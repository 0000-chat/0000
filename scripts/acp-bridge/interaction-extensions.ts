const ZERO_CHAT_EXTENSION_PREFIX = "0000.chat/"
const REDACTED = "[redacted]"

export type ElicitationPendingInteractionId = string & {
  readonly __brand: "ElicitationPendingInteractionId"
}

export type ElicitationPendingInteraction = {
  readonly interactionId: ElicitationPendingInteractionId
  readonly sessionKey?: string
  readonly queueItemId?: string
  readonly createdAtMs: number
  readonly expiresAtMs?: number
}

export type ElicitationResponseResolution =
  | {
      readonly ok: true
      readonly interaction: ElicitationPendingInteraction
    }
  | {
      readonly ok: false
      readonly reason:
        | "missing_interaction_id"
        | "stale_interaction"
        | "ambiguous_interaction"
        | "expired_interaction"
    }

export type ZeroChatExtensionNamespaceValidation =
  | {
      readonly ok: true
      readonly namespace: string
    }
  | {
      readonly ok: false
      readonly reason:
        | "missing_namespace"
        | "missing_extension_path"
        | "foreign_namespace"
        | "malformed_extension_path"
    }

export type RedactedCorrelationMetadata =
  | null
  | boolean
  | number
  | string
  | RedactedCorrelationMetadata[]
  | { readonly [key: string]: RedactedCorrelationMetadata }

export type InteractionWorkItemReference = {
  readonly agentSessionId?: string
  readonly queueItemId?: string
  readonly sessionKey?: string
  readonly threadId?: string
}

export type InteractionLifecycleStatus = "requested" | "responded" | "resolved" | "stale"

export type ElicitationStaleReason = Extract<
  ElicitationResponseResolution,
  { readonly ok: false }
>["reason"]

export type ApprovalInteractionRecord = {
  readonly category: "approval"
  readonly approvalId: string
  readonly responseId?: string
  readonly staleReason?: ElicitationStaleReason
  readonly status: InteractionLifecycleStatus
  readonly workItem?: InteractionWorkItemReference
}

export type ElicitationInteractionKind = "elicitation" | "choice" | "choice_group"

export type ElicitationInteractionRecord = {
  readonly category: "elicitation"
  readonly elicitationKind: ElicitationInteractionKind
  readonly interactionId: string
  readonly responseId?: string
  readonly staleReason?: ElicitationStaleReason
  readonly status: InteractionLifecycleStatus
  readonly workItem?: InteractionWorkItemReference
}

const unsafeCorrelationMetadataKeyPattern =
  /(?:authorization|auth|bearer|cookie|message|password|prompt|secret|token|api[_-]?key|(?:public|private|client|server|ssh|jwt|access|refresh)[_-]?key|key[_-]?fingerprint)/i

const safeExtensionPathPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

export function buildApprovalInteractionRecord(input: {
  readonly approvalId: string
  readonly responseId?: string
  readonly staleReason?: ApprovalInteractionRecord["staleReason"]
  readonly status: InteractionLifecycleStatus
  readonly workItem?: InteractionWorkItemReference
}): ApprovalInteractionRecord {
  return omitUndefined({
    category: "approval" as const,
    approvalId: requireNonEmptyInteractionIdentifier(input.approvalId, "approval id"),
    responseId:
      input.responseId === undefined
        ? undefined
        : requireNonEmptyInteractionIdentifier(input.responseId, "approval response id"),
    staleReason: input.staleReason,
    status: input.status,
    workItem: input.workItem,
  })
}

export function buildElicitationInteractionRecord(input: {
  readonly elicitationKind: ElicitationInteractionKind
  readonly interactionId: string
  readonly responseId?: string
  readonly staleReason?: ElicitationInteractionRecord["staleReason"]
  readonly status: InteractionLifecycleStatus
  readonly workItem?: InteractionWorkItemReference
}): ElicitationInteractionRecord {
  return omitUndefined({
    category: "elicitation" as const,
    elicitationKind: input.elicitationKind,
    interactionId: requireNonEmptyInteractionIdentifier(input.interactionId, "elicitation interaction id"),
    responseId:
      input.responseId === undefined
        ? undefined
        : requireNonEmptyInteractionIdentifier(input.responseId, "elicitation response id"),
    staleReason: input.staleReason,
    status: input.status,
    workItem: input.workItem,
  })
}

export function toElicitationPendingInteractionId(
  interactionId: string,
): ElicitationPendingInteractionId | null {
  const trimmed = interactionId.trim()

  if (trimmed.length === 0 || /\s/.test(trimmed)) {
    return null
  }

  return trimmed as ElicitationPendingInteractionId
}

export function requireElicitationPendingInteractionId(
  interactionId: string,
): ElicitationPendingInteractionId {
  const parsed = toElicitationPendingInteractionId(interactionId)

  if (parsed === null) {
    throw new Error("Invalid pending elicitation interaction id")
  }

  return parsed
}

export function resolveElicitationResponseInteraction(input: {
  readonly interactionId?: string | null
  readonly pendingInteractions: readonly ElicitationPendingInteraction[]
  readonly nowMs: number
}): ElicitationResponseResolution {
  if (input.interactionId == null || input.interactionId.trim().length === 0) {
    return { ok: false, reason: "missing_interaction_id" }
  }

  const interactionId = toElicitationPendingInteractionId(input.interactionId)

  if (interactionId === null) {
    return { ok: false, reason: "missing_interaction_id" }
  }

  const matches = input.pendingInteractions.filter(
    (interaction) => interaction.interactionId === interactionId,
  )

  if (matches.length === 0) {
    return { ok: false, reason: "stale_interaction" }
  }

  if (matches.length > 1) {
    return { ok: false, reason: "ambiguous_interaction" }
  }

  const [interaction] = matches

  if (interaction === undefined) {
    return { ok: false, reason: "stale_interaction" }
  }

  if (interaction.expiresAtMs !== undefined && interaction.expiresAtMs <= input.nowMs) {
    return { ok: false, reason: "expired_interaction" }
  }

  return { ok: true, interaction }
}

export function validateZeroChatExtensionNamespace(
  namespace: string | null | undefined,
): ZeroChatExtensionNamespaceValidation {
  if (namespace == null || namespace.trim().length === 0) {
    return { ok: false, reason: "missing_namespace" }
  }

  const trimmed = namespace.trim()

  if (trimmed === "0000.chat") {
    return { ok: false, reason: "missing_extension_path" }
  }

  if (!trimmed.startsWith(ZERO_CHAT_EXTENSION_PREFIX)) {
    return { ok: false, reason: "foreign_namespace" }
  }

  const extensionPath = trimmed.slice(ZERO_CHAT_EXTENSION_PREFIX.length)

  if (extensionPath.length === 0) {
    return { ok: false, reason: "missing_extension_path" }
  }

  if (
    !safeExtensionPathPattern.test(extensionPath) ||
    extensionPath.includes("//") ||
    extensionPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return { ok: false, reason: "malformed_extension_path" }
  }

  return { ok: true, namespace: trimmed }
}

export function isZeroChatExtensionNamespace(namespace: string | null | undefined): boolean {
  return validateZeroChatExtensionNamespace(namespace).ok
}

export function redactCorrelationMetadata(value: unknown): RedactedCorrelationMetadata {
  return redactCorrelationMetadataValue(value, undefined)
}

function redactCorrelationMetadataValue(
  value: unknown,
  key: string | undefined,
): RedactedCorrelationMetadata {
  if (key !== undefined && unsafeCorrelationMetadataKeyPattern.test(key)) {
    return REDACTED
  }

  if (value == null) {
    return null
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactCorrelationMetadataValue(item, undefined))
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactCorrelationMetadataValue(entryValue, entryKey),
      ]),
    )
  }

  return String(value)
}

function requireNonEmptyInteractionIdentifier(value: string, label: string): string {
  const trimmed = value.trim()

  if (trimmed.length === 0 || /\s/.test(trimmed)) {
    throw new Error(`Invalid ${label}`)
  }

  return trimmed
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T
}
