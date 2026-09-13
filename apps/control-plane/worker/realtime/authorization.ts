import {
  RealtimeTicketRequestSchema,
  SessionResponseSchema,
  type RealtimeResumePosition,
  type RealtimeSubscription,
  type SessionResponse,
} from "@communicator/contracts";
import {
  RealtimeUpgradeContextSchema,
  type RealtimeUpgradeContext,
} from "./contracts";

export type AuthorizedRealtimeRequest = {
  schema_version: 1;
  tenant_id: string;
  principal_id: string;
  membership_id: string;
  subscriptions: RealtimeSubscription[];
  resume: RealtimeResumePosition[];
};

export type RealtimeAuthorizationErrorCode = "invalid_request" | "not_found";

const SAFE_MESSAGES: Record<RealtimeAuthorizationErrorCode, string> = {
  invalid_request: "Invalid realtime ticket request",
  not_found: "Realtime authorization not found",
};

const realtimeAuthorizationErrorCauses = new WeakMap<RealtimeAuthorizationError, unknown>();

export class RealtimeAuthorizationError extends Error {
  readonly code!: RealtimeAuthorizationErrorCode;

  constructor(code: RealtimeAuthorizationErrorCode, cause?: unknown) {
    super(SAFE_MESSAGES[code]);
    Object.defineProperty(this, "name", {
      configurable: true,
      enumerable: false,
      value: "RealtimeAuthorizationError",
      writable: true,
    });
    Object.defineProperty(this, "code", {
      configurable: true,
      enumerable: true,
      value: code,
      writable: false,
    });
    if (cause !== undefined) realtimeAuthorizationErrorCauses.set(this, cause);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const getRealtimeAuthorizationErrorCause = (
  error: RealtimeAuthorizationError,
): unknown => realtimeAuthorizationErrorCauses.get(error);

/**
 * Realtime subscriptions currently carry identity-level positions and cannot
 * express the account/chat predicate used by stored reads. Keep the existing
 * stream available only to a tenant owner/admin human or operator with an
 * explicit identity read grant; delegated principals must wait for an
 * account-aware subscription protocol.
 */
export async function realtimeReadScopeSupported(
  db: D1DatabaseSession,
  authorization: Pick<AuthorizedRealtimeRequest, "tenant_id" | "principal_id" | "membership_id" | "subscriptions">,
): Promise<boolean> {
  const identityIds = [...new Set(authorization.subscriptions.map(
    (subscription) => subscription.identity_id,
  ))];
  if (identityIds.length === 0) return true;
  const principal = await db.prepare(
    `SELECT p.principal_type, m.role
     FROM tenants AS t
     JOIN memberships AS m ON m.tenant_id = t.id
     JOIN principals AS p ON p.id = m.principal_id
     WHERE t.id = ?
       AND t.status = 'active'
       AND m.id = ?
       AND m.principal_id = ?
       AND m.status = 'active'
       AND m.revoked_at IS NULL
       AND p.status = 'active'
       AND p.revoked_at IS NULL
     LIMIT 1`,
  ).bind(
    authorization.tenant_id,
    authorization.membership_id,
    authorization.principal_id,
  ).first<{ principal_type: string; role: string }>();
  if (
    principal === null ||
    (principal.principal_type !== "human" && principal.principal_type !== "operator") ||
    (principal.role !== "owner" && principal.role !== "admin")
  ) {
    return false;
  }
  const placeholders = identityIds.map(() => "?").join(", ");
  const grants = await db.prepare(
    `SELECT DISTINCT g.identity_id
     FROM identity_grants AS g
     JOIN identities AS i
       ON i.tenant_id = g.tenant_id
      AND i.id = g.identity_id
     WHERE g.tenant_id = ?
       AND g.membership_id = ?
       AND g.operation_scope = 'conversation.read'
       AND i.status = 'active'
       AND i.id IN (${placeholders})`,
  ).bind(
    authorization.tenant_id,
    authorization.membership_id,
    ...identityIds,
  ).all<{ identity_id: string }>();
  const granted = new Set(grants.results.map((row) => row.identity_id));
  return granted.size === identityIds.length && identityIds.every((identityId) => granted.has(identityId));
}

export function authorizeRealtimeRequest(
  session: SessionResponse,
  request: unknown,
): AuthorizedRealtimeRequest {
  const parsedSession = SessionResponseSchema.safeParse(session);
  if (!parsedSession.success) {
    throw new RealtimeAuthorizationError("invalid_request", parsedSession.error);
  }

  const parsedRequest = RealtimeTicketRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new RealtimeAuthorizationError("invalid_request", parsedRequest.error);
  }

  for (const subscription of parsedRequest.data.subscriptions) {
    const identity = parsedSession.data.identities.find(
      (candidate) => candidate.identity_id === subscription.identity_id,
    );
    if (identity === undefined || !identity.scopes.includes("conversation.read")) {
      throw new RealtimeAuthorizationError("not_found");
    }
  }

  return {
    schema_version: 1,
    tenant_id: parsedSession.data.tenant.id,
    principal_id: parsedSession.data.principal.id,
    membership_id: parsedSession.data.membership.id,
    subscriptions: parsedRequest.data.subscriptions.map((subscription) => ({
      identity_id: subscription.identity_id,
      families: [...subscription.families],
    })),
    resume: (parsedRequest.data.resume ?? []).map((position) => ({
      identity_id: position.identity_id,
      generation: position.generation,
      after_sequence: position.after_sequence,
    })),
  };
}

/**
 * Re-check the directory after a ticket has been consumed. This function
 * intentionally receives a D1 session so the reads remain ordered after the
 * primary DELETE that consumed the ticket.
 */
export async function revalidateRealtimeAuthorization(
  db: D1DatabaseSession,
  authorization: RealtimeUpgradeContext,
): Promise<boolean> {
  const parsed = RealtimeUpgradeContextSchema.safeParse(authorization);
  if (!parsed.success) return false;

  const membership = await db.prepare(
    `SELECT 1 AS authorized
     FROM tenants AS t
     JOIN memberships AS m ON m.tenant_id = t.id
     JOIN principals AS p ON p.id = m.principal_id
     WHERE t.id = ?
       AND t.status = 'active'
       AND m.id = ?
       AND m.principal_id = ?
       AND m.status = 'active'
       AND m.revoked_at IS NULL
       AND p.id = ?
       AND p.status = 'active'
       AND p.revoked_at IS NULL
     LIMIT 1`,
  ).bind(
    parsed.data.tenant_id,
    parsed.data.membership_id,
    parsed.data.principal_id,
    parsed.data.principal_id,
  ).first<{ authorized: number }>();
  if (membership === null) return false;

  const identityIds = parsed.data.subscriptions.map(
    (subscription) => subscription.identity_id,
  );
  const placeholders = identityIds.map(() => "?").join(", ");
  const grants = await db.prepare(
    `SELECT i.id AS identity_id
     FROM identity_grants AS g
     JOIN identities AS i
       ON i.tenant_id = g.tenant_id
      AND i.id = g.identity_id
     WHERE g.tenant_id = ?
       AND g.membership_id = ?
       AND g.operation_scope = 'conversation.read'
       AND i.status = 'active'
       AND i.id IN (${placeholders})
     ORDER BY i.id COLLATE BINARY`,
  ).bind(
    parsed.data.tenant_id,
    parsed.data.membership_id,
    ...identityIds,
  ).all<{ identity_id: string }>();

  const grantedIdentityIds = new Set(grants.results.map((row) => row.identity_id));
  return (
    grants.results.length === identityIds.length &&
    grantedIdentityIds.size === identityIds.length &&
    identityIds.every((identityId) => grantedIdentityIds.has(identityId)) &&
    await realtimeReadScopeSupported(db, parsed.data)
  );
}

export const hasCurrentRealtimeAuthorization = revalidateRealtimeAuthorization;
