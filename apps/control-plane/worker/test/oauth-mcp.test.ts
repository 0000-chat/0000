import { env, runInDurableObject } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { VerifiedSubject } from "../auth/oidc";
import {
  createOAuthAccessTokenVerifier,
  type OAuthRuntimeConfig,
} from "../oauth/tokens";
import { randomBase64url, sha256Base64url } from "../oauth/crypto";
import { completeConfiguredOAuthUpstreamLogin } from "../oauth/upstream";
import {
  auth,
  bindingFor,
  event,
  initialize,
} from "./projection/projector-test-support";
import {
  clearDirectory,
  seedAccountAccess,
  seedDirectory,
} from "./support/directory-fixtures";

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

const createDefaultUpstreamApp = (fetcher: typeof fetch) =>
  createApp({
    oauthConfig: () => ({
      ...config,
      humanTokenUrl: "https://idp.example/token",
      humanIssuer: humanSession.issuer,
      humanJwksUrl: "https://idp.example/jwks",
      humanAudience: "communicator-client",
    }),
    oauthClock: () => fixedNow,
    fetchOAuthUpstream: fetcher,
  });

const makeCodeChallenge = async (verifier: string) => sha256Base64url(verifier);

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
      bindingFor(
        "account_human",
        "connection_human_whatsapp",
        "identity_human",
      ),
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

async function requestToken(
  app: ReturnType<typeof createApp>,
  token: string,
  init: RequestInit = {},
) {
  return app.request(
    "https://communicator.example/mcp",
    {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
    },
    workerEnv,
  );
}

async function requestApi(
  app: ReturnType<typeof createApp>,
  token: string,
  path: string,
  init: RequestInit = {},
) {
  return app.request(
    `https://communicator.example${path}`,
    {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
    },
    workerEnv,
  );
}

const connectMcpClient = async (
  app: ReturnType<typeof createApp>,
  token: string,
) => {
  const client = new Client({
    name: "oauth-mcp-test-client",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(
    new URL("https://communicator.example/mcp"),
    {
      requestInit: {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://communicator.example",
        },
      },
      fetch: async (input, init) => {
        const url = input instanceof URL ? input.href : input.toString();
        return app.request(url, init, workerEnv);
      },
    },
  );
  await client.connect(
    transport as unknown as Parameters<Client["connect"]>[0],
  );
  return { client, transport };
};

describe("OAuth authorization code and shared MCP read boundary", () => {
  beforeEach(async () => {
    await clearDirectory(workerEnv.CONTROL_DB);
    await seedDirectory(workerEnv.CONTROL_DB);
    await seedAccountAccess(workerEnv.CONTROL_DB);
    await workerEnv.CONTROL_DB.batch([
      workerEnv.CONTROL_DB.prepare("DELETE FROM oauth_authorization_codes"),
      workerEnv.CONTROL_DB.prepare(
        "DELETE FROM oauth_authorization_transactions",
      ),
      workerEnv.CONTROL_DB.prepare(
        "DELETE FROM oauth_upstream_login_transactions",
      ),
      workerEnv.CONTROL_DB.prepare("DELETE FROM oauth_client_installations"),
      workerEnv.CONTROL_DB.prepare("DELETE FROM oauth_clients"),
      workerEnv.CONTROL_DB.prepare(
        "INSERT INTO oauth_clients (client_id, client_name, redirect_uri, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
      ).bind(
        clientId,
        "ChatGPT Work test",
        redirectUri,
        fixedNow.toISOString(),
        fixedNow.toISOString(),
      ),
    ]);
  });

  it("completes the configured upstream code exchange and verifies the ID token with default app wiring", async () => {
    const keyPair = await generateKeyPair("ES256");
    const publicJwk = await exportJWK(keyPair.publicKey);
    publicJwk.kid = "upstream-test-key";
    publicJwk.alg = "ES256";
    publicJwk.use = "sig";
    const upstreamApp = createDefaultUpstreamApp(async (input, init) => {
      const url = input.toString();
      if (url === "https://idp.example/jwks") {
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://idp.example/token") {
        expect(new Headers(init?.headers).get("Authorization")).toBeNull();
        const body = await new Request(input, init).text();
        const form = new URLSearchParams(body);
        expect(form.get("code")).toBe("upstream-code");
        expect(form.get("code_verifier")).toBeTruthy();
        const nonce = form.get("code_verifier");
        const idToken = await new SignJWT({ nonce: upstreamNonce })
          .setProtectedHeader({ alg: "ES256", kid: "upstream-test-key" })
          .setIssuer(humanSession.issuer)
          .setAudience("communicator-client")
          .setSubject(humanSession.subject)
          .setIssuedAt(Math.floor(fixedNow.getTime() / 1000))
          .setExpirationTime(Math.floor(fixedNow.getTime() / 1000) + 300)
          .sign(keyPair.privateKey);
        expect(nonce).toBeTruthy();
        return new Response(JSON.stringify({ id_token: idToken }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    });
    let upstreamNonce = "";
    const verifier = randomBase64url(48);
    const state = randomBase64url(24);
    const challenge = await makeCodeChallenge(verifier);
    const authorization = await upstreamApp.request(
      `https://communicator.example/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(resource)}&scope=communicator.read`,
      {},
      workerEnv,
    );
    expect(authorization.status).toBe(302);
    const upstreamLocation = new URL(
      authorization.headers.get("location") ?? "",
    );
    upstreamNonce = upstreamLocation.searchParams.get("nonce") ?? "";
    expect(upstreamNonce).toMatch(/^[A-Za-z0-9_-]+$/);

    const callback = await upstreamApp.request(
      `https://communicator.example/oauth/callback?state=${encodeURIComponent(upstreamLocation.searchParams.get("state") ?? "")}&code=upstream-code`,
      {},
      workerEnv,
    );
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain("Authorize ChatGPT Work test");
  });

  it("rejects a configured upstream ID token without an expiration claim", async () => {
    const keyPair = await generateKeyPair("ES256");
    const publicJwk = await exportJWK(keyPair.publicKey);
    publicJwk.kid = "upstream-exp-required-key";
    publicJwk.alg = "ES256";
    publicJwk.use = "sig";
    const idToken = await new SignJWT({ nonce: "expected-nonce" })
      .setProtectedHeader({ alg: "ES256", kid: "upstream-exp-required-key" })
      .setIssuer(humanSession.issuer)
      .setAudience("communicator-client")
      .setSubject(humanSession.subject)
      .setIssuedAt(Math.floor(fixedNow.getTime() / 1000))
      .sign(keyPair.privateKey);
    const result = await completeConfiguredOAuthUpstreamLogin(
      {
        request: new Request("https://communicator.example/oauth/callback"),
        env: workerEnv,
        authorizationCode: "upstream-code",
        verifier: "upstream-verifier",
        nonce: "expected-nonce",
        clientId,
        redirectUri: config.humanRedirectUri ?? "",
      },
      {
        ...config,
        humanTokenUrl: "https://idp.example/token",
        humanIssuer: humanSession.issuer,
        humanJwksUrl: "https://idp.example/jwks",
        humanAudience: "communicator-client",
      },
      async (input, init) => {
        if (input.toString() === "https://idp.example/jwks") {
          return new Response(JSON.stringify({ keys: [publicJwk] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        expect(input.toString()).toBe("https://idp.example/token");
        expect(new Headers(init?.headers).get("Authorization")).toBeNull();
        return new Response(JSON.stringify({ id_token: idToken }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      fixedNow,
    );
    expect(result).toBeNull();
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
    const upstreamLocation = new URL(
      authorization.headers.get("location") ?? "",
    );
    expect(upstreamLocation.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(upstreamLocation.searchParams.get("client_id")).toBe(
      "communicator-client",
    );

    const callback = await app.request(
      `https://communicator.example/oauth/callback?state=${encodeURIComponent(upstreamLocation.searchParams.get("state") ?? "")}&code=upstream-code`,
      {},
      workerEnv,
    );
    expect(callback.status).toBe(200);
    expect(upstream.value).toBeDefined();
    const consentHtml = await callback.text();
    const transactionId = /name="transaction_id" value="([^"]+)"/.exec(
      consentHtml,
    )?.[1];
    const consentToken = /name="consent_token" value="([^"]+)"/.exec(
      consentHtml,
    )?.[1];
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
    expect(callbackLocation.origin + callbackLocation.pathname).toBe(
      redirectUri,
    );
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
    ).first<{
      id: string;
      membership_id: string;
      identity_id: string;
      principal_id: string;
    }>();
    expect(installation).toBeTruthy();
    const principal = await workerEnv.CONTROL_DB.prepare(
      "SELECT principal_type FROM principals WHERE id = ?",
    )
      .bind(installation?.principal_id ?? "")
      .first<{ principal_type: string }>();
    expect(principal?.principal_type).toBe("agent");
    expect(
      await workerEnv.CONTROL_DB.prepare(
        "SELECT role FROM memberships WHERE id = ?",
      )
        .bind(installation?.membership_id ?? "")
        .first<{ role: string }>(),
    ).toEqual({ role: "member" });
    expect(
      await workerEnv.CONTROL_DB.prepare(
        "SELECT COUNT(*) AS count FROM account_grants WHERE membership_id = ?",
      )
        .bind(installation?.membership_id ?? "")
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });

    const { client, transport } = await connectMcpClient(
      app,
      tokenBody.access_token,
    );
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("list_accounts");
    const denied = await client.callTool({
      name: "list_conversations",
      arguments: {
        identity_id: installation?.identity_id,
        account_id: "account_human",
      },
    });
    expect(denied.isError).toBe(true);
    expect(denied.content).toEqual([
      { type: "text", text: expect.stringContaining("forbidden") },
    ]);
    const apiDenied = await requestApi(
      app,
      tokenBody.access_token,
      `/api/v1/accounts/account_human/conversations?identity_id=${installation?.identity_id}`,
    );
    expect(apiDenied.status).toBe(403);
    expect(await apiDenied.json()).toMatchObject({
      error: { code: "forbidden" },
    });
    const wrongTenant = await requestToken(app, tokenBody.access_token, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "X-Communicator-Tenant": "tenant_other",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    });
    expect(wrongTenant.status).toBe(401);
    const badOrigin = await requestToken(app, tokenBody.access_token, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        Origin: "https://evil.example",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    });
    expect(badOrigin.status).toBe(403);

    const overlappingVerifierApp = createApp({
      createTokenVerifier: () => ({
        verify: async () => ({
          issuer: humanSession.issuer,
          subject: humanSession.subject,
        }),
      }),
      createOAuthAccessTokenVerifier: () =>
        createOAuthAccessTokenVerifier(config, { currentDate: fixedNow }),
      oauthConfig: () => config,
      oauthClock: () => fixedNow,
    });
    const overlap = await requestApi(
      overlappingVerifierApp,
      tokenBody.access_token,
      "/api/v1/accounts?identity_id=identity_human",
    );
    expect(overlap.status).toBe(403);

    await workerEnv.CONTROL_DB.prepare(
      "INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'conversation.read', 'all_chats', 'active', ?, ?)",
    )
      .bind(
        "grant_oauth_installation",
        tenantId,
        installation?.membership_id ?? "",
        installation?.identity_id ?? "",
        "account_human",
        fixedNow.toISOString(),
        fixedNow.toISOString(),
      )
      .run();
    await seedProjection();
    const accounts = await client.callTool({
      name: "list_accounts",
      arguments: { identity_id: installation?.identity_id },
    });
    expect(accounts.isError).not.toBe(true);
    expect(
      (
        accounts.structuredContent as { items: Array<{ account_id: string }> }
      ).items.map((item) => item.account_id),
    ).toEqual(["account_human"]);
    const allowed = await client.callTool({
      name: "list_conversations",
      arguments: {
        identity_id: installation?.identity_id,
        account_id: "account_human",
      },
    });
    expect(allowed.isError).not.toBe(true);
    expect(
      (allowed.structuredContent as { items: Array<{ id: string }> }).items.map(
        (item) => item.id,
      ),
    ).toEqual(["conversation_oauth"]);
    const apiAllowed = await requestApi(
      app,
      tokenBody.access_token,
      `/api/v1/accounts/account_human/conversations?identity_id=${installation?.identity_id}`,
    );
    expect(apiAllowed.status).toBe(200);
    expect(
      ((await apiAllowed.json()) as { items: Array<{ id: string }> }).items.map(
        (item) => item.id,
      ),
    ).toEqual(
      (allowed.structuredContent as { items: Array<{ id: string }> }).items.map(
        (item) => item.id,
      ),
    );
    await client.close();
    await transport.close();
  });
});
