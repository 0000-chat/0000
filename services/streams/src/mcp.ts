export const objectSchema = (
  properties: Record<string, unknown>,
  required: string[],
) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const visibleStatuses = ["needs_decision", "ongoing", "no_action"] as const;
const upsertStatuses = [
  ...visibleStatuses,
  "active",
  "deferred",
  "archived",
] as const;
const statusSchema = { type: "string", enum: visibleStatuses };
const upsertStatusSchema = { type: "string", enum: upsertStatuses };
const timelineEntrySchema = objectSchema(
  {
    at: { type: "string" },
    text: { type: "string" },
  },
  ["at", "text"],
);
const choiceSchema = objectSchema(
  {
    id: { type: "string" },
    label: { type: "string" },
    value: { type: "string" },
    recommended: { type: "boolean" },
  },
  ["id", "label", "value"],
);
const streamChoicesSchema = { type: "array", minItems: 1, items: choiceSchema };

export const toolDefinitions = [
  {
    name: "upsert_stream",
    description: "Create or update a Helm stream.",
    inputSchema: objectSchema(
      {
        streamId: { type: "string" },
        title: { type: "string" },
        ownerBot: { type: "string" },
        about: { type: "string" },
        timeline: { type: "array", items: timelineEntrySchema },
        status: upsertStatusSchema,
        choices: streamChoicesSchema,
        summary: { type: "string" },
        choiceWebhookUrl: { type: "string" },
        choiceWebhookAuthorization: { type: "string" },
        history: { type: "array", items: { type: "string" } },
        priority: { type: "integer", minimum: 0 },
        needsDon: { type: "boolean" },
      },
      ["streamId", "title", "ownerBot"],
    ),
  },
  {
    name: "reprioritize_stream",
    description: "Change a stream priority and Don-attention flag.",
    inputSchema: objectSchema(
      {
        streamId: { type: "string" },
        priority: { type: "integer" },
        needsDon: { type: "boolean" },
      },
      ["streamId", "priority"],
    ),
  },
  {
    name: "archive_stream",
    description: "Archive a stream.",
    inputSchema: objectSchema({ streamId: { type: "string" } }, ["streamId"]),
  },
  {
    name: "set_stream_choices",
    description: "Replace the choices shown for a stream.",
    inputSchema: objectSchema(
      { streamId: { type: "string" }, choices: streamChoicesSchema },
      ["streamId", "choices"],
    ),
  },
  {
    name: "patch_streams",
    description: "Apply status or priority changes to multiple streams.",
    inputSchema: objectSchema(
      {
        patches: {
          type: "array",
          minItems: 1,
          items: objectSchema(
            {
              streamId: { type: "string" },
              status: statusSchema,
              priority: { type: "integer", minimum: 0 },
            },
            ["streamId"],
          ),
        },
      },
      ["patches"],
    ),
  },
  {
    name: "list_streams",
    description:
      "List streams in the Don room. includeArchived defaults true for ops/storage diagnosis.",
    inputSchema: objectSchema(
      {
        includeArchived: { type: "boolean" },
      },
      [],
    ),
  },
];

export type McpEnvelope =
  | {
      kind: "request";
      id: string | number | null;
      method: string;
      params: Record<string, unknown>;
    }
  | { kind: "notification"; method: string };

export function parseMcpEnvelope(value: unknown): McpEnvelope {
  if (!value || typeof value !== "object") throw new Error("Invalid Request");
  const body = value as Record<string, unknown>;
  if (body.jsonrpc !== "2.0" || typeof body.method !== "string")
    throw new Error("Invalid Request");
  if (!("id" in body)) return { kind: "notification", method: body.method };
  if (
    body.id !== null &&
    typeof body.id !== "string" &&
    typeof body.id !== "number"
  )
    throw new Error("Invalid Request");
  if (
    body.params !== undefined &&
    (!body.params ||
      typeof body.params !== "object" ||
      Array.isArray(body.params))
  )
    throw new Error("Invalid params");
  return {
    kind: "request",
    id: body.id,
    method: body.method,
    params: (body.params ?? {}) as Record<string, unknown>,
  };
}

const text = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} is required`);
  return value;
};
const integer = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a nonnegative integer`);
  return value;
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function validateStatus(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !visibleStatuses.includes(value as (typeof visibleStatuses)[number])
  ) {
    throw new Error(`${name} must be one of ${visibleStatuses.join(", ")}`);
  }
  return value;
}

function validateUpsertStatus(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !upsertStatuses.includes(value as (typeof upsertStatuses)[number])
  ) {
    throw new Error(`${name} must be one of ${upsertStatuses.join(", ")}`);
  }
  return value;
}

function validateTimeline(value: unknown): { at: string; text: string }[] {
  if (!Array.isArray(value)) throw new Error("timeline must be an array");
  return value.map((entry, index) => {
    if (!isRecord(entry))
      throw new Error(`timeline[${index}] must be an object`);
    const extra = Object.keys(entry).find(
      (key) => !["at", "text"].includes(key),
    );
    if (extra) throw new Error(`unexpected timeline field: ${extra}`);
    return {
      at: text(entry.at, `timeline[${index}].at`),
      text: text(entry.text, `timeline[${index}].text`),
    };
  });
}

function validateChoices(
  value: unknown,
): { id: string; label: string; value: string; recommended?: boolean }[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("choices are required");
  const choices = value.map((choice, index) => {
    if (!isRecord(choice))
      throw new Error(`choice[${index}] must be an object`);
    const extra = Object.keys(choice).find(
      (key) => !["id", "label", "value", "recommended"].includes(key),
    );
    if (extra) throw new Error(`unexpected choice field: ${extra}`);
    if (
      choice.recommended !== undefined &&
      typeof choice.recommended !== "boolean"
    ) {
      throw new Error("choice.recommended must be boolean");
    }
    return {
      id: text(choice.id, "choice.id"),
      label: text(choice.label, "choice.label"),
      value: text(choice.value, "choice.value"),
      ...(choice.recommended === undefined
        ? {}
        : { recommended: choice.recommended }),
    };
  });
  if (choices.filter((choice) => choice.recommended === true).length > 1) {
    throw new Error("at most one choice may be recommended");
  }
  return choices;
}

export function validateToolInput(
  name: string,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const allowed: Record<string, string[]> = {
    archive_stream: ["streamId"],
    reprioritize_stream: ["streamId", "priority", "needsDon"],
    upsert_stream: [
      "streamId",
      "title",
      "ownerBot",
      "about",
      "timeline",
      "status",
      "choices",
      "summary",
      "history",
      "priority",
      "needsDon",
      "choiceWebhookUrl",
      "choiceWebhookAuthorization",
    ],
    set_stream_choices: ["streamId", "choices"],
    patch_streams: ["patches"],
    list_streams: ["includeArchived"],
  };
  if (!allowed[name]) throw new Error(`Unknown tool: ${name}`);
  const extra = Object.keys(raw).find((key) => !allowed[name].includes(key));
  if (extra) throw new Error(`unexpected field: ${extra}`);
  if (name === "list_streams") {
    if (
      raw.includeArchived !== undefined &&
      typeof raw.includeArchived !== "boolean"
    ) {
      throw new Error("includeArchived must be boolean");
    }
    return typeof raw.includeArchived === "boolean"
      ? { includeArchived: raw.includeArchived }
      : {};
  }
  if (name === "archive_stream")
    return { streamId: text(raw.streamId, "streamId") };
  if (name === "reprioritize_stream") {
    return {
      streamId: text(raw.streamId, "streamId"),
      priority: integer(raw.priority, "priority"),
      ...(typeof raw.needsDon === "boolean" ? { needsDon: raw.needsDon } : {}),
    };
  }
  if (name === "upsert_stream") {
    if (raw.about !== undefined && typeof raw.about !== "string")
      throw new Error("about must be a string");
    if (raw.summary !== undefined && typeof raw.summary !== "string")
      throw new Error("summary must be a string");
    if (
      raw.history !== undefined &&
      (!Array.isArray(raw.history) ||
        !raw.history.every((item) => typeof item === "string"))
    ) {
      throw new Error("history must contain strings");
    }
    if (raw.needsDon !== undefined && typeof raw.needsDon !== "boolean")
      throw new Error("needsDon must be boolean");
    if (raw.status !== undefined) validateUpsertStatus(raw.status, "status");
    return {
      streamId: text(raw.streamId, "streamId"),
      title: text(raw.title, "title"),
      ownerBot: text(raw.ownerBot, "ownerBot"),
      ...(typeof raw.about === "string" ? { about: raw.about } : {}),
      ...(raw.timeline === undefined
        ? {}
        : { timeline: validateTimeline(raw.timeline) }),
      ...(typeof raw.status === "string" ? { status: raw.status } : {}),
      ...(raw.choices === undefined
        ? {}
        : { choices: validateChoices(raw.choices) }),
      ...(typeof raw.summary === "string" ? { summary: raw.summary } : {}),
      ...(typeof raw.choiceWebhookUrl === "string"
        ? { choiceWebhookUrl: raw.choiceWebhookUrl }
        : {}),
      ...(typeof raw.choiceWebhookAuthorization === "string"
        ? { choiceWebhookAuthorization: raw.choiceWebhookAuthorization }
        : {}),
      ...(Array.isArray(raw.history) &&
      raw.history.every((item) => typeof item === "string")
        ? { history: raw.history }
        : {}),
      ...(raw.priority === undefined
        ? {}
        : { priority: integer(raw.priority, "priority") }),
      ...(typeof raw.needsDon === "boolean" ? { needsDon: raw.needsDon } : {}),
    };
  }
  if (name === "set_stream_choices") {
    return {
      streamId: text(raw.streamId, "streamId"),
      choices: validateChoices(raw.choices),
    };
  }
  if (name === "patch_streams") {
    if (!Array.isArray(raw.patches) || raw.patches.length === 0)
      throw new Error("patches must be a nonempty array");
    const ids = new Set<string>();
    const patches = raw.patches.map((patch, index) => {
      if (!isRecord(patch))
        throw new Error(`patches[${index}] must be an object`);
      const extra = Object.keys(patch).find(
        (key) => !["streamId", "status", "priority"].includes(key),
      );
      if (extra) throw new Error(`unexpected patch field: ${extra}`);
      const streamId = text(patch.streamId, `patches[${index}].streamId`);
      if (ids.has(streamId)) throw new Error("patch stream IDs must be unique");
      ids.add(streamId);
      if (patch.status === undefined && patch.priority === undefined) {
        throw new Error("each patch must include at least one mutable field");
      }
      return {
        streamId,
        ...(patch.status === undefined
          ? {}
          : {
              status: validateStatus(patch.status, `patches[${index}].status`),
            }),
        ...(patch.priority === undefined
          ? {}
          : {
              priority: integer(patch.priority, `patches[${index}].priority`),
            }),
      };
    });
    return { patches };
  }
  throw new Error(`Unknown tool: ${name}`);
}

const protocolVersion = "2025-06-18";
const response = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "MCP-Protocol-Version": protocolVersion,
    },
  });

export async function handleMcpRequest(
  request: Request,
  authToken: string,
  execute: (name: string, input: Record<string, unknown>) => Promise<unknown>,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (origin && origin !== "https://don.0000.gold")
    return response({ error: "Forbidden origin" }, 403);
  if (request.headers.get("Authorization") !== `Bearer ${authToken}`)
    return response({ error: "Unauthorized" }, 401);
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  let requestId: string | number | null = null;
  try {
    if (!request.headers.get("content-type")?.includes("application/json"))
      throw new SyntaxError("JSON body required");
    const envelope = parseMcpEnvelope(await request.json());
    if (envelope.kind === "notification") {
      if (request.headers.get("MCP-Protocol-Version") !== protocolVersion)
        return new Response(null, { status: 400 });
      return new Response(null, { status: 202 });
    }
    const { id, method, params } = envelope;
    requestId = id;
    if (
      method !== "initialize" &&
      request.headers.get("MCP-Protocol-Version") !== protocolVersion
    ) {
      return response(
        {
          jsonrpc: "2.0",
          id,
          error: { code: -32600, message: "Unsupported MCP protocol version" },
        },
        400,
      );
    }
    if (method === "initialize")
      return response({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "0000-streams", version: "0.1.0" },
        },
      });
    if (method === "ping") return response({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list")
      return response({
        jsonrpc: "2.0",
        id,
        result: { tools: toolDefinitions },
      });
    if (method !== "tools/call")
      return response({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found" },
      });
    const name = typeof params.name === "string" ? params.name : "";
    const args =
      params.arguments &&
      typeof params.arguments === "object" &&
      !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
    const result = await execute(name, validateToolInput(name, args));
    return response({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid Request";
    const code =
      error instanceof SyntaxError
        ? -32700
        : message === "Invalid Request"
          ? -32600
          : -32602;
    return response({
      jsonrpc: "2.0",
      id: requestId,
      error: { code, message },
    });
  }
}
