import type { SessionResponse } from "@communicator/contracts";
import { CommunicatorIdSchema } from "@communicator/contracts";
import type { Context } from "hono";
import type { AuthorizationVariables } from "./auth/middleware";
import {
  getConversation,
  listChannels,
  listConnections,
  listConversations,
  listIdentities,
  listMessages,
  type ReadHandlerContext,
} from "./read/handlers";
import {
  toGrantedProjectionReadAuthorization,
} from "./read/authorization";
import { ReadError, readErrorResponse } from "./read/errors";

type McpContext = Context<{
  Bindings: Cloudflare.Env;
  Variables: AuthorizationVariables;
}>;

type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

const tools = [
  {
    name: "list_identities",
    description: "List identities authorized for this tenant",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "list_connections",
    description: "List granted connected accounts for an identity",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["identity_id"],
      properties: { identity_id: { type: "string" } },
    },
  },
  {
    name: "list_channels",
    description: "List granted channel summaries for an identity",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["identity_id"],
      properties: { identity_id: { type: "string" } },
    },
  },
  {
    name: "list_conversations",
    description: "List stored conversations for an identity or account",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["identity_id"],
      properties: {
        identity_id: { type: "string" },
        account_id: { type: "string" },
        channel_id: { type: "string" },
        cursor: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "get_conversation",
    description: "Read one stored conversation",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["identity_id", "conversation_id"],
      properties: {
        identity_id: { type: "string" },
        conversation_id: { type: "string" },
        account_id: { type: "string" },
      },
    },
  },
  {
    name: "list_messages",
    description: "Read paginated stored messages",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["identity_id", "conversation_id"],
      properties: {
        identity_id: { type: "string" },
        conversation_id: { type: "string" },
        account_id: { type: "string" },
        cursor: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
] as const;

const rpcError = (
  id: unknown,
  code: number,
  message: string,
): Record<string, unknown> => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

const rpcResult = (id: unknown, result: unknown): Record<string, unknown> => ({
  jsonrpc: "2.0",
  id: id ?? null,
  result,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const stringValue = (value: unknown, name: string): string => {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return CommunicatorIdSchema.max(128).parse(value);
};

const optionalStringValue = (value: unknown, name: string): string | undefined =>
  value === undefined ? undefined : stringValue(value, name);

const inputObject = (params: unknown): Record<string, unknown> => {
  if (!isRecord(params)) return {};
  const argumentsValue = params.arguments;
  if (argumentsValue === undefined) return {};
  if (!isRecord(argumentsValue)) throw new Error("arguments must be an object");
  return argumentsValue;
};

const contextForRead = (context: McpContext): ReadHandlerContext => ({
  env: context.env,
  authorization: context.get("authorization"),
  delegated: context.get("delegated"),
});

async function requireDelegatedGrant(
  context: ReadHandlerContext,
  identityId: string,
): Promise<void> {
  if (!context.delegated) return;
  const authorization = await toGrantedProjectionReadAuthorization(
    context.env,
    context.authorization,
    identityId,
  );
  if (authorization.allowed_account_ids?.length === 0) {
    throw new ReadError("forbidden");
  }
}

async function callTool(
  context: ReadHandlerContext,
  name: string,
  params: unknown,
): Promise<unknown> {
  const input = inputObject(params);
  switch (name) {
    case "list_identities":
      return listIdentities(context);
    case "list_connections": {
      const identityId = stringValue(input.identity_id, "identity_id");
      await requireDelegatedGrant(context, identityId);
      return listConnections(context, { identity_id: identityId });
    }
    case "list_channels": {
      const identityId = stringValue(input.identity_id, "identity_id");
      await requireDelegatedGrant(context, identityId);
      return listChannels(context, { identity_id: identityId });
    }
    case "list_conversations": {
      const identityId = stringValue(input.identity_id, "identity_id");
      await requireDelegatedGrant(context, identityId);
      return listConversations(context, {
        identity_id: identityId,
        ...(input.account_id === undefined
          ? {}
          : { account_id: stringValue(input.account_id, "account_id") }),
        ...(input.channel_id === undefined
          ? {}
          : { channel_id: stringValue(input.channel_id, "channel_id") }),
        ...(input.cursor === undefined
          ? {}
          : { cursor: stringValue(input.cursor, "cursor") }),
        ...(input.limit === undefined ? {} : { limit: Number(input.limit) }),
      });
    }
    case "get_conversation": {
      const identityId = stringValue(input.identity_id, "identity_id");
      await requireDelegatedGrant(context, identityId);
      return getConversation(context, {
        identity_id: identityId,
        conversation_id: stringValue(input.conversation_id, "conversation_id"),
        ...(input.account_id === undefined
          ? {}
          : { account_id: stringValue(input.account_id, "account_id") }),
      });
    }
    case "list_messages": {
      const identityId = stringValue(input.identity_id, "identity_id");
      await requireDelegatedGrant(context, identityId);
      return listMessages(context, {
        identity_id: identityId,
        conversation_id: stringValue(input.conversation_id, "conversation_id"),
        ...(input.account_id === undefined
          ? {}
          : { account_id: stringValue(input.account_id, "account_id") }),
        ...(input.cursor === undefined
          ? {}
          : { cursor: stringValue(input.cursor, "cursor") }),
        ...(input.limit === undefined ? {} : { limit: Number(input.limit) }),
      });
    }
    default:
      throw new TypeError("Unknown MCP tool");
  }
}

const toolText = (value: unknown): Array<Record<string, string>> => [
  { type: "text", text: JSON.stringify(value) },
];

export async function handleMcpRequest(context: McpContext): Promise<Response> {
  let body: JsonRpcRequest;
  try {
    body = await context.req.json<JsonRpcRequest>();
  } catch {
    return context.json(rpcError(null, -32700, "Invalid JSON"), 400);
  }
  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return context.json(rpcError(body.id, -32600, "Invalid JSON-RPC request"), 400);
  }
  const id = body.id ?? null;
  if (body.method === "initialize") {
    return context.json(
      rpcResult(id, {
        protocolVersion: "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "communicator", version: "1.0.0" },
      }),
      200,
    );
  }
  if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (body.method === "tools/list") return context.json(rpcResult(id, { tools }), 200);
  if (body.method !== "tools/call") {
    return context.json(rpcError(id, -32601, "Method not found"), 200);
  }
  if (!isRecord(body.params) || typeof body.params.name !== "string") {
    return context.json(rpcError(id, -32602, "Tool name is required"), 200);
  }
  try {
    const result = await callTool(
      contextForRead(context),
      body.params.name,
      body.params,
    );
    return context.json(rpcResult(id, { content: toolText(result), structuredContent: result }), 200);
  } catch (error) {
    if (error instanceof TypeError) return context.json(rpcError(id, -32602, error.message), 200);
    if (error instanceof ReadError) {
      const mapped = readErrorResponse(error);
      return context.json(
        rpcResult(id, {
          isError: true,
          content: toolText(mapped.body),
        }),
        200,
      );
    }
    return context.json(
      rpcResult(id, {
        isError: true,
        content: toolText({ error: { code: "service_unavailable", message: "Service unavailable" } }),
      }),
      200,
    );
  }
}

export function handleMcpGet(context: McpContext): Response {
  return context.body(null, 405, {
    Allow: "POST",
    "Cache-Control": "no-store",
  });
}
