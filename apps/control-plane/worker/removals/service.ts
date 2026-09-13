import {
  RemovalStatusResponseSchema,
  type RecordRemovalInput,
  type RemovalAuthority,
  type RemovalResourceType,
  type RemovalStatusResponse,
} from "../../../../packages/contracts/src/removals";
import {
  listRemovalAuthorities,
  readRemovalAuthority,
  recordRemoval,
  runRemovalExpiryTick,
  type RemovalExpiryTickResult,
  type RemovalAuthorityLookup,
} from "./ledger";
import { listArchivePurgeOperations } from "../archive/purge";

/**
 * Resource identity is the immutable content lineage. A message edit changes
 * its projection revision, but it never creates a new resource generation.
 */
export const contentGenerationForResource = (resourceId: string): string => {
  if (resourceId.length === 0) throw new Error("removal resource id required");
  return resourceId;
};

export type ResourceRemovalLookup = {
  tenantId: string;
  resourceType: RemovalResourceType | string;
  resourceId: string;
  accountId?: string | null;
  conversationId?: string | null;
};

export const readResourceRemoval = async (
  database: D1Database | D1DatabaseSession,
  lookup: ResourceRemovalLookup,
): Promise<RemovalAuthority | null> =>
  readRemovalAuthority(database, {
    tenantId: lookup.tenantId,
    resourceType: lookup.resourceType,
    resourceId: lookup.resourceId,
    ...(lookup.accountId === undefined ? {} : { accountId: lookup.accountId }),
    ...(lookup.conversationId === undefined
      ? {}
      : { conversationId: lookup.conversationId }),
  } satisfies RemovalAuthorityLookup);

export const resourceIsRemoved = async (
  database: D1Database | D1DatabaseSession,
  lookup: ResourceRemovalLookup,
): Promise<boolean> => (await readResourceRemoval(database, lookup)) !== null;

/**
 * Resolve a canonical resource first, then apply its optional owner scope.
 * A null lookup is not denial; callers perform identity/account authorization
 * before using this helper and this function only recognizes a matching
 * authority (including a deliberately tenant-wide authority).
 */
export const readAuthorizedResourceRemoval = async (
  database: D1Database | D1DatabaseSession,
  lookup: {
    tenantId: string;
    resourceType: RemovalResourceType | string;
    resourceId: string;
    accountId: string;
    conversationId: string;
  },
): Promise<RemovalAuthority | null> => {
  const authority = await readResourceRemoval(database, {
    tenantId: lookup.tenantId,
    resourceType: lookup.resourceType,
    resourceId: lookup.resourceId,
  });
  if (authority === null) return null;
  if (
    authority.account_id !== null &&
    authority.account_id !== lookup.accountId
  ) {
    return null;
  }
  if (
    authority.conversation_id !== null &&
    authority.conversation_id !== lookup.conversationId
  ) {
    return null;
  }
  return authority;
};

/** Message reads inherit a conversation removal unless a message authority is newer. */
export const readAuthorizedMessageRemoval = async (
  database: D1Database | D1DatabaseSession,
  lookup: {
    tenantId: string;
    messageId: string;
    accountId: string;
    conversationId: string;
  },
): Promise<RemovalAuthority | null> => {
  const messageAuthority = await readAuthorizedResourceRemoval(database, {
    tenantId: lookup.tenantId,
    resourceType: "message",
    resourceId: lookup.messageId,
    accountId: lookup.accountId,
    conversationId: lookup.conversationId,
  });
  if (messageAuthority !== null) return messageAuthority;
  return readAuthorizedResourceRemoval(database, {
    tenantId: lookup.tenantId,
    resourceType: "conversation",
    resourceId: lookup.conversationId,
    accountId: lookup.accountId,
    conversationId: lookup.conversationId,
  });
};

/**
 * Cancel only content that has not reached a destination. A leased worker can
 * still be between preparation and HTTP; clearing its lease makes its final
 * removal-epoch check authoritative while preserving any delivered/uncertain
 * evidence for later audit.
 */
export const cancelPendingWebhookDeliveriesForRemoval = async (
  database: D1Database | D1DatabaseSession,
  authority: RemovalAuthority,
  now = new Date(),
): Promise<void> => {
  if (
    authority.resource_type !== "message" &&
    authority.resource_type !== "conversation"
  ) {
    return;
  }
  const sourceColumn =
    authority.resource_type === "message"
      ? "source_message_id"
      : "source_conversation_id";
  const db =
    "withSession" in database && typeof database.withSession === "function"
      ? database.withSession("first-primary")
      : database;
  const timestamp = now.toISOString();
  await db
    .prepare(
      `UPDATE webhook_deliveries
       SET status = 'cancelled', cancelled_at = ?,
           cancellation_reason = 'source_removed', lease_id = NULL,
           lease_expires_at = NULL, next_attempt_at = NULL,
           payload_json = NULL, manual_retry_at = NULL,
           uncertain_at = NULL, uncertainty_reason = NULL
       WHERE tenant_id = ? AND ${sourceColumn} = ?
         AND status IN ('pending', 'leased')
         AND (? IS NULL OR source_account_id = ?)
         AND (? IS NULL OR source_conversation_id = ?)`,
    )
    .bind(
      timestamp,
      authority.tenant_id,
      authority.resource_id,
      authority.account_id,
      authority.account_id,
      authority.conversation_id,
      authority.conversation_id,
    )
    .run();
};

/** Record the authority before any active redaction or delivery cancellation. */
export const recordRemovalWithSuppression = async (
  database: D1Database | D1DatabaseSession,
  input: RecordRemovalInput,
  now?: Date,
): Promise<RemovalAuthority> => {
  const authority = await recordRemoval(database, input, now);
  await cancelPendingWebhookDeliveriesForRemoval(database, authority, now);
  return authority;
};

export const removalStatusForTenant = async (
  database: D1Database | D1DatabaseSession,
  tenantId: string,
): Promise<RemovalStatusResponse> => {
  const authorities = await listRemovalAuthorities(database, tenantId);
  return RemovalStatusResponseSchema.parse({
    tenant_id: tenantId,
    authorities,
    incomplete: authorities.filter(
      (authority) => authority.status !== "completed",
    ),
    active_suppression: "enforced",
    physical_purge: "not_implemented",
    archive_purge: (await listArchivePurgeOperations(database, tenantId)).map(
      (operation) => ({
        operation_id: operation.id,
        removal_id: operation.removal_id,
        status: operation.status,
        safety_deadline: operation.safety_deadline,
        failure_code: operation.failure_code,
        updated_at: operation.updated_at,
        completed_at: operation.completed_at,
      }),
    ),
  });
};

/** Durable scheduled wakeup that records expiry before canceling deliveries. */
export const runRemovalExpiryAndSuppress = async (
  database: D1Database | D1DatabaseSession,
  now = new Date(),
  limit?: number,
): Promise<RemovalExpiryTickResult> => {
  const result = await runRemovalExpiryTick(database, now, limit);
  for (const authority of result.completed) {
    await cancelPendingWebhookDeliveriesForRemoval(database, authority, now);
  }
  return result;
};
