import {
  GroupManagementEvidenceSchema,
  GroupManagementGroupSchema,
  GroupManagementOperationSchema,
  type GroupManagementEvidence,
  type GroupManagementGroup,
  type GroupManagementOperation,
  type GroupManagementAction,
  type GroupManagementEvidenceSource,
  type GroupManagementStatus,
  ProviderSchema,
} from "@communicator/contracts";
import { z } from "zod";
import type { ManagedProviderGroup } from "./provider";
import type { OutboundCapability } from "../outbound/authority-types";

export type GroupManagementRepositoryErrorCode =
  | "management_invalid"
  | "management_not_found"
  | "management_conflict"
  | "management_unavailable";

const messages: Record<GroupManagementRepositoryErrorCode, string> = {
  management_invalid: "Invalid group management data",
  management_not_found: "Group management target not found",
  management_conflict: "Group management operation conflict",
  management_unavailable: "Group management directory unavailable",
};

export class GroupManagementRepositoryError extends Error {
  constructor(
    readonly code: GroupManagementRepositoryErrorCode,
    cause?: unknown,
  ) {
    super(messages[code]);
    this.name = "GroupManagementRepositoryError";
    if (cause !== undefined)
      Object.defineProperty(this, "cause", { value: cause });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type GroupStateRow = {
  tenant_id: string;
  identity_id: string;
  account_id: string;
  connection_id: string;
  provider: string;
  conversation_id: string;
  provider_group_id: string;
  matrix_room_id: string;
  name: string;
  current_revision: string;
  current_member_provider_ids_json: string;
  current_evidence_json: string | null;
  active_operation_id: string | null;
  active_claim_expires_at: string | null;
  created_at: string;
  updated_at: string;
};

type ManagementOperationRow = {
  operation_id: string;
  tenant_id: string;
  membership_id: string;
  identity_id: string;
  account_id: string;
  connection_id: string;
  session_generation: string;
  provider: string;
  conversation_id: string;
  provider_group_id: string;
  matrix_room_id: string;
  action: string;
  requested_name: string | null;
  requested_member_provider_ids_json: string;
  expected_revision: string;
  request_hash: string;
  idempotency_key: string;
  status: string;
  result_revision: string | null;
  result_member_provider_ids_json: string | null;
  evidence_json: string | null;
  evidence_path: string | null;
  duplicate_risk: number;
  human_action_required: number;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
};

export type GroupManagementOperationInput = {
  operationId: string;
  tenantId: string;
  membershipId: string;
  identityId: string;
  accountId: string;
  connectionId: string;
  provider: "whatsapp" | "telegram" | "messenger" | "linkedin";
  conversationId: string;
  providerGroupId: string;
  matrixRoomId: string;
  action: GroupManagementAction;
  requestedName: string | null;
  requestedMemberProviderIds: readonly string[];
  expectedRevision: string;
  idempotencyKey: string;
  requestHash: string;
  sessionGeneration: string;
  now: string;
};

export type BeginGroupManagementResult = {
  operation: GroupManagementOperation;
  dispatchOwner: boolean;
};

export type GroupManagementCompletion = {
  status: Exclude<GroupManagementStatus, "pending">;
  resultRevision?: string;
  resultMemberProviderIds?: readonly string[];
  evidence?: GroupManagementEvidence;
  evidencePath?: GroupManagementEvidenceSource;
  duplicateRisk: boolean;
  humanActionRequired: boolean;
  /** The current private authority family used for the provider call. */
  authorityKind?: OutboundCapability["kind"];
  failureCode?: string;
  now: string;
};

const groupStateQuery = `
  SELECT tenant_id, identity_id, account_id, connection_id, provider,
         conversation_id, provider_group_id, matrix_room_id, name,
         current_revision, current_member_provider_ids_json,
         current_evidence_json, active_operation_id, active_claim_expires_at,
         created_at, updated_at
    FROM group_management_groups
`;

const operationQuery = `
  SELECT operation_id, tenant_id, membership_id, identity_id, account_id,
         connection_id, provider, conversation_id, provider_group_id,
         matrix_room_id, action, requested_name,
         requested_member_provider_ids_json, expected_revision, request_hash,
         idempotency_key, status, result_revision,
         result_member_provider_ids_json, evidence_json, evidence_path,
         duplicate_risk, human_action_required, failure_code, created_at,
         updated_at, session_generation
    FROM group_management_operations
`;

const parseJson = <T>(value: string, schema: z.ZodType<T>): T => {
  try {
    return schema.parse(JSON.parse(value));
  } catch (error) {
    throw new GroupManagementRepositoryError("management_invalid", error);
  }
};

const mapGroupState = (row: GroupStateRow): GroupManagementGroup =>
  GroupManagementGroupSchema.parse({
    tenant_id: row.tenant_id,
    identity_id: row.identity_id,
    account_id: row.account_id,
    connection_id: row.connection_id,
    provider: ProviderSchema.parse(row.provider),
    conversation_id: row.conversation_id,
    provider_group_id: row.provider_group_id,
    matrix_room_id: row.matrix_room_id,
    name: row.name,
    current_revision: row.current_revision,
    member_provider_ids: parseJson(
      row.current_member_provider_ids_json,
      z.array(z.string().trim().min(1).max(512)).max(128),
    ),
    evidence:
      row.current_evidence_json === null
        ? null
        : parseJson(row.current_evidence_json, GroupManagementEvidenceSchema),
    updated_at: row.updated_at,
  });

const mapOperation = (
  row: ManagementOperationRow,
  state: GroupManagementGroup,
): GroupManagementOperation =>
  GroupManagementOperationSchema.parse({
    operation_id: row.operation_id,
    tenant_id: row.tenant_id,
    membership_id: row.membership_id,
    identity_id: row.identity_id,
    account_id: row.account_id,
    connection_id: row.connection_id,
    provider: ProviderSchema.parse(row.provider),
    conversation_id: row.conversation_id,
    provider_group_id: row.provider_group_id,
    matrix_room_id: row.matrix_room_id,
    action: row.action,
    requested_name: row.requested_name,
    requested_member_provider_ids: parseJson(
      row.requested_member_provider_ids_json,
      z.array(z.string().trim().min(1).max(512)).max(128),
    ),
    expected_revision: row.expected_revision,
    request_hash: row.request_hash,
    status: row.status,
    result_revision: row.result_revision,
    result_member_provider_ids:
      row.result_member_provider_ids_json === null
        ? null
        : parseJson(
            row.result_member_provider_ids_json,
            z.array(z.string().trim().min(1).max(512)).max(128),
          ),
    current_name: state.name,
    current_revision: state.current_revision,
    current_member_provider_ids: state.member_provider_ids,
    evidence:
      row.evidence_json === null
        ? null
        : parseJson(row.evidence_json, GroupManagementEvidenceSchema),
    evidence_path:
      row.evidence_path === null
        ? null
        : z.enum(["provider", "event", "refresh"]).parse(row.evidence_path),
    duplicate_risk: row.duplicate_risk === 1,
    human_action_required: row.human_action_required === 1,
    failure_code: row.failure_code,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });

const readState = async (
  db: D1DatabaseSession,
  tenantId: string,
  conversationId: string,
): Promise<GroupManagementGroup | null> => {
  const row = await db
    .prepare(`${groupStateQuery} WHERE tenant_id = ? AND conversation_id = ?`)
    .bind(tenantId, conversationId)
    .first<GroupStateRow>();
  return row === null ? null : mapGroupState(row);
};

const readOperationRow = async (
  db: D1DatabaseSession,
  tenantId: string,
  operationId: string,
): Promise<ManagementOperationRow | null> =>
  db
    .prepare(
      `${operationQuery} WHERE tenant_id = ? AND operation_id = ? LIMIT 1`,
    )
    .bind(tenantId, operationId)
    .first<ManagementOperationRow>();

const readOperationWithState = async (
  db: D1DatabaseSession,
  tenantId: string,
  operationId: string,
): Promise<GroupManagementOperation | null> => {
  const row = await readOperationRow(db, tenantId, operationId);
  if (row === null) return null;
  const state = await readState(db, tenantId, row.conversation_id);
  if (state === null)
    throw new GroupManagementRepositoryError("management_not_found");
  return mapOperation(row, state);
};

const seedStateFromCreation = async (
  db: D1DatabaseSession,
  tenantId: string,
  identityId: string,
  accountId: string,
  conversationId: string,
  now: string,
): Promise<GroupManagementGroup> => {
  const existing = await readState(db, tenantId, conversationId);
  if (existing !== null) return existing;
  const creation = await db
    .prepare(
      `SELECT connection_id, provider, provider_group_id, matrix_room_id,
              name, participant_provider_ids_json
         FROM group_creation_operations
        WHERE tenant_id = ? AND identity_id = ? AND account_id = ?
          AND conversation_id = ? AND status = 'created'
        LIMIT 1`,
    )
    .bind(tenantId, identityId, accountId, conversationId)
    .first<{
      connection_id: string;
      provider: string;
      provider_group_id: string | null;
      matrix_room_id: string | null;
      name: string;
      participant_provider_ids_json: string;
    }>();
  if (
    creation === null ||
    creation.provider_group_id === null ||
    creation.matrix_room_id === null
  ) {
    throw new GroupManagementRepositoryError("management_not_found");
  }
  const participants = parseJson(
    creation.participant_provider_ids_json,
    z.array(z.string().trim().min(1).max(512)).max(128),
  );
  try {
    await db
      .prepare(
        `INSERT INTO group_management_groups (
           tenant_id, identity_id, account_id, connection_id, provider,
           conversation_id, provider_group_id, matrix_room_id, name,
           current_revision, current_member_provider_ids_json,
           current_evidence_json, active_operation_id, active_claim_expires_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '0', ?, NULL, NULL, NULL, ?, ?)
         ON CONFLICT(tenant_id, conversation_id) DO NOTHING`,
      )
      .bind(
        tenantId,
        identityId,
        accountId,
        creation.connection_id,
        creation.provider,
        conversationId,
        creation.provider_group_id,
        creation.matrix_room_id,
        creation.name,
        JSON.stringify(participants),
        now,
        now,
      )
      .run();
  } catch (error) {
    throw new GroupManagementRepositoryError("management_conflict", error);
  }
  const state = await readState(db, tenantId, conversationId);
  if (state === null)
    throw new GroupManagementRepositoryError("management_not_found");
  return state;
};

export async function readGroupManagementGroup(
  db: D1DatabaseSession,
  tenantId: string,
  identityId: string,
  accountId: string,
  conversationId: string,
  now: string,
): Promise<GroupManagementGroup> {
  try {
    const state = await readState(db, tenantId, conversationId);
    if (state !== null) {
      if (state.identity_id !== identityId || state.account_id !== accountId)
        throw new GroupManagementRepositoryError("management_not_found");
      return state;
    }
    return seedStateFromCreation(
      db,
      tenantId,
      identityId,
      accountId,
      conversationId,
      now,
    );
  } catch (error) {
    if (error instanceof GroupManagementRepositoryError) throw error;
    throw new GroupManagementRepositoryError("management_unavailable", error);
  }
}

export async function beginGroupManagementOperation(
  db: D1Database,
  input: GroupManagementOperationInput,
): Promise<BeginGroupManagementResult> {
  const requested = z
    .array(z.string().trim().min(1).max(512))
    .max(128)
    .parse(input.requestedMemberProviderIds);
  try {
    const existing = await readGroupManagementByIdempotency(
      db.withSession("first-primary"),
      input.tenantId,
      input.idempotencyKey,
    );
    if (existing !== null) {
      if (existing.requestHash !== input.requestHash)
        throw new GroupManagementRepositoryError("management_conflict");
      return { operation: existing.operation, dispatchOwner: false };
    }
    const state = await seedStateFromCreation(
      db.withSession("first-primary"),
      input.tenantId,
      input.identityId,
      input.accountId,
      input.conversationId,
      input.now,
    );
    if (
      state.provider_group_id !== input.providerGroupId ||
      state.matrix_room_id !== input.matrixRoomId
    ) {
      throw new GroupManagementRepositoryError("management_conflict");
    }
    await db
      .prepare(
        `INSERT INTO group_management_operations (
           operation_id, tenant_id, membership_id, identity_id, account_id,
           connection_id, provider, conversation_id, provider_group_id,
           matrix_room_id, action, requested_name,
           requested_member_provider_ids_json, expected_revision, request_hash,
           idempotency_key, status, result_revision,
           result_member_provider_ids_json, evidence_json, evidence_path,
           duplicate_risk, human_action_required, failure_code, created_at,
           updated_at, session_generation
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending',
                   NULL, NULL, NULL, NULL, 0, 0, NULL, ?, ?, ?)`,
      )
      .bind(
        input.operationId,
        input.tenantId,
        input.membershipId,
        input.identityId,
        input.accountId,
        input.connectionId,
        input.provider,
        input.conversationId,
        input.providerGroupId,
        input.matrixRoomId,
        input.action,
        input.requestedName,
        JSON.stringify(requested),
        input.expectedRevision,
        input.requestHash,
        input.idempotencyKey,
        input.now,
        input.now,
        input.sessionGeneration,
      )
      .run();
    const operation = await readOperationWithState(
      db.withSession("first-primary"),
      input.tenantId,
      input.operationId,
    );
    if (operation === null)
      throw new GroupManagementRepositoryError("management_not_found");
    return { operation, dispatchOwner: true };
  } catch (error) {
    if (error instanceof GroupManagementRepositoryError) throw error;
    const existing = await readGroupManagementByIdempotency(
      db.withSession("first-primary"),
      input.tenantId,
      input.idempotencyKey,
    ).catch(() => null);
    if (existing !== null) {
      if (existing.requestHash !== input.requestHash)
        throw new GroupManagementRepositoryError("management_conflict");
      return { operation: existing.operation, dispatchOwner: false };
    }
    throw new GroupManagementRepositoryError("management_conflict", error);
  }
}

export async function readGroupManagementByIdempotency(
  db: D1DatabaseSession,
  tenantId: string,
  idempotencyKey: string,
): Promise<{
  operation: GroupManagementOperation;
  requestHash: string;
} | null> {
  try {
    const row = await db
      .prepare(
        `${operationQuery} WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`,
      )
      .bind(tenantId, idempotencyKey)
      .first<ManagementOperationRow>();
    if (row === null) return null;
    const operation = await readOperationWithState(
      db,
      tenantId,
      row.operation_id,
    );
    if (operation === null)
      throw new GroupManagementRepositoryError("management_not_found");
    return { operation, requestHash: row.request_hash };
  } catch (error) {
    if (error instanceof GroupManagementRepositoryError) throw error;
    throw new GroupManagementRepositoryError("management_unavailable", error);
  }
}

export async function claimGroupManagementOperation(
  db: D1Database,
  operation: GroupManagementOperation,
  now: string,
  expiresAt: string,
): Promise<boolean> {
  try {
    const result = await db
      .prepare(
        `UPDATE group_management_groups
            SET active_operation_id = ?, active_claim_expires_at = ?
          WHERE tenant_id = ? AND conversation_id = ?
            AND current_revision = ?
            AND (
              active_operation_id IS NULL OR
              active_claim_expires_at IS NULL OR
              active_claim_expires_at <= ?
            )`,
      )
      .bind(
        operation.operation_id,
        expiresAt,
        operation.tenant_id,
        operation.conversation_id,
        operation.expected_revision,
        now,
      )
      .run();
    return (result.meta.changes ?? 0) === 1;
  } catch (error) {
    throw new GroupManagementRepositoryError("management_conflict", error);
  }
}

export async function recordGroupManagementEvidence(
  db: D1Database,
  tenantId: string,
  operationId: string,
  managed: ManagedProviderGroup,
  accepted: boolean,
  reason: string | null,
  now: string,
): Promise<void> {
  const evidence = GroupManagementEvidenceSchema.parse({
    ...managed.evidence,
    accepted,
    reason: reason ?? managed.evidence.reason,
  });
  try {
    await db
      .prepare(
        `INSERT INTO group_management_evidence (
           id, tenant_id, operation_id, source, evidence_id, observed_at,
           account_id, connection_id, provider_group_id, matrix_room_id,
           revision, name, member_provider_ids_json, accepted, reason, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, operation_id, evidence_id)
         DO UPDATE SET accepted = excluded.accepted,
                       reason = excluded.reason,
                       created_at = excluded.created_at`,
      )
      .bind(
        `group_management_evidence_${operationId}_${evidence.evidence_id}`.slice(
          0,
          128,
        ),
        tenantId,
        operationId,
        evidence.source,
        evidence.evidence_id,
        evidence.observed_at,
        evidence.account_id,
        evidence.connection_id,
        evidence.provider_group_id,
        evidence.matrix_room_id,
        evidence.revision,
        evidence.name,
        JSON.stringify(evidence.member_provider_ids),
        accepted ? 1 : 0,
        evidence.reason,
        now,
      )
      .run();
  } catch (error) {
    throw new GroupManagementRepositoryError("management_unavailable", error);
  }
}

export async function finishGroupManagementOperation(
  db: D1Database,
  operation: GroupManagementOperation,
  completion: GroupManagementCompletion,
): Promise<GroupManagementOperation> {
  try {
    const statements: D1PreparedStatement[] = [];
    if (completion.status === "succeeded") {
      if (
        completion.resultRevision === undefined ||
        completion.resultMemberProviderIds === undefined ||
        completion.evidence === undefined ||
        completion.evidencePath === undefined
      ) {
        throw new GroupManagementRepositoryError("management_invalid");
      }
      const completionUpdate =
        completion.authorityKind === "owner_admin"
          ? db
              .prepare(
                `UPDATE group_management_groups
                    SET name = ?, current_revision = ?,
                        current_member_provider_ids_json = ?, current_evidence_json = ?,
                        active_operation_id = NULL, active_claim_expires_at = NULL,
                        updated_at = ?
                  WHERE tenant_id = ? AND conversation_id = ?
                    AND current_revision = ? AND active_operation_id = ?
                    AND EXISTS (
                      SELECT 1
                        FROM memberships AS m
                        JOIN tenants AS t ON t.id = m.tenant_id
                        JOIN principals AS p ON p.id = m.principal_id
                        JOIN identities AS i ON i.tenant_id = m.tenant_id
                        JOIN connections AS c ON c.tenant_id = m.tenant_id
                        JOIN connection_accounts AS ca
                          ON ca.connection_id = c.id
                         AND ca.status = 'active'
                       WHERE m.tenant_id = ?
                         AND m.id = ?
                         AND m.status = 'active'
                         AND m.role IN ('owner', 'admin')
                         AND t.status = 'active'
                         AND p.status = 'active'
                         AND p.revoked_at IS NULL
                         AND p.principal_type IN ('human', 'operator')
                         AND i.id = ?
                         AND i.status = 'active'
                         AND i.identity_kind = 'human'
                         AND c.id = ?
                         AND c.identity_id = i.id
                         AND ca.account_id = ?
                    )`,
              )
              .bind(
                completion.evidence.name,
                completion.resultRevision,
                JSON.stringify(completion.resultMemberProviderIds),
                JSON.stringify(completion.evidence),
                completion.now,
                operation.tenant_id,
                operation.conversation_id,
                operation.expected_revision,
                operation.operation_id,
                operation.tenant_id,
                operation.membership_id,
                operation.identity_id,
                operation.connection_id,
                operation.account_id,
              )
          : db
              .prepare(
                `UPDATE group_management_groups
                    SET name = ?, current_revision = ?,
                        current_member_provider_ids_json = ?, current_evidence_json = ?,
                        active_operation_id = NULL, active_claim_expires_at = NULL,
                        updated_at = ?
                  WHERE tenant_id = ? AND conversation_id = ?
                    AND current_revision = ? AND active_operation_id = ?
                    AND EXISTS (
                      SELECT 1
                        FROM account_grants AS ag
                        JOIN connections AS c
                          ON c.tenant_id = ag.tenant_id
                        JOIN connection_accounts AS ca
                          ON ca.connection_id = c.id
                         AND ca.account_id = ag.account_id
                         AND ca.status = 'active'
                       WHERE ag.tenant_id = ?
                         AND ag.membership_id = ?
                         AND ag.identity_id = ?
                         AND ag.account_id = ?
                         AND ag.operation_scope = 'group.manage'
                         AND ag.status = 'active'
                         AND (
                           ag.chat_scope = 'all_chats'
                           OR EXISTS (
                             SELECT 1
                               FROM account_grant_chats AS gc
                              WHERE gc.tenant_id = ag.tenant_id
                                AND gc.grant_id = ag.id
                                AND gc.chat_id = ?
                           )
                         )
                    )
                    AND EXISTS (
                      SELECT 1
                        FROM account_grants AS ag
                        JOIN connections AS c
                          ON c.tenant_id = ag.tenant_id
                        JOIN connection_accounts AS ca
                          ON ca.connection_id = c.id
                         AND ca.account_id = ag.account_id
                         AND ca.status = 'active'
                       WHERE ag.tenant_id = ?
                         AND ag.membership_id = ?
                         AND ag.identity_id = ?
                         AND ag.account_id = ?
                         AND ag.operation_scope = 'conversation.read'
                         AND ag.status = 'active'
                         AND (
                           ag.chat_scope = 'all_chats'
                           OR EXISTS (
                             SELECT 1
                               FROM account_grant_chats AS gc
                              WHERE gc.tenant_id = ag.tenant_id
                                AND gc.grant_id = ag.id
                                AND gc.chat_id = ?
                           )
                         )
                    )`,
              )
              .bind(
                completion.evidence.name,
                completion.resultRevision,
                JSON.stringify(completion.resultMemberProviderIds),
                JSON.stringify(completion.evidence),
                completion.now,
                operation.tenant_id,
                operation.conversation_id,
                operation.expected_revision,
                operation.operation_id,
                operation.tenant_id,
                operation.membership_id,
                operation.identity_id,
                operation.account_id,
                operation.conversation_id,
                operation.tenant_id,
                operation.membership_id,
                operation.identity_id,
                operation.account_id,
                operation.conversation_id,
              );
      statements.push(completionUpdate);
      statements.push(
        db
          .prepare(
            `UPDATE group_management_operations
                SET status = 'succeeded', result_revision = ?,
                    result_member_provider_ids_json = ?, evidence_json = ?,
                    evidence_path = ?, duplicate_risk = ?,
                    human_action_required = ?, failure_code = NULL, updated_at = ?
              WHERE tenant_id = ? AND operation_id = ?
                AND status IN ('pending', 'human_action_required')
                AND EXISTS (
                  SELECT 1
                    FROM group_management_groups
                   WHERE tenant_id = ? AND conversation_id = ?
                     AND current_revision = ?
                     AND active_operation_id IS NULL
                     AND current_evidence_json = ?
                )`,
          )
          .bind(
            completion.resultRevision,
            JSON.stringify(completion.resultMemberProviderIds),
            JSON.stringify(completion.evidence),
            completion.evidencePath,
            completion.duplicateRisk ? 1 : 0,
            completion.humanActionRequired ? 1 : 0,
            completion.now,
            operation.tenant_id,
            operation.operation_id,
            operation.tenant_id,
            operation.conversation_id,
            completion.resultRevision,
            JSON.stringify(completion.evidence),
          ),
      );
    } else {
      statements.push(
        db
          .prepare(
            `UPDATE group_management_groups
                SET active_operation_id = NULL, active_claim_expires_at = NULL,
                    updated_at = ?
              WHERE tenant_id = ? AND conversation_id = ?
                AND active_operation_id = ?`,
          )
          .bind(
            completion.now,
            operation.tenant_id,
            operation.conversation_id,
            operation.operation_id,
          ),
      );
      statements.push(
        db
          .prepare(
            `UPDATE group_management_operations
                SET status = ?, evidence_json = ?, evidence_path = ?,
                    duplicate_risk = ?, human_action_required = ?,
                    failure_code = ?, updated_at = ?
              WHERE tenant_id = ? AND operation_id = ? AND status = 'pending'`,
          )
          .bind(
            completion.status,
            completion.evidence === undefined
              ? null
              : JSON.stringify(completion.evidence),
            completion.evidencePath ?? null,
            completion.duplicateRisk ? 1 : 0,
            completion.humanActionRequired ? 1 : 0,
            completion.failureCode ?? null,
            completion.now,
            operation.tenant_id,
            operation.operation_id,
          ),
      );
    }
    const results = await db.batch(statements);
    if (
      completion.status === "succeeded" &&
      ((results[0]?.meta.changes ?? 0) !== 1 ||
        (results[1]?.meta.changes ?? 0) !== 1)
    ) {
      throw new GroupManagementRepositoryError("management_conflict");
    }
    const finished = await readOperationWithState(
      db.withSession("first-primary"),
      operation.tenant_id,
      operation.operation_id,
    );
    if (finished === null)
      throw new GroupManagementRepositoryError("management_not_found");
    return finished;
  } catch (error) {
    if (error instanceof GroupManagementRepositoryError) throw error;
    throw new GroupManagementRepositoryError("management_conflict", error);
  }
}

export async function listGroupManagementOperations(
  db: D1DatabaseSession,
  tenantId: string,
  options: {
    identityId?: string;
    accountId?: string;
    status?: GroupManagementStatus;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<{ items: GroupManagementOperation[]; next_cursor: string | null }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const conditions = ["o.tenant_id = ?"];
  const values: string[] = [tenantId];
  if (options.identityId !== undefined) {
    conditions.push("o.identity_id = ?");
    values.push(options.identityId);
  }
  if (options.accountId !== undefined) {
    conditions.push("o.account_id = ?");
    values.push(options.accountId);
  }
  if (options.status !== undefined) {
    conditions.push("o.status = ?");
    values.push(options.status);
  }
  if (options.cursor !== undefined) {
    conditions.push("o.operation_id < ?");
    values.push(options.cursor);
  }
  try {
    const rows = await db
      .prepare(
        `${operationQuery.replace("FROM group_management_operations", "FROM group_management_operations AS o")} WHERE ${conditions.join(" AND ")} ORDER BY o.operation_id DESC LIMIT ?`,
      )
      .bind(...values, limit + 1)
      .all<ManagementOperationRow>();
    const visible = rows.results.slice(0, limit);
    const items: GroupManagementOperation[] = [];
    for (const row of visible) {
      const state = await readState(db, tenantId, row.conversation_id);
      if (state !== null) items.push(mapOperation(row, state));
    }
    return {
      items,
      next_cursor:
        rows.results.length > limit
          ? (visible[visible.length - 1]?.operation_id ?? null)
          : null,
    };
  } catch (error) {
    if (error instanceof GroupManagementRepositoryError) throw error;
    throw new GroupManagementRepositoryError("management_unavailable", error);
  }
}

export async function readGroupManagementOperation(
  db: D1DatabaseSession,
  tenantId: string,
  operationId: string,
): Promise<GroupManagementOperation | null> {
  try {
    return await readOperationWithState(db, tenantId, operationId);
  } catch (error) {
    if (error instanceof GroupManagementRepositoryError) throw error;
    throw new GroupManagementRepositoryError("management_unavailable", error);
  }
}

export async function groupManagementEvidenceFor(
  db: D1DatabaseSession,
  tenantId: string,
  operationId: string,
): Promise<GroupManagementEvidence[]> {
  try {
    const rows = await db
      .prepare(
        `SELECT source, evidence_id, observed_at, account_id, connection_id,
                provider_group_id, matrix_room_id, revision, name,
                member_provider_ids_json, accepted, reason
           FROM group_management_evidence
          WHERE tenant_id = ? AND operation_id = ?
          ORDER BY observed_at ASC, id ASC`,
      )
      .bind(tenantId, operationId)
      .all<{
        source: string;
        evidence_id: string;
        observed_at: string;
        account_id: string | null;
        connection_id: string | null;
        provider_group_id: string | null;
        matrix_room_id: string | null;
        revision: string | null;
        name: string | null;
        member_provider_ids_json: string | null;
        accepted: number;
        reason: string | null;
      }>();
    return rows.results.flatMap((row) => {
      if (
        row.account_id === null ||
        row.connection_id === null ||
        row.provider_group_id === null ||
        row.matrix_room_id === null ||
        row.revision === null ||
        row.name === null ||
        row.member_provider_ids_json === null
      ) {
        return [];
      }
      return [
        GroupManagementEvidenceSchema.parse({
          source: row.source,
          evidence_id: row.evidence_id,
          observed_at: row.observed_at,
          operation_id: operationId,
          account_id: row.account_id,
          connection_id: row.connection_id,
          provider_group_id: row.provider_group_id,
          matrix_room_id: row.matrix_room_id,
          revision: row.revision,
          name: row.name,
          member_provider_ids: parseJson(
            row.member_provider_ids_json,
            z.array(z.string().trim().min(1).max(512)).max(128),
          ),
          status: "confirmed",
          reason: row.reason,
          accepted: row.accepted === 1,
        }),
      ];
    });
  } catch (error) {
    if (error instanceof GroupManagementRepositoryError) throw error;
    throw new GroupManagementRepositoryError("management_unavailable", error);
  }
}
