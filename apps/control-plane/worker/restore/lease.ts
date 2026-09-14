import { CommunicatorIdSchema } from "@communicator/contracts";
import { randomIdentifier } from "../oauth/crypto";

type RestoreLeaseDatabase = D1Database | D1DatabaseSession;

export const RESTORE_ACTIVATION_LEASE_TTL_MS = 10 * 60 * 1_000;
export const RESTORE_ACTIVATION_LEASE_MAX_TTL_MS = 15 * 60 * 1_000;

export type RestoreActivationLease = {
  lease_id: string;
  tenant_id: string;
  lease_token: string;
  deletion_epoch: number;
  ledger_head: string;
  expires_at: string;
};

type RestoreActivationLeaseRow = {
  id: unknown;
  tenant_id: unknown;
  lease_token_hash: unknown;
  deletion_epoch: unknown;
  ledger_head: unknown;
  expires_at: unknown;
  status: unknown;
};

const primaryDatabase = (database: RestoreLeaseDatabase): D1DatabaseSession => {
  if ("withSession" in database && typeof database.withSession === "function") {
    return database.withSession("first-primary");
  }
  return database as D1DatabaseSession;
};

const timestampFor = (value: Date): string => {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("restore activation lease clock is invalid");
  }
  return value.toISOString();
};

const positiveEpoch = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("restore activation lease epoch is invalid");
  }
  return value;
};

const boundedTtl = (value: number | undefined): number => {
  const ttl = value ?? RESTORE_ACTIVATION_LEASE_TTL_MS;
  if (
    !Number.isSafeInteger(ttl) ||
    ttl < 1_000 ||
    ttl > RESTORE_ACTIVATION_LEASE_MAX_TTL_MS
  ) {
    throw new Error("restore activation lease ttl is invalid");
  }
  return ttl;
};

const requiredText = (value: string, name: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 256) {
    throw new Error(`restore activation lease ${name} is invalid`);
  }
  return trimmed;
};

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const tokenHash = (token: string): Promise<string> => sha256Hex(token);

const leaseFromRow = (
  row: RestoreActivationLeaseRow | null,
): RestoreActivationLeaseRow | null => {
  if (row === null) return null;
  if (
    typeof row.id !== "string" ||
    typeof row.tenant_id !== "string" ||
    typeof row.lease_token_hash !== "string" ||
    typeof row.deletion_epoch !== "number" ||
    !Number.isSafeInteger(row.deletion_epoch) ||
    row.deletion_epoch < 0 ||
    typeof row.ledger_head !== "string" ||
    typeof row.expires_at !== "string" ||
    row.status !== "active"
  ) {
    throw new Error("restore activation lease row is invalid");
  }
  return row;
};

export const restoreActivationLeaseIsActive = async (
  database: RestoreLeaseDatabase,
  tenantId: string,
  now = new Date(),
): Promise<boolean> => {
  const tenant = CommunicatorIdSchema.parse(tenantId);
  const timestamp = timestampFor(now);
  const row = await primaryDatabase(database)
    .prepare(
      `SELECT id, tenant_id, lease_token_hash, deletion_epoch, ledger_head,
              expires_at, status
       FROM restore_activation_leases
       WHERE tenant_id = ? AND status = 'active' AND expires_at > ?
       LIMIT 1`,
    )
    .bind(tenant, timestamp)
    .first<RestoreActivationLeaseRow>();
  return leaseFromRow(row) !== null;
};

/** Acquire a tenant-wide write fence at one observed removal epoch. */
export const acquireRestoreActivationLease = async (
  database: RestoreLeaseDatabase,
  input: {
    tenantId: string;
    leaseId: string;
    expectedDeletionEpoch: number;
    expectedLedgerHead: string;
    now?: Date;
    ttlMs?: number;
  },
): Promise<RestoreActivationLease> => {
  const tenant = CommunicatorIdSchema.parse(input.tenantId);
  const leaseId = CommunicatorIdSchema.parse(input.leaseId);
  const expectedDeletionEpoch = positiveEpoch(input.expectedDeletionEpoch);
  const expectedLedgerHead = requiredText(
    input.expectedLedgerHead,
    "ledger head",
  );
  const now = input.now ?? new Date();
  const nowIso = timestampFor(now);
  const expiresAt = new Date(now.getTime() + boundedTtl(input.ttlMs));
  const expiresAtIso = timestampFor(expiresAt);
  const leaseToken = randomIdentifier("restore_token");
  const hash = await tokenHash(leaseToken);
  const databaseSession = primaryDatabase(database);

  await databaseSession
    .prepare(
      `UPDATE restore_activation_leases
       SET status = 'expired', updated_at = ?
       WHERE tenant_id = ? AND status = 'active' AND expires_at <= ?`,
    )
    .bind(nowIso, tenant, nowIso)
    .run();

  const inserted = await databaseSession
    .prepare(
      `INSERT INTO restore_activation_leases (
         id, tenant_id, lease_token_hash, deletion_epoch, ledger_head,
         expires_at, status, created_at, updated_at
       )
       SELECT ?, ?, ?, current_epoch, ?, ?, 'active', ?, ?
       FROM (
         SELECT COALESCE(MAX(deletion_epoch), 0) AS current_epoch
         FROM removal_authority
         WHERE tenant_id = ?
       ) current
       WHERE current.current_epoch = ?
         AND NOT EXISTS (
           SELECT 1
           FROM restore_activation_leases
           WHERE tenant_id = ? AND status = 'active' AND expires_at > ?
         )`,
    )
    .bind(
      leaseId,
      tenant,
      hash,
      expectedLedgerHead,
      expiresAtIso,
      nowIso,
      nowIso,
      tenant,
      expectedDeletionEpoch,
      tenant,
      nowIso,
    )
    .run();
  if ((inserted.meta.changes ?? 0) !== 1) {
    const active = await restoreActivationLeaseIsActive(
      databaseSession,
      tenant,
      now,
    );
    if (active) throw new Error("restore activation lease already active");
    const current = await databaseSession
      .prepare(
        "SELECT COALESCE(MAX(deletion_epoch), 0) AS deletion_epoch FROM removal_authority WHERE tenant_id = ?",
      )
      .bind(tenant)
      .first<{ deletion_epoch: unknown }>();
    if (
      typeof current?.deletion_epoch !== "number" ||
      current.deletion_epoch !== expectedDeletionEpoch
    ) {
      throw new Error("restore authority changed before activation lease");
    }
    throw new Error("restore activation lease was not acquired");
  }
  return {
    lease_id: leaseId,
    tenant_id: tenant,
    lease_token: leaseToken,
    deletion_epoch: expectedDeletionEpoch,
    ledger_head: expectedLedgerHead,
    expires_at: expiresAtIso,
  };
};

export const renewRestoreActivationLease = async (
  database: RestoreLeaseDatabase,
  input: {
    tenantId: string;
    leaseId: string;
    leaseToken: string;
    now?: Date;
    ttlMs?: number;
  },
): Promise<boolean> => {
  const tenant = CommunicatorIdSchema.parse(input.tenantId);
  const leaseId = CommunicatorIdSchema.parse(input.leaseId);
  const now = input.now ?? new Date();
  const nowIso = timestampFor(now);
  const expiresAtIso = timestampFor(
    new Date(now.getTime() + boundedTtl(input.ttlMs)),
  );
  const result = await primaryDatabase(database)
    .prepare(
      `UPDATE restore_activation_leases
       SET expires_at = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND status = 'active'
         AND lease_token_hash = ? AND expires_at > ?`,
    )
    .bind(
      expiresAtIso,
      nowIso,
      tenant,
      leaseId,
      await tokenHash(input.leaseToken),
      nowIso,
    )
    .run();
  return (result.meta.changes ?? 0) === 1;
};

/**
 * Revalidate the identity and authority binding at the DO completion
 * boundary.  The caller must renew the same active token immediately before
 * the DO publishes a rebuilt generation; a released, expired, or replaced
 * lease cannot authorize readiness.
 */
export const renewRestoreActivationLeaseForCompletion = async (
  database: RestoreLeaseDatabase,
  input: {
    tenantId: string;
    leaseId: string;
    leaseToken: string;
    expectedDeletionEpoch: number;
    expectedLedgerHead: string;
    now?: Date;
  },
): Promise<boolean> => {
  const tenant = CommunicatorIdSchema.parse(input.tenantId);
  const leaseId = CommunicatorIdSchema.parse(input.leaseId);
  const expectedDeletionEpoch = positiveEpoch(input.expectedDeletionEpoch);
  const expectedLedgerHead = requiredText(
    input.expectedLedgerHead,
    "ledger head",
  );
  const now = input.now ?? new Date();
  const nowIso = timestampFor(now);
  const expiresAtIso = timestampFor(
    new Date(now.getTime() + RESTORE_ACTIVATION_LEASE_MAX_TTL_MS),
  );
  const result = await primaryDatabase(database)
    .prepare(
      `UPDATE restore_activation_leases
       SET expires_at = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND status = 'active'
         AND lease_token_hash = ? AND expires_at > ?
         AND deletion_epoch = ? AND ledger_head = ?`,
    )
    .bind(
      expiresAtIso,
      nowIso,
      tenant,
      leaseId,
      await tokenHash(input.leaseToken),
      nowIso,
      expectedDeletionEpoch,
      expectedLedgerHead,
    )
    .run();
  return (result.meta.changes ?? 0) === 1;
};

export const releaseRestoreActivationLease = async (
  database: RestoreLeaseDatabase,
  input: {
    tenantId: string;
    leaseId: string;
    leaseToken: string;
    now?: Date;
  },
): Promise<boolean> => {
  const tenant = CommunicatorIdSchema.parse(input.tenantId);
  const leaseId = CommunicatorIdSchema.parse(input.leaseId);
  const nowIso = timestampFor(input.now ?? new Date());
  const result = await primaryDatabase(database)
    .prepare(
      `UPDATE restore_activation_leases
       SET status = 'released', updated_at = ?
       WHERE tenant_id = ? AND id = ? AND status = 'active'
         AND lease_token_hash = ?`,
    )
    .bind(nowIso, tenant, leaseId, await tokenHash(input.leaseToken))
    .run();
  return (result.meta.changes ?? 0) === 1;
};
