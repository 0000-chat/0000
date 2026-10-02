import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createPlatformBrowserClient } from "@0000/platform-client";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { provisionTrustedOAuthClient } from "../src/oauth-installation.ts";
import { opaqueSecret } from "../src/platform-state.ts";
import { registerTestService } from "../worker/test/fixtures/provision.ts";
import { PLATFORM_TEST_MINIFLARE_RATE_LIMITS } from "./test-rate-limits.ts";
import {
  D1BrowserOAuthTransactionStore,
  handleBrowserFixtureRequest,
} from "../worker/test/fixtures/browser-oauth.ts";

const playwrightModule = process.env.T07_PLAYWRIGHT_MODULE;
if (!playwrightModule) {
  throw new Error(
    "Set T07_PLAYWRIGHT_MODULE to the installed @playwright/test module before running the first-party Chromium browser proof.",
  );
}
const { chromium } = await import(
  pathToFileURL(resolve(playwrightModule)).href
);

const platformRoot = fileURLToPath(new URL("../", import.meta.url));
const workerEntry = fileURLToPath(new URL("../src/worker.ts", import.meta.url));
const compatibilityDate = "2026-09-18";
const authority = "platform-t11-chromium-authority";
const service = {
  serviceId: "t11-chromium-browser-service",
  audience: "https://t11-chromium-browser.0000.test",
  verifier: opaqueSecret("t11_chromium_verify_"),
  guestGrantIssuer: opaqueSecret("t11_chromium_guest_grant_"),
  allowedCapabilities: ["resource:read"],
};
const providerIdentity = {
  id: 817111,
  login: "t11-chromium-user",
  name: "T11 Chromium User",
  email: "t11-chromium@example.test",
};
const operationTimeoutMs = 20_000;
const cleanupTimeoutMs = 5_000;

async function within(label, operation, timeoutMs = operationTimeoutMs) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function cleanupStep(label, action, state) {
  try {
    await within(label, Promise.resolve().then(action), cleanupTimeoutMs);
  } catch (error) {
    if (!state.failed) {
      state.failed = true;
      state.failure = error;
    }
  }
}

async function buildWorkerScript() {
  const result = await Bun.build({
    entrypoints: [workerEntry],
    external: ["cloudflare:workers"],
    format: "esm",
    naming: "worker.js",
    target: "browser",
  });
  if (!result.success) {
    throw new Error(
      `Worker bundle failed: ${result.logs.map((log) => log.message).join("\n")}`,
    );
  }
  const entry = result.outputs.find((output) => output.kind === "entry-point");
  if (!entry) throw new Error("Worker bundle entry point was not emitted");
  return entry.text();
}

async function applyMigrationDirectory(database, directory) {
  const migrations = await readD1Migrations(directory);
  for (const migration of migrations) {
    if (migration.queries.length === 0) continue;
    await within(
      "migration batch",
      database.batch(migration.queries.map((query) => database.prepare(query))),
    );
  }
}

async function applyMigrations(database) {
  await applyMigrationDirectory(database, join(platformRoot, "migrations"));
  await applyMigrationDirectory(
    database,
    join(platformRoot, "worker/test/fixtures/migrations"),
  );
}

function providerOutbound(request) {
  const url = new URL(request.url);
  if (
    url.hostname === "github.com" &&
    url.pathname === "/login/oauth/access_token"
  ) {
    return Response.json({
      access_token: "t11-chromium-provider-access",
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

function createRuntime(script, persistenceDirectory, baseUrl) {
  const options = convertV4MiniflareOptions({
    bindings: {
      BETTER_AUTH_SECRET:
        "t11-chromium-secret-with-at-least-32-characters-for-proof",
      GITHUB_CLIENT_ID: "t11-chromium-github-client",
      GITHUB_CLIENT_SECRET: "t11-chromium-github-secret",
      PLATFORM_AUTHORITY_ID: authority,
      PLATFORM_BASE_URL: baseUrl,
      PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS: "90",
      PLATFORM_SERVER_DEADLINE_MS: "8000",
      PLATFORM_RATE_LIMIT_POLICY: "",
      PLATFORM_DEPLOYMENT_MODE: "self-hosted",
      PLATFORM_SIGNUP_POLICY: "open",
    },
    compatibilityDate,
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { IDENTITY_DB: "platform-t11-chromium-identity" },
    ratelimits: PLATFORM_TEST_MINIFLARE_RATE_LIMITS,
    host: "127.0.0.1",
    modules: true,
    name: "platform-t11-chromium-runtime",
    outboundService: providerOutbound,
    resourcePersistencePath: persistenceDirectory,
    script,
  });
  return new Miniflare(options);
}

async function requestFromNode(request, fallbackHost) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) {
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  const host = String(request.headers.host ?? fallbackHost);
  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };
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
      name === "connection" ||
      name === "content-length" ||
      name === "keep-alive" ||
      name === "transfer-encoding" ||
      name === "set-cookie"
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

async function listenPlatformBridge() {
  let platform;
  const server = createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const csrfTarget = requestUrl.searchParams.get("target");
      if (requestUrl.pathname === "/test/csrf-attacker" && csrfTarget) {
        const body = `<!doctype html><html><body>
          <form method="POST" action="${escapeHtml(csrfTarget)}"></form>
          <script>document.forms[0].submit()</script>
        </body></html>`;
        await writeNodeResponse(
          new Response(body, {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
          response,
        );
        return;
      }
      if (!platform) {
        await writeNodeResponse(
          Response.json({ error: "platform unavailable" }, { status: 503 }),
          response,
        );
        return;
      }
      const webRequest = await requestFromNode(request, "127.0.0.1");
      await writeNodeResponse(
        await platform.dispatchFetch(webRequest),
        response,
      );
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
  await within(
    "Platform HTTP bridge listen",
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
    baseUrl: `http://127.0.0.1:${address.port}`,
    setPlatform(value) {
      platform = value;
    },
    async close() {
      await within(
        "Platform HTTP bridge close",
        new Promise((resolveClose, reject) => {
          server.close((error) => (error ? reject(error) : resolveClose()));
        }),
      );
    },
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function appPage(draft, resourceId) {
  const safeDraft = escapeHtml(draft);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Chromium browser fixture</title></head>
<body>
  <h1>First-party browser fixture</h1>
  <form id="work-form"><label>Draft <input id="work-input" name="draft" value="${safeDraft}"></label></form>
  <p id="status">Loading service access</p>
  <a id="login-link" href="/start?returnTo=${encodeURIComponent(`/app?draft=${draft}`)}">Sign in again</a>
  <script>
    const status = document.querySelector("#status");
    const login = document.querySelector("#login-link");
    login.hidden = true;
    async function loadResource() {
      try {
        const response = await fetch(${JSON.stringify(`/api/resource/${resourceId}`)}, { credentials: "include" });
        const body = await response.json().catch(() => ({}));
        if (response.status === 200) {
          status.textContent = "authenticated";
          login.hidden = true;
          return;
        }
        if (response.status === 401) {
          status.textContent = body.error === "invalid_credential" ? "session expired; sign in again" : "sign in required";
          login.hidden = false;
          return;
        }
        if (response.status === 503) {
          status.textContent = "service unavailable";
          login.hidden = true;
          return;
        }
        status.textContent = "service request failed";
        login.hidden = true;
      } catch {
        status.textContent = "service unavailable";
        login.hidden = true;
      }
    }
    window.reloadResource = loadResource;
    loadResource();
  </script>
</body></html>`;
}

function callbackFailurePage(returnTo, status, reason) {
  let draft = "";
  try {
    draft =
      new URL(returnTo ?? "/", "http://localhost").searchParams.get("draft") ??
      "";
  } catch {
    // The shared helper has already rejected unsafe return paths.
  }
  const safeReturnTo = returnTo ?? `/app?draft=${draft}`;
  return `<!doctype html><html><body>
    <h1>Sign in unavailable</h1>
    <p id="login-status">${escapeHtml(reason ?? status)}</p>
    <label>Draft <input id="work-input" value="${escapeHtml(draft)}"></label>
    <a id="login-link" href="/start?returnTo=${encodeURIComponent(safeReturnTo)}">Try sign in again</a>
  </body></html>`;
}

async function listenConsumerFixture({
  database,
  platformBaseUrl,
  clientRegistration,
  resourceId,
}) {
  const state = {
    outageMode: false,
    csrfDenied: false,
    browserCsrfDenied: false,
    lastCallbackStatus: null,
    lastCallbackExpiresAt: null,
    lastIssuedAccessToken: null,
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (!fixture) {
        await writeNodeResponse(
          Response.json({ error: "fixture unavailable" }, { status: 503 }),
          response,
        );
        return;
      }
      const webRequest = await requestFromNode(request, "localhost");
      await writeNodeResponse(await fixture(webRequest), response);
    })().catch(async (error) => {
      await writeNodeResponse(
        Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        ),
        response,
      );
    });
  });
  await within(
    "consumer fixture listen",
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
  const baseUrl = `http://localhost:${address.port}`;
  const transactionStore = new D1BrowserOAuthTransactionStore(database);
  const platformFetch = async (input, init) => {
    if (state.outageMode) {
      state.outageMode = false;
      throw new Error("controlled Platform outage");
    }
    const response = await globalThis.fetch(input, init);
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (url.pathname === "/api/auth/oauth2/token" && response.ok) {
      const body = await response
        .clone()
        .json()
        .catch(() => ({}));
      if (typeof body.access_token === "string") {
        state.lastIssuedAccessToken = body.access_token;
      }
    }
    return response;
  };
  let client = createPlatformBrowserClient({
    baseUrl: platformBaseUrl,
    authority,
    audience: service.audience,
    serviceVerifier: service.verifier,
    clientId: clientRegistration.clientId,
    clientSecret: clientRegistration.clientSecret,
    redirectUri: `${baseUrl}/oauth/callback`,
    resource: service.audience,
    scopes: service.allowedCapabilities,
    returnOrigin: baseUrl,
    transactionStore,
    fetch: platformFetch,
  });
  const resourceConfig = {
    database,
    platformBaseUrl,
    authority,
    audience: service.audience,
    serviceVerifier: service.verifier,
    guestGrantIssuer: service.guestGrantIssuer,
    fetch: platformFetch,
    serviceId: service.serviceId,
  };
  let fixture;
  fixture = async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/start" && request.method === "GET") {
      const started = await client.start({
        returnTo: url.searchParams.get("returnTo") ?? "/app",
      });
      if (started.status !== "started") {
        return Response.json({ status: started.status }, { status: 503 });
      }
      const headers = new Headers({ location: started.authorizationUrl });
      headers.append("set-cookie", started.setCookie);
      return new Response(null, { status: 302, headers });
    }
    if (url.pathname === "/oauth/callback" && request.method === "GET") {
      const result = await client.callback(request);
      state.lastCallbackStatus = result.status;
      state.lastCallbackExpiresAt =
        result.status === "authenticated" ? result.expiresAt : null;
      const headers = new Headers();
      if (result.clearBrowserBindingCookie) {
        headers.append("set-cookie", result.clearBrowserBindingCookie);
      }
      if (result.status === "authenticated") {
        headers.set("location", new URL(result.returnTo, baseUrl).toString());
        headers.append("set-cookie", result.setCookie);
        return new Response(null, { status: 302, headers });
      }
      return new Response(
        callbackFailurePage(result.returnTo, result.status, result.reason),
        {
          status: result.status === "authority_unavailable" ? 503 : 400,
          headers: {
            "content-type": "text/html; charset=utf-8",
            ...(headers.has("set-cookie")
              ? { "set-cookie": headers.get("set-cookie") }
              : {}),
          },
        },
      );
    }
    if (url.pathname.startsWith("/api/resource/") && request.method === "GET") {
      return handleBrowserFixtureRequest(request, resourceConfig);
    }
    if (url.pathname === "/logout" && request.method === "POST") {
      if (!client.isSameOriginUnsafeRequest(request)) {
        state.csrfDenied = true;
        if (request.headers.get("sec-fetch-site") === "cross-site") {
          state.browserCsrfDenied = true;
        }
        return Response.json({ error: "csrf_denied" }, { status: 403 });
      }
      return new Response(null, {
        status: 204,
        headers: { "set-cookie": client.clearCredentialCookie() },
      });
    }
    if (url.pathname === "/test/set-outage" && request.method === "POST") {
      state.outageMode = true;
      return Response.json({ status: "armed" });
    }
    if (url.pathname === "/test/status" && request.method === "GET") {
      return Response.json({
        csrfDenied: state.csrfDenied,
        lastCallbackStatus: state.lastCallbackStatus,
      });
    }
    if (url.pathname === "/app" && request.method === "GET") {
      return new Response(
        appPage(url.searchParams.get("draft") ?? "", resourceId),
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    if (url.pathname === "/favicon.ico")
      return new Response(null, { status: 204 });
    return Response.json({ error: "not_found" }, { status: 404 });
  };
  return {
    baseUrl,
    client,
    state,
    configure(nextRegistration) {
      client = createPlatformBrowserClient({
        baseUrl: platformBaseUrl,
        authority,
        audience: service.audience,
        serviceVerifier: service.verifier,
        clientId: nextRegistration.clientId,
        clientSecret: nextRegistration.clientSecret,
        redirectUri: `${baseUrl}/oauth/callback`,
        resource: service.audience,
        scopes: service.allowedCapabilities,
        returnOrigin: baseUrl,
        transactionStore,
        fetch: platformFetch,
      });
    },
    async close() {
      await within(
        "consumer fixture close",
        new Promise((resolveClose, reject) => {
          server.close((error) => (error ? reject(error) : resolveClose()));
        }),
      );
    },
  };
}

async function pageJson(page, expression, arg) {
  return within(
    "browser page evaluation",
    Promise.resolve().then(() =>
      page.evaluate(
        async ({ expression: source, arg: value }) => {
          const operation = new Function("arg", `return (${source})(arg);`);
          return await operation(value);
        },
        { expression, arg },
      ),
    ),
  );
}

async function signIn(page, platformBaseUrl) {
  await page.goto(`${platformBaseUrl}/login`, {
    waitUntil: "domcontentloaded",
  });
  const start = await pageJson(
    page,
    `async () => {
      const response = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "github",
          callbackURL: location.origin + "/account",
          disableRedirect: true,
        }),
      });
      return { status: response.status, body: await response.json() };
    }`,
    null,
  );
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const providerUrl = new URL(start.body.url);
  assert.equal(providerUrl.origin, "https://github.com");
  const state = providerUrl.searchParams.get("state");
  assert.ok(state);
  const callback = await page.goto(
    `${platformBaseUrl}/api/auth/callback/github?code=t11-chromium-callback&state=${encodeURIComponent(state)}`,
    { waitUntil: "domcontentloaded" },
  );
  await page.locator("h1").filter({ hasText: "Your account" }).waitFor();
  assert.ok(callback, "social callback produced a browser response");
  const session = await pageJson(
    page,
    `async () => {
      const response = await fetch("/api/auth/get-session");
      return { status: response.status, body: await response.json() };
    }`,
    null,
  );
  assert.equal(session.status, 200);
  assert.ok(session.body?.user?.id);
  const me = await pageJson(
    page,
    `async () => {
      const response = await fetch("/api/me");
      return { status: response.status, body: await response.json() };
    }`,
    null,
  );
  assert.equal(me.status, 200);
  assert.ok(me.body?.organizationId);
  return {
    userId: session.body.user.id,
    organizationId: me.body.organizationId,
  };
}

async function completeConsumerLogin(
  page,
  platformBaseUrl,
  consumer,
  organizationId,
  returnTo,
  outageAtCallback = false,
) {
  await page.goto(
    `${consumer.baseUrl}/start?returnTo=${encodeURIComponent(returnTo)}`,
    { waitUntil: "domcontentloaded" },
  );
  await page.locator("h1").filter({ hasText: "Choose access" }).waitFor();
  const selection = page.locator('form[action="/oauth2/selection"]');
  await selection
    .locator('select[name="organizationId"]')
    .selectOption(organizationId);
  await Promise.all([
    page.waitForURL(
      (url) => url.origin === platformBaseUrl && url.pathname === "/consent",
      { waitUntil: "domcontentloaded" },
    ),
    selection.getByRole("button", { name: "Continue to consent" }).click(),
  ]);
  await page.locator("h1").filter({ hasText: "Approve access" }).waitFor();
  const consent = page
    .locator('form[action="/api/auth/oauth2/consent"]')
    .first();
  if (outageAtCallback) {
    // The next Platform call is the SDK's callback token exchange. Arm the
    // local transport immediately before leaving the consent page so this
    // failure is classified by the real callback path.
    consumer.state.outageMode = true;
  }
  try {
    if (outageAtCallback) {
      await Promise.all([
        page.waitForURL(
          (url) =>
            url.origin === consumer.baseUrl &&
            url.pathname === "/oauth/callback",
          { waitUntil: "domcontentloaded" },
        ),
        consent.getByRole("button", { name: "Approve access" }).click(),
      ]);
      await page.locator("#login-status").waitFor();
      assert.equal(consumer.state.lastCallbackStatus, "authority_unavailable");
      assert.match(
        await page.locator("#login-status").textContent(),
        /authority_unavailable/,
      );
      assert.equal(
        await page.locator("#work-input").inputValue(),
        "outage-draft",
      );
      return;
    }
    await Promise.all([
      page.waitForURL(
        (url) => url.origin === consumer.baseUrl && url.pathname === "/app",
        { waitUntil: "domcontentloaded" },
      ),
      consent.getByRole("button", { name: "Approve access" }).click(),
    ]);
    await page.locator("#status").waitFor();
    assert.equal(consumer.state.lastCallbackStatus, "authenticated");
    assert.equal(await page.locator("#status").textContent(), "authenticated");
  } finally {
    // The outage switch is one-shot and is consumed by the callback transport.
  }
}

async function latestInstallation(database, clientId) {
  const row = await database
    .prepare(
      `SELECT i.id, a.expiresAt AS access_expires_at
       FROM platform_oauth_installation AS i
       JOIN oauthAccessToken AS a ON a.referenceId = i.id
       WHERE i.client_id = ?
       ORDER BY i.created_at DESC, i.id DESC, a.createdAt DESC
       LIMIT 1`,
    )
    .bind(clientId)
    .first();
  assert.ok(row?.id, "first-party installation persisted");
  return { id: row.id, accessExpiresAt: Number(row.access_expires_at) };
}

async function expireInstallation(database, installationId) {
  await database
    .prepare(
      `UPDATE oauthAccessToken
       SET expiresAt = ?
       WHERE referenceId = ? AND revoked IS NULL`,
    )
    .bind(Date.now() - 1, installationId)
    .run();
}

async function revokeInstallation(page, platformBaseUrl, installationId) {
  await page.goto(`${platformBaseUrl}/account`, {
    waitUntil: "domcontentloaded",
  });
  await page.locator("#oauth-installation-heading").waitFor();
  const row = page.locator(`[data-oauth-installation-id="${installationId}"]`);
  await row.waitFor();
  const revoke = row.locator("button[data-revoke-oauth-installation]");
  assert.equal(
    await revoke.count(),
    1,
    "active first-party revoke control rendered",
  );
  await revoke.click();
  await page.waitForFunction(
    (id) => {
      const target = document.querySelector(
        `[data-oauth-installation-id="${id}"]`,
      );
      return (
        target?.textContent?.toLowerCase().includes("revoked") === true &&
        target.querySelector("button[data-revoke-oauth-installation]") === null
      );
    },
    installationId,
    { timeout: operationTimeoutMs },
  );
}

async function assertNoCredentialSurfaces(
  context,
  page,
  consumerBaseUrl,
  secrets,
) {
  const cookies = await context.cookies(consumerBaseUrl);
  const credentialCookies = cookies.filter(
    (cookie) => cookie.name === "__Host-0000-access",
  );
  assert.equal(credentialCookies.length, 1, "fixture issued one access cookie");
  assert.equal(credentialCookies[0].httpOnly, true);
  assert.equal(credentialCookies[0].secure, true);
  assert.equal(credentialCookies[0].sameSite, "Lax");
  assert.equal(credentialCookies[0].domain.startsWith("."), false);
  const surfaces = await page.evaluate(() => ({
    url: location.href,
    html: document.documentElement.outerHTML,
    links: [...document.querySelectorAll("[href]")]
      .map((element) => element.href)
      .join("\n"),
    local: JSON.stringify(localStorage),
    session: JSON.stringify(sessionStorage),
  }));
  for (const secret of [...secrets, credentialCookies[0].value]) {
    assert.equal(typeof secret, "string");
    assert.ok(secret.length > 0);
    for (const surface of Object.values(surfaces)) {
      assert.equal(
        surface.includes(secret),
        false,
        "credential value absent from browser-visible surfaces",
      );
    }
  }
  for (const surface of Object.values(surfaces)) {
    for (const marker of [
      "access_token",
      "refresh_token",
      "client_secret",
      "Bearer ",
    ]) {
      assert.equal(
        surface.includes(marker),
        false,
        `credential marker ${marker} absent`,
      );
    }
  }
  assert.equal(new URL(page.url()).searchParams.has("access_token"), false);
  assert.equal(new URL(page.url()).searchParams.has("refresh_token"), false);
  return credentialCookies[0];
}

let platformPersistence;
let workerScript;
let platformBridge;
let consumer;
let platform;
let browser;
let failed = false;
let failure;

try {
  platformPersistence = await within(
    "browser persistence directory",
    mkdtemp(join(tmpdir(), "platform-t11-chromium-")),
  );
  workerScript = await within("worker build", buildWorkerScript());
  platformBridge = await listenPlatformBridge();
  platform = createRuntime(
    workerScript,
    platformPersistence,
    platformBridge.baseUrl,
  );
  platformBridge.setPlatform(platform);
  await within("browser runtime ready", platform.ready);
  const database = await within(
    "browser database open",
    platform.getD1Database("IDENTITY_DB"),
  );
  await applyMigrations(database);
  await registerTestService(database, service);

  const resourceId = `t11-chromium-resource-${crypto.randomUUID().slice(0, 8)}`;
  await database
    .prepare(
      `INSERT INTO fixture_resource (id, owner_kind, owner_id, created_at, audience)
       VALUES (?, 'organization', ?, ?, ?)`,
    )
    .bind(resourceId, "pending", Date.now(), service.audience)
    .run();

  consumer = await listenConsumerFixture({
    database,
    platformBaseUrl: platformBridge.baseUrl,
    clientRegistration: {
      clientId: "t11-chromium-first-party",
      clientSecret: "pending",
    },
    resourceId,
  });
  const clientRegistration = await provisionTrustedOAuthClient(
    database,
    "t11-chromium-secret-with-at-least-32-characters-for-proof",
    {
      serviceId: service.serviceId,
      clientId: "t11-chromium-first-party",
      redirectUri: `${consumer.baseUrl}/oauth/callback`,
      capabilities: service.allowedCapabilities,
      authMethod: "client_secret_post",
      purpose: "first_party_browser",
      name: "T11 Chromium First-party Browser",
    },
  );
  assert.equal(clientRegistration.clientSecret?.length > 16, true);

  // Configure the already-listening consumer with the trusted secret. The
  // redirect URI remains the exact port that was registered above.
  consumer.configure(clientRegistration);

  browser = await within(
    "Chromium launch",
    chromium.launch({ headless: true }),
  );
  const context = await within("Chromium context", browser.newContext());
  const page = await within("Chromium page", context.newPage());
  page.setDefaultTimeout(operationTimeoutMs);
  page.setDefaultNavigationTimeout(operationTimeoutMs);
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));

  const account = await signIn(page, platformBridge.baseUrl);
  await database
    .prepare("UPDATE fixture_resource SET owner_id = ? WHERE id = ?")
    .bind(account.organizationId, resourceId)
    .run();

  await completeConsumerLogin(
    page,
    platformBridge.baseUrl,
    consumer,
    account.organizationId,
    "/app?draft=logout-draft",
  );
  const firstInstallation = await latestInstallation(
    database,
    clientRegistration.clientId,
  );
  assert.equal(typeof consumer.state.lastIssuedAccessToken, "string");
  const firstCookie = await assertNoCredentialSurfaces(
    context,
    page,
    consumer.baseUrl,
    [clientRegistration.clientSecret, consumer.state.lastIssuedAccessToken],
  );
  assert.ok(firstCookie.expires > Math.floor(Date.now() / 1000));
  assert.ok(
    firstCookie.expires <= Math.floor(firstInstallation.accessExpiresAt / 1000),
    `browser cookie absolute expiry does not exceed Platform access expiry: cookie=${firstCookie.expires} access=${firstInstallation.accessExpiresAt} callback=${consumer.state.lastCallbackExpiresAt}`,
  );

  const invalidAuthorization = await pageJson(
    page,
    `async (resourceId) => {
      const response = await fetch("/api/resource/" + resourceId, {
        headers: { authorization: "Basic intentionally-invalid" },
      });
      return { status: response.status, body: await response.json() };
    }`,
    resourceId,
  );
  assert.deepEqual(invalidAuthorization, {
    status: 401,
    body: { error: "invalid_credential" },
  });

  const retainedDraft = `typed-browser-draft-${crypto.randomUUID()}`;
  await page.locator("#work-input").fill(retainedDraft);
  const appUrlBeforeFailures = page.url();
  consumer.state.outageMode = true;
  await page.evaluate(() => window.reloadResource());
  await page.waitForFunction(
    () =>
      document.querySelector("#status")?.textContent === "service unavailable",
  );
  assert.equal(await page.locator("#work-input").inputValue(), retainedDraft);
  assert.equal(page.url(), appUrlBeforeFailures);
  assert.equal(await page.locator("#login-link").isHidden(), true);
  await page.evaluate(() => window.reloadResource());
  await page.waitForFunction(
    () => document.querySelector("#status")?.textContent === "authenticated",
  );
  assert.equal(await page.locator("#work-input").inputValue(), retainedDraft);
  assert.equal(page.url(), appUrlBeforeFailures);
  assert.equal(await page.locator("#login-link").isHidden(), true);

  const attackerUrl = new URL("/test/csrf-attacker", platformBridge.baseUrl);
  attackerUrl.searchParams.set("target", `${consumer.baseUrl}/logout`);
  await page.goto(attackerUrl.toString(), { waitUntil: "domcontentloaded" });
  assert.equal(
    consumer.state.csrfDenied,
    true,
    "cross-origin unsafe logout was denied",
  );
  assert.equal(
    consumer.state.browserCsrfDenied,
    true,
    "Chromium cross-origin form reached the fixture CSRF guard",
  );
  assert.equal(
    (await context.cookies(consumer.baseUrl)).some(
      (cookie) => cookie.name === "__Host-0000-access",
    ),
    true,
    "CSRF denial retained the service cookie",
  );

  await page.goto(`${consumer.baseUrl}/app?draft=logout-draft`, {
    waitUntil: "domcontentloaded",
  });
  const logoutStatus = await pageJson(
    page,
    `async () => {
      const response = await fetch("/logout", { method: "POST" });
      return response.status;
    }`,
    null,
  );
  assert.equal(logoutStatus, 204);
  assert.equal(
    (await context.cookies(consumer.baseUrl)).some(
      (cookie) => cookie.name === "__Host-0000-access",
    ),
    false,
    "local logout clears only the service credential cookie",
  );
  await page.goto(`${consumer.baseUrl}/app?draft=logout-draft`, {
    waitUntil: "domcontentloaded",
  });
  await page.locator("#status").waitFor();
  assert.match(
    await page.locator("#status").textContent(),
    /sign in|required|expired/,
  );
  assert.equal(await page.locator("#work-input").inputValue(), "logout-draft");
  await page.goto(`${platformBridge.baseUrl}/account`, {
    waitUntil: "domcontentloaded",
  });
  await page.locator("h1").filter({ hasText: "Your account" }).waitFor();

  await completeConsumerLogin(
    page,
    platformBridge.baseUrl,
    consumer,
    account.organizationId,
    "/app?draft=expired-draft",
  );
  const expiredInstallation = await latestInstallation(
    database,
    clientRegistration.clientId,
  );
  const expiredDraft = `typed-expired-draft-${crypto.randomUUID()}`;
  await page.locator("#work-input").fill(expiredDraft);
  const expiredAppUrl = page.url();
  await expireInstallation(database, expiredInstallation.id);
  await page.evaluate(() => window.reloadResource());
  await page.waitForFunction(
    () =>
      document.querySelector("#status")?.textContent ===
      "session expired; sign in again",
  );
  assert.equal(await page.locator("#work-input").inputValue(), expiredDraft);
  assert.equal(page.url(), expiredAppUrl);
  assert.equal(await page.locator("#login-link").isHidden(), false);

  await completeConsumerLogin(
    page,
    platformBridge.baseUrl,
    consumer,
    account.organizationId,
    "/app?draft=revoked-draft",
  );
  const revokedInstallation = await latestInstallation(
    database,
    clientRegistration.clientId,
  );
  const revokedDraft = `typed-revoked-draft-${crypto.randomUUID()}`;
  await page.locator("#work-input").fill(revokedDraft);
  const revokedAppUrl = page.url();
  const controlPage = await context.newPage();
  controlPage.setDefaultTimeout(operationTimeoutMs);
  controlPage.setDefaultNavigationTimeout(operationTimeoutMs);
  await revokeInstallation(
    controlPage,
    platformBridge.baseUrl,
    revokedInstallation.id,
  );
  await controlPage.close();
  await page.evaluate(() => window.reloadResource());
  await page.waitForFunction(
    () =>
      document.querySelector("#status")?.textContent ===
      "session expired; sign in again",
  );
  assert.equal(await page.locator("#work-input").inputValue(), revokedDraft);
  assert.equal(page.url(), revokedAppUrl);
  assert.equal(await page.locator("#login-link").isHidden(), false);

  await completeConsumerLogin(
    page,
    platformBridge.baseUrl,
    consumer,
    account.organizationId,
    "/app?draft=outage-draft",
    true,
  );
  const callbackSurfaces = await page.evaluate(() => ({
    url: location.href,
    html: document.documentElement.outerHTML,
    links: [...document.querySelectorAll("[href]")]
      .map((element) => element.href)
      .join("\n"),
    local: JSON.stringify(localStorage),
    session: JSON.stringify(sessionStorage),
  }));
  for (const secret of [
    clientRegistration.clientSecret,
    consumer.state.lastIssuedAccessToken,
  ]) {
    assert.equal(typeof secret, "string");
    assert.ok(secret.length > 0);
    for (const surface of Object.values(callbackSurfaces)) {
      assert.equal(
        surface.includes(secret),
        false,
        "credential value absent from callback browser-visible surfaces",
      );
    }
  }
  for (const surface of Object.values(callbackSurfaces)) {
    assert.equal(surface.includes("access_token"), false);
    assert.equal(surface.includes("refresh_token"), false);
  }
  assert.equal(browserErrors.length, 0, browserErrors.join("\n"));

  console.log(
    JSON.stringify({
      experiment: "first-party-browser-chromium",
      browser:
        "Chromium through Playwright and separate local HTTP consumer fixture",
      provider:
        "mocked GitHub outbound only; Platform account/OAuth and consumer callback were real",
      flow: {
        account: "real browser session and selected organization",
        purpose:
          "trusted first_party_browser client_secret_post with PKCE and consent",
        fixture: "shared SDK callback plus atomic D1 transaction adapter",
        api: "HttpOnly cookie authenticates fixture resource",
      },
      protections: {
        cookie:
          "host-only Secure HttpOnly SameSite=Lax with absolute expiry bounded by Platform access",
        surfaces:
          "actual issued access/cookie values and client secret absent from DOM, localStorage, sessionStorage or URL",
        authorizationPrecedence:
          "invalid explicit Authorization denied over a valid cookie",
        csrf: "cross-origin unsafe logout denied; same-origin logout clears service cookie",
        invalidation: ["expired access", "installation revoke"],
        draft:
          "typed mounted input retained across in-place authenticated 401 and 503; 503 keeps sign-in hidden",
        outage:
          "callback classified authority_unavailable and preserved return draft",
      },
      pageErrors: 0,
    }),
  );
} catch (error) {
  failed = true;
  failure = error;
} finally {
  const cleanupState = { failed, failure };
  if (browser)
    await cleanupStep("Chromium close", () => browser.close(), cleanupState);
  if (consumer)
    await cleanupStep(
      "consumer fixture close",
      () => consumer.close(),
      cleanupState,
    );
  if (platform)
    await cleanupStep(
      "browser runtime dispose",
      () => platform.dispose(),
      cleanupState,
    );
  if (platformBridge)
    await cleanupStep(
      "Platform bridge close",
      () => platformBridge.close(),
      cleanupState,
    );
  if (platformPersistence) {
    await cleanupStep(
      "browser persistence cleanup",
      () => rm(platformPersistence, { force: true, recursive: true }),
      cleanupState,
    );
  }
  failed = cleanupState.failed;
  failure = cleanupState.failure;
}

if (failed) throw failure;
