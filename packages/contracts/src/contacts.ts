import { z } from "zod";
import { ProviderSchema } from "./connection";
import { CommunicatorIdSchema, TimestampSchema } from "./ids";

/** The source operation that produced a contact or chat-creation observation. */
export const ContactEvidenceOperationSchema = z.enum([
  "search",
  "resolve",
  "create_dm",
]);
export type ContactEvidenceOperation = z.infer<
  typeof ContactEvidenceOperationSchema
>;

export const ContactEvidenceSourceSchema = z.enum(["bridge", "provider"]);
export type ContactEvidenceSource = z.infer<typeof ContactEvidenceSourceSchema>;

/** Evidence is deliberately separate from the selected account and result state. */
export const ContactProviderEvidenceSchema = z
  .object({
    source: ContactEvidenceSourceSchema,
    operation: ContactEvidenceOperationSchema,
    evidence_id: z.string().trim().min(1).max(256),
    observed_at: TimestampSchema,
    provider_id: z.string().trim().min(1).max(512),
    matrix_room_id: z.string().trim().min(1).max(512).nullable(),
    status: z.enum(["confirmed", "already_exists", "uncertain"]),
    reason: z.string().trim().min(1).max(200).nullable(),
  })
  .strict();
export type ContactProviderEvidence = z.infer<
  typeof ContactProviderEvidenceSchema
>;

export const ContactMatchReasonSchema = z.enum([
  "name",
  "phone",
  "provider_id",
]);
export type ContactMatchReason = z.infer<typeof ContactMatchReasonSchema>;

/**
 * A candidate is account-bound.  `contact_id` is stable for the account and
 * the provider's stable identifier when one is available; the provider ID and
 * LID are current observations and may change after a later resolution.
 */
export const ContactCandidateSchema = z
  .object({
    contact_id: CommunicatorIdSchema,
    tenant_id: CommunicatorIdSchema,
    identity_id: CommunicatorIdSchema,
    account_id: CommunicatorIdSchema,
    connection_id: CommunicatorIdSchema,
    provider: ProviderSchema,
    provider_id: z.string().trim().min(1).max(512),
    current_lid: z.string().trim().min(1).max(512).nullable(),
    display_name: z.string().trim().min(1).max(200),
    identifiers: z.array(z.string().trim().min(1).max(512)).max(32),
    match_reason: ContactMatchReasonSchema,
    candidate_revision: z.string().regex(/^[0-9a-f]{64}$/),
    observed_at: TimestampSchema,
    evidence: ContactProviderEvidenceSchema,
  })
  .strict();
export type ContactCandidate = z.infer<typeof ContactCandidateSchema>;

export const ContactSearchRequestSchema = z
  .object({
    identity_id: CommunicatorIdSchema,
    account_id: CommunicatorIdSchema,
    query: z.string().trim().min(1).max(200),
  })
  .strict();
export type ContactSearchRequest = z.infer<typeof ContactSearchRequestSchema>;

export const ContactSearchPageSchema = z
  .object({
    items: z.array(ContactCandidateSchema).max(100),
    next_cursor: z.string().trim().min(1).max(2_048).nullable(),
  })
  .strict();
export type ContactSearchPage = z.infer<typeof ContactSearchPageSchema>;

export const ContactResolveRequestSchema = z
  .object({
    identity_id: CommunicatorIdSchema,
    account_id: CommunicatorIdSchema,
    phone: z.string().trim().min(1).max(32),
  })
  .strict();
export type ContactResolveRequest = z.infer<typeof ContactResolveRequestSchema>;

export const ContactResolutionSchema = z
  .object({
    status: z.enum(["resolved", "unsupported", "unresolved"]),
    candidate: ContactCandidateSchema.nullable(),
    reason: z.string().trim().min(1).max(200).nullable(),
  })
  .strict();
export type ContactResolution = z.infer<typeof ContactResolutionSchema>;

export const CreateDirectChatRequestSchema = z
  .object({
    identity_id: CommunicatorIdSchema,
    account_id: CommunicatorIdSchema,
    contact_id: CommunicatorIdSchema,
    candidate_revision: z.string().regex(/^[0-9a-f]{64}$/),
    idempotency_key: z.string().trim().min(1).max(200),
  })
  .strict();
export type CreateDirectChatRequest = z.infer<
  typeof CreateDirectChatRequestSchema
>;

export const DirectChatSchema = z
  .object({
    conversation_id: CommunicatorIdSchema,
    tenant_id: CommunicatorIdSchema,
    identity_id: CommunicatorIdSchema,
    account_id: CommunicatorIdSchema,
    connection_id: CommunicatorIdSchema,
    provider: ProviderSchema,
    contact_id: CommunicatorIdSchema,
    provider_id: z.string().trim().min(1).max(512),
    current_lid: z.string().trim().min(1).max(512).nullable(),
    matrix_room_id: z.string().trim().min(1).max(512),
    status: z.enum(["created", "already_exists"]),
    evidence: ContactProviderEvidenceSchema,
    created_at: TimestampSchema,
  })
  .strict();
export type DirectChat = z.infer<typeof DirectChatSchema>;
