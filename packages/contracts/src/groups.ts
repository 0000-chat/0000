import { z } from "zod";
import { ProviderSchema } from "./connection";
import { CommunicatorIdSchema, TimestampSchema } from "./ids";
import { WebhookSubscriptionEvaluationSchema } from "./webhooks";

const CandidateRevisionSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/** A participant must be selected from an account-bound, resolved contact. */
export const GroupParticipantRequestSchema = z
  .object({
    contact_id: CommunicatorIdSchema,
    candidate_revision: CandidateRevisionSchema,
  })
  .strict();
export type GroupParticipantRequest = z.infer<
  typeof GroupParticipantRequestSchema
>;

export const GroupCreateRequestSchema = z
  .object({
    identity_id: CommunicatorIdSchema,
    account_id: CommunicatorIdSchema,
    name: z.string().trim().min(1).max(100),
    participants: z.array(GroupParticipantRequestSchema).min(1).max(128),
    idempotency_key: z.string().trim().min(1).max(200),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const [index, participant] of value.participants.entries()) {
      if (ids.has(participant.contact_id)) {
        context.addIssue({
          code: "custom",
          path: ["participants", index, "contact_id"],
          message: "Participants must be unique",
        });
      }
      ids.add(participant.contact_id);
    }
  });
export type GroupCreateRequest = z.infer<typeof GroupCreateRequestSchema>;

export const GroupEvidenceSourceSchema = z.enum([
  "provider",
  "event",
  "refresh",
]);
export type GroupEvidenceSource = z.infer<typeof GroupEvidenceSourceSchema>;

export const GroupEvidenceSchema = z
  .object({
    source: GroupEvidenceSourceSchema,
    evidence_id: z.string().trim().min(1).max(256),
    observed_at: TimestampSchema,
    operation_id: CommunicatorIdSchema,
    account_id: CommunicatorIdSchema,
    connection_id: CommunicatorIdSchema,
    provider_group_id: z.string().trim().min(1).max(512),
    matrix_room_id: z.string().trim().min(1).max(512),
    participant_provider_ids: z
      .array(z.string().trim().min(1).max(512))
      .max(128),
    status: z.enum(["confirmed", "uncertain"]),
    reason: z.string().trim().min(1).max(200).nullable(),
  })
  .strict();
export type GroupEvidence = z.infer<typeof GroupEvidenceSchema>;

export const GroupCreationStatusSchema = z.enum([
  "pending",
  "created",
  "failed",
  "human_action_required",
]);
export type GroupCreationStatus = z.infer<typeof GroupCreationStatusSchema>;

export const GroupParticipantSchema = z
  .object({
    contact_id: CommunicatorIdSchema,
    candidate_revision: CandidateRevisionSchema,
    provider_id: z.string().trim().min(1).max(512),
    current_lid: z.string().trim().min(1).max(512).nullable(),
    display_name: z.string().trim().min(1).max(200),
  })
  .strict();
export type GroupParticipant = z.infer<typeof GroupParticipantSchema>;

export const GroupAccessGrantSchema = z
  .object({
    operation_scope: z.enum(["conversation.read", "message.send"]),
    grant_id: CommunicatorIdSchema,
    conversation_id: CommunicatorIdSchema,
    source: z.literal("group_creation"),
  })
  .strict();
export type GroupAccessGrant = z.infer<typeof GroupAccessGrantSchema>;

export const GroupCreationOperationSchema = z
  .object({
    operation_id: CommunicatorIdSchema,
    tenant_id: CommunicatorIdSchema,
    identity_id: CommunicatorIdSchema,
    account_id: CommunicatorIdSchema,
    connection_id: CommunicatorIdSchema,
    provider: ProviderSchema,
    conversation_id: CommunicatorIdSchema,
    name: z.string().trim().min(1).max(100),
    participants: z.array(GroupParticipantSchema).min(1).max(128),
    status: GroupCreationStatusSchema,
    provider_group_id: z.string().trim().min(1).max(512).nullable(),
    matrix_room_id: z.string().trim().min(1).max(512).nullable(),
    evidence: GroupEvidenceSchema.nullable(),
    evidence_path: GroupEvidenceSourceSchema.nullable(),
    duplicate_risk: z.boolean(),
    human_action_required: z.boolean(),
    failure_code: z.string().trim().min(1).max(200).nullable(),
    access_grants: z.array(GroupAccessGrantSchema).max(2),
    webhook_evaluations: z
      .array(WebhookSubscriptionEvaluationSchema)
      .max(10_000),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .strict();
export type GroupCreationOperation = z.infer<
  typeof GroupCreationOperationSchema
>;

export const GroupCreateResponseSchema = GroupCreationOperationSchema;
export type GroupCreateResponse = GroupCreationOperation;
