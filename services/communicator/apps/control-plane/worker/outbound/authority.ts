import type {
  ClaimOutboundDispatchInput,
  ClaimOutboundDispatchResult,
  FinalizeOutboundAcceptanceInput,
  FinalizeOutboundAcceptanceResult,
  MarkAcceptanceReservationUncertainInput,
  MarkAcceptanceReservationUncertainResult,
  MarkDispatchClaimUncertainInput,
  MarkDispatchClaimUncertainResult,
  OutboundAcceptanceReservation,
  OutboundAcceptanceReservationResult,
  OutboundCapability,
  OutboundCapabilityTuple,
  OutboundDispatchClaim,
  OutboundTuple,
  ReserveOutboundAcceptanceInput,
} from "./authority-types";

type AuthorityDatabase = D1Database | D1DatabaseSession;

type AcceptanceRow = {
  id: string;
  tenant_id: string;
  membership_id: string;
  identity_id: string;
  account_id: string;
  conversation_id: string;
  connection_id: string;
  grant_id: string | null;
  capability_kind: string;
  capability_id: string;
  capability_epoch: number;
  authority_id: string | null;
  idempotency_key: string;
  request_digest: string;
  body_digest: string;
  status: string;
  command_id: string | null;
  message_id: string | null;
  dispatch_id: string | null;
  transaction_id: string | null;
  uncertain_reason: string | null;
  created_at: string;
  updated_at: string;
};

type ClaimRow = {
  id: string;
  tenant_id: string;
  reservation_id: string;
  membership_id: string;
  identity_id: string;
  account_id: string;
  conversation_id: string;
  connection_id: string;
  grant_id: string | null;
  capability_kind: string;
  capability_id: string;
  capability_epoch: number;
  authority_id: string | null;
  command_id: string;
  dispatch_id: string;
  transaction_id: string;
  request_digest: string;
  body_digest: string;
  status: string;
  uncertain_reason: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

const batchResult = <T>(results: D1Result<T>[], index: number): D1Result<T> => {
  const result = results[index];
  if (result === undefined)
    throw new Error("outbound authority batch incomplete");
  return result;
};

const ACCEPTANCE_COLUMNS = `
  id, tenant_id, membership_id, identity_id, account_id, conversation_id,
  connection_id, grant_id, capability_kind, capability_id, capability_epoch,
  authority_id, idempotency_key, request_digest, body_digest, status,
  command_id, message_id, dispatch_id, transaction_id, uncertain_reason,
  created_at, updated_at`;

const CLAIM_COLUMNS = `
  id, tenant_id, reservation_id, membership_id, identity_id, account_id,
  conversation_id, connection_id, grant_id, capability_kind, capability_id,
  capability_epoch, authority_id, command_id, dispatch_id, transaction_id,
  request_digest, body_digest, status, uncertain_reason, expires_at,
  created_at, updated_at`;

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

const isPositiveEpoch = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 1;

const capabilityColumns = (
  capability: OutboundCapability,
): {
  capability_kind: OutboundCapability["kind"];
  capability_id: string;
  capability_epoch: number;
  grant_id: string | null;
  authority_id: string | null;
} => {
  if (capability.kind === "account_grant") {
    return {
      capability_kind: capability.kind,
      capability_id: capability.grant_id,
      capability_epoch: capability.authorization_epoch,
      grant_id: capability.grant_id,
      authority_id: null,
    };
  }
  return {
    capability_kind: capability.kind,
    capability_id: capability.authority_id,
    capability_epoch: capability.authority_epoch,
    grant_id: null,
    authority_id: capability.authority_id,
  };
};

const tupleWithCapability = (
  input: OutboundTuple,
  capability: OutboundCapability,
): OutboundCapabilityTuple => ({
  ...input,
  grant_id: capability.kind === "account_grant" ? capability.grant_id : null,
  capability,
});

const validTuple = (tuple: OutboundTuple): boolean =>
  NON_EMPTY_FIELDS.every((field) => isNonEmpty(tuple[field]));

const validCapability = (capability: OutboundCapability): boolean => {
  if (
    !isNonEmpty(
      capability.kind === "account_grant"
        ? capability.grant_id
        : capability.authority_id,
    )
  ) {
    return false;
  }
  return isPositiveEpoch(
    capability.kind === "account_grant"
      ? capability.authorization_epoch
      : capability.authority_epoch,
  );
};

const validDigests = (requestDigest: string, bodyDigest: string): boolean =>
  isDigest(requestDigest) && isDigest(bodyDigest);

const validWindow = (now: string, expiresAt: string): boolean => {
  const nowMs = Date.parse(now);
  const expiresMs = Date.parse(expiresAt);
  return (
    Number.isFinite(nowMs) && Number.isFinite(expiresMs) && expiresMs > nowMs
  );
};

const capabilityFromRow = (
  kind: string,
  capabilityId: string,
  epoch: number,
): OutboundCapability => {
  if (kind === "account_grant") {
    return {
      kind,
      grant_id: capabilityId,
      authorization_epoch: epoch,
    };
  }
  if (kind === "owner_admin") {
    return {
      kind,
      authority_id: capabilityId,
      authority_epoch: epoch,
    };
  }
  throw new Error("outbound authority capability kind is invalid");
};

const acceptanceStatus = (
  status: string,
): OutboundAcceptanceReservation["status"] => {
  if (
    status === "reserved" ||
    status === "committed" ||
    status === "uncertain"
  ) {
    return status;
  }
  throw new Error("outbound acceptance status is invalid");
};

const claimStatus = (status: string): OutboundDispatchClaim["status"] => {
  if (status === "claimed" || status === "uncertain") return status;
  throw new Error("outbound dispatch claim status is invalid");
};

const acceptanceFromRow = (
  row: AcceptanceRow,
): OutboundAcceptanceReservation => ({
  id: row.id,
  tenant_id: row.tenant_id,
  membership_id: row.membership_id,
  identity_id: row.identity_id,
  account_id: row.account_id,
  conversation_id: row.conversation_id,
  connection_id: row.connection_id,
  grant_id: row.grant_id,
  capability: capabilityFromRow(
    row.capability_kind,
    row.capability_id,
    row.capability_epoch,
  ),
  idempotency_key: row.idempotency_key,
  request_digest: row.request_digest,
  body_digest: row.body_digest,
  status: acceptanceStatus(row.status),
  command_id: row.command_id,
  message_id: row.message_id,
  dispatch_id: row.dispatch_id,
  transaction_id: row.transaction_id,
  uncertain_reason: row.uncertain_reason,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const claimFromRow = (row: ClaimRow): OutboundDispatchClaim => ({
  id: row.id,
  tenant_id: row.tenant_id,
  reservation_id: row.reservation_id,
  membership_id: row.membership_id,
  identity_id: row.identity_id,
  account_id: row.account_id,
  conversation_id: row.conversation_id,
  connection_id: row.connection_id,
  grant_id: row.grant_id,
  capability: capabilityFromRow(
    row.capability_kind,
    row.capability_id,
    row.capability_epoch,
  ),
  command_id: row.command_id,
  dispatch_id: row.dispatch_id,
  transaction_id: row.transaction_id,
  request_digest: row.request_digest,
  body_digest: row.body_digest,
  status: claimStatus(row.status),
  uncertain_reason: row.uncertain_reason,
  expires_at: row.expires_at,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const sameCapability = (
  row: {
    capability_kind: string;
    capability_id: string;
    capability_epoch: number;
  },
  capability: OutboundCapability,
): boolean => {
  const columns = capabilityColumns(capability);
  return (
    row.capability_kind === columns.capability_kind &&
    row.capability_id === columns.capability_id &&
    row.capability_epoch === columns.capability_epoch
  );
};

const sameTuple = (
  row: {
    tenant_id: string;
    membership_id: string;
    identity_id: string;
    account_id: string;
    conversation_id: string;
    connection_id: string;
    grant_id: string | null;
    capability_kind: string;
    capability_id: string;
    capability_epoch: number;
  },
  tuple: OutboundCapabilityTuple,
): boolean =>
  row.tenant_id === tuple.tenant_id &&
  row.membership_id === tuple.membership_id &&
  row.identity_id === tuple.identity_id &&
  row.account_id === tuple.account_id &&
  row.conversation_id === tuple.conversation_id &&
  row.connection_id === tuple.connection_id &&
  row.grant_id === tuple.grant_id &&
  sameCapability(row, tuple.capability);

const acceptanceSelect = (
  database: AuthorityDatabase,
  tenantId: string,
  reservationId: string,
) =>
  database
    .prepare(
      `SELECT ${ACCEPTANCE_COLUMNS}
       FROM outbound_acceptance_intents
       WHERE tenant_id = ? AND id = ?`,
    )
    .bind(tenantId, reservationId);

const acceptanceByIdempotencySelect = (
  database: AuthorityDatabase,
  tenantId: string,
  idempotencyKey: string,
) =>
  database
    .prepare(
      `SELECT ${ACCEPTANCE_COLUMNS}
       FROM outbound_acceptance_intents
       WHERE tenant_id = ? AND idempotency_key = ?`,
    )
    .bind(tenantId, idempotencyKey);

const claimSelect = (
  database: AuthorityDatabase,
  tenantId: string,
  reservationId: string,
) =>
  database
    .prepare(
      `SELECT ${CLAIM_COLUMNS}
       FROM outbound_dispatch_claims
       WHERE tenant_id = ? AND reservation_id = ?`,
    )
    .bind(tenantId, reservationId);

const validReserveInput = (input: ReserveOutboundAcceptanceInput): boolean =>
  validTuple(input) &&
  validCapability(input.capability) &&
  isNonEmpty(input.idempotency_key) &&
  validDigests(input.request_digest, input.body_digest) &&
  isNonEmpty(input.now);

/**
 * Reserve the acceptance LP.  The INSERT ... SELECT is deliberately the
 * authority check and write in one D1 batch; a grant or membership mutation
 * committed before this transaction makes the INSERT affect zero rows.
 */
export async function reserveOutboundAcceptance(
  database: AuthorityDatabase,
  input: ReserveOutboundAcceptanceInput,
): Promise<OutboundAcceptanceReservationResult> {
  if (!validReserveInput(input)) {
    return { status: "denied", reason: "invalid_input" };
  }

  const reservationId =
    input.reservation_id ?? `accept_${crypto.randomUUID().replaceAll("-", "")}`;
  const tuple = tupleWithCapability(input, input.capability);
  const columns = capabilityColumns(input.capability);
  const insert = database
    .prepare(
      `INSERT INTO outbound_acceptance_intents (
         id, tenant_id, membership_id, identity_id, account_id,
         conversation_id, connection_id, grant_id, capability_kind,
         capability_id, capability_epoch, authority_id, idempotency_key,
         request_digest, body_digest, status, command_id, message_id,
         dispatch_id, transaction_id, uncertain_reason, created_at, updated_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved',
              NULL, NULL, NULL, NULL, NULL, ?, ?
       FROM memberships AS m
       JOIN tenants AS t ON t.id = m.tenant_id
       JOIN principals AS p ON p.id = m.principal_id
       JOIN identities AS i
         ON i.tenant_id = m.tenant_id AND i.id = ?
       JOIN connection_accounts AS ca
         ON ca.account_id = ? AND ca.status = 'active'
       JOIN connections AS c
         ON c.tenant_id = m.tenant_id
        AND c.id = ca.connection_id
        AND c.id = ?
       WHERE m.tenant_id = ?
         AND m.id = ?
         AND t.status = 'active'
         AND m.status = 'active'
         AND p.status = 'active'
         AND p.revoked_at IS NULL
         AND i.status = 'active'
         AND (
           (p.principal_type IN ('human', 'operator') AND i.identity_kind = 'human')
           OR (p.principal_type IN ('agent', 'service') AND i.identity_kind = 'agent')
         )
         AND (
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
                 AND g.operation_scope = 'message.send'
                 AND g.status = 'active'
                 AND g.authorization_epoch = ?
                 AND (
                   g.chat_scope = 'all_chats'
                   OR EXISTS (
                     SELECT 1
                     FROM account_grant_chats AS gc
                     WHERE gc.tenant_id = g.tenant_id
                       AND gc.grant_id = g.id
                       AND gc.account_id = g.account_id
                       AND gc.chat_id = ?
                   )
                 )
                 AND EXISTS (
                   SELECT 1
                   FROM identity_grants AS ig
                   WHERE ig.tenant_id = g.tenant_id
                     AND ig.membership_id = g.membership_id
                     AND ig.identity_id = g.identity_id
                     AND ig.operation_scope = 'message.send'
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
         )
       ON CONFLICT DO NOTHING`,
    )
    .bind(
      reservationId,
      input.tenant_id,
      input.membership_id,
      input.identity_id,
      input.account_id,
      input.conversation_id,
      input.connection_id,
      columns.grant_id,
      columns.capability_kind,
      columns.capability_id,
      columns.capability_epoch,
      columns.authority_id,
      input.idempotency_key,
      input.request_digest,
      input.body_digest,
      input.now,
      input.now,
      input.identity_id,
      input.account_id,
      input.connection_id,
      input.tenant_id,
      input.membership_id,
      columns.capability_kind,
      columns.grant_id,
      columns.capability_epoch,
      input.conversation_id,
      columns.capability_kind,
      columns.authority_id,
      columns.capability_epoch,
    );
  const selected = database
    .prepare(
      `SELECT ${ACCEPTANCE_COLUMNS}
       FROM outbound_acceptance_intents
       WHERE tenant_id = ? AND idempotency_key = ?`,
    )
    .bind(input.tenant_id, input.idempotency_key);

  const batchResults = await database.batch<AcceptanceRow>([insert, selected]);
  const inserted = batchResult(batchResults, 0);
  const selectedResult = batchResult(batchResults, 1);
  const row = selectedResult.results[0] ?? null;
  if (row === null)
    return { status: "denied", reason: "authorization_revoked" };

  const reservation = acceptanceFromRow(row);
  if (
    !sameTuple(row, tuple) ||
    row.idempotency_key !== input.idempotency_key ||
    row.request_digest !== input.request_digest ||
    row.body_digest !== input.body_digest
  ) {
    return { status: "denied", reason: "idempotency_conflict" };
  }
  return {
    status: "reserved",
    replayed: (inserted.meta.changes ?? 0) !== 1,
    reservation,
  };
}

const validFinalizeInput = (input: FinalizeOutboundAcceptanceInput): boolean =>
  validTuple(input) &&
  validCapability(input.capability) &&
  input.grant_id ===
    (input.capability.kind === "account_grant"
      ? input.capability.grant_id
      : null) &&
  isNonEmpty(input.reservation_id) &&
  isNonEmpty(input.idempotency_key) &&
  validDigests(input.request_digest, input.body_digest) &&
  isNonEmpty(input.command_id) &&
  isNonEmpty(input.message_id) &&
  isNonEmpty(input.dispatch_id) &&
  isNonEmpty(input.transaction_id) &&
  isNonEmpty(input.now);

/** Finalize a reservation after the Durable Object triple commits. */
export async function finalizeOutboundAcceptance(
  database: AuthorityDatabase,
  input: FinalizeOutboundAcceptanceInput,
): Promise<FinalizeOutboundAcceptanceResult> {
  if (!validFinalizeInput(input)) {
    return { status: "denied", reason: "invalid_input" };
  }
  const tuple = tupleWithCapability(input, input.capability);
  const columns = capabilityColumns(input.capability);
  const update = database
    .prepare(
      `UPDATE outbound_acceptance_intents
       SET status = 'committed', command_id = ?, message_id = ?,
           dispatch_id = ?, transaction_id = ?, uncertain_reason = NULL,
           updated_at = ?
       WHERE tenant_id = ?
         AND id = ?
         AND status = 'reserved'
         AND membership_id = ?
         AND identity_id = ?
         AND account_id = ?
         AND conversation_id = ?
         AND connection_id = ?
         AND grant_id IS ?
         AND capability_kind = ?
         AND capability_id = ?
         AND capability_epoch = ?
         AND authority_id IS ?
         AND idempotency_key = ?
         AND request_digest = ?
         AND body_digest = ?`,
    )
    .bind(
      input.command_id,
      input.message_id,
      input.dispatch_id,
      input.transaction_id,
      input.now,
      input.tenant_id,
      input.reservation_id,
      input.membership_id,
      input.identity_id,
      input.account_id,
      input.conversation_id,
      input.connection_id,
      columns.grant_id,
      columns.capability_kind,
      columns.capability_id,
      columns.capability_epoch,
      columns.authority_id,
      input.idempotency_key,
      input.request_digest,
      input.body_digest,
    );
  const selected = acceptanceSelect(
    database,
    input.tenant_id,
    input.reservation_id,
  );
  const batchResults = await database.batch<AcceptanceRow>([update, selected]);
  const updated = batchResult(batchResults, 0);
  const selectedResult = batchResult(batchResults, 1);
  const row = selectedResult.results[0] ?? null;
  if (row === null) {
    return { status: "denied", reason: "reservation_not_found" };
  }
  if (
    !sameTuple(row, tuple) ||
    row.idempotency_key !== input.idempotency_key ||
    row.request_digest !== input.request_digest ||
    row.body_digest !== input.body_digest
  ) {
    return { status: "denied", reason: "tuple_mismatch" };
  }
  const reservation = acceptanceFromRow(row);
  if (reservation.status === "committed") {
    if (
      reservation.command_id !== input.command_id ||
      reservation.message_id !== input.message_id ||
      reservation.dispatch_id !== input.dispatch_id ||
      reservation.transaction_id !== input.transaction_id
    ) {
      return { status: "denied", reason: "tuple_mismatch" };
    }
    return { status: "committed", replayed: true, reservation };
  }
  if (reservation.status !== "reserved") {
    return { status: "denied", reason: "reservation_not_reserved" };
  }
  if ((updated.meta.changes ?? 0) !== 1) {
    return { status: "denied", reason: "reservation_not_reserved" };
  }
  const committed = await database
    .prepare(
      `SELECT ${ACCEPTANCE_COLUMNS}
       FROM outbound_acceptance_intents
       WHERE tenant_id = ? AND id = ?`,
    )
    .bind(input.tenant_id, input.reservation_id)
    .first<AcceptanceRow>();
  if (committed === null) {
    return { status: "denied", reason: "reservation_not_found" };
  }
  return {
    status: "committed",
    replayed: false,
    reservation: acceptanceFromRow(committed),
  };
}

const validUncertainReservationInput = (
  input: MarkAcceptanceReservationUncertainInput,
): boolean =>
  isNonEmpty(input.tenant_id) &&
  isNonEmpty(input.reservation_id) &&
  isNonEmpty(input.reason) &&
  isNonEmpty(input.now);

/** Keep a reservation visible when the process outcome is unknown. */
export async function markOutboundAcceptanceUncertain(
  database: AuthorityDatabase,
  input: MarkAcceptanceReservationUncertainInput,
): Promise<MarkAcceptanceReservationUncertainResult> {
  if (!validUncertainReservationInput(input)) {
    return { status: "denied", reason: "invalid_input" };
  }
  const update = database
    .prepare(
      `UPDATE outbound_acceptance_intents
       SET status = 'uncertain', uncertain_reason = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND status = 'reserved'`,
    )
    .bind(input.reason, input.now, input.tenant_id, input.reservation_id);
  const selected = acceptanceSelect(
    database,
    input.tenant_id,
    input.reservation_id,
  );
  const batchResults = await database.batch<AcceptanceRow>([update, selected]);
  const updated = batchResult(batchResults, 0);
  const selectedResult = batchResult(batchResults, 1);
  const row = selectedResult.results[0] ?? null;
  if (row === null) {
    return { status: "denied", reason: "reservation_not_found" };
  }
  const reservation = acceptanceFromRow(row);
  if (reservation.status === "uncertain") {
    return { status: "uncertain", replayed: true, reservation };
  }
  if ((updated.meta.changes ?? 0) !== 1) {
    return { status: "denied", reason: "reservation_already_uncertain" };
  }
  const uncertain = await acceptanceSelect(
    database,
    input.tenant_id,
    input.reservation_id,
  ).first<AcceptanceRow>();
  if (uncertain === null) {
    return { status: "denied", reason: "reservation_not_found" };
  }
  return {
    status: "uncertain",
    replayed: false,
    reservation: acceptanceFromRow(uncertain),
  };
}

const validClaimInput = (input: ClaimOutboundDispatchInput): boolean =>
  validTuple(input) &&
  validCapability(input.capability) &&
  input.grant_id ===
    (input.capability.kind === "account_grant"
      ? input.capability.grant_id
      : null) &&
  isNonEmpty(input.reservation_id) &&
  isNonEmpty(input.command_id) &&
  isNonEmpty(input.dispatch_id) &&
  isNonEmpty(input.transaction_id) &&
  validDigests(input.request_digest, input.body_digest) &&
  validWindow(input.now, input.expires_at);

const sameClaimInput = (
  row: ClaimRow,
  input: ClaimOutboundDispatchInput,
): boolean => {
  const tuple = tupleWithCapability(input, input.capability);
  return (
    sameTuple(row, tuple) &&
    row.tenant_id === input.tenant_id &&
    row.reservation_id === input.reservation_id &&
    row.command_id === input.command_id &&
    row.dispatch_id === input.dispatch_id &&
    row.transaction_id === input.transaction_id &&
    row.request_digest === input.request_digest &&
    row.body_digest === input.body_digest
  );
};

/**
 * Claim the provider boundary exactly once.  A current grant/authority epoch
 * is checked in the same conditional INSERT that records the claim.  The
 * resulting row is the only result that permits a provider call.
 */
export async function claimOutboundDispatch(
  database: AuthorityDatabase,
  input: ClaimOutboundDispatchInput,
): Promise<ClaimOutboundDispatchResult> {
  if (!validClaimInput(input)) {
    return { status: "denied", reason: "invalid_input" };
  }
  const claimId =
    input.claim_id ?? `claim_${crypto.randomUUID().replaceAll("-", "")}`;
  const tuple = tupleWithCapability(input, input.capability);
  const columns = capabilityColumns(input.capability);
  const insert = database
    .prepare(
      `INSERT INTO outbound_dispatch_claims (
         id, tenant_id, reservation_id, membership_id, identity_id, account_id,
         conversation_id, connection_id, grant_id, capability_kind,
         capability_id, capability_epoch, authority_id, command_id,
         dispatch_id, transaction_id, request_digest, body_digest, status,
         uncertain_reason, expires_at, created_at, updated_at
       )
       SELECT ?, a.tenant_id, a.id, a.membership_id, a.identity_id,
              a.account_id, a.conversation_id, a.connection_id, a.grant_id,
              a.capability_kind, a.capability_id, a.capability_epoch,
              a.authority_id, a.command_id, a.dispatch_id, a.transaction_id,
              a.request_digest, a.body_digest, 'claimed', NULL, ?, ?, ?
       FROM outbound_acceptance_intents AS a
       JOIN tenants AS t ON t.id = a.tenant_id
       JOIN memberships AS m
         ON m.tenant_id = a.tenant_id AND m.id = a.membership_id
       JOIN principals AS p ON p.id = m.principal_id
       JOIN identities AS i
         ON i.tenant_id = a.tenant_id AND i.id = a.identity_id
       JOIN connection_accounts AS ca
         ON ca.account_id = a.account_id AND ca.status = 'active'
       JOIN connections AS c
         ON c.tenant_id = a.tenant_id
        AND c.id = ca.connection_id
        AND c.id = a.connection_id
        AND c.status IN ('connected', 'syncing', 'ready')
       WHERE a.tenant_id = ?
         AND a.id = ?
         AND t.status = 'active'
         AND a.status = 'committed'
         AND a.membership_id = ?
         AND a.identity_id = ?
         AND a.account_id = ?
         AND a.conversation_id = ?
         AND a.connection_id = ?
         AND a.grant_id IS ?
         AND a.capability_kind = ?
         AND a.capability_id = ?
         AND a.capability_epoch = ?
         AND a.authority_id IS ?
         AND a.command_id = ?
         AND a.dispatch_id = ?
         AND a.transaction_id = ?
         AND a.request_digest = ?
         AND a.body_digest = ?
         AND m.status = 'active'
         AND p.status = 'active'
         AND p.revoked_at IS NULL
         AND i.status = 'active'
         AND (
           (p.principal_type IN ('human', 'operator') AND i.identity_kind = 'human')
           OR (p.principal_type IN ('agent', 'service') AND i.identity_kind = 'agent')
         )
         AND (
           (
             a.capability_kind = 'account_grant'
             AND EXISTS (
               SELECT 1
               FROM account_grants AS g
               WHERE g.tenant_id = a.tenant_id
                 AND g.id = a.grant_id
                 AND g.membership_id = a.membership_id
                 AND g.identity_id = a.identity_id
                 AND g.account_id = a.account_id
                 AND g.operation_scope = 'message.send'
                 AND g.status = 'active'
                 AND g.authorization_epoch = a.capability_epoch
                 AND (
                   g.chat_scope = 'all_chats'
                   OR EXISTS (
                     SELECT 1
                     FROM account_grant_chats AS gc
                     WHERE gc.tenant_id = g.tenant_id
                       AND gc.grant_id = g.id
                       AND gc.account_id = g.account_id
                       AND gc.chat_id = a.conversation_id
                   )
                 )
                 AND EXISTS (
                   SELECT 1
                   FROM identity_grants AS ig
                   WHERE ig.tenant_id = g.tenant_id
                     AND ig.membership_id = g.membership_id
                     AND ig.identity_id = g.identity_id
                     AND ig.operation_scope = 'message.send'
                 )
             )
           )
           OR (
             a.capability_kind = 'owner_admin'
             AND a.authority_id = m.id
             AND m.authority_epoch = a.capability_epoch
             AND m.role IN ('owner', 'admin')
             AND p.principal_type IN ('human', 'operator')
             AND i.identity_kind = 'human'
             AND c.identity_id = a.identity_id
           )
         )
       ON CONFLICT DO NOTHING`,
    )
    .bind(
      claimId,
      input.expires_at,
      input.now,
      input.now,
      input.tenant_id,
      input.reservation_id,
      input.membership_id,
      input.identity_id,
      input.account_id,
      input.conversation_id,
      input.connection_id,
      columns.grant_id,
      columns.capability_kind,
      columns.capability_id,
      columns.capability_epoch,
      columns.authority_id,
      input.command_id,
      input.dispatch_id,
      input.transaction_id,
      input.request_digest,
      input.body_digest,
    );
  const byReservation = claimSelect(
    database,
    input.tenant_id,
    input.reservation_id,
  );
  const byTransaction = database
    .prepare(
      `SELECT ${CLAIM_COLUMNS}
       FROM outbound_dispatch_claims
       WHERE tenant_id = ? AND transaction_id = ?`,
    )
    .bind(input.tenant_id, input.transaction_id);
  const byId = database
    .prepare(
      `SELECT ${CLAIM_COLUMNS}
       FROM outbound_dispatch_claims
       WHERE tenant_id = ? AND id = ?`,
    )
    .bind(input.tenant_id, claimId);
  const batchResults = await database.batch<ClaimRow>([
    insert,
    byReservation,
    byTransaction,
    byId,
  ]);
  const inserted = batchResult(batchResults, 0);
  const reservationResult = batchResult(batchResults, 1);
  const transactionResult = batchResult(batchResults, 2);
  const idResult = batchResult(batchResults, 3);
  const row =
    reservationResult.results[0] ??
    transactionResult.results[0] ??
    idResult.results[0] ??
    null;

  if (row !== null) {
    const claim = claimFromRow(row);
    if (!sameClaimInput(row, input)) {
      return {
        status: "denied",
        reason:
          row.reservation_id === input.reservation_id
            ? "tuple_mismatch"
            : "claim_conflict",
      };
    }
    if ((inserted.meta.changes ?? 0) !== 1) {
      return {
        status: "replayed",
        replayed: true,
        provider_allowed: false,
        claim,
      };
    }
    return {
      status: "claimed",
      replayed: false,
      provider_allowed: true,
      claim,
    };
  }

  const reservation = await acceptanceSelect(
    database,
    input.tenant_id,
    input.reservation_id,
  ).first<AcceptanceRow>();
  if (reservation === null) {
    return { status: "denied", reason: "reservation_not_found" };
  }
  if (!sameTuple(reservation, tuple)) {
    return { status: "denied", reason: "tuple_mismatch" };
  }
  if (acceptanceStatus(reservation.status) !== "committed") {
    return { status: "denied", reason: "reservation_not_committed" };
  }
  return { status: "denied", reason: "authorization_revoked" };
}

const validMarkClaimInput = (input: MarkDispatchClaimUncertainInput): boolean =>
  isNonEmpty(input.tenant_id) &&
  isNonEmpty(input.claim_id) &&
  isNonEmpty(input.reason) &&
  isNonEmpty(input.now);

/** Once a claim may have reached the provider, make retries no-send. */
export async function markOutboundDispatchClaimUncertain(
  database: AuthorityDatabase,
  input: MarkDispatchClaimUncertainInput,
): Promise<MarkDispatchClaimUncertainResult> {
  if (!validMarkClaimInput(input)) {
    return { status: "denied", reason: "invalid_input" };
  }
  const update = database
    .prepare(
      `UPDATE outbound_dispatch_claims
       SET status = 'uncertain', uncertain_reason = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND status = 'claimed'`,
    )
    .bind(input.reason, input.now, input.tenant_id, input.claim_id);
  const selected = database
    .prepare(
      `SELECT ${CLAIM_COLUMNS}
       FROM outbound_dispatch_claims
       WHERE tenant_id = ? AND id = ?`,
    )
    .bind(input.tenant_id, input.claim_id);
  const batchResults = await database.batch<ClaimRow>([update, selected]);
  const updated = batchResult(batchResults, 0);
  const selectedResult = batchResult(batchResults, 1);
  const row = selectedResult.results[0] ?? null;
  if (row === null) return { status: "denied", reason: "claim_not_found" };
  const claim = claimFromRow(row);
  if (claim.status === "uncertain") {
    return { status: "uncertain", replayed: true, claim };
  }
  if ((updated.meta.changes ?? 0) !== 1) {
    return { status: "denied", reason: "claim_already_uncertain" };
  }
  const uncertain = await database
    .prepare(
      `SELECT ${CLAIM_COLUMNS}
       FROM outbound_dispatch_claims
       WHERE tenant_id = ? AND id = ?`,
    )
    .bind(input.tenant_id, input.claim_id)
    .first<ClaimRow>();
  if (uncertain === null)
    return { status: "denied", reason: "claim_not_found" };
  return {
    status: "uncertain",
    replayed: false,
    claim: claimFromRow(uncertain),
  };
}

/** Read a reservation after a crash without treating the read as authority. */
export async function readOutboundAcceptanceReservation(
  database: AuthorityDatabase,
  tenantId: string,
  reservationId: string,
): Promise<OutboundAcceptanceReservation | null> {
  const row = await acceptanceSelect(
    database,
    tenantId,
    reservationId,
  ).first<AcceptanceRow>();
  return row === null ? null : acceptanceFromRow(row);
}

/** Read an existing reservation before rechecking live authority on replay. */
export async function readOutboundAcceptanceReservationByKey(
  database: AuthorityDatabase,
  tenantId: string,
  idempotencyKey: string,
): Promise<OutboundAcceptanceReservation | null> {
  const row = await acceptanceByIdempotencySelect(
    database,
    tenantId,
    idempotencyKey,
  ).first<AcceptanceRow>();
  return row === null ? null : acceptanceFromRow(row);
}

/** Read a claim for recovery; callers must still use claimOutboundDispatch. */
export async function readOutboundDispatchClaim(
  database: AuthorityDatabase,
  tenantId: string,
  reservationId: string,
): Promise<OutboundDispatchClaim | null> {
  const row = await claimSelect(
    database,
    tenantId,
    reservationId,
  ).first<ClaimRow>();
  return row === null ? null : claimFromRow(row);
}
