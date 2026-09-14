import { z } from "zod";
import { CommunicatorIdSchema, TimestampSchema } from "./ids";
import { DeliveryStatusSchema } from "./conversation";

const MAX_SEARCH_TEXT_CHARS = 200;
const MAX_SEARCH_CONTACT_CHARS = 100;
const MAX_SEARCH_CURSOR_CHARS = 2_048;
const MAX_SEARCH_ATTACHMENTS = 500;

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

const strictObject = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.preprocess(snapshotStrictObjectInput, z.object(shape).strict());

const SearchTextSchema = z.string().trim().min(1).max(MAX_SEARCH_TEXT_CHARS);
const SearchContactSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SEARCH_CONTACT_CHARS);
const SearchTimestampSchema = TimestampSchema.max(64);

export const MessageSearchDirectionSchema = z.enum(["inbound", "outbound"]);
export type MessageSearchDirection = z.infer<
  typeof MessageSearchDirectionSchema
>;

const messageSearchFilterShape = {
  account_id: CommunicatorIdSchema.optional(),
  conversation_id: CommunicatorIdSchema.optional(),
  text: SearchTextSchema.optional(),
  contact: SearchContactSchema.optional(),
  from: SearchTimestampSchema.optional(),
  to: SearchTimestampSchema.optional(),
  direction: MessageSearchDirectionSchema.optional(),
};

export const validateMessageSearchDatesAndTerms = (
  value: {
    text?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
  },
  context: z.RefinementCtx,
): void => {
  if (value.text !== undefined) {
    const terms = value.text
      .split(/\s+/u)
      .map((term) => term.toLocaleLowerCase())
      .filter((term) => term.length > 0);
    if (new Set(terms).size !== terms.length) {
      context.addIssue({
        code: "custom",
        path: ["text"],
        message: "Search text must not repeat a term",
      });
    }
  }

  if (value.from !== undefined && value.to !== undefined) {
    const from = Date.parse(value.from);
    const to = Date.parse(value.to);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "Search date range is invalid",
      });
    }
  }
};

export const MessageSearchFiltersSchema = strictObject(
  messageSearchFilterShape,
).superRefine(validateMessageSearchDatesAndTerms);

export type MessageSearchFilters = z.infer<typeof MessageSearchFiltersSchema>;

export const MessageSearchRequestSchema = strictObject({
  identity_id: CommunicatorIdSchema,
  ...messageSearchFilterShape,
  cursor: z.string().min(1).max(MAX_SEARCH_CURSOR_CHARS).optional(),
  limit: z.number().int().safe().min(1).max(100).optional(),
}).superRefine(validateMessageSearchDatesAndTerms);

export type MessageSearchRequest = z.infer<typeof MessageSearchRequestSchema>;

export const MessageSearchResultSchema = strictObject({
  id: CommunicatorIdSchema,
  tenant_id: CommunicatorIdSchema,
  identity_id: CommunicatorIdSchema,
  account_id: CommunicatorIdSchema,
  connection_id: CommunicatorIdSchema,
  conversation_id: CommunicatorIdSchema,
  contact_id: CommunicatorIdSchema.nullable(),
  event_id: z.string().min(1).max(1_024),
  revision: z.string().min(1).max(1_024),
  direction: MessageSearchDirectionSchema,
  sender_label: z.string().min(1).max(100),
  body: z.string().max(20_000),
  occurred_at: TimestampSchema,
  edited_at: TimestampSchema.nullable(),
  attachment_count: z.number().int().safe().nonnegative(),
  attachments: z
    .array(
      strictObject({
        id: CommunicatorIdSchema,
        file_name: z.string().max(512).nullable(),
        mime_type: z.string().max(255).nullable(),
        size_bytes: z.number().int().safe().nonnegative().nullable(),
        sha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/u)
          .nullable(),
      }),
    )
    .max(MAX_SEARCH_ATTACHMENTS),
  removed: z.boolean(),
  removed_at: TimestampSchema.nullable(),
  removal_reason: z.string().min(1).max(128).nullable(),
  delivery_status: DeliveryStatusSchema,
});

export type MessageSearchResult = z.infer<typeof MessageSearchResultSchema>;

export const MessageSearchPageResultSchema = strictObject({
  items: z.array(MessageSearchResultSchema).max(100),
  next_cursor: z.string().min(1).max(MAX_SEARCH_CURSOR_CHARS).nullable(),
});

export type MessageSearchPageResult = z.infer<
  typeof MessageSearchPageResultSchema
>;

export const MessageSearchCursorSchema = strictObject({
  schema_version: z.literal(1),
  query_kind: z.literal("projection.message_search"),
  tenant_id: CommunicatorIdSchema,
  identity_id: CommunicatorIdSchema,
  account_id: CommunicatorIdSchema.nullable(),
  conversation_id: CommunicatorIdSchema.nullable(),
  text: SearchTextSchema.nullable(),
  contact: SearchContactSchema.nullable(),
  from: SearchTimestampSchema.nullable(),
  to: SearchTimestampSchema.nullable(),
  direction: MessageSearchDirectionSchema.nullable(),
  generation: z.number().int().safe().positive(),
  last_occurred_ms: z.number().int().safe(),
  last_id: CommunicatorIdSchema,
});

export type MessageSearchCursor = z.infer<typeof MessageSearchCursorSchema>;
