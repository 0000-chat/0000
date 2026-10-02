import { z } from "zod";
import type {
  AgentPrincipal,
  ServiceToolCatalog,
  ServiceToolDeclaration,
  ToolInvocationContext,
} from "./access";
import type { CallToolResult } from "mcp-use";

/** The subset of the Fetcher contract used by a Cloudflare service binding. */
export interface GatewayServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface MsgToolEntry {
  /** Stable ID owned by Msg and persisted in Gateway profile grants. */
  readonly operationId: string;
  /** The name registered by Msg's MCP server. */
  readonly mcpName: string;
  /** Safe agent-facing description supplied or approved by Msg. */
  readonly description: string;
  readonly inputSchema: ServiceToolDeclaration["inputSchema"];
}

export interface MsgAdapterOptions {
  readonly binding: GatewayServiceBinding;
  readonly endpoint?: string;
}

const MSG_ENDPOINT = "https://msg.0000.chat/mcp";
const MAX_CATALOG_PAGES = 8;
const MAX_CATALOG_TOOLS = 128;
const MAX_MSG_REQUEST_BYTES = 128 * 1024;
const MAX_MSG_RESPONSE_BYTES = 512 * 1024;
const MSG_CATALOG_TIMEOUT_MS = 3_000;
const MSG_CALL_TIMEOUT_MS = 5_000;

export function createMsgServiceCatalog(
  options: MsgAdapterOptions,
): ServiceToolCatalog {
  return {
    async getDeclarations() {
      const endpoint = options.endpoint ?? MSG_ENDPOINT;
      const declarations: ServiceToolDeclaration[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
        const params = cursor === undefined ? {} : { cursor };
        const listed = await requestMsgRpc(
          options.binding,
          endpoint,
          "tools/list",
          params,
          undefined,
          undefined,
          MSG_CATALOG_TIMEOUT_MS,
        );
        if (!isRecord(listed) || !Array.isArray(listed.tools)) return [];
        for (const entry of listed.tools) {
          if (declarations.length >= MAX_CATALOG_TOOLS) return [];
          declarations.push(
            ...declarationFromMsgTool(entry, options.binding, endpoint),
          );
          if (declarations.length > MAX_CATALOG_TOOLS) return [];
        }
        if (listed.nextCursor === undefined) return declarations;
        if (
          typeof listed.nextCursor !== "string" ||
          listed.nextCursor.length === 0 ||
          listed.nextCursor.length > 256
        )
          return [];
        cursor = listed.nextCursor;
      }
      return [];
    },
  };
}

/**
 * Adapt Msg's service-owned MCP surface to Gateway declarations. The binding
 * is the only egress path; no URL supplied by a program is fetched by
 * Gateway. Msg still validates every Thread/resource capability itself.
 */
async function invokeMsgTool(
  binding: GatewayServiceBinding,
  endpoint: string,
  entry: MsgToolEntry,
  principal: AgentPrincipal,
  input: Record<string, unknown>,
  context: ToolInvocationContext,
): Promise<CallToolResult> {
  const result = await requestMsgRpc(
    binding,
    endpoint,
    "tools/call",
    { name: entry.mcpName, arguments: input },
    context.signal,
    {
      "x-0000-gateway-agent-id": principal.agentId,
      "x-0000-gateway-organization-id": principal.organizationId,
      "x-0000-gateway-profile-id": principal.profileId,
    },
    MSG_CALL_TIMEOUT_MS,
  );
  if (!isCallToolResult(result) || result.isError === true) {
    return failedMsgCall();
  }
  return projectCallToolResult(result);
}

async function requestMsgRpc(
  binding: GatewayServiceBinding,
  endpoint: string,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>,
  timeoutMs = MSG_CALL_TIMEOUT_MS,
): Promise<unknown> {
  if (signal?.aborted) return null;
  const id = crypto.randomUUID();
  let body: string;
  try {
    body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });
  } catch {
    return null;
  }
  if (new TextEncoder().encode(body).byteLength > MAX_MSG_REQUEST_BYTES) {
    return null;
  }
  const controller = new AbortController();
  let resolveAborted: (() => void) | undefined;
  const aborted = new Promise<null>((resolve) => {
    resolveAborted = () => resolve(null);
  });
  const onAbort = () => {
    controller.abort();
    resolveAborted?.();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const responsePromise = (async () => {
      const response = await binding.fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": "2025-06-18",
          origin: new URL(endpoint).origin,
          ...extraHeaders,
        },
        body,
      });
      if (!response.ok) return null;
      return (await readBoundedJson(response, controller.signal)) as {
        id?: unknown;
        result?: unknown;
        error?: unknown;
      } | null;
    })();
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
    });
    const parsed = await Promise.race([responsePromise, timeout, aborted]);
    if (!parsed || parsed.id !== id || parsed.error !== undefined) return null;
    return parsed.result;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

function declarationFromMsgTool(
  value: unknown,
  binding: GatewayServiceBinding,
  endpoint: string,
): ServiceToolDeclaration[] {
  if (!isRecord(value)) return [];
  const name = value.name;
  const description = value.description;
  const inputSchema = value.inputSchema;
  if (
    typeof name !== "string" ||
    !/^[A-Za-z0-9_-]{1,96}$/u.test(name) ||
    typeof description !== "string" ||
    description.length > 8_192 ||
    !isRecord(inputSchema)
  )
    return [];
  try {
    const safeSchema = sanitizeSchema(inputSchema);
    const schema = z.fromJSONSchema(safeSchema);
    const outputSchema =
      isRecord(value.outputSchema) && isSafeSchema(value.outputSchema)
        ? z.fromJSONSchema(sanitizeSchema(value.outputSchema))
        : undefined;
    const entry: MsgToolEntry = {
      operationId: `msg.${name}`,
      mcpName: name,
      description,
      inputSchema: schema,
      ...(outputSchema ? { outputSchema } : {}),
    };
    return [
      {
        operationId: entry.operationId,
        name: `msg_${name}`,
        description: safeDescription(name, description),
        inputSchema: schema,
        ...(outputSchema ? { outputSchema } : {}),
        invoke: (principal, input, context) =>
          invokeMsgTool(binding, endpoint, entry, principal, input, context),
      },
    ];
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!isSafeSchema(schema)) throw new Error("Msg schema is not supported.");
  if (
    new TextEncoder().encode(JSON.stringify(schema)).byteLength >
    128 * 1024
  ) {
    throw new Error("Msg schema is too large.");
  }
  const output: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [key, value] of Object.entries(schema)) {
    if (key === "description" && typeof value === "string") {
      output[key] = redactPrivateCapabilityText(value);
    } else if (
      (key === "default" || key === "example") &&
      typeof value === "string"
    ) {
      output[key] = redactPrivateCapabilityText(value);
    } else if (key === "examples" && Array.isArray(value)) {
      output[key] = value.map((item) =>
        typeof item === "string" ? redactPrivateCapabilityText(item) : item,
      );
    } else if (isRecord(value)) {
      output[key] = sanitizeSchema(value);
    } else if (Array.isArray(value)) {
      output[key] = value.map((item) =>
        isRecord(item) ? sanitizeSchema(item) : item,
      );
    } else {
      output[key] = value;
    }
  }
  return output;
}

function redactPrivateCapabilityText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"']+\/manage\/[^\s"']*/giu, "[private input]")
    .replace(
      /private owner management URL[^.]*\.?/iu,
      "Private input supplied by the caller.",
    );
}

function isSafeSchema(schema: Record<string, unknown>, depth = 0): boolean {
  if (depth > 32) return false;
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$ref" && typeof value === "string" && !value.startsWith("#")) {
      return false;
    }
    if (isRecord(value) && !isSafeSchema(value, depth + 1)) return false;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isRecord(item) && !isSafeSchema(item, depth + 1)) return false;
      }
    }
  }
  return true;
}

function safeDescription(name: string, description: string): string {
  if (name === "manage_room")
    return "Perform a permitted Msg Thread management operation using authorized input.";
  return description
    .replace(
      /private owner management URL[^.]*\.?/iu,
      "Authorized operation details are returned only to the authorized caller.",
    )
    .replace(/signing secret/giu, "private signing value");
}

async function readBoundedJson(
  response: Response,
  signal?: AbortSignal,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  try {
    if (signal?.aborted) return null;
    signal?.addEventListener("abort", cancelReader, { once: true });
    while (true) {
      if (signal?.aborted) return null;
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_MSG_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(next.value);
    }
  } catch {
    return null;
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
  const text = new TextDecoder().decode(concat(chunks, total));
  const payload = response.headers
    .get("content-type")
    ?.toLocaleLowerCase()
    .includes("text/event-stream")
    ? (text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean)
        .at(-1) ?? "")
    : text;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function isCallToolResult(value: unknown): value is CallToolResult {
  if (value === null || typeof value !== "object") return false;
  const result = value as Partial<CallToolResult>;
  return Array.isArray(result.content);
}

function projectCallToolResult(result: CallToolResult): CallToolResult {
  const projected: CallToolResult = {
    content: result.content
      .map((block) => projectContentBlock(block))
      .filter(
        (block): block is NonNullable<typeof block> => block !== undefined,
      ),
  };
  if (result.structuredContent !== undefined) {
    projected.structuredContent = result.structuredContent;
  }
  return projected;
}

function projectContentBlock(
  block: CallToolResult["content"][number],
): CallToolResult["content"][number] | undefined {
  if (block.type === "text") {
    return typeof block.text === "string"
      ? { type: "text", text: block.text }
      : undefined;
  }
  if (block.type === "image" || block.type === "audio") {
    return typeof block.data === "string" && typeof block.mimeType === "string"
      ? { type: block.type, data: block.data, mimeType: block.mimeType }
      : undefined;
  }
  if (block.type === "resource") {
    return { type: "resource", resource: block.resource };
  }
  return undefined;
}

function failedMsgCall(): CallToolResult {
  // Do not relay Msg errors: they could contain a private management URL,
  // capability, token, or secret. Authorized successful create results pass
  // through unchanged because that is the operation's explicit return value.
  return {
    isError: true,
    content: [{ type: "text", text: "Msg operation failed." }],
  };
}
