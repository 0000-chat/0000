const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DATE_MS = 8_640_000_000_000_000;
const DEFAULT_CREDENTIAL_LIFETIME_DAYS = 90;

export interface DefaultOrganization {
  organizationId: string;
  membershipId: string;
}

export interface ServiceRegistration {
  serviceId: string;
  audience: string;
  verifierHash: string;
  allowedCapabilities: string[];
  displayName?: string;
}

export interface CredentialMetadata {
  id: string;
  name: string;
  createdAt: number;
  audience: string;
  capabilities: string[];
  expiresAt: number;
  revokedAt: number | null;
  revokedReason: string | null;
  replacedById: string | null;
  predecessorId: string | null;
}

export class CredentialRotationConflict extends Error {
  constructor() {
    super("Credential rotation lost the predecessor race");
    this.name = "CredentialRotationConflict";
  }
}

export async function hashOpaque(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function opaqueSecret(prefix: string): string {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const encoded = btoa(String.fromCharCode(...random))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `${prefix}${encoded}`;
}

export function validServiceId(value: unknown): value is string {
  return (
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
  );
}

/** Service audiences are exact HTTPS URLs without credentials, query or fragment aliases. */
export function validServiceAudience(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      (value === parsed.origin || value === parsed.href)
    );
  } catch {
    return false;
  }
}

export function validCapability(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,63}$/.test(value)
  );
}

export function validCapabilities(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(validCapability) &&
    new Set(value).size === value.length
  );
}

/** Parse a JSON array without allowing malformed or empty entries. */
export function parseStringArray(value: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string" && item.length > 0)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function stableId(prefix: string, userId: string): Promise<string> {
  return hashOpaque(`platform-default:${prefix}:${userId}`).then(
    (digest) => `${prefix}_${digest.slice(0, 32)}`,
  );
}

export async function ensureDefaultOrganization(
  database: D1Database,
  user: { id: string; name: string },
): Promise<DefaultOrganization> {
  const [organizationId, membershipId] = await Promise.all([
    stableId("org", user.id),
    stableId("member", user.id),
  ]);
  const slug = `default-${organizationId.slice(4, 24)}`;
  const createdAt = Date.now();
  const bootstrapNonce = opaqueSecret("bootstrap_");
  await database.batch([
    database
      .prepare(
        `INSERT OR IGNORE INTO platform_default_organization
       (user_id, organization_id, membership_id, bootstrap_nonce, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(user.id, organizationId, membershipId, bootstrapNonce, createdAt),
    database
      .prepare(
        `INSERT OR IGNORE INTO organization (id, name, slug, createdAt)
       SELECT ?, ?, ?, ? WHERE EXISTS (
         SELECT 1 FROM platform_default_organization WHERE user_id = ? AND bootstrap_nonce = ?
       )`,
      )
      .bind(
        organizationId,
        `${user.name || "User"}'s organization`,
        slug,
        createdAt,
        user.id,
        bootstrapNonce,
      ),
    database
      .prepare(
        `INSERT OR IGNORE INTO member (id, organizationId, userId, role, createdAt)
       SELECT membership_id, organization_id, user_id, 'owner', created_at
       FROM platform_default_organization WHERE user_id = ? AND bootstrap_nonce = ?`,
      )
      .bind(user.id, bootstrapNonce),
  ]);
  const receipt = await database
    .prepare(
      "SELECT organization_id, membership_id, bootstrap_nonce FROM platform_default_organization WHERE user_id = ?",
    )
    .bind(user.id)
    .first<{
      organization_id: string;
      membership_id: string;
      bootstrap_nonce: string;
    }>();
  if (!receipt)
    throw new Error("Default organization bootstrap receipt is missing");
  if (receipt.bootstrap_nonce === bootstrapNonce) {
    const ownerMembership = await database
      .prepare(
        "SELECT id, organizationId, userId, role FROM member WHERE id = ?",
      )
      .bind(receipt.membership_id)
      .first<{
        id: string;
        organizationId: string;
        userId: string;
        role: string;
      }>();
    if (
      !ownerMembership ||
      ownerMembership.organizationId !== receipt.organization_id ||
      ownerMembership.userId !== user.id ||
      ownerMembership.role !== "owner"
    ) {
      throw new Error(
        "Default organization owner membership could not be confirmed",
      );
    }
  }
  return {
    organizationId: receipt.organization_id,
    membershipId: receipt.membership_id,
  };
}

function catalogPredicate(capabilitiesJsonParameter = "?"): string {
  return `
    EXISTS (
      SELECT 1 FROM platform_service AS live_service
      WHERE live_service.service_id = ?
        AND live_service.audience = ?
        AND live_service.disabled = 0
        AND NOT EXISTS (
          SELECT 1 FROM json_each(${capabilitiesJsonParameter}) AS requested
          WHERE NOT EXISTS (
            SELECT 1 FROM json_each(live_service.allowed_capabilities) AS catalog
            WHERE catalog.value = requested.value
          )
        )
    )`;
}

function credentialName(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  return normalized || "Personal API credential";
}

export function isSafeCredentialExpiry(
  expiresAt: number,
  now = Date.now(),
): boolean {
  return (
    Number.isSafeInteger(expiresAt) &&
    expiresAt > now &&
    expiresAt <= MAX_DATE_MS
  );
}

export function parseConfiguredCredentialLifetimeDays(
  raw: unknown,
): number | null {
  const value =
    raw === undefined || raw === null
      ? `${DEFAULT_CREDENTIAL_LIFETIME_DAYS}`
      : raw;
  if (
    typeof value !== "string" ||
    !/^[0-9]+(?:\.[0-9]+)?$/.test(value.trim())
  ) {
    return null;
  }
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) return null;
  if (days * DAY_MS > MAX_DATE_MS - Date.now()) return null;
  return days;
}

export function resolveCredentialExpiry(
  maxDays: number | null,
  requestedDays: unknown,
  now = Date.now(),
): number | null {
  if (maxDays === null) return null;
  if (
    requestedDays !== undefined &&
    (typeof requestedDays !== "number" ||
      !Number.isFinite(requestedDays) ||
      requestedDays <= 0 ||
      requestedDays > maxDays)
  ) {
    return null;
  }
  const days = requestedDays === undefined ? maxDays : requestedDays;
  const expiresAt = Math.floor(now + days * DAY_MS);
  return isSafeCredentialExpiry(expiresAt, now) ? expiresAt : null;
}

export async function listActiveServices(
  database: D1DatabaseSession,
): Promise<ServiceRegistration[]> {
  const rows = await database
    .prepare(
      `SELECT service_id, audience, verifier_hash, allowed_capabilities, display_name
       FROM platform_service WHERE disabled = 0 ORDER BY service_id`,
    )
    .all<{
      service_id: string;
      audience: string;
      verifier_hash: string;
      allowed_capabilities: string;
      display_name: string;
    }>();
  return rows.results.flatMap((row) => {
    const allowedCapabilities = parseStringArray(row.allowed_capabilities);
    return validServiceId(row.service_id) &&
      validServiceAudience(row.audience) &&
      validCapabilities(allowedCapabilities)
      ? [
          {
            serviceId: row.service_id,
            audience: row.audience,
            verifierHash: row.verifier_hash,
            allowedCapabilities,
            displayName: row.display_name || undefined,
          },
        ]
      : [];
  });
}

export async function issueHumanCredential(
  database: D1Database,
  input: {
    service: ServiceRegistration;
    userId: string;
    organizationId: string;
    membershipId: string;
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
    throw new RangeError("Requested credential grant is invalid");
  }
  const credential = opaqueSecret("0000_");
  const credentialHash = await hashOpaque(credential);
  const credentialId = crypto.randomUUID();
  const createdAt = Date.now();
  const name = credentialName(input.name);
  const inserted = await database
    .prepare(
      `INSERT INTO platform_credential
       (id, credential_hash, kind, subject_id, organization_id, membership_id, grant_id,
        audience, capabilities, resource_ids, expires_at, revoked_at, name, created_at,
        revoked_reason, replaced_by_id, predecessor_id)
       SELECT ?, ?, 'human', ?, ?, ?, NULL, ?, ?, '[]', ?, NULL, ?, ?, NULL, NULL, NULL
       WHERE EXISTS (
         SELECT 1 FROM member
         JOIN organization ON organization.id = member.organizationId
         JOIN "user" AS active_user ON active_user.id = member.userId
         WHERE member.id = ? AND member.organizationId = ?
           AND member.userId = ?
           AND organization.suspendedAt IS NULL
           AND active_user.disabledAt IS NULL
       )
         AND ${catalogPredicate("?")}`,
    )
    .bind(
      credentialId,
      credentialHash,
      input.userId,
      input.organizationId,
      input.membershipId,
      input.service.audience,
      JSON.stringify(input.capabilities),
      input.expiresAt,
      name,
      createdAt,
      input.membershipId,
      input.organizationId,
      input.userId,
      input.service.serviceId,
      input.service.audience,
      JSON.stringify(input.capabilities),
    )
    .run();
  if (inserted.meta.changes !== 1) {
    throw new RangeError(
      "Current organization membership or service grant is required",
    );
  }
  return { credential, credentialId, expiresAt: input.expiresAt };
}

export async function listHumanCredentials(
  database: D1DatabaseSession,
  input: { userId: string; organizationId: string; membershipId: string },
): Promise<CredentialMetadata[]> {
  const rows = await database
    .prepare(
      `SELECT id, name, created_at, audience, capabilities, expires_at,
              revoked_at, revoked_reason, replaced_by_id, predecessor_id
       FROM platform_credential
       WHERE kind = 'human' AND oauth_origin IS NULL
         AND subject_id = ? AND organization_id = ? AND membership_id = ?
       ORDER BY created_at DESC, id`,
    )
    .bind(input.userId, input.organizationId, input.membershipId)
    .all<{
      id: string;
      name: string;
      created_at: number;
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
    return capabilities &&
      row.expires_at !== null &&
      Number.isSafeInteger(row.expires_at) &&
      row.expires_at <= MAX_DATE_MS
      ? [
          {
            id: row.id,
            name: row.name || "Personal API credential",
            createdAt: row.created_at,
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

export async function rotateHumanCredential(
  database: D1Database,
  input: {
    service: ServiceRegistration;
    userId: string;
    organizationId: string;
    membershipId: string;
    credentialId: string;
    expiresAt: number;
  },
): Promise<{ credential: string; credentialId: string; expiresAt: number }> {
  if (!isSafeCredentialExpiry(input.expiresAt)) {
    throw new RangeError("Requested credential lifetime is invalid");
  }
  const credential = opaqueSecret("0000_");
  const credentialHash = await hashOpaque(credential);
  const replacementId = crypto.randomUUID();
  const now = Date.now();
  await database.batch([
    database
      .prepare(
        `UPDATE platform_credential
         SET revoked_at = ?, revoked_reason = 'rotated', replaced_by_id = ?
         WHERE id = ? AND kind = 'human' AND oauth_origin IS NULL
           AND subject_id = ?
           AND organization_id = ? AND membership_id = ?
           AND audience = ? AND revoked_at IS NULL
           AND expires_at > ? AND replaced_by_id IS NULL
           AND EXISTS (
             SELECT 1 FROM member
             JOIN organization ON organization.id = member.organizationId
             JOIN "user" AS active_user ON active_user.id = member.userId
             WHERE member.id = ? AND member.organizationId = ?
               AND member.userId = ?
               AND organization.suspendedAt IS NULL
               AND active_user.disabledAt IS NULL
           )
           AND ${catalogPredicate("capabilities")}`,
      )
      .bind(
        now,
        replacementId,
        input.credentialId,
        input.userId,
        input.organizationId,
        input.membershipId,
        input.service.audience,
        now,
        input.membershipId,
        input.organizationId,
        input.userId,
        input.service.serviceId,
        input.service.audience,
      ),
    database
      .prepare(
        `INSERT INTO platform_credential
         (id, credential_hash, kind, subject_id, organization_id, membership_id, grant_id,
          audience, capabilities, resource_ids, expires_at, revoked_at, name, created_at,
          revoked_reason, replaced_by_id, predecessor_id)
         SELECT ?, ?, kind, subject_id, organization_id, membership_id, grant_id,
                audience, capabilities, resource_ids, ?, NULL, name, ?, NULL, NULL, ?
         FROM platform_credential
         WHERE id = ? AND oauth_origin IS NULL
           AND replaced_by_id = ? AND revoked_at = ?
           AND ${catalogPredicate("capabilities")}`,
      )
      .bind(
        replacementId,
        credentialHash,
        input.expiresAt,
        now,
        input.credentialId,
        input.credentialId,
        replacementId,
        now,
        input.service.serviceId,
        input.service.audience,
      ),
  ]);
  const replacement = await database
    .prepare(
      `SELECT id FROM platform_credential
       WHERE id = ? AND predecessor_id = ? AND credential_hash = ?
         AND revoked_at IS NULL`,
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

export async function revokeHumanCredential(
  database: D1DatabaseSession,
  input: {
    userId: string;
    organizationId: string;
    membershipId: string;
    credentialId: string;
  },
): Promise<boolean> {
  const result = await database
    .prepare(
      `UPDATE platform_credential
       SET revoked_at = COALESCE(revoked_at, ?),
           revoked_reason = COALESCE(revoked_reason, 'revoked')
       WHERE id = ? AND kind = 'human' AND oauth_origin IS NULL
         AND subject_id = ?
         AND organization_id = ? AND membership_id = ?`,
    )
    .bind(
      Date.now(),
      input.credentialId,
      input.userId,
      input.organizationId,
      input.membershipId,
    )
    .run();
  return result.meta.changes === 1;
}
