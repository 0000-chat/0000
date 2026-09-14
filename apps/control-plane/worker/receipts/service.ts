import {
  ReadReceiptRequestSchema,
  ReadReceiptResultSchema,
  ReceiptTargetSchema,
  type ReadReceiptOperation,
  type ReadReceiptRequest,
  type ReadReceiptResult,
} from "@communicator/contracts";
import type { SessionResponse } from "@communicator/contracts";
import type { OutboundCapability } from "@communicator/contracts";
import { getTenantProjection } from "../projection/routing";
import { isAdministratorSession } from "../read/authorization";
import { mapReadError, ReadError } from "../read/errors";
import {
  claimReceiptOperation,
  createOrReadReceiptOperation,
  getReceiptOperation,
  listReceiptOperations,
  updateReceiptOperation,
  ReceiptRepositoryError,
  type ReceiptOperationIdentity,
} from "./repository";
import {
  defaultWhatsAppReceiptProvider,
  ReceiptProviderError,
  type ReceiptAdapterResult,
  type ReceiptDispatchPayload,
  type ReceiptProvider,
  type ReceiptRoute,
} from "./provider";
import { reservePrivateAuthority } from "../outbound/private-authority";

export type ReceiptServiceContext = {
  env: Cloudflare.Env;
  authorization: SessionResponse;
};

export type ReceiptServices = {
  now?: () => Date;
  createProvider?: (context: ReceiptServiceContext) => ReceiptProvider;
  /** Called before the receipt reservation, so revocation can be tested. */
  beforeFinalAuthorization?: () => void | Promise<void>;
  dispatchReceipt?: (
    payload: ReceiptDispatchPayload,
  ) => Promise<ReceiptAdapterResult>;
};

type ReceiptRouteRow = {
  tenant_id: string;
  identity_id: string;
  account_id: string;
  connection_id: string;
  provider: string;
  connection_status: string;
  session_generation: string;
  gateway_route_id: string;
  bridge_instance_id: string;
  matrix_user_id: string;
  matrix_room_namespace: string;
  provider_login_id: string | null;
  has_receipt_capability: number;
  has_provider_identity: number;
};

type ReceiptCapabilityRow = {
  grant_id: string;
  authorization_epoch: number;
};

type ReceiptAuthorityEpochRow = { authority_epoch: number };

const usableStatuses = new Set(["connected", "syncing", "ready"]);

const databaseFor = (context: ReceiptServiceContext): D1Database => {
  const database = context.env.CONTROL_DB;
  if (database === undefined || typeof database.withSession !== "function")
    throw new ReadError("service_unavailable");
  return database;
};

const nowFor = (services: ReceiptServices): string =>
  (services.now?.() ?? new Date()).toISOString();

const requireIdentityScope = (
  session: SessionResponse,
  identityId: string,
): void => {
  const identity = session.identities.find(
    (candidate) => candidate.identity_id === identityId,
  );
  if (identity === undefined || !identity.scopes.includes("receipt.send"))
    throw new ReadError("forbidden");
};

const readRoute = async (
  context: ReceiptServiceContext,
  identityId: string,
  accountId: string,
): Promise<ReceiptRouteRow | null> => {
  const db = databaseFor(context).withSession("first-primary");
  try {
    return await db
      .prepare(
        `SELECT c.tenant_id, c.identity_id, ca.account_id, c.id AS connection_id,
                c.provider, c.status AS connection_status,
                c.updated_at AS session_generation,
                cr.gateway_route_id, cr.bridge_instance_id, cr.matrix_user_id,
                cr.matrix_room_namespace, pi.provider_login_id,
                EXISTS (
                  SELECT 1 FROM connection_capabilities AS cc
                   WHERE cc.tenant_id = c.tenant_id
                     AND cc.connection_id = c.id
                     AND cc.capability = 'receipt.read'
                ) OR EXISTS (
                  SELECT 1 FROM provider_capability_records AS pcr
                   WHERE pcr.tenant_id = c.tenant_id
                     AND pcr.account_id = ca.account_id
                     AND pcr.connection_id = c.id
                     AND pcr.capability = 'receipt.read'
                     AND pcr.status = 'supported'
                     AND pcr.freshness = 'fresh'
                ) AS has_receipt_capability,
                CASE WHEN pi.connection_id IS NULL THEN 0 ELSE 1 END AS has_provider_identity
           FROM connections AS c
           JOIN connection_accounts AS ca
             ON ca.connection_id = c.id AND ca.status = 'active'
           JOIN connection_routes AS cr ON cr.connection_id = c.id
           LEFT JOIN connection_provider_identities AS pi
             ON pi.tenant_id = c.tenant_id
            AND pi.connection_id = c.id
            AND pi.provider = c.provider
          WHERE c.tenant_id = ? AND c.identity_id = ? AND ca.account_id = ?
          LIMIT 1`,
      )
      .bind(context.authorization.tenant.id, identityId, accountId)
      .first<ReceiptRouteRow>();
  } catch (error) {
    throw new ReadError("service_unavailable", error);
  }
};

const routeFor = (row: ReceiptRouteRow): ReceiptRoute => {
  if (row.provider !== "whatsapp") throw new ReadError("invalid_request");
  if (!usableStatuses.has(row.connection_status))
    throw new ReadError("service_unavailable");
  if (row.has_provider_identity !== 1 || row.provider_login_id === null)
    throw new ReadError("service_unavailable");
  if (row.has_receipt_capability !== 1) throw new ReadError("invalid_request");
  return {
    tenant_id: row.tenant_id,
    identity_id: row.identity_id,
    account_id: row.account_id,
    connection_id: row.connection_id,
    provider: "whatsapp",
    session_generation: row.session_generation,
    gateway_route_id: row.gateway_route_id,
    bridge_instance_id: row.bridge_instance_id,
    matrix_user_id: row.matrix_user_id,
    matrix_room_namespace: row.matrix_room_namespace,
    provider_login_id: row.provider_login_id,
  };
};

const requestHash = async (request: ReadReceiptRequest): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(request)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const readReceiptCapability = async (
  database: D1DatabaseSession,
  context: ReceiptServiceContext,
  identityId: string,
  accountId: string,
  connectionId: string,
  conversationId: string,
): Promise<OutboundCapability | null> => {
  if (isAdministratorSession(context.authorization)) {
    const authority = await database
      .prepare(
        `SELECT authority_epoch FROM memberships
          WHERE tenant_id = ? AND id = ? AND status = 'active'
            AND role IN ('owner', 'admin') LIMIT 1`,
      )
      .bind(
        context.authorization.tenant.id,
        context.authorization.membership.id,
      )
      .first<ReceiptAuthorityEpochRow>();
    return authority === null
      ? null
      : {
          kind: "owner_admin",
          authority_id: context.authorization.membership.id,
          authority_epoch: authority.authority_epoch,
        };
  }
  const grant = await database
    .prepare(
      `SELECT g.id AS grant_id, g.authorization_epoch
         FROM account_grants AS g
         JOIN identity_grants AS ig
           ON ig.tenant_id = g.tenant_id
          AND ig.membership_id = g.membership_id
          AND ig.identity_id = g.identity_id
          AND ig.operation_scope = 'receipt.send'
         JOIN connection_accounts AS ca
           ON ca.account_id = g.account_id AND ca.status = 'active'
         JOIN connections AS c
           ON c.tenant_id = g.tenant_id AND c.id = ca.connection_id AND c.id = ?
        WHERE g.tenant_id = ? AND g.membership_id = ? AND g.identity_id = ?
          AND g.account_id = ? AND g.operation_scope = 'receipt.send'
          AND g.status = 'active'
          AND (g.chat_scope = 'all_chats' OR EXISTS (
            SELECT 1 FROM account_grant_chats AS gc
             WHERE gc.tenant_id = g.tenant_id AND gc.grant_id = g.id
               AND gc.account_id = g.account_id AND gc.chat_id = ?
          ))
        ORDER BY g.id LIMIT 1`,
    )
    .bind(
      connectionId,
      context.authorization.tenant.id,
      context.authorization.membership.id,
      identityId,
      accountId,
      conversationId,
    )
    .first<ReceiptCapabilityRow>();
  return grant === null
    ? null
    : {
        kind: "account_grant",
        grant_id: grant.grant_id,
        authorization_epoch: grant.authorization_epoch,
      };
};

const operationIdFor = (hash: string): string => `receipt_${hash.slice(0, 48)}`;

const resultFor = (
  operation: ReadReceiptOperation,
  replayed: boolean,
): ReadReceiptResult =>
  ReadReceiptResultSchema.parse({ ...operation, replayed });

const mapRepositoryError = (error: unknown): ReadError => {
  if (error instanceof ReceiptRepositoryError) {
    if (error.code === "receipt_invalid" || error.code === "receipt_conflict")
      return new ReadError("invalid_request", error);
    if (error.code === "receipt_not_found")
      return new ReadError("not_found", error);
    return new ReadError("service_unavailable", error);
  }
  return mapReadError(error);
};

const adapterFailure = (error: unknown): ReceiptAdapterResult => {
  if (error instanceof ReceiptProviderError) {
    if (error.code === "timeout")
      return {
        status: "unknown",
        matrix_stage: "unknown",
        bridge_stage: "unknown",
        provider_stage: "unknown",
        evidence: [],
        failure_code: "provider_timeout",
        failure_reason: "Provider response timed out",
      };
    if (error.code === "rejected")
      return {
        status: "rejected",
        matrix_stage: "unknown",
        bridge_stage: "unknown",
        provider_stage: "unknown",
        evidence: [],
        failure_code: "provider_rejected",
        failure_reason: "Provider rejected the receipt",
      };
    return {
      status: "unknown",
      matrix_stage: "unknown",
      bridge_stage: "unknown",
      provider_stage: "unknown",
      evidence: [],
      failure_code:
        error.code === "protocol"
          ? "provider_protocol_error"
          : "provider_unavailable",
      failure_reason: "Provider evidence is unavailable",
    };
  }
  return {
    status: "unknown",
    matrix_stage: "unknown",
    bridge_stage: "unknown",
    provider_stage: "unknown",
    evidence: [],
    failure_code: "provider_unavailable",
    failure_reason: "Provider evidence is unavailable",
  };
};

const operationIdentity = (
  context: ReceiptServiceContext,
  request: ReadReceiptRequest,
  target: ReturnType<typeof ReceiptTargetSchema.parse>,
  hash: string,
  operationId: string,
): ReceiptOperationIdentity & { operationId: string; requestedAt: string } => ({
  operationId,
  tenant_id: context.authorization.tenant.id,
  membership_id: context.authorization.membership.id,
  identity_id: request.identity_id,
  account_id: request.account_id,
  connection_id: target.connection_id,
  session_generation: "",
  conversation_id: request.conversation_id,
  message_id: request.message_id,
  matrix_room_id: target.matrix_room_id,
  matrix_event_id: target.matrix_event_id,
  request_hash: hash,
  idempotency_key: request.idempotency_key,
  requestedAt: "",
});

const rejectOperation = async (
  database: D1Database,
  identity: ReceiptOperationIdentity & {
    operationId: string;
    requestedAt: string;
  },
  code: NonNullable<ReadReceiptOperation["failure_code"]>,
  reason: string,
  now: string,
): Promise<ReadReceiptOperation> => {
  const created = await createOrReadReceiptOperation(
    database.withSession("first-primary"),
    {
      ...identity,
      requestedAt: identity.requestedAt || now,
    },
  );
  if (!created.inserted && created.operation.status !== "requested")
    return created.operation;
  return updateReceiptOperation(
    database.withSession("first-primary"),
    identity.tenant_id,
    identity.operationId,
    {
      status: "rejected",
      matrixStage: "unknown",
      bridgeStage: "unknown",
      providerStage: "unknown",
      failureCode: code,
      failureReason: reason,
      evidence: [],
      updatedAt: now,
    },
  );
};

export async function requestReadReceipt(
  context: ReceiptServiceContext,
  input: ReadReceiptRequest,
  services: ReceiptServices = {},
): Promise<ReadReceiptResult> {
  const request = ReadReceiptRequestSchema.parse(input);
  requireIdentityScope(context.authorization, request.identity_id);
  const projection = getTenantProjection(
    context.env,
    context.authorization.tenant.id,
  );
  const owner = await projection.resolveConversationOwner({
    schema_version: 1,
    tenant_id: context.authorization.tenant.id,
    conversation_id: request.conversation_id,
  });
  if (owner === null) throw new ReadError("not_found");
  if (
    owner.account_id !== request.account_id ||
    owner.identity_id !== request.identity_id
  ) {
    throw new ReadError("invalid_request");
  }
  const targetValue = await projection.resolveReceiptTarget({
    schema_version: 1,
    tenant_id: context.authorization.tenant.id,
    identity_id: owner.identity_id,
    account_id: owner.account_id,
    conversation_id: request.conversation_id,
    message_id: request.message_id,
  });
  if (targetValue === null) throw new ReadError("not_found");
  const target = ReceiptTargetSchema.parse(targetValue);
  const database = databaseFor(context);
  const hash = await requestHash(request);
  const operationId = operationIdFor(hash);
  const now = nowFor(services);
  const identity = operationIdentity(
    context,
    request,
    target,
    hash,
    operationId,
  );
  identity.requestedAt = now;

  if (
    target.deleted_at !== null ||
    target.matrix_room_id === null ||
    target.matrix_event_id === null
  ) {
    const rejected = await rejectOperation(
      database,
      identity,
      "stale_message",
      "The selected message no longer has a readable Matrix event",
      now,
    );
    return resultFor(rejected, false);
  }

  const routeRow = await readRoute(
    context,
    request.identity_id,
    request.account_id,
  );
  if (routeRow === null) throw new ReadError("not_found");
  try {
    const route = routeFor(routeRow);
    identity.session_generation = route.session_generation;
  } catch (error) {
    if (error instanceof ReadError && error.code === "invalid_request") {
      const rejected = await rejectOperation(
        database,
        identity,
        "missing_capability",
        "The account has no fresh receipt capability evidence",
        now,
      );
      return resultFor(rejected, false);
    }
    throw error;
  }

  let capability: OutboundCapability | null;
  try {
    capability = await readReceiptCapability(
      database.withSession("first-primary"),
      context,
      request.identity_id,
      request.account_id,
      target.connection_id,
      request.conversation_id,
    );
  } catch (error) {
    throw mapRepositoryError(error);
  }
  if (capability === null) throw new ReadError("forbidden");

  let created: { operation: ReadReceiptOperation; inserted: boolean };
  try {
    created = await createOrReadReceiptOperation(
      database.withSession("first-primary"),
      identity,
    );
  } catch (error) {
    throw mapRepositoryError(error);
  }
  if (!created.inserted) {
    return resultFor(created.operation, true);
  }
  const claimed = await claimReceiptOperation(
    database.withSession("first-primary"),
    context.authorization.tenant.id,
    operationId,
    now,
  );
  if (!claimed) {
    const existing = await getReceiptOperation(
      database.withSession("first-primary"),
      context.authorization.tenant.id,
      operationId,
    );
    if (existing === null) throw new ReadError("service_unavailable");
    return resultFor(existing, true);
  }

  if (services.beforeFinalAuthorization !== undefined)
    await services.beforeFinalAuthorization();
  const reservation = await reservePrivateAuthority(
    database.withSession("first-primary"),
    {
      tenant_id: context.authorization.tenant.id,
      membership_id: context.authorization.membership.id,
      identity_id: request.identity_id,
      account_id: request.account_id,
      conversation_id: request.conversation_id,
      connection_id: target.connection_id,
      operation_scope: "receipt.send",
      operation_id: operationId,
      request_hash: hash,
      capability,
      session_generation: routeRow.session_generation,
      now: nowFor(services),
    },
  );
  if (reservation.status === "denied") {
    const rejected = await updateReceiptOperation(
      database.withSession("first-primary"),
      context.authorization.tenant.id,
      operationId,
      {
        status: "rejected",
        matrixStage: "unknown",
        bridgeStage: "unknown",
        providerStage: "unknown",
        failureCode:
          reservation.reason === "authorization_revoked"
            ? "authorization_revoked"
            : "receipt_conflict",
        failureReason: "The receipt authority reservation was denied",
        evidence: [],
        updatedAt: nowFor(services),
      },
    );
    return resultFor(rejected, false);
  }

  let finalRoute: ReceiptRoute;
  try {
    const latestRoute = await readRoute(
      context,
      request.identity_id,
      request.account_id,
    );
    if (latestRoute === null) throw new ReadError("not_found");
    finalRoute = routeFor(latestRoute);
  } catch (error) {
    const failure =
      error instanceof ReadError && error.code === "service_unavailable"
        ? "connection_unavailable"
        : "missing_capability";
    const rejected = await updateReceiptOperation(
      database.withSession("first-primary"),
      context.authorization.tenant.id,
      operationId,
      {
        status: "rejected",
        matrixStage: "unknown",
        bridgeStage: "unknown",
        providerStage: "unknown",
        failureCode: failure,
        failureReason: "The account route is no longer usable",
        evidence: [],
        updatedAt: nowFor(services),
      },
    );
    return resultFor(rejected, false);
  }

  const payload: ReceiptDispatchPayload = {
    route: finalRoute,
    membership_id: context.authorization.membership.id,
    actor_identity_id: request.identity_id,
    reservation_id: reservation.reservation.id,
    capability: reservation.reservation.capability,
    request_hash: hash,
    operation_id: operationId,
    operation_created_at: created.operation.requested_at,
    conversation_id: request.conversation_id,
    message_id: request.message_id,
    matrix_room_id: target.matrix_room_id,
    matrix_event_id: target.matrix_event_id,
    receipt_position: target.matrix_event_id,
  };
  let adapterResult: ReceiptAdapterResult;
  try {
    adapterResult = await (services.dispatchReceipt
      ? services.dispatchReceipt(payload)
      : (
          services.createProvider?.(context) ??
          defaultWhatsAppReceiptProvider(context.env)
        ).dispatch(payload));
  } catch (error) {
    adapterResult = adapterFailure(error);
  }
  const updated = await updateReceiptOperation(
    database.withSession("first-primary"),
    context.authorization.tenant.id,
    operationId,
    {
      status: adapterResult.status,
      matrixStage: adapterResult.matrix_stage,
      bridgeStage: adapterResult.bridge_stage,
      providerStage: adapterResult.provider_stage,
      failureCode: adapterResult.failure_code ?? null,
      failureReason: adapterResult.failure_reason ?? null,
      evidence: adapterResult.evidence,
      updatedAt: nowFor(services),
    },
  );
  return resultFor(updated, false);
}

const authorizeOperationRead = (
  context: ReceiptServiceContext,
  operation: ReadReceiptOperation,
): void => {
  if (isAdministratorSession(context.authorization)) return;
  const identity = context.authorization.identities.find(
    (candidate) => candidate.identity_id === operation.identity_id,
  );
  if (identity === undefined || !identity.scopes.includes("receipt.send"))
    throw new ReadError("forbidden");
};

export async function getReadReceipt(
  context: ReceiptServiceContext,
  operationId: string,
): Promise<ReadReceiptOperation> {
  const database = databaseFor(context);
  const operation = await getReceiptOperation(
    database.withSession("first-primary"),
    context.authorization.tenant.id,
    operationId,
  );
  if (operation === null) throw new ReadError("not_found");
  authorizeOperationRead(context, operation);
  return operation;
}

export async function listReadReceipts(
  context: ReceiptServiceContext,
  input: { limit?: number; cursor?: string; account_id?: string },
): Promise<{ items: ReadReceiptOperation[]; next_cursor: string | null }> {
  if (!isAdministratorSession(context.authorization))
    throw new ReadError("forbidden");
  try {
    return await listReceiptOperations(
      databaseFor(context).withSession("first-primary"),
      context.authorization.tenant.id,
      {
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.account_id === undefined
          ? {}
          : { accountId: input.account_id }),
      },
    );
  } catch (error) {
    throw mapRepositoryError(error);
  }
}
