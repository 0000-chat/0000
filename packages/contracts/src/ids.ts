import { z } from "zod";

export const CommunicatorIdSchema = z
  .string()
  .regex(/^[a-z]+_[a-z0-9_]+$/);

export const TimestampSchema = z.string().datetime({ offset: true });

export type CommunicatorId = z.infer<typeof CommunicatorIdSchema>;
export type Timestamp = z.infer<typeof TimestampSchema>;
