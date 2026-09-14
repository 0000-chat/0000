import { z } from "zod";
import { CommunicatorIdSchema } from "./ids";

export const IdentityKindSchema = z.enum(["human", "agent"]);

export const IdentitySchema = z
  .object({
    id: CommunicatorIdSchema,
    tenant_id: CommunicatorIdSchema,
    kind: IdentityKindSchema,
    display_name: z.string().min(1).max(100),
  })
  .strict();

export type IdentityKind = z.infer<typeof IdentityKindSchema>;
export type Identity = z.infer<typeof IdentitySchema>;
