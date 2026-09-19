import type { GuestPrincipal } from "@0000/contracts";
import {
  hashOpaque,
  opaqueSecret,
  parseStringArray,
  validCapabilities,
  type ServiceRegistration,
} from "./platform-state";

export type GuestGrantAssertion =
  | { kind: "owner"; storedOwnerId: string }
  | { kind: "participant" };

export interface GuestIssuer {
  service: ServiceRegistration;
  issuerHash: string;
}

export interface GuestControl {
  guestId: string;
  bootstrapHash: string;
}

export interface GuestGrantSuccess {
  credential: string;
  credentialId: string;
  grantId: string;
  principal: GuestPrincipal;
}

export type GuestGrantMutationResult =
  | { status: "success"; value: GuestGrantSuccess }
  | { status: "invalid_guest_control" }
  | { status: "grant_denied" }
  | { status: "conflict" };

export class GuestGrantConflict extends Error {
  constructor() {
    super("Guest grant changed during renewal.");
    this.name = "GuestGrantConflict";
  }
}

export class GuestAuthorityUnavailable extends Error {
  constructor() {
    super("The guest grant issuer is no longer authorized.");
    this.name = "GuestAuthorityUnavailable";
  }
}

function validGuestResourceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export function parseGuestAssertion(
  value: unknown,
): GuestGrantAssertion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const assertion = value as Record<string, unknown>;
  if (assertion.kind === "owner") {
    return typeof assertion.storedOwnerId === "string" &&
      assertion.storedOwnerId.length > 0 &&
      assertion.storedOwnerId.length <= 512
      ? { kind: "owner", storedOwnerId: assertion.storedOwnerId }
      : null;
  }
  return assertion.kind === "participant" ? { kind: "participant" } : null;
}

function issuerAuthorityPredicate(capabilitiesExpression: string): string {
  return `
    EXISTS (
      SELECT 1
      FROM platform_service AS current_service
      JOIN platform_service_grant_issuer AS current_issuer
        ON current_issuer.service_id = current_service.service_id
      WHERE current_service.service_id = ?
        AND current_service.audience = ?
        AND current_service.disabled = 0
        AND current_issuer.credential_hash = ?
        AND current_issuer.disabled = 0
        AND EXISTS (
          SELECT 1 FROM json_each(current_issuer.capabilities) AS issuer_capability
          WHERE issuer_capability.value = 'guest:grant'
        )
        AND NOT EXISTS (
          SELECT 1 FROM json_each(${capabilitiesExpression}) AS requested
          WHERE NOT EXISTS (
            SELECT 1 FROM json_each(current_service.allowed_capabilities) AS catalog
            WHERE catalog.value = requested.value
          )
        )
    )`;
}

function grantCapabilityPredicate(
  capabilitiesExpression: string,
  grantExpression: string,
): string {
  return `
    NOT EXISTS (
      SELECT 1 FROM json_each(${capabilitiesExpression}) AS requested
      WHERE NOT EXISTS (
        SELECT 1 FROM json_each(${grantExpression}) AS granted
        WHERE granted.value = requested.value
      )
    )`;
}

function success(
  authority: string,
  input: {
    credential: string;
    credentialId: string;
    grantId: string;
    guestId: string;
    audience: string;
    capabilities: string[];
    resourceId: string;
  },
): GuestGrantMutationResult {
  return {
    status: "success",
    value: {
      credential: input.credential,
      credentialId: input.credentialId,
      grantId: input.grantId,
      principal: {
        version: 1,
        kind: "guest",
        authority,
        subjectId: input.guestId,
        credentialId: input.credentialId,
        audience: input.audience,
        capabilities: [...input.capabilities],
        expiresAt: null,
        grantId: input.grantId,
        resourceIds: [input.resourceId],
      },
    },
  };
}

export async function createGuestIdentity(
  database: D1Database,
  issuer: GuestIssuer,
): Promise<{ guestId: string; bootstrapCredential: string } | null> {
  const guestId = crypto.randomUUID();
  const bootstrapId = crypto.randomUUID();
  const bootstrapCredential = opaqueSecret("guest_control_");
  const createdAt = Date.now();
  const issuerPredicate = `EXISTS (
    SELECT 1
    FROM platform_service AS current_service
    JOIN platform_service_grant_issuer AS current_issuer
      ON current_issuer.service_id = current_service.service_id
    WHERE current_service.service_id = ?
      AND current_service.audience = ?
      AND current_service.disabled = 0
      AND current_issuer.credential_hash = ?
      AND current_issuer.disabled = 0
      AND EXISTS (
        SELECT 1 FROM json_each(current_issuer.capabilities) AS capability
        WHERE capability.value = 'guest:grant'
      )
  )`;
  const results = await database.batch([
    database
      .prepare(
        `INSERT INTO platform_guest (id, created_at)
         SELECT ?, ? WHERE ${issuerPredicate}`,
      )
      .bind(
        guestId,
        createdAt,
        issuer.service.serviceId,
        issuer.service.audience,
        issuer.issuerHash,
      ),
    database
      .prepare(
        `INSERT INTO platform_guest_bootstrap
         (id, credential_hash, guest_id, created_at, revoked_at)
         SELECT ?, ?, ?, ?, NULL
         WHERE EXISTS (SELECT 1 FROM platform_guest WHERE id = ?)
           AND ${issuerPredicate}`,
      )
      .bind(
        bootstrapId,
        await hashOpaque(bootstrapCredential),
        guestId,
        createdAt,
        guestId,
        issuer.service.serviceId,
        issuer.service.audience,
        issuer.issuerHash,
      ),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    await database
      .prepare("DELETE FROM platform_guest WHERE id = ?")
      .bind(guestId)
      .run();
    return null;
  }
  return { guestId, bootstrapCredential };
}

export async function resolveGuestControl(
  database: D1Database | D1DatabaseSession,
  bootstrapCredential: string,
  issuer?: GuestIssuer,
): Promise<GuestControl | null> {
  if (!bootstrapCredential) return null;
  const bootstrapHash = await hashOpaque(bootstrapCredential);
  const issuerProjection = issuer
    ? `${issuerAuthorityPredicate("'[]'")} AS issuer_valid`
    : "1 AS issuer_valid";
  const statement = database
    .prepare(
      `SELECT bootstrap.guest_id, ${issuerProjection}
       FROM platform_guest_bootstrap AS bootstrap
       JOIN platform_guest AS guest ON guest.id = bootstrap.guest_id
       WHERE bootstrap.credential_hash = ?
         AND bootstrap.revoked_at IS NULL
         AND guest.disabled_at IS NULL`,
    )
    .bind(
      ...(issuer
        ? [
            issuer.service.serviceId,
            issuer.service.audience,
            issuer.issuerHash,
            bootstrapHash,
          ]
        : [bootstrapHash]),
    );
  const row = await statement.first<{
    guest_id: string;
    issuer_valid: number;
  }>();
  if (row && issuer && row.issuer_valid !== 1) {
    throw new GuestAuthorityUnavailable();
  }
  return row ? { guestId: row.guest_id, bootstrapHash } : null;
}

export async function issueGuestGrant(
  database: D1Database,
  input: {
    issuer: GuestIssuer;
    authority: string;
    bootstrapCredential: string;
    resourceId: string;
    capabilities: string[];
    assertion: GuestGrantAssertion;
  },
): Promise<GuestGrantMutationResult> {
  if (
    !validGuestResourceId(input.resourceId) ||
    !validCapabilities(input.capabilities) ||
    !parseGuestAssertion(input.assertion) ||
    input.capabilities.some(
      (capability) =>
        !input.issuer.service.allowedCapabilities.includes(capability),
    )
  ) {
    return { status: "grant_denied" };
  }
  const control = await resolveGuestControl(
    database,
    input.bootstrapCredential,
    input.issuer,
  );
  if (!control) return { status: "invalid_guest_control" };
  if (
    input.assertion.kind === "owner" &&
    input.assertion.storedOwnerId !== control.guestId
  ) {
    return { status: "grant_denied" };
  }

  const credential = opaqueSecret("guest_grant_");
  const credentialId = crypto.randomUUID();
  const grantId = crypto.randomUUID();
  const now = Date.now();
  const capabilities = JSON.stringify(input.capabilities);
  const grantInsert = database
    .prepare(
      `INSERT INTO platform_guest_grant
       (id, guest_id, service_id, audience, resource_id, assertion_kind,
        capabilities, created_at, revoked_at, revoked_reason)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL
       WHERE EXISTS (
         SELECT 1 FROM platform_guest_bootstrap AS bootstrap
         JOIN platform_guest AS guest ON guest.id = bootstrap.guest_id
         WHERE bootstrap.credential_hash = ?
           AND bootstrap.guest_id = ?
           AND bootstrap.revoked_at IS NULL
           AND guest.disabled_at IS NULL
       )
         AND ${issuerAuthorityPredicate("?")}
         AND NOT EXISTS (
           SELECT 1 FROM platform_guest_grant
           WHERE guest_id = ? AND service_id = ? AND resource_id = ?
             AND revoked_at IS NULL
         )`,
    )
    .bind(
      grantId,
      control.guestId,
      input.issuer.service.serviceId,
      input.issuer.service.audience,
      input.resourceId,
      input.assertion.kind,
      capabilities,
      now,
      control.bootstrapHash,
      control.guestId,
      input.issuer.service.serviceId,
      input.issuer.service.audience,
      input.issuer.issuerHash,
      capabilities,
      control.guestId,
      input.issuer.service.serviceId,
      input.resourceId,
    );
  const credentialInsert = database
    .prepare(
      `INSERT INTO platform_credential
       (id, credential_hash, kind, subject_id, organization_id, membership_id,
        grant_id, audience, capabilities, resource_ids, expires_at, revoked_at,
        name, created_at, revoked_reason, replaced_by_id, predecessor_id)
       SELECT ?, ?, 'guest', guest_grant.guest_id, NULL, NULL, guest_grant.id,
              guest_grant.audience, guest_grant.capabilities,
              json_array(guest_grant.resource_id), NULL, NULL,
              'Guest resource grant', ?, NULL, NULL, NULL
       FROM platform_guest_grant AS guest_grant
       WHERE guest_grant.id = ? AND guest_grant.revoked_at IS NULL`,
    )
    .bind(credentialId, await hashOpaque(credential), now, grantId);
  try {
    const results = await database.batch([grantInsert, credentialInsert]);
    if (results[0]?.meta.changes !== 1) return { status: "conflict" };
    if (results[1]?.meta.changes !== 1) {
      throw new Error("Guest grant credential insertion was incomplete.");
    }
  } catch (error) {
    if (error instanceof Error && /unique|constraint/i.test(error.message)) {
      return { status: "conflict" };
    }
    throw error;
  }
  return success(input.authority, {
    credential,
    credentialId,
    grantId,
    guestId: control.guestId,
    audience: input.issuer.service.audience,
    capabilities: input.capabilities,
    resourceId: input.resourceId,
  });
}

export async function renewGuestGrant(
  database: D1Database,
  input: {
    issuer: GuestIssuer;
    authority: string;
    grantId: string;
    bootstrapCredential: string;
    resourceId: string;
    capabilities: string[];
    assertion: GuestGrantAssertion;
  },
): Promise<GuestGrantMutationResult> {
  if (
    !validGuestResourceId(input.resourceId) ||
    !validCapabilities(input.capabilities) ||
    !parseGuestAssertion(input.assertion)
  ) {
    return { status: "grant_denied" };
  }
  const control = await resolveGuestControl(
    database,
    input.bootstrapCredential,
    input.issuer,
  );
  if (!control) return { status: "invalid_guest_control" };
  const current = await database
    .prepare(
      `SELECT guest_grant.guest_id, guest_grant.service_id,
              guest_grant.audience, guest_grant.resource_id,
              guest_grant.assertion_kind, guest_grant.capabilities,
              credential.id AS credential_id
       FROM platform_guest_grant AS guest_grant
       JOIN platform_credential AS credential
         ON credential.grant_id = guest_grant.id
        AND credential.kind = 'guest'
        AND credential.revoked_at IS NULL
        AND credential.replaced_by_id IS NULL
       WHERE guest_grant.id = ?
         AND guest_grant.guest_id = ?
         AND guest_grant.service_id = ?
         AND guest_grant.audience = ?
         AND guest_grant.resource_id = ?
         AND guest_grant.revoked_at IS NULL`,
    )
    .bind(
      input.grantId,
      control.guestId,
      input.issuer.service.serviceId,
      input.issuer.service.audience,
      input.resourceId,
    )
    .first<{
      guest_id: string;
      service_id: string;
      audience: string;
      resource_id: string;
      assertion_kind: string;
      capabilities: string;
      credential_id: string;
    }>();
  if (!current) return { status: "grant_denied" };
  if (
    current.assertion_kind !== input.assertion.kind ||
    (input.assertion.kind === "owner" &&
      input.assertion.storedOwnerId !== control.guestId)
  ) {
    return { status: "grant_denied" };
  }
  const grantCapabilities = parseStringArray(current.capabilities);
  if (
    !grantCapabilities ||
    !validCapabilities(grantCapabilities) ||
    input.capabilities.some(
      (capability) =>
        !grantCapabilities.includes(capability) ||
        !input.issuer.service.allowedCapabilities.includes(capability),
    )
  ) {
    return { status: "grant_denied" };
  }

  const credential = opaqueSecret("guest_grant_");
  const credentialId = crypto.randomUUID();
  const now = Date.now();
  const requestedCapabilities = JSON.stringify(input.capabilities);
  const grantPredicate = `
    EXISTS (
      SELECT 1 FROM platform_guest_grant AS current_grant
      WHERE current_grant.id = ?
        AND current_grant.guest_id = ?
        AND current_grant.service_id = ?
        AND current_grant.audience = ?
        AND current_grant.resource_id = ?
        AND current_grant.assertion_kind = ?
        AND current_grant.revoked_at IS NULL
        AND ${grantCapabilityPredicate("?", "current_grant.capabilities")}
    )`;
  const update = database
    .prepare(
      `UPDATE platform_credential
       SET revoked_at = ?, revoked_reason = 'rotated', replaced_by_id = ?
       WHERE id = ? AND kind = 'guest' AND grant_id = ?
         AND subject_id = ? AND audience = ? AND revoked_at IS NULL
         AND replaced_by_id IS NULL
         AND EXISTS (
           SELECT 1 FROM platform_guest_bootstrap AS bootstrap
           WHERE bootstrap.credential_hash = ?
             AND bootstrap.guest_id = ? AND bootstrap.revoked_at IS NULL
             AND EXISTS (
               SELECT 1 FROM platform_guest
               WHERE platform_guest.id = bootstrap.guest_id
                 AND platform_guest.disabled_at IS NULL
             )
         )
         AND ${grantPredicate}
         AND ${issuerAuthorityPredicate("?")}`,
    )
    .bind(
      now,
      credentialId,
      current.credential_id,
      input.grantId,
      control.guestId,
      input.issuer.service.audience,
      control.bootstrapHash,
      control.guestId,
      input.grantId,
      control.guestId,
      input.issuer.service.serviceId,
      input.issuer.service.audience,
      input.resourceId,
      input.assertion.kind,
      requestedCapabilities,
      input.issuer.service.serviceId,
      input.issuer.service.audience,
      input.issuer.issuerHash,
      requestedCapabilities,
    );
  const insert = database
    .prepare(
      `INSERT INTO platform_credential
       (id, credential_hash, kind, subject_id, organization_id, membership_id,
        grant_id, audience, capabilities, resource_ids, expires_at, revoked_at,
        name, created_at, revoked_reason, replaced_by_id, predecessor_id)
       SELECT ?, ?, old.kind, old.subject_id, NULL, NULL, old.grant_id,
              old.audience, ?, json_array(?), NULL, NULL, old.name, ?, NULL,
              NULL, ?
       FROM platform_credential AS old
       WHERE old.id = ? AND old.kind = 'guest' AND old.grant_id = ?
         AND old.subject_id = ? AND old.audience = ?
         AND old.revoked_at = ? AND old.replaced_by_id = ?
         AND ${grantPredicate}`,
    )
    .bind(
      credentialId,
      await hashOpaque(credential),
      requestedCapabilities,
      input.resourceId,
      now,
      current.credential_id,
      current.credential_id,
      input.grantId,
      control.guestId,
      input.issuer.service.audience,
      now,
      credentialId,
      input.grantId,
      control.guestId,
      input.issuer.service.serviceId,
      input.issuer.service.audience,
      input.resourceId,
      input.assertion.kind,
      requestedCapabilities,
    );
  const results = await database.batch([update, insert]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    throw new GuestGrantConflict();
  }
  return success(input.authority, {
    credential,
    credentialId,
    grantId: input.grantId,
    guestId: control.guestId,
    audience: input.issuer.service.audience,
    capabilities: input.capabilities,
    resourceId: input.resourceId,
  });
}

export async function revokeGuestGrant(
  database: D1Database,
  input: { issuer: GuestIssuer; grantId: string },
): Promise<boolean> {
  const current = await database
    .prepare(
      `SELECT id FROM platform_guest_grant
       WHERE id = ? AND service_id = ? AND audience = ?`,
    )
    .bind(
      input.grantId,
      input.issuer.service.serviceId,
      input.issuer.service.audience,
    )
    .first<{ id: string }>();
  if (!current) return false;
  const now = Date.now();
  const results = await database.batch([
    database
      .prepare(
        `UPDATE platform_guest_grant
         SET revoked_at = COALESCE(revoked_at, ?),
             revoked_reason = COALESCE(revoked_reason, 'revoked')
         WHERE id = ? AND service_id = ? AND audience = ?
           AND ${issuerAuthorityPredicate("'[]'")}`,
      )
      .bind(
        now,
        input.grantId,
        input.issuer.service.serviceId,
        input.issuer.service.audience,
        input.issuer.service.serviceId,
        input.issuer.service.audience,
        input.issuer.issuerHash,
      ),
    database
      .prepare(
        `UPDATE platform_credential
         SET revoked_at = COALESCE(revoked_at, ?),
             revoked_reason = COALESCE(revoked_reason, 'grant_revoked')
         WHERE kind = 'guest' AND grant_id = ? AND revoked_at IS NULL
           AND ${issuerAuthorityPredicate("'[]'")}`,
      )
      .bind(
        now,
        input.grantId,
        input.issuer.service.serviceId,
        input.issuer.service.audience,
        input.issuer.issuerHash,
      ),
  ]);
  return results[0]?.meta.changes === 1;
}
