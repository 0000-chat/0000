import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const communicatorRoot = join(here, "../..");
const runnerPath = join(here, "run.mjs");
const nodePath = process.execPath;

function commandPath(command) {
  return execFileSync("which", [command], { encoding: "utf8" }).trim();
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function executable(path, contents) {
  await writeFile(path, contents, { mode: 0o700 });
  await chmod(path, 0o700);
}

async function baseBin() {
  const bin = await mkdtemp(join(tmpdir(), "platform-t11-runner-test-"));
  const bunPath = commandPath("bun");
  const pnpmPath = commandPath("pnpm");
  await executable(
    join(bin, "bun"),
    `#!/bin/sh\nexec ${shellQuote(bunPath)} "$@"\n`,
  );
  await executable(
    join(bin, "node"),
    `#!/bin/sh\nexec ${shellQuote(nodePath)} "$@"\n`,
  );
  return { bin, pnpmPath };
}

function runRunner(environment) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(nodePath, [runnerPath], {
      cwd: communicatorRoot,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const lines = output.split("\n");
      const summary = JSON.parse(lines.at(-1));
      resolveRun({
        code,
        signal,
        summary,
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

test("missing background executable reaches cleanup and a bounded failure", {
  timeout: 120_000,
}, async () => {
  const { bin, pnpmPath } = await baseBin();
  const countPath = join(bin, "pnpm-count");
  const logPath = join(bin, "run.log");
  await writeFile(countPath, "0\n");
  await executable(
    join(bin, "pnpm"),
    `#!/bin/sh
count=$(cat ${shellQuote(countPath)})
count=$((count + 1))
printf '%s\\n' "$count" > ${shellQuote(countPath)}
if [ "$count" -eq 2 ]; then mv "$0" "$0.disabled"; fi
exec ${shellQuote(pnpmPath)} "$@"
`,
  );
  try {
    const run = await runRunner({
      PATH: `${bin}:/usr/bin:/bin`,
      T11_RUST_RUN_LOG: logPath,
    });
    assert.equal(run.code, 1);
    assert.match(
      run.summary.error,
      /communicator-worker failed to start: spawn pnpm ENOENT/u,
    );
    assert.equal(run.summary.cleanup.allStopped, true);
    assert.equal(run.summary.cleanup.stateRemoved, true);
  } finally {
    await rm(bin, { recursive: true, force: true });
  }
});

test("setup timeout is rejected when the child exits zero after TERM", {
  timeout: 120_000,
}, async () => {
  const { bin } = await baseBin();
  const logPath = join(bin, "run.log");
  await executable(
    join(bin, "bun"),
    `#!/bin/sh
case "$1" in
  */issue-service.mjs)
    trap 'exit 0' TERM INT
    sleep 60
    ;;
  *)
    exec ${shellQuote(commandPath("bun"))} "$@"
    ;;
esac
`,
  );
  await executable(
    join(bin, "pnpm"),
    `#!/bin/sh\nexec ${shellQuote(commandPath("pnpm"))} "$@"\n`,
  );
  try {
    const run = await runRunner({
      PATH: `${bin}:/usr/bin:/bin`,
      T11_STAGE_TIMEOUT_MS: "5000",
      T11_RUST_RUN_LOG: logPath,
    });
    const safeLog = await readFile(logPath, "utf8");
    assert.equal(run.code, 1);
    assert.match(run.summary.error, /Platform service issuance failed/u);
    assert.match(safeLog, /"stage":"issue-service"/u);
    assert.match(safeLog, /"timedOut":true/u);
    assert.equal(run.summary.cleanup.allStopped, true);
    assert.equal(run.summary.cleanup.stateRemoved, true);
  } finally {
    await rm(bin, { recursive: true, force: true });
  }
});
