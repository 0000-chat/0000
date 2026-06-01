#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod/v4"

import { buildZeroChatMcpGuideText } from "./hermes-bridge/zero-chat-policy"

export const AGENT_TOOL_MCP_TOOL_NAMES = [
  "userPrompts.requestChoice",
  "threads.current",
  "threads.list",
  "threads.read",
  "messages.search",
  "settings.setDefaultApprovalLevel",
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

export const AGENT_TOOL_GUIDE_RESOURCE = "https://0000.chat/mcp/resources/agent-tools-guide"
export const AGENT_TOOL_SESSION_CONTEXT_RESOURCE = "https://0000.chat/mcp/resources/session-context"

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
  "threads.current": {},
  "threads.list": { limit: z.number().optional() },
  "threads.read": { threadId: z.string() },
  "messages.search": {
    limit: z.number().optional(),
    query: z.string(),
    threadId: z.string().optional(),
  },
  "settings.setDefaultApprovalLevel": {
    approvalLevel: z.enum(["ask", "full_permissions"]).optional(),
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
}

const toolDescriptions: Record<AgentToolMcpToolName, string> = {
  "userPrompts.requestChoice":
    "Ask the user a structured multiple-choice question in the current 0000 Chat thread. Use this instead of printing a lettered list when you need the multiple-choice UI and decision-needed thread indicator.",
  "threads.current":
    "Read the exact current 0000 Chat thread, space, agent session, recent messages, and continuity identity for this agent run. Prefer this before threads.list for continue/resume/remember prompts.",
  "threads.list": "List recent 0000 Chat threads visible to this agent session.",
  "threads.read": "Read one 0000 Chat thread and its cached messages.",
  "messages.search": "Search cached 0000 Chat messages.",
  "settings.setDefaultApprovalLevel":
    "Set the user's default approval mode. Use full_permissions only when the user explicitly asks to enable trusted local automation; this tool requires in-thread approval unless the current thread already has full permissions.",
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
): Promise<unknown> {
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
  })
  const text = await response.text()
  const payload = text ? JSON.parse(text) : {}
  if (!response.ok) {
    return { error: payload.error ?? (text || "Agent tool request failed"), ok: false }
  }
  return payload
}

export function toMcpToolResult(result: unknown) {
  const record = result && typeof result === "object" ? (result as { ok?: unknown }) : undefined
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
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
mcpServer: 0000-chat
currentThreadTool: threads.current
toolGuide: ${AGENT_TOOL_GUIDE_RESOURCE}`
}

export function createAgentToolsMcpServer(env: AgentToolMcpEnv): McpServer {
  const server = new McpServer({ name: "0000-chat-agent-tools", version: "0.1.0" })

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
      async (input) => toMcpToolResult(await invokeAgentToolOverHttp(env, toolName, input)),
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

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
