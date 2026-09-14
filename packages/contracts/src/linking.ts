import { z } from "zod";
import { CommunicatorIdSchema, TimestampSchema } from "./ids";
import { ProviderSchema } from "./connection";

export const LinkSessionStatusSchema = z.enum([
  "created",
  "awaiting_user",
  "authenticating",
  "connected",
  "expired",
  "failed",
  "cancelled",
  "relink_required",
  "reconciliation_required",
]);

export const LinkSessionActionSchema = z.enum(["scan_qr", "wait", "none"]);

export const LinkSessionErrorCodeSchema = z.enum([
  "provider_unavailable",
  "provider_error",
  "provisioning_disabled",
  "identity_mismatch",
  "relink_required",
  "reconciliation_required",
  "expired",
  "cancelled",
]);

export const LinkSessionSchema = z
  .object({
    id: CommunicatorIdSchema,
    identity_id: CommunicatorIdSchema,
    provider: ProviderSchema,
    generation: z.number().int().positive(),
    status: LinkSessionStatusSchema,
    action: LinkSessionActionSchema,
    expires_at: TimestampSchema,
    action_expires_at: TimestampSchema.nullable(),
    qr: z.string().min(1).max(16_384).nullable(),
    connection_id: CommunicatorIdSchema.nullable(),
    account_id: CommunicatorIdSchema.nullable(),
    provider_label: z.string().min(1).max(100).nullable(),
    error_code: LinkSessionErrorCodeSchema.nullable(),
  })
  .strict();

export const LinkSessionStartSchema = z
  .object({
    provider: ProviderSchema,
    method: z.literal("qr"),
    confirmed_identity_id: CommunicatorIdSchema,
  })
  .strict();

export const LinkSessionActionRequestSchema = z
  .object({
    generation: z.number().int().positive(),
    action: z.enum(["poll", "refresh"]),
  })
  .strict();

export const ConnectionLifecycleOperationKindSchema = z.enum([
  "relink",
  "disconnect",
]);

export const ConnectionLifecycleOperationStatusSchema = z.enum([
  "pending",
  "provider_pending",
  "succeeded",
  "reconciliation_required",
  "failed",
]);

export const ConnectionLifecycleErrorCodeSchema = z.enum([
  "provider_unavailable",
  "provider_error",
  "provider_identity_mismatch",
  "stale_generation",
  "reconciliation_required",
]);

export const ConnectionRelinkStartSchema = z
  .object({
    provider: ProviderSchema,
    method: z.literal("qr"),
    confirmed_identity_id: CommunicatorIdSchema,
    expected_session_generation: TimestampSchema.optional(),
  })
  .strict();

export const ConnectionDisconnectRequestSchema = z
  .object({
    expected_session_generation: TimestampSchema.optional(),
  })
  .strict();

export const ConnectionLifecycleOperationSchema = z
  .object({
    operation_id: CommunicatorIdSchema,
    kind: ConnectionLifecycleOperationKindSchema,
    connection_id: CommunicatorIdSchema,
    provider: ProviderSchema,
    status: ConnectionLifecycleOperationStatusSchema,
    session_generation: TimestampSchema,
    replacement_connection_id: CommunicatorIdSchema.nullable(),
    error_code: ConnectionLifecycleErrorCodeSchema.nullable(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .strict();

export type LinkSessionStatus = z.infer<typeof LinkSessionStatusSchema>;
export type LinkSessionAction = z.infer<typeof LinkSessionActionSchema>;
export type LinkSessionErrorCode = z.infer<typeof LinkSessionErrorCodeSchema>;
export type LinkSession = z.infer<typeof LinkSessionSchema>;
export type LinkSessionStart = z.infer<typeof LinkSessionStartSchema>;
export type LinkSessionActionRequest = z.infer<
  typeof LinkSessionActionRequestSchema
>;
export type ConnectionLifecycleOperationKind = z.infer<
  typeof ConnectionLifecycleOperationKindSchema
>;
export type ConnectionLifecycleOperationStatus = z.infer<
  typeof ConnectionLifecycleOperationStatusSchema
>;
export type ConnectionLifecycleErrorCode = z.infer<
  typeof ConnectionLifecycleErrorCodeSchema
>;
export type ConnectionRelinkStart = z.infer<
  typeof ConnectionRelinkStartSchema
>;
export type ConnectionDisconnectRequest = z.infer<
  typeof ConnectionDisconnectRequestSchema
>;
export type ConnectionLifecycleOperation = z.infer<
  typeof ConnectionLifecycleOperationSchema
>;
