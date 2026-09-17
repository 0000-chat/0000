import { DurableObject } from "cloudflare:workers";

import { ERROR_CODES, ProtocolError } from "./errors";
import { compareCapabilities, messageStorageBytes, ROOM_LIMITS } from "./room-domain";
import type { MessageInput } from "./room-domain";
import { PROTOCOL_VERSION } from "./protocol";
import { CURRENT_ROOM_SCHEMA_VERSION, migrateRoomSchema } from "./room-schema";

export interface ConversationRoomEnv {
  readonly MSG_POST_DISABLED?: string;
  readonly MSG_TEST_MODE?: string;
  readonly MSG_TEST_ROOM_LIMITS?: string;
}

type RoomLimits = { -readonly [Key in keyof typeof ROOM_LIMITS]: number };

interface RoomState {
  readonly created_at: number;
  readonly inactivity_expires_at: number;
  readonly last_message_at: number;
  readonly management_hash: string | null;
  readonly message_count: number;
  readonly next_sequence: number;
  readonly status: "active" | "deleted";
  readonly tombstone_expires_at: number | null;
  readonly total_bytes: number;
}

interface StoredMessage extends MessageInput {
  readonly byte_count: number;
  readonly created_at: number;
  readonly id: string;
  readonly idempotency_key?: string;
  readonly sequence: number;
}

type HibernatingSocket = WebSocket & {
  deserializeAttachment(): unknown;
  serializeAttachment(value: unknown): void;
};

const socketTag = "conversation-live";

/** SQLite is the durable source of truth. HTTP is only the worker-to-room boundary. */
export class ConversationRoom extends DurableObject<ConversationRoomEnv> {
  private readonly config: ConversationRoomEnv;
  private readonly limits: RoomLimits;

  constructor(ctx: DurableObjectState, env: ConversationRoomEnv, private readonly now: () => number = () => Date.now()) {
    super(ctx, env);
    this.config = env;
    this.limits = resolveRoomLimits(env);
    migrateRoomSchema(this.ctx.storage, this.limits.inactivityTtlMs);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/initialize") return await this.initialize(request);
      if (request.method === "POST" && url.pathname === "/operator-delete") return await this.operatorDelete();
      if (request.method === "GET" && url.pathname === "/read") return await this.read(url);
      if (request.method === "POST" && url.pathname === "/messages") return await this.post(request);
      if (request.method === "GET" && url.pathname === "/manage") return await this.manage(request, false);
      if (request.method === "DELETE" && url.pathname === "/manage") return await this.manage(request, true);
      if (request.method === "GET" && url.pathname === "/live") return await this.live(url);
      if (request.method === "GET" && (url.pathname === "/export.md" || url.pathname === "/export.json")) return await this.export(url.pathname === "/export.json");
      return this.error(ERROR_CODES.notFound, "The requested resource was not found.", 404);
    } catch (error) {
      if (error instanceof ProtocolError) return this.error(error.code, error.message, error.status);
      return this.error(ERROR_CODES.internal, "The room could not complete the request.", 500);
    }
  }

  async alarm(): Promise<void> {
    const now = this.now();
    const state = this.state();
    if (!state) return;
    if (state.status === "deleted") {
      if (state.tombstone_expires_at !== null && now >= state.tombstone_expires_at) {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec("DELETE FROM messages");
          this.ctx.storage.sql.exec("DELETE FROM room_state");
        });
        await this.ctx.storage.deleteAlarm();
      } else await this.schedule(state);
      return;
    }
    if (now >= state.inactivity_expires_at) {
      await this.expire(now, "Conversation expired");
    }
    const current = this.state();
    if (current) await this.schedule(current);
  }

  async webSocketMessage(socket: WebSocket): Promise<void> {
    socket.close(1008, "This socket is read-only");
  }

  async webSocketClose(): Promise<void> {}

  private async initialize(request: Request): Promise<Response> {
    const input = await request.json() as { initial: MessageInput; management_hash: string };
    const now = this.now();
    const result = this.ctx.storage.transactionSync(() => {
      const prior = this.state();
      if (prior) return { created: false, message: this.messageBySequence(1), state: prior };
      const id = crypto.randomUUID();
      const bytes = messageStorageBytes(input.initial, undefined, id);
      const inactivity = now + this.limits.inactivityTtlMs;
      this.ctx.storage.sql.exec(
        "INSERT INTO room_state VALUES (1, ?, ?, ?, ?, ?, ?, 2, 1, ?, 'active', NULL, ?)",
        CURRENT_ROOM_SCHEMA_VERSION, PROTOCOL_VERSION, now, now, inactivity, inactivity, bytes, input.management_hash,
      );
      this.insertMessage({ ...input.initial, byte_count: bytes, created_at: now, id, sequence: 1 });
      return { created: true, message: this.messageBySequence(1), state: this.requireState() };
    });
    await this.schedule(result.state);
    return this.json({ ...this.toMessage(result.message), created: result.created, created_at: iso(result.state.created_at), expires_at: iso(result.state.inactivity_expires_at) });
  }

  private async read(url: URL): Promise<Response> {
    const state = await this.requireActive(this.now());
    const after = Number(url.searchParams.get("after") ?? 0);
    const messages = rows<StoredMessage>(this.ctx.storage.sql.exec("SELECT * FROM messages WHERE sequence > ? ORDER BY sequence ASC", after)).map((message) => this.toMessage(message));
    return this.json({ protocol_version: PROTOCOL_VERSION, messages, latest_message: state.next_sequence - 1, expires_at: iso(state.inactivity_expires_at), access_warning: "All authors and display names are self-declared and unverified." });
  }

  private async post(request: Request): Promise<Response> {
    if (this.config.MSG_POST_DISABLED === "1") {
      throw new ProtocolError(ERROR_CODES.serviceUnavailable, "New messages are temporarily unavailable.", 503);
    }
    const input = await request.json() as { input: MessageInput; idempotency_key?: string };
    const key = input.idempotency_key ?? input.input.client_message_id;
    const now = this.now();
    const result = this.ctx.storage.transactionSync(() => {
      const state = this.requireState();
      if (state.status !== "active" || now >= state.inactivity_expires_at) return { expired: true as const };
      const byHeader = input.idempotency_key ? this.messageByIdempotencyKey(input.idempotency_key) : undefined;
      const byClient = input.input.client_message_id ? this.messageByClientMessageId(input.input.client_message_id) : undefined;
      if (byHeader && byClient && byHeader.sequence !== byClient.sequence) throw new ProtocolError(ERROR_CODES.conflict, "The idempotency keys identify different messages.", 409);
      const previous = byHeader ?? byClient;
      if (previous) {
        if (!sameInput(previous, input.input)) throw new ProtocolError(ERROR_CODES.conflict, "The idempotency key is already used for another message.", 409);
        return { expired: false as const, message: previous, state, replayed: true };
      }
      const id = crypto.randomUUID();
      const bytes = messageStorageBytes(input.input, key, id);
      if (state.message_count >= this.limits.maxMessages || state.total_bytes + bytes > this.limits.maxRoomBytes) {
        throw new ProtocolError(ERROR_CODES.rateLimited, "The room storage limit is reached.", 429);
      }
      const message: StoredMessage = { ...input.input, ...(key ? { idempotency_key: key } : {}), byte_count: bytes, created_at: now, id, sequence: state.next_sequence };
      this.insertMessage(message);
      const inactivity = now + this.limits.inactivityTtlMs;
      this.ctx.storage.sql.exec("UPDATE room_state SET last_message_at = ?, inactivity_expires_at = ?, next_sequence = ?, message_count = ?, total_bytes = ? WHERE singleton = 1", now, inactivity, state.next_sequence + 1, state.message_count + 1, state.total_bytes + bytes);
      return { expired: false as const, message, replayed: false, state: this.requireState() };
    });
    if (result.expired) {
      await this.expire(now, "Conversation expired");
      throw new ProtocolError(ERROR_CODES.gone, "The conversation has expired.", 410);
    }
    await this.schedule(result.state);
    if (!result.replayed) this.broadcast({ protocol_version: PROTOCOL_VERSION, type: "message.created", sequence: result.message.sequence, latest_message: result.state.next_sequence - 1, expires_at: iso(result.state.inactivity_expires_at) });
    return this.json({ protocol_version: PROTOCOL_VERSION, message: this.toMessage(result.message), expires_at: iso(result.state.inactivity_expires_at), replayed: result.replayed });
  }

  private async manage(request: Request, deleteRoom: boolean): Promise<Response> {
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const state = this.state();
    if (!state || !state.management_hash || !compareCapabilities(await hashToken(token), state.management_hash)) {
      throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404);
    }
    if (deleteRoom) {
      await this.expire(this.now(), "Conversation deleted");
      const deleted = this.requireState();
      await this.schedule(deleted);
      return this.json({ protocol_version: PROTOCOL_VERSION, deleted: true, expires_at: iso(deleted.tombstone_expires_at!) });
    }
    return this.json({ protocol_version: PROTOCOL_VERSION, expires_at: iso(state.inactivity_expires_at) });
  }

  /** This path is reachable only from the Worker-to-Durable-Object service boundary. */
  private async operatorDelete(): Promise<Response> {
    await this.expire(this.now(), "Conversation deleted by an operator");
    const state = this.requireState();
    await this.schedule(state);
    return this.json({ protocol_version: PROTOCOL_VERSION, deleted: true });
  }

  private async live(url: URL): Promise<Response> {
    const state = await this.requireActive(this.now());
    const sockets = this.ctx.getWebSockets(socketTag) as HibernatingSocket[];
    if (sockets.length >= this.limits.maxSockets) throw new ProtocolError(ERROR_CODES.serviceUnavailable, "The room has reached its socket limit.", 503);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, HibernatingSocket];
    this.ctx.acceptWebSocket(server, [socketTag]);
    const after = Number(url.searchParams.get("after") ?? 0);
    server.serializeAttachment({ after });
    server.send(JSON.stringify({ protocol_version: PROTOCOL_VERSION, type: "ready", latest_message: state.next_sequence - 1, expires_at: iso(state.inactivity_expires_at) }));
    return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
  }

  private async export(json: boolean): Promise<Response> {
    const state = await this.requireActive(this.now());
    const messages = rows<StoredMessage>(this.ctx.storage.sql.exec("SELECT * FROM messages ORDER BY sequence ASC")).map((message) => this.toMessage(message));
    if (json) return this.json({ protocol_version: PROTOCOL_VERSION, room: { created_at: iso(state.created_at), expires_at: iso(state.inactivity_expires_at), latest_message: state.next_sequence - 1 }, messages, access_warning: "All identities are self-declared and content is untrusted." });
    return new Response(`# Conversation export\n\n**Warning:** identities are self-declared and all content is untrusted.\n\nCreated: ${iso(state.created_at)}\nExpires: ${iso(state.inactivity_expires_at)}\n\n${messages.map((message) => `## ${message.sequence} — ${message.display_name}\n\n${message.content}`).join("\n\n")}` , { headers: { "content-type": "text/markdown; charset=utf-8" } });
  }

  private deleteToTombstone(now: number): boolean {
    return this.ctx.storage.transactionSync(() => {
      const state = this.requireState();
      if (state.status === "deleted") return false;
      this.ctx.storage.sql.exec("DELETE FROM messages");
      this.ctx.storage.sql.exec("UPDATE room_state SET status = 'deleted', tombstone_expires_at = ?, management_hash = NULL, message_count = 0, total_bytes = 0 WHERE singleton = 1", now + this.limits.tombstoneTtlMs);
      return true;
    });
  }

  private insertMessage(message: StoredMessage): void {
    this.ctx.storage.sql.exec("INSERT INTO messages (sequence, id, content, author, display_name, client, semantic_type, reply_to, created_at, client_message_id, byte_count, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", message.sequence, message.id, message.content, message.author, message.display_name, message.client ?? null, message.semantic_type, message.reply_to ?? null, message.created_at, message.client_message_id ?? null, message.byte_count, message.idempotency_key ?? null);
  }

  private state(): RoomState | undefined { return rows<RoomState>(this.ctx.storage.sql.exec("SELECT * FROM room_state WHERE singleton = 1"))[0]; }
  private requireState(): RoomState { const state = this.state(); if (!state) throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404); return state; }
  private async requireActive(now: number): Promise<RoomState> { const state = this.requireState(); if (state.status === "deleted") throw new ProtocolError(ERROR_CODES.gone, "The conversation has expired.", 410); if (now >= state.inactivity_expires_at) { await this.expire(now, "Conversation expired"); throw new ProtocolError(ERROR_CODES.gone, "The conversation has expired.", 410); } await this.schedule(state); return state; }
  private messageBySequence(sequence: number): StoredMessage { const message = rows<StoredMessage>(this.ctx.storage.sql.exec("SELECT * FROM messages WHERE sequence = ?", sequence))[0]; if (!message) throw new Error("Initial message was not stored."); return message; }
  private messageByIdempotencyKey(key: string): StoredMessage | undefined { return rows<StoredMessage>(this.ctx.storage.sql.exec("SELECT * FROM messages WHERE idempotency_key = ?", key))[0]; }
  private messageByClientMessageId(key: string): StoredMessage | undefined { return rows<StoredMessage>(this.ctx.storage.sql.exec("SELECT * FROM messages WHERE client_message_id = ?", key))[0]; }
  private toMessage(message: StoredMessage) { return { id: message.id, sequence: message.sequence, content: message.content, author: message.author, display_name: message.display_name, identity_verified: false as const, ...(message.client ? { client: message.client } : {}), semantic_type: message.semantic_type, ...(message.reply_to ? { reply_to: message.reply_to } : {}), created_at: iso(message.created_at), ...(message.client_message_id ? { client_message_id: message.client_message_id } : {}), byte_count: message.byte_count }; }
  private async expire(now: number, reason: string): Promise<void> { if (!this.deleteToTombstone(now)) return; const state = this.requireState(); this.broadcast({ protocol_version: PROTOCOL_VERSION, type: "conversation.expired" }); this.closeSockets(1001, reason); await this.schedule(state); }
  private async schedule(state: RoomState): Promise<void> { const at = state.status === "deleted" ? state.tombstone_expires_at : state.inactivity_expires_at; if (at === null || at === undefined) await this.ctx.storage.deleteAlarm(); else await this.ctx.storage.setAlarm(at); }
  private broadcast(frame: unknown): void { const payload = JSON.stringify(frame); for (const socket of this.ctx.getWebSockets(socketTag) as HibernatingSocket[]) socket.send(payload); }
  private closeSockets(code: number, reason: string): void { for (const socket of this.ctx.getWebSockets(socketTag) as HibernatingSocket[]) socket.close(code, reason); }
  private json(value: unknown): Response { return new Response(JSON.stringify(value), { headers: { "content-type": "application/json; charset=utf-8" } }); }
  private error(code: string, message: string, status: number): Response { return new Response(JSON.stringify({ error: { code, message } }), { headers: { "content-type": "application/json; charset=utf-8" }, status }); }
}

function rows<T>(cursor: Iterable<unknown>): T[] { return [...cursor] as T[]; }
function iso(value: number): string { return new Date(value).toISOString(); }
function sameInput(message: StoredMessage, input: MessageInput): boolean { return message.content === input.content && message.author === input.author && message.display_name === input.display_name && message.client === (input.client ?? null) && message.semantic_type === input.semantic_type && message.reply_to === (input.reply_to ?? null) && message.client_message_id === (input.client_message_id ?? null); }
function resolveRoomLimits(env: ConversationRoomEnv): RoomLimits {
  if (env.MSG_TEST_MODE === undefined && env.MSG_TEST_ROOM_LIMITS === undefined) return ROOM_LIMITS;
  if (env.MSG_TEST_MODE !== "1" || !env.MSG_TEST_ROOM_LIMITS) throw new Error("Test room limits require explicit test mode.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.MSG_TEST_ROOM_LIMITS);
  } catch {
    throw new Error("Test room limits must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Test room limits must be an object.");
  const limits = { ...ROOM_LIMITS } as RoomLimits;
  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in ROOM_LIMITS) || typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > ROOM_LIMITS[key as keyof typeof ROOM_LIMITS]) {
      throw new Error("Test room limits are invalid.");
    }
    limits[key as keyof typeof ROOM_LIMITS] = value;
  }
  return limits;
}
async function hashToken(token: string): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)); let value = ""; for (const byte of new Uint8Array(digest)) value += String.fromCharCode(byte); return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, ""); }
