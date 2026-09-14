import { z } from "zod";
import { CommunicatorIdSchema, TimestampSchema } from "./ids";
import {
  CONTROLLED_COPY_STORES,
  ControlledCopyAuxiliaryStoreSchema,
  ControlledCopyStoreSchema,
} from "./controlled-copies";
import { ProjectionStatusSchema } from "./projection";

export const RESTORE_GATE_STAGES = [
  "authority_loaded",
  "payload_validated",
  "store_evidence_validated",
  "content_sanitized",
  "tombstones_reapplied",
  "ready",
] as const;
export const RestoreGateStageSchema = z.enum(RESTORE_GATE_STAGES);
export type RestoreGateStage = z.infer<typeof RestoreGateStageSchema>;

export const RestoreGateStateSchema = z.enum([
  "authority_ready",
  "ready",
  "blocked",
  "incomplete",
]);
export type RestoreGateState = z.infer<typeof RestoreGateStateSchema>;

export const RestoreInventoryCopySchema = z
  .object({
    reference: z.string().trim().min(1).max(2_048),
    copy_created_at: TimestampSchema,
    resource_id: z.string().trim().min(1).max(2_048),
    content_generation: z.string().trim().min(1).max(256),
  })
  .strict();
export type RestoreInventoryCopy = z.infer<typeof RestoreInventoryCopySchema>;

export const RestoreStoreStatusSchema = z
  .object({
    store: z.union([
      ControlledCopyStoreSchema,
      ControlledCopyAuxiliaryStoreSchema,
    ]),
    generation: z.string().trim().min(1).max(256),
    status: z.enum([
      "complete",
      "preserved",
      "incomplete",
      "missing",
      "unknown",
    ]),
    content_present: z.boolean(),
    evidence_source: z.string().trim().min(1).max(256),
    detail: z.string().trim().min(1).max(4_096).nullable(),
    /** Concrete provider copy/snapshot references covered by this status. */
    references: z.array(z.string().trim().min(1).max(2_048)).max(10_000),
    /** Metadata binding each reference to the exact copied generation. */
    copies: z.array(z.lazy(() => RestoreInventoryCopySchema)).max(10_000),
  })
  .strict();
export type RestoreStoreStatus = z.infer<typeof RestoreStoreStatusSchema>;

export const RestoreStageEvidenceSchema = z
  .object({
    stage: RestoreGateStageSchema,
    status: z.enum(["complete", "blocked", "incomplete"]),
    detail: z.string().trim().min(1).max(4_096).nullable(),
    observed_at: TimestampSchema,
  })
  .strict();
export type RestoreStageEvidence = z.infer<typeof RestoreStageEvidenceSchema>;

const RequiredRestoreStoresSchema = z
  .array(ControlledCopyStoreSchema)
  .length(CONTROLLED_COPY_STORES.length)
  .refine(
    (stores) =>
      new Set(stores).size === CONTROLLED_COPY_STORES.length &&
      CONTROLLED_COPY_STORES.every((store) => stores.includes(store)),
    "restore report must name every required controlled store",
  );

export const RestoreReadinessSchema = z
  .object({
    tenant_id: CommunicatorIdSchema,
    deletion_epoch: z.number().int().safe().nonnegative(),
    authority_ids: z.array(CommunicatorIdSchema).max(10_000),
    authority_count: z.number().int().safe().nonnegative(),
    required_stores: RequiredRestoreStoresSchema,
    stores: z.array(RestoreStoreStatusSchema).max(10_000),
    incomplete_stores: z.array(ControlledCopyStoreSchema).max(100),
    blocked_reasons: z.array(z.string().trim().min(1).max(256)).max(100),
    state: z.enum(["ready", "blocked", "incomplete"]),
    checked_at: TimestampSchema,
  })
  .strict();
export type RestoreReadiness = z.infer<typeof RestoreReadinessSchema>;

export const RestoreReplayEvidenceSchema = z
  .object({
    tenant_id: CommunicatorIdSchema,
    deletion_epoch: z.number().int().safe().nonnegative(),
    authority_ids: z.array(CommunicatorIdSchema).max(10_000),
    removed_event_ids: z
      .array(z.string().trim().min(1).max(2_048))
      .max(100_000),
    changed_event_ids: z
      .array(z.string().trim().min(1).max(2_048))
      .max(100_000),
    rejected_event_ids: z
      .array(z.string().trim().min(1).max(2_048))
      .max(100_000),
    tombstones_reapplied: z.array(CommunicatorIdSchema).max(10_000),
  })
  .strict();
export type RestoreReplayEvidence = z.infer<typeof RestoreReplayEvidenceSchema>;

/** Result of the real control-plane archive-to-projection restore caller. */
export const RestoreProjectionActivationResultSchema = z
  .object({
    tenant_id: CommunicatorIdSchema,
    rebuild_id: CommunicatorIdSchema,
    deletion_epoch: z.number().int().safe().nonnegative(),
    page_count: z.number().int().safe().nonnegative(),
    removed_event_ids: z
      .array(z.string().trim().min(1).max(2_048))
      .max(100_000),
    changed_event_ids: z
      .array(z.string().trim().min(1).max(2_048))
      .max(100_000),
    readiness: RestoreReadinessSchema,
    projection: ProjectionStatusSchema,
  })
  .strict();
export type RestoreProjectionActivationResult = z.infer<
  typeof RestoreProjectionActivationResultSchema
>;

export const RestoreActivationLeaseSchema = z
  .object({
    lease_id: CommunicatorIdSchema,
    tenant_id: CommunicatorIdSchema,
    lease_token: z.string().trim().min(32).max(256),
    deletion_epoch: z.number().int().safe().nonnegative(),
    ledger_head: z.string().trim().min(1).max(256),
    expires_at: TimestampSchema,
  })
  .strict();
export type RestoreActivationLease = z.infer<
  typeof RestoreActivationLeaseSchema
>;

export const RestoreActivationLeaseReleaseSchema = z
  .object({
    released: z.boolean(),
    lease_id: CommunicatorIdSchema,
  })
  .strict();
export type RestoreActivationLeaseRelease = z.infer<
  typeof RestoreActivationLeaseReleaseSchema
>;

/**
 * Exact host-side locations are part of the current authority export.  A
 * restore may not infer a database row or media path from a resource id: the
 * control plane must publish the mapping that it observed while recording the
 * removal.  Empty mappings remain valid at the transport boundary so the
 * host gate can report them as blocked instead of silently guessing.
 */
export const RestoreDatabaseTargetSchema = z
  .object({
    database: z.enum([
      "synapse",
      "whatsapp_bridge",
      "messenger_bridge",
      "telegram_bridge",
    ]),
    contract: z.string().trim().min(1).max(128),
    resource_id: z.string().trim().min(1).max(2_048),
    content_generation: z.string().trim().min(1).max(256),
    room_id: z.string().trim().min(1).max(2_048).optional(),
    event_id: z.string().trim().min(1).max(2_048).optional(),
    event_type: z.string().trim().min(1).max(256).optional(),
    bridge_id: z.string().trim().min(1).max(256).optional(),
    message_id: z.string().trim().min(1).max(2_048).optional(),
    part_id: z.string().trim().min(1).max(256).optional(),
    media_paths: z
      .array(z.string().trim().min(1).max(2_048))
      .max(10_000)
      .optional(),
    media_paths_complete: z.boolean().optional(),
  })
  .strict();
export type RestoreDatabaseTarget = z.infer<typeof RestoreDatabaseTargetSchema>;

const RestoreAuthorityRecordSchema = z
  .object({
    id: CommunicatorIdSchema,
    tenant_id: CommunicatorIdSchema,
    resource_type: z.string().trim().min(1).max(64),
    resource_id: z.string().trim().min(1).max(2_048),
    content_generation: z.string().trim().min(1).max(256),
    account_id: CommunicatorIdSchema.nullable(),
    conversation_id: CommunicatorIdSchema.nullable(),
    source_event_id: z.string().trim().min(1).max(2_048).nullable(),
    source_object_key: z.string().trim().min(1).max(2_048).nullable(),
    reason: z.enum(["requested", "expired", "retention"]),
    removed_at: TimestampSchema,
    deletion_epoch: z.number().int().safe().positive(),
    status: z.enum(["active", "completed", "failed"]),
    purge_status: z.enum(["not_started", "pending", "complete", "failed"]),
    failure_code: z.string().trim().min(1).max(512).nullable(),
    completed_at: TimestampSchema.nullable(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    /** Empty only when the current application has no exact mapping yet. */
    targets: z.array(RestoreDatabaseTargetSchema).max(10_000),
  })
  .strict();
export type RestoreAuthorityRecord = z.infer<
  typeof RestoreAuthorityRecordSchema
>;

const RestoreInventoryStoreSchema = z
  .object({
    store: z.union([
      ControlledCopyStoreSchema,
      ControlledCopyAuxiliaryStoreSchema,
    ]),
    complete: z.boolean(),
    evidence_source: z.string().trim().min(1).max(256),
    detail: z.string().trim().min(1).max(4_096).nullable(),
    references: z.array(z.string().trim().min(1).max(2_048)).max(10_000),
    copies: z.array(RestoreInventoryCopySchema).max(10_000),
  })
  .strict();

export const RestoreAuthorityInventorySchema = z
  .object({
    authority_id: CommunicatorIdSchema,
    targets: z.array(RestoreDatabaseTargetSchema).max(10_000),
    stores: z.array(RestoreInventoryStoreSchema).max(10_000),
  })
  .strict();
export type RestoreAuthorityInventory = z.infer<
  typeof RestoreAuthorityInventorySchema
>;

export const RestoreArchiveEvidenceSchema = z
  .object({
    status: z.enum(["complete", "incomplete", "missing"]),
    generation: z.string().trim().min(1).max(256),
    evidence_source: z.string().trim().min(1).max(256),
  })
  .strict();
export type RestoreArchiveEvidence = z.infer<
  typeof RestoreArchiveEvidenceSchema
>;

/**
 * Authenticated response served by the current control-plane ledger.  The
 * ledger head is compared again after the isolated payload is sanitised, so a
 * removal recorded during restore blocks activation.
 */
export const RestoreAuthorityExportSchema = z
  .object({
    version: z.literal(1),
    tenant_id: CommunicatorIdSchema,
    deletion_epoch: z.number().int().safe().nonnegative(),
    authority_ids: z.array(CommunicatorIdSchema).max(10_000),
    authority_count: z.number().int().safe().nonnegative(),
    authorities: z.array(RestoreAuthorityRecordSchema).max(10_000),
    inventory: z.array(RestoreAuthorityInventorySchema).max(10_000),
    ledger_head: z.string().regex(/^[a-f0-9]{64}$/u),
    stores: z.array(RestoreStoreStatusSchema).max(10_000),
    archive: RestoreArchiveEvidenceSchema,
    issued_at: TimestampSchema,
    expires_at: TimestampSchema,
  })
  .strict();
export type RestoreAuthorityExport = z.infer<
  typeof RestoreAuthorityExportSchema
>;
