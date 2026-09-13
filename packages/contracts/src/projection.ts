import { z } from "zod";
import { ArchiveReplayPageSchema } from "./archive";
import {
  CanonicalEventEnvelopeSchema,
  CanonicalEventTypeSchema,
  CanonicalResourceIdSchema,
  OpaqueEventIdSchema,
  type CanonicalEventEnvelope,
  type CanonicalEventType,
  type OpaqueEventId,
} from "./canonical-event";
import { CommandStatusSchema } from "./command";
import { DeliveryModeSchema } from "./command";
import { ProviderSchema } from "./connection";
import {
  ConversationSummarySchema,
  DeliveryStatusSchema,
} from "./conversation";
import { TimestampSchema } from "./ids";
import {
  MessageSearchDirectionSchema,
  validateMessageSearchDatesAndTerms,
} from "./search";

export const MAX_PROJECTION_BATCH_EVENTS = 500;
export const MAX_PROJECTION_BATCH_BYTES = 4 * 1024 * 1024;
export const DEFAULT_PROJECTION_PAGE_SIZE = 50;
export const MAX_PROJECTION_PAGE_SIZE = 100;
export const MAX_PROJECTION_CURSOR_CHARS = 2_048;
export const MAX_PROJECTION_CHECKPOINT_VALUE_CHARS = 4_096;
export const MAX_PROJECTION_CHANGES = 10_000;
export const MAX_IDENTITY_CONNECTIONS = 64;
/** A grant may span more than the legacy identity connection display bound. */
export const MAX_AUTHORIZATION_SCOPE_IDS = 10_000;

const PROTOTYPE_SENSITIVE_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

/**
 * Snapshot an object using property descriptors. This keeps the contract
 * boundary from invoking accessors or Proxy get traps before Zod validates it.
 */
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

const strictObject = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.preprocess(snapshotStrictObjectInput, z.object(shape).strict());

const strictArray = <Schema extends z.ZodTypeAny>(
  schema: Schema,
  maxLength: number,
  minLength = 0,
) =>
  z.preprocess(
    (input) => snapshotStrictArrayInput(input, maxLength),
    z.array(schema).min(minLength).max(maxLength),
  );

const BoundedTimestampSchema = TimestampSchema.max(64);
const NonnegativeSafeIntegerSchema = z.number().int().safe().nonnegative();
const PositiveSafeIntegerSchema = z.number().int().safe().positive();
const SafeIntegerSchema = z.number().int().safe();
const QueryCursorSchema = z.string().min(1).max(MAX_PROJECTION_CURSOR_CHARS);
const CheckpointCursorSchema = z
  .string()
  .min(1)
  .max(MAX_PROJECTION_CHECKPOINT_VALUE_CHARS);

const ResourceIdOrNullSchema = CanonicalResourceIdSchema.nullable();

export const ProjectionChannelStatSchema = strictObject({
  connection_id: CanonicalResourceIdSchema,
  unread_count: NonnegativeSafeIntegerSchema,
  last_activity_at: TimestampSchema.nullable(),
});

export type ProjectionChannelStat = z.infer<typeof ProjectionChannelStatSchema>;

export const ProjectionChannelStatsSchema = strictArray(
  ProjectionChannelStatSchema,
  MAX_IDENTITY_CONNECTIONS,
);

export type ProjectionChannelStats = z.infer<
  typeof ProjectionChannelStatsSchema
>;

export const ProjectionScopeSchema = z.enum([
  "projection.initialize",
  "projection.write",
  "projection.read",
  "projection.rebuild",
  "projection.status",
]);

export type ProjectionScope = z.infer<typeof ProjectionScopeSchema>;

const hasStrictlyIncreasingValues = (values: readonly string[]): boolean => {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (
      previous === undefined ||
      current === undefined ||
      previous >= current
    ) {
      return false;
    }
  }
  return true;
};

const ProjectionAuthorizationContextObjectSchema = strictObject({
  schema_version: z.literal(1),
  tenant_id: CanonicalResourceIdSchema,
  principal_id: CanonicalResourceIdSchema,
  allowed_identity_ids: strictArray(
    CanonicalResourceIdSchema,
    MAX_PROJECTION_BATCH_EVENTS,
  ),
  // These fields are optional for the projection's internal/replay callers and
  // preserve the legacy identity-only contract. Product reads include them
  // whenever account/chat grants are enforced.
  allowed_account_ids: strictArray(
    CanonicalResourceIdSchema,
    MAX_AUTHORIZATION_SCOPE_IDS,
  ).optional(),
  allowed_all_account_ids: strictArray(
    CanonicalResourceIdSchema,
    MAX_AUTHORIZATION_SCOPE_IDS,
  ).optional(),
  allowed_conversation_ids: strictArray(
    CanonicalResourceIdSchema,
    MAX_AUTHORIZATION_SCOPE_IDS,
  ).optional(),
  scopes: strictArray(ProjectionScopeSchema, 5, 1),
}).superRefine((value, context) => {
  if (!hasStrictlyIncreasingValues(value.allowed_identity_ids)) {
    context.addIssue({
      code: "custom",
      path: ["allowed_identity_ids"],
      message: "Allowed identities must be sorted and unique",
    });
  }
  if (!hasStrictlyIncreasingValues(value.scopes)) {
    context.addIssue({
      code: "custom",
      path: ["scopes"],
      message: "Projection scopes must be sorted and unique",
    });
  }
  for (const key of [
    "allowed_account_ids",
    "allowed_all_account_ids",
    "allowed_conversation_ids",
  ] as const) {
    const values = value[key];
    if (values !== undefined && !hasStrictlyIncreasingValues(values)) {
      context.addIssue({
        code: "custom",
        path: [key],
        message: "Authorization IDs must be sorted and unique",
      });
    }
  }
});

export const ProjectionAuthorizationContextSchema =
  ProjectionAuthorizationContextObjectSchema;

export type ProjectionAuthorizationContext = z.infer<
  typeof ProjectionAuthorizationContextSchema
>;

export const ListProjectionChannelStatsInputSchema = strictObject({
  schema_version: z.literal(1),
  tenant_id: CanonicalResourceIdSchema,
  identity_id: CanonicalResourceIdSchema,
  authorization: ProjectionAuthorizationContextSchema,
});

export type ListProjectionChannelStatsInput = z.infer<
  typeof ListProjectionChannelStatsInputSchema
>;

export const GetProjectionConversationInputSchema = strictObject({
  schema_version: z.literal(1),
  tenant_id: CanonicalResourceIdSchema,
  identity_id: CanonicalResourceIdSchema,
  conversation_id: CanonicalResourceIdSchema,
  account_id: CanonicalResourceIdSchema.optional(),
  authorization: ProjectionAuthorizationContextSchema,
});

export type GetProjectionConversationInput = z.infer<
  typeof GetProjectionConversationInputSchema
>;

export const GetProjectionConversationResultSchema =
  ConversationSummarySchema.nullable();

const ProjectionConnectionBindingObjectSchema = strictObject({
  account_id: CanonicalResourceIdSchema,
  connection_id: CanonicalResourceIdSchema,
  identity_id: CanonicalResourceIdSchema,
  platform: ProviderSchema,
});

export const ProjectionConnectionBindingSchema =
  ProjectionConnectionBindingObjectSchema;

export type ProjectionConnectionBinding = z.infer<
  typeof ProjectionConnectionBindingSchema
>;

const ProjectionConnectionBindingsObjectSchema = strictArray(
  ProjectionConnectionBindingSchema,
  MAX_PROJECTION_BATCH_EVENTS,
).superRefine((bindings, context) => {
  const accountIds = bindings.map((row) => row.account_id);
  if (!hasStrictlyIncreasingValues(accountIds)) {
    context.addIssue({
      code: "custom",
      path: [],
      message: "Connection bindings must be sorted uniquely by account_id",
    });
  }
});

export const ProjectionConnectionBindingsSchema =
  ProjectionConnectionBindingsObjectSchema;

export type ProjectionConnectionBindings = z.infer<
  typeof ProjectionConnectionBindingsSchema
>;

const MessageCreatedProjectionPayloadSchema = strictObject({
  message_id: CanonicalResourceIdSchema,
  direction: z.enum(["inbound", "outbound"]),
  sender_participant_id: ResourceIdOrNullSchema,
  sender_label: z.string().min(1).max(100),
  body: z.string().max(20_000),
  reply_to_message_id: ResourceIdOrNullSchema,
  delivery_status: DeliveryStatusSchema,
  unread: z.boolean(),
});

const MessageEditedProjectionPayloadSchema = strictObject({
  message_id: CanonicalResourceIdSchema,
  body: z.string().max(20_000),
  editor_participant_id: ResourceIdOrNullSchema,
});

const MessageDeletedProjectionPayloadSchema = strictObject({
  message_id: CanonicalResourceIdSchema,
  reason_code: z.string().min(1).max(100).nullable(),
});

const ReactionAddedProjectionPayloadSchema = strictObject({
  reaction_id: CanonicalResourceIdSchema,
  message_id: CanonicalResourceIdSchema,
  participant_id: CanonicalResourceIdSchema,
  emoji: z.string().min(1).max(64),
});

const ReactionRemovedProjectionPayloadSchema = strictObject({
  reaction_id: CanonicalResourceIdSchema,
  message_id: CanonicalResourceIdSchema,
});

const ReceiptProjectionPayloadSchema = strictObject({
  message_id: CanonicalResourceIdSchema,
  participant_id: CanonicalResourceIdSchema,
  local_identity: z.boolean(),
});

const TypingStartedProjectionPayloadSchema = strictObject({
  participant_id: CanonicalResourceIdSchema,
  expires_at: TimestampSchema,
});

const TypingStoppedProjectionPayloadSchema = strictObject({
  participant_id: CanonicalResourceIdSchema,
});

const AttachmentObservedProjectionPayloadSchema = strictObject({
  attachment_id: CanonicalResourceIdSchema,
  message_id: CanonicalResourceIdSchema,
  file_name: z.string().max(255).nullable(),
  mime_type: z.string().min(1).max(255).nullable(),
  size_bytes: z.number().int().safe().nonnegative().nullable(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  r2_key: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[\x20-\x7E]+$/)
    .nullable(),
});

const ConversationUpdatedProjectionPayloadSchema = strictObject({
  title: z.string().min(1).max(200),
  archived: z.boolean(),
  muted: z.boolean(),
});

const ParticipantUpdatedProjectionPayloadSchema = strictObject({
  participant_id: CanonicalResourceIdSchema,
  display_name: z.string().min(1).max(100),
  remote_id: z.string().min(1).max(1_024).nullable(),
  avatar_url: z.string().min(1).max(2_048).nullable(),
});

const CommandUpdatedProjectionPayloadSchema = strictObject({
  command_id: CanonicalResourceIdSchema,
  operation: z.literal("message.send"),
  delivery_mode: DeliveryModeSchema,
  status: CommandStatusSchema,
  failure_code: z.string().min(1).max(100).nullable(),
});

const BridgeDeliveryUpdatedProjectionPayloadSchema = strictObject({
  message_id: CanonicalResourceIdSchema,
  delivery_status: DeliveryStatusSchema,
  failure_code: z.string().min(1).max(100).nullable(),
});

const EventMarkerProjectionPayloadSchema = strictObject({
  target_event_id: OpaqueEventIdSchema,
  reason_code: z.string().min(1).max(100),
});

const DeletionTombstoneProjectionPayloadSchema = strictObject({
  resource_type: z.enum([
    "message",
    "conversation",
    "participant",
    "attachment",
  ]),
  resource_id: CanonicalResourceIdSchema,
  reason_code: z.string().min(1).max(100),
});

export const ProjectionPayloadSchemaByType = {
  "message.created": MessageCreatedProjectionPayloadSchema,
  "message.edited": MessageEditedProjectionPayloadSchema,
  "message.deleted": MessageDeletedProjectionPayloadSchema,
  "reaction.added": ReactionAddedProjectionPayloadSchema,
  "reaction.removed": ReactionRemovedProjectionPayloadSchema,
  "receipt.read": ReceiptProjectionPayloadSchema,
  "receipt.delivered": ReceiptProjectionPayloadSchema,
  "typing.started": TypingStartedProjectionPayloadSchema,
  "typing.stopped": TypingStoppedProjectionPayloadSchema,
  "attachment.observed": AttachmentObservedProjectionPayloadSchema,
  "conversation.updated": ConversationUpdatedProjectionPayloadSchema,
  "participant.updated": ParticipantUpdatedProjectionPayloadSchema,
  "command.updated": CommandUpdatedProjectionPayloadSchema,
  "bridge.delivery.updated": BridgeDeliveryUpdatedProjectionPayloadSchema,
  "replay.tombstone": EventMarkerProjectionPayloadSchema,
  "correction.applied": EventMarkerProjectionPayloadSchema,
  "deletion.tombstone": DeletionTombstoneProjectionPayloadSchema,
} as const satisfies Record<CanonicalEventType, z.ZodTypeAny>;

export type ProjectionPayload = {
  [EventType in CanonicalEventType]: z.infer<
    (typeof ProjectionPayloadSchemaByType)[EventType]
  >;
}[CanonicalEventType];

type ProjectionEventEnvelopeFor<EventType extends CanonicalEventType> = Omit<
  CanonicalEventEnvelope,
  "event_type" | "payload"
> & {
  event_type: EventType;
  payload: z.infer<(typeof ProjectionPayloadSchemaByType)[EventType]>;
};

export type ProjectionEventEnvelope = {
  [EventType in CanonicalEventType]: ProjectionEventEnvelopeFor<EventType>;
}[CanonicalEventType];

const ProjectionEventEnvelopeValidationSchema = z.preprocess(
  snapshotStrictObjectInput,
  z.unknown().transform((input, context) => {
    const canonicalResult = CanonicalEventEnvelopeSchema.safeParse(input);
    if (!canonicalResult.success) {
      context.addIssue({
        code: "custom",
        message: "Invalid canonical event envelope",
      });
      return z.NEVER;
    }

    const canonical = canonicalResult.data;
    const payloadSchema = ProjectionPayloadSchemaByType[canonical.event_type];
    const payloadResult = payloadSchema.safeParse(canonical.payload);
    if (!payloadResult.success) {
      context.addIssue({
        code: "custom",
        path: ["payload"],
        message: "Invalid projection payload for event type",
      });
      return z.NEVER;
    }

    return {
      ...canonical,
      payload: payloadResult.data,
    };
  }),
);

export const ProjectionEventEnvelopeSchema =
  ProjectionEventEnvelopeValidationSchema as unknown as z.ZodType<ProjectionEventEnvelope>;

export const parseProjectionEvent = (input: unknown): ProjectionEventEnvelope =>
  ProjectionEventEnvelopeSchema.parse(input);

export const compareOpaqueEventIds = (
  a: OpaqueEventId,
  b: OpaqueEventId,
): number => {
  const left = new TextEncoder().encode(OpaqueEventIdSchema.parse(a));
  const right = new TextEncoder().encode(OpaqueEventIdSchema.parse(b));
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftByte = left[index];
    const rightByte = right[index];
    if (leftByte === undefined || rightByte === undefined) continue;
    if (leftByte < rightByte) return -1;
    if (leftByte > rightByte) return 1;
  }
  if (left.length < right.length) return -1;
  if (left.length > right.length) return 1;
  return 0;
};

export const ProjectionCheckpointInputSchema = strictObject({
  kind: z.string().trim().min(1).max(64),
  value: z.string().trim().min(1).max(MAX_PROJECTION_CHECKPOINT_VALUE_CHARS),
  last_observed_at: BoundedTimestampSchema,
  last_event_id: OpaqueEventIdSchema,
});

export type ProjectionCheckpointInput = z.infer<
  typeof ProjectionCheckpointInputSchema
>;

export const ApplyProjectionBatchInputSchema = strictObject({
  schema_version: z.literal(1),
  tenant_id: CanonicalResourceIdSchema,
  authorization: ProjectionAuthorizationContextSchema,
  mode: z.literal("live"),
  rebuild_id: z.null(),
  connections: ProjectionConnectionBindingsSchema,
  events: strictArray(
    ProjectionEventEnvelopeSchema,
    MAX_PROJECTION_BATCH_EVENTS,
    1,
  ),
  checkpoint: ProjectionCheckpointInputSchema.nullable(),
});

export type ApplyProjectionBatchInput = z.infer<
  typeof ApplyProjectionBatchInputSchema
>;

export const ApplyProjectionBatchResultSchema = strictObject({
  schema_version: z.literal(1),
  tenant_id: CanonicalResourceIdSchema,
  generation: PositiveSafeIntegerSchema,
  applied_count: NonnegativeSafeIntegerSchema,
  duplicate_count: NonnegativeSafeIntegerSchema,
  last_sequence: NonnegativeSafeIntegerSchema,
});

export type ApplyProjectionBatchResult = z.infer<
  typeof ApplyProjectionBatchResultSchema
>;

export const InitializeProjectionInputSchema = strictObject({
  schema_version: z.literal(1),
  tenant_id: CanonicalResourceIdSchema,
  initialized_at: TimestampSchema,
  authorization: ProjectionAuthorizationContextSchema,
});

export type InitializeProjectionInput = z.infer<
  typeof InitializeProjectionInputSchema
>;

export const ProjectionStatusInputSchema = strictObject({
  schema_version: z.literal(1),
  tenant_id: CanonicalResourceIdSchema,
  authorization: ProjectionAuthorizationContextSchema,
});

export type ProjectionStatusInput = z.infer<typeof ProjectionStatusInputSchema>;

export const ProjectionStateSchema = z.enum([
  "ready",
  "rebuilding",
  "rebuild_failed",
]);

export type ProjectionState = z.infer<typeof ProjectionStateSchema>;

export const RebuildFailureCodeSchema = z.enum([
  "operator_abort",
  "unsupported_archive",
  "archive_gap",
  "binding_conflict",
  "validation_failed",
]);

export type RebuildFailureCode = z.infer<typeof RebuildFailureCodeSchema>;

export const ProjectionErrorCodeSchema = z.enum([
  "projection_invalid",
  "projection_forbidden",
  "projection_tenant_mismatch",
  "projection_conflict",
  "projection_rebuilding",
  "projection_rebuild_failed",
  "projection_rebuild_mismatch",
  "projection_not_found",
  "projection_too_large",
  "projection_unavailable",
]);

export type ProjectionErrorCode = z.infer<typeof ProjectionErrorCodeSchema>;

const PageDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const ProjectionStatusCheckpointSchema = strictObject({
  kind: z.string().trim().min(1).max(64),
  value: CheckpointCursorSchema,
  generation: PositiveSafeIntegerSchema,
  updated_at: TimestampSchema,
  last_observed_at: TimestampSchema.nullable(),
  last_event_id: OpaqueEventIdSchema.nullable(),
  source_cursor: CheckpointCursorSchema.nullable(),
  page_digest: PageDigestSchema.nullable(),
});

export type ProjectionStatusCheckpoint = z.infer<
  typeof ProjectionStatusCheckpointSchema
>;

export const ProjectionStatusSchema = strictObject({
  schema_version: z.literal(1),
  tenant_id: CanonicalResourceIdSchema,
  schema_generation: PositiveSafeIntegerSchema,
  state: ProjectionStateSchema,
  generation: PositiveSafeIntegerSchema,
  rebuild_id: CanonicalResourceIdSchema.nullable(),
  last_completed_rebuild_id: CanonicalResourceIdSchema.nullable(),
  last_failed_rebuild_id: CanonicalResourceIdSchema.nullable(),
  last_rebuild_failure_code: RebuildFailureCodeSchema.nullable(),
  applied_event_count: NonnegativeSafeIntegerSchema,
  conversation_count: NonnegativeSafeIntegerSchema,
  message_count: NonnegativeSafeIntegerSchema,
  latest_change_sequence: NonnegativeSafeIntegerSchema,
  checkpoints: strictArray(
    ProjectionStatusCheckpointSchema,
    MAX_PROJECTION_CHANGES,
  ),
});

export type ProjectionStatus = z.infer<typeof ProjectionStatusSchema>;

export const BeginRebuildInputSchema = strictObject({
  schema_version: z.literal(1),
  tenant_id: CanonicalResourceIdSchema,
  rebuild_id: CanonicalResourceIdSchema,
  expected_generation: PositiveSafeIntegerSchema,
  started_at: TimestampSchema,
  authorization: ProjectionAuthorizationContextSchema,
});

export type BeginRebuildInput = z.infer<typeof BeginRebuildInputSchema>;

export const CompleteRebuildInputSchema = strictObject({
  schema_version: z.literal(1),
  tenant_id: CanonicalResourceIdSchema,
  rebuild_id: CanonicalResourceIdSchema,
  terminal_cursor: z.null(),
  completed_at: TimestampSchema,
  authorization: ProjectionAuthorizationContextSchema,
});

export type CompleteRebuildInput = z.infer<typeof CompleteRebuildInputSchema>;

export const AbortRebuildInputSchema = strictObject({
  schema_version: z.literal(1),
  tenant_id: CanonicalResourceIdSchema,
  rebuild_id: CanonicalResourceIdSchema,
  failed_at: TimestampSchema,
  failure_code: RebuildFailureCodeSchema,
  authorization: ProjectionAuthorizationContextSchema,
});

export type AbortRebuildInput = z.infer<typeof AbortRebuildInputSchema>;

const ApplyReplayPageInputObjectSchema = strictObject({
  schema_version: z.literal(1),
  tenant_id: CanonicalResourceIdSchema,
  rebuild_id: CanonicalResourceIdSchema,
  source_cursor: CheckpointCursorSchema.nullable(),
  connections: ProjectionConnectionBindingsSchema,
  page: ArchiveReplayPageSchema,
  authorization: ProjectionAuthorizationContextSchema,
});

export const ApplyReplayPageInputSchema =
  ApplyReplayPageInputObjectSchema.transform((value, context) => {
    try {
      return structuredClone(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Invalid replay projection input",
      });
      return z.NEVER;
    }
  });

export type ApplyReplayPageInput = z.infer<typeof ApplyReplayPageInputSchema>;

export const ListProjectionConversationsInputSchema = strictObject({
  schema_version: z.literal(1),
  tenant_id: CanonicalResourceIdSchema,
  identity_id: CanonicalResourceIdSchema,
  account_id: CanonicalResourceIdSchema.optional(),
  connection_id: CanonicalResourceIdSchema.nullable(),
  page_size: z
    .number()
    .int()
    .safe()
    .min(1)
    .max(MAX_PROJECTION_PAGE_SIZE)
    .optional(),
  cursor: QueryCursorSchema.optional(),
  authorization: ProjectionAuthorizationContextSchema,
});

export type ListProjectionConversationsInput = z.infer<
  typeof ListProjectionConversationsInputSchema
>;

export const ListProjectionMessagesInputSchema = strictObject({
  schema_version: z.literal(1),
  tenant_id: CanonicalResourceIdSchema,
  identity_id: CanonicalResourceIdSchema,
  conversation_id: CanonicalResourceIdSchema,
  message_id: CanonicalResourceIdSchema.optional(),
  account_id: CanonicalResourceIdSchema.optional(),
  page_size: z
    .number()
    .int()
    .safe()
    .min(1)
    .max(MAX_PROJECTION_PAGE_SIZE)
    .optional(),
  cursor: QueryCursorSchema.optional(),
  authorization: ProjectionAuthorizationContextSchema,
});

export type ListProjectionMessagesInput = z.infer<
  typeof ListProjectionMessagesInputSchema
>;

export const ListProjectionMessageSearchInputSchema = strictObject({
  schema_version: z.literal(1),
  tenant_id: CanonicalResourceIdSchema,
  identity_id: CanonicalResourceIdSchema,
  account_id: CanonicalResourceIdSchema.optional(),
  conversation_id: CanonicalResourceIdSchema.optional(),
  text: z.string().trim().min(1).max(200).optional(),
  contact: z.string().trim().min(1).max(100).optional(),
  from: BoundedTimestampSchema.optional(),
  to: BoundedTimestampSchema.optional(),
  direction: MessageSearchDirectionSchema.optional(),
  page_size: z
    .number()
    .int()
    .safe()
    .min(1)
    .max(MAX_PROJECTION_PAGE_SIZE)
    .optional(),
  cursor: QueryCursorSchema.optional(),
  authorization: ProjectionAuthorizationContextSchema,
}).superRefine(validateMessageSearchDatesAndTerms);

export type ListProjectionMessageSearchInput = z.infer<
  typeof ListProjectionMessageSearchInputSchema
>;

export const ListProjectionChangesInputSchema = strictObject({
  schema_version: z.literal(1),
  tenant_id: CanonicalResourceIdSchema,
  identity_id: CanonicalResourceIdSchema,
  generation: PositiveSafeIntegerSchema,
  after_sequence: NonnegativeSafeIntegerSchema,
  limit: z
    .number()
    .int()
    .safe()
    .min(1)
    .max(MAX_PROJECTION_PAGE_SIZE)
    .optional(),
  authorization: ProjectionAuthorizationContextSchema,
});

export type ListProjectionChangesInput = z.infer<
  typeof ListProjectionChangesInputSchema
>;

export const ProjectionChangeSchema = strictObject({
  sequence: PositiveSafeIntegerSchema,
  event_id: OpaqueEventIdSchema,
  event_type: CanonicalEventTypeSchema,
  identity_id: CanonicalResourceIdSchema,
  connection_id: CanonicalResourceIdSchema,
  conversation_id: CanonicalResourceIdSchema,
  occurred_at: TimestampSchema,
  observed_at: TimestampSchema,
  generation: PositiveSafeIntegerSchema,
});

export type ProjectionChange = z.infer<typeof ProjectionChangeSchema>;

export const ProjectionChangePageSchema = strictObject({
  schema_version: z.literal(1),
  tenant_id: CanonicalResourceIdSchema,
  identity_id: CanonicalResourceIdSchema,
  generation: PositiveSafeIntegerSchema,
  items: strictArray(ProjectionChangeSchema, MAX_PROJECTION_PAGE_SIZE),
  latest_sequence: NonnegativeSafeIntegerSchema,
  reset_required: z.boolean(),
}).superRefine((value, context) => {
  value.items.forEach((item, index) => {
    if (item.identity_id !== value.identity_id) {
      context.addIssue({
        code: "custom",
        path: ["items", index, "identity_id"],
        message: "Projection change identity must match the page identity",
      });
    }
    if (item.generation !== value.generation) {
      context.addIssue({
        code: "custom",
        path: ["items", index, "generation"],
        message: "Projection change generation must match the page generation",
      });
    }
  });
});

export type ProjectionChangePage = z.infer<typeof ProjectionChangePageSchema>;

export const ConversationCursorSchema = strictObject({
  schema_version: z.literal(1),
  query_kind: z.literal("projection.conversations"),
  tenant_id: CanonicalResourceIdSchema,
  identity_id: CanonicalResourceIdSchema,
  connection_id: CanonicalResourceIdSchema.nullable(),
  generation: PositiveSafeIntegerSchema,
  last_activity_ms: SafeIntegerSchema,
  last_id: CanonicalResourceIdSchema,
});

export type ConversationCursor = z.infer<typeof ConversationCursorSchema>;

export const MessageCursorSchema = strictObject({
  schema_version: z.literal(1),
  query_kind: z.literal("projection.messages"),
  tenant_id: CanonicalResourceIdSchema,
  identity_id: CanonicalResourceIdSchema,
  conversation_id: CanonicalResourceIdSchema,
  generation: PositiveSafeIntegerSchema,
  last_occurred_ms: SafeIntegerSchema,
  last_id: CanonicalResourceIdSchema,
});

export type MessageCursor = z.infer<typeof MessageCursorSchema>;
