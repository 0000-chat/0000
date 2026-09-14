import { env as runtimeEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { VerifiedSubject } from "../auth/oidc";
import {
  GroupProviderError,
  HttpGroupProvider,
  type GroupManagementProviderInput,
  type GroupProvider,
  type ManagedProviderGroup,
} from "../groups/provider";
import {
  clearDirectory,
  seedAccountAccess,
  seedDirectory,
} from "./support/directory-fixtures";

const env = runtimeEnv as typeof runtimeEnv & { CONTROL_DB: D1Database };
const tenantId = "tenant_pilot";
const timestamp = "2026-09-14T00:00:00.000Z";
const conversationId = "conversation_group_manage";
const providerGroupId = "provider_group_manage";
const matrixRoomId = "!group-manage:example.test";
const accountId = "account_human";
const identityId = "identity_human";
const connectionId = "connection_human_whatsapp";

type ManagementMode =
  | "provider"
  | "event"
  | "refresh"
  | "timeout"
  | "mismatch"
  | "rejected";

type ManagementState = {
  mode: ManagementMode;
  providerCalls: GroupManagementProviderInput[];
  observeCalls: GroupManagementProviderInput[];
  refreshCalls: GroupManagementProviderInput[];
  beforeProvider?: (input: GroupManagementProviderInput) => Promise<void>;
};

const managementEvidence = (
  input: GroupManagementProviderInput,
  source: "provider" | "event" | "refresh",
  name: string,
  members: readonly string[],
  overrides: Partial<ManagedProviderGroup["evidence"]> = {},
) => ({
  source,
  evidence_id: `management-${source}-${input.operation_id}`,
  observed_at: timestamp,
  operation_id: input.operation_id,
  account_id: input.route.account_id,
  connection_id: input.route.connection_id,
  provider_group_id: input.provider_group_id,
  matrix_room_id: input.matrix_room_id,
  revision: "2",
  name,
  member_provider_ids: [...members],
  status: "confirmed" as const,
  reason: null,
  accepted: true,
  ...overrides,
});

const managedGroup = (
  input: GroupManagementProviderInput,
  source: "provider" | "event" | "refresh",
  overrides: Partial<ManagedProviderGroup> = {},
): ManagedProviderGroup => {
  const members =
    input.action === "add_participants"
      ? ["provider_member_a", ...input.requested_member_provider_ids]
      : input.action === "remove_participants"
        ? input.requested_member_provider_ids.includes("provider_member_b")
          ? ["provider_member_a"]
          : []
        : ["provider_member_a"];
  const name = input.requested_name ?? "Team";
  const revision = input.expected_revision === "1" ? "2" : "3";
  return {
    provider_group_id: input.provider_group_id,
    matrix_room_id: input.matrix_room_id,
    name,
    revision,
    member_provider_ids: members,
    evidence: managementEvidence(input, source, name, members, { revision }),
    ...overrides,
  };
};

const providerFor = (state: ManagementState): GroupProvider => {
  const apply = async (
    input: GroupManagementProviderInput,
  ): Promise<ManagedProviderGroup> => {
    state.providerCalls.push(input);
    await state.beforeProvider?.(input);
    if (
      state.mode === "timeout" ||
      state.mode === "event" ||
      state.mode === "refresh"
    ) {
      throw new GroupProviderError("unavailable");
    }
    if (state.mode === "rejected") throw new GroupProviderError("rejected");
    if (state.mode === "mismatch") {
      return managedGroup(input, "provider", {
        evidence: managementEvidence(
          input,
          "provider",
          input.requested_name ?? "Team",
          ["provider_member_a"],
          { account_id: "account_other" },
        ),
      });
    }
    return managedGroup(input, "provider");
  };

  return {
    async createGroup() {
      throw new Error("group creation is not part of this fixture");
    },
    async observeGroup() {
      return null;
    },
    async refreshGroup() {
      return null;
    },
    async renameGroup(input) {
      return apply(input);
    },
    async addGroupParticipants(input) {
      return apply(input);
    },
    async removeGroupParticipants(input) {
      return apply(input);
    },
    async observeManagedGroup(input) {
      state.observeCalls.push(input);
      if (state.mode === "event") return managedGroup(input, "event");
      return null;
    },
    async refreshManagedGroup(input) {
      state.refreshCalls.push(input);
      if (state.mode === "refresh") return managedGroup(input, "refresh");
      return null;
    },
  } satisfies GroupProvider;
};

const createTestApp = (state: ManagementState) =>
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
      now: () => new Date(timestamp),
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

const renameBody = (idempotencyKey: string, expectedRevision = "1") => ({
  conversation_id: conversationId,
  identity_id: identityId,
  account_id: accountId,
  name: "Renamed Team",
  expected_revision: expectedRevision,
  idempotency_key: idempotencyKey,
});

const participant = (contactId: string, revision: string) => ({
  contact_id: contactId,
  candidate_revision: revision,
});

const addBody = (idempotencyKey: string, expectedRevision = "1") => ({
  conversation_id: conversationId,
  identity_id: identityId,
  account_id: accountId,
  participants: [participant("contact_member_b", "b".repeat(64))],
  expected_revision: expectedRevision,
  idempotency_key: idempotencyKey,
});

async function seedManagementDirectory(): Promise<void> {
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "INSERT INTO connection_provider_identities (tenant_id, provider, identity_key, provider_login_id, connection_id, link_session_id, created_at) VALUES (?, 'whatsapp', ?, ?, ?, ?, ?)",
    ).bind(
      tenantId,
      "e".repeat(64),
      "login-human-management",
      connectionId,
      "link-management-human",
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO provider_capability_records (tenant_id, account_id, connection_id, identity_id, provider, capability, status, freshness, proof_source, provider_evidence_json, product_claim, observed_at, updated_at) VALUES (?, ?, ?, ?, 'whatsapp', 'group.manage', 'supported', 'fresh', ?, ?, ?, ?, ?)",
    ).bind(
      tenantId,
      accountId,
      connectionId,
      identityId,
      "group-management-test",
      JSON.stringify({ capability: "group.manage", account_id: accountId }),
      "Provider group management is available",
      timestamp,
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES (?, 'membership_human', ?, 'group.manage', ?)",
    ).bind(tenantId, identityId, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at) VALUES (?, ?, 'membership_human', ?, ?, 'group.manage', 'all_chats', 'active', ?, ?)",
    ).bind(
      "grant_group_manage",
      tenantId,
      identityId,
      accountId,
      timestamp,
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      `INSERT INTO group_management_groups (
         tenant_id, identity_id, account_id, connection_id, provider,
         conversation_id, provider_group_id, matrix_room_id, name,
         current_revision, current_member_provider_ids_json,
         current_evidence_json, active_operation_id, active_claim_expires_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'whatsapp', ?, ?, ?, 'Team', '1', ?, NULL, NULL, NULL, ?, ?)`,
    ).bind(
      tenantId,
      identityId,
      accountId,
      connectionId,
      conversationId,
      providerGroupId,
      matrixRoomId,
      JSON.stringify(["provider_member_a"]),
      timestamp,
      timestamp,
    ),
    ...[
      ["contact_member_a", "provider_member_a", "a".repeat(64), "+15550000101"],
      ["contact_member_b", "provider_member_b", "b".repeat(64), "+15550000102"],
    ].map(([contactId, providerId, revision, phone]) =>
      env.CONTROL_DB.prepare(
        `INSERT INTO contact_resolution_candidates (
           contact_id, tenant_id, identity_id, account_id, connection_id,
           provider, provider_id, current_lid, display_name, identifiers_json,
           stable_key, match_reason, candidate_revision, observed_at,
           evidence_json, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'whatsapp', ?, ?, 'Member', ?, ?, 'name', ?, ?, ?, 'active', ?, ?)`,
      ).bind(
        contactId,
        tenantId,
        identityId,
        accountId,
        connectionId,
        providerId,
        `${providerId}@lid`,
        JSON.stringify([phone, `${providerId}@lid`]),
        phone,
        revision,
        timestamp,
        JSON.stringify({
          source: "provider",
          operation: "resolve",
          evidence_id: `candidate-${contactId}`,
          observed_at: timestamp,
          provider_id: providerId,
          matrix_room_id: null,
          status: "confirmed",
          reason: null,
        }),
        timestamp,
        timestamp,
      ),
    ),
  ]);
}

beforeEach(async () => {
  await clearDirectory(env.CONTROL_DB);
  await seedDirectory(env.CONTROL_DB);
  await seedAccountAccess(env.CONTROL_DB);
  await seedManagementDirectory();
});

describe("group management operation boundaries", () => {
  it("persists before provider I/O, applies rename, replays idempotently, and exposes evidence", async () => {
    let durableBeforeProvider = false;
    const state: ManagementState = {
      mode: "provider",
      providerCalls: [],
      observeCalls: [],
      refreshCalls: [],
      beforeProvider: async (input) => {
        const row = await env.CONTROL_DB.prepare(
          "SELECT status, active_operation_id FROM group_management_operations o JOIN group_management_groups g ON g.tenant_id = o.tenant_id AND g.conversation_id = o.conversation_id WHERE o.tenant_id = ? AND o.operation_id = ?",
        )
          .bind(tenantId, input.operation_id)
          .first<{ status: string; active_operation_id: string | null }>();
        durableBeforeProvider =
          row?.status === "pending" &&
          row.active_operation_id === input.operation_id;
      },
    };
    const app = createTestApp(state);
    const body = renameBody("rename-durable");
    const response = await request(app, `/api/v1/groups/${conversationId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as Record<string, any>;
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result).toMatchObject({
      status: "succeeded",
      action: "rename",
      evidence_path: "provider",
      result_revision: "2",
      current_name: "Renamed Team",
    });
    expect(durableBeforeProvider).toBe(true);
    expect(state.providerCalls).toHaveLength(1);

    const replay = await request(app, `/api/v1/groups/${conversationId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    const replayResult = (await replay.json()) as Record<string, any>;
    expect(replay.status, JSON.stringify(replayResult)).toBe(200);
    expect(replayResult.operation_id).toBe(result.operation_id);
    expect(state.providerCalls).toHaveLength(1);

    const evidenceResponse = await request(
      app,
      `/api/v1/group-management/operations/${result.operation_id}/evidence`,
      { method: "GET" },
    );
    const evidence = (await evidenceResponse.json()) as Array<
      Record<string, any>
    >;
    expect(evidenceResponse.status, JSON.stringify(evidence)).toBe(200);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ source: "provider", accepted: true });
  });

  it("requires both identity and account group.manage authority before provider I/O", async () => {
    const state: ManagementState = {
      mode: "provider",
      providerCalls: [],
      observeCalls: [],
      refreshCalls: [],
    };
    const app = createTestApp(state);
    await env.CONTROL_DB.prepare(
      "UPDATE account_grants SET status = 'revoked', revoked_at = ? WHERE id = 'grant_group_manage'",
    )
      .bind(timestamp)
      .run();
    const revoked = await request(app, `/api/v1/groups/${conversationId}`, {
      method: "PATCH",
      body: JSON.stringify(renameBody("rename-revoked")),
    });
    expect(revoked.status).toBe(403);
    expect(state.providerCalls).toHaveLength(0);

    await env.CONTROL_DB.prepare(
      "UPDATE account_grants SET status = 'active', revoked_at = NULL WHERE id = 'grant_group_manage'",
    ).run();
    await env.CONTROL_DB.prepare(
      "DELETE FROM identity_grants WHERE tenant_id = ? AND membership_id = 'membership_human' AND identity_id = ? AND operation_scope = 'group.manage'",
    )
      .bind(tenantId, identityId)
      .run();
    const missingIdentityScope = await request(
      app,
      `/api/v1/groups/${conversationId}`,
      { method: "PATCH", body: JSON.stringify(renameBody("rename-no-scope")) },
    );
    expect(missingIdentityScope.status).toBe(403);
    expect(state.providerCalls).toHaveLength(0);
  });

  it("reconciles timeout through event and bounded refresh evidence", async () => {
    const modes = [
      ["event", "event"],
      ["refresh", "refresh"],
    ] as const;
    for (const [index, modeEntry] of modes.entries()) {
      const [mode, evidencePath] = modeEntry;
      if (index > 0) {
        await clearDirectory(env.CONTROL_DB);
        await seedDirectory(env.CONTROL_DB);
        await seedAccountAccess(env.CONTROL_DB);
        await seedManagementDirectory();
      }
      const state: ManagementState = {
        mode,
        providerCalls: [],
        observeCalls: [],
        refreshCalls: [],
      };
      const app = createTestApp(state);
      const response = await request(app, `/api/v1/groups/${conversationId}`, {
        method: "PATCH",
        body: JSON.stringify(renameBody(`rename-${mode}`)),
      });
      const result = (await response.json()) as Record<string, any>;
      expect(response.status, JSON.stringify(result)).toBe(200);
      expect(result).toMatchObject({
        status: "succeeded",
        evidence_path: evidencePath,
      });
      expect(state.providerCalls).toHaveLength(1);
      expect(state.observeCalls).toHaveLength(mode === "event" ? 1 : 1);
      expect(state.refreshCalls).toHaveLength(mode === "refresh" ? 1 : 0);
    }
  });

  it("keeps mismatched provider evidence human-action-required without changing group state", async () => {
    const state: ManagementState = {
      mode: "mismatch",
      providerCalls: [],
      observeCalls: [],
      refreshCalls: [],
    };
    const app = createTestApp(state);
    const response = await request(app, `/api/v1/groups/${conversationId}`, {
      method: "PATCH",
      body: JSON.stringify(renameBody("rename-mismatch")),
    });
    const result = (await response.json()) as Record<string, any>;
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result).toMatchObject({
      status: "human_action_required",
      duplicate_risk: true,
      failure_code: "account_mismatch",
    });
    expect(
      await env.CONTROL_DB.prepare(
        "SELECT name, current_revision, active_operation_id FROM group_management_groups WHERE tenant_id = ? AND conversation_id = ?",
      )
        .bind(tenantId, conversationId)
        .first(),
    ).toEqual({
      name: "Team",
      current_revision: "1",
      active_operation_id: null,
    });
  });

  it("rejects stale revisions and never reports a lost claim as success", async () => {
    const staleState: ManagementState = {
      mode: "provider",
      providerCalls: [],
      observeCalls: [],
      refreshCalls: [],
    };
    const staleApp = createTestApp(staleState);
    const staleResponse = await request(
      staleApp,
      `/api/v1/groups/${conversationId}`,
      {
        method: "PATCH",
        body: JSON.stringify(renameBody("rename-stale", "0")),
      },
    );
    const stale = (await staleResponse.json()) as Record<string, any>;
    expect(staleResponse.status, JSON.stringify(stale)).toBe(200);
    expect(stale).toMatchObject({
      status: "human_action_required",
      failure_code: "group_revision_conflict",
    });
    expect(staleState.providerCalls).toHaveLength(0);

    const lostState: ManagementState = {
      mode: "provider",
      providerCalls: [],
      observeCalls: [],
      refreshCalls: [],
      beforeProvider: async () => {
        await env.CONTROL_DB.prepare(
          "UPDATE group_management_groups SET current_revision = '9', updated_at = ? WHERE tenant_id = ? AND conversation_id = ?",
        )
          .bind(timestamp, tenantId, conversationId)
          .run();
      },
    };
    const lostApp = createTestApp(lostState);
    const lostResponse = await request(
      lostApp,
      `/api/v1/groups/${conversationId}`,
      {
        method: "PATCH",
        body: JSON.stringify(renameBody("rename-lost-claim")),
      },
    );
    const lost = (await lostResponse.json()) as Record<string, any>;
    expect(lostResponse.status, JSON.stringify(lost)).toBe(200);
    expect(lost).toMatchObject({
      status: "human_action_required",
      duplicate_risk: true,
      failure_code: "group_management_persistence_uncertain",
    });
    expect(
      await env.CONTROL_DB.prepare(
        "SELECT status, result_revision FROM group_management_operations WHERE tenant_id = ? AND operation_id = ?",
      )
        .bind(tenantId, lost.operation_id)
        .first(),
    ).toEqual({ status: "human_action_required", result_revision: null });
    expect(
      await env.CONTROL_DB.prepare(
        "SELECT name, current_revision FROM group_management_groups WHERE tenant_id = ? AND conversation_id = ?",
      )
        .bind(tenantId, conversationId)
        .first(),
    ).toEqual({ name: "Team", current_revision: "9" });
  });

  it("adds and removes account-bound contacts with reordered provider snapshots", async () => {
    const state: ManagementState = {
      mode: "provider",
      providerCalls: [],
      observeCalls: [],
      refreshCalls: [],
    };
    const app = createTestApp(state);
    const addResponse = await request(
      app,
      `/api/v1/groups/${conversationId}/participants`,
      { method: "POST", body: JSON.stringify(addBody("add-member")) },
    );
    const added = (await addResponse.json()) as Record<string, any>;
    expect(addResponse.status, JSON.stringify(added)).toBe(200);
    expect(added).toMatchObject({
      status: "succeeded",
      action: "add_participants",
      result_revision: "2",
    });
    expect(added.result_member_provider_ids).toEqual([
      "provider_member_a",
      "provider_member_b",
    ]);

    const removeResponse = await request(
      app,
      `/api/v1/groups/${conversationId}/participants`,
      {
        method: "DELETE",
        body: JSON.stringify({
          ...addBody("remove-member", "2"),
          participants: [participant("contact_member_b", "b".repeat(64))],
        }),
      },
    );
    const removed = (await removeResponse.json()) as Record<string, any>;
    expect(removeResponse.status, JSON.stringify(removed)).toBe(200);
    expect(removed).toMatchObject({
      status: "succeeded",
      action: "remove_participants",
      result_revision: "3",
    });
    expect(removed.result_member_provider_ids).toEqual(["provider_member_a"]);
    expect(state.providerCalls).toHaveLength(2);
  });
});

describe("group management gateway envelope", () => {
  it("sends only the pinned strict management request fields", async () => {
    let sent: Record<string, any> | undefined;
    const input: GroupManagementProviderInput = {
      route: {
        tenant_id: tenantId,
        identity_id: identityId,
        account_id: accountId,
        connection_id: connectionId,
        provider: "whatsapp",
        session_generation: timestamp,
        gateway_route_id: "gateway_route_human",
        bridge_instance_id: "bridge-human",
        matrix_user_id: "route-user-human",
        matrix_room_namespace: "route-room-human",
        provider_login_id: "login-human-management",
      },
      operation_id: "group_manage_envelope",
      conversation_id: conversationId,
      idempotency_key: "group_manage_envelope",
      provider_group_id: providerGroupId,
      matrix_room_id: matrixRoomId,
      expected_revision: "1",
      action: "rename",
      operation_created_at: timestamp,
      requested_name: "Renamed Team",
      requested_member_provider_ids: [],
    };
    const responsePayload = {
      id: providerGroupId,
      mxid: matrixRoomId,
      name: "Renamed Team",
      revision: "2",
      members: ["provider_member_a"],
      evidence: {
        source: "provider",
        evidence_id: "management-envelope-evidence",
        observed_at: timestamp,
        operation_id: input.operation_id,
        account_id: accountId,
        connection_id: connectionId,
        provider_group_id: providerGroupId,
        matrix_room_id: matrixRoomId,
        revision: "2",
        name: "Renamed Team",
        member_provider_ids: ["provider_member_a"],
        status: "confirmed",
        reason: null,
      },
    };
    const provider = new HttpGroupProvider(
      {
        CONNECTION_GATEWAY_URL: "https://gateway.example.test",
        CONNECTION_GATEWAY_TOKEN: "group-management-secret-0123456789",
      } as unknown as Cloudflare.Env,
      async (_url, init) => {
        sent = JSON.parse(String(init?.body)) as Record<string, any>;
        return new Response(JSON.stringify(responsePayload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    const result = await provider.renameGroup(input, "Renamed Team");
    expect(result.revision).toBe("2");
    expect(sent).toMatchObject({
      action: "rename",
      name: "Renamed Team",
      operation_created_at: timestamp,
      expected_revision: "1",
    });
    expect(sent).not.toHaveProperty("requested_name");
    expect(sent).not.toHaveProperty("requested_member_provider_ids");
  });
});
