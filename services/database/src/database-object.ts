import { DurableObject } from "cloudflare:workers";
import type { CapacityPolicyBindings } from "./capacity-policy";
import { getGlobalAdmission, type DatabaseUsage } from "./global-admission";
import {
  MUTATION_LOGICAL_RESERVATION_BYTES,
  MUTATION_REPLAY_RESERVATION_BYTES,
} from "./global-admission";
import {
  buildExportItems,
  exportCursorPosition,
  ExportFault,
  pageExportItemWindow,
  serializeExportItems,
  EXPORT_DEFAULT_PAGE_ITEMS,
  EXPORT_MAX_PAGE_ITEMS,
  EXPORT_MAX_SNAPSHOT_BYTES,
  EXPORT_TTL_MS,
  type ExportItem,
  type ExportManifest,
  type ExportPage,
} from "./export";

const DAY_MS = 24 * 60 * 60 * 1_000;
const INACTIVITY_MS = 7 * DAY_MS;
const IDEMPOTENCY_MS = DAY_MS;
const MAX_STORAGE_BYTES = 10 * 1024 * 1024;
const MAX_DAILY_REQUESTS = 1_000;
const MAX_DAILY_MUTATIONS = 100;
const MAX_REQUESTS_PER_MINUTE = 60;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_MUTATION_RESULT_BYTES = 255 * 1024;
const MAX_DAILY_RETURNED_BYTES = 100 * 1024 * 1024;
const MAX_TABLES = 100;
const MAX_COLUMNS_PER_TABLE = 64;
const MAX_RECORDS_PER_DATABASE = 10_000;
const MAX_REPLAY_BYTES = 51 * 1024 * 1024;
const OBJECT_ALARM_RETRY_MS = 60 * 1_000;
const MAX_EXPIRED_EXPORT_TOMBSTONES = 2 * MAX_DAILY_REQUESTS;
const ACCESS_WARNING =
  "Anyone with this link can read and change this database while writable. Use it at your own risk and do not store sensitive information.";

export type DatabaseBindings = {
  DATABASES: DurableObjectNamespace;
  REGISTRY: DurableObjectNamespace;
} & CapacityPolicyBindings;

export type DatabaseResource = {
  databaseId: string;
  databaseUrl: string;
  name: string;
  description: string;
  createdAt: string;
  writeUntil: string;
  lastActivityAt: string;
  state: "writable" | "read_only";
  accessWarning: string;
};

export type DurableCallOutcome<T> =
  | { ok: true; result: T }
  | {
      ok: false;
      status: number;
      body: {
        error: {
          code: string;
          message: string;
          details: Record<string, unknown>;
        };
      };
      headers: Record<string, string>;
    };

export type TableResource = {
  id: string;
  name: string;
  description: string;
  schemaVersion: string;
};

export type ColumnResource = {
  id: string;
  name: string;
  type: "string" | "number" | "boolean";
  nullable: boolean;
};

export type RecordResource = {
  id: string;
  values: Record<string, string | number | boolean | null>;
  version: string;
};

type MetadataRow = {
  singleton: number;
  database_id: string;
  database_url: string;
  name: string;
  description: string;
  created_at: number;
  write_until: number;
  last_activity_at: number;
  last_activity_paused_total_ms: number;
  usage_version: number;
  quota_day: string;
  daily_requests: number;
  daily_mutations: number;
  daily_returned_bytes: number;
};

type TableRow = {
  id: string;
  name: string;
  description: string;
  schema_version: number;
};

type ColumnRow = {
  id: string;
  table_id: string;
  name: string;
  type: ColumnResource["type"];
  nullable: number;
};

type RecordRow = {
  id: string;
  table_id: string;
  values_json: string;
  version: number;
};

type ExportSnapshotRow = {
  export_id: string;
  export_key: string;
  format_version: number;
  snapshot_at: string;
  expires_at: number;
  snapshot_bytes: number;
  item_count: number;
};

type ExportSnapshotItemRow = {
  item_index: number;
  item_json: string;
};

type MutationContext = {
  requestKey: string;
  expectedVersion?: string;
  expectedSchemaVersion?: string;
};

type MutationOutcome<T> = {
  status: number;
  body: T | null;
  headers?: Record<string, string>;
};

type Cursor = {
  v: 1;
  databaseId: string;
  scope: string;
  afterId: string;
  query: string;
};

export class ApiFault extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(messageFor(code));
    this.name = "ApiFault";
  }
}

function messageFor(code: string): string {
  const messages: Record<string, string> = {
    VALIDATION_ERROR: "Request validation failed",
    NOT_FOUND: "Resource not found",
    VERSION_CONFLICT: "The record version is stale",
    SCHEMA_VERSION_CONFLICT: "The table schema version is stale",
    IDEMPOTENCY_CONFLICT:
      "The request key was already used for a different operation",
    REQUEST_IN_PROGRESS:
      "An operation with this request key is still in progress",
    NAME_CONFLICT: "A sibling resource already uses this name",
    SCHEMA_INCOMPATIBLE:
      "The schema change is incompatible with stored records",
    DATABASE_READ_ONLY: "The database write window has ended",
    QUOTA_EXCEEDED: "A database quota has been reached",
    CAPACITY_UNAVAILABLE:
      "The service cannot reserve capacity for this operation",
    SERVICE_SUSPENDED: "The service is temporarily suspended",
    REQUEST_TOO_LARGE: "The request body exceeds 65536 bytes",
    RESULT_TOO_LARGE: "The result exceeds 262144 bytes",
    EXPORT_EXPIRED: "The export handle has expired",
    INVALID_JSON: "Request body must be valid JSON",
    UNSUPPORTED_MEDIA_TYPE: "Content-Type must be application/json",
    INTERNAL_ERROR: "Internal server error",
  };
  return messages[code] ?? "Request failed";
}

export function errorResponse(error: unknown): Response {
  const result = errorOutcome(error);
  return Response.json(result.body, {
    status: result.status,
    headers: result.headers,
  });
}

export function errorOutcome(
  error: unknown,
): Extract<DurableCallOutcome<never>, { ok: false }> {
  const fault =
    error instanceof ApiFault ? error : new ApiFault("INTERNAL_ERROR", 500);
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (fault.code === "QUOTA_EXCEEDED") headers["retry-after"] = "60";
  if (fault.code === "REQUEST_IN_PROGRESS")
    headers["retry-after"] = String(fault.details.retryAfterSeconds ?? 1);
  return {
    ok: false,
    status: fault.status,
    body: {
      error: {
        code: fault.code,
        message: fault.message,
        details: fault.details,
      },
    },
    headers,
  };
}

export function parseObject(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiFault("VALIDATION_ERROR", 400);
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !allowed.includes(key))) {
    throw new ApiFault("VALIDATION_ERROR", 400);
  }
  return object;
}

function nonemptyName(value: unknown): string {
  if (typeof value !== "string") throw new ApiFault("VALIDATION_ERROR", 400);
  const name = value.trim();
  if (name.length === 0 || new TextEncoder().encode(name).byteLength > 256) {
    throw new ApiFault("VALIDATION_ERROR", 400);
  }
  return name;
}

function description(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 1_000) {
    throw new ApiFault("VALIDATION_ERROR", 400);
  }
  return value;
}

function isCell(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function requireCell(
  value: unknown,
  column: ColumnRow,
): asserts value is string | number | boolean | null {
  const valid =
    value === null
      ? column.nullable === 1
      : column.type === "string"
        ? typeof value === "string" && value.length <= 10_000
        : column.type === "number"
          ? typeof value === "number" && Number.isFinite(value)
          : typeof value === "boolean";
  if (!valid) throw new ApiFault("VALIDATION_ERROR", 400);
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

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

async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stable(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function encodeCursor(cursor: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeCursor(value: string): Cursor {
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const cursor = JSON.parse(new TextDecoder().decode(bytes)) as Cursor;
    if (
      cursor.v !== 1 ||
      typeof cursor.databaseId !== "string" ||
      typeof cursor.scope !== "string" ||
      typeof cursor.afterId !== "string" ||
      typeof cursor.query !== "string"
    )
      throw new Error("invalid cursor");
    return cursor;
  } catch {
    throw new ApiFault("VALIDATION_ERROR", 400);
  }
}

function pageLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return 20;
  if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(raw)) {
    throw new ApiFault("VALIDATION_ERROR", 400);
  }
  return Number(raw);
}

function exportPageLimit(url: URL): number {
  validateQueryKeys(url, ["limit", "cursor"]);
  const raw = url.searchParams.get("limit");
  if (raw === null) return EXPORT_DEFAULT_PAGE_ITEMS;
  if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(raw))
    throw new ApiFault("VALIDATION_ERROR", 400, { field: "limit" });
  const limit = Number(raw);
  if (limit > EXPORT_MAX_PAGE_ITEMS)
    throw new ApiFault("VALIDATION_ERROR", 400, { field: "limit" });
  return limit;
}

function validateQueryKeys(url: URL, allowed: readonly string[]): void {
  const seen = new Set<string>();
  const accepted = new Set(allowed);
  for (const key of url.searchParams.keys()) {
    if (!accepted.has(key) || seen.has(key))
      throw new ApiFault("VALIDATION_ERROR", 400);
    seen.add(key);
  }
}

function responseBudget(headers: Headers): number {
  const raw = headers.get("x-database-response-budget");
  if (raw === null) return MAX_RESPONSE_BYTES;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new ApiFault("VALIDATION_ERROR", 400);
  const requested = Number(raw);
  if (!Number.isSafeInteger(requested) || requested < 1_024)
    throw new ApiFault("VALIDATION_ERROR", 400);
  return Math.min(requested, MAX_RESPONSE_BYTES);
}

function getExpectedVersion(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (
    value === null ||
    !/^[1-9][0-9]*$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  ) {
    throw new ApiFault("VALIDATION_ERROR", 400);
  }
  return value;
}

function getRequestKey(headers: Headers): string {
  const value = headers.get("idempotency-key");
  if (
    value === null ||
    value.length < 8 ||
    value.length > 128 ||
    value.trim() !== value
  ) {
    throw new ApiFault("VALIDATION_ERROR", 400);
  }
  return value;
}

export class DatabaseObject extends DurableObject<DatabaseBindings> {
  private currentPausedTotalMs = 0;
  private maxPhysicalBytesPerDatabase = 128 * 1024 * 1024;
  private mutationTail: Promise<void> = Promise.resolve();
  private activityTail: Promise<void> = Promise.resolve();
  private schemaReady = false;

  constructor(ctx: DurableObjectState, env: DatabaseBindings) {
    super(ctx, env);
  }

  async ensureCreated(
    input: {
      databaseId: string;
      databaseUrl: string;
      name: string;
      description: string;
      createdAt: number;
      writeUntil: number;
    },
    creationKeyDigest: string,
    leaseToken: string,
  ): Promise<DurableCallOutcome<DatabaseResource>> {
    return await this.enqueueActivity(() =>
      this.ensureCreatedUnlocked(input, creationKeyDigest, leaseToken),
    );
  }

  private async ensureCreatedUnlocked(
    input: {
      databaseId: string;
      databaseUrl: string;
      name: string;
      description: string;
      createdAt: number;
      writeUntil: number;
    },
    creationKeyDigest: string,
    leaseToken: string,
  ): Promise<DurableCallOutcome<DatabaseResource>> {
    try {
      const authorization = await getGlobalAdmission(
        this.env,
      ).authorizeDatabaseCreation({
        databaseId: input.databaseId,
        creationKeyDigest,
        leaseToken,
      });
      if (!authorization.ok) return authorization;
      this.currentPausedTotalMs = authorization.result.pausedTotalMs;
      this.maxPhysicalBytesPerDatabase =
        authorization.result.maxPhysicalBytesPerDatabase;
      if (authorization.result.mayInitialize) {
        this.migrate();
        this.schemaReady = true;
      }
      let reusedExisting = false;
      const result = this.transaction(() => {
        const existing = this.metadata();
        if (existing) {
          if (
            existing.database_id !== input.databaseId ||
            existing.database_url !== input.databaseUrl ||
            existing.name !== input.name ||
            existing.description !== input.description ||
            existing.created_at !== input.createdAt ||
            existing.write_until !== input.writeUntil
          )
            throw new ApiFault("IDEMPOTENCY_CONFLICT", 409);
          reusedExisting = true;
          this.assertPhysicalLimit();
          return this.databaseResource(existing, Date.now());
        }
        if (!authorization.result.mayInitialize)
          throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
            reason: "databaseStateUnavailable",
          });
        this.ctx.storage.sql.exec(
          `INSERT INTO database_state
            (singleton, database_id, database_url, name, description, created_at, write_until,
             last_activity_at, last_activity_paused_total_ms, usage_version,
             quota_day, daily_requests, daily_mutations, daily_returned_bytes)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, 0, 0)`,
          input.databaseId,
          input.databaseUrl,
          input.name,
          input.description,
          input.createdAt,
          input.writeUntil,
          input.createdAt,
          authorization.result.pausedTotalMs,
          utcDay(input.createdAt),
        );
        const row = this.metadata();
        if (!row) throw new Error("database state insert did not persist");
        this.assertPhysicalLimit();
        return this.databaseResource(row, Date.now());
      });
      await this.scheduleInactivityAlarm(result.databaseId);
      const stillAuthorized = await getGlobalAdmission(
        this.env,
      ).authorizeDatabaseCreation({
        databaseId: result.databaseId,
        creationKeyDigest,
        leaseToken,
      });
      if (!stillAuthorized.ok) return stillAuthorized;
      if (!stillAuthorized.result.mayInitialize && !reusedExisting) {
        return errorOutcome(
          new ApiFault("CAPACITY_UNAVAILABLE", 503, {
            reason: "databaseStateUnavailable",
          }),
        );
      }
      return { ok: true, result };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  getUsage(): DurableCallOutcome<DatabaseUsage> {
    try {
      const metadata = this.metadata();
      if (!metadata) throw new ApiFault("NOT_FOUND", 404);
      return { ok: true, result: this.measureUsage(metadata) };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async reconcileMutation(
    databaseId: string,
    operationKey: string,
  ): Promise<
    DurableCallOutcome<{ committed: boolean; usage?: DatabaseUsage }>
  > {
    return await this.enqueueActivity(async () => {
      try {
        const metadata = this.metadata();
        const registry = getGlobalAdmission(this.env);
        if (!metadata) {
          const released = await registry.releaseMutation(
            databaseId,
            operationKey,
          );
          if (!released.ok) return released;
          return { ok: true, result: { committed: false } };
        }
        if (metadata.database_id !== databaseId)
          throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
            reason: "databaseIdentityMismatch",
          });
        const committed =
          this.ctx.storage.sql
            .exec<{ request_key: string }>(
              "SELECT request_key FROM mutation_outcomes WHERE request_key = ?",
              operationKey,
            )
            .toArray().length > 0;
        if (!committed) {
          const released = await registry.releaseMutation(
            databaseId,
            operationKey,
          );
          if (!released.ok) return released;
          return { ok: true, result: { committed: false } };
        }
        const usage = this.measureUsage(metadata);
        const settled = await registry.settleMutation(
          databaseId,
          operationKey,
          usage,
        );
        if (!settled.ok) return settled;
        return { ok: true, result: { committed: true, usage } };
      } catch (error) {
        return errorOutcome(error);
      }
    });
  }

  async reconcileExport(
    databaseId: string,
    exportKey: string,
  ): Promise<DurableCallOutcome<"active" | "missing" | "pending">> {
    return await this.enqueueActivity(async () => {
      try {
        const registry = getGlobalAdmission(this.env);
        const hasTable =
          this.ctx.storage.sql
            .exec<{ name: string }>(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'export_snapshots'",
            )
            .toArray().length > 0;
        if (!hasTable) {
          const released = await registry.releaseExport(databaseId, exportKey);
          if (!released.ok) return released;
          return { ok: true, result: "missing" };
        }
        const metadata = this.metadata();
        if (metadata && metadata.database_id !== databaseId)
          throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
            reason: "databaseIdentityMismatch",
          });
        const snapshot = this.ctx.storage.sql
          .exec<ExportSnapshotRow>(
            "SELECT * FROM export_snapshots WHERE export_key = ?",
            exportKey,
          )
          .toArray()[0];
        if (!snapshot) {
          const released = await registry.releaseExport(databaseId, exportKey);
          if (!released.ok) return released;
          return { ok: true, result: "missing" };
        }
        if (snapshot.expires_at <= Date.now()) {
          this.deleteLocalExport(snapshot.export_id, exportKey, true);
          const released = await registry.releaseExport(databaseId, exportKey);
          if (!released.ok) return released;
          return { ok: true, result: "missing" };
        }
        const completed = await registry.completeExport({
          databaseId,
          exportKey,
          exportId: snapshot.export_id,
          snapshotBytes: snapshot.snapshot_bytes,
          expiresAt: snapshot.expires_at,
        });
        if (!completed.ok) return completed;
        const activated = await registry.activateExport(databaseId, exportKey);
        if (!activated.ok) return activated;
        return { ok: true, result: "active" };
      } catch (error) {
        return errorOutcome(error);
      }
    });
  }

  async startExport(
    requestKey: string,
  ): Promise<DurableCallOutcome<ExportManifest>> {
    return await this.enqueueMutation(() => this.startExportOnce(requestKey));
  }

  async readExport(
    exportId: string,
    cursor: string | null,
    limit: number,
    responseBudget: number,
  ): Promise<DurableCallOutcome<ExportPage>> {
    try {
      if (!exportId || exportId.length > 128)
        throw new ApiFault("VALIDATION_ERROR", 400);
      if (cursor !== null && cursor.length > 512)
        throw new ApiFault("VALIDATION_ERROR", 400, { field: "cursor" });
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > EXPORT_MAX_PAGE_ITEMS
      )
        throw new ApiFault("VALIDATION_ERROR", 400, { field: "limit" });
      await this.cleanupExpiredExports(Date.now());
      const result = this.transaction(() => {
        const now = Date.now();
        const beforeBytes = this.ctx.storage.sql.databaseSize;
        const metadata = this.requireMetadata(now);
        const snapshot = this.ctx.storage.sql
          .exec<ExportSnapshotRow>(
            "SELECT * FROM export_snapshots WHERE export_id = ?",
            exportId,
          )
          .toArray()[0];
        if (!snapshot) {
          const expired = this.ctx.storage.sql
            .exec<{ expired_at: number }>(
              "SELECT expired_at FROM expired_exports WHERE export_id = ?",
              exportId,
            )
            .toArray()[0];
          if (expired) throw new ApiFault("EXPORT_EXPIRED", 410);
          throw new ApiFault("NOT_FOUND", 404);
        }
        if (snapshot.expires_at <= now)
          throw new ApiFault("EXPORT_EXPIRED", 410);
        let position: ReturnType<typeof exportCursorPosition>;
        try {
          position = exportCursorPosition(cursor ?? undefined, exportId);
        } catch (error) {
          if (error instanceof ExportFault)
            throw new ApiFault(error.code, error.status, error.details);
          throw error;
        }
        if (
          position.itemIndex >= snapshot.item_count &&
          snapshot.item_count > 0
        )
          throw new ApiFault("VALIDATION_ERROR", 400, { field: "cursor" });
        const rows = this.ctx.storage.sql
          .exec<ExportSnapshotItemRow>(
            `SELECT item_index, item_json FROM export_snapshot_items
             WHERE export_id = ? AND item_index >= ? ORDER BY item_index LIMIT ?`,
            exportId,
            position.itemIndex,
            limit,
          )
          .toArray();
        if (rows.length === 0 && position.itemIndex < snapshot.item_count)
          throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
            reason: "exportSnapshotUnavailable",
          });
        const items = rows.map(
          (row) => JSON.parse(row.item_json) as ExportItem,
        );
        const manifest: ExportManifest = {
          exportId: snapshot.export_id,
          formatVersion: 1,
          snapshotAt: snapshot.snapshot_at,
          expiresAt: new Date(snapshot.expires_at).toISOString(),
        };
        let page: ExportPage;
        try {
          page = pageExportItemWindow(
            items,
            position.itemIndex,
            snapshot.item_count,
            manifest,
            cursor ?? undefined,
            limit,
            responseBudget,
          );
        } catch (error) {
          if (error instanceof ExportFault)
            throw new ApiFault(error.code, error.status, error.details);
          throw error;
        }
        const bytes = encodedBytes(JSON.stringify(page));
        this.resetDailyQuota(metadata, now);
        if (metadata.daily_returned_bytes + bytes > MAX_DAILY_RETURNED_BYTES)
          throw new ApiFault("QUOTA_EXCEEDED", 429, {
            quota: "returnedBytes",
            limitBytes: MAX_DAILY_RETURNED_BYTES,
          });
        metadata.daily_returned_bytes += bytes;
        metadata.last_activity_at = now;
        metadata.last_activity_paused_total_ms = this.currentPausedTotalMs;
        this.writeMetadata(metadata);
        this.assertPhysicalLimit(beforeBytes);
        return page;
      });
      await this.scheduleInactivityAlarm();
      return { ok: true, result };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async deleteRetiredStorage(
    databaseId?: string,
  ): Promise<DurableCallOutcome<void>> {
    return await this.enqueueActivity(() =>
      this.deleteRetiredStorageUnlocked(databaseId),
    );
  }

  private async deleteRetiredStorageUnlocked(
    databaseId?: string,
  ): Promise<DurableCallOutcome<void>> {
    try {
      if (!databaseId) return { ok: true, result: undefined };
      const metadata = this.metadata();
      if (metadata && metadata.database_id !== databaseId)
        throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
          reason: "databaseIdentityMismatch",
        });
      await this.ctx.storage.deleteAll();
      this.schemaReady = false;
      return { ok: true, result: undefined };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  private async startExportOnce(
    requestKey: string,
  ): Promise<DurableCallOutcome<ExportManifest>> {
    try {
      if (
        requestKey.length < 8 ||
        requestKey.length > 128 ||
        requestKey.trim() !== requestKey
      )
        throw new ApiFault("VALIDATION_ERROR", 400);
      const databaseId = this.metadata()?.database_id;
      if (!databaseId) throw new ApiFault("NOT_FOUND", 404);
      const requestKeyDigest = await fingerprint(requestKey);
      await this.cleanupExpiredExports(Date.now());
      const old = this.ctx.storage.sql
        .exec<ExportSnapshotRow>(
          "SELECT * FROM export_snapshots WHERE export_key = ?",
          requestKeyDigest,
        )
        .toArray()[0];
      const registry = getGlobalAdmission(this.env);
      if (old) {
        const manifest: ExportManifest = {
          exportId: old.export_id,
          formatVersion: 1,
          snapshotAt: old.snapshot_at,
          expiresAt: new Date(old.expires_at).toISOString(),
        };
        this.assertExportStartResponseAllowance(manifest);
        const reserved = await registry.reserveExport({
          databaseId,
          exportKey: requestKeyDigest,
          exportId: old.export_id,
          snapshotBytes: old.snapshot_bytes,
          expiresAt: old.expires_at,
        });
        if (!reserved.ok) return reserved;
        if (reserved.result.exportId !== old.export_id)
          throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
            reason: "exportReservationMismatch",
          });
        if (reserved.result.state === "pending") {
          const completed = await registry.completeExport({
            databaseId,
            exportKey: requestKeyDigest,
            exportId: old.export_id,
            snapshotBytes: old.snapshot_bytes,
            expiresAt: old.expires_at,
          });
          if (!completed.ok) return completed;
          const activated = await registry.activateExport(
            databaseId,
            requestKeyDigest,
          );
          if (!activated.ok) return activated;
        }
        this.chargeExportStartResponse(
          manifest,
          reserved.result.state === "pending",
        );
        return { ok: true, result: manifest };
      }
      const exportId = crypto.randomUUID().replaceAll("-", "");
      const snapshotAtMs = Date.now();
      const expiresAt = snapshotAtMs + EXPORT_TTL_MS;
      const manifest: ExportManifest = {
        exportId,
        formatVersion: 1,
        snapshotAt: new Date(snapshotAtMs).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
      };
      this.assertExportStartResponseAllowance(manifest);
      const reserved = await registry.reserveExport({
        databaseId,
        exportKey: requestKeyDigest,
        exportId,
        snapshotBytes: EXPORT_MAX_SNAPSHOT_BYTES,
        expiresAt,
      });
      if (!reserved.ok) return reserved;
      if (reserved.result.state === "active")
        throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
          reason: "exportSnapshotUnavailable",
        });
      const effectiveExportId = reserved.result.exportId;
      let items: ExportItem[];
      let serialized: ReturnType<typeof serializeExportItems>;
      try {
        const snapshot = this.transaction(() => {
          const beforeBytes = this.ctx.storage.sql.databaseSize;
          const metadata = this.requireMetadata(snapshotAtMs);
          const exportMetadata = {
            ...metadata,
            last_activity_at: snapshotAtMs,
            last_activity_paused_total_ms: this.currentPausedTotalMs,
          };
          const database = this.databaseResource(exportMetadata, snapshotAtMs);
          const tables = this.ctx.storage.sql
            .exec<TableRow>("SELECT * FROM tables ORDER BY id")
            .toArray()
            .map((row) => this.tableResource(row));
          const columns = this.ctx.storage.sql
            .exec<ColumnRow>("SELECT * FROM columns ORDER BY id")
            .toArray()
            .map((row) => ({
              ...this.columnResource(row),
              tableId: row.table_id,
            }));
          const records = this.ctx.storage.sql
            .exec<RecordRow>("SELECT * FROM records ORDER BY id")
            .toArray()
            .map((row) => ({
              ...this.recordResource(row),
              tableId: row.table_id,
            }));
          const built = buildExportItems(
            {
              name: database.name,
              description: database.description,
              createdAt: database.createdAt,
              writeUntil: database.writeUntil,
              lastActivityAt: database.lastActivityAt,
              state: database.state,
            },
            tables,
            columns,
            records,
          );
          this.assertPhysicalLimit(beforeBytes);
          return { items: built, serialized: serializeExportItems(built) };
        });
        items = snapshot.items;
        serialized = snapshot.serialized;
        if (serialized.bytes > EXPORT_MAX_SNAPSHOT_BYTES)
          throw new ApiFault("RESULT_TOO_LARGE", 413, {
            maxBytes: EXPORT_MAX_SNAPSHOT_BYTES,
          });
      } catch (error) {
        await registry.releaseExport(databaseId, requestKeyDigest);
        throw error;
      }

      const storedManifest: ExportManifest = {
        exportId: effectiveExportId,
        formatVersion: 1,
        snapshotAt: new Date(snapshotAtMs).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
      };
      try {
        this.transaction(() => {
          const beforeBytes = this.ctx.storage.sql.databaseSize;
          const existing = this.ctx.storage.sql
            .exec<ExportSnapshotRow>(
              "SELECT * FROM export_snapshots WHERE export_key = ?",
              requestKeyDigest,
            )
            .toArray()[0];
          if (existing) return;
          this.requireMetadata(Date.now());
          this.ctx.storage.sql.exec(
            `INSERT INTO export_snapshots
              (export_id, export_key, format_version, snapshot_at, expires_at,
               snapshot_bytes, item_count)
             VALUES (?, ?, 1, ?, ?, ?, ?)`,
            effectiveExportId,
            requestKeyDigest,
            storedManifest.snapshotAt,
            expiresAt,
            serialized.bytes,
            items.length,
          );
          items.forEach((item, index) => {
            this.ctx.storage.sql.exec(
              "INSERT INTO export_snapshot_items (export_id, item_index, item_json) VALUES (?, ?, ?)",
              effectiveExportId,
              index,
              JSON.stringify(item),
            );
          });
          this.assertPhysicalLimit(beforeBytes);
        });
      } catch (error) {
        const released = await registry.releaseExport(
          databaseId,
          requestKeyDigest,
        );
        if (!released.ok) return released;
        throw error;
      }
      const completed = await registry.completeExport({
        databaseId,
        exportKey: requestKeyDigest,
        exportId: effectiveExportId,
        snapshotBytes: serialized.bytes,
        expiresAt,
      });
      if (!completed.ok) return completed;
      const activated = await registry.activateExport(
        databaseId,
        requestKeyDigest,
      );
      if (!activated.ok) return activated;
      this.chargeExportStartResponse(storedManifest, true);
      return { ok: true, result: storedManifest };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  private assertExportStartResponseAllowance(manifest: ExportManifest): void {
    this.transaction(() => {
      const now = Date.now();
      const metadata = this.requireMetadata(now);
      this.resetDailyQuota(metadata, now);
      const bytes = encodedBytes(JSON.stringify(manifest));
      if (metadata.daily_returned_bytes + bytes > MAX_DAILY_RETURNED_BYTES)
        throw new ApiFault("QUOTA_EXCEEDED", 429, {
          quota: "returnedBytes",
          limitBytes: MAX_DAILY_RETURNED_BYTES,
        });
    });
  }

  private chargeExportStartResponse(
    manifest: ExportManifest,
    renewActivity: boolean,
  ): void {
    this.transaction(() => {
      const now = Date.now();
      const beforeBytes = this.ctx.storage.sql.databaseSize;
      const metadata = this.requireMetadata(now);
      this.resetDailyQuota(metadata, now);
      const bytes = encodedBytes(JSON.stringify(manifest));
      if (metadata.daily_returned_bytes + bytes > MAX_DAILY_RETURNED_BYTES)
        throw new ApiFault("QUOTA_EXCEEDED", 429, {
          quota: "returnedBytes",
          limitBytes: MAX_DAILY_RETURNED_BYTES,
        });
      metadata.daily_returned_bytes += bytes;
      if (renewActivity) {
        metadata.last_activity_at = now;
        metadata.last_activity_paused_total_ms = this.currentPausedTotalMs;
      }
      this.writeMetadata(metadata);
      this.assertPhysicalLimit(beforeBytes);
    });
  }

  private async cleanupExpiredExports(now: number): Promise<void> {
    const expired = this.ctx.storage.sql
      .exec<ExportSnapshotRow>(
        "SELECT * FROM export_snapshots WHERE expires_at <= ? ORDER BY expires_at LIMIT 100",
        now,
      )
      .toArray();
    for (const snapshot of expired) {
      this.deleteLocalExport(snapshot.export_id, snapshot.export_key, true);
    }
    if (expired.length === 0) return;
    const databaseId = this.metadata()?.database_id;
    if (!databaseId) return;
    const registry = getGlobalAdmission(this.env);
    for (const snapshot of expired) {
      const released = await registry.releaseExport(
        databaseId,
        snapshot.export_key,
      );
      if (!released.ok)
        throw new ApiFault(released.body.error.code, released.status, {
          ...released.body.error.details,
          reason: "expiredExportCapacityReleaseUncertain",
        });
    }
  }

  private pruneExpiredExportsLocally(now: number): void {
    const expired = this.ctx.storage.sql
      .exec<ExportSnapshotRow>(
        "SELECT * FROM export_snapshots WHERE expires_at <= ? ORDER BY expires_at LIMIT 100",
        now,
      )
      .toArray();
    for (const snapshot of expired)
      this.deleteLocalExport(snapshot.export_id, snapshot.export_key, true);
  }

  private deleteLocalExport(
    exportId: string,
    exportKey: string,
    expired = false,
  ): void {
    this.transaction(() => {
      const beforeBytes = this.ctx.storage.sql.databaseSize;
      if (expired) {
        const row = this.ctx.storage.sql
          .exec<{ expires_at: number }>(
            "SELECT expires_at FROM export_snapshots WHERE export_id = ? AND export_key = ?",
            exportId,
            exportKey,
          )
          .toArray()[0];
        if (row) {
          this.ctx.storage.sql.exec(
            "INSERT OR IGNORE INTO expired_exports (export_id, expired_at) VALUES (?, ?)",
            exportId,
            row.expires_at,
          );
        }
      }
      this.ctx.storage.sql.exec(
        "DELETE FROM export_snapshot_items WHERE export_id = ?",
        exportId,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM export_snapshots WHERE export_id = ? AND export_key = ?",
        exportId,
        exportKey,
      );
      if (expired) {
        const cutoff = Date.now() - EXPORT_TTL_MS;
        this.ctx.storage.sql.exec(
          "DELETE FROM expired_exports WHERE expired_at <= ?",
          cutoff,
        );
        this.ctx.storage.sql.exec(
          `DELETE FROM expired_exports WHERE export_id IN (
             SELECT export_id FROM expired_exports ORDER BY expired_at DESC LIMIT -1 OFFSET ?
           )`,
          MAX_EXPIRED_EXPORT_TOMBSTONES,
        );
        const metadata = this.metadata();
        if (metadata) this.writeMetadata(metadata);
      }
      this.assertPhysicalLimit(beforeBytes);
    });
  }

  private async enqueueMutation<T>(work: () => Promise<T> | T): Promise<T> {
    const previous = this.mutationTail;
    let release = (): void => {};
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private async enqueueActivity<T>(work: () => Promise<T> | T): Promise<T> {
    const previous = this.activityTail;
    let release = (): void => {};
    this.activityTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  async alarm(): Promise<void> {
    await this.enqueueActivity(() => this.alarmUnlocked());
  }

  private async alarmUnlocked(): Promise<void> {
    const metadata = this.metadata();
    if (!metadata) return;
    const databaseId = metadata.database_id;
    const registry = getGlobalAdmission(this.env);
    const clock = await registry.getServiceClock();
    if (!clock.ok) {
      await this.ctx.storage.setAlarm(Date.now() + OBJECT_ALARM_RETRY_MS);
      return;
    }
    this.currentPausedTotalMs = clock.result.pausedTotalMs;
    this.maxPhysicalBytesPerDatabase = clock.result.maxPhysicalBytesPerDatabase;
    this.pruneExpiredExportsLocally(Date.now());
    const pausedSinceActivity = Math.max(
      0,
      this.currentPausedTotalMs - metadata.last_activity_paused_total_ms,
    );
    const inactiveFor =
      Date.now() - metadata.last_activity_at - pausedSinceActivity;
    if (inactiveFor >= INACTIVITY_MS) {
      const retiring = await registry.retireDatabase(databaseId);
      if (!retiring.ok || !retiring.result) {
        await this.ctx.storage.setAlarm(Date.now() + OBJECT_ALARM_RETRY_MS);
        return;
      }
      await this.ctx.storage.deleteAll();
      this.schemaReady = false;
      return;
    }
    await this.scheduleInactivityAlarm(databaseId);
  }

  isInitialized(): DurableCallOutcome<boolean> {
    try {
      return { ok: true, result: this.metadata() !== undefined };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async fetch(request: Request): Promise<Response> {
    return await this.enqueueActivity(() => this.fetchUnlocked(request));
  }

  private async fetchUnlocked(request: Request): Promise<Response> {
    let admittedDatabaseId: string | undefined;
    try {
      const admission = getGlobalAdmission(this.env);
      const clock = await admission.getServiceClock();
      if (!clock.ok) return this.outcomeResponse(clock);
      this.currentPausedTotalMs = clock.result.pausedTotalMs;
      this.maxPhysicalBytesPerDatabase =
        clock.result.maxPhysicalBytesPerDatabase;
      if (clock.result.suspended)
        throw new ApiFault("SERVICE_SUSPENDED", 503, {
          policyRevision: clock.result.policyRevision,
        });
      const targetDatabaseId = this.databaseIdFromRequest(request);
      if (!targetDatabaseId) throw new ApiFault("NOT_FOUND", 404);
      const serving = await admission.isDatabaseServing(targetDatabaseId);
      if (!serving.ok) return this.outcomeResponse(serving);
      if (!serving.result) throw new ApiFault("NOT_FOUND", 404);
      // Only known, active slugs may touch their SQLite database. This additive
      // migration also upgrades databases created by the local pilot.
      if (!this.metadata()) throw new ApiFault("NOT_FOUND", 404);
      if (!this.schemaReady) {
        this.migrate();
        this.schemaReady = true;
      }
      const url = new URL(request.url);
      const route = this.matchRoute(url, request.method);
      if (!route) throw new ApiFault("NOT_FOUND", 404);
      const now = Date.now();
      this.admitRequest(now);
      admittedDatabaseId = targetDatabaseId;
      const maxResponseBytes = responseBudget(request.headers);
      const body = route.mutating
        ? await this.readJsonBody(request)
        : undefined;
      let response: Response | undefined;
      const mutationBody = body ?? {};
      switch (route.operation) {
        case "get_database":
          response = Response.json(
            this.read(
              () => this.readDatabase(Date.now()),
              false,
              now,
              maxResponseBytes,
            ),
          );
          break;
        case "create_table":
          response = this.toResponse(
            await this.createTable(
              mutationBody,
              getRequestKey(request.headers),
              maxResponseBytes,
            ),
          );
          break;
        case "list_tables":
          response = Response.json(
            this.read(
              () => this.listTables(url, maxResponseBytes),
              false,
              now,
              maxResponseBytes,
            ),
          );
          break;
        case "get_table":
          response = Response.json(
            this.read(
              () => this.getTable(route.tableId!),
              false,
              now,
              maxResponseBytes,
            ),
          );
          break;
        case "create_column":
          response = this.toResponse(
            await this.createColumn(
              route.tableId!,
              mutationBody,
              getRequestKey(request.headers),
              getExpectedVersion(request.headers, "x-expected-schema-version"),
              maxResponseBytes,
            ),
          );
          break;
        case "list_columns":
          response = Response.json(
            this.read(
              () => this.listColumns(route.tableId!, url, maxResponseBytes),
              false,
              now,
              maxResponseBytes,
            ),
          );
          break;
        case "get_column":
          response = Response.json(
            this.read(
              () => this.getColumn(route.tableId!, route.columnId!),
              false,
              now,
              maxResponseBytes,
            ),
          );
          break;
        case "create_record":
          response = this.toResponse(
            await this.createRecord(
              route.tableId!,
              mutationBody,
              getRequestKey(request.headers),
              maxResponseBytes,
            ),
          );
          break;
        case "list_records":
          response = Response.json(
            this.read(
              () => this.listRecords(route.tableId!, url, maxResponseBytes),
              true,
              now,
              maxResponseBytes,
            ),
          );
          break;
        case "get_record":
          response = Response.json(
            this.read(
              () => this.getRecord(route.tableId!, route.recordId!),
              true,
              now,
              maxResponseBytes,
            ),
          );
          break;
        case "update_record":
          response = this.toResponse(
            await this.updateRecord(
              route.tableId!,
              route.recordId!,
              mutationBody,
              getRequestKey(request.headers),
              getExpectedVersion(request.headers, "x-expected-version"),
              maxResponseBytes,
            ),
          );
          break;
        case "delete_record":
          response = this.toResponse(
            await this.deleteRecord(
              route.tableId!,
              route.recordId!,
              getRequestKey(request.headers),
              getExpectedVersion(request.headers, "x-expected-version"),
              maxResponseBytes,
            ),
          );
          break;
        case "start_export": {
          const outcome = await this.startExport(
            getRequestKey(request.headers),
          );
          response = outcome.ok
            ? Response.json(outcome.result, { status: 201 })
            : this.outcomeResponse(outcome);
          break;
        }
        case "read_export": {
          const outcome = await this.readExport(
            route.exportId!,
            url.searchParams.get("cursor"),
            exportPageLimit(url),
            maxResponseBytes,
          );
          response = outcome.ok
            ? Response.json(outcome.result)
            : this.outcomeResponse(outcome);
          break;
        }
        default:
          throw new ApiFault("NOT_FOUND", 404);
      }
      if (!response) throw new ApiFault("NOT_FOUND", 404);
      response.headers.set("cache-control", "no-store");
      if (
        route.tableId &&
        ["list_columns", "get_column"].includes(route.operation)
      ) {
        response.headers.set(
          "x-schema-version",
          String(this.tableRow(route.tableId).schema_version),
        );
      }
      await this.scheduleInactivityAlarm();
      const usage = this.getUsage();
      if (usage.ok)
        await admission.reportDatabaseUsage(targetDatabaseId, usage.result);
      return response;
    } catch (error) {
      if (admittedDatabaseId) {
        const usage = this.getUsage();
        if (usage.ok) {
          try {
            await getGlobalAdmission(this.env).reportDatabaseUsage(
              admittedDatabaseId,
              usage.result,
            );
          } catch {
            // The fixed physical reservation remains charged if reporting is uncertain.
          }
        }
      }
      return errorResponse(error);
    }
  }

  private databaseIdFromRequest(request: Request): string {
    const parts = new URL(request.url).pathname.split("/").filter(Boolean);
    return parts[0] === "v1" && parts[1] === "databases"
      ? (parts[2] ?? "")
      : "";
  }

  private outcomeResponse<T>(
    outcome: Extract<DurableCallOutcome<T>, { ok: false }>,
  ): Response {
    return Response.json(outcome.body, {
      status: outcome.status,
      headers: outcome.headers,
    });
  }

  private matchRoute(
    url: URL,
    method: string,
  ):
    | {
        operation: string;
        tableId?: string;
        columnId?: string;
        recordId?: string;
        exportId?: string;
        mutating: boolean;
      }
    | undefined {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 3 || parts[0] !== "v1" || parts[1] !== "databases")
      return undefined;
    const metadata = this.metadata();
    if (!metadata || parts[2] !== metadata.database_id)
      throw new ApiFault("NOT_FOUND", 404);
    if (parts.length === 3 && method === "GET")
      return { operation: "get_database", mutating: false };
    if (parts.length === 4 && parts[3] === "exports" && method === "POST")
      return { operation: "start_export", mutating: false };
    if (parts.length === 5 && parts[3] === "exports" && method === "GET")
      return {
        operation: "read_export",
        exportId: parts[4],
        mutating: false,
      };
    if (parts[3] !== "tables") return undefined;
    if (parts.length === 4 && method === "POST")
      return { operation: "create_table", mutating: true };
    if (parts.length === 4 && method === "GET")
      return { operation: "list_tables", mutating: false };
    const tableId = parts[4];
    if (!tableId) return undefined;
    if (parts.length === 5 && method === "GET")
      return { operation: "get_table", tableId, mutating: false };
    if (parts.length === 6 && parts[5] === "columns") {
      if (method === "POST")
        return { operation: "create_column", tableId, mutating: true };
      if (method === "GET")
        return { operation: "list_columns", tableId, mutating: false };
      return undefined;
    }
    if (parts.length === 7 && parts[5] === "columns" && method === "GET") {
      return {
        operation: "get_column",
        tableId,
        columnId: parts[6],
        mutating: false,
      };
    }
    if (parts.length === 6 && parts[5] === "records") {
      if (method === "POST")
        return { operation: "create_record", tableId, mutating: true };
      if (method === "GET")
        return { operation: "list_records", tableId, mutating: false };
      return undefined;
    }
    if (parts.length === 7 && parts[5] === "records") {
      if (method === "GET")
        return {
          operation: "get_record",
          tableId,
          recordId: parts[6],
          mutating: false,
        };
      if (method === "PATCH")
        return {
          operation: "update_record",
          tableId,
          recordId: parts[6],
          mutating: true,
        };
      if (method === "DELETE")
        return {
          operation: "delete_record",
          tableId,
          recordId: parts[6],
          mutating: false,
        };
    }
    return undefined;
  }

  private transaction<T>(callback: () => T): T {
    return this.ctx.storage.transactionSync(callback);
  }

  private migrate(): void {
    this.transaction(() => {
      const beforeBytes = this.ctx.storage.sql.databaseSize;
      const sql = this.ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS database_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        database_id TEXT NOT NULL,
        database_url TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        write_until INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        last_activity_paused_total_ms INTEGER NOT NULL DEFAULT 0,
        usage_version INTEGER NOT NULL DEFAULT 0,
        quota_day TEXT NOT NULL,
        daily_requests INTEGER NOT NULL,
        daily_mutations INTEGER NOT NULL,
        daily_returned_bytes INTEGER NOT NULL
      )`);
      const stateColumns = sql
        .exec<{ name: string }>("PRAGMA table_info(database_state)")
        .toArray();
      if (
        !stateColumns.some(
          (column) => column.name === "last_activity_paused_total_ms",
        )
      )
        sql.exec(
          "ALTER TABLE database_state ADD COLUMN last_activity_paused_total_ms INTEGER NOT NULL DEFAULT 0",
        );
      if (!stateColumns.some((column) => column.name === "usage_version"))
        sql.exec(
          "ALTER TABLE database_state ADD COLUMN usage_version INTEGER NOT NULL DEFAULT 0",
        );
      sql.exec(`CREATE TABLE IF NOT EXISTS tables (
        id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        description TEXT NOT NULL, schema_version INTEGER NOT NULL
      )`);
      sql.exec(`CREATE TABLE IF NOT EXISTS columns (
        id TEXT PRIMARY KEY, table_id TEXT NOT NULL, name TEXT NOT NULL COLLATE NOCASE,
        type TEXT NOT NULL CHECK (type IN ('string', 'number', 'boolean')),
        nullable INTEGER NOT NULL CHECK (nullable IN (0, 1)), UNIQUE(table_id, name)
      )`);
      sql.exec(`CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY, table_id TEXT NOT NULL, values_json TEXT NOT NULL,
        version INTEGER NOT NULL
      )`);
      sql.exec(
        `CREATE INDEX IF NOT EXISTS records_by_table ON records(table_id, id)`,
      );
      sql.exec(`CREATE TABLE IF NOT EXISTS mutation_outcomes (
        request_key TEXT PRIMARY KEY, request_fingerprint TEXT NOT NULL,
        response_status INTEGER NOT NULL, response_json TEXT NOT NULL,
        response_headers_json TEXT NOT NULL DEFAULT '{}',
        response_bytes INTEGER NOT NULL, completed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      )`);
      const outcomeColumns = sql
        .exec<{ name: string }>("PRAGMA table_info(mutation_outcomes)")
        .toArray();
      if (
        !outcomeColumns.some(
          (column) => column.name === "response_headers_json",
        )
      ) {
        sql.exec(
          "ALTER TABLE mutation_outcomes ADD COLUMN response_headers_json TEXT NOT NULL DEFAULT '{}'",
        );
      }
      sql.exec(
        `CREATE INDEX IF NOT EXISTS mutation_outcomes_expiry ON mutation_outcomes(expires_at)`,
      );
      sql.exec(`CREATE TABLE IF NOT EXISTS request_timestamps (
        request_at INTEGER NOT NULL
      )`);
      sql.exec(
        `CREATE INDEX IF NOT EXISTS request_timestamps_at ON request_timestamps(request_at)`,
      );
      sql.exec(`CREATE TABLE IF NOT EXISTS export_snapshots (
        export_id TEXT PRIMARY KEY,
        export_key TEXT NOT NULL UNIQUE,
        format_version INTEGER NOT NULL CHECK (format_version = 1),
        snapshot_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        snapshot_bytes INTEGER NOT NULL,
        item_count INTEGER NOT NULL
      )`);
      sql.exec(`CREATE TABLE IF NOT EXISTS export_snapshot_items (
        export_id TEXT NOT NULL,
        item_index INTEGER NOT NULL,
        item_json TEXT NOT NULL,
        PRIMARY KEY (export_id, item_index)
      )`);
      sql.exec(
        "CREATE INDEX IF NOT EXISTS export_snapshots_expiry ON export_snapshots(expires_at)",
      );
      sql.exec(`CREATE TABLE IF NOT EXISTS expired_exports (
        export_id TEXT PRIMARY KEY,
        expired_at INTEGER NOT NULL
      )`);
      sql.exec(
        "CREATE INDEX IF NOT EXISTS expired_exports_at ON expired_exports(expired_at)",
      );
      const metadata = this.metadata();
      if (metadata) this.writeMetadata(metadata);
      this.assertPhysicalLimit(beforeBytes);
    });
  }

  private metadata(): MetadataRow | undefined {
    const hasTable =
      this.ctx.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'database_state'",
        )
        .toArray().length > 0;
    if (!hasTable) return undefined;
    return this.ctx.storage.sql
      .exec<MetadataRow>("SELECT * FROM database_state WHERE singleton = 1")
      .toArray()[0];
  }

  private requireMetadata(now: number): MetadataRow {
    const metadata = this.metadata();
    const pausedSinceActivity = metadata
      ? Math.max(
          0,
          this.currentPausedTotalMs - metadata.last_activity_paused_total_ms,
        )
      : 0;
    if (
      !metadata ||
      metadata.database_id.length === 0 ||
      now - metadata.last_activity_at - pausedSinceActivity >= INACTIVITY_MS
    ) {
      throw new ApiFault("NOT_FOUND", 404);
    }
    return metadata;
  }

  private writeMetadata(metadata: MetadataRow): void {
    metadata.usage_version += 1;
    this.ctx.storage.sql.exec(
      `UPDATE database_state SET database_url = ?, name = ?, description = ?, created_at = ?,
       write_until = ?, last_activity_at = ?, last_activity_paused_total_ms = ?,
       usage_version = ?, quota_day = ?, daily_requests = ?, daily_mutations = ?,
       daily_returned_bytes = ? WHERE singleton = 1`,
      metadata.database_url,
      metadata.name,
      metadata.description,
      metadata.created_at,
      metadata.write_until,
      metadata.last_activity_at,
      metadata.last_activity_paused_total_ms,
      metadata.usage_version,
      metadata.quota_day,
      metadata.daily_requests,
      metadata.daily_mutations,
      metadata.daily_returned_bytes,
    );
  }

  private databaseResource(
    metadata: MetadataRow,
    now: number,
  ): DatabaseResource {
    return {
      databaseId: metadata.database_id,
      databaseUrl: metadata.database_url,
      name: metadata.name,
      description: metadata.description,
      createdAt: new Date(metadata.created_at).toISOString(),
      writeUntil: new Date(metadata.write_until).toISOString(),
      lastActivityAt: new Date(metadata.last_activity_at).toISOString(),
      state: now < metadata.write_until ? "writable" : "read_only",
      accessWarning: ACCESS_WARNING,
    };
  }

  private read<T>(
    operation: () => T,
    renewActivity: boolean,
    _requestTime: number,
    maxResponseBytes: number,
  ): T {
    return this.transaction(() => {
      const currentTime = Date.now();
      const beforeBytes = this.ctx.storage.sql.databaseSize;
      const metadata = this.requireMetadata(currentTime);
      this.resetDailyQuota(metadata, currentTime);
      const result = operation();
      const responseBytes = encodedBytes(JSON.stringify(result));
      if (responseBytes > maxResponseBytes) {
        throw new ApiFault("RESULT_TOO_LARGE", 413, {
          maxBytes: maxResponseBytes,
        });
      }
      if (
        metadata.daily_returned_bytes + responseBytes >
        MAX_DAILY_RETURNED_BYTES
      ) {
        throw new ApiFault("QUOTA_EXCEEDED", 429, {
          quota: "returnedBytes",
          limitBytes: MAX_DAILY_RETURNED_BYTES,
        });
      }
      metadata.daily_returned_bytes += responseBytes;
      if (renewActivity) {
        metadata.last_activity_at = currentTime;
        metadata.last_activity_paused_total_ms = this.currentPausedTotalMs;
      }
      this.writeMetadata(metadata);
      this.assertPhysicalLimit(beforeBytes);
      return result;
    });
  }

  private admitRequest(now: number): void {
    this.transaction(() => {
      const beforeBytes = this.ctx.storage.sql.databaseSize;
      const metadata = this.requireMetadata(now);
      this.resetDailyQuota(metadata, now);
      if (metadata.daily_requests >= MAX_DAILY_REQUESTS) {
        throw new ApiFault("QUOTA_EXCEEDED", 429, {
          quota: "requests",
          limit: MAX_DAILY_REQUESTS,
        });
      }
      this.ctx.storage.sql.exec(
        "DELETE FROM request_timestamps WHERE request_at <= ?",
        now - 60_000,
      );
      const active =
        this.ctx.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM request_timestamps",
          )
          .toArray()[0]?.count ?? 0;
      if (active >= MAX_REQUESTS_PER_MINUTE) {
        throw new ApiFault("QUOTA_EXCEEDED", 429, {
          quota: "requestsPerMinute",
          limit: MAX_REQUESTS_PER_MINUTE,
        });
      }
      metadata.daily_requests += 1;
      this.writeMetadata(metadata);
      this.ctx.storage.sql.exec(
        "INSERT INTO request_timestamps (request_at) VALUES (?)",
        now,
      );
      this.assertPhysicalLimit(beforeBytes);
    });
  }

  private resetDailyQuota(metadata: MetadataRow, now: number): void {
    const day = utcDay(now);
    if (metadata.quota_day !== day) {
      metadata.quota_day = day;
      metadata.daily_requests = 0;
      metadata.daily_mutations = 0;
      metadata.daily_returned_bytes = 0;
    }
  }

  private measureUsage(metadata: MetadataRow): DatabaseUsage {
    return {
      logicalBytes: this.logicalStorageBytes(metadata),
      replayBytes: this.replayStorageBytes(),
      physicalBytes: this.ctx.storage.sql.databaseSize,
      version: metadata.usage_version,
    };
  }

  private assertPhysicalLimit(beforeBytes?: number): void {
    const physicalBytes = this.ctx.storage.sql.databaseSize;
    if (
      physicalBytes > this.maxPhysicalBytesPerDatabase &&
      (beforeBytes === undefined || physicalBytes > beforeBytes)
    ) {
      throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
        quota: "physicalBytesPerDatabase",
        maxBytes: this.maxPhysicalBytesPerDatabase,
        usedBytes: physicalBytes,
      });
    }
  }

  private async scheduleInactivityAlarm(databaseId?: string): Promise<void> {
    const metadata = this.metadata();
    if (!metadata || (databaseId && metadata.database_id !== databaseId))
      return;
    const pausedSinceActivity = Math.max(
      0,
      this.currentPausedTotalMs - metadata.last_activity_paused_total_ms,
    );
    const elapsed = Math.max(
      0,
      Date.now() - metadata.last_activity_at - pausedSinceActivity,
    );
    const delay = Math.max(1, INACTIVITY_MS - elapsed);
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  private async readJsonBody(
    request: Request,
  ): Promise<Record<string, unknown>> {
    const contentType = request.headers.get("content-type") ?? "";
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      throw new ApiFault("UNSUPPORTED_MEDIA_TYPE", 415);
    }
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_REQUEST_BYTES)
      throw new ApiFault("REQUEST_TOO_LARGE", 413, {
        maxBytes: MAX_REQUEST_BYTES,
      });
    if (!request.body) throw new ApiFault("INVALID_JSON", 400);
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new ApiFault("REQUEST_TOO_LARGE", 413, {
          maxBytes: MAX_REQUEST_BYTES,
        });
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return parseObject(JSON.parse(new TextDecoder().decode(bytes)), [
        "name",
        "description",
        "type",
        "nullable",
        "values",
      ]);
    } catch (error) {
      if (error instanceof ApiFault) throw error;
      throw new ApiFault("INVALID_JSON", 400);
    }
  }

  private toResponse<T>(outcome: MutationOutcome<T>): Response {
    if (outcome.status === 204) return new Response(null, { status: 204 });
    return Response.json(outcome.body, {
      status: outcome.status,
      headers: outcome.headers,
    });
  }

  private async mutate<T>(
    operation: string,
    target: Record<string, unknown>,
    input: unknown,
    context: MutationContext,
    status: number,
    _requestTime: number,
    maxResponseBytes: number,
    apply: (metadata: MetadataRow) => T | null,
    makeResponseHeaders?: () => Record<string, string>,
  ): Promise<MutationOutcome<T>> {
    // Keep each committed resource mutation returnable through both REST and the
    // JSON-RPC MCP envelope, whose complete response shares the 256 KiB cap.
    const mutationResponseBudget = Math.min(
      maxResponseBytes,
      MAX_MUTATION_RESULT_BYTES,
    );
    const requestFingerprint = await fingerprint({
      operation,
      target,
      input,
      expectedVersion: context.expectedVersion ?? null,
      expectedSchemaVersion: context.expectedSchemaVersion ?? null,
    });
    const requestKeyDigest = await fingerprint(context.requestKey);
    // Expired replay cleanup is an independent durable step. A later failed
    // write must not restore outcomes that have passed their retention window.
    this.transaction(() => this.cleanupExpiredOutcomes(Date.now()));
    const replay = this.transaction(() =>
      this.readMutationReplay<T>(
        requestKeyDigest,
        requestFingerprint,
        mutationResponseBudget,
        Date.now(),
      ),
    );
    if (replay) return replay;

    const databaseId = String(target.databaseId ?? "");
    if (!databaseId) throw new ApiFault("NOT_FOUND", 404);
    const registry = getGlobalAdmission(this.env);
    const reservation = await registry.reserveMutation({
      databaseId,
      operationKey: requestKeyDigest,
      operationFingerprint: requestFingerprint,
      logicalBytes: MUTATION_LOGICAL_RESERVATION_BYTES,
      replayBytes: MUTATION_REPLAY_RESERVATION_BYTES,
    });
    if (!reservation.ok)
      throw new ApiFault(
        reservation.body.error.code,
        reservation.status,
        reservation.body.error.details,
      );

    let committed = false;
    try {
      const outcome = this.transaction(() => {
        const currentTime = Date.now();
        const beforeBytes = this.ctx.storage.sql.databaseSize;
        const metadata = this.requireMetadata(currentTime);
        this.resetDailyQuota(metadata, currentTime);
        const previous = this.readMutationReplay<T>(
          requestKeyDigest,
          requestFingerprint,
          mutationResponseBudget,
          currentTime,
        );
        if (previous) return { replay: true as const, outcome: previous };
        if (currentTime >= metadata.write_until)
          throw new ApiFault("DATABASE_READ_ONLY", 409);
        if (metadata.daily_mutations >= MAX_DAILY_MUTATIONS) {
          throw new ApiFault("QUOTA_EXCEEDED", 429, {
            quota: "mutations",
            limit: MAX_DAILY_MUTATIONS,
          });
        }
        const body = apply(metadata);
        const responseJson = JSON.stringify(body);
        const responseBytes = body === null ? 0 : encodedBytes(responseJson);
        const responseHeaders = makeResponseHeaders?.() ?? {};
        const responseHeadersJson = JSON.stringify(responseHeaders);
        if (responseBytes > mutationResponseBudget) {
          throw new ApiFault("RESULT_TOO_LARGE", 413, {
            maxBytes: mutationResponseBudget,
          });
        }
        if (
          metadata.daily_returned_bytes + responseBytes >
          MAX_DAILY_RETURNED_BYTES
        ) {
          throw new ApiFault("QUOTA_EXCEEDED", 429, {
            quota: "returnedBytes",
            limitBytes: MAX_DAILY_RETURNED_BYTES,
          });
        }
        const logicalBytes = this.logicalStorageBytes(metadata);
        if (logicalBytes > MAX_STORAGE_BYTES) {
          throw new ApiFault("QUOTA_EXCEEDED", 429, {
            quota: "storageBytes",
            limitBytes: MAX_STORAGE_BYTES,
            usedBytes: logicalBytes,
          });
        }
        const replayBytes =
          this.replayStorageBytes() +
          responseBytes +
          encodedBytes(responseHeadersJson) +
          requestFingerprint.length +
          128;
        if (replayBytes > MAX_REPLAY_BYTES)
          throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
            quota: "replayBytes",
          });
        metadata.daily_mutations += 1;
        metadata.daily_returned_bytes += responseBytes;
        metadata.last_activity_at = currentTime;
        metadata.last_activity_paused_total_ms = this.currentPausedTotalMs;
        this.writeMetadata(metadata);
        this.ctx.storage.sql.exec(
          `INSERT INTO mutation_outcomes
            (request_key, request_fingerprint, response_status, response_json, response_headers_json, response_bytes, completed_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          requestKeyDigest,
          requestFingerprint,
          status,
          responseJson,
          responseHeadersJson,
          responseBytes,
          currentTime,
          currentTime + IDEMPOTENCY_MS,
        );
        this.assertPhysicalLimit(beforeBytes);
        return {
          replay: false as const,
          outcome: { status, body, headers: responseHeaders },
        };
      });
      if (outcome.replay) {
        await registry.releaseMutation(databaseId, requestKeyDigest);
        return outcome.outcome;
      }
      committed = true;
      const usage = this.getUsage();
      if (usage.ok)
        await registry.settleMutation(
          databaseId,
          requestKeyDigest,
          usage.result,
        );
      return outcome.outcome;
    } catch (error) {
      if (!committed)
        await registry.releaseMutation(databaseId, requestKeyDigest);
      throw error;
    }
  }

  private readMutationReplay<T>(
    requestKeyDigest: string,
    requestFingerprint: string,
    responseBudget: number,
    now: number,
  ): MutationOutcome<T> | null {
    const beforeBytes = this.ctx.storage.sql.databaseSize;
    const metadata = this.requireMetadata(now);
    this.resetDailyQuota(metadata, now);
    const previous = this.ctx.storage.sql
      .exec<{
        request_fingerprint: string;
        response_status: number;
        response_json: string;
        response_headers_json: string;
        response_bytes: number;
      }>(
        "SELECT request_fingerprint, response_status, response_json, response_headers_json, response_bytes FROM mutation_outcomes WHERE request_key = ?",
        requestKeyDigest,
      )
      .toArray()[0];
    if (!previous) return null;
    if (previous.request_fingerprint !== requestFingerprint)
      throw new ApiFault("IDEMPOTENCY_CONFLICT", 409);
    if (previous.response_bytes > responseBudget)
      throw new ApiFault("RESULT_TOO_LARGE", 413, { maxBytes: responseBudget });
    if (
      metadata.daily_returned_bytes + previous.response_bytes >
      MAX_DAILY_RETURNED_BYTES
    )
      throw new ApiFault("QUOTA_EXCEEDED", 429, {
        quota: "returnedBytes",
        limitBytes: MAX_DAILY_RETURNED_BYTES,
      });
    metadata.daily_returned_bytes += previous.response_bytes;
    this.writeMetadata(metadata);
    this.assertPhysicalLimit(beforeBytes);
    return {
      status: previous.response_status,
      body: JSON.parse(previous.response_json) as T | null,
      headers: JSON.parse(previous.response_headers_json) as Record<
        string,
        string
      >,
    };
  }

  private cleanupExpiredOutcomes(now: number): void {
    const beforeBytes = this.ctx.storage.sql.databaseSize;
    const hasExpired =
      this.ctx.storage.sql
        .exec<{ request_key: string }>(
          "SELECT request_key FROM mutation_outcomes WHERE expires_at <= ? ORDER BY expires_at LIMIT 1",
          now,
        )
        .toArray().length > 0;
    if (!hasExpired) return;
    this.ctx.storage.sql.exec(
      `DELETE FROM mutation_outcomes WHERE request_key IN
       (SELECT request_key FROM mutation_outcomes WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)`,
      now,
    );
    const metadata = this.metadata();
    if (metadata) this.writeMetadata(metadata);
    this.assertPhysicalLimit(beforeBytes);
  }

  private replayStorageBytes(): number {
    return (
      this.ctx.storage.sql
        .exec<{ bytes: number }>(
          "SELECT COALESCE(SUM(response_bytes + LENGTH(response_headers_json) + LENGTH(request_fingerprint) + 128), 0) AS bytes FROM mutation_outcomes",
        )
        .toArray()[0]?.bytes ?? 0
    );
  }

  private logicalStorageBytes(metadata: MetadataRow): number {
    const database = this.databaseResource(metadata, Date.now());
    const tables = this.ctx.storage.sql
      .exec<TableRow>("SELECT * FROM tables ORDER BY id")
      .toArray()
      .map((row) => this.tableResource(row));
    const columns = this.ctx.storage.sql
      .exec<ColumnRow>("SELECT * FROM columns ORDER BY id")
      .toArray()
      .map((row) => this.columnResource(row));
    const records = this.ctx.storage.sql
      .exec<RecordRow>("SELECT * FROM records ORDER BY id")
      .toArray()
      .map((row) => this.recordResource(row));
    return encodedBytes(JSON.stringify({ database, tables, columns, records }));
  }

  private assertTableSchema(tableId: string, expected: string): TableRow {
    const table = this.tableRow(tableId);
    if (String(table.schema_version) !== expected)
      throw new ApiFault("SCHEMA_VERSION_CONFLICT", 409, {
        currentSchemaVersion: String(table.schema_version),
      });
    return table;
  }

  private tableRow(tableId: string): TableRow {
    const table = this.ctx.storage.sql
      .exec<TableRow>("SELECT * FROM tables WHERE id = ?", tableId)
      .toArray()[0];
    if (!table) throw new ApiFault("NOT_FOUND", 404);
    return table;
  }

  private columnRows(tableId: string): ColumnRow[] {
    this.tableRow(tableId);
    return this.ctx.storage.sql
      .exec<ColumnRow>(
        "SELECT * FROM columns WHERE table_id = ? ORDER BY id",
        tableId,
      )
      .toArray();
  }

  private validateCreateValues(
    tableId: string,
    rawValues: Record<string, unknown>,
  ): Record<string, string | number | boolean | null> {
    const columns = this.columnRows(tableId);
    const values: Record<string, string | number | boolean | null> = {};
    for (const column of columns) {
      if (!Object.hasOwn(rawValues, column.id)) {
        if (column.nullable !== 1) throw new ApiFault("VALIDATION_ERROR", 400);
        values[column.id] = null;
      } else {
        const value = rawValues[column.id];
        requireCell(value, column);
        values[column.id] = value;
      }
    }
    if (
      Object.keys(rawValues).some(
        (columnId) => !columns.some((column) => column.id === columnId),
      )
    ) {
      throw new ApiFault("VALIDATION_ERROR", 400);
    }
    return values;
  }

  private tableResource(row: TableRow): TableResource {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      schemaVersion: String(row.schema_version),
    };
  }

  private columnResource(row: ColumnRow): ColumnResource {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      nullable: row.nullable === 1,
    };
  }

  private recordResource(row: RecordRow): RecordResource {
    return {
      id: row.id,
      values: JSON.parse(row.values_json) as Record<
        string,
        string | number | boolean | null
      >,
      version: String(row.version),
    };
  }

  private readDatabase(now: number): DatabaseResource {
    const metadata = this.requireMetadata(now);
    return this.databaseResource(metadata, now);
  }

  private getTable(tableId: string): TableResource {
    return this.tableResource(this.tableRow(tableId));
  }

  private getColumn(tableId: string, columnId: string): ColumnResource {
    const row = this.ctx.storage.sql
      .exec<ColumnRow>(
        "SELECT * FROM columns WHERE id = ? AND table_id = ?",
        columnId,
        tableId,
      )
      .toArray()[0];
    if (!row) throw new ApiFault("NOT_FOUND", 404);
    return this.columnResource(row);
  }

  private getRecord(tableId: string, recordId: string): RecordResource {
    const row = this.ctx.storage.sql
      .exec<RecordRow>(
        "SELECT * FROM records WHERE id = ? AND table_id = ?",
        recordId,
        tableId,
      )
      .toArray()[0];
    if (!row) throw new ApiFault("NOT_FOUND", 404);
    return this.recordResource(row);
  }

  private listTables(
    url: URL,
    maxResponseBytes: number,
  ): { items: TableResource[]; nextCursor: string | null } {
    validateQueryKeys(url, ["limit", "cursor"]);
    const limit = pageLimit(url);
    const query = stable({});
    const cursor = this.readCursor(url, "tables", query);
    const rows = this.ctx.storage.sql
      .exec<TableRow>(
        "SELECT * FROM tables WHERE id > ? ORDER BY id LIMIT ?",
        cursor?.afterId ?? "",
        limit + 1,
      )
      .toArray();
    return this.makePage(
      rows,
      limit,
      "tables",
      query,
      (row) => this.tableResource(row),
      maxResponseBytes,
    );
  }

  private listColumns(
    tableId: string,
    url: URL,
    maxResponseBytes: number,
  ): { items: ColumnResource[]; nextCursor: string | null } {
    validateQueryKeys(url, ["limit", "cursor"]);
    const limit = pageLimit(url);
    const query = stable({ tableId });
    const cursor = this.readCursor(url, `columns:${tableId}`, query);
    const rows = this.ctx.storage.sql
      .exec<ColumnRow>(
        "SELECT * FROM columns WHERE table_id = ? AND id > ? ORDER BY id LIMIT ?",
        tableId,
        cursor?.afterId ?? "",
        limit + 1,
      )
      .toArray();
    return this.makePage(
      rows,
      limit,
      `columns:${tableId}`,
      query,
      (row) => this.columnResource(row),
      maxResponseBytes,
    );
  }

  private listRecords(
    tableId: string,
    url: URL,
    maxResponseBytes: number,
  ): { items: RecordResource[]; nextCursor: string | null } {
    validateQueryKeys(url, [
      "limit",
      "cursor",
      "filterColumnId",
      "filterValue",
      "sortColumnId",
      "sortDirection",
    ]);
    const limit = pageLimit(url);
    const filterColumnId = url.searchParams.get("filterColumnId");
    const filterValueRaw = url.searchParams.get("filterValue");
    const sortColumnId = url.searchParams.get("sortColumnId");
    const sortDirection = url.searchParams.get("sortDirection") ?? "asc";
    if (
      (filterColumnId === null) !== (filterValueRaw === null) ||
      (sortColumnId === null && url.searchParams.has("sortDirection")) ||
      !["asc", "desc"].includes(sortDirection)
    ) {
      throw new ApiFault("VALIDATION_ERROR", 400);
    }
    const columns = this.columnRows(tableId);
    const filterColumn =
      filterColumnId === null
        ? undefined
        : columns.find((column) => column.id === filterColumnId);
    const sortColumn =
      sortColumnId === null
        ? undefined
        : columns.find((column) => column.id === sortColumnId);
    if (
      (filterColumnId !== null && !filterColumn) ||
      (sortColumnId !== null && !sortColumn)
    )
      throw new ApiFault("VALIDATION_ERROR", 400);
    let filterValue: string | number | boolean | null | undefined;
    if (filterColumn && filterValueRaw !== null) {
      try {
        const parsed: unknown = JSON.parse(filterValueRaw);
        if (!isCell(parsed)) throw new Error("not a scalar");
        requireCell(parsed, filterColumn);
        filterValue = parsed;
      } catch (error) {
        if (error instanceof ApiFault) throw error;
        throw new ApiFault("VALIDATION_ERROR", 400);
      }
    }
    const query = stable({
      filterColumnId,
      filterValue,
      sortColumnId,
      sortDirection,
    });
    const cursor = this.readCursor(url, `records:${tableId}`, query);
    const all = this.ctx.storage.sql
      .exec<RecordRow>(
        "SELECT * FROM records WHERE table_id = ? ORDER BY id LIMIT ?",
        tableId,
        MAX_RECORDS_PER_DATABASE + 1,
      )
      .toArray();
    if (all.length > MAX_RECORDS_PER_DATABASE)
      throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
        limit: "recordsPerDatabase",
        max: MAX_RECORDS_PER_DATABASE,
      });
    let resources = all.map((row) => this.recordResource(row));
    if (filterColumn)
      resources = resources.filter(
        (record) => record.values[filterColumn.id] === filterValue,
      );
    if (sortColumn) {
      resources.sort((left, right) => {
        const a = left.values[sortColumn.id] ?? null;
        const b = right.values[sortColumn.id] ?? null;
        if (a === null && b !== null) return 1;
        if (a !== null && b === null) return -1;
        let comparison = 0;
        if (a !== null && b !== null) comparison = a < b ? -1 : a > b ? 1 : 0;
        if (comparison !== 0 && sortDirection === "desc")
          comparison = -comparison;
        return comparison || left.id.localeCompare(right.id);
      });
    }
    if (cursor) {
      const index = resources.findIndex(
        (record) => record.id === cursor.afterId,
      );
      resources = index < 0 ? [] : resources.slice(index + 1);
    }
    const page = resources.slice(0, limit + 1);
    const hasMore = page.length > limit;
    if (hasMore) page.pop();
    return this.fitPage(
      page,
      hasMore,
      `records:${tableId}`,
      query,
      maxResponseBytes,
    );
  }

  private readCursor(
    url: URL,
    scope: string,
    query: string,
  ): Cursor | undefined {
    for (const key of url.searchParams.keys())
      if (
        !new Set([
          "limit",
          "cursor",
          "filterColumnId",
          "filterValue",
          "sortColumnId",
          "sortDirection",
        ]).has(key)
      )
        throw new ApiFault("VALIDATION_ERROR", 400);
    const encoded = url.searchParams.get("cursor");
    if (!encoded) return undefined;
    if (encoded.length > 2_048) throw new ApiFault("VALIDATION_ERROR", 400);
    const cursor = decodeCursor(encoded);
    const databaseId = this.metadata()?.database_id ?? "";
    if (
      cursor.databaseId !== databaseId ||
      cursor.scope !== scope ||
      cursor.query !== query
    )
      throw new ApiFault("VALIDATION_ERROR", 400);
    return cursor;
  }

  private makePage<Row, Item>(
    rows: Row[],
    limit: number,
    scope: string,
    query: string,
    map: (row: Row) => Item,
    maxResponseBytes: number,
    getId: (row: Row) => string = (row) => (row as { id: string }).id,
  ): { items: Item[]; nextCursor: string | null } {
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map(map);
    return this.fitPage(
      items,
      hasMore,
      scope,
      query,
      maxResponseBytes,
      (_item, index) => getId(pageRows[index]!),
    );
  }

  private fitPage<Item>(
    items: Item[],
    hasMore: boolean,
    scope: string,
    query: string,
    maxResponseBytes: number,
    getId: (item: Item, index: number) => string = (item) =>
      (item as { id: string }).id,
  ): { items: Item[]; nextCursor: string | null } {
    const metadata = this.metadata();
    if (!metadata) throw new ApiFault("NOT_FOUND", 404);
    const hadItems = items.length > 0;
    let continuation = hasMore;
    for (;;) {
      const last = items.at(-1);
      const nextCursor =
        continuation && last
          ? encodeCursor({
              v: 1,
              databaseId: metadata.database_id,
              scope,
              afterId: getId(last, items.length - 1),
              query,
            })
          : null;
      const page = { items, nextCursor };
      if (encodedBytes(JSON.stringify(page)) <= maxResponseBytes) return page;
      if (items.length === 0)
        throw new ApiFault("RESULT_TOO_LARGE", 413, {
          maxBytes: maxResponseBytes,
        });
      items.pop();
      continuation = true;
      if (hadItems && items.length === 0)
        throw new ApiFault("RESULT_TOO_LARGE", 413, {
          maxBytes: maxResponseBytes,
        });
    }
  }

  private async createTable(
    body: Record<string, unknown>,
    requestKey: string,
    maxResponseBytes: number,
  ): Promise<MutationOutcome<TableResource>> {
    const input = parseObject(body, ["name", "description"]);
    const normalized = {
      name: nonemptyName(input.name),
      description: description(input.description),
    };
    return this.mutate(
      "create_table",
      { databaseId: this.metadata()?.database_id },
      normalized,
      { requestKey },
      201,
      Date.now(),
      maxResponseBytes,
      () => {
        const count =
          this.ctx.storage.sql
            .exec<{ count: number }>("SELECT COUNT(*) AS count FROM tables")
            .toArray()[0]?.count ?? 0;
        if (count >= MAX_TABLES)
          throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
            limit: "tablesPerDatabase",
            max: MAX_TABLES,
          });
        if (
          this.ctx.storage.sql
            .exec(
              "SELECT 1 FROM tables WHERE name = ? COLLATE NOCASE",
              normalized.name,
            )
            .toArray().length > 0
        )
          throw new ApiFault("NAME_CONFLICT", 409);
        const resource: TableResource = {
          id: randomId(),
          ...normalized,
          schemaVersion: "1",
        };
        this.ctx.storage.sql.exec(
          "INSERT INTO tables (id, name, description, schema_version) VALUES (?, ?, ?, 1)",
          resource.id,
          resource.name,
          resource.description,
        );
        return resource;
      },
    );
  }

  private createColumn(
    tableId: string,
    body: Record<string, unknown>,
    requestKey: string,
    expectedSchemaVersion: string,
    maxResponseBytes: number,
  ): Promise<MutationOutcome<ColumnResource>> {
    const input = parseObject(body, ["name", "type", "nullable"]);
    const name = nonemptyName(input.name);
    if (
      input.type !== "string" &&
      input.type !== "number" &&
      input.type !== "boolean"
    )
      throw new ApiFault("VALIDATION_ERROR", 400);
    if (input.nullable !== undefined && typeof input.nullable !== "boolean")
      throw new ApiFault("VALIDATION_ERROR", 400);
    const type: ColumnResource["type"] = input.type;
    const normalized = { name, type, nullable: input.nullable ?? true };
    return this.mutate(
      "create_column",
      { databaseId: this.metadata()?.database_id, tableId },
      normalized,
      { requestKey, expectedSchemaVersion },
      201,
      Date.now(),
      maxResponseBytes,
      () => {
        this.assertTableSchema(tableId, expectedSchemaVersion);
        const count =
          this.ctx.storage.sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM columns WHERE table_id = ?",
              tableId,
            )
            .toArray()[0]?.count ?? 0;
        if (count >= MAX_COLUMNS_PER_TABLE)
          throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
            limit: "columnsPerTable",
            max: MAX_COLUMNS_PER_TABLE,
          });
        if (
          this.ctx.storage.sql
            .exec(
              "SELECT 1 FROM columns WHERE table_id = ? AND name = ? COLLATE NOCASE",
              tableId,
              name,
            )
            .toArray().length > 0
        )
          throw new ApiFault("NAME_CONFLICT", 409);
        const records = this.ctx.storage.sql
          .exec<RecordRow>("SELECT * FROM records WHERE table_id = ?", tableId)
          .toArray();
        if (!normalized.nullable && records.length > 0)
          throw new ApiFault("SCHEMA_INCOMPATIBLE", 409);
        const resource: ColumnResource = { id: randomId(), ...normalized };
        this.ctx.storage.sql.exec(
          "INSERT INTO columns (id, table_id, name, type, nullable) VALUES (?, ?, ?, ?, ?)",
          resource.id,
          tableId,
          resource.name,
          resource.type,
          resource.nullable ? 1 : 0,
        );
        if (records.length > 0) {
          for (const record of records) {
            const values = JSON.parse(record.values_json) as Record<
              string,
              string | number | boolean | null
            >;
            values[resource.id] = null;
            const nextResource: RecordResource = {
              id: record.id,
              values,
              version: String(record.version + 1),
            };
            if (
              encodedBytes(JSON.stringify(nextResource)) >
              MAX_MUTATION_RESULT_BYTES
            ) {
              throw new ApiFault("RESULT_TOO_LARGE", 413, {
                maxBytes: MAX_MUTATION_RESULT_BYTES,
              });
            }
            this.ctx.storage.sql.exec(
              "UPDATE records SET values_json = ?, version = version + 1 WHERE id = ?",
              JSON.stringify(values),
              record.id,
            );
          }
        }
        this.ctx.storage.sql.exec(
          "UPDATE tables SET schema_version = schema_version + 1 WHERE id = ?",
          tableId,
        );
        return resource;
      },
      () => ({
        "x-schema-version": String(this.tableRow(tableId).schema_version),
      }),
    );
  }

  private async createRecord(
    tableId: string,
    body: Record<string, unknown>,
    requestKey: string,
    maxResponseBytes: number,
  ): Promise<MutationOutcome<RecordResource>> {
    const input = parseObject(body, ["values"]);
    const candidateKeys =
      typeof input.values === "object" &&
      input.values !== null &&
      !Array.isArray(input.values)
        ? Object.keys(input.values)
        : [];
    const rawValues = parseObject(input.values, candidateKeys);
    for (const value of Object.values(rawValues))
      if (!isCell(value)) throw new ApiFault("VALIDATION_ERROR", 400);
    const normalized = { values: rawValues };
    return this.mutate(
      "create_record",
      { databaseId: this.metadata()?.database_id, tableId },
      normalized,
      { requestKey },
      201,
      Date.now(),
      maxResponseBytes,
      () => {
        const values = this.validateCreateValues(tableId, rawValues);
        const count =
          this.ctx.storage.sql
            .exec<{ count: number }>("SELECT COUNT(*) AS count FROM records")
            .toArray()[0]?.count ?? 0;
        if (count >= MAX_RECORDS_PER_DATABASE)
          throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
            limit: "recordsPerDatabase",
            max: MAX_RECORDS_PER_DATABASE,
          });
        const resource: RecordResource = {
          id: randomId(),
          values,
          version: "1",
        };
        this.ctx.storage.sql.exec(
          "INSERT INTO records (id, table_id, values_json, version) VALUES (?, ?, ?, 1)",
          resource.id,
          tableId,
          JSON.stringify(values),
        );
        return resource;
      },
    );
  }

  private async updateRecord(
    tableId: string,
    recordId: string,
    body: Record<string, unknown>,
    requestKey: string,
    expectedVersion: string,
    maxResponseBytes: number,
  ): Promise<MutationOutcome<RecordResource>> {
    const input = parseObject(body, ["values"]);
    const candidateKeys =
      typeof input.values === "object" &&
      input.values !== null &&
      !Array.isArray(input.values)
        ? Object.keys(input.values)
        : [];
    const values = parseObject(input.values, candidateKeys);
    if (
      Object.keys(values).length === 0 ||
      Object.values(values).some((value) => !isCell(value))
    ) {
      throw new ApiFault("VALIDATION_ERROR", 400);
    }
    const normalized: Record<string, string | number | boolean | null> = {};
    for (const [columnId, value] of Object.entries(values)) {
      if (!isCell(value)) throw new ApiFault("VALIDATION_ERROR", 400);
      normalized[columnId] = value;
    }
    return this.mutate(
      "update_record",
      { databaseId: this.metadata()?.database_id, tableId, recordId },
      { values: normalized },
      { requestKey, expectedVersion },
      200,
      Date.now(),
      maxResponseBytes,
      () => {
        const current = this.ctx.storage.sql
          .exec<RecordRow>(
            "SELECT * FROM records WHERE id = ? AND table_id = ?",
            recordId,
            tableId,
          )
          .toArray()[0];
        if (!current) throw new ApiFault("NOT_FOUND", 404);
        if (String(current.version) !== expectedVersion)
          throw new ApiFault("VERSION_CONFLICT", 409, {
            currentVersion: String(current.version),
          });
        const columns = this.columnRows(tableId);
        for (const [columnId, value] of Object.entries(normalized)) {
          const column = columns.find((candidate) => candidate.id === columnId);
          if (!column) throw new ApiFault("VALIDATION_ERROR", 400);
          requireCell(value, column);
        }
        const merged = {
          ...(JSON.parse(current.values_json) as Record<
            string,
            string | number | boolean | null
          >),
          ...normalized,
        };
        const nextVersion = current.version + 1;
        this.ctx.storage.sql.exec(
          "UPDATE records SET values_json = ?, version = ? WHERE id = ?",
          JSON.stringify(merged),
          nextVersion,
          recordId,
        );
        return { id: recordId, values: merged, version: String(nextVersion) };
      },
    );
  }

  private async deleteRecord(
    tableId: string,
    recordId: string,
    requestKey: string,
    expectedVersion: string,
    maxResponseBytes: number,
  ): Promise<MutationOutcome<null>> {
    return this.mutate(
      "delete_record",
      { databaseId: this.metadata()?.database_id, tableId, recordId },
      null,
      { requestKey, expectedVersion },
      204,
      Date.now(),
      maxResponseBytes,
      () => {
        const current = this.ctx.storage.sql
          .exec<RecordRow>(
            "SELECT * FROM records WHERE id = ? AND table_id = ?",
            recordId,
            tableId,
          )
          .toArray()[0];
        if (!current) throw new ApiFault("NOT_FOUND", 404);
        if (String(current.version) !== expectedVersion)
          throw new ApiFault("VERSION_CONFLICT", 409, {
            currentVersion: String(current.version),
          });
        this.ctx.storage.sql.exec("DELETE FROM records WHERE id = ?", recordId);
        return null;
      },
    );
  }
}
