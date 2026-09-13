import { z } from "zod";
import { ProviderSchema } from "./connection";
import { CommunicatorIdSchema, TimestampSchema } from "./ids";

export const ProviderCapabilityNameSchema = z.enum([
  "history.import",
  "media.read",
  "contact.lookup",
  "group.manage",
  "receipt.read",
  "message.send.text",
  "account.route",
]);

export type ProviderCapabilityName = z.infer<
  typeof ProviderCapabilityNameSchema
>;

export const ProviderCapabilityStatusSchema = z.enum([
  "supported",
  "conditional",
  "unverified",
  "unsupported",
]);

export type ProviderCapabilityStatus = z.infer<
  typeof ProviderCapabilityStatusSchema
>;

export const CapabilityFreshnessSchema = z.enum([
  "fresh",
  "stale",
  "unknown",
  "unavailable",
]);

export type CapabilityFreshness = z.infer<typeof CapabilityFreshnessSchema>;

export const ProviderEvidenceSchema = z
  .object({
    provider_version: z.string().trim().min(1).max(128).nullable(),
    proof_source: z.string().trim().min(1).max(512),
    summary: z.string().trim().min(1).max(2_000),
    observed_at: TimestampSchema.nullable(),
  })
  .strict();

export type ProviderEvidence = z.infer<typeof ProviderEvidenceSchema>;

/**
 * Provider evidence and the product claim are deliberately separate fields.
 * A source can describe an upstream feature without proving that this
 * deployment can use it for an account.
 */
export const ProviderCapabilitySchema = z
  .object({
    tenant_id: CommunicatorIdSchema,
    account_id: CommunicatorIdSchema,
    connection_id: CommunicatorIdSchema,
    identity_id: CommunicatorIdSchema,
    provider: ProviderSchema,
    capability: ProviderCapabilityNameSchema,
    status: ProviderCapabilityStatusSchema,
    freshness: CapabilityFreshnessSchema,
    provider_version: z.string().trim().min(1).max(128).nullable(),
    proof_source: z.string().trim().min(1).max(512),
    provider_evidence: ProviderEvidenceSchema,
    product_claim: z.string().trim().min(1).max(2_000),
    observed_at: TimestampSchema.nullable(),
    updated_at: TimestampSchema,
  })
  .strict();

export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>;

export const HistoryImportStatusSchema = z.enum([
  "started",
  "active",
  "completed",
  "partial",
  "failed",
]);

export type HistoryImportStatus = z.infer<typeof HistoryImportStatusSchema>;

export const HistoryImportAvailabilitySchema = z.enum([
  "available",
  "blocked",
  "unavailable",
]);

export type HistoryImportAvailability = z.infer<
  typeof HistoryImportAvailabilitySchema
>;

export const HistoryImportFailureCodeSchema = z.enum([
  "runtime_unavailable",
  "provider_refused",
  "provider_timeout",
  "provider_error",
  "malformed_range",
  "duplicate_event_conflict",
  "interrupted",
  "bounded_retry_exhausted",
]);

export type HistoryImportFailureCode = z.infer<
  typeof HistoryImportFailureCodeSchema
>;

export const HistoryImportRangeStatusSchema = z.enum([
  "pending",
  "active",
  "completed",
  "partial",
  "failed",
  "gap",
]);

export type HistoryImportRangeStatus = z.infer<
  typeof HistoryImportRangeStatusSchema
>;

export const HistoryImportRangeSchema = z
  .object({
    range_id: CommunicatorIdSchema,
    import_id: CommunicatorIdSchema,
    account_id: CommunicatorIdSchema,
    start_at: TimestampSchema,
    end_at: TimestampSchema,
    status: HistoryImportRangeStatusSchema,
    attempt_count: z.number().int().safe().nonnegative().max(10),
    event_count: z.number().int().safe().nonnegative(),
    source_cursor: z.string().trim().min(1).max(2_048).nullable(),
    gap_code: z.string().trim().min(1).max(128).nullable(),
    error_code: HistoryImportFailureCodeSchema.nullable(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    completed_at: TimestampSchema.nullable(),
  })
  .strict();

export type HistoryImportRange = z.infer<typeof HistoryImportRangeSchema>;

export const HistoryImportSchema = z
  .object({
    import_id: CommunicatorIdSchema,
    tenant_id: CommunicatorIdSchema,
    account_id: CommunicatorIdSchema,
    connection_id: CommunicatorIdSchema,
    identity_id: CommunicatorIdSchema,
    provider: ProviderSchema,
    status: HistoryImportStatusSchema,
    availability: HistoryImportAvailabilitySchema,
    requested_start_at: TimestampSchema,
    requested_end_at: TimestampSchema,
    source_start_at: TimestampSchema.nullable(),
    source_end_at: TimestampSchema.nullable(),
    max_events: z.number().int().safe().positive().max(100_000),
    event_count: z.number().int().safe().nonnegative(),
    completed_range_count: z.number().int().safe().nonnegative(),
    total_range_count: z.number().int().safe().positive(),
    gap_count: z.number().int().safe().nonnegative(),
    attempt_count: z.number().int().safe().nonnegative().max(10),
    max_attempts: z.number().int().safe().positive().max(10),
    last_error_code: HistoryImportFailureCodeSchema.nullable(),
    started_at: TimestampSchema,
    updated_at: TimestampSchema,
    completed_at: TimestampSchema.nullable(),
  })
  .strict();

export type HistoryImport = z.infer<typeof HistoryImportSchema>;

export const HistoryImportDetailSchema = z
  .object({
    import: HistoryImportSchema,
    ranges: z.array(HistoryImportRangeSchema).max(100),
    capabilities: z.array(ProviderCapabilitySchema).max(20),
  })
  .strict();

export type HistoryImportDetail = z.infer<typeof HistoryImportDetailSchema>;

export const HistoryImportPageSchema = z
  .object({
    items: z.array(HistoryImportSchema).max(100),
    next_cursor: z.string().trim().min(1).max(2_048).nullable(),
  })
  .strict();

export type HistoryImportPage = z.infer<typeof HistoryImportPageSchema>;

export const HistoryCoverageStateSchema = z.enum([
  "not_imported",
  "empty",
  "available",
  "partial",
  "unavailable",
]);

export type HistoryCoverageState = z.infer<typeof HistoryCoverageStateSchema>;

/** Stored-read metadata: an empty chat is different from a range we have not imported. */
export const HistoryCoverageSchema = z
  .object({
    state: HistoryCoverageStateSchema,
    account_id: CommunicatorIdSchema,
    latest_import_id: CommunicatorIdSchema.nullable(),
    requested_start_at: TimestampSchema.nullable(),
    requested_end_at: TimestampSchema.nullable(),
    known_gap_count: z.number().int().safe().nonnegative(),
  })
  .strict();

export type HistoryCoverage = z.infer<typeof HistoryCoverageSchema>;

export const HistoryImportStartRequestSchema = z
  .object({
    identity_id: CommunicatorIdSchema,
    start_at: TimestampSchema,
    end_at: TimestampSchema,
    max_events: z.number().int().safe().positive().max(100_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.start_at) >= Date.parse(value.end_at)) {
      context.addIssue({
        code: "custom",
        path: ["end_at"],
        message: "History range end must be after its start",
      });
    }
  });

export type HistoryImportStartRequest = z.infer<
  typeof HistoryImportStartRequestSchema
>;

export const HistoryImportAdvanceRequestSchema = z
  .object({
    identity_id: CommunicatorIdSchema,
    range_id: CommunicatorIdSchema.optional(),
  })
  .strict();

export type HistoryImportAdvanceRequest = z.infer<
  typeof HistoryImportAdvanceRequestSchema
>;
