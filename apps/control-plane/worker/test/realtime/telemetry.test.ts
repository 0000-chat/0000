import {
  REALTIME_SUBPROTOCOL,
  type RealtimeSubscription,
} from "@communicator/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  RealtimeSocketTelemetryEventSchema,
  buildRealtimeSocketTelemetryEvents,
  createRealtimeSocketLogger,
  logRealtimeSocketOutcome,
  realtimeSocketLoggerFromEnv,
} from "../../realtime/telemetry";

const subject = {
  tenant_id: "tenant_telemetry",
  subscriptions: [
    { identity_id: "identity_human", families: ["projection"] },
    { identity_id: "identity_agent", families: ["projection"] },
  ] as RealtimeSubscription[],
  resumed: true,
};

describe("realtime socket telemetry", () => {
  it("builds one bounded event per subscribed identity", () => {
    const events = buildRealtimeSocketTelemetryEvents(
      subject,
      "resumed",
      2,
      "2026-09-11T00:00:00.000Z",
    );

    expect(events).toEqual([
      {
        schema_version: 1,
        type: "realtime.socket",
        outcome: "resumed",
        tenant_id: "tenant_telemetry",
        identity_id: "identity_human",
        active_tenant_socket_count: 2,
        resumed: true,
        timestamp: "2026-09-11T00:00:00.000Z",
      },
      {
        schema_version: 1,
        type: "realtime.socket",
        outcome: "resumed",
        tenant_id: "tenant_telemetry",
        identity_id: "identity_agent",
        active_tenant_socket_count: 2,
        resumed: true,
        timestamp: "2026-09-11T00:00:00.000Z",
      },
    ]);
    for (const event of events) {
      expect(RealtimeSocketTelemetryEventSchema.safeParse(event).success).toBe(
        true,
      );
    }
  });

  it("accepts only the closed set of outcomes", () => {
    for (const outcome of [
      "accepted",
      "resumed",
      "closed",
      "lease_expired",
      "capacity_rejected",
    ] as const) {
      expect(
        buildRealtimeSocketTelemetryEvents(
          { ...subject, resumed: outcome === "resumed" },
          outcome,
          0,
          "2026-09-11T00:00:00.000Z",
        ),
      ).toHaveLength(2);
    }
    expect(() =>
      buildRealtimeSocketTelemetryEvents(
        subject,
        "arbitrary-label" as never,
        0,
        "2026-09-11T00:00:00.000Z",
      ),
    ).toThrow();
  });

  it("uses an injected logger and never copies secret or message fields", () => {
    const logger = vi.fn();
    logRealtimeSocketOutcome(
      logger,
      subject,
      "accepted",
      1,
      "2026-09-11T00:00:00.000Z",
    );

    expect(logger).toHaveBeenCalledTimes(2);
    const serialized = JSON.stringify(logger.mock.calls);
    for (const forbidden of [
      "raw-ticket-sentinel",
      "digest-sentinel",
      "internal-context-sentinel",
      "Bearer access-token-sentinel",
      "message body sentinel",
      "message preview sentinel",
      "event-id-sentinel",
      "matrix-id-sentinel",
      "remote-id-sentinel",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).not.toContain(REALTIME_SUBPROTOCOL);
  });

  it("uses console.info as the fallback and emits only the strict event", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const logger = realtimeSocketLoggerFromEnv({
        REALTIME_SOCKET_LOGGER: "not-a-function",
      });
      logger({
        schema_version: 1,
        type: "realtime.socket",
        outcome: "accepted",
        tenant_id: "tenant_telemetry",
        identity_id: "identity_human",
        active_tenant_socket_count: 1,
        resumed: false,
        timestamp: "2026-09-11T00:00:00.000Z",
        raw_error: { message: "raw-error-sentinel" },
        raw_ticket: "raw-ticket-sentinel",
        digest: "digest-sentinel",
        internal_context: "internal-context-sentinel",
        authorization: "Bearer access-token-sentinel",
        message_body: "message body sentinel",
        message_preview: "message preview sentinel",
        matrix_id: "matrix-id-sentinel",
        remote_id: "remote-id-sentinel",
        arbitrary_label: "arbitrary-label-sentinel",
        caller_controlled: { value: "caller-controlled-object-sentinel" },
      } as never);

      expect(info).toHaveBeenCalledTimes(1);
      const logged = info.mock.calls[0]?.[0];
      expect(RealtimeSocketTelemetryEventSchema.safeParse(logged).success).toBe(
        true,
      );
      expect(logged).toEqual({
        schema_version: 1,
        type: "realtime.socket",
        outcome: "accepted",
        tenant_id: "tenant_telemetry",
        identity_id: "identity_human",
        active_tenant_socket_count: 1,
        resumed: false,
        timestamp: "2026-09-11T00:00:00.000Z",
      });
      const serialized = JSON.stringify(info.mock.calls);
      for (const forbidden of [
        "raw-error-sentinel",
        "raw-ticket-sentinel",
        "digest-sentinel",
        "internal-context-sentinel",
        "Bearer access-token-sentinel",
        "message body sentinel",
        "message preview sentinel",
        "matrix-id-sentinel",
        "remote-id-sentinel",
        "arbitrary-label-sentinel",
        "caller-controlled-object-sentinel",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
      info.mockRestore();
    }
  });

  it("does not allow a logger to widen the event shape", () => {
    const sink = vi.fn();
    const logger = createRealtimeSocketLogger(sink);
    logger({
      schema_version: 1,
      type: "realtime.socket",
      outcome: "closed",
      tenant_id: "tenant_telemetry",
      identity_id: "identity_human",
      active_tenant_socket_count: 1,
      resumed: false,
      timestamp: "2026-09-11T00:00:00.000Z",
      secret: "must-not-be-forwarded",
    } as never);

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]?.[0]).not.toHaveProperty("secret");
  });
});
