import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  ApiFault,
  DatabaseObject,
  errorResponse,
  parseObject,
  type DatabaseBindings,
  type DatabaseResource,
  type DurableCallOutcome,
} from "./database-object";
import { DatabaseRegistry } from "./database-registry";

export { DatabaseObject, DatabaseRegistry };

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MCP_ENVELOPE_OVERHEAD_BYTES = 1024;
const MCP_EXPECTED_ID_BYTES = 64;
const REGISTRY_ID = "database-create-registry-v1";
const ACCESS_WARNING =
  "Anyone with this link can read and change the database while writable. Do not store sensitive information.";

type JsonObject = Record<string, unknown>;
type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: JsonObject;
  isError?: boolean;
};

const idSchema = z.string().min(1).max(128);
const requestKeySchema = z
  .string()
  .min(8)
  .max(128)
  .refine((value) => value.trim() === value)
  .describe(
    "Reuse only to retry the same logical mutation; use a new key after a conflict.",
  );
const creationKeySchema = z
  .string()
  .min(22)
  .max(128)
  .refine((value) => value.trim() === value)
  .describe(
    "Fresh cryptographically random key with at least 128 bits of entropy; retain it for retries.",
  );
const versionSchema = z.string().regex(new RegExp("^[1-9][0-9]*$"));
const scalarSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const valuesSchema = z.record(z.string(), scalarSchema);
const paginationFields = {
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
};

function registerTool(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: z.ZodObject,
  readOnly: boolean,
  origin: string,
  env: DatabaseBindings,
  responseBudget: number,
): void {
  server.registerTool(
    name,
    {
      title: name.replaceAll("_", " "),
      description: description + " " + ACCESS_WARNING,
      inputSchema,
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: name === "delete_record",
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      callTool(name, args as JsonObject, origin, env, responseBudget),
  );
}

function registerDatabaseTools(
  server: McpServer,
  origin: string,
  env: DatabaseBindings,
  responseBudget: number,
): void {
  registerTool(
    server,
    "create_database",
    "Create a database. Generate and retain a fresh cryptographically random requestKey with at least 128 bits of entropy for retries. The returned database link grants shared access.",
    z.strictObject({
      name: z.string(),
      description: z.string().optional(),
      requestKey: creationKeySchema,
    }),
    false,
    origin,
    env,
    responseBudget,
  );
  registerTool(
    server,
    "get_database",
    "Read database metadata and lifecycle state.",
    z.strictObject({ databaseId: idSchema }),
    true,
    origin,
    env,
    responseBudget,
  );
  registerTool(
    server,
    "create_table",
    "Create a table in a database.",
    z.strictObject({
      databaseId: idSchema,
      name: z.string(),
      description: z.string().optional(),
      requestKey: requestKeySchema,
    }),
    false,
    origin,
    env,
    responseBudget,
  );
  registerTool(
    server,
    "list_tables",
    "List tables with an optional continuation cursor.",
    z.strictObject({ databaseId: idSchema, ...paginationFields }),
    true,
    origin,
    env,
    responseBudget,
  );
  registerTool(
    server,
    "get_table",
    "Read one table and its schema version.",
    z.strictObject({ databaseId: idSchema, tableId: idSchema }),
    true,
    origin,
    env,
    responseBudget,
  );
  registerTool(
    server,
    "create_column",
    "Create a typed column using the current schema version as a precondition.",
    z.strictObject({
      databaseId: idSchema,
      tableId: idSchema,
      name: z.string(),
      type: z.enum(["string", "number", "boolean"]),
      nullable: z.boolean().optional(),
      expectedSchemaVersion: versionSchema,
      requestKey: requestKeySchema,
    }),
    false,
    origin,
    env,
    responseBudget,
  );
  registerTool(
    server,
    "list_columns",
    "List columns for a table with an optional continuation cursor.",
    z.strictObject({
      databaseId: idSchema,
      tableId: idSchema,
      ...paginationFields,
    }),
    true,
    origin,
    env,
    responseBudget,
  );
  registerTool(
    server,
    "get_column",
    "Read one column in a table.",
    z.strictObject({
      databaseId: idSchema,
      tableId: idSchema,
      columnId: idSchema,
    }),
    true,
    origin,
    env,
    responseBudget,
  );
  registerTool(
    server,
    "create_record",
    "Create a record using the table's current columns.",
    z.strictObject({
      databaseId: idSchema,
      tableId: idSchema,
      values: valuesSchema,
      requestKey: requestKeySchema,
    }),
    false,
    origin,
    env,
    responseBudget,
  );
  registerTool(
    server,
    "list_records",
    "List, filter, and sort records with an optional continuation cursor.",
    z.strictObject({
      databaseId: idSchema,
      tableId: idSchema,
      ...paginationFields,
      filterColumnId: idSchema.optional(),
      filterValue: scalarSchema.optional(),
      sortColumnId: idSchema.optional(),
      sortDirection: z.enum(["asc", "desc"]).optional(),
    }),
    true,
    origin,
    env,
    responseBudget,
  );
  registerTool(
    server,
    "get_record",
    "Read one record and its current version.",
    z.strictObject({
      databaseId: idSchema,
      tableId: idSchema,
      recordId: idSchema,
    }),
    true,
    origin,
    env,
    responseBudget,
  );
  registerTool(
    server,
    "update_record",
    "Merge record values only if expectedVersion is current.",
    z.strictObject({
      databaseId: idSchema,
      tableId: idSchema,
      recordId: idSchema,
      values: valuesSchema,
      expectedVersion: versionSchema,
      requestKey: requestKeySchema,
    }),
    false,
    origin,
    env,
    responseBudget,
  );
  registerTool(
    server,
    "delete_record",
    "Delete one record only if expectedVersion is current.",
    z.strictObject({
      databaseId: idSchema,
      tableId: idSchema,
      recordId: idSchema,
      expectedVersion: versionSchema,
      requestKey: requestKeySchema,
    }),
    false,
    origin,
    env,
    responseBudget,
  );
}

function internalUrl(
  origin: string,
  path: string,
  query: URLSearchParams,
): URL {
  const url = new URL(path, origin);
  url.search = query.toString();
  return url;
}

function appendQuery(
  query: URLSearchParams,
  args: JsonObject,
  fields: readonly string[],
): void {
  for (const field of fields) {
    const value = args[field];
    if (value === undefined) continue;
    query.set(
      field,
      field === "filterValue" || typeof value !== "string"
        ? JSON.stringify(value)
        : value,
    );
  }
}

function requestForTool(
  name: string,
  args: JsonObject,
  origin: string,
  responseBudget: number,
): Request {
  const databaseId = encodeURIComponent(String(args.databaseId ?? ""));
  const tableId = encodeURIComponent(String(args.tableId ?? ""));
  const columnId = encodeURIComponent(String(args.columnId ?? ""));
  const recordId = encodeURIComponent(String(args.recordId ?? ""));
  const databasePath = "/v1/databases/" + databaseId;
  const query = new URLSearchParams();
  const headers = new Headers();
  headers.set("x-database-response-budget", String(responseBudget));
  let path = databasePath;
  let method = "GET";
  let body: JsonObject | undefined;

  switch (name) {
    case "create_database":
      path = "/v1/databases";
      method = "POST";
      body = {
        name: args.name,
        ...(args.description === undefined
          ? {}
          : { description: args.description }),
      };
      headers.set("idempotency-key", String(args.requestKey));
      break;
    case "get_database":
      break;
    case "create_table":
      path += "/tables";
      method = "POST";
      body = {
        name: args.name,
        ...(args.description === undefined
          ? {}
          : { description: args.description }),
      };
      headers.set("idempotency-key", String(args.requestKey));
      break;
    case "list_tables":
      path += "/tables";
      appendQuery(query, args, ["limit", "cursor"]);
      break;
    case "get_table":
      path += "/tables/" + tableId;
      break;
    case "create_column":
      path += "/tables/" + tableId + "/columns";
      method = "POST";
      body = {
        name: args.name,
        type: args.type,
        ...(args.nullable === undefined ? {} : { nullable: args.nullable }),
      };
      headers.set("idempotency-key", String(args.requestKey));
      headers.set(
        "x-expected-schema-version",
        String(args.expectedSchemaVersion),
      );
      break;
    case "list_columns":
      path += "/tables/" + tableId + "/columns";
      appendQuery(query, args, ["limit", "cursor"]);
      break;
    case "get_column":
      path += "/tables/" + tableId + "/columns/" + columnId;
      break;
    case "create_record":
      path += "/tables/" + tableId + "/records";
      method = "POST";
      body = { values: args.values as JsonObject };
      headers.set("idempotency-key", String(args.requestKey));
      break;
    case "list_records":
      path += "/tables/" + tableId + "/records";
      appendQuery(query, args, [
        "limit",
        "cursor",
        "filterColumnId",
        "filterValue",
        "sortColumnId",
        "sortDirection",
      ]);
      break;
    case "get_record":
      path += "/tables/" + tableId + "/records/" + recordId;
      break;
    case "update_record":
      path += "/tables/" + tableId + "/records/" + recordId;
      method = "PATCH";
      body = { values: args.values as JsonObject };
      headers.set("idempotency-key", String(args.requestKey));
      headers.set("x-expected-version", String(args.expectedVersion));
      break;
    case "delete_record":
      path += "/tables/" + tableId + "/records/" + recordId;
      method = "DELETE";
      headers.set("idempotency-key", String(args.requestKey));
      headers.set("x-expected-version", String(args.expectedVersion));
      break;
    default:
      throw new ApiFault("VALIDATION_ERROR", 400, { tool: name });
  }

  const requestUrl = internalUrl(origin, path, query);
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  return new Request(requestUrl, init);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolText(name: string, result: JsonObject, isError: boolean): string {
  if (isError) {
    const error = isJsonObject(result.error) ? result.error : {};
    const code = typeof error.code === "string" ? error.code : "REQUEST_FAILED";
    const message =
      typeof error.message === "string"
        ? error.message
        : "The database request failed.";
    return name + " failed (" + code + "): " + message;
  }
  return name + " succeeded. See structuredContent for the result.";
}

async function callTool(
  name: string,
  args: JsonObject,
  origin: string,
  env: DatabaseBindings,
  responseBudget: number,
): Promise<McpToolResult> {
  let response: Response;
  try {
    response = await fetchRest(
      requestForTool(name, args, origin, responseBudget),
      env,
    );
  } catch (error) {
    response = errorResponse(error);
  }
  const body: unknown = response.status === 204 ? null : await response.json();

  if (!response.ok) {
    const errorBody = isJsonObject(body)
      ? body
      : { error: { code: "INTERNAL_ERROR", message: "Request failed" } };
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter !== null && isJsonObject(errorBody.error)) {
      const retryAfterSeconds = Number(retryAfter);
      const details = isJsonObject(errorBody.error.details)
        ? errorBody.error.details
        : {};
      errorBody.error.details = Number.isFinite(retryAfterSeconds)
        ? { ...details, retryAfterSeconds }
        : { ...details, retryAfter };
    }
    return {
      content: [{ type: "text", text: toolText(name, errorBody, true) }],
      structuredContent: errorBody,
      isError: true,
    };
  }

  const structuredContent: JsonObject = isJsonObject(body) ? body : {};
  const schemaVersion = response.headers.get("x-schema-version");
  if (schemaVersion !== null) structuredContent.schemaVersion = schemaVersion;
  return {
    content: [{ type: "text", text: toolText(name, structuredContent, false) }],
    structuredContent,
  };
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new ApiFault("UNSUPPORTED_MEDIA_TYPE", 415);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_REQUEST_BYTES) {
    throw new ApiFault("REQUEST_TOO_LARGE", 413, {
      maxBytes: MAX_REQUEST_BYTES,
    });
  }
  if (!request.body) throw new ApiFault("INVALID_JSON", 400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ApiFault("REQUEST_TOO_LARGE", 413, {
        maxBytes: MAX_REQUEST_BYTES,
      });
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiFault("INVALID_JSON", 400);
  }
}

type McpRequestContext = {
  responseBudget: number;
  requestId: string | number | null;
  method?: string;
};

function isJsonRpcId(value: unknown): value is string | number | null {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

async function inspectMcpRequest(request: Request): Promise<McpRequestContext> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_REQUEST_BYTES) {
    throw new ApiFault("REQUEST_TOO_LARGE", 413, {
      maxBytes: MAX_REQUEST_BYTES,
    });
  }
  const reader = request.clone().body?.getReader();
  if (!reader) {
    return {
      responseBudget: MAX_RESPONSE_BYTES - MCP_ENVELOPE_OVERHEAD_BYTES,
      requestId: null,
    };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ApiFault("REQUEST_TOO_LARGE", 413, {
        maxBytes: MAX_REQUEST_BYTES,
      });
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {
      responseBudget: MAX_RESPONSE_BYTES - MCP_ENVELOPE_OVERHEAD_BYTES,
      requestId: null,
    };
  }

  const entries = Array.isArray(parsed) ? parsed : [parsed];
  let idBytes = 0;
  let requestId: string | number | null = null;
  let method: string | undefined;
  for (const entry of entries) {
    if (!isJsonObject(entry)) continue;
    if (typeof entry.method === "string") method = entry.method;
    if (!Object.hasOwn(entry, "id")) continue;
    const serializedId = JSON.stringify(entry.id);
    if (serializedId !== undefined) {
      idBytes += new TextEncoder().encode(serializedId).byteLength;
    }
    if (isJsonRpcId(entry.id)) requestId = entry.id;
  }

  return {
    responseBudget: Math.max(
      1_024,
      MAX_RESPONSE_BYTES -
        MCP_ENVELOPE_OVERHEAD_BYTES -
        Math.max(0, idBytes - MCP_EXPECTED_ID_BYTES),
    ),
    requestId,
    method,
  };
}

async function fetchRest(
  request: Request,
  env: DatabaseBindings,
): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    parts.length === 2 &&
    parts[0] === "v1" &&
    parts[1] === "databases" &&
    request.method === "POST"
  ) {
    const payload = parseObject(await readJson(request), [
      "name",
      "description",
    ]);
    const id = env.REGISTRY.idFromName(REGISTRY_ID);
    const registry = env.REGISTRY.get(id) as unknown as {
      createDatabaseOutcome: (
        input: unknown,
        requestKey: string | null,
        origin: string,
      ) => Promise<DurableCallOutcome<DatabaseResource>>;
    };
    const outcome = await registry.createDatabaseOutcome(
      payload,
      request.headers.get("idempotency-key"),
      url.origin,
    );
    if (!outcome.ok) {
      return Response.json(outcome.body, {
        status: outcome.status,
        headers: outcome.headers,
      });
    }
    return Response.json(outcome.result, {
      status: 201,
      headers: { "cache-control": "no-store" },
    });
  }
  if (
    parts.length < 3 ||
    parts[0] !== "v1" ||
    parts[1] !== "databases" ||
    !parts[2]
  ) {
    throw new ApiFault("NOT_FOUND", 404);
  }
  const id = env.DATABASES.idFromName(parts[2]);
  return env.DATABASES.get(id).fetch(request);
}

async function fetchMcp(
  request: Request,
  env: DatabaseBindings,
): Promise<Response> {
  const requestContext = await inspectMcpRequest(request);
  const server = new McpServer(
    {
      name: "0000-database",
      version: "0.1.0",
    },
    {
      instructions: ACCESS_WARNING,
    },
  );
  registerDatabaseTools(
    server,
    new URL(request.url).origin,
    env,
    requestContext.responseBudget,
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(request);
    const contentType = response.headers.get("content-type") ?? "";
    if (
      contentType.toLowerCase().includes("application/json") &&
      (await response.clone().arrayBuffer()).byteLength > MAX_RESPONSE_BYTES
    ) {
      if (requestContext.method === "tools/call") {
        const errorBody = {
          error: {
            code: "RESULT_TOO_LARGE",
            message: "The MCP response exceeds 262144 bytes",
            details: { maxBytes: MAX_RESPONSE_BYTES },
          },
        };
        return Response.json(
          {
            jsonrpc: "2.0",
            id: requestContext.requestId,
            result: {
              content: [
                {
                  type: "text",
                  text: "The tool result exceeds the MCP response limit.",
                },
              ],
              structuredContent: errorBody,
              isError: true,
            },
          },
          { headers: { "cache-control": "no-store" } },
        );
      }
      return Response.json(
        {
          jsonrpc: "2.0",
          id: requestContext.requestId,
          error: { code: -32603, message: "MCP response exceeds 262144 bytes" },
        },
        { status: 500, headers: { "cache-control": "no-store" } },
      );
    }
    return response;
  } finally {
    await server.close();
    await transport.close();
  }
}

const worker = {
  async fetch(request: Request, env: DatabaseBindings): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/mcp") return await fetchMcp(request, env);
      return await fetchRest(request, env);
    } catch (error) {
      return errorResponse(error);
    }
  },
};

export default worker;
