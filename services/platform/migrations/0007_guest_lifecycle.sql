-- T08 durable guest resource grants and their service-scoped authority.
CREATE TABLE IF NOT EXISTS platform_guest_grant (
  id TEXT PRIMARY KEY NOT NULL,
  guest_id TEXT NOT NULL REFERENCES platform_guest(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES platform_service(service_id),
  audience TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  assertion_kind TEXT NOT NULL CHECK (assertion_kind IN ('owner', 'participant')),
  capabilities TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_reason TEXT
);

CREATE INDEX IF NOT EXISTS platform_guest_grant_guest_idx
  ON platform_guest_grant(guest_id, created_at, id);

CREATE INDEX IF NOT EXISTS platform_guest_grant_service_idx
  ON platform_guest_grant(service_id, audience, resource_id, created_at, id);

CREATE UNIQUE INDEX IF NOT EXISTS platform_guest_grant_current_resource_unique
  ON platform_guest_grant(guest_id, service_id, resource_id)
  WHERE revoked_at IS NULL;

CREATE TRIGGER IF NOT EXISTS platform_guest_grant_authority_immutable
BEFORE UPDATE OF guest_id, service_id, audience, resource_id, assertion_kind
  ON platform_guest_grant
WHEN NEW.guest_id <> OLD.guest_id
  OR NEW.service_id <> OLD.service_id
  OR NEW.audience <> OLD.audience
  OR NEW.resource_id <> OLD.resource_id
  OR NEW.assertion_kind <> OLD.assertion_kind
BEGIN
  SELECT RAISE(ABORT, 'guest grant authority is immutable');
END;

CREATE TRIGGER IF NOT EXISTS platform_guest_grant_service_match_insert
BEFORE INSERT ON platform_guest_grant
WHEN NOT EXISTS (
  SELECT 1 FROM platform_service
  WHERE service_id = NEW.service_id AND audience = NEW.audience
)
BEGIN
  SELECT RAISE(ABORT, 'guest grant service mismatch');
END;

CREATE TRIGGER IF NOT EXISTS platform_guest_grant_service_match_update
BEFORE UPDATE OF service_id, audience ON platform_guest_grant
WHEN NOT EXISTS (
  SELECT 1 FROM platform_service
  WHERE service_id = NEW.service_id AND audience = NEW.audience
)
BEGIN
  SELECT RAISE(ABORT, 'guest grant service mismatch');
END;
