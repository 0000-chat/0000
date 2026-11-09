import fs from "node:fs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { readJson, readJsonc, sha256, stableJson } from "./lib.mjs";
import { assertAppendOnlyD1Migrations, migrationMetadata } from "./migrations.mjs";

const service = "services/communicator";
const app = `${service}/apps/control-plane`;
const requiredPackages = ["@0000/contracts", "@0000/platform-client", "@communicator/contracts", "@communicator/test-fixtures"];

function run(root, command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, maxBuffer: 128 * 1024 * 1024, ...options });
}

function copyTree(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`bundle input is a symlink: ${source}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source).sort()) copyTree(path.join(source, name), path.join(destination, name));
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  } else throw new Error(`bundle input is not a regular file: ${source}`);
}

function fileLedger(root, directory = "") {
  return fs.readdirSync(path.join(root, directory)).sort().flatMap((name) => {
    const relative = path.posix.join(directory, name);
    const file = path.join(root, relative);
    if (fs.lstatSync(file).isDirectory()) return fileLedger(root, relative);
    return [{ name: relative, digest: `sha256:${sha256(fs.readFileSync(file))}`, executable: (fs.statSync(file).mode & 0o111) !== 0 }];
  });
}

export function workspaceClosure(root) {
  const dependencies = readJson(path.join(root, app, "package.json")).dependencies;
  const workspaceNames = Object.keys(dependencies).filter((name) => dependencies[name].startsWith("workspace:"));
  if (workspaceNames.length !== requiredPackages.length || workspaceNames.some((name) => !requiredPackages.includes(name))) {
    throw new Error("missing or unreviewed required workspace dependency");
  }
  return requiredPackages.map((name) => {
    if (dependencies[name] !== "workspace:*") throw new Error(`missing required workspace dependency: ${name}`);
    const directory = name.startsWith("@0000/") ? `packages/${name.split("/")[1]}` : `${service}/packages/${name.split("/")[1]}`;
    const manifest = readJson(path.join(root, directory, "package.json"));
    if (manifest.name !== name) throw new Error(`wrong workspace dependency: ${name}`);
    const sourceFiles = run(root, "git", ["ls-files", "--", directory]).toString().trim().split("\n").filter(Boolean);
    if (sourceFiles.length === 0) throw new Error(`workspace dependency has no tracked inputs: ${name}`);
    return { name, source_files: sourceFiles.map((file) => ({ name: file, digest: `sha256:${sha256(fs.readFileSync(path.join(root, file)))}` })), delivery: "bundled" };
  });
}

export function bridgeImages(source) {
  const images = {};
  for (const line of source.trim().split(/\r?\n/)) {
    const match = /^([A-Z]+_IMAGE)=([^\s]+@sha256:[a-f0-9]{64})$/.exec(line);
    if (!match || images[match[1]]) throw new Error("bridge images must be unique digest-pinned references");
    images[match[1]] = match[2];
  }
  const required = ["POSTGRES_IMAGE", "CADDY_IMAGE", "SYNAPSE_IMAGE", "WHATSAPP_IMAGE", "MESSENGER_IMAGE", "TELEGRAM_IMAGE"];
  if (Object.keys(images).length !== required.length || required.some((key) => !images[key])) throw new Error("missing required bridge image");
  return images;
}

export function buildCommunicatorUnit(unit, plan, root) {
  if (run(root, "git", ["rev-parse", "HEAD"]).toString().trim() !== plan.source_commit) throw new Error("Communicator source revision does not match plan");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "0000-communicator-"));
  const output = path.join(temporary, "bundle");
  fs.mkdirSync(output);
  const copy = (source, destination = source) => copyTree(path.join(root, source), path.join(output, destination));
  const manifest = {
    schema_version: 1, product: "0000", name: unit.name, kind: unit.kind,
    version: plan.release_version, source_commit: plan.source_commit, compatibility: plan.compatibility,
    artifact_format: "0000-communicator-bundle-v1", role: unit.build.role,
    dependencies: [], state: { compatibility: "communicator-state-v1", migration_policy: "forward-only", rollback: "restore-compatible-backup", persistent: [] }
  };
  try {
    copy("LICENSE-AGPL-3.0.txt", "LICENSE-AGPL-3.0.txt");
    copy("LICENSE-APACHE-2.0.txt", "LICENSE-APACHE-2.0.txt");
    if (unit.build.role === "worker") {
      manifest.dependencies = workspaceClosure(root);
      const source = readJsonc(path.join(root, app, "wrangler.jsonc"));
      const supported = ["$schema", "name", "main", "compatibility_date", "compatibility_flags", "triggers", "assets", "exports", "durable_objects", "observability", "d1_databases", "r2_buckets", "queues", "vars", "env"];
      assert.ok(Object.keys(source).every((key) => supported.includes(key)), "new Worker configuration requires a release contract");
      assert.deepEqual(source.d1_databases.map(({ binding }) => binding), ["CONTROL_DB"], "D1 binding contract changed");
      assert.deepEqual(source.r2_buckets.map(({ binding }) => binding), ["EVENT_ARCHIVE"], "R2 binding contract changed");
      assert.deepEqual(source.queues.producers.map(({ binding }) => binding), ["INGESTION_QUEUE"], "Queue binding contract changed");
      assert.equal(source.queues.consumers.length, 1, "Queue consumer contract changed");
      assert.deepEqual(source.durable_objects.bindings.map(({ name }) => name).sort(), ["LINK_SESSIONS", "TENANT_PROJECTION"], "persistent DO binding contract changed");
      assertAppendOnlyD1Migrations({ repositoryRoot: root, source: `${app}/migrations`, baseCommit: plan.base_commit });
      run(root, "pnpm", ["--dir", service, "--filter", "@communicator/control-plane", "build"], {
        env: { ...process.env, VITE_DEPLOYMENT_ENV: "production", VITE_DATA_MODE: "live", CLOUDFLARE_ENV: "" }
      });
      assert.deepEqual(fileLedger(path.join(root, app, "dist/communicator_control_plane")).map(({ name }) => name), [".vite/manifest.json", "index.js", "wrangler.json"], "new Vite Worker output requires a release contract");
      copy(`${app}/dist/communicator_control_plane/index.js`, "worker.js");
      copy(`${app}/dist/client`, "assets");
      // The dev service worker is not a production deployment input.
      fs.rmSync(path.join(output, "assets/mockServiceWorker.js"), { force: true });
      copy(`${app}/migrations`, "migrations");
      const config = {
        main: "worker.js", no_bundle: true, workers_dev: false,
        compatibility_date: source.compatibility_date, compatibility_flags: source.compatibility_flags,
        assets: { ...source.assets, directory: "assets" }, exports: source.exports,
        durable_objects: source.durable_objects, observability: source.observability, triggers: source.triggers,
        d1_databases: [{ binding: "CONTROL_DB", database_name: "communicator-control-directory", migrations_dir: "migrations" }],
        r2_buckets: [{ binding: "EVENT_ARCHIVE", bucket_name: "communicator-event-archive" }],
        queues: {
          producers: [{ binding: "INGESTION_QUEUE", queue: "communicator-ingestion" }],
          consumers: source.queues.consumers.map(({ queue, dead_letter_queue, ...settings }) => ({ ...settings, queue: "communicator-ingestion", dead_letter_queue: "communicator-ingestion-dlq" }))
        }
      };
      fs.writeFileSync(path.join(output, "wrangler.json"), stableJson(config));
      manifest.entrypoint = "worker.js";
      manifest.bindings = config;
      manifest.migration_files = migrationMetadata(path.join(output, "migrations"), fs.readdirSync(path.join(output, "migrations")));
      manifest.state.persistent = ["CONTROL_DB", "TENANT_PROJECTION", "LINK_SESSIONS", "EVENT_ARCHIVE", "INGESTION_QUEUE", "dead-letter-queue"];
      manifest.state.embedded_schema = ["worker/projection/schema.ts", "worker/linking/session.ts", "worker/retention/schema.ts"].map((file) => ({ name: file, digest: `sha256:${sha256(fs.readFileSync(path.join(root, app, file)))}` }));
    } else if (unit.build.role === "native") {
      const toolchain = fs.readFileSync(path.join(root, service, "rust-toolchain.toml"), "utf8").match(/channel = "([0-9.]+)"/)?.[1];
      if (!toolchain) throw new Error("native bundle requires a pinned Rust toolchain");
      const target = "x86_64-unknown-linux-gnu";
      run(root, "cargo", [`+${toolchain}`, "build", "--manifest-path", `${service}/Cargo.toml`, "--locked", "--release", "--target", target, "--bin", "communicator-matrix-gateway"]);
      copy(`${service}/target/${target}/release/communicator-matrix-gateway`, "communicator-matrix-gateway");
      fs.chmodSync(path.join(output, "communicator-matrix-gateway"), 0o755);
      copy(`${service}/deploy/matrix-gateway`, "deploy/matrix-gateway");
      const example = path.join(output, "deploy/matrix-gateway/config.example.json");
      fs.writeFileSync(example, fs.readFileSync(example, "utf8").replaceAll("communicator.0000.gold", "communicator.example.invalid"));
      manifest.entrypoint = "communicator-matrix-gateway";
      manifest.native = { target, rust: toolchain, libc: "glibc", build_os: run(root, "ldd", ["--version"]).toString().split("\n")[0] };
      manifest.native.required_glibc_symbols = [...new Set(run(root, "objdump", ["-T", path.join(output, "communicator-matrix-gateway")]).toString().match(/GLIBC_[0-9.]+/g))].sort();
      manifest.state.persistent = ["matrix_store_dir", "state_db_path", "protected-secret-files"];
      manifest.state.embedded_schema = ["src/store.rs", "src/config.rs"].map((file) => ({ name: file, digest: `sha256:${sha256(fs.readFileSync(path.join(root, service, "services/matrix-gateway", file)))}` }));
      manifest.state.restart_prevent_exit_status = 78;
    } else {
      copy(`${service}/compose.yaml`, "compose.yaml");
      copy(`${service}/deploy/images.lock.env`, "deploy/images.lock.env");
      manifest.images = bridgeImages(fs.readFileSync(path.join(output, "deploy/images.lock.env"), "utf8"));
      for (const directory of ["caddy", "synapse"]) {
        copy(`${service}/deploy/${directory}`, `deploy/${directory}`);
      }
      for (const name of fs.readdirSync(path.join(root, service, "scripts")).sort()) {
        if (/^(?:init-.*\.sh|render-.*\.py|validate-.*\.sh|validate_.*_policy\.py)$/.test(name)) copy(`${service}/scripts/${name}`, `scripts/${name}`);
      }
      for (const file of fileLedger(output).filter((file) => /(?:Caddyfile|\.template|\.sh|\.py)$/.test(file.name))) {
        const target = path.join(output, file.name);
        fs.writeFileSync(target, fs.readFileSync(target, "utf8").replaceAll("communicator.0000.gold", "communicator.example.invalid"));
      }
      manifest.state.persistent = ["postgres", "synapse", "whatsapp", "messenger", "telegram", "caddy", "secrets", "backups"];
      manifest.state.upgrade_policy = "review-upstream-migrations-and-backup-before-changing-image-digests";
    }
    copy("scripts/release/verify-communicator.mjs", "verify-communicator.mjs");
    manifest.files = fileLedger(output);
    fs.writeFileSync(path.join(output, "artifact-manifest.json"), stableJson(manifest));
    const tar = run(root, "tar", ["--format=ustar", "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "--mode=u+rwX,go+rX,go-w", "-cf", "-", "-C", output, ...fs.readdirSync(output).sort()]);
    return { bytes: gzipSync(tar, { level: 9, mtime: 0 }), metadata: { artifact_format: manifest.artifact_format, manifest_digest: `sha256:${sha256(fs.readFileSync(path.join(output, "artifact-manifest.json")))}` } };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
