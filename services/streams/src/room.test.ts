import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: unknown;
    constructor(ctx: unknown) {
      this.ctx = ctx;
    }
  },
}));

const { StreamsRoom } = await import("./room");

class SqlStub {
  readonly db = new Database(":memory:");

  exec<T extends Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ) {
    const statement = this.db.query(query);
    const isRead = /^\s*(SELECT|PRAGMA|WITH)\b/i.test(query);
    const rows = isRead ? statement.all(...bindings) : [];
    if (!isRead) statement.run(...bindings);
    return { toArray: () => rows as T[] };
  }
}

type RoomTestOptions = {
  sockets?: WebSocket[];
  onAccept?: (socket: WebSocket) => void;
};

function roomFromSql(sql: SqlStub, options: RoomTestOptions = {}) {
  const storage = {
    sql,
    transactionSync<T>(closure: () => T): T {
      return sql.db.transaction(closure)();
    },
  };
  const ctx = {
    storage,
    acceptWebSocket(socket: WebSocket) {
      options.onAccept?.(socket);
    },
    getWebSockets() {
      return options.sockets ?? [];
    },
    blockConcurrencyWhile<T>(closure: () => Promise<T>): Promise<T> {
      return closure();
    },
  };
  return new StreamsRoom(ctx as never, {} as Env);
}

function makeSocket() {
  const messages: Array<string | ArrayBuffer> = [];
  const socket = {
    readyState: 1,
    messages,
    send(message: string | ArrayBuffer) {
      messages.push(message);
    },
    close() {
      socket.readyState = 3;
    },
  };
  return socket as unknown as WebSocket & {
    messages: Array<string | ArrayBuffer>;
  };
}

function makeRoom() {
  return roomFromSql(new SqlStub());
}

function seed(room: InstanceType<typeof StreamsRoom>, streamId = "travel") {
  return room.upsert({
    streamId,
    title: "Travel",
    ownerBot: "helm",
    about: "Choose the next step.",
    timeline: [{ at: "2026-09-06T00:00:00Z", text: "Research started" }],
    status: "needs_decision",
    updatedAt: "2026-09-06T00:00:00Z",
  });
}

describe("StreamsRoom decision authority", () => {
  test("accepts a hibernatable WebSocket and sends the current stream snapshot", async () => {
    const client = makeSocket();
    const server = makeSocket();
    const originalPair = (globalThis as unknown as { WebSocketPair?: unknown })
      .WebSocketPair;
    (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair =
      class {
        0 = client;
        1 = server;
      };
    let accepted: WebSocket | undefined;
    try {
      const room = roomFromSql(new SqlStub(), {
        onAccept: (socket) => {
          accepted = socket;
        },
      });
      seed(room);

      const response = await room.fetch(
        new Request("https://don.0000.gold/api/streams/live", {
          headers: { Upgrade: "websocket" },
        }),
      );

      expect(response.status).toBe(101);
      expect(accepted).toBe(server);
      expect(server.messages).toEqual([
        JSON.stringify({ type: "streams.snapshot", streams: room.list() }),
      ]);
    } finally {
      (globalThis as unknown as { WebSocketPair?: unknown }).WebSocketPair =
        originalPair;
    }
  });

  test("broadcasts one atomic update to connected clients after an MCP patch", () => {
    const client = makeSocket();
    const room = roomFromSql(new SqlStub(), { sockets: [client] });
    seed(room);
    client.messages.length = 0;

    room.patchStreams([{ streamId: "travel", status: "ongoing" }]);

    expect(client.messages).toHaveLength(1);
    expect(JSON.parse(String(client.messages[0]))).toEqual({
      type: "streams.updated",
      changedStreamIds: ["travel"],
      streams: room.list(),
    });
  });

  test("answers a client refresh message with a fresh snapshot", () => {
    const client = makeSocket();
    const room = roomFromSql(new SqlStub(), { sockets: [client] });
    seed(room);
    client.messages.length = 0;

    room.webSocketMessage(client, JSON.stringify({ type: "refresh" }));

    expect(client.messages).toEqual([
      JSON.stringify({ type: "streams.snapshot", streams: room.list() }),
    ]);
  });

  test("rejects non-WebSocket requests at the Durable Object boundary", async () => {
    const room = makeRoom();

    const response = await room.fetch(
      new Request("https://don.0000.gold/api/streams/live"),
    );

    expect(response.status).toBe(426);
    expect(response.headers.get("Upgrade")).toBe("websocket");
  });

  test("lists visible modern statuses and hides archived legacy rows", () => {
    const room = makeRoom();
    seed(room, "needs");
    room.upsert({
      streamId: "ongoing",
      title: "Ongoing",
      ownerBot: "helm",
      status: "ongoing",
    });
    room.upsert({
      streamId: "archived",
      title: "Archived",
      ownerBot: "helm",
      status: "archived",
    });

    expect(room.list().map((stream) => stream.streamId)).toEqual([
      "needs",
      "ongoing",
    ]);
    expect(room.get("archived")?.archived).toBe(true);
    expect(room.get("archived")?.status).toBe("no_action");
  });

  test("stores a lock and decision row before returning a webhook send", () => {
    const room = makeRoom();
    seed(room);
    const start = room.beginDecision({
      decisionId: "decision-1",
      streamId: "travel",
      choiceId: "send",
      value: "send_draft",
      freeText: "Ship it",
      createdAt: "2026-09-06T00:01:00.000Z",
    });

    expect(start).toMatchObject({
      action: "send",
      decisionId: "decision-1",
      streamId: "travel",
      choiceId: "send",
      value: "send_draft",
      freeText: "Ship it",
      createdAt: "2026-09-06T00:01:00.000Z",
      kind: "decision",
    });
    expect(room.get("travel")?.decisionLock).toMatchObject({
      decisionId: "decision-1",
      status: "pending",
      kind: "decision",
    });
    expect(room.list()[0]?.decisionLock?.decisionId).toBe("decision-1");
  });

  test("keeps failed locks retryable with the original decision time", () => {
    const room = makeRoom();
    seed(room);
    const first = room.beginDecision({
      decisionId: "decision-1",
      streamId: "travel",
      choiceId: "send",
      value: "send_draft",
      freeText: "",
      createdAt: "2026-09-06T00:01:00.000Z",
    });
    room.finishDecision("decision-1", first.attemptedAt, "failed", "HTTP 503");

    expect(room.get("travel")?.decisionLock).toMatchObject({
      status: "failed",
      error: "HTTP 503",
    });
    const retry = room.beginDecision({
      decisionId: "decision-1",
      streamId: "travel",
      choiceId: "send",
      value: "send_draft",
      freeText: "",
      createdAt: "2026-09-06T00:02:00.000Z",
    });
    expect(retry).toMatchObject({
      action: "send",
      createdAt: "2026-09-06T00:01:00.000Z",
      decisionId: "decision-1",
    });
    expect(room.get("travel")?.decisionLock).toMatchObject({
      status: "pending",
      error: undefined,
    });
  });

  test("unlock rejects the predecessor and makes the next decision a correction", () => {
    const room = makeRoom();
    seed(room);
    const first = room.beginDecision({
      decisionId: "decision-1",
      streamId: "travel",
      choiceId: "send",
      value: "send_draft",
      freeText: "First",
      createdAt: "2026-09-06T00:01:00.000Z",
    });
    room.finishDecision("decision-1", first.attemptedAt, "submitted");
    room.unlockDecision("travel", "decision-1");
    expect(room.get("travel")?.decisionLock).toBeNull();

    const correction = room.beginDecision({
      decisionId: "decision-2",
      streamId: "travel",
      choiceId: "defer",
      value: "defer",
      freeText: "Second",
      createdAt: "2026-09-06T00:02:00.000Z",
    });
    expect(correction).toMatchObject({
      action: "send",
      kind: "correction",
      correctionOf: "decision-1",
    });
    expect(room.get("travel")?.decisionLock).toMatchObject({
      kind: "correction",
      correctionOf: "decision-1",
    });
  });

  test("validates every patch before applying any patch", () => {
    const room = makeRoom();
    seed(room, "one");
    seed(room, "two");
    expect(() =>
      room.patchStreams([
        { streamId: "one", status: "ongoing" },
        { streamId: "missing", priority: 5 },
      ]),
    ).toThrow("unknown stream");
    expect(room.get("one")?.status).toBe("needs_decision");
  });

  test("patches status without erasing the timeline or decision lock", () => {
    const room = makeRoom();
    seed(room);
    room.beginDecision({
      decisionId: "decision-1",
      streamId: "travel",
      choiceId: "send",
      value: "send_draft",
      freeText: "",
      createdAt: "2026-09-06T00:01:00.000Z",
    });
    room.patchStreams([{ streamId: "travel", status: "ongoing" }]);
    expect(room.get("travel")).toMatchObject({
      status: "ongoing",
      timeline: [{ at: "2026-09-06T00:00:00Z", text: "Research started" }],
      decisionLock: { decisionId: "decision-1", status: "pending" },
    });
  });

  test("rejects a different decision while the stream lock is held", () => {
    const room = makeRoom();
    seed(room);
    room.beginDecision({
      decisionId: "decision-1",
      streamId: "travel",
      choiceId: "send",
      value: "send_draft",
      freeText: "",
      createdAt: "2026-09-06T00:01:00.000Z",
    });

    expect(() =>
      room.beginDecision({
        decisionId: "decision-2",
        streamId: "travel",
        choiceId: "defer",
        value: "defer",
        freeText: "",
        createdAt: "2026-09-06T00:02:00.000Z",
      }),
    ).toThrow("locked");
  });

  test("retries the same decision from stored fields after stream state changes", () => {
    const room = makeRoom();
    seed(room);
    const first = room.beginDecision({
      decisionId: "decision-1",
      streamId: "travel",
      choiceId: "send",
      value: "send_draft",
      freeText: "Original",
      createdAt: "2026-09-06T00:01:00.000Z",
    });
    room.finishDecision("decision-1", first.attemptedAt, "failed", "HTTP 503");
    room.patchStreams([{ streamId: "travel", status: "ongoing" }]);

    const retry = room.beginDecision({
      decisionId: "decision-1",
      streamId: "travel",
      choiceId: "send",
      value: "send_draft",
      freeText: "Original",
      createdAt: "2026-09-06T00:02:00.000Z",
    });
    expect(retry).toMatchObject({
      action: "send",
      decisionId: "decision-1",
      streamId: "travel",
      choiceId: "send",
      value: "send_draft",
      freeText: "Original",
      createdAt: "2026-09-06T00:01:00.000Z",
      kind: "decision",
    });
  });

  test("refuses to unlock a pending decision without changing its lock", () => {
    const room = makeRoom();
    seed(room);
    room.beginDecision({
      decisionId: "decision-1",
      streamId: "travel",
      choiceId: "send",
      value: "send_draft",
      freeText: "",
      createdAt: "2026-09-06T00:01:00.000Z",
    });
    expect(() => room.unlockDecision("travel", "decision-1")).toThrow(
      "pending",
    );
    expect(room.get("travel")?.decisionLock).toMatchObject({
      decisionId: "decision-1",
      status: "pending",
    });
  });

  test("retains the decision lock when delivery status changes", () => {
    const room = makeRoom();
    seed(room);
    const first = room.beginDecision({
      decisionId: "decision-1",
      streamId: "travel",
      choiceId: "send",
      value: "send_draft",
      freeText: "",
      createdAt: "2026-09-06T00:01:00.000Z",
    });
    room.finishDecision("decision-1", first.attemptedAt, "submitted");

    expect(room.get("travel")?.decisionLock).toMatchObject({
      decisionId: "decision-1",
      status: "submitted",
    });
    expect(() =>
      room.beginDecision({
        decisionId: "decision-2",
        streamId: "travel",
        choiceId: "defer",
        value: "defer",
        freeText: "",
        createdAt: "2026-09-06T00:02:00.000Z",
      }),
    ).toThrow("locked");
  });

  test("migrates legacy tables and seeds one deterministic lock per stream", () => {
    const sql = new SqlStub();
    sql.exec(`CREATE TABLE streams (
      stream_id TEXT PRIMARY KEY,
      document TEXT NOT NULL,
      status TEXT NOT NULL,
      needs_don INTEGER NOT NULL,
      priority INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE decisions (
      decision_id TEXT PRIMARY KEY,
      stream_id TEXT NOT NULL,
      choice_id TEXT NOT NULL,
      value TEXT NOT NULL,
      free_text TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      attempted_at TEXT NOT NULL,
      error TEXT
    )`);
    sql.exec(
      "INSERT INTO streams (stream_id, document, status, needs_don, priority, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      "legacy",
      JSON.stringify({
        streamId: "legacy",
        title: "Legacy",
        summary: "Old",
        history: ["Started"],
        ownerBot: "helm",
        status: "active",
        needsDon: true,
        priority: 1,
        choices: [{ id: "send", label: "Send", value: "send_draft" }],
        updatedAt: "2026-09-06T00:00:00Z",
      }),
      "active",
      1,
      1,
      "2026-09-06T00:00:00Z",
    );
    sql.exec(
      "INSERT INTO decisions (decision_id, stream_id, choice_id, value, free_text, status, created_at, attempted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      "old-1",
      "legacy",
      "send",
      "send_draft",
      "",
      "submitted",
      "2026-09-05T00:00:00Z",
      "2026-09-05T00:00:00Z",
    );
    sql.exec(
      "INSERT INTO decisions (decision_id, stream_id, choice_id, value, free_text, status, created_at, attempted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      "old-2",
      "legacy",
      "send",
      "send_draft",
      "later",
      "failed",
      "2026-09-06T00:00:00Z",
      "2026-09-06T00:00:00Z",
    );
    const room = roomFromSql(sql);
    expect(room.get("legacy")?.decisionLock).toMatchObject({
      decisionId: "old-2",
      status: "failed",
      kind: "decision",
    });
    expect(
      sql.db
        .query("SELECT archived FROM streams WHERE stream_id = 'legacy'")
        .get(),
    ).toEqual({ archived: 0 });
    expect(
      sql.db
        .query(
          "SELECT decision_id, locked FROM decision_locks WHERE stream_id = 'legacy'",
        )
        .get(),
    ).toEqual({ decision_id: "old-2", locked: 1 });

    // Running the migration again must not replace the chosen lock.
    roomFromSql(sql);
    expect(
      sql.db
        .query(
          "SELECT decision_id, locked FROM decision_locks WHERE stream_id = 'legacy'",
        )
        .get(),
    ).toEqual({ decision_id: "old-2", locked: 1 });
  });

  test("keeps an archived legacy document hidden even when its old status was active", () => {
    const sql = new SqlStub();
    sql.exec(`CREATE TABLE streams (
      stream_id TEXT PRIMARY KEY,
      document TEXT NOT NULL,
      status TEXT NOT NULL,
      needs_don INTEGER NOT NULL,
      priority INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE decisions (
      decision_id TEXT PRIMARY KEY,
      stream_id TEXT NOT NULL,
      choice_id TEXT NOT NULL,
      value TEXT NOT NULL,
      free_text TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      attempted_at TEXT NOT NULL,
      error TEXT
    )`);
    sql.exec(
      "INSERT INTO streams (stream_id, document, status, needs_don, priority, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      "hidden",
      JSON.stringify({
        streamId: "hidden",
        title: "Hidden",
        ownerBot: "helm",
        status: "active",
        needsDon: true,
        archived: true,
      }),
      "active",
      1,
      0,
      "2026-09-06T00:00:00Z",
    );
    const room = roomFromSql(sql);
    expect(room.list()).toEqual([]);
    expect(room.get("hidden")).toMatchObject({
      archived: true,
      status: "no_action",
    });
  });

  test("legacy needsDon-only updates override an existing modern status", () => {
    const room = makeRoom();
    seed(room, "needs");
    room.upsert({
      streamId: "needs",
      title: "Travel",
      ownerBot: "helm",
      needsDon: false,
    });
    expect(room.get("needs")).toMatchObject({
      status: "ongoing",
      needsDon: false,
    });

    room.upsert({
      streamId: "needs",
      title: "Travel",
      ownerBot: "helm",
      needsDon: true,
    });
    expect(room.get("needs")).toMatchObject({
      status: "needs_decision",
      needsDon: true,
    });
  });

  test("ignores a stale completion after a lease retry starts", () => {
    const room = makeRoom();
    seed(room);
    const first = room.beginDecision({
      decisionId: "decision-1",
      streamId: "travel",
      choiceId: "send",
      value: "send_draft",
      freeText: "",
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    const second = room.beginDecision({
      decisionId: "decision-1",
      streamId: "travel",
      choiceId: "send",
      value: "send_draft",
      freeText: "",
      createdAt: "2026-09-06T00:02:00.000Z",
    });
    expect(first.attemptedAt).not.toBe(second.attemptedAt);

    room.finishDecision("decision-1", first.attemptedAt, "submitted");
    expect(room.get("travel")?.decisionLock).toMatchObject({
      status: "pending",
      attemptedAt: second.attemptedAt,
    });

    room.finishDecision("decision-1", second.attemptedAt, "submitted");
    expect(room.get("travel")?.decisionLock).toMatchObject({
      status: "submitted",
      attemptedAt: second.attemptedAt,
    });
  });

  test("does not let a stale failure downgrade a submitted current attempt", () => {
    const room = makeRoom();
    seed(room);
    const first = room.beginDecision({
      decisionId: "decision-1",
      streamId: "travel",
      choiceId: "send",
      value: "send_draft",
      freeText: "",
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    const second = room.beginDecision({
      decisionId: "decision-1",
      streamId: "travel",
      choiceId: "send",
      value: "send_draft",
      freeText: "",
      createdAt: "2026-09-06T00:03:00.000Z",
    });

    room.finishDecision("decision-1", second.attemptedAt, "submitted");
    room.finishDecision(
      "decision-1",
      first.attemptedAt,
      "failed",
      "late HTTP 503",
    );
    expect(room.get("travel")?.decisionLock).toMatchObject({
      status: "submitted",
      attemptedAt: second.attemptedAt,
    });
  });
});
