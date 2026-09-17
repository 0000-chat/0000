interface EncryptedEnvelope {
  readonly ciphertext: string;
  readonly iv: string;
  readonly v: 1;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Encrypts D1-only records. AAD binds ciphertext to its record type and row key. */
export async function encryptOperationRecord(
  encodedKey: string,
  recordType: string,
  primaryKey: string,
  value: unknown,
): Promise<string> {
  const key = await importKey(encodedKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt(
    { additionalData: byteBuffer(aad(recordType, primaryKey)), iv: byteBuffer(iv), name: "AES-GCM" },
    key,
    byteBuffer(plaintext),
  );
  return JSON.stringify({ ciphertext: encode(new Uint8Array(ciphertext)), iv: encode(iv), v: 1 } satisfies EncryptedEnvelope);
}

export async function decryptOperationRecord<T>(
  encodedKey: string,
  recordType: string,
  primaryKey: string,
  serialized: string,
): Promise<T> {
  const envelope = parseEnvelope(serialized);
  const plaintext = await crypto.subtle.decrypt(
    { additionalData: byteBuffer(aad(recordType, primaryKey)), iv: byteBuffer(decode(envelope.iv)), name: "AES-GCM" },
    await importKey(encodedKey),
    byteBuffer(decode(envelope.ciphertext)),
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}

function aad(recordType: string, primaryKey: string): Uint8Array {
  return encoder.encode(`msg.0000.chat/operations/v1/${recordType}/${primaryKey}`);
}

async function importKey(encodedKey: string): Promise<CryptoKey> {
  const bytes = decode(encodedKey);
  if (bytes.byteLength !== 32) throw new Error("MSG_DATA_ENCRYPTION_KEY_V1 must be a 32-byte base64url value.");
  return crypto.subtle.importKey("raw", byteBuffer(bytes), { name: "AES-GCM" }, false, ["decrypt", "encrypt"]);
}

function parseEnvelope(value: string): EncryptedEnvelope {
  const parsed = JSON.parse(value) as Partial<EncryptedEnvelope>;
  if (parsed.v !== 1 || typeof parsed.iv !== "string" || typeof parsed.ciphertext !== "string") {
    throw new Error("The encrypted operation record is invalid.");
  }
  const iv = decode(parsed.iv);
  if (iv.byteLength !== 12) throw new Error("The encrypted operation record has an invalid IV.");
  return { ciphertext: parsed.ciphertext, iv: parsed.iv, v: 1 };
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new Error("The encoded key is invalid.");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function byteBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
