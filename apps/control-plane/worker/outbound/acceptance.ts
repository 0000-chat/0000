import {
  AcceptTextReplyInputSchema,
  type AcceptTextReplyResult,
  type OutboundDispatch,
  type OutboundDispatchPayload,
  type OutboundEvidenceInput,
  type OutboundEvidenceSource,
  type OutboundEvidenceStatus,
  OutboundDecisionResultSchema,
  type OutboundDecisionResult,
  type Command,
  type SessionResponse,
  type TextReplyRequest,
  TextReplyRequestSchema,
} from "@communicator/contracts";
import { getTenantProjection } from "../projection/routing";
import { hasAccountOperationGrant } from "../control-directory/grants";
import { canonicalJsonStringify } from "../archive/canonical-json";
import { sha256Hex } from "../archive/codec";
import { mapReadError, ReadError } from "../read/errors";
import { isAdministratorSession } from "../read/authorization";
import { readAuthorizedMessageRemoval } from "../removals/service";
import { defaultWhatsAppTextAdapter } from "./whatsapp-adapter";
import {
  finalizeOutboundAcceptance,
  readOutboundAcceptanceReservationByKey,
  reserveOutboundAcceptance,
} from "./authority";
import type { OutboundCapability } from "./authority-types";

export type OutboundAcceptanceContext = {
  env: Cloudflare.Env;
  authorization: SessionResponse;
};

export type OutboundAcceptanceServices = {
  /** Runtime clock used to anchor the immutable acceptance timestamp. */
  now?: () => Date;
  /** Controlled test seam immediately before the acceptance reservation LP. */
  beforeAcceptanceReservation?: () => void | Promise<void>;
  /** Controlled test seam before the DO transaction is entered. */
  beforeCommit?: () => void | Promise<void>;
  /** Controlled test seam after the DO transaction commits. */
  afterCommit?: (result: AcceptTextReplyResult) => void | Promise<void>;
  /** Controlled test seam immediately before an adapter wakeup. */
  beforeWakeup?: (dispatch: OutboundDispatch) => void | Promise<void>;
  /** Wake a controlled adapter after the durable transaction commits. */
  wakeDispatch?: (dispatch: OutboundDispatch) => Promise<void>;
  /** Controlled adapter boundary, reached only after a durable lease claim. */
  dispatchOutbound?: (
    dispatch: OutboundDispatch,
    payload: OutboundDispatchPayload,
  ) => Promise<OutboundAdapterResult>;
};

export type OutboundAdapterEvidence = {
  source: OutboundEvidenceSource;
  status: OutboundEvidenceStatus;
  evidence_id: string;
  observed_at?: string | undefined;
  reason?: string | undefined;
  provider_operation_id?: string | undefined;
  provider_message_id?: string | undefined;
  remote_echo_id?: string | undefined;
};

export type OutboundAdapterResult =
  | {
      type: "uncertain";
      reason: string;
      evidence_id?: string;
    }
  | {
      type: "evidence";
      source: OutboundEvidenceSource;
      status: OutboundEvidenceStatus;
      evidence_id: string;
      reason?: string;
      provider_operation_id?: string;
      provider_message_id?: string;
      remote_echo_id?: string;
      observed_at?: string;
    }
  | {
      type: "evidence_batch";
      evidences: OutboundAdapterEvidence[];
    }
  | {
      type: "failure";
      failure_code:
        | "missing_capability"
        | "authorization_revoked"
        | "account_mismatch"
        | "connection_unavailable"
        | "session_expired"
        | "provider_rejected"
        | "rate_limited"
        | "provider_unavailable"
        | "provider_protocol_error"
        | "deleted_message";
      reason: string;
    };

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const USABLE_CONNECTION_STATUSES = new Set(["connected", "syncing", "ready"]);

const requireSendIdentity = (
  session: SessionResponse,
  identityId: string,
): void => {
  const identity = session.identities.find(
    (candidate) => candidate.identity_id === identityId,
  );
  if (identity === undefined || !identity.scopes.includes("message.send")) {
    throw new ReadError("forbidden");
  }
};

type AcceptanceCapabilityRow = {
  grant_id: string;
  authorization_epoch: number;
};

type AuthorityEpochRow = {
  authority_epoch: number;
};

const readAcceptanceCapability = async (
  database: D1DatabaseSession,
  context: OutboundAcceptanceContext,
  identityId: string,
  accountId: string,
  connectionId: string,
  conversationId: string,
): Promise<OutboundCapability | null> => {
  if (isAdministratorSession(context.authorization)) {
    const authority = await database
      .prepare(
        "SELECT authority_epoch FROM memberships WHERE tenant_id = ? AND id = ? LIMIT 1",
      )
      .bind(
        context.authorization.tenant.id,
        context.authorization.membership.id,
      )
      .first<AuthorityEpochRow>();
    return authority === null
      ? null
      : {
          kind: "owner_admin",
          authority_id: context.authorization.membership.id,
          authority_epoch: authority.authority_epoch,
        };
  }

  const delegated = await database
    .prepare(
      `SELECT g.id AS grant_id, g.authorization_epoch
       FROM account_grants AS g
       JOIN identity_grants AS ig
         ON ig.tenant_id = g.tenant_id
        AND ig.membership_id = g.membership_id
        AND ig.identity_id = g.identity_id
        AND ig.operation_scope = 'message.send'
       JOIN connection_accounts AS ca
         ON ca.account_id = g.account_id
        AND ca.status = 'active'
       JOIN connections AS c
         ON c.tenant_id = g.tenant_id
        AND c.id = ca.connection_id
        AND c.id = ?
       WHERE g.tenant_id = ?
         AND g.membership_id = ?
         AND g.identity_id = ?
         AND g.account_id = ?
         AND g.operation_scope = 'message.send'
         AND g.status = 'active'
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
       ORDER BY g.id
       LIMIT 1`,
    )
    .bind(
      connectionId,
      context.authorization.tenant.id,
      context.authorization.membership.id,
      identityId,
      accountId,
      conversationId,
    )
    .first<AcceptanceCapabilityRow>();
  return delegated === null
    ? null
    : {
        kind: "account_grant",
        grant_id: delegated.grant_id,
        authorization_epoch: delegated.authorization_epoch,
      };
};

const outboundAcceptanceDigests = async (input: {
  actorPrincipalId: string;
  actorIdentityId: string;
  conversationId: string;
  accountId: string;
  body: string;
  deliveryMode: string;
  idempotencyKey: string;
}): Promise<{ bodyDigest: string; requestDigest: string }> => {
  const bodyDigest = await sha256Hex(
    new TextEncoder().encode(
      canonicalJsonStringify({
        actor_principal_id: input.actorPrincipalId,
        actor_identity_id: input.actorIdentityId,
        conversation_id: input.conversationId,
        account_id: input.accountId,
        body: input.body,
        delivery_mode: input.deliveryMode,
      }),
    ),
  );
  const requestDigest = await sha256Hex(
    new TextEncoder().encode(
      canonicalJsonStringify({
        body_digest: bodyDigest,
        idempotency_key: input.idempotencyKey,
      }),
    ),
  );
  return { bodyDigest, requestDigest };
};

/**
 * Resolve the chat's immutable account owner, check the distinct account/chat
 * send grant, and commit the outbound ledger through the tenant DO.
 */
export async function acceptTextReply(
  context: OutboundAcceptanceContext,
  request: TextReplyRequest,
  idempotencyKey: string,
  services: OutboundAcceptanceServices = {},
): Promise<AcceptTextReplyResult> {
  const parsed = TextReplyRequestSchema.parse(request);
  requireSendIdentity(context.authorization, parsed.identity_id);

  const projection = getTenantProjection(
    context.env,
    context.authorization.tenant.id,
  );
  const owner = await projection.resolveConversationOwner({
    schema_version: 1,
    tenant_id: context.authorization.tenant.id,
    conversation_id: parsed.conversation_id,
  });
  if (owner === null) throw new ReadError("not_found");
  if (
    parsed.account_id !== undefined &&
    parsed.account_id !== owner.account_id
  ) {
    throw new ReadError("invalid_request");
  }

  const database = context.env.CONTROL_DB;
  if (database === undefined || typeof database.withSession !== "function") {
    throw new ReadError("service_unavailable");
  }
  const dbSession = database.withSession("first-primary");

  let connectionAvailable = false;
  try {
    const connection = await dbSession
      .prepare(
        "SELECT status FROM connections WHERE tenant_id = ? AND id = ? LIMIT 1",
      )
      .bind(context.authorization.tenant.id, owner.connection_id)
      .first<{ status: string }>();
    if (connection === null) throw new ReadError("not_found");
    connectionAvailable = USABLE_CONNECTION_STATUSES.has(connection.status);
  } catch (error) {
    if (error instanceof ReadError) throw error;
    throw mapReadError(error);
  }

  const acceptedAt = (
    services.now === undefined ? new Date() : services.now()
  ).toISOString();
  const initialDispatchStatus = connectionAvailable
    ? "pending"
    : "waiting_for_connection";
  const confirmationDueAt = connectionAvailable
    ? null
    : new Date(Date.parse(acceptedAt) + FOUR_HOURS_MS).toISOString();

  const { bodyDigest, requestDigest } = await outboundAcceptanceDigests({
    actorPrincipalId: context.authorization.principal.id,
    actorIdentityId: parsed.identity_id,
    conversationId: parsed.conversation_id,
    accountId: owner.account_id,
    body: parsed.body,
    deliveryMode: parsed.delivery_mode,
    idempotencyKey,
  });

  let capability: OutboundCapability;
  let reservation: Awaited<ReturnType<typeof reserveOutboundAcceptance>>;
  let existingReservation: Awaited<
    ReturnType<typeof readOutboundAcceptanceReservationByKey>
  >;
  try {
    existingReservation = await readOutboundAcceptanceReservationByKey(
      dbSession,
      context.authorization.tenant.id,
      idempotencyKey,
    );
  } catch (error) {
    throw mapReadError(error);
  }
  if (existingReservation !== null) {
    if (
      existingReservation.membership_id !==
        context.authorization.membership.id ||
      existingReservation.identity_id !== parsed.identity_id ||
      existingReservation.account_id !== owner.account_id ||
      existingReservation.conversation_id !== parsed.conversation_id ||
      existingReservation.connection_id !== owner.connection_id ||
      existingReservation.request_digest !== requestDigest ||
      existingReservation.body_digest !== bodyDigest
    ) {
      throw new ReadError("invalid_request");
    }
    capability = existingReservation.capability;
    reservation = {
      status: "reserved",
      replayed: true,
      reservation: existingReservation,
    };
  } else {
    try {
      const liveCapability = await readAcceptanceCapability(
        dbSession,
        context,
        parsed.identity_id,
        owner.account_id,
        owner.connection_id,
        parsed.conversation_id,
      );
      if (liveCapability === null) throw new ReadError("forbidden");
      capability = liveCapability;
    } catch (error) {
      if (error instanceof ReadError) throw error;
      throw mapReadError(error);
    }

    if (services.beforeAcceptanceReservation !== undefined) {
      await services.beforeAcceptanceReservation();
    }

    try {
      reservation = await reserveOutboundAcceptance(dbSession, {
        tenant_id: context.authorization.tenant.id,
        membership_id: context.authorization.membership.id,
        identity_id: parsed.identity_id,
        account_id: owner.account_id,
        conversation_id: parsed.conversation_id,
        connection_id: owner.connection_id,
        idempotency_key: idempotencyKey,
        request_digest: requestDigest,
        body_digest: bodyDigest,
        capability,
        now: acceptedAt,
      });
    } catch (error) {
      throw mapReadError(error);
    }
    if (reservation.status === "denied") {
      throw new ReadError(
        reservation.reason === "authorization_revoked"
          ? "forbidden"
          : "invalid_request",
      );
    }
  }

  if (services.beforeCommit !== undefined) {
    await services.beforeCommit();
  }

  const accepted = await projection.acceptTextReply(
    AcceptTextReplyInputSchema.parse({
      schema_version: 1,
      tenant_id: context.authorization.tenant.id,
      actor_principal_id: context.authorization.principal.id,
      actor_identity_id: parsed.identity_id,
      conversation_id: parsed.conversation_id,
      account_id: owner.account_id,
      body: parsed.body,
      delivery_mode: parsed.delivery_mode,
      idempotency_key: idempotencyKey,
      accepted_at: acceptedAt,
      initial_dispatch_status: initialDispatchStatus,
      confirmation_due_at: confirmationDueAt,
    }),
  );

  let finalized: Awaited<ReturnType<typeof finalizeOutboundAcceptance>>;
  try {
    finalized = await finalizeOutboundAcceptance(dbSession, {
      tenant_id: context.authorization.tenant.id,
      membership_id: context.authorization.membership.id,
      identity_id: parsed.identity_id,
      account_id: owner.account_id,
      conversation_id: parsed.conversation_id,
      connection_id: owner.connection_id,
      grant_id: reservation.reservation.grant_id,
      capability: reservation.reservation.capability,
      reservation_id: reservation.reservation.id,
      idempotency_key: idempotencyKey,
      request_digest: requestDigest,
      body_digest: bodyDigest,
      command_id: accepted.command.id,
      message_id: accepted.message.id,
      dispatch_id: accepted.dispatch.id,
      transaction_id: accepted.dispatch.transaction_id,
      now: acceptedAt,
    });
  } catch (error) {
    throw mapReadError(error);
  }
  if (finalized.status === "denied") {
    throw new ReadError(
      finalized.reason === "tuple_mismatch"
        ? "invalid_request"
        : "service_unavailable",
    );
  }

  // The DO transaction is the source of truth. A wakeup is advisory and may
  // fail after commit; the pending dispatch row remains recoverable by T07+.
  if (!accepted.replayed) {
    if (services.afterCommit !== undefined) {
      await services.afterCommit(accepted);
    }
    const configuredAdapter = configuredOutboundAdapter(context, services);
    if (
      accepted.dispatch.status === "pending" &&
      configuredAdapter !== undefined
    ) {
      const now = acceptanceNow(services);
      const leaseExpiresAt = new Date(Date.parse(now) + 30_000).toISOString();
      const claimed = await projection.claimOutboundDispatch({
        tenant_id: context.authorization.tenant.id,
        command_id: accepted.command.id,
        lease_id: `lease_${accepted.dispatch.transaction_id}_${Date.parse(now)}`,
        lease_expires_at: leaseExpiresAt,
        now,
      });
      if (claimed.status === "dispatching") {
        const reconciled = await dispatchClaimedOutbound(
          context,
          accepted.command.id,
          claimed,
          configuredAdapter,
          services,
          now,
        );
        return {
          ...accepted,
          command: reconciled.command,
          dispatch: reconciled.dispatch,
        };
      }
    } else if (
      accepted.dispatch.status === "pending" &&
      services.beforeWakeup !== undefined
    ) {
      await services.beforeWakeup(accepted.dispatch);
    }
    if (
      accepted.dispatch.status === "pending" &&
      services.wakeDispatch !== undefined &&
      configuredAdapter === undefined
    ) {
      try {
        await services.wakeDispatch(accepted.dispatch);
      } catch {
        // Keep the durable acceptance visible. Provider I/O is outside the DO
        // transaction and must never turn a saved command into a false failure.
      }
    }
  }
  return accepted;
}

const acceptanceNow = (services: OutboundAcceptanceServices): string =>
  (services.now === undefined ? new Date() : services.now()).toISOString();

const configuredOutboundAdapter = (
  context: OutboundAcceptanceContext,
  services: OutboundAcceptanceServices,
): DispatchAdapter | undefined =>
  services.dispatchOutbound ??
  (() => {
    const adapter = defaultWhatsAppTextAdapter(context);
    return adapter === undefined
      ? undefined
      : (dispatch: OutboundDispatch, payload: OutboundDispatchPayload) =>
          adapter.dispatch(dispatch, payload);
  })();

type DispatchAdapter = (
  dispatch: OutboundDispatch,
  payload: OutboundDispatchPayload,
) => Promise<OutboundAdapterResult>;

const outboundRemoval = async (
  context: OutboundAcceptanceContext,
  dispatch: OutboundDispatch,
) => {
  const database = context.env.CONTROL_DB;
  if (database === undefined || typeof database.withSession !== "function") {
    throw new ReadError("service_unavailable");
  }
  try {
    return await readAuthorizedMessageRemoval(database, {
      tenantId: context.authorization.tenant.id,
      messageId: dispatch.message_id,
      accountId: dispatch.account_id,
      conversationId: dispatch.conversation_id,
    });
  } catch (error) {
    throw mapReadError(error);
  }
};

const failRemovedOutbound = (
  projection: ReturnType<typeof getTenantProjection>,
  context: OutboundAcceptanceContext,
  commandId: string,
  claimed: OutboundDispatch,
  now: string,
) =>
  projection.failOutboundDispatch({
    schema_version: 1,
    tenant_id: context.authorization.tenant.id,
    command_id: commandId,
    lease_id: claimed.dispatch_lease_id ?? "",
    now,
    failure_code: "deleted_message",
  });

const dispatchClaimedOutbound = async (
  context: OutboundAcceptanceContext,
  commandId: string,
  claimed: OutboundDispatch,
  adapter: DispatchAdapter,
  services: OutboundAcceptanceServices,
  now: string,
): Promise<OutboundDecisionResult> => {
  const projection = getTenantProjection(
    context.env,
    context.authorization.tenant.id,
  );
  if ((await outboundRemoval(context, claimed)) !== null) {
    return failRemovedOutbound(projection, context, commandId, claimed, now);
  }
  let payload: OutboundDispatchPayload;
  try {
    payload = await projection.getOutboundDispatchPayload({
      schema_version: 1,
      tenant_id: context.authorization.tenant.id,
      command_id: commandId,
      lease_id: claimed.dispatch_lease_id ?? "",
      now,
    });
  } catch {
    return projection.failOutboundDispatch({
      schema_version: 1,
      tenant_id: context.authorization.tenant.id,
      command_id: commandId,
      lease_id: claimed.dispatch_lease_id ?? "",
      now,
      failure_code: "deleted_message",
    });
  }
  if ((await outboundRemoval(context, claimed)) !== null) {
    return failRemovedOutbound(projection, context, commandId, claimed, now);
  }
  let adapterResult: OutboundAdapterResult;
  try {
    adapterResult = await adapter(claimed, payload);
  } catch (error) {
    adapterResult = {
      type: "uncertain",
      reason: error instanceof Error ? "adapter_error" : "adapter_timeout",
    };
  }
  if (adapterResult.type === "failure") {
    return projection.failOutboundDispatch({
      schema_version: 1,
      tenant_id: context.authorization.tenant.id,
      command_id: commandId,
      lease_id: claimed.dispatch_lease_id ?? "",
      now,
      failure_code: adapterResult.failure_code,
    });
  }
  const evidences = adapterResultEvidence(
    adapterResult,
    context,
    commandId,
    claimed,
    now,
  );
  const effectiveEvidences =
    evidences.length > 0
      ? evidences
      : adapterResultEvidence(
          {
            type: "uncertain",
            reason: "adapter_returned_no_evidence",
          },
          context,
          commandId,
          claimed,
          now,
        );
  let reconciled: OutboundDecisionResult | undefined;
  for (const evidence of effectiveEvidences) {
    reconciled = await reconcileTrustedOutboundEvidence(
      context,
      commandId,
      services,
      evidence,
    );
  }
  if (reconciled === undefined) throw new ReadError("service_unavailable");
  return reconciled;
};

/**
 * Apply evidence produced by the private outbound adapter boundary.
 *
 * This helper is intentionally kept separate from the public status
 * reconciler.  REST and MCP callers may observe a command, or make an
 * explicit administrator decision, but they cannot submit a provider outcome
 * that the projection would treat as authoritative evidence.
 */
export const reconcileTrustedOutboundEvidence = async (
  context: OutboundAcceptanceContext,
  commandId: string,
  services: OutboundAcceptanceServices,
  evidence: OutboundEvidenceInput,
): Promise<OutboundDecisionResult> => {
  const projection = getTenantProjection(
    context.env,
    context.authorization.tenant.id,
  );
  try {
    return OutboundDecisionResultSchema.parse(
      await projection.reconcileOutbound({
        schema_version: 1,
        tenant_id: context.authorization.tenant.id,
        command_id: commandId,
        now: acceptanceNow(services),
        evidence,
      }),
    );
  } catch (error) {
    throw mapReadError(error);
  }
};

const adapterResultEvidence = (
  result: OutboundAdapterResult,
  context: OutboundAcceptanceContext,
  commandId: string,
  dispatch: OutboundDispatch,
  observedAt: string,
): OutboundEvidenceInput[] => {
  if (result.type === "uncertain") {
    return [
      {
        schema_version: 1,
        tenant_id: context.authorization.tenant.id,
        command_id: commandId,
        source: "provider",
        evidence_id:
          result.evidence_id ?? `uncertain_${dispatch.transaction_id}`,
        transaction_id: dispatch.transaction_id,
        request_digest: dispatch.request_digest,
        account_id: dispatch.account_id,
        conversation_id: dispatch.conversation_id,
        generation: dispatch.projection_generation ?? 1,
        status: "uncertain",
        observed_at: observedAt,
        reason: result.reason,
      },
    ];
  }
  const sourceEvidence =
    result.type === "evidence"
      ? [result]
      : result.type === "evidence_batch"
        ? result.evidences
        : [];
  return sourceEvidence.map((evidence) => ({
    schema_version: 1,
    tenant_id: context.authorization.tenant.id,
    command_id: commandId,
    source: evidence.source,
    evidence_id: evidence.evidence_id,
    transaction_id: dispatch.transaction_id,
    request_digest: dispatch.request_digest,
    account_id: dispatch.account_id,
    conversation_id: dispatch.conversation_id,
    generation: dispatch.projection_generation ?? 1,
    status: evidence.status,
    observed_at: evidence.observed_at ?? observedAt,
    ...(evidence.provider_operation_id === undefined
      ? {}
      : { provider_operation_id: evidence.provider_operation_id }),
    ...(evidence.provider_message_id === undefined
      ? {}
      : { provider_message_id: evidence.provider_message_id }),
    ...(evidence.remote_echo_id === undefined
      ? {}
      : { remote_echo_id: evidence.remote_echo_id }),
    ...(evidence.reason === undefined ? {} : { reason: evidence.reason }),
  }));
};

export async function reconcileOutboundCommand(
  context: OutboundAcceptanceContext,
  commandId: string,
  services: OutboundAcceptanceServices = {},
): Promise<OutboundDecisionResult> {
  const projection = getTenantProjection(
    context.env,
    context.authorization.tenant.id,
  );
  try {
    return OutboundDecisionResultSchema.parse(
      await projection.reconcileOutbound({
        schema_version: 1,
        tenant_id: context.authorization.tenant.id,
        command_id: commandId,
        now: acceptanceNow(services),
      }),
    );
  } catch (error) {
    throw mapReadError(error);
  }
}

export async function listOutboundCommands(
  context: OutboundAcceptanceContext,
): Promise<Command[]> {
  if (!isAdministratorSession(context.authorization)) {
    throw new ReadError("forbidden");
  }
  const projection = getTenantProjection(
    context.env,
    context.authorization.tenant.id,
  );
  try {
    return await projection.listOutboundCommands({
      schema_version: 1,
      tenant_id: context.authorization.tenant.id,
    });
  } catch (error) {
    throw mapReadError(error);
  }
}

export async function listOutboundEvidence(
  context: OutboundAcceptanceContext,
  commandId: string,
) {
  if (!isAdministratorSession(context.authorization)) {
    throw new ReadError("forbidden");
  }
  const projection = getTenantProjection(
    context.env,
    context.authorization.tenant.id,
  );
  try {
    return await projection.listOutboundEvidence({
      schema_version: 1,
      tenant_id: context.authorization.tenant.id,
      command_id: commandId,
    });
  } catch (error) {
    throw mapReadError(error);
  }
}

export async function decideOutboundCommand(
  context: OutboundAcceptanceContext,
  commandId: string,
  decision: "confirm" | "cancel" | "continue" | "resend",
  idempotencyKey: string,
  services: OutboundAcceptanceServices = {},
  duplicateRiskAcknowledged = false,
): Promise<OutboundDecisionResult> {
  const current = await reconcileOutboundCommand(context, commandId, services);
  const administrator = isAdministratorSession(context.authorization);
  const identity = context.authorization.identities.find((candidate) =>
    candidate.scopes.includes("message.send"),
  );
  if (!administrator) {
    // A delegated agent may cancel its own pre-dispatch work when its
    // account/chat send grant is still active. Confirmation after the
    // deadline remains an explicit human administrator action.
    if (
      decision !== "cancel" ||
      context.authorization.principal.type !== "agent" ||
      identity === undefined
    ) {
      throw new ReadError("forbidden");
    }
    const database = context.env.CONTROL_DB;
    if (database === undefined || typeof database.withSession !== "function") {
      throw new ReadError("service_unavailable");
    }
    let granted = false;
    try {
      granted = await hasAccountOperationGrant(
        database.withSession("first-primary"),
        context.authorization.tenant.id,
        context.authorization.membership.id,
        identity.identity_id,
        current.dispatch.account_id,
        current.dispatch.conversation_id,
        "message.send",
      );
    } catch (error) {
      throw mapReadError(error);
    }
    if (!granted) throw new ReadError("forbidden");
  }
  const actorIdentity =
    identity?.identity_id ?? context.authorization.identities[0]?.identity_id;
  if (actorIdentity === undefined) throw new ReadError("forbidden");
  const projection = getTenantProjection(
    context.env,
    context.authorization.tenant.id,
  );
  try {
    const result = OutboundDecisionResultSchema.parse(
      await projection.decideOutbound({
        schema_version: 1,
        tenant_id: context.authorization.tenant.id,
        command_id: commandId,
        decision,
        idempotency_key: idempotencyKey,
        actor_principal_id: context.authorization.principal.id,
        actor_identity_id: actorIdentity,
        decided_at: acceptanceNow(services),
        duplicate_risk_acknowledged: duplicateRiskAcknowledged,
      }),
    );
    const adapter = configuredOutboundAdapter(context, services);
    if (
      decision === "confirm" &&
      !result.replayed &&
      result.dispatch.status === "pending" &&
      adapter !== undefined
    ) {
      const now = acceptanceNow(services);
      const claimed = await projection.claimOutboundDispatch({
        tenant_id: context.authorization.tenant.id,
        command_id: commandId,
        lease_id: `lease_${result.dispatch.transaction_id}_${Date.parse(now)}`,
        lease_expires_at: new Date(Date.parse(now) + 30_000).toISOString(),
        now,
      });
      if (claimed.status === "dispatching") {
        const dispatched = await dispatchClaimedOutbound(
          context,
          commandId,
          claimed,
          adapter,
          services,
          now,
        );
        return {
          ...result,
          command: dispatched.command,
          dispatch: dispatched.dispatch,
        };
      }
    }
    return result;
  } catch (error) {
    throw mapReadError(error);
  }
}
