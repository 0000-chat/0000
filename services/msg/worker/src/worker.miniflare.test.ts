import { rm } from "node:fs/promises";
import { afterAll, expect, test } from "bun:test";
import WebSocketClient from "ws";

import { createMsgMiniflareTempDirectory, SHORT_LIVED_TEST_ROOM_LIMITS, startMsgMiniflare, TEST_ROOM_LIMITS } from "../test-fixtures/msg-worker.miniflare-fixture";

const jsonHeaders = { accept: "application/json", "content-type": "application/json" };

let sharedFixture: Awaited<ReturnType<typeof startMsgMiniflare>> | undefined;
let sharedPersistenceDirectory: string | undefined;

afterAll(async () => {
  await disposeSharedRuntime();
});

async function disposeSharedRuntime() {
  const fixture = sharedFixture;
  const persistenceDirectory = sharedPersistenceDirectory;
  sharedFixture = undefined;
  sharedPersistenceDirectory = undefined;
  let failed = false;
  let failure: unknown;
  try {
    try {
      await fixture?.dispose();
    } catch (error) {
      failed = true;
      failure = error;
    }
  } finally {
    try {
      if (persistenceDirectory) await rm(persistenceDirectory, { force: true, recursive: true });
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }
  if (failed) throw failure;
}

async function withSharedRuntime(run: (miniflare: Awaited<ReturnType<typeof startMsgMiniflare>>["miniflare"]) => Promise<void>) {
  if (!sharedFixture) {
    sharedPersistenceDirectory = await createMsgMiniflareTempDirectory("state");
    sharedFixture = await startMsgMiniflare(sharedPersistenceDirectory);
  }
  await run(sharedFixture.miniflare);
}

async function withRuntime(
  run: (miniflare: Awaited<ReturnType<typeof startMsgMiniflare>>["miniflare"]) => Promise<void>,
  limits?: typeof SHORT_LIVED_TEST_ROOM_LIMITS,
) {
  // A Miniflare runtime owns the process-wide workerd test slot. The shared
  // default runtime must close before a test starts with different limits.
  await disposeSharedRuntime();
  const persistenceDirectory = await createMsgMiniflareTempDirectory("state");
  let fixture: Awaited<ReturnType<typeof startMsgMiniflare>> | undefined;
  let failed = false;
  let failure: unknown;
  try {
    fixture = await startMsgMiniflare(persistenceDirectory, limits);
    await run(fixture.miniflare);
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    try {
      try {
        await fixture?.dispose();
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    } finally {
      try {
        await rm(persistenceDirectory, { force: true, recursive: true });
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  }
  if (failed) throw failure;
}

async function createRoom(miniflare: Awaited<ReturnType<typeof startMsgMiniflare>>["miniflare"], content = "first") {
  const response = await miniflare.dispatchFetch("https://msg.0000.chat/", {
    body: JSON.stringify({ content, author: "alpha", display_name: "Alpha", semantic_type: "message" }),
    headers: jsonHeaders,
    method: "POST",
  });
  expect(response.status).toBe(201);
  return await response.json() as { conversation_url: string; manage_url: string; room: { id: string } };
}

async function post(miniflare: Awaited<ReturnType<typeof startMsgMiniflare>>["miniflare"], room: string, content: string, idempotencyKey?: string) {
  return miniflare.dispatchFetch(`https://msg.0000.chat/${room}`, {
    body: JSON.stringify({ content, author: "beta", display_name: "Beta", semantic_type: "message" }),
    headers: { ...jsonHeaders, ...(idempotencyKey !== undefined ? { "idempotency-key": idempotencyKey } : {}) },
    method: "POST",
  });
}

function socketUrl(server: URL, room: string): string {
  const url = new URL(`/${room}/live`, server);
  if (url.hostname === "[::]") url.hostname = "127.0.0.1";
  url.protocol = "ws:";
  return url.toString();
}

interface LiveSocket {
  readonly messages: string[];
  readonly socket: WebSocketClient;
}

function openSocket(url: string): Promise<LiveSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketClient(url);
    const messages: string[] = [];
    socket.on("message", (data) => messages.push(data.toString()));
    socket.on("error", reject);
    socket.once("open", () => resolve({ messages, socket }));
  });
}

function nextSocketMessage(live: LiveSocket, timeoutMs = 1_000): Promise<string> {
  const queued = live.messages.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for a WebSocket message.")), timeoutMs);
    live.socket.once("message", (data) => {
      clearTimeout(timeout);
      const message = data.toString();
      const index = live.messages.indexOf(message);
      if (index >= 0) live.messages.splice(index, 1);
      resolve(message);
    });
    live.socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function nextSocketClose(live: LiveSocket, timeoutMs = 1_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket close.")), timeoutMs);
    live.socket.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
    live.socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function waitForStatus(miniflare: Awaited<ReturnType<typeof startMsgMiniflare>>["miniflare"], path: string, status: number, timeoutMs = 1_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let response = await miniflare.dispatchFetch(`https://msg.0000.chat${path}`, { headers: { accept: "application/json" } });
  while (response.status !== status && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    response = await miniflare.dispatchFetch(`https://msg.0000.chat${path}`, { headers: { accept: "application/json" } });
  }
  return response;
}

test.serial("persists rooms across workerd restarts", { timeout: 15_000 }, async () => {
  const persistenceDirectory = await createMsgMiniflareTempDirectory("state");
  let first: Awaited<ReturnType<typeof startMsgMiniflare>> | undefined;
  let second: Awaited<ReturnType<typeof startMsgMiniflare>> | undefined;
  let failed = false;
  let failure: unknown;
  try {
    first = await startMsgMiniflare(persistenceDirectory);
    const { room } = await createRoom(first.miniflare);
    expect((await post(first.miniflare, room.id, "persisted")).status).toBe(201);
    await first.dispose();
    first = undefined;
    second = await startMsgMiniflare(persistenceDirectory);
    const read = await second.miniflare.dispatchFetch(`https://msg.0000.chat/${room.id}`, { headers: { accept: "application/json" } });
    expect((await read.json() as { latest_message: number }).latest_message).toBe(2);
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    try {
      try {
        await first?.dispose();
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    } finally {
      try {
        try {
          await second?.dispose();
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      } finally {
        try {
          await rm(persistenceDirectory, { force: true, recursive: true });
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      }
    }
  }
  if (failed) throw failure;
});

test.serial("runs the production Worker against SQLite Durable Objects", { timeout: 15_000 }, async () => {
  await withSharedRuntime(async (miniflare) => {
    const created = await createRoom(miniflare);
    const room = created.room.id;
    expect((await miniflare.dispatchFetch(`https://msg.0000.chat/${room}`, { headers: { accept: "application/json" } })).status).toBe(200);
    expect((await post(miniflare, room, "second")).status).toBe(201);
    const transcript = await miniflare.dispatchFetch(`https://msg.0000.chat/${room}`, { headers: { accept: "application/json" } });
    expect((await transcript.json() as { messages: Array<{ content: string; sequence: number }> }).messages).toEqual([
      { author: "alpha", byte_count: expect.any(Number), content: "first", created_at: expect.any(String), display_name: "Alpha", id: expect.any(String), identity_verified: false, semantic_type: "message", sequence: 1 },
      { author: "beta", byte_count: expect.any(Number), content: "second", created_at: expect.any(String), display_name: "Beta", id: expect.any(String), identity_verified: false, semantic_type: "message", sequence: 2 },
    ]);
  });
});

test.serial("serves the agent representation through a real Durable Object", { timeout: 15_000 }, async () => {
  await withSharedRuntime(async (miniflare) => {
    const { room } = await createRoom(miniflare, "participant message");
    const text = await miniflare.dispatchFetch(`https://msg.0000.chat/${room.id}/agent`);
    expect(text.status).toBe(200);
    expect(text.headers.get("content-type")).toContain("text/plain");
    expect(await text.text()).toContain("UNTRUSTED PARTICIPANT MESSAGES");

    const json = await miniflare.dispatchFetch(`https://msg.0000.chat/${room.id}/agent`, {
      headers: { accept: "application/json" },
    });
    expect(json.status).toBe(200);
    expect(await json.json()).toMatchObject({
      conversation_url: `https://msg.0000.chat/${room.id}`,
      wait: { requires_user_consent: true },
    });
  });
});

test.serial("serializes concurrent posts with unique consecutive sequences", { timeout: 15_000 }, async () => {
  await withSharedRuntime(async (miniflare) => {
    const { room } = await createRoom(miniflare);
    const responses = await Promise.all(Array.from({ length: 3 }, (_, index) => post(miniflare, room.id, `message-${index}`)));
    expect(await Promise.all(responses.map(async (response) => (await response.json() as { message: { sequence: number } }).message.sequence))).toEqual([2, 3, 4]);
  });
});

test.serial("replays exact idempotent posts and rejects changed retries", { timeout: 15_000 }, async () => {
  await withSharedRuntime(async (miniflare) => {
    const { room } = await createRoom(miniflare);
    const first = await post(miniflare, room.id, "retry me", "retry-key");
    const replay = await post(miniflare, room.id, "retry me", "retry-key");
    const conflict = await post(miniflare, room.id, "changed", "retry-key");
    expect((await first.json() as { replayed: boolean }).replayed).toBe(false);
    expect((await replay.json() as { replayed: boolean }).replayed).toBe(true);
    expect(conflict.status).toBe(409);
    const empty = await post(miniflare, room.id, "empty key", "");
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ error: { code: "invalid_body" } });
  });
});

test.serial("renders Durable Object export errors in the negotiated public representation", { timeout: 15_000 }, async () => {
  await withRuntime(async (miniflare) => {
    const deleted = await createRoom(miniflare);
    expect((await miniflare.dispatchFetch(deleted.manage_url, { headers: { accept: "application/json" }, method: "DELETE" })).status).toBe(200);
    for (const [accept, type] of [["application/json", "application/json"], ["text/html", "text/html"], ["text/markdown", "text/markdown"]] as const) {
      for (const [path, status, code] of [["/missing-room/export.json", 404, "not_found"], [`/${deleted.room.id}/export.md`, 410, "gone"]] as const) {
        const response = await miniflare.dispatchFetch(`https://msg.0000.chat${path}`, { headers: { accept } });
        expect(response.status).toBe(status);
        expect(response.headers.get("content-type")).toContain(type);
        expect(response.headers.get("cache-control")).toBe("private, no-store, no-transform");
        expect(await response.text()).toContain(code);
      }
    }
  }, { ...TEST_ROOM_LIMITS, tombstoneTtlMs: 5_000 });
});

test.serial("returns gone after management deletion and enforces the test quota", { timeout: 15_000 }, async () => {
  await withRuntime(async (miniflare) => {
    const quotaRoom = await createRoom(miniflare);
    expect((await post(miniflare, quotaRoom.room.id, "second")).status).toBe(201);
    expect((await post(miniflare, quotaRoom.room.id, "third")).status).toBe(201);
    expect((await post(miniflare, quotaRoom.room.id, "fourth")).status).toBe(201);
    expect((await post(miniflare, quotaRoom.room.id, "too many")).status).toBe(429);

    const deleted = await miniflare.dispatchFetch(quotaRoom.manage_url, { headers: { accept: "application/json" }, method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect((await miniflare.dispatchFetch(`https://msg.0000.chat/${quotaRoom.room.id}`, { headers: { accept: "application/json" } })).status).toBe(410);
    expect((await waitForStatus(miniflare, `/${quotaRoom.room.id}`, 404, 2_000)).status).toBe(404);
  }, { ...TEST_ROOM_LIMITS, tombstoneTtlMs: 1_000 });
});

test.serial("sends live metadata frames and rejects client socket messages", { timeout: 15_000 }, async () => {
  await withSharedRuntime(async (miniflare) => {
    const { room } = await createRoom(miniflare);
    const live = await openSocket(socketUrl(await miniflare.ready, room.id));
    const ready = await nextSocketMessage(live);
    expect(JSON.parse(ready)).toMatchObject({ latest_message: 1, type: "ready" });
    expect((await post(miniflare, room.id, "private message")).status).toBe(201);
    const created = await nextSocketMessage(live);
    expect(JSON.parse(created)).toMatchObject({ latest_message: 2, sequence: 2, type: "message.created" });
    expect(created).not.toContain("private message");
    live.socket.send("client attempt");
    expect(await nextSocketClose(live)).toBe(1008);
  });
});

test.serial("uses workerd alarms to tombstone then purge expired rooms", { timeout: 15_000 }, async () => {
  await withRuntime(async (miniflare) => {
    const { room } = await createRoom(miniflare);
    const live = await openSocket(socketUrl(await miniflare.ready, room.id));
    await nextSocketMessage(live);
    const expired = await nextSocketMessage(live);
    expect(JSON.parse(expired)).toMatchObject({ type: "conversation.expired" });
    // workerd v1.20260515.1 closes hibernating sockets with 1000 after the
    // Durable Object sends 1001; the expiry frame proves the alarm path ran.
    expect(await nextSocketClose(live)).toBe(1000);
    expect((await miniflare.dispatchFetch(`https://msg.0000.chat/${room.id}`, { headers: { accept: "application/json" } })).status).toBe(410);
    expect((await waitForStatus(miniflare, `/${room.id}`, 404)).status).toBe(404);
  }, SHORT_LIVED_TEST_ROOM_LIMITS);
});
