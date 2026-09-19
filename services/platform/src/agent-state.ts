import {
  CredentialRotationConflict,
  hashOpaque,
  isSafeCredentialExpiry,
  opaqueSecret,
  parseStringArray,
  validCapabilities,
  type CredentialMetadata,
  type ServiceRegistration,
} from "./platform-state";

export interface AgentRecord {
  id: string;
  organizationId: string;
  name: string;
  enabled: boolean;
  createdByUserId: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentGrantRecord {
  id: string;
  agentId: string;
  organizationId: string;
  serviceId: string;
  audience: string;
  capabilities: string[];
  createdAt: number;
  revokedAt: number | null;
  revokedReason: string | null;
}

export interface AgentCredentialMetadata extends CredentialMetadata {
  grantId: string;
}

export type AgentGrantMutation =
  | { status: "created" | "narrowed" | "unchanged"; grant: AgentGrantRecord }
  | { status: "not_found" | "conflict" | "widening" | "invalid" };

function credentialName(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  return normalized || "Agent API credential";
}

function managerPredicate(): string {
  return `
    EXISTS (
      SELECT 1 FROM member AS actor_member
      JOIN organization AS actor_org ON actor_org.id = actor_member.organizationId
      JOIN "user" AS actor_user ON actor_user.id = actor_member.userId
      WHERE actor_member.organizationId = ?
        AND actor_member.userId = ?
        AND actor_member.role IN ('owner', 'admin')
        AND actor_org.suspendedAt IS NULL
        AND actor_user.disabledAt IS NULL
    )`;
}

function catalogPredicate(capabilitiesExpression: string): string {
  return `
    EXISTS (
      SELECT 1 FROM platform_service AS live_service
      WHERE live_service.service_id = ?
        AND live_service.audience = ?
        AND live_service.disabled = 0
        AND NOT EXISTS (
          SELECT 1 FROM json_each(${capabilitiesExpression}) AS requested
          WHERE NOT EXISTS (
            SELECT 1 FROM json_each(live_service.allowed_capabilities) AS catalog
            WHERE catalog.value = requested.value
          )
        )
    )`;
}

function parseAgent(row: {
  id: string;
  organization_id: string;
  name: string;
  enabled: number;
  created_by_user_id: string;
  created_at: number;
  updated_at: number;
}): AgentRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    enabled: row.enabled === 1,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseGrant(row: {
  id: string;
  agent_id: string;
  organization_id: string;
  service_id: string;
  audience: string;
  capabilities: string;
  created_at: number;
  revoked_at: number | null;
  revoked_reason: string | null;
}): AgentGrantRecord | null {
  const capabilities = parseStringArray(row.capabilities);
  if (!capabilities || !validCapabilities(capabilities)) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    organizationId: row.organization_id,
    serviceId: row.service_id,
    audience: row.audience,
    capabilities,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
  };
}

async function readGrant(
  database: D1Database | D1DatabaseSession,
  grantId: string,
): Promise<AgentGrantRecord | null> {
  const row = await database
    .prepare(
      `SELECT id, agent_id, organization_id, service_id, audience,
              capabilities, created_at, revoked_at, revoked_reason
       FROM platform_agent_grant WHERE id = ?`,
    )
    .bind(grantId)
    .first<{
      id: string;
      agent_id: string;
      organization_id: string;
      service_id: string;
      audience: string;
      capabilities: string;
      created_at: number;
      revoked_at: number | null;
      revoked_reason: string | null;
    }>();
  return row ? parseGrant(row) : null;
}

export async function listOrganizationAgents(
  database: D1DatabaseSession,
  organizationId: string,
): Promise<AgentRecord[]> {
  const rows = await database
    .prepare(
      `SELECT id, organization_id, name, enabled, created_by_user_id,
              created_at, updated_at
       FROM platform_agent
       WHERE organization_id = ?
       ORDER BY lower(name), id`,
    )
    .bind(organizationId)
    .all<{
      id: string;
      organization_id: string;
      name: string;
      enabled: number;
      created_by_user_id: string;
      created_at: number;
      updated_at: number;
    }>();
  return rows.results.map(parseAgent);
}

export async function createAgent(
  database: D1Database,
  input: {
    actorUserId: string;
    organizationId: string;
    name: string;
  },
): Promise<AgentRecord | null> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const inserted = await database
    .prepare(
      `INSERT INTO platform_agent
         (id, organization_id, name, enabled, created_by_user_id, created_at, updated_at)
       SELECT ?, ?, ?, 1, ?, ?, ?
       WHERE ${managerPredicate()}`,
    )
    .bind(
      id,
      input.organizationId,
      input.name,
      input.actorUserId,
      now,
      now,
      input.organizationId,
      input.actorUserId,
    )
    .run();
  if (inserted.meta.changes !== 1) return null;
  const row = await database
    .prepare(
      `SELECT id, organization_id, name, enabled, created_by_user_id,
              created_at, updated_at
       FROM platform_agent WHERE id = ? AND organization_id = ?`,
    )
    .bind(id, input.organizationId)
    .first<{
      id: string;
      organization_id: string;
      name: string;
      enabled: number;
      created_by_user_id: string;
      created_at: number;
      updated_at: number;
    }>();
  return row ? parseAgent(row) : null;
}

export async function renameAgent(
  database: D1DatabaseSession,
  input: {
    actorUserId: string;
    organizationId: string;
    agentId: string;
    name: string;
  },
): Promise<boolean> {
  const result = await database
    .prepare(
      `UPDATE platform_agent
       SET name = ?, updated_at = ?
       WHERE id = ? AND organization_id = ?
         AND ${managerPredicate()}`,
    )
    .bind(
      input.name,
      Date.now(),
      input.agentId,
      input.organizationId,
      input.organizationId,
      input.actorUserId,
    )
    .run();
  return result.meta.changes === 1;
}

export async function setAgentEnabled(
  database: D1DatabaseSession,
  input: {
    actorUserId: string;
    organizationId: string;
    agentId: string;
    enabled: boolean;
  },
): Promise<boolean> {
  const result = await database
    .prepare(
      `UPDATE platform_agent
       SET enabled = ?, updated_at = ?
       WHERE id = ? AND organization_id = ?
         AND ${managerPredicate()}`,
    )
    .bind(
      input.enabled ? 1 : 0,
      Date.now(),
      input.agentId,
      input.organizationId,
      input.organizationId,
      input.actorUserId,
    )
    .run();
  return result.meta.changes === 1;
}

export async function listAgentGrants(
  database: D1DatabaseSession,
  input: { organizationId: string; agentId: string },
): Promise<AgentGrantRecord[]> {
  const rows = await database
    .prepare(
      `SELECT id, agent_id, organization_id, service_id, audience,
              capabilities, created_at, revoked_at, revoked_reason
       FROM platform_agent_grant
       WHERE organization_id = ? AND agent_id = ?
       ORDER BY created_at DESC, id`,
    )
    .bind(input.organizationId, input.agentId)
    .all<{
      id: string;
      agent_id: string;
      organization_id: string;
      service_id: string;
      audience: string;
      capabilities: string;
      created_at: number;
      revoked_at: number | null;
      revoked_reason: string | null;
    }>();
  return rows.results.flatMap((row) => {
    const grant = parseGrant(row);
    return grant ? [grant] : [];
  });
}

export async function createOrNarrowAgentGrant(
  database: D1DatabaseSession,
  input: {
    actorUserId: string;
    organizationId: string;
    agentId: string;
    service: ServiceRegistration;
    capabilities: string[];
  },
): Promise<AgentGrantMutation> {
  if (
    !validCapabilities(input.capabilities) ||
    input.capabilities.some(
      (capability) => !input.service.allowedCapabilities.includes(capability),
    )
  ) {
    return { status: "invalid" };
  }

  const manager = await database
    .prepare(`SELECT 1 AS authorized WHERE ${managerPredicate()}`)
    .bind(input.organizationId, input.actorUserId)
    .first<{ authorized: number }>();
  if (!manager) return { status: "not_found" };

  const currentRow = await database
    .prepare(
      `SELECT id, agent_id, organization_id, service_id, audience,
              capabilities, created_at, revoked_at, revoked_reason
       FROM platform_agent_grant
       WHERE organization_id = ? AND agent_id = ? AND service_id = ?
         AND revoked_at IS NULL
         AND EXISTS (
           SELECT 1 FROM platform_agent
           WHERE platform_agent.id = platform_agent_grant.agent_id
             AND platform_agent.organization_id = ?
         )`,
    )
    .bind(
      input.organizationId,
      input.agentId,
      input.service.serviceId,
      input.organizationId,
    )
    .first<{
      id: string;
      agent_id: string;
      organization_id: string;
      service_id: string;
      audience: string;
      capabilities: string;
      created_at: number;
      revoked_at: number | null;
      revoked_reason: string | null;
    }>();

  if (currentRow) {
    const current = parseGrant(currentRow);
    if (!current) return { status: "invalid" };
    const currentSet = new Set(current.capabilities);
    const requestedSet = new Set(input.capabilities);
    if ([...requestedSet].some((capability) => !currentSet.has(capability))) {
      return { status: "widening" };
    }
    if (requestedSet.size === currentSet.size) {
      return { status: "unchanged", grant: current };
    }
    const narrowed = await database
      .prepare(
        `UPDATE platform_agent_grant
         SET capabilities = ?
         WHERE id = ? AND organization_id = ? AND agent_id = ?
           AND revoked_at IS NULL
           AND EXISTS (
             SELECT 1 FROM platform_agent
             WHERE platform_agent.id = platform_agent_grant.agent_id
               AND platform_agent.organization_id = ?
           )
           AND ${managerPredicate()}`,
      )
      .bind(
        JSON.stringify(input.capabilities),
        current.id,
        input.organizationId,
        input.agentId,
        input.organizationId,
        input.organizationId,
        input.actorUserId,
      )
      .run();
    if (narrowed.meta.changes !== 1) return { status: "conflict" };
    const grant = await readGrant(database, current.id);
    return grant ? { status: "narrowed", grant } : { status: "conflict" };
  }

  const grantId = crypto.randomUUID();
  const now = Date.now();
  const inserted = await database
    .prepare(
      `INSERT INTO platform_agent_grant
         (id, agent_id, organization_id, service_id, audience, capabilities, created_at, revoked_at, revoked_reason)
       SELECT ?, ?, ?, ?, ?, ?, ?, NULL, NULL
       WHERE ${managerPredicate()}
         AND EXISTS (
           SELECT 1 FROM platform_agent AS agent
           WHERE agent.id = ? AND agent.organization_id = ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM platform_agent_grant AS current_grant
           WHERE current_grant.agent_id = ? AND current_grant.service_id = ?
             AND current_grant.revoked_at IS NULL
         )
         AND ${catalogPredicate("?")}`,
    )
    .bind(
      grantId,
      input.agentId,
      input.organizationId,
      input.service.serviceId,
      input.service.audience,
      JSON.stringify(input.capabilities),
      now,
      input.organizationId,
      input.actorUserId,
      input.agentId,
      input.organizationId,
      input.agentId,
      input.service.serviceId,
      input.service.serviceId,
      input.service.audience,
      JSON.stringify(input.capabilities),
    )
    .run();
  if (inserted.meta.changes !== 1) return { status: "conflict" };
  const grant = await readGrant(database, grantId);
  return grant ? { status: "created", grant } : { status: "conflict" };
}

export async function revokeAgentGrant(
  database: D1DatabaseSession,
  input: {
    actorUserId: string;
    organizationId: string;
    agentId: string;
    grantId: string;
  },
): Promise<boolean> {
  const manager = await database
    .prepare(`SELECT 1 AS authorized WHERE ${managerPredicate()}`)
    .bind(input.organizationId, input.actorUserId)
    .first<{ authorized: number }>();
  if (!manager) return false;
  const target = await database
    .prepare(
      `SELECT id FROM platform_agent_grant
       WHERE id = ? AND organization_id = ? AND agent_id = ?
         AND EXISTS (
           SELECT 1 FROM platform_agent
           WHERE platform_agent.id = platform_agent_grant.agent_id
             AND platform_agent.organization_id = ?
         )`,
    )
    .bind(
      input.grantId,
      input.organizationId,
      input.agentId,
      input.organizationId,
    )
    .first<{ id: string }>();
  if (!target) return false;
  const now = Date.now();
  await database.batch([
    database
      .prepare(
        `UPDATE platform_agent_grant
         SET revoked_at = COALESCE(revoked_at, ?),
             revoked_reason = COALESCE(revoked_reason, 'revoked')
         WHERE id = ? AND organization_id = ? AND agent_id = ?
           AND EXISTS (
             SELECT 1 FROM platform_agent
             WHERE platform_agent.id = platform_agent_grant.agent_id
               AND platform_agent.organization_id = ?
           )
           AND ${managerPredicate()}`,
      )
      .bind(
        now,
        input.grantId,
        input.organizationId,
        input.agentId,
        input.organizationId,
        input.organizationId,
        input.actorUserId,
      ),
    database
      .prepare(
        `UPDATE platform_credential
         SET revoked_at = COALESCE(revoked_at, ?),
             revoked_reason = COALESCE(revoked_reason, 'grant_revoked')
         WHERE kind = 'agent' AND grant_id = ?
           AND subject_id = ? AND organization_id = ?
           AND membership_id IS NULL AND revoked_at IS NULL
           AND ${managerPredicate()}`,
      )
      .bind(
        now,
        input.grantId,
        input.agentId,
        input.organizationId,
        input.organizationId,
        input.actorUserId,
      ),
  ]);
  const active = await database
    .prepare(
      `SELECT id FROM platform_agent_grant
       WHERE id = ? AND organization_id = ? AND agent_id = ?
         AND EXISTS (
           SELECT 1 FROM platform_agent
           WHERE platform_agent.id = platform_agent_grant.agent_id
             AND platform_agent.organization_id = ?
         )
         AND revoked_at IS NOT NULL`,
    )
    .bind(
      input.grantId,
      input.organizationId,
      input.agentId,
      input.organizationId,
    )
    .first<{ id: string }>();
  return active !== null;
}

export async function issueAgentCredential(
  database: D1Database,
  input: {
    actorUserId: string;
    service: ServiceRegistration;
    organizationId: string;
    agentId: string;
    grantId: string;
    capabilities: string[];
    name?: string;
    expiresAt: number;
  },
): Promise<{ credential: string; credentialId: string; expiresAt: number }> {
  if (
    !validCapabilities(input.capabilities) ||
    input.capabilities.some(
      (capability) => !input.service.allowedCapabilities.includes(capability),
    ) ||
    !isSafeCredentialExpiry(input.expiresAt)
  ) {
    throw new RangeError("Requested agent credential grant is invalid");
  }
  const credential = opaqueSecret("0000_agent_");
  const credentialHash = await hashOpaque(credential);
  const credentialId = crypto.randomUUID();
  const createdAt = Date.now();
  const requestedCapabilities = JSON.stringify(input.capabilities);
  const inserted = await database
    .prepare(
      `INSERT INTO platform_credential
       (id, credential_hash, kind, subject_id, organization_id, membership_id, grant_id,
        audience, capabilities, resource_ids, expires_at, revoked_at, name, created_at,
        revoked_reason, replaced_by_id, predecessor_id)
       SELECT ?, ?, 'agent', ?, ?, NULL, ?, ?, ?, '[]', ?, NULL, ?, ?, NULL, NULL, NULL
       WHERE ${managerPredicate()}
         AND EXISTS (
           SELECT 1 FROM platform_agent AS agent
           JOIN organization AS owning_org ON owning_org.id = agent.organization_id
           WHERE agent.id = ? AND agent.organization_id = ?
             AND agent.enabled = 1 AND owning_org.suspendedAt IS NULL
         )
         AND EXISTS (
           SELECT 1 FROM platform_agent_grant AS agent_grant
           WHERE agent_grant.id = ? AND agent_grant.agent_id = ?
             AND agent_grant.organization_id = ?
             AND agent_grant.service_id = ?
             AND agent_grant.audience = ?
             AND agent_grant.revoked_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM json_each(?) AS requested
               WHERE NOT EXISTS (
                 SELECT 1 FROM json_each(agent_grant.capabilities) AS granted
                 WHERE granted.value = requested.value
               )
             )
         )
         AND ${catalogPredicate("?")}`,
    )
    .bind(
      credentialId,
      credentialHash,
      input.agentId,
      input.organizationId,
      input.grantId,
      input.service.audience,
      requestedCapabilities,
      input.expiresAt,
      credentialName(input.name),
      createdAt,
      input.organizationId,
      input.actorUserId,
      input.agentId,
      input.organizationId,
      input.grantId,
      input.agentId,
      input.organizationId,
      input.service.serviceId,
      input.service.audience,
      requestedCapabilities,
      input.service.serviceId,
      input.service.audience,
      requestedCapabilities,
    )
    .run();
  if (inserted.meta.changes !== 1) {
    throw new RangeError("Current agent grant is required");
  }
  return { credential, credentialId, expiresAt: input.expiresAt };
}

export async function listAgentCredentials(
  database: D1DatabaseSession,
  input: { organizationId: string; agentId: string },
): Promise<AgentCredentialMetadata[]> {
  const rows = await database
    .prepare(
      `SELECT id, name, created_at, grant_id, audience, capabilities, expires_at,
              revoked_at, revoked_reason, replaced_by_id, predecessor_id
       FROM platform_credential
       WHERE kind = 'agent' AND subject_id = ? AND organization_id = ?
       ORDER BY created_at DESC, id`,
    )
    .bind(input.agentId, input.organizationId)
    .all<{
      id: string;
      name: string;
      created_at: number;
      grant_id: string | null;
      audience: string;
      capabilities: string;
      expires_at: number | null;
      revoked_at: number | null;
      revoked_reason: string | null;
      replaced_by_id: string | null;
      predecessor_id: string | null;
    }>();
  return rows.results.flatMap((row) => {
    const capabilities = parseStringArray(row.capabilities);
    return row.grant_id &&
      capabilities &&
      validCapabilities(capabilities) &&
      row.expires_at !== null &&
      isSafeCredentialExpiry(row.expires_at, 0)
      ? [
          {
            id: row.id,
            name: row.name || "Agent API credential",
            createdAt: row.created_at,
            grantId: row.grant_id,
            audience: row.audience,
            capabilities,
            expiresAt: row.expires_at,
            revokedAt: row.revoked_at,
            revokedReason: row.revoked_reason,
            replacedById: row.replaced_by_id,
            predecessorId: row.predecessor_id,
          },
        ]
      : [];
  });
}

export async function rotateAgentCredential(
  database: D1Database,
  input: {
    actorUserId: string;
    service: ServiceRegistration;
    organizationId: string;
    agentId: string;
    grantId: string;
    credentialId: string;
    expiresAt: number;
  },
): Promise<{ credential: string; credentialId: string; expiresAt: number }> {
  if (!isSafeCredentialExpiry(input.expiresAt)) {
    throw new RangeError("Requested credential lifetime is invalid");
  }
  const credential = opaqueSecret("0000_agent_");
  const credentialHash = await hashOpaque(credential);
  const replacementId = crypto.randomUUID();
  const now = Date.now();
  const manager = managerPredicate();
  const grantValidity = (credentialCapabilities: string) => `
    EXISTS (
      SELECT 1 FROM platform_agent_grant AS current_grant
      WHERE current_grant.id = ? AND current_grant.agent_id = ?
        AND current_grant.organization_id = ?
        AND current_grant.service_id = ?
        AND current_grant.audience = ?
        AND current_grant.revoked_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM json_each(${credentialCapabilities}) AS requested
          WHERE NOT EXISTS (
            SELECT 1 FROM json_each(current_grant.capabilities) AS granted
            WHERE granted.value = requested.value
          )
        )
    )`;
  await database.batch([
    database
      .prepare(
        `UPDATE platform_credential
         SET revoked_at = ?, revoked_reason = 'rotated', replaced_by_id = ?
         WHERE id = ? AND kind = 'agent' AND subject_id = ?
           AND organization_id = ? AND membership_id IS NULL AND grant_id = ?
           AND audience = ? AND revoked_at IS NULL
           AND expires_at > ? AND replaced_by_id IS NULL
           AND ${manager}
           AND EXISTS (
             SELECT 1 FROM platform_agent AS agent
             JOIN organization AS owning_org ON owning_org.id = agent.organization_id
             WHERE agent.id = ? AND agent.organization_id = ?
               AND agent.enabled = 1 AND owning_org.suspendedAt IS NULL
           )
           AND ${grantValidity("platform_credential.capabilities")}
           AND ${catalogPredicate("capabilities")}`,
      )
      .bind(
        now,
        replacementId,
        input.credentialId,
        input.agentId,
        input.organizationId,
        input.grantId,
        input.service.audience,
        now,
        input.organizationId,
        input.actorUserId,
        input.agentId,
        input.organizationId,
        input.grantId,
        input.agentId,
        input.organizationId,
        input.service.serviceId,
        input.service.audience,
        input.service.serviceId,
        input.service.audience,
      ),
    database
      .prepare(
        `INSERT INTO platform_credential
         (id, credential_hash, kind, subject_id, organization_id, membership_id, grant_id,
          audience, capabilities, resource_ids, expires_at, revoked_at, name, created_at,
          revoked_reason, replaced_by_id, predecessor_id)
         SELECT ?, ?, old.kind, old.subject_id, old.organization_id, NULL, old.grant_id,
                old.audience, old.capabilities, old.resource_ids, ?, NULL, old.name, ?, NULL, NULL, ?
         FROM platform_credential AS old
         WHERE old.id = ? AND old.kind = 'agent' AND old.subject_id = ?
           AND old.organization_id = ? AND old.membership_id IS NULL AND old.grant_id = ?
           AND old.audience = ? AND old.replaced_by_id = ? AND old.revoked_at = ?
           AND ${manager}
           AND EXISTS (
             SELECT 1 FROM platform_agent AS agent
             JOIN organization AS owning_org ON owning_org.id = agent.organization_id
             WHERE agent.id = ? AND agent.organization_id = ?
               AND agent.enabled = 1 AND owning_org.suspendedAt IS NULL
           )
           AND ${grantValidity("old.capabilities")}
           AND ${catalogPredicate("old.capabilities")}`,
      )
      .bind(
        replacementId,
        credentialHash,
        input.expiresAt,
        now,
        input.credentialId,
        input.credentialId,
        input.agentId,
        input.organizationId,
        input.grantId,
        input.service.audience,
        replacementId,
        now,
        input.organizationId,
        input.actorUserId,
        input.agentId,
        input.organizationId,
        input.grantId,
        input.agentId,
        input.organizationId,
        input.service.serviceId,
        input.service.audience,
        input.service.serviceId,
        input.service.audience,
      ),
  ]);
  const replacement = await database
    .prepare(
      `SELECT id FROM platform_credential
       WHERE id = ? AND kind = 'agent' AND predecessor_id = ?
         AND credential_hash = ? AND revoked_at IS NULL`,
    )
    .bind(replacementId, input.credentialId, credentialHash)
    .first<{ id: string }>();
  if (!replacement) throw new CredentialRotationConflict();
  return {
    credential,
    credentialId: replacementId,
    expiresAt: input.expiresAt,
  };
}

export async function revokeAgentCredential(
  database: D1DatabaseSession,
  input: {
    actorUserId: string;
    organizationId: string;
    agentId: string;
    credentialId: string;
  },
): Promise<boolean> {
  const result = await database
    .prepare(
      `UPDATE platform_credential
       SET revoked_at = COALESCE(revoked_at, ?),
           revoked_reason = COALESCE(revoked_reason, 'revoked')
       WHERE id = ? AND kind = 'agent' AND subject_id = ?
         AND organization_id = ? AND membership_id IS NULL
         AND EXISTS (
           SELECT 1 FROM platform_agent
           WHERE platform_agent.id = platform_credential.subject_id
             AND platform_agent.organization_id = ?
         )
         AND ${managerPredicate()}`,
    )
    .bind(
      Date.now(),
      input.credentialId,
      input.agentId,
      input.organizationId,
      input.organizationId,
      input.organizationId,
      input.actorUserId,
    )
    .run();
  return result.meta.changes === 1;
}
