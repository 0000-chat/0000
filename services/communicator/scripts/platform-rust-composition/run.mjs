import { closeSync, openSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

import { fetchWithDeadline } from "./health.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const communicatorRoot = resolve(here, "../..");
const controlPlaneRoot = join(communicatorRoot, "apps/control-plane");
const platformBridge = join(here, "platform-bridge.mjs");
const issuer = join(here, "issue-service.mjs");
const revoker = join(here, "revoke-service.mjs");
const seeder = join(here, "seed-communicator.mjs");
const batchPaths = [
  join(here, "ingestion-batch-one.json"),
  join(here, "ingestion-batch-two.json"),
  join(here, "ingestion-batch-three.json"),
];
const runRoot = await mkdtemp(
  join("/tmp", "communicator-t11-rust-composition-"),
);
const infoPath = join(runRoot, "platform.json");
const issuedPath = join(runRoot, "issued-service.json");
const communicatorState = join(runRoot, "communicator");
const internalLogPath = join(runRoot, "run.log");
const outputLogPath =
  process.env.T11_RUST_RUN_LOG ?? "/tmp/platform-t11-rust-composition.log";
const keepState = process.env.T11_KEEP_STATE === "1";
const targetDirectory =
  process.env.CARGO_TARGET_DIR ?? join(runRoot, "cargo-target");
const startupTimeoutMs = Number(process.env.T11_STARTUP_TIMEOUT_MS ?? "30000");
const stageTimeoutMs = Number(process.env.T11_STAGE_TIMEOUT_MS ?? "120000");
const requestTimeoutMs = 5000;
if (
  !Number.isInteger(startupTimeoutMs) ||
  startupTimeoutMs < 1 ||
  !Number.isInteger(stageTimeoutMs) ||
  stageTimeoutMs < 1
) {
  throw new Error("T11 startup/stage timeouts must be positive integers");
}

const ownedGroups = new Map();
const groupStopPromises = new Map();
const shutdownController = new AbortController();
let interruptedBy = null;
let cleanupPromise;

const append = async (line) => {
  await writeFile(internalLogPath, `${line}\n`, { flag: "a", mode: 0o600 });
};

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPort(new Error("unable to allocate local port"));
        return;
      }
      server.close((error) => {
        if (error) rejectPort(error);
        else resolvePort(address.port);
      });
    });
  });
}

function spawnLogged(
  command,
  args,
  environment,
  {
    detached = false,
    cwd = communicatorRoot,
    logPath = internalLogPath,
    label = command,
  } = {},
) {
  assertNotInterrupted();
  const output = openSync(logPath, "a");
  const child = spawn(command, args, {
    cwd,
    detached,
    env: { ...process.env, ...environment },
    stdio: ["ignore", output, output],
  });
  if (detached && child.pid !== undefined) {
    ownedGroups.set(child.pid, { label, pid: child.pid });
  }
  child.once("exit", () => closeSync(output));
  return child;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function assertNotInterrupted() {
  if (interruptedBy !== null) {
    throw new Error(`runner interrupted by ${interruptedBy}`);
  }
}

async function groupExists(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function stopGroup(pgid) {
  if (groupStopPromises.has(pgid)) return groupStopPromises.get(pgid);
  const group = ownedGroups.get(pgid);
  const stopPromise = (async () => {
    const termSent = signalGroup(pgid, "SIGTERM");
    const termDeadline = Date.now() + 1500;
    while (await groupExists(pgid)) {
      if (Date.now() >= termDeadline) break;
      await delay(50);
    }
    const killSent = (await groupExists(pgid))
      ? signalGroup(pgid, "SIGKILL")
      : false;
    const killDeadline = Date.now() + 1500;
    while (await groupExists(pgid)) {
      if (Date.now() >= killDeadline) break;
      await delay(50);
    }
    return {
      label: group?.label ?? "unknown",
      pid: pgid,
      termSent,
      killSent,
      stopped: !(await groupExists(pgid)),
    };
  })();
  groupStopPromises.set(pgid, stopPromise);
  return stopPromise;
}

async function stopOwnedGroups() {
  const groups = await Promise.all(
    [...ownedGroups.keys()].map((pgid) => stopGroup(pgid)),
  );
  return {
    allStopped: groups.every((group) => group.stopped),
    groups,
  };
}

async function requestShutdown(signal) {
  interruptedBy ??= signal;
  shutdownController.abort();
  cleanupPromise ??= stopOwnedGroups();
  await cleanupPromise;
}

process.once("SIGINT", () => void requestShutdown("SIGINT"));
process.once("SIGTERM", () => void requestShutdown("SIGTERM"));

function runLogged(command, args, environment = {}, label = command) {
  return new Promise((resolveRun, rejectRun) => {
    const stageLogPath = join(runRoot, `${label}.log`);
    const child = spawnLogged(command, args, environment, {
      detached: true,
      label,
      logPath: stageLogPath,
    });
    let settled = false;
    let timedOut = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolveRun({ ...value, timedOut, logPath: stageLogPath });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void stopGroup(child.pid)
        .catch(() => {})
        .finally(() => finish({ code: null, signal: "SIGKILL" }));
    }, stageTimeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      finish({
        code: 1,
        signal: null,
        spawnError: error instanceof Error ? error.message : String(error),
      });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      finish({ code: code ?? 1, signal });
    });
  });
}

async function waitForJson(path, timeoutMs = startupTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertNotInterrupted();
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForHealth(url, timeoutMs = startupTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertNotInterrupted();
    try {
      const response = await fetchWithDeadline(`${url}/healthz`, {
        shutdownSignal: shutdownController.signal,
        timeoutMs: requestTimeoutMs,
      });
      if (response.ok) return;
    } catch {
      // The local Wrangler process is still starting.
    }
    await delay(250);
  }
  throw new Error(`timed out waiting for ${url}`);
}

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readStageLog(stageResult) {
  try {
    return await readFile(stageResult.logPath, "utf8");
  } catch {
    return "";
  }
}

async function runCargoStage(label, testName, environment) {
  const stageResult = await runLogged(
    "cargo",
    [
      "test",
      "-p",
      "communicator-matrix-gateway",
      "--features",
      "loopback-test",
      "--test",
      "t11_issued_live_http",
      testName,
      "--",
      "--exact",
      "--ignored",
      "--nocapture",
    ],
    environment,
    label,
  );
  const output = await readStageLog(stageResult);
  const executed =
    /running 1 test\b/u.test(output) &&
    new RegExp(`^test ${escapedRegExp(testName)} \\.\\.\\. ok$`, "mu").test(
      output,
    ) &&
    /test result: ok\. 1 passed; 0 failed(?:;|\s)/u.test(output);
  const observed =
    label === "before"
      ? {
          ingestion: output.includes(
            "issued Rust ingestion before revocation: Accepted",
          )
            ? "Accepted"
            : null,
          claim: output.includes("issued Rust claim before revocation: Allowed")
            ? "Allowed"
            : null,
        }
      : {
          ingestion: output.includes(
            "issued Rust ingestion after Platform revocation: class=Paused code=ingestion_unauthorized",
          )
            ? "Paused/ingestion_unauthorized"
            : null,
          directClaimHttpStatus: output.includes(
            "revoked issued credential direct claim HTTP status: 401",
          )
            ? 401
            : null,
          claim: output.includes(
            "issued Rust claim after Platform revocation: Uncertain",
          )
            ? "Uncertain"
            : null,
          replacementIngestion: output.includes(
            "replacement Rust ingestion: Accepted",
          )
            ? "Accepted"
            : null,
          replacementClaim: output.includes("replacement Rust claim: Allowed")
            ? "Allowed"
            : null,
        };
  const completeObservation =
    label === "before"
      ? observed.ingestion === "Accepted" && observed.claim === "Allowed"
      : observed.ingestion === "Paused/ingestion_unauthorized" &&
        observed.directClaimHttpStatus === 401 &&
        observed.claim === "Uncertain" &&
        observed.replacementIngestion === "Accepted" &&
        observed.replacementClaim === "Allowed";
  const passed = stageResult.code === 0 && !stageResult.timedOut && executed;
  const value = {
    code: stageResult.code,
    signal: stageResult.signal,
    timedOut: stageResult.timedOut,
    ran: executed,
    passed: passed && completeObservation,
    observed: passed && completeObservation ? { ...observed } : null,
  };
  await append(
    JSON.stringify({
      stage: label,
      code: value.code,
      signal: value.signal,
      timedOut: value.timedOut,
      ran: value.ran,
      passed: value.passed,
      observed: value.observed,
    }),
  );
  return value;
}

async function runRevocation(environment) {
  const stageResult = await runLogged(
    "bun",
    [revoker],
    environment,
    "revoke-service",
  );
  const output = await readStageLog(stageResult);
  const observed = /\{"status":200,"revoked":true\}/u.test(output)
    ? { status: 200, revoked: true }
    : null;
  const value = {
    code: stageResult.code,
    signal: stageResult.signal,
    timedOut: stageResult.timedOut,
    passed:
      stageResult.code === 0 && !stageResult.timedOut && observed !== null,
    observed,
  };
  await append(JSON.stringify({ stage: "revoke-service", ...value }));
  return value;
}

let result = { before: null, revoke: null, after: null };
let cleanupResult = null;
let stateRemoved = false;
try {
  const platformPort = Number(
    process.env.T11_PLATFORM_PORT ?? (await freePort()),
  );
  const communicatorPort = Number(
    process.env.T11_COMMUNICATOR_PORT ?? (await freePort()),
  );
  if (!Number.isInteger(platformPort) || !Number.isInteger(communicatorPort)) {
    throw new Error("allocated ports must be integers");
  }
  await append(
    JSON.stringify({
      stage: "fixture",
      platformPort,
      communicatorPort,
      source: "checked-in platform bridge and current Platform source",
    }),
  );

  spawnLogged(
    "bun",
    [platformBridge],
    {
      T11_PLATFORM_PORT: String(platformPort),
      T11_COMMUNICATOR_PORT: String(communicatorPort),
      T11_PLATFORM_INFO_PATH: infoPath,
      T11_PLATFORM_STATE_PATH: join(runRoot, "platform"),
    },
    {
      detached: true,
      label: "platform-worker",
      cwd: resolve(communicatorRoot, "../platform"),
      logPath: join(runRoot, "platform.log"),
    },
  );
  const info = await waitForJson(infoPath);
  await waitForHealth(info.baseUrl);

  const issueResult = await runLogged(
    "bun",
    [issuer],
    {
      T11_PLATFORM_INFO_PATH: infoPath,
      T11_ISSUED_SERVICE_PATH: issuedPath,
    },
    "issue-service",
  );
  if (issueResult.code !== 0) {
    throw new Error("Platform service issuance failed");
  }
  await waitForJson(issuedPath, 5000);

  const seedResult = await runLogged(
    "node",
    [seeder],
    {
      T11_PLATFORM_INFO_PATH: infoPath,
      T11_ISSUED_SERVICE_PATH: issuedPath,
      T11_COMMUNICATOR_STATE_PATH: communicatorState,
    },
    "seed-communicator",
  );
  if (seedResult.code !== 0) {
    throw new Error("Communicator fixture seeding failed");
  }

  const workerArgs = [
    "exec",
    "wrangler",
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(communicatorPort),
    "--persist-to",
    communicatorState,
    "--var",
    `COMMUNICATOR_PLATFORM_BASE_URL:${info.baseUrl}`,
    "--var",
    `COMMUNICATOR_PLATFORM_AUTHORITY:${info.authority}`,
    "--var",
    `COMMUNICATOR_PLATFORM_AUDIENCE:${info.service.audience}`,
    "--var",
    `COMMUNICATOR_PLATFORM_SERVICE_VERIFIER:${info.service.verifier}`,
    "--var",
    "COMMUNICATOR_PLATFORM_BROWSER_CLIENT_ID:t11-rust-composition-client",
    "--var",
    "COMMUNICATOR_PLATFORM_BROWSER_CLIENT_SECRET:",
    "--var",
    `COMMUNICATOR_PLATFORM_BROWSER_REDIRECT_URI:http://localhost:${communicatorPort}/auth/callback`,
    "--var",
    `COMMUNICATOR_PLATFORM_BROWSER_RESOURCE:${info.service.audience}`,
    "--var",
    "COMMUNICATOR_PLATFORM_BROWSER_SCOPES:conversation.read message.send connection.read",
    "--var",
    "COMMUNICATOR_DATA_MODE:live",
    "--var",
    "COMMUNICATOR_ENV:local",
    "--var",
    "COMMUNICATOR_INGRESS_ENABLED:true",
  ];
  spawnLogged(
    "pnpm",
    workerArgs,
    {},
    {
      detached: true,
      label: "communicator-worker",
      cwd: controlPlaneRoot,
      logPath: join(runRoot, "communicator.log"),
    },
  );
  const workerBaseUrl = `http://127.0.0.1:${communicatorPort}`;
  await waitForHealth(workerBaseUrl);

  const rustEnvironment = {
    CARGO_TARGET_DIR: targetDirectory,
    T11_ISSUED_SERVICE_PATH: issuedPath,
    T11_RUST_WORKER_BASE_URL: workerBaseUrl,
    T11_RUST_BATCH_ONE: batchPaths[0],
    T11_RUST_BATCH_TWO: batchPaths[1],
    T11_RUST_BATCH_THREE: batchPaths[2],
  };
  result.before = await runCargoStage(
    "before",
    "issued_platform_credential_reaches_live_ingestion_and_claim",
    rustEnvironment,
  );
  if (!result.before.passed) {
    throw new Error("pre-revocation Rust test did not pass as one exact test");
  }

  result.revoke = await runRevocation({
    T11_PLATFORM_INFO_PATH: infoPath,
    T11_ISSUED_SERVICE_PATH: issuedPath,
  });
  if (!result.revoke.passed) throw new Error("Platform revocation failed");

  result.after = await runCargoStage(
    "after",
    "revoked_credential_pauses_and_replacement_credential_recovers_both_callers",
    rustEnvironment,
  );
  if (!result.after.passed) {
    throw new Error("post-revocation Rust test did not pass as one exact test");
  }
  result.fixture = { platformPort, communicatorPort };
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
} finally {
  cleanupPromise ??= stopOwnedGroups();
  cleanupResult = await cleanupPromise.catch((error) => ({
    allStopped: false,
    error: error instanceof Error ? error.message : String(error),
    groups: [],
  }));
  await append(
    JSON.stringify({
      stage: "cleanup",
      allStopped: cleanupResult.allStopped,
      groups: cleanupResult.groups,
    }),
  ).catch(() => {});
  await copyFile(internalLogPath, outputLogPath).catch(() => {});
  if (!keepState) {
    try {
      await rm(runRoot, { recursive: true, force: true });
      stateRemoved = true;
    } catch {
      stateRemoved = false;
    }
  }
}

const summary = {
  before: result.before,
  revoke: result.revoke,
  after: result.after,
  error: result.error ?? null,
  interruptedBy,
  assertions: {
    before: result.before?.observed ? 2 : null,
    after: result.after?.observed ? 6 : null,
  },
  directRevokedClaimHttpStatus:
    result.after?.observed?.directClaimHttpStatus ?? null,
  fixture: result.fixture ?? null,
  cleanup: cleanupResult
    ? {
        allStopped: cleanupResult.allStopped,
        groups: cleanupResult.groups,
        stateRemoved,
        stateRetained: keepState,
      }
    : null,
  logPath: outputLogPath,
};
console.log(JSON.stringify(summary));
if (
  interruptedBy !== null ||
  result.error ||
  !result.before?.passed ||
  !result.revoke?.passed ||
  !result.after?.passed ||
  !cleanupResult?.allStopped ||
  (!keepState && !stateRemoved)
) {
  process.exitCode = 1;
}
