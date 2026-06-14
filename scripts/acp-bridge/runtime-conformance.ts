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
    }
  >
  status: "healthy" | "degraded" | "unavailable"
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

export function refreshActiveRuntimeConformanceRecords(input: {
  activeRuntimeProfileIds: Iterable<string>
  now: number
  records: Record<string, RuntimeConformanceRecord>
  requiredStrength?: Exclude<RuntimeConformanceStrength, "none">
}): Record<string, RuntimeConformanceRecord> {
  const activeRuntimeProfileIds = new Set(input.activeRuntimeProfileIds)
  if (activeRuntimeProfileIds.size === 0) {
    return input.records
  }
  const requiredStrength = input.requiredStrength ?? "init_only"
  let changed = false
  const records = { ...input.records }
  for (const runtimeId of activeRuntimeProfileIds) {
    const record = records[runtimeId]
    if (
      !record ||
      record.state !== "passing" ||
      STRENGTH_RANK[record.strength] < STRENGTH_RANK[requiredStrength]
    ) {
      continue
    }
    if (record.checkedAt >= input.now) {
      continue
    }
    records[runtimeId] = { ...record, checkedAt: input.now }
    changed = true
  }
  return changed ? records : input.records
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
  now: number
  profiles: BridgeRuntimeProfile[]
  records: Record<string, RuntimeConformanceRecord | undefined>
  ttlMs?: number
}): RuntimeConformanceSummary {
  const ttlMs = input.ttlMs ?? DEFAULT_RUNTIME_CONFORMANCE_TTL_MS
  const profiles: RuntimeConformanceSummary["profiles"] = {}
  for (const profile of input.profiles.filter((candidate) => candidate.status === "available")) {
    const record = input.records[profile.id]
    const decision = evaluateConformanceForClaim({
      now: input.now,
      record,
      requiredStrength: "init_only",
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
      canClaim: decision.ok,
      ...(!decision.ok ? { reasonCode: decision.reasonCode } : {}),
    }
  }
  const entries = Object.values(profiles)
  const hasPassing = entries.some((entry) => entry.canClaim)
  const allPassing = entries.every((entry) => entry.canClaim)
  const canClaim = entries.length === 0 || hasPassing
  return {
    canClaim,
    profiles,
    status: allPassing ? "healthy" : hasPassing ? "degraded" : "unavailable",
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
