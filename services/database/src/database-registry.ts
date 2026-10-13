import { DurableObject } from "cloudflare:workers";
import {
  ApiFault,
  errorOutcome,
  type DatabaseBindings,
  type DatabaseResource,
  type DurableCallOutcome,
} from "./database-object";
import {
  CREATE_LOGICAL_RESERVATION_BYTES,
  MUTATION_LOGICAL_RESERVATION_BYTES,
  MUTATION_REPLAY_RESERVATION_BYTES,
  type AdmissionKind,
  type AdmissionReservation,
  type DatabaseUsage,
  type ExportReservation,
  type ServiceClock,
} from "./global-admission";
import {
  capacityPolicyFingerprint,
  parseCapacityPolicy,
  type CapacityPolicy,
} from "./capacity-policy";
import { EXPORT_MAX_PER_DATABASE, EXPORT_MAX_SNAPSHOT_BYTES } from "./export";

const WRITE_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const CREATE_REPLAY_MS = 24 * 60 * 60 * 1_000;
const CREATE_LEASE_MS = 30 * 1_000;
const RESERVATION_RECONCILE_MS = 5 * 60 * 1_000;
const GLOBAL_REQUEST_RETENTION_MS = 48 * 60 * 60 * 1_000;
const GLOBAL_MUTATION_REPLAY_MS = 24 * 60 * 60 * 1_000;
const TOMBSTONE_RETENTION_MS = CREATE_REPLAY_MS + 60 * 60 * 1_000;
const LEGACY_LOGICAL_RESERVATION_BYTES = 10 * 1024 * 1024;
const LEGACY_REPLAY_RESERVATION_BYTES = 51 * 1024 * 1024;
const REGISTRY_ALARM_INTERVAL_MS = 60 * 1_000;

type CreateIntent = {
  databaseId: string;
  databaseUrl: string;
  name: string;
  description: string;
  createdAt: number;
  writeUntil: number;
};

type ReservationRow = {
  key_digest: string;
  request_fingerprint: string;
  database_id: string;
  intent_json: string;
  result_json: string | null;
  expires_at: number | null;
  lease_token: string | null;
  lease_until: number | null;
};

type PolicyRow = {
  singleton: number;
  revision: number;
  fingerprint: string;
  suspended: number;
  suspended_since: number | null;
  paused_total_ms: number;
};

type CapacityRow = {
  database_id: string;
  creation_key_digest: string;
  status: "creating" | "active" | "retiring" | "deleted";
  lease_token: string | null;
  lease_until: number | null;
  logical_bytes: number;
  replay_bytes: number;
  physical_bytes: number;
  usage_version: number;
  physical_reserved_bytes: number;
  created_at: number;
  deleted_at: number | null;
};

type MutationReservationRow = {
  database_id: string;
  operation_key: string;
  operation_fingerprint: string;
  logical_bytes: number;
  replay_bytes: number;
  state: "pending" | "settled";
  reserved_at: number;
  expires_at: number | null;
};

type ExportReservationRow = {
  database_id: string;
  export_key: string;
  export_id: string;
  snapshot_bytes: number;
  expires_at: number;
  state: "pending" | "active";
  reserved_at: number;
};

type CreateReservation = {
  intent: CreateIntent;
  leaseToken?: string;
  result?: DatabaseResource;
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function randomSlug(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string") throw new ApiFault("VALIDATION_ERROR", 400);
  const name = value.trim();
  if (!name || new TextEncoder().encode(name).byteLength > 256)
    throw new ApiFault("VALIDATION_ERROR", 400);
  return name;
}

function normalizeDescription(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 1_000)
    throw new ApiFault("VALIDATION_ERROR", 400);
  return value;
}

function normalizeKey(value: string | null): string {
  if (
    value === null ||
    value.length < 22 ||
    value.length > 128 ||
    value.trim() !== value
  ) {
    throw new ApiFault("VALIDATION_ERROR", 400);
  }
  return value;
}

function faultFromOutcome<T>(
  outcome: Extract<DurableCallOutcome<T>, { ok: false }>,
): ApiFault {
  return new ApiFault(
    outcome.body.error.code,
    outcome.status,
    outcome.body.error.details,
  );
}

export class DatabaseRegistry extends DurableObject<DatabaseBindings> {
  constructor(ctx: DurableObjectState, env: DatabaseBindings) {
    super(ctx, env);
    this.migrate();
  }

  async createDatabase(
    input: unknown,
    rawKey: string | null,
    origin: string,
  ): Promise<DatabaseResource> {
    await this.scheduleAlarm();
    const preflight = await this.getServiceClock();
    if (!preflight.ok) throw faultFromOutcome(preflight);
    this.assertNotSuspended(preflight.result);
    if (typeof input !== "object" || input === null || Array.isArray(input))
      throw new ApiFault("VALIDATION_ERROR", 400);
    const raw = input as Record<string, unknown>;
    if (Object.keys(raw).some((key) => !["name", "description"].includes(key)))
      throw new ApiFault("VALIDATION_ERROR", 400);
    const normalized = {
      name: normalizeName(raw.name),
      description: normalizeDescription(raw.description),
    };
    const key = normalizeKey(rawKey);
    const keyDigest = await digest(key);
    const requestFingerprint = await digest(stable(normalized));
    const reservation = this.reserve(
      keyDigest,
      requestFingerprint,
      normalized,
      origin,
    );
    await this.scheduleAlarm(CREATE_LEASE_MS);
    const capacity = await this.reserveDatabase({
      databaseId: reservation.intent.databaseId,
      creationKeyDigest: keyDigest,
      leaseToken: reservation.leaseToken ?? "completed",
    });
    if (!capacity.ok) throw faultFromOutcome(capacity);
    const databaseNamespace = this.env.DATABASES;
    const id = databaseNamespace.idFromName(reservation.intent.databaseId);
    const stub = databaseNamespace.get(id) as unknown as {
      ensureCreated: (
        input: CreateIntent,
        creationKeyDigest: string,
        leaseToken: string,
      ) => Promise<DurableCallOutcome<DatabaseResource>>;
      isInitialized: () => Promise<DurableCallOutcome<boolean>>;
      getUsage: () => Promise<DurableCallOutcome<DatabaseUsage>>;
    };
    if (reservation.result) {
      const serving = await this.isDatabaseServing(
        reservation.intent.databaseId,
      );
      if (!serving.ok) throw faultFromOutcome(serving);
      if (!serving.result)
        throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
          reason: "databaseRetired",
        });
      const initialized = await stub.isInitialized();
      if (!initialized.ok) throw faultFromOutcome(initialized);
      if (!initialized.result)
        throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
          reason: "databaseStateUnavailable",
        });
      return reservation.result;
    }
    try {
      const initialized = await stub.ensureCreated(
        reservation.intent,
        keyDigest,
        reservation.leaseToken!,
      );
      if (!initialized.ok) throw faultFromOutcome(initialized);
      const measured = await stub.getUsage();
      if (!measured.ok) throw faultFromOutcome(measured);
      const completedCapacity = await this.completeDatabase(
        reservation.intent.databaseId,
        measured.result,
        reservation.leaseToken!,
      );
      if (!completedCapacity.ok) throw faultFromOutcome(completedCapacity);
      return this.complete(
        keyDigest,
        requestFingerprint,
        reservation.leaseToken!,
        initialized.result,
      );
    } catch (error) {
      this.releaseLease(keyDigest, reservation.leaseToken!);
      throw error;
    }
  }

  async createDatabaseOutcome(
    input: unknown,
    rawKey: string | null,
    origin: string,
  ): Promise<DurableCallOutcome<DatabaseResource>> {
    try {
      return {
        ok: true,
        result: await this.createDatabase(input, rawKey, origin),
      };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async admitRequest(
    kind: AdmissionKind,
    requestId: string,
  ): Promise<DurableCallOutcome<ServiceClock>> {
    try {
      await this.scheduleAlarm();
      return {
        ok: true,
        result: this.withPolicy((policy, clock) => {
          this.assertNotSuspended(clock);
          if (
            typeof requestId !== "string" ||
            requestId.length < 1 ||
            requestId.length > 128 ||
            (kind !== "http" && kind !== "mcp_tool")
          )
            throw new ApiFault("VALIDATION_ERROR", 400);
          const sql = this.ctx.storage.sql;
          const now = Date.now();
          sql.exec(
            "DELETE FROM admission_requests WHERE request_at < ?",
            now - GLOBAL_REQUEST_RETENTION_MS,
          );
          const existing = sql
            .exec<{ kind: AdmissionKind }>(
              "SELECT kind FROM admission_requests WHERE request_id = ?",
              requestId,
            )
            .toArray()[0];
          if (existing) return clock;
          const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
          const daily =
            sql
              .exec<{ count: number }>(
                "SELECT COUNT(*) AS count FROM admission_requests WHERE request_at >= ?",
                dayStart,
              )
              .toArray()[0]?.count ?? 0;
          const minute =
            sql
              .exec<{ count: number }>(
                "SELECT COUNT(*) AS count FROM admission_requests WHERE request_at > ?",
                now - 60_000,
              )
              .toArray()[0]?.count ?? 0;
          if (daily >= policy.maxDailyRequests)
            throw new ApiFault("QUOTA_EXCEEDED", 429, {
              quota: "globalDailyRequests",
              limit: policy.maxDailyRequests,
            });
          if (minute >= policy.maxRequestsPerMinute)
            throw new ApiFault("QUOTA_EXCEEDED", 429, {
              quota: "globalRequestsPerMinute",
              limit: policy.maxRequestsPerMinute,
            });
          sql.exec(
            "INSERT INTO admission_requests (request_id, kind, request_at) VALUES (?, ?, ?)",
            requestId,
            kind,
            now,
          );
          this.assertControlStore(policy);
          return clock;
        }),
      };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async getServiceClock(): Promise<DurableCallOutcome<ServiceClock>> {
    try {
      return { ok: true, result: this.withPolicy((_policy, clock) => clock) };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async isDatabaseServing(
    databaseId: string,
  ): Promise<DurableCallOutcome<boolean>> {
    try {
      return {
        ok: true,
        result: this.withPolicy((_policy, clock) => {
          if (clock.suspended) return false;
          const row = this.capacityRow(databaseId);
          return row?.status === "active";
        }),
      };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async reserveDatabase(input: {
    databaseId: string;
    creationKeyDigest: string;
    leaseToken: string;
  }): Promise<DurableCallOutcome<ServiceClock>> {
    try {
      await this.scheduleAlarm();
      return {
        ok: true,
        result: this.withPolicy((policy, clock) => {
          this.assertNotSuspended(clock);
          const sql = this.ctx.storage.sql;
          const existing = this.capacityRow(input.databaseId);
          const creation = sql
            .exec<ReservationRow>(
              "SELECT * FROM create_reservations WHERE database_id = ?",
              input.databaseId,
            )
            .toArray()[0];
          if (!creation || creation.key_digest !== input.creationKeyDigest)
            throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
              reason: "creationReservationExpired",
            });
          const now = Date.now();
          if (existing) {
            if (existing.creation_key_digest !== input.creationKeyDigest)
              throw new ApiFault("IDEMPOTENCY_CONFLICT", 409);
            if (existing.status === "deleted" || existing.status === "retiring")
              throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
                reason: "databaseRetired",
              });
            if (creation.result_json !== null) {
              if (existing.status !== "active")
                throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
                  reason: "databaseStateUnavailable",
                });
              return clock;
            }
            if (
              (creation.expires_at !== null && creation.expires_at <= now) ||
              creation.lease_token !== input.leaseToken ||
              creation.lease_until === null ||
              creation.lease_until <= now
            )
              throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
                reason: "creationReservationExpired",
              });
            if (existing.status === "creating")
              sql.exec(
                `UPDATE database_capacity SET lease_token = ?, lease_until = ?
                 WHERE database_id = ? AND status = 'creating'`,
                input.leaseToken,
                now + CREATE_LEASE_MS,
                input.databaseId,
              );
            this.assertControlStore(policy);
            return clock;
          }
          if (
            creation.result_json !== null ||
            creation.lease_token !== input.leaseToken ||
            creation.lease_until === null ||
            creation.lease_until <= now ||
            (creation.expires_at !== null && creation.expires_at <= now)
          )
            throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
              reason: "creationReservationExpired",
            });
          const aggregate = this.aggregateUsage();
          const count = this.activeDatabaseCount();
          if (count >= policy.maxDatabases)
            throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
              quota: "databases",
              limit: policy.maxDatabases,
            });
          if (
            aggregate.logicalBytes + CREATE_LOGICAL_RESERVATION_BYTES >
            policy.maxLogicalBytes
          )
            throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
              quota: "globalLogicalBytes",
            });
          if (
            aggregate.physicalReservedBytes +
              policy.maxPhysicalBytesPerDatabase >
            policy.maxPhysicalBytes
          )
            throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
              quota: "globalPhysicalBytes",
            });
          sql.exec(
            `INSERT INTO database_capacity
              (database_id, creation_key_digest, status, lease_token, lease_until,
               logical_bytes, replay_bytes, physical_bytes, physical_reserved_bytes,
               created_at, deleted_at)
             VALUES (?, ?, 'creating', ?, ?, ?, 0, 0, ?, ?, NULL)`,
            input.databaseId,
            input.creationKeyDigest,
            input.leaseToken,
            now + CREATE_LEASE_MS,
            CREATE_LOGICAL_RESERVATION_BYTES,
            policy.maxPhysicalBytesPerDatabase,
            now,
          );
          this.assertControlStore(policy);
          return clock;
        }),
      };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async authorizeDatabaseCreation(input: {
    databaseId: string;
    creationKeyDigest: string;
    leaseToken: string;
  }): Promise<DurableCallOutcome<ServiceClock & { mayInitialize: boolean }>> {
    try {
      return {
        ok: true,
        result: this.withPolicy((policy, clock) => {
          this.assertNotSuspended(clock);
          const row = this.capacityRow(input.databaseId);
          const reservation = this.ctx.storage.sql
            .exec<ReservationRow>(
              "SELECT * FROM create_reservations WHERE database_id = ?",
              input.databaseId,
            )
            .toArray()[0];
          if (
            !row ||
            row.creation_key_digest !== input.creationKeyDigest ||
            (row.status !== "creating" && row.status !== "active") ||
            !reservation ||
            reservation.key_digest !== input.creationKeyDigest ||
            reservation.result_json !== null ||
            reservation.lease_token !== input.leaseToken ||
            reservation.lease_until === null ||
            reservation.lease_until <= Date.now() ||
            (reservation.expires_at !== null &&
              reservation.expires_at <= Date.now())
          )
            throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
              reason: "creationReservationExpired",
            });
          if (row.status === "active")
            return { ...clock, mayInitialize: false };
          if (row.lease_token !== input.leaseToken)
            throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
              reason: "creationReservationExpired",
            });
          this.assertControlStore(policy);
          return { ...clock, mayInitialize: true };
        }),
      };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async completeDatabase(
    databaseId: string,
    usage: DatabaseUsage,
    leaseToken: string,
  ): Promise<DurableCallOutcome<void>> {
    try {
      const result = this.withPolicy((policy, _clock) => {
        const row = this.capacityRow(databaseId);
        if (!row || row.status === "deleted" || row.status === "retiring")
          throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
            reason: "databaseRetired",
          });
        if (row.status === "creating") {
          const reservation = this.ctx.storage.sql
            .exec<{ lease_token: string | null; lease_until: number | null }>(
              "SELECT lease_token, lease_until FROM create_reservations WHERE database_id = ?",
              databaseId,
            )
            .toArray()[0];
          if (
            row.lease_token !== leaseToken ||
            reservation?.lease_token !== leaseToken ||
            reservation.lease_until === null ||
            reservation.lease_until <= Date.now()
          )
            throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
              reason: "creationReservationExpired",
            });
        }
        this.writeUsage(databaseId, usage, true);
        if (usage.physicalBytes > policy.maxPhysicalBytesPerDatabase)
          throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
            quota: "physicalBytesPerDatabase",
          });
        const aggregate = this.aggregateUsage();
        if (
          aggregate.logicalBytes > policy.maxLogicalBytes ||
          aggregate.replayBytes > policy.maxReplayBytes ||
          aggregate.physicalReservedBytes > policy.maxPhysicalBytes
        )
          throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
            reason: "capacityPolicyBelowCurrentUsage",
          });
        this.assertControlStore(policy);
      });
      return { ok: true, result };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async reportDatabaseUsage(
    databaseId: string,
    usage: DatabaseUsage,
  ): Promise<DurableCallOutcome<void>> {
    try {
      return {
        ok: true,
        result: this.withPolicy(() => {
          const row = this.capacityRow(databaseId);
          if (!row || row.status === "deleted")
            throw new ApiFault("CAPACITY_UNAVAILABLE", 503);
          this.writeUsage(databaseId, usage);
        }),
      };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async getDatabaseUsage(
    databaseId: string,
  ): Promise<DurableCallOutcome<DatabaseUsage>> {
    try {
      return {
        ok: true,
        result: this.withPolicy(() => {
          const row = this.capacityRow(databaseId);
          if (!row || row.status === "deleted")
            throw new ApiFault("NOT_FOUND", 404);
          return {
            logicalBytes: row.logical_bytes,
            replayBytes: row.replay_bytes,
            physicalBytes: row.physical_bytes,
            version: row.usage_version,
          };
        }),
      };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async reserveMutation(
    reservation: AdmissionReservation,
  ): Promise<DurableCallOutcome<void>> {
    try {
      await this.scheduleAlarm(RESERVATION_RECONCILE_MS);
      const result = this.withPolicy((policy, clock) => {
        this.assertNotSuspended(clock);
        const sql = this.ctx.storage.sql;
        const database = this.capacityRow(reservation.databaseId);
        if (!database || database.status !== "active")
          throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
            reason: "databaseNotServing",
          });
        if (database.physical_bytes > policy.maxPhysicalBytesPerDatabase)
          throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
            quota: "physicalBytesPerDatabase",
          });
        if (
          reservation.logicalBytes !== MUTATION_LOGICAL_RESERVATION_BYTES ||
          reservation.replayBytes !== MUTATION_REPLAY_RESERVATION_BYTES
        )
          throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
            reason: "invalidMutationReservation",
          });
        sql.exec(
          "DELETE FROM mutation_capacity WHERE state = 'settled' AND expires_at <= ?",
          Date.now(),
        );
        const existing = sql
          .exec<MutationReservationRow>(
            "SELECT * FROM mutation_capacity WHERE database_id = ? AND operation_key = ?",
            reservation.databaseId,
            reservation.operationKey,
          )
          .toArray()[0];
        if (existing) {
          if (
            existing.operation_fingerprint !== reservation.operationFingerprint
          )
            throw new ApiFault("IDEMPOTENCY_CONFLICT", 409);
          this.assertControlStore(policy);
          return;
        }
        const day = new Date(Date.now()).toISOString().slice(0, 10);
        const daily =
          sql
            .exec<{ mutation_count: number }>(
              "SELECT mutation_count FROM mutation_days WHERE day = ?",
              day,
            )
            .toArray()[0]?.mutation_count ?? 0;
        if (daily >= policy.maxDailyMutations)
          throw new ApiFault("QUOTA_EXCEEDED", 429, {
            quota: "globalDailyMutations",
            limit: policy.maxDailyMutations,
          });
        const aggregate = this.aggregateUsage();
        if (
          aggregate.logicalBytes +
            aggregate.pendingLogicalBytes +
            reservation.logicalBytes >
          policy.maxLogicalBytes
        )
          throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
            quota: "globalLogicalBytes",
          });
        if (
          aggregate.replayBytes +
            aggregate.pendingReplayBytes +
            reservation.replayBytes >
          policy.maxReplayBytes
        )
          throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
            quota: "globalReplayBytes",
          });
        const now = Date.now();
        sql.exec(
          `INSERT INTO mutation_capacity
            (database_id, operation_key, operation_fingerprint, logical_bytes,
             replay_bytes, state, reserved_at, expires_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)`,
          reservation.databaseId,
          reservation.operationKey,
          reservation.operationFingerprint,
          reservation.logicalBytes,
          reservation.replayBytes,
          now,
        );
        sql.exec(
          `INSERT INTO mutation_days (day, mutation_count) VALUES (?, 1)
           ON CONFLICT(day) DO UPDATE SET mutation_count = mutation_count + 1`,
          day,
        );
        sql.exec("DELETE FROM mutation_days WHERE day < ?", day);
        this.assertControlStore(policy);
      });
      return { ok: true, result };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async settleMutation(
    databaseId: string,
    operationKey: string,
    usage: DatabaseUsage,
  ): Promise<DurableCallOutcome<void>> {
    try {
      this.withPolicy((policy) => {
        const row = this.ctx.storage.sql
          .exec<MutationReservationRow>(
            "SELECT * FROM mutation_capacity WHERE database_id = ? AND operation_key = ?",
            databaseId,
            operationKey,
          )
          .toArray()[0];
        if (!row)
          throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
            reason: "mutationReservationMissing",
          });
        this.writeUsage(databaseId, usage);
        if (row.state === "pending") {
          this.ctx.storage.sql.exec(
            `UPDATE mutation_capacity SET state = 'settled', expires_at = ?
             WHERE database_id = ? AND operation_key = ?`,
            Date.now() + GLOBAL_MUTATION_REPLAY_MS,
            databaseId,
            operationKey,
          );
        }
        this.assertControlStore(policy);
      });
      return { ok: true, result: undefined };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async releaseMutation(
    databaseId: string,
    operationKey: string,
  ): Promise<DurableCallOutcome<void>> {
    try {
      this.withPolicy((policy) => {
        const row = this.ctx.storage.sql
          .exec<MutationReservationRow>(
            "SELECT * FROM mutation_capacity WHERE database_id = ? AND operation_key = ?",
            databaseId,
            operationKey,
          )
          .toArray()[0];
        if (!row || row.state !== "pending") return;
        this.ctx.storage.sql.exec(
          "DELETE FROM mutation_capacity WHERE database_id = ? AND operation_key = ? AND state = 'pending'",
          databaseId,
          operationKey,
        );
        const day = new Date(row.reserved_at).toISOString().slice(0, 10);
        this.ctx.storage.sql.exec(
          "UPDATE mutation_days SET mutation_count = MAX(0, mutation_count - 1) WHERE day = ?",
          day,
        );
        this.assertControlStore(policy);
      });
      return { ok: true, result: undefined };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async reserveExport(
    reservation: ExportReservation,
  ): Promise<
    DurableCallOutcome<{ exportId: string; state: "pending" | "active" }>
  > {
    try {
      await this.scheduleAlarm(RESERVATION_RECONCILE_MS);
      const result = this.withPolicy((policy, clock) => {
        this.assertNotSuspended(clock);
        const sql = this.ctx.storage.sql;
        const database = this.capacityRow(reservation.databaseId);
        if (!database || database.status !== "active")
          throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
            reason: "databaseNotServing",
          });
        const existing = sql
          .exec<ExportReservationRow>(
            "SELECT * FROM export_capacity WHERE database_id = ? AND export_key = ?",
            reservation.databaseId,
            reservation.exportKey,
          )
          .toArray()[0];
        if (existing) {
          this.assertControlStore(policy);
          return { exportId: existing.export_id, state: existing.state };
        }
        const activeCount =
          sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM export_capacity WHERE database_id = ?",
              reservation.databaseId,
            )
            .toArray()[0]?.count ?? 0;
        if (activeCount >= EXPORT_MAX_PER_DATABASE)
          throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
            quota: "exportsPerDatabase",
            limit: EXPORT_MAX_PER_DATABASE,
          });
        if (
          reservation.snapshotBytes < 0 ||
          reservation.snapshotBytes > EXPORT_MAX_SNAPSHOT_BYTES
        )
          throw new ApiFault("RESULT_TOO_LARGE", 413, {
            maxBytes: EXPORT_MAX_SNAPSHOT_BYTES,
          });
        const used =
          sql
            .exec<{ bytes: number }>(
              "SELECT COALESCE(SUM(snapshot_bytes), 0) AS bytes FROM export_capacity",
            )
            .toArray()[0]?.bytes ?? 0;
        if (used + reservation.snapshotBytes > policy.maxExportBytes)
          throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
            quota: "globalExportBytes",
          });
        sql.exec(
          `INSERT INTO export_capacity
            (database_id, export_key, export_id, snapshot_bytes, expires_at, state, reserved_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
          reservation.databaseId,
          reservation.exportKey,
          reservation.exportId,
          reservation.snapshotBytes,
          reservation.expiresAt,
          Date.now(),
        );
        this.assertControlStore(policy);
        return { exportId: reservation.exportId, state: "pending" as const };
      });
      return { ok: true, result };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async completeExport(input: {
    databaseId: string;
    exportKey: string;
    exportId: string;
    snapshotBytes: number;
    expiresAt: number;
  }): Promise<DurableCallOutcome<void>> {
    try {
      const result = this.withPolicy((policy, _clock) => {
        if (
          !Number.isSafeInteger(input.snapshotBytes) ||
          input.snapshotBytes < 0 ||
          input.snapshotBytes > EXPORT_MAX_SNAPSHOT_BYTES
        )
          throw new ApiFault("RESULT_TOO_LARGE", 413, {
            maxBytes: EXPORT_MAX_SNAPSHOT_BYTES,
          });
        const row = this.ctx.storage.sql
          .exec<ExportReservationRow>(
            "SELECT * FROM export_capacity WHERE database_id = ? AND export_key = ?",
            input.databaseId,
            input.exportKey,
          )
          .toArray()[0];
        if (!row || row.export_id !== input.exportId)
          throw new ApiFault("CAPACITY_UNAVAILABLE", 503);
        if (row.state === "active") return;
        if (input.snapshotBytes > row.snapshot_bytes)
          throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
            reason: "exportReservationExceeded",
          });
        this.ctx.storage.sql.exec(
          `UPDATE export_capacity SET snapshot_bytes = ?, expires_at = ?
           WHERE database_id = ? AND export_key = ? AND state = 'pending'`,
          input.snapshotBytes,
          input.expiresAt,
          input.databaseId,
          input.exportKey,
        );
        this.assertControlStore(policy);
      });
      return { ok: true, result };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async activateExport(
    databaseId: string,
    exportKey: string,
  ): Promise<DurableCallOutcome<void>> {
    try {
      this.withPolicy((policy) => {
        this.ctx.storage.sql.exec(
          "UPDATE export_capacity SET state = 'active' WHERE database_id = ? AND export_key = ? AND state = 'pending'",
          databaseId,
          exportKey,
        );
        this.assertControlStore(policy);
      });
      return { ok: true, result: undefined };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async releaseExport(
    databaseId: string,
    exportKey: string,
  ): Promise<DurableCallOutcome<void>> {
    try {
      this.withPolicy((policy) => {
        this.ctx.storage.sql.exec(
          "DELETE FROM export_capacity WHERE database_id = ? AND export_key = ?",
          databaseId,
          exportKey,
        );
        this.assertControlStore(policy);
      });
      return { ok: true, result: undefined };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async retireDatabase(
    databaseId: string,
  ): Promise<DurableCallOutcome<boolean>> {
    try {
      const ready = this.withPolicy((policy) => {
        this.ctx.storage.sql.exec(
          `UPDATE database_capacity SET status = 'retiring'
           WHERE database_id = ? AND status IN ('active', 'creating')`,
          databaseId,
        );
        const row = this.capacityRow(databaseId);
        if (!row || (row.status !== "retiring" && row.status !== "deleted"))
          return false;
        if (row.status === "deleted") return false;
        const now = Date.now();
        this.ctx.storage.sql.exec(
          `UPDATE create_reservations SET expires_at = MAX(COALESCE(expires_at, ?), ?),
             lease_token = NULL, lease_until = NULL
           WHERE database_id = ? AND result_json IS NULL`,
          now + TOMBSTONE_RETENTION_MS,
          now + TOMBSTONE_RETENTION_MS,
          databaseId,
        );
        const pendingMutations =
          this.ctx.storage.sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM mutation_capacity WHERE database_id = ? AND state = 'pending'",
              databaseId,
            )
            .toArray()[0]?.count ?? 0;
        const pendingExports =
          this.ctx.storage.sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM export_capacity WHERE database_id = ? AND state = 'pending'",
              databaseId,
            )
            .toArray()[0]?.count ?? 0;
        this.assertControlStore(policy);
        return pendingMutations === 0 && pendingExports === 0;
      });
      await this.scheduleAlarm();
      return { ok: true, result: ready };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async isDatabaseRetiring(
    databaseId: string,
  ): Promise<DurableCallOutcome<boolean>> {
    try {
      return {
        ok: true,
        result: this.withPolicy(
          () => this.capacityRow(databaseId)?.status === "retiring",
        ),
      };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async completeRetirement(
    databaseId: string,
  ): Promise<DurableCallOutcome<void>> {
    try {
      this.withPolicy((policy) => {
        const row = this.capacityRow(databaseId);
        if (!row || row.status === "deleted") return;
        if (row.status !== "retiring")
          throw new ApiFault("CAPACITY_UNAVAILABLE", 503);
        const pending =
          this.ctx.storage.sql
            .exec<{ count: number }>(
              `SELECT
                (SELECT COUNT(*) FROM mutation_capacity WHERE database_id = ? AND state = 'pending') +
                (SELECT COUNT(*) FROM export_capacity WHERE database_id = ? AND state = 'pending') AS count`,
              databaseId,
              databaseId,
            )
            .toArray()[0]?.count ?? 0;
        if (pending > 0)
          throw new ApiFault("REQUEST_IN_PROGRESS", 409, {
            retryAfterSeconds: 60,
          });
        const now = Date.now();
        this.ctx.storage.sql.exec(
          `UPDATE database_capacity SET status = 'deleted', lease_token = NULL,
             lease_until = NULL, logical_bytes = 0, replay_bytes = 0,
             physical_bytes = 0, physical_reserved_bytes = 0, deleted_at = ?
           WHERE database_id = ? AND status = 'retiring'`,
          now,
          databaseId,
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM mutation_capacity WHERE database_id = ?",
          databaseId,
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM export_capacity WHERE database_id = ?",
          databaseId,
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM database_slugs WHERE database_id = ?",
          databaseId,
        );
        this.ctx.storage.sql.exec(
          `UPDATE create_reservations SET expires_at = MAX(COALESCE(expires_at, ?), ?),
             lease_token = NULL, lease_until = NULL
           WHERE database_id = ? AND result_json IS NULL`,
          now + TOMBSTONE_RETENTION_MS,
          now + TOMBSTONE_RETENTION_MS,
          databaseId,
        );
        this.assertControlStore(policy);
      });
      return { ok: true, result: undefined };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async owns(databaseId: string): Promise<boolean> {
    return (
      this.ctx.storage.sql
        .exec<{ database_id: string }>(
          "SELECT database_id FROM database_slugs WHERE database_id = ?",
          databaseId,
        )
        .toArray().length > 0
    );
  }

  private reserve(
    keyDigest: string,
    requestFingerprint: string,
    normalized: { name: string; description: string },
    origin: string,
  ): CreateReservation {
    return this.withPolicy((policy) => {
      const now = Date.now();
      const sql = this.ctx.storage.sql;
      sql.exec(
        `DELETE FROM create_reservations WHERE key_digest IN (
           SELECT r.key_digest FROM create_reservations r
           WHERE r.result_json IS NOT NULL AND r.expires_at <= ?
           LIMIT 100
         )`,
        now,
      );
      const existing = sql
        .exec<ReservationRow>(
          "SELECT * FROM create_reservations WHERE key_digest = ?",
          keyDigest,
        )
        .toArray()[0];
      if (existing) {
        if (existing.request_fingerprint !== requestFingerprint)
          throw new ApiFault("IDEMPOTENCY_CONFLICT", 409);
        if (existing.result_json !== null) {
          return {
            intent: JSON.parse(existing.intent_json) as CreateIntent,
            result: JSON.parse(existing.result_json) as DatabaseResource,
          };
        }
        const capacity = this.capacityRow(existing.database_id);
        if (
          capacity &&
          (capacity.status === "retiring" || capacity.status === "deleted")
        )
          throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
            reason: "databaseRetired",
          });
        if (
          existing.expires_at !== null &&
          existing.expires_at <= now &&
          (!capacity || capacity.status === "deleted")
        ) {
          sql.exec(
            "DELETE FROM create_reservations WHERE key_digest = ? AND result_json IS NULL",
            keyDigest,
          );
        } else if (existing.expires_at !== null && existing.expires_at <= now) {
          throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
            reason: "creationReservationExpired",
          });
        } else if (
          existing.lease_until !== null &&
          existing.lease_until > now
        ) {
          throw new ApiFault("REQUEST_IN_PROGRESS", 409, {
            retryAfterSeconds: Math.ceil((existing.lease_until - now) / 1_000),
          });
        } else {
          const leaseToken = randomSlug();
          sql.exec(
            `UPDATE create_reservations SET lease_token = ?, lease_until = ?,
               expires_at = ? WHERE key_digest = ? AND result_json IS NULL`,
            leaseToken,
            now + CREATE_LEASE_MS,
            now + CREATE_REPLAY_MS,
            keyDigest,
          );
          this.assertControlStore(policy);
          return {
            intent: JSON.parse(existing.intent_json) as CreateIntent,
            leaseToken,
          };
        }
      }
      const databaseId = randomSlug();
      const intent: CreateIntent = {
        databaseId,
        databaseUrl: `${origin}/v1/databases/${databaseId}`,
        ...normalized,
        createdAt: now,
        writeUntil: now + WRITE_WINDOW_MS,
      };
      const leaseToken = randomSlug();
      this.ctx.storage.sql.exec(
        `INSERT INTO create_reservations
          (key_digest, request_fingerprint, database_id, intent_json, result_json, reserved_at, expires_at, lease_token, lease_until)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        keyDigest,
        requestFingerprint,
        intent.databaseId,
        JSON.stringify(intent),
        now,
        now + CREATE_REPLAY_MS,
        leaseToken,
        now + CREATE_LEASE_MS,
      );
      this.assertControlStore(policy);
      return { intent, leaseToken };
    });
  }

  private complete(
    keyDigest: string,
    requestFingerprint: string,
    leaseToken: string,
    result: DatabaseResource,
  ): DatabaseResource {
    return this.withPolicy((policy) => {
      const now = Date.now();
      const existing = this.ctx.storage.sql
        .exec<ReservationRow>(
          "SELECT * FROM create_reservations WHERE key_digest = ?",
          keyDigest,
        )
        .toArray()[0];
      if (!existing || existing.request_fingerprint !== requestFingerprint)
        throw new ApiFault("CAPACITY_UNAVAILABLE", 503);
      if (existing.result_json !== null)
        return JSON.parse(existing.result_json) as DatabaseResource;
      const capacity = this.capacityRow(existing.database_id);
      if (
        existing.lease_token !== leaseToken ||
        existing.lease_until === null ||
        existing.lease_until <= now ||
        existing.expires_at === null ||
        existing.expires_at <= now ||
        !capacity ||
        capacity.creation_key_digest !== keyDigest ||
        capacity.status !== "active"
      )
        throw new ApiFault("REQUEST_IN_PROGRESS", 409, {
          retryAfterSeconds: 1,
        });
      this.ctx.storage.sql.exec(
        "UPDATE create_reservations SET result_json = ?, expires_at = ?, lease_token = NULL, lease_until = NULL WHERE key_digest = ? AND result_json IS NULL",
        JSON.stringify(result),
        now + CREATE_REPLAY_MS,
        keyDigest,
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO database_slugs (database_id, created_at) VALUES (?, ?)",
        result.databaseId,
        now,
      );
      this.assertControlStore(policy);
      return result;
    });
  }

  private releaseLease(keyDigest: string, leaseToken: string): void {
    this.withPolicy((policy) => {
      this.ctx.storage.sql.exec(
        "UPDATE create_reservations SET lease_token = NULL, lease_until = NULL WHERE key_digest = ? AND lease_token = ? AND result_json IS NULL",
        keyDigest,
        leaseToken,
      );
      this.assertControlStore(policy);
    });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    let nextDelay = 60 * 60 * 1_000;
    try {
      const work = this.withPolicy((policy) => {
        const sql = this.ctx.storage.sql;
        sql.exec(
          `DELETE FROM create_reservations WHERE key_digest IN (
             SELECT key_digest FROM create_reservations
             WHERE result_json IS NOT NULL AND expires_at <= ? LIMIT 100
           )`,
          now,
        );
        sql.exec(
          `DELETE FROM admission_requests WHERE request_id IN (
             SELECT request_id FROM admission_requests
             WHERE request_at < ? LIMIT 1000
           )`,
          now - GLOBAL_REQUEST_RETENTION_MS,
        );
        sql.exec(
          `DELETE FROM mutation_capacity WHERE (database_id, operation_key) IN (
             SELECT database_id, operation_key FROM mutation_capacity
             WHERE state = 'settled' AND expires_at <= ? LIMIT 100
           )`,
          now,
        );
        const expiredCreating = sql
          .exec<{ database_id: string }>(
            `SELECT database_id FROM database_capacity
             WHERE status = 'creating' AND (lease_until IS NULL OR lease_until <= ?)
             LIMIT 100`,
            now,
          )
          .toArray();
        for (const { database_id: databaseId } of expiredCreating) {
          sql.exec(
            `UPDATE database_capacity SET status = 'retiring',
               lease_token = NULL, lease_until = NULL
             WHERE database_id = ? AND status = 'creating'
               AND (lease_until IS NULL OR lease_until <= ?)`,
            databaseId,
            now,
          );
          sql.exec(
            `UPDATE create_reservations SET expires_at = MAX(COALESCE(expires_at, ?), ?),
               lease_token = NULL, lease_until = NULL
             WHERE database_id = ? AND result_json IS NULL`,
            now + TOMBSTONE_RETENTION_MS,
            now + TOMBSTONE_RETENTION_MS,
            databaseId,
          );
        }
        const expiredUnreturned = sql
          .exec<{ database_id: string }>(
            `SELECT c.database_id FROM database_capacity c
             JOIN create_reservations r ON r.database_id = c.database_id
             WHERE c.status = 'active' AND r.result_json IS NULL
               AND r.expires_at IS NOT NULL AND r.expires_at <= ?
             LIMIT 100`,
            now,
          )
          .toArray();
        for (const { database_id: databaseId } of expiredUnreturned) {
          sql.exec(
            `UPDATE database_capacity SET status = 'retiring',
               lease_token = NULL, lease_until = NULL
             WHERE database_id = ? AND status = 'active'
               AND EXISTS (SELECT 1 FROM create_reservations r
                 WHERE r.database_id = ? AND r.result_json IS NULL
                   AND r.expires_at IS NOT NULL AND r.expires_at <= ?)`,
            databaseId,
            databaseId,
            now,
          );
          sql.exec(
            `UPDATE create_reservations SET expires_at = MAX(COALESCE(expires_at, ?), ?),
               lease_token = NULL, lease_until = NULL
             WHERE database_id = ? AND result_json IS NULL`,
            now + TOMBSTONE_RETENTION_MS,
            now + TOMBSTONE_RETENTION_MS,
            databaseId,
          );
        }
        sql.exec(
          `DELETE FROM create_reservations WHERE key_digest IN (
             SELECT r.key_digest FROM create_reservations r
             WHERE r.result_json IS NULL AND r.expires_at IS NOT NULL
               AND r.expires_at <= ?
               AND NOT EXISTS (SELECT 1 FROM database_capacity c
                 WHERE c.database_id = r.database_id
                   AND c.status IN ('creating', 'active', 'retiring'))
             LIMIT 100
           )`,
          now,
        );
        sql.exec(
          `DELETE FROM database_capacity WHERE database_id IN (
             SELECT c.database_id FROM database_capacity c
             WHERE c.status = 'deleted' AND c.deleted_at <= ?
               AND NOT EXISTS (SELECT 1 FROM create_reservations r
                 WHERE r.database_id = c.database_id)
             LIMIT 100
           )`,
          now - TOMBSTONE_RETENTION_MS,
        );
        sql.exec(
          `DELETE FROM database_slugs WHERE database_id IN (
             SELECT s.database_id FROM database_slugs s
             WHERE NOT EXISTS (SELECT 1 FROM database_capacity c
               WHERE c.database_id = s.database_id AND c.status = 'active')
             LIMIT 100
           )`,
        );

        const mutations = sql
          .exec<{ database_id: string; operation_key: string }>(
            `SELECT database_id, operation_key FROM mutation_capacity
             WHERE state = 'pending' AND reserved_at <= ?
             ORDER BY reserved_at LIMIT 100`,
            now - RESERVATION_RECONCILE_MS,
          )
          .toArray();
        const exports = sql
          .exec<{ database_id: string; export_key: string }>(
            `SELECT database_id, export_key FROM export_capacity
             WHERE (state = 'pending' AND reserved_at <= ?)
                OR (state = 'active' AND expires_at <= ?)
             ORDER BY CASE WHEN state = 'active' THEN expires_at ELSE reserved_at END
             LIMIT 100`,
            now - RESERVATION_RECONCILE_MS,
            now,
          )
          .toArray();
        const retiring = sql
          .exec<{ database_id: string }>(
            `SELECT c.database_id FROM database_capacity c
             WHERE c.status = 'retiring'
               AND NOT EXISTS (SELECT 1 FROM mutation_capacity m
                 WHERE m.database_id = c.database_id AND m.state = 'pending')
               AND NOT EXISTS (SELECT 1 FROM export_capacity e
                 WHERE e.database_id = c.database_id AND e.state = 'pending')
             LIMIT 100`,
          )
          .toArray();
        const hasPending =
          (sql
            .exec<{ count: number }>(
              `SELECT
                (SELECT COUNT(*) FROM mutation_capacity WHERE state = 'pending') +
                (SELECT COUNT(*) FROM export_capacity WHERE state = 'pending') +
                (SELECT COUNT(*) FROM export_capacity
                 WHERE state = 'active' AND expires_at <= ?) AS count`,
              now,
            )
            .toArray()[0]?.count ?? 0) > 0;
        const hasIncompleteCreate =
          (sql
            .exec<{ count: number }>(
              `SELECT COUNT(*) AS count FROM database_capacity
               WHERE status = 'creating'`,
            )
            .toArray()[0]?.count ?? 0) > 0;
        const hasRetiring =
          (sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM database_capacity WHERE status = 'retiring'",
            )
            .toArray()[0]?.count ?? 0) > 0;
        this.assertControlStore(policy);
        return {
          mutations,
          exports,
          retiring,
          hasWork: hasPending || hasIncompleteCreate || hasRetiring,
        };
      });

      for (const {
        database_id: databaseId,
        operation_key: operationKey,
      } of work.mutations) {
        const stub = this.env.DATABASES.get(
          this.env.DATABASES.idFromName(databaseId),
        ) as unknown as {
          reconcileMutation: (
            databaseId: string,
            operationKey: string,
          ) => Promise<
            DurableCallOutcome<{ committed: boolean; usage?: DatabaseUsage }>
          >;
        };
        try {
          await stub.reconcileMutation(databaseId, operationKey);
        } catch {
          // Keep the reservation charged until the Object confirms its outcome.
        }
      }
      for (const {
        database_id: databaseId,
        export_key: exportKey,
      } of work.exports) {
        const stub = this.env.DATABASES.get(
          this.env.DATABASES.idFromName(databaseId),
        ) as unknown as {
          reconcileExport: (
            databaseId: string,
            exportKey: string,
          ) => Promise<DurableCallOutcome<"active" | "missing" | "pending">>;
        };
        try {
          await stub.reconcileExport(databaseId, exportKey);
        } catch {
          // Keep the reservation charged until the Object confirms its outcome.
        }
      }
      for (const { database_id: databaseId } of work.retiring) {
        const stub = this.env.DATABASES.get(
          this.env.DATABASES.idFromName(databaseId),
        ) as unknown as {
          deleteRetiredStorage: (
            databaseId: string,
          ) => Promise<DurableCallOutcome<void>>;
        };
        try {
          const deleted = await stub.deleteRetiredStorage(databaseId);
          if (deleted.ok) await this.completeRetirement(databaseId);
        } catch {
          // Keep the physical reservation until deleteAll and completion succeed.
        }
      }
      nextDelay = work.hasWork ? REGISTRY_ALARM_INTERVAL_MS : 60 * 60 * 1_000;
    } finally {
      await this.scheduleAlarm(nextDelay);
    }
  }

  private async scheduleAlarm(delay = 60 * 60 * 1_000): Promise<void> {
    const target = Date.now() + delay;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > target)
      await this.ctx.storage.setAlarm(target);
  }

  private withPolicy<T>(
    operation: (policy: CapacityPolicy, clock: ServiceClock) => T,
  ): T {
    const context = this.ctx.storage.transactionSync(() => {
      const current = this.refreshPolicy();
      if (
        current.policy.revision > 0 &&
        current.clock.maxPhysicalBytesPerDatabase > 0
      ) {
        this.ctx.storage.sql.exec(
          `UPDATE database_capacity SET physical_reserved_bytes = MAX(physical_bytes, ?)
           WHERE status <> 'deleted'`,
          current.policy.maxPhysicalBytesPerDatabase,
        );
      }
      return current;
    });
    return this.ctx.storage.transactionSync(() => {
      const { policy, clock } = context;
      this.backfillLegacyCapacity(policy);
      const result = operation(policy, clock);
      this.assertControlStore(policy);
      return result;
    });
  }

  private refreshPolicy(): { policy: CapacityPolicy; clock: ServiceClock } {
    let policy: CapacityPolicy;
    try {
      policy = parseCapacityPolicy(this.env);
    } catch {
      throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
        reason: "capacityPolicyMissingOrInvalid",
      });
    }
    const fingerprint = capacityPolicyFingerprint(policy);
    const row = this.ctx.storage.sql
      .exec<PolicyRow>("SELECT * FROM capacity_policy WHERE singleton = 1")
      .toArray()[0];
    const now = Date.now();
    if (!row) {
      const suspendedSince = policy.serviceSuspended ? now : null;
      this.ctx.storage.sql.exec(
        `INSERT INTO capacity_policy
          (singleton, revision, fingerprint, suspended, suspended_since, paused_total_ms)
         VALUES (1, ?, ?, ?, ?, 0)`,
        policy.revision,
        fingerprint,
        policy.serviceSuspended ? 1 : 0,
        suspendedSince,
      );
      return {
        policy,
        clock: this.serviceClock(policy, 0, suspendedSince, now),
      };
    }
    if (policy.revision < row.revision)
      throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
        reason: "staleCapacityPolicyRevision",
        currentRevision: row.revision,
      });
    if (policy.revision === row.revision && fingerprint !== row.fingerprint)
      throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
        reason: "capacityPolicyRevisionConflict",
        currentRevision: row.revision,
      });
    let pausedTotalMs = row.paused_total_ms;
    let suspendedSince = row.suspended_since;
    if (policy.revision > row.revision) {
      if (policy.serviceSuspended && suspendedSince === null)
        suspendedSince = now;
      else if (!policy.serviceSuspended && suspendedSince !== null) {
        pausedTotalMs += Math.max(0, now - suspendedSince);
        suspendedSince = null;
      }
      this.ctx.storage.sql.exec(
        `UPDATE capacity_policy SET revision = ?, fingerprint = ?, suspended = ?,
           suspended_since = ?, paused_total_ms = ? WHERE singleton = 1`,
        policy.revision,
        fingerprint,
        policy.serviceSuspended ? 1 : 0,
        suspendedSince,
        pausedTotalMs,
      );
    }
    return {
      policy,
      clock: this.serviceClock(policy, pausedTotalMs, suspendedSince, now),
    };
  }

  private serviceClock(
    policy: CapacityPolicy,
    pausedTotalMs: number,
    suspendedSince: number | null,
    now: number,
  ): ServiceClock {
    return {
      suspended: policy.serviceSuspended,
      pausedTotalMs:
        pausedTotalMs +
        (policy.serviceSuspended && suspendedSince !== null
          ? Math.max(0, now - suspendedSince)
          : 0),
      suspendedSince,
      policyRevision: policy.revision,
      maxPhysicalBytesPerDatabase: policy.maxPhysicalBytesPerDatabase,
    };
  }

  private assertNotSuspended(clock: ServiceClock): void {
    if (clock.suspended)
      throw new ApiFault("SERVICE_SUSPENDED", 503, {
        policyRevision: clock.policyRevision,
      });
  }

  private assertControlStore(policy: CapacityPolicy): void {
    if (this.ctx.storage.sql.databaseSize > policy.maxControlBytes)
      throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
        quota: "globalControlStoreBytes",
        limitBytes: policy.maxControlBytes,
        physicalBytes: this.ctx.storage.sql.databaseSize,
      });
  }

  private backfillLegacyCapacity(policy: CapacityPolicy): void {
    const complete = this.ctx.storage.sql
      .exec<{ legacy_backfill_done: number }>(
        "SELECT legacy_backfill_done FROM capacity_meta WHERE singleton = 1",
      )
      .toArray()[0];
    if (complete?.legacy_backfill_done === 1) return;
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "DELETE FROM create_reservations WHERE result_json IS NOT NULL AND expires_at <= ?",
      now,
    );
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO database_capacity
        (database_id, creation_key_digest, status, lease_token, lease_until,
         logical_bytes, replay_bytes, physical_bytes, physical_reserved_bytes,
         created_at, deleted_at)
       SELECT database_id, key_digest,
         CASE WHEN result_json IS NULL THEN 'creating' ELSE 'active' END,
         lease_token, lease_until, ?, ?, 0, ?, reserved_at, NULL
       FROM create_reservations`,
      LEGACY_LOGICAL_RESERVATION_BYTES,
      LEGACY_REPLAY_RESERVATION_BYTES,
      policy.maxPhysicalBytesPerDatabase,
    );
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO database_capacity
        (database_id, creation_key_digest, status, lease_token, lease_until,
         logical_bytes, replay_bytes, physical_bytes, physical_reserved_bytes,
         created_at, deleted_at)
       SELECT database_id, 'legacy:' || database_id, 'active', NULL, NULL,
         ?, ?, 0, ?, created_at, NULL
       FROM database_slugs`,
      LEGACY_LOGICAL_RESERVATION_BYTES,
      LEGACY_REPLAY_RESERVATION_BYTES,
      policy.maxPhysicalBytesPerDatabase,
    );
    this.ctx.storage.sql.exec(
      `UPDATE database_capacity SET physical_reserved_bytes = ?
       WHERE status <> 'deleted' AND physical_reserved_bytes = 0`,
      policy.maxPhysicalBytesPerDatabase,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO capacity_meta (singleton, legacy_backfill_done) VALUES (1, 1) ON CONFLICT(singleton) DO UPDATE SET legacy_backfill_done = 1",
    );
  }

  private capacityRow(databaseId: string): CapacityRow | undefined {
    return this.ctx.storage.sql
      .exec<CapacityRow>(
        "SELECT * FROM database_capacity WHERE database_id = ?",
        databaseId,
      )
      .toArray()[0];
  }

  private activeDatabaseCount(): number {
    return (
      this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM database_capacity WHERE status <> 'deleted'",
        )
        .toArray()[0]?.count ?? 0
    );
  }

  private aggregateUsage(): {
    logicalBytes: number;
    replayBytes: number;
    physicalReservedBytes: number;
    pendingLogicalBytes: number;
    pendingReplayBytes: number;
  } {
    const total = this.ctx.storage.sql
      .exec<{
        logical: number;
        replay: number;
        physical: number;
      }>(
        `SELECT COALESCE(SUM(logical_bytes), 0) AS logical,
          COALESCE(SUM(replay_bytes), 0) AS replay,
          COALESCE(SUM(physical_reserved_bytes), 0) AS physical
         FROM database_capacity WHERE status <> 'deleted'`,
      )
      .toArray()[0];
    const pending = this.ctx.storage.sql
      .exec<{ logical: number; replay: number }>(
        `SELECT COALESCE(SUM(logical_bytes), 0) AS logical,
          COALESCE(SUM(replay_bytes), 0) AS replay
         FROM mutation_capacity WHERE state = 'pending'`,
      )
      .toArray()[0];
    return {
      logicalBytes: total?.logical ?? 0,
      replayBytes: total?.replay ?? 0,
      physicalReservedBytes: total?.physical ?? 0,
      pendingLogicalBytes: pending?.logical ?? 0,
      pendingReplayBytes: pending?.replay ?? 0,
    };
  }

  private writeUsage(
    databaseId: string,
    usage: DatabaseUsage,
    activate = false,
  ): void {
    for (const value of Object.values(usage))
      if (!Number.isSafeInteger(value) || value < 0)
        throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
          reason: "invalidUsageMeasurement",
        });
    this.ctx.storage.sql.exec(
      `UPDATE database_capacity SET logical_bytes = ?, replay_bytes = ?,
         physical_bytes = ?, usage_version = ?,
         status = CASE WHEN ? = 1 AND status = 'creating' THEN 'active' ELSE status END
       WHERE database_id = ? AND status <> 'deleted' AND usage_version < ?`,
      usage.logicalBytes,
      usage.replayBytes,
      usage.physicalBytes,
      usage.version,
      activate ? 1 : 0,
      databaseId,
      usage.version,
    );
  }

  private migrate(): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS create_reservations (
        key_digest TEXT PRIMARY KEY,
        request_fingerprint TEXT NOT NULL,
        database_id TEXT NOT NULL UNIQUE,
        intent_json TEXT NOT NULL,
        result_json TEXT,
        reserved_at INTEGER NOT NULL,
        expires_at INTEGER,
        lease_token TEXT,
        lease_until INTEGER
      )`);
      this.ctx.storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS create_reservations_by_database ON create_reservations(database_id)",
      );
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS database_slugs (
        database_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )`);
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS capacity_policy (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        suspended INTEGER NOT NULL CHECK (suspended IN (0, 1)),
        suspended_since INTEGER,
        paused_total_ms INTEGER NOT NULL
      )`);
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS capacity_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        legacy_backfill_done INTEGER NOT NULL CHECK (legacy_backfill_done IN (0, 1))
      )`);
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS admission_requests (
        request_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('http', 'mcp_tool')),
        request_at INTEGER NOT NULL
      )`);
      this.ctx.storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS admission_requests_at ON admission_requests(request_at)",
      );
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS database_capacity (
        database_id TEXT PRIMARY KEY,
        creation_key_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('creating', 'active', 'retiring', 'deleted')),
        lease_token TEXT,
        lease_until INTEGER,
        logical_bytes INTEGER NOT NULL,
        replay_bytes INTEGER NOT NULL,
        physical_bytes INTEGER NOT NULL,
        usage_version INTEGER NOT NULL DEFAULT 0,
        physical_reserved_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        deleted_at INTEGER
      )`);
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS mutation_capacity (
        database_id TEXT NOT NULL,
        operation_key TEXT NOT NULL,
        operation_fingerprint TEXT NOT NULL,
        logical_bytes INTEGER NOT NULL,
        replay_bytes INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'settled')),
        reserved_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (database_id, operation_key)
      )`);
      this.ctx.storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS mutation_capacity_expiry ON mutation_capacity(state, expires_at)",
      );
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS mutation_days (
        day TEXT PRIMARY KEY,
        mutation_count INTEGER NOT NULL
      )`);
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS export_capacity (
        database_id TEXT NOT NULL,
        export_key TEXT NOT NULL,
        export_id TEXT NOT NULL,
        snapshot_bytes INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'active')),
        reserved_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (database_id, export_key),
        UNIQUE (database_id, export_id)
      )`);
      const capacityColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(database_capacity)")
        .toArray();
      if (!capacityColumns.some((column) => column.name === "usage_version"))
        this.ctx.storage.sql.exec(
          "ALTER TABLE database_capacity ADD COLUMN usage_version INTEGER NOT NULL DEFAULT 0",
        );
      const exportColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(export_capacity)")
        .toArray();
      if (!exportColumns.some((column) => column.name === "reserved_at"))
        this.ctx.storage.sql.exec(
          "ALTER TABLE export_capacity ADD COLUMN reserved_at INTEGER NOT NULL DEFAULT 0",
        );
    });
  }
}
