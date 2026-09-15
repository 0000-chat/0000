import {
  ContactCandidateSchema,
  ContactProviderEvidenceSchema,
  DirectChatSchema,
  ProviderSchema,
  type ContactCandidate,
  type ContactProviderEvidence,
  type DirectChat,
  type Provider,
} from "@communicator/contracts";
import { z } from "zod";

export type ContactRepositoryErrorCode =
  | "contact_invalid"
  | "contact_not_found"
  | "contact_conflict"
  | "contact_unavailable";

const messages: Record<ContactRepositoryErrorCode, string> = {
  contact_invalid: "Invalid contact data",
  contact_not_found: "Contact not found",
  contact_conflict: "Contact operation conflict",
  contact_unavailable: "Contact directory unavailable",
};

export class ContactRepositoryError extends Error {
  constructor(
    readonly code: ContactRepositoryErrorCode,
    cause?: unknown,
  ) {
    super(messages[code]);
    this.name = "ContactRepositoryError";
    if (cause !== undefined)
      Object.defineProperty(this, "cause", { value: cause });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type ContactRouteRow = {
  tenant_id: string;
  identity_id: string;
  account_id: string;
  connection_id: string;
  provider: Provider;
  connection_status: string;
  session_generation: string;
  gateway_route_id: string;
  bridge_instance_id: string;
  matrix_user_id: string;
  matrix_room_namespace: string;
  has_contact_capability: number;
  has_provider_identity: number;
  provider_login_id: string | null;
};

export type CandidateInput = {
  candidate: ContactCandidate;
  stableKey: string;
  status?: "active" | "stale";
  now: string;
};

type CandidateRow = {
  contact_id: string;
  tenant_id: string;
  identity_id: string;
  account_id: string;
  connection_id: string;
  provider: string;
  provider_id: string;
  current_lid: string | null;
  display_name: string;
  identifiers_json: string;
  match_reason: string;
  candidate_revision: string;
  observed_at: string;
  evidence_json: string;
  status: string;
};

type OperationRow = {
  operation_id: string;
  tenant_id: string;
  membership_id: string;
  identity_id: string;
  account_id: string;
  connection_id: string;
  provider: string;
  contact_id: string;
  candidate_revision: string;
  conversation_id: string;
  idempotency_key: string;
  request_hash: string;
  session_generation: string;
  status: string;
  provider_id: string;
  current_lid: string | null;
  matrix_room_id: string | null;
  evidence_json: string | null;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
};

const parseJson = <T>(value: string, schema: z.ZodType<T>): T => {
  try {
    return schema.parse(JSON.parse(value));
  } catch (error) {
    throw new ContactRepositoryError("contact_invalid", error);
  }
};

const candidateArray = z.array(z.string().trim().min(1).max(512)).max(32);

const mapCandidate = (row: CandidateRow): ContactCandidate =>
  ContactCandidateSchema.parse({
    contact_id: row.contact_id,
    tenant_id: row.tenant_id,
    identity_id: row.identity_id,
    account_id: row.account_id,
    connection_id: row.connection_id,
    provider: row.provider,
    provider_id: row.provider_id,
    current_lid: row.current_lid,
    display_name: row.display_name,
    identifiers: parseJson(row.identifiers_json, candidateArray),
    match_reason: row.match_reason,
    candidate_revision: row.candidate_revision,
    observed_at: row.observed_at,
    evidence: parseJson(row.evidence_json, ContactProviderEvidenceSchema),
  });

export async function readContactRoute(
  db: D1DatabaseSession,
  tenantId: string,
  identityId: string,
  accountId: string,
): Promise<ContactRouteRow | null> {
  try {
    return await db
      .prepare(
        `SELECT c.tenant_id, c.identity_id, ca.account_id, c.id AS connection_id,
                c.provider, c.status AS connection_status,
                c.updated_at AS session_generation,
                cr.gateway_route_id, cr.bridge_instance_id, cr.matrix_user_id,
                cr.matrix_room_namespace,
                pi.provider_login_id,
                EXISTS (
                  SELECT 1 FROM connection_capabilities AS cc
                   WHERE cc.tenant_id = c.tenant_id
                     AND cc.connection_id = c.id
                     AND cc.capability = 'contact.lookup'
                ) OR EXISTS (
                  SELECT 1 FROM provider_capability_records AS pcr
                   WHERE pcr.tenant_id = c.tenant_id
                     AND pcr.account_id = ca.account_id
                     AND pcr.capability = 'contact.lookup'
                     AND pcr.status IN ('supported', 'conditional')
                ) AS has_contact_capability,
                CASE WHEN pi.connection_id IS NULL THEN 0 ELSE 1 END AS has_provider_identity
           FROM connections AS c
           JOIN connection_accounts AS ca
             ON ca.connection_id = c.id AND ca.status = 'active'
           JOIN connection_routes AS cr ON cr.connection_id = c.id
           LEFT JOIN connection_provider_identities AS pi
             ON pi.tenant_id = c.tenant_id
            AND pi.connection_id = c.id
            AND pi.provider = c.provider
          WHERE c.tenant_id = ?
            AND c.identity_id = ?
            AND ca.account_id = ?
          LIMIT 1`,
      )
      .bind(tenantId, identityId, accountId)
      .first<ContactRouteRow>();
  } catch (error) {
    throw new ContactRepositoryError("contact_unavailable", error);
  }
}

export async function upsertContactCandidate(
  db: D1Database,
  input: CandidateInput,
): Promise<ContactCandidate> {
  const candidate = ContactCandidateSchema.parse(input.candidate);
  const status = input.status ?? "active";
  try {
    await db
      .prepare(
        `INSERT INTO contact_resolution_candidates (
           contact_id, tenant_id, identity_id, account_id, connection_id,
           provider, provider_id, current_lid, display_name, identifiers_json,
           stable_key, match_reason, candidate_revision, observed_at, evidence_json, status,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(contact_id) DO UPDATE SET
           identity_id = excluded.identity_id,
           account_id = excluded.account_id,
           connection_id = excluded.connection_id,
           provider = excluded.provider,
           provider_id = excluded.provider_id,
           current_lid = excluded.current_lid,
           display_name = excluded.display_name,
           identifiers_json = excluded.identifiers_json,
           stable_key = excluded.stable_key,
           match_reason = excluded.match_reason,
           candidate_revision = excluded.candidate_revision,
           observed_at = excluded.observed_at,
           evidence_json = excluded.evidence_json,
           status = excluded.status,
           updated_at = excluded.updated_at`,
      )
      .bind(
        candidate.contact_id,
        candidate.tenant_id,
        candidate.identity_id,
        candidate.account_id,
        candidate.connection_id,
        candidate.provider,
        candidate.provider_id,
        candidate.current_lid,
        candidate.display_name,
        JSON.stringify(candidate.identifiers),
        input.stableKey,
        candidate.match_reason,
        candidate.candidate_revision,
        candidate.observed_at,
        JSON.stringify(candidate.evidence),
        status,
        input.now,
        input.now,
      )
      .run();
    return candidate;
  } catch (error) {
    if (error instanceof ContactRepositoryError) throw error;
    throw new ContactRepositoryError("contact_conflict", error);
  }
}

export async function getContactCandidate(
  db: D1DatabaseSession,
  tenantId: string,
  accountId: string,
  contactId: string,
): Promise<ContactCandidate | null> {
  try {
    const row = await db
      .prepare(
        `SELECT contact_id, tenant_id, identity_id, account_id, connection_id,
                provider, provider_id, current_lid, display_name,
                identifiers_json, match_reason, candidate_revision, observed_at,
                evidence_json, status
           FROM contact_resolution_candidates
          WHERE tenant_id = ? AND account_id = ? AND contact_id = ?
          LIMIT 1`,
      )
      .bind(tenantId, accountId, contactId)
      .first<CandidateRow>();
    return row === null ? null : mapCandidate(row);
  } catch (error) {
    if (error instanceof ContactRepositoryError) throw error;
    throw new ContactRepositoryError("contact_unavailable", error);
  }
}

export type DirectChatOperationInput = {
  operationId: string;
  tenantId: string;
  membershipId: string;
  identityId: string;
  accountId: string;
  connectionId: string;
  provider: Provider;
  contactId: string;
  candidateRevision: string;
  conversationId: string;
  idempotencyKey: string;
  requestHash: string;
  sessionGeneration: string;
  providerId: string;
  currentLid: string | null;
  now: string;
};

export type DirectChatOperation = Omit<DirectChatOperationInput, "now"> & {
  status: "pending" | "created" | "already_exists" | "uncertain" | "failed";
  matrixRoomId: string | null;
  evidence: ContactProviderEvidence | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BeginDirectChatOperationResult = {
  operation: DirectChatOperation;
  dispatchOwner: boolean;
};

const mapOperation = (row: OperationRow): DirectChatOperation => {
  const provider = ProviderSchema.parse(row.provider);
  const status = z
    .enum(["pending", "created", "already_exists", "uncertain", "failed"])
    .parse(row.status);
  return {
    operationId: row.operation_id,
    tenantId: row.tenant_id,
    membershipId: row.membership_id,
    identityId: row.identity_id,
    accountId: row.account_id,
    connectionId: row.connection_id,
    provider,
    contactId: row.contact_id,
    candidateRevision: row.candidate_revision,
    conversationId: row.conversation_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    sessionGeneration: row.session_generation,
    status,
    providerId: row.provider_id,
    currentLid: row.current_lid,
    matrixRoomId: row.matrix_room_id,
    evidence:
      row.evidence_json === null
        ? null
        : parseJson(row.evidence_json, ContactProviderEvidenceSchema),
    failureCode: row.failure_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

export async function readDirectChatOperation(
  db: D1DatabaseSession,
  tenantId: string,
  idempotencyKey: string,
): Promise<DirectChatOperation | null> {
  try {
    const row = await db
      .prepare(
        `SELECT operation_id, tenant_id, membership_id, identity_id, account_id, connection_id,
                provider, contact_id, candidate_revision, conversation_id,
                idempotency_key, request_hash, session_generation, status, provider_id, current_lid,
                matrix_room_id, evidence_json, failure_code, created_at, updated_at
           FROM direct_chat_creation_operations
          WHERE tenant_id = ? AND idempotency_key = ?
          LIMIT 1`,
      )
      .bind(tenantId, idempotencyKey)
      .first<OperationRow>();
    return row === null ? null : mapOperation(row);
  } catch (error) {
    if (error instanceof ContactRepositoryError) throw error;
    throw new ContactRepositoryError("contact_unavailable", error);
  }
}

export async function readCreatedChatForContact(
  db: D1DatabaseSession,
  tenantId: string,
  accountId: string,
  contactId: string,
): Promise<DirectChatOperation | null> {
  try {
    const row = await db
      .prepare(
        `SELECT operation_id, tenant_id, membership_id, identity_id, account_id, connection_id,
                provider, contact_id, candidate_revision, conversation_id,
                idempotency_key, request_hash, session_generation, status, provider_id, current_lid,
                matrix_room_id, evidence_json, failure_code, created_at, updated_at
           FROM direct_chat_creation_operations
          WHERE tenant_id = ? AND account_id = ? AND contact_id = ?
            AND status IN ('created', 'already_exists')
          ORDER BY updated_at DESC, operation_id DESC
          LIMIT 1`,
      )
      .bind(tenantId, accountId, contactId)
      .first<OperationRow>();
    return row === null ? null : mapOperation(row);
  } catch (error) {
    if (error instanceof ContactRepositoryError) throw error;
    throw new ContactRepositoryError("contact_unavailable", error);
  }
}

export async function beginDirectChatOperation(
  db: D1Database,
  input: DirectChatOperationInput,
): Promise<BeginDirectChatOperationResult> {
  const existing = await readDirectChatOperation(
    db.withSession("first-primary"),
    input.tenantId,
    input.idempotencyKey,
  );
  if (existing !== null) {
    if (existing.requestHash !== input.requestHash)
      throw new ContactRepositoryError("contact_conflict");
    return { operation: existing, dispatchOwner: false };
  }
  try {
    await db
      .prepare(
        `INSERT INTO direct_chat_creation_operations (
           operation_id, tenant_id, membership_id, identity_id, account_id, connection_id,
           provider, contact_id, candidate_revision, conversation_id,
           idempotency_key, request_hash, session_generation, status, provider_id, current_lid,
           matrix_room_id, evidence_json, failure_code, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, ?, ?)`,
      )
      .bind(
        input.operationId,
        input.tenantId,
        input.membershipId,
        input.identityId,
        input.accountId,
        input.connectionId,
        input.provider,
        input.contactId,
        input.candidateRevision,
        input.conversationId,
        input.idempotencyKey,
        input.requestHash,
        input.sessionGeneration,
        input.providerId,
        input.currentLid,
        input.now,
        input.now,
      )
      .run();
  } catch (error) {
    // A concurrent request may have inserted the idempotency key after the
    // initial read. Re-read the primary and let only the insert winner own
    // provider dispatch.
    const raced = await readDirectChatOperation(
      db.withSession("first-primary"),
      input.tenantId,
      input.idempotencyKey,
    );
    if (raced !== null) {
      if (raced.requestHash !== input.requestHash)
        throw new ContactRepositoryError("contact_conflict");
      return { operation: raced, dispatchOwner: false };
    }
    if (error instanceof ContactRepositoryError) throw error;
    throw new ContactRepositoryError("contact_conflict", error);
  }
  const created = await readDirectChatOperation(
    db.withSession("first-primary"),
    input.tenantId,
    input.idempotencyKey,
  );
  if (created === null) throw new ContactRepositoryError("contact_unavailable");
  return { operation: created, dispatchOwner: true };
}

export async function finishDirectChatOperation(
  db: D1Database,
  operation: DirectChatOperation,
  result:
    | {
        status: "created" | "already_exists";
        providerId: string;
        currentLid: string | null;
        matrixRoomId: string;
        evidence: ContactProviderEvidence;
      }
    | { status: "uncertain" | "failed"; failureCode: string },
  now: string,
): Promise<DirectChatOperation> {
  try {
    if (result.status === "created" || result.status === "already_exists") {
      await db
        .prepare(
          `UPDATE direct_chat_creation_operations
              SET status = ?, provider_id = ?, current_lid = ?, matrix_room_id = ?,
                  evidence_json = ?, failure_code = NULL, updated_at = ?
            WHERE tenant_id = ? AND operation_id = ? AND status = 'pending'`,
        )
        .bind(
          result.status,
          result.providerId,
          result.currentLid,
          result.matrixRoomId,
          JSON.stringify(result.evidence),
          now,
          operation.tenantId,
          operation.operationId,
        )
        .run();
    } else if ("failureCode" in result) {
      await db
        .prepare(
          `UPDATE direct_chat_creation_operations
              SET status = ?, failure_code = ?, updated_at = ?
            WHERE tenant_id = ? AND operation_id = ? AND status = 'pending'`,
        )
        .bind(
          result.status,
          result.failureCode,
          now,
          operation.tenantId,
          operation.operationId,
        )
        .run();
    }
    const updated = await db
      .withSession("first-primary")
      .prepare(
        `SELECT operation_id, tenant_id, membership_id, identity_id, account_id, connection_id,
                provider, contact_id, candidate_revision, conversation_id,
                idempotency_key, request_hash, session_generation, status, provider_id, current_lid,
                matrix_room_id, evidence_json, failure_code, created_at, updated_at
           FROM direct_chat_creation_operations
          WHERE tenant_id = ? AND operation_id = ?
          LIMIT 1`,
      )
      .bind(operation.tenantId, operation.operationId)
      .first<OperationRow>();
    if (updated === null) throw new ContactRepositoryError("contact_not_found");
    return mapOperation(updated);
  } catch (error) {
    if (error instanceof ContactRepositoryError) throw error;
    throw new ContactRepositoryError("contact_conflict", error);
  }
}

export const directChatResult = (operation: DirectChatOperation): DirectChat =>
  DirectChatSchema.parse({
    conversation_id: operation.conversationId,
    tenant_id: operation.tenantId,
    identity_id: operation.identityId,
    account_id: operation.accountId,
    connection_id: operation.connectionId,
    provider: operation.provider,
    contact_id: operation.contactId,
    provider_id: operation.providerId,
    current_lid: operation.currentLid,
    matrix_room_id: operation.matrixRoomId,
    status:
      operation.status === "already_exists" ? "already_exists" : "created",
    evidence: operation.evidence,
    created_at: operation.updatedAt,
  });
