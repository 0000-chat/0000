import { env, runInDurableObject } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  AccountGrantSchema,
  ApiErrorResponseSchema,
  ConnectedAccountPageSchema,
  ConnectionSchema,
  ConversationPageResultSchema,
} from "@communicator/contracts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppServices } from "../app";
import type { VerifiedSubject } from "../auth/oidc";
import {
  auth,
  bindingFor,
  event,
  initialize,
  rows,
} from "./projection/projector-test-support";
import { clearDirectory, seedDirectory } from "./support/directory-fixtures";

const workerEnv = env as typeof env & { CONTROL_DB: D1Database };
const tenantId = "tenant_pilot";

const createTestApp = (services: AppServices = {}) =>
  createApp({
    ...services,
    createTokenVerifier: () => ({
      verify: async (token: string): Promise<VerifiedSubject> => {
        if (token === "human-token")
          return {
            issuer: "https://issuer.example/",
            subject: "human-subject",
          };
        if (token === "agent-token")
          return {
            issuer: "https://issuer.example/",
            subject: "agent-subject",
            token_id: "agent-token-id",
          };
        if (token === "service-token")
          return {
            issuer: "https://issuer.example/",
            subject: "service-subject",
            token_id: "service-token-id",
          };
        throw new Error("invalid local test token");
      },
    }),
  });

const requestForApp = async (
  app: ReturnType<typeof createApp>,
  path: string,
  token = "human-token",
  init: RequestInit = {},
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

const request = async (
  path: string,
  token = "human-token",
  init: RequestInit = {},
) => requestForApp(createTestApp(), path, token, init);

const connectMcpClient = async (
  app: ReturnType<typeof createApp>,
  token: string,
) => {
  const client = new Client({
    name: "durable-acceptance-test-client",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://example.test/mcp"),
    {
      requestInit: {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "http://example.test",
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

const grantBody = (overrides: Record<string, unknown> = {}) => ({
  membership_id: "membership_human",
  identity_id: "identity_human",
  account_id: "account_human",
  operation_scope: "conversation.read",
  chat_scope: "selected_chats",
  chat_ids: ["conversation_human_one"],
  idempotency_key: `grant-test-${crypto.randomUUID()}`,
  ...overrides,
});

async function insertAccounts() {
  await workerEnv.CONTROL_DB.batch([
    workerEnv.CONTROL_DB.prepare(
      "INSERT INTO gateway_routes (id, service_principal_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
    ).bind(
      "gateway_route_human",
      "principal_operator",
      "2026-09-07T00:00:00.000Z",
      "2026-09-07T00:00:00.000Z",
    ),
    workerEnv.CONTROL_DB.prepare(
      "INSERT INTO gateway_routes (id, service_principal_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
    ).bind(
      "gateway_route_agent",
      "principal_operator",
      "2026-09-07T00:00:00.000Z",
      "2026-09-07T00:00:00.000Z",
    ),
    workerEnv.CONTROL_DB.prepare(
      "INSERT INTO gateway_routes (id, service_principal_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
    ).bind(
      "gateway_route_agent_secondary",
      "principal_operator",
      "2026-09-07T00:00:00.000Z",
      "2026-09-07T00:00:00.000Z",
    ),
    workerEnv.CONTROL_DB.prepare(
      "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, 'telegram', ?, 'ready', ?, ?)",
    ).bind(
      "connection_agent_secondary",
      tenantId,
      "identity_agent",
      "Agent Telegram",
      "2026-09-07T00:00:00.000Z",
      "2026-09-07T00:00:00.000Z",
    ),
    workerEnv.CONTROL_DB.prepare(
      "INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "connection_agent_secondary",
      "gateway_route_agent_secondary",
      "bridge-agent-secondary",
      "route-user-agent-secondary",
      "route-room-agent-secondary",
      "2026-09-07T00:00:00.000Z",
      "2026-09-07T00:00:00.000Z",
    ),
    workerEnv.CONTROL_DB.prepare(
      "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
    ).bind(
      "account_human",
      "connection_human_whatsapp",
      "2026-09-07T00:00:00.000Z",
      "2026-09-07T00:00:00.000Z",
    ),
    workerEnv.CONTROL_DB.prepare(
      "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
    ).bind(
      "account_agent",
      "connection_agent_whatsapp",
      "2026-09-07T00:00:00.000Z",
      "2026-09-07T00:00:00.000Z",
    ),
    workerEnv.CONTROL_DB.prepare(
      "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
    ).bind(
      "account_agent_secondary",
      "connection_agent_secondary",
      "2026-09-07T00:00:00.000Z",
      "2026-09-07T00:00:00.000Z",
    ),
  ]);
}

async function projectReadFixtures() {
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
        "event_grant_human_one",
        {
          title: "Granted conversation",
          archived: false,
          muted: false,
        },
        "conversation.updated",
        {
          tenant_id: tenantId,
          identity_id: "identity_human",
          account_id: "account_human",
          conversation_id: "conversation_human_one",
        },
      ),
      event(
        "event_grant_human_two",
        {
          title: "Another conversation",
          archived: false,
          muted: false,
        },
        "conversation.updated",
        {
          tenant_id: tenantId,
          identity_id: "identity_human",
          account_id: "account_human",
          conversation_id: "conversation_human_two",
          occurred_at: "2026-09-07T02:00:00.000Z",
          observed_at: "2026-09-07T02:00:01.000Z",
        },
      ),
    ],
    checkpoint: null,
  });
}

beforeAll(projectReadFixtures);
beforeEach(async () => {
  await clearDirectory(workerEnv.CONTROL_DB);
  await seedDirectory(workerEnv.CONTROL_DB);
  await workerEnv.CONTROL_DB.batch([
    workerEnv.CONTROL_DB.prepare(
      "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'service', ?, 'active', ?, ?)",
    ).bind(
      "principal_service",
      "https://issuer.example/",
      "service-subject",
      "Service",
      "2026-09-07T00:00:00.000Z",
      "2026-09-07T00:00:00.000Z",
    ),
    workerEnv.CONTROL_DB.prepare(
      "INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'owner', 'active', ?, ?)",
    ).bind(
      "membership_service",
      tenantId,
      "principal_service",
      "2026-09-07T00:00:00.000Z",
      "2026-09-07T00:00:00.000Z",
    ),
  ]);
  await insertAccounts();
});

describe("account-scoped grant API", () => {
  it("fails closed for an ungranted linked account, then applies selected/all scope and revocation", async () => {
    const beforeGrant = await request(
      "/api/v1/accounts/account_human/conversations?identity_id=identity_human",
    );
    expect(beforeGrant.status).toBe(404);
    const realtime = await request("/api/v1/realtime/tickets", "agent-token", {
      method: "POST",
      body: JSON.stringify({
        schema_version: 1,
        subscriptions: [
          { identity_id: "identity_agent", families: ["projection"] },
        ],
      }),
    });
    expect(realtime.status).toBe(404);

    const create = await request("/api/v1/grants", "human-token", {
      method: "POST",
      body: JSON.stringify(grantBody()),
    });
    expect(create.status).toBe(201);
    const grant = AccountGrantSchema.parse(await create.json());

    const selected = await request(
      "/api/v1/accounts/account_human/conversations?identity_id=identity_human",
    );
    expect(selected.status).toBe(200);
    expect(
      ConversationPageResultSchema.parse(await selected.json()).items.map(
        (item) => item.id,
      ),
    ).toEqual(["conversation_human_one"]);

    const update = await request(`/api/v1/grants/${grant.id}`, "human-token", {
      method: "PATCH",
      body: JSON.stringify({
        operation_scope: "conversation.read",
        chat_scope: "all_chats",
        chat_ids: [],
        idempotency_key: `grant-update-${crypto.randomUUID()}`,
      }),
    });
    expect(update.status).toBe(200);
    await workerEnv.TENANT_PROJECTION.getByName(tenantId).applyBatch({
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
          "event_grant_human_future",
          {
            title: "Future conversation",
            archived: false,
            muted: false,
          },
          "conversation.updated",
          {
            tenant_id: tenantId,
            identity_id: "identity_human",
            account_id: "account_human",
            conversation_id: "conversation_human_future",
            occurred_at: "2026-09-07T03:00:00.000Z",
            observed_at: "2026-09-07T03:00:01.000Z",
          },
        ),
      ],
      checkpoint: null,
    });
    const allChats = await request(
      "/api/v1/accounts/account_human/conversations?identity_id=identity_human",
    );
    expect(
      ConversationPageResultSchema.parse(await allChats.json()).items.map(
        (item) => item.id,
      ),
    ).toEqual([
      "conversation_human_future",
      "conversation_human_two",
      "conversation_human_one",
    ]);

    const revoke = await request(`/api/v1/grants/${grant.id}`, "human-token", {
      method: "DELETE",
      headers: { "Idempotency-Key": `grant-revoke-${crypto.randomUUID()}` },
    });
    expect(revoke.status).toBe(200);
    const afterRevoke = await request(
      "/api/v1/accounts/account_human/conversations?identity_id=identity_human",
    );
    expect(afterRevoke.status).toBe(404);
    const audit = await workerEnv.CONTROL_DB.prepare(
      "SELECT action, target_id FROM audit_events WHERE target_type = 'account_grant' ORDER BY occurred_at, id",
    ).all<{ action: string; target_id: string }>();
    expect(audit.results.map((row) => row.action)).toEqual([
      "authorization.account_grant.created",
      "authorization.account_grant.updated",
      "authorization.account_grant.revoked",
    ]);
    expect(new Set(audit.results.map((row) => row.target_id))).toEqual(
      new Set([grant.id]),
    );
  });

  it("accepts and replays a text reply through the official MCP tool", async () => {
    const create = await request("/api/v1/grants", "human-token", {
      method: "POST",
      body: JSON.stringify(
        grantBody({
          membership_id: "membership_agent",
          identity_id: "identity_agent",
          operation_scope: "message.send",
          idempotency_key: `mcp-send-grant-${crypto.randomUUID()}`,
        }),
      ),
    });
    expect(create.status).toBe(201);

    const app = createTestApp();
    const { client, transport } = await connectMcpClient(app, "agent-token");
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain(
        "send_text_reply",
      );

      const idempotencyKey = `mcp-send-${crypto.randomUUID()}`;
      const input = {
        identity_id: "identity_agent",
        conversation_id: "conversation_human_one",
        body: "Saved through MCP",
        delivery_mode: "direct",
        idempotency_key: idempotencyKey,
      } as const;
      const first = await client.callTool({
        name: "send_text_reply",
        arguments: input,
      });
      expect(first.isError).not.toBe(true);
      const firstValue = first.structuredContent as {
        command: {
          id: string;
          status: string;
          message_id?: string;
          event_id?: string;
          dispatch_id?: string;
        };
        message: { id: string };
        dispatch: { id: string; status: string; idempotency_key: string };
        replayed: boolean;
      };
      expect(firstValue.replayed).toBe(false);
      expect(firstValue.command.status).toBe("accepted");
      expect(firstValue.command.message_id).toBe(firstValue.message.id);
      expect(firstValue.command.dispatch_id).toBe(firstValue.dispatch.id);
      expect(firstValue.dispatch.status).toBe("pending");
      expect(firstValue.dispatch.idempotency_key).toBe(idempotencyKey);

      const replay = await client.callTool({
        name: "send_text_reply",
        arguments: input,
      });
      expect(replay.isError).not.toBe(true);
      const replayValue = replay.structuredContent as typeof firstValue;
      expect(replayValue.replayed).toBe(true);
      expect(replayValue.command.id).toBe(firstValue.command.id);
      expect(replayValue.message.id).toBe(firstValue.message.id);
      expect(replayValue.dispatch.id).toBe(firstValue.dispatch.id);

      const apiReplay = await requestForApp(
        app,
        "/api/v1/conversations/conversation_human_one/messages",
        "agent-token",
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey },
          body: JSON.stringify({
            identity_id: "identity_agent",
            body: "Saved through MCP",
            delivery_mode: "direct",
          }),
        },
      );
      expect(apiReplay.status).toBe(202);
      const apiCommand = (await apiReplay.json()) as { id: string };
      expect(apiCommand.id).toBe(firstValue.command.id);

      const projection = workerEnv.TENANT_PROJECTION.getByName(tenantId);
      expect(
        await rows(
          projection,
          "SELECT id FROM outbound_dispatches WHERE idempotency_key = ?",
          idempotencyKey,
        ),
      ).toHaveLength(1);
      expect(
        await rows(
          projection,
          "SELECT id FROM commands WHERE id = ?",
          firstValue.command.id,
        ),
      ).toHaveLength(1);
      expect(
        await rows(
          projection,
          "SELECT id FROM messages WHERE id = ?",
          firstValue.message.id,
        ),
      ).toHaveLength(1);
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it("denies an agent grant, cross-account reads, and cross-tenant account binding", async () => {
    await workerEnv.CONTROL_DB.prepare(
      "UPDATE memberships SET role = 'admin' WHERE id = ?",
    )
      .bind("membership_agent")
      .run();
    const agentGrant = await request("/api/v1/grants", "agent-token", {
      method: "POST",
      body: JSON.stringify(
        grantBody({
          membership_id: "membership_agent",
          identity_id: "identity_agent",
          account_id: "account_agent",
          idempotency_key: `agent-grant-${crypto.randomUUID()}`,
        }),
      ),
    });
    expect(agentGrant.status).toBe(403);
    expect(
      ApiErrorResponseSchema.parse(await agentGrant.json()).error.code,
    ).toBe("forbidden");

    const serviceGrant = await request("/api/v1/grants", "service-token", {
      method: "POST",
      body: JSON.stringify(
        grantBody({
          idempotency_key: `service-grant-${crypto.randomUUID()}`,
        }),
      ),
    });
    expect(serviceGrant.status).toBe(403);

    const crossAccount = await request(
      "/api/v1/accounts/account_agent/conversations?identity_id=identity_human",
    );
    expect(crossAccount.status).toBe(404);

    await workerEnv.CONTROL_DB.batch([
      workerEnv.CONTROL_DB.prepare(
        "INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
      ).bind(
        "tenant_other",
        "other",
        "Other",
        "2026-09-07T00:00:00.000Z",
        "2026-09-07T00:00:00.000Z",
      ),
      workerEnv.CONTROL_DB.prepare(
        "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'human', ?, 'active', ?, ?)",
      ).bind(
        "principal_other",
        "https://issuer.example/",
        "other-subject",
        "Other",
        "2026-09-07T00:00:00.000Z",
        "2026-09-07T00:00:00.000Z",
      ),
      workerEnv.CONTROL_DB.prepare(
        "INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'owner', 'active', ?, ?)",
      ).bind(
        "membership_other",
        "tenant_other",
        "principal_other",
        "2026-09-07T00:00:00.000Z",
        "2026-09-07T00:00:00.000Z",
      ),
      workerEnv.CONTROL_DB.prepare(
        "INSERT INTO identities (id, tenant_id, identity_kind, display_name, status, created_at, updated_at) VALUES (?, ?, 'human', ?, 'active', ?, ?)",
      ).bind(
        "identity_other",
        "tenant_other",
        "Other",
        "2026-09-07T00:00:00.000Z",
        "2026-09-07T00:00:00.000Z",
      ),
      workerEnv.CONTROL_DB.prepare(
        "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, 'whatsapp', ?, 'ready', ?, ?)",
      ).bind(
        "connection_other",
        "tenant_other",
        "identity_other",
        "Other WhatsApp",
        "2026-09-07T00:00:00.000Z",
        "2026-09-07T00:00:00.000Z",
      ),
      workerEnv.CONTROL_DB.prepare(
        "INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "connection_other",
        "gateway_route_other",
        "bridge-other",
        "route-user-other",
        "route-room-other",
        "2026-09-07T00:00:00.000Z",
        "2026-09-07T00:00:00.000Z",
      ),
      workerEnv.CONTROL_DB.prepare(
        "INSERT INTO gateway_routes (id, service_principal_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
      ).bind(
        "gateway_route_other",
        "principal_other",
        "2026-09-07T00:00:00.000Z",
        "2026-09-07T00:00:00.000Z",
      ),
      workerEnv.CONTROL_DB.prepare(
        "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
      ).bind(
        "account_other",
        "connection_other",
        "2026-09-07T00:00:00.000Z",
        "2026-09-07T00:00:00.000Z",
      ),
    ]);
    const crossTenant = await request("/api/v1/grants", "human-token", {
      method: "POST",
      body: JSON.stringify(
        grantBody({
          account_id: "account_other",
          idempotency_key: `cross-tenant-${crypto.randomUUID()}`,
        }),
      ),
    });
    expect(crossTenant.status).toBe(409);
  });

  it("filters delegated account and connection enumeration by active grants", async () => {
    const before = await request(
      "/api/v1/accounts?identity_id=identity_agent",
      "agent-token",
    );
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ items: [], next_cursor: null });

    const beforeConnections = await request(
      "/api/v1/connections?identity_id=identity_agent",
      "agent-token",
    );
    expect(beforeConnections.status).toBe(200);
    expect(await beforeConnections.json()).toEqual([]);

    const create = await request("/api/v1/grants", "human-token", {
      method: "POST",
      body: JSON.stringify(
        grantBody({
          membership_id: "membership_agent",
          identity_id: "identity_agent",
          account_id: "account_agent",
          idempotency_key: `agent-account-${crypto.randomUUID()}`,
        }),
      ),
    });
    expect(create.status).toBe(201);

    const after = await request(
      "/api/v1/accounts?identity_id=identity_agent",
      "agent-token",
    );
    expect(after.status).toBe(200);
    expect(
      ConnectedAccountPageSchema.parse(await after.json()).items.map(
        (account) => account.account_id,
      ),
    ).toEqual(["account_agent"]);

    const afterConnections = await request(
      "/api/v1/connections?identity_id=identity_agent",
      "agent-token",
    );
    expect(afterConnections.status).toBe(200);
    expect(
      ConnectionSchema.array()
        .parse(await afterConnections.json())
        .map((connection) => connection.id),
    ).toEqual(["connection_agent_whatsapp"]);
  });

  it("paginates more than one hundred delegated account grants without an account-list cap", async () => {
    const rows: D1PreparedStatement[] = [];
    for (let index = 0; index < 105; index += 1) {
      const suffix = String(index).padStart(3, "0");
      const connectionId = `connection_agent_bulk_${suffix}`;
      const accountId = `account_agent_bulk_${suffix}`;
      rows.push(
        workerEnv.CONTROL_DB.prepare(
          "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, 'identity_agent', 'telegram', ?, 'ready', ?, ?)",
        ).bind(
          connectionId,
          tenantId,
          `Agent bulk ${suffix}`,
          "2026-09-07T00:00:00.000Z",
          "2026-09-07T00:00:00.000Z",
        ),
        workerEnv.CONTROL_DB.prepare(
          "INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES (?, 'gateway_route_agent', ?, ?, ?, ?, ?)",
        ).bind(
          connectionId,
          `bridge-agent-bulk-${suffix}`,
          `route-user-agent-bulk-${suffix}`,
          `route-room-agent-bulk-${suffix}`,
          "2026-09-07T00:00:00.000Z",
          "2026-09-07T00:00:00.000Z",
        ),
        workerEnv.CONTROL_DB.prepare(
          "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
        ).bind(
          accountId,
          connectionId,
          "2026-09-07T00:00:00.000Z",
          "2026-09-07T00:00:00.000Z",
        ),
        workerEnv.CONTROL_DB.prepare(
          "INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at) VALUES (?, ?, 'membership_agent', 'identity_agent', ?, 'conversation.read', 'all_chats', 'active', ?, ?)",
        ).bind(
          `grant_agent_bulk_${suffix}`,
          tenantId,
          accountId,
          "2026-09-07T00:00:00.000Z",
          "2026-09-07T00:00:00.000Z",
        ),
      );
    }
    await workerEnv.CONTROL_DB.batch(rows);

    const accountIds: string[] = [];
    const pageSizes: number[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({
        identity_id: "identity_agent",
        limit: "50",
      });
      if (cursor !== undefined) query.set("cursor", cursor);
      const response = await request(
        `/api/v1/accounts?${query}`,
        "agent-token",
      );
      expect(response.status).toBe(200);
      const page = ConnectedAccountPageSchema.parse(await response.json());
      pageSizes.push(page.items.length);
      accountIds.push(...page.items.map((account) => account.account_id));
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);

    expect(pageSizes).toEqual([50, 50, 5]);
    expect(new Set(accountIds).size).toBe(105);
    expect(accountIds).toContain("account_agent_bulk_104");
  });

  it("denies retained projection rows when the last account is retired or the account table is empty", async () => {
    await workerEnv.CONTROL_DB.prepare(
      "UPDATE connection_accounts SET status = 'retired', retired_at = ? WHERE account_id = ?",
    )
      .bind("2026-09-07T04:00:00.000Z", "account_human")
      .run();
    const retired = await request(
      "/api/v1/accounts/account_human/conversations?identity_id=identity_human",
    );
    expect(retired.status).toBe(404);

    await clearDirectory(workerEnv.CONTROL_DB);
    await seedDirectory(workerEnv.CONTROL_DB);
    const unknownLegacy = await request(
      "/api/v1/accounts/account_human/conversations?identity_id=identity_human",
    );
    expect(unknownLegacy.status).toBe(404);
  });

  it("lets an agent inspect its own grants and request access without elevating itself", async () => {
    const implicitOwnGrants = await request("/api/v1/grants", "agent-token");
    expect(implicitOwnGrants.status).toBe(200);
    expect(await implicitOwnGrants.json()).toEqual({
      items: [],
      next_cursor: null,
    });
    const ownGrants = await request(
      "/api/v1/grants?identity_id=identity_agent",
      "agent-token",
    );
    expect(ownGrants.status).toBe(200);
    expect(await ownGrants.json()).toEqual({ items: [], next_cursor: null });

    const requestAccess = await request(
      "/api/v1/permission-requests",
      "agent-token",
      {
        method: "POST",
        body: JSON.stringify({
          identity_id: "identity_agent",
          account_id: "account_agent",
          operation_scope: "conversation.read",
          chat_scope: "all_chats",
          chat_ids: [],
          reason: "Need access to the assigned account",
          idempotency_key: `permission-${crypto.randomUUID()}`,
        }),
      },
    );
    expect(requestAccess.status).toBe(201);

    const selfGrant = await request("/api/v1/grants", "agent-token", {
      method: "POST",
      body: JSON.stringify(
        grantBody({
          membership_id: "membership_agent",
          identity_id: "identity_agent",
          account_id: "account_agent",
          idempotency_key: `self-grant-${crypto.randomUUID()}`,
        }),
      ),
    });
    expect(selfGrant.status).toBe(403);

    const otherIdentityRequest = await request(
      "/api/v1/permission-requests",
      "agent-token",
      {
        method: "POST",
        body: JSON.stringify({
          identity_id: "identity_human",
          account_id: "account_human",
          operation_scope: "conversation.read",
          chat_scope: "all_chats",
          chat_ids: [],
          reason: "Attempt to request for another identity",
          idempotency_key: `permission-other-${crypto.randomUUID()}`,
        }),
      },
    );
    expect(otherIdentityRequest.status).toBe(403);
  });

  it("accepts an account-scoped text reply once, separates keys, and survives rebuild", async () => {
    const conversationPath =
      "/api/v1/conversations/conversation_human_one/messages";
    const firstKey = `reply-first-${crypto.randomUUID()}`;
    const secondKey = `reply-second-${crypto.randomUUID()}`;
    const before = await request(conversationPath, "agent-token", {
      method: "POST",
      headers: { "Idempotency-Key": firstKey },
      body: JSON.stringify({
        identity_id: "identity_agent",
        body: "durable hello",
        delivery_mode: "direct",
      }),
    });
    expect(before.status).toBe(403);
    expect(
      await rows(
        workerEnv.TENANT_PROJECTION.getByName(tenantId),
        "SELECT id FROM outbound_dispatches WHERE idempotency_key = ?",
        firstKey,
      ),
    ).toEqual([]);

    const grantResponse = await request("/api/v1/grants", "human-token", {
      method: "POST",
      body: JSON.stringify(
        grantBody({
          membership_id: "membership_agent",
          identity_id: "identity_agent",
          account_id: "account_human",
          operation_scope: "message.send",
          idempotency_key: `send-grant-${crypto.randomUUID()}`,
        }),
      ),
    });
    expect(grantResponse.status).toBe(201);

    const firstResponse = await request(conversationPath, "agent-token", {
      method: "POST",
      headers: { "Idempotency-Key": firstKey },
      body: JSON.stringify({
        identity_id: "identity_agent",
        body: "durable hello",
        delivery_mode: "direct",
      }),
    });
    expect(firstResponse.status).toBe(202);
    const first = (await firstResponse.json()) as {
      id: string;
      status: string;
      account_id?: string;
      message_id?: string;
      event_id?: string;
      dispatch_id?: string;
    };
    expect(first).toMatchObject({
      status: "accepted",
      account_id: "account_human",
    });
    expect(first.message_id).toEqual(expect.any(String));
    expect(first.event_id).toEqual(expect.any(String));
    expect(first.dispatch_id).toEqual(expect.any(String));

    const replayResponse = await request(conversationPath, "agent-token", {
      method: "POST",
      headers: { "Idempotency-Key": firstKey },
      body: JSON.stringify({
        identity_id: "identity_agent",
        body: "durable hello",
        delivery_mode: "direct",
      }),
    });
    expect(replayResponse.status).toBe(202);
    const replay = (await replayResponse.json()) as { id: string };
    expect(replay.id).toBe(first.id);

    const secondResponse = await request(conversationPath, "agent-token", {
      method: "POST",
      headers: { "Idempotency-Key": secondKey },
      body: JSON.stringify({
        identity_id: "identity_agent",
        body: "durable hello",
        delivery_mode: "direct",
      }),
    });
    expect(secondResponse.status).toBe(202);
    const second = (await secondResponse.json()) as {
      id: string;
      message_id?: string;
    };
    expect(second.id).not.toBe(first.id);
    expect(second.message_id).not.toBe(first.message_id);

    const conflict = await request(conversationPath, "agent-token", {
      method: "POST",
      headers: { "Idempotency-Key": firstKey },
      body: JSON.stringify({
        identity_id: "identity_agent",
        body: "changed durable hello",
        delivery_mode: "direct",
      }),
    });
    expect(conflict.status).toBe(400);
    expect(ApiErrorResponseSchema.parse(await conflict.json()).error.code).toBe(
      "invalid_request",
    );

    const dispatchRows = await rows<{ id: string; message_id: string; command_id: string }>(
      workerEnv.TENANT_PROJECTION.getByName(tenantId),
      "SELECT id, message_id, command_id FROM outbound_dispatches WHERE idempotency_key IN (?, ?) ORDER BY idempotency_key",
      firstKey,
      secondKey,
    );
    expect(dispatchRows).toHaveLength(2);
    expect(
      await rows(
        workerEnv.TENANT_PROJECTION.getByName(tenantId),
        "SELECT id FROM messages WHERE id IN (?, ?)",
        dispatchRows[0]!.message_id,
        dispatchRows[1]!.message_id,
      ),
    ).toHaveLength(2);
    expect(
      await rows(
        workerEnv.TENANT_PROJECTION.getByName(tenantId),
        "SELECT id FROM commands WHERE id IN (?, ?)",
        dispatchRows[0]!.command_id,
        dispatchRows[1]!.command_id,
      ),
    ).toHaveLength(2);

    const revoke = await request(
      `/api/v1/grants/${(await grantResponse.clone().json() as { id: string }).id}`,
      "human-token",
      {
        method: "DELETE",
        headers: { "Idempotency-Key": `revoke-send-${crypto.randomUUID()}` },
      },
    );
    expect(revoke.status).toBe(200);
    const afterRevoke = await request(conversationPath, "agent-token", {
      method: "POST",
      headers: { "Idempotency-Key": `reply-after-revoke-${crypto.randomUUID()}` },
      body: JSON.stringify({
        identity_id: "identity_agent",
        body: "must be denied",
        delivery_mode: "direct",
      }),
    });
    expect(afterRevoke.status).toBe(403);

    const projection = workerEnv.TENANT_PROJECTION.getByName(tenantId);
    const deletionEvent = event(
      "event_outbound_deleted",
      { message_id: first.message_id!, reason_code: "redacted" },
      "message.deleted",
      {
        tenant_id: tenantId,
        identity_id: "identity_human",
        account_id: "account_human",
        conversation_id: "conversation_human_one",
        occurred_at: "2026-09-13T02:00:00.000Z",
        observed_at: "2026-09-13T02:00:01.000Z",
      },
    );
    await projection.applyBatch({
      schema_version: 1,
      tenant_id: tenantId,
      authorization: auth(
        ["projection.write"],
        ["identity_human"],
        tenantId,
      ),
      mode: "live",
      rebuild_id: null,
      connections: [
        bindingFor(
          "account_human",
          "connection_human_whatsapp",
          "identity_human",
        ),
      ],
      events: [deletionEvent],
      checkpoint: null,
    });
    expect(
      await rows<{ body: string; deleted_at: string | null }>(
        projection,
        "SELECT body, deleted_at FROM messages WHERE id = ?",
        first.message_id!,
      ),
    ).toEqual([{ body: "", deleted_at: expect.any(String) }]);

    const currentMeta = await rows<{ generation: number }>(
      projection,
      "SELECT generation FROM projection_meta WHERE singleton = 1",
    );
    const rebuildId = `rebuild_outbound_${crypto.randomUUID().replaceAll("-", "")}`;
    const rebuildAuthorization = auth(
      ["projection.rebuild"],
      ["identity_human"],
      tenantId,
    );
    await projection.beginRebuild({
      schema_version: 1,
      tenant_id: tenantId,
      rebuild_id: rebuildId,
      expected_generation: currentMeta[0]!.generation,
      started_at: "2026-09-13T02:00:00.000Z",
      authorization: rebuildAuthorization,
    });
    const replayEvent = event(
      `event_rebuild_outbound_${crypto.randomUUID().replaceAll("-", "")}`,
      { title: "Granted conversation", archived: false, muted: false },
      "conversation.updated",
      {
        event_source: "replay",
        tenant_id: tenantId,
        identity_id: "identity_human",
        account_id: "account_human",
        conversation_id: "conversation_human_one",
        occurred_at: "2026-09-13T02:00:00.000Z",
        observed_at: "2026-09-13T02:00:01.000Z",
      },
    );
    const replayDeletionEvent = event(
      "event_rebuild_outbound_deleted",
      { message_id: first.message_id!, reason_code: "redacted" },
      "message.deleted",
      {
        event_source: "replay",
        tenant_id: tenantId,
        identity_id: "identity_human",
        account_id: "account_human",
        conversation_id: "conversation_human_one",
        occurred_at: "2026-09-13T02:00:02.000Z",
        observed_at: "2026-09-13T02:00:03.000Z",
      },
    );
    await projection.applyReplayPage({
      schema_version: 1,
      tenant_id: tenantId,
      rebuild_id: rebuildId,
      source_cursor: null,
      connections: [
        bindingFor(
          "account_human",
          "connection_human_whatsapp",
          "identity_human",
        ),
      ],
      page: {
        schema_version: 1,
        replay_mode: "projection_only",
        tenant_id: tenantId,
        manifests: [
          {
            schema_version: 1,
            tenant_id: tenantId,
            batch_id: "batch_outbound_rebuild",
            data_key: `events/${tenantId}/2026/09/13/02/batch_outbound_rebuild.jsonl.gz`,
            compression: "gzip",
            content_type: "application/x-ndjson",
            event_count: 2,
            uncompressed_bytes: 1,
            compressed_bytes: 1,
            canonical_sha256: "0".repeat(64),
            data_etag: "etag-outbound-rebuild",
            first_event_id: replayEvent.event_id,
            last_event_id: replayDeletionEvent.event_id,
            first_observed_at: replayEvent.observed_at,
            last_observed_at: replayDeletionEvent.observed_at,
            archived_at: "2026-09-13T02:00:02.000Z",
            producer: {
              service: "communicator-control-plane",
              version: "outbound-test/1",
            },
            source_checkpoint: null,
          },
        ],
        events: [replayEvent, replayDeletionEvent],
        next_cursor: null,
      },
      authorization: rebuildAuthorization,
    });
    const completeInput = {
      schema_version: 1,
      tenant_id: tenantId,
      rebuild_id: rebuildId,
      terminal_cursor: null,
      completed_at: "2026-09-13T02:00:03.000Z",
      authorization: rebuildAuthorization,
    } as const;
    await projection.completeRebuild(completeInput);

    expect(
      await rows(
        projection,
        "SELECT id FROM outbound_dispatches WHERE idempotency_key IN (?, ?)",
        firstKey,
        secondKey,
      ),
    ).toHaveLength(2);
    expect(
      await rows<{ body: string; deleted_at: string | null }>(
        projection,
        "SELECT body, deleted_at FROM messages WHERE id = ?",
        first.message_id!,
      ),
    ).toEqual([{ body: "", deleted_at: expect.any(String) }]);
    expect(
      await rows(
        projection,
        "SELECT id FROM messages WHERE id IN (?, ?)",
        dispatchRows[0]!.message_id,
        dispatchRows[1]!.message_id,
      ),
    ).toHaveLength(2);
    expect(
      await rows(
        projection,
        "SELECT id FROM commands WHERE id IN (?, ?)",
        dispatchRows[0]!.command_id,
        dispatchRows[1]!.command_id,
      ),
    ).toHaveLength(2);
  });
});
