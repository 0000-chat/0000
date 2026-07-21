import { describe, expect, test } from "bun:test"

import {
  cloudSmokeExitCode,
  selectRegistrations,
  validateCloudSmokeFlags,
} from "./cloud-smoke"

describe("bridge cloud smoke filters", () => {
  test("can focus a single bridge registration by device id", () => {
    const registrations = [
      {
        appUrl: "https://0000.chat",
        bridgeToken: "token-a",
        deviceId: "bridge_active",
      },
      {
        appUrl: "https://0000.chat",
        bridgeToken: "token-b",
        deviceId: "bridge_stale",
      },
    ]

    expect(selectRegistrations(registrations, { deviceId: "bridge_active" })).toEqual([
      registrations[0],
    ])
  })

  test("keeps default fleet mode strict about stale registrations", () => {
    expect(
      cloudSmokeExitCode([
        {
          appUrl: "https://0000.chat",
          deviceId: "bridge_active",
          realtime: { ok: true, status: "pass" },
        },
        {
          appUrl: "https://0000.chat",
          deviceId: "bridge_stale",
          realtime: { detail: "bridge_device_not_paired", ok: false, status: "fail" },
        },
      ]),
    ).toBe(1)
  })

  test("requires an explicit stopped-bridge assertion before a claim probe", () => {
    expect(() =>
      validateCloudSmokeFlags({ bridgeStopped: false, includeClaim: true }),
    ).toThrow(/requires --bridge-stopped/)
    expect(() =>
      validateCloudSmokeFlags({ bridgeStopped: true, includeClaim: true }),
    ).not.toThrow()
    expect(() =>
      validateCloudSmokeFlags({ bridgeStopped: false, includeClaim: false }),
    ).not.toThrow()
  })
})
