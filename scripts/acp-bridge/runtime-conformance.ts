import type { HermesAcpPromptResult } from "./acp-session"
import type { BridgeRuntimeProfile } from "./runtime-profiles"

export type RuntimeConformanceStrength = "none" | "init_only" | "prompt_smoke"
export type RuntimeConformanceState = "passing" | "failing" | "quarantined"

export type RuntimeConformanceReasonCode =
  | "runtime_conformance_missing"
  | "runtime_conformance_stale"
  | "runtime_conformance_failed"
  | "runtime_quarantined"
  | "runtime_conformance_insufficient"
  | "acp_session_create_failed"
  | "prompt_send_failed"

export type RuntimeConformanceRecord = {
  checkedAt: number
  diagnostics: Array<{ message?: string; reasonCode: RuntimeConformanceReasonCode }>
  runtimeId: string
  state: RuntimeConformanceState
  strength: RuntimeConformanceStrength
}

export type RuntimeConformanceClaimDecision =
  | { ok: true }
  | { ok: false; reasonCode: RuntimeConformanceReasonCode }

export type RuntimeConformanceHealthStatus =
  | "healthy"
  | "degraded"
  | "unavailable"
  | "quarantined"

export type RuntimeConformanceSession = {
  close(): Promise<void>
  sendUserMessage?(text: string): Promise<HermesAcpPromptResult>
  start?(): Promise<string>
}

export type RuntimeConformanceSummary = {
  canClaim: boolean
  profiles: Record<
    string,
    RuntimeConformanceRecord & {
      canClaim: boolean
      reasonCode?: RuntimeConformanceReasonCode
      status: RuntimeConformanceHealthStatus
    }
  >
  status: RuntimeConformanceHealthStatus
}

export const DEFAULT_RUNTIME_CONFORMANCE_TTL_MS = 5 * 60_000

const STRENGTH_RANK: Record<RuntimeConformanceStrength, number> = {
  none: 0,
  init_only: 1,
  prompt_smoke: 2,
}

export function shouldRefreshRuntimeConformance(input: {
  force?: boolean
  inFlightCommandCount: number
  lastProbeAt: number
  now: number
  runningSessionCount: number
  ttlMs?: number
}): boolean {
  if (input.runningSessionCount > 0 || input.inFlightCommandCount > 0) {
    return false
  }
  if (input.force === true) {
    return true
  }
  return input.now - input.lastProbeAt >= (input.ttlMs ?? DEFAULT_RUNTIME_CONFORMANCE_TTL_MS) / 2
}

export function shouldRefreshRuntimeConformanceProfile(input: {
  force?: boolean
  inFlightProfileIds: Set<string>
  lastProbeAt: number
  now: number
  profileId: string
  runningSessionProfileIds: Set<string>
  ttlMs?: number
}): boolean {
  if (input.force === true) {
    return true
  }
  if (input.inFlightProfileIds.has(input.profileId)) {
    return false
  }
  if (input.runningSessionProfileIds.has(input.profileId)) {
    return false
  }
  return input.now - input.lastProbeAt >= (input.ttlMs ?? DEFAULT_RUNTIME_CONFORMANCE_TTL_MS) / 2
}

export function evaluateConformanceForClaim(input: {
  now: number
  record: RuntimeConformanceRecord | null | undefined
  requiredStrength: Exclude<RuntimeConformanceStrength, "none">
  ttlMs: number
}): RuntimeConformanceClaimDecision {
  if (!input.record) {
    return { ok: false, reasonCode: "runtime_conformance_missing" }
  }
  if (input.now - input.record.checkedAt > input.ttlMs) {
    return { ok: false, reasonCode: "runtime_conformance_stale" }
  }
  if (input.record.state === "quarantined") {
    return { ok: false, reasonCode: "runtime_quarantined" }
  }
  if (input.record.state !== "passing") {
    return { ok: false, reasonCode: "runtime_conformance_failed" }
  }
  if (STRENGTH_RANK[input.record.strength] < STRENGTH_RANK[input.requiredStrength]) {
    return { ok: false, reasonCode: "runtime_conformance_insufficient" }
  }
  return { ok: true }
}

export async function runRuntimeConformance(input: {
  createSession: (profile: BridgeRuntimeProfile) => RuntimeConformanceSession
  now?: () => Date
  profile: BridgeRuntimeProfile
}): Promise<RuntimeConformanceRecord> {
  const checkedAt = (input.now ?? (() => new Date()))().getTime()
  const session = input.createSession(input.profile)
  try {
    await session.start?.()
  } catch (error) {
    await closeQuietly(session)
    return failingRecord(input.profile.id, checkedAt, "acp_session_create_failed", error)
  }
  try {
    await closeQuietly(session)
    return {
      checkedAt,
      diagnostics: [],
      runtimeId: input.profile.id,
      state: "passing",
      strength: "init_only",
    }
  } catch (error) {
    return failingRecord(input.profile.id, checkedAt, "acp_session_create_failed", error)
  }
}

export function summarizeRuntimeConformance(input: {
  activeProfileIds?: Set<string>
  now: number
  profiles: BridgeRuntimeProfile[]
  records: Record<string, RuntimeConformanceRecord | undefined>
  ttlMs?: number
}): RuntimeConformanceSummary {
  const ttlMs = input.ttlMs ?? DEFAULT_RUNTIME_CONFORMANCE_TTL_MS
  const profiles: RuntimeConformanceSummary["profiles"] = {}
  for (const profile of input.profiles.filter((candidate) => candidate.status === "available")) {
    const record = input.records[profile.id]
    const health = summarizeRuntimeProfileHealth({
      activeProfileIds: input.activeProfileIds ?? new Set(),
      now: input.now,
      profileId: profile.id,
      record,
      ttlMs,
    })
    profiles[profile.id] = {
      ...(record ?? {
        checkedAt: 0,
        diagnostics: [],
        runtimeId: profile.id,
        state: "failing" as const,
        strength: "none" as const,
      }),
      canClaim: health.canClaim,
      status: health.status,
      ...(!health.canClaim ? { reasonCode: health.reasonCode } : {}),
    }
  }
  const entries = Object.values(profiles)
  const hasPassing = entries.some((entry) => entry.canClaim)
  const allPassing = entries.every((entry) => entry.canClaim)
  const hasDegraded = entries.some((entry) => entry.status === "degraded")
  const allQuarantined =
    entries.length > 0 && entries.every((entry) => entry.status === "quarantined")
  const canClaim = entries.length === 0 || hasPassing
  return {
    canClaim,
    profiles,
    status: allPassing
      ? "healthy"
      : hasPassing || hasDegraded
        ? "degraded"
        : allQuarantined
          ? "quarantined"
          : "unavailable",
  }
}

export function summarizeRuntimeProfileHealth(input: {
  activeProfileIds: Set<string>
  now: number
  profileId: string
  record: RuntimeConformanceRecord | null | undefined
  ttlMs?: number
}): {
  canClaim: boolean
  reasonCode?: RuntimeConformanceReasonCode
  status: RuntimeConformanceHealthStatus
} {
  const ttlMs = input.ttlMs ?? DEFAULT_RUNTIME_CONFORMANCE_TTL_MS
  const decision = evaluateConformanceForClaim({
    now: input.now,
    record: input.record,
    requiredStrength: "init_only",
    ttlMs,
  })
  if (decision.ok) {
    return { canClaim: true, status: "healthy" }
  }
  if (decision.reasonCode === "runtime_quarantined") {
    return {
      canClaim: false,
      reasonCode: decision.reasonCode,
      status: "quarantined",
    }
  }
  if (input.activeProfileIds.has(input.profileId)) {
    return {
      canClaim: false,
      reasonCode: decision.reasonCode,
      status: "degraded",
    }
  }
  return {
    canClaim: false,
    reasonCode: decision.reasonCode,
    status: "unavailable",
  }
}

function failingRecord(
  runtimeId: string,
  checkedAt: number,
  reasonCode: RuntimeConformanceReasonCode,
  error: unknown,
): RuntimeConformanceRecord {
  return {
    checkedAt,
    diagnostics: [{ message: redactErrorMessage(error), reasonCode }],
    runtimeId,
    state: "failing",
    strength: "none",
  }
}

async function closeQuietly(session: RuntimeConformanceSession): Promise<void> {
  try {
    await session.close()
  } catch {
    // Best effort: a failed conformance probe must not keep the bridge from reporting status.
  }
}

function redactErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/(token|secret|password|authorization|api[_-]?key)=\S+/gi, "$1=[redacted]")
}
