import { http, HttpResponse, passthrough } from "msw";
import { z } from "zod";
import {
  CommunicatorIdSchema,
  DeliveryModeSchema,
  AccountGrantMutationSchema,
  AccountGrantPageSchema,
  AccountGrantSchema,
  AccountGrantUpdateSchema,
  HistoryImportAdvanceRequestSchema,
  HistoryImportDetailSchema,
  HistoryImportStartRequestSchema,
  ProviderCapabilitySchema,
  LinkSessionActionRequestSchema,
  LinkSessionStartSchema,
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

const sendMessageSchema = z
  .object({
    identity_id: CommunicatorIdSchema,
    body: z.string().min(1).max(20_000),
    delivery_mode: DeliveryModeSchema,
  })
  .strict();

const commandDecisionSchema = z
  .object({ idempotency_key: z.string().trim().min(1).max(200) })
  .strict();

const simulatedMessageEventSchema = z
  .object({
    tenant_id: CommunicatorIdSchema,
    identity_id: CommunicatorIdSchema,
    connection_id: CommunicatorIdSchema,
    conversation_id: CommunicatorIdSchema,
    last_message_preview: z.string().max(280),
    last_activity_at: z.string().datetime({ offset: true }),
    unread_delta: z.number().int(),
  })
  .strict();

const errorResponse = (
  status: 400 | 403 | 404 | 409 | 503,
  code: "invalid_request" | "forbidden" | "not_found" | "service_unavailable",
) =>
  HttpResponse.json(
    {
      error: {
        code,
        message:
          code === "not_found"
            ? "Resource not found"
            : code === "service_unavailable"
              ? "Service unavailable"
              : "Invalid request",
      },
    },
    { status },
  );

const boundedId = CommunicatorIdSchema.max(128);
const boundedCursor = z.string().min(1).max(MAX_PROJECTION_CURSOR_CHARS);
const boundedLimit = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_PROJECTION_PAGE_SIZE);

function pageByCursor<T>(
  items: readonly T[],
  cursor: string | undefined,
  limit: number | undefined,
  key: (item: T) => string,
) {
  const pageSize = limit ?? 2;
  const start =
    cursor === undefined ? 0 : items.findIndex((item) => key(item) > cursor);
  const offset = start < 0 ? items.length : start;
  const visible = items.slice(offset, offset + pageSize);
  return {
    items: visible,
    next_cursor:
      offset + pageSize < items.length && visible.length > 0
        ? key(visible[visible.length - 1]!)
        : null,
  };
}

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

  http.get("*/api/v1/session", () =>
    HttpResponse.json(simulatedStore.session()),
  ),

  http.post(
    "*/api/v1/identities/:identityId/link-sessions",
    async ({ request, params }) => {
      if (!request.headers.get("Idempotency-Key"))
        return errorResponse(400, "invalid_request");
      const input = LinkSessionStartSchema.safeParse(await request.json());
      const identityId = String(params.identityId);
      if (!input.success || input.data.confirmed_identity_id !== identityId) {
        return errorResponse(400, "invalid_request");
      }
      const session = simulatedStore.startLinkSession(identityId, input.data);
      return session
        ? HttpResponse.json(session, { status: 201 })
        : errorResponse(403, "forbidden");
    },
  ),

  http.get("*/api/v1/link-sessions/:sessionId", ({ params }) => {
    const session = simulatedStore.linkSession(String(params.sessionId));
    return session
      ? HttpResponse.json(session)
      : errorResponse(404, "not_found");
  }),

  http.post(
    "*/api/v1/link-sessions/:sessionId/actions",
    async ({ request, params }) => {
      if (!request.headers.get("Idempotency-Key"))
        return errorResponse(400, "invalid_request");
      const input = LinkSessionActionRequestSchema.safeParse(
        await request.json(),
      );
      if (!input.success) return errorResponse(400, "invalid_request");
      const actionDelay = simulatedStore.linkActionDelay();
      if (actionDelay > 0 && input.data.action === "poll") {
        await new Promise((resolve) => setTimeout(resolve, actionDelay));
      }
      const result = simulatedStore.actLinkSession(
        String(params.sessionId),
        input.data,
      );
      if (result.kind !== "ok") {
        return errorResponse(
          result.kind === "missing" ? 404 : 409,
          result.kind === "missing" ? "not_found" : "invalid_request",
        );
      }
      return HttpResponse.json(result.session);
    },
  ),

  http.delete("*/api/v1/link-sessions/:sessionId", ({ request, params }) => {
    if (!request.headers.get("Idempotency-Key"))
      return errorResponse(400, "invalid_request");
    const session = simulatedStore.cancelLinkSession(String(params.sessionId));
    return session
      ? HttpResponse.json(session)
      : errorResponse(404, "not_found");
  }),

  http.get("*/api/v1/accounts", ({ request }) => {
    const search = new URL(request.url).searchParams;
    if (!hasOnlyQueryKeys(search, ["identity_id", "cursor", "limit"]))
      return errorResponse(400, "invalid_request");
    const identityId = search.get("identity_id") ?? undefined;
    const cursor = parseSingleQueryValue(search, "cursor", boundedCursor);
    const limit = parseSingleQueryValue(search, "limit", boundedLimit);
    if (cursor === null || limit === null)
      return errorResponse(400, "invalid_request");
    const items = simulatedStore.connectedAccounts(identityId);
    return HttpResponse.json(
      pageByCursor(items, cursor, limit, (item) => item.account_id),
    );
  }),

  http.get(
    "*/api/v1/accounts/:accountId/capabilities",
    ({ request, params }) => {
      const search = new URL(request.url).searchParams;
      if (!hasOnlyQueryKeys(search, ["identity_id"]))
        return errorResponse(400, "invalid_request");
      const identityId = parseSingleQueryValue(
        search,
        "identity_id",
        boundedId,
      );
      if (!identityId) return errorResponse(400, "invalid_request");
      const capabilities = simulatedStore.historyCapabilities(
        String(params.accountId),
      );
      if (
        capabilities.length === 0 ||
        capabilities[0]?.identity_id !== identityId
      ) {
        return errorResponse(404, "not_found");
      }
      return HttpResponse.json(
        capabilities.map((capability) =>
          ProviderCapabilitySchema.parse(capability),
        ),
      );
    },
  ),

  http.get(
    "*/api/v1/accounts/:accountId/history-imports",
    ({ request, params }) => {
      const search = new URL(request.url).searchParams;
      if (!hasOnlyQueryKeys(search, ["identity_id", "cursor", "limit"]))
        return errorResponse(400, "invalid_request");
      const identityId = parseSingleQueryValue(
        search,
        "identity_id",
        boundedId,
      );
      const cursor = parseSingleQueryValue(search, "cursor", boundedCursor);
      const limit = parseSingleQueryValue(search, "limit", boundedLimit);
      if (!identityId || cursor === null || limit === null)
        return errorResponse(400, "invalid_request");
      const details = simulatedStore.historyImportPage(
        String(params.accountId),
        identityId,
      );
      if (details === null) return errorResponse(404, "not_found");
      const page = pageByCursor(
        details,
        cursor,
        limit,
        (detail) => detail.import.import_id,
      );
      return HttpResponse.json({
        items: page.items.map((detail) => detail.import),
        next_cursor: page.next_cursor,
      });
    },
  ),

  http.post(
    "*/api/v1/accounts/:accountId/history-imports",
    async ({ request, params }) => {
      const idempotencyKey = request.headers.get("Idempotency-Key");
      if (!idempotencyKey) return errorResponse(400, "invalid_request");
      const parsed = HistoryImportStartRequestSchema.safeParse(
        await request.json(),
      );
      if (!parsed.success) return errorResponse(400, "invalid_request");
      const detail = simulatedStore.startHistoryImport(
        String(params.accountId),
        parsed.data,
        idempotencyKey,
      );
      return detail
        ? HttpResponse.json(HistoryImportDetailSchema.parse(detail), {
            status: 201,
          })
        : errorResponse(404, "not_found");
    },
  ),

  http.get("*/api/v1/history-imports/:importId", ({ request, params }) => {
    const search = new URL(request.url).searchParams;
    if (!hasOnlyQueryKeys(search, ["identity_id"]))
      return errorResponse(400, "invalid_request");
    const identityId = parseSingleQueryValue(search, "identity_id", boundedId);
    if (!identityId) return errorResponse(400, "invalid_request");
    const detail = simulatedStore.historyImport(
      String(params.importId),
      identityId,
    );
    return detail
      ? HttpResponse.json(HistoryImportDetailSchema.parse(detail))
      : errorResponse(404, "not_found");
  }),

  http.post(
    "*/api/v1/history-imports/:importId/advance",
    async ({ request, params }) => {
      const parsed = HistoryImportAdvanceRequestSchema.safeParse(
        await request.json(),
      );
      if (!parsed.success) return errorResponse(400, "invalid_request");
      const detail = simulatedStore.advanceHistoryImport(
        String(params.importId),
        parsed.data,
      );
      return detail
        ? HttpResponse.json(HistoryImportDetailSchema.parse(detail))
        : errorResponse(404, "not_found");
    },
  ),

  http.get("*/api/v1/grant-targets", ({ request }) => {
    const search = new URL(request.url).searchParams;
    if (!hasOnlyQueryKeys(search, ["cursor", "limit"]))
      return errorResponse(400, "invalid_request");
    const cursor = parseSingleQueryValue(search, "cursor", boundedCursor);
    const limit = parseSingleQueryValue(search, "limit", boundedLimit);
    if (cursor === null || limit === null)
      return errorResponse(400, "invalid_request");
    const items = simulatedStore.grantTargets();
    return HttpResponse.json(
      pageByCursor(
        items,
        cursor,
        limit,
        (item) => `${item.membership_id}|${item.identity_id}`,
      ),
    );
  }),

  http.get("*/api/v1/grants", ({ request }) => {
    const search = new URL(request.url).searchParams;
    if (!hasOnlyQueryKeys(search, ["cursor", "limit"]))
      return errorResponse(400, "invalid_request");
    const cursor = parseSingleQueryValue(search, "cursor", boundedCursor);
    const limit = parseSingleQueryValue(search, "limit", boundedLimit);
    if (cursor === null || limit === null)
      return errorResponse(400, "invalid_request");
    const page = pageByCursor(
      simulatedStore.accountGrants(),
      cursor,
      limit,
      (item) => item.id,
    );
    return HttpResponse.json(AccountGrantPageSchema.parse(page));
  }),

  http.post("*/api/v1/grants", async ({ request }) => {
    const parsed = AccountGrantMutationSchema.safeParse(await request.json());
    if (!parsed.success) return errorResponse(400, "invalid_request");
    const grant = simulatedStore.createAccountGrant(parsed.data);
    return grant
      ? HttpResponse.json(AccountGrantSchema.parse(grant), { status: 201 })
      : errorResponse(404, "not_found");
  }),

  http.patch("*/api/v1/grants/:grantId", async ({ request, params }) => {
    const parsed = AccountGrantUpdateSchema.safeParse(await request.json());
    if (!parsed.success) return errorResponse(400, "invalid_request");
    const grant = simulatedStore.updateAccountGrant(
      String(params.grantId),
      parsed.data,
    );
    return grant ? HttpResponse.json(grant) : errorResponse(404, "not_found");
  }),

  http.delete("*/api/v1/grants/:grantId", ({ params }) => {
    const grant = simulatedStore.revokeAccountGrant(String(params.grantId));
    return grant ? HttpResponse.json(grant) : errorResponse(404, "not_found");
  }),

  http.get("*/api/v1/identities", () =>
    HttpResponse.json(simulatedStore.identities()),
  ),

  http.get("*/api/v1/connections", ({ request }) => {
    const search = new URL(request.url).searchParams;
    if (!hasOnlyQueryKeys(search, ["identity_id"]))
      return errorResponse(400, "invalid_request");
    const identityId = parseSingleQueryValue(search, "identity_id", boundedId);
    if (!identityId) return errorResponse(400, "invalid_request");
    if (!simulatedStore.identities().some((item) => item.id === identityId)) {
      return errorResponse(404, "not_found");
    }
    return HttpResponse.json(simulatedStore.connections(identityId));
  }),

  http.get("*/api/v1/identities/:identityId/channels", ({ params }) => {
    const identityId = String(params.identityId);
    if (!boundedId.safeParse(identityId).success)
      return errorResponse(400, "invalid_request");
    if (!simulatedStore.identities().some((item) => item.id === identityId)) {
      return errorResponse(404, "not_found");
    }
    return HttpResponse.json(simulatedStore.channels(identityId));
  }),

  http.get(
    "*/api/v1/identities/:identityId/conversations",
    ({ request, params }) => {
      const identityId = String(params.identityId);
      if (!boundedId.safeParse(identityId).success)
        return errorResponse(400, "invalid_request");
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
          ? limit === undefined
            ? {}
            : { limit }
          : limit === undefined
            ? { cursor }
            : { limit, cursor },
      );
      return result.ok
        ? HttpResponse.json(result.page)
        : errorResponse(400, "invalid_request");
    },
  ),

  http.get(
    "*/api/v1/accounts/:accountId/conversations",
    ({ request, params }) => {
      const accountId = String(params.accountId);
      const search = new URL(request.url).searchParams;
      if (!hasOnlyQueryKeys(search, ["identity_id", "cursor", "limit"]))
        return errorResponse(400, "invalid_request");
      const identityId = parseSingleQueryValue(
        search,
        "identity_id",
        boundedId,
      );
      const cursor = parseSingleQueryValue(search, "cursor", boundedCursor);
      const limit = parseSingleQueryValue(search, "limit", boundedLimit);
      if (!identityId || cursor === null || limit === null)
        return errorResponse(400, "invalid_request");
      const page = simulatedStore.accountConversations(accountId, identityId, {
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
      });
      return page ? HttpResponse.json(page) : errorResponse(404, "not_found");
    },
  ),

  http.get(
    "*/api/v1/identities/:identityId/conversations/:conversationId",
    ({ params }) => {
      if (
        !boundedId.safeParse(String(params.identityId)).success ||
        !boundedId.safeParse(String(params.conversationId)).success
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
    },
  ),

  http.get(
    "*/api/v1/conversations/:conversationId/messages",
    ({ request, params }) => {
      if (!boundedId.safeParse(String(params.conversationId)).success) {
        return errorResponse(400, "invalid_request");
      }
      const search = new URL(request.url).searchParams;
      if (
        !hasOnlyQueryKeys(search, [
          "identity_id",
          "message_id",
          "cursor",
          "limit",
        ])
      ) {
        return errorResponse(400, "invalid_request");
      }
      const identityId = parseSingleQueryValue(
        search,
        "identity_id",
        boundedId,
      );
      const messageId = parseSingleQueryValue(search, "message_id", boundedId);
      const cursor = parseSingleQueryValue(search, "cursor", boundedCursor);
      const limit = parseSingleQueryValue(search, "limit", boundedLimit);
      if (
        !identityId ||
        messageId === null ||
        cursor === null ||
        limit === null
      ) {
        return errorResponse(400, "invalid_request");
      }
      const messageMode = simulatedStore.selectedMessageMode();
      if (messageMode === "error") {
        return errorResponse(503, "service_unavailable");
      }
      const conversationId = String(params.conversationId);
      if (!simulatedStore.conversation(identityId, conversationId)) {
        return errorResponse(404, "not_found");
      }
      const page = simulatedStore.messages(conversationId, identityId, {
        ...(limit === undefined
          ? messageMode === "pages"
            ? { limit: 2 }
            : {}
          : { limit: messageMode === "pages" ? Math.min(limit, 2) : limit }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(messageId === undefined ? {} : { messageId }),
      });
      return page
        ? HttpResponse.json(MessagePageResultSchema.parse(page))
        : errorResponse(400, "invalid_request");
    },
  ),

  http.get("*/api/v1/commands", ({ request }) => {
    const identityId = new URL(request.url).searchParams.get("identity_id");
    return HttpResponse.json(
      simulatedStore.commands(identityId === null ? undefined : identityId),
    );
  }),

  http.post(
    "*/api/v1/commands/:commandId/:decision",
    async ({ request, params }) => {
      const decision = String(params.decision);
      if (decision !== "confirm" && decision !== "cancel") {
        return errorResponse(400, "invalid_request");
      }
      const parsed = commandDecisionSchema.safeParse(await request.json());
      if (!parsed.success) return errorResponse(400, "invalid_request");
      const command = simulatedStore.decideCommand(
        String(params.commandId),
        decision,
      );
      if (!command) return errorResponse(404, "not_found");
      return HttpResponse.json({
        command,
        dispatch: {
          id: `dispatch_${command.id}`,
          tenant_id: command.tenant_id,
          command_id: command.id,
          message_id: command.message_id ?? `message_${command.id}`,
          event_id: command.event_id ?? `event_${command.id}`,
          actor_principal_id: command.actor_principal_id ?? "principal_pilot",
          actor_identity_id: command.actor_identity_id ?? command.identity_id,
          resource_identity_id: command.identity_id,
          account_id: command.account_id ?? "account_simulated",
          connection_id: command.connection_id ?? "connection_simulated",
          conversation_id: command.conversation_id,
          idempotency_key: parsed.data.idempotency_key,
          status: decision === "cancel" ? "cancelled" : "pending",
          created_at: command.created_at,
          updated_at: command.updated_at,
          confirmation_decision: decision,
          confirmation_actor_principal_id:
            command.confirmation_actor_principal_id,
          confirmation_actor_identity_id:
            command.confirmation_actor_identity_id,
          confirmation_decided_at: command.confirmation_decided_at,
        },
        replayed: false,
      });
    },
  ),

  http.post(
    "*/api/v1/conversations/:conversationId/messages",
    async ({ request, params }) => {
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
    },
  ),

  http.post("*/api/v1/testing/realtime/message", async ({ request }) => {
    const parsed = simulatedMessageEventSchema.safeParse(await request.json());
    if (!parsed.success) return errorResponse(400, "invalid_request");
    const conversation = simulatedStore.conversation(
      parsed.data.identity_id,
      parsed.data.conversation_id,
    );
    if (
      !conversation ||
      conversation.tenant_id !== parsed.data.tenant_id ||
      conversation.connection_id !== parsed.data.connection_id
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
      const parsed = z
        .object({
          scenario: z.enum(["ready", "attention_required"]).optional(),
          message_mode: z.enum(["normal", "pages", "error"]).optional(),
        })
        .safeParse(await request.json());
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
