import {
  RecordRemovalInputSchema,
  RemovalAuthoritySchema,
  RemovalExpiryScheduleSchema,
  ScheduleRemovalExpiryInputSchema,
  type NormalizedRecordRemovalInput,
  type RecordRemovalInput,
  type RemovalAuthority,
  type RemovalExpirySchedule,
  type RemovalResourceType,
  type ScheduleRemovalExpiryInput,
} from "../../../../packages/contracts/src/removals";
import { randomIdentifier } from "../oauth/crypto";

/** The scheduler never holds a lease longer than this before another wakeup can recover it. */
export const REMOVAL_EXPIRY_LEASE_MS = 60_000;
export const MAX_REMOVAL_EXPIRY_BATCH = 100;

type RemovalDatabase = D1Database | D1DatabaseSession;

export type RemovalAuthorityLookup = {
  tenantId: string;
  resourceType: RemovalResourceType | string;
  resourceId: string;
  contentGeneration?: string | number;
  accountId?: string | null;
  conversationId?: string | null;
};

export type RemovalExpiryLookup = {
  tenantId: string;
  resourceType: RemovalResourceType | string;
  resourceId: string;
  contentGeneration?: string | number;
};

type AuthorityRow = {
  id: unknown;
  tenant_id: unknown;
  resource_type: unknown;
  resource_id: unknown;
  content_generation: unknown;
  account_id: unknown;
  conversation_id: unknown;
  source_event_id: unknown;
  source_object_key: unknown;
  reason: unknown;
  removed_at: unknown;
  deletion_epoch: unknown;
  status: unknown;
  purge_status: unknown;
  failure_code: unknown;
  completed_at: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type ScheduleRow = {
  id: unknown;
  tenant_id: unknown;
  resource_type: unknown;
  resource_id: unknown;
  content_generation: unknown;
  account_id: unknown;
  conversation_id: unknown;
  source_event_id: unknown;
  source_object_key: unknown;
  expires_at: unknown;
  status: unknown;
  lease_token: unknown;
  lease_expires_at: unknown;
  removal_id: unknown;
  last_error: unknown;
  created_at: unknown;
  updated_at: unknown;
};

const PRIMARY_CONSISTENCY = "first-primary" as const;

const primarySession = (database: RemovalDatabase): D1DatabaseSession => {
  if ("withSession" in database && typeof database.withSession === "function") {
    return database.withSession(PRIMARY_CONSISTENCY);
  }
  return database as D1DatabaseSession;
};

const timestampFor = (value: Date | undefined): string => {
  const timestamp = (value ?? new Date()).toISOString();
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error("removal timestamp invalid");
  }
  return timestamp;
};

const normalizeGeneration = (value: string | number): string => {
  const parsed =
    RecordRemovalInputSchema.shape.content_generation.safeParse(value);
  if (!parsed.success) throw new Error("removal content generation invalid");
  return parsed.data;
};

const parseAuthority = (row: AuthorityRow | null): RemovalAuthority | null => {
  if (row === null) return null;
  const parsed = RemovalAuthoritySchema.safeParse(row);
  if (!parsed.success) throw new Error("removal authority row invalid");
  return parsed.data;
};

const parseSchedule = (
  row: ScheduleRow | null,
): RemovalExpirySchedule | null => {
  if (row === null) return null;
  const parsed = RemovalExpiryScheduleSchema.safeParse(row);
  if (!parsed.success) throw new Error("removal expiry row invalid");
  return parsed.data;
};

const authorityColumns = `
  id, tenant_id, resource_type, resource_id, content_generation,
  account_id, conversation_id, source_event_id, source_object_key, reason,
  removed_at, deletion_epoch, status, purge_status, failure_code,
  completed_at, created_at, updated_at
`;

const scheduleColumns = `
  id, tenant_id, resource_type, resource_id, content_generation,
  account_id, conversation_id, source_event_id, source_object_key,
  expires_at, status, lease_token, lease_expires_at, removal_id, last_error,
  created_at, updated_at
`;

const readAuthorityById = async (
  db: D1DatabaseSession,
  tenantId: string,
  id: string,
): Promise<RemovalAuthority | null> => {
  const row = await db
    .prepare(
      `SELECT ${authorityColumns} FROM removal_authority WHERE tenant_id = ? AND id = ? LIMIT 1`,
    )
    .bind(tenantId, id)
    .first<AuthorityRow>();
  return parseAuthority(row);
};

export const readRemovalAuthorityById = async (
  database: RemovalDatabase,
  tenantId: string,
  id: string,
): Promise<RemovalAuthority | null> =>
  readAuthorityById(primarySession(database), tenantId, id);

const scopeMatches = (
  authority: RemovalAuthority,
  input: NormalizedRecordRemovalInput,
): boolean =>
  authority.account_id === input.account_id &&
  authority.conversation_id === input.conversation_id;

const buildAuthorityLookup = (
  lookup: RemovalAuthorityLookup,
): { query: string; values: (string | number | null)[] } => {
  const values: (string | number | null)[] = [
    lookup.tenantId,
    lookup.resourceType,
    lookup.resourceId,
  ];
  let query = `SELECT ${authorityColumns}
    FROM removal_authority
    WHERE tenant_id = ? AND resource_type = ? AND resource_id = ?`;

  if (lookup.contentGeneration !== undefined) {
    query += " AND content_generation = ?";
    values.push(normalizeGeneration(lookup.contentGeneration));
  }
  if (lookup.accountId !== undefined) {
    if (lookup.accountId === null) query += " AND account_id IS NULL";
    else {
      query += " AND account_id = ?";
      values.push(lookup.accountId);
    }
  }
  if (lookup.conversationId !== undefined) {
    if (lookup.conversationId === null) query += " AND conversation_id IS NULL";
    else {
      query += " AND conversation_id = ?";
      values.push(lookup.conversationId);
    }
  }
  query += " ORDER BY deletion_epoch DESC, removed_at DESC, id DESC LIMIT 1";
  return { query, values };
};

const readAuthorityForInput = async (
  db: D1DatabaseSession,
  input: NormalizedRecordRemovalInput,
): Promise<RemovalAuthority | null> => {
  const row = await db
    .prepare(`SELECT ${authorityColumns}
      FROM removal_authority
      WHERE tenant_id = ? AND resource_type = ? AND resource_id = ?
        AND content_generation = ?
      LIMIT 1`)
    .bind(
      input.tenant_id,
      input.resource_type,
      input.resource_id,
      input.content_generation,
    )
    .first<AuthorityRow>();
  return parseAuthority(row);
};

/**
 * Record suppression before a projection or delivery can mutate active
 * state.  The unique resource/generation key makes retries converge.  The
 * INSERT ... SELECT allocates the tenant epoch in the same SQLite write as
 * the authority row, so concurrent callers cannot observe a duplicate epoch.
 */
export const recordRemoval = async (
  database: RemovalDatabase,
  input: RecordRemovalInput,
  now?: Date,
): Promise<RemovalAuthority> => {
  const normalized = RecordRemovalInputSchema.parse(input);
  const db = primarySession(database);
  const createdAt = timestampFor(now);
  const removedAt = normalized.removed_at ?? createdAt;
  const id = randomIdentifier("removal");

  await db
    .prepare(
      `INSERT OR IGNORE INTO removal_authority (
        id, tenant_id, resource_type, resource_id, content_generation,
        account_id, conversation_id, source_event_id, source_object_key,
        reason, removed_at, deletion_epoch, status, purge_status,
        failure_code, completed_at, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        COALESCE(MAX(deletion_epoch), 0) + 1,
        'active', 'not_started', NULL, NULL, ?, ?
      FROM removal_authority
      WHERE tenant_id = ?`,
    )
    .bind(
      id,
      normalized.tenant_id,
      normalized.resource_type,
      normalized.resource_id,
      normalized.content_generation,
      normalized.account_id,
      normalized.conversation_id,
      normalized.source_event_id,
      normalized.source_object_key,
      normalized.reason,
      removedAt,
      createdAt,
      createdAt,
      normalized.tenant_id,
    )
    .run();

  const authority = await readAuthorityForInput(db, normalized);
  if (authority === null) throw new Error("removal authority was not recorded");
  if (!scopeMatches(authority, normalized)) {
    throw new Error("removal authority scope conflict");
  }
  return authority;
};

/** Alias named after the durable table for callers that prefer the domain term. */
export const recordRemovalAuthority = recordRemoval;

export const readRemovalAuthority = async (
  database: RemovalDatabase,
  lookup: RemovalAuthorityLookup,
): Promise<RemovalAuthority | null> => {
  const db = primarySession(database);
  const { query, values } = buildAuthorityLookup(lookup);
  const row = await db
    .prepare(query)
    .bind(...values)
    .first<AuthorityRow>();
  return parseAuthority(row);
};

/** Alias for reads that describe the resource rather than the ledger row. */
export const readRemovalForResource = readRemovalAuthority;

export const listRemovalAuthorities = async (
  database: RemovalDatabase,
  tenantId: string,
): Promise<RemovalAuthority[]> => {
  const db = primarySession(database);
  const rows = await db
    .prepare(
      `SELECT ${authorityColumns}
       FROM removal_authority
       WHERE tenant_id = ?
       ORDER BY deletion_epoch ASC, id ASC`,
    )
    .bind(tenantId)
    .all<AuthorityRow>();
  return rows.results.map((row) => {
    const parsed = parseAuthority(row);
    if (parsed === null) throw new Error("removal authority row missing");
    return parsed;
  });
};

/** Read a bounded cross-tenant page for scheduled controlled-copy work. */
export const listAllRemovalAuthorities = async (
  database: RemovalDatabase,
  limit = MAX_REMOVAL_EXPIRY_BATCH,
): Promise<RemovalAuthority[]> => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error("removal authority page limit invalid");
  }
  const db = primarySession(database);
  const rows = await db
    .prepare(
      `SELECT ${authorityColumns}
       FROM removal_authority
       ORDER BY updated_at ASC, id ASC
       LIMIT ?`,
    )
    .bind(limit)
    .all<AuthorityRow>();
  return rows.results.map((row) => {
    const parsed = parseAuthority(row);
    if (parsed === null) throw new Error("removal authority row missing");
    return parsed;
  });
};

export const readTenantDeletionEpoch = async (
  database: RemovalDatabase,
  tenantId: string,
): Promise<number> => {
  const db = primarySession(database);
  const row = await db
    .prepare(
      "SELECT COALESCE(MAX(deletion_epoch), 0) AS deletion_epoch FROM removal_authority WHERE tenant_id = ?",
    )
    .bind(tenantId)
    .first<{ deletion_epoch: unknown }>();
  const epoch = row?.deletion_epoch;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error("removal epoch invalid");
  }
  return epoch;
};

export const markRemovalSuppressionComplete = async (
  database: RemovalDatabase,
  tenantId: string,
  removalId: string,
  completedAt?: Date,
): Promise<RemovalAuthority | null> => {
  const db = primarySession(database);
  const timestamp = timestampFor(completedAt);
  await db
    .prepare(
      `UPDATE removal_authority
       SET status = 'completed', completed_at = COALESCE(completed_at, ?),
           failure_code = NULL, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    )
    .bind(timestamp, timestamp, tenantId, removalId)
    .run();
  return readAuthorityById(db, tenantId, removalId);
};

export const markRemovalFailed = async (
  database: RemovalDatabase,
  tenantId: string,
  removalId: string,
  failureCode: string,
  updatedAt?: Date,
): Promise<RemovalAuthority | null> => {
  const code = failureCode.trim().slice(0, 512);
  if (code.length === 0) throw new Error("removal failure code required");
  const db = primarySession(database);
  const timestamp = timestampFor(updatedAt);
  await db
    .prepare(
      `UPDATE removal_authority
       SET status = 'failed', failure_code = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    )
    .bind(code, timestamp, tenantId, removalId)
    .run();
  return readAuthorityById(db, tenantId, removalId);
};

/** A removal remains authoritative after active redaction reports completion. */
export const removalMatchesGeneration = (
  authority: RemovalAuthority | null,
  contentGeneration: string | number,
): boolean =>
  authority !== null &&
  authority.content_generation === normalizeGeneration(contentGeneration);

/**
 * Schedule expiry without creating a second source of truth.  Duplicate
 * schedules return the original row and therefore cannot move a deadline
 * forward or allocate another deletion epoch.
 */
export const scheduleRemovalExpiry = async (
  database: RemovalDatabase,
  input: ScheduleRemovalExpiryInput,
  now?: Date,
): Promise<RemovalExpirySchedule> => {
  const normalized = ScheduleRemovalExpiryInputSchema.parse(input);
  const db = primarySession(database);
  const timestamp = timestampFor(now);
  const id = randomIdentifier("removal_expiry");

  await db
    .prepare(
      `INSERT OR IGNORE INTO removal_expiry_schedule (
        id, tenant_id, resource_type, resource_id, content_generation,
        account_id, conversation_id, source_event_id, source_object_key,
        expires_at, status, lease_token, lease_expires_at, removal_id,
        last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', NULL, NULL, NULL, NULL, ?, ?)`,
    )
    .bind(
      id,
      normalized.tenant_id,
      normalized.resource_type,
      normalized.resource_id,
      normalized.content_generation,
      normalized.account_id,
      normalized.conversation_id,
      normalized.source_event_id,
      normalized.source_object_key,
      normalized.expires_at,
      timestamp,
      timestamp,
    )
    .run();

  const row = await db
    .prepare(
      `SELECT ${scheduleColumns}
       FROM removal_expiry_schedule
       WHERE tenant_id = ? AND resource_type = ? AND resource_id = ?
         AND content_generation = ?
       LIMIT 1`,
    )
    .bind(
      normalized.tenant_id,
      normalized.resource_type,
      normalized.resource_id,
      normalized.content_generation,
    )
    .first<ScheduleRow>();
  const schedule = parseSchedule(row);
  if (schedule === null) throw new Error("removal expiry was not scheduled");
  if (
    schedule.account_id !== normalized.account_id ||
    schedule.conversation_id !== normalized.conversation_id
  ) {
    throw new Error("removal expiry scope conflict");
  }
  return schedule;
};

export const readRemovalExpiry = async (
  database: RemovalDatabase,
  lookup: RemovalExpiryLookup,
): Promise<RemovalExpirySchedule | null> => {
  const db = primarySession(database);
  const values: (string | number)[] = [
    lookup.tenantId,
    lookup.resourceType,
    lookup.resourceId,
  ];
  let query = `SELECT ${scheduleColumns}
    FROM removal_expiry_schedule
    WHERE tenant_id = ? AND resource_type = ? AND resource_id = ?`;
  if (lookup.contentGeneration !== undefined) {
    query += " AND content_generation = ?";
    values.push(normalizeGeneration(lookup.contentGeneration));
  }
  query += " ORDER BY expires_at ASC, id ASC LIMIT 1";
  const row = await db
    .prepare(query)
    .bind(...values)
    .first<ScheduleRow>();
  return parseSchedule(row);
};

export type RemovalExpiryTickResult = {
  claimed: number;
  completed: RemovalAuthority[];
  failed: Array<{ schedule_id: string; error: string }>;
};

const errorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 1_024) || "removal expiry failed";
};

/**
 * Claim due expiry rows, record through the authority, then acknowledge the
 * wakeup.  Expired leases are reclaimable, so a process crash cannot strand a
 * resource in `processing` forever.
 */
export const runRemovalExpiryTick = async (
  database: RemovalDatabase,
  now = new Date(),
  limit = MAX_REMOVAL_EXPIRY_BATCH,
): Promise<RemovalExpiryTickResult> => {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_REMOVAL_EXPIRY_BATCH
  ) {
    throw new Error("removal expiry batch limit invalid");
  }
  const db = primarySession(database);
  const nowIso = timestampFor(now);
  const leaseUntil = new Date(now.getTime() + REMOVAL_EXPIRY_LEASE_MS);
  const leaseUntilIso = timestampFor(leaseUntil);
  const rows = await db
    .prepare(
      `SELECT ${scheduleColumns}
       FROM removal_expiry_schedule
       WHERE expires_at <= ? AND (
         status IN ('scheduled', 'failed') OR
         (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
       )
       ORDER BY expires_at ASC, id ASC
       LIMIT ?`,
    )
    .bind(nowIso, nowIso, limit)
    .all<ScheduleRow>();

  const result: RemovalExpiryTickResult = {
    claimed: 0,
    completed: [],
    failed: [],
  };

  for (const candidate of rows.results) {
    const schedule = parseSchedule(candidate);
    if (schedule === null) throw new Error("removal expiry row missing");
    const leaseToken = randomIdentifier("removal_lease");
    const claim = await db
      .prepare(
        `UPDATE removal_expiry_schedule
         SET status = 'processing', lease_token = ?, lease_expires_at = ?,
             last_error = NULL, updated_at = ?
         WHERE id = ? AND expires_at <= ? AND (
           status IN ('scheduled', 'failed') OR
           (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
         )`,
      )
      .bind(leaseToken, leaseUntilIso, nowIso, schedule.id, nowIso, nowIso)
      .run();
    if ((claim.meta.changes ?? 0) !== 1) continue;
    result.claimed += 1;

    try {
      const authority = await recordRemoval(
        db,
        {
          tenant_id: schedule.tenant_id,
          resource_type: schedule.resource_type,
          resource_id: schedule.resource_id,
          content_generation: schedule.content_generation,
          account_id: schedule.account_id,
          conversation_id: schedule.conversation_id,
          source_event_id: schedule.source_event_id,
          source_object_key: schedule.source_object_key,
          reason: "expired",
          // The expiry instant is the removal instant even if the scheduler was
          // asleep and wakes later. This keeps replay cutoffs deterministic.
          removed_at: schedule.expires_at,
        },
        now,
      );
      await db
        .prepare(
          `UPDATE removal_expiry_schedule
           SET status = 'completed', removal_id = ?, lease_token = NULL,
               lease_expires_at = NULL, last_error = NULL, updated_at = ?
           WHERE id = ? AND lease_token = ?`,
        )
        .bind(authority.id, nowIso, schedule.id, leaseToken)
        .run();
      result.completed.push(authority);
    } catch (error) {
      const message = errorMessage(error);
      await db
        .prepare(
          `UPDATE removal_expiry_schedule
           SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
               last_error = ?, updated_at = ?
           WHERE id = ? AND lease_token = ?`,
        )
        .bind(message, nowIso, schedule.id, leaseToken)
        .run();
      result.failed.push({ schedule_id: schedule.id, error: message });
    }
  }
  return result;
};
