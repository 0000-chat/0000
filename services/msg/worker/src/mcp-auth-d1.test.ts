import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readD1Migrations } from "../../../platform/node_modules/@cloudflare/vitest-plugin";
import { convertV4MiniflareOptions, Miniflare } from "../../../platform/node_modules/miniflare";
import { expect, mock, test } from "bun:test";

import { McpAuthService } from "./mcp-auth";
import { D1McpAuthStore } from "./mcp-auth-store";
import type { D1DatabaseLike } from "./operations";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: unknown;
    constructor(ctx: unknown) { this.ctx = ctx; }
  },
}));

const issuer = "https://msg.0000.chat";
const resource = `${issuer}/mcp`;
const threadUrl = `${issuer}/thread-d1-auth`;
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
    const auth = new McpAuthService({ issuer, resource, store });

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
    const allowed = await auth.authorize(new Request(`${issuer}/authorize`, {
      body: JSON.stringify({ csrf, decision: "allow", grants: [{ scopes: ["threads:read"], thread_url: threadUrl }], request_id: requestId }),
      headers: { "content-type": "application/json" },
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
    const grant = await store.getGrant(principal.principalId, threadUrl);
    expect(grant).toMatchObject({ source: "public", scope: "threads:read", threadUrl });

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
      await auth.authorize(new Request(`${issuer}/authorize`, {
        body: JSON.stringify({ csrf: deniedCsrf, decision: "allow", grants: [{ scopes: ["threads:read"], thread_url: threadUrl }], request_id: deniedRequestId }),
        headers: { "content-type": "application/json" },
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
    await store.upsertGrant({ createdAt: now, principalId: explicitPrincipalId, revokedAt: null, scope: "threads:read", source: "explicit", threadUrl });
    await store.createAccessToken({ clientId: client.client_id, createdAt: now, expiresAt: now + 60_000, principalId: explicitPrincipalId, resource, revokedAt: null, scope: "threads:read", tokenHash: await sha256(explicitToken) });
    const explicitContext = await mcpAuth.authenticate(new Request(resource, { headers: { authorization: `Bearer ${explicitToken}` } }));
    expect(await explicitContext?.authorize("thread-d1-auth", "read")).toBe(true);
  } finally {
    await runtime.dispose();
    await rm(persistence, { force: true, recursive: true });
  }
});
