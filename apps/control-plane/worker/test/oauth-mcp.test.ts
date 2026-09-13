import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { VerifiedSubject } from "../auth/oidc";
import {
  createOAuthAccessTokenVerifier,
  type OAuthRuntimeConfig,
} from "../oauth/tokens";
import { randomBase64url, sha256Base64url } from "../oauth/crypto";
import {
  auth,
  bindingFor,
  event,
  initialize,
} from "./projection/projector-test-support";
import { clearDirectory, seedAccountAccess, seedDirectory } from "./support/directory-fixtures";

const workerEnv = env as typeof env & { CONTROL_DB: D1Database };
const tenantId = "tenant_pilot";
const resource = "https://communicator.example/mcp";
const clientId = "chatgpt-work-test";
const redirectUri = "https://client.example/callback";
const fixedNow = new Date("2026-09-13T00:00:00.000Z");
const config: OAuthRuntimeConfig = {
  issuer: "https://communicator.example/",
  resource,
  signingSecret: "oauth-test-signing-secret-012345678901234567890123",
  accessTokenTtlSeconds: 900,
  humanAuthorizeUrl: "https://idp.example/authorize",
  humanClientId: "communicator-client",
  humanRedirectUri: "https://communicator.example/oauth/callback",
};

const humanSession = {
  issuer: "https://issuer.example/",
  subject: "human-subject",
  tenantId,
  membershipId: "membership_human",
  principalId: "principal_human",
};

const createTestApp = (upstreamVerifier: { value: string | undefined }) =>
  createApp({
    createTokenVerifier: () => ({
      verify: async (_token: string): Promise<VerifiedSubject> => {
        throw new Error("not a human bearer");
      },
    }),
    createOAuthAccessTokenVerifier: () =>
      createOAuthAccessTokenVerifier(config, { currentDate: fixedNow }),
    oauthConfig: () => config,
    oauthClock: () => fixedNow,
    resolveOAuthHumanSession: async () => null,
    completeOAuthUpstreamLogin: async (input) => {
      upstreamVerifier.value = input.verifier;
      expect(input.authorizationCode).toBe("upstream-code");
      expect(input.nonce).toMatch(/^[A-Za-z0-9_-]+$/);
      return humanSession;
    },
  });

const makeCodeChallenge = async (verifier: string) =>
  sha256Base64url(verifier);

async function seedProjection(): Promise<void> {
  const stub = workerEnv.TENANT_PROJECTION.getByName(tenantId);
  await initialize(tenantId);
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec("UPDATE projection_meta SET state = 'ready'");
  });
  await stub.applyBatch({
    schema_version: 1,
    tenant_id: tenantId,
    authorization: auth(["projection.write"], ["identity_human"], tenantId),
    mode: "live",
    rebuild_id: null,
    connections: [
      bindingFor("account_human", "connection_human_whatsapp", "identity_human"),
    ],
    events: [
      event(
        "oauth_read_shell",
        { title: "OAuth conversation", archived: false, muted: false },
        "conversation.updated",
        {
          tenant_id: tenantId,
          identity_id: "identity_human",
          account_id: "account_human",
          conversation_id: "conversation_oauth",
          occurred_at: "2026-09-13T00:01:00.000Z",
          observed_at: "2026-09-13T00:01:01.000Z",
        },
      ),
    ],
    checkpoint: null,
  });
}

async function requestToken(app: ReturnType<typeof createApp>, token: string, init: RequestInit = {}) {
  return app.request(
    "https://communicator.example/mcp",
    {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
    },
    workerEnv,
  );
}

describe("OAuth authorization code and shared MCP read boundary", () => {
  beforeEach(async () => {
    await clearDirectory(workerEnv.CONTROL_DB);
    await seedDirectory(workerEnv.CONTROL_DB);
    await seedAccountAccess(workerEnv.CONTROL_DB);
    await workerEnv.CONTROL_DB.batch([
      workerEnv.CONTROL_DB.prepare("DELETE FROM oauth_authorization_codes"),
      workerEnv.CONTROL_DB.prepare("DELETE FROM oauth_authorization_transactions"),
      workerEnv.CONTROL_DB.prepare("DELETE FROM oauth_upstream_login_transactions"),
      workerEnv.CONTROL_DB.prepare("DELETE FROM oauth_client_installations"),
      workerEnv.CONTROL_DB.prepare("DELETE FROM oauth_clients"),
      workerEnv.CONTROL_DB.prepare(
        "INSERT INTO oauth_clients (client_id, client_name, redirect_uri, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
      ).bind(clientId, "ChatGPT Work test", redirectUri, fixedNow.toISOString(), fixedNow.toISOString()),
    ]);
  });

  it("completes browser login, creates a non-admin installation, denies then reads after a local grant", async () => {
    const upstream = { value: undefined as string | undefined };
    const app = createTestApp(upstream);
    const verifier = randomBase64url(48);
    const state = randomBase64url(24);
    const challenge = await makeCodeChallenge(verifier);
    const authorization = await app.request(
      `https://communicator.example/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(resource)}&scope=communicator.read`,
      {},
      workerEnv,
    );
    expect(authorization.status).toBe(302);
    const upstreamLocation = new URL(authorization.headers.get("location") ?? "");
    expect(upstreamLocation.searchParams.get("code_challenge_method")).toBe("S256");
    expect(upstreamLocation.searchParams.get("client_id")).toBe("communicator-client");

    const callback = await app.request(
      `https://communicator.example/oauth/callback?state=${encodeURIComponent(upstreamLocation.searchParams.get("state") ?? "")}&code=upstream-code`,
      {},
      workerEnv,
    );
    expect(callback.status).toBe(200);
    expect(upstream.value).toBeDefined();
    const consentHtml = await callback.text();
    const transactionId = /name="transaction_id" value="([^"]+)"/.exec(consentHtml)?.[1];
    const consentToken = /name="consent_token" value="([^"]+)"/.exec(consentHtml)?.[1];
    expect(consentHtml).toContain("Authorize ChatGPT Work test");
    expect(transactionId).toBeTruthy();
    expect(consentToken).toBeTruthy();
    const consent = await app.request(
      "https://communicator.example/oauth/consent",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          transaction_id: transactionId ?? "",
          consent_token: consentToken ?? "",
          action: "approve",
        }),
      },
      workerEnv,
    );
    expect(consent.status).toBe(302);
    const callbackLocation = new URL(consent.headers.get("location") ?? "");
    expect(callbackLocation.origin + callbackLocation.pathname).toBe(redirectUri);
    expect(callbackLocation.searchParams.get("state")).toBe(state);
    const code = callbackLocation.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenResponse = await app.request(
      "https://communicator.example/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code ?? "",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          resource,
        }),
      },
      workerEnv,
    );
    expect(tokenResponse.status).toBe(200);
    const tokenBody = (await tokenResponse.json()) as { access_token: string };
    expect(tokenBody.access_token).toBeTruthy();

    const installation = await workerEnv.CONTROL_DB.prepare(
      "SELECT id, membership_id, identity_id, principal_id FROM oauth_client_installations LIMIT 1",
    ).first<{ id: string; membership_id: string; identity_id: string; principal_id: string }>();
    expect(installation).toBeTruthy();
    const principal = await workerEnv.CONTROL_DB.prepare(
      "SELECT principal_type FROM principals WHERE id = ?",
    ).bind(installation?.principal_id ?? "").first<{ principal_type: string }>();
    expect(principal?.principal_type).toBe("agent");
    expect(
      await workerEnv.CONTROL_DB.prepare("SELECT role FROM memberships WHERE id = ?")
        .bind(installation?.membership_id ?? "")
        .first<{ role: string }>(),
    ).toEqual({ role: "member" });
    expect(
      await workerEnv.CONTROL_DB.prepare("SELECT COUNT(*) AS count FROM account_grants WHERE membership_id = ?")
        .bind(installation?.membership_id ?? "")
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });

    const denied = await requestToken(app, tokenBody.access_token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "list_conversations",
          arguments: { identity_id: installation?.identity_id, account_id: "account_human" },
        },
      }),
    });
    expect(denied.status).toBe(200);
    expect((await denied.json()) as Record<string, unknown>).toMatchObject({
      result: { isError: true, content: [{ text: expect.stringContaining("forbidden") }] },
    });

    await workerEnv.CONTROL_DB.prepare(
      "INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'conversation.read', 'all_chats', 'active', ?, ?)",
    ).bind(
      "grant_oauth_installation",
      tenantId,
      installation?.membership_id ?? "",
      installation?.identity_id ?? "",
      "account_human",
      fixedNow.toISOString(),
      fixedNow.toISOString(),
    ).run();
    await seedProjection();
    const allowed = await requestToken(app, tokenBody.access_token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "list_conversations",
          arguments: { identity_id: installation?.identity_id, account_id: "account_human" },
        },
      }),
    });
    expect(allowed.status).toBe(200);
    const allowedBody = (await allowed.json()) as { result: { structuredContent: { items: Array<{ id: string }> } } };
    expect(allowedBody.result.structuredContent.items.map((item) => item.id)).toEqual([
      "conversation_oauth",
    ]);
  });
});
