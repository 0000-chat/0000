import { AGENT_INSTRUCTIONS, jsonResponse, OPENAPI_DOCUMENT, renderDiscovery } from "./discovery";
import { buildAgentRepresentation, renderAgentText } from "./agent-representation";
import { agentBrowserAsset, renderAgentHomePage, renderAgentRoomPage, renderAgentStatusPage } from "./agent-browser";
import { browserAsset, browserIcon, MERMAID_ASSET_PATH, renderBrowserDocument } from "./browser";
import { browserViewRedirect, selectBrowserView } from "./browser-view";
import { ERROR_CODES, ProtocolError, type ErrorCode } from "./errors";
import {
  foregroundWaitForConversation,
  PROTOCOL_VERSION,
  stripLegacyAbsoluteExpiry,
  type CreateRoomResponse,
  type GetPostMessageResponse,
  type GetPostProbeResponse,
  type RequestBody,
  type ManageRoomResponse,
  type ReadRoomResponse,
  type RoomService,
} from "./protocol";
import { byteLength, compareCapabilities, MAX_ROOM_REQUEST_BYTES, roomEtag, validateCursor, validateIdempotencyKey, validateRequestId } from "./room-domain";
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
import { handleMcpRequest } from "./mcp";

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
  readonly publicOrigin?: string;
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
const CHATGPT_ORIGIN = "https://chatgpt.com";
const DELEGATED_POST_TOKEN_HEADER = "x-0000-post-token";
const CHATGPT_CREATE_PREFLIGHT_HEADERS = "content-type, accept, idempotency-key";
const CHATGPT_DELEGATED_POST_PREFLIGHT_HEADERS = `${CHATGPT_CREATE_PREFLIGHT_HEADERS}, ${DELEGATED_POST_TOKEN_HEADER}`;

type ChatGptCorsMode = "create" | "delegated-post" | "preflight" | "delegated-post-preflight" | undefined;

export function createWorker(service: RoomService, options: MsgWorkerOptions = {}): MsgWorker {
  return {
    async fetch(request) {
      const requestUrl = new URL(request.url);
      const corsMode = chatGptCorsMode(request, requestUrl);
      try {
        return secure(applyChatGptCors(await route(request, service, options), corsMode));
      } catch (error) {
        const representation = errorRepresentation(request);
        const agentHtml = representation === "html"
          && request.method === "GET"
          && selectBrowserView(requestUrl, request.headers.get("cookie")) === "agent"
          && (requestUrl.pathname === "/" || /^\/[^/]+$/u.test(requestUrl.pathname));
        const response =
          error instanceof ProtocolError
            ? agentHtml
              ? htmlResponse(renderAgentStatusPage(error.status, error.code, error.message, requestUrl), error.status)
              : errorResponse(error.code, error.message, error.status, representation)
            : errorResponse(
                ERROR_CODES.internal,
                "The relay could not complete the request.",
                500,
                representation,
              );
        if (error instanceof ProtocolError && error.retryAfterSeconds !== undefined) {
          response.headers.set("retry-after", String(error.retryAfterSeconds));
        }
        return secure(applyChatGptCors(response, corsMode));
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
  const corsMode = chatGptCorsMode(request, url);
  if (corsMode === "preflight" || corsMode === "delegated-post-preflight") {
    return new Response(null, {
      headers: {
        "access-control-allow-headers": corsMode === "delegated-post-preflight"
          ? CHATGPT_DELEGATED_POST_PREFLIGHT_HEADERS
          : CHATGPT_CREATE_PREFLIGHT_HEADERS,
        "access-control-allow-methods": "POST",
      },
      status: 204,
    });
  }
  if (url.pathname === "/mcp") {
    return handleMcpRequest(request, service, {
      postDisabled: options.postDisabled,
      publicOrigin: options.publicOrigin,
      rateLimits: options.rateLimits,
    });
  }
  if (request.method !== "GET" && request.method !== "HEAD" && !isSameOrigin(request, url) && corsMode !== "create" && corsMode !== "delegated-post") {
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
        return createResponse(claim.response, negotiateCreateRepresentation(request.headers.get("accept")));
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

  const agentMatch = /^\/([^/]+)\/agent$/.exec(url.pathname);
  if (agentMatch && request.method === "GET") {
    if (!service.read) return notFound();
    await enforceRateLimit(request, options.rateLimits?.reads);
    const result = stripLegacyAbsoluteExpiry(await service.read({
      after: validateCursor(url.searchParams.get("after")),
      room: agentMatch[1],
    })) as unknown as ReadRoomResponse;
    const document = buildAgentRepresentation(result);
    return request.headers.get("accept")?.toLowerCase().includes("application/json")
      ? jsonResponse(document)
      : textResponse(renderAgentText(document));
  }

  const getPostMatch = /^\/([^/]+)\/post$/.exec(url.pathname);
  if (getPostMatch && request.method === "POST") {
    if (!service.getPost) return notFound();
    if (options.postDisabled) {
      throw new ProtocolError(ERROR_CODES.serviceUnavailable, "New messages are temporarily unavailable.", 503);
    }
    if (!isSameOrigin(request, url) && corsMode !== "delegated-post") {
      throw new ProtocolError(ERROR_CODES.forbidden, "Cross-origin state changes are not allowed.", 403);
    }
    const token = parseDelegatedPostToken(request, url);
    const body = await parseRequestBody(request, { maxBytes: MAX_ROOM_REQUEST_BYTES });
    const requestId = delegatedPostRequestId(request, body);
    await enforceRateLimit(request, options.rateLimits?.posts);
    const result = stripLegacyAbsoluteExpiry(await service.getPost({
      body,
      requestId,
      room: getPostMatch[1],
      token,
    })) as unknown as GetPostMessageResponse;
    return getPostResponse(result);
  }
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
      requestId: getPost.requestId,
      room: getPostMatch[1],
      token: getPost.token,
    })) as unknown as GetPostMessageResponse;
    return getPostResponse(result);
  }

  const getPostProbeMatch = /^\/([^/]+)\/post-probe\/([^/]+)$/.exec(url.pathname);
  if (getPostProbeMatch && request.method === "GET") {
    if (!service.getPostProbe) return notFound();
    if (options.postDisabled) {
      throw new ProtocolError(ERROR_CODES.serviceUnavailable, "New messages are temporarily unavailable.", 503);
    }
    if (url.search) {
      throw new ProtocolError(ERROR_CODES.invalidBody, "The GET posting probe does not accept a query.", 400);
    }
    if (!isSameOrigin(request, url)) {
      throw new ProtocolError(ERROR_CODES.forbidden, "Cross-origin state changes are not allowed.", 403);
    }
    const token = boundedPathValue(getPostProbeMatch[2]!, "token", MAX_GET_POST_TOKEN_CHARS, MAX_GET_POST_TOKEN_BYTES);
    await enforceRateLimit(request, options.rateLimits?.posts);
    const result = stripLegacyAbsoluteExpiry(await service.getPostProbe({ room: getPostProbeMatch[1]!, token })) as unknown as GetPostProbeResponse;
    return getPostProbeResponse(result);
  }

  const roomMatch = /^\/([^/]+)$/.exec(url.pathname);
  if (roomMatch) {
    const room = roomMatch[1];
    if (request.method === "GET") {
      if (!service.read) return notFound();
      await enforceRateLimit(request, options.rateLimits?.reads);
      const after = validateCursor(url.searchParams.get("after"));
      const result = stripLegacyAbsoluteExpiry(await service.read({ after, room })) as unknown as ReadRoomResponse;
      if (negotiateRepresentation(request.headers.get("accept")) === "html") {
        if (selectBrowserView(url, request.headers.get("cookie")) === "agent") {
          return htmlResponse(renderAgentRoomPage(result, url));
        }
        const page = renderBrowserDocument({ pushPublicKey: options.pushConfigured ? options.pushVapidPublicKey : undefined, room, title: "Temporary conversation", url });
        return htmlResponse(page.html, 200, page.styleNonce);
      }
      const etag = roomEtag(result.latest_message, after);
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
      const result = stripLegacyAbsoluteExpiry(await service.post({
        body: await parseRequestBody(request, { maxBytes: MAX_ROOM_REQUEST_BYTES }),
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
  if (manageMatch && (request.method === "GET" || request.method === "DELETE" || request.method === "POST")) {
    if (!service.manage) return notFound();
    const action = request.method === "POST" ? await parseManagementAction(request) : undefined;
    const result = await service.manage({ action, method: request.method, room: manageMatch[1], token: manageMatch[2] });
    return manageResponse(result, request.method, negotiateRepresentation(request.headers.get("accept")), url);
  }

  return errorResponse(
    ERROR_CODES.notFound,
    "The requested resource was not found.",
    404,
    negotiateRepresentation(request.headers.get("accept")),
  );
}

const GET_POST_QUERY_FIELDS = new Set(["author", "client", "content", "display_name", "reply_to", "request_id", "semantic_type", "token"]);

interface GetPostQuery {
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
  const content = requiredQueryValue(url.searchParams.get("content"), "content");
  if (byteLength(content) > MAX_GET_POST_CONTENT_BYTES) {
    throw new ProtocolError(ERROR_CODES.bodyTooLarge, "The GET posting content is too large.", 413);
  }
  const input: Record<string, string> = { content };
  for (const field of ["author", "display_name", "client", "semantic_type", "reply_to"] as const) {
    const value = url.searchParams.get(field);
    if (value !== null) input[field] = value;
  }
  return { input, requestId, token };
}

function parseDelegatedPostToken(request: Request, url: URL): string {
  if (byteLength(request.url) > MAX_GET_POST_URL_BYTES) {
    throw new ProtocolError(ERROR_CODES.bodyTooLarge, "The delegated posting URL is too large.", 413);
  }
  if (url.search) {
    throw new ProtocolError(ERROR_CODES.invalidBody, "The delegated POST URL must not contain a query.", 400);
  }
  const values = request.headers.get(DELEGATED_POST_TOKEN_HEADER);
  if (values === null || values === "") {
    throw new ProtocolError(ERROR_CODES.invalidBody, `The ${DELEGATED_POST_TOKEN_HEADER} header is required.`, 400);
  }
  if (values !== values.trim() || values.includes(",") || !/^[A-Za-z0-9_-]+$/u.test(values)) {
    throw new ProtocolError(ERROR_CODES.invalidBody, `The ${DELEGATED_POST_TOKEN_HEADER} header is malformed or duplicated.`, 400);
  }
  if (Array.from(values).length > MAX_GET_POST_TOKEN_CHARS || byteLength(values) > MAX_GET_POST_TOKEN_BYTES) {
    throw new ProtocolError(ERROR_CODES.bodyTooLarge, `The ${DELEGATED_POST_TOKEN_HEADER} header is too large.`, 413);
  }
  return values;
}

function delegatedPostRequestId(request: Request, body: RequestBody): string {
  const header = request.headers.get("idempotency-key");
  if (header !== null) return validateIdempotencyKey(header);
  if (body.kind === "json" && body.value !== null && !Array.isArray(body.value) && typeof body.value === "object") {
    const clientMessageId = body.value.client_message_id;
    if (typeof clientMessageId === "string") return validateRequestId(clientMessageId);
  }
  throw new ProtocolError(ERROR_CODES.invalidBody, "The delegated POST requires Idempotency-Key or client_message_id.", 400);
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

function boundedPathValue(value: string, field: string, maxChars: number, maxBytes: number): string {
  if (!value || Array.from(value).length > maxChars || byteLength(value) > maxBytes) {
    throw new ProtocolError(ERROR_CODES.bodyTooLarge, `The ${field} path value is too large.`, 413);
  }
  return value;
}

function rejectGetPostPrefetch(request: Request): void {
  const prefetchHeaders = ["purpose", "sec-purpose", "x-moz"].map((name) => request.headers.get(name)?.toLowerCase() ?? "");
  if (prefetchHeaders.some((value) => value.includes("prefetch") || value.includes("prerender"))) {
    throw new ProtocolError(ERROR_CODES.forbidden, "GET posting URLs cannot be used by prefetch or prerender requests.", 403);
  }
}

async function parseManagementAction(request: Request): Promise<"disable" | "enable" | "rotate" | "disable_mcp" | "enable_mcp"> {
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
  if (action !== "enable" && action !== "disable" && action !== "rotate" && action !== "enable_mcp" && action !== "disable_mcp") {
    throw new ProtocolError(ERROR_CODES.invalidBody, "The management action is invalid.", 400);
  }
  return action;
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

function chatGptCorsMode(request: Request, url: URL): ChatGptCorsMode {
  const delegatedPost = /^\/[^/]+\/post$/u.test(url.pathname);
  if (request.headers.get("origin") !== CHATGPT_ORIGIN || (url.pathname !== "/" && !delegatedPost)) return undefined;
  if (request.method === "POST" && mediaType(request.headers.get("content-type")) === "application/json") return delegatedPost ? "delegated-post" : "create";
  if (request.method === "OPTIONS"
    && request.headers.get("access-control-request-method") === "POST"
    && allowedChatGptPreflightHeaders(request.headers.get("access-control-request-headers"), delegatedPost)) {
    return delegatedPost ? "delegated-post-preflight" : "preflight";
  }
  return undefined;
}

function allowedChatGptPreflightHeaders(value: string | null, delegatedPost: boolean): boolean {
  if (value === null || value.trim() === "") return true;
  return value.split(",").every((header) => {
    const normalized = header.trim().toLowerCase();
    return normalized === "content-type"
      || normalized === "accept"
      || normalized === "idempotency-key"
      || (delegatedPost && normalized === DELEGATED_POST_TOKEN_HEADER);
  });
}

function mediaType(value: string | null): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function applyChatGptCors(response: Response, mode: ChatGptCorsMode): Response {
  if (mode === undefined) return response;
  response.headers.set("access-control-allow-origin", CHATGPT_ORIGIN);
  response.headers.set("vary", "Origin");
  if (mode === "create" || mode === "delegated-post") response.headers.set("access-control-expose-headers", "Location, Retry-After");
  return response;
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
          `${hydrated.share_message}\n`,
          201,
        );
  response.headers.set("location", hydrated.conversation_url);
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

function postResponse(result: import("./protocol").PostMessageResponse, representation: ReturnType<typeof negotiateRepresentation>): Response {
  const safeResult = stripLegacyAbsoluteExpiry(result);
  if (representation === "json") return jsonResponse(safeResult, 201);
  if (representation === "html") return new Response(`<!doctype html><html lang="en"><body><main><h1>Message created</h1><article data-sequence="${safeResult.message.sequence}"><pre>${escapeHtml(safeResult.message.content)}</pre></article><p>Expires: ${safeResult.expires_at}</p></main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" }, status: 201 });
  return new Response(`# Message created\n\n${safeResult.message.content}\n\nExpires: ${safeResult.expires_at}\n`, { headers: { "content-type": "text/markdown; charset=utf-8" }, status: 201 });
}

function getPostResponse(result: GetPostMessageResponse): Response {
  return jsonResponse({
    accepted: true,
    protocol_version: result.protocol_version,
    replayed: result.replayed,
    request_id: result.request_id,
    sequence: result.sequence,
  });
}

function getPostProbeResponse(result: GetPostProbeResponse): Response {
  if (result.active !== true || result.get_post_enabled !== true) {
    throw new ProtocolError(ERROR_CODES.internal, "The GET posting probe returned an invalid result.", 500);
  }
  return textResponse("GET posting capability is valid.\n");
}

function manageResponse(result: ManageRoomResponse, method: "DELETE" | "GET" | "POST", representation: ReturnType<typeof negotiateRepresentation>, url: URL): Response {
  if (representation === "json") return jsonResponse(result, 200);
  if (method === "DELETE") {
    const body = "# Conversation deleted\n";
    return new Response(representation === "html" ? `<!doctype html><html lang="en"><body><main><h1>Conversation deleted</h1></main></body></html>` : body, { headers: { "content-type": representation === "html" ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8" } });
  }
  const agentEnabled = result.agent_posting_enabled === true;
  const delegatedEnabled = result.get_post_enabled === true;
  const delegated = result.get_post_url ? `<section><h2>GET posting capability</h2><p>${escapeHtml(result.get_post_url_warning ?? "Treat this URL as a secret write capability.")}</p><pre>${escapeHtml(result.get_post_url)}</pre></section>` : "";
  const controls = `<section><h2>Anonymous MCP posting</h2><p>Status: ${agentEnabled ? "enabled" : "disabled"}.</p><form method="post" action="${escapeHtml(url.toString())}"><button name="action" value="enable_mcp" type="submit">Enable anonymous MCP posting</button> <button name="action" value="disable_mcp" type="submit">Disable anonymous MCP posting</button></form><p>MCP clients use the canonical public room URL. This setting is independent from the delegated capability below.</p></section><section><h2>Delegated GET posting</h2><p>Status: ${delegatedEnabled ? "enabled" : "disabled"}.</p><form method="post" action="${escapeHtml(url.toString())}"><button name="action" value="enable" type="submit">Enable delegated invitation</button> <button name="action" value="rotate" type="submit">Rotate delegated invitation</button> <button name="action" value="disable" type="submit">Disable delegated invitation</button></form><p>The delegated capability supports POST from a configured ChatGPT Action or connector and GET for fetch-only agents. Keep delegated URLs secret; use Idempotency-Key or client_message_id for safe retries.</p></section>`;
  const body = method === "POST" && result.get_post_url
    ? `${delegated}${controls}`
    : controls;
  if (representation === "html") return new Response(`<!doctype html><html lang="en"><body><main><h1>Conversation management</h1>${body}</main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "x-msg-management-forms": "1" } });
  return new Response(`# Conversation management\n\nAnonymous MCP posting: ${agentEnabled ? "enabled" : "disabled"}.\nDelegated GET posting: ${delegatedEnabled ? "enabled" : "disabled"}.\n\n${result.get_post_url ? `${result.get_post_url_warning ?? "Treat this URL as a secret write capability."}\n\n${result.get_post_url}\n` : "Use the management URL to enable or rotate the delegated posting capability.\n"}`, { headers: { "content-type": "text/markdown; charset=utf-8" } });
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function errorResponse(
  code: ErrorCode,
  message: string,
  status: number,
  representation: ErrorRepresentation,
): Response {
  if (representation === "json") {
    return jsonResponse({ error: { code, message } }, status);
  }
  if (representation === "html") {
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Request failed</title></head><body><main><h1>Request failed</h1><p>Code: ${code}</p><p>${message}</p></main></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" }, status },
    );
  }
  if (representation === "markdown") {
    return new Response(`# Request failed\n\nCode: \`${code}\`\n\n${message}\n`, {
      headers: { "content-type": "text/markdown; charset=utf-8" },
      status,
    });
  }
  return textResponse(`${code}: ${message}\n`, status);
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
  applySecurityHeaders(response.headers, { allowSameOriginForms, styleNonce });
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
      publicOrigin: env.MSG_PUBLIC_ORIGIN,
    }).fetch(request);
  },
};
