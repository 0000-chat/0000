-- T09 dependency: keep independent service-owned guest permissions separate.
ALTER TABLE platform_guest_grant
  ADD COLUMN permission_id TEXT NOT NULL DEFAULT 'default';

DROP INDEX IF EXISTS platform_guest_grant_current_resource_unique;
DROP INDEX IF EXISTS platform_guest_grant_service_idx;

CREATE INDEX IF NOT EXISTS platform_guest_grant_service_idx
  ON platform_guest_grant(
    service_id,
    audience,
    resource_id,
    permission_id,
    created_at,
    id
  );

CREATE UNIQUE INDEX IF NOT EXISTS platform_guest_grant_current_permission_unique
  ON platform_guest_grant(guest_id, service_id, resource_id, permission_id)
  WHERE revoked_at IS NULL;

DROP TRIGGER IF EXISTS platform_guest_grant_authority_immutable;

CREATE TRIGGER platform_guest_grant_authority_immutable
BEFORE UPDATE OF guest_id, service_id, audience, resource_id, assertion_kind,
                 permission_id
  ON platform_guest_grant
WHEN NEW.guest_id <> OLD.guest_id
  OR NEW.service_id <> OLD.service_id
  OR NEW.audience <> OLD.audience
  OR NEW.resource_id <> OLD.resource_id
  OR NEW.assertion_kind <> OLD.assertion_kind
  OR NEW.permission_id <> OLD.permission_id
BEGIN
  SELECT RAISE(ABORT, 'guest grant authority is immutable');
END;

CREATE TRIGGER IF NOT EXISTS platform_guest_grant_permission_valid_insert
BEFORE INSERT ON platform_guest_grant
WHEN NEW.permission_id IS NULL
  OR length(NEW.permission_id) = 0
  OR length(NEW.permission_id) > 512
BEGIN
  SELECT RAISE(ABORT, 'guest grant permission is invalid');
END;

CREATE TRIGGER IF NOT EXISTS platform_guest_grant_permission_valid_update
BEFORE UPDATE OF permission_id ON platform_guest_grant
WHEN NEW.permission_id IS NULL
  OR length(NEW.permission_id) = 0
  OR length(NEW.permission_id) > 512
BEGIN
  SELECT RAISE(ABORT, 'guest grant permission is invalid');
END;
