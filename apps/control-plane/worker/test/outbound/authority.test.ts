import { env as runtimeEnv } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { describe, expect, it } from "vitest";
import {
  claimOutboundDispatch,
  finalizeOutboundAcceptance,
  markOutboundDispatchClaimUncertain,
  readOutboundAcceptanceReservation,
  reserveOutboundAcceptance,
} from "../../outbound/authority";
import {
  claimPrivateAuthority,
  reservePrivateAuthority,
} from "../../outbound/private-authority";
import type {
  ClaimOutboundDispatchInput,
  FinalizeOutboundAcceptanceInput,
  OutboundAcceptanceReservation,
  OutboundAcceptanceReservationResult,
  OutboundCapability,
  OutboundTuple,
  ReserveOutboundAcceptanceInput,
} from "../../outbound/authority-types";
import type {
  PrivateAuthorityClaimInput,
  PrivateAuthorityReservationInput,
  PrivateAuthorityScope,
} from "../../outbound/authority-types";

const env = runtimeEnv as typeof runtimeEnv & {
  CONTROL_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};

const timestamp = "2026-09-14T00:00:00.000Z";
const later = "2026-09-14T00:00:01.000Z";
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);

type Fixture = OutboundTuple & {
  tenant_id: string;
  agent_membership_id: string;
  agent_identity_id: string;
  owner_membership_id: string;
  owner_identity_id: string;
  grant_id: string;
  read_grant_id: string;
  owner_account_id: string;
  owner_connection_id: string;
  owner_conversation_id: string;
  owner_capability: OutboundCapability;
  grant_capability: OutboundCapability;
  conversation_id: string;
};

const fixtureTuple = (fixture: Fixture): OutboundTuple => ({
  tenant_id: fixture.tenant_id,
  membership_id: fixture.membership_id,
  identity_id: fixture.identity_id,
  account_id: fixture.account_id,
  conversation_id: fixture.conversation_id,
  connection_id: fixture.connection_id,
});

async function seedFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const tenantId = `tenant_authority_${suffix}`;
  const agentPrincipalId = `principal_agent_${suffix}`;
  const ownerPrincipalId = `principal_owner_${suffix}`;
  const agentMembershipId = `membership_agent_${suffix}`;
  const ownerMembershipId = `membership_owner_${suffix}`;
  const agentIdentityId = `identity_agent_${suffix}`;
  const ownerIdentityId = `identity_owner_${suffix}`;
  const gatewayId = `gateway_${suffix}`;
  const connectionId = `connection_${suffix}`;
  const accountId = `account_${suffix}`;
  const ownerConnectionId = `connection_owner_${suffix}`;
  const ownerAccountId = `account_owner_${suffix}`;
  const grantId = `grant_send_${suffix}`;
  const readGrantId = `grant_read_${suffix}`;
  const conversationId = `conversation_${suffix}`;
  const ownerConversationId = `conversation_owner_${suffix}`;
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
    ).bind(tenantId, suffix, "Authority test", timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'agent', ?, 'active', ?, ?)",
    ).bind(
      agentPrincipalId,
      "https://authority.test/",
      `agent-${suffix}`,
      "Agent",
      timestamp,
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'human', ?, 'active', ?, ?)",
    ).bind(
      ownerPrincipalId,
      "https://authority.test/",
      `owner-${suffix}`,
      "Owner",
      timestamp,
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'member', 'active', ?, ?)",
    ).bind(agentMembershipId, tenantId, agentPrincipalId, timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'owner', 'active', ?, ?)",
    ).bind(ownerMembershipId, tenantId, ownerPrincipalId, timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO identities (id, tenant_id, identity_kind, display_name, status, created_at, updated_at) VALUES (?, ?, 'agent', ?, 'active', ?, ?)",
    ).bind(agentIdentityId, tenantId, "Agent identity", timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO identities (id, tenant_id, identity_kind, display_name, status, created_at, updated_at) VALUES (?, ?, 'human', ?, 'active', ?, ?)",
    ).bind(ownerIdentityId, tenantId, "Owner identity", timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES (?, ?, ?, 'message.send', ?)",
    ).bind(tenantId, agentMembershipId, agentIdentityId, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO gateway_routes (id, service_principal_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
    ).bind(gatewayId, ownerPrincipalId, timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, 'whatsapp', ?, 'ready', ?, ?)",
    ).bind(
      connectionId,
      tenantId,
      agentIdentityId,
      "Authority connection",
      timestamp,
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, 'whatsapp', ?, 'ready', ?, ?)",
    ).bind(
      ownerConnectionId,
      tenantId,
      ownerIdentityId,
      "Owner connection",
      timestamp,
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      connectionId,
      gatewayId,
      `bridge-${suffix}`,
      `user-${suffix}`,
      `room-${suffix}`,
      timestamp,
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      ownerConnectionId,
      gatewayId,
      `bridge-owner-${suffix}`,
      `user-owner-${suffix}`,
      `room-owner-${suffix}`,
      timestamp,
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
    ).bind(accountId, connectionId, timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
    ).bind(ownerAccountId, ownerConnectionId, timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at, revoked_at) VALUES (?, ?, ?, ?, ?, 'message.send', 'all_chats', 'active', ?, ?, NULL)",
    ).bind(
      grantId,
      tenantId,
      agentMembershipId,
      agentIdentityId,
      accountId,
      timestamp,
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at, revoked_at) VALUES (?, ?, ?, ?, ?, 'conversation.read', 'all_chats', 'active', ?, ?, NULL)",
    ).bind(
      readGrantId,
      tenantId,
      agentMembershipId,
      agentIdentityId,
      accountId,
      timestamp,
      timestamp,
    ),
  ]);
  const grant = await env.CONTROL_DB.prepare(
    "SELECT authorization_epoch FROM account_grants WHERE tenant_id = ? AND id = ?",
  )
    .bind(tenantId, grantId)
    .first<{ authorization_epoch: number }>();
  const owner = await env.CONTROL_DB.prepare(
    "SELECT authority_epoch FROM memberships WHERE tenant_id = ? AND id = ?",
  )
    .bind(tenantId, ownerMembershipId)
    .first<{ authority_epoch: number }>();
  if (grant === null || owner === null)
    throw new Error("fixture epoch missing");
  return {
    tenant_id: tenantId,
    membership_id: agentMembershipId,
    identity_id: agentIdentityId,
    account_id: accountId,
    conversation_id: conversationId,
    connection_id: connectionId,
    agent_membership_id: agentMembershipId,
    agent_identity_id: agentIdentityId,
    owner_membership_id: ownerMembershipId,
    owner_identity_id: ownerIdentityId,
    grant_id: grantId,
    read_grant_id: readGrantId,
    owner_account_id: ownerAccountId,
    owner_connection_id: ownerConnectionId,
    owner_conversation_id: ownerConversationId,
    grant_capability: {
      kind: "account_grant",
      grant_id: grantId,
      authorization_epoch: grant.authorization_epoch,
    },
    owner_capability: {
      kind: "owner_admin",
      authority_id: ownerMembershipId,
      authority_epoch: owner.authority_epoch,
    },
  };
}

const reserveInput = (
  fixture: Fixture,
  overrides: Partial<ReserveOutboundAcceptanceInput> = {},
): ReserveOutboundAcceptanceInput => ({
  ...fixtureTuple(fixture),
  idempotency_key: `accept-${crypto.randomUUID()}`,
  request_digest: digestA,
  body_digest: digestB,
  capability: fixture.grant_capability,
  now: timestamp,
  ...overrides,
});

const finalizeInput = (
  fixture: Fixture,
  reservation: OutboundAcceptanceReservation,
  overrides: Partial<FinalizeOutboundAcceptanceInput> = {},
): FinalizeOutboundAcceptanceInput => ({
  ...fixtureTuple(fixture),
  grant_id: reservation.grant_id,
  capability: reservation.capability,
  reservation_id: reservation.id,
  idempotency_key: reservation.idempotency_key,
  request_digest: reservation.request_digest,
  body_digest: reservation.body_digest,
  command_id: `command-${reservation.id}`,
  message_id: `message-${reservation.id}`,
  dispatch_id: `dispatch-${reservation.id}`,
  transaction_id: `transaction-${reservation.id}`,
  now: later,
  ...overrides,
});

const claimInput = (
  fixture: Fixture,
  reservation: OutboundAcceptanceReservation,
  overrides: Partial<ClaimOutboundDispatchInput> = {},
): ClaimOutboundDispatchInput => ({
  ...fixtureTuple(fixture),
  grant_id: reservation.grant_id,
  capability: reservation.capability,
  reservation_id: reservation.id,
  command_id: reservation.command_id ?? `command-${reservation.id}`,
  dispatch_id: reservation.dispatch_id ?? `dispatch-${reservation.id}`,
  transaction_id: reservation.transaction_id ?? `transaction-${reservation.id}`,
  request_digest: reservation.request_digest,
  body_digest: reservation.body_digest,
  now: later,
  expires_at: "2026-09-14T00:01:00.000Z",
  ...overrides,
});

const requireReservation = (
  result: OutboundAcceptanceReservationResult,
): OutboundAcceptanceReservation => {
  if (result.status !== "reserved") throw new Error(result.reason);
  return result.reservation;
};

type PrivateOperationFixture = {
  scope: PrivateAuthorityScope;
  operation_id: string;
  request_hash: string;
  session_generation: string;
  tuple: OutboundTuple;
  capability: OutboundCapability;
};

const privateTuple = (fixture: Fixture, owner: boolean): OutboundTuple =>
  owner
    ? {
        tenant_id: fixture.tenant_id,
        membership_id: fixture.owner_membership_id,
        identity_id: fixture.owner_identity_id,
        account_id: fixture.owner_account_id,
        conversation_id: fixture.owner_conversation_id,
        connection_id: fixture.owner_connection_id,
      }
    : fixtureTuple(fixture);

async function seedPrivateOperation(
  fixture: Fixture,
  scope: PrivateAuthorityScope,
  tuple: OutboundTuple = fixtureTuple(fixture),
  capability?: OutboundCapability,
): Promise<PrivateOperationFixture> {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const operationId = `operation_${scope.replaceAll(".", "_")}_${suffix}`;
  const requestHash =
    `${scope === "receipt.send" ? "d" : scope === "group.create" ? "e" : "f"}`.repeat(
      64,
    );
  let effectiveCapability = capability;
  const statements: D1PreparedStatement[] = [];
  if (effectiveCapability === undefined) {
    const grantId = `grant_${scope.replaceAll(".", "_")}_${suffix}`;
    statements.push(
      env.CONTROL_DB.prepare(
        "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        tuple.tenant_id,
        tuple.membership_id,
        tuple.identity_id,
        scope,
        timestamp,
      ),
      env.CONTROL_DB.prepare(
        "INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, 'all_chats', 'active', ?, ?, NULL)",
      ).bind(
        grantId,
        tuple.tenant_id,
        tuple.membership_id,
        tuple.identity_id,
        tuple.account_id,
        scope,
        timestamp,
        timestamp,
      ),
    );
    effectiveCapability = {
      kind: "account_grant",
      grant_id: grantId,
      authorization_epoch: 1,
    };
  }

  if (scope === "receipt.send") {
    statements.push(
      env.CONTROL_DB.prepare(
        `INSERT INTO receipt_operations (
             operation_id, tenant_id, membership_id, identity_id, account_id,
             connection_id, conversation_id, message_id, matrix_room_id,
             matrix_event_id, request_hash, idempotency_key, status,
             matrix_stage, bridge_stage, provider_stage, failure_code,
             failure_reason, evidence_json, requested_at, updated_at, session_generation
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 'requested',
                     'unknown', 'unknown', 'unknown', NULL, NULL, '[]', ?, ?, ?)`,
      ).bind(
        operationId,
        tuple.tenant_id,
        tuple.membership_id,
        tuple.identity_id,
        tuple.account_id,
        tuple.connection_id,
        tuple.conversation_id,
        `message_${suffix}`,
        requestHash,
        `receipt_key_${suffix}`,
        timestamp,
        timestamp,
        timestamp,
      ),
    );
  } else if (scope === "group.create") {
    statements.push(
      env.CONTROL_DB.prepare(
        `INSERT INTO group_creation_operations (
             operation_id, tenant_id, membership_id, identity_id, account_id,
             connection_id, provider, conversation_id, idempotency_key,
             request_hash, name, participant_contacts_json,
             participant_provider_ids_json, status, provider_group_id,
             matrix_room_id, evidence_json, evidence_path, duplicate_risk,
             human_action_required, failure_code, created_at, updated_at,
             session_generation
           ) VALUES (?, ?, ?, ?, ?, ?, 'whatsapp', ?, ?, ?, 'Test group',
                     '[]', '[]', 'pending', NULL, NULL, NULL, NULL, 0, 0,
                     NULL, ?, ?, ?)`,
      ).bind(
        operationId,
        tuple.tenant_id,
        tuple.membership_id,
        tuple.identity_id,
        tuple.account_id,
        tuple.connection_id,
        tuple.conversation_id,
        `group_create_key_${suffix}`,
        requestHash,
        timestamp,
        timestamp,
        timestamp,
      ),
    );
  } else {
    statements.push(
      env.CONTROL_DB.prepare(
        `INSERT INTO group_management_groups (
             tenant_id, identity_id, account_id, connection_id, provider,
             conversation_id, provider_group_id, matrix_room_id, name,
             current_revision, current_member_provider_ids_json,
             current_evidence_json, active_operation_id,
             active_claim_expires_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'whatsapp', ?, ?, ?, 'Test group', 'r1',
                     '[]', NULL, NULL, NULL, ?, ?)`,
      ).bind(
        tuple.tenant_id,
        tuple.identity_id,
        tuple.account_id,
        tuple.connection_id,
        tuple.conversation_id,
        `provider_group_${suffix}`,
        `matrix_room_${suffix}`,
        timestamp,
        timestamp,
      ),
      env.CONTROL_DB.prepare(
        `INSERT INTO group_management_operations (
             operation_id, tenant_id, membership_id, identity_id, account_id,
             connection_id, provider, conversation_id, provider_group_id,
             matrix_room_id, action, requested_name,
             requested_member_provider_ids_json, expected_revision,
             request_hash, idempotency_key, status, result_revision,
             result_member_provider_ids_json, evidence_json, evidence_path,
             duplicate_risk, human_action_required, failure_code, created_at,
             updated_at, session_generation
           ) VALUES (?, ?, ?, ?, ?, ?, 'whatsapp', ?, ?, ?, 'rename', 'New name',
                     '[]', 'r1', ?, ?, 'pending', NULL, NULL, NULL, NULL, 0,
                     0, NULL, ?, ?, ?)`,
      ).bind(
        operationId,
        tuple.tenant_id,
        tuple.membership_id,
        tuple.identity_id,
        tuple.account_id,
        tuple.connection_id,
        tuple.conversation_id,
        `provider_group_${suffix}`,
        `matrix_room_${suffix}`,
        requestHash,
        `group_manage_key_${suffix}`,
        timestamp,
        timestamp,
        timestamp,
      ),
    );
  }
  await env.CONTROL_DB.batch(statements);
  return {
    scope,
    operation_id: operationId,
    request_hash: requestHash,
    session_generation: timestamp,
    tuple,
    capability: effectiveCapability,
  };
}

const privateReserveInput = (
  operation: PrivateOperationFixture,
  overrides: Partial<PrivateAuthorityReservationInput> = {},
): PrivateAuthorityReservationInput => ({
  ...operation.tuple,
  operation_scope: operation.scope,
  operation_id: operation.operation_id,
  request_hash: operation.request_hash,
  session_generation: operation.session_generation,
  capability: operation.capability,
  reservation_id: `reservation_${operation.operation_id}`,
  now: timestamp,
  ...overrides,
});

const privateClaimInput = (
  operation: PrivateOperationFixture,
  reservationId: string,
  overrides: Partial<PrivateAuthorityClaimInput> = {},
): PrivateAuthorityClaimInput => ({
  ...operation.tuple,
  grant_id:
    operation.capability.kind === "account_grant"
      ? operation.capability.grant_id
      : null,
  operation_scope: operation.scope,
  operation_id: operation.operation_id,
  request_hash: operation.request_hash,
  session_generation: operation.session_generation,
  capability: operation.capability,
  reservation_id: reservationId,
  now: later,
  expires_at: "2026-09-14T00:01:00.000Z",
  ...overrides,
});

describe("outbound authority migration", () => {
  it("preserves populated pre-fence grants and retains epochs across regrant", async () => {
    const fixture = await seedFixture();
    const before = await env.CONTROL_DB.prepare(
      "SELECT id, operation_scope, status FROM account_grants WHERE tenant_id = ? ORDER BY id",
    )
      .bind(fixture.tenant_id)
      .all();
    const after = await env.CONTROL_DB.prepare(
      "SELECT id, operation_scope, status FROM account_grants WHERE tenant_id = ? ORDER BY id",
    )
      .bind(fixture.tenant_id)
      .all();
    expect(after.results).toEqual(before.results);
    const initial = await env.CONTROL_DB.prepare(
      "SELECT authorization_epoch FROM account_grants WHERE tenant_id = ? AND id = ?",
    )
      .bind(fixture.tenant_id, fixture.grant_id)
      .first<{ authorization_epoch: number }>();
    expect(initial?.authorization_epoch).toBe(1);
    await env.CONTROL_DB.prepare(
      "UPDATE account_grants SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?",
    )
      .bind(later, later, fixture.tenant_id, fixture.grant_id)
      .run();
    const revoked = await env.CONTROL_DB.prepare(
      "SELECT authorization_epoch FROM account_grants WHERE tenant_id = ? AND id = ?",
    )
      .bind(fixture.tenant_id, fixture.grant_id)
      .first<{ authorization_epoch: number }>();
    expect(revoked?.authorization_epoch).toBe(2);
    await env.CONTROL_DB.prepare(
      "UPDATE account_grants SET status = 'active', revoked_at = NULL, updated_at = ? WHERE tenant_id = ? AND id = ?",
    )
      .bind("2026-09-14T00:00:02.000Z", fixture.tenant_id, fixture.grant_id)
      .run();
    const regranted = await env.CONTROL_DB.prepare(
      "SELECT authorization_epoch FROM account_grants WHERE tenant_id = ? AND id = ?",
    )
      .bind(fixture.tenant_id, fixture.grant_id)
      .first<{ authorization_epoch: number }>();
    expect(regranted?.authorization_epoch).toBe(3);
  });

  it("denies a revoked grant before reservation and leaves no intent", async () => {
    const fixture = await seedFixture();
    const oldCapability = fixture.grant_capability;
    await env.CONTROL_DB.prepare(
      "UPDATE account_grants SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?",
    )
      .bind(later, later, fixture.tenant_id, fixture.grant_id)
      .run();
    const result = await reserveOutboundAcceptance(
      env.CONTROL_DB,
      reserveInput(fixture, { capability: oldCapability }),
    );
    expect(result).toEqual({
      status: "denied",
      reason: "authorization_revoked",
    });
    const intents = await env.CONTROL_DB.prepare(
      "SELECT COUNT(*) AS count FROM outbound_acceptance_intents WHERE tenant_id = ?",
    )
      .bind(fixture.tenant_id)
      .first<{ count: number }>();
    expect(intents?.count).toBe(0);
  });

  it("keeps an accepted reservation recorded while revoke and regrant deny its old epoch", async () => {
    const fixture = await seedFixture();
    const input = reserveInput(fixture, {
      idempotency_key: "accepted-before-revoke",
    });
    const reservation = requireReservation(
      await reserveOutboundAcceptance(env.CONTROL_DB, input),
    );
    const committed = await finalizeOutboundAcceptance(
      env.CONTROL_DB,
      finalizeInput(fixture, reservation),
    );
    expect(committed.status).toBe("committed");
    await env.CONTROL_DB.prepare(
      "UPDATE account_grants SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?",
    )
      .bind(later, later, fixture.tenant_id, fixture.grant_id)
      .run();
    const deniedAfterRevoke = await claimOutboundDispatch(
      env.CONTROL_DB,
      claimInput(fixture, reservation),
    );
    expect(deniedAfterRevoke).toEqual({
      status: "denied",
      reason: "authorization_revoked",
    });
    await env.CONTROL_DB.prepare(
      "UPDATE account_grants SET status = 'active', revoked_at = NULL, updated_at = ? WHERE tenant_id = ? AND id = ?",
    )
      .bind("2026-09-14T00:00:02.000Z", fixture.tenant_id, fixture.grant_id)
      .run();
    const deniedAfterRegrant = await claimOutboundDispatch(
      env.CONTROL_DB,
      claimInput(fixture, reservation),
    );
    expect(deniedAfterRegrant).toEqual({
      status: "denied",
      reason: "authorization_revoked",
    });
    const stored = await readOutboundAcceptanceReservation(
      env.CONTROL_DB,
      fixture.tenant_id,
      reservation.id,
    );
    expect(stored?.status).toBe("committed");
  });

  it("fences delegated capabilities across membership revoke and reactivation", async () => {
    const fixture = await seedFixture();
    const reservation = requireReservation(
      await reserveOutboundAcceptance(
        env.CONTROL_DB,
        reserveInput(fixture, { idempotency_key: "membership-before-revoke" }),
      ),
    );
    await finalizeOutboundAcceptance(
      env.CONTROL_DB,
      finalizeInput(fixture, reservation),
    );
    await env.CONTROL_DB.prepare(
      "UPDATE memberships SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?",
    )
      .bind(later, later, fixture.tenant_id, fixture.membership_id)
      .run();
    await env.CONTROL_DB.prepare(
      "UPDATE memberships SET status = 'active', revoked_at = NULL, updated_at = ? WHERE tenant_id = ? AND id = ?",
    )
      .bind(
        "2026-09-14T00:00:02.000Z",
        fixture.tenant_id,
        fixture.membership_id,
      )
      .run();
    const denied = await claimOutboundDispatch(
      env.CONTROL_DB,
      claimInput(fixture, reservation),
    );
    expect(denied).toEqual({
      status: "denied",
      reason: "authorization_revoked",
    });
  });

  it("makes duplicate dispatch claims replay-only and records uncertainty", async () => {
    const fixture = await seedFixture();
    const reservation = requireReservation(
      await reserveOutboundAcceptance(env.CONTROL_DB, reserveInput(fixture)),
    );
    await finalizeOutboundAcceptance(
      env.CONTROL_DB,
      finalizeInput(fixture, reservation),
    );
    const first = await claimOutboundDispatch(
      env.CONTROL_DB,
      claimInput(fixture, reservation),
    );
    expect(first.status).toBe("claimed");
    if (first.status !== "claimed") throw new Error("claim was denied");
    const duplicate = await claimOutboundDispatch(
      env.CONTROL_DB,
      claimInput(fixture, reservation, { claim_id: "different-claim-id" }),
    );
    expect(duplicate).toEqual({
      status: "replayed",
      replayed: true,
      provider_allowed: false,
      claim: first.claim,
    });
    const uncertain = await markOutboundDispatchClaimUncertain(env.CONTROL_DB, {
      tenant_id: fixture.tenant_id,
      claim_id: first.claim.id,
      reason: "provider outcome unknown",
      now: later,
    });
    expect(uncertain.status).toBe("uncertain");
    const retry = await claimOutboundDispatch(
      env.CONTROL_DB,
      claimInput(fixture, reservation),
    );
    expect(retry).toMatchObject({
      status: "replayed",
      replayed: true,
      provider_allowed: false,
    });
  });

  it("rejects mismatched digest and tuple reuse, and never lets read grant send", async () => {
    const fixture = await seedFixture();
    const input = reserveInput(fixture, { idempotency_key: "digest-key" });
    const reservation = requireReservation(
      await reserveOutboundAcceptance(env.CONTROL_DB, input),
    );
    const digestConflict = await reserveOutboundAcceptance(
      env.CONTROL_DB,
      reserveInput(fixture, {
        idempotency_key: input.idempotency_key,
        body_digest: "c".repeat(64),
      }),
    );
    expect(digestConflict).toEqual({
      status: "denied",
      reason: "idempotency_conflict",
    });
    const tupleConflict = await finalizeOutboundAcceptance(
      env.CONTROL_DB,
      finalizeInput(fixture, reservation, {
        conversation_id: "different-conversation",
      }),
    );
    expect(tupleConflict).toEqual({
      status: "denied",
      reason: "tuple_mismatch",
    });
    const readOnly = await reserveOutboundAcceptance(
      env.CONTROL_DB,
      reserveInput(fixture, {
        idempotency_key: "read-only-capability",
        capability: {
          kind: "account_grant",
          grant_id: fixture.read_grant_id,
          authorization_epoch: 1,
        },
      }),
    );
    expect(readOnly).toEqual({
      status: "denied",
      reason: "authorization_revoked",
    });
  });

  it("supports owner/admin capability without an account grant and fences demotion", async () => {
    const fixture = await seedFixture();
    const ownerTuple: OutboundTuple = {
      ...fixtureTuple(fixture),
      membership_id: fixture.owner_membership_id,
      identity_id: fixture.owner_identity_id,
      account_id: fixture.owner_account_id,
      conversation_id: fixture.owner_conversation_id,
      connection_id: fixture.owner_connection_id,
    };
    const ownerInput = reserveInput(fixture, {
      ...ownerTuple,
      idempotency_key: "owner-send",
      capability: fixture.owner_capability,
    });
    const ownerReservation = requireReservation(
      await reserveOutboundAcceptance(env.CONTROL_DB, ownerInput),
    );
    expect(ownerReservation.grant_id).toBeNull();
    await finalizeOutboundAcceptance(
      env.CONTROL_DB,
      finalizeInput({ ...fixture, ...ownerTuple }, ownerReservation, {
        grant_id: null,
      }),
    );
    const ownerClaim = await claimOutboundDispatch(
      env.CONTROL_DB,
      claimInput({ ...fixture, ...ownerTuple }, ownerReservation, {
        grant_id: null,
      }),
    );
    expect(ownerClaim.status).toBe("claimed");
    const staleOwnerReservation = requireReservation(
      await reserveOutboundAcceptance(
        env.CONTROL_DB,
        reserveInput(
          { ...fixture, ...ownerTuple },
          {
            ...ownerTuple,
            idempotency_key: "owner-before-demotion",
            capability: fixture.owner_capability,
          },
        ),
      ),
    );
    await finalizeOutboundAcceptance(
      env.CONTROL_DB,
      finalizeInput({ ...fixture, ...ownerTuple }, staleOwnerReservation, {
        grant_id: null,
      }),
    );
    await env.CONTROL_DB.prepare(
      "UPDATE memberships SET role = 'member', updated_at = ? WHERE tenant_id = ? AND id = ?",
    )
      .bind(later, fixture.tenant_id, fixture.owner_membership_id)
      .run();
    const deniedAfterDemotion = await claimOutboundDispatch(
      env.CONTROL_DB,
      claimInput({ ...fixture, ...ownerTuple }, staleOwnerReservation, {
        grant_id: null,
      }),
    );
    expect(deniedAfterDemotion).toEqual({
      status: "denied",
      reason: "authorization_revoked",
    });
    const afterDemotion = await reserveOutboundAcceptance(
      env.CONTROL_DB,
      reserveInput(fixture, {
        ...ownerTuple,
        idempotency_key: "owner-after-demotion",
        capability: fixture.owner_capability,
      }),
    );
    expect(afterDemotion).toEqual({
      status: "denied",
      reason: "authorization_revoked",
    });
    const agentForge = await reserveOutboundAcceptance(
      env.CONTROL_DB,
      reserveInput(fixture, {
        idempotency_key: "agent-forged-owner",
        capability: {
          kind: "owner_admin",
          authority_id: fixture.agent_membership_id,
          authority_epoch: 1,
        },
      }),
    );
    expect(agentForge).toEqual({
      status: "denied",
      reason: "authorization_revoked",
    });
  });

  it("retains the grant epoch when a grant id is deleted and recreated", async () => {
    const fixture = await seedFixture();
    const oldCapability = fixture.grant_capability;
    await env.CONTROL_DB.prepare(
      "DELETE FROM account_grants WHERE tenant_id = ? AND id = ?",
    )
      .bind(fixture.tenant_id, fixture.grant_id)
      .run();
    await env.CONTROL_DB.prepare(
      "INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at, revoked_at) VALUES (?, ?, ?, ?, ?, 'message.send', 'all_chats', 'active', ?, ?, NULL)",
    )
      .bind(
        fixture.grant_id,
        fixture.tenant_id,
        fixture.membership_id,
        fixture.identity_id,
        fixture.account_id,
        later,
        later,
      )
      .run();
    const recreated = await env.CONTROL_DB.prepare(
      "SELECT authorization_epoch FROM account_grants WHERE tenant_id = ? AND id = ?",
    )
      .bind(fixture.tenant_id, fixture.grant_id)
      .first<{ authorization_epoch: number }>();
    expect(recreated?.authorization_epoch).toBeGreaterThan(
      oldCapability.kind === "account_grant"
        ? oldCapability.authorization_epoch
        : 0,
    );
    const stale = await reserveOutboundAcceptance(
      env.CONTROL_DB,
      reserveInput(fixture, {
        idempotency_key: "deleted-and-recreated-stale",
        capability: oldCapability,
      }),
    );
    expect(stale).toEqual({
      status: "denied",
      reason: "authorization_revoked",
    });
    const currentCapability: OutboundCapability = {
      kind: "account_grant",
      grant_id: fixture.grant_id,
      authorization_epoch: recreated?.authorization_epoch ?? 0,
    };
    const current = await reserveOutboundAcceptance(
      env.CONTROL_DB,
      reserveInput(fixture, {
        idempotency_key: "deleted-and-recreated-current",
        capability: currentCapability,
      }),
    );
    expect(current.status).toBe("reserved");
  });

  it("advances the grant epoch when selected chat scope is changed directly", async () => {
    const fixture = await seedFixture();
    const oldReservation = requireReservation(
      await reserveOutboundAcceptance(
        env.CONTROL_DB,
        reserveInput(fixture, {
          idempotency_key: "selected-chat-before-change",
        }),
      ),
    );
    await finalizeOutboundAcceptance(
      env.CONTROL_DB,
      finalizeInput(fixture, oldReservation),
    );
    await env.CONTROL_DB.prepare(
      "UPDATE account_grants SET chat_scope = 'selected_chats', updated_at = ? WHERE tenant_id = ? AND id = ?",
    )
      .bind(later, fixture.tenant_id, fixture.grant_id)
      .run();
    await env.CONTROL_DB.prepare(
      "INSERT INTO account_grant_chats (grant_id, tenant_id, account_id, chat_id, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        fixture.grant_id,
        fixture.tenant_id,
        fixture.account_id,
        fixture.conversation_id,
        later,
      )
      .run();
    const denied = await claimOutboundDispatch(
      env.CONTROL_DB,
      claimInput(fixture, oldReservation),
    );
    expect(denied).toEqual({
      status: "denied",
      reason: "authorization_revoked",
    });
    const afterScopeChange = await env.CONTROL_DB.prepare(
      "SELECT authorization_epoch FROM account_grants WHERE tenant_id = ? AND id = ?",
    )
      .bind(fixture.tenant_id, fixture.grant_id)
      .first<{ authorization_epoch: number }>();
    expect(afterScopeChange?.authorization_epoch).toBeGreaterThan(
      fixture.grant_capability.kind === "account_grant"
        ? fixture.grant_capability.authorization_epoch
        : 0,
    );
  });
});

describe("private provider authority", () => {
  it("uses the exact operation tuple and allows only the first claim", async () => {
    const fixture = await seedFixture();
    const operation = await seedPrivateOperation(fixture, "receipt.send");
    const reservation = await reservePrivateAuthority(
      env.CONTROL_DB,
      privateReserveInput(operation),
    );
    expect(reservation.status).toBe("reserved");
    if (reservation.status !== "reserved") throw new Error("not reserved");

    const mismatchedDigest = await claimPrivateAuthority(
      env.CONTROL_DB,
      privateClaimInput(operation, reservation.reservation.id, {
        request_hash: "0".repeat(64),
      }),
    );
    expect(mismatchedDigest).toEqual({
      status: "denied",
      reason: "tuple_mismatch",
    });
    const first = await claimPrivateAuthority(
      env.CONTROL_DB,
      privateClaimInput(operation, reservation.reservation.id),
    );
    expect(first.status).toBe("claimed");
    expect(first).toMatchObject({ provider_allowed: true });
    const duplicate = await claimPrivateAuthority(
      env.CONTROL_DB,
      privateClaimInput(operation, reservation.reservation.id, {
        claim_id: "claim_replay_private",
      }),
    );
    expect(duplicate).toMatchObject({
      status: "replayed",
      replayed: true,
      provider_allowed: false,
    });
  });

  it("rejects a revoke before claim and cannot revive the old epoch on regrant", async () => {
    const fixture = await seedFixture();
    const operation = await seedPrivateOperation(fixture, "group.create");
    const reservation = await reservePrivateAuthority(
      env.CONTROL_DB,
      privateReserveInput(operation),
    );
    expect(reservation.status).toBe("reserved");
    if (reservation.status !== "reserved") throw new Error("not reserved");
    await env.CONTROL_DB.prepare(
      "UPDATE account_grants SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?",
    )
      .bind(
        later,
        later,
        fixture.tenant_id,
        operation.capability.kind === "account_grant"
          ? operation.capability.grant_id
          : "",
      )
      .run();
    const denied = await claimPrivateAuthority(
      env.CONTROL_DB,
      privateClaimInput(operation, reservation.reservation.id),
    );
    expect(denied).toEqual({
      status: "denied",
      reason: "authorization_revoked",
    });

    await env.CONTROL_DB.prepare(
      "UPDATE account_grants SET status = 'active', revoked_at = NULL, updated_at = ? WHERE tenant_id = ? AND id = ?",
    )
      .bind(
        "2026-09-14T00:00:02.000Z",
        fixture.tenant_id,
        operation.capability.kind === "account_grant"
          ? operation.capability.grant_id
          : "",
      )
      .run();
    const stillDenied = await claimPrivateAuthority(
      env.CONTROL_DB,
      privateClaimInput(operation, reservation.reservation.id),
    );
    expect(stillDenied).toEqual({
      status: "denied",
      reason: "authorization_revoked",
    });
    const current = await env.CONTROL_DB.prepare(
      "SELECT authorization_epoch FROM account_grants WHERE tenant_id = ? AND id = ?",
    )
      .bind(
        fixture.tenant_id,
        operation.capability.kind === "account_grant"
          ? operation.capability.grant_id
          : "",
      )
      .first<{ authorization_epoch: number }>();
    expect(current?.authorization_epoch).toBeGreaterThan(1);
  });

  it("denies a revoked capability before writing a private intent", async () => {
    const fixture = await seedFixture();
    const operation = await seedPrivateOperation(fixture, "receipt.send");
    await env.CONTROL_DB.prepare(
      "UPDATE account_grants SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?",
    )
      .bind(
        later,
        later,
        fixture.tenant_id,
        operation.capability.kind === "account_grant"
          ? operation.capability.grant_id
          : "",
      )
      .run();
    const denied = await reservePrivateAuthority(
      env.CONTROL_DB,
      privateReserveInput(operation),
    );
    expect(denied).toEqual({
      status: "denied",
      reason: "authorization_revoked",
    });
    const intent = await env.CONTROL_DB.prepare(
      "SELECT COUNT(*) AS count FROM receipt_authority_intents WHERE tenant_id = ? AND operation_id = ?",
    )
      .bind(fixture.tenant_id, operation.operation_id)
      .first<{ count: number }>();
    expect(intent?.count).toBe(0);
  });

  it("supports receipt, group creation, and group management operation scopes", async () => {
    const fixture = await seedFixture();
    for (const scope of [
      "receipt.send",
      "group.create",
      "group.manage",
    ] as const) {
      const operation = await seedPrivateOperation(fixture, scope);
      const reservation = await reservePrivateAuthority(
        env.CONTROL_DB,
        privateReserveInput(operation),
      );
      expect(reservation.status).toBe("reserved");
      if (reservation.status !== "reserved") continue;
      const claim = await claimPrivateAuthority(
        env.CONTROL_DB,
        privateClaimInput(operation, reservation.reservation.id),
      );
      expect(claim).toMatchObject({
        status: "claimed",
        provider_allowed: true,
      });
    }
  });

  it("keeps unavailable connections acceptable at reservation but denies the provider claim", async () => {
    for (const scope of [
      "receipt.send",
      "group.create",
      "group.manage",
    ] as const) {
      const fixture = await seedFixture();
      const operation = await seedPrivateOperation(fixture, scope);
      const reservation = await reservePrivateAuthority(
        env.CONTROL_DB,
        privateReserveInput(operation),
      );
      expect(reservation.status).toBe("reserved");
      if (reservation.status !== "reserved")
        throw new Error("private reservation was denied");
      await env.CONTROL_DB.prepare(
        "UPDATE connections SET status = 'disconnected', updated_at = ? WHERE tenant_id = ? AND id = ?",
      )
        .bind(later, fixture.tenant_id, fixture.connection_id)
        .run();
      await expect(
        claimPrivateAuthority(
          env.CONTROL_DB,
          privateClaimInput(operation, reservation.reservation.id),
        ),
      ).resolves.toEqual({
        status: "denied",
        reason: "authorization_revoked",
      });
    }
  });

  it("allows owner/admin authority without an account-grant row and fences demotion", async () => {
    const fixture = await seedFixture();
    const owner = await seedPrivateOperation(
      fixture,
      "group.manage",
      privateTuple(fixture, true),
      fixture.owner_capability,
    );
    const reservation = await reservePrivateAuthority(
      env.CONTROL_DB,
      privateReserveInput(owner),
    );
    expect(reservation.status).toBe("reserved");
    if (reservation.status !== "reserved") throw new Error("not reserved");
    const claim = await claimPrivateAuthority(
      env.CONTROL_DB,
      privateClaimInput(owner, reservation.reservation.id),
    );
    expect(claim).toMatchObject({
      status: "claimed",
      provider_allowed: true,
    });
    const grants = await env.CONTROL_DB.prepare(
      "SELECT COUNT(*) AS count FROM account_grants WHERE tenant_id = ? AND membership_id = ? AND operation_scope = 'group.manage'",
    )
      .bind(fixture.tenant_id, fixture.owner_membership_id)
      .first<{ count: number }>();
    expect(grants?.count).toBe(0);

    await env.CONTROL_DB.prepare(
      "UPDATE memberships SET role = 'member', updated_at = ? WHERE tenant_id = ? AND id = ?",
    )
      .bind(later, fixture.tenant_id, fixture.owner_membership_id)
      .run();
    const afterDemotion = await seedPrivateOperation(
      fixture,
      "group.manage",
      {
        ...privateTuple(fixture, true),
        conversation_id: `owner_retry_${crypto.randomUUID().replaceAll("-", "")}`,
      },
      fixture.owner_capability,
    );
    await expect(
      reservePrivateAuthority(
        env.CONTROL_DB,
        privateReserveInput(afterDemotion),
      ),
    ).resolves.toEqual({
      status: "denied",
      reason: "authorization_revoked",
    });
  });
});
