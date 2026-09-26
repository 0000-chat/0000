import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";

import { hashCapability, ROOM_LIMITS } from "./room-domain";
import { DurableRoomService } from "./room-service";
import { createWorker } from "./worker";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: unknown;
    constructor(ctx: unknown) { this.ctx = ctx; }
  },
}));

class CoordinationFakeSocket {
  readonly sent: string[] = [];
  closed?: { code: number; reason: string };
  private attachment: unknown;
  send(value: string) { this.sent.push(value); }
  close(code: number, reason: string) { this.closed = { code, reason }; }
  deserializeAttachment() { return this.attachment; }
  serializeAttachment(value: unknown) { this.attachment = value; }
}

class CoordinationFakeWebSocketPair {
  0 = new CoordinationFakeSocket();
  1 = new CoordinationFakeSocket();
}

(globalThis as unknown as { WebSocketPair: typeof CoordinationFakeWebSocketPair }).WebSocketPair = CoordinationFakeWebSocketPair;

class Context {
  alarm: number | undefined;
  deleteAlarmCalls = 0;
  messagePageSelects = 0;
  setAlarmCalls = 0;
  readonly sockets: CoordinationFakeSocket[] = [];
  readonly storage: { readonly sql: { exec(query: string, ...values: unknown[]): Iterable<unknown> }; transactionSync<T>(callback: () => T): T; setAlarm(value: number): Promise<void>; deleteAlarm(): Promise<void> };
  constructor(readonly database: Database) {
    this.storage = {
      sql: { exec: (query, ...values) => {
        if (values.length === 0 && query.includes(";")) { database.exec(query); return []; }
        if (/FROM messages WHERE sequence >/iu.test(query)) this.messagePageSelects += 1;
        const statement = database.query(query);
        if (/^\s*(?:SELECT|PRAGMA)/iu.test(query)) return statement.all(...(values as never[]));
        statement.run(...(values as never[])); return [];
      } },
      transactionSync: <T>(callback: () => T) => database.transaction(callback)(),
      setAlarm: async (value) => { this.alarm = value; this.setAlarmCalls += 1; },
      deleteAlarm: async () => { this.alarm = undefined; this.deleteAlarmCalls += 1; },
    };
  }
  getWebSockets() { return this.sockets; }
  acceptWebSocket(socket: CoordinationFakeSocket) { this.sockets.push(socket); }
  waitUntil() {}
}

async function room(environment: Record<string, string> = {}, existingDatabase?: Database) {
  const { ConversationRoom } = await import("./conversation-room");
  const database = existingDatabase ?? new Database(":memory:");
  let now = 10_000;
  const context = new Context(database);
  return { context, database, room: new ConversationRoom(context as never, { MSG_TEST_MODE: "1", MSG_TEST_ROOM_LIMITS: "{}", ...environment }, () => now), setNow: (value: number) => { now = value; } };
}

function json(path: string, value: unknown, method = "POST"): Request {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (method !== "GET" && method !== "HEAD") init.body = JSON.stringify(withTestNamePassword(path, value));
  return new Request(`https://room${path}`, init);
}

function workerJson(path: string, value: unknown, method = "POST"): Request {
  const init: RequestInit = { method, headers: { accept: "application/json", "content-type": "application/json" } };
  if (method !== "GET" && method !== "HEAD") init.body = JSON.stringify(withTestNamePassword(path, value));
  return new Request(`https://msg.0000.chat${path}`, init);
}

function withTestNamePassword(path: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const route = path.split("?", 1)[0];
  const field = route === "/initialize" ? "initial" : route === "/messages" ? "input" : undefined;
  if (field !== undefined && record[field] !== undefined) {
    const message = record[field];
    if (message !== null && typeof message === "object" && !Array.isArray(message)) {
      const messageRecord = message as Record<string, unknown>;
      if (typeof messageRecord.author === "string" && messageRecord.name_password === undefined) {
        return { ...record, [field]: { ...messageRecord, name_password: "test-password" } };
      }
    }
  }
  if (/^\/[^/]+$/u.test(route) && typeof record.author === "string" && typeof record.content === "string" && record.name_password === undefined) {
    return { ...record, name_password: "test-password" };
  }
  return value;
}

function proposal(retry: string, source: string, baseRevision = 0, title = "Collect evidence") {
  return {
    actor_label: "participant-a",
    base_revision: baseRevision,
    body: {
      completion_criteria: ["A checked report is linked"],
      decision_impact: "Informs the next release decision.",
      owner_label: "owner-a",
      purpose: "Collect evidence for the release.",
      requested_output: "A short checked report.",
      title,
      unknowns: ["Which source is current?"],
    },
    client_retry_id: retry,
    kind: "request.create",
    source_message_ids: [source],
  };
}

function progress(retry: string, requestId: string, status: string, baseRevision: number, source: string, extra: Record<string, unknown> = {}) {
  return {
    actor_label: "reporter-a",
    base_revision: baseRevision,
    body: {
      blockers: status === "blocked" ? ["Waiting for source owner"] : [],
      evidence: status === "done" ? [{ artifact_url: "https://example.com/report", location: "tab:Summary!A1", reported_verification: "Reported checked against the cited source.", remaining_blockers: [] }] : [],
      request_id: requestId,
      status,
      ...extra,
    },
    client_retry_id: retry,
    kind: "request.progress",
    source_message_ids: [source],
  };
}

function panelProposal(retry: string, source: string, baseRevision = 0, purpose: string | null = "Ship the room panel") {
  return {
    actor_label: "panel-author",
    base_revision: baseRevision,
    body: {
      artifacts: [{ role: "canonical spec", title: "Room spec", url: "https://example.com/spec" }],
      next_actions: [{ description: "Review the panel", owner_label: "room-owner" }],
      phase: "review",
      purpose,
    },
    client_retry_id: retry,
    kind: "panel.replace",
    source_message_ids: [source],
  };
}

function decisionProposal(retry: string, source: string, baseRevision = 0, title = "Choose a release") {
  return {
    actor_label: "decision-recommender",
    base_revision: baseRevision,
    body: {
      proposal_text: "Ship the reviewed release after the evidence is checked.",
      required_approver_labels: ["alice", "bob"],
      title,
    },
    client_retry_id: retry,
    kind: "decision.proposal",
    source_message_ids: [source],
  };
}

function decisionPosition(retry: string, decisionId: string, revision: number, source: string, participantLabel = "carol") {
  return {
    actor_label: "position-reporter",
    base_revision: 0,
    body: {
      decision_proposal_id: decisionId,
      decision_revision: revision,
      participant_label: participantLabel,
      statement: "I report this position for owner review; it is not an acceptance.",
    },
    client_retry_id: retry,
    kind: "decision.position",
    source_message_ids: [source],
  };
}

function exportPathValue(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

test("routes a complete panel replacement through pending review, exact publication, history, and agent reads", async () => {
  const { room: durable } = await room();
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "panel source", author: "a", display_name: "A", semantic_type: "message" } }));
  const sourceId = (await initialized.json() as { id: string }).id;
  const service = new DurableRoomService({ getByName: () => ({ fetch: (request: Request) => durable.fetch(request) }) }, "https://msg.0000.chat");
  const worker = createWorker(service);
  const initialLegacyRead = await worker.fetch(new Request("https://msg.0000.chat/room", { headers: { accept: "application/json" } }));
  const initialLegacyEtag = initialLegacyRead.headers.get("etag");
  const initialLegacyValue = await initialLegacyRead.json() as { latest_message: number; expires_at: string };
  const initialBoundedRead = await worker.fetch(new Request("https://msg.0000.chat/room?limit=20", { headers: { accept: "application/json" } }));
  const initialBoundedEtag = initialBoundedRead.headers.get("etag");
  const initialBoundedValue = await initialBoundedRead.json() as { latest_message: number; expires_at: string };
  expect(initialLegacyEtag).not.toBe(initialBoundedEtag);
  const initialOverview = await worker.fetch(new Request("https://msg.0000.chat/room/coordination"));
  const initialEtag = initialOverview.headers.get("etag");
  const proposalResponse = await durable.fetch(json("/coordination/proposals", panelProposal("panel-proposal", sourceId)));
  expect(proposalResponse.status).toBe(201);
  const proposalValue = await proposalResponse.json() as { proposal: { proposal_id: string; request_id: string | null; revision: number } };
  expect(proposalValue.proposal.request_id).toBeNull();
  expect((await (await durable.fetch(new Request("https://room/coordination"))).json()) as { pending_panel_proposal_count: number; panel: unknown }).toMatchObject({ pending_panel_proposal_count: 1, panel: null });
  const pendingOverview = await worker.fetch(new Request("https://msg.0000.chat/room/coordination", { headers: { "if-none-match": initialEtag ?? "" } }));
  expect(pendingOverview.status).toBe(200);
  expect(pendingOverview.headers.get("etag")).not.toBe(initialEtag);
  const pendingLegacyRead = await worker.fetch(new Request("https://msg.0000.chat/room", { headers: { accept: "application/json", "if-none-match": initialLegacyEtag ?? "" } }));
  expect(pendingLegacyRead.status).toBe(200);
  expect(await pendingLegacyRead.json()).toMatchObject({ latest_message: initialLegacyValue.latest_message, expires_at: initialLegacyValue.expires_at });
  const pendingBoundedRead = await worker.fetch(new Request("https://msg.0000.chat/room?limit=20", { headers: { accept: "application/json", "if-none-match": initialBoundedEtag ?? "" } }));
  expect(pendingBoundedRead.status).toBe(200);
  expect(await pendingBoundedRead.json()).toMatchObject({ latest_message: initialBoundedValue.latest_message, expires_at: initialBoundedValue.expires_at });
  const published = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "panel-publish", owner_label: "room-owner", proposal_id: proposalValue.proposal.proposal_id, revision: 1 }));
  expect(published.status).toBe(201);
  const publication = await published.json() as { panel: { purpose: string | null; artifacts: readonly { role: string }[]; next_actions: readonly { owner_label: string }[]; published_revision: number }; request?: unknown; published_revision: number };
  expect(publication.request).toBeUndefined();
  expect(publication).toMatchObject({ published_revision: 1, panel: { purpose: "Ship the room panel", artifacts: [{ role: "canonical spec" }], next_actions: [{ owner_label: "room-owner" }], published_revision: 1 } });
  const afterPublication = await worker.fetch(new Request("https://msg.0000.chat/room/coordination", { headers: { "if-none-match": pendingOverview.headers.get("etag") ?? "" } }));
  expect(afterPublication.status).toBe(200);
  const afterPublicationLegacyRead = await worker.fetch(new Request("https://msg.0000.chat/room", { headers: { accept: "application/json", "if-none-match": pendingLegacyRead.headers.get("etag") ?? "" } }));
  expect(afterPublicationLegacyRead.status).toBe(200);
  expect(await afterPublicationLegacyRead.json()).toMatchObject({ latest_message: initialLegacyValue.latest_message, expires_at: initialLegacyValue.expires_at });
  const afterPublicationBoundedRead = await worker.fetch(new Request("https://msg.0000.chat/room?limit=20", { headers: { accept: "application/json", "if-none-match": pendingBoundedRead.headers.get("etag") ?? "" } }));
  expect(afterPublicationBoundedRead.status).toBe(200);
  expect(await afterPublicationBoundedRead.json()).toMatchObject({ latest_message: initialBoundedValue.latest_message, expires_at: initialBoundedValue.expires_at });
  const panel = await (await durable.fetch(new Request("https://room/coordination/panel"))).json() as { panel: { proposal_id: string; published_revision: number } | null };
  expect(panel).toMatchObject({ panel: { proposal_id: proposalValue.proposal.proposal_id, published_revision: 1 } });
  expect((await durable.fetch(new Request("https://room/coordination/panel?revision=1"))).status).toBe(200);
  expect((await durable.fetch(new Request("https://room/coordination/panel?revision=9"))).status).toBe(404);
  const history = await (await durable.fetch(new Request("https://room/coordination/panel/history?limit=20"))).json() as { events: readonly { cursor: number; panel?: unknown }[] };
  expect(history.events).toHaveLength(1);
  const read = await (await durable.fetch(new Request("https://room/read?after=0&limit=20"))).json() as { coordination_overview: { panel_published_revision: number } };
  expect(read.coordination_overview.panel_published_revision).toBe(1);
});

test("routes bounded retention inspection and extension without changing chat state", async () => {
  const { room: durable, database, setNow } = await room({ MSG_TEST_ROOM_LIMITS: JSON.stringify({ inactivityTtlMs: 1_000 }) });
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
  expect(initialized.status).toBe(200);
  const service = new DurableRoomService({ getByName: () => ({ fetch: (request: Request) => durable.fetch(request) }) }, "https://msg.0000.chat");
  const worker = createWorker(service);

  const before = await worker.fetch(new Request("https://msg.0000.chat/room", { headers: { accept: "application/json" } }));
  const beforeValue = await before.json() as { expires_at: string; latest_message: number; message_count?: number; coordination_cursor: number; retention: { inactivity_window_ms: number; mode: string; policy: string } };
  expect(beforeValue).toMatchObject({ latest_message: 1, coordination_cursor: 0, retention: { inactivity_window_ms: 1_000, mode: "temporary", policy: "sliding_inactivity" } });
  const beforeEtag = before.headers.get("etag");

  const inspect = await worker.fetch(new Request("https://msg.0000.chat/manage/room/owner-token", { headers: { accept: "application/json" } }));
  expect(inspect.status).toBe(200);
  expect(inspect.headers.get("cache-control")).toContain("no-store");
  const bounds = await inspect.json() as { expires_at: string; maximum_expires_at: string; minimum_expires_at: string; retention: { inactivity_window_ms: number }; server_now: string };
  expect(bounds).toMatchObject({ expires_at: bounds.minimum_expires_at, retention: { inactivity_window_ms: 1_000 }, server_now: new Date(10_000).toISOString() });

  const extension = await worker.fetch(workerJson("/manage/room/owner-token/retention", { client_retry_id: "retention-1", expires_at: bounds.maximum_expires_at }));
  expect(extension.status).toBe(201);
  const receipt = await extension.json() as { client_retry_id: string; event_id: string; old_expires_at: string; requested_expires_at: string; result_expires_at: string; expires_at: string; replayed: boolean; coordination_cursor: number; latest_message: number };
  expect(receipt).toMatchObject({ client_retry_id: "retention-1", old_expires_at: beforeValue.expires_at, requested_expires_at: bounds.maximum_expires_at, result_expires_at: bounds.maximum_expires_at, expires_at: bounds.maximum_expires_at, replayed: false, coordination_cursor: 1, latest_message: 1 });
  expect(receipt.event_id).toMatch(/[0-9a-f-]{36}/u);
  expect(database.query("SELECT kind, operation, actor_label, authority_class, proposal_id, request_id, resulting_revision, source_message_ids, base_revision FROM coordination_events").all()).toEqual([{
    kind: "retention.extended", operation: "retention.extended", actor_label: "Management capability holder", authority_class: "management", proposal_id: null, request_id: null, resulting_revision: null, source_message_ids: "[]", base_revision: 0,
  }]);

  setNow(10_001);
  const post = await worker.fetch(workerJson("/room", { content: "activity", author: "b", display_name: "B", semantic_type: "message" }));
  expect(post.status).toBe(201);
  const afterPost = await post.json() as { message: { sequence: number }; expires_at: string };
  expect(afterPost.message.sequence).toBe(2);
  const replay = await worker.fetch(workerJson("/manage/room/owner-token/retention", { client_retry_id: "retention-1", expires_at: new Date(Date.parse(receipt.requested_expires_at) - 1).toISOString() }));
  expect(replay.status).toBe(409);
  const exactReplay = await worker.fetch(workerJson("/manage/room/owner-token/retention", { client_retry_id: "retention-1", expires_at: new Date(Date.parse(receipt.requested_expires_at)).toISOString() }));
  expect(exactReplay.status).toBe(200);
  expect(await exactReplay.json()).toMatchObject({ replayed: true, event_id: receipt.event_id, result_expires_at: receipt.result_expires_at, current_expires_at: afterPost.expires_at, current_coordination_cursor: 1 });

  const after = await worker.fetch(new Request("https://msg.0000.chat/room", { headers: { accept: "application/json", ...(beforeEtag === null ? {} : { "if-none-match": beforeEtag }) } }));
  expect(after.status).toBe(200);
  expect(await after.json()).toMatchObject({ latest_message: 2, coordination_cursor: 1 });
});

test("invalidates room and exact-message validators when the configured retention window changes", async () => {
  const database = new Database(":memory:");
  const first = await room({ MSG_TEST_ROOM_LIMITS: JSON.stringify({ inactivityTtlMs: 1_000 }) }, database);
  const initialized = await first.room.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
  const messageId = (await initialized.json() as { id: string }).id;
  const firstService = new DurableRoomService({ getByName: () => ({ fetch: (request: Request) => first.room.fetch(request) }) }, "https://msg.0000.chat");
  const firstWorker = createWorker(firstService);
  const firstRoomRead = await firstWorker.fetch(new Request("https://msg.0000.chat/room", { headers: { accept: "application/json" } }));
  const firstMessageRead = await firstWorker.fetch(new Request(`https://msg.0000.chat/room/messages/${messageId}`, { headers: { accept: "application/json" } }));
  const firstRoomEtag = firstRoomRead.headers.get("etag");
  const firstMessageEtag = firstMessageRead.headers.get("etag");
  expect(await firstRoomRead.json()).toMatchObject({ retention: { inactivity_window_ms: 1_000 } });
  expect(await firstMessageRead.json()).toMatchObject({ retention: { inactivity_window_ms: 1_000 } });

  const second = await room({ MSG_TEST_ROOM_LIMITS: JSON.stringify({ inactivityTtlMs: 2_000 }) }, database);
  const secondService = new DurableRoomService({ getByName: () => ({ fetch: (request: Request) => second.room.fetch(request) }) }, "https://msg.0000.chat");
  const secondWorker = createWorker(secondService);
  const secondRoomRead = await secondWorker.fetch(new Request("https://msg.0000.chat/room", { headers: { accept: "application/json", "if-none-match": firstRoomEtag ?? "" } }));
  const secondMessageRead = await secondWorker.fetch(new Request(`https://msg.0000.chat/room/messages/${messageId}`, { headers: { accept: "application/json", "if-none-match": firstMessageEtag ?? "" } }));
  expect(secondRoomRead.status).toBe(200);
  expect(secondMessageRead.status).toBe(200);
  expect(await secondRoomRead.json()).toMatchObject({ retention: { inactivity_window_ms: 2_000 } });
  expect(await secondMessageRead.json()).toMatchObject({ retention: { inactivity_window_ms: 2_000 } });
  expect(secondRoomRead.headers.get("etag")).not.toBe(firstRoomEtag);
  expect(secondMessageRead.headers.get("etag")).not.toBe(firstMessageEtag);
});

test("keeps retention extension quota failures atomic", async () => {
  const { room: durable, database } = await room({ MSG_TEST_ROOM_LIMITS: JSON.stringify({ inactivityTtlMs: 1_000 }) });
  await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
  const service = new DurableRoomService({ getByName: () => ({ fetch: (request: Request) => durable.fetch(request) }) }, "https://msg.0000.chat");
  const worker = createWorker(service);
  const inspect = await worker.fetch(new Request("https://msg.0000.chat/manage/room/owner-token", { headers: { accept: "application/json" } }));
  const bounds = await inspect.json() as { maximum_expires_at: string };
  const before = database.query("SELECT inactivity_expires_at, coordination_cursor, total_bytes FROM room_state WHERE singleton = 1").get() as Record<string, number>;
  database.query("UPDATE room_state SET total_bytes = ? WHERE singleton = 1").run(ROOM_LIMITS.maxRoomBytes - 1);
  const response = await worker.fetch(workerJson("/manage/room/owner-token/retention", { client_retry_id: "quota-retention", expires_at: bounds.maximum_expires_at }));
  expect(response.status).toBe(429);
  expect(database.query("SELECT inactivity_expires_at, coordination_cursor, total_bytes FROM room_state WHERE singleton = 1").get()).toMatchObject({ inactivity_expires_at: before.inactivity_expires_at, coordination_cursor: before.coordination_cursor, total_bytes: ROOM_LIMITS.maxRoomBytes - 1 });
  expect(database.query("SELECT COUNT(*) AS count FROM coordination_events").get()).toEqual({ count: 0 });
  expect(database.query("SELECT COUNT(*) AS count FROM coordination_retries").get()).toEqual({ count: 0 });
});

test("rejects malformed retention timestamps before fingerprinting", async () => {
  const { room: durable } = await room();
  await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
  const service = new DurableRoomService({ getByName: () => ({ fetch: (request: Request) => durable.fetch(request) }) }, "https://msg.0000.chat");
  const worker = createWorker(service);
  const response = await worker.fetch(workerJson("/room/owner-token/retention", { client_retry_id: "bad-date", expires_at: "2026-02-30T00:00:00Z" }));
  expect(response.status).toBe(404);
  const valid = await worker.fetch(workerJson("/manage/room/owner-token/retention", { client_retry_id: "bad-date", expires_at: "2026-02-30T00:00:00Z" }));
  expect(valid.status).toBe(400);
});

test("enforces fresh retention authorization and inclusive bounds, including a recorded no-op", async () => {
  const { room: durable, database } = await room({ MSG_TEST_ROOM_LIMITS: JSON.stringify({ inactivityTtlMs: 1_000 }) });
  await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
  const service = new DurableRoomService({ getByName: () => ({ fetch: (request: Request) => durable.fetch(request) }) }, "https://msg.0000.chat");
  const worker = createWorker(service);

  const beforeState = database.query("SELECT last_message_at, next_sequence, message_count, published_revision FROM room_state WHERE singleton = 1").get();
  expect((await worker.fetch(new Request("https://msg.0000.chat/manage/room/wrong-token", { headers: { accept: "application/json" } }))).status).toBe(404);
  const inspect = await worker.fetch(new Request("https://msg.0000.chat/manage/room/owner-token", { headers: { accept: "application/json" } }));
  const bounds = await inspect.json() as { expires_at: string; minimum_expires_at: string; maximum_expires_at: string };
  expect(inspect.status).toBe(200);
  expect(bounds.expires_at).toBe(bounds.minimum_expires_at);
  const belowMinimum = await worker.fetch(workerJson("/manage/room/owner-token/retention", { client_retry_id: "retention-below", expires_at: new Date(Date.parse(bounds.minimum_expires_at) - 1).toISOString() }));
  const aboveMaximum = await worker.fetch(workerJson("/manage/room/owner-token/retention", { client_retry_id: "retention-above", expires_at: new Date(Date.parse(bounds.maximum_expires_at) + 1).toISOString() }));
  expect(belowMinimum.status).toBe(400);
  expect(aboveMaximum.status).toBe(400);

  const noOp = await worker.fetch(workerJson("/manage/room/owner-token/retention", { client_retry_id: "retention-no-op", expires_at: bounds.expires_at }));
  expect(noOp.status).toBe(201);
  const receipt = await noOp.json() as { old_expires_at: string; requested_expires_at: string; result_expires_at: string; expires_at: string; replayed: boolean; coordination_cursor: number; event_id: string };
  expect(receipt).toMatchObject({ old_expires_at: bounds.expires_at, requested_expires_at: bounds.expires_at, result_expires_at: bounds.expires_at, expires_at: bounds.expires_at, replayed: false, coordination_cursor: 1 });
  expect(receipt.event_id).toMatch(/[0-9a-f-]{36}/u);
  const afterState = database.query("SELECT last_message_at, next_sequence, message_count, published_revision, coordination_cursor, inactivity_expires_at FROM room_state WHERE singleton = 1").get() as Record<string, number>;
  expect(afterState).toMatchObject({ ...(beforeState as Record<string, number>), coordination_cursor: 1, inactivity_expires_at: Date.parse(bounds.expires_at) });
  const event = database.query("SELECT body FROM coordination_events WHERE event_id = ?").get(receipt.event_id) as { body: string };
  expect(JSON.parse(event.body)).toEqual({ configured_inactivity_window_ms: 1_000, new_expires_at: bounds.expires_at, old_expires_at: bounds.expires_at });
});

test("serializes racing retention extensions into bounded immutable receipts", async () => {
  const { room: durable, database, setNow } = await room({ MSG_TEST_ROOM_LIMITS: JSON.stringify({ inactivityTtlMs: 1_000 }) });
  await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
  const service = new DurableRoomService({ getByName: () => ({ fetch: (request: Request) => durable.fetch(request) }) }, "https://msg.0000.chat");
  const worker = createWorker(service);
  setNow(10_500);
  const inspect = await worker.fetch(new Request("https://msg.0000.chat/manage/room/owner-token", { headers: { accept: "application/json" } }));
  const maximum = (await inspect.json() as { maximum_expires_at: string }).maximum_expires_at;
  const responses = await Promise.all([
    worker.fetch(workerJson("/manage/room/owner-token/retention", { client_retry_id: "retention-race-a", expires_at: maximum })),
    worker.fetch(workerJson("/manage/room/owner-token/retention", { client_retry_id: "retention-race-b", expires_at: maximum })),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([201, 201]);
  const receipts = await Promise.all(responses.map(async (response) => await response.json() as { client_retry_id: string; event_id: string; old_expires_at: string; result_expires_at: string; coordination_cursor: number; maximum_expires_at: string }));
  expect(new Set(receipts.map((receipt) => receipt.event_id)).size).toBe(2);
  expect(receipts.map((receipt) => receipt.coordination_cursor).sort()).toEqual([1, 2]);
  expect(receipts.every((receipt) => receipt.result_expires_at === maximum && receipt.maximum_expires_at === maximum)).toBe(true);
  expect(new Set(receipts.map((receipt) => receipt.old_expires_at))).toEqual(new Set([new Date(11_000).toISOString(), maximum]));
  expect(database.query("SELECT coordination_cursor, inactivity_expires_at, last_message_at, next_sequence, message_count, published_revision FROM room_state WHERE singleton = 1").get()).toMatchObject({ coordination_cursor: 2, inactivity_expires_at: Date.parse(maximum), last_message_at: 10_000, next_sequence: 2, message_count: 1, published_revision: 0 });
  expect(database.query("SELECT COUNT(*) AS count FROM coordination_events WHERE kind = 'retention.extended'").get()).toEqual({ count: 2 });
  expect(database.query("SELECT COUNT(*) AS count FROM coordination_retries WHERE operation = 'retention.extend'").get()).toEqual({ count: 2 });
});

test("cannot resurrect a room after expiry or explicit deletion", async () => {
  const fixture = async () => {
    const value = await room({ MSG_TEST_ROOM_LIMITS: JSON.stringify({ inactivityTtlMs: 1_000 }) });
    await value.room.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
    const service = new DurableRoomService({ getByName: () => ({ fetch: (request: Request) => value.room.fetch(request) }) }, "https://msg.0000.chat");
    return { ...value, worker: createWorker(service) };
  };

  const expired = await fixture();
  expired.setNow(11_001);
  const expiryAttempt = await expired.worker.fetch(workerJson("/manage/room/owner-token/retention", { client_retry_id: "retention-after-expiry", expires_at: new Date(12_000).toISOString() }));
  expect(expiryAttempt.status).toBe(410);
  expect(expired.database.query("SELECT status FROM room_state WHERE singleton = 1").get()).toEqual({ status: "deleted" });
  expect(expired.database.query("SELECT COUNT(*) AS count FROM coordination_events").get()).toEqual({ count: 0 });
  expect((await expired.worker.fetch(workerJson("/manage/room/owner-token/retention", { client_retry_id: "retention-after-delete", expires_at: new Date(12_000).toISOString() }))).status).toBe(404);

  const deleted = await fixture();
  const deleteResponse = await deleted.worker.fetch(new Request("https://msg.0000.chat/manage/room/owner-token", { method: "DELETE", headers: { accept: "application/json" } }));
  expect(deleteResponse.status).toBe(200);
  expect(await deleteResponse.json()).toMatchObject({ deleted: true });
  expect((await deleted.worker.fetch(workerJson("/manage/room/owner-token/retention", { client_retry_id: "retention-after-explicit-delete", expires_at: new Date(12_000).toISOString() }))).status).toBe(404);
});

test("fails a captured export when deletion interleaves with a buffered page", async () => {
  const { room: durable, database } = await room();
  await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
  await durable.fetch(json("/messages", { input: { content: "second", author: "b", display_name: "B", semantic_type: "message" } }));
  const service = new DurableRoomService({ getByName: () => ({ fetch: (request: Request) => durable.fetch(request) }) }, "https://msg.0000.chat");
  const worker = createWorker(service);
  const response = await worker.fetch(new Request("https://msg.0000.chat/room/export.json"));
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const header = await reader.read();
  const message = await reader.read();
  const captured = `${decoder.decode(header.value)}${decoder.decode(message.value)}`;
  expect(header.done).toBe(false);
  expect(message.done).toBe(false);
  expect(captured).toContain('"messages":[');
  expect(captured).toContain('"content":"source"');
  expect(captured).not.toContain('"complete":true');

  const deleted = await worker.fetch(new Request("https://msg.0000.chat/manage/room/owner-token", { method: "DELETE", headers: { accept: "application/json" } }));
  expect(deleted.status).toBe(200);
  let deletionError: unknown;
  try { await reader.read(); } catch (error) { deletionError = error; }
  expect(deletionError).toBeDefined();
  expect(database.query("SELECT status FROM room_state WHERE singleton = 1").get()).toEqual({ status: "deleted" });
});

test("keeps the scheduled expiry lifecycle intact when export expires between pulls", async () => {
  const { room: durable, context, database, setNow } = await room({ MSG_TEST_ROOM_LIMITS: JSON.stringify({ inactivityTtlMs: 1_000 }) });
  await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
  const service = new DurableRoomService({ getByName: () => ({ fetch: (request: Request) => durable.fetch(request) }) }, "https://msg.0000.chat");
  const worker = createWorker(service);
  const live = await durable.fetch(new Request("https://room/live?after=1", { headers: { upgrade: "websocket" } }));
  expect(live.status).toBe(101);
  const response = await worker.fetch(new Request("https://msg.0000.chat/room/export.json"));
  const reader = response.body!.getReader();
  await reader.read();
  await reader.read();
  expect(context.alarm).toBe(11_000);

  setNow(11_001);
  await durable.alarm();
  expect(database.query("SELECT status FROM room_state WHERE singleton = 1").get()).toEqual({ status: "deleted" });
  expect(JSON.parse(context.sockets[0]!.sent.at(-1)!)).toMatchObject({ type: "conversation.expired" });
  expect(context.sockets[0]!.closed).toEqual({ code: 1001, reason: "Conversation expired" });
  expect(context.alarm).toBeGreaterThan(11_001);
  let expiryError: unknown;
  try { await reader.read(); } catch (error) { expiryError = error; }
  expect(expiryError).toBeDefined();
});

test("exports captured coordination history, evidence, and bounded late changes", async () => {
  const { room: durable, database } = await room();
  const service = new DurableRoomService({ getByName: () => ({ fetch: (request: Request) => durable.fetch(request) }) }, "https://msg.0000.chat");
  const worker = createWorker(service);
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "Owner source", author: "owner", display_name: "Owner", semantic_type: "message" } }));
  const ownerSource = (await initialized.json() as { id: string }).id;
  const delegatedToken = "delegated-export-token";
  const delegated = await durable.fetch(json("/manage?token=owner-token", { action: "enable", get_post_token: delegatedToken }));
  expect(delegated.status).toBe(200);
  const managementHash = (database.query("SELECT management_hash FROM room_state WHERE singleton = 1").get() as { management_hash: string }).management_hash;
  const delegatedHash = (database.query("SELECT get_post_hash FROM room_state WHERE singleton = 1").get() as { get_post_hash: string }).get_post_hash;
  expect(managementHash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(delegatedHash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  const webhookCreated = await durable.fetch(json("/webhooks", { url: "https://receiver.example.com/export-secret?audience=public" }));
  expect(webhookCreated.status).toBe(200);
  const webhook = await webhookCreated.json() as { secret: string; webhook: { id: string } };
  expect(webhook.webhook.id).toMatch(/^[0-9a-f-]{36}$/u);
  const pushEnrollment = await durable.fetch(json("/push-subscriptions", {
    browser_id: "export-browser-secret",
    subscription: {
      auth: "push-auth-secret",
      endpoint: "https://push.example.net/export-subscription-secret",
      p256dh: "push-p256dh-secret",
    },
  }));
  expect(pushEnrollment.status).toBe(200);
  const privateExportValues = ["owner-token", managementHash, delegatedHash, delegatedToken, webhook.secret, "https://receiver.example.com/export-secret?audience=public", "push-auth-secret", "push-p256dh-secret", "https://push.example.net/export-subscription-secret", "export-browser-secret"];
  const alice = await durable.fetch(json("/messages", { input: { content: "Alice approval", author: "alice", display_name: "Alice", semantic_type: "message" } }));
  const aliceSource = (await alice.json() as { message: { id: string } }).message.id;
  const bob = await durable.fetch(json("/messages", { input: { content: "Bob approval", author: "bob", display_name: "Bob", semantic_type: "message" } }));
  const bobSource = (await bob.json() as { message: { id: string } }).message.id;
  const expectedProposalKeys = new Set<string>();

  const panelCreated = await worker.fetch(workerJson("/room/coordination/proposals", panelProposal("export-panel", ownerSource)));
  expect(panelCreated.status).toBe(201);
  const panel = await panelCreated.json() as { proposal: { proposal_id: string; revision: number } };
  expectedProposalKeys.add(`${panel.proposal.proposal_id}:${panel.proposal.revision}`);
  expect((await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: 0, client_retry_id: "export-panel-publish", owner_label: "room-owner", proposal_id: panel.proposal.proposal_id, revision: panel.proposal.revision }))).status).toBe(201);

  const requestCreated = await worker.fetch(workerJson("/room/coordination/proposals", proposal("export-request", ownerSource, 1)));
  expect(requestCreated.status).toBe(201);
  const requestValue = await requestCreated.json() as { proposal: { proposal_id: string; request_id: string; revision: number } };
  expectedProposalKeys.add(`${requestValue.proposal.proposal_id}:${requestValue.proposal.revision}`);
  expect((await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: 1, client_retry_id: "export-request-publish", owner_label: "room-owner", proposal_id: requestValue.proposal.proposal_id, revision: requestValue.proposal.revision }))).status).toBe(201);

  const progressCreated = await worker.fetch(workerJson("/room/coordination/proposals", progress("export-progress", requestValue.proposal.request_id, "done", 2, ownerSource)));
  expect(progressCreated.status).toBe(201);
  const progressValue = await progressCreated.json() as { proposal: { proposal_id: string; revision: number } };
  expectedProposalKeys.add(`${progressValue.proposal.proposal_id}:${progressValue.proposal.revision}`);
  expect((await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: 2, client_retry_id: "export-progress-publish", owner_label: "room-owner", proposal_id: progressValue.proposal.proposal_id, revision: progressValue.proposal.revision }))).status).toBe(201);

  const decisionCreated = await worker.fetch(workerJson("/room/coordination/proposals", decisionProposal("export-decision", ownerSource, 3)));
  expect(decisionCreated.status).toBe(201);
  const decision = await decisionCreated.json() as { proposal: { proposal_id: string; revision: number } };
  expectedProposalKeys.add(`${decision.proposal.proposal_id}:${decision.proposal.revision}`);
  expect((await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: 3, client_retry_id: "export-decision-recommendation", decision_publication: { mode: "recommendation" }, owner_label: "room-owner", proposal_id: decision.proposal.proposal_id, revision: decision.proposal.revision }))).status).toBe(201);
  const positionCreated = await worker.fetch(workerJson("/room/coordination/proposals", { ...decisionPosition("export-position", decision.proposal.proposal_id, 1, ownerSource), base_revision: 4 }));
  expect(positionCreated.status).toBe(201);
  const position = await positionCreated.json() as { proposal: { proposal_id: string; revision: number } };
  expectedProposalKeys.add(`${position.proposal.proposal_id}:${position.proposal.revision}`);
  expect((await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: 4, client_retry_id: "export-position-publish", owner_label: "room-owner", proposal_id: position.proposal.proposal_id, revision: position.proposal.revision }))).status).toBe(201);
  const acceptedResponse = await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", {
    base_revision: 5,
    client_retry_id: "export-decision-acceptance",
    decision_publication: { approvals: [{ participant_label: "alice", source_message_id: aliceSource }, { participant_label: "bob", source_message_id: bobSource }], mode: "acceptance", owner_attestation: true },
    owner_label: "room-owner",
    proposal_id: decision.proposal.proposal_id,
    revision: decision.proposal.revision,
  }));
  expect(acceptedResponse.status).toBe(201);
  const accepted = await acceptedResponse.json() as { accepted_record: { accepted_record_id: string }; published_revision: number };
  expect(accepted.published_revision).toBe(6);

  const reportResponse = await worker.fetch(workerJson("/room/coordination/disputes", { accepted_record_id: accepted.accepted_record.accepted_record_id, actor_label: "reviewer", client_retry_id: "export-dispute", kind: "dispute", source_message_ids: [bobSource], statement: "The accepted conclusion needs a review trail." }));
  expect(reportResponse.status).toBe(201);
  const report = await reportResponse.json() as { dispute: { report_id: string } };
  const reviewResponse = await worker.fetch(workerJson(`/manage/room/owner-token/coordination/disputes/${report.dispute.report_id}/review`, { base_revision: 6, client_retry_id: "export-review", disposition: "acknowledged", owner_label: "room-owner", rationale: "The owner recorded the review.", source_message_ids: [bobSource] }));
  expect(reviewResponse.status).toBe(201);
  const review = await reviewResponse.json() as { published_revision: number };
  expect(review.published_revision).toBe(7);

  const correctionResponse = await worker.fetch(workerJson("/room/coordination/proposals", {
    actor_label: "correction-reporter",
    base_revision: 7,
    body: { correction_text: "The published request needs a clearer title.", target: { claim_path: ["title"], published_revision: 2, type: "publication" } },
    client_retry_id: "export-correction",
    kind: "claim.correction",
    source_message_ids: [ownerSource],
  }));
  expect(correctionResponse.status).toBe(201);
  const correction = await correctionResponse.json() as { proposal: { proposal_id: string; revision: number } };
  expectedProposalKeys.add(`${correction.proposal.proposal_id}:${correction.proposal.revision}`);
  const correctionPublication = await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: 7, client_retry_id: "export-correction-publish", owner_label: "room-owner", proposal_id: correction.proposal.proposal_id, revision: correction.proposal.revision }));
  expect(correctionPublication.status).toBe(201);
  expect((await correctionPublication.json() as { published_revision: number }).published_revision).toBe(8);

  const inspect = await worker.fetch(new Request("https://msg.0000.chat/manage/room/owner-token", { headers: { accept: "application/json" } }));
  const bounds = await inspect.json() as { maximum_expires_at: string };
  const retention = await worker.fetch(workerJson("/manage/room/owner-token/retention", { client_retry_id: "export-retention", expires_at: bounds.maximum_expires_at }));
  expect(retention.status).toBe(201);

  const successorResponse = await worker.fetch(workerJson("/room/coordination/proposals", decisionProposal("export-successor", ownerSource, 8, "New release")));
  expect(successorResponse.status).toBe(201);
  const successor = await successorResponse.json() as { proposal: { proposal_id: string; revision: number } };
  expectedProposalKeys.add(`${successor.proposal.proposal_id}:${successor.proposal.revision}`);
  const successorPublication = await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: 8, client_retry_id: "export-successor-acceptance", decision_publication: { approvals: [{ participant_label: "alice", source_message_id: aliceSource }, { participant_label: "bob", source_message_id: bobSource }], mode: "acceptance", owner_attestation: true }, owner_label: "room-owner", proposal_id: successor.proposal.proposal_id, revision: successor.proposal.revision }));
  expect(successorPublication.status).toBe(201);
  const successorAccepted = await successorPublication.json() as { accepted_record: { accepted_record_id: string }; published_revision: number };
  expect(successorAccepted.published_revision).toBe(9);
  const supersessionResponse = await worker.fetch(workerJson("/room/coordination/proposals", {
    actor_label: "supersession-reporter",
    base_revision: 9,
    body: { predecessor_accepted_record_id: accepted.accepted_record.accepted_record_id, successor_decision_id: successor.proposal.proposal_id, successor_decision_revision: successor.proposal.revision },
    client_retry_id: "export-supersession",
    kind: "decision.supersession",
    source_message_ids: [ownerSource],
  }));
  expect(supersessionResponse.status).toBe(201);
  const supersession = await supersessionResponse.json() as { proposal: { proposal_id: string; revision: number } };
  expectedProposalKeys.add(`${supersession.proposal.proposal_id}:${supersession.proposal.revision}`);
  const supersessionPublication = await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: 9, client_retry_id: "export-supersession-publish", owner_label: "room-owner", proposal_id: supersession.proposal.proposal_id, revision: supersession.proposal.revision }));
  expect(supersessionPublication.status).toBe(201);
  expect((await supersessionPublication.json() as { published_revision: number }).published_revision).toBe(10);

  const revisedProposalResponse = await worker.fetch(workerJson("/room/coordination/proposals", proposal("export-revised-v1", bobSource, 10, "Revision one")));
  expect(revisedProposalResponse.status).toBe(201);
  const revisedProposal = await revisedProposalResponse.json() as { proposal: { proposal_id: string; revision: number } };
  expectedProposalKeys.add(`${revisedProposal.proposal.proposal_id}:${revisedProposal.proposal.revision}`);
  const revisedProposalRevisionResponse = await worker.fetch(workerJson(`/room/coordination/proposals/${revisedProposal.proposal.proposal_id}/revisions`, { ...proposal("export-revised-v2", bobSource, 10, "Revision two"), base_revision: 10 }));
  expect(revisedProposalRevisionResponse.status).toBe(201);
  const revisedProposalRevision = await revisedProposalRevisionResponse.json() as { proposal: { proposal_id: string; revision: number } };
  expectedProposalKeys.add(`${revisedProposalRevision.proposal.proposal_id}:${revisedProposalRevision.proposal.revision}`);
  for (let index = 0; index < 105; index += 1) {
    const bulkProposalResponse = await worker.fetch(workerJson("/room/coordination/proposals", proposal(`export-bulk-${index}`, bobSource, 10, `Bulk proposal ${index}`)));
    expect(bulkProposalResponse.status).toBe(201);
    const bulkProposal = await bulkProposalResponse.json() as { proposal: { proposal_id: string; revision: number } };
    expectedProposalKeys.add(`${bulkProposal.proposal.proposal_id}:${bulkProposal.proposal.revision}`);
  }

  const markdownResponse = await worker.fetch(new Request("https://msg.0000.chat/room/export.md"));
  expect(markdownResponse.status).toBe(200);
  const markdown = await markdownResponse.text();
  expect(markdown).toContain("**Captured room record:**");
  expect(markdown).toContain('"id": "');
  expect(markdown).toContain('"created_at": "');
  expect(markdown).toContain('"author": "owner"');
  expect(markdown).toContain('"semantic_type": "message"');
  for (const heading of ["Messages", "Requests", "Request status history", "Panel history", "Proposals and revisions", "Decisions", "Decision history", "Reported positions", "Accepted records", "Approval evidence", "Publications", "Corrections", "Disputes", "Dispute reviews", "Supersessions", "Coordination events", "Retention history", "Published state", "Retention"]) {
    expect(markdown).toContain(`## ${heading}`);
  }
  expect(markdown).toContain("Export complete: true");
  const markdownRecords = [...markdown.matchAll(/```json\n([\s\S]*?)\n```/gu)].map((match) => JSON.parse(match[1]!) as Record<string, unknown>);
  const markdownTargetPublication = markdownRecords.find((record) => record.operation === "request.published" && record.resulting_revision === 2);
  const markdownTargetBody = markdownTargetPublication?.body as Record<string, unknown> | undefined;
  expect(markdownTargetBody).toMatchObject({ title: "Collect evidence" });
  expect(markdownTargetBody).not.toHaveProperty("original");
  expect(exportPathValue(markdownTargetBody, ["title"])).toBe("Collect evidence");
  expect(markdown).toContain("Owner source");
  for (const value of privateExportValues) expect(markdown).not.toContain(value);
  for (const field of ["management_hash", "get_post_hash", "get_post_enabled", "get_post_token", "webhook_endpoints", "push_subscriptions", "source_browser_id", "secret", "p256dh", "auth"]) {
    expect(markdown).not.toContain(`"${field}"`);
  }

  database.query("DELETE FROM messages WHERE id = ?").run(ownerSource);
  const response = await worker.fetch(new Request("https://msg.0000.chat/room/export.json"));
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const header = await reader.read();
  expect(header.done).toBe(false);
  const headerText = decoder.decode(header.value);
  const headerJsonEnd = headerText.indexOf(',"messages":[');
  const capturedHeader = JSON.parse(`${headerText.slice(0, headerJsonEnd)}}`) as { export: { coordination_cursor: number; published_revision: number } };
  const capturedCursor = capturedHeader.export.coordination_cursor;
  const eventIds = (predicate: string): string[] => (database.query(`SELECT event_id FROM coordination_events WHERE ${predicate} AND cursor <= ? ORDER BY cursor ASC`).all(capturedCursor) as { event_id: string }[]).map((event) => event.event_id);
  const recordIds = (table: string, column: string, cursorColumn = "publication_cursor"): string[] => (database.query(`SELECT ${column} AS value FROM ${table} WHERE ${cursorColumn} <= ? ORDER BY ${cursorColumn} ASC, ${column} ASC`).all(capturedCursor) as { value: string }[]).map((record) => record.value);
  const capturedEventIds = new Set(eventIds("1 = 1"));
  const capturedRequestHistoryIds = eventIds("operation = 'request.published'");
  const capturedPanelHistoryIds = eventIds("operation = 'panel.published'");
  const capturedDecisionHistoryIds = eventIds("operation IN ('decision.recommended', 'decision.accepted', 'decision.position.published')");
  const capturedPublicationIds = eventIds("operation IN ('request.published', 'panel.published', 'decision.recommended', 'decision.accepted', 'decision.position.published', 'correction.published', 'supersession.published', 'dispute.reviewed')");
  const capturedRetentionIds = eventIds("operation = 'retention.extended'");
  const capturedPositionIds = recordIds("coordination_decision_positions", "position_id", "published_cursor");
  const capturedAcceptedRecordIds = recordIds("coordination_decision_accepted_records", "accepted_record_id");
  const capturedApprovalIds = (database.query("SELECT a.approval_record_id AS value FROM coordination_decision_approval_evidence AS a JOIN coordination_decision_accepted_records AS r ON r.accepted_record_id = a.accepted_record_id WHERE r.publication_cursor <= ? ORDER BY a.approval_record_id ASC").all(capturedCursor) as { value: string }[]).map((record) => record.value);
  const capturedCorrectionIds = recordIds("coordination_corrections", "correction_id");
  const capturedDisputeIds = recordIds("coordination_disputes", "report_id", "cursor");
  const capturedReviewIds = recordIds("coordination_dispute_reviews", "review_id", "cursor");
  const capturedSupersessionIds = recordIds("coordination_supersessions", "supersession_id");
  const lateReview = await worker.fetch(workerJson(`/manage/room/owner-token/coordination/disputes/${report.dispute.report_id}/review`, { base_revision: 10, client_retry_id: "late-review", disposition: "rejected", owner_label: "room-owner", rationale: "This review is after capture.", source_message_ids: [] }));
  expect(lateReview.status).toBe(201);
  const lateReviewValue = await lateReview.json() as { review: { review_id: string } };
  const lateProgress = await worker.fetch(workerJson("/room/coordination/proposals", progress("late-progress", requestValue.proposal.request_id, "blocked", 11, bobSource, { reopen_reason: "A later review reopened this work." })));
  expect(lateProgress.status).toBe(201);
  const lateProgressValue = await lateProgress.json() as { proposal: { proposal_id: string; revision: number } };
  const lateRequestPublication = await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: 11, client_retry_id: "late-request-publish", owner_label: "room-owner", proposal_id: lateProgressValue.proposal.proposal_id, revision: lateProgressValue.proposal.revision }));
  expect(lateRequestPublication.status).toBe(201);
  const latePanel = await worker.fetch(workerJson("/room/coordination/proposals", panelProposal("late-panel", bobSource, 12, "Late panel")));
  expect(latePanel.status).toBe(201);
  const latePanelValue = await latePanel.json() as { proposal: { proposal_id: string; revision: number } };
  const latePanelPublication = await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: 12, client_retry_id: "late-panel-publish", owner_label: "room-owner", proposal_id: latePanelValue.proposal.proposal_id, revision: latePanelValue.proposal.revision }));
  expect(latePanelPublication.status).toBe(201);
  const lateRetention = await worker.fetch(workerJson("/manage/room/owner-token/retention", { client_retry_id: "late-retention", expires_at: bounds.maximum_expires_at }));
  expect(lateRetention.status).toBe(201);

  let output = decoder.decode(header.value);
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    output += decoder.decode(next.value, { stream: true });
  }
  output += decoder.decode();
  const exported = JSON.parse(output) as {
    export: { message_max_sequence: number; coordination_cursor: number; published_revision: number };
    messages: readonly Record<string, unknown>[];
    coordination: Record<string, readonly Record<string, unknown>[]> & { panel: Record<string, unknown> | null };
    retention: { history: readonly Record<string, unknown>[] };
    complete: boolean;
  };
  expect(exported.complete).toBe(true);
  expect(exported.export.message_max_sequence).toBe(3);
  expect(exported.export.coordination_cursor).toBe(capturedCursor);
  expect(exported.export.published_revision).toBe(capturedHeader.export.published_revision);
  const exactIds = (records: readonly Record<string, unknown>[], key: string, expected: readonly string[]) => {
    const actual = records.map((record) => String(record[key]));
    expect(actual.length).toBe(expected.length);
    expect(new Set(actual).size).toBe(actual.length);
    expect([...actual].sort()).toEqual([...expected].sort());
  };
  exactIds(exported.coordination.events, "event_id", [...capturedEventIds]);
  exactIds(exported.coordination.request_history, "event_id", capturedRequestHistoryIds);
  exactIds(exported.coordination.panel_history, "event_id", capturedPanelHistoryIds);
  exactIds(exported.coordination.decision_history, "event_id", capturedDecisionHistoryIds);
  exactIds(exported.coordination.publications, "event_id", capturedPublicationIds);
  exactIds(exported.coordination.positions, "position_id", capturedPositionIds);
  exactIds(exported.coordination.accepted_records, "accepted_record_id", capturedAcceptedRecordIds);
  exactIds(exported.coordination.approval_evidence, "approval_record_id", capturedApprovalIds);
  exactIds(exported.coordination.corrections, "correction_id", capturedCorrectionIds);
  exactIds(exported.coordination.disputes, "report_id", capturedDisputeIds);
  exactIds(exported.coordination.dispute_reviews, "review_id", capturedReviewIds);
  exactIds(exported.coordination.supersessions, "supersession_id", capturedSupersessionIds);
  expect(JSON.stringify(exported)).not.toContain("owner-token");
  expect(JSON.stringify(exported)).not.toContain("management_hash");
  expect(JSON.stringify(exported)).not.toContain("coordination_retries");
  const actualProposalKeys = exported.coordination.proposals.map((proposal) => `${String(proposal.proposal_id)}:${String(proposal.revision)}`);
  expect(actualProposalKeys.length).toBe(expectedProposalKeys.size);
  expect(new Set(actualProposalKeys).size).toBe(actualProposalKeys.length);
  expect([...actualProposalKeys].sort()).toEqual([...expectedProposalKeys].sort());
  exactIds(exported.coordination.decisions, "decision_id", [decision.proposal.proposal_id, successor.proposal.proposal_id]);
  exactIds(exported.coordination.requests, "request_id", [requestValue.proposal.request_id]);
  expect(exported.coordination.requests[0]).toMatchObject({ status: "done", body: { title: "Collect evidence" }, progress: { status: "done" } });
  expect(exported.coordination.panel).toMatchObject({ proposal_id: panel.proposal.proposal_id, purpose: "Ship the room panel" });
  const targetCorrection = exported.coordination.corrections.find((correction) => (correction.target as Record<string, unknown> | undefined)?.published_revision === 2);
  const targetPublication = exported.coordination.publications.find((publication) => publication.operation === "request.published" && publication.resulting_revision === 2);
  const targetPublicationBody = targetPublication?.body as Record<string, unknown> | undefined;
  expect(targetCorrection).toBeDefined();
  if (targetCorrection === undefined) throw new Error("The export omitted the target correction.");
  expect(targetPublicationBody).toMatchObject({ title: "Collect evidence" });
  expect(targetPublicationBody).not.toHaveProperty("original");
  expect(exportPathValue(targetPublicationBody, ((targetCorrection.target as Record<string, unknown>).claim_path ?? []) as (string | number)[])).toBe("Collect evidence");
  const positionPublication = exported.coordination.publications.find((publication) => publication.operation === "decision.position.published");
  expect(positionPublication?.body).toMatchObject({ position_id: position.proposal.proposal_id, reporter_label: "position-reporter" });
  const reviewRecord = exported.coordination.dispute_reviews[0];
  const reviewPublication = exported.coordination.publications.find((publication) => publication.operation === "dispute.reviewed");
  expect(reviewPublication?.body).toMatchObject({ created_at: reviewRecord?.created_at, review_id: reviewRecord?.review_id });
  exactIds(exported.retention.history, "event_id", capturedRetentionIds);
  expect(exported.messages.some((message) => message.content === "Bob approval")).toBe(true);
  const exportedJson = JSON.stringify(exported);
  for (const value of privateExportValues) expect(exportedJson).not.toContain(value);
  for (const field of ["management_hash", "get_post_hash", "get_post_enabled", "get_post_token", "webhook_endpoints", "push_subscriptions", "source_browser_id", "secret", "p256dh", "auth"]) {
    expect(exportedJson).not.toContain(`"${field}"`);
  }
  expect(exported.coordination.events.some((event) => event.review_id === lateReviewValue.review.review_id)).toBe(false);
  expect(exported.coordination.events.some((event) => event.proposal_id === lateProgressValue.proposal.proposal_id)).toBe(false);
  expect(exported.coordination.events.some((event) => event.proposal_id === latePanelValue.proposal.proposal_id)).toBe(false);
  expect(database.query("SELECT status FROM coordination_requests WHERE request_id = ?").get(requestValue.proposal.request_id)).toMatchObject({ status: "blocked" });
  expect(database.query("SELECT proposal_id FROM coordination_panel WHERE singleton = 1").get()).toMatchObject({ proposal_id: latePanelValue.proposal.proposal_id });
  expect(database.query("SELECT COUNT(*) AS count FROM coordination_dispute_reviews WHERE report_id = ?").get(report.dispute.report_id)).toEqual({ count: 2 });
  const missingSource = exported.coordination.corrections[0]?.source_messages?.[0] as Record<string, unknown> | undefined;
  expect(missingSource).toMatchObject({ id: ownerSource, available: false, unavailable_reason: "The original source message is unavailable in this captured room." });
  expect(missingSource).not.toHaveProperty("content");
  expect(missingSource).not.toHaveProperty("author");
});

test("cancels a paged export before it schedules another message page", async () => {
  const { room: durable, context } = await room();
  await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "control-0", author: "fixture", display_name: "Fixture", client: "coordination-test", semantic_type: "message" } }));
  for (let index = 1; index <= 40; index += 1) {
    const response = await durable.fetch(json("/messages", { input: { content: `control-${index}`, author: "fixture", display_name: "Fixture", client: "coordination-test", semantic_type: "message", reply_to: "1" } }));
    expect(response.status).toBe(200);
  }
  const service = new DurableRoomService({ getByName: () => ({ fetch: (request: Request) => durable.fetch(request) }) }, "https://msg.0000.chat");
  const worker = createWorker(service);
  const response = await worker.fetch(new Request("https://msg.0000.chat/room/export.json"));
  const reader = response.body!.getReader();
  const beforeHeader = context.messagePageSelects;
  const header = await reader.read();
  expect(header.done).toBe(false);
  expect(context.messagePageSelects).toBe(beforeHeader);
  const firstMessage = await reader.read();
  expect(firstMessage.done).toBe(false);
  expect(context.messagePageSelects).toBe(beforeHeader + 1);
  const alarmsAfterFirstMessage = context.setAlarmCalls;
  await reader.cancel();
  await Promise.resolve();
  expect(context.messagePageSelects).toBe(beforeHeader + 1);
  expect(context.setAlarmCalls).toBe(alarmsAfterFirstMessage);
});

test("exports a large control-heavy message exactly in bounded JSON and Markdown pages", async () => {
  const { room: durable, context } = await room();
  await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
  const content = Array.from({ length: 64 * 1024 }, (_, index) => ["\u0000", "\u0001", "\u0008", "\u0009", "\u000a", "\u000b", "\u000c", "\u000d", "\u001b"][index % 9]!).join("");
  const posted = await durable.fetch(json("/messages", { input: { content, author: "control-heavy", display_name: "Control Heavy", semantic_type: "message" } }));
  expect(posted.status).toBe(200);
  const messageId = (await posted.json() as { message: { id: string } }).message.id;
  const service = new DurableRoomService({ getByName: () => ({ fetch: (request: Request) => durable.fetch(request) }) }, "https://msg.0000.chat");
  const worker = createWorker(service);

  const beforeJsonPages = context.messagePageSelects;
  const jsonResponse = await worker.fetch(new Request("https://msg.0000.chat/room/export.json"));
  expect(jsonResponse.status).toBe(200);
  const jsonText = await jsonResponse.text();
  const exported = JSON.parse(jsonText) as { messages: readonly { content: string; id: string }[]; complete: boolean };
  expect(exported.complete).toBe(true);
  expect(exported.messages.find((message) => message.id === messageId)?.content).toBe(content);
  expect(jsonText).toContain("\\u0000");
  expect(new TextEncoder().encode(jsonText).byteLength).toBeGreaterThan(content.length * 3);
  expect(context.messagePageSelects).toBe(beforeJsonPages + 1);

  const beforeMarkdownPages = context.messagePageSelects;
  const markdownResponse = await worker.fetch(new Request("https://msg.0000.chat/room/export.md"));
  expect(markdownResponse.status).toBe(200);
  const markdown = await markdownResponse.text();
  expect(markdown).toContain("Export complete: true");
  expect(markdown).toContain(content);
  expect(markdown).toContain(`"id": "${messageId}"`);
  expect(context.messagePageSelects).toBe(beforeMarkdownPages + 1);
});

test("runs proposal, review, exact publication, retries, and revisions inside the room route", async () => {
  const { room: durable } = await room();
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source evidence", author: "participant", display_name: "Participant", semantic_type: "message" } }));
  const sourceId = (await initialized.json() as { id: string }).id;
  const before = await durable.fetch(new Request("https://room/read?after=0&limit=20"));
  const beforeValue = await before.json() as { expires_at: string; latest_message: number; coordination_cursor: number };

  const created = await durable.fetch(json("/coordination/proposals", proposal("proposal-1", sourceId)));
  expect(created.status).toBe(201);
  const createdValue = await created.json() as { proposal: { proposal_id: string; request_id: string; revision: number; status: string; source_messages: readonly { id: string; content?: string }[] }; coordination_cursor: number; replayed: boolean };
  expect(createdValue).toMatchObject({ coordination_cursor: 1, replayed: false, proposal: { revision: 1, status: "pending", source_messages: [{ id: sourceId }] } });
  expect(createdValue.proposal.source_messages[0]).not.toHaveProperty("content");

  const overview = await durable.fetch(new Request("https://room/coordination"));
  expect(await overview.json()).toMatchObject({ empty: false, pending_proposal_count: 1, published_request_count: 0, published_revision: 0 });
  const list = await durable.fetch(new Request("https://room/coordination/proposals?limit=20"));
  expect(await list.json()).toMatchObject({ has_more: false, next_after: 1, through: 1, proposals: [{ proposal_id: createdValue.proposal.proposal_id }] });

  const replay = await durable.fetch(json("/coordination/proposals", proposal("proposal-1", sourceId)));
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ replayed: true, coordination_cursor: 1, proposal: { proposal_id: createdValue.proposal.proposal_id } });
  const changed = await durable.fetch(json("/coordination/proposals", { ...proposal("proposal-1", sourceId), body: { ...proposal("proposal-1", sourceId).body, title: "Changed" } }));
  expect(changed.status).toBe(409);

  const wrongOwner = await durable.fetch(json("/coordination/publish?token=owner-token-wrong", { base_revision: 0, client_retry_id: "publish-1", owner_label: "owner", proposal_id: createdValue.proposal.proposal_id, revision: 1 }));
  expect(wrongOwner.status).toBe(404);
  const published = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "publish-1", owner_label: "owner", proposal_id: createdValue.proposal.proposal_id, revision: 1 }));
  expect(published.status).toBe(201);
  expect(await published.json()).toMatchObject({ published_revision: 1, replayed: false, request: { request_id: createdValue.proposal.request_id, status: "open" }, proposal: { status: "published" } });
  const after = await (await durable.fetch(new Request("https://room/read?after=0&limit=20"))).json() as typeof beforeValue;
  expect(after).toMatchObject({ latest_message: beforeValue.latest_message, coordination_cursor: 2, expires_at: beforeValue.expires_at });

  const publishReplay = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "publish-1", owner_label: "owner", proposal_id: createdValue.proposal.proposal_id, revision: 1 }));
  expect(publishReplay.status).toBe(200);
  expect(await publishReplay.json()).toMatchObject({ replayed: true, published_revision: 1 });
  const rejectedReplay = await durable.fetch(json("/coordination/publish?token=owner-token-wrong", { base_revision: 0, client_retry_id: "publish-1", owner_label: "owner", proposal_id: createdValue.proposal.proposal_id, revision: 1 }));
  expect(rejectedReplay.status).toBe(404);

});

test("routes public proposal and private publication through Worker, service, and the room", async () => {
  const { room: durable } = await room();
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
  const sourceId = (await initialized.json() as { id: string }).id;
  const service = new DurableRoomService({ getByName: () => ({ fetch: (request: Request) => durable.fetch(request) }) }, "https://msg.0000.chat");
  const worker = createWorker(service);

  const proposalResponse = await worker.fetch(json("/room/coordination/proposals", proposal("worker-proposal", sourceId)));
  expect(proposalResponse.status).toBe(201);
  const proposalValue = await proposalResponse.json() as { proposal: { proposal_id: string; revision: number }; proposal?: { source_messages?: readonly { content?: string }[] } };
  expect(proposalValue.proposal?.source_messages?.[0]).not.toHaveProperty("content");
  const publicationResponse = await worker.fetch(json("/manage/room/owner-token/coordination/publish", { base_revision: 0, client_retry_id: "worker-publication", owner_label: "owner", proposal_id: proposalValue.proposal.proposal_id, revision: proposalValue.proposal.revision }));
  expect(publicationResponse.status).toBe(201);
  expect(await publicationResponse.json()).toMatchObject({ request: { status: "open" }, proposal: { status: "published" } });
});

test("routes progress publication and filters through Worker without changing chat state", async () => {
  const { room: durable } = await room();
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
  const sourceId = (await initialized.json() as { id: string }).id;
  const service = new DurableRoomService({ getByName: () => ({ fetch: (request: Request) => durable.fetch(request) }) }, "https://msg.0000.chat");
  const worker = createWorker(service);

  const created = await worker.fetch(json("/room/coordination/proposals", proposal("worker-progress-create", sourceId)));
  const createdValue = await created.json() as { proposal: { proposal_id: string; request_id: string; revision: number } };
  expect((await worker.fetch(json("/manage/room/owner-token/coordination/publish", { base_revision: 0, client_retry_id: "worker-progress-create-publish", owner_label: "owner", proposal_id: createdValue.proposal.proposal_id, revision: createdValue.proposal.revision })))).toHaveProperty("status", 201);
  const before = await (await durable.fetch(new Request("https://room/read?after=0&limit=20"))).json() as { latest_message: number; expires_at: string };

  const report = await worker.fetch(json("/room/coordination/proposals", progress("worker-progress-report", createdValue.proposal.request_id, "in_progress", 1, sourceId)));
  expect(report.status).toBe(201);
  const reportValue = await report.json() as { proposal: { proposal_id: string; revision: number; status: string } };
  expect(reportValue.proposal).toMatchObject({ revision: 1, status: "pending" });
  const pendingFilter = await worker.fetch(new Request("https://msg.0000.chat/room/coordination/requests?owner_label=owner-a&status=in_progress&limit=20"));
  expect(await pendingFilter.json()).toMatchObject({ requests: [], owner_label: "owner-a", status: "in_progress" });

  const published = await worker.fetch(json("/manage/room/owner-token/coordination/publish", { base_revision: 1, client_retry_id: "worker-progress-publish", owner_label: "owner", proposal_id: reportValue.proposal.proposal_id, revision: reportValue.proposal.revision }));
  expect(published.status).toBe(201);
  expect(await published.json()).toMatchObject({ request: { request_id: createdValue.proposal.request_id, body: { owner_label: "owner-a" }, status: "in_progress", progress: { reported_by: "reporter-a", authority_class: "management" } }, proposal: { status: "published" } });
  const filtered = await worker.fetch(new Request("https://msg.0000.chat/room/coordination/requests?owner_label=owner-a&status=in_progress&limit=20"));
  expect(await filtered.json()).toMatchObject({ requests: [{ request_id: createdValue.proposal.request_id, status: "in_progress" }], owner_label: "owner-a", status: "in_progress" });
  const after = await (await durable.fetch(new Request("https://room/read?after=0&limit=20"))).json() as typeof before;
  expect(after).toMatchObject({ latest_message: before.latest_message, expires_at: before.expires_at });
});

test("rejects foreign sources and reports stale publication without consuming retry IDs", async () => {
  const { room: durable } = await room();
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
  const sourceId = (await initialized.json() as { id: string }).id;
  const missing = await durable.fetch(json("/coordination/proposals", proposal("missing", "foreign-source")));
  expect(missing.status).toBe(404);
  const first = await durable.fetch(json("/coordination/proposals", proposal("one", sourceId)));
  const firstValue = await first.json() as { proposal: { proposal_id: string } };
  const second = await durable.fetch(json("/coordination/proposals", proposal("two", sourceId)));
  const secondValue = await second.json() as { proposal: { proposal_id: string } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "publish-one", owner_label: "owner", proposal_id: firstValue.proposal.proposal_id, revision: 1 }))).status).toBe(201);
  const stale = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "publish-two", owner_label: "owner", proposal_id: secondValue.proposal.proposal_id, revision: 1 }));
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: "stale_revision", current_revision: 1, submitted_base_revision: 0 } });
  const rebased = await durable.fetch(json(`/coordination/proposals/${secondValue.proposal.proposal_id}/revisions`, proposal("two-rebased", sourceId, 1, "Rebased")));
  expect(rebased.status).toBe(201);
  const rebasedValue = await rebased.json() as { proposal: { revision: number } };
  const staleRevision = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 1, client_retry_id: "publish-old", owner_label: "owner", proposal_id: secondValue.proposal.proposal_id, revision: 1 }));
  expect(staleRevision.status).toBe(409);
  const publishRebased = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 1, client_retry_id: "publish-rebased", owner_label: "owner", proposal_id: secondValue.proposal.proposal_id, revision: rebasedValue.proposal.revision }));
  expect(publishRebased.status).toBe(201);
});

test("freezes proposal revision and status at the requested coordination cursor", async () => {
  const { room: durable } = await room();
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
  const sourceId = (await initialized.json() as { id: string }).id;
  const first = await durable.fetch(json("/coordination/proposals", proposal("first", sourceId)));
  const firstValue = await first.json() as { proposal: { proposal_id: string; revision: number } };
  const revised = await durable.fetch(json(`/coordination/proposals/${firstValue.proposal.proposal_id}/revisions`, proposal("second", sourceId, 0, "Revised")));
  expect(revised.status).toBe(201);
  const revisedValue = await revised.json() as { proposal: { revision: number } };

  const live = await durable.fetch(new Request("https://room/coordination/proposals?limit=20"));
  expect(await live.json()).toMatchObject({ through: 2, proposals: [{ revision: revisedValue.proposal.revision, status: "pending" }] });
  const frozen = await durable.fetch(new Request("https://room/coordination/proposals?limit=20&through=1"));
  expect(await frozen.json()).toMatchObject({ through: 1, proposals: [{ revision: firstValue.proposal.revision, status: "pending" }] });

  const oldDetail = await durable.fetch(new Request(`https://room/coordination/proposals/${firstValue.proposal.proposal_id}/revisions/1`));
  expect(await oldDetail.json()).toMatchObject({ proposal: { revision: 1, status: "superseded" } });
  const oldPublication = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "publish-old", owner_label: "owner", proposal_id: firstValue.proposal.proposal_id, revision: 1 }));
  expect(oldPublication.status).toBe(409);
  const publication = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "publish-new", owner_label: "owner", proposal_id: firstValue.proposal.proposal_id, revision: revisedValue.proposal.revision }));
  expect(publication.status).toBe(201);
});

test("keeps reported progress pending, publishes evidence, filters canonical status, and pages event history", async () => {
  const { room: durable } = await room();
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
  const sourceId = (await initialized.json() as { id: string }).id;
  const created = await durable.fetch(json("/coordination/proposals", proposal("create-progress", sourceId)));
  const createdValue = await created.json() as { proposal: { proposal_id: string; request_id: string; revision: number } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "publish-create-progress", owner_label: "owner", proposal_id: createdValue.proposal.proposal_id, revision: 1 }))).status).toBe(201);

  const report = await durable.fetch(json("/coordination/proposals", progress("report-done", createdValue.proposal.request_id, "done", 1, sourceId)));
  expect(report.status).toBe(201);
  const reportValue = await report.json() as { proposal: { proposal_id: string; revision: number; status: string; body: Record<string, unknown> } };
  expect(reportValue.proposal).toMatchObject({ revision: 1, status: "pending", body: { request_id: createdValue.proposal.request_id, status: "done" } });
  expect(await (await durable.fetch(new Request("https://room/coordination"))).json()).toMatchObject({ pending_proposal_count: 1, published_request_count: 1 });
  expect((await durable.fetch(new Request("https://room/coordination/requests?status=done&limit=20"))).json()).resolves.toMatchObject({ requests: [] });

  const publication = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 1, client_retry_id: "publish-done", owner_label: "owner", proposal_id: reportValue.proposal.proposal_id, revision: 1 }));
  expect(publication.status).toBe(201);
  const publicationValue = await publication.json() as { request: { status: string; evidence: readonly { artifact_url: string; reported_by: string }[]; progress?: { reported_by: string; authority_class: string } } };
  expect(publicationValue.request).toMatchObject({ status: "done", evidence: [{ artifact_url: "https://example.com/report", reported_by: "reporter-a" }], progress: { reported_by: "reporter-a", authority_class: "management" } });
  const filtered = await durable.fetch(new Request("https://room/coordination/requests?owner_label=owner-a&status=done&limit=20"));
  expect(await filtered.json()).toMatchObject({ requests: [{ request_id: createdValue.proposal.request_id, status: "done" }], status: "done", owner_label: "owner-a" });

  const blockedReport = await durable.fetch(json("/coordination/proposals", progress("report-blocked", createdValue.proposal.request_id, "blocked", 2, sourceId, { reopen_reason: "A remaining blocker needs owner attention." })));
  const blockedValue = await blockedReport.json() as { proposal: { proposal_id: string; revision: number } };
  const blockedPublication = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 2, client_retry_id: "publish-blocked", owner_label: "owner", proposal_id: blockedValue.proposal.proposal_id, revision: 1 }));
  expect(blockedPublication.status).toBe(201);
  const detail = await durable.fetch(new Request(`https://room/coordination/requests/${createdValue.proposal.request_id}?after=0&through=6&limit=20`));
  expect(await detail.json()).toMatchObject({ history_after: 0, revisions: [{ kind: "request.create" }, { kind: "request.progress" }, { kind: "request.progress" }] });
});

test("keeps a captured request page stable when a later report updates an undelivered row", async () => {
  const { room: durable } = await room();
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
  const sourceId = (await initialized.json() as { id: string }).id;
  const first = await durable.fetch(json("/coordination/proposals", proposal("page-first", sourceId, 0, "First request")));
  const firstValue = await first.json() as { proposal: { proposal_id: string; request_id: string } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "page-first-publish", owner_label: "owner", proposal_id: firstValue.proposal.proposal_id, revision: 1 }))).status).toBe(201);
  const second = await durable.fetch(json("/coordination/proposals", proposal("page-second", sourceId, 1, "Second request")));
  const secondValue = await second.json() as { proposal: { proposal_id: string; request_id: string } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 1, client_retry_id: "page-second-publish", owner_label: "owner", proposal_id: secondValue.proposal.proposal_id, revision: 1 }))).status).toBe(201);

  const pageOne = await durable.fetch(new Request("https://room/coordination/requests?owner_label=owner-a&status=open&limit=1"));
  const pageOneValue = await pageOne.json() as { through: number; next_after: number; has_more: boolean; requests: readonly { request_id: string; status: string }[] };
  expect(pageOneValue).toMatchObject({ through: 2, next_after: 1, has_more: true, requests: [{ request_id: firstValue.proposal.request_id, status: "open" }] });

  const competing = await durable.fetch(json("/coordination/proposals", progress("page-second-blocked", secondValue.proposal.request_id, "blocked", 2, sourceId)));
  const competingValue = await competing.json() as { proposal: { proposal_id: string; revision: number } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 2, client_retry_id: "page-second-blocked-publish", owner_label: "owner", proposal_id: competingValue.proposal.proposal_id, revision: 1 }))).status).toBe(201);

  const pageTwo = await durable.fetch(new Request(`https://room/coordination/requests?owner_label=owner-a&status=open&after=${pageOneValue.next_after}&through=${pageOneValue.through}&limit=1`));
  const pageTwoValue = await pageTwo.json() as { requests: readonly { request_id: string; status: string }[]; has_more: boolean; next_after: number; through: number };
  expect(pageTwoValue).toMatchObject({ through: 2, has_more: false, next_after: 2, requests: [{ request_id: secondValue.proposal.request_id, status: "open" }] });
  expect(pageTwoValue.requests.filter((request) => request.request_id === secondValue.proposal.request_id)).toHaveLength(1);
});

test("rejects done reports without evidence and requires a reason to reopen", async () => {
  const { room: durable } = await room();
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
  const sourceId = (await initialized.json() as { id: string }).id;
  const created = await durable.fetch(json("/coordination/proposals", proposal("create-reopen", sourceId)));
  const createdValue = await created.json() as { proposal: { proposal_id: string; request_id: string } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "publish-reopen-create", owner_label: "owner", proposal_id: createdValue.proposal.proposal_id, revision: 1 }))).status).toBe(201);
  const invalid = await durable.fetch(json("/coordination/proposals", { ...progress("invalid-done", createdValue.proposal.request_id, "done", 1, sourceId), body: { blockers: [], evidence: [], request_id: createdValue.proposal.request_id, status: "done" } }));
  expect(invalid.status).toBe(400);
  const done = await durable.fetch(json("/coordination/proposals", progress("done-for-reopen", createdValue.proposal.request_id, "done", 1, sourceId, { evidence: [], unverified_explanation: "Reported complete; external artifact was not independently verified." })));
  const doneValue = await done.json() as { proposal: { proposal_id: string } };
  const donePublication = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 1, client_retry_id: "publish-done-reopen", owner_label: "owner", proposal_id: doneValue.proposal.proposal_id, revision: 1 }));
  expect(donePublication.status).toBe(201);
  expect(await donePublication.json()).toMatchObject({ request: { status: "done", evidence: [], progress: { unverified_explanation: "Reported complete; external artifact was not independently verified." } } });
  const reopen = await durable.fetch(json("/coordination/proposals", progress("reopen-missing", createdValue.proposal.request_id, "open", 2, sourceId)));
  const reopenValue = await reopen.json() as { proposal: { proposal_id: string } };
  const missingReason = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 2, client_retry_id: "publish-reopen-missing", owner_label: "owner", proposal_id: reopenValue.proposal.proposal_id, revision: 1 }));
  expect(missingReason.status).toBe(409);
  const revised = await durable.fetch(json(`/coordination/proposals/${reopenValue.proposal.proposal_id}/revisions`, progress("reopen-with-reason", createdValue.proposal.request_id, "open", 2, sourceId, { reopen_reason: "New source evidence requires follow-up." })));
  const revisedValue = await revised.json() as { proposal: { proposal_id: string; revision: number } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 2, client_retry_id: "publish-reopen-with-reason", owner_label: "owner", proposal_id: revisedValue.proposal.proposal_id, revision: revisedValue.proposal.revision }))).status).toBe(201);

  const withdrawn = await durable.fetch(json("/coordination/proposals", progress("withdraw-after-reopen", createdValue.proposal.request_id, "withdrawn", 3, sourceId)));
  const withdrawnValue = await withdrawn.json() as { proposal: { proposal_id: string } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 3, client_retry_id: "publish-withdrawn", owner_label: "owner", proposal_id: withdrawnValue.proposal.proposal_id, revision: 1 }))).status).toBe(201);
  const reopenWithdrawn = await durable.fetch(json("/coordination/proposals", progress("reopen-withdrawn-missing", createdValue.proposal.request_id, "in_progress", 4, sourceId)));
  const reopenWithdrawnValue = await reopenWithdrawn.json() as { proposal: { proposal_id: string } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 4, client_retry_id: "publish-reopen-withdrawn-missing", owner_label: "owner", proposal_id: reopenWithdrawnValue.proposal.proposal_id, revision: 1 }))).status).toBe(409);
  const reopenWithdrawnRevision = await durable.fetch(json(`/coordination/proposals/${reopenWithdrawnValue.proposal.proposal_id}/revisions`, progress("reopen-withdrawn-reason", createdValue.proposal.request_id, "in_progress", 4, sourceId, { reopen_reason: "The withdrawn work is active again after a new owner request." })));
  const reopenWithdrawnRevisionValue = await reopenWithdrawnRevision.json() as { proposal: { proposal_id: string; revision: number } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 4, client_retry_id: "publish-reopen-withdrawn-reason", owner_label: "owner", proposal_id: reopenWithdrawnRevisionValue.proposal.proposal_id, revision: reopenWithdrawnRevisionValue.proposal.revision }))).status).toBe(201);
});

test("requires an explicit progress rebase after a competing report is published", async () => {
  const { room: durable } = await room();
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
  const sourceId = (await initialized.json() as { id: string }).id;
  const created = await durable.fetch(json("/coordination/proposals", proposal("stale-progress-create", sourceId)));
  const createdValue = await created.json() as { proposal: { proposal_id: string; request_id: string } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "stale-progress-create-publish", owner_label: "owner", proposal_id: createdValue.proposal.proposal_id, revision: 1 }))).status).toBe(201);
  const first = await durable.fetch(json("/coordination/proposals", progress("stale-progress-first", createdValue.proposal.request_id, "in_progress", 1, sourceId)));
  const firstValue = await first.json() as { proposal: { proposal_id: string; revision: number } };
  const second = await durable.fetch(json("/coordination/proposals", progress("stale-progress-second", createdValue.proposal.request_id, "blocked", 1, sourceId)));
  const secondValue = await second.json() as { proposal: { proposal_id: string; revision: number } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 1, client_retry_id: "stale-progress-first-publish", owner_label: "owner", proposal_id: firstValue.proposal.proposal_id, revision: firstValue.proposal.revision }))).status).toBe(201);
  const stale = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 1, client_retry_id: "stale-progress-second-publish", owner_label: "owner", proposal_id: secondValue.proposal.proposal_id, revision: secondValue.proposal.revision }));
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: "stale_revision", current_revision: 2 } });
  const rebased = await durable.fetch(json(`/coordination/proposals/${secondValue.proposal.proposal_id}/revisions`, progress("stale-progress-rebased", createdValue.proposal.request_id, "blocked", 2, sourceId, { reopen_reason: "The competing progress report left this blocker unresolved." })));
  const rebasedValue = await rebased.json() as { proposal: { proposal_id: string; revision: number } };
  expect(rebased.status).toBe(201);
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 2, client_retry_id: "stale-progress-rebased-publish", owner_label: "owner", proposal_id: rebasedValue.proposal.proposal_id, revision: rebasedValue.proposal.revision }))).status).toBe(201);
});

test("publishes recommendation then exact-revision acceptance with distinct evidence and immutable record", async () => {
  const { room: durable } = await room();
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "I approve the exact proposal revision.", author: "alice", display_name: "Alice", semantic_type: "message" } }));
  const aliceMessageId = (await initialized.json() as { id: string }).id;
  const bobResponse = await durable.fetch(json("/messages", { input: { content: "I approve this exact proposal revision too.", author: "bob", display_name: "Bob", semantic_type: "message" } }));
  const bobMessageId = (await bobResponse.json() as { message: { id: string } }).message.id;
  const decisionResponse = await durable.fetch(json("/coordination/proposals", decisionProposal("decision-proposal", aliceMessageId)));
  const decision = await decisionResponse.json() as { proposal: { proposal_id: string; revision: number }; coordination_cursor: number };
  expect(decisionResponse.status).toBe(201);
  const recommendation = await durable.fetch(json("/coordination/publish?token=owner-token", {
    base_revision: 0,
    client_retry_id: "decision-recommendation",
    decision_publication: { mode: "recommendation" },
    owner_label: "room-owner",
    proposal_id: decision.proposal.proposal_id,
    revision: decision.proposal.revision,
  }));
  expect(recommendation.status).toBe(201);
  expect(await recommendation.json()).toMatchObject({ decision: { state: "recommended", decision_id: decision.proposal.proposal_id }, proposal: { status: "published" } });

  const unrelated = await durable.fetch(json("/coordination/proposals", proposal("unrelated-request", aliceMessageId, 1, "Unrelated request")));
  const unrelatedValue = await unrelated.json() as { proposal: { proposal_id: string; revision: number } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 1, client_retry_id: "unrelated-publish", owner_label: "room-owner", proposal_id: unrelatedValue.proposal.proposal_id, revision: 1 }))).status).toBe(201);
  const before = await (await durable.fetch(new Request("https://room/read?after=0&limit=20"))).json() as { latest_message: number; coordination_cursor: number; published_revision: number };

  const acceptanceInput = {
    base_revision: 2,
    client_retry_id: "decision-acceptance",
    decision_publication: { approvals: [{ participant_label: "alice", source_message_id: aliceMessageId }, { participant_label: "bob", source_message_id: bobMessageId }], mode: "acceptance", owner_attestation: true },
    owner_label: "room-owner",
    proposal_id: decision.proposal.proposal_id,
    revision: decision.proposal.revision,
  };
  const acceptance = await durable.fetch(json("/coordination/publish?token=owner-token", acceptanceInput));
  expect(acceptance.status).toBe(201);
  const accepted = await acceptance.json() as { accepted_record: { accepted_record_id: string; owner_attestation: true; decision_revision: number }; approvals: readonly { participant_label: string; source_message_id: string; source_message?: { content: string } }[]; decision: { state: string }; published_revision: number };
  expect(accepted).toMatchObject({ decision: { state: "accepted" }, accepted_record: { decision_revision: 1, owner_attestation: true }, approvals: [{ participant_label: "alice" }, { participant_label: "bob" }] });
  expect(accepted.approvals[0]?.source_message).toBeUndefined();
  const after = await (await durable.fetch(new Request("https://room/read?after=0&limit=20"))).json() as typeof before;
  expect(after.latest_message).toBe(before.latest_message);
  expect(after.published_revision).toBe(before.published_revision + 1);
  expect(after.coordination_cursor).toBeGreaterThan(before.coordination_cursor);

  const record = await durable.fetch(new Request(`https://room/coordination/decisions/${decision.proposal.proposal_id}/records/${accepted.accepted_record.accepted_record_id}`));
  expect(record.status).toBe(200);
  expect(await record.json()).toMatchObject({ accepted_record: { accepted_record_id: accepted.accepted_record.accepted_record_id }, approvals: [{ approval_record_id: expect.any(String), accepted_record_id: accepted.accepted_record.accepted_record_id, decision_id: decision.proposal.proposal_id, decision_revision: 1, source_message_id: aliceMessageId, source_author: "alice", citation_url: `/messages/${aliceMessageId}` }, { approval_record_id: expect.any(String), accepted_record_id: accepted.accepted_record.accepted_record_id, decision_id: decision.proposal.proposal_id, decision_revision: 1, source_message_id: bobMessageId, source_author: "bob", citation_url: `/messages/${bobMessageId}` }] });
  expect((await (await durable.fetch(new Request(`https://room/messages/${aliceMessageId}`))).json()) as { message: { content: string } }).toMatchObject({ message: { content: "I approve the exact proposal revision." } });
  expect((await (await durable.fetch(new Request(`https://room/messages/${bobMessageId}`))).json()) as { message: { content: string } }).toMatchObject({ message: { content: "I approve this exact proposal revision too." } });
  const currentList = await durable.fetch(new Request("https://room/coordination/decisions?limit=20"));
  expect(await currentList.json()).toMatchObject({ decisions: [{ decision_id: decision.proposal.proposal_id, state: "accepted" }] });
  const frozenList = await durable.fetch(new Request("https://room/coordination/decisions?limit=20&through=2"));
  expect(await frozenList.json()).toMatchObject({ through: 2, decisions: [{ decision_id: decision.proposal.proposal_id, state: "recommended" }] });

  const replay = await durable.fetch(json("/coordination/publish?token=owner-token", acceptanceInput));
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ replayed: true, accepted_record: { accepted_record_id: accepted.accepted_record.accepted_record_id } });
  const changedRetry = await durable.fetch(json("/coordination/publish?token=owner-token", { ...acceptanceInput, decision_publication: { ...acceptanceInput.decision_publication, owner_attestation: true, approvals: [{ participant_label: "alice", source_message_id: aliceMessageId }, { participant_label: "bob", source_message_id: bobMessageId }] }, owner_label: "changed-owner" }));
  expect(changedRetry.status).toBe(409);
  const wrongAuthReplay = await durable.fetch(json("/coordination/publish?token=wrong-token", acceptanceInput));
  expect(wrongAuthReplay.status).toBe(404);
});

test("replaces an unaccepted recommendation when its latest proposal revision is published", async () => {
  const { room: durable, database } = await room();
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "I approve the revised proposal.", author: "alice", display_name: "Alice", semantic_type: "message" } }));
  const aliceMessageId = (await initialized.json() as { id: string }).id;
  const bobResponse = await durable.fetch(json("/messages", { input: { content: "I approve the revised proposal too.", author: "bob", display_name: "Bob", semantic_type: "message" } }));
  const bobMessageId = (await bobResponse.json() as { message: { id: string } }).message.id;

  const firstProposal = decisionProposal("recommendation-revision-v1", aliceMessageId, 0, "Choose the original recommendation after reviewing the complete evidence set");
  firstProposal.body.proposal_text = "Ship the reviewed release after the complete evidence report and all supporting checks have been carefully validated.";
  const created = await durable.fetch(json("/coordination/proposals", firstProposal));
  const decision = await created.json() as { proposal: { proposal_id: string; revision: number } };
  expect(created.status).toBe(201);
  expect(decision.proposal.revision).toBe(1);

  const firstRecommendationInput = {
    base_revision: 0,
    client_retry_id: "recommendation-publish-v1",
    decision_publication: { mode: "recommendation" },
    owner_label: "room-owner",
    proposal_id: decision.proposal.proposal_id,
    revision: decision.proposal.revision,
  };
  const firstRecommendation = await durable.fetch(json("/coordination/publish?token=owner-token", firstRecommendationInput));
  const firstRecommendationValue = await firstRecommendation.json() as { coordination_cursor: number; published_revision: number };
  expect(firstRecommendation.status).toBe(201);
  expect(firstRecommendationValue.published_revision).toBe(1);
  const firstProjection = database.query("SELECT byte_count FROM coordination_decisions WHERE decision_id = ?").get(decision.proposal.proposal_id) as { byte_count: number };

  const secondProposal = decisionProposal("recommendation-revision-v2", aliceMessageId, 1, "V2");
  secondProposal.body.proposal_text = "Ship v2.";
  const revised = await durable.fetch(json(`/coordination/proposals/${decision.proposal.proposal_id}/revisions`, secondProposal));
  const revisedValue = await revised.json() as { proposal: { proposal_id: string; revision: number } };
  expect(revised.status).toBe(201);
  expect(revisedValue.proposal).toMatchObject({ proposal_id: decision.proposal.proposal_id, revision: 2 });

  const beforeSecondRecommendation = database.query("SELECT total_bytes FROM room_state WHERE singleton = 1").get() as { total_bytes: number };
  const secondRecommendationInput = {
    base_revision: 1,
    client_retry_id: "recommendation-publish-v2",
    decision_publication: { mode: "recommendation" },
    owner_label: "room-owner",
    proposal_id: decision.proposal.proposal_id,
    revision: revisedValue.proposal.revision,
  };
  const secondRecommendation = await durable.fetch(json("/coordination/publish?token=owner-token", secondRecommendationInput));
  expect(secondRecommendation.status).toBe(201);
  expect(await secondRecommendation.json()).toMatchObject({ decision: { state: "recommended", latest_proposal_revision: 2, title: "V2" }, published_revision: 2 });
  const secondProjection = database.query("SELECT byte_count FROM coordination_decisions WHERE decision_id = ?").get(decision.proposal.proposal_id) as { byte_count: number };
  const secondEvent = database.query("SELECT byte_count FROM coordination_events WHERE operation = 'decision.recommended' AND proposal_id = ? AND proposal_revision = 2").get(decision.proposal.proposal_id) as { byte_count: number };
  const secondRetry = database.query("SELECT byte_count FROM coordination_retries WHERE operation = 'publication' AND retry_id = ?").get(secondRecommendationInput.client_retry_id) as { byte_count: number };
  const afterSecondRecommendation = database.query("SELECT total_bytes FROM room_state WHERE singleton = 1").get() as { total_bytes: number };
  const projectionDelta = secondProjection.byte_count - firstProjection.byte_count;
  expect(projectionDelta).toBeLessThan(0);
  expect(afterSecondRecommendation.total_bytes - beforeSecondRecommendation.total_bytes).toBe(projectionDelta + secondEvent.byte_count + secondRetry.byte_count);

  const current = await durable.fetch(new Request(`https://room/coordination/decisions/${decision.proposal.proposal_id}`));
  expect(await current.json()).toMatchObject({ decision: { state: "recommended", latest_proposal_revision: 2, title: "V2" }, history: [{ operation: "decision.recommended", proposal_revision: 1 }, { operation: "decision.recommended", proposal_revision: 2 }] });
  const asOfFirstRecommendation = await durable.fetch(new Request(`https://room/coordination/decisions/${decision.proposal.proposal_id}?through=${firstRecommendationValue.coordination_cursor}`));
  expect(await asOfFirstRecommendation.json()).toMatchObject({ decision: { state: "recommended", latest_proposal_revision: 1, title: "Choose the original recommendation after reviewing the complete evidence set" }, history: [{ operation: "decision.recommended", proposal_revision: 1 }] });

  const oldRevisionRepublish = await durable.fetch(json("/coordination/publish?token=owner-token", { ...firstRecommendationInput, base_revision: 2, client_retry_id: "recommendation-republish-v1" }));
  expect(oldRevisionRepublish.status).toBe(409);
  expect(await oldRevisionRepublish.json()).toMatchObject({ error: { code: "conflict" } });

  const beforeFirstReplay = database.query("SELECT coordination_cursor, published_revision, total_bytes FROM room_state WHERE singleton = 1").get();
  const firstReplay = await durable.fetch(json("/coordination/publish?token=owner-token", firstRecommendationInput));
  expect(firstReplay.status).toBe(200);
  expect(await firstReplay.json()).toMatchObject({ replayed: true, decision: { latest_proposal_revision: 1, title: "Choose the original recommendation after reviewing the complete evidence set" } });
  expect(database.query("SELECT coordination_cursor, published_revision, total_bytes FROM room_state WHERE singleton = 1").get()).toEqual(beforeFirstReplay);

  const acceptance = await durable.fetch(json("/coordination/publish?token=owner-token", {
    base_revision: 2,
    client_retry_id: "recommendation-acceptance-v2",
    decision_publication: { approvals: [{ participant_label: "alice", source_message_id: aliceMessageId }, { participant_label: "bob", source_message_id: bobMessageId }], mode: "acceptance", owner_attestation: true },
    owner_label: "room-owner",
    proposal_id: decision.proposal.proposal_id,
    revision: revisedValue.proposal.revision,
  }));
  expect(acceptance.status).toBe(201);
  const accepted = await acceptance.json() as { accepted_record: { decision_revision: number }; approvals: readonly { decision_revision: number }[]; decision: { latest_proposal_revision: number; state: string } };
  expect(accepted).toMatchObject({ accepted_record: { decision_revision: 2 }, approvals: [{ decision_revision: 2 }, { decision_revision: 2 }], decision: { latest_proposal_revision: 2, state: "accepted" } });

  const beforeSecondReplay = database.query("SELECT coordination_cursor, published_revision, total_bytes FROM room_state WHERE singleton = 1").get();
  const secondReplay = await durable.fetch(json("/coordination/publish?token=owner-token", secondRecommendationInput));
  expect(secondReplay.status).toBe(200);
  expect(await secondReplay.json()).toMatchObject({ replayed: true, decision: { latest_proposal_revision: 2, title: "V2" } });
  expect(database.query("SELECT coordination_cursor, published_revision, total_bytes FROM room_state WHERE singleton = 1").get()).toEqual(beforeSecondReplay);

  const afterAcceptanceRevision = await durable.fetch(json(`/coordination/proposals/${decision.proposal.proposal_id}/revisions`, decisionProposal("recommendation-revision-after-acceptance", aliceMessageId, 2, "Should not revise")));
  expect(afterAcceptanceRevision.status).toBe(409);
  expect(await afterAcceptanceRevision.json()).toMatchObject({ error: { code: "conflict" } });
});

test("rejects insufficient or misattributed acceptance evidence and preserves reported positions separately", async () => {
  const { room: durable } = await room();
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "Owner source", author: "owner", display_name: "Owner", semantic_type: "message" } }));
  const ownerSource = (await initialized.json() as { id: string }).id;
  const alice = await durable.fetch(json("/messages", { input: { content: "Alice position", author: "alice", display_name: "Alice", semantic_type: "message" } }));
  const aliceSource = (await alice.json() as { message: { id: string } }).message.id;
  const bob = await durable.fetch(json("/messages", { input: { content: "Bob position", author: "bob", display_name: "Bob", semantic_type: "message" } }));
  const bobSource = (await bob.json() as { message: { id: string } }).message.id;
  const created = await durable.fetch(json("/coordination/proposals", decisionProposal("insufficient-decision", ownerSource)));
  const value = await created.json() as { proposal: { proposal_id: string; revision: number } };
  const missingAttestation = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "missing-attestation", decision_publication: { approvals: [{ participant_label: "alice", source_message_id: aliceSource }, { participant_label: "bob", source_message_id: bobSource }], mode: "acceptance" }, owner_label: "owner", proposal_id: value.proposal.proposal_id, revision: 1 }));
  expect(missingAttestation.status).toBe(400);
  const incomplete = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "incomplete-approval", decision_publication: { approvals: [{ participant_label: "alice", source_message_id: aliceSource }], mode: "acceptance", owner_attestation: true }, owner_label: "owner", proposal_id: value.proposal.proposal_id, revision: 1 }));
  expect(incomplete.status).toBe(409);
  const wrongAuthor = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "wrong-author", decision_publication: { approvals: [{ participant_label: "alice", source_message_id: bobSource }, { participant_label: "bob", source_message_id: aliceSource }], mode: "acceptance", owner_attestation: true }, owner_label: "owner", proposal_id: value.proposal.proposal_id, revision: 1 }));
  expect(wrongAuthor.status).toBe(409);
  const foreign = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "foreign-evidence", decision_publication: { approvals: [{ participant_label: "alice", source_message_id: "foreign" }, { participant_label: "bob", source_message_id: bobSource }], mode: "acceptance", owner_attestation: true }, owner_label: "owner", proposal_id: value.proposal.proposal_id, revision: 1 }));
  expect(foreign.status).toBe(404);

  const recommendation = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "position-decision-recommendation", decision_publication: { mode: "recommendation" }, owner_label: "owner", proposal_id: value.proposal.proposal_id, revision: value.proposal.revision }));
  expect(recommendation.status).toBe(201);
  const position = await durable.fetch(json("/coordination/proposals", { ...decisionPosition("position-report", value.proposal.proposal_id, 1, ownerSource), base_revision: 1 }));
  const positionValue = await position.json() as { proposal: { proposal_id: string; revision: number } };
  const publishedPosition = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 1, client_retry_id: "position-publish", owner_label: "owner", proposal_id: positionValue.proposal.proposal_id, revision: positionValue.proposal.revision }));
  expect(publishedPosition.status).toBe(201);
  expect(await publishedPosition.json()).toMatchObject({ position: { participant_label: "carol", reporter_label: "position-reporter" } });
  const detail = await durable.fetch(new Request(`https://room/coordination/decisions/${value.proposal.proposal_id}`));
  expect(await detail.json()).toMatchObject({ decision: { state: "recommended" }, positions: [{ participant_label: "carol", statement: expect.stringContaining("not an acceptance") }] });
});

test("routes direct decision acceptance through the Worker service and rejects stale publication boundaries", async () => {
  const { room: durable } = await room();
  const service = new DurableRoomService({ getByName: () => ({ fetch: (request: Request) => durable.fetch(request) }) }, "https://msg.0000.chat");
  const worker = createWorker(service);
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "Owner source", author: "owner", display_name: "Owner", semantic_type: "message" } }));
  const ownerSource = (await initialized.json() as { id: string }).id;
  const alice = await durable.fetch(json("/messages", { input: { content: "I approve the direct proposal.", author: "alice", display_name: "Alice", semantic_type: "message" } }));
  const aliceSource = (await alice.json() as { message: { id: string } }).message.id;
  const bob = await durable.fetch(json("/messages", { input: { content: "I approve the same direct proposal.", author: "bob", display_name: "Bob", semantic_type: "message" } }));
  const bobSource = (await bob.json() as { message: { id: string } }).message.id;

  const created = await worker.fetch(workerJson("/room/coordination/proposals", decisionProposal("worker-direct-proposal", ownerSource)));
  expect(created.status).toBe(201);
  const createdValue = await created.json() as { proposal: { proposal_id: string; revision: number } };
  const accepted = await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", {
    base_revision: 0,
    client_retry_id: "worker-direct-acceptance",
    decision_publication: { approvals: [{ participant_label: "alice", source_message_id: aliceSource }, { participant_label: "bob", source_message_id: bobSource }], mode: "acceptance", owner_attestation: true },
    owner_label: "room-owner",
    proposal_id: createdValue.proposal.proposal_id,
    revision: createdValue.proposal.revision,
  }));
  expect(accepted.status).toBe(201);
  const acceptedValue = await accepted.json() as { accepted_record: { accepted_record_id: string; decision_revision: number }; approvals: readonly { source_message?: unknown; citation_url: string }[]; decision: { state: string; detail_url: string } };
  expect(acceptedValue).toMatchObject({ accepted_record: { decision_revision: 1 }, decision: { state: "accepted", detail_url: "https://msg.0000.chat/room/coordination/decisions/" + createdValue.proposal.proposal_id }, approvals: [{ citation_url: "https://msg.0000.chat/room/messages/" + aliceSource }, { citation_url: "https://msg.0000.chat/room/messages/" + bobSource }] });
  expect(acceptedValue.approvals[0]?.source_message).toBeUndefined();

  const list = await worker.fetch(new Request("https://msg.0000.chat/room/coordination/decisions?limit=20"));
  expect(list.status).toBe(200);
  expect(await list.json()).toMatchObject({ decisions: [{ decision_id: createdValue.proposal.proposal_id, state: "accepted" }] });
  const detail = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/decisions/${createdValue.proposal.proposal_id}?limit=20`));
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({ decision: { state: "accepted" }, history: [{ operation: "decision.accepted" }] });
  const record = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/decisions/${createdValue.proposal.proposal_id}/records/${acceptedValue.accepted_record.accepted_record_id}`));
  expect(record.status).toBe(200);
  expect(await record.json()).toMatchObject({ accepted_record: { accepted_record_id: acceptedValue.accepted_record.accepted_record_id }, approvals: [{ source_message_id: aliceSource }, { source_message_id: bobSource }], decision_url: `https://msg.0000.chat/room/coordination/decisions/${createdValue.proposal.proposal_id}` });
  const source = await worker.fetch(new Request(`https://msg.0000.chat/room/messages/${aliceSource}`, { headers: { accept: "application/json" } }));
  expect(source.status).toBe(200);
  expect(await source.json()).toMatchObject({ message: { id: aliceSource, content: "I approve the direct proposal." } });

  const newer = await worker.fetch(workerJson("/room/coordination/proposals", decisionProposal("worker-stale-latest", ownerSource)));
  const newerValue = await newer.json() as { proposal: { proposal_id: string; revision: number } };
  const revised = await worker.fetch(workerJson(`/room/coordination/proposals/${newerValue.proposal.proposal_id}/revisions`, decisionProposal("worker-stale-revision", ownerSource, 0, "Changed direct proposal")));
  expect(revised.status).toBe(201);
  const oldRevisionPublish = await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: 1, client_retry_id: "worker-old-revision", decision_publication: { mode: "recommendation" }, owner_label: "room-owner", proposal_id: newerValue.proposal.proposal_id, revision: newerValue.proposal.revision }));
  expect(oldRevisionPublish.status).toBe(409);
  expect(await oldRevisionPublish.json()).toMatchObject({ error: { code: "conflict" } });
  const staleInput = await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: 0, client_retry_id: "worker-stale-input", decision_publication: { mode: "recommendation" }, owner_label: "room-owner", proposal_id: newerValue.proposal.proposal_id, revision: 2 }));
  expect(staleInput.status).toBe(409);
  expect(await staleInput.json()).toMatchObject({ error: { code: "stale_revision", current_revision: 1, submitted_base_revision: 0 } });
});

test("rejects a position whose stored base is older than the current publication", async () => {
  const { room: durable } = await room();
  const service = new DurableRoomService({ getByName: () => ({ fetch: (request: Request) => durable.fetch(request) }) }, "https://msg.0000.chat");
  const worker = createWorker(service);
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "Owner source", author: "owner", display_name: "Owner", semantic_type: "message" } }));
  const ownerSource = (await initialized.json() as { id: string }).id;
  const created = await worker.fetch(workerJson("/room/coordination/proposals", decisionProposal("stale-position-decision", ownerSource)));
  const decision = await created.json() as { proposal: { proposal_id: string; revision: number } };
  const recommendation = await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: 0, client_retry_id: "stale-position-recommendation", decision_publication: { mode: "recommendation" }, owner_label: "room-owner", proposal_id: decision.proposal.proposal_id, revision: decision.proposal.revision }));
  expect(recommendation.status).toBe(201);
  const position = await worker.fetch(workerJson("/room/coordination/proposals", { ...decisionPosition("stale-position", decision.proposal.proposal_id, 1, ownerSource), base_revision: 1 }));
  const positionValue = await position.json() as { proposal: { proposal_id: string; revision: number } };
  const unrelated = await worker.fetch(workerJson("/room/coordination/proposals", proposal("stale-position-unrelated", ownerSource, 1, "Unrelated publication")));
  const unrelatedValue = await unrelated.json() as { proposal: { proposal_id: string; revision: number } };
  const unrelatedPublication = await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: 1, client_retry_id: "stale-position-unrelated-publish", owner_label: "room-owner", proposal_id: unrelatedValue.proposal.proposal_id, revision: unrelatedValue.proposal.revision }));
  expect(unrelatedPublication.status).toBe(201);
  const stalePosition = await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: 2, client_retry_id: "stale-position-publish", owner_label: "room-owner", proposal_id: positionValue.proposal.proposal_id, revision: positionValue.proposal.revision }));
  expect(stalePosition.status).toBe(409);
  expect(await stalePosition.json()).toMatchObject({ error: { code: "stale_revision", current_revision: 2, submitted_base_revision: 1 } });
});

test("rejects a decision publication atomically when coordination rows exceed the room quota", async () => {
  const { room: durable } = await room({ MSG_TEST_ROOM_LIMITS: JSON.stringify({ maxRoomBytes: 5_000 }) });
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "Owner source", author: "owner", display_name: "Owner", semantic_type: "message" } }));
  const ownerSource = (await initialized.json() as { id: string }).id;
  const alice = await durable.fetch(json("/messages", { input: { content: "I approve the exact proposal.", author: "alice", display_name: "Alice", semantic_type: "message" } }));
  const aliceSource = (await alice.json() as { message: { id: string } }).message.id;
  const bob = await durable.fetch(json("/messages", { input: { content: "I approve the exact proposal too.", author: "bob", display_name: "Bob", semantic_type: "message" } }));
  const bobSource = (await bob.json() as { message: { id: string } }).message.id;
  const created = await durable.fetch(json("/coordination/proposals", decisionProposal("quota-decision", ownerSource)));
  expect(created.status).toBe(201);
  const decision = await created.json() as { proposal: { proposal_id: string; revision: number } };
  const before = await (await durable.fetch(new Request("https://room/read?after=0&limit=20"))).json() as { coordination_cursor: number; latest_message: number; published_revision: number };
  const input = { base_revision: 0, client_retry_id: "quota-acceptance", decision_publication: { approvals: [{ participant_label: "alice", source_message_id: aliceSource }, { participant_label: "bob", source_message_id: bobSource }], mode: "acceptance", owner_attestation: true }, owner_label: "room-owner", proposal_id: decision.proposal.proposal_id, revision: decision.proposal.revision };
  const rejected = await durable.fetch(json("/coordination/publish?token=owner-token", input));
  expect(rejected.status).toBe(429);
  expect(await rejected.json()).toMatchObject({ error: { code: "rate_limited" } });
  const after = await (await durable.fetch(new Request("https://room/read?after=0&limit=20"))).json() as typeof before;
  expect(after).toMatchObject(before);
  expect((await (await durable.fetch(new Request("https://room/coordination/decisions"))).json() as { decisions: readonly unknown[] }).decisions).toHaveLength(0);
  const retryRejected = await durable.fetch(json("/coordination/publish?token=owner-token", input));
  expect(retryRejected.status).toBe(429);
  expect((await (await durable.fetch(new Request("https://room/coordination/decisions"))).json() as { decisions: readonly unknown[] }).decisions).toHaveLength(0);
});

test("removes decision, approval, and position rows with the room lifecycle", async () => {
  const { room: durable, database } = await room();
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "Owner source", author: "owner", display_name: "Owner", semantic_type: "message" } }));
  const ownerSource = (await initialized.json() as { id: string }).id;
  const alice = await durable.fetch(json("/messages", { input: { content: "I approve the exact proposal.", author: "alice", display_name: "Alice", semantic_type: "message" } }));
  const aliceSource = (await alice.json() as { message: { id: string } }).message.id;
  const bob = await durable.fetch(json("/messages", { input: { content: "I approve the exact proposal too.", author: "bob", display_name: "Bob", semantic_type: "message" } }));
  const bobSource = (await bob.json() as { message: { id: string } }).message.id;
  const created = await durable.fetch(json("/coordination/proposals", decisionProposal("lifecycle-decision", ownerSource)));
  const decision = await created.json() as { proposal: { proposal_id: string; revision: number } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "lifecycle-recommendation", decision_publication: { mode: "recommendation" }, owner_label: "room-owner", proposal_id: decision.proposal.proposal_id, revision: decision.proposal.revision }))).status).toBe(201);
  const position = await durable.fetch(json("/coordination/proposals", { ...decisionPosition("lifecycle-position", decision.proposal.proposal_id, 1, ownerSource), base_revision: 1 }));
  const positionValue = await position.json() as { proposal: { proposal_id: string; revision: number } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 1, client_retry_id: "lifecycle-position-publish", owner_label: "room-owner", proposal_id: positionValue.proposal.proposal_id, revision: positionValue.proposal.revision }))).status).toBe(201);
  const accepted = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 2, client_retry_id: "lifecycle-acceptance", decision_publication: { approvals: [{ participant_label: "alice", source_message_id: aliceSource }, { participant_label: "bob", source_message_id: bobSource }], mode: "acceptance", owner_attestation: true }, owner_label: "room-owner", proposal_id: decision.proposal.proposal_id, revision: decision.proposal.revision }));
  expect(accepted.status).toBe(201);
  expect((database.query("SELECT COUNT(*) AS count FROM coordination_decision_approval_evidence").get() as { count: number }).count).toBe(2);
  expect((database.query("SELECT COUNT(*) AS count FROM coordination_decision_accepted_records").get() as { count: number }).count).toBe(1);
  expect((database.query("SELECT COUNT(*) AS count FROM coordination_decision_positions").get() as { count: number }).count).toBe(1);
  const deleted = await durable.fetch(new Request("https://room/manage?token=owner-token", { method: "DELETE" }));
  expect(deleted.status).toBe(200);
  expect((await durable.fetch(new Request("https://room/coordination/decisions"))).status).toBe(410);
  expect((database.query("SELECT COUNT(*) AS count FROM coordination_decision_approval_evidence").get() as { count: number }).count).toBe(0);
  expect((database.query("SELECT COUNT(*) AS count FROM coordination_decision_accepted_records").get() as { count: number }).count).toBe(0);
  expect((database.query("SELECT COUNT(*) AS count FROM coordination_decision_positions").get() as { count: number }).count).toBe(0);
  expect((database.query("SELECT COUNT(*) AS count FROM coordination_decisions").get() as { count: number }).count).toBe(0);
});

test("keeps decision history and positions paginated at a frozen cursor", async () => {
  const { room: durable } = await room();
  const service = new DurableRoomService({ getByName: () => ({ fetch: (request: Request) => durable.fetch(request) }) }, "https://msg.0000.chat");
  const worker = createWorker(service);
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "Owner source", author: "owner", display_name: "Owner", semantic_type: "message" } }));
  const ownerSource = (await initialized.json() as { id: string }).id;
  const alice = await durable.fetch(json("/messages", { input: { content: "I approve this revision.", author: "alice", display_name: "Alice", semantic_type: "message" } }));
  const aliceSource = (await alice.json() as { message: { id: string } }).message.id;
  const bob = await durable.fetch(json("/messages", { input: { content: "I approve this revision too.", author: "bob", display_name: "Bob", semantic_type: "message" } }));
  const bobSource = (await bob.json() as { message: { id: string } }).message.id;
  const created = await worker.fetch(workerJson("/room/coordination/proposals", decisionProposal("paged-decision", ownerSource)));
  const createdValue = await created.json() as { proposal: { proposal_id: string; revision: number } };
  const recommendation = await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: 0, client_retry_id: "paged-recommendation", decision_publication: { mode: "recommendation" }, owner_label: "room-owner", proposal_id: createdValue.proposal.proposal_id, revision: createdValue.proposal.revision }));
  expect(recommendation.status).toBe(201);

  const publishPosition = async (retry: string, baseRevision: number, participantLabel: string) => {
    const proposed = await worker.fetch(workerJson("/room/coordination/proposals", { ...decisionPosition(retry + "-proposal", createdValue.proposal.proposal_id, 1, ownerSource, participantLabel), base_revision: baseRevision }));
    expect(proposed.status).toBe(201);
    const value = await proposed.json() as { proposal: { proposal_id: string; revision: number } };
    const published = await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: baseRevision, client_retry_id: retry, owner_label: "room-owner", proposal_id: value.proposal.proposal_id, revision: value.proposal.revision }));
    expect(published.status).toBe(201);
    return value.proposal.proposal_id;
  };
  const firstPositionId = await publishPosition("paged-position-one", 1, "carol");
  const secondPositionId = await publishPosition("paged-position-two", 2, "dana");

  const frozen = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/decisions/${createdValue.proposal.proposal_id}?limit=1`));
  expect(frozen.status).toBe(200);
  const frozenValue = await frozen.json() as { history_through: number; decision: { state: string }; history: readonly { cursor: number }[]; positions: readonly { position_id: string }[]; history_next_after: number; positions_next_after: number };
  expect(frozenValue).toMatchObject({ decision: { state: "recommended" }, history: [{ operation: "decision.recommended" }], positions: [{ position_id: firstPositionId }] });
  expect(frozenValue.history_next_after).toBe(frozenValue.history[0]!.cursor);
  expect(frozenValue.positions_next_after).toBeGreaterThan(0);

  const accepted = await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: 3, client_retry_id: "paged-acceptance", decision_publication: { approvals: [{ participant_label: "alice", source_message_id: aliceSource }, { participant_label: "bob", source_message_id: bobSource }], mode: "acceptance", owner_attestation: true }, owner_label: "room-owner", proposal_id: createdValue.proposal.proposal_id, revision: createdValue.proposal.revision }));
  expect(accepted.status).toBe(201);
  const thirdPositionId = await publishPosition("paged-position-three", 4, "erin");
  expect(thirdPositionId).not.toBe(firstPositionId);

  const pageOne = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/decisions/${createdValue.proposal.proposal_id}?after=0&through=${frozenValue.history_through}&limit=1`));
  const pageOneValue = await pageOne.json() as { decision: { state: string; accepted_record_id?: string }; history: readonly { cursor: number }[]; history_has_more: boolean; history_next_after: number; positions: readonly { position_id: string }[]; positions_has_more: boolean; positions_next_after: number };
  expect(pageOneValue).toMatchObject({ decision: { state: "recommended" }, history_has_more: true, positions_has_more: true, history: [{ cursor: frozenValue.history[0]!.cursor }], positions: [{ position_id: firstPositionId }] });
  const pageTwo = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/decisions/${createdValue.proposal.proposal_id}?after=${pageOneValue.history_next_after}&through=${frozenValue.history_through}&limit=1`));
  const pageTwoValue = await pageTwo.json() as { history: readonly { cursor: number }[]; history_has_more: boolean; history_next_after: number; positions: readonly { position_id: string }[]; positions_has_more: boolean; positions_next_after: number };
  expect(pageTwoValue).toMatchObject({ history_has_more: true, positions_has_more: true, history: [{ position: { position_id: firstPositionId } }], positions: [{ position_id: firstPositionId }] });
  const pageThree = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/decisions/${createdValue.proposal.proposal_id}?after=${pageTwoValue.history_next_after}&through=${frozenValue.history_through}&limit=1`));
  const pageThreeValue = await pageThree.json() as { history: readonly { cursor: number }[]; history_has_more: boolean; positions: readonly { position_id: string }[] };
  expect(pageThreeValue).toMatchObject({ history_has_more: false, history: [{ position: { position_id: secondPositionId } }], positions: [{ position_id: secondPositionId }] });
  expect(new Set([...pageOneValue.history, ...pageTwoValue.history, ...pageThreeValue.history].map((entry) => entry.cursor)).size).toBe(3);

  const positionPageTwo = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/decisions/${createdValue.proposal.proposal_id}?after=${pageOneValue.positions_next_after}&through=${frozenValue.history_through}&limit=1`));
  const positionPageTwoValue = await positionPageTwo.json() as { positions: readonly { position_id: string }[]; positions_has_more: boolean; positions_next_after: number };
  expect(positionPageTwoValue).toMatchObject({ positions_has_more: false, positions: [{ position_id: secondPositionId }] });
  const positionPageThree = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/decisions/${createdValue.proposal.proposal_id}?after=${positionPageTwoValue.positions_next_after}&through=${frozenValue.history_through}&limit=1`));
  expect(await positionPageThree.json()).toMatchObject({ positions: [], positions_has_more: false });

  const current = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/decisions/${createdValue.proposal.proposal_id}?limit=20`));
  expect(await current.json()).toMatchObject({ decision: { state: "accepted" }, positions: [{ position_id: firstPositionId }, { position_id: secondPositionId }, { position_id: thirdPositionId }] });
  const frozenList = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/decisions?through=${frozenValue.history_through}&limit=20`));
  expect(await frozenList.json()).toMatchObject({ through: frozenValue.history_through, decisions: [{ decision_id: createdValue.proposal.proposal_id, state: "recommended" }] });
});

test("routes correction publication and follows its original publication and source links", async () => {
  const { room: durable } = await room();
  const service = new DurableRoomService({ getByName: () => ({ fetch: (request: Request) => durable.fetch(request) }) }, "https://msg.0000.chat");
  const worker = createWorker(service);
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "Owner source", author: "owner", display_name: "Owner", semantic_type: "message" } }));
  const sourceId = (await initialized.json() as { id: string }).id;

  const created = await worker.fetch(workerJson("/room/coordination/proposals", proposal("correction-request", sourceId)));
  const createdValue = await created.json() as { proposal: { proposal_id: string; revision: number } };
  const published = await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: 0, client_retry_id: "correction-request-publish", owner_label: "room-owner", proposal_id: createdValue.proposal.proposal_id, revision: createdValue.proposal.revision }));
  expect(published.status).toBe(201);
  const publishedValue = await published.json() as { published_revision: number };
  const publication = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/publications/${publishedValue.published_revision}`));
  expect(publication.status).toBe(200);
  const publicationValue = await publication.json() as { publication: { body: { title: string }; source_messages: readonly { citation_url: string }[]; corrections_url: string; correction_count: number } };
  expect(publicationValue.publication).toMatchObject({ body: { title: "Collect evidence" }, correction_count: 0, source_messages: [{ citation_url: `https://msg.0000.chat/room/messages/${sourceId}` }] });
  const inheritedPath = await worker.fetch(workerJson("/room/coordination/proposals", {
    actor_label: "reporter",
    base_revision: publishedValue.published_revision,
    body: { correction_text: "Inherited properties are not claims.", target: { claim_path: ["toString"], published_revision: publishedValue.published_revision, type: "publication" } },
    client_retry_id: "correction-inherited-path",
    kind: "claim.correction",
    source_message_ids: [sourceId],
  }));
  expect(inheritedPath.status).toBe(400);
  const missingMessage = await worker.fetch(workerJson("/room/coordination/proposals", {
    actor_label: "reporter",
    base_revision: publishedValue.published_revision,
    body: { correction_text: "The missing message cannot be corrected.", target: { message_id: "missing-message", type: "message" } },
    client_retry_id: "correction-missing-message",
    kind: "claim.correction",
    source_message_ids: [sourceId],
  }));
  expect(missingMessage.status).toBe(404);

  const correction = await worker.fetch(workerJson("/room/coordination/proposals", {
    actor_label: "reporter",
    base_revision: publishedValue.published_revision,
    body: { correction_text: "The title should identify the release evidence.", target: { claim_path: ["title"], published_revision: publishedValue.published_revision, type: "publication" } },
    client_retry_id: "correction-proposal",
    kind: "claim.correction",
    source_message_ids: [sourceId],
  }));
  expect(correction.status).toBe(201);
  const correctionValue = await correction.json() as { proposal: { proposal_id: string; revision: number } };
  const correctionPublication = await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: publishedValue.published_revision, client_retry_id: "correction-publish", owner_label: "room-owner", proposal_id: correctionValue.proposal.proposal_id, revision: correctionValue.proposal.revision }));
  expect(correctionPublication.status).toBe(201);
  const correctionPublicationValue = await correctionPublication.json() as { correction: { correction_id: string; target_url: string; source_messages: readonly { citation_url: string }[] }; published_revision: number };
  expect(correctionPublicationValue.correction).toMatchObject({ target_url: `https://msg.0000.chat/room/coordination/publications/${publishedValue.published_revision}#claim-%5B%22title%22%5D`, source_messages: [{ citation_url: `https://msg.0000.chat/room/messages/${sourceId}` }] });

  const listed = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/corrections?target_type=publication&target_published_revision=${publishedValue.published_revision}&limit=20`));
  expect(await listed.json()).toMatchObject({ correction_count: 1, corrections: [{ correction_id: correctionValue.proposal.proposal_id }] });
  const detail = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/corrections/${correctionValue.proposal.proposal_id}`));
  expect(await detail.json()).toMatchObject({ correction: { target_url: `https://msg.0000.chat/room/coordination/publications/${publishedValue.published_revision}#claim-%5B%22title%22%5D` } });
  const original = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/publications/${publishedValue.published_revision}`));
  expect(await original.json()).toMatchObject({ publication: { body: { title: "Collect evidence" }, correction_count: 1 } });

  const secondCorrectionProposal = await worker.fetch(workerJson("/room/coordination/proposals", {
    actor_label: "reporter-two",
    base_revision: correctionPublicationValue.published_revision,
    body: { correction_text: "The purpose also needs a source qualifier.", target: { claim_path: ["purpose"], published_revision: publishedValue.published_revision, type: "publication" } },
    client_retry_id: "correction-second-proposal",
    kind: "claim.correction",
    source_message_ids: [sourceId],
  }));
  const secondCorrection = await secondCorrectionProposal.json() as { proposal: { proposal_id: string; revision: number } };
  const secondPublished = await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: correctionPublicationValue.published_revision, client_retry_id: "correction-second-publish", owner_label: "room-owner", proposal_id: secondCorrection.proposal.proposal_id, revision: secondCorrection.proposal.revision }));
  expect(secondPublished.status).toBe(201);
  const secondPublishedValue = await secondPublished.json() as { published_revision: number };
  const titlePath = encodeURIComponent(JSON.stringify(["title"]));
  const purposePath = encodeURIComponent(JSON.stringify(["purpose"]));
  expect(await (await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/corrections?target_published_revision=${publishedValue.published_revision}&target_claim_path=${titlePath}&limit=20`))).json()).toMatchObject({ correction_count: 1, corrections: [{ correction_id: correctionPublicationValue.correction.correction_id }] });
  expect(await (await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/corrections?target_published_revision=${publishedValue.published_revision}&target_claim_path=${purposePath}&limit=20`))).json()).toMatchObject({ correction_count: 1, corrections: [{ correction_id: secondCorrection.proposal.proposal_id }] });

  const beforeMessage = await worker.fetch(new Request(`https://msg.0000.chat/room/messages/${sourceId}`, { headers: { accept: "application/json" } }));
  const beforeMessageValue = await beforeMessage.json() as { message: unknown; correction_count: number; corrections_url: string; coordination_cursor: number };
  const messageCorrectionProposal = await worker.fetch(workerJson("/room/coordination/proposals", {
    actor_label: "message-reporter",
    base_revision: secondPublishedValue.published_revision,
    body: { correction_text: "The original message is accompanied by this attributed correction.", target: { message_id: sourceId, type: "message" } },
    client_retry_id: "correction-message-proposal",
    kind: "claim.correction",
    source_message_ids: [sourceId],
  }));
  const messageCorrection = await messageCorrectionProposal.json() as { proposal: { proposal_id: string; revision: number } };
  const messagePublished = await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: secondPublishedValue.published_revision, client_retry_id: "correction-message-publish", owner_label: "room-owner", proposal_id: messageCorrection.proposal.proposal_id, revision: messageCorrection.proposal.revision }));
  expect(messagePublished.status).toBe(201);
  const afterMessage = await worker.fetch(new Request(`https://msg.0000.chat/room/messages/${sourceId}`, { headers: { accept: "application/json", "if-none-match": beforeMessage.headers.get("etag") ?? "" } }));
  const afterMessageValue = await afterMessage.json() as { message: unknown; correction_count: number; corrections_url: string; coordination_cursor: number };
  expect(afterMessageValue).toMatchObject({ correction_count: 1, corrections_url: `https://msg.0000.chat/room/coordination/corrections?target_type=message&target_message_id=${sourceId}` });
  expect(afterMessageValue.message).toEqual(beforeMessageValue.message);
  expect(afterMessageValue.coordination_cursor).toBeGreaterThan(beforeMessageValue.coordination_cursor);
  expect(afterMessage.headers.get("etag")).not.toBe(beforeMessage.headers.get("etag"));
});

test("routes attributed disputes and owner reviews without changing the accepted record", async () => {
  const { room: durable } = await room();
  const service = new DurableRoomService({ getByName: () => ({ fetch: (request: Request) => durable.fetch(request) }) }, "https://msg.0000.chat");
  const worker = createWorker(service);
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "Owner source", author: "owner", display_name: "Owner", semantic_type: "message" } }));
  const ownerSource = (await initialized.json() as { id: string }).id;
  const approval = await durable.fetch(json("/messages", { input: { content: "I approve this exact proposal.", author: "alice", display_name: "Alice", semantic_type: "message" } }));
  const approvalSource = (await approval.json() as { message: { id: string } }).message.id;
  const secondApproval = await durable.fetch(json("/messages", { input: { content: "I approve this exact proposal too.", author: "bob", display_name: "Bob", semantic_type: "message" } }));
  const secondApprovalSource = (await secondApproval.json() as { message: { id: string } }).message.id;
  const created = await worker.fetch(workerJson("/room/coordination/proposals", decisionProposal("dispute-decision", ownerSource)));
  const decision = await created.json() as { proposal: { proposal_id: string; revision: number } };
  const accepted = await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: 0, client_retry_id: "dispute-acceptance", decision_publication: { approvals: [{ participant_label: "alice", source_message_id: approvalSource }, { participant_label: "bob", source_message_id: secondApprovalSource }], mode: "acceptance", owner_attestation: true }, owner_label: "room-owner", proposal_id: decision.proposal.proposal_id, revision: decision.proposal.revision }));
  expect(accepted.status).toBe(201);
  const acceptedValue = await accepted.json() as { accepted_record: { accepted_record_id: string; proposal_snapshot: unknown; publication_revision: number }; approvals: readonly { approval_record_id: string }[]; published_revision: number };
  const immutableSnapshot = acceptedValue.accepted_record.proposal_snapshot;

  const invalidWithdrawal = await worker.fetch(workerJson("/room/coordination/disputes", { accepted_record_id: acceptedValue.accepted_record.accepted_record_id, actor_label: "reporter", approval_record_id: "missing-approval", client_retry_id: "invalid-withdrawal", kind: "approval_withdrawal", source_message_ids: [], statement: "This approval record does not belong to the accepted decision." }));
  expect(invalidWithdrawal.status).toBe(404);

  const reported = await worker.fetch(workerJson("/room/coordination/disputes", { accepted_record_id: acceptedValue.accepted_record.accepted_record_id, actor_label: "reporter", client_retry_id: "dispute-report-one", kind: "dispute", source_message_ids: [ownerSource], statement: "I dispute the conclusion based on the cited evidence." }));
  expect(reported.status).toBe(201);
  const report = await reported.json() as { dispute: { report_id: string; actor_label: string; cursor: number; latest_review?: unknown }; published_revision: number; coordination_cursor: number };
  expect(report).toMatchObject({ dispute: { actor_label: "reporter" }, published_revision: acceptedValue.published_revision });

  const contested = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/decisions/${decision.proposal.proposal_id}`));
  expect(await contested.json()).toMatchObject({ decision: { contested: true, current_annotations: { report_count: 1, unresolved_report_count: 1 } } });
  const record = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/decisions/${decision.proposal.proposal_id}/records/${acceptedValue.accepted_record.accepted_record_id}`));
  expect(await record.json()).toMatchObject({ accepted_record: { proposal_snapshot: immutableSnapshot }, current_annotations: { contested: true, reports_preview: [{ report_id: report.dispute.report_id }] } });
  const reports = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/disputes?accepted_record_id=${acceptedValue.accepted_record.accepted_record_id}&limit=20`));
  expect(await reports.json()).toMatchObject({ report_count: 1, unresolved_report_count: 1, disputes: [{ report_id: report.dispute.report_id, source_messages: [{ citation_url: `https://msg.0000.chat/room/messages/${ownerSource}` }] }] });

  const reviewed = await worker.fetch(workerJson(`/manage/room/owner-token/coordination/disputes/${report.dispute.report_id}/review`, { base_revision: acceptedValue.published_revision, client_retry_id: "dispute-review-one", disposition: "acknowledged", owner_label: "room-owner", rationale: "The owner recorded the account for follow-up.", source_message_ids: [ownerSource] }));
  expect(reviewed.status).toBe(201);
  const reviewedValue = await reviewed.json() as { review: { review_id: string }; published_revision: number };
  expect(reviewedValue.review.review_id).toBeString();
  expect(reviewedValue.published_revision).toBe(acceptedValue.published_revision + 1);
  const afterReview = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/decisions/${decision.proposal.proposal_id}`));
  expect(await afterReview.json()).toMatchObject({ decision: { contested: false, current_annotations: { report_count: 1, unresolved_report_count: 0, reports_preview: [{ latest_review: { review_id: reviewedValue.review.review_id } }] } } });

  const unauthorizedReplay = await worker.fetch(workerJson(`/manage/room/wrong-token/coordination/disputes/${report.dispute.report_id}/review`, { base_revision: acceptedValue.published_revision, client_retry_id: "dispute-review-one", disposition: "acknowledged", owner_label: "room-owner", rationale: "The owner recorded the account for follow-up.", source_message_ids: [ownerSource] }));
  expect(unauthorizedReplay.status).toBe(404);
  const replayedReview = await worker.fetch(workerJson(`/manage/room/owner-token/coordination/disputes/${report.dispute.report_id}/review`, { base_revision: acceptedValue.published_revision, client_retry_id: "dispute-review-one", disposition: "acknowledged", owner_label: "room-owner", rationale: "The owner recorded the account for follow-up.", source_message_ids: [ownerSource] }));
  expect(await replayedReview.json()).toMatchObject({ replayed: true, review: { review_id: reviewedValue.review.review_id } });
  const changedReplay = await worker.fetch(workerJson(`/manage/room/owner-token/coordination/disputes/${report.dispute.report_id}/review`, { base_revision: acceptedValue.published_revision, client_retry_id: "dispute-review-one", disposition: "rejected", owner_label: "room-owner", rationale: "Changed retry input.", source_message_ids: [ownerSource] }));
  expect(changedReplay.status).toBe(409);

  const secondReviewed = await worker.fetch(workerJson(`/manage/room/owner-token/coordination/disputes/${report.dispute.report_id}/review`, { base_revision: reviewedValue.published_revision, client_retry_id: "dispute-review-two", disposition: "rejected", owner_label: "room-owner", rationale: "A later owner assessment remains attributable.", source_message_ids: [] }));
  expect(secondReviewed.status).toBe(201);
  const secondReviewedValue = await secondReviewed.json() as { review: { review_id: string }; published_revision: number };
  const frozenReport = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/disputes/${report.dispute.report_id}?through=${report.dispute.cursor}&limit=20`));
  expect(await frozenReport.json()).toMatchObject({ through: report.dispute.cursor, dispute: { reviews: [], reviews_has_more: false, reviews_next_after: 0, reviews_through: report.dispute.cursor } });
  const reviewPageOne = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/disputes/${report.dispute.report_id}?limit=1`));
  const reviewPageOneValue = await reviewPageOne.json() as { dispute: { reviews: readonly { review_id: string; cursor: number }[]; reviews_has_more: boolean; reviews_next_after: number; reviews_through: number } };
  expect(reviewPageOneValue.dispute).toMatchObject({ reviews: [{ review_id: reviewedValue.review.review_id }], reviews_has_more: true });
  const reviewPageTwo = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/disputes/${report.dispute.report_id}?after=${reviewPageOneValue.dispute.reviews_next_after}&limit=1`));
  expect(await reviewPageTwo.json()).toMatchObject({ dispute: { reviews: [{ review_id: secondReviewedValue.review.review_id }], reviews_has_more: false } });

  const secondReported = await worker.fetch(workerJson("/room/coordination/disputes", { accepted_record_id: acceptedValue.accepted_record.accepted_record_id, actor_label: "second-reporter", approval_record_id: acceptedValue.approvals[0]!.approval_record_id, client_retry_id: "dispute-report-two", kind: "approval_withdrawal", source_message_ids: [], statement: "A second attributed withdrawal account remains unresolved." }));
  expect(secondReported.status).toBe(201);
  const secondReportValue = await secondReported.json() as { dispute: { report_id: string; cursor: number } };
  expect(await (await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/decisions/${decision.proposal.proposal_id}`))).json()).toMatchObject({ decision: { contested: true, current_annotations: { report_count: 2, unresolved_report_count: 1 } } });
  const absentAtThrough = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/disputes/${secondReportValue.dispute.report_id}?through=${report.dispute.cursor}`));
  expect(absentAtThrough.status).toBe(404);
  const reportDetail = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/disputes/${report.dispute.report_id}?limit=20`));
  expect(await reportDetail.json()).toMatchObject({ dispute: { reviews: [{ review_id: reviewedValue.review.review_id }, { review_id: secondReviewedValue.review.review_id }] } });

  const hiddenReportIds: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const hiddenReport = await worker.fetch(workerJson("/room/coordination/disputes", { accepted_record_id: acceptedValue.accepted_record.accepted_record_id, actor_label: `hidden-reporter-${index}`, client_retry_id: `hidden-report-${index}`, kind: "dispute", source_message_ids: [], statement: `Unresolved attributed account ${index}.` }));
    expect(hiddenReport.status).toBe(201);
    hiddenReportIds.push(((await hiddenReport.json()) as { dispute: { report_id: string } }).dispute.report_id);
  }
  const previewResponse = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/decisions/${decision.proposal.proposal_id}/records/${acceptedValue.accepted_record.accepted_record_id}`));
  const previewValue = await previewResponse.json() as { current_annotations: { reports_preview: readonly { report_id: string; latest_review?: unknown }[] } };
  expect(previewValue.current_annotations.reports_preview).toHaveLength(5);
  let reviewBase = secondReviewedValue.published_revision;
  for (const previewReport of previewValue.current_annotations.reports_preview) {
    if (previewReport.latest_review !== undefined) continue;
    const previewReview = await worker.fetch(workerJson(`/manage/room/owner-token/coordination/disputes/${previewReport.report_id}/review`, { base_revision: reviewBase, client_retry_id: `preview-review-${previewReport.report_id}`, disposition: "acknowledged", owner_label: "room-owner", rationale: "The owner reviewed this visible account.", source_message_ids: [] }));
    expect(previewReview.status).toBe(201);
    reviewBase = ((await previewReview.json()) as { published_revision: number }).published_revision;
  }
  const afterPreviewReviews = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/decisions/${decision.proposal.proposal_id}/records/${acceptedValue.accepted_record.accepted_record_id}`));
  expect(await afterPreviewReviews.json()).toMatchObject({ current_annotations: { report_count: 8, unresolved_report_count: 3 } });
  expect(hiddenReportIds).toHaveLength(6);
});

test("rejects a dispute atomically when persisted metadata exceeds the room quota", async () => {
  const { room: durable } = await room({ MSG_TEST_ROOM_LIMITS: JSON.stringify({ maxRoomBytes: 20_000 }) });
  const service = new DurableRoomService({ getByName: () => ({ fetch: (request: Request) => durable.fetch(request) }) }, "https://msg.0000.chat");
  const worker = createWorker(service);
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "Owner source", author: "owner", display_name: "Owner", semantic_type: "message" } }));
  const ownerSource = (await initialized.json() as { id: string }).id;
  const alice = await durable.fetch(json("/messages", { input: { content: "I approve this exact proposal.", author: "alice", display_name: "Alice", semantic_type: "message" } }));
  const aliceSource = (await alice.json() as { message: { id: string } }).message.id;
  const bob = await durable.fetch(json("/messages", { input: { content: "I approve this exact proposal too.", author: "bob", display_name: "Bob", semantic_type: "message" } }));
  const bobSource = (await bob.json() as { message: { id: string } }).message.id;
  const created = await worker.fetch(workerJson("/room/coordination/proposals", decisionProposal("quota-dispute-decision", ownerSource)));
  const decision = await created.json() as { proposal: { proposal_id: string; revision: number } };
  const accepted = await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: 0, client_retry_id: "quota-dispute-acceptance", decision_publication: { approvals: [{ participant_label: "alice", source_message_id: aliceSource }, { participant_label: "bob", source_message_id: bobSource }], mode: "acceptance", owner_attestation: true }, owner_label: "room-owner", proposal_id: decision.proposal.proposal_id, revision: decision.proposal.revision }));
  expect(accepted.status).toBe(201);
  const acceptedValue = await accepted.json() as { accepted_record: { accepted_record_id: string } };
  const before = await (await durable.fetch(new Request("https://room/read?after=0&limit=20"))).json() as { coordination_cursor: number; latest_message: number; published_revision: number };
  const reportInput = { accepted_record_id: acceptedValue.accepted_record.accepted_record_id, actor_label: "a".repeat(80), client_retry_id: "quota-dispute-report", kind: "dispute", source_message_ids: [ownerSource, aliceSource, bobSource], statement: "x".repeat(1_800) };
  const rejected = await worker.fetch(workerJson("/room/coordination/disputes", reportInput));
  expect(rejected.status).toBe(429);
  expect(await (await durable.fetch(new Request("https://room/read?after=0&limit=20"))).json()).toMatchObject(before);
  expect(await (await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/disputes?accepted_record_id=${acceptedValue.accepted_record.accepted_record_id}`))).json()).toMatchObject({ report_count: 0, disputes: [] });
  expect((await worker.fetch(workerJson("/room/coordination/disputes", reportInput))).status).toBe(429);
});

test("keeps supersession proposed until the exact newer successor is accepted", async () => {
  const { room: durable } = await room();
  const service = new DurableRoomService({ getByName: () => ({ fetch: (request: Request) => durable.fetch(request) }) }, "https://msg.0000.chat");
  const worker = createWorker(service);
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "Owner source", author: "owner", display_name: "Owner", semantic_type: "message" } }));
  const ownerSource = (await initialized.json() as { id: string }).id;
  const alice = await durable.fetch(json("/messages", { input: { content: "I approve the predecessor.", author: "alice", display_name: "Alice", semantic_type: "message" } }));
  const aliceSource = (await alice.json() as { message: { id: string } }).message.id;
  const bob = await durable.fetch(json("/messages", { input: { content: "I approve the predecessor too.", author: "bob", display_name: "Bob", semantic_type: "message" } }));
  const bobSource = (await bob.json() as { message: { id: string } }).message.id;

  const predecessorProposal = await worker.fetch(workerJson("/room/coordination/proposals", decisionProposal("supersession-predecessor", ownerSource, 0, "Old release")));
  const predecessor = await predecessorProposal.json() as { proposal: { proposal_id: string; revision: number } };
  const predecessorPublication = await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: 0, client_retry_id: "supersession-predecessor-accept", decision_publication: { approvals: [{ participant_label: "alice", source_message_id: aliceSource }, { participant_label: "bob", source_message_id: bobSource }], mode: "acceptance", owner_attestation: true }, owner_label: "room-owner", proposal_id: predecessor.proposal.proposal_id, revision: predecessor.proposal.revision }));
  const predecessorAccepted = await predecessorPublication.json() as { accepted_record: { accepted_record_id: string }; published_revision: number };

  const successorProposal = await worker.fetch(workerJson("/room/coordination/proposals", decisionProposal("supersession-successor", ownerSource, predecessorAccepted.published_revision, "New release")));
  const successor = await successorProposal.json() as { proposal: { proposal_id: string; revision: number } };
  const relationInput = {
    actor_label: "reporter",
    base_revision: predecessorAccepted.published_revision,
    body: { predecessor_accepted_record_id: predecessorAccepted.accepted_record.accepted_record_id, successor_decision_id: successor.proposal.proposal_id, successor_decision_revision: successor.proposal.revision },
    client_retry_id: "supersession-link",
    kind: "decision.supersession",
    source_message_ids: [ownerSource],
  };
  const relationProposal = await worker.fetch(workerJson("/room/coordination/proposals", relationInput));
  expect(relationProposal.status).toBe(201);
  const relation = await relationProposal.json() as { proposal: { proposal_id: string; revision: number } };
  const pending = await worker.fetch(new Request("https://msg.0000.chat/room/coordination/proposals?limit=20"));
  const pendingValue = await pending.json() as { proposals: readonly { kind: string; status: string }[] };
  expect(pendingValue.proposals).toContainEqual(expect.objectContaining({ kind: "decision.supersession", status: "pending" }));
  const premature = await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: predecessorAccepted.published_revision, client_retry_id: "supersession-premature", owner_label: "room-owner", proposal_id: relation.proposal.proposal_id, revision: relation.proposal.revision }));
  expect(premature.status).toBe(409);

  const successorPublication = await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: predecessorAccepted.published_revision, client_retry_id: "supersession-successor-accept", decision_publication: { approvals: [{ participant_label: "alice", source_message_id: aliceSource }, { participant_label: "bob", source_message_id: bobSource }], mode: "acceptance", owner_attestation: true }, owner_label: "room-owner", proposal_id: successor.proposal.proposal_id, revision: successor.proposal.revision }));
  expect(successorPublication.status).toBe(201);
  const successorAccepted = await successorPublication.json() as { accepted_record: { accepted_record_id: string }; published_revision: number };
  const rebasedRelation = await worker.fetch(workerJson(`/room/coordination/proposals/${relation.proposal.proposal_id}/revisions`, { ...relationInput, base_revision: successorAccepted.published_revision, client_retry_id: "supersession-link-rebased" }));
  expect(rebasedRelation.status).toBe(201);
  const rebased = await rebasedRelation.json() as { coordination_cursor: number; proposal: { proposal_id: string; revision: number } };
  const frozenThrough = rebased.coordination_cursor;
  const publishedRelation = await worker.fetch(workerJson("/manage/room/owner-token/coordination/publish", { base_revision: successorAccepted.published_revision, client_retry_id: "supersession-link-publish", owner_label: "room-owner", proposal_id: rebased.proposal.proposal_id, revision: rebased.proposal.revision }));
  expect(publishedRelation.status).toBe(201);
  expect(await publishedRelation.json()).toMatchObject({ supersession: { predecessor_accepted_record_id: predecessorAccepted.accepted_record.accepted_record_id, successor_decision_id: successor.proposal.proposal_id } });

  const frozenSupersessions = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/supersessions?through=${frozenThrough}&limit=20`));
  expect(await frozenSupersessions.json()).toMatchObject({ through: frozenThrough, supersession_count: 0, supersessions: [] });
  const currentSupersessions = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/supersessions?predecessor_accepted_record_id=${predecessorAccepted.accepted_record.accepted_record_id}&limit=20`));
  const currentSupersessionValue = await currentSupersessions.json() as { supersession_count: number; supersessions: readonly { detail_url: string }[] };
  expect(currentSupersessionValue).toMatchObject({ supersession_count: 1, supersessions: [{ detail_url: `https://msg.0000.chat/room/coordination/publications/${successorAccepted.published_revision + 1}` }] });
  const successorFiltered = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/supersessions?successor_decision_id=${successor.proposal.proposal_id}&limit=20`));
  expect(await successorFiltered.json()).toMatchObject({ supersession_count: 1, supersessions: [{ predecessor_accepted_record_id: predecessorAccepted.accepted_record.accepted_record_id }] });

  const predecessorRecord = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/decisions/${predecessor.proposal.proposal_id}/records/${predecessorAccepted.accepted_record.accepted_record_id}`));
  expect(await predecessorRecord.json()).toMatchObject({ current_annotations: { superseded: true, successor_count: 1, successor_links: [{ successor_decision_id: successor.proposal.proposal_id }] } });
  const successorRecord = await worker.fetch(new Request(`https://msg.0000.chat/room/coordination/decisions/${successor.proposal.proposal_id}/records/${successorAccepted.accepted_record.accepted_record_id}`));
  expect(await successorRecord.json()).toMatchObject({ current_annotations: { predecessor_count: 1, predecessor_links: [{ predecessor_accepted_record_id: predecessorAccepted.accepted_record.accepted_record_id }] } });
});
