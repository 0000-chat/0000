import { z } from "zod";
import { ProviderSchema } from "./connection";
import { MessageSchema } from "./conversation";
import { CommunicatorIdSchema, TimestampSchema } from "./ids";
import { OutboundAuthorityMetadataSchema } from "./grants";

export const DeliveryModeSchema = z.enum(["direct", "paced"]);

export const OutboundEvidenceSourceSchema = z.enum([
  "matrix",
  "bridge",
  "provider",
  "refresh",
]);

export const OutboundEvidenceStatusSchema = z.enum([
  "confirmed",
  "accepted",
  "delivered",
  "uncertain",
]);

export const OutboundActionSchema = z.enum(["cancel", "continue", "resend"]);

export const OutboundStageSchema = z.enum([
  "unknown",
  "confirmed",
  "accepted",
  "delivered",
]);

export const CommandStatusSchema = z.enum([
  "accepted",
  "waiting_for_connection",
  "confirmation_required",
  "delivery_uncertain",
  "scheduled",
  "reading",
  "typing",
  "submitted_to_matrix",
  "matrix_confirmed",
  "bridged",
  "delivered",
  "cancelled",
  "unsupported",
  "failed",
]);

export const CommandSchema = z
  .object({
    id: CommunicatorIdSchema,
    tenant_id: CommunicatorIdSchema,
    identity_id: CommunicatorIdSchema,
    conversation_id: CommunicatorIdSchema,
    operation: z.enum(["message.send"]),
    delivery_mode: DeliveryModeSchema,
    status: CommandStatusSchema,
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    failure_code: z.string().max(100).optional(),
    /** Present on commands accepted by the durable outbound ledger. */
    account_id: CommunicatorIdSchema.optional(),
    connection_id: CommunicatorIdSchema.optional(),
    resource_identity_id: CommunicatorIdSchema.optional(),
    message_id: CommunicatorIdSchema.optional(),
    event_id: CommunicatorIdSchema.optional(),
    dispatch_id: CommunicatorIdSchema.optional(),
    transaction_id: CommunicatorIdSchema.optional(),
    request_digest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    body_digest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    authority: OutboundAuthorityMetadataSchema.optional(),
    dispatch_lease_id: CommunicatorIdSchema.optional(),
    dispatch_lease_expires_at: TimestampSchema.optional(),
    projection_generation: z.number().int().positive().optional(),
    uncertainty_reason: z.string().max(200).optional(),
    uncertain_at: TimestampSchema.optional(),
    matrix_stage: OutboundStageSchema.optional(),
    bridge_stage: OutboundStageSchema.optional(),
    provider_stage: OutboundStageSchema.optional(),
    last_evidence_at: TimestampSchema.optional(),
    chat_paused: z.boolean().optional(),
    duplicate_risk: z.boolean().optional(),
    resend_of_command_id: CommunicatorIdSchema.optional(),
    last_action: OutboundActionSchema.optional(),
    last_action_actor_principal_id: CommunicatorIdSchema.optional(),
    last_action_at: TimestampSchema.optional(),
    actor_principal_id: CommunicatorIdSchema.optional(),
    actor_identity_id: CommunicatorIdSchema.optional(),
    confirmation_due_at: TimestampSchema.optional(),
    confirmation_decision: z.enum(["confirm", "cancel"]).optional(),
    confirmation_actor_principal_id: CommunicatorIdSchema.optional(),
    confirmation_actor_identity_id: CommunicatorIdSchema.optional(),
    confirmation_decided_at: TimestampSchema.optional(),
  })
  .strict();

export const OutboundDispatchStatusSchema = z.enum([
  "pending",
  "waiting_for_connection",
  "confirmation_required",
  "delivery_uncertain",
  "wakeup_failed",
  "dispatching",
  "dispatched",
  "cancelled",
]);

export const ConfirmationDecisionSchema = z.enum(["confirm", "cancel"]);

export const OutboundDispatchSchema = z
  .object({
    id: CommunicatorIdSchema,
    tenant_id: CommunicatorIdSchema,
    command_id: CommunicatorIdSchema,
    message_id: CommunicatorIdSchema,
    event_id: CommunicatorIdSchema,
    actor_principal_id: CommunicatorIdSchema,
    actor_identity_id: CommunicatorIdSchema,
    resource_identity_id: CommunicatorIdSchema,
    account_id: CommunicatorIdSchema,
    connection_id: CommunicatorIdSchema,
    conversation_id: CommunicatorIdSchema,
    idempotency_key: z.string().min(1).max(200),
    status: OutboundDispatchStatusSchema,
    transaction_id: CommunicatorIdSchema,
    request_digest: z.string().regex(/^[0-9a-f]{64}$/),
    body_digest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    authority: OutboundAuthorityMetadataSchema.optional(),
    dispatch_lease_id: CommunicatorIdSchema.nullable().optional(),
    dispatch_lease_expires_at: TimestampSchema.nullable().optional(),
    uncertainty_reason: z.string().max(200).nullable().optional(),
    uncertain_at: TimestampSchema.nullable().optional(),
    projection_generation: z.number().int().positive().optional(),
    matrix_stage: OutboundStageSchema.optional(),
    bridge_stage: OutboundStageSchema.optional(),
    provider_stage: OutboundStageSchema.optional(),
    last_evidence_at: TimestampSchema.nullable().optional(),
    chat_paused: z.boolean().optional(),
    duplicate_risk: z.boolean().optional(),
    resend_of_command_id: CommunicatorIdSchema.nullable().optional(),
    last_action: OutboundActionSchema.optional(),
    last_action_actor_principal_id: CommunicatorIdSchema.optional(),
    last_action_at: TimestampSchema.optional(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    confirmation_due_at: TimestampSchema.nullable().optional(),
    confirmation_decision: ConfirmationDecisionSchema.optional(),
    confirmation_actor_principal_id: CommunicatorIdSchema.optional(),
    confirmation_actor_identity_id: CommunicatorIdSchema.optional(),
    confirmation_decided_at: TimestampSchema.optional(),
  })
  .strict();

/**
 * Internal payload released to the adapter only after a live dispatch lease
 * has been claimed.  The public dispatch and command projections deliberately
 * do not contain the saved message body.
 */
export const OutboundDispatchPayloadSchema = z
  .object({
    schema_version: z.literal(1),
    tenant_id: CommunicatorIdSchema,
    command_id: CommunicatorIdSchema,
    dispatch_id: CommunicatorIdSchema,
    message_id: CommunicatorIdSchema,
    event_id: CommunicatorIdSchema,
    identity_id: CommunicatorIdSchema,
    resource_identity_id: CommunicatorIdSchema,
    account_id: CommunicatorIdSchema,
    connection_id: CommunicatorIdSchema,
    conversation_id: CommunicatorIdSchema,
    provider: ProviderSchema,
    body: z.string().min(1).max(20_000),
    transaction_id: CommunicatorIdSchema,
    request_digest: z.string().regex(/^[0-9a-f]{64}$/),
    projection_generation: z.number().int().positive(),
    dispatch_lease_id: CommunicatorIdSchema,
    dispatch_lease_expires_at: TimestampSchema,
    body_digest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    authority: OutboundAuthorityMetadataSchema.optional(),
    created_at: TimestampSchema,
  })
  .strict();

export const GetOutboundDispatchPayloadInputSchema = z
  .object({
    schema_version: z.literal(1),
    tenant_id: CommunicatorIdSchema,
    command_id: CommunicatorIdSchema,
    lease_id: CommunicatorIdSchema,
    now: TimestampSchema,
  })
  .strict();

export const FailOutboundDispatchInputSchema = z
  .object({
    schema_version: z.literal(1),
    tenant_id: CommunicatorIdSchema,
    command_id: CommunicatorIdSchema,
    lease_id: CommunicatorIdSchema,
    now: TimestampSchema,
    failure_code: z.string().trim().min(1).max(100),
  })
  .strict();

export const OutboundEvidenceRecordSchema = z
  .object({
    id: z.string().trim().min(1).max(400),
    tenant_id: CommunicatorIdSchema,
    command_id: CommunicatorIdSchema,
    dispatch_id: CommunicatorIdSchema,
    source: OutboundEvidenceSourceSchema,
    evidence_id: z.string().trim().min(1).max(200),
    transaction_id: CommunicatorIdSchema,
    request_digest: z.string().regex(/^[0-9a-f]{64}$/),
    account_id: CommunicatorIdSchema,
    conversation_id: CommunicatorIdSchema,
    generation: z.number().int().positive(),
    status: OutboundEvidenceStatusSchema,
    observed_at: TimestampSchema,
    provider_operation_id: z.string().trim().min(1).max(200).nullable(),
    provider_message_id: z.string().trim().min(1).max(200).nullable(),
    remote_echo_id: z.string().trim().min(1).max(200).nullable(),
    reason: z.string().trim().min(1).max(200).nullable(),
    created_at: TimestampSchema,
  })
  .strict();

export const ListOutboundEvidenceInputSchema = z
  .object({
    schema_version: z.literal(1),
    tenant_id: CommunicatorIdSchema,
    command_id: CommunicatorIdSchema,
  })
  .strict();

export const AcceptTextReplyInputSchema = z
  .object({
    schema_version: z.literal(1),
    tenant_id: CommunicatorIdSchema,
    actor_principal_id: CommunicatorIdSchema,
    actor_identity_id: CommunicatorIdSchema,
    conversation_id: CommunicatorIdSchema,
    account_id: CommunicatorIdSchema.optional(),
    body: z.string().trim().min(1).max(20_000),
    delivery_mode: DeliveryModeSchema,
    idempotency_key: z.string().trim().min(1).max(200),
    accepted_at: TimestampSchema,
    initial_dispatch_status: z
      .enum(["pending", "waiting_for_connection"])
      .optional(),
    confirmation_due_at: TimestampSchema.nullable().optional(),
    authority: OutboundAuthorityMetadataSchema.optional(),
  })
  .strict();

/** Public API/MCP text payload; the server supplies tenant and actor claims. */
export const TextReplyRequestSchema = z
  .object({
    identity_id: CommunicatorIdSchema,
    conversation_id: CommunicatorIdSchema,
    account_id: CommunicatorIdSchema.optional(),
    body: z.string().trim().min(1).max(20_000),
    delivery_mode: DeliveryModeSchema,
  })
  .strict();

export const AcceptTextReplyResultSchema = z
  .object({
    command: CommandSchema,
    message: MessageSchema,
    dispatch: OutboundDispatchSchema,
    replayed: z.boolean(),
  })
  .strict();

export const OutboundDecisionInputSchema = z
  .object({
    schema_version: z.literal(1),
    tenant_id: CommunicatorIdSchema,
    command_id: CommunicatorIdSchema,
    decision: z.enum(["confirm", "cancel", "continue", "resend"]),
    idempotency_key: z.string().trim().min(1).max(200),
    actor_principal_id: CommunicatorIdSchema,
    actor_identity_id: CommunicatorIdSchema,
    decided_at: TimestampSchema,
    connection_available: z.boolean().optional(),
    duplicate_risk_acknowledged: z.boolean().optional(),
    resend_authority: OutboundAuthorityMetadataSchema.optional(),
  })
  .strict();

export const OutboundEvidenceInputSchema = z
  .object({
    schema_version: z.literal(1),
    tenant_id: CommunicatorIdSchema,
    command_id: CommunicatorIdSchema,
    source: OutboundEvidenceSourceSchema,
    evidence_id: z.string().trim().min(1).max(200),
    transaction_id: CommunicatorIdSchema,
    request_digest: z.string().regex(/^[0-9a-f]{64}$/),
    account_id: CommunicatorIdSchema,
    conversation_id: CommunicatorIdSchema,
    generation: z.number().int().positive(),
    status: OutboundEvidenceStatusSchema,
    observed_at: TimestampSchema,
    provider_operation_id: z.string().trim().min(1).max(200).optional(),
    provider_message_id: z.string().trim().min(1).max(200).optional(),
    remote_echo_id: z.string().trim().min(1).max(200).optional(),
    reason: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.source === "matrix" || value.source === "bridge") &&
      value.status === "delivered"
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Matrix and bridge evidence cannot claim provider delivery",
      });
    }
  });

export const OutboundReconcileInputSchema = z
  .object({
    schema_version: z.literal(1),
    tenant_id: CommunicatorIdSchema,
    command_id: CommunicatorIdSchema,
    now: TimestampSchema,
    connection_available: z.boolean().optional(),
    evidence: OutboundEvidenceInputSchema.optional(),
  })
  .strict();

export const ListOutboundCommandsInputSchema = z
  .object({
    schema_version: z.literal(1),
    tenant_id: CommunicatorIdSchema,
  })
  .strict();

export const OutboundDecisionResultSchema = z
  .object({
    command: CommandSchema,
    dispatch: OutboundDispatchSchema,
    replayed: z.boolean(),
    action: OutboundActionSchema.optional(),
    duplicate_risk: z.boolean().optional(),
  })
  .strict();

export const ResolveConversationOwnerInputSchema = z
  .object({
    schema_version: z.literal(1),
    tenant_id: CommunicatorIdSchema,
    conversation_id: CommunicatorIdSchema,
  })
  .strict();

export const ConversationOwnerSchema = z
  .object({
    tenant_id: CommunicatorIdSchema,
    conversation_id: CommunicatorIdSchema,
    identity_id: CommunicatorIdSchema,
    account_id: CommunicatorIdSchema,
    connection_id: CommunicatorIdSchema,
    platform: ProviderSchema,
  })
  .strict();

export type OutboundDispatchStatus = z.infer<
  typeof OutboundDispatchStatusSchema
>;
export type OutboundDispatch = z.infer<typeof OutboundDispatchSchema>;
export type OutboundDispatchPayload = z.infer<
  typeof OutboundDispatchPayloadSchema
>;
export type GetOutboundDispatchPayloadInput = z.infer<
  typeof GetOutboundDispatchPayloadInputSchema
>;
export type FailOutboundDispatchInput = z.infer<
  typeof FailOutboundDispatchInputSchema
>;
export type OutboundEvidenceRecord = z.infer<
  typeof OutboundEvidenceRecordSchema
>;
export type ListOutboundEvidenceInput = z.infer<
  typeof ListOutboundEvidenceInputSchema
>;
export type TextReplyRequest = z.infer<typeof TextReplyRequestSchema>;
export type AcceptTextReplyInput = z.infer<typeof AcceptTextReplyInputSchema>;
export type AcceptTextReplyResult = z.infer<typeof AcceptTextReplyResultSchema>;
export type OutboundDecisionInput = z.infer<typeof OutboundDecisionInputSchema>;
export type OutboundReconcileInput = z.infer<
  typeof OutboundReconcileInputSchema
>;
export type ListOutboundCommandsInput = z.infer<
  typeof ListOutboundCommandsInputSchema
>;
export type OutboundDecisionResult = z.infer<
  typeof OutboundDecisionResultSchema
>;
export type ConfirmationDecision = z.infer<typeof ConfirmationDecisionSchema>;
export type OutboundEvidenceSource = z.infer<
  typeof OutboundEvidenceSourceSchema
>;
export type OutboundEvidenceStatus = z.infer<
  typeof OutboundEvidenceStatusSchema
>;
export type OutboundAction = z.infer<typeof OutboundActionSchema>;
export type OutboundStage = z.infer<typeof OutboundStageSchema>;
export type OutboundEvidenceInput = z.infer<typeof OutboundEvidenceInputSchema>;
export type ResolveConversationOwnerInput = z.infer<
  typeof ResolveConversationOwnerInputSchema
>;
export type ConversationOwner = z.infer<typeof ConversationOwnerSchema>;

export type DeliveryMode = z.infer<typeof DeliveryModeSchema>;
export type CommandStatus = z.infer<typeof CommandStatusSchema>;
export type Command = z.infer<typeof CommandSchema>;
