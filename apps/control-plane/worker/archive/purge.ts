import {
  CanonicalResourceIdSchema,
  RemovalAuthoritySchema,
  type RemovalAuthority,
} from "@communicator/contracts";
import { listRemovalAuthorities } from "../removals/ledger";
import { archiveError, ArchiveError } from "./errors";
import {
  ArchivePurgeLineageSchema,
  ArchivePurgeObjectStateSchema,
  ArchivePurgeOperationSchema,
  type ArchivePurgeLineage,
  type ArchivePurgeObjectState,
  type ArchivePurgeOperation,
  type ArchivePurgeStatus,
  operationIdForRemoval,
} from "./manifest";
import { readCommittedArchiveBatch, listCommittedManifestPage } from "./reader";
import { sanitizeArchiveEvents } from "./replay";
import { archiveCanonicalEventBatch } from "./writer";

/** Keep a cleanup margin before the hard 30-day controlled-copy ceiling. */
export const ARCHIVE_PURGE_SAFETY_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const ARCHIVE_PURGE_MAX_SAFETY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_DISCOVERED_MANIFESTS = 10_000;

type PurgeDatabase = D1Database | D1DatabaseSession;

export type ArchivePurgeHooks = {
  /** Test/operations seam: throw after replacement lineage is durable. */
  afterReplacement?: (lineage: ArchivePurgeLineage) => void | Promise<void>;
  /** Test/operations seam: throw after the old manifest deletion attempt. */
  afterManifestDeletion?: (
    lineage: ArchivePurgeLineage,
  ) => void | Promise<void>;
};

export type ArchivePurgeInput = {
  database: PurgeDatabase;
  bucket: R2Bucket;
  tenantId: string;
  removalId: string;
  now?: Date;
  safetyWindowMs?: number;
  hooks?: ArchivePurgeHooks;
};

export type ArchivePurgeResult = {
  operation: ArchivePurgeOperation;
  objects: ArchivePurgeLineage[];
};

type OperationRow = {
  id: unknown;
  tenant_id: unknown;
  removal_id: unknown;
  resource_type: unknown;
  resource_id: unknown;
  content_generation: unknown;
  deletion_epoch: unknown;
  status: unknown;
  safety_deadline: unknown;
  failure_code: unknown;
  created_at: unknown;
  updated_at: unknown;
  completed_at: unknown;
};

type ObjectRow = {
  operation_id: unknown;
  tenant_id: unknown;
  original_manifest_key: unknown;
  original_data_key: unknown;
  replacement_manifest_key: unknown;
  replacement_data_key: unknown;
  original_canonical_sha256: unknown;
  replacement_canonical_sha256: unknown;
  original_first_event_id: unknown;
  original_last_event_id: unknown;
  replacement_first_event_id: unknown;
  replacement_last_event_id: unknown;
  original_event_count: unknown;
  replacement_event_count: unknown;
  removed_event_ids_json: unknown;
  retained_event_ids_json: unknown;
  state: unknown;
  manifest_deleted_at: unknown;
  data_deleted_at: unknown;
  last_error: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type PurgePlan = {
  manifestKey: string;
  dataKey: string;
  canonicalSha256: string;
  firstEventId: string;
  lastEventId: string;
  eventCount: number;
  retainedEvents: Awaited<
    ReturnType<typeof readCommittedArchiveBatch>
  >["events"];
  removedEventIds: string[];
  retainedEventIds: string[];
};

const OPERATION_COLUMNS = `
  id, tenant_id, removal_id, resource_type, resource_id, content_generation,
  deletion_epoch, status, safety_deadline, failure_code, created_at,
  updated_at, completed_at
`;
const OBJECT_COLUMNS = `
  operation_id, tenant_id, original_manifest_key, original_data_key,
  replacement_manifest_key, replacement_data_key, original_canonical_sha256,
  replacement_canonical_sha256, original_first_event_id,
  original_last_event_id, replacement_first_event_id,
  replacement_last_event_id, original_event_count, replacement_event_count,
  removed_event_ids_json, retained_event_ids_json, state,
  manifest_deleted_at, data_deleted_at, last_error, created_at, updated_at
`;

const primarySession = (database: PurgeDatabase): D1DatabaseSession => {
  if ("withSession" in database && typeof database.withSession === "function") {
    return database.withSession("first-primary");
  }
  return database as D1DatabaseSession;
};

const timestamp = (value: Date): string => {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw archiveError("archive_invalid");
  }
  return value.toISOString();
};

const errorCode = (error: unknown): string => {
  if (error instanceof ArchiveError) return error.code;
  if (error instanceof Error && error.name.trim()) {
    return error.name.trim().slice(0, 1_024);
  }
  return "archive_purge_incomplete";
};

const parseJsonIds = (value: unknown): string[] => {
  if (typeof value !== "string")
    throw new Error("purge event evidence missing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("purge event evidence malformed");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "string")
  ) {
    throw new Error("purge event evidence malformed");
  }
  return parsed;
};

const nullableString = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

const parseOperation = (
  row: OperationRow | null,
): ArchivePurgeOperation | null => {
  if (row === null) return null;
  const parsed = ArchivePurgeOperationSchema.safeParse(row);
  if (!parsed.success) throw new Error("archive purge operation row invalid");
  return parsed.data;
};

/**
 * Object rows carry the resource columns in the parent operation.  This
 * rehydrates a public lineage object after joining those two rows.
 */
const lineageFromRows = (
  operation: ArchivePurgeOperation,
  row: ObjectRow,
): ArchivePurgeLineage => {
  const parsed = ArchivePurgeLineageSchema.safeParse({
    operation_id: operation.id,
    removal_id: operation.removal_id,
    tenant_id: operation.tenant_id,
    resource_type: operation.resource_type,
    resource_id: operation.resource_id,
    content_generation: operation.content_generation,
    deletion_epoch: operation.deletion_epoch,
    original_manifest_key: row.original_manifest_key,
    original_data_key: row.original_data_key,
    replacement_manifest_key: nullableString(row.replacement_manifest_key),
    replacement_data_key: nullableString(row.replacement_data_key),
    original_canonical_sha256: row.original_canonical_sha256,
    replacement_canonical_sha256: nullableString(
      row.replacement_canonical_sha256,
    ),
    original_first_event_id: row.original_first_event_id,
    original_last_event_id: row.original_last_event_id,
    replacement_first_event_id: nullableString(row.replacement_first_event_id),
    replacement_last_event_id: nullableString(row.replacement_last_event_id),
    original_event_count: row.original_event_count,
    replacement_event_count: row.replacement_event_count,
    removed_event_ids: parseJsonIds(row.removed_event_ids_json),
    retained_event_ids: parseJsonIds(row.retained_event_ids_json),
    state: row.state,
    manifest_deleted_at: nullableString(row.manifest_deleted_at),
    data_deleted_at: nullableString(row.data_deleted_at),
    last_error: nullableString(row.last_error),
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
  if (!parsed.success) throw new Error("archive purge lineage row invalid");
  return parsed.data;
};

const readOperation = async (
  db: D1DatabaseSession,
  tenantId: string,
  operationId: string,
): Promise<ArchivePurgeOperation | null> =>
  parseOperation(
    await db
      .prepare(
        `SELECT ${OPERATION_COLUMNS} FROM archive_purge_operations WHERE tenant_id = ? AND id = ? LIMIT 1`,
      )
      .bind(tenantId, operationId)
      .first<OperationRow>(),
  );

const readObjects = async (
  db: D1DatabaseSession,
  operationId: string,
): Promise<ObjectRow[]> => {
  const result = await db
    .prepare(
      `SELECT ${OBJECT_COLUMNS} FROM archive_purge_objects WHERE operation_id = ? ORDER BY original_manifest_key ASC`,
    )
    .bind(operationId)
    .all<ObjectRow>();
  return result.results;
};

type ArchivePurgeCandidateRow = {
  tenant_id: unknown;
  removal_id: unknown;
};

/** Durable wakeups for both incomplete work and late archive batches. */
export const listArchivePurgeCandidates = async (
  database: PurgeDatabase,
  limit = 100,
): Promise<Array<{ tenantId: string; removalId: string }>> => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw archiveError("archive_invalid");
  }
  const db = primarySession(database);
  const rows = await db
    .prepare(
      `SELECT tenant_id, removal_id
       FROM archive_purge_operations
       ORDER BY updated_at ASC, id ASC
       LIMIT ?`,
    )
    .bind(limit)
    .all<ArchivePurgeCandidateRow>();
  return rows.results.flatMap((row) => {
    if (
      typeof row.tenant_id !== "string" ||
      typeof row.removal_id !== "string"
    ) {
      throw archiveError("archive_corrupt");
    }
    return [{ tenantId: row.tenant_id, removalId: row.removal_id }];
  });
};

/** Read archive operation progress for an authorized tenant status view. */
export const listArchivePurgeOperations = async (
  database: PurgeDatabase,
  tenantId: string,
): Promise<ArchivePurgeOperation[]> => {
  if (!CanonicalResourceIdSchema.safeParse(tenantId).success) {
    throw archiveError("archive_invalid");
  }
  const db = primarySession(database);
  const rows = await db
    .prepare(
      `SELECT ${OPERATION_COLUMNS}
       FROM archive_purge_operations
       WHERE tenant_id = ?
       ORDER BY updated_at ASC, id ASC`,
    )
    .bind(tenantId)
    .all<OperationRow>();
  return rows.results.flatMap((row) => {
    const operation = parseOperation(row);
    if (operation === null) throw archiveError("archive_corrupt");
    return [operation];
  });
};

/**
 * Read the durable archive-only purge state without changing it.  Removal
 * status callers use this to show incomplete work while active suppression
 * remains authoritative in the separate removal ledger.
 */
export const readArchivePurgeForRemoval = async (
  database: PurgeDatabase,
  tenantId: string,
  removalId: string,
): Promise<ArchivePurgeResult | null> => {
  if (!CanonicalResourceIdSchema.safeParse(tenantId).success) {
    throw archiveError("archive_invalid");
  }
  if (!CanonicalResourceIdSchema.safeParse(removalId).success) {
    throw archiveError("archive_invalid");
  }
  const db = primarySession(database);
  const operation = await readOperation(
    db,
    tenantId,
    operationIdForRemoval(removalId),
  );
  if (operation === null) return null;
  const rows = await readObjects(db, operation.id);
  return {
    operation,
    objects: rows.map((row) => lineageFromRows(operation, row)),
  };
};

const updateOperation = async (
  db: D1DatabaseSession,
  operation: ArchivePurgeOperation,
  status: ArchivePurgeStatus,
  now: string,
  failureCode: string | null,
  completedAt: string | null,
): Promise<ArchivePurgeOperation> => {
  await db
    .prepare(
      `UPDATE archive_purge_operations
       SET status = ?, failure_code = ?, updated_at = ?, completed_at = ?
       WHERE id = ? AND tenant_id = ?`,
    )
    .bind(
      status,
      failureCode,
      now,
      completedAt,
      operation.id,
      operation.tenant_id,
    )
    .run();
  const next = await readOperation(db, operation.tenant_id, operation.id);
  if (next === null) throw new Error("archive purge operation disappeared");
  return next;
};

const insertOperation = async (
  db: D1DatabaseSession,
  authority: RemovalAuthority,
  now: string,
  safetyDeadline: string,
): Promise<ArchivePurgeOperation> => {
  const id = operationIdForRemoval(authority.id);
  await db
    .prepare(
      `INSERT OR IGNORE INTO archive_purge_operations (
        id, tenant_id, removal_id, resource_type, resource_id,
        content_generation, deletion_epoch, status, safety_deadline,
        failure_code, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?, NULL, ?, ?, NULL)`,
    )
    .bind(
      id,
      authority.tenant_id,
      authority.id,
      authority.resource_type,
      authority.resource_id,
      authority.content_generation,
      authority.deletion_epoch,
      safetyDeadline,
      now,
      now,
    )
    .run();
  const operation = await readOperation(db, authority.tenant_id, id);
  if (operation === null)
    throw new Error("archive purge operation was not recorded");
  if (
    operation.removal_id !== authority.id ||
    operation.resource_type !== authority.resource_type ||
    operation.resource_id !== authority.resource_id ||
    operation.content_generation !== authority.content_generation ||
    operation.deletion_epoch !== authority.deletion_epoch
  ) {
    throw archiveError("archive_conflict");
  }
  return operation;
};

const PURGE_LOCK_LEASE_MS = 60 * 1_000;

type PurgeLockRenew = () => Promise<void>;

const withPurgeLock = async <T>(
  db: D1DatabaseSession,
  tenantId: string,
  operationId: string,
  nowDate: Date,
  work: (renew: PurgeLockRenew) => Promise<T>,
): Promise<T> => {
  const leaseToken = `archive_lock_${crypto.randomUUID()}`;
  const now = timestamp(nowDate);
  const leaseExpiresAt = new Date(
    nowDate.getTime() + PURGE_LOCK_LEASE_MS,
  ).toISOString();
  const claim = await db
    .prepare(
      `INSERT INTO archive_purge_locks (
         tenant_id, operation_id, lease_token, lease_expires_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET
         operation_id = excluded.operation_id,
         lease_token = excluded.lease_token,
         lease_expires_at = excluded.lease_expires_at,
         updated_at = excluded.updated_at
       WHERE archive_purge_locks.lease_expires_at <= excluded.updated_at`,
    )
    .bind(tenantId, operationId, leaseToken, leaseExpiresAt, now, now)
    .run();
  if ((claim.meta.changes ?? 0) !== 1) {
    throw archiveError("archive_busy");
  }

  const renew = async (): Promise<void> => {
    const renewed = await db
      .prepare(
        `UPDATE archive_purge_locks
         SET lease_expires_at = ?, updated_at = ?
         WHERE tenant_id = ? AND operation_id = ? AND lease_token = ?`,
      )
      .bind(
        new Date(Date.now() + PURGE_LOCK_LEASE_MS).toISOString(),
        new Date().toISOString(),
        tenantId,
        operationId,
        leaseToken,
      )
      .run();
    if ((renewed.meta.changes ?? 0) !== 1) {
      throw archiveError("archive_busy");
    }
  };

  try {
    return await work(renew);
  } finally {
    await db
      .prepare(
        "DELETE FROM archive_purge_locks WHERE tenant_id = ? AND operation_id = ? AND lease_token = ?",
      )
      .bind(tenantId, operationId, leaseToken)
      .run();
  }
};

const insertObjectPlan = async (
  db: D1DatabaseSession,
  operation: ArchivePurgeOperation,
  plan: PurgePlan,
  now: string,
): Promise<void> => {
  await db
    .prepare(
      `INSERT OR IGNORE INTO archive_purge_objects (
        operation_id, tenant_id, original_manifest_key, original_data_key,
        replacement_manifest_key, replacement_data_key,
        original_canonical_sha256, replacement_canonical_sha256,
        original_first_event_id, original_last_event_id,
        replacement_first_event_id, replacement_last_event_id,
        original_event_count, replacement_event_count,
        removed_event_ids_json, retained_event_ids_json, state,
        manifest_deleted_at, data_deleted_at, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, 'planned', NULL, NULL, NULL, ?, ?)`,
    )
    .bind(
      operation.id,
      operation.tenant_id,
      plan.manifestKey,
      plan.dataKey,
      plan.canonicalSha256,
      plan.firstEventId,
      plan.lastEventId,
      plan.eventCount,
      plan.retainedEvents.length,
      JSON.stringify(plan.removedEventIds),
      JSON.stringify(plan.retainedEventIds),
      now,
      now,
    )
    .run();
};

const updateObject = async (
  db: D1DatabaseSession,
  operation: ArchivePurgeOperation,
  originalManifestKey: string,
  updates: {
    replacementManifestKey?: string | null;
    replacementDataKey?: string | null;
    replacementCanonicalSha256?: string | null;
    replacementFirstEventId?: string | null;
    replacementLastEventId?: string | null;
    replacementEventCount?: number;
    state?: ArchivePurgeObjectState;
    manifestDeletedAt?: string | null;
    dataDeletedAt?: string | null;
    lastError?: string | null;
  },
  now: string,
): Promise<ObjectRow> => {
  const assignments: string[] = [];
  const values: Array<string | number | null> = [];
  const add = (column: string, value: string | number | null | undefined) => {
    if (value === undefined) return;
    assignments.push(`${column} = ?`);
    values.push(value);
  };
  add("replacement_manifest_key", updates.replacementManifestKey);
  add("replacement_data_key", updates.replacementDataKey);
  add("replacement_canonical_sha256", updates.replacementCanonicalSha256);
  add("replacement_first_event_id", updates.replacementFirstEventId);
  add("replacement_last_event_id", updates.replacementLastEventId);
  add("replacement_event_count", updates.replacementEventCount);
  add("state", updates.state);
  add("manifest_deleted_at", updates.manifestDeletedAt);
  add("data_deleted_at", updates.dataDeletedAt);
  add("last_error", updates.lastError);
  add("updated_at", now);
  values.push(operation.id, originalManifestKey);
  await db
    .prepare(
      `UPDATE archive_purge_objects SET ${assignments.join(", ")} WHERE operation_id = ? AND original_manifest_key = ?`,
    )
    .bind(...values)
    .run();
  const row = await db
    .prepare(
      `SELECT ${OBJECT_COLUMNS} FROM archive_purge_objects WHERE operation_id = ? AND original_manifest_key = ? LIMIT 1`,
    )
    .bind(operation.id, originalManifestKey)
    .first<ObjectRow>();
  if (row === null) throw new Error("archive purge object disappeared");
  return row;
};

const listManifestKeys = async (
  bucket: R2Bucket,
  tenantId: string,
): Promise<string[]> => {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await listCommittedManifestPage(bucket, tenantId, {
      pageSize: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const item of page.items) {
      keys.push(item.key);
      if (keys.length > MAX_DISCOVERED_MANIFESTS) {
        throw archiveError("archive_too_large");
      }
    }
    if (page.next_cursor !== null && page.next_cursor === cursor) {
      throw archiveError("archive_corrupt");
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return keys;
};

const discoverPlans = async (
  bucket: R2Bucket,
  authority: RemovalAuthority,
): Promise<PurgePlan[]> => {
  const plans: PurgePlan[] = [];
  const keys = await listManifestKeys(bucket, authority.tenant_id);
  for (const manifestKey of keys) {
    const committed = await readCommittedArchiveBatch(
      bucket,
      authority.tenant_id,
      manifestKey,
    );
    const sanitized = sanitizeArchiveEvents(committed.events, authority);
    if (
      sanitized.removed_event_ids.length === 0 &&
      sanitized.changed_event_ids.length === 0
    ) {
      continue;
    }
    plans.push({
      manifestKey,
      dataKey: committed.manifest.data_key,
      canonicalSha256: committed.manifest.canonical_sha256,
      firstEventId: committed.manifest.first_event_id,
      lastEventId: committed.manifest.last_event_id,
      eventCount: committed.events.length,
      retainedEvents: sanitized.events,
      removedEventIds: sanitized.removed_event_ids,
      retainedEventIds: sanitized.retained_event_ids,
    });
  }
  return plans;
};

const replacementBatchId = async (
  operation: ArchivePurgeOperation,
  originalManifestKey: string,
): Promise<string> => {
  const input = new TextEncoder().encode(
    `${operation.id}\u0000${originalManifestKey}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", input);
  const hex = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  return `batch_purge_${hex.slice(0, 48)}`;
};

const headObject = async (
  bucket: R2Bucket,
  key: string,
): Promise<R2Object | null> => {
  try {
    return await bucket.head(key);
  } catch (error) {
    throw archiveError("archive_unavailable", error);
  }
};

const deleteAndVerify = async (
  bucket: R2Bucket,
  key: string,
  missingIsSuccess: boolean,
): Promise<void> => {
  const before = await headObject(bucket, key);
  if (before === null && missingIsSuccess) return;
  if (before === null) throw archiveError("archive_not_found");
  try {
    await bucket.delete(key);
  } catch (error) {
    throw archiveError("archive_unavailable", error);
  }
  const after = await headObject(bucket, key);
  if (after !== null) throw archiveError("archive_unavailable");
};

const validateReplacement = async (
  bucket: R2Bucket,
  authority: RemovalAuthority,
  row: ObjectRow,
): Promise<void> => {
  const manifestKey = nullableString(row.replacement_manifest_key);
  if (manifestKey === null) {
    if (Number(row.replacement_event_count) !== 0) {
      throw archiveError("archive_corrupt");
    }
    return;
  }
  const replacement = await readCommittedArchiveBatch(
    bucket,
    authority.tenant_id,
    manifestKey,
  );
  const expectedIds = parseJsonIds(row.retained_event_ids_json);
  const actualIds = replacement.events.map((event) => event.event_id);
  if (
    actualIds.length !== expectedIds.length ||
    actualIds.some((eventId, index) => eventId !== expectedIds[index])
  ) {
    throw archiveError("archive_conflict");
  }
  if (
    nullableString(row.replacement_data_key) !==
      replacement.manifest.data_key ||
    nullableString(row.replacement_canonical_sha256) !==
      replacement.manifest.canonical_sha256
  ) {
    throw archiveError("archive_conflict");
  }
};

const writeReplacement = async (
  db: D1DatabaseSession,
  bucket: R2Bucket,
  authority: RemovalAuthority,
  operation: ArchivePurgeOperation,
  plan: PurgePlan,
  row: ObjectRow,
  now: string,
): Promise<ObjectRow> => {
  if (nullableString(row.replacement_manifest_key) !== null) {
    await validateReplacement(bucket, authority, row);
    return row;
  }
  if (plan.retainedEvents.length === 0) {
    return updateObject(
      db,
      operation,
      plan.manifestKey,
      {
        replacementEventCount: 0,
        state: "replacement_written",
        lastError: null,
      },
      now,
    );
  }
  const batchId = await replacementBatchId(operation, plan.manifestKey);
  const committed = await archiveCanonicalEventBatch({
    bucket,
    tenantId: authority.tenant_id,
    batchId,
    events: plan.retainedEvents,
    archivedAt: now,
    producerVersion: "archive-purge/1",
    sourceCheckpoint: {
      kind: "archive-purge",
      value: `${operation.id}:${plan.manifestKey}`.slice(0, 512),
    },
  });
  await readCommittedArchiveBatch(
    bucket,
    authority.tenant_id,
    committed.manifestKey,
  );
  return updateObject(
    db,
    operation,
    plan.manifestKey,
    {
      replacementManifestKey: committed.manifestKey,
      replacementDataKey: committed.manifest.data_key,
      replacementCanonicalSha256: committed.manifest.canonical_sha256,
      replacementFirstEventId: committed.manifest.first_event_id,
      replacementLastEventId: committed.manifest.last_event_id,
      replacementEventCount: committed.manifest.event_count,
      state: "replacement_written",
      lastError: null,
    },
    now,
  );
};

const processObject = async (
  db: D1DatabaseSession,
  bucket: R2Bucket,
  authority: RemovalAuthority,
  operation: ArchivePurgeOperation,
  row: ObjectRow,
  plan: PurgePlan | undefined,
  nowDate: Date,
  hooks: ArchivePurgeHooks | undefined,
): Promise<ObjectRow> => {
  const now = timestamp(nowDate);
  let current = row;
  try {
    const state = ArchivePurgeObjectStateSchema.safeParse(current.state);
    if (!state.success) throw archiveError("archive_corrupt");

    if (state.data === "data_deleted") return current;
    if (state.data === "incomplete") {
      // Recovery is driven by durable lineage, not by rediscovering the old
      // manifest.  A replacement or a recorded manifest deletion tells us
      // which phase was reached before the worker failed.
      const replacementExists =
        nullableString(current.replacement_manifest_key) !== null;
      const manifestWasDeleted =
        nullableString(current.manifest_deleted_at) !== null;
      if (manifestWasDeleted) {
        current = await updateObject(
          db,
          operation,
          String(current.original_manifest_key),
          { state: "manifest_deleted", lastError: null },
          now,
        );
      } else if (replacementExists) {
        current = await updateObject(
          db,
          operation,
          String(current.original_manifest_key),
          { state: "replacement_written", lastError: null },
          now,
        );
      } else if (plan !== undefined) {
        current = await updateObject(
          db,
          operation,
          String(current.original_manifest_key),
          { state: "planned", lastError: null },
          now,
        );
      } else {
        return current;
      }
    }

    const currentStateBeforeWrite = ArchivePurgeObjectStateSchema.parse(
      current.state,
    );
    if (currentStateBeforeWrite === "planned") {
      if (plan === undefined) throw archiveError("archive_not_found");
      current = await writeReplacement(
        db,
        bucket,
        authority,
        operation,
        plan,
        current,
        now,
      );
      if (hooks?.afterReplacement) {
        const lineage = lineageFromRows(operation, current);
        await hooks.afterReplacement(lineage);
      }
    } else {
      await validateReplacement(bucket, authority, current);
    }

    const currentState = ArchivePurgeObjectStateSchema.parse(current.state);
    if (currentState === "replacement_written") {
      await deleteAndVerify(
        bucket,
        String(current.original_manifest_key),
        true,
      );
      current = await updateObject(
        db,
        operation,
        String(current.original_manifest_key),
        {
          state: "manifest_deleted",
          manifestDeletedAt: now,
          lastError: null,
        },
        now,
      );
      if (hooks?.afterManifestDeletion) {
        const lineage = lineageFromRows(operation, current);
        await hooks.afterManifestDeletion(lineage);
      }
    }

    const afterManifest = ArchivePurgeObjectStateSchema.parse(current.state);
    if (afterManifest === "manifest_deleted") {
      const deadline = Date.parse(operation.safety_deadline);
      if (!Number.isFinite(deadline)) throw archiveError("archive_corrupt");
      if (nowDate.getTime() < deadline) return current;
      await deleteAndVerify(bucket, String(current.original_data_key), true);
      current = await updateObject(
        db,
        operation,
        String(current.original_manifest_key),
        {
          state: "data_deleted",
          dataDeletedAt: now,
          lastError: null,
        },
        now,
      );
    }
    return current;
  } catch (error) {
    const code = errorCode(error);
    try {
      return await updateObject(
        db,
        operation,
        String(current.original_manifest_key),
        { state: "incomplete", lastError: code },
        now,
      );
    } catch {
      throw error;
    }
  }
};

const loadAuthority = async (
  db: D1DatabaseSession,
  tenantId: string,
  removalId: string,
): Promise<RemovalAuthority> => {
  const authorities = await listRemovalAuthorities(db, tenantId);
  const authority = authorities.find((candidate) => candidate.id === removalId);
  if (authority === undefined) throw archiveError("archive_not_found");
  const parsed = RemovalAuthoritySchema.safeParse(authority);
  if (!parsed.success) throw archiveError("archive_corrupt", parsed.error);
  return parsed.data;
};

const ensureInput = (input: ArchivePurgeInput): void => {
  if (input === null || typeof input !== "object") {
    throw archiveError("archive_invalid");
  }
  if (!CanonicalResourceIdSchema.safeParse(input.tenantId).success) {
    throw archiveError("archive_invalid");
  }
  if (!CanonicalResourceIdSchema.safeParse(input.removalId).success) {
    throw archiveError("archive_invalid");
  }
  const window = input.safetyWindowMs ?? ARCHIVE_PURGE_SAFETY_WINDOW_MS;
  if (
    !Number.isSafeInteger(window) ||
    window < 0 ||
    window > ARCHIVE_PURGE_MAX_SAFETY_WINDOW_MS
  ) {
    throw archiveError("archive_invalid");
  }
  if (input.database === null || typeof input.database !== "object") {
    throw archiveError("archive_invalid");
  }
  if (
    input.bucket === null ||
    typeof input.bucket !== "object" ||
    typeof (input.bucket as { list?: unknown }).list !== "function" ||
    typeof (input.bucket as { get?: unknown }).get !== "function" ||
    typeof (input.bucket as { put?: unknown }).put !== "function" ||
    typeof (input.bucket as { delete?: unknown }).delete !== "function" ||
    typeof (input.bucket as { head?: unknown }).head !== "function"
  ) {
    throw archiveError("archive_invalid");
  }
};

/**
 * Discover committed batches, write sanitized replacements, hide original
 * manifests, and delete old data only after the explicit safety window.  The
 * operation is idempotent by removal id and can resume after any failed step.
 */
export const purgeArchiveForRemoval = async (
  input: ArchivePurgeInput,
): Promise<ArchivePurgeResult> => {
  ensureInput(input);
  const nowDate = input.now ?? new Date();
  const now = timestamp(nowDate);
  const db = primarySession(input.database);
  const authority = await loadAuthority(db, input.tenantId, input.removalId);
  if (authority.tenant_id !== input.tenantId) {
    throw archiveError("archive_tenant_mismatch");
  }
  const safetyWindow = input.safetyWindowMs ?? ARCHIVE_PURGE_SAFETY_WINDOW_MS;
  const operationId = operationIdForRemoval(authority.id);
  let operation = await readOperation(db, authority.tenant_id, operationId);
  if (operation === null) {
    operation = await insertOperation(
      db,
      authority,
      now,
      new Date(nowDate.getTime() + safetyWindow).toISOString(),
    );
  }
  const operationForRun = operation;

  try {
    return await withPurgeLock(
      db,
      authority.tenant_id,
      operationForRun.id,
      nowDate,
      async (renew) => {
        let currentOperation = operationForRun;
        await renew();
        let plans: PurgePlan[] = [];
        let discoveryError: unknown;
        try {
          plans = await discoverPlans(input.bucket, authority);
        } catch (error) {
          discoveryError = error;
        }

        if (discoveryError !== undefined) {
          const code = errorCode(discoveryError);
          currentOperation = await updateOperation(
            db,
            currentOperation,
            "incomplete",
            now,
            code,
            null,
          );
          const rows = await readObjects(db, currentOperation.id);
          return {
            operation: currentOperation,
            objects: rows.map((row) => lineageFromRows(currentOperation, row)),
          };
        }

        for (const plan of plans) {
          await insertObjectPlan(db, currentOperation, plan, now);
        }
        const rows = await readObjects(db, currentOperation.id);
        const plansByKey = new Map(
          plans.map((plan) => [plan.manifestKey, plan]),
        );
        const processed: ObjectRow[] = [];
        for (const row of rows) {
          await renew();
          const updated = await processObject(
            db,
            input.bucket,
            authority,
            currentOperation,
            row,
            plansByKey.get(String(row.original_manifest_key)),
            nowDate,
            input.hooks,
          );
          processed.push(updated);
        }

        const hasIncomplete = processed.some(
          (row) => row.state === "incomplete",
        );
        const hasPending = processed.some(
          (row) =>
            row.state === "planned" ||
            row.state === "replacement_written" ||
            row.state === "manifest_deleted",
        );
        if (hasIncomplete) {
          currentOperation = await updateOperation(
            db,
            currentOperation,
            "incomplete",
            now,
            "archive_purge_incomplete",
            null,
          );
        } else if (hasPending) {
          const status: ArchivePurgeStatus =
            nowDate.getTime() < Date.parse(currentOperation.safety_deadline)
              ? "pending_deletion"
              : "rewritten";
          currentOperation = await updateOperation(
            db,
            currentOperation,
            status,
            now,
            null,
            null,
          );
        } else {
          currentOperation = await updateOperation(
            db,
            currentOperation,
            "complete",
            now,
            null,
            now,
          );
        }

        const finalRows = await readObjects(db, currentOperation.id);
        return {
          operation: currentOperation,
          objects: finalRows.map((row) =>
            lineageFromRows(currentOperation, row),
          ),
        };
      },
    );
  } catch (error) {
    if (!(error instanceof ArchiveError) || error.code !== "archive_busy") {
      throw error;
    }
    operation = await updateOperation(
      db,
      operation,
      "incomplete",
      now,
      "archive_purge_busy",
      null,
    );
    const rows = await readObjects(db, operation.id);
    return {
      operation,
      objects: rows.map((row) =>
        lineageFromRows(operation as ArchivePurgeOperation, row),
      ),
    };
  }
};

export const runArchivePurge = purgeArchiveForRemoval;
