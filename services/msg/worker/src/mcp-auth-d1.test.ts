import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readD1Migrations } from "../../../platform/node_modules/@cloudflare/vitest-plugin";
import { convertV4MiniflareOptions, Miniflare } from "../../../platform/node_modules/miniflare";
import { expect, mock, test } from "bun:test";

import { McpAuthError, McpAuthService } from "./mcp-auth";
import { D1McpAuthStore } from "./mcp-auth-store";
import type { D1DatabaseLike } from "./operations";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: unknown;
    constructor(ctx: unknown) { this.ctx = ctx; }
  },
}));

const issuer = "https://0000.chat";
const legacyIssuer = "https://msg.0000.chat";
const resource = `${issuer}/mcp`;
const legacyResource = `${legacyIssuer}/mcp`;
const threadUrl = `${legacyIssuer}/thread-d1-auth`;
const redirectUri = "https://client.example.test/callback";
const serviceRoot = join(import.meta.dir, "../..");

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function hidden(html: string, name: string): string {
  const match = new RegExp(`<input type="hidden" name="${name}" value="([^"]+)"`, "u").exec(html);
  if (!match?.[1]) throw new Error(`Missing consent field ${name}.`);
  return match[1];
}

async function applyMigrations(database: D1DatabaseLike): Promise<void> {
  const migrations = await readD1Migrations(join(serviceRoot, "worker/migrations"));
  for (const migration of migrations) {
    if (migration.queries.length > 0) await database.batch(migration.queries.map((query) => database.prepare(query)));
  }
}

test.serial("stores OAuth grant provenance in D1 and rechecks revoked public links", { timeout: 30_000 }, async () => {
  const persistence = await mkdtemp(join(tmpdir(), "msg-mcp-auth-d1-"));
  const runtime = new Miniflare(convertV4MiniflareOptions({
    compatibilityDate: "2026-08-09",
    d1Databases: { MSG_DB: "msg-mcp-auth-d1" },
    host: "127.0.0.1",
    modules: true,
    name: "msg-mcp-auth-d1",
    port: 0,
    resourcePersistencePath: persistence,
    script: "export default {};",
  }));
  try {
    const { createMcpAuthenticator } = await import("./worker-entry");
    await runtime.ready;
    const database = await runtime.getD1Database("MSG_DB") as unknown as D1DatabaseLike;
    await applyMigrations(database);
    const store = new D1McpAuthStore(database);
    let linksRevoked = false;
    const auth = new McpAuthService({ acceptedOrigins: [legacyIssuer], issuer, resource, store });

    const registration = await auth.registerClient(new Request(`${issuer}/register`, {
      body: JSON.stringify({ client_name: "D1 test client", redirect_uris: [redirectUri] }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }));
    expect(registration.status).toBe(201);
    const client = await registration.json() as { client_id: string };
    const verifier = "v".repeat(43);
    const challenge = await sha256(verifier);
    const authorizationUrl = new URL(`${issuer}/authorize`);
    authorizationUrl.search = new URLSearchParams({
      client_id: client.client_id,
      code_challenge: challenge,
      code_challenge_method: "S256",
      redirect_uri: redirectUri,
      response_type: "code",
      resource,
      scope: "threads:read",
      state: "d1-state",
    }).toString();
    const consent = await auth.authorize(new Request(authorizationUrl), { validateThread: async (candidate) => linksRevoked ? null : { canonicalUrl: candidate } });
    expect(consent.status).toBe(200);
    const consentHtml = await consent.text();
    const requestId = hidden(consentHtml, "request_id");
    const csrf = hidden(consentHtml, "csrf");
    const allowed = await auth.authorize(new Request(`${legacyIssuer}/authorize`, {
      body: JSON.stringify({ csrf, decision: "allow", grants: [{ scopes: ["threads:read"], thread_url: threadUrl }], request_id: requestId }),
      headers: { "content-type": "application/json", origin: legacyIssuer },
      method: "POST",
    }), { validateThread: async (candidate) => linksRevoked ? null : { canonicalUrl: candidate } });
    expect(allowed.status).toBe(302);
    const code = new URL(allowed.headers.get("location") ?? redirectUri).searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenResponse = await auth.token(new Request(`${issuer}/token`, {
      body: new URLSearchParams({ code: code ?? "", client_id: client.client_id, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri, resource }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    }));
    expect(tokenResponse.status).toBe(200);
    const token = await tokenResponse.json() as { access_token: string };
    const bearer = new Request(resource, { headers: { authorization: `Bearer ${token.access_token}` } });
    const principal = await auth.authenticateBearer(bearer);
    const grant = await store.getGrant(principal.principalId, `${issuer}/thread-d1-auth`);
    expect(grant).toMatchObject({ source: "public", scope: "threads:read", threadUrl: `${issuer}/thread-d1-auth` });

    linksRevoked = true;
    const roomService = { roomStatus: async () => ({ active: true, agent_posting_enabled: true, expires_at: "2099-01-01T00:00:00.000Z", latest_message: 1, protocol_version: 1, public_grants_allowed: false }) };
    const mcpAuth = createMcpAuthenticator(auth, issuer, roomService as never);
    const authenticated = await mcpAuth.authenticate(bearer);
    expect(authenticated).not.toBeNull();
    expect(await authenticated?.authorize("thread-d1-auth", "read")).toBe(false);

    const deniedConsent = await auth.authorize(new Request(authorizationUrl), { validateThread: async (candidate) => linksRevoked ? null : { canonicalUrl: candidate } });
    expect(deniedConsent.status).toBe(200);
    const deniedHtml = await deniedConsent.text();
    const deniedRequestId = hidden(deniedHtml, "request_id");
    const deniedCsrf = hidden(deniedHtml, "csrf");
    let deniedCode = "";
    try {
      await auth.authorize(new Request(`${legacyIssuer}/authorize`, {
        body: JSON.stringify({ csrf: deniedCsrf, decision: "allow", grants: [{ scopes: ["threads:read"], thread_url: threadUrl }], request_id: deniedRequestId }),
        headers: { "content-type": "application/json", origin: legacyIssuer },
        method: "POST",
      }), { validateThread: async () => null });
    } catch (error) {
      deniedCode = error instanceof Error && "code" in error ? String((error as Error & { code?: unknown }).code) : "";
    }
    expect(deniedCode).toBe("access_denied");

    const explicitPrincipalId = "prf_explicit_d1_test";
    const explicitToken = "e".repeat(43);
    const now = Date.now();
    await store.createPrincipal(explicitPrincipalId, now);
    await store.upsertGrant({ createdAt: now, principalId: explicitPrincipalId, revokedAt: null, scope: "threads:read", source: "explicit", threadUrl: `${issuer}/thread-d1-auth` });
    await store.createAccessToken({ clientId: client.client_id, createdAt: now, expiresAt: now + 60_000, principalId: explicitPrincipalId, resource, revokedAt: null, scope: "threads:read", tokenHash: await sha256(explicitToken) });
    const explicitContext = await mcpAuth.authenticate(new Request(resource, { headers: { authorization: `Bearer ${explicitToken}` } }));
    expect(await explicitContext?.authorize("thread-d1-auth", "read")).toBe(true);
  } finally {
    await runtime.dispose();
    await rm(persistence, { force: true, recursive: true });
  }
});

test.serial("accepts pre-cutover OAuth state after the canonical origin switch", { timeout: 30_000 }, async () => {
  const persistence = await mkdtemp(join(tmpdir(), "msg-mcp-auth-migration-d1-"));
  const runtime = new Miniflare(convertV4MiniflareOptions({
    compatibilityDate: "2026-08-09",
    d1Databases: { MSG_DB: "msg-mcp-auth-migration-d1" },
    host: "127.0.0.1",
    modules: true,
    name: "msg-mcp-auth-migration-d1",
    port: 0,
    resourcePersistencePath: persistence,
    script: "export default {};",
  }));
  try {
    const { createMcpAuthenticator } = await import("./worker-entry");
    await runtime.ready;
    const database = await runtime.getD1Database("MSG_DB") as unknown as D1DatabaseLike;
    await applyMigrations(database);
    const store = new D1McpAuthStore(database);
    const legacyAuth = new McpAuthService({ issuer: legacyIssuer, resource: legacyResource, store });
    const canonicalAuth = new McpAuthService({ acceptedOrigins: [legacyIssuer], issuer, resource, store });
    const legacyThread = `${legacyIssuer}/thread-cutover`;
    const canonicalThread = `${issuer}/thread-cutover`;

    expect(canonicalAuth.protectedResourceMetadata()).toMatchObject({ resource, authorization_servers: [issuer] });
    expect(canonicalAuth.authorizationServerMetadata()).toMatchObject({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token` });

    const legacyRegistration = await legacyAuth.registerClient(new Request(`${legacyIssuer}/register`, {
      body: JSON.stringify({ client_name: "Legacy OAuth client", redirect_uris: [redirectUri] }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }));
    const legacyClient = await legacyRegistration.json() as { client_id: string };
    const legacyVerifier = "l".repeat(43);
    const legacyPending = await beginAuthorization(legacyAuth, legacyResource, legacyClient.client_id, legacyVerifier, "legacy-live");
    const legacyAllowed = await submitAuthorization(legacyAuth, legacyPending.requestId, legacyPending.csrf, legacyThread, legacyThread, legacyIssuer);
    expect(new URL(legacyAllowed.headers.get("location") ?? redirectUri).searchParams.get("iss")).toBe(legacyIssuer);
    const legacyCode = codeFromLocation(legacyAllowed);
    const legacyTokenResponse = await exchangeCode(legacyAuth, legacyResource, legacyClient.client_id, legacyCode, legacyVerifier);
    expect(legacyTokenResponse.status).toBe(200);
    const legacyTokens = await legacyTokenResponse.json() as { access_token: string; refresh_token: string };
    const legacyPrincipal = await legacyAuth.authenticateBearer(new Request(legacyResource, { headers: { authorization: `Bearer ${legacyTokens.access_token}` } }));
    expect(await store.getGrant(legacyPrincipal.principalId, legacyThread)).toMatchObject({ source: "public", threadUrl: legacyThread });

    // The request is created under the old resource before the cutover and submitted through the new service after it.
    const pendingVerifier = "p".repeat(43);
    const pending = await beginAuthorization(legacyAuth, legacyResource, legacyClient.client_id, pendingVerifier, "legacy-pending");
    const completedAfterSwitch = await submitAuthorization(canonicalAuth, pending.requestId, pending.csrf, legacyThread, legacyThread, legacyIssuer);
    expect(new URL(completedAfterSwitch.headers.get("location") ?? redirectUri).searchParams.get("iss")).toBe(legacyIssuer);
    const pendingCode = codeFromLocation(completedAfterSwitch);
    const pendingTokenResponse = await exchangeCode(canonicalAuth, legacyResource, legacyClient.client_id, pendingCode, pendingVerifier);
    expect(pendingTokenResponse.status).toBe(200);
    const pendingTokens = await pendingTokenResponse.json() as { access_token: string };
    expect((await canonicalAuth.authenticateBearer(new Request(resource, { headers: { authorization: `Bearer ${pendingTokens.access_token}` } }))).scopes).toContain("threads:read");

    const oldBearer = new Request(resource, { headers: { authorization: `Bearer ${legacyTokens.access_token}` } });
    const oldPrincipalAfterSwitch = await canonicalAuth.authenticateBearer(oldBearer);
    expect(await canonicalAuth.validateGrant(oldPrincipalAfterSwitch.principalId, canonicalThread, "read")).toMatchObject({ threadUrl: legacyThread });
    expect(await canonicalAuth.validateGrant(oldPrincipalAfterSwitch.principalId, legacyThread, "read")).toMatchObject({ threadUrl: legacyThread });

    const wrongResource = await tokenStatus(canonicalAuth, new Request(`${issuer}/token`, {
      body: new URLSearchParams({ client_id: legacyClient.client_id, grant_type: "refresh_token", refresh_token: legacyTokens.refresh_token, resource: "https://other.example/mcp" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    }));
    expect(wrongResource).toBe(400);
    const rotatedResponse = await canonicalAuth.token(new Request(`${legacyIssuer}/token`, {
      body: new URLSearchParams({ client_id: legacyClient.client_id, grant_type: "refresh_token", refresh_token: legacyTokens.refresh_token, resource: legacyResource }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    }));
    expect(rotatedResponse.status).toBe(200);
    const rotated = await rotatedResponse.json() as { refresh_token: string };
    const replayed = await tokenStatus(canonicalAuth, new Request(`${legacyIssuer}/token`, {
      body: new URLSearchParams({ client_id: legacyClient.client_id, grant_type: "refresh_token", refresh_token: legacyTokens.refresh_token, resource: legacyResource }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    }));
    expect(replayed).toBe(400);
    const revokedFamily = await tokenStatus(canonicalAuth, new Request(`${legacyIssuer}/token`, {
      body: new URLSearchParams({ client_id: legacyClient.client_id, grant_type: "refresh_token", refresh_token: rotated.refresh_token, resource: legacyResource }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    }));
    expect(revokedFamily).toBe(400);

    const canonicalRegistration = await canonicalAuth.registerClient(new Request(`${issuer}/register`, {
      body: JSON.stringify({ client_name: "Canonical OAuth client", redirect_uris: [redirectUri] }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }));
    const canonicalClient = await canonicalRegistration.json() as { client_id: string };
    const canonicalVerifier = "c".repeat(43);
    const canonicalPending = await beginAuthorization(canonicalAuth, resource, canonicalClient.client_id, canonicalVerifier, "canonical");
    const canonicalAllowed = await submitAuthorization(canonicalAuth, canonicalPending.requestId, canonicalPending.csrf, canonicalThread, canonicalThread, issuer);
    expect(new URL(canonicalAllowed.headers.get("location") ?? redirectUri).searchParams.get("iss")).toBe(issuer);
    const canonicalTokenResponse = await exchangeCode(canonicalAuth, resource, canonicalClient.client_id, codeFromLocation(canonicalAllowed), canonicalVerifier);
    expect(canonicalTokenResponse.status).toBe(200);
    const canonicalTokens = await canonicalTokenResponse.json() as { access_token: string };
    const canonicalPrincipal = await canonicalAuth.authenticateBearer(new Request(resource, { headers: { authorization: `Bearer ${canonicalTokens.access_token}` } }));
    expect(await store.getGrant(canonicalPrincipal.principalId, canonicalThread)).toMatchObject({ source: "public", threadUrl: canonicalThread });

    let publicGrantsAllowed = true;
    const roomService = { roomStatus: async () => ({ active: true, agent_posting_enabled: true, expires_at: "2099-01-01T00:00:00.000Z", latest_message: 1, protocol_version: 1, public_grants_allowed: publicGrantsAllowed }) };
    const mcpAuth = createMcpAuthenticator(canonicalAuth, issuer, roomService as never);
    const publicContext = await mcpAuth.authenticate(new Request(resource, { headers: { authorization: `Bearer ${pendingTokens.access_token}` } }));
    expect(publicContext).not.toBeNull();
    publicGrantsAllowed = false;
    expect(await publicContext?.authorize("thread-cutover", "read")).toBe(false);

    const explicitPrincipalId = "prf_migration_explicit";
    const explicitToken = "x".repeat(43);
    const now = Date.now();
    await store.createPrincipal(explicitPrincipalId, now);
    await store.upsertGrant({ createdAt: now, principalId: explicitPrincipalId, revokedAt: null, scope: "threads:read", source: "explicit", threadUrl: legacyThread });
    await store.createAccessToken({ clientId: legacyClient.client_id, createdAt: now, expiresAt: now + 60_000, principalId: explicitPrincipalId, resource: legacyResource, revokedAt: null, scope: "threads:read", tokenHash: await sha256(explicitToken) });
    const explicitContext = await mcpAuth.authenticate(new Request(resource, { headers: { authorization: `Bearer ${explicitToken}` } }));
    expect(await explicitContext?.authorize("thread-cutover", "read")).toBe(true);
    await database.prepare("UPDATE mcp_oauth_grants SET revoked_at = ? WHERE principal_id = ? AND thread_url = ?").bind(now, explicitPrincipalId, legacyThread).run();
    expect(await canonicalAuth.validateGrant(explicitPrincipalId, canonicalThread, "read")).toBeNull();
    expect(await explicitContext?.authorize("thread-cutover", "read")).toBe(false);
    await store.upsertGrant({ createdAt: now, principalId: explicitPrincipalId, revokedAt: null, scope: "threads:read", source: "explicit", threadUrl: legacyThread });
    expect(await explicitContext?.authorize("thread-cutover", "read")).toBe(true);
    await store.revokePrincipal(legacyPrincipal.principalId, now);
    expect(await canonicalAuth.validateGrant(legacyPrincipal.principalId, canonicalThread, "read")).toBeNull();
    await store.revokePrincipal(explicitPrincipalId, now);
    expect(await explicitContext?.authorize("thread-cutover", "read")).toBe(false);
  } finally {
    await runtime.dispose();
    await rm(persistence, { force: true, recursive: true });
  }
});

async function beginAuthorization(auth: McpAuthService, resourceUrl: string, clientId: string, verifier: string, state: string): Promise<{ readonly requestId: string; readonly csrf: string }> {
  const url = new URL(`${new URL(resourceUrl).origin}/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId,
    code_challenge: await sha256(verifier),
    code_challenge_method: "S256",
    redirect_uri: redirectUri,
    response_type: "code",
    resource: resourceUrl,
    scope: "threads:read",
    state,
  }).toString();
  const response = await auth.authorize(new Request(url), { validateThread: async (candidate) => ({ canonicalUrl: candidate }) });
  expect(response.status).toBe(200);
  const body = await response.text();
  return { requestId: hidden(body, "request_id"), csrf: hidden(body, "csrf") };
}

async function submitAuthorization(auth: McpAuthService, requestId: string, csrf: string, threadUrlValue: string, canonicalUrl: string, origin: string): Promise<Response> {
  return auth.authorize(new Request(`${origin}/authorize`, {
    body: JSON.stringify({ csrf, decision: "allow", grants: [{ scopes: ["threads:read"], thread_url: threadUrlValue }], request_id: requestId }),
    headers: { "content-type": "application/json", origin },
    method: "POST",
  }), { validateThread: async () => ({ canonicalUrl }) });
}

function codeFromLocation(response: Response): string {
  const code = new URL(response.headers.get("location") ?? redirectUri).searchParams.get("code");
  if (!code) throw new Error("The authorization response did not contain a code.");
  return code;
}

async function exchangeCode(auth: McpAuthService, resourceUrl: string, clientId: string, code: string, verifier: string): Promise<Response> {
  return auth.token(new Request(`${new URL(resourceUrl).origin}/token`, {
    body: new URLSearchParams({ client_id: clientId, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri, resource: resourceUrl }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  }));
}

async function tokenStatus(auth: McpAuthService, request: Request): Promise<number> {
  try {
    return (await auth.token(request)).status;
  } catch (error) {
    if (error instanceof McpAuthError) return error.status;
    throw error;
  }
}
