import {
  ReadReceiptOperationSchema,
  ReceiptEvidenceSchema,
  type ReadReceiptOperation,
  type ReceiptEvidence,
  type ReceiptFailureCode,
  type ReceiptOperationStatus,
} from "@communicator/contracts";
import { z } from "zod";

export type ReceiptRepositoryErrorCode =
  | "receipt_invalid"
  | "receipt_not_found"
  | "receipt_conflict"
  | "receipt_unavailable";

const messages: Record<ReceiptRepositoryErrorCode, string> = {
  receipt_invalid: "Invalid receipt operation",
  receipt_not_found: "Receipt operation not found",
  receipt_conflict: "Receipt operation conflict",
  receipt_unavailable: "Receipt directory unavailable",
};

export class ReceiptRepositoryError extends Error {
  constructor(
    readonly code: ReceiptRepositoryErrorCode,
    cause?: unknown,
  ) {
    super(messages[code]);
    this.name = "ReceiptRepositoryError";
    if (cause !== undefined)
      Object.defineProperty(this, "cause", { value: cause });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type ReceiptOperationRow = {
  operation_id: string;
  tenant_id: string;
  membership_id: string;
  identity_id: string;
  account_id: string;
  connection_id: string;
  session_generation: string;
  conversation_id: string;
  message_id: string;
  matrix_room_id: string | null;
  matrix_event_id: string | null;
  request_hash: string;
  idempotency_key: string;
  status: string;
  matrix_stage: string;
  bridge_stage: string;
  provider_stage: string;
  failure_code: string | null;
  failure_reason: string | null;
  evidence_json: string;
  requested_at: string;
  updated_at: string;
};

export type ReceiptOperationIdentity = Pick<
  ReceiptOperationRow,
  | "tenant_id"
  | "membership_id"
  | "identity_id"
  | "account_id"
  | "connection_id"
  | "session_generation"
  | "conversation_id"
  | "message_id"
  | "matrix_room_id"
  | "matrix_event_id"
  | "request_hash"
  | "idempotency_key"
>;

export type ReceiptOperationUpdate = {
  status: ReceiptOperationStatus | "dispatching";
  matrixStage: "unknown" | "accepted";
  bridgeStage: "unknown" | "observed";
  providerStage: "unknown" | "confirmed";
  failureCode?: ReceiptFailureCode | null;
  failureReason?: string | null;
  evidence?: ReceiptEvidence[];
  updatedAt: string;
};

const parseEvidence = (value: string): ReceiptEvidence[] => {
  try {
    const parsed: unknown = JSON.parse(value);
    const result = z.array(ReceiptEvidenceSchema).max(6).safeParse(parsed);
    if (!result.success) throw result.error;
    return result.data;
  } catch (error) {
    throw new ReceiptRepositoryError("receipt_invalid", error);
  }
};

const mapOperation = (row: ReceiptOperationRow): ReadReceiptOperation => {
  const publicStatus = row.status === "dispatching" ? "requested" : row.status;
  return ReadReceiptOperationSchema.parse({
    schema_version: 1,
    operation_id: row.operation_id,
    tenant_id: row.tenant_id,
    identity_id: row.identity_id,
    account_id: row.account_id,
    connection_id: row.connection_id,
    conversation_id: row.conversation_id,
    message_id: row.message_id,
    matrix_room_id: row.matrix_room_id,
    matrix_event_id: row.matrix_event_id,
    status: publicStatus,
    matrix_stage: row.matrix_stage,
    bridge_stage: row.bridge_stage,
    provider_stage: row.provider_stage,
    failure_code: row.failure_code,
    failure_reason: row.failure_reason,
    idempotency_key: row.idempotency_key,
    requested_at: row.requested_at,
    updated_at: row.updated_at,
    evidence: parseEvidence(row.evidence_json),
  });
};

const operationColumns =
  "operation_id, tenant_id, membership_id, identity_id, account_id, connection_id, session_generation, conversation_id, message_id, matrix_room_id, matrix_event_id, request_hash, idempotency_key, status, matrix_stage, bridge_stage, provider_stage, failure_code, failure_reason, evidence_json, requested_at, updated_at";

const readRow = async (
  db: D1DatabaseSession,
  tenantId: string,
  operationId: string,
): Promise<ReceiptOperationRow | null> =>
  db
    .prepare(
      `SELECT ${operationColumns} FROM receipt_operations WHERE tenant_id = ? AND operation_id = ? LIMIT 1`,
    )
    .bind(tenantId, operationId)
    .first<ReceiptOperationRow>();

const ensureDatabase = (db: D1DatabaseSession): D1DatabaseSession => {
  if (db === undefined || typeof db.prepare !== "function")
    throw new ReceiptRepositoryError("receipt_unavailable");
  return db;
};

export async function createOrReadReceiptOperation(
  database: D1DatabaseSession,
  input: ReceiptOperationIdentity & {
    operationId: string;
    requestedAt: string;
  },
): Promise<{ operation: ReadReceiptOperation; inserted: boolean }> {
  const db = ensureDatabase(database);
  try {
    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO receipt_operations (
          operation_id, tenant_id, membership_id, identity_id, account_id,
          connection_id, session_generation, conversation_id, message_id, matrix_room_id,
          matrix_event_id, request_hash, idempotency_key, status, matrix_stage,
          bridge_stage, provider_stage, failure_code, failure_reason,
          evidence_json, requested_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', 'unknown',
          'unknown', 'unknown', NULL, NULL, '[]', ?, ?)`,
      )
      .bind(
        input.operationId,
        input.tenant_id,
        input.membership_id,
        input.identity_id,
        input.account_id,
        input.connection_id,
        input.session_generation,
        input.conversation_id,
        input.message_id,
        input.matrix_room_id,
        input.matrix_event_id,
        input.request_hash,
        input.idempotency_key,
        input.requestedAt,
        input.requestedAt,
      )
      .run();
    const row = await readRow(db, input.tenant_id, input.operationId);
    if (row === null) throw new ReceiptRepositoryError("receipt_unavailable");
    if (
      row.request_hash !== input.request_hash ||
      row.identity_id !== input.identity_id ||
      row.account_id !== input.account_id ||
      row.conversation_id !== input.conversation_id ||
      row.message_id !== input.message_id
    ) {
      throw new ReceiptRepositoryError("receipt_conflict");
    }
    return { operation: mapOperation(row), inserted: result.meta.changes > 0 };
  } catch (error) {
    if (error instanceof ReceiptRepositoryError) throw error;
    throw new ReceiptRepositoryError("receipt_unavailable", error);
  }
}

export async function claimReceiptOperation(
  database: D1DatabaseSession,
  tenantId: string,
  operationId: string,
  now: string,
): Promise<boolean> {
  const db = ensureDatabase(database);
  try {
    const result = await db
      .prepare(
        "UPDATE receipt_operations SET status = 'dispatching', updated_at = ? WHERE tenant_id = ? AND operation_id = ? AND status = 'requested'",
      )
      .bind(now, tenantId, operationId)
      .run();
    return result.meta.changes === 1;
  } catch (error) {
    throw new ReceiptRepositoryError("receipt_unavailable", error);
  }
}

export async function updateReceiptOperation(
  database: D1DatabaseSession,
  tenantId: string,
  operationId: string,
  update: ReceiptOperationUpdate,
): Promise<ReadReceiptOperation> {
  const db = ensureDatabase(database);
  try {
    const evidence = update.evidence ?? [];
    const result = await db
      .prepare(
        `UPDATE receipt_operations
            SET status = ?, matrix_stage = ?, bridge_stage = ?, provider_stage = ?,
                failure_code = ?, failure_reason = ?, evidence_json = ?, updated_at = ?
          WHERE tenant_id = ? AND operation_id = ? AND status IN ('requested', 'dispatching')`,
      )
      .bind(
        update.status,
        update.matrixStage,
        update.bridgeStage,
        update.providerStage,
        update.failureCode ?? null,
        update.failureReason ?? null,
        JSON.stringify(evidence),
        update.updatedAt,
        tenantId,
        operationId,
      )
      .run();
    if (result.meta.changes !== 1) {
      const existing = await readRow(db, tenantId, operationId);
      if (existing === null)
        throw new ReceiptRepositoryError("receipt_not_found");
      return mapOperation(existing);
    }
    const row = await readRow(db, tenantId, operationId);
    if (row === null) throw new ReceiptRepositoryError("receipt_unavailable");
    return mapOperation(row);
  } catch (error) {
    if (error instanceof ReceiptRepositoryError) throw error;
    throw new ReceiptRepositoryError("receipt_unavailable", error);
  }
}

export async function getReceiptOperation(
  database: D1DatabaseSession,
  tenantId: string,
  operationId: string,
): Promise<ReadReceiptOperation | null> {
  try {
    const row = await readRow(ensureDatabase(database), tenantId, operationId);
    return row === null ? null : mapOperation(row);
  } catch (error) {
    if (error instanceof ReceiptRepositoryError) throw error;
    throw new ReceiptRepositoryError("receipt_unavailable", error);
  }
}

export async function listReceiptOperations(
  database: D1DatabaseSession,
  tenantId: string,
  input: { limit?: number; cursor?: string; accountId?: string },
): Promise<{ items: ReadReceiptOperation[]; next_cursor: string | null }> {
  const db = ensureDatabase(database);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const bindings: (string | number)[] = [tenantId];
  const conditions = ["tenant_id = ?"];
  if (input.accountId !== undefined) {
    conditions.push("account_id = ?");
    bindings.push(input.accountId);
  }
  if (input.cursor !== undefined) {
    const separator = input.cursor.indexOf("|");
    if (separator <= 0 || separator === input.cursor.length - 1)
      throw new ReceiptRepositoryError("receipt_invalid");
    const created = input.cursor.slice(0, separator);
    const operationId = input.cursor.slice(separator + 1);
    conditions.push(
      "(updated_at < ? OR (updated_at = ? AND operation_id < ?))",
    );
    bindings.push(created, created, operationId);
  }
  bindings.push(limit + 1);
  try {
    const result = await db
      .prepare(
        `SELECT ${operationColumns} FROM receipt_operations WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC, operation_id DESC LIMIT ?`,
      )
      .bind(...bindings)
      .all<ReceiptOperationRow>();
    const rows = result.results;
    const visible = rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(mapOperation),
      next_cursor:
        rows.length > limit && last !== undefined
          ? `${last.updated_at}|${last.operation_id}`
          : null,
    };
  } catch (error) {
    if (error instanceof ReceiptRepositoryError) throw error;
    throw new ReceiptRepositoryError("receipt_unavailable", error);
  }
}
