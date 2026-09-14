import { env as runtimeEnv } from "cloudflare:workers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { VerifiedSubject } from "../auth/oidc";
import {
  GroupProviderError,
  HttpGroupProvider,
  type GroupProvider,
  type GroupProviderInput,
  type ProviderGroup,
} from "../groups/provider";
import {
  clearDirectory,
  seedAccountAccess,
  seedDirectory,
} from "./support/directory-fixtures";

const env = runtimeEnv as typeof runtimeEnv & { CONTROL_DB: D1Database };
const tenantId = "tenant_pilot";
const observedAt = "2026-09-14T00:00:00.000Z";
const oldObservedAt = "2026-09-13T23:00:00.000Z";

type GroupMode = "provider" | "event" | "refresh" | "timeout" | "mismatch";

type GroupProviderState = {
  mode: GroupMode;
  createCalls: GroupProviderInput[];
  observeCalls: GroupProviderInput[];
  refreshCalls: GroupProviderInput[];
  createAttempts: number;
  now?: Date;
  createStarted?: () => void;
  releaseCreate?: Promise<void>;
};

const participantIds = ["provider_alex_one", "provider_alex_two"] as const;

const evidenceFor = (
  input: GroupProviderInput,
  source: "provider" | "event" | "refresh",
  overrides: Partial<ProviderGroup["evidence"]> = {},
) => ({
  source,
  evidence_id: `group-evidence-${source}-${input.operation_id}`,
  observed_at: observedAt,
  operation_id: input.operation_id,
  account_id: input.route.account_id,
  connection_id: input.route.connection_id,
  provider_group_id: "provider_group_alex",
  matrix_room_id: "!group-alex:example.test",
  participant_provider_ids: [...participantIds],
  status: "confirmed" as const,
  reason: null,
  ...overrides,
});

const providerGroup = (
  input: GroupProviderInput,
  source: "provider" | "event" | "refresh",
  overrides: Partial<ProviderGroup> = {},
): ProviderGroup => ({
  provider_group_id: "provider_group_alex",
  matrix_room_id: "!group-alex:example.test",
  name: "Alex Room",
  participant_provider_ids: [...participantIds],
  evidence: evidenceFor(input, source),
  ...overrides,
});

const providerFor = (state: GroupProviderState): GroupProvider => ({
  async createGroup(input) {
    state.createCalls.push(input);
    state.createAttempts += 1;
    state.createStarted?.();
    if (state.releaseCreate !== undefined) await state.releaseCreate;
    if (
      state.mode === "timeout" ||
      state.mode === "event" ||
      state.mode === "refresh"
    )
      throw new GroupProviderError("unavailable");
    if (state.mode === "mismatch") {
      return providerGroup(input, "provider", {
        evidence: evidenceFor(input, "provider", {
          account_id: "account_other",
          operation_id: "group_create_wrong_operation",
        }),
      });
    }
    return providerGroup(input, "provider");
  },
  async observeGroup(input) {
    state.observeCalls.push(input);
    if (state.mode === "event") return providerGroup(input, "event");
    if (state.mode === "refresh") return null;
    if (state.mode === "timeout") return null;
    return null;
  },
  async refreshGroup(input) {
    state.refreshCalls.push(input);
    if (state.mode === "refresh") return providerGroup(input, "refresh");
    return null;
  },
});

const createTestApp = (state: GroupProviderState) =>
  createApp({
    createTokenVerifier: () => ({
      verify: async (token: string): Promise<VerifiedSubject> => {
        if (token === "human-token") {
          return {
            issuer: "https://issuer.example/",
            subject: "human-subject",
          };
        }
        throw new Error("invalid local token");
      },
    }),
    groupServices: {
      createProvider: () => providerFor(state),
      now: () => state.now ?? new Date(observedAt),
    },
  });

const request = (
  app: ReturnType<typeof createTestApp>,
  path: string,
  init: RequestInit = {},
) =>
  app.request(
    `http://example.test${path}`,
    {
      ...init,
      headers: {
        Authorization: "Bearer human-token",
        "Content-Type": "application/json",
        ...init.headers,
      },
    },
    env,
  );

const groupBody = (idempotencyKey: string) => ({
  identity_id: "identity_human",
  account_id: "account_human",
  name: "Alex Room",
  participants: [
    {
      contact_id: "contact_alex_one",
      candidate_revision: "1".repeat(64),
    },
    {
      contact_id: "contact_alex_two",
      candidate_revision: "2".repeat(64),
    },
  ],
  idempotency_key: idempotencyKey,
});

async function seedGroupDirectory(): Promise<void> {
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "INSERT INTO connection_provider_identities (tenant_id, provider, identity_key, provider_login_id, connection_id, link_session_id, created_at) VALUES (?, 'whatsapp', ?, ?, ?, ?, ?)",
    ).bind(
      tenantId,
      "d".repeat(64),
      "login-human-group",
      "connection_human_whatsapp",
      "link-group-human",
      observedAt,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO provider_capability_records (tenant_id, account_id, connection_id, identity_id, provider, capability, status, freshness, proof_source, provider_evidence_json, product_claim, observed_at, updated_at) VALUES (?, ?, ?, ?, 'whatsapp', 'group.manage', 'supported', 'fresh', ?, ?, ?, ?, ?)",
    ).bind(
      tenantId,
      "account_human",
      "connection_human_whatsapp",
      "identity_human",
      "group-creation-test",
      JSON.stringify({
        capability: "group.manage",
        account_id: "account_human",
      }),
      "Provider group creation is available",
      observedAt,
      observedAt,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES (?, ?, ?, 'group.create', ?)",
    ).bind(tenantId, "membership_human", "identity_human", observedAt),
    env.CONTROL_DB.prepare(
      "INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'group.create', 'all_chats', 'active', ?, ?)",
    ).bind(
      "grant_group_create",
      tenantId,
      "membership_human",
      "identity_human",
      "account_human",
      observedAt,
      observedAt,
    ),
    ...[
      [
        "contact_alex_one",
        "provider_alex_one",
        "alex-one@lid",
        "1".repeat(64),
        "+15550000001",
      ],
      [
        "contact_alex_two",
        "provider_alex_two",
        "alex-two@lid",
        "2".repeat(64),
        "+15550000002",
      ],
    ].map(([contactId, providerId, lid, revision, phone]) =>
      env.CONTROL_DB.prepare(
        "INSERT INTO contact_resolution_candidates (contact_id, tenant_id, identity_id, account_id, connection_id, provider, provider_id, current_lid, display_name, identifiers_json, stable_key, match_reason, candidate_revision, observed_at, evidence_json, status, created_at, updated_at) VALUES (?, ?, 'identity_human', 'account_human', 'connection_human_whatsapp', 'whatsapp', ?, ?, 'Alex', ?, ?, 'name', ?, ?, ?, 'active', ?, ?)",
      ).bind(
        contactId,
        tenantId,
        providerId,
        lid,
        JSON.stringify([phone, lid]),
        phone,
        revision,
        observedAt,
        JSON.stringify({
          source: "provider",
          operation: "resolve",
          evidence_id: `contact-evidence-${contactId}`,
          observed_at: observedAt,
          provider_id: providerId,
          matrix_room_id: null,
          status: "confirmed",
          reason: null,
        }),
        observedAt,
        observedAt,
      ),
    ),
  ]);
}

async function insertWebhookFixtures(): Promise<void> {
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `INSERT INTO webhook_subscriptions
       (id, tenant_id, creation_idempotency_key, owner_principal_id,
        creator_principal_id, creator_membership_id, creator_identity_id,
        ownership_mode, destination_url, destination_version,
        event_filter_json, global_enabled, status, created_at, updated_at,
        revoked_at)
       VALUES (?, ?, ?, 'principal_human', 'principal_human', 'membership_human',
               'identity_human', 'human_owner', ?, 1, ?, ?, 'active', ?, ?, NULL)`,
    ).bind(
      "webhook_global_group",
      tenantId,
      "webhook-global-group",
      "https://global.example.test/hook",
      JSON.stringify({ event_types: ["group.created"] }),
      1,
      observedAt,
      observedAt,
    ),
    env.CONTROL_DB.prepare(
      `INSERT INTO webhook_subscriptions
       (id, tenant_id, creation_idempotency_key, owner_principal_id,
        creator_principal_id, creator_membership_id, creator_identity_id,
        ownership_mode, destination_url, destination_version,
        event_filter_json, global_enabled, status, created_at, updated_at,
        revoked_at)
       VALUES (?, ?, ?, 'principal_human', 'principal_human', 'membership_human',
               'identity_human', 'human_owner', ?, 1, ?, 1, 'active', ?, ?, NULL)`,
    ).bind(
      "webhook_account_group",
      tenantId,
      "webhook-account-group",
      "https://account.example.test/hook",
      JSON.stringify({ event_types: ["group.created"] }),
      observedAt,
      observedAt,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO webhook_subscription_account_rules (tenant_id, subscription_id, account_id, enabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
    ).bind(
      tenantId,
      "webhook_account_group",
      "account_human",
      observedAt,
      observedAt,
    ),
  ]);
}

async function connectMcp(
  app: ReturnType<typeof createTestApp>,
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client({ name: "group-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://example.test/mcp"),
    {
      requestInit: {
        headers: {
          Authorization: "Bearer human-token",
          Origin: "http://example.test",
        },
      },
      fetch: async (input, init) => {
        const url = input instanceof URL ? input.href : input.toString();
        return app.request(url, init, env);
      },
    },
  );
  await client.connect(
    transport as unknown as Parameters<Client["connect"]>[0],
  );
  return { client, transport };
}

beforeEach(async () => {
  await clearDirectory(env.CONTROL_DB);
  await seedDirectory(env.CONTROL_DB);
  await seedAccountAccess(env.CONTROL_DB);
  await seedGroupDirectory();
});

describe("group creation account and evidence boundaries", () => {
  it("creates duplicate-name participants through REST, preserves grants, evaluates webhook defaults, and exposes MCP", async () => {
    await insertWebhookFixtures();
    const state: GroupProviderState = {
      mode: "provider",
      createCalls: [],
      observeCalls: [],
      refreshCalls: [],
      createAttempts: 0,
    };
    const app = createTestApp(state);
    const response = await request(app, "/api/v1/groups", {
      method: "POST",
      body: JSON.stringify(groupBody("group-rest")),
    });
    const body = (await response.json()) as Record<string, any>;
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body, JSON.stringify(body)).toMatchObject({
      status: "created",
      account_id: "account_human",
      evidence_path: "provider",
      provider_group_id: "provider_group_alex",
    });
    expect(
      body.participants.map((participant: any) => participant.display_name),
    ).toEqual(["Alex", "Alex"]);
    expect(
      body.participants.map((participant: any) => participant.provider_id),
    ).toEqual(["provider_alex_one", "provider_alex_two"]);
    expect(state.createAttempts).toBe(1);
    expect(state.createCalls[0]?.route.account_id).toBe("account_human");
    expect(state.createCalls[0]?.route.provider_login_id).toBe(
      "login-human-group",
    );
    expect(body.webhook_evaluations).toEqual([
      {
        subscription_id: "webhook_account_group",
        account_id: "account_human",
        chat_id: body.conversation_id,
        enabled: false,
        source: "account",
      },
      {
        subscription_id: "webhook_global_group",
        account_id: "account_human",
        chat_id: body.conversation_id,
        enabled: true,
        source: "global",
      },
    ]);

    const access = await env.CONTROL_DB.prepare(
      "SELECT operation_scope, source, conversation_id FROM group_creation_access_grants WHERE tenant_id = ? AND operation_id = ? ORDER BY operation_scope",
    )
      .bind(tenantId, body.operation_id)
      .all();
    expect(access.results).toEqual([
      {
        operation_scope: "conversation.read",
        source: "group_creation",
        conversation_id: body.conversation_id,
      },
      {
        operation_scope: "message.send",
        source: "group_creation",
        conversation_id: body.conversation_id,
      },
    ]);
    const grants = await env.CONTROL_DB.prepare(
      "SELECT operation_scope, chat_scope, status FROM account_grants WHERE tenant_id = ? AND membership_id = ? AND identity_id = ? AND account_id = ? ORDER BY operation_scope",
    )
      .bind(tenantId, "membership_human", "identity_human", "account_human")
      .all();
    expect(grants.results).toEqual([
      {
        operation_scope: "conversation.read",
        chat_scope: "all_chats",
        status: "active",
      },
      {
        operation_scope: "group.create",
        chat_scope: "all_chats",
        status: "active",
      },
      {
        operation_scope: "message.send",
        chat_scope: "selected_chats",
        status: "active",
      },
    ]);

    const mcp = await connectMcp(app);
    const mcpResult = await mcp.client.callTool({
      name: "create_group",
      arguments: groupBody("group-mcp"),
    });
    expect(mcpResult.isError).not.toBe(true);
    expect(mcpResult.structuredContent).toMatchObject({ status: "created" });
    expect(state.createAttempts).toBe(2);
    await mcp.client.close();
    await mcp.transport.close();
  });

  it("requires the distinct group.create grants and an active candidate revision", async () => {
    const state: GroupProviderState = {
      mode: "provider",
      createCalls: [],
      observeCalls: [],
      refreshCalls: [],
      createAttempts: 0,
    };
    const app = createTestApp(state);
    await env.CONTROL_DB.prepare(
      "UPDATE memberships SET role = 'member', updated_at = ? WHERE id = 'membership_human'",
    )
      .bind(observedAt)
      .run();
    await env.CONTROL_DB.prepare(
      "DELETE FROM account_grants WHERE id = 'grant_group_create'",
    ).run();
    const denied = await request(app, "/api/v1/groups", {
      method: "POST",
      body: JSON.stringify(groupBody("group-denied")),
    });
    expect(denied.status).toBe(403);
    expect(state.createAttempts).toBe(0);

    await env.CONTROL_DB.prepare(
      "INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at) VALUES ('grant_group_create', ?, 'membership_human', 'identity_human', 'account_human', 'group.create', 'all_chats', 'active', ?, ?)",
    )
      .bind(tenantId, observedAt, observedAt)
      .run();
    await env.CONTROL_DB.prepare(
      "UPDATE contact_resolution_candidates SET status = 'stale' WHERE contact_id = 'contact_alex_two'",
    ).run();
    const stale = await request(app, "/api/v1/groups", {
      method: "POST",
      body: JSON.stringify(groupBody("group-stale")),
    });
    expect(stale.status).toBe(400);
    expect(state.createAttempts).toBe(0);
  });

  it("reconciles event and refresh evidence, and leaves mismatches or timeout human-action-required", async () => {
    for (const [mode, expectedPath] of [
      ["event", "event"],
      ["refresh", "refresh"],
    ] as const) {
      const state: GroupProviderState = {
        mode,
        createCalls: [],
        observeCalls: [],
        refreshCalls: [],
        createAttempts: 0,
      };
      const app = createTestApp(state);
      const response = await request(app, "/api/v1/groups", {
        method: "POST",
        body: JSON.stringify(groupBody(`group-${mode}`)),
      });
      const body = (await response.json()) as Record<string, any>;
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body.status, JSON.stringify(body)).toBe("created");
      expect(body.evidence_path).toBe(expectedPath);
      expect(state.createAttempts).toBe(1);
      expect(state.observeCalls).toHaveLength(1);
      if (mode === "refresh") expect(state.refreshCalls).toHaveLength(1);
      else expect(state.refreshCalls).toHaveLength(0);
    }

    const mismatchState: GroupProviderState = {
      mode: "mismatch",
      createCalls: [],
      observeCalls: [],
      refreshCalls: [],
      createAttempts: 0,
    };
    const mismatchApp = createTestApp(mismatchState);
    const mismatchResponse = await request(mismatchApp, "/api/v1/groups", {
      method: "POST",
      body: JSON.stringify(groupBody("group-mismatch")),
    });
    const mismatch = (await mismatchResponse.json()) as Record<string, any>;
    expect(mismatchResponse.status).toBe(200);
    expect(mismatch).toMatchObject({
      status: "human_action_required",
      duplicate_risk: true,
      human_action_required: true,
      provider_group_id: null,
    });
    expect(
      await env.CONTROL_DB.prepare(
        "SELECT COUNT(*) AS count FROM group_creation_access_grants WHERE tenant_id = ? AND operation_id = ?",
      )
        .bind(tenantId, mismatch.operation_id)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });

    const timeoutState: GroupProviderState = {
      mode: "timeout",
      createCalls: [],
      observeCalls: [],
      refreshCalls: [],
      createAttempts: 0,
    };
    const timeoutApp = createTestApp(timeoutState);
    const timeoutRequest = groupBody("group-timeout");
    const timeoutResponse = await request(timeoutApp, "/api/v1/groups", {
      method: "POST",
      body: JSON.stringify(timeoutRequest),
    });
    const timeout = (await timeoutResponse.json()) as Record<string, any>;
    expect(timeoutResponse.status).toBe(200);
    expect(timeout.status).toBe("human_action_required");
    const replay = await request(timeoutApp, "/api/v1/groups", {
      method: "POST",
      body: JSON.stringify(timeoutRequest),
    });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as Record<string, any>).status).toBe(
      "human_action_required",
    );
    expect(timeoutState.createAttempts).toBe(1);
  });

  it("does not revive revoked all-chat or selected-chat access outside the new group", async () => {
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        "UPDATE account_grants SET status = 'revoked', revoked_at = ? WHERE id = 'grant_fixture_human'",
      ).bind(observedAt),
      env.CONTROL_DB.prepare(
        "INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at, revoked_at) VALUES ('grant_revoked_send', ?, 'membership_human', 'identity_human', 'account_human', 'message.send', 'selected_chats', 'revoked', ?, ?, ?)",
      ).bind(tenantId, observedAt, observedAt, observedAt),
      env.CONTROL_DB.prepare(
        "INSERT INTO account_grant_chats (grant_id, tenant_id, account_id, chat_id, created_at) VALUES ('grant_revoked_send', ?, 'account_human', 'conversation_unrelated', ?)",
      ).bind(tenantId, observedAt),
    ]);
    const state: GroupProviderState = {
      mode: "provider",
      createCalls: [],
      observeCalls: [],
      refreshCalls: [],
      createAttempts: 0,
    };
    const app = createTestApp(state);
    const response = await request(app, "/api/v1/groups", {
      method: "POST",
      body: JSON.stringify(groupBody("group-revoked-grants")),
    });
    const body = (await response.json()) as Record<string, any>;
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe("created");
    const grants = await env.CONTROL_DB.prepare(
      "SELECT id, operation_scope, chat_scope, status, revoked_at FROM account_grants WHERE tenant_id = ? AND membership_id = ? AND identity_id = ? AND account_id = ? AND operation_scope IN ('conversation.read', 'message.send') ORDER BY operation_scope",
    )
      .bind(tenantId, "membership_human", "identity_human", "account_human")
      .all();
    expect(grants.results).toEqual([
      {
        id: "grant_fixture_human",
        operation_scope: "conversation.read",
        chat_scope: "selected_chats",
        status: "active",
        revoked_at: null,
      },
      {
        id: "grant_revoked_send",
        operation_scope: "message.send",
        chat_scope: "selected_chats",
        status: "active",
        revoked_at: null,
      },
    ]);
    const chats = await env.CONTROL_DB.prepare(
      "SELECT grant_id, chat_id FROM account_grant_chats WHERE tenant_id = ? AND grant_id IN ('grant_fixture_human', 'grant_revoked_send') ORDER BY grant_id, chat_id",
    )
      .bind(tenantId)
      .all();
    expect(chats.results).toEqual([
      { grant_id: "grant_fixture_human", chat_id: body.conversation_id },
      { grant_id: "grant_revoked_send", chat_id: body.conversation_id },
    ]);
  });

  it("reconciles a post-provider persistence uncertainty after reopening without another create", async () => {
    await env.CONTROL_DB.prepare(
      `INSERT INTO webhook_subscriptions
       (id, tenant_id, creation_idempotency_key, owner_principal_id,
        creator_principal_id, creator_membership_id, creator_identity_id,
        ownership_mode, destination_url, destination_version,
        event_filter_json, global_enabled, status, created_at, updated_at,
        revoked_at)
       VALUES ('webhook_malformed_group', ?, 'webhook-malformed-group',
               'principal_human', 'principal_human', 'membership_human',
               'identity_human', 'human_owner', 'https://malformed.example.test/hook',
               1, '{}', 1, 'active', ?, ?, NULL)`,
    )
      .bind(tenantId, observedAt, observedAt)
      .run();
    const state: GroupProviderState = {
      mode: "provider",
      createCalls: [],
      observeCalls: [],
      refreshCalls: [],
      createAttempts: 0,
    };
    const app = createTestApp(state);
    const bodyInput = groupBody("group-persistence-recovery");
    const firstResponse = await request(app, "/api/v1/groups", {
      method: "POST",
      body: JSON.stringify(bodyInput),
    });
    const first = (await firstResponse.json()) as Record<string, any>;
    expect(firstResponse.status).toBe(200);
    expect(first).toMatchObject({
      status: "human_action_required",
      failure_code: "group_creation_persistence_uncertain",
      duplicate_risk: true,
    });
    expect(state.createAttempts).toBe(1);

    await env.CONTROL_DB.prepare(
      "UPDATE webhook_subscriptions SET event_filter_json = ? WHERE tenant_id = ? AND id = ?",
    )
      .bind(
        JSON.stringify({ event_types: ["group.created"] }),
        tenantId,
        "webhook_malformed_group",
      )
      .run();
    state.mode = "event";
    const reopenedApp = createTestApp(state);
    const recoveredResponse = await request(reopenedApp, "/api/v1/groups", {
      method: "POST",
      body: JSON.stringify(bodyInput),
    });
    const recovered = (await recoveredResponse.json()) as Record<string, any>;
    expect(recoveredResponse.status, JSON.stringify(recovered)).toBe(200);
    expect(recovered).toMatchObject({
      status: "created",
      evidence_path: "event",
    });
    expect(state.createAttempts).toBe(1);
    expect(state.observeCalls).toHaveLength(1);
  });

  it("reopens stale pending work with evidence-only reconciliation and never creates twice", async () => {
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    let releaseResolve: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const state: GroupProviderState = {
      mode: "provider",
      createCalls: [],
      observeCalls: [],
      refreshCalls: [],
      createAttempts: 0,
      createStarted: () => startedResolve?.(),
      releaseCreate: release,
      now: new Date(observedAt),
    };
    const app = createTestApp(state);
    const firstRequest = request(app, "/api/v1/groups", {
      method: "POST",
      body: JSON.stringify(groupBody("group-restart")),
    });
    await started;
    const operation = await env.CONTROL_DB.prepare(
      "SELECT operation_id FROM group_creation_operations WHERE tenant_id = ? AND idempotency_key = ?",
    )
      .bind(tenantId, "group-restart")
      .first<{ operation_id: string }>();
    expect(operation).not.toBeNull();
    await env.CONTROL_DB.prepare(
      "UPDATE group_creation_operations SET updated_at = ? WHERE tenant_id = ? AND idempotency_key = ?",
    )
      .bind(oldObservedAt, tenantId, "group-restart")
      .run();
    state.mode = "event";
    state.now = new Date("2026-09-14T00:01:00.000Z");
    const recoveredApp = createTestApp(state);
    const recoveredResponse = await request(recoveredApp, "/api/v1/groups", {
      method: "POST",
      body: JSON.stringify(groupBody("group-restart")),
    });
    const recoveredText = await recoveredResponse.text();
    const recovered = JSON.parse(recoveredText) as Record<string, any>;
    expect(recoveredResponse.status, recoveredText).toBe(200);
    expect(recovered.status).toBe("created");
    expect(recovered.evidence_path).toBe("event");
    expect(state.createAttempts).toBe(1);
    expect(state.observeCalls).toHaveLength(1);
    releaseResolve?.();
    const firstResponse = await firstRequest;
    expect(firstResponse.status).toBe(200);
    expect(((await firstResponse.json()) as Record<string, any>).status).toBe(
      "created",
    );
    expect(
      await env.CONTROL_DB.prepare(
        "SELECT COUNT(*) AS count FROM group_creation_access_grants WHERE tenant_id = ? AND operation_id = ?",
      )
        .bind(tenantId, operation?.operation_id)
        .first<{ count: number }>(),
    ).toEqual({ count: 2 });
  });
});

describe("group gateway evidence validation", () => {
  it("rejects a successful response that lacks explicit correlation evidence", async () => {
    const envWithGateway = {
      CONNECTION_GATEWAY_URL: "https://gateway.example.test",
      CONNECTION_GATEWAY_TOKEN: "group-test-secret-0123456789",
    } as unknown as Cloudflare.Env;
    const provider = new HttpGroupProvider(
      envWithGateway,
      async () =>
        new Response(
          JSON.stringify({
            id: "provider_group_missing_evidence",
            mxid: "!missing-evidence:example.test",
            name: "Alex Room",
            participants: [...participantIds],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const input: GroupProviderInput = {
      route: {
        tenant_id: tenantId,
        identity_id: "identity_human",
        account_id: "account_human",
        connection_id: "connection_human_whatsapp",
        provider: "whatsapp",
        session_generation: observedAt,
        gateway_route_id: "gateway_route_human",
        bridge_instance_id: "bridge-human",
        matrix_user_id: "route-user-human",
        matrix_room_namespace: "route-room-human",
        provider_login_id: "login-human-group",
      },
      operation_id: "group_create_missing_evidence",
      conversation_id: "conversation_group_missing_evidence",
      idempotency_key: "group-missing-evidence",
    };
    await expect(
      provider.createGroup(input, "Alex Room", participantIds),
    ).rejects.toMatchObject({
      code: "uncertain",
    } satisfies Partial<GroupProviderError>);
  });
});
