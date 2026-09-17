import { ERROR_CODES, ProtocolError } from "./errors";
import type { JsonObject, JsonValue, RequestBody } from "./protocol";

export const ROOM_LIMITS = {
  displayNameChars: 80,
  inactivityTtlMs: 7 * 24 * 60 * 60 * 1000,
  maxMessages: 10_000,
  maxMessageBytes: 64 * 1024,
  maxRoomBytes: 10 * 1024 * 1024,
  maxSockets: 50,
  tombstoneTtlMs: 24 * 60 * 60 * 1000,
} as const;

/** Permits JSON field overhead while the normalized content stays at 64 KiB. */
export const MAX_ROOM_REQUEST_BYTES = ROOM_LIMITS.maxMessageBytes + 8 * 1024;
const maxIdentityChars = 80;
const maxIdentityBytes = 320;
const maxClientMessageIdChars = 128;
const maxClientMessageIdBytes = 512;
const recordOverheadBytes = 64;
const semanticTypes = new Set(["question", "proposal", "answer", "result", "status", "decision", "note", "message"]);

export interface MessageInput {
  readonly author: string;
  readonly client?: string;
  readonly client_message_id?: string;
  readonly content: string;
  readonly display_name: string;
  readonly identity_verified: false;
  readonly reply_to?: string;
  readonly semantic_type: string;
}

export function parseMessageInput(body: RequestBody): MessageInput {
  if (body.kind === "raw") {
    return messageInput({ content: body.value });
  }
  if (!isObject(body.value)) throw invalidMessage("The message body must be an object.");
  return messageInput(body.value);
}

export function validateCursor(value: string | null): number {
  if (value === null || value === "") return 0;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw invalidMessage("The after cursor must be a nonnegative sequence.");
  }
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) {
    throw invalidMessage("The after cursor must be a nonnegative sequence.");
  }
  return cursor;
}

export function roomEtag(latestSequence: number, after: number): string {
  return `W/"room-${latestSequence}-after-${after}"`;
}

export function validateIdempotencyKey(value: string): string {
  validateBoundedString(value, "Idempotency-Key", maxClientMessageIdChars, maxClientMessageIdBytes);
  if (!value) throw invalidMessage("The Idempotency-Key header must not be empty.");
  return value;
}

export function messageStorageBytes(input: MessageInput, idempotencyKey?: string, generatedId?: string): number {
  return recordOverheadBytes + [input.author, input.client, input.client_message_id, input.content, input.display_name, input.reply_to, input.semantic_type, idempotencyKey, generatedId]
    .filter((value): value is string => typeof value === "string")
    .reduce((total, value) => total + byteLength(value), 0);
}

export function compareCapabilities(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

export async function hashCapability(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export function randomCapability(randomValues: (values: Uint8Array) => Uint8Array = secureRandomValues): string {
  return bytesToBase64Url(randomValues(new Uint8Array(32)));
}

function secureRandomValues(values: Uint8Array): Uint8Array {
  return crypto.getRandomValues(values as Uint8Array<ArrayBuffer>) as Uint8Array;
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function messageInput(value: JsonObject): MessageInput {
  const content = stringField(value, "content");
  const author = optionalString(value, "author") ?? "anonymous";
  const displayName = optionalString(value, "display_name") ?? author;
  const semanticType = optionalString(value, "semantic_type") ?? "message";
  const client = optionalString(value, "client");
  const replyTo = optionalPositiveSafeInteger(value, "reply_to");
  const clientMessageId = optionalString(value, "client_message_id");
  if (!content) throw invalidMessage("The message content is required.");
  if (!author) throw invalidMessage("The self-declared author is required.");
  validateBoundedString(author, "author", maxIdentityChars, maxIdentityBytes);
  validateBoundedString(displayName, "display_name", maxIdentityChars, maxIdentityBytes);
  if (client) validateBoundedString(client, "client", maxIdentityChars, maxIdentityBytes);
  if (clientMessageId) validateBoundedString(clientMessageId, "client_message_id", maxClientMessageIdChars, maxClientMessageIdBytes);
  if (!semanticTypes.has(semanticType)) throw invalidMessage("The semantic_type field is not supported.");
  if (byteLength(content) > ROOM_LIMITS.maxMessageBytes) {
    throw new ProtocolError(ERROR_CODES.bodyTooLarge, "The message is too large.", 413);
  }
  return {
    author,
    ...(client ? { client } : {}),
    ...(clientMessageId ? { client_message_id: clientMessageId } : {}),
    content,
    display_name: displayName,
    identity_verified: false,
    ...(replyTo ? { reply_to: replyTo } : {}),
    semantic_type: semanticType,
  };
}

function validateBoundedString(value: string, field: string, maxChars: number, maxBytes: number): void {
  if (Array.from(value).length > maxChars) throw invalidMessage(`The ${field} field is too long.`);
  if (byteLength(value) > maxBytes) throw new ProtocolError(ERROR_CODES.bodyTooLarge, `The ${field} field is too large.`, 413);
}

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: JsonObject, field: string): string | undefined {
  const candidate = value[field];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string") throw invalidMessage(`The ${field} field must be a string.`);
  return candidate;
}

function optionalPositiveSafeInteger(value: JsonObject, field: string): string | undefined {
  const candidate = value[field];
  if (candidate === undefined) return undefined;
  const normalized = typeof candidate === "number" ? String(candidate) : candidate;
  if (typeof normalized !== "string" || !/^[1-9][0-9]*$/u.test(normalized) || !Number.isSafeInteger(Number(normalized))) {
    throw invalidMessage(`The ${field} field must be a positive safe integer.`);
  }
  return normalized;
}

function stringField(value: JsonObject, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string") throw invalidMessage(`The ${field} field must be a string.`);
  return candidate;
}

function invalidMessage(message: string): ProtocolError {
  return new ProtocolError(ERROR_CODES.invalidBody, message, 400);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
