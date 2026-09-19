-- T06 personal-harness OAuth installations and request-local consent flows.
-- The Better Auth provider tables remain the protocol ledger. These tables are
-- the Platform authority binding used by the shared verifier.

CREATE TABLE IF NOT EXISTS platform_oauth_client (
  client_id TEXT PRIMARY KEY NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES platform_service(service_id),
  owner_user_id TEXT REFERENCES "user"(id),
  redirect_uri TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_oauth_flow (
  id TEXT PRIMARY KEY NOT NULL,
  query_hash TEXT NOT NULL UNIQUE,
  oauth_query TEXT NOT NULL,
  state TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id),
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  organization_id TEXT REFERENCES organization(id),
  membership_id TEXT,
  installation_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'selected', 'consumed', 'activated', 'rejected')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX IF NOT EXISTS platform_oauth_flow_owner_idx
  ON platform_oauth_flow(user_id, session_id, created_at);

CREATE TABLE IF NOT EXISTS platform_oauth_installation (
  id TEXT PRIMARY KEY NOT NULL,
  client_id TEXT NOT NULL REFERENCES oauthClient(clientId),
  user_id TEXT NOT NULL REFERENCES "user"(id),
  membership_id TEXT NOT NULL REFERENCES member(id),
  organization_id TEXT NOT NULL REFERENCES organization(id),
  service_id TEXT NOT NULL REFERENCES platform_service(service_id),
  audience TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  subject_id TEXT NOT NULL UNIQUE,
  grant_id TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_oauth_installation_authority_idx
  ON platform_oauth_installation(user_id, organization_id, service_id, active);

ALTER TABLE platform_credential ADD COLUMN oauth_origin TEXT;
ALTER TABLE platform_credential ADD COLUMN oauth_installation_id TEXT REFERENCES platform_oauth_installation(id);
ALTER TABLE platform_credential ADD COLUMN oauth_provider_row_id TEXT;
ALTER TABLE platform_credential ADD COLUMN oauth_provider_token_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS platform_credential_oauth_provider_row_unique
  ON platform_credential(oauth_provider_row_id)
  WHERE oauth_provider_row_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS platform_oauth_installation_service_match_insert
BEFORE INSERT ON platform_oauth_installation
WHEN NOT EXISTS (
  SELECT 1 FROM platform_service
  WHERE service_id = NEW.service_id AND audience = NEW.audience
)
BEGIN
  SELECT RAISE(ABORT, 'oauth installation service mismatch');
END;

CREATE TRIGGER IF NOT EXISTS platform_oauth_installation_subject_guard
BEFORE INSERT ON platform_oauth_installation
WHEN EXISTS (SELECT 1 FROM platform_agent WHERE id = NEW.subject_id)
BEGIN
  SELECT RAISE(ABORT, 'oauth subject cannot be a managed agent');
END;

CREATE TRIGGER IF NOT EXISTS platform_oauth_installation_authority_immutable
BEFORE UPDATE OF client_id, user_id, membership_id, organization_id, service_id,
  audience, capabilities, subject_id, grant_id, expires_at
ON platform_oauth_installation
BEGIN
  SELECT RAISE(ABORT, 'oauth installation authority is immutable');
END;

CREATE TRIGGER IF NOT EXISTS platform_oauth_credential_shape_insert
BEFORE INSERT ON platform_credential
WHEN NEW.oauth_origin IS NOT NULL
 AND (NEW.oauth_origin <> 'better-auth'
      OR NEW.kind <> 'agent'
      OR NEW.oauth_installation_id IS NULL
      OR NEW.oauth_provider_row_id IS NULL
      OR NEW.oauth_provider_token_hash IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid oauth credential binding');
END;

CREATE TRIGGER IF NOT EXISTS platform_oauth_credential_shape_update
BEFORE UPDATE OF oauth_origin, oauth_installation_id, oauth_provider_row_id,
  oauth_provider_token_hash, kind ON platform_credential
WHEN NEW.oauth_origin IS NOT NULL
 AND (NEW.oauth_origin <> 'better-auth'
      OR NEW.kind <> 'agent'
      OR NEW.oauth_installation_id IS NULL
      OR NEW.oauth_provider_row_id IS NULL
      OR NEW.oauth_provider_token_hash IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid oauth credential binding');
END;

CREATE TRIGGER IF NOT EXISTS platform_oauth_credential_binding_immutable
BEFORE UPDATE OF credential_hash, kind, subject_id, organization_id,
  membership_id, grant_id, audience, capabilities, resource_ids, expires_at,
  oauth_origin, oauth_installation_id, oauth_provider_row_id,
  oauth_provider_token_hash
ON platform_credential
WHEN OLD.oauth_origin = 'better-auth'
 AND (NEW.credential_hash IS NOT OLD.credential_hash
      OR NEW.kind IS NOT OLD.kind
      OR NEW.subject_id IS NOT OLD.subject_id
      OR NEW.organization_id IS NOT OLD.organization_id
      OR NEW.membership_id IS NOT OLD.membership_id
      OR NEW.grant_id IS NOT OLD.grant_id
      OR NEW.audience IS NOT OLD.audience
      OR NEW.capabilities IS NOT OLD.capabilities
      OR NEW.resource_ids IS NOT OLD.resource_ids
      OR NEW.expires_at IS NOT OLD.expires_at
      OR NEW.oauth_origin IS NOT OLD.oauth_origin
      OR NEW.oauth_installation_id IS NOT OLD.oauth_installation_id
      OR NEW.oauth_provider_row_id IS NOT OLD.oauth_provider_row_id
      OR NEW.oauth_provider_token_hash IS NOT OLD.oauth_provider_token_hash)
BEGIN
  SELECT RAISE(ABORT, 'oauth credential binding is immutable');
END;
