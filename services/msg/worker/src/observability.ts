type MsgEventName = "msg.creation.claimed" | "msg.d1.availability" | "msg.operator.action" | "msg.report.recorded";

/** The only msg logging boundary. Callers may supply only bounded outcome values. */
export function emitMsgEvent(event: MsgEventName, outcome: string): void {
  const boundedOutcome = outcome.length > 2048 ? outcome.slice(0, 2048) + "..." : outcome;
  const record = {
    outcome: boundedOutcome,
    event,
    level: "info",
    service: "worker",
    environment: "msg",
    timestamp: new Date().toISOString(),
  };

  try {
    globalThis.console.info(JSON.stringify(record));
  } catch {
    // Logging must not change the result of a Worker request.
  }
}
