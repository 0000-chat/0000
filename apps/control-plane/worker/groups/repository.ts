import {
  GroupAccessGrantSchema,
  GroupCreationOperationSchema,
  GroupEvidenceSchema,
  GroupParticipantSchema,
  ProviderSchema,
  WebhookSubscriptionEvaluationSchema,
  type GroupCreationOperation,
  type GroupEvidence,
  type GroupParticipant,
  type Provider,
  type WebhookSubscriptionEvaluation,
} from "@communicator/contracts";
import { z } from "zod";
import { evaluateWebhookSubscription } from "../control-directory/webhooks";

export type GroupRepositoryErrorCode =
  | "group_invalid"
  | "group_not_found"
  | "group_conflict"
  | "group_unavailable";

const messages: Record<GroupRepositoryErrorCode, string> = {
  group_invalid: "Invalid group data",
  group_not_found: "Group operation not found",
  group_conflict: "Group operation conflict",
  group_unavailable: "Group directory unavailable",
};

export class GroupRepositoryError extends Error {
  constructor(
    readonly code: GroupRepositoryErrorCode,
    cause?: unknown,
  ) {
    super(messages[code]);
    this.name = "GroupRepositoryError";
    if (cause !== undefined)
      Object.defineProperty(this, "cause", { value: cause });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type GroupOperationRow = {
  operation_id: string;
  tenant_id: string;
  membership_id: string;
  identity_id: string;
  account_id: string;
  connection_id: string;
  session_generation: string;
  provider: string;
  conversation_id: string;
  idempotency_key: string;
  request_hash: string;
  name: string;
  participant_contacts_json: string;
  participant_provider_ids_json: string;
  status: string;
  provider_group_id: string | null;
  matrix_room_id: string | null;
  evidence_json: string | null;
  evidence_path: string | null;
  duplicate_risk: number;
  human_action_required: number;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
};

type AccessGrantRow = {
  operation_scope: "conversation.read" | "message.send";
  grant_id: string;
  conversation_id: string;
};

type ExistingAccountGrantRow = {
  operation_scope: "conversation.read" | "message.send";
  id: string;
  status: "active" | "revoked";
  chat_scope: "all_chats" | "selected_chats";
};

type WebhookEvaluationRow = {
  subscription_id: string;
  account_id: string;
  conversation_id: string;
  enabled: number;
  source: "chat" | "account" | "global";
};

const parseJson = <T>(value: string, schema: z.ZodType<T>): T => {
  try {
    return schema.parse(JSON.parse(value));
  } catch (error) {
    throw new GroupRepositoryError("group_invalid", error);
  }
};

const groupOperationQuery = `
  SELECT operation_id, tenant_id, membership_id, identity_id, account_id, connection_id,
         provider, conversation_id, idempotency_key, request_hash, name,
         participant_contacts_json, participant_provider_ids_json, status,
         provider_group_id, matrix_room_id, evidence_json, evidence_path,
         duplicate_risk, human_action_required, failure_code, created_at,
         updated_at, session_generation
    FROM group_creation_operations
`;

const mapOperation = (
  row: GroupOperationRow,
  accessGrants: readonly AccessGrantRow[],
  webhookEvaluations: readonly WebhookEvaluationRow[],
): GroupCreationOperation => {
  const participants = parseJson(
    row.participant_contacts_json,
    z.array(GroupParticipantSchema).min(1).max(128),
  );
  const evidence =
    row.evidence_json === null
      ? null
      : parseJson(row.evidence_json, GroupEvidenceSchema);
  const provider = ProviderSchema.parse(row.provider);
  const access = accessGrants.map((grant) =>
    GroupAccessGrantSchema.parse({
      operation_scope: grant.operation_scope,
      grant_id: grant.grant_id,
      conversation_id: grant.conversation_id,
      source: "group_creation",
    }),
  );
  const evaluations = webhookEvaluations.map((evaluation) =>
    WebhookSubscriptionEvaluationSchema.parse({
      subscription_id: evaluation.subscription_id,
      account_id: evaluation.account_id,
      chat_id: evaluation.conversation_id,
      enabled: evaluation.enabled === 1,
      source: evaluation.source,
    }),
  );
  return GroupCreationOperationSchema.parse({
    operation_id: row.operation_id,
    tenant_id: row.tenant_id,
    membership_id: row.membership_id,
    identity_id: row.identity_id,
    account_id: row.account_id,
    connection_id: row.connection_id,
    provider,
    conversation_id: row.conversation_id,
    name: row.name,
    participants,
    status: z
      .enum(["pending", "created", "failed", "human_action_required"])
      .parse(row.status),
    provider_group_id: row.provider_group_id,
    matrix_room_id: row.matrix_room_id,
    evidence,
    evidence_path:
      row.evidence_path === null
        ? null
        : z.enum(["provider", "event", "refresh"]).parse(row.evidence_path),
    duplicate_risk: row.duplicate_risk === 1,
    human_action_required: row.human_action_required === 1,
    failure_code: row.failure_code,
    access_grants: access,
    webhook_evaluations: evaluations,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
};

const readOperationWithChildren = async (
  db: D1DatabaseSession,
  tenantId: string,
  operationId: string,
): Promise<GroupCreationOperation | null> => {
  const row = await db
    .prepare(
      `${groupOperationQuery} WHERE tenant_id = ? AND operation_id = ? LIMIT 1`,
    )
    .bind(tenantId, operationId)
    .first<GroupOperationRow>();
  if (row === null) return null;
  const [access, evaluations] = await Promise.all([
    db
      .prepare(
        "SELECT operation_scope, grant_id, conversation_id FROM group_creation_access_grants WHERE tenant_id = ? AND operation_id = ? ORDER BY operation_scope",
      )
      .bind(tenantId, operationId)
      .all<AccessGrantRow>(),
    db
      .prepare(
        "SELECT subscription_id, account_id, conversation_id, enabled, source FROM group_creation_webhook_evaluations WHERE tenant_id = ? AND operation_id = ? ORDER BY subscription_id",
      )
      .bind(tenantId, operationId)
      .all<WebhookEvaluationRow>(),
  ]);
  return mapOperation(row, access.results, evaluations.results);
};

export type GroupCreationOperationInput = {
  operationId: string;
  tenantId: string;
  membershipId: string;
  identityId: string;
  accountId: string;
  connectionId: string;
  provider: Provider;
  conversationId: string;
  idempotencyKey: string;
  requestHash: string;
  name: string;
  participants: readonly GroupParticipant[];
  participantProviderIds: readonly string[];
  sessionGeneration: string;
  now: string;
};

export type BeginGroupCreationResult = {
  operation: GroupCreationOperation;
  dispatchOwner: boolean;
};

export async function readGroupCreationOperation(
  db: D1DatabaseSession,
  tenantId: string,
  operationId: string,
): Promise<GroupCreationOperation | null> {
  try {
    return await readOperationWithChildren(db, tenantId, operationId);
  } catch (error) {
    if (error instanceof GroupRepositoryError) throw error;
    throw new GroupRepositoryError("group_unavailable", error);
  }
}

export async function readGroupCreationByIdempotency(
  db: D1DatabaseSession,
  tenantId: string,
  idempotencyKey: string,
): Promise<{ operation: GroupCreationOperation; requestHash: string } | null> {
  try {
    const row = await db
      .prepare(
        `${groupOperationQuery} WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`,
      )
      .bind(tenantId, idempotencyKey)
      .first<GroupOperationRow>();
    if (row === null) return null;
    const operation = await readOperationWithChildren(
      db,
      tenantId,
      row.operation_id,
    );
    if (operation === null) throw new GroupRepositoryError("group_not_found");
    return { operation, requestHash: row.request_hash };
  } catch (error) {
    if (error instanceof GroupRepositoryError) throw error;
    throw new GroupRepositoryError("group_unavailable", error);
  }
}

export async function beginGroupCreationOperation(
  db: D1Database,
  input: GroupCreationOperationInput,
): Promise<BeginGroupCreationResult> {
  const participants = z
    .array(GroupParticipantSchema)
    .min(1)
    .max(128)
    .parse(input.participants);
  try {
    const existing = await readGroupCreationByIdempotency(
      db.withSession("first-primary"),
      input.tenantId,
      input.idempotencyKey,
    );
    if (existing !== null) {
      if (existing.requestHash !== input.requestHash)
        throw new GroupRepositoryError("group_conflict");
      return { operation: existing.operation, dispatchOwner: false };
    }
    await db
      .prepare(
        `INSERT INTO group_creation_operations (
           operation_id, tenant_id, membership_id, identity_id, account_id, connection_id,
           provider, conversation_id, idempotency_key, request_hash, name,
           participant_contacts_json, participant_provider_ids_json, status,
           provider_group_id, matrix_room_id, evidence_json, evidence_path,
           duplicate_risk, human_action_required, failure_code, created_at,
           updated_at, session_generation
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL,
                   NULL, NULL, 0, 0, NULL, ?, ?, ?)`,
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
        input.idempotencyKey,
        input.requestHash,
        input.name,
        JSON.stringify(participants),
        JSON.stringify(input.participantProviderIds),
        input.now,
        input.now,
        input.sessionGeneration,
      )
      .run();
    const operation = await readOperationWithChildren(
      db.withSession("first-primary"),
      input.tenantId,
      input.operationId,
    );
    if (operation === null) throw new GroupRepositoryError("group_not_found");
    return { operation, dispatchOwner: true };
  } catch (error) {
    if (error instanceof GroupRepositoryError) throw error;
    // A concurrent caller may have won the unique idempotency insert. Read it
    // back and only dispatch if this request really inserted the row.
    const existing = await readGroupCreationByIdempotency(
      db.withSession("first-primary"),
      input.tenantId,
      input.idempotencyKey,
    ).catch(() => null);
    if (existing !== null) {
      if (existing.requestHash !== input.requestHash)
        throw new GroupRepositoryError("group_conflict");
      return { operation: existing.operation, dispatchOwner: false };
    }
    throw new GroupRepositoryError("group_conflict", error);
  }
}

export type GroupCompletion = {
  membershipId: string;
  status: "created" | "failed" | "human_action_required";
  providerGroupId?: string;
  matrixRoomId?: string;
  evidence?: GroupEvidence;
  evidencePath?: "provider" | "event" | "refresh";
  duplicateRisk: boolean;
  humanActionRequired: boolean;
  failureCode?: string;
  accessGrants?: readonly {
    operationScope: "conversation.read" | "message.send";
    grantId: string;
  }[];
  webhookEvaluations?: readonly WebhookSubscriptionEvaluation[];
  now: string;
};

const grantIdFor = (
  operation: GroupCreationOperation,
  scope: "conversation.read" | "message.send",
): string =>
  `grant_${operation.operation_id}_${scope === "conversation.read" ? "read" : "send"}`.slice(
    0,
    128,
  );

export async function finishGroupCreationOperation(
  db: D1Database,
  operation: GroupCreationOperation,
  completion: GroupCompletion,
): Promise<GroupCreationOperation> {
  try {
    const stored = await db
      .prepare(
        "SELECT membership_id FROM group_creation_operations WHERE tenant_id = ? AND operation_id = ? LIMIT 1",
      )
      .bind(operation.tenant_id, operation.operation_id)
      .first<{ membership_id: string }>();
    if (stored === null) throw new GroupRepositoryError("group_not_found");
    const membershipId = stored.membership_id;
    const statements: D1PreparedStatement[] = [
      db
        .prepare(
          `UPDATE group_creation_operations
              SET status = ?, provider_group_id = ?, matrix_room_id = ?,
                  evidence_json = ?, evidence_path = ?, duplicate_risk = ?,
                  human_action_required = ?, failure_code = ?, updated_at = ?
            WHERE tenant_id = ? AND operation_id = ?`,
        )
        .bind(
          completion.status,
          completion.providerGroupId ?? null,
          completion.matrixRoomId ?? null,
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
    ];
    if (completion.status === "created") {
      const scopes: Array<"conversation.read" | "message.send"> = [
        "conversation.read",
        "message.send",
      ];
      const existing = await db
        .prepare(
          "SELECT operation_scope, id, status, chat_scope FROM account_grants WHERE tenant_id = ? AND membership_id = ? AND identity_id = ? AND account_id = ? AND operation_scope IN ('conversation.read', 'message.send')",
        )
        .bind(
          operation.tenant_id,
          membershipId,
          operation.identity_id,
          operation.account_id,
        )
        .all<ExistingAccountGrantRow>();
      const existingByScope = new Map(
        existing.results.map((row) => [row.operation_scope, row]),
      );
      // The membership is supplied by the service through the stable source
      // rows. It is deliberately not inferred from an identity ID in SQL.
      const access = completion.accessGrants ?? [];
      if (access.length !== 2) throw new GroupRepositoryError("group_invalid");
      for (const scope of scopes) {
        // Reuse an existing grant's primary key when the account already has
        // that scope. The upsert preserves that key; using a newly proposed
        // key for account_grant_chats would violate its foreign key.
        const existingGrant = existingByScope.get(scope);
        const grantId =
          existingGrant?.id ??
          access.find((grant) => grant.operationScope === scope)?.grantId ??
          grantIdFor(operation, scope);
        if (existingGrant?.status === "revoked") {
          // A revoked all-chats or selected-chats grant may contain historical
          // chat rows. Reusing its primary key is safe only after removing
          // those rows; the new group receives a selected-chat row below.
          statements.push(
            db
              .prepare(
                "DELETE FROM account_grant_chats WHERE tenant_id = ? AND grant_id = ?",
              )
              .bind(operation.tenant_id, grantId),
          );
        }
        statements.push(
          db
            .prepare(
              `INSERT INTO account_grants (
                 id, tenant_id, membership_id, identity_id, account_id,
                 operation_scope, chat_scope, status, created_at, updated_at,
                 revoked_at
               ) VALUES (?, ?, ?, ?, ?, ?, 'selected_chats', 'active', ?, ?, NULL)
               ON CONFLICT(tenant_id, membership_id, identity_id, account_id, operation_scope)
               DO UPDATE SET status = 'active',
                             chat_scope = CASE
                               WHEN account_grants.status = 'revoked' THEN 'selected_chats'
                               WHEN account_grants.chat_scope = 'all_chats' THEN 'all_chats'
                               ELSE 'selected_chats'
                             END,
                             updated_at = excluded.updated_at, revoked_at = NULL`,
            )
            .bind(
              grantId,
              operation.tenant_id,
              membershipId,
              operation.identity_id,
              operation.account_id,
              scope,
              completion.now,
              completion.now,
            ),
        );
        statements.push(
          db
            .prepare(
              `INSERT INTO account_grant_chats
                 (grant_id, tenant_id, account_id, chat_id, created_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(grant_id, chat_id) DO NOTHING`,
            )
            .bind(
              grantId,
              operation.tenant_id,
              operation.account_id,
              operation.conversation_id,
              completion.now,
            ),
        );
        statements.push(
          db
            .prepare(
              `INSERT INTO group_creation_access_grants
                 (id, tenant_id, operation_id, membership_id, identity_id,
                  account_id, conversation_id, operation_scope, grant_id,
                  source, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'group_creation', ?)
               ON CONFLICT(tenant_id, operation_id, operation_scope)
               DO UPDATE SET grant_id = excluded.grant_id`,
            )
            .bind(
              `group_access_${operation.operation_id}_${scope === "conversation.read" ? "read" : "send"}`,
              operation.tenant_id,
              operation.operation_id,
              membershipId,
              operation.identity_id,
              operation.account_id,
              operation.conversation_id,
              scope,
              grantId,
              completion.now,
            ),
        );
      }
      for (const evaluation of completion.webhookEvaluations ?? []) {
        statements.push(
          db
            .prepare(
              `INSERT INTO group_creation_webhook_evaluations
                 (id, tenant_id, operation_id, subscription_id, account_id,
                  conversation_id, enabled, source, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(tenant_id, operation_id, subscription_id)
               DO UPDATE SET enabled = excluded.enabled, source = excluded.source`,
            )
            .bind(
              `group_webhook_${operation.operation_id}_${evaluation.subscription_id}`.slice(
                0,
                128,
              ),
              operation.tenant_id,
              operation.operation_id,
              evaluation.subscription_id,
              operation.account_id,
              operation.conversation_id,
              evaluation.enabled ? 1 : 0,
              evaluation.source,
              completion.now,
            ),
        );
      }
    }
    await db.batch(statements);
    const finished = await readOperationWithChildren(
      db.withSession("first-primary"),
      operation.tenant_id,
      operation.operation_id,
    );
    if (finished === null) throw new GroupRepositoryError("group_not_found");
    return finished;
  } catch (error) {
    if (error instanceof GroupRepositoryError) throw error;
    throw new GroupRepositoryError("group_conflict", error);
  }
}

/** Evaluate all active subscriptions independently before a group is exposed. */
export async function evaluateGroupWebhookSubscriptions(
  db: D1DatabaseSession,
  tenantId: string,
  accountId: string,
  conversationId: string,
): Promise<WebhookSubscriptionEvaluation[]> {
  try {
    const rows = await db
      .prepare(
        "SELECT id FROM webhook_subscriptions WHERE tenant_id = ? AND status = 'active' ORDER BY id ASC LIMIT 10000",
      )
      .bind(tenantId)
      .all<{ id: string }>();
    const values = await Promise.all(
      rows.results.map((row) =>
        evaluateWebhookSubscription(
          db,
          tenantId,
          row.id,
          accountId,
          conversationId,
        ),
      ),
    );
    return values.map((value) =>
      WebhookSubscriptionEvaluationSchema.parse(value),
    );
  } catch (error) {
    if (error instanceof GroupRepositoryError) throw error;
    throw new GroupRepositoryError("group_unavailable", error);
  }
}

export async function groupParticipantStatus(
  db: D1DatabaseSession,
  tenantId: string,
  accountId: string,
  contactId: string,
): Promise<"active" | "stale" | null> {
  try {
    const row = await db
      .prepare(
        "SELECT status FROM contact_resolution_candidates WHERE tenant_id = ? AND account_id = ? AND contact_id = ? LIMIT 1",
      )
      .bind(tenantId, accountId, contactId)
      .first<{ status: "active" | "stale" }>();
    return row?.status ?? null;
  } catch (error) {
    throw new GroupRepositoryError("group_unavailable", error);
  }
}
