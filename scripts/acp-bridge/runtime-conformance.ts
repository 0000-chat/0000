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
  sendUserMessage(text: string): Promise<HermesAcpPromptResult>
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
    const result = await session.sendUserMessage("Return exactly: ok")
    await closeQuietly(session)
    if (typeof result.text === "string" && result.text.trim().length > 0) {
      return {
        checkedAt,
        diagnostics: [],
        runtimeId: input.profile.id,
        state: "passing",
        strength: "prompt_smoke",
      }
    }
    return failingRecord(input.profile.id, checkedAt, "prompt_send_failed", "empty prompt smoke")
  } catch (error) {
    await closeQuietly(session)
    return failingRecord(input.profile.id, checkedAt, "prompt_send_failed", error)
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
      requiredStrength: "prompt_smoke",
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
  const canClaim = entries.every((entry) => entry.canClaim)
  const hasPassing = entries.some((entry) => entry.canClaim)
  return {
    canClaim,
    profiles,
    status: canClaim ? "healthy" : hasPassing ? "degraded" : "unavailable",
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
