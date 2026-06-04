import { registeredBridgeLogEvents } from "./hermes-bridge/bridge-log";

const requiredBridgeLogEvents = [
  "bridge.start",
  "bridge.stop",
  "bridge.queue.claimed",
  "bridge.queue_item.start",
  "bridge.queue_item.settled",
  "bridge.events.appended",
  "bridge.events.append_failed",
  "bridge.session.ready",
  "bridge.session.idle_close",
  "bridge.log_delivery.failed",
  "agent.turn.started",
  "agent.turn.completed",
  "agent.turn.failed",
] as const;

const missingEvents = requiredBridgeLogEvents.filter(
  (eventName) => !registeredBridgeLogEvents.has(eventName),
);

if (missingEvents.length > 0) {
  console.error(
    `Missing registered bridge log events: ${missingEvents.join(", ")}`,
  );
  process.exit(1);
}

console.log(
  `observability: ${registeredBridgeLogEvents.size} bridge log events registered`,
);
