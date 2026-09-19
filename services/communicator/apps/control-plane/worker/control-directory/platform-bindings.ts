import {
  parsePrincipal,
  type AuthenticatedPrincipal,
  type PrincipalExpectations,
} from "@0000/contracts";

export type BindablePlatformPrincipal = Exclude<
  AuthenticatedPrincipal,
  { kind: "guest" }
>;

export type PlatformBindingFailureCode = "not_found" | "directory_unavailable";

export type LocalPrincipalKind = "human" | "operator" | "agent" | "service";
export type LocalMembershipRole = "owner" | "admin" | "member";

export type ResolvedPlatformBinding = Readonly<{
  bindingId: string;
  authority: string;
  kind: BindablePlatformPrincipal["kind"];
  subjectId: string;
  organizationId: string;
  platformMembershipId: string | null;
  platformGrantId: string | null;
  localTenantId: string;
  localPrincipalId: string;
  localPrincipalKind: LocalPrincipalKind;
  localMembershipId: string;
  localRole: LocalMembershipRole;
  localIdentityId: string | null;
  localInstallationId: string | null;
  localClientId: string | null;
}>;

export type PlatformBindingResolution =
  | { ok: true; binding: ResolvedPlatformBinding }
  | { ok: false; code: PlatformBindingFailureCode };

type PlatformBindingRow = {
  binding_id: string;
  platform_authority: string;
  platform_kind: string;
  platform_subject_id: string;
  platform_organization_id: string;
  platform_membership_id: string | null;
  platform_grant_id: string | null;
  local_tenant_id: string;
  local_principal_id: string;
  local_principal_kind: string;
  local_membership_id: string;
  local_role: string;
  local_identity_id: string | null;
  local_installation_id: string | null;
  local_client_id: string | null;
};

const localPrincipalKinds = new Set<LocalPrincipalKind>([
  "human",
  "operator",
  "agent",
  "service",
]);
const localMembershipRoles = new Set<LocalMembershipRole>([
  "owner",
  "admin",
  "member",
]);

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse an untrusted value with the shared versioned contract before it can be
 * used at this component boundary. The resolver itself still accepts only a
 * principal returned by the shared verifier's typed path.
 */
export function parseBindablePlatformPrincipal(
  value: unknown,
  expectations: PrincipalExpectations,
): BindablePlatformPrincipal | null {
  const principal = parsePrincipal(value, expectations);
  if (!principal || principal.kind === "guest" || !record(value)) return null;

  // The shared parser intentionally strips fields that belong to another
  // discriminant for wire compatibility. A binding is an authority tuple, so
  // reject those incoherent fields before it reaches the database resolver.
  if (Object.hasOwn(value, "resourceIds")) return null;
  if (principal.kind === "human" && Object.hasOwn(value, "grantId")) {
    return null;
  }
  if (
    (principal.kind === "agent" || principal.kind === "service") &&
    Object.hasOwn(value, "membershipId")
  ) {
    return null;
  }
  return principal;
}

function principalReference(principal: BindablePlatformPrincipal): {
  kind: BindablePlatformPrincipal["kind"];
  authority: string;
  subjectId: string;
  organizationId: string;
  referenceId: string;
  referenceColumn: "platform_membership_id" | "platform_grant_id";
} | null {
  if (principal.kind === "human") {
    return {
      kind: principal.kind,
      authority: principal.authority,
      subjectId: principal.subjectId,
      organizationId: principal.organizationId,
      referenceId: principal.membershipId,
      referenceColumn: "platform_membership_id",
    };
  }
  if (principal.kind === "agent" || principal.kind === "service") {
    return {
      kind: principal.kind,
      authority: principal.authority,
      subjectId: principal.subjectId,
      organizationId: principal.organizationId,
      referenceId: principal.grantId,
      referenceColumn: "platform_grant_id",
    };
  }
  return null;
}

function parseBindingRow(
  row: PlatformBindingRow,
): ResolvedPlatformBinding | null {
  if (
    !nonEmptyString(row.binding_id) ||
    !nonEmptyString(row.platform_authority) ||
    !nonEmptyString(row.platform_subject_id) ||
    !nonEmptyString(row.platform_organization_id) ||
    !nonEmptyString(row.local_tenant_id) ||
    !nonEmptyString(row.local_principal_id) ||
    !nonEmptyString(row.local_membership_id) ||
    (row.platform_kind !== "human" &&
      row.platform_kind !== "agent" &&
      row.platform_kind !== "service") ||
    !localPrincipalKinds.has(row.local_principal_kind as LocalPrincipalKind) ||
    !localMembershipRoles.has(row.local_role as LocalMembershipRole)
  ) {
    return null;
  }

  if (
    row.platform_kind === "human"
      ? !nonEmptyString(row.platform_membership_id) ||
        row.platform_grant_id !== null
      : row.platform_membership_id !== null ||
        !nonEmptyString(row.platform_grant_id)
  ) {
    return null;
  }

  for (const value of [
    row.local_identity_id,
    row.local_installation_id,
    row.local_client_id,
  ]) {
    if (value !== null && !nonEmptyString(value)) return null;
  }
  if ((row.local_installation_id === null) !== (row.local_client_id === null)) {
    return null;
  }

  return {
    bindingId: row.binding_id,
    authority: row.platform_authority,
    kind: row.platform_kind,
    subjectId: row.platform_subject_id,
    organizationId: row.platform_organization_id,
    platformMembershipId: row.platform_membership_id,
    platformGrantId: row.platform_grant_id,
    localTenantId: row.local_tenant_id,
    localPrincipalId: row.local_principal_id,
    localPrincipalKind: row.local_principal_kind as LocalPrincipalKind,
    localMembershipId: row.local_membership_id,
    localRole: row.local_role as LocalMembershipRole,
    localIdentityId: row.local_identity_id,
    localInstallationId: row.local_installation_id,
    localClientId: row.local_client_id,
  };
}

const baseBindingQuery = `
  SELECT
    b.binding_id,
    b.platform_authority,
    b.platform_kind,
    b.platform_subject_id,
    b.platform_organization_id,
    b.platform_membership_id,
    b.platform_grant_id,
    b.local_tenant_id,
    b.local_principal_id,
    p.principal_type AS local_principal_kind,
    b.local_membership_id,
    m.role AS local_role,
    i.id AS local_identity_id,
    oi.id AS local_installation_id,
    b.local_client_id
  FROM platform_bindings AS b
  JOIN tenants AS t
    ON t.id = b.local_tenant_id
   AND t.status = 'active'
  JOIN principals AS p
    ON p.id = b.local_principal_id
   AND p.status = 'active'
  JOIN memberships AS m
    ON m.tenant_id = b.local_tenant_id
   AND m.id = b.local_membership_id
   AND m.principal_id = b.local_principal_id
   AND m.status = 'active'
  LEFT JOIN identities AS i
    ON i.tenant_id = b.local_tenant_id
   AND i.id = b.local_identity_id
  LEFT JOIN oauth_client_installations AS oi
    ON oi.tenant_id = b.local_tenant_id
   AND oi.id = b.local_installation_id
  LEFT JOIN oauth_clients AS oc
    ON oc.client_id = b.local_client_id
  WHERE b.status = 'active'
    AND b.platform_authority = ?
    AND b.platform_kind = ?
    AND b.platform_subject_id = ?
    AND b.platform_organization_id = ?
    AND b.platform_membership_id IS ?
    AND b.platform_grant_id IS ?
    AND (
      (b.platform_kind = 'human' AND p.principal_type IN ('human', 'operator')) OR
      (b.platform_kind IN ('agent', 'service') AND p.principal_type = b.platform_kind)
    )
    AND (
      b.local_identity_id IS NULL OR (
        i.status = 'active' AND
        (
          (b.platform_kind = 'human' AND i.identity_kind = 'human') OR
          (b.platform_kind = 'agent' AND i.identity_kind = 'agent')
        ) AND EXISTS (
          SELECT 1
          FROM identity_grants AS ig
          WHERE ig.tenant_id = b.local_tenant_id
            AND ig.membership_id = b.local_membership_id
            AND ig.identity_id = b.local_identity_id
        )
      )
    )
    AND (
      b.local_installation_id IS NULL OR (
        oi.status = 'active' AND
        oc.status = 'active' AND
        oi.client_id = b.local_client_id AND
        oi.principal_id = b.local_principal_id AND
        oi.membership_id = b.local_membership_id AND
        oi.identity_id = b.local_identity_id
      )
    )`;

/**
 * Resolve one active, immutable binding for an already verified shared
 * Platform principal. This lookup is intentionally a single primary D1 read;
 * any query, invariant, or row-shape failure returns the fixed unavailable
 * result and never falls back to another issuer or local credential path.
 */
export async function resolvePlatformBinding(
  db: D1Database,
  principal: BindablePlatformPrincipal,
  tenantHint?: string,
): Promise<PlatformBindingResolution> {
  const reference = principalReference(principal);
  if (!reference) return { ok: false, code: "not_found" };

  const tenantClause =
    tenantHint === undefined ? "" : "\n    AND b.local_tenant_id = ?";
  const query = `${baseBindingQuery}${tenantClause}\n  LIMIT 2`;

  try {
    const values: unknown[] = [
      reference.authority,
      reference.kind,
      reference.subjectId,
      reference.organizationId,
      reference.referenceColumn === "platform_membership_id"
        ? reference.referenceId
        : null,
      reference.referenceColumn === "platform_grant_id"
        ? reference.referenceId
        : null,
    ];
    if (tenantHint !== undefined) values.push(tenantHint);

    const result = await db
      .withSession("first-primary")
      .prepare(query)
      .bind(...values)
      .all<PlatformBindingRow>();

    if (result.results.length === 0) return { ok: false, code: "not_found" };
    if (result.results.length !== 1) {
      return { ok: false, code: "directory_unavailable" };
    }
    const binding = parseBindingRow(result.results[0]!);
    return binding
      ? { ok: true, binding }
      : { ok: false, code: "directory_unavailable" };
  } catch {
    return { ok: false, code: "directory_unavailable" };
  }
}
