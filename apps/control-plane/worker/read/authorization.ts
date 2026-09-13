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

export const isAdministratorSession = (session: SessionResponse): boolean =>
  (session.principal.type === "human" ||
    session.principal.type === "operator") &&
  (session.membership.role === "owner" || session.membership.role === "admin");

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

/** Resolve the durable account/chat grant at the application boundary. */
export async function toGrantedProjectionReadAuthorization(
  env: Cloudflare.Env,
  session: SessionResponse,
  identityId: string,
): Promise<ProjectionAuthorizationContext> {
  const base = toProjectionReadAuthorization(session, identityId);
  // Tenant administrators are explicitly authorized to inspect their own
  // connected accounts while setting up a delegated grant. This is an
  // authority check, never an inference from an empty grant result.
  if (isAdministratorSession(session)) return base;
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
  return ProjectionAuthorizationContextSchema.parse({
    ...base,
    allowed_account_ids: scope.allowedAccountIds,
    allowed_all_account_ids: scope.allowedAllAccountIds,
    allowed_conversation_ids: scope.allowedConversationIds,
  });
}

/** Resolve the projection identity owned by an explicit connected account. */
export async function toGrantedAccountReadAuthorization(
  env: Cloudflare.Env,
  session: SessionResponse,
  targetIdentityId: string,
  accountId: string,
): Promise<{
  authorization: ProjectionAuthorizationContext;
  resourceIdentityId: string;
}> {
  const administrator = isAdministratorSession(session);
  const target = session.identities.find(
    (identity) => identity.identity_id === targetIdentityId,
  );
  if (target === undefined && !administrator) throw new ReadError("not_found");
  if (target !== undefined && !target.scopes.includes("conversation.read")) {
    throw new ReadError("not_found");
  }
  const database = env.CONTROL_DB;
  if (database === undefined || typeof database.withSession !== "function") {
    throw new ReadError("service_unavailable");
  }
  try {
    const db = database.withSession("first-primary");
    const account = await db
      .prepare(
        `SELECT c.identity_id
       FROM connection_accounts AS ca
       JOIN connections AS c ON c.tenant_id = ? AND c.id = ca.connection_id
       JOIN identities AS i ON i.tenant_id = c.tenant_id AND i.id = c.identity_id
       JOIN identities AS target_i ON target_i.tenant_id = c.tenant_id AND target_i.id = ?
       WHERE ca.account_id = ?
         AND ca.status = 'active'
         AND i.status = 'active'
         AND target_i.status = 'active'
         AND EXISTS (
           SELECT 1
           FROM memberships AS target_m
           JOIN principals AS target_p ON target_p.id = target_m.principal_id
           JOIN identity_grants AS target_g
             ON target_g.tenant_id = target_m.tenant_id
            AND target_g.membership_id = target_m.id
            AND target_g.identity_id = target_i.id
           WHERE target_m.tenant_id = c.tenant_id
             AND target_m.status = 'active'
             AND target_p.status = 'active'
             AND target_p.revoked_at IS NULL
             AND ((target_p.principal_type IN ('human', 'operator') AND target_i.identity_kind = 'human') OR (target_p.principal_type = 'agent' AND target_i.identity_kind = 'agent'))
         )
       LIMIT 1`,
      )
      .bind(session.tenant.id, targetIdentityId, accountId)
      .first<{ identity_id: string }>();
    if (account === null) throw new ReadError("not_found");

    const resourceIdentity = session.identities.find(
      (identity) => identity.identity_id === account.identity_id,
    );
    if (administrator && resourceIdentity === undefined) {
      throw new ReadError("not_found");
    }

    // An administrator may inspect an account owned by one of its own
    // identities while choosing chats for a different eligible target. The
    // target itself still needs to be active in the tenant, as checked above.
    // Reading the administrator's own identity continues to require an
    // account grant, so an empty grant set remains restrictive.
    const scope =
      administrator && targetIdentityId !== account.identity_id
        ? {
            allowedAccountIds: [accountId],
            allowedAllAccountIds: [accountId],
            allowedConversationIds: [],
          }
        : await resolveAccountReadScope(
            db,
            session.tenant.id,
            session.membership.id,
            targetIdentityId,
            accountId,
          );
    if (!administrator && !scope.allowedAccountIds.includes(accountId)) {
      throw new ReadError("not_found");
    }
    return {
      resourceIdentityId: account.identity_id,
      authorization: ProjectionAuthorizationContextSchema.parse({
        schema_version: 1,
        tenant_id: session.tenant.id,
        principal_id: session.principal.id,
        allowed_identity_ids: [account.identity_id],
        allowed_account_ids: scope.allowedAccountIds,
        allowed_all_account_ids: scope.allowedAllAccountIds,
        allowed_conversation_ids: scope.allowedConversationIds,
        scopes: ["projection.read"],
      }),
    };
  } catch (error) {
    if (error instanceof ReadError) throw error;
    throw new ReadError("service_unavailable", error);
  }
}
