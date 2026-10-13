import {
  SessionResponseSchema,
  type SessionResponse,
} from "@communicator/contracts";
import type { VerifiedSubject } from "../auth/oidc";
import {
  findActivePrincipal,
  isTokenRevoked,
  listActiveMemberships,
  listAuthorizedIdentities,
} from "./repository";
import { findActiveOAuthInstallation } from "../oauth/repository";
import {
  resolvePlatformBinding,
  type BindablePlatformPrincipal,
  type ResolvedPlatformBinding,
} from "./platform-bindings";

export type AuthorizationFailureCode =
  | "unauthenticated"
  | "not_found"
  | "tenant_selection_required"
  | "directory_unavailable";

export type AuthorizationResult =
  | { ok: true; context: SessionResponse }
  | { ok: false; code: AuthorizationFailureCode };

export type PlatformAuthorizationResult =
  | {
      ok: true;
      context: SessionResponse;
      binding: ResolvedPlatformBinding;
      principal: BindablePlatformPrincipal;
      capabilities: readonly string[];
    }
  | { ok: false; code: AuthorizationFailureCode };

/**
 * Resolve the service-owned resource context for an already verified Platform
 * principal.  Platform validity and capabilities are inputs; neither a
 * credential nor a Platform organization role creates a local resource grant.
 */
export async function resolvePlatformAuthorization(
  db: D1Database,
  principal: BindablePlatformPrincipal,
  tenantHint?: string,
): Promise<PlatformAuthorizationResult> {
  try {
    const resolved = await resolvePlatformBinding(db, principal, tenantHint);
    if (!resolved.ok) return { ok: false, code: resolved.code };

    const binding = resolved.binding;
    const session = db.withSession("first-primary");
    const memberships = await listActiveMemberships(
      session,
      binding.localPrincipalId,
      binding.localTenantId,
    );
    const membership = memberships.find(
      (candidate) => candidate.id === binding.localMembershipId,
    );
    if (
      !membership ||
      membership.role !== binding.localRole ||
      membership.tenant_id !== binding.localTenantId
    ) {
      return { ok: false, code: "not_found" };
    }

    const platformCapabilities = new Set(principal.capabilities);
    let identities = await listAuthorizedIdentities(
      session,
      membership.id,
      membership.tenant_id,
    );
    if (binding.localIdentityId !== null) {
      identities = identities.filter(
        (identity) => identity.identity_id === binding.localIdentityId,
      );
    }
    identities = identities
      .map((identity) => ({
        ...identity,
        // Capabilities are an upper bound supplied by the authority.  The
        // local grant remains the second, independent half of this check.
        scopes: identity.scopes.filter((scope) =>
          platformCapabilities.has(scope),
        ),
      }))
      .filter((identity) => identity.scopes.length > 0);

    const context = SessionResponseSchema.parse({
      binding_id: binding.bindingId,
      tenant: {
        id: membership.tenant_id,
        slug: membership.tenant_slug,
        display_name: membership.tenant_display_name,
      },
      principal: {
        id: binding.localPrincipalId,
        type: binding.localPrincipalKind,
        display_name: await activePrincipalDisplayName(
          session,
          binding.localPrincipalId,
        ),
      },
      membership: { id: membership.id, role: membership.role },
      identities,
    });
    return {
      ok: true,
      context,
      binding,
      principal,
      capabilities: [...new Set(principal.capabilities)],
    };
  } catch {
    return { ok: false, code: "directory_unavailable" };
  }
}

async function activePrincipalDisplayName(
  db: D1DatabaseSession,
  principalId: string,
): Promise<string> {
  const row = await db
    .prepare(
      "SELECT display_name FROM principals WHERE id = ? AND status = 'active' AND revoked_at IS NULL LIMIT 1",
    )
    .bind(principalId)
    .first<{ display_name: string }>();
  if (
    !row ||
    typeof row.display_name !== "string" ||
    row.display_name.length === 0
  ) {
    throw new Error("local principal is unavailable");
  }
  return row.display_name;
}

export async function resolveAuthorization(
  db: D1Database,
  subject: VerifiedSubject,
  tenantHint?: string,
): Promise<AuthorizationResult> {
  try {
    const session = db.withSession("first-primary");
    const principal = await findActivePrincipal(
      session,
      subject.issuer,
      subject.subject,
    );
    if (!principal) return { ok: false, code: "not_found" };

    if (
      (principal.principal_type === "agent" ||
        principal.principal_type === "service") &&
      !subject.token_id
    ) {
      return { ok: false, code: "unauthenticated" };
    }
    if (
      subject.token_id &&
      (await isTokenRevoked(session, subject.issuer, subject.token_id))
    ) {
      return { ok: false, code: "unauthenticated" };
    }

    const memberships = await listActiveMemberships(
      session,
      principal.id,
      tenantHint,
    );
    if (memberships.length === 0) return { ok: false, code: "not_found" };
    if (memberships.length > 1 && !tenantHint) {
      return { ok: false, code: "tenant_selection_required" };
    }

    const [membership] = memberships;
    if (!membership) return { ok: false, code: "not_found" };
    const identities = await listAuthorizedIdentities(
      session,
      membership.id,
      membership.tenant_id,
    );
    const context = SessionResponseSchema.parse({
      tenant: {
        id: membership.tenant_id,
        slug: membership.tenant_slug,
        display_name: membership.tenant_display_name,
      },
      principal: {
        id: principal.id,
        type: principal.principal_type,
        display_name: principal.display_name,
      },
      membership: {
        id: membership.id,
        role: membership.role,
      },
      identities,
    });
    return { ok: true, context };
  } catch {
    return { ok: false, code: "directory_unavailable" };
  }
}

/**
 * Resolve a locally issued OAuth token through its installation binding.
 * Human issuer/subject claims carried as consent provenance are intentionally
 * ignored here; the token subject must be the generated installation agent
 * principal and the installation must still be active.
 */
export async function resolveOAuthInstallationAuthorization(
  db: D1Database,
  subject: VerifiedSubject,
  tenantHint?: string,
): Promise<AuthorizationResult> {
  if (!subject.installation_id || !subject.client_id || !subject.resource) {
    return { ok: false, code: "unauthenticated" };
  }
  if (!subject.token_id) return { ok: false, code: "unauthenticated" };

  try {
    const session = db.withSession("first-primary");
    const installation = await findActiveOAuthInstallation(
      session,
      subject.installation_id,
    );
    if (
      installation === null ||
      installation.client_id !== subject.client_id ||
      installation.resource !== subject.resource ||
      (tenantHint !== undefined && installation.tenant_id !== tenantHint) ||
      installation.principal_id !== subject.subject ||
      (await isTokenRevoked(session, subject.issuer, subject.token_id))
    ) {
      return { ok: false, code: "unauthenticated" };
    }

    const memberships = await listActiveMemberships(
      session,
      installation.principal_id,
      installation.tenant_id,
    );
    const membership = memberships.find(
      (candidate) => candidate.id === installation.membership_id,
    );
    if (!membership) return { ok: false, code: "unauthenticated" };
    const identities = await listAuthorizedIdentities(
      session,
      membership.id,
      membership.tenant_id,
    );
    if (
      !identities.some(
        (identity) => identity.identity_id === installation.identity_id,
      )
    ) {
      return { ok: false, code: "unauthenticated" };
    }
    const principal = await session
      .prepare(
        "SELECT id, principal_type, display_name FROM principals WHERE id = ? AND status = 'active' AND revoked_at IS NULL LIMIT 1",
      )
      .bind(installation.principal_id)
      .first<{
        id: string;
        principal_type: "human" | "service" | "agent" | "operator";
        display_name: string;
      }>();
    if (!principal || principal.principal_type !== "agent") {
      return { ok: false, code: "unauthenticated" };
    }
    return {
      ok: true,
      context: SessionResponseSchema.parse({
        tenant: {
          id: membership.tenant_id,
          slug: membership.tenant_slug,
          display_name: membership.tenant_display_name,
        },
        principal: {
          id: principal.id,
          type: principal.principal_type,
          display_name: principal.display_name,
        },
        membership: { id: membership.id, role: membership.role },
        identities,
      }),
    };
  } catch {
    return { ok: false, code: "directory_unavailable" };
  }
}
