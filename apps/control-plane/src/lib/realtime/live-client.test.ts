import { describe, expect, it } from "vitest";
import {
  REALTIME_SUBPROTOCOL,
  type RealtimeConnectedFrame,
  type RealtimeProjectionChangesFrame,
  type RealtimeResetRequiredFrame,
  type RealtimeServerFrame,
  type RealtimeTicketRequest,
  type RealtimeTicketResponse,
} from "@communicator/contracts";
import { SimulatedRealtimeClient } from "./simulated-client";
import { LiveRealtimeClient, type LiveRealtimeClientOptions } from "./live-client";

const NOW = Date.parse("2026-09-10T00:00:00.000Z");

class FakeTimers {
  nowMs = NOW;
  private nextHandle = 1;
  private readonly tasks = new Map<number, { due: number; callback: () => void; order: number }>();
  private order = 0;

  readonly scheduler = {
    setTimeout: (callback: () => void, delayMs: number) => {
      const handle = this.nextHandle++;
      this.tasks.set(handle, {
        due: this.nowMs + Math.max(0, delayMs),
        callback,
        order: this.order++,
      });
      return handle;
    },
    clearTimeout: (handle: unknown) => {
      if (typeof handle === "number") this.tasks.delete(handle);
    },
  };

  get pendingCount() {
    return this.tasks.size;
  }

  get nextDelay() {
    const next = [...this.tasks.values()].toSorted((left, right) => left.due - right.due || left.order - right.order)[0];
    return next ? next.due - this.nowMs : undefined;
  }

  advanceBy(delayMs: number) {
    const target = this.nowMs + delayMs;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.due <= target)
        .toSorted((left, right) => left[1].due - right[1].due || left[1].order - right[1].order)[0];
      if (!next) break;
      const [handle, task] = next;
      this.tasks.delete(handle);
      this.nowMs = task.due;
      task.callback();
    }
    this.nowMs = target;
  }
}

class MemoryStorage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  clear() {
    this.values.clear();
  }

  entries() {
    return [...this.values.entries()];
  }
}

type FakeSocketMessage = { data: unknown };

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  readonly url: string;
  readonly protocols: string | string[] | undefined;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: FakeSocketMessage) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  message(data: string) {
    this.onmessage?.({ data });
  }

  serverClose(code = 1006, reason = "abnormal") {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: code === 1000 });
  }

  close(code = 1000, reason = "") {
    this.closeCalls.push({ code, reason });
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: code === 1000 });
  }
}

class FakeTicketApi {
  readonly requests: RealtimeTicketRequest[] = [];
  readonly responses: RealtimeTicketResponse[] = [];
  private responseNumber = 0;

  async createRealtimeTicket(request: RealtimeTicketRequest): Promise<RealtimeTicketResponse> {
    this.requests.push(structuredClone(request));
    const responseNumber = ++this.responseNumber;
    const response: RealtimeTicketResponse = {
      schema_version: 1,
      ticket: `rt1_${String(responseNumber).padStart(2, "0")}${"x".repeat(41)}`,
      expires_at: new Date(NOW + 30_000).toISOString(),
      websocket_url: `wss://communicator.test/api/v1/realtime?ticket=rt1_${String(responseNumber).padStart(2, "0")}${"x".repeat(41)}`,
    };
    this.responses.push(response);
    return response;
  }
}

const options = {
  tenantId: "tenant_pilot",
  principalId: "principal_pilot",
  identityIds: ["identity_human", "identity_agent"],
  families: ["projection"],
} as const;

function connectedFrame(
  positions: RealtimeConnectedFrame["positions"] = [
    { identity_id: "identity_human", generation: 1, sequence: 0 },
    { identity_id: "identity_agent", generation: 1, sequence: 0 },
  ],
): RealtimeConnectedFrame {
  return {
    schema_version: 1,
    type: "connected",
    tenant_id: "tenant_pilot",
    positions,
    connection_expires_at: new Date(NOW + 15 * 60_000).toISOString(),
  };
}

function changesFrame(
  identityId: string,
  fromSequence: number,
  count = 1,
): RealtimeProjectionChangesFrame {
  return {
    schema_version: 1,
    type: "projection.changes",
    tenant_id: "tenant_pilot",
    identity_id: identityId,
    generation: 1,
    from_sequence: fromSequence,
    to_sequence: fromSequence + count,
    changes: Array.from({ length: count }, (_, index) => ({
      sequence: fromSequence + index,
      event_type: "message.created",
      connection_id: "connection_human_whatsapp",
      conversation_id: "conversation_human_family",
      occurred_at: "2026-09-10T00:00:01.000Z",
    })),
  };
}

function resetFrame(sequence = 7): RealtimeResetRequiredFrame {
  return {
    schema_version: 1,
    type: "reset_required",
    tenant_id: "tenant_pilot",
    identity_id: "identity_human",
    generation: 2,
    latest_sequence: sequence,
    reason: "generation_changed",
  };
}

function makeClient(
  api: FakeTicketApi,
  timers: FakeTimers,
  storage: MemoryStorage,
) {
  const clientOptions: LiveRealtimeClientOptions = {
    apiClient: api,
    webSocket: FakeWebSocket,
    clock: () => new Date(timers.nowMs),
    timers: timers.scheduler,
    storage: storage as unknown as Storage,
  };
  return new LiveRealtimeClient(clientOptions);
}

function sendFrame(socket: FakeWebSocket, frame: RealtimeServerFrame) {
  socket.message(JSON.stringify(frame));
}

describe("live realtime client", () => {
  it("requests a scoped ticket and resolves after the exact socket sends connected", async () => {
    FakeWebSocket.instances = [];
    const api = new FakeTicketApi();
    const timers = new FakeTimers();
    const storage = new MemoryStorage();
    const client = makeClient(api, timers, storage);
    const statuses: string[] = [];
    client.subscribeStatus((status) => statuses.push(status));

    const connected = client.connect(options);
    await Promise.resolve();

    expect(api.requests).toEqual([{
      schema_version: 1,
      subscriptions: [
        { identity_id: "identity_human", families: ["projection"] },
        { identity_id: "identity_agent", families: ["projection"] },
      ],
    }]);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.url).toBe(api.responses[0]?.websocket_url);
    expect(FakeWebSocket.instances[0]?.protocols).toBe(REALTIME_SUBPROTOCOL);
    expect(statuses).toEqual(["connecting"]);

    FakeWebSocket.instances[0]?.open();
    sendFrame(FakeWebSocket.instances[0]!, connectedFrame());
    await expect(connected).resolves.toBeUndefined();
    expect(statuses).toEqual(["connecting", "connected"]);
    expect(storage.entries()).toHaveLength(2);
  });

  it("delivers valid changes only for requested identities and suppresses old sequences", async () => {
    FakeWebSocket.instances = [];
    const api = new FakeTicketApi();
    const timers = new FakeTimers();
    const storage = new MemoryStorage();
    const client = makeClient(api, timers, storage);
    const events: RealtimeServerFrame[] = [];
    client.subscribe((event) => events.push(event as unknown as RealtimeServerFrame));

    const connected = client.connect({ ...options, identityIds: ["identity_human"] });
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    sendFrame(socket, connectedFrame([{ identity_id: "identity_human", generation: 1, sequence: 2 }]));
    await connected;

    sendFrame(socket, changesFrame("identity_human", 1, 3));
    sendFrame(socket, changesFrame("identity_agent", 4));
    sendFrame(socket, {
      ...changesFrame("identity_human", 4),
      tenant_id: "tenant_other",
    });
    sendFrame(socket, changesFrame("identity_human", 3));

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "connected",
      positions: [{ identity_id: "identity_human", generation: 1, sequence: 2 }],
    });
    expect(events[1]).toMatchObject({
      type: "projection.changes",
      identity_id: "identity_human",
      from_sequence: 3,
      to_sequence: 4,
      changes: [{ sequence: 3 }],
    });
    expect(JSON.stringify(events)).not.toMatch(/rt1_|wss:\/\//);
  });

  it("rejects malformed frames without delivering them", async () => {
    FakeWebSocket.instances = [];
    const api = new FakeTicketApi();
    const timers = new FakeTimers();
    const storage = new MemoryStorage();
    const client = makeClient(api, timers, storage);
    const events: RealtimeServerFrame[] = [];
    client.subscribe((event) => events.push(event as unknown as RealtimeServerFrame));

    const connected = client.connect({ ...options, identityIds: ["identity_human"] });
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    sendFrame(socket, connectedFrame([{ identity_id: "identity_human", generation: 1, sequence: 0 }]));
    await connected;

    socket.message("not json");
    socket.message(JSON.stringify({ type: "projection.changes", tenant_id: "tenant_pilot" }));

    expect(events).toHaveLength(1);
    expect(socket.closeCalls).toContainEqual({ code: 1008, reason: "invalid realtime frame" });
  });

  it("stores identity-local positions under tenant, principal, and identity keys", async () => {
    FakeWebSocket.instances = [];
    const api = new FakeTicketApi();
    const timers = new FakeTimers();
    const storage = new MemoryStorage();
    const client = makeClient(api, timers, storage);

    const connected = client.connect(options);
    await Promise.resolve();
    const firstSocket = FakeWebSocket.instances[0]!;
    firstSocket.open();
    sendFrame(firstSocket, connectedFrame());
    await connected;
    sendFrame(firstSocket, changesFrame("identity_human", 1, 2));
    firstSocket.serverClose();

    expect(timers.nextDelay).toBe(250);
    timers.advanceBy(250);
    await Promise.resolve();
    expect(api.requests).toHaveLength(2);
    expect(api.requests[1]?.resume).toEqual([
      { identity_id: "identity_human", generation: 1, after_sequence: 2 },
      { identity_id: "identity_agent", generation: 1, after_sequence: 0 },
    ]);
    expect(storage.entries().every(([key, value]) =>
      key.includes("tenant_pilot")
      && key.includes("principal_pilot")
      && !value.includes("rt1_")
      && !value.includes("wss://")
    )).toBe(true);
  });

  it("replaces a reset baseline before delivering the reset", async () => {
    FakeWebSocket.instances = [];
    const api = new FakeTicketApi();
    const timers = new FakeTimers();
    const storage = new MemoryStorage();
    const client = makeClient(api, timers, storage);
    const events: RealtimeServerFrame[] = [];
    client.subscribe((event) => events.push(event as unknown as RealtimeServerFrame));

    const connected = client.connect({ ...options, identityIds: ["identity_human"] });
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    sendFrame(socket, connectedFrame([{ identity_id: "identity_human", generation: 1, sequence: 42 }]));
    await connected;
    sendFrame(socket, resetFrame());
    socket.serverClose();
    timers.advanceBy(250);
    await Promise.resolve();

    expect(events.at(-1)).toMatchObject({ type: "reset_required", generation: 2, latest_sequence: 7 });
    expect(api.requests[1]?.resume).toEqual([
      { identity_id: "identity_human", generation: 2, after_sequence: 7 },
    ]);
  });

  it("uses bounded abnormal-close delays and a fresh ticket for each attempt", async () => {
    FakeWebSocket.instances = [];
    const api = new FakeTicketApi();
    const timers = new FakeTimers();
    const storage = new MemoryStorage();
    const client = makeClient(api, timers, storage);

    const connected = client.connect({ ...options, identityIds: ["identity_human"] });
    await Promise.resolve();
    const firstSocket = FakeWebSocket.instances[0]!;
    firstSocket.open();
    sendFrame(firstSocket, connectedFrame([{ identity_id: "identity_human", generation: 1, sequence: 0 }]));
    await connected;

    for (const delay of [250, 500, 1_000, 2_000, 5_000]) {
      const socket = FakeWebSocket.instances.at(-1)!;
      socket.serverClose();
      expect(timers.nextDelay).toBe(delay);
      timers.advanceBy(delay);
      await Promise.resolve();
    }

    expect(api.requests).toHaveLength(6);
    expect(new Set(FakeWebSocket.instances.map((socket) => socket.url)).size).toBe(6);

    const finalSocket = FakeWebSocket.instances.at(-1)!;
    finalSocket.open();
    sendFrame(finalSocket, connectedFrame([{ identity_id: "identity_human", generation: 1, sequence: 0 }]));
    finalSocket.serverClose();
    expect(timers.nextDelay).toBe(250);
  });

  it("reconnects with a fresh ticket when the server lease expires", async () => {
    FakeWebSocket.instances = [];
    const api = new FakeTicketApi();
    const timers = new FakeTimers();
    const storage = new MemoryStorage();
    const client = makeClient(api, timers, storage);

    const connected = client.connect({ ...options, identityIds: ["identity_human"] });
    await Promise.resolve();
    const firstSocket = FakeWebSocket.instances[0]!;
    firstSocket.open();
    sendFrame(firstSocket, connectedFrame([{ identity_id: "identity_human", generation: 1, sequence: 0 }]));
    await connected;

    timers.advanceBy(15 * 60_000);
    timers.advanceBy(0);
    await Promise.resolve();

    expect(api.requests).toHaveLength(2);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[0]?.closeCalls).toContainEqual({ code: 1000, reason: "realtime lease expired" });
  });

  it("cancels reconnect and lease timers on explicit close", async () => {
    FakeWebSocket.instances = [];
    const api = new FakeTicketApi();
    const timers = new FakeTimers();
    const storage = new MemoryStorage();
    const client = makeClient(api, timers, storage);

    const connected = client.connect({ ...options, identityIds: ["identity_human"] });
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    sendFrame(socket, connectedFrame([{ identity_id: "identity_human", generation: 1, sequence: 0 }]));
    await connected;
    socket.serverClose();
    client.close();

    expect(timers.pendingCount).toBe(0);
    timers.advanceBy(60_000);
    expect(api.requests).toHaveLength(1);
    expect(client.status).toBe("idle");
  });

  it("keeps simulated message and command events scoped without ticket or socket work", async () => {
    const client = new SimulatedRealtimeClient(() => new Date(NOW));
    const events: unknown[] = [];
    client.subscribe((event) => events.push(event));
    await client.connect({
      tenantId: "tenant_pilot",
      principalId: "principal_pilot",
      identityIds: ["identity_human"],
      families: ["projection"],
    });

    client.publishMessage({
      tenantId: "tenant_pilot",
      identityId: "identity_agent",
      connectionId: "connection_agent_whatsapp",
      conversationId: "conversation_agent_one",
      lastMessagePreview: "Hidden",
      lastActivityAt: "2026-09-10T00:00:01.000Z",
      unreadDelta: 1,
    });
    client.publishMessage({
      tenantId: "tenant_pilot",
      identityId: "identity_human",
      connectionId: "connection_human_whatsapp",
      conversationId: "conversation_human_family",
      lastMessagePreview: "Visible",
      lastActivityAt: "2026-09-10T00:00:02.000Z",
      unreadDelta: 1,
    });

    expect(events).toHaveLength(1);
    expect(client.status).toBe("connected");

    client.publishCommand({
      id: "command_agent",
      tenant_id: "tenant_pilot",
      identity_id: "identity_agent",
      conversation_id: "conversation_agent_one",
      operation: "message.send",
      delivery_mode: "direct",
      status: "accepted",
      created_at: "2026-09-10T00:00:03.000Z",
      updated_at: "2026-09-10T00:00:03.000Z",
    });
    client.publishCommand({
      id: "command_human",
      tenant_id: "tenant_pilot",
      identity_id: "identity_human",
      conversation_id: "conversation_human_family",
      operation: "message.send",
      delivery_mode: "direct",
      status: "accepted",
      created_at: "2026-09-10T00:00:04.000Z",
      updated_at: "2026-09-10T00:00:04.000Z",
    });

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: "command.updated", identity_id: "identity_human" });
  });
});
