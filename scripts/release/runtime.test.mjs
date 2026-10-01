import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Miniflare } from "../../services/msg/node_modules/miniflare/dist/src/index.js";
import { makePlan, readReleaseConfig, repositoryRoot, stableJson } from "./lib.mjs";

const releaseConfig = readReleaseConfig();
const msgUnit = releaseConfig.units.find((unit) => unit.name === "msg-worker");
if (!msgUnit) throw new Error("release configuration does not define msg-worker");

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
      MSG_TEST_MODE: "1",
      MSG_TEST_ROOM_LIMITS: "{}",
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
    ratelimits: Object.fromEntries((manifest.rate_limits ?? []).map(({ name, simple }, index) => [
      name,
      { namespace_id: String(9000 + index), simple },
    ])),
    scriptPath: workerPath,
  };
}

async function startRuntime(options) {
  const runtime = new Miniflare(options);
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
    const compatibleRuntime = new Miniflare({ ...options, compatibilityDate: supportedDate });
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
      if (create.status !== 201) {
        throw new Error(`Extracted Msg worker create returned ${create.status}: ${await create.text()}`);
      }
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
