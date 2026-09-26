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
export const MAX_READ_MESSAGE_BYTES = 128 * 1024;
export const DEFAULT_READ_LIMIT = 20;
export const MAX_READ_LIMIT = 100;
const maxIdentityChars = 80;
const maxIdentityBytes = 320;
const maxClientMessageIdChars = 128;
const maxClientMessageIdBytes = 512;
const recordOverheadBytes = 64;
const semanticTypes = new Set(["question", "proposal", "answer", "result", "status", "decision", "note", "message"]);
const ABSOLUTE_ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u;

export const RETENTION_MODE = "temporary" as const;
export const RETENTION_POLICY = "sliding_inactivity" as const;

export interface RetentionMetadata {
  readonly expires_at: string;
  readonly inactivity_window_ms: number;
  readonly mode: typeof RETENTION_MODE;
  readonly policy: typeof RETENTION_POLICY;
}

export interface RetentionExtensionInput {
  readonly client_retry_id: string;
  readonly expires_at: string;
  readonly expires_at_ms: number;
}

export interface MessageInput {
  readonly author: string;
  readonly client?: string;
  readonly client_message_id?: string;
  readonly content: string;
  readonly display_name: string;
  readonly identity_verified: false;
  /** Transport-only credential; the room strips it before storing or publishing a message. */
  readonly name_password?: string;
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

/** Reads the optional posting precondition without adding it to the stored message payload. */
export function parseBasedOnSequence(body: RequestBody): number | undefined {
  if (body.kind === "raw" || !isObject(body.value)) return undefined;
  return validateBasedOnSequence(body.value.based_on_sequence);
}

export function validateBasedOnSequence(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidMessage("The based_on_sequence field must be a nonnegative safe integer.");
  }
  return value;
}

export function validateBasedOnSequenceQuery(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw invalidMessage("The based_on_sequence query field must be a nonnegative safe integer.");
  }
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence)) {
    throw invalidMessage("The based_on_sequence query field must be a nonnegative safe integer.");
  }
  return sequence;
}

export function validateCursor(value: string | null): number {
  if (value === null || value === "") return 0;
  return validateNonnegativeInteger(value, "after");
}

export function validateBoundedCursor(value: string | null, field: "after" | "through"): number {
  if (value === null) return 0;
  return validateNonnegativeInteger(value, field);
}

export function validateReadLimit(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw invalidMessage("The limit must be a positive safe integer no greater than 100.");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > MAX_READ_LIMIT) {
    throw invalidMessage("The limit must be a positive safe integer no greater than 100.");
  }
  return limit;
}

export function validateThrough(value: string | null): number | undefined {
  if (value === null) return undefined;
  return validateBoundedCursor(value, "through");
}

function validateNonnegativeInteger(value: string | null, field: "after" | "through"): number {
  if (value === null || value === "") {
    throw invalidMessage(`The ${field} cursor must be a nonnegative sequence.`);
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw invalidMessage(`The ${field} cursor must be a nonnegative sequence.`);
  }
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) {
    throw invalidMessage(`The ${field} cursor must be a nonnegative safe integer.`);
  }
  return cursor;
}

export interface RoomEtagOptions {
  readonly inactivityWindowMs?: number;
  readonly mode?: "bounded" | "unbounded";
  readonly retentionMode?: string;
  readonly retentionPolicy?: string;
  readonly coordinationCursor?: number;
  readonly expiresAt?: string;
  readonly limit?: number;
  readonly publishedRevision?: number;
  readonly through?: number;
}

export function roomEtag(latestSequence: number, after: number, options?: RoomEtagOptions): string {
  if (options === undefined) return `W/"room-${latestSequence}-after-${after}"`;
  const selectors = [
    `after=${after}`,
    `coordination=${options.coordinationCursor ?? ""}`,
    `limit=${options.mode === "unbounded" ? "all" : options.limit ?? DEFAULT_READ_LIMIT}`,
    `published=${options.publishedRevision ?? ""}`,
    `retention=${options.retentionMode ?? ""}-${options.retentionPolicy ?? ""}-${options.inactivityWindowMs ?? ""}`,
    `through=${options.mode === "unbounded" ? "all" : options.through ?? latestSequence}`,
    `expires=${options.expiresAt ?? ""}`,
  ].join("&");
  return `W/"room-${latestSequence}-${selectors}"`;
}

export function coordinationEtag(cursor: number, publishedRevision: number, expiresAt: string): string {
  return `W/"coordination-${cursor}-published-${publishedRevision}-expires-${expiresAt}"`;
}

export function validateIdempotencyKey(value: string): string {
  validateBoundedString(value, "Idempotency-Key", maxClientMessageIdChars, maxClientMessageIdBytes);
  if (!value) throw invalidMessage("The Idempotency-Key header must not be empty.");
  return value;
}

export function validateRequestId(value: string): string {
  validateBoundedString(value, "request_id", maxClientMessageIdChars, maxClientMessageIdBytes);
  if (!value) throw invalidMessage("The request_id field is required.");
  return value;
}

/** Parse the private retention mutation and normalize an absolute instant. */
export function parseRetentionExtension(value: unknown): RetentionExtensionInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidMessage("The retention extension must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "client_retry_id" && key !== "expires_at") || Object.keys(record).length !== 2) {
    throw invalidMessage("The retention extension must contain only client_retry_id and expires_at.");
  }
  if (typeof record.client_retry_id !== "string") throw invalidMessage("The client_retry_id field must be a string.");
  const clientRetryId = validateRequestId(record.client_retry_id);
  if (typeof record.expires_at !== "string") {
    throw invalidMessage("The expires_at field must be an absolute ISO timestamp.");
  }
  const match = ABSOLUTE_ISO_TIMESTAMP.exec(record.expires_at);
  if (!match) throw invalidMessage("The expires_at field must be an absolute ISO timestamp.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[8]!;
  const daysInMonth = month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  const offsetHours = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const offsetMinutes = zone === "Z" ? 0 : Number(zone.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59) {
    throw invalidMessage("The expires_at field must be a valid absolute ISO timestamp.");
  }
  const expiresAtMs = Date.parse(record.expires_at);
  if (!Number.isSafeInteger(expiresAtMs)) throw invalidMessage("The expires_at field must be a valid absolute ISO timestamp.");
  return { client_retry_id: clientRetryId, expires_at: new Date(expiresAtMs).toISOString(), expires_at_ms: expiresAtMs };
}

export function retentionMetadata(expiresAt: number | string, inactivityWindowMs: number): RetentionMetadata {
  return {
    expires_at: typeof expiresAt === "number" ? new Date(expiresAt).toISOString() : expiresAt,
    inactivity_window_ms: inactivityWindowMs,
    mode: RETENTION_MODE,
    policy: RETENTION_POLICY,
  };
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
  const author = optionalString(value, "author");
  if (author === undefined) throw invalidMessage("The self-declared author is required.");
  const displayName = optionalString(value, "display_name") ?? author;
  const namePassword = optionalString(value, "name_password");
  const semanticType = optionalString(value, "semantic_type") ?? "message";
  const client = optionalString(value, "client");
  const replyTo = optionalPositiveSafeInteger(value, "reply_to");
  const clientMessageId = optionalString(value, "client_message_id");
  if (!content) throw invalidMessage("The message content is required.");
  if (!author) throw invalidMessage("The self-declared author is required.");
  if (!displayName) throw invalidMessage("The display_name field is required.");
  if (namePassword !== undefined && namePassword.length === 0) throw invalidMessage("The name_password field must be a nonempty string.");
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
    ...(namePassword === undefined ? {} : { name_password: namePassword }),
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
