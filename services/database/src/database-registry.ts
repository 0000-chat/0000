import { DurableObject } from "cloudflare:workers";
import {
  ApiFault,
  errorOutcome,
  type DatabaseBindings,
  type DatabaseResource,
  type DurableCallOutcome,
} from "./database-object";

const WRITE_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const CREATE_REPLAY_MS = 24 * 60 * 60 * 1_000;
const CREATE_LEASE_MS = 30 * 1_000;

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
    const databaseNamespace = this.env.DATABASES;
    const id = databaseNamespace.idFromName(reservation.intent.databaseId);
    const stub = databaseNamespace.get(id) as unknown as {
      ensureCreated: (
        input: CreateIntent,
      ) => Promise<DurableCallOutcome<DatabaseResource>>;
      isInitialized: () => Promise<DurableCallOutcome<boolean>>;
    };
    if (reservation.result) {
      const initialized = await stub.isInitialized();
      if (!initialized.ok) throw faultFromOutcome(initialized);
      if (!initialized.result)
        throw new ApiFault("CAPACITY_UNAVAILABLE", 503, {
          reason: "databaseStateUnavailable",
        });
      return reservation.result;
    }
    try {
      const initialized = await stub.ensureCreated(reservation.intent);
      if (!initialized.ok) throw faultFromOutcome(initialized);
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
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM create_reservations WHERE result_json IS NOT NULL AND expires_at <= ?",
        Date.now(),
      );
    });
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const existing = this.ctx.storage.sql
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
        if (existing.lease_until !== null && existing.lease_until > now) {
          throw new ApiFault("REQUEST_IN_PROGRESS", 409, {
            retryAfterSeconds: Math.ceil((existing.lease_until - now) / 1_000),
          });
        }
        const leaseToken = randomSlug();
        this.ctx.storage.sql.exec(
          "UPDATE create_reservations SET lease_token = ?, lease_until = ? WHERE key_digest = ?",
          leaseToken,
          now + CREATE_LEASE_MS,
          keyDigest,
        );
        return {
          intent: JSON.parse(existing.intent_json) as CreateIntent,
          leaseToken,
        };
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
         VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
        keyDigest,
        requestFingerprint,
        intent.databaseId,
        JSON.stringify(intent),
        now,
        leaseToken,
        now + CREATE_LEASE_MS,
      );
      return { intent, leaseToken };
    });
  }

  private complete(
    keyDigest: string,
    requestFingerprint: string,
    leaseToken: string,
    result: DatabaseResource,
  ): DatabaseResource {
    return this.ctx.storage.transactionSync(() => {
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
      if (existing.lease_token !== leaseToken)
        throw new ApiFault("REQUEST_IN_PROGRESS", 409, {
          retryAfterSeconds: 1,
        });
      this.ctx.storage.sql.exec(
        "UPDATE create_reservations SET result_json = ?, expires_at = ?, lease_token = NULL, lease_until = NULL WHERE key_digest = ? AND result_json IS NULL",
        JSON.stringify(result),
        Date.now() + CREATE_REPLAY_MS,
        keyDigest,
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO database_slugs (database_id, created_at) VALUES (?, ?)",
        result.databaseId,
        Date.now(),
      );
      return result;
    });
  }

  private releaseLease(keyDigest: string, leaseToken: string): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE create_reservations SET lease_token = NULL, lease_until = NULL WHERE key_digest = ? AND lease_token = ? AND result_json IS NULL",
        keyDigest,
        leaseToken,
      );
    });
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
    });
  }
}
