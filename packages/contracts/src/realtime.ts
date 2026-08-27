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
  occurred_at: TimestampSchema,
  data: z.record(z.string(), z.unknown()),
}).strict();

export type RealtimeEvent = z.infer<typeof RealtimeEventSchema>;
