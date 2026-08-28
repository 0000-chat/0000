import { http, HttpResponse, passthrough } from "msw";
import { z } from "zod";
import {
  CommunicatorIdSchema,
  DeliveryModeSchema,
} from "@communicator/contracts";
import { notFound, simulatedStore, type SimulatedScenario } from "./store";
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

const errorResponse = (status: 400 | 404, code: "bad_request" | "not_found") =>
  HttpResponse.json({
    error: {
      code,
      message: code === "not_found"
        ? "The requested resource is not available."
        : "The request is invalid.",
    },
  }, { status });

export const handlers = [
  http.get("*/api/v1/health", () => passthrough()),

  http.get("*/api/v1/me", () => HttpResponse.json(simulatedStore.me())),

  http.get("*/api/v1/identities", () =>
    HttpResponse.json(simulatedStore.identities())),

  http.get("*/api/v1/connections", ({ request }) => {
    const identityId = new URL(request.url).searchParams.get("identity_id");
    if (!identityId) return errorResponse(400, "bad_request");
    return HttpResponse.json(simulatedStore.connections(identityId));
  }),

  http.get("*/api/v1/identities/:identityId/channels", ({ params }) => {
    const identityId = String(params.identityId);
    if (!simulatedStore.identities().some((item) => item.id === identityId)) {
      return errorResponse(404, "not_found");
    }
    return HttpResponse.json(simulatedStore.channels(identityId));
  }),

  http.get("*/api/v1/identities/:identityId/conversations", ({ request, params }) => {
    const identityId = String(params.identityId);
    const search = new URL(request.url).searchParams;
    const channelId = search.get("channel_id") ?? undefined;
    const cursor = search.get("cursor") ?? undefined;
    const rawLimit = search.get("limit");
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    const conversations = simulatedStore.conversations(identityId, channelId);
    if (!conversations) return errorResponse(404, "not_found");
    const result = paginateConversations(
      conversations,
      cursor ? { limit, cursor } : { limit },
    );
    return result.ok
      ? HttpResponse.json(result.page)
      : errorResponse(400, "bad_request");
  }),

  http.get("*/api/v1/identities/:identityId/conversations/:conversationId", ({ params }) => {
    const conversation = simulatedStore.conversation(
      String(params.identityId),
      String(params.conversationId),
    );
    return conversation
      ? HttpResponse.json(conversation)
      : errorResponse(404, "not_found");
  }),

  http.get("*/api/v1/conversations", ({ request }) => {
    const identityId = new URL(request.url).searchParams.get("identity_id");
    if (!identityId) return errorResponse(400, "bad_request");
    return HttpResponse.json(simulatedStore.conversations(identityId));
  }),

  http.get("*/api/v1/conversations/:conversationId/messages", ({ request, params }) => {
    const identityId = new URL(request.url).searchParams.get("identity_id");
    const messages = identityId
      ? simulatedStore.messages(String(params.conversationId), identityId)
      : null;
    return messages ? HttpResponse.json(messages) : errorResponse(404, "not_found");
  }),

  http.get("*/api/v1/commands", ({ request }) => {
    const identityId = new URL(request.url).searchParams.get("identity_id");
    if (!identityId) return errorResponse(400, "bad_request");
    return HttpResponse.json(simulatedStore.commands(identityId));
  }),

  http.post("*/api/v1/conversations/:conversationId/messages", async ({ request, params }) => {
    const idempotencyKey = request.headers.get("Idempotency-Key");
    if (!idempotencyKey) return errorResponse(400, "bad_request");

    const parsed = sendMessageSchema.safeParse(await request.json());
    if (!parsed.success) return errorResponse(400, "bad_request");

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
    if (!parsed.success) return errorResponse(400, "bad_request");
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
    const contentType = request.headers.get("Content-Type") ?? "";
    if (contentType.includes("application/json")) {
      const parsed = z.object({
        scenario: z.enum(["ready", "attention_required"]).optional(),
      }).safeParse(await request.json());
      if (!parsed.success) return errorResponse(400, "bad_request");
      scenario = parsed.data.scenario ?? "ready";
    }
    simulatedStore.reset(scenario);
    return HttpResponse.json({
      status: "reset",
      scenario,
      fixture_reset_at: simulatedStore.resetAtTime(),
    });
  }),
];
