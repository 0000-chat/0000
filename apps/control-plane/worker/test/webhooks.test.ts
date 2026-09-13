import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebhookSubscriptionSchema } from "@communicator/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { VerifiedSubject } from "../auth/oidc";
import {
  createOAuthAccessTokenVerifier,
  signOAuthAccessToken,
  type OAuthRuntimeConfig,
} from "../oauth/tokens";
import {
  clearDirectory,
  seedAccountAccess,
  seedDirectory,
} from "./support/directory-fixtures";

const workerEnv = env as typeof env & { CONTROL_DB: D1Database };
const oauthConfig: OAuthRuntimeConfig = {
  issuer: "https://communicator.example/",
  resource: "https://communicator.example/mcp",
  signingSecret: "webhook-test-signing-secret-012345678901234567890123",
  accessTokenTtlSeconds: 900,
};
const fixedNow = new Date("2026-09-13T00:00:00.000Z");

const app = createApp({
  createTokenVerifier: () => ({
    verify: async (token: string): Promise<VerifiedSubject> => {
      if (token === "human-token") {
        return {
          issuer: "https://issuer.example/",
          subject: "human-subject",
        };
      }
      if (token === "agent-token") {
        return {
          issuer: "https://issuer.example/",
          subject: "agent-subject",
          token_id: "agent-token-id",
        };
      }
      throw new Error("invalid test token");
    },
  }),
  createOAuthAccessTokenVerifier: () =>
    createOAuthAccessTokenVerifier(oauthConfig, { currentDate: fixedNow }),
  oauthConfig: () => oauthConfig,
  oauthClock: () => fixedNow,
});

const request = async (
  path: string,
  init: RequestInit = {},
  token = "human-token",
) =>
  app.request(
    `http://example.test${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    },
    workerEnv,
  );

beforeEach(async () => {
  await clearDirectory(workerEnv.CONTROL_DB);
  await seedDirectory(workerEnv.CONTROL_DB);
  await seedAccountAccess(workerEnv.CONTROL_DB);
  await workerEnv.CONTROL_DB.batch([
    workerEnv.CONTROL_DB.prepare(
      "INSERT INTO oauth_clients (client_id, client_name, redirect_uri, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
    ).bind(
      "webhook-test-client",
      "Webhook test client",
      "https://client.example/callback",
      fixedNow.toISOString(),
      fixedNow.toISOString(),
    ),
    workerEnv.CONTROL_DB.prepare(
      "INSERT INTO oauth_client_installations (id, client_id, redirect_uri, resource, human_issuer, human_subject, tenant_id, membership_id, principal_id, identity_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
    ).bind(
      "installation_agent",
      "webhook-test-client",
      "https://client.example/callback",
      oauthConfig.resource,
      "https://issuer.example/",
      "human-subject",
      "tenant_pilot",
      "membership_agent",
      "principal_agent",
      "identity_agent",
      fixedNow.toISOString(),
      fixedNow.toISOString(),
    ),
  ]);
});

const installationToken = async (scope = "communicator.read") =>
  signOAuthAccessToken(oauthConfig, {
    installationId: "installation_agent",
    clientId: "webhook-test-client",
    subject: "principal_agent",
    scope,
    issuer: oauthConfig.issuer,
    resource: oauthConfig.resource,
    tokenId: `webhook-token-${crypto.randomUUID()}`,
    issuedAt: fixedNow,
    expiresAt: new Date(fixedNow.getTime() + 300_000),
  });

describe("webhook subscription production entrypoints", () => {
  it("creates through the API, evaluates precedence, and reads the same result through MCP", async () => {
    const create = await request("/api/v1/webhook-subscriptions", {
      method: "POST",
      body: JSON.stringify({
        destination: {
          url: "https://hooks.example.test/one",
          credential_ref: "deploy-ref-one",
        },
        event_filter: { event_types: ["message.created", "message.updated"] },
        global_enabled: false,
        account_rules: [{ account_id: "account_human", enabled: false }],
        chat_rules: [
          { account_id: "account_human", chat_id: "chat_one", enabled: true },
        ],
        idempotency_key: "webhook-flow-create",
      }),
    });
    expect(create.status).toBe(201);
    const subscription = WebhookSubscriptionSchema.parse(await create.json());
    expect(subscription.destination_version).toBe(1);
    expect(subscription.destination.credential_ref).toBe("deploy-ref-one");

    const chat = await request(
      `/api/v1/webhook-subscriptions/${subscription.id}/evaluate?account_id=account_human&chat_id=chat_one`,
    );
    expect(chat.status).toBe(200);
    await expect(chat.json()).resolves.toMatchObject({
      enabled: true,
      source: "chat",
    });

    const account = await request(
      `/api/v1/webhook-subscriptions/${subscription.id}/evaluate?account_id=account_human&chat_id=chat_two`,
    );
    expect(account.status).toBe(200);
    await expect(account.json()).resolves.toMatchObject({
      enabled: false,
      source: "account",
    });

    const mcpTransport = new StreamableHTTPClientTransport(
      new URL("http://example.test/mcp"),
      {
        requestInit: {
          headers: { Authorization: "Bearer human-token" },
        },
        fetch: async (input, init) => {
          const url = input instanceof URL ? input.href : input.toString();
          return app.request(url, init, workerEnv);
        },
      },
    );
    const mcp = new Client({ name: "webhook-flow-test", version: "1.0.0" });
    await mcp.connect(
      mcpTransport as unknown as Parameters<Client["connect"]>[0],
    );
    const tools = await mcp.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "evaluate_webhook_subscription",
    );
    const mcpCreated = await mcp.callTool({
      name: "create_webhook_subscription",
      arguments: {
        destination: { url: "https://hooks.example.test/mcp" },
        account_rules: [{ account_id: "account_human", enabled: true }],
        idempotency_key: "webhook-mcp-create",
      },
    });
    expect(mcpCreated.isError).not.toBe(true);
    const mcpCreatedPayload = mcpCreated as unknown as {
      structuredContent?: { id?: string };
    };
    expect(mcpCreatedPayload.structuredContent?.id).toMatch(/^webhook_/);
    const mcpInspected = await mcp.callTool({
      name: "get_webhook_subscription",
      arguments: { subscription_id: mcpCreatedPayload.structuredContent?.id },
    });
    expect(mcpInspected.isError).not.toBe(true);
    const result = await mcp.callTool({
      name: "evaluate_webhook_subscription",
      arguments: {
        subscription_id: subscription.id,
        account_id: "account_human",
        chat_id: "chat_one",
      },
    });
    expect(result.isError).not.toBe(true);
    const mcpPayload = result as unknown as {
      content?: Array<{ text?: string }>;
    };
    const mcpContent = mcpPayload.content?.[0];
    expect(JSON.parse(String(mcpContent?.text))).toMatchObject({
      enabled: true,
      source: "chat",
    });
    await mcp.close();
  });

  it("keeps subscriptions independent, requires webhook management, and cancels only the cut over work", async () => {
    const create = async (key: string, globalEnabled: boolean) => {
      const response = await request("/api/v1/webhook-subscriptions", {
        method: "POST",
        body: JSON.stringify({
          destination: { url: `https://hooks.example.test/${key}` },
          global_enabled: globalEnabled,
          account_rules: [],
          chat_rules: [],
          idempotency_key: key,
        }),
      });
      expect(response.status).toBe(201);
      return WebhookSubscriptionSchema.parse(await response.json());
    };
    const first = await create("webhook-independent-one", false);
    const second = await create("webhook-independent-two", true);

    await workerEnv.CONTROL_DB.batch([
      workerEnv.CONTROL_DB.prepare(
        "INSERT INTO webhook_deliveries (id, tenant_id, subscription_id, source_event_id, destination_version, status, first_pending_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
      ).bind(
        "delivery_first",
        "tenant_pilot",
        first.id,
        "source-one",
        1,
        "2026-09-13T00:00:00.000Z",
      ),
      workerEnv.CONTROL_DB.prepare(
        "INSERT INTO webhook_deliveries (id, tenant_id, subscription_id, source_event_id, destination_version, status, first_pending_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
      ).bind(
        "delivery_second",
        "tenant_pilot",
        second.id,
        "source-two",
        1,
        "2026-09-13T00:00:00.000Z",
      ),
    ]);

    // The agent assertion below proves read grants alone cannot create or
    // inspect this state.
    const agentDenied = await app.request(
      "http://example.test/api/v1/webhook-subscriptions",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer agent-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          destination: { url: "https://hooks.example.test/agent" },
          account_rules: [{ account_id: "account_agent", enabled: true }],
          idempotency_key: "webhook-agent-denied-real",
        }),
      },
      workerEnv,
    );
    expect(agentDenied.status).toBe(403);

    const cutover = await request(
      `/api/v1/webhook-subscriptions/${first.id}/cutover`,
      {
        method: "POST",
        body: JSON.stringify({
          destination: { url: "https://hooks.example.test/one-new" },
          idempotency_key: "webhook-independent-cutover",
        }),
      },
    );
    expect(cutover.status).toBe(200);
    expect(
      ((await cutover.json()) as { destination_version: number })
        .destination_version,
    ).toBe(2);
    const deliveriesAfterCutover = await workerEnv.CONTROL_DB.prepare(
      "SELECT subscription_id, destination_version, status FROM webhook_deliveries ORDER BY id",
    ).all<{
      subscription_id: string;
      destination_version: number;
      status: string;
    }>();
    expect(deliveriesAfterCutover.results).toEqual([
      {
        subscription_id: first.id,
        destination_version: 1,
        status: "cancelled",
      },
      { subscription_id: second.id, destination_version: 1, status: "pending" },
    ]);

    const revoke = await request(`/api/v1/webhook-subscriptions/${first.id}`, {
      method: "DELETE",
      body: JSON.stringify({ idempotency_key: "webhook-independent-revoke" }),
    });
    expect(revoke.status).toBe(200);
    expect(((await revoke.json()) as { status: string }).status).toBe(
      "revoked",
    );
    const secondInspection = await request(
      `/api/v1/webhook-subscriptions/${second.id}`,
    );
    expect(secondInspection.status).toBe(200);
    expect(((await secondInspection.json()) as { status: string }).status).toBe(
      "active",
    );
  });

  it("keeps OAuth installation ownership separate from the human and uses shared mode without a Bot claim", async () => {
    const token = await installationToken(
      "communicator.read communicator.webhook.manage",
    );
    const denied = await request(
      "/api/v1/webhook-subscriptions",
      {
        method: "POST",
        body: JSON.stringify({
          destination: { url: "https://hooks.example.test/oauth-denied" },
          account_rules: [{ account_id: "account_agent", enabled: true }],
          idempotency_key: "webhook-oauth-denied",
        }),
      },
      token,
    );
    expect(denied.status).toBe(403);

    await workerEnv.CONTROL_DB.prepare(
      "INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'webhook.manage', 'all_chats', 'active', ?, ?)",
    )
      .bind(
        "grant_webhook_agent",
        "tenant_pilot",
        "membership_agent",
        "identity_agent",
        "account_agent",
        fixedNow.toISOString(),
        fixedNow.toISOString(),
      )
      .run();

    const created = await request(
      "/api/v1/webhook-subscriptions",
      {
        method: "POST",
        body: JSON.stringify({
          destination: { url: "https://hooks.example.test/oauth-shared" },
          account_rules: [{ account_id: "account_agent", enabled: true }],
          idempotency_key: "webhook-oauth-shared",
        }),
      },
      token,
    );
    expect(created.status).toBe(201);
    const subscription = WebhookSubscriptionSchema.parse(await created.json());
    expect(subscription.owner_installation_id).toBe("installation_agent");
    expect(subscription.owner_principal_id).toBe("principal_agent");
    expect(subscription.ownership_mode).toBe("shared_installation");
    expect(subscription.logical_agent_id).toBeNull();

    const inspected = await request(
      `/api/v1/webhook-subscriptions/${subscription.id}`,
      {},
      token,
    );
    expect(inspected.status).toBe(200);
    expect(
      ((await inspected.json()) as { owner_principal_id: string })
        .owner_principal_id,
    ).toBe("principal_agent");

    const transferred = await request(
      `/api/v1/webhook-subscriptions/${subscription.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          owner_installation_id: null,
          logical_agent_id: null,
          idempotency_key: "webhook-oauth-transfer",
        }),
      },
    );
    expect(transferred.status).toBe(200);
    expect(
      ((await transferred.json()) as { ownership_mode: string }).ownership_mode,
    ).toBe("administrator");
    const afterTransfer = await request(
      `/api/v1/webhook-subscriptions/${subscription.id}`,
      {},
      token,
    );
    expect(afterTransfer.status).toBe(403);

    await workerEnv.CONTROL_DB.prepare(
      "UPDATE oauth_client_installations SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?",
    )
      .bind(
        fixedNow.toISOString(),
        fixedNow.toISOString(),
        "installation_agent",
      )
      .run();
    const revokedInstallation = await request(
      `/api/v1/webhook-subscriptions/${subscription.id}`,
      {},
      token,
    );
    expect(revokedInstallation.status).toBe(401);
    const administratorRecovery = await request(
      `/api/v1/webhook-subscriptions/${subscription.id}`,
    );
    expect(administratorRecovery.status).toBe(200);
    const audit = await workerEnv.CONTROL_DB.prepare(
      "SELECT action FROM audit_events WHERE target_type = 'webhook_subscription' AND target_id = ? ORDER BY occurred_at, id",
    )
      .bind(subscription.id)
      .all<{ action: string }>();
    expect(audit.results.map((row) => row.action)).toEqual([
      "webhook.subscription.created",
      "webhook.subscription.updated",
    ]);
  });
});
