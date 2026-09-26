import { normalizeWebhookUrl } from "./webhooks";

export interface ValidPushSubscription {
  readonly auth: string;
  readonly endpoint: string;
  readonly p256dh: string;
}

const browserIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parsePushBrowserId(value: string | null): string | undefined {
  return value !== null && browserIdPattern.test(value) ? value.toLowerCase() : undefined;
}

/** Parses untrusted PushSubscription JSON at the Worker HTTP boundary. */
export async function parsePushSubscription(value: unknown): Promise<ValidPushSubscription | undefined> {
  if (!isRecord(value) || !Object.hasOwn(value, "endpoint") || !Object.hasOwn(value, "keys")
    || Object.keys(value).some((key) => key !== "endpoint" && key !== "keys" && key !== "expirationTime")) {
    return undefined;
  }
  if (Object.hasOwn(value, "expirationTime") && value.expirationTime !== null
    && (typeof value.expirationTime !== "number" || !Number.isSafeInteger(value.expirationTime) || value.expirationTime < 0)) return undefined;
  const keys = value.keys;
  if (!isRecord(keys) || Object.keys(keys).length !== 2 || typeof keys.auth !== "string" || typeof keys.p256dh !== "string") {
    return undefined;
  }
  const endpoint = normalizeWebhookUrl(value.endpoint);
  if (!endpoint) return undefined;
  const parsedEndpoint = new URL(endpoint);
  if (parsedEndpoint.username || parsedEndpoint.password) return undefined;

  const auth = decodeCanonicalBase64Url(keys.auth, 16);
  const p256dh = decodeCanonicalBase64Url(keys.p256dh, 65);
  if (!auth || !p256dh || p256dh[0] !== 0x04) return undefined;
  try {
    await crypto.subtle.importKey("raw", byteBuffer(p256dh), { name: "ECDH", namedCurve: "P-256" }, false, []);
  } catch {
    return undefined;
  }
  return { auth: keys.auth, endpoint, p256dh: keys.p256dh };
}

function decodeCanonicalBase64Url(value: string, expectedBytes: number): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(base64 + "=".repeat((4 - base64.length % 4) % 4)), (character) => character.charCodeAt(0));
    return bytes.byteLength === expectedBytes && encodeBase64Url(bytes) === value ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function byteBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
