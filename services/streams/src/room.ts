import { DurableObject } from "cloudflare:workers";
import {
  appendTimeline,
  normalizeStream,
  sortStreams,
  validateDecision,
  type DecisionKind,
  type DecisionLock,
  type DecisionStatus,
  type HelmStream,
  type StreamChoice,
  type StreamInput,
  type StreamPatch,
} from "./domain";

const PENDING_LEASE_MS = 30_000;

export const STREAMS_LIVE_PATH = "/api/streams/live";
export const STREAMS_SNAPSHOT_EVENT = "streams.snapshot";
export const STREAMS_UPDATED_EVENT = "streams.updated";

export type StreamsLiveEnvelope = {
  type: typeof STREAMS_SNAPSHOT_EVENT | typeof STREAMS_UPDATED_EVENT;
  streams: HelmStream[];
  changedStreamIds?: string[];
};

type StoredDecision = {
  decisionId: string;
  streamId: string;
  choiceId: string;
  value: string;
  freeText: string;
  status: DecisionStatus;
  kind: DecisionKind;
  correctionOf?: string;
  createdAt: string;
  attemptedAt: string;
  error?: string;
};

type DecisionLockRow = {
  stream_id: string;
  decision_id: string;
  locked: number;
};

type StreamRow = {
  stream_id: string;
  document: string;
  status: string;
  needs_don: number;
  priority: number;
  updated_at: string;
  archived: number;
};

export type DecisionStart = {
  action: "send" | "pending" | "submitted";
  decisionId: string;
  streamId: string;
  choiceId: string;
  value: string;
  freeText: string;
  createdAt: string;
  attemptedAt: string;
  kind: DecisionKind;
  correctionOf?: string;
};

export class StreamsRoom extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    state.blockConcurrencyWhile(async () => {
      this.inTransaction(() => this.migrateSchema());
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", {
        status: 426,
        headers: { Upgrade: "websocket" },
      });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    this.sendSnapshot(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const text =
      typeof message === "string" ? message : new TextDecoder().decode(message);
    let type: unknown;
    try {
      type = (JSON.parse(text) as { type?: unknown }).type;
    } catch {
      // Plain-text refresh messages are supported for simple clients.
    }
    if (
      text.trim() === "refresh" ||
      text.trim() === "subscribe" ||
      type === "refresh" ||
      type === "subscribe"
    ) {
      this.sendSnapshot(ws);
    }
  }

  webSocketClose(): void {}

  webSocketError(): void {}

  list(): HelmStream[] {
    const rows = this.ctx.storage.sql
      .exec<StreamRow>(
        "SELECT stream_id, document, status, needs_don, priority, updated_at, archived FROM streams WHERE archived = 0 AND status <> 'archived'",
      )
      .toArray();
    return sortStreams(rows.map((row) => this.viewStream(row)));
  }

  /** MCP/ops listing. includeArchived=true returns every row for storage diagnosis. */
  listAll(includeArchived = true): HelmStream[] {
    const rows = this.ctx.storage.sql
      .exec<StreamRow>(
        includeArchived
          ? "SELECT stream_id, document, status, needs_don, priority, updated_at, archived FROM streams"
          : "SELECT stream_id, document, status, needs_don, priority, updated_at, archived FROM streams WHERE archived = 0 AND status <> 'archived'",
      )
      .toArray();
    return sortStreams(rows.map((row) => this.viewStream(row)));
  }

  get(streamId: string): HelmStream | null {
    return this.readStream(streamId);
  }

  upsert(input: StreamInput): HelmStream {
    const now = new Date();
    const stream = this.inTransaction(() => {
      const current = this.readStream(input.streamId);
      const stream = normalizeStream(this.mergeInput(current, input, now), now);
      this.writeStream(stream);
      return this.viewStreamById(stream.streamId) ?? stream;
    });
    this.broadcast([stream.streamId]);
    return stream;
  }

  reprioritize(
    streamId: string,
    priority: number,
    needsDon?: boolean,
  ): HelmStream {
    const current = this.requireStream(streamId);
    const nextNeedsDon = needsDon ?? current.needsDon;
    return this.upsert({
      ...current,
      priority,
      ...(needsDon === undefined
        ? {}
        : {
            needsDon: nextNeedsDon,
            status: nextNeedsDon ? "needs_decision" : "ongoing",
          }),
    });
  }

  archive(streamId: string): HelmStream {
    return this.upsert({
      ...this.requireStream(streamId),
      status: "archived",
      needsDon: false,
      archived: true,
    });
  }

  setChoices(streamId: string, choices: StreamChoice[]): HelmStream {
    return this.upsert({ ...this.requireStream(streamId), choices });
  }

  patchStreams(patches: StreamPatch[]): HelmStream[] {
    if (!Array.isArray(patches) || patches.length === 0)
      throw new Error("patches must be a nonempty array");

    const streams = this.inTransaction(() => {
      const ids = new Set<string>();
      const now = new Date();
      const staged = patches.map((patch, index) => {
        this.validatePatch(patch, index, ids);
        const current = this.requireStream(patch.streamId);
        const archived =
          patch.status === "archived"
            ? true
            : patch.status === "needs_decision" || patch.status === "ongoing"
              ? false
              : current.archived;
        const candidate = this.mergeInput(
          current,
          {
            ...current,
            ...(patch.status === undefined ? {} : { status: patch.status }),
            ...(patch.priority === undefined
              ? {}
              : { priority: patch.priority }),
            archived,
          },
          now,
        );
        return normalizeStream(candidate, now);
      });

      for (const stream of staged) this.writeStream(stream);
      return staged.map(
        (stream) => this.viewStreamById(stream.streamId) ?? stream,
      );
    });
    this.broadcast(streams.map((stream) => stream.streamId));
    return streams;
  }

  beginDecision(input: {
    decisionId: string;
    streamId: string;
    choiceId: string;
    value: string;
    freeText: string;
    createdAt: string;
  }): DecisionStart {
    const result = this.inTransaction(() => {
      const existing = this.readDecision(input.decisionId);
      if (existing) {
        this.assertSameDecision(existing, input);
        if (existing.status === "submitted")
          return this.decisionStart(existing, "submitted");
        if (existing.status === "rejected")
          throw new Error("decision was rejected");

        const lock = this.readLockRow(existing.streamId);
        if (lock && lock.decision_id !== existing.decisionId) {
          throw new Error("decision is no longer current");
        }
        if (
          existing.status === "pending" &&
          this.pendingLeaseActive(existing.attemptedAt)
        ) {
          return this.decisionStart(existing, "pending");
        }

        // A failed delivery, or an expired pending lease, can be retried from
        // the immutable row even if the stream has since changed status.
        const attemptedAt = this.nextAttemptedAt(
          input.createdAt,
          existing.attemptedAt,
        );
        this.setDecisionPending(existing.decisionId, attemptedAt);
        this.lockStream(existing.streamId, existing.decisionId);
        return this.decisionStart(
          { ...existing, status: "pending", attemptedAt, error: undefined },
          "send",
        );
      }

      const stream = this.requireStream(input.streamId);
      const lock = this.readLockRow(input.streamId);
      if (lock?.locked)
        throw new Error(`stream is locked by decision ${lock.decision_id}`);

      validateDecision(stream, input);
      const correctionOf =
        lock?.decision_id || this.latestDecisionId(input.streamId);
      const kind: DecisionKind = correctionOf ? "correction" : "decision";
      const decision: StoredDecision = {
        decisionId: input.decisionId,
        streamId: input.streamId,
        choiceId: input.choiceId,
        value: input.value,
        freeText: input.freeText,
        status: "pending",
        kind,
        ...(correctionOf ? { correctionOf } : {}),
        createdAt: input.createdAt,
        attemptedAt: this.nextAttemptedAt(input.createdAt),
      };
      this.insertDecision(decision);
      this.lockStream(input.streamId, input.decisionId);
      return this.decisionStart(decision, "send");
    });
    if (result.action === "send") this.broadcast([result.streamId]);
    return result;
  }

  finishDecision(
    decisionId: string,
    attemptedAt: string,
    status: Exclude<DecisionStatus, "pending">,
    error?: string,
  ): void {
    let streamId: string | undefined;
    this.inTransaction(() => {
      streamId = this.readDecision(decisionId)?.streamId;
      this.ctx.storage.sql.exec(
        "UPDATE decisions SET status = ?, error = ? WHERE decision_id = ? AND status = 'pending' AND attempted_at = ?",
        status,
        error ?? null,
        decisionId,
        attemptedAt,
      );
    });
    if (streamId) this.broadcast([streamId]);
  }

  unlockDecision(streamId: string, decisionId?: string): HelmStream {
    const stream = this.inTransaction(() => {
      this.requireStream(streamId);
      const lock = this.readLockRow(streamId);
      if (!lock) return this.viewStreamById(streamId) as HelmStream;
      if (decisionId !== undefined && decisionId !== lock.decision_id) {
        throw new Error("decision lock does not match");
      }

      const decision = this.readDecision(lock.decision_id);
      if (decision?.status === "pending") {
        throw new Error(
          "pending decision must be finished before it can be unlocked",
        );
      }
      this.ctx.storage.sql.exec(
        "UPDATE decision_locks SET locked = 0 WHERE stream_id = ?",
        streamId,
      );
      return this.viewStreamById(streamId) as HelmStream;
    });
    this.broadcast([stream.streamId]);
    return stream;
  }

  /** Short RPC alias retained for callers that model the operation as unlock(streamId). */
  unlock(streamId: string, decisionId?: string): HelmStream {
    return this.unlockDecision(streamId, decisionId);
  }

  private sendSnapshot(socket: WebSocket): void {
    this.sendEnvelope(socket, {
      type: STREAMS_SNAPSHOT_EVENT,
      streams: this.list(),
    });
  }

  private broadcast(changedStreamIds: string[]): void {
    const uniqueIds = [...new Set(changedStreamIds)];
    if (uniqueIds.length === 0) return;
    const envelope: StreamsLiveEnvelope = {
      type: STREAMS_UPDATED_EVENT,
      streams: this.list(),
      changedStreamIds: uniqueIds,
    };
    const payload = JSON.stringify(envelope);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== 1) continue;
      try {
        socket.send(payload);
      } catch {
        try {
          socket.close(1011, "Unable to send stream update");
        } catch {
          // A failed socket must not make a committed mutation fail.
        }
      }
    }
  }

  private sendEnvelope(socket: WebSocket, envelope: StreamsLiveEnvelope): void {
    try {
      socket.send(JSON.stringify(envelope));
    } catch {
      try {
        socket.close(1011, "Unable to send stream update");
      } catch {
        // The connection is already unusable; leave the durable state intact.
      }
    }
  }

  private migrateSchema(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS streams (
      stream_id TEXT PRIMARY KEY,
      document TEXT NOT NULL,
      status TEXT NOT NULL,
      needs_don INTEGER NOT NULL,
      priority INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS decisions (
      decision_id TEXT PRIMARY KEY,
      stream_id TEXT NOT NULL,
      choice_id TEXT NOT NULL,
      value TEXT NOT NULL,
      free_text TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      attempted_at TEXT NOT NULL,
      error TEXT,
      kind TEXT NOT NULL DEFAULT 'decision',
      correction_of TEXT
    )`);

    const streamColumns = this.tableColumns("streams");
    if (!streamColumns.has("archived")) {
      sql.exec(
        "ALTER TABLE streams ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
      );
    }
    const decisionColumns = this.tableColumns("decisions");
    if (!decisionColumns.has("kind")) {
      sql.exec(
        "ALTER TABLE decisions ADD COLUMN kind TEXT NOT NULL DEFAULT 'decision'",
      );
    }
    if (!decisionColumns.has("correction_of")) {
      sql.exec("ALTER TABLE decisions ADD COLUMN correction_of TEXT");
    }

    sql.exec(`CREATE TABLE IF NOT EXISTS decision_locks (
      stream_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      locked INTEGER NOT NULL DEFAULT 1
    )`);

    // Keep archived state out of the visible status column. This also makes
    // old rows with status='archived' safe when the new list query runs.
    const streamRows = sql
      .exec<{ stream_id: string; document: string }>(
        "SELECT stream_id, document FROM streams",
      )
      .toArray();
    for (const row of streamRows) {
      try {
        const document = JSON.parse(row.document) as Record<string, unknown>;
        if (document.archived === true || document.status === "archived") {
          sql.exec(
            "UPDATE streams SET archived = 1 WHERE stream_id = ?",
            row.stream_id,
          );
        }
      } catch {
        // A malformed document will still fail when read. Migration must not
        // prevent the rest of the durable object from starting.
      }
    }

    // Seed one locked row for each stream from the deterministic latest
    // decision. INSERT OR IGNORE keeps this migration idempotent.
    const existingLocks = new Set(
      sql
        .exec<{ stream_id: string }>("SELECT stream_id FROM decision_locks")
        .toArray()
        .map((row) => row.stream_id),
    );
    const latest = sql
      .exec<{ stream_id: string; decision_id: string; status: string }>(
        "SELECT stream_id, decision_id, status FROM decisions ORDER BY stream_id, created_at DESC, attempted_at DESC, decision_id DESC",
      )
      .toArray();
    for (const row of latest) {
      if (existingLocks.has(row.stream_id)) continue;
      existingLocks.add(row.stream_id);
      sql.exec(
        "INSERT OR IGNORE INTO decision_locks (stream_id, decision_id, locked) VALUES (?, ?, ?)",
        row.stream_id,
        row.decision_id,
        row.status === "rejected" ? 0 : 1,
      );
    }
  }

  private tableColumns(table: string): Set<string> {
    const rows = this.ctx.storage.sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray();
    return new Set(rows.map((row) => row.name));
  }

  private inTransaction<T>(closure: () => T): T {
    const storage = this.ctx.storage as DurableObjectStorage & {
      transactionSync?: <Result>(callback: () => Result) => Result;
    };
    return storage.transactionSync
      ? storage.transactionSync(closure)
      : closure();
  }

  private readStream(streamId: string): HelmStream | null {
    return this.viewStreamById(streamId);
  }

  private viewStreamById(streamId: string): HelmStream | null {
    const row = this.ctx.storage.sql
      .exec<StreamRow>(
        "SELECT stream_id, document, status, needs_don, priority, updated_at, archived FROM streams WHERE stream_id = ?",
        streamId,
      )
      .toArray()[0];
    return row ? this.viewStream(row) : null;
  }

  private viewStream(row: StreamRow): HelmStream {
    const document = JSON.parse(row.document) as Record<string, unknown>;
    const archived =
      Boolean(row.archived) ||
      document.archived === true ||
      document.status === "archived";
    const input: Record<string, unknown> = {
      ...document,
      streamId: row.stream_id,
      status: archived ? "archived" : row.status,
      needsDon: Boolean(row.needs_don),
      priority: row.priority,
      updatedAt: row.updated_at,
      archived,
    };
    // Modern documents store history as an alias of timeline. Do not append
    // that alias a second time on every read.
    if (Array.isArray(document.timeline) && Array.isArray(document.history)) {
      const timeline = document.timeline as Array<Record<string, unknown>>;
      const history = document.history as unknown[];
      if (
        history.length === timeline.length &&
        history.every((value, index) => value === timeline[index]?.text)
      ) {
        delete input.history;
      }
    }
    const stream = normalizeStream(input as StreamInput);
    return { ...stream, decisionLock: this.currentDecisionLock(row.stream_id) };
  }

  private currentDecisionLock(streamId: string): DecisionLock | null {
    const lock = this.readLockRow(streamId);
    if (!lock?.locked) return null;
    const decision = this.readDecision(lock.decision_id);
    if (!decision || decision.status === "rejected") return null;
    return {
      decisionId: decision.decisionId,
      choiceId: decision.choiceId,
      value: decision.value,
      freeText: decision.freeText,
      status: decision.status,
      kind: decision.kind,
      ...(decision.correctionOf ? { correctionOf: decision.correctionOf } : {}),
      createdAt: decision.createdAt,
      attemptedAt: decision.attemptedAt,
      error: decision.error,
    };
  }

  private readLockRow(streamId: string): DecisionLockRow | null {
    return (
      this.ctx.storage.sql
        .exec<DecisionLockRow>(
          "SELECT stream_id, decision_id, locked FROM decision_locks WHERE stream_id = ?",
          streamId,
        )
        .toArray()[0] ?? null
    );
  }

  private readDecision(decisionId: string): StoredDecision | null {
    const row = this.ctx.storage.sql
      .exec<{
        decision_id: string;
        stream_id: string;
        choice_id: string;
        value: string;
        free_text: string;
        status: DecisionStatus;
        kind: DecisionKind;
        correction_of: string | null;
        created_at: string;
        attempted_at: string;
        error: string | null;
      }>(
        "SELECT decision_id, stream_id, choice_id, value, free_text, status, kind, correction_of, created_at, attempted_at, error FROM decisions WHERE decision_id = ?",
        decisionId,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      decisionId: row.decision_id,
      streamId: row.stream_id,
      choiceId: row.choice_id,
      value: row.value,
      freeText: row.free_text,
      status: row.status,
      kind: row.kind,
      ...(row.correction_of ? { correctionOf: row.correction_of } : {}),
      createdAt: row.created_at,
      attemptedAt: row.attempted_at,
      ...(row.error ? { error: row.error } : {}),
    };
  }

  private latestDecisionId(streamId: string): string | undefined {
    const row = this.ctx.storage.sql
      .exec<{ decision_id: string }>(
        "SELECT decision_id FROM decisions WHERE stream_id = ? ORDER BY created_at DESC, attempted_at DESC, decision_id DESC LIMIT 1",
        streamId,
      )
      .toArray()[0];
    return row?.decision_id;
  }

  private writeStream(stream: HelmStream): void {
    const lock = this.currentDecisionLock(stream.streamId);
    const document = JSON.stringify({ ...stream, decisionLock: lock });
    this.ctx.storage.sql.exec(
      `INSERT INTO streams (stream_id, document, status, needs_don, priority, updated_at, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(stream_id) DO UPDATE SET document = excluded.document,
       status = excluded.status, needs_don = excluded.needs_don,
       priority = excluded.priority, updated_at = excluded.updated_at,
       archived = excluded.archived`,
      stream.streamId,
      document,
      stream.status,
      Number(stream.needsDon),
      stream.priority,
      stream.updatedAt,
      Number(stream.archived === true),
    );
  }

  private insertDecision(decision: StoredDecision): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO decisions (
        decision_id, stream_id, choice_id, value, free_text, status,
        created_at, attempted_at, error, kind, correction_of
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, ?, ?)`,
      decision.decisionId,
      decision.streamId,
      decision.choiceId,
      decision.value,
      decision.freeText,
      decision.createdAt,
      decision.attemptedAt,
      decision.kind,
      decision.correctionOf ?? null,
    );
  }

  private setDecisionPending(decisionId: string, attemptedAt: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE decisions SET status = 'pending', attempted_at = ?, error = NULL WHERE decision_id = ?",
      attemptedAt,
      decisionId,
    );
  }

  private lockStream(streamId: string, decisionId: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO decision_locks (stream_id, decision_id, locked) VALUES (?, ?, 1)
       ON CONFLICT(stream_id) DO UPDATE SET decision_id = excluded.decision_id, locked = 1`,
      streamId,
      decisionId,
    );
  }

  private assertSameDecision(
    existing: StoredDecision,
    input: {
      decisionId: string;
      streamId: string;
      choiceId: string;
      value: string;
      freeText: string;
    },
  ): void {
    if (
      existing.streamId !== input.streamId ||
      existing.choiceId !== input.choiceId ||
      existing.value !== input.value ||
      existing.freeText !== input.freeText
    ) {
      throw new Error("decisionId is already bound to a different decision");
    }
  }

  private pendingLeaseActive(attemptedAt: string): boolean {
    const timestamp = Date.parse(attemptedAt);
    return (
      Number.isFinite(timestamp) && Date.now() - timestamp < PENDING_LEASE_MS
    );
  }

  private nextAttemptedAt(requestedAt: string, previous?: string): string {
    if (previous === undefined || requestedAt !== previous) return requestedAt;
    const timestamp = Date.parse(requestedAt);
    return Number.isFinite(timestamp)
      ? new Date(timestamp + 1).toISOString()
      : new Date().toISOString();
  }

  private decisionStart(
    decision: StoredDecision,
    action: DecisionStart["action"],
  ): DecisionStart {
    return {
      action,
      decisionId: decision.decisionId,
      streamId: decision.streamId,
      choiceId: decision.choiceId,
      value: decision.value,
      freeText: decision.freeText,
      createdAt: decision.createdAt,
      attemptedAt: decision.attemptedAt,
      kind: decision.kind,
      ...(decision.correctionOf ? { correctionOf: decision.correctionOf } : {}),
    };
  }

  private mergeInput(
    current: HelmStream | null,
    input: StreamInput,
    now: Date,
  ): StreamInput {
    const timeline =
      input.timeline === undefined
        ? current?.timeline
        : appendTimeline(current?.timeline ?? [], input.timeline);
    const history =
      input.history === undefined
        ? undefined
        : input.history.filter((entry) => !current?.history.includes(entry));
    const merged: Record<string, unknown> = {};
    if (current) Object.assign(merged, current);
    Object.assign(merged, input);
    if (
      current &&
      input.status === undefined &&
      typeof input.needsDon === "boolean"
    ) {
      merged.status = input.needsDon ? "needs_decision" : "ongoing";
    }
    if (timeline !== undefined) merged.timeline = timeline;
    if (history !== undefined) merged.history = history;
    Object.assign(merged, {
      updatedAt: now.toISOString(),
      // The lock is maintained in its own table. Caller-provided lock fields
      // must never mutate the authoritative decision state.
      decisionLock: current?.decisionLock ?? null,
    });
    if (current && input.history === undefined) delete merged.history;
    if (input.about === undefined && input.summary !== undefined)
      merged.about = input.summary;
    return merged as StreamInput;
  }

  private validatePatch(
    patch: StreamPatch,
    index: number,
    ids: Set<string>,
  ): void {
    if (
      !patch ||
      typeof patch.streamId !== "string" ||
      !patch.streamId.trim()
    ) {
      throw new Error(`patches[${index}].streamId is required`);
    }
    if (ids.has(patch.streamId))
      throw new Error("patch stream IDs must be unique");
    ids.add(patch.streamId);
    if (patch.status === undefined && patch.priority === undefined) {
      throw new Error("each patch must include at least one mutable field");
    }
    if (
      patch.status !== undefined &&
      !(
        [
          "needs_decision",
          "ongoing",
          "no_action",
          "active",
          "deferred",
          "archived",
        ] as string[]
      ).includes(patch.status)
    ) {
      throw new Error("patch status is invalid");
    }
    if (
      patch.priority !== undefined &&
      (!Number.isInteger(patch.priority) || patch.priority < 0)
    ) {
      throw new Error("patch priority must be a nonnegative integer");
    }
  }

  private requireStream(streamId: string): HelmStream {
    const stream = this.readStream(streamId);
    if (!stream) throw new Error(`unknown stream: ${streamId}`);
    return stream;
  }
}
