import assert from "node:assert/strict";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../../../../");
const platformRoot = join(repositoryRoot, "services/platform");
const platformWorkerEntry = join(platformRoot, "src/worker.ts");
const { convertV4MiniflareOptions, Miniflare } = await import(
  pathToFileURL(join(platformRoot, "node_modules/miniflare/dist/src/index.js"))
    .href
);
const { readD1Migrations } = await import(
  pathToFileURL(
    join(
      platformRoot,
      "node_modules/@cloudflare/vitest-plugin/dist/pool/index.mjs",
    ),
  ).href
);
const { provisionTrustedOAuthClient } = await import(
  pathToFileURL(join(platformRoot, "src/oauth-installation.ts")).href
);
const { opaqueSecret } = await import(
  pathToFileURL(join(platformRoot, "src/platform-state.ts")).href
);
const { registerTestService } = await import(
  pathToFileURL(join(platformRoot, "worker/test/fixtures/provision.ts")).href
);
const { PLATFORM_TEST_MINIFLARE_RATE_LIMITS } = await import(
  pathToFileURL(join(platformRoot, "scripts/test-rate-limits.ts")).href
);
const authority = "platform-t11-communicator-rust-authority";
const service = {
  serviceId: "t11-communicator-rust-service",
  audience: "https://t11-communicator-rust.0000.test",
  verifier: opaqueSecret("t11_communicator_rust_verify_"),
  guestGrantIssuer: opaqueSecret("t11_communicator_rust_guest_"),
  allowedCapabilities: [
    "conversation.read",
    "message.send",
    "connection.read",
    "ingestion.write",
    "outbound.claim",
    "directory.read",
    "directory.manage",
  ],
};
const providerIdentity = {
  id: 817112,
  login: "t11-communicator-rust-browser-user",
  name: "T11 Communicator Rust Browser User",
  email: "t11-communicator-rust-browser@example.test",
};
const platformPort = Number(process.env.T11_PLATFORM_PORT ?? "0");
const communicatorPort = Number(process.env.T11_COMMUNICATOR_PORT ?? "18798");
const infoPath =
  process.env.T11_PLATFORM_INFO_PATH ??
  "/tmp/platform-t11-rust-composition.json";
const persistenceDirectory =
  process.env.T11_PLATFORM_STATE_PATH ??
  (await mkdtemp(join(tmpdir(), "platform-t11-rust-composition-")));

if (
  !Number.isInteger(platformPort) ||
  platformPort < 0 ||
  platformPort > 65535
) {
  throw new Error("T11_PLATFORM_PORT must be an integer between 0 and 65535");
}
if (
  !Number.isInteger(communicatorPort) ||
  communicatorPort < 1 ||
  communicatorPort > 65535
) {
  throw new Error(
    "T11_COMMUNICATOR_PORT must be an integer between 1 and 65535",
  );
}

await mkdir(persistenceDirectory, { recursive: true });

async function buildWorkerScript() {
  const result = await Bun.build({
    entrypoints: [platformWorkerEntry],
    external: ["cloudflare:workers"],
    format: "esm",
    naming: "worker.js",
    target: "browser",
  });
  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join("\n"));
  }
  const entry = result.outputs.find((output) => output.kind === "entry-point");
  assert.ok(entry);
  return entry.text();
}

function providerOutbound(request) {
  const url = new URL(request.url);
  if (
    url.hostname === "github.com" &&
    url.pathname === "/login/oauth/access_token"
  ) {
    return Response.json({
      access_token: "t11-communicator-rust-provider-access",
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
  throw new Error(`Unexpected provider request: ${url.origin}${url.pathname}`);
}

function createRuntime(script, baseUrl) {
  return new Miniflare(
    convertV4MiniflareOptions({
      bindings: {
        BETTER_AUTH_SECRET:
          "t11-communicator-rust-platform-secret-with-at-least-32-characters",
        GITHUB_CLIENT_ID: "t11-communicator-rust-github-client",
        GITHUB_CLIENT_SECRET: "t11-communicator-rust-github-secret",
        PLATFORM_AUTHORITY_ID: authority,
        PLATFORM_BASE_URL: baseUrl,
        PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS: "90",
        PLATFORM_SERVER_DEADLINE_MS: "8000",
        PLATFORM_RATE_LIMIT_POLICY: "",
        PLATFORM_DEPLOYMENT_MODE: "self-hosted",
        PLATFORM_SIGNUP_POLICY: "open",
      },
      compatibilityDate: "2026-09-18",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { IDENTITY_DB: "platform-t11-rust-composition-identity" },
      ratelimits: PLATFORM_TEST_MINIFLARE_RATE_LIMITS,
      host: "127.0.0.1",
      modules: true,
      name: "platform-t11-rust-composition",
      outboundService: providerOutbound,
      resourcePersistencePath: persistenceDirectory,
      script,
    }),
  );
}

async function requestFromNode(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) {
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  const host = String(request.headers.host ?? "127.0.0.1");
  const init = { method: request.method, headers, redirect: "manual" };
  if (
    chunks.length > 0 &&
    request.method !== "GET" &&
    request.method !== "HEAD"
  ) {
    init.body = Buffer.concat(chunks);
  }
  return new Request(`http://${host}${request.url ?? "/"}`, init);
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
    ) {
      continue;
    }
    outputHeaders[name] = value;
  }
  const setCookies =
    response.headers.getSetCookie?.() ??
    [response.headers.get("set-cookie") ?? ""].filter(Boolean);
  if (setCookies.length > 0) outputHeaders["set-cookie"] = setCookies;
  const body = Buffer.from(await response.arrayBuffer());
  outputHeaders["content-length"] = String(body.byteLength);
  nodeResponse.writeHead(response.status, outputHeaders);
  nodeResponse.end(body);
}

let platform;
const bridge = createServer((request, response) => {
  void (async () => {
    if (!platform) {
      await writeNodeResponse(
        Response.json({ error: "platform unavailable" }, { status: 503 }),
        response,
      );
      return;
    }
    const webRequest = await requestFromNode(request);
    await writeNodeResponse(await platform.dispatchFetch(webRequest), response);
  })().catch(async (error) => {
    await writeNodeResponse(
      Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 503 },
      ),
      response,
    );
  });
});

await new Promise((resolveListen, reject) => {
  bridge.once("error", reject);
  bridge.listen(platformPort, "127.0.0.1", () => {
    bridge.off("error", reject);
    resolveListen();
  });
});
const address = bridge.address();
assert.ok(address && typeof address !== "string");
const baseUrl = `http://127.0.0.1:${address.port}`;
platform = createRuntime(await buildWorkerScript(), baseUrl);
await platform.ready;

const database = await platform.getD1Database("IDENTITY_DB");
const migrations = await readD1Migrations(join(platformRoot, "migrations"));
for (const migration of migrations) {
  if (migration.queries.length > 0) {
    await database.batch(
      migration.queries.map((query) => database.prepare(query)),
    );
  }
}
await registerTestService(database, service);
const client = await provisionTrustedOAuthClient(
  database,
  "t11-communicator-rust-platform-secret-with-at-least-32-characters",
  {
    serviceId: service.serviceId,
    clientId: "t11-communicator-rust-client",
    redirectUri: `http://localhost:${communicatorPort}/auth/callback`,
    capabilities: service.allowedCapabilities,
    authMethod: "client_secret_post",
    purpose: "first_party_browser",
    name: "T11 Communicator Rust composition client",
  },
);
await writeFile(
  infoPath,
  JSON.stringify(
    {
      baseUrl,
      authority,
      service,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: `http://localhost:${communicatorPort}/auth/callback`,
      persistenceDirectory,
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    ready: true,
    baseUrl,
    authority,
    serviceId: service.serviceId,
    audience: service.audience,
    infoPath,
  }),
);

const keepAlive = setInterval(() => {}, 60_000);
const shutdown = async () => {
  clearInterval(keepAlive);
  bridge.close();
  await platform.dispose();
};
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
