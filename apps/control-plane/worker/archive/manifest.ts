import {
  ArchiveDataKeySchema,
  ArchiveManifestKeySchema,
  CanonicalResourceIdSchema,
  MAX_ARCHIVE_EVENTS,
  RemovalResourceTypeSchema,
  TimestampSchema,
  type RemovalResourceType,
} from "@communicator/contracts";
import { z } from "zod";

/**
 * Archive purge is a two-phase operation.  A replacement may be committed
 * while the old data object is retained for the configured safety window, but
 * the old manifest must already be gone before replay can see the replacement
 * as the only committed batch.
 */
export const ArchivePurgeStatusSchema = z.enum([
  "planned",
  "rewritten",
  "pending_deletion",
  "complete",
  "incomplete",
]);
export type ArchivePurgeStatus = z.infer<typeof ArchivePurgeStatusSchema>;

export const ArchivePurgeObjectStateSchema = z.enum([
  "planned",
  "replacement_written",
  "manifest_deleted",
  "data_deleted",
  "incomplete",
]);
export type ArchivePurgeObjectState = z.infer<
  typeof ArchivePurgeObjectStateSchema
>;

const EventIdListSchema = z
  .array(z.string().trim().min(1).max(1024))
  .max(MAX_ARCHIVE_EVENTS);

/** Durable operation state returned by the archive purge executor. */
export const ArchivePurgeOperationSchema = z
  .object({
    id: CanonicalResourceIdSchema,
    tenant_id: CanonicalResourceIdSchema,
    removal_id: CanonicalResourceIdSchema,
    resource_type: RemovalResourceTypeSchema,
    resource_id: z.string().trim().min(1).max(2_048),
    content_generation: z.string().trim().min(1).max(256),
    deletion_epoch: z.number().int().safe().positive(),
    status: ArchivePurgeStatusSchema,
    safety_deadline: TimestampSchema,
    failure_code: z.string().trim().min(1).max(1_024).nullable(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    completed_at: TimestampSchema.nullable(),
  })
  .strict();
export type ArchivePurgeOperation = z.infer<typeof ArchivePurgeOperationSchema>;

/**
 * Per-batch lineage is deliberately explicit.  It is the durable evidence
 * that a replacement still represents the same tenant/archive range and that
 * the old pair has been hidden/deleted (or why it remains incomplete).
 */
export const ArchivePurgeLineageSchema = z
  .object({
    operation_id: CanonicalResourceIdSchema,
    removal_id: CanonicalResourceIdSchema,
    tenant_id: CanonicalResourceIdSchema,
    resource_type: RemovalResourceTypeSchema,
    resource_id: z.string().trim().min(1).max(2_048),
    content_generation: z.string().trim().min(1).max(256),
    deletion_epoch: z.number().int().safe().positive(),
    original_manifest_key: ArchiveManifestKeySchema,
    original_data_key: ArchiveDataKeySchema,
    replacement_manifest_key: ArchiveManifestKeySchema.nullable(),
    replacement_data_key: ArchiveDataKeySchema.nullable(),
    original_canonical_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    replacement_canonical_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    original_first_event_id: z.string().trim().min(1).max(1024),
    original_last_event_id: z.string().trim().min(1).max(1024),
    replacement_first_event_id: z.string().trim().min(1).max(1024).nullable(),
    replacement_last_event_id: z.string().trim().min(1).max(1024).nullable(),
    original_event_count: z
      .number()
      .int()
      .safe()
      .positive()
      .max(MAX_ARCHIVE_EVENTS),
    replacement_event_count: z
      .number()
      .int()
      .safe()
      .nonnegative()
      .max(MAX_ARCHIVE_EVENTS),
    removed_event_ids: EventIdListSchema,
    retained_event_ids: EventIdListSchema,
    state: ArchivePurgeObjectStateSchema,
    manifest_deleted_at: TimestampSchema.nullable(),
    data_deleted_at: TimestampSchema.nullable(),
    last_error: z.string().trim().min(1).max(1_024).nullable(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .strict();
export type ArchivePurgeLineage = z.infer<typeof ArchivePurgeLineageSchema>;

export type ArchivePurgeResource = {
  tenant_id: string;
  resource_type: RemovalResourceType | string;
  resource_id: string;
  content_generation: string;
  removal_id: string;
  deletion_epoch: number;
};

export const operationIdForRemoval = (removalId: string): string =>
  `archive_purge_${removalId}`;
