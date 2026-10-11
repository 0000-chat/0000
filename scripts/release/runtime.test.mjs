import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  Client as DatabaseMcpClient,
  StreamableHTTPClientTransport,
} from "../../services/database/node_modules/@modelcontextprotocol/client/dist/index.mjs";
import { Miniflare as MsgMiniflare } from "../../services/msg/node_modules/miniflare/dist/src/index.js";
import {
  convertV4MiniflareOptions,
  Miniflare as DatabaseMiniflare,
} from "../../services/database/node_modules/miniflare/dist/src/index.js";
import { makePlan, readReleaseConfig, repositoryRoot, stableJson } from "./lib.mjs";

const releaseConfig = readReleaseConfig();
const msgUnit = releaseConfig.units.find((unit) => unit.name === "msg-worker");
if (!msgUnit) throw new Error("release configuration does not define msg-worker");
const databaseUnit = releaseConfig.units.find((unit) => unit.name === "database-worker");
if (!databaseUnit) throw new Error("release configuration does not define database-worker");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function makeReadableTree(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      fs.chmodSync(entryPath, 0o755);
      makeReadableTree(entryPath);
    }
  }
}

function baseCommitForPlan(sourceCommit, gitRunner = run) {
  let parentError;
  try {
    return gitRunner("git", ["rev-parse", `${sourceCommit}^`]).trim();
  } catch (error) {
    parentError = error;
  }
  if (gitRunner("git", ["rev-parse", "--is-shallow-repository"]).trim() !== "true") throw parentError;
  // This test constructs a synthetic runtime plan from the checked-out tree.
  // A shallow checkout has no historical parent to use as its comparison base;
  // using the exact source commit keeps the artifact identity unchanged while
  // making the append-only migration check compare the tree with itself.
  return sourceCommit;
}

test("shallow source checkouts use the exact source commit as the synthetic base", () => {
  const calls = [];
  const shallowGit = (command, args) => {
    calls.push([command, ...args]);
    if (args[1] === "source-commit^") throw new Error("shallow checkout has no parent");
    if (args[1] === "--is-shallow-repository") return "true\n";
    throw new Error(`unexpected git probe: ${args.join(" ")}`);
  };

  assert.equal(baseCommitForPlan("source-commit", shallowGit), "source-commit");
  assert.deepEqual(calls, [
    ["git", "rev-parse", "source-commit^"],
    ["git", "rev-parse", "--is-shallow-repository"],
  ]);
});

function buildAndExtractMsgArtifact() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "0000-msg-runtime-"));
  const buildOutput = path.join(temporaryRoot, "artifacts");
  const extracted = path.join(temporaryRoot, "extracted");
  const configHome = path.join(temporaryRoot, "wrangler-config");
  fs.mkdirSync(buildOutput);
  fs.mkdirSync(extracted);
  fs.mkdirSync(configHome);

  const sourceCommit = run("git", ["rev-parse", "HEAD"]).trim();
  const baseCommit = baseCommitForPlan(sourceCommit);
  const plan = makePlan({
    config: releaseConfig,
    base: baseCommit,
    head: sourceCommit,
    changedFiles: ["services/msg/worker/src/worker.ts"],
  });
  const planPath = path.join(temporaryRoot, "plan.json");
  fs.writeFileSync(planPath, stableJson(plan), "utf8");

  run("node", ["scripts/release/build.mjs", "--plan", planPath, "--output-dir", buildOutput], {
    env: { ...process.env, XDG_CONFIG_HOME: configHome },
  });
  const archiveName = `${msgUnit.name}-${plan.release_version}.tar.gz`;
  const archivePath = path.join(buildOutput, archiveName);
  assert.equal(fs.existsSync(archivePath), true, `release build did not produce ${archiveName}`);
  run("tar", ["-xzf", archivePath, "-C", extracted]);
  makeReadableTree(extracted);

  return {
    archivePath,
    extracted,
    cleanup: () => fs.rmSync(temporaryRoot, { force: true, recursive: true }),
  };
}

function readArtifact(extracted) {
  const manifest = JSON.parse(fs.readFileSync(path.join(extracted, "artifact-manifest.json"), "utf8"));
  const wrangler = JSON.parse(fs.readFileSync(path.join(extracted, "wrangler.json"), "utf8"));
  return { manifest, wrangler };
}

async function connectDatabaseMcp(runtime) {
  const transport = new StreamableHTTPClientTransport(
    new URL("https://database.example/mcp"),
    {
      fetch: async (input, init) => {
        const worker = await runtime.getWorker();
        return worker.fetch(new Request(input, init));
      },
    },
  );
  const client = new DatabaseMcpClient({
    name: "database-release-artifact",
    version: "0.0.0",
  });
  await client.connect(transport);
  return client;
}

async function fetchJson(worker, url, init, expectedStatus) {
  const response = await worker.fetch(url, init);
  const body = await response.text();
  assert.equal(response.status, expectedStatus, body);
  return JSON.parse(body);
}

function buildAndExtractDatabaseArtifact() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "0000-database-release-runtime-"));
  const buildOutput = path.join(temporaryRoot, "artifacts");
  const extracted = path.join(temporaryRoot, "extracted");
  const configHome = path.join(temporaryRoot, "wrangler-config");
  fs.mkdirSync(buildOutput);
  fs.mkdirSync(extracted);
  fs.mkdirSync(configHome);

  const sourceCommit = run("git", ["rev-parse", "HEAD"]).trim();
  const baseCommit = baseCommitForPlan(sourceCommit);
  const plan = makePlan({
    config: releaseConfig,
    base: baseCommit,
    head: sourceCommit,
    changedFiles: ["services/database/src/worker.ts"],
  });
  const planPath = path.join(temporaryRoot, "plan.json");
  fs.writeFileSync(planPath, stableJson(plan), "utf8");

  run("node", ["scripts/release/build.mjs", "--plan", planPath, "--output-dir", buildOutput], {
    env: { ...process.env, XDG_CONFIG_HOME: configHome },
  });
  const archiveName = `${databaseUnit.name}-${plan.release_version}.tar.gz`;
  const archivePath = path.join(buildOutput, archiveName);
  assert.equal(fs.existsSync(archivePath), true, `release build did not produce ${archiveName}`);
  run("tar", ["-xzf", archivePath, "-C", extracted]);
  makeReadableTree(extracted);

  return {
    archivePath,
    buildOutput,
    extracted,
    plan,
    cleanup: () => fs.rmSync(temporaryRoot, { force: true, recursive: true }),
  };
}

function runtimeOptions(extracted, manifest, wrangler, omittedModule) {
  const workerPath = path.join(extracted, "worker.js");
  if (omittedModule) fs.renameSync(path.join(extracted, omittedModule), `${path.join(extracted, omittedModule)}.missing`);
  return {
    assets: {
      binding: wrangler.assets.binding,
      directory: path.join(extracted, wrangler.assets.directory),
    },
    bindings: {
      MSG_CREATE_DISABLED: "0",
      MSG_POST_DISABLED: "0",
      MSG_PUBLIC_ORIGIN: "https://msg.0000.chat",
    },
    compatibilityDate: wrangler.compatibility_date,
    compatibilityFlags: wrangler.compatibility_flags,
    durableObjects: {
      ConversationRoom: { className: "ConversationRoom", useSQLite: true },
    },
    durableObjectsPersist: path.join(extracted, ".runtime-state"),
    modules: true,
    modulesRoot: extracted,
    modulesRules: (wrangler.rules ?? []).map((rule) => ({
      type: rule.type,
      include: rule.globs,
      ...(rule.fallthrough === undefined ? {} : { fallthrough: rule.fallthrough }),
    })),
    scriptPath: workerPath,
  };
}

async function startRuntime(options) {
  const runtime = new MsgMiniflare(options);
  try {
    await runtime.ready;
    return { runtime, compatibilityDate: options.compatibilityDate };
  } catch (error) {
    await runtime.dispose().catch(() => undefined);
    // The lockfile currently pins a workerd binary whose newest supported
    // date predates the public artifact contract. Keep the archive and its
    // rules unchanged, but use that binary's advertised date for this local
    // runtime regression. Newer binaries exercise the exact artifact date.
    const supportedDate = /newest date supported by this server binary is "(\d{4}-\d{2}-\d{2})"/u.exec(String(error))?.[1];
    if (!supportedDate) throw error;
    const compatibleRuntime = new MsgMiniflare({ ...options, compatibilityDate: supportedDate });
    await compatibleRuntime.ready;
    return { runtime: compatibleRuntime, compatibilityDate: supportedDate };
  }
}

test("an extracted Msg archive boots with its Text modules and fails when one is absent", { timeout: 180_000 }, async () => {
  const artifact = buildAndExtractMsgArtifact();
  try {
    const { manifest, wrangler } = readArtifact(artifact.extracted);
    assert.ok(Array.isArray(manifest.modules) && manifest.modules.length > 0);
    assert.deepEqual(wrangler.rules, [{ type: "Text", globs: ["**/*.svg"], fallthrough: true }]);

    const started = await startRuntime(runtimeOptions(artifact.extracted, manifest, wrangler));
    const runtime = started.runtime;
    try {
      await runtime.ready;
      const worker = await runtime.getWorker();

      const health = await worker.fetch("https://msg.0000.chat/healthz");
      const healthBody = await health.text();
      assert.equal(health.status, 200, `health response: ${health.status} ${healthBody}`);
      assert.deepEqual(JSON.parse(healthBody), { ok: true, protocol_version: 1 });

      const create = await worker.fetch("https://msg.0000.chat/", {
        body: JSON.stringify({ author: "release-test", content: "runtime module check" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      assert.equal(create.status, 201);
      const created = await create.json();
      assert.equal(typeof created.conversation_url, "string");

      const page = await worker.fetch(created.conversation_url, {
        headers: { accept: "text/html" },
      });
      assert.equal(page.status, 200);
      assert.match(page.headers.get("content-type") ?? "", /text\/html/);
      const html = await page.text();
      assert.match(html, /<!doctype html>/i);
      const iconNames = ["arrow-down.svg", "clock.svg", "download.svg", "link.svg", "user-plus-white.svg"];
      for (const iconName of iconNames) {
        assert.ok(html.includes(`/_msg/icon/${iconName}`), `HTML route did not reference ${iconName}`);
      }
      const expectedModules = new Set(manifest.modules.map((module) => fs.readFileSync(path.join(artifact.extracted, module.name), "utf8").trim()));
      const servedModules = new Set();
      for (const iconName of iconNames) {
        const icon = await worker.fetch(`https://msg.0000.chat/_msg/icon/${iconName}`);
        assert.equal(icon.status, 200, `icon route failed for ${iconName}`);
        servedModules.add((await icon.text()).trim());
      }
      assert.deepEqual(servedModules, expectedModules);
    } finally {
      await runtime.dispose();
    }

    const omittedModule = manifest.modules[0].name;
    const brokenOptions = runtimeOptions(artifact.extracted, manifest, wrangler, omittedModule);
    try {
      await assert.rejects(() => startRuntime(brokenOptions), /ENOENT|module|import|worker/i);
    } finally {
      fs.renameSync(`${path.join(artifact.extracted, omittedModule)}.missing`, path.join(artifact.extracted, omittedModule));
    }
  } finally {
    artifact.cleanup();
  }
});

test("an extracted Database archive boots with its SQLite Durable Object contract", { timeout: 180_000 }, async (t) => {
  const artifact = buildAndExtractDatabaseArtifact();
  try {
    const { manifest, wrangler } = readArtifact(artifact.extracted);
    const metadata = JSON.parse(fs.readFileSync(path.join(artifact.buildOutput, `${databaseUnit.name}.artifact.json`), "utf8"));
    const archiveDigest = `sha256:${createHash("sha256").update(fs.readFileSync(artifact.archivePath)).digest("hex")}`;
    const entrypointDigest = `sha256:${createHash("sha256").update(fs.readFileSync(path.join(artifact.extracted, "worker.js"))).digest("hex")}`;
    assert.equal(metadata.digest, archiveDigest);
    assert.equal(metadata.entrypoint_digest, entrypointDigest);
    t.diagnostic(`Database archive ${archiveDigest}; Worker entrypoint ${entrypointDigest}`);
    assert.deepEqual(manifest.durable_objects, databaseUnit.build.wrangler.durable_objects);
    assert.deepEqual(manifest.migrations, databaseUnit.build.wrangler.migrations);
    assert.deepEqual(manifest.vars, databaseUnit.build.wrangler.vars);
    assert.deepEqual(metadata.vars, manifest.vars);
    assert.deepEqual(wrangler.durable_objects, manifest.durable_objects);
    assert.deepEqual(wrangler.migrations, manifest.migrations);
    assert.deepEqual(wrangler.vars, manifest.vars);
    assert.equal(wrangler.name, undefined);
    assert.equal(wrangler.account_id, undefined);
    assert.equal(wrangler.routes, undefined);
    assert.equal(wrangler.workers_dev, false);
    assert.equal(manifest.required_secrets, undefined);

    const archiveText = `${JSON.stringify(manifest)}\n${JSON.stringify(wrangler)}`;
    assert.equal(/account_id|database\.0000\.chat|secret|route/i.test(archiveText), false);
    assert.deepEqual(
      fs.readdirSync(artifact.extracted).sort(),
      ["artifact-manifest.json", "worker.js", "wrangler.json"],
    );

    const persistence = path.join(artifact.extracted, ".runtime-state");
    const workerScript = fs.readFileSync(
      path.join(artifact.extracted, "worker.js"),
      "utf8",
    );
    const options = convertV4MiniflareOptions({
      resourcePersistencePath: persistence,
      workers: [
        {
          name: "database",
          compatibilityDate: wrangler.compatibility_date,
          compatibilityFlags: wrangler.compatibility_flags,
          bindings: wrangler.vars,
          durableObjects: Object.fromEntries(
            wrangler.durable_objects.bindings.map((binding) => [binding.name, {
              className: binding.class_name,
              useSQLite: true,
            }]),
          ),
          modules: true,
          script: workerScript,
        },
      ],
    });
    const runtime = new DatabaseMiniflare(options);
    let database;
    let table;
    let column;
    let record;
    let exportManifest;
    let client;
    try {
      await runtime.ready;
      const worker = await runtime.getWorker();
      database = await fetchJson(
        worker,
        "https://database.example/v1/databases",
        {
          body: JSON.stringify({ name: "Release artifact smoke" }),
          headers: {
            "content-type": "application/json",
            "idempotency-key": "release-artifact-create-key-0001",
          },
          method: "POST",
        },
        201,
      );
      assert.equal(typeof database.databaseId, "string");

      const databasePath = `https://database.example/v1/databases/${database.databaseId}`;
      table = await fetchJson(
        worker,
        `${databasePath}/tables`,
        {
          body: JSON.stringify({ name: "Artifact records" }),
          headers: {
            "content-type": "application/json",
            "idempotency-key": "release-artifact-table-key-0001",
          },
          method: "POST",
        },
        201,
      );
      column = await fetchJson(
        worker,
        `${databasePath}/tables/${table.id}/columns`,
        {
          body: JSON.stringify({ name: "value", type: "string" }),
          headers: {
            "content-type": "application/json",
            "idempotency-key": "release-artifact-column-key-0001",
            "x-expected-schema-version": table.schemaVersion,
          },
          method: "POST",
        },
        201,
      );
      record = await fetchJson(
        worker,
        `${databasePath}/tables/${table.id}/records`,
        {
          body: JSON.stringify({ values: { [column.id]: "from packaged worker" } }),
          headers: {
            "content-type": "application/json",
            "idempotency-key": "release-artifact-record-key-0001",
          },
          method: "POST",
        },
        201,
      );

      client = await connectDatabaseMcp(runtime);
      const mcpRecord = await client.callTool({
        name: "get_record",
        arguments: {
          databaseId: database.databaseId,
          tableId: table.id,
          recordId: record.id,
        },
      });
      assert.equal(mcpRecord.isError ?? false, false);
      assert.deepEqual(mcpRecord.structuredContent?.values, {
        [column.id]: "from packaged worker",
      });

      exportManifest = await fetchJson(
        worker,
        `${databasePath}/exports`,
        {
          headers: {
            "idempotency-key": "release-artifact-export-key-0001",
          },
          method: "POST",
        },
        201,
      );
      assert.equal(exportManifest.formatVersion, 1);
      await client.close();
      client = undefined;
    } finally {
      await client?.close();
      await runtime.dispose();
    }

    const restarted = new DatabaseMiniflare(options);
    try {
      await restarted.ready;
      const worker = await restarted.getWorker();
      const read = await worker.fetch(`https://database.example/v1/databases/${database.databaseId}`);
      assert.equal(read.status, 200, await read.clone().text());
      assert.equal((await read.json()).databaseId, database.databaseId);

      const databasePath = `https://database.example/v1/databases/${database.databaseId}`;
      const recordRead = await fetchJson(
        worker,
        `${databasePath}/tables/${table.id}/records/${record.id}`,
        undefined,
        200,
      );
      assert.deepEqual(recordRead.values, { [column.id]: "from packaged worker" });

      const exportRead = await fetchJson(
        worker,
        `${databasePath}/exports/${exportManifest.exportId}?limit=100`,
        undefined,
        200,
      );
      const exportedRecord = exportRead.items.find(
        (item) => item.type === "record" && item.id === record.id,
      );
      assert.deepEqual(exportedRecord?.values, {
        [column.id]: "from packaged worker",
      });
      assert.ok(exportRead.items.some((item) => item.type === "table" && item.id === table.id));
      assert.ok(exportRead.items.some((item) => item.type === "column" && item.id === column.id));
    } finally {
      await restarted.dispose();
    }
  } finally {
    artifact.cleanup();
  }
});
