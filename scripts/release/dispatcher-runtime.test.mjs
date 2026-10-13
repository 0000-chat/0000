import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { makePlan, readReleaseConfig, repositoryRoot, stableJson } from "./lib.mjs";

const config = readReleaseConfig();
const unit = config.units.find((candidate) => candidate.name === "msg-webhook-dispatcher");
if (!unit) throw new Error("release configuration does not define msg-webhook-dispatcher");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} failed`);
  }
  return result.stdout;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

test("extracted Bun dispatcher artifact starts and enforces relay auth", async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "0000-dispatcher-artifact-test-"));
  const artifactDirectory = path.join(temporaryRoot, "artifacts");
  const extractedDirectory = path.join(temporaryRoot, "extracted");
  fs.mkdirSync(artifactDirectory);
  fs.mkdirSync(extractedDirectory);
  const sourceCommit = run("git", ["rev-parse", "HEAD"]).trim();
  const plan = makePlan({
    config,
    base: null,
    head: sourceCommit,
    changedFiles: ["services/msg/scripts/mcp-webhook-dispatcher.ts"],
  });
  const planPath = path.join(temporaryRoot, "plan.json");
  fs.writeFileSync(planPath, stableJson(plan), "utf8");

  try {
    run("node", ["scripts/release/build.mjs", "--plan", planPath, "--output-dir", artifactDirectory]);
    const archive = path.join(artifactDirectory, `${unit.name}-${plan.release_version}.tar.gz`);
    assert.equal(fs.existsSync(archive), true);
    run("tar", ["-xzf", archive, "-C", extractedDirectory]);

    const manifest = JSON.parse(fs.readFileSync(path.join(extractedDirectory, "artifact-manifest.json"), "utf8"));
    assert.equal(manifest.kind, unit.kind);
    assert.equal(manifest.entrypoint, unit.build.entrypoint);
    assert.deepEqual(manifest.runtime, unit.build.runtime);
    assert.equal(typeof manifest.entrypoint_digest, "string");
    assert.equal(fs.existsSync(path.join(extractedDirectory, unit.build.entrypoint)), true);

    const port = await freePort();
    const child = spawn("bun", [path.join(extractedDirectory, unit.build.entrypoint)], {
      cwd: extractedDirectory,
      env: {
        ...process.env,
        MSG_MCP_WEBHOOK_DISPATCH_TOKEN: "artifact-smoke-token",
        MSG_MCP_WEBHOOK_DISPATCH_HOST: "127.0.0.1",
        MSG_MCP_WEBHOOK_DISPATCH_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`dispatcher did not start: ${output}`)), 5_000);
        const started = (chunk) => {
          if (chunk.toString().includes(`127.0.0.1:${port}`)) {
            clearTimeout(timer);
            resolve();
          }
        };
        child.stdout.on("data", started);
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
      });

      const payload = JSON.stringify({
        url: "https://127.0.0.1/events",
        method: "POST",
        headers: {},
        body: "{}",
      });
      const unauthorized = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
      assert.equal(unauthorized.status, 401);

      const authorized = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: "POST",
        headers: {
          authorization: "Bearer artifact-smoke-token",
          "content-type": "application/json",
        },
        body: payload,
      });
      assert.equal(authorized.status, 200);
      assert.deepEqual(await authorized.json(), { status: 599, headers: {}, body: "" });
    } finally {
      child.kill("SIGTERM");
      if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
    }
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

