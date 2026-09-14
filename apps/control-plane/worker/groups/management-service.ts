import {
  GroupManagementEvidenceSchema,
  GroupManagementOperationSchema,
  GroupParticipantsRequestSchema,
  GroupRenameRequestSchema,
  type GroupManagementOperation,
  type GroupManagementParticipant,
  type GroupParticipantsRequest,
  type GroupRenameRequest,
} from "@communicator/contracts";
import { hasAccountOperationGrant } from "../control-directory/grants";
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
  type GroupManagementProviderInput,
  type GroupProvider,
  type ManagedProviderGroup,
} from "./provider";
import {
  beginGroupManagementOperation,
  claimGroupManagementOperation,
  finishGroupManagementOperation,
  groupManagementEvidenceFor,
  readGroupManagementByIdempotency,
  readGroupManagementGroup,
  readGroupManagementOperation,
  recordGroupManagementEvidence,
  listGroupManagementOperations,
  type GroupManagementOperationInput,
  type GroupManagementRepositoryError,
} from "./management-repository";

export type GroupManagementRouteServices = {
  createProvider?: (context: ContactServiceContext) => GroupProvider;
  now?: () => Date;
};

const usableStatuses = new Set(["connected", "syncing", "ready"]);
const GROUP_MANAGEMENT_DISPATCH_LEASE_MS = 30_000;

type GroupRoute = ContactRouteRow & {
  provider: "whatsapp";
  provider_login_id: string;
};

const nowFor = (services: GroupManagementRouteServices): string =>
  (services.now?.() ?? new Date()).toISOString();

const databaseFor = (context: ContactServiceContext): D1Database => {
  const database = context.env.CONTROL_DB;
  if (database === undefined || typeof database.withSession !== "function")
    throw new ReadError("service_unavailable");
  return database;
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

const routeInput = (
  route: GroupRoute,
): GroupManagementProviderInput["route"] => ({
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
  services: GroupManagementRouteServices,
): GroupProvider =>
  services.createProvider?.(context) ?? defaultGroupProvider(context.env);

const requireManageIdentityScope = (
  context: ContactServiceContext,
  identityId: string,
): void => {
  const identity = context.authorization.identities.find(
    (candidate) => candidate.identity_id === identityId,
  );
  if (identity === undefined || !identity.scopes.includes("group.manage"))
    throw new ReadError("forbidden");
};

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

const requireAuthority = async (
  context: ContactServiceContext,
  route: GroupRoute,
  conversationId: string,
): Promise<void> => {
  const database = databaseFor(context);
  const session = database.withSession("first-primary");
  const [manage, read] = await Promise.all([
    hasAccountOperationGrant(
      session,
      context.authorization.tenant.id,
      context.authorization.membership.id,
      route.identity_id,
      route.account_id,
      conversationId,
      "group.manage",
    ),
    hasAccountOperationGrant(
      session,
      context.authorization.tenant.id,
      context.authorization.membership.id,
      route.identity_id,
      route.account_id,
      conversationId,
      "conversation.read",
    ),
  ]);
  if (!manage || !read) throw new ReadError("forbidden");
};

const participantSnapshot = async (
  context: ContactServiceContext,
  route: GroupRoute,
  participants: readonly GroupManagementParticipant[],
): Promise<string[]> => {
  const db = databaseFor(context);
  const providerIds: string[] = [];
  for (const participant of participants) {
    const candidate = await getContactCandidate(
      db.withSession("first-primary"),
      context.authorization.tenant.id,
      route.account_id,
      participant.contact_id,
    );
    if (
      candidate === null ||
      candidate.identity_id !== route.identity_id ||
      candidate.account_id !== route.account_id ||
      candidate.connection_id !== route.connection_id ||
      candidate.provider !== route.provider ||
      candidate.candidate_revision !== participant.candidate_revision
    ) {
      throw new ReadError("invalid_request");
    }
    const status = await db
      .withSession("first-primary")
      .prepare(
        "SELECT status FROM contact_resolution_candidates WHERE tenant_id = ? AND account_id = ? AND contact_id = ? LIMIT 1",
      )
      .bind(
        context.authorization.tenant.id,
        route.account_id,
        participant.contact_id,
      )
      .first<{ status: string }>();
    if (status?.status !== "active") throw new ReadError("invalid_request");
    providerIds.push(candidate.provider_id);
  }
  return providerIds;
};

const hashRequest = async (value: unknown): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
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

const includesAll = (
  members: readonly string[],
  expected: readonly string[],
): boolean => expected.every((member) => members.includes(member));

const revisionCompare = (left: string, right: string): number => {
  if (/^\d+$/u.test(left) && /^\d+$/u.test(right)) {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return left < right ? -1 : left > right ? 1 : 0;
};

const validateManagedGroup = (
  operation: GroupManagementOperation,
  group: ManagedProviderGroup,
  source: "provider" | "event" | "refresh",
): string | null => {
  const evidence = GroupManagementEvidenceSchema.safeParse(group.evidence);
  if (!evidence.success) return "malformed_evidence";
  if (evidence.data.source !== source) return "evidence_source_mismatch";
  if (evidence.data.operation_id !== operation.operation_id)
    return "stale_operation_evidence";
  if (evidence.data.account_id !== operation.account_id)
    return "account_mismatch";
  if (evidence.data.connection_id !== operation.connection_id)
    return "connection_mismatch";
  if (evidence.data.provider_group_id !== operation.provider_group_id)
    return "group_mismatch";
  if (evidence.data.matrix_room_id !== operation.matrix_room_id)
    return "matrix_room_mismatch";
  if (evidence.data.status !== "confirmed") return "uncertain_evidence";
  if (revisionCompare(group.revision, operation.expected_revision) <= 0)
    return "stale_revision";
  if (operation.action === "rename") {
    if (
      operation.requested_name === null ||
      group.name !== operation.requested_name
    )
      return "name_mismatch";
    if (
      !sameMembers(
        group.member_provider_ids,
        operation.current_member_provider_ids,
      )
    )
      return "unexpected_membership_change";
  }
  if (operation.action === "add_participants") {
    if (
      !includesAll(
        group.member_provider_ids,
        operation.requested_member_provider_ids,
      )
    )
      return "participant_addition_missing";
    if (
      !includesAll(
        group.member_provider_ids,
        operation.current_member_provider_ids,
      )
    )
      return "unexpected_membership_removal";
  }
  if (operation.action === "remove_participants") {
    if (
      operation.requested_member_provider_ids.some((member) =>
        group.member_provider_ids.includes(member),
      )
    )
      return "participant_removal_missing";
    const preserved = operation.current_member_provider_ids.filter(
      (member) => !operation.requested_member_provider_ids.includes(member),
    );
    if (!includesAll(group.member_provider_ids, preserved))
      return "unexpected_membership_removal";
  }
  return null;
};

const providerInput = (
  operation: GroupManagementOperation,
  route: GroupRoute,
): GroupManagementProviderInput => ({
  route: routeInput(route),
  operation_id: operation.operation_id,
  conversation_id: operation.conversation_id,
  idempotency_key: operation.operation_id,
  provider_group_id: operation.provider_group_id,
  matrix_room_id: operation.matrix_room_id,
  expected_revision: operation.expected_revision,
  action: operation.action,
  operation_created_at: operation.created_at,
  requested_name: operation.requested_name,
  requested_member_provider_ids: [...operation.requested_member_provider_ids],
});

const providerErrorCode = (error: unknown): string =>
  error instanceof GroupProviderError
    ? `provider_${error.code}`
    : "provider_unavailable";

const isReconciliationError = (error: unknown): boolean =>
  error instanceof GroupProviderError &&
  ["unavailable", "uncertain", "not_found"].includes(error.code);

const recordEvidence = async (
  context: ContactServiceContext,
  operation: GroupManagementOperation,
  group: ManagedProviderGroup,
  accepted: boolean,
  reason: string | null,
  services: GroupManagementRouteServices,
): Promise<void> => {
  await recordGroupManagementEvidence(
    databaseFor(context),
    operation.tenant_id,
    operation.operation_id,
    group,
    accepted,
    reason,
    nowFor(services),
  );
};

const completeFailure = async (
  context: ContactServiceContext,
  operation: GroupManagementOperation,
  failureCode: string,
  services: GroupManagementRouteServices,
  status: "failed" | "human_action_required" = "human_action_required",
): Promise<GroupManagementOperation> =>
  finishGroupManagementOperation(databaseFor(context), operation, {
    status,
    duplicateRisk: status === "human_action_required",
    humanActionRequired: status === "human_action_required",
    failureCode,
    now: nowFor(services),
  });

const completeManaged = async (
  context: ContactServiceContext,
  operation: GroupManagementOperation,
  group: ManagedProviderGroup,
  source: "provider" | "event" | "refresh",
  services: GroupManagementRouteServices,
  finalizeInvalid = true,
): Promise<GroupManagementOperation> => {
  const invalidReason = validateManagedGroup(operation, group, source);
  await recordEvidence(
    context,
    operation,
    group,
    invalidReason === null,
    invalidReason,
    services,
  );
  if (invalidReason !== null) {
    if (!finalizeInvalid) return operation;
    return completeFailure(context, operation, invalidReason, services);
  }
  try {
    return await finishGroupManagementOperation(
      databaseFor(context),
      operation,
      {
        status: "succeeded",
        resultRevision: group.revision,
        resultMemberProviderIds: group.member_provider_ids,
        evidence: GroupManagementEvidenceSchema.parse(group.evidence),
        evidencePath: source,
        duplicateRisk: false,
        humanActionRequired: false,
        now: nowFor(services),
      },
    );
  } catch {
    return completeFailure(
      context,
      operation,
      "group_management_persistence_uncertain",
      services,
    );
  }
};

const reconcileManagementOperation = async (
  context: ContactServiceContext,
  operation: GroupManagementOperation,
  route: GroupRoute,
  provider: GroupProvider,
  services: GroupManagementRouteServices,
): Promise<GroupManagementOperation> => {
  const input = providerInput(operation, route);
  if (provider.observeManagedGroup !== undefined) {
    try {
      const observed = await provider.observeManagedGroup(input);
      if (observed !== null) {
        const result = await completeManaged(
          context,
          operation,
          observed,
          "event",
          services,
          false,
        );
        if (result.status === "succeeded") return result;
      }
    } catch {
      // The bounded refresh below is the only follow-up provider read.
    }
  }
  if (provider.refreshManagedGroup !== undefined) {
    try {
      const refreshed = await provider.refreshManagedGroup(input);
      if (refreshed !== null) {
        const result = await completeManaged(
          context,
          operation,
          refreshed,
          "refresh",
          services,
          false,
        );
        if (result.status === "succeeded") return result;
      }
    } catch {
      // A durable human decision state records the unresolved provider result.
    }
  }
  return completeFailure(
    context,
    operation,
    "group_management_evidence_unresolved",
    services,
  );
};

const dispatchProvider = async (
  context: ContactServiceContext,
  operation: GroupManagementOperation,
  route: GroupRoute,
  provider: GroupProvider,
  services: GroupManagementRouteServices,
): Promise<GroupManagementOperation> => {
  const input = providerInput(operation, route);
  try {
    let result: ManagedProviderGroup;
    if (operation.action === "rename") {
      if (provider.renameGroup === undefined)
        return completeFailure(
          context,
          operation,
          "provider_unsupported",
          services,
          "failed",
        );
      result = await provider.renameGroup(input, operation.requested_name!);
    } else if (operation.action === "add_participants") {
      if (provider.addGroupParticipants === undefined)
        return completeFailure(
          context,
          operation,
          "provider_unsupported",
          services,
          "failed",
        );
      result = await provider.addGroupParticipants(
        input,
        operation.requested_member_provider_ids,
      );
    } else {
      if (provider.removeGroupParticipants === undefined)
        return completeFailure(
          context,
          operation,
          "provider_unsupported",
          services,
          "failed",
        );
      result = await provider.removeGroupParticipants(
        input,
        operation.requested_member_provider_ids,
      );
    }
    return completeManaged(context, operation, result, "provider", services);
  } catch (error) {
    if (!isReconciliationError(error)) {
      return completeFailure(
        context,
        operation,
        providerErrorCode(error),
        services,
        "failed",
      );
    }
    return reconcileManagementOperation(
      context,
      operation,
      route,
      provider,
      services,
    );
  }
};

const dispatchOwner = async (
  context: ContactServiceContext,
  operation: GroupManagementOperation,
  route: GroupRoute,
  provider: GroupProvider,
  services: GroupManagementRouteServices,
): Promise<GroupManagementOperation> => {
  await requireAuthority(context, route, operation.conversation_id);
  await checkCapability(
    databaseFor(context).withSession("first-primary"),
    operation.tenant_id,
    operation.account_id,
  );
  const now = nowFor(services);
  const expiresAt = new Date(
    Date.parse(now) + GROUP_MANAGEMENT_DISPATCH_LEASE_MS,
  ).toISOString();
  const claimed = await claimGroupManagementOperation(
    databaseFor(context),
    operation,
    now,
    expiresAt,
  );
  if (!claimed)
    return completeFailure(
      context,
      operation,
      "group_revision_conflict",
      services,
    );
  return dispatchProvider(context, operation, route, provider, services);
};

const routeAndState = async (
  context: ContactServiceContext,
  input: {
    identity_id: string;
    account_id: string;
    conversation_id: string;
  },
  services: GroupManagementRouteServices,
) => {
  requireManageIdentityScope(context, input.identity_id);
  const db = databaseFor(context);
  const routeRow = await readContactRoute(
    db.withSession("first-primary"),
    context.authorization.tenant.id,
    input.identity_id,
    input.account_id,
  );
  if (routeRow === null) throw new ReadError("not_found");
  const route = routeFor(routeRow);
  await requireAuthority(context, route, input.conversation_id);
  const state = await readGroupManagementGroup(
    db.withSession("first-primary"),
    context.authorization.tenant.id,
    input.identity_id,
    input.account_id,
    input.conversation_id,
    nowFor(services),
  );
  if (state.connection_id !== route.connection_id)
    throw new ReadError("not_found");
  return { db, route, state };
};

const runManagement = async (
  context: ContactServiceContext,
  parsed:
    | { action: "rename"; input: GroupRenameRequest }
    | {
        action: "add_participants" | "remove_participants";
        input: GroupParticipantsRequest;
      },
  services: GroupManagementRouteServices,
): Promise<GroupManagementOperation> => {
  const { input } = parsed;
  const { db, route, state } = await routeAndState(context, input, services);
  const requestedName = "name" in input ? input.name : null;
  const requestedParticipants =
    "participants" in input ? input.participants : [];
  const providerIds =
    parsed.action === "rename"
      ? []
      : await participantSnapshot(context, route, requestedParticipants);
  const requested = [...providerIds].sort();
  const requestHash = await hashRequest({
    action: parsed.action,
    identity_id: input.identity_id,
    account_id: input.account_id,
    conversation_id: input.conversation_id,
    expected_revision: input.expected_revision,
    name: requestedName,
    participants: requested,
  });
  const existing = await readGroupManagementByIdempotency(
    db.withSession("first-primary"),
    context.authorization.tenant.id,
    input.idempotency_key,
  );
  const operationInput: GroupManagementOperationInput = {
    operationId: `group_manage_${crypto.randomUUID().replaceAll("-", "")}`,
    tenantId: context.authorization.tenant.id,
    membershipId: context.authorization.membership.id,
    identityId: input.identity_id,
    accountId: input.account_id,
    connectionId: route.connection_id,
    provider: route.provider,
    conversationId: input.conversation_id,
    providerGroupId: state.provider_group_id,
    matrixRoomId: state.matrix_room_id,
    action: parsed.action,
    requestedName,
    requestedMemberProviderIds: requested,
    expectedRevision: input.expected_revision,
    idempotencyKey: input.idempotency_key,
    requestHash,
    now: nowFor(services),
  };
  // An exact replay must be answered from the durable operation even after
  // the requested state has become current. New operations still reject
  // no-op or duplicate participant requests before inserting any row.
  if (existing === null) {
    if (parsed.action === "rename" && state.name === requestedName)
      throw new ReadError("invalid_request");
    if (parsed.action === "add_participants") {
      if (providerIds.some((id) => state.member_provider_ids.includes(id)))
        throw new ReadError("invalid_request");
    }
    if (parsed.action === "remove_participants") {
      if (providerIds.some((id) => !state.member_provider_ids.includes(id)))
        throw new ReadError("invalid_request");
    }
  }
  const begun = await beginGroupManagementOperation(db, operationInput);
  const operation = begun.operation;
  if (!begun.dispatchOwner) {
    if (
      operation.status === "human_action_required" &&
      operation.failure_code === "group_management_persistence_uncertain"
    ) {
      const provider = providerFor(context, services);
      const now = nowFor(services);
      const expiresAt = new Date(
        Date.parse(now) + GROUP_MANAGEMENT_DISPATCH_LEASE_MS,
      ).toISOString();
      if (await claimGroupManagementOperation(db, operation, now, expiresAt)) {
        return GroupManagementOperationSchema.parse(
          await reconcileManagementOperation(
            context,
            operation,
            route,
            provider,
            services,
          ),
        );
      }
    }
    if (operation.status !== "pending")
      return GroupManagementOperationSchema.parse(operation);
    const age = Date.parse(nowFor(services)) - Date.parse(operation.updated_at);
    const provider = providerFor(context, services);
    if (!Number.isFinite(age) || age <= GROUP_MANAGEMENT_DISPATCH_LEASE_MS)
      return GroupManagementOperationSchema.parse(operation);
    return GroupManagementOperationSchema.parse(
      await reconcileManagementOperation(
        context,
        operation,
        route,
        provider,
        services,
      ),
    );
  }
  const provider = providerFor(context, services);
  return GroupManagementOperationSchema.parse(
    await dispatchOwner(context, operation, route, provider, services),
  );
};

export async function renameGroup(
  context: ContactServiceContext,
  input: GroupRenameRequest,
  services: GroupManagementRouteServices = {},
): Promise<GroupManagementOperation> {
  return runManagement(
    context,
    { action: "rename", input: GroupRenameRequestSchema.parse(input) },
    services,
  );
}

export async function addGroupParticipants(
  context: ContactServiceContext,
  input: GroupParticipantsRequest,
  services: GroupManagementRouteServices = {},
): Promise<GroupManagementOperation> {
  return runManagement(
    context,
    {
      action: "add_participants",
      input: GroupParticipantsRequestSchema.parse(input),
    },
    services,
  );
}

export async function removeGroupParticipants(
  context: ContactServiceContext,
  input: GroupParticipantsRequest,
  services: GroupManagementRouteServices = {},
): Promise<GroupManagementOperation> {
  return runManagement(
    context,
    {
      action: "remove_participants",
      input: GroupParticipantsRequestSchema.parse(input),
    },
    services,
  );
}

export async function listManagedGroupOperations(
  context: ContactServiceContext,
  options: Parameters<typeof listGroupManagementOperations>[2] = {},
) {
  return listGroupManagementOperations(
    databaseFor(context).withSession("first-primary"),
    context.authorization.tenant.id,
    options,
  );
}

export async function getManagedGroup(
  context: ContactServiceContext,
  input: {
    identity_id: string;
    account_id: string;
    conversation_id: string;
  },
  services: GroupManagementRouteServices = {},
) {
  const { state } = await routeAndState(context, input, services);
  return state;
}

export async function listManagementEvidence(
  context: ContactServiceContext,
  operationId: string,
) {
  return groupManagementEvidenceFor(
    databaseFor(context).withSession("first-primary"),
    context.authorization.tenant.id,
    operationId,
  );
}

export async function readManagedGroupOperation(
  context: ContactServiceContext,
  operationId: string,
): Promise<GroupManagementOperation | null> {
  return readGroupManagementOperation(
    databaseFor(context).withSession("first-primary"),
    context.authorization.tenant.id,
    operationId,
  );
}

export type { GroupManagementRepositoryError };
