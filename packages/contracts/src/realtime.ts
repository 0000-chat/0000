import { z } from "zod";
import {
  CanonicalEventTypeSchema,
  type CanonicalEventType,
} from "./canonical-event";
import { CommunicatorIdSchema, TimestampSchema } from "./ids";

export const RealtimeEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    type: z.enum([
      "connection.updated",
      "message.created",
      "command.updated",
      "system.status.updated",
    ]),
    tenant_id: CommunicatorIdSchema,
    identity_id: CommunicatorIdSchema,
    connection_id: CommunicatorIdSchema.optional(),
    conversation_id: CommunicatorIdSchema.optional(),
    occurred_at: TimestampSchema,
    data: z.record(z.string(), z.unknown()),
  })
  .strict();

export const MessageCreatedDataSchema = z
  .object({
    last_message_preview: z.string().max(280),
    last_activity_at: TimestampSchema,
    unread_delta: z.number().int(),
  })
  .strict();

export type RealtimeEvent = z.infer<typeof RealtimeEventSchema>;

export const REALTIME_SUBPROTOCOL = "communicator.realtime.v1";
export const REALTIME_TICKET_TTL_MS = 30_000;
export const REALTIME_CONNECTION_TTL_MS = 15 * 60_000;
export const MAX_REALTIME_IDENTITIES = 16;
export const MAX_REALTIME_CHANGES_PER_FRAME = 100;
export const MAX_REALTIME_REPLAY_CHANGES = 500;
export const MAX_REALTIME_SOCKETS_PER_TENANT = 256;
export const MAX_REALTIME_SOCKETS_PER_PRINCIPAL = 8;
export const MAX_REALTIME_ID_LENGTH = 255;
export const MAX_REALTIME_ATTACHMENT_JSON_BYTES = 12_000;

const PROTOTYPE_SENSITIVE_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

/** Snapshot a strict object without invoking accessors or Proxy get traps. */
const snapshotStrictObjectInput = (input: unknown): unknown => {
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

const isArrayIndexKey = (key: string, length: number): boolean => {
  const index = Number(key);
  return (
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
};

/** Snapshot a strict array while rejecting holes, symbols, and extra keys. */
const snapshotStrictArrayInput = (
  input: unknown,
  maxLength: number,
): unknown => {
  try {
    if (input === null || typeof input !== "object" || !Array.isArray(input)) {
      return undefined;
    }
    if (Object.getPrototypeOf(input) !== Array.prototype) return undefined;

    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor)) return undefined;
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maxLength) {
      return undefined;
    }

    const keys = Reflect.ownKeys(input);
    if (keys.length !== length + 1) return undefined;

    const snapshot: unknown[] = [];
    for (const key of keys) {
      if (typeof key !== "string") return undefined;
      if (key === "length") continue;
      if (!isArrayIndexKey(key, length)) return undefined;

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

    for (let index = 0; index < length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(snapshot, String(index))) {
        return undefined;
      }
    }
    snapshot.length = length;
    return snapshot;
  } catch {
    return undefined;
  }
};

const strictArray = <Schema extends z.ZodTypeAny>(
  schema: Schema,
  maxLength: number,
  minLength = 0,
) =>
  z.preprocess(
    (input) => snapshotStrictArrayInput(input, maxLength),
    z.array(schema).min(minLength).max(maxLength),
  );

const uniqueBy = <Value>(
  values: readonly Value[],
  keyOf: (value: Value) => string,
  context: z.RefinementCtx,
  pathForIndex: (index: number) => Array<string | number>,
): void => {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const key = keyOf(value);
    if (seen.has(key)) {
      context.addIssue({
        code: "custom",
        path: pathForIndex(index),
        message: "Values must be unique",
      });
    }
    seen.add(key);
  });
};

const RealtimeTimestampSchema = TimestampSchema.max(64);
const RealtimeIdSchema = CommunicatorIdSchema.max(MAX_REALTIME_ID_LENGTH);
const RealtimePositiveIntegerSchema = z.number().int().safe().positive();
const RealtimeNonnegativeIntegerSchema = z.number().int().safe().nonnegative();
const RealtimeTicketSchema = z.string().regex(/^rt1_[A-Za-z0-9_-]{43}$/);
const RealtimeWebSocketUrlSchema = z
  .string()
  .url()
  .max(4_096)
  .refine((value) => value.startsWith("ws://") || value.startsWith("wss://"), {
    message: "Expected a WebSocket URL",
  });

export const RealtimeIdentityIdSchema = RealtimeIdSchema;
export { RealtimeIdSchema };

export const RealtimeEventFamilySchema = z.literal("projection");
export type RealtimeEventFamily = z.infer<typeof RealtimeEventFamilySchema>;

const RealtimeSubscriptionObjectSchema = z
  .object({
    identity_id: RealtimeIdentityIdSchema,
    families: strictArray(RealtimeEventFamilySchema, 1, 1),
  })
  .strict()
  .superRefine((value, context) => {
    uniqueBy(
      value.families,
      (family) => family,
      context,
      (index) => ["families", index],
    );
  });

export const RealtimeSubscriptionSchema = z.preprocess(
  snapshotStrictObjectInput,
  RealtimeSubscriptionObjectSchema,
);
export type RealtimeSubscription = z.infer<typeof RealtimeSubscriptionSchema>;

const RealtimeResumePositionObjectSchema = z
  .object({
    identity_id: RealtimeIdentityIdSchema,
    generation: RealtimePositiveIntegerSchema,
    after_sequence: RealtimeNonnegativeIntegerSchema,
  })
  .strict();

export const RealtimeResumePositionSchema = z.preprocess(
  snapshotStrictObjectInput,
  RealtimeResumePositionObjectSchema,
);
export type RealtimeResumePosition = z.infer<
  typeof RealtimeResumePositionSchema
>;

const RealtimeTicketRequestObjectSchema = z
  .object({
    schema_version: z.literal(1),
    subscriptions: strictArray(
      RealtimeSubscriptionSchema,
      MAX_REALTIME_IDENTITIES,
      1,
    ),
    resume: strictArray(
      RealtimeResumePositionSchema,
      MAX_REALTIME_IDENTITIES,
    ).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    uniqueBy(
      value.subscriptions,
      (subscription) => subscription.identity_id,
      context,
      (index) => ["subscriptions", index, "identity_id"],
    );

    const subscribedIdentities = new Set(
      value.subscriptions.map((subscription) => subscription.identity_id),
    );
    const resume = value.resume ?? [];
    uniqueBy(
      resume,
      (position) => position.identity_id,
      context,
      (index) => ["resume", index, "identity_id"],
    );
    resume.forEach((position, index) => {
      if (!subscribedIdentities.has(position.identity_id)) {
        context.addIssue({
          code: "custom",
          path: ["resume", index, "identity_id"],
          message: "Resume identity must be subscribed",
        });
      }
    });
  });

export const RealtimeTicketRequestSchema = z.preprocess(
  snapshotStrictObjectInput,
  RealtimeTicketRequestObjectSchema,
);
export type RealtimeTicketRequest = z.infer<typeof RealtimeTicketRequestSchema>;

const RealtimeTicketResponseObjectSchema = z
  .object({
    schema_version: z.literal(1),
    ticket: RealtimeTicketSchema,
    expires_at: RealtimeTimestampSchema,
    websocket_url: RealtimeWebSocketUrlSchema,
  })
  .strict();

export const RealtimeTicketResponseSchema = z.preprocess(
  snapshotStrictObjectInput,
  RealtimeTicketResponseObjectSchema,
);
export type RealtimeTicketResponse = z.infer<
  typeof RealtimeTicketResponseSchema
>;

const RealtimePositionObjectSchema = z
  .object({
    identity_id: RealtimeIdentityIdSchema,
    generation: RealtimePositiveIntegerSchema,
    sequence: RealtimeNonnegativeIntegerSchema,
  })
  .strict();

export const RealtimePositionSchema = z.preprocess(
  snapshotStrictObjectInput,
  RealtimePositionObjectSchema,
);
export type RealtimePosition = z.infer<typeof RealtimePositionSchema>;

const RealtimeProjectionChangeObjectSchema = z
  .object({
    sequence: RealtimePositiveIntegerSchema,
    event_type: CanonicalEventTypeSchema,
    connection_id: RealtimeIdSchema,
    conversation_id: RealtimeIdSchema,
    occurred_at: RealtimeTimestampSchema,
  })
  .strict();

export const RealtimeProjectionChangeSchema = z.preprocess(
  snapshotStrictObjectInput,
  RealtimeProjectionChangeObjectSchema,
);
export type RealtimeProjectionChange = z.infer<
  typeof RealtimeProjectionChangeSchema
>;

const RealtimeConnectedFrameObjectSchema = z
  .object({
    schema_version: z.literal(1),
    type: z.literal("connected"),
    tenant_id: RealtimeIdSchema,
    positions: strictArray(RealtimePositionSchema, MAX_REALTIME_IDENTITIES, 1),
    connection_expires_at: RealtimeTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    uniqueBy(
      value.positions,
      (position) => position.identity_id,
      context,
      (index) => ["positions", index, "identity_id"],
    );
  });

export const RealtimeConnectedFrameSchema = z.preprocess(
  snapshotStrictObjectInput,
  RealtimeConnectedFrameObjectSchema,
);
export type RealtimeConnectedFrame = z.infer<
  typeof RealtimeConnectedFrameSchema
>;

const RealtimeProjectionChangesFrameObjectSchema = z
  .object({
    schema_version: z.literal(1),
    type: z.literal("projection.changes"),
    tenant_id: RealtimeIdSchema,
    identity_id: RealtimeIdentityIdSchema,
    generation: RealtimePositiveIntegerSchema,
    from_sequence: RealtimePositiveIntegerSchema,
    to_sequence: RealtimePositiveIntegerSchema,
    changes: strictArray(
      RealtimeProjectionChangeSchema,
      MAX_REALTIME_CHANGES_PER_FRAME,
      1,
    ),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.to_sequence < value.from_sequence ||
      value.to_sequence - value.from_sequence !== value.changes.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["changes"],
        message: "Change sequences must cover one contiguous range",
      });
      return;
    }

    value.changes.forEach((change, index) => {
      if (change.sequence !== value.from_sequence + index) {
        context.addIssue({
          code: "custom",
          path: ["changes", index, "sequence"],
          message: "Change sequences must be ordered",
        });
      }
    });
  });

export const RealtimeProjectionChangesFrameSchema = z.preprocess(
  snapshotStrictObjectInput,
  RealtimeProjectionChangesFrameObjectSchema,
);
export type RealtimeProjectionChangesFrame = z.infer<
  typeof RealtimeProjectionChangesFrameSchema
>;

const RealtimeResetRequiredFrameObjectSchema = z
  .object({
    schema_version: z.literal(1),
    type: z.literal("reset_required"),
    tenant_id: RealtimeIdSchema,
    identity_id: RealtimeIdentityIdSchema,
    generation: RealtimePositiveIntegerSchema,
    latest_sequence: RealtimeNonnegativeIntegerSchema,
    reason: z.enum([
      "generation_changed",
      "history_unavailable",
      "replay_too_large",
    ]),
  })
  .strict();

export const RealtimeResetRequiredFrameSchema = z.preprocess(
  snapshotStrictObjectInput,
  RealtimeResetRequiredFrameObjectSchema,
);
export type RealtimeResetRequiredFrame = z.infer<
  typeof RealtimeResetRequiredFrameSchema
>;

export const RealtimeServerFrameSchema = z.preprocess(
  snapshotStrictObjectInput,
  z.discriminatedUnion("type", [
    RealtimeConnectedFrameObjectSchema,
    RealtimeProjectionChangesFrameObjectSchema,
    RealtimeResetRequiredFrameObjectSchema,
  ]),
);

export type RealtimeServerFrame =
  | RealtimeConnectedFrame
  | RealtimeProjectionChangesFrame
  | RealtimeResetRequiredFrame;

export type RealtimeEventType = CanonicalEventType;
