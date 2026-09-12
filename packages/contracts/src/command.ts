import { z } from "zod";
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

export const CommandSchema = z.object({
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
}).strict();

export type DeliveryMode = z.infer<typeof DeliveryModeSchema>;
export type CommandStatus = z.infer<typeof CommandStatusSchema>;
export type Command = z.infer<typeof CommandSchema>;
