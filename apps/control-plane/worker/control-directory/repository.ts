import {
  AuthorizedIdentitySchema,
  type AuthorizedIdentity,
  type OperationScope,
  OperationScopeSchema,
} from "@communicator/contracts";

export type PrincipalRow = {
  id: string;
  principal_type: "human" | "service" | "agent" | "operator";
  display_name: string;
};

export type MembershipRow = {
  id: string;
  tenant_id: string;
  tenant_slug: string;
  tenant_display_name: string;
  role: "owner" | "admin" | "member";
};

const operationScopeOrder: OperationScope[] = [
  "conversation.read",
  "message.send",
  "message.mutate",
  "receipt.send",
  "connection.read",
  "connection.manage",
  "export.create",
  "replay.run",
  "retention.manage",
  "break_glass.inspect",
];

export async function findActivePrincipal(
  db: D1DatabaseSession,
  issuer: string,
  subject: string,
): Promise<PrincipalRow | null> {
  const result = await db.prepare(
    "SELECT id, principal_type, display_name FROM principals WHERE issuer = ? AND subject = ? AND status = 'active' LIMIT 1",
  ).bind(issuer, subject).first<PrincipalRow>();
  return result ?? null;
}

export async function listActiveMemberships(
  db: D1DatabaseSession,
  principalId: string,
  tenantHint?: string,
): Promise<MembershipRow[]> {
  const query = tenantHint
    ? "SELECT m.id, m.tenant_id, t.slug AS tenant_slug, t.display_name AS tenant_display_name, m.role FROM memberships AS m JOIN tenants AS t ON t.id = m.tenant_id WHERE m.principal_id = ? AND m.status = 'active' AND t.status = 'active' AND t.id = ? ORDER BY m.tenant_id, m.id"
    : "SELECT m.id, m.tenant_id, t.slug AS tenant_slug, t.display_name AS tenant_display_name, m.role FROM memberships AS m JOIN tenants AS t ON t.id = m.tenant_id WHERE m.principal_id = ? AND m.status = 'active' AND t.status = 'active' ORDER BY m.tenant_id, m.id";
  const statement = db.prepare(query);
  const result = tenantHint
    ? await statement.bind(principalId, tenantHint).all<MembershipRow>()
    : await statement.bind(principalId).all<MembershipRow>();
  return result.results;
}

export async function listAuthorizedIdentities(
  db: D1DatabaseSession,
  membershipId: string,
  tenantId: string,
): Promise<AuthorizedIdentity[]> {
  const result = await db.prepare(
    "SELECT i.id AS identity_id, i.identity_kind AS kind, i.display_name, g.operation_scope FROM identity_grants AS g JOIN identities AS i ON i.tenant_id = g.tenant_id AND i.id = g.identity_id WHERE g.tenant_id = ? AND g.membership_id = ? AND i.status = 'active' ORDER BY i.id",
  ).bind(tenantId, membershipId).all<{
    identity_id: string;
    kind: "human" | "agent";
    display_name: string;
    operation_scope: string;
  }>();

  const grouped = new Map<string, AuthorizedIdentity>();
  for (const row of result.results) {
    const existing = grouped.get(row.identity_id);
    const scope = OperationScopeSchema.parse(row.operation_scope);
    if (existing) {
      if (!existing.scopes.includes(scope)) existing.scopes.push(scope);
      continue;
    }
    grouped.set(row.identity_id, {
      identity_id: row.identity_id,
      kind: row.kind,
      display_name: row.display_name,
      scopes: [scope],
    });
  }

  return [...grouped.values()]
    .sort((left, right) => left.identity_id.localeCompare(right.identity_id))
    .map((identity) => AuthorizedIdentitySchema.parse({
      ...identity,
      scopes: [...identity.scopes].sort(
        (left, right) => operationScopeOrder.indexOf(left) - operationScopeOrder.indexOf(right),
      ),
    }));
}

export async function isTokenRevoked(
  db: D1DatabaseSession,
  issuer: string,
  tokenId: string,
): Promise<boolean> {
  const result = await db.prepare(
    "SELECT 1 AS revoked FROM revoked_tokens WHERE issuer = ? AND token_id = ? LIMIT 1",
  ).bind(issuer, tokenId).first<{ revoked: number }>();
  return result !== null;
}
