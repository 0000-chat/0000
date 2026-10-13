import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createPlatformClient } from "@0000/platform-client";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import {
  oauthProviderTokenHash,
  provisionTrustedOAuthClient,
} from "../src/oauth-installation.ts";
import { opaqueSecret } from "../src/platform-state.ts";
import { registerTestService } from "../worker/test/fixtures/provision.ts";
import { PLATFORM_TEST_MINIFLARE_RATE_LIMITS } from "./test-rate-limits.ts";

const playwrightModule = process.env.T07_PLAYWRIGHT_MODULE;
if (!playwrightModule) {
  throw new Error(
    "Set T07_PLAYWRIGHT_MODULE to the installed @playwright/test module before running the optional T07 browser acceptance probe.",
  );
}
const { chromium } = await import(
  pathToFileURL(resolve(playwrightModule)).href
);

const platformRoot = fileURLToPath(new URL("../", import.meta.url));
const workerEntry = fileURLToPath(new URL("../src/worker.ts", import.meta.url));
const compatibilityDate = "2026-09-18";
const authority = "platform-t07-browser-authority";
const service = {
  serviceId: "t07-browser-service",
  audience: "https://t07-browser.0000.test",
  verifier: opaqueSecret("t07_browser_verify_"),
  guestGrantIssuer: opaqueSecret("t07_browser_guest_grant_"),
  allowedCapabilities: ["resource:read"],
};
const providerIdentity = {
  id: 817072,
  login: "t07-browser-user",
  name: "T07 Browser User",
  email: "t07-browser@example.test",
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

async function applyMigrations(database) {
  const migrations = await readD1Migrations(join(platformRoot, "migrations"));
  for (const migration of migrations) {
    if (migration.queries.length === 0) continue;
    await within(
      "migration batch",
      database.batch(migration.queries.map((query) => database.prepare(query))),
    );
  }
}

function providerOutbound(request) {
  const url = new URL(request.url);
  if (
    url.hostname === "github.com" &&
    url.pathname === "/login/oauth/access_token"
  ) {
    return Response.json({
      access_token: "t07-browser-provider-access",
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
        "t07-browser-secret-with-at-least-32-characters-for-probe",
      GITHUB_CLIENT_ID: "t07-browser-github-client",
      GITHUB_CLIENT_SECRET: "t07-browser-github-secret",
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
    d1Databases: { IDENTITY_DB: "platform-t07-browser-identity" },
    ratelimits: PLATFORM_TEST_MINIFLARE_RATE_LIMITS,
    host: "127.0.0.1",
    modules: true,
    name: "platform-t07-browser-runtime",
    outboundService: providerOutbound,
    resourcePersistencePath: persistenceDirectory,
    script,
  });
  return new Miniflare(options);
}

async function listenBridge() {
  let platform;
  const server = createServer((request, response) => {
    void (async () => {
      if (!platform) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "platform unavailable" }));
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) {
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
      }
      const host = String(request.headers.host ?? "127.0.0.1");
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
      const result = await platform.dispatchFetch(
        new Request(`http://${host}${request.url ?? "/"}`, init),
      );
      const outputHeaders = {};
      for (const [name, value] of result.headers) {
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
        result.headers.getSetCookie?.() ??
        [result.headers.get("set-cookie") ?? ""].filter(Boolean);
      if (setCookies.length > 0) outputHeaders["set-cookie"] = setCookies;
      const body = Buffer.from(await result.arrayBuffer());
      outputHeaders["content-length"] = String(body.byteLength);
      response.writeHead(result.status, outputHeaders);
      response.end(body);
    })().catch((error) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  });
  await within(
    "HTTP bridge listen",
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
    baseUrl: `http://localhost:${address.port}`,
    setPlatform(value) {
      platform = value;
    },
    async close() {
      await within(
        "HTTP bridge close",
        new Promise((resolveClose, reject) => {
          server.close((error) => (error ? reject(error) : resolveClose()));
        }),
      );
    },
  };
}

async function expectStatus(response, expected, label) {
  const body =
    expected === response.status ? "" : `: ${await response.clone().text()}`;
  assert.equal(response.status, expected, `${label} status${body}`);
}

async function pageJson(page, expression, arg) {
  return within(
    "browser page evaluation",
    Promise.resolve().then(() =>
      page.evaluate(
        async ({ expression, arg }) => {
          const operation = new Function("arg", `return (${expression})(arg);`);
          return await operation(arg);
        },
        { expression, arg },
      ),
    ),
  );
}

async function browserSignIn(page, baseUrl) {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  assert.match(await page.locator("h1").textContent(), /Sign in/);
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
  assert.ok(state, "synthetic browser provider state returned");
  let callbackRequestCookie = "";
  const callbackRequestListener = (request) => {
    if (request.url().includes("/api/auth/callback/github")) {
      callbackRequestCookie = request.headers().cookie ?? "";
    }
  };
  page.on("request", callbackRequestListener);
  const callbackResponse = await page.goto(
    `${baseUrl}/api/auth/callback/github?code=t07-browser-callback&state=${encodeURIComponent(state)}`,
    { waitUntil: "domcontentloaded" },
  );
  try {
    await page.locator("h1").filter({ hasText: "Your account" }).waitFor();
  } catch (error) {
    const bodyText = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    const cookieNames = (await page.context().cookies()).map(
      (cookie) => cookie.name,
    );
    throw new Error(
      `synthetic browser callback did not establish account: callbackStatus=${callbackResponse?.status()} requestCookie=${callbackRequestCookie ? "present" : "missing"} url=${page.url()} cookies=${cookieNames.join(",")} body=${bodyText.slice(0, 500)} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  page.off("request", callbackRequestListener);
  const session = await pageJson(
    page,
    `async () => {
      const response = await fetch("/api/auth/get-session");
      return { status: response.status, body: await response.json() };
    }`,
    null,
  );
  assert.equal(session.status, 200);
  assert.ok(session.body?.user?.id, "browser session cookie is active");
  const me = await pageJson(
    page,
    `async () => {
      const response = await fetch("/api/me");
      return { status: response.status, body: await response.json() };
    }`,
    null,
  );
  assert.equal(me.status, 200);
  assert.ok(
    me.body?.organizationId,
    "browser organization authority is active",
  );
  return {
    userId: session.body.user.id,
    organizationId: me.body.organizationId,
  };
}

async function browserBeginOAuth(page, baseUrl, input) {
  const verifier = opaqueSecret("t07_browser_pkce_");
  const challenge = await challengeFor(verifier);
  const state = crypto.randomUUID();
  const query = new URLSearchParams({
    client_id: input.client.clientId,
    response_type: "code",
    redirect_uri: input.client.redirectUri,
    scope: "resource:read offline_access",
    resource: service.audience,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  await page.goto(`${baseUrl}/api/auth/oauth2/authorize?${query}`, {
    waitUntil: "domcontentloaded",
  });
  await page.locator("h1").filter({ hasText: "Choose access" }).waitFor();
  const flowId = await page
    .locator('form[action="/oauth2/selection"] input[name="flowId"]')
    .inputValue();
  assert.ok(flowId, "browser OAuth flow id rendered in selection form");
  return { flowId, state, verifier };
}

async function browserCompleteOAuth(page, input) {
  const selection = page.locator('form[action="/oauth2/selection"]');
  await selection
    .locator('select[name="organizationId"]')
    .selectOption(input.organizationId);
  await Promise.all([
    page.waitForURL(
      (url) => url.pathname === "/consent" && url.search.length > 1,
      { waitUntil: "domcontentloaded" },
    ),
    selection.getByRole("button", { name: "Continue to consent" }).click(),
  ]);
  await page.locator("h1").filter({ hasText: "Approve access" }).waitFor();
  const consent = page
    .locator('form[action="/api/auth/oauth2/consent"]')
    .first();
  await Promise.all([
    page.waitForURL(
      (url) =>
        url.pathname === "/oauth-callback" && url.searchParams.has("code"),
      { waitUntil: "domcontentloaded" },
    ),
    consent.getByRole("button", { name: "Approve access" }).click(),
  ]);
  const callback = new URL(page.url());
  const code = callback.searchParams.get("code");
  assert.ok(code, "browser consent returned authorization code");
  await page.goto(input.baseUrl + "/account", {
    waitUntil: "domcontentloaded",
  });
  const token = await pageJson(
    page,
    `async (input) => {
      const response = await fetch("/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: input.clientId,
          redirect_uri: input.redirectUri,
          code: input.code,
          code_verifier: input.verifier,
          resource: input.audience,
        }),
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    }`,
    {
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      code,
      verifier: input.verifier,
      audience: service.audience,
    },
  );
  return token;
}

async function challengeFor(value) {
  return base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function browserRefresh(page, input) {
  return pageJson(
    page,
    `async (input) => {
      const response = await fetch("/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: input.clientId,
          refresh_token: input.refreshToken,
          resource: input.audience,
        }),
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    }`,
    input,
  );
}

async function installationId(database, accessToken) {
  const tokenHash = await oauthProviderTokenHash(accessToken);
  const row = await within(
    "browser installation lookup",
    database
      .prepare(
        "SELECT referenceId AS installation_id FROM oauthAccessToken WHERE token = ? LIMIT 1",
      )
      .bind(tokenHash)
      .first(),
  );
  assert.ok(row?.installation_id, "browser token maps to installation");
  return row.installation_id;
}

function sharedClient(fetch, baseUrl) {
  return createPlatformClient({
    baseUrl,
    authority,
    audience: service.audience,
    serviceVerifier: service.verifier,
    fetch,
  });
}

async function accountInstallationJson(page, organizationId) {
  return pageJson(
    page,
    `async (organizationId) => {
      const response = await fetch("/api/account/oauth-installations?organizationId=" + encodeURIComponent(organizationId));
      return { status: response.status, body: await response.json() };
    }`,
    organizationId,
  );
}

let platformPersistence;
let workerScript;
let bridge;
let platform;
let browser;
let failed = false;
let failure;

try {
  platformPersistence = await within(
    "browser persistence directory",
    mkdtemp(join(tmpdir(), "platform-t07-browser-")),
  );
  workerScript = await within("worker build", buildWorkerScript());
  bridge = await listenBridge();
  platform = createRuntime(workerScript, platformPersistence, bridge.baseUrl);
  bridge.setPlatform(platform);
  await within("browser runtime ready", platform.ready);
  const database = await within(
    "browser database open",
    platform.getD1Database("IDENTITY_DB"),
  );
  await applyMigrations(database);
  await registerTestService(database, service);

  browser = await within(
    "Chromium launch",
    chromium.launch({ headless: true }),
  );
  const browserContext = await within("Chromium context", browser.newContext());
  const page = await within("Chromium page", browserContext.newPage());
  page.setDefaultTimeout(operationTimeoutMs);
  page.setDefaultNavigationTimeout(operationTimeoutMs);
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.route("**/favicon.ico", (route) =>
    route.fulfill({ status: 204, body: "" }),
  );

  const account = await browserSignIn(page, bridge.baseUrl);
  const client = await provisionTrustedOAuthClient(
    database,
    "t07-browser-secret-with-at-least-32-characters-for-probe",
    {
      serviceId: service.serviceId,
      clientId: "t07-browser-client",
      redirectUri: `${bridge.baseUrl}/oauth-callback`,
      capabilities: service.allowedCapabilities,
      authMethod: "none",
      name: "T07 Browser Harness",
      refreshEnabled: true,
    },
  );
  assert.equal(
    client.clientSecret,
    null,
    "browser public client has no secret",
  );

  const installations = [];
  for (const label of ["first", "sibling"]) {
    const begin = await browserBeginOAuth(page, bridge.baseUrl, { client });
    const completed = await browserCompleteOAuth(page, {
      flowId: begin.flowId,
      organizationId: account.organizationId,
      verifier: begin.verifier,
      clientId: client.clientId,
      redirectUri: client.redirectUri,
      audience: service.audience,
      baseUrl: bridge.baseUrl,
    });
    assert.equal(completed.status, 200, `${label} browser token exchange`);
    assert.match(completed.body.access_token, /^.{16,}$/);
    assert.match(completed.body.refresh_token, /^.{16,}$/);
    const installation = {
      label,
      accessToken: completed.body.access_token,
      refreshToken: completed.body.refresh_token,
      installationId: await installationId(
        database,
        completed.body.access_token,
      ),
    };
    installations.push(installation);
  }

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#oauth-installation-heading").waitFor();

  const listing = await accountInstallationJson(page, account.organizationId);
  assert.equal(listing.status, 200, "browser account installation listing");
  assert.equal(listing.body.installations.length, 2);
  for (const installation of installations) {
    const row = page.locator(
      `[data-oauth-installation-id="${installation.installationId}"]`,
    );
    const text = await row.innerText();
    assert.match(text, /T07 Browser Harness/);
    assert.ok(
      text.includes(`${providerIdentity.name}'s organization`),
      "organization name is rendered in installation metadata",
    );
    assert.match(text, /t07-browser-service/);
    assert.match(text, /https:\/\/t07-browser\.0000\.test/);
    assert.match(text, /resource:read/);
    assert.match(text, /active/);
    for (const secret of [
      installation.accessToken,
      installation.refreshToken,
      client.clientSecret,
    ]) {
      if (secret) assert.equal(text.includes(secret), false);
    }
  }
  const pageContentBeforeRevoke = await page.content();
  for (const secret of [
    ...installations.flatMap((entry) => [
      entry.accessToken,
      entry.refreshToken,
    ]),
    client.clientSecret,
  ]) {
    if (secret) assert.equal(pageContentBeforeRevoke.includes(secret), false);
  }
  assert.equal(
    pageContentBeforeRevoke.includes("client_secret"),
    false,
    "browser account output does not expose client-secret form fields",
  );

  const target = installations[0];
  const sibling = installations[1];
  const targetRow = page.locator(
    `[data-oauth-installation-id="${target.installationId}"]`,
  );
  const revokeButton = targetRow.locator(
    "button[data-revoke-oauth-installation]",
  );
  assert.equal(await revokeButton.count(), 1, "actual revoke button rendered");
  await revokeButton.click();
  await page.waitForFunction(
    (installationId) => {
      const row = document.querySelector(
        `[data-oauth-installation-id="${installationId}"]`,
      );
      return (
        row?.textContent?.toLowerCase().includes("revoked") === true &&
        row.querySelector("button[data-revoke-oauth-installation]") === null
      );
    },
    target.installationId,
    { timeout: operationTimeoutMs },
  );
  const revokedRow = page.locator(
    `[data-oauth-installation-id="${target.installationId}"]`,
  );
  assert.match((await revokedRow.innerText()).toLowerCase(), /revoked/);
  assert.equal(
    await revokedRow.locator("button[data-revoke-oauth-installation]").count(),
    0,
    "revoked installation has no active revoke control",
  );
  const listingAfterRevoke = await accountInstallationJson(
    page,
    account.organizationId,
  );
  assert.equal(listingAfterRevoke.status, 200);
  const targetMetadata = listingAfterRevoke.body.installations.find(
    (entry) => entry.id === target.installationId,
  );
  const siblingMetadata = listingAfterRevoke.body.installations.find(
    (entry) => entry.id === sibling.installationId,
  );
  assert.equal(
    Number(targetMetadata?.active),
    0,
    "revoked metadata is terminal",
  );
  assert.ok(targetMetadata?.revoked_at, "revoked metadata has timestamp");
  assert.equal(
    Number(siblingMetadata?.active),
    1,
    "sibling metadata remains active",
  );

  const bridgeFetch = (input, init) => fetch(input, init);
  const verified = sharedClient(bridgeFetch, bridge.baseUrl);
  assert.equal(
    (await verified.authenticate(target.accessToken)).status,
    "invalid_credential",
    "revoked target access is denied through shared client",
  );
  assert.equal(
    (await verified.authenticate(sibling.accessToken)).status,
    "authenticated",
    "unrelated sibling access remains usable",
  );
  const deniedRefresh = await browserRefresh(page, {
    clientId: client.clientId,
    refreshToken: target.refreshToken,
    audience: service.audience,
  });
  assert.equal(deniedRefresh.status, 400, "revoked target refresh is denied");
  assert.equal(deniedRefresh.body.error, "invalid_grant");

  await page.reload({ waitUntil: "domcontentloaded" });
  const reloadedTarget = page.locator(
    `[data-oauth-installation-id="${target.installationId}"]`,
  );
  assert.match((await reloadedTarget.innerText()).toLowerCase(), /revoked/);
  assert.equal(
    await reloadedTarget
      .locator("button[data-revoke-oauth-installation]")
      .count(),
    0,
    "reload retains terminal revoked state",
  );
  const pageContentAfterRevoke = await page.content();
  for (const secret of [
    ...installations.flatMap((entry) => [
      entry.accessToken,
      entry.refreshToken,
    ]),
    client.clientSecret,
  ]) {
    if (secret) assert.equal(pageContentAfterRevoke.includes(secret), false);
  }
  assert.equal(
    pageContentAfterRevoke.includes("client_secret"),
    false,
    "reloaded browser account output does not expose client-secret form fields",
  );
  assert.equal(browserErrors.length, 0, browserErrors.join("\n"));

  console.log(
    JSON.stringify({
      experiment: "oauth-installation-browser",
      browser: "Chromium through Bun HTTP bridge",
      provider:
        "mocked GitHub callback outbound; OAuth token and installation routes were production",
      session:
        "synthetic provider callback established a real browser cookie session",
      installations: {
        listed: 2,
        metadata:
          "client name, organization, service, audience, capability and active state rendered",
        target: {
          installationId: target.installationId,
          afterRevoke: "revoked",
          access: "invalid_credential",
          refresh: "invalid_grant",
        },
        sibling: {
          installationId: sibling.installationId,
          afterTargetRevoke: "active",
          access: "authenticated",
        },
      },
      reload: "revoked terminal state retained and revoke control absent",
      secrets:
        "access and refresh values absent from account DOM; public client has no client-secret field",
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
  if (platform)
    await cleanupStep(
      "browser runtime dispose",
      () => platform.dispose(),
      cleanupState,
    );
  if (bridge)
    await cleanupStep("HTTP bridge close", () => bridge.close(), cleanupState);
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
