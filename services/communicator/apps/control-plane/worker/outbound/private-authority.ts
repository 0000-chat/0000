import type {
  OutboundCapability,
  OutboundTuple,
  PrivateAuthorityClaim,
  PrivateAuthorityClaimInput,
  PrivateAuthorityClaimResult,
  PrivateAuthorityReservation,
  PrivateAuthorityReservationInput,
  PrivateAuthorityReservationResult,
  PrivateAuthorityScope,
} from "./authority-types";

type AuthorityDatabase = D1Database | D1DatabaseSession;

type ReservationRow = {
  id: string;
  tenant_id: string;
  operation_id: string;
  membership_id: string;
  identity_id: string;
  account_id: string;
  conversation_id: string;
  connection_id: string;
  session_generation: string;
  grant_id: string | null;
  capability_kind: string;
  capability_id: string;
  capability_epoch: number;
  authority_id: string | null;
  request_hash: string;
  status: string;
  uncertain_reason: string | null;
  created_at: string;
  updated_at: string;
};

type ClaimRow = ReservationRow & {
  reservation_id: string;
  expires_at: string;
};

const NON_EMPTY_FIELDS = [
  "tenant_id",
  "membership_id",
  "identity_id",
  "account_id",
  "conversation_id",
  "connection_id",
] as const;

const isNonEmpty = (value: string): boolean => value.trim().length > 0;
const isDigest = (value: string): boolean => /^[0-9a-f]{64}$/u.test(value);
const isEpoch = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 1;
const validTuple = (tuple: OutboundTuple): boolean =>
  NON_EMPTY_FIELDS.every((field) => isNonEmpty(tuple[field]));
const validCapability = (capability: OutboundCapability): boolean =>
  isNonEmpty(
    capability.kind === "account_grant"
      ? capability.grant_id
      : capability.authority_id,
  ) &&
  isEpoch(
    capability.kind === "account_grant"
      ? capability.authorization_epoch
      : capability.authority_epoch,
  );
const validWindow = (now: string, expiresAt: string): boolean => {
  const nowMs = Date.parse(now);
  const expiresMs = Date.parse(expiresAt);
  return (
    Number.isFinite(nowMs) && Number.isFinite(expiresMs) && expiresMs > nowMs
  );
};

const intentTable = (scope: PrivateAuthorityScope): string =>
  scope === "receipt.send"
    ? "receipt_authority_intents"
    : scope === "conversation.create"
      ? "contact_authority_intents"
      : "group_authority_intents";

const claimTable = (scope: PrivateAuthorityScope): string =>
  scope === "receipt.send"
    ? "receipt_dispatch_claims"
    : scope === "conversation.create"
      ? "contact_dispatch_claims"
      : "group_dispatch_claims";

const usesOperationKind = (scope: PrivateAuthorityScope): boolean =>
  scope === "group.create" || scope === "group.manage";

const operationPredicate = (
  scope: PrivateAuthorityScope,
  alias: string,
): string => {
  const table =
    scope === "receipt.send"
      ? "receipt_operations"
      : scope === "conversation.create"
        ? "direct_chat_creation_operations"
        : scope === "group.create"
          ? "group_creation_operations"
          : "group_management_operations";
  return `EXISTS (
    SELECT 1 FROM ${table} AS ${alias}
    WHERE ${alias}.tenant_id = ?
      AND ${alias}.operation_id = ?
      AND ${alias}.membership_id = ?
      AND ${alias}.identity_id = ?
      AND ${alias}.account_id = ?
      AND ${alias}.connection_id = ?
      AND ${alias}.conversation_id = ?
      AND ${alias}.request_hash = ?
      AND ${alias}.session_generation = ?
  )`;
};

const authorityPredicate = (scope: PrivateAuthorityScope): string => `(
  (
    ? = 'account_grant'
    AND EXISTS (
      SELECT 1
      FROM account_grants AS g
      WHERE g.tenant_id = m.tenant_id
        AND g.id = ?
        AND g.membership_id = m.id
        AND g.identity_id = i.id
        AND g.account_id = ca.account_id
        AND g.operation_scope = '${scope}'
        AND g.status = 'active'
        AND g.authorization_epoch = ?
        AND (
          g.chat_scope = 'all_chats'
          OR EXISTS (
            SELECT 1 FROM account_grant_chats AS gc
            WHERE gc.tenant_id = g.tenant_id
              AND gc.grant_id = g.id
              AND gc.account_id = g.account_id
              AND gc.chat_id = ?
          )
        )
        AND EXISTS (
          SELECT 1 FROM identity_grants AS ig
          WHERE ig.tenant_id = g.tenant_id
            AND ig.membership_id = g.membership_id
            AND ig.identity_id = g.identity_id
            AND ig.operation_scope = '${scope}'
        )
    )
  )
  OR (
    ? = 'owner_admin'
    AND ? = m.id
    AND ? = m.authority_epoch
    AND m.role IN ('owner', 'admin')
    AND p.principal_type IN ('human', 'operator')
    AND i.identity_kind = 'human'
    AND c.identity_id = i.id
  )
)`;

const capabilityColumns = (
  capability: OutboundCapability,
): {
  kind: OutboundCapability["kind"];
  id: string;
  epoch: number;
  grantId: string | null;
  authorityId: string | null;
} =>
  capability.kind === "account_grant"
    ? {
        kind: capability.kind,
        id: capability.grant_id,
        epoch: capability.authorization_epoch,
        grantId: capability.grant_id,
        authorityId: null,
      }
    : {
        kind: capability.kind,
        id: capability.authority_id,
        epoch: capability.authority_epoch,
        grantId: null,
        authorityId: capability.authority_id,
      };

const status = (value: string): PrivateAuthorityReservation["status"] => {
  if (value === "reserved" || value === "committed" || value === "uncertain")
    return value;
  throw new Error("private authority reservation status is invalid");
};

const claimStatus = (value: string): PrivateAuthorityClaim["status"] => {
  if (value === "claimed" || value === "uncertain") return value;
  throw new Error("private authority claim status is invalid");
};

const mapReservation = (
  row: ReservationRow,
  operationScope: PrivateAuthorityScope,
): PrivateAuthorityReservation => ({
  id: row.id,
  tenant_id: row.tenant_id,
  operation_scope: operationScope,
  operation_id: row.operation_id,
  membership_id: row.membership_id,
  identity_id: row.identity_id,
  account_id: row.account_id,
  conversation_id: row.conversation_id,
  connection_id: row.connection_id,
  session_generation: row.session_generation,
  grant_id: row.grant_id,
  capability:
    row.capability_kind === "account_grant"
      ? {
          kind: "account_grant",
          grant_id: row.capability_id,
          authorization_epoch: row.capability_epoch,
        }
      : {
          kind: "owner_admin",
          authority_id: row.capability_id,
          authority_epoch: row.capability_epoch,
        },
  request_hash: row.request_hash,
  status: status(row.status),
  uncertain_reason: row.uncertain_reason,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const mapClaim = (
  row: ClaimRow,
  operationScope: PrivateAuthorityScope,
): PrivateAuthorityClaim => ({
  id: row.id,
  tenant_id: row.tenant_id,
  operation_scope: operationScope,
  operation_id: row.operation_id,
  membership_id: row.membership_id,
  identity_id: row.identity_id,
  account_id: row.account_id,
  conversation_id: row.conversation_id,
  connection_id: row.connection_id,
  session_generation: row.session_generation,
  grant_id: row.grant_id,
  capability:
    row.capability_kind === "account_grant"
      ? {
          kind: "account_grant",
          grant_id: row.capability_id,
          authorization_epoch: row.capability_epoch,
        }
      : {
          kind: "owner_admin",
          authority_id: row.capability_id,
          authority_epoch: row.capability_epoch,
        },
  reservation_id: row.reservation_id,
  request_hash: row.request_hash,
  status: claimStatus(row.status),
  uncertain_reason: row.uncertain_reason,
  expires_at: row.expires_at,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const sameReservationInput = (
  row: ReservationRow,
  input: PrivateAuthorityReservationInput,
): boolean =>
  row.tenant_id === input.tenant_id &&
  row.operation_id === input.operation_id &&
  row.membership_id === input.membership_id &&
  row.identity_id === input.identity_id &&
  row.account_id === input.account_id &&
  row.conversation_id === input.conversation_id &&
  row.connection_id === input.connection_id &&
  row.session_generation === input.session_generation &&
  row.request_hash === input.request_hash &&
  row.capability_kind === input.capability.kind &&
  row.capability_id ===
    (input.capability.kind === "account_grant"
      ? input.capability.grant_id
      : input.capability.authority_id) &&
  row.capability_epoch ===
    (input.capability.kind === "account_grant"
      ? input.capability.authorization_epoch
      : input.capability.authority_epoch);

const sameClaimInput = (
  row: ClaimRow,
  input: PrivateAuthorityClaimInput,
): boolean =>
  sameReservationInput(row, {
    ...input,
    reservation_id: input.reservation_id,
    now: input.now,
  }) && row.reservation_id === input.reservation_id;

const operationBindings = (input: {
  tenant_id: string;
  operation_id: string;
  membership_id: string;
  identity_id: string;
  account_id: string;
  connection_id: string;
  conversation_id: string;
  request_hash: string;
  session_generation: string;
}): string[] => [
  input.tenant_id,
  input.operation_id,
  input.membership_id,
  input.identity_id,
  input.account_id,
  input.connection_id,
  input.conversation_id,
  input.request_hash,
  input.session_generation,
];

const baseBindings = (
  input: OutboundTuple,
  capability: OutboundCapability,
): unknown[] => {
  const columns = capabilityColumns(capability);
  return [
    input.identity_id,
    input.account_id,
    input.connection_id,
    input.tenant_id,
    input.membership_id,
    columns.kind,
    columns.id,
    columns.epoch,
    input.conversation_id,
    columns.kind,
    columns.id,
    columns.epoch,
  ];
};

const reservationColumns = `
  id, tenant_id, operation_id, membership_id, identity_id, account_id,
  conversation_id, connection_id, grant_id, capability_kind, capability_id,
  capability_epoch, authority_id, request_hash, status, uncertain_reason,
  session_generation, created_at, updated_at`;

const claimColumns = `
  id, tenant_id, reservation_id, operation_id, membership_id, identity_id,
  account_id, conversation_id, connection_id, grant_id, capability_kind,
  capability_id, capability_epoch, authority_id, request_hash, status,
  uncertain_reason, session_generation, expires_at, created_at, updated_at`;

const validReservationInput = (
  input: PrivateAuthorityReservationInput,
): boolean =>
  validTuple(input) &&
  validCapability(input.capability) &&
  isNonEmpty(input.operation_id) &&
  isDigest(input.request_hash) &&
  Number.isFinite(Date.parse(input.session_generation)) &&
  isNonEmpty(input.now);

/** Read the operation's saved reservation for crash recovery. */
export async function readPrivateAuthorityReservation(
  database: AuthorityDatabase,
  operationScope: PrivateAuthorityScope,
  tenantId: string,
  operationId: string,
): Promise<PrivateAuthorityReservation | null> {
  const table = intentTable(operationScope);
  const operationKind = usesOperationKind(operationScope);
  const row = await database
    .prepare(
      `SELECT ${reservationColumns}
         FROM ${table}
        WHERE tenant_id = ? AND operation_id = ?${
          operationKind ? " AND operation_kind = ?" : ""
        }
        LIMIT 1`,
    )
    .bind(tenantId, operationId, ...(operationKind ? [operationScope] : []))
    .first<ReservationRow>();
  return row === null ? null : mapReservation(row, operationScope);
}

/** Reserve a receipt/group operation at the durable operation boundary. */
export async function reservePrivateAuthority(
  database: AuthorityDatabase,
  input: PrivateAuthorityReservationInput,
): Promise<PrivateAuthorityReservationResult> {
  if (!validReservationInput(input))
    return { status: "denied", reason: "invalid_input" };
  const id =
    input.reservation_id ??
    `op_accept_${crypto.randomUUID().replaceAll("-", "")}`;
  const columns = capabilityColumns(input.capability);
  const table = intentTable(input.operation_scope);
  const operationSql = operationPredicate(input.operation_scope, "op");
  const operationKind = usesOperationKind(input.operation_scope);
  const insert = database
    .prepare(`
      INSERT INTO ${table} (
        id, tenant_id, ${operationKind ? "operation_kind, " : ""}operation_id, membership_id, identity_id, account_id,
        conversation_id, connection_id, session_generation, grant_id, capability_kind,
        capability_id, capability_epoch, authority_id, request_hash, status,
        uncertain_reason, created_at, updated_at
      )
      SELECT ?, ?, ${operationKind ? "?, " : ""}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'committed', NULL, ?, ?
      FROM memberships AS m
      JOIN tenants AS t ON t.id = m.tenant_id
      JOIN principals AS p ON p.id = m.principal_id
      JOIN identities AS i ON i.tenant_id = m.tenant_id AND i.id = ?
      JOIN connection_accounts AS ca ON ca.account_id = ? AND ca.status = 'active'
      JOIN connections AS c
        ON c.tenant_id = m.tenant_id AND c.id = ca.connection_id AND c.id = ?
       AND c.updated_at = ?
      WHERE m.tenant_id = ? AND m.id = ?
        AND t.status = 'active' AND m.status = 'active'
        AND p.status = 'active' AND p.revoked_at IS NULL
        AND i.status = 'active'
        AND ((p.principal_type IN ('human', 'operator') AND i.identity_kind = 'human')
          OR (p.principal_type = 'agent' AND i.identity_kind = 'agent'))
        AND ${operationSql}
        AND ${authorityPredicate(input.operation_scope)}
      ON CONFLICT DO NOTHING
    `)
    .bind(
      id,
      input.tenant_id,
      ...(operationKind ? [input.operation_scope] : []),
      input.operation_id,
      input.membership_id,
      input.identity_id,
      input.account_id,
      input.conversation_id,
      input.connection_id,
      input.session_generation,
      columns.grantId,
      columns.kind,
      columns.id,
      columns.epoch,
      columns.authorityId,
      input.request_hash,
      input.now,
      input.now,
      ...baseBindings(input, input.capability).slice(0, 3),
      input.session_generation,
      input.tenant_id,
      input.membership_id,
      ...operationBindings(input),
      ...baseBindings(input, input.capability).slice(5),
    );
  const selected = database
    .prepare(
      `SELECT ${reservationColumns} FROM ${table} WHERE tenant_id = ? AND operation_id = ?${operationKind ? " AND operation_kind = ?" : ""}`,
    )
    .bind(
      input.tenant_id,
      input.operation_id,
      ...(operationKind ? [input.operation_scope] : []),
    );
  const batchResults = await database.batch<ReservationRow>([insert, selected]);
  const inserted = batchResults[0];
  const selectedResult = batchResults[1];
  if (inserted === undefined || selectedResult === undefined)
    throw new Error("private authority reservation batch incomplete");
  const row = selectedResult.results[0] ?? null;
  if (row === null)
    return { status: "denied", reason: "authorization_revoked" };
  const reservation = mapReservation(row, input.operation_scope);
  if (!sameReservationInput(row, input))
    return { status: "denied", reason: "idempotency_conflict" };
  return {
    status: "reserved",
    replayed: (inserted.meta.changes ?? 0) !== 1,
    reservation,
  };
}

const validClaimInput = (input: PrivateAuthorityClaimInput): boolean =>
  validTuple(input) &&
  validCapability(input.capability) &&
  isNonEmpty(input.operation_id) &&
  isNonEmpty(input.reservation_id) &&
  isDigest(input.request_hash) &&
  Number.isFinite(Date.parse(input.session_generation)) &&
  validWindow(input.now, input.expires_at);

/** Claim the receipt/group provider boundary exactly once. */
export async function claimPrivateAuthority(
  database: AuthorityDatabase,
  input: PrivateAuthorityClaimInput,
): Promise<PrivateAuthorityClaimResult> {
  if (!validClaimInput(input))
    return { status: "denied", reason: "invalid_input" };
  const id =
    input.claim_id ?? `op_claim_${crypto.randomUUID().replaceAll("-", "")}`;
  const columns = capabilityColumns(input.capability);
  const table = claimTable(input.operation_scope);
  const intent = intentTable(input.operation_scope);
  const operationSql = operationPredicate(input.operation_scope, "op");
  const operationKind = usesOperationKind(input.operation_scope);
  const insert = database
    .prepare(`
      INSERT INTO ${table} (
        id, tenant_id, reservation_id, ${operationKind ? "operation_kind, " : ""}
        operation_id, membership_id, identity_id, account_id, conversation_id,
        connection_id, session_generation, grant_id, capability_kind, capability_id,
        capability_epoch, authority_id, request_hash, status, uncertain_reason,
        expires_at, created_at, updated_at
      )
      SELECT ?, ?, ?, ${operationKind ? "?, " : ""}
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', NULL, ?, ?, ?
      FROM ${intent} AS ai
      JOIN memberships AS m ON m.tenant_id = ai.tenant_id AND m.id = ai.membership_id
      JOIN tenants AS t ON t.id = m.tenant_id
      JOIN principals AS p ON p.id = m.principal_id
      JOIN identities AS i ON i.tenant_id = m.tenant_id AND i.id = ai.identity_id
      JOIN connection_accounts AS ca ON ca.account_id = ai.account_id AND ca.status = 'active'
      JOIN connections AS c
        ON c.tenant_id = m.tenant_id
       AND c.id = ca.connection_id
       AND c.updated_at = ai.session_generation
      WHERE ai.tenant_id = ? AND ai.id = ? AND ai.operation_id = ?
        AND ai.status = 'committed'
        ${operationKind ? "AND ai.operation_kind = ?" : ""}
        AND ai.membership_id = ? AND ai.identity_id = ? AND ai.account_id = ?
        AND ai.conversation_id = ? AND ai.connection_id = ?
        AND ai.capability_kind = ? AND ai.capability_id = ?
        AND ai.capability_epoch = ? AND ai.request_hash = ?
        AND ai.session_generation = ?
        AND t.status = 'active' AND m.status = 'active'
        AND p.status = 'active' AND p.revoked_at IS NULL AND i.status = 'active'
        AND c.id = ? AND c.status IN ('connected', 'syncing', 'ready')
        AND ${operationSql}
        AND ${authorityPredicate(input.operation_scope)}
      ON CONFLICT DO NOTHING
    `)
    .bind(
      id,
      input.tenant_id,
      input.reservation_id,
      ...(operationKind ? [input.operation_scope] : []),
      input.operation_id,
      input.membership_id,
      input.identity_id,
      input.account_id,
      input.conversation_id,
      input.connection_id,
      input.session_generation,
      columns.grantId,
      columns.kind,
      columns.id,
      columns.epoch,
      columns.authorityId,
      input.request_hash,
      input.expires_at,
      input.now,
      input.now,
      input.tenant_id,
      input.reservation_id,
      input.operation_id,
      ...(operationKind ? [input.operation_scope] : []),
      input.membership_id,
      input.identity_id,
      input.account_id,
      input.conversation_id,
      input.connection_id,
      columns.kind,
      columns.id,
      columns.epoch,
      input.request_hash,
      input.session_generation,
      input.connection_id,
      ...operationBindings(input),
      ...baseBindings(input, input.capability).slice(5),
    );
  const selected = database
    .prepare(
      `SELECT ${claimColumns} FROM ${table} WHERE tenant_id = ? AND reservation_id = ?`,
    )
    .bind(input.tenant_id, input.reservation_id);
  const batchResults = await database.batch<ClaimRow>([insert, selected]);
  const inserted = batchResults[0];
  const selectedResult = batchResults[1];
  if (inserted === undefined || selectedResult === undefined)
    throw new Error("private authority claim batch incomplete");
  const existing = selectedResult.results[0] ?? null;
  if (existing !== null) {
    const claim = mapClaim(existing, input.operation_scope);
    if (!sameClaimInput(existing, input))
      return { status: "denied", reason: "claim_conflict" };
    if ((inserted.meta.changes ?? 0) === 1) {
      return {
        status: "claimed",
        replayed: false,
        provider_allowed: true,
        claim,
      };
    }
    return {
      status: "replayed",
      replayed: true,
      provider_allowed: false,
      claim,
    };
  }
  const reservation = await database
    .prepare(
      `SELECT ${reservationColumns} FROM ${intent} WHERE tenant_id = ? AND id = ?`,
    )
    .bind(input.tenant_id, input.reservation_id)
    .first<ReservationRow>();
  if (reservation === null)
    return { status: "denied", reason: "reservation_not_found" };
  if (
    !sameReservationInput(
      reservation,
      input as PrivateAuthorityReservationInput,
    )
  )
    return { status: "denied", reason: "tuple_mismatch" };
  if (reservation.status !== "committed")
    return { status: "denied", reason: "reservation_not_committed" };
  return { status: "denied", reason: "authorization_revoked" };
}
