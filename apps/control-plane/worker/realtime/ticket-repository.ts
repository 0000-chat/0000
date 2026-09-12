import {
  REALTIME_TICKET_TTL_MS,
} from "@communicator/contracts";
import {
  revalidateRealtimeAuthorization,
  type AuthorizedRealtimeRequest,
} from "./authorization";
import {
  RealtimeUpgradeContextSchema,
  type RealtimeUpgradeContext,
} from "./contracts";
import { digestRealtimeTicket, generateRealtimeTicket, isRealtimeTicket } from "./token";

export const MAX_EXPIRED_REALTIME_TICKET_CLEANUP = 100;

export type RealtimeTicketDatabase = D1Database | D1DatabaseSession;
export type RealtimeNow = Date | number | string;

export type IssuedRealtimeTicket = {
  ticket: string;
  expires_at: string;
};

export type ConsumedRealtimeAuthorization = RealtimeUpgradeContext;

export type RealtimeTicketErrorCode = "invalid_request" | "service_unavailable";

const SAFE_MESSAGES: Record<RealtimeTicketErrorCode, string> = {
  invalid_request: "Invalid realtime ticket request",
  service_unavailable: "Realtime ticket service unavailable",
};

const realtimeTicketErrorCauses = new WeakMap<RealtimeTicketError, unknown>();

export class RealtimeTicketError extends Error {
  readonly code!: RealtimeTicketErrorCode;

  constructor(code: RealtimeTicketErrorCode, cause?: unknown) {
    super(SAFE_MESSAGES[code]);
    Object.defineProperty(this, "name", {
      configurable: true,
      enumerable: false,
      value: "RealtimeTicketError",
      writable: true,
    });
    Object.defineProperty(this, "code", {
      configurable: true,
      enumerable: true,
      value: code,
      writable: false,
    });
    if (cause !== undefined) realtimeTicketErrorCauses.set(this, cause);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const getRealtimeTicketErrorCause = (
  error: RealtimeTicketError,
): unknown => realtimeTicketErrorCauses.get(error);

export const isRealtimeTicketError = (
  error: unknown,
): error is RealtimeTicketError => error instanceof RealtimeTicketError;

export const safeRealtimeTicketError = (
  error: unknown,
  fallback: RealtimeTicketErrorCode,
): RealtimeTicketError =>
  isRealtimeTicketError(error) ? error : new RealtimeTicketError(fallback, error);

export const realtimeTicketErrorResponse = (error: RealtimeTicketError) => ({
  error: {
    code: error.code,
    message: SAFE_MESSAGES[error.code],
  },
});

const EXPIRED_TICKET_CLEANUP_SQL = `
DELETE FROM realtime_tickets
WHERE ticket_digest IN (
  SELECT ticket_digest
  FROM realtime_tickets
  WHERE expires_at_ms <= ?
  ORDER BY expires_at_ms ASC, ticket_digest ASC
  LIMIT ?
)`;

const INSERT_TICKET_SQL = `
INSERT INTO realtime_tickets (
  ticket_digest,
  tenant_id,
  principal_id,
  membership_id,
  subscriptions_json,
  resume_json,
  created_at,
  expires_at,
  expires_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const CONSUME_TICKET_SQL = `
DELETE FROM realtime_tickets
WHERE ticket_digest = ?
  AND expires_at_ms > ?
RETURNING
  ticket_digest,
  tenant_id,
  principal_id,
  membership_id,
  subscriptions_json,
  resume_json,
  created_at,
  expires_at,
  expires_at_ms`;

type StoredRealtimeTicketRow = {
  ticket_digest: unknown;
  tenant_id: unknown;
  principal_id: unknown;
  membership_id: unknown;
  subscriptions_json: unknown;
  resume_json: unknown;
  created_at: unknown;
  expires_at: unknown;
  expires_at_ms: unknown;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const parseNowMilliseconds = (now: RealtimeNow): number | null => {
  const milliseconds = now instanceof Date
    ? now.getTime()
    : typeof now === "number"
      ? now
      : Date.parse(now);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) return null;
  return milliseconds;
};

const isoTimestamp = (milliseconds: number): string | null => {
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    return null;
  }
};

const primarySession = (db: RealtimeTicketDatabase): D1DatabaseSession => {
  if (
    "withSession" in db &&
    typeof db.withSession === "function"
  ) {
    return db.withSession("first-primary");
  }
  return db as D1DatabaseSession;
};

const invalidTicketRequest = (cause?: unknown): RealtimeTicketError =>
  new RealtimeTicketError("invalid_request", cause);

const unavailable = (cause: unknown): RealtimeTicketError =>
  new RealtimeTicketError("service_unavailable", cause);

const parseConsumedAuthorization = (
  row: StoredRealtimeTicketRow,
  expectedDigest: string,
  nowMilliseconds: number,
): ConsumedRealtimeAuthorization | null => {
  const expiresAtMilliseconds = row.expires_at_ms;
  if (
    typeof row.ticket_digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.ticket_digest) ||
    row.ticket_digest !== expectedDigest ||
    typeof row.subscriptions_json !== "string" ||
    typeof row.resume_json !== "string" ||
    typeof row.created_at !== "string" ||
    typeof row.expires_at !== "string" ||
    typeof expiresAtMilliseconds !== "number" ||
    !Number.isSafeInteger(expiresAtMilliseconds) ||
    expiresAtMilliseconds < 0
  ) {
    return null;
  }

  let subscriptions: unknown;
  let resume: unknown;
  try {
    subscriptions = JSON.parse(row.subscriptions_json);
    resume = JSON.parse(row.resume_json);
  } catch {
    return null;
  }

  const candidate = RealtimeUpgradeContextSchema.safeParse({
    schema_version: 1,
    tenant_id: row.tenant_id,
    principal_id: row.principal_id,
    membership_id: row.membership_id,
    subscriptions,
    resume,
    issued_at: row.created_at,
    expires_at: row.expires_at,
  });
  if (!candidate.success) return null;

  const createdMilliseconds = Date.parse(candidate.data.issued_at);
  const expiresMilliseconds = Date.parse(candidate.data.expires_at);
  if (
    !Number.isSafeInteger(createdMilliseconds) ||
    !Number.isSafeInteger(expiresMilliseconds) ||
    expiresMilliseconds - createdMilliseconds !== REALTIME_TICKET_TTL_MS ||
    expiresAtMilliseconds !== expiresMilliseconds ||
    createdMilliseconds > nowMilliseconds ||
    expiresMilliseconds <= nowMilliseconds
  ) {
    return null;
  }

  return candidate.data;
};

export async function issueRealtimeTicket(
  db: RealtimeTicketDatabase,
  authorizedRequest: AuthorizedRealtimeRequest,
  now: RealtimeNow = new Date(),
): Promise<IssuedRealtimeTicket> {
  const nowMilliseconds = parseNowMilliseconds(now);
  if (nowMilliseconds === null) throw invalidTicketRequest();

  const createdAt = isoTimestamp(nowMilliseconds);
  const expiresAt = isoTimestamp(nowMilliseconds + REALTIME_TICKET_TTL_MS);
  if (createdAt === null || expiresAt === null) throw invalidTicketRequest();

  const context = RealtimeUpgradeContextSchema.safeParse({
    ...(asRecord(authorizedRequest) ?? {}),
    schema_version: 1,
    issued_at: createdAt,
    expires_at: expiresAt,
  });
  if (!context.success) throw invalidTicketRequest(context.error);

  let ticket: string;
  let digest: string;
  try {
    ticket = generateRealtimeTicket();
    digest = await digestRealtimeTicket(ticket);
  } catch (error) {
    throw unavailable(error);
  }

  try {
    const session = primarySession(db);
    await session.prepare(EXPIRED_TICKET_CLEANUP_SQL).bind(
      nowMilliseconds,
      MAX_EXPIRED_REALTIME_TICKET_CLEANUP,
    ).run();
    await session.prepare(INSERT_TICKET_SQL).bind(
      digest,
      context.data.tenant_id,
      context.data.principal_id,
      context.data.membership_id,
      JSON.stringify(context.data.subscriptions),
      JSON.stringify(context.data.resume),
      context.data.issued_at,
      context.data.expires_at,
      nowMilliseconds + REALTIME_TICKET_TTL_MS,
    ).run();
  } catch (error) {
    throw unavailable(error);
  }

  return { ticket, expires_at: context.data.expires_at };
}

export async function consumeRealtimeTicket(
  db: RealtimeTicketDatabase,
  ticket: string,
  now: RealtimeNow = new Date(),
): Promise<ConsumedRealtimeAuthorization | null> {
  if (!isRealtimeTicket(ticket)) return null;
  const nowMilliseconds = parseNowMilliseconds(now);
  if (nowMilliseconds === null) return null;

  let digest: string;
  try {
    digest = await digestRealtimeTicket(ticket);
  } catch (error) {
    throw unavailable(error);
  }

  try {
    const session = primarySession(db);
    const row = await session.prepare(CONSUME_TICKET_SQL).bind(
      digest,
      nowMilliseconds,
    ).first<StoredRealtimeTicketRow>();
    if (row === null) return null;

    const consumed = parseConsumedAuthorization(row, digest, nowMilliseconds);
    if (consumed === null) return null;
    if (!await revalidateRealtimeAuthorization(session, consumed)) return null;
    return consumed;
  } catch (error) {
    throw unavailable(error);
  }
}
