import {
  AttachmentMetadataSchema,
  ChannelSummarySchema,
  ConnectionSchema,
  ConversationPageResultSchema,
  ConversationSummarySchema,
  IdentitySchema,
  MAX_IDENTITY_CONNECTIONS,
  MessagePageResultSchema,
  MessageSearchPageResultSchema,
  MessageSearchRequestSchema,
  type ChannelSummary,
  type Connection,
  type ConversationPageResult,
  type ConversationSummary,
  type Identity,
  type MessagePageResult,
  type MessageSearchPageResult,
  type MessageSearchRequest,
  type ProjectionAuthorizationContext,
  type SessionResponse,
} from "@communicator/contracts";
import type { DirectoryConnection } from "../control-directory/read-repository";
import { listConnectionsForIdentity } from "../control-directory/read-repository";
import type { TenantProjectionDO } from "../projection/tenant-projection";
import { historyCoverage } from "../history/repository";
import {
  requireAuthorizedIdentity,
  toGrantedAccountReadAuthorization,
  toGrantedProjectionReadAuthorization,
} from "./authorization";
import { mapReadError, ReadError } from "./errors";
import {
  metadataFor,
  type AttachmentServiceContext,
} from "../attachments/service";
import { attachmentProviderFromEnv } from "../attachments/provider";
import type { ProjectionAttachment } from "@communicator/contracts";
import {
  readAuthorizedMessageRemoval,
  readAuthorizedResourceRemoval,
} from "../removals/service";
import type { RemovalAuthority } from "../../../../packages/contracts/src/removals";

export type ReadHandlerContext = {
  env: Cloudflare.Env;
  authorization: SessionResponse;
  delegated?: boolean;
};

export type ListConnectionsInput = {
  identity_id: string;
};

export type ListChannelsInput = {
  identity_id: string;
};

export type ListConversationsInput = {
  identity_id: string;
  account_id?: string;
  channel_id?: string;
  cursor?: string;
  limit?: number;
};

export type GetConversationInput = {
  identity_id: string;
  conversation_id: string;
  account_id?: string;
};

export type ListMessagesInput = {
  identity_id: string;
  conversation_id: string;
  message_id?: string;
  account_id?: string;
  cursor?: string;
  limit?: number;
};

export type SearchMessagesInput = MessageSearchRequest;

type ProjectionReadStub = Pick<
  DurableObjectStub<TenantProjectionDO>,
  | "listChannelStats"
  | "listConversations"
  | "getConversation"
  | "listMessages"
  | "listAttachments"
  | "searchMessages"
>;

const directorySession = (env: Cloudflare.Env): D1DatabaseSession => {
  const database = env.CONTROL_DB;
  if (database === undefined || typeof database.withSession !== "function") {
    throw new ReadError("service_unavailable");
  }
  try {
    return database.withSession("first-primary");
  } catch (error) {
    throw new ReadError("service_unavailable", error);
  }
};

const projection = (context: ReadHandlerContext): ProjectionReadStub => {
  const namespace = context.env.TENANT_PROJECTION;
  if (namespace === undefined || typeof namespace.getByName !== "function") {
    throw new ReadError("service_unavailable");
  }
  try {
    return namespace.getByName(context.authorization.tenant.id);
  } catch (error) {
    throw new ReadError("service_unavailable", error);
  }
};

const withReadErrors = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    throw mapReadError(error);
  }
};

const removalDatabase = (context: ReadHandlerContext): D1Database => {
  const database = context.env.CONTROL_DB;
  if (database === undefined) throw new ReadError("service_unavailable");
  return database;
};

const removalFor = async (
  context: ReadHandlerContext,
  resourceType: string,
  resourceId: string,
  accountId: string,
  conversationId: string,
): Promise<RemovalAuthority | null> => {
  try {
    return await readAuthorizedResourceRemoval(removalDatabase(context), {
      tenantId: context.authorization.tenant.id,
      resourceType,
      resourceId,
      accountId,
      conversationId,
    });
  } catch (error) {
    throw new ReadError("service_unavailable", error);
  }
};

const messageRemovalFor = async (
  context: ReadHandlerContext,
  messageId: string,
  accountId: string,
  conversationId: string,
): Promise<RemovalAuthority | null> => {
  try {
    return await readAuthorizedMessageRemoval(removalDatabase(context), {
      tenantId: context.authorization.tenant.id,
      messageId,
      accountId,
      conversationId,
    });
  } catch (error) {
    throw new ReadError("service_unavailable", error);
  }
};

const redactMessage = (
  message: MessagePageResult["items"][number],
  authority: RemovalAuthority | null,
): MessagePageResult["items"][number] =>
  authority === null
    ? message
    : ({
        ...message,
        sender_participant_id: null,
        sender_label: "Deleted sender",
        body: "",
        attachment_count: 0,
        attachments: [],
      } satisfies MessagePageResult["items"][number]);

const redactSearchResult = (
  message: MessageSearchPageResult["items"][number],
  authority: RemovalAuthority | null,
): MessageSearchPageResult["items"][number] =>
  authority === null
    ? message
    : ({
        ...message,
        sender_label: "Deleted sender",
        body: "",
        attachments: [],
        removed: true,
        removed_at: authority.removed_at,
        removal_reason: authority.reason,
      } satisfies MessageSearchPageResult["items"][number]);

const publicConnection = ({
  sort_position: _sortPosition,
  account_id: _accountId,
  ...connection
}: DirectoryConnection): Connection => ConnectionSchema.parse(connection);

const filterGrantedConnections = (
  connections: readonly DirectoryConnection[],
  authorization: ProjectionAuthorizationContext,
): DirectoryConnection[] => {
  const allowed = authorization.allowed_account_ids;
  if (allowed === undefined) return [...connections];
  return connections.filter(
    (connection) =>
      connection.account_id !== undefined &&
      allowed.includes(connection.account_id),
  );
};

const listDirectoryConnections = async (
  context: ReadHandlerContext,
  identityId: string,
): Promise<DirectoryConnection[]> => {
  const session = directorySession(context.env);
  return listConnectionsForIdentity(
    session,
    context.authorization.tenant.id,
    identityId,
  );
};

export async function listIdentities(
  context: ReadHandlerContext,
): Promise<Identity[]> {
  return withReadErrors(async () => {
    const values = context.authorization.identities.map((identity) => ({
      id: identity.identity_id,
      tenant_id: context.authorization.tenant.id,
      kind: identity.kind,
      display_name: identity.display_name,
    }));
    return IdentitySchema.array().max(MAX_IDENTITY_CONNECTIONS).parse(values);
  });
}

export async function listConnections(
  context: ReadHandlerContext,
  input: ListConnectionsInput,
): Promise<Connection[]> {
  return withReadErrors(async () => {
    requireAuthorizedIdentity(
      context.authorization,
      input.identity_id,
      "connection.read",
    );
    const authorization = await toGrantedProjectionReadAuthorization(
      context.env,
      context.authorization,
      input.identity_id,
      context.delegated,
    );
    const connections = filterGrantedConnections(
      await listDirectoryConnections(context, input.identity_id),
      authorization,
    );
    return ConnectionSchema.array()
      .max(MAX_IDENTITY_CONNECTIONS)
      .parse(connections.map(publicConnection));
  });
}

const channelRows = (
  connections: readonly DirectoryConnection[],
  stats: readonly {
    connection_id: string;
    unread_count: number;
    last_activity_at: string | null;
  }[],
): ChannelSummary[] => {
  const statsByConnection = new Map<
    string,
    {
      unread_count: number;
      last_activity_at: string | null;
    }
  >();
  for (const stat of stats) {
    if (statsByConnection.has(stat.connection_id)) {
      throw new Error("duplicate projection channel statistic");
    }
    statsByConnection.set(stat.connection_id, {
      unread_count: stat.unread_count,
      last_activity_at: stat.last_activity_at,
    });
  }

  const connectionIds = new Set(connections.map((connection) => connection.id));
  for (const stat of stats) {
    if (!connectionIds.has(stat.connection_id)) {
      throw new Error("projection channel statistic is outside the directory");
    }
  }

  return ChannelSummarySchema.array()
    .max(MAX_IDENTITY_CONNECTIONS)
    .parse(
      connections.map((connection) => {
        const stat = statsByConnection.get(connection.id);
        return {
          id: connection.id,
          tenant_id: connection.tenant_id,
          identity_id: connection.identity_id,
          provider: connection.provider,
          display_label: connection.display_label,
          status: connection.status,
          capabilities: connection.capabilities,
          unread_count: stat?.unread_count ?? 0,
          last_activity_at: stat?.last_activity_at ?? null,
          sort_position: connection.sort_position,
          ...(connection.attention_code === undefined
            ? {}
            : { attention_code: connection.attention_code }),
        };
      }),
    );
};

export async function listChannels(
  context: ReadHandlerContext,
  input: ListChannelsInput,
): Promise<ChannelSummary[]> {
  return withReadErrors(async () => {
    requireAuthorizedIdentity(
      context.authorization,
      input.identity_id,
      "conversation.read",
    );
    requireAuthorizedIdentity(
      context.authorization,
      input.identity_id,
      "connection.read",
    );
    const authorization = await toGrantedProjectionReadAuthorization(
      context.env,
      context.authorization,
      input.identity_id,
      context.delegated,
    );
    const connections = filterGrantedConnections(
      await listDirectoryConnections(context, input.identity_id),
      authorization,
    );
    const stats = await projection(context).listChannelStats({
      schema_version: 1,
      tenant_id: context.authorization.tenant.id,
      identity_id: input.identity_id,
      authorization,
    });
    return channelRows(connections, stats);
  });
}

const validateChannelFilter = async (
  context: ReadHandlerContext,
  identityId: string,
  channelId: string | undefined,
  authorization: ProjectionAuthorizationContext,
): Promise<void> => {
  if (channelId === undefined) return;
  const connections = await listDirectoryConnections(context, identityId);
  const connection = connections.find(
    (candidate) => candidate.id === channelId,
  );
  if (connection === undefined) {
    throw new ReadError("not_found");
  }
  if (
    authorization.allowed_account_ids !== undefined &&
    (connection.account_id === undefined ||
      !authorization.allowed_account_ids.includes(connection.account_id))
  ) {
    throw new ReadError("not_found");
  }
};

const validateAccountFilter = (
  accountId: string | undefined,
  authorization: ProjectionAuthorizationContext,
): void => {
  if (accountId === undefined) return;
  const allowed = authorization.allowed_account_ids;
  if (allowed !== undefined && !allowed.includes(accountId)) {
    throw new ReadError("not_found");
  }
};

export async function listConversations(
  context: ReadHandlerContext,
  input: ListConversationsInput,
): Promise<ConversationPageResult> {
  return withReadErrors(async () => {
    let resourceIdentityId = input.identity_id;
    let authorization;
    if (input.account_id !== undefined) {
      const resolved = await toGrantedAccountReadAuthorization(
        context.env,
        context.authorization,
        input.identity_id,
        input.account_id,
        context.delegated,
      );
      resourceIdentityId = resolved.resourceIdentityId;
      authorization = resolved.authorization;
    } else {
      requireAuthorizedIdentity(
        context.authorization,
        input.identity_id,
        "conversation.read",
      );
      authorization = await toGrantedProjectionReadAuthorization(
        context.env,
        context.authorization,
        input.identity_id,
        context.delegated,
      );
    }
    validateAccountFilter(input.account_id, authorization);
    await validateChannelFilter(
      context,
      resourceIdentityId,
      input.channel_id,
      authorization,
    );
    const projectionInput = {
      schema_version: 1 as const,
      tenant_id: context.authorization.tenant.id,
      identity_id: resourceIdentityId,
      ...(input.account_id === undefined
        ? {}
        : { account_id: input.account_id }),
      connection_id: input.channel_id ?? null,
      ...(input.limit === undefined ? {} : { page_size: input.limit }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      authorization,
    };
    const page = await projection(context).listConversations(projectionInput);
    const parsedPage = ConversationPageResultSchema.parse(
      structuredClone(page),
    );
    const visibleItems = await Promise.all(
      parsedPage.items.map(async (conversation) =>
        (await removalFor(
          context,
          "conversation",
          conversation.id,
          conversation.account_id ?? "",
          conversation.id,
        )) === null
          ? conversation
          : null,
      ),
    );
    return ConversationPageResultSchema.parse({
      ...parsedPage,
      items: visibleItems.filter(
        (conversation): conversation is NonNullable<typeof conversation> =>
          conversation !== null,
      ),
    });
  });
}

export async function getConversation(
  context: ReadHandlerContext,
  input: GetConversationInput,
): Promise<ConversationSummary> {
  return withReadErrors(async () => {
    let resourceIdentityId = input.identity_id;
    let authorization;
    if (input.account_id !== undefined) {
      const resolved = await toGrantedAccountReadAuthorization(
        context.env,
        context.authorization,
        input.identity_id,
        input.account_id,
        context.delegated,
      );
      resourceIdentityId = resolved.resourceIdentityId;
      authorization = resolved.authorization;
    } else {
      requireAuthorizedIdentity(
        context.authorization,
        input.identity_id,
        "conversation.read",
      );
      authorization = await toGrantedProjectionReadAuthorization(
        context.env,
        context.authorization,
        input.identity_id,
        context.delegated,
      );
    }
    validateAccountFilter(input.account_id, authorization);
    const conversation = await projection(context).getConversation({
      schema_version: 1,
      tenant_id: context.authorization.tenant.id,
      identity_id: resourceIdentityId,
      conversation_id: input.conversation_id,
      ...(input.account_id === undefined
        ? {}
        : { account_id: input.account_id }),
      authorization,
    });
    if (conversation === null) throw new ReadError("not_found");
    if (
      (await removalFor(
        context,
        "conversation",
        conversation.id,
        conversation.account_id ?? "",
        conversation.id,
      )) !== null
    ) {
      throw new ReadError("not_found");
    }
    return ConversationSummarySchema.parse(structuredClone(conversation));
  });
}

export async function listMessages(
  context: ReadHandlerContext,
  input: ListMessagesInput,
): Promise<MessagePageResult> {
  return withReadErrors(async () => {
    let resourceIdentityId = input.identity_id;
    let authorization;
    if (input.account_id !== undefined) {
      const resolved = await toGrantedAccountReadAuthorization(
        context.env,
        context.authorization,
        input.identity_id,
        input.account_id,
        context.delegated,
      );
      resourceIdentityId = resolved.resourceIdentityId;
      authorization = resolved.authorization;
    } else {
      requireAuthorizedIdentity(
        context.authorization,
        input.identity_id,
        "conversation.read",
      );
      authorization = await toGrantedProjectionReadAuthorization(
        context.env,
        context.authorization,
        input.identity_id,
        context.delegated,
      );
    }
    validateAccountFilter(input.account_id, authorization);
    const projectionStub = projection(context);
    const conversation = await projectionStub.getConversation({
      schema_version: 1,
      tenant_id: context.authorization.tenant.id,
      identity_id: resourceIdentityId,
      conversation_id: input.conversation_id,
      ...(input.account_id === undefined
        ? {}
        : { account_id: input.account_id }),
      authorization,
    });
    if (conversation === null) throw new ReadError("not_found");
    const page = await projectionStub.listMessages({
      schema_version: 1,
      tenant_id: context.authorization.tenant.id,
      identity_id: resourceIdentityId,
      conversation_id: input.conversation_id,
      ...(input.message_id === undefined
        ? {}
        : { message_id: input.message_id }),
      ...(input.account_id === undefined
        ? {}
        : { account_id: input.account_id }),
      ...(input.limit === undefined ? {} : { page_size: input.limit }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      authorization,
    });
    const parsedPage = MessagePageResultSchema.parse(structuredClone(page));
    const removedMessageIds = new Set<string>();
    const messageItems = await Promise.all(
      parsedPage.items.map(async (item) => {
        const authority = await messageRemovalFor(
          context,
          item.id,
          item.account_id ?? "",
          item.conversation_id,
        );
        if (authority !== null) removedMessageIds.add(item.id);
        return redactMessage(item, authority);
      }),
    );
    const attachmentRows: ProjectionAttachment[] =
      messageItems.length === 0
        ? []
        : await projectionStub.listAttachments({
            schema_version: 1,
            tenant_id: context.authorization.tenant.id,
            identity_id: resourceIdentityId,
            conversation_id: input.conversation_id,
            message_ids: messageItems
              .filter((item) => !removedMessageIds.has(item.id))
              .map((item) => item.id),
            ...(input.account_id === undefined
              ? {}
              : { account_id: input.account_id }),
            authorization,
          });
    const attachmentsByMessage = new Map<string, ProjectionAttachment[]>();
    for (const attachment of attachmentRows) {
      const existing = attachmentsByMessage.get(attachment.message_id);
      if (existing === undefined) {
        attachmentsByMessage.set(attachment.message_id, [attachment]);
      } else {
        existing.push(attachment);
      }
    }
    const attachmentContext: AttachmentServiceContext = {
      env: context.env,
      authorization: context.authorization,
      requestedIdentityId: input.identity_id,
      ...(context.delegated === undefined
        ? {}
        : { delegated: context.delegated }),
      provider: attachmentProviderFromEnv(context.env),
    };
    const enrichedItems = await Promise.all(
      messageItems.map(async (item) => {
        const rows = attachmentsByMessage.get(item.id) ?? [];
        const attachments = await Promise.all(
          rows.map((attachment) => metadataFor(attachmentContext, attachment)),
        );
        return {
          ...item,
          attachments: AttachmentMetadataSchema.array().parse(attachments),
        };
      }),
    );
    const finalItems = await Promise.all(
      enrichedItems.map(async (item) =>
        redactMessage(
          item,
          await messageRemovalFor(
            context,
            item.id,
            item.account_id ?? "",
            item.conversation_id,
          ),
        ),
      ),
    );
    const enrichedPage = MessagePageResultSchema.parse({
      ...parsedPage,
      items: finalItems,
    });
    const accountId = conversation.account_id;
    let hasMessages = parsedPage.items.length > 0;
    if (!hasMessages) {
      // Coverage describes the conversation, not the requested page. A seek
      // cursor can legitimately land after the final row, so probe the first
      // row before calling an existing chat empty.
      const coverageProbe = await projectionStub.listMessages({
        schema_version: 1,
        tenant_id: context.authorization.tenant.id,
        identity_id: resourceIdentityId,
        conversation_id: input.conversation_id,
        ...(input.account_id === undefined
          ? {}
          : { account_id: input.account_id }),
        page_size: 1,
        authorization,
      });
      hasMessages =
        MessagePageResultSchema.parse(structuredClone(coverageProbe)).items
          .length > 0;
    }
    if (accountId === undefined) return enrichedPage;
    return MessagePageResultSchema.parse({
      ...enrichedPage,
      history: await historyCoverage(
        context.env.CONTROL_DB,
        context.authorization.tenant.id,
        accountId,
        hasMessages,
      ),
    });
  });
}

export async function searchMessages(
  context: ReadHandlerContext,
  input: SearchMessagesInput,
): Promise<MessageSearchPageResult> {
  return withReadErrors(async () => {
    let parsedInput: MessageSearchRequest;
    try {
      parsedInput = MessageSearchRequestSchema.parse(input);
    } catch (error) {
      throw new ReadError("invalid_request", error);
    }

    let resourceIdentityId = parsedInput.identity_id;
    let authorization: ProjectionAuthorizationContext;
    if (parsedInput.account_id !== undefined) {
      const resolved = await toGrantedAccountReadAuthorization(
        context.env,
        context.authorization,
        parsedInput.identity_id,
        parsedInput.account_id,
        context.delegated,
      );
      resourceIdentityId = resolved.resourceIdentityId;
      authorization = resolved.authorization;
    } else {
      requireAuthorizedIdentity(
        context.authorization,
        parsedInput.identity_id,
        "conversation.read",
      );
      authorization = await toGrantedProjectionReadAuthorization(
        context.env,
        context.authorization,
        parsedInput.identity_id,
        context.delegated,
      );
    }
    validateAccountFilter(parsedInput.account_id, authorization);
    const page = await projection(context).searchMessages({
      schema_version: 1,
      tenant_id: context.authorization.tenant.id,
      identity_id: resourceIdentityId,
      ...(parsedInput.account_id === undefined
        ? {}
        : { account_id: parsedInput.account_id }),
      ...(parsedInput.conversation_id === undefined
        ? {}
        : { conversation_id: parsedInput.conversation_id }),
      ...(parsedInput.text === undefined ? {} : { text: parsedInput.text }),
      ...(parsedInput.contact === undefined
        ? {}
        : { contact: parsedInput.contact }),
      ...(parsedInput.from === undefined ? {} : { from: parsedInput.from }),
      ...(parsedInput.to === undefined ? {} : { to: parsedInput.to }),
      ...(parsedInput.direction === undefined
        ? {}
        : { direction: parsedInput.direction }),
      ...(parsedInput.limit === undefined
        ? {}
        : { page_size: parsedInput.limit }),
      ...(parsedInput.cursor === undefined
        ? {}
        : { cursor: parsedInput.cursor }),
      authorization,
    });
    const parsedPage = MessageSearchPageResultSchema.parse(
      structuredClone(page),
    );
    const items = await Promise.all(
      parsedPage.items.map(async (item) =>
        redactSearchResult(
          item,
          await messageRemovalFor(
            context,
            item.id,
            item.account_id,
            item.conversation_id,
          ),
        ),
      ),
    );
    return MessageSearchPageResultSchema.parse({ ...parsedPage, items });
  });
}
