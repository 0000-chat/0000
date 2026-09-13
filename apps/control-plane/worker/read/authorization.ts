import {
  ProjectionAuthorizationContextSchema,
  type AuthorizedIdentity,
  type OperationScope,
  type ProjectionAuthorizationContext,
  type SessionResponse,
} from "@communicator/contracts";
import { ReadError } from "./errors";
import { resolveAccountReadScope } from "../control-directory/grants";

export type ReadAuthorizationScope = Extract<
  OperationScope,
  "conversation.read" | "connection.read"
>;

export function requireAuthorizedIdentity(
  session: SessionResponse,
  identityId: string,
  requiredScope: ReadAuthorizationScope,
): AuthorizedIdentity {
  const identity = session.identities.find(
    (candidate) => candidate.identity_id === identityId,
  );
  if (identity === undefined || !identity.scopes.includes(requiredScope)) {
    throw new ReadError("not_found");
  }
  return identity;
}

export function toProjectionReadAuthorization(
  session: SessionResponse,
  identityId: string,
): ProjectionAuthorizationContext {
  const identity = session.identities.find(
    (candidate) => candidate.identity_id === identityId,
  );
  if (
    identity === undefined ||
    !identity.scopes.some((scope) =>
      scope === "conversation.read" || scope === "connection.read"
    )
  ) {
    throw new ReadError("not_found");
  }

  return ProjectionAuthorizationContextSchema.parse({
    schema_version: 1,
    tenant_id: session.tenant.id,
    principal_id: session.principal.id,
    allowed_identity_ids: [identityId],
    scopes: ["projection.read"],
  });
}

/** Resolve the durable account/chat grant at the application boundary. */
export async function toGrantedProjectionReadAuthorization(
  env: Cloudflare.Env,
  session: SessionResponse,
  identityId: string,
): Promise<ProjectionAuthorizationContext> {
  const base = toProjectionReadAuthorization(session, identityId);
  const database = env.CONTROL_DB;
  if (database === undefined || typeof database.withSession !== "function") {
    throw new ReadError("service_unavailable");
  }
  let scope;
  try {
    scope = await resolveAccountReadScope(
      database.withSession("first-primary"),
      session.tenant.id,
      session.membership.id,
      identityId,
    );
  } catch (error) {
    throw new ReadError("service_unavailable", error);
  }
  if (!scope.enforced) return base;
  return ProjectionAuthorizationContextSchema.parse({
    ...base,
    allowed_account_ids: scope.allowedAccountIds,
    allowed_all_account_ids: scope.allowedAllAccountIds,
    allowed_conversation_ids: scope.allowedConversationIds,
  });
}
