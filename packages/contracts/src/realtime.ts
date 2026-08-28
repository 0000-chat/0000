import { z } from "zod";
import { CommunicatorIdSchema, TimestampSchema } from "./ids";

export const RealtimeEventSchema = z.object({
  sequence: z.number().int().positive(),
  type: z.enum([
    "connection.updated",
    "message.created",
    "command.updated",
    "system.status.updated",
  ]),
  tenant_id: CommunicatorIdSchema,
  identity_id: CommunicatorIdSchema,
  connection_id: CommunicatorIdSchema.optional(),
  conversation_id: CommunicatorIdSchema.optional(),
  occurred_at: TimestampSchema,
  data: z.record(z.string(), z.unknown()),
}).strict();

export const MessageCreatedDataSchema = z.object({
  last_message_preview: z.string().max(280),
  last_activity_at: TimestampSchema,
  unread_delta: z.number().int(),
}).strict();

export type RealtimeEvent = z.infer<typeof RealtimeEventSchema>;
