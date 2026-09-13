import { z } from "zod";
import { CommunicatorIdSchema, TimestampSchema } from "./ids";

/**
 * Removal records are intentionally provider-neutral.  A resource id may be
 * a Communicator id or an opaque provider/object key, while the tenant and
 * account/chat owners remain Communicator ids.
 */
export const RemovalResourceTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_.-]*$/u);
export type RemovalResourceType = z.infer<typeof RemovalResourceTypeSchema>;

export const RemovalReasonSchema = z.enum([
  "requested",
  "expired",
  "retention",
]);
export type RemovalReason = z.infer<typeof RemovalReasonSchema>;

/** Active suppression is complete independently of any later physical purge. */
export const RemovalStatusSchema = z.enum(["active", "completed", "failed"]);
export type RemovalStatus = z.infer<typeof RemovalStatusSchema>;

/** Physical purge is deliberately not implemented by the active-removal ticket. */
export const RemovalPurgeStatusSchema = z.enum([
  "not_started",
  "pending",
  "complete",
  "failed",
]);
export type RemovalPurgeStatus = z.infer<typeof RemovalPurgeStatusSchema>;

const OpaqueKeySchema = z.string().trim().min(1).max(2_048);
/**
 * An immutable lineage for the removed resource. This is intentionally
 * separate from a message edit revision: a late edit must not be able to
 * replace the resource lineage and evade an existing removal authority.
 */
const ContentGenerationSchema = z
  .union([
    z.string().trim().min(1).max(256),
    z.number().int().safe().nonnegative(),
  ])
  .transform(String);

export const RemovalAuthoritySchema = z
  .object({
    id: CommunicatorIdSchema,
    tenant_id: CommunicatorIdSchema,
    resource_type: RemovalResourceTypeSchema,
    resource_id: OpaqueKeySchema,
    content_generation: z.string().min(1).max(256),
    account_id: CommunicatorIdSchema.nullable(),
    conversation_id: CommunicatorIdSchema.nullable(),
    source_event_id: OpaqueKeySchema.nullable(),
    source_object_key: OpaqueKeySchema.nullable(),
    reason: RemovalReasonSchema,
    removed_at: TimestampSchema,
    deletion_epoch: z.number().int().safe().positive(),
    status: RemovalStatusSchema,
    purge_status: RemovalPurgeStatusSchema,
    failure_code: z.string().trim().min(1).max(512).nullable(),
    completed_at: TimestampSchema.nullable(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .strict();
export type RemovalAuthority = z.infer<typeof RemovalAuthoritySchema>;

export const RecordRemovalInputSchema = z
  .object({
    tenant_id: CommunicatorIdSchema,
    resource_type: RemovalResourceTypeSchema,
    resource_id: OpaqueKeySchema,
    content_generation: ContentGenerationSchema,
    account_id: CommunicatorIdSchema.nullable().default(null),
    conversation_id: CommunicatorIdSchema.nullable().default(null),
    source_event_id: OpaqueKeySchema.nullable().default(null),
    source_object_key: OpaqueKeySchema.nullable().default(null),
    reason: RemovalReasonSchema,
    removed_at: TimestampSchema.optional(),
  })
  .strict();
export type RecordRemovalInput = z.input<typeof RecordRemovalInputSchema>;
export type NormalizedRecordRemovalInput = z.output<
  typeof RecordRemovalInputSchema
>;

export const RemovalExpiryStatusSchema = z.enum([
  "scheduled",
  "processing",
  "completed",
  "failed",
]);
export type RemovalExpiryStatus = z.infer<typeof RemovalExpiryStatusSchema>;

export const RemovalExpiryScheduleSchema = z
  .object({
    id: CommunicatorIdSchema,
    tenant_id: CommunicatorIdSchema,
    resource_type: RemovalResourceTypeSchema,
    resource_id: OpaqueKeySchema,
    content_generation: z.string().min(1).max(256),
    account_id: CommunicatorIdSchema.nullable(),
    conversation_id: CommunicatorIdSchema.nullable(),
    source_event_id: OpaqueKeySchema.nullable(),
    source_object_key: OpaqueKeySchema.nullable(),
    expires_at: TimestampSchema,
    status: RemovalExpiryStatusSchema,
    lease_token: OpaqueKeySchema.nullable(),
    lease_expires_at: TimestampSchema.nullable(),
    removal_id: CommunicatorIdSchema.nullable(),
    last_error: z.string().trim().min(1).max(1_024).nullable(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .strict();
export type RemovalExpirySchedule = z.infer<typeof RemovalExpiryScheduleSchema>;

export const ScheduleRemovalExpiryInputSchema = z
  .object({
    tenant_id: CommunicatorIdSchema,
    resource_type: RemovalResourceTypeSchema,
    resource_id: OpaqueKeySchema,
    content_generation: ContentGenerationSchema,
    account_id: CommunicatorIdSchema.nullable().default(null),
    conversation_id: CommunicatorIdSchema.nullable().default(null),
    source_event_id: OpaqueKeySchema.nullable().default(null),
    source_object_key: OpaqueKeySchema.nullable().default(null),
    expires_at: TimestampSchema,
  })
  .strict();
export type ScheduleRemovalExpiryInput = z.input<
  typeof ScheduleRemovalExpiryInputSchema
>;
export type NormalizedScheduleRemovalExpiryInput = z.output<
  typeof ScheduleRemovalExpiryInputSchema
>;
