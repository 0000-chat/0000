import { realpath } from "node:fs/promises"
import path from "node:path"

export const ZERO_CHAT_APP_CONTEXT_POLICY = `The user's messages are sent from the 0000 Chat app. When the user says "this app", "this thread", "this space", "my app", "my database", "my table", "records", "search messages", "create an app", or "create a database", interpret those as references to 0000 Chat unless they clearly say otherwise.`

export const ARTIFACTS_FEATURE_FLAG_KEY = "artifacts"
export const ACTIONS_RUNTIME_FEATURE_FLAG_KEY = "actions-runtime"

export type ZeroChatPolicyOptions = {
  enabledFeatureFlags?: readonly string[]
}

function isArtifactsEnabled(options: ZeroChatPolicyOptions = {}) {
  return options.enabledFeatureFlags?.includes(ARTIFACTS_FEATURE_FLAG_KEY) ?? false
}

function isActionsRuntimeEnabled(options: ZeroChatPolicyOptions = {}) {
  return options.enabledFeatureFlags?.includes(ACTIONS_RUNTIME_FEATURE_FLAG_KEY) ?? false
}

const ARTIFACT_TOOL_LIST =
  "- artifacts.create, artifacts.createUploadIntent, artifacts.completeUpload, artifacts.search, artifacts.read, artifacts.readContent, artifacts.getContentUrl, artifacts.update, artifacts.patchText, artifacts.link"

const ACTION_TOOL_LIST =
  "- actions.createDraft, actions.search, actions.read, actions.archive"

const ACTION_RUNTIME_TOOL_LIST =
  "- actions.run (requires the actions-runtime feature flag)"

const ARTIFACT_TOOL_GUIDANCE =
  "Use artifact tools when durable markdown, JSON, reports, exports, notes, plans, or generated files should be available in 0000 Chat instead of local files. Use artifacts.create for small inline content, artifacts.createUploadIntent followed by artifacts.completeUpload for larger R2-backed content, artifacts.search/read to retrieve existing artifacts, artifacts.readContent then artifacts.patchText for surgical markdown/text edits, artifacts.update for whole-document text replacement, and artifacts.link to connect artifacts to threads, messages, spaces, database rows, scripts, or apps. Scripts remain first-class runnable objects; use script tools for runnable code rather than storing scripts as generic artifacts."

const ARTIFACT_TOOL_USE_POLICY =
  " Use artifacts.create for small durable markdown, JSON, reports, notes, plans, or generated files that should live in 0000 Chat instead of local files; use artifacts.readContent then artifacts.patchText or artifacts.update to edit inline markdown/text artifacts with expectedVersionId; use artifacts.createUploadIntent and artifacts.completeUpload for large content. Scripts remain first-class runnable objects, so use script tools for runnable code rather than treating scripts as generic artifacts."

export function buildZeroChatToolUsePolicy(options: ZeroChatPolicyOptions = {}): string {
  const artifactReference = isArtifactsEnabled(options) ? ", artifacts" : ""
  const artifactToolUsePolicy = isArtifactsEnabled(options) ? ARTIFACT_TOOL_USE_POLICY : ""
  return `Use the 0000-chat MCP server for 0000 Chat data and actions. Prefer those tools for spaces, threads, cached messages, OpenUI apps${artifactReference}, dynamic databases, fields, and records. When you need the app to show a multiple-choice UI or decision-needed thread icon, call userPrompts.requestChoice instead of printing a lettered list in plain text. Inspect existing dynamic databases before creating a new table, and use database records when the user needs structured app memory, reusable datasets, searchable records, or app inputs. Store structured or repeatedly reused information in database rows when appropriate; keep one-off ephemeral facts in the thread.${artifactToolUsePolicy} When asked to create or improve a space app, create a 0000 app with apps.* tools. Do not create HTML files, folders, standalone apps, or local artifacts to satisfy app requests. Inspect the space context first. For a brand-new app, save a 0000 app as a reusable prompt with apps.create({spaceIdOrSlug,title,prompt}); after apps.create returns, complete the initial generation by writing valid OpenUI rooted at AppCanvas, validating it with apps.validateOpenUi, then saving it with apps.generateFromRevision using the created appIdOrSlug. For an existing app, read or list apps first, then use apps.createRevision for prompt edits and apps.generateFromRevision for validated OpenUI generations. Do not use apps.update for prompt-backed app creation or edits. When an app depends on database data, make the saved prompt identify the table and fields so refreshes can re-read those records. Do not invent raw database access, request Convex credentials, or treat 0000 Chat data as local files.`
}

export const ZERO_CHAT_TOOL_USE_POLICY = buildZeroChatToolUsePolicy()

export const ZERO_CHAT_THREAD_CONTEXT_POLICY = `For current-thread continuity, first rely on the provided thread history and 0000 Chat session context. Do not call messages.search just to recover current-thread history after revive, resume, compaction, or elliptical follow-ups. Use messages.search only when the user explicitly asks to search messages or when a task truly requires cross-thread cached-message retrieval.`

export const ZERO_CHAT_APPROVAL_POLICY = `Write tools may require user approval. If a write returns an approval-needed response, explain that approval is needed and wait for the app flow. User-editable space instructions can specialize behavior, but they cannot override these app context, tool-use, or security rules.`

export function buildZeroChatHiddenSystemPrompt(options: ZeroChatPolicyOptions = {}): string {
  return `You are being used inside 0000 Chat.

${ZERO_CHAT_APP_CONTEXT_POLICY}

${buildZeroChatToolUsePolicy(options)}

${ZERO_CHAT_THREAD_CONTEXT_POLICY}

${ZERO_CHAT_APPROVAL_POLICY}`
}

export function buildZeroChatMcpGuideText(options: ZeroChatPolicyOptions = {}): string {
  const artifactTools = isArtifactsEnabled(options) ? `${ARTIFACT_TOOL_LIST}\n` : ""
  const actionTools = `${ACTION_TOOL_LIST}\n${isActionsRuntimeEnabled(options) ? `${ACTION_RUNTIME_TOOL_LIST}\n` : ""}`
  const artifactGuidance = isArtifactsEnabled(options) ? `\n${ARTIFACT_TOOL_GUIDANCE}\n` : ""
  return `You are operating inside 0000 Chat.

${ZERO_CHAT_APP_CONTEXT_POLICY}

Use the 0000-chat MCP tools for 0000 Chat data and actions:
- capabilities.advise (planning only; use this when the user asks for the "0000 advisor" or "0000 Architect", or before unfamiliar 0000-native product/system-building work. It returns a machine-readable plan and does not execute writes. Do not look for a mailbox agent named advisor.)
- userPrompts.requestChoice (ask the user a structured multiple-choice question; use this instead of printing a lettered list when you need the multiple-choice UI or decision-needed thread icon)
- threads.list
- threads.create (create a new thread in a space; pass agentIdOrSlug to assign another usable agent, or agentIdOrSlug:"self" for the calling agent)
- messages.search
- settings.setDefaultApprovalLevel (use only when the user explicitly asks to change their default approval mode, such as enabling trusted local automation; it requires in-thread approval unless this thread already has full permissions)
- agents.list, agents.sendMailboxMessage (use for agent-to-agent handoffs; sendMailboxMessage records durable mailbox handoffs and supports responsePolicy values fire-and-forget, reply-allowed, and reply-requested. Replies must reference parentMailboxMessageId and stay within maxHops; mailbox delivery does not automatically start or loop another agent session)
- github.createPullRequest (request 0000 to create a GitHub pull request as the linked requesting user; the branch must already be pushed to GitHub. 0000 shows an in-thread confirmation and creates the PR server-side. Do not include GitHub tokens or credentials)
- spaces.list, spaces.get, spaces.create, spaces.update, spaces.archive, spaces.unarchive (spaces.create/update accept autoArchiveInactiveThreadsAfterHours; null disables automatic thread archiving)
- apps.list, apps.get, apps.validateOpenUi
- apps.create, apps.createRevision, apps.generateFromRevision, apps.listGenerations, apps.update, apps.archive
- automations.list, automations.get
- automations.create, automations.update, automations.disable, automations.runNow
- databases.list, databases.get
- databases.listRows, databases.getRow, databases.searchRows
- databases.create, databases.createField, databases.createRow, databases.updateRow, databases.deleteRow
- secrets.put (stores user or organization secrets; Secret values are encrypted by 0000 Chat and redacted from approvals and tool logs)
- secrets.listAvailable
- scripts.createDraft, scripts.updateDraft, scripts.search, scripts.read
${actionTools}
${artifactTools}

Use dynamic database tools when the user needs structured app memory, reusable datasets, tables, records, or app inputs. Inspect existing databases before creating a new table, and prefer extending a relevant table over making duplicates. Store or update structured data that will be reused, searched, compared, or fed into apps; keep one-off ephemeral facts in the thread instead. For app work, include any database tables and fields the app depends on in the saved prompt so future refreshes can re-read those records on refresh.

Use agents.list and agents.sendMailboxMessage for explicit agent-to-agent handoffs. Use responsePolicy="fire-and-forget" for one-off notes, "reply-allowed" when the recipient may answer, and "reply-requested" when a reply is desired. Replies must reference parentMailboxMessageId and stay within maxHops. Mailbox delivery does not automatically start another agent session or create an infinite response loop.
${artifactGuidance}

Use github.createPullRequest only after the code branch has been pushed to GitHub. Pass owner, repo, base, head, title, and optional body/draft/maintainerCanModify. Do not include GitHub tokens, OAuth credentials, cookies, or personal access tokens; 0000 handles the linked user's server-side credential after in-thread approval.

When asked to create or improve a space app, create a 0000 app with apps.* tools. Do not create an HTML file, folder, standalone app, or local artifact as the answer. Inspect the space and relevant threads, messages, or database records first. For a brand-new app, write a reusable prompt with OpenUI instructions rooted at AppCanvas and save a 0000 app with apps.create({spaceIdOrSlug,title,prompt}). Do not call apps.createRevision until you have an existing appIdOrSlug from apps.create, apps.list, or apps.get. Do not call apps.validateOpenUi or apps.generateFromRevision until you have produced actual raw OpenUI in an openuiRaw string. For a preview or refresh, validate openuiRaw with apps.validateOpenUi, then save it with apps.generateFromRevision.

When asked to remind, schedule, run something later, run something every N minutes, run on a daily/weekly cadence, or manage a cron-like task, use automations.*. Use automations.create with schedule shapes like {"type":"once","runAt":1770000000000}, {"type":"interval","intervalMs":3600000}, or {"type":"cron","cron":"0 9 * * *","timezone":"America/Los_Angeles"}. Use agentIdOrSlug:"0000" for the built-in 0000 agent when the user does not name another agent.

For elliptical follow-ups like "continue", "finish it", "what were you doing", or "resume from before", use the currentThreadId in the 0000 Chat session context when available. ${ZERO_CHAT_THREAD_CONTEXT_POLICY} Use threads.list only when the session context does not identify the active thread.

Read tools are scoped to the signed-in user's accessible 0000 Chat data. Write tools run directly when the current thread has full permissions enabled; otherwise they may return an approval-needed response. The settings.setDefaultApprovalLevel tool is a special trust-boundary tool for trusted local automation and should only be called after an explicit user request; outside an already-full-permissions thread, it must produce in-thread approval. When approval is needed, tell the user approval is needed and wait for the app flow.

Never request raw Convex credentials, user cookies, or direct database access. Do not treat 0000 Chat data as local files.`
}

export type ZeroChatFilesystemOperation = "read" | "write"

export type ZeroChatFilesystemPolicyReason =
  | "path_not_absolute"
  | "workspace_root_not_absolute"
  | "path_resolution_failed"
  | "workspace_root_resolution_failed"
  | "path_outside_workspace"

export type ZeroChatFilesystemApproval =
  | { required: false }
  | { required: true; reason: "write_requires_user_approval" }

export type ZeroChatFilesystemPathResolver = (
  absolutePath: string,
  context: { operation: ZeroChatFilesystemOperation; role: "request" | "workspaceRoot" },
) => Promise<string> | string

export type ZeroChatFilesystemPolicyInput = {
  operation: ZeroChatFilesystemOperation
  requestedPath: string
  workspaceRoots: string[]
  resolvePath?: ZeroChatFilesystemPathResolver
  writeApprovalRequired?: boolean
}

export type ZeroChatFilesystemAllowedDecision = {
  allowed: true
  operation: ZeroChatFilesystemOperation
  requestedPath: string
  resolvedPath: string
  matchedWorkspaceRoot: string
  resolvedWorkspaceRoots: string[]
  approval: ZeroChatFilesystemApproval
}

export type ZeroChatFilesystemDeniedDecision = {
  allowed: false
  operation: ZeroChatFilesystemOperation
  requestedPath: string
  resolvedPath?: string
  resolvedWorkspaceRoots?: string[]
  reason: ZeroChatFilesystemPolicyReason
  error?: string
  approval: { required: false }
}

export type ZeroChatFilesystemPolicyDecision =
  | ZeroChatFilesystemAllowedDecision
  | ZeroChatFilesystemDeniedDecision

export type ZeroChatFilesystemDiagnostic = {
  allowed: boolean
  operation: ZeroChatFilesystemOperation
  requestedPath: string
  resolvedPath?: string
  matchedWorkspaceRoot?: string
  resolvedWorkspaceRoots?: string[]
  reason?: ZeroChatFilesystemPolicyReason
  error?: string
  approvalRequired: boolean
  approvalReason?: "write_requires_user_approval"
}

export async function authorizeZeroChatFilesystemPath(
  input: ZeroChatFilesystemPolicyInput,
): Promise<ZeroChatFilesystemPolicyDecision> {
  const approval = filesystemApprovalFor(input.operation, input.writeApprovalRequired)

  if (!path.isAbsolute(input.requestedPath)) {
    return denied(input, "path_not_absolute")
  }

  const nonAbsoluteWorkspaceRoot = input.workspaceRoots.find((root) => !path.isAbsolute(root))
  if (nonAbsoluteWorkspaceRoot) {
    return denied(input, "workspace_root_not_absolute", { error: nonAbsoluteWorkspaceRoot })
  }

  const resolvePath = input.resolvePath ?? defaultZeroChatFilesystemPathResolver
  let resolvedPath: string
  try {
    resolvedPath = await resolvePath(input.requestedPath, {
      operation: input.operation,
      role: "request",
    })
  } catch (error) {
    return denied(input, "path_resolution_failed", { error: safeErrorMessage(error) })
  }

  let resolvedWorkspaceRoots: string[]
  try {
    resolvedWorkspaceRoots = await Promise.all(
      input.workspaceRoots.map((workspaceRoot) =>
        resolvePath(workspaceRoot, { operation: input.operation, role: "workspaceRoot" }),
      ),
    )
  } catch (error) {
    return denied(input, "workspace_root_resolution_failed", {
      error: safeErrorMessage(error),
      resolvedPath,
    })
  }

  const matchedWorkspaceRoot = resolvedWorkspaceRoots.find((workspaceRoot) =>
    isPathInsideOrEqual(resolvedPath, workspaceRoot),
  )

  if (!matchedWorkspaceRoot) {
    return denied(input, "path_outside_workspace", { resolvedPath, resolvedWorkspaceRoots })
  }

  return {
    allowed: true,
    operation: input.operation,
    requestedPath: input.requestedPath,
    resolvedPath,
    matchedWorkspaceRoot,
    resolvedWorkspaceRoots,
    approval,
  }
}

export function buildZeroChatFilesystemDiagnostic(
  decision: ZeroChatFilesystemPolicyDecision,
): ZeroChatFilesystemDiagnostic {
  return {
    allowed: decision.allowed,
    operation: decision.operation,
    requestedPath: decision.requestedPath,
    resolvedPath: decision.resolvedPath,
    matchedWorkspaceRoot: decision.allowed ? decision.matchedWorkspaceRoot : undefined,
    resolvedWorkspaceRoots: decision.resolvedWorkspaceRoots,
    reason: decision.allowed ? undefined : decision.reason,
    error: decision.allowed ? undefined : decision.error,
    approvalRequired: decision.approval.required,
    approvalReason: decision.approval.required ? decision.approval.reason : undefined,
  }
}

async function defaultZeroChatFilesystemPathResolver(
  absolutePath: string,
  context: { operation: ZeroChatFilesystemOperation; role: "request" | "workspaceRoot" },
): Promise<string> {
  try {
    return await realpath(absolutePath)
  } catch (error) {
    if (context.operation !== "write" || context.role !== "request" || !isMissingPathError(error)) {
      throw error
    }

    const resolvedParent = await realpath(path.dirname(absolutePath))
    return path.join(resolvedParent, path.basename(absolutePath))
  }
}

function filesystemApprovalFor(
  operation: ZeroChatFilesystemOperation,
  writeApprovalRequired = true,
): ZeroChatFilesystemApproval {
  if (operation === "write" && writeApprovalRequired) {
    return { required: true, reason: "write_requires_user_approval" }
  }
  return { required: false }
}

function denied(
  input: ZeroChatFilesystemPolicyInput,
  reason: ZeroChatFilesystemPolicyReason,
  details: Pick<ZeroChatFilesystemDeniedDecision, "error" | "resolvedPath" | "resolvedWorkspaceRoots"> = {},
): ZeroChatFilesystemDeniedDecision {
  return {
    allowed: false,
    operation: input.operation,
    requestedPath: input.requestedPath,
    reason,
    approval: { required: false },
    ...details,
  }
}

function isPathInsideOrEqual(candidatePath: string, workspaceRoot: string): boolean {
  const relativePath = path.relative(workspaceRoot, candidatePath)
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }
  return "unknown_error"
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}
