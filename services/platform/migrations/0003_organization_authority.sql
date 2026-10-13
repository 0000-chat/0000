CREATE UNIQUE INDEX IF NOT EXISTS member_organization_user_unique
  ON member (organizationId, userId);

CREATE TRIGGER IF NOT EXISTS platform_member_role_insert
BEFORE INSERT ON member
WHEN NEW.role NOT IN ('owner', 'admin', 'member')
BEGIN
  SELECT RAISE(ABORT, 'invalid member role');
END;

CREATE TRIGGER IF NOT EXISTS platform_member_role_update
BEFORE UPDATE OF role ON member
WHEN NEW.role NOT IN ('owner', 'admin', 'member')
BEGIN
  SELECT RAISE(ABORT, 'invalid member role');
END;

CREATE TRIGGER IF NOT EXISTS platform_invitation_insert
BEFORE INSERT ON invitation
WHEN NEW.role IS NULL
  OR NEW.role NOT IN ('owner', 'admin', 'member')
  OR NEW.status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'invalid invitation role or status');
END;

CREATE TRIGGER IF NOT EXISTS platform_invitation_role_update
BEFORE UPDATE OF role ON invitation
WHEN NEW.role IS NULL OR NEW.role NOT IN ('owner', 'admin', 'member')
BEGIN
  SELECT RAISE(ABORT, 'invalid invitation role');
END;

CREATE TRIGGER IF NOT EXISTS platform_invitation_status_update
BEFORE UPDATE OF status ON invitation
WHEN NEW.status NOT IN ('pending', 'accepted', 'cancelled')
  OR NOT (
    NEW.status = OLD.status
    OR (OLD.status = 'pending' AND NEW.status IN ('accepted', 'cancelled'))
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid invitation status transition');
END;

CREATE TRIGGER IF NOT EXISTS platform_invitation_authority_immutable
BEFORE UPDATE OF organizationId, email, role, inviterId ON invitation
WHEN NEW.organizationId <> OLD.organizationId
  OR lower(NEW.email) <> lower(OLD.email)
  OR NEW.role <> OLD.role
  OR NEW.inviterId <> OLD.inviterId
BEGIN
  SELECT RAISE(ABORT, 'invitation authority is immutable');
END;
