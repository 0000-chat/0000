import { z } from "zod";
import { AttachmentMetadataSchema, MAX_ATTACHMENT_COUNT } from "./attachments";
import { CommunicatorIdSchema, TimestampSchema } from "./ids";
import { HistoryCoverageSchema } from "./history";

const snapshotStrictObjectInput = (input: unknown): unknown => {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return undefined;
    }

    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return undefined;

    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(input)) {
      if (
        typeof key !== "string" ||
        key === "__proto__" ||
        key === "prototype" ||
        key === "constructor"
      ) {
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

const snapshotStrictArrayInput = (input: unknown): unknown => {
  try {
    if (input === null || typeof input !== "object" || !Array.isArray(input)) {
      return undefined;
    }
    if (Object.getPrototypeOf(input) !== Array.prototype) return undefined;

    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor)) return undefined;
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0) return undefined;

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

const DeliveryStatusValues = [
  "unknown",
  "accepted",
  "sent",
  "delivered",
  "read",
  "failed",
] as const;

export const DeliveryStatusSchema = z.enum(DeliveryStatusValues);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

const ConversationSummaryObjectSchema = z
  .object({
    id: CommunicatorIdSchema,
    tenant_id: CommunicatorIdSchema,
    identity_id: CommunicatorIdSchema,
    /** Connected-account ownership is returned on every stored read. */
    account_id: CommunicatorIdSchema.optional(),
    connection_id: CommunicatorIdSchema,
    /** The latest stable source event that produced this summary. */
    event_id: z.string().min(1).max(1_024).optional(),
    title: z.string().min(1).max(200),
    last_message_preview: z.string().max(280),
    last_activity_at: TimestampSchema,
    unread_count: z.number().int().nonnegative(),
  })
  .strict();

export const ConversationSummarySchema = z.preprocess(
  snapshotStrictObjectInput,
  ConversationSummaryObjectSchema,
);

export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

const ConversationPageResultObjectSchema = z
  .object({
    items: z.preprocess(
      snapshotStrictArrayInput,
      z.array(ConversationSummarySchema),
    ),
    next_cursor: z.string().min(1).max(2_048).nullable(),
  })
  .strict();

export const ConversationPageResultSchema = z.preprocess(
  snapshotStrictObjectInput,
  ConversationPageResultObjectSchema,
);

export type ConversationPageResult = z.infer<
  typeof ConversationPageResultSchema
>;

const MessageObjectSchema = z
  .object({
    id: CommunicatorIdSchema,
    tenant_id: CommunicatorIdSchema,
    identity_id: CommunicatorIdSchema,
    /** Connected-account ownership is returned on every stored read. */
    account_id: CommunicatorIdSchema.optional(),
    connection_id: CommunicatorIdSchema,
    conversation_id: CommunicatorIdSchema,
    /** Stable source event and sender/contact identifiers when available. */
    event_id: z.string().min(1).max(1_024).optional(),
    sender_participant_id: CommunicatorIdSchema.nullable().optional(),
    direction: z.enum(["inbound", "outbound"]),
    sender_label: z.string().min(1).max(100),
    body: z.string().max(20_000),
    occurred_at: TimestampSchema,
    delivery_status: DeliveryStatusSchema,
    attachment_count: z.number().int().nonnegative(),
    attachments: z.array(AttachmentMetadataSchema).max(MAX_ATTACHMENT_COUNT),
  })
  .strict();

export const MessageSchema = z.preprocess(
  snapshotStrictObjectInput,
  MessageObjectSchema,
);

export type Message = z.infer<typeof MessageSchema>;

const MessagePageResultObjectSchema = z
  .object({
    items: z.preprocess(snapshotStrictArrayInput, z.array(MessageSchema)),
    next_cursor: z.string().min(1).max(2_048).nullable(),
    history: HistoryCoverageSchema.optional(),
  })
  .strict();

export const MessagePageResultSchema = z.preprocess(
  snapshotStrictObjectInput,
  MessagePageResultObjectSchema,
);

export type MessagePageResult = z.infer<typeof MessagePageResultSchema>;
