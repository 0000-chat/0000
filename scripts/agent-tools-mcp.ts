#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod/v4"

import { AGENT_TOOL_MANIFEST_SNAPSHOT } from "./agent-tool-manifest-snapshot"
import {
  ACTIONS_RUNTIME_FEATURE_FLAG_KEY,
  ARTIFACTS_FEATURE_FLAG_KEY,
  type ZeroChatPolicyOptions,
} from "./acp-bridge/zero-chat-policy"

export { ACTIONS_RUNTIME_FEATURE_FLAG_KEY, ARTIFACTS_FEATURE_FLAG_KEY }

export const AGENT_TOOL_MCP_MANIFEST = AGENT_TOOL_MANIFEST_SNAPSHOT.AGENT_TOOL_MANIFEST
export const AGENT_TOOL_MCP_TOOL_NAMES = AGENT_TOOL_MANIFEST_SNAPSHOT.AGENT_TOOL_MANIFEST_NAMES
export const AGENT_TOOL_CAPABILITY_PACKS = AGENT_TOOL_MANIFEST_SNAPSHOT.AGENT_TOOL_CAPABILITY_PACKS
export const AGENT_TOOL_CAPABILITY_PACK_ORDER = AGENT_TOOL_MANIFEST_SNAPSHOT.AGENT_TOOL_CAPABILITY_PACK_ORDER

export type AgentToolMcpToolName = (typeof AGENT_TOOL_MCP_TOOL_NAMES)[number]
type AgentToolCapabilityPackName = (typeof AGENT_TOOL_CAPABILITY_PACK_ORDER)[number]
type AgentToolSurface = "thread" | "space" | "database" | "app" | "automation" | "settings" | "action"
type FeatureFlagKey = typeof ARTIFACTS_FEATURE_FLAG_KEY | typeof ACTIONS_RUNTIME_FEATURE_FLAG_KEY
type AgentToolInputSchemaField =
  | { kind: "array"; items: AgentToolInputSchemaField; nullable?: true; optional?: true; sensitive?: true }
  | { kind: "boolean"; nullable?: true; optional?: true; sensitive?: true }
  | { kind: "enum"; values: readonly string[]; nullable?: true; optional?: true; sensitive?: true }
  | { kind: "literal"; value: string | number | boolean; nullable?: true; optional?: true; sensitive?: true }
  | { kind: "number"; nullable?: true; optional?: true; sensitive?: true }
  | { kind: "object"; fields: AgentToolInputSchema; nullable?: true; optional?: true; sensitive?: true }
  | { kind: "record"; value: AgentToolInputSchemaField; nullable?: true; optional?: true; sensitive?: true }
  | { kind: "string"; nullable?: true; optional?: true; sensitive?: true }
  | { kind: "union"; options: readonly AgentToolInputSchemaField[]; nullable?: true; optional?: true; sensitive?: true }
  | { kind: "unknown"; nullable?: true; optional?: true; sensitive?: true }
type AgentToolInputSchema = Record<string, AgentToolInputSchemaField>
type AgentToolManifestEntry = {
  annotations: Record<string, boolean>
  approvalBehavior: string
  capabilityPack: AgentToolCapabilityPackName
  description: string
  effect: string
  featureFlagKey?: FeatureFlagKey
  inputSchema: AgentToolInputSchema
  risk: string
  surfaces?: readonly AgentToolSurface[]
  visibility: "core" | "deferred" | "surface-scoped"
}
type AgentToolMcpEnv = {
  activeToolSurfaces?: readonly AgentToolSurface[]
  agentSessionId: string
  appUrl: string
  bridgeToken: string
  deviceId: string
  enabledFeatureFlags?: readonly FeatureFlagKey[]
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
  | "TIMEOUT"
type AgentToolInvokeFailure = {
  ok: false
  error: string
  reasonCode: AgentToolInvokeFailureReasonCode
  retryable?: boolean
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
export const AGENT_TOOL_CAPABILITY_PACKS_RESOURCE = "https://0000.chat/mcp/resources/capabilities/packs"
export const CAPABILITY_PACKS_RESOURCE = AGENT_TOOL_CAPABILITY_PACKS_RESOURCE
export const AGENT_TOOL_TOOL_ROUTING_GUIDE_RESOURCE = "https://0000.chat/mcp/resources/capabilities/tool-routing-guide"
export const AGENT_TOOL_CORE_CAPABILITY_RESOURCE = "https://0000.chat/mcp/resources/capabilities/core"
export const AGENT_TOOL_CAPABILITY_PACK_RESOURCE_BASE = "https://0000.chat/mcp/resources/capabilities/pack/"
const DEFAULT_AGENT_TOOL_HTTP_TIMEOUT_MS = 30_000
const MAX_ERROR_TEXT_LENGTH = 280
const MAX_MCP_ERROR_JSON_LENGTH = 1_500
const DEFINED_FEATURE_FLAGS = new Set<string>([ARTIFACTS_FEATURE_FLAG_KEY, ACTIONS_RUNTIME_FEATURE_FLAG_KEY])
const AGENT_TOOL_MCP_SURFACES = [
  "thread",
  "space",
  "database",
  "app",
  "automation",
  "settings",
  "action",
] as const satisfies readonly AgentToolSurface[]

function getToolManifestEntry(toolName: AgentToolMcpToolName): AgentToolManifestEntry {
  return AGENT_TOOL_MCP_MANIFEST[toolName] as unknown as AgentToolManifestEntry
}

function toZodField(field: AgentToolInputSchemaField): z.ZodType {
  let schema: z.ZodType
  switch (field.kind) {
    case "array":
      schema = z.array(toZodField(field.items as AgentToolInputSchemaField))
      break
    case "boolean":
      schema = z.boolean()
      break
    case "enum":
      schema = z.enum(field.values as [string, ...string[]])
      break
    case "literal":
      schema = z.literal(field.value)
      break
    case "number":
      schema = z.number()
      break
    case "object":
      schema = z.object(toZodRawShape(field.fields as AgentToolInputSchema))
      break
    case "record":
      schema = z.record(z.string(), toZodField(field.value as AgentToolInputSchemaField))
      break
    case "string":
      schema = z.string()
      break
    case "union":
      schema = z.union(field.options.map((option) => toZodField(option as AgentToolInputSchemaField)) as [z.ZodType, z.ZodType, ...z.ZodType[]])
      break
    case "unknown":
      schema = z.unknown()
      break
  }
  if ("nullable" in field && field.nullable) schema = schema.nullable()
  if ("optional" in field && field.optional) schema = schema.optional()
  return schema
}

function toZodRawShape(inputSchema: AgentToolInputSchema): z.ZodRawShape {
  return Object.fromEntries(
    Object.entries(inputSchema).map(([fieldName, field]) => [fieldName, toZodField(field as AgentToolInputSchemaField)]),
  )
}

export function buildAgentToolMcpInputSchemas(): Record<AgentToolMcpToolName, z.ZodRawShape> {
  return Object.fromEntries(
    AGENT_TOOL_MCP_TOOL_NAMES.map((toolName) => [
      toolName,
      toZodRawShape(getToolManifestEntry(toolName).inputSchema),
    ]),
  ) as Record<AgentToolMcpToolName, z.ZodRawShape>
}

const toolSchemas = buildAgentToolMcpInputSchemas()
export const AGENT_TOOL_MCP_INPUT_SCHEMAS = Object.fromEntries(
  AGENT_TOOL_MCP_TOOL_NAMES.map((toolName) => [toolName, z.object(toolSchemas[toolName])]),
) as Record<AgentToolMcpToolName, z.ZodObject<z.ZodRawShape>>

export function getAgentToolCapabilityPackName(toolName: AgentToolMcpToolName): AgentToolCapabilityPackName {
  const domain = toolName.split(".")[0]
  if (getToolManifestEntry(toolName).visibility === "core") return "core"
  if (domain === "databaseViews" || domain === "databases") return "databases"
  if (domain === "bridgeDevices" || domain === "notifications") return "runtime"
  if (domain === "messages" || domain === "tags" || domain === "threads") return "threads"
  return getToolManifestEntry(toolName).capabilityPack as AgentToolCapabilityPackName
}

export function buildAgentToolMcpRegistrationMetadata(
  toolName: AgentToolMcpToolName,
  inputSchemas: Record<AgentToolMcpToolName, z.ZodRawShape> = toolSchemas,
) {
  const tool = getToolManifestEntry(toolName)
  return {
    annotations: tool.annotations,
    description: `${tool.description}\n\nCapability pack: ${getAgentToolCapabilityPackName(toolName)}. Effect: ${tool.effect}. Approval: ${tool.approvalBehavior}. Visibility: ${tool.visibility}.`,
    inputSchema: inputSchemas[toolName],
  }
}

export function buildCapabilityPackResourceUri(packName: AgentToolCapabilityPackName): string {
  return packName === "core" ? AGENT_TOOL_CORE_CAPABILITY_RESOURCE : `${AGENT_TOOL_CAPABILITY_PACK_RESOURCE_BASE}${packName}`
}

function toolNamesForPack(
  packName: AgentToolCapabilityPackName,
  enabledFeatureFlags: readonly FeatureFlagKey[] = [],
): AgentToolMcpToolName[] {
  return filterAgentToolNamesForFeatureFlags(AGENT_TOOL_MCP_TOOL_NAMES, enabledFeatureFlags).filter(
    (toolName) => getAgentToolCapabilityPackName(toolName) === packName,
  )
}

function filterAgentToolNamesForFeatureFlags<T extends AgentToolMcpToolName>(
  toolNames: readonly T[],
  enabledFeatureFlags: readonly FeatureFlagKey[] = [],
): T[] {
  return toolNames.filter((toolName) => {
    const featureFlagKey = getToolManifestEntry(toolName).featureFlagKey as FeatureFlagKey | undefined
    return !featureFlagKey || enabledFeatureFlags.includes(featureFlagKey)
  })
}

export function buildCapabilityPacksText(options: { enabledFeatureFlags?: readonly FeatureFlagKey[] } = {}): string {
  return `# 0000 Chat MCP capability packs

Default core stays intentionally small. Activate contextual surfaces with ZERO_CHAT_ACTIVE_TOOL_SURFACES only when the user intent or active surface needs them.

${AGENT_TOOL_CAPABILITY_PACK_ORDER.map((packName) => {
  const pack = AGENT_TOOL_CAPABILITY_PACKS[packName]
  return `- ${pack.name}: ${pack.title}; visibility=${pack.defaultVisibility}; contexts=${pack.contexts.join(",") || "any"}; tools=${toolNamesForPack(packName, options.enabledFeatureFlags).join(", ") || "none"}; resource=${buildCapabilityPackResourceUri(packName)}`
}).join("\n")}

Legacy/confusing routing: apps.update is legacy; use apps.createRevision and apps.generateFromRevision for prompt-backed app work. messages.search is for cross-thread/cached-message search, not current-thread continuity. Low-level artifact upload/version tools belong in the artifacts pack, not normal app-building flow. Admin/security tools are contextual and not default-visible.`
}

export function buildCapabilityPackText(
  packName: AgentToolCapabilityPackName,
  options: { enabledFeatureFlags?: readonly FeatureFlagKey[] } = {},
): string {
  const pack = AGENT_TOOL_CAPABILITY_PACKS[packName]
  const tools = toolNamesForPack(packName, options.enabledFeatureFlags)
    .map((toolName) => {
      const tool = getToolManifestEntry(toolName)
      return `- ${toolName}: effect=${tool.effect}; approval=${tool.approvalBehavior}; visibility=${tool.visibility}; contexts=${tool.surfaces?.join(",") ?? "any"}; ${tool.description}`
    })
    .join("\n")
  return `# ${pack.title}
pack: ${pack.name}
defaultVisibility: ${pack.defaultVisibility}
contexts: ${pack.contexts.join(",") || "any"}
effectTypes: ${pack.effectTypes.join(",") || "read"}
approvalBehavior: ${pack.approvalBehavior}

${pack.description}

When to use: ${pack.whenToUse}
When not to use: ${pack.whenNotToUse}

Tools:
${tools || "(No tools available with current feature flags.)"}`
}

export function buildToolRoutingGuideText(options: { enabledFeatureFlags?: readonly FeatureFlagKey[] } = {}): string {
  return `# 0000 Chat MCP tool routing guide

Start with core: context.get, threads.current, threads.read, objects.*, capabilities.describe, capabilities.advise, and userPrompts.requestChoice.

- Current-thread continuity: use context.get or threads.current, then threads.read. Do not use messages.search for revive/resume/compaction continuity.
- Durable activity and memory: use threads.readActivity for bounded event detail; use threads.contextList/contextDescribe/contextExpand for lossless context memory before broad search.
- Cross-thread search: use messages.search only when the user asks to search messages/history or you need cached-message retrieval beyond the current thread.
- Thread writes: use threads.create for new threads, threads.continue for agent-authored continuation/handoff without faking a user message, and threads.fork for safe branched work.
- Tags: use tags.* for org-scoped thread/artifact/database tagging.
- Apps: use apps.create for a new prompt-backed app, validate OpenUI with apps.validateOpenUi, then save with apps.generateFromRevision. For existing apps use apps.get/list, apps.createRevision, apps.validateOpenUi, and apps.generateFromRevision. Do not use apps.update for prompt-backed app creation or edits.
- Databases: inspect existing tables with databases.list/get and saved views with databaseViews.* before creating schema; use rows for reusable structured data and app inputs, not one-off facts; use relationship tools for true related records instead of raw row-id fields.
- Automations: use only for explicit reminders, schedules, loops, or run management; writes may need approval.
- Actions: use actions.* for first-class reusable runnable code and metadata; actions.run is feature-flagged and executes code through the Actions runtime.
- Artifacts: use for durable docs/files/reports. Low-level createUploadIntent/completeUpload is for large R2-backed bytes after upload, not routine app creation.
- Runtime: bridgeDevices and notification runtime tools are contextual; do not restart/update devices without explicit user intent.
- Admin/security: secrets and default approval settings are contextual. settings.setDefaultApprovalLevel is an explicit trust-boundary operation.

Available packs now: ${AGENT_TOOL_CAPABILITY_PACK_ORDER.filter((packName) => toolNamesForPack(packName, options.enabledFeatureFlags).length > 0).join(", ")}.`
}

export function parseAgentToolMcpSurfaces(value: string | undefined): AgentToolSurface[] {
  if (!value?.trim()) return []
  const allowedSurfaces = new Set<string>(AGENT_TOOL_MCP_SURFACES)
  const activeSurfaces: AgentToolSurface[] = []
  for (const rawSurface of value.split(",")) {
    const surface = rawSurface.trim()
    if (!surface) continue
    if (!allowedSurfaces.has(surface)) continue
    if (!activeSurfaces.includes(surface as AgentToolSurface)) activeSurfaces.push(surface as AgentToolSurface)
  }
  return activeSurfaces
}

export function parseAgentToolMcpFeatureFlags(value: string | undefined): FeatureFlagKey[] {
  if (!value?.trim()) return []
  const featureFlags: FeatureFlagKey[] = []
  for (const rawFeatureFlag of value.split(",")) {
    const featureFlag = rawFeatureFlag.trim().toLowerCase()
    if (!featureFlag) continue
    if (!DEFINED_FEATURE_FLAGS.has(featureFlag)) continue
    if (!featureFlags.includes(featureFlag as FeatureFlagKey)) featureFlags.push(featureFlag as FeatureFlagKey)
  }
  return featureFlags
}

export function getVisibleAgentToolMcpToolNames(
  activeToolSurfaces: readonly AgentToolSurface[] = [],
  enabledFeatureFlags: readonly FeatureFlagKey[] = [],
): AgentToolMcpToolName[] {
  const activeSurfaceSet = new Set<AgentToolSurface>(activeToolSurfaces)
  return filterAgentToolNamesForFeatureFlags(AGENT_TOOL_MCP_TOOL_NAMES, enabledFeatureFlags).filter((toolName) => {
    const tool = getToolManifestEntry(toolName)
    if (tool.visibility === "core") return true
    if (tool.visibility !== "surface-scoped") return false
    return tool.surfaces?.some((surface) => activeSurfaceSet.has(surface as AgentToolSurface)) ?? false
  })
}

export function buildAgentToolMcpEnv(env: NodeJS.ProcessEnv): AgentToolMcpEnv {
  return {
    activeToolSurfaces: parseAgentToolMcpSurfaces(env.ZERO_CHAT_ACTIVE_TOOL_SURFACES),
    appUrl: requiredEnv(env, "ZERO_CHAT_APP_URL"),
    bridgeToken: requiredEnv(env, "ZERO_CHAT_BRIDGE_TOKEN"),
    deviceId: requiredEnv(env, "ZERO_CHAT_BRIDGE_DEVICE_ID"),
    enabledFeatureFlags: parseAgentToolMcpFeatureFlags(env.ZERO_CHAT_ENABLED_FEATURE_FLAGS),
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
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_AGENT_TOOL_HTTP_TIMEOUT_MS)
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
        reasonCode: "TIMEOUT",
        retryable: true,
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
  const text = record?.ok === false ? JSON.stringify(boundToolFailureForMcp(result), null, 2) : JSON.stringify(result, null, 2)
  return {
    content: [{ type: "text" as const, text }],
    ...(record?.ok === false ? { isError: true } : {}),
  }
}

export function buildAgentToolGuideText(options: ZeroChatPolicyOptions = {}): string {
  const featureFlags = parseFeatureFlagArray(options.enabledFeatureFlags)
  return `You are operating inside 0000 Chat.

Use the 0000 MCP server for 0000 Chat data and actions. The default public bridge tool surface is intentionally small: core tools are always visible, and contextual tools appear when ZERO_CHAT_ACTIVE_TOOL_SURFACES includes their surface (thread, space, database, app, automation, settings, action).

Core tools: ${getVisibleAgentToolMcpToolNames([], featureFlags).join(", ")}.

Capability packs and routing resources:
- ${AGENT_TOOL_CAPABILITY_PACKS_RESOURCE}
- ${AGENT_TOOL_TOOL_ROUTING_GUIDE_RESOURCE}
- ${AGENT_TOOL_CAPABILITY_PACK_ORDER.map(buildCapabilityPackResourceUri).join("\n- ")}

${buildToolRoutingGuideText({ enabledFeatureFlags: featureFlags })}

${buildCapabilityPacksText({ enabledFeatureFlags: featureFlags })}

Never request raw Convex credentials, user cookies, direct database access, GitHub tokens, OAuth credentials, cookies, or personal access tokens. Read tools are scoped to the signed-in user's accessible 0000 Chat data. Write tools may require user approval; when approval is needed, tell the user approval is needed and wait for the app flow.`
}

export function buildAgentToolSessionContextText(env: AgentToolMcpEnv): string {
  const currentThreadLine = env.threadId ? `currentThreadId: ${env.threadId}\n` : ""
  const activeToolSurfaces = env.activeToolSurfaces?.length ? env.activeToolSurfaces.join(",") : "(core only)"
  const enabledFeatureFlags = env.enabledFeatureFlags?.length ? env.enabledFeatureFlags.join(",") : "(none)"
  return `app: 0000-chat
agentSessionId: ${env.agentSessionId}
${currentThreadLine}bridgeDeviceId: ${env.deviceId}
appUrl: ${env.appUrl}
mcpServer: 0000
activeToolSurfaces: ${activeToolSurfaces}
enabledFeatureFlags: ${enabledFeatureFlags}
toolGuide: ${AGENT_TOOL_GUIDE_RESOURCE}`
}

export function createAgentToolsMcpServer(env: AgentToolMcpEnv): McpServer {
  const server = new McpServer({ name: "0000-agent-tools", version: "0.1.0" })
  const inputSchemas = buildAgentToolMcpInputSchemas()

  server.registerResource(
    "0000 Chat agent tool guide",
    AGENT_TOOL_GUIDE_RESOURCE,
    { description: "How agents should interpret 0000 Chat context and use app MCP tools.", mimeType: "text/plain" },
    async () => ({ contents: [{ text: buildAgentToolGuideText({ enabledFeatureFlags: env.enabledFeatureFlags }), uri: AGENT_TOOL_GUIDE_RESOURCE }] }),
  )

  server.registerResource(
    "0000 Chat session context",
    AGENT_TOOL_SESSION_CONTEXT_RESOURCE,
    { description: "Current 0000 Chat MCP bridge/session context.", mimeType: "text/plain" },
    async () => ({ contents: [{ text: buildAgentToolSessionContextText(env), uri: AGENT_TOOL_SESSION_CONTEXT_RESOURCE }] }),
  )

  server.registerResource(
    "0000 Chat capability packs",
    AGENT_TOOL_CAPABILITY_PACKS_RESOURCE,
    { description: "Passive guide to 0000 Chat MCP capability packs and contextual tool namespaces.", mimeType: "text/plain" },
    async () => ({ contents: [{ text: buildCapabilityPacksText({ enabledFeatureFlags: env.enabledFeatureFlags }), uri: AGENT_TOOL_CAPABILITY_PACKS_RESOURCE }] }),
  )

  server.registerResource(
    "0000 Chat tool routing guide",
    AGENT_TOOL_TOOL_ROUTING_GUIDE_RESOURCE,
    { description: "Routing guidance for choosing core tools versus contextual MCP capability packs.", mimeType: "text/plain" },
    async () => ({ contents: [{ text: buildToolRoutingGuideText({ enabledFeatureFlags: env.enabledFeatureFlags }), uri: AGENT_TOOL_TOOL_ROUTING_GUIDE_RESOURCE }] }),
  )

  for (const packName of AGENT_TOOL_CAPABILITY_PACK_ORDER) {
    const uri = buildCapabilityPackResourceUri(packName)
    server.registerResource(
      `0000 Chat ${packName} capability pack`,
      uri,
      { description: `Passive guidance and tools for the ${packName} 0000 Chat MCP capability pack.`, mimeType: "text/plain" },
      async () => ({ contents: [{ text: buildCapabilityPackText(packName, { enabledFeatureFlags: env.enabledFeatureFlags }), uri }] }),
    )
  }

  for (const toolName of getVisibleAgentToolMcpToolNames(env.activeToolSurfaces, env.enabledFeatureFlags)) {
    server.registerTool(toolName, buildAgentToolMcpRegistrationMetadata(toolName, inputSchemas), async (input) => {
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
    })
  }

  return server
}

async function main() {
  const env = buildAgentToolMcpEnv(process.env)
  const server = createAgentToolsMcpServer(env)
  await server.connect(new StdioServerTransport())
}

function parseFeatureFlagArray(value: readonly string[] | undefined): FeatureFlagKey[] {
  return (value ?? []).filter((featureFlag): featureFlag is FeatureFlagKey => DEFINED_FEATURE_FLAGS.has(featureFlag))
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
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

function buildAgentToolInvokeFailure(failure: Omit<AgentToolInvokeFailure, "ok">): AgentToolInvokeFailure {
  return { ok: false, ...failure, error: sanitizeErrorText(failure.error) }
}

function sanitizeErrorText(input: string): string {
  const redacted = input
    .replace(/authorization\s*:\s*[^\s,]+/gi, "authorization: [redacted]")
    .replace(/bearer\s+[^\s,]+/gi, "Bearer [redacted]")
    .replace(/(bridgeToken|token|authToken|authorization)["']?\s*[:=]\s*["'][^"']+["']/gi, "$1: [redacted]")
    .replace(/\s+/g, " ")
    .trim()
  return redacted.length <= MAX_ERROR_TEXT_LENGTH ? redacted : `${redacted.slice(0, MAX_ERROR_TEXT_LENGTH - 12).trimEnd()} [truncated]`
}

function boundToolFailureForMcp(result: unknown): AgentToolInvokeFailure {
  const failure = (result ?? {}) as Partial<AgentToolInvokeFailure>
  const bounded: AgentToolInvokeFailure = {
    error: sanitizeErrorText(typeof failure.error === "string" ? failure.error : "Agent tool request failed"),
    ok: false,
    reasonCode: failure.reasonCode ?? "APP_ERROR",
    ...(typeof failure.retryable === "boolean" ? { retryable: failure.retryable } : {}),
    ...(typeof failure.timeoutMs === "number" ? { timeoutMs: failure.timeoutMs } : {}),
    ...(typeof failure.httpStatus === "number" ? { httpStatus: failure.httpStatus } : {}),
    ...(typeof failure.tool === "string" ? { tool: failure.tool } : {}),
  }
  let text = JSON.stringify(bounded, null, 2)
  if (text.length <= MAX_MCP_ERROR_JSON_LENGTH) return bounded
  bounded.error = sanitizeErrorText(bounded.error.slice(0, MAX_ERROR_TEXT_LENGTH / 2))
  text = JSON.stringify(bounded, null, 2)
  if (text.length <= MAX_MCP_ERROR_JSON_LENGTH) return bounded
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
