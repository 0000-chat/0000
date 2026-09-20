import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  chmod,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { provisionTrustedOAuthClient } from "../../src/oauth-installation.ts";
import { opaqueSecret } from "../../src/platform-state.ts";
import { registerTestService } from "../../worker/test/fixtures/provision.ts";
import { PLATFORM_TEST_MINIFLARE_RATE_LIMITS } from "../test-rate-limits.ts";
import {
  FIXTURE,
  alternateBindingSql,
  baseDirectorySql,
  humanBindingSql,
  initialProjectionEvents,
  postRevocationProjectionEvents,
  projectionBatch,
  projectionInitialization,
} from "./fixture.mjs";
import { fetchBodyWithDeadline, fetchJsonWithDeadline } from "./http.mjs";
import {
  acquireResourceWithShutdownCleanup,
  assertCloseCode,
  evaluateWithDeadline,
  runBoundedCleanup,
  terminateProcessGroup,
} from "./lifecycle.mjs";

const harnessRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(harnessRoot, "../../../../");
const platformRoot = join(repoRoot, "services/platform");
const communicatorRoot = join(repoRoot, "services/communicator");
const communicatorApp = join(communicatorRoot, "apps/control-plane");
const communicatorMigrations = join(communicatorApp, "migrations");
const wrapperPath = join(harnessRoot, "communicator-wrapper.mjs");
const workerEntry = join(platformRoot, "src/worker.ts");
const operationTimeoutMs = 30_000;
const httpTimeoutMs = 5_000;
const startupTimeoutMs = 120_000;
const cleanupTimeoutMs = 8_000;
const processCleanupTimeoutMs = cleanupTimeoutMs * 2 + 1_000;
const compatibilityDate = "2026-09-18";
const authority = "platform-composition-browser-authority";
const service = {
  serviceId: "composition-browser-service",
  audience: "https://composition-browser.0000.test",
  verifier: opaqueSecret("composition_service_verify_"),
  guestGrantIssuer: opaqueSecret("composition_guest_grant_"),
  allowedCapabilities: ["conversation.read", "message.send", "connection.read"],
};
const providerIdentity = {
  id: 817321,
  login: "composition-browser-user",
  name: "Composition Browser User",
  email: "composition-browser@example.test",
};

const safeLog = [];
const state = {
  failed: false,
  failure: null,
  stage: "initializing",
  safeLogPath: null,
  tempRoot: null,
  platform: null,
  platformBridge: null,
  platformProxy: null,
  communicator: null,
  browser: null,
  activeChildren: new Set(),
  shutdownController: new AbortController(),
  shuttingDown: false,
  cleanupFailures: [],
  pendingResources: new Set(),
};

function stage(name) {
  assertActive();
  state.stage = name;
}

function assertActive() {
  if (state.shuttingDown || state.shutdownController.signal.aborted)
    throw new Error("harness_interrupted");
}

function trackPendingResource(promise) {
  state.pendingResources.add(promise);
  promise.then(
    () => state.pendingResources.delete(promise),
    () => state.pendingResources.delete(promise),
  );
  promise.catch(() => {});
  return promise;
}

function record(event, fields = {}) {
  const line = JSON.stringify({ event, ...fields });
  safeLog.push(line);
  console.log(line);
}

function safeFailure(error) {
  return error instanceof Error ? error.name : "unknown";
}

async function within(
  label,
  operation,
  timeoutMs = operationTimeoutMs,
  { allowShutdown = false } = {},
) {
  let timer;
  let abortShutdown;
  const shutdownPromise = allowShutdown
    ? null
    : new Promise((_, reject) => {
        abortShutdown = () => reject(new Error("harness_interrupted"));
        if (state.shutdownController.signal.aborted) abortShutdown();
        else
          state.shutdownController.signal.addEventListener(
            "abort",
            abortShutdown,
            { once: true },
          );
      });
  try {
    const operations = [
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}_timeout`)),
          timeoutMs,
        );
      }),
    ];
    if (shutdownPromise) operations.push(shutdownPromise);
    return await Promise.race(operations);
  } finally {
    clearTimeout(timer);
    if (abortShutdown)
      state.shutdownController.signal.removeEventListener(
        "abort",
        abortShutdown,
      );
  }
}

async function sleep(milliseconds) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function waitFor(label, predicate, timeoutMs = operationTimeoutMs) {
  assertActive();
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    assertActive();
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`${label}_timeout`);
}

async function writePrivate(path, contents) {
  await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function hashFile(path) {
  const digest = createHash("sha256");
  digest.update(await readFile(path));
  return digest.digest("hex");
}

async function hashSources(paths) {
  const entries = {};
  for (const path of paths)
    entries[path.replace(`${repoRoot}/`, "")] = await hashFile(path);
  return entries;
}

async function allocateFreePort() {
  const server = createServer();
  await within(
    "free_port_listen",
    new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolveListen();
      });
    }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await within(
    "free_port_close",
    new Promise((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose())),
    ),
  );
  return port;
}

async function requestFromNode(request, origin) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (
      value !== undefined &&
      name !== "content-length" &&
      name !== "connection"
    ) {
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  const init = { method: request.method, headers, redirect: "manual" };
  if (
    chunks.length > 0 &&
    request.method !== "GET" &&
    request.method !== "HEAD"
  ) {
    init.body = Buffer.concat(chunks);
  }
  return new Request(`${origin}${request.url ?? "/"}`, init);
}

async function writeNodeResponse(response, nodeResponse) {
  const outputHeaders = {};
  for (const [name, value] of response.headers) {
    if (
      [
        "connection",
        "content-length",
        "keep-alive",
        "transfer-encoding",
        "set-cookie",
      ].includes(name)
    )
      continue;
    outputHeaders[name] = value;
  }
  const cookies =
    response.headers.getSetCookie?.() ??
    [response.headers.get("set-cookie") ?? ""].filter(Boolean);
  if (cookies.length > 0) outputHeaders["set-cookie"] = cookies;
  const body = Buffer.from(
    await within("node_response_body", response.arrayBuffer()),
  );
  outputHeaders["content-length"] = String(body.byteLength);
  nodeResponse.writeHead(response.status, outputHeaders);
  nodeResponse.end(body);
}

function forwardHeaders(request, host) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (
      value === undefined ||
      ["connection", "content-length", "host"].includes(name)
    )
      continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  headers.host = host;
  return headers;
}

async function readNodeBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

async function listenPlatformBridge(platformOrigin) {
  let requestOrigin = platformOrigin;
  let platform;
  const server = createServer((request, response) => {
    void (async () => {
      if (!platform) {
        await writeNodeResponse(
          Response.json({ error: "platform_unavailable" }, { status: 503 }),
          response,
        );
        return;
      }
      const webRequest = await requestFromNode(request, requestOrigin);
      await writeNodeResponse(
        await platform.dispatchFetch(webRequest),
        response,
      );
    })().catch(async () => {
      await writeNodeResponse(
        Response.json({ error: "platform_unavailable" }, { status: 503 }),
        response,
      );
    });
  });
  await within(
    "platform_bridge_listen",
    new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolveListen();
      });
    }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    setPlatform(value) {
      platform = value;
    },
    setOrigin(value) {
      requestOrigin = value;
    },
    async close() {
      await within(
        "platform_bridge_close",
        new Promise((resolveClose, reject) =>
          server.close((error) => (error ? reject(error) : resolveClose())),
        ),
        cleanupTimeoutMs,
        { allowShutdown: true },
      );
    },
  };
}

async function listenPlatformProxy(upstreamOrigin) {
  let outage = false;
  let proxyOrigin = "";
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? "/", "http://composition.invalid")
        .pathname;
      if (pathname === "/__composition/outage" && request.method === "POST") {
        outage = true;
        await writeNodeResponse(Response.json({ ok: true }), response);
        return;
      }
      if (pathname === "/__composition/recover" && request.method === "POST") {
        outage = false;
        await writeNodeResponse(Response.json({ ok: true }), response);
        return;
      }
      if (outage) {
        await writeNodeResponse(
          Response.json({ error: "platform_unavailable" }, { status: 503 }),
          response,
        );
        return;
      }
      const body = await readNodeBody(request);
      const { response: upstream, body: upstreamBody } =
        await fetchBodyWithDeadline(
          `${upstreamOrigin}${request.url ?? "/"}`,
          {
            method: request.method,
            headers: forwardHeaders(request, new URL(proxyOrigin).host),
            body,
            redirect: "manual",
          },
          {
            shutdownSignal: state.shutdownController.signal,
            timeoutMs: httpTimeoutMs,
          },
        );
      const headers = new Headers(upstream.headers);
      const location = headers.get("location");
      if (location)
        headers.set("location", location.replace(upstreamOrigin, proxyOrigin));
      await writeNodeResponse(
        new Response(upstreamBody, {
          status: upstream.status,
          headers,
        }),
        response,
      );
    })().catch(async () => {
      await writeNodeResponse(
        Response.json({ error: "platform_unavailable" }, { status: 503 }),
        response,
      );
    });
  });
  await within(
    "platform_proxy_listen",
    new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolveListen();
      });
    }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  proxyOrigin = `http://127.0.0.1:${address.port}`;
  return {
    origin: proxyOrigin,
    outage: () => outage,
    async close() {
      await within(
        "platform_proxy_close",
        new Promise((resolveClose, reject) =>
          server.close((error) => (error ? reject(error) : resolveClose())),
        ),
        cleanupTimeoutMs,
        { allowShutdown: true },
      );
    },
  };
}

function providerOutbound(request) {
  const url = new URL(request.url);
  if (
    url.hostname === "github.com" &&
    url.pathname === "/login/oauth/access_token"
  ) {
    return Response.json({
      access_token: "composition-provider-access",
      token_type: "bearer",
      scope: "read:user user:email",
    });
  }
  if (url.hostname === "api.github.com" && url.pathname === "/user") {
    return Response.json({
      id: providerIdentity.id,
      login: providerIdentity.login,
      name: providerIdentity.name,
      avatar_url: null,
    });
  }
  if (url.hostname === "api.github.com" && url.pathname === "/user/emails") {
    return Response.json([
      { email: providerIdentity.email, primary: true, verified: true },
    ]);
  }
  throw new Error("unexpected_provider_request");
}

async function buildPlatformWorker() {
  const result = await Bun.build({
    entrypoints: [workerEntry],
    external: ["cloudflare:workers"],
    format: "esm",
    naming: "worker.js",
    target: "browser",
  });
  if (!result.success) throw new Error("platform_worker_build_failed");
  const entry = result.outputs.find((output) => output.kind === "entry-point");
  if (!entry) throw new Error("platform_worker_entry_missing");
  return entry.text();
}

async function applyMigrations(database, directory) {
  const migrations = await readD1Migrations(directory);
  for (const migration of migrations) {
    if (migration.queries.length > 0) {
      await within(
        "platform_migration_batch",
        database.batch(
          migration.queries.map((query) => database.prepare(query)),
        ),
      );
    }
  }
}

async function createPlatformRuntime(tempRoot, proxyOrigin) {
  assertActive();
  const bridge = await listenPlatformBridge(proxyOrigin);
  state.platformBridge = bridge;
  assertActive();
  const proxy = await listenPlatformProxy(bridge.origin);
  state.platformProxy = proxy;
  assertActive();
  bridge.setOrigin(proxy.origin);
  const script = await buildPlatformWorker();
  assertActive();
  const secret = opaqueSecret("composition_platform_secret_");
  const platformState = join(tempRoot, "platform-state");
  const platform = new Miniflare(
    convertV4MiniflareOptions({
      bindings: {
        BETTER_AUTH_SECRET: secret,
        GITHUB_CLIENT_ID: "composition-github-client",
        GITHUB_CLIENT_SECRET: opaqueSecret("composition_github_secret_"),
        PLATFORM_AUTHORITY_ID: authority,
        PLATFORM_BASE_URL: proxy.origin,
        PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS: "90",
        PLATFORM_SERVER_DEADLINE_MS: "8000",
        PLATFORM_RATE_LIMIT_POLICY: "",
        PLATFORM_DEPLOYMENT_MODE: "self-hosted",
        PLATFORM_SIGNUP_POLICY: "open",
      },
      compatibilityDate,
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { IDENTITY_DB: "composition-platform-identity" },
      ratelimits: PLATFORM_TEST_MINIFLARE_RATE_LIMITS,
      host: "127.0.0.1",
      modules: true,
      name: "composition-platform-runtime",
      outboundService: providerOutbound,
      resourcePersistencePath: platformState,
      script,
    }),
  );
  state.platform = platform;
  await within("platform_ready", platform.ready);
  assertActive();
  const database = await platform.getD1Database("IDENTITY_DB");
  await applyMigrations(database, join(platformRoot, "migrations"));
  assertActive();
  await registerTestService(database, service);
  assertActive();
  bridge.setPlatform(platform);
  return { platform, database, proxyOrigin: proxy.origin, secret };
}

async function runCommand(args, options) {
  assertActive();
  const logHandle = await open(options.logPath, "w", 0o600);
  let child;
  try {
    child = spawn("pnpm", args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      detached: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
    });
  } catch {
    await logHandle.close().catch(() => {});
    throw new Error("child_spawn_failed");
  }
  state.activeChildren.add(child);
  try {
    const result = await within(
      "child_command",
      new Promise((resolveCommand, rejectCommand) => {
        child.once("error", () =>
          rejectCommand(new Error("child_spawn_failed")),
        );
        child.once("close", (code, signal) => resolveCommand({ code, signal }));
      }),
      options.timeoutMs ?? startupTimeoutMs,
    );
    await stopProcess(child);
    assertActive();
    if (result.code !== 0) throw new Error("child_command_failed");
  } catch (error) {
    await stopProcess(child).catch(() => {});
    throw error;
  } finally {
    state.activeChildren.delete(child);
    await logHandle.close().catch(() => {});
  }
}

async function stopProcess(child) {
  const result = await terminateProcessGroup(child);
  if (!result.groupGone) throw new Error("child_group_cleanup_failed");
  if (child) state.activeChildren.delete(child);
  return result;
}

async function buildCommunicatorAssets(tempRoot) {
  assertActive();
  const buildRoot = join(tempRoot, "communicator-build");
  const buildLog = join(tempRoot, "communicator-build.log");
  await runCommand(["vite", "build", "--outDir", buildRoot], {
    cwd: communicatorApp,
    env: { VITE_DEPLOYMENT_ENV: "local", VITE_DATA_MODE: "live" },
    logPath: buildLog,
  });
  assertActive();
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(path);
    }
  }
  await visit(buildRoot);
  for (const file of files) {
    const contents = await readFile(file);
    assert.equal(contents.includes(Buffer.from("DEBUG_BROWSER_")), false);
    assert.equal(contents.includes(Buffer.from("T11_BROWSER")), false);
  }
  return buildRoot;
}

async function createCommunicatorRuntime(tempRoot, values, platformRuntime) {
  assertActive();
  const port = values.port;
  const baseUrl = `http://localhost:${port}`;
  const buildRoot = await buildCommunicatorAssets(tempRoot);
  assertActive();
  const configRoot = join(tempRoot, "communicator-config");
  const stateRoot = join(tempRoot, "communicator-state");
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(configRoot, { recursive: true, mode: 0o700 }),
  );
  assertActive();
  const configPath = join(configRoot, "wrangler.jsonc");
  const config = {
    name: `composition-communicator-${process.pid}`,
    main: wrapperPath,
    compatibility_date: "2026-08-27",
    compatibility_flags: ["nodejs_compat"],
    assets: {
      not_found_handling: "single-page-application",
      run_worker_first: [
        "/api/*",
        "/internal/*",
        "/auth/*",
        "/oauth/*",
        "/.well-known/*",
        "/mcp",
        "/__composition/*",
      ],
    },
    exports: {
      TenantProjectionDO: { type: "durable-object", storage: "sqlite" },
      LinkSessionDO: { type: "durable-object", storage: "sqlite" },
    },
    durable_objects: {
      bindings: [
        { name: "TENANT_PROJECTION", class_name: "TenantProjectionDO" },
        { name: "LINK_SESSIONS", class_name: "LinkSessionDO" },
      ],
    },
    d1_databases: [
      {
        binding: "CONTROL_DB",
        database_name: `composition-control-${process.pid}`,
        database_id: "00000000-0000-0000-0000-000000000001",
        migrations_dir: communicatorMigrations,
      },
    ],
    r2_buckets: [
      {
        binding: "EVENT_ARCHIVE",
        bucket_name: `composition-archive-${process.pid}`,
      },
    ],
    queues: {
      producers: [
        {
          binding: "INGESTION_QUEUE",
          queue: `composition-ingestion-${process.pid}`,
        },
      ],
      consumers: [
        {
          queue: `composition-ingestion-${process.pid}`,
          max_batch_size: 10,
          max_batch_timeout: 5,
          max_retries: 10,
          retry_delay: 60,
          max_concurrency: 5,
          dead_letter_queue: `composition-ingestion-dlq-${process.pid}`,
        },
      ],
    },
  };
  await writePrivate(configPath, `${JSON.stringify(config, null, 2)}\n`);
  assertActive();
  const devVars = [
    ["COMMUNICATOR_ENV", "local"],
    ["COMMUNICATOR_DATA_MODE", "live"],
    ["COMMUNICATOR_PLATFORM_BASE_URL", platformRuntime.proxyOrigin],
    ["COMMUNICATOR_PLATFORM_AUTHORITY", authority],
    ["COMMUNICATOR_PLATFORM_AUDIENCE", service.audience],
    ["COMMUNICATOR_PLATFORM_SERVICE_VERIFIER", service.verifier],
    ["COMMUNICATOR_PLATFORM_BROWSER_CLIENT_ID", values.clientId],
    ["COMMUNICATOR_PLATFORM_BROWSER_CLIENT_SECRET", values.clientSecret],
    ["COMMUNICATOR_PLATFORM_BROWSER_REDIRECT_URI", `${baseUrl}/auth/callback`],
    ["COMMUNICATOR_PLATFORM_BROWSER_RESOURCE", service.audience],
    [
      "COMMUNICATOR_PLATFORM_BROWSER_SCOPES",
      service.allowedCapabilities.join(" "),
    ],
    ["COMMUNICATOR_INGRESS_ENABLED", "false"],
    ["CONNECTION_GATEWAY_URL", "https://composition-gateway.0000.test"],
    ["COMPOSITION_HARNESS_TOKEN", values.harnessToken],
  ]
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  await writePrivate(join(configRoot, ".dev.vars"), `${devVars}\n`);
  const logs = join(tempRoot, "communicator-logs");
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(logs, { recursive: true, mode: 0o700 }),
  );
  assertActive();
  const migrationLog = join(logs, "migrations.log");
  await runCommand(
    [
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "CONTROL_DB",
      "--local",
      "--persist-to",
      stateRoot,
      "--config",
      configPath,
    ],
    { cwd: communicatorApp, logPath: migrationLog },
  );
  assertActive();
  const baseSqlPath = join(configRoot, "base-directory.sql");
  await writePrivate(baseSqlPath, baseDirectorySql());
  await runCommand(
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "CONTROL_DB",
      "--local",
      "--persist-to",
      stateRoot,
      "--file",
      baseSqlPath,
      "--config",
      configPath,
    ],
    { cwd: communicatorApp, logPath: join(logs, "base-directory.log") },
  );
  assertActive();
  const childLogPath = join(logs, "worker.log");
  const logFile = await open(childLogPath, "w", 0o600);
  const runtime = {
    baseUrl,
    port,
    child: null,
    buildRoot,
    configRoot,
    stateRoot,
    logFile,
  };
  state.communicator = runtime;
  let child;
  let childError = null;
  let childExited = false;
  try {
    assertActive();
    child = spawn(
      "pnpm",
      [
        "exec",
        "wrangler",
        "dev",
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--persist-to",
        stateRoot,
        "--assets",
        join(buildRoot, "client"),
        "--config",
        configPath,
      ],
      {
        cwd: communicatorApp,
        env: { ...process.env },
        detached: true,
        stdio: ["ignore", logFile.fd, logFile.fd],
      },
    );
    runtime.child = child;
    state.activeChildren.add(child);
    child.once("error", (error) => {
      childError = error;
    });
    child.once("close", () => {
      childExited = true;
    });
    await waitFor(
      "communicator_health",
      async () => {
        if (childError) throw new Error("communicator_spawn_failed");
        if (childExited) throw new Error("communicator_exited_before_health");
        try {
          const { response } = await fetchBodyWithDeadline(
            `${baseUrl}/api/v1/health`,
            {},
            {
              shutdownSignal: state.shutdownController.signal,
              timeoutMs: httpTimeoutMs,
            },
          );
          return response.status === 200;
        } catch (error) {
          if (state.shutdownController.signal.aborted) throw error;
          return false;
        }
      },
      startupTimeoutMs,
    );
    assertActive();
    return runtime;
  } catch (error) {
    await stopProcess(child).catch(() => {});
    await logFile.close().catch(() => {});
    throw error;
  }
}

async function seedBinding(communicator, sql, label) {
  const path = join(communicator.configRoot, `${label}.sql`);
  await writePrivate(path, sql);
  await runCommand(
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "CONTROL_DB",
      "--local",
      "--persist-to",
      communicator.stateRoot,
      "--file",
      path,
      "--config",
      join(communicator.configRoot, "wrangler.jsonc"),
    ],
    {
      cwd: communicatorApp,
      logPath: join(communicator.configRoot, `${label}.log`),
    },
  );
}

async function postJson(url, body, headers = {}) {
  return fetchJsonWithDeadline(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      redirect: "manual",
    },
    {
      shutdownSignal: state.shutdownController.signal,
      timeoutMs: httpTimeoutMs,
    },
  );
}

async function pageEvaluate(page, label, pageFunction, arg) {
  return within(
    label,
    evaluateWithDeadline(page, pageFunction, arg, {
      label,
      timeoutMs: operationTimeoutMs,
    }),
    operationTimeoutMs,
  );
}

async function safeJson(response) {
  try {
    return await within("playwright_response_body", response.json());
  } catch (error) {
    if (state.shutdownController.signal.aborted) throw error;
    return {};
  }
}

function cookieMetadata(cookie) {
  return cookie === undefined
    ? { present: false }
    : {
        present: true,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        path: cookie.path,
        hostOnly: !cookie.domain.startsWith("."),
      };
}

async function platformLogin(page, platformOrigin, callbackOrigin) {
  await page.goto(`${platformOrigin}/login`, { waitUntil: "domcontentloaded" });
  const start = await pageEvaluate(
    page,
    "platform_login_start_evaluate",
    async ({ callbackURL, requestTimeoutMs }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await fetch("/api/auth/sign-in/social", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: "github",
            callbackURL,
            disableRedirect: true,
          }),
          signal: controller.signal,
        });
        const text = await response.text();
        let body = {};
        try {
          body = text.length > 0 ? JSON.parse(text) : {};
        } catch {}
        return { status: response.status, url: body.url };
      } finally {
        clearTimeout(timer);
      }
    },
    { callbackURL: callbackOrigin, requestTimeoutMs: httpTimeoutMs },
  );
  assert.equal(start.status, 200);
  assert.equal(typeof start.url, "string");
  const stateValue = new URL(start.url).searchParams.get("state");
  assert.equal(typeof stateValue, "string");
  await page.goto(
    `${platformOrigin}/api/auth/callback/github?code=composition-browser-callback&state=${encodeURIComponent(stateValue)}`,
    { waitUntil: "domcontentloaded" },
  );
  const account = await pageEvaluate(
    page,
    "platform_login_account_evaluate",
    async ({ requestTimeoutMs }) => {
      const fetchJson = async (input) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
          const response = await fetch(input, { signal: controller.signal });
          const text = await response.text();
          let body = {};
          try {
            body = text.length > 0 ? JSON.parse(text) : {};
          } catch {}
          return { status: response.status, body };
        } finally {
          clearTimeout(timer);
        }
      };
      const [session, me] = await Promise.all([
        fetchJson("/api/auth/get-session"),
        fetchJson("/api/me"),
      ]);
      return {
        sessionStatus: session.status,
        authenticated: Boolean(session.body?.user),
        meStatus: me.status,
        hasUserId: typeof me.body?.userId === "string",
        hasOrganizationId: typeof me.body?.organizationId === "string",
        hasMembershipId: typeof me.body?.membershipId === "string",
        userId: me.body?.userId,
        organizationId: me.body?.organizationId,
        membershipId: me.body?.membershipId,
      };
    },
    { requestTimeoutMs: httpTimeoutMs },
  );
  assert.equal(account.sessionStatus, 200);
  assert.equal(account.authenticated, true);
  assert.equal(account.meStatus, 200);
  assert.equal(account.hasUserId, true);
  assert.equal(account.hasOrganizationId, true);
  assert.equal(account.hasMembershipId, true);
  return account;
}

async function createAlternateOrganization(page, platformOrigin) {
  const response = await page.request.post(
    `${platformOrigin}/api/account/organizations/create`,
    {
      headers: { origin: platformOrigin, "content-type": "application/json" },
      data: JSON.stringify({ name: `Composition Alternate ${Date.now()}` }),
    },
  );
  const body = await response.json().catch(() => ({}));
  assert.equal(response.status(), 201);
  assert.equal(typeof body.organizationId, "string");
  assert.equal(typeof body.membershipId, "string");
  return {
    organizationId: body.organizationId,
    membershipId: body.membershipId,
  };
}

async function communicatorLogin(
  page,
  values,
  selectedOrganizationId,
  returnTo,
) {
  const commBase = values.commBase;
  const platformOrigin = values.platformOrigin;
  await page.goto(
    `${commBase}/auth/login?return_to=${encodeURIComponent(returnTo)}`,
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForURL((url) => url.pathname === "/oauth2/selection", {
    waitUntil: "domcontentloaded",
  });
  const selection = page.locator("form").first();
  await selection
    .locator('select[name="organizationId"]')
    .selectOption(selectedOrganizationId);
  const selectionResponse = await page.request.post(
    `${platformOrigin}/oauth2/selection`,
    {
      headers: { origin: platformOrigin },
      form: {
        flowId: await selection.locator('input[name="flowId"]').inputValue(),
        organizationId: selectedOrganizationId,
      },
      maxRedirects: 0,
    },
  );
  assert.equal(selectionResponse.status(), 303);
  const consentLocation = selectionResponse.headers().location;
  assert.equal(typeof consentLocation, "string");
  await page.goto(consentLocation, { waitUntil: "domcontentloaded" });
  await page.locator("h1").filter({ hasText: "Approve access" }).waitFor();
  const consent = page
    .locator('form[action="/api/auth/oauth2/consent"]')
    .first();
  const consentResponse = await page.request.post(
    `${platformOrigin}/api/auth/oauth2/consent`,
    {
      headers: { origin: platformOrigin },
      form: {
        accept: "true",
        oauth_query: await consent
          .locator('input[name="oauth_query"]')
          .inputValue(),
        flow_id: await consent.locator('input[name="flow_id"]').inputValue(),
      },
      maxRedirects: 0,
    },
  );
  assert.equal(consentResponse.status(), 303);
  const callbackLocation = consentResponse.headers().location;
  assert.equal(typeof callbackLocation, "string");
  await page.goto(callbackLocation, { waitUntil: "networkidle" });
}

async function inspectCommunicatorSession(page, expected) {
  const response = await page.request.get(
    `${expected.commBase}/api/v1/session`,
  );
  const body = await safeJson(response);
  const identityIds = Array.isArray(body.identities)
    ? body.identities.map((identity) => identity.identity_id)
    : [];
  return {
    status: response.status(),
    expectedBinding: body.binding_id === expected.bindingId,
    expectedTenant: body.tenant?.id === expected.tenantId,
    expectedMembership: body.membership?.id === expected.membershipId,
    expectedIdentity: identityIds.includes(expected.identityId),
  };
}

async function projectionCall(baseUrl, token, path, input, details = false) {
  const { response, body } = await fetchJsonWithDeadline(
    `${baseUrl}/__composition/projection/${path}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-composition-harness-token": token,
      },
      body: JSON.stringify({ tenant_id: FIXTURE.tenantId, input }),
    },
    {
      shutdownSignal: state.shutdownController.signal,
      timeoutMs: httpTimeoutMs,
    },
  );
  if (!details) return response.status;
  return {
    status: response.status,
    failureKind:
      typeof body.failure_kind === "string" ? body.failure_kind : null,
    failureCode:
      typeof body.failure_code === "string" ? body.failure_code : null,
  };
}

async function issueRealtimeTicket(page, baseUrl, includeResume) {
  const response = await page.request.post(
    `${baseUrl}/api/v1/realtime/tickets`,
    {
      headers: { origin: baseUrl },
      data: {
        schema_version: 1,
        subscriptions: [
          { identity_id: FIXTURE.identityId, families: ["projection"] },
        ],
        ...(includeResume
          ? {
              resume: [
                {
                  identity_id: FIXTURE.identityId,
                  generation: 1,
                  after_sequence: 0,
                },
              ],
            }
          : {}),
      },
    },
  );
  return { response, body: await safeJson(response) };
}

async function realtimeObservation(
  page,
  ticketBody,
  slotName = "__compositionRealtime",
  expectedIdentityId = FIXTURE.identityId,
) {
  const result = await page.evaluate(
    ({ expectedIdentityId, slotName, websocketUrl }) =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(websocketUrl, "communicator.realtime.v1");
        window[slotName] = socket;
        const closeCodeSlot = `${slotName}CloseCode`;
        const closeSeenSlot = `${slotName}CloseSeen`;
        const metricsSlot = `${slotName}Metrics`;
        window[closeCodeSlot] = null;
        window[closeSeenSlot] = false;
        const state = {
          connected: false,
          allowedChangeCount: 0,
          deniedChangeVisible: false,
          resetReason: null,
          subprotocol: "",
          projectionChangeCount: 0,
          postRevocationDeliveryCount: 0,
          trackPostRevocation: false,
          identityFrameCount: 0,
          identityMatched: true,
        };
        window[metricsSlot] = state;
        let settled = false;
        const timer = setTimeout(
          () => reject(new Error("realtime_observation_timeout")),
          20_000,
        );
        socket.addEventListener("open", () => {
          state.subprotocol = socket.protocol;
        });
        socket.addEventListener("message", (event) => {
          let body;
          try {
            body = JSON.parse(event.data);
          } catch {
            return;
          }
          if (body.type === "connected") state.connected = true;
          if (body.type === "projection.changes") {
            const changes = Array.isArray(body.changes) ? body.changes : [];
            state.projectionChangeCount += changes.length;
            if (state.trackPostRevocation)
              state.postRevocationDeliveryCount += changes.length;
            if (typeof body.identity_id === "string") {
              state.identityFrameCount += 1;
              if (body.identity_id !== expectedIdentityId)
                state.identityMatched = false;
            }
            state.allowedChangeCount += changes.filter(
              (change) =>
                change?.connection_id === "connection_composition_allowed",
            ).length;
            if (
              changes.some(
                (change) =>
                  change?.connection_id === "connection_composition_denied",
              )
            )
              state.deniedChangeVisible = true;
          }
          if (body.type === "reset_required") {
            if (typeof body.identity_id === "string") {
              state.identityFrameCount += 1;
              if (body.identity_id !== expectedIdentityId)
                state.identityMatched = false;
            }
            state.resetReason =
              typeof body.reason === "string" ? body.reason : "unknown";
          }
          if (
            state.connected &&
            state.allowedChangeCount >= 1 &&
            state.resetReason !== null
          ) {
            clearTimeout(timer);
            settled = true;
            resolve(state);
          }
        });
        socket.addEventListener(
          "error",
          () => settled || reject(new Error("realtime_socket_error")),
        );
        socket.addEventListener("close", (event) => {
          window[closeSeenSlot] = true;
          window[closeCodeSlot] = event.code;
          if (!settled) reject(new Error(`realtime_closed_${event.code}`));
        });
      }),
    {
      expectedIdentityId,
      slotName,
      websocketUrl: ticketBody.websocket_url,
    },
  );
  return result;
}

async function runBrowserComposition(
  platformRuntime,
  communicator,
  client,
  phase = "full",
) {
  assertActive();
  const playwrightCandidates = [
    process.env.T11_PLAYWRIGHT_MODULE,
    join(communicatorApp, "node_modules/@playwright/test/index.mjs"),
    join(communicatorRoot, "node_modules/@playwright/test/index.mjs"),
  ].filter(Boolean);
  let playwrightModule;
  for (const candidate of playwrightCandidates) {
    try {
      playwrightModule = await import(pathToFileURL(resolve(candidate)).href);
      break;
    } catch {}
  }
  if (!playwrightModule) throw new Error("playwright_module_missing");
  const browserAcquisition = acquireResourceWithShutdownCleanup(
    playwrightModule.chromium.launch({ headless: true }),
    {
      isShutdown: () =>
        state.shuttingDown || state.shutdownController.signal.aborted,
      dispose: (browser) => browser.close(),
      label: "late_browser_close",
      timeoutMs: cleanupTimeoutMs,
    },
  )
    .then((browser) => {
      if (browser) state.browser = browser;
      return browser;
    })
    .catch((error) => {
      if (state.shuttingDown || state.shutdownController.signal.aborted) {
        state.cleanupFailures.push("late_browser_close");
        throw new Error("late_browser_close_failed");
      }
      throw error;
    });
  trackPendingResource(browserAcquisition);
  const browser = await within(
    "browser_launch",
    browserAcquisition,
    startupTimeoutMs,
  );
  if (!browser) throw new Error("harness_interrupted");
  assertActive();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  assertActive();
  const page = await context.newPage();
  page.setDefaultTimeout(operationTimeoutMs);
  page.setDefaultNavigationTimeout(operationTimeoutMs);
  let browserErrors = 0;
  let failedRequests = 0;
  const playwrightSocketStates = [];
  page.on("pageerror", () => {
    browserErrors += 1;
  });
  page.on("requestfailed", () => {
    failedRequests += 1;
  });
  page.on("websocket", (socket) => {
    const state = {
      url: socket.url(),
      closed: false,
      projectionChangeCount: 0,
      postRevocationProjectionChangeCount: 0,
      identityMatched: true,
      trackPostRevocation: false,
    };
    playwrightSocketStates.push(state);
    socket.on("framereceived", ({ payload }) => {
      let body;
      try {
        body = JSON.parse(
          typeof payload === "string" ? payload : payload.toString(),
        );
      } catch {
        return;
      }
      if (
        typeof body?.identity_id === "string" &&
        body.identity_id !== FIXTURE.identityId
      )
        state.identityMatched = false;
      if (body?.type !== "projection.changes") return;
      const changes = Array.isArray(body.changes) ? body.changes : [];
      state.projectionChangeCount += changes.length;
      if (state.trackPostRevocation)
        state.postRevocationProjectionChangeCount += changes.length;
    });
    socket.on("close", () => {
      state.closed = true;
    });
  });
  stage("platform_login");
  const platformAccount = await platformLogin(
    page,
    platformRuntime.proxyOrigin,
    `${platformRuntime.proxyOrigin}/account`,
  );
  record("platform_startup", {
    status: 200,
    authenticated: true,
    selectionRoutesReachable: true,
    consentRoutesReachable: true,
    callbackRoutesReachable: true,
  });
  stage("alternate_organization");
  const alternate = await createAlternateOrganization(
    page,
    platformRuntime.proxyOrigin,
  );
  record("platform_alternate_organization", { status: 201, created: true });
  stage("primary_binding_seed");
  await seedBinding(
    communicator,
    humanBindingSql({
      authority,
      subjectId: platformAccount.userId,
      organizationId: platformAccount.organizationId,
      membershipId: platformAccount.membershipId,
    }),
    "primary-binding",
  );
  stage("alternate_binding_seed");
  await seedBinding(
    communicator,
    alternateBindingSql({
      authority,
      subjectId: platformAccount.userId,
      organizationId: alternate.organizationId,
      membershipId: alternate.membershipId,
    }),
    "alternate-binding",
  );
  record("communicator_local_seed", {
    directory: true,
    primaryBinding: true,
    alternateBinding: true,
    allowedAccountGrant: true,
    deniedAccountGrant: false,
  });

  stage("protected_before_login");
  const unauthenticated = await page.request.get(
    `${communicator.baseUrl}/api/v1/session`,
  );
  assert.equal(unauthenticated.status(), 401);
  record("protected_before_login", { status: unauthenticated.status() });
  stage("communicator_login");
  await communicatorLogin(
    page,
    {
      commBase: communicator.baseUrl,
      platformOrigin: platformRuntime.proxyOrigin,
      platformDatabase: platformRuntime.database,
    },
    platformAccount.organizationId,
    "/conversations/conversation_composition_allowed?identity=identity_composition_human&channel=connection_composition_allowed",
  );
  stage("communicator_session_cookie");
  const session = await inspectCommunicatorSession(page, {
    commBase: communicator.baseUrl,
    bindingId: "binding_composition_human",
    tenantId: FIXTURE.tenantId,
    membershipId: FIXTURE.membershipId,
    identityId: FIXTURE.identityId,
  });
  assert.deepEqual(session, {
    status: 200,
    expectedBinding: true,
    expectedTenant: true,
    expectedMembership: true,
    expectedIdentity: true,
  });
  const cookies = await context.cookies(communicator.baseUrl);
  const accessCookie = cookies.find(
    (cookie) => cookie.name === "__Host-0000-access",
  );
  const metadata = cookieMetadata(accessCookie);
  assert.deepEqual(metadata, {
    present: true,
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    hostOnly: true,
  });
  record("communicator_callback_session", { ...session, cookie: metadata });
  if (phase === "oauth") {
    record("oauth_phase_complete", {
      protectedSessionStatus: session.status,
      expectedBinding: session.expectedBinding,
      expectedTenant: session.expectedTenant,
      expectedMembership: session.expectedMembership,
      expectedIdentity: session.expectedIdentity,
      cookieAttributesVerified: true,
    });
    await context.close();
    return;
  }

  stage("projection_initialize");
  const initializationStatus = await projectionCall(
    communicator.baseUrl,
    client.harnessToken,
    "initialize",
    projectionInitialization(),
  );
  assert.equal(initializationStatus, 200);
  const initialApplyStatus = await projectionCall(
    communicator.baseUrl,
    client.harnessToken,
    "apply",
    projectionBatch(initialProjectionEvents()),
  );
  assert.equal(initialApplyStatus, 200);
  stage("communicator_conversation_reload");
  await page.reload({ waitUntil: "networkidle" });
  stage("realtime_ticket");
  const { response: ticketResponse, body: ticket } = await issueRealtimeTicket(
    page,
    communicator.baseUrl,
    true,
  );
  assert.equal(ticketResponse.status(), 201);
  assert.equal(typeof ticket.websocket_url, "string");
  stage("realtime_observation");
  const realtime = await realtimeObservation(
    page,
    ticket,
    "__compositionRealtime",
    FIXTURE.identityId,
  );
  assert.deepEqual(
    {
      connected: realtime.connected,
      allowedChangeCount: realtime.allowedChangeCount,
      deniedChangeVisible: realtime.deniedChangeVisible,
      resetReason: realtime.resetReason,
      subprotocol: realtime.subprotocol,
    },
    {
      connected: true,
      allowedChangeCount: 1,
      deniedChangeVisible: false,
      resetReason: "history_unavailable",
      subprotocol: "communicator.realtime.v1",
    },
  );
  assert.equal(realtime.identityMatched, true);
  assert.ok(realtime.identityFrameCount >= 1);
  record("realtime_actual_platform_authority", {
    ticketStatus: ticketResponse.status(),
    connected: realtime.connected,
    authorizedDeliveryCount: realtime.allowedChangeCount,
    deniedAccountVisible: realtime.deniedChangeVisible,
    resetReason: realtime.resetReason,
    subprotocol: realtime.subprotocol,
  });

  stage("realtime_revocation_ticket");
  const { response: revocationTicketResponse, body: revocationTicket } =
    await issueRealtimeTicket(page, communicator.baseUrl, true);
  assert.equal(revocationTicketResponse.status(), 201);
  assert.equal(typeof revocationTicket.websocket_url, "string");
  const socketCountBeforeRevocationObservation = playwrightSocketStates.length;
  const revocationRealtime = await realtimeObservation(
    page,
    revocationTicket,
    "__compositionRevocationRealtime",
    FIXTURE.identityId,
  );
  assert.deepEqual(
    {
      connected: revocationRealtime.connected,
      allowedChangeCount: revocationRealtime.allowedChangeCount,
      deniedChangeVisible: revocationRealtime.deniedChangeVisible,
      resetReason: revocationRealtime.resetReason,
      subprotocol: revocationRealtime.subprotocol,
    },
    {
      connected: true,
      allowedChangeCount: 1,
      deniedChangeVisible: false,
      resetReason: "history_unavailable",
      subprotocol: "communicator.realtime.v1",
    },
  );
  assert.equal(revocationRealtime.identityMatched, true);
  assert.ok(revocationRealtime.identityFrameCount >= 1);
  const revocationSocketState = await page.evaluate(() => ({
    present: Boolean(window.__compositionRevocationRealtime),
    readyState: window.__compositionRevocationRealtime?.readyState ?? null,
  }));
  assert.equal(revocationSocketState.readyState, 1);
  record("realtime_revocation_socket_ready", {
    ticketStatus: revocationTicketResponse.status(),
    connected: revocationRealtime.connected,
    readyState: revocationSocketState.readyState,
  });
  const revocationSocketRecords = playwrightSocketStates.filter(
    (candidate) => candidate.url === revocationTicket.websocket_url,
  );
  assert.equal(revocationSocketRecords.length, 1);
  const [revocationSocketRecord] = revocationSocketRecords;
  assert.ok(revocationSocketRecord);
  assert.equal(
    playwrightSocketStates.length - socketCountBeforeRevocationObservation,
    1,
  );
  await waitFor(
    "realtime_revocation_socket_frame",
    () => revocationSocketRecord.projectionChangeCount >= 1,
    operationTimeoutMs,
  );
  const revocationMetricsBefore = await page.evaluate(() => {
    const metrics = window.__compositionRevocationRealtimeMetrics;
    return metrics
      ? {
          identityMatched: metrics.identityMatched,
          projectionChangeCount: metrics.projectionChangeCount,
          postRevocationDeliveryCount: metrics.postRevocationDeliveryCount,
        }
      : null;
  });
  assert.ok(revocationMetricsBefore);
  assert.equal(revocationMetricsBefore.identityMatched, true);

  stage("revocation_ui");
  let mutationCount = 0;
  page.on("request", (request) => {
    if (
      request.method() !== "GET" &&
      request.method() !== "HEAD" &&
      request.url().includes("/api/v1/") &&
      !request.url().includes("/api/v1/realtime/")
    )
      mutationCount += 1;
  });
  const draft401 = "draft survives actual Platform revocation";
  stage("revocation_draft_fill");
  const composerState = await page.evaluate(() => ({
    pathname: window.location.pathname,
    textareaCount: document.querySelectorAll("textarea").length,
    enabledTextareaCount: [...document.querySelectorAll("textarea")].filter(
      (element) => !element.disabled,
    ).length,
    composerFormCount: document.querySelectorAll(
      'form[aria-label="Send a message"]',
    ).length,
  }));
  record("communicator_composer_state", composerState);
  await page.locator("textarea").fill(draft401);
  const accountPage = await context.newPage();
  accountPage.setDefaultTimeout(operationTimeoutMs);
  stage("revocation_account_navigation");
  await accountPage.goto(`${platformRuntime.proxyOrigin}/account`, {
    waitUntil: "networkidle",
  });
  stage("revocation_installation_locator");
  const activeInstallation = accountPage
    .locator("li[data-oauth-installation-id]")
    .filter({
      has: accountPage.locator("button[data-revoke-oauth-installation]"),
    })
    .first();
  stage("revocation_installation_click");
  await activeInstallation
    .locator("button[data-revoke-oauth-installation]")
    .click();
  stage("revocation_account_reload");
  await accountPage.waitForLoadState("networkidle");
  await accountPage.close();
  stage("revocation_communicator_focus");
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const unauthStatus = page
    .locator("div[role=status]")
    .filter({
      hasText: "Sign in to read and change protected Communicator data.",
    })
    .first();
  stage("revocation_unauthorized_ui");
  await unauthStatus.waitFor({ state: "visible" });
  stage("revocation_draft_preserved");
  assert.equal(await page.locator("textarea").inputValue(), draft401);
  assert.equal(mutationCount, 0);
  stage("revocation_session_status");
  const revokedSession = await page.request.get(
    `${communicator.baseUrl}/api/v1/session`,
  );
  const { response: revokedTicketResponse } = await issueRealtimeTicket(
    page,
    communicator.baseUrl,
    false,
  );
  stage("revocation_ticket_status");
  assert.equal(revokedSession.status(), 401);
  assert.equal(revokedTicketResponse.status(), 401);
  stage("revocation_projection_apply");
  revocationSocketRecord.trackPostRevocation = true;
  await page.evaluate(() => {
    const metrics = window.__compositionRevocationRealtimeMetrics;
    if (!metrics) throw new Error("realtime_metrics_missing");
    metrics.trackPostRevocation = true;
  });
  const afterRevocationApply = await projectionCall(
    communicator.baseUrl,
    client.harnessToken,
    "apply",
    projectionBatch(postRevocationProjectionEvents()),
    true,
  );
  record("post_revocation_projection", {
    status: afterRevocationApply.status,
    applied: afterRevocationApply.status === 200,
    failureKind: afterRevocationApply.failureKind,
    failureCode: afterRevocationApply.failureCode,
  });
  assert.equal(afterRevocationApply.status, 200);
  stage("revocation_socket_close");
  const socketState = await page.evaluate(() => ({
    present: Boolean(window.__compositionRevocationRealtime),
    readyState: window.__compositionRevocationRealtime?.readyState ?? null,
    metrics: window.__compositionRevocationRealtimeMetrics
      ? {
          projectionChangeCount:
            window.__compositionRevocationRealtimeMetrics.projectionChangeCount,
          postRevocationDeliveryCount:
            window.__compositionRevocationRealtimeMetrics
              .postRevocationDeliveryCount,
        }
      : null,
  }));
  record("realtime_socket_state", {
    ...socketState,
    transportClosed: revocationSocketRecord.closed,
  });
  await waitFor(
    "realtime_revocation_transport_close",
    () => revocationSocketRecord.closed,
    operationTimeoutMs,
  );
  await waitFor(
    "realtime_revocation_browser_close",
    async () =>
      page.evaluate(
        () => window.__compositionRevocationRealtimeCloseSeen === true,
      ),
    operationTimeoutMs,
  );
  const socketStateAfterClose = await page.evaluate(() => ({
    present: Boolean(window.__compositionRevocationRealtime),
    readyState: window.__compositionRevocationRealtime?.readyState ?? null,
  }));
  const revocationCloseCode = await page.evaluate(
    () => window.__compositionRevocationRealtimeCloseCode ?? null,
  );
  const revocationCloseSeen = await page.evaluate(
    () => window.__compositionRevocationRealtimeCloseSeen === true,
  );
  const revocationMetricsAfter = await page.evaluate(() => {
    const metrics = window.__compositionRevocationRealtimeMetrics;
    return metrics
      ? {
          identityMatched: metrics.identityMatched,
          projectionChangeCount: metrics.projectionChangeCount,
          postRevocationDeliveryCount: metrics.postRevocationDeliveryCount,
        }
      : null;
  });
  assertCloseCode(
    { closeSeen: revocationCloseSeen, closeCode: revocationCloseCode },
    1008,
  );
  assert.ok(revocationMetricsAfter);
  assert.equal(revocationMetricsAfter.identityMatched, true);
  assert.equal(
    revocationMetricsAfter.projectionChangeCount,
    revocationMetricsBefore.projectionChangeCount,
  );
  assert.equal(revocationMetricsAfter.postRevocationDeliveryCount, 0);
  assert.equal(revocationSocketRecord.identityMatched, true);
  assert.equal(revocationSocketRecord.postRevocationProjectionChangeCount, 0);
  record("actual_platform_revocation", {
    uiUnauthorized: true,
    draftPreserved: true,
    mutationCount,
    protectedSessionStatus: revokedSession.status(),
    protectedTicketStatus: revokedTicketResponse.status(),
    realtimeTransportClosed: revocationSocketRecord.closed,
    realtimeCloseEventObserved: revocationCloseSeen,
    realtimeCloseCode: revocationCloseCode,
    realtimeBrowserReadyState: socketStateAfterClose.readyState,
    projectionChangeCountBeforeRevocation:
      revocationMetricsBefore.projectionChangeCount,
    projectionChangeCountAfterRevocation:
      revocationMetricsAfter.projectionChangeCount,
    postRevocationDeliveryCount:
      revocationMetricsAfter.postRevocationDeliveryCount,
  });

  stage("matching_reauth");
  const [reauthPage] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("button", { name: "Sign in in a new tab" }).click(),
  ]);
  await communicatorLogin(
    reauthPage,
    {
      commBase: communicator.baseUrl,
      platformOrigin: platformRuntime.proxyOrigin,
      platformDatabase: platformRuntime.database,
    },
    platformAccount.organizationId,
    "/conversations/conversation_composition_allowed?identity=identity_composition_human&channel=connection_composition_allowed",
  );
  const reauthSession = await inspectCommunicatorSession(reauthPage, {
    commBase: communicator.baseUrl,
    bindingId: "binding_composition_human",
    tenantId: FIXTURE.tenantId,
    membershipId: FIXTURE.membershipId,
    identityId: FIXTURE.identityId,
  });
  assert.deepEqual(reauthSession, {
    status: 200,
    expectedBinding: true,
    expectedTenant: true,
    expectedMembership: true,
    expectedIdentity: true,
  });
  await reauthPage.close();
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await unauthStatus.waitFor({ state: "detached" });
  assert.equal(await page.locator("textarea").inputValue(), draft401);
  record("matching_reauth", {
    sessionStatus: reauthSession.status,
    expectedBinding: reauthSession.expectedBinding,
    draftPreserved: true,
    messageMutationCount: mutationCount,
  });

  stage("platform_outage_recovery");
  const draft503 = "draft survives controlled Platform outage";
  await page.locator("textarea").fill(draft503);
  const outage = await postJson(
    `${platformRuntime.proxyOrigin}/__composition/outage`,
    {},
  );
  assert.equal(outage.response.status, 200);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const unavailableStatus = page
    .locator("div[role=status]")
    .filter({ hasText: "Platform is temporarily unavailable." })
    .first();
  await unavailableStatus.waitFor({ state: "visible" });
  assert.equal(await page.locator("textarea").inputValue(), draft503);
  assert.equal(mutationCount, 0);
  const outageSession = await page.request.get(
    `${communicator.baseUrl}/api/v1/session`,
  );
  assert.equal(outageSession.status(), 503);
  const recover = await postJson(
    `${platformRuntime.proxyOrigin}/__composition/recover`,
    {},
  );
  assert.equal(recover.response.status, 200);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await unavailableStatus.waitFor({ state: "detached" });
  const recoveredSession = await page.request.get(
    `${communicator.baseUrl}/api/v1/session`,
  );
  assert.equal(recoveredSession.status(), 200);
  assert.equal(await page.locator("textarea").inputValue(), draft503);
  record("platform_outage_recovery", {
    outageControlStatus: outage.response.status,
    unavailableSessionStatus: outageSession.status(),
    recoveredSessionStatus: recoveredSession.status(),
    draftPreserved: true,
    mutationCount,
  });

  stage("changed_platform_context");
  const changedDraft = "draft stays paused across changed context";
  await page.locator("textarea").fill(changedDraft);
  const changedPage = await context.newPage();
  await communicatorLogin(
    changedPage,
    {
      commBase: communicator.baseUrl,
      platformOrigin: platformRuntime.proxyOrigin,
      platformDatabase: platformRuntime.database,
    },
    alternate.organizationId,
    "/conversations/conversation_composition_allowed?identity=identity_composition_human&channel=connection_composition_allowed",
  );
  const changedSession = await inspectCommunicatorSession(changedPage, {
    commBase: communicator.baseUrl,
    bindingId: "binding_composition_alternate",
    tenantId: "tenant_composition_alternate",
    membershipId: "membership_composition_alternate",
    identityId: "identity_composition_alternate",
  });
  assert.deepEqual(changedSession, {
    status: 200,
    expectedBinding: true,
    expectedTenant: true,
    expectedMembership: true,
    expectedIdentity: true,
  });
  await changedPage.close();
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const changedStatus = page
    .locator("div[role=status]")
    .filter({
      hasText: "Your renewed login has a different organization or identity.",
    })
    .first();
  await changedStatus.waitFor({ state: "visible" });
  assert.equal(await page.locator("textarea").inputValue(), changedDraft);
  assert.equal(mutationCount, 0);
  await page.getByRole("button", { name: "Review and continue" }).click();
  await changedStatus.waitFor({ state: "detached" });
  record("changed_platform_context", {
    alternateSessionStatus: changedSession.status,
    expectedAlternateBinding: changedSession.expectedBinding,
    draftPreserved: true,
    messageMutationCount: mutationCount,
    reviewTransitioned: true,
  });

  stage("logout");
  await page.getByRole("button", { name: "Log out" }).first().click();
  await page
    .locator("div[role=status]")
    .filter({
      hasText: "Sign in to read and change protected Communicator data.",
    })
    .first()
    .waitFor({ state: "visible" });
  const afterLogoutCookies = (
    await context.cookies(communicator.baseUrl)
  ).filter((cookie) => cookie.name === "__Host-0000-access");
  assert.equal(afterLogoutCookies.length, 0);
  assert.equal(new URL(page.url()).origin, communicator.baseUrl);
  assert.equal(new URL(page.url()).pathname, "/");
  record("logout", {
    accessCookieCount: afterLogoutCookies.length,
    signInVisible: true,
    ambientLoginLoop: false,
  });
  record("browser_runtime", { pageErrors: browserErrors, failedRequests });
  await context.close();
}

let cleanupPromise = null;

async function cleanup() {
  state.shuttingDown = true;
  state.shutdownController.abort();
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    const cleanupResource = async (
      label,
      operation,
      timeoutMs = cleanupTimeoutMs,
    ) => {
      try {
        const result = await runBoundedCleanup(
          label,
          operation,
          timeoutMs,
        );
        return { ok: true, result };
      } catch {
        state.cleanupFailures.push(label);
        return { ok: false, result: null };
      }
    };

    for (const pending of [...state.pendingResources])
      await cleanupResource(
        "pending_resource",
        () => pending,
        processCleanupTimeoutMs,
      );

    if (state.browser)
      await cleanupResource("browser_close", () => state.browser.close());
    const children = new Set(
      [...state.activeChildren, state.communicator?.child].filter(Boolean),
    );
    const childResults = [];
    for (const child of children)
      childResults.push(
        await cleanupResource(
          "child_stop",
          () => stopProcess(child),
          processCleanupTimeoutMs,
        ),
      );
    if (state.communicator?.logFile)
      await cleanupResource("communicator_log_close", () =>
        state.communicator.logFile.close(),
      );
    if (state.platform)
      await cleanupResource("platform_dispose", () => state.platform.dispose());
    if (state.platformProxy)
      await cleanupResource("platform_proxy_close", () =>
        state.platformProxy.close(),
      );
    if (state.platformBridge)
      await cleanupResource("platform_bridge_close", () =>
        state.platformBridge.close(),
      );
    const stateCleanup = state.tempRoot
      ? await cleanupResource("temp_cleanup", () =>
          rm(state.tempRoot, { recursive: true, force: true }),
        )
      : { ok: true };
    return {
      ok: state.cleanupFailures.length === 0,
      childGroupsGone: childResults.every(
        ({ ok, result }) => ok && result?.groupGone !== false,
      ),
      stateRemoved: stateCleanup.ok,
      failures: [...state.cleanupFailures],
    };
  })();
  return cleanupPromise;
}

async function main() {
  assert.equal(typeof Bun, "object");
  stage("temp_state");
  state.tempRoot = await mkdtemp(
    join(tmpdir(), "platform-browser-composition-"),
  );
  const safeLogPath = join(
    tmpdir(),
    `platform-browser-composition-${process.pid}.jsonl`,
  );
  state.safeLogPath = safeLogPath;
  const sourceHashes = await hashSources([
    wrapperPath,
    join(harnessRoot, "fixture.mjs"),
    join(harnessRoot, "runner.mjs"),
    join(communicatorApp, "worker/index.ts"),
    join(communicatorApp, "worker/auth/browser-routes.ts"),
    join(communicatorApp, "worker/auth/middleware.ts"),
    join(communicatorApp, "worker/realtime/handlers.ts"),
    join(communicatorApp, "worker/projection/tenant-projection.ts"),
    workerEntry,
  ]);
  record("run", {
    command:
      "bun run services/platform/scripts/platform-browser-composition/runner.mjs",
    freshState: true,
    freePorts: true,
    provider: "simulated_github_only",
    sourceHashes,
  });
  stage("platform_runtime");
  const platform = await createPlatformRuntime(
    state.tempRoot,
    "http://127.0.0.1",
  );
  stage("communicator_port");
  const commPort = await allocateFreePort();
  const commBase = `http://localhost:${commPort}`;
  const harnessToken = opaqueSecret("composition_harness_");
  stage("oauth_client_provision");
  const client = await provisionTrustedOAuthClient(
    platform.database,
    platform.secret,
    {
      serviceId: service.serviceId,
      redirectUri: `${commBase}/auth/callback`,
      capabilities: service.allowedCapabilities,
      authMethod: "client_secret_post",
      purpose: "first_party_browser",
      clientId: "composition-browser-client",
      name: "Composition browser proof",
      refreshEnabled: false,
    },
  );
  assertActive();
  stage("communicator_runtime");
  const communicator = await createCommunicatorRuntime(
    state.tempRoot,
    {
      port: commPort,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      harnessToken,
    },
    platform,
  );
  state.communicator = communicator;
  record("startup", {
    platformBase: true,
    communicatorHealthStatus: 200,
    platformPortOwned: true,
    communicatorPortOwned: true,
    stateDirectoriesOwned: true,
    actualPlatformEntrypoint: true,
    actualCommunicatorEntrypoint: true,
  });
  stage("browser_composition");
  await runBrowserComposition(
    platform,
    communicator,
    { harnessToken, commBase, platformOrigin: platform.proxyOrigin },
    process.env.COMPOSITION_PHASE ?? "full",
  );
}

for (const [signal, exitCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.once(signal, () => {
    process.exitCode = exitCode;
    void cleanup().catch(() => {});
  });
}

try {
  await main();
} catch (error) {
  state.failed = true;
  state.failure = error;
  record("failure", { kind: safeFailure(error), stage: state.stage });
  if (process.exitCode === undefined || process.exitCode === 0)
    process.exitCode = 1;
} finally {
  let cleanupResult;
  try {
    cleanupResult = await cleanup();
  } catch {
    state.cleanupFailures.push("cleanup_unhandled");
    cleanupResult = {
      ok: false,
      childGroupsGone: false,
      stateRemoved: false,
      failures: [...state.cleanupFailures],
    };
  }
  if (cleanupResult.ok && state.cleanupFailures.length > 0) {
    cleanupResult = {
      ...cleanupResult,
      ok: false,
      failures: [...state.cleanupFailures],
    };
  }
  if (!cleanupResult.ok) {
    state.failed = true;
    record("cleanup_failure", {
      childGroupsGone: cleanupResult.childGroupsGone,
      stateRemoved: cleanupResult.stateRemoved,
      failureCount: cleanupResult.failures.length,
    });
    if (process.exitCode === undefined || process.exitCode === 0)
      process.exitCode = 1;
  } else {
    record("cleanup", {
      ok: true,
      childGroupsGone: cleanupResult.childGroupsGone,
      stateRemoved: cleanupResult.stateRemoved,
    });
    if (!state.failed) record("complete", { safeLogPath: state.safeLogPath });
  }
  if (state.safeLogPath)
    await writePrivate(state.safeLogPath, `${safeLog.join("\n")}\n`).catch(
      () => {},
    );
}
