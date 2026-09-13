import { z } from "zod";
import { CommunicatorIdSchema } from "./ids";
import { IdentityKindSchema } from "./identity";

export const PrincipalTypeSchema = z.enum([
  "human",
  "service",
  "agent",
  "operator",
]);
export const MembershipRoleSchema = z.enum(["owner", "admin", "member"]);
export const OperationScopeSchema = z.enum([
  "conversation.read",
  "conversation.create",
  "group.create",
  "message.send",
  "message.mutate",
  "receipt.send",
  "connection.read",
  "connection.manage",
  "export.create",
  "replay.run",
  "retention.manage",
  "break_glass.inspect",
]);

export const AuthorizedIdentitySchema = z
  .object({
    identity_id: CommunicatorIdSchema,
    kind: IdentityKindSchema,
    display_name: z.string().min(1).max(100),
    scopes: z.array(OperationScopeSchema),
  })
  .strict();

export const SessionResponseSchema = z
  .object({
    tenant: z
      .object({
        id: CommunicatorIdSchema,
        slug: z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .max(63),
        display_name: z.string().min(1).max(100),
      })
      .strict(),
    principal: z
      .object({
        id: CommunicatorIdSchema,
        type: PrincipalTypeSchema,
        display_name: z.string().min(1).max(100),
      })
      .strict(),
    membership: z
      .object({
        id: CommunicatorIdSchema,
        role: MembershipRoleSchema,
      })
      .strict(),
    identities: z.array(AuthorizedIdentitySchema),
  })
  .strict();

export const ApiErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.enum([
          "unauthenticated",
          "invalid_request",
          "chat_paused",
          "forbidden",
          "not_found",
          "tenant_selection_required",
          "attachment_unavailable",
          "attachment_removed",
          "service_unavailable",
        ]),
        message: z.string().min(1).max(100),
      })
      .strict(),
  })
  .strict();

export type PrincipalType = z.infer<typeof PrincipalTypeSchema>;
export type MembershipRole = z.infer<typeof MembershipRoleSchema>;
export type OperationScope = z.infer<typeof OperationScopeSchema>;
export type AuthorizedIdentity = z.infer<typeof AuthorizedIdentitySchema>;
export type SessionResponse = z.infer<typeof SessionResponseSchema>;
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
