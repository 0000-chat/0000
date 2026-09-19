import { decryptOperationRecord, encryptOperationRecord } from "./operations-crypto";
import type { CreateRoomResponse } from "./protocol";
import type { CreationClaim, CreationOperations } from "./worker";

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<{ meta?: { changes?: number } }>;
  all<T>(): Promise<{ results: T[] }>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1Statement;
}

export interface AbuseReportInput {
  readonly capability: string;
  readonly description?: string;
}
export interface CreationPlan { readonly management: string; readonly room: string; readonly ownerGuestId?: string; }

export type AbuseReportStatus = "closed" | "open" | "reviewed";

export interface OperatorReportSummary {
  readonly created_at: number;
  readonly id: string;
  readonly status: AbuseReportStatus;
}

export interface OperatorReport extends OperatorReportSummary, AbuseReportInput {}

interface CreationRow {
  readonly expires_at: number;
  readonly lease_token: string;
  readonly plan_envelope: string;
  readonly request_fingerprint: string;
  readonly response_envelope: string | null;
  readonly state: "complete" | "pending";
  readonly updated_at: number;
}

interface ReportRow extends OperatorReportSummary {
  readonly report_envelope: string;
}

const IDP_TTL_MS = 24 * 60 * 60 * 1000;
const STALE_PENDING_MS = 60 * 1000;
const REPORT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUDIT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const PURGE_LIMIT = 50;
const maxReportDescriptionBytes = 4 * 1024;
const maxReportDescriptionChars = 2_000;

/** D1 is an operations sidecar. It must never make room reads or posts unavailable. */
export class D1OperationStore implements CreationOperations {
  constructor(
    private readonly d1: D1DatabaseLike,
    private readonly encryptionKey: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async claimCreation(key: string, fingerprint: string, guestId = "legacy-unscoped-test"): Promise<CreationClaim> {
    const now = this.now();
    await this.purge(now);
    const storageId = await this.storageId(guestId, key);
    const comparisonFingerprint = await opaque(this.encryptionKey, "creation-fingerprint", `${guestId}/${fingerprint}`);
    return this.claim(storageId, comparisonFingerprint, now, 0, guestId);
  }

  async completeCreation(key: string, leaseToken: string, response: CreateRoomResponse, guestId = "legacy-unscoped-test"): Promise<void> {
    const storageId = await this.storageId(guestId, key);
    const envelope = await encryptOperationRecord(this.encryptionKey, "creation_idempotency", storageId, response);
    const now = this.now();
    const result = await this.d1.prepare("UPDATE creation_idempotency SET state = 'complete', response_envelope = ?, updated_at = ?, lease_token = '' WHERE idempotency_key = ? AND state = 'pending' AND lease_token = ?").bind(envelope, now, storageId, leaseToken).run();
    if (result.meta?.changes !== 1) throw new Error("The creation lease is no longer valid.");
  }

  async submitReport(input: AbuseReportInput): Promise<void> {
    validateReport(input);
    const id = crypto.randomUUID();
    const envelope = await encryptOperationRecord(this.encryptionKey, "abuse_report", id, input);
    const now = this.now();
    await this.purge(now);
    await this.d1.prepare("INSERT INTO abuse_reports (id, report_envelope, created_at, expires_at, status) VALUES (?, ?, ?, ?, 'open')").bind(id, envelope, now, now + REPORT_TTL_MS).run();
  }

  async diagnostics(): Promise<{ readonly d1_configured: true }> {
    await this.d1.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    return { d1_configured: true };
  }

  async listReports(limit: number): Promise<readonly OperatorReportSummary[]> {
    const now = this.now();
    await this.purge(now);
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
    const result = await this.d1.prepare("SELECT id, status, created_at FROM abuse_reports WHERE expires_at > ? ORDER BY created_at DESC LIMIT ?").bind(now, bounded).all<OperatorReportSummary>();
    return result.results;
  }

  async readReport(id: string): Promise<OperatorReport | undefined> {
    const now = this.now();
    await this.purge(now);
    const row = await this.d1.prepare("SELECT id, status, created_at, report_envelope FROM abuse_reports WHERE id = ? AND expires_at > ?").bind(id, now).first<ReportRow>();
    if (!row) return undefined;
    const report = await decryptOperationRecord<AbuseReportInput>(this.encryptionKey, "abuse_report", id, row.report_envelope);
    return { ...row, ...report };
  }

  async updateReportStatus(id: string, status: AbuseReportStatus): Promise<OperatorReportSummary | undefined> {
    if (!reportStatuses.has(status)) throw new Error("The report status is invalid.");
    const now = this.now();
    await this.purge(now);
    const updated = await this.d1.prepare("UPDATE abuse_reports SET status = ? WHERE id = ? AND expires_at > ?").bind(status, id, now).run();
    if (updated.meta?.changes !== 1) return undefined;
    const report = await this.d1.prepare("SELECT id, status, created_at FROM abuse_reports WHERE id = ?").bind(id).first<OperatorReportSummary>();
    return report ?? undefined;
  }

  async audit(action: string, target: string | undefined, outcome: string): Promise<void> {
    const targetFingerprint = target ? await digest(target) : null;
    const now = this.now();
    await this.purge(now);
    await this.d1.prepare("INSERT INTO operator_audit (id, action, target_fingerprint, created_at, expires_at, outcome) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), action, targetFingerprint, now, now + AUDIT_TTL_MS, outcome).run();
  }

  async purgeExpired(now = this.now()): Promise<number> {
    return this.purge(now);
  }

  private async claim(storageId: string, fingerprint: string, now: number, attempt: number, guestId: string): Promise<CreationClaim> {
    const leaseToken = crypto.randomUUID();
    const plan: CreationPlan = { management: randomCapability(), room: randomCapability(), ownerGuestId: guestId === "legacy-unscoped-test" ? undefined : guestId };
    const planEnvelope = await encryptOperationRecord(this.encryptionKey, "creation_plan", storageId, plan);
    try {
      const inserted = await this.d1.prepare("INSERT OR IGNORE INTO creation_idempotency (idempotency_key, request_fingerprint, state, response_envelope, plan_envelope, lease_token, created_at, updated_at, expires_at) VALUES (?, ?, 'pending', NULL, ?, ?, ?, ?, ?)").bind(storageId, fingerprint, planEnvelope, leaseToken, now, now, now + IDP_TTL_MS).run();
      if (inserted.meta?.changes === 1) return { kind: "claimed", leaseToken, plan };
    } catch (error) {
      if (!isConstraintError(error)) throw error;
    }
    const row = await this.d1.prepare("SELECT request_fingerprint, state, response_envelope, plan_envelope, lease_token, updated_at, expires_at FROM creation_idempotency WHERE idempotency_key = ?").bind(storageId).first<CreationRow>();
    if (!row || row.expires_at <= now) {
      if (attempt >= 2) return { kind: "pending" };
      if (row) await this.d1.prepare("DELETE FROM creation_idempotency WHERE idempotency_key = ? AND expires_at <= ?").bind(storageId, now).run();
      return this.claim(storageId, fingerprint, now, attempt + 1, guestId);
    }
    if (row.request_fingerprint !== fingerprint) return { kind: "conflict" };
    if (row.state === "complete" && row.response_envelope) {
      return { kind: "complete", response: await decryptOperationRecord<CreateRoomResponse>(this.encryptionKey, "creation_idempotency", storageId, row.response_envelope) };
    }
    if (now - row.updated_at < STALE_PENDING_MS) return { kind: "pending" };
    const reclaimed = await this.d1.prepare("UPDATE creation_idempotency SET lease_token = ?, updated_at = ? WHERE idempotency_key = ? AND state = 'pending' AND lease_token = ? AND updated_at = ? AND expires_at > ?").bind(leaseToken, now, storageId, row.lease_token, row.updated_at, now).run();
    if (reclaimed.meta?.changes === 1) return { kind: "claimed", leaseToken, plan: await decryptOperationRecord<CreationPlan>(this.encryptionKey, "creation_plan", storageId, row.plan_envelope) };
    return attempt >= 2 ? { kind: "pending" } : this.claim(storageId, fingerprint, now, attempt + 1, guestId);
  }

  private storageId(guestId: string, key: string): Promise<string> {
    return opaque(this.encryptionKey, "creation-id", `${guestId}\u0000${key}`);
  }

  private async purge(now: number): Promise<number> {
    const a = await this.d1.prepare("DELETE FROM creation_idempotency WHERE rowid IN (SELECT rowid FROM creation_idempotency WHERE expires_at <= ? LIMIT ?)").bind(now, PURGE_LIMIT).run();
    const b = await this.d1.prepare("DELETE FROM abuse_reports WHERE rowid IN (SELECT rowid FROM abuse_reports WHERE expires_at <= ? LIMIT ?)").bind(now, PURGE_LIMIT).run();
    const c = await this.d1.prepare("DELETE FROM operator_audit WHERE rowid IN (SELECT rowid FROM operator_audit WHERE expires_at <= ? LIMIT ?)").bind(now, PURGE_LIMIT).run();
    return (a.meta?.changes ?? 0) + (b.meta?.changes ?? 0) + (c.meta?.changes ?? 0);
  }
}

const reportStatuses = new Set<AbuseReportStatus>(["closed", "open", "reviewed"]);

function validateReport(input: AbuseReportInput): void {
  if (!input.capability || input.capability.length > 512) throw new Error("The report capability is invalid.");
  if (input.description === undefined) return;
  if (Array.from(input.description).length > maxReportDescriptionChars || new TextEncoder().encode(input.description).byteLength > maxReportDescriptionBytes) {
    throw new Error("The report description is too long.");
  }
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|unique/i.test(error.message);
}

function randomCapability(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function opaque(key: string, domain: string, value: string): Promise<string> {
  const raw = Uint8Array.from(atob(key.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - key.length % 4) % 4)), (char) => char.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(`msg.0000.chat/${domain}/${value}`)));
  let binary = ""; for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
