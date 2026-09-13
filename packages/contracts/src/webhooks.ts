import { z } from "zod";
import { CommunicatorIdSchema, TimestampSchema } from "./ids";

export const MAX_WEBHOOK_EVENT_TYPES = 64;
export const MAX_WEBHOOK_RULES = 10_000;
export const MAX_WEBHOOK_PAGE_SIZE = 100;

const WebhookEventTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_.-]*$/);

export const WebhookEventFilterSchema = z
  .object({
    event_types: z
      .array(WebhookEventTypeSchema)
      .min(1)
      .max(MAX_WEBHOOK_EVENT_TYPES),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.event_types).size !== value.event_types.length) {
      context.addIssue({
        code: "custom",
        path: ["event_types"],
        message: "Event types must be unique",
      });
    }
  });
export type WebhookEventFilter = z.infer<typeof WebhookEventFilterSchema>;

export const WebhookDestinationSchema = z
  .object({
    url: z
      .string()
      .url()
      .max(2_048)
      .refine((value) => {
        const parsed = new URL(value);
        return (
          parsed.protocol === "https:" &&
          !parsed.username &&
          !parsed.password &&
          !parsed.search &&
          !parsed.hash
        );
      }, "Destination URL must be HTTPS without a query or fragment"),
    /** Opaque reference to a deployment-managed credential; never a secret. */
    credential_ref: z.string().trim().min(1).max(256).nullable().optional(),
  })
  .strict();
export type WebhookDestination = z.infer<typeof WebhookDestinationSchema>;

export const WebhookAccountRuleSchema = z
  .object({
    account_id: CommunicatorIdSchema,
    enabled: z.boolean(),
  })
  .strict();
export type WebhookAccountRule = z.infer<typeof WebhookAccountRuleSchema>;

export const WebhookChatRuleSchema = z
  .object({
    account_id: CommunicatorIdSchema,
    chat_id: CommunicatorIdSchema,
    enabled: z.boolean(),
  })
  .strict();
export type WebhookChatRule = z.infer<typeof WebhookChatRuleSchema>;

const uniqueRules = <T extends { account_id: string; chat_id?: string }>(
  values: readonly T[],
  context: z.RefinementCtx,
) => {
  const keys = values.map((value) =>
    value.chat_id === undefined
      ? value.account_id
      : `${value.account_id}:${value.chat_id}`,
  );
  if (new Set(keys).size !== keys.length) {
    context.addIssue({
      code: "custom",
      path: [],
      message: "Webhook rules must be unique per target",
    });
  }
};

export const WebhookSubscriptionStatusSchema = z.enum(["active", "revoked"]);
export type WebhookSubscriptionStatus = z.infer<
  typeof WebhookSubscriptionStatusSchema
>;

export const WebhookOwnershipModeSchema = z.enum([
  "installation",
  "shared_installation",
  "human_owner",
  "administrator",
]);
export type WebhookOwnershipMode = z.infer<typeof WebhookOwnershipModeSchema>;

export const WebhookSubscriptionSchema = z
  .object({
    id: CommunicatorIdSchema,
    tenant_id: CommunicatorIdSchema,
    owner_installation_id: CommunicatorIdSchema.nullable(),
    owner_principal_id: CommunicatorIdSchema,
    creator_principal_id: CommunicatorIdSchema,
    creator_membership_id: CommunicatorIdSchema,
    creator_identity_id: CommunicatorIdSchema.nullable(),
    logical_agent_id: CommunicatorIdSchema.nullable(),
    ownership_mode: WebhookOwnershipModeSchema,
    destination: WebhookDestinationSchema,
    destination_version: z.number().int().positive(),
    event_filter: WebhookEventFilterSchema,
    global_enabled: z.boolean(),
    account_rules: z.array(WebhookAccountRuleSchema).max(MAX_WEBHOOK_RULES),
    chat_rules: z.array(WebhookChatRuleSchema).max(MAX_WEBHOOK_RULES),
    status: WebhookSubscriptionStatusSchema,
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    revoked_at: TimestampSchema.nullable(),
  })
  .strict();
export type WebhookSubscription = z.infer<typeof WebhookSubscriptionSchema>;

export const WebhookSubscriptionPageSchema = z
  .object({
    items: z.array(WebhookSubscriptionSchema),
    next_cursor: z.string().min(1).max(2_048).nullable(),
  })
  .strict();
export type WebhookSubscriptionPage = z.infer<
  typeof WebhookSubscriptionPageSchema
>;

export const WebhookSubscriptionCreateSchema = z
  .object({
    owner_installation_id: CommunicatorIdSchema.optional(),
    logical_agent_id: CommunicatorIdSchema.nullable().optional(),
    destination: WebhookDestinationSchema,
    event_filter: WebhookEventFilterSchema.default({
      event_types: ["message.created"],
    }),
    global_enabled: z.boolean().default(true),
    account_rules: z
      .array(WebhookAccountRuleSchema)
      .max(MAX_WEBHOOK_RULES)
      .default([]),
    chat_rules: z
      .array(WebhookChatRuleSchema)
      .max(MAX_WEBHOOK_RULES)
      .default([]),
    idempotency_key: z.string().trim().min(1).max(200),
  })
  .strict()
  .superRefine((value, context) => {
    uniqueRules(value.account_rules, context);
    uniqueRules(value.chat_rules, context);
  });
export type WebhookSubscriptionCreate = z.infer<
  typeof WebhookSubscriptionCreateSchema
>;

export const WebhookSubscriptionUpdateSchema = z
  .object({
    owner_installation_id: CommunicatorIdSchema.nullable().optional(),
    logical_agent_id: CommunicatorIdSchema.nullable().optional(),
    event_filter: WebhookEventFilterSchema.optional(),
    global_enabled: z.boolean().optional(),
    account_rules: z
      .array(WebhookAccountRuleSchema)
      .max(MAX_WEBHOOK_RULES)
      .optional(),
    chat_rules: z
      .array(WebhookChatRuleSchema)
      .max(MAX_WEBHOOK_RULES)
      .optional(),
    idempotency_key: z.string().trim().min(1).max(200),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.owner_installation_id === undefined &&
      value.logical_agent_id === undefined &&
      value.event_filter === undefined &&
      value.global_enabled === undefined &&
      value.account_rules === undefined &&
      value.chat_rules === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "At least one subscription field must change",
      });
    }
    if (value.account_rules !== undefined)
      uniqueRules(value.account_rules, context);
    if (value.chat_rules !== undefined) uniqueRules(value.chat_rules, context);
  });
export type WebhookSubscriptionUpdate = z.infer<
  typeof WebhookSubscriptionUpdateSchema
>;

export const WebhookSubscriptionCutoverSchema = z
  .object({
    destination: WebhookDestinationSchema,
    idempotency_key: z.string().trim().min(1).max(200),
  })
  .strict();
export type WebhookSubscriptionCutover = z.infer<
  typeof WebhookSubscriptionCutoverSchema
>;

export const WebhookSubscriptionRevokeSchema = z
  .object({ idempotency_key: z.string().trim().min(1).max(200) })
  .strict();
export type WebhookSubscriptionRevoke = z.infer<
  typeof WebhookSubscriptionRevokeSchema
>;

export const WebhookSubscriptionEvaluationSchema = z
  .object({
    subscription_id: CommunicatorIdSchema,
    account_id: CommunicatorIdSchema,
    chat_id: CommunicatorIdSchema.nullable(),
    enabled: z.boolean(),
    source: z.enum(["chat", "account", "global"]),
  })
  .strict();
export type WebhookSubscriptionEvaluation = z.infer<
  typeof WebhookSubscriptionEvaluationSchema
>;

export const WebhookDeliveryStatusSchema = z.enum([
  "pending",
  "leased",
  "delivered",
  "failed",
  "uncertain",
  "cancelled",
]);
export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatusSchema>;

export const WebhookDeliverySchema = z
  .object({
    id: CommunicatorIdSchema,
    tenant_id: CommunicatorIdSchema,
    subscription_id: CommunicatorIdSchema,
    source_event_id: z.string().min(1).max(1_024),
    source_message_id: CommunicatorIdSchema.nullable(),
    destination_version: z.number().int().positive(),
    status: WebhookDeliveryStatusSchema,
    first_pending_at: TimestampSchema,
    retry_deadline: TimestampSchema,
    attempt_count: z.number().int().nonnegative(),
    next_attempt_at: TimestampSchema.nullable(),
    last_attempt_at: TimestampSchema.nullable(),
    delivered_at: TimestampSchema.nullable(),
    http_status: z.number().int().min(100).max(599).nullable(),
    error_code: z.string().min(1).max(128).nullable(),
    last_response_body: z.string().max(8_192).nullable(),
    cancellation_reason: z.string().min(1).max(128).nullable(),
    uncertain_at: TimestampSchema.nullable(),
    uncertainty_reason: z.string().min(1).max(128).nullable(),
  })
  .strict();
export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>;

export const WebhookDeliveryRetrySchema = z
  .object({
    idempotency_key: z.string().trim().min(1).max(200),
  })
  .strict();
export type WebhookDeliveryRetry = z.infer<typeof WebhookDeliveryRetrySchema>;

const WebhookAttachmentReferenceSchema = z
  .object({
    attachment_id: CommunicatorIdSchema,
    message_id: CommunicatorIdSchema,
    file_name: z.string().max(512).nullable(),
    mime_type: z.string().max(255).nullable(),
    size_bytes: z.number().int().safe().nonnegative().nullable(),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .nullable(),
    revision: z.string().min(1).max(1_024),
    download_path: z.string().min(1).max(2_048),
    download_grant: z.string().min(32).max(512).nullable(),
    download_grant_expires_at: TimestampSchema.nullable(),
  })
  .strict();
export type WebhookAttachmentReference = z.infer<
  typeof WebhookAttachmentReferenceSchema
>;

export const WebhookDeliveryPayloadSchema = z
  .object({
    schema_version: z.literal(1),
    type: z.literal("message.created"),
    delivery_id: CommunicatorIdSchema,
    source_event_id: z.string().min(1).max(1_024),
    source_message_id: CommunicatorIdSchema,
    tenant_id: CommunicatorIdSchema,
    identity_id: CommunicatorIdSchema,
    account_id: CommunicatorIdSchema,
    chat_id: CommunicatorIdSchema,
    revision: z.string().min(1).max(1_024),
    timestamp: TimestampSchema,
    sender: z
      .object({
        participant_id: CommunicatorIdSchema.nullable(),
        label: z.string().min(1).max(100),
      })
      .strict(),
    text: z.string().max(20_000),
    source: z
      .object({
        remote_message_id: z.string().min(1).max(1_024).nullable(),
        matrix_room_id: z.string().min(1).max(1_024).nullable(),
        matrix_event_id: z.string().min(1).max(1_024).nullable(),
      })
      .strict(),
    attachments: z.array(WebhookAttachmentReferenceSchema).max(100),
  })
  .strict();
export type WebhookDeliveryPayload = z.infer<
  typeof WebhookDeliveryPayloadSchema
>;
