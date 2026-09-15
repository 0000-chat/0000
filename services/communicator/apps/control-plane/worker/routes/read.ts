import { createRoute, z } from "@hono/zod-openapi";
import {
  ApiErrorResponseSchema,
  ChannelSummarySchema,
  CommunicatorIdSchema,
  ConnectionSchema,
  ConversationPageResultSchema,
  ConversationSummarySchema,
  IdentitySchema,
  MAX_IDENTITY_CONNECTIONS,
  MAX_PROJECTION_CURSOR_CHARS,
  MAX_PROJECTION_PAGE_SIZE,
  MessagePageResultSchema,
  MessageSearchDirectionSchema,
  MessageSearchPageResultSchema,
} from "@communicator/contracts";
import type { Context, Handler, Input } from "hono";
import type { AuthorizationVariables } from "../auth/middleware";
import type { IngestionAuthorizationVariables } from "../auth/ingestion-middleware";
import {
  getConversation,
  listChannels,
  listConnections,
  listConversations,
  listIdentities,
  listMessages,
  searchMessages,
  type ListConnectionsInput,
  type ListConversationsInput,
  type ListMessagesInput,
  type SearchMessagesInput,
  type ReadHandlerContext,
} from "../read/handlers";
import { readErrorResponse } from "../read/errors";

const errorContent = {
  "application/json": { schema: ApiErrorResponseSchema },
};

const readResponses = (schema: z.ZodTypeAny, description: string) => ({
  200: {
    description,
    content: { "application/json": { schema } },
  },
  400: { description: "Invalid request", content: errorContent },
  401: { description: "Authentication required", content: errorContent },
  403: { description: "Forbidden", content: errorContent },
  404: { description: "Resource not found", content: errorContent },
  503: { description: "Service unavailable", content: errorContent },
});

const rejectRepeatedQueryValues = (value: unknown): unknown =>
  Array.isArray(value) ? { invalid_query_value: true } : value;

const singleString = (schema: z.ZodTypeAny) =>
  z.preprocess(rejectRepeatedQueryValues, schema);

const boundedId = CommunicatorIdSchema.max(128);
const queryId = () => singleString(boundedId);
const optionalQueryId = () => singleString(boundedId.optional());
const optionalCursor = () =>
  singleString(z.string().min(1).max(MAX_PROJECTION_CURSOR_CHARS).optional());
const optionalLimit = () =>
  singleString(
    z.coerce.number().int().min(1).max(MAX_PROJECTION_PAGE_SIZE).optional(),
  );

const connectionQuery = z.object({ identity_id: queryId() }).strict();
const conversationQuery = z
  .object({
    account_id: optionalQueryId(),
    channel_id: optionalQueryId(),
    cursor: optionalCursor(),
    limit: optionalLimit(),
  })
  .strict();
const messageQuery = z
  .object({
    identity_id: queryId(),
    message_id: optionalQueryId(),
    account_id: optionalQueryId(),
    cursor: optionalCursor(),
    limit: optionalLimit(),
  })
  .strict();
const messageSearchQuery = z
  .object({
    identity_id: queryId(),
    account_id: optionalQueryId(),
    conversation_id: optionalQueryId(),
    text: singleString(z.string().trim().min(1).max(200).optional()),
    contact: singleString(z.string().trim().min(1).max(100).optional()),
    from: singleString(z.string().max(64).optional()),
    to: singleString(z.string().max(64).optional()),
    direction: singleString(MessageSearchDirectionSchema.optional()),
    cursor: optionalCursor(),
    limit: optionalLimit(),
  })
  .strict();

export const identitiesRoute = createRoute({
  method: "get",
  path: "/api/v1/identities",
  security: [{ bearerAuth: [] }],
  responses: readResponses(
    IdentitySchema.array().max(MAX_IDENTITY_CONNECTIONS),
    "Authorized identities for the selected tenant",
  ),
});

export const connectionsRoute = createRoute({
  method: "get",
  path: "/api/v1/connections",
  security: [{ bearerAuth: [] }],
  request: { query: connectionQuery },
  responses: readResponses(
    ConnectionSchema.array().max(MAX_IDENTITY_CONNECTIONS),
    "Connections for one authorized identity",
  ),
});

export const channelsRoute = createRoute({
  method: "get",
  path: "/api/v1/identities/{identity_id}/channels",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ identity_id: boundedId }).strict() },
  responses: readResponses(
    ChannelSummarySchema.array().max(MAX_IDENTITY_CONNECTIONS),
    "Channels for one authorized identity",
  ),
});

export const conversationsRoute = createRoute({
  method: "get",
  path: "/api/v1/identities/{identity_id}/conversations",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ identity_id: boundedId }).strict(),
    query: conversationQuery,
  },
  responses: readResponses(
    ConversationPageResultSchema,
    "Seek-paginated conversations",
  ),
});

export const conversationRoute = createRoute({
  method: "get",
  path: "/api/v1/identities/{identity_id}/conversations/{conversation_id}",
  security: [{ bearerAuth: [] }],
  request: {
    params: z
      .object({
        identity_id: boundedId,
        conversation_id: boundedId,
      })
      .strict(),
    query: z.object({ account_id: optionalQueryId() }).strict(),
  },
  responses: readResponses(
    ConversationSummarySchema,
    "One authorized conversation",
  ),
});

export const accountConversationsRoute = createRoute({
  method: "get",
  path: "/api/v1/accounts/{account_id}/conversations",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ account_id: boundedId }).strict(),
    query: z
      .object({
        identity_id: queryId(),
        cursor: optionalCursor(),
        limit: optionalLimit(),
      })
      .strict(),
  },
  responses: readResponses(
    ConversationPageResultSchema,
    "Seek-paginated conversations for one authorized account",
  ),
});

export const messagesRoute = createRoute({
  method: "get",
  path: "/api/v1/conversations/{conversation_id}/messages",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ conversation_id: boundedId }).strict(),
    query: messageQuery,
  },
  responses: readResponses(MessagePageResultSchema, "Seek-paginated messages"),
});

export const searchMessagesRoute = createRoute({
  method: "get",
  path: "/api/v1/search/messages",
  security: [{ bearerAuth: [] }],
  request: { query: messageSearchQuery },
  responses: readResponses(
    MessageSearchPageResultSchema,
    "Seek-paginated stored message search results",
  ),
});

type ReadRouteEnv = {
  Bindings: Cloudflare.Env;
  Variables: AuthorizationVariables & IngestionAuthorizationVariables;
};

const readContext = <I extends Input>(
  context: Context<ReadRouteEnv, string, I>,
): ReadHandlerContext => ({
  env: context.env,
  authorization: context.get("authorization"),
  delegated: context.get("delegated"),
});

const failureResponse = (context: Context<ReadRouteEnv>, error: unknown) => {
  const result = readErrorResponse(error);
  return context.json(result.body, result.status);
};

export const identitiesHandler: Handler<
  ReadRouteEnv,
  string,
  { out: {} }
> = async (context) => {
  try {
    return context.json(await listIdentities(readContext(context)), 200);
  } catch (error) {
    return failureResponse(context, error);
  }
};

export const connectionsHandler: Handler<
  ReadRouteEnv,
  string,
  { out: { query: ListConnectionsInput } }
> = async (context) => {
  try {
    return context.json(
      await listConnections(readContext(context), context.req.valid("query")),
      200,
    );
  } catch (error) {
    return failureResponse(context, error);
  }
};

export const channelsHandler: Handler<
  ReadRouteEnv,
  string,
  { out: { param: { identity_id: string } } }
> = async (context) => {
  try {
    return context.json(
      await listChannels(readContext(context), context.req.valid("param")),
      200,
    );
  } catch (error) {
    return failureResponse(context, error);
  }
};

export const conversationsHandler: Handler<
  ReadRouteEnv,
  string,
  { out: { param: { identity_id: string }; query: ListConversationsInput } }
> = async (context) => {
  try {
    return context.json(
      await listConversations(readContext(context), {
        ...context.req.valid("param"),
        ...context.req.valid("query"),
      }),
      200,
    );
  } catch (error) {
    return failureResponse(context, error);
  }
};

export const conversationHandler: Handler<
  ReadRouteEnv,
  string,
  {
    out: {
      param: { identity_id: string; conversation_id: string };
      query: { account_id?: string };
    };
  }
> = async (context) => {
  try {
    return context.json(
      await getConversation(readContext(context), {
        ...context.req.valid("param"),
        ...context.req.valid("query"),
      }),
      200,
    );
  } catch (error) {
    return failureResponse(context, error);
  }
};

export const messagesHandler: Handler<
  ReadRouteEnv,
  string,
  { out: { param: { conversation_id: string }; query: ListMessagesInput } }
> = async (context) => {
  try {
    return context.json(
      await listMessages(readContext(context), {
        ...context.req.valid("param"),
        ...context.req.valid("query"),
      }),
      200,
    );
  } catch (error) {
    return failureResponse(context, error);
  }
};

export const searchMessagesHandler: Handler<
  ReadRouteEnv,
  string,
  { out: { query: SearchMessagesInput } }
> = async (context) => {
  try {
    return context.json(
      await searchMessages(readContext(context), context.req.valid("query")),
      200,
    );
  } catch (error) {
    return failureResponse(context, error);
  }
};

export const accountConversationsHandler: Handler<
  ReadRouteEnv,
  string,
  { out: { param: { account_id: string }; query: ListConversationsInput } }
> = async (context) => {
  try {
    return context.json(
      await listConversations(readContext(context), {
        ...context.req.valid("param"),
        ...context.req.valid("query"),
      }),
      200,
    );
  } catch (error) {
    return failureResponse(context, error);
  }
};
