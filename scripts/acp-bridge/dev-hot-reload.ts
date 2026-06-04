export type DevHotReloadStatus = {
  activeSessions?: unknown[]
  inFlightCommands?: unknown[]
  sessionQueues?: Array<{
    sessionKey?: unknown
    threadId?: unknown
    queueDepth?: unknown
    runningQueueItemId?: unknown
  }>
  registrations?: DevHotReloadStatus[]
}

export type DevHotReloadDecision =
  | { ready: true }
  | { ready: false; reason: "in_flight_commands" | "session_queue_busy" }

export function shouldRestartBridgeForDevHotReload(
  status: DevHotReloadStatus,
): DevHotReloadDecision {
  const registrations = Array.isArray(status.registrations) ? status.registrations : [status]
  if (registrations.some((registration) => (registration.inFlightCommands?.length ?? 0) > 0)) {
    return { ready: false, reason: "in_flight_commands" }
  }
  if (
    registrations.some((registration) =>
      (registration.sessionQueues ?? []).some((queue) => {
        const queueDepth = typeof queue.queueDepth === "number" ? queue.queueDepth : 0
        return Boolean(queue.runningQueueItemId) || queueDepth > 0
      }),
    )
  ) {
    return { ready: false, reason: "session_queue_busy" }
  }
  return { ready: true }
}
