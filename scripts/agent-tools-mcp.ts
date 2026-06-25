#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod/v4"

import { buildZeroChatMcpGuideText } from "./acp-bridge/zero-chat-policy"

export const AGENT_TOOL_MCP_TOOL_NAMES = [
  "userPrompts.requestChoice",
  "threads.list",
  "messages.search",
  "settings.setDefaultApprovalLevel",
  "agents.list",
  "agents.sendMailboxMessage",
  "spaces.list",
  "spaces.get",
  "spaces.create",
  "spaces.update",
  "spaces.archive",
  "spaces.unarchive",
  "apps.list",
  "apps.get",
  "apps.create",
  "apps.createRevision",
  "apps.generateFromRevision",
  "apps.listGenerations",
  "apps.update",
  "apps.archive",
  "apps.validateOpenUi",
  "automations.list",
  "automations.get",
  "automations.create",
  "automations.update",
  "automations.disable",
  "automations.runNow",
  "databases.list",
  "databases.get",
  "databases.listRows",
  "databases.getRow",
  "databases.searchRows",
  "databases.create",
  "databases.createField",
  "databases.createRow",
  "databases.updateRow",
  "databases.deleteRow",
  "secrets.put",
  "secrets.listAvailable",
  "scripts.createDraft",
  "scripts.updateDraft",
  "scripts.search",
  "scripts.read",
] as const

type AgentToolMcpToolName = (typeof AGENT_TOOL_MCP_TOOL_NAMES)[number]
type AgentToolMcpEnv = {
  agentSessionId: string
  appUrl: string
  bridgeToken: string
  deviceId: string
  threadId?: string
  toolBaseUrl?: string
}
type AgentToolFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type AgentToolHttpInvokeOptions = {
  timeoutMs?: number
}
type AgentToolInvokeFailureReasonCode =
  | "APP_ERROR"
  | "FETCH_ERROR"
  | "HTTP_ERROR"
  | "INVALID_JSON"
  | "TOOL_TIMEOUT"
type AgentToolInvokeFailure = {
  ok: false
  error: string
  reasonCode: AgentToolInvokeFailureReasonCode
  retryable?: boolean
  safeToRetry?: boolean
  timeoutMs?: number
  httpStatus?: number
  tool?: string
}
type AgentToolInvokeSuccess = {
  ok: true
  result: unknown
}
type AgentToolInvokeResult = AgentToolInvokeFailure | AgentToolInvokeSuccess

export const AGENT_TOOL_GUIDE_RESOURCE = "https://0000.chat/mcp/resources/agent-tools-guide"
export const AGENT_TOOL_SESSION_CONTEXT_RESOURCE = "https://0000.chat/mcp/resources/session-context"
const DEFAULT_AGENT_TOOL_HTTP_TIMEOUT_MS = 30_000
const AGENT_TOOL_TIMEOUTS_MS: Partial<Record<AgentToolMcpToolName, number>> = {
  "databases.get": 20_000,
  "databases.listRows": 30_000,
  "databases.searchRows": 30_000,
  "messages.search": 30_000,
  "threads.list": 20_000,
}
const MAX_ERROR_TEXT_LENGTH = 280
const MAX_MCP_ERROR_JSON_LENGTH = 1_500

export function resolveAgentToolTimeoutMs(
  tool: string,
  options: AgentToolHttpInvokeOptions = {},
): number {
  if (options.timeoutMs !== undefined) {
    return Math.max(1, options.timeoutMs)
  }
  return Math.max(
    1,
    AGENT_TOOL_TIMEOUTS_MS[tool as AgentToolMcpToolName] ?? DEFAULT_AGENT_TOOL_HTTP_TIMEOUT_MS,
  )
}

const toolSchemas: Record<AgentToolMcpToolName, z.ZodRawShape> = {
  "userPrompts.requestChoice": {
    choices: z.array(
      z.object({
        description: z.string().optional(),
        id: z.string(),
        label: z.string(),
      }),
    ),
    prompt: z.string(),
  },
  "threads.list": { limit: z.number().optional() },
  "messages.search": {
    limit: z.number().optional(),
    query: z.string(),
    threadId: z.string().optional(),
  },
  "settings.setDefaultApprovalLevel": {
    approvalLevel: z.enum(["ask", "full_permissions"]).optional(),
  },
  "agents.list": { limit: z.number().optional(), query: z.string().optional() },
  "agents.sendMailboxMessage": {
    body: z.string(),
    maxHops: z.number().optional(),
    parentMailboxMessageId: z.string().optional(),
    responsePolicy: z.enum(["fire-and-forget", "reply-allowed", "reply-requested"]).optional(),
    subject: z.string(),
    toAgentIdOrSlug: z.string(),
  },
  "spaces.list": { includeArchived: z.boolean().optional(), limit: z.number().optional() },
  "spaces.get": { includeArchived: z.boolean().optional(), spaceIdOrSlug: z.string() },
  "spaces.create": {
    autoArchiveInactiveThreadsAfterHours: z.number().nullable().optional(),
    color: z.string().optional(),
    description: z.string().optional(),
    favorite: z.boolean().optional(),
    icon: z.string().optional(),
    systemPrompt: z.string().optional(),
    title: z.string(),
  },
  "spaces.update": {
    autoArchiveInactiveThreadsAfterHours: z.number().nullable().optional(),
    color: z.string().optional(),
    description: z.string().optional(),
    favorite: z.boolean().optional(),
    icon: z.string().optional(),
    spaceIdOrSlug: z.string(),
    systemPrompt: z.string().optional(),
    title: z.string().optional(),
  },
  "spaces.archive": { spaceIdOrSlug: z.string() },
  "spaces.unarchive": { spaceIdOrSlug: z.string() },
  "apps.list": {
    includeArchived: z.boolean().optional(),
    spaceIdOrSlug: z.string(),
  },
  "apps.get": {
    appIdOrSlug: z.string(),
    includeArchived: z.boolean().optional(),
    spaceIdOrSlug: z.string().optional(),
  },
  "apps.create": {
    designBrief: z.string().optional(),
    openuiRaw: z.string().optional(),
    prompt: z.string().optional(),
    spaceIdOrSlug: z.string(),
    title: z.string(),
  },
  "apps.createRevision": {
    appIdOrSlug: z.string(),
    designBrief: z.string().optional(),
    prompt: z.string(),
    spaceIdOrSlug: z.string().optional(),
    title: z.string().optional(),
  },
  "apps.generateFromRevision": {
    appIdOrSlug: z.string(),
    dataSnapshotSummary: z.string().optional(),
    openuiRaw: z.string(),
    revisionId: z.string().optional(),
    spaceIdOrSlug: z.string().optional(),
  },
  "apps.listGenerations": {
    appIdOrSlug: z.string(),
    limit: z.number().optional(),
    spaceIdOrSlug: z.string().optional(),
  },
  "apps.update": {
    appIdOrSlug: z.string(),
    openuiRaw: z.string().optional(),
    spaceIdOrSlug: z.string().optional(),
    title: z.string().optional(),
  },
  "apps.archive": {
    appIdOrSlug: z.string(),
    spaceIdOrSlug: z.string().optional(),
  },
  "apps.validateOpenUi": {
    openuiRaw: z.string(),
  },
  "automations.list": {
    includeDisabled: z.boolean().optional(),
    spaceIdOrSlug: z.string(),
  },
  "automations.get": {
    automationId: z.string(),
  },
  "automations.create": {
    agentId: z.string().optional(),
    agentIdOrSlug: z.string().optional(),
    name: z.string(),
    prompt: z.string(),
    schedule: z.union([
      z.object({ runAt: z.number(), type: z.literal("once") }),
      z.object({ intervalMs: z.number(), type: z.literal("interval") }),
      z.object({ cron: z.string(), timezone: z.string().optional(), type: z.literal("cron") }),
    ]),
    spaceIdOrSlug: z.string(),
    threadMode: z.enum(["new-thread", "reuse-thread"]).optional(),
  },
  "automations.update": {
    agentId: z.string().optional(),
    agentIdOrSlug: z.string().optional(),
    automationId: z.string(),
    enabled: z.boolean().optional(),
    name: z.string().optional(),
    prompt: z.string().optional(),
    schedule: z
      .union([
        z.object({ runAt: z.number(), type: z.literal("once") }),
        z.object({ intervalMs: z.number(), type: z.literal("interval") }),
        z.object({ cron: z.string(), timezone: z.string().optional(), type: z.literal("cron") }),
      ])
      .optional(),
    threadMode: z.enum(["new-thread", "reuse-thread"]).optional(),
  },
  "automations.disable": {
    automationId: z.string(),
  },
  "automations.runNow": {
    automationId: z.string(),
  },
  "databases.list": { includeArchived: z.boolean().optional() },
  "databases.get": { tableIdOrSlug: z.string() },
  "databases.listRows": {
    cursor: z.string().optional(),
    includeArchived: z.boolean().optional(),
    limit: z.number().optional(),
    tableIdOrSlug: z.string(),
  },
  "databases.getRow": { rowId: z.string() },
  "databases.searchRows": {
    limit: z.number().optional(),
    query: z.string(),
    searchFields: z.array(z.string()).optional(),
    tableIdOrSlug: z.string(),
  },
  "databases.create": {
    color: z.string().optional(),
    description: z.string().optional(),
    icon: z.string().optional(),
    name: z.string(),
  },
  "databases.createField": {
    attributeType: z.string(),
    displayName: z.string(),
    fieldKey: z.string(),
    tableId: z.string(),
  },
  "databases.createRow": {
    attributes: z.record(z.string(), z.unknown()).optional(),
    tableId: z.string(),
  },
  "databases.updateRow": {
    attributes: z.record(z.string(), z.unknown()),
    rowId: z.string(),
  },
  "databases.deleteRow": {
    permanent: z.boolean().optional(),
    rowId: z.string(),
  },
  "secrets.put": {
    name: z.string(),
    scope: z.enum(["user", "organization"]),
    value: z.string(),
  },
  "secrets.listAvailable": {
    query: z.string().optional(),
    scopes: z.array(z.enum(["user", "organization"])).optional(),
  },
  "scripts.createDraft": {
    code: z.string(),
    description: z.string(),
    kind: z.enum(["agent_skill", "app_script", "automation"]),
    manifest: z.record(z.string(), z.unknown()),
    name: z.string(),
    slug: z.string().optional(),
    spaceId: z.string().optional(),
  },
  "scripts.updateDraft": {
    code: z.string().optional(),
    description: z.string().optional(),
    manifest: z.record(z.string(), z.unknown()).optional(),
    name: z.string().optional(),
    scriptId: z.string(),
    slug: z.string().optional(),
  },
  "scripts.search": {
    query: z.string().optional(),
  },
  "scripts.read": {
    scriptId: z.string(),
  },
}

export const AGENT_TOOL_MCP_INPUT_SCHEMAS = Object.fromEntries(
  AGENT_TOOL_MCP_TOOL_NAMES.map((toolName) => [toolName, z.object(toolSchemas[toolName])]),
) as Record<AgentToolMcpToolName, z.ZodObject<z.ZodRawShape>>

const toolDescriptions: Record<AgentToolMcpToolName, string> = {
  "userPrompts.requestChoice":
    "Ask the user a structured multiple-choice question in the current 0000 Chat thread. Use this instead of printing a lettered list when you need the multiple-choice UI and decision-needed thread indicator.",
  "threads.list": "List recent 0000 Chat threads visible to this agent session.",
  "messages.search": "Search cached 0000 Chat messages.",
  "settings.setDefaultApprovalLevel":
    "Set the user's default approval mode. Use full_permissions only when the user explicitly asks to enable trusted local automation; this tool requires in-thread approval unless the current thread already has full permissions.",
  "agents.list":
    "List mailbox-capable agents in the current organization so you can address agent-to-agent handoffs by id or slug.",
  "agents.sendMailboxMessage":
    "Send a mailbox message from the current agent to another agent in the same organization. Use responsePolicy='fire-and-forget' for one-off handoffs, 'reply-allowed' when the recipient may answer, and 'reply-requested' when a reply is desired. Replies must pass parentMailboxMessageId and stay within maxHops; this records the handoff but does not automatically start another ACP session.",
  "spaces.list": "List spaces in 0000 Chat.",
  "spaces.get": "Read one 0000 Chat space by id or slug.",
  "spaces.create":
    "Create a 0000 Chat space. Optional autoArchiveInactiveThreadsAfterHours sets inactive-thread auto-archive hours; null disables it.",
  "spaces.update":
    "Update a 0000 Chat space. Optional autoArchiveInactiveThreadsAfterHours sets inactive-thread auto-archive hours; null disables it.",
  "spaces.archive": "Archive a 0000 Chat space.",
  "spaces.unarchive": "Restore an archived 0000 Chat space.",
  "apps.list": "List saved OpenUI apps for a 0000 Chat space.",
  "apps.get": "Read one saved OpenUI app by id or slug.",
  "apps.create":
    "Create a brand-new prompt-backed OpenUI app for a space. Required: spaceIdOrSlug and title. Include prompt with OpenUI AppCanvas instructions. Include openuiRaw only after validating actual generated OpenUI.",
  "apps.createRevision":
    "Create a new editable prompt revision for an existing app. Requires appIdOrSlug from apps.create, apps.list, or apps.get.",
  "apps.generateFromRevision":
    "Save generated OpenUI output for an existing app revision. Requires appIdOrSlug and actual openuiRaw rooted at AppCanvas; call apps.validateOpenUi first.",
  "apps.listGenerations": "List generated OpenUI outputs for a saved app.",
  "apps.update":
    "Legacy update for a saved OpenUI app title or raw OpenUI program. Prefer createRevision for prompt changes and generateFromRevision for generated output.",
  "apps.archive": "Archive a saved OpenUI app.",
  "apps.validateOpenUi":
    "Validate raw AppCanvas-rooted OpenUI app language before saving it.",
  "automations.list": "List scheduled agent automations for a 0000 Chat space.",
  "automations.get": "Read one scheduled agent automation and recent run history.",
  "automations.create":
    "Create a scheduled agent automation in a space. Schedules support once, interval, and cron.",
  "automations.update":
    "Update a scheduled agent automation's prompt, schedule, agent, thread mode, or enabled state.",
  "automations.disable": "Disable a scheduled agent automation and cancel future scheduled runs.",
  "automations.runNow": "Run a scheduled agent automation immediately.",
  "databases.list": "List 0000 Chat dynamic database tables.",
  "databases.get": "Read one 0000 Chat dynamic database table definition.",
  "databases.listRows": "List records in a 0000 Chat dynamic database table.",
  "databases.getRow": "Read one record from a 0000 Chat dynamic database table.",
  "databases.searchRows": "Search records in a 0000 Chat dynamic database table.",
  "databases.create":
    "Create a 0000 Chat dynamic database table. Optional icon and color match the space customization palette.",
  "databases.createField": "Create a field on a 0000 Chat dynamic database table.",
  "databases.createRow": "Create a record in a 0000 Chat dynamic database table.",
  "databases.updateRow": "Update a record in a 0000 Chat dynamic database table.",
  "databases.deleteRow":
    "Archive a record in a 0000 Chat dynamic database table, or permanently delete it when permanent is true.",
  "secrets.put":
    "Encrypt and store a 0000 Chat user or organization secret. The value is sent to 0000 Chat for encrypted storage and is redacted from approvals and tool logs.",
  "secrets.listAvailable":
    "List metadata for secrets available to generated scripts without revealing values.",
  "scripts.createDraft": "Create a reusable generated script draft and first version.",
  "scripts.updateDraft": "Update a reusable generated script draft by creating a new draft version.",
  "scripts.search": "Search reusable generated script artifacts in the current organization.",
  "scripts.read": "Read one reusable generated script artifact and its current version.",
}

export function buildAgentToolMcpEnv(env: NodeJS.ProcessEnv): AgentToolMcpEnv {
  return {
    appUrl: requiredEnv(env, "ZERO_CHAT_APP_URL"),
    bridgeToken: requiredEnv(env, "ZERO_CHAT_BRIDGE_TOKEN"),
    deviceId: requiredEnv(env, "ZERO_CHAT_BRIDGE_DEVICE_ID"),
    agentSessionId: requiredEnv(env, "ZERO_CHAT_AGENT_SESSION_ID"),
    threadId: optionalEnv(env, "ZERO_CHAT_THREAD_ID"),
    toolBaseUrl: optionalEnv(env, "ZERO_CHAT_AGENT_TOOLS_URL"),
  }
}

export async function invokeAgentToolOverHttp(
  env: AgentToolMcpEnv,
  tool: string,
  input: unknown,
  fetchImpl: AgentToolFetch = fetch,
  options: AgentToolHttpInvokeOptions = {},
): Promise<AgentToolInvokeResult | unknown> {
  const timeoutMs = resolveAgentToolTimeoutMs(tool, options)
  const abortController = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        abortController.abort()
        reject(new Error(`Agent tool request timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    })
    const requestPromise = (async () => {
      const response = await fetchImpl(buildEndpoint(env.toolBaseUrl ?? env.appUrl, "/api/agent-tools/invoke"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.bridgeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agentSessionId: env.agentSessionId,
          deviceId: env.deviceId,
          input,
          threadId: env.threadId,
          tool,
        }),
        signal: abortController.signal,
      })
      if (!response.ok) {
        return buildAgentToolInvokeFailure({
          error: `Agent tool request failed with HTTP ${response.status}`,
          httpStatus: response.status,
          reasonCode: "HTTP_ERROR",
          retryable: response.status >= 500 || response.status === 429,
          tool,
        })
      }
      const text = await response.text()
      let payload: unknown = {}
      if (text) {
        try {
          payload = JSON.parse(text)
        } catch {
          return buildAgentToolInvokeFailure({
            error: "Agent tool response was not valid JSON",
            reasonCode: "INVALID_JSON",
            tool,
          })
        }
      }
      if (isErrorPayload(payload)) {
        return buildAgentToolInvokeFailure({
          error: payload.error,
          reasonCode: "APP_ERROR",
          retryable: typeof payload.retryable === "boolean" ? payload.retryable : undefined,
          tool,
        })
      }
      return payload
    })()
    return await Promise.race([requestPromise, timeoutPromise])
  } catch (error) {
    if (abortController.signal.aborted) {
      return buildAgentToolInvokeFailure({
        error: `Agent tool request timed out after ${timeoutMs}ms`,
        reasonCode: "TOOL_TIMEOUT",
        retryable: true,
        safeToRetry: true,
        timeoutMs,
        tool,
      })
    }
    return buildAgentToolInvokeFailure({
      error: error instanceof Error ? error.message : String(error),
      reasonCode: "FETCH_ERROR",
      retryable: true,
      tool,
    })
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

export function toMcpToolResult(result: unknown) {
  const record = result && typeof result === "object" ? (result as { ok?: unknown }) : undefined
  const text =
    record?.ok === false
      ? JSON.stringify(boundToolFailureForMcp(result), null, 2)
      : JSON.stringify(result, null, 2)
  return {
    content: [{ type: "text" as const, text }],
    ...(record?.ok === false ? { isError: true } : {}),
  }
}

export function buildAgentToolGuideText(): string {
  return buildZeroChatMcpGuideText()
}

export function buildAgentToolSessionContextText(env: AgentToolMcpEnv): string {
  const currentThreadLine = env.threadId ? `currentThreadId: ${env.threadId}\n` : ""
  return `app: 0000-chat
agentSessionId: ${env.agentSessionId}
${currentThreadLine}bridgeDeviceId: ${env.deviceId}
appUrl: ${env.appUrl}
mcpServer: 0000
toolGuide: ${AGENT_TOOL_GUIDE_RESOURCE}`
}

export function createAgentToolsMcpServer(env: AgentToolMcpEnv): McpServer {
  const server = new McpServer({ name: "0000-agent-tools", version: "0.1.0" })

  server.registerResource(
    "0000 Chat agent tool guide",
    AGENT_TOOL_GUIDE_RESOURCE,
    {
      description: "How agents should interpret 0000 Chat context and use app MCP tools.",
      mimeType: "text/plain",
    },
    async () => ({
      contents: [{ text: buildAgentToolGuideText(), uri: AGENT_TOOL_GUIDE_RESOURCE }],
    }),
  )

  server.registerResource(
    "0000 Chat session context",
    AGENT_TOOL_SESSION_CONTEXT_RESOURCE,
    {
      description: "Current 0000 Chat MCP bridge/session context.",
      mimeType: "text/plain",
    },
    async () => ({
      contents: [
        {
          text: buildAgentToolSessionContextText(env),
          uri: AGENT_TOOL_SESSION_CONTEXT_RESOURCE,
        },
      ],
    }),
  )

  for (const toolName of AGENT_TOOL_MCP_TOOL_NAMES) {
    server.registerTool(
      toolName,
      {
        description: toolDescriptions[toolName],
        inputSchema: toolSchemas[toolName],
      },
      async (input) => {
        try {
          return toMcpToolResult(await invokeAgentToolOverHttp(env, toolName, input))
        } catch (error) {
          return toMcpToolResult(
            buildAgentToolInvokeFailure({
              error: error instanceof Error ? error.message : String(error),
              reasonCode: "FETCH_ERROR",
              retryable: false,
              tool: toolName,
            }),
          )
        }
      },
    )
  }

  return server
}

async function main() {
  const env = buildAgentToolMcpEnv(process.env)
  const server = createAgentToolsMcpServer(env)
  await server.connect(new StdioServerTransport())
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim()
  return value ? value : undefined
}

function buildEndpoint(baseUrl: string, path: string): string {
  const url = new URL(baseUrl)
  url.pathname = path
  url.search = ""
  url.hash = ""
  return url.toString()
}

function buildAgentToolInvokeFailure(
  failure: Omit<AgentToolInvokeFailure, "ok">,
): AgentToolInvokeFailure {
  return {
    ok: false,
    ...failure,
    error: sanitizeErrorText(failure.error),
  }
}

function sanitizeErrorText(input: string): string {
  const redacted = input
    .replace(/authorization\s*:\s*[^\s,]+/gi, "authorization: [redacted]")
    .replace(/bearer\s+[^\s,]+/gi, "Bearer [redacted]")
    .replace(/(bridgeToken|token|authToken|authorization)["']?\s*[:=]\s*["'][^"']+["']/gi, "$1: [redacted]")
    .replace(/\s+/g, " ")
    .trim()

  if (redacted.length <= MAX_ERROR_TEXT_LENGTH) {
    return redacted
  }
  return `${redacted.slice(0, MAX_ERROR_TEXT_LENGTH - 12).trimEnd()} [truncated]`
}

function boundToolFailureForMcp(result: unknown): AgentToolInvokeFailure {
  const failure = (result ?? {}) as Partial<AgentToolInvokeFailure>
  const bounded: AgentToolInvokeFailure = {
    error: sanitizeErrorText(typeof failure.error === "string" ? failure.error : "Agent tool request failed"),
    ok: false,
    reasonCode: failure.reasonCode ?? "APP_ERROR",
    ...(typeof failure.retryable === "boolean" ? { retryable: failure.retryable } : {}),
    ...(typeof failure.safeToRetry === "boolean" ? { safeToRetry: failure.safeToRetry } : {}),
    ...(typeof failure.timeoutMs === "number" ? { timeoutMs: failure.timeoutMs } : {}),
    ...(typeof failure.httpStatus === "number" ? { httpStatus: failure.httpStatus } : {}),
    ...(typeof failure.tool === "string" ? { tool: failure.tool } : {}),
  }
  let text = JSON.stringify(bounded, null, 2)
  if (text.length <= MAX_MCP_ERROR_JSON_LENGTH) {
    return bounded
  }
  bounded.error = sanitizeErrorText(bounded.error.slice(0, MAX_ERROR_TEXT_LENGTH / 2))
  text = JSON.stringify(bounded, null, 2)
  if (text.length <= MAX_MCP_ERROR_JSON_LENGTH) {
    return bounded
  }
  return {
    error: "Agent tool request failed [truncated]",
    ok: false,
    reasonCode: bounded.reasonCode,
    ...(typeof bounded.tool === "string" ? { tool: bounded.tool } : {}),
  }
}

function isErrorPayload(payload: unknown): payload is { error: string; ok?: false; retryable?: boolean } {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof (payload as { error?: unknown }).error === "string" &&
      (!("ok" in payload) || (payload as { ok?: unknown }).ok === false),
  )
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
