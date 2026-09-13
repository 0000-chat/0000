import {
  ConversationCursorSchema,
  MAX_PROJECTION_CURSOR_CHARS,
  MessageCursorSchema,
  type ConversationCursor,
  type MessageCursor,
} from "@communicator/contracts";
import { canonicalJsonStringify } from "../archive/canonical-json";
import { isProjectionError, projectionError } from "./errors";

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export type ConversationCursorContext = {
  readonly tenant_id: string;
  readonly identity_id: string;
  readonly connection_id: string | null;
  readonly generation: number;
};

export type MessageCursorContext = {
  readonly tenant_id: string;
  readonly identity_id: string;
  readonly conversation_id: string;
  readonly generation: number;
};

const encodeBase64Url = (bytes: Uint8Array): string => {
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const second = hasSecond ? (bytes[index + 1] ?? 0) : 0;
    const third = hasThird ? (bytes[index + 2] ?? 0) : 0;
    result += BASE64URL_ALPHABET[first >> 2];
    result += BASE64URL_ALPHABET[((first & 0x03) << 4) | (second >> 4)];
    if (hasSecond) {
      result += BASE64URL_ALPHABET[((second & 0x0f) << 2) | (third >> 6)];
    }
    if (hasThird) result += BASE64URL_ALPHABET[third & 0x3f];
  }
  return result;
};

const decodeBase64Url = (value: string): Uint8Array => {
  if (
    value.length === 0 ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw projectionError("projection_invalid");
  }

  const output: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of value) {
    const digit = BASE64URL_ALPHABET.indexOf(character);
    if (digit < 0) throw projectionError("projection_invalid");
    buffer = (buffer << 6) | digit;
    bits += 6;
    while (bits >= 8) {
      bits -= 8;
      output.push((buffer >> bits) & 0xff);
      buffer = bits === 0 ? 0 : buffer & ((1 << bits) - 1);
    }
  }

  // A non-zero remainder is an alternate representation of the same bytes,
  // and is never accepted as a canonical base64url cursor.
  if (bits > 0 && buffer !== 0) {
    throw projectionError("projection_invalid");
  }
  return new Uint8Array(output);
};

const skipJsonWhitespace = (value: string, offset: number): number => {
  let current = offset;
  while (
    current < value.length &&
    (value[current] === " " ||
      value[current] === "\n" ||
      value[current] === "\r" ||
      value[current] === "\t")
  ) {
    current += 1;
  }
  return current;
};

/**
 * JSON.parse accepts duplicate object members and keeps only the last one.
 * Cursors are a signed canonical representation, so reject duplicates before
 * parsing rather than allowing an ambiguous spelling through re-encoding.
 */
const containsDuplicateObjectKey = (json: string): boolean => {
  let offset = 0;
  let duplicate = false;

  const parseString = (): string | undefined => {
    if (json[offset] !== '"') return undefined;
    const start = offset;
    offset += 1;
    while (offset < json.length) {
      const character = json[offset];
      if (character === "\\") {
        offset += 1;
        if (offset >= json.length) return undefined;
        if (json[offset] === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(json.slice(offset + 1, offset + 5))) {
            return undefined;
          }
          offset += 5;
        } else {
          offset += 1;
        }
        continue;
      }
      if (character === '"') {
        offset += 1;
        try {
          return JSON.parse(json.slice(start, offset)) as string;
        } catch {
          return undefined;
        }
      }
      if (character !== undefined && character < " ") return undefined;
      offset += 1;
    }
    return undefined;
  };

  const parseValue = (): boolean => {
    offset = skipJsonWhitespace(json, offset);
    const character = json[offset];
    if (character === '"') return parseString() !== undefined;
    if (character === "{") {
      offset += 1;
      offset = skipJsonWhitespace(json, offset);
      if (json[offset] === "}") {
        offset += 1;
        return true;
      }
      const keys = new Set<string>();
      while (offset < json.length) {
        offset = skipJsonWhitespace(json, offset);
        const key = parseString();
        if (key === undefined) return false;
        if (keys.has(key)) {
          duplicate = true;
          return false;
        }
        keys.add(key);
        offset = skipJsonWhitespace(json, offset);
        if (json[offset] !== ":") return false;
        offset += 1;
        if (!parseValue()) return false;
        offset = skipJsonWhitespace(json, offset);
        if (json[offset] === "}") {
          offset += 1;
          return true;
        }
        if (json[offset] !== ",") return false;
        offset += 1;
      }
      return false;
    }
    if (character === "[") {
      offset += 1;
      offset = skipJsonWhitespace(json, offset);
      if (json[offset] === "]") {
        offset += 1;
        return true;
      }
      while (offset < json.length) {
        if (!parseValue()) return false;
        offset = skipJsonWhitespace(json, offset);
        if (json[offset] === "]") {
          offset += 1;
          return true;
        }
        if (json[offset] !== ",") return false;
        offset += 1;
      }
      return false;
    }
    for (const literal of ["true", "false", "null"]) {
      if (json.startsWith(literal, offset)) {
        offset += literal.length;
        return true;
      }
    }
    if (
      character === "-" ||
      (character !== undefined && /[0-9]/.test(character))
    ) {
      const start = offset;
      while (
        offset < json.length &&
        json[offset] !== "," &&
        json[offset] !== "]" &&
        json[offset] !== "}" &&
        !/\s/.test(json[offset] ?? "")
      ) {
        offset += 1;
      }
      return offset > start;
    }
    return false;
  };

  parseValue();
  return duplicate;
};

const payloadBytes = (
  payload: unknown,
  schema: typeof ConversationCursorSchema | typeof MessageCursorSchema,
): Uint8Array => {
  let parsed: { success: true; data: unknown } | { success: false };
  try {
    parsed = schema.safeParse(payload) as typeof parsed;
  } catch (error) {
    throw projectionError("projection_invalid", error);
  }
  if (!parsed.success) throw projectionError("projection_invalid");
  try {
    return new TextEncoder().encode(canonicalJsonStringify(parsed.data));
  } catch (error) {
    throw projectionError("projection_invalid", error);
  }
};

const encodePayload = (
  payload: unknown,
  schema: typeof ConversationCursorSchema | typeof MessageCursorSchema,
): string => {
  const encoded = encodeBase64Url(payloadBytes(payload, schema));
  if (encoded.length > MAX_PROJECTION_CURSOR_CHARS) {
    throw projectionError("projection_invalid");
  }
  return encoded;
};

const decodePayload = <T>(
  cursor: unknown,
  schema: typeof ConversationCursorSchema | typeof MessageCursorSchema,
): T => {
  if (typeof cursor !== "string" || cursor.length === 0) {
    throw projectionError("projection_invalid");
  }
  if (cursor.length > MAX_PROJECTION_CURSOR_CHARS) {
    throw projectionError("projection_invalid");
  }

  const bytes = decodeBase64Url(cursor);
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw projectionError("projection_invalid", error);
  }
  try {
    if (containsDuplicateObjectKey(json)) {
      throw projectionError("projection_invalid");
    }
  } catch (error) {
    if (isProjectionError(error)) throw error;
    throw projectionError("projection_invalid", error);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json) as unknown;
  } catch (error) {
    throw projectionError("projection_invalid", error);
  }
  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success) throw projectionError("projection_invalid");

  let canonicalCursor: string;
  try {
    canonicalCursor = encodePayload(parsed.data, schema);
  } catch (error) {
    if (isProjectionError(error)) throw error;
    throw projectionError("projection_invalid", error);
  }
  if (canonicalCursor !== cursor) {
    throw projectionError("projection_invalid");
  }
  return parsed.data as T;
};

const validateConversationContext = (
  cursor: ConversationCursor,
  expected: ConversationCursorContext,
): void => {
  if (cursor.tenant_id !== expected.tenant_id) {
    throw projectionError("projection_tenant_mismatch");
  }
  if (
    cursor.identity_id !== expected.identity_id ||
    cursor.connection_id !== expected.connection_id ||
    cursor.generation !== expected.generation
  ) {
    throw projectionError("projection_conflict");
  }
};

const validateMessageContext = (
  cursor: MessageCursor,
  expected: MessageCursorContext,
): void => {
  if (cursor.tenant_id !== expected.tenant_id) {
    throw projectionError("projection_tenant_mismatch");
  }
  if (
    cursor.identity_id !== expected.identity_id ||
    cursor.conversation_id !== expected.conversation_id ||
    cursor.generation !== expected.generation
  ) {
    throw projectionError("projection_conflict");
  }
};

export const encodeConversationCursor = (payload: unknown): string =>
  encodePayload(payload, ConversationCursorSchema);

export function decodeConversationCursor(
  cursor: unknown,
  expected?: ConversationCursorContext,
): ConversationCursor;
export function decodeConversationCursor(
  cursor: unknown,
  expectedTenantId?: string,
  expectedIdentityId?: string,
  expectedConnectionId?: string | null,
  expectedGeneration?: number,
): ConversationCursor;
export function decodeConversationCursor(
  cursor: unknown,
  expectedOrTenant?: ConversationCursorContext | string,
  expectedIdentityId?: string,
  expectedConnectionId?: string | null,
  expectedGeneration?: number,
): ConversationCursor {
  const parsed = decodePayload<ConversationCursor>(
    cursor,
    ConversationCursorSchema,
  );
  if (expectedOrTenant !== undefined) {
    const expected: ConversationCursorContext =
      typeof expectedOrTenant === "string"
        ? {
            tenant_id: expectedOrTenant,
            identity_id: expectedIdentityId ?? "",
            connection_id: expectedConnectionId ?? null,
            generation: expectedGeneration ?? 0,
          }
        : expectedOrTenant;
    validateConversationContext(parsed, expected);
  }
  return parsed;
}

export const encodeMessageCursor = (payload: unknown): string =>
  encodePayload(payload, MessageCursorSchema);

export function decodeMessageCursor(
  cursor: unknown,
  expected?: MessageCursorContext,
): MessageCursor;
export function decodeMessageCursor(
  cursor: unknown,
  expectedTenantId?: string,
  expectedIdentityId?: string,
  expectedConversationId?: string,
  expectedGeneration?: number,
): MessageCursor;
export function decodeMessageCursor(
  cursor: unknown,
  expectedOrTenant?: MessageCursorContext | string,
  expectedIdentityId?: string,
  expectedConversationId?: string,
  expectedGeneration?: number,
): MessageCursor {
  const parsed = decodePayload<MessageCursor>(cursor, MessageCursorSchema);
  if (expectedOrTenant !== undefined) {
    const expected: MessageCursorContext =
      typeof expectedOrTenant === "string"
        ? {
            tenant_id: expectedOrTenant,
            identity_id: expectedIdentityId ?? "",
            conversation_id: expectedConversationId ?? "",
            generation: expectedGeneration ?? 0,
          }
        : expectedOrTenant;
    validateMessageContext(parsed, expected);
  }
  return parsed;
}
