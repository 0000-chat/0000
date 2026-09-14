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

export type GrantReplacement = {
  idempotency_key: string;
  tenant_id: string;
  actor_principal_id: string;
  membership_id: string;
  grants: Array<{ identity_id: string; scopes: OperationScope[] }>;
  occurred_at: string;
};

export type MembershipStatusChange = {
  idempotency_key: string;
  tenant_id: string;
  actor_principal_id: string;
  membership_id: string;
  status: "active" | "disabled" | "revoked";
  occurred_at: string;
};

const operationScopeOrder: OperationScope[] = [
  "conversation.read",
  "conversation.create",
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

function canonicalizeGrants(
  grants: GrantReplacement["grants"],
): Array<{ identity_id: string; scopes: OperationScope[] }> {
  const grouped = new Map<string, Set<OperationScope>>();
  for (const grant of grants) {
    const scopes = grouped.get(grant.identity_id) ?? new Set<OperationScope>();
    for (const scope of grant.scopes)
      scopes.add(OperationScopeSchema.parse(scope));
    grouped.set(grant.identity_id, scopes);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([identity_id, scopes]) => ({
      identity_id,
      scopes: [...scopes].sort(
        (left, right) =>
          operationScopeOrder.indexOf(left) -
          operationScopeOrder.indexOf(right),
      ),
    }));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function findActivePrincipal(
  db: D1DatabaseSession,
  issuer: string,
  subject: string,
): Promise<PrincipalRow | null> {
  const result = await db
    .prepare(
      "SELECT id, principal_type, display_name FROM principals WHERE issuer = ? AND subject = ? AND status = 'active' LIMIT 1",
    )
    .bind(issuer, subject)
    .first<PrincipalRow>();
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
  const result = await db
    .prepare(
      "SELECT i.id AS identity_id, i.identity_kind AS kind, i.display_name, g.operation_scope FROM identity_grants AS g JOIN identities AS i ON i.tenant_id = g.tenant_id AND i.id = g.identity_id WHERE g.tenant_id = ? AND g.membership_id = ? AND i.status = 'active' ORDER BY i.id",
    )
    .bind(tenantId, membershipId)
    .all<{
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
    .map((identity) =>
      AuthorizedIdentitySchema.parse({
        ...identity,
        scopes: [...identity.scopes].sort(
          (left, right) =>
            operationScopeOrder.indexOf(left) -
            operationScopeOrder.indexOf(right),
        ),
      }),
    );
}

export async function isTokenRevoked(
  db: D1DatabaseSession,
  issuer: string,
  tokenId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      "SELECT 1 AS revoked FROM revoked_tokens WHERE issuer = ? AND token_id = ? LIMIT 1",
    )
    .bind(issuer, tokenId)
    .first<{ revoked: number }>();
  return result !== null;
}

export async function replaceIdentityGrants(
  db: D1Database,
  input: GrantReplacement,
): Promise<void> {
  const canonicalGrants = canonicalizeGrants(input.grants);
  const canonicalRequest = JSON.stringify({
    tenant_id: input.tenant_id,
    actor_principal_id: input.actor_principal_id,
    membership_id: input.membership_id,
    grants: canonicalGrants,
    occurred_at: input.occurred_at,
  });
  const requestHash = await sha256Hex(canonicalRequest);
  const payloadJson = JSON.stringify({
    tenant_id: input.tenant_id,
    actor_principal_id: input.actor_principal_id,
    membership_id: input.membership_id,
    grants: canonicalGrants,
  });

  const statements = [
    db
      .prepare(
        "INSERT INTO directory_mutations (idempotency_key, tenant_id, actor_principal_id, mutation_type, request_hash, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(idempotency_key) DO UPDATE SET request_hash = excluded.request_hash",
      )
      .bind(
        input.idempotency_key,
        input.tenant_id,
        input.actor_principal_id,
        "authorization.identity_grants.replaced",
        requestHash,
        input.occurred_at,
      ),
    db
      .prepare(
        "DELETE FROM identity_grants WHERE tenant_id = ? AND membership_id = ?",
      )
      .bind(input.tenant_id, input.membership_id),
    ...canonicalGrants.flatMap((grant) =>
      grant.scopes.map((scope) =>
        db
          .prepare(
            "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(
            input.tenant_id,
            input.membership_id,
            grant.identity_id,
            scope,
            input.occurred_at,
          ),
      ),
    ),
    db
      .prepare(
        "INSERT OR IGNORE INTO audit_events (id, tenant_id, actor_principal_id, action, target_type, target_id, reason, metadata_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        `audit_${input.idempotency_key}`,
        input.tenant_id,
        input.actor_principal_id,
        "authorization.identity_grants.replaced",
        "membership",
        input.membership_id,
        null,
        payloadJson,
        input.occurred_at,
      ),
    db
      .prepare(
        "INSERT OR IGNORE INTO control_event_outbox (event_id, tenant_id, event_type, aggregate_type, aggregate_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        `control_${input.idempotency_key}`,
        input.tenant_id,
        "authorization.identity_grants.replaced",
        "membership",
        input.membership_id,
        payloadJson,
        input.occurred_at,
      ),
  ];
  await db.batch(statements);
}

export async function setMembershipStatus(
  db: D1Database,
  input: MembershipStatusChange,
): Promise<void> {
  const canonicalRequest = JSON.stringify({
    tenant_id: input.tenant_id,
    actor_principal_id: input.actor_principal_id,
    membership_id: input.membership_id,
    status: input.status,
    occurred_at: input.occurred_at,
  });
  const requestHash = await sha256Hex(canonicalRequest);
  const payloadJson = JSON.stringify({
    tenant_id: input.tenant_id,
    membership_id: input.membership_id,
    status: input.status,
  });
  const revokedAt = input.status === "revoked" ? input.occurred_at : null;

  await db.batch([
    db
      .prepare(
        "INSERT INTO directory_mutations (idempotency_key, tenant_id, actor_principal_id, mutation_type, request_hash, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(idempotency_key) DO UPDATE SET request_hash = excluded.request_hash",
      )
      .bind(
        input.idempotency_key,
        input.tenant_id,
        input.actor_principal_id,
        "authorization.membership.updated",
        requestHash,
        input.occurred_at,
      ),
    db
      .prepare(
        "UPDATE memberships SET status = ?, revoked_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?",
      )
      .bind(
        input.status,
        revokedAt,
        input.occurred_at,
        input.tenant_id,
        input.membership_id,
      ),
    db
      .prepare(
        "INSERT OR IGNORE INTO audit_events (id, tenant_id, actor_principal_id, action, target_type, target_id, reason, metadata_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        `audit_${input.idempotency_key}`,
        input.tenant_id,
        input.actor_principal_id,
        "authorization.membership.updated",
        "membership",
        input.membership_id,
        null,
        payloadJson,
        input.occurred_at,
      ),
    db
      .prepare(
        "INSERT OR IGNORE INTO control_event_outbox (event_id, tenant_id, event_type, aggregate_type, aggregate_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        `control_${input.idempotency_key}`,
        input.tenant_id,
        "authorization.membership.updated",
        "membership",
        input.membership_id,
        payloadJson,
        input.occurred_at,
      ),
  ]);
}
