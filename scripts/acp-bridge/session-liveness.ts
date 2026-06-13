export type SessionLivenessEventType =
  | "assistant_output"
  | "permission_request"
  | "process_exited"
  | "provider_quiet"
  | "tool_progress"
  | "transport_closed";

export type SessionLivenessState =
  | "active"
  | "failed"
  | "quiet"
  | "waiting_for_permission";

export type SessionLivenessRecord = {
  bridgeProfileId?: string;
  claimId?: string;
  lastActivityAt: number;
  lastMeaningfulEventAt: number;
  providerActivitySeen: boolean;
  queueItemId: string;
  quietSince?: number;
  reasonCode?: SessionLivenessReasonCode;
  sessionKey: string;
  silenceMs?: number;
  startedAt: number;
  state: SessionLivenessState;
  processAlive?: boolean;
  transportOpen?: boolean;
};

export type SessionLivenessReasonCode =
  | "provider_silent_timeout"
  | "runtime_process_exited"
  | "runtime_transport_closed";

export type SessionLivenessDecision =
  | { ok: true }
  | {
      action: "fail_terminal";
      ok: false;
      reasonCode: SessionLivenessReasonCode;
    };

export function createSessionLivenessRecord(input: {
  bridgeProfileId?: string;
  claimId?: string;
  now: number;
  queueItemId: string;
  sessionKey: string;
}): SessionLivenessRecord {
  return {
    bridgeProfileId: input.bridgeProfileId,
    claimId: input.claimId,
    lastActivityAt: input.now,
    lastMeaningfulEventAt: input.now,
    providerActivitySeen: false,
    queueItemId: input.queueItemId,
    sessionKey: input.sessionKey,
    startedAt: input.now,
    state: "active",
    processAlive: true,
    transportOpen: true,
  };
}

export function reduceSessionLiveness(
  record: SessionLivenessRecord,
  event: { at: number; type: SessionLivenessEventType },
): SessionLivenessRecord {
  if (event.type === "process_exited") {
    return {
      ...record,
      lastActivityAt: event.at,
      lastMeaningfulEventAt: event.at,
      processAlive: false,
      reasonCode: "runtime_process_exited",
      state: "failed",
    };
  }
  if (event.type === "transport_closed") {
    return {
      ...record,
      lastActivityAt: event.at,
      lastMeaningfulEventAt: event.at,
      reasonCode: "runtime_transport_closed",
      state: "failed",
      transportOpen: false,
    };
  }
  if (event.type === "provider_quiet") {
    return {
      ...record,
      lastActivityAt: event.at,
      quietSince: record.quietSince ?? event.at,
      silenceMs: event.at - record.lastMeaningfulEventAt,
      state: "quiet",
    };
  }
  return {
    ...record,
    lastActivityAt: event.at,
    lastMeaningfulEventAt: event.at,
    providerActivitySeen: true,
    quietSince: undefined,
    reasonCode: undefined,
    silenceMs: undefined,
    state:
      event.type === "permission_request" ? "waiting_for_permission" : "active",
  };
}

export function evaluateSessionLiveness(input: {
  now: number;
  record: SessionLivenessRecord;
  timeoutMs: number;
}): SessionLivenessDecision {
  if (input.record.state === "failed") {
    return {
      action: "fail_terminal",
      ok: false,
      reasonCode: input.record.reasonCode ?? "runtime_process_exited",
    };
  }
  return { ok: true };
}
