import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPlatformClient } from "@0000/platform-client";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import {
  oauthProviderTokenHash,
  provisionTrustedOAuthClient,
} from "../src/oauth-installation.ts";
import { opaqueSecret } from "../src/platform-state.ts";
import { registerTestService } from "../worker/test/fixtures/provision.ts";

const platformRoot = fileURLToPath(new URL("../", import.meta.url));
const workerEntry = fileURLToPath(new URL("../src/worker.ts", import.meta.url));
const compatibilityDate = "2026-09-18";
const platformBaseUrl = "http://localhost";
const authority = "platform-t07-restart-authority";
const service = {
  serviceId: "t07-restart-service",
  audience: "https://t07-restart.0000.test",
  verifier: opaqueSecret("t07_restart_verify_"),
  guestGrantIssuer: opaqueSecret("t07_restart_guest_grant_"),
  allowedCapabilities: ["resource:read"],
};
const providerIdentity = {
  id: 817071,
  login: "t07-runtime-restart",
  name: "T07 Runtime Restart",
  email: "t07-runtime-restart@example.test",
};

const operationTimeoutMs = 20_000;

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

async function applyMigrations(database, migrationsPath) {
  const migrations = await readD1Migrations(migrationsPath);
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
      access_token: "t07-runtime-provider-access",
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

function createRuntime(script, persistenceDirectory) {
  const options = convertV4MiniflareOptions({
    bindings: {
      BETTER_AUTH_SECRET:
        "t07-runtime-restart-secret-with-at-least-32-characters",
      GITHUB_CLIENT_ID: "t07-runtime-github-client",
      GITHUB_CLIENT_SECRET: "t07-runtime-github-secret",
      PLATFORM_AUTHORITY_ID: authority,
      PLATFORM_BASE_URL: platformBaseUrl,
      PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS: "90",
      PLATFORM_DEPLOYMENT_MODE: "self-hosted",
      PLATFORM_SIGNUP_POLICY: "open",
    },
    compatibilityDate,
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { IDENTITY_DB: "platform-t07-restart-identity" },
    host: "127.0.0.1",
    modules: true,
    name: "platform-t07-runtime-restart",
    outboundService: providerOutbound,
    resourcePersistencePath: persistenceDirectory,
    script,
  });
  return new Miniflare(options);
}

function cookiesFrom(...responses) {
  const cookies = new Map();
  for (const response of responses) {
    const all = response.headers.getSetCookie?.() ?? [
      response.headers.get("set-cookie") ?? "",
    ];
    for (const cookie of all) {
      const pair = cookie.split(";")[0];
      const separator = pair.indexOf("=");
      if (pair && separator > 0) {
        cookies.set(pair.slice(0, separator), pair);
      }
    }
  }
  return [...cookies.values()].join("; ");
}

async function expectStatus(response, expected, label) {
  const body =
    expected === response.status ? "" : `: ${await response.clone().text()}`;
  assert.equal(response.status, expected, `${label} status${body}`);
}

async function signIn(fetch, code) {
  const start = await within(
    "social sign-in start",
    fetch(`${platformBaseUrl}/api/auth/sign-in/social`, {
      method: "POST",
      headers: {
        origin: platformBaseUrl,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider: "github",
        callbackURL: `${platformBaseUrl}/account`,
      }),
    }),
  );
  await expectStatus(start, 200, "social sign-in start");
  const startBody = await start.json();
  const state = new URL(startBody.url).searchParams.get("state");
  assert.ok(state, "provider state returned");
  const callback = await within(
    "social callback",
    fetch(
      `${platformBaseUrl}/api/auth/callback/github?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      {
        headers: {
          cookie: cookiesFrom(start),
          origin: platformBaseUrl,
        },
        redirect: "manual",
      },
    ),
  );
  await expectStatus(callback, 302, "social callback");
  const cookie = cookiesFrom(callback);
  assert.ok(cookie, "human session cookie returned");
  const session = await within(
    "session read",
    fetch(`${platformBaseUrl}/api/auth/get-session`, {
      headers: { cookie },
    }),
  );
  await expectStatus(session, 200, "session read");
  const sessionBody = await session.json();
  assert.ok(sessionBody?.user?.id, "human user persisted");
  return {
    cookie,
    userId: sessionBody.user.id,
    sessionId: sessionBody.session.id,
  };
}

async function organizationId(fetch, cookie) {
  const response = await within(
    "organization read",
    fetch(`${platformBaseUrl}/api/me`, { headers: { cookie } }),
  );
  await expectStatus(response, 200, "organization read");
  const body = await response.json();
  assert.ok(body.organizationId, "default organization persisted");
  assert.ok(body.membershipId, "default membership persisted");
  return {
    organizationId: body.organizationId,
    membershipId: body.membershipId,
  };
}

async function issueInstallation(fetch, input) {
  const verifier = opaqueSecret("t07_restart_pkce_");
  const state = crypto.randomUUID();
  const query = new URLSearchParams({
    client_id: input.client.clientId,
    response_type: "code",
    redirect_uri: input.client.redirectUri,
    scope: "resource:read offline_access",
    resource: service.audience,
    state,
    code_challenge: await challenge(verifier),
    code_challenge_method: "S256",
  });
  const authorize = await within(
    "OAuth authorize",
    fetch(`${platformBaseUrl}/api/auth/oauth2/authorize?${query}`, {
      headers: { cookie: input.cookie },
      redirect: "manual",
    }),
  );
  await expectStatus(authorize, 302, `${input.label} authorize`);
  const selectionUrl = new URL(
    authorize.headers.get("location"),
    platformBaseUrl,
  );
  const selectionPage = await within(
    "OAuth selection page",
    fetch(selectionUrl, { headers: { cookie: input.cookie } }),
  );
  await expectStatus(selectionPage, 200, `${input.label} selection page`);
  const flow = await within(
    "OAuth flow lookup",
    input.database
      .prepare(
        "SELECT id FROM platform_oauth_flow WHERE user_id = ? AND state = ? ORDER BY created_at DESC LIMIT 1",
      )
      .bind(input.userId, state)
      .first(),
  );
  assert.ok(flow?.id, `${input.label} persisted flow`);
  const selected = await within(
    "OAuth organization selection",
    fetch(`${platformBaseUrl}/oauth2/selection`, {
      method: "POST",
      headers: {
        cookie: input.cookie,
        origin: platformBaseUrl,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        flowId: flow.id,
        organizationId: input.organizationId,
      }),
      redirect: "manual",
    }),
  );
  await expectStatus(selected, 303, `${input.label} organization selection`);
  const continued = await within(
    "OAuth consent continuation",
    fetch(new URL(selected.headers.get("location"), platformBaseUrl), {
      headers: { cookie: input.cookie },
      redirect: "manual",
    }),
  );
  await expectStatus(continued, 302, `${input.label} consent continuation`);
  const consentUrl = new URL(
    continued.headers.get("location"),
    platformBaseUrl,
  );
  const consentPage = await within(
    "OAuth consent page",
    fetch(consentUrl, { headers: { cookie: input.cookie } }),
  );
  await expectStatus(consentPage, 200, `${input.label} consent page`);
  const consent = await within(
    "OAuth consent",
    fetch(`${platformBaseUrl}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: {
        cookie: input.cookie,
        origin: platformBaseUrl,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        accept: true,
        oauth_query: consentUrl.search.slice(1),
      }),
    }),
  );
  await expectStatus(consent, 200, `${input.label} consent`);
  const consentBody = await consent.json();
  const callback = new URL(
    consentBody.redirect_uri ?? consentBody.url ?? "",
    platformBaseUrl,
  );
  const code = callback.searchParams.get("code");
  assert.ok(code, `${input.label} authorization code returned`);
  const tokenValues = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: input.client.clientId,
    redirect_uri: input.client.redirectUri,
    code,
    code_verifier: verifier,
    resource: service.audience,
  });
  if (input.client.clientSecret) {
    tokenValues.set("client_secret", input.client.clientSecret);
  }
  const token = await within(
    "OAuth code exchange",
    fetch(`${platformBaseUrl}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenValues,
    }),
  );
  await expectStatus(token, 200, `${input.label} code exchange`);
  const body = await token.json();
  assert.match(body.access_token, /^.{16,}$/, `${input.label} access token`);
  assert.match(body.refresh_token, /^.{16,}$/, `${input.label} refresh token`);
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
  };
}

async function challenge(value) {
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

async function installationId(database, accessToken) {
  const tokenHash = await oauthProviderTokenHash(accessToken);
  const row = await within(
    "installation lookup",
    database
      .prepare(
        "SELECT referenceId AS installation_id FROM oauthAccessToken WHERE token = ? LIMIT 1",
      )
      .bind(tokenHash)
      .first(),
  );
  assert.ok(row?.installation_id, "access token is mapped to installation");
  return row.installation_id;
}

async function familyState(database, installation) {
  const row = await within(
    "refresh family lookup",
    database
      .prepare(
        `SELECT f.id AS family_id, f.state AS family_state,
                f.pending_token_id, f.pending_consumption_nonce,
                i.active AS installation_active, i.revoked_at,
                COUNT(t.id) AS token_count,
                MIN(t.state) AS first_token_state,
                MAX(t.sequence) AS last_sequence
         FROM platform_oauth_refresh_family AS f
         JOIN platform_oauth_installation AS i ON i.id = f.installation_id
         LEFT JOIN platform_oauth_refresh_token AS t ON t.family_id = f.id
         WHERE f.installation_id = ?
         GROUP BY f.id, i.active, i.revoked_at`,
      )
      .bind(installation)
      .first(),
  );
  assert.ok(row?.family_id, `refresh family exists for ${installation}`);
  return row;
}

async function addFailureTriggers(database, installation, familyId) {
  const quotedInstallation = sqlString(installation);
  const quotedFamily = sqlString(familyId);
  await within(
    "provider failure trigger",
    database
      .prepare(
        `CREATE TRIGGER t07_probe_provider_refresh_failure
         BEFORE INSERT ON oauthAccessToken
         WHEN NEW.referenceId = ${quotedInstallation}
         BEGIN SELECT RAISE(ABORT, 't07 provider refresh failure'); END`,
      )
      .run(),
  );
  await within(
    "quarantine failure trigger",
    database
      .prepare(
        `CREATE TRIGGER t07_probe_quarantine_failure
         BEFORE UPDATE OF state ON platform_oauth_refresh_family
         WHEN OLD.id = ${quotedFamily} AND NEW.state = 'quarantined'
         BEGIN SELECT RAISE(ABORT, 't07 quarantine persistence failure'); END`,
      )
      .run(),
  );
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function refresh(fetch, input) {
  const values = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: input.client.clientId,
    refresh_token: input.refreshToken,
    resource: service.audience,
  });
  if (input.client.clientSecret) {
    values.set("client_secret", input.client.clientSecret);
  }
  const response = await within(
    `${input.label} refresh`,
    fetch(`${platformBaseUrl}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: values,
    }),
  );
  const body = await response
    .clone()
    .json()
    .catch(() => ({}));
  return { response, body };
}

function sharedClient(fetch) {
  return createPlatformClient({
    baseUrl: platformBaseUrl,
    authority,
    audience: service.audience,
    serviceVerifier: service.verifier,
    fetch,
  });
}

async function logout(fetch, cookie) {
  const response = await within(
    "human logout",
    fetch(`${platformBaseUrl}/api/auth/sign-out`, {
      method: "POST",
      headers: {
        cookie,
        origin: platformBaseUrl,
        "content-type": "application/json",
      },
      body: JSON.stringify({ disableRedirect: true }),
    }),
  );
  await expectStatus(response, 200, "human logout");
  const session = await within(
    "post-logout session read",
    fetch(`${platformBaseUrl}/api/auth/get-session`, { headers: { cookie } }),
  );
  await expectStatus(session, 200, "post-logout session read");
  assert.equal(await session.json(), null, "browser session is revoked");
}

const persistenceDirectory = await within(
  "persistence directory",
  mkdtemp(join(tmpdir(), "platform-t07-restart-")),
);
const workerScript = await buildWorkerScript();
let first;
let second;
let failed = false;
let failure;

try {
  first = createRuntime(workerScript, persistenceDirectory);
  await within("first runtime ready", first.ready);
  const firstFetch = (input, init) => first.dispatchFetch(input, init);
  const firstDatabase = await within(
    "first database open",
    first.getD1Database("IDENTITY_DB"),
  );
  await applyMigrations(firstDatabase, join(platformRoot, "migrations"));
  await registerTestService(firstDatabase, service);
  const firstUser = await signIn(firstFetch, "t07-runtime-signup");
  const firstOrganization = await organizationId(firstFetch, firstUser.cookie);
  const client = await provisionTrustedOAuthClient(
    firstDatabase,
    "t07-runtime-restart-secret-with-at-least-32-characters",
    {
      serviceId: service.serviceId,
      clientId: "t07-runtime-restart-client",
      redirectUri: "https://t07-runtime-restart-client.example.test/callback",
      capabilities: service.allowedCapabilities,
      authMethod: "client_secret_post",
      name: "T07 Runtime Restart Harness",
      refreshEnabled: true,
    },
  );

  const target = await issueInstallation(firstFetch, {
    ...firstUser,
    organizationId: firstOrganization.organizationId,
    database: firstDatabase,
    client,
    label: "target",
  });
  const targetInstallation = await installationId(
    firstDatabase,
    target.accessToken,
  );
  const targetFamilyBeforeFault = await familyState(
    firstDatabase,
    targetInstallation,
  );
  assert.equal(targetFamilyBeforeFault.family_state, "active");
  assert.equal(targetFamilyBeforeFault.first_token_state, "issued");

  const sibling = await issueInstallation(firstFetch, {
    ...firstUser,
    organizationId: firstOrganization.organizationId,
    database: firstDatabase,
    client,
    label: "sibling",
  });
  const siblingInstallation = await installationId(
    firstDatabase,
    sibling.accessToken,
  );
  const siblingFamilyBeforeFault = await familyState(
    firstDatabase,
    siblingInstallation,
  );
  assert.equal(siblingFamilyBeforeFault.family_state, "active");
  assert.equal(siblingFamilyBeforeFault.first_token_state, "issued");

  const beforeClient = sharedClient(firstFetch);
  assert.equal(
    (await beforeClient.authenticate(target.accessToken)).status,
    "authenticated",
    "target access authenticates before failure",
  );
  assert.equal(
    (await beforeClient.authenticate(sibling.accessToken)).status,
    "authenticated",
    "sibling access authenticates before failure",
  );

  await addFailureTriggers(
    firstDatabase,
    targetInstallation,
    targetFamilyBeforeFault.family_id,
  );
  const failedRefresh = await refresh(firstFetch, {
    ...target,
    client,
    label: "faulted target",
  });
  await expectStatus(
    failedRefresh.response,
    503,
    "faulted refresh after consume/quarantine failure",
  );
  assert.equal(
    failedRefresh.body.error,
    "temporarily_unavailable",
    "faulted refresh fails closed",
  );
  assert.equal(
    failedRefresh.body.status,
    "authority_unavailable",
    "faulted refresh reports authority unavailability",
  );
  const pendingBeforeRestart = await familyState(
    firstDatabase,
    targetInstallation,
  );
  assert.equal(pendingBeforeRestart.family_state, "pending");
  assert.equal(pendingBeforeRestart.first_token_state, "pending");
  assert.equal(pendingBeforeRestart.pending_token_id !== null, true);
  assert.equal(pendingBeforeRestart.pending_consumption_nonce !== null, true);
  assert.equal(
    (await beforeClient.authenticate(target.accessToken)).status,
    "invalid_credential",
    "pending target access is denied",
  );
  const pendingRefresh = await refresh(firstFetch, {
    ...target,
    client,
    label: "pending target",
  });
  await expectStatus(
    pendingRefresh.response,
    503,
    "pending target refresh is denied",
  );
  assert.equal(
    (await beforeClient.authenticate(sibling.accessToken)).status,
    "authenticated",
    "healthy sibling remains usable after target failure",
  );

  const persisted = {
    ...firstUser,
    ...firstOrganization,
    target,
    targetInstallation,
    sibling,
    siblingInstallation,
    client,
    targetFamilyId: targetFamilyBeforeFault.family_id,
  };
  await within("first runtime dispose", first.dispose());
  first = undefined;

  second = createRuntime(workerScript, persistenceDirectory);
  await within("second runtime ready", second.ready);
  const secondFetch = (input, init) => second.dispatchFetch(input, init);
  const secondDatabase = await within(
    "second database open",
    second.getD1Database("IDENTITY_DB"),
  );
  const afterClient = sharedClient(secondFetch);
  const pendingAfterRestart = await familyState(
    secondDatabase,
    persisted.targetInstallation,
  );
  assert.equal(pendingAfterRestart.family_id, persisted.targetFamilyId);
  assert.equal(pendingAfterRestart.family_state, "pending");
  assert.equal(pendingAfterRestart.first_token_state, "pending");
  assert.equal(
    (await afterClient.authenticate(persisted.target.accessToken)).status,
    "invalid_credential",
    "durable pending target access remains denied after restart",
  );
  const pendingAfterRestartRefresh = await refresh(secondFetch, {
    ...persisted.target,
    client: persisted.client,
    label: "durable pending target",
  });
  await expectStatus(
    pendingAfterRestartRefresh.response,
    503,
    "durable pending target refresh remains denied after restart",
  );
  assert.equal(
    (await afterClient.authenticate(persisted.sibling.accessToken)).status,
    "authenticated",
    "healthy sibling access survives runtime restart",
  );

  await logout(secondFetch, persisted.cookie);
  const siblingRefresh = await refresh(secondFetch, {
    ...persisted.sibling,
    client: persisted.client,
    label: "healthy sibling after logout",
  });
  await expectStatus(
    siblingRefresh.response,
    200,
    "healthy sibling refresh after logout",
  );
  assert.match(
    siblingRefresh.body.access_token,
    /^.{16,}$/,
    "healthy successor access returned",
  );
  assert.match(
    siblingRefresh.body.refresh_token,
    /^.{16,}$/,
    "healthy successor refresh returned",
  );
  assert.equal(
    (await afterClient.authenticate(siblingRefresh.body.access_token)).status,
    "authenticated",
    "healthy successor authenticates after restart and logout",
  );
  const siblingAfterRefresh = await familyState(
    secondDatabase,
    persisted.siblingInstallation,
  );
  assert.equal(siblingAfterRefresh.family_state, "active");
  assert.equal(siblingAfterRefresh.last_sequence, 1);

  const reauthenticated = await signIn(secondFetch, "t07-runtime-reauth");
  assert.notEqual(reauthenticated.cookie, persisted.cookie);
  const reauthOrganization = await organizationId(
    secondFetch,
    reauthenticated.cookie,
  );
  assert.equal(
    reauthOrganization.organizationId,
    persisted.organizationId,
    "reauthentication returns the same organization authority",
  );
  const reauthorized = await issueInstallation(secondFetch, {
    ...reauthenticated,
    organizationId: reauthOrganization.organizationId,
    database: secondDatabase,
    client: persisted.client,
    label: "reauthorized",
  });
  const reauthorizedInstallation = await installationId(
    secondDatabase,
    reauthorized.accessToken,
  );
  assert.notEqual(
    reauthorizedInstallation,
    persisted.targetInstallation,
    "reauthorization uses a new installation",
  );
  const reauthorizedFamily = await familyState(
    secondDatabase,
    reauthorizedInstallation,
  );
  assert.equal(reauthorizedFamily.family_state, "active");
  assert.equal(reauthorizedFamily.first_token_state, "issued");
  assert.equal(
    (await afterClient.authenticate(reauthorized.accessToken)).status,
    "authenticated",
    "reauthorized installation access authenticates",
  );
  const oldFamilyAfterReauth = await familyState(
    secondDatabase,
    persisted.targetInstallation,
  );
  assert.equal(
    oldFamilyAfterReauth.family_id,
    persisted.targetFamilyId,
    "old family is retained as the same durable record",
  );
  assert.equal(
    oldFamilyAfterReauth.family_state,
    "pending",
    "reauthorization does not resurrect old pending family",
  );

  console.log(
    JSON.stringify({
      experiment: "oauth-refresh-restart",
      provider:
        "mocked GitHub outbound service; OAuth provider storage remained production",
      faultInjection: {
        providerWrite: "D1 BEFORE INSERT trigger on target oauthAccessToken",
        quarantineWrite:
          "D1 BEFORE UPDATE trigger rejecting target family quarantined state",
        observedResponse: failedRefresh.response.status,
      },
      target: {
        installationId: persisted.targetInstallation,
        familyId: persisted.targetFamilyId,
        before: "active/issued",
        afterFailure: "pending/pending",
        afterRestart: "pending/pending",
        access: "denied",
        refresh: "denied",
      },
      sibling: {
        installationId: persisted.siblingInstallation,
        before: "active/issued",
        afterRestart: "active/issued",
        afterLogoutRefresh: "active/sequence-1",
        access: "authenticated",
      },
      reauthorization: {
        installationId: reauthorizedInstallation,
        family: "new active family",
        oldFamily: "same pending family",
      },
      runtime: {
        migrationsAppliedBeforeRestart: true,
        migrationsReappliedAfterRestart: false,
        persistenceDirectoryReused: true,
      },
    }),
  );
} catch (error) {
  failed = true;
  failure = error;
} finally {
  for (const runtime of [second, first]) {
    try {
      await runtime?.dispose();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }
  try {
    await rm(persistenceDirectory, { force: true, recursive: true });
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
}

if (failed) throw failure;
