import { z } from "zod";
import { CommunicatorIdSchema, TimestampSchema } from "./ids";

export const ProviderSchema = z.enum([
  "whatsapp",
  "telegram",
  "messenger",
  "linkedin",
]);

export const ConnectionStatusSchema = z.enum([
  "connected",
  "syncing",
  "ready",
  "attention_required",
  "disconnected",
  "revoked",
  "unlinked",
]);

export const CapabilitySchema = z.enum([
  "message.send",
  "message.edit",
  "message.delete",
  "reaction.add",
  "reaction.remove",
  "receipt.read",
  "typing.send",
  "attachment.send",
]);

export const ConnectionSchema = z
  .object({
    id: CommunicatorIdSchema,
    tenant_id: CommunicatorIdSchema,
    identity_id: CommunicatorIdSchema,
    provider: ProviderSchema,
    display_label: z.string().min(1).max(100),
    status: ConnectionStatusSchema,
    capabilities: z.array(CapabilitySchema),
    last_synced_at: TimestampSchema.nullable(),
    attention_code: z.string().max(100).optional(),
  })
  .strict();

export type Provider = z.infer<typeof ProviderSchema>;
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;
export type Capability = z.infer<typeof CapabilitySchema>;
export type Connection = z.infer<typeof ConnectionSchema>;
