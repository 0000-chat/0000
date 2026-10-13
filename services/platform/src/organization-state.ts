export const ORGANIZATION_ROLES = ["owner", "admin", "member"] as const;

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export interface OrganizationAuthority {
  organizationId: string;
  membershipId: string;
  userId: string;
  role: OrganizationRole;
  organizationName: string;
  suspendedAt: number | null;
}

export interface OrganizationMembership {
  organizationId: string;
  organizationName: string;
  membershipId: string;
  role: OrganizationRole;
  suspendedAt: number | null;
}

export interface OrganizationMember {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: OrganizationRole;
  disabled: boolean;
}

export interface OrganizationInvitation {
  id: string;
  organizationId: string;
  organizationName: string;
  email: string;
  role: OrganizationRole;
  expiresAt: number;
  suspended: boolean;
}

export interface OperatorOrganization {
  id: string;
  name: string;
  suspended: boolean;
}

export interface OperatorUser {
  id: string;
  name: string;
  email: string;
  disabled: boolean;
}

export function isOrganizationRole(value: unknown): value is OrganizationRole {
  return (
    typeof value === "string" &&
    ORGANIZATION_ROLES.includes(value as OrganizationRole)
  );
}

/**
 * Resolves tenant authority only from current D1 state. The organization ID is
 * always an explicit input; Better Auth's mutable active-organization cookie
 * is never consulted.
 */
async function getOrganizationMembershipRecord(
  database: D1DatabaseSession,
  userId: string,
  organizationId: string,
): Promise<OrganizationAuthority | null> {
  const row = await database
    .prepare(
      `SELECT organization.id AS organizationId,
              organization.name AS organizationName,
              organization.suspendedAt AS suspendedAt,
              member.id AS membershipId,
              member.userId AS userId,
              member.role AS role
       FROM member
       JOIN organization ON organization.id = member.organizationId
       JOIN "user" AS active_user ON active_user.id = member.userId
       WHERE member.organizationId = ?
         AND member.userId = ?
         AND active_user.disabledAt IS NULL`,
    )
    .bind(organizationId, userId)
    .first<{
      organizationId: string;
      organizationName: string;
      suspendedAt: number | null;
      membershipId: string;
      userId: string;
      role: string;
    }>();
  if (!row || !isOrganizationRole(row.role)) return null;
  return { ...row, role: row.role };
}

/** Returns current, active tenant authority and fails closed on suspension. */
export async function getCurrentOrganizationAuthority(
  database: D1DatabaseSession,
  userId: string,
  organizationId: string,
): Promise<OrganizationAuthority | null> {
  const membership = await getOrganizationMembershipRecord(
    database,
    userId,
    organizationId,
  );
  return membership?.suspendedAt === null ? membership : null;
}

/** Display-only membership state; callers must not use this to authorize writes. */
export async function getOrganizationMembershipForDisplay(
  database: D1DatabaseSession,
  userId: string,
  organizationId: string,
): Promise<OrganizationAuthority | null> {
  return getOrganizationMembershipRecord(database, userId, organizationId);
}

export async function listCurrentOrganizations(
  database: D1DatabaseSession,
  userId: string,
): Promise<OrganizationMembership[]> {
  const rows = await database
    .prepare(
      `SELECT organization.id AS organizationId,
              organization.name AS organizationName,
              organization.suspendedAt AS suspendedAt,
              member.id AS membershipId,
              member.role AS role
       FROM member
       JOIN organization ON organization.id = member.organizationId
       JOIN "user" AS active_user ON active_user.id = member.userId
       WHERE member.userId = ? AND active_user.disabledAt IS NULL
       ORDER BY lower(organization.name), organization.id`,
    )
    .bind(userId)
    .all<{
      organizationId: string;
      organizationName: string;
      suspendedAt: number | null;
      membershipId: string;
      role: string;
    }>();
  return rows.results.flatMap((row) =>
    isOrganizationRole(row.role) ? [{ ...row, role: row.role }] : [],
  );
}

export async function listRecipientInvitations(
  database: D1DatabaseSession,
  userId: string,
): Promise<OrganizationInvitation[]> {
  const rows = await database
    .prepare(
      `SELECT invitation.id AS id,
              invitation.organizationId AS organizationId,
              organization.name AS organizationName,
              invitation.email AS email,
              invitation.role AS role,
              invitation.expiresAt AS expiresAt,
              organization.suspendedAt AS suspendedAt
       FROM invitation
       JOIN organization ON organization.id = invitation.organizationId
       JOIN "user" AS recipient ON recipient.id = ?
       WHERE invitation.status = 'pending'
         AND invitation.expiresAt > ?
         AND recipient.emailVerified = 1
         AND recipient.disabledAt IS NULL
         AND lower(invitation.email) = lower(recipient.email)
       ORDER BY invitation.createdAt DESC, invitation.id`,
    )
    .bind(userId, Date.now())
    .all<{
      id: string;
      organizationId: string;
      organizationName: string;
      email: string;
      role: string | null;
      expiresAt: number;
      suspendedAt: number | null;
    }>();
  return rows.results.flatMap((row) =>
    isOrganizationRole(row.role)
      ? [
          {
            id: row.id,
            organizationId: row.organizationId,
            organizationName: row.organizationName,
            email: row.email,
            role: row.role,
            expiresAt: row.expiresAt,
            suspended: row.suspendedAt !== null,
          },
        ]
      : [],
  );
}

export async function listOrganizationMembers(
  database: D1DatabaseSession,
  authority: OrganizationAuthority,
): Promise<OrganizationMember[]> {
  const rows = await database
    .prepare(
      `SELECT member.id AS id,
              member.userId AS userId,
              active_user.name AS name,
              active_user.email AS email,
              active_user.disabledAt AS disabledAt,
              member.role AS role
       FROM member
       JOIN "user" AS active_user ON active_user.id = member.userId
       WHERE member.organizationId = ?
       ORDER BY CASE member.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                lower(active_user.name), member.id`,
    )
    .bind(authority.organizationId)
    .all<{
      id: string;
      userId: string;
      name: string;
      email: string;
      disabledAt: number | null;
      role: string;
    }>();
  const bounded = rows.results.flatMap((row) =>
    isOrganizationRole(row.role)
      ? [{ ...row, role: row.role, disabled: row.disabledAt !== null }]
      : [],
  );
  return authority.role === "owner" || authority.role === "admin"
    ? bounded
    : bounded.filter((member) => member.id === authority.membershipId);
}

export async function listOrganizationInvitations(
  database: D1DatabaseSession,
  authority: OrganizationAuthority,
): Promise<OrganizationInvitation[]> {
  if (authority.role === "member") return [];
  const rows = await database
    .prepare(
      `SELECT invitation.id AS id,
              invitation.organizationId AS organizationId,
              organization.name AS organizationName,
              invitation.email AS email,
              invitation.role AS role,
              invitation.expiresAt AS expiresAt,
              organization.suspendedAt AS suspendedAt
       FROM invitation
       JOIN organization ON organization.id = invitation.organizationId
       WHERE invitation.organizationId = ? AND invitation.status = 'pending'
       ORDER BY invitation.createdAt DESC, invitation.id`,
    )
    .bind(authority.organizationId)
    .all<{
      id: string;
      organizationId: string;
      organizationName: string;
      email: string;
      role: string | null;
      expiresAt: number;
      suspendedAt: number | null;
    }>();
  return rows.results.flatMap((row) =>
    isOrganizationRole(row.role) &&
    (authority.role === "owner" || row.role !== "owner")
      ? [
          {
            id: row.id,
            organizationId: row.organizationId,
            organizationName: row.organizationName,
            email: row.email,
            role: row.role,
            expiresAt: row.expiresAt,
            suspended: row.suspendedAt !== null,
          },
        ]
      : [],
  );
}

export async function createOwnedOrganization(
  database: D1Database,
  user: { id: string; name: string },
  name: string,
  onCommitted?: (result: {
    organizationId: string;
    membershipId: string;
  }) => void,
): Promise<{ organizationId: string; membershipId: string } | null> {
  const organizationId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const slug = `org-${organizationId.replaceAll("-", "").slice(0, 24)}`;
  const createdAt = Date.now();
  const results = await database.batch([
    database
      .prepare(
        `INSERT INTO organization (id, name, slug, createdAt)
         SELECT ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM "user" WHERE id = ? AND disabledAt IS NULL
         )`,
      )
      .bind(organizationId, name, slug, createdAt, user.id),
    database
      .prepare(
        `INSERT INTO member (id, organizationId, userId, role, createdAt)
         SELECT ?, organization.id, ?, 'owner', ?
         FROM organization
         JOIN "user" AS active_user ON active_user.id = ?
         WHERE organization.id = ? AND active_user.disabledAt IS NULL`,
      )
      .bind(membershipId, user.id, createdAt, user.id, organizationId),
  ]);
  if (results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1) {
    onCommitted?.({ organizationId, membershipId });
  }
  const owner = await database
    .prepare(
      `SELECT id FROM member
       WHERE id = ? AND organizationId = ? AND userId = ? AND role = 'owner'`,
    )
    .bind(membershipId, organizationId, user.id)
    .first<{ id: string }>();
  return owner ? { organizationId, membershipId } : null;
}

export async function renameOrganization(
  database: D1DatabaseSession,
  actorUserId: string,
  organizationId: string,
  name: string,
): Promise<boolean> {
  const result = await database
    .prepare(
      `UPDATE organization
       SET name = ?
       WHERE id = ? AND suspendedAt IS NULL
         AND EXISTS (
           SELECT 1 FROM member AS actor_member
           JOIN "user" AS actor_user ON actor_user.id = actor_member.userId
           WHERE actor_member.organizationId = organization.id
             AND actor_member.userId = ?
             AND actor_user.disabledAt IS NULL
             AND actor_member.role IN ('owner', 'admin')
         )`,
    )
    .bind(name, organizationId, actorUserId)
    .run();
  return result.meta.changes === 1;
}

export async function createOrganizationInvitation(
  database: D1DatabaseSession,
  input: {
    actorUserId: string;
    organizationId: string;
    email: string;
    role: OrganizationRole;
  },
): Promise<{ id: string; expiresAt: number } | null> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + 48 * 60 * 60 * 1000;
  const result = await database
    .prepare(
      `INSERT INTO invitation
         (id, organizationId, email, role, status, expiresAt, createdAt, inviterId)
       SELECT ?, organization.id, ?, ?, 'pending', ?, ?, ?
       FROM organization
       WHERE organization.id = ? AND organization.suspendedAt IS NULL
         AND EXISTS (
           SELECT 1 FROM member AS actor_member
           JOIN "user" AS actor_user ON actor_user.id = actor_member.userId
           WHERE actor_member.organizationId = organization.id
             AND actor_member.userId = ?
             AND actor_user.disabledAt IS NULL
             AND actor_member.role IN ('owner', 'admin')
             AND (? <> 'owner' OR actor_member.role = 'owner')
         )
         AND NOT EXISTS (
           SELECT 1 FROM member AS existing_member
           JOIN "user" AS existing_user ON existing_user.id = existing_member.userId
           WHERE existing_member.organizationId = organization.id
             AND lower(existing_user.email) = lower(?)
         )
         AND NOT EXISTS (
           SELECT 1 FROM invitation AS existing_invitation
           WHERE existing_invitation.organizationId = organization.id
             AND lower(existing_invitation.email) = lower(?)
             AND existing_invitation.role = ?
             AND existing_invitation.status = 'pending'
             AND existing_invitation.expiresAt > ?
         )`,
    )
    .bind(
      id,
      input.email,
      input.role,
      expiresAt,
      now,
      input.actorUserId,
      input.organizationId,
      input.actorUserId,
      input.role,
      input.email,
      input.email,
      input.role,
      now,
    )
    .run();
  return result.meta.changes === 1 ? { id, expiresAt } : null;
}

export async function cancelOrganizationInvitation(
  database: D1DatabaseSession,
  input: {
    actorUserId: string;
    organizationId: string;
    invitationId: string;
  },
): Promise<boolean> {
  const result = await database
    .prepare(
      `UPDATE invitation AS target
       SET status = 'cancelled'
       WHERE target.id = ? AND target.organizationId = ? AND target.status = 'pending'
         AND EXISTS (
           SELECT 1 FROM organization
           WHERE organization.id = target.organizationId
             AND organization.suspendedAt IS NULL
         )
         AND EXISTS (
           SELECT 1 FROM member AS actor_member
           JOIN "user" AS actor_user ON actor_user.id = actor_member.userId
           WHERE actor_member.organizationId = target.organizationId
             AND actor_member.userId = ?
             AND actor_user.disabledAt IS NULL
             AND actor_member.role IN ('owner', 'admin')
             AND (target.role <> 'owner' OR actor_member.role = 'owner')
         )`,
    )
    .bind(input.invitationId, input.organizationId, input.actorUserId)
    .run();
  return result.meta.changes === 1;
}

export async function updateOrganizationMemberRole(
  database: D1DatabaseSession,
  input: {
    actorUserId: string;
    organizationId: string;
    membershipId: string;
    role: OrganizationRole;
  },
): Promise<boolean> {
  const result = await database
    .prepare(
      `UPDATE member AS target
       SET role = ?
       WHERE target.id = ? AND target.organizationId = ?
         AND EXISTS (
           SELECT 1 FROM organization
           WHERE organization.id = target.organizationId
             AND organization.suspendedAt IS NULL
         )
         AND EXISTS (
           SELECT 1 FROM member AS actor_member
           JOIN "user" AS actor_user ON actor_user.id = actor_member.userId
           WHERE actor_member.organizationId = target.organizationId
             AND actor_member.userId = ?
             AND actor_user.disabledAt IS NULL
             AND actor_member.role IN ('owner', 'admin')
             AND (target.role <> 'owner' OR actor_member.role = 'owner')
             AND (? <> 'owner' OR actor_member.role = 'owner')
         )
         AND (
           target.role <> 'owner'
           OR ? = 'owner'
           OR EXISTS (
             SELECT 1 FROM member AS other_owner
             WHERE other_owner.organizationId = target.organizationId
               AND other_owner.role = 'owner'
               AND other_owner.id <> target.id
           )
         )`,
    )
    .bind(
      input.role,
      input.membershipId,
      input.organizationId,
      input.actorUserId,
      input.role,
      input.role,
    )
    .run();
  return result.meta.changes === 1;
}

export async function removeOrganizationMember(
  database: D1DatabaseSession,
  input: {
    actorUserId: string;
    organizationId: string;
    membershipId: string;
  },
): Promise<boolean> {
  const result = await database
    .prepare(
      `DELETE FROM member AS target
       WHERE target.id = ? AND target.organizationId = ?
         AND target.userId <> ?
         AND EXISTS (
           SELECT 1 FROM organization
           WHERE organization.id = target.organizationId
             AND organization.suspendedAt IS NULL
         )
         AND EXISTS (
           SELECT 1 FROM member AS actor_member
           JOIN "user" AS actor_user ON actor_user.id = actor_member.userId
           WHERE actor_member.organizationId = target.organizationId
             AND actor_member.userId = ?
             AND actor_user.disabledAt IS NULL
             AND actor_member.role IN ('owner', 'admin')
             AND (target.role <> 'owner' OR actor_member.role = 'owner')
         )
         AND (
           target.role <> 'owner'
           OR EXISTS (
             SELECT 1 FROM member AS other_owner
             WHERE other_owner.organizationId = target.organizationId
               AND other_owner.role = 'owner'
               AND other_owner.id <> target.id
           )
         )`,
    )
    .bind(
      input.membershipId,
      input.organizationId,
      input.actorUserId,
      input.actorUserId,
    )
    .run();
  return result.meta.changes === 1;
}

export async function leaveOrganization(
  database: D1DatabaseSession,
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const result = await database
    .prepare(
      `DELETE FROM member AS target
       WHERE target.organizationId = ? AND target.userId = ?
         AND EXISTS (
           SELECT 1 FROM "user"
           WHERE id = target.userId AND disabledAt IS NULL
         )
         AND EXISTS (
           SELECT 1 FROM organization
           WHERE organization.id = target.organizationId
             AND organization.suspendedAt IS NULL
         )
         AND (
           target.role <> 'owner'
           OR EXISTS (
             SELECT 1 FROM member AS other_owner
             WHERE other_owner.organizationId = target.organizationId
               AND other_owner.role = 'owner'
               AND other_owner.id <> target.id
           )
         )`,
    )
    .bind(organizationId, userId)
    .run();
  return result.meta.changes === 1;
}

export type AcceptInvitationResult =
  | { status: "accepted"; membershipId: string; organizationId: string }
  | {
      status:
        | "not_found"
        | "email_unverified"
        | "wrong_email"
        | "organization_suspended"
        | "expired"
        | "cancelled"
        | "membership_removed";
    };

export async function acceptOrganizationInvitation(
  database: D1Database,
  userId: string,
  invitationId: string,
  onCommitted?: (result: {
    organizationId: string;
    membershipId: string;
  }) => void,
): Promise<AcceptInvitationResult> {
  const recipient = await database
    .prepare(
      `SELECT email, emailVerified FROM "user"
       WHERE id = ? AND disabledAt IS NULL`,
    )
    .bind(userId)
    .first<{ email: string; emailVerified: number }>();
  if (!recipient) return { status: "not_found" };
  if (recipient.emailVerified !== 1) return { status: "email_unverified" };

  const invitation = await database
    .prepare(
      `SELECT invitation.organizationId AS organizationId,
              invitation.email AS email,
              invitation.role AS role,
              invitation.status AS status,
              invitation.expiresAt AS expiresAt,
              organization.suspendedAt AS suspendedAt
       FROM invitation
       JOIN organization ON organization.id = invitation.organizationId
       WHERE invitation.id = ?`,
    )
    .bind(invitationId)
    .first<{
      organizationId: string;
      email: string;
      role: string | null;
      status: string;
      expiresAt: number;
      suspendedAt: number | null;
    }>();
  if (!invitation || !isOrganizationRole(invitation.role)) {
    return { status: "not_found" };
  }
  if (invitation.suspendedAt !== null) {
    return { status: "organization_suspended" };
  }
  if (invitation.email.toLowerCase() !== recipient.email.toLowerCase()) {
    return { status: "wrong_email" };
  }

  const findMembership = async () =>
    database
      .prepare(
        `SELECT id FROM member
         WHERE organizationId = ? AND userId = ?`,
      )
      .bind(invitation.organizationId, userId)
      .first<{ id: string }>();

  if (invitation.status === "accepted") {
    const membership = await findMembership();
    return membership
      ? {
          status: "accepted",
          membershipId: membership.id,
          organizationId: invitation.organizationId,
        }
      : { status: "membership_removed" };
  }
  if (invitation.status !== "pending") return { status: "cancelled" };
  if (invitation.expiresAt <= Date.now()) return { status: "expired" };

  const membershipId = crypto.randomUUID();
  const now = Date.now();
  const results = await database.batch([
    database
      .prepare(
        `INSERT OR IGNORE INTO member (id, organizationId, userId, role, createdAt)
         SELECT ?, invitation.organizationId, recipient.id, invitation.role, ?
         FROM invitation
         JOIN organization ON organization.id = invitation.organizationId
         JOIN "user" AS recipient ON recipient.id = ?
         WHERE invitation.id = ?
           AND invitation.status = 'pending'
           AND invitation.expiresAt > ?
           AND invitation.role IN ('owner', 'admin', 'member')
           AND organization.suspendedAt IS NULL
           AND recipient.disabledAt IS NULL
           AND recipient.emailVerified = 1
           AND lower(recipient.email) = lower(invitation.email)
           AND NOT EXISTS (
             SELECT 1 FROM member AS existing_member
             WHERE existing_member.organizationId = invitation.organizationId
               AND existing_member.userId = recipient.id
           )`,
      )
      .bind(membershipId, now, userId, invitationId, now),
    database
      .prepare(
        `UPDATE invitation
         SET status = 'accepted'
         WHERE id = ? AND status = 'pending' AND expiresAt > ?
           AND role IN ('owner', 'admin', 'member')
           AND EXISTS (
             SELECT 1 FROM organization
             WHERE organization.id = invitation.organizationId
               AND organization.suspendedAt IS NULL
           )
           AND EXISTS (
             SELECT 1 FROM "user"
             WHERE id = ? AND disabledAt IS NULL AND emailVerified = 1
               AND lower(email) = lower(invitation.email)
           )
           AND EXISTS (
             SELECT 1 FROM member
             WHERE member.organizationId = invitation.organizationId
               AND member.userId = ?
           )`,
      )
      .bind(invitationId, now, userId, userId),
  ]);
  if (results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1) {
    onCommitted?.({
      organizationId: invitation.organizationId,
      membershipId,
    });
  }

  const finalState = await database
    .prepare("SELECT status FROM invitation WHERE id = ?")
    .bind(invitationId)
    .first<{ status: string }>();
  if (!finalState) return { status: "not_found" };
  if (finalState.status !== "accepted") {
    return finalState.status === "cancelled"
      ? { status: "cancelled" }
      : Date.now() >= invitation.expiresAt
        ? { status: "expired" }
        : { status: "not_found" };
  }
  const membership = await findMembership();
  return membership
    ? {
        status: "accepted",
        membershipId: membership.id,
        organizationId: invitation.organizationId,
      }
    : { status: "membership_removed" };
}

export async function listOperatorOrganizations(
  database: D1DatabaseSession,
): Promise<OperatorOrganization[]> {
  const rows = await database
    .prepare(
      `SELECT id, name, suspendedAt FROM organization
       ORDER BY lower(name), id`,
    )
    .all<{ id: string; name: string; suspendedAt: number | null }>();
  return rows.results.map((row) => ({
    id: row.id,
    name: row.name,
    suspended: row.suspendedAt !== null,
  }));
}

export async function listOperatorUsers(
  database: D1DatabaseSession,
): Promise<OperatorUser[]> {
  const rows = await database
    .prepare(
      `SELECT id, name, email, disabledAt FROM "user"
       ORDER BY lower(email), id`,
    )
    .all<{
      id: string;
      name: string;
      email: string;
      disabledAt: number | null;
    }>();
  return rows.results.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    disabled: row.disabledAt !== null,
  }));
}

export async function changeOrganizationLifecycle(
  database: D1DatabaseSession,
  operatorUserId: string,
  organizationId: string,
  suspend: boolean,
): Promise<boolean> {
  const now = Date.now();
  const result = await database
    .prepare(
      `UPDATE organization
       SET suspendedAt = ?
       WHERE id = ? AND ${suspend ? "suspendedAt IS NULL" : "suspendedAt IS NOT NULL"}
         AND EXISTS (
           SELECT 1 FROM "user"
           WHERE id = ? AND disabledAt IS NULL
         )`,
    )
    .bind(suspend ? now : null, organizationId, operatorUserId)
    .run();
  return result.meta.changes === 1;
}

export async function changeUserLifecycle(
  database: D1DatabaseSession,
  operatorUserId: string,
  targetUserId: string,
  disable: boolean,
): Promise<boolean> {
  const now = Date.now();
  const result = await database
    .prepare(
      `UPDATE "user"
       SET disabledAt = ?
       WHERE id = ? AND ${disable ? "disabledAt IS NULL" : "disabledAt IS NOT NULL"}
         AND EXISTS (
           SELECT 1 FROM "user" AS current_operator
           WHERE current_operator.id = ? AND current_operator.disabledAt IS NULL
         )`,
    )
    .bind(disable ? now : null, targetUserId, operatorUserId)
    .run();
  return result.meta.changes === 1;
}
