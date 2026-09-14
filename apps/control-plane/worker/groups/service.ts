import {
  GroupCreateRequestSchema,
  GroupCreationOperationSchema,
  GroupEvidenceSchema,
  type GroupCreateRequest,
  type GroupCreationOperation,
  type GroupEvidenceSource,
  type GroupParticipant,
  type SessionResponse,
} from "@communicator/contracts";
import { isAdministratorSession } from "../read/authorization";
import { ReadError } from "../read/errors";
import {
  getContactCandidate,
  readContactRoute,
  type ContactRouteRow,
} from "../contacts/repository";
import type { ContactServiceContext } from "../contacts/service";
import {
  defaultGroupProvider,
  GroupProviderError,
  type GroupProvider,
  type GroupProviderInput,
  type ProviderGroup,
} from "./provider";
import {
  beginGroupCreationOperation,
  evaluateGroupWebhookSubscriptions,
  finishGroupCreationOperation,
  groupParticipantStatus,
  type GroupCreationOperationInput,
} from "./repository";
import { GroupRepositoryError } from "./repository";
import {
  readPrivateAuthorityReservation,
  reservePrivateAuthority,
} from "../outbound/private-authority";
import type { OutboundCapability } from "../outbound/authority-types";

export type GroupRouteServices = {
  createProvider?: (context: ContactServiceContext) => GroupProvider;
  now?: () => Date;
};

const usableStatuses = new Set(["connected", "syncing", "ready"]);
// A duplicate caller may not steal a live provider call.  Once this bounded
// claim is stale, a restart recovery caller owns only event/refresh evidence
// checks and can never issue another create request.
const GROUP_DISPATCH_LEASE_MS = 30_000;

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const databaseFor = (context: ContactServiceContext): D1Database => {
  const database = context.env.CONTROL_DB;
  if (database === undefined || typeof database.withSession !== "function")
    throw new ReadError("service_unavailable");
  return database;
};

const nowFor = (services: GroupRouteServices): string =>
  (services.now?.() ?? new Date()).toISOString();

const requireIdentityScope = (
  session: SessionResponse,
  identityId: string,
): void => {
  const identity = session.identities.find(
    (candidate) => candidate.identity_id === identityId,
  );
  if (identity === undefined || !identity.scopes.includes("group.create"))
    throw new ReadError("forbidden");
};

type GroupRoute = ContactRouteRow & {
  provider: "whatsapp";
  provider_login_id: string;
};

const routeFor = (row: ContactRouteRow): GroupRoute => {
  if (row.provider !== "whatsapp") throw new ReadError("invalid_request");
  if (!usableStatuses.has(row.connection_status))
    throw new ReadError("service_unavailable");
  if (row.has_provider_identity !== 1 || row.provider_login_id === null)
    throw new ReadError("service_unavailable");
  return {
    ...row,
    provider: "whatsapp",
    provider_login_id: row.provider_login_id,
  };
};

const routeInput = (route: GroupRoute): GroupProviderInput["route"] => ({
  tenant_id: route.tenant_id,
  identity_id: route.identity_id,
  account_id: route.account_id,
  connection_id: route.connection_id,
  provider: route.provider,
  session_generation: route.session_generation,
  gateway_route_id: route.gateway_route_id,
  bridge_instance_id: route.bridge_instance_id,
  matrix_user_id: route.matrix_user_id,
  matrix_room_namespace: route.matrix_room_namespace,
  provider_login_id: route.provider_login_id,
});

const providerFor = (
  context: ContactServiceContext,
  services: GroupRouteServices,
): GroupProvider =>
  services.createProvider?.(context) ?? defaultGroupProvider(context.env);

const checkCapability = async (
  db: D1DatabaseSession,
  tenantId: string,
  accountId: string,
): Promise<void> => {
  const capability = await db
    .prepare(
      `SELECT 1 AS available
         FROM provider_capability_records
        WHERE tenant_id = ? AND account_id = ?
          AND capability = 'group.manage'
          AND status IN ('supported', 'conditional')
          AND freshness IN ('fresh', 'unknown', 'stale')
        LIMIT 1`,
    )
    .bind(tenantId, accountId)
    .first<{ available: number }>();
  if (capability === null) throw new ReadError("service_unavailable");
};

const readGroupCapability = async (
  context: ContactServiceContext,
  route: GroupRoute,
  identityId: string,
  accountId: string,
  conversationId: string,
  operationScope: "group.create" | "group.manage",
): Promise<OutboundCapability | null> => {
  const db = databaseFor(context).withSession("first-primary");
  if (isAdministratorSession(context.authorization)) {
    const row = await db
      .prepare(
        `SELECT m.authority_epoch
           FROM memberships AS m
           JOIN tenants AS t ON t.id = m.tenant_id
           JOIN principals AS p ON p.id = m.principal_id
           JOIN identities AS i
             ON i.tenant_id = m.tenant_id AND i.id = ?
           JOIN connections AS c
             ON c.tenant_id = m.tenant_id AND c.id = ?
            AND c.identity_id = i.id
           JOIN connection_accounts AS ca
             ON ca.connection_id = c.id AND ca.account_id = ?
            AND ca.status = 'active'
          WHERE m.tenant_id = ? AND m.id = ?
            AND t.status = 'active'
            AND m.status = 'active' AND m.role IN ('owner', 'admin')
            AND p.status = 'active' AND p.revoked_at IS NULL
            AND p.principal_type IN ('human', 'operator')
            AND i.status = 'active' AND i.identity_kind = 'human'
          LIMIT 1`,
      )
      .bind(
        identityId,
        route.connection_id,
        accountId,
        context.authorization.tenant.id,
        context.authorization.membership.id,
      )
      .first<{ authority_epoch: number }>();
    return row === null
      ? null
      : {
          kind: "owner_admin",
          authority_id: context.authorization.membership.id,
          authority_epoch: row.authority_epoch,
        };
  }
  const row = await db
    .prepare(
      `SELECT g.id AS grant_id, g.authorization_epoch
         FROM account_grants AS g
         JOIN identity_grants AS ig
           ON ig.tenant_id = g.tenant_id
          AND ig.membership_id = g.membership_id
          AND ig.identity_id = g.identity_id
          AND ig.operation_scope = ?
         JOIN connection_accounts AS ca
           ON ca.account_id = g.account_id AND ca.status = 'active'
         JOIN connections AS c
           ON c.tenant_id = g.tenant_id AND c.id = ca.connection_id AND c.id = ?
        WHERE g.tenant_id = ? AND g.membership_id = ? AND g.identity_id = ?
          AND g.account_id = ? AND g.operation_scope = ? AND g.status = 'active'
          AND (g.chat_scope = 'all_chats' OR EXISTS (
            SELECT 1 FROM account_grant_chats AS gc
             WHERE gc.tenant_id = g.tenant_id AND gc.grant_id = g.id
               AND gc.account_id = g.account_id AND gc.chat_id = ?
          ))
        ORDER BY g.id LIMIT 1`,
    )
    .bind(
      operationScope,
      route.connection_id,
      context.authorization.tenant.id,
      context.authorization.membership.id,
      identityId,
      accountId,
      operationScope,
      conversationId,
    )
    .first<{ grant_id: string; authorization_epoch: number }>();
  return row === null
    ? null
    : {
        kind: "account_grant",
        grant_id: row.grant_id,
        authorization_epoch: row.authorization_epoch,
      };
};

const participantSnapshot = async (
  context: ContactServiceContext,
  route: GroupRoute,
  input: GroupCreateRequest,
): Promise<{ participants: GroupParticipant[]; providerIds: string[] }> => {
  const database = databaseFor(context);
  const participants: GroupParticipant[] = [];
  for (const participant of input.participants) {
    const candidate = await getContactCandidate(
      database.withSession("first-primary"),
      context.authorization.tenant.id,
      route.account_id,
      participant.contact_id,
    );
    if (candidate === null) throw new ReadError("not_found");
    if (
      candidate.identity_id !== input.identity_id ||
      candidate.account_id !== input.account_id ||
      candidate.connection_id !== route.connection_id ||
      candidate.provider !== route.provider ||
      candidate.candidate_revision !== participant.candidate_revision
    ) {
      throw new ReadError("invalid_request");
    }
    const status = await groupParticipantStatus(
      database.withSession("first-primary"),
      context.authorization.tenant.id,
      route.account_id,
      participant.contact_id,
    );
    if (status !== "active") throw new ReadError("invalid_request");
    participants.push({
      contact_id: candidate.contact_id,
      candidate_revision: candidate.candidate_revision,
      provider_id: candidate.provider_id,
      current_lid: candidate.current_lid,
      display_name: candidate.display_name,
    });
  }
  return {
    participants,
    providerIds: participants.map((participant) => participant.provider_id),
  };
};

const sameMembers = (
  left: readonly string[],
  right: readonly string[],
): boolean => {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
};

const evidenceSource = (
  value: GroupEvidenceSource,
  expected: GroupEvidenceSource,
): boolean => value === expected;

const validateProviderGroup = (
  value: ProviderGroup,
  route: GroupRoute,
  operationId: string,
  requestedName: string,
  participantProviderIds: readonly string[],
  source: GroupEvidenceSource,
): boolean => {
  if (
    value.name !== requestedName ||
    !sameMembers(value.participant_provider_ids, participantProviderIds)
  )
    return false;
  const evidence = GroupEvidenceSchema.safeParse(value.evidence);
  if (!evidence.success) return false;
  return (
    evidence.data.operation_id === operationId &&
    evidence.data.account_id === route.account_id &&
    evidence.data.connection_id === route.connection_id &&
    evidence.data.provider_group_id === value.provider_group_id &&
    evidence.data.matrix_room_id === value.matrix_room_id &&
    evidence.data.status === "confirmed" &&
    evidenceSource(evidence.data.source, source) &&
    sameMembers(evidence.data.participant_provider_ids, participantProviderIds)
  );
};

const operationResult = (
  operation: GroupCreationOperation,
): GroupCreationOperation => GroupCreationOperationSchema.parse(operation);

const grantInputs = (operation: GroupCreationOperation) => [
  {
    operationScope: "conversation.read" as const,
    grantId: `grant_${operation.operation_id}_read`.slice(0, 128),
  },
  {
    operationScope: "message.send" as const,
    grantId: `grant_${operation.operation_id}_send`.slice(0, 128),
  },
];

const completeCreated = async (
  context: ContactServiceContext,
  operation: GroupCreationOperation,
  route: GroupRoute,
  group: ProviderGroup,
  source: GroupEvidenceSource,
  services: GroupRouteServices,
): Promise<GroupCreationOperation> => {
  const database = databaseFor(context);
  const evaluations = await evaluateGroupWebhookSubscriptions(
    database.withSession("first-primary"),
    operation.tenant_id,
    operation.account_id,
    operation.conversation_id,
  );
  const evidence = GroupEvidenceSchema.parse(group.evidence);
  if (
    !validateProviderGroup(
      group,
      route,
      operation.operation_id,
      operation.name,
      operation.participants.map((participant) => participant.provider_id),
      source,
    )
  ) {
    throw new GroupRepositoryError("group_invalid");
  }
  return finishGroupCreationOperation(database, operation, {
    membershipId: context.authorization.membership.id,
    status: "created",
    providerGroupId: group.provider_group_id,
    matrixRoomId: group.matrix_room_id,
    evidence,
    evidencePath: source,
    duplicateRisk: false,
    humanActionRequired: false,
    accessGrants: grantInputs(operation),
    webhookEvaluations: evaluations,
    now: nowFor(services),
  });
};

const completeUnresolved = async (
  context: ContactServiceContext,
  operation: GroupCreationOperation,
  failureCode: string,
  services: GroupRouteServices,
): Promise<GroupCreationOperation> =>
  finishGroupCreationOperation(databaseFor(context), operation, {
    membershipId: context.authorization.membership.id,
    status: "human_action_required",
    duplicateRisk: true,
    humanActionRequired: true,
    failureCode,
    now: nowFor(services),
  });

/**
 * Provider confirmation has already happened when this is called. If the
 * local grant/evidence transaction cannot be written, keep the operation
 * visibly uncertain so a later reconciler cannot treat it as a safe failure.
 */
const completeCreatedWithRecovery = async (
  context: ContactServiceContext,
  operation: GroupCreationOperation,
  route: GroupRoute,
  group: ProviderGroup,
  source: GroupEvidenceSource,
  services: GroupRouteServices,
): Promise<GroupCreationOperation> => {
  try {
    return await completeCreated(
      context,
      operation,
      route,
      group,
      source,
      services,
    );
  } catch {
    return completeUnresolved(
      context,
      operation,
      "group_creation_persistence_uncertain",
      services,
    );
  }
};

const providerInput = (
  route: GroupRoute,
  operationId: string,
  conversationId: string,
  idempotencyKey: string,
): GroupProviderInput => ({
  route: routeInput(route),
  operation_id: operationId,
  conversation_id: conversationId,
  idempotency_key: idempotencyKey,
});

const recoveryProviderInput = async (
  context: ContactServiceContext,
  operation: GroupCreationOperation,
  route: GroupRoute,
  idempotencyKey: string,
): Promise<GroupProviderInput | null> => {
  const reservation = await readPrivateAuthorityReservation(
    databaseFor(context).withSession("first-primary"),
    "group.create",
    operation.tenant_id,
    operation.operation_id,
  );
  if (reservation === null) return null;
  return {
    ...providerInput(
      route,
      operation.operation_id,
      operation.conversation_id,
      idempotencyKey,
    ),
    membership_id: reservation.membership_id,
    actor_identity_id: reservation.identity_id,
    reservation_id: reservation.id,
    capability: reservation.capability,
    request_hash: reservation.request_hash,
    operation_scope: "group.create",
  };
};

const providerErrorCode = (error: unknown): string =>
  error instanceof GroupProviderError && error.code === "authorization_revoked"
    ? "authorization_revoked"
    : error instanceof GroupProviderError
      ? `provider_${error.code}`
      : "provider_unavailable";

const isReconciliationError = (error: unknown): boolean =>
  error instanceof GroupProviderError &&
  ["unavailable", "uncertain", "unsupported", "not_found"].includes(error.code);

const reconcileAfterCreate = async (
  context: ContactServiceContext,
  operation: GroupCreationOperation,
  route: GroupRoute,
  provider: GroupProvider,
  input: GroupProviderInput,
  services: GroupRouteServices,
): Promise<GroupCreationOperation> => {
  const expectedParticipants = operation.participants.map(
    (participant) => participant.provider_id,
  );
  try {
    const event = await provider.observeGroup(
      input,
      operation.name,
      expectedParticipants,
    );
    if (
      event !== null &&
      validateProviderGroup(
        event,
        route,
        operation.operation_id,
        operation.name,
        expectedParticipants,
        "event",
      )
    ) {
      return completeCreatedWithRecovery(
        context,
        operation,
        route,
        event,
        "event",
        services,
      );
    }
  } catch {
    // A missing event or a temporarily unavailable event stream is followed
    // by exactly one bounded refresh. It never retries group creation.
  }
  try {
    const refreshed = await provider.refreshGroup(
      input,
      operation.name,
      expectedParticipants,
    );
    if (
      refreshed !== null &&
      validateProviderGroup(
        refreshed,
        route,
        operation.operation_id,
        operation.name,
        expectedParticipants,
        "refresh",
      )
    ) {
      return completeCreatedWithRecovery(
        context,
        operation,
        route,
        refreshed,
        "refresh",
        services,
      );
    }
  } catch {
    // The durable human-action result below is the recovery path.
  }
  return completeUnresolved(
    context,
    operation,
    "group_creation_evidence_unresolved",
    services,
  );
};

export async function createGroup(
  context: ContactServiceContext,
  input: GroupCreateRequest,
  services: GroupRouteServices = {},
): Promise<GroupCreationOperation> {
  const parsed = GroupCreateRequestSchema.parse(input);
  requireIdentityScope(context.authorization, parsed.identity_id);
  const database = databaseFor(context);
  const routeRow = await readContactRoute(
    database.withSession("first-primary"),
    context.authorization.tenant.id,
    parsed.identity_id,
    parsed.account_id,
  );
  if (routeRow === null) throw new ReadError("not_found");
  const route = routeFor(routeRow);
  await checkCapability(
    database.withSession("first-primary"),
    context.authorization.tenant.id,
    parsed.account_id,
  );
  const snapshot = await participantSnapshot(context, route, parsed);
  const canonicalParticipants = [...snapshot.participants].sort((a, b) =>
    a.contact_id.localeCompare(b.contact_id),
  );
  const requestHash = await sha256Hex(
    JSON.stringify({
      identity_id: parsed.identity_id,
      account_id: parsed.account_id,
      name: parsed.name,
      participants: canonicalParticipants.map((participant) => ({
        contact_id: participant.contact_id,
        candidate_revision: participant.candidate_revision,
      })),
    }),
  );
  const conversationId = `conversation_group_${(
    await sha256Hex(
      [
        context.authorization.tenant.id,
        parsed.account_id,
        parsed.idempotency_key,
      ].join("\u001f"),
    )
  ).slice(0, 36)}`;
  const capability = await readGroupCapability(
    context,
    route,
    parsed.identity_id,
    parsed.account_id,
    conversationId,
    "group.create",
  );
  if (capability === null) throw new ReadError("forbidden");
  const operationId = `group_create_${crypto.randomUUID().replaceAll("-", "")}`;
  const operationInput: GroupCreationOperationInput = {
    operationId,
    tenantId: context.authorization.tenant.id,
    membershipId: context.authorization.membership.id,
    identityId: parsed.identity_id,
    accountId: parsed.account_id,
    connectionId: route.connection_id,
    provider: route.provider,
    conversationId,
    idempotencyKey: parsed.idempotency_key,
    requestHash,
    name: parsed.name,
    participants: canonicalParticipants,
    participantProviderIds: canonicalParticipants.map(
      (participant) => participant.provider_id,
    ),
    now: nowFor(services),
  };
  const begun = await beginGroupCreationOperation(database, operationInput);
  const operation = begun.operation;
  if (!begun.dispatchOwner) {
    if (
      operation.status === "human_action_required" &&
      operation.failure_code === "group_creation_persistence_uncertain"
    ) {
      const provider = providerFor(context, services);
      const input = await recoveryProviderInput(
        context,
        operation,
        route,
        parsed.idempotency_key,
      );
      if (input === null)
        return operationResult(
          await completeUnresolved(
            context,
            operation,
            "group_creation_authority_reservation_missing",
            services,
          ),
        );
      return operationResult(
        await reconcileAfterCreate(
          context,
          operation,
          route,
          provider,
          input,
          services,
        ),
      );
    }
    if (operation.status !== "pending") return operationResult(operation);
    const age = Date.parse(nowFor(services)) - Date.parse(operation.updated_at);
    if (!Number.isFinite(age) || age <= GROUP_DISPATCH_LEASE_MS)
      return operationResult(operation);
    const provider = providerFor(context, services);
    const input = await recoveryProviderInput(
      context,
      operation,
      route,
      parsed.idempotency_key,
    );
    if (input === null)
      return operationResult(
        await completeUnresolved(
          context,
          operation,
          "group_creation_authority_reservation_missing",
          services,
        ),
      );
    return operationResult(
      await reconcileAfterCreate(
        context,
        operation,
        route,
        provider,
        input,
        services,
      ),
    );
  }
  if (operation.status !== "pending") return operationResult(operation);

  const reservation = await reservePrivateAuthority(
    database.withSession("first-primary"),
    {
      tenant_id: operation.tenant_id,
      membership_id:
        operation.membership_id ?? context.authorization.membership.id,
      identity_id: operation.identity_id,
      account_id: operation.account_id,
      conversation_id: operation.conversation_id,
      connection_id: operation.connection_id,
      operation_scope: "group.create",
      operation_id: operation.operation_id,
      request_hash: operationInput.requestHash,
      capability,
      now: nowFor(services),
    },
  );
  if (reservation.status === "denied") {
    throw new ReadError(
      reservation.reason === "authorization_revoked"
        ? "forbidden"
        : "service_unavailable",
    );
  }

  const provider = providerFor(context, services);
  const inputForProvider: GroupProviderInput = {
    ...providerInput(
      route,
      operation.operation_id,
      operation.conversation_id,
      parsed.idempotency_key,
    ),
    membership_id:
      operation.membership_id ?? context.authorization.membership.id,
    actor_identity_id: operation.identity_id,
    reservation_id: reservation.reservation.id,
    capability: reservation.reservation.capability,
    request_hash: operationInput.requestHash,
    operation_scope: "group.create",
  };
  let created: ProviderGroup;
  try {
    created = await provider.createGroup(
      inputForProvider,
      operation.name,
      operation.participants.map((participant) => participant.provider_id),
    );
  } catch (error) {
    if (
      error instanceof GroupProviderError &&
      error.code === "authorization_revoked"
    ) {
      return operationResult(
        await finishGroupCreationOperation(database, operation, {
          membershipId: context.authorization.membership.id,
          status: "failed",
          duplicateRisk: false,
          humanActionRequired: false,
          failureCode: "authorization_revoked",
          now: nowFor(services),
        }),
      );
    }
    if (!isReconciliationError(error)) {
      return operationResult(
        await finishGroupCreationOperation(database, operation, {
          membershipId: context.authorization.membership.id,
          status: "failed",
          duplicateRisk: false,
          humanActionRequired: false,
          failureCode: providerErrorCode(error),
          now: nowFor(services),
        }),
      );
    }
    return operationResult(
      await reconcileAfterCreate(
        context,
        operation,
        route,
        provider,
        inputForProvider,
        services,
      ),
    );
  }
  if (
    validateProviderGroup(
      created,
      route,
      operation.operation_id,
      operation.name,
      operation.participants.map((participant) => participant.provider_id),
      "provider",
    )
  ) {
    return operationResult(
      await completeCreatedWithRecovery(
        context,
        operation,
        route,
        created,
        "provider",
        services,
      ),
    );
  }
  return operationResult(
    await completeUnresolved(
      context,
      operation,
      "group_creation_response_mismatch",
      services,
    ),
  );
}
