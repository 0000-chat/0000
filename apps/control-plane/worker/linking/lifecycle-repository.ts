import {
  ConnectionLifecycleOperationSchema,
  ProviderSchema,
  type ConnectionLifecycleOperation,
  type Provider,
} from "@communicator/contracts";
import type { GatewayRoute } from "./gateway-client";
import {
  commitLinkedAccount,
  LinkingRepositoryError,
  type CommitLinkedAccountResult,
} from "./repository";

type LifecycleDatabase = D1Database;

export type LifecycleConnection = {
  tenant_id: string;
  connection_id: string;
  identity_id: string;
  provider: Provider;
  account_id: string;
  status:
    | "connected"
    | "syncing"
    | "ready"
    | "attention_required"
    | "disconnected"
    | "revoked"
    | "unlinked";
  session_generation: string;
  provider_login_id: string;
  route: GatewayRoute;
};

export type LifecycleOperationRow = ConnectionLifecycleOperation & {
  tenant_id: string;
  identity_id: string;
  session_id: string | null;
  idempotency_key: string;
  provider_login_id: string;
  evidence_json: string;
  completed_at: string | null;
};

export type LifecycleActor = {
  tenant_id: string;
  actor_principal_id: string;
  membership_id: string;
  identity_id: string;
};

export type BeginRelinkInput = LifecycleActor & {
  db: LifecycleDatabase;
  operation_id: string;
  session_id: string;
  connection_id: string;
  provider: Provider;
  idempotency_key: string;
  expected_session_generation?: string;
  occurred_at: string;
};

export type BeginDisconnectInput = LifecycleActor & {
  db: LifecycleDatabase;
  operation_id: string;
  connection_id: string;
  idempotency_key: string;
  expected_session_generation?: string;
  occurred_at: string;
};

export type CompleteRelinkInput = {
  db: LifecycleDatabase;
  operation_id: string;
  session_id: string;
  actor: LifecycleActor;
  provider_identity: {
    user_login_id: string;
    display_label: string;
    route: GatewayRoute;
  };
  identity_hash_secret: string;
  occurred_at: string;
};

export type CompleteDisconnectInput = {
  db: LifecycleDatabase;
  operation_id: string;
  actor: LifecycleActor;
  provider_login_id: string;
  occurred_at: string;
};

export type LifecycleRepositoryErrorCode =
  | "authorization_required"
  | "invalid_lifecycle"
  | "connection_not_found"
  | "stale_generation"
  | "operation_conflict"
  | "provider_identity_mismatch"
  | "reconciliation_required";

const lifecycleMessages: Record<LifecycleRepositoryErrorCode, string> = {
  authorization_required: "Administrator connection management is required",
  invalid_lifecycle: "Invalid connection lifecycle request",
  connection_not_found: "Connection not found",
  stale_generation: "Connection session is stale",
  operation_conflict: "Connection lifecycle operation conflicts with an existing operation",
  provider_identity_mismatch: "Provider identity did not match the selected connection",
  reconciliation_required: "Connection lifecycle requires reconciliation",
};

export class LifecycleRepositoryError extends Error {
  constructor(
    readonly code: LifecycleRepositoryErrorCode,
    cause?: unknown,
  ) {
    super(lifecycleMessages[code]);
    this.name = "LifecycleRepositoryError";
    if (cause !== undefined)
      Object.defineProperty(this, "cause", {
        configurable: false,
        enumerable: false,
        value: cause,
        writable: false,
      });
  }
}

const validId = (value: string, max = 128): boolean =>
  value.length > 0 && value.length <= max && !/[\s\0]/u.test(value);

const normalizeProviderLogin = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!validId(normalized, 512))
    throw new LifecycleRepositoryError("invalid_lifecycle");
  return normalized;
};

const connectionRow = (row: Record<string, unknown>): LifecycleConnection | null => {
  const provider = ProviderSchema.safeParse(row.provider);
  if (
    !provider.success ||
    typeof row.tenant_id !== "string" ||
    typeof row.connection_id !== "string" ||
    typeof row.identity_id !== "string" ||
    typeof row.account_id !== "string" ||
    typeof row.status !== "string" ||
    typeof row.session_generation !== "string" ||
    typeof row.provider_login_id !== "string" ||
    typeof row.gateway_route_id !== "string" ||
    typeof row.bridge_instance_id !== "string" ||
    typeof row.matrix_user_id !== "string" ||
    typeof row.matrix_room_namespace !== "string"
  )
    return null;
  return {
    tenant_id: row.tenant_id,
    connection_id: row.connection_id,
    identity_id: row.identity_id,
    provider: provider.data,
    account_id: row.account_id,
    status: row.status as LifecycleConnection["status"],
    session_generation: row.session_generation,
    provider_login_id: row.provider_login_id,
    route: {
      gateway_route_id: row.gateway_route_id,
      bridge_instance_id: row.bridge_instance_id,
      matrix_user_id: row.matrix_user_id,
      matrix_room_namespace: row.matrix_room_namespace,
    },
  };
};

export async function getLifecycleConnection(
  db: LifecycleDatabase,
  tenantId: string,
  connectionId: string,
): Promise<LifecycleConnection | null> {
  const row = await db
    .prepare(
      `SELECT c.tenant_id, c.id AS connection_id, c.identity_id, c.provider,
              ca.account_id, c.status, c.updated_at AS session_generation,
              pi.provider_login_id,
              cr.gateway_route_id, cr.bridge_instance_id, cr.matrix_user_id,
              cr.matrix_room_namespace
         FROM connections AS c
         JOIN connection_accounts AS ca
           ON ca.connection_id = c.id AND ca.status = 'active'
         JOIN connection_provider_identities AS pi
           ON pi.tenant_id = c.tenant_id AND pi.connection_id = c.id
         JOIN connection_routes AS cr ON cr.connection_id = c.id
        WHERE c.tenant_id = ? AND c.id = ?
        LIMIT 1`,
    )
    .bind(tenantId, connectionId)
    .first<Record<string, unknown>>();
  return row ? connectionRow(row) : null;
}

const administratorExists = async (
  db: LifecycleDatabase,
  actor: LifecycleActor,
): Promise<boolean> => {
  const row = await db
    .prepare(
      `SELECT 1 AS valid
         FROM principals AS p
         JOIN memberships AS m
           ON m.tenant_id = ? AND m.id = ? AND m.principal_id = p.id
         JOIN identities AS i
           ON i.tenant_id = m.tenant_id AND i.id = ?
         JOIN identity_grants AS g
           ON g.tenant_id = m.tenant_id
          AND g.membership_id = m.id
          AND g.identity_id = i.id
          AND g.operation_scope = 'connection.manage'
        WHERE p.id = ?
          AND p.principal_type IN ('human', 'operator')
          AND p.status = 'active'
          AND m.status = 'active'
          AND m.role IN ('owner', 'admin')
          AND i.identity_kind = 'human'
          AND i.status = 'active'
        LIMIT 1`,
    )
    .bind(
      actor.tenant_id,
      actor.membership_id,
      actor.identity_id,
      actor.actor_principal_id,
    )
    .first<{ valid: number }>();
  return row !== null;
};

const operationFromRow = (
  row: Record<string, unknown>,
): LifecycleOperationRow => {
  const operation = ConnectionLifecycleOperationSchema.parse({
    operation_id: row.operation_id,
    kind: row.kind,
    connection_id: row.connection_id,
    provider: row.provider,
    status: row.status,
    session_generation: row.expected_session_generation,
    replacement_connection_id: row.replacement_connection_id ?? null,
    error_code: row.error_code ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
  return {
    ...operation,
    tenant_id: String(row.tenant_id),
    identity_id: String(row.identity_id),
    session_id: row.session_id === null ? null : String(row.session_id),
    idempotency_key: String(row.idempotency_key),
    provider_login_id: String(row.provider_login_id),
    evidence_json: String(row.evidence_json ?? "[]"),
    completed_at: row.completed_at === null ? null : String(row.completed_at),
  };
};

const operationSelect = `
  SELECT operation_id, tenant_id, connection_id, identity_id, provider, kind,
         session_id, idempotency_key, expected_session_generation,
         provider_login_id, status, replacement_connection_id, error_code,
         evidence_json, created_at, updated_at, completed_at
    FROM connection_lifecycle_operations`;

export async function getLifecycleOperation(
  db: LifecycleDatabase,
  tenantId: string,
  operationId: string,
): Promise<LifecycleOperationRow | null> {
  const row = await db
    .prepare(`${operationSelect} WHERE tenant_id = ? AND operation_id = ? LIMIT 1`)
    .bind(tenantId, operationId)
    .first<Record<string, unknown>>();
  return row ? operationFromRow(row) : null;
}

const existingOperation = async (
  db: LifecycleDatabase,
  tenantId: string,
  idempotencyKey: string,
): Promise<LifecycleOperationRow | null> => {
  const row = await db
    .prepare(
      `${operationSelect} WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`,
    )
    .bind(tenantId, idempotencyKey)
    .first<Record<string, unknown>>();
  return row ? operationFromRow(row) : null;
};

const requestHash = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const ensureNextTimestamp = (current: string, requested: string): string => {
  const currentMs = Date.parse(current);
  const requestedMs = Date.parse(requested);
  if (!Number.isSafeInteger(currentMs) || !Number.isSafeInteger(requestedMs))
    throw new LifecycleRepositoryError("invalid_lifecycle");
  return new Date(Math.max(currentMs + 1, requestedMs)).toISOString();
};

const beginOperation = async (
  input: BeginRelinkInput | BeginDisconnectInput,
  connection: LifecycleConnection,
  kind: "relink" | "disconnect",
): Promise<LifecycleOperationRow> => {
  const prior = await existingOperation(input.db, input.tenant_id, input.idempotency_key);
  if (prior) {
    if (
      prior.connection_id !== input.connection_id ||
      prior.kind !== kind ||
      ("provider" in input && prior.provider !== input.provider)
    )
      throw new LifecycleRepositoryError("operation_conflict");
    return prior;
  }
  const expected = input.expected_session_generation ?? connection.session_generation;
  if (expected !== connection.session_generation)
    throw new LifecycleRepositoryError("stale_generation");
  const operationId = input.operation_id;
  if (!validId(operationId) || !validId(input.idempotency_key, 200))
    throw new LifecycleRepositoryError("invalid_lifecycle");
  const payload = JSON.stringify({
    operation_id: operationId,
    kind,
    connection_id: input.connection_id,
    identity_id: connection.identity_id,
    expected_session_generation: expected,
  });
  const hash = await requestHash(payload);
  const mutationKey = `connection_${kind}_${input.idempotency_key}`.slice(0, 200);
  try {
    await input.db.batch([
      input.db
        .prepare(
          `INSERT INTO directory_mutations
             (idempotency_key, tenant_id, actor_principal_id, mutation_type, request_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          mutationKey,
          input.tenant_id,
          input.actor_principal_id,
          `connection.${kind}`,
          hash,
          input.occurred_at,
        ),
      input.db
        .prepare(
          `INSERT INTO connection_lifecycle_operations
             (operation_id, tenant_id, connection_id, identity_id, provider, kind,
              session_id, idempotency_key, expected_session_generation,
              provider_login_id, status, replacement_connection_id, error_code,
              evidence_json, created_at, updated_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, '[]', ?, ?, NULL)`,
        )
        .bind(
          operationId,
          input.tenant_id,
          input.connection_id,
          connection.identity_id,
          connection.provider,
          kind,
          "session_id" in input ? input.session_id : null,
          input.idempotency_key,
          expected,
          connection.provider_login_id,
          input.occurred_at,
          input.occurred_at,
        ),
      ...(kind === "disconnect"
        ? [
            input.db
              .prepare(
                `UPDATE connections
                    SET status = 'disconnected', attention_code = NULL, updated_at = ?
                  WHERE tenant_id = ? AND id = ? AND updated_at = ?
                    AND status NOT IN ('revoked', 'unlinked')`,
              )
              .bind(
                ensureNextTimestamp(connection.session_generation, input.occurred_at),
                input.tenant_id,
                input.connection_id,
                connection.session_generation,
              ),
          ]
        : []),
      input.db
        .prepare(
          `INSERT INTO audit_events
             (id, tenant_id, actor_principal_id, action, target_type, target_id,
              reason, metadata_json, occurred_at)
           VALUES (?, ?, ?, ?, 'connection', ?, NULL, ?, ?)`,
        )
        .bind(
          `audit_${operationId}`,
          input.tenant_id,
          input.actor_principal_id,
          kind === "relink" ? "connection.relink_requested" : "connection.disconnect_requested",
          input.connection_id,
          JSON.stringify({
            operation_id: operationId,
            connection_id: input.connection_id,
            expected_session_generation: expected,
          }),
          input.occurred_at,
        ),
      input.db
        .prepare(
          `INSERT INTO control_event_outbox
             (event_id, tenant_id, event_type, aggregate_type, aggregate_id, payload_json, created_at)
           VALUES (?, ?, ?, 'connection', ?, ?, ?)`,
        )
        .bind(
          `control_${operationId}`,
          input.tenant_id,
          kind === "relink" ? "connection.relink_requested" : "connection.disconnect_requested",
          input.connection_id,
          JSON.stringify({
            operation_id: operationId,
            connection_id: input.connection_id,
            status: kind === "disconnect" ? "disconnected" : "pending",
          }),
          input.occurred_at,
        ),
    ]);
  } catch (error) {
    const replay = await existingOperation(input.db, input.tenant_id, input.idempotency_key);
    if (replay) return replay;
    throw new LifecycleRepositoryError("operation_conflict", error);
  }
  const created = await getLifecycleOperation(input.db, input.tenant_id, operationId);
  if (!created) throw new LifecycleRepositoryError("reconciliation_required");
  return created;
};

export async function beginConnectionRelink(
  input: BeginRelinkInput,
): Promise<{ operation: LifecycleOperationRow; connection: LifecycleConnection }> {
  if (!ProviderSchema.safeParse(input.provider).success)
    throw new LifecycleRepositoryError("invalid_lifecycle");
  if (!(await administratorExists(input.db, input)))
    throw new LifecycleRepositoryError("authorization_required");
  const connection = await getLifecycleConnection(
    input.db,
    input.tenant_id,
    input.connection_id,
  );
  if (!connection) throw new LifecycleRepositoryError("connection_not_found");
  if (connection.identity_id !== input.identity_id || connection.provider !== input.provider)
    throw new LifecycleRepositoryError("invalid_lifecycle");
  if (["revoked", "unlinked"].includes(connection.status))
    throw new LifecycleRepositoryError("invalid_lifecycle");
  return {
    operation: await beginOperation(input, connection, "relink"),
    connection,
  };
}

export async function beginConnectionDisconnect(
  input: BeginDisconnectInput,
): Promise<{ operation: LifecycleOperationRow; connection: LifecycleConnection }> {
  if (!(await administratorExists(input.db, input)))
    throw new LifecycleRepositoryError("authorization_required");
  const connection = await getLifecycleConnection(
    input.db,
    input.tenant_id,
    input.connection_id,
  );
  if (!connection) throw new LifecycleRepositoryError("connection_not_found");
  if (connection.identity_id !== input.identity_id)
    throw new LifecycleRepositoryError("invalid_lifecycle");
  const operation = await beginOperation(input, connection, "disconnect");
  return { operation, connection };
}

export async function markLifecycleProviderPending(
  db: LifecycleDatabase,
  tenantId: string,
  operationId: string,
  occurredAt: string,
): Promise<LifecycleOperationRow> {
  await db
    .prepare(
      `UPDATE connection_lifecycle_operations
          SET status = CASE WHEN status = 'pending' THEN 'provider_pending' ELSE status END,
              updated_at = ?
        WHERE tenant_id = ? AND operation_id = ?
          AND status IN ('pending', 'provider_pending')`,
    )
    .bind(occurredAt, tenantId, operationId)
    .run();
  const operation = await getLifecycleOperation(db, tenantId, operationId);
  if (!operation) throw new LifecycleRepositoryError("connection_not_found");
  return operation;
}

export async function markLifecycleReconciliation(
  db: LifecycleDatabase,
  tenantId: string,
  operationId: string,
  errorCode: "provider_unavailable" | "provider_error" | "reconciliation_required" | "stale_generation",
  occurredAt: string,
): Promise<LifecycleOperationRow> {
  await db
    .prepare(
      `UPDATE connection_lifecycle_operations
          SET status = 'reconciliation_required', error_code = ?, updated_at = ?
        WHERE tenant_id = ? AND operation_id = ?
          AND status NOT IN ('succeeded', 'failed')`,
    )
    .bind(errorCode, occurredAt, tenantId, operationId)
    .run();
  const operation = await getLifecycleOperation(db, tenantId, operationId);
  if (!operation) throw new LifecycleRepositoryError("connection_not_found");
  if (operation.kind === "disconnect") {
    await db
      .prepare(
        `UPDATE connections SET attention_code = 'disconnect_reconciliation_required'
          WHERE tenant_id = ? AND id = ? AND status = 'disconnected'`,
      )
      .bind(tenantId, operation.connection_id)
      .run();
  }
  return operation;
}

export async function completeConnectionRelink(
  input: CompleteRelinkInput,
): Promise<{
  operation: LifecycleOperationRow;
  connection: LifecycleConnection | null;
  committed: CommitLinkedAccountResult | null;
}> {
  const operation = await getLifecycleOperation(
    input.db,
    input.actor.tenant_id,
    input.operation_id,
  );
  if (!operation || operation.kind !== "relink")
    throw new LifecycleRepositoryError("connection_not_found");
  const current = await getLifecycleConnection(
    input.db,
    input.actor.tenant_id,
    operation.connection_id,
  );
  if (!current || current.identity_id !== operation.identity_id)
    throw new LifecycleRepositoryError("connection_not_found");
  const verifiedLogin = normalizeProviderLogin(input.provider_identity.user_login_id);
  if (operation.status === "succeeded")
    return { operation, connection: current, committed: null };
  if (current.session_generation !== operation.session_generation)
    throw new LifecycleRepositoryError("stale_generation");
  if (current.status === "disconnected" || current.status === "revoked" || current.status === "unlinked")
    throw new LifecycleRepositoryError("stale_generation");

  if (verifiedLogin !== normalizeProviderLogin(current.provider_login_id)) {
    const committed = await commitLinkedAccount({
      db: input.db,
      sessionId: input.session_id,
      tenantId: input.actor.tenant_id,
      actorPrincipalId: input.actor.actor_principal_id,
      membershipId: input.actor.membership_id,
      targetIdentityId: input.actor.identity_id,
      provider: current.provider,
      providerIdentity: input.provider_identity,
      identityHashSecret: input.identity_hash_secret,
      occurredAt: input.occurred_at,
    });
    if (committed.kind === "duplicate")
      throw new LifecycleRepositoryError("provider_identity_mismatch");
    await input.db
      .prepare(
        `UPDATE connection_lifecycle_operations
            SET status = 'succeeded', replacement_connection_id = ?,
                updated_at = ?, completed_at = ?
          WHERE tenant_id = ? AND operation_id = ?
            AND status IN ('pending', 'provider_pending')
            AND expected_session_generation = ?`,
      )
      .bind(
        committed.connection_id,
        input.occurred_at,
        input.occurred_at,
        input.actor.tenant_id,
        input.operation_id,
        operation.session_generation,
      )
      .run();
    const updated = await getLifecycleOperation(
      input.db,
      input.actor.tenant_id,
      input.operation_id,
    );
    if (!updated || updated.status !== "succeeded")
      throw new LifecycleRepositoryError("reconciliation_required");
    return {
      operation: updated,
      connection: await getLifecycleConnection(
        input.db,
        input.actor.tenant_id,
        committed.connection_id ?? operation.connection_id,
      ),
      committed,
    };
  }

  const nextGeneration = ensureNextTimestamp(
    current.session_generation,
    input.occurred_at,
  );
  await input.db.batch([
    input.db
      .prepare(
        `UPDATE connections
            SET status = 'connected', attention_code = NULL, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND identity_id = ?
            AND provider = ? AND updated_at = ?
            AND status IN ('connected', 'syncing', 'ready', 'attention_required')
            AND EXISTS (
              SELECT 1 FROM connection_lifecycle_operations
               WHERE tenant_id = ? AND operation_id = ?
                 AND status IN ('pending', 'provider_pending')
                 AND expected_session_generation = ?
            )`,
      )
      .bind(
        nextGeneration,
        input.actor.tenant_id,
        operation.connection_id,
        operation.identity_id,
        operation.provider,
        operation.session_generation,
        input.actor.tenant_id,
        input.operation_id,
        operation.session_generation,
      ),
    input.db
      .prepare(
        `UPDATE connection_lifecycle_operations
            SET status = 'succeeded', error_code = NULL, updated_at = ?, completed_at = ?
          WHERE tenant_id = ? AND operation_id = ?
            AND status IN ('pending', 'provider_pending')
            AND expected_session_generation = ?`,
      )
      .bind(
        input.occurred_at,
        input.occurred_at,
        input.actor.tenant_id,
        input.operation_id,
        operation.session_generation,
      ),
    input.db
      .prepare(
        `INSERT INTO audit_events
           (id, tenant_id, actor_principal_id, action, target_type, target_id,
            reason, metadata_json, occurred_at)
         VALUES (?, ?, ?, 'connection.relinked', 'connection', ?, NULL, ?, ?)`,
      )
      .bind(
        `audit_${input.operation_id}_complete`,
        input.actor.tenant_id,
        input.actor.actor_principal_id,
        operation.connection_id,
        JSON.stringify({
          operation_id: input.operation_id,
          provider_identity_verified: true,
          session_generation: nextGeneration,
        }),
        input.occurred_at,
      ),
  ]);
  const updated = await getLifecycleOperation(
    input.db,
    input.actor.tenant_id,
    input.operation_id,
  );
  if (!updated || updated.status !== "succeeded")
    throw new LifecycleRepositoryError("reconciliation_required");
  return {
    operation: updated,
    connection: await getLifecycleConnection(
      input.db,
      input.actor.tenant_id,
      operation.connection_id,
    ),
    committed: null,
  };
}

export async function completeConnectionDisconnect(
  input: CompleteDisconnectInput,
): Promise<LifecycleOperationRow> {
  const operation = await getLifecycleOperation(
    input.db,
    input.actor.tenant_id,
    input.operation_id,
  );
  if (!operation || operation.kind !== "disconnect")
    throw new LifecycleRepositoryError("connection_not_found");
  if (operation.status === "succeeded") return operation;
  if (normalizeProviderLogin(input.provider_login_id) !== normalizeProviderLogin(operation.provider_login_id))
    throw new LifecycleRepositoryError("provider_identity_mismatch");
  await input.db
    .prepare(
      `UPDATE connection_lifecycle_operations
          SET status = 'succeeded', error_code = NULL,
              updated_at = ?, completed_at = ?
        WHERE tenant_id = ? AND operation_id = ?
          AND status IN ('pending', 'provider_pending')
          AND provider_login_id = ?
          AND EXISTS (
            SELECT 1 FROM connections
             WHERE tenant_id = ? AND id = ? AND status = 'disconnected'
          )`,
    )
    .bind(
      input.occurred_at,
      input.occurred_at,
      input.actor.tenant_id,
      input.operation_id,
      operation.provider_login_id,
      input.actor.tenant_id,
      operation.connection_id,
    )
    .run();
  const updated = await getLifecycleOperation(
    input.db,
    input.actor.tenant_id,
    input.operation_id,
  );
  if (!updated || updated.status !== "succeeded")
    throw new LifecycleRepositoryError("reconciliation_required");
  await input.db
    .prepare(
      `INSERT INTO audit_events
         (id, tenant_id, actor_principal_id, action, target_type, target_id,
          reason, metadata_json, occurred_at)
       VALUES (?, ?, ?, 'connection.disconnected', 'connection', ?, NULL, ?, ?)`,
    )
    .bind(
      `audit_${input.operation_id}_complete`,
      input.actor.tenant_id,
      input.actor.actor_principal_id,
      operation.connection_id,
      JSON.stringify({ operation_id: input.operation_id, provider_logout_verified: true }),
      input.occurred_at,
    )
    .run();
  return updated;
}
