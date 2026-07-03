const REDACTED = "[redacted]";
const SENSITIVE_KEY_PATTERN =
  /(?:authorization|bridgeToken|token|secret|password|apiKey|api_key|x-api-key|x_api_key|accessToken|refreshToken|prompt)/i;
const SENSITIVE_STRING_KEY_PATTERN =
  /("?(?:authorization|bridgeToken|token|secret|password|apiKey|api_key|x-api-key|x_api_key|accessToken|refreshToken|prompt)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}&]+)/gi;
const SENSITIVE_TRAILING_KEY_PATTERN =
  "(?:bridgeToken|token|secret|password|apiKey|api_key|x-api-key|x_api_key|accessToken|refreshToken|prompt)";
const AUTHORIZATION_HEADER_PATTERN = new RegExp(
  `(?<!["'])(\\bauthorization\\b\\s*[:=]\\s*)[^\\r\\n]*?(?=\\s+${SENSITIVE_TRAILING_KEY_PATTERN}\\s*[:=]|$)`,
  "gi",
);
const API_KEY_HEADER_PATTERN =
  /(?<!["'])(\bx[-_]api[-_]key\b\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}\]]+)/gi;
const ACP_SESSION_ERROR_PATTERN =
  /(ACP\s+session\/(?:new|prompt|cancel)\s+(?:failed|did not return [^:]+):)[\s\S]*/gi;
const SAFE_ACP_SESSION_ERROR_PATTERN =
  /^ACP\s+session\/(?:new|prompt|cancel)\s+(?:failed|did not return [^:]+):\s+[a-z][a-z0-9_]*(?:\s+\(code\s+-?\d+\))?$/i;

export type BridgeLogLevel = "debug" | "info" | "warn" | "error";

export const bridgeLogEventNames = [
  "agent.attachments.emitted",
  "agent.attachments.upload_deferred",
  "agent.attachments.upload_failed",
  "agent.attachments.upload_resolved",
  "agent.reasoning.chunk",
  "agent.final_text.withheld",
  "agent.tool.completed",
  "agent.tool.failed",
  "agent.tool.requested",
  "agent.turn.completed",
  "agent.turn.failed",
  "agent.turn.started",
  "bridge.audit",
  "bridge.audit.write_failed",
  "bridge.attachments.delivered",
  "bridge.attachments.received",
  "bridge.axiom_delivery.failed",
  "bridge.control_command.received",
  "bridge.choice_response.continuation",
  "bridge.interaction_response.stale_noop",
  "bridge.input_response.continuation",
  "bridge.events.append_failed",
  "bridge.events.append_single_failed",
  "bridge.events.appended",
  "bridge.events.appended_single",
  "bridge.heartbeat.transient_error",
  "bridge.hermes_profiles.refresh",
  "bridge.hermes_profiles.refresh_error",
  "bridge.log_delivery.failed",
  "bridge.loop.error",
  "bridge.exception",
  "bridge.process.orphan_cleanup",
  "bridge.process.orphan_cleanup_failed",
  "bridge.queue.claim_skipped",
  "bridge.queue.claimed",
  "bridge.queue.cleanup_stale",
  "bridge.queue.cleanup_stale_timeout",
  "bridge.registration.claim_skipped",
  "bridge.registration.disabled",
  "bridge.queue_item.complete",
  "bridge.queue_item.error",
  "bridge.queue_item.externally_terminalized",
  "bridge.queue_item.first_assistant_text",
  "bridge.queue_item.first_runtime_activity",
  "bridge.queue_item.in_flight",
  "bridge.queue_item.settled",
  "bridge.queue_item.start",
  "bridge.lifecycle.externally_terminalized_result_ignored",
  "bridge.lifecycle.idle_close",
  "bridge.lifecycle.idle_pressure_close",
  "bridge.lifecycle.late_prompt_result_ignored",
  "bridge.lifecycle.replacement_session",
  "bridge.session.ready",
  "bridge.runtime_profiles.restart_requested",
  "bridge.session.mcp_manifest_changed",
  "bridge.session.tool_surface_changed",
  "bridge.session.quiet_degraded",
  "bridge.session.runtime_profile_changed",
  "bridge.session.warm_failed",
  "bridge.session.warm_runtime_profiles",
  "bridge.session.warmed",
  "bridge.session.tool_call_reconciled",
  "bridge.session.tool_calls_reconciled",
  "bridge.session.tool_result_timeout",
  "bridge.signal.received",
  "bridge.process.exiting",
  "bridge.start",
  "bridge.stop",
  "bridge.stop.timeout",
  "bridge.supervisor.started",
  "bridge.supervisor.child_started",
  "bridge.supervisor.child_exited",
  "bridge.supervisor.restart_requested",
  "bridge.supervisor.child_kill_sent",
  "bridge.supervisor.stop_requested",
  "bridge.supervisor.stopped",
  "bridge.systemd.unit_call",
  "bridge.systemd.stop_snapshot",
  "bridge.subscription.awaiting_wake_token",
  "bridge.subscription.disabled",
  "bridge.subscription.enabled",
  "bridge.subscription.error",
  "bridge.watchdog.terminalize_missed",
  "bridge.watchdog.quiet",
  "bridge.watchdog.timeout",
] as const;

export type BridgeLogEventName = (typeof bridgeLogEventNames)[number];

export const registeredBridgeLogEvents = new Set<string>(bridgeLogEventNames);

export function isBridgeLogEventName(
  value: string,
): value is BridgeLogEventName {
  return registeredBridgeLogEvents.has(value);
}

export type BridgeLogEntry = {
  level: BridgeLogLevel;
  event: BridgeLogEventName;
  message?: string;
  deviceId?: string;
  threadId?: string;
  sessionId?: string;
  agentSessionId?: string;
  acpSessionId?: string;
  queueId?: string;
  queueType?: string;
  activeSessionCount?: number;
  commandCount?: number;
  error?: string;
  [key: string]: unknown;
};

export type BridgeLogger = (entry: BridgeLogEntry) => void;
export type FlushableBridgeLogger = BridgeLogger & {
  flush: () => Promise<void>;
};

type AxiomBridgeLoggerOptions = {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  stderr?: Pick<typeof process.stderr, "write">;
};

type WorkerBridgeLoggerOptions = {
  bridgeToken: string;
  deviceId: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  flushIntervalMs?: number;
  logUrl?: string;
  maxBatchSize?: number;
  stderr?: Pick<typeof process.stderr, "write">;
};

const defaultDataset = "0000-chat-app";
const axiomBaseUrl = "https://api.axiom.co";

export function redactLogValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactLogValue(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, childValue] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? REDACTED
      : redactLogValue(childValue);
  }
  return redacted;
}

export function createStderrBridgeLogger(): BridgeLogger {
  return (entry) => {
    const safeEntry = redactLogValue({
      ...entry,
      ts: new Date().toISOString(),
    });
    process.stderr.write(`${JSON.stringify(safeEntry)}\n`);
  };
}

export function createCompositeBridgeLogger(
  loggers: FlushableBridgeLogger[],
): FlushableBridgeLogger {
  const logger = ((entry: BridgeLogEntry) => {
    for (const childLogger of loggers) {
      childLogger(entry);
    }
  }) as FlushableBridgeLogger;

  logger.flush = async () => {
    await Promise.allSettled(loggers.map((childLogger) => childLogger.flush()));
  };

  return logger;
}

export function createAxiomBridgeLogger(
  options: AxiomBridgeLoggerOptions = {},
): FlushableBridgeLogger {
  const env = options.env ?? process.env;
  const fetcher = options.fetch ?? globalThis.fetch;
  const stderr = options.stderr ?? process.stderr;
  const pending: Promise<unknown>[] = [];
  const apiKey = clean(env.AXIOM_API_KEY) ?? clean(env.AXIOM_TOKEN);
  const dataset = clean(env.AXIOM_DATASET) ?? defaultDataset;

  const logger = ((entry: BridgeLogEntry) => {
    const safeEntry = redactLogValue({
      ...entry,
      environment: clean(env.NODE_ENV) ?? "production",
      service: "acp-bridge",
      timestamp: new Date().toISOString(),
      ts: new Date().toISOString(),
    }) as Record<string, unknown>;
    stderr.write(`${JSON.stringify(safeEntry)}\n`);

    if (!apiKey || !fetcher) {
      return;
    }

    pending.push(
      fetcher(
        `${axiomBaseUrl}/v1/datasets/${encodeURIComponent(dataset)}/ingest`,
        {
          body: JSON.stringify([safeEntry]),
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          method: "POST",
        },
      ).catch((error) => {
        stderr.write(
          `${JSON.stringify({
            environment: clean(env.NODE_ENV) ?? "production",
            error: error instanceof Error ? error.message : String(error),
            event: "bridge.axiom_delivery.failed",
            level: "warn",
            service: "acp-bridge",
            timestamp: new Date().toISOString(),
          })}\n`,
        );
      }),
    );
  }) as FlushableBridgeLogger;

  logger.flush = async () => {
    await Promise.allSettled(pending.splice(0));
  };

  return logger;
}

export function createWorkerBridgeLogger(
  options: WorkerBridgeLoggerOptions,
): FlushableBridgeLogger {
  const env = options.env ?? process.env;
  const fetcher = options.fetch ?? globalThis.fetch;
  const stderr = options.stderr ?? process.stderr;
  const pendingDeliveries: Promise<unknown>[] = [];
  const queuedEvents: Record<string, unknown>[] = [];
  const logUrl = clean(options.logUrl) ?? clean(env.ZERO_CHAT_BRIDGE_LOG_URL);
  const maxBatchSize = options.maxBatchSize ?? 25;
  const flushIntervalMs = options.flushIntervalMs ?? 1_000;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const clearFlushTimer = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
  };

  const deliver = (events: Record<string, unknown>[]) => {
    if (events.length === 0 || !fetcher || !logUrl) {
      return;
    }
    pendingDeliveries.push(
      fetcher(logUrl, {
        body: JSON.stringify({ deviceId: options.deviceId, events }),
        headers: {
          authorization: `Bearer ${options.bridgeToken}`,
          "content-type": "application/json",
        },
        method: "POST",
      })
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Worker log ingest failed with ${response.status}`);
          }
        })
        .catch((error) => {
          stderr.write(
            `${JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
              event: "bridge.log_delivery.failed",
              level: "warn",
              service: "acp-bridge",
              timestamp: new Date().toISOString(),
            })}\n`,
          );
        }),
    );
  };

  const flushQueued = () => {
    clearFlushTimer();
    deliver(queuedEvents.splice(0, queuedEvents.length));
  };

  const scheduleFlush = () => {
    if (flushTimer || queuedEvents.length === 0) {
      return;
    }
    flushTimer = setTimeout(flushQueued, flushIntervalMs);
  };

  const logger = ((entry: BridgeLogEntry) => {
    const safeEntry = redactLogValue({
      ...entry,
      deviceId: entry.deviceId ?? options.deviceId,
      environment: clean(env.NODE_ENV) ?? "production",
      service: "acp-bridge",
      timestamp: new Date().toISOString(),
      ts: new Date().toISOString(),
    }) as Record<string, unknown>;
    stderr.write(`${JSON.stringify(safeEntry)}\n`);
    queuedEvents.push(safeEntry);
    if (queuedEvents.length >= maxBatchSize) {
      flushQueued();
      return;
    }
    scheduleFlush();
  }) as FlushableBridgeLogger;

  logger.flush = async () => {
    flushQueued();
    await Promise.allSettled(pendingDeliveries.splice(0));
  };

  return logger;
}

function clean(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function redactString(value: string): string {
  if (SAFE_ACP_SESSION_ERROR_PATTERN.test(value)) {
    return value;
  }
  return value
    .replace(ACP_SESSION_ERROR_PATTERN, `$1 ${REDACTED}`)
    .replace(
      AUTHORIZATION_HEADER_PATTERN,
      (_match, prefix: string) => `${prefix}${REDACTED}`,
    )
    .replace(
      API_KEY_HEADER_PATTERN,
      (_match, prefix: string) => `${prefix}${REDACTED}`,
    )
    .replace(/Bearer\s+[^\s,}\]]+/gi, "Bearer [redacted]")
    .replace(
      SENSITIVE_STRING_KEY_PATTERN,
      (_match, prefix: string, rawValue: string) => {
        const quote =
          rawValue.startsWith('"') || rawValue.startsWith("'")
            ? rawValue[0]
            : "";
        return `${prefix}${quote}${REDACTED}${quote}`;
      },
    );
}
