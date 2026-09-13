import {
  AccountGrantSchema,
  AccountGrantOperationScopeSchema,
  AccountGrantPageSchema,
  AccountGrantTargetPageSchema,
  ConnectedAccountPageSchema,
  ConnectedAccountSchema,
  MAX_GRANT_CHAT_IDS,
  MAX_GRANT_PAGE_SIZE,
  PermissionRequestPageSchema,
  PermissionRequestSchema,
  type AccountGrant,
  type AccountGrantOperationScope,
  type AccountGrantPage,
  type AccountGrantTargetPage,
  type AccountGrantChatScope,
  type AccountGrantStatus,
  type ConnectedAccount,
  type ConnectedAccountPage,
  type PermissionRequest,
  type PermissionRequestPage,
  type PermissionRequestStatus,
} from "@communicator/contracts";

type GrantRepositoryErrorCode =
  | "grant_not_found"
  | "grant_invalid"
  | "grant_conflict"
  | "grant_unavailable";

const SAFE_MESSAGES: Record<GrantRepositoryErrorCode, string> = {
  grant_not_found: "Grant not found",
  grant_invalid: "Invalid grant data",
  grant_conflict: "Grant mutation conflict",
  grant_unavailable: "Grant directory unavailable",
};

const grantRepositoryCauses = new WeakMap<GrantRepositoryError, unknown>();

export class GrantRepositoryError extends Error {
  readonly code: GrantRepositoryErrorCode;

  constructor(code: GrantRepositoryErrorCode, cause?: unknown) {
    super(SAFE_MESSAGES[code]);
    this.code = code;
    Object.defineProperty(this, "name", {
      configurable: true,
      enumerable: false,
      value: "GrantRepositoryError",
      writable: true,
    });
    if (cause !== undefined) grantRepositoryCauses.set(this, cause);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const getGrantRepositoryCause = (error: GrantRepositoryError): unknown =>
  grantRepositoryCauses.get(error);

type AccountGrantRow = {
  id: string;
  tenant_id: string;
  membership_id: string;
  identity_id: string;
  identity_display_name: string;
  account_id: string;
  connection_id: string;
  provider: string;
  account_label: string;
  operation_scope: string;
  chat_scope: string;
  status: string;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
};

type AccountGrantChatRow = {
  grant_id: string;
  chat_id: string;
};

type PermissionRequestRow = {
  id: string;
  tenant_id: string;
  requester_principal_id: string;
  requester_membership_id: string;
  identity_id: string;
  account_id: string;
  operation_scope: string;
  chat_scope: string;
  chat_ids_json: string;
  reason: string;
  status: string;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  decided_by_principal_id: string | null;
};

type AccountReadGrantRow = {
  account_id: string;
  chat_scope: AccountGrantChatScope;
  chat_id: string | null;
};

export type AccountReadScope = {
  allowedAccountIds: string[];
  allowedAllAccountIds: string[];
  allowedConversationIds: string[];
};

/** Check one account/chat operation grant without materializing grant scope. */
export async function hasAccountOperationGrant(
  db: D1DatabaseSession,
  tenantId: string,
  membershipId: string,
  identityId: string,
  accountId: string,
  conversationId: string,
  operationScope: AccountGrantOperationScope,
): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        `SELECT 1 AS granted
       FROM account_grants AS g
       JOIN connections AS c
         ON c.tenant_id = g.tenant_id
       JOIN connection_accounts AS ca
         ON ca.connection_id = c.id
        AND ca.account_id = g.account_id
        AND ca.status = 'active'
       WHERE g.tenant_id = ?
         AND g.membership_id = ?
         AND g.identity_id = ?
         AND g.account_id = ?
         AND g.operation_scope = ?
         AND g.status = 'active'
         AND (
           g.chat_scope = 'all_chats'
           OR EXISTS (
             SELECT 1
             FROM account_grant_chats AS gc
             WHERE gc.tenant_id = g.tenant_id
               AND gc.grant_id = g.id
               AND gc.chat_id = ?
           )
         )
       LIMIT 1`,
      )
      .bind(
        tenantId,
        membershipId,
        identityId,
        accountId,
        operationScope,
        conversationId,
      )
      .first<{ granted: number }>();
    return row !== null;
  } catch (error) {
    throw grantError("grant_unavailable", error);
  }
}

export type ListAccountGrantsInput = {
  tenantId: string;
  membershipId?: string;
  identityId?: string;
  accountId?: string;
  status?: AccountGrantStatus;
  cursor?: string;
  limit?: number;
};

export type ListAccountGrantTargetsInput = {
  tenantId: string;
  cursor?: string;
  limit?: number;
};

type ListConnectedAccountsInput = {
  tenantId: string;
  identityId?: string;
  grantMembershipId?: string;
  grantIdentityId?: string;
  cursor?: string;
  limit?: number;
};

export type ListPermissionRequestsInput = {
  tenantId: string;
  requesterMembershipId?: string;
  identityId?: string;
  status?: PermissionRequestStatus;
  cursor?: string;
  limit?: number;
};

export type AccountMutationInput = {
  idempotencyKey: string;
  tenantId: string;
  actorPrincipalId: string;
  membershipId: string;
  identityId: string;
  accountId: string;
  operationScope: AccountGrantOperationScope;
  chatScope: AccountGrantChatScope;
  chatIds: string[];
  occurredAt: string;
  grantId?: string;
};

export type AccountUpdateInput = {
  idempotencyKey: string;
  tenantId: string;
  actorPrincipalId: string;
  grantId: string;
  operationScope: AccountGrantOperationScope;
  chatScope: AccountGrantChatScope;
  chatIds: string[];
  occurredAt: string;
};

export type PermissionRequestMutationInput = {
  idempotencyKey: string;
  tenantId: string;
  requesterPrincipalId: string;
  requesterMembershipId: string;
  identityId: string;
  accountId: string;
  operationScope: AccountGrantOperationScope;
  chatScope: AccountGrantChatScope;
  chatIds: string[];
  reason: string;
  occurredAt: string;
  requestId?: string;
};

const grantError = (
  code: GrantRepositoryErrorCode,
  cause?: unknown,
): GrantRepositoryError => new GrantRepositoryError(code, cause);

const canonicalChatIds = (chatIds: readonly string[]): string[] => {
  const values = [...new Set(chatIds)].sort((left, right) =>
    left.localeCompare(right),
  );
  if (values.length > MAX_GRANT_CHAT_IDS) throw grantError("grant_invalid");
  return values;
};

const accountGrantId = (): string =>
  `grant_${crypto.randomUUID().replaceAll("-", "")}`;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

const parseChatIds = (value: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string")) {
      throw new Error("invalid chat IDs");
    }
    return canonicalChatIds(parsed);
  } catch (error) {
    throw grantError("grant_invalid", error);
  }
};

const validateChatScope = (
  chatScope: AccountGrantChatScope,
  chatIds: readonly string[],
): string[] => {
  const canonical = canonicalChatIds(chatIds);
  if (chatScope === "all_chats" && canonical.length > 0) {
    throw grantError("grant_invalid");
  }
  if (chatScope === "selected_chats" && canonical.length === 0) {
    throw grantError("grant_invalid");
  }
  return canonical;
};

const validateScope = (scope: string): AccountGrantOperationScope => {
  const parsed = AccountGrantOperationScopeSchema.safeParse(scope);
  if (!parsed.success) throw grantError("grant_invalid");
  return parsed.data;
};

const mapAccountGrantRows = (
  rows: readonly AccountGrantRow[],
  chats: readonly AccountGrantChatRow[],
): AccountGrant[] => {
  const chatsByGrant = new Map<string, string[]>();
  for (const row of chats) {
    const existing = chatsByGrant.get(row.grant_id) ?? [];
    existing.push(row.chat_id);
    chatsByGrant.set(row.grant_id, existing);
  }
  return rows.map((row) =>
    AccountGrantSchema.parse({
      id: row.id,
      tenant_id: row.tenant_id,
      membership_id: row.membership_id,
      identity_id: row.identity_id,
      identity_display_name: row.identity_display_name,
      account_id: row.account_id,
      connection_id: row.connection_id,
      provider: row.provider,
      account_label: row.account_label,
      operation_scope: validateScope(row.operation_scope),
      chat_scope: row.chat_scope,
      chat_ids: canonicalChatIds(chatsByGrant.get(row.id) ?? []),
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      revoked_at: row.revoked_at,
    }),
  );
};

const mapPermissionRequestRows = (
  rows: readonly PermissionRequestRow[],
): PermissionRequest[] =>
  rows.map((row) =>
    PermissionRequestSchema.parse({
      id: row.id,
      tenant_id: row.tenant_id,
      requester_principal_id: row.requester_principal_id,
      requester_membership_id: row.requester_membership_id,
      identity_id: row.identity_id,
      account_id: row.account_id,
      operation_scope: validateScope(row.operation_scope),
      chat_scope: row.chat_scope,
      chat_ids: parseChatIds(row.chat_ids_json),
      reason: row.reason,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      decided_at: row.decided_at,
      decided_by_principal_id: row.decided_by_principal_id,
    }),
  );

const grantRowsQuery = `
  SELECT
    g.id,
    g.tenant_id,
    g.membership_id,
    g.identity_id,
    i.display_name AS identity_display_name,
    g.account_id,
    c.id AS connection_id,
    c.provider,
    c.display_label AS account_label,
    g.operation_scope,
    g.chat_scope,
    g.status,
    g.created_at,
    g.updated_at,
    g.revoked_at
  FROM account_grants AS g
  JOIN identities AS i ON i.tenant_id = g.tenant_id AND i.id = g.identity_id
  JOIN connection_accounts AS ca ON ca.account_id = g.account_id
  JOIN connections AS c ON c.id = ca.connection_id AND c.tenant_id = g.tenant_id
  WHERE g.tenant_id = ?
`;

type AccountGrantTargetRow = {
  membership_id: string;
  principal_id: string;
  principal_type: string;
  principal_display_name: string;
  role: string;
  identity_id: string;
  identity_kind: string;
  identity_display_name: string;
};

const parseTargetCursor = (cursor: string): [string, string] => {
  const separator = cursor.indexOf("|");
  if (separator <= 0 || separator === cursor.length - 1) {
    throw grantError("grant_invalid");
  }
  return [cursor.slice(0, separator), cursor.slice(separator + 1)];
};

export async function listAccountGrantTargets(
  db: D1DatabaseSession,
  input: ListAccountGrantTargetsInput,
): Promise<AccountGrantTargetPage> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), MAX_GRANT_PAGE_SIZE);
  const conditions = [
    "m.tenant_id = ?",
    "m.status = 'active'",
    "t.status = 'active'",
    "p.status = 'active'",
    "p.revoked_at IS NULL",
    "i.status = 'active'",
    "((p.principal_type IN ('human', 'operator') AND i.identity_kind = 'human') OR (p.principal_type = 'agent' AND i.identity_kind = 'agent'))",
    "EXISTS (SELECT 1 FROM identity_grants AS ig WHERE ig.tenant_id = m.tenant_id AND ig.membership_id = m.id AND ig.identity_id = i.id)",
  ];
  const bindings: (string | number)[] = [input.tenantId];
  if (input.cursor !== undefined) {
    const [membershipId, identityId] = parseTargetCursor(input.cursor);
    conditions.push("(m.id > ? OR (m.id = ? AND i.id > ?))");
    bindings.push(membershipId, membershipId, identityId);
  }
  bindings.push(limit + 1);
  try {
    const result = await db
      .prepare(
        `SELECT m.id AS membership_id, p.id AS principal_id, p.principal_type, p.display_name AS principal_display_name, m.role, i.id AS identity_id, i.identity_kind, i.display_name AS identity_display_name
       FROM memberships AS m
       JOIN tenants AS t ON t.id = m.tenant_id
       JOIN principals AS p ON p.id = m.principal_id
       JOIN identity_grants AS g ON g.tenant_id = m.tenant_id AND g.membership_id = m.id
       JOIN identities AS i ON i.tenant_id = g.tenant_id AND i.id = g.identity_id
       WHERE ${conditions.join(" AND ")}
       GROUP BY m.id, p.id, p.principal_type, p.display_name, m.role, i.id, i.identity_kind, i.display_name
       ORDER BY m.id ASC, i.id ASC
       LIMIT ?`,
      )
      .bind(...bindings)
      .all<AccountGrantTargetRow>();
    const visible = result.results.slice(0, limit).map((row) => ({
      membership_id: row.membership_id,
      principal_id: row.principal_id,
      principal_type: row.principal_type,
      principal_display_name: row.principal_display_name,
      role: row.role,
      identity_id: row.identity_id,
      identity_kind: row.identity_kind,
      identity_display_name: row.identity_display_name,
    }));
    const last = visible.at(-1);
    return AccountGrantTargetPageSchema.parse({
      items: visible,
      next_cursor:
        result.results.length > limit && last
          ? `${last.membership_id}|${last.identity_id}`
          : null,
    });
  } catch (error) {
    if (error instanceof GrantRepositoryError) throw error;
    throw grantError("grant_unavailable", error);
  }
}

export async function listAccountGrants(
  db: D1DatabaseSession,
  input: ListAccountGrantsInput,
): Promise<AccountGrantPage> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), MAX_GRANT_PAGE_SIZE);
  const conditions: string[] = [];
  const bindings: (string | number)[] = [input.tenantId];
  if (input.membershipId !== undefined) {
    conditions.push("g.membership_id = ?");
    bindings.push(input.membershipId);
  }
  if (input.identityId !== undefined) {
    conditions.push("g.identity_id = ?");
    bindings.push(input.identityId);
  }
  if (input.accountId !== undefined) {
    conditions.push("g.account_id = ?");
    bindings.push(input.accountId);
  }
  if (input.status !== undefined) {
    conditions.push("g.status = ?");
    bindings.push(input.status);
  }
  if (input.cursor !== undefined) {
    conditions.push("g.id > ?");
    bindings.push(input.cursor);
  }
  const query = `${grantRowsQuery}${conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : ""} ORDER BY g.id ASC LIMIT ?`;
  bindings.push(limit + 1);
  let result: { results: AccountGrantRow[] };
  try {
    result = await db
      .prepare(query)
      .bind(...bindings)
      .all<AccountGrantRow>();
    const visible = result.results.slice(0, limit);
    const next =
      result.results.length > limit ? (visible.at(-1)?.id ?? null) : null;
    if (visible.length === 0)
      return AccountGrantPageSchema.parse({ items: [], next_cursor: null });
    const placeholders = visible.map(() => "?").join(",");
    const chatRows = await db
      .prepare(
        `SELECT grant_id, chat_id FROM account_grant_chats WHERE tenant_id = ? AND grant_id IN (${placeholders}) ORDER BY grant_id ASC, chat_id ASC`,
      )
      .bind(input.tenantId, ...visible.map((grant) => grant.id))
      .all<AccountGrantChatRow>();
    return AccountGrantPageSchema.parse({
      items: mapAccountGrantRows(visible, chatRows.results),
      next_cursor: next,
    });
  } catch (error) {
    if (error instanceof GrantRepositoryError) throw error;
    throw grantError("grant_unavailable", error);
  }
}

export async function getAccountGrant(
  db: D1DatabaseSession,
  tenantId: string,
  grantId: string,
): Promise<AccountGrant> {
  // A direct query avoids making a caller-provided ID depend on list ordering.
  try {
    const row = await db
      .prepare(`${grantRowsQuery} AND g.id = ? LIMIT 1`)
      .bind(tenantId, grantId)
      .first<AccountGrantRow>();
    if (!row) throw grantError("grant_not_found");
    const chats = await db
      .prepare(
        "SELECT grant_id, chat_id FROM account_grant_chats WHERE tenant_id = ? AND grant_id = ? ORDER BY chat_id ASC",
      )
      .bind(tenantId, grantId)
      .all<AccountGrantChatRow>();
    const [grant] = mapAccountGrantRows([row], chats.results);
    if (!grant) throw grantError("grant_not_found");
    return grant;
  } catch (error) {
    if (error instanceof GrantRepositoryError) throw error;
    throw grantError("grant_unavailable", error);
  }
}

const mutationPayload = (input: AccountMutationInput | AccountUpdateInput) =>
  "grantId" in input
    ? {
        tenant_id: input.tenantId,
        grant_id: input.grantId,
        operation_scope: input.operationScope,
        chat_scope: input.chatScope,
        chat_ids: canonicalChatIds(input.chatIds),
      }
    : {
        tenant_id: input.tenantId,
        membership_id: input.membershipId,
        identity_id: input.identityId,
        account_id: input.accountId,
        operation_scope: input.operationScope,
        chat_scope: input.chatScope,
        chat_ids: canonicalChatIds(input.chatIds),
      };

const mutationRecordStatement = async (
  db: D1Database,
  idempotencyKey: string,
  tenantId: string,
  actorPrincipalId: string,
  mutationType: string,
  payload: unknown,
  occurredAt: string,
): Promise<D1PreparedStatement> => {
  const requestHash = await sha256Hex(JSON.stringify(payload));
  return db
    .prepare(
      "INSERT INTO directory_mutations (idempotency_key, tenant_id, actor_principal_id, mutation_type, request_hash, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(idempotency_key) DO UPDATE SET request_hash = excluded.request_hash",
    )
    .bind(
      idempotencyKey,
      tenantId,
      actorPrincipalId,
      mutationType,
      requestHash,
      occurredAt,
    );
};

const grantAuditStatements = (
  db: D1Database,
  input: {
    idempotencyKey: string;
    tenantId: string;
    actorPrincipalId: string;
    action: string;
    grantId: string;
    payload: unknown;
    occurredAt: string;
  },
) => {
  const payloadJson = JSON.stringify(input.payload);
  return [
    db
      .prepare(
        "INSERT OR IGNORE INTO audit_events (id, tenant_id, actor_principal_id, action, target_type, target_id, reason, metadata_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        `audit_${input.idempotencyKey}`,
        input.tenantId,
        input.actorPrincipalId,
        input.action,
        "account_grant",
        input.grantId,
        null,
        payloadJson,
        input.occurredAt,
      ),
    db
      .prepare(
        "INSERT OR IGNORE INTO control_event_outbox (event_id, tenant_id, event_type, aggregate_type, aggregate_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        `control_${input.idempotencyKey}`,
        input.tenantId,
        input.action,
        "account_grant",
        input.grantId,
        payloadJson,
        input.occurredAt,
      ),
  ];
};

const grantChatStatements = (
  db: D1Database,
  grantId: string,
  tenantId: string,
  accountId: string,
  chatScope: AccountGrantChatScope,
  chatIds: readonly string[],
  occurredAt: string,
) => [
  db
    .prepare(
      "DELETE FROM account_grant_chats WHERE tenant_id = ? AND grant_id = ?",
    )
    .bind(tenantId, grantId),
  ...(chatScope === "selected_chats"
    ? canonicalChatIds(chatIds).map((chatId) =>
        db
          .prepare(
            "INSERT INTO account_grant_chats (grant_id, tenant_id, account_id, chat_id, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(grantId, tenantId, accountId, chatId, occurredAt),
      )
    : []),
];

export async function createAccountGrant(
  db: D1Database,
  input: AccountMutationInput,
): Promise<AccountGrant> {
  const chatIds = validateChatScope(input.chatScope, input.chatIds);
  try {
    const target = await db
      .prepare(
        `SELECT 1 AS eligible
       FROM memberships AS m
       JOIN principals AS p ON p.id = m.principal_id
       JOIN identities AS i ON i.tenant_id = m.tenant_id AND i.id = ?
       WHERE m.tenant_id = ?
         AND m.id = ?
         AND m.status = 'active'
         AND p.status = 'active'
         AND p.revoked_at IS NULL
         AND i.status = 'active'
         AND ((p.principal_type IN ('human', 'operator') AND i.identity_kind = 'human') OR (p.principal_type = 'agent' AND i.identity_kind = 'agent'))
         AND EXISTS (SELECT 1 FROM identity_grants AS ig WHERE ig.tenant_id = m.tenant_id AND ig.membership_id = m.id AND ig.identity_id = i.id)
       LIMIT 1`,
      )
      .bind(input.identityId, input.tenantId, input.membershipId)
      .first<{ eligible: number }>();
    if (target === null) throw grantError("grant_not_found");

    const account = await db
      .prepare(
        `SELECT 1 AS eligible
       FROM connection_accounts AS ca
       JOIN connections AS c ON c.id = ca.connection_id AND c.tenant_id = ?
       WHERE ca.account_id = ? AND ca.status = 'active'
       LIMIT 1`,
      )
      .bind(input.tenantId, input.accountId)
      .first<{ eligible: number }>();
    // Keep account binding failures as mutation conflicts. The account may
    // exist in another tenant, and exposing that distinction as a not-found
    // response would change the established cross-tenant mutation contract.
    if (account === null) throw new Error("account binding is not valid");

    const existing = await db
      .prepare(
        "SELECT id FROM account_grants WHERE tenant_id = ? AND membership_id = ? AND identity_id = ? AND account_id = ? AND operation_scope = ? LIMIT 1",
      )
      .bind(
        input.tenantId,
        input.membershipId,
        input.identityId,
        input.accountId,
        input.operationScope,
      )
      .first<{ id: string }>();
    const grantId = existing?.id ?? input.grantId ?? accountGrantId();
    const resolvedPayload = mutationPayload({ ...input, grantId });
    const mutation = await mutationRecordStatement(
      db,
      input.idempotencyKey,
      input.tenantId,
      input.actorPrincipalId,
      "authorization.account_grant.created",
      resolvedPayload,
      input.occurredAt,
    );
    await db.batch([
      mutation,
      db
        .prepare(
          "INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL) ON CONFLICT(tenant_id, membership_id, identity_id, account_id, operation_scope) DO UPDATE SET chat_scope = excluded.chat_scope, status = 'active', updated_at = excluded.updated_at, revoked_at = NULL",
        )
        .bind(
          grantId,
          input.tenantId,
          input.membershipId,
          input.identityId,
          input.accountId,
          input.operationScope,
          input.chatScope,
          input.occurredAt,
          input.occurredAt,
        ),
      ...grantChatStatements(
        db,
        grantId,
        input.tenantId,
        input.accountId,
        input.chatScope,
        chatIds,
        input.occurredAt,
      ),
      ...grantAuditStatements(db, {
        idempotencyKey: input.idempotencyKey,
        tenantId: input.tenantId,
        actorPrincipalId: input.actorPrincipalId,
        action: "authorization.account_grant.created",
        grantId,
        payload: resolvedPayload,
        occurredAt: input.occurredAt,
      }),
    ]);
    return await getAccountGrant(
      db.withSession("first-primary"),
      input.tenantId,
      grantId,
    );
  } catch (error) {
    if (error instanceof GrantRepositoryError) throw error;
    throw grantError("grant_conflict", error);
  }
}

export async function updateAccountGrant(
  db: D1Database,
  input: AccountUpdateInput,
): Promise<AccountGrant> {
  const chatIds = validateChatScope(input.chatScope, input.chatIds);
  const payload = mutationPayload({ ...input, grantId: input.grantId });
  try {
    const existing = await getAccountGrant(
      db.withSession("first-primary"),
      input.tenantId,
      input.grantId,
    );
    const mutation = await mutationRecordStatement(
      db,
      input.idempotencyKey,
      input.tenantId,
      input.actorPrincipalId,
      "authorization.account_grant.updated",
      payload,
      input.occurredAt,
    );
    await db.batch([
      mutation,
      db
        .prepare(
          "UPDATE account_grants SET operation_scope = ?, chat_scope = ?, status = 'active', updated_at = ?, revoked_at = NULL WHERE tenant_id = ? AND id = ?",
        )
        .bind(
          input.operationScope,
          input.chatScope,
          input.occurredAt,
          input.tenantId,
          input.grantId,
        ),
      ...grantChatStatements(
        db,
        input.grantId,
        input.tenantId,
        existing.account_id,
        input.chatScope,
        chatIds,
        input.occurredAt,
      ),
      ...grantAuditStatements(db, {
        idempotencyKey: input.idempotencyKey,
        tenantId: input.tenantId,
        actorPrincipalId: input.actorPrincipalId,
        action: "authorization.account_grant.updated",
        grantId: input.grantId,
        payload,
        occurredAt: input.occurredAt,
      }),
    ]);
    return await getAccountGrant(
      db.withSession("first-primary"),
      input.tenantId,
      input.grantId,
    );
  } catch (error) {
    if (error instanceof GrantRepositoryError) throw error;
    throw grantError("grant_conflict", error);
  }
}

export async function revokeAccountGrant(
  db: D1Database,
  input: {
    idempotencyKey: string;
    tenantId: string;
    actorPrincipalId: string;
    grantId: string;
    occurredAt: string;
  },
): Promise<AccountGrant> {
  const payload = {
    tenant_id: input.tenantId,
    grant_id: input.grantId,
    status: "revoked",
  };
  try {
    await getAccountGrant(
      db.withSession("first-primary"),
      input.tenantId,
      input.grantId,
    );
    const mutation = await mutationRecordStatement(
      db,
      input.idempotencyKey,
      input.tenantId,
      input.actorPrincipalId,
      "authorization.account_grant.revoked",
      payload,
      input.occurredAt,
    );
    await db.batch([
      mutation,
      db
        .prepare(
          "UPDATE account_grants SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?",
        )
        .bind(
          input.occurredAt,
          input.occurredAt,
          input.tenantId,
          input.grantId,
        ),
      ...grantAuditStatements(db, {
        idempotencyKey: input.idempotencyKey,
        tenantId: input.tenantId,
        actorPrincipalId: input.actorPrincipalId,
        action: "authorization.account_grant.revoked",
        grantId: input.grantId,
        payload,
        occurredAt: input.occurredAt,
      }),
    ]);
    return await getAccountGrant(
      db.withSession("first-primary"),
      input.tenantId,
      input.grantId,
    );
  } catch (error) {
    if (error instanceof GrantRepositoryError) throw error;
    throw grantError("grant_conflict", error);
  }
}

export async function resolveAccountReadScope(
  db: D1DatabaseSession,
  tenantId: string,
  membershipId: string,
  identityId: string,
  accountId?: string,
): Promise<AccountReadScope> {
  try {
    const bindings: (string | number)[] = [tenantId, membershipId, identityId];
    const accountFilter =
      accountId === undefined ? "" : " AND g.account_id = ?";
    if (accountId !== undefined) bindings.push(accountId);
    const result = await db
      .prepare(
        `SELECT g.account_id, g.chat_scope, gc.chat_id
       FROM account_grants AS g
       JOIN connection_accounts AS ca ON ca.account_id = g.account_id AND ca.status = 'active'
       LEFT JOIN account_grant_chats AS gc ON gc.tenant_id = g.tenant_id AND gc.grant_id = g.id
       WHERE g.tenant_id = ?
         AND g.membership_id = ?
         AND g.identity_id = ?
         AND g.operation_scope = 'conversation.read'
         AND g.status = 'active'
         ${accountFilter}
       ORDER BY g.account_id ASC, gc.chat_id ASC`,
      )
      .bind(...bindings)
      .all<AccountReadGrantRow>();
    const allowed = new Set<string>();
    const all = new Set<string>();
    const chats = new Set<string>();
    for (const row of result.results) {
      allowed.add(row.account_id);
      if (row.chat_scope === "all_chats") all.add(row.account_id);
      if (row.chat_id !== null) chats.add(row.chat_id);
    }
    return {
      allowedAccountIds: [...allowed].sort(),
      allowedAllAccountIds: [...all].sort(),
      allowedConversationIds: [...chats].sort(),
    };
  } catch (error) {
    throw grantError("grant_unavailable", error);
  }
}

export async function listConnectedAccounts(
  db: D1DatabaseSession,
  input: ListConnectedAccountsInput,
): Promise<ConnectedAccountPage> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), MAX_GRANT_PAGE_SIZE);
  const bindings: (string | number)[] = [input.tenantId];
  const conditions = ["c.tenant_id = ?", "ca.status = 'active'"];
  if (input.identityId !== undefined) {
    conditions.push("c.identity_id = ?");
    bindings.push(input.identityId);
  }
  if (
    input.grantMembershipId !== undefined ||
    input.grantIdentityId !== undefined
  ) {
    if (
      input.grantMembershipId === undefined ||
      input.grantIdentityId === undefined
    ) {
      return ConnectedAccountPageSchema.parse({ items: [], next_cursor: null });
    }
    conditions.push(
      `EXISTS (
         SELECT 1
         FROM account_grants AS ag
         WHERE ag.tenant_id = c.tenant_id
           AND ag.account_id = ca.account_id
           AND ag.membership_id = ?
           AND ag.identity_id = ?
           AND ag.operation_scope = 'conversation.read'
           AND ag.status = 'active'
       )`,
    );
    bindings.push(input.grantMembershipId, input.grantIdentityId);
  }
  if (input.cursor !== undefined) {
    conditions.push("ca.account_id > ?");
    bindings.push(input.cursor);
  }
  bindings.push(limit + 1);
  try {
    const result = await db
      .prepare(
        `SELECT ca.account_id, c.tenant_id, c.id AS connection_id, c.identity_id, c.provider, c.display_label, c.status, c.created_at, c.updated_at FROM connection_accounts AS ca JOIN connections AS c ON c.id = ca.connection_id WHERE ${conditions.join(" AND ")} ORDER BY ca.account_id ASC LIMIT ?`,
      )
      .bind(...bindings)
      .all<ConnectedAccount>();
    const visible = result.results.slice(0, limit).map((row) =>
      ConnectedAccountSchema.parse({
        account_id: row.account_id,
        tenant_id: row.tenant_id,
        connection_id: row.connection_id,
        identity_id: row.identity_id,
        provider: row.provider,
        display_label: row.display_label,
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }),
    );
    return ConnectedAccountPageSchema.parse({
      items: visible,
      next_cursor:
        result.results.length > limit
          ? (visible.at(-1)?.account_id ?? null)
          : null,
    });
  } catch (error) {
    throw grantError("grant_unavailable", error);
  }
}

export async function createPermissionRequest(
  db: D1Database,
  input: PermissionRequestMutationInput,
): Promise<PermissionRequest> {
  const chatIds = validateChatScope(input.chatScope, input.chatIds);
  const requestId =
    input.requestId ??
    `request_${(await sha256Hex(input.idempotencyKey)).slice(0, 48)}`;
  const payload = {
    tenant_id: input.tenantId,
    requester_membership_id: input.requesterMembershipId,
    identity_id: input.identityId,
    account_id: input.accountId,
    operation_scope: input.operationScope,
    chat_scope: input.chatScope,
    chat_ids: chatIds,
    reason: input.reason,
  };
  try {
    const mutation = await mutationRecordStatement(
      db,
      input.idempotencyKey,
      input.tenantId,
      input.requesterPrincipalId,
      "authorization.permission_request.created",
      payload,
      input.occurredAt,
    );
    await db.batch([
      mutation,
      db
        .prepare(
          "INSERT OR IGNORE INTO permission_requests (id, tenant_id, requester_principal_id, requester_membership_id, identity_id, account_id, operation_scope, chat_scope, chat_ids_json, reason, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
        )
        .bind(
          requestId,
          input.tenantId,
          input.requesterPrincipalId,
          input.requesterMembershipId,
          input.identityId,
          input.accountId,
          input.operationScope,
          input.chatScope,
          JSON.stringify(chatIds),
          input.reason,
          input.occurredAt,
          input.occurredAt,
        ),
      db
        .prepare(
          "INSERT OR IGNORE INTO audit_events (id, tenant_id, actor_principal_id, action, target_type, target_id, reason, metadata_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          `audit_${input.idempotencyKey}`,
          input.tenantId,
          input.requesterPrincipalId,
          "authorization.permission_request.created",
          "permission_request",
          requestId,
          input.reason,
          JSON.stringify(payload),
          input.occurredAt,
        ),
    ]);
    const row = await db
      .withSession("first-primary")
      .prepare(
        "SELECT id, tenant_id, requester_principal_id, requester_membership_id, identity_id, account_id, operation_scope, chat_scope, chat_ids_json, reason, status, created_at, updated_at, decided_at, decided_by_principal_id FROM permission_requests WHERE tenant_id = ? AND id = ?",
      )
      .bind(input.tenantId, requestId)
      .first<PermissionRequestRow>();
    if (!row) throw grantError("grant_not_found");
    const [request] = mapPermissionRequestRows([row]);
    if (!request) throw grantError("grant_not_found");
    return request;
  } catch (error) {
    if (error instanceof GrantRepositoryError) throw error;
    throw grantError("grant_conflict", error);
  }
}

export async function listPermissionRequests(
  db: D1DatabaseSession,
  input: ListPermissionRequestsInput,
): Promise<PermissionRequestPage> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), MAX_GRANT_PAGE_SIZE);
  const conditions = ["tenant_id = ?"];
  const bindings: (string | number)[] = [input.tenantId];
  if (input.requesterMembershipId !== undefined) {
    conditions.push("requester_membership_id = ?");
    bindings.push(input.requesterMembershipId);
  }
  if (input.identityId !== undefined) {
    conditions.push("identity_id = ?");
    bindings.push(input.identityId);
  }
  if (input.status !== undefined) {
    conditions.push("status = ?");
    bindings.push(input.status);
  }
  if (input.cursor !== undefined) {
    conditions.push("id > ?");
    bindings.push(input.cursor);
  }
  bindings.push(limit + 1);
  try {
    const result = await db
      .prepare(
        `SELECT id, tenant_id, requester_principal_id, requester_membership_id, identity_id, account_id, operation_scope, chat_scope, chat_ids_json, reason, status, created_at, updated_at, decided_at, decided_by_principal_id FROM permission_requests WHERE ${conditions.join(" AND ")} ORDER BY id ASC LIMIT ?`,
      )
      .bind(...bindings)
      .all<PermissionRequestRow>();
    const visible = mapPermissionRequestRows(result.results.slice(0, limit));
    return PermissionRequestPageSchema.parse({
      items: visible,
      next_cursor:
        result.results.length > limit ? (visible.at(-1)?.id ?? null) : null,
    });
  } catch (error) {
    throw grantError("grant_unavailable", error);
  }
}
