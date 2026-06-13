import { describe, expect, test } from "bun:test"

import {
  evaluateConformanceForClaim,
  runRuntimeConformance,
  summarizeRuntimeConformance,
  type RuntimeConformanceRecord,
} from "./runtime-conformance"

function passing(patch: Partial<RuntimeConformanceRecord> = {}): RuntimeConformanceRecord {
  return {
    checkedAt: 1_000,
    diagnostics: [],
    runtimeId: "codex",
    state: "passing",
    strength: "prompt_smoke",
    ...patch,
  }
}

describe("runtime conformance", () => {
  test("permits claims only for fresh passing prompt-smoke conformance", () => {
    expect(
      evaluateConformanceForClaim({
        now: 61_000,
        record: passing(),
        requiredStrength: "prompt_smoke",
        ttlMs: 60_000,
      }),
    ).toEqual({ ok: true })
    expect(
      evaluateConformanceForClaim({
        now: 61_001,
        record: passing(),
        requiredStrength: "prompt_smoke",
        ttlMs: 60_000,
      }),
    ).toMatchObject({ ok: false, reasonCode: "runtime_conformance_stale" })
    expect(
      evaluateConformanceForClaim({
        now: 1_000,
        record: null,
        requiredStrength: "prompt_smoke",
        ttlMs: 60_000,
      }),
    ).toMatchObject({ ok: false, reasonCode: "runtime_conformance_missing" })
    expect(
      evaluateConformanceForClaim({
        now: 1_000,
        record: passing({ state: "failing" }),
        requiredStrength: "prompt_smoke",
        ttlMs: 60_000,
      }),
    ).toMatchObject({ ok: false, reasonCode: "runtime_conformance_failed" })
    expect(
      evaluateConformanceForClaim({
        now: 1_000,
        record: passing({ state: "quarantined" }),
        requiredStrength: "prompt_smoke",
        ttlMs: 60_000,
      }),
    ).toMatchObject({ ok: false, reasonCode: "runtime_quarantined" })
    expect(
      evaluateConformanceForClaim({
        now: 1_000,
        record: passing({ strength: "init_only" }),
        requiredStrength: "prompt_smoke",
        ttlMs: 60_000,
      }),
    ).toMatchObject({ ok: false, reasonCode: "runtime_conformance_insufficient" })
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

  test("records prompt-smoke conformance for runtimes that initialize and answer", async () => {
    const record = await runRuntimeConformance({
      createSession: () => ({
        close: async () => {},
        sendUserMessage: async () => ({
          events: [],
          rawResult: {},
          sessionId: "scratch-session",
          text: "ok",
        }),
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
      strength: "prompt_smoke",
    })
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
