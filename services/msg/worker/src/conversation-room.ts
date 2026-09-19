import { DurableObject } from "cloudflare:workers";

import { createPlatformClient } from "@0000/platform-client";

import { ERROR_CODES, ProtocolError } from "./errors";
import { compareCapabilities, messageStorageBytes, ROOM_LIMITS } from "./room-domain";
import type { MessageInput } from "./room-domain";
import { PROTOCOL_VERSION } from "./protocol";
import { CURRENT_ROOM_SCHEMA_VERSION, migrateRoomSchema } from "./room-schema";

export interface ConversationRoomEnv {
  readonly MSG_AUTH_REQUIRED?: string;
  readonly MSG_PLATFORM_AUTHORITY?: string;
  readonly MSG_PLATFORM_AUDIENCE?: string;
  readonly MSG_PLATFORM_BASE_URL?: string;
  readonly MSG_PLATFORM_SERVICE_VERIFIER?: string;
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
  readonly creation_guest_id: string | null;
  readonly owner_guest_id: string | null;
  readonly owner_organization_id: string | null;
  readonly owner_subject_id: string | null;
  readonly links_revoked: number;
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

interface ClaimReceipt {
  readonly idempotency_key: string;
  readonly request_digest: string;
  readonly original_guest_id: string;
  readonly claimant_subject_id: string;
  readonly organization_id: string;
  readonly revoke_links: number;
  readonly claimed_at: number;
}

type HibernatingSocket = WebSocket & {
  deserializeAttachment(): unknown;
  serializeAttachment(value: unknown): void;
};

type CredentialVerification = "valid" | "invalid" | "forbidden" | "unavailable";
interface ClaimCredentialVerification { readonly status: CredentialVerification; readonly subjectId?: string; readonly organizationId?: string; }

interface SocketContext {
  readonly kind: "guest" | "organization";
  readonly credential?: string;
  readonly guestId?: string;
  readonly subjectId?: string;
  readonly organizationId?: string;
  readonly resource: string;
  readonly source: "owner" | "public" | "management" | "organization";
  readonly after: number;
}

type RequestAuth =
  | { readonly kind: "guest"; readonly credential?: string; readonly guestId: string; readonly source: "owner" | "public" | "management" }
  | { readonly kind: "organization"; readonly credential: string; readonly subjectId?: string; readonly organizationId?: string; readonly source: "organization" }
  | { readonly kind: "claim"; readonly credential: string; readonly guestId: string; readonly subjectId?: string; readonly organizationId?: string; readonly source: "claim" };

const socketTag = "conversation-live";

/** SQLite is the durable source of truth. HTTP is only the worker-to-room boundary. */
export class ConversationRoom extends DurableObject<ConversationRoomEnv> {
  private readonly config: ConversationRoomEnv;
  private readonly limits: RoomLimits;
  private readonly socketCredentials = new Map<WebSocket, string>();
  private readonly socketContexts = new Map<WebSocket, SocketContext>();

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
      if (request.method === "POST" && url.pathname === "/access/proof") return await this.accessProof(request);
      if (request.method === "POST" && url.pathname === "/access/record") return await this.accessRecord(request);
      if (request.method === "POST" && url.pathname === "/access/check") return await this.accessCheck(request);
      if (request.method === "POST" && url.pathname === "/access/grant") return await this.accessGrant(request);
      if (request.method === "POST" && url.pathname === "/claim") return await this.claim(request);
      if (request.method === "GET" && url.pathname === "/read") return await this.read(request);
      if (request.method === "POST" && url.pathname === "/messages") return await this.post(request);
      if (request.method === "GET" && url.pathname === "/manage") return await this.manage(request, false);
      if (request.method === "DELETE" && url.pathname === "/manage") return await this.manage(request, true);
      if (request.method === "GET" && url.pathname === "/live") return await this.live(request);
      if (request.method === "GET" && (url.pathname === "/export.md" || url.pathname === "/export.json")) return await this.export(request, url.pathname === "/export.json");
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
    this.socketCredentials.delete(socket);
    this.socketContexts.delete(socket);
    socket.close(1008, "This socket is read-only");
  }

  async webSocketClose(socket?: WebSocket): Promise<void> {
    if (socket) {
      this.socketCredentials.delete(socket);
      this.socketContexts.delete(socket);
    }
  }

  private async initialize(request: Request): Promise<Response> {
    const input = await request.json() as { initial: MessageInput; management_hash: string; owner_guest_id?: string };
    const now = this.now();
    const result = this.ctx.storage.transactionSync(() => {
      const prior = this.state();
      if (prior) return { created: false, message: this.messageBySequence(1), state: prior };
      const id = crypto.randomUUID();
      const bytes = messageStorageBytes(input.initial, undefined, id);
      const inactivity = now + this.limits.inactivityTtlMs;
      this.ctx.storage.sql.exec(
        "INSERT INTO room_state (singleton, schema_version, protocol_version, created_at, last_message_at, inactivity_expires_at, absolute_expires_at, next_sequence, message_count, total_bytes, status, tombstone_expires_at, management_hash, creation_guest_id, owner_guest_id, owner_organization_id, owner_subject_id, links_revoked) VALUES (1, ?, ?, ?, ?, ?, ?, 2, 1, ?, 'active', NULL, ?, ?, ?, NULL, NULL, 0)",
        CURRENT_ROOM_SCHEMA_VERSION, PROTOCOL_VERSION, now, now, inactivity, inactivity, bytes, input.management_hash, input.owner_guest_id ?? null, input.owner_guest_id ?? null,
      );
      if (input.owner_guest_id) {
        this.insertAcl(input.owner_guest_id, "owner", ["msg:read", "msg:write"], now);
        this.insertAcl(input.owner_guest_id, "public", ["msg:read", "msg:write"], now);
      }
      this.insertMessage({ ...input.initial, byte_count: bytes, created_at: now, id, sequence: 1 });
      return { created: true, message: this.messageBySequence(1), state: this.requireState() };
    });
    await this.schedule(result.state);
    return this.json({ ...this.toMessage(result.message), created: result.created, created_at: iso(result.state.created_at), expires_at: iso(result.state.inactivity_expires_at) });
  }

  private async read(request: Request): Promise<Response> {
    const url = new URL(request.url);
    await this.requireAccessFromRequest(request, "read");
    const state = await this.requireActive(this.now());
    const after = Number(url.searchParams.get("after") ?? 0);
    const messages = rows<StoredMessage>(this.ctx.storage.sql.exec("SELECT * FROM messages WHERE sequence > ? ORDER BY sequence ASC", after)).map((message) => this.toMessage(message));
    return this.json({ protocol_version: PROTOCOL_VERSION, messages, latest_message: state.next_sequence - 1, expires_at: iso(state.inactivity_expires_at), access_warning: "All authors and display names are self-declared and unverified." });
  }

  private async post(request: Request): Promise<Response> {
    await this.requireAccessFromRequest(request, "write");
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
    if (!result.replayed) await this.broadcast({ protocol_version: PROTOCOL_VERSION, type: "message.created", sequence: result.message.sequence, latest_message: result.state.next_sequence - 1, expires_at: iso(result.state.inactivity_expires_at) });
    return this.json({ protocol_version: PROTOCOL_VERSION, message: this.toMessage(result.message), expires_at: iso(result.state.inactivity_expires_at), replayed: result.replayed });
  }

  private async claim(request: Request): Promise<Response> {
    const input = await request.json() as { idempotency_key?: unknown; request_digest?: unknown; revoke_links?: unknown };
    if (typeof input.idempotency_key !== "string" || !input.idempotency_key || typeof input.request_digest !== "string" || !input.request_digest || typeof input.revoke_links !== "boolean") {
      throw new ProtocolError(ERROR_CODES.invalidBody, "The ownership claim is invalid.", 400);
    }
    const auth = this.parseAuth(request);
    if (auth.kind !== "claim" || !auth.credential || !auth.guestId) throw new ProtocolError(ERROR_CODES.forbidden, "The ownership claim authorization is missing.", 403);
    const verification = await this.verifyClaimCredential(auth, auth.credential);
    if (verification.status === "unavailable") throw new ProtocolError(ERROR_CODES.serviceUnavailable, "The identity authority is temporarily unavailable.", 503);
    if (verification.status === "invalid") throw new ProtocolError(ERROR_CODES.invalidBody, "The ownership claim credential is invalid.", 401);
    if (verification.status !== "valid" || !verification.subjectId || !verification.organizationId) throw new ProtocolError(ERROR_CODES.forbidden, "The ownership claim is not authorized.", 403);
    const claimantSubjectId = verification.subjectId;
    const organizationId = verification.organizationId;
    const now = this.now();
    const result = this.ctx.storage.transactionSync(() => {
      const state = this.requireState();
      if (state.status !== "active") throw new ProtocolError(ERROR_CODES.gone, "The conversation has expired.", 410);
      const receipt = rows<ClaimReceipt>(this.ctx.storage.sql.exec("SELECT * FROM claim_receipts WHERE idempotency_key = ?", input.idempotency_key))[0];
      if (receipt) {
        if (receipt.request_digest !== input.request_digest || receipt.original_guest_id !== auth.guestId || receipt.claimant_subject_id !== claimantSubjectId || receipt.organization_id !== organizationId || receipt.revoke_links !== (input.revoke_links ? 1 : 0)) {
          throw new ProtocolError(ERROR_CODES.conflict, "The ownership claim key is already used for another claim.", 409);
        }
        return { claimedAt: receipt.claimed_at, organizationId: receipt.organization_id, revokeLinks: receipt.revoke_links === 1 };
      }
      if (state.owner_guest_id !== auth.guestId || state.owner_organization_id !== null) {
        throw new ProtocolError(ERROR_CODES.forbidden, "The room is not owned by the controlled guest.", 403);
      }
      const owner = rows<{ active: number; capabilities: string }>(this.ctx.storage.sql.exec("SELECT active, capabilities FROM room_acl WHERE guest_id = ? AND source = 'owner'", auth.guestId))[0];
      if (!owner || owner.active !== 1 || !parseCapabilities(owner.capabilities).includes("msg:read") || !parseCapabilities(owner.capabilities).includes("msg:write")) {
        throw new ProtocolError(ERROR_CODES.forbidden, "The room owner permission is no longer valid.", 403);
      }
      this.ctx.storage.sql.exec(
        "UPDATE room_state SET owner_guest_id = NULL, owner_organization_id = ?, owner_subject_id = ?, management_hash = NULL, links_revoked = ? WHERE singleton = 1 AND owner_guest_id = ? AND owner_organization_id IS NULL",
        organizationId, claimantSubjectId, input.revoke_links ? 1 : 0, auth.guestId,
      );
      this.ctx.storage.sql.exec("UPDATE room_acl SET active = 0 WHERE guest_id = ? AND source IN ('owner', 'management')", auth.guestId);
      if (input.revoke_links) this.ctx.storage.sql.exec("UPDATE room_acl SET active = 0 WHERE source = 'public'");
      this.ctx.storage.sql.exec(
        "INSERT INTO claim_receipts (idempotency_key, request_digest, original_guest_id, claimant_subject_id, organization_id, revoke_links, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        input.idempotency_key, input.request_digest, auth.guestId, claimantSubjectId, organizationId, input.revoke_links ? 1 : 0, now,
      );
      return { claimedAt: now, organizationId, revokeLinks: input.revoke_links };
    });
    return this.json({ protocol_version: PROTOCOL_VERSION, room: new URL(request.url).searchParams.get("resource") ?? "", organization_id: result.organizationId, claimed_at: iso(result.claimedAt), revoke_links: result.revokeLinks });
  }

  private async manage(request: Request, deleteRoom: boolean): Promise<Response> {
    const auth = this.parseAuth(request);
    await this.requireAccess(auth, "manage", new URL(request.url).searchParams.get("resource") ?? "");
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const state = this.state();
    if (auth.kind !== "organization" && (!state || !state.management_hash || !compareCapabilities(await hashToken(token), state.management_hash))) {
      throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404);
    }
    if (deleteRoom) {
      await this.expire(this.now(), "Conversation deleted");
      const deleted = this.requireState();
      await this.schedule(deleted);
      return this.json({ protocol_version: PROTOCOL_VERSION, deleted: true, expires_at: iso(deleted.tombstone_expires_at!) });
    }
    if (!state) throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404);
    return this.json({ protocol_version: PROTOCOL_VERSION, expires_at: iso(state.inactivity_expires_at) });
  }

  /** This path is reachable only from the Worker-to-Durable-Object service boundary. */
  private async operatorDelete(): Promise<Response> {
    await this.expire(this.now(), "Conversation deleted by an operator");
    const state = this.requireState();
    await this.schedule(state);
    return this.json({ protocol_version: PROTOCOL_VERSION, deleted: true });
  }

  private async live(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const auth = this.parseAuth(request);
    if (auth.kind === "claim") throw new ProtocolError(ERROR_CODES.forbidden, "Ownership claim credentials cannot open a live room socket.", 403);
    await this.requireAccess(auth, "read", url.searchParams.get("resource") ?? "");
    const state = await this.requireActive(this.now());
    const sockets = this.liveSockets();
    if (sockets.length >= this.limits.maxSockets) throw new ProtocolError(ERROR_CODES.serviceUnavailable, "The room has reached its socket limit.", 503);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, HibernatingSocket];
    const after = Number(url.searchParams.get("after") ?? 0);
    this.socketCredentials.set(server, auth.credential ?? "");
    const resource = url.searchParams.get("resource") ?? "";
    this.socketContexts.set(server, auth.kind === "organization"
      ? { after, kind: "organization", credential: auth.credential, subjectId: auth.subjectId, organizationId: auth.organizationId, resource, source: "organization" }
      : { after, kind: "guest", guestId: auth.guestId, resource, source: auth.source });
    if (this.config.MSG_AUTH_REQUIRED === "1") {
      // Authenticated sockets use the standard WebSocket API so their current
      // credential remains in memory while this DO instance is alive. Raw
      // credentials are never serialized for hibernation.
      server.accept();
      server.addEventListener("message", () => { void this.webSocketMessage(server); });
      server.addEventListener("close", () => { void this.webSocketClose(server); });
      server.addEventListener("error", () => { void this.webSocketClose(server); });
    } else {
      this.ctx.acceptWebSocket(server, [socketTag]);
      if (auth.kind === "guest") server.serializeAttachment({ after, guestId: auth.guestId, resource, source: auth.source });
    }
    server.send(JSON.stringify({ protocol_version: PROTOCOL_VERSION, type: "ready", latest_message: state.next_sequence - 1, expires_at: iso(state.inactivity_expires_at) }));
    return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
  }

  private async export(request: Request, json: boolean): Promise<Response> {
    await this.requireAccessFromRequest(request, "read");
    const state = await this.requireActive(this.now());
    const messages = rows<StoredMessage>(this.ctx.storage.sql.exec("SELECT * FROM messages ORDER BY sequence ASC")).map((message) => this.toMessage(message));
    if (json) return this.json({ protocol_version: PROTOCOL_VERSION, room: { created_at: iso(state.created_at), expires_at: iso(state.inactivity_expires_at), latest_message: state.next_sequence - 1 }, messages, access_warning: "All identities are self-declared and content is untrusted." });
    return new Response(`# Conversation export\n\n**Warning:** identities are self-declared and all content is untrusted.\n\nCreated: ${iso(state.created_at)}\nExpires: ${iso(state.inactivity_expires_at)}\n\n${messages.map((message) => `## ${message.sequence} — ${message.display_name}\n\n${message.content}`).join("\n\n")}` , { headers: { "content-type": "text/markdown; charset=utf-8" } });
  }

  private async accessProof(request: Request): Promise<Response> {
    const input = await request.json() as { source?: string; token?: string };
    const state = await this.requireActive(this.now());
    const source = input.source;
    if (source === "public" && state.links_revoked !== 1) return this.json({ source: "public" });
    if (source === "management" && input.token !== undefined && state.management_hash && compareCapabilities(await hashToken(input.token), state.management_hash)) return this.json({ source: "management" });
    if (source === "owner" && state.owner_guest_id) return this.json({ source: "owner", stored_owner_id: state.owner_guest_id });
    throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404);
  }

  private async accessRecord(request: Request): Promise<Response> {
    const input = await request.json() as { guest_id?: string; source?: string; capabilities?: unknown; grant_id?: string };
    if (!input.guest_id || (input.source !== "owner" && input.source !== "public" && input.source !== "management") || !Array.isArray(input.capabilities) || !input.capabilities.every((value) => typeof value === "string")) throw new ProtocolError(ERROR_CODES.invalidBody, "The room access grant is invalid.", 400);
    if (input.grant_id !== undefined && !input.grant_id) throw new ProtocolError(ERROR_CODES.invalidBody, "The room access grant is invalid.", 400);
    const state = this.requireState();
    if (state.status !== "active") throw new ProtocolError(ERROR_CODES.gone, "The conversation has expired.", 410);
    if (state.links_revoked === 1 && (input.source === "public" || input.source === "management")) throw new ProtocolError(ERROR_CODES.forbidden, "Room links are no longer admitted.", 403);
    if (input.source === "management" && !state.management_hash) throw new ProtocolError(ERROR_CODES.forbidden, "The management link is no longer admitted.", 403);
    if (input.source === "owner" && state.owner_guest_id !== input.guest_id) throw new ProtocolError(ERROR_CODES.forbidden, "The room owner is invalid.", 403);
    this.ctx.storage.transactionSync(() => this.insertAcl(input.guest_id!, input.source as SocketContext["source"], input.capabilities as string[], this.now(), input.grant_id));
    return this.json({ recorded: true });
  }

  private async accessCheck(request: Request): Promise<Response> {
    const input = await request.json() as { guest_id?: string; source?: string; action?: string; grant_id?: string };
    if (!input.guest_id || (input.source !== "owner" && input.source !== "public" && input.source !== "management") || (input.action !== "read" && input.action !== "write" && input.action !== "manage")) throw new ProtocolError(ERROR_CODES.invalidBody, "The room access check is invalid.", 400);
    if (input.grant_id !== undefined && !input.grant_id) throw new ProtocolError(ERROR_CODES.invalidBody, "The room access check is invalid.", 400);
    await this.requireActive(this.now());
    return this.json({ allowed: this.hasGrant(input.guest_id, input.source as SocketContext["source"], input.action as "read" | "write" | "manage", input.grant_id) });
  }

  private async accessGrant(request: Request): Promise<Response> {
    const input = await request.json() as { guest_id?: string; source?: string; grant_id?: string };
    if (!input.guest_id || input.source !== undefined && input.source !== "owner" && input.source !== "public" && input.source !== "management" || input.grant_id !== undefined && !input.grant_id) throw new ProtocolError(ERROR_CODES.invalidBody, "The room access lookup is invalid.", 400);
    await this.requireActive(this.now());
    const conditions = ["guest_id = ?"];
    const values: unknown[] = [input.guest_id];
    if (input.source !== undefined) { conditions.push("source = ?"); values.push(input.source); }
    if (input.grant_id !== undefined) { conditions.push("grant_id = ?"); values.push(input.grant_id); }
    const row = rows<{ source: SocketContext["source"]; grant_id: string | null; capabilities: string; active: number }>(this.ctx.storage.sql.exec(`SELECT source, grant_id, capabilities, active FROM room_acl WHERE ${conditions.join(" AND ")} LIMIT 1`, ...values))[0];
    if (!row) throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404);
    return this.json({ source: row.source, ...(row.grant_id ? { grant_id: row.grant_id } : {}), capabilities: parseCapabilities(row.capabilities), active: row.active === 1 });
  }

  private parseAuth(request: Request): RequestAuth {
    const kind = request.headers.get("x-msg-auth-kind");
    const authorization = request.headers.get("authorization");
    const credential = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
    if (kind === "organization") {
      if (!credential) throw new ProtocolError(ERROR_CODES.forbidden, "The organization authorization is missing.", 403);
      return { kind: "organization", credential, subjectId: request.headers.get("x-msg-subject-id") ?? undefined, organizationId: request.headers.get("x-msg-organization-id") ?? undefined, source: "organization" };
    }
    if (kind === "claim") {
      const guestId = request.headers.get("x-msg-guest-id") ?? "";
      if (!credential || !guestId) throw new ProtocolError(ERROR_CODES.forbidden, "The ownership claim authorization is missing.", 403);
      return { kind: "claim", credential, guestId, subjectId: request.headers.get("x-msg-subject-id") ?? undefined, organizationId: request.headers.get("x-msg-organization-id") ?? undefined, source: "claim" };
    }
    const guestId = request.headers.get("x-msg-guest-id") ?? "";
    const source = request.headers.get("x-msg-source");
    if (!guestId || (source !== "owner" && source !== "public" && source !== "management")) {
      if (this.config.MSG_AUTH_REQUIRED === "1") throw new ProtocolError(ERROR_CODES.forbidden, "The room authorization is missing.", 403);
      return { kind: "guest", guestId: "legacy", source: "public" };
    }
    if (this.config.MSG_AUTH_REQUIRED === "1" && !credential) throw new ProtocolError(ERROR_CODES.forbidden, "The room authorization is missing.", 403);
    return { kind: "guest", ...(credential ? { credential } : {}), guestId, source };
  }

  private async requireAccessFromRequest(request: Request, action: "read" | "write" | "manage"): Promise<void> {
    if (this.config.MSG_AUTH_REQUIRED !== "1") return;
    const auth = this.parseAuth(request);
    await this.requireAccess(auth, action, new URL(request.url).searchParams.get("resource") ?? "");
  }

  private async requireAccess(auth: RequestAuth | SocketContext, action: "read" | "write" | "manage", resource: string): Promise<void> {
    if (this.config.MSG_AUTH_REQUIRED !== "1") return;
    if (!auth.credential || !resource) throw new ProtocolError(ERROR_CODES.forbidden, "The room authorization is missing.", 403);
    await this.requireActive(this.now());
    const verification = await this.verifyCredential(auth, auth.credential, resource, action);
    if (verification === "unavailable") throw new ProtocolError(ERROR_CODES.serviceUnavailable, "The identity authority is temporarily unavailable.", 503);
    if (verification === "forbidden") throw new ProtocolError(ERROR_CODES.forbidden, "The room authorization is no longer valid.", 403);
    if (verification !== "valid") throw new ProtocolError(ERROR_CODES.invalidBody, "The room authorization is no longer valid.", 401);
  }

  private async verifyCredential(auth: RequestAuth | SocketContext, credential: string, resource: string, action: "read" | "write" | "manage"): Promise<CredentialVerification> {
    const baseUrl = this.config.MSG_PLATFORM_BASE_URL;
    const authority = this.config.MSG_PLATFORM_AUTHORITY;
    const audience = this.config.MSG_PLATFORM_AUDIENCE;
    const verifier = this.config.MSG_PLATFORM_SERVICE_VERIFIER;
    if (!baseUrl || !authority || !audience || !verifier) return "unavailable";
    const authentication = await createPlatformClient({ baseUrl, authority, audience, serviceVerifier: verifier }).authenticate(credential);
    if (authentication.status === "authority_unavailable") return "unavailable";
    const capability = action === "read" ? "msg:read" : action === "write" ? "msg:write" : "msg:manage";
    if (authentication.status !== "authenticated") return "invalid";
    const principal = authentication.principal;
    if (auth.kind === "organization") {
      const state = this.state();
      if (principal.kind === "guest") return "forbidden";
      if (state?.owner_organization_id !== principal.organizationId) return "forbidden";
      return principal.capabilities.includes(capability) ? "valid" : "forbidden";
    }
    if (auth.kind === "claim") {
      if (principal.kind !== "human") return "forbidden";
      return principal.subjectId === auth.subjectId && principal.organizationId === auth.organizationId && principal.capabilities.includes("msg:claim") ? "valid" : "forbidden";
    }
    if (principal.kind !== "guest") return "invalid";
    return principal.subjectId === auth.guestId && principal.resourceIds.includes(resource) && principal.capabilities.includes(capability) && this.hasGrant(auth.guestId, auth.source, action, principal.grantId) ? "valid" : "invalid";
  }

  private async verifyClaimCredential(auth: RequestAuth, credential: string): Promise<ClaimCredentialVerification> {
    const baseUrl = this.config.MSG_PLATFORM_BASE_URL;
    const authority = this.config.MSG_PLATFORM_AUTHORITY;
    const audience = this.config.MSG_PLATFORM_AUDIENCE;
    const verifier = this.config.MSG_PLATFORM_SERVICE_VERIFIER;
    if (!baseUrl || !authority || !audience || !verifier) return { status: "unavailable" };
    const authentication = await createPlatformClient({ baseUrl, authority, audience, serviceVerifier: verifier }).authenticate(credential);
    if (authentication.status === "authority_unavailable") return { status: "unavailable" };
    if (authentication.status !== "authenticated") return { status: "invalid" };
    if (auth.kind !== "claim" || authentication.principal.kind !== "human") return { status: "forbidden" };
    if (!authentication.principal.capabilities.includes("msg:claim")) return { status: "forbidden" };
    return { status: "valid", subjectId: authentication.principal.subjectId, organizationId: authentication.principal.organizationId };
  }

  private attachmentContext(socket: HibernatingSocket): SocketContext | undefined {
    const value = socket.deserializeAttachment();
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.guestId !== "string" || typeof candidate.resource !== "string" || (candidate.source !== "owner" && candidate.source !== "public" && candidate.source !== "management") || typeof candidate.after !== "number") return undefined;
    return { kind: "guest", guestId: candidate.guestId, resource: candidate.resource, source: candidate.source, after: candidate.after };
  }

  private async verifySocket(context: SocketContext, credential: string): Promise<boolean> {
    // The Durable Object name is the room resource identifier. The raw bearer
    // stays in the volatile map and is never serialized as socket attachment.
    return (await this.verifyCredential({ ...context, credential }, credential, context.resource, "read")) === "valid";
  }

  private insertAcl(guestId: string, source: SocketContext["source"], capabilities: readonly string[], createdAt: number, grantId?: string): void {
    const prior = rows<{ capabilities: string }>(this.ctx.storage.sql.exec("SELECT capabilities FROM room_acl WHERE guest_id = ? AND source = ?", guestId, source))[0];
    const existing = prior ? parseCapabilities(prior.capabilities) : [];
    const merged = [...new Set([...existing, ...capabilities])];
    this.ctx.storage.sql.exec("INSERT INTO room_acl (guest_id, source, capabilities, active, created_at, grant_id) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(guest_id, source) DO UPDATE SET capabilities = excluded.capabilities, active = 1, grant_id = COALESCE(excluded.grant_id, room_acl.grant_id)", guestId, source, JSON.stringify(merged), createdAt, grantId ?? null);
  }

  private hasGrant(guestId: string, source: SocketContext["source"], action: "read" | "write" | "manage", grantId?: string): boolean {
    const state = this.state();
    if (state?.links_revoked === 1 && (source === "public" || source === "management")) return false;
    const required = action === "read" ? "msg:read" : action === "write" ? "msg:write" : "msg:manage";
    const sources = source === "public" ? ["public", "owner"] : [source];
    return sources.some((candidate) => {
      const row = rows<{ capabilities: string; active: number; grant_id: string | null }>(this.ctx.storage.sql.exec("SELECT capabilities, active, grant_id FROM room_acl WHERE guest_id = ? AND source = ?", guestId, candidate))[0];
      return row?.active === 1 && (!grantId || row.grant_id === grantId) && parseCapabilities(row.capabilities).includes(required);
    });
  }

  private deleteToTombstone(now: number): boolean {
    return this.ctx.storage.transactionSync(() => {
      const state = this.requireState();
      if (state.status === "deleted") return false;
      this.ctx.storage.sql.exec("DELETE FROM messages");
      this.ctx.storage.sql.exec("DELETE FROM room_acl");
      this.ctx.storage.sql.exec("DELETE FROM claim_receipts");
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
  private async expire(now: number, reason: string): Promise<void> { if (!this.deleteToTombstone(now)) return; const state = this.requireState(); await this.broadcast({ protocol_version: PROTOCOL_VERSION, type: "conversation.expired" }); this.closeSockets(1001, reason); await this.schedule(state); }
  private async schedule(state: RoomState): Promise<void> { const at = state.status === "deleted" ? state.tombstone_expires_at : state.inactivity_expires_at; if (at === null || at === undefined) await this.ctx.storage.deleteAlarm(); else await this.ctx.storage.setAlarm(at); }
  private async broadcast(frame: unknown): Promise<void> { const payload = JSON.stringify(frame); for (const socket of this.liveSockets()) { if (this.config.MSG_AUTH_REQUIRED !== "1") { socket.send(payload); continue; } const context = this.socketContexts.get(socket) ?? this.attachmentContext(socket); const credential = this.socketCredentials.get(socket); if (!context || !credential || !(await this.verifySocket(context, credential))) { socket.close(1008, "The live authorization is no longer valid"); continue; } socket.send(payload); } }
  private closeSockets(code: number, reason: string): void { for (const socket of this.liveSockets()) { this.socketCredentials.delete(socket); this.socketContexts.delete(socket); socket.close(code, reason); } }
  private liveSockets(): WebSocket[] { return [...new Set([...this.ctx.getWebSockets(socketTag), ...this.socketContexts.keys()])]; }
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
function parseCapabilities(value: string): string[] { try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : []; } catch { return []; } }
