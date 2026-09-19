-- T11 service principals share the organization-owned machine lifecycle.
-- Existing rows are managed agents; the kind is immutable authority.
ALTER TABLE platform_agent
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent'
  CHECK (kind IN ('agent', 'service'));

CREATE INDEX IF NOT EXISTS platform_agent_organization_kind_idx
  ON platform_agent(organization_id, kind, created_at, id);

CREATE TRIGGER IF NOT EXISTS platform_agent_kind_immutable
BEFORE UPDATE OF kind ON platform_agent
WHEN NEW.kind <> OLD.kind
BEGIN
  SELECT RAISE(ABORT, 'machine kind is immutable');
END;

CREATE TRIGGER IF NOT EXISTS platform_machine_credential_kind_insert
BEFORE INSERT ON platform_credential
WHEN NEW.kind IN ('agent', 'service')
 AND NEW.oauth_origin IS NULL
 AND NOT EXISTS (
   SELECT 1 FROM platform_agent AS machine
   WHERE machine.id = NEW.subject_id
     AND machine.kind = NEW.kind
     AND machine.organization_id = NEW.organization_id
 )
BEGIN
  SELECT RAISE(ABORT, 'machine credential kind mismatch');
END;

CREATE TRIGGER IF NOT EXISTS platform_machine_credential_kind_update
BEFORE UPDATE OF kind, subject_id, organization_id ON platform_credential
WHEN (OLD.kind IN ('agent', 'service') OR NEW.kind IN ('agent', 'service'))
 AND NEW.oauth_origin IS NULL
 AND (
   NEW.kind NOT IN ('agent', 'service')
   OR NOT EXISTS (
     SELECT 1 FROM platform_agent AS machine
     WHERE machine.id = NEW.subject_id
       AND machine.kind = NEW.kind
       AND machine.organization_id = NEW.organization_id
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'machine credential kind mismatch');
END;
