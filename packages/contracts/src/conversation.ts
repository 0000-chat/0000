import { z } from "zod";
import { CommunicatorIdSchema, TimestampSchema } from "./ids";

export const ConversationSummarySchema = z.object({
  id: CommunicatorIdSchema,
  tenant_id: CommunicatorIdSchema,
  identity_id: CommunicatorIdSchema,
  connection_id: CommunicatorIdSchema,
  title: z.string().min(1).max(200),
  last_message_preview: z.string().max(280),
  last_activity_at: TimestampSchema,
  unread_count: z.number().int().nonnegative(),
}).strict();

export const MessageSchema = z.object({
  id: CommunicatorIdSchema,
  tenant_id: CommunicatorIdSchema,
  identity_id: CommunicatorIdSchema,
  connection_id: CommunicatorIdSchema,
  conversation_id: CommunicatorIdSchema,
  direction: z.enum(["inbound", "outbound"]),
  sender_label: z.string().min(1).max(100),
  body: z.string().max(20_000),
  occurred_at: TimestampSchema,
  delivery_status: z.enum([
    "unknown",
    "accepted",
    "sent",
    "delivered",
    "read",
    "failed",
  ]),
  attachment_count: z.number().int().nonnegative(),
}).strict();

export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;
export type Message = z.infer<typeof MessageSchema>;
