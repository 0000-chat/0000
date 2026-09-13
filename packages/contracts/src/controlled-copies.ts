import { z } from "zod";
import { CommunicatorIdSchema, TimestampSchema } from "./ids";

/**
 * A controlled copy is a recoverable copy that Communicator can inventory,
 * delete, quarantine, or age out.  It is deliberately separate from the
 * canonical archive: archive lineage has its own operation and evidence.
 */
export const CONTROLLED_COPY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const CONTROLLED_COPY_CLEANUP_MARGIN_MS = 24 * 60 * 60 * 1_000;
export const CONTROLLED_COPY_MAX_CLEANUP_AGE_MS =
  CONTROLLED_COPY_MAX_AGE_MS - CONTROLLED_COPY_CLEANUP_MARGIN_MS;

export const CONTROLLED_COPY_STORES = [
  "projection_backup",
  "synapse",
  "bridge_database",
  "media_store",
  "queue",
  "restic_snapshot",
] as const;
export const ControlledCopyStoreSchema = z.enum(CONTROLLED_COPY_STORES);
export type ControlledCopyStore = z.infer<typeof ControlledCopyStoreSchema>;

/** Session material is inventoried separately and is never a message purge target. */
export const ControlledCopyAuxiliaryStoreSchema = z.enum([
  "session_credentials",
  "account_keys",
]);
export type ControlledCopyAuxiliaryStore = z.infer<
  typeof ControlledCopyAuxiliaryStoreSchema
>;

export const ControlledCopyContentClassSchema = z.enum([
  "message",
  "attachment",
  "bridge_mapping",
  "queue_item",
  "session_credential",
  "account_key",
  "inventory",
]);
export type ControlledCopyContentClass = z.infer<
  typeof ControlledCopyContentClassSchema
>;

export const ControlledCopyDeletionMethodSchema = z.enum([
  "delete",
  "quarantine",
  "expire",
  "age_out",
  "preserve",
]);
export type ControlledCopyDeletionMethod = z.infer<
  typeof ControlledCopyDeletionMethodSchema
>;

export const ControlledCopyOperationStatusSchema = z.enum([
  "planned",
  "leased",
  "complete",
  "preserved",
  "incomplete",
  "failed",
]);
export type ControlledCopyOperationStatus = z.infer<
  typeof ControlledCopyOperationStatusSchema
>;

export const ControlledCopyEvidenceStatusSchema = z.enum([
  "deleted",
  "quarantined",
  "expired",
  "aged_out",
  "preserved",
  "missing",
  "permission_denied",
  "lifecycle_pending",
  "unknown",
  "failed",
]);
export type ControlledCopyEvidenceStatus = z.infer<
  typeof ControlledCopyEvidenceStatusSchema
>;

const OpaqueReferenceSchema = z.string().trim().min(1).max(2_048);
const DetailSchema = z.string().trim().min(1).max(4_096);
const WorkerTokenSchema = z.string().trim().min(1).max(256);

/** One discovered copy, before it receives a durable operation id. */
export const ControlledCopyInventoryItemSchema = z
  .object({
    store: z.union([
      ControlledCopyStoreSchema,
      ControlledCopyAuxiliaryStoreSchema,
    ]),
    owner: z.string().trim().min(1).max(128),
    content_class: ControlledCopyContentClassSchema,
    resource_id: OpaqueReferenceSchema,
    content_generation: z.string().trim().min(1).max(256),
    reference: OpaqueReferenceSchema,
    copy_created_at: TimestampSchema,
    deletion_method: ControlledCopyDeletionMethodSchema,
    required: z.boolean(),
  })
  .strict();
export type ControlledCopyInventoryItem = z.infer<
  typeof ControlledCopyInventoryItemSchema
>;

/** Durable per-store state.  `required` excludes separate session lifecycles. */
export const ControlledCopyOperationSchema = z
  .object({
    id: CommunicatorIdSchema,
    tenant_id: CommunicatorIdSchema,
    removal_id: CommunicatorIdSchema,
    resource_type: z.string().trim().min(1).max(64),
    resource_id: OpaqueReferenceSchema,
    content_generation: z.string().trim().min(1).max(256),
    deletion_epoch: z.number().int().safe().positive(),
    store: z.union([
      ControlledCopyStoreSchema,
      ControlledCopyAuxiliaryStoreSchema,
    ]),
    owner: z.string().trim().min(1).max(128),
    content_class: ControlledCopyContentClassSchema,
    reference: OpaqueReferenceSchema,
    deletion_method: ControlledCopyDeletionMethodSchema,
    required: z.boolean(),
    copy_created_at: TimestampSchema,
    cleanup_margin_ms: z
      .number()
      .int()
      .nonnegative()
      .lt(CONTROLLED_COPY_MAX_AGE_MS),
    cleanup_deadline: TimestampSchema,
    retention_deadline: TimestampSchema,
    status: ControlledCopyOperationStatusSchema,
    lease_token: WorkerTokenSchema.nullable(),
    lease_expires_at: TimestampSchema.nullable(),
    last_error: DetailSchema.nullable(),
    completed_at: TimestampSchema.nullable(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .strict();
export type ControlledCopyOperation = z.infer<
  typeof ControlledCopyOperationSchema
>;

/** Append-only evidence for one worker attempt or store observation. */
export const ControlledCopyEvidenceSchema = z
  .object({
    id: CommunicatorIdSchema,
    operation_id: CommunicatorIdSchema,
    tenant_id: CommunicatorIdSchema,
    removal_id: CommunicatorIdSchema,
    store: z.union([
      ControlledCopyStoreSchema,
      ControlledCopyAuxiliaryStoreSchema,
    ]),
    resource_id: OpaqueReferenceSchema,
    content_generation: z.string().trim().min(1).max(256),
    deletion_epoch: z.number().int().safe().positive(),
    status: ControlledCopyEvidenceStatusSchema,
    content_present: z.boolean(),
    evidence_source: z.string().trim().min(1).max(256),
    object_reference: OpaqueReferenceSchema.nullable(),
    detail: DetailSchema.nullable(),
    worker_token: WorkerTokenSchema,
    observed_at: TimestampSchema,
  })
  .strict();
export type ControlledCopyEvidence = z.infer<
  typeof ControlledCopyEvidenceSchema
>;

export const ControlledCopyCanonicalArchiveStatusSchema = z.enum([
  "complete",
  "incomplete",
  "missing",
]);
export type ControlledCopyCanonicalArchiveStatus = z.infer<
  typeof ControlledCopyCanonicalArchiveStatusSchema
>;

const RequiredControlledCopyStoresSchema = z
  .array(ControlledCopyStoreSchema)
  .length(CONTROLLED_COPY_STORES.length)
  .refine(
    (stores) =>
      new Set(stores).size === CONTROLLED_COPY_STORES.length &&
      CONTROLLED_COPY_STORES.every((store) => stores.includes(store)),
    "all required controlled-copy stores must be present exactly once",
  );

/**
 * The result consumed by the restore gate and administrator view.  A
 * successful controlled-copy pass still remains incomplete until the caller
 * supplies completion evidence from the canonical archive operation.
 */
export const ControlledCopyCompletionSchema = z
  .object({
    tenant_id: CommunicatorIdSchema,
    removal_id: CommunicatorIdSchema,
    resource_id: OpaqueReferenceSchema,
    content_generation: z.string().trim().min(1).max(256),
    deletion_epoch: z.number().int().safe().positive(),
    status: z.enum(["complete", "incomplete"]),
    canonical_archive: ControlledCopyCanonicalArchiveStatusSchema,
    required_stores: RequiredControlledCopyStoresSchema,
    completed_stores: z.array(ControlledCopyStoreSchema).max(100),
    incomplete_stores: z.array(ControlledCopyStoreSchema).max(100),
    missing_stores: z.array(ControlledCopyStoreSchema).max(100),
    auxiliary_operations: z.array(ControlledCopyOperationSchema).max(1_000),
    alerts: z.array(z.string().trim().min(1).max(256)).max(100),
    checked_at: TimestampSchema,
  })
  .strict();
export type ControlledCopyCompletion = z.infer<
  typeof ControlledCopyCompletionSchema
>;

export const ControlledCopyEvidenceInputSchema = z
  .object({
    status: ControlledCopyEvidenceStatusSchema,
    content_present: z.boolean(),
    evidence_source: z.string().trim().min(1).max(256),
    object_reference: OpaqueReferenceSchema.nullable().default(null),
    detail: DetailSchema.nullable().default(null),
  })
  .strict();
export type ControlledCopyEvidenceInput = z.input<
  typeof ControlledCopyEvidenceInputSchema
>;

export type ControlledCopyLineage = {
  tenant_id: string;
  removal_id: string;
  resource_type: string;
  resource_id: string;
  content_generation: string;
  deletion_epoch: number;
};
