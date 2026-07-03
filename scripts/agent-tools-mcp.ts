#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod/v4"

import {
  ACTIONS_RUNTIME_FEATURE_FLAG_KEY,
  ARTIFACTS_FEATURE_FLAG_KEY,
  buildZeroChatMcpGuideText,
  type ZeroChatPolicyOptions,
} from "./acp-bridge/zero-chat-policy"

export { ACTIONS_RUNTIME_FEATURE_FLAG_KEY, ARTIFACTS_FEATURE_FLAG_KEY }

export const AGENT_TOOL_MCP_TOOL_NAMES = [
  "capabilities.advise",
  "userPrompts.requestChoice",
  "threads.list",
  "threads.create",
  "threads.continue",
  "messages.search",
  "settings.setDefaultApprovalLevel",
  "agents.list",
  "agents.sendMailboxMessage",
  "github.createPullRequest",
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
  "databases.listRelationshipDefinitions",
  "databases.listRowRelationships",
  "databases.createRelationshipDefinition",
  "databases.createRelationship",
  "databases.deleteRelationship",
  "secrets.put",
  "secrets.listAvailable",
  "artifacts.create",
  "artifacts.createUploadIntent",
  "artifacts.completeUpload",
  "artifacts.search",
  "artifacts.read",
  "artifacts.readContent",
  "artifacts.getContentUrl",
  "artifacts.update",
  "artifacts.patchText",
  "artifacts.link",
  "scripts.createDraft",
  "scripts.updateDraft",
  "scripts.search",
  "scripts.read",
  "actions.createDraft",
  "actions.search",
  "actions.read",
  "actions.archive",
  "actions.run",
] as const

type AgentToolMcpToolName = (typeof AGENT_TOOL_MCP_TOOL_NAMES)[number]
type AgentToolMcpEnv = {
  agentSessionId: string
  appUrl: string
  bridgeToken: string
  deviceId: string
  enabledFeatureFlags?: readonly string[]
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
const DEFAULT_AGENT_TOOL_HTTP_TIMEOUT_MS = 30_000
const MAX_ERROR_TEXT_LENGTH = 280
const MAX_MCP_ERROR_JSON_LENGTH = 1_500
const ARTIFACT_TOOL_NAMES = new Set<AgentToolMcpToolName>([
  "artifacts.create",
  "artifacts.createUploadIntent",
  "artifacts.completeUpload",
  "artifacts.search",
  "artifacts.read",
  "artifacts.readContent",
  "artifacts.getContentUrl",
  "artifacts.update",
  "artifacts.patchText",
  "artifacts.link",
])
const ACTIONS_RUNTIME_TOOL_NAMES = new Set<AgentToolMcpToolName>(["actions.run"])
const DEFINED_FEATURE_FLAGS = new Set([ARTIFACTS_FEATURE_FLAG_KEY, ACTIONS_RUNTIME_FEATURE_FLAG_KEY])

const toolSchemas: Record<AgentToolMcpToolName, z.ZodRawShape> = {
  "capabilities.advise": {
    availablePacks: z.array(z.string()).optional(),
    availableTools: z.array(z.string()).optional(),
    constraints: z.string().optional(),
    currentContext: z.string().optional(),
    desiredOutcome: z.string(),
  },
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
  "threads.create": {
    agentIdOrSlug: z.string().optional(),
    approvalLevel: z.enum(["ask", "full_permissions"]).optional(),
    clientThreadId: z.string().optional(),
    initialUserMessage: z.string().optional(),
    requireAgentSession: z.boolean().optional(),
    spaceIdOrSlug: z.string(),
    summary: z.string().optional(),
    title: z.string().optional(),
  },
  "threads.continue": {
    agentIdOrSlug: z.string().optional(),
    approvalLevel: z.enum(["ask", "full_permissions"]).optional(),
    instruction: z.string(),
    requireAgentSession: z.boolean().optional(),
    threadId: z.string().optional(),
    title: z.string().optional(),
  },
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
  "github.createPullRequest": {
    base: z.string(),
    body: z.string().optional(),
    draft: z.boolean().optional(),
    head: z.string(),
    maintainerCanModify: z.boolean().optional(),
    owner: z.string(),
    repo: z.string(),
    title: z.string(),
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
  "databases.listRelationshipDefinitions": {
    direction: z.enum(["source", "target", "both"]).optional(),
    tableIdOrSlug: z.string(),
  },
  "databases.listRowRelationships": {
    direction: z.enum(["forward", "reverse", "both"]).optional(),
    limit: z.number().optional(),
    rowId: z.string(),
  },
  "databases.createRelationshipDefinition": {
    cardinality: z.enum(["one_to_one", "one_to_many", "many_to_one", "many_to_many"]),
    description: z.string().optional(),
    displayName: z.string(),
    metadataFields: z
      .array(
        z.object({
          displayName: z.string(),
          fieldKey: z.string(),
          fieldType: z.enum(["text_single", "checkbox", "select_single", "number", "date"]),
          options: z.array(z.string()).optional(),
          required: z.boolean().optional(),
        }),
      )
      .optional(),
    relationshipKey: z.string(),
    reverseDisplayName: z.string(),
    sourceTableIdOrSlug: z.string(),
    targetTableIdOrSlug: z.string(),
  },
  "databases.createRelationship": {
    metadata: z.record(z.string(), z.unknown()).optional(),
    relationshipDefinitionId: z.string(),
    sourceRowId: z.string(),
    targetRowId: z.string(),
  },
  "databases.deleteRelationship": {
    relationshipId: z.string(),
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
  "artifacts.create": {
    content: z.string(),
    contentHash: z.string().optional(),
    format: z.enum(["text/markdown", "text/typescript", "application/json", "binary"]),
    kind: z.enum(["document", "action", "app", "file", "report"]),
    metadata: z.record(z.string(), z.unknown()).optional(),
    slug: z.string().optional(),
    spaceId: z.string().optional(),
    summary: z.string().optional(),
    tags: z.array(z.string()).optional(),
    title: z.string(),
    versionMetadata: z.record(z.string(), z.unknown()).optional(),
    visibility: z.enum(["organization", "space", "restricted"]).optional(),
  },
  "artifacts.createUploadIntent": {
    extension: z.string().optional(),
    format: z.enum(["text/markdown", "text/typescript", "application/json", "binary"]),
    kind: z.enum(["document", "action", "app", "file", "report"]),
    metadata: z.record(z.string(), z.unknown()).optional(),
    slug: z.string().optional(),
    spaceId: z.string().optional(),
    summary: z.string().optional(),
    tags: z.array(z.string()).optional(),
    title: z.string(),
    versionMetadata: z.record(z.string(), z.unknown()).optional(),
    visibility: z.enum(["organization", "space", "restricted"]).optional(),
  },
  "artifacts.completeUpload": {
    artifactId: z.string(),
    byteLength: z.number(),
    contentHash: z.string(),
    versionId: z.string(),
  },
  "artifacts.search": {
    kind: z.enum(["document", "action", "app", "file", "report"]).optional(),
    limit: z.number().optional(),
    query: z.string().optional(),
    spaceId: z.string().optional(),
    status: z.enum(["draft", "active", "archived", "pendingDeletion"]).optional(),
  },
  "artifacts.read": {
    artifactId: z.string().optional(),
    slug: z.string().optional(),
  },
  "artifacts.readContent": {
    artifactId: z.string().optional(),
    slug: z.string().optional(),
    versionId: z.string().optional(),
  },
  "artifacts.getContentUrl": {
    artifactId: z.string().optional(),
    expiresIn: z.number().optional(),
    slug: z.string().optional(),
    versionId: z.string().optional(),
  },
  "artifacts.update": {
    artifactId: z.string().optional(),
    content: z.string(),
    contentHash: z.string().optional(),
    expectedContentHash: z.string().optional(),
    expectedVersionId: z.string(),
    slug: z.string().optional(),
    summary: z.string().optional(),
    tags: z.array(z.string()).optional(),
    title: z.string().optional(),
    versionMetadata: z.record(z.string(), z.unknown()).optional(),
  },
  "artifacts.patchText": {
    artifactId: z.string().optional(),
    contentHash: z.string().optional(),
    expectedContentHash: z.string().optional(),
    expectedVersionId: z.string(),
    newText: z.string(),
    oldText: z.string(),
    replaceAll: z.boolean().optional(),
    slug: z.string().optional(),
    summary: z.string().optional(),
    tags: z.array(z.string()).optional(),
    title: z.string().optional(),
    versionMetadata: z.record(z.string(), z.unknown()).optional(),
  },
  "artifacts.link": {
    artifactId: z.string(),
    fieldKey: z.string().optional(),
    relationship: z.enum(["source", "reference", "result", "embedded", "mentioned"]),
    rowId: z.string().optional(),
    tableId: z.string().optional(),
    targetId: z.string(),
    targetType: z.enum(["thread", "message", "space", "database_row", "database_table", "action", "app"]),
    targetVersionId: z.string().optional(),
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
  "actions.createDraft": {
    code: z.string(),
    description: z.string(),
    kind: z.enum(["agent_action", "app_action", "automation"]),
    manifest: z.record(z.string(), z.unknown()),
    name: z.string(),
    slug: z.string().optional(),
  },
  "actions.search": { query: z.string().optional() },
  "actions.read": { actionId: z.string() },
  "actions.archive": { actionId: z.string() },
  "actions.run": {
    actionId: z.string(),
    input: z.record(z.string(), z.unknown()),
  },
}

export const AGENT_TOOL_MCP_INPUT_SCHEMAS = Object.fromEntries(
  AGENT_TOOL_MCP_TOOL_NAMES.map((toolName) => [toolName, z.object(toolSchemas[toolName])]),
) as Record<AgentToolMcpToolName, z.ZodObject<z.ZodRawShape>>

const toolDescriptions: Record<AgentToolMcpToolName, string> = {
  "capabilities.advise":
    "Ask the 0000 advisor / 0000 Architect for a read-only machine-readable plan over 0000 primitives and capability packs. This tool does not execute writes.",
  "userPrompts.requestChoice":
    "Ask the user a structured multiple-choice question in the current 0000 Chat thread. Use this instead of printing a lettered list when you need the multiple-choice UI and decision-needed thread indicator.",
  "threads.list": "List recent 0000 Chat threads visible to this agent session.",
  "threads.create":
    "Create a new 0000 Chat thread in a space. By default this creates a thread and agent session without messages; pass agentIdOrSlug to assign the thread to another usable agent, or pass agentIdOrSlug: \"self\" to assign it to the calling agent. Pass initialUserMessage only when the user explicitly wants that text carried into the new thread as the first user message.",
  "threads.continue":
    "Continue the current 0000 Chat thread with an agent-authored turn. Pass instruction, optionally agentIdOrSlug: \"self\" or another usable agent id/slug. This records agent provenance and must not be used to simulate a user-authored message.",
  "messages.search": "Search cached 0000 Chat messages.",
  "settings.setDefaultApprovalLevel":
    "Set the user's default approval mode. Use full_permissions only when the user explicitly asks to enable trusted local automation; this tool requires in-thread approval unless the current thread already has full permissions.",
  "agents.list":
    "List mailbox-capable agents in the current organization so you can address agent-to-agent handoffs by id or slug.",
  "agents.sendMailboxMessage":
    "Send a mailbox message from the current agent to another agent in the same organization. Use responsePolicy='fire-and-forget' for one-off handoffs, 'reply-allowed' when the recipient may answer, and 'reply-requested' when a reply is desired. Replies must pass parentMailboxMessageId and stay within maxHops; this records the handoff but does not automatically start another ACP session.",
  "github.createPullRequest":
    "Request creation of a GitHub pull request as the linked requesting user. The branch must already be pushed to GitHub. 0000 will show an in-thread confirmation and then create the PR server-side; do not include GitHub tokens or credentials.",
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
  "databases.listRelationshipDefinitions":
    "List true relationship definitions for a 0000 Chat dynamic database table.",
  "databases.listRowRelationships":
    "List true relationship instances for a 0000 Chat dynamic database row, including related row data when access-safe.",
  "databases.createRelationshipDefinition":
    "Create a true relationship definition between two 0000 Chat dynamic database tables.",
  "databases.createRelationship":
    "Create a true relationship instance linking two 0000 Chat dynamic database rows through a relationship definition.",
  "databases.deleteRelationship":
    "Delete a true relationship instance attached to an owned 0000 Chat dynamic database row.",
  "secrets.put":
    "Encrypt and store a 0000 Chat user or organization secret. The value is sent to 0000 Chat for encrypted storage and is redacted from approvals and tool logs.",
  "secrets.listAvailable":
    "List metadata for secrets available to generated scripts without revealing values.",
  "artifacts.create":
    "Create a small durable org-visible artifact inline. Use this for markdown notes, plans, JSON, and other durable content that should live in 0000 Chat instead of local files.",
  "artifacts.createUploadIntent":
    "Create an R2 upload intent for a large durable artifact. Upload the content to the returned uploadUrl, then call artifacts.completeUpload with the byte length and content hash.",
  "artifacts.completeUpload":
    "Use after artifacts.createUploadIntent and a successful R2 upload to mark the pending artifact version as available.",
  "artifacts.search":
    "Search durable artifacts in the current organization. Use this before creating local files when looking for existing plans, reports, exported files, or generated content.",
  "artifacts.read":
    "Read artifact metadata and current version metadata by id or slug. Use artifacts.readContent for inline markdown/text content and artifacts.getContentUrl for R2-backed bytes.",
  "artifacts.readContent":
    "Read inline markdown/text artifact content directly by id or slug. Use this before editing artifacts like local markdown files; returns content, versionId, contentHash, format, and artifact metadata. R2-backed or binary content is rejected.",
  "artifacts.getContentUrl":
    "Get a short-lived read URL for an R2-backed artifact version. Use artifacts.read first when you need metadata or the current version id.",
  "artifacts.update":
    "Replace an inline markdown/text artifact with a new version. Read with artifacts.readContent first, pass the returned expectedVersionId, and optionally expectedContentHash to avoid overwriting concurrent edits. Use this like a whole-file markdown save.",
  "artifacts.patchText":
    "Patch an inline markdown/text artifact by replacing exact oldText with newText in a new version. Read with artifacts.readContent first and pass expectedVersionId; if oldText appears more than once, provide more context or set replaceAll true.",
  "artifacts.link":
    "Use when an artifact should be attached to a first-class 0000 object such as a thread, message, space, database row, script, or app.",
  "scripts.createDraft": "Create a reusable generated script draft and first version.",
  "scripts.updateDraft": "Update a reusable generated script draft by creating a new draft version.",
  "scripts.search": "Search reusable generated script artifacts in the current organization.",
  "scripts.read": "Read one reusable generated script artifact and its current version.",
  "actions.createDraft": "Create a reusable generated action draft and first version.",
  "actions.search": "Search reusable generated actions in the current organization.",
  "actions.read": "Read one reusable generated action and its current version.",
  "actions.archive": "Archive a reusable generated action so it no longer appears in default search and cannot be run.",
  "actions.run": "Run one reusable generated action with JSON input through the 0000 Actions runtime.",
}

export function buildAgentToolMcpEnv(env: NodeJS.ProcessEnv): AgentToolMcpEnv {
  return {
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
  const text =
    record?.ok === false
      ? JSON.stringify(boundToolFailureForMcp(result), null, 2)
      : JSON.stringify(result, null, 2)
  return {
    content: [{ type: "text" as const, text }],
    ...(record?.ok === false ? { isError: true } : {}),
  }
}

export function parseAgentToolMcpFeatureFlags(value: string | undefined): string[] {
  if (!value?.trim()) return []
  const featureFlags: string[] = []
  for (const rawFeatureFlag of value.split(",")) {
    const featureFlag = rawFeatureFlag.trim().toLowerCase()
    if (!featureFlag) continue
    if (!DEFINED_FEATURE_FLAGS.has(featureFlag)) {
      continue
    }
    if (!featureFlags.includes(featureFlag)) featureFlags.push(featureFlag)
  }
  return featureFlags
}

export function getVisibleAgentToolMcpToolNames(
  enabledFeatureFlags: readonly string[] = [],
): AgentToolMcpToolName[] {
  const artifactsEnabled = enabledFeatureFlags.includes(ARTIFACTS_FEATURE_FLAG_KEY)
  const actionsRuntimeEnabled = enabledFeatureFlags.includes(ACTIONS_RUNTIME_FEATURE_FLAG_KEY)
  return AGENT_TOOL_MCP_TOOL_NAMES.filter((toolName) => {
    if (ARTIFACT_TOOL_NAMES.has(toolName) && !artifactsEnabled) return false
    if (ACTIONS_RUNTIME_TOOL_NAMES.has(toolName) && !actionsRuntimeEnabled) return false
    return true
  })
}

export function buildAgentToolGuideText(options: ZeroChatPolicyOptions = {}): string {
  return buildZeroChatMcpGuideText({ enabledFeatureFlags: options.enabledFeatureFlags })
}

export function buildAgentToolSessionContextText(env: AgentToolMcpEnv): string {
  const currentThreadLine = env.threadId ? `currentThreadId: ${env.threadId}\n` : ""
  return `app: 0000-chat
agentSessionId: ${env.agentSessionId}
${currentThreadLine}bridgeDeviceId: ${env.deviceId}
appUrl: ${env.appUrl}
mcpServer: 0000
enabledFeatureFlags: ${env.enabledFeatureFlags?.length ? env.enabledFeatureFlags.join(",") : "(none)"}
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

  for (const toolName of getVisibleAgentToolMcpToolNames(env.enabledFeatureFlags)) {
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
