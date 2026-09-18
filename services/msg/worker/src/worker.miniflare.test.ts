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


async function withRestartedRuntime(
  run: (
    initial: Awaited<ReturnType<typeof startMsgMiniflare>>["miniflare"],
    restart: (nowMs: number) => Promise<Awaited<ReturnType<typeof startMsgMiniflare>>["miniflare"]>,
  ) => Promise<void>,
  limits: typeof TEST_ROOM_LIMITS = TEST_ROOM_LIMITS,
  nowMs = 4_000_000_000_000,
) {
  await disposeSharedRuntime();
  const persistenceDirectory = await createMsgMiniflareTempDirectory("restart");
  let fixture: Awaited<ReturnType<typeof startMsgMiniflare>> | undefined;
  let failed = false;
  let failure: unknown;
  try {
    fixture = await startMsgMiniflare(persistenceDirectory, limits, { nowMs });
    await run(fixture.miniflare, async (nextNowMs) => {
      await fixture?.dispose();
      fixture = undefined;
      fixture = await startMsgMiniflare(persistenceDirectory, limits, { nowMs: nextNowMs });
      return fixture.miniflare;
    });
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    try {
      await fixture?.dispose();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
    try {
      await rm(persistenceDirectory, { force: true, recursive: true });
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
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

async function registerWebhook(miniflare: Awaited<ReturnType<typeof startMsgMiniflare>>["miniflare"], room: string, url: string) {
  const response = await miniflare.dispatchFetch(`https://msg.0000.chat/${room}/webhooks`, {
    body: JSON.stringify({ url }),
    headers: jsonHeaders,
    method: "POST",
  });
  expect(response.status).toBe(201);
  return await response.json() as { secret: string; webhook: { id: string; url: string } };
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

async function waitForOutboundRequests(miniflare: Awaited<ReturnType<typeof startMsgMiniflare>>["miniflare"], count: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let requests = await miniflare.inspectOutboundRequests();
  while (requests.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    requests = await miniflare.inspectOutboundRequests();
  }
  return requests;
}

async function waitForWebhookDeliveryStatus(
  miniflare: Awaited<ReturnType<typeof startMsgMiniflare>>["miniflare"],
  room: string,
  endpointId: string,
  status: string,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await miniflare.dispatchFetch(`https://msg.0000.chat/${room}/webhooks`, { headers: { accept: "application/json" } });
    const listing = await response.json() as { webhooks: Array<{ deliveries: Array<{ attempt_count: number; failure_category: string | null; status: string }>; id: string }> };
    const delivery = listing.webhooks.find(({ id }) => id === endpointId)?.deliveries[0];
    if (delivery?.status === status) return delivery;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`The webhook delivery did not reach ${status}.`);
}

async function verifyWebhookSignature(secret: string, timestamp: string, body: string, signature: string): Promise<boolean> {
  const encoded = secret.replaceAll("-", "+").replaceAll("_", "/");
  const padded = encoded + "=".repeat((4 - encoded.length % 4) % 4);
  const keyBytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const digest = signature.replace(/^v1=/u, "").match(/.{2}/gu)?.map((byte) => Number.parseInt(byte, 16));
  if (!digest) return false;
  return await crypto.subtle.verify("HMAC", key, new Uint8Array(digest), new TextEncoder().encode(`${timestamp}.${body}`));
}

test.serial("delivers one signed full-message webhook from a durable outbox after restart", { timeout: 15_000 }, async () => {
  const persistenceDirectory = await createMsgMiniflareTempDirectory("webhook-restart");
  const fakeNow = 4_000_000_000_000;
  let first: Awaited<ReturnType<typeof startMsgMiniflare>> | undefined;
  let second: Awaited<ReturnType<typeof startMsgMiniflare>> | undefined;
  let failed = false;
  let failure: unknown;
  try {
    first = await startMsgMiniflare(persistenceDirectory, TEST_ROOM_LIMITS, { nowMs: fakeNow });
    const { room } = await createRoom(first.miniflare, "before registration");
    const created = await first.miniflare.dispatchFetch(`https://msg.0000.chat/${room.id}/webhooks`, {
      body: JSON.stringify({ url: "https://receiver.example.com/hooks/msg" }),
      headers: jsonHeaders,
      method: "POST",
    });
    expect(created.status).toBe(201);
    const registration = await created.json() as { secret: string; webhook: { id: string } };
    expect(registration.secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const posted = await post(first.miniflare, room.id, "authored <message>\nverbatim", "webhook-idempotency-key");
    const postedValue = await posted.json() as { message: { created_at: string; id: string; sequence: number }; replayed: boolean };
    const replay = await post(first.miniflare, room.id, "authored <message>\nverbatim", "webhook-idempotency-key");
    expect(posted.status).toBe(201);
    expect(postedValue.replayed).toBe(false);
    expect((await replay.json() as { replayed: boolean }).replayed).toBe(true);
    expect(await first.miniflare.inspectOutboundRequests()).toEqual([]);

    await first.dispose();
    first = undefined;
    second = await startMsgMiniflare(persistenceDirectory, TEST_ROOM_LIMITS, { nowMs: fakeNow + 5_000 });
    await second.miniflare.triggerAlarm(room.id);
    const requests = await waitForOutboundRequests(second.miniflare, 1);
    expect(requests).toHaveLength(1);

    const outbound = requests[0]!;
    expect(outbound.url).toBe("https://receiver.example.com/hooks/msg");
    expect(outbound.method).toBe("POST");
    expect(outbound.headers["content-type"]).toContain("application/json");
    const timestamp = outbound.headers["x-msg-timestamp"];
    const signature = outbound.headers["x-msg-signature"];
    expect(timestamp).toMatch(/^[0-9]+$/u);
    expect(signature).toMatch(/^v1=[0-9a-f]{64}$/u);
    expect(await verifyWebhookSignature(registration.secret, timestamp!, outbound.body, signature!)).toBe(true);

    const event = JSON.parse(outbound.body) as {
      event_id: string;
      message: { content: string; created_at: string; id: string; sequence: number };
      protocol_version: number;
      room_id: string;
      type: string;
    };
    expect(event).toMatchObject({
      event_id: postedValue.message.id,
      message: { content: "authored <message>\nverbatim", created_at: postedValue.message.created_at, id: postedValue.message.id, sequence: 2 },
      protocol_version: 1,
      type: "message.created",
    });
    expect(event.room_id).toMatch(/^[0-9a-f-]{36}$/iu);
    expect(event.room_id).not.toBe(room.id);
    expect(outbound.body).not.toContain(room.id);
    expect(outbound.body).not.toContain(registration.secret);

    const listed = await second.miniflare.dispatchFetch(`https://msg.0000.chat/${room.id}/webhooks`, { headers: { accept: "application/json" } });
    expect(listed.status).toBe(200);
    const listing = await listed.json() as { webhooks: Array<{ deliveries: Array<{ attempt_count: number; status: string }>; id: string }> };
    expect(listing.webhooks).toHaveLength(1);
    expect(listing.webhooks[0]).toMatchObject({ id: registration.webhook.id, deliveries: [{ attempt_count: 1, status: "delivered" }] });
    expect(JSON.stringify(listing)).not.toContain(registration.secret);
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    try {
      await first?.dispose();
      await second?.dispose();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
    try {
      await rm(persistenceDirectory, { force: true, recursive: true });
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }
  if (failed) throw failure;
});

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


test.serial("creates five concurrent webhooks atomically and hides URL credentials in management responses", { timeout: 15_000 }, async () => {
  await withRuntime(async (miniflare) => {
    const { room } = await createRoom(miniflare);
    const destinations = Array.from({ length: 6 }, (_, index) => `https://user-${index}:pass-${index}@receiver.example.com/hooks/${index}?token=query-secret-${index}&audience=internal-${index}`);
    const results = await Promise.all(destinations.map(async (url, index) => {
      const response = await miniflare.dispatchFetch(`https://msg.0000.chat/${room.id}/webhooks`, {
        body: JSON.stringify({ url }),
        headers: jsonHeaders,
        method: "POST",
      });
      return { index, status: response.status, value: await response.json() as {
        error?: { code: string };
        secret?: string;
        webhook?: { id: string; url: string };
      } };
    }));

    expect(results.map(({ status }) => status).sort()).toEqual([201, 201, 201, 201, 201, 409]);
    const created = results.filter(({ status }) => status === 201);
    const secrets = created.map(({ value }) => value.secret);
    expect(new Set(secrets).size).toBe(5);
    for (const result of created) {
      expect(result.value.secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(result.value.webhook?.url).toBe(`https://redacted:redacted@receiver.example.com/hooks/${result.index}?token=redacted&audience=redacted`);
      const responseText = JSON.stringify(result.value);
      expect(responseText).not.toContain(`user-${result.index}`);
      expect(responseText).not.toContain(`pass-${result.index}`);
      expect(responseText).not.toContain(`query-secret-${result.index}`);
      expect(responseText).not.toContain(`internal-${result.index}`);
    }
    expect(results.find(({ status }) => status === 409)?.value).toMatchObject({ error: { code: "conflict" } });

    const listed = await miniflare.dispatchFetch(`https://msg.0000.chat/${room.id}/webhooks`, { headers: { accept: "application/json" } });
    expect(listed.status).toBe(200);
    const listing = await listed.json() as { webhooks: Array<{ id: string; url: string }> };
    expect(listing.webhooks).toHaveLength(5);
    const listingText = JSON.stringify(listing);
    for (const secret of secrets) expect(listingText).not.toContain(secret);
    for (let index = 0; index < destinations.length; index += 1) {
      expect(listingText).not.toContain(`user-${index}`);
      expect(listingText).not.toContain(`pass-${index}`);
      expect(listingText).not.toContain(`query-secret-${index}`);
      expect(listingText).not.toContain(`internal-${index}`);
    }
    expect(listing.webhooks.every(({ url }) => url.includes("token=redacted&audience=redacted"))).toBe(true);

    const removed = await miniflare.dispatchFetch(`https://msg.0000.chat/${room.id}/webhooks/${listing.webhooks[0]!.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ removed: true });
    const afterRemove = await miniflare.dispatchFetch(`https://msg.0000.chat/${room.id}/webhooks`, { headers: { accept: "application/json" } });
    expect((await afterRemove.json() as { webhooks: unknown[] }).webhooks).toHaveLength(4);

    const replacement = await registerWebhook(miniflare, room.id, "https://receiver.example.com/replacement");
    expect(replacement.secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const afterReplacement = await miniflare.dispatchFetch(`https://msg.0000.chat/${room.id}/webhooks`, { headers: { accept: "application/json" } });
    expect((await afterReplacement.json() as { webhooks: unknown[] }).webhooks).toHaveLength(5);
  });
});

test.serial("sends an unchanged 64 KiB control-heavy message beyond the former envelope limit", { timeout: 15_000 }, async () => {
  await withRuntime(async (miniflare) => {
    const { room } = await createRoom(miniflare);
    const registration = await registerWebhook(miniflare, room.id, "https://receiver.example.com/full-message");
    const content = "\u0000".repeat(64 * 1024);
    const response = await miniflare.dispatchFetch(`https://msg.0000.chat/${room.id}`, {
      body: content,
      headers: { accept: "application/json", "content-type": "text/plain" },
      method: "POST",
    });
    expect(response.status).toBe(201);
    const posted = await response.json() as { message: { content: string; id: string; sequence: number } };
    expect(posted.message.content).toHaveLength(64 * 1024);
    expect(posted.message.content).toBe(content);

    const requests = await waitForOutboundRequests(miniflare, 1, 5_000);
    expect(requests).toHaveLength(1);
    const outbound = requests[0]!;
    expect(outbound.body.length).toBeGreaterThan(72 * 1024);
    const timestamp = outbound.headers["x-msg-timestamp"];
    const signature = outbound.headers["x-msg-signature"];
    expect(await verifyWebhookSignature(registration.secret, timestamp!, outbound.body, signature!)).toBe(true);
    const event = JSON.parse(outbound.body) as { event_id: string; message: { content: string; id: string; sequence: number }; room_id: string };
    expect(event.event_id).toBe(posted.message.id);
    expect(event.message).toMatchObject({ content, id: posted.message.id, sequence: posted.message.sequence });
    expect(event.room_id).not.toBe(room.id);
    expect(outbound.body).not.toContain(room.id);
    expect(outbound.body).not.toContain(registration.secret);
  });
});

test.serial("cancels queued deliveries when an endpoint is removed or its room is deleted", { timeout: 15_000 }, async () => {
  const fakeNow = 4_000_000_000_000;
  const limits = { ...TEST_ROOM_LIMITS, tombstoneTtlMs: 10_000 };
  await withRestartedRuntime(async (first, restart) => {
    const endpointRoom = await createRoom(first);
    const registration = await registerWebhook(first, endpointRoom.room.id, "https://receiver.example.com/removed");
    expect((await post(first, endpointRoom.room.id, "cancel this delivery")).status).toBe(201);
    const removed = await first.dispatchFetch(`https://msg.0000.chat/${endpointRoom.room.id}/webhooks/${registration.webhook.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);

    const deletedRoom = await createRoom(first);
    await registerWebhook(first, deletedRoom.room.id, "https://receiver.example.com/deleted-room");
    expect((await post(first, deletedRoom.room.id, "cancel on deletion")).status).toBe(201);
    const deleted = await first.dispatchFetch(deletedRoom.manage_url, { headers: { accept: "application/json" }, method: "DELETE" });
    expect(deleted.status).toBe(200);

    const restarted = await restart(fakeNow + 5_000);
    await restarted.triggerAlarm(endpointRoom.room.id);
    expect(await restarted.inspectOutboundRequests()).toEqual([]);
    const listed = await restarted.dispatchFetch(`https://msg.0000.chat/${endpointRoom.room.id}/webhooks`, { headers: { accept: "application/json" } });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ webhooks: [] });

    await restarted.triggerAlarm(deletedRoom.room.id);
    expect(await restarted.inspectOutboundRequests()).toEqual([]);
    const gone = await restarted.dispatchFetch(`https://msg.0000.chat/${deletedRoom.room.id}/webhooks`, { headers: { accept: "application/json" } });
    expect(gone.status).toBe(410);
  }, limits, fakeNow);
});

test.serial("expires a room with pending webhook work without extending its message lifetime", { timeout: 15_000 }, async () => {
  const fakeNow = 4_000_000_000_000;
  const limits = { ...TEST_ROOM_LIMITS, inactivityTtlMs: 1_000 };
  await withRestartedRuntime(async (first, restart) => {
    const { room } = await createRoom(first);
    await registerWebhook(first, room.id, "https://receiver.example.com/expiring-room");
    expect((await post(first, room.id, "expires before delivery")).status).toBe(201);

    const restarted = await restart(fakeNow + limits.inactivityTtlMs);
    await restarted.triggerAlarm(room.id);
    expect(await restarted.inspectOutboundRequests()).toEqual([]);
    const gone = await restarted.dispatchFetch(`https://msg.0000.chat/${room.id}/webhooks`, { headers: { accept: "application/json" } });
    expect(gone.status).toBe(410);
  }, limits, fakeNow);
});

test.serial("accepts a message before an unavailable webhook receiver fails", { timeout: 15_000 }, async () => {
  await withRuntime(async (miniflare) => {
    await miniflare.setOutboundResponse(503);
    const { room } = await createRoom(miniflare);
    const registration = await registerWebhook(miniflare, room.id, "https://receiver.example.com/unavailable?token=private-query");
    const response = await post(miniflare, room.id, "accepted despite delivery failure");
    expect(response.status).toBe(201);
    const posted = await response.json() as { message: { id: string } };

    const requests = await waitForOutboundRequests(miniflare, 1);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ event_id: posted.message.id, message: { content: "accepted despite delivery failure" } });
    const delivery = await waitForWebhookDeliveryStatus(miniflare, room.id, registration.webhook.id, "failed");
    expect(delivery).toMatchObject({ attempt_count: 1, failure_category: "http_status", status: "failed" });

    const listed = await miniflare.dispatchFetch(`https://msg.0000.chat/${room.id}/webhooks`, { headers: { accept: "application/json" } });
    const listing = await listed.text();
    expect(listing).not.toContain("accepted despite delivery failure");
    expect(listing).not.toContain(registration.secret);
    expect(listing).not.toContain("private-query");
  });
});


test.serial("does not follow webhook redirects and cancels response bodies", { timeout: 15_000 }, async () => {
  await withRuntime(async (miniflare) => {
    await miniflare.setOutboundResponse(302, "https://redirected.example.com/other");
    const { room } = await createRoom(miniflare);
    const registration = await registerWebhook(miniflare, room.id, "https://receiver.example.com/original?token=private-query");
    expect((await post(miniflare, room.id, "redirected delivery")).status).toBe(201);

    const requests = await waitForOutboundRequests(miniflare, 1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://receiver.example.com/original?token=private-query");
    const delivery = await waitForWebhookDeliveryStatus(miniflare, room.id, registration.webhook.id, "failed");
    expect(delivery).toMatchObject({ attempt_count: 1, failure_category: "redirect", status: "failed" });
    const listed = await miniflare.dispatchFetch(`https://msg.0000.chat/${room.id}/webhooks`, { headers: { accept: "application/json" } });
    expect(await listed.text()).not.toContain("test-only response body");
  });
});

test.serial("times out a webhook fetch without changing the accepted message", { timeout: 15_000 }, async () => {
  await withRuntime(async (miniflare) => {
    await miniflare.setOutboundResponse(200, undefined, 5_500);
    const { room } = await createRoom(miniflare);
    const registration = await registerWebhook(miniflare, room.id, "https://receiver.example.com/slow");
    const posted = await post(miniflare, room.id, "message before timeout");
    expect(posted.status).toBe(201);

    expect(await waitForOutboundRequests(miniflare, 1)).toHaveLength(1);
    const delivery = await waitForWebhookDeliveryStatus(miniflare, room.id, registration.webhook.id, "failed", 7_000);
    expect(delivery).toMatchObject({ attempt_count: 1, failure_category: "timeout", status: "failed" });
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
});
