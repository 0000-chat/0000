import {
  ProjectionAuthorizationContextSchema,
  type AuthorizedIdentity,
  type OperationScope,
  type ProjectionAuthorizationContext,
  type SessionResponse,
} from "@communicator/contracts";
import { ReadError } from "./errors";

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
    !identity.scopes.some(
      (scope) => scope === "conversation.read" || scope === "connection.read",
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
