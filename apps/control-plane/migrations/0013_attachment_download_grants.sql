PRAGMA foreign_keys = ON;

-- Download grants are opaque, short-lived capabilities. Only a SHA-256
-- digest is stored so a D1 read cannot turn into a reusable bearer secret.
-- Ownership is copied into the grant to make account/chat/revision binding
-- explicit and auditable; the projection is re-read before bytes are released.
CREATE TABLE attachment_download_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  grant_hash TEXT NOT NULL UNIQUE CHECK (length(grant_hash) = 64),
  attachment_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  actor_identity_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  revision TEXT NOT NULL CHECK (length(revision) BETWEEN 1 AND 1024),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK (revoked_at IS NULL OR revoked_at <= expires_at)
);

CREATE INDEX attachment_download_grants_lookup_idx
  ON attachment_download_grants(tenant_id, grant_hash, expires_at, revoked_at);
CREATE INDEX attachment_download_grants_attachment_idx
  ON attachment_download_grants(tenant_id, attachment_id, expires_at);
