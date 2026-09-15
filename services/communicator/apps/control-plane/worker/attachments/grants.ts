import {
  ATTACHMENT_DOWNLOAD_GRANT_TTL_MS,
  type ProjectionAttachment,
} from "@communicator/contracts";
import { sha256Hex } from "../archive/codec";
import { randomBase64url, randomIdentifier } from "../oauth/crypto";

export type AttachmentGrantRow = {
  id: string;
  tenant_id: string;
  attachment_id: string;
  message_id: string;
  actor_identity_id: string;
  identity_id: string;
  account_id: string;
  connection_id: string;
  conversation_id: string;
  revision: string;
  expires_at: string;
  revoked_at: string | null;
};

export type AttachmentGrant = {
  token: string;
  expires_at: string;
};

const grantDigest = (token: string): Promise<string> =>
  sha256Hex(new TextEncoder().encode(token));

const grantDatabase = (database: D1Database): D1DatabaseSession => {
  if (typeof database.withSession !== "function") {
    throw new Error("attachment grant database unavailable");
  }
  return database.withSession("first-primary");
};

export const issueAttachmentGrant = async (
  database: D1Database,
  tenantId: string,
  actorIdentityId: string,
  attachment: ProjectionAttachment,
  now: Date,
  ttlMs = ATTACHMENT_DOWNLOAD_GRANT_TTL_MS,
): Promise<AttachmentGrant> => {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 15 * 60 * 1000) {
    throw new Error("attachment grant ttl invalid");
  }
  const token = `adg_${randomBase64url(32)}`;
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const db = grantDatabase(database);
  await db
    .prepare(
      `INSERT INTO attachment_download_grants (id, tenant_id, grant_hash, attachment_id, message_id, actor_identity_id, identity_id, account_id, connection_id, conversation_id, revision, expires_at, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      randomIdentifier("attachment_grant"),
      tenantId,
      await grantDigest(token),
      attachment.attachment_id,
      attachment.message_id,
      actorIdentityId,
      attachment.identity_id,
      attachment.account_id,
      attachment.connection_id,
      attachment.conversation_id,
      attachment.revision,
      expiresAt,
      now.toISOString(),
    )
    .run();
  return { token, expires_at: expiresAt };
};

export const readAttachmentGrant = async (
  database: D1Database,
  tenantId: string,
  token: string,
  now: Date,
): Promise<AttachmentGrantRow | null> => {
  if (!/^adg_[A-Za-z0-9_-]{40,256}$/u.test(token)) return null;
  const db = grantDatabase(database);
  const row = await db
    .prepare(
      `SELECT id, tenant_id, attachment_id, message_id, actor_identity_id, identity_id, account_id, connection_id, conversation_id, revision, expires_at, revoked_at
       FROM attachment_download_grants
       WHERE tenant_id = ? AND grant_hash = ? AND revoked_at IS NULL AND expires_at > ?
       LIMIT 1`,
    )
    .bind(tenantId, await grantDigest(token), now.toISOString())
    .first<AttachmentGrantRow>();
  return row ?? null;
};

export const revokeAttachmentGrantsForAttachment = async (
  database: D1Database,
  tenantId: string,
  attachmentId: string,
  revokedAt: string,
): Promise<void> => {
  const db = grantDatabase(database);
  await db
    .prepare(
      "UPDATE attachment_download_grants SET revoked_at = ? WHERE tenant_id = ? AND attachment_id = ? AND revoked_at IS NULL",
    )
    .bind(revokedAt, tenantId, attachmentId)
    .run();
};
