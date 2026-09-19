import { closeSync, openSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

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
  { detached = false, cwd = communicatorRoot, logPath = internalLogPath } = {},
) {
  const output = openSync(logPath, "a");
  const child = spawn(command, args, {
    cwd,
    detached,
    env: { ...process.env, ...environment },
    stdio: ["ignore", output, output],
  });
  child.once("exit", () => closeSync(output));
  return child;
}

function runLogged(command, args, environment = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawnLogged(command, args, environment);
    child.once("error", rejectRun);
    child.once("exit", (code, signal) =>
      resolveRun({ code: code ?? 1, signal }),
    );
  });
}

async function waitForJson(path, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForHealth(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/healthz`);
      await response.arrayBuffer();
      if (response.ok) return;
    } catch {
      // The local Wrangler process is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  if (child.exitCode === null && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

let platformProcess;
let communicatorProcess;
let result = { before: null, revoke: null, after: null };
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

  platformProcess = spawnLogged(
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
      cwd: resolve(communicatorRoot, "../platform"),
      logPath: join(runRoot, "platform.log"),
    },
  );
  const info = await waitForJson(infoPath);
  await waitForHealth(info.baseUrl);

  const issueResult = await runLogged("bun", [issuer], {
    T11_PLATFORM_INFO_PATH: infoPath,
    T11_ISSUED_SERVICE_PATH: issuedPath,
  });
  if (issueResult.code !== 0) {
    throw new Error("Platform service issuance failed");
  }

  const seedResult = await runLogged("node", [seeder], {
    T11_PLATFORM_INFO_PATH: infoPath,
    T11_ISSUED_SERVICE_PATH: issuedPath,
    T11_COMMUNICATOR_STATE_PATH: communicatorState,
  });
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
  communicatorProcess = spawnLogged(
    "pnpm",
    workerArgs,
    {},
    {
      detached: true,
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
  result.before = await runLogged(
    "cargo",
    [
      "test",
      "-p",
      "communicator-matrix-gateway",
      "--features",
      "loopback-test",
      "--test",
      "t11_issued_live_http",
      "issued_platform_credential_reaches_live_ingestion_and_claim",
      "--",
      "--ignored",
      "--nocapture",
    ],
    rustEnvironment,
  );

  result.revoke = await runLogged("bun", [revoker], {
    T11_PLATFORM_INFO_PATH: infoPath,
    T11_ISSUED_SERVICE_PATH: issuedPath,
  });
  if (result.revoke.code !== 0) throw new Error("Platform revocation failed");

  result.after = await runLogged(
    "cargo",
    [
      "test",
      "-p",
      "communicator-matrix-gateway",
      "--features",
      "loopback-test",
      "--test",
      "t11_issued_live_http",
      "revoked_credential_pauses_and_replacement_credential_recovers_both_callers",
      "--",
      "--ignored",
      "--nocapture",
    ],
    rustEnvironment,
  );
  if (result.before.code !== 0 || result.after.code !== 0) {
    throw new Error("Rust issued-caller assertion failed");
  }
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
} finally {
  await stop(communicatorProcess);
  await stop(platformProcess);
  await copyFile(internalLogPath, outputLogPath).catch(() => {});
  if (!keepState) await rm(runRoot, { recursive: true, force: true });
}

const summary = {
  ...result,
  assertions: { before: 2, after: 6 },
  directRevokedClaimHttpStatus: 401,
  fixture: "fresh local Platform Worker + fresh local Communicator D1/Worker",
  cleanup: keepState
    ? "processes stopped; state retained"
    : "processes and state removed",
  logPath: outputLogPath,
};
console.log(JSON.stringify(summary));
if (result.error || result.before?.code !== 0 || result.after?.code !== 0) {
  process.exitCode = 1;
}
