import {
  WebhookAccountRuleSchema,
  WebhookChatRuleSchema,
  WebhookEventFilterSchema,
  WebhookOwnershipModeSchema,
  WebhookSubscriptionEvaluationSchema,
  WebhookSubscriptionPageSchema,
  WebhookSubscriptionSchema,
  type WebhookAccountRule,
  type WebhookChatRule,
  type WebhookDestination,
  type WebhookEventFilter,
  type WebhookOwnershipMode,
  type WebhookSubscription,
  type WebhookSubscriptionCreate,
  type WebhookSubscriptionEvaluation,
  type WebhookSubscriptionUpdate,
} from "@communicator/contracts";

export type WebhookRepositoryErrorCode =
  | "webhook_not_found"
  | "webhook_invalid"
  | "webhook_forbidden"
  | "webhook_conflict"
  | "webhook_unavailable";

const SAFE_MESSAGES: Record<WebhookRepositoryErrorCode, string> = {
  webhook_not_found: "Webhook subscription not found",
  webhook_invalid: "Invalid webhook subscription data",
  webhook_forbidden: "Webhook management permission required",
  webhook_conflict: "Webhook subscription mutation conflict",
  webhook_unavailable: "Webhook subscription directory unavailable",
};

const repositoryCauses = new WeakMap<WebhookRepositoryError, unknown>();

export class WebhookRepositoryError extends Error {
  readonly code: WebhookRepositoryErrorCode;

  constructor(code: WebhookRepositoryErrorCode, cause?: unknown) {
    super(SAFE_MESSAGES[code]);
    this.code = code;
    Object.defineProperty(this, "name", {
      configurable: true,
      enumerable: false,
      value: "WebhookRepositoryError",
      writable: true,
    });
    if (cause !== undefined) repositoryCauses.set(this, cause);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const getWebhookRepositoryCause = (
  error: WebhookRepositoryError,
): unknown => repositoryCauses.get(error);

export type WebhookActor = {
  tenantId: string;
  principalId: string;
  principalType: "human" | "service" | "agent" | "operator";
  membershipId: string;
  role: "owner" | "admin" | "member";
  identityIds: readonly string[];
  delegated: boolean;
};

type SubscriptionRow = {
  id: string;
  tenant_id: string;
  owner_installation_id: string | null;
  owner_principal_id: string;
  creator_principal_id: string;
  creator_membership_id: string;
  creator_identity_id: string | null;
  logical_agent_id: string | null;
  ownership_mode: string;
  destination_url: string;
  destination_credential_ref: string | null;
  destination_version: number;
  event_filter_json: string;
  global_enabled: number;
  status: string;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
};

type RuleRow = {
  account_id: string;
  chat_id?: string;
  enabled: number;
};

type InstallationRow = {
  id: string;
  principal_id: string;
  identity_id: string;
  tenant_id: string;
  status: string;
};

type ManagementGrantRow = {
  account_id: string;
  chat_scope: "all_chats" | "selected_chats";
  chat_id: string | null;
};

const webhookError = (
  code: WebhookRepositoryErrorCode,
  cause?: unknown,
): WebhookRepositoryError => new WebhookRepositoryError(code, cause);

const isAdministrator = (actor: WebhookActor): boolean =>
  (actor.principalType === "human" || actor.principalType === "operator") &&
  (actor.role === "owner" || actor.role === "admin");

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const destinationForStorage = (destination: WebhookDestination) => ({
  // T13 keeps this as an opaque, deployment-owned label. No delivery path in
  // this module resolves it or treats it as a credential-bearing authority.
  url: destination.url,
  credentialRef: destination.credential_ref ?? null,
});

const eventFilterForStorage = (filter: WebhookEventFilter): string =>
  JSON.stringify(WebhookEventFilterSchema.parse(filter));

const parseEventFilter = (value: string): WebhookEventFilter => {
  try {
    return WebhookEventFilterSchema.parse(JSON.parse(value));
  } catch (error) {
    throw webhookError("webhook_unavailable", error);
  }
};

const canonicalAccountRules = (
  rules: readonly WebhookAccountRule[],
): WebhookAccountRule[] =>
  [...rules]
    .map((rule) => WebhookAccountRuleSchema.parse(rule))
    .sort((left, right) => left.account_id.localeCompare(right.account_id));

const canonicalChatRules = (
  rules: readonly WebhookChatRule[],
): WebhookChatRule[] =>
  [...rules]
    .map((rule) => WebhookChatRuleSchema.parse(rule))
    .sort(
      (left, right) =>
        left.account_id.localeCompare(right.account_id) ||
        left.chat_id.localeCompare(right.chat_id),
    );

const mapSubscription = (
  row: SubscriptionRow,
  accountRules: readonly RuleRow[],
  chatRules: readonly RuleRow[],
): WebhookSubscription =>
  WebhookSubscriptionSchema.parse({
    id: row.id,
    tenant_id: row.tenant_id,
    owner_installation_id: row.owner_installation_id,
    owner_principal_id: row.owner_principal_id,
    creator_principal_id: row.creator_principal_id,
    creator_membership_id: row.creator_membership_id,
    creator_identity_id: row.creator_identity_id,
    logical_agent_id: row.logical_agent_id,
    ownership_mode: WebhookOwnershipModeSchema.parse(row.ownership_mode),
    destination: {
      url: row.destination_url,
      ...(row.destination_credential_ref === null
        ? { credential_ref: null }
        : { credential_ref: row.destination_credential_ref }),
    },
    destination_version: row.destination_version,
    event_filter: parseEventFilter(row.event_filter_json),
    global_enabled: row.global_enabled === 1,
    account_rules: canonicalAccountRules(
      accountRules.map((rule) => ({
        account_id: rule.account_id,
        enabled: rule.enabled === 1,
      })),
    ),
    chat_rules: canonicalChatRules(
      chatRules.map((rule) => ({
        account_id: rule.account_id,
        chat_id: rule.chat_id ?? "",
        enabled: rule.enabled === 1,
      })),
    ),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    revoked_at: row.revoked_at,
  });

const subscriptionQuery = `
  SELECT id, tenant_id, owner_installation_id, owner_principal_id,
         creator_principal_id, creator_membership_id, creator_identity_id,
         logical_agent_id, ownership_mode, destination_url,
         destination_credential_ref, destination_version, event_filter_json,
         global_enabled, status, created_at, updated_at, revoked_at
  FROM webhook_subscriptions
`;

async function readSubscription(
  db: D1DatabaseSession,
  tenantId: string,
  subscriptionId: string,
): Promise<WebhookSubscription> {
  const row = await db
    .prepare(`${subscriptionQuery} WHERE tenant_id = ? AND id = ? LIMIT 1`)
    .bind(tenantId, subscriptionId)
    .first<SubscriptionRow>();
  if (!row) throw webhookError("webhook_not_found");
  const [accountRules, chatRules] = await Promise.all([
    db
      .prepare(
        "SELECT account_id, enabled FROM webhook_subscription_account_rules WHERE tenant_id = ? AND subscription_id = ? ORDER BY account_id ASC",
      )
      .bind(tenantId, subscriptionId)
      .all<RuleRow>(),
    db
      .prepare(
        "SELECT account_id, chat_id, enabled FROM webhook_subscription_chat_rules WHERE tenant_id = ? AND subscription_id = ? ORDER BY account_id ASC, chat_id ASC",
      )
      .bind(tenantId, subscriptionId)
      .all<RuleRow>(),
  ]);
  return mapSubscription(row, accountRules.results, chatRules.results);
}

export async function getWebhookSubscription(
  db: D1DatabaseSession,
  tenantId: string,
  subscriptionId: string,
): Promise<WebhookSubscription> {
  try {
    return await readSubscription(db, tenantId, subscriptionId);
  } catch (error) {
    if (error instanceof WebhookRepositoryError) throw error;
    throw webhookError("webhook_unavailable", error);
  }
}

async function findInstallationForPrincipal(
  db: D1DatabaseSession,
  tenantId: string,
  principalId: string,
): Promise<InstallationRow | null> {
  return db
    .prepare(
      `SELECT id, principal_id, identity_id, tenant_id, status
       FROM oauth_client_installations
       WHERE tenant_id = ? AND principal_id = ? AND status = 'active'
         AND revoked_at IS NULL
       ORDER BY id ASC LIMIT 1`,
    )
    .bind(tenantId, principalId)
    .first<InstallationRow>();
}

async function validateIdentity(
  db: D1DatabaseSession,
  actor: WebhookActor,
  identityId: string | null | undefined,
): Promise<string | null> {
  if (identityId === null) return null;
  if (identityId !== undefined) {
    if (actor.identityIds.includes(identityId)) return identityId;
    if (!isAdministrator(actor)) throw webhookError("webhook_forbidden");
    const row = await db
      .prepare(
        "SELECT id FROM identities WHERE tenant_id = ? AND id = ? AND status = 'active' LIMIT 1",
      )
      .bind(actor.tenantId, identityId)
      .first<{ id: string }>();
    if (!row) throw webhookError("webhook_not_found");
    return row.id;
  }
  if (actor.delegated) {
    const installation = await findInstallationForPrincipal(
      db,
      actor.tenantId,
      actor.principalId,
    );
    if (
      !installation ||
      !actor.identityIds.includes(installation.identity_id)
    ) {
      throw webhookError("webhook_forbidden");
    }
    return installation.identity_id;
  }
  if (actor.identityIds.length === 1) return actor.identityIds[0] ?? null;
  if (actor.identityIds.length > 1) throw webhookError("webhook_invalid");
  return null;
}

async function findInstallation(
  db: D1DatabaseSession,
  tenantId: string,
  installationId: string,
): Promise<InstallationRow | null> {
  return db
    .prepare(
      `SELECT id, principal_id, identity_id, tenant_id, status
       FROM oauth_client_installations
       WHERE tenant_id = ? AND id = ? AND status = 'active'
         AND revoked_at IS NULL LIMIT 1`,
    )
    .bind(tenantId, installationId)
    .first<InstallationRow>();
}

async function validateOwnerInstallation(
  db: D1DatabaseSession,
  actor: WebhookActor,
  ownerInstallationId: string | undefined,
): Promise<InstallationRow | null> {
  if (ownerInstallationId === undefined) return null;
  const installation = await findInstallation(
    db,
    actor.tenantId,
    ownerInstallationId,
  );
  if (!installation) throw webhookError("webhook_not_found");
  if (actor.delegated && installation.principal_id !== actor.principalId) {
    throw webhookError("webhook_forbidden");
  }
  if (!actor.delegated && !isAdministrator(actor)) {
    throw webhookError("webhook_forbidden");
  }
  return installation;
}

async function validateAccounts(
  db: D1DatabaseSession,
  tenantId: string,
  accountIds: readonly string[],
): Promise<void> {
  const uniqueIds = unique(accountIds);
  if (uniqueIds.length === 0) return;
  const placeholders = uniqueIds.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT ca.account_id
       FROM connection_accounts AS ca
       JOIN connections AS c ON c.id = ca.connection_id AND c.tenant_id = ?
       WHERE ca.account_id IN (${placeholders}) AND ca.status = 'active'`,
    )
    .bind(tenantId, ...uniqueIds)
    .all<{ account_id: string }>();
  if (
    new Set(rows.results.map((row) => row.account_id)).size !== uniqueIds.length
  ) {
    throw webhookError("webhook_invalid");
  }
}

async function managementGrants(
  db: D1DatabaseSession,
  actor: WebhookActor,
  identityId: string | null,
): Promise<ManagementGrantRow[]> {
  if (identityId === null) return [];
  return (
    await db
      .prepare(
        `SELECT g.account_id, g.chat_scope, agc.chat_id
         FROM account_grants AS g
         LEFT JOIN account_grant_chats AS agc
           ON agc.tenant_id = g.tenant_id AND agc.grant_id = g.id
         WHERE g.tenant_id = ? AND g.membership_id = ? AND g.identity_id = ?
           AND g.operation_scope = 'webhook.manage' AND g.status = 'active'`,
      )
      .bind(actor.tenantId, actor.membershipId, identityId)
      .all<ManagementGrantRow>()
  ).results;
}

const grantAllows = (
  grants: readonly ManagementGrantRow[],
  accountId: string,
  chatId?: string,
): boolean =>
  grants.some(
    (grant) =>
      grant.account_id === accountId &&
      (grant.chat_scope === "all_chats" ||
        (chatId !== undefined && grant.chat_id === chatId)),
  );

async function requireManagementAuthority(
  db: D1DatabaseSession,
  actor: WebhookActor,
  identityId: string | null,
  accountRules: readonly WebhookAccountRule[],
  chatRules: readonly WebhookChatRule[],
): Promise<void> {
  if (isAdministrator(actor)) return;
  const grants = await managementGrants(db, actor, identityId);
  if (grants.length === 0) throw webhookError("webhook_forbidden");
  const targets = unique([
    ...accountRules.map((rule) => rule.account_id),
    ...chatRules.map((rule) => rule.account_id),
  ]);
  if (targets.length === 0 && grants.length === 0) {
    throw webhookError("webhook_forbidden");
  }
  for (const rule of accountRules) {
    if (!grantAllows(grants, rule.account_id)) {
      throw webhookError("webhook_forbidden");
    }
  }
  for (const rule of chatRules) {
    if (!grantAllows(grants, rule.account_id, rule.chat_id)) {
      throw webhookError("webhook_forbidden");
    }
  }
}

async function requireSubscriptionAuthority(
  db: D1DatabaseSession,
  actor: WebhookActor,
  subscription: WebhookSubscription,
): Promise<void> {
  if (isAdministrator(actor)) return;
  if (subscription.owner_principal_id !== actor.principalId) {
    throw webhookError("webhook_forbidden");
  }
  let authorityIdentityId =
    subscription.logical_agent_id ?? subscription.creator_identity_id;
  if (subscription.owner_installation_id !== null) {
    const installation = await findInstallation(
      db,
      actor.tenantId,
      subscription.owner_installation_id,
    );
    if (!installation || installation.principal_id !== actor.principalId) {
      throw webhookError("webhook_forbidden");
    }
    if (subscription.logical_agent_id === null) {
      authorityIdentityId = installation.identity_id;
    }
  }
  await requireManagementAuthority(
    db,
    actor,
    authorityIdentityId,
    subscription.account_rules,
    subscription.chat_rules,
  );
}

const subscriptionAccountIds = (
  accountRules: readonly WebhookAccountRule[],
  chatRules: readonly WebhookChatRule[],
): string[] =>
  unique([
    ...accountRules.map((rule) => rule.account_id),
    ...chatRules.map((rule) => rule.account_id),
  ]);

async function hashPayload(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function checkIdempotency(
  db: D1DatabaseSession,
  key: string,
  payload: unknown,
): Promise<{ exists: boolean; hash: string }> {
  const hash = await hashPayload(payload);
  const existing = await db
    .prepare(
      "SELECT request_hash FROM directory_mutations WHERE idempotency_key = ? LIMIT 1",
    )
    .bind(key)
    .first<{ request_hash: string }>();
  if (existing && existing.request_hash !== hash) {
    throw webhookError("webhook_conflict");
  }
  return { exists: existing !== null, hash };
}

const mutationStatement = (
  db: D1Database,
  key: string,
  actor: WebhookActor,
  mutationType: string,
  hash: string,
  occurredAt: string,
) =>
  db
    .prepare(
      `INSERT INTO directory_mutations
       (idempotency_key, tenant_id, actor_principal_id, mutation_type, request_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO UPDATE SET request_hash = excluded.request_hash`,
    )
    .bind(
      key,
      actor.tenantId,
      actor.principalId,
      mutationType,
      hash,
      occurredAt,
    );

const cutoverMutationStatement = (
  db: D1Database,
  key: string,
  actor: WebhookActor,
  hash: string,
  occurredAt: string,
) =>
  db
    .prepare(
      `INSERT INTO directory_mutations
       (idempotency_key, tenant_id, actor_principal_id, mutation_type, request_hash, created_at)
       SELECT ?, ?, ?, 'webhook.subscription.cutover', ?, ?
       WHERE changes() = 1`,
    )
    .bind(key, actor.tenantId, actor.principalId, hash, occurredAt);

const auditStatements = (
  db: D1Database,
  input: {
    key: string;
    actor: WebhookActor;
    action: string;
    subscriptionId: string;
    payload: unknown;
    occurredAt: string;
  },
) => {
  const payloadJson = JSON.stringify(input.payload);
  return [
    db
      .prepare(
        `INSERT OR IGNORE INTO audit_events
         (id, tenant_id, actor_principal_id, action, target_type, target_id, reason, metadata_json, occurred_at)
         VALUES (?, ?, ?, ?, 'webhook_subscription', ?, NULL, ?, ?)`,
      )
      .bind(
        `audit_webhook_${input.key}`,
        input.actor.tenantId,
        input.actor.principalId,
        input.action,
        input.subscriptionId,
        payloadJson,
        input.occurredAt,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO control_event_outbox
         (event_id, tenant_id, event_type, aggregate_type, aggregate_id, payload_json, created_at)
         VALUES (?, ?, ?, 'webhook_subscription', ?, ?, ?)`,
      )
      .bind(
        `control_webhook_${input.key}`,
        input.actor.tenantId,
        input.action,
        input.subscriptionId,
        payloadJson,
        input.occurredAt,
      ),
  ];
};

const cutoverAuditStatements = (
  db: D1Database,
  input: {
    key: string;
    actor: WebhookActor;
    subscriptionId: string;
    destination: WebhookDestination;
    occurredAt: string;
  },
) => [
  db
    .prepare(
      `INSERT OR IGNORE INTO audit_events
       (id, tenant_id, actor_principal_id, action, target_type, target_id, reason, metadata_json, occurred_at)
       SELECT ?, ?, ?, 'webhook.subscription.cutover', 'webhook_subscription', ?, NULL,
              json_object(
                'previous_destination_version', destination_version - 1,
                'destination_version', destination_version,
                'destination_url', ?,
                'destination_credential_ref', ?
              ), ?
       FROM webhook_subscriptions
       WHERE tenant_id = ? AND id = ? AND status = 'active'
         AND EXISTS (
           SELECT 1 FROM directory_mutations WHERE idempotency_key = ?
         )`,
    )
    .bind(
      `audit_webhook_${input.key}`,
      input.actor.tenantId,
      input.actor.principalId,
      input.subscriptionId,
      input.destination.url,
      input.destination.credential_ref ?? null,
      input.occurredAt,
      input.actor.tenantId,
      input.subscriptionId,
      input.key,
    ),
  db
    .prepare(
      `INSERT OR IGNORE INTO control_event_outbox
       (event_id, tenant_id, event_type, aggregate_type, aggregate_id, payload_json, created_at)
       SELECT ?, ?, 'webhook.subscription.cutover', 'webhook_subscription', ?,
              json_object(
                'previous_destination_version', destination_version - 1,
                'destination_version', destination_version,
                'destination_url', ?,
                'destination_credential_ref', ?
              ), ?
       FROM webhook_subscriptions
       WHERE tenant_id = ? AND id = ? AND status = 'active'
         AND EXISTS (
           SELECT 1 FROM directory_mutations WHERE idempotency_key = ?
         )`,
    )
    .bind(
      `control_webhook_${input.key}`,
      input.actor.tenantId,
      input.subscriptionId,
      input.destination.url,
      input.destination.credential_ref ?? null,
      input.occurredAt,
      input.actor.tenantId,
      input.subscriptionId,
      input.key,
    ),
];

const ruleStatements = (
  db: D1Database,
  tenantId: string,
  subscriptionId: string,
  accountRules: readonly WebhookAccountRule[],
  chatRules: readonly WebhookChatRule[],
  occurredAt: string,
) => [
  db
    .prepare(
      "DELETE FROM webhook_subscription_account_rules WHERE tenant_id = ? AND subscription_id = ?",
    )
    .bind(tenantId, subscriptionId),
  db
    .prepare(
      "DELETE FROM webhook_subscription_chat_rules WHERE tenant_id = ? AND subscription_id = ?",
    )
    .bind(tenantId, subscriptionId),
  ...canonicalAccountRules(accountRules).map((rule) =>
    db
      .prepare(
        `INSERT INTO webhook_subscription_account_rules
         (tenant_id, subscription_id, account_id, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        tenantId,
        subscriptionId,
        rule.account_id,
        rule.enabled ? 1 : 0,
        occurredAt,
        occurredAt,
      ),
  ),
  ...canonicalChatRules(chatRules).map((rule) =>
    db
      .prepare(
        `INSERT INTO webhook_subscription_chat_rules
         (tenant_id, subscription_id, account_id, chat_id, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        tenantId,
        subscriptionId,
        rule.account_id,
        rule.chat_id,
        rule.enabled ? 1 : 0,
        occurredAt,
        occurredAt,
      ),
  ),
];

const webhookId = (): string =>
  `webhook_${crypto.randomUUID().replaceAll("-", "")}`;

async function readRowsForList(
  db: D1DatabaseSession,
  tenantId: string,
  rows: readonly SubscriptionRow[],
): Promise<WebhookSubscription[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => "?").join(",");
  const [accountRules, chatRules] = await Promise.all([
    db
      .prepare(
        `SELECT subscription_id, account_id, enabled
         FROM webhook_subscription_account_rules
         WHERE tenant_id = ? AND subscription_id IN (${placeholders})
         ORDER BY subscription_id ASC, account_id ASC`,
      )
      .bind(tenantId, ...ids)
      .all<RuleRow & { subscription_id: string }>(),
    db
      .prepare(
        `SELECT subscription_id, account_id, chat_id, enabled
         FROM webhook_subscription_chat_rules
         WHERE tenant_id = ? AND subscription_id IN (${placeholders})
         ORDER BY subscription_id ASC, account_id ASC, chat_id ASC`,
      )
      .bind(tenantId, ...ids)
      .all<RuleRow & { subscription_id: string }>(),
  ]);
  const accountBySubscription = new Map<string, RuleRow[]>();
  const chatBySubscription = new Map<string, RuleRow[]>();
  for (const row of accountRules.results) {
    const values = accountBySubscription.get(row.subscription_id) ?? [];
    values.push(row);
    accountBySubscription.set(row.subscription_id, values);
  }
  for (const row of chatRules.results) {
    const values = chatBySubscription.get(row.subscription_id) ?? [];
    values.push(row);
    chatBySubscription.set(row.subscription_id, values);
  }
  return rows.map((row) =>
    mapSubscription(
      row,
      accountBySubscription.get(row.id) ?? [],
      chatBySubscription.get(row.id) ?? [],
    ),
  );
}

export async function listWebhookSubscriptions(
  db: D1DatabaseSession,
  actor: WebhookActor,
  cursor?: string,
  limit = 50,
): Promise<{ items: WebhookSubscription[]; next_cursor: string | null }> {
  try {
    if (!isAdministrator(actor)) {
      let hasManagementGrant = false;
      for (const identityId of actor.identityIds) {
        if ((await managementGrants(db, actor, identityId)).length > 0) {
          hasManagementGrant = true;
          break;
        }
      }
      if (!hasManagementGrant) throw webhookError("webhook_forbidden");
    }
    const pageSize = Math.min(Math.max(limit, 1), 100);
    const conditions = ["tenant_id = ?"];
    const bindings: (string | number)[] = [actor.tenantId];
    if (!isAdministrator(actor)) {
      conditions.push("owner_principal_id = ?");
      bindings.push(actor.principalId);
    }
    if (cursor !== undefined) {
      conditions.push("id > ?");
      bindings.push(cursor);
    }
    bindings.push(pageSize + 1);
    const rows = await db
      .prepare(
        `${subscriptionQuery} WHERE ${conditions.join(" AND ")} ORDER BY id ASC LIMIT ?`,
      )
      .bind(...bindings)
      .all<SubscriptionRow>();
    const visible = rows.results.slice(0, pageSize);
    const subscriptions = await readRowsForList(db, actor.tenantId, visible);
    return {
      items: subscriptions,
      next_cursor:
        rows.results.length > pageSize ? (visible.at(-1)?.id ?? null) : null,
    };
  } catch (error) {
    if (error instanceof WebhookRepositoryError) throw error;
    throw webhookError("webhook_unavailable", error);
  }
}

async function validateRulesAndAuthority(
  db: D1DatabaseSession,
  actor: WebhookActor,
  identityId: string | null,
  accountRules: readonly WebhookAccountRule[],
  chatRules: readonly WebhookChatRule[],
): Promise<void> {
  const accountIds = subscriptionAccountIds(accountRules, chatRules);
  await validateAccounts(db, actor.tenantId, accountIds);
  await requireManagementAuthority(
    db,
    actor,
    identityId,
    accountRules,
    chatRules,
  );
}

export async function createWebhookSubscription(
  db: D1Database,
  actor: WebhookActor,
  input: WebhookSubscriptionCreate,
  occurredAt: string,
): Promise<WebhookSubscription> {
  try {
    const database = db.withSession("first-primary");
    const managementIdentityId =
      isAdministrator(actor) &&
      (input.logical_agent_id === undefined || input.logical_agent_id === null)
        ? null
        : await validateIdentity(
            database,
            actor,
            input.logical_agent_id === null
              ? undefined
              : input.logical_agent_id,
          );
    const ownerInstallation = await validateOwnerInstallation(
      database,
      actor,
      input.owner_installation_id,
    );
    const delegatedInstallation = actor.delegated
      ? await findInstallationForPrincipal(
          database,
          actor.tenantId,
          actor.principalId,
        )
      : null;
    if (actor.delegated && !delegatedInstallation) {
      throw webhookError("webhook_forbidden");
    }
    if (
      actor.delegated &&
      ownerInstallation !== null &&
      ownerInstallation.id !== delegatedInstallation?.id
    ) {
      throw webhookError("webhook_forbidden");
    }
    const actualOwnerInstallation = delegatedInstallation ?? ownerInstallation;
    const ownerPrincipalId =
      actualOwnerInstallation?.principal_id ?? actor.principalId;
    const logicalAgentId = input.logical_agent_id ?? null;
    const ownershipMode: WebhookOwnershipMode = isAdministrator(actor)
      ? "administrator"
      : actualOwnerInstallation !== null
        ? logicalAgentId === null
          ? "shared_installation"
          : "installation"
        : "human_owner";
    const accountRules = canonicalAccountRules(input.account_rules);
    const chatRules = canonicalChatRules(input.chat_rules);
    await validateRulesAndAuthority(
      database,
      actor,
      managementIdentityId,
      accountRules,
      chatRules,
    );
    const payload = {
      operation: "create",
      owner_installation_id: actualOwnerInstallation?.id ?? null,
      logical_agent_id: logicalAgentId,
      destination: destinationForStorage(input.destination),
      event_filter: input.event_filter,
      global_enabled: input.global_enabled,
      account_rules: accountRules,
      chat_rules: chatRules,
    };
    const idempotency = await checkIdempotency(
      database,
      input.idempotency_key,
      payload,
    );
    const existing = await database
      .prepare(
        "SELECT id FROM webhook_subscriptions WHERE tenant_id = ? AND creation_idempotency_key = ? LIMIT 1",
      )
      .bind(actor.tenantId, input.idempotency_key)
      .first<{ id: string }>();
    if (existing) {
      if (!idempotency.exists) throw webhookError("webhook_conflict");
      return await readSubscription(database, actor.tenantId, existing.id);
    }
    const subscriptionId = webhookId();
    const eventFilter = eventFilterForStorage(input.event_filter);
    const auditPayload = {
      owner_installation_id: actualOwnerInstallation?.id ?? null,
      owner_principal_id: ownerPrincipalId,
      creator_principal_id: actor.principalId,
      creator_identity_id: managementIdentityId,
      logical_agent_id: logicalAgentId,
      ownership_mode: ownershipMode,
      destination_url: input.destination.url,
      destination_credential_ref: input.destination.credential_ref ?? null,
      destination_version: 1,
      event_filter: input.event_filter,
      global_enabled: input.global_enabled,
      account_rules: accountRules,
      chat_rules: chatRules,
    };
    await db.batch([
      mutationStatement(
        db,
        input.idempotency_key,
        actor,
        "webhook.subscription.created",
        idempotency.hash,
        occurredAt,
      ),
      db
        .prepare(
          `INSERT INTO webhook_subscriptions
           (id, tenant_id, creation_idempotency_key, owner_installation_id,
            owner_principal_id, creator_principal_id, creator_membership_id,
            creator_identity_id, logical_agent_id, ownership_mode,
            destination_url, destination_credential_ref, destination_version,
            event_filter_json, global_enabled, status, created_at, updated_at,
            revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'active', ?, ?, NULL)`,
        )
        .bind(
          subscriptionId,
          actor.tenantId,
          input.idempotency_key,
          actualOwnerInstallation?.id ?? null,
          ownerPrincipalId,
          actor.principalId,
          actor.membershipId,
          managementIdentityId,
          logicalAgentId,
          ownershipMode,
          input.destination.url,
          input.destination.credential_ref ?? null,
          eventFilter,
          input.global_enabled ? 1 : 0,
          occurredAt,
          occurredAt,
        ),
      ...ruleStatements(
        db,
        actor.tenantId,
        subscriptionId,
        accountRules,
        chatRules,
        occurredAt,
      ),
      ...auditStatements(db, {
        key: input.idempotency_key,
        actor,
        action: "webhook.subscription.created",
        subscriptionId,
        payload: auditPayload,
        occurredAt,
      }),
    ]);
    return await readSubscription(database, actor.tenantId, subscriptionId);
  } catch (error) {
    if (error instanceof WebhookRepositoryError) throw error;
    throw webhookError("webhook_conflict", error);
  }
}

export async function updateWebhookSubscription(
  db: D1Database,
  actor: WebhookActor,
  subscriptionId: string,
  input: WebhookSubscriptionUpdate,
  occurredAt: string,
): Promise<WebhookSubscription> {
  try {
    const database = db.withSession("first-primary");
    const existing = await readSubscription(
      database,
      actor.tenantId,
      subscriptionId,
    );
    await requireSubscriptionAuthority(database, actor, existing);
    if (existing.status !== "active") throw webhookError("webhook_conflict");
    const idempotencyPayload = {
      operation: "update",
      subscriptionId,
      ...input,
    };
    const idempotency = await checkIdempotency(
      database,
      input.idempotency_key,
      idempotencyPayload,
    );
    if (idempotency.exists) {
      return existing;
    }
    const targetOwnerInstallationId =
      input.owner_installation_id === undefined
        ? existing.owner_installation_id
        : input.owner_installation_id;
    const targetOwnerInstallation =
      targetOwnerInstallationId === null
        ? null
        : input.owner_installation_id === undefined
          ? await findInstallation(
              database,
              actor.tenantId,
              targetOwnerInstallationId,
            )
          : await validateOwnerInstallation(
              database,
              actor,
              targetOwnerInstallationId,
            );
    if (input.owner_installation_id !== undefined && !isAdministrator(actor)) {
      throw webhookError("webhook_forbidden");
    }
    const targetLogicalAgentId =
      input.logical_agent_id === undefined
        ? existing.logical_agent_id
        : await validateIdentity(database, actor, input.logical_agent_id);
    if (
      input.logical_agent_id !== undefined &&
      input.logical_agent_id !== existing.logical_agent_id &&
      !isAdministrator(actor)
    ) {
      throw webhookError("webhook_forbidden");
    }
    const accountRules = canonicalAccountRules(
      input.account_rules ?? existing.account_rules,
    );
    const chatRules = canonicalChatRules(
      input.chat_rules ?? existing.chat_rules,
    );
    const managementIdentityId =
      targetLogicalAgentId ?? existing.creator_identity_id;
    await validateRulesAndAuthority(
      database,
      actor,
      managementIdentityId,
      accountRules,
      chatRules,
    );
    let ownerPrincipalId = existing.owner_principal_id;
    if (input.owner_installation_id !== undefined) {
      ownerPrincipalId =
        targetOwnerInstallation?.principal_id ?? actor.principalId;
    }
    const ownershipMode: WebhookOwnershipMode = isAdministrator(actor)
      ? targetOwnerInstallationId !== null
        ? targetLogicalAgentId === null
          ? "shared_installation"
          : "installation"
        : "administrator"
      : targetOwnerInstallationId !== null
        ? targetLogicalAgentId === null
          ? "shared_installation"
          : "installation"
        : "human_owner";
    const eventFilter = input.event_filter ?? existing.event_filter;
    const destination = existing.destination;
    const statements = [
      mutationStatement(
        db,
        input.idempotency_key,
        actor,
        "webhook.subscription.updated",
        idempotency.hash,
        occurredAt,
      ),
      db
        .prepare(
          `UPDATE webhook_subscriptions
           SET owner_installation_id = ?, owner_principal_id = ?,
               logical_agent_id = ?, ownership_mode = ?,
               event_filter_json = ?, global_enabled = ?, updated_at = ?
           WHERE tenant_id = ? AND id = ? AND status = 'active'`,
        )
        .bind(
          targetOwnerInstallationId,
          ownerPrincipalId,
          targetLogicalAgentId,
          ownershipMode,
          eventFilterForStorage(eventFilter),
          (input.global_enabled ?? existing.global_enabled) ? 1 : 0,
          occurredAt,
          actor.tenantId,
          subscriptionId,
        ),
      ...ruleStatements(
        db,
        actor.tenantId,
        subscriptionId,
        accountRules,
        chatRules,
        occurredAt,
      ),
      ...auditStatements(db, {
        key: input.idempotency_key,
        actor,
        action: "webhook.subscription.updated",
        subscriptionId,
        payload: {
          owner_installation_id: targetOwnerInstallationId,
          owner_principal_id: ownerPrincipalId,
          logical_agent_id: targetLogicalAgentId,
          destination_url: destination.url,
          destination_credential_ref: destination.credential_ref ?? null,
          destination_version: existing.destination_version,
          event_filter: eventFilter,
          global_enabled: input.global_enabled ?? existing.global_enabled,
          account_rules: accountRules,
          chat_rules: chatRules,
        },
        occurredAt,
      }),
    ];
    await db.batch(statements);
    return await readSubscription(database, actor.tenantId, subscriptionId);
  } catch (error) {
    if (error instanceof WebhookRepositoryError) throw error;
    throw webhookError("webhook_conflict", error);
  }
}

export async function cutoverWebhookSubscription(
  db: D1Database,
  actor: WebhookActor,
  subscriptionId: string,
  destination: WebhookDestination,
  idempotencyKey: string,
  occurredAt: string,
): Promise<WebhookSubscription> {
  const database = db.withSession("first-primary");
  const payload = {
    operation: "cutover",
    subscriptionId,
    destination: destinationForStorage(destination),
  };
  try {
    const existing = await readSubscription(
      database,
      actor.tenantId,
      subscriptionId,
    );
    await requireSubscriptionAuthority(database, actor, existing);
    if (existing.status !== "active") throw webhookError("webhook_conflict");
    const idempotency = await checkIdempotency(
      database,
      idempotencyKey,
      payload,
    );
    if (idempotency.exists) return existing;
    await db.batch([
      db
        .prepare(
          `UPDATE webhook_subscriptions
           SET destination_url = ?, destination_credential_ref = ?,
               destination_version = destination_version + 1, updated_at = ?
           WHERE tenant_id = ? AND id = ? AND status = 'active'`,
        )
        .bind(
          destination.url,
          destination.credential_ref ?? null,
          occurredAt,
          actor.tenantId,
          subscriptionId,
        ),
      cutoverMutationStatement(
        db,
        idempotencyKey,
        actor,
        idempotency.hash,
        occurredAt,
      ),
      db
        .prepare(
          `UPDATE webhook_deliveries
           SET status = 'cancelled', cancelled_at = ?,
               cancellation_reason = 'destination_cutover'
           WHERE tenant_id = ? AND subscription_id = ?
             AND destination_version < (
               SELECT destination_version
               FROM webhook_subscriptions
               WHERE tenant_id = ? AND id = ?
             )
             AND EXISTS (
               SELECT 1 FROM directory_mutations WHERE idempotency_key = ?
             )
             AND status IN ('pending', 'leased')`,
        )
        .bind(
          occurredAt,
          actor.tenantId,
          subscriptionId,
          actor.tenantId,
          subscriptionId,
          idempotencyKey,
        ),
      ...cutoverAuditStatements(db, {
        key: idempotencyKey,
        actor,
        subscriptionId,
        destination,
        occurredAt,
      }),
    ]);
    const committed = await checkIdempotency(database, idempotencyKey, payload);
    if (!committed.exists) throw webhookError("webhook_conflict");
    return await readSubscription(database, actor.tenantId, subscriptionId);
  } catch (error) {
    if (error instanceof WebhookRepositoryError) throw error;
    const retryIdempotency = await checkIdempotency(
      database,
      idempotencyKey,
      payload,
    );
    if (retryIdempotency.exists) {
      return await readSubscription(database, actor.tenantId, subscriptionId);
    }
    throw webhookError("webhook_conflict", error);
  }
}

export async function revokeWebhookSubscription(
  db: D1Database,
  actor: WebhookActor,
  subscriptionId: string,
  idempotencyKey: string,
  occurredAt: string,
): Promise<WebhookSubscription> {
  try {
    const database = db.withSession("first-primary");
    const existing = await readSubscription(
      database,
      actor.tenantId,
      subscriptionId,
    );
    await requireSubscriptionAuthority(database, actor, existing);
    const payload = { operation: "revoke", subscriptionId };
    const idempotency = await checkIdempotency(
      database,
      idempotencyKey,
      payload,
    );
    if (idempotency.exists) return existing;
    if (existing.status === "revoked") return existing;
    await db.batch([
      mutationStatement(
        db,
        idempotencyKey,
        actor,
        "webhook.subscription.revoked",
        idempotency.hash,
        occurredAt,
      ),
      db
        .prepare(
          `UPDATE webhook_subscriptions
           SET status = 'revoked', revoked_at = ?, updated_at = ?
           WHERE tenant_id = ? AND id = ? AND status = 'active'`,
        )
        .bind(occurredAt, occurredAt, actor.tenantId, subscriptionId),
      db
        .prepare(
          `UPDATE webhook_deliveries
           SET status = 'cancelled', cancelled_at = ?,
               cancellation_reason = 'subscription_revoked'
           WHERE tenant_id = ? AND subscription_id = ?
             AND status IN ('pending', 'leased')`,
        )
        .bind(occurredAt, actor.tenantId, subscriptionId),
      ...auditStatements(db, {
        key: idempotencyKey,
        actor,
        action: "webhook.subscription.revoked",
        subscriptionId,
        payload,
        occurredAt,
      }),
    ]);
    return await readSubscription(database, actor.tenantId, subscriptionId);
  } catch (error) {
    if (error instanceof WebhookRepositoryError) throw error;
    throw webhookError("webhook_conflict", error);
  }
}

export async function evaluateWebhookSubscription(
  db: D1DatabaseSession,
  tenantId: string,
  subscriptionId: string,
  accountId: string,
  chatId: string | null,
): Promise<WebhookSubscriptionEvaluation> {
  await validateAccounts(db, tenantId, [accountId]);
  const subscription = await readSubscription(db, tenantId, subscriptionId);
  if (subscription.status !== "active") throw webhookError("webhook_not_found");
  const chatRule =
    chatId === null
      ? undefined
      : subscription.chat_rules.find(
          (rule) => rule.account_id === accountId && rule.chat_id === chatId,
        );
  const accountRule = subscription.account_rules.find(
    (rule) => rule.account_id === accountId,
  );
  const source =
    chatRule !== undefined ? "chat" : accountRule ? "account" : "global";
  const enabled =
    chatRule?.enabled ?? accountRule?.enabled ?? subscription.global_enabled;
  return WebhookSubscriptionEvaluationSchema.parse({
    subscription_id: subscriptionId,
    account_id: accountId,
    chat_id: chatId,
    enabled,
    source,
  });
}

export async function authorizeWebhookInspection(
  db: D1DatabaseSession,
  actor: WebhookActor,
  subscriptionId: string,
): Promise<WebhookSubscription> {
  const subscription = await readSubscription(
    db,
    actor.tenantId,
    subscriptionId,
  );
  await requireSubscriptionAuthority(db, actor, subscription);
  return subscription;
}

export async function listWebhookSubscriptionPage(
  db: D1DatabaseSession,
  actor: WebhookActor,
  cursor?: string,
  limit = 50,
): Promise<ReturnType<typeof WebhookSubscriptionPageSchema.parse>> {
  const page = await listWebhookSubscriptions(db, actor, cursor, limit);
  return WebhookSubscriptionPageSchema.parse(page);
}
