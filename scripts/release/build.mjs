#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import {
  assertReleaseConfig,
  normalisePath,
  readJson,
  readReleaseConfig,
  repositoryRoot,
  sha256,
  stableJson
} from "./lib.mjs";
import { neutralWranglerConfig, workerArtifactManifest } from "./worker.mjs";
import { assertAppendOnlyD1Migrations, migrationMetadata } from "./migrations.mjs";

function argument(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: null,
    maxBuffer: 128 * 1024 * 1024,
    ...options
  });
  if (result.status !== 0) {
    const detail = result.stderr?.toString().trim() || result.stdout?.toString().trim();
    const reason = result.error?.message || `status=${result.status ?? "null"} signal=${result.signal ?? "none"}`;
    throw new Error(detail || `${command} failed: ${reason}`);
  }
  return result.stdout ?? Buffer.alloc(0);
}

function repositoryPath(value, label) {
  const normalised = normalisePath(value);
  const resolved = path.resolve(repositoryRoot, normalised);
  const relative = path.relative(repositoryRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the repository: ${value}`);
  }
  return resolved;
}

function archiveUnit(unit, commit) {
  const tar = run("git", ["archive", "--format=tar", `--prefix=${unit.name}/`, commit, "--", ...unit.archive_paths]);
  if (tar.length === 0) throw new Error(`empty archive for ${unit.name}`);
  return gzipSync(tar, { level: 9, mtime: 0 });
}

function wranglerCommand(unit) {
  const configured = process.env.WRANGLER_BIN;
  if (configured) return configured;
  const serviceDirectory = path.dirname(unit.build.config_path);
  const serviceLocal = path.join(repositoryRoot, serviceDirectory, "node_modules/.bin/wrangler");
  if (fs.existsSync(serviceLocal)) return serviceLocal;
  const rootLocal = path.join(repositoryRoot, "node_modules/.bin/wrangler");
  return fs.existsSync(rootLocal) ? rootLocal : "wrangler";
}

function copyDirectory(source, destination) {
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new Error(`configured Worker directory does not exist: ${source}`);
  }
  const copiedFiles = [];
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`configured Worker directory contains a symlink: ${sourcePath}`);
    if (entry.isDirectory()) {
      copiedFiles.push(...copyDirectory(sourcePath, destinationPath).map((file) => path.join(entry.name, file)));
      continue;
    }
    if (!entry.isFile()) throw new Error(`configured Worker directory contains a special file: ${sourcePath}`);
    fs.copyFileSync(sourcePath, destinationPath);
    copiedFiles.push(entry.name);
  }
  return copiedFiles;
}

function buildDirectory(unit, definition, artifactRoot) {
  if (!definition) return { target: undefined, files: [] };
  const source = repositoryPath(definition.source, `${unit.name} build directory source`);
  const target = path.join(artifactRoot, definition.directory);
  const files = copyDirectory(source, target);
  return { target: definition.directory, files };
}

function stagingLabel(unit) {
  if (unit.name === "msg-worker") return "Msg Worker";
  if (unit.name === "gateway") return "Gateway";
  return unit.name;
}

function buildWorkerUnit(unit, plan) {
  const commit = plan.source_commit;
  const currentCommit = run("git", ["rev-parse", "HEAD"]).toString().trim();
  if (currentCommit !== commit) {
    throw new Error(`built artifact source checkout ${currentCommit} does not match release commit ${commit}`);
  }
  if (unit.build.migrations) {
    assertAppendOnlyD1Migrations({
      repositoryRoot,
      source: unit.build.migrations.source,
      baseCommit: plan.base_commit
    });
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `0000-${unit.name}-`));
  const wranglerOutput = path.join(temporaryRoot, "wrangler-output");
  const artifactRoot = path.join(temporaryRoot, "artifact");
  const wranglerConfig = repositoryPath(unit.build.config_path, `${unit.name} build.config_path`);
  let logConfig;
  fs.mkdirSync(wranglerOutput);
  fs.mkdirSync(artifactRoot);

  try {
    logConfig = fs.mkdtempSync(path.join(os.tmpdir(), "0000-wrangler-config-"));
    const environment = {
      ...process.env,
      XDG_CONFIG_HOME: logConfig
    };
    if (unit.build.wrapper) {
      run(
        "bun",
        [repositoryPath(unit.build.wrapper, `${unit.name} build.wrapper`), "deploy", "--dry-run", "--outdir", wranglerOutput],
        { env: environment }
      );
    } else {
      run(
        wranglerCommand(unit),
        ["deploy", "--dry-run", "--outdir", wranglerOutput, "--config", wranglerConfig],
        { env: environment }
      );
    }

    const generatedWorker = path.join(wranglerOutput, unit.build.generated_entrypoint ?? unit.build.entrypoint);
    if (!fs.existsSync(generatedWorker) || !fs.statSync(generatedWorker).isFile()) {
      throw new Error(`Wrangler did not emit the configured Worker entrypoint: ${unit.build.entrypoint}`);
    }
    const workerBytes = fs.readFileSync(generatedWorker);
    fs.writeFileSync(path.join(artifactRoot, unit.build.entrypoint), workerBytes);
    fs.writeFileSync(
      path.join(artifactRoot, unit.build.config),
      stableJson(neutralWranglerConfig(unit)),
      "utf8",
    );

    const assets = buildDirectory(unit, unit.build.assets, artifactRoot);
    const migrations = buildDirectory(unit, unit.build.migrations, artifactRoot);
    const migrationFiles = migrationMetadata(
      migrations.target ? path.join(artifactRoot, migrations.target) : undefined,
      migrations.files
    );
    const manifest = workerArtifactManifest(unit, plan, migrationFiles.length > 0 ? { migration_files: migrationFiles } : {});
    fs.writeFileSync(path.join(artifactRoot, "artifact-manifest.json"), stableJson(manifest), "utf8");

    const missing = unit.build.files.filter((file) => !fs.existsSync(path.join(artifactRoot, file)));
    if (missing.length > 0) {
      throw new Error(`built artifact is missing configured files for ${unit.name}: ${missing.join(", ")}`);
    }

    const directories = [assets.target, migrations.target].filter(Boolean);
    const archivePaths = [...unit.build.files, ...directories];
    const tar = run(
      "tar",
      [
        "--format=ustar",
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--mode=0644",
        "-cf",
        "-",
        "-C",
        artifactRoot,
        ...archivePaths
      ],
      { maxBuffer: 128 * 1024 * 1024 }
    );
    if (tar.length === 0) throw new Error(`empty built archive for ${unit.name}`);
    const bytes = gzipSync(tar, { level: 9, mtime: 0 });
    return {
      bytes,
      metadata: {
        artifact_format: "0000-cloudflare-worker-bundle-v1",
        entrypoint: unit.build.entrypoint,
        config: unit.build.config,
        files: unit.build.files,
        directories,
        migration_files: migrationFiles,
        entrypoint_digest: `sha256:${sha256(workerBytes)}`,
        deployment: {
          tool: "wrangler",
          mode: "prebuilt",
          route_configuration: "cloud",
          command: [
            "wrangler",
            "deploy",
            "--config",
            "wrangler.staging.json",
            "--no-bundle",
            "--strict",
            "--message",
            `${stagingLabel(unit)} staging ${plan.release_version}`
          ]
        }
      }
    };
  } finally {
    if (logConfig) fs.rmSync(logConfig, { force: true, recursive: true });
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

const planPath = argument("--plan");
const outputDirectory = argument("--output-dir");
if (!planPath || !outputDirectory) throw new Error("usage: build.mjs --plan PLAN --output-dir DIRECTORY");

const plan = readJson(planPath);
const config = assertReleaseConfig(readReleaseConfig());
const units = new Map(config.units.map((unit) => [unit.name, unit]));
fs.mkdirSync(outputDirectory, { recursive: true });

for (const name of plan.affected_units) {
  const unit = units.get(name);
  if (!unit) throw new Error(`plan references unknown release unit: ${name}`);

  const built = unit.build
    ? buildWorkerUnit(unit, plan)
    : { bytes: archiveUnit(unit, plan.source_commit), metadata: {} };
  const digest = `sha256:${sha256(built.bytes)}`;
  const archiveName = `${unit.name}-${plan.release_version}.tar.gz`;
  fs.writeFileSync(path.join(outputDirectory, archiveName), built.bytes);
  const metadata = {
    schema_version: 1,
    product: "0000",
    name: unit.name,
    version: plan.release_version,
    kind: unit.kind,
    digest,
    asset_name: archiveName,
    media_type: "application/gzip",
    compatibility: plan.compatibility,
    source_commit: plan.source_commit,
    archive_paths: unit.archive_paths,
    ...built.metadata
  };
  fs.writeFileSync(path.join(outputDirectory, `${unit.name}.artifact.json`), stableJson(metadata), "utf8");
  process.stdout.write(`${unit.name}: ${digest}\n`);
}
