import {
  AcceptTextReplyInputSchema,
  type AcceptTextReplyResult,
  type OutboundDispatch,
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
import { mapReadError, ReadError } from "../read/errors";
import { isAdministratorSession } from "../read/authorization";

export type OutboundAcceptanceContext = {
  env: Cloudflare.Env;
  authorization: SessionResponse;
};

export type OutboundAcceptanceServices = {
  /** Runtime clock used to anchor the immutable acceptance timestamp. */
  now?: () => Date;
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
  ) => Promise<OutboundAdapterResult>;
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
  let granted: boolean;
  try {
    granted = await hasAccountOperationGrant(
      database.withSession("first-primary"),
      context.authorization.tenant.id,
      context.authorization.membership.id,
      parsed.identity_id,
      owner.account_id,
      parsed.conversation_id,
      "message.send",
    );
  } catch (error) {
    throw mapReadError(error);
  }
  if (!granted) throw new ReadError("forbidden");

  let connectionAvailable = false;
  try {
    const connection = await database
      .withSession("first-primary")
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

  // The DO transaction is the source of truth. A wakeup is advisory and may
  // fail after commit; the pending dispatch row remains recoverable by T07+.
  if (!accepted.replayed) {
    if (services.afterCommit !== undefined) {
      await services.afterCommit(accepted);
    }
    if (
      accepted.dispatch.status === "pending" &&
      services.dispatchOutbound !== undefined
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
        let adapterResult: OutboundAdapterResult;
        try {
          adapterResult = await services.dispatchOutbound(claimed);
        } catch (error) {
          adapterResult = {
            type: "uncertain",
            reason:
              error instanceof Error ? "adapter_error" : "adapter_timeout",
          };
        }
        const reconciled = await projection.reconcileOutbound({
          schema_version: 1,
          tenant_id: context.authorization.tenant.id,
          command_id: accepted.command.id,
          now,
          evidence: adapterResultEvidence(
            adapterResult,
            context,
            accepted.command.id,
            claimed,
            now,
          ),
        });
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
      services.dispatchOutbound === undefined
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

const adapterResultEvidence = (
  result: OutboundAdapterResult,
  context: OutboundAcceptanceContext,
  commandId: string,
  dispatch: OutboundDispatch,
  observedAt: string,
): OutboundEvidenceInput => {
  if (result.type === "uncertain") {
    return {
      schema_version: 1,
      tenant_id: context.authorization.tenant.id,
      command_id: commandId,
      source: "provider",
      evidence_id: result.evidence_id ?? `uncertain_${dispatch.transaction_id}`,
      transaction_id: dispatch.transaction_id,
      request_digest: dispatch.request_digest,
      account_id: dispatch.account_id,
      conversation_id: dispatch.conversation_id,
      generation: dispatch.projection_generation ?? 1,
      status: "uncertain",
      observed_at: observedAt,
      reason: result.reason,
    };
  }
  return {
    schema_version: 1,
    tenant_id: context.authorization.tenant.id,
    command_id: commandId,
    source: result.source,
    evidence_id: result.evidence_id,
    transaction_id: dispatch.transaction_id,
    request_digest: dispatch.request_digest,
    account_id: dispatch.account_id,
    conversation_id: dispatch.conversation_id,
    generation: dispatch.projection_generation ?? 1,
    status: result.status,
    observed_at: observedAt,
    ...(result.provider_operation_id === undefined
      ? {}
      : { provider_operation_id: result.provider_operation_id }),
    ...(result.provider_message_id === undefined
      ? {}
      : { provider_message_id: result.provider_message_id }),
    ...(result.remote_echo_id === undefined
      ? {}
      : { remote_echo_id: result.remote_echo_id }),
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  };
};

export async function reconcileOutboundCommand(
  context: OutboundAcceptanceContext,
  commandId: string,
  services: OutboundAcceptanceServices = {},
  evidence?: OutboundEvidenceInput,
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
        ...(evidence === undefined ? {} : { evidence }),
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
    return OutboundDecisionResultSchema.parse(
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
  } catch (error) {
    throw mapReadError(error);
  }
}
