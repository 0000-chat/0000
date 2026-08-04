#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod/v4"

import { AGENT_TOOL_MANIFEST_SNAPSHOT } from "./agent-tool-manifest-snapshot"
import {
  ACTIONS_RUNTIME_FEATURE_FLAG_KEY,
  ARTIFACTS_FEATURE_FLAG_KEY,
  REACT_CODE_APPS_FEATURE_FLAG_KEY,
  type ZeroChatPolicyOptions,
} from "./acp-bridge/zero-chat-policy"

export {
  ACTIONS_RUNTIME_FEATURE_FLAG_KEY,
  ARTIFACTS_FEATURE_FLAG_KEY,
  REACT_CODE_APPS_FEATURE_FLAG_KEY,
}

export const AGENT_TOOL_MCP_MANIFEST = AGENT_TOOL_MANIFEST_SNAPSHOT.AGENT_TOOL_MANIFEST
export const AGENT_TOOL_MCP_TOOL_NAMES = AGENT_TOOL_MANIFEST_SNAPSHOT.AGENT_TOOL_MANIFEST_NAMES
export const AGENT_TOOL_CAPABILITY_PACKS = AGENT_TOOL_MANIFEST_SNAPSHOT.AGENT_TOOL_CAPABILITY_PACKS
export const AGENT_TOOL_CAPABILITY_PACK_ORDER = AGENT_TOOL_MANIFEST_SNAPSHOT.AGENT_TOOL_CAPABILITY_PACK_ORDER

type AgentToolMcpToolName = (typeof AGENT_TOOL_MCP_TOOL_NAMES)[number]
type AgentToolCapabilityPackName = (typeof AGENT_TOOL_CAPABILITY_PACK_ORDER)[number]
type AgentToolSurface = "thread" | "space" | "database" | "app" | "automation" | "settings" | "action"
type FeatureFlagKeyFromManifestEntry<Entry> =
  Entry extends { readonly featureFlagKey: infer Key extends string } ? Key : never
type FeatureFlagKey = FeatureFlagKeyFromManifestEntry<
  (typeof AGENT_TOOL_MCP_MANIFEST)[AgentToolMcpToolName]
>
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
  executionMode?: string
  featureFlagKey?: FeatureFlagKey
  inputSchema: AgentToolInputSchema
  risk: string
  sensitiveInput?: boolean
  surfaces?: readonly AgentToolSurface[]
  visibility: "core" | "deferred" | "surface-scoped"
}
const DEFINED_FEATURE_FLAGS = new Set<string>(
  Object.values(AGENT_TOOL_MCP_MANIFEST).flatMap((entry) =>
    "featureFlagKey" in entry && typeof entry.featureFlagKey === "string"
      ? [entry.featureFlagKey]
      : [],
  ),
)
const AGENT_TOOL_MCP_SURFACES = [
  "thread",
  "space",
  "database",
  "app",
  "automation",
  "settings",
  "action",
] as const satisfies readonly AgentToolSurface[]

export type AgentToolMcpEnv = {
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
  failedSteps?: Array<{ error?: string; id: string; reasonCode?: string; tool: string }>
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
export const AGENT_TOOL_CORE_CAPABILITY_RESOURCE = "https://0000.chat/mcp/resources/capabilities/core"
export const AGENT_TOOL_TOOL_ROUTING_GUIDE_RESOURCE = "https://0000.chat/mcp/resources/capabilities/tool-routing-guide"
export const AGENT_TOOL_CAPABILITY_PACK_RESOURCE_BASE = "https://0000.chat/mcp/resources/capabilities/pack/"
const DEFAULT_AGENT_TOOL_HTTP_TIMEOUT_MS = 30_000
const MAX_ERROR_TEXT_LENGTH = 280
const MAX_MCP_ERROR_JSON_LENGTH = 1_500
export const AGENT_TOOL_BROKER_MCP_TOOL_NAMES = [
  "tools.search",
  "tools.describe",
  "tools.call",
  "tools.executePlan",
  "tools.executeCode",
] as const
export type AgentToolBrokerMcpToolName = (typeof AGENT_TOOL_BROKER_MCP_TOOL_NAMES)[number]
export const AGENT_TOOL_TOP_LEVEL_MCP_TOOL_NAMES = [
  ...AGENT_TOOL_BROKER_MCP_TOOL_NAMES,
  "capabilities.advise",
] as const
export type AgentToolTopLevelMcpToolName = (typeof AGENT_TOOL_TOP_LEVEL_MCP_TOOL_NAMES)[number]
const TOOL_SEARCH_INPUT_SCHEMA = {
  query: z.string().optional(),
  limit: z.number().int().positive().max(50).optional(),
  offset: z.number().int().min(0).optional(),
  capabilityPack: z.string().optional(),
  effect: z.string().optional(),
  risk: z.string().optional(),
}
const TOOL_DESCRIBE_INPUT_SCHEMA = {
  tool: z.string().trim().min(1),
}
const TOOL_CALL_INPUT_SCHEMA = {
  tool: z.string().trim().min(1),
  input: z.unknown().optional(),
}
const TOOL_EXECUTE_PLAN_INPUT_SCHEMA = {
  mode: z.enum(["sequential", "parallel"]).optional(),
  steps: z.array(
    z.object({
      id: z.string().trim().min(1).optional(),
      input: z.unknown().optional(),
      tool: z.string().trim().min(1),
    }),
  ).min(1).max(20),
}
const TOOL_EXECUTE_CODE_INPUT_SCHEMA = {
  code: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional(),
}

function toZodField(field: AgentToolInputSchemaField): z.ZodType {
  let schema: z.ZodType

  switch (field.kind) {
    case "array":
      schema = z.array(toZodField(field.items))
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
      schema = z.object(toZodRawShape(field.fields))
      break
    case "record":
      schema = z.record(z.string(), toZodField(field.value))
      break
    case "string":
      schema = z.string()
      break
    case "union":
      schema = z.union(field.options.map(toZodField) as [z.ZodType, z.ZodType, ...z.ZodType[]])
      break
    case "unknown":
      schema = z.unknown()
      break
  }

  if ("nullable" in field && field.nullable) schema = schema.nullable()
  if (field.optional) schema = schema.optional()
  return schema
}

function toZodRawShape(inputSchema: AgentToolInputSchema): z.ZodRawShape {
  return Object.fromEntries(
    Object.entries(inputSchema).map(([fieldName, field]) => [fieldName, toZodField(field)]),
  )
}

export function buildAgentToolMcpInputSchemas(): Record<AgentToolMcpToolName, z.ZodRawShape> {
  return Object.fromEntries(
    AGENT_TOOL_MCP_TOOL_NAMES.map((toolName) => [
      toolName,
      toZodRawShape(AGENT_TOOL_MCP_MANIFEST[toolName].inputSchema),
    ]),
  ) as Record<AgentToolMcpToolName, z.ZodRawShape>
}

const toolSchemas = buildAgentToolMcpInputSchemas()
export const AGENT_TOOL_MCP_INPUT_SCHEMAS = Object.fromEntries(
  AGENT_TOOL_MCP_TOOL_NAMES.map((toolName) => [toolName, z.object(toolSchemas[toolName])]),
) as Record<AgentToolMcpToolName, z.ZodObject<z.ZodRawShape>>

export function getAgentToolCapabilityPackName(toolName: AgentToolMcpToolName): AgentToolCapabilityPackName {
  const domain = toolName.split(".")[0]
  const tool = AGENT_TOOL_MCP_MANIFEST[toolName] as AgentToolManifestEntry
  if (tool.visibility === "core") return "core"
  if (domain === "databaseViews" || domain === "databases") return "databases"
  if (domain === "bridgeDevices" || domain === "notifications") return "runtime"
  if (domain === "messages" || domain === "tags" || domain === "threads") return "threads"
  return tool.capabilityPack
}

export function buildAgentToolMcpRegistrationMetadata(
  toolName: AgentToolMcpToolName,
  inputSchemas: Record<AgentToolMcpToolName, z.ZodRawShape> = toolSchemas,
) {
  const tool = AGENT_TOOL_MCP_MANIFEST[toolName] as AgentToolManifestEntry
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
    const featureFlagKey = (AGENT_TOOL_MCP_MANIFEST[toolName] as AgentToolManifestEntry).featureFlagKey
    return !featureFlagKey || enabledFeatureFlags.includes(featureFlagKey)
  })
}

function formatPackText(packName: AgentToolCapabilityPackName, enabledFeatureFlags: readonly FeatureFlagKey[] = []): string {
  const pack = AGENT_TOOL_CAPABILITY_PACKS[packName]
  const toolNames = toolNamesForPack(packName, enabledFeatureFlags)
  const tools = toolNames
    .map((toolName) => {
      const tool = AGENT_TOOL_MCP_MANIFEST[toolName] as AgentToolManifestEntry
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

export function buildCapabilityPacksText(options: { enabledFeatureFlags?: readonly FeatureFlagKey[] } = {}): string {
  return `# 0000 Chat MCP capability packs

Default core stays intentionally small. Load or activate contextual packs only when the user intent or active surface needs them.

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
  return formatPackText(packName, options.enabledFeatureFlags)
}

export function buildToolRoutingGuideText(options: { enabledFeatureFlags?: readonly FeatureFlagKey[] } = {}): string {
  return `# 0000 Chat MCP tool routing guide

Start with core: context.get, threads.current, threads.read, objects.*, capabilities.describe, capabilities.advise, and userPrompts.requestChoice.

- Current-thread continuity: use context.get or threads.current, then threads.read. Do not use messages.search for revive/resume/compaction continuity.
- Durable activity and memory: use threads.readActivity for bounded event detail; use threads.contextList/contextDescribe/contextExpand for lossless context memory before broad search.
- Cross-thread search: use messages.search only when the user asks to search messages/history or you need cached-message retrieval beyond the current thread.
- Thread writes: use threads.create for new threads, threads.update for bounded lifecycle metadata, threads.continue for agent-authored continuation/handoff without faking a user message, and threads.fork for safe branched work.
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

type ToolCatalogSearchInput = {
  capabilityPack?: string
  effect?: string
  enabledFeatureFlags?: readonly FeatureFlagKey[]
  limit?: number
  offset?: number
  query?: string
  risk?: string
}

type ToolCatalogSearchResult = {
  approvalBehavior: string
  capabilityPack: string
  description: string
  effect: string
  inputFields: string[]
  risk: string
  score: number
  surfaces?: readonly AgentToolSurface[]
  tool: AgentToolMcpToolName
}

function normalizeToolSearchText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:-]+/g, " ")
    .toLowerCase()
    .trim()
}

function tokenizeToolSearchText(value: string): string[] {
  return normalizeToolSearchText(value)
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .map((token) =>
      token === "edit" || token === "modify" || token === "change" || token === "adjust" || token === "revise"
        ? "update"
        : token,
    )
    .filter((token) => !["a", "an", "the", "this", "that", "it", "please", "can", "could", "would"].includes(token))
    .filter(Boolean)
}

function scoreToolCatalogEntry(toolName: AgentToolMcpToolName, query: string): number {
  const tool = AGENT_TOOL_MCP_MANIFEST[toolName] as AgentToolManifestEntry
  const normalizedQuery = normalizeToolSearchText(query)
  const queryTokens = tokenizeToolSearchText(query)
  if (!normalizedQuery || queryTokens.length === 0) return 1
  const weightedFields = [
    [toolName, 14],
    [toolName.split(".").at(-1) ?? toolName, 12],
    [getAgentToolCapabilityPackName(toolName), 9],
    [tool.description, 6],
    [tool.effect, 4],
    [tool.risk, 4],
    [tool.surfaces?.join(" ") ?? "", 5],
    [Object.keys(tool.inputSchema).join(" "), 3],
  ] as const
  let score = 0
  const matchedTokens = new Set<string>()
  for (const [rawField, weight] of weightedFields) {
    const field = normalizeToolSearchText(rawField)
    const fieldTokens = tokenizeToolSearchText(rawField)
    if (!field) continue
    if (field === normalizedQuery) score += weight * 12
    else if (field.startsWith(normalizedQuery)) score += weight * 8
    else if (field.includes(normalizedQuery)) score += weight * 5
    for (const token of queryTokens) {
      if (fieldTokens.includes(token)) {
        score += weight * 4
        matchedTokens.add(token)
      } else if (fieldTokens.some((candidate) => candidate.startsWith(token) || token.startsWith(candidate))) {
        score += weight * 2
        matchedTokens.add(token)
      } else if (field.includes(token)) {
        score += weight
        matchedTokens.add(token)
      }
    }
  }
  const coverage = matchedTokens.size / queryTokens.length
  if (coverage < (queryTokens.length <= 2 ? 1 : 0.55) && !normalizeToolSearchText(tool.description).includes(normalizedQuery)) {
    return 0
  }
  return score + Math.round(coverage * 25)
}

function visibleCatalogToolNames(enabledFeatureFlags: readonly FeatureFlagKey[] = []): AgentToolMcpToolName[] {
  return filterAgentToolNamesForFeatureFlags(AGENT_TOOL_MCP_TOOL_NAMES, enabledFeatureFlags)
}

export function searchAgentToolCatalog(input: ToolCatalogSearchInput = {}) {
  const query = input.query ?? ""
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 12), 1), 50)
  const offset = Math.max(Math.floor(input.offset ?? 0), 0)
  const candidates = visibleCatalogToolNames(input.enabledFeatureFlags).filter((toolName) => {
    const tool = AGENT_TOOL_MCP_MANIFEST[toolName]
    if (input.capabilityPack && getAgentToolCapabilityPackName(toolName) !== input.capabilityPack) return false
    if (input.effect && tool.effect !== input.effect) return false
    if (input.risk && tool.risk !== input.risk) return false
    return true
  })
  const ranked = candidates
    .map((toolName): ToolCatalogSearchResult | null => {
      const score = scoreToolCatalogEntry(toolName, query)
      if (score <= 0) return null
      const tool = AGENT_TOOL_MCP_MANIFEST[toolName] as AgentToolManifestEntry
      return {
        approvalBehavior: tool.approvalBehavior,
        capabilityPack: getAgentToolCapabilityPackName(toolName),
        description: tool.description,
        effect: tool.effect,
        inputFields: Object.keys(tool.inputSchema),
        risk: tool.risk,
        score,
        ...(tool.surfaces ? { surfaces: tool.surfaces } : {}),
        tool: toolName,
      }
    })
    .filter((entry): entry is ToolCatalogSearchResult => entry !== null)
    .sort((left, right) => right.score - left.score || left.tool.localeCompare(right.tool))
  const items = ranked.slice(offset, offset + limit)
  return {
    hasMore: offset + items.length < ranked.length,
    items,
    nextOffset: offset + items.length < ranked.length ? offset + items.length : null,
    total: ranked.length,
  }
}

export function describeAgentToolCatalogEntry(toolName: string, enabledFeatureFlags: readonly FeatureFlagKey[] = []) {
  if (!isAgentToolMcpToolName(toolName) || !visibleCatalogToolNames(enabledFeatureFlags).includes(toolName)) {
    const suggestions = searchAgentToolCatalog({ enabledFeatureFlags, limit: 5, query: toolName }).items.map((item) => item.tool)
    return {
      error: {
        code: "tool_not_found",
        message: `Unknown or unavailable 0000 tool: ${toolName}`,
        suggestions,
      },
      tool: toolName,
    }
  }
  const tool = AGENT_TOOL_MCP_MANIFEST[toolName] as AgentToolManifestEntry
  return {
    annotations: tool.annotations,
    approvalBehavior: tool.approvalBehavior,
    capabilityPack: getAgentToolCapabilityPackName(toolName),
    description: tool.description,
    effect: tool.effect,
    executionMode: tool.executionMode,
    inputSchema: tool.inputSchema,
    risk: tool.risk,
    sensitiveInput: (tool as { sensitiveInput?: boolean }).sensitiveInput === true,
    surfaces: tool.surfaces ?? [],
    tool: toolName,
    visibility: tool.visibility,
  }
}

function isAgentToolMcpToolName(value: string): value is AgentToolMcpToolName {
  return (AGENT_TOOL_MCP_TOOL_NAMES as readonly string[]).includes(value)
}

function canCatalogToolRunInParallel(toolName: string, enabledFeatureFlags: readonly FeatureFlagKey[] = []): boolean {
  if (!isAgentToolMcpToolName(toolName) || !visibleCatalogToolNames(enabledFeatureFlags).includes(toolName)) return false
  const tool = AGENT_TOOL_MCP_MANIFEST[toolName] as AgentToolManifestEntry
  return tool.effect === "read" || tool.annotations.readOnlyHint === true
}

async function callCatalogTool(env: AgentToolMcpEnv, toolName: string, input: unknown): Promise<unknown> {
  if (!isAgentToolMcpToolName(toolName) || !visibleCatalogToolNames(env.enabledFeatureFlags).includes(toolName)) {
    return { ok: false, error: `Unknown or unavailable 0000 tool: ${toolName}` }
  }
  return invokeAgentToolOverHttp(env, toolName, input ?? {})
}

type CatalogPlanStepResult = { id: string; result: unknown; tool: string }

function getCatalogPlanPathValue(root: unknown, path: string): unknown {
  if (!path) return root
  return path.split(".").reduce<unknown>((current, part) => {
    if (current === undefined || current === null) return undefined
    if (/^\d+$/.test(part) && Array.isArray(current)) return current[Number(part)]
    if (typeof current === "object" && part in current) return (current as Record<string, unknown>)[part]
    return undefined
  }, root)
}

function resolveCatalogPlanInputReferences(value: unknown, completedSteps: readonly CatalogPlanStepResult[]): unknown {
  if (typeof value === "string") {
    const match = value.match(/^\$steps\.([A-Za-z0-9_-]+)(?:\.(.+))?$/)
    if (!match) return value
    const step = completedSteps.find((candidate) => candidate.id === match[1])
    return getCatalogPlanPathValue(step, match[2] ?? "")
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveCatalogPlanInputReferences(item, completedSteps))
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        resolveCatalogPlanInputReferences(item, completedSteps),
      ]),
    )
  }
  return value
}

export async function executeCatalogPlan(
  env: AgentToolMcpEnv,
  plan: { mode?: "sequential" | "parallel"; steps: { id?: string; input?: unknown; tool: string }[] },
): Promise<unknown> {
  const requestedMode = plan.mode === "parallel" ? "parallel" : "sequential"
  const steps = plan.steps.map((step, index) => ({ ...step, id: step.id ?? `step_${index + 1}` }))
  const mode = requestedMode === "parallel" && steps.every((step) => canCatalogToolRunInParallel(step.tool, env.enabledFeatureFlags))
    ? "parallel"
    : "sequential"
  const runStep = async (
    step: { id?: string; input?: unknown; tool: string },
    index: number,
    completedSteps: readonly CatalogPlanStepResult[] = [],
  ): Promise<CatalogPlanStepResult> => {
    const id = step.id ?? `step_${index + 1}`
    const input = mode === "parallel" ? (step.input ?? {}) : resolveCatalogPlanInputReferences(step.input ?? {}, completedSteps)
    try {
      return {
        id,
        result: await callCatalogTool(env, step.tool, input),
        tool: step.tool,
      }
    } catch (error) {
      return {
        id,
        result: buildAgentToolInvokeFailure({
          error: error instanceof Error ? error.message : String(error),
          reasonCode: "APP_ERROR",
          tool: step.tool,
        }),
        tool: step.tool,
      }
    }
  }
  const results = mode === "parallel"
    ? await Promise.all(steps.map((step, index) => runStep(step, index)))
    : []
  if (mode !== "parallel") {
    for (let index = 0; index < steps.length; index += 1) {
      results.push(await runStep(steps[index]!, index, results))
      const result = results[results.length - 1]?.result
      if (result && typeof result === "object" && (result as { ok?: unknown }).ok === false) break
    }
  }
  const failedSteps = results
    .filter((step) => step.result && typeof step.result === "object" && (step.result as { ok?: unknown }).ok === false)
    .map((step) => {
      const failure = step.result as { error?: unknown; reasonCode?: unknown }
      return {
        error: typeof failure.error === "string" ? sanitizeErrorText(failure.error) : undefined,
        id: step.id,
        reasonCode: typeof failure.reasonCode === "string" ? failure.reasonCode : undefined,
        tool: step.tool,
      }
    })
  return {
    ok: failedSteps.length === 0,
    ...(failedSteps.length > 0
      ? {
          error: `Plan failed at ${failedSteps.length} step${failedSteps.length === 1 ? "" : "s"}: ${failedSteps
            .slice(0, 5)
            .map((step) => `${step.id} (${step.tool})${step.error ? `: ${step.error}` : ""}`)
            .join("; ")}${failedSteps.length > 5 ? `; ${failedSteps.length - 5} more` : ""}`,
          failedSteps,
          reasonCode: "APP_ERROR",
        }
      : {}),
    result: {
      mode,
      ...(requestedMode !== mode ? { requestedMode } : {}),
      steps: results,
    },
  }
}

export function parseAgentToolMcpSurfaces(value: string | undefined): AgentToolSurface[] {
  if (!value?.trim()) return []

  const allowedSurfaces = new Set<string>(AGENT_TOOL_MCP_SURFACES)
  const activeSurfaces: AgentToolSurface[] = []
  for (const rawSurface of value.split(",")) {
    const surface = rawSurface.trim()
    if (!surface) continue
    if (!allowedSurfaces.has(surface)) continue
    if (!activeSurfaces.includes(surface as AgentToolSurface)) {
      activeSurfaces.push(surface as AgentToolSurface)
    }
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
  _activeToolSurfaces: readonly AgentToolSurface[] = [],
  _enabledFeatureFlags: readonly FeatureFlagKey[] = [],
): AgentToolTopLevelMcpToolName[] {
  return [...AGENT_TOOL_TOP_LEVEL_MCP_TOOL_NAMES]
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
  if (tool === "apps.code.reserveSource") {
    const record = input && typeof input === "object" && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {}
    if (record.sourceText !== undefined || record.sourceBase64 !== undefined) {
      return await uploadReactCodeSourceOverHttp(env, record, fetchImpl, options)
    }
  }
  return await invokeAgentToolRequestOverHttp(env, tool, input, fetchImpl, options)
}

async function invokeAgentToolRequestOverHttp(
  env: AgentToolMcpEnv,
  tool: string,
  input: unknown,
  fetchImpl: AgentToolFetch,
  options: AgentToolHttpInvokeOptions,
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
          httpStatus: typeof payload.httpStatus === "number" ? payload.httpStatus : undefined,
          reasonCode: isAgentToolInvokeFailureReasonCode(payload.reasonCode) ? payload.reasonCode : "APP_ERROR",
          retryable: typeof payload.retryable === "boolean" ? payload.retryable : undefined,
          timeoutMs: typeof payload.timeoutMs === "number" ? payload.timeoutMs : undefined,
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

function reactCodeSourceBytes(input: Record<string, unknown>): Uint8Array {
  const hasText = typeof input.sourceText === "string"
  const hasBase64 = typeof input.sourceBase64 === "string"
  if (hasText === hasBase64) throw new Error("Provide exactly one of sourceText or sourceBase64")

  const bytes = hasText
    ? new TextEncoder().encode(input.sourceText as string)
    : (() => {
        const encoded = input.sourceBase64 as string
        if (
          encoded.length === 0 ||
          encoded.length > 65_536 ||
          encoded.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
        ) {
          throw new Error("sourceBase64 is invalid")
        }
        const decoded = Buffer.from(encoded, "base64")
        if (decoded.toString("base64") !== encoded) throw new Error("sourceBase64 is invalid")
        return new Uint8Array(decoded)
      })()
  if (bytes.byteLength < 1 || bytes.byteLength > 48 * 1024) {
    throw new Error("React code source must contain 1 to 49152 bytes")
  }
  return bytes
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function successfulToolResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("React code source transport received an invalid tool response")
  }
  const envelope = value as { error?: unknown; ok?: unknown; result?: unknown }
  if (envelope.ok !== true || !envelope.result || typeof envelope.result !== "object" || Array.isArray(envelope.result)) {
    throw new Error(
      typeof envelope.error === "string"
        ? envelope.error
        : "React code source transport did not receive a successful receipt",
    )
  }
  return envelope.result as Record<string, unknown>
}

function boundedUploadHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("React code source upload headers are invalid")
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 16) throw new Error("React code source upload headers are invalid")
  const seen = new Set<string>()
  const forbidden = new Set([
    "authorization", "connection", "content-length", "cookie", "host", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
  ])
  return Object.fromEntries(entries.map(([name, headerValue]) => {
    const normalizedName = name.toLowerCase()
    if (
      !/^[a-z0-9-]{1,64}$/i.test(name) ||
      seen.has(normalizedName) ||
      forbidden.has(normalizedName) ||
      typeof headerValue !== "string" ||
      headerValue.length > 512 ||
      /[\0-\x08\x0a-\x1f\x7f]/.test(headerValue)
    ) {
      throw new Error("React code source upload headers are invalid")
    }
    seen.add(normalizedName)
    return [name, headerValue]
  }))
}

function remainingReactSourceOptions(
  deadlineMs: number,
  totalTimeoutMs: number,
): AgentToolHttpInvokeOptions {
  const timeoutMs = deadlineMs - Date.now()
  if (timeoutMs <= 0) throw new Error(`React code source transport timed out after ${totalTimeoutMs}ms`)
  return { timeoutMs }
}

async function putReactCodeSourceOverHttp(
  uploadUrl: URL,
  bytes: Uint8Array,
  requiredUploadHeaders: unknown,
  fetchImpl: AgentToolFetch,
  options: AgentToolHttpInvokeOptions,
): Promise<void> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_AGENT_TOOL_HTTP_TIMEOUT_MS)
  const abortController = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        abortController.abort()
        reject(new Error(`React code source upload timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    })
    const response = await Promise.race([
      fetchImpl(uploadUrl, {
        body: bytes as unknown as BodyInit,
        headers: boundedUploadHeaders(requiredUploadHeaders),
        method: "PUT",
        redirect: "error",
        signal: abortController.signal,
      }),
      timeoutPromise,
    ])
    if (!response.ok && response.status !== 409 && response.status !== 412) {
      throw new Error(`React code source upload failed with status ${response.status}`)
    }
  } catch (error) {
    if (
      error instanceof Error &&
      /^React code source upload (?:failed with status \d+|timed out after \d+ms)$/.test(error.message)
    ) {
      throw error
    }
    throw new Error("React code source upload failed")
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

async function uploadReactCodeSourceOverHttp(
  env: AgentToolMcpEnv,
  input: Record<string, unknown>,
  fetchImpl: AgentToolFetch,
  options: AgentToolHttpInvokeOptions,
): Promise<AgentToolInvokeResult | unknown> {
  try {
    const totalTimeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_AGENT_TOOL_HTTP_TIMEOUT_MS)
    const deadlineMs = Date.now() + totalTimeoutMs
    const bytes = reactCodeSourceBytes(input)
    const sha256 = await sha256Hex(bytes)
    if (input.byteLength !== undefined && input.byteLength !== bytes.byteLength) {
      throw new Error("byteLength does not match the provided React code source")
    }
    if (input.sha256 !== undefined && input.sha256 !== sha256) {
      throw new Error("sha256 does not match the provided React code source")
    }
    const operationId =
      typeof input.operationId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(input.operationId)
        ? input.operationId
        : undefined
    if (!operationId) throw new Error("operationId is invalid")
    const operationIdHash = await sha256Hex(new TextEncoder().encode(operationId))
    const completionOperationId =
      typeof input.completionOperationId === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/.test(input.completionOperationId)
        ? input.completionOperationId
        : `${operationId.slice(0, 86)}_complete_${operationIdHash.slice(0, 32)}`

    const reservationResponse = await invokeAgentToolRequestOverHttp(
      env,
      "apps.code.reserveSource",
      {
        ...input,
        byteLength: bytes.byteLength,
        completionOperationId: undefined,
        sha256,
        sourceBase64: undefined,
        sourceText: undefined,
      },
      fetchImpl,
      remainingReactSourceOptions(deadlineMs, totalTimeoutMs),
    )
    if (
      reservationResponse &&
      typeof reservationResponse === "object" &&
      !Array.isArray(reservationResponse) &&
      (reservationResponse as { ok?: unknown }).ok === false
    ) {
      return reservationResponse
    }
    const reservation = successfulToolResult(reservationResponse)
    const sourceBlobId = reservation.sourceBlobId
    if (typeof sourceBlobId !== "string" || sourceBlobId.length === 0) {
      throw new Error("React code source reservation is missing its sourceBlobId")
    }
    if (reservation.status === "pending") {
      if (typeof reservation.uploadUrl !== "string") {
        throw new Error("React code source reservation is missing its upload URL")
      }
      let uploadUrl: URL
      try {
        uploadUrl = new URL(reservation.uploadUrl)
      } catch {
        throw new Error("React code source upload URL is invalid")
      }
      if (uploadUrl.protocol !== "https:" || uploadUrl.username || uploadUrl.password || uploadUrl.hash) {
        throw new Error("React code source upload URL is invalid")
      }
      await putReactCodeSourceOverHttp(
        uploadUrl,
        bytes,
        reservation.requiredUploadHeaders,
        fetchImpl,
        remainingReactSourceOptions(deadlineMs, totalTimeoutMs),
      )
    } else if (reservation.status !== "available") {
      throw new Error("React code source reservation returned an invalid status")
    }
    return await invokeAgentToolRequestOverHttp(
      env,
      "apps.code.completeSource",
      {
        appId: input.appId,
        editSessionId: input.editSessionId,
        operationId: completionOperationId,
        sourceBlobId,
      },
      fetchImpl,
      remainingReactSourceOptions(deadlineMs, totalTimeoutMs),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return buildAgentToolInvokeFailure({
      error: message,
      reasonCode: /timed out/.test(message) ? "TIMEOUT" : "APP_ERROR",
      retryable: /timed out|failed with status (?:429|5\d\d)/.test(message) || undefined,
      tool: "apps.code.reserveSource",
    })
  }
}

export function toMcpToolResult(result: unknown, options: { markOkFalseAsError?: boolean } = {}) {
  const record = result && typeof result === "object"
    ? result as { interactionId?: unknown; needsApproval?: unknown; ok?: unknown }
    : undefined
  const approvalRequest =
    record?.ok === false &&
    record.needsApproval === true &&
    typeof record.interactionId === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(record.interactionId)
  const markAsError =
    record?.ok === false &&
    !approvalRequest &&
    options.markOkFalseAsError !== false
  const text = approvalRequest
    ? JSON.stringify({ interactionId: record.interactionId, needsApproval: true, ok: false }, null, 2)
    : markAsError
      ? JSON.stringify(boundToolFailureForMcp(result), null, 2)
      : JSON.stringify(result, null, 2)
  return {
    content: [{ type: "text" as const, text }],
    ...(markAsError ? { isError: true } : {}),
  }
}

export function buildAgentToolGuideText(options: ZeroChatPolicyOptions = {}): string {
  const featureFlags = parseFeatureFlagArray(options.enabledFeatureFlags)
  return `You are operating inside 0000 Chat.

Use the 0000 MCP server for 0000 Chat data and actions. The public bridge MCP surface is hard-switched to a small broker plus the top-level Architect advisor: tools.search finds catalog tools, tools.describe returns schema/risk/approval details, tools.call invokes one catalog tool, tools.executePlan runs bounded multi-step plans, tools.executeCode runs ephemeral per-turn Code Mode, and capabilities.advise returns 0000-native architecture guidance. Individual 0000 tool names are catalog entries passed through the broker, not directly visible MCP tools.

Top-level tools: ${AGENT_TOOL_TOP_LEVEL_MCP_TOOL_NAMES.join(", ")}.

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
  const activeToolSurfaces = env.activeToolSurfaces?.length
    ? env.activeToolSurfaces.join(",")
    : "(core only)"
  const enabledFeatureFlags = env.enabledFeatureFlags?.length
    ? env.enabledFeatureFlags.join(",")
    : "(none)"
  const visibleTools = getVisibleAgentToolMcpToolNames(env.activeToolSurfaces, env.enabledFeatureFlags)
  return `app: 0000-chat
agentSessionId: ${env.agentSessionId}
${currentThreadLine}bridgeDeviceId: ${env.deviceId}
appUrl: ${env.appUrl}
mcpServer: 0000
activeToolSurfaces: ${activeToolSurfaces} (legacy hint only; other direct surface tools are hidden by the broker hard-switch)
enabledFeatureFlags: ${enabledFeatureFlags}
visibleTools: ${visibleTools.join(",")}
toolBroker: use capabilities.advise directly for 0000-native architecture guidance; use tools.search to find catalog tools, tools.describe for schema/risk, tools.call for one call, tools.executePlan for bounded multi-step calls, and tools.executeCode for ephemeral Code Mode. Do not rely on other direct surface tools being visible.
toolGuide: ${AGENT_TOOL_GUIDE_RESOURCE}`
}

export function createAgentToolsMcpServer(env: AgentToolMcpEnv): McpServer {
  const server = new McpServer({ name: "0000-agent-tools", version: "0.2.0" })

  server.registerTool(
    "tools.search",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true },
      description:
        "Search the full 0000 Chat tool catalog by intent, target object, effect, risk, or tool name. This is the primary hard-switch discovery path; individual surface tools are not exposed directly.",
      inputSchema: TOOL_SEARCH_INPUT_SCHEMA,
    },
    async (input) => toMcpToolResult({ ok: true, result: searchAgentToolCatalog({ ...input, enabledFeatureFlags: env.enabledFeatureFlags }) }),
  )

  server.registerTool(
    "tools.describe",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true },
      description: "Describe one 0000 Chat catalog tool, including input schema, risk, effect, approval behavior, and suggestions if missing.",
      inputSchema: TOOL_DESCRIBE_INPUT_SCHEMA,
    },
    async (input) => toMcpToolResult({ ok: true, result: describeAgentToolCatalogEntry(input.tool, env.enabledFeatureFlags) }),
  )

  server.registerTool(
    "tools.call",
    {
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false, readOnlyHint: false },
      description:
        "Call one 0000 Chat catalog tool by name with JSON input. Existing 0000 approval, audit, feature-flag, and action-runtime behavior still applies. Search and describe before calling when unsure.",
      inputSchema: TOOL_CALL_INPUT_SCHEMA,
    },
    async (input) => toMcpToolResult(await callCatalogTool(env, input.tool, input.input ?? {})),
  )

  server.registerTool(
    "tools.executePlan",
    {
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false, readOnlyHint: false },
      description:
        "Execute a bounded multi-step 0000 Chat tool plan through the broker. Use mode='parallel' only when steps are independent; otherwise omit mode for sequential execution. Sequential step inputs may reference previous step results with strings like '$steps.current.result.thread.id'. Loops and conditionals are not supported; create/run an Action for reusable workflow logic. Existing approval and audit behavior applies per step.",
      inputSchema: TOOL_EXECUTE_PLAN_INPUT_SCHEMA,
    },
    async (input) => toMcpToolResult(await executeCatalogPlan(env, input), { markOkFalseAsError: false }),
  )

  server.registerTool(
    "tools.executeCode",
    {
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false, readOnlyHint: false },
      description:
        "Execute ephemeral per-turn JavaScript Code Mode through 0000 Chat. Use when loops, conditions, pagination, transforms, retries, or branching are needed. The code runs server-side in the Actions runtime substrate and nested 0000 tool calls still use normal auth, approval, audit, policy, and limits.",
      inputSchema: TOOL_EXECUTE_CODE_INPUT_SCHEMA,
    },
    async (input) => toMcpToolResult(await callCatalogTool(env, "tools.executeCode", input)),
  )

  server.registerTool(
    "capabilities.advise",
    buildAgentToolMcpRegistrationMetadata("capabilities.advise"),
    async (input) => toMcpToolResult(await callCatalogTool(env, "capabilities.advise", input)),
  )

  server.registerResource(
    "0000 Chat agent tool guide",
    AGENT_TOOL_GUIDE_RESOURCE,
    {
      description: "How agents should interpret 0000 Chat context and use app MCP tools.",
      mimeType: "text/plain",
    },
    async () => ({
      contents: [
        {
          text: buildAgentToolGuideText({ enabledFeatureFlags: env.enabledFeatureFlags }),
          uri: AGENT_TOOL_GUIDE_RESOURCE,
        },
      ],
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

  server.registerResource(
    "0000 Chat capability packs",
    AGENT_TOOL_CAPABILITY_PACKS_RESOURCE,
    { description: "Passive guide to 0000 Chat MCP capability packs and contextual/deferred tool namespaces.", mimeType: "text/plain" },
    async () => ({ contents: [{ text: buildCapabilityPacksText({ enabledFeatureFlags: env.enabledFeatureFlags }), uri: AGENT_TOOL_CAPABILITY_PACKS_RESOURCE }] }),
  )

  server.registerResource(
    "0000 Chat tool routing guide",
    AGENT_TOOL_TOOL_ROUTING_GUIDE_RESOURCE,
    { description: "Routing guidance for choosing broker tools and catalog capability packs.", mimeType: "text/plain" },
    async () => ({ contents: [{ text: buildToolRoutingGuideText({ enabledFeatureFlags: env.enabledFeatureFlags }), uri: AGENT_TOOL_TOOL_ROUTING_GUIDE_RESOURCE }] }),
  )

  for (const packName of AGENT_TOOL_CAPABILITY_PACK_ORDER) {
    const uri = buildCapabilityPackResourceUri(packName)
    server.registerResource(
      `0000 Chat ${packName} capability pack`,
      uri,
      {
        description: `Passive guidance and tools for the ${packName} 0000 Chat MCP capability pack.`,
        mimeType: "text/plain",
      },
      async () => ({
        contents: [
          {
            text: buildCapabilityPackText(packName, { enabledFeatureFlags: env.enabledFeatureFlags }),
            uri,
          },
        ],
      }),
    )
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


function buildAgentToolInvokeFailure(failure: Omit<AgentToolInvokeFailure, "ok">): AgentToolInvokeFailure {
  return { ok: false, ...failure, error: sanitizeErrorText(failure.error) }
}

function sanitizeErrorText(input: string): string {
  const redacted = input
    .replace(/authorization\s*:\s*[^\s,]+/gi, "authorization: [redacted]")
    .replace(/bearer\s+[^\s,]+/gi, "Bearer [redacted]")
    .replace(/(bridgeToken|token|authToken|authorization)["']?\s*[:=]\s*["'][^"']+["']/gi, "$1: [redacted]")
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, "$1?[redacted]")
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
    ...(Array.isArray(failure.failedSteps) ? { failedSteps: failure.failedSteps.slice(0, 10) } : {}),
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

function isAgentToolInvokeFailureReasonCode(value: unknown): value is AgentToolInvokeFailureReasonCode {
  return value === "APP_ERROR" || value === "FETCH_ERROR" || value === "HTTP_ERROR" || value === "INVALID_JSON" || value === "TIMEOUT"
}

function isErrorPayload(payload: unknown): payload is {
  error: string
  httpStatus?: number
  ok?: false
  reasonCode?: unknown
  retryable?: boolean
  timeoutMs?: number
} {
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
