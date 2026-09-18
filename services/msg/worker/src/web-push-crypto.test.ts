import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from "node:crypto";
import { expect, test } from "bun:test";

import { createWebPushRequest, MAX_WEB_PUSH_PAYLOAD_BYTES } from "./web-push-crypto";

const decoder = new TextDecoder();
const rfc8291 = {
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  endpoint: "https://push.example.net/push/subscription-token",
  publicKey: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  receiverPrivateKey: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  applicationServerPublicKey: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ciphertext: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ",
} as const;

test("decrypts the RFC 8291 vector and independently decrypts a generated Web Push body", async () => {
  const officialBody = createOfficialWireBody();
  expect(decoder.decode(decryptWireBody(officialBody, decodeBase64Url(rfc8291.receiverPrivateKey), decodeBase64Url(rfc8291.auth))))
    .toBe("When I grow up, I want to be a watermelon");

  const vapid = await makeVapidKeys();
  const request = await createWebPushRequest({
    subscription: {
      auth: decodeBase64Url(rfc8291.auth),
      endpoint: rfc8291.endpoint,
      p256dh: decodeBase64Url(rfc8291.publicKey),
    },
    payload: "New message in msg",
    vapid: { ...vapid, subject: "mailto:push@example.com" },
    ttlSeconds: 300,
    nowSeconds: 1_700_000_000,
  });

  expect(request.endpoint).toBe(rfc8291.endpoint);
  expect(request.headers["Content-Encoding"]).toBe("aes128gcm");
  expect(request.headers["Content-Type"]).toBe("application/octet-stream");
  expect(request.headers.TTL).toBe("300");
  expect(decoder.decode(decryptWireBody(request.body, decodeBase64Url(rfc8291.receiverPrivateKey), decodeBase64Url(rfc8291.auth))))
    .toBe("New message in msg");

  const authorization = request.headers.Authorization;
  const [, jwt, publicKeyParameter] = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/u.exec(authorization) ?? [];
  expect(jwt).toBeDefined();
  expect(publicKeyParameter).toBe(encodeBase64Url(vapid.publicKey));
  const [encodedHeader, encodedClaims, encodedSignature] = jwt!.split(".");
  const header = JSON.parse(decoder.decode(decodeBase64Url(encodedHeader!))) as Record<string, unknown>;
  const claims = JSON.parse(decoder.decode(decodeBase64Url(encodedClaims!))) as Record<string, unknown>;
  const signature = decodeBase64Url(encodedSignature!);
  const publicJwk = {
    crv: "P-256",
    kty: "EC",
    x: encodeBase64Url(vapid.publicKey.subarray(1, 33)),
    y: encodeBase64Url(vapid.publicKey.subarray(33, 65)),
  };

  expect(header).toEqual({ typ: "JWT", alg: "ES256" });
  expect(claims).toEqual({ aud: "https://push.example.net", exp: 1_700_043_200, sub: "mailto:push@example.com" });
  expect(signature.byteLength).toBe(64);
  expect(
    verify(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      { key: createPublicKey({ key: publicJwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
      Buffer.from(signature),
    ),
  ).toBe(true);
});

test("fits the RFC 8291 maximum body and rejects payloads above its plaintext limit", async () => {
  const vapid = await makeVapidKeys();
  const subscription = {
    auth: decodeBase64Url(rfc8291.auth),
    endpoint: rfc8291.endpoint,
    p256dh: decodeBase64Url(rfc8291.publicKey),
  };
  const request = await createWebPushRequest({
    subscription,
    payload: new Uint8Array(MAX_WEB_PUSH_PAYLOAD_BYTES),
    vapid: { ...vapid, subject: "https://msg.example.com/contact" },
    ttlSeconds: 86400,
    nowSeconds: 1_700_000_000,
  });

  expect(request.body.byteLength).toBe(4096);
  await expect(
    createWebPushRequest({
      subscription,
      payload: new Uint8Array(MAX_WEB_PUSH_PAYLOAD_BYTES + 1),
      vapid: { ...vapid, subject: "https://msg.example.com/contact" },
      ttlSeconds: 86400,
      nowSeconds: 1_700_000_000,
    }),
  ).rejects.toThrow("payload exceeds");
});

test("uses a bounded caller-supplied TTL without extending provider retention", async () => {
  const vapid = await makeVapidKeys();
  const subscription = {
    auth: decodeBase64Url(rfc8291.auth),
    endpoint: rfc8291.endpoint,
    p256dh: decodeBase64Url(rfc8291.publicKey),
  };
  const request = await createWebPushRequest({
    subscription,
    payload: "New message in msg",
    vapid: { ...vapid, subject: "mailto:push@example.com" },
    ttlSeconds: 37,
    nowSeconds: 1_700_000_000,
  });
  expect(request.headers.TTL).toBe("37");
  const immediateRequest = await createWebPushRequest({
    subscription,
    payload: "New message in msg",
    vapid: { ...vapid, subject: "mailto:push@example.com" },
    ttlSeconds: 0,
    nowSeconds: 1_700_000_000,
  });
  expect(immediateRequest.headers.TTL).toBe("0");

  for (const ttlSeconds of [-1, 86401, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await expect(
      createWebPushRequest({
        subscription,
        payload: "x",
        vapid: { ...vapid, subject: "mailto:push@example.com" },
        ttlSeconds,
        nowSeconds: 1_700_000_000,
      }),
    ).rejects.toThrow("TTL must be an integer between 0 and 86400 seconds");
  }
});

test("rejects malformed subscriptions, non-HTTPS endpoints, and invalid contact URIs", async () => {
  const vapid = await makeVapidKeys();
  const validSubscription = {
    auth: decodeBase64Url(rfc8291.auth),
    endpoint: rfc8291.endpoint,
    p256dh: decodeBase64Url(rfc8291.publicKey),
  };
  const validVapid = { ...vapid, subject: "mailto:push@example.com" };

  await expect(
    createWebPushRequest({ subscription: { ...validSubscription, auth: new Uint8Array(15) }, payload: "x", vapid: validVapid, ttlSeconds: 86400 }),
  ).rejects.toThrow("authentication secret");
  await expect(
    createWebPushRequest({ subscription: { ...validSubscription, p256dh: new Uint8Array(64) }, payload: "x", vapid: validVapid, ttlSeconds: 86400 }),
  ).rejects.toThrow("uncompressed P-256 point");
  const invalidPoint = new Uint8Array(65);
  invalidPoint[0] = 0x04;
  await expect(
    createWebPushRequest({ subscription: { ...validSubscription, p256dh: invalidPoint }, payload: "x", vapid: validVapid, ttlSeconds: 86400 }),
  ).rejects.toThrow("not a valid P-256 point");
  await expect(
    createWebPushRequest({ subscription: validSubscription, payload: {} as Uint8Array, vapid: validVapid, ttlSeconds: 86400 }),
  ).rejects.toThrow("payload must be a byte array");
  await expect(
    createWebPushRequest({ subscription: { ...validSubscription, endpoint: "http://push.example.net/send" }, payload: "x", vapid: validVapid, ttlSeconds: 86400 }),
  ).rejects.toThrow("HTTPS URL");
  await expect(
    createWebPushRequest({ subscription: { ...validSubscription, endpoint: "https://user:pass@push.example.net/send" }, payload: "x", vapid: validVapid, ttlSeconds: 86400 }),
  ).rejects.toThrow("HTTPS URL");
  await expect(
    createWebPushRequest({ subscription: { ...validSubscription, endpoint: "https://push.example.net/send#" }, payload: "x", vapid: validVapid, ttlSeconds: 86400 }),
  ).rejects.toThrow("HTTPS URL");
  await expect(
    createWebPushRequest({ subscription: validSubscription, payload: "x", vapid: { ...vapid, subject: "javascript:alert(1)" }, ttlSeconds: 86400 }),
  ).rejects.toThrow("mailto: or https:");
});

test("rejects mismatched or malformed VAPID key material", async () => {
  const first = await makeVapidKeys();
  const second = await makeVapidKeys();
  const subscription = {
    auth: decodeBase64Url(rfc8291.auth),
    endpoint: rfc8291.endpoint,
    p256dh: decodeBase64Url(rfc8291.publicKey),
  };

  await expect(
    createWebPushRequest({ subscription, payload: "x", vapid: { ...first, publicKey: second.publicKey, subject: "mailto:push@example.com" }, ttlSeconds: 86400 }),
  ).rejects.toThrow(/invalid|do not match/u);
  await expect(
    createWebPushRequest({ subscription, payload: "x", vapid: { ...first, privateKey: new Uint8Array(31), subject: "mailto:push@example.com" }, ttlSeconds: 86400 }),
  ).rejects.toThrow("private key must be 32 bytes");
  await expect(
    createWebPushRequest({ subscription, payload: "x", vapid: { ...first, publicKey: new Uint8Array(65), subject: "mailto:push@example.com" }, ttlSeconds: 86400 }),
  ).rejects.toThrow("uncompressed P-256 point");
});

async function makeVapidKeys(): Promise<{ readonly publicKey: Uint8Array; readonly privateKey: Uint8Array }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const [publicKey, privateJwk] = await Promise.all([
    crypto.subtle.exportKey("raw", pair.publicKey),
    crypto.subtle.exportKey("jwk", pair.privateKey),
  ]);
  if (typeof privateJwk.d !== "string") throw new Error("The generated test key did not contain a private scalar.");
  return { publicKey: new Uint8Array(publicKey), privateKey: decodeBase64Url(privateJwk.d) };
}

function createOfficialWireBody(): Uint8Array {
  const header = new Uint8Array(86);
  header.set(decodeBase64Url(rfc8291.salt), 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = 65;
  header.set(decodeBase64Url(rfc8291.applicationServerPublicKey), 21);
  const ciphertext = decodeBase64Url(rfc8291.ciphertext.replaceAll(" ", ""));
  return new Uint8Array(Buffer.concat([Buffer.from(header), Buffer.from(ciphertext)]));
}

function decryptWireBody(body: Uint8Array, receiverPrivateKey: Uint8Array, authSecret: Uint8Array): Uint8Array {
  if (body.byteLength < 103 || body[20] !== 65) throw new Error("The encrypted Web Push body has an invalid header.");
  const recordSize = Buffer.from(body).readUInt32BE(16);
  if (recordSize !== 4096) throw new Error("The encrypted Web Push body has an unexpected record size.");

  const salt = Buffer.from(body.subarray(0, 16));
  const applicationServerPublicKey = Buffer.from(body.subarray(21, 86));
  const ciphertextAndTag = Buffer.from(body.subarray(86));
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(receiverPrivateKey));
  const sharedSecret = ecdh.computeSecret(applicationServerPublicKey);
  const keyInfo = Buffer.from("WebPush: info\0", "ascii");
  const userAgentPublicKey = derivePublicKey(receiverPrivateKey);
  const fullKeyInfo = Buffer.concat([keyInfo, userAgentPublicKey, applicationServerPublicKey]);
  const prkKey = hmacSha256(Buffer.from(authSecret), sharedSecret);
  const inputKeyMaterial = hkdfExpand(prkKey, fullKeyInfo, 32);
  const prk = hmacSha256(salt, inputKeyMaterial);
  const contentEncryptionKey = hkdfExpand(prk, Buffer.from("Content-Encoding: aes128gcm\0", "ascii"), 16);
  const nonce = hkdfExpand(prk, Buffer.from("Content-Encoding: nonce\0", "ascii"), 12);

  const authenticationTag = ciphertextAndTag.subarray(ciphertextAndTag.byteLength - 16);
  const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.byteLength - 16);
  const decipher = createDecipheriv("aes-128-gcm", contentEncryptionKey, nonce, { authTagLength: 16 });
  decipher.setAuthTag(authenticationTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (plaintext.at(-1) !== 0x02) throw new Error("The encrypted Web Push body has an invalid padding delimiter.");
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

function hkdfExpand(pseudorandomKey: Uint8Array, info: Uint8Array, length: number): Buffer {
  let previousBlock = Buffer.alloc(0);
  const output: Buffer[] = [];
  let outputLength = 0;
  for (let counter = 1; outputLength < length; counter += 1) {
    previousBlock = hmacSha256(pseudorandomKey, Buffer.concat([previousBlock, Buffer.from(info), Buffer.from([counter])]));
    output.push(previousBlock);
    outputLength += previousBlock.byteLength;
  }
  return Buffer.concat(output).subarray(0, length);
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
