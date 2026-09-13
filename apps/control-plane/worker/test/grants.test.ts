import { env, runInDurableObject } from "cloudflare:test";
import {
  AccountGrantSchema,
  ApiErrorResponseSchema,
  ConnectedAccountPageSchema,
  ConnectionSchema,
  ConversationPageResultSchema,
} from "@communicator/contracts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { VerifiedSubject } from "../auth/oidc";
import {
  auth,
  bindingFor,
  event,
  initialize,
} from "./projection/projector-test-support";
import { clearDirectory, seedDirectory } from "./support/directory-fixtures";

const workerEnv = env as typeof env & { CONTROL_DB: D1Database };
const tenantId = "tenant_pilot";

const createTestApp = () =>
  createApp({
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

const request = async (
  path: string,
  token = "human-token",
  init: RequestInit = {},
) =>
  createTestApp().request(
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
});
