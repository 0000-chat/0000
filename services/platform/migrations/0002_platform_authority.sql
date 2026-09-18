CREATE TABLE IF NOT EXISTS platform_default_organization (
  user_id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  bootstrap_nonce TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_service (
  service_id TEXT PRIMARY KEY NOT NULL,
  audience TEXT NOT NULL UNIQUE,
  verifier_hash TEXT NOT NULL UNIQUE,
  allowed_capabilities TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS platform_service_grant_issuer (
  credential_hash TEXT PRIMARY KEY NOT NULL,
  service_id TEXT NOT NULL REFERENCES platform_service(service_id) ON DELETE CASCADE,
  capabilities TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS platform_credential (
  id TEXT PRIMARY KEY NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'service', 'guest')),
  subject_id TEXT NOT NULL,
  organization_id TEXT,
  membership_id TEXT,
  grant_id TEXT,
  audience TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  resource_ids TEXT NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS platform_guest (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);

CREATE TABLE IF NOT EXISTS platform_guest_bootstrap (
  id TEXT PRIMARY KEY NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE,
  guest_id TEXT NOT NULL REFERENCES platform_guest(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
