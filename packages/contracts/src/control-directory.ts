import { z } from "zod";
import { MembershipRoleSchema, PrincipalTypeSchema } from "./authorization";
import { CommunicatorIdSchema, TimestampSchema } from "./ids";
import { IdentityKindSchema } from "./identity";

export const DirectoryStatusSchema = z.enum(["active", "disabled", "revoked"]);

export const DirectoryTenantSchema = z.object({
  id: CommunicatorIdSchema,
  slug: z.string().regex(/^[a-z0-9-]+$/).max(63),
  display_name: z.string().min(1).max(100),
  status: DirectoryStatusSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
}).strict();

export const DirectoryPrincipalSchema = z.object({
  id: CommunicatorIdSchema,
  type: PrincipalTypeSchema,
  display_name: z.string().min(1).max(100),
  status: DirectoryStatusSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
}).strict();

export const DirectoryMembershipSchema = z.object({
  id: CommunicatorIdSchema,
  tenant_id: CommunicatorIdSchema,
  principal_id: CommunicatorIdSchema,
  role: MembershipRoleSchema,
  status: DirectoryStatusSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
}).strict();

export const DirectoryIdentitySchema = z.object({
  id: CommunicatorIdSchema,
  tenant_id: CommunicatorIdSchema,
  kind: IdentityKindSchema,
  display_name: z.string().min(1).max(100),
  status: DirectoryStatusSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
}).strict();

export type DirectoryStatus = z.infer<typeof DirectoryStatusSchema>;
export type DirectoryTenant = z.infer<typeof DirectoryTenantSchema>;
export type DirectoryPrincipal = z.infer<typeof DirectoryPrincipalSchema>;
export type DirectoryMembership = z.infer<typeof DirectoryMembershipSchema>;
export type DirectoryIdentity = z.infer<typeof DirectoryIdentitySchema>;
