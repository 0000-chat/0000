import { AGENT_INSTRUCTIONS, jsonResponse, OPENAPI_DOCUMENT, renderDiscovery } from "./discovery";
import { buildAgentRepresentation, renderAgentText } from "./agent-representation";
import { agentBrowserAsset, renderAgentHomePage, renderAgentRoomPage, renderAgentStatusPage } from "./agent-browser";
import { browserAsset, browserIcon, MERMAID_ASSET_PATH, renderBrowserDocument } from "./browser";
import { browserViewRedirect, selectBrowserView } from "./browser-view";
import { ERROR_CODES, isStaleRevisionDetails, isStaleSequenceDetails, ProtocolError, type ErrorCode, type StaleRevisionDetails, type StaleSequenceDetails } from "./errors";
import {
  foregroundWaitForConversation,
  messageCitationUrl,
  NAME_PASSWORD_NOTICE,
  PROTOCOL_VERSION,
  sequenceCitationUrl,
  stripLegacyAbsoluteExpiry,
  type CreateRoomResponse,
  type GetPostMessageResponse,
  type ReadMessageResponse,
  type RequestBody,
  type ManageRoomResponse,
  type ReadRoomResponse,
  type RetentionExtensionResponse,
  type RoomService,
} from "./protocol";
import { byteLength, compareCapabilities, DEFAULT_READ_LIMIT, MAX_ROOM_REQUEST_BYTES, parseBasedOnSequence, roomEtag, validateBasedOnSequenceQuery, validateBoundedCursor, validateCursor, validateIdempotencyKey, validateReadLimit, validateRequestId, validateThrough } from "./room-domain";
import { coordinationEtag } from "./room-domain";
import { parseCoordinationClaimPath, parseCoordinationListSelectors } from "./coordination-domain";
import {
  negotiateCreateRepresentation,
  negotiateRepresentation,
  parseRequestBody,
} from "./request";
import { applySecurityHeaders } from "./security";
import { DurableRoomService, type RoomNamespace } from "./room-service";
import { emitMsgEvent } from "./observability";
import { normalizeWebhookUrl } from "./webhooks";
import { PUSH_SERVICE_WORKER_PATH, pushServiceWorkerResponse } from "./push-service-worker";
import { parsePushBrowserId, parsePushSubscription } from "./push-subscriptions";

export interface MsgWorker {
  fetch(request: Request): Promise<Response>;
}

export interface MsgRateLimit {
  limit(input: { readonly key: string }): Promise<{ readonly success: boolean }>;
}

export interface MsgRateLimits {
  readonly creation?: MsgRateLimit;
  readonly live?: MsgRateLimit;
  readonly posts?: MsgRateLimit;
  readonly reads?: MsgRateLimit;
}

export interface MsgStaticAssets {
  fetch(request: Request): Promise<Response>;
}

export interface MsgWorkerOptions {
  readonly assets?: MsgStaticAssets;
  readonly createDisabled?: boolean;
  readonly operations?: Operations;
  readonly operatorToken?: string;
  readonly postDisabled?: boolean;
  readonly pushConfigured?: boolean;
  readonly pushVapidPublicKey?: string;
  readonly rateLimits?: MsgRateLimits;
}

export type CreationClaim =
  | { readonly kind: "claimed"; readonly leaseToken: string; readonly plan: { readonly management: string; readonly room: string } }
  | { readonly kind: "complete"; readonly response: CreateRoomResponse }
  | { readonly kind: "conflict" }
  | { readonly kind: "pending" };

export interface CreationOperations {
  claimCreation(key: string, fingerprint: string): Promise<CreationClaim>;
  completeCreation(key: string, leaseToken: string, response: CreateRoomResponse): Promise<void>;
}

export interface Operations extends CreationOperations {
  submitReport(input: { readonly capability: string; readonly description?: string }): Promise<void>;
  diagnostics?(): Promise<{ readonly d1_configured: true }>;
  audit?(action: string, target: string | undefined, outcome: string): Promise<void>;
  listReports?(limit: number): Promise<readonly { readonly created_at: number; readonly id: string; readonly status: string }[]>;
  readReport?(id: string): Promise<{ readonly capability: string; readonly created_at: number; readonly description?: string; readonly id: string; readonly status: string } | undefined>;
  updateReportStatus?(id: string, status: "closed" | "open" | "reviewed"): Promise<{ readonly created_at: number; readonly id: string; readonly status: string } | undefined>;
}

export interface MsgEnvironment {
  readonly ASSETS?: MsgStaticAssets;
  readonly ROOM_SERVICE?: RoomService;
  readonly ConversationRoom?: RoomNamespace;
  readonly MSG_PUBLIC_ORIGIN?: string;
  readonly MSG_VAPID_PRIVATE_KEY?: string;
  readonly MSG_VAPID_PUBLIC_KEY?: string;
  readonly MSG_VAPID_SUBJECT?: string;
}

const MAX_CANONICAL_JSON_DEPTH = 32;
const MAX_REPORT_CAPABILITY_CHARS = 512;
const MAX_REPORT_DESCRIPTION_BYTES = 4 * 1024;
const MAX_REPORT_DESCRIPTION_CHARS = 2_000;
const MAX_WEBHOOK_REQUEST_BYTES = 4 * 1024;
const MAX_PUSH_SUBSCRIPTION_REQUEST_BYTES = 4 * 1024;
const MAX_GET_POST_URL_BYTES = 8 * 1024;
const MAX_GET_POST_CONTENT_BYTES = 4 * 1024;
const MAX_GET_POST_TOKEN_CHARS = 512;
const MAX_GET_POST_TOKEN_BYTES = 2 * 1024;
const RATE_LIMIT_PERIOD_SECONDS = 60;

export function createWorker(service: RoomService, options: MsgWorkerOptions = {}): MsgWorker {
  return {
    async fetch(request) {
      try {
        return secure(await route(request, service, options));
      } catch (error) {
        const representation = errorRepresentation(request);
        const requestUrl = new URL(request.url);
        const agentHtml = representation === "html"
          && request.method === "GET"
          && selectBrowserView(requestUrl, request.headers.get("cookie")) === "agent"
          && (requestUrl.pathname === "/" || /^\/[^/]+$/u.test(requestUrl.pathname));
        const response =
          error instanceof ProtocolError
            ? agentHtml
              ? htmlResponse(renderAgentStatusPage(error.status, error.code, renderedErrorMessage(error.message, isStaleSequenceDetails(error.details) ? error.details : undefined, isStaleRevisionDetails(error.details) ? error.details : undefined), requestUrl), error.status)
              : errorResponse(error.code, error.message, error.status, representation, error.details)
            : errorResponse(
                ERROR_CODES.internal,
                "The relay could not complete the request.",
                500,
                representation,
              );
        if (error instanceof ProtocolError && error.retryAfterSeconds !== undefined) {
          response.headers.set("retry-after", String(error.retryAfterSeconds));
        }
        return secure(response);
      }
    },
  };
}

async function route(request: Request, service: RoomService, options: MsgWorkerOptions): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname.startsWith("/operator/v1/")) {
    if (!operatorAuthorized(request, options.operatorToken)) return operatorUnauthorized();
    if (request.method !== "GET" && request.method !== "HEAD" && !isSameOrigin(request, url)) {
      throw new ProtocolError(ERROR_CODES.forbidden, "Cross-origin state changes are not allowed.", 403);
    }
    const deleteMatch = /^\/operator\/v1\/rooms\/([^/]+)$/.exec(url.pathname);
    if (request.method === "DELETE" && deleteMatch) {
      if (!service.operatorDelete) return notFound();
      await service.operatorDelete(deleteMatch[1]);
      void options.operations?.audit?.("forced_delete", deleteMatch[1], "complete").catch(() => undefined);
      emitMsgEvent("msg.operator.action", "forced_delete_complete");
      return jsonResponse({ deleted: true });
    }
    if (request.method === "GET" && url.pathname === "/operator/v1/reports") {
      if (!options.operations?.listReports) return notFound();
      const limit = parseOperatorLimit(url.searchParams.get("limit"));
      const reports = await options.operations.listReports(limit);
      void options.operations.audit?.("report_list", undefined, "complete").catch(() => undefined);
      emitMsgEvent("msg.operator.action", "report_list_complete");
      return jsonResponse({ reports });
    }
    const reportMatch = /^\/operator\/v1\/reports\/([A-Za-z0-9-]{1,64})$/.exec(url.pathname);
    if (reportMatch && request.method === "GET") {
      if (!options.operations?.readReport) return notFound();
      const report = await options.operations.readReport(reportMatch[1]);
      if (!report) return notFound();
      void options.operations.audit?.("report_read", reportMatch[1], "complete").catch(() => undefined);
      emitMsgEvent("msg.operator.action", "report_read_complete");
      return jsonResponse(report);
    }
    if (reportMatch && request.method === "PATCH") {
      if (!options.operations?.updateReportStatus) return notFound();
      const body = await parseRequestBody(request, { maxBytes: 512 });
      const status = parseReportStatus(body);
      const report = await options.operations.updateReportStatus(reportMatch[1], status);
      if (!report) return notFound();
      void options.operations.audit?.("report_update", reportMatch[1], "complete").catch(() => undefined);
      emitMsgEvent("msg.operator.action", "report_update_complete");
      return jsonResponse(report);
    }
    if (request.method === "GET" && (url.pathname === "/operator/v1/status" || url.pathname === "/operator/v1/diagnostics")) {
      let d1Configured = false;
      try {
        d1Configured = (await options.operations?.diagnostics?.())?.d1_configured === true;
      } catch {
        d1Configured = false;
      }
      emitMsgEvent("msg.d1.availability", d1Configured ? "available" : "unavailable");
      return jsonResponse({
        create_disabled: options.createDisabled === true,
        d1_configured: d1Configured,
        instructions: "Set MSG_CREATE_DISABLED=1 or MSG_POST_DISABLED=1 in deployment configuration, then redeploy. These switches are not stored in D1.",
        post_disabled: options.postDisabled === true,
        protocol_version: PROTOCOL_VERSION,
      });
    }
    return notFound();
  }
  if (request.method !== "GET" && request.method !== "HEAD" && !isSameOrigin(request, url)) {
    throw new ProtocolError(ERROR_CODES.forbidden, "Cross-origin state changes are not allowed.", 403);
  }

  if (request.method === "GET" && url.pathname === "/healthz") {
    return jsonResponse({ ok: true, protocol_version: PROTOCOL_VERSION });
  }
  if (request.method === "GET" && (url.pathname === "/privacy" || url.pathname === "/terms" || url.pathname === "/abuse")) {
    return policyResponse(url.pathname);
  }
  if (request.method === "POST" && url.pathname === "/report") {
    if (!options.operations) {
      throw new ProtocolError(ERROR_CODES.serviceUnavailable, "Abuse reports are temporarily unavailable. Please retry later.", 503);
    }
    await enforceRateLimit(request, options.rateLimits?.posts);
    const body = await parseRequestBody(request, { maxBytes: 8 * 1024 });
    const report = parseReport(body);
    try {
      await options.operations.submitReport(report);
    } catch {
      emitMsgEvent("msg.report.recorded", "unavailable");
      throw new ProtocolError(ERROR_CODES.serviceUnavailable, "Abuse reports are temporarily unavailable. Please retry later.", 503);
    }
    emitMsgEvent("msg.report.recorded", "accepted");
    return jsonResponse({ accepted: true }, 202);
  }
  if (request.method === "GET" && url.pathname === "/agent.txt") {
    return textResponse(AGENT_INSTRUCTIONS);
  }
  if (request.method === "GET" && url.pathname === "/llms.txt") {
    return textResponse(AGENT_INSTRUCTIONS);
  }
  if (request.method === "GET" && url.pathname === "/openapi.json") {
    return jsonResponse(OPENAPI_DOCUMENT);
  }
  if (request.method === "GET" && url.pathname === PUSH_SERVICE_WORKER_PATH) {
    return pushServiceWorkerResponse();
  }
  if (request.method === "GET" && url.pathname.startsWith("/_msg/view/")) {
    return browserViewRedirect(url) ?? notFound();
  }
  const iconMatch = /^\/_msg\/icon\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && iconMatch) {
    return browserIcon(iconMatch[1]) ?? notFound();
  }
  if (request.method === "GET" && url.pathname === MERMAID_ASSET_PATH) {
    if (!options.assets) return notFound();
    const asset = await options.assets.fetch(request);
    return new Response(asset.body, {
      headers: new Headers(asset.headers),
      status: asset.status,
      statusText: asset.statusText,
    });
  }
  const assetMatch = /^\/_msg\/asset\/((?:agent\.css)|(?:client\.(?:css|js)))$/.exec(url.pathname);
  if (request.method === "GET" && assetMatch) {
    return agentBrowserAsset(assetMatch[1]) ?? browserAsset(assetMatch[1]) ?? notFound();
  }
  if (request.method === "GET" && url.pathname === "/") {
    const representation = negotiateRepresentation(request.headers.get("accept"));
    if (representation !== "html") return renderDiscovery(representation);
    if (selectBrowserView(url, request.headers.get("cookie")) === "agent") {
      return htmlResponse(renderAgentHomePage(url));
    }
    const page = renderBrowserDocument({ title: "Start a temporary conversation", url });
    return htmlResponse(page.html, 200, page.styleNonce);
  }
  if (request.method === "POST" && url.pathname === "/") {
    if (options.createDisabled) {
      throw new ProtocolError(
        ERROR_CODES.serviceUnavailable,
        "New room creation is temporarily unavailable.",
        503,
      );
    }
    await enforceRateLimit(request, options.rateLimits?.creation);
    const body = await parseRequestBody(request, { maxBytes: MAX_ROOM_REQUEST_BYTES });
    const key = request.headers.has("idempotency-key")
      ? validateIdempotencyKey(request.headers.get("idempotency-key") ?? "")
      : undefined;
    if (key && options.operations) {
      const fingerprint = await creationFingerprint(body);
      let claim: CreationClaim | undefined;
      try {
        claim = await options.operations.claimCreation(key, fingerprint);
      } catch {
        // D1 is intentionally outside the room creation availability path.
        emitMsgEvent("msg.d1.availability", "unavailable");
      }
      if (claim) emitMsgEvent("msg.creation.claimed", claim.kind);
      if (claim?.kind === "complete") {
        return createResponse(stripGeneratedNamePassword(claim.response), negotiateCreateRepresentation(request.headers.get("accept")));
      }
      if (claim?.kind === "conflict") {
        throw new ProtocolError(ERROR_CODES.conflict, "The Idempotency-Key is already used for another request.", 409);
      }
      if (claim?.kind === "pending") {
        throw new ProtocolError(ERROR_CODES.serviceUnavailable, "Room creation is still in progress. Retry with the same Idempotency-Key.", 503);
      }
      const created = await service.create({ body, ...(claim?.kind === "claimed" ? { plan: claim.plan } : {}) });
      try {
        await options.operations.completeCreation(key, claim?.kind === "claimed" ? claim.leaseToken : "", created);
      } catch {
        // The created room remains valid when the optional replay receipt cannot persist.
        emitMsgEvent("msg.d1.availability", "unavailable");
      }
      return createResponse(created, negotiateCreateRepresentation(request.headers.get("accept")));
    }
    const created = await service.create({ body });
    return createResponse(
      created,
      negotiateCreateRepresentation(request.headers.get("accept")),
    );
  }

  const webhookCollectionMatch = /^\/([^/]+)\/webhooks$/u.exec(url.pathname);
  if (webhookCollectionMatch && request.method === "GET") {
    if (!service.listWebhooks) return notFound();
    await enforceRateLimit(request, options.rateLimits?.reads);
    return jsonResponse(await service.listWebhooks({ room: webhookCollectionMatch[1]! }));
  }
  if (webhookCollectionMatch && request.method === "POST") {
    if (!service.createWebhook) return notFound();
    await enforceRateLimit(request, options.rateLimits?.posts);
    const destination = parseWebhookDestination(await parseRequestBody(request, { maxBytes: MAX_WEBHOOK_REQUEST_BYTES }));
    return jsonResponse(await service.createWebhook({ room: webhookCollectionMatch[1]!, url: destination }), 201);
  }
  const webhookItemMatch = /^\/([^/]+)\/webhooks\/([0-9a-f-]{36})$/iu.exec(url.pathname);
  if (webhookItemMatch && request.method === "DELETE") {
    if (!service.removeWebhook) return notFound();
    await enforceRateLimit(request, options.rateLimits?.posts);
    return jsonResponse(await service.removeWebhook({ id: webhookItemMatch[2]!, room: webhookItemMatch[1]! }));
  }
  const webhookActionMatch = /^\/([^/]+)\/webhooks\/([0-9a-f-]{36})\/(disable|enable|rotate-secret)$/iu.exec(url.pathname);
  if (webhookActionMatch && request.method === "POST") {
    await enforceRateLimit(request, options.rateLimits?.posts);
    const input = { id: webhookActionMatch[2]!, room: webhookActionMatch[1]! };
    if (webhookActionMatch[3] === "disable") {
      if (!service.disableWebhook) return notFound();
      return jsonResponse(await service.disableWebhook(input));
    }
    if (webhookActionMatch[3] === "enable") {
      if (!service.enableWebhook) return notFound();
      return jsonResponse(await service.enableWebhook(input));
    }
    if (!service.rotateWebhookSecret) return notFound();
    return jsonResponse(await service.rotateWebhookSecret(input));
  }
  const webhookRedeliveryMatch = /^\/([^/]+)\/webhooks\/([0-9a-f-]{36})\/deliveries\/([0-9a-f-]{36})\/redeliver$/iu.exec(url.pathname);
  if (webhookRedeliveryMatch && request.method === "POST") {
    if (!service.redeliverWebhook) return notFound();
    await enforceRateLimit(request, options.rateLimits?.posts);
    const result = await service.redeliverWebhook({ eventId: webhookRedeliveryMatch[3]!, id: webhookRedeliveryMatch[2]!, room: webhookRedeliveryMatch[1]! });
    return jsonResponse(result, result.result === "queued" ? 202 : 200);
  }

  const pushSubscriptionMatch = /^\/([^/]+)\/push-subscriptions$/u.exec(url.pathname);
  if (pushSubscriptionMatch && (request.method === "GET" || request.method === "POST" || request.method === "DELETE")) {
    const browserId = parsePushBrowserId(request.headers.get("x-msg-browser-id"));
    if (!browserId) throw new ProtocolError(ERROR_CODES.invalidBody, "A valid X-Msg-Browser-Id header is required.", 400);
    const room = pushSubscriptionMatch[1]!;
    if (request.method === "GET") {
      if (!service.readPushEnrollment) return notFound();
      await enforceRateLimit(request, options.rateLimits?.reads);
      return jsonResponse(await service.readPushEnrollment({ browserId, room }));
    }
    await enforceRateLimit(request, options.rateLimits?.posts);
    if (request.method === "DELETE") {
      if (!service.removePushEnrollment) return notFound();
      return jsonResponse(await service.removePushEnrollment({ browserId, room }));
    }
    if (!service.enrollPush) return notFound();
    if (!options.pushConfigured || !options.pushVapidPublicKey) {
      throw new ProtocolError(ERROR_CODES.serviceUnavailable, "Browser push is not configured on this service.", 503);
    }
    const pushBody = await parseRequestBody(request, { maxBytes: MAX_PUSH_SUBSCRIPTION_REQUEST_BYTES });
    const subscription = pushBody.kind === "json" ? await parsePushSubscription(pushBody.value) : undefined;
    if (!subscription) throw new ProtocolError(ERROR_CODES.invalidBody, "The browser push subscription is invalid.", 400);
    return jsonResponse(await service.enrollPush({ browserId, room, subscription }), 201);
  }

  const exportMatch = /^\/([^/]+)\/export\.(md|json)$/.exec(url.pathname);
  if (exportMatch && request.method === "GET") {
    if (!service.exportRoom) return notFound();
    await enforceRateLimit(request, options.rateLimits?.reads);
    return service.exportRoom({ format: exportMatch[2] === "json" ? "json" : "markdown", room: exportMatch[1] });
  }

  const coordinationOverviewMatch = /^\/([^/]+)\/coordination$/u.exec(url.pathname);
  if (coordinationOverviewMatch && request.method === "GET") {
    if (!service.coordinationOverview) return notFound();
    await enforceRateLimit(request, options.rateLimits?.reads);
    const result = await service.coordinationOverview({ room: coordinationOverviewMatch[1]! });
    const etag = coordinationEtag(result.coordination_cursor, result.published_revision, result.expires_at);
    if (request.headers.get("if-none-match") === etag) return new Response(null, { headers: { etag, "retry-after": "5" }, status: 304 });
    const response = jsonResponse(result);
    response.headers.set("etag", etag);
    response.headers.set("retry-after", "5");
    return response;
  }
  const coordinationPublicationMatch = /^\/([^/]+)\/coordination\/publications\/([1-9][0-9]*)$/u.exec(url.pathname);
  if (coordinationPublicationMatch && request.method === "GET") {
    if (!service.readCoordinationPublication) return notFound();
    await enforceRateLimit(request, options.rateLimits?.reads);
    return jsonResponse(await service.readCoordinationPublication({ room: coordinationPublicationMatch[1]!, publishedRevision: Number(coordinationPublicationMatch[2]!) }));
  }
  const coordinationCorrectionCollection = /^\/([^/]+)\/coordination\/corrections$/u.exec(url.pathname);
  if (coordinationCorrectionCollection && request.method === "GET") {
    if (!service.listCoordinationCorrections) return notFound();
    await enforceRateLimit(request, options.rateLimits?.reads);
    const selectors = parseCoordinationListSelectors(url);
    const targetType = url.searchParams.get("target_type");
    if (targetType !== null && targetType !== "message" && targetType !== "publication") throw new ProtocolError(ERROR_CODES.invalidBody, "The correction target_type is not supported.", 400);
    const targetPublishedRevisionValue = url.searchParams.get("target_published_revision");
    const targetPublishedRevision = targetPublishedRevisionValue === null ? undefined : parsePositiveCoordinationRevision(targetPublishedRevisionValue);
    const targetClaimPath = parseCoordinationClaimPathSelector(url.searchParams.get("target_claim_path"));
    if (targetClaimPath !== undefined && targetType === "message") throw new ProtocolError(ERROR_CODES.invalidBody, "A message correction target cannot have a claim_path filter.", 400);
    return jsonResponse(await service.listCoordinationCorrections({
      room: coordinationCorrectionCollection[1]!,
      after: selectors.after,
      limit: selectors.limit,
      ...(targetType === null ? {} : { targetType }),
      ...(targetClaimPath === undefined ? {} : { targetClaimPath }),
      ...(url.searchParams.get("target_message_id") === null ? {} : { targetMessageId: url.searchParams.get("target_message_id")! }),
      ...(targetPublishedRevision === undefined ? {} : { targetPublishedRevision }),
      ...(selectors.through === undefined ? {} : { through: selectors.through }),
    }));
  }
  const coordinationCorrectionDetail = /^\/([^/]+)\/coordination\/corrections\/([^/]+)$/u.exec(url.pathname);
  if (coordinationCorrectionDetail && request.method === "GET") {
    if (!service.readCoordinationCorrection) return notFound();
    await enforceRateLimit(request, options.rateLimits?.reads);
    return jsonResponse(await service.readCoordinationCorrection({ correctionId: decodePathSegment(coordinationCorrectionDetail[2]!), room: coordinationCorrectionDetail[1]! }));
  }
  const coordinationDisputeCollection = /^\/([^/]+)\/coordination\/disputes$/u.exec(url.pathname);
  if (coordinationDisputeCollection && request.method === "GET") {
    if (!service.listCoordinationDisputes) return notFound();
    await enforceRateLimit(request, options.rateLimits?.reads);
    const selectors = parseCoordinationListSelectors(url);
    const kind = parseCoordinationDisputeKind(url.searchParams.get("kind"));
    return jsonResponse(await service.listCoordinationDisputes({
      room: coordinationDisputeCollection[1]!,
      after: selectors.after,
      limit: selectors.limit,
      ...(url.searchParams.get("accepted_record_id") === null ? {} : { acceptedRecordId: url.searchParams.get("accepted_record_id")! }),
      ...(kind === undefined ? {} : { kind }),
      ...(selectors.through === undefined ? {} : { through: selectors.through }),
    }));
  }
  if (coordinationDisputeCollection && request.method === "POST") {
    if (!service.submitCoordinationDispute) return notFound();
    await enforceRateLimit(request, options.rateLimits?.posts);
    return jsonResponse(await service.submitCoordinationDispute({ body: await parseRequestBody(request, { maxBytes: MAX_ROOM_REQUEST_BYTES }), room: coordinationDisputeCollection[1]! }), 201);
  }
  const coordinationSupersessionCollection = /^\/([^/]+)\/coordination\/supersessions$/u.exec(url.pathname);
  if (coordinationSupersessionCollection && request.method === "GET") {
    if (!service.listCoordinationSupersessions) return notFound();
    await enforceRateLimit(request, options.rateLimits?.reads);
    const selectors = parseCoordinationListSelectors(url);
    return jsonResponse(await service.listCoordinationSupersessions({
      room: coordinationSupersessionCollection[1]!,
      after: selectors.after,
      limit: selectors.limit,
      ...(url.searchParams.get("predecessor_accepted_record_id") === null ? {} : { predecessorAcceptedRecordId: url.searchParams.get("predecessor_accepted_record_id")! }),
      ...(url.searchParams.get("successor_decision_id") === null ? {} : { successorDecisionId: url.searchParams.get("successor_decision_id")! }),
      ...(selectors.through === undefined ? {} : { through: selectors.through }),
    }));
  }
  const coordinationDisputeReviewMatch = /^\/manage\/([^/]+)\/([^/]+)\/coordination\/disputes\/([^/]+)\/review$/u.exec(url.pathname);
  if (coordinationDisputeReviewMatch && request.method === "POST") {
    if (!service.reviewCoordinationDispute) return notFound();
    await enforceRateLimit(request, options.rateLimits?.posts);
    return jsonResponse(await service.reviewCoordinationDispute({ body: await parseRequestBody(request, { maxBytes: MAX_ROOM_REQUEST_BYTES }), ownerToken: decodePathSegment(coordinationDisputeReviewMatch[2]!), reportId: decodePathSegment(coordinationDisputeReviewMatch[3]!), room: coordinationDisputeReviewMatch[1]! }), 201);
  }
  const coordinationDisputeDetail = /^\/([^/]+)\/coordination\/disputes\/([^/]+)$/u.exec(url.pathname);
  if (coordinationDisputeDetail && request.method === "GET") {
    if (!service.readCoordinationDispute) return notFound();
    await enforceRateLimit(request, options.rateLimits?.reads);
    const selectors = parseCoordinationListSelectors(url);
    return jsonResponse(await service.readCoordinationDispute({ reportId: decodePathSegment(coordinationDisputeDetail[2]!), room: coordinationDisputeDetail[1]!, after: selectors.after, limit: selectors.limit, ...(selectors.through === undefined ? {} : { through: selectors.through }) }));
  }
  const coordinationPanelHistoryMatch = /^\/([^/]+)\/coordination\/panel\/history$/u.exec(url.pathname);
  if (coordinationPanelHistoryMatch && request.method === "GET") {
    if (!service.listCoordinationPanelHistory) return notFound();
    await enforceRateLimit(request, options.rateLimits?.reads);
    const selectors = parseCoordinationListSelectors(url);
    const result = await service.listCoordinationPanelHistory({ room: coordinationPanelHistoryMatch[1]!, after: selectors.after, limit: selectors.limit, ...(selectors.through === undefined ? {} : { through: selectors.through }) });
    const etag = coordinationPanelHistoryEtag(result, selectors);
    if (request.headers.get("if-none-match") === etag) return new Response(null, { headers: { etag, "retry-after": "5" }, status: 304 });
    const response = jsonResponse(result);
    response.headers.set("etag", etag);
    response.headers.set("retry-after", "5");
    return response;
  }
  const coordinationPanelMatch = /^\/([^/]+)\/coordination\/panel$/u.exec(url.pathname);
  if (coordinationPanelMatch && request.method === "GET") {
    if (!service.readCoordinationPanel) return notFound();
    await enforceRateLimit(request, options.rateLimits?.reads);
    const revisionValue = url.searchParams.get("revision");
    const revision = revisionValue === null ? undefined : parsePositiveCoordinationRevision(revisionValue);
    const result = await service.readCoordinationPanel({ room: coordinationPanelMatch[1]!, ...(revision === undefined ? {} : { revision }) });
    const etag = coordinationPanelEtag(result, revision);
    if (request.headers.get("if-none-match") === etag) return new Response(null, { headers: { etag, "retry-after": "5" }, status: 304 });
    const response = jsonResponse(result);
    response.headers.set("etag", etag);
    response.headers.set("retry-after", "5");
    return response;
  }
  const coordinationDecisionCollection = /^\/([^/]+)\/coordination\/decisions$/u.exec(url.pathname);
  if (coordinationDecisionCollection && request.method === "GET") {
    if (!service.listCoordinationDecisions) return notFound();
    await enforceRateLimit(request, options.rateLimits?.reads);
    const selectors = parseCoordinationListSelectors(url);
    const result = await service.listCoordinationDecisions({ room: coordinationDecisionCollection[1]!, after: selectors.after, limit: selectors.limit, ...(selectors.through === undefined ? {} : { through: selectors.through }) });
    const etag = coordinationDecisionListEtag(result, selectors);
    if (request.headers.get("if-none-match") === etag) return new Response(null, { headers: { etag, "retry-after": "5" }, status: 304 });
    const response = jsonResponse(result);
    response.headers.set("etag", etag);
    response.headers.set("retry-after", "5");
    return response;
  }
  const coordinationAcceptedRecordMatch = /^\/([^/]+)\/coordination\/decisions\/([^/]+)\/records\/([^/]+)$/u.exec(url.pathname);
  if (coordinationAcceptedRecordMatch && request.method === "GET") {
    if (!service.readCoordinationAcceptedRecord) return notFound();
    await enforceRateLimit(request, options.rateLimits?.reads);
    return jsonResponse(await service.readCoordinationAcceptedRecord({ acceptedRecordId: decodePathSegment(coordinationAcceptedRecordMatch[3]!), decisionId: decodePathSegment(coordinationAcceptedRecordMatch[2]!), room: coordinationAcceptedRecordMatch[1]! }));
  }
  const coordinationDecisionDetail = /^\/([^/]+)\/coordination\/decisions\/([^/]+)$/u.exec(url.pathname);
  if (coordinationDecisionDetail && request.method === "GET") {
    if (!service.readCoordinationDecision) return notFound();
    await enforceRateLimit(request, options.rateLimits?.reads);
    const selectors = parseCoordinationListSelectors(url);
    const result = await service.readCoordinationDecision({ decisionId: decodePathSegment(coordinationDecisionDetail[2]!), room: coordinationDecisionDetail[1]!, after: selectors.after, limit: selectors.limit, ...(selectors.through === undefined ? {} : { through: selectors.through }) });
    const etag = coordinationDecisionDetailEtag(result, selectors);
    if (request.headers.get("if-none-match") === etag) return new Response(null, { headers: { etag, "retry-after": "5" }, status: 304 });
    const response = jsonResponse(result);
    response.headers.set("etag", etag);
    response.headers.set("retry-after", "5");
    return response;
  }
  const coordinationProposalCollection = /^\/([^/]+)\/coordination\/proposals$/u.exec(url.pathname);
  if (coordinationProposalCollection && request.method === "GET") {
    if (!service.listCoordinationProposals) return notFound();
    await enforceRateLimit(request, options.rateLimits?.reads);
    const selectors = parseCoordinationListSelectors(url);
    return jsonResponse(await service.listCoordinationProposals({ room: coordinationProposalCollection[1]!, after: selectors.after, limit: selectors.limit, ...(selectors.through === undefined ? {} : { through: selectors.through }) }));
  }
  if (coordinationProposalCollection && request.method === "POST") {
    if (!service.submitCoordinationProposal) return notFound();
    await enforceRateLimit(request, options.rateLimits?.posts);
    return jsonResponse(await service.submitCoordinationProposal({ body: await parseRequestBody(request, { maxBytes: MAX_ROOM_REQUEST_BYTES }), room: coordinationProposalCollection[1]! }), 201);
  }
  const coordinationRevisionMatch = /^\/([^/]+)\/coordination\/proposals\/([^/]+)\/revisions$/u.exec(url.pathname);
  if (coordinationRevisionMatch && request.method === "POST") {
    if (!service.submitCoordinationRevision) return notFound();
    await enforceRateLimit(request, options.rateLimits?.posts);
    return jsonResponse(await service.submitCoordinationRevision({ body: await parseRequestBody(request, { maxBytes: MAX_ROOM_REQUEST_BYTES }), proposalId: decodePathSegment(coordinationRevisionMatch[2]!), room: coordinationRevisionMatch[1]! }), 201);
  }
  const coordinationRevisionDetailMatch = /^\/([^/]+)\/coordination\/proposals\/([^/]+)\/revisions\/([1-9][0-9]*)$/u.exec(url.pathname);
  if (coordinationRevisionDetailMatch && request.method === "GET") {
    if (!service.readCoordinationProposalRevision) return notFound();
    await enforceRateLimit(request, options.rateLimits?.reads);
    return jsonResponse(await service.readCoordinationProposalRevision({ proposalId: decodePathSegment(coordinationRevisionDetailMatch[2]!), revision: Number(coordinationRevisionDetailMatch[3]!), room: coordinationRevisionDetailMatch[1]! }));
  }
  const coordinationProposalDetail = /^\/([^/]+)\/coordination\/proposals\/([^/]+)$/u.exec(url.pathname);
  if (coordinationProposalDetail && request.method === "GET") {
    if (!service.readCoordinationProposal) return notFound();
    await enforceRateLimit(request, options.rateLimits?.reads);
    return jsonResponse(await service.readCoordinationProposal({ proposalId: decodePathSegment(coordinationProposalDetail[2]!), room: coordinationProposalDetail[1]! }));
  }
  const coordinationRequestCollection = /^\/([^/]+)\/coordination\/requests$/u.exec(url.pathname);
  if (coordinationRequestCollection && request.method === "GET") {
    if (!service.listCoordinationRequests) return notFound();
    await enforceRateLimit(request, options.rateLimits?.reads);
    const selectors = parseCoordinationListSelectors(url);
    const result = await service.listCoordinationRequests({ room: coordinationRequestCollection[1]!, after: selectors.after, limit: selectors.limit, ...(selectors.owner_label === undefined ? {} : { owner_label: selectors.owner_label }), ...(selectors.status === undefined ? {} : { status: selectors.status }), ...(selectors.through === undefined ? {} : { through: selectors.through }) });
    const etag = coordinationListEtag("requests", result, selectors);
    if (request.headers.get("if-none-match") === etag) return new Response(null, { headers: { etag, "retry-after": "5" }, status: 304 });
    const response = jsonResponse(result);
    response.headers.set("etag", etag);
    response.headers.set("retry-after", "5");
    return response;
  }
  const coordinationRequestDetail = /^\/([^/]+)\/coordination\/requests\/([^/]+)$/u.exec(url.pathname);
  if (coordinationRequestDetail && request.method === "GET") {
    if (!service.readCoordinationRequest) return notFound();
    await enforceRateLimit(request, options.rateLimits?.reads);
    const selectors = parseCoordinationListSelectors(url);
    return jsonResponse(await service.readCoordinationRequest({ requestId: decodePathSegment(coordinationRequestDetail[2]!), room: coordinationRequestDetail[1]!, after: selectors.after, limit: selectors.limit, ...(selectors.owner_label === undefined ? {} : { owner_label: selectors.owner_label }), ...(selectors.status === undefined ? {} : { status: selectors.status }), ...(selectors.through === undefined ? {} : { through: selectors.through }) }));
  }
  const coordinationPublishMatch = /^\/manage\/([^/]+)\/([^/]+)\/coordination\/publish$/u.exec(url.pathname);
  if (coordinationPublishMatch && request.method === "POST") {
    if (!service.publishCoordinationRequest) return notFound();
    await enforceRateLimit(request, options.rateLimits?.posts);
    return jsonResponse(await service.publishCoordinationRequest({ body: await parseRequestBody(request, { maxBytes: MAX_ROOM_REQUEST_BYTES }), ownerToken: decodePathSegment(coordinationPublishMatch[2]!), room: coordinationPublishMatch[1]! }), 201);
  }

  const messageMatch = /^\/([^/]+)\/messages\/([^/]+)$/u.exec(url.pathname);
  if (messageMatch && request.method === "GET") {
    if (!service.readMessage) return notFound();
    await enforceRateLimit(request, options.rateLimits?.reads);
    const result = stripLegacyAbsoluteExpiry(await service.readMessage({ id: decodePathSegment(messageMatch[2]!), room: messageMatch[1]! })) as unknown as ReadMessageResponse;
    const etag = coordinationMessageEtag(result);
    if (request.headers.get("if-none-match") === etag) return new Response(null, { headers: { etag, "retry-after": "5" }, status: 304 });
    const response = messageResponse(result, negotiateRepresentation(request.headers.get("accept")));
    response.headers.set("etag", etag);
    response.headers.set("retry-after", "5");
    return response;
  }

  const agentMatch = /^\/([^/]+)\/agent$/.exec(url.pathname);
  if (agentMatch && request.method === "GET") {
    if (!service.read) return notFound();
    await enforceRateLimit(request, options.rateLimits?.reads);
    const selectors = parseReadSelectors(url);
    const result = stripLegacyAbsoluteExpiry(await service.read({
      after: selectors.after,
      ...(selectors.limit === undefined ? {} : { limit: selectors.limit }),
      room: agentMatch[1],
      ...(selectors.through === undefined ? {} : { through: selectors.through }),
    })) as unknown as ReadRoomResponse;
    const document = buildAgentRepresentation(result, selectors.bounded ? { limit: selectors.limit ?? DEFAULT_READ_LIMIT } : undefined);
    return request.headers.get("accept")?.toLowerCase().includes("application/json")
      ? jsonResponse(document)
      : textResponse(renderAgentText(document));
  }

  const getPostMatch = /^\/([^/]+)\/post$/.exec(url.pathname);
  if (getPostMatch && request.method === "GET") {
    if (!service.getPost) return notFound();
    if (options.postDisabled) {
      throw new ProtocolError(ERROR_CODES.serviceUnavailable, "New messages are temporarily unavailable.", 503);
    }
    if (!isSameOrigin(request, url)) {
      throw new ProtocolError(ERROR_CODES.forbidden, "Cross-origin state changes are not allowed.", 403);
    }
    rejectGetPostPrefetch(request);
    const getPost = parseGetPostQuery(request, url);
    await enforceRateLimit(request, options.rateLimits?.posts);
    const result = stripLegacyAbsoluteExpiry(await service.getPost({
      body: { kind: "json", value: getPost.input },
      ...(getPost.basedOnSequence === undefined ? {} : { basedOnSequence: getPost.basedOnSequence }),
      requestId: getPost.requestId,
      room: getPostMatch[1]!,
      token: getPost.token,
    })) as unknown as GetPostMessageResponse;
    return getPostResponse(result);
  }

  const roomMatch = /^\/([^/]+)$/.exec(url.pathname);
  if (roomMatch) {
    const room = roomMatch[1];
    if (request.method === "GET") {
      if (!service.read) return notFound();
      await enforceRateLimit(request, options.rateLimits?.reads);
      const selectors = parseReadSelectors(url);
      const result = stripLegacyAbsoluteExpiry(await service.read({
        after: selectors.after,
        ...(selectors.limit === undefined ? {} : { limit: selectors.limit }),
        room,
        ...(selectors.through === undefined ? {} : { through: selectors.through }),
      })) as unknown as ReadRoomResponse;
      if (negotiateRepresentation(request.headers.get("accept")) === "html") {
        if (selectBrowserView(url, request.headers.get("cookie")) === "agent") {
          return htmlResponse(renderAgentRoomPage(result, url));
        }
        const page = renderBrowserDocument({ pushPublicKey: options.pushConfigured ? options.pushVapidPublicKey : undefined, room, title: "Temporary conversation", url });
        return htmlResponse(page.html, 200, page.styleNonce);
      }
      const etag = selectors.bounded
        ? roomEtag(result.latest_message, selectors.after, { expiresAt: result.expires_at, mode: "bounded", limit: selectors.limit ?? DEFAULT_READ_LIMIT, through: result.through, ...(result.coordination_cursor === undefined ? {} : { coordinationCursor: result.coordination_cursor }), ...(result.published_revision === undefined ? {} : { publishedRevision: result.published_revision }), ...(result.retention === undefined ? {} : { inactivityWindowMs: result.retention.inactivity_window_ms, retentionMode: result.retention.mode, retentionPolicy: result.retention.policy }) })
        : result.coordination_cursor === undefined && result.published_revision === undefined
          ? roomEtag(result.latest_message, selectors.after)
          : roomEtag(result.latest_message, selectors.after, { coordinationCursor: result.coordination_cursor, expiresAt: result.expires_at, mode: "unbounded", publishedRevision: result.published_revision, ...(result.retention === undefined ? {} : { inactivityWindowMs: result.retention.inactivity_window_ms, retentionMode: result.retention.mode, retentionPolicy: result.retention.policy }) });
      if (request.headers.get("if-none-match") === etag) {
        return new Response(null, { headers: { etag, "retry-after": "5" }, status: 304 });
      }
      return readResponse(result, negotiateRepresentation(request.headers.get("accept")), etag);
    }
    if (request.method === "POST") {
      if (!service.post) return notFound();
      if (options.postDisabled) {
        throw new ProtocolError(ERROR_CODES.serviceUnavailable, "New messages are temporarily unavailable.", 503);
      }
      await enforceRateLimit(request, options.rateLimits?.posts);
      const body = await parseRequestBody(request, { maxBytes: MAX_ROOM_REQUEST_BYTES });
      const basedOnSequence = parseBasedOnSequence(body);
      const result = stripLegacyAbsoluteExpiry(await service.post({
        body,
        ...(basedOnSequence === undefined ? {} : { basedOnSequence }),
        browserId: parseOptionalPushBrowserId(request.headers.get("x-msg-browser-id")),
        idempotencyKey: request.headers.has("idempotency-key") ? validateIdempotencyKey(request.headers.get("idempotency-key") ?? "") : undefined,
        room,
      })) as unknown as import("./protocol").PostMessageResponse;
      return postResponse(result, negotiateRepresentation(request.headers.get("accept")));
    }
  }

  const liveMatch = /^\/([^/]+)\/live$/.exec(url.pathname);
  if (liveMatch && request.method === "GET") {
    if (!service.live) return notFound();
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw new ProtocolError(ERROR_CODES.invalidBody, "The live endpoint requires a WebSocket upgrade.", 400);
    }
    await enforceRateLimit(request, options.rateLimits?.live);
    return service.live({ after: validateCursor(url.searchParams.get("after")), room: liveMatch[1] });
  }

  const manageMatch = /^\/manage\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  const retentionMatch = /^\/manage\/([^/]+)\/([^/]+)\/retention$/.exec(url.pathname);
  if (retentionMatch && request.method === "POST") {
    if (!service.extendRetention) return notFound();
    await enforceRateLimit(request, options.rateLimits?.posts);
    const result = await service.extendRetention({ body: await parseRequestBody(request, { maxBytes: 4 * 1024 }), room: retentionMatch[1]!, token: decodePathSegment(retentionMatch[2]!) });
    return retentionResponse(result, negotiateRepresentation(request.headers.get("accept")));
  }
  if (manageMatch && (request.method === "GET" || request.method === "DELETE" || request.method === "POST")) {
    if (!service.manage) return notFound();
    if (request.method === "POST") await enforceRateLimit(request, options.rateLimits?.posts);
    const action = request.method === "POST" ? await parseManagementAction(request) : undefined;
    const result = await service.manage({ action, method: request.method, room: manageMatch[1]!, token: manageMatch[2]! });
    return manageResponse(result, request.method, negotiateRepresentation(request.headers.get("accept")), url);
  }

  return errorResponse(
    ERROR_CODES.notFound,
    "The requested resource was not found.",
    404,
    negotiateRepresentation(request.headers.get("accept")),
  );
}

const GET_POST_QUERY_FIELDS = new Set(["author", "based_on_sequence", "client", "content", "display_name", "name_password", "reply_to", "request_id", "semantic_type", "token"]);

interface GetPostQuery {
  readonly basedOnSequence?: number;
  readonly input: Record<string, string>;
  readonly requestId: string;
  readonly token: string;
}

function parseGetPostQuery(request: Request, url: URL): GetPostQuery {
  if (byteLength(request.url) > MAX_GET_POST_URL_BYTES) {
    throw new ProtocolError(ERROR_CODES.bodyTooLarge, "The GET posting URL is too large.", 413);
  }
  const counts = new Map<string, number>();
  for (const [name] of url.searchParams) {
    if (!GET_POST_QUERY_FIELDS.has(name)) throw new ProtocolError(ERROR_CODES.invalidBody, "The GET posting query contains an unsupported field.", 400);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const [name, count] of counts) {
    if (count !== 1) throw new ProtocolError(ERROR_CODES.invalidBody, `The ${name} query field must appear once.`, 400);
  }

  const token = boundedQueryValue(url.searchParams.get("token"), "token", MAX_GET_POST_TOKEN_CHARS, MAX_GET_POST_TOKEN_BYTES);
  const requestId = validateRequestId(requiredQueryValue(url.searchParams.get("request_id"), "request_id"));
  const basedOnSequence = validateBasedOnSequenceQuery(url.searchParams.get("based_on_sequence"));
  const content = requiredQueryValue(url.searchParams.get("content"), "content");
  if (byteLength(content) > MAX_GET_POST_CONTENT_BYTES) {
    throw new ProtocolError(ERROR_CODES.bodyTooLarge, "The GET posting content is too large.", 413);
  }
  const input: Record<string, string> = { content };
  for (const field of ["author", "display_name", "name_password", "client", "semantic_type", "reply_to"] as const) {
    const value = url.searchParams.get(field);
    if (value !== null) input[field] = value;
  }
  return { input, ...(basedOnSequence === undefined ? {} : { basedOnSequence }), requestId, token };
}

function requiredQueryValue(value: string | null, field: string): string {
  if (value === null || value === "") throw new ProtocolError(ERROR_CODES.invalidBody, `The ${field} query field is required.`, 400);
  return value;
}

function boundedQueryValue(value: string | null, field: string, maxChars: number, maxBytes: number): string {
  const result = requiredQueryValue(value, field);
  if (Array.from(result).length > maxChars || byteLength(result) > maxBytes) {
    throw new ProtocolError(ERROR_CODES.bodyTooLarge, `The ${field} query field is too large.`, 413);
  }
  return result;
}

function rejectGetPostPrefetch(request: Request): void {
  if (request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site") {
    throw new ProtocolError(ERROR_CODES.forbidden, "GET posting URLs cannot be used by cross-site browser requests.", 403);
  }
  const prefetchHeaders = ["purpose", "sec-purpose", "x-moz"].map((name) => request.headers.get(name)?.toLowerCase() ?? "");
  if (prefetchHeaders.some((value) => value.includes("prefetch") || value.includes("prerender"))) {
    throw new ProtocolError(ERROR_CODES.forbidden, "GET posting URLs cannot be used by prefetch or prerender requests.", 403);
  }
}

async function parseManagementAction(request: Request): Promise<"disable" | "enable" | "rotate"> {
  const body = await parseRequestBody(request, { maxBytes: 512 });
  let action: unknown;
  if (body.kind === "json") {
    if (body.value === null || Array.isArray(body.value) || typeof body.value !== "object") {
      throw new ProtocolError(ERROR_CODES.invalidBody, "The management action must be a JSON object.", 400);
    }
    const fields = Object.keys(body.value);
    if (fields.length !== 1 || fields[0] !== "action") {
      throw new ProtocolError(ERROR_CODES.invalidBody, "The management action must contain only action.", 400);
    }
    action = body.value.action;
  } else {
    const values = new URLSearchParams(body.value);
    const fields = [...values.keys()];
    if (fields.length !== 1 || fields[0] !== "action") {
      throw new ProtocolError(ERROR_CODES.invalidBody, "The management action must contain only action.", 400);
    }
    action = values.get("action");
  }
  if (action !== "enable" && action !== "disable" && action !== "rotate") {
    throw new ProtocolError(ERROR_CODES.invalidBody, "The management action must be enable, disable, or rotate.", 400);
  }
  return action;
}

interface ReadSelectors {
  readonly after: number;
  readonly bounded: boolean;
  readonly limit?: number;
  readonly through?: number;
}

function parseReadSelectors(url: URL): ReadSelectors {
  const bounded = url.searchParams.has("limit") || url.searchParams.has("through");
  const limit = validateReadLimit(url.searchParams.get("limit"));
  const through = validateThrough(url.searchParams.get("through"));
  return {
    after: bounded ? validateBoundedCursor(url.searchParams.get("after"), "after") : validateCursor(url.searchParams.get("after")),
    bounded,
    ...(limit === undefined ? {} : { limit }),
    ...(through === undefined ? {} : { through }),
  };
}

function coordinationListEtag(kind: "requests", result: unknown, selectors: { readonly after: number; readonly limit: number; readonly owner_label?: string; readonly status?: string; readonly through?: number }): string {
  const value = result && typeof result === "object" && !Array.isArray(result) ? result as { coordination_cursor?: unknown; expires_at?: unknown; published_revision?: unknown; through?: unknown } : {};
  return `W/"coordination-${kind}-${String(value.coordination_cursor ?? "")}-${String(value.published_revision ?? "")}-after-${selectors.after}-limit-${selectors.limit}-through-${String(selectors.through ?? value.through ?? "")}-owner-${encodeURIComponent(selectors.owner_label ?? "")}-status-${selectors.status ?? ""}-expires-${String(value.expires_at ?? "")}"`;
}

function coordinationDecisionListEtag(result: unknown, selectors: { readonly after: number; readonly limit: number; readonly through?: number }): string {
  const value = result && typeof result === "object" && !Array.isArray(result) ? result as { coordination_cursor?: unknown; expires_at?: unknown; published_revision?: unknown; through?: unknown } : {};
  return `W/"coordination-decisions-${String(value.coordination_cursor ?? "")}-${String(value.published_revision ?? "")}-after-${selectors.after}-limit-${selectors.limit}-through-${String(selectors.through ?? value.through ?? "")}-expires-${String(value.expires_at ?? "")}"`;
}

function coordinationDecisionDetailEtag(result: unknown, selectors: { readonly after: number; readonly limit: number; readonly through?: number }): string {
  const value = result && typeof result === "object" && !Array.isArray(result) ? result as { coordination_cursor?: unknown; expires_at?: unknown; published_revision?: unknown; history_through?: unknown; decision?: { decision_id?: unknown; latest_proposal_revision?: unknown; state?: unknown; accepted_record_id?: unknown } } : {};
  const decision = value.decision ?? {};
  return `W/"coordination-decision-${String(decision.decision_id ?? "")}-${String(decision.latest_proposal_revision ?? "")}-${String(decision.state ?? "")}-${String(decision.accepted_record_id ?? "")}-${String(value.coordination_cursor ?? "")}-${String(value.published_revision ?? "")}-after-${selectors.after}-limit-${selectors.limit}-through-${String(selectors.through ?? value.history_through ?? "")}-expires-${String(value.expires_at ?? "")}"`;
}

function parsePositiveCoordinationRevision(value: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new ProtocolError(ERROR_CODES.invalidBody, "The panel revision must be a positive safe integer.", 400);
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) throw new ProtocolError(ERROR_CODES.invalidBody, "The panel revision must be a positive safe integer.", 400);
  return revision;
}

function parseCoordinationDisputeKind(value: string | null): "dispute" | "approval_withdrawal" | undefined {
  if (value === null) return undefined;
  if (value !== "dispute" && value !== "approval_withdrawal") throw new ProtocolError(ERROR_CODES.invalidBody, "The coordination report kind is not supported.", 400);
  return value;
}

function parseCoordinationClaimPathSelector(value: string | null): readonly (string | number)[] | undefined {
  if (value === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ProtocolError(ERROR_CODES.invalidBody, "The correction target_claim_path must be JSON.", 400);
  }
  return parseCoordinationClaimPath(parsed);
}

function coordinationPanelEtag(result: unknown, revision: number | undefined): string {
  const value = result && typeof result === "object" && !Array.isArray(result) ? result as { coordination_cursor?: unknown; expires_at?: unknown; panel_published_revision?: unknown; published_revision?: unknown } : {};
  return `W/"coordination-panel-${String(value.coordination_cursor ?? "")}-${String(value.published_revision ?? "")}-${String(value.panel_published_revision ?? "")}-revision-${String(revision ?? "latest")}-expires-${String(value.expires_at ?? "")}"`;
}

function coordinationPanelHistoryEtag(result: unknown, selectors: { readonly after: number; readonly limit: number; readonly through?: number }): string {
  const value = result && typeof result === "object" && !Array.isArray(result) ? result as { coordination_cursor?: unknown; expires_at?: unknown; published_revision?: unknown; history_through?: unknown } : {};
  return `W/"coordination-panel-history-${String(value.coordination_cursor ?? "")}-${String(value.published_revision ?? "")}-after-${selectors.after}-limit-${selectors.limit}-through-${String(selectors.through ?? value.history_through ?? "")}-expires-${String(value.expires_at ?? "")}"`;
}

function coordinationMessageEtag(result: ReadMessageResponse): string {
  return `W/"message-${result.message.id}-coordination-${result.coordination_cursor}-published-${result.published_revision}-corrections-${result.correction_count}-expires-${result.expires_at}-retention-window-${result.retention?.inactivity_window_ms ?? ""}-retention-mode-${result.retention?.mode ?? ""}-retention-policy-${result.retention?.policy ?? ""}"`;
}

async function enforceRateLimit(request: Request, binding: MsgRateLimit | undefined): Promise<void> {
  if (!binding) return;
  let outcome: { readonly success: boolean };
  try {
    outcome = await binding.limit({ key: rateLimitActor(request) });
  } catch {
    throw rateLimitedError();
  }
  if (!outcome.success) throw rateLimitedError();
}

function rateLimitActor(request: Request): string {
  const actor = request.headers.get("cf-connecting-ip");
  return actor !== null && (isIpv4(actor) || isIpv6(actor)) ? actor : "unknown";
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^(?:0|[1-9][0-9]{0,2})$/u.test(part) && Number(part) <= 255);
}

function isIpv6(value: string): boolean {
  if (!value.includes(":") || value.length > 45 || !/^[0-9A-Fa-f:.]+$/u.test(value)) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.startsWith("[");
  } catch {
    return false;
  }
}

function rateLimitedError(): ProtocolError {
  return new ProtocolError(ERROR_CODES.rateLimited, "Too many requests. Retry later.", 429, RATE_LIMIT_PERIOD_SECONDS);
}

async function creationFingerprint(body: RequestBody): Promise<string> {
  const normalized = body.kind === "raw" ? `raw:${body.value}` : `json:${canonicalJson(body.value)}`;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function parseReport(body: RequestBody): { capability: string; description?: string } {
  if (body.kind !== "json" || body.value === null || Array.isArray(body.value) || typeof body.value !== "object") {
    throw new ProtocolError(ERROR_CODES.invalidBody, "The abuse report body must be a JSON object.", 400);
  }
  const capability = body.value.capability ?? body.value.room_capability;
  const description = body.value.description;
  if (typeof capability !== "string" || !capability || capability.length > MAX_REPORT_CAPABILITY_CHARS || typeof description !== "undefined" && typeof description !== "string") {
    throw new ProtocolError(ERROR_CODES.invalidBody, "The abuse report is invalid.", 400);
  }
  if (description !== undefined && (Array.from(description).length > MAX_REPORT_DESCRIPTION_CHARS || new TextEncoder().encode(description).byteLength > MAX_REPORT_DESCRIPTION_BYTES)) {
    throw new ProtocolError(ERROR_CODES.invalidBody, "The abuse report description is too long.", 400);
  }
  return description === undefined ? { capability } : { capability, description };
}

function parseOptionalPushBrowserId(value: string | null): string | undefined {
  if (value === null) return undefined;
  const browserId = parsePushBrowserId(value);
  if (!browserId) throw new ProtocolError(ERROR_CODES.invalidBody, "The X-Msg-Browser-Id header is invalid.", 400);
  return browserId;
}

function parseOperatorLimit(value: string | null): number {
  if (value === null) return 25;
  if (!/^[1-9][0-9]*$/u.test(value)) throw new ProtocolError(ERROR_CODES.invalidBody, "The report limit is invalid.", 400);
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > 100) throw new ProtocolError(ERROR_CODES.invalidBody, "The report limit is invalid.", 400);
  return limit;
}

function parseReportStatus(body: RequestBody): "closed" | "open" | "reviewed" {
  if (body.kind !== "json" || body.value === null || Array.isArray(body.value) || typeof body.value !== "object") {
    throw new ProtocolError(ERROR_CODES.invalidBody, "The report update is invalid.", 400);
  }
  const status = body.value.status;
  if (status !== "closed" && status !== "open" && status !== "reviewed") {
    throw new ProtocolError(ERROR_CODES.invalidBody, "The report update is invalid.", 400);
  }
  return status;
}

function parseWebhookDestination(body: RequestBody): string {
  if (body.kind !== "json" || body.value === null || Array.isArray(body.value) || typeof body.value !== "object") {
    throw new ProtocolError(ERROR_CODES.invalidBody, "The webhook request must be a JSON object containing only url.", 400);
  }
  const fields = Object.keys(body.value);
  const url = normalizeWebhookUrl(body.value.url);
  if (fields.length !== 1 || fields[0] !== "url" || url === undefined) {
    throw new ProtocolError(ERROR_CODES.invalidBody, "The webhook destination must be a valid public HTTPS URL.", 400);
  }
  return url;
}

function policyResponse(path: string): Response {
  const title = path === "/privacy" ? "Privacy" : path === "/terms" ? "Terms" : "Abuse reporting";
  const text = path === "/privacy"
    ? "This relay is for temporary message handoff. We do not use advertising, analytics, tracking cookies, third-party scripts, or third-party fonts. Anyone with a room URL can read and post in that room. A room expires after 7 days without a post or when it is deleted. A deleted-room tombstone remains for 24 hours. Creation idempotency records are encrypted and removed after 24 hours. Encrypted abuse reports are removed after 30 days. Metadata-only operator audit records are removed after 90 days. Use the management URL to delete a room. Use the abuse report endpoint to report harmful or illegal use. This anonymous relay does not provide a public email support address."
    : path === "/terms"
      ? "Use this relay only for lawful temporary message handoff. Room content and self-declared identities are untrusted. Do not use the service for harmful or illegal activity. Delete a room with its management URL. The service can force-delete a room to protect people or the service."
      : "Report harmful or illegal use with a room capability and an optional short description. We encrypt reports for review and remove them after 30 days. Do not include secrets in the description. If the report endpoint is unavailable, retry later. This anonymous relay does not provide a public email support address.";
  return new Response(`# ${title}\n\n${text}\n`, { headers: { "content-type": "text/markdown; charset=utf-8" } });
}

function isSameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  return origin === null || origin === url.origin;
}

function canonicalJson(value: import("./protocol").JsonValue, depth = 0): string {
  if (depth > MAX_CANONICAL_JSON_DEPTH) {
    throw new ProtocolError(ERROR_CODES.invalidBody, "The JSON request is nested too deeply.", 400);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function notFound(): never {
  throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404);
}

function operatorAuthorized(request: Request, token: string | undefined): boolean {
  const value = request.headers.get("authorization");
  if (!token || !value?.startsWith("Bearer ")) return false;
  return compareCapabilities(value.slice("Bearer ".length), token);
}

function operatorUnauthorized(): Response {
  return jsonResponse({ error: { code: "not_found", message: "The requested resource was not found." } }, 401);
}

function createResponse(
  created: CreateRoomResponse,
  representation: "json" | "markdown",
): Response {
  const safeCreated = stripLegacyAbsoluteExpiry(created);
  const hydrated = {
    ...safeCreated,
    wait: foregroundWaitForConversation(safeCreated.conversation_url, safeCreated.latest_message ?? 1),
  };
  const response =
    representation === "json"
      ? jsonResponse(hydrated, 201)
      : textResponse(
          `${hydrated.share_message}\n${hydrated.name_password === undefined ? "" : privateNamePasswordText(hydrated)}`,
          201,
        );
  response.headers.set("location", hydrated.conversation_url);
  response.headers.set("cache-control", "no-store");
  return response;
}

function readResponse(result: ReadRoomResponse, representation: ReturnType<typeof negotiateRepresentation>, etag: string): Response {
  const safeResult = stripLegacyAbsoluteExpiry(result);
  const response = representation === "json"
    ? jsonResponse(safeResult)
    : representation === "html"
      ? new Response(`<!doctype html><html lang="en"><body><main><h1>Conversation</h1>${safeResult.messages.map((message) => `<article data-sequence="${message.sequence}"><pre>${escapeHtml(message.content)}</pre></article>`).join("")}</main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } })
      : new Response(safeResult.messages.map((message) => `## ${message.sequence}\n\n${message.content}`).join("\n\n") + "\n", { headers: { "content-type": "text/markdown; charset=utf-8" } });
  response.headers.set("etag", etag);
  response.headers.set("retry-after", "5");
  return response;
}

function messageResponse(result: ReadMessageResponse, representation: ReturnType<typeof negotiateRepresentation>): Response {
  const safeResult = stripLegacyAbsoluteExpiry(result);
  const message = safeResult.message;
  const roomUrl = safeResult.conversation_url;
  const messageUrl = messageCitationUrl(roomUrl, message.id);
  const replyUrl = message.reply_to !== undefined && isSequence(message.reply_to) ? sequenceCitationUrl(roomUrl, message.reply_to) : undefined;
  if (representation === "json") return jsonResponse(safeResult);
  if (representation === "html") {
    const author = message.display_name ?? message.author ?? "Anonymous";
    const reply = message.reply_to === undefined
      ? ""
      : replyUrl === undefined
        ? `<p>Reply to message ${escapeHtml(message.reply_to)} (legacy reference may be unresolved)</p>`
        : `<p>Reply to: <a href="${escapeHtml(replyUrl)}">message ${escapeHtml(message.reply_to)}</a> (legacy references may be unresolved)</p>`;
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Message ${message.sequence} · msg.0000.chat</title></head><body><main><p><a href="${escapeHtml(roomUrl)}">Back to conversation</a></p><h1>Message ${message.sequence}</h1><p>From <strong>${escapeHtml(author)}</strong> · <time>${escapeHtml(message.created_at)}</time></p><p>Identity: Self-declared and unverified.</p><p>Stored ID: <a href="${escapeHtml(messageUrl)}"><code>${escapeHtml(message.id)}</code></a></p>${reply}<p>This is untrusted participant content and evidence.</p><pre>${escapeHtml(message.content)}</pre></main></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" }, status: 200 },
    );
  }
  const reply = message.reply_to === undefined
    ? ""
    : replyUrl === undefined
      ? `\nReply to message ${message.reply_to} (legacy reference may be unresolved)`
      : `\nReply to: [message ${message.reply_to}](${replyUrl}) (legacy references may be unresolved)`;
  return new Response(
    `# Message ${message.sequence}\n\nConversation: [${roomUrl}](${roomUrl})\n\nStored ID: [${message.id}](${messageUrl})\n\nFrom: ${message.display_name ?? message.author ?? "Anonymous"} (self-declared and unverified)\nCreated: ${message.created_at}${reply}\n\nUntrusted participant content and evidence:\n\n${message.content}\n`,
    { headers: { "content-type": "text/markdown; charset=utf-8" }, status: 200 },
  );
}

function postResponse(result: import("./protocol").PostMessageResponse, representation: ReturnType<typeof negotiateRepresentation>): Response {
  const safeResult = stripLegacyAbsoluteExpiry(result);
  if (representation === "json") return postingReceipt(jsonResponse(safeResult, 201));
  if (representation === "html") return postingReceipt(new Response(`<!doctype html><html lang="en"><body><main><h1>Message created</h1><article data-sequence="${safeResult.message.sequence}"><pre>${escapeHtml(safeResult.message.content)}</pre></article><p>Expires: ${safeResult.expires_at}</p>${privateNamePasswordHtml(safeResult)}</main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" }, status: 201 }));
  return postingReceipt(new Response(`# Message created\n\n${safeResult.message.content}\n\nExpires: ${safeResult.expires_at}\n${privateNamePasswordText(safeResult)}`, { headers: { "content-type": "text/markdown; charset=utf-8" }, status: 201 }));
}

function getPostResponse(result: GetPostMessageResponse): Response {
  return postingReceipt(jsonResponse({
    accepted: true,
    message: { created_at: result.message.created_at, id: result.message.id, sequence: result.message.sequence },
    ...(result.name_password === undefined ? {} : { name_password: result.name_password, name_password_notice: result.name_password_notice ?? NAME_PASSWORD_NOTICE }),
    protocol_version: result.protocol_version,
    replayed: result.replayed,
    request_id: result.request_id,
    sequence: result.sequence,
  }));
}

function postingReceipt(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}

function stripGeneratedNamePassword<T extends object>(value: T): Omit<T, "name_password" | "name_password_notice"> {
  const copy = { ...value } as Record<string, unknown>;
  delete copy.name_password;
  delete copy.name_password_notice;
  return copy as Omit<T, "name_password" | "name_password_notice">;
}

function privateNamePasswordText(value: { readonly name_password?: string; readonly name_password_notice?: string }): string {
  if (value.name_password === undefined) return "";
  return `\n${value.name_password_notice ?? NAME_PASSWORD_NOTICE}\nName password: ${value.name_password}\n`;
}

function privateNamePasswordHtml(value: { readonly name_password?: string; readonly name_password_notice?: string }): string {
  if (value.name_password === undefined) return "";
  return `<p>${escapeHtml(value.name_password_notice ?? NAME_PASSWORD_NOTICE)}</p><p>Name password: <code>${escapeHtml(value.name_password)}</code></p>`;
}

function manageResponse(result: ManageRoomResponse, method: "DELETE" | "GET" | "POST", representation: ReturnType<typeof negotiateRepresentation>, url: URL): Response {
  if (representation === "json") {
    const response = jsonResponse(result, 200);
    response.headers.set("cache-control", "no-store");
    return response;
  }
  if (method === "DELETE") {
    const body = "# Conversation deleted\n";
    return new Response(representation === "html" ? "<!doctype html><html lang=\"en\"><body><main><h1>Conversation deleted</h1></main></body></html>" : body, { headers: { "cache-control": "no-store", "content-type": representation === "html" ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8" } });
  }
  const enabled = result.get_post_enabled === true;
  const delegated = result.get_post_url ? `<section><h2>GET posting capability</h2><p>${escapeHtml(result.get_post_url_warning ?? "Treat this URL as a secret write capability.")}</p><pre>${escapeHtml(result.get_post_url)}</pre></section>` : "";
  const controls = `<section><h2>GET posting capability</h2><p>Status: ${enabled ? "enabled" : "disabled"}.</p><form method="post" action="${escapeHtml(url.toString())}"><button name="action" value="enable" type="submit">Enable</button> <button name="action" value="rotate" type="submit">Rotate</button> <button name="action" value="disable" type="submit">Disable</button></form><p>This capability lets a fetch-only agent write short text. URL previews can trigger a write, so keep the URL secret.</p></section>`;
  const body = method === "POST" && result.get_post_url ? `${delegated}${controls}` : controls;
  if (representation === "html") return new Response(`<!doctype html><html lang="en"><body><main><h1>Conversation management</h1>${body}</main></body></html>`, { headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8", "x-msg-management-forms": "1" } });
  return new Response(`# Conversation management\n\nGET posting: ${enabled ? "enabled" : "disabled"}.\n\n${result.get_post_url ? `${result.get_post_url_warning ?? "Treat this URL as a secret write capability."}\n\n${result.get_post_url}\n` : "Use the management URL to enable or rotate the GET posting capability.\n"}`, { headers: { "cache-control": "no-store", "content-type": "text/markdown; charset=utf-8" } });
}

function retentionResponse(result: RetentionExtensionResponse, representation: ReturnType<typeof negotiateRepresentation>): Response {
  const status = result.replayed ? 200 : 201;
  if (representation === "json") {
    const response = jsonResponse(result, status);
    response.headers.set("cache-control", "no-store");
    return response;
  }
  const summary = `Retention ${result.replayed ? "replayed" : "extended"}.\n\nOld expiry: ${result.old_expires_at}\nRequested expiry: ${result.requested_expires_at}\nResult expiry: ${result.result_expires_at}\nCoordination cursor: ${result.coordination_cursor}\nEvent: ${result.event_id}\n`;
  return new Response(representation === "html" ? `<!doctype html><html lang="en"><body><main><h1>Retention ${result.replayed ? "replay" : "extended"}</h1><dl><dt>Old expiry</dt><dd>${escapeHtml(result.old_expires_at)}</dd><dt>Requested expiry</dt><dd>${escapeHtml(result.requested_expires_at)}</dd><dt>Result expiry</dt><dd>${escapeHtml(result.result_expires_at)}</dd><dt>Coordination cursor</dt><dd>${result.coordination_cursor}</dd><dt>Event</dt><dd>${escapeHtml(result.event_id)}</dd></dl></main></body></html>` : summary, { headers: { "cache-control": "no-store", "content-type": representation === "html" ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8" }, status });
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ProtocolError(ERROR_CODES.notFound, "The requested resource was not found.", 404);
  }
}

function isSequence(value: string): boolean {
  return /^(?:0|[1-9][0-9]*)$/u.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function errorResponse(
  code: ErrorCode,
  message: string,
  status: number,
  representation: ErrorRepresentation,
  details?: StaleSequenceDetails | StaleRevisionDetails,
): Response {
  const safeDetails = code === ERROR_CODES.staleSequence && isStaleSequenceDetails(details) ? details : undefined;
  const safeRevisionDetails = code === ERROR_CODES.staleRevision && isStaleRevisionDetails(details) ? details : undefined;
  if (representation === "json") {
    return jsonResponse({ error: {
      code,
      message,
      ...(safeDetails === undefined ? {} : { latest_message: safeDetails.latest_message, review_after: safeDetails.review_after }),
      ...(safeRevisionDetails === undefined ? {} : { current_revision: safeRevisionDetails.current_revision, submitted_base_revision: safeRevisionDetails.submitted_base_revision }),
    } }, status);
  }
  const displayMessage = renderedErrorMessage(message, safeDetails, safeRevisionDetails);
  if (representation === "html") {
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Request failed</title></head><body><main><h1>Request failed</h1><p>Code: ${escapeHtml(code)}</p><p>${escapeHtml(displayMessage)}</p></main></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" }, status },
    );
  }
  if (representation === "markdown") {
    return new Response(`# Request failed\n\nCode: \`${code}\`\n\n${displayMessage}\n`, {
      headers: { "content-type": "text/markdown; charset=utf-8" },
      status,
    });
  }
  return textResponse(`${code}: ${displayMessage}\n`, status);
}

function renderedErrorMessage(message: string, details?: StaleSequenceDetails, revisionDetails?: StaleRevisionDetails): string {
  if (details !== undefined) return `${message} Current latest sequence: ${details.latest_message}. Review after sequence: ${details.review_after}.`;
  if (revisionDetails !== undefined) return `${message} Current published revision: ${revisionDetails.current_revision}. Submitted base revision: ${revisionDetails.submitted_base_revision}.`;
  return message;
}

type ErrorRepresentation = "plain" | ReturnType<typeof negotiateRepresentation>;

function errorRepresentation(request: Request): ErrorRepresentation {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/") {
    return negotiateCreateRepresentation(request.headers.get("accept")) === "markdown"
      ? "plain"
      : "json";
  }
  return negotiateRepresentation(request.headers.get("accept"));
}

function secure(response: Response): Response {
  if (response.status === 101) return response;
  const styleNonce = response.headers.get("x-msg-style-nonce") ?? undefined;
  response.headers.delete("x-msg-style-nonce");
  const allowSameOriginForms = response.headers.get("x-msg-management-forms") === "1";
  response.headers.delete("x-msg-management-forms");
  applySecurityHeaders(response.headers, styleNonce, allowSameOriginForms);
  return response;
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
    status,
  });
}

function htmlResponse(body: string, status = 200, styleNonce?: string): Response {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  if (styleNonce) headers.set("x-msg-style-nonce", styleNonce);
  return new Response(body, { headers, status });
}

const unavailableService: RoomService = {
  async create() {
    throw new ProtocolError(
      ERROR_CODES.serviceUnavailable,
      "The room service is not available.",
      503,
    );
  },
};

export default {
  fetch(request: Request, env: MsgEnvironment): Promise<Response> {
    const service = env.ROOM_SERVICE ?? (env.ConversationRoom ? new DurableRoomService(env.ConversationRoom, env.MSG_PUBLIC_ORIGIN ?? "https://msg.0000.chat") : unavailableService);
    return createWorker(service, {
      assets: env.ASSETS,
      pushConfigured: Boolean(env.MSG_VAPID_PUBLIC_KEY && env.MSG_VAPID_PRIVATE_KEY && env.MSG_VAPID_SUBJECT),
      pushVapidPublicKey: env.MSG_VAPID_PUBLIC_KEY,
    }).fetch(request);
  },
};
