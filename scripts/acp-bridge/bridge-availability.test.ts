import { describe, expect, test } from "bun:test"

import {
  classifyBridgeCloudFailure,
  deriveBridgeAvailability,
} from "./bridge-availability"

describe("bridge availability", () => {
  test("classifies auth failures separately from retryable cloud failures", () => {
    expect(classifyBridgeCloudFailure({ status: 401, body: "bridge token is invalid" })).toBe(
      "auth_failed",
    )
    expect(classifyBridgeCloudFailure({ status: 403, body: "bridge device revoked" })).toBe(
      "auth_failed",
    )
    expect(classifyBridgeCloudFailure({ status: 503, body: "try later" })).toBe("retryable")
  })

  test("derives top-level bridge availability from process and conformance health", () => {
    expect(
      deriveBridgeAvailability({
        connected: true,
        processHealth: { canClaim: true, status: "healthy" },
        runtimeConformance: { canClaim: true, status: "healthy" },
      }),
    ).toEqual({ canClaim: true, status: "healthy" })

    expect(
      deriveBridgeAvailability({
        connected: true,
        processHealth: { canClaim: false, status: "ambiguous" },
        runtimeConformance: { canClaim: true, status: "healthy" },
      }),
    ).toEqual({ canClaim: false, reasonCode: "process_health_unsafe", status: "degraded" })

    expect(
      deriveBridgeAvailability({
        connected: true,
        processHealth: { canClaim: true, status: "healthy" },
        runtimeConformance: { canClaim: false, status: "unavailable" },
      }),
    ).toEqual({
      canClaim: false,
      reasonCode: "runtime_conformance_unavailable",
      status: "unavailable",
    })
  })

  test("degraded runtime health reports degraded availability", () => {
    expect(
      deriveBridgeAvailability({
        connected: true,
        processHealth: { canClaim: true, status: "healthy" },
        runtimeConformance: { canClaim: false, status: "degraded" },
      }),
    ).toEqual({
      canClaim: false,
      reasonCode: "runtime_conformance_unavailable",
      status: "degraded",
    })
  })
})
