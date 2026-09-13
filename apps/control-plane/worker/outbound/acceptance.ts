import {
  AcceptTextReplyInputSchema,
  type AcceptTextReplyResult,
  type OutboundDispatch,
  type SessionResponse,
  type TextReplyRequest,
  TextReplyRequestSchema,
} from "@communicator/contracts";
import { getTenantProjection } from "../projection/routing";
import { hasAccountOperationGrant } from "../control-directory/grants";
import { mapReadError, ReadError } from "../read/errors";

export type OutboundAcceptanceContext = {
  env: Cloudflare.Env;
  authorization: SessionResponse;
};

export type OutboundAcceptanceServices = {
  /** Controlled test seam before the DO transaction is entered. */
  beforeCommit?: () => void | Promise<void>;
  /** Controlled test seam after the DO transaction commits. */
  afterCommit?: (result: AcceptTextReplyResult) => void | Promise<void>;
  /** Controlled test seam immediately before an adapter wakeup. */
  beforeWakeup?: (dispatch: OutboundDispatch) => void | Promise<void>;
  /** Wake a controlled adapter after the durable transaction commits. */
  wakeDispatch?: (dispatch: OutboundDispatch) => Promise<void>;
};

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
      accepted_at: new Date().toISOString(),
    }),
  );

  // The DO transaction is the source of truth. A wakeup is advisory and may
  // fail after commit; the pending dispatch row remains recoverable by T07+.
  if (!accepted.replayed) {
    if (services.afterCommit !== undefined) {
      await services.afterCommit(accepted);
    }
    if (services.beforeWakeup !== undefined) {
      await services.beforeWakeup(accepted.dispatch);
    }
    if (services.wakeDispatch !== undefined) {
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
