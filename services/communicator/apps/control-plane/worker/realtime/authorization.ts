import {
  RealtimeTicketRequestSchema,
  SessionResponseSchema,
  type RealtimeResumePosition,
  type RealtimeSubscription,
  type SessionResponse,
} from "@communicator/contracts";
import {
  RealtimeUpgradeContextSchema,
  type RealtimePlatformContext,
  type RealtimeUpgradeContext,
} from "./contracts";

export type AuthorizedRealtimeRequest = {
  schema_version: 1;
  tenant_id: string;
  principal_id: string;
  membership_id: string;
  subscriptions: RealtimeSubscription[];
  resume: RealtimeResumePosition[];
  platform?: RealtimePlatformContext;
};

export type RealtimeAuthorizationErrorCode = "invalid_request" | "not_found";

const SAFE_MESSAGES: Record<RealtimeAuthorizationErrorCode, string> = {
  invalid_request: "Invalid realtime ticket request",
  not_found: "Realtime authorization not found",
};

const realtimeAuthorizationErrorCauses = new WeakMap<
  RealtimeAuthorizationError,
  unknown
>();

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
 * express the account/chat predicate used by stored reads. Platform-backed
 * requests therefore require an active account grant for every subscribed
 * identity; the legacy fixture path retains its historical tenant-admin
 * behavior.
 */
export async function realtimeReadScopeSupported(
  db: D1DatabaseSession,
  authorization: Pick<
    RealtimeUpgradeContext,
    | "tenant_id"
    | "principal_id"
    | "membership_id"
    | "subscriptions"
    | "platform"
  >,
  options: { allowMachine?: boolean } = {},
): Promise<boolean> {
  const identityIds = [
    ...new Set(
      authorization.subscriptions.map(
        (subscription) => subscription.identity_id,
      ),
    ),
  ];
  if (identityIds.length === 0) return true;
  const principal = await db
    .prepare(
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
    )
    .bind(
      authorization.tenant_id,
      authorization.membership_id,
      authorization.principal_id,
    )
    .first<{ principal_type: string; role: string }>();
  const machine =
    options.allowMachine === true &&
    (principal?.principal_type === "agent" ||
      principal?.principal_type === "service");
  const humanOperator =
    principal !== null &&
    (principal.principal_type === "human" ||
      principal.principal_type === "operator") &&
    (principal.role === "owner" || principal.role === "admin");
  if (principal === null || (!machine && !humanOperator)) {
    return false;
  }
  const placeholders = identityIds.map(() => "?").join(", ");
  const grants = await db
    .prepare(
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
    )
    .bind(authorization.tenant_id, authorization.membership_id, ...identityIds)
    .all<{ identity_id: string }>();
  const granted = new Set(grants.results.map((row) => row.identity_id));
  const identityGrantIsComplete =
    granted.size === identityIds.length &&
    identityIds.every((identityId) => granted.has(identityId));
  if (!identityGrantIsComplete) return false;

  // A Platform machine credential can use realtime only when the service
  // owned account registry grants the subscribed identity access to at least
  // one active account. Identity grants alone never create account access.
  // Keep the historical human fixture seam's tenant-admin behavior while
  // applying the full account ACL to Platform requests and machines.
  if (!machine && authorization.platform === undefined) return true;
  const accountGrants = await db
    .prepare(
      `SELECT DISTINCT g.identity_id
     FROM account_grants AS g
     JOIN connection_accounts AS ca
       ON ca.account_id = g.account_id
        AND ca.status = 'active'
     JOIN connections AS c
       ON c.id = ca.connection_id
      AND c.tenant_id = g.tenant_id
     WHERE g.tenant_id = ?
         AND g.membership_id = ?
         AND g.operation_scope = 'conversation.read'
         AND g.status = 'active'
         AND g.identity_id IN (${placeholders})`,
    )
    .bind(authorization.tenant_id, authorization.membership_id, ...identityIds)
    .all<{ identity_id: string }>();
  const accountGranted = new Set(
    accountGrants.results.map((row) => row.identity_id),
  );
  return (
    accountGranted.size === identityIds.length &&
    identityIds.every((identityId) => accountGranted.has(identityId))
  );
}

export function authorizeRealtimeRequest(
  session: SessionResponse,
  request: unknown,
  platform?: RealtimePlatformContext,
): AuthorizedRealtimeRequest {
  const parsedSession = SessionResponseSchema.safeParse(session);
  if (!parsedSession.success) {
    throw new RealtimeAuthorizationError(
      "invalid_request",
      parsedSession.error,
    );
  }

  const parsedRequest = RealtimeTicketRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new RealtimeAuthorizationError(
      "invalid_request",
      parsedRequest.error,
    );
  }

  for (const subscription of parsedRequest.data.subscriptions) {
    const identity = parsedSession.data.identities.find(
      (candidate) => candidate.identity_id === subscription.identity_id,
    );
    if (
      identity === undefined ||
      !identity.scopes.includes("conversation.read")
    ) {
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
    ...(platform === undefined ? {} : { platform }),
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

  const membership = await db
    .prepare(
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
    )
    .bind(
      parsed.data.tenant_id,
      parsed.data.membership_id,
      parsed.data.principal_id,
      parsed.data.principal_id,
    )
    .first<{ authorized: number }>();
  if (membership === null) return false;

  const identityIds = parsed.data.subscriptions.map(
    (subscription) => subscription.identity_id,
  );
  const placeholders = identityIds.map(() => "?").join(", ");
  const grants = await db
    .prepare(
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
    )
    .bind(parsed.data.tenant_id, parsed.data.membership_id, ...identityIds)
    .all<{ identity_id: string }>();

  const grantedIdentityIds = new Set(
    grants.results.map((row) => row.identity_id),
  );
  return (
    grants.results.length === identityIds.length &&
    grantedIdentityIds.size === identityIds.length &&
    identityIds.every((identityId) => grantedIdentityIds.has(identityId)) &&
    (await realtimeReadScopeSupported(db, parsed.data, {
      allowMachine:
        parsed.data.platform?.kind === "agent" ||
        parsed.data.platform?.kind === "service",
    }))
  );
}

/** Revalidate an already-open hibernated socket before delivering new data. */
export async function revalidateRealtimeSocketAuthorization(
  db: D1DatabaseSession,
  authorization: Pick<
    RealtimeUpgradeContext,
    "tenant_id" | "principal_id" | "subscriptions" | "platform"
  > & { readonly membership_id?: string | undefined },
): Promise<boolean> {
  if (authorization.membership_id === undefined) return false;
  return revalidateRealtimeAuthorization(db, {
    schema_version: 1,
    tenant_id: authorization.tenant_id,
    principal_id: authorization.principal_id,
    membership_id: authorization.membership_id,
    subscriptions: authorization.subscriptions,
    resume: [],
    ...(authorization.platform === undefined
      ? {}
      : { platform: authorization.platform }),
    issued_at: new Date(0).toISOString(),
    expires_at: new Date(1_000).toISOString(),
  });
}

export const hasCurrentRealtimeAuthorization = revalidateRealtimeAuthorization;
