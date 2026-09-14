import { z } from "zod";
import { CommunicatorIdSchema, TimestampSchema } from "./ids";

export const ReceiptStageSchema = z.enum([
  "unknown",
  "accepted",
  "observed",
  "confirmed",
]);
export type ReceiptStage = z.infer<typeof ReceiptStageSchema>;

export const ReceiptOperationStatusSchema = z.enum([
  "requested",
  "accepted",
  "observed",
  "unknown",
  "rejected",
]);
export type ReceiptOperationStatus = z.infer<
  typeof ReceiptOperationStatusSchema
>;

export const ReceiptEvidenceSourceSchema = z.enum([
  "matrix",
  "bridge",
  "provider",
]);
export type ReceiptEvidenceSource = z.infer<typeof ReceiptEvidenceSourceSchema>;

export const ReceiptEvidenceStatusSchema = z.enum([
  "accepted",
  "observed",
  "confirmed",
  "uncertain",
]);
export type ReceiptEvidenceStatus = z.infer<typeof ReceiptEvidenceStatusSchema>;

export const ReceiptFailureCodeSchema = z.enum([
  "authorization_revoked",
  "account_mismatch",
  "connection_unavailable",
  "missing_capability",
  "stale_message",
  "provider_rejected",
  "provider_unavailable",
  "provider_timeout",
  "provider_protocol_error",
  "matrix_rejected",
  "receipt_conflict",
]);
export type ReceiptFailureCode = z.infer<typeof ReceiptFailureCodeSchema>;

export const ReadReceiptRequestSchema = z
  .object({
    schema_version: z.literal(1),
    identity_id: CommunicatorIdSchema,
    account_id: CommunicatorIdSchema,
    conversation_id: CommunicatorIdSchema,
    message_id: CommunicatorIdSchema,
    idempotency_key: z.string().trim().min(1).max(200),
  })
  .strict();
export type ReadReceiptRequest = z.infer<typeof ReadReceiptRequestSchema>;

export const ReceiptEvidenceSchema = z
  .object({
    source: ReceiptEvidenceSourceSchema,
    status: ReceiptEvidenceStatusSchema,
    evidence_id: z.string().trim().min(1).max(512),
    observed_at: TimestampSchema.optional(),
    reason: z.string().trim().min(1).max(200).optional(),
    provider_operation_id: z.string().trim().min(1).max(512).optional(),
  })
  .strict();
export type ReceiptEvidence = z.infer<typeof ReceiptEvidenceSchema>;

export const ReadReceiptOperationSchema = z
  .object({
    schema_version: z.literal(1),
    operation_id: CommunicatorIdSchema,
    tenant_id: CommunicatorIdSchema,
    identity_id: CommunicatorIdSchema,
    account_id: CommunicatorIdSchema,
    connection_id: CommunicatorIdSchema,
    conversation_id: CommunicatorIdSchema,
    message_id: CommunicatorIdSchema,
    matrix_room_id: z.string().trim().min(1).max(512).nullable(),
    matrix_event_id: z.string().trim().min(1).max(512).nullable(),
    status: ReceiptOperationStatusSchema,
    matrix_stage: z.enum(["unknown", "accepted"]),
    bridge_stage: z.enum(["unknown", "observed"]),
    provider_stage: z.enum(["unknown", "confirmed"]),
    failure_code: ReceiptFailureCodeSchema.nullable(),
    failure_reason: z.string().trim().min(1).max(200).nullable(),
    idempotency_key: z.string().trim().min(1).max(200),
    requested_at: TimestampSchema,
    updated_at: TimestampSchema,
    evidence: z.array(ReceiptEvidenceSchema).max(6),
  })
  .strict();
export type ReadReceiptOperation = z.infer<typeof ReadReceiptOperationSchema>;

export const ReadReceiptResultSchema = ReadReceiptOperationSchema.extend({
  replayed: z.boolean(),
}).strict();
export type ReadReceiptResult = z.infer<typeof ReadReceiptResultSchema>;

export const ReadReceiptOperationPageSchema = z
  .object({
    items: z.array(ReadReceiptOperationSchema),
    next_cursor: z.string().max(2_048).nullable(),
  })
  .strict();
export type ReadReceiptOperationPage = z.infer<
  typeof ReadReceiptOperationPageSchema
>;

export const ResolveReceiptTargetInputSchema = z
  .object({
    schema_version: z.literal(1),
    tenant_id: CommunicatorIdSchema,
    identity_id: CommunicatorIdSchema,
    account_id: CommunicatorIdSchema,
    conversation_id: CommunicatorIdSchema,
    message_id: CommunicatorIdSchema,
  })
  .strict();
export type ResolveReceiptTargetInput = z.infer<
  typeof ResolveReceiptTargetInputSchema
>;

export const ReceiptTargetSchema = z
  .object({
    schema_version: z.literal(1),
    tenant_id: CommunicatorIdSchema,
    identity_id: CommunicatorIdSchema,
    account_id: CommunicatorIdSchema,
    connection_id: CommunicatorIdSchema,
    conversation_id: CommunicatorIdSchema,
    message_id: CommunicatorIdSchema,
    platform: z.string().trim().min(1).max(64),
    event_id: z.string().trim().min(1).max(512).nullable(),
    matrix_room_id: z.string().trim().min(1).max(512).nullable(),
    matrix_event_id: z.string().trim().min(1).max(512).nullable(),
    occurred_at: TimestampSchema,
    deleted_at: TimestampSchema.nullable(),
  })
  .strict();
export type ReceiptTarget = z.infer<typeof ReceiptTargetSchema>;
