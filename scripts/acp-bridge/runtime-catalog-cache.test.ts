import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

import {
  loadRuntimeCatalogCache,
  runtimeCatalogCacheKey,
  writeRuntimeCatalogCache,
} from "./runtime-catalog-cache"
import type { RuntimeConformanceRecord } from "./runtime-conformance"
import type { BridgeRuntimeProfile } from "./runtime-profiles"

const checkedAt = Date.parse("2026-06-30T00:00:00.000Z")
const now = checkedAt + 10_000

const profile: BridgeRuntimeProfile = {
  capabilities: { sessionMcpServers: true, supportsCancel: true },
  command: ["codex", "acp"],
  diagnostics: { acp: "supported", version: "codex 1.2.3" },
  id: "codex:codex-acp",
  kind: "codex",
  label: "Codex",
  status: "available",
}

const record: RuntimeConformanceRecord = {
  checkedAt,
  diagnostics: [],
  runtimeId: profile.id,
  state: "passing",
  strength: "init_only",
}

async function tempCachePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "runtime-catalog-cache-")), "cache.json")
}

describe("runtime catalog cache", () => {
  test("loads valid cached profiles and conformance records", async () => {
    const path = await tempCachePath()
    await writeRuntimeCatalogCache({
      bridgeVersion: "0.1.28",
      cachePath: path,
      conformanceRecords: { [record.runtimeId]: record },
      now,
      profiles: [profile],
      runtimeCommandKeys: [["codex", "acp"]],
      ttlMs: 60_000,
    })

    const loaded = await loadRuntimeCatalogCache({
      bridgeVersion: "0.1.28",
      cachePath: path,
      now,
      runtimeCommandKeys: [["codex", "acp"]],
      ttlMs: 60_000,
    })

    expect(loaded?.profiles).toEqual([profile])
    expect(loaded?.conformanceRecords).toEqual({ [record.runtimeId]: record })
    expect(loaded?.cacheKey).toBe(runtimeCatalogCacheKey({
      bridgeVersion: "0.1.28",
      runtimeCommandKeys: [["codex", "acp"]],
    }))
  })

  test("rejects stale entries and schema or runtime command mismatches", async () => {
    const path = await tempCachePath()
    await writeRuntimeCatalogCache({
      bridgeVersion: "0.1.28",
      cachePath: path,
      conformanceRecords: { [record.runtimeId]: record },
      now,
      profiles: [profile],
      runtimeCommandKeys: [["codex", "acp"]],
      ttlMs: 60_000,
    })

    expect(
      await loadRuntimeCatalogCache({
        bridgeVersion: "0.1.28",
        cachePath: path,
        now: checkedAt + 60_001,
        runtimeCommandKeys: [["codex", "acp"]],
        ttlMs: 60_000,
      }),
    ).toBeNull()
    expect(
      await loadRuntimeCatalogCache({
        bridgeVersion: "0.1.29",
        cachePath: path,
        now,
        runtimeCommandKeys: [["codex", "acp"]],
        ttlMs: 60_000,
      }),
    ).toBeNull()
    expect(
      await loadRuntimeCatalogCache({
        bridgeVersion: "0.1.28",
        cachePath: path,
        now,
        runtimeCommandKeys: [["codex", "acp", "--new"]],
        ttlMs: 60_000,
      }),
    ).toBeNull()
  })

  test("writes sanitized cache files without secret-ish fields", async () => {
    const path = await tempCachePath()
    const unsafeProfile = {
      ...profile,
      bridgeToken: "bridge-token-secret",
      token: "runtime-token",
      credentials: { password: "nope" },
      diagnostics: {
        ...profile.diagnostics,
        apiKey: "sk-secret",
        detail: "provider token=secret",
      },
    } as BridgeRuntimeProfile & Record<string, unknown>
    const unsafeRecord = {
      ...record,
      diagnostics: [
        {
          message: "failed with password=hunter2 and token=secret",
          reasonCode: "acp_session_create_failed" as const,
          rawToken: "secret",
        },
      ],
      secret: "nope",
    } as unknown as RuntimeConformanceRecord & Record<string, unknown>
    const unsafeCommandProfile: BridgeRuntimeProfile = {
      ...profile,
      command: ["openclaw", "acp", "--token", "command-token-secret"],
      id: "openclaw:secret-command",
      kind: "openclaw",
      label: "OpenClaw",
    }
    const unsafeCommandRecord: RuntimeConformanceRecord = {
      ...record,
      runtimeId: unsafeCommandProfile.id,
    }

    await writeRuntimeCatalogCache({
      bridgeVersion: "0.1.28",
      cachePath: path,
      conformanceRecords: {
        [unsafeRecord.runtimeId]: unsafeRecord,
        [unsafeCommandRecord.runtimeId]: unsafeCommandRecord,
      },
      now,
      profiles: [unsafeProfile, unsafeCommandProfile],
      runtimeCommandKeys: [["codex", "acp"]],
      ttlMs: 60_000,
    })

    const raw = await readFile(path, "utf8")
    expect(raw).not.toContain("bridge-token-secret")
    expect(raw).not.toContain("runtime-token")
    expect(raw).not.toContain("hunter2")
    expect(raw).not.toContain("sk-secret")
    expect(raw).not.toContain("command-token-secret")
    expect(raw).not.toContain("rawToken")
    expect(raw).toContain("[redacted]")
  })

  test("ignores missing or unsafe conformance records", async () => {
    const path = await tempCachePath()
    await writeRuntimeCatalogCache({
      bridgeVersion: "0.1.28",
      cachePath: path,
      conformanceRecords: {
        [profile.id]: { ...record, state: "failing", strength: "none" },
      },
      now,
      profiles: [profile],
      runtimeCommandKeys: [["codex", "acp"]],
      ttlMs: 60_000,
    })

    expect(
      await loadRuntimeCatalogCache({
        bridgeVersion: "0.1.28",
        cachePath: path,
        now,
        runtimeCommandKeys: [["codex", "acp"]],
        ttlMs: 60_000,
      }),
    ).toBeNull()

    await rm(path, { force: true })
    expect(
      await loadRuntimeCatalogCache({
        bridgeVersion: "0.1.28",
        cachePath: path,
        now,
        runtimeCommandKeys: [["codex", "acp"]],
        ttlMs: 60_000,
      }),
    ).toBeNull()
  })

  test("keys runtime commands by structured argv arrays", () => {
    expect(runtimeCatalogCacheKey({
      bridgeVersion: "0.1.28",
      runtimeCommandKeys: [["foo bar", "baz"]],
    })).not.toBe(runtimeCatalogCacheKey({
      bridgeVersion: "0.1.28",
      runtimeCommandKeys: [["foo", "bar baz"]],
    }))
  })

  test("rejects cached runtime profiles with unsupported kind literals", async () => {
    const path = await tempCachePath()
    await writeRuntimeCatalogCache({
      bridgeVersion: "0.1.28",
      cachePath: path,
      conformanceRecords: {
        [record.runtimeId]: record,
        "bad:runtime": { ...record, runtimeId: "bad:runtime" },
      },
      now,
      profiles: [
        profile,
        {
          ...profile,
          id: "bad:runtime",
          kind: "totally-new-runtime" as BridgeRuntimeProfile["kind"],
        },
      ],
      runtimeCommandKeys: [["codex", "acp"]],
      ttlMs: 60_000,
    })

    const loaded = await loadRuntimeCatalogCache({
      bridgeVersion: "0.1.28",
      cachePath: path,
      now,
      runtimeCommandKeys: [["codex", "acp"]],
      ttlMs: 60_000,
    })

    expect(loaded?.profiles).toEqual([profile])
    expect(loaded?.conformanceRecords).toEqual({ [record.runtimeId]: record })
  })
})
