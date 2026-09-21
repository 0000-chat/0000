import { expect, test } from "bun:test";

import { parseWaitCommand, waitForMessages } from "./wait";

test("parses a wait command with an integer cursor and duration timeout", () => {
  expect(parseWaitCommand(["wait", "https://msg.0000.chat/room-1", "--after", "4", "--timeout", "2s"])).toEqual({
    after: 4,
    conversationUrl: "https://msg.0000.chat/room-1",
    timeoutMs: 2_000,
  });
});

test("uses a finite default and rejects unsafe or overlong timeout overrides", () => {
  expect(parseWaitCommand(["wait", "https://msg.0000.chat/room-1", "--after", "4"])).toEqual({
    after: 4,
    conversationUrl: "https://msg.0000.chat/room-1",
  });
  expect(parseWaitCommand(["wait", "https://msg.0000.chat/room-1", "--after", "4", "--timeout", "5m"]).timeoutMs).toBe(300_000);
  expect(() => parseWaitCommand(["wait", "https://msg.0000.chat/room-1", "--after", "4", "--timeout", "0ms"])).toThrow("positive duration");
  expect(() => parseWaitCommand(["wait", "https://msg.0000.chat/room-1", "--after", "4", "--timeout", "301s"])).toThrow("5 minutes");
  expect(() => parseWaitCommand(["wait", "https://msg.0000.chat/room-1", "--after", "4", "--timeout", "999999999999999999999ms"])).toThrow("5 minutes");
});

test("rejects a non-production conversation URL and malformed cursor", () => {
  expect(() => parseWaitCommand(["wait", "https://example.test/room-1", "--after", "4"])).toThrow("https://msg.0000.chat/{room}");
  expect(parseWaitCommand(["wait", "https://msg.0000.chat/room-1", "--after", "0"])).toMatchObject({ after: 0 });
  expect(() => parseWaitCommand(["wait", "https://msg.0000.chat/room-1", "--after", "9007199254740992"])).toThrow("safe integer");
});

test("returns the first read result when messages already exist", async () => {
  const controller = new AbortController();
  const result = await waitForMessages({
    after: 4,
    conversationUrl: "https://msg.0000.chat/room-1",
    fetch: async (input, init) => {
      expect(input).toBe("https://msg.0000.chat/room-1?after=4&limit=20");
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toEqual({ accept: "application/json" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json(boundedRead(5, [{ content: "hello", id: "m5", sequence: 5 }]));
    },
    signal: controller.signal,
    websocket: () => { throw new Error("WebSocket must not connect when messages exist."); },
  });

  expect(result).toEqual({ event: "new_messages", ...boundedResult(5, [{ content: "hello", id: "m5", sequence: 5 }]) });
});

test("delivers one bounded page without draining or subscribing", async () => {
  let reads = 0;
  const result = await waitForMessages({
    after: 4,
    conversationUrl: "https://msg.0000.chat/room-1",
    fetch: async () => {
      reads += 1;
      return Response.json(boundedRead(8, [
        { content: "first", id: "m5", sequence: 5 },
        { content: "second", id: "m6", sequence: 6 },
      ], 4, 6, true));
    },
    websocket: () => { throw new Error("WebSocket must not connect after a bounded page is delivered."); },
  });

  expect(result).toEqual({ event: "new_messages", ...boundedResult(8, [
    { content: "first", id: "m5", sequence: 5 },
    { content: "second", id: "m6", sequence: 6 },
  ], 4, 6, true) });
  expect(reads).toBe(1);
});

test.each([
  ["https://msg.0000.chat/room-1", "wss://msg.0000.chat/room-1/live?after=4"],
  ["http://localhost:8791/room-1", "ws://localhost:8791/room-1/live?after=4"],
])("reads again after a ready frame closes the read-to-live race at %s", async (conversationUrl, socketUrl) => {
  const socket = new FakeSocket();
  let reads = 0;
  const pending = waitForMessages({
    after: 4,
    conversationUrl,
    fetch: async () => Response.json(reads++ === 0
      ? boundedRead(4, [])
      : boundedRead(5, [{ content: "later", id: "m5", sequence: 5 }])),
    websocket: (url) => {
      expect(url).toBe(socketUrl);
      return socket;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.message({ type: "ready", latest_message: 5 });

  await expect(pending).resolves.toEqual({ event: "new_messages", ...boundedResult(5, [{ content: "later", id: "m5", sequence: 5 }]) });
  expect(socket.closed).toBe(true);
});

test("reconnects after a transient close and resolves only once", async () => {
  const sockets: FakeSocket[] = [];
  const delays: number[] = [];
  let reads = 0;
  const pending = waitForMessages({
    after: 4,
    conversationUrl: "https://msg.0000.chat/room-1",
    fetch: async () => Response.json(reads++ < 2
      ? boundedRead(4, [])
      : boundedRead(5, [{ content: "later", id: "m5", sequence: 5 }])),
    sleep: async (delay) => { delays.push(delay); },
    websocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  sockets[0]?.closeEvent();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(sockets).toHaveLength(2);
  sockets[1]?.message({ type: "ready", latest_message: 5 });
  sockets[1]?.message({ type: "message.created", latest_message: 5 });

  await expect(pending).resolves.toEqual({ event: "new_messages", ...boundedResult(5, [{ content: "later", id: "m5", sequence: 5 }]) });
  expect(delays).toEqual([250]);
  expect(sockets).toHaveLength(2);
});

test("ignores delayed close and error events from a replaced socket", async () => {
  const controller = new AbortController();
  const sockets: FakeSocket[] = [];
  const delays: number[] = [];
  let returnMessages = false;
  const pending = waitForMessages({
    after: 4,
    conversationUrl: "https://msg.0000.chat/room-1",
    fetch: async () => Response.json(returnMessages
      ? boundedRead(5, [{ content: "later", id: "m5", sequence: 5 }])
      : boundedRead(4, [])),
    signal: controller.signal,
    sleep: async (delay) => { delays.push(delay); },
    websocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    sockets[0]?.closeEvent();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sockets).toHaveLength(2);

    sockets[0]?.errorEvent();
    sockets[0]?.closeEvent();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sockets).toHaveLength(2);
    expect(sockets[1]?.closed).toBe(false);
    expect(delays).toEqual([250]);

    returnMessages = true;
    sockets[1]?.message({ type: "ready", latest_message: 5 });
    await expect(pending).resolves.toMatchObject({ latest_message: 5 });
  } finally {
    controller.abort();
    await pending.catch(() => {});
  }
});

test("stops on a permanent read error found during reconnection", async () => {
  const socket = new FakeSocket();
  let reads = 0;
  const pending = waitForMessages({
    after: 4,
    conversationUrl: "https://msg.0000.chat/room-1",
    fetch: async () => reads++ === 0
      ? Response.json(boundedRead(4, []))
      : new Response("expired", { status: 410 }),
    sleep: async () => {},
    timeoutMs: 10,
    websocket: () => socket,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.closeEvent();

  await expect(pending).rejects.toThrow("HTTP 410");
});

test("aborts a reconnect backoff and clears its delay timer", async () => {
  const controller = new AbortController();
  const socket = new FakeSocket();
  const timers: (() => void)[] = [];
  const cleared: number[] = [];
  const pending = waitForMessages({
    after: 4,
    conversationUrl: "https://msg.0000.chat/room-1",
    clearTimer: (timer) => cleared.push(timer as number),
    fetch: async () => Response.json(boundedRead(4, [])),
    setTimer: (callback) => { timers.push(callback); return 1; },
    signal: controller.signal,
    websocket: () => socket,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.closeEvent();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(timers).toHaveLength(2);
  controller.abort();
  await expect(pending).rejects.toThrow("interrupted");
  expect(cleared).toEqual([1, 1]);
});

test("clears an active reconnect backoff when the wait times out", async () => {
  const socket = new FakeSocket();
  const timers: (() => void)[] = [];
  const cleared: number[] = [];
  const pending = waitForMessages({
    after: 4,
    conversationUrl: "https://msg.0000.chat/room-1",
    clearTimer: (timer) => cleared.push(timer as number),
    fetch: async () => Response.json(boundedRead(4, [])),
    setTimer: (callback) => { timers.push(callback); return timers.length; },
    timeoutMs: 10,
    websocket: () => socket,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.closeEvent();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(timers).toHaveLength(2);
  timers[0]?.();
  await expect(pending).resolves.toEqual({ event: "timeout", messages: [], next_after: 4, latest_message: 4 });
  expect(cleared).toEqual([1, 2]);
});

test("clears an active reconnect backoff when a live refresh finds messages", async () => {
  const socket = new FakeSocket();
  const timers: (() => void)[] = [];
  const cleared: number[] = [];
  let resolveRefresh: ((response: Response) => void) | undefined;
  let reads = 0;
  const pending = waitForMessages({
    after: 4,
    conversationUrl: "https://msg.0000.chat/room-1",
    clearTimer: (timer) => cleared.push(timer as number),
    fetch: async () => reads++ === 0
      ? Response.json(boundedRead(4, []))
      : await new Promise<Response>((resolve) => { resolveRefresh = resolve; }),
    setTimer: (callback) => { timers.push(callback); return timers.length; },
    websocket: () => socket,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.message({ type: "ready", latest_message: 5 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.closeEvent();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(timers).toHaveLength(2);
  resolveRefresh?.(Response.json(boundedRead(5, [{ content: "later", id: "m5", sequence: 5 }])));
  await expect(pending).resolves.toMatchObject({ event: "new_messages", latest_message: 5 });
  expect(cleared).toEqual([1, 2]);
});

test("timeout aborts an in-flight live refresh owned by the wait", async () => {
  const socket = new FakeSocket();
  const timers: (() => void)[] = [];
  const signals: AbortSignal[] = [];
  let reads = 0;
  const pending = waitForMessages({
    after: 4,
    conversationUrl: "https://msg.0000.chat/room-1",
    fetch: async (_input, init) => {
      signals.push(init?.signal as AbortSignal);
      if (reads++ === 0) return Response.json(boundedRead(4, []));
      return await new Promise<Response>(() => {});
    },
    setTimer: (callback) => { timers.push(callback); return timers.length; },
    timeoutMs: 10,
    websocket: () => socket,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.message({ type: "ready", latest_message: 5 });
  await new Promise((resolve) => setTimeout(resolve, 0));

  timers[0]?.();
  await expect(pending).resolves.toMatchObject({ event: "timeout", messages: [], next_after: 4, latest_message: 4 });
  expect(signals[1]?.aborted).toBe(true);
});

test("coalesces duplicate live frames and aborts the owned signal after success", async () => {
  const socket = new FakeSocket();
  const signals: AbortSignal[] = [];
  let resolveRefresh: ((response: Response) => void) | undefined;
  let reads = 0;
  const pending = waitForMessages({
    after: 4,
    conversationUrl: "https://msg.0000.chat/room-1",
    fetch: async (_input, init) => {
      signals.push(init?.signal as AbortSignal);
      if (reads++ === 0) return Response.json(boundedRead(4, []));
      return await new Promise<Response>((resolve) => { resolveRefresh = resolve; });
    },
    websocket: () => socket,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.message({ type: "ready", latest_message: 5 });
  socket.message({ type: "message.created", latest_message: 5 });
  socket.message({ type: "message.created", latest_message: 5 });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(reads).toBe(2);
  resolveRefresh?.(Response.json(boundedRead(5, [{ content: "later", id: "m5", sequence: 5 }])));
  await expect(pending).resolves.toMatchObject({ latest_message: 5 });
  expect(signals[1]?.aborted).toBe(true);
});

test("retains a notification that arrives during an empty refresh", async () => {
  const socket = new FakeSocket();
  const pendingReads: ((response: Response) => void)[] = [];
  let reads = 0;
  const pending = waitForMessages({
    after: 4,
    conversationUrl: "https://msg.0000.chat/room-1",
    fetch: async () => reads++ === 0
      ? Response.json(boundedRead(4, []))
      : await new Promise<Response>((resolve) => { pendingReads.push(resolve); }),
    websocket: () => socket,
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.message({ type: "ready", latest_message: 5 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(reads).toBe(2);

  socket.message({ type: "message.created", latest_message: 5 });
  pendingReads[0]?.(Response.json(boundedRead(5, [])));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(reads).toBe(3);

  pendingReads[1]?.(Response.json(boundedRead(5, [{ content: "later", id: "m5", sequence: 5 }])));
  await expect(pending).resolves.toMatchObject({ event: "new_messages", next_after: 5, through: 5 });
  expect(socket.closed).toBe(true);
  expect(reads).toBe(3);
});

test("validates direct wait options and rejects legacy unbounded responses", async () => {
  const dependencies = {
    conversationUrl: "https://msg.0000.chat/room-1",
    fetch: async () => Response.json({ protocol_version: 1, latest_message: 4, messages: [] }),
    websocket: () => new FakeSocket(),
  };
  await expect(waitForMessages({ ...dependencies, after: 4, timeoutMs: 0 })).rejects.toThrow("timeoutMs");
  await expect(waitForMessages({ ...dependencies, after: -1 })).rejects.toThrow("after");
  await expect(waitForMessages({ ...dependencies, after: 4 })).rejects.toThrow("bounded reads");
});

test("ends with a structured timeout result when no messages arrive", async () => {
  const timers: (() => void)[] = [];
  const status: string[] = [];
  const pending = waitForMessages({
    after: 4,
    conversationUrl: "https://msg.0000.chat/room-1",
    fetch: async () => Response.json(boundedRead(4, [])),
    timeoutMs: 1,
    setTimer: (callback) => { timers.push(callback); return 1; },
    status: (text) => status.push(text),
    websocket: () => new FakeSocket(),
  });

  expect(timers).toHaveLength(1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(status).toEqual(["Waiting for new messages."]);
  timers[0]?.();
  await expect(pending).resolves.toEqual({ event: "timeout", messages: [], next_after: 4, latest_message: 4 });
});

test("times out a hanging initial read without inventing a latest sequence", async () => {
  const timers: (() => void)[] = [];
  let readSignal: AbortSignal | undefined;
  const pending = waitForMessages({
    after: 4,
    conversationUrl: "https://msg.0000.chat/room-1",
    fetch: async (_input, init) => {
      readSignal = init?.signal;
      return await new Promise<Response>(() => {});
    },
    setTimer: (callback) => { timers.push(callback); return timers.length; },
    timeoutMs: 10,
    websocket: () => new FakeSocket(),
  });

  expect(timers).toHaveLength(1);
  timers[0]?.();
  await expect(pending).resolves.toEqual({ event: "timeout", messages: [], next_after: 4 });
  expect(readSignal?.aborted).toBe(true);
});

function boundedRead(latest: number, messages: readonly { readonly sequence: number }[], after = 4, through = latest, has_more = false) {
  return {
    protocol_version: 1,
    latest_message: latest,
    messages,
    next_after: messages.at(-1)?.sequence ?? after,
    has_more,
    through,
  };
}

function boundedResult(latest: number, messages: readonly { readonly sequence: number }[], after = 4, through = latest, has_more = false) {
  const { protocol_version: _protocolVersion, ...result } = boundedRead(latest, messages, after, through, has_more);
  return result;
}

class FakeSocket {
  closed = false;
  private readonly listeners = new Map<string, ((event: { data?: string }) => void)[]>();

  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void { this.closed = true; }

  message(value: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) listener({ data: JSON.stringify(value) });
  }

  closeEvent(): void {
    for (const listener of this.listeners.get("close") ?? []) listener({});
  }

  errorEvent(): void {
    for (const listener of this.listeners.get("error") ?? []) listener({});
  }
}
