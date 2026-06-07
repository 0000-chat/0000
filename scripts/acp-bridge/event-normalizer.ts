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
  source: "hermes_acp" | "bridge"
  eventType: string
  sessionId?: string
  externalRequestId?: string
  payload: unknown
  part?: BridgeMessagePart
}

type JsonRecord = Record<string, unknown>

type NormalizedAvailableCommand = {
  name: string
  description?: string
  inputHint?: string
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
  const sessionUpdate =
    maybeRecord(rawSessionUpdate) ??
    (record.method === "session/request_permission" ? params : update)
  const kind =
    readString(rawSessionUpdate) ??
    readString(sessionUpdate.type) ??
    readString(sessionUpdate.kind) ??
    readString(record.method) ??
    "event"
  const eventType = normalizeAcpEventType(kind)
  const externalEventId = buildExternalEventId(sessionId, sequence, eventType)

  return {
    externalEventId,
    source: "hermes_acp",
    eventType,
    sessionId,
    externalRequestId: readString(record.id) ?? readNumberString(record.id),
    payload: normalizeEventPayload(kind, record),
    part: normalizeSessionUpdatePart(kind, sessionUpdate),
  }
}

function normalizeAcpEventType(kind: string): string {
  if (kind === "session/request_permission") {
    return "permission_request"
  }
  return kind
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

function normalizeEventPayload(kind: string, record: JsonRecord): unknown {
  if (kind === "tool_call_update" || kind === "tool_result") {
    return record
  }

  return truncateEventValue(record)
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
