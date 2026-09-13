import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CommunicatorIdSchema,
  DeliveryModeSchema,
  MessageSearchDirectionSchema,
  WebhookEventFilterSchema,
  WebhookSubscriptionCreateSchema,
  WebhookSubscriptionCutoverSchema,
  WebhookSubscriptionUpdateSchema,
  WebhookSubscriptionRevokeSchema,
  ContactSearchRequestSchema,
  ContactResolveRequestSchema,
  CreateDirectChatRequestSchema,
  type TextReplyRequest,
} from "@communicator/contracts";
import type { Context } from "hono";
import { z } from "zod/v4";
import type { AuthorizationVariables } from "./auth/middleware";
import type { IngestionAuthorizationVariables } from "./auth/ingestion-middleware";
import {
  isAdministratorSession,
  toGrantedProjectionReadAuthorization,
} from "./read/authorization";
import {
  getConversation,
  listChannels,
  listConnections,
  listConversations,
  listIdentities,
  listMessages,
  searchMessages,
  type GetConversationInput,
  type ListConversationsInput,
  type ListMessagesInput,
  type SearchMessagesInput,
  type ReadHandlerContext,
} from "./read/handlers";
import { ReadError, readErrorResponse } from "./read/errors";
import { listConnectedAccounts } from "./control-directory/grants";
import {
  authorizeWebhookInspection,
  createWebhookSubscription,
  cutoverWebhookSubscription,
  evaluateWebhookSubscription,
  listWebhookSubscriptionPage,
  revokeWebhookSubscription,
  updateWebhookSubscription,
  WebhookRepositoryError,
  type WebhookActor,
} from "./control-directory/webhooks";
import {
  acceptTextReply,
  decideOutboundCommand,
  reconcileOutboundCommand,
  type OutboundAcceptanceServices,
} from "./outbound/acceptance";
import { ContactRepositoryError } from "./contacts/repository";
import {
  createDirectChat,
  resolveContact,
  searchContacts,
  type ContactRouteServices,
  type ContactServiceContext,
} from "./contacts/service";

type McpContext = Context<{
  Bindings: Cloudflare.Env;
  Variables: AuthorizationVariables & IngestionAuthorizationVariables;
}>;

const boundedId = CommunicatorIdSchema.max(128);
const optionalId = boundedId.optional();
const optionalCursor = z.string().min(1).max(2_048).optional();
const optionalLimit = z.number().int().min(1).max(100).optional();

const listConnectionsInput = { identity_id: boundedId };
const listChannelsInput = { identity_id: boundedId };
const listAccountsInput = {
  identity_id: optionalId,
  cursor: optionalCursor,
  limit: optionalLimit,
};
const listConversationsInput = {
  identity_id: boundedId,
  account_id: optionalId,
  channel_id: optionalId,
  cursor: optionalCursor,
  limit: optionalLimit,
};
const getConversationInput = {
  identity_id: boundedId,
  conversation_id: boundedId,
  account_id: optionalId,
};
const listMessagesInput = {
  identity_id: boundedId,
  conversation_id: boundedId,
  account_id: optionalId,
  cursor: optionalCursor,
  limit: optionalLimit,
};
const searchMessagesInput = {
  identity_id: boundedId,
  account_id: optionalId,
  conversation_id: optionalId,
  text: z.string().trim().min(1).max(200).optional(),
  contact: z.string().trim().min(1).max(100).optional(),
  from: z.string().max(64).optional(),
  to: z.string().max(64).optional(),
  direction: MessageSearchDirectionSchema.optional(),
  cursor: optionalCursor,
  limit: optionalLimit,
};

const webhookDestinationInput = z
  .object({
    url: z.string(),
    credential_ref: z.string().nullable().optional(),
  })
  .strict();
const webhookEventFilterInput = WebhookEventFilterSchema;
const webhookCreateInput = {
  owner_installation_id: optionalId,
  logical_agent_id: boundedId.nullable().optional(),
  destination: webhookDestinationInput,
  event_filter: webhookEventFilterInput.optional(),
  global_enabled: z.boolean().optional(),
  account_rules: z
    .array(z.object({ account_id: boundedId, enabled: z.boolean() }).strict())
    .optional(),
  chat_rules: z
    .array(
      z
        .object({
          account_id: boundedId,
          chat_id: boundedId,
          enabled: z.boolean(),
        })
        .strict(),
    )
    .optional(),
  idempotency_key: z.string().trim().min(1).max(200),
};
const webhookUpdateInput = {
  owner_installation_id: boundedId.nullable().optional(),
  logical_agent_id: boundedId.nullable().optional(),
  event_filter: webhookEventFilterInput.optional(),
  global_enabled: z.boolean().optional(),
  account_rules: webhookCreateInput.account_rules,
  chat_rules: webhookCreateInput.chat_rules,
  idempotency_key: z.string().trim().min(1).max(200),
};
const webhookCutoverInput = {
  destination: webhookDestinationInput,
  idempotency_key: z.string().trim().min(1).max(200),
};
const webhookRevokeInput = {
  idempotency_key: z.string().trim().min(1).max(200),
};
const webhookEvaluateInput = {
  subscription_id: boundedId,
  account_id: boundedId,
  chat_id: boundedId.nullable().optional(),
};
const sendTextReplyInput = {
  identity_id: boundedId,
  conversation_id: boundedId,
  account_id: optionalId,
  body: z.string().trim().min(1).max(20_000),
  delivery_mode: DeliveryModeSchema,
  idempotency_key: z.string().trim().min(1).max(200),
  attachments: z.array(z.unknown()).max(0).optional(),
};
const outboundCommandInput = { command_id: boundedId };
const cancelTextReplyInput = {
  command_id: boundedId,
  idempotency_key: z.string().trim().min(1).max(200),
};
const contactSearchInput = {
  identity_id: CommunicatorIdSchema.max(128),
  account_id: CommunicatorIdSchema.max(128),
  query: z.string().trim().min(1).max(200),
};
const contactResolveInput = {
  identity_id: CommunicatorIdSchema.max(128),
  account_id: CommunicatorIdSchema.max(128),
  phone: z.string().trim().min(1).max(32),
};
const createDirectChatInput = {
  identity_id: CommunicatorIdSchema.max(128),
  account_id: CommunicatorIdSchema.max(128),
  contact_id: CommunicatorIdSchema.max(128),
  candidate_revision: z.string().regex(/^[0-9a-f]{64}$/u),
  idempotency_key: z.string().trim().min(1).max(200),
};

const contextForRead = (context: McpContext): ReadHandlerContext => ({
  env: context.env,
  authorization: context.get("authorization"),
  delegated: context.get("delegated"),
});

const contextForContacts = (
  context: ReadHandlerContext,
): ContactServiceContext => ({
  env: context.env,
  authorization: context.authorization,
  ...(context.delegated === undefined ? {} : { delegated: context.delegated }),
});

const webhookActorFor = (context: ReadHandlerContext): WebhookActor => ({
  tenantId: context.authorization.tenant.id,
  principalId: context.authorization.principal.id,
  principalType: context.authorization.principal.type,
  membershipId: context.authorization.membership.id,
  role: context.authorization.membership.role,
  identityIds: context.authorization.identities.map(
    (identity) => identity.identity_id,
  ),
  delegated: context.delegated === true,
});

const webhookDatabase = (context: ReadHandlerContext): D1Database => {
  if (
    context.env.CONTROL_DB === undefined ||
    typeof context.env.CONTROL_DB.withSession !== "function"
  ) {
    throw new WebhookRepositoryError("webhook_unavailable");
  }
  return context.env.CONTROL_DB;
};

const requireDelegatedGrant = async (
  context: ReadHandlerContext,
  identityId: string,
): Promise<void> => {
  if (!context.delegated) return;
  // Every delegated identity starts with identity grants only. Account reads
  // become available only after an explicit conversation.read account grant.
  await toGrantedProjectionReadAuthorization(
    context.env,
    context.authorization,
    identityId,
    true,
  );
};

const errorResult = (error: unknown) => {
  if (error instanceof WebhookRepositoryError) {
    const code =
      error.code === "webhook_invalid"
        ? "invalid_request"
        : error.code === "webhook_forbidden"
          ? "forbidden"
          : error.code === "webhook_not_found"
            ? "not_found"
            : error.code === "webhook_conflict"
              ? "invalid_request"
              : "service_unavailable";
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: { code, message: error.message } }),
        },
      ],
    };
  }
  if (error instanceof ContactRepositoryError) {
    const code =
      error.code === "contact_invalid" || error.code === "contact_conflict"
        ? "invalid_request"
        : error.code === "contact_not_found"
          ? "not_found"
          : "service_unavailable";
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: { code, message: error.message } }),
        },
      ],
    };
  }
  const mapped = readErrorResponse(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(mapped.body) }],
  };
};

const toolResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  // MCP structuredContent is an object. Preserve the API payload in the text
  // block and use an items envelope for the three list endpoints that return
  // arrays.
  structuredContent: (Array.isArray(value)
    ? { items: value }
    : value) as Record<string, unknown>,
});

const withReadErrors = async (operation: () => Promise<unknown>) => {
  try {
    return toolResult(await operation());
  } catch (error) {
    return errorResult(error);
  }
};

const listAccounts = async (
  context: ReadHandlerContext,
  input: {
    identity_id: string | undefined;
    cursor: string | undefined;
    limit: number | undefined;
  },
) => {
  const targetIdentityId =
    input.identity_id ?? context.authorization.identities[0]?.identity_id;
  if (targetIdentityId === undefined) {
    return { items: [], next_cursor: null };
  }
  await requireDelegatedGrant(context, targetIdentityId);

  const administrator = isAdministratorSession(context.authorization);
  if (!administrator && input.identity_id !== undefined) {
    const ownsIdentity = context.authorization.identities.some(
      (identity) => identity.identity_id === input.identity_id,
    );
    if (!ownsIdentity) throw new ReadError("forbidden");
  }

  const database = context.env.CONTROL_DB;
  if (database === undefined || typeof database.withSession !== "function") {
    throw new ReadError("service_unavailable");
  }
  try {
    return await listConnectedAccounts(database.withSession("first-primary"), {
      tenantId: context.authorization.tenant.id,
      ...(administrator && input.identity_id !== undefined
        ? { identityId: input.identity_id }
        : {}),
      ...(!administrator
        ? {
            grantMembershipId: context.authorization.membership.id,
            grantIdentityId: targetIdentityId,
          }
        : {}),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
  } catch (error) {
    throw new ReadError("service_unavailable", error);
  }
};

const registerTools = (
  server: McpServer,
  context: ReadHandlerContext,
  outboundServices: OutboundAcceptanceServices,
  contactServices: ContactRouteServices,
): void => {
  server.registerTool(
    "list_identities",
    {
      description: "List identities authorized for this tenant",
    },
    () => withReadErrors(() => listIdentities(context)),
  );

  server.registerTool(
    "list_accounts",
    {
      description: "List paginated connected accounts granted to an identity",
      inputSchema: listAccountsInput,
    },
    (input) =>
      withReadErrors(() =>
        listAccounts(context, {
          identity_id: input.identity_id,
          cursor: input.cursor,
          limit: input.limit,
        }),
      ),
  );

  server.registerTool(
    "list_connections",
    {
      description: "List connection summaries owned by an identity",
      inputSchema: listConnectionsInput,
    },
    (input) =>
      withReadErrors(async () => {
        await requireDelegatedGrant(context, input.identity_id);
        return listConnections(context, input);
      }),
  );

  server.registerTool(
    "list_channels",
    {
      description: "List channel summaries owned by an identity",
      inputSchema: listChannelsInput,
    },
    (input) =>
      withReadErrors(async () => {
        await requireDelegatedGrant(context, input.identity_id);
        return listChannels(context, input);
      }),
  );

  server.registerTool(
    "list_conversations",
    {
      description: "List stored conversations for an identity or account",
      inputSchema: listConversationsInput,
    },
    (input) =>
      withReadErrors(async () => {
        await requireDelegatedGrant(context, input.identity_id);
        const value: ListConversationsInput = {
          identity_id: input.identity_id,
          ...(input.account_id === undefined
            ? {}
            : { account_id: input.account_id }),
          ...(input.channel_id === undefined
            ? {}
            : { channel_id: input.channel_id }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        };
        return listConversations(context, value);
      }),
  );

  server.registerTool(
    "get_conversation",
    {
      description: "Read one stored conversation",
      inputSchema: getConversationInput,
    },
    (input) =>
      withReadErrors(async () => {
        await requireDelegatedGrant(context, input.identity_id);
        const value: GetConversationInput = {
          identity_id: input.identity_id,
          conversation_id: input.conversation_id,
          ...(input.account_id === undefined
            ? {}
            : { account_id: input.account_id }),
        };
        return getConversation(context, value);
      }),
  );

  server.registerTool(
    "list_messages",
    {
      description: "Read paginated stored messages",
      inputSchema: listMessagesInput,
    },
    (input) =>
      withReadErrors(async () => {
        await requireDelegatedGrant(context, input.identity_id);
        const value: ListMessagesInput = {
          identity_id: input.identity_id,
          conversation_id: input.conversation_id,
          ...(input.account_id === undefined
            ? {}
            : { account_id: input.account_id }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        };
        return listMessages(context, value);
      }),
  );

  server.registerTool(
    "search_messages",
    {
      description: "Search stored messages within granted accounts and chats",
      inputSchema: searchMessagesInput,
    },
    (input) =>
      withReadErrors(async () => {
        await requireDelegatedGrant(context, input.identity_id);
        const value: SearchMessagesInput = {
          identity_id: input.identity_id,
          ...(input.account_id === undefined
            ? {}
            : { account_id: input.account_id }),
          ...(input.conversation_id === undefined
            ? {}
            : { conversation_id: input.conversation_id }),
          ...(input.text === undefined ? {} : { text: input.text }),
          ...(input.contact === undefined ? {} : { contact: input.contact }),
          ...(input.from === undefined ? {} : { from: input.from }),
          ...(input.to === undefined ? {} : { to: input.to }),
          ...(input.direction === undefined
            ? {}
            : { direction: input.direction }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        };
        return searchMessages(context, value);
      }),
  );

  server.registerTool(
    "search_contacts",
    {
      description: "Search account contacts without selecting a recipient",
      inputSchema: contactSearchInput,
    },
    (input) =>
      withReadErrors(() =>
        searchContacts(
          contextForContacts(context),
          ContactSearchRequestSchema.parse(input),
          contactServices,
        ),
      ),
  );

  server.registerTool(
    "resolve_contact",
    {
      description: "Resolve a phone number through one selected account",
      inputSchema: contactResolveInput,
    },
    (input) =>
      withReadErrors(() =>
        resolveContact(
          contextForContacts(context),
          ContactResolveRequestSchema.parse(input),
          contactServices,
        ),
      ),
  );

  server.registerTool(
    "create_direct_chat",
    {
      description: "Create one direct chat from an explicit account contact",
      inputSchema: createDirectChatInput,
    },
    (input) =>
      withReadErrors(() =>
        createDirectChat(
          contextForContacts(context),
          CreateDirectChatRequestSchema.parse(input),
          contactServices,
        ),
      ),
  );

  server.registerTool(
    "list_webhook_subscriptions",
    {
      description: "List webhook subscriptions visible to this identity",
      inputSchema: {
        cursor: optionalCursor,
        limit: optionalLimit,
      },
    },
    (input) =>
      withReadErrors(() =>
        listWebhookSubscriptionPage(
          webhookDatabase(context).withSession("first-primary"),
          webhookActorFor(context),
          input.cursor,
          input.limit,
        ),
      ),
  );

  server.registerTool(
    "get_webhook_subscription",
    {
      description: "Inspect one webhook subscription",
      inputSchema: { subscription_id: boundedId },
    },
    (input) =>
      withReadErrors(() =>
        authorizeWebhookInspection(
          webhookDatabase(context).withSession("first-primary"),
          webhookActorFor(context),
          input.subscription_id,
        ),
      ),
  );

  server.registerTool(
    "create_webhook_subscription",
    {
      description: "Create an independently managed webhook subscription",
      inputSchema: webhookCreateInput,
    },
    (input) =>
      withReadErrors(() =>
        createWebhookSubscription(
          webhookDatabase(context),
          webhookActorFor(context),
          WebhookSubscriptionCreateSchema.parse(input),
          new Date().toISOString(),
        ),
      ),
  );

  server.registerTool(
    "update_webhook_subscription",
    {
      description: "Update webhook filters, rules, or ownership",
      inputSchema: { subscription_id: boundedId, ...webhookUpdateInput },
    },
    (input) =>
      withReadErrors(() => {
        const { subscription_id, ...body } = input;
        return updateWebhookSubscription(
          webhookDatabase(context),
          webhookActorFor(context),
          subscription_id,
          WebhookSubscriptionUpdateSchema.parse(body),
          new Date().toISOString(),
        );
      }),
  );

  server.registerTool(
    "cutover_webhook_subscription",
    {
      description: "Change a subscription destination and version",
      inputSchema: { subscription_id: boundedId, ...webhookCutoverInput },
    },
    (input) =>
      withReadErrors(() => {
        const { subscription_id, ...body } = input;
        const parsed = WebhookSubscriptionCutoverSchema.parse(body);
        return cutoverWebhookSubscription(
          webhookDatabase(context),
          webhookActorFor(context),
          subscription_id,
          parsed.destination,
          parsed.idempotency_key,
          new Date().toISOString(),
        );
      }),
  );

  server.registerTool(
    "revoke_webhook_subscription",
    {
      description: "Revoke a webhook subscription and cancel its pending work",
      inputSchema: { subscription_id: boundedId, ...webhookRevokeInput },
    },
    (input) =>
      withReadErrors(() => {
        const { subscription_id, ...body } = input;
        const parsed = WebhookSubscriptionRevokeSchema.parse(body);
        return revokeWebhookSubscription(
          webhookDatabase(context),
          webhookActorFor(context),
          subscription_id,
          parsed.idempotency_key,
          new Date().toISOString(),
        );
      }),
  );

  server.registerTool(
    "evaluate_webhook_subscription",
    {
      description: "Evaluate chat, account, and global webhook precedence",
      inputSchema: webhookEvaluateInput,
    },
    (input) =>
      withReadErrors(async () => {
        const database = webhookDatabase(context);
        const subscription = await authorizeWebhookInspection(
          database.withSession("first-primary"),
          webhookActorFor(context),
          input.subscription_id,
        );
        return evaluateWebhookSubscription(
          database.withSession("first-primary"),
          subscription.tenant_id,
          subscription.id,
          input.account_id,
          input.chat_id ?? null,
        );
      }),
  );

  server.registerTool(
    "get_text_reply_status",
    {
      description:
        "Inspect the durable state of a saved text reply and reconcile connection waiting",
      inputSchema: outboundCommandInput,
    },
    (input) =>
      withReadErrors(() =>
        reconcileOutboundCommand(
          {
            env: context.env,
            authorization: context.authorization,
          },
          input.command_id,
          outboundServices,
        ),
      ),
  );

  server.registerTool(
    "cancel_text_reply",
    {
      description:
        "Cancel a saved text reply before adapter dispatch when the account grant allows it",
      inputSchema: cancelTextReplyInput,
    },
    (input) =>
      withReadErrors(() =>
        decideOutboundCommand(
          {
            env: context.env,
            authorization: context.authorization,
          },
          input.command_id,
          "cancel",
          input.idempotency_key,
          outboundServices,
        ),
      ),
  );

  server.registerTool(
    "send_text_reply",
    {
      description:
        "Save one account-scoped text reply before controlled adapter dispatch",
      inputSchema: sendTextReplyInput,
    },
    (input) =>
      withReadErrors(async () => {
        const request: TextReplyRequest = {
          identity_id: input.identity_id,
          conversation_id: input.conversation_id,
          ...(input.account_id === undefined
            ? {}
            : { account_id: input.account_id }),
          body: input.body,
          delivery_mode: input.delivery_mode,
        };
        return acceptTextReply(
          {
            env: context.env,
            authorization: context.authorization,
          },
          request,
          input.idempotency_key,
          outboundServices,
        );
      }),
  );
};

const validMcpRequestHeaders = (request: Request): boolean => {
  const origin = request.headers.get("Origin");
  if (origin === null) return true;
  try {
    return origin === new URL(request.url).origin;
  } catch {
    return false;
  }
};

/**
 * Handle one stateless MCP request using the official SDK transport. A new
 * server/transport is intentionally created per request because the Worker
 * instance is not a durable session store; the SDK still validates the full
 * initialize/tools/call protocol and request headers.
 */
export async function handleMcpRequest(
  context: McpContext,
  outboundServices: OutboundAcceptanceServices = {},
  contactServices: ContactRouteServices = {},
): Promise<Response> {
  if (!validMcpRequestHeaders(context.req.raw)) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid Origin header" },
        id: null,
      }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }

  const server = new McpServer({ name: "communicator", version: "1.0.0" });
  registerTools(
    server,
    contextForRead(context),
    outboundServices,
    contactServices,
  );
  const requestUrl = new URL(context.req.url);
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    allowedOrigins: [requestUrl.origin],
    enableDnsRebindingProtection: true,
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(context.req.raw);
    await transport.close();
    await server.close();
    return response;
  } catch {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

export function handleMcpGet(context: McpContext): Response {
  if (!validMcpRequestHeaders(context.req.raw)) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid Origin header" },
        id: null,
      }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }
  return context.body(null, 405, {
    Allow: "POST",
    "Cache-Control": "no-store",
  });
}
