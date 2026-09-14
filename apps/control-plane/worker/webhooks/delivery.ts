import {
  GetWebhookMessageInputSchema,
  ProjectionAuthorizationContextSchema,
  RemovalAuthoritySchema,
  WebhookDeliveryPayloadSchema,
  WebhookRemovalDeliveryPayloadSchema,
  WebhookEventFilterSchema,
  type GetWebhookMessageInput,
  type ProjectionEventEnvelope,
  type ProjectionAttachment,
  type WebhookDeliveryPayload,
  type WebhookRemovalDeliveryPayload,
  type WebhookMessage,
  type WebhookSubscription,
  type RemovalAuthority,
} from "@communicator/contracts";
import { sha256Hex } from "../archive/codec";
import { issueAttachmentGrant } from "../attachments/grants";
import { hasAccountOperationGrant } from "../control-directory/grants";
import { getWebhookSubscription } from "../control-directory/webhooks";
import {
  readAuthorizedMessageRemoval,
  readAuthorizedResourceRemoval,
} from "../removals/service";
import { readTenantDeletionEpoch } from "../removals/ledger";
import {
  isEligibleWebhookSource,
  isWebhookRemovalDelivery,
  sourceMessageIdForWebhookEvent,
  webhookDeliveryEventTypeFor,
  WEBHOOK_MESSAGE_CREATED,
  WEBHOOK_MESSAGE_DELETED,
  WEBHOOK_MESSAGE_EDITED,
  type WebhookDeliveryEventType,
} from "./revisions";

const DELIVERY_LEASE_MS = 60_000;
const MAX_DELIVERY_BATCH = 100;
const MAX_RETRY_BATCH = 100;
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const RETRY_BACKOFF_MS = [
  1_000,
  5_000,
  30_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
] as const;
const MAX_RESPONSE_BODY_BYTES = 8_192;
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

type DeliveryRow = {
  id: string;
  tenant_id: string;
  subscription_id: string;
  source_event_id: string;
  event_type: WebhookDeliveryEventType;
  source_message_id: string | null;
  source_identity_id: string | null;
  source_account_id: string | null;
  source_conversation_id: string | null;
  source_revision: string | null;
  destination_version: number;
  status:
    | "pending"
    | "leased"
    | "delivered"
    | "failed"
    | "uncertain"
    | "cancelled";
  first_pending_at: string;
  retry_deadline: string;
  attempt_count: number;
  next_attempt_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  lease_id: string | null;
  lease_expires_at: string | null;
  removal_epoch: number;
  provider_request_started_at: string | null;
  last_attempt_at: string | null;
  delivered_at: string | null;
  http_status: number | null;
  error_code: string | null;
  payload_json: string | null;
  last_response_body: string | null;
  manual_retry_at: string | null;
  uncertain_at: string | null;
  uncertainty_reason: string | null;
};

type DeliveryLease = DeliveryRow & {
  lease_id: string;
  lease_expires_at: string;
};

type DeliveryClaim = {
  lease: DeliveryLease | null;
  busy: boolean;
};

export type WebhookProjection = {
  getWebhookMessage(
    input: GetWebhookMessageInput,
  ): Promise<WebhookMessage | null>;
};

export type WebhookCredentialResolver = (input: {
  tenantId: string;
  subscriptionId: string;
  ownerPrincipalId: string;
  ownerInstallationId: string | null;
  credentialRef: string;
}) => Promise<string | null>;

/**
 * A deployment-owned secret containing owner-scoped credential entries. The
 * secret is deliberately outside D1: D1 stores only the opaque reference.
 */
export type WebhookCredentialStore = {
  get(): Promise<string>;
};

export type WebhookDeliveryServices = {
  now?: (() => Date) | undefined;
  fetch?: typeof fetch | undefined;
  resolveCredential?: WebhookCredentialResolver | undefined;
  credentialStore?: WebhookCredentialStore | undefined;
  httpTimeoutMs?: number | undefined;
  /** Test-only seam for a removal race immediately before the durable lease. */
  beforeClaim?: ((deliveryId: string) => Promise<void>) | undefined;
  /** Test-only seam for revocation/edit races immediately before HTTP. */
  beforeFetch?: ((deliveryId: string) => Promise<void>) | undefined;
  /** Test-only seam for a removal race after the response fence. */
  beforeTerminalWrite?: ((deliveryId: string) => Promise<void>) | undefined;
};

export type WebhookRetryTickServices = Pick<
  WebhookDeliveryServices,
  | "now"
  | "fetch"
  | "resolveCredential"
  | "credentialStore"
  | "beforeClaim"
  | "beforeFetch"
  | "beforeTerminalWrite"
>;

export type WebhookRetryTickResult = {
  scanned: number;
  attempted: number;
};

type StoredCredential = {
  tenant_id: string;
  owner_principal_id: string;
  owner_installation_id: string | null;
  credential_ref: string;
  authorization: string;
};

const storedCredentialShape = (value: unknown): value is StoredCredential => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.tenant_id === "string" &&
    typeof row.owner_principal_id === "string" &&
    (row.owner_installation_id === null ||
      typeof row.owner_installation_id === "string") &&
    typeof row.credential_ref === "string" &&
    typeof row.authorization === "string" &&
    row.authorization.length > 0 &&
    row.authorization.length <= 4_096 &&
    !/[\r\n]/u.test(row.authorization)
  );
};

const storedCredentials = async (
  store: WebhookCredentialStore,
): Promise<StoredCredential[]> => {
  const raw = await store.get();
  const parsed: unknown = JSON.parse(raw);
  const credentialsUnknown =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).credentials
      : undefined;
  if (!Array.isArray(credentialsUnknown)) {
    throw new Error("webhook credential configuration invalid");
  }
  const credentials = credentialsUnknown;
  if (
    credentials.length > 10_000 ||
    !credentials.every(storedCredentialShape)
  ) {
    throw new Error("webhook credential configuration invalid");
  }
  return credentials;
};

export const createWebhookCredentialResolver =
  (store: WebhookCredentialStore): WebhookCredentialResolver =>
  async (input): Promise<string | null> => {
    const credentials = await storedCredentials(store);
    const match = credentials.find(
      (credential) =>
        credential.tenant_id === input.tenantId &&
        credential.owner_principal_id === input.ownerPrincipalId &&
        credential.owner_installation_id === input.ownerInstallationId &&
        credential.credential_ref === input.credentialRef,
    );
    return match?.authorization ?? null;
  };

const resolveStoredCredential = async (
  store: WebhookCredentialStore,
  input: Parameters<WebhookCredentialResolver>[0],
): Promise<string | null> => {
  return createWebhookCredentialResolver(store)(input);
};

type Candidate = {
  event: ProjectionEventEnvelope;
  eventType: WebhookDeliveryEventType;
  sourceMessageId: string;
  subscription: WebhookSubscription;
  deliveryId: string;
};

const databaseSession = (
  database: D1Database | D1DatabaseSession,
): D1DatabaseSession => {
  if ("withSession" in database && typeof database.withSession === "function") {
    return database.withSession("first-primary");
  }
  return database as D1DatabaseSession;
};

/**
 * Apply removal suppression to work that has not crossed the provider-request
 * boundary.  A row with a durable provider start marker is deliberately left
 * leased so its worker can classify the external result as uncertain after it
 * observes the advanced removal epoch.  The retention caller must use this
 * helper after recording authority; a broad status-only update would erase
 * that in-flight evidence.
 */
export const cancelWebhookDeliveriesForRemoval = async (
  database: D1Database | D1DatabaseSession,
  authority: Pick<
    RemovalAuthority,
    | "tenant_id"
    | "resource_type"
    | "resource_id"
    | "account_id"
    | "conversation_id"
  >,
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
  const db = databaseSession(database);
  await db
    .prepare(
      `UPDATE webhook_deliveries
       SET status = 'cancelled', cancelled_at = ?,
           cancellation_reason = 'source_removed', lease_id = NULL,
           lease_expires_at = NULL, next_attempt_at = NULL,
           payload_json = NULL, manual_retry_at = NULL,
           uncertain_at = NULL, uncertainty_reason = NULL,
           provider_request_started_at = NULL
       WHERE tenant_id = ? AND ${sourceColumn} = ?
         AND (
           status = 'pending' OR
           (status = 'leased' AND provider_request_started_at IS NULL)
         )
         AND (? IS NULL OR source_account_id = ?)
         AND (? IS NULL OR source_conversation_id = ?)`,
    )
    .bind(
      now.toISOString(),
      authority.tenant_id,
      authority.resource_id,
      authority.account_id,
      authority.account_id,
      authority.conversation_id,
      authority.conversation_id,
    )
    .run();
};

const nowFor = (services: WebhookDeliveryServices): Date => {
  const value = services.now?.() ?? new Date();
  if (!Number.isFinite(value.getTime()))
    throw new Error("webhook delivery clock invalid");
  return value;
};

const retryDeadlineFor = (firstPendingAt: string): string => {
  const parsed = Date.parse(firstPendingAt);
  if (!Number.isFinite(parsed))
    throw new Error("webhook delivery timestamp invalid");
  return new Date(parsed + RETRY_WINDOW_MS).toISOString();
};

const retryDelayFor = (attemptCount: number): number => {
  const index = Math.max(
    0,
    Math.min(attemptCount - 1, RETRY_BACKOFF_MS.length - 1),
  );
  const fallback = RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
  if (fallback === undefined)
    throw new Error("webhook retry backoff unavailable");
  return RETRY_BACKOFF_MS[index] ?? fallback;
};

const boundedResponseBody = async (
  response: Response,
  timeoutMs: number,
): Promise<string | null> => {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const readBody = async (): Promise<string | null> => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (size < MAX_RESPONSE_BODY_BYTES) {
        const next = await reader.read();
        if (next.done) break;
        const remaining = MAX_RESPONSE_BODY_BYTES - size;
        const chunk =
          next.value.byteLength <= remaining
            ? next.value
            : next.value.slice(0, remaining);
        chunks.push(chunk);
        size += chunk.byteLength;
        if (size >= MAX_RESPONSE_BODY_BYTES) {
          void reader.cancel().catch(() => undefined);
          break;
        }
      }
      const result = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(result);
    } catch {
      try {
        await reader.cancel();
      } catch {
        // The response body is already unusable.
      }
      return null;
    }
  };
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve(null);
      void reader.cancel().catch(() => undefined);
    }, timeoutMs);
  });
  try {
    return await Promise.race([readBody(), timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

const httpTimeoutFor = (services: WebhookDeliveryServices): number => {
  const candidate = services.httpTimeoutMs;
  if (candidate === undefined || !Number.isFinite(candidate) || candidate < 1) {
    return DEFAULT_HTTP_TIMEOUT_MS;
  }
  return Math.min(Math.floor(candidate), 5 * 60_000);
};

const fetchWithTimeout = async (
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Response>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error("webhook delivery timeout"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetcher(url, { ...init, signal: controller.signal }),
      timeout,
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

const subscriptionAllowsEvent = (
  subscription: WebhookSubscription,
  event: ProjectionEventEnvelope,
): boolean => {
  const deliveryEventType = webhookDeliveryEventTypeFor(event);
  if (deliveryEventType === null) return false;
  if (
    subscription.status !== "active" ||
    !WebhookEventFilterSchema.parse(
      subscription.event_filter,
    ).event_types.includes(deliveryEventType)
  ) {
    return false;
  }
  const chatRule = subscription.chat_rules.find(
    (rule) =>
      rule.account_id === event.account_id &&
      rule.chat_id === event.conversation_id,
  );
  if (chatRule !== undefined) return chatRule.enabled;
  const accountRule = subscription.account_rules.find(
    (rule) => rule.account_id === event.account_id,
  );
  return accountRule?.enabled ?? subscription.global_enabled;
};

const subscriptionAllowsStoredDelivery = (
  subscription: WebhookSubscription,
  delivery: Pick<
    DeliveryRow,
    "event_type" | "source_account_id" | "source_conversation_id"
  >,
): boolean => {
  if (
    subscription.status !== "active" ||
    !WebhookEventFilterSchema.parse(
      subscription.event_filter,
    ).event_types.includes(delivery.event_type) ||
    delivery.source_account_id === null ||
    delivery.source_conversation_id === null
  ) {
    return false;
  }
  const chatRule = subscription.chat_rules.find(
    (rule) =>
      rule.account_id === delivery.source_account_id &&
      rule.chat_id === delivery.source_conversation_id,
  );
  if (chatRule !== undefined) return chatRule.enabled;
  const accountRule = subscription.account_rules.find(
    (rule) => rule.account_id === delivery.source_account_id,
  );
  return accountRule?.enabled ?? subscription.global_enabled;
};

const stableDeliveryId = async (
  tenantId: string,
  subscriptionId: string,
  sourceEventId: string,
): Promise<string> => {
  const digest = await sha256Hex(
    new TextEncoder().encode(
      `${tenantId}\u0000${subscriptionId}\u0000${sourceEventId}`,
    ),
  );
  return `webhook_delivery_${digest}`;
};

const activeAccount = async (
  db: D1DatabaseSession,
  tenantId: string,
  accountId: string,
): Promise<boolean> =>
  (await db
    .prepare(
      `SELECT 1 AS active
       FROM connection_accounts AS ca
       JOIN connections AS c
         ON c.tenant_id = ? AND c.id = ca.connection_id
       WHERE ca.account_id = ? AND ca.status = 'active'
       LIMIT 1`,
    )
    .bind(tenantId, accountId)
    .first<{ active: number }>()) !== null;

type InstallationAuthority = {
  identityId: string;
  principalId: string;
};

const installationAuthority = async (
  db: D1DatabaseSession,
  tenantId: string,
  installationId: string,
): Promise<InstallationAuthority | null> => {
  const row = await db
    .prepare(
      `SELECT identity_id, principal_id
       FROM oauth_client_installations
       WHERE tenant_id = ? AND id = ? AND status = 'active'
         AND revoked_at IS NULL
       LIMIT 1`,
    )
    .bind(tenantId, installationId)
    .first<InstallationAuthority>();
  return row ?? null;
};

const identityIsActive = async (
  db: D1DatabaseSession,
  tenantId: string,
  identityId: string,
): Promise<boolean> =>
  (await db
    .prepare(
      "SELECT 1 AS active FROM identities WHERE tenant_id = ? AND id = ? AND status = 'active' LIMIT 1",
    )
    .bind(tenantId, identityId)
    .first<{ active: number }>()) !== null;

const administratorCreatorIsActive = async (
  db: D1DatabaseSession,
  subscription: WebhookSubscription,
): Promise<boolean> =>
  (await db
    .prepare(
      `SELECT 1 AS authorized
       FROM memberships AS m
       JOIN principals AS p
         ON p.id = m.principal_id AND p.status = 'active'
          AND p.revoked_at IS NULL
       WHERE m.tenant_id = ? AND m.id = ?
         AND m.principal_id = ? AND m.status = 'active'
         AND m.role IN ('owner', 'admin')
       LIMIT 1`,
    )
    .bind(
      subscription.tenant_id,
      subscription.creator_membership_id,
      subscription.creator_principal_id,
    )
    .first<{ authorized: number }>()) !== null;

const creatorMembershipIsActive = async (
  db: D1DatabaseSession,
  subscription: WebhookSubscription,
): Promise<boolean> =>
  (await db
    .prepare(
      `SELECT 1 AS active
       FROM memberships AS m
       JOIN principals AS p
         ON p.id = m.principal_id AND p.status = 'active'
          AND p.revoked_at IS NULL
       WHERE m.tenant_id = ? AND m.id = ? AND m.principal_id = ?
         AND m.status = 'active'
       LIMIT 1`,
    )
    .bind(
      subscription.tenant_id,
      subscription.creator_membership_id,
      subscription.creator_principal_id,
    )
    .first<{ active: number }>()) !== null;

const currentAuthority = async (
  db: D1DatabaseSession,
  subscription: WebhookSubscription,
  accountId: string,
  conversationId: string,
): Promise<boolean> => {
  if (!(await activeAccount(db, subscription.tenant_id, accountId))) {
    return false;
  }

  let identityId =
    subscription.logical_agent_id ?? subscription.creator_identity_id;
  if (subscription.owner_installation_id !== null) {
    const installation = await installationAuthority(
      db,
      subscription.tenant_id,
      subscription.owner_installation_id,
    );
    if (
      installation === null ||
      installation.principalId !== subscription.owner_principal_id
    ) {
      return false;
    }
    identityId = installation.identityId;
  }

  if (await administratorCreatorIsActive(db, subscription)) return true;
  if (identityId !== null) {
    if (!(await creatorMembershipIsActive(db, subscription))) return false;
    if (!(await identityIsActive(db, subscription.tenant_id, identityId))) {
      return false;
    }
    return hasAccountOperationGrant(
      db,
      subscription.tenant_id,
      subscription.creator_membership_id,
      identityId,
      accountId,
      conversationId,
      "webhook.manage",
    );
  }

  return false;
};

const readActiveSubscriptions = async (
  db: D1DatabaseSession,
  tenantId: string,
): Promise<WebhookSubscription[]> => {
  const rows = await db
    .prepare(
      "SELECT id FROM webhook_subscriptions WHERE tenant_id = ? AND status = 'active' ORDER BY id ASC",
    )
    .bind(tenantId)
    .all<{ id: string }>();
  return Promise.all(
    rows.results.map((row) => getWebhookSubscription(db, tenantId, row.id)),
  );
};

const previouslyDeliveredDestinationVersion = async (
  db: D1DatabaseSession,
  input: {
    tenantId: string;
    subscriptionId: string;
    sourceMessageId: string;
    accountId: string;
    conversationId: string;
  },
): Promise<number | null> => {
  const row = await db
    .prepare(
      `SELECT destination_version
       FROM webhook_deliveries
       WHERE tenant_id = ? AND subscription_id = ?
         AND source_message_id = ? AND source_account_id = ?
         AND source_conversation_id = ? AND event_type = 'message.created'
         AND status = 'delivered'
       ORDER BY delivered_at DESC, id DESC
       LIMIT 1`,
    )
    .bind(
      input.tenantId,
      input.subscriptionId,
      input.sourceMessageId,
      input.accountId,
      input.conversationId,
    )
    .first<{ destination_version: number }>();
  return row?.destination_version ?? null;
};

const insertDeliveryRows = async (
  database: D1Database,
  candidates: readonly Candidate[],
  removalEpoch: number,
  now: string,
): Promise<void> => {
  for (
    let offset = 0;
    offset < candidates.length;
    offset += MAX_DELIVERY_BATCH
  ) {
    const chunk = candidates.slice(offset, offset + MAX_DELIVERY_BATCH);
    await database.batch(
      chunk.map((candidate) =>
        database
          .prepare(
            `INSERT OR IGNORE INTO webhook_deliveries
             (id, tenant_id, subscription_id, source_event_id,
              event_type, source_message_id, source_identity_id, source_account_id,
              source_conversation_id, source_revision, destination_version,
              status, first_pending_at, retry_deadline, attempt_count,
              next_attempt_at, cancelled_at, cancellation_reason, lease_id,
              lease_expires_at, last_attempt_at, delivered_at, http_status,
              error_code, payload_json, last_response_body, manual_retry_at,
              uncertain_at, uncertainty_reason, removal_epoch)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0,
                     ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                     NULL, NULL, NULL, NULL, ?)`,
          )
          .bind(
            candidate.deliveryId,
            candidate.event.tenant_id,
            candidate.subscription.id,
            candidate.event.event_id,
            candidate.eventType,
            candidate.sourceMessageId,
            candidate.event.identity_id,
            candidate.event.account_id,
            candidate.event.conversation_id,
            candidate.event.event_id,
            candidate.subscription.destination_version,
            now,
            retryDeadlineFor(now),
            now,
            removalEpoch,
          ),
      ),
    );
  }
};

type RemovalAuthorityRow = {
  id: string;
  tenant_id: string;
  resource_type: string;
  resource_id: string;
  content_generation: string;
  account_id: string | null;
  conversation_id: string | null;
  source_event_id: string | null;
  reason: string;
  removed_at: string;
};

type DeliveredSourceRow = {
  subscription_id: string;
  source_message_id: string | null;
  source_identity_id: string | null;
  source_account_id: string | null;
  source_conversation_id: string | null;
  destination_version: number;
  payload_json: string | null;
};

const authoritySourceEventId = (
  authority: RemovalAuthorityRow,
  sourceMessageId: string,
): string => {
  const base = authority.source_event_id ?? `removal_${authority.id}`;
  return authority.resource_type === "message"
    ? base
    : `${base}:message:${sourceMessageId}`;
};

const deliveredRowsForRemovalAuthority = async (
  database: D1Database,
  authority: RemovalAuthorityRow,
): Promise<DeliveredSourceRow[]> => {
  const sourceFilter =
    authority.resource_type === "message"
      ? "source_message_id = ?"
      : authority.resource_type === "conversation"
        ? "source_conversation_id = ?"
        : "source_message_id IS NOT NULL";
  const rows = await database
    .prepare(
      `SELECT subscription_id, source_message_id, source_identity_id,
              source_account_id, source_conversation_id, destination_version,
              payload_json
       FROM webhook_deliveries
       WHERE tenant_id = ? AND status = 'delivered' AND ${sourceFilter}
       ORDER BY subscription_id ASC, source_message_id ASC, id ASC`,
    )
    .bind(
      authority.tenant_id,
      ...(authority.resource_type === "message"
        ? [authority.resource_id]
        : authority.resource_type === "conversation"
          ? [authority.resource_id]
          : []),
    )
    .all<DeliveredSourceRow>();
  if (authority.resource_type !== "attachment") return rows.results;
  return rows.results.filter((row) => {
    if (row.payload_json === null) return false;
    try {
      const parsed: unknown = JSON.parse(row.payload_json);
      const payload = WebhookDeliveryPayloadSchema.safeParse(parsed);
      return (
        payload.success &&
        "attachments" in payload.data &&
        payload.data.attachments.some(
          (attachment) => attachment.attachment_id === authority.resource_id,
        )
      );
    } catch {
      return false;
    }
  });
};

const authorityAppliesToDeliveredRow = (
  authority: RemovalAuthorityRow,
  row: DeliveredSourceRow,
): boolean =>
  row.source_message_id !== null &&
  row.source_identity_id !== null &&
  row.source_account_id !== null &&
  row.source_conversation_id !== null &&
  (authority.account_id === null ||
    authority.account_id === row.source_account_id) &&
  (authority.conversation_id === null ||
    authority.conversation_id === row.source_conversation_id);

const insertRemovalDeliveryRows = async (
  database: D1Database,
  authority: RemovalAuthorityRow,
  subscriptions: readonly WebhookSubscription[],
  rows: readonly DeliveredSourceRow[],
  removalEpoch: number,
  now: string,
): Promise<string[]> => {
  const candidates: Array<{
    id: string;
    subscription: WebhookSubscription;
    row: DeliveredSourceRow;
    sourceEventId: string;
    sourceMessageId: string;
  }> = [];
  for (const row of rows) {
    if (!authorityAppliesToDeliveredRow(authority, row)) continue;
    const sourceMessageId = row.source_message_id;
    if (sourceMessageId === null) continue;
    const subscription = subscriptions.find(
      (value) => value.id === row.subscription_id,
    );
    if (
      subscription === undefined ||
      subscription.destination_version !== row.destination_version ||
      !subscriptionAllowsStoredDelivery(subscription, {
        event_type: WEBHOOK_MESSAGE_DELETED,
        source_account_id: row.source_account_id,
        source_conversation_id: row.source_conversation_id,
      }) ||
      !(await currentAuthority(
        databaseSession(database),
        subscription,
        row.source_account_id ?? "",
        row.source_conversation_id ?? "",
      ))
    ) {
      continue;
    }
    const sourceEventId = authoritySourceEventId(authority, sourceMessageId);
    candidates.push({
      id: await stableDeliveryId(
        authority.tenant_id,
        subscription.id,
        sourceEventId,
      ),
      subscription,
      row,
      sourceEventId,
      sourceMessageId,
    });
  }
  if (candidates.length === 0) return [];
  const retryDeadline = retryDeadlineFor(now);
  await database.batch(
    candidates.map((candidate) =>
      database
        .prepare(
          `INSERT OR IGNORE INTO webhook_deliveries
           (id, tenant_id, subscription_id, source_event_id, event_type,
            source_message_id, source_identity_id, source_account_id,
            source_conversation_id, source_revision, destination_version,
            status, first_pending_at, retry_deadline, attempt_count,
            next_attempt_at, cancelled_at, cancellation_reason, lease_id,
            lease_expires_at, last_attempt_at, delivered_at, http_status,
            error_code, payload_json, last_response_body, manual_retry_at,
            uncertain_at, uncertainty_reason, removal_epoch)
           VALUES (?, ?, ?, ?, 'message.deleted', ?, ?, ?, ?, ?, ?, 'pending',
                   ?, ?, 0, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                   NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
        )
        .bind(
          candidate.id,
          authority.tenant_id,
          candidate.subscription.id,
          candidate.sourceEventId,
          candidate.sourceMessageId,
          candidate.row.source_identity_id,
          candidate.row.source_account_id,
          candidate.row.source_conversation_id,
          authority.source_event_id ?? authority.content_generation,
          candidate.subscription.destination_version,
          now,
          retryDeadline,
          now,
          removalEpoch,
        ),
    ),
  );
  return candidates.map((candidate) => candidate.id);
};

/**
 * Reconcile durable removal authority with destinations that already received
 * the message. This covers API/MCP deletes and expiry records that do not
 * carry a projection deletion event through ingestion.
 */
export const reconcileWebhookRemovalDeliveries = async (input: {
  database: D1Database;
  tenantId?: string;
  now?: (() => Date) | undefined;
}): Promise<string[]> => {
  const now = input.now?.() ?? new Date();
  const authorityQuery = input.tenantId
    ? input.database
        .prepare(
          `SELECT id, tenant_id, resource_type, resource_id,
                  content_generation, account_id, conversation_id,
                  source_event_id, reason, removed_at
           FROM removal_authority
           WHERE tenant_id = ? AND status IN ('active', 'completed', 'failed')
           ORDER BY removed_at ASC, id ASC`,
        )
        .bind(input.tenantId)
    : input.database.prepare(
        `SELECT id, tenant_id, resource_type, resource_id,
                content_generation, account_id, conversation_id,
                source_event_id, reason, removed_at
         FROM removal_authority
         WHERE status IN ('active', 'completed', 'failed')
         ORDER BY removed_at ASC, id ASC`,
      );
  const authorities = await authorityQuery.all<RemovalAuthorityRow>();
  const subscriptionsByTenant = new Map<string, WebhookSubscription[]>();
  const ids: string[] = [];
  for (const authority of authorities.results) {
    if (
      authority.resource_type !== "message" &&
      authority.resource_type !== "conversation" &&
      authority.resource_type !== "attachment"
    ) {
      continue;
    }
    let subscriptions = subscriptionsByTenant.get(authority.tenant_id);
    if (subscriptions === undefined) {
      subscriptions = await readActiveSubscriptions(
        databaseSession(input.database),
        authority.tenant_id,
      );
      subscriptionsByTenant.set(authority.tenant_id, subscriptions);
    }
    const deliveredRows = await deliveredRowsForRemovalAuthority(
      input.database,
      authority,
    );
    ids.push(
      ...(await insertRemovalDeliveryRows(
        input.database,
        authority,
        subscriptions,
        deliveredRows,
        await readTenantDeletionEpoch(input.database, authority.tenant_id),
        now.toISOString(),
      )),
    );
  }
  return [...new Set(ids)];
};

const readDelivery = async (
  db: D1DatabaseSession,
  tenantId: string,
  deliveryId: string,
): Promise<DeliveryRow | null> => {
  const row = await db
    .prepare(
      `SELECT id, tenant_id, subscription_id, source_event_id,
              event_type, source_message_id, source_identity_id, source_account_id,
              source_conversation_id, source_revision, destination_version,
              status, first_pending_at, retry_deadline, attempt_count,
              next_attempt_at, cancelled_at, cancellation_reason, lease_id,
              lease_expires_at, removal_epoch, provider_request_started_at,
              last_attempt_at, delivered_at, http_status,
              error_code, payload_json, last_response_body, manual_retry_at,
              uncertain_at, uncertainty_reason
       FROM webhook_deliveries
       WHERE tenant_id = ? AND id = ?
       LIMIT 1`,
    )
    .bind(tenantId, deliveryId)
    .first<DeliveryRow>();
  return row ?? null;
};

const claimDelivery = async (
  database: D1Database,
  tenantId: string,
  deliveryId: string,
  now: Date,
): Promise<DeliveryClaim> => {
  const leaseId = `lease_${crypto.randomUUID()}`;
  const leasedUntil = new Date(now.getTime() + DELIVERY_LEASE_MS).toISOString();
  const nowIso = now.toISOString();
  const db = databaseSession(database);
  await database
    .prepare(
      `UPDATE webhook_deliveries
       SET status = 'uncertain', uncertain_at = ?,
           uncertainty_reason = 'delivery_lease_expired_in_flight',
           delivered_at = NULL, next_attempt_at = NULL,
           error_code = 'delivery_uncertain', lease_id = NULL,
           lease_expires_at = NULL, manual_retry_at = NULL
       WHERE tenant_id = ? AND id = ? AND status = 'leased'
         AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
         AND provider_request_started_at IS NOT NULL`,
    )
    .bind(nowIso, tenantId, deliveryId, nowIso)
    .run();
  await database
    .prepare(
      `UPDATE webhook_deliveries
       SET status = 'failed', error_code = 'retry_deadline_exceeded',
           next_attempt_at = NULL, lease_id = NULL, lease_expires_at = NULL,
           manual_retry_at = NULL, provider_request_started_at = NULL
       WHERE tenant_id = ? AND id = ?
         AND retry_deadline <= ? AND manual_retry_at IS NULL
         AND (
           status = 'pending'
           OR (status = 'leased' AND lease_expires_at IS NOT NULL
               AND lease_expires_at <= ?
               AND provider_request_started_at IS NULL)
         )`,
    )
    .bind(tenantId, deliveryId, nowIso, nowIso)
    .run();
  await database
    .prepare(
      `UPDATE webhook_deliveries
       SET status = 'leased', lease_id = ?, lease_expires_at = ?,
           last_attempt_at = ?, attempt_count = attempt_count + 1,
           next_attempt_at = NULL, manual_retry_at = NULL,
           provider_request_started_at = NULL,
           removal_epoch = COALESCE(
             (
               SELECT MAX(authority.deletion_epoch)
               FROM removal_authority AS authority
               WHERE authority.tenant_id = webhook_deliveries.tenant_id
             ),
             0
           )
       WHERE tenant_id = ? AND id = ?
         AND (
           (
             status = 'pending'
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             AND (manual_retry_at IS NOT NULL OR retry_deadline > ?)
           )
           OR (
             status = 'leased' AND lease_expires_at IS NOT NULL
             AND lease_expires_at <= ? AND retry_deadline > ?
             AND provider_request_started_at IS NULL
           )
         )`,
    )
    .bind(
      leaseId,
      leasedUntil,
      nowIso,
      tenantId,
      deliveryId,
      nowIso,
      nowIso,
      nowIso,
      nowIso,
    )
    .run();
  const row = await readDelivery(db, tenantId, deliveryId);
  if (row === null || row.status !== "leased" || row.lease_id !== leaseId) {
    const heldByAnotherWorker =
      row?.status === "leased" &&
      row.lease_id !== null &&
      (row.lease_expires_at === null ||
        Date.parse(row.lease_expires_at) > now.getTime());
    return { lease: null, busy: heldByAnotherWorker };
  }
  return {
    lease: { ...row, lease_id: leaseId, lease_expires_at: leasedUntil },
    busy: false,
  };
};

const cancelDelivery = async (
  database: D1Database,
  tenantId: string,
  deliveryId: string,
  leaseId: string,
  reason: string,
  now: string,
): Promise<void> => {
  await database
    .prepare(
      `UPDATE webhook_deliveries
       SET status = 'cancelled', cancelled_at = ?, cancellation_reason = ?,
           lease_id = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
           payload_json = NULL, manual_retry_at = NULL, uncertain_at = NULL,
           uncertainty_reason = NULL, provider_request_started_at = NULL
       WHERE tenant_id = ? AND id = ? AND status = 'leased' AND lease_id = ?`,
    )
    .bind(now, reason, tenantId, deliveryId, leaseId)
    .run();
};

const finishSuccessfulDelivery = async (
  database: D1Database,
  input: {
    tenantId: string;
    deliveryId: string;
    leaseId: string;
    now: string;
    httpStatus: number | null;
    payloadJson: string | null;
    responseBody: string | null;
    removalEpoch: number;
  },
): Promise<boolean> => {
  const result = await database
    .prepare(
      `UPDATE webhook_deliveries
       SET status = 'delivered', delivered_at = ?, http_status = ?,
           error_code = NULL, payload_json = ?, last_response_body = ?,
           lease_id = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
           manual_retry_at = NULL, uncertain_at = NULL, uncertainty_reason = NULL,
           provider_request_started_at = NULL
       WHERE tenant_id = ? AND id = ? AND status = 'leased' AND lease_id = ?
         AND provider_request_started_at IS NOT NULL
         AND removal_epoch = ?
         AND ? = COALESCE(
           (
             SELECT MAX(authority.deletion_epoch)
             FROM removal_authority AS authority
             WHERE authority.tenant_id = webhook_deliveries.tenant_id
           ),
           0
         )`,
    )
    .bind(
      input.now,
      input.httpStatus,
      input.payloadJson,
      input.responseBody,
      input.tenantId,
      input.deliveryId,
      input.leaseId,
      input.removalEpoch,
      input.removalEpoch,
    )
    .run();
  return (result.meta.changes ?? 0) === 1;
};

const finishFailedDelivery = async (
  database: D1Database,
  input: {
    tenantId: string;
    deliveryId: string;
    leaseId: string;
    now: Date;
    retryDeadline: string;
    attemptCount: number;
    httpStatus: number | null;
    errorCode: string;
    payloadJson: string | null;
    responseBody: string | null;
    providerRequestStarted: boolean;
    removalEpoch: number;
  },
): Promise<boolean> => {
  const deadlineMs = Date.parse(input.retryDeadline);
  const retryable =
    Number.isFinite(deadlineMs) && input.now.getTime() < deadlineMs;
  const nextAttemptAt = retryable
    ? new Date(
        Math.min(
          input.now.getTime() + retryDelayFor(input.attemptCount),
          deadlineMs,
        ),
      ).toISOString()
    : null;
  const result = await database
    .prepare(
      `UPDATE webhook_deliveries
       SET status = ?, next_attempt_at = ?,
           delivered_at = NULL, http_status = ?, error_code = ?,
           payload_json = ?, last_response_body = ?, lease_id = NULL,
           lease_expires_at = NULL, manual_retry_at = NULL,
           uncertain_at = NULL, uncertainty_reason = NULL,
           provider_request_started_at = NULL
       WHERE tenant_id = ? AND id = ? AND status = 'leased' AND lease_id = ?
         AND (? = 0 OR provider_request_started_at IS NOT NULL)
         AND removal_epoch = ?
         AND ? = COALESCE(
           (
             SELECT MAX(authority.deletion_epoch)
             FROM removal_authority AS authority
             WHERE authority.tenant_id = webhook_deliveries.tenant_id
           ),
           0
         )`,
    )
    .bind(
      retryable ? "pending" : "failed",
      nextAttemptAt,
      input.httpStatus,
      retryable ? input.errorCode : "retry_deadline_exceeded",
      input.payloadJson,
      input.responseBody,
      input.tenantId,
      input.deliveryId,
      input.leaseId,
      input.providerRequestStarted ? 1 : 0,
      input.removalEpoch,
      input.removalEpoch,
    )
    .run();
  if ((result.meta.changes ?? 0) !== 1) return false;
  if (!retryable) {
    await database
      .prepare(
        `UPDATE webhook_deliveries
         SET next_attempt_at = NULL
         WHERE tenant_id = ? AND id = ? AND status = 'failed'`,
      )
      .bind(input.tenantId, input.deliveryId)
      .run();
  }
  return true;
};

const finishUncertainDelivery = async (
  database: D1Database,
  input: {
    tenantId: string;
    deliveryId: string;
    leaseId: string;
    now: string;
    httpStatus: number | null;
    reason: string;
    payloadJson: string | null;
    responseBody: string | null;
  },
): Promise<void> => {
  await database
    .prepare(
      `UPDATE webhook_deliveries
       SET status = 'uncertain', uncertain_at = ?, uncertainty_reason = ?,
           delivered_at = NULL, next_attempt_at = NULL, http_status = ?,
           error_code = 'delivery_uncertain', payload_json = ?,
           last_response_body = ?, lease_id = NULL, lease_expires_at = NULL,
           manual_retry_at = NULL
       WHERE tenant_id = ? AND id = ? AND status = 'leased' AND lease_id = ?`,
    )
    .bind(
      input.now,
      input.reason,
      input.httpStatus,
      input.payloadJson,
      input.responseBody,
      input.tenantId,
      input.deliveryId,
      input.leaseId,
    )
    .run();
};

/**
 * Atomically cross the durable provider-I/O boundary.  The epoch comparison
 * is in the same UPDATE as the provider-start marker, so a removal committed
 * before this claim cannot be followed by an HTTP request.
 */
const claimProviderRequest = async (
  database: D1Database,
  input: {
    tenantId: string;
    deliveryId: string;
    leaseId: string;
    now: string;
    expectedRemovalEpoch: number;
  },
): Promise<boolean> => {
  const result = await database
    .prepare(
      `UPDATE webhook_deliveries
       SET provider_request_started_at = ?, removal_epoch = ?
       WHERE tenant_id = ? AND id = ? AND status = 'leased'
         AND lease_id = ? AND provider_request_started_at IS NULL
         AND lease_expires_at IS NOT NULL AND lease_expires_at > ?
         AND ? = COALESCE(
           (
             SELECT MAX(authority.deletion_epoch)
             FROM removal_authority AS authority
             WHERE authority.tenant_id = webhook_deliveries.tenant_id
           ),
           0
         )`,
    )
    .bind(
      input.now,
      input.expectedRemovalEpoch,
      input.tenantId,
      input.deliveryId,
      input.leaseId,
      input.now,
      input.expectedRemovalEpoch,
    )
    .run();
  return (result.meta.changes ?? 0) === 1;
};

const projectionAuthorization = (
  tenantId: string,
  principalId: string,
  identityId: string,
): GetWebhookMessageInput["authorization"] =>
  ProjectionAuthorizationContextSchema.parse({
    schema_version: 1,
    tenant_id: tenantId,
    principal_id: principalId,
    allowed_identity_ids: [identityId],
    scopes: ["projection.read"],
  });

const toGrantAttachment = (
  attachment: WebhookMessage["attachments"][number],
): ProjectionAttachment =>
  ({
    attachment_id: attachment.attachment_id,
    message_id: attachment.message_id,
    identity_id: attachment.identity_id,
    account_id: attachment.account_id,
    connection_id: attachment.connection_id,
    conversation_id: attachment.conversation_id,
    platform: attachment.platform,
    file_name: attachment.file_name,
    mime_type: attachment.mime_type,
    size_bytes: attachment.size_bytes,
    sha256: attachment.sha256,
    media_key: null,
    revision: attachment.revision,
    expires_at: attachment.expires_at,
    deleted_at: null,
  }) as ProjectionAttachment;

const payloadFor = async (
  database: D1Database,
  subscription: WebhookSubscription,
  deliveryId: string,
  sourceEventId: string,
  message: WebhookMessage,
  now: Date,
  eventType: typeof WEBHOOK_MESSAGE_CREATED | typeof WEBHOOK_MESSAGE_EDITED,
  revisionOverride?: string,
): Promise<WebhookDeliveryPayload> => {
  if (message.deleted_at !== null || message.direction !== "inbound") {
    throw new Error("webhook message is unavailable");
  }
  const actorIdentityId =
    subscription.creator_identity_id ?? message.identity_id;
  const attachments = await Promise.all(
    message.attachments.map(async (attachment) => {
      const grant = await issueAttachmentGrant(
        database,
        message.tenant_id,
        actorIdentityId,
        toGrantAttachment(attachment),
        now,
      );
      return {
        attachment_id: attachment.attachment_id,
        message_id: attachment.message_id,
        file_name: attachment.file_name,
        mime_type: attachment.mime_type,
        size_bytes: attachment.size_bytes,
        sha256: attachment.sha256,
        revision: attachment.revision,
        download_path: `/api/v1/attachments/${attachment.attachment_id}/download`,
        download_grant: grant.token,
        download_grant_expires_at: grant.expires_at,
      };
    }),
  );
  return WebhookDeliveryPayloadSchema.parse({
    schema_version: 1,
    type: eventType,
    delivery_id: deliveryId,
    source_event_id: sourceEventId,
    source_message_id: message.message_id,
    tenant_id: message.tenant_id,
    identity_id: message.identity_id,
    account_id: message.account_id,
    chat_id: message.conversation_id,
    revision: revisionOverride ?? message.revision,
    timestamp: message.occurred_at,
    sender: {
      participant_id: message.sender_participant_id,
      label: message.sender_label,
    },
    text: message.body,
    source: {
      remote_message_id: message.remote_message_id,
      matrix_room_id: message.matrix_room_id,
      matrix_event_id: message.matrix_event_id,
    },
    attachments,
  });
};

const currentSubscription = async (
  db: D1DatabaseSession,
  tenantId: string,
  subscriptionId: string,
): Promise<WebhookSubscription | null> => {
  const row = await db
    .prepare(
      "SELECT id FROM webhook_subscriptions WHERE tenant_id = ? AND id = ? LIMIT 1",
    )
    .bind(tenantId, subscriptionId)
    .first<{ id: string }>();
  if (row === null) return null;
  try {
    return await getWebhookSubscription(db, tenantId, subscriptionId);
  } catch {
    return null;
  }
};

const currentMessageFor = async (
  projection: WebhookProjection,
  delivery: DeliveryLease,
  subscription: WebhookSubscription,
): Promise<WebhookMessage | null> => {
  if (
    delivery.source_message_id === null ||
    delivery.source_identity_id === null ||
    delivery.source_account_id === null ||
    delivery.source_conversation_id === null
  ) {
    return null;
  }
  if (isWebhookRemovalDelivery(delivery.event_type)) return null;
  const authorization = projectionAuthorization(
    delivery.tenant_id,
    subscription.owner_principal_id,
    delivery.source_identity_id,
  );
  const message = await projection.getWebhookMessage(
    GetWebhookMessageInputSchema.parse({
      schema_version: 1,
      tenant_id: delivery.tenant_id,
      identity_id: delivery.source_identity_id,
      account_id: delivery.source_account_id,
      conversation_id: delivery.source_conversation_id,
      message_id: delivery.source_message_id,
      authorization,
    }),
  );
  if (
    message === null ||
    message.deleted_at !== null ||
    message.direction !== "inbound"
  ) {
    return null;
  }
  return message;
};

const attachmentIdsForMessage = (
  message: WebhookMessage | null,
): readonly string[] =>
  message?.attachments.map((attachment) => attachment.attachment_id) ?? [];

const attachmentIdsForPayload = (
  payloadJson: string | null,
): readonly string[] => {
  if (payloadJson === null) return [];
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    const payload = WebhookDeliveryPayloadSchema.safeParse(parsed);
    return payload.success && "attachments" in payload.data
      ? payload.data.attachments.map((attachment) => attachment.attachment_id)
      : [];
  } catch {
    return [];
  }
};

const removalForDelivery = async (
  database: D1Database,
  delivery: Pick<
    DeliveryRow,
    | "tenant_id"
    | "subscription_id"
    | "source_message_id"
    | "source_account_id"
    | "source_conversation_id"
    | "payload_json"
  >,
  currentAttachmentIds: readonly string[] = [],
) => {
  if (
    delivery.source_message_id === null ||
    delivery.source_account_id === null ||
    delivery.source_conversation_id === null
  ) {
    return null;
  }
  const messageRemoval = await readAuthorizedMessageRemoval(database, {
    tenantId: delivery.tenant_id,
    messageId: delivery.source_message_id,
    accountId: delivery.source_account_id,
    conversationId: delivery.source_conversation_id,
  });
  if (messageRemoval !== null) return messageRemoval;

  const attachmentIds = [
    ...new Set([
      ...currentAttachmentIds,
      ...attachmentIdsForPayload(delivery.payload_json),
    ]),
  ];
  for (const attachmentId of attachmentIds) {
    const attachmentRemoval = await readAuthorizedResourceRemoval(database, {
      tenantId: delivery.tenant_id,
      resourceType: "attachment",
      resourceId: attachmentId,
      accountId: delivery.source_account_id,
      conversationId: delivery.source_conversation_id,
    });
    if (attachmentRemoval !== null) return attachmentRemoval;
  }

  // Attachment authorities do not replace the message lineage. Match the
  // removed attachment against the already delivered metadata and return the
  // authority so the next event remains content-free.
  const attachmentRows = await database
    .prepare(
      `SELECT * FROM removal_authority
       WHERE tenant_id = ? AND resource_type = 'attachment'
         AND status IN ('active', 'completed', 'failed')
         AND (account_id IS NULL OR account_id = ?)
         AND (conversation_id IS NULL OR conversation_id = ?)
       ORDER BY removed_at DESC, id DESC`,
    )
    .bind(
      delivery.tenant_id,
      delivery.source_account_id,
      delivery.source_conversation_id,
    )
    .all<Record<string, unknown>>();
  if (attachmentRows.results.length === 0) return null;
  const delivered = await database
    .prepare(
      `SELECT payload_json
       FROM webhook_deliveries
       WHERE tenant_id = ? AND subscription_id = ?
         AND source_message_id = ? AND status = 'delivered'
         AND payload_json IS NOT NULL
       ORDER BY delivered_at DESC, id DESC
       LIMIT 1`,
    )
    .bind(
      delivery.tenant_id,
      delivery.subscription_id,
      delivery.source_message_id,
    )
    .first<{ payload_json: string }>();
  if (delivered?.payload_json === undefined) return null;
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(delivered.payload_json);
  } catch {
    return null;
  }
  const payloadResult = WebhookDeliveryPayloadSchema.safeParse(parsedPayload);
  if (!payloadResult.success || !("attachments" in payloadResult.data)) {
    return null;
  }
  for (const row of attachmentRows.results) {
    const authority = RemovalAuthoritySchema.safeParse(row);
    if (!authority.success) continue;
    if (
      payloadResult.data.attachments.some(
        (attachment) => attachment.attachment_id === authority.data.resource_id,
      )
    ) {
      return authority.data;
    }
  }
  return null;
};

const removalAttachmentsForDelivery = async (
  db: D1DatabaseSession,
  delivery: DeliveryLease,
  message: WebhookMessage | null,
): Promise<
  ReadonlyArray<{
    attachment_id: string;
    message_id: string;
    file_name: string | null;
    mime_type: string | null;
    size_bytes: number | null;
    sha256: string | null;
    revision: string;
  }>
> => {
  const fromMessage = message?.attachments ?? [];
  if (fromMessage.length > 0) {
    return fromMessage.map((attachment) => ({
      attachment_id: attachment.attachment_id,
      message_id: attachment.message_id,
      file_name: attachment.file_name,
      mime_type: attachment.mime_type,
      size_bytes: attachment.size_bytes,
      sha256: attachment.sha256,
      revision: attachment.revision,
    }));
  }
  const row = await db
    .prepare(
      `SELECT payload_json
       FROM webhook_deliveries
       WHERE tenant_id = ? AND subscription_id = ?
         AND source_message_id = ? AND event_type = 'message.created'
         AND status = 'delivered' AND payload_json IS NOT NULL
       ORDER BY delivered_at DESC, id DESC
       LIMIT 1`,
    )
    .bind(
      delivery.tenant_id,
      delivery.subscription_id,
      delivery.source_message_id,
    )
    .first<{ payload_json: string }>();
  if (row?.payload_json === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(row.payload_json);
    const result = WebhookDeliveryPayloadSchema.safeParse(parsed);
    if (!result.success || !("attachments" in result.data)) return [];
    return result.data.attachments.map((attachment) => ({
      attachment_id: attachment.attachment_id,
      message_id: attachment.message_id,
      file_name: attachment.file_name,
      mime_type: attachment.mime_type,
      size_bytes: attachment.size_bytes,
      sha256: attachment.sha256,
      revision: attachment.revision,
    }));
  } catch {
    return [];
  }
};

const removalPayloadFor = async (
  database: D1Database,
  db: D1DatabaseSession,
  projection: WebhookProjection,
  delivery: DeliveryLease,
  subscription: WebhookSubscription,
  authority: NonNullable<Awaited<ReturnType<typeof removalForDelivery>>>,
): Promise<WebhookRemovalDeliveryPayload> => {
  if (
    delivery.source_message_id === null ||
    delivery.source_identity_id === null ||
    delivery.source_account_id === null ||
    delivery.source_conversation_id === null
  ) {
    throw new Error("webhook removal source is incomplete");
  }
  const authorization = projectionAuthorization(
    delivery.tenant_id,
    subscription.owner_principal_id,
    delivery.source_identity_id,
  );
  let message: WebhookMessage | null = null;
  try {
    message = await projection.getWebhookMessage(
      GetWebhookMessageInputSchema.parse({
        schema_version: 1,
        tenant_id: delivery.tenant_id,
        identity_id: delivery.source_identity_id,
        account_id: delivery.source_account_id,
        conversation_id: delivery.source_conversation_id,
        message_id: delivery.source_message_id,
        authorization,
      }),
    );
  } catch {
    // The authority remains sufficient to send a content-free event even if
    // the redacted projection is temporarily unavailable.
  }
  const attachmentMetadata = await removalAttachmentsForDelivery(
    db,
    delivery,
    message,
  );
  return WebhookRemovalDeliveryPayloadSchema.parse({
    schema_version: 1,
    type: "message.deleted",
    delivery_id: delivery.id,
    source_event_id: delivery.source_event_id,
    source_message_id: delivery.source_message_id,
    tenant_id: delivery.tenant_id,
    identity_id: delivery.source_identity_id,
    account_id: delivery.source_account_id,
    chat_id: delivery.source_conversation_id,
    revision:
      delivery.source_revision ??
      authority.source_event_id ??
      authority.content_generation,
    timestamp: authority.removed_at,
    removed_at: authority.removed_at,
    removal_reason: authority.reason,
    content_generation: authority.content_generation,
    source: {
      remote_message_id: message?.remote_message_id ?? null,
      matrix_room_id: message?.matrix_room_id ?? null,
      matrix_event_id: message?.matrix_event_id ?? null,
    },
    text: "",
    attachments: attachmentMetadata,
  });
};

const deliverOne = async (
  database: D1Database,
  projection: WebhookProjection,
  tenantId: string,
  deliveryId: string,
  services: WebhookDeliveryServices,
): Promise<void> => {
  const now = nowFor(services);
  await services.beforeClaim?.(deliveryId);
  const claim = await claimDelivery(database, tenantId, deliveryId, now);
  if (claim.busy) throw new Error("webhook delivery lease is active");
  const lease = claim.lease;
  if (lease === null) return;
  const db = databaseSession(database);
  let removalEpoch = lease.removal_epoch;
  let providerRequestStarted = false;
  let payloadJson: string | null = null;
  let currentMessage: WebhookMessage | null = null;
  const sourceAttachmentIds = (): readonly string[] =>
    attachmentIdsForMessage(currentMessage);
  const authorizationMatches = async (
    subscription: WebhookSubscription | null,
    credentialRef: string | null | undefined,
  ): Promise<boolean> =>
    subscription !== null &&
    subscription.status === "active" &&
    subscriptionAllowsStoredDelivery(subscription, lease) &&
    subscription.destination_version === lease.destination_version &&
    subscription.destination.credential_ref === credentialRef &&
    lease.source_account_id !== null &&
    lease.source_conversation_id !== null &&
    (await currentAuthority(
      db,
      subscription,
      lease.source_account_id,
      lease.source_conversation_id,
    ));

  const cancelFor = async (
    subscription: WebhookSubscription | null,
    credentialRef: string | null | undefined,
  ): Promise<void> => {
    await cancelDelivery(
      database,
      tenantId,
      deliveryId,
      lease.lease_id,
      subscription === null || subscription.status !== "active"
        ? "subscription_revoked"
        : subscription.destination_version !== lease.destination_version ||
            subscription.destination.credential_ref !== credentialRef
          ? "destination_version_mismatch"
          : "authorization_revoked",
      now.toISOString(),
    );
  };

  const cancelForRemoval = async (reason = "source_removed"): Promise<void> => {
    await cancelDelivery(
      database,
      tenantId,
      deliveryId,
      lease.lease_id,
      reason,
      now.toISOString(),
    );
  };

  const removalFence = async (
    attachmentIds: readonly string[] = sourceAttachmentIds(),
  ): Promise<{
    changed: boolean;
    authority: Awaited<ReturnType<typeof removalForDelivery>>;
  }> => {
    const currentEpoch = await readTenantDeletionEpoch(database, tenantId);
    const authority = await removalForDelivery(database, lease, attachmentIds);
    const changed = currentEpoch !== removalEpoch;
    removalEpoch = currentEpoch;
    return { changed, authority };
  };

  const removalUncertaintyReason = (): string =>
    isWebhookRemovalDelivery(lease.event_type)
      ? "removal_epoch_advanced_in_flight"
      : "source_removed_in_flight";

  const removalBecameUncertain = (fence: {
    changed: boolean;
    authority: Awaited<ReturnType<typeof removalForDelivery>>;
  }): boolean =>
    fence.changed ||
    (!isWebhookRemovalDelivery(lease.event_type) && fence.authority !== null);

  const finishUncertainAfterRemovalRace = async (
    httpStatus: number | null,
    responseBody: string | null,
  ): Promise<boolean> => {
    let removal: Awaited<ReturnType<typeof removalFence>>;
    try {
      removal = await removalFence();
    } catch {
      await finishUncertainDelivery(database, {
        tenantId,
        deliveryId,
        leaseId: lease.lease_id,
        now: nowFor(services).toISOString(),
        httpStatus,
        reason: "removal_fence_unavailable_in_flight",
        payloadJson,
        responseBody,
      });
      return true;
    }
    if (!removalBecameUncertain(removal)) return false;
    await finishUncertainDelivery(database, {
      tenantId,
      deliveryId,
      leaseId: lease.lease_id,
      now: nowFor(services).toISOString(),
      httpStatus,
      reason: removalUncertaintyReason(),
      payloadJson,
      responseBody,
    });
    return true;
  };

  const initialRemoval = await removalFence();
  if (
    (isWebhookRemovalDelivery(lease.event_type) &&
      initialRemoval.authority === null) ||
    (!isWebhookRemovalDelivery(lease.event_type) &&
      initialRemoval.authority !== null)
  ) {
    await cancelForRemoval(
      isWebhookRemovalDelivery(lease.event_type)
        ? "source_removal_authority_unavailable"
        : "source_removed",
    );
    return;
  }

  const markNetworkFailure = async (
    errorCode: string,
    httpStatus: number | null,
    responseBody: string | null,
  ): Promise<void> => {
    if (providerRequestStarted) {
      let removal: Awaited<ReturnType<typeof removalFence>>;
      try {
        removal = await removalFence();
      } catch {
        await finishUncertainDelivery(database, {
          tenantId,
          deliveryId,
          leaseId: lease.lease_id,
          now: nowFor(services).toISOString(),
          httpStatus,
          reason: "removal_fence_unavailable_in_flight",
          payloadJson,
          responseBody,
        });
        return;
      }
      if (removalBecameUncertain(removal)) {
        await finishUncertainDelivery(database, {
          tenantId,
          deliveryId,
          leaseId: lease.lease_id,
          now: nowFor(services).toISOString(),
          httpStatus,
          reason: removalUncertaintyReason(),
          payloadJson,
          responseBody,
        });
        return;
      }
    }
    const latest = await currentSubscription(
      db,
      tenantId,
      lease.subscription_id,
    );
    if (
      !(await authorizationMatches(latest, latest?.destination.credential_ref))
    ) {
      await finishUncertainDelivery(database, {
        tenantId,
        deliveryId,
        leaseId: lease.lease_id,
        now: nowFor(services).toISOString(),
        httpStatus,
        reason:
          latest === null || latest.status !== "active"
            ? "subscription_revoked_in_flight"
            : "destination_version_changed_in_flight",
        payloadJson,
        responseBody,
      });
      return;
    }
    const finished = await finishFailedDelivery(database, {
      tenantId,
      deliveryId,
      leaseId: lease.lease_id,
      now: nowFor(services),
      retryDeadline: lease.retry_deadline,
      attemptCount: lease.attempt_count,
      httpStatus,
      errorCode,
      payloadJson,
      responseBody,
      providerRequestStarted,
      removalEpoch,
    });
    if (!finished && providerRequestStarted) {
      await finishUncertainAfterRemovalRace(httpStatus, responseBody);
    }
  };
  try {
    const subscription = await currentSubscription(
      db,
      tenantId,
      lease.subscription_id,
    );
    if (
      subscription === null ||
      !(await authorizationMatches(
        subscription,
        subscription.destination.credential_ref,
      ))
    ) {
      await cancelFor(subscription, subscription?.destination.credential_ref);
      return;
    }
    const activeSubscription = subscription;

    let authorizationHeader: string | null = null;
    const credentialRef = activeSubscription.destination.credential_ref;
    if (credentialRef !== undefined && credentialRef !== null) {
      const resolver =
        services.resolveCredential === undefined &&
        services.credentialStore !== undefined
          ? (input: Parameters<WebhookCredentialResolver>[0]) =>
              resolveStoredCredential(services.credentialStore!, input)
          : services.resolveCredential;
      const credential = await resolver?.({
        tenantId,
        subscriptionId: activeSubscription.id,
        ownerPrincipalId: activeSubscription.owner_principal_id,
        ownerInstallationId: activeSubscription.owner_installation_id,
        credentialRef,
      });
      if (credential === null || credential === undefined) {
        await markNetworkFailure("credential_unavailable", null, null);
        return;
      }
      authorizationHeader = credential;
    }

    // This seam represents work that can occur after owner configuration has
    // been resolved but before the final authorization and revision fence.
    await services.beforeFetch?.(deliveryId);

    // Recheck immediately before the first network call. The second projection
    // read means an edit or tombstone injected by the race seam is reflected or
    // cancelled rather than sending stale content.
    const finalSubscription = await currentSubscription(
      db,
      tenantId,
      lease.subscription_id,
    );
    if (
      finalSubscription === null ||
      !(await authorizationMatches(finalSubscription, credentialRef))
    ) {
      await cancelFor(finalSubscription, credentialRef);
      return;
    }
    let activeFinalSubscription = finalSubscription;
    if (!isWebhookRemovalDelivery(lease.event_type)) {
      currentMessage = await currentMessageFor(
        projection,
        lease,
        activeFinalSubscription,
      );
      if (currentMessage === null) {
        await cancelDelivery(
          database,
          tenantId,
          deliveryId,
          lease.lease_id,
          "source_tombstoned_or_unavailable",
          now.toISOString(),
        );
        return;
      }
    }

    // A removal epoch can advance while the current message and attachment
    // grants are being prepared. Rehydrate once after any observed advance,
    // then perform one final scoped authority read immediately before HTTP.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const fence = await removalFence();
      if (
        (isWebhookRemovalDelivery(lease.event_type) &&
          fence.authority === null) ||
        (!isWebhookRemovalDelivery(lease.event_type) &&
          fence.authority !== null)
      ) {
        await cancelForRemoval(
          isWebhookRemovalDelivery(lease.event_type)
            ? "source_removal_authority_unavailable"
            : "source_removed",
        );
        return;
      }
      if (!fence.changed) break;
      const refreshedSubscription = await currentSubscription(
        db,
        tenantId,
        lease.subscription_id,
      );
      if (
        refreshedSubscription === null ||
        !(await authorizationMatches(refreshedSubscription, credentialRef))
      ) {
        await cancelFor(refreshedSubscription, credentialRef);
        return;
      }
      activeFinalSubscription = refreshedSubscription;
      if (!isWebhookRemovalDelivery(lease.event_type)) {
        currentMessage = await currentMessageFor(
          projection,
          lease,
          activeFinalSubscription,
        );
        if (currentMessage === null) {
          await cancelDelivery(
            database,
            tenantId,
            deliveryId,
            lease.lease_id,
            "source_tombstoned_or_unavailable",
            now.toISOString(),
          );
          return;
        }
      }
    }

    const preparedSubscription = await currentSubscription(
      db,
      tenantId,
      lease.subscription_id,
    );
    if (
      preparedSubscription === null ||
      !(await authorizationMatches(preparedSubscription, credentialRef))
    ) {
      await cancelFor(preparedSubscription, credentialRef);
      return;
    }
    activeFinalSubscription = preparedSubscription;
    const finalRemoval = await removalFence();
    if (
      (isWebhookRemovalDelivery(lease.event_type) &&
        finalRemoval.authority === null) ||
      (!isWebhookRemovalDelivery(lease.event_type) &&
        finalRemoval.authority !== null)
    ) {
      await cancelForRemoval(
        isWebhookRemovalDelivery(lease.event_type)
          ? "source_removal_authority_unavailable"
          : "source_removed",
      );
      return;
    }
    if (isWebhookRemovalDelivery(lease.event_type)) {
      if (finalRemoval.authority === null) {
        await cancelForRemoval("source_removal_authority_unavailable");
        return;
      }
      payloadJson = JSON.stringify(
        await removalPayloadFor(
          database,
          db,
          projection,
          lease,
          activeFinalSubscription,
          finalRemoval.authority,
        ),
      );
    } else if (currentMessage !== null) {
      payloadJson = JSON.stringify(
        await payloadFor(
          database,
          activeFinalSubscription,
          lease.id,
          lease.source_event_id,
          currentMessage,
          now,
          lease.event_type === WEBHOOK_MESSAGE_EDITED
            ? WEBHOOK_MESSAGE_EDITED
            : WEBHOOK_MESSAGE_CREATED,
          lease.event_type === WEBHOOK_MESSAGE_EDITED
            ? (lease.source_revision ?? undefined)
            : undefined,
        ),
      );
    } else {
      await cancelDelivery(
        database,
        tenantId,
        deliveryId,
        lease.lease_id,
        "source_tombstoned_or_unavailable",
        now.toISOString(),
      );
      return;
    }
    const sendSubscription = await currentSubscription(
      db,
      tenantId,
      lease.subscription_id,
    );
    if (
      sendSubscription === null ||
      !(await authorizationMatches(sendSubscription, credentialRef))
    ) {
      await cancelFor(sendSubscription, credentialRef);
      return;
    }
    activeFinalSubscription = sendSubscription;
    const sendRemoval = await removalFence();
    if (
      (isWebhookRemovalDelivery(lease.event_type) &&
        sendRemoval.authority === null) ||
      (!isWebhookRemovalDelivery(lease.event_type) &&
        sendRemoval.authority !== null)
    ) {
      await cancelForRemoval(
        isWebhookRemovalDelivery(lease.event_type)
          ? "source_removal_authority_unavailable"
          : "source_removed",
      );
      return;
    }

    providerRequestStarted = await claimProviderRequest(database, {
      tenantId,
      deliveryId,
      leaseId: lease.lease_id,
      now: nowFor(services).toISOString(),
      expectedRemovalEpoch: removalEpoch,
    });
    if (!providerRequestStarted) {
      const removal = await removalFence();
      if (
        (isWebhookRemovalDelivery(lease.event_type) &&
          removal.authority === null) ||
        (!isWebhookRemovalDelivery(lease.event_type) &&
          removal.authority !== null)
      ) {
        await cancelForRemoval(
          isWebhookRemovalDelivery(lease.event_type)
            ? "source_removal_authority_unavailable"
            : "source_removed",
        );
      } else if (removal.changed) {
        providerRequestStarted = await claimProviderRequest(database, {
          tenantId,
          deliveryId,
          leaseId: lease.lease_id,
          now: nowFor(services).toISOString(),
          expectedRemovalEpoch: removalEpoch,
        });
      }
      if (!providerRequestStarted) return;
    }

    const response = await fetchWithTimeout(
      services.fetch ?? fetch,
      activeFinalSubscription.destination.url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": deliveryId,
          ...(authorizationHeader === null
            ? {}
            : { authorization: authorizationHeader }),
        },
        body: payloadJson,
      },
      httpTimeoutFor(services),
    );
    const responseBody = await boundedResponseBody(
      response,
      httpTimeoutFor(services),
    );
    const outcomeNow = nowFor(services);
    let afterResponseRemoval: Awaited<ReturnType<typeof removalFence>>;
    try {
      afterResponseRemoval = await removalFence();
    } catch {
      await finishUncertainDelivery(database, {
        tenantId,
        deliveryId,
        leaseId: lease.lease_id,
        now: outcomeNow.toISOString(),
        httpStatus: response.status,
        reason: "removal_fence_unavailable_in_flight",
        payloadJson,
        responseBody,
      });
      return;
    }
    if (removalBecameUncertain(afterResponseRemoval)) {
      await finishUncertainDelivery(database, {
        tenantId,
        deliveryId,
        leaseId: lease.lease_id,
        now: outcomeNow.toISOString(),
        httpStatus: response.status,
        reason: removalUncertaintyReason(),
        payloadJson,
        responseBody,
      });
      return;
    }
    const afterResponse = await currentSubscription(
      db,
      tenantId,
      lease.subscription_id,
    );
    if (!(await authorizationMatches(afterResponse, credentialRef))) {
      await finishUncertainDelivery(database, {
        tenantId,
        deliveryId,
        leaseId: lease.lease_id,
        now: outcomeNow.toISOString(),
        httpStatus: response.status,
        reason:
          afterResponse === null || afterResponse.status !== "active"
            ? "subscription_revoked_in_flight"
            : "destination_version_changed_in_flight",
        payloadJson,
        responseBody,
      });
      return;
    }
    await services.beforeTerminalWrite?.(deliveryId);
    if (response.ok) {
      const finished = await finishSuccessfulDelivery(database, {
        tenantId,
        deliveryId,
        leaseId: lease.lease_id,
        now: outcomeNow.toISOString(),
        httpStatus: response.status,
        payloadJson,
        responseBody,
        removalEpoch,
      });
      if (!finished) {
        await finishUncertainAfterRemovalRace(response.status, responseBody);
      }
      return;
    }
    const finished = await finishFailedDelivery(database, {
      tenantId,
      deliveryId,
      leaseId: lease.lease_id,
      now: outcomeNow,
      retryDeadline: lease.retry_deadline,
      attemptCount: lease.attempt_count,
      httpStatus: response.status,
      errorCode: `http_${response.status}`,
      payloadJson,
      responseBody,
      providerRequestStarted,
      removalEpoch,
    });
    if (!finished) {
      await finishUncertainAfterRemovalRace(response.status, responseBody);
    }
  } catch {
    try {
      await markNetworkFailure("delivery_unavailable", null, null);
    } catch {
      // Leave the lease for durable expiry if storage or the final check is
      // unavailable; the scheduled sweep will make the row recoverable.
    }
  }
};

export const fanOutIncomingWebhookDeliveries = async (input: {
  database: D1Database;
  tenantId: string;
  events: readonly ProjectionEventEnvelope[];
  now?: (() => Date) | undefined;
}): Promise<string[]> => {
  const now = input.now?.() ?? new Date();
  const db = databaseSession(input.database);
  const subscriptions = await readActiveSubscriptions(db, input.tenantId);
  const candidates: Candidate[] = [];
  for (const event of input.events) {
    const eventType = webhookDeliveryEventTypeFor(event);
    const sourceMessageId = sourceMessageIdForWebhookEvent(event);
    if (
      event.tenant_id !== input.tenantId ||
      !isEligibleWebhookSource(event) ||
      eventType === null ||
      sourceMessageId === null
    ) {
      continue;
    }
    for (const subscription of subscriptions) {
      if (!subscriptionAllowsEvent(subscription, event)) continue;
      if (eventType !== WEBHOOK_MESSAGE_CREATED) {
        const previousDestinationVersion =
          await previouslyDeliveredDestinationVersion(db, {
            tenantId: input.tenantId,
            subscriptionId: subscription.id,
            sourceMessageId,
            accountId: event.account_id,
            conversationId: event.conversation_id,
          });
        if (
          previousDestinationVersion === null ||
          previousDestinationVersion !== subscription.destination_version
        ) {
          continue;
        }
      }
      if (
        !(await currentAuthority(
          db,
          subscription,
          event.account_id,
          event.conversation_id,
        ))
      ) {
        continue;
      }
      candidates.push({
        event,
        eventType,
        sourceMessageId,
        subscription,
        deliveryId: await stableDeliveryId(
          input.tenantId,
          subscription.id,
          event.event_id,
        ),
      });
    }
  }
  if (candidates.length === 0) return [];
  const removalEpoch = await readTenantDeletionEpoch(
    input.database,
    input.tenantId,
  );
  await insertDeliveryRows(
    input.database,
    candidates,
    removalEpoch,
    now.toISOString(),
  );
  return [...new Set(candidates.map((candidate) => candidate.deliveryId))];
};

export const deliverIncomingWebhookBatch = async (input: {
  database: D1Database;
  tenantId: string;
  projection: WebhookProjection;
  deliveryIds: readonly string[];
  services?: WebhookDeliveryServices;
}): Promise<void> => {
  const services = input.services ?? {};
  let activeLeaseError: unknown;
  for (const deliveryId of new Set(input.deliveryIds)) {
    try {
      await deliverOne(
        input.database,
        input.projection,
        input.tenantId,
        deliveryId,
        services,
      );
    } catch (error) {
      // A concurrent worker's live lease must keep the queue pointer alive,
      // but it must not prevent independent destinations from being attempted.
      activeLeaseError ??= error;
    }
  }
  if (activeLeaseError !== undefined) throw activeLeaseError;
};

const dueDeliveryIds = async (
  database: D1Database,
  now: string,
): Promise<Array<{ tenantId: string; deliveryId: string }>> => {
  const rows = await database
    .prepare(
      `SELECT tenant_id, id
       FROM webhook_deliveries
       WHERE (
         status = 'pending'
         AND (
           next_attempt_at IS NULL OR next_attempt_at <= ?
           OR retry_deadline <= ?
         )
       ) OR (
         status = 'leased' AND lease_expires_at IS NOT NULL
         AND lease_expires_at <= ?
       )
       ORDER BY COALESCE(next_attempt_at, lease_expires_at, first_pending_at), id
       LIMIT ?`,
    )
    .bind(now, now, now, MAX_RETRY_BATCH)
    .all<{ tenant_id: string; id: string }>();
  return rows.results.map((row) => ({
    tenantId: row.tenant_id,
    deliveryId: row.id,
  }));
};

/**
 * The cron sweep is the durable retry wakeup. It re-reads due rows from D1 on
 * every invocation so a lost queue message, process restart, or duplicate
 * wakeup cannot change the delivery's age or create a second delivery ID.
 */
export const runWebhookRetryTick = async (input: {
  database: D1Database;
  projectionForTenant: (tenantId: string) => WebhookProjection;
  services?: WebhookRetryTickServices;
}): Promise<WebhookRetryTickResult> => {
  const services = input.services ?? {};
  const now = nowFor(services);
  await reconcileWebhookRemovalDeliveries({
    database: input.database,
    now: () => now,
  });
  const due = await dueDeliveryIds(input.database, now.toISOString());
  const byTenant = new Map<string, string[]>();
  for (const row of due) {
    const ids = byTenant.get(row.tenantId) ?? [];
    ids.push(row.deliveryId);
    byTenant.set(row.tenantId, ids);
  }
  let attempted = 0;
  for (const [tenantId, deliveryIds] of byTenant) {
    try {
      await deliverIncomingWebhookBatch({
        database: input.database,
        tenantId,
        projection: input.projectionForTenant(tenantId),
        deliveryIds,
        services,
      });
      attempted += deliveryIds.length;
    } catch {
      // A live lease belongs to another invocation. The ledger and the next
      // cron sweep remain authoritative; other tenants are independent.
      attempted += deliveryIds.length;
    }
  }
  return { scanned: due.length, attempted };
};
