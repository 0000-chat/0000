import { DurableObject } from "cloudflare:workers";

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
const ACCESS_WARNING =
  "Anyone with this link can read and change this database while writable. Use it at your own risk and do not store sensitive information.";

export type DatabaseBindings = {
  DATABASES: DurableObjectNamespace;
  REGISTRY: DurableObjectNamespace;
};

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
    REQUEST_TOO_LARGE: "The request body exceeds 65536 bytes",
    RESULT_TOO_LARGE: "The result exceeds 262144 bytes",
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
  constructor(ctx: DurableObjectState, env: DatabaseBindings) {
    super(ctx, env);
  }

  ensureCreated(input: {
    databaseId: string;
    databaseUrl: string;
    name: string;
    description: string;
    createdAt: number;
    writeUntil: number;
  }): DurableCallOutcome<DatabaseResource> {
    try {
      this.migrate();
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
          return this.databaseResource(existing, Date.now());
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO database_state
            (singleton, database_id, database_url, name, description, created_at, write_until,
             last_activity_at, quota_day, daily_requests, daily_mutations, daily_returned_bytes)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`,
          input.databaseId,
          input.databaseUrl,
          input.name,
          input.description,
          input.createdAt,
          input.writeUntil,
          input.createdAt,
          utcDay(input.createdAt),
        );
        const row = this.metadata();
        if (!row) throw new Error("database state insert did not persist");
        return this.databaseResource(row, Date.now());
      });
      return { ok: true, result };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  isInitialized(): DurableCallOutcome<boolean> {
    try {
      return { ok: true, result: this.metadata() !== undefined };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const route = this.matchRoute(url, request.method);
      if (!route) throw new ApiFault("NOT_FOUND", 404);
      const now = Date.now();
      this.admitRequest(now);
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
      return response;
    } catch (error) {
      return errorResponse(error);
    }
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
        quota_day TEXT NOT NULL,
        daily_requests INTEGER NOT NULL,
        daily_mutations INTEGER NOT NULL,
        daily_returned_bytes INTEGER NOT NULL
      )`);
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
    if (
      !metadata ||
      metadata.database_id.length === 0 ||
      now - metadata.last_activity_at >= INACTIVITY_MS
    ) {
      throw new ApiFault("NOT_FOUND", 404);
    }
    return metadata;
  }

  private writeMetadata(metadata: MetadataRow): void {
    this.ctx.storage.sql.exec(
      `UPDATE database_state SET database_url = ?, name = ?, description = ?, created_at = ?,
       write_until = ?, last_activity_at = ?, quota_day = ?, daily_requests = ?,
       daily_mutations = ?, daily_returned_bytes = ? WHERE singleton = 1`,
      metadata.database_url,
      metadata.name,
      metadata.description,
      metadata.created_at,
      metadata.write_until,
      metadata.last_activity_at,
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
      if (renewActivity) metadata.last_activity_at = currentTime;
      this.writeMetadata(metadata);
      return result;
    });
  }

  private admitRequest(now: number): void {
    this.transaction(() => {
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
    // Expiry pruning commits independently so a later rejected mutation cannot roll it back.
    this.transaction(() => this.cleanupExpiredOutcomes(Date.now()));
    return this.transaction(() => {
      const currentTime = Date.now();
      const metadata = this.requireMetadata(currentTime);
      this.resetDailyQuota(metadata, currentTime);
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
      if (previous) {
        if (previous.request_fingerprint !== requestFingerprint)
          throw new ApiFault("IDEMPOTENCY_CONFLICT", 409);
        if (previous.response_bytes > mutationResponseBudget) {
          throw new ApiFault("RESULT_TOO_LARGE", 413, {
            maxBytes: mutationResponseBudget,
          });
        }
        if (
          metadata.daily_returned_bytes + previous.response_bytes >
          MAX_DAILY_RETURNED_BYTES
        ) {
          throw new ApiFault("QUOTA_EXCEEDED", 429, {
            quota: "returnedBytes",
            limitBytes: MAX_DAILY_RETURNED_BYTES,
          });
        }
        metadata.daily_returned_bytes += previous.response_bytes;
        this.writeMetadata(metadata);
        return {
          status: previous.response_status,
          body: JSON.parse(previous.response_json) as T | null,
          headers: JSON.parse(previous.response_headers_json) as Record<
            string,
            string
          >,
        };
      }
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
      return { status, body, headers: responseHeaders };
    });
  }

  private cleanupExpiredOutcomes(now: number): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM mutation_outcomes WHERE request_key IN
       (SELECT request_key FROM mutation_outcomes WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)`,
      now,
    );
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
