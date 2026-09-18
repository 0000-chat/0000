const DAY_MS = 24 * 60 * 60 * 1000;

export interface DefaultOrganization {
  organizationId: string;
  membershipId: string;
}

export interface ServiceRegistration {
  serviceId: string;
  audience: string;
  verifierHash: string;
  allowedCapabilities: string[];
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

async function stableId(prefix: string, userId: string): Promise<string> {
  return `${prefix}_${(await hashOpaque(`platform-default:${prefix}:${userId}`)).slice(0, 32)}`;
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

export async function issueHumanCredential(
  database: D1Database,
  input: {
    service: ServiceRegistration;
    userId: string;
    organizationId: string;
    membershipId: string;
    capabilities: string[];
  },
): Promise<{ credential: string; credentialId: string; expiresAt: number }> {
  if (
    input.capabilities.length === 0 ||
    input.capabilities.some(
      (capability) => !input.service.allowedCapabilities.includes(capability),
    )
  ) {
    throw new RangeError("Requested capability exceeds this service grant");
  }
  const membership = await database
    .prepare(
      `SELECT member.id
       FROM member
       JOIN organization ON organization.id = member.organizationId
       JOIN "user" AS active_user ON active_user.id = member.userId
       WHERE member.id = ? AND member.organizationId = ? AND member.userId = ?
         AND organization.suspendedAt IS NULL
         AND active_user.disabledAt IS NULL`,
    )
    .bind(input.membershipId, input.organizationId, input.userId)
    .first<{ id: string }>();
  if (!membership)
    throw new RangeError("Current organization membership is required");

  const credential = opaqueSecret("0000_");
  const credentialHash = await hashOpaque(credential);
  const credentialId = crypto.randomUUID();
  const expiresAt = Date.now() + 90 * DAY_MS;
  const inserted = await database
    .prepare(
      `INSERT INTO platform_credential
       (id, credential_hash, kind, subject_id, organization_id, membership_id, grant_id, audience, capabilities, resource_ids, expires_at, revoked_at)
       SELECT ?, ?, 'human', ?, ?, ?, NULL, ?, ?, '[]', ?, NULL
       WHERE EXISTS (
         SELECT 1 FROM member
         JOIN organization ON organization.id = member.organizationId
         JOIN "user" AS active_user ON active_user.id = member.userId
         WHERE member.id = ? AND member.organizationId = ?
           AND member.userId = ?
           AND organization.suspendedAt IS NULL
           AND active_user.disabledAt IS NULL
       )`,
    )
    .bind(
      credentialId,
      credentialHash,
      input.userId,
      input.organizationId,
      input.membershipId,
      input.service.audience,
      JSON.stringify(input.capabilities),
      expiresAt,
      input.membershipId,
      input.organizationId,
      input.userId,
    )
    .run();
  if (inserted.meta.changes !== 1) {
    throw new RangeError("Current organization membership is required");
  }
  return { credential, credentialId, expiresAt };
}

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
