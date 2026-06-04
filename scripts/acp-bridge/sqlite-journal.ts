import { Database } from "bun:sqlite"
import { dirname } from "node:path"
import { mkdirSync } from "node:fs"

export type BridgeJournalReasonCode =
  | "local_persistence_unavailable"
  | "sqlite_lock_busy"
  | "local_disk_full"

export class BridgeJournalError extends Error {
  override readonly cause: unknown
  readonly reasonCode: BridgeJournalReasonCode

  constructor(reasonCode: BridgeJournalReasonCode, message: string, options: { cause?: unknown } = {}) {
    super(message)
    this.name = "BridgeJournalError"
    this.reasonCode = reasonCode
    this.cause = options.cause
  }
}

export type BridgeJournalDatabase = Pick<
  Database,
  "close" | "exec" | "prepare" | "query" | "transaction"
>

export type BridgeJournalDatabaseFactory = (path: string) => BridgeJournalDatabase

export type OpenBridgeJournalOptions = {
  databaseFactory?: BridgeJournalDatabaseFactory
  now?: () => number
  path: string
}

export type RecordClaimBeforePromptInput = {
  agentId: string
  bridgeDeviceId: string
  claimId: string
  eventType?: string
  organizationId: string
  payload: unknown
  queueItemId: string
  runtimeProfileId?: string
  threadId: string
  traceId?: string
}

export type RecordOutboxEventInput = {
  agentId?: string
  bridgeDeviceId: string
  claimId?: string
  eventType: string
  organizationId: string
  payload: unknown
  queueItemId?: string
  runtimeProfileId?: string
  threadId: string
  traceId?: string
}

export type AppendDiagnosticInput = {
  details?: unknown
  message: string
  reasonCode: string
  traceId?: string
}

export type RecoveryOutboxRow = {
  id: number
  sequence: number
  sessionId?: string
  queueItemId?: string
  claimId?: string
  eventType: string
  payload: unknown
  traceId?: string
}

export type AppliedMigration = {
  version: number
  name: string
  appliedAt: number
}

export type BridgeSessionRow = {
  id: string
  organizationId: string
  bridgeDeviceId: string
  agentId: string
  threadId: string
  runtimeProfileId?: string
}

const MIGRATIONS = [
  {
    version: 1,
    name: "bridge_sessions",
    sql: `
      CREATE TABLE IF NOT EXISTS bridge_sessions (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        bridge_device_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        runtime_profile_id TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (
          organization_id,
          bridge_device_id,
          agent_id,
          thread_id,
          runtime_profile_id
        )
      );
    `,
  },
  {
    version: 2,
    name: "turns",
    sql: `
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        queue_item_id TEXT NOT NULL,
        claim_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: "outbox",
    sql: `
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sequence INTEGER NOT NULL UNIQUE,
        session_id TEXT,
        queue_item_id TEXT,
        claim_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        trace_id TEXT,
        created_at INTEGER NOT NULL,
        published_at INTEGER,
        host_ack_json TEXT
      );
      CREATE INDEX IF NOT EXISTS by_outbox_status_sequence ON outbox (status, sequence);
    `,
  },
  {
    version: 4,
    name: "event_ledger",
    sql: `
      CREATE TABLE IF NOT EXISTS event_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 5,
    name: "diagnostics",
    sql: `
      CREATE TABLE IF NOT EXISTS diagnostics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id TEXT,
        reason_code TEXT NOT NULL,
        message TEXT NOT NULL,
        details_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS by_diagnostics_trace ON diagnostics (trace_id, id);
    `,
  },
  {
    version: 6,
    name: "locks",
    sql: `
      CREATE TABLE IF NOT EXISTS locks (
        name TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 7,
    name: "migrations",
    sql: `
      CREATE TABLE IF NOT EXISTS migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `,
  },
]

export function openBridgeJournal(options: OpenBridgeJournalOptions): BridgeJournal {
  try {
    mkdirSync(dirname(options.path), { recursive: true })
    const database = options.databaseFactory?.(options.path) ?? new Database(options.path)
    const journal = new BridgeJournal(database, options.now ?? Date.now)
    journal.migrate()
    return journal
  } catch (error) {
    throw mapSqliteError(error)
  }
}

export class BridgeJournal {
  constructor(
    private readonly database: BridgeJournalDatabase,
    private readonly now: () => number,
  ) {}

  migrate(): void {
    this.database.exec("PRAGMA journal_mode = WAL;")
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `)
    for (const migration of MIGRATIONS) {
      const existing = this.database
        .query("SELECT version FROM migrations WHERE version = ?")
        .get(migration.version) as { version: number } | null
      if (existing) {
        continue
      }
      this.withJournalTransaction(`migration:${migration.version}`, () => {
        this.database.exec(migration.sql)
        this.database
          .prepare("INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, this.now())
      })
    }
  }

  withJournalTransaction<T>(label: string, fn: () => T): T {
    try {
      return this.database.transaction(() => fn())()
    } catch (error) {
      throw mapSqliteError(error, label)
    }
  }

  recordClaimBeforePrompt(input: RecordClaimBeforePromptInput): { sessionId: string; turnId: string; outboxId: number } {
    return this.withJournalTransaction("recordClaimBeforePrompt", () => {
      const sessionId = this.upsertBridgeSession(input)
      const now = this.now()
      const turnId = `${sessionId}:${input.queueItemId}:${input.claimId}`
      this.database
        .prepare(
          `
          INSERT OR REPLACE INTO turns (
            id, session_id, queue_item_id, claim_id, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM turns WHERE id = ?), ?), ?)
        `,
        )
        .run(turnId, sessionId, input.queueItemId, input.claimId, "claimed", turnId, now, now)
      const outboxId = this.insertOutbox({
        ...input,
        eventType: input.eventType ?? "prompt.send",
        sessionId,
      })
      return { outboxId, sessionId, turnId }
    })
  }

  recordOutboxEvent(input: RecordOutboxEventInput): { outboxId: number } {
    return this.withJournalTransaction("recordOutboxEvent", () => {
      const sessionId =
        input.agentId && input.queueItemId
          ? this.upsertBridgeSession({
              agentId: input.agentId,
              bridgeDeviceId: input.bridgeDeviceId,
              organizationId: input.organizationId,
              runtimeProfileId: input.runtimeProfileId,
              threadId: input.threadId,
            })
          : undefined
      return { outboxId: this.insertOutbox({ ...input, sessionId }) }
    })
  }

  markOutboxPublished(outboxId: number, hostAck: unknown): void {
    this.withJournalTransaction("markOutboxPublished", () => {
      this.database
        .prepare("UPDATE outbox SET status = ?, published_at = ?, host_ack_json = ? WHERE id = ?")
        .run("published", this.now(), stableJson(hostAck), outboxId)
    })
  }

  listRecoveryWork(): RecoveryOutboxRow[] {
    const rows = this.database
      .query(
        `
        SELECT id, sequence, session_id, queue_item_id, claim_id, event_type, payload_json, trace_id
        FROM outbox
        WHERE status = 'pending'
        ORDER BY sequence ASC
      `,
      )
      .all() as Array<Record<string, unknown>>
    return rows.map((row) => ({
      claimId: stringOrUndefined(row.claim_id),
      eventType: String(row.event_type),
      id: Number(row.id),
      payload: parseJson(String(row.payload_json)),
      queueItemId: stringOrUndefined(row.queue_item_id),
      sequence: Number(row.sequence),
      sessionId: stringOrUndefined(row.session_id),
      traceId: stringOrUndefined(row.trace_id),
    }))
  }

  appendDiagnostic(input: AppendDiagnosticInput): number {
    return this.withJournalTransaction("appendDiagnostic", () => {
      const result = this.database
        .prepare(
          `
          INSERT INTO diagnostics (trace_id, reason_code, message, details_json, created_at)
          VALUES (?, ?, ?, ?, ?)
        `,
        )
        .run(input.traceId ?? null, input.reasonCode, input.message, stableJson(input.details ?? {}), this.now())
      return Number(result.lastInsertRowid)
    })
  }

  readTrace(traceId: string): { diagnostics: Array<Record<string, unknown>>; outbox: RecoveryOutboxRow[] } {
    const diagnostics = this.database
      .query("SELECT reason_code, message, details_json, created_at FROM diagnostics WHERE trace_id = ? ORDER BY id ASC")
      .all(traceId) as Array<Record<string, unknown>>
    return {
      diagnostics: diagnostics.map((row) => ({
        createdAt: Number(row.created_at),
        details: parseJson(String(row.details_json ?? "{}")),
        message: String(row.message),
        reasonCode: String(row.reason_code),
      })),
      outbox: this.listRecoveryWork().filter((row) => row.traceId === traceId),
    }
  }

  buildDoctorSnapshot(): Record<string, unknown> {
    const pending = this.listRecoveryWork().map((row) => ({
      ...row,
      payload: redactContent(row.payload),
    }))
    const diagnostics = this.database
      .query("SELECT trace_id, reason_code, message, details_json, created_at FROM diagnostics ORDER BY id ASC")
      .all() as Array<Record<string, unknown>>
    return {
      diagnostics: diagnostics.map((row) => ({
        createdAt: Number(row.created_at),
        details: redactContent(parseJson(String(row.details_json ?? "{}"))),
        message: "[redacted]",
        reasonCode: row.reason_code,
        traceId: row.trace_id,
      })),
      pendingOutbox: pending,
    }
  }

  listAppliedMigrations(): AppliedMigration[] {
    const rows = this.database
      .query("SELECT version, name, applied_at FROM migrations ORDER BY version ASC")
      .all() as Array<Record<string, unknown>>
    return rows.map((row) => ({
      appliedAt: Number(row.applied_at),
      name: String(row.name),
      version: Number(row.version),
    }))
  }

  listBridgeSessions(): BridgeSessionRow[] {
    const rows = this.database
      .query(
        `
        SELECT id, organization_id, bridge_device_id, agent_id, thread_id, runtime_profile_id
        FROM bridge_sessions
        ORDER BY id ASC
      `,
      )
      .all() as Array<Record<string, unknown>>
    return rows.map((row) => ({
      agentId: String(row.agent_id),
      bridgeDeviceId: String(row.bridge_device_id),
      id: String(row.id),
      organizationId: String(row.organization_id),
      runtimeProfileId: stringOrUndefined(row.runtime_profile_id),
      threadId: String(row.thread_id),
    }))
  }

  close(): void {
    this.database.close()
  }

  private upsertBridgeSession(input: {
    agentId: string
    bridgeDeviceId: string
    organizationId: string
    runtimeProfileId?: string
    threadId: string
  }): string {
    const runtimeProfileId = input.runtimeProfileId ?? ""
    const sessionId = stableSessionId({
      agentId: input.agentId,
      bridgeDeviceId: input.bridgeDeviceId,
      organizationId: input.organizationId,
      runtimeProfileId,
      threadId: input.threadId,
    })
    const now = this.now()
    this.database
      .prepare(
        `
        INSERT INTO bridge_sessions (
          id, organization_id, bridge_device_id, agent_id, thread_id, runtime_profile_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (
          organization_id, bridge_device_id, agent_id, thread_id, runtime_profile_id
        ) DO UPDATE SET updated_at = excluded.updated_at
      `,
      )
      .run(
        sessionId,
        input.organizationId,
        input.bridgeDeviceId,
        input.agentId,
        input.threadId,
        runtimeProfileId,
        now,
        now,
      )
    return sessionId
  }

  private insertOutbox(
    input: (RecordOutboxEventInput | RecordClaimBeforePromptInput) & { eventType: string; sessionId?: string },
  ): number {
    const nextSequence =
      (this.database.query("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM outbox").get() as {
        next_sequence: number
      }).next_sequence ?? 1
    const result = this.database
      .prepare(
        `
        INSERT INTO outbox (
          sequence, session_id, queue_item_id, claim_id, event_type, payload_json, status, trace_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        nextSequence,
        input.sessionId ?? null,
        input.queueItemId ?? null,
        input.claimId ?? null,
        input.eventType,
        stableJson(input.payload),
        "pending",
        input.traceId ?? null,
        this.now(),
      )
    return Number(result.lastInsertRowid)
  }
}

function mapSqliteError(error: unknown, label = "openBridgeJournal"): BridgeJournalError {
  if (error instanceof BridgeJournalError) {
    return error
  }
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  if (lower.includes("busy") || lower.includes("locked")) {
    return new BridgeJournalError("sqlite_lock_busy", `${label}: SQLite database is busy`, { cause: error })
  }
  if (lower.includes("sqlite_full") || lower.includes("disk") || lower.includes("no space")) {
    return new BridgeJournalError("local_disk_full", `${label}: local bridge journal disk is full`, {
      cause: error,
    })
  }
  return new BridgeJournalError("local_persistence_unavailable", `${label}: local bridge journal unavailable`, {
    cause: error,
  })
}

function stableSessionId(input: {
  agentId: string
  bridgeDeviceId: string
  organizationId: string
  runtimeProfileId: string
  threadId: string
}): string {
  return [
    "session",
    input.organizationId,
    input.bridgeDeviceId,
    input.agentId,
    input.threadId,
    input.runtimeProfileId,
  ]
    .map((part) => encodeURIComponent(part))
    .join(":")
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson)
  }
  if (!value || typeof value !== "object") {
    return value
  }
  const record = value as Record<string, unknown>
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortJson(record[key])]))
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function redactContent(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactContent)
  }
  if (typeof value === "string") {
    return redactText(value)
  }
  if (!value || typeof value !== "object") {
    return value
  }
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      isSensitiveKey(key) ? "[redacted]" : redactContent(entry),
    ]),
  )
}

const SENSITIVE_JOURNAL_KEY_PATTERN =
  /(?:authorization|bridgeToken|token|secret|password|apiKey|api_key|x-api-key|x_api_key|accessToken|refreshToken|connectionString|databaseUrl|prompt|content|message|messages|rawPayload|text)/i

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_JOURNAL_KEY_PATTERN.test(key)
}

function redactText(value: string): string {
  return value
    .replace(
      /("?(?:authorization|bridgeToken|token|secret|password|apiKey|api_key|x-api-key|x_api_key|accessToken|refreshToken|connectionString|databaseUrl|prompt)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}&]+)/gi,
      (_match, prefix: string, rawValue: string) => {
        const quote = rawValue.startsWith('"') || rawValue.startsWith("'") ? rawValue[0] : ""
        return `${prefix}${quote}[redacted]${quote}`
      },
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]")
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}
