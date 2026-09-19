import { DurableObject } from "cloudflare:workers";

import { createPlatformClient } from "@0000/platform-client";

import { ERROR_CODES, ProtocolError } from "./errors";
import { compareCapabilities, messageStorageBytes, ROOM_LIMITS } from "./room-domain";
import type { MessageInput } from "./room-domain";
import { PROTOCOL_VERSION, type CreateWebhookResponse, type ManageWebhookResponse, type RedeliverWebhookResponse, type RotateWebhookSecretResponse, type WebhookAttemptMetadata, type WebhookDeliveryMetadata, type WebhookSummary } from "./protocol";
import { CURRENT_ROOM_SCHEMA_VERSION, migrateRoomSchema } from "./room-schema";
import { discardWebhookResponseBody, generateWebhookSecret, normalizeWebhookUrl, redactWebhookUrl, signWebhookPayload, webhookRequestTarget } from "./webhooks";
import { createWebPushRequest } from "./web-push-crypto";
import { PUSH_DELIVERY_LEASE_MS, PUSH_DELIVERY_TIMEOUT_MS, PUSH_INITIAL_DELAY_MS, PUSH_RETRY_WINDOW_MS, pushRetryDelayMs } from "./push-policy";
import {
  WEBHOOK_FAILURE_WINDOW_MS,
  WEBHOOK_HISTORY_TTL_MS,
  WEBHOOK_INITIAL_DELAY_MS,
  WEBHOOK_RETRY_WINDOW_MS,
  webhookRetryDelayMs,
} from "./webhook-policy";

const MAX_WEBHOOKS_PER_ROOM = 5;
const WEBHOOK_REQUEST_TIMEOUT_MS = 5_000;
const WEBHOOK_DELIVERY_LEASE_MS = WEBHOOK_REQUEST_TIMEOUT_MS + 5_000;
const WEBHOOK_HISTORY_LIMIT = 50;

export interface ConversationRoomEnv {
  readonly MSG_AUTH_REQUIRED?: string;
  readonly MSG_PLATFORM_AUTHORITY?: string;
  readonly MSG_PLATFORM_AUDIENCE?: string;
  readonly MSG_PLATFORM_BASE_URL?: string;
  readonly MSG_PLATFORM_SERVICE_VERIFIER?: string;
  readonly MSG_PUBLIC_ORIGIN?: string;
  readonly MSG_POST_DISABLED?: string;
  readonly MSG_TEST_MODE?: string;
  readonly MSG_TEST_NOW_MS?: string;
  readonly MSG_TEST_ROOM_LIMITS?: string;
  readonly MSG_VAPID_PRIVATE_KEY?: string;
  readonly MSG_VAPID_PUBLIC_KEY?: string;
  readonly MSG_VAPID_SUBJECT?: string;
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
  readonly notification_id: string;
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
  readonly source_browser_id: string | null;
}

interface StoredPushSubscription {
  readonly auth: string;
  readonly created_at: number;
  readonly endpoint: string;
  readonly id: string;
  readonly p256dh: string;
  readonly source_browser_id: string;
}

interface StoredPushDelivery {
  readonly attempt_count: number;
  readonly attempted_at: number | null;
  readonly completed_at: number | null;
  readonly created_at: number;
  readonly due_at: number;
  readonly event_id: string;
  readonly failure_category: string | null;
  readonly id: string;
  readonly lease_expires_at: number | null;
  readonly message_id: string;
  readonly message_sequence: number;
  readonly retry_expires_at: number;
  readonly status: "delivered" | "failed" | "pending" | "retrying" | "sending";
  readonly subscription_id: string;
}

interface StoredWebhookEndpoint {
  readonly created_at: number;
  readonly disabled_at: number | null;
  readonly failure_started_at: number | null;
  readonly id: string;
  readonly last_failure_at: number | null;
  readonly last_success_at: number | null;
  readonly recovered_at: number | null;
  readonly secret: string;
  readonly status: "active" | "disabled";
  readonly url: string;
}

interface StoredWebhookDelivery {
  readonly attempt_count: number;
  readonly attempted_at: number | null;
  readonly cancelled_at: number | null;
  readonly completed_at: number | null;
  readonly created_at: number;
  readonly due_at: number;
  readonly endpoint_id: string;
  readonly event_id: string;
  readonly failure_category: string | null;
  readonly id: string;
  readonly lease_expires_at: number | null;
  readonly manual_redelivery_requested_at: number | null;
  readonly message_id: string;
  readonly message_sequence: number;
  readonly retry_expires_at: number;
  readonly status: "cancelled" | "delivered" | "failed" | "pending" | "retrying" | "sending";
}

interface StoredWebhookAttempt {
  readonly attempt_number: number;
  readonly attempted_at: number;
  readonly completed_at: number | null;
  readonly delivery_id: string;
  readonly failure_category: string | null;
  readonly status: "delivered" | "failed" | "sending";
}

interface ClaimedWebhookDelivery {
  readonly delivery: StoredWebhookDelivery;
  readonly endpoint: StoredWebhookEndpoint;
  readonly message: StoredMessage;
  readonly previousDelivery: StoredWebhookDelivery;
  readonly manualRedelivery: boolean;
  readonly roomId: string;
}

interface ClaimedPushDelivery {
  readonly delivery: StoredPushDelivery;
  readonly message: StoredMessage;
  readonly subscription: StoredPushSubscription;
}

interface DeferredSignal {
  readonly promise: Promise<void>;
  resolve(): void;
}

interface TestPushSendGate {
  readonly entered: DeferredSignal;
  readonly released: DeferredSignal;
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

type ResourceRequestAuth =
  | { readonly kind: "guest"; readonly credential?: string; readonly guestId: string; readonly source: "owner" | "public" | "management" }
  | { readonly kind: "organization"; readonly credential: string; readonly source: "organization" };
type ClaimRequestAuth = { readonly kind: "claim"; readonly credential: string; readonly guestId: string; readonly source: "claim" };
type RequestAuth = ResourceRequestAuth | ClaimRequestAuth;

const socketTag = "conversation-live";

/** SQLite is the durable source of truth. HTTP is only the worker-to-room boundary. */
export class ConversationRoom extends DurableObject<ConversationRoomEnv> {
  private readonly config: ConversationRoomEnv;
  private readonly limits: RoomLimits;
  private readonly socketCredentials = new Map<WebSocket, string>();
  private readonly socketContexts = new Map<WebSocket, SocketContext>();
  private readonly now: () => number;
  private readonly signWebhook: typeof signWebhookPayload;
  private testNowOverride: number | undefined;
  private scheduleRevision = 0;
  private scheduledRevision = 0;
  private schedulePromise: Promise<void> | undefined;
  private testPushSendGate: TestPushSendGate | undefined;

  constructor(ctx: DurableObjectState, env: ConversationRoomEnv, now?: () => number, signWebhook: typeof signWebhookPayload = signWebhookPayload) {
    super(ctx, env);
    this.config = env;
    this.limits = resolveRoomLimits(env);
    this.now = now ?? (() => this.testNowOverride ?? resolveNow(env));
    this.signWebhook = signWebhook;
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
      if (request.method === "POST" && url.pathname === "/messages") return await this.post(request);
      if (request.method === "POST" && url.pathname === "/webhooks") return await this.createWebhook(request);
      if (request.method === "GET" && url.pathname === "/webhooks") return await this.listWebhooks(request);
      if (request.method === "POST" && url.pathname === "/push-subscriptions") return await this.enrollPush(request);
      if (request.method === "GET" && url.pathname === "/push-subscriptions") return await this.readPushEnrollment(request);
      if (request.method === "DELETE" && url.pathname === "/push-subscriptions") return await this.removePushEnrollment(request);
      const webhookActionMatch = /^\/webhooks\/([0-9a-f-]{36})\/(disable|enable|rotate-secret)$/iu.exec(url.pathname);
      if (request.method === "POST" && webhookActionMatch) {
        if (webhookActionMatch[2] === "rotate-secret") return await this.rotateWebhookSecret(request, webhookActionMatch[1]!);
        return await this.setWebhookEnabled(request, webhookActionMatch[1]!, webhookActionMatch[2] === "enable");
      }
      const redeliveryMatch = /^\/webhooks\/([0-9a-f-]{36})\/deliveries\/([0-9a-f-]{36})\/redeliver$/iu.exec(url.pathname);
      if (request.method === "POST" && redeliveryMatch) return await this.redeliverWebhook(request, redeliveryMatch[1]!, redeliveryMatch[2]!);
      const webhookMatch = /^\/webhooks\/([0-9a-f-]{36})$/iu.exec(url.pathname);
      if (request.method === "DELETE" && webhookMatch) return await this.removeWebhook(request, webhookMatch[1]!);
      if (this.config.MSG_TEST_MODE === "1" && request.method === "POST" && url.pathname === "/__test/mark-webhook-sending") return await this.testMarkWebhookSending(request);
      if (this.config.MSG_TEST_MODE === "1" && request.method === "POST" && url.pathname === "/__test/delete-webhook-source") return await this.testDeleteWebhookSource(request);
      if (this.config.MSG_TEST_MODE === "1" && request.method === "POST" && url.pathname === "/__test/push-send-gate") return await this.testPushSendGateControl(request);
      if (this.config.MSG_TEST_MODE === "1" && request.method === "POST" && url.pathname === "/__test/run-alarm") {
        await this.alarm();
        return this.json({ triggered: true });
      }
      if (request.method === "GET" && url.pathname === "/read") return await this.read(request);
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
          this.ctx.storage.sql.exec("DELETE FROM webhook_delivery_attempts");
          this.ctx.storage.sql.exec("DELETE FROM webhook_deliveries");
          this.ctx.storage.sql.exec("DELETE FROM webhook_endpoints");
          this.ctx.storage.sql.exec("DELETE FROM push_deliveries");
          this.ctx.storage.sql.exec("DELETE FROM push_subscriptions");
          this.ctx.storage.sql.exec("DELETE FROM room_state");
        });
        await this.ctx.storage.deleteAlarm();
      } else await this.schedule();
      return;
    }
    if (now >= state.inactivity_expires_at) {
      await this.expire(now, "Conversation expired");
      return;
    }
    this.finishExpiredWebhookRetries(now);
    this.recoverExpiredWebhookLeases(now);
    this.disableUnhealthyWebhooks(now);
    this.pruneWebhookHistory(now);
    this.recoverExpiredPushLeases(now);
    this.prunePushDeliveries(now);
    for (let batch = 0; batch < MAX_WEBHOOKS_PER_ROOM; batch += 1) {
      const attemptNow = this.now();
      this.finishExpiredWebhookRetries(attemptNow);
      this.recoverExpiredWebhookLeases(attemptNow);
      this.disableUnhealthyWebhooks(attemptNow);
      const claimed = this.claimDueWebhookDelivery(attemptNow);
      if (!claimed) break;
      await this.deliverWebhook(claimed);
      const current = this.state();
      if (!current || current.status === "deleted") return;
      if (this.now() >= current.inactivity_expires_at) {
        await this.expire(this.now(), "Conversation expired");
        return;
      }
    }
    for (let batch = 0; batch < MAX_WEBHOOKS_PER_ROOM * 2; batch += 1) {
      const attemptNow = this.now();
      this.recoverExpiredPushLeases(attemptNow);
      this.prunePushDeliveries(attemptNow);
      const claimed = this.claimDuePushDelivery(attemptNow);
      if (!claimed) break;
      await this.deliverPush(claimed);
      const current = this.state();
      if (!current || current.status === "deleted") return;
      if (this.now() >= current.inactivity_expires_at) {
        await this.expire(this.now(), "Conversation expired");
        return;
      }
    }
    await this.schedule();
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
      const notificationId = crypto.randomUUID();
      const bytes = messageStorageBytes(input.initial, undefined, id);
      const inactivity = now + this.limits.inactivityTtlMs;
      this.ctx.storage.sql.exec(
        "INSERT INTO room_state (singleton, schema_version, protocol_version, created_at, last_message_at, inactivity_expires_at, absolute_expires_at, next_sequence, message_count, total_bytes, status, tombstone_expires_at, management_hash, creation_guest_id, owner_guest_id, owner_organization_id, owner_subject_id, links_revoked, notification_id) VALUES (1, ?, ?, ?, ?, ?, ?, 2, 1, ?, 'active', NULL, ?, ?, ?, NULL, NULL, 0, ?)",
        CURRENT_ROOM_SCHEMA_VERSION, PROTOCOL_VERSION, now, now, inactivity, inactivity, bytes, input.management_hash, input.owner_guest_id ?? null, input.owner_guest_id ?? null, notificationId,
      );
      if (input.owner_guest_id) {
        this.insertAcl(input.owner_guest_id, "owner", ["msg:read", "msg:write"], now);
        this.insertAcl(input.owner_guest_id, "public", ["msg:read", "msg:write"], now);
      }
      this.insertMessage({ ...input.initial, byte_count: bytes, created_at: now, id, sequence: 1, source_browser_id: null });
      // The creation guest receives both owner and public capabilities so that
      // the first browser request can use the same durable participant grant.
      return { created: true, message: this.messageBySequence(1), state: this.requireState() };
    });
    await this.schedule();
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
    const input = await request.json() as { browser_id?: string; input: MessageInput; idempotency_key?: string };
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
      const message: StoredMessage = { ...input.input, ...(key ? { idempotency_key: key } : {}), byte_count: bytes, created_at: now, id, sequence: state.next_sequence, source_browser_id: input.browser_id ?? null };
      this.insertMessage(message);
      this.queueWebhookDeliveries(message, now);
      this.queuePushDeliveries(message, now);
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
      if (now >= state.inactivity_expires_at) return { expired: true as const };
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
      this.ctx.storage.sql.exec("UPDATE room_acl SET active = 0 WHERE source = 'management' OR guest_id = ? AND source = 'owner'", auth.guestId);
      if (input.revoke_links) this.ctx.storage.sql.exec("UPDATE room_acl SET active = 0 WHERE source = 'public'");
      this.ctx.storage.sql.exec(
        "INSERT INTO claim_receipts (idempotency_key, request_digest, original_guest_id, claimant_subject_id, organization_id, revoke_links, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        input.idempotency_key, input.request_digest, auth.guestId, claimantSubjectId, organizationId, input.revoke_links ? 1 : 0, now,
      );
      return { claimedAt: now, organizationId, revokeLinks: input.revoke_links };
    });
    if (result.expired) {
      await this.expire(now, "Conversation expired");
      throw new ProtocolError(ERROR_CODES.gone, "The conversation has expired.", 410);
    }
    return this.json({ protocol_version: PROTOCOL_VERSION, room: new URL(request.url).searchParams.get("resource") ?? "", organization_id: result.organizationId, claimed_at: iso(result.claimedAt), revoke_links: result.revokeLinks });
  }

  private async manage(request: Request, deleteRoom: boolean): Promise<Response> {
    const auth = this.parseResourceAuth(request);
    await this.requireAccess(auth, "manage", new URL(request.url).searchParams.get("resource") ?? "");
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const state = this.state();
    if (auth.kind !== "organization" && (!state || !state.management_hash || !compareCapabilities(await hashToken(token), state.management_hash))) {
      throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404);
    }
    if (deleteRoom) {
      await this.expire(this.now(), "Conversation deleted");
      const deleted = this.requireState();
      await this.schedule();
      return this.json({ protocol_version: PROTOCOL_VERSION, deleted: true, expires_at: iso(deleted.tombstone_expires_at!) });
    }
    if (!state) throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404);
    return this.json({ protocol_version: PROTOCOL_VERSION, expires_at: iso(state.inactivity_expires_at) });
  }

  private async createWebhook(request: Request): Promise<Response> {
    await this.requireAccessFromRequest(request, "write");
    const input: unknown = await request.json();
    if (!isRecord(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, "url")) {
      throw new ProtocolError(ERROR_CODES.invalidBody, "The webhook request must contain only url.", 400);
    }
    const url = normalizeWebhookUrl(input.url);
    if (!url) throw new ProtocolError(ERROR_CODES.invalidBody, "The webhook destination must be a valid public HTTPS URL.", 400);
    const now = this.now();
    const id = crypto.randomUUID();
    const secret = generateWebhookSecret();
    const result = this.ctx.storage.transactionSync(() => {
      const state = this.requireState();
      if (state.status !== "active" || now >= state.inactivity_expires_at) return { kind: "expired" as const };
      const count = rows<{ count: number }>(this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM webhook_endpoints"))[0]?.count ?? 0;
      if (count >= MAX_WEBHOOKS_PER_ROOM) return { kind: "limit" as const };
      this.ctx.storage.sql.exec(
        "INSERT INTO webhook_endpoints (id, url, secret, created_at, status, failure_started_at, last_success_at, last_failure_at, recovered_at, disabled_at) VALUES (?, ?, ?, ?, 'active', NULL, NULL, NULL, NULL, NULL)",
        id, url, secret, now,
      );
      return { kind: "created" as const };
    });
    if (result.kind === "expired") {
      await this.expire(now, "Conversation expired");
      throw new ProtocolError(ERROR_CODES.gone, "The conversation has expired.", 410);
    }
    if (result.kind === "limit") throw new ProtocolError(ERROR_CODES.conflict, "A room can have at most five webhook endpoints.", 409);
    await this.schedule();
    const webhook = this.webhookSummary({
      created_at: now,
      disabled_at: null,
      failure_started_at: null,
      id,
      last_failure_at: null,
      last_success_at: null,
      recovered_at: null,
      secret,
      status: "active",
      url,
    }, now);
    const response: CreateWebhookResponse = { protocol_version: PROTOCOL_VERSION, secret, webhook };
    return this.json(response);
  }

  private async listWebhooks(request: Request): Promise<Response> {
    await this.requireAccessFromRequest(request, "read");
    const now = this.now();
    await this.requireActive(now);
    this.finishExpiredWebhookRetries(now);
    this.recoverExpiredWebhookLeases(now);
    this.disableUnhealthyWebhooks(now);
    this.pruneWebhookHistory(now);
    const endpoints = rows<StoredWebhookEndpoint>(this.ctx.storage.sql.exec("SELECT * FROM webhook_endpoints ORDER BY created_at ASC, id ASC"));
    const webhooks = endpoints.map((endpoint) => this.webhookSummary(endpoint, now));
    await this.schedule();
    return this.json({ protocol_version: PROTOCOL_VERSION, webhooks });
  }

  private async readPushEnrollment(request: Request): Promise<Response> {
    await this.requireAccessFromRequest(request, "read");
    const browserId = request.headers.get("x-msg-browser-id");
    if (!browserId) throw new ProtocolError(ERROR_CODES.invalidBody, "A browser identifier is required.", 400);
    await this.requireActive(this.now());
    const subscription = rows<{ id: string }>(this.ctx.storage.sql.exec(
      "SELECT id FROM push_subscriptions WHERE source_browser_id = ?",
      browserId,
    ))[0];
    return this.json({ protocol_version: PROTOCOL_VERSION, enrolled: subscription !== undefined });
  }

  private async enrollPush(request: Request): Promise<Response> {
    await this.requireAccessFromRequest(request, "write");
    const input: unknown = await request.json();
    if (!isRecord(input) || typeof input.browser_id !== "string" || !isRecord(input.subscription)
      || typeof input.subscription.endpoint !== "string" || typeof input.subscription.p256dh !== "string" || typeof input.subscription.auth !== "string") {
      throw new ProtocolError(ERROR_CODES.invalidBody, "The browser push enrollment is invalid.", 400);
    }
    const { browser_id: browserId, subscription } = input;
    const now = this.now();
    const result = this.ctx.storage.transactionSync(() => {
      const state = this.requireState();
      if (state.status !== "active" || now >= state.inactivity_expires_at) return "expired" as const;
      const byBrowser = rows<StoredPushSubscription>(this.ctx.storage.sql.exec(
        "SELECT * FROM push_subscriptions WHERE source_browser_id = ?",
        browserId,
      ))[0];
      const byEndpoint = rows<StoredPushSubscription>(this.ctx.storage.sql.exec(
        "SELECT * FROM push_subscriptions WHERE endpoint = ?",
        subscription.endpoint,
      ))[0];
      let existing = byBrowser ?? byEndpoint;
      if (byBrowser && byEndpoint && byBrowser.id !== byEndpoint.id) {
        this.deletePushSubscription(byBrowser.id);
        existing = byEndpoint;
      }
      if (existing) {
        this.ctx.storage.sql.exec(
          "UPDATE push_subscriptions SET source_browser_id = ?, endpoint = ?, p256dh = ?, auth = ? WHERE id = ?",
          browserId, subscription.endpoint, subscription.p256dh, subscription.auth, existing.id,
        );
      } else {
        this.ctx.storage.sql.exec(
          "INSERT INTO push_subscriptions (id, source_browser_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          crypto.randomUUID(), browserId, subscription.endpoint, subscription.p256dh, subscription.auth, now,
        );
      }
      return "enrolled" as const;
    });
    if (result === "expired") {
      await this.expire(now, "Conversation expired");
      throw new ProtocolError(ERROR_CODES.gone, "The conversation has expired.", 410);
    }
    await this.schedule();
    return this.json({ protocol_version: PROTOCOL_VERSION, enrolled: true });
  }

  private async removePushEnrollment(request: Request): Promise<Response> {
    await this.requireAccessFromRequest(request, "write");
    const browserId = request.headers.get("x-msg-browser-id");
    if (!browserId) throw new ProtocolError(ERROR_CODES.invalidBody, "A browser identifier is required.", 400);
    const now = this.now();
    const result = this.ctx.storage.transactionSync(() => {
      const state = this.requireState();
      if (state.status !== "active" || now >= state.inactivity_expires_at) return "expired" as const;
      const subscription = rows<{ id: string }>(this.ctx.storage.sql.exec(
        "SELECT id FROM push_subscriptions WHERE source_browser_id = ?",
        browserId,
      ))[0];
      if (!subscription) return false;
      this.deletePushSubscription(subscription.id);
      return true;
    });
    if (result === "expired") {
      await this.expire(now, "Conversation expired");
      throw new ProtocolError(ERROR_CODES.gone, "The conversation has expired.", 410);
    }
    await this.schedule();
    return this.json({ protocol_version: PROTOCOL_VERSION, removed: result });
  }

  private deletePushSubscription(id: string): void {
    this.ctx.storage.sql.exec("DELETE FROM push_deliveries WHERE subscription_id = ?", id);
    this.ctx.storage.sql.exec("DELETE FROM push_subscriptions WHERE id = ?", id);
  }

  private async removeWebhook(request: Request, id: string): Promise<Response> {
    await this.requireAccessFromRequest(request, "write");
    const now = this.now();
    const result = this.ctx.storage.transactionSync(() => {
      const state = this.requireState();
      if (state.status !== "active" || now >= state.inactivity_expires_at) return "expired" as const;
      const endpoint = rows<{ id: string }>(this.ctx.storage.sql.exec("SELECT id FROM webhook_endpoints WHERE id = ?", id))[0];
      if (!endpoint) return "missing" as const;
      this.ctx.storage.sql.exec(
        "DELETE FROM webhook_delivery_attempts WHERE delivery_id IN (SELECT id FROM webhook_deliveries WHERE endpoint_id = ?)",
        id,
      );
      this.ctx.storage.sql.exec("DELETE FROM webhook_deliveries WHERE endpoint_id = ?", id);
      this.ctx.storage.sql.exec("DELETE FROM webhook_endpoints WHERE id = ?", id);
      return "removed" as const;
    });
    if (result === "expired") {
      await this.expire(now, "Conversation expired");
      throw new ProtocolError(ERROR_CODES.gone, "The conversation has expired.", 410);
    }
    if (result === "missing") throw new ProtocolError(ERROR_CODES.notFound, "The webhook was not found.", 404);
    await this.schedule();
    return this.json({ protocol_version: PROTOCOL_VERSION, removed: true });
  }

  private async setWebhookEnabled(request: Request, id: string, enabled: boolean): Promise<Response> {
    await this.requireAccessFromRequest(request, "write");
    const now = this.now();
    const result = this.ctx.storage.transactionSync(() => {
      const state = this.state();
      if (!state) return { kind: "missing-room" as const };
      if (state.status !== "active" || now >= state.inactivity_expires_at) return { kind: "expired" as const };
      const endpoint = rows<StoredWebhookEndpoint>(this.ctx.storage.sql.exec("SELECT * FROM webhook_endpoints WHERE id = ?", id))[0];
      if (!endpoint) return { kind: "missing-endpoint" as const };
      if (enabled) {
        if (endpoint.status === "disabled") {
          this.ctx.storage.sql.exec(
            "UPDATE webhook_endpoints SET status = 'active', disabled_at = NULL, failure_started_at = NULL WHERE id = ?",
            id,
          );
        }
      } else {
        if (endpoint.status === "active") {
          this.ctx.storage.sql.exec("UPDATE webhook_endpoints SET status = 'disabled', disabled_at = ? WHERE id = ?", now, id);
        }
        this.ctx.storage.sql.exec(
          "UPDATE webhook_deliveries SET status = CASE WHEN manual_redelivery_requested_at IS NULL THEN 'cancelled' ELSE 'failed' END, cancelled_at = CASE WHEN manual_redelivery_requested_at IS NULL THEN COALESCE(cancelled_at, ?) ELSE NULL END, completed_at = COALESCE(completed_at, ?), lease_expires_at = NULL, manual_redelivery_requested_at = NULL WHERE endpoint_id = ? AND status IN ('pending', 'retrying')",
          now, now, id,
        );
        this.ctx.storage.sql.exec(
          "UPDATE webhook_deliveries SET cancelled_at = COALESCE(cancelled_at, ?) WHERE endpoint_id = ? AND status = 'sending'",
          now, id,
        );
      }
      const updated = rows<StoredWebhookEndpoint>(this.ctx.storage.sql.exec("SELECT * FROM webhook_endpoints WHERE id = ?", id))[0];
      if (!updated) throw new Error("The webhook disappeared during a room-scoped update.");
      return { kind: "updated" as const, endpoint: updated };
    });
    if (result.kind === "missing-room") throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404);
    if (result.kind === "expired") {
      await this.expire(now, "Conversation expired");
      throw new ProtocolError(ERROR_CODES.gone, "The conversation has expired.", 410);
    }
    if (result.kind === "missing-endpoint") throw new ProtocolError(ERROR_CODES.notFound, "The webhook was not found.", 404);
    await this.schedule();
    const response: ManageWebhookResponse = { protocol_version: PROTOCOL_VERSION, webhook: this.webhookSummary(result.endpoint, now) };
    return this.json(response);
  }

  private async rotateWebhookSecret(request: Request, id: string): Promise<Response> {
    await this.requireAccessFromRequest(request, "write");
    const now = this.now();
    const secret = generateWebhookSecret();
    const result = this.ctx.storage.transactionSync(() => {
      const state = this.state();
      if (!state) return { kind: "missing-room" as const };
      if (state.status !== "active" || now >= state.inactivity_expires_at) return { kind: "expired" as const };
      const endpoint = rows<StoredWebhookEndpoint>(this.ctx.storage.sql.exec("SELECT * FROM webhook_endpoints WHERE id = ?", id))[0];
      if (!endpoint) return { kind: "missing-endpoint" as const };
      this.ctx.storage.sql.exec("UPDATE webhook_endpoints SET secret = ? WHERE id = ?", secret, id);
      const updated = rows<StoredWebhookEndpoint>(this.ctx.storage.sql.exec("SELECT * FROM webhook_endpoints WHERE id = ?", id))[0];
      if (!updated) throw new Error("The webhook disappeared during secret rotation.");
      return { kind: "rotated" as const, endpoint: updated };
    });
    if (result.kind === "missing-room") throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404);
    if (result.kind === "expired") {
      await this.expire(now, "Conversation expired");
      throw new ProtocolError(ERROR_CODES.gone, "The conversation has expired.", 410);
    }
    if (result.kind === "missing-endpoint") throw new ProtocolError(ERROR_CODES.notFound, "The webhook was not found.", 404);
    await this.schedule();
    const response: RotateWebhookSecretResponse = {
      protocol_version: PROTOCOL_VERSION,
      secret,
      webhook: this.webhookSummary(result.endpoint, now),
    };
    return this.json(response);
  }

  private async redeliverWebhook(request: Request, endpointId: string, eventId: string): Promise<Response> {
    await this.requireAccessFromRequest(request, "write");
    const now = this.now();
    const result = this.ctx.storage.transactionSync(() => {
      const state = this.state();
      if (!state) return { kind: "missing-room" as const };
      if (state.status !== "active" || now >= state.inactivity_expires_at) return { kind: "expired" as const };
      const endpoint = rows<StoredWebhookEndpoint>(this.ctx.storage.sql.exec("SELECT id FROM webhook_endpoints WHERE id = ?", endpointId))[0];
      if (!endpoint) return { kind: "unavailable" as const };
      const delivery = rows<StoredWebhookDelivery>(this.ctx.storage.sql.exec(
        "SELECT * FROM webhook_deliveries WHERE endpoint_id = ? AND event_id = ?",
        endpointId,
        eventId,
      ))[0];
      if (!delivery || delivery.created_at <= now - WEBHOOK_HISTORY_TTL_MS) return { kind: "unavailable" as const };
      const message = rows<StoredMessage>(this.ctx.storage.sql.exec("SELECT id FROM messages WHERE id = ?", delivery.message_id))[0];
      if (!message) return { kind: "unavailable" as const };
      if (delivery.manual_redelivery_requested_at !== null && (delivery.status === "pending" || delivery.status === "sending")) {
        return { kind: "already-queued" as const, delivery };
      }
      if (delivery.status !== "failed") return { kind: "not-failed" as const };
      this.ctx.storage.sql.exec(
        "UPDATE webhook_deliveries SET status = 'pending', due_at = ?, lease_expires_at = NULL, cancelled_at = NULL, manual_redelivery_requested_at = ? WHERE id = ? AND status = 'failed' AND manual_redelivery_requested_at IS NULL",
        now,
        now,
        delivery.id,
      );
      const queued = rows<StoredWebhookDelivery>(this.ctx.storage.sql.exec("SELECT * FROM webhook_deliveries WHERE id = ?", delivery.id))[0];
      if (!queued) throw new Error("The failed webhook delivery disappeared during redelivery.");
      return { kind: "queued" as const, delivery: queued };
    });
    if (result.kind === "missing-room") throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404);
    if (result.kind === "expired") {
      await this.expire(now, "Conversation expired");
      throw new ProtocolError(ERROR_CODES.gone, "The conversation has expired.", 410);
    }
    if (result.kind === "unavailable") throw new ProtocolError(ERROR_CODES.notFound, "The failed webhook delivery is no longer available for redelivery.", 404);
    if (result.kind === "not-failed") throw new ProtocolError(ERROR_CODES.conflict, "Only a retained failed webhook delivery can be redelivered.", 409);
    await this.schedule();
    const response: RedeliverWebhookResponse = {
      delivery: this.webhookDeliveryMetadata(result.delivery),
      protocol_version: PROTOCOL_VERSION,
      result: result.kind === "already-queued" ? "already_queued" : "queued",
    };
    return this.json(response);
  }

  private async testPushSendGateControl(request: Request): Promise<Response> {
    const input: unknown = await request.json();
    if (!isRecord(input) || (input.action !== "arm" && input.action !== "wait" && input.action !== "release" && input.action !== "advance")) {
      throw new ProtocolError(ERROR_CODES.invalidBody, "The test push gate action is invalid.", 400);
    }
    if (input.action === "advance" && (typeof input.now_ms !== "number" || !Number.isSafeInteger(input.now_ms))) {
      throw new ProtocolError(ERROR_CODES.invalidBody, "The test clock value is invalid.", 400);
    }
    if (input.action !== "advance" && input.now_ms !== undefined) {
      throw new ProtocolError(ERROR_CODES.invalidBody, "The test push gate action does not accept a clock value.", 400);
    }
    if (input.action === "arm") {
      if (this.testPushSendGate) throw new ProtocolError(ERROR_CODES.conflict, "The test push gate is already armed.", 409);
      this.testPushSendGate = { entered: createDeferredSignal(), released: createDeferredSignal() };
      return this.json({ armed: true });
    }
    const gate = this.testPushSendGate;
    if (!gate) throw new ProtocolError(ERROR_CODES.notFound, "The test push gate is not armed.", 404);
    if (input.action === "advance") {
      const now = input.now_ms as number;
      if (now < this.now()) throw new ProtocolError(ERROR_CODES.invalidBody, "The test clock cannot move backwards.", 400);
      this.testNowOverride = now;
      return this.json({ advanced: true });
    }
    if (input.action === "wait") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let entered: boolean;
      try {
        entered = await Promise.race([
          gate.entered.promise.then(() => true),
          new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 5_000); }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (!entered) throw new ProtocolError(ERROR_CODES.serviceUnavailable, "The test push gate was not reached.", 503);
      return this.json({ entered: true });
    }
    this.testPushSendGate = undefined;
    gate.released.resolve();
    return this.json({ released: true });
  }

  private async waitForTestPushSendGate(): Promise<void> {
    const gate = this.testPushSendGate;
    if (!gate) return;
    gate.entered.resolve();
    await gate.released.promise;
  }

  private async testMarkWebhookSending(request: Request): Promise<Response> {
    const input: unknown = await request.json();
    if (!isRecord(input) || typeof input.event_id !== "string" || input.event_id.length === 0 || input.event_id.length > 128) {
      throw new ProtocolError(ERROR_CODES.invalidBody, "The test delivery identifier is invalid.", 400);
    }
    const now = this.now();
    const marked = this.ctx.storage.transactionSync(() => {
      const delivery = rows<StoredWebhookDelivery>(this.ctx.storage.sql.exec(
        "SELECT * FROM webhook_deliveries WHERE event_id = ? AND status IN ('pending', 'retrying') ORDER BY created_at ASC, id ASC LIMIT 1",
        input.event_id,
      ))[0];
      if (!delivery) return false;
      const attemptCount = delivery.attempt_count + 1;
      this.ctx.storage.sql.exec(
        "UPDATE webhook_deliveries SET status = 'sending', attempt_count = ?, attempted_at = ?, completed_at = NULL, lease_expires_at = ?, failure_category = NULL WHERE id = ?",
        attemptCount, now, now + WEBHOOK_DELIVERY_LEASE_MS, delivery.id,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO webhook_delivery_attempts (delivery_id, attempt_number, attempted_at, completed_at, status, failure_category) VALUES (?, ?, ?, NULL, 'sending', NULL)",
        delivery.id, attemptCount, now,
      );
      return true;
    });
    if (!marked) throw new ProtocolError(ERROR_CODES.notFound, "The pending test delivery was not found.", 404);
    await this.schedule();
    return this.json({ marked: true });
  }

  private async testDeleteWebhookSource(request: Request): Promise<Response> {
    const input: unknown = await request.json();
    if (!isRecord(input) || typeof input.message_id !== "string" || input.message_id.length === 0 || input.message_id.length > 128) {
      throw new ProtocolError(ERROR_CODES.invalidBody, "The test source message identifier is invalid.", 400);
    }
    const deleted = this.ctx.storage.transactionSync(() => {
      const message = rows<{ id: string }>(this.ctx.storage.sql.exec("SELECT id FROM messages WHERE id = ?", input.message_id))[0];
      if (!message) return false;
      this.ctx.storage.sql.exec("DELETE FROM messages WHERE id = ?", input.message_id);
      return true;
    });
    return this.json({ deleted });
  }

  /** This path is reachable only from the Worker-to-Durable-Object service boundary. */
  private async operatorDelete(): Promise<Response> {
    await this.expire(this.now(), "Conversation deleted by an operator");
    this.requireState();
    await this.schedule();
    return this.json({ protocol_version: PROTOCOL_VERSION, deleted: true });
  }

  private async live(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const auth = this.parseResourceAuth(request);
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
      ? { after, kind: "organization", credential: auth.credential, resource, source: "organization" }
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
      return { kind: "organization", credential, source: "organization" };
    }
    if (kind === "claim") {
      const guestId = request.headers.get("x-msg-guest-id") ?? "";
      if (!credential || !guestId) throw new ProtocolError(ERROR_CODES.forbidden, "The ownership claim authorization is missing.", 403);
      return { kind: "claim", credential, guestId, source: "claim" };
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

  private parseResourceAuth(request: Request): ResourceRequestAuth {
    const auth = this.parseAuth(request);
    if (auth.kind === "claim") throw new ProtocolError(ERROR_CODES.forbidden, "Ownership claim credentials cannot access a room resource.", 403);
    return auth;
  }

  private async requireAccessFromRequest(request: Request, action: "read" | "write" | "manage"): Promise<void> {
    if (this.config.MSG_AUTH_REQUIRED !== "1") return;
    const auth = this.parseResourceAuth(request);
    await this.requireAccess(auth, action, new URL(request.url).searchParams.get("resource") ?? "");
  }

  private async requireAccess(auth: ResourceRequestAuth | SocketContext, action: "read" | "write" | "manage", resource: string): Promise<void> {
    if (this.config.MSG_AUTH_REQUIRED !== "1") return;
    if (!auth.credential || !resource) throw new ProtocolError(ERROR_CODES.forbidden, "The room authorization is missing.", 403);
    await this.requireActive(this.now());
    const verification = await this.verifyCredential(auth, auth.credential, resource, action);
    if (verification === "unavailable") throw new ProtocolError(ERROR_CODES.serviceUnavailable, "The identity authority is temporarily unavailable.", 503);
    if (verification === "forbidden") throw new ProtocolError(ERROR_CODES.forbidden, "The room authorization is no longer valid.", 403);
    if (verification !== "valid") throw new ProtocolError(ERROR_CODES.invalidBody, "The room authorization is no longer valid.", 401);
  }

  private async verifyCredential(auth: ResourceRequestAuth | SocketContext, credential: string, resource: string, action: "read" | "write" | "manage"): Promise<CredentialVerification> {
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
    if (principal.kind !== "guest") return "invalid";
    return principal.subjectId === auth.guestId && principal.resourceIds.includes(resource) && principal.capabilities.includes(capability) && this.hasGrant(auth.guestId, auth.source, action, principal.grantId) ? "valid" : "invalid";
  }

  private async verifyClaimCredential(auth: ClaimRequestAuth, credential: string): Promise<ClaimCredentialVerification> {
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
      this.ctx.storage.sql.exec("DELETE FROM webhook_delivery_attempts");
      this.ctx.storage.sql.exec("DELETE FROM webhook_deliveries");
      this.ctx.storage.sql.exec("DELETE FROM webhook_endpoints");
      this.ctx.storage.sql.exec("DELETE FROM push_deliveries");
      this.ctx.storage.sql.exec("DELETE FROM push_subscriptions");
      this.ctx.storage.sql.exec("UPDATE room_state SET status = 'deleted', tombstone_expires_at = ?, management_hash = NULL, message_count = 0, total_bytes = 0 WHERE singleton = 1", now + this.limits.tombstoneTtlMs);
      return true;
    });
  }

  private queueWebhookDeliveries(message: StoredMessage, now: number): void {
    const endpoints = rows<{ id: string }>(this.ctx.storage.sql.exec("SELECT id FROM webhook_endpoints WHERE status = 'active'"));
    for (const endpoint of endpoints) {
      this.ctx.storage.sql.exec(
        "INSERT INTO webhook_deliveries (id, endpoint_id, event_id, message_id, message_sequence, created_at, due_at, retry_expires_at, attempted_at, completed_at, lease_expires_at, cancelled_at, status, attempt_count, failure_category) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'pending', 0, NULL)",
        crypto.randomUUID(), endpoint.id, message.id, message.id, message.sequence, now, now + WEBHOOK_INITIAL_DELAY_MS, now + WEBHOOK_RETRY_WINDOW_MS,
      );
    }
  }

  private queuePushDeliveries(message: StoredMessage, now: number): void {
    const subscriptions = rows<StoredPushSubscription>(this.ctx.storage.sql.exec("SELECT * FROM push_subscriptions ORDER BY created_at ASC, id ASC"));
    for (const subscription of subscriptions) {
      if (message.source_browser_id !== null && message.source_browser_id === subscription.source_browser_id) continue;
      this.ctx.storage.sql.exec(
        "DELETE FROM push_deliveries WHERE subscription_id = ? AND status IN ('pending', 'retrying')",
        subscription.id,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO push_deliveries (id, subscription_id, event_id, message_id, message_sequence, created_at, due_at, retry_expires_at, attempted_at, completed_at, lease_expires_at, status, attempt_count, failure_category) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'pending', 0, NULL)",
        crypto.randomUUID(), subscription.id, message.id, message.id, message.sequence, now, now + PUSH_INITIAL_DELAY_MS, now + PUSH_RETRY_WINDOW_MS,
      );
    }
  }

  private webhookSummary(endpoint: StoredWebhookEndpoint, now: number): WebhookSummary {
    const deliveries = rows<StoredWebhookDelivery>(this.ctx.storage.sql.exec(
      "SELECT * FROM webhook_deliveries WHERE endpoint_id = ? AND created_at > ? ORDER BY created_at DESC, id DESC LIMIT ?",
      endpoint.id, now - WEBHOOK_HISTORY_TTL_MS, WEBHOOK_HISTORY_LIMIT,
    )).map((delivery) => this.webhookDeliveryMetadata(delivery));
    return {
      id: endpoint.id,
      url: redactWebhookUrl(endpoint.url),
      created_at: iso(endpoint.created_at),
      disabled_at: endpoint.disabled_at === null ? null : iso(endpoint.disabled_at),
      failure_started_at: endpoint.failure_started_at === null ? null : iso(endpoint.failure_started_at),
      last_failure_at: endpoint.last_failure_at === null ? null : iso(endpoint.last_failure_at),
      last_success_at: endpoint.last_success_at === null ? null : iso(endpoint.last_success_at),
      recovered_at: endpoint.recovered_at === null ? null : iso(endpoint.recovered_at),
      status: endpoint.status,
      deliveries,
    };
  }

  private webhookDeliveryMetadata(delivery: StoredWebhookDelivery): WebhookDeliveryMetadata {
    const attempts = rows<StoredWebhookAttempt>(this.ctx.storage.sql.exec(
      "SELECT * FROM webhook_delivery_attempts WHERE delivery_id = ? ORDER BY attempt_number ASC",
      delivery.id,
    )).map((attempt): WebhookAttemptMetadata => ({
      attempt_number: attempt.attempt_number,
      attempted_at: iso(attempt.attempted_at),
      completed_at: attempt.completed_at === null ? null : iso(attempt.completed_at),
      failure_category: attempt.failure_category,
      status: attempt.status,
    }));
    return {
      attempts,
      attempt_count: delivery.attempt_count,
      attempted_at: delivery.attempted_at === null ? null : iso(delivery.attempted_at),
      cancelled_at: delivery.status === "cancelled" && delivery.cancelled_at !== null ? iso(delivery.cancelled_at) : null,
      completed_at: delivery.completed_at === null ? null : iso(delivery.completed_at),
      created_at: iso(delivery.created_at),
      event_id: delivery.event_id,
      failure_category: delivery.failure_category,
      message_id: delivery.message_id,
      message_sequence: delivery.message_sequence,
      next_attempt_at: delivery.status === "pending" || delivery.status === "retrying" ? iso(delivery.due_at) : null,
      retry_expires_at: iso(delivery.retry_expires_at),
      status: delivery.status,
    };
  }

  private pruneWebhookHistory(now: number): void {
    const expiredAt = now - WEBHOOK_HISTORY_TTL_MS;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM webhook_delivery_attempts WHERE delivery_id IN (SELECT id FROM webhook_deliveries WHERE created_at <= ?)",
        expiredAt,
      );
      this.ctx.storage.sql.exec("DELETE FROM webhook_deliveries WHERE created_at <= ?", expiredAt);
      this.ctx.storage.sql.exec(
        "UPDATE webhook_endpoints SET failure_started_at = CASE WHEN failure_started_at <= ? THEN NULL ELSE failure_started_at END, last_success_at = CASE WHEN last_success_at <= ? THEN NULL ELSE last_success_at END, last_failure_at = CASE WHEN last_failure_at <= ? THEN NULL ELSE last_failure_at END, recovered_at = CASE WHEN recovered_at <= ? THEN NULL ELSE recovered_at END, disabled_at = CASE WHEN disabled_at <= ? THEN NULL ELSE disabled_at END",
        expiredAt, expiredAt, expiredAt, expiredAt, expiredAt,
      );
    });
  }

  private finishExpiredWebhookRetries(now: number): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE webhook_deliveries SET status = 'failed', completed_at = retry_expires_at, lease_expires_at = NULL WHERE status IN ('pending', 'retrying') AND retry_expires_at <= ? AND manual_redelivery_requested_at IS NULL",
        now,
      );
    });
  }

  private recoverExpiredWebhookLeases(now: number): void {
    this.ctx.storage.transactionSync(() => {
      const expired = rows<StoredWebhookDelivery>(this.ctx.storage.sql.exec(
        "SELECT * FROM webhook_deliveries WHERE status = 'sending' AND lease_expires_at <= ? ORDER BY lease_expires_at ASC LIMIT ?",
        now, MAX_WEBHOOKS_PER_ROOM,
      ));
      for (const delivery of expired) {
        const endpoint = rows<StoredWebhookEndpoint>(this.ctx.storage.sql.exec(
          "SELECT * FROM webhook_endpoints WHERE id = ?",
          delivery.endpoint_id,
        ))[0];
        if (!endpoint) {
          this.ctx.storage.sql.exec("DELETE FROM webhook_delivery_attempts WHERE delivery_id = ?", delivery.id);
          this.ctx.storage.sql.exec("DELETE FROM webhook_deliveries WHERE id = ?", delivery.id);
          continue;
        }
        if (delivery.manual_redelivery_requested_at !== null) {
          this.ctx.storage.sql.exec(
            "UPDATE webhook_delivery_attempts SET status = 'failed', completed_at = ?, failure_category = 'timeout' WHERE delivery_id = ? AND attempt_number = ? AND status = 'sending'",
            now, delivery.id, delivery.attempt_count,
          );
          this.ctx.storage.sql.exec(
            "UPDATE webhook_endpoints SET last_failure_at = ?, failure_started_at = CASE WHEN status = 'active' THEN COALESCE(failure_started_at, ?) ELSE failure_started_at END WHERE id = ?",
            now, now, endpoint.id,
          );
          this.ctx.storage.sql.exec(
            "UPDATE webhook_deliveries SET status = 'failed', completed_at = ?, lease_expires_at = NULL, failure_category = 'timeout', manual_redelivery_requested_at = NULL WHERE id = ?",
            now, delivery.id,
          );
          continue;
        }
        if (delivery.retry_expires_at <= now) {
          this.ctx.storage.sql.exec(
            "UPDATE webhook_delivery_attempts SET status = 'failed', completed_at = ?, failure_category = 'retry_window_expired' WHERE delivery_id = ? AND attempt_number = ? AND status = 'sending'",
            delivery.retry_expires_at, delivery.id, delivery.attempt_count,
          );
          this.ctx.storage.sql.exec(
            "UPDATE webhook_deliveries SET status = 'failed', completed_at = retry_expires_at, lease_expires_at = NULL, failure_category = 'retry_window_expired' WHERE id = ?",
            delivery.id,
          );
          continue;
        }
        this.ctx.storage.sql.exec(
          "UPDATE webhook_delivery_attempts SET status = 'failed', completed_at = ?, failure_category = 'timeout' WHERE delivery_id = ? AND attempt_number = ? AND status = 'sending'",
          now, delivery.id, delivery.attempt_count,
        );
        this.ctx.storage.sql.exec(
          "UPDATE webhook_endpoints SET last_failure_at = ?, failure_started_at = CASE WHEN status = 'active' THEN COALESCE(failure_started_at, ?) ELSE failure_started_at END WHERE id = ?",
          now, now, endpoint.id,
        );
        if (delivery.cancelled_at !== null) {
          this.ctx.storage.sql.exec(
            "UPDATE webhook_deliveries SET status = 'cancelled', completed_at = ?, lease_expires_at = NULL, cancelled_at = ?, failure_category = 'timeout' WHERE id = ?",
            now, delivery.cancelled_at, delivery.id,
          );
          continue;
        }
        const retryAt = now + webhookRetryDelayMs(delivery.attempt_count);
        if (endpoint.status === "active" && retryAt < delivery.retry_expires_at) {
          this.ctx.storage.sql.exec(
            "UPDATE webhook_deliveries SET status = 'retrying', due_at = ?, completed_at = ?, lease_expires_at = NULL, failure_category = 'timeout' WHERE id = ?",
            retryAt, now, delivery.id,
          );
        } else if (endpoint.status === "disabled") {
          this.ctx.storage.sql.exec(
            "UPDATE webhook_deliveries SET status = 'cancelled', completed_at = ?, lease_expires_at = NULL, cancelled_at = COALESCE(?, ?) , failure_category = 'timeout' WHERE id = ?",
            now, endpoint.disabled_at, now, delivery.id,
          );
        } else {
          this.ctx.storage.sql.exec(
            "UPDATE webhook_deliveries SET status = 'failed', completed_at = ?, lease_expires_at = NULL, failure_category = 'timeout' WHERE id = ?",
            now, delivery.id,
          );
        }
      }
    });
  }

  private disableUnhealthyWebhooks(now: number): void {
    this.ctx.storage.transactionSync(() => {
      const unhealthy = rows<StoredWebhookEndpoint>(this.ctx.storage.sql.exec(
        "SELECT * FROM webhook_endpoints WHERE status = 'active' AND failure_started_at IS NOT NULL AND failure_started_at + ? <= ?",
        WEBHOOK_FAILURE_WINDOW_MS, now,
      ));
      for (const endpoint of unhealthy) {
        this.ctx.storage.sql.exec("UPDATE webhook_endpoints SET status = 'disabled', disabled_at = ? WHERE id = ? AND status = 'active'", now, endpoint.id);
        this.ctx.storage.sql.exec(
          "UPDATE webhook_deliveries SET status = 'cancelled', cancelled_at = ?, completed_at = COALESCE(completed_at, ?) WHERE endpoint_id = ? AND status IN ('pending', 'retrying') AND manual_redelivery_requested_at IS NULL",
          now, now,
          endpoint.id,
        );
        this.ctx.storage.sql.exec(
          "UPDATE webhook_deliveries SET cancelled_at = COALESCE(cancelled_at, ?) WHERE endpoint_id = ? AND status = 'sending' AND manual_redelivery_requested_at IS NULL",
          now, endpoint.id,
        );
      }
    });
  }

  private claimDueWebhookDelivery(now: number): ClaimedWebhookDelivery | undefined {
    return this.ctx.storage.transactionSync(() => {
      const state = this.state();
      if (!state || state.status !== "active" || now >= state.inactivity_expires_at) return undefined;
      const delivery = rows<StoredWebhookDelivery>(this.ctx.storage.sql.exec(
        "SELECT * FROM webhook_deliveries WHERE status IN ('pending', 'retrying') AND due_at <= ? AND (retry_expires_at > ? OR manual_redelivery_requested_at IS NOT NULL) ORDER BY due_at ASC, created_at ASC, id ASC LIMIT 1",
        now, now,
      ))[0];
      if (!delivery) return undefined;
      const manualRedelivery = delivery.manual_redelivery_requested_at !== null;
      const endpoint = rows<StoredWebhookEndpoint>(this.ctx.storage.sql.exec("SELECT * FROM webhook_endpoints WHERE id = ?", delivery.endpoint_id))[0];
      const message = rows<StoredMessage>(this.ctx.storage.sql.exec("SELECT * FROM messages WHERE id = ?", delivery.message_id))[0];
      if (!endpoint || !message) {
        this.ctx.storage.sql.exec("DELETE FROM webhook_delivery_attempts WHERE delivery_id = ?", delivery.id);
        this.ctx.storage.sql.exec("DELETE FROM webhook_deliveries WHERE id = ?", delivery.id);
        return undefined;
      }
      if (!manualRedelivery && (endpoint.status !== "active" || delivery.cancelled_at !== null)) {
        this.ctx.storage.sql.exec(
          "UPDATE webhook_deliveries SET status = 'cancelled', cancelled_at = COALESCE(?, ?) WHERE id = ?",
          delivery.cancelled_at ?? endpoint.disabled_at, now, delivery.id,
        );
        return undefined;
      }
      const attemptCount = delivery.attempt_count + 1;
      const leaseExpiresAt = now + WEBHOOK_DELIVERY_LEASE_MS;
      this.ctx.storage.sql.exec(
        "UPDATE webhook_deliveries SET status = 'sending', attempt_count = ?, attempted_at = ?, completed_at = NULL, lease_expires_at = ?, failure_category = NULL WHERE id = ?",
        attemptCount, now, leaseExpiresAt, delivery.id,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO webhook_delivery_attempts (delivery_id, attempt_number, attempted_at, completed_at, status, failure_category) VALUES (?, ?, ?, NULL, 'sending', NULL)",
        delivery.id, attemptCount, now,
      );
      return {
        delivery: { ...delivery, attempt_count: attemptCount, attempted_at: now, completed_at: null, lease_expires_at: leaseExpiresAt, status: "sending", failure_category: null },
        endpoint,
        message,
        previousDelivery: delivery,
        manualRedelivery,
        roomId: state.notification_id,
      };
    });
  }

  private async deliverWebhook(claimed: ClaimedWebhookDelivery): Promise<void> {
    const timestamp = String(Math.floor(this.now() / 1_000));
    const body = JSON.stringify({
      event_id: claimed.delivery.event_id,
      message: this.toMessage(claimed.message),
      protocol_version: PROTOCOL_VERSION,
      room_id: claimed.roomId,
      type: "message.created",
    });
    let status: "delivered" | "failed" = "failed";
    let failureCategory: string | null = "network_error";
    try {
      const target = webhookRequestTarget(claimed.endpoint.url);
      let signature: string | undefined;
      for (let checks = 0; checks < 8; checks += 1) {
        const secret = this.webhookClaimSecret(claimed, this.now());
        if (!secret) {
          await this.resolveWebhookClaimBeforeSend(claimed, this.now());
          return;
        }
        const candidate = await this.signWebhook(secret, timestamp, body);
        const sendAt = this.now();
        const currentSecret = this.webhookClaimSecret(claimed, sendAt);
        if (!currentSecret) {
          await this.resolveWebhookClaimBeforeSend(claimed, sendAt);
          return;
        }
        if (currentSecret === secret) {
          signature = candidate;
          break;
        }
      }
      if (!signature) {
        await this.resolveWebhookClaimBeforeSend(claimed, this.now(), true);
        return;
      }
      const headers = new Headers({
        "content-type": "application/json; charset=utf-8",
        "x-msg-signature": signature,
        "x-msg-timestamp": timestamp,
      });
      if (target.authorization) headers.set("authorization", target.authorization);
      const response = await fetch(target.url, {
        body,
        headers,
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(WEBHOOK_REQUEST_TIMEOUT_MS),
      });
      await discardWebhookResponseBody(response);
      if (response.status >= 200 && response.status < 300) {
        status = "delivered";
        failureCategory = null;
      } else failureCategory = response.status >= 300 && response.status < 400 ? "redirect" : "http_status";
    } catch (error) {
      failureCategory = error instanceof Error && /timeout/iu.test(error.name) ? "timeout" : "network_error";
    }

    const completedAt = this.now();
    const current = this.state();
    if (current?.status === "active" && completedAt >= current.inactivity_expires_at) {
      await this.expire(completedAt, "Conversation expired");
      return;
    }
    this.ctx.storage.transactionSync(() => {
      const state = this.state();
      const delivery = rows<StoredWebhookDelivery>(this.ctx.storage.sql.exec("SELECT * FROM webhook_deliveries WHERE id = ? AND status = 'sending' AND attempt_count = ?", claimed.delivery.id, claimed.delivery.attempt_count))[0];
      const endpoint = rows<StoredWebhookEndpoint>(this.ctx.storage.sql.exec("SELECT * FROM webhook_endpoints WHERE id = ?", claimed.endpoint.id))[0];
      if (!state || state.status !== "active" || !delivery || !endpoint) return;
      const retryAt = completedAt + webhookRetryDelayMs(delivery.attempt_count);
      const cancelledAutomaticAttempt = !claimed.manualRedelivery && (delivery.cancelled_at !== null || endpoint.status === "disabled");
      const canRetry = !claimed.manualRedelivery && status === "failed" && !cancelledAutomaticAttempt && endpoint.status === "active" && retryAt < delivery.retry_expires_at;
      const deliveryStatus = status === "delivered"
        ? "delivered"
        : claimed.manualRedelivery
          ? "failed"
          : cancelledAutomaticAttempt
          ? "cancelled"
          : canRetry ? "retrying" : "failed";
      const cancelledAt = deliveryStatus === "cancelled" ? delivery.cancelled_at ?? endpoint.disabled_at ?? completedAt : null;
      this.ctx.storage.sql.exec(
        "UPDATE webhook_delivery_attempts SET status = ?, completed_at = ?, failure_category = ? WHERE delivery_id = ? AND attempt_number = ?",
        status, completedAt, failureCategory, claimed.delivery.id, delivery.attempt_count,
      );
      this.ctx.storage.sql.exec(
        "UPDATE webhook_deliveries SET status = ?, due_at = ?, completed_at = ?, lease_expires_at = NULL, cancelled_at = ?, failure_category = ?, manual_redelivery_requested_at = NULL WHERE id = ?",
        deliveryStatus, canRetry ? retryAt : delivery.due_at, completedAt, cancelledAt, failureCategory, claimed.delivery.id,
      );
      if (status === "delivered") {
        this.ctx.storage.sql.exec(
          "UPDATE webhook_endpoints SET last_success_at = ?, recovered_at = CASE WHEN failure_started_at IS NOT NULL THEN ? ELSE recovered_at END, failure_started_at = NULL WHERE id = ?",
          completedAt, completedAt, endpoint.id,
        );
      } else {
        this.ctx.storage.sql.exec(
          "UPDATE webhook_endpoints SET last_failure_at = ?, failure_started_at = CASE WHEN status = 'active' THEN COALESCE(failure_started_at, ?) ELSE failure_started_at END WHERE id = ?",
          completedAt, completedAt, endpoint.id,
        );
      }
    });
    await this.schedule();
  }

  private claimDuePushDelivery(now: number): ClaimedPushDelivery | undefined {
    return this.ctx.storage.transactionSync(() => {
      const state = this.state();
      if (!state || state.status !== "active" || now >= state.inactivity_expires_at) return undefined;
      const delivery = rows<StoredPushDelivery>(this.ctx.storage.sql.exec(
        "SELECT * FROM push_deliveries WHERE status IN ('pending', 'retrying') AND due_at <= ? AND retry_expires_at > ? ORDER BY due_at ASC, created_at ASC, id ASC LIMIT 1",
        now, now,
      ))[0];
      if (!delivery) return undefined;
      const subscription = rows<StoredPushSubscription>(this.ctx.storage.sql.exec(
        "SELECT * FROM push_subscriptions WHERE id = ?",
        delivery.subscription_id,
      ))[0];
      const message = rows<StoredMessage>(this.ctx.storage.sql.exec("SELECT * FROM messages WHERE id = ?", delivery.message_id))[0];
      if (!subscription || !message) {
        this.ctx.storage.sql.exec("DELETE FROM push_deliveries WHERE id = ?", delivery.id);
        return undefined;
      }
      const attemptCount = delivery.attempt_count + 1;
      const leaseExpiresAt = now + PUSH_DELIVERY_LEASE_MS;
      this.ctx.storage.sql.exec(
        "UPDATE push_deliveries SET status = 'sending', attempt_count = ?, attempted_at = ?, completed_at = NULL, lease_expires_at = ?, failure_category = NULL WHERE id = ?",
        attemptCount, now, leaseExpiresAt, delivery.id,
      );
      return {
        delivery: { ...delivery, attempt_count: attemptCount, attempted_at: now, completed_at: null, lease_expires_at: leaseExpiresAt, status: "sending", failure_category: null },
        message,
        subscription,
      };
    });
  }

  private async deliverPush(claimed: ClaimedPushDelivery): Promise<void> {
    const startedAt = this.now();
    if (startedAt >= claimed.delivery.retry_expires_at) {
      this.ctx.storage.sql.exec("DELETE FROM push_deliveries WHERE id = ? AND status = 'sending' AND attempt_count = ?", claimed.delivery.id, claimed.delivery.attempt_count);
      await this.schedule();
      return;
    }
    const preparationTtlSeconds = Math.max(0, Math.floor((claimed.delivery.retry_expires_at - startedAt) / 1_000));
    let request: Awaited<ReturnType<typeof createWebPushRequest>>;
    let topic = "";
    try {
      const roomCapability = this.ctx.id.name;
      const publicOrigin = new URL(this.config.MSG_PUBLIC_ORIGIN ?? "https://msg.0000.chat").origin;
      if (!roomCapability || !this.config.MSG_VAPID_PUBLIC_KEY || !this.config.MSG_VAPID_PRIVATE_KEY || !this.config.MSG_VAPID_SUBJECT) {
        throw new Error("Browser push configuration is unavailable.");
      }
      const state = this.state();
      if (!state || state.status !== "active" || startedAt >= state.inactivity_expires_at || !this.pushClaimIsCurrent(claimed, startedAt)) {
        await this.resolvePushClaimBeforeSend(claimed, startedAt);
        return;
      }
      topic = state.notification_id.replaceAll("-", "");
      request = await createWebPushRequest({
        subscription: {
          auth: decodeBase64Url(claimed.subscription.auth),
          endpoint: claimed.subscription.endpoint,
          p256dh: decodeBase64Url(claimed.subscription.p256dh),
        },
        payload: JSON.stringify({
          type: "message.created",
          room_id: state.notification_id,
          room_url: `${publicOrigin}/${roomCapability}`,
        }),
        vapid: {
          publicKey: decodeBase64Url(this.config.MSG_VAPID_PUBLIC_KEY),
          privateKey: decodeBase64Url(this.config.MSG_VAPID_PRIVATE_KEY),
          subject: this.config.MSG_VAPID_SUBJECT,
        },
        ttlSeconds: preparationTtlSeconds,
        nowSeconds: Math.floor(startedAt / 1_000),
      });
      if (this.config.MSG_TEST_MODE === "1") await this.waitForTestPushSendGate();
    } catch {
      this.finishPushDelivery(claimed, this.now(), "configuration_error", false);
      await this.schedule();
      return;
    }

    const sendAt = this.now();
    if (sendAt >= claimed.delivery.retry_expires_at || !this.pushClaimIsCurrent(claimed, sendAt)) {
      await this.resolvePushClaimBeforeSend(claimed, sendAt);
      return;
    }
    const ttlSeconds = Math.max(0, Math.floor((claimed.delivery.retry_expires_at - sendAt) / 1_000));

    try {
      const response = await fetch(request.endpoint, {
        body: byteBuffer(request.body),
        headers: { ...request.headers, TTL: String(ttlSeconds), Topic: topic },
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(PUSH_DELIVERY_TIMEOUT_MS),
      });
      try { await response.body?.cancel(); } catch {}
      const completedAt = this.now();
      if (response.status >= 200 && response.status < 300) {
        this.finishPushDelivery(claimed, completedAt, null, false);
      } else if (response.status === 404 || response.status === 410) {
        this.removeInvalidPushSubscription(claimed);
      } else if (response.status === 429 || response.status >= 500) {
        this.finishPushDelivery(claimed, completedAt, "provider_unavailable", true);
      } else {
        this.finishPushDelivery(claimed, completedAt, "provider_rejected", false);
      }
    } catch {
      this.finishPushDelivery(claimed, this.now(), "provider_unavailable", true);
    }
    await this.schedule();
  }

  private pushClaimIsCurrent(claimed: ClaimedPushDelivery, now: number): boolean {
    const state = this.state();
    if (!state || state.status !== "active" || now >= state.inactivity_expires_at) return false;
    const delivery = rows<StoredPushDelivery>(this.ctx.storage.sql.exec(
      "SELECT * FROM push_deliveries WHERE id = ? AND status = 'sending' AND attempt_count = ?",
      claimed.delivery.id, claimed.delivery.attempt_count,
    ))[0];
    if (!delivery || now >= delivery.retry_expires_at) return false;
    const subscription = rows<{ id: string }>(this.ctx.storage.sql.exec(
      "SELECT id FROM push_subscriptions WHERE id = ? AND endpoint = ? AND p256dh = ? AND auth = ?",
      claimed.subscription.id, claimed.subscription.endpoint, claimed.subscription.p256dh, claimed.subscription.auth,
    ))[0];
    const message = rows<{ id: string }>(this.ctx.storage.sql.exec("SELECT id FROM messages WHERE id = ?", delivery.message_id))[0];
    return subscription !== undefined && message !== undefined && !this.hasNewerPushDelivery(delivery);
  }

  private hasNewerPushDelivery(delivery: Pick<StoredPushDelivery, "message_sequence" | "subscription_id">): boolean {
    return rows<{ id: string }>(this.ctx.storage.sql.exec(
      "SELECT id FROM push_deliveries WHERE subscription_id = ? AND message_sequence > ? LIMIT 1",
      delivery.subscription_id, delivery.message_sequence,
    )).length > 0;
  }

  private async resolvePushClaimBeforeSend(claimed: ClaimedPushDelivery, now: number): Promise<void> {
    const state = this.state();
    if (state?.status === "active" && now >= state.inactivity_expires_at) {
      await this.expire(now, "Conversation expired");
      return;
    }
    this.ctx.storage.transactionSync(() => {
      const delivery = rows<StoredPushDelivery>(this.ctx.storage.sql.exec(
        "SELECT * FROM push_deliveries WHERE id = ? AND status = 'sending' AND attempt_count = ?",
        claimed.delivery.id, claimed.delivery.attempt_count,
      ))[0];
      if (!delivery) return;
      if (now >= delivery.retry_expires_at) {
        this.ctx.storage.sql.exec("DELETE FROM push_deliveries WHERE id = ?", delivery.id);
        return;
      }
      if (this.hasNewerPushDelivery(delivery)) {
        this.ctx.storage.sql.exec("DELETE FROM push_deliveries WHERE id = ?", delivery.id);
        return;
      }
      const retryAt = now + PUSH_INITIAL_DELAY_MS;
      this.ctx.storage.sql.exec(
        "UPDATE push_deliveries SET status = 'pending', due_at = ?, completed_at = NULL, lease_expires_at = NULL, failure_category = NULL WHERE id = ?",
        Math.min(retryAt, delivery.retry_expires_at), delivery.id,
      );
    });
    await this.schedule();
  }

  private finishPushDelivery(claimed: ClaimedPushDelivery, now: number, failureCategory: string | null, retry: boolean): void {
    this.ctx.storage.transactionSync(() => {
      const delivery = rows<StoredPushDelivery>(this.ctx.storage.sql.exec(
        "SELECT * FROM push_deliveries WHERE id = ? AND status = 'sending' AND attempt_count = ?",
        claimed.delivery.id, claimed.delivery.attempt_count,
      ))[0];
      if (!delivery) return;
      if (now >= delivery.retry_expires_at) {
        this.ctx.storage.sql.exec("DELETE FROM push_deliveries WHERE id = ?", delivery.id);
        return;
      }
      if (retry && this.hasNewerPushDelivery(delivery)) {
        this.ctx.storage.sql.exec("DELETE FROM push_deliveries WHERE id = ?", delivery.id);
        return;
      }
      const retryAt = now + pushRetryDelayMs(delivery.attempt_count);
      const canRetry = retry && retryAt < delivery.retry_expires_at;
      this.ctx.storage.sql.exec(
        "UPDATE push_deliveries SET status = ?, due_at = ?, completed_at = ?, lease_expires_at = NULL, failure_category = ? WHERE id = ?",
        failureCategory === null ? "delivered" : canRetry ? "retrying" : "failed",
        canRetry ? retryAt : delivery.due_at,
        now,
        failureCategory,
        delivery.id,
      );
    });
  }

  private removeInvalidPushSubscription(claimed: ClaimedPushDelivery): void {
    this.ctx.storage.transactionSync(() => {
      const current = rows<{ id: string }>(this.ctx.storage.sql.exec(
        "SELECT id FROM push_subscriptions WHERE id = ? AND endpoint = ? AND p256dh = ? AND auth = ?",
        claimed.subscription.id, claimed.subscription.endpoint, claimed.subscription.p256dh, claimed.subscription.auth,
      ))[0];
      if (current) this.deletePushSubscription(current.id);
    });
  }

  private recoverExpiredPushLeases(now: number): void {
    this.ctx.storage.transactionSync(() => {
      const expired = rows<StoredPushDelivery>(this.ctx.storage.sql.exec(
        "SELECT * FROM push_deliveries WHERE status = 'sending' AND lease_expires_at <= ? ORDER BY lease_expires_at ASC LIMIT ?",
        now, MAX_WEBHOOKS_PER_ROOM * 2,
      ));
      for (const delivery of expired) {
        if (delivery.retry_expires_at <= now) {
          this.ctx.storage.sql.exec("DELETE FROM push_deliveries WHERE id = ?", delivery.id);
          continue;
        }
        if (this.hasNewerPushDelivery(delivery)) {
          this.ctx.storage.sql.exec("DELETE FROM push_deliveries WHERE id = ?", delivery.id);
          continue;
        }
        const retryAt = now + pushRetryDelayMs(delivery.attempt_count);
        if (retryAt >= delivery.retry_expires_at) {
          this.ctx.storage.sql.exec("DELETE FROM push_deliveries WHERE id = ?", delivery.id);
          continue;
        }
        this.ctx.storage.sql.exec(
          "UPDATE push_deliveries SET status = 'retrying', due_at = ?, completed_at = ?, lease_expires_at = NULL, failure_category = 'timeout' WHERE id = ?",
          retryAt, now, delivery.id,
        );
      }
    });
  }

  private prunePushDeliveries(now: number): void {
    this.ctx.storage.sql.exec("DELETE FROM push_deliveries WHERE retry_expires_at <= ?", now);
  }

  private webhookClaimSecret(claimed: ClaimedWebhookDelivery, now: number): string | undefined {
    const state = this.state();
    if (!state || state.status !== "active" || now >= state.inactivity_expires_at) return undefined;
    const delivery = rows<{ attempt_count: number; cancelled_at: number | null; manual_redelivery_requested_at: number | null; message_id: string; retry_expires_at: number; status: string }>(this.ctx.storage.sql.exec(
      "SELECT attempt_count, cancelled_at, manual_redelivery_requested_at, message_id, retry_expires_at, status FROM webhook_deliveries WHERE id = ?",
      claimed.delivery.id,
    ))[0];
    if (!delivery || delivery.status !== "sending" || delivery.attempt_count !== claimed.delivery.attempt_count) return undefined;
    const manualRedelivery = delivery.manual_redelivery_requested_at !== null;
    if (manualRedelivery !== claimed.manualRedelivery) return undefined;
    if (delivery.cancelled_at !== null || (!manualRedelivery && now >= delivery.retry_expires_at)) return undefined;
    const message = rows<{ id: string }>(this.ctx.storage.sql.exec("SELECT id FROM messages WHERE id = ?", delivery.message_id))[0];
    if (!message) return undefined;
    const endpoint = rows<{ secret: string; status: string }>(this.ctx.storage.sql.exec(
      "SELECT secret, status FROM webhook_endpoints WHERE id = ?",
      claimed.endpoint.id,
    ))[0];
    if (!endpoint || (!manualRedelivery && endpoint.status !== "active")) return undefined;
    return endpoint.secret;
  }

  private async resolveWebhookClaimBeforeSend(claimed: ClaimedWebhookDelivery, now: number, deferUnsentClaim = false): Promise<void> {
    const state = this.state();
    if (state?.status === "active" && now >= state.inactivity_expires_at) {
      await this.expire(now, "Conversation expired");
      return;
    }
    this.ctx.storage.transactionSync(() => {
      const current = this.state();
      const delivery = rows<StoredWebhookDelivery>(this.ctx.storage.sql.exec(
        "SELECT * FROM webhook_deliveries WHERE id = ? AND status = 'sending' AND attempt_count = ?",
        claimed.delivery.id, claimed.delivery.attempt_count,
      ))[0];
      const endpoint = rows<StoredWebhookEndpoint>(this.ctx.storage.sql.exec(
        "SELECT * FROM webhook_endpoints WHERE id = ?",
        claimed.endpoint.id,
      ))[0];
      if (!current || current.status !== "active" || !delivery) return;
      const message = rows<{ id: string }>(this.ctx.storage.sql.exec(
        "SELECT id FROM messages WHERE id = ?",
        delivery.message_id,
      ))[0];
      if (!message || !endpoint) {
        this.ctx.storage.sql.exec("DELETE FROM webhook_delivery_attempts WHERE delivery_id = ?", delivery.id);
        this.ctx.storage.sql.exec("DELETE FROM webhook_deliveries WHERE id = ? AND status = 'sending' AND attempt_count = ?", delivery.id, delivery.attempt_count);
        return;
      }
      const manualRedelivery = delivery.manual_redelivery_requested_at !== null;
      if (manualRedelivery !== claimed.manualRedelivery) return;
      const cancelledBeforeSend = delivery.cancelled_at !== null || (!manualRedelivery && endpoint.status !== "active");
      const expiredAutomaticAttempt = !manualRedelivery && now >= delivery.retry_expires_at;
      if (!cancelledBeforeSend && !expiredAutomaticAttempt && !deferUnsentClaim) return;
      this.ctx.storage.sql.exec(
        "DELETE FROM webhook_delivery_attempts WHERE delivery_id = ? AND attempt_number = ?",
        delivery.id, delivery.attempt_count,
      );
      if (manualRedelivery && cancelledBeforeSend) {
        this.ctx.storage.sql.exec(
          "UPDATE webhook_deliveries SET status = 'failed', attempt_count = ?, attempted_at = ?, completed_at = ?, lease_expires_at = NULL, cancelled_at = NULL, failure_category = ?, manual_redelivery_requested_at = NULL WHERE id = ? AND status = 'sending' AND attempt_count = ?",
          claimed.previousDelivery.attempt_count, claimed.previousDelivery.attempted_at, claimed.previousDelivery.completed_at, claimed.previousDelivery.failure_category, delivery.id, delivery.attempt_count,
        );
      } else if (expiredAutomaticAttempt && !cancelledBeforeSend) {
        this.ctx.storage.sql.exec(
          "UPDATE webhook_deliveries SET status = 'failed', attempt_count = ?, attempted_at = ?, completed_at = retry_expires_at, lease_expires_at = NULL, failure_category = ? WHERE id = ?",
          claimed.previousDelivery.attempt_count, claimed.previousDelivery.attempted_at, claimed.previousDelivery.failure_category, delivery.id,
        );
      } else if (cancelledBeforeSend) {
        this.ctx.storage.sql.exec(
          "UPDATE webhook_deliveries SET status = 'cancelled', attempt_count = ?, attempted_at = ?, completed_at = ?, lease_expires_at = NULL, cancelled_at = COALESCE(?, ?), failure_category = ?, manual_redelivery_requested_at = NULL WHERE id = ? AND status = 'sending' AND attempt_count = ?",
          claimed.previousDelivery.attempt_count, claimed.previousDelivery.attempted_at, claimed.previousDelivery.completed_at ?? now, delivery.cancelled_at, endpoint.disabled_at ?? now, claimed.previousDelivery.failure_category, delivery.id, delivery.attempt_count,
        );
      } else {
        const deferredDueAt = now + WEBHOOK_INITIAL_DELAY_MS;
        this.ctx.storage.sql.exec(
          "UPDATE webhook_deliveries SET status = ?, due_at = ?, attempt_count = ?, attempted_at = ?, completed_at = ?, lease_expires_at = NULL, cancelled_at = NULL, failure_category = ?, manual_redelivery_requested_at = ? WHERE id = ? AND status = 'sending' AND attempt_count = ? AND manual_redelivery_requested_at IS ?",
          claimed.previousDelivery.status,
          manualRedelivery ? deferredDueAt : Math.min(deferredDueAt, delivery.retry_expires_at),
          claimed.previousDelivery.attempt_count,
          claimed.previousDelivery.attempted_at,
          claimed.previousDelivery.completed_at,
          claimed.previousDelivery.failure_category,
          claimed.previousDelivery.manual_redelivery_requested_at,
          delivery.id,
          delivery.attempt_count,
          claimed.previousDelivery.manual_redelivery_requested_at,
        );
      }
    });
    await this.schedule();
  }

  private async schedule(_state?: RoomState): Promise<void> {
    this.scheduleRevision += 1;
    while (this.scheduledRevision !== this.scheduleRevision) {
      let pending = this.schedulePromise;
      if (!pending) {
        pending = this.drainSchedule().finally(() => {
          if (this.schedulePromise === pending) this.schedulePromise = undefined;
        });
        this.schedulePromise = pending;
      }
      await pending;
    }
  }

  private async drainSchedule(): Promise<void> {
    while (this.scheduledRevision !== this.scheduleRevision) {
      const revision = this.scheduleRevision;
      const state = this.state();
      if (!state) {
        await this.ctx.storage.deleteAlarm();
      } else {
        const retry = rows<{ at: number | null }>(this.ctx.storage.sql.exec(
          "SELECT MIN(CASE WHEN manual_redelivery_requested_at IS NOT NULL THEN due_at WHEN due_at < retry_expires_at THEN due_at ELSE retry_expires_at END) AS at FROM webhook_deliveries WHERE status IN ('pending', 'retrying')",
        ))[0]?.at;
        const lease = rows<{ at: number | null }>(this.ctx.storage.sql.exec(
          "SELECT MIN(lease_expires_at) AS at FROM webhook_deliveries WHERE status = 'sending'",
        ))[0]?.at;
        const failureDeadline = rows<{ at: number | null }>(this.ctx.storage.sql.exec(
          "SELECT MIN(failure_started_at + ?) AS at FROM webhook_endpoints WHERE status = 'active' AND failure_started_at IS NOT NULL",
          WEBHOOK_FAILURE_WINDOW_MS,
        ))[0]?.at;
        const history = rows<{ at: number | null }>(this.ctx.storage.sql.exec(
          "SELECT MIN(created_at + ?) AS at FROM webhook_deliveries",
          WEBHOOK_HISTORY_TTL_MS,
        ))[0]?.at;
        const healthHistory = rows<{ at: number | null }>(this.ctx.storage.sql.exec(
          "SELECT MIN(at) AS at FROM (SELECT last_success_at + ? AS at FROM webhook_endpoints WHERE last_success_at IS NOT NULL UNION ALL SELECT last_failure_at + ? AS at FROM webhook_endpoints WHERE last_failure_at IS NOT NULL UNION ALL SELECT failure_started_at + ? AS at FROM webhook_endpoints WHERE failure_started_at IS NOT NULL UNION ALL SELECT recovered_at + ? AS at FROM webhook_endpoints WHERE recovered_at IS NOT NULL UNION ALL SELECT disabled_at + ? AS at FROM webhook_endpoints WHERE disabled_at IS NOT NULL)",
          WEBHOOK_HISTORY_TTL_MS, WEBHOOK_HISTORY_TTL_MS, WEBHOOK_HISTORY_TTL_MS, WEBHOOK_HISTORY_TTL_MS, WEBHOOK_HISTORY_TTL_MS,
        ))[0]?.at;
        const pushDue = rows<{ at: number | null }>(this.ctx.storage.sql.exec(
          "SELECT MIN(CASE WHEN due_at < retry_expires_at THEN due_at ELSE retry_expires_at END) AS at FROM push_deliveries WHERE status IN ('pending', 'retrying')",
        ))[0]?.at;
        const pushLease = rows<{ at: number | null }>(this.ctx.storage.sql.exec(
          "SELECT MIN(lease_expires_at) AS at FROM push_deliveries WHERE status = 'sending'",
        ))[0]?.at;
        const pushHistory = rows<{ at: number | null }>(this.ctx.storage.sql.exec(
          "SELECT MIN(retry_expires_at) AS at FROM push_deliveries",
        ))[0]?.at;
        const stateDeadline = state.status === "deleted" ? state.tombstone_expires_at : state.inactivity_expires_at;
        const deadlines = [stateDeadline, retry, lease, failureDeadline, history, healthHistory, pushDue, pushLease, pushHistory].filter((value): value is number => typeof value === "number");
        if (deadlines.length === 0) await this.ctx.storage.deleteAlarm();
        else await this.ctx.storage.setAlarm(Math.min(...deadlines));
      }
      this.scheduledRevision = revision;
    }
  }

  private insertMessage(message: StoredMessage): void {
    this.ctx.storage.sql.exec("INSERT INTO messages (sequence, id, content, author, display_name, client, semantic_type, reply_to, created_at, client_message_id, byte_count, idempotency_key, source_browser_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", message.sequence, message.id, message.content, message.author, message.display_name, message.client ?? null, message.semantic_type, message.reply_to ?? null, message.created_at, message.client_message_id ?? null, message.byte_count, message.idempotency_key ?? null, message.source_browser_id);
  }

  private state(): RoomState | undefined { return rows<RoomState>(this.ctx.storage.sql.exec("SELECT * FROM room_state WHERE singleton = 1"))[0]; }
  private requireState(): RoomState { const state = this.state(); if (!state) throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404); return state; }
  private async requireActive(now: number): Promise<RoomState> { const state = this.requireState(); if (state.status === "deleted") throw new ProtocolError(ERROR_CODES.gone, "The conversation has expired.", 410); if (now >= state.inactivity_expires_at) { await this.expire(now, "Conversation expired"); throw new ProtocolError(ERROR_CODES.gone, "The conversation has expired.", 410); } await this.schedule(); return state; }
  private messageBySequence(sequence: number): StoredMessage { const message = rows<StoredMessage>(this.ctx.storage.sql.exec("SELECT * FROM messages WHERE sequence = ?", sequence))[0]; if (!message) throw new Error("Initial message was not stored."); return message; }
  private messageByIdempotencyKey(key: string): StoredMessage | undefined { return rows<StoredMessage>(this.ctx.storage.sql.exec("SELECT * FROM messages WHERE idempotency_key = ?", key))[0]; }
  private messageByClientMessageId(key: string): StoredMessage | undefined { return rows<StoredMessage>(this.ctx.storage.sql.exec("SELECT * FROM messages WHERE client_message_id = ?", key))[0]; }
  private toMessage(message: StoredMessage) { return { id: message.id, sequence: message.sequence, content: message.content, author: message.author, display_name: message.display_name, identity_verified: false as const, ...(message.client ? { client: message.client } : {}), semantic_type: message.semantic_type, ...(message.reply_to ? { reply_to: message.reply_to } : {}), created_at: iso(message.created_at), ...(message.client_message_id ? { client_message_id: message.client_message_id } : {}), byte_count: message.byte_count }; }
  private async expire(now: number, reason: string): Promise<void> { if (!this.deleteToTombstone(now)) return; const state = this.requireState(); await this.broadcast({ protocol_version: PROTOCOL_VERSION, type: "conversation.expired" }); this.closeSockets(1001, reason); await this.schedule(state); }
  private async broadcast(frame: unknown): Promise<void> { const payload = JSON.stringify(frame); for (const socket of this.liveSockets()) { if (this.config.MSG_AUTH_REQUIRED !== "1") { socket.send(payload); continue; } const context = this.socketContexts.get(socket) ?? this.attachmentContext(socket); const credential = this.socketCredentials.get(socket); if (!context || !credential || !(await this.verifySocket(context, credential))) { socket.close(1008, "The live authorization is no longer valid"); continue; } socket.send(payload); } }
  private closeSockets(code: number, reason: string): void { for (const socket of this.liveSockets()) { this.socketCredentials.delete(socket); this.socketContexts.delete(socket); socket.close(code, reason); } }
  private liveSockets(): WebSocket[] { return [...new Set([...this.ctx.getWebSockets(socketTag), ...this.socketContexts.keys()])]; }
  private json(value: unknown): Response { return new Response(JSON.stringify(value), { headers: { "content-type": "application/json; charset=utf-8" } }); }
  private error(code: string, message: string, status: number): Response { return new Response(JSON.stringify({ error: { code, message } }), { headers: { "content-type": "application/json; charset=utf-8" }, status }); }
}

function createDeferredSignal(): DeferredSignal {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = () => done(); });
  return { promise, resolve };
}

function rows<T>(cursor: Iterable<unknown>): T[] { return [...cursor] as T[]; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function iso(value: number): string { return new Date(value).toISOString(); }
function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const decoded = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
function byteBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
function resolveNow(env: ConversationRoomEnv): number {
  if (env.MSG_TEST_NOW_MS === undefined) return Date.now();
  if (env.MSG_TEST_MODE !== "1" || !/^[0-9]+$/u.test(env.MSG_TEST_NOW_MS)) throw new Error("The test clock requires explicit test mode and a valid timestamp.");
  const now = Number(env.MSG_TEST_NOW_MS);
  if (!Number.isSafeInteger(now)) throw new Error("The test clock timestamp is invalid.");
  return now;
}
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
