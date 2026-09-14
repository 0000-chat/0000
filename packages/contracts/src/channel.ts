import { z } from "zod";
import {
  CapabilitySchema,
  ConnectionStatusSchema,
  ProviderSchema,
} from "./connection";
import { CommunicatorIdSchema, TimestampSchema } from "./ids";

export const ChannelSummarySchema = z
  .object({
    id: CommunicatorIdSchema,
    tenant_id: CommunicatorIdSchema,
    identity_id: CommunicatorIdSchema,
    provider: ProviderSchema,
    display_label: z.string().min(1).max(100),
    status: ConnectionStatusSchema,
    capabilities: z.array(CapabilitySchema),
    unread_count: z.number().int().nonnegative(),
    last_activity_at: TimestampSchema.nullable(),
    sort_position: z.number().int().nonnegative(),
    attention_code: z.string().max(100).optional(),
  })
  .strict();

export type ChannelSummary = z.infer<typeof ChannelSummarySchema>;
