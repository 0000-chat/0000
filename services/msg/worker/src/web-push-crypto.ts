export const MAX_WEB_PUSH_PAYLOAD_BYTES = 3993;

const WEB_PUSH_RECORD_SIZE = 4096;
const WEB_PUSH_BODY_LIMIT = 4096;
const VAPID_TOKEN_LIFETIME_SECONDS = 12 * 60 * 60;
const MAX_PUSH_TTL_SECONDS = 24 * 60 * 60;

const encoder = new TextEncoder();

export interface WebPushSubscriptionKeyMaterial {
  readonly endpoint: string;
  readonly p256dh: Uint8Array;
  readonly auth: Uint8Array;
}

export interface WebPushVapidKeyMaterial {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
  readonly subject: string;
}

export interface WebPushRequestInput {
  readonly subscription: WebPushSubscriptionKeyMaterial;
  readonly payload: string | Uint8Array;
  readonly vapid: WebPushVapidKeyMaterial;
  readonly ttlSeconds: number;
  readonly nowSeconds?: number;
}

export interface WebPushRequest {
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export async function createWebPushRequest(input: WebPushRequestInput): Promise<WebPushRequest> {
  if (typeof input !== "object" || input === null || typeof input.subscription !== "object" || input.subscription === null || typeof input.vapid !== "object" || input.vapid === null) {
    throw new Error("The Web Push request input is invalid.");
  }

  if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 0 || input.ttlSeconds > MAX_PUSH_TTL_SECONDS) {
    throw new Error("The Web Push TTL must be an integer between 0 and 86400 seconds.");
  }

  const endpoint = validateEndpoint(input.subscription.endpoint);
  const subject = validateSubject(input.vapid.subject);
  const payload = typeof input.payload === "string" ? encoder.encode(input.payload) : copyBytes(input.payload, "payload");
  if (payload.byteLength > MAX_WEB_PUSH_PAYLOAD_BYTES) {
    throw new Error("The Web Push payload exceeds the supported size limit.");
  }

  const userAgentPublicKeyBytes = copyP256Point(input.subscription.p256dh, "subscription public key");
  const authSecret = copyBytes(input.subscription.auth, "authentication secret");
  if (authSecret.byteLength !== 16) throw new Error("The Web Push authentication secret must be 16 bytes.");

  const vapidPublicKeyBytes = copyP256Point(input.vapid.publicKey, "VAPID public key");
  const vapidPrivateKeyBytes = copyBytes(input.vapid.privateKey, "VAPID private key");
  if (vapidPrivateKeyBytes.byteLength !== 32) throw new Error("The VAPID private key must be 32 bytes.");

  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0 || nowSeconds > Number.MAX_SAFE_INTEGER - VAPID_TOKEN_LIFETIME_SECONDS) {
    throw new Error("The VAPID token issue time is invalid.");
  }

  const vapidPublicKey = await importP256PublicKey(vapidPublicKeyBytes, "ECDSA");
  const vapidPrivateKey = await importVapidPrivateKey(vapidPublicKeyBytes, vapidPrivateKeyBytes);
  await verifyVapidKeyPair(vapidPrivateKey, vapidPublicKey);

  const userAgentPublicKey = await importP256PublicKey(userAgentPublicKeyBytes, "ECDH");
  const applicationServerKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const applicationServerPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", applicationServerKeyPair.publicKey));
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: userAgentPublicKey }, applicationServerKeyPair.privateKey, 256),
  );

  const authPrk = await hkdf(
    ecdhSecret,
    authSecret,
    concat(encoder.encode("WebPush: info"), Uint8Array.of(0), userAgentPublicKeyBytes, applicationServerPublicKey),
    32,
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentEncryptionKey = await hkdf(authPrk, salt, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(authPrk, salt, encoder.encode("Content-Encoding: nonce\0"), 12);

  const encryptionKey = await crypto.subtle.importKey("raw", byteBuffer(contentEncryptionKey), { name: "AES-GCM" }, false, ["encrypt"]);
  const plaintext = concat(payload, Uint8Array.of(0x02));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: byteBuffer(nonce), tagLength: 128 },
      encryptionKey,
      byteBuffer(plaintext),
    ),
  );

  const body = createEncryptedBody(salt, applicationServerPublicKey, ciphertext);
  if (body.byteLength > WEB_PUSH_BODY_LIMIT) throw new Error("The encrypted Web Push body exceeds the supported size limit.");

  const authorization = await createVapidAuthorization(
    endpoint.origin,
    subject,
    nowSeconds,
    vapidPublicKeyBytes,
    vapidPrivateKey,
  );

  return {
    endpoint: input.subscription.endpoint,
    headers: {
      Authorization: authorization,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(input.ttlSeconds),
    },
    body,
  };
}

function validateEndpoint(value: string): URL {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) throw new Error("The Web Push endpoint is invalid.");

  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("The Web Push endpoint is invalid.");
  }

  if (endpoint.protocol !== "https:" || endpoint.hostname.length === 0 || endpoint.username || endpoint.password || value.includes("#")) {
    throw new Error("The Web Push endpoint must be an HTTPS URL without credentials or a fragment.");
  }
  return endpoint;
}

function validateSubject(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 320 || value.trim() !== value || /[\r\n]/u.test(value)) {
    throw new Error("The VAPID subject must be a contact URI.");
  }

  let subject: URL;
  try {
    subject = new URL(value);
  } catch {
    throw new Error("The VAPID subject must be a contact URI.");
  }

  if (subject.protocol === "mailto:" && subject.pathname.length > 0) return value;
  if (subject.protocol === "https:" && subject.hostname.length > 0 && !subject.username && !subject.password) return value;
  throw new Error("The VAPID subject must use mailto: or https:.");
}

function copyP256Point(value: Uint8Array, name: string): Uint8Array {
  const copy = copyBytes(value, name);
  if (copy.byteLength !== 65 || copy[0] !== 0x04) throw new Error(`The Web Push ${name} must be an uncompressed P-256 point.`);
  return copy;
}

function copyBytes(value: Uint8Array, name: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`The Web Push ${name} must be a byte array.`);
  return value.slice();
}

async function importP256PublicKey(bytes: Uint8Array, algorithm: "ECDH" | "ECDSA"): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      "raw",
      byteBuffer(bytes),
      { name: algorithm, namedCurve: "P-256" },
      false,
      algorithm === "ECDH" ? [] : ["verify"],
    );
  } catch {
    throw new Error("A Web Push public key is not a valid P-256 point.");
  }
}

async function importVapidPrivateKey(publicKey: Uint8Array, privateKey: Uint8Array): Promise<CryptoKey> {
  try {
    const jwk: JsonWebKey = {
      crv: "P-256",
      d: encodeBase64Url(privateKey),
      kty: "EC",
      x: encodeBase64Url(publicKey.subarray(1, 33)),
      y: encodeBase64Url(publicKey.subarray(33, 65)),
    };
    return await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  } catch {
    throw new Error("The VAPID key material is invalid.");
  }
}

async function verifyVapidKeyPair(privateKey: CryptoKey, publicKey: CryptoKey): Promise<void> {
  const challenge = encoder.encode("msg-web-push-vapid-key-check");
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, byteBuffer(challenge));
  const matches = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    signature,
    byteBuffer(challenge),
  );
  if (!matches) throw new Error("The VAPID public and private keys do not match.");
}

async function createVapidAuthorization(
  audience: string,
  subject: string,
  nowSeconds: number,
  publicKeyBytes: Uint8Array,
  privateKey: CryptoKey,
): Promise<string> {
  const header = encodeBase64Url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = encodeBase64Url(
    encoder.encode(
      JSON.stringify({ aud: audience, exp: nowSeconds + VAPID_TOKEN_LIFETIME_SECONDS, sub: subject }),
    ),
  );
  const signingInput = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    byteBuffer(encoder.encode(signingInput)),
  );
  return `vapid t=${signingInput}.${encodeBase64Url(new Uint8Array(signature))}, k=${encodeBase64Url(publicKeyBytes)}`;
}

async function hkdf(inputKeyMaterial: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", byteBuffer(inputKeyMaterial), "HKDF", false, ["deriveBits"]);
  const output = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: byteBuffer(salt), info: byteBuffer(info) },
    key,
    length * 8,
  );
  return new Uint8Array(output);
}

function createEncryptedBody(salt: Uint8Array, applicationServerPublicKey: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const header = new Uint8Array(86);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, WEB_PUSH_RECORD_SIZE, false);
  header[20] = applicationServerPublicKey.byteLength;
  header.set(applicationServerPublicKey, 21);
  return concat(header, ciphertext);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function byteBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
