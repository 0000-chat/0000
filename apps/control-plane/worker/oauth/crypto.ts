const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function base64url(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += BASE64URL[first >> 2] ?? "";
    output += BASE64URL[((first & 3) << 4) | ((second ?? 0) >> 4)] ?? "";
    if (second !== undefined) {
      output += BASE64URL[((second & 15) << 2) | ((third ?? 0) >> 6)] ?? "";
    }
    if (third !== undefined) output += BASE64URL[third & 63] ?? "";
  }
  return output;
}

export function randomBase64url(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export function randomIdentifier(prefix: string, byteLength = 18): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function sha256Base64url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return base64url(new Uint8Array(digest));
}

export async function constantTimeEqual(
  left: string,
  right: string,
): Promise<boolean> {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export function isoNow(clock: () => Date = () => new Date()): string {
  return clock().toISOString();
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptVerifier(
  verifier: string,
  secret: string,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(secret),
    new TextEncoder().encode(verifier),
  );
  return { ciphertext: base64url(new Uint8Array(ciphertext)), iv: base64url(iv) };
}

const decodeBase64url = (value: string): Uint8Array => {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export async function decryptVerifier(
  ciphertext: string,
  iv: string,
  secret: string,
): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decodeBase64url(iv) as unknown as BufferSource,
    },
    await encryptionKey(secret),
    decodeBase64url(ciphertext) as unknown as BufferSource,
  );
  return new TextDecoder().decode(plain);
}
