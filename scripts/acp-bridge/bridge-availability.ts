export type BridgeAvailabilityStatus = "healthy" | "degraded" | "unavailable"

type RuntimeConformanceEntry = {
  canClaim?: boolean
  reasonCode?: string
  state?: string
}

type RuntimeConformanceAvailabilitySummary = {
  canClaim: boolean
  launchSpecs?: Record<string, RuntimeConformanceEntry>
  profiles?: Record<string, RuntimeConformanceEntry>
  status: string
}

export function classifyBridgeCloudFailure(input: {
  body?: string
  status?: number
}): "auth_failed" | "retryable" {
  const body = input.body ?? ""
  if (
    input.status === 401 ||
    input.status === 403 ||
    /bridge credentials are invalid/i.test(body) ||
    /bridge token is invalid/i.test(body) ||
    /bridge token scope is invalid/i.test(body) ||
    /bridge device is not paired/i.test(body) ||
    /bridge device revoked/i.test(body)
  ) {
    return "auth_failed"
  }
  return "retryable"
}

export function deriveBridgeAvailability(input: {
  connected: boolean
  processHealth?: { canClaim: boolean; status: string }
  runtimeConformance?: RuntimeConformanceAvailabilitySummary
}):
  | { canClaim: true; reasonCode?: string; status: "healthy" | "degraded" }
  | { canClaim: false; reasonCode: string; status: BridgeAvailabilityStatus } {
  if (!input.connected) {
    return { canClaim: false, reasonCode: "bridge_unavailable", status: "unavailable" }
  }
  if (input.processHealth && !input.processHealth.canClaim) {
    return { canClaim: false, reasonCode: "process_health_unsafe", status: "degraded" }
  }
  if (input.runtimeConformance && !input.runtimeConformance.canClaim) {
    if (runtimeConformanceCanRefreshWithoutBlocking(input.runtimeConformance)) {
      return {
        canClaim: true,
        reasonCode: "runtime_conformance_refresh_needed",
        status: "degraded",
      }
    }
    return {
      canClaim: false,
      reasonCode: "runtime_conformance_unavailable",
      status: input.runtimeConformance.status === "degraded" ? "degraded" : "unavailable",
    }
  }
  return { canClaim: true, status: "healthy" }
}

function runtimeConformanceCanRefreshWithoutBlocking(
  runtimeConformance: RuntimeConformanceAvailabilitySummary,
): boolean {
  const entries = [
    ...Object.values(runtimeConformance.profiles ?? {}),
    ...Object.values(runtimeConformance.launchSpecs ?? {}),
  ]
  const blockedEntries = entries.filter((entry) => entry.canClaim === false)
  return (
    blockedEntries.length > 0 &&
    blockedEntries.every((entry) => {
      if (entry.reasonCode === "runtime_conformance_missing") {
        return true
      }
      return (
        entry.reasonCode === "runtime_conformance_stale" &&
        entry.state === "passing"
      )
    })
  )
}
