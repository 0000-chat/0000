-- T05 organization-owned agents, service grants, and immutable authority bindings.
CREATE TABLE IF NOT EXISTS platform_agent (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organization(id),
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_agent_organization_idx
  ON platform_agent(organization_id, created_at, id);

CREATE TABLE IF NOT EXISTS platform_agent_grant (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL REFERENCES platform_agent(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organization(id),
  service_id TEXT NOT NULL REFERENCES platform_service(service_id),
  audience TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_reason TEXT
);

CREATE INDEX IF NOT EXISTS platform_agent_grant_agent_idx
  ON platform_agent_grant(agent_id, created_at, id);

CREATE UNIQUE INDEX IF NOT EXISTS platform_agent_grant_current_service_unique
  ON platform_agent_grant(agent_id, service_id)
  WHERE revoked_at IS NULL;

CREATE TRIGGER IF NOT EXISTS platform_agent_authority_immutable
BEFORE UPDATE OF organization_id, created_by_user_id ON platform_agent
WHEN NEW.organization_id <> OLD.organization_id
  OR NEW.created_by_user_id <> OLD.created_by_user_id
BEGIN
  SELECT RAISE(ABORT, 'agent authority is immutable');
END;

CREATE TRIGGER IF NOT EXISTS platform_agent_grant_authority_immutable
BEFORE UPDATE OF agent_id, organization_id, service_id, audience ON platform_agent_grant
WHEN NEW.agent_id <> OLD.agent_id
  OR NEW.organization_id <> OLD.organization_id
  OR NEW.service_id <> OLD.service_id
  OR NEW.audience <> OLD.audience
BEGIN
  SELECT RAISE(ABORT, 'agent grant authority is immutable');
END;

CREATE TRIGGER IF NOT EXISTS platform_agent_grant_parent_match_insert
BEFORE INSERT ON platform_agent_grant
WHEN NOT EXISTS (
  SELECT 1 FROM platform_agent
  WHERE id = NEW.agent_id AND organization_id = NEW.organization_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent grant organization mismatch');
END;

CREATE TRIGGER IF NOT EXISTS platform_agent_grant_service_match_insert
BEFORE INSERT ON platform_agent_grant
WHEN NOT EXISTS (
  SELECT 1 FROM platform_service
  WHERE service_id = NEW.service_id AND audience = NEW.audience
)
BEGIN
  SELECT RAISE(ABORT, 'agent grant service mismatch');
END;
