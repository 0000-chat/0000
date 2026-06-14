import type { BridgeHostAdapter, BridgeDiagnosticInput } from "./host-adapter";
import type {
  AcpBridgeOrphanProcessCleanup,
  AcpBridgeProcessHealth,
  AcpBridgeProcessRegistryLike,
} from "./process-registry";
import {
  BridgeJournalError,
  openBridgeJournal,
  type BridgeJournal,
  type BridgeJournalReasonCode,
  type RecoveryOutboxRow,
} from "./sqlite-journal";

export type BridgeTurnCheckpoint =
  | "queued"
  | "claimed"
  | "prompt_persisted"
  | "prompt_sent"
  | "active"
  | "quiet"
  | "waiting_for_interaction"
  | "cancelling"
  | "steering"
  | "cancelled"
  | "completed"
  | "failed";

export type BridgeSupervisorHealth =
  | { status: "healthy" }
  | {
      status: "hard_failed";
      reasonCode: BridgeJournalReasonCode;
      message: string;
    };

export type BridgeSupervisorWorkItem = {
  agentId?: string;
  agentName?: string;
  bridgeDeviceId?: string;
  bridgeProfileId?: string;
  claimId?: string;
  hermesProfileName?: string;
  id: string;
  organizationId?: string;
  runtimeProfileId?: string;
  threadId?: string;
  sessionId?: string;
  traceId?: string;
  type?: string;
  kind?: string;
};

export type BridgeTurnState = {
  checkpoint: BridgeTurnCheckpoint;
  claimId?: string;
  interactionId?: string;
  lastProviderEventAt?: number;
  queueItemId: string;
  reasonCode?: string;
  traceId?: string;
  updatedAt: number;
};

export type BridgeWatchdogResult =
  | {
      checkpoint: "quiet";
      queueItemId: string;
      reasonCode: "provider_quiet";
      silenceMs: number;
    }
  | {
      checkpoint: "failed";
      queueItemId: string;
      reasonCode: "provider_silent_timeout";
    };

export type OpenBridgeSupervisorOptions = {
  bridgeDeviceId: string;
  host?: BridgeHostAdapter;
  journalPath: string;
  organizationId?: string;
  processRegistry?: Pick<
    AcpBridgeProcessRegistryLike,
    "cleanupOrphanedProcesses" | "getProcessHealth" | "reconcileBeforeClaiming"
  >;
  providerSilentTimeoutMs?: number;
};

export type BridgeSupervisorOptions = {
  health?: BridgeSupervisorHealth;
  host?: BridgeHostAdapter;
  journal?: BridgeJournal;
  maxTurnStates?: number;
  now?: () => number;
  processRegistry?: Pick<
    AcpBridgeProcessRegistryLike,
    "cleanupOrphanedProcesses" | "getProcessHealth" | "reconcileBeforeClaiming"
  >;
  providerSilentTimeoutMs?: number;
};

const DEFAULT_PROVIDER_SILENT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TURN_STATES = 1_000;

export function openBridgeSupervisor(
  options: OpenBridgeSupervisorOptions,
): BridgeSupervisor {
  try {
    return new BridgeSupervisor({
      host: options.host,
      journal: openBridgeJournal({ path: options.journalPath }),
      processRegistry: options.processRegistry,
      providerSilentTimeoutMs: options.providerSilentTimeoutMs,
    });
  } catch (error) {
    const mapped = mapJournalOpenError(error);
    return new BridgeSupervisor({
      health: {
        status: "hard_failed",
        reasonCode: mapped.reasonCode,
        message: mapped.message,
      },
      host: options.host,
      processRegistry: options.processRegistry,
      providerSilentTimeoutMs: options.providerSilentTimeoutMs,
    });
  }
}

export class BridgeSupervisor {
  private health: BridgeSupervisorHealth;
  private readonly host?: BridgeHostAdapter;
  private readonly journal?: BridgeJournal;
  private readonly maxTurnStates: number;
  private readonly now: () => number;
  private readonly processRegistry?: Pick<
    AcpBridgeProcessRegistryLike,
    "cleanupOrphanedProcesses" | "getProcessHealth" | "reconcileBeforeClaiming"
  >;
  private readonly providerSilentTimeoutMs: number;
  private readonly promptOutboxIds = new Map<string, number>();
  private readonly turns = new Map<string, BridgeTurnState>();

  constructor(options: BridgeSupervisorOptions = {}) {
    this.health = options.health ?? { status: "healthy" };
    this.host = options.host;
    this.journal = options.journal;
    this.processRegistry = options.processRegistry;
    this.maxTurnStates = options.maxTurnStates ?? DEFAULT_MAX_TURN_STATES;
    this.now = options.now ?? Date.now;
    this.providerSilentTimeoutMs =
      options.providerSilentTimeoutMs ?? DEFAULT_PROVIDER_SILENT_TIMEOUT_MS;
  }

  canClaimWork(): boolean {
    return this.health.status === "healthy" && this.getProcessHealth().canClaim;
  }

  getHealth(): BridgeSupervisorHealth {
    return this.health;
  }

  getProcessHealth(): AcpBridgeProcessHealth {
    return (
      this.processRegistry?.getProcessHealth() ?? {
        ambiguousProcessCount: 0,
        canClaim: true,
        childCount: 0,
        childCountsByRuntimeProfile: {},
        processCapExceeded: false,
        startupReconciliation: {
          ambiguousProcessCount: 0,
          orphanedProcessCount: 0,
          removedDeadProcessCount: 0,
          retainedProcessCount: 0,
          status: "not_run",
          terminatedOrphanedProcessCount: 0,
          terminatedProcessCount: 0,
        },
        status: "healthy",
      }
    );
  }

  getTurnState(queueItemId: string): BridgeTurnState | undefined {
    return this.turns.get(queueItemId);
  }

  recordQueued(item: BridgeSupervisorWorkItem): void {
    this.transition(item, "queued");
  }

  recordClaimed(item: BridgeSupervisorWorkItem): void {
    this.transition(item, "claimed");
  }

  recordPromptPersisted(item: BridgeSupervisorWorkItem): void {
    this.persistPromptOutbox(item);
    this.transition(item, "prompt_persisted");
  }

  recordPromptSent(item: BridgeSupervisorWorkItem): void {
    this.transition(item, "prompt_sent");
  }

  recordProviderEvent(
    item: BridgeSupervisorWorkItem,
    event: { eventType?: string } = {},
  ): void {
    this.retirePromptOutbox(item, { providerEventType: event.eventType });
    this.transition(item, "active", { lastProviderEventAt: this.now() });
    this.appendLocalDiagnostic(
      item,
      "provider_event",
      event.eventType ?? "provider event observed",
    );
  }

  recordQuiet(item: BridgeSupervisorWorkItem, silenceMs: number): void {
    this.transition(item, "quiet", {
      lastProviderEventAt: this.turns.get(item.id)?.lastProviderEventAt,
      reasonCode: "provider_quiet",
    });
    this.appendLocalDiagnostic(
      item,
      "provider_quiet",
      `ACP provider has been quiet for ${silenceMs}ms while the runtime is still active.`,
    );
  }

  recordWaitingForInteraction(
    item: BridgeSupervisorWorkItem,
    interactionId: string,
  ): void {
    this.transition(item, "waiting_for_interaction", { interactionId });
  }

  recordInteractionAnswered(
    item: BridgeSupervisorWorkItem,
    interactionId: string,
  ): void {
    this.transition(item, "active", { interactionId });
  }

  recordCancelling(item: BridgeSupervisorWorkItem): void {
    this.transition(item, "cancelling");
  }

  recordSteering(item: BridgeSupervisorWorkItem): void {
    this.transition(item, "steering");
  }

  recordCancelled(item: BridgeSupervisorWorkItem): void {
    this.retirePromptOutbox(item, { terminal: "cancelled" });
    this.transition(item, "cancelled");
  }

  recordCompleted(item: BridgeSupervisorWorkItem): void {
    this.retirePromptOutbox(item, { terminal: "completed" });
    this.transition(item, "completed");
  }

  recordFailed(item: BridgeSupervisorWorkItem, reasonCode: string): void {
    if (reasonCode !== "provider_silent_timeout") {
      this.retirePromptOutbox(item, { reasonCode, terminal: "failed" });
    }
    this.transition(item, "failed", { reasonCode });
  }

  checkWatchdogs(): BridgeWatchdogResult[] {
    const now = this.now();
    const results: BridgeWatchdogResult[] = [];
    for (const turn of this.turns.values()) {
      if (turn.checkpoint !== "active" && turn.checkpoint !== "prompt_sent") {
        continue;
      }
      const lastProviderEventAt = turn.lastProviderEventAt ?? turn.updatedAt;
      const silenceMs = now - lastProviderEventAt;
      if (silenceMs < this.providerSilentTimeoutMs) {
        continue;
      }
      const item = {
        id: turn.queueItemId,
        claimId: turn.claimId,
        traceId: turn.traceId,
      };
      this.recordQuiet(item, silenceMs);
      results.push({
        checkpoint: "quiet",
        queueItemId: turn.queueItemId,
        reasonCode: "provider_quiet",
        silenceMs,
      });
    }
    return results;
  }

  async replayOutboxBeforeClaiming(): Promise<void> {
    if (!this.journal) {
      return;
    }
    let rows: RecoveryOutboxRow[];
    try {
      rows = this.journal.listRecoveryWork();
    } catch (error) {
      this.markJournalHardFailed(error);
      return;
    }
    for (const row of rows) {
      await this.publishRecoveryDiagnostic(row);
      try {
        this.journal.markOutboxPublished(row.id, { recovered: true });
      } catch (error) {
        this.markJournalHardFailed(error);
      }
    }
  }

  async reconcileProcessesBeforeClaiming(): Promise<void> {
    try {
      await this.processRegistry?.reconcileBeforeClaiming();
    } catch (error) {
      this.markJournalHardFailed(error);
    }
  }

  async cleanupOrphanedProcesses(): Promise<AcpBridgeOrphanProcessCleanup | undefined> {
    return await this.processRegistry?.cleanupOrphanedProcesses();
  }

  async publishHealthDiagnostic(
    input: {
      bridgeDeviceId?: string;
      organizationId?: string;
      traceId?: string;
    } = {},
  ): Promise<void> {
    const health = this.getHealth();
    const diagnostic: BridgeDiagnosticInput = {
      details: {
        bridgeDeviceId: input.bridgeDeviceId,
        organizationId: input.organizationId,
        status: health.status,
        ...(health.status === "hard_failed"
          ? { message: health.message, reasonCode: health.reasonCode }
          : {}),
      },
      message:
        health.status === "healthy"
          ? "Bridge local journal is healthy."
          : "Bridge local journal is hard-failed; new queue claims are disabled.",
      reasonCode:
        health.status === "healthy"
          ? "local_journal_healthy"
          : health.reasonCode,
      traceId: input.traceId,
    };
    try {
      this.journal?.appendDiagnostic(diagnostic);
    } catch (error) {
      this.markJournalHardFailed(error);
    }
    await this.tryAppendHostDiagnostic(diagnostic);
  }

  close(): void {
    this.journal?.close();
  }

  private transition(
    item: BridgeSupervisorWorkItem,
    checkpoint: BridgeTurnCheckpoint,
    extra: Partial<BridgeTurnState> = {},
  ): void {
    const existing = this.turns.get(item.id);
    this.turns.set(item.id, {
      checkpoint,
      claimId: item.claimId ?? existing?.claimId,
      queueItemId: item.id,
      traceId: item.traceId ?? existing?.traceId,
      updatedAt: this.now(),
      ...extra,
    });
    this.pruneTurnStates();
  }

  private persistPromptOutbox(item: BridgeSupervisorWorkItem): void {
    if (!this.journal || !item.claimId) {
      return;
    }
    try {
      const { outboxId } = this.journal.recordClaimBeforePrompt({
        agentId: item.agentId ?? item.agentName ?? "unknown-agent",
        bridgeDeviceId: item.bridgeDeviceId ?? "unknown-device",
        claimId: item.claimId,
        eventType: "prompt.send",
        organizationId: item.organizationId ?? "unknown-org",
        payload: {
          checkpoint: "prompt_persisted",
          queueItemId: item.id,
          queueType: item.type ?? item.kind,
        },
        queueItemId: item.id,
        runtimeProfileId:
          item.runtimeProfileId ??
          item.bridgeProfileId ??
          item.hermesProfileName,
        threadId: item.threadId ?? item.sessionId ?? "unknown-thread",
        traceId: item.traceId,
      });
      this.promptOutboxIds.set(item.id, outboxId);
    } catch (error) {
      this.markJournalHardFailed(error);
    }
  }

  private appendLocalDiagnostic(
    item: BridgeSupervisorWorkItem,
    reasonCode: string,
    message: string,
  ): void {
    try {
      this.journal?.appendDiagnostic({
        details: { queueItemId: item.id },
        message,
        reasonCode,
        traceId: item.traceId,
      });
    } catch (error) {
      this.markJournalHardFailed(error);
    }
  }

  private async publishRecoveryDiagnostic(
    row: RecoveryOutboxRow,
  ): Promise<void> {
    const diagnostic: BridgeDiagnosticInput = {
      details: {
        claimId: row.claimId,
        eventType: row.eventType,
        outboxId: row.id,
        queueItemId: row.queueItemId,
        sequence: row.sequence,
      },
      message:
        row.eventType === "prompt.send"
          ? "Bridge restarted after a prompt send checkpoint and before provider confirmation."
          : "Bridge restarted with an unpublished local outbox row.",
      reasonCode:
        row.eventType === "prompt.send"
          ? "ambiguous_after_crash"
          : "outbox_replayed",
      traceId: row.traceId,
    };
    try {
      this.journal?.appendDiagnostic(diagnostic);
    } catch (error) {
      this.markJournalHardFailed(error);
    }
    await this.tryAppendHostDiagnostic(diagnostic);
  }

  private retirePromptOutbox(
    item: BridgeSupervisorWorkItem,
    hostAck: Record<string, unknown>,
  ): void {
    const outboxId = this.promptOutboxIds.get(item.id);
    if (!this.journal || outboxId === undefined) {
      return;
    }
    try {
      this.journal.markOutboxPublished(outboxId, hostAck);
      this.promptOutboxIds.delete(item.id);
    } catch (error) {
      this.markJournalHardFailed(error);
    }
  }

  private pruneTurnStates(): void {
    while (this.turns.size > this.maxTurnStates) {
      const terminal = Array.from(this.turns).find(([, turn]) =>
        isTerminalCheckpoint(turn.checkpoint),
      );
      const key = terminal?.[0] ?? this.turns.keys().next().value;
      if (typeof key !== "string") {
        return;
      }
      this.turns.delete(key);
      this.promptOutboxIds.delete(key);
    }
  }

  private markJournalHardFailed(error: unknown): void {
    const mapped = mapJournalOpenError(error);
    this.health = {
      status: "hard_failed",
      reasonCode: mapped.reasonCode,
      message: mapped.message,
    };
  }

  private async tryAppendHostDiagnostic(
    diagnostic: BridgeDiagnosticInput,
  ): Promise<void> {
    try {
      await this.host?.appendDiagnostics({ diagnostics: [diagnostic] });
    } catch {
      // Host diagnostic delivery is visibility-only in shadow mode.
    }
  }
}

function isTerminalCheckpoint(checkpoint: BridgeTurnCheckpoint): boolean {
  return (
    checkpoint === "cancelled" ||
    checkpoint === "completed" ||
    checkpoint === "failed"
  );
}

function mapJournalOpenError(error: unknown): BridgeJournalError {
  if (error instanceof BridgeJournalError) {
    return error;
  }
  return new BridgeJournalError(
    "local_persistence_unavailable",
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}
