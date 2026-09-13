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

export type AuthorizationFailureCode =
  | "unauthenticated"
  | "not_found"
  | "tenant_selection_required"
  | "directory_unavailable";

export type AuthorizationResult =
  | { ok: true; context: SessionResponse }
  | { ok: false; code: AuthorizationFailureCode };

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
