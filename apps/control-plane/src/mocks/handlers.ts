import { http, HttpResponse, passthrough } from "msw";
import { z } from "zod";
import {
  CommunicatorIdSchema,
  DeliveryModeSchema,
  MAX_PROJECTION_CURSOR_CHARS,
  MAX_PROJECTION_PAGE_SIZE,
  MessagePageResultSchema,
} from "@communicator/contracts";
import {
  simulatedStore,
  type SimulatedMessageMode,
  type SimulatedScenario,
} from "./store";
import { paginateConversations } from "./conversation-pagination";
import { runtimeRealtimeClient } from "@/lib/realtime/runtime-client";

const sendMessageSchema = z.object({
  identity_id: CommunicatorIdSchema,
  body: z.string().min(1).max(20_000),
  delivery_mode: DeliveryModeSchema,
}).strict();

const simulatedMessageEventSchema = z.object({
  tenant_id: CommunicatorIdSchema,
  identity_id: CommunicatorIdSchema,
  connection_id: CommunicatorIdSchema,
  conversation_id: CommunicatorIdSchema,
  last_message_preview: z.string().max(280),
  last_activity_at: z.string().datetime({ offset: true }),
  unread_delta: z.number().int(),
}).strict();

const errorResponse = (
  status: 400 | 404 | 503,
  code: "invalid_request" | "not_found" | "service_unavailable",
) =>
  HttpResponse.json({
    error: {
      code,
      message: code === "not_found"
        ? "Resource not found"
        : code === "service_unavailable"
          ? "Service unavailable"
        : "Invalid request",
    },
  }, { status });

const boundedId = CommunicatorIdSchema.max(128);
const boundedCursor = z.string().min(1).max(MAX_PROJECTION_CURSOR_CHARS);
const boundedLimit = z.coerce.number().int().min(1).max(MAX_PROJECTION_PAGE_SIZE);

function hasOnlyQueryKeys(search: URLSearchParams, allowed: readonly string[]) {
  const allowedKeys = new Set(allowed);
  for (const key of search.keys()) {
    if (!allowedKeys.has(key)) return false;
  }
  return true;
}

function parseSingleQueryValue<T>(
  search: URLSearchParams,
  name: string,
  schema: z.ZodType<T>,
): T | null | undefined {
  const values = search.getAll(name);
  if (values.length > 1) return null;
  const value = values[0];
  if (value === undefined) return undefined;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const handlers = [
  http.get("*/api/v1/health", () => passthrough()),

  http.get("*/api/v1/session", () => HttpResponse.json(simulatedStore.session())),

  http.get("*/api/v1/identities", () =>
    HttpResponse.json(simulatedStore.identities())),

  http.get("*/api/v1/connections", ({ request }) => {
    const search = new URL(request.url).searchParams;
    if (!hasOnlyQueryKeys(search, ["identity_id"])) return errorResponse(400, "invalid_request");
    const identityId = parseSingleQueryValue(search, "identity_id", boundedId);
    if (!identityId) return errorResponse(400, "invalid_request");
    if (!simulatedStore.identities().some((item) => item.id === identityId)) {
      return errorResponse(404, "not_found");
    }
    return HttpResponse.json(simulatedStore.connections(identityId));
  }),

  http.get("*/api/v1/identities/:identityId/channels", ({ params }) => {
    const identityId = String(params.identityId);
    if (!boundedId.safeParse(identityId).success) return errorResponse(400, "invalid_request");
    if (!simulatedStore.identities().some((item) => item.id === identityId)) {
      return errorResponse(404, "not_found");
    }
    return HttpResponse.json(simulatedStore.channels(identityId));
  }),

  http.get("*/api/v1/identities/:identityId/conversations", ({ request, params }) => {
    const identityId = String(params.identityId);
    if (!boundedId.safeParse(identityId).success) return errorResponse(400, "invalid_request");
    const search = new URL(request.url).searchParams;
    if (!hasOnlyQueryKeys(search, ["channel_id", "cursor", "limit"])) {
      return errorResponse(400, "invalid_request");
    }
    const channelId = parseSingleQueryValue(search, "channel_id", boundedId);
    const cursor = parseSingleQueryValue(search, "cursor", boundedCursor);
    const limit = parseSingleQueryValue(search, "limit", boundedLimit);
    if (channelId === null || cursor === null || limit === null) {
      return errorResponse(400, "invalid_request");
    }
    const conversations = simulatedStore.conversations(identityId, channelId);
    if (!conversations) return errorResponse(404, "not_found");
    const result = paginateConversations(
      conversations,
      cursor === undefined
        ? (limit === undefined ? {} : { limit })
        : (limit === undefined ? { cursor } : { limit, cursor }),
    );
    return result.ok
      ? HttpResponse.json(result.page)
      : errorResponse(400, "invalid_request");
  }),

  http.get("*/api/v1/identities/:identityId/conversations/:conversationId", ({ params }) => {
    if (
      !boundedId.safeParse(String(params.identityId)).success
      || !boundedId.safeParse(String(params.conversationId)).success
    ) {
      return errorResponse(400, "invalid_request");
    }
    const conversation = simulatedStore.conversation(
      String(params.identityId),
      String(params.conversationId),
    );
    return conversation
      ? HttpResponse.json(conversation)
      : errorResponse(404, "not_found");
  }),

  http.get("*/api/v1/conversations/:conversationId/messages", ({ request, params }) => {
    if (!boundedId.safeParse(String(params.conversationId)).success) {
      return errorResponse(400, "invalid_request");
    }
    const search = new URL(request.url).searchParams;
    if (!hasOnlyQueryKeys(search, ["identity_id", "cursor", "limit"])) {
      return errorResponse(400, "invalid_request");
    }
    const identityId = parseSingleQueryValue(search, "identity_id", boundedId);
    const cursor = parseSingleQueryValue(search, "cursor", boundedCursor);
    const limit = parseSingleQueryValue(search, "limit", boundedLimit);
    if (!identityId || cursor === null || limit === null) {
      return errorResponse(400, "invalid_request");
    }
    const messageMode = simulatedStore.selectedMessageMode();
    if (messageMode === "error") {
      return HttpResponse.json({
        error: {
          code: "service_unavailable",
          message: "private backend detail",
        },
      }, { status: 503 });
    }
    const conversationId = String(params.conversationId);
    if (!simulatedStore.conversation(identityId, conversationId)) {
      return errorResponse(404, "not_found");
    }
    const page = simulatedStore.messages(conversationId, identityId, {
      ...(limit === undefined
        ? (messageMode === "pages" ? { limit: 2 } : {})
        : { limit: messageMode === "pages" ? Math.min(limit, 2) : limit }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    return page
      ? HttpResponse.json(MessagePageResultSchema.parse(page))
      : errorResponse(400, "invalid_request");
  }),

  http.get("*/api/v1/commands", ({ request }) => {
    const identityId = new URL(request.url).searchParams.get("identity_id");
    if (!identityId) return errorResponse(400, "invalid_request");
    return HttpResponse.json(simulatedStore.commands(identityId));
  }),

  http.post("*/api/v1/conversations/:conversationId/messages", async ({ request, params }) => {
    const idempotencyKey = request.headers.get("Idempotency-Key");
    if (!idempotencyKey) return errorResponse(400, "invalid_request");

    const parsed = sendMessageSchema.safeParse(await request.json());
    if (!parsed.success) return errorResponse(400, "invalid_request");

    const command = simulatedStore.commandForMessage({
      conversationId: String(params.conversationId),
      identityId: parsed.data.identity_id,
      body: parsed.data.body,
      deliveryMode: parsed.data.delivery_mode,
      idempotencyKey,
    });
    return command
      ? HttpResponse.json(command, { status: 202 })
      : errorResponse(404, "not_found");
  }),

  http.post("*/api/v1/testing/realtime/message", async ({ request }) => {
    const parsed = simulatedMessageEventSchema.safeParse(await request.json());
    if (!parsed.success) return errorResponse(400, "invalid_request");
    const conversation = simulatedStore.conversation(parsed.data.identity_id, parsed.data.conversation_id);
    if (
      !conversation
      || conversation.tenant_id !== parsed.data.tenant_id
      || conversation.connection_id !== parsed.data.connection_id
    ) {
      return errorResponse(404, "not_found");
    }
    await runtimeRealtimeClient?.connect();
    runtimeRealtimeClient?.publishMessage({
      tenantId: parsed.data.tenant_id,
      identityId: parsed.data.identity_id,
      connectionId: parsed.data.connection_id,
      conversationId: parsed.data.conversation_id,
      lastMessagePreview: parsed.data.last_message_preview,
      lastActivityAt: parsed.data.last_activity_at,
      unreadDelta: parsed.data.unread_delta,
    });
    return HttpResponse.json({ status: "published" });
  }),

  http.post("*/api/v1/testing/reset", async ({ request }) => {
    let scenario: SimulatedScenario = "ready";
    let messageMode: SimulatedMessageMode = "normal";
    const contentType = request.headers.get("Content-Type") ?? "";
    if (contentType.includes("application/json")) {
      const parsed = z.object({
        scenario: z.enum(["ready", "attention_required"]).optional(),
        message_mode: z.enum(["normal", "pages", "error"]).optional(),
      }).safeParse(await request.json());
      if (!parsed.success) return errorResponse(400, "invalid_request");
      scenario = parsed.data.scenario ?? "ready";
      messageMode = parsed.data.message_mode ?? "normal";
    }
    simulatedStore.reset(scenario, messageMode);
    return HttpResponse.json({
      status: "reset",
      scenario,
      fixture_reset_at: simulatedStore.resetAtTime(),
    });
  }),
];
