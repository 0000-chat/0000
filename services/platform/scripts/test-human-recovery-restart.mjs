import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPlatformClient } from "@0000/platform-client";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { opaqueSecret } from "../src/platform-state.ts";
import { registerTestService } from "../worker/test/fixtures/provision.ts";

const platformRoot = fileURLToPath(new URL("../", import.meta.url));
const workerEntry = fileURLToPath(new URL("../src/worker.ts", import.meta.url));
const compatibilityDate = "2026-09-18";
const platformBaseUrl = "http://localhost";
const authority = "platform-human-recovery-authority";
const audience = "https://human-recovery.0000.test";
const providerIdentity = {
  id: 814920,
  login: "platform-human-restart",
  name: "Platform Human Restart",
  email: "human-restart@example.test",
};

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
    await database.batch(
      migration.queries.map((query) => database.prepare(query)),
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
      access_token: "human-restart-provider-token",
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
      PLATFORM_BASE_URL: platformBaseUrl,
      PLATFORM_AUTHORITY_ID: authority,
      PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS: "90",
      PLATFORM_DEPLOYMENT_MODE: "self-hosted",
      PLATFORM_SIGNUP_POLICY: "open",
      GITHUB_CLIENT_ID: "human-recovery-probe",
      GITHUB_CLIENT_SECRET: "local-probe-only",
      BETTER_AUTH_SECRET: "local-probe-secret-not-for-deployment",
    },
    compatibilityDate,
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { IDENTITY_DB: "platform-identity" },
    host: "127.0.0.1",
    modules: true,
    name: "platform-human-recovery-probe",
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
  assert.equal(response.status, expected, `${label} status`);
}

async function signUp(fetch) {
  const start = await fetch(`${platformBaseUrl}/api/auth/sign-in/social`, {
    method: "POST",
    headers: {
      origin: platformBaseUrl,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      provider: "github",
      callbackURL: "http://localhost/account",
    }),
  });
  await expectStatus(start, 200, "human signup start");
  const startBody = await start.json();
  const state = new URL(startBody.url).searchParams.get("state");
  assert.ok(state, "provider state returned");

  const callback = await fetch(
    `${platformBaseUrl}/api/auth/callback/github?code=human-restart-signup&state=${encodeURIComponent(state)}`,
    {
      headers: {
        cookie: cookiesFrom(start),
        origin: platformBaseUrl,
      },
      redirect: "manual",
    },
  );
  await expectStatus(callback, 302, "human signup callback");
  const cookie = cookiesFrom(callback);
  assert.ok(cookie, "human session cookie returned");
  return { callback, cookie };
}

async function readSession(fetch, cookie) {
  const response = await fetch(`${platformBaseUrl}/api/auth/get-session`, {
    headers: { cookie },
  });
  await expectStatus(response, 200, "human session read");
  const session = await response.json();
  assert.ok(session?.user?.id, "human user persisted");
  assert.ok(session?.session?.id, "human session persisted");
  return session;
}

async function readMe(fetch, cookie) {
  const response = await fetch(`${platformBaseUrl}/api/me`, {
    headers: { cookie },
  });
  await expectStatus(response, 200, "human default organization read");
  const me = await response.json();
  assert.ok(me.userId, "default organization user persisted");
  assert.ok(me.organizationId, "default organization persisted");
  assert.ok(me.membershipId, "default membership persisted");
  return me;
}

async function issueCredential(fetch, cookie, organizationId, name) {
  const response = await fetch(`${platformBaseUrl}/api/credentials`, {
    method: "POST",
    headers: {
      cookie,
      origin: platformBaseUrl,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      serviceId: "human-recovery-service",
      organizationId,
      capabilities: ["resource:read"],
      name,
    }),
  });
  await expectStatus(response, 201, `${name} issue`);
  const issued = await response.json();
  assert.match(issued.credential, /^0000_/);
  assert.ok(issued.credentialId, `${name} id returned`);
  return issued;
}

const persistenceDirectory = await mkdtemp(join(tmpdir(), "platform-human-"));
const workerScript = await buildWorkerScript();
let first;
let second;
let failed = false;
let failure;

try {
  first = createRuntime(workerScript, persistenceDirectory);
  await first.ready;
  const firstFetch = (input, init) => first.dispatchFetch(input, init);
  const database = await first.getD1Database("IDENTITY_DB");
  await applyMigrations(database, join(platformRoot, "migrations"));

  const service = {
    serviceId: "human-recovery-service",
    audience,
    verifier: opaqueSecret("human_recovery_verify_"),
    guestGrantIssuer: opaqueSecret("human_recovery_guest_grant_"),
    allowedCapabilities: ["resource:read"],
  };
  await registerTestService(database, service);

  const signup = await signUp(firstFetch);
  const beforeSession = await readSession(firstFetch, signup.cookie);
  const beforeMe = await readMe(firstFetch, signup.cookie);
  assert.equal(beforeSession.user.email, providerIdentity.email);
  assert.equal(beforeMe.userId, beforeSession.user.id);
  const firstCredential = await issueCredential(
    firstFetch,
    signup.cookie,
    beforeMe.organizationId,
    "Restart probe key",
  );
  const secondCredential = await issueCredential(
    firstFetch,
    signup.cookie,
    beforeMe.organizationId,
    "Restart probe survivor",
  );

  const beforeClient = createPlatformClient({
    baseUrl: platformBaseUrl,
    authority,
    audience,
    serviceVerifier: service.verifier,
    fetch: firstFetch,
  });
  assert.equal(
    (await beforeClient.authenticate(firstCredential.credential)).status,
    "authenticated",
    "first key authenticates before restart",
  );
  assert.equal(
    (await beforeClient.authenticate(secondCredential.credential)).status,
    "authenticated",
    "survivor key authenticates before restart",
  );

  const persisted = {
    cookie: signup.cookie,
    sessionId: beforeSession.session.id,
    userId: beforeSession.user.id,
    email: beforeSession.user.email,
    organizationId: beforeMe.organizationId,
    membershipId: beforeMe.membershipId,
    firstCredential,
    secondCredential,
  };

  await first.dispose();
  first = undefined;

  second = createRuntime(workerScript, persistenceDirectory);
  await second.ready;
  const secondFetch = (input, init) => second.dispatchFetch(input, init);
  const afterSession = await readSession(secondFetch, persisted.cookie);
  const afterMe = await readMe(secondFetch, persisted.cookie);
  assert.deepEqual(
    {
      sessionId: afterSession.session.id,
      userId: afterSession.user.id,
      email: afterSession.user.email,
    },
    {
      sessionId: persisted.sessionId,
      userId: persisted.userId,
      email: persisted.email,
    },
    "human and session survive runtime restart",
  );
  assert.deepEqual(
    {
      userId: afterMe.userId,
      organizationId: afterMe.organizationId,
      membershipId: afterMe.membershipId,
    },
    {
      userId: persisted.userId,
      organizationId: persisted.organizationId,
      membershipId: persisted.membershipId,
    },
    "default organization and membership survive runtime restart",
  );

  const afterClient = createPlatformClient({
    baseUrl: platformBaseUrl,
    authority,
    audience,
    serviceVerifier: service.verifier,
    fetch: secondFetch,
  });
  const afterFirst = await afterClient.authenticate(
    persisted.firstCredential.credential,
  );
  const afterSecond = await afterClient.authenticate(
    persisted.secondCredential.credential,
  );
  assert.equal(
    afterFirst.status,
    "authenticated",
    "first key survives restart",
  );
  assert.equal(
    afterSecond.status,
    "authenticated",
    "survivor key survives restart",
  );
  if (afterFirst.status === "authenticated") {
    assert.equal(afterFirst.principal.kind, "human");
    if (afterFirst.principal.kind === "human") {
      assert.equal(afterFirst.principal.subjectId, persisted.userId);
      assert.equal(
        afterFirst.principal.organizationId,
        persisted.organizationId,
      );
      assert.equal(afterFirst.principal.membershipId, persisted.membershipId);
    }
  }

  const revoke = await secondFetch(
    `${platformBaseUrl}/api/credentials/revoke`,
    {
      method: "POST",
      headers: {
        cookie: persisted.cookie,
        origin: platformBaseUrl,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        credentialId: persisted.firstCredential.credentialId,
        organizationId: persisted.organizationId,
      }),
    },
  );
  await expectStatus(revoke, 200, "post-restart key revoke");
  assert.equal(
    (await afterClient.authenticate(persisted.firstCredential.credential))
      .status,
    "invalid_credential",
    "revoked key is denied after restart",
  );
  assert.equal(
    (await afterClient.authenticate(persisted.secondCredential.credential))
      .status,
    "authenticated",
    "unrevoked key remains valid after sibling revoke",
  );

  const logout = await secondFetch(`${platformBaseUrl}/api/auth/sign-out`, {
    method: "POST",
    headers: {
      cookie: persisted.cookie,
      origin: platformBaseUrl,
      "content-type": "application/json",
    },
    body: JSON.stringify({ disableRedirect: true }),
  });
  await expectStatus(logout, 200, "post-restart human logout");
  const sessionAfterLogout = await secondFetch(
    `${platformBaseUrl}/api/auth/get-session`,
    { headers: { cookie: persisted.cookie } },
  );
  await expectStatus(sessionAfterLogout, 200, "post-logout session read");
  assert.equal(
    await sessionAfterLogout.json(),
    null,
    "logged-out session denied",
  );
  const credentialRouteAfterLogout = await secondFetch(
    `${platformBaseUrl}/api/credentials?organizationId=${encodeURIComponent(persisted.organizationId)}`,
    { headers: { cookie: persisted.cookie } },
  );
  await expectStatus(
    credentialRouteAfterLogout,
    401,
    "post-logout browser credential listing",
  );
  assert.equal(
    (await afterClient.authenticate(persisted.secondCredential.credential))
      .status,
    "authenticated",
    "API key remains independent of browser logout",
  );

  console.log(
    JSON.stringify({
      experiment: "human-restart",
      provider: "mocked GitHub outbound service",
      signup: {
        userId: persisted.userId,
        email: persisted.email,
        sessionId: persisted.sessionId,
      },
      defaultOrganization: {
        organizationId: persisted.organizationId,
        membershipId: persisted.membershipId,
      },
      restart: {
        migrationsAppliedBeforeRestart: true,
        migrationsReappliedAfterRestart: false,
        session: "same user/session",
        keys: "both authenticate",
      },
      revocation: {
        revokedKey: "invalid_credential",
        survivorKey: "authenticated",
      },
      logout: {
        session: "null",
        browserCredentialListing: 401,
        survivorKey: "authenticated",
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
