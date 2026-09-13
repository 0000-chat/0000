import { z } from "zod";
import { CommunicatorIdSchema, TimestampSchema } from "./ids";
import { ProviderSchema } from "./connection";

export const MAX_GRANT_PAGE_SIZE = 100;
export const MAX_GRANT_CHAT_IDS = 10_000;

/** A grant's operation is intentionally independent from its resource scope. */
export const AccountGrantOperationScopeSchema = z.enum([
  "conversation.read",
  "message.send",
  "webhook.manage",
]);
export type AccountGrantOperationScope = z.infer<
  typeof AccountGrantOperationScopeSchema
>;

export const AccountGrantChatScopeSchema = z.enum(["all_chats", "selected_chats"]);
export type AccountGrantChatScope = z.infer<typeof AccountGrantChatScopeSchema>;

export const AccountGrantStatusSchema = z.enum(["active", "revoked"]);
export type AccountGrantStatus = z.infer<typeof AccountGrantStatusSchema>;

export const AccountGrantSchema = z.object({
  id: CommunicatorIdSchema,
  tenant_id: CommunicatorIdSchema,
  membership_id: CommunicatorIdSchema,
  identity_id: CommunicatorIdSchema,
  identity_display_name: z.string().min(1).max(100),
  account_id: CommunicatorIdSchema,
  connection_id: CommunicatorIdSchema,
  provider: ProviderSchema,
  account_label: z.string().min(1).max(200),
  operation_scope: AccountGrantOperationScopeSchema,
  chat_scope: AccountGrantChatScopeSchema,
  chat_ids: z.array(CommunicatorIdSchema).max(MAX_GRANT_CHAT_IDS),
  status: AccountGrantStatusSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  revoked_at: TimestampSchema.nullable(),
}).strict();
export type AccountGrant = z.infer<typeof AccountGrantSchema>;

export const AccountGrantPageSchema = z.object({
  items: z.array(AccountGrantSchema),
  next_cursor: z.string().min(1).max(2_048).nullable(),
}).strict();
export type AccountGrantPage = z.infer<typeof AccountGrantPageSchema>;

export const ConnectedAccountSchema = z.object({
  account_id: CommunicatorIdSchema,
  tenant_id: CommunicatorIdSchema,
  connection_id: CommunicatorIdSchema,
  identity_id: CommunicatorIdSchema,
  provider: ProviderSchema,
  display_label: z.string().min(1).max(200),
  status: z.enum([
    "connected",
    "syncing",
    "ready",
    "attention_required",
    "disconnected",
    "revoked",
    "unlinked",
  ]),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
}).strict();
export type ConnectedAccount = z.infer<typeof ConnectedAccountSchema>;

export const ConnectedAccountPageSchema = z.object({
  items: z.array(ConnectedAccountSchema),
  next_cursor: z.string().min(1).max(2_048).nullable(),
}).strict();
export type ConnectedAccountPage = z.infer<typeof ConnectedAccountPageSchema>;

export const AccountGrantMutationSchema = z.object({
  membership_id: CommunicatorIdSchema,
  identity_id: CommunicatorIdSchema,
  account_id: CommunicatorIdSchema,
  operation_scope: AccountGrantOperationScopeSchema,
  chat_scope: AccountGrantChatScopeSchema,
  chat_ids: z.array(CommunicatorIdSchema).max(MAX_GRANT_CHAT_IDS),
  idempotency_key: z.string().trim().min(1).max(200),
}).strict().superRefine((value, context) => {
  if (value.chat_scope === "all_chats" && value.chat_ids.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["chat_ids"],
      message: "All-chats grants cannot include selected chat IDs",
    });
  }
  if (value.chat_scope === "selected_chats" && value.chat_ids.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["chat_ids"],
      message: "Selected-chat grants require at least one chat ID",
    });
  }
});
export type AccountGrantMutation = z.infer<typeof AccountGrantMutationSchema>;

export const AccountGrantUpdateSchema = z.object({
  operation_scope: AccountGrantOperationScopeSchema,
  chat_scope: AccountGrantChatScopeSchema,
  chat_ids: z.array(CommunicatorIdSchema).max(MAX_GRANT_CHAT_IDS),
  idempotency_key: z.string().trim().min(1).max(200),
}).strict().superRefine((value, context) => {
  if (value.chat_scope === "all_chats" && value.chat_ids.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["chat_ids"],
      message: "All-chats grants cannot include selected chat IDs",
    });
  }
  if (value.chat_scope === "selected_chats" && value.chat_ids.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["chat_ids"],
      message: "Selected-chat grants require at least one chat ID",
    });
  }
});
export type AccountGrantUpdate = z.infer<typeof AccountGrantUpdateSchema>;

export const PermissionRequestStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "cancelled",
]);
export type PermissionRequestStatus = z.infer<typeof PermissionRequestStatusSchema>;

export const PermissionRequestSchema = z.object({
  id: CommunicatorIdSchema,
  tenant_id: CommunicatorIdSchema,
  requester_principal_id: CommunicatorIdSchema,
  requester_membership_id: CommunicatorIdSchema,
  identity_id: CommunicatorIdSchema,
  account_id: CommunicatorIdSchema,
  operation_scope: AccountGrantOperationScopeSchema,
  chat_scope: AccountGrantChatScopeSchema,
  chat_ids: z.array(CommunicatorIdSchema).max(MAX_GRANT_CHAT_IDS),
  reason: z.string().min(1).max(500),
  status: PermissionRequestStatusSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  decided_at: TimestampSchema.nullable(),
  decided_by_principal_id: CommunicatorIdSchema.nullable(),
}).strict();
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

export const PermissionRequestPageSchema = z.object({
  items: z.array(PermissionRequestSchema),
  next_cursor: z.string().min(1).max(2_048).nullable(),
}).strict();
export type PermissionRequestPage = z.infer<typeof PermissionRequestPageSchema>;

export const PermissionRequestCreateSchema = z.object({
  identity_id: CommunicatorIdSchema,
  account_id: CommunicatorIdSchema,
  operation_scope: AccountGrantOperationScopeSchema,
  chat_scope: AccountGrantChatScopeSchema,
  chat_ids: z.array(CommunicatorIdSchema).max(MAX_GRANT_CHAT_IDS),
  reason: z.string().trim().min(1).max(500),
  idempotency_key: z.string().trim().min(1).max(200),
}).strict().superRefine((value, context) => {
  if (value.chat_scope === "all_chats" && value.chat_ids.length > 0) {
    context.addIssue({ code: "custom", path: ["chat_ids"], message: "All-chats requests cannot include selected chat IDs" });
  }
  if (value.chat_scope === "selected_chats" && value.chat_ids.length === 0) {
    context.addIssue({ code: "custom", path: ["chat_ids"], message: "Selected-chat requests require at least one chat ID" });
  }
});
export type PermissionRequestCreate = z.infer<typeof PermissionRequestCreateSchema>;
