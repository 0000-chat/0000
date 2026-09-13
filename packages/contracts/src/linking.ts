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

export type LinkSessionStatus = z.infer<typeof LinkSessionStatusSchema>;
export type LinkSessionAction = z.infer<typeof LinkSessionActionSchema>;
export type LinkSessionErrorCode = z.infer<typeof LinkSessionErrorCodeSchema>;
export type LinkSession = z.infer<typeof LinkSessionSchema>;
export type LinkSessionStart = z.infer<typeof LinkSessionStartSchema>;
export type LinkSessionActionRequest = z.infer<
  typeof LinkSessionActionRequestSchema
>;
