import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPlatformMiniflareRateLimits,
  buildPlatformTestRateLimitPolicy,
} from "../../../platform/src/rate-limit-policy.ts";
import { runWebhookProof, webhookReceiver } from "./webhooks.mjs";
import { runHistoryProof } from "./history.mjs";
import { runRemovalProof, runRestoreActivationProof } from "./removals.mjs";
import { runOperationsProof } from "./operations.mjs";
import { runEvidenceProof } from "./evidence.mjs";
import { createRetentionFixture } from "./retention.mjs";
import { runRecoveryProof } from "./recovery.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const service = path.resolve(here, "../..");
const root = path.resolve(service, "../..");
const require = createRequire(
  fs.realpathSync(
    path.join(service, "apps/control-plane/node_modules/wrangler/package.json"),
  ),
);
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const { unstable_splitSqlQuery } = require("wrangler");
const output = path.resolve(process.argv[2] ?? "integrated-proof.json");
if (fs.existsSync(output))
  throw new Error("Refusing to overwrite an existing evidence bundle");
const scratch = fs.mkdtempSync(
  path.join(os.tmpdir(), "communicator-integrated-proof-"),
);
fs.chmodSync(scratch, 0o700);
const observations = [];
const children = new Set();
let runtime;
let gateway;
let beforeGateway;
let loseGatewayResponse = false;
const gatewayTraces = [];
const retention = createRetentionFixture();
const report = {
  schema_version: 1,
  started_at: new Date().toISOString(),
  source: {
    head: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    files: {},
  },
  components: {
    platform:
      "actual Worker/D1; fixture-issued managed agent and service credentials",
    communicator:
      "actual production HTTP entry/middleware, D1 and SQLite Durable Objects; fixture-seeded directory and projection",
    gateway: "production constructor and SDK with real HTTP authority client",
    external:
      "controlled Matrix/bridge endpoints, no WhatsApp or external client",
    ui: "not exercised by this runner",
  },
  cases: observations,
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function sourceFiles() {
  const files = {};
  const names = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root },
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  for (const name of names.sort()) {
    const absolute = path.join(root, name);
    if (absolute === output || !fs.existsSync(absolute)) continue;
    const metadata = fs.lstatSync(absolute);
    if (metadata.isSymbolicLink())
      files[name] = digest(`symlink:${fs.readlinkSync(absolute)}`);
    else if (metadata.isFile()) files[name] = digest(fs.readFileSync(absolute));
  }
  return files;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const result = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return result;
}
function child(command, args, env = {}) {
  const log = fs.openSync(
    path.join(scratch, `child-${children.size}.log`),
    "a",
    0o600,
  );
  const process = spawn(command, args, {
    cwd: service,
    env: { ...globalThis.process.env, ...env },
    stdio: ["ignore", log, log],
  });
  fs.closeSync(log);
  process.failure = null;
  process.once("error", (error) => {
    process.failure = error;
  });
  children.add(process);
  return process;
}
async function waitFor(file, process) {
  const deadline = Date.now() + 60_000;
  while (!fs.existsSync(file)) {
    if (
      process.failure ||
      process.exitCode !== null ||
      process.signalCode !== null
    )
      throw new Error("gateway exited before readiness");
    assert.ok(Date.now() < deadline, "gateway startup deadline");
    await pause(50);
  }
}
async function stop(process) {
  if (!process || process.exitCode !== null || process.signalCode !== null)
    return;
  process.kill("SIGTERM");
  const deadline = Date.now() + 5000;
  while (
    process.exitCode === null &&
    process.signalCode === null &&
    Date.now() < deadline
  )
    await pause(50);
  if (process.exitCode === null && process.signalCode === null) {
    process.kill("SIGKILL");
    await new Promise((resolve) => process.once("exit", resolve));
  }
}
async function observe(id, run) {
  assert.ok(
    !observations.some((item) => item.id === id),
    "duplicate proof case",
  );
  try {
    const facts = await run();
    observations.push({ id, status: "pass", facts });
  } catch (error) {
    console.error(`${id}: ${error.message}`);
    observations.push({
      id,
      status: "defect",
      failure: {
        name: error.name,
        code: error.code,
        operator: error.operator,
        ...(typeof error.actual === "number" ? { actual: error.actual } : {}),
        ...(typeof error.expected === "number"
          ? { expected: error.expected }
          : {}),
      },
      reason:
        "Executed assertion failed; no response body, credential or caught provider error is copied into this bundle",
    });
  }
  console.log(`${id}: ${observations.at(-1).status}`);
}
const build = (entry, outfile) =>
  execFileSync(
    "bun",
    [
      "build",
      entry,
      "--target=browser",
      "--external=cloudflare:*",
      "--external=node:*",
      `--outfile=${outfile}`,
    ],
    { cwd: service, stdio: "pipe" },
  );
async function migrate(database, directory) {
  for (const name of fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const queries = unstable_splitSqlQuery(
      fs.readFileSync(path.join(directory, name), "utf8"),
    );
    await database.batch(queries.map((query) => database.prepare(query)));
  }
}
try {
  // Include dirty and new source files; HEAD alone does not identify this run.
  report.source.files = sourceFiles();
  report.source.content_sha256 = digest(JSON.stringify(report.source.files));
  report.versions = Object.fromEntries(
    ["node", "bun", "pnpm", "cargo", "rustc"].map((name) => [
      name,
      execFileSync(name, ["--version"], {
        cwd: service,
        encoding: "utf8",
      }).trim(),
    ]),
  );
  for (const name of ["wrangler", "miniflare", "workerd"])
    report.versions[name] = require(`${name}/package.json`).version;
  report.versions.matrix_sdk = fs
    .readFileSync(path.join(service, "Cargo.lock"), "utf8")
    .match(/name = "matrix-sdk"\nversion = "([^"]+)"/u)?.[1];
  console.log("Building actual Worker entry points and gateway fixture");
  build(path.join(here, "platform.mjs"), path.join(scratch, "platform.mjs"));
  build(
    path.join(here, "webhook-tick.mjs"),
    path.join(scratch, "communicator.mjs"),
  );
  execFileSync(
    "cargo",
    [
      "test",
      "--locked",
      "--features",
      "loopback-test",
      "--test",
      "t13_local_gateway",
      "--no-run",
      "--message-format=json",
    ],
    {
      cwd: service,
      stdio: [
        "ignore",
        fs.openSync(path.join(scratch, "cargo-build.json"), "w", 0o600),
        fs.openSync(path.join(scratch, "cargo-build.log"), "w", 0o600),
      ],
    },
  );
  const artifacts = fs
    .readFileSync(path.join(scratch, "cargo-build.json"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const executable = artifacts.find(
    (item) =>
      item.reason === "compiler-artifact" &&
      item.target.name === "t13_local_gateway" &&
      item.executable,
  )?.executable;
  assert.ok(executable, "gateway executable missing");
  const workerPort = await port();
  const gatewayPort = await port();
  const options = () =>
    convertV4MiniflareOptions({
      host: "127.0.0.1",
      port: workerPort,
      resourcePersistencePath: path.join(scratch, "persist"),
      workers: [
        {
          name: "communicator",
          modules: true,
          modulesRoot: scratch,
          scriptPath: path.join(scratch, "communicator.mjs"),
          compatibilityDate: "2026-08-27",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: { CONTROL_DB: "control" },
          r2Buckets: ["EVENT_ARCHIVE"],
          durableObjects: {
            TENANT_PROJECTION: {
              className: "TenantProjectionDO",
              useSQLite: true,
            },
            LINK_SESSIONS: { className: "LinkSessionDO", useSQLite: true },
          },
          bindings: {
            ...retention.bindings,
            COMMUNICATOR_DATA_MODE: "live",
            COMMUNICATOR_INGRESS_ENABLED: "true",
            COMMUNICATOR_PLATFORM_BASE_URL: "http://platform.integrated.test",
            COMMUNICATOR_PLATFORM_AUTHORITY: "integrated-authority",
            COMMUNICATOR_PLATFORM_AUDIENCE:
              "https://communicator.integrated.test",
            COMMUNICATOR_PLATFORM_SERVICE_VERIFIER:
              "integrated-local-service-verifier",
            CONNECTION_GATEWAY_URL: "https://gateway.integrated.test",
            CONNECTION_GATEWAY_TOKEN: "integrated-local-gateway-token",
          },
          serviceBindings: {
            CONNECTION_GATEWAY_VPC: async (request) => {
              if (beforeGateway) {
                const mutate = beforeGateway;
                beforeGateway = undefined;
                try {
                  await mutate();
                } catch (error) {
                  report.fixture_mutation_error = error.message;
                  throw error;
                }
              }
              const result = await fetch(
                `http://127.0.0.1:${gatewayPort}${new URL(request.url).pathname}`,
                request,
              );
              gatewayTraces.push({
                path: new URL(request.url).pathname,
                status: result.status,
                envelope: await result.clone().json(),
              });
              if (loseGatewayResponse) {
                loseGatewayResponse = false;
                await result.arrayBuffer();
                throw new Error(
                  "Controlled response loss after real gateway response",
                );
              }
              return result;
            },
          },
          outboundService: async (request) => {
            const retained = await retention.outboundService(request);
            if (retained) return retained;
            const receiver = await webhookReceiver(request);
            if (receiver) return receiver;
            assert.equal(
              new URL(request.url).hostname,
              "platform.integrated.test",
              "nonlocal outbound forbidden",
            );
            return (await runtime.getWorker("platform")).fetch(request);
          },
        },
        {
          name: "platform",
          modules: true,
          modulesRoot: scratch,
          scriptPath: path.join(scratch, "platform.mjs"),
          compatibilityDate: "2026-08-25",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: { IDENTITY_DB: "platform" },
          ratelimits: buildPlatformMiniflareRateLimits(
            buildPlatformTestRateLimitPolicy(),
          ),
          bindings: {
            PLATFORM_BASE_URL: "http://platform.integrated.test",
            PLATFORM_AUTHORITY_ID: "integrated-authority",
            PLATFORM_DEPLOYMENT_MODE: "self-hosted",
            PLATFORM_SIGNUP_POLICY: "open",
            PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS: "90",
            PLATFORM_SERVER_DEADLINE_MS: "8000",
            PLATFORM_RATE_LIMIT_POLICY: "",
            BETTER_AUTH_SECRET:
              "integrated-local-only-secret-at-least-32-characters",
            GITHUB_CLIENT_ID: "integrated-github-client",
            GITHUB_CLIENT_SECRET: "integrated-github-secret",
          },
          outboundService: async (request) => {
            const url = new URL(request.url);
            if (
              url.hostname === "github.com" &&
              url.pathname === "/login/oauth/access_token"
            )
              return Response.json({
                access_token: "integrated-provider-token",
                token_type: "bearer",
                scope: "read:user user:email",
              });
            if (url.hostname === "api.github.com" && url.pathname === "/user")
              return Response.json({
                id: 817141,
                login: "integrated-human",
                name: "Integrated Human",
                avatar_url: null,
              });
            if (
              url.hostname === "api.github.com" &&
              url.pathname === "/user/emails"
            )
              return Response.json([
                {
                  email: "integrated-human@example.test",
                  primary: true,
                  verified: true,
                },
              ]);
            throw new Error("Platform nonlocal outbound forbidden");
          },
        },
      ],
    });
  runtime = new Miniflare(options());
  await runtime.ready;
  await migrate(
    await runtime.getD1Database("IDENTITY_DB", "platform"),
    path.join(root, "services/platform/migrations"),
  );
  await migrate(
    await runtime.getD1Database("CONTROL_DB", "communicator"),
    path.join(service, "apps/control-plane/migrations"),
  );
  const seeded = await (await runtime.getWorker("platform")).fetch(
    "http://platform.integrated.test/__fixture/seed",
  );
  assert.equal(seeded.status, 200, "Platform fixture provisioning failed");
  const fixture = await seeded.json();
  const seededLocal = await runtime.dispatchFetch(
    "http://localhost/__fixture/seed",
    { method: "POST", body: JSON.stringify(fixture) },
  );
  if (seededLocal.status !== 200) console.error(await seededLocal.text());
  assert.equal(
    seededLocal.status,
    200,
    "Communicator fixture provisioning failed",
  );
  const ready = path.join(scratch, "ready.json");
  const stats = path.join(scratch, "stats.json");
  const stopPath = path.join(scratch, "stop");
  const evidencePath = path.join(scratch, "evidence.json");
  const launch = () =>
    child(
      executable,
      [
        "--ignored",
        "--exact",
        "integrated_local_gateway_sidecar",
        "--nocapture",
      ],
      {
        T13_WORKER_URL: `http://127.0.0.1:${workerPort}`,
        T13_GATEWAY_CREDENTIAL: fixture.gateway.credential,
        T13_GATEWAY_TOKEN: "integrated-local-gateway-token",
        T13_GATEWAY_PORT: String(gatewayPort),
        T13_READY_PATH: ready,
        T13_STOP_PATH: stopPath,
        T13_STATS_PATH: stats,
        T13_STATE_DIR: path.join(scratch, "gateway-state"),
        T13_REJECT_PATH: path.join(scratch, "reject"),
        T13_EVIDENCE_PATH: evidencePath,
      },
    );
  gateway = launch();
  await waitFor(ready, gateway);
  const rawApi = (
    url,
    body,
    headers = {},
    method = body === undefined ? "GET" : "POST",
  ) =>
    fetch(`http://127.0.0.1:${workerPort}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${fixture.actor.credential}`,
        "content-type": "application/json",
        "x-communicator-tenant": "tenant_pilot",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
  const api = async (url, body, headers = {}, method) => {
    const response = await rawApi(url, body, headers, method);
    return { status: response.status, body: await response.json() };
  };
  const humanApi = (url, body, headers = {}, method) =>
    api(
      url,
      body,
      { ...headers, authorization: `Bearer ${fixture.human.credential}` },
      method,
    );
  const serviceApi = (url, body, headers = {}, method) =>
    api(
      url,
      body,
      { ...headers, authorization: `Bearer ${fixture.gateway.credential}` },
      method,
    );
  const calls = async () => {
    await pause(150);
    return JSON.parse(fs.readFileSync(stats, "utf8"));
  };
  await observe("session-lineaged-human-administrator", async () => {
    const result = await humanApi("/api/v1/commands");
    assert.equal(result.status, 200);
    return {
      http_status: 200,
      actual_platform_session_oauth_issuance: true,
      provider_identity: "controlled synthetic GitHub",
    };
  });
  await observe("pristine-and-legacy-bootstrap-lifecycle", async () => {
    const before = await calls();
    const response = await runtime.dispatchFetch(
      "http://localhost/__fixture/bootstrap",
      { method: "POST" },
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.pristine.state, "idle");
    assert.equal(result.uninitialized_before_explicit_initialization, true);
    assert.equal(result.initialized.state, "idle");
    assert.equal(result.legacy_rechecked.state, "idle");
    assert.equal(result.legacy_rechecked.attempts, 3);
    assert.deepEqual(await calls(), before);
    return {
      actual_d1_do_lifecycle: true,
      pristine_without_implicit_initialization: true,
      normal_initialize_and_ingestion_remains_idle: true,
      legacy_attempt_three_rechecked_without_budget_reset: true,
      additional_matrix_io: 0,
    };
  });
  const send = (key, patch = {}) =>
    api(
      "/api/v1/conversations/conversation_integrated/messages",
      {
        identity_id: "identity_agent",
        account_id: "account_human",
        body: "Controlled local integration text",
        delivery_mode: "direct",
        ...patch,
      },
      { "idempotency-key": key },
    );
  await observe("authorized-read", async () => {
    const result = await api(
      "/api/v1/conversations/conversation_integrated/messages?identity_id=identity_agent&account_id=account_human",
    );
    assert.equal(result.status, 200);
    assert.ok(JSON.stringify(result.body).includes("message_integrated"));
    return { http_status: result.status, persisted_message_observed: true };
  });
  let accepted;
  await observe("authorized-send-real-gateway", async () => {
    accepted = await send("integrated-send-one");
    assert.equal(accepted.status, 202);
    const count = await calls();
    assert.equal(count.send_requests, 1);
    assert.notEqual(accepted.body.status, "delivered");
    report.authorized_control = {
      claim: await (
        await runtime.dispatchFetch("http://localhost/__fixture/claim-traces")
      ).json(),
      gateway: gatewayTraces.at(-1),
      adapter_command: accepted,
      persisted_command: await humanApi(`/api/v1/commands/${accepted.body.id}`),
      ledger_claim_count: (
        await (
          await runtime.getD1Database("CONTROL_DB", "communicator")
        )
          .prepare(
            "SELECT COUNT(*) AS count FROM outbound_dispatch_claims WHERE command_id = ?",
          )
          .bind(accepted.body.id)
          .first()
      ).count,
      calls: count,
    };
    return {
      http_status: 202,
      matrix_send_requests: count.send_requests,
      acceptance_is_not_provider_delivery: true,
    };
  });
  await observe("idempotent-replay-no-duplicate", async () => {
    assert.equal((await send("integrated-send-one")).status, 202);
    assert.equal((await calls()).send_requests, 1);
    return { matrix_send_requests: 1 };
  });
  await runEvidenceProof({
    observe,
    serviceApi,
    humanApi,
    accepted,
    evidencePath,
    calls,
  });
  report.evidence_traces = gatewayTraces.filter((item) =>
    /evidence/.test(item.path),
  );
  await observe("unsupported-paced-no-io", async () => {
    const before = await calls();
    const result = await send("integrated-paced", { delivery_mode: "paced" });
    assert.ok([400, 422].includes(result.status));
    assert.equal((await calls()).send_requests, before.send_requests);
    return { http_status: result.status, additional_matrix_sends: 0 };
  });
  await observe("cross-account-denial", async () => {
    const before = await calls();
    const result = await send("integrated-wrong-account", {
      account_id: "account_agent",
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "invalid_request");
    assert.equal((await calls()).send_requests, before.send_requests);
    return { http_status: result.status, additional_matrix_sends: 0 };
  });
  await observe("cross-tenant-denial", async () => {
    const result = await api("/api/v1/identities", undefined, {
      "x-communicator-tenant": "tenant_other",
    });
    assert.ok([403, 404].includes(result.status));
    return { http_status: result.status };
  });
  await observe("worker-process-restart-replay", async () => {
    const before = await calls();
    await runtime.dispose();
    runtime = new Miniflare(options());
    await runtime.ready;
    assert.equal((await send("integrated-send-one")).status, 202);
    assert.equal((await calls()).send_requests, before.send_requests);
    return {
      runtime_disposed_and_reconstructed: true,
      persisted_acceptance_replayed: true,
      additional_matrix_sends: 0,
    };
  });
  await observe("gateway-process-restart-replay", async () => {
    const before = await calls();
    fs.writeFileSync(stopPath, "stop", { mode: 0o600 });
    const deadline = Date.now() + 10_000;
    while (
      gateway.exitCode === null &&
      gateway.signalCode === null &&
      Date.now() < deadline
    )
      await pause(50);
    assert.equal(
      gateway.exitCode,
      0,
      "gateway must close its actual SDK and protected Store cleanly",
    );
    assert.equal(
      fs.existsSync(ready),
      false,
      "sidecar removes readiness before clean shutdown",
    );
    fs.rmSync(stopPath);
    gateway = launch();
    await waitFor(ready, gateway);
    assert.equal(
      JSON.parse(fs.readFileSync(ready, "utf8")).restored_state,
      true,
    );
    assert.equal((await send("integrated-send-one")).status, 202);
    assert.equal((await calls()).send_requests, before.send_requests);
    return {
      actual_gateway_process_restarted: true,
      protected_gateway_and_sdk_sqlite_reopened: true,
      additional_matrix_sends: 0,
      actual_login_claimed: false,
    };
  });
  const database = () => runtime.getD1Database("CONTROL_DB", "communicator");
  await observe("cross-chat-denial", async () => {
    const db = await database();
    const before = await calls();
    await db
      .prepare(
        "UPDATE account_grants SET chat_scope = 'selected_chats' WHERE id = 'grant_integrated_message_send'",
      )
      .run();
    try {
      const result = await send("integrated-chat-denied");
      assert.equal(result.status, 403);
      assert.equal((await calls()).send_requests, before.send_requests);
    } finally {
      await db
        .prepare(
          "UPDATE account_grants SET chat_scope = 'all_chats' WHERE id = 'grant_integrated_message_send'",
        )
        .run();
    }
    return {
      http_status: 403,
      selected_chat_grant_does_not_include_target: true,
      additional_matrix_sends: 0,
    };
  });
  const removalBoundary = (resourceType) => {
    let authority;
    const id = `final-boundary-${resourceType}-removal`;
    return [
      id,
      async (db) => {
        const acceptance = await db
          .prepare(
            "SELECT * FROM outbound_acceptance_intents WHERE status = 'committed' AND idempotency_key = ?",
          )
          .bind(id)
          .first();
        assert.ok(acceptance?.message_id);
        const response = await runtime.dispatchFetch(
          "http://localhost/__fixture/outbound-removal",
          {
            method: "POST",
            body: JSON.stringify({
              tenant_id: acceptance.tenant_id,
              resource_type: resourceType,
              resource_id:
                resourceType === "message"
                  ? acceptance.message_id
                  : acceptance.conversation_id,
              content_generation:
                resourceType === "message"
                  ? acceptance.message_id
                  : acceptance.conversation_id,
              account_id: acceptance.account_id,
              conversation_id: acceptance.conversation_id,
              reason: "requested",
            }),
          },
        );
        assert.equal(response.status, 200);
        authority = await response.json();
      },
      async (db) => {
        // This is a disposable local fixture, not a production ledger reset.
        if (authority)
          await db
            .prepare("DELETE FROM removal_authority WHERE id = ?")
            .bind(authority.id)
            .run();
      },
    ];
  };
  for (const [id, mutate, restore] of [
    [
      "final-boundary-grant-revocation",
      "UPDATE account_grants SET status = 'revoked', revoked_at = '2026-11-07T00:00:00.000Z' WHERE id = 'grant_integrated_message_send'",
      "UPDATE account_grants SET status = 'active', revoked_at = NULL WHERE id = 'grant_integrated_message_send'",
    ],
    [
      "final-boundary-route-rotation",
      "UPDATE connection_routes SET matrix_user_id = '@rotated:example.test' WHERE connection_id = 'connection_human_whatsapp'",
      "UPDATE connection_routes SET matrix_user_id = '@t13:example.test' WHERE connection_id = 'connection_human_whatsapp'",
    ],
    [
      "final-boundary-session-rotation",
      "UPDATE connections SET updated_at = '2026-08-30T00:00:00.000Z' WHERE id = 'connection_human_whatsapp'",
      "UPDATE connections SET updated_at = '2026-08-29T00:00:00.000Z' WHERE id = 'connection_human_whatsapp'",
    ],
    removalBoundary("message"),
    removalBoundary("conversation"),
  ])
    await observe(id, async () => {
      const db = await database();
      const before = await calls();
      let crossedBoundary = false;
      const traceStart = gatewayTraces.length;
      const claimStart = (
        await (
          await runtime.dispatchFetch("http://localhost/__fixture/claim-traces")
        ).json()
      ).length;
      beforeGateway = async () => {
        crossedBoundary = true;
        if (typeof mutate === "function") await mutate(db);
        else await db.prepare(mutate).run();
      };
      try {
        const result = await send(id);
        report.boundary_traces ??= [];
        const boundary = {
          id,
          claim: (
            await (
              await runtime.dispatchFetch(
                "http://localhost/__fixture/claim-traces",
              )
            ).json()
          ).slice(claimStart),
          gateway: gatewayTraces.slice(traceStart),
          adapter_command: result,
          persisted_command: await humanApi(
            `/api/v1/commands/${result.body.id}`,
          ),
          ledger_claim_count: (
            await db
              .prepare(
                "SELECT COUNT(*) AS count FROM outbound_dispatch_claims WHERE command_id = ?",
              )
              .bind(result.body.id)
              .first()
          ).count,
          calls_before: before,
          calls_after: await calls(),
        };
        report.boundary_traces.push(boundary);
        assert.equal(result.status, 202);
        assert.equal(crossedBoundary, true);
        assert.equal(result.body.status, "failed");
        assert.equal(result.body.failure_code, "authorization_revoked");
        assert.deepEqual(boundary.claim, [
          {
            status: 403,
            envelope: { status: "denied", reason: "authorization_revoked" },
          },
        ]);
        assert.equal(boundary.gateway.length, 1);
        assert.equal(boundary.gateway[0].path, "/v1/outbound/text");
        assert.equal(boundary.gateway[0].status, 200);
        const rejected = boundary.gateway[0].envelope;
        assert.equal(rejected.outcome, "rejected");
        assert.equal(rejected.reason, "authorization_revoked");
        assert.equal(rejected.account_id, "account_human");
        assert.equal(rejected.connection_id, "connection_human_whatsapp");
        assert.equal(rejected.session_generation, "2026-08-29T00:00:00.000Z");
        assert.equal(rejected.transaction_id, result.body.transaction_id);
        assert.equal(rejected.request_digest, result.body.request_digest);
        assert.equal(boundary.persisted_command.status, 200);
        assert.equal(
          boundary.persisted_command.body.command.id,
          result.body.id,
        );
        assert.equal(
          boundary.persisted_command.body.command.status,
          "cancelled",
        );
        assert.equal(
          boundary.persisted_command.body.command.failure_code,
          "authorization_revoked",
        );
        assert.equal(
          boundary.persisted_command.body.dispatch.status,
          "cancelled",
        );
        assert.equal(
          boundary.persisted_command.body.dispatch.uncertainty_reason,
          "authorization_revoked",
        );
        assert.equal(
          boundary.persisted_command.body.dispatch.transaction_id,
          result.body.transaction_id,
        );
        assert.equal(boundary.ledger_claim_count, 0);
        assert.deepEqual(boundary.calls_after, before);
      } finally {
        beforeGateway = undefined;
        if (typeof restore === "function") await restore(db);
        else await db.prepare(restore).run();
      }
      return {
        saved_before_mutation: true,
        final_real_http_claim_denied: true,
        additional_matrix_sends: 0,
      };
    });
  await observe("matrix-rejection", async () => {
    const before = await calls();
    fs.writeFileSync(path.join(scratch, "reject"), "reject", { mode: 0o600 });
    try {
      const result = await send("integrated-matrix-reject");
      assert.equal(result.status, 202);
      assert.equal(result.body.status, "failed");
      assert.equal((await calls()).send_rejections, before.send_rejections + 1);
    } finally {
      fs.rmSync(path.join(scratch, "reject"));
    }
    return {
      controlled_matrix_rejections: 1,
      provider_delivery_not_inferred: true,
    };
  });
  await runHistoryProof({
    observe,
    api,
    humanApi,
    rawApi,
    getRuntime: () => runtime,
    gatewayReady: JSON.parse(fs.readFileSync(ready, "utf8")),
    getGatewayStats: calls,
  });
  const fixtureCall = async (url, body) => {
    const response = await runtime.dispatchFetch(`http://localhost${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  await runOperationsProof({
    observe,
    api,
    humanApi,
    getRuntime: () => runtime,
    calls,
    fixtureCall,
  });
  report.operation_traces = gatewayTraces.filter((item) =>
    /receipt|group/.test(item.path),
  );
  await runWebhookProof({ observe, api, getRuntime: () => runtime });
  await runRecoveryProof({
    observe,
    api,
    humanApi,
    getRuntime: () => runtime,
    calls,
    fixtureCall,
    send,
    uncertainAccepted: async () => {
      loseGatewayResponse = true;
      const result = await send("integrated-recovery-uncertain");
      await runtime.dispose();
      runtime = new Miniflare(options());
      await runtime.ready;
      report.uncertain_worker_runtime_reconstructed = true;
      return result;
    },
  });
  await runRemovalProof({
    observe,
    api,
    humanApi,
    getRuntime: () => runtime,
    fixtureCall,
  });
  await observe("credential-revocation", async () => {
    const db = await runtime.getD1Database("IDENTITY_DB", "platform");
    await db
      .prepare(
        "UPDATE platform_credential SET revoked_at = ?, revoked_reason = 'revoked' WHERE id = ?",
      )
      .bind(Date.now(), fixture.actor.credentialId)
      .run();
    const before = await calls();
    assert.equal((await send("integrated-revoked")).status, 401);
    assert.equal((await calls()).send_requests, before.send_requests);
    return {
      http_status: 401,
      platform_revocation_fixture:
        "D1 authority mutation; not account HTTP revocation workflow",
      additional_matrix_sends: 0,
    };
  });
  await runRestoreActivationProof({
    observe,
    humanApi,
    fixtureCall,
    calls,
    retention,
  });
  observations.push(
    {
      id: "live-whatsapp-and-external-clients",
      scope: "external",
      status: "unverified",
      reason:
        "Not authorized. Controlled Matrix acceptance and bot reports do not prove real WhatsApp delivery or ChatGPT/Grok operations",
    },
    {
      id: "provider-read-evidence",
      scope: "external",
      status: "unsupported",
      reason: "Matrix m.read does not authenticate WhatsApp provider origin",
    },
    {
      id: "production-sdk-login-and-extracted-daemon-restore",
      scope: "external",
      status: "unverified",
      reason:
        "Sidecar uses persistent real SDK stores with synthetic authentication/join state, not the daemon bootstrap/restore constructor",
    },
  );
} catch (error) {
  console.error(error.message);
  observations.push({
    id: "runner-setup-or-execution",
    status: "defect",
    reason: "Runner could not finish; no omitted observation is a pass",
  });
} finally {
  const stopped = await Promise.allSettled([...children].map(stop));
  let disposed = true;
  if (runtime)
    await runtime.dispose().catch(() => {
      disposed = false;
    });
  if (!disposed || stopped.some((result) => result.status === "rejected"))
    observations.push({
      id: "runner-cleanup",
      status: "defect",
      reason: "Owned runtime or child process cleanup failed",
    });
  report.finished_at = new Date().toISOString();
  report.source.unchanged_during_run =
    report.source.content_sha256 === digest(JSON.stringify(sourceFiles()));
  if (!report.source.unchanged_during_run)
    observations.push({
      id: "source-changed-during-run",
      status: "defect",
      reason: "Source identity changed; rerun against a stable checkout",
    });
  report.local_acceptance =
    observations.length > 0 &&
    observations
      .filter((item) => item.scope !== "external")
      .every((item) => item.status === "pass");
  report.pilot_live_acceptance = false;
  report.cleanup = {
    child_processes_stopped: stopped.every(
      (result) => result.status === "fulfilled",
    ),
    runtime_disposed: disposed,
    ephemeral_state_removed: true,
  };
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    `Integrated local acceptance: ${report.local_acceptance ? "pass" : "incomplete"}; live acceptance: unverified; evidence: ${output}`,
  );
  process.exitCode = report.local_acceptance
    ? 0
    : observations.some((item) => item.status === "defect")
      ? 1
      : 2;
}
