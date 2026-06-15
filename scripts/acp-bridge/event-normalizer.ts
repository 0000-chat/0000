export type BridgeMessagePartType =
  | "text"
  | "thinking"
  | "code"
  | "tool_call"
  | "tool_result"
  | "choice"
  | "approval_request"
  | "attachment"
  | "error"
  | "event"

export type BridgeMessagePart = {
  type: BridgeMessagePartType
  text?: string
  json?: unknown
  reasoningVisibility?: "hidden" | "user_visible_summary"
  status?: "streaming" | "complete" | "error"
}

export type NormalizedBridgeEvent = {
  externalEventId: string
  source: "acp_bridge" | "bridge"
  eventType: string
  providerSequence?: number
  sessionId?: string
  externalRequestId?: string
  payload: unknown
  part?: BridgeMessagePart
  attachmentUpload?: BridgeAttachmentUploadCandidate
}

export type RuntimeLogSeverity = "debug" | "info" | "warn" | "error"

export type RuntimeLogClassification = {
  severity: RuntimeLogSeverity
  text: string
}

export type BridgeAttachmentUploadCandidate =
  | {
      kind: "base64"
      dataBase64: string
      filename: string
      mediaType?: string
      sizeBytes?: number
    }
  | {
      kind: "local_file"
      path: string
      filename?: string
      mediaType?: string
      sizeBytes?: number
    }

type JsonRecord = Record<string, unknown>

type NormalizedAvailableCommand = {
  name: string
  description?: string
  inputHint?: string
}

type ResolvedSessionUpdate = {
  kind: string
  update: JsonRecord
}

const MAX_EVENT_STRING_LENGTH = 12_000
const MAX_EVENT_ARRAY_LENGTH = 50
const MAX_EVENT_OBJECT_KEYS = 80
const MAX_EVENT_DEPTH = 6
const REDACTED_EVENT_VALUE = "[REDACTED]"
const SENSITIVE_EVENT_KEY_PATTERN =
  /(?:authorization|bridgeToken|token|secret|password|apiKey|api_key|x-api-key|x_api_key|accessToken|refreshToken|connectionString|connection_string|databaseUrl|database_url)/i
const BEARER_TOKEN_PATTERN = /Bearer\s+[^\s,}\]]+/gi
const KEY_VALUE_SECRET_PATTERN =
  /("?(?:authorization|bridgeToken|token|secret|password|apiKey|api_key|x-api-key|x_api_key|accessToken|refreshToken|connectionString|connection_string|databaseUrl|database_url)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}&]+)/gi

export function normalizeAcpNotification(
  message: unknown,
  sequence: number,
): NormalizedBridgeEvent {
  const record = asRecord(message)
  const params = asRecord(record.params)
  const sessionId = readString(params.sessionId)
  const update = asRecord(params.update)
  const rawSessionUpdate = update.sessionUpdate ?? params.sessionUpdate
  const resolvedSessionUpdate = resolveSessionUpdate(
    rawSessionUpdate,
    update,
    params,
    readString(record.method),
  )
  const sessionUpdate = resolvedSessionUpdate.update
  const eventType = normalizeAcpEventType(resolvedSessionUpdate.kind)
  const externalEventId = buildExternalEventId(sessionId, sequence, eventType)
  const attachmentUpload = normalizeAttachmentUploadCandidate(eventType, sessionUpdate)

  return {
    externalEventId,
    source: "acp_bridge",
    eventType,
    providerSequence: sequence,
    sessionId,
    externalRequestId: readString(record.id) ?? readNumberString(record.id),
    payload: attachmentUpload
      ? sanitizeAttachmentUploadPayload(eventType, attachmentUpload)
      : normalizeEventPayload(eventType, record, sessionUpdate),
    part: attachmentUpload
      ? {
          type: "event",
          text: "Agent emitted an attachment.",
          json: sanitizeAttachmentUploadPayload(eventType, attachmentUpload),
          status: "streaming",
        }
      : normalizeSessionUpdatePart(eventType, sessionUpdate),
    attachmentUpload,
  }
}

function normalizeAcpEventType(kind: string): string {
  if (kind === "session/request_permission") {
    return "permission_request"
  }
  const normalized = kind
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase()
  if (isKnownAcpEventType(normalized)) {
    return normalized
  }
  return kind
}

function resolveSessionUpdate(
  rawSessionUpdate: unknown,
  update: JsonRecord,
  params: JsonRecord,
  method: string | undefined,
): ResolvedSessionUpdate {
  const rawKind = readString(rawSessionUpdate)
  if (rawKind) {
    return { kind: rawKind, update }
  }

  const rawRecord = maybeRecord(rawSessionUpdate)
  if (rawRecord) {
    const typedKind = readString(rawRecord.type) ?? readString(rawRecord.kind)
    if (typedKind) {
      return { kind: typedKind, update: mergeSessionUpdatePayload(update, rawRecord) }
    }

    const variant = readSingleSessionUpdateVariant(rawRecord)
    if (variant) {
      return {
        kind: variant.kind,
        update: mergeSessionUpdatePayload(update, variant.update),
      }
    }

    return {
      kind: readString(rawRecord.type) ?? readString(rawRecord.kind) ?? method ?? "event",
      update: rawRecord,
    }
  }

  const fallbackUpdate = method === "session/request_permission" ? params : update
  return {
    kind:
      readString(fallbackUpdate.type) ?? readString(fallbackUpdate.kind) ?? method ?? "event",
    update: fallbackUpdate,
  }
}

function readSingleSessionUpdateVariant(
  rawRecord: JsonRecord,
): ResolvedSessionUpdate | undefined {
  const entries = Object.entries(rawRecord)
  if (entries.length !== 1) {
    return undefined
  }
  const [kind, value] = entries[0] ?? []
  if (!kind || !isKnownAcpEventType(normalizeAcpEventType(kind))) {
    return undefined
  }
  return { kind, update: asRecord(value) }
}

function mergeSessionUpdatePayload(update: JsonRecord, payload: JsonRecord): JsonRecord {
  const { sessionUpdate: _sessionUpdate, ...outerUpdate } = update
  return { ...outerUpdate, ...payload }
}

function isKnownAcpEventType(kind: string): boolean {
  return (
    kind === "agent_message_chunk" ||
    kind === "user_message_chunk" ||
    kind === "agent_thought_chunk" ||
    kind === "code_chunk" ||
    kind === "tool_call" ||
    kind === "tool_call_update" ||
    kind === "tool_result" ||
    kind === "plan" ||
    kind === "plan_update" ||
    kind === "plan_removed" ||
    kind === "available_commands_update" ||
    kind === "permission_request" ||
    kind === "file"
  )
}

export function normalizeBridgeError(
  error: unknown,
  sequence: number,
  sessionId?: string,
): NormalizedBridgeEvent {
  const message = error instanceof Error ? error.message : String(error)
  return {
    externalEventId: buildExternalEventId(sessionId, sequence, "bridge_error"),
    source: "bridge",
    eventType: "bridge_error",
    sessionId,
    payload: { message },
    part: { type: "error", text: message, status: "error" },
  }
}

export function normalizeRuntimeDiagnostic(
  diagnostic: RuntimeLogClassification,
  sequence: number,
  sessionId?: string,
): NormalizedBridgeEvent {
  return {
    externalEventId: buildExternalEventId(sessionId, sequence, "runtime_diagnostic"),
    source: "bridge",
    eventType: "runtime_diagnostic",
    sessionId,
    payload: {
      message: truncateEventText(diagnostic.text),
      severity: diagnostic.severity,
    },
    part: {
      type: "event",
      json: {
        message: truncateEventText(diagnostic.text),
        severity: diagnostic.severity,
      },
      status: "streaming",
    },
  }
}

export function classifyRuntimeLogLine(line: string): RuntimeLogClassification | undefined {
  const text = truncateEventText(redactRuntimeLogLine(line.trim()))
  if (!text) {
    return undefined
  }
  return {
    severity: parseRuntimeLogSeverity(text),
    text,
  }
}

export function shouldSuppressRuntimeDiagnostic(
  diagnostic: RuntimeLogClassification | undefined,
): boolean {
  return diagnostic?.severity === "debug" || diagnostic?.severity === "info"
}

export function extractTextFromAcpUpdate(update: unknown): string | undefined {
  const record = asRecord(update)
  const content = asRecord(record.content)
  return (
    readString(record.text) ??
    readString(record.content) ??
    readString(content.text) ??
    readString(record.delta) ??
    readString(record.message) ??
    readString(record.markdown) ??
    readString(record.code) ??
    readString(record.output)
  )
}

function parseRuntimeLogSeverity(text: string): RuntimeLogSeverity {
  if (isRoutineCliStatusLine(text)) {
    return "info"
  }
  const explicitSeverity = parseExplicitRuntimeLogSeverity(text)
  if (explicitSeverity) {
    return explicitSeverity
  }
  if (/\b(?:fatal|panic)\b/i.test(text)) {
    return "error"
  }
  if (/(?:^|[\s:[({])(?:err|error|exception|traceback)(?:$|[\s:\])},.])/i.test(text)) {
    return "error"
  }
  if (/(?:^|[\s:[({])(?:warn|warning)(?:$|[\s:\])},.])/i.test(text)) {
    return "warn"
  }
  if (/(?:^|[\s:[({])(?:debug|trace)(?:$|[\s:\])},.])/i.test(text)) {
    return "debug"
  }
  if (/(?:^|[\s:[({])info(?:$|[\s:\])},.])/i.test(text)) {
    return "info"
  }
  if (isRoutineHermesLifecycleLogLine(text)) {
    return "info"
  }
  return "error"
}

function parseExplicitRuntimeLogSeverity(text: string): RuntimeLogSeverity | undefined {
  const match = text.match(/(?:^|[\s:[({])(?:\[)?(INFO|WARN|WARNING|ERROR|DEBUG|TRACE)(?:\])?(?:$|[\s:\])},.])/i)
  const value = match?.[1]?.toLowerCase()
  if (value === "info") {
    return "info"
  }
  if (value === "warn" || value === "warning") {
    return "warn"
  }
  if (value === "error") {
    return "error"
  }
  if (value === "debug" || value === "trace") {
    return "debug"
  }
  return undefined
}

function isRoutineCliStatusLine(text: string): boolean {
  return (
    /^The user's messages are sent from the 0000 Chat app\./.test(text) ||
    /Preflight compression:/i.test(text) ||
    /Compacting context/i.test(text)
  )
}

function isRoutineHermesLifecycleLogLine(text: string): boolean {
  return (
    /acp_adapter\.server:\s*ACP client connected/i.test(text) ||
    /Initialize from unknown \(protocol v\d+\)/i.test(text) ||
    /run_agent:\s*Loaded environment variables/i.test(text) ||
    /OpenAI client created/i.test(text) ||
    /agent\.auxiliary_client:\s*Vision auto-detect/i.test(text) ||
    /tools\.terminal_tool:\s*local environment ready/i.test(text) ||
    /OpenAI client closed/i.test(text)
  )
}

function redactRuntimeLogLine(text: string): string {
  return text
    .replace(BEARER_TOKEN_PATTERN, "Bearer [REDACTED]")
    .replace(KEY_VALUE_SECRET_PATTERN, "$1[REDACTED]")
}

function normalizeSessionUpdatePart(kind: string, update: JsonRecord): BridgeMessagePart {
  const attachment = normalizeAttachmentUpdate(kind, update)
  if (attachment) {
    return { type: "attachment", json: attachment, status: "complete" }
  }

  if (kind === "agent_message_chunk" || kind === "user_message_chunk") {
    return {
      type: "text",
      text: truncateEventText(extractTextFromAcpUpdate(update)),
      status: "streaming",
    }
  }

  if (kind === "agent_thought_chunk") {
    return {
      type: "thinking",
      text: truncateEventText(extractTextFromAcpUpdate(update)),
      reasoningVisibility: readReasoningVisibility(update),
      status: "streaming",
    }
  }

  if (kind === "code_chunk") {
    return {
      type: "code",
      text: truncateEventText(extractTextFromAcpUpdate(update)),
      json: truncateEventValue(update),
      status: "streaming",
    }
  }

  if (kind === "tool_call") {
    return { type: "tool_call", json: truncateEventValue(update), status: "streaming" }
  }

  if (kind === "tool_call_update" || kind === "tool_result") {
    return { type: "tool_result", json: compactToolEvent(update), status: "streaming" }
  }

  if (kind === "session/request_permission") {
    return { type: "approval_request", json: truncateEventValue(update), status: "streaming" }
  }

  if (kind === "choice" || kind === "choice_group") {
    return {
      type: "choice",
      text: truncateEventText(extractTextFromAcpUpdate(update)),
      json: truncateEventValue(update),
      status: "streaming",
    }
  }

  if (kind === "message_failed") {
    return {
      type: "error",
      text: truncateEventText(extractErrorText(update)),
      json: truncateEventValue(update),
      status: "error",
    }
  }

  if (kind === "available_commands_update") {
    return {
      type: "event",
      text: "Available commands updated",
      json: { availableCommands: normalizeAvailableCommandsFromUpdate(update) },
      status: "streaming",
    }
  }

  if (isPlanEventType(kind)) {
    return { type: "event", json: normalizePlanEventValue(update), status: "streaming" }
  }

  const text = truncateEventText(extractTextFromAcpUpdate(update))
  return text
    ? { type: "event", text, json: truncateEventValue(update), status: "streaming" }
    : { type: "event", json: truncateEventValue(update), status: "streaming" }
}

function normalizeAttachmentUpdate(kind: string, update: JsonRecord): JsonRecord | undefined {
  const resource =
    maybeRecord(update.attachment) ??
    maybeRecord(update.file) ??
    maybeRecord(update.image) ??
    maybeRecord(update.resource) ??
    maybeRecord(update.artifact) ??
    update
  const url =
    readString(resource.url) ??
    readString(resource.href) ??
    readString(resource.src) ??
    (maybeRecord(resource.access) ? readString(maybeRecord(resource.access)?.url) : undefined)
  const objectKey =
    readString(resource.objectKey) ?? readString(resource.key) ?? readString(resource.path)
  const filename =
    readString(resource.filename) ?? readString(resource.name) ?? readString(resource.title)
  const mediaType =
    readString(resource.mediaType) ?? readString(resource.mimeType) ?? readString(resource.contentType)
  const attachmentishKind = /(?:attachment|file|image|resource|artifact)/i.test(kind)
  if (!attachmentishKind && !(filename && (url || objectKey) && mediaType)) {
    return undefined
  }
  if (!url && !objectKey) {
    return undefined
  }
  return removeUndefinedValues({
    access: normalizeAttachmentAccess(resource.access),
    bucket: readString(resource.bucket),
    checksumSha256: readString(resource.checksumSha256),
    createdAt: readString(resource.createdAt),
    filename: filename ?? "Attachment",
    key: readString(resource.key) ?? objectKey,
    mediaType,
    objectKey,
    sizeBytes: readNumber(resource.sizeBytes) ?? readNumber(resource.size),
    status: readString(resource.status) ?? "available",
    storageBackend: readString(resource.storageBackend),
    type: "file",
    url,
  })
}

function normalizeAttachmentUploadCandidate(
  kind: string,
  update: JsonRecord,
): BridgeAttachmentUploadCandidate | undefined {
  const resource =
    maybeRecord(update.attachment) ??
    maybeRecord(update.file) ??
    maybeRecord(update.image) ??
    maybeRecord(update.resource) ??
    maybeRecord(update.artifact) ??
    update
  const attachmentishKind = /(?:attachment|file|image|resource|artifact)/i.test(kind)
  if (!attachmentishKind) {
    return undefined
  }

  const filename =
    readString(resource.filename) ?? readString(resource.name) ?? readString(resource.title)
  const mediaType =
    readString(resource.mediaType) ?? readString(resource.mimeType) ?? readString(resource.contentType)
  const sizeBytes = readNumber(resource.sizeBytes) ?? readNumber(resource.size)
  const dataBase64 =
    readString(resource.dataBase64) ??
    readString(resource.base64Data) ??
    readString(resource.contentBase64) ??
    readString(resource.bytesBase64)
  if (dataBase64 && filename) {
    return removeUndefinedValues({
      kind: "base64",
      dataBase64,
      filename,
      mediaType,
      sizeBytes,
    }) as BridgeAttachmentUploadCandidate
  }

  const localPath =
    readString(resource.localPath) ??
    readString(resource.filePath) ??
    readString(resource.path) ??
    readString(resource.uri)
  if (localPath && isLocalAttachmentPath(localPath)) {
    return removeUndefinedValues({
      kind: "local_file",
      path: localPath,
      filename,
      mediaType,
      sizeBytes,
    }) as BridgeAttachmentUploadCandidate
  }

  return undefined
}

function sanitizeAttachmentUploadPayload(
  kind: string,
  candidate: BridgeAttachmentUploadCandidate,
): JsonRecord {
  return removeUndefinedValues({
    type: "agent_attachment_upload",
    candidateKind: candidate.kind,
    eventKind: kind,
    filename: candidate.filename,
    mediaType: candidate.mediaType,
    sizeBytes: candidate.sizeBytes,
    status: "pending_upload",
  })
}

function isLocalAttachmentPath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("file://")
  )
}

function normalizeAttachmentAccess(value: unknown): JsonRecord | undefined {
  const access = maybeRecord(value)
  if (!access) {
    return undefined
  }
  const url = readString(access.url)
  if (!url) {
    return undefined
  }
  return removeUndefinedValues({
    expiresAt: readNumber(access.expiresAt),
    mode: readString(access.mode),
    url,
  })
}

function extractErrorText(update: JsonRecord): string | undefined {
  const error = asRecord(update.error)
  return readString(error.message) ?? readString(update.error) ?? extractTextFromAcpUpdate(update)
}

function normalizeEventPayload(
  kind: string,
  record: JsonRecord,
  update: JsonRecord,
): unknown {
  if (kind === "tool_call_update" || kind === "tool_result") {
    return record
  }

  if (isPlanEventType(kind)) {
    return normalizePlanEventValue(update)
  }

  return truncateEventValue(record)
}

function isPlanEventType(kind: string): boolean {
  return kind === "plan" || kind === "plan_update" || kind === "plan_removed"
}

function normalizePlanEventValue(value: JsonRecord): unknown {
  const normalized = asRecord(truncateEventValue(value, -1))
  const plan = maybeRecord(normalized.plan) ?? normalized
  const items = normalizePlanItems(normalized, plan)

  return removeUndefinedValues({
    ...normalized,
    category: "plan",
    planId:
      readString(normalized.planId) ??
      readString(normalized.id) ??
      readString(plan.id),
    items,
    associatedFiles: normalizePlanAssociatedFiles(normalized, plan, items),
  })
}

function normalizePlanItems(normalized: JsonRecord, plan: JsonRecord): unknown[] {
  return (
    arrayFromUnknown(normalized.items) ??
    arrayFromUnknown(plan.entries) ??
    arrayFromUnknown(plan.items) ??
    arrayFromUnknown(normalized.entries) ??
    []
  )
}

function normalizePlanAssociatedFiles(
  normalized: JsonRecord,
  plan: JsonRecord,
  items: unknown[],
): unknown[] {
  const files: unknown[] = []
  appendPlanFileRefs(files, arrayFromUnknown(normalized.associatedFiles))
  appendPlanFileRefs(files, arrayFromUnknown(normalized.associated_files))
  appendPlanFileRefs(files, arrayFromUnknown(plan.associatedFiles))
  appendPlanFileRefs(files, arrayFromUnknown(plan.associated_files))
  appendPlanFileRefs(files, arrayFromUnknown(plan.fileRefs))
  appendPlanFileRefs(files, arrayFromUnknown(plan.file_refs))

  for (const item of items) {
    const itemRecord = maybeRecord(item)
    if (!itemRecord) {
      continue
    }
    appendPlanFileRefs(files, arrayFromUnknown(itemRecord.associatedFiles))
    appendPlanFileRefs(files, arrayFromUnknown(itemRecord.associated_files))
    appendPlanFileRefs(files, arrayFromUnknown(itemRecord.fileRefs))
    appendPlanFileRefs(files, arrayFromUnknown(itemRecord.file_refs))
    const meta = maybeRecord(itemRecord._meta)
    if (meta) {
      appendPlanFileRefs(files, arrayFromUnknown(meta.associatedFiles))
      appendPlanFileRefs(files, arrayFromUnknown(meta.associated_files))
      appendPlanFileRefs(files, arrayFromUnknown(meta.fileRefs))
      appendPlanFileRefs(files, arrayFromUnknown(meta.file_refs))
    }
  }

  return files
}

function appendPlanFileRefs(files: unknown[], refs: unknown[] | undefined): void {
  if (!refs) {
    return
  }
  for (const ref of refs) {
    files.push(ref)
  }
}

function normalizeAvailableCommandsFromUpdate(update: JsonRecord): NormalizedAvailableCommand[] {
  const commands =
    arrayFromUnknown(update.availableCommands) ??
    arrayFromUnknown(update.available_commands) ??
    arrayFromUnknown(update.commands) ??
    []

  return commands
    .map((command) => normalizeAvailableCommand(command))
    .filter((command): command is NormalizedAvailableCommand => command !== undefined)
}

function normalizeAvailableCommand(command: unknown): NormalizedAvailableCommand | undefined {
  const record = maybeRecord(command)
  if (!record) {
    return undefined
  }
  const name = normalizeCommandName(readString(record.name) ?? readString(record.command))
  if (!name) {
    return undefined
  }
  const input = maybeRecord(record.input)
  return removeUndefinedValues({
    name,
    description: readString(record.description),
    inputHint: readString(input?.hint),
  }) as NormalizedAvailableCommand
}

function normalizeCommandName(value: string | undefined): string | undefined {
  const name = value?.trim().replace(/^\/+/, "")
  return name ? name : undefined
}

function compactToolEvent(update: JsonRecord): JsonRecord {
  const content = update.content
  const output = update.output
  const text = extractTextFromAcpUpdate(update)
  const compact: JsonRecord = {
    type: readString(update.type) ?? readString(update.kind) ?? "tool_call_update",
    state: normalizeToolState(readString(update.state) ?? readString(update.status)),
    status: readString(update.status),
    toolCallId:
      readString(update.toolCallId) ?? readString(update.tool_call_id) ?? readString(update.id),
    toolName: readString(update.toolName) ?? readString(update.name) ?? readString(update.tool),
  }

  const contentLength = valueLength(content)
  if (contentLength !== undefined) {
    compact.contentLength = contentLength
  }
  const outputLength = valueLength(output)
  if (outputLength !== undefined) {
    compact.outputLength = outputLength
  }
  if (text !== undefined) {
    compact.textLength = text.length
  }

  compact.omitted = "tool result payload omitted by bridge"
  return removeUndefinedValues(compact)
}

function readReasoningVisibility(update: JsonRecord): "hidden" | "user_visible_summary" {
  return update.reasoningVisibility === "user_visible_summary" ? "user_visible_summary" : "hidden"
}

function normalizeToolState(status: string | undefined): string | undefined {
  if (!status) {
    return undefined
  }
  const normalized = status.toLowerCase()
  if (
    normalized === "complete" ||
    normalized === "completed" ||
    normalized === "success" ||
    normalized === "succeeded" ||
    normalized === "ok"
  ) {
    return "output-available"
  }
  if (normalized === "error" || normalized === "failed" || normalized === "failure") {
    return "output-error"
  }
  if (normalized === "pending" || normalized === "streaming") {
    return "input-streaming"
  }
  if (normalized === "running" || normalized === "started") {
    return "input-available"
  }
  return undefined
}

function valueLength(value: unknown): number | undefined {
  if (typeof value === "string") {
    return value.length
  }
  if (Array.isArray(value)) {
    return value.length
  }
  if (value && typeof value === "object") {
    return Object.keys(value as JsonRecord).length
  }
  return undefined
}

function removeUndefinedValues(record: JsonRecord): JsonRecord {
  const output: JsonRecord = {}
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      output[key] = value
    }
  }
  return output
}

function buildExternalEventId(
  sessionId: string | undefined,
  sequence: number,
  kind: string,
): string {
  const sessionPart = sessionId ?? "no-session"
  return `${sessionPart}:${sequence}:${kind}`
}

function asRecord(value: unknown): JsonRecord {
  return maybeRecord(value) ?? {}
}

function maybeRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" ? (value as JsonRecord) : undefined
}

function arrayFromUnknown(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function readNumberString(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function truncateEventText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value.length <= MAX_EVENT_STRING_LENGTH) {
    return redactEventString(value)
  }
  return `${redactEventString(value.slice(0, MAX_EVENT_STRING_LENGTH))}\n…[truncated ${value.length - MAX_EVENT_STRING_LENGTH} chars]`
}

function redactEventString(value: string): string {
  return value
    .replace(BEARER_TOKEN_PATTERN, `Bearer ${REDACTED_EVENT_VALUE}`)
    .replace(KEY_VALUE_SECRET_PATTERN, (_match, prefix: string, rawValue: string) => {
      const quote = rawValue.startsWith('"') || rawValue.startsWith("'") ? rawValue[0] : ""
      return `${prefix}${quote}${REDACTED_EVENT_VALUE}${quote}`
    })
}

function truncateEventValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return truncateEventText(value)
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === undefined
  ) {
    return value
  }
  if (depth >= MAX_EVENT_DEPTH) {
    return "[truncated: max depth reached]"
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_EVENT_ARRAY_LENGTH)
      .map((item) => truncateEventValue(item, depth + 1))
    if (value.length > MAX_EVENT_ARRAY_LENGTH) {
      items.push(`[truncated ${value.length - MAX_EVENT_ARRAY_LENGTH} array items]`)
    }
    return items
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as JsonRecord)
    const output: JsonRecord = {}
    for (const [key, entryValue] of entries.slice(0, MAX_EVENT_OBJECT_KEYS)) {
      output[key] = SENSITIVE_EVENT_KEY_PATTERN.test(key)
        ? REDACTED_EVENT_VALUE
        : truncateEventValue(entryValue, depth + 1)
    }
    if (entries.length > MAX_EVENT_OBJECT_KEYS) {
      output.__truncatedKeys = entries.length - MAX_EVENT_OBJECT_KEYS
    }
    return output
  }
  return String(value)
}
