import { z } from "zod";
import { ProviderSchema } from "./connection";
import { CommunicatorIdSchema, TimestampSchema } from "./ids";

const PROTOTYPE_SENSITIVE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export const MAX_CANONICAL_JSON_DEPTH = 32;
export const MAX_CANONICAL_JSON_NODES = 50_000;
export const MAX_CANONICAL_JSON_COLLECTION_ENTRIES = 10_000;
export const MAX_CANONICAL_JSON_KEY_CHARS = 256;
export const MAX_CANONICAL_JSON_STRING_CHARS = 1024 * 1024;

export type CanonicalJsonPrimitive = null | boolean | string | number;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };
export type CanonicalJsonObject = { [key: string]: CanonicalJsonValue };

type InspectionFrame =
  | { kind: "visit"; value: unknown; depth: number }
  | { kind: "leave"; value: object };

const isArrayIndexKey = (key: string, length: number): boolean => {
  const index = Number(key);
  return (
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
};

const hasEnumerableSymbolKey = (value: object): boolean => {
  for (const symbol of Object.getOwnPropertySymbols(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, symbol);
    if (descriptor?.enumerable) return true;
  }
  return false;
};

/**
 * Validate JSON-safe values without recursion. The active WeakSet tracks the
 * current explicit traversal path, so repeated (but acyclic) references are
 * valid while direct and indirect cycles are rejected.
 */
const isCanonicalJsonValue = (root: unknown): root is CanonicalJsonValue => {
  try {
    const active = new WeakSet<object>();
    const stack: InspectionFrame[] = [{ kind: "visit", value: root, depth: 0 }];
    let nodeCount = 0;

    while (stack.length > 0) {
      const frame = stack.pop();
      if (!frame) return false;

      if (frame.kind === "leave") {
        active.delete(frame.value);
        continue;
      }

      if (frame.depth > MAX_CANONICAL_JSON_DEPTH) return false;
      nodeCount += 1;
      if (nodeCount > MAX_CANONICAL_JSON_NODES) return false;

      const value = frame.value;
      if (value === null) continue;

      switch (typeof value) {
        case "boolean":
          continue;
        case "number":
          if (Number.isFinite(value)) continue;
          return false;
        case "string":
          if (value.length <= MAX_CANONICAL_JSON_STRING_CHARS) continue;
          return false;
        case "object":
          break;
        default:
          return false;
      }

      if (active.has(value)) return false;

      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) return false;

        const length = value.length;
        if (!Number.isSafeInteger(length) || length > MAX_CANONICAL_JSON_COLLECTION_ENTRIES) {
          return false;
        }

        const keys = Object.keys(value);
        if (keys.length > MAX_CANONICAL_JSON_COLLECTION_ENTRIES) return false;
        if (hasEnumerableSymbolKey(value)) return false;
        for (const key of keys) {
          if (PROTOTYPE_SENSITIVE_KEYS.has(key)) return false;
          if (!isArrayIndexKey(key, length)) return false;
        }

        active.add(value);
        stack.push({ kind: "leave", value });
        for (let index = length - 1; index >= 0; index -= 1) {
          const key = String(index);
          if (!Object.prototype.hasOwnProperty.call(value, key)) return false;
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !("value" in descriptor)) return false;
          stack.push({ kind: "visit", value: descriptor.value, depth: frame.depth + 1 });
        }
        continue;
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return false;

      const keys = Object.keys(value);
      if (keys.length > MAX_CANONICAL_JSON_COLLECTION_ENTRIES) return false;
      if (hasEnumerableSymbolKey(value)) return false;

      active.add(value);
      stack.push({ kind: "leave", value });
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index];
        if (key === undefined) return false;
        if (
          PROTOTYPE_SENSITIVE_KEYS.has(key) ||
          key.length > MAX_CANONICAL_JSON_KEY_CHARS
        ) {
          return false;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) return false;
        stack.push({ kind: "visit", value: descriptor.value, depth: frame.depth + 1 });
      }
    }

    return true;
  } catch {
    return false;
  }
};

const isCanonicalJsonObject = (value: unknown): value is CanonicalJsonObject => {
  try {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      isCanonicalJsonValue(value)
    );
  } catch {
    return false;
  }
};

export const CanonicalJsonValueSchema = z.custom<CanonicalJsonValue>(
  (value) => isCanonicalJsonValue(value),
  "Expected a bounded JSON-safe value",
);

export const CanonicalJsonObjectSchema = z.custom<CanonicalJsonObject>(
  (value) => isCanonicalJsonObject(value),
  "Expected a bounded JSON-safe object",
);

export const CanonicalResourceIdSchema = CommunicatorIdSchema
  .max(128)
  .regex(/^[\x00-\x7F]+$/);

export type CanonicalResourceId = z.infer<typeof CanonicalResourceIdSchema>;

export const CanonicalEventTypeSchema = z.enum([
  "message.created",
  "message.edited",
  "message.deleted",
  "reaction.added",
  "reaction.removed",
  "receipt.read",
  "receipt.delivered",
  "typing.started",
  "typing.stopped",
  "attachment.observed",
  "conversation.updated",
  "participant.updated",
  "command.updated",
  "bridge.delivery.updated",
  "replay.tombstone",
  "correction.applied",
  "deletion.tombstone",
]);

export const CanonicalEventSourceSchema = z.enum([
  "live",
  "backfill",
  "command_result",
  "replay",
  "correction",
  "deletion",
]);

const OpaqueIdSchema = z.string().trim().min(1).max(1024);
const MatrixRoomIdSchema = z.string().min(1).max(1024).startsWith("!");
const MatrixEventIdSchema = z.string().min(1).max(1024).startsWith("$");
const BoundedTimestampSchema = TimestampSchema.max(64);

/**
 * Snapshot the envelope boundary before handing it to Zod. In particular,
 * descriptor values avoid invoking getters or Proxy `get` traps, while the
 * copied null-prototype object prevents special-key behavior in Zod's object
 * parser. Any failed inspection is represented as undefined so safeParse()
 * returns a normal validation failure instead of leaking the trap error.
 */
const snapshotCanonicalEventInput = (input: unknown): unknown => {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return undefined;
    }

    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return undefined;

    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string" || PROTOTYPE_SENSITIVE_KEYS.has(key)) {
        return undefined;
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        return undefined;
      }

      Object.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true,
      });
    }

    return snapshot;
  } catch {
    return undefined;
  }
};

const CanonicalEventEnvelopeObjectSchema = z
  .object({
    schema_version: z.literal(1),
    event_id: OpaqueIdSchema,
    event_type: CanonicalEventTypeSchema,
    event_source: CanonicalEventSourceSchema,
    tenant_id: CanonicalResourceIdSchema,
    identity_id: CanonicalResourceIdSchema,
    platform: ProviderSchema,
    account_id: CanonicalResourceIdSchema,
    conversation_id: CanonicalResourceIdSchema,
    matrix_room_id: MatrixRoomIdSchema.nullable(),
    matrix_event_id: MatrixEventIdSchema.nullable(),
    remote_message_id: OpaqueIdSchema.nullable(),
    occurred_at: BoundedTimestampSchema,
    observed_at: BoundedTimestampSchema,
    payload: CanonicalJsonObjectSchema,
  })
  .strict();

export const CanonicalEventEnvelopeSchema = z.preprocess(
  snapshotCanonicalEventInput,
  CanonicalEventEnvelopeObjectSchema,
);

export type CanonicalEventType = z.infer<typeof CanonicalEventTypeSchema>;
export type CanonicalEventSource = z.infer<typeof CanonicalEventSourceSchema>;
export type CanonicalEventEnvelope = z.infer<typeof CanonicalEventEnvelopeSchema>;
