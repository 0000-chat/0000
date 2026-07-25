import { describe, expect, test } from "bun:test";

import {
  BridgeDeviceRealtimeClient,
  BridgeRealtimeCoordinator,
  bridgeRealtimeReconnectDelay,
  isTerminalBridgeRealtimeEvent,
  parseBridgeRealtimeServerFrame,
} from "./bridge-realtime";

describe("bridge device realtime protocol", () => {
  test("accumulates unique wake ids until a resync claim acknowledges them", () => {
    const coordinator = new BridgeRealtimeCoordinator();
    expect(
      coordinator.receive(
        JSON.stringify({ type: "wake", wakeIds: ["queue_1", "queue_2"] }),
      ),
    ).toEqual({
      reason: "wake",
      wakeIds: ["queue_1", "queue_2"],
    });
    expect(
      coordinator.receive(
        JSON.stringify({ type: "wake", wakeIds: ["queue_2", "queue_3"] }),
      ),
    ).toEqual({
      reason: "wake",
      wakeIds: ["queue_1", "queue_2", "queue_3"],
    });
    expect(coordinator.acknowledgeResync()).toEqual([
      "queue_1",
      "queue_2",
      "queue_3",
    ]);
    expect(coordinator.pendingWakeIds()).toEqual([]);
  });

  test("acknowledges only attempted wake ids and retains the rest", () => {
    const coordinator = new BridgeRealtimeCoordinator();
    coordinator.receive(
      JSON.stringify({
        type: "wake",
        wakeIds: ["queue_1", "queue_2", "queue_3"],
      }),
    );

    expect(coordinator.acknowledgeResync(["queue_1", "queue_3"])).toEqual([
      "queue_1",
      "queue_3",
    ]);
    expect(coordinator.pendingWakeIds()).toEqual(["queue_2"]);
  });

  test("captures the server-issued connection epoch before startup resync", () => {
    const coordinator = new BridgeRealtimeCoordinator();
    expect(
      coordinator.receive(
        JSON.stringify({
          connectionEpoch: "epoch_1",
          reason: "connected",
          type: "resync",
        }),
      ),
    ).toEqual({ reason: "resync", wakeIds: [] });
    expect(coordinator.connectionEpoch()).toBe("epoch_1");
  });

  test("clears a disconnected lease epoch without dropping pending wakes", () => {
    const coordinator = new BridgeRealtimeCoordinator();
    coordinator.receive(
      JSON.stringify({
        connectionEpoch: "epoch_1",
        reason: "connected",
        type: "resync",
      }),
    );
    coordinator.receive(
      JSON.stringify({ type: "wake", wakeIds: ["queue_1"] }),
    );

    coordinator.disconnect();

    expect(coordinator.connectionEpoch()).toBeUndefined();
    expect(coordinator.pendingWakeIds()).toEqual(["queue_1"]);
  });

  test("surfaces explicit control, supersession, and revocation", () => {
    const coordinator = new BridgeRealtimeCoordinator();
    expect(
      coordinator.receive(
        JSON.stringify({ controlId: "control_1", type: "control" }),
      ),
    ).toEqual({
      controlId: "control_1",
      reason: "control",
    });
    expect(coordinator.receive(JSON.stringify({ type: "superseded" }))).toEqual(
      { reason: "superseded" },
    );
    expect(coordinator.receive(JSON.stringify({ type: "revoked" }))).toEqual({
      reason: "revoked",
    });
  });

  test("treats supersession and revocation as terminal connection events", () => {
    expect(isTerminalBridgeRealtimeEvent({ reason: "superseded" })).toBe(true);
    expect(isTerminalBridgeRealtimeEvent({ reason: "revoked" })).toBe(true);
    expect(
      isTerminalBridgeRealtimeEvent({ reason: "resync", wakeIds: [] }),
    ).toBe(false);
  });

  test("closes and does not reconnect after the server supersedes the socket", async () => {
    const listeners = new Map<string, Array<(event: { data?: string }) => void>>();
    let closeCount = 0;
    let fetchCount = 0;
    const socket = {
      addEventListener(
        type: string,
        listener: (event: { data?: string }) => void,
      ) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      close() {
        closeCount += 1;
        for (const listener of listeners.get("close") ?? []) listener({});
      },
      readyState: WebSocket.OPEN,
      send() {},
    } as unknown as WebSocket;
    const client = new BridgeDeviceRealtimeClient({
      appUrl: "https://0000.chat",
      bridgeToken: "bridge-token",
      deviceId: "brdg_1",
      fetch: (async () => {
        fetchCount += 1;
        return Response.json({ ticketId: "ticket_1" });
      }) as unknown as typeof fetch,
      onEvent: () => {},
      webSocketFactory: () => socket,
    });

    await client.start();
    for (const listener of listeners.get("message") ?? []) {
      listener({ data: JSON.stringify({ type: "superseded" }) });
    }
    await Bun.sleep(1_100);

    expect(closeCount).toBe(1);
    expect(fetchCount).toBe(1);
  });

  test("rejects oversized or unknown server frames", () => {
    expect(
      parseBridgeRealtimeServerFrame("x".repeat(32 * 1024 + 1)),
    ).toBeUndefined();
    expect(
      parseBridgeRealtimeServerFrame(JSON.stringify({ type: "unknown" })),
    ).toBeUndefined();
  });

  test("uses bounded exponential reconnect backoff", () => {
    expect(bridgeRealtimeReconnectDelay(0)).toBe(1_000);
    expect(bridgeRealtimeReconnectDelay(3)).toBe(8_000);
    expect(bridgeRealtimeReconnectDelay(10)).toBe(30_000);
  });
});
