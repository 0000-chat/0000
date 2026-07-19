import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BridgeSupervisor, openBridgeSupervisor } from "./bridge-supervisor";
import { openBridgeJournal, type BridgeJournal } from "./sqlite-journal";
import type { BridgeHostAdapter, BridgeDiagnosticInput } from "./host-adapter";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("bridge supervisor shadow mode", () => {
  test("records prompt lifecycle transitions through completion", () => {
    const journal = journalAtTempPath();
    const supervisor = new BridgeSupervisor({ journal });

    supervisor.recordQueued(baseWork());
    supervisor.recordClaimed(baseWork());
    supervisor.recordPromptPersisted(baseWork());
    supervisor.recordPromptSent(baseWork());
    supervisor.recordProviderEvent(baseWork(), {
      eventType: "message_started",
    });
    supervisor.recordCompleted(baseWork());

    expect(supervisor.getTurnState("queue-1")).toMatchObject({
      checkpoint: "completed",
      claimId: "claim-1",
      queueItemId: "queue-1",
    });
    expect(journal.listRecoveryWork()).toEqual([]);
  });

  test("records interaction wait and answer transitions", () => {
    const supervisor = new BridgeSupervisor({ journal: journalAtTempPath() });

    supervisor.recordClaimed(baseWork());
    supervisor.recordPromptSent(baseWork());
    supervisor.recordWaitingForInteraction(baseWork(), "choice-1");
    expect(supervisor.getTurnState("queue-1")?.checkpoint).toBe(
      "waiting_for_interaction",
    );

    supervisor.recordInteractionAnswered(baseWork(), "choice-1");
    expect(supervisor.getTurnState("queue-1")?.checkpoint).toBe("active");
  });

  test("records cancellation transitions", () => {
    const supervisor = new BridgeSupervisor({ journal: journalAtTempPath() });

    supervisor.recordClaimed(baseWork());
    supervisor.recordPromptSent(baseWork());
    supervisor.recordCancelling(baseWork());
    supervisor.recordCancelled(baseWork());

    expect(supervisor.getTurnState("queue-1")?.checkpoint).toBe("cancelled");
  });

  test("records steering transitions before replacement prompts", () => {
    const supervisor = new BridgeSupervisor({ journal: journalAtTempPath() });

    supervisor.recordClaimed(baseWork());
    supervisor.recordSteering(baseWork());

    expect(supervisor.getTurnState("queue-1")?.checkpoint).toBe("steering");
  });

  test("marks an active turn quiet after provider silence timeout", () => {
    let now = 1_000;
    const journal = journalAtTempPath();
    const supervisor = new BridgeSupervisor({
      journal,
      now: () => now,
      providerSilentTimeoutMs: 100,
    });

    supervisor.recordClaimed(baseWork());
    supervisor.recordPromptPersisted(baseWork());
    supervisor.recordPromptSent(baseWork());
    now = 1_101;

    expect(supervisor.checkWatchdogs()).toEqual([
      {
        checkpoint: "quiet",
        queueItemId: "queue-1",
        reasonCode: "provider_quiet",
        silenceMs: 101,
      },
    ]);
    expect(supervisor.getTurnState("queue-1")?.checkpoint).toBe("quiet");
    expect(journal.listRecoveryWork().map((row) => row.eventType)).toEqual([
      "prompt.send",
    ]);

    expect(supervisor.checkWatchdogs()).toEqual([]);

    supervisor.recordProviderEvent(baseWork(), { eventType: "tool_call" });
    expect(supervisor.getTurnState("queue-1")?.checkpoint).toBe("active");
  });

  test("replays outbox rows before claiming new work and flags prompt-send ambiguity", async () => {
    const journal = journalAtTempPath();
    const host = fakeHostAdapter();
    const supervisor = new BridgeSupervisor({ journal });
    supervisor.recordClaimed(baseWork());
    supervisor.recordPromptPersisted(baseWork());
    supervisor.recordPromptSent(baseWork());

    const restarted = new BridgeSupervisor({ journal, host });
    await restarted.replayOutboxBeforeClaiming();

    expect(host.diagnostics).toContainEqual(
      expect.objectContaining({
        reasonCode: "ambiguous_after_crash",
        traceId: "trace-1",
      }),
    );
    expect(journal.listRecoveryWork()).toEqual([]);
  });

  test("does not replay prompt-send checkpoints after provider confirmation", async () => {
    const journal = journalAtTempPath();
    const host = fakeHostAdapter();
    const supervisor = new BridgeSupervisor({ journal });
    supervisor.recordClaimed(baseWork());
    supervisor.recordPromptPersisted(baseWork());
    supervisor.recordPromptSent(baseWork());
    supervisor.recordProviderEvent(baseWork(), {
      eventType: "message_started",
    });

    const restarted = new BridgeSupervisor({ journal, host });
    await restarted.replayOutboxBeforeClaiming();

    expect(host.diagnostics).toEqual([]);
    expect(journal.listRecoveryWork()).toEqual([]);
  });

  test("enters no-claim mode when the journal hard-fails to open", () => {
    const supervisor = openBridgeSupervisor({
      bridgeDeviceId: "device-1",
      journalPath: tmpdir(),
      organizationId: "org-1",
    });

    expect(supervisor.canClaimWork()).toBe(false);
    expect(supervisor.getHealth().status).toBe("hard_failed");
  });

  test("publishes local journal health diagnostics through the host adapter", async () => {
    const host = fakeHostAdapter();
    const supervisor = new BridgeSupervisor({
      host,
      journal: journalAtTempPath(),
    });

    await supervisor.publishHealthDiagnostic({
      bridgeDeviceId: "device-1",
      organizationId: "org-1",
    });

    expect(host.diagnostics).toContainEqual(
      expect.objectContaining({
        reasonCode: "local_journal_healthy",
      }),
    );
  });

  test("does not fail startup when host diagnostic publishing fails", async () => {
    const supervisor = new BridgeSupervisor({
      host: {
        ...fakeHostAdapter(),
        appendDiagnostics: async () => {
          throw new Error("network down");
        },
      },
      journal: journalAtTempPath(),
    });

    await expect(
      supervisor.publishHealthDiagnostic({ bridgeDeviceId: "device-1" }),
    ).resolves.toBe(undefined);
    expect(supervisor.canClaimWork()).toBe(true);
  });

  test("enters no-claim mode when replay cannot read local recovery work", async () => {
    const supervisor = new BridgeSupervisor({
      journal: {
        listRecoveryWork: () => {
          throw new Error("database is locked");
        },
      } as unknown as BridgeJournal,
    });

    await expect(supervisor.replayOutboxBeforeClaiming()).resolves.toBe(
      undefined,
    );
    expect(supervisor.canClaimWork()).toBe(false);
  });

  test("runs process reconciliation before claims and exposes unsafe process health", async () => {
    let reconciled = false;
    const supervisor = new BridgeSupervisor({
      processRegistry: {
        cleanupOrphanedProcesses: async () => ({
          lastReconciledAt: "2026-06-05T10:04:00.000Z",
          orphanedProcessCount: 0,
          terminatedOrphanedProcessCount: 0,
        }),
        getProcessHealth: () => ({
          ambiguousProcessCount: reconciled ? 1 : 0,
          canClaim: !reconciled,
          childCount: 1,
          childCountsByRuntimeProfile: { "codex:default": 1 },
          processCap: 1,
          processCapExceeded: true,
          startupReconciliation: {
            ambiguousProcessCount: reconciled ? 1 : 0,
            orphanedProcessCount: 0,
            removedDeadProcessCount: 0,
            retainedProcessCount: reconciled ? 1 : 0,
            status: reconciled ? "ambiguous" : "not_run",
            terminatedOrphanedProcessCount: 0,
            terminatedProcessCount: 0,
          },
          status: reconciled ? "ambiguous" : "healthy",
        }),
        reconcileBeforeClaiming: async () => {
          reconciled = true;
        },
      },
    });

    await supervisor.reconcileProcessesBeforeClaiming();

    expect(supervisor.canClaimWork()).toBe(false);
    expect(supervisor.getProcessHealth()).toMatchObject({
      ambiguousProcessCount: 1,
      canClaim: false,
      status: "ambiguous",
    });
  });

  test("runs orphan process cleanup without marking active registry entries unsafe", async () => {
    const supervisor = new BridgeSupervisor({
      processRegistry: {
        cleanupOrphanedProcesses: async () => {
          return {
            lastReconciledAt: "2026-06-05T10:04:00.000Z",
            orphanedProcessCount: 2,
            terminatedOrphanedProcessCount: 2,
          };
        },
        getProcessHealth: () => ({
          ambiguousProcessCount: 0,
          canClaim: true,
          childCount: 1,
          childCountsByRuntimeProfile: { "hermes:default": 1 },
          processCap: 2,
          processCapExceeded: false,
          startupReconciliation: {
            ambiguousProcessCount: 0,
            lastReconciledAt: "2026-06-05T10:04:00.000Z",
            orphanedProcessCount: 0,
            removedDeadProcessCount: 0,
            retainedProcessCount: 0,
            status: "healthy",
            terminatedOrphanedProcessCount: 0,
            terminatedProcessCount: 0,
          },
          status: "healthy",
        }),
        reconcileBeforeClaiming: async () => {},
      },
    });

    await expect(supervisor.cleanupOrphanedProcesses()).resolves.toMatchObject({
      orphanedProcessCount: 2,
      terminatedOrphanedProcessCount: 2,
    });
    expect(supervisor.canClaimWork()).toBe(true);
    expect(supervisor.getProcessHealth()).toMatchObject({
      childCount: 1,
      startupReconciliation: {
        orphanedProcessCount: 0,
        terminatedOrphanedProcessCount: 0,
      },
    });
  });

  test("does not let local diagnostic write failures interrupt provider events", () => {
    const journal = journalAtTempPath();
    const supervisor = new BridgeSupervisor({ journal });
    supervisor.recordClaimed(baseWork());
    supervisor.recordPromptPersisted(baseWork());
    supervisor.recordPromptSent(baseWork());
    journal.close();

    expect(() =>
      supervisor.recordProviderEvent(baseWork(), {
        eventType: "message_started",
      }),
    ).not.toThrow();
    expect(supervisor.canClaimWork()).toBe(false);
  });

  test("bounds tracked turn state for long-running bridges", () => {
    const supervisor = new BridgeSupervisor({ maxTurnStates: 2 });

    for (let index = 0; index < 5; index += 1) {
      const item = {
        ...baseWork(),
        id: `queue-${index}`,
        claimId: `claim-${index}`,
      };
      supervisor.recordClaimed(item);
      supervisor.recordCompleted(item);
    }

    expect(supervisor.getTurnState("queue-0")).toBeUndefined();
    expect(supervisor.getTurnState("queue-4")).toMatchObject({
      checkpoint: "completed",
    });
  });
});

function journalAtTempPath(): BridgeJournal {
  const dir = mkdtempSyncTracked();
  return openBridgeJournal({ path: join(dir, "bridge.sqlite") });
}

function mkdtempSyncTracked(): string {
  const dir = mkdtempSync(join(tmpdir(), "bridge-supervisor-"));
  tempDirs.push(dir);
  return dir;
}

function baseWork() {
  return {
    agentName: "Agent",
    agentId: "agent-1",
    bridgeDeviceId: "device-1",
    claimId: "claim-1",
    id: "queue-1",
    organizationId: "org-1",
    runtimeProfileId: "codex",
    threadId: "thread-1",
    traceId: "trace-1",
    type: "prompt",
  };
}

function fakeHostAdapter(): BridgeHostAdapter & {
  diagnostics: BridgeDiagnosticInput[];
} {
  const diagnostics: BridgeDiagnosticInput[] = [];
  return {
    diagnostics,
    appendDiagnostics: async (input) => {
      diagnostics.push(...input.diagnostics);
      return { ok: true };
    },
    appendEvents: async () => ({ ok: true }),
    answerInteraction: async () => ({ ok: true }),
    claimWork: async () => ({ raw: {}, workItems: [] }),
    completeWork: async () => ({ ok: true }),
    releaseWork: async () => ({ ok: true }),
  };
}
