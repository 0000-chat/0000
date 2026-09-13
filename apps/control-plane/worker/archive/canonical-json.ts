import {
  CanonicalEventEnvelopeSchema,
  MAX_CANONICAL_JSON_COLLECTION_ENTRIES,
  MAX_CANONICAL_JSON_DEPTH,
  MAX_CANONICAL_JSON_KEY_CHARS,
  MAX_CANONICAL_JSON_NODES,
  MAX_CANONICAL_JSON_STRING_CHARS,
  type CanonicalJsonValue,
} from "@communicator/contracts";
import { ArchiveError, archiveError } from "./errors";

export { ArchiveError } from "./errors";

const PROTOTYPE_SENSITIVE_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

const isArrayIndexKey = (key: string, length: number): boolean => {
  const index = Number(key);
  return (
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
};

type SnapshotContext = {
  active: WeakSet<object>;
  copies: WeakMap<object, CanonicalJsonValue>;
  nodes: number;
};

/**
 * Validate and snapshot a JSON value in one descriptor-only observation.
 * The serializer consumes the returned plain graph, so stateful Proxies are
 * never validated and then traversed again.
 */
const snapshotJsonValue = (
  value: unknown,
  depth: number,
  context: SnapshotContext,
): CanonicalJsonValue => {
  if (depth > MAX_CANONICAL_JSON_DEPTH) throw archiveError("archive_invalid");
  context.nodes += 1;
  if (context.nodes > MAX_CANONICAL_JSON_NODES) {
    throw archiveError("archive_invalid");
  }

  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw archiveError("archive_invalid");
      return value;
    case "string":
      if (value.length > MAX_CANONICAL_JSON_STRING_CHARS) {
        throw archiveError("archive_invalid");
      }
      return value;
    case "object":
      break;
    default:
      throw archiveError("archive_invalid");
  }

  if (context.active.has(value)) throw archiveError("archive_invalid");
  const existing = context.copies.get(value);
  if (existing !== undefined) return existing;

  try {
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) throw archiveError("archive_invalid");
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (!lengthDescriptor || !("value" in lengthDescriptor)) {
        throw archiveError("archive_invalid");
      }
      const length = lengthDescriptor.value;
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_CANONICAL_JSON_COLLECTION_ENTRIES
      ) {
        throw archiveError("archive_invalid");
      }

      const descriptors = new Map<string, PropertyDescriptor>();
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor) throw archiveError("archive_invalid");
        if (typeof key === "symbol") {
          if (descriptor.enumerable) throw archiveError("archive_invalid");
          continue;
        }
        if (key === "length") continue;
        if (!isArrayIndexKey(key, length)) {
          if (descriptor.enumerable) throw archiveError("archive_invalid");
          continue;
        }
        if (descriptors.size >= MAX_CANONICAL_JSON_COLLECTION_ENTRIES) {
          throw archiveError("archive_invalid");
        }
        descriptors.set(key, descriptor);
      }

      const snapshot: CanonicalJsonValue[] = [];
      snapshot.length = length;
      context.copies.set(value, snapshot);
      context.active.add(value);
      try {
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors.get(String(index));
          if (
            !descriptor ||
            !descriptor.enumerable ||
            !("value" in descriptor)
          ) {
            throw archiveError("archive_invalid");
          }
          snapshot[index] = snapshotJsonValue(
            descriptor.value,
            depth + 1,
            context,
          );
        }
      } finally {
        context.active.delete(value);
      }
      return snapshot;
    }

    if (prototype !== Object.prototype && prototype !== null) {
      throw archiveError("archive_invalid");
    }
    const descriptors = new Map<string, PropertyDescriptor>();
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) throw archiveError("archive_invalid");
      if (typeof key === "symbol") {
        if (descriptor.enumerable) throw archiveError("archive_invalid");
        continue;
      }
      if (!descriptor.enumerable) continue;
      if (
        PROTOTYPE_SENSITIVE_KEYS.has(key) ||
        key.length > MAX_CANONICAL_JSON_KEY_CHARS
      ) {
        throw archiveError("archive_invalid");
      }
      if (!("value" in descriptor)) throw archiveError("archive_invalid");
      if (descriptors.size >= MAX_CANONICAL_JSON_COLLECTION_ENTRIES) {
        throw archiveError("archive_invalid");
      }
      descriptors.set(key, descriptor);
    }
    if (descriptors.size > MAX_CANONICAL_JSON_COLLECTION_ENTRIES) {
      throw archiveError("archive_invalid");
    }

    const snapshot = Object.create(
      prototype === null ? null : Object.prototype,
    ) as Record<string, CanonicalJsonValue>;
    context.copies.set(value, snapshot);
    context.active.add(value);
    try {
      for (const [key, descriptor] of descriptors) {
        Object.defineProperty(snapshot, key, {
          configurable: true,
          enumerable: true,
          value: snapshotJsonValue(descriptor.value, depth + 1, context),
          writable: true,
        });
      }
    } finally {
      context.active.delete(value);
    }
    return snapshot;
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive_invalid", error);
  }
};

const snapshotCanonicalJsonValue = (value: unknown): CanonicalJsonValue =>
  snapshotJsonValue(value, 0, {
    active: new WeakSet<object>(),
    copies: new WeakMap<object, CanonicalJsonValue>(),
    nodes: 0,
  });

const CANONICAL_EVENT_KEYS = new Set([
  "schema_version",
  "event_id",
  "event_type",
  "event_source",
  "tenant_id",
  "identity_id",
  "platform",
  "account_id",
  "conversation_id",
  "matrix_room_id",
  "matrix_event_id",
  "remote_message_id",
  "occurred_at",
  "observed_at",
  "payload",
]);

/** Snapshot an envelope while applying payload bounds relative to payload root. */
export const snapshotCanonicalEventInput = (input: unknown): unknown => {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw archiveError("archive_invalid");
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      throw archiveError("archive_invalid");
    }

    const snapshot = Object.create(null) as Record<string, unknown>;
    const context: SnapshotContext = {
      active: new WeakSet<object>(),
      copies: new WeakMap<object, CanonicalJsonValue>(),
      nodes: 0,
    };
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string" || !CANONICAL_EVENT_KEYS.has(key)) {
        throw archiveError("archive_invalid");
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw archiveError("archive_invalid");
      }
      Object.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        value:
          key === "payload"
            ? snapshotJsonValue(descriptor.value, 0, context)
            : descriptor.value,
        writable: true,
      });
    }
    return snapshot;
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive_invalid", error);
  }
};

const stringifyCanonical = (value: CanonicalJsonValue): string => {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw archiveError("archive_invalid");
  }

  if (Array.isArray(value)) {
    const values: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) {
        throw archiveError("archive_invalid");
      }
      values.push(stringifyCanonical(descriptor.value as CanonicalJsonValue));
    }
    return `[${values.join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  const pairs: string[] = [];
  for (const key of keys) {
    if (PROTOTYPE_SENSITIVE_KEYS.has(key)) {
      throw archiveError("archive_invalid");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw archiveError("archive_invalid");
    }
    pairs.push(
      `${JSON.stringify(key)}:${stringifyCanonical(
        descriptor.value as CanonicalJsonValue,
      )}`,
    );
  }
  return `{${pairs.join(",")}}`;
};

/** Serialize a bounded JSON-safe value with recursive UTF-16 key ordering. */
export const canonicalJsonStringify = (value: unknown): string => {
  try {
    return stringifyCanonical(snapshotCanonicalJsonValue(value));
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive_invalid", error);
  }
};

/** Serialize a schema-validated envelope without charging envelope fields to payload depth. */
export const canonicalEventJsonStringify = (value: unknown): string => {
  try {
    const snapshot = snapshotCanonicalEventInput(value);
    if (snapshot === null || typeof snapshot !== "object") {
      throw archiveError("archive_invalid");
    }
    const result = CanonicalEventEnvelopeSchema.safeParse(snapshot);
    if (!result.success) throw archiveError("archive_invalid", result.error);
    const pairs: string[] = [];
    for (const key of Object.keys(snapshot).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(snapshot, key);
      if (!descriptor || !("value" in descriptor))
        throw archiveError("archive_invalid");
      const field = descriptor.value;
      pairs.push(
        `${JSON.stringify(key)}:${
          key === "payload"
            ? stringifyCanonical(field as CanonicalJsonValue)
            : JSON.stringify(field)
        }`,
      );
    }
    return `{${pairs.join(",")}}`;
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive_invalid", error);
  }
};

export const utf8ByteLength = (value: string): number => {
  try {
    return new TextEncoder().encode(value).byteLength;
  } catch (error) {
    throw archiveError("archive_unavailable", error);
  }
};

export const canonicalJsonBytes = (value: unknown): Uint8Array => {
  const serialized = canonicalJsonStringify(value);
  try {
    return new TextEncoder().encode(serialized);
  } catch (error) {
    throw archiveError("archive_unavailable", error);
  }
};

export const canonicalEventJsonBytes = (value: unknown): Uint8Array => {
  const serialized = canonicalEventJsonStringify(value);
  try {
    return new TextEncoder().encode(serialized);
  } catch (error) {
    throw archiveError("archive_unavailable", error);
  }
};

export const canonicalJsonLineBytes = (value: unknown): Uint8Array => {
  const serialized = canonicalJsonStringify(value);
  try {
    const body = new TextEncoder().encode(serialized);
    const line = new Uint8Array(body.byteLength + 1);
    line.set(body);
    line[body.byteLength] = 0x0a;
    return line;
  } catch (error) {
    throw archiveError("archive_unavailable", error);
  }
};

export const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};
