import { readdir, rm, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from "node:crypto";
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocketClient from "ws";

import { PUSH_DELIVERY_LEASE_MS, PUSH_INITIAL_DELAY_MS, PUSH_RETRY_INITIAL_DELAY_MS, PUSH_RETRY_WINDOW_MS } from "./push-policy";
import { createMsgMiniflareTempDirectory, SHORT_LIVED_TEST_ROOM_LIMITS, startMsgMiniflare, TEST_ROOM_LIMITS, TEST_VAPID_PUBLIC_KEY, TEST_VAPID_SUBJECT } from "../test-fixtures/msg-worker.miniflare-fixture";

const jsonHeaders = { accept: "application/json", "content-type": "application/json" };
const fixtureTemporaryDirectory = fileURLToPath(new URL("../.miniflare-tests/", import.meta.url));

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

async function nodeRuntimeConfigurationDirectories(): Promise<string[]> {
  return (await readdir(fixtureTemporaryDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("node-runtime-config-"))
    .map((entry) => entry.name)
    .sort();
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
  nowMs?: number,
  testMode = true,
) {
  // A Miniflare runtime owns the process-wide workerd test slot. The shared
  // default runtime must close before a test starts with different limits.
  await disposeSharedRuntime();
  const persistenceDirectory = await createMsgMiniflareTempDirectory("state");
  let fixture: Awaited<ReturnType<typeof startMsgMiniflare>> | undefined;
  let failed = false;
  let failure: unknown;
  try {
    fixture = await startMsgMiniflare(persistenceDirectory, limits, { ...(nowMs === undefined ? {} : { nowMs }), testMode });
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

async function post(miniflare: Awaited<ReturnType<typeof startMsgMiniflare>>["miniflare"], room: string, content: string, idempotencyKey?: string, browserId?: string) {
  return miniflare.dispatchFetch(`https://msg.0000.chat/${room}`, {
    body: JSON.stringify({ content, author: "beta", display_name: "Beta", semantic_type: "message" }),
    headers: { ...jsonHeaders, ...(idempotencyKey !== undefined ? { "idempotency-key": idempotencyKey } : {}), ...(browserId !== undefined ? { "x-msg-browser-id": browserId } : {}) },
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

interface TestWebhookDelivery {
  readonly attempt_count: number;
  readonly attempts: Array<{
    readonly attempt_number: number;
    readonly attempted_at: string;
    readonly completed_at: string | null;
    readonly failure_category: string | null;
    readonly status: string;
  }>;
  readonly attempted_at: string | null;
  readonly cancelled_at: string | null;
  readonly completed_at: string | null;
  readonly event_id: string;
  readonly failure_category: string | null;
  readonly next_attempt_at: string | null;
  readonly retry_expires_at: string;
  readonly status: string;
}

interface TestWebhookEndpoint {
  readonly deliveries: TestWebhookDelivery[];
  readonly disabled_at: string | null;
  readonly failure_started_at: string | null;
  readonly id: string;
  readonly last_failure_at: string | null;
  readonly last_success_at: string | null;
  readonly recovered_at: string | null;
  readonly status: string;
}

async function readWebhookList(
  miniflare: Awaited<ReturnType<typeof startMsgMiniflare>>["miniflare"],
  room: string,
) {
  const response = await miniflare.dispatchFetch(`https://msg.0000.chat/${room}/webhooks`, { headers: { accept: "application/json" } });
  expect(response.status).toBe(200);
  return await response.json() as { webhooks: TestWebhookEndpoint[] };
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

function decodeBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64"));
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decryptWebPushBody(body: Uint8Array, receiverPrivateKey: Uint8Array, authSecret: Uint8Array): Uint8Array {
  if (body.byteLength < 103 || body[20] !== 65) throw new Error("The encrypted push body has an invalid header.");
  if (Buffer.from(body).readUInt32BE(16) !== 4096) throw new Error("The encrypted push body has an unexpected record size.");
  const salt = Buffer.from(body.subarray(0, 16));
  const senderPublicKey = Buffer.from(body.subarray(21, 86));
  const ciphertextAndTag = Buffer.from(body.subarray(86));
  const receiver = createECDH("prime256v1");
  receiver.setPrivateKey(Buffer.from(receiverPrivateKey));
  const sharedSecret = receiver.computeSecret(senderPublicKey);
  const receiverPublicKey = derivePublicKey(receiverPrivateKey);
  const authPrk = hmacSha256(Buffer.from(authSecret), sharedSecret);
  const inputKeyMaterial = hkdfExpand(authPrk, Buffer.concat([Buffer.from("WebPush: info\0"), receiverPublicKey, senderPublicKey]), 32);
  const contentPrk = hmacSha256(salt, inputKeyMaterial);
  const key = hkdfExpand(contentPrk, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdfExpand(contentPrk, Buffer.from("Content-Encoding: nonce\0"), 12);
  const decipher = createDecipheriv("aes-128-gcm", key, nonce, { authTagLength: 16 });
  decipher.setAuthTag(ciphertextAndTag.subarray(ciphertextAndTag.byteLength - 16));
  const plaintext = Buffer.concat([
    decipher.update(ciphertextAndTag.subarray(0, ciphertextAndTag.byteLength - 16)),
    decipher.final(),
  ]);
  if (plaintext.at(-1) !== 0x02) throw new Error("The encrypted push body has an invalid padding delimiter.");
  return new Uint8Array(plaintext.subarray(0, plaintext.byteLength - 1));
}

function derivePublicKey(privateKey: Uint8Array): Buffer {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privateKey));
  return ecdh.getPublicKey(undefined, "uncompressed");
}

function hmacSha256(key: Uint8Array, data: Uint8Array): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Buffer {
  const output: Buffer[] = [];
  let previous = Buffer.alloc(0);
  let outputLength = 0;
  for (let counter = 1; outputLength < length; counter += 1) {
    previous = hmacSha256(prk, Buffer.concat([previous, Buffer.from(info), Buffer.from([counter])]));
    output.push(previous);
    outputLength += previous.byteLength;
  }
  return Buffer.concat(output).subarray(0, length);
}

function verifyVapidAuthorization(authorization: string, endpoint: string, nowSeconds: number): void {
  const matched = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/u.exec(authorization);
  expect(matched).not.toBeNull();
  const token = matched![1]!;
  const publicKeyParameter = matched![2]!;
  const [encodedHeader, encodedClaims, encodedSignature] = token.split(".");
  expect(encodedHeader).toBeDefined();
  expect(encodedClaims).toBeDefined();
  expect(encodedSignature).toBeDefined();
  const publicKey = decodeBase64Url(TEST_VAPID_PUBLIC_KEY);
  const x = encodeBase64Url(publicKey.subarray(1, 33));
  const y = encodeBase64Url(publicKey.subarray(33, 65));
  expect(publicKeyParameter).toBe(TEST_VAPID_PUBLIC_KEY);
  expect(JSON.parse(Buffer.from(decodeBase64Url(encodedHeader!)).toString("utf8"))).toEqual({ alg: "ES256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(decodeBase64Url(encodedClaims!)).toString("utf8")) as { aud: string; exp: number; sub: string };
  expect(claims.aud).toBe(new URL(endpoint).origin);
  expect(claims.sub).toBe(TEST_VAPID_SUBJECT);
  expect(claims.exp).toBeGreaterThanOrEqual(nowSeconds + 12 * 60 * 60 - 5);
  expect(claims.exp).toBeLessThanOrEqual(nowSeconds + 12 * 60 * 60);
  expect(verify(
    "sha256",
    Buffer.from(`${encodedHeader}.${encodedClaims}`),
    { key: createPublicKey({ key: { crv: "P-256", kty: "EC", x, y }, format: "jwk" }), dsaEncoding: "ieee-p1363" },
    Buffer.from(decodeBase64Url(encodedSignature!)),
  )).toBe(true);
}

const pushReceiver = {
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  endpoint: "https://push.example.net/push/subscription-token",
  p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  privateKey: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
} as const;

function nativePushSubscription(receiver: { readonly auth: string; readonly endpoint: string; readonly p256dh: string }) {
  return { expirationTime: null, endpoint: receiver.endpoint, keys: { auth: receiver.auth, p256dh: receiver.p256dh } };
}

async function enrollPush(
  miniflare: Awaited<ReturnType<typeof startMsgMiniflare>>["miniflare"],
  room: string,
  browserId: string,
  receiver: { readonly auth: string; readonly endpoint: string; readonly p256dh: string } = pushReceiver,
) {
  return await miniflare.dispatchFetch(`https://msg.0000.chat/${room}/push-subscriptions`, {
    body: JSON.stringify(nativePushSubscription(receiver)),
    headers: { ...jsonHeaders, "x-msg-browser-id": browserId },
    method: "POST",
  });
}

async function readPushStatus(
  miniflare: Awaited<ReturnType<typeof startMsgMiniflare>>["miniflare"],
  room: string,
  browserId: string,
) {
  return await miniflare.dispatchFetch(`https://msg.0000.chat/${room}/push-subscriptions`, {
    headers: { accept: "application/json", "x-msg-browser-id": browserId },
  });
}

test.serial("uses a private startup file and cleans it after Node runtime success or failure", { timeout: 20_000 }, async () => {
  await disposeSharedRuntime();
  const persistenceDirectory = await createMsgMiniflareTempDirectory("startup-handoff-state");
  const before = await nodeRuntimeConfigurationDirectories();
  let fixture: Awaited<ReturnType<typeof startMsgMiniflare>> | undefined;
  try {
    fixture = await startMsgMiniflare(persistenceDirectory);
    expect(await nodeRuntimeConfigurationDirectories()).toEqual(before);
  } finally {
    try {
      await fixture?.dispose();
    } finally {
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  }

  const failureDirectory = await createMsgMiniflareTempDirectory("startup-handoff-failure");
  const invalidPersistenceDirectory = join(failureDirectory, "persistence-is-a-file");
  await writeFile(invalidPersistenceDirectory, "not a directory");
  let startupFailure: unknown;
  let unexpectedFixture: Awaited<ReturnType<typeof startMsgMiniflare>> | undefined;
  try {
    try {
      unexpectedFixture = await startMsgMiniflare(invalidPersistenceDirectory);
    } catch (error) {
      startupFailure = error;
    }
    await unexpectedFixture?.dispose();
    expect(startupFailure).toBeInstanceOf(Error);
    expect(await nodeRuntimeConfigurationDirectories()).toEqual(before);
  } finally {
    await rm(failureDirectory, { force: true, recursive: true });
  }
});

test.serial("push send barriers stay unavailable outside test mode and public Worker routes", { timeout: 15_000 }, async () => {
  await withRuntime(async (miniflare) => {
    let error: unknown;
    try { await miniflare.armPushSendGate("uninitialized-room"); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("HTTP 404");

    const response = await miniflare.dispatchFetch("https://msg.0000.chat/uninitialized-room/__test/push-send-gate", {
      body: JSON.stringify({ action: "arm" }),
      headers: jsonHeaders,
      method: "POST",
    });
    expect(response.status).toBe(404);
  }, TEST_ROOM_LIMITS, undefined, false);
});

test.serial("delivers an encrypted, VAPID-signed generic push through Worker HTTP and the SQLite alarm queue", { timeout: 15_000 }, async () => {
  const fakeNow = 4_000_000_000_000;
  await withRestartedRuntime(async (initial, restart) => {
    const { room } = await createRoom(initial, "before push enrollment");
    const browserId = crypto.randomUUID();
    const enrollment = await initial.dispatchFetch(`https://msg.0000.chat/${room.id}/push-subscriptions`, {
      body: JSON.stringify({ expirationTime: null, endpoint: pushReceiver.endpoint, keys: { auth: pushReceiver.auth, p256dh: pushReceiver.p256dh } }),
      headers: { ...jsonHeaders, "x-msg-browser-id": browserId },
      method: "POST",
    });
    expect(enrollment.status).toBe(201);
    expect(await enrollment.json()).toMatchObject({ enrolled: true });

    const status = await initial.dispatchFetch(`https://msg.0000.chat/${room.id}/push-subscriptions`, {
      headers: { accept: "application/json", "x-msg-browser-id": browserId },
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ enrolled: true, protocol_version: 1 });

    // This transport tracer exercises an ordinary API post. Browser-local
    // self-post suppression has its own case below.
    const posted = await post(initial, room.id, "private message preview must stay encrypted", "push-message-key");
    expect(posted.status).toBe(201);
    const message = await posted.json() as { message: { id: string; sequence: number }; replayed: boolean };
    expect(message.replayed).toBe(false);

    const miniflare = await restart(fakeNow + 500);
    await miniflare.triggerAlarm(room.id);
    const requests = await waitForOutboundRequests(miniflare, 1, 5_000);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe(pushReceiver.endpoint);
    expect(request.method).toBe("POST");
    expect(request.headers["content-encoding"]).toBe("aes128gcm");
    expect(request.headers["content-type"]).toBe("application/octet-stream");
    expect(Number(request.headers.ttl)).toBeGreaterThanOrEqual(86_399);
    expect(Number(request.headers.ttl)).toBeLessThanOrEqual(86_400);
    verifyVapidAuthorization(request.headers.authorization!, pushReceiver.endpoint, Math.floor(fakeNow / 1_000));

    const decrypted = decryptWebPushBody(
      new Uint8Array(Buffer.from(request.body_base64, "base64")),
      decodeBase64Url(pushReceiver.privateKey),
      decodeBase64Url(pushReceiver.auth),
    );
    const payload = JSON.parse(Buffer.from(decrypted).toString("utf8")) as Record<string, unknown>;
    expect(payload).toEqual({
      room_id: expect.stringMatching(/^[0-9a-f-]{36}$/iu),
      room_url: `https://msg.0000.chat/${room.id}`,
      type: "message.created",
    });
    expect(request.headers.topic).toBe((payload.room_id as string).replaceAll("-", ""));
    expect(request.headers.topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/u);
    expect(request.headers.topic).not.toContain(room.id);
    expect(payload).not.toHaveProperty("content");
    expect(payload).not.toHaveProperty("message");
    expect(payload).not.toHaveProperty("browser_id");
    expect(JSON.stringify(payload)).not.toContain("private message preview");
    expect(request.body).not.toContain("private message preview");
    expect(message.message.sequence).toBe(2);

    const replay = await post(miniflare, room.id, "private message preview must stay encrypted", "push-message-key");
    expect(replay.status).toBe(201);
    expect((await replay.json() as { replayed: boolean }).replayed).toBe(true);
    expect(await waitForOutboundRequests(miniflare, 1)).toHaveLength(1);
  }, TEST_ROOM_LIMITS, fakeNow);
});

test.serial("suppresses only the source browser while keeping another browser's pending alert", { timeout: 20_000 }, async () => {
  const fakeNow = 4_000_000_000_000;
  const browserA = crypto.randomUUID();
  const browserB = crypto.randomUUID();
  const receiverB = { ...pushReceiver, endpoint: "https://push.example.net/push/subscription-token-browser-b" };

  await withRestartedRuntime(async (initial, restart) => {
    const { room } = await createRoom(initial, "before browser push enrollment");
    expect((await enrollPush(initial, room.id, browserA)).status).toBe(201);
    expect((await enrollPush(initial, room.id, browserB, receiverB)).status).toBe(201);
    await registerWebhook(initial, room.id, "https://receiver.example.com/push-suppression");

    const earlier = await post(initial, room.id, "earlier message from browser B", "browser-b-message", browserB);
    expect(earlier.status).toBe(201);
    const replay = await post(initial, room.id, "earlier message from browser B", "browser-b-message", browserA);
    expect(replay.status).toBe(201);
    expect((await replay.json() as { replayed: boolean }).replayed).toBe(true);

    let miniflare = await restart(fakeNow + 60_000);
    const ownPost = await post(miniflare, room.id, "new message from browser A", "browser-a-message", browserA);
    expect(ownPost.status).toBe(201);
    expect((await ownPost.json() as { replayed: boolean }).replayed).toBe(false);

    miniflare = await restart(fakeNow + 60_500);
    await miniflare.triggerAlarm(room.id);
    const outbound = await miniflare.inspectOutboundRequests();
    const pushRequests = outbound.filter(({ url }) => url.startsWith("https://push.example.net/"));
    const webhookRequests = outbound.filter(({ url }) => url === "https://receiver.example.com/push-suppression");
    expect(pushRequests).toHaveLength(2);
    expect(new Set(pushRequests.map(({ url }) => url))).toEqual(new Set([pushReceiver.endpoint, receiverB.endpoint]));
    expect(webhookRequests).toHaveLength(2);

    const pushForA = pushRequests.find(({ url }) => url === pushReceiver.endpoint)!;
    const pushForB = pushRequests.find(({ url }) => url === receiverB.endpoint)!;
    expect(Number(pushForA.headers.ttl)).toBe(86_339);
    expect(Number(pushForB.headers.ttl)).toBe(86_399);
    const payloads = [pushForA, pushForB].map((request) => JSON.parse(Buffer.from(decryptWebPushBody(
      new Uint8Array(Buffer.from(request.body_base64, "base64")),
      decodeBase64Url(pushReceiver.privateKey),
      decodeBase64Url(pushReceiver.auth),
    )).toString("utf8")) as Record<string, unknown>);
    expect(payloads[0]).toEqual({ room_id: expect.stringMatching(/^[0-9a-f-]{36}$/iu), room_url: `https://msg.0000.chat/${room.id}`, type: "message.created" });
    expect(payloads[1]).toEqual(payloads[0]);
    expect(pushForA.headers.topic).toBe(pushForB.headers.topic);
    expect(pushForA.headers.topic).toBe((payloads[0]!.room_id as string).replaceAll("-", ""));
    expect(pushForA.headers.topic).not.toContain(room.id);
    expect(pushForA.headers.topic).not.toContain(browserA);
    expect(pushForA.headers.topic).not.toContain(browserB);

    const events = webhookRequests.map(({ body }) => JSON.parse(body) as { message: { content: string }; source_browser_id?: string });
    expect(events.map(({ message }) => message.content).sort()).toEqual([
      "earlier message from browser B",
      "new message from browser A",
    ]);
    expect(events.every((event) => !Object.hasOwn(event, "source_browser_id"))).toBe(true);

    miniflare = await restart(fakeNow + 60_500);
    const anonymous = await post(miniflare, room.id, "anonymous API message");
    expect(anonymous.status).toBe(201);
    miniflare = await restart(fakeNow + 61_000);
    await miniflare.triggerAlarm(room.id);
    const anonymousOutbound = await miniflare.inspectOutboundRequests();
    const anonymousPushes = anonymousOutbound.filter(({ url }) => url.startsWith("https://push.example.net/"));
    const anonymousWebhooks = anonymousOutbound.filter(({ url }) => url === "https://receiver.example.com/push-suppression");
    expect(anonymousPushes.map(({ url }) => url).sort()).toEqual([pushReceiver.endpoint, receiverB.endpoint].sort());
    expect(anonymousWebhooks).toHaveLength(1);
    expect(JSON.parse(anonymousWebhooks[0]!.body)).toMatchObject({ message: { content: "anonymous API message" } });
  }, TEST_ROOM_LIMITS, fakeNow);
});

test.serial("collapses unsent room alerts separately for each enrolled browser", { timeout: 15_000 }, async () => {
  const fakeNow = 4_000_000_000_000;
  const browserA = crypto.randomUUID();
  const browserB = crypto.randomUUID();
  const receiverB = { ...pushReceiver, endpoint: "https://push.example.net/push/subscription-token-collapse-b" };

  await withRestartedRuntime(async (initial, restart) => {
    const { room } = await createRoom(initial, "before browser push enrollment");
    expect((await enrollPush(initial, room.id, browserA)).status).toBe(201);
    expect((await enrollPush(initial, room.id, browserB, receiverB)).status).toBe(201);
    expect((await post(initial, room.id, "first pending room message")).status).toBe(201);
    expect((await post(initial, room.id, "latest pending room message")).status).toBe(201);

    const miniflare = await restart(fakeNow + 500);
    await miniflare.triggerAlarm(room.id);
    const pushRequests = (await miniflare.inspectOutboundRequests()).filter(({ url }) => url.startsWith("https://push.example.net/"));
    expect(pushRequests).toHaveLength(2);
    expect(pushRequests.map(({ url }) => url).sort()).toEqual([pushReceiver.endpoint, receiverB.endpoint].sort());
  }, TEST_ROOM_LIMITS, fakeNow);
});

test.serial("gives a replacement room alert its own 24-hour delivery deadline", { timeout: 20_000 }, async () => {
  const fakeNow = 4_000_000_000_000;
  const browserId = crypto.randomUUID();

  await withRestartedRuntime(async (initial, restart) => {
    const expiredRoom = await createRoom(initial, "room whose only alert expires");
    const replacedRoom = await createRoom(initial, "room whose alert will be replaced");
    expect((await enrollPush(initial, expiredRoom.room.id, browserId)).status).toBe(201);
    expect((await enrollPush(initial, replacedRoom.room.id, browserId)).status).toBe(201);
    expect((await post(initial, expiredRoom.room.id, "old event without a replacement")).status).toBe(201);
    expect((await post(initial, replacedRoom.room.id, "old event that will be replaced")).status).toBe(201);

    let miniflare = await restart(fakeNow + 12 * 60 * 60 * 1_000);
    expect((await post(miniflare, replacedRoom.room.id, "replacement message with a fresh event lifetime")).status).toBe(201);

    miniflare = await restart(fakeNow + 24 * 60 * 60 * 1_000 + 5 * 60 * 1_000);
    await miniflare.triggerAlarm(expiredRoom.room.id);
    await miniflare.triggerAlarm(replacedRoom.room.id);
    const pushRequests = (await miniflare.inspectOutboundRequests()).filter(({ url }) => url.startsWith("https://push.example.net/"));
    expect(pushRequests).toHaveLength(1);
    expect(pushRequests[0]!.url).toBe(pushReceiver.endpoint);
    expect(pushRequests[0]!.headers.ttl).toBe("42900");
    const payload = JSON.parse(Buffer.from(decryptWebPushBody(
      new Uint8Array(Buffer.from(pushRequests[0]!.body_base64, "base64")),
      decodeBase64Url(pushReceiver.privateKey),
      decodeBase64Url(pushReceiver.auth),
    )).toString("utf8")) as Record<string, unknown>;
    expect(payload).toEqual({
      room_id: expect.stringMatching(/^[0-9a-f-]{36}$/iu),
      room_url: `https://msg.0000.chat/${replacedRoom.room.id}`,
      type: "message.created",
    });
    expect(JSON.stringify(payload)).not.toContain("replacement message with a fresh event lifetime");
  }, TEST_ROOM_LIMITS, fakeNow);
});

test.serial("uses send-time TTL after encryption and skips work that expires before send", { timeout: 20_000 }, async () => {
  const fakeNow = 4_000_000_000_000;

  await withRestartedRuntime(async (initial, restart) => {
    const firstRoom = await createRoom(initial, "before push enrollment");
    const expiringRoom = await createRoom(initial, "before push enrollment");
    expect((await enrollPush(initial, firstRoom.room.id, crypto.randomUUID())).status).toBe(201);
    expect((await enrollPush(initial, expiringRoom.room.id, crypto.randomUUID())).status).toBe(201);
    const firstPost = await post(initial, firstRoom.room.id, "fresh TTL after encryption");
    const firstMessage = await firstPost.json() as { message: { created_at: string } };
    const firstDeadline = Date.parse(firstMessage.message.created_at) + PUSH_RETRY_WINDOW_MS;
    const expiringPost = await post(initial, expiringRoom.room.id, "expires during preparation");
    const expiringMessage = await expiringPost.json() as { message: { created_at: string } };
    const expiringDeadline = Date.parse(expiringMessage.message.created_at) + PUSH_RETRY_WINDOW_MS;

    const runtime = await restart(fakeNow + PUSH_INITIAL_DELAY_MS);
    await runtime.armPushSendGate(firstRoom.room.id);
    const firstAlarm = runtime.triggerAlarm(firstRoom.room.id);
    try {
      await runtime.waitForPushSendGate(firstRoom.room.id);
      const sendAt = fakeNow + PUSH_INITIAL_DELAY_MS + 2_000;
      await runtime.advancePushSendClock(firstRoom.room.id, sendAt);
    } finally {
      await runtime.releasePushSendGate(firstRoom.room.id);
      await firstAlarm;
    }

    const firstRequests = await runtime.inspectOutboundRequests();
    expect(firstRequests).toHaveLength(1);
    expect(firstRequests[0]!.headers.ttl).toBe(String(Math.floor((firstDeadline - (fakeNow + PUSH_INITIAL_DELAY_MS + 2_000)) / 1_000)));
    expect(firstRequests[0]!.headers.ttl).toBe("86397");

    await runtime.clearOutboundRequests();
    await runtime.armPushSendGate(expiringRoom.room.id);
    const expiringAlarm = runtime.triggerAlarm(expiringRoom.room.id);
    try {
      await runtime.waitForPushSendGate(expiringRoom.room.id);
      await runtime.advancePushSendClock(expiringRoom.room.id, expiringDeadline + 1);
    } finally {
      await runtime.releasePushSendGate(expiringRoom.room.id);
      await expiringAlarm;
    }
    expect(await runtime.inspectOutboundRequests()).toEqual([]);
  }, TEST_ROOM_LIMITS, fakeNow);
});

test.serial("does not retry an in-flight push after a newer eligible delivery replaces it", { timeout: 20_000 }, async () => {
  const fakeNow = 4_000_000_000_000;
  const subscribedBrowser = crypto.randomUUID();
  const otherBrowser = crypto.randomUUID();

  await withRestartedRuntime(async (initial, restart) => {
    const { room } = await createRoom(initial, "before push enrollment");
    expect((await enrollPush(initial, room.id, subscribedBrowser)).status).toBe(201);
    expect((await post(initial, room.id, "older push that will be in flight", undefined, otherBrowser)).status).toBe(201);

    let runtime = await restart(fakeNow + PUSH_INITIAL_DELAY_MS);
    await runtime.setOutboundResponse(503, undefined, 1_500);
    const oldAttempt = runtime.triggerAlarm(room.id);
    let newerCreatedAt: number | undefined;
    try {
      const firstAttempt = await waitForOutboundRequests(runtime, 1, 5_000);
      expect(firstAttempt).toHaveLength(1);
      const newerPost = await post(runtime, room.id, "newer push after the older request started", undefined, otherBrowser);
      expect(newerPost.status).toBe(201);
      const newerMessage = await newerPost.json() as { message: { created_at: string } };
      newerCreatedAt = Date.parse(newerMessage.message.created_at);
    } finally {
      await oldAttempt;
    }

    expect(await runtime.inspectOutboundRequests()).toHaveLength(1);
    runtime = await restart(fakeNow + PUSH_INITIAL_DELAY_MS + PUSH_RETRY_INITIAL_DELAY_MS);
    await runtime.setOutboundResponse(204);
    await runtime.triggerAlarm(room.id);
    const retryWindowRequests = await runtime.inspectOutboundRequests();
    expect(retryWindowRequests).toHaveLength(1);
    expect(retryWindowRequests[0]!.headers.ttl).toBe(String(Math.floor((newerCreatedAt! + PUSH_RETRY_WINDOW_MS - (fakeNow + PUSH_INITIAL_DELAY_MS + PUSH_RETRY_INITIAL_DELAY_MS)) / 1_000)));
  }, TEST_ROOM_LIMITS, fakeNow);
});

test.serial("provider-held alerts replace by room Topic but remain separate across rooms", { timeout: 20_000 }, async () => {
  await withRuntime(async (miniflare) => {
    const firstRoom = await createRoom(miniflare, "first provider-held room");
    const secondRoom = await createRoom(miniflare, "second provider-held room");
    const browserId = crypto.randomUUID();
    expect((await enrollPush(miniflare, firstRoom.room.id, browserId)).status).toBe(201);
    expect((await enrollPush(miniflare, secondRoom.room.id, browserId)).status).toBe(201);
    await miniflare.setOutboundResponse(201);

    const send = async (room: string, content: string, expectedCount: number) => {
      const posted = await post(miniflare, room, content);
      expect(posted.status).toBe(201);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await miniflare.triggerAlarm(room);
      const requests = await waitForOutboundRequests(miniflare, expectedCount, 5_000);
      return requests[expectedCount - 1]!;
    };

    const firstRoomFirst = await send(firstRoom.room.id, "first offline push for room one", 1);
    const pendingAfterFirst = await miniflare.inspectPendingPushes();
    expect(pendingAfterFirst).toHaveLength(1);
    expect(pendingAfterFirst[0]!.body_base64).toBe(firstRoomFirst.body_base64);

    const firstRoomSecond = await send(firstRoom.room.id, "replacement offline push for room one", 2);
    const pendingAfterReplacement = await miniflare.inspectPendingPushes();
    expect(pendingAfterReplacement).toHaveLength(1);
    expect(pendingAfterReplacement[0]!.headers.topic).toBe(firstRoomFirst.headers.topic);
    expect(pendingAfterReplacement[0]!.body_base64).toBe(firstRoomSecond.body_base64);
    expect(pendingAfterReplacement[0]!.body_base64).not.toBe(firstRoomFirst.body_base64);

    const secondRoomFirst = await send(secondRoom.room.id, "first offline push for room two", 3);
    const pendingWithBothRooms = await miniflare.inspectPendingPushes();
    expect(pendingWithBothRooms).toHaveLength(2);
    expect(secondRoomFirst.url).toBe(pushReceiver.endpoint);
    expect(firstRoomFirst.url).toBe(pushReceiver.endpoint);
    expect(secondRoomFirst.headers.topic).not.toBe(firstRoomFirst.headers.topic);

    const secondRoomSecond = await send(secondRoom.room.id, "replacement offline push for room two", 4);
    const finalPending = await miniflare.inspectPendingPushes();
    expect(finalPending).toHaveLength(2);
    const pendingByTopic = new Map(finalPending.map((request) => [request.headers.topic ?? "", request]));
    expect(pendingByTopic.get(firstRoomFirst.headers.topic!)?.body_base64).toBe(firstRoomSecond.body_base64);
    expect(pendingByTopic.get(secondRoomFirst.headers.topic!)?.body_base64).toBe(secondRoomSecond.body_base64);

    for (const request of [firstRoomFirst, firstRoomSecond, secondRoomFirst, secondRoomSecond]) {
      expect(request.headers.topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/u);
      expect(request.headers).not.toHaveProperty("x-msg-browser-id");
      expect(request.headers.topic).not.toContain(firstRoom.room.id);
      expect(request.headers.topic).not.toContain(secondRoom.room.id);
    }
    const firstRoomPayload = JSON.parse(Buffer.from(decryptWebPushBody(
      new Uint8Array(Buffer.from(firstRoomFirst.body_base64, "base64")),
      decodeBase64Url(pushReceiver.privateKey),
      decodeBase64Url(pushReceiver.auth),
    )).toString("utf8")) as Record<string, unknown>;
    const secondRoomPayload = JSON.parse(Buffer.from(decryptWebPushBody(
      new Uint8Array(Buffer.from(secondRoomFirst.body_base64, "base64")),
      decodeBase64Url(pushReceiver.privateKey),
      decodeBase64Url(pushReceiver.auth),
    )).toString("utf8")) as Record<string, unknown>;
    expect(firstRoomFirst.headers.topic).toBe((firstRoomPayload.room_id as string).replaceAll("-", ""));
    expect(firstRoomPayload.room_url).toBe(`https://msg.0000.chat/${firstRoom.room.id}`);
    expect(secondRoomFirst.headers.topic).toBe((secondRoomPayload.room_id as string).replaceAll("-", ""));
    expect(secondRoomPayload.room_url).toBe(`https://msg.0000.chat/${secondRoom.room.id}`);
  });
});

test.serial("removes one room enrollment while preserving the same browser subscription in another room", { timeout: 15_000 }, async () => {
  const fakeNow = 4_000_000_000_000;
  await withRuntime(async (miniflare) => {
    const firstRoom = await createRoom(miniflare, "first room before enrollment");
    const secondRoom = await createRoom(miniflare, "second room before enrollment");
    const browserId = crypto.randomUUID();

    expect((await enrollPush(miniflare, firstRoom.room.id, browserId)).status).toBe(201);
    expect((await enrollPush(miniflare, secondRoom.room.id, browserId)).status).toBe(201);
    expect(await (await readPushStatus(miniflare, firstRoom.room.id, browserId)).json()).toEqual({ enrolled: true, protocol_version: 1 });
    expect(await (await readPushStatus(miniflare, secondRoom.room.id, browserId)).json()).toEqual({ enrolled: true, protocol_version: 1 });

    const removed = await miniflare.dispatchFetch(`https://msg.0000.chat/${firstRoom.room.id}/push-subscriptions`, {
      headers: { accept: "application/json", "x-msg-browser-id": browserId }, method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ protocol_version: 1, removed: true });
    expect(await (await readPushStatus(miniflare, firstRoom.room.id, browserId)).json()).toEqual({ enrolled: false, protocol_version: 1 });
    expect(await (await readPushStatus(miniflare, secondRoom.room.id, browserId)).json()).toEqual({ enrolled: true, protocol_version: 1 });

    await miniflare.triggerAlarm(firstRoom.room.id);
    await miniflare.triggerAlarm(secondRoom.room.id);
    expect(await miniflare.inspectOutboundRequests()).toEqual([]);
  }, TEST_ROOM_LIMITS, fakeNow);
});

test.serial("unsubscribing or deleting a room during push encryption prevents the provider fetch", { timeout: 25_000 }, async () => {
  const fakeNow = 4_000_000_000_000;
  await withRestartedRuntime(async (initial, restart) => {
    let miniflare = initial;
    const browserId = crypto.randomUUID();
    const subscribedRoom = await createRoom(initial, "before push enrollment");
    expect((await enrollPush(initial, subscribedRoom.room.id, browserId)).status).toBe(201);
    expect((await post(initial, subscribedRoom.room.id, "pending before room unsubscribe")).status).toBe(201);

    miniflare = await restart(fakeNow + 500);
    await miniflare.armPushSendGate(subscribedRoom.room.id);
    const unsubscribeAlarm = miniflare.triggerAlarm(subscribedRoom.room.id);
    try {
      await miniflare.waitForPushSendGate(subscribedRoom.room.id);
      const removed = await miniflare.dispatchFetch(`https://msg.0000.chat/${subscribedRoom.room.id}/push-subscriptions`, {
        headers: { accept: "application/json", "x-msg-browser-id": browserId },
        method: "DELETE",
      });
      expect(removed.status).toBe(200);
      expect(await removed.json()).toEqual({ protocol_version: 1, removed: true });
    } finally {
      await miniflare.releasePushSendGate(subscribedRoom.room.id);
      await unsubscribeAlarm;
    }
    expect(await miniflare.inspectOutboundRequests()).toEqual([]);
    expect(await (await readPushStatus(miniflare, subscribedRoom.room.id, browserId)).json()).toEqual({ enrolled: false, protocol_version: 1 });

    const deletedRoom = await createRoom(miniflare, "before room deletion");
    const deletedBrowserId = crypto.randomUUID();
    expect((await enrollPush(miniflare, deletedRoom.room.id, deletedBrowserId)).status).toBe(201);
    expect((await post(miniflare, deletedRoom.room.id, "pending before room deletion")).status).toBe(201);

    miniflare = await restart(fakeNow + 751);
    await miniflare.armPushSendGate(deletedRoom.room.id);
    const deleteAlarm = miniflare.triggerAlarm(deletedRoom.room.id);
    try {
      await miniflare.waitForPushSendGate(deletedRoom.room.id);
      const deleted = await miniflare.dispatchFetch(deletedRoom.manage_url, { headers: { accept: "application/json" }, method: "DELETE" });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toMatchObject({ deleted: true });
    } finally {
      await miniflare.releasePushSendGate(deletedRoom.room.id);
      await deleteAlarm;
    }
    expect(await miniflare.inspectOutboundRequests()).toEqual([]);
    expect((await readPushStatus(miniflare, deletedRoom.room.id, deletedBrowserId)).status).toBe(410);
  }, TEST_ROOM_LIMITS, fakeNow);
});

test.serial("cleans up a provider-rejected push subscription without creating another delivery", { timeout: 15_000 }, async () => {
  const fakeNow = 4_000_000_000_000;
  await withRestartedRuntime(async (initial, restart) => {
    const { room } = await createRoom(initial, "before push enrollment");
    const browserId = crypto.randomUUID();
    expect((await enrollPush(initial, room.id, browserId)).status).toBe(201);
    expect((await post(initial, room.id, "future message for an invalid endpoint")).status).toBe(201);

    const miniflare = await restart(fakeNow + 500);
    await miniflare.setOutboundResponse(410);
    await miniflare.triggerAlarm(room.id);
    const requests = await waitForOutboundRequests(miniflare, 1);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(pushReceiver.endpoint);
    expect(await (await readPushStatus(miniflare, room.id, browserId)).json()).toEqual({ enrolled: false, protocol_version: 1 });
  }, TEST_ROOM_LIMITS, fakeNow);
});

test.serial("retries offline push independently and stops at the original 24-hour deadline", { timeout: 20_000 }, async () => {
  const fakeNow = 4_000_000_000_000;
  await withRestartedRuntime(async (initial, restart) => {
    const { room } = await createRoom(initial, "before push enrollment");
    const browserId = crypto.randomUUID();
    expect((await enrollPush(initial, room.id, browserId)).status).toBe(201);
    expect((await post(initial, room.id, "future message for an offline device")).status).toBe(201);

    let miniflare = await restart(fakeNow + 500);
    await miniflare.setOutboundResponse(503);
    await miniflare.triggerAlarm(room.id);
    const firstAttempt = await waitForOutboundRequests(miniflare, 1);
    expect(firstAttempt).toHaveLength(1);
    expect(firstAttempt[0]!.headers.ttl).toBeDefined();

    await registerWebhook(miniflare, room.id, "https://receiver.example.com/after-push-outage");
    const webhookList = await readWebhookList(miniflare, room.id);
    expect(webhookList.webhooks[0]).toMatchObject({ failure_started_at: null, last_failure_at: null, last_success_at: null });
    expect(webhookList.webhooks[0]!.deliveries).toEqual([]);

    miniflare = await restart(fakeNow + 30_501);
    await miniflare.setOutboundResponse(204);
    await miniflare.triggerAlarm(room.id);
    const retry = await waitForOutboundRequests(miniflare, 1);
    expect(retry).toHaveLength(1);
    expect(Number(retry[0]!.headers.ttl)).toBeLessThan(86_400);
    expect(Number(retry[0]!.headers.ttl)).toBeGreaterThan(86_000);

    miniflare = await restart(fakeNow + 86_400_000);
    await miniflare.triggerAlarm(room.id);
    expect(await miniflare.inspectOutboundRequests()).toEqual([]);
    expect(await (await readPushStatus(miniflare, room.id, browserId)).json()).toEqual({ enrolled: true, protocol_version: 1 });
  }, TEST_ROOM_LIMITS, fakeNow);
});

test.serial("an old 410 cannot remove a same-endpoint enrollment whose keys changed in flight", { timeout: 25_000 }, async () => {
  const fakeNow = 4_000_000_000_000;
  const replacementPrivateKey = new Uint8Array(Buffer.alloc(32, 1));
  const replacementReceiver = {
    auth: encodeBase64Url(new Uint8Array(Buffer.alloc(16, 0x36))),
    endpoint: pushReceiver.endpoint,
    p256dh: encodeBase64Url(derivePublicKey(replacementPrivateKey)),
    privateKey: encodeBase64Url(replacementPrivateKey),
  };
  await withRestartedRuntime(async (initial, restart) => {
    const { room } = await createRoom(initial, "before push enrollment");
    const browserId = crypto.randomUUID();
    expect((await enrollPush(initial, room.id, browserId)).status).toBe(201);
    expect((await post(initial, room.id, "future message for a replaced key")).status).toBe(201);

    let miniflare = await restart(fakeNow + 500);
    await miniflare.setOutboundResponse(410, undefined, 500);
    const inFlight = miniflare.triggerAlarm(room.id);
    const oldRequest = await waitForOutboundRequests(miniflare, 1);
    expect(oldRequest).toHaveLength(1);

    const replacement = await enrollPush(miniflare, room.id, browserId, replacementReceiver);
    expect(replacement.status).toBe(201);
    await inFlight;
    expect(await (await readPushStatus(miniflare, room.id, browserId)).json()).toEqual({ enrolled: true, protocol_version: 1 });

    await miniflare.clearOutboundRequests();
    expect((await post(miniflare, room.id, "the next message after replacing keys")).status).toBe(201);
    miniflare = await restart(fakeNow + 751);
    await miniflare.setOutboundResponse(204);
    await miniflare.triggerAlarm(room.id);
    const nextMessage = await waitForOutboundRequests(miniflare, 1);
    expect(nextMessage).toHaveLength(1);
    const payload = JSON.parse(Buffer.from(decryptWebPushBody(
      new Uint8Array(Buffer.from(nextMessage[0]!.body_base64, "base64")),
      decodeBase64Url(replacementReceiver.privateKey),
      decodeBase64Url(replacementReceiver.auth),
    )).toString("utf8")) as Record<string, unknown>;
    expect(payload).toEqual({
      room_id: expect.stringMatching(/^[0-9a-f-]{36}$/iu),
      room_url: `https://msg.0000.chat/${room.id}`,
      type: "message.created",
    });
    expect(await (await readPushStatus(miniflare, room.id, browserId)).json()).toEqual({ enrolled: true, protocol_version: 1 });

    miniflare = await restart(fakeNow + 10_501);
    await miniflare.triggerAlarm(room.id);
    expect(await miniflare.inspectOutboundRequests()).toEqual([]);
    miniflare = await restart(fakeNow + 40_502);
    await miniflare.triggerAlarm(room.id);
    expect(await miniflare.inspectOutboundRequests()).toEqual([]);
    expect(await (await readPushStatus(miniflare, room.id, browserId)).json()).toEqual({ enrolled: true, protocol_version: 1 });
  }, TEST_ROOM_LIMITS, fakeNow);
});

test.serial("recovers an unsuperseded push with the current same-endpoint keys", { timeout: 25_000 }, async () => {
  const fakeNow = 4_000_000_000_000;
  const replacementPrivateKey = new Uint8Array(Buffer.alloc(32, 1));
  const replacementReceiver = {
    auth: encodeBase64Url(new Uint8Array(Buffer.alloc(16, 0x36))),
    endpoint: pushReceiver.endpoint,
    p256dh: encodeBase64Url(derivePublicKey(replacementPrivateKey)),
    privateKey: encodeBase64Url(replacementPrivateKey),
  };

  await withRestartedRuntime(async (initial, restart) => {
    const { room } = await createRoom(initial, "before push enrollment");
    const browserId = crypto.randomUUID();
    expect((await enrollPush(initial, room.id, browserId)).status).toBe(201);
    expect((await post(initial, room.id, "future message for a replaced key without a newer event")).status).toBe(201);

    let runtime = await restart(fakeNow + PUSH_INITIAL_DELAY_MS);
    await runtime.setOutboundResponse(410, undefined, 500);
    const inFlight = runtime.triggerAlarm(room.id);
    const oldRequest = await waitForOutboundRequests(runtime, 1);
    expect(oldRequest).toHaveLength(1);
    expect((await enrollPush(runtime, room.id, browserId, replacementReceiver)).status).toBe(201);
    await inFlight;
    expect(await (await readPushStatus(runtime, room.id, browserId)).json()).toEqual({ enrolled: true, protocol_version: 1 });

    runtime = await restart(fakeNow + PUSH_INITIAL_DELAY_MS + PUSH_DELIVERY_LEASE_MS + 1);
    await runtime.triggerAlarm(room.id);
    expect(await runtime.inspectOutboundRequests()).toEqual([]);

    runtime = await restart(fakeNow + PUSH_INITIAL_DELAY_MS + PUSH_DELIVERY_LEASE_MS + 1 + PUSH_RETRY_INITIAL_DELAY_MS);
    await runtime.setOutboundResponse(204);
    await runtime.triggerAlarm(room.id);
    const retry = await waitForOutboundRequests(runtime, 1);
    expect(retry).toHaveLength(1);
    const payload = JSON.parse(Buffer.from(decryptWebPushBody(
      new Uint8Array(Buffer.from(retry[0]!.body_base64, "base64")),
      decodeBase64Url(replacementReceiver.privateKey),
      decodeBase64Url(replacementReceiver.auth),
    )).toString("utf8")) as Record<string, unknown>;
    expect(payload).toEqual({
      room_id: expect.stringMatching(/^[0-9a-f-]{36}$/iu),
      room_url: `https://msg.0000.chat/${room.id}`,
      type: "message.created",
    });
    expect(await (await readPushStatus(runtime, room.id, browserId)).json()).toEqual({ enrolled: true, protocol_version: 1 });
  }, TEST_ROOM_LIMITS, fakeNow);
});

test.serial("room deletion and inactivity expiry clear subscriptions and pending push work", { timeout: 20_000 }, async () => {
  const fakeNow = 4_000_000_000_000;
  const shortRoomLimits = { ...TEST_ROOM_LIMITS, inactivityTtlMs: 1_000 };
  await withRestartedRuntime(async (initial, restart) => {
    const deletedRoom = await createRoom(initial, "room to delete");
    const expiredRoom = await createRoom(initial, "room to expire");
    const browserId = crypto.randomUUID();
    expect((await enrollPush(initial, deletedRoom.room.id, browserId)).status).toBe(201);
    expect((await enrollPush(initial, expiredRoom.room.id, browserId)).status).toBe(201);
    expect((await post(initial, deletedRoom.room.id, "pending before deletion")).status).toBe(201);
    expect((await post(initial, expiredRoom.room.id, "pending before inactivity expiry")).status).toBe(201);

    const deletion = await initial.dispatchFetch(deletedRoom.manage_url, { headers: { accept: "application/json" }, method: "DELETE" });
    expect(deletion.status).toBe(200);
    expect(await deletion.json()).toMatchObject({ deleted: true });
    await initial.triggerAlarm(deletedRoom.room.id);
    expect(await initial.inspectOutboundRequests()).toEqual([]);

    const miniflare = await restart(fakeNow + 1_001);
    await miniflare.triggerAlarm(expiredRoom.room.id);
    expect(await miniflare.inspectOutboundRequests()).toEqual([]);
    expect((await readPushStatus(miniflare, deletedRoom.room.id, browserId)).status).toBe(410);
    expect((await readPushStatus(miniflare, expiredRoom.room.id, browserId)).status).toBe(410);
  }, shortRoomLimits, fakeNow);
});

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

test.serial("creates and persists a room from the ChatGPT origin", { timeout: 15_000 }, async () => {
  await withSharedRuntime(async (miniflare) => {
    const content = "created from ChatGPT";
    const response = await miniflare.dispatchFetch("https://msg.0000.chat/", {
      body: JSON.stringify({ content, author: "alpha", display_name: "Alpha", semantic_type: "message" }),
      headers: { ...jsonHeaders, "idempotency-key": "chatgpt-integration", origin: "https://chatgpt.com" },
      method: "POST",
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://chatgpt.com");
    expect(response.headers.get("access-control-expose-headers")).toBe("Location, Retry-After");
    expect(response.headers.get("vary")).toBe("Origin");

    const created = await response.json() as { room: { id: string } };
    const read = await miniflare.dispatchFetch(`https://msg.0000.chat/${created.room.id}`, {
      headers: { accept: "application/json" },
    });
    expect(read.status).toBe(200);
    expect((await read.json() as { messages: Array<{ content: string }> }).messages).toContainEqual(expect.objectContaining({ content }));
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

test.serial("runs the delegated GET posting lifecycle through Worker and Durable Object", { timeout: 15_000 }, async () => {
  await withSharedRuntime(async (miniflare) => {
    const created = await createRoom(miniflare);
    const enabled = await miniflare.dispatchFetch(created.manage_url, {
      body: JSON.stringify({ action: "enable" }),
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
    });
    const enabledValue = await enabled.json() as { get_post_enabled: boolean; get_post_url: string; get_post_url_warning?: string };
    expect(enabled.status).toBe(200);
    expect(enabledValue.get_post_enabled).toBe(true);
    expect(enabledValue.get_post_url_warning).toContain("write capability");

    const firstUrl = new URL(enabledValue.get_post_url);
    firstUrl.searchParams.set("request_id", "fetch-only-1");
    firstUrl.searchParams.set("content", "fetch-only reply");
    firstUrl.searchParams.set("author", "URL agent");
    const first = await miniflare.dispatchFetch(firstUrl, { headers: { accept: "application/json" } });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ accepted: true, replayed: false, request_id: "fetch-only-1", sequence: 2 });

    const rotated = await miniflare.dispatchFetch(created.manage_url, {
      body: JSON.stringify({ action: "rotate" }),
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
    });
    const rotatedValue = await rotated.json() as { get_post_url: string };
    const oldRetry = await miniflare.dispatchFetch(firstUrl, { headers: { accept: "application/json" } });
    expect(rotated.status).toBe(200);
    expect(oldRetry.status).toBe(404);

    const disabled = await miniflare.dispatchFetch(created.manage_url, {
      body: JSON.stringify({ action: "disable" }),
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
    });
    const newUrl = new URL(rotatedValue.get_post_url);
    newUrl.searchParams.set("request_id", "fetch-only-2");
    newUrl.searchParams.set("content", "blocked");
    const afterDisable = await miniflare.dispatchFetch(newUrl, { headers: { accept: "application/json" } });
    expect(disabled.status).toBe(200);
    expect(afterDisable.status).toBe(404);

    const transcript = await miniflare.dispatchFetch(created.conversation_url, { headers: { accept: "application/json" } });
    expect((await transcript.json() as { messages: Array<{ content: string }> }).messages.map((message) => message.content)).toEqual(["first", "fetch-only reply"]);
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
    const deletedRegistration = await registerWebhook(first, deletedRoom.room.id, "https://receiver.example.com/deleted-room");
    const deletedPost = await post(first, deletedRoom.room.id, "cancel on deletion");
    expect(deletedPost.status).toBe(201);
    const deletedSource = (await deletedPost.json() as { message: { id: string } }).message;
    const deleted = await first.dispatchFetch(deletedRoom.manage_url, { headers: { accept: "application/json" }, method: "DELETE" });
    expect(deleted.status).toBe(200);
    const redeliveryAfterDelete = await first.dispatchFetch(`https://msg.0000.chat/${deletedRoom.room.id}/webhooks/${deletedRegistration.webhook.id}/deliveries/${deletedSource.id}/redeliver`, { method: "POST" });
    expect(redeliveryAfterDelete.status).toBe(410);

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

test.serial("manual disable cancels queued work and re-enable starts with only later messages across restart", { timeout: 20_000 }, async () => {
  const fakeNow = 4_000_000_000_000;
  await withRestartedRuntime(async (first, restart) => {
    const { room } = await createRoom(first);
    const registration = await registerWebhook(first, room.id, "https://receiver.example.com/disable-and-enable");
    const beforeDisable = await post(first, room.id, "queued before disable");
    const beforeDisableId = (await beforeDisable.json() as { message: { id: string } }).message.id;

    const disabled = await first.dispatchFetch(`https://msg.0000.chat/${room.id}/webhooks/${registration.webhook.id}/disable`, { method: "POST" });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ webhook: { id: registration.webhook.id, status: "disabled" } });
    expect((await post(first, room.id, "created while disabled")).status).toBe(201);

    let runtime = await restart(fakeNow + 1_000);
    let endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    expect(endpoint).toMatchObject({ status: "disabled", deliveries: [{ cancelled_at: new Date(fakeNow).toISOString(), event_id: beforeDisableId, status: "cancelled" }] });
    await runtime.triggerAlarm(room.id);
    expect(await runtime.inspectOutboundRequests()).toEqual([]);

    const enabled = await runtime.dispatchFetch(`https://msg.0000.chat/${room.id}/webhooks/${registration.webhook.id}/enable`, { method: "POST" });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({ webhook: { disabled_at: null, failure_started_at: null, status: "active" } });
    await runtime.triggerAlarm(room.id);
    expect(await runtime.inspectOutboundRequests()).toEqual([]);

    const afterEnable = await post(runtime, room.id, "created after re-enable");
    const afterEnableId = (await afterEnable.json() as { message: { id: string } }).message.id;
    runtime = await restart(fakeNow + 2_000);
    await runtime.triggerAlarm(room.id);
    const requests = await waitForOutboundRequests(runtime, 1);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ event_id: afterEnableId, message: { content: "created after re-enable" } });
    endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    expect(endpoint).toMatchObject({
      status: "active",
      deliveries: [
        { event_id: afterEnableId, status: "delivered" },
        { event_id: beforeDisableId, status: "cancelled" },
      ],
    });
    expect(endpoint.deliveries.some(({ event_id }) => event_id !== afterEnableId && event_id !== beforeDisableId)).toBe(false);
  }, TEST_ROOM_LIMITS, fakeNow);
});

test.serial("a disable followed by re-enable does not resurrect an automatic request already in flight", { timeout: 20_000 }, async () => {
  const fakeNow = 4_000_000_000_000;
  await withRestartedRuntime(async (first, restart) => {
    const { room } = await createRoom(first);
    const registration = await registerWebhook(first, room.id, "https://receiver.example.com/disable-in-flight");
    const oldPost = await post(first, room.id, "in-flight event canceled by disable");
    const oldEventId = (await oldPost.json() as { message: { id: string } }).message.id;

    let runtime = await restart(fakeNow + 250);
    await runtime.setOutboundResponse(503, undefined, 750);
    const alarm = runtime.triggerAlarm(room.id);
    expect(await waitForOutboundRequests(runtime, 1)).toHaveLength(1);

    const disabled = await runtime.dispatchFetch(`https://msg.0000.chat/${room.id}/webhooks/${registration.webhook.id}/disable`, { method: "POST" });
    expect(disabled.status).toBe(200);
    const enabled = await runtime.dispatchFetch(`https://msg.0000.chat/${room.id}/webhooks/${registration.webhook.id}/enable`, { method: "POST" });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({ webhook: { failure_started_at: null, status: "active" } });
    await alarm;

    let endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    expect(endpoint).toMatchObject({ status: "active", deliveries: [{ attempt_count: 1, cancelled_at: new Date(fakeNow + 250).toISOString(), event_id: oldEventId, status: "cancelled" }] });
    expect(endpoint.deliveries[0]?.attempts.map(({ status }) => status)).toEqual(["failed"]);
    await runtime.triggerAlarm(room.id);
    expect(await runtime.inspectOutboundRequests()).toHaveLength(1);

    runtime = await restart(fakeNow + 500);
    await runtime.setOutboundResponse(204);
    const newPost = await post(runtime, room.id, "new message after re-enable");
    const newEventId = (await newPost.json() as { message: { id: string } }).message.id;
    runtime = await restart(fakeNow + 751);
    await runtime.setOutboundResponse(204);
    await runtime.triggerAlarm(room.id);
    const requests = await waitForOutboundRequests(runtime, 1);
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ event_id: newEventId, message: { content: "new message after re-enable" } });
    endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    expect(endpoint.deliveries.map(({ event_id, status }) => [event_id, status])).toEqual([[newEventId, "delivered"], [oldEventId, "cancelled"]]);
  }, TEST_ROOM_LIMITS, fakeNow);
});

test.serial("secret rotation reveals once and signs later dispatches with the current key", { timeout: 20_000 }, async () => {
  const fakeNow = 4_000_000_000_000;
  await withRestartedRuntime(async (first, restart) => {
    const { room } = await createRoom(first);
    const registration = await registerWebhook(first, room.id, "https://receiver.example.com/secret-rotation");
    const oldSecret = registration.secret;
    const inFlightPost = await post(first, room.id, "already in flight under the old key");
    const inFlightEventId = (await inFlightPost.json() as { message: { id: string } }).message.id;

    let runtime = await restart(fakeNow + 250);
    await runtime.setOutboundResponse(204, undefined, 750);
    const alarm = runtime.triggerAlarm(room.id);
    const inFlight = await waitForOutboundRequests(runtime, 1);
    expect(inFlight).toHaveLength(1);

    const rotated = await runtime.dispatchFetch(`https://msg.0000.chat/${room.id}/webhooks/${registration.webhook.id}/rotate-secret`, { method: "POST" });
    expect(rotated.status).toBe(200);
    const rotation = await rotated.json() as { secret: string; webhook: { id: string } };
    expect(rotation.webhook.id).toBe(registration.webhook.id);
    expect(rotation.secret).not.toBe(oldSecret);
    const listed = await runtime.dispatchFetch(`https://msg.0000.chat/${room.id}/webhooks`, { headers: { accept: "application/json" } });
    const listing = await listed.text();
    expect(listing).not.toContain(oldSecret);
    expect(listing).not.toContain(rotation.secret);
    await alarm;

    const oldRequest = inFlight[0]!;
    expect(JSON.parse(oldRequest.body)).toMatchObject({ event_id: inFlightEventId, message: { content: "already in flight under the old key" } });
    expect(await verifyWebhookSignature(oldSecret, oldRequest.headers["x-msg-timestamp"]!, oldRequest.body, oldRequest.headers["x-msg-signature"]!)).toBe(true);
    expect(await verifyWebhookSignature(rotation.secret, oldRequest.headers["x-msg-timestamp"]!, oldRequest.body, oldRequest.headers["x-msg-signature"]!)).toBe(false);

    const afterRotation = await post(runtime, room.id, "signed with the new key");
    const afterRotationId = (await afterRotation.json() as { message: { id: string } }).message.id;
    runtime = await restart(fakeNow + 500);
    await runtime.setOutboundResponse(204);
    await runtime.triggerAlarm(room.id);
    const requests = await waitForOutboundRequests(runtime, 1);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ event_id: afterRotationId, message: { content: "signed with the new key" } });
    expect(await verifyWebhookSignature(rotation.secret, requests[0]!.headers["x-msg-timestamp"]!, requests[0]!.body, requests[0]!.headers["x-msg-signature"]!)).toBe(true);
    expect(await verifyWebhookSignature(oldSecret, requests[0]!.headers["x-msg-timestamp"]!, requests[0]!.body, requests[0]!.headers["x-msg-signature"]!)).toBe(false);
  }, TEST_ROOM_LIMITS, fakeNow);
});

test.serial("redelivers one retained failed event while disabled after its automatic window without an automatic backlog", { timeout: 20_000 }, async () => {
  const fakeNow = 4_000_000_000_000;
  const dayMs = 24 * 60 * 60 * 1_000;
  await withRestartedRuntime(async (first, restart) => {
    const { room } = await createRoom(first);
    const registration = await registerWebhook(first, room.id, "https://receiver.example.com/targeted-redelivery");
    const posted = await post(first, room.id, "the retained source message");
    const source = (await posted.json() as { message: { id: string } }).message;

    let runtime = await restart(fakeNow + 250);
    await runtime.setOutboundResponse(503);
    await runtime.triggerAlarm(room.id);
    let endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    expect(endpoint.deliveries[0]).toMatchObject({ attempt_count: 1, event_id: source.id, status: "retrying" });
    const automaticDeadline = Date.parse(endpoint.failure_started_at!) + dayMs;

    runtime = await restart(automaticDeadline);
    await runtime.triggerAlarm(room.id);
    endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    expect(endpoint).toMatchObject({ status: "disabled", deliveries: [{ attempt_count: 1, event_id: source.id, status: "failed" }] });

    const beforeRead = await runtime.dispatchFetch(`https://msg.0000.chat/${room.id}`, { headers: { accept: "application/json" } });
    const expiresAt = (await beforeRead.json() as { expires_at: string }).expires_at;
    const redeliveryUrl = `https://msg.0000.chat/${room.id}/webhooks/${registration.webhook.id}/deliveries/${source.id}/redeliver`;
    const queued = await runtime.dispatchFetch(redeliveryUrl, { method: "POST" });
    expect(queued.status).toBe(202);
    expect(await queued.json()).toMatchObject({ result: "queued", delivery: { attempt_count: 1, event_id: source.id, status: "pending" } });
    const duplicate = await runtime.dispatchFetch(redeliveryUrl, { method: "POST" });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ result: "already_queued", delivery: { attempt_count: 1, event_id: source.id, status: "pending" } });

    const disabledAgain = await runtime.dispatchFetch(`https://msg.0000.chat/${room.id}/webhooks/${registration.webhook.id}/disable`, { method: "POST" });
    expect(disabledAgain.status).toBe(200);
    endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    expect(endpoint).toMatchObject({ status: "disabled", deliveries: [{ attempt_count: 1, event_id: source.id, failure_category: "http_status", status: "failed" }] });
    expect(endpoint.deliveries[0]?.attempts.map(({ status }) => status)).toEqual(["failed"]);
    await runtime.triggerAlarm(room.id);
    expect(await runtime.inspectOutboundRequests()).toEqual([]);

    const queuedAgain = await runtime.dispatchFetch(redeliveryUrl, { method: "POST" });
    expect(queuedAgain.status).toBe(202);
    expect(await queuedAgain.json()).toMatchObject({ result: "queued", delivery: { attempt_count: 1, event_id: source.id, status: "pending" } });

    const rotated = await runtime.dispatchFetch(`https://msg.0000.chat/${room.id}/webhooks/${registration.webhook.id}/rotate-secret`, { method: "POST" });
    expect(rotated.status).toBe(200);
    const activeSecret = (await rotated.json() as { secret: string }).secret;
    expect(activeSecret).not.toBe(registration.secret);
    endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    expect(endpoint.status).toBe("disabled");

    runtime = await restart(automaticDeadline + 1_000);
    await runtime.setOutboundResponse(503);
    await runtime.triggerAlarm(room.id);
    let requests = await waitForOutboundRequests(runtime, 1);
    expect(requests).toHaveLength(1);
    const firstManualAttempt = requests[0]!;
    expect(await verifyWebhookSignature(activeSecret, firstManualAttempt.headers["x-msg-timestamp"]!, firstManualAttempt.body, firstManualAttempt.headers["x-msg-signature"]!)).toBe(true);
    endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    expect(endpoint).toMatchObject({ status: "disabled", deliveries: [{ attempt_count: 2, event_id: source.id, failure_category: "http_status", status: "failed" }] });
    expect(endpoint.deliveries[0]?.attempts.map(({ status }) => status)).toEqual(["failed", "failed"]);
    await runtime.triggerAlarm(room.id);
    expect(await runtime.inspectOutboundRequests()).toHaveLength(1);

    await runtime.clearOutboundRequests();
    const retryAfterFailure = await runtime.dispatchFetch(redeliveryUrl, { method: "POST" });
    expect(retryAfterFailure.status).toBe(202);
    expect(await retryAfterFailure.json()).toMatchObject({ result: "queued", delivery: { attempt_count: 2, event_id: source.id, status: "pending" } });
    await runtime.setOutboundResponse(204);
    await runtime.triggerAlarm(room.id);
    requests = await waitForOutboundRequests(runtime, 1);
    expect(requests).toHaveLength(1);
    const outbound = requests[0]!;
    const event = JSON.parse(outbound.body) as { event_id: string; message: { content: string; id: string; sequence: number } };
    expect(event).toMatchObject({ event_id: source.id, message: { content: "the retained source message", id: source.id, sequence: source.sequence } });
    expect(await verifyWebhookSignature(activeSecret, outbound.headers["x-msg-timestamp"]!, outbound.body, outbound.headers["x-msg-signature"]!)).toBe(true);
    expect(await verifyWebhookSignature(registration.secret, outbound.headers["x-msg-timestamp"]!, outbound.body, outbound.headers["x-msg-signature"]!)).toBe(false);

    endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    expect(endpoint).toMatchObject({
      disabled_at: new Date(automaticDeadline).toISOString(),
      last_success_at: new Date(automaticDeadline + 1_000).toISOString(),
      status: "disabled",
      deliveries: [{ attempt_count: 3, event_id: source.id, status: "delivered" }],
    });
    expect(endpoint.deliveries[0]?.attempts.map(({ status }) => status)).toEqual(["failed", "failed", "delivered"]);
    const afterRead = await runtime.dispatchFetch(`https://msg.0000.chat/${room.id}`, { headers: { accept: "application/json" } });
    expect((await afterRead.json() as { expires_at: string }).expires_at).toBe(expiresAt);
    const rejected = await runtime.dispatchFetch(redeliveryUrl, { method: "POST" });
    expect(rejected.status).toBe(409);
    expect(await runtime.inspectOutboundRequests()).toHaveLength(1);
  }, TEST_ROOM_LIMITS, fakeNow);
});

test.serial("rejects redelivery when a failed event or its source is no longer retained", { timeout: 25_000 }, async () => {
  const fakeNow = 4_000_000_000_000;
  const dayMs = 24 * 60 * 60 * 1_000;
  await withRestartedRuntime(async (first, restart) => {
    const { room } = await createRoom(first);
    const registration = await registerWebhook(first, room.id, "https://receiver.example.com/missing-redelivery-source");
    const firstPost = await post(first, room.id, "source removed before request");
    const firstSource = (await firstPost.json() as { message: { id: string } }).message;
    const secondPost = await post(first, room.id, "source removed after queue");
    const secondSource = (await secondPost.json() as { message: { id: string } }).message;

    let runtime = await restart(fakeNow + 250);
    await runtime.setOutboundResponse(503);
    await runtime.triggerAlarm(room.id);
    expect(await waitForOutboundRequests(runtime, 2)).toHaveLength(2);
    let endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    expect(endpoint.deliveries.map(({ status }) => status)).toEqual(["retrying", "retrying"]);
    const automaticDeadline = Date.parse(endpoint.failure_started_at!) + dayMs;

    runtime = await restart(automaticDeadline);
    await runtime.triggerAlarm(room.id);
    endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    expect(endpoint).toMatchObject({ status: "disabled" });
    expect(endpoint.deliveries.map(({ status }) => status)).toEqual(["failed", "failed"]);

    const unknownEvent = await runtime.dispatchFetch(
      `https://msg.0000.chat/${room.id}/webhooks/${registration.webhook.id}/deliveries/c0000000-0000-4000-8000-000000000001/redeliver`,
      { method: "POST" },
    );
    expect(unknownEvent.status).toBe(404);

    await runtime.deleteWebhookSource(room.id, firstSource.id);
    const missingAtRequest = await runtime.dispatchFetch(
      `https://msg.0000.chat/${room.id}/webhooks/${registration.webhook.id}/deliveries/${firstSource.id}/redeliver`,
      { method: "POST" },
    );
    expect(missingAtRequest.status).toBe(404);
    const retainedEventIds = (await readWebhookList(runtime, room.id)).webhooks[0]?.deliveries.map(({ event_id }) => event_id) ?? [];
    expect(retainedEventIds).toHaveLength(2);
    expect(retainedEventIds.sort()).toEqual([firstSource.id, secondSource.id].sort());

    const secondRedeliveryUrl = `https://msg.0000.chat/${room.id}/webhooks/${registration.webhook.id}/deliveries/${secondSource.id}/redeliver`;
    const queued = await runtime.dispatchFetch(secondRedeliveryUrl, { method: "POST" });
    expect(queued.status).toBe(202);
    await runtime.deleteWebhookSource(room.id, secondSource.id);
    await runtime.clearOutboundRequests();
    await runtime.triggerAlarm(room.id);
    expect(await runtime.inspectOutboundRequests()).toEqual([]);
    endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    expect(endpoint.deliveries.map(({ event_id, status }) => [event_id, status])).toEqual([[firstSource.id, "failed"]]);
    expect((await runtime.dispatchFetch(secondRedeliveryUrl, { method: "POST" })).status).toBe(404);

    runtime = await restart(fakeNow + 6 * dayMs);
    expect((await post(runtime, room.id, "keep the room active past the original event retention")).status).toBe(201);
    runtime = await restart(fakeNow + 7 * dayMs + 1);
    const activeRoom = await runtime.dispatchFetch(`https://msg.0000.chat/${room.id}`, { headers: { accept: "application/json" } });
    expect(activeRoom.status).toBe(200);
    const expiredDelivery = await runtime.dispatchFetch(
      `https://msg.0000.chat/${room.id}/webhooks/${registration.webhook.id}/deliveries/${firstSource.id}/redeliver`,
      { method: "POST" },
    );
    expect(expiredDelivery.status).toBe(404);
  }, TEST_ROOM_LIMITS, fakeNow);
});

test.serial("expires a room with pending webhook work without extending its message lifetime", { timeout: 15_000 }, async () => {
  const fakeNow = 4_000_000_000_000;
  const limits = { ...TEST_ROOM_LIMITS, inactivityTtlMs: 1_000 };
  await withRestartedRuntime(async (first, restart) => {
    const { room } = await createRoom(first);
    const registration = await registerWebhook(first, room.id, "https://receiver.example.com/expiring-room");
    const posted = await post(first, room.id, "expires before delivery");
    expect(posted.status).toBe(201);
    const source = (await posted.json() as { message: { id: string } }).message;

    const restarted = await restart(fakeNow + limits.inactivityTtlMs);
    await restarted.triggerAlarm(room.id);
    expect(await restarted.inspectOutboundRequests()).toEqual([]);
    const gone = await restarted.dispatchFetch(`https://msg.0000.chat/${room.id}/webhooks`, { headers: { accept: "application/json" } });
    expect(gone.status).toBe(410);
    const redelivery = await restarted.dispatchFetch(`https://msg.0000.chat/${room.id}/webhooks/${registration.webhook.id}/deliveries/${source.id}/redeliver`, { method: "POST" });
    expect(redelivery.status).toBe(410);
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
    const delivery = await waitForWebhookDeliveryStatus(miniflare, room.id, registration.webhook.id, "retrying");
    expect(delivery).toMatchObject({ attempt_count: 1, failure_category: "http_status", status: "retrying" });

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
    const delivery = await waitForWebhookDeliveryStatus(miniflare, room.id, registration.webhook.id, "retrying");
    expect(delivery).toMatchObject({ attempt_count: 1, failure_category: "redirect", status: "retrying" });
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
    const delivery = await waitForWebhookDeliveryStatus(miniflare, room.id, registration.webhook.id, "retrying", 7_000);
    expect(delivery).toMatchObject({ attempt_count: 1, failure_category: "timeout", status: "retrying" });
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
});

test.serial("retries each event on increasing durable delays and preserves its event ID across duplicates", { timeout: 20_000 }, async () => {
  const fakeNow = 4_000_000_000_000;
  await withRestartedRuntime(async (first, restart) => {
    const { room } = await createRoom(first);
    await registerWebhook(first, room.id, "https://receiver.example.com/retries");
    const posted = await post(first, room.id, "retry with one stable event");
    const eventId = (await posted.json() as { message: { id: string } }).message.id;
    const bodies: string[] = [];

    let runtime = await restart(fakeNow + 250);
    await runtime.setOutboundResponse(503);
    await runtime.triggerAlarm(room.id);
    bodies.push((await runtime.inspectOutboundRequests())[0]!.body);
    let endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    let delivery = endpoint.deliveries.find(({ event_id }) => event_id === eventId)!;
    expect(delivery).toMatchObject({ attempt_count: 1, failure_category: "http_status", status: "retrying" });
    expect(delivery.attempts).toHaveLength(1);
    const firstDelayMs = Date.parse(delivery.next_attempt_at!) - Date.parse(delivery.completed_at!);
    expect(firstDelayMs).toBeGreaterThan(0);

    runtime = await restart(Date.parse(delivery.next_attempt_at!));
    await runtime.setOutboundResponse(503);
    await runtime.triggerAlarm(room.id);
    bodies.push((await runtime.inspectOutboundRequests())[0]!.body);
    endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    delivery = endpoint.deliveries.find(({ event_id }) => event_id === eventId)!;
    expect(delivery).toMatchObject({ attempt_count: 2, failure_category: "http_status", status: "retrying" });
    expect(delivery.attempts.map(({ status }) => status)).toEqual(["failed", "failed"]);
    const secondDelayMs = Date.parse(delivery.next_attempt_at!) - Date.parse(delivery.completed_at!);
    expect(secondDelayMs).toBeGreaterThan(firstDelayMs);

    runtime = await restart(Date.parse(delivery.next_attempt_at!));
    await runtime.setOutboundResponse(204);
    await runtime.triggerAlarm(room.id);
    bodies.push((await runtime.inspectOutboundRequests())[0]!.body);
    endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    delivery = endpoint.deliveries.find(({ event_id }) => event_id === eventId)!;
    expect(delivery).toMatchObject({ attempt_count: 3, failure_category: null, status: "delivered" });
    expect(delivery.attempts.map(({ status }) => status)).toEqual(["failed", "failed", "delivered"]);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!).event_id).toBe(eventId);
    expect(endpoint).toMatchObject({
      disabled_at: null,
      failure_started_at: null,
      last_failure_at: expect.any(String),
      last_success_at: expect.any(String),
      recovered_at: expect.any(String),
      status: "active",
    });
  }, TEST_ROOM_LIMITS, fakeNow);
});

test.serial("a newer success resets endpoint health before an older event expires", { timeout: 20_000 }, async () => {
  const fakeNow = 4_000_000_000_000;
  await withRestartedRuntime(async (first, restart) => {
    const { room } = await createRoom(first);
    await registerWebhook(first, room.id, "https://receiver.example.com/independent-events");
    const oldPost = await post(first, room.id, "older event");
    const oldEventId = (await oldPost.json() as { message: { id: string } }).message.id;

    let runtime = await restart(fakeNow + 1);
    const newPost = await post(runtime, room.id, "newer event");
    const newEventId = (await newPost.json() as { message: { id: string } }).message.id;

    runtime = await restart(fakeNow + 250);
    await runtime.setOutboundResponse(503);
    await runtime.triggerAlarm(room.id);
    expect(await runtime.inspectOutboundRequests()).toHaveLength(1);
    let endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    expect(endpoint.deliveries.find(({ event_id }) => event_id === oldEventId)?.status).toBe("retrying");
    expect(endpoint.deliveries.find(({ event_id }) => event_id === newEventId)?.status).toBe("pending");

    runtime = await restart(fakeNow + 251);
    await runtime.setOutboundResponse(204);
    await runtime.triggerAlarm(room.id);
    expect(await runtime.inspectOutboundRequests()).toHaveLength(1);
    endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    const recoveredAt = endpoint.recovered_at;
    expect(endpoint).toMatchObject({ failure_started_at: null, last_success_at: expect.any(String), recovered_at: expect.any(String), status: "active" });
    expect(endpoint.deliveries.find(({ event_id }) => event_id === newEventId)?.status).toBe("delivered");

    runtime = await restart(fakeNow + 24 * 60 * 60 * 1_000);
    await runtime.triggerAlarm(room.id);
    endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    expect(endpoint.status).toBe("active");
    expect(endpoint.failure_started_at).toBeNull();
    expect(endpoint.recovered_at).toBe(recoveredAt);
    expect(endpoint.deliveries.find(({ event_id }) => event_id === oldEventId)).toMatchObject({
      attempt_count: 1,
      completed_at: new Date(fakeNow + 24 * 60 * 60 * 1_000).toISOString(),
      failure_category: "http_status",
      status: "failed",
    });
  }, TEST_ROOM_LIMITS, fakeNow);
});

test.serial("a newer success survives recovery of an expired persisted sending lease", { timeout: 20_000 }, async () => {
  const fakeNow = 4_000_000_000_000;
  await withRestartedRuntime(async (first, restart) => {
    const { room } = await createRoom(first);
    await registerWebhook(first, room.id, "https://receiver.example.com/stale-lease");
    const oldPost = await post(first, room.id, "persisted sending event");
    const oldEventId = (await oldPost.json() as { message: { id: string } }).message.id;
    await first.markWebhookDeliverySending(room.id, oldEventId);

    const newPost = await post(first, room.id, "later successful event");
    const newEventId = (await newPost.json() as { message: { id: string } }).message.id;
    let runtime = await restart(fakeNow + 250);
    let endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    const oldDelivery = endpoint.deliveries.find(({ event_id }) => event_id === oldEventId)!;
    expect(oldDelivery).toMatchObject({ attempt_count: 1, status: "sending" });
    expect(oldDelivery.attempts).toMatchObject([{ attempt_number: 1, status: "sending" }]);

    await runtime.setOutboundResponse(204);
    await runtime.triggerAlarm(room.id);
    expect(await runtime.inspectOutboundRequests()).toHaveLength(1);
    endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    expect(endpoint.deliveries.find(({ event_id }) => event_id === newEventId)?.status).toBe("delivered");
    expect(endpoint).toMatchObject({ failure_started_at: null, last_failure_at: null, last_success_at: expect.any(String), status: "active" });

    runtime = await restart(fakeNow + 24 * 60 * 60 * 1_000 + 1);
    await runtime.triggerAlarm(room.id);
    endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    expect(endpoint).toMatchObject({ failure_started_at: null, last_failure_at: null, last_success_at: new Date(fakeNow + 250).toISOString(), status: "active" });
    expect(endpoint.deliveries.find(({ event_id }) => event_id === oldEventId)).toMatchObject({
      attempt_count: 1,
      completed_at: new Date(fakeNow + 24 * 60 * 60 * 1_000).toISOString(),
      failure_category: "retry_window_expired",
      status: "failed",
    });
    expect(endpoint.deliveries.find(({ event_id }) => event_id === oldEventId)?.attempts).toMatchObject([
      { attempt_number: 1, failure_category: "retry_window_expired", status: "failed" },
    ]);
  }, TEST_ROOM_LIMITS, fakeNow);
});

test.serial("keeps the health deadline after an event expires and preserves cancelled history on automatic disable", { timeout: 20_000 }, async () => {
  const fakeNow = 4_000_000_000_000;
  await withRestartedRuntime(async (first, restart) => {
    const { room } = await createRoom(first);
    await registerWebhook(first, room.id, "https://receiver.example.com/unhealthy");
    const oldPost = await post(first, room.id, "event that will expire");
    const oldEventId = (await oldPost.json() as { message: { id: string } }).message.id;

    let runtime = await restart(fakeNow + 250);
    await runtime.setOutboundResponse(503);
    await runtime.triggerAlarm(room.id);
    let endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    const failureStartedAt = Date.parse(endpoint.failure_started_at!);

    runtime = await restart(fakeNow + 23 * 60 * 60 * 1_000);
    const queuedPost = await post(runtime, room.id, "queued before automatic disable");
    const queuedEventId = (await queuedPost.json() as { message: { id: string } }).message.id;
    const disableAt = failureStartedAt + 24 * 60 * 60 * 1_000;

    runtime = await restart(disableAt);
    await runtime.triggerAlarm(room.id);
    expect(await runtime.inspectOutboundRequests()).toEqual([]);
    endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    expect(endpoint).toMatchObject({
      disabled_at: new Date(disableAt).toISOString(),
      failure_started_at: new Date(failureStartedAt).toISOString(),
      last_failure_at: new Date(failureStartedAt).toISOString(),
      status: "disabled",
    });
    expect(endpoint.deliveries.find(({ event_id }) => event_id === oldEventId)).toMatchObject({ status: "failed", attempt_count: 1 });
    expect(endpoint.deliveries.find(({ event_id }) => event_id === queuedEventId)).toMatchObject({
      attempt_count: 0,
      cancelled_at: new Date(disableAt).toISOString(),
      status: "cancelled",
    });
  }, TEST_ROOM_LIMITS, fakeNow);
});

test.serial("retains webhook delivery and health metadata for seven days, then prunes it without re-enabling the endpoint", { timeout: 20_000 }, async () => {
  const fakeNow = 4_000_000_000_000;
  const dayMs = 24 * 60 * 60 * 1_000;
  await withRestartedRuntime(async (first, restart) => {
    const { room } = await createRoom(first);
    await registerWebhook(first, room.id, "https://receiver.example.com/history-retention");
    const posted = await post(first, room.id, "event retained for seven days");
    const eventId = (await posted.json() as { message: { id: string } }).message.id;

    let runtime = await restart(fakeNow + 250);
    await runtime.setOutboundResponse(503);
    await runtime.triggerAlarm(room.id);
    let endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    const failureStartedAt = Date.parse(endpoint.failure_started_at!);
    expect(endpoint.deliveries.find(({ event_id }) => event_id === eventId)).toMatchObject({
      attempt_count: 1,
      status: "retrying",
    });

    const disableAt = failureStartedAt + dayMs;
    runtime = await restart(disableAt);
    await runtime.triggerAlarm(room.id);
    endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    expect(endpoint.status).toBe("disabled");
    expect(endpoint.disabled_at).toBe(new Date(disableAt).toISOString());

    runtime = await restart(fakeNow + 6 * dayMs);
    const refresh = await post(runtime, room.id, "room remains active while disabled webhook history ages");
    expect(refresh.status).toBe(201);
    expect((await readWebhookList(runtime, room.id)).webhooks[0]!.deliveries.map(({ event_id }) => event_id)).toEqual([eventId]);

    // The delivery and endpoint health dates remain available up to the
    // seven-day boundary, even though the endpoint is already disabled.
    runtime = await restart(fakeNow + 7 * dayMs - 1);
    endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    expect(endpoint).toMatchObject({
      disabled_at: new Date(disableAt).toISOString(),
      failure_started_at: new Date(failureStartedAt).toISOString(),
      last_failure_at: new Date(failureStartedAt).toISOString(),
      status: "disabled",
    });
    expect(endpoint.deliveries.find(({ event_id }) => event_id === eventId)).toMatchObject({ attempt_count: 1 });

    // Disabled status is durable, while its associated delivery and health
    // timestamps age out after their individual seven-day retention period.
    runtime = await restart(disableAt + 7 * dayMs + 1);
    endpoint = (await readWebhookList(runtime, room.id)).webhooks[0]!;
    expect(endpoint).toMatchObject({
      disabled_at: null,
      failure_started_at: null,
      last_failure_at: null,
      last_success_at: null,
      recovered_at: null,
      status: "disabled",
    });
    expect(endpoint.deliveries).toEqual([]);
  }, TEST_ROOM_LIMITS, fakeNow);
});

test.serial("room deletion during an outbound await removes notification state and allows the in-flight request to finish", { timeout: 15_000 }, async () => {
  const limits = { ...TEST_ROOM_LIMITS, tombstoneTtlMs: 10_000 };
  await withRuntime(async (miniflare) => {
    await miniflare.setOutboundResponse(204, undefined, 750);
    const created = await createRoom(miniflare);
    const { room } = created;
    await registerWebhook(miniflare, room.id, "https://receiver.example.com/delete-during-send");
    expect((await post(miniflare, room.id, "message sent before room deletion")).status).toBe(201);

    expect(await waitForOutboundRequests(miniflare, 1)).toHaveLength(1);
    const deletion = await miniflare.dispatchFetch(created.manage_url, { headers: { accept: "application/json" }, method: "DELETE" });
    expect(deletion.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect((await miniflare.inspectOutboundRequests()).length).toBe(1);
    const gone = await miniflare.dispatchFetch(`https://msg.0000.chat/${room.id}/webhooks`, { headers: { accept: "application/json" } });
    expect(gone.status).toBe(410);
  }, limits);
});
