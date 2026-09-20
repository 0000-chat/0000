import { expect, test } from "bun:test";

import { parseWaitCommand, waitForMessages } from "./wait";

test("parses a wait command with an integer cursor and duration timeout", () => {
  expect(parseWaitCommand(["wait", "https://msg.0000.chat/room-1", "--after", "4", "--timeout", "2s"])).toEqual({
    after: 4,
    conversationUrl: "https://msg.0000.chat/room-1",
    timeoutMs: 2_000,
  });
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
      expect(input).toBe("https://msg.0000.chat/room-1?after=4");
      expect(init).toEqual({ headers: { accept: "application/json" }, signal: controller.signal });
      return Response.json({ latest_message: 5, messages: [{ content: "hello", id: "m5", sequence: 5 }] });
    },
    signal: controller.signal,
    websocket: () => { throw new Error("WebSocket must not connect when messages exist."); },
  });

  expect(result).toEqual({ latest_message: 5, messages: [{ content: "hello", id: "m5", sequence: 5 }] });
});

test("reads again after a ready frame closes the read-to-live race", async () => {
  const socket = new FakeSocket();
  let reads = 0;
  const pending = waitForMessages({
    after: 4,
    conversationUrl: "https://msg.0000.chat/room-1",
    fetch: async () => Response.json(reads++ === 0
      ? { latest_message: 4, messages: [] }
      : { latest_message: 5, messages: [{ content: "later", id: "m5", sequence: 5 }] }),
    websocket: (url) => {
      expect(url).toBe("wss://msg.0000.chat/room-1/live?after=4");
      return socket;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.message({ type: "ready", latest_message: 5 });

  await expect(pending).resolves.toEqual({ latest_message: 5, messages: [{ content: "later", id: "m5", sequence: 5 }] });
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
      ? { latest_message: 4, messages: [] }
      : { latest_message: 5, messages: [{ content: "later", id: "m5", sequence: 5 }] }),
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

  await expect(pending).resolves.toEqual({ latest_message: 5, messages: [{ content: "later", id: "m5", sequence: 5 }] });
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
      ? { latest_message: 5, messages: [{ content: "later", id: "m5", sequence: 5 }] }
      : { latest_message: 4, messages: [] }),
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
      ? Response.json({ latest_message: 4, messages: [] })
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
    fetch: async () => Response.json({ latest_message: 4, messages: [] }),
    setTimer: (callback) => { timers.push(callback); return 1; },
    signal: controller.signal,
    websocket: () => socket,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.closeEvent();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(timers).toHaveLength(1);
  controller.abort();
  await expect(pending).rejects.toThrow("interrupted");
  expect(cleared).toEqual([1]);
});

test("clears an active reconnect backoff when the wait times out", async () => {
  const socket = new FakeSocket();
  const timers: (() => void)[] = [];
  const cleared: number[] = [];
  const pending = waitForMessages({
    after: 4,
    conversationUrl: "https://msg.0000.chat/room-1",
    clearTimer: (timer) => cleared.push(timer as number),
    fetch: async () => Response.json({ latest_message: 4, messages: [] }),
    setTimer: (callback) => { timers.push(callback); return timers.length; },
    timeoutMs: 10,
    websocket: () => socket,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.closeEvent();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(timers).toHaveLength(2);
  timers[0]?.();
  await expect(pending).rejects.toThrow("timed out");
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
      ? Response.json({ latest_message: 4, messages: [] })
      : await new Promise<Response>((resolve) => { resolveRefresh = resolve; }),
    setTimer: (callback) => { timers.push(callback); return timers.length; },
    websocket: () => socket,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.message({ type: "ready", latest_message: 5 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.closeEvent();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(timers).toHaveLength(1);
  resolveRefresh?.(Response.json({ latest_message: 5, messages: [{ content: "later", id: "m5", sequence: 5 }] }));
  await expect(pending).resolves.toMatchObject({ latest_message: 5 });
  expect(cleared).toEqual([1]);
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
      if (reads++ === 0) return Response.json({ latest_message: 4, messages: [] });
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
  await expect(pending).rejects.toThrow("timed out");
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
      if (reads++ === 0) return Response.json({ latest_message: 4, messages: [] });
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
  resolveRefresh?.(Response.json({ latest_message: 5, messages: [{ content: "later", id: "m5", sequence: 5 }] }));
  await expect(pending).resolves.toMatchObject({ latest_message: 5 });
  expect(signals[1]?.aborted).toBe(true);
});

test("ends with a timeout error when no messages arrive", async () => {
  const timers: (() => void)[] = [];
  const status: string[] = [];
  const pending = waitForMessages({
    after: 4,
    conversationUrl: "https://msg.0000.chat/room-1",
    fetch: async () => Response.json({ latest_message: 4, messages: [] }),
    timeoutMs: 1,
    setTimer: (callback) => { timers.push(callback); return 1; },
    status: (text) => status.push(text),
    websocket: () => new FakeSocket(),
  });

  expect(timers).toHaveLength(1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(status).toEqual(["Waiting for new messages."]);
  timers[0]?.();
  await expect(pending).rejects.toThrow("timed out");
});

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
