import { DurableObject } from "cloudflare:workers";

import { ERROR_CODES, isStaleRevisionDetails, isStaleSequenceDetails, ProtocolError, type StaleRevisionDetails, type StaleSequenceDetails } from "./errors";
import { coordinationMutationFingerprint, coordinationStorageBytes, COORDINATION_DEFAULT_LIMIT, COORDINATION_KIND, COORDINATION_PANEL_KIND, COORDINATION_PROGRESS_KIND, DECISION_POSITION_KIND, DECISION_PROPOSAL_KIND, MAX_COORDINATION_PAGE_BYTES, parseCoordinationListSelectors, parseCoordinationProposal, parseCoordinationPublish, parseCoordinationRevision, type CoordinationDecisionApproval, type CoordinationKind, type CoordinationPanelBody, type CoordinationProgressBody, type CoordinationProposalBody, type CoordinationProposalInput, type CoordinationPublishInput, type CoordinationRequestBody, type CoordinationStatus, type DecisionPositionBody, type DecisionProposalBody } from "./coordination-domain";
import { byteLength, compareCapabilities, DEFAULT_READ_LIMIT, MAX_READ_MESSAGE_BYTES, messageStorageBytes, ROOM_LIMITS, validateBasedOnSequence, validateBoundedCursor, validateCursor, validateReadLimit, validateRequestId, validateThrough } from "./room-domain";
import type { MessageInput } from "./room-domain";
import { PROTOCOL_VERSION, type CoordinationAcceptedRecord, type CoordinationDecision, type CoordinationDecisionApprovalEvidence, type CoordinationDecisionHistoryEntry, type CoordinationDecisionPosition, type CoordinationEvidenceItem, type CoordinationPanel, type CoordinationPanelHistoryEntry, type CoordinationProgress, type CoordinationProposal, type CoordinationProposalSummary, type CoordinationRequest, type CoordinationRequestSummary, type CoordinationSourceMessage, type CreateWebhookResponse, type ManageWebhookResponse, type RedeliverWebhookResponse, type RotateWebhookSecretResponse, type WebhookAttemptMetadata, type WebhookDeliveryMetadata, type WebhookSummary } from "./protocol";
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
  readonly get_post_enabled: number;
  readonly get_post_hash: string | null;
  readonly coordination_cursor: number;
  readonly published_revision: number;
  readonly message_count: number;
  readonly next_sequence: number;
  readonly notification_id: string;
  readonly status: "active" | "deleted";
  readonly tombstone_expires_at: number | null;
  readonly total_bytes: number;
}

interface StoredCoordinationProposal {
  readonly actor_label: string;
  readonly authority_class: "management" | "participant";
  readonly base_revision: number;
  readonly body: string;
  readonly created_at: number;
  readonly kind: CoordinationKind;
  readonly proposal_id: string;
  readonly request_id: string | null;
  readonly revision: number;
  readonly source_message_ids: string;
  readonly byte_count: number;
}

interface StoredCoordinationRequest {
  readonly completion_criteria: string;
  readonly created_at: number;
  readonly decision_impact: string;
  readonly owner_label: string;
  readonly published_revision: number;
  readonly purpose: string;
  readonly request_id: string;
  readonly requested_output: string;
  readonly status: CoordinationStatus;
  readonly title: string;
  readonly unknowns: string;
  readonly updated_at: number;
  readonly byte_count: number;
}

interface StoredCoordinationEvent {
  readonly actor_label: string;
  readonly authority_class: "management" | "participant";
  readonly base_revision: number;
  readonly body: string;
  readonly created_at: number;
  readonly event_id: string;
  readonly kind: CoordinationKind;
  readonly operation: string;
  readonly proposal_id: string | null;
  readonly proposal_revision: number | null;
  readonly request_id: string | null;
  readonly resulting_revision: number | null;
  readonly source_message_ids: string;
  readonly cursor: number;
  readonly byte_count: number;
}

interface StoredCoordinationPanel {
  readonly artifacts: string;
  readonly byte_count: number;
  readonly owner_label: string;
  readonly phase: string | null;
  readonly proposal_id: string;
  readonly proposal_revision: number;
  readonly published_at: number;
  readonly published_revision: number;
  readonly purpose: string | null;
  readonly singleton: number;
  readonly source_message_ids: string;
  readonly next_actions: string;
}

interface StoredCoordinationDecision {
  readonly accepted_record_id: string | null;
  readonly byte_count: number;
  readonly decision_id: string;
  readonly latest_proposal_revision: number;
  readonly proposal_text: string;
  readonly recommendation_cursor: number;
  readonly recommendation_published_revision: number;
  readonly required_approver_labels: string;
  readonly state: "recommended" | "accepted";
  readonly title: string;
  readonly updated_at: number;
}

interface StoredCoordinationDecisionPosition {
  readonly byte_count: number;
  readonly created_at: number;
  readonly decision_id: string;
  readonly decision_revision: number;
  readonly participant_label: string;
  readonly position_id: string;
  readonly published_cursor: number;
  readonly published_revision: number;
  readonly reporter_label: string;
  readonly source_message_ids: string;
  readonly statement: string;
}

interface StoredCoordinationAcceptedRecord {
  readonly accepted_record_id: string;
  readonly byte_count: number;
  readonly created_at: number;
  readonly decision_id: string;
  readonly decision_revision: number;
  readonly owner_attestation: number;
  readonly owner_label: string;
  readonly proposal_snapshot: string;
  readonly publication_cursor: number;
  readonly publication_revision: number;
  readonly required_approver_labels: string;
}

interface StoredCoordinationApprovalEvidence {
  readonly accepted_record_id: string;
  readonly approval_record_id: string;
  readonly byte_count: number;
  readonly decision_id: string;
  readonly decision_revision: number;
  readonly participant_label: string;
  readonly source_author: string;
  readonly source_created_at: number;
  readonly source_display_name: string;
  readonly source_message_id: string;
  readonly source_sequence: number;
}

interface CoordinationProgressSnapshot {
  readonly blockers: readonly string[];
  readonly evidence: readonly CoordinationEvidenceItem[];
  readonly progress?: CoordinationProgress;
  readonly status: CoordinationStatus;
  readonly unverified_explanation?: string;
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

type HibernatingSocket = WebSocket & {
  deserializeAttachment(): unknown;
  serializeAttachment(value: unknown): void;
};

const socketTag = "conversation-live";

/** SQLite is the durable source of truth. HTTP is only the worker-to-room boundary. */
export class ConversationRoom extends DurableObject<ConversationRoomEnv> {
  private readonly config: ConversationRoomEnv;
  private readonly limits: RoomLimits;
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
      if (request.method === "POST" && url.pathname === "/webhooks") return await this.createWebhook(request);
      if (request.method === "GET" && url.pathname === "/webhooks") return await this.listWebhooks();
      if (request.method === "POST" && url.pathname === "/push-subscriptions") return await this.enrollPush(request);
      if (request.method === "GET" && url.pathname === "/push-subscriptions") return await this.readPushEnrollment(request);
      if (request.method === "DELETE" && url.pathname === "/push-subscriptions") return await this.removePushEnrollment(request);
      const webhookActionMatch = /^\/webhooks\/([0-9a-f-]{36})\/(disable|enable|rotate-secret)$/iu.exec(url.pathname);
      if (request.method === "POST" && webhookActionMatch) {
        if (webhookActionMatch[2] === "rotate-secret") return await this.rotateWebhookSecret(webhookActionMatch[1]!);
        return await this.setWebhookEnabled(webhookActionMatch[1]!, webhookActionMatch[2] === "enable");
      }
      const redeliveryMatch = /^\/webhooks\/([0-9a-f-]{36})\/deliveries\/([0-9a-f-]{36})\/redeliver$/iu.exec(url.pathname);
      if (request.method === "POST" && redeliveryMatch) return await this.redeliverWebhook(redeliveryMatch[1]!, redeliveryMatch[2]!);
      const webhookMatch = /^\/webhooks\/([0-9a-f-]{36})$/iu.exec(url.pathname);
      if (request.method === "DELETE" && webhookMatch) return await this.removeWebhook(webhookMatch[1]!);
      if (this.config.MSG_TEST_MODE === "1" && request.method === "POST" && url.pathname === "/__test/mark-webhook-sending") return await this.testMarkWebhookSending(request);
      if (this.config.MSG_TEST_MODE === "1" && request.method === "POST" && url.pathname === "/__test/delete-webhook-source") return await this.testDeleteWebhookSource(request);
      if (this.config.MSG_TEST_MODE === "1" && request.method === "POST" && url.pathname === "/__test/push-send-gate") return await this.testPushSendGateControl(request);
      if (this.config.MSG_TEST_MODE === "1" && request.method === "POST" && url.pathname === "/__test/run-alarm") {
        await this.alarm();
        return this.json({ triggered: true });
      }
      const messageMatch = /^\/messages\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "GET" && messageMatch) return await this.readMessage(decodePathSegment(messageMatch[1]!));
      if (request.method === "GET" && url.pathname === "/read") return await this.read(url);
      if (request.method === "GET" && url.pathname === "/coordination") return await this.readCoordinationOverview();
      if (request.method === "GET" && url.pathname === "/coordination/panel") return await this.readCoordinationPanel(url);
      if (request.method === "GET" && url.pathname === "/coordination/panel/history") return await this.listCoordinationPanelHistory(url);
      if (request.method === "GET" && url.pathname === "/coordination/decisions") return await this.listCoordinationDecisions(url);
      const acceptedRecordMatch = /^\/coordination\/decisions\/([^/]+)\/records\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "GET" && acceptedRecordMatch) return await this.readCoordinationAcceptedRecord(decodePathSegment(acceptedRecordMatch[1]!), decodePathSegment(acceptedRecordMatch[2]!));
      const decisionMatch = /^\/coordination\/decisions\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "GET" && decisionMatch) return await this.readCoordinationDecision(decodePathSegment(decisionMatch[1]!), url);
      if (request.method === "GET" && url.pathname === "/coordination/proposals") return await this.listCoordinationProposals(url);
      if (request.method === "POST" && url.pathname === "/coordination/proposals") return await this.submitCoordinationProposal(request);
      const proposalRevisionMatch = /^\/coordination\/proposals\/([^/]+)\/revisions$/u.exec(url.pathname);
      if (request.method === "POST" && proposalRevisionMatch) return await this.submitCoordinationRevision(request, decodePathSegment(proposalRevisionMatch[1]!));
      const proposalRevisionDetailMatch = /^\/coordination\/proposals\/([^/]+)\/revisions\/([1-9][0-9]*)$/u.exec(url.pathname);
      if (request.method === "GET" && proposalRevisionDetailMatch) return await this.readCoordinationProposalRevision(decodePathSegment(proposalRevisionDetailMatch[1]!), Number(proposalRevisionDetailMatch[2]!));
      const proposalMatch = /^\/coordination\/proposals\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "GET" && proposalMatch) return await this.readCoordinationProposal(decodePathSegment(proposalMatch[1]!), url);
      if (request.method === "GET" && url.pathname === "/coordination/requests") return await this.listCoordinationRequests(url);
      const requestMatch = /^\/coordination\/requests\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "GET" && requestMatch) return await this.readCoordinationRequest(decodePathSegment(requestMatch[1]!), url);
      if (request.method === "POST" && url.pathname === "/coordination/publish") return await this.publishCoordination(request);
      if (request.method === "POST" && url.pathname === "/messages") return await this.post(request);
      if (request.method === "GET" && url.pathname === "/manage") return await this.manage(request, false);
      if (request.method === "DELETE" && url.pathname === "/manage") return await this.manage(request, true);
      if (request.method === "POST" && url.pathname === "/manage") return await this.managePost(request);
      if (request.method === "POST" && url.pathname === "/get-post") return await this.getPost(request);
      if (request.method === "GET" && url.pathname === "/live") return await this.live(url);
      if (request.method === "GET" && (url.pathname === "/export.md" || url.pathname === "/export.json")) return await this.export(url.pathname === "/export.json");
      return this.error(ERROR_CODES.notFound, "The requested resource was not found.", 404);
    } catch (error) {
      if (error instanceof ProtocolError) return this.error(error.code, error.message, error.status, error.details);
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
          this.ctx.storage.sql.exec("DELETE FROM coordination_retries");
          this.ctx.storage.sql.exec("DELETE FROM coordination_events");
          this.ctx.storage.sql.exec("DELETE FROM coordination_proposals");
          this.ctx.storage.sql.exec("DELETE FROM coordination_requests");
          this.ctx.storage.sql.exec("DELETE FROM coordination_panel");
          this.ctx.storage.sql.exec("DELETE FROM coordination_decision_approval_evidence");
          this.ctx.storage.sql.exec("DELETE FROM coordination_decision_accepted_records");
          this.ctx.storage.sql.exec("DELETE FROM coordination_decision_positions");
          this.ctx.storage.sql.exec("DELETE FROM coordination_decisions");
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
    socket.close(1008, "This socket is read-only");
  }

  async webSocketClose(): Promise<void> {}

  private async initialize(request: Request): Promise<Response> {
    const input = await request.json() as { initial: MessageInput; management_hash: string };
    const now = this.now();
    const result = this.ctx.storage.transactionSync(() => {
      const prior = this.state();
      if (prior) return { created: false, message: this.messageBySequence(1), state: prior };
      if (input.initial.reply_to !== undefined) {
        throw new ProtocolError(ERROR_CODES.notFound, "The replied-to message was not found.", 404);
      }
      const id = crypto.randomUUID();
      const notificationId = crypto.randomUUID();
      const bytes = messageStorageBytes(input.initial, undefined, id);
      const inactivity = now + this.limits.inactivityTtlMs;
      this.ctx.storage.sql.exec(
        "INSERT INTO room_state (singleton, schema_version, protocol_version, created_at, last_message_at, inactivity_expires_at, absolute_expires_at, next_sequence, message_count, total_bytes, status, tombstone_expires_at, management_hash, notification_id, get_post_hash, get_post_enabled, coordination_cursor, published_revision) VALUES (1, ?, ?, ?, ?, ?, ?, 2, 1, ?, 'active', NULL, ?, ?, NULL, 0, 0, 0)",
        CURRENT_ROOM_SCHEMA_VERSION, PROTOCOL_VERSION, now, now, inactivity, inactivity, bytes, input.management_hash, notificationId,
      );
      this.insertMessage({ ...input.initial, byte_count: bytes, created_at: now, id, sequence: 1, source_browser_id: null });
      return { created: true, message: this.messageBySequence(1), state: this.requireState() };
    });
    await this.schedule();
    return this.json({ ...this.toMessage(result.message), created: result.created, created_at: iso(result.state.created_at), expires_at: iso(result.state.inactivity_expires_at) });
  }

  private async read(url: URL): Promise<Response> {
    await this.prepareActive(this.now());
    const state = this.requireActiveState();
    const bounded = url.searchParams.has("limit") || url.searchParams.has("through");
    const after = bounded ? validateBoundedCursor(url.searchParams.get("after"), "after") : validateCursor(url.searchParams.get("after"));
    if (!bounded) {
      const messages = rows<StoredMessage>(this.ctx.storage.sql.exec("SELECT * FROM messages WHERE sequence > ? ORDER BY sequence ASC", after)).map((message) => this.toMessage(message));
      return this.json({ protocol_version: PROTOCOL_VERSION, messages, latest_message: state.next_sequence - 1, expires_at: iso(state.inactivity_expires_at), coordination_cursor: state.coordination_cursor, published_revision: state.published_revision, coordination_overview: this.coordinationOverviewValue(state), access_warning: "All authors and display names are self-declared and unverified." });
    }

    const limit = validateReadLimit(url.searchParams.get("limit")) ?? DEFAULT_READ_LIMIT;
    const latest = state.next_sequence - 1;
    const through = validateThrough(url.searchParams.get("through")) ?? latest;
    if (after > latest) throw new ProtocolError(ERROR_CODES.invalidBody, "The after cursor is in the future.", 400);
    if (through > latest) throw new ProtocolError(ERROR_CODES.invalidBody, "The through cursor is in the future.", 400);
    if (after > through) throw new ProtocolError(ERROR_CODES.invalidBody, "The after cursor must not be greater than through.", 400);

    const candidates = rows<StoredMessage>(this.ctx.storage.sql.exec(
      "SELECT * FROM messages WHERE sequence > ? AND sequence <= ? ORDER BY sequence ASC LIMIT ?",
      after,
      through,
      limit + 1,
    )).map((message) => this.toMessage(message));
    const messages = [] as ReturnType<ConversationRoom["toMessage"]>[];
    let serializedBytes = 2; // The [] wrapper around the serialized message array.
    let oversized = false;
    for (const message of candidates) {
      if (messages.length >= limit) break;
      const messageBytes = byteLength(JSON.stringify(message));
      const separatorBytes = messages.length === 0 ? 0 : 1;
      if (messages.length === 0 && serializedBytes + messageBytes > MAX_READ_MESSAGE_BYTES) {
        messages.push(message);
        oversized = true;
        break;
      }
      if (serializedBytes + separatorBytes + messageBytes > MAX_READ_MESSAGE_BYTES) break;
      messages.push(message);
      serializedBytes += separatorBytes + messageBytes;
    }
    const hasMore = messages.length < candidates.length;
    return this.json({
      protocol_version: PROTOCOL_VERSION,
      messages,
      latest_message: latest,
      expires_at: iso(state.inactivity_expires_at),
      coordination_cursor: state.coordination_cursor,
      published_revision: state.published_revision,
      coordination_overview: this.coordinationOverviewValue(state),
      access_warning: "All authors and display names are self-declared and unverified.",
      next_after: messages.at(-1)?.sequence ?? after,
      has_more: hasMore,
      through,
      ...(oversized ? { oversized_message: true } : {}),
    });
  }

  private async readMessage(id: string): Promise<Response> {
    const state = await this.requireActive(this.now());
    const message = rows<StoredMessage>(this.ctx.storage.sql.exec("SELECT * FROM messages WHERE id = ?", id))[0];
    if (!message) throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404);
    return this.json({
      protocol_version: PROTOCOL_VERSION,
      message: this.toMessage(message),
      latest_message: state.next_sequence - 1,
      expires_at: iso(state.inactivity_expires_at),
    });
  }

  private async readCoordinationOverview(): Promise<Response> {
    await this.prepareActive(this.now());
    const state = this.requireActiveState();
    return this.json(this.coordinationOverviewValue(state));
  }

  private coordinationOverviewValue(state: RoomState): Record<string, unknown> {
    const pendingRows = rows<StoredCoordinationProposal>(this.ctx.storage.sql.exec(
      "SELECT p.* FROM coordination_proposals AS p WHERE p.revision = (SELECT MAX(latest.revision) FROM coordination_proposals AS latest WHERE latest.proposal_id = p.proposal_id) AND NOT EXISTS (SELECT 1 FROM coordination_events AS published WHERE published.proposal_id = p.proposal_id AND published.proposal_revision = p.revision AND published.resulting_revision IS NOT NULL) ORDER BY p.created_at DESC, p.proposal_id DESC LIMIT ?",
      5,
    ));
    const publishedRows = rows<StoredCoordinationRequest>(this.ctx.storage.sql.exec(
      "SELECT * FROM coordination_requests ORDER BY published_revision DESC, request_id DESC LIMIT ?",
      5,
    ));
    const decisionRows = rows<StoredCoordinationDecision>(this.ctx.storage.sql.exec(
      "SELECT * FROM coordination_decisions ORDER BY recommendation_published_revision DESC, decision_id DESC LIMIT ?",
      5,
    ));
    const pendingCount = rows<{ count: number }>(this.ctx.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM coordination_proposals AS p WHERE p.revision = (SELECT MAX(latest.revision) FROM coordination_proposals AS latest WHERE latest.proposal_id = p.proposal_id) AND NOT EXISTS (SELECT 1 FROM coordination_events AS published WHERE published.proposal_id = p.proposal_id AND published.proposal_revision = p.revision AND published.resulting_revision IS NOT NULL)",
    ))[0]?.count ?? 0;
    const pendingRequestCount = rows<{ count: number }>(this.ctx.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM coordination_proposals AS p WHERE p.revision = (SELECT MAX(latest.revision) FROM coordination_proposals AS latest WHERE latest.proposal_id = p.proposal_id) AND p.request_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM coordination_events AS published WHERE published.proposal_id = p.proposal_id AND published.proposal_revision = p.revision AND published.resulting_revision IS NOT NULL)",
    ))[0]?.count ?? 0;
    const pendingPanelCount = rows<{ count: number }>(this.ctx.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM coordination_proposals AS p WHERE p.revision = (SELECT MAX(latest.revision) FROM coordination_proposals AS latest WHERE latest.proposal_id = p.proposal_id) AND p.kind = ? AND NOT EXISTS (SELECT 1 FROM coordination_events AS published WHERE published.proposal_id = p.proposal_id AND published.proposal_revision = p.revision AND published.resulting_revision IS NOT NULL)",
      COORDINATION_PANEL_KIND,
    ))[0]?.count ?? 0;
    const publishedCount = rows<{ count: number }>(this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM coordination_requests"))[0]?.count ?? 0;
    const decisionCount = rows<{ count: number }>(this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM coordination_decisions"))[0]?.count ?? 0;
    const acceptedDecisionCount = rows<{ count: number }>(this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM coordination_decisions WHERE state = 'accepted'"))[0]?.count ?? 0;
    const statusCounts = rows<{ status: CoordinationStatus; count: number }>(this.ctx.storage.sql.exec("SELECT status, COUNT(*) AS count FROM coordination_requests GROUP BY status"));
    const requestStatusCounts: Record<string, number> = { open: 0, in_progress: 0, blocked: 0, done: 0, withdrawn: 0 };
    for (const row of statusCounts) requestStatusCounts[row.status] = row.count;
    const panel = rows<StoredCoordinationPanel>(this.ctx.storage.sql.exec("SELECT * FROM coordination_panel WHERE singleton = 1"))[0];
    const panelValue = panel === undefined ? null : this.toCoordinationPanelOverview(panel);
    return {
      conversation_url: this.publicRoomPath(),
      coordination_cursor: state.coordination_cursor,
      empty: pendingCount === 0 && publishedCount === 0 && decisionCount === 0 && panelValue === null,
      expires_at: iso(state.inactivity_expires_at),
      latest_message: state.next_sequence - 1,
      pending_proposal_count: pendingCount,
      pending_request_proposal_count: pendingRequestCount,
      pending_panel_proposal_count: pendingPanelCount,
      pending_proposals: pendingRows.map((proposal) => this.toCoordinationProposalSummary(proposal)),
      protocol_version: PROTOCOL_VERSION,
      published_request_count: publishedCount,
      published_requests: publishedRows.map((request) => this.toCoordinationRequestSummary(request)),
      decision_count: decisionCount,
      accepted_decision_count: acceptedDecisionCount,
      recommended_decision_count: decisionCount - acceptedDecisionCount,
      decision_summaries: decisionRows.map((decision) => this.toCoordinationDecisionSummary(decision)),
      decisions_url: "/coordination/decisions?limit=20",
      request_status_counts: requestStatusCounts,
      correction_summaries: [],
      panel: panelValue,
      panel_published_revision: panel?.published_revision ?? null,
      panel_url: "/coordination/panel",
      panel_history_url: "/coordination/panel/history?limit=20",
      proposals_url: "/coordination/proposals?limit=20",
      requests_url: "/coordination/requests?limit=20",
      published_revision: state.published_revision,
    };
  }

  private async readCoordinationPanel(url: URL): Promise<Response> {
    await this.prepareActive(this.now());
    const state = this.requireActiveState();
    const revisionValue = url.searchParams.get("revision");
    if (revisionValue !== null && !/^[1-9][0-9]*$/u.test(revisionValue)) throw new ProtocolError(ERROR_CODES.invalidBody, "The panel revision must be a positive safe integer.", 400);
    const revision = revisionValue === null ? undefined : Number(revisionValue);
    if (revision !== undefined && !Number.isSafeInteger(revision)) throw new ProtocolError(ERROR_CODES.invalidBody, "The panel revision must be a positive safe integer.", 400);
    const stored = revision === undefined
      ? rows<StoredCoordinationPanel>(this.ctx.storage.sql.exec("SELECT * FROM coordination_panel WHERE singleton = 1"))[0]
      : undefined;
    const event = revision === undefined
      ? undefined
      : rows<StoredCoordinationEvent>(this.ctx.storage.sql.exec("SELECT * FROM coordination_events WHERE operation = 'panel.published' AND resulting_revision = ?", revision))[0];
    if (revision !== undefined && event === undefined) throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404);
    const panel = stored === undefined && event === undefined ? null : this.toCoordinationPanel((stored ?? event)!);
    return this.json({
      coordination_cursor: state.coordination_cursor,
      expires_at: iso(state.inactivity_expires_at),
      latest_message: state.next_sequence - 1,
      panel,
      panel_published_revision: panel?.published_revision ?? null,
      protocol_version: PROTOCOL_VERSION,
      published_revision: state.published_revision,
    });
  }

  private async listCoordinationPanelHistory(url: URL): Promise<Response> {
    await this.prepareActive(this.now());
    const state = this.requireActiveState();
    const selectors = parseCoordinationListSelectors(url);
    const through = selectors.through ?? state.coordination_cursor;
    if (through > state.coordination_cursor) throw new ProtocolError(ERROR_CODES.invalidBody, "The coordination through cursor is in the future.", 400);
    const candidates = rows<StoredCoordinationEvent>(this.ctx.storage.sql.exec(
      "SELECT * FROM coordination_events WHERE operation = 'panel.published' AND cursor > ? AND cursor <= ? ORDER BY cursor ASC LIMIT ?",
      selectors.after, through, selectors.limit + 1,
    ));
    const events: CoordinationPanelHistoryEntry[] = [];
    let serializedBytes = 2;
    for (const candidate of candidates) {
      if (events.length >= selectors.limit) break;
      const next = { ...this.toCoordinationPanel(candidate), cursor: candidate.cursor, event_id: candidate.event_id };
      const nextBytes = byteLength(JSON.stringify(next)) + (events.length === 0 ? 0 : 1);
      if (events.length > 0 && serializedBytes + nextBytes > MAX_COORDINATION_PAGE_BYTES) break;
      events.push(next);
      serializedBytes += nextBytes;
    }
    return this.json({
      coordination_cursor: state.coordination_cursor,
      events,
      expires_at: iso(state.inactivity_expires_at),
      has_more: events.length < candidates.length,
      history_after: selectors.after,
      history_next_after: events.at(-1)?.cursor ?? selectors.after,
      history_through: through,
      latest_message: state.next_sequence - 1,
      protocol_version: PROTOCOL_VERSION,
      published_revision: state.published_revision,
    });
  }

  private async listCoordinationDecisions(url: URL): Promise<Response> {
    const state = await this.requireActive(this.now());
    const selectors = parseCoordinationListSelectors(url);
    const through = selectors.through ?? state.coordination_cursor;
    if (through > state.coordination_cursor) throw new ProtocolError(ERROR_CODES.invalidBody, "The coordination through cursor is in the future.", 400);
    const candidates = rows<StoredCoordinationEvent>(this.ctx.storage.sql.exec(
      "SELECT e.* FROM coordination_events AS e WHERE e.operation IN ('decision.recommended', 'decision.accepted') AND e.cursor > ? AND e.cursor <= ? AND e.cursor = (SELECT MAX(latest.cursor) FROM coordination_events AS latest WHERE latest.operation IN ('decision.recommended', 'decision.accepted') AND latest.proposal_id = e.proposal_id AND latest.cursor <= ?) ORDER BY e.cursor ASC LIMIT ?",
      selectors.after, through, through, selectors.limit + 1,
    ));
    const decisions: CoordinationDecision[] = [];
    let serializedBytes = 2;
    for (const candidate of candidates) {
      if (decisions.length >= selectors.limit) break;
      const next = this.toCoordinationDecisionFromEvent(candidate);
      const nextBytes = byteLength(JSON.stringify(next)) + (decisions.length === 0 ? 0 : 1);
      if (decisions.length > 0 && serializedBytes + nextBytes > MAX_COORDINATION_PAGE_BYTES) break;
      decisions.push(next);
      serializedBytes += nextBytes;
    }
    return this.json({
      coordination_cursor: state.coordination_cursor,
      decisions,
      expires_at: iso(state.inactivity_expires_at),
      has_more: decisions.length < candidates.length,
      latest_message: state.next_sequence - 1,
      next_after: candidates[decisions.length - 1]?.cursor ?? selectors.after,
      protocol_version: PROTOCOL_VERSION,
      published_revision: state.published_revision,
      through,
    });
  }

  private async readCoordinationDecision(decisionId: string, url: URL): Promise<Response> {
    await this.prepareActive(this.now());
    const state = this.requireActiveState();
    const selectors = parseCoordinationListSelectors(url);
    const through = selectors.through ?? state.coordination_cursor;
    if (through > state.coordination_cursor) throw new ProtocolError(ERROR_CODES.invalidBody, "The coordination through cursor is in the future.", 400);
    const history = rows<StoredCoordinationEvent>(this.ctx.storage.sql.exec(
      "SELECT * FROM coordination_events AS e WHERE ((e.operation IN ('decision.recommended', 'decision.accepted') AND e.proposal_id = ?) OR (e.operation = 'decision.position.published' AND json_extract(e.body, '$.decision_proposal_id') = ?)) AND e.cursor > ? AND e.cursor <= ? ORDER BY e.cursor ASC LIMIT ?",
      decisionId, decisionId, selectors.after, through, selectors.limit + 1,
    ));
    const snapshotEvent = rows<StoredCoordinationEvent>(this.ctx.storage.sql.exec(
      "SELECT * FROM coordination_events WHERE operation IN ('decision.recommended', 'decision.accepted') AND proposal_id = ? AND cursor <= ? ORDER BY cursor DESC LIMIT 1",
      decisionId, through,
    ))[0];
    if (!snapshotEvent) throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404);
    const positionRows = rows<StoredCoordinationDecisionPosition>(this.ctx.storage.sql.exec(
      "SELECT * FROM coordination_decision_positions WHERE decision_id = ? AND published_cursor > ? AND published_cursor <= ? ORDER BY published_cursor ASC, position_id ASC LIMIT ?",
      decisionId, selectors.after, through, selectors.limit + 1,
    ));
    const positions: CoordinationDecisionPosition[] = [];
    let positionBytes = 2;
    for (const position of positionRows) {
      if (positions.length >= selectors.limit) break;
      const next = this.toCoordinationDecisionPosition(position);
      const nextBytes = byteLength(JSON.stringify(next)) + (positions.length === 0 ? 0 : 1);
      if (positions.length > 0 && positionBytes + nextBytes > MAX_COORDINATION_PAGE_BYTES) break;
      positions.push(next);
      positionBytes += nextBytes;
    }
    const decision = { ...this.toCoordinationDecisionFromEvent(snapshotEvent), positions };
    const delivered: CoordinationDecisionHistoryEntry[] = [];
    let historyBytes = 2;
    for (const event of history) {
      if (delivered.length >= selectors.limit) break;
      const next = this.toCoordinationDecisionHistoryEntry(event, decisionId);
      const nextBytes = byteLength(JSON.stringify(next)) + (delivered.length === 0 ? 0 : 1);
      if (delivered.length > 0 && historyBytes + nextBytes > MAX_COORDINATION_PAGE_BYTES) break;
      delivered.push(next);
      historyBytes += nextBytes;
    }
    return this.json({
      coordination_cursor: state.coordination_cursor,
      decision,
      expires_at: iso(state.inactivity_expires_at),
      history: delivered,
      history_has_more: delivered.length < history.length,
      history_next_after: delivered.at(-1)?.cursor ?? selectors.after,
      history_through: through,
      latest_message: state.next_sequence - 1,
      positions,
      positions_has_more: positions.length < positionRows.length,
      positions_next_after: positionRows[positions.length - 1]?.published_cursor ?? selectors.after,
      positions_through: through,
      protocol_version: PROTOCOL_VERSION,
      published_revision: state.published_revision,
    });
  }

  private async readCoordinationAcceptedRecord(decisionId: string, acceptedRecordId: string): Promise<Response> {
    await this.prepareActive(this.now());
    const state = this.requireActiveState();
    const record = rows<StoredCoordinationAcceptedRecord>(this.ctx.storage.sql.exec(
      "SELECT * FROM coordination_decision_accepted_records WHERE decision_id = ? AND accepted_record_id = ?",
      decisionId, acceptedRecordId,
    ))[0];
    if (!record) throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404);
    const approvals = rows<StoredCoordinationApprovalEvidence>(this.ctx.storage.sql.exec(
      "SELECT * FROM coordination_decision_approval_evidence WHERE accepted_record_id = ? ORDER BY participant_label ASC",
      acceptedRecordId,
    )).map((approval) => this.toCoordinationApprovalEvidence(approval));
    return this.json({
      accepted_record: this.toCoordinationAcceptedRecord(record),
      approvals,
      coordination_cursor: state.coordination_cursor,
      decision_url: `/coordination/decisions/${encodeURIComponent(decisionId)}`,
      expires_at: iso(state.inactivity_expires_at),
      latest_message: state.next_sequence - 1,
      protocol_version: PROTOCOL_VERSION,
      published_revision: state.published_revision,
    });
  }

  private async listCoordinationProposals(url: URL): Promise<Response> {
    const state = await this.requireActive(this.now());
    const selectors = parseCoordinationListSelectors(url);
    const through = selectors.through ?? state.coordination_cursor;
    if (through > state.coordination_cursor) throw new ProtocolError(ERROR_CODES.invalidBody, "The coordination through cursor is in the future.", 400);
    const candidates = rows<StoredCoordinationProposal & { event_cursor: number }>(this.ctx.storage.sql.exec(
      "SELECT p.*, e.cursor AS event_cursor FROM coordination_proposals AS p JOIN coordination_events AS e ON e.proposal_id = p.proposal_id AND e.proposal_revision = p.revision AND e.operation = 'proposal.created' WHERE p.revision = (SELECT MAX(as_of.revision) FROM coordination_proposals AS as_of JOIN coordination_events AS as_of_event ON as_of_event.proposal_id = as_of.proposal_id AND as_of_event.proposal_revision = as_of.revision AND as_of_event.operation = 'proposal.created' WHERE as_of.proposal_id = p.proposal_id AND as_of_event.cursor <= ?) AND e.cursor > ? AND e.cursor <= ? ORDER BY e.cursor ASC LIMIT ?",
      through,
      selectors.after, through, selectors.limit + 1,
    ));
    const proposals: CoordinationProposal[] = [];
    let proposalBytes = 2;
    for (const candidate of candidates) {
      if (proposals.length >= selectors.limit) break;
      const next = this.toCoordinationProposal(candidate, undefined, undefined, through);
      const nextBytes = byteLength(JSON.stringify(next)) + (proposals.length === 0 ? 0 : 1);
      if (proposals.length > 0 && proposalBytes + nextBytes > MAX_COORDINATION_PAGE_BYTES) break;
      proposals.push(next);
      proposalBytes += nextBytes;
    }
    return this.json({
      coordination_cursor: state.coordination_cursor,
      expires_at: iso(state.inactivity_expires_at),
      has_more: proposals.length < candidates.length,
      latest_message: state.next_sequence - 1,
      next_after: candidates[proposals.length - 1]?.event_cursor ?? selectors.after,
      proposals,
      protocol_version: PROTOCOL_VERSION,
      through,
    });
  }

  private async readCoordinationProposal(proposalId: string, url?: URL): Promise<Response> {
    const state = await this.requireActive(this.now());
    const latest = rows<StoredCoordinationProposal>(this.ctx.storage.sql.exec(
      "SELECT * FROM coordination_proposals WHERE proposal_id = ? ORDER BY revision DESC LIMIT 1",
      proposalId,
    ))[0];
    if (!latest) throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404);
    const selectors = url === undefined ? { after: 0, limit: COORDINATION_DEFAULT_LIMIT, through: latest.revision } : parseCoordinationListSelectors(url);
    const through = selectors.through ?? latest.revision;
    if (through > latest.revision) throw new ProtocolError(ERROR_CODES.invalidBody, "The proposal revision cursor is in the future.", 400);
    const candidateRevisions = rows<StoredCoordinationProposal>(this.ctx.storage.sql.exec(
      "SELECT * FROM coordination_proposals WHERE proposal_id = ? AND revision > ? AND revision <= ? ORDER BY revision ASC LIMIT ?",
      proposalId, selectors.after, through, selectors.limit + 1,
    ));
    const revisions: StoredCoordinationProposal[] = [];
    let revisionBytes = 2;
    for (const candidate of candidateRevisions) {
      if (revisions.length >= selectors.limit) break;
      const next = this.toCoordinationProposal(candidate);
      const nextBytes = byteLength(JSON.stringify(next)) + (revisions.length === 0 ? 0 : 1);
      if (revisions.length > 0 && revisionBytes + nextBytes > MAX_COORDINATION_PAGE_BYTES) break;
      revisions.push(candidate);
      revisionBytes += nextBytes;
    }
    return this.json({
      coordination_cursor: state.coordination_cursor,
      expires_at: iso(state.inactivity_expires_at),
      latest_message: state.next_sequence - 1,
      proposal: this.toCoordinationProposal(latest),
      protocol_version: PROTOCOL_VERSION,
      revisions: revisions.map((revision) => this.toCoordinationProposal(revision)),
      revisions_has_more: revisions.length < candidateRevisions.length,
      revisions_next_after: revisions.at(-1)?.revision ?? selectors.after,
      revisions_through: through,
    });
  }

  private async readCoordinationProposalRevision(proposalId: string, revision: number): Promise<Response> {
    const state = await this.requireActive(this.now());
    const proposal = rows<StoredCoordinationProposal>(this.ctx.storage.sql.exec("SELECT * FROM coordination_proposals WHERE proposal_id = ? AND revision = ?", proposalId, revision))[0];
    if (!proposal) throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404);
    const value = this.toCoordinationProposal(proposal);
    return this.json({
      coordination_cursor: state.coordination_cursor,
      expires_at: iso(state.inactivity_expires_at),
      latest_message: state.next_sequence - 1,
      proposal: value,
      protocol_version: PROTOCOL_VERSION,
      revisions: [value],
      revisions_has_more: false,
      revisions_next_after: revision,
      revisions_through: revision,
    });
  }

  private async submitCoordinationProposal(request: Request): Promise<Response> {
    const input = parseCoordinationProposal(await request.json());
    const result = this.commitCoordinationProposal(input, undefined, this.now());
    if (result.expired) {
      await this.expire(this.now(), "Conversation expired");
      throw new ProtocolError(ERROR_CODES.gone, "The conversation has expired.", 410);
    }
    return this.json(result.response, result.replayed ? 200 : 201);
  }

  private async submitCoordinationRevision(request: Request, proposalId: string): Promise<Response> {
    const input = parseCoordinationRevision(await request.json());
    const result = this.commitCoordinationProposal(input, proposalId, this.now());
    if (result.expired) {
      await this.expire(this.now(), "Conversation expired");
      throw new ProtocolError(ERROR_CODES.gone, "The conversation has expired.", 410);
    }
    return this.json(result.response, result.replayed ? 200 : 201);
  }

  private async listCoordinationRequests(url: URL): Promise<Response> {
    const state = await this.requireActive(this.now());
    const selectors = parseCoordinationListSelectors(url);
    const through = selectors.through ?? state.published_revision;
    if (through > state.published_revision) throw new ProtocolError(ERROR_CODES.invalidBody, "The published revision cursor is in the future.", 400);
    const events = rows<StoredCoordinationEvent>(this.ctx.storage.sql.exec(
      "SELECT e.* FROM coordination_events AS e WHERE e.operation = 'request.published' AND e.resulting_revision = (SELECT MAX(selected.resulting_revision) FROM coordination_events AS selected WHERE selected.operation = 'request.published' AND selected.request_id = e.request_id AND selected.resulting_revision <= ?) AND e.resulting_revision > ? AND (? IS NULL OR json_extract(e.body, '$.owner_label') = ?) AND (? IS NULL OR json_extract(e.body, '$.status') = ? OR (? = 'open' AND json_extract(e.body, '$.status') IS NULL)) ORDER BY e.resulting_revision ASC, e.request_id ASC LIMIT ?",
      through,
      selectors.after,
      selectors.owner_label ?? null, selectors.owner_label ?? null,
      selectors.status ?? null, selectors.status ?? null, selectors.status ?? null,
      selectors.limit + 1,
    ));
    const candidates = events.map((event) => ({ event, request: this.coordinationRequestFromEvent(event) }));
    const requests: CoordinationRequest[] = [];
    let requestBytes = 2;
    for (const candidate of candidates) {
      if (requests.length >= selectors.limit) break;
      const next = this.toCoordinationRequest(candidate.request, candidate.event);
      const nextBytes = byteLength(JSON.stringify(next)) + (requests.length === 0 ? 0 : 1);
      if (requests.length > 0 && requestBytes + nextBytes > MAX_COORDINATION_PAGE_BYTES) break;
      requests.push(next);
      requestBytes += nextBytes;
    }
    return this.json({
      expires_at: iso(state.inactivity_expires_at),
      has_more: requests.length < candidates.length,
      latest_message: state.next_sequence - 1,
      next_after: requests.at(-1)?.published_revision ?? selectors.after,
      protocol_version: PROTOCOL_VERSION,
      published_revision: state.published_revision,
      requests,
      through,
      ...(selectors.owner_label === undefined ? {} : { owner_label: selectors.owner_label }),
      ...(selectors.status === undefined ? {} : { status: selectors.status }),
    });
  }

  private async readCoordinationRequest(requestId: string, url?: URL): Promise<Response> {
    const state = await this.requireActive(this.now());
    const request = rows<StoredCoordinationRequest>(this.ctx.storage.sql.exec("SELECT * FROM coordination_requests WHERE request_id = ?", requestId))[0];
    if (!request) throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404);
    const selectors = url === undefined ? { after: 0, limit: COORDINATION_DEFAULT_LIMIT, through: state.coordination_cursor } : parseCoordinationListSelectors(url);
    const through = selectors.through ?? state.coordination_cursor;
    if (through > state.coordination_cursor) throw new ProtocolError(ERROR_CODES.invalidBody, "The coordination history cursor is in the future.", 400);
    const history = rows<StoredCoordinationProposal & { event_cursor: number }>(this.ctx.storage.sql.exec(
      "SELECT p.*, e.cursor AS event_cursor FROM coordination_events AS e JOIN coordination_proposals AS p ON p.proposal_id = e.proposal_id AND p.revision = e.proposal_revision WHERE e.operation = 'proposal.created' AND e.request_id = ? AND e.cursor > ? AND e.cursor <= ? ORDER BY e.cursor ASC LIMIT ?",
      requestId, selectors.after, through, selectors.limit + 1,
    ));
    const delivered: (StoredCoordinationProposal & { event_cursor: number })[] = [];
    let revisionBytes = 2;
    for (const revision of history) {
      if (delivered.length >= selectors.limit) break;
      const next = this.toCoordinationProposal(revision);
      const nextBytes = byteLength(JSON.stringify(next)) + (delivered.length === 0 ? 0 : 1);
      if (delivered.length > 0 && revisionBytes + nextBytes > MAX_COORDINATION_PAGE_BYTES) break;
      delivered.push(revision);
      revisionBytes += nextBytes;
    }
    return this.json({
      coordination_cursor: state.coordination_cursor,
      expires_at: iso(state.inactivity_expires_at),
      latest_message: state.next_sequence - 1,
      protocol_version: PROTOCOL_VERSION,
      request: this.toCoordinationRequest(request),
      revisions: delivered.map((revision) => this.toCoordinationProposal(revision)),
      revisions_has_more: delivered.length < history.length,
      revisions_next_after: delivered.at(-1)?.event_cursor ?? selectors.after,
      revisions_through: through,
      history_after: selectors.after,
      history_has_more: delivered.length < history.length,
      history_next_after: delivered.at(-1)?.event_cursor ?? selectors.after,
      history_through: through,
    });
  }

  private async publishCoordination(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") ?? "";
    const managementHash = await hashToken(token);
    const input = parseCoordinationPublish(await request.json());
    const result = this.commitCoordinationPublication(input, managementHash, this.now());
    if (result.expired) {
      await this.expire(this.now(), "Conversation expired");
      throw new ProtocolError(ERROR_CODES.gone, "The conversation has expired.", 410);
    }
    return this.json(result.response, result.replayed ? 200 : 201);
  }

  private commitCoordinationProposal(input: CoordinationProposalInput, requestedProposalId: string | undefined, now: number) {
    return this.ctx.storage.transactionSync(() => {
      const state = this.requireState();
      if (state.status !== "active" || now >= state.inactivity_expires_at) return { expired: true as const };
      const operation = requestedProposalId === undefined ? "proposal:create" : `proposal:revision:${requestedProposalId}`;
      const fingerprint = coordinationMutationFingerprint(input);
      const existingRetry = this.coordinationRetry(operation, input.client_retry_id);
      if (existingRetry) {
        if (existingRetry.fingerprint !== fingerprint) throw new ProtocolError(ERROR_CODES.conflict, "The coordination retry identifier is already used for another mutation.", 409);
        return { expired: false as const, replayed: true as const, response: { ...JSON.parse(existingRetry.receipt) as Record<string, unknown>, replayed: true } };
      }
      if (input.base_revision > state.published_revision) throw new ProtocolError(ERROR_CODES.invalidBody, "The coordination base revision is in the future.", 400);
      const sourceMessages = this.requireCoordinationSources(input.source_message_ids);
      const proposalId = requestedProposalId ?? crypto.randomUUID();
      const previous = requestedProposalId === undefined
        ? undefined
        : rows<StoredCoordinationProposal>(this.ctx.storage.sql.exec("SELECT * FROM coordination_proposals WHERE proposal_id = ? ORDER BY revision DESC LIMIT 1", requestedProposalId))[0];
      if (requestedProposalId !== undefined && !previous) throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404);
      if (previous && previous.kind !== input.kind) throw new ProtocolError(ERROR_CODES.conflict, "A proposal revision cannot change kind.", 409);
      const previousDecisionAccepted = previous?.kind === DECISION_PROPOSAL_KIND && rows<{ accepted_record_id: string }>(this.ctx.storage.sql.exec("SELECT accepted_record_id FROM coordination_decision_accepted_records WHERE decision_id = ? LIMIT 1", previous.proposal_id))[0] !== undefined;
      if (previous && !((input.kind === DECISION_PROPOSAL_KIND) && !previousDecisionAccepted) && rows<{ proposal_id: string }>(this.ctx.storage.sql.exec("SELECT proposal_id FROM coordination_events WHERE proposal_id = ? AND proposal_revision = ? AND resulting_revision IS NOT NULL", previous.proposal_id, previous.revision))[0]) {
        throw new ProtocolError(ERROR_CODES.conflict, "A published proposal cannot be revised through the proposal route.", 409);
      }
      const requestedRequestId = input.kind === COORDINATION_PROGRESS_KIND ? (input.body as CoordinationProgressBody).request_id : undefined;
      const requestId = input.kind === COORDINATION_PANEL_KIND || input.kind === DECISION_PROPOSAL_KIND || input.kind === DECISION_POSITION_KIND ? null : previous?.request_id ?? requestedRequestId ?? crypto.randomUUID();
      if (previous && requestedRequestId !== undefined && previous.request_id !== requestedRequestId) throw new ProtocolError(ERROR_CODES.conflict, "A proposal revision cannot change its request target.", 409);
      if (input.kind === COORDINATION_PROGRESS_KIND && requestId !== null && !rows<{ request_id: string }>(this.ctx.storage.sql.exec("SELECT request_id FROM coordination_requests WHERE request_id = ?", requestId))[0]) {
        throw new ProtocolError(ERROR_CODES.notFound, "The requested coordination request was not found.", 404);
      }
      if (input.kind === DECISION_POSITION_KIND) {
        const positionBody = input.body as DecisionPositionBody;
        const target = rows<StoredCoordinationProposal>(this.ctx.storage.sql.exec("SELECT * FROM coordination_proposals WHERE proposal_id = ? AND revision = ?", positionBody.decision_proposal_id, positionBody.decision_revision))[0];
        if (!target || target.kind !== DECISION_PROPOSAL_KIND) throw new ProtocolError(ERROR_CODES.notFound, "The referenced decision proposal revision was not found in this room.", 404);
      }
      const revision = (previous?.revision ?? 0) + 1;
      const cursor = state.coordination_cursor + 1;
      const proposal: StoredCoordinationProposal = {
        actor_label: input.actor_label,
        authority_class: "participant",
        base_revision: input.base_revision,
        body: JSON.stringify(input.body),
        created_at: now,
        kind: input.kind,
        proposal_id: proposalId,
        request_id: requestId,
        revision,
        source_message_ids: JSON.stringify(input.source_message_ids),
        byte_count: coordinationStorageBytes(input.body, proposalId),
      };
      const eventBody = JSON.stringify(input.body);
      const eventBytes = coordinationStorageBytes({ operation: "proposal.created", proposal, eventBody }, crypto.randomUUID());
      const receipt = this.coordinationProposalResponse(proposal, sourceMessages, state, cursor, false);
      const receiptText = JSON.stringify(receipt);
      const retryBytes = coordinationStorageBytes({ operation, retry_id: input.client_retry_id, fingerprint, receipt: receiptText });
      this.ensureCoordinationCapacity(state, proposal.byte_count + eventBytes + retryBytes);
      this.ctx.storage.sql.exec(
        "INSERT INTO coordination_proposals (proposal_id, revision, request_id, kind, actor_label, authority_class, base_revision, source_message_ids, body, created_at, byte_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        proposal.proposal_id, proposal.revision, proposal.request_id, proposal.kind, proposal.actor_label, proposal.authority_class, proposal.base_revision, proposal.source_message_ids, proposal.body, proposal.created_at, proposal.byte_count,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO coordination_events (cursor, event_id, operation, proposal_id, proposal_revision, request_id, kind, actor_label, authority_class, source_message_ids, base_revision, resulting_revision, body, created_at, byte_count) VALUES (?, ?, 'proposal.created', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
        cursor, crypto.randomUUID(), proposal.proposal_id, proposal.revision, proposal.request_id, proposal.kind, proposal.actor_label, proposal.authority_class, proposal.source_message_ids, proposal.base_revision, eventBody, now, eventBytes,
      );
      this.ctx.storage.sql.exec("INSERT INTO coordination_retries (operation, retry_id, fingerprint, receipt, created_at, byte_count) VALUES (?, ?, ?, ?, ?, ?)", operation, input.client_retry_id, fingerprint, receiptText, now, retryBytes);
      this.ctx.storage.sql.exec("UPDATE room_state SET coordination_cursor = ?, total_bytes = total_bytes + ? WHERE singleton = 1", cursor, proposal.byte_count + eventBytes + retryBytes);
      return { expired: false as const, replayed: false as const, response: receipt };
    });
  }

  private commitCoordinationPublication(input: CoordinationPublishInput, managementHash: string, now: number) {
    return this.ctx.storage.transactionSync(() => {
      const state = this.requireState();
      if (!state.management_hash || !compareCapabilities(managementHash, state.management_hash)) {
        throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404);
      }
      if (state.status !== "active" || now >= state.inactivity_expires_at) return { expired: true as const };
      const operation = "publication";
      const fingerprint = coordinationMutationFingerprint(input);
      const existingRetry = this.coordinationRetry(operation, input.client_retry_id);
      if (existingRetry) {
        if (existingRetry.fingerprint !== fingerprint) throw new ProtocolError(ERROR_CODES.conflict, "The coordination retry identifier is already used for another mutation.", 409);
        return { expired: false as const, replayed: true as const, response: { ...JSON.parse(existingRetry.receipt) as Record<string, unknown>, replayed: true } };
      }
      if (input.base_revision !== state.published_revision) {
        throw new ProtocolError(ERROR_CODES.staleRevision, "The published coordination state advanced; rebase the proposal before publishing.", 409, undefined, { current_revision: state.published_revision, submitted_base_revision: input.base_revision });
      }
      const proposal = rows<StoredCoordinationProposal>(this.ctx.storage.sql.exec("SELECT * FROM coordination_proposals WHERE proposal_id = ? AND revision = ?", input.proposal_id, input.revision))[0];
      if (!proposal) throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404);
      const latestProposal = rows<{ revision: number }>(this.ctx.storage.sql.exec("SELECT revision FROM coordination_proposals WHERE proposal_id = ? ORDER BY revision DESC LIMIT 1", input.proposal_id))[0];
      if (!latestProposal || latestProposal.revision !== input.revision) throw new ProtocolError(ERROR_CODES.conflict, "The proposal has a newer revision; review and publish the latest revision.", 409);
      if (proposal.kind === DECISION_PROPOSAL_KIND || proposal.kind === DECISION_POSITION_KIND) {
        return this.commitDecisionPublication(input, proposal, state, now, fingerprint, operation);
      }
      if (input.decision_publication !== undefined) throw new ProtocolError(ERROR_CODES.invalidBody, "decision_publication is only valid for decision.proposal.", 400);
      if (proposal.base_revision !== input.base_revision) {
        throw new ProtocolError(ERROR_CODES.staleRevision, "The proposal was based on a different published revision; rebase it before publishing.", 409, undefined, { current_revision: state.published_revision, submitted_base_revision: proposal.base_revision });
      }
      if (rows<{ proposal_id: string }>(this.ctx.storage.sql.exec("SELECT proposal_id FROM coordination_events WHERE proposal_id = ? AND proposal_revision = ? AND resulting_revision IS NOT NULL", proposal.proposal_id, proposal.revision))[0]) {
        throw new ProtocolError(ERROR_CODES.conflict, "The proposal revision has already been published.", 409);
      }
      const sourceMessages = this.requireCoordinationSources(JSON.parse(proposal.source_message_ids) as string[]);
      const nextRevision = state.published_revision + 1;
      const cursor = state.coordination_cursor + 1;
      const body = parseStoredCoordinationBody(proposal.kind, proposal.body);
      const previousRequestProjection = proposal.request_id === null ? undefined : rows<StoredCoordinationRequest>(this.ctx.storage.sql.exec("SELECT * FROM coordination_requests WHERE request_id = ?", proposal.request_id))[0];
      const previousPanelProjection = proposal.kind === COORDINATION_PANEL_KIND ? rows<StoredCoordinationPanel>(this.ctx.storage.sql.exec("SELECT * FROM coordination_panel WHERE singleton = 1"))[0] : undefined;
      let requestProjection: StoredCoordinationRequest | undefined;
      let panelProjection: StoredCoordinationPanel | undefined;
      let eventBody: string;
      let publicationOperation: "request.published" | "panel.published";
      if (proposal.kind === COORDINATION_KIND) {
        if (proposal.request_id === null) throw new ProtocolError(ERROR_CODES.conflict, "The request proposal is missing its request target.", 409);
        if (previousRequestProjection) throw new ProtocolError(ERROR_CODES.conflict, "The request already exists.", 409);
        const createBody = body as CoordinationRequestBody;
        requestProjection = {
          completion_criteria: JSON.stringify(createBody.completion_criteria),
          created_at: now,
          decision_impact: createBody.decision_impact,
          owner_label: createBody.owner_label,
          published_revision: nextRevision,
          purpose: createBody.purpose,
          request_id: proposal.request_id,
          requested_output: createBody.requested_output,
          status: "open",
          title: createBody.title,
          unknowns: JSON.stringify(createBody.unknowns),
          updated_at: now,
          byte_count: coordinationStorageBytes(createBody, proposal.request_id),
        };
        eventBody = JSON.stringify(createBody);
        publicationOperation = "request.published";
      } else if (proposal.kind === COORDINATION_PANEL_KIND) {
        const panelBody = body as CoordinationPanelBody;
        panelProjection = {
          artifacts: JSON.stringify(panelBody.artifacts),
          byte_count: coordinationStorageBytes(panelBody, proposal.proposal_id),
          next_actions: JSON.stringify(panelBody.next_actions),
          owner_label: input.owner_label,
          phase: panelBody.phase,
          proposal_id: proposal.proposal_id,
          proposal_revision: proposal.revision,
          published_at: now,
          published_revision: nextRevision,
          purpose: panelBody.purpose,
          singleton: 1,
          source_message_ids: proposal.source_message_ids,
        };
        eventBody = JSON.stringify(panelBody);
        publicationOperation = "panel.published";
      } else {
        if (!proposal.request_id || !previousRequestProjection) throw new ProtocolError(ERROR_CODES.notFound, "The requested coordination request was not found.", 404);
        const progressBody = body as CoordinationProgressBody;
        validateCoordinationTransition(previousRequestProjection.status, progressBody.status, progressBody.reopen_reason);
        const publishedEvidence = progressBody.evidence.map((evidence): CoordinationEvidenceItem => ({ ...evidence, reported_by: proposal.actor_label }));
        const progress: CoordinationProgress = {
          authority_class: "management",
          base_revision: input.base_revision,
          blockers: progressBody.blockers,
          evidence: publishedEvidence,
          published_at: iso(now),
          proposal_id: proposal.proposal_id,
          proposal_revision: proposal.revision,
          reported_by: proposal.actor_label,
          request_id: progressBody.request_id,
          source_message_ids: JSON.parse(proposal.source_message_ids) as string[],
          status: progressBody.status,
          ...(progressBody.reopen_reason === undefined ? {} : { reopen_reason: progressBody.reopen_reason }),
          ...(progressBody.unverified_explanation === undefined ? {} : { unverified_explanation: progressBody.unverified_explanation }),
        };
        const snapshot = {
          completion_criteria: JSON.parse(previousRequestProjection.completion_criteria) as string[],
          decision_impact: previousRequestProjection.decision_impact,
          owner_label: previousRequestProjection.owner_label,
          purpose: previousRequestProjection.purpose,
          requested_output: previousRequestProjection.requested_output,
          title: previousRequestProjection.title,
          unknowns: JSON.parse(previousRequestProjection.unknowns) as string[],
          blockers: progress.blockers,
          evidence: progress.evidence,
          status: progress.status,
          ...(progress.unverified_explanation === undefined ? {} : { unverified_explanation: progress.unverified_explanation }),
          progress,
        };
        requestProjection = {
          ...previousRequestProjection,
          byte_count: coordinationStorageBytes(snapshot, proposal.request_id),
          published_revision: nextRevision,
          status: progress.status,
          updated_at: now,
        };
        eventBody = JSON.stringify(snapshot);
        publicationOperation = "request.published";
      }
      const eventBytes = coordinationStorageBytes({ operation: publicationOperation, proposal, owner_label: input.owner_label, body: eventBody }, crypto.randomUUID());
      const receipt = this.coordinationPublicationResponse(proposal, requestProjection, panelProjection, sourceMessages, state, cursor, nextRevision, false, eventBody);
      const receiptText = JSON.stringify(receipt);
      const retryBytes = coordinationStorageBytes({ operation, retry_id: input.client_retry_id, fingerprint, proposal_id: input.proposal_id, revision: input.revision, receipt: receiptText });
      const previousProjection = proposal.kind === COORDINATION_PANEL_KIND ? previousPanelProjection : previousRequestProjection;
      const nextProjection = proposal.kind === COORDINATION_PANEL_KIND ? panelProjection : requestProjection;
      const projectionDelta = previousProjection === undefined ? nextProjection!.byte_count : nextProjection!.byte_count - previousProjection.byte_count;
      this.ensureCoordinationCapacity(state, Math.max(0, projectionDelta) + eventBytes + retryBytes);
      if (proposal.kind === COORDINATION_PANEL_KIND) {
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO coordination_panel (singleton, published_revision, proposal_id, proposal_revision, purpose, phase, artifacts, next_actions, source_message_ids, owner_label, published_at, byte_count) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          panelProjection!.published_revision, panelProjection!.proposal_id, panelProjection!.proposal_revision, panelProjection!.purpose, panelProjection!.phase, panelProjection!.artifacts, panelProjection!.next_actions, panelProjection!.source_message_ids, panelProjection!.owner_label, panelProjection!.published_at, panelProjection!.byte_count,
        );
      } else if (previousRequestProjection === undefined) {
        this.ctx.storage.sql.exec(
          "INSERT INTO coordination_requests (request_id, published_revision, purpose, title, owner_label, requested_output, unknowns, completion_criteria, decision_impact, status, created_at, updated_at, byte_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          requestProjection!.request_id, requestProjection!.published_revision, requestProjection!.purpose, requestProjection!.title, requestProjection!.owner_label, requestProjection!.requested_output, requestProjection!.unknowns, requestProjection!.completion_criteria, requestProjection!.decision_impact, requestProjection!.status, requestProjection!.created_at, requestProjection!.updated_at, requestProjection!.byte_count,
        );
      } else {
        this.ctx.storage.sql.exec(
          "UPDATE coordination_requests SET published_revision = ?, status = ?, updated_at = ?, byte_count = ? WHERE request_id = ?",
          requestProjection!.published_revision, requestProjection!.status, requestProjection!.updated_at, requestProjection!.byte_count, requestProjection!.request_id,
        );
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO coordination_events (cursor, event_id, operation, proposal_id, proposal_revision, request_id, kind, actor_label, authority_class, source_message_ids, base_revision, resulting_revision, body, created_at, byte_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'management', ?, ?, ?, ?, ?, ?)",
        cursor, crypto.randomUUID(), publicationOperation, proposal.proposal_id, proposal.revision, proposal.request_id, proposal.kind, input.owner_label, proposal.source_message_ids, input.base_revision, nextRevision, eventBody, now, eventBytes,
      );
      this.ctx.storage.sql.exec("INSERT INTO coordination_retries (operation, retry_id, fingerprint, receipt, created_at, byte_count) VALUES (?, ?, ?, ?, ?, ?)", operation, input.client_retry_id, fingerprint, receiptText, now, retryBytes);
      this.ctx.storage.sql.exec("UPDATE room_state SET coordination_cursor = ?, published_revision = ?, total_bytes = total_bytes + ? WHERE singleton = 1", cursor, nextRevision, projectionDelta + eventBytes + retryBytes);
      return { expired: false as const, replayed: false as const, response: receipt };
    });
  }

  private commitDecisionPublication(
    input: CoordinationPublishInput,
    proposal: StoredCoordinationProposal,
    state: RoomState,
    now: number,
    fingerprint: string,
    operation: string,
  ) {
    const sourceMessages = this.requireCoordinationSources(JSON.parse(proposal.source_message_ids) as string[]);
    const nextRevision = state.published_revision + 1;
    const cursor = state.coordination_cursor + 1;
    const decisionPublication = input.decision_publication;
    if (proposal.kind === DECISION_POSITION_KIND) {
      if (decisionPublication !== undefined) throw new ProtocolError(ERROR_CODES.invalidBody, "decision_publication is only valid for decision.proposal.", 400);
      if (proposal.base_revision !== input.base_revision) throw new ProtocolError(ERROR_CODES.staleRevision, "The decision position was based on a different published revision; rebase it before publishing.", 409, undefined, { current_revision: state.published_revision, submitted_base_revision: proposal.base_revision });
      if (rows<{ proposal_id: string }>(this.ctx.storage.sql.exec("SELECT proposal_id FROM coordination_events WHERE proposal_id = ? AND proposal_revision = ? AND resulting_revision IS NOT NULL", proposal.proposal_id, proposal.revision))[0]) throw new ProtocolError(ERROR_CODES.conflict, "The decision position has already been published.", 409);
      const body = parseStoredCoordinationBody(proposal.kind, proposal.body) as DecisionPositionBody;
      const target = rows<StoredCoordinationProposal>(this.ctx.storage.sql.exec("SELECT * FROM coordination_proposals WHERE proposal_id = ? AND revision = ?", body.decision_proposal_id, body.decision_revision))[0];
      if (!target || target.kind !== DECISION_PROPOSAL_KIND) throw new ProtocolError(ERROR_CODES.notFound, "The referenced decision proposal revision was not found in this room.", 404);
      if (rows<{ position_id: string }>(this.ctx.storage.sql.exec("SELECT position_id FROM coordination_decision_positions WHERE position_id = ?", proposal.proposal_id))[0]) {
        throw new ProtocolError(ERROR_CODES.conflict, "The decision position has already been published.", 409);
      }
      const position: StoredCoordinationDecisionPosition = {
        byte_count: coordinationStorageBytes(body, proposal.proposal_id),
        created_at: now,
        decision_id: body.decision_proposal_id,
        decision_revision: body.decision_revision,
        participant_label: body.participant_label,
        position_id: proposal.proposal_id,
        published_cursor: cursor,
        published_revision: nextRevision,
        reporter_label: proposal.actor_label,
        source_message_ids: proposal.source_message_ids,
        statement: body.statement,
      };
      const eventId = crypto.randomUUID();
      const eventBody = JSON.stringify({ ...body, position_id: position.position_id, reporter_label: position.reporter_label });
      const eventBytes = coordinationStorageBytes({ operation: "decision.position.published", proposal, body: eventBody }, eventId);
      const response = this.coordinationDecisionPositionPublicationResponse(proposal, position, sourceMessages, state, cursor, nextRevision);
      const receiptText = JSON.stringify(response);
      const retryBytes = coordinationStorageBytes({ operation, retry_id: input.client_retry_id, fingerprint, receipt: receiptText });
      this.ensureCoordinationCapacity(state, position.byte_count + eventBytes + retryBytes);
      this.ctx.storage.sql.exec(
        "INSERT INTO coordination_decision_positions (position_id, decision_id, decision_revision, participant_label, reporter_label, statement, source_message_ids, published_cursor, published_revision, created_at, byte_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        position.position_id, position.decision_id, position.decision_revision, position.participant_label, position.reporter_label, position.statement, position.source_message_ids, position.published_cursor, position.published_revision, position.created_at, position.byte_count,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO coordination_events (cursor, event_id, operation, proposal_id, proposal_revision, request_id, kind, actor_label, authority_class, source_message_ids, base_revision, resulting_revision, body, created_at, byte_count) VALUES (?, ?, 'decision.position.published', ?, ?, NULL, ?, ?, 'management', ?, ?, ?, ?, ?, ?)",
        cursor, eventId, proposal.proposal_id, proposal.revision, proposal.kind, input.owner_label, proposal.source_message_ids, input.base_revision, nextRevision, eventBody, now, eventBytes,
      );
      this.ctx.storage.sql.exec("INSERT INTO coordination_retries (operation, retry_id, fingerprint, receipt, created_at, byte_count) VALUES (?, ?, ?, ?, ?, ?)", operation, input.client_retry_id, fingerprint, receiptText, now, retryBytes);
      this.ctx.storage.sql.exec("UPDATE room_state SET coordination_cursor = ?, published_revision = ?, total_bytes = total_bytes + ? WHERE singleton = 1", cursor, nextRevision, position.byte_count + eventBytes + retryBytes);
      return { expired: false as const, replayed: false as const, response };
    }

    if (proposal.base_revision !== input.base_revision && (decisionPublication?.mode !== "acceptance" || !this.hasDecisionRecommendation(proposal.proposal_id, proposal.revision))) {
      throw new ProtocolError(ERROR_CODES.staleRevision, "The decision proposal was based on a different published revision; rebase it before publishing.", 409, undefined, { current_revision: state.published_revision, submitted_base_revision: proposal.base_revision });
    }
    if (decisionPublication === undefined) throw new ProtocolError(ERROR_CODES.invalidBody, "decision_publication is required for decision.proposal.", 400);
    const body = parseStoredCoordinationBody(proposal.kind, proposal.body) as DecisionProposalBody;
    const priorRecommendation = this.decisionRecommendation(proposal.proposal_id, proposal.revision);
    const priorAccepted = rows<StoredCoordinationAcceptedRecord>(this.ctx.storage.sql.exec("SELECT * FROM coordination_decision_accepted_records WHERE decision_id = ? LIMIT 1", proposal.proposal_id))[0];
    if (decisionPublication.mode === "recommendation") {
      if (priorRecommendation || priorAccepted) throw new ProtocolError(ERROR_CODES.conflict, "The exact decision proposal revision has already been recommended or accepted.", 409);
      if (proposal.base_revision !== input.base_revision) throw new ProtocolError(ERROR_CODES.staleRevision, "The decision proposal was based on a different published revision; rebase it before publishing.", 409, undefined, { current_revision: state.published_revision, submitted_base_revision: proposal.base_revision });
      const projection: StoredCoordinationDecision = {
        accepted_record_id: null,
        byte_count: coordinationStorageBytes({ decision_id: proposal.proposal_id, ...body, state: "recommended" }, proposal.proposal_id),
        decision_id: proposal.proposal_id,
        latest_proposal_revision: proposal.revision,
        proposal_text: body.proposal_text,
        recommendation_cursor: cursor,
        recommendation_published_revision: nextRevision,
        required_approver_labels: JSON.stringify(body.required_approver_labels),
        state: "recommended",
        title: body.title,
        updated_at: now,
      };
      const eventId = crypto.randomUUID();
      const eventBody = JSON.stringify({ ...body, decision_id: proposal.proposal_id, state: "recommended" });
      const eventBytes = coordinationStorageBytes({ operation: "decision.recommended", proposal, body: eventBody }, eventId);
      const response = this.coordinationDecisionPublicationResponse(proposal, projection, undefined, [], sourceMessages, state, cursor, nextRevision);
      const receiptText = JSON.stringify(response);
      const retryBytes = coordinationStorageBytes({ operation, retry_id: input.client_retry_id, fingerprint, receipt: receiptText });
      this.ensureCoordinationCapacity(state, projection.byte_count + eventBytes + retryBytes);
      this.ctx.storage.sql.exec(
        "INSERT INTO coordination_decisions (decision_id, latest_proposal_revision, title, proposal_text, required_approver_labels, state, recommendation_cursor, recommendation_published_revision, accepted_record_id, updated_at, byte_count) VALUES (?, ?, ?, ?, ?, 'recommended', ?, ?, NULL, ?, ?)",
        projection.decision_id, projection.latest_proposal_revision, projection.title, projection.proposal_text, projection.required_approver_labels, projection.recommendation_cursor, projection.recommendation_published_revision, projection.updated_at, projection.byte_count,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO coordination_events (cursor, event_id, operation, proposal_id, proposal_revision, request_id, kind, actor_label, authority_class, source_message_ids, base_revision, resulting_revision, body, created_at, byte_count) VALUES (?, ?, 'decision.recommended', ?, ?, NULL, ?, ?, 'management', ?, ?, ?, ?, ?, ?)",
        cursor, eventId, proposal.proposal_id, proposal.revision, proposal.kind, input.owner_label, proposal.source_message_ids, input.base_revision, nextRevision, eventBody, now, eventBytes,
      );
      this.ctx.storage.sql.exec("INSERT INTO coordination_retries (operation, retry_id, fingerprint, receipt, created_at, byte_count) VALUES (?, ?, ?, ?, ?, ?)", operation, input.client_retry_id, fingerprint, receiptText, now, retryBytes);
      this.ctx.storage.sql.exec("UPDATE room_state SET coordination_cursor = ?, published_revision = ?, total_bytes = total_bytes + ? WHERE singleton = 1", cursor, nextRevision, projection.byte_count + eventBytes + retryBytes);
      return { expired: false as const, replayed: false as const, response };
    }

    if (decisionPublication.mode !== "acceptance") throw new ProtocolError(ERROR_CODES.invalidBody, "The decision publication mode is not supported.", 400);
    if (priorAccepted) throw new ProtocolError(ERROR_CODES.conflict, "The decision already has an immutable accepted record.", 409);
    if (!priorRecommendation && proposal.base_revision !== input.base_revision) throw new ProtocolError(ERROR_CODES.staleRevision, "The decision proposal was based on a different published revision; rebase it before direct acceptance.", 409, undefined, { current_revision: state.published_revision, submitted_base_revision: proposal.base_revision });
    const acceptedRecordId = crypto.randomUUID();
    const approvals = this.validateDecisionApprovals(body.required_approver_labels, decisionPublication.approvals, proposal.proposal_id, proposal.revision, acceptedRecordId);
    const accepted: StoredCoordinationAcceptedRecord = {
      accepted_record_id: acceptedRecordId,
      byte_count: coordinationStorageBytes({ decision_id: proposal.proposal_id, decision_revision: proposal.revision, proposal_snapshot: body, required_approver_labels: body.required_approver_labels, owner_label: input.owner_label, owner_attestation: true }, acceptedRecordId),
      created_at: now,
      decision_id: proposal.proposal_id,
      decision_revision: proposal.revision,
      owner_attestation: 1,
      owner_label: input.owner_label,
      proposal_snapshot: JSON.stringify(body),
      publication_cursor: cursor,
      publication_revision: nextRevision,
      required_approver_labels: JSON.stringify(body.required_approver_labels),
    };
    const evidenceBytes = approvals.reduce((total, approval) => total + approval.byte_count, 0);
    const previousProjection = rows<StoredCoordinationDecision>(this.ctx.storage.sql.exec("SELECT * FROM coordination_decisions WHERE decision_id = ?", proposal.proposal_id))[0];
    const projection: StoredCoordinationDecision = {
      accepted_record_id: acceptedRecordId,
      byte_count: coordinationStorageBytes({ decision_id: proposal.proposal_id, ...body, state: "accepted", accepted_record_id: acceptedRecordId }, proposal.proposal_id),
      decision_id: proposal.proposal_id,
      latest_proposal_revision: proposal.revision,
      proposal_text: body.proposal_text,
      recommendation_cursor: previousProjection?.recommendation_cursor ?? cursor,
      recommendation_published_revision: previousProjection?.recommendation_published_revision ?? nextRevision,
      required_approver_labels: JSON.stringify(body.required_approver_labels),
      state: "accepted",
      title: body.title,
      updated_at: now,
    };
    const eventId = crypto.randomUUID();
    const eventBody = JSON.stringify({ ...body, accepted_record_id: acceptedRecordId, approvals: approvals.map((approval) => ({ participant_label: approval.participant_label, source_message_id: approval.source_message_id })), decision_id: proposal.proposal_id, state: "accepted" });
    const eventBytes = coordinationStorageBytes({ operation: "decision.accepted", proposal, body: eventBody }, eventId);
    const acceptedValue = this.toCoordinationAcceptedRecord(accepted);
    const response = this.coordinationDecisionPublicationResponse(proposal, projection, accepted, approvals, sourceMessages, state, cursor, nextRevision, acceptedValue);
    const receiptText = JSON.stringify(response);
    const retryBytes = coordinationStorageBytes({ operation, retry_id: input.client_retry_id, fingerprint, receipt: receiptText });
    const projectionDelta = previousProjection === undefined ? projection.byte_count : projection.byte_count - previousProjection.byte_count;
    this.ensureCoordinationCapacity(state, projectionDelta + accepted.byte_count + evidenceBytes + eventBytes + retryBytes);
    this.ctx.storage.sql.exec(
      "INSERT INTO coordination_decision_accepted_records (accepted_record_id, decision_id, decision_revision, proposal_snapshot, required_approver_labels, owner_label, owner_attestation, publication_cursor, publication_revision, created_at, byte_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      accepted.accepted_record_id, accepted.decision_id, accepted.decision_revision, accepted.proposal_snapshot, accepted.required_approver_labels, accepted.owner_label, accepted.owner_attestation, accepted.publication_cursor, accepted.publication_revision, accepted.created_at, accepted.byte_count,
    );
    for (const approval of approvals) {
      this.ctx.storage.sql.exec(
        "INSERT INTO coordination_decision_approval_evidence (approval_record_id, accepted_record_id, decision_id, decision_revision, participant_label, source_message_id, source_author, source_display_name, source_sequence, source_created_at, byte_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        approval.approval_record_id, acceptedRecordId, approval.decision_id, approval.decision_revision, approval.participant_label, approval.source_message_id, approval.source_author, approval.source_display_name, approval.source_sequence, approval.source_created_at, approval.byte_count,
      );
    }
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO coordination_decisions (decision_id, latest_proposal_revision, title, proposal_text, required_approver_labels, state, recommendation_cursor, recommendation_published_revision, accepted_record_id, updated_at, byte_count) VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?, ?)",
      projection.decision_id, projection.latest_proposal_revision, projection.title, projection.proposal_text, projection.required_approver_labels, projection.recommendation_cursor, projection.recommendation_published_revision, projection.accepted_record_id, projection.updated_at, projection.byte_count,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO coordination_events (cursor, event_id, operation, proposal_id, proposal_revision, request_id, kind, actor_label, authority_class, source_message_ids, base_revision, resulting_revision, body, created_at, byte_count) VALUES (?, ?, 'decision.accepted', ?, ?, NULL, ?, ?, 'management', ?, ?, ?, ?, ?, ?)",
      cursor, eventId, proposal.proposal_id, proposal.revision, proposal.kind, input.owner_label, proposal.source_message_ids, input.base_revision, nextRevision, eventBody, now, eventBytes,
    );
    this.ctx.storage.sql.exec("INSERT INTO coordination_retries (operation, retry_id, fingerprint, receipt, created_at, byte_count) VALUES (?, ?, ?, ?, ?, ?)", operation, input.client_retry_id, fingerprint, receiptText, now, retryBytes);
    this.ctx.storage.sql.exec("UPDATE room_state SET coordination_cursor = ?, published_revision = ?, total_bytes = total_bytes + ? WHERE singleton = 1", cursor, nextRevision, projectionDelta + accepted.byte_count + evidenceBytes + eventBytes + retryBytes);
    return { expired: false as const, replayed: false as const, response };
  }

  private async post(request: Request): Promise<Response> {
    if (this.config.MSG_POST_DISABLED === "1") {
      throw new ProtocolError(ERROR_CODES.serviceUnavailable, "New messages are temporarily unavailable.", 503);
    }
    const input = await request.json() as { based_on_sequence?: unknown; browser_id?: string; input: MessageInput; idempotency_key?: string };
    const now = this.now();
    const result = this.commitMessage(input.input, { basedOnSequence: input.based_on_sequence, idempotencyKey: input.idempotency_key, sourceBrowserId: input.browser_id ?? null }, now);
    if (result.expired) {
      await this.expire(now, "Conversation expired");
      throw new ProtocolError(ERROR_CODES.gone, "The conversation has expired.", 410);
    }
    await this.schedule();
    if (!result.replayed) this.broadcast({ protocol_version: PROTOCOL_VERSION, type: "message.created", sequence: result.message.sequence, latest_message: result.state.next_sequence - 1, expires_at: iso(result.state.inactivity_expires_at) });
    return this.json({ protocol_version: PROTOCOL_VERSION, message: this.toMessage(result.message), expires_at: iso(result.state.inactivity_expires_at), replayed: result.replayed });
  }

  private async getPost(request: Request): Promise<Response> {
    if (this.config.MSG_POST_DISABLED === "1") {
      throw new ProtocolError(ERROR_CODES.serviceUnavailable, "New messages are temporarily unavailable.", 503);
    }
    const input = await request.json() as { based_on_sequence?: unknown; input: MessageInput; request_id: string; token: string };
    const token = typeof input.token === "string" ? input.token : "";
    const requestId = validateRequestId(typeof input.request_id === "string" ? input.request_id : "");
    const tokenHash = await hashToken(token);
    const now = this.now();
    const result = this.commitMessage(
      input.input,
      {
        basedOnSequence: input.based_on_sequence,
        idempotencyKey: `get:${requestId}`,
        sourceBrowserId: null,
        authorize: (state) => {
          if (state.get_post_enabled !== 1 || !state.get_post_hash || !compareCapabilities(tokenHash, state.get_post_hash)) {
            throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404);
          }
        },
      },
      now,
    );
    if (result.expired) {
      await this.expire(now, "Conversation expired");
      throw new ProtocolError(ERROR_CODES.gone, "The conversation has expired.", 410);
    }
    await this.schedule();
    if (!result.replayed) this.broadcast({ protocol_version: PROTOCOL_VERSION, type: "message.created", sequence: result.message.sequence, latest_message: result.state.next_sequence - 1, expires_at: iso(result.state.inactivity_expires_at) });
    return this.json({
      accepted: true,
      message: { created_at: iso(result.message.created_at), id: result.message.id, sequence: result.message.sequence },
      protocol_version: PROTOCOL_VERSION,
      replayed: result.replayed,
      request_id: requestId,
      sequence: result.message.sequence,
    });
  }

  private commitMessage(
    input: MessageInput,
    options: {
      readonly authorize?: (state: RoomState) => void;
      readonly basedOnSequence?: unknown;
      /** An explicitly supplied idempotency key, such as a POST header or GET request ID. */
      readonly idempotencyKey?: string;
      readonly sourceBrowserId: string | null;
    },
    now: number,
  ) {
    return this.ctx.storage.transactionSync(() => {
      const state = this.requireState();
      if (this.config.MSG_POST_DISABLED === "1") {
        throw new ProtocolError(ERROR_CODES.serviceUnavailable, "New messages are temporarily unavailable.", 503);
      }
      options.authorize?.(state);
      if (state.status !== "active" || now >= state.inactivity_expires_at) return { expired: true as const };

      // Header and client IDs are independent retry namespaces. A client ID is
      // also retained as the legacy idempotency_key value when no header was
      // supplied, but it must never be looked up as an explicit header key.
      const byHeader = options.idempotencyKey === undefined ? undefined : this.messageByIdempotencyKey(options.idempotencyKey);
      const byClient = input.client_message_id ? this.messageByClientMessageId(input.client_message_id) : undefined;
      if (byHeader && byClient && byHeader.sequence !== byClient.sequence) throw new ProtocolError(ERROR_CODES.conflict, "The idempotency keys identify different messages.", 409);
      const previous = byHeader ?? byClient;
      if (previous) {
        if (!sameInput(previous, input)) throw new ProtocolError(ERROR_CODES.conflict, "The idempotency key is already used for another message.", 409);
        return { expired: false as const, message: previous, state, replayed: true };
      }
      const basedOnSequence = validateBasedOnSequence(options.basedOnSequence);
      const latestMessage = state.next_sequence - 1;
      if (basedOnSequence !== undefined) {
        if (basedOnSequence > latestMessage) {
          throw new ProtocolError(ERROR_CODES.invalidBody, "The based_on_sequence value cannot be newer than the room.", 400);
        }
        if (basedOnSequence < latestMessage) {
          throw new ProtocolError(
            ERROR_CODES.staleSequence,
            `The room advanced after sequence ${basedOnSequence}; review the intervening messages before resubmitting.`,
            409,
            undefined,
            { latest_message: latestMessage, review_after: basedOnSequence },
          );
        }
      }
      if (input.reply_to !== undefined && !this.messageBySequenceOptional(Number(input.reply_to))) {
        throw new ProtocolError(ERROR_CODES.notFound, "The replied-to message was not found.", 404);
      }
      const id = crypto.randomUUID();
      const key = options.idempotencyKey ?? input.client_message_id;
      const bytes = messageStorageBytes(input, key, id);
      if (state.message_count >= this.limits.maxMessages || state.total_bytes + bytes > this.limits.maxRoomBytes) {
        throw new ProtocolError(ERROR_CODES.rateLimited, "The room storage limit is reached.", 429);
      }
      const message: StoredMessage = { ...input, ...(key ? { idempotency_key: key } : {}), byte_count: bytes, created_at: now, id, sequence: state.next_sequence, source_browser_id: options.sourceBrowserId };
      this.insertMessage(message);
      this.queueWebhookDeliveries(message, now);
      this.queuePushDeliveries(message, now);
      const inactivity = now + this.limits.inactivityTtlMs;
      this.ctx.storage.sql.exec("UPDATE room_state SET last_message_at = ?, inactivity_expires_at = ?, next_sequence = ?, message_count = ?, total_bytes = ? WHERE singleton = 1", now, inactivity, state.next_sequence + 1, state.message_count + 1, state.total_bytes + bytes);
      return { expired: false as const, message, replayed: false, state: this.requireState() };
    });
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
      await this.schedule();
      return this.json({ protocol_version: PROTOCOL_VERSION, deleted: true, expires_at: iso(deleted.tombstone_expires_at!) });
    }
    return this.json({ protocol_version: PROTOCOL_VERSION, expires_at: iso(state.inactivity_expires_at), get_post_enabled: state.get_post_enabled === 1 });
  }

  private async managePost(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") ?? "";
    const input: unknown = await request.json();
    if (!isRecord(input) || (input.action !== "enable" && input.action !== "disable" && input.action !== "rotate")) {
      throw new ProtocolError(ERROR_CODES.invalidBody, "The management action must be enable, disable, or rotate.", 400);
    }
    const delegatedToken = input.action === "disable" ? undefined : input.get_post_token;
    if (input.action !== "disable" && (typeof delegatedToken !== "string" || !delegatedToken)) {
      throw new ProtocolError(ERROR_CODES.invalidBody, "The delegated posting capability is required.", 400);
    }
    const managementHash = await hashToken(token);
    const delegatedHash = typeof delegatedToken === "string" ? await hashToken(delegatedToken) : null;
    const now = this.now();
    const result = this.ctx.storage.transactionSync(() => {
      const state = this.requireState();
      if (!state.management_hash || !compareCapabilities(managementHash, state.management_hash)) {
        throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404);
      }
      if (state.status !== "active" || now >= state.inactivity_expires_at) return { expired: true as const };
      if (input.action === "disable") {
        this.ctx.storage.sql.exec("UPDATE room_state SET get_post_hash = NULL, get_post_enabled = 0 WHERE singleton = 1");
      } else {
        this.ctx.storage.sql.exec("UPDATE room_state SET get_post_hash = ?, get_post_enabled = 1 WHERE singleton = 1", delegatedHash);
      }
      return { expired: false as const, state: this.requireState() };
    });
    if (result.expired) {
      await this.expire(now, "Conversation expired");
      throw new ProtocolError(ERROR_CODES.gone, "The conversation has expired.", 410);
    }
    return this.json({ protocol_version: PROTOCOL_VERSION, expires_at: iso(result.state.inactivity_expires_at), get_post_enabled: result.state.get_post_enabled === 1 });
  }

  private async createWebhook(request: Request): Promise<Response> {
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

  private async listWebhooks(): Promise<Response> {
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

  private async removeWebhook(id: string): Promise<Response> {
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

  private async setWebhookEnabled(id: string, enabled: boolean): Promise<Response> {
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

  private async rotateWebhookSecret(id: string): Promise<Response> {
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

  private async redeliverWebhook(endpointId: string, eventId: string): Promise<Response> {
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
      this.ctx.storage.sql.exec("DELETE FROM webhook_delivery_attempts");
      this.ctx.storage.sql.exec("DELETE FROM webhook_deliveries");
      this.ctx.storage.sql.exec("DELETE FROM webhook_endpoints");
      this.ctx.storage.sql.exec("DELETE FROM push_deliveries");
      this.ctx.storage.sql.exec("DELETE FROM push_subscriptions");
      this.ctx.storage.sql.exec("DELETE FROM coordination_retries");
      this.ctx.storage.sql.exec("DELETE FROM coordination_events");
          this.ctx.storage.sql.exec("DELETE FROM coordination_proposals");
      this.ctx.storage.sql.exec("DELETE FROM coordination_requests");
      this.ctx.storage.sql.exec("DELETE FROM coordination_panel");
      this.ctx.storage.sql.exec("DELETE FROM coordination_decision_approval_evidence");
      this.ctx.storage.sql.exec("DELETE FROM coordination_decision_accepted_records");
      this.ctx.storage.sql.exec("DELETE FROM coordination_decision_positions");
      this.ctx.storage.sql.exec("DELETE FROM coordination_decisions");
      this.ctx.storage.sql.exec("UPDATE room_state SET status = 'deleted', tombstone_expires_at = ?, management_hash = NULL, get_post_hash = NULL, get_post_enabled = 0, message_count = 0, total_bytes = 0, coordination_cursor = 0, published_revision = 0 WHERE singleton = 1", now + this.limits.tombstoneTtlMs);
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

  private async schedule(): Promise<void> {
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

  private hasDecisionRecommendation(decisionId: string, revision: number): boolean {
    return this.decisionRecommendation(decisionId, revision) !== undefined;
  }

  private decisionRecommendation(decisionId: string, revision: number): StoredCoordinationEvent | undefined {
    return rows<StoredCoordinationEvent>(this.ctx.storage.sql.exec(
      "SELECT * FROM coordination_events WHERE operation = 'decision.recommended' AND proposal_id = ? AND proposal_revision = ? LIMIT 1",
      decisionId, revision,
    ))[0];
  }

  private validateDecisionApprovals(requiredLabels: readonly string[], approvals: readonly CoordinationDecisionApproval[], decisionId: string, decisionRevision: number, acceptedRecordId: string): StoredCoordinationApprovalEvidence[] {
    if (approvals.length !== requiredLabels.length) throw new ProtocolError(ERROR_CODES.conflict, "Decision acceptance requires one approval evidence record for every required participant label.", 409);
    const required = new Set(requiredLabels);
    const seen = new Set<string>();
    const result: StoredCoordinationApprovalEvidence[] = [];
    for (const approval of approvals) {
      if (!required.has(approval.participant_label) || seen.has(approval.participant_label)) throw new ProtocolError(ERROR_CODES.conflict, "Decision approval labels must exactly match the required participant labels.", 409);
      seen.add(approval.participant_label);
      const message = rows<StoredMessage>(this.ctx.storage.sql.exec("SELECT * FROM messages WHERE id = ?", approval.source_message_id))[0];
      if (!message) throw new ProtocolError(ERROR_CODES.notFound, "A decision approval source message was not found in this room.", 404);
      if (message.author !== approval.participant_label) throw new ProtocolError(ERROR_CODES.conflict, "A decision approval source message author does not match its required participant label.", 409);
      const approvalRecordId = crypto.randomUUID();
      result.push({
        accepted_record_id: acceptedRecordId,
        approval_record_id: approvalRecordId,
        byte_count: coordinationStorageBytes({ accepted_record_id: acceptedRecordId, approval_record_id: approvalRecordId, decision_id: decisionId, decision_revision: decisionRevision, participant_label: approval.participant_label, source_author: message.author, source_created_at: message.created_at, source_display_name: message.display_name, source_message_id: message.id, source_sequence: message.sequence }, approvalRecordId),
        decision_id: decisionId,
        decision_revision: decisionRevision,
        participant_label: approval.participant_label,
        source_author: message.author,
        source_created_at: message.created_at,
        source_display_name: message.display_name,
        source_message_id: message.id,
        source_sequence: message.sequence,
      });
    }
    if (seen.size !== required.size) throw new ProtocolError(ERROR_CODES.conflict, "Decision approval labels must exactly match the required participant labels.", 409);
    return result;
  }

  private coordinationRetry(operation: string, retryId: string): { readonly fingerprint: string; readonly receipt: string } | undefined {
    return rows<{ fingerprint: string; receipt: string }>(this.ctx.storage.sql.exec(
      "SELECT fingerprint, receipt FROM coordination_retries WHERE operation = ? AND retry_id = ?",
      operation, retryId,
    ))[0];
  }

  private requireCoordinationSources(ids: readonly string[]): StoredMessage[] {
    const messages: StoredMessage[] = [];
    for (const id of ids) {
      const message = rows<StoredMessage>(this.ctx.storage.sql.exec("SELECT * FROM messages WHERE id = ?", id))[0];
      if (!message) throw new ProtocolError(ERROR_CODES.notFound, "A coordination source message was not found in this room.", 404);
      messages.push(message);
    }
    return messages;
  }

  private ensureCoordinationCapacity(state: RoomState, addedBytes: number): void {
    if (state.total_bytes + addedBytes > this.limits.maxRoomBytes) {
      throw new ProtocolError(ERROR_CODES.rateLimited, "The room storage limit is reached.", 429);
    }
  }

  private coordinationProposalResponse(proposal: StoredCoordinationProposal, sourceMessages: readonly StoredMessage[], state: RoomState, cursor: number, replayed: boolean): Record<string, unknown> {
    const responseProposal = this.toCoordinationProposal(proposal, sourceMessages);
    return {
      coordination_cursor: cursor,
      expires_at: iso(state.inactivity_expires_at),
      latest_message: state.next_sequence - 1,
      proposal: responseProposal,
      protocol_version: PROTOCOL_VERSION,
      replayed,
      revisions: [responseProposal],
    };
  }

  private coordinationPublicationResponse(proposal: StoredCoordinationProposal, request: StoredCoordinationRequest | undefined, panel: StoredCoordinationPanel | undefined, sourceMessages: readonly StoredMessage[], state: RoomState, cursor: number, publishedRevision: number, replayed: boolean, eventBody?: string): Record<string, unknown> {
    const responseProposal = this.toCoordinationProposal(proposal, sourceMessages, "published");
    const selectedEvent = eventBody === undefined || request === undefined ? undefined : {
      actor_label: proposal.actor_label,
      authority_class: "management" as const,
      base_revision: proposal.base_revision,
      body: eventBody,
      created_at: request.updated_at,
      event_id: "",
      kind: proposal.kind as CoordinationKind,
      operation: "request.published",
      proposal_id: proposal.proposal_id,
      proposal_revision: proposal.revision,
      request_id: request.request_id,
      resulting_revision: publishedRevision,
      source_message_ids: proposal.source_message_ids,
      cursor,
      byte_count: request.byte_count,
    };
    const response: Record<string, unknown> = {
      coordination_cursor: cursor,
      expires_at: iso(state.inactivity_expires_at),
      latest_message: state.next_sequence - 1,
      protocol_version: PROTOCOL_VERSION,
      published_revision: publishedRevision,
      replayed,
      proposal: responseProposal,
    };
    if (request !== undefined) response.request = this.toCoordinationRequest(request, selectedEvent);
    if (panel !== undefined) {
      response.panel = this.toCoordinationPanel(panel);
      response.panel_published_revision = panel.published_revision;
    }
    return response;
  }

  private toCoordinationProposal(proposal: StoredCoordinationProposal, sourceMessages?: readonly StoredMessage[], statusOverride?: "pending" | "published" | "superseded", asOfCursor?: number): CoordinationProposal {
    const body = parseStoredCoordinationBody(proposal.kind, proposal.body);
    const sourceIds = JSON.parse(proposal.source_message_ids) as string[];
    const publication = rows<{ proposal_revision: number }>(this.ctx.storage.sql.exec("SELECT proposal_revision FROM coordination_events WHERE proposal_id = ? AND proposal_revision = ? AND resulting_revision IS NOT NULL AND (? IS NULL OR cursor <= ?)", proposal.proposal_id, proposal.revision, asOfCursor ?? null, asOfCursor ?? null))[0];
    const request = proposal.request_id === null ? undefined : rows<{ request_id: string }>(this.ctx.storage.sql.exec("SELECT request_id FROM coordination_requests WHERE request_id = ?", proposal.request_id))[0];
    const newerRevision = rows<{ revision: number }>(this.ctx.storage.sql.exec(
      "SELECT p.revision FROM coordination_proposals AS p JOIN coordination_events AS e ON e.proposal_id = p.proposal_id AND e.proposal_revision = p.revision AND e.operation = 'proposal.created' WHERE p.proposal_id = ? AND p.revision > ? AND (? IS NULL OR e.cursor <= ?) LIMIT 1",
      proposal.proposal_id, proposal.revision, asOfCursor ?? null, asOfCursor ?? null,
    ))[0];
    const requestPublishedAtSnapshot = proposal.kind === COORDINATION_KIND
      ? asOfCursor === undefined
        ? request !== undefined
        : rows<{ request_id: string }>(this.ctx.storage.sql.exec("SELECT request_id FROM coordination_events WHERE operation = 'request.published' AND proposal_id = ? AND proposal_revision = ? AND cursor <= ? LIMIT 1", proposal.proposal_id, proposal.revision, asOfCursor))[0]
      : undefined;
    const sources = sourceMessages ?? this.requireCoordinationSources(sourceIds);
    return {
      actor_label: proposal.actor_label,
      authority_class: proposal.authority_class,
      base_revision: proposal.base_revision,
      body,
      created_at: iso(proposal.created_at),
      detail_url: `/coordination/proposals/${encodeURIComponent(proposal.proposal_id)}`,
      kind: proposal.kind,
      proposal_id: proposal.proposal_id,
      request_id: proposal.request_id,
      revision: proposal.revision,
      source_message_ids: sourceIds,
      source_messages: sources.map((message): CoordinationSourceMessage => ({
        author: message.author,
        created_at: iso(message.created_at),
        display_name: message.display_name,
        id: message.id,
        sequence: message.sequence,
        citation_url: `/messages/${encodeURIComponent(message.id)}`,
      })),
      status: statusOverride ?? (publication ? "published" : newerRevision || requestPublishedAtSnapshot ? "superseded" : "pending"),
    };
  }

  private toCoordinationDecisionSummary(decision: StoredCoordinationDecision): import("./protocol").CoordinationDecisionSummary {
    return {
      ...(decision.accepted_record_id === null ? {} : { accepted_record_id: decision.accepted_record_id }),
      decision_id: decision.decision_id,
      detail_url: `/coordination/decisions/${encodeURIComponent(decision.decision_id)}`,
      latest_proposal_revision: decision.latest_proposal_revision,
      proposal_text: decision.proposal_text,
      published_revision: this.decisionPublishedRevision(decision),
      required_approver_labels: JSON.parse(decision.required_approver_labels) as string[],
      state: decision.state,
      title: decision.title,
    };
  }

  private toCoordinationDecision(decision: StoredCoordinationDecision, positions: readonly CoordinationDecisionPosition[] = []): CoordinationDecision {
    return {
      ...(decision.accepted_record_id === null ? {} : { accepted_record_id: decision.accepted_record_id }),
      decision_id: decision.decision_id,
      detail_url: `/coordination/decisions/${encodeURIComponent(decision.decision_id)}`,
      latest_proposal_revision: decision.latest_proposal_revision,
      positions,
      proposal_text: decision.proposal_text,
      published_revision: this.decisionPublishedRevision(decision),
      required_approver_labels: JSON.parse(decision.required_approver_labels) as string[],
      state: decision.state,
      title: decision.title,
    };
  }

  private decisionPublishedRevision(decision: StoredCoordinationDecision): number {
    if (decision.accepted_record_id !== null) {
      const accepted = rows<{ publication_revision: number }>(this.ctx.storage.sql.exec("SELECT publication_revision FROM coordination_decision_accepted_records WHERE accepted_record_id = ?", decision.accepted_record_id))[0];
      if (accepted) return accepted.publication_revision;
    }
    return decision.recommendation_published_revision;
  }

  private toCoordinationDecisionFromEvent(event: StoredCoordinationEvent): CoordinationDecision {
    const body = JSON.parse(event.body) as DecisionProposalBody & { readonly accepted_record_id?: string };
    const acceptedRecordId = body.accepted_record_id;
    return {
      ...(acceptedRecordId === undefined ? {} : { accepted_record_id: acceptedRecordId }),
      decision_id: event.proposal_id!,
      detail_url: `/coordination/decisions/${encodeURIComponent(event.proposal_id!)}`,
      latest_proposal_revision: event.proposal_revision!,
      proposal_text: body.proposal_text,
      published_revision: event.resulting_revision!,
      required_approver_labels: body.required_approver_labels,
      state: event.operation === "decision.accepted" ? "accepted" : "recommended",
      title: body.title,
    };
  }

  private toCoordinationDecisionHistoryEntry(event: StoredCoordinationEvent, decisionId: string): CoordinationDecisionHistoryEntry {
    const base = {
      actor_label: event.actor_label,
      authority_class: event.authority_class,
      body: JSON.parse(event.body) as CoordinationProposalBody,
      cursor: event.cursor,
      event_id: event.event_id,
      kind: event.kind,
      operation: event.operation,
      proposal_id: event.proposal_id,
      proposal_revision: event.proposal_revision,
      published_revision: event.resulting_revision,
      source_message_ids: JSON.parse(event.source_message_ids) as string[],
    };
    if (event.operation === "decision.position.published") {
      const position = rows<StoredCoordinationDecisionPosition>(this.ctx.storage.sql.exec("SELECT * FROM coordination_decision_positions WHERE position_id = ? AND decision_id = ?", event.proposal_id, decisionId))[0];
      return position === undefined ? base : { ...base, position: this.toCoordinationDecisionPosition(position) };
    }
    const proposal = event.proposal_id === null || event.proposal_revision === null
      ? undefined
      : rows<StoredCoordinationProposal>(this.ctx.storage.sql.exec("SELECT * FROM coordination_proposals WHERE proposal_id = ? AND revision = ?", event.proposal_id, event.proposal_revision))[0];
    return proposal === undefined ? base : { ...base, proposal: this.toCoordinationProposal(proposal, undefined, "published", event.cursor) };
  }

  private toCoordinationDecisionPosition(position: StoredCoordinationDecisionPosition): CoordinationDecisionPosition {
    const sourceIds = JSON.parse(position.source_message_ids) as string[];
    const sources = this.requireCoordinationSources(sourceIds);
    return {
      decision_proposal_id: position.decision_id,
      decision_revision: position.decision_revision,
      participant_label: position.participant_label,
      position_id: position.position_id,
      published_at: iso(position.created_at),
      published_revision: position.published_revision,
      reporter_label: position.reporter_label,
      source_message_ids: sourceIds,
      source_messages: sources.map((message) => ({
        author: message.author,
        created_at: iso(message.created_at),
        display_name: message.display_name,
        id: message.id,
        sequence: message.sequence,
        citation_url: `/messages/${encodeURIComponent(message.id)}`,
      })),
      statement: position.statement,
    };
  }

  private toCoordinationAcceptedRecord(record: StoredCoordinationAcceptedRecord): CoordinationAcceptedRecord {
    return {
      accepted_record_id: record.accepted_record_id,
      decision_id: record.decision_id,
      decision_revision: record.decision_revision,
      owner_attestation: true,
      owner_label: record.owner_label,
      publication_cursor: record.publication_cursor,
      publication_revision: record.publication_revision,
      published_at: iso(record.created_at),
      proposal_snapshot: JSON.parse(record.proposal_snapshot) as DecisionProposalBody,
      required_approver_labels: JSON.parse(record.required_approver_labels) as string[],
    };
  }

  private toCoordinationApprovalEvidence(approval: StoredCoordinationApprovalEvidence): CoordinationDecisionApprovalEvidence {
    return {
      accepted_record_id: approval.accepted_record_id,
      approval_record_id: approval.approval_record_id,
      participant_label: approval.participant_label,
      source_message_id: approval.source_message_id,
      citation_url: `/messages/${encodeURIComponent(approval.source_message_id)}`,
      decision_id: approval.decision_id,
      decision_revision: approval.decision_revision,
      source_author: approval.source_author,
      source_created_at: iso(approval.source_created_at),
      source_display_name: approval.source_display_name,
      source_sequence: approval.source_sequence,
    };
  }

  private coordinationDecisionPublicationResponse(
    proposal: StoredCoordinationProposal,
    decision: StoredCoordinationDecision,
    accepted: StoredCoordinationAcceptedRecord | undefined,
    approvals: readonly StoredCoordinationApprovalEvidence[],
    sourceMessages: readonly StoredMessage[],
    state: RoomState,
    cursor: number,
    publishedRevision: number,
    acceptedValue?: CoordinationAcceptedRecord,
  ): Record<string, unknown> {
    const response: Record<string, unknown> = {
      coordination_cursor: cursor,
      decision: this.toCoordinationDecision(decision),
      expires_at: iso(state.inactivity_expires_at),
      latest_message: state.next_sequence - 1,
      proposal: this.toCoordinationProposal(proposal, sourceMessages, "published"),
      protocol_version: PROTOCOL_VERSION,
      published_revision: publishedRevision,
      replayed: false,
    };
    if (accepted !== undefined) {
      response.accepted_record = acceptedValue ?? this.toCoordinationAcceptedRecord(accepted);
      response.approvals = approvals.map((approval) => this.toCoordinationApprovalEvidence(approval));
    }
    return response;
  }

  private coordinationDecisionPositionPublicationResponse(
    proposal: StoredCoordinationProposal,
    position: StoredCoordinationDecisionPosition,
    sourceMessages: readonly StoredMessage[],
    state: RoomState,
    cursor: number,
    publishedRevision: number,
  ): Record<string, unknown> {
    return {
      coordination_cursor: cursor,
      expires_at: iso(state.inactivity_expires_at),
      latest_message: state.next_sequence - 1,
      position: this.toCoordinationDecisionPosition(position),
      proposal: this.toCoordinationProposal(proposal, sourceMessages, "published"),
      protocol_version: PROTOCOL_VERSION,
      published_revision: publishedRevision,
      replayed: false,
    };
  }

  private toCoordinationPanel(value: StoredCoordinationPanel | StoredCoordinationEvent): CoordinationPanel {
    const event = "event_id" in value;
    const rawBody = "event_id" in value ? value.body : JSON.stringify({
      artifacts: JSON.parse(value.artifacts),
      next_actions: JSON.parse(value.next_actions),
      phase: value.phase,
      purpose: value.purpose,
    });
    const body = parseStoredCoordinationBody(COORDINATION_PANEL_KIND, rawBody) as CoordinationPanelBody;
    const sourceIds = JSON.parse(value.source_message_ids) as string[];
    const sources = this.requireCoordinationSources(sourceIds);
    const publishedRevision = event ? value.resulting_revision! : value.published_revision;
    const proposalId = value.proposal_id!;
    const proposalRevision = value.proposal_revision!;
    const ownerLabel = event ? value.actor_label : value.owner_label;
    const publishedAt = event ? value.created_at : value.published_at;
    return {
      artifacts: body.artifacts,
      authority_class: "management",
      body,
      next_actions: body.next_actions,
      owner_label: ownerLabel,
      phase: body.phase,
      proposal_id: proposalId,
      proposal_revision: proposalRevision,
      published_at: iso(publishedAt),
      published_revision: publishedRevision,
      purpose: body.purpose,
      source_message_ids: sourceIds,
      source_messages: sources.map((message): CoordinationSourceMessage => ({
        author: message.author,
        created_at: iso(message.created_at),
        display_name: message.display_name,
        id: message.id,
        sequence: message.sequence,
        citation_url: `/messages/${encodeURIComponent(message.id)}`,
      })),
    };
  }

  private toCoordinationPanelOverview(value: StoredCoordinationPanel | StoredCoordinationEvent): CoordinationPanel {
    const full = this.toCoordinationPanel(value);
    const artifacts = full.artifacts.slice(0, 5);
    const nextActions = full.next_actions.slice(0, 5);
    const sourceMessages = full.source_messages.slice(0, 5);
    const sourceMessageIds = full.source_message_ids.slice(0, 5);
    const body: CoordinationPanelBody = {
      artifacts,
      next_actions: nextActions,
      phase: full.phase,
      purpose: full.purpose,
    };
    return {
      ...full,
      artifact_count: full.artifacts.length,
      artifacts_truncated: artifacts.length < full.artifacts.length,
      body,
      next_action_count: full.next_actions.length,
      next_actions: nextActions,
      next_actions_truncated: nextActions.length < full.next_actions.length,
      source_message_count: full.source_message_ids.length,
      source_message_ids: sourceMessageIds,
      source_messages: sourceMessages,
      source_messages_truncated: sourceMessages.length < full.source_messages.length,
    };
  }

  private toCoordinationProposalSummary(proposal: StoredCoordinationProposal): CoordinationProposalSummary {
    const body = parseStoredCoordinationBody(proposal.kind, proposal.body);
    const title = proposal.kind === COORDINATION_KIND
      ? (body as CoordinationRequestBody).title
      : proposal.kind === COORDINATION_PANEL_KIND
        ? "Published room panel"
        : proposal.kind === DECISION_PROPOSAL_KIND
          ? (body as DecisionProposalBody).title
          : proposal.kind === DECISION_POSITION_KIND
            ? `Reported position: ${(body as DecisionPositionBody).participant_label}`
            : `Progress report: ${(body as CoordinationProgressBody).status}`;
    const published = rows<{ proposal_revision: number }>(this.ctx.storage.sql.exec("SELECT proposal_revision FROM coordination_events WHERE proposal_id = ? AND proposal_revision = ? AND resulting_revision IS NOT NULL", proposal.proposal_id, proposal.revision))[0] !== undefined;
    const superseded = !published && rows<{ revision: number }>(this.ctx.storage.sql.exec(
      "SELECT revision FROM coordination_proposals WHERE proposal_id = ? AND revision > ? LIMIT 1",
      proposal.proposal_id, proposal.revision,
    ))[0] !== undefined;
    return {
      actor_label: proposal.actor_label,
      authority_class: proposal.authority_class,
      base_revision: proposal.base_revision,
      created_at: iso(proposal.created_at),
      detail_url: `/coordination/proposals/${encodeURIComponent(proposal.proposal_id)}`,
      kind: proposal.kind,
      proposal_id: proposal.proposal_id,
      request_id: proposal.request_id,
      revision: proposal.revision,
      status: published ? "published" : superseded ? "superseded" : "pending",
      title,
    };
  }

  private coordinationRequestFromEvent(event: StoredCoordinationEvent): StoredCoordinationRequest {
    const snapshot = this.coordinationProgressSnapshot(event.body);
    const body = parseStoredCoordinationSnapshotBody(event.body);
    const original = body.original;
    const creation = rows<{ created_at: number }>(this.ctx.storage.sql.exec(
      "SELECT created_at FROM coordination_events WHERE operation = 'request.published' AND request_id = ? AND kind = ? ORDER BY resulting_revision ASC LIMIT 1",
      event.request_id, COORDINATION_KIND,
    ))[0];
    return {
      completion_criteria: JSON.stringify(original.completion_criteria),
      created_at: creation?.created_at ?? event.created_at,
      decision_impact: original.decision_impact,
      owner_label: original.owner_label,
      published_revision: event.resulting_revision ?? 0,
      purpose: original.purpose,
      request_id: event.request_id!,
      requested_output: original.requested_output,
      status: snapshot.status,
      title: original.title,
      unknowns: JSON.stringify(original.unknowns),
      updated_at: event.created_at,
      byte_count: event.byte_count,
    };
  }

  private coordinationProgressSnapshot(rawBody: string): CoordinationProgressSnapshot {
    const snapshot = parseStoredCoordinationSnapshotBody(rawBody);
    if (!snapshot.progress) return { blockers: [], evidence: [], status: "open" };
    return {
      blockers: snapshot.blockers,
      evidence: snapshot.evidence,
      progress: snapshot.progress,
      status: snapshot.status,
      ...(snapshot.unverified_explanation === undefined ? {} : { unverified_explanation: snapshot.unverified_explanation }),
    };
  }

  private toCoordinationRequest(request: StoredCoordinationRequest, selectedEvent?: StoredCoordinationEvent): CoordinationRequest {
    const latestEvent = selectedEvent ?? rows<StoredCoordinationEvent>(this.ctx.storage.sql.exec(
      "SELECT * FROM coordination_events WHERE operation = 'request.published' AND request_id = ? ORDER BY resulting_revision DESC LIMIT 1",
      request.request_id,
    ))[0];
    const snapshot = latestEvent === undefined ? undefined : this.coordinationProgressSnapshot(latestEvent.body);
    return {
      body: {
        completion_criteria: JSON.parse(request.completion_criteria) as string[],
        decision_impact: request.decision_impact,
        owner_label: request.owner_label,
        purpose: request.purpose,
        requested_output: request.requested_output,
        title: request.title,
        unknowns: JSON.parse(request.unknowns) as string[],
      },
      created_at: iso(request.created_at),
      detail_url: `/coordination/requests/${encodeURIComponent(request.request_id)}`,
      blockers: snapshot?.blockers ?? [],
      evidence: snapshot?.evidence ?? [],
      published_revision: request.published_revision,
      request_id: request.request_id,
      status: request.status,
      updated_at: iso(request.updated_at),
      ...(snapshot?.progress === undefined ? {} : { progress: snapshot.progress }),
      ...(snapshot?.unverified_explanation === undefined ? {} : { unverified_explanation: snapshot.unverified_explanation }),
    };
  }

  private toCoordinationRequestSummary(request: StoredCoordinationRequest): CoordinationRequestSummary {
    return {
      detail_url: `/coordination/requests/${encodeURIComponent(request.request_id)}`,
      owner_label: request.owner_label,
      published_revision: request.published_revision,
      request_id: request.request_id,
      status: request.status,
      title: request.title,
      updated_at: iso(request.updated_at),
    };
  }

  private publicRoomPath(): string { return "/coordination"; }

  private state(): RoomState | undefined { return rows<RoomState>(this.ctx.storage.sql.exec("SELECT * FROM room_state WHERE singleton = 1"))[0]; }
  private requireState(): RoomState { const state = this.state(); if (!state) throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404); return state; }
  private requireActiveState(): RoomState {
    const state = this.requireState();
    if (state.status === "deleted") throw new ProtocolError(ERROR_CODES.gone, "The conversation has expired.", 410);
    return state;
  }
  private async prepareActive(now: number): Promise<void> {
    const state = this.requireActiveState();
    if (now >= state.inactivity_expires_at) {
      await this.expire(now, "Conversation expired");
      throw new ProtocolError(ERROR_CODES.gone, "The conversation has expired.", 410);
    }
    await this.schedule();
    const current = this.requireActiveState();
    const currentNow = this.now();
    if (currentNow >= current.inactivity_expires_at) {
      await this.expire(currentNow, "Conversation expired");
      throw new ProtocolError(ERROR_CODES.gone, "The conversation has expired.", 410);
    }
  }
  private async requireActive(now: number): Promise<RoomState> { await this.prepareActive(now); return this.requireActiveState(); }
  private messageBySequence(sequence: number): StoredMessage { const message = rows<StoredMessage>(this.ctx.storage.sql.exec("SELECT * FROM messages WHERE sequence = ?", sequence))[0]; if (!message) throw new Error("Initial message was not stored."); return message; }
  private messageBySequenceOptional(sequence: number): StoredMessage | undefined { return rows<StoredMessage>(this.ctx.storage.sql.exec("SELECT * FROM messages WHERE sequence = ?", sequence))[0]; }
  private messageByIdempotencyKey(key: string): StoredMessage | undefined { return rows<StoredMessage>(this.ctx.storage.sql.exec("SELECT * FROM messages WHERE idempotency_key = ?", key))[0]; }
  private messageByClientMessageId(key: string): StoredMessage | undefined { return rows<StoredMessage>(this.ctx.storage.sql.exec("SELECT * FROM messages WHERE client_message_id = ?", key))[0]; }
  private toMessage(message: StoredMessage) { return { id: message.id, sequence: message.sequence, content: message.content, author: message.author, display_name: message.display_name, identity_verified: false as const, ...(message.client ? { client: message.client } : {}), semantic_type: message.semantic_type, ...(message.reply_to ? { reply_to: message.reply_to } : {}), created_at: iso(message.created_at), ...(message.client_message_id ? { client_message_id: message.client_message_id } : {}), byte_count: message.byte_count }; }
  private async expire(now: number, reason: string): Promise<void> { if (!this.deleteToTombstone(now)) return; this.broadcast({ protocol_version: PROTOCOL_VERSION, type: "conversation.expired" }); this.closeSockets(1001, reason); await this.schedule(); }
  private broadcast(frame: unknown): void { const payload = JSON.stringify(frame); for (const socket of this.ctx.getWebSockets(socketTag) as HibernatingSocket[]) socket.send(payload); }
  private closeSockets(code: number, reason: string): void { for (const socket of this.ctx.getWebSockets(socketTag) as HibernatingSocket[]) socket.close(code, reason); }
  private json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { headers: { "content-type": "application/json; charset=utf-8" }, status }); }
  private error(code: string, message: string, status: number, details?: StaleSequenceDetails | StaleRevisionDetails): Response {
    return new Response(JSON.stringify({ error: {
      code,
      message,
      ...(code === ERROR_CODES.staleSequence && isStaleSequenceDetails(details) ? { latest_message: details.latest_message, review_after: details.review_after } : {}),
      ...(code === ERROR_CODES.staleRevision && isStaleRevisionDetails(details) ? { current_revision: details.current_revision, submitted_base_revision: details.submitted_base_revision } : {}),
    } }), { headers: { "content-type": "application/json; charset=utf-8" }, status });
  }
}

interface StoredCoordinationSnapshotBody {
  readonly original: CoordinationRequestBody;
  readonly blockers: readonly string[];
  readonly evidence: readonly CoordinationEvidenceItem[];
  readonly status: CoordinationStatus;
  readonly progress?: CoordinationProgress;
  readonly unverified_explanation?: string;
}

function parseStoredCoordinationBody(kind: CoordinationKind, raw: string): CoordinationProposalBody {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) throw new Error("Stored coordination body is invalid.");
  return kind === COORDINATION_KIND
    ? value as unknown as CoordinationRequestBody
    : kind === COORDINATION_PROGRESS_KIND
      ? value as unknown as CoordinationProgressBody
      : kind === COORDINATION_PANEL_KIND
        ? value as unknown as CoordinationPanelBody
        : kind === DECISION_PROPOSAL_KIND
          ? value as unknown as DecisionProposalBody
          : value as unknown as DecisionPositionBody;
}

function parseStoredCoordinationSnapshotBody(raw: string): StoredCoordinationSnapshotBody {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) throw new Error("Stored coordination snapshot is invalid.");
  const original = {
    completion_criteria: value.completion_criteria as string[],
    decision_impact: value.decision_impact as string,
    owner_label: value.owner_label as string,
    purpose: value.purpose as string,
    requested_output: value.requested_output as string,
    title: value.title as string,
    unknowns: value.unknowns as string[],
  } satisfies CoordinationRequestBody;
  const status = value.status === "in_progress" || value.status === "blocked" || value.status === "done" || value.status === "withdrawn" ? value.status : "open";
  const blockers = Array.isArray(value.blockers) ? value.blockers as string[] : [];
  const evidence = Array.isArray(value.evidence) ? value.evidence as CoordinationEvidenceItem[] : [];
  const progress = isRecord(value.progress) ? value.progress as unknown as CoordinationProgress : undefined;
  return {
    original,
    blockers,
    evidence,
    status,
    ...(progress === undefined ? {} : { progress }),
    ...(typeof value.unverified_explanation === "string" ? { unverified_explanation: value.unverified_explanation } : {}),
  };
}

function validateCoordinationTransition(current: CoordinationStatus, next: CoordinationStatus, reopenReason: string | undefined): void {
  if ((current === "done" || current === "withdrawn") && (next === "open" || next === "in_progress" || next === "blocked") && !reopenReason) {
    throw new ProtocolError(ERROR_CODES.conflict, "Reopening a done or withdrawn request requires a reason.", 409);
  }
}

function createDeferredSignal(): DeferredSignal {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = () => done(); });
  return { promise, resolve };
}

function rows<T>(cursor: Iterable<unknown>): T[] { return [...cursor] as T[]; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function iso(value: number): string { return new Date(value).toISOString(); }
function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404);
  }
}
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
