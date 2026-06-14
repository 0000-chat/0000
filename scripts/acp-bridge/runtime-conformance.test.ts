import { describe, expect, test } from "bun:test"

import {
  evaluateConformanceForClaim,
  refreshActiveRuntimeConformanceRecords,
  runRuntimeConformance,
  shouldRefreshRuntimeConformance,
  summarizeRuntimeConformance,
  type RuntimeConformanceRecord,
} from "./runtime-conformance"

function passing(patch: Partial<RuntimeConformanceRecord> = {}): RuntimeConformanceRecord {
  return {
    checkedAt: 1_000,
    diagnostics: [],
    runtimeId: "codex",
    state: "passing",
    strength: "init_only",
    ...patch,
  }
}

describe("runtime conformance", () => {
  test("defers refreshes while bridge work is active", () => {
    expect(
      shouldRefreshRuntimeConformance({
        inFlightCommandCount: 0,
        lastProbeAt: 0,
        now: 30_000,
        runningSessionCount: 0,
        ttlMs: 60_000,
      }),
    ).toBe(true)
    expect(
      shouldRefreshRuntimeConformance({
        force: true,
        inFlightCommandCount: 0,
        lastProbeAt: 30_000,
        now: 30_001,
        runningSessionCount: 0,
        ttlMs: 60_000,
      }),
    ).toBe(true)
    expect(
      shouldRefreshRuntimeConformance({
        force: true,
        inFlightCommandCount: 0,
        lastProbeAt: 0,
        now: 120_000,
        runningSessionCount: 1,
        ttlMs: 60_000,
      }),
    ).toBe(false)
    expect(
      shouldRefreshRuntimeConformance({
        force: true,
        inFlightCommandCount: 1,
        lastProbeAt: 0,
        now: 120_000,
        runningSessionCount: 0,
        ttlMs: 60_000,
      }),
    ).toBe(false)
  })

  test("permits claims only for fresh passing init conformance", () => {
    expect(
      evaluateConformanceForClaim({
        now: 61_000,
        record: passing(),
        requiredStrength: "init_only",
        ttlMs: 60_000,
      }),
    ).toEqual({ ok: true })
    expect(
      evaluateConformanceForClaim({
        now: 61_001,
        record: passing(),
        requiredStrength: "init_only",
        ttlMs: 60_000,
      }),
    ).toMatchObject({ ok: false, reasonCode: "runtime_conformance_stale" })
    expect(
      evaluateConformanceForClaim({
        now: 1_000,
        record: null,
        requiredStrength: "init_only",
        ttlMs: 60_000,
      }),
    ).toMatchObject({ ok: false, reasonCode: "runtime_conformance_missing" })
    expect(
      evaluateConformanceForClaim({
        now: 1_000,
        record: passing({ state: "failing" }),
        requiredStrength: "init_only",
        ttlMs: 60_000,
      }),
    ).toMatchObject({ ok: false, reasonCode: "runtime_conformance_failed" })
    expect(
      evaluateConformanceForClaim({
        now: 1_000,
        record: passing({ state: "quarantined" }),
        requiredStrength: "init_only",
        ttlMs: 60_000,
      }),
    ).toMatchObject({ ok: false, reasonCode: "runtime_quarantined" })
    expect(
      evaluateConformanceForClaim({
        now: 1_000,
        record: passing({ strength: "none" }),
        requiredStrength: "init_only",
        ttlMs: 60_000,
      }),
    ).toMatchObject({ ok: false, reasonCode: "runtime_conformance_insufficient" })
    expect(
      evaluateConformanceForClaim({
        now: 1_000,
        record: passing({ strength: "init_only" }),
        requiredStrength: "prompt_smoke",
        ttlMs: 60_000,
      }),
    ).toMatchObject({ ok: false, reasonCode: "runtime_conformance_insufficient" })
  })

  test("keeps active passing runtime conformance fresh without reviving failing profiles", () => {
    const records = {
      codex: passing({ checkedAt: 1_000, runtimeId: "codex" }),
      broken: passing({ checkedAt: 1_000, runtimeId: "broken", state: "failing" }),
      idle: passing({ checkedAt: 1_000, runtimeId: "idle" }),
      weak: passing({ checkedAt: 1_000, runtimeId: "weak", strength: "init_only" }),
    }

    const refreshed = refreshActiveRuntimeConformanceRecords({
      activeRuntimeProfileIds: ["codex", "broken", "weak"],
      now: 120_000,
      records,
      requiredStrength: "prompt_smoke",
    })

    expect(refreshed.codex?.checkedAt).toBe(1_000)
    expect(refreshed.broken?.checkedAt).toBe(1_000)
    expect(refreshed.idle?.checkedAt).toBe(1_000)
    expect(refreshed.weak?.checkedAt).toBe(1_000)
    const defaultStrengthRefreshed = refreshActiveRuntimeConformanceRecords({
      activeRuntimeProfileIds: ["codex"],
      now: 120_000,
      records,
    })
    expect(defaultStrengthRefreshed.codex?.checkedAt).toBe(120_000)
    expect(
      summarizeRuntimeConformance({
        now: 120_001,
        profiles: [
          {
            capabilities: {},
            command: ["codex"],
            id: "codex",
            kind: "codex",
            label: "Codex",
            status: "available",
          },
          {
            capabilities: {},
            command: ["idle"],
            id: "idle",
            kind: "codex",
            label: "Idle",
            status: "available",
          },
        ],
        records: defaultStrengthRefreshed,
        ttlMs: 60_000,
      }),
    ).toMatchObject({ canClaim: true, status: "degraded" })
  })

  test("detects initialize failures before user sessions are bound", async () => {
    const record = await runRuntimeConformance({
      createSession: () => ({
        close: async () => {},
        sendUserMessage: async () => {
          throw new Error("should not prompt after failed init")
        },
        start: async () => {
          throw new Error("initialize_closed")
        },
      }),
      now: () => new Date("2026-06-14T00:00:00.000Z"),
      profile: {
        capabilities: {},
        command: ["codex", "acp"],
        id: "codex:default",
        kind: "codex",
        label: "Codex",
        status: "available",
      },
    })

    expect(record).toMatchObject({
      checkedAt: Date.parse("2026-06-14T00:00:00.000Z"),
      runtimeId: "codex:default",
      state: "failing",
      strength: "none",
      diagnostics: [{ reasonCode: "acp_session_create_failed" }],
    })
  })

  test("records init-only conformance without sending a prompt", async () => {
    let promptSent = false
    const record = await runRuntimeConformance({
      createSession: () => ({
        close: async () => {},
        sendUserMessage: async () => {
          promptSent = true
          return {
            events: [],
            rawResult: {},
            sessionId: "scratch-session",
            text: "ok",
          }
        },
        start: async () => "scratch-session",
      }),
      now: () => new Date("2026-06-14T00:00:00.000Z"),
      profile: {
        capabilities: {},
        command: ["codex", "acp"],
        id: "codex:default",
        kind: "codex",
        label: "Codex",
        status: "available",
      },
    })

    expect(record).toMatchObject({
      runtimeId: "codex:default",
      state: "passing",
      strength: "init_only",
    })
    expect(promptSent).toBe(false)
  })

  test("summarizes profile claimability for heartbeat status", () => {
    const now = 10_000
    expect(
      summarizeRuntimeConformance({
        now,
        profiles: [
          {
            capabilities: {},
            command: ["codex", "acp"],
            id: "codex:default",
            kind: "codex",
            label: "Codex",
            status: "available",
          },
        ],
        records: { "codex:default": passing({ checkedAt: now }) },
        ttlMs: 60_000,
      }),
    ).toMatchObject({
      canClaim: true,
      profiles: { "codex:default": { canClaim: true, state: "passing" } },
      status: "healthy",
    })

    expect(
      summarizeRuntimeConformance({
        now,
        profiles: [
          {
            capabilities: {},
            command: ["codex", "acp"],
            id: "codex:default",
            kind: "codex",
            label: "Codex",
            status: "available",
          },
        ],
        records: {},
        ttlMs: 60_000,
      }),
    ).toMatchObject({
      canClaim: false,
      profiles: {
        "codex:default": {
          canClaim: false,
          reasonCode: "runtime_conformance_missing",
        },
      },
      status: "unavailable",
    })
  })

  test("keeps bridge claimable when at least one runtime profile is healthy", () => {
    const now = 10_000

    expect(
      summarizeRuntimeConformance({
        now,
        profiles: [
          {
            capabilities: {},
            command: ["codex", "acp"],
            id: "codex:default",
            kind: "codex",
            label: "Codex",
            status: "available",
          },
          {
            capabilities: {},
            command: ["broken", "acp"],
            id: "broken:default",
            kind: "unknown-acp",
            label: "Broken",
            status: "available",
          },
        ],
        records: {
          "broken:default": passing({
            checkedAt: now,
            runtimeId: "broken:default",
            state: "failing",
            strength: "none",
          }),
          "codex:default": passing({ checkedAt: now }),
        },
        ttlMs: 60_000,
      }),
    ).toMatchObject({
      canClaim: true,
      profiles: {
        "broken:default": { canClaim: false, reasonCode: "runtime_conformance_failed" },
        "codex:default": { canClaim: true },
      },
      status: "degraded",
    })
  })
})
