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
    const principal = await findActivePrincipal(session, subject.issuer, subject.subject);
    if (!principal) return { ok: false, code: "not_found" };

    if ((principal.principal_type === "agent" || principal.principal_type === "service") && !subject.token_id) {
      return { ok: false, code: "unauthenticated" };
    }
    if (subject.token_id && await isTokenRevoked(session, subject.issuer, subject.token_id)) {
      return { ok: false, code: "unauthenticated" };
    }

    const memberships = await listActiveMemberships(session, principal.id, tenantHint);
    if (memberships.length === 0) return { ok: false, code: "not_found" };
    if (memberships.length > 1 && !tenantHint) {
      return { ok: false, code: "tenant_selection_required" };
    }

    const [membership] = memberships;
    if (!membership) return { ok: false, code: "not_found" };
    const identities = await listAuthorizedIdentities(session, membership.id, membership.tenant_id);
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
