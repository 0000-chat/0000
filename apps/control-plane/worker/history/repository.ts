import {
  HistoryCoverageSchema,
  HistoryImportDetailSchema,
  HistoryImportPageSchema,
  HistoryImportRangeSchema,
  HistoryImportSchema,
  ProviderCapabilitySchema,
  ProviderSchema,
  type HistoryCoverage,
  type HistoryImport,
  type HistoryImportDetail,
  type HistoryImportFailureCode,
  type HistoryImportPage,
  type HistoryImportRange,
  type Provider,
  type ProviderCapability,
} from "@communicator/contracts";

type HistoryDatabase = D1Database | D1DatabaseSession;

export type HistoryAccountBinding = {
  account_id: string;
  tenant_id: string;
  connection_id: string;
  identity_id: string;
  provider: Provider;
  status: "active" | "retired";
  connection_status: string;
};

export type HistoryProjectionBinding = HistoryAccountBinding & {
  gateway_route_id: string;
  service_principal_id: string;
};

type HistoryImportRow = {
  import_id: string;
  tenant_id: string;
  account_id: string;
  connection_id: string;
  identity_id: string;
  provider: string;
  status: string;
  availability: string;
  requested_start_at: string;
  requested_end_at: string;
  source_start_at: string | null;
  source_end_at: string | null;
  max_events: number;
  event_count: number;
  completed_range_count: number;
  total_range_count: number;
  gap_count: number;
  attempt_count: number;
  max_attempts: number;
  last_error_code: string | null;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
};

type HistoryRangeRow = {
  range_id: string;
  import_id: string;
  account_id: string;
  start_at: string;
  end_at: string;
  status: string;
  attempt_count: number;
  event_count: number;
  source_cursor: string | null;
  gap_code: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type HistoryRangeWorkRow = HistoryRangeRow & {
  tenant_id: string;
  identity_id: string;
  next_attempt_at: string | null;
  lease_token: string | null;
  lease_until: string | null;
  operation_key: string | null;
};

type CapabilityRow = {
  tenant_id: string;
  account_id: string;
  connection_id: string;
  identity_id: string;
  provider: string;
  capability: string;
  status: string;
  freshness: string;
  provider_version: string | null;
  proof_source: string;
  provider_evidence_json: string;
  product_claim: string;
  observed_at: string | null;
  updated_at: string;
};

type EventHashRow = { source_event_id: string; event_hash: string };

// Keep each D1 statement below the lowest documented SQLite bind-parameter
// limit while retaining the provider's supported 500-event page size.
const EVENT_HASH_LOOKUP_CHUNK_SIZE = 90;
const EVENT_HASH_INSERT_CHUNK_SIZE = 100;

export type HistoryImportCreateInput = {
  import_id: string;
  range_id: string;
  tenant_id: string;
  account_id: string;
  connection_id: string;
  identity_id: string;
  provider: Provider;
  idempotency_key: string;
  requested_start_at: string;
  requested_end_at: string;
  max_events: number;
  started_at: string;
};

export type HistoryImportRangeCreateInput = {
  range_id: string;
  import_id: string;
  account_id: string;
  start_at: string;
  end_at: string;
  source_cursor: string | null;
  created_at: string;
};

export type HistoryImportUpdate = {
  import_id: string;
  status: HistoryImport["status"];
  availability: HistoryImport["availability"];
  source_start_at?: string | null;
  source_end_at?: string | null;
  event_count?: number;
  completed_range_count?: number;
  total_range_count?: number;
  gap_count?: number;
  attempt_count?: number;
  last_error_code?: HistoryImportFailureCode | null;
  updated_at: string;
  completed_at?: string | null;
  lease_token?: string;
  range_id?: string;
};

export type HistoryRangeUpdate = {
  range_id: string;
  status: HistoryImportRange["status"];
  source_cursor?: string | null;
  gap_code?: string | null;
  error_code?: HistoryImportFailureCode | null;
  attempt_count?: number;
  event_count?: number;
  updated_at: string;
  completed_at?: string | null;
  lease_token?: string;
};

export type HistoryRangeWorkClaim = {
  tenant_id: string;
  import_id: string;
  range_id: string;
  account_id: string;
  identity_id: string;
  source_cursor: string | null;
  operation_key: string;
  lease_token: string;
  lease_until: string;
};

export type HistoryRangeWorkSchedule = {
  tenant_id: string;
  import_id: string;
  range_id: string;
  account_id: string;
  source_cursor: string | null;
  next_attempt_at: string;
  updated_at: string;
  lease_token?: string;
};

export type HistoryRepositoryErrorCode =
  | "history_not_found"
  | "history_invalid"
  | "history_conflict"
  | "history_unavailable";

const SAFE_MESSAGES: Record<HistoryRepositoryErrorCode, string> = {
  history_not_found: "History import not found",
  history_invalid: "Invalid history import data",
  history_conflict: "History import conflict",
  history_unavailable: "History import storage unavailable",
};

const causes = new WeakMap<HistoryRepositoryError, unknown>();

export class HistoryRepositoryError extends Error {
  readonly code: HistoryRepositoryErrorCode;

  constructor(code: HistoryRepositoryErrorCode, cause?: unknown) {
    super(SAFE_MESSAGES[code]);
    this.name = "HistoryRepositoryError";
    this.code = code;
    if (cause !== undefined) causes.set(this, cause);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const getHistoryRepositoryCause = (
  error: HistoryRepositoryError,
): unknown => causes.get(error);

const historyError = (
  code: HistoryRepositoryErrorCode,
  cause?: unknown,
): HistoryRepositoryError => new HistoryRepositoryError(code, cause);

const primarySession = (db: HistoryDatabase): D1DatabaseSession => {
  if ("withSession" in db && typeof db.withSession === "function") {
    return db.withSession("first-primary");
  }
  return db as D1DatabaseSession;
};

const mapImport = (row: HistoryImportRow): HistoryImport => {
  try {
    return HistoryImportSchema.parse(row);
  } catch (error) {
    throw historyError("history_invalid", error);
  }
};

const mapRange = (row: HistoryRangeRow): HistoryImportRange => {
  try {
    return HistoryImportRangeSchema.parse(row);
  } catch (error) {
    throw historyError("history_invalid", error);
  }
};

const parseProviderEvidence = (json: string): unknown => {
  try {
    return JSON.parse(json) as unknown;
  } catch (error) {
    throw historyError("history_invalid", error);
  }
};

const mapCapability = (row: CapabilityRow): ProviderCapability => {
  try {
    return ProviderCapabilitySchema.parse({
      tenant_id: row.tenant_id,
      account_id: row.account_id,
      connection_id: row.connection_id,
      identity_id: row.identity_id,
      provider: row.provider,
      capability: row.capability,
      status: row.status,
      freshness: row.freshness,
      provider_version: row.provider_version,
      proof_source: row.proof_source,
      provider_evidence: parseProviderEvidence(row.provider_evidence_json),
      product_claim: row.product_claim,
      observed_at: row.observed_at,
      updated_at: row.updated_at,
    });
  } catch (error) {
    if (error instanceof HistoryRepositoryError) throw error;
    throw historyError("history_invalid", error);
  }
};

export async function findHistoryAccount(
  db: HistoryDatabase,
  tenantId: string,
  accountId: string,
  identityId?: string,
): Promise<HistoryAccountBinding> {
  try {
    const row = await primarySession(db)
      .prepare(
        `SELECT ca.account_id, c.tenant_id, ca.connection_id, c.identity_id,
                c.provider, ca.status, c.status AS connection_status
           FROM connection_accounts AS ca
           JOIN connections AS c ON c.id = ca.connection_id
          WHERE ca.account_id = ? AND c.tenant_id = ?
            ${identityId === undefined ? "" : "AND c.identity_id = ?"}
          LIMIT 1`,
      )
      .bind(
        ...(identityId === undefined
          ? [accountId, tenantId]
          : [accountId, tenantId, identityId]),
      )
      .first<HistoryAccountBinding>();
    if (row === null) throw historyError("history_not_found");
    if (!ProviderSchema.safeParse(row.provider).success)
      throw historyError("history_invalid");
    return row as HistoryAccountBinding;
  } catch (error) {
    if (error instanceof HistoryRepositoryError) throw error;
    throw historyError("history_unavailable", error);
  }
}

export async function findHistoryProjectionBinding(
  db: HistoryDatabase,
  tenantId: string,
  accountId: string,
): Promise<HistoryProjectionBinding> {
  try {
    const row = await primarySession(db)
      .prepare(
        `SELECT ca.account_id, c.tenant_id, ca.connection_id, c.identity_id,
                c.provider, ca.status, c.status AS connection_status,
                cr.gateway_route_id, gr.service_principal_id
           FROM connection_accounts AS ca
           JOIN connections AS c ON c.id = ca.connection_id
           JOIN connection_routes AS cr ON cr.connection_id = c.id
           JOIN gateway_routes AS gr ON gr.id = cr.gateway_route_id
          WHERE ca.account_id = ? AND c.tenant_id = ?
          LIMIT 1`,
      )
      .bind(accountId, tenantId)
      .first<HistoryProjectionBinding>();
    if (row === null) throw historyError("history_not_found");
    if (!ProviderSchema.safeParse(row.provider).success)
      throw historyError("history_invalid");
    return row as HistoryProjectionBinding;
  } catch (error) {
    if (error instanceof HistoryRepositoryError) throw error;
    throw historyError("history_unavailable", error);
  }
}

export async function findImportByIdempotency(
  db: HistoryDatabase,
  tenantId: string,
  accountId: string,
  idempotencyKey: string,
): Promise<HistoryImport | null> {
  try {
    const row = await primarySession(db)
      .prepare(
        `SELECT import_id, tenant_id, account_id, connection_id, identity_id,
                provider, status, availability, requested_start_at,
                requested_end_at, source_start_at, source_end_at, max_events,
                event_count, completed_range_count, total_range_count,
                gap_count, attempt_count, max_attempts, last_error_code,
                started_at, updated_at, completed_at
           FROM history_imports
          WHERE tenant_id = ? AND account_id = ? AND idempotency_key = ?
          LIMIT 1`,
      )
      .bind(tenantId, accountId, idempotencyKey)
      .first<HistoryImportRow>();
    return row === null ? null : mapImport(row);
  } catch (error) {
    if (error instanceof HistoryRepositoryError) throw error;
    throw historyError("history_unavailable", error);
  }
}

export async function createImport(
  db: D1Database,
  input: HistoryImportCreateInput,
): Promise<void> {
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO history_imports
             (import_id, tenant_id, account_id, connection_id, identity_id,
              provider, status, availability, idempotency_key,
              requested_start_at, requested_end_at, max_events, started_at,
              updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'started', 'available', ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.import_id,
          input.tenant_id,
          input.account_id,
          input.connection_id,
          input.identity_id,
          input.provider,
          input.idempotency_key,
          input.requested_start_at,
          input.requested_end_at,
          input.max_events,
          input.started_at,
          input.started_at,
        ),
      db
        .prepare(
          `INSERT INTO history_import_ranges
             (range_id, import_id, account_id, start_at, end_at, status,
              source_cursor, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .bind(
          input.range_id,
          input.import_id,
          input.account_id,
          input.requested_start_at,
          input.requested_end_at,
          null,
          input.started_at,
          input.started_at,
        ),
    ]);
  } catch (error) {
    throw historyError("history_conflict", error);
  }
}

export async function insertRanges(
  db: D1Database,
  ranges: readonly HistoryImportRangeCreateInput[],
): Promise<void> {
  if (ranges.length === 0) return;
  try {
    await db.batch(
      ranges.map((range) =>
        db
          .prepare(
            `INSERT INTO history_import_ranges
               (range_id, import_id, account_id, start_at, end_at, status,
                source_cursor, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
          )
          .bind(
            range.range_id,
            range.import_id,
            range.account_id,
            range.start_at,
            range.end_at,
            range.source_cursor,
            range.created_at,
            range.created_at,
          ),
      ),
    );
  } catch (error) {
    throw historyError("history_conflict", error);
  }
}

export async function updateImport(
  db: D1Database,
  input: HistoryImportUpdate,
): Promise<void> {
  const assignments = ["status = ?", "availability = ?", "updated_at = ?"];
  const values: unknown[] = [
    input.status,
    input.availability,
    input.updated_at,
  ];
  const optional: Array<[string, unknown]> = [
    ["source_start_at = ?", input.source_start_at],
    ["source_end_at = ?", input.source_end_at],
    ["event_count = ?", input.event_count],
    ["completed_range_count = ?", input.completed_range_count],
    ["total_range_count = ?", input.total_range_count],
    ["gap_count = ?", input.gap_count],
    ["attempt_count = ?", input.attempt_count],
    ["last_error_code = ?", input.last_error_code],
    ["completed_at = ?", input.completed_at],
  ];
  for (const [assignment, value] of optional) {
    if (value !== undefined) {
      assignments.push(assignment);
      values.push(value);
    }
  }
  values.push(input.import_id);
  const leaseClause =
    input.lease_token === undefined || input.range_id === undefined
      ? ""
      : " AND EXISTS (SELECT 1 FROM history_import_ranges WHERE import_id = ? AND range_id = ? AND lease_token = ?)";
  if (input.lease_token !== undefined && input.range_id !== undefined) {
    values.push(input.import_id, input.range_id, input.lease_token);
  }
  try {
    const result = await db
      .prepare(
        `UPDATE history_imports SET ${assignments.join(", ")} WHERE import_id = ?${leaseClause}`,
      )
      .bind(...values)
      .run();
    if ((result.meta.changes ?? 0) !== 1)
      throw historyError("history_not_found");
  } catch (error) {
    if (error instanceof HistoryRepositoryError) throw error;
    throw historyError("history_unavailable", error);
  }
}

export async function updateRange(
  db: D1Database,
  input: HistoryRangeUpdate,
): Promise<void> {
  const assignments = ["status = ?", "updated_at = ?"];
  const values: unknown[] = [input.status, input.updated_at];
  const optional: Array<[string, unknown]> = [
    ["source_cursor = ?", input.source_cursor],
    ["gap_code = ?", input.gap_code],
    ["error_code = ?", input.error_code],
    ["attempt_count = ?", input.attempt_count],
    ["event_count = ?", input.event_count],
    ["completed_at = ?", input.completed_at],
  ];
  for (const [assignment, value] of optional) {
    if (value !== undefined) {
      assignments.push(assignment);
      values.push(value);
    }
  }
  values.push(input.range_id);
  const leaseClause =
    input.lease_token === undefined ? "" : " AND lease_token = ?";
  if (input.lease_token !== undefined) values.push(input.lease_token);
  try {
    const result = await db
      .prepare(
        `UPDATE history_import_ranges SET ${assignments.join(", ")} WHERE range_id = ?${leaseClause}`,
      )
      .bind(...values)
      .run();
    if ((result.meta.changes ?? 0) !== 1)
      throw historyError("history_not_found");
  } catch (error) {
    if (error instanceof HistoryRepositoryError) throw error;
    throw historyError("history_unavailable", error);
  }
}

const historyRangeOperationKey = (
  importId: string,
  rangeId: string,
  sourceCursor: string | null,
): string => `history-page:${importId}:${rangeId}:${sourceCursor ?? "initial"}`;

/** Initialize a range's durable wake and page key without disturbing a live lease. */
export async function ensureHistoryRangeWork(
  db: D1Database,
  input: {
    import_id: string;
    range_id: string;
    account_id: string;
    source_cursor: string | null;
    next_attempt_at: string;
    updated_at: string;
  },
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE history_import_ranges
            SET next_attempt_at = COALESCE(next_attempt_at, ?),
                operation_key = COALESCE(operation_key, ?),
                updated_at = ?
          WHERE import_id = ? AND range_id = ? AND account_id = ?
            AND status IN ('pending', 'active')
            AND (lease_token IS NULL OR lease_until IS NULL OR lease_until <= ?)`,
      )
      .bind(
        input.next_attempt_at,
        historyRangeOperationKey(
          input.import_id,
          input.range_id,
          input.source_cursor,
        ),
        input.updated_at,
        input.import_id,
        input.range_id,
        input.account_id,
        input.updated_at,
      )
      .run();
  } catch (error) {
    throw historyError("history_unavailable", error);
  }
}

/** Claim one page. The same claim path is used by cron and manual replay. */
export async function claimHistoryRangeWork(
  db: D1Database,
  input: {
    tenant_id: string;
    import_id: string;
    range_id: string;
    account_id: string;
    identity_id: string;
    source_cursor: string | null;
    lease_token: string;
    lease_until: string;
    now: string;
    ignore_due?: boolean;
  },
): Promise<boolean> {
  try {
    const dueClause = input.ignore_due
      ? ""
      : "AND (next_attempt_at IS NULL OR next_attempt_at <= ?)";
    const dueValues = input.ignore_due ? [] : [input.now];
    const result = await db
      .prepare(
        `UPDATE history_import_ranges
            SET lease_token = ?, lease_until = ?,
                operation_key = ?, updated_at = ?
          WHERE import_id = ? AND range_id = ? AND account_id = ?
            AND status IN ('pending', 'active')
            AND EXISTS (
              SELECT 1 FROM history_imports
               WHERE history_imports.import_id = history_import_ranges.import_id
                 AND history_imports.tenant_id = ?
                 AND history_imports.account_id = ?
                 AND history_imports.identity_id = ?
            )
            AND (lease_token IS NULL OR lease_until IS NULL OR lease_until <= ? OR lease_token = ?)
            ${dueClause}`,
      )
      .bind(
        input.lease_token,
        input.lease_until,
        historyRangeOperationKey(
          input.import_id,
          input.range_id,
          input.source_cursor,
        ),
        input.now,
        input.import_id,
        input.range_id,
        input.account_id,
        input.tenant_id,
        input.account_id,
        input.identity_id,
        input.now,
        input.lease_token,
        ...dueValues,
      )
      .run();
    return (result.meta.changes ?? 0) === 1;
  } catch (error) {
    throw historyError("history_unavailable", error);
  }
}

/** Claim the oldest due range for a bounded scheduled tick. */
export async function claimNextHistoryRangeWork(
  db: D1Database,
  input: {
    lease_token: string;
    lease_until: string;
    now: string;
  },
): Promise<HistoryRangeWorkClaim | null> {
  try {
    const row = await primarySession(db)
      .prepare(
        `SELECT i.tenant_id, i.identity_id, r.import_id, r.range_id,
                r.account_id, r.source_cursor, r.operation_key, r.lease_until
           FROM history_import_ranges AS r
           JOIN history_imports AS i ON i.import_id = r.import_id
          WHERE r.status IN ('pending', 'active')
            AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= ?)
            AND (r.lease_token IS NULL OR r.lease_until IS NULL OR r.lease_until <= ?)
          ORDER BY COALESCE(r.next_attempt_at, r.updated_at) ASC,
                   r.updated_at ASC, r.range_id ASC
          LIMIT 1`,
      )
      .bind(input.now, input.now)
      .first<HistoryRangeWorkRow>();
    if (row === null) return null;
    const claimed = await claimHistoryRangeWork(db, {
      tenant_id: row.tenant_id,
      import_id: row.import_id,
      range_id: row.range_id,
      account_id: row.account_id,
      identity_id: row.identity_id,
      source_cursor: row.source_cursor,
      lease_token: input.lease_token,
      lease_until: input.lease_until,
      now: input.now,
    });
    if (!claimed) return null;
    return {
      tenant_id: row.tenant_id,
      import_id: row.import_id,
      range_id: row.range_id,
      account_id: row.account_id,
      identity_id: row.identity_id,
      source_cursor: row.source_cursor,
      operation_key:
        row.operation_key ??
        historyRangeOperationKey(
          row.import_id,
          row.range_id,
          row.source_cursor,
        ),
      lease_token: input.lease_token,
      lease_until: input.lease_until,
    };
  } catch (error) {
    if (error instanceof HistoryRepositoryError) throw error;
    throw historyError("history_unavailable", error);
  }
}

/** Move a claimed range to its next durable wake after its checkpoint changed. */
export async function scheduleHistoryRangeWork(
  db: D1Database,
  input: HistoryRangeWorkSchedule,
): Promise<void> {
  try {
    const leaseClause =
      input.lease_token === undefined
        ? "(lease_token IS NULL OR lease_until IS NULL OR lease_until <= ?)"
        : "lease_token = ?";
    const leaseValue = input.lease_token ?? input.updated_at;
    await db
      .prepare(
        `UPDATE history_import_ranges
            SET next_attempt_at = ?, lease_token = NULL, lease_until = NULL,
                operation_key = ?, updated_at = ?
          WHERE import_id = ? AND range_id = ? AND account_id = ?
            AND status IN ('pending', 'active')
            AND ${leaseClause}`,
      )
      .bind(
        input.next_attempt_at,
        historyRangeOperationKey(
          input.import_id,
          input.range_id,
          input.source_cursor,
        ),
        input.updated_at,
        input.import_id,
        input.range_id,
        input.account_id,
        leaseValue,
      )
      .run();
  } catch (error) {
    throw historyError("history_unavailable", error);
  }
}

/** Close the scheduler state only after the range checkpoint is terminal. */
export async function closeHistoryRangeWork(
  db: D1Database,
  input: {
    import_id: string;
    range_id: string;
    account_id: string;
    updated_at: string;
    lease_token?: string;
  },
): Promise<void> {
  try {
    const leaseClause =
      input.lease_token === undefined
        ? "(lease_token IS NULL OR lease_until IS NULL OR lease_until <= ?)"
        : "lease_token = ?";
    const leaseValue = input.lease_token ?? input.updated_at;
    await db
      .prepare(
        `UPDATE history_import_ranges
            SET next_attempt_at = NULL, lease_token = NULL, lease_until = NULL,
                updated_at = ?
          WHERE import_id = ? AND range_id = ? AND account_id = ?
            AND status IN ('completed', 'partial', 'failed', 'gap')
            AND ${leaseClause}`,
      )
      .bind(
        input.updated_at,
        input.import_id,
        input.range_id,
        input.account_id,
        leaseValue,
      )
      .run();
  } catch (error) {
    throw historyError("history_unavailable", error);
  }
}

const importSelect = `SELECT import_id, tenant_id, account_id, connection_id,
  identity_id, provider, status, availability, requested_start_at,
  requested_end_at, source_start_at, source_end_at, max_events, event_count,
  completed_range_count, total_range_count, gap_count, attempt_count,
  max_attempts, last_error_code, started_at, updated_at, completed_at
  FROM history_imports`;

export async function getImport(
  db: HistoryDatabase,
  tenantId: string,
  importId: string,
  accountId?: string,
): Promise<HistoryImport> {
  try {
    const row = await primarySession(db)
      .prepare(
        `${importSelect} WHERE tenant_id = ? AND import_id = ?${accountId === undefined ? "" : " AND account_id = ?"} LIMIT 1`,
      )
      .bind(
        ...(accountId === undefined
          ? [tenantId, importId]
          : [tenantId, importId, accountId]),
      )
      .first<HistoryImportRow>();
    if (row === null) throw historyError("history_not_found");
    return mapImport(row);
  } catch (error) {
    if (error instanceof HistoryRepositoryError) throw error;
    throw historyError("history_unavailable", error);
  }
}

export async function getRanges(
  db: HistoryDatabase,
  importId: string,
): Promise<HistoryImportRange[]> {
  try {
    const result = await primarySession(db)
      .prepare(
        `SELECT range_id, import_id, account_id, start_at, end_at, status,
                attempt_count, event_count, source_cursor, gap_code,
                error_code, created_at, updated_at, completed_at
           FROM history_import_ranges
          WHERE import_id = ? ORDER BY start_at ASC, range_id ASC LIMIT 100`,
      )
      .bind(importId)
      .all<HistoryRangeRow>();
    return result.results.map(mapRange);
  } catch (error) {
    if (error instanceof HistoryRepositoryError) throw error;
    throw historyError("history_unavailable", error);
  }
}

export async function getRange(
  db: HistoryDatabase,
  importId: string,
  rangeId: string,
): Promise<HistoryImportRange> {
  try {
    const row = await primarySession(db)
      .prepare(
        `SELECT range_id, import_id, account_id, start_at, end_at, status,
                attempt_count, event_count, source_cursor, gap_code,
                error_code, created_at, updated_at, completed_at
           FROM history_import_ranges
          WHERE import_id = ? AND range_id = ? LIMIT 1`,
      )
      .bind(importId, rangeId)
      .first<HistoryRangeRow>();
    if (row === null) throw historyError("history_not_found");
    return mapRange(row);
  } catch (error) {
    if (error instanceof HistoryRepositoryError) throw error;
    throw historyError("history_unavailable", error);
  }
}

export async function getDetail(
  db: HistoryDatabase,
  tenantId: string,
  importId: string,
  accountId?: string,
): Promise<HistoryImportDetail> {
  const item = await getImport(db, tenantId, importId, accountId);
  const ranges = await getRanges(db, importId);
  const capabilities = await listCapabilities(
    db,
    tenantId,
    item.account_id,
    item.connection_id,
  );
  return HistoryImportDetailSchema.parse({
    import: item,
    ranges,
    capabilities,
  });
}

export async function listImports(
  db: HistoryDatabase,
  tenantId: string,
  accountId: string,
  limit = 50,
  cursor?: string,
): Promise<HistoryImportPage> {
  try {
    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    const result = await primarySession(db)
      .prepare(
        `${importSelect}
          WHERE tenant_id = ? AND account_id = ?
            ${cursor === undefined ? "" : " AND import_id < ?"}
          ORDER BY import_id DESC LIMIT ?`,
      )
      .bind(
        ...(cursor === undefined
          ? [tenantId, accountId, boundedLimit + 1]
          : [tenantId, accountId, cursor, boundedLimit + 1]),
      )
      .all<HistoryImportRow>();
    const items = result.results.slice(0, boundedLimit).map(mapImport);
    const next =
      result.results.length > boundedLimit
        ? (items.at(-1)?.import_id ?? null)
        : null;
    return HistoryImportPageSchema.parse({ items, next_cursor: next });
  } catch (error) {
    if (error instanceof HistoryRepositoryError) throw error;
    throw historyError("history_unavailable", error);
  }
}

export async function listCapabilities(
  db: HistoryDatabase,
  tenantId: string,
  accountId: string,
  connectionId: string,
): Promise<ProviderCapability[]> {
  try {
    const result = await primarySession(db)
      .prepare(
        `SELECT tenant_id, account_id, connection_id, identity_id, provider,
                capability, status, freshness, provider_version, proof_source,
                provider_evidence_json, product_claim, observed_at, updated_at
           FROM provider_capability_records
          WHERE tenant_id = ? AND account_id = ? AND connection_id = ?
          ORDER BY capability ASC`,
      )
      .bind(tenantId, accountId, connectionId)
      .all<CapabilityRow>();
    return result.results.map(mapCapability);
  } catch (error) {
    if (error instanceof HistoryRepositoryError) throw error;
    throw historyError("history_unavailable", error);
  }
}

export async function upsertCapability(
  db: D1Database,
  capability: ProviderCapability,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO provider_capability_records
          (tenant_id, account_id, connection_id, identity_id, provider,
           capability, status, freshness, provider_version, proof_source,
           provider_evidence_json, product_claim, observed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, account_id, capability) DO UPDATE SET
           connection_id = excluded.connection_id,
           identity_id = excluded.identity_id,
           provider = excluded.provider,
           status = excluded.status,
           freshness = excluded.freshness,
           provider_version = excluded.provider_version,
           proof_source = excluded.proof_source,
           provider_evidence_json = excluded.provider_evidence_json,
           product_claim = excluded.product_claim,
           observed_at = excluded.observed_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        capability.tenant_id,
        capability.account_id,
        capability.connection_id,
        capability.identity_id,
        capability.provider,
        capability.capability,
        capability.status,
        capability.freshness,
        capability.provider_version,
        capability.proof_source,
        JSON.stringify(capability.provider_evidence),
        capability.product_claim,
        capability.observed_at,
        capability.updated_at,
      )
      .run();
  } catch (error) {
    throw historyError("history_unavailable", error);
  }
}

/** Seed only evidence-backed, explicitly non-optimistic capability records. */
export async function ensureDefaultCapabilities(
  db: D1Database,
  binding: HistoryAccountBinding,
  updatedAt: string,
): Promise<void> {
  const providerVersion = binding.provider === "whatsapp" ? "v26.08" : null;
  const proofSource =
    binding.provider === "whatsapp"
      ? "docs/research/2026-09-13-whatsapp-capability-research.md"
      : "provider-capability-proof-pending";
  const defaults: ReadonlyArray<
    readonly [
      ProviderCapability["capability"],
      ProviderCapability["status"],
      string,
    ]
  > = [
    [
      "history.import",
      "unverified" as const,
      "History import is not proven for this pinned runtime; the configured local product path is unavailable until a provider adapter responds.",
    ],
    [
      "media.read",
      "conditional" as const,
      "Provider media types are documented, but Communicator media retrieval still requires deployment proof.",
    ],
    [
      "contact.lookup",
      "conditional" as const,
      "Provider contact lookup is documented, but account-bound resolution requires deployment proof.",
    ],
    [
      "group.manage",
      "conditional" as const,
      "Provider group operations are documented, but operation-specific permissions require deployment proof.",
    ],
    [
      "receipt.read",
      "conditional" as const,
      "Provider receipt support is documented, but a live provider result is still required.",
    ],
  ];
  for (const [capability, status, productClaim] of defaults) {
    await upsertCapability(
      db,
      ProviderCapabilitySchema.parse({
        tenant_id: binding.tenant_id,
        account_id: binding.account_id,
        connection_id: binding.connection_id,
        identity_id: binding.identity_id,
        provider: binding.provider,
        capability,
        status,
        freshness: "unknown",
        provider_version: providerVersion,
        proof_source: proofSource,
        provider_evidence: {
          provider_version: providerVersion,
          proof_source: proofSource,
          summary:
            providerVersion === null
              ? "No pinned provider evidence is available for this provider."
              : "Pinned upstream documentation is evidence of provider behavior, not proof of this deployment.",
          observed_at: null,
        },
        product_claim: productClaim,
        observed_at: null,
        updated_at: updatedAt,
      }),
    );
  }
}

export async function listExistingEventHashes(
  db: HistoryDatabase,
  importId: string,
  sourceEventIds: readonly string[],
): Promise<EventHashRow[]> {
  if (sourceEventIds.length === 0) return [];
  try {
    const session = primarySession(db);
    const rows: EventHashRow[] = [];
    for (
      let offset = 0;
      offset < sourceEventIds.length;
      offset += EVENT_HASH_LOOKUP_CHUNK_SIZE
    ) {
      const chunk = sourceEventIds.slice(
        offset,
        offset + EVENT_HASH_LOOKUP_CHUNK_SIZE,
      );
      const result = await session
        .prepare(
          `SELECT source_event_id, event_hash FROM history_import_events
            WHERE import_id = ? AND source_event_id IN (${chunk.map(() => "?").join(",")})`,
        )
        .bind(importId, ...chunk)
        .all<EventHashRow>();
      rows.push(...result.results);
    }
    return rows;
  } catch (error) {
    throw historyError("history_unavailable", error);
  }
}

export async function insertEventHashes(
  db: D1Database,
  rows: readonly {
    import_id: string;
    range_id: string;
    source_event_id: string;
    event_hash: string;
    occurred_at: string;
    created_at: string;
  }[],
): Promise<void> {
  if (rows.length === 0) return;
  try {
    for (
      let offset = 0;
      offset < rows.length;
      offset += EVENT_HASH_INSERT_CHUNK_SIZE
    ) {
      const chunk = rows.slice(offset, offset + EVENT_HASH_INSERT_CHUNK_SIZE);
      await db.batch(
        chunk.map((row) =>
          db
            .prepare(
              `INSERT OR IGNORE INTO history_import_events
                (import_id, range_id, source_event_id, event_hash, occurred_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              row.import_id,
              row.range_id,
              row.source_event_id,
              row.event_hash,
              row.occurred_at,
              row.created_at,
            ),
        ),
      );
    }
  } catch (error) {
    throw historyError("history_conflict", error);
  }
}

export async function historyCoverage(
  db: HistoryDatabase,
  tenantId: string,
  accountId: string,
  hasMessages: boolean,
): Promise<HistoryCoverage> {
  try {
    const row = await primarySession(db)
      .prepare(
        `SELECT import_id, status, requested_start_at, requested_end_at, gap_count
           FROM history_imports
          WHERE tenant_id = ? AND account_id = ?
          ORDER BY updated_at DESC, import_id DESC LIMIT 1`,
      )
      .bind(tenantId, accountId)
      .first<{
        import_id: string;
        status: string;
        requested_start_at: string;
        requested_end_at: string;
        gap_count: number;
      }>();
    const state: HistoryCoverage["state"] =
      row === null
        ? hasMessages
          ? "available"
          : "not_imported"
        : hasMessages
          ? row.status === "partial"
            ? "partial"
            : "available"
          : row.status === "completed"
            ? "empty"
            : row.status === "partial"
              ? "partial"
              : row.status === "failed"
                ? "unavailable"
                : "not_imported";
    return HistoryCoverageSchema.parse({
      state,
      account_id: accountId,
      latest_import_id: row?.import_id ?? null,
      requested_start_at: row?.requested_start_at ?? null,
      requested_end_at: row?.requested_end_at ?? null,
      known_gap_count: row?.gap_count ?? 0,
    });
  } catch (error) {
    if (error instanceof HistoryRepositoryError) throw error;
    throw historyError("history_unavailable", error);
  }
}
