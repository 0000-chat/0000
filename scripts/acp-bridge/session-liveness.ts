export type SessionLivenessEventType =
  | "assistant_output"
  | "permission_request"
  | "process_exited"
  | "tool_progress"
  | "transport_closed"

export type SessionLivenessState =
  | "active"
  | "failed"
  | "waiting_for_permission"

export type SessionLivenessRecord = {
  bridgeProfileId?: string
  lastActivityAt: number
  queueItemId: string
  reasonCode?: SessionLivenessReasonCode
  sessionKey: string
  startedAt: number
  state: SessionLivenessState
}

export type SessionLivenessReasonCode =
  | "provider_silent_timeout"
  | "runtime_process_exited"
  | "runtime_transport_closed"

export type SessionLivenessDecision =
  | { ok: true }
  | {
      action: "fail_terminal"
      ok: false
      reasonCode: SessionLivenessReasonCode
    }

export function createSessionLivenessRecord(input: {
  bridgeProfileId?: string
  now: number
  queueItemId: string
  sessionKey: string
}): SessionLivenessRecord {
  return {
    bridgeProfileId: input.bridgeProfileId,
    lastActivityAt: input.now,
    queueItemId: input.queueItemId,
    sessionKey: input.sessionKey,
    startedAt: input.now,
    state: "active",
  }
}

export function reduceSessionLiveness(
  record: SessionLivenessRecord,
  event: { at: number; type: SessionLivenessEventType },
): SessionLivenessRecord {
  if (event.type === "process_exited") {
    return {
      ...record,
      lastActivityAt: event.at,
      reasonCode: "runtime_process_exited",
      state: "failed",
    }
  }
  if (event.type === "transport_closed") {
    return {
      ...record,
      lastActivityAt: event.at,
      reasonCode: "runtime_transport_closed",
      state: "failed",
    }
  }
  return {
    ...record,
    lastActivityAt: event.at,
    state: event.type === "permission_request" ? "waiting_for_permission" : "active",
  }
}

export function evaluateSessionLiveness(input: {
  now: number
  record: SessionLivenessRecord
  timeoutMs: number
}): SessionLivenessDecision {
  if (input.record.state === "failed") {
    return {
      action: "fail_terminal",
      ok: false,
      reasonCode: input.record.reasonCode ?? "runtime_process_exited",
    }
  }
  if (input.now - input.record.lastActivityAt >= input.timeoutMs) {
    return { action: "fail_terminal", ok: false, reasonCode: "provider_silent_timeout" }
  }
  return { ok: true }
}
