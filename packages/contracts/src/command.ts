import { z } from "zod";
import { ProviderSchema } from "./connection";
import { MessageSchema } from "./conversation";
import { CommunicatorIdSchema, TimestampSchema } from "./ids";

export const DeliveryModeSchema = z.enum(["direct", "paced"]);

export const CommandStatusSchema = z.enum([
  "accepted",
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
    message_id: CommunicatorIdSchema.optional(),
    event_id: CommunicatorIdSchema.optional(),
    dispatch_id: CommunicatorIdSchema.optional(),
    actor_principal_id: CommunicatorIdSchema.optional(),
    actor_identity_id: CommunicatorIdSchema.optional(),
  })
  .strict();

export const OutboundDispatchStatusSchema = z.enum([
  "pending",
  "wakeup_failed",
  "dispatching",
  "dispatched",
]);

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
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
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
export type TextReplyRequest = z.infer<typeof TextReplyRequestSchema>;
export type AcceptTextReplyInput = z.infer<typeof AcceptTextReplyInputSchema>;
export type AcceptTextReplyResult = z.infer<typeof AcceptTextReplyResultSchema>;
export type ResolveConversationOwnerInput = z.infer<
  typeof ResolveConversationOwnerInputSchema
>;
export type ConversationOwner = z.infer<typeof ConversationOwnerSchema>;

export type DeliveryMode = z.infer<typeof DeliveryModeSchema>;
export type CommandStatus = z.infer<typeof CommandStatusSchema>;
export type Command = z.infer<typeof CommandSchema>;
