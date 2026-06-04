import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  BridgeJournalError,
  openBridgeJournal,
  type BridgeJournalDatabaseFactory,
} from "./sqlite-journal"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function tempDatabasePath() {
  const dir = await mkdtemp(join(tmpdir(), "bridge-journal-"))
  tempDirs.push(dir)
  return join(dir, "bridge.sqlite")
}

describe("SQLite bridge journal", () => {
  test("opens and runs idempotent migrations", async () => {
    const path = await tempDatabasePath()
    const first = openBridgeJournal({ path })
    expect(first.listAppliedMigrations().map((migration) => migration.version)).toEqual([
      1,
      2,
      3,
      4,
      5,
      6,
      7,
    ])
    first.close()

    const second = openBridgeJournal({ path })
    expect(second.listAppliedMigrations()).toHaveLength(7)
    second.close()
  })

  test("keys bridge sessions by organization, bridge device, agent, thread, and runtime profile", async () => {
    const journal = openBridgeJournal({ path: await tempDatabasePath() })
    const first = journal.recordClaimBeforePrompt(baseClaim({ queueItemId: "queue-1" }))
    const second = journal.recordClaimBeforePrompt(baseClaim({ queueItemId: "queue-2" }))
    const otherProfile = journal.recordClaimBeforePrompt(
      baseClaim({ queueItemId: "queue-3", runtimeProfileId: "claude:default" }),
    )

    expect(first.sessionId).toBe(second.sessionId)
    expect(otherProfile.sessionId).not.toBe(first.sessionId)
    expect(journal.listBridgeSessions()).toHaveLength(2)
    journal.close()
  })

  test("writes outbox rows before prompt send and recovers them in sequence order", async () => {
    const journal = openBridgeJournal({ path: await tempDatabasePath() })
    const first = journal.recordClaimBeforePrompt(baseClaim({ queueItemId: "queue-2" }))
    const second = journal.recordClaimBeforePrompt(baseClaim({ queueItemId: "queue-1" }))

    expect(first.outboxId).toBeLessThan(second.outboxId)
    expect(journal.listRecoveryWork().map((row) => row.queueItemId)).toEqual(["queue-2", "queue-1"])
    journal.close()
  })

  test("maps open and migration failures to local_persistence_unavailable", async () => {
    const error = expectJournalError(() =>
      openBridgeJournal({
        path: awaitLiteralPath(),
        databaseFactory: throwingFactory(new Error("permission denied")),
      }),
    )
    expect(error.reasonCode).toBe("local_persistence_unavailable")
  })

  test("maps busy locks to sqlite_lock_busy", () => {
    const error = expectJournalError(() =>
      openBridgeJournal({
        path: "locked.sqlite",
        databaseFactory: throwingFactory(new Error("SQLITE_BUSY: database is locked")),
      }),
    )
    expect(error.reasonCode).toBe("sqlite_lock_busy")
  })

  test("maps disk-full failures to local_disk_full", () => {
    const error = expectJournalError(() =>
      openBridgeJournal({
        path: "full.sqlite",
        databaseFactory: throwingFactory(new Error("SQLITE_FULL: database or disk is full")),
      }),
    )
    expect(error.reasonCode).toBe("local_disk_full")
  })

  test("doctor redaction never prints raw prompt or content-bearing payloads", async () => {
    const journal = openBridgeJournal({ path: await tempDatabasePath() })
    journal.recordClaimBeforePrompt(
      baseClaim({
        payload: {
          content: "secret prompt",
          messages: [{ role: "user", text: "please leak me" }],
          safe: "metadata",
        },
      }),
    )
    journal.appendDiagnostic({
      details: {
        Authorization: "Bearer upper-secret-token",
        accessToken: "access-secret-token",
        api_key: "api-key-secret",
        databaseUrl: "postgres://user:pass@example.test/db",
        prompt: "hidden diagnostic content",
        safe: "diagnostic metadata",
        token: "Bearer super-secret-token",
      },
      message: "raw prompt hidden diagnostic content",
      reasonCode: "prompt_send_failed",
      traceId: "trace-redaction",
    })

    const doctor = JSON.stringify(journal.buildDoctorSnapshot())
    expect(doctor).not.toContain("secret prompt")
    expect(doctor).not.toContain("please leak me")
    expect(doctor).not.toContain("hidden diagnostic content")
    expect(doctor).not.toContain("super-secret-token")
    expect(doctor).not.toContain("upper-secret-token")
    expect(doctor).not.toContain("access-secret-token")
    expect(doctor).not.toContain("api-key-secret")
    expect(doctor).not.toContain("postgres://user:pass@example.test/db")
    expect(doctor).toContain("[redacted]")
    journal.close()
  })
})

function baseClaim(overrides: Partial<Parameters<ReturnType<typeof openBridgeJournal>["recordClaimBeforePrompt"]>[0]> = {}) {
  return {
    agentId: "agent-1",
    bridgeDeviceId: "device-1",
    claimId: "claim-1",
    eventType: "prompt.send",
    organizationId: "org-1",
    payload: { preview: "safe" },
    queueItemId: "queue-1",
    runtimeProfileId: "codex:default",
    threadId: "thread-1",
    traceId: "trace-1",
    ...overrides,
  }
}

function throwingFactory(error: Error): BridgeJournalDatabaseFactory {
  return () => {
    throw error
  }
}

function expectJournalError(fn: () => unknown): BridgeJournalError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(BridgeJournalError)
    return error as BridgeJournalError
  }
  throw new Error("Expected BridgeJournalError")
}

function awaitLiteralPath() {
  return "unavailable.sqlite"
}
