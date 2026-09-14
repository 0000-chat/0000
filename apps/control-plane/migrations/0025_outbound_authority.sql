PRAGMA foreign_keys = ON;

-- These epochs are the durable fence for every account grant and
-- owner/admin membership.  The head table deliberately has no foreign key:
-- a deleted grant or membership must not be able to restart at epoch one if
-- its identifier is ever reused by a repair or a group-created grant.
ALTER TABLE account_grants
  ADD COLUMN authorization_epoch INTEGER NOT NULL DEFAULT 1
  CHECK (authorization_epoch >= 1);

ALTER TABLE memberships
  ADD COLUMN authority_epoch INTEGER NOT NULL DEFAULT 1
  CHECK (authority_epoch >= 1);

CREATE TABLE outbound_authority_heads (
  tenant_id TEXT NOT NULL,
  authority_kind TEXT NOT NULL CHECK (authority_kind IN ('account_grant', 'membership')),
  authority_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, authority_kind, authority_id)
);

INSERT INTO outbound_authority_heads (
  tenant_id, authority_kind, authority_id, epoch, created_at, updated_at
)
SELECT tenant_id, 'account_grant', id, authorization_epoch, created_at, updated_at
FROM account_grants;

INSERT INTO outbound_authority_heads (
  tenant_id, authority_kind, authority_id, epoch, created_at, updated_at
)
SELECT tenant_id, 'membership', id, authority_epoch, created_at, updated_at
FROM memberships;

-- A fresh row starts at one.  Reusing an identifier advances the retained
-- head, so a capability issued for a deleted row can never become valid.
CREATE TRIGGER outbound_account_grant_epoch_insert
AFTER INSERT ON account_grants
BEGIN
  INSERT INTO outbound_authority_heads (
    tenant_id, authority_kind, authority_id, epoch, created_at, updated_at
  ) VALUES (
    NEW.tenant_id, 'account_grant', NEW.id, NEW.authorization_epoch,
    NEW.created_at, NEW.updated_at
  )
  ON CONFLICT (tenant_id, authority_kind, authority_id) DO UPDATE SET
    epoch = MAX(outbound_authority_heads.epoch + 1, excluded.epoch),
    updated_at = excluded.updated_at;

  UPDATE account_grants
  SET authorization_epoch = (
    SELECT epoch
    FROM outbound_authority_heads
    WHERE tenant_id = NEW.tenant_id
      AND authority_kind = 'account_grant'
      AND authority_id = NEW.id
  )
  WHERE tenant_id = NEW.tenant_id AND id = NEW.id;
END;

CREATE TRIGGER outbound_account_grant_epoch_update
AFTER UPDATE OF id, tenant_id, membership_id, identity_id, account_id,
  operation_scope, chat_scope, status, revoked_at, authorization_epoch
ON account_grants
WHEN NEW.authorization_epoch <> OLD.authorization_epoch
  OR NEW.id <> OLD.id
  OR NEW.tenant_id <> OLD.tenant_id
  OR NEW.membership_id <> OLD.membership_id
  OR NEW.identity_id <> OLD.identity_id
  OR NEW.account_id <> OLD.account_id
  OR NEW.operation_scope <> OLD.operation_scope
  OR NEW.chat_scope <> OLD.chat_scope
  OR NEW.status <> OLD.status
  OR NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
  INSERT INTO outbound_authority_heads (
    tenant_id, authority_kind, authority_id, epoch, created_at, updated_at
  ) VALUES (
    NEW.tenant_id, 'account_grant', NEW.id, NEW.authorization_epoch,
    NEW.created_at, NEW.updated_at
  )
  ON CONFLICT (tenant_id, authority_kind, authority_id) DO UPDATE SET
    epoch = MAX(
      outbound_authority_heads.epoch + CASE
        WHEN NEW.authorization_epoch = OLD.authorization_epoch THEN 1
        ELSE 0
      END,
      excluded.epoch
    ),
    updated_at = excluded.updated_at;

  UPDATE account_grants
  SET authorization_epoch = (
    SELECT epoch
    FROM outbound_authority_heads
    WHERE tenant_id = NEW.tenant_id
      AND authority_kind = 'account_grant'
      AND authority_id = NEW.id
  )
  WHERE tenant_id = NEW.tenant_id AND id = NEW.id;
END;

CREATE TRIGGER outbound_account_grant_epoch_delete
AFTER DELETE ON account_grants
BEGIN
  INSERT INTO outbound_authority_heads (
    tenant_id, authority_kind, authority_id, epoch, created_at, updated_at
  ) VALUES (
    OLD.tenant_id, 'account_grant', OLD.id, OLD.authorization_epoch + 1,
    OLD.created_at, OLD.updated_at
  )
  ON CONFLICT (tenant_id, authority_kind, authority_id) DO UPDATE SET
    epoch = MAX(outbound_authority_heads.epoch + 1, excluded.epoch),
    updated_at = excluded.updated_at;
END;

-- Selected-chat changes are authorization changes even when the grant row's
-- status and scope remain unchanged.  These triggers cover the direct delete
-- and insert sequence used by ordinary grant updates and group reactivation.
CREATE TRIGGER outbound_account_grant_chat_epoch_insert
AFTER INSERT ON account_grant_chats
BEGIN
  INSERT INTO outbound_authority_heads (
    tenant_id, authority_kind, authority_id, epoch, created_at, updated_at
  )
  SELECT tenant_id, 'account_grant', id, authorization_epoch,
         created_at, NEW.created_at
  FROM account_grants
  WHERE tenant_id = NEW.tenant_id AND id = NEW.grant_id
  ON CONFLICT (tenant_id, authority_kind, authority_id) DO UPDATE SET
    epoch = outbound_authority_heads.epoch + 1,
    updated_at = excluded.updated_at;

  UPDATE account_grants
  SET authorization_epoch = (
    SELECT epoch
    FROM outbound_authority_heads
    WHERE tenant_id = NEW.tenant_id
      AND authority_kind = 'account_grant'
      AND authority_id = NEW.grant_id
  )
  WHERE tenant_id = NEW.tenant_id AND id = NEW.grant_id;
END;

CREATE TRIGGER outbound_account_grant_chat_epoch_delete
AFTER DELETE ON account_grant_chats
BEGIN
  INSERT INTO outbound_authority_heads (
    tenant_id, authority_kind, authority_id, epoch, created_at, updated_at
  )
  SELECT tenant_id, 'account_grant', id, authorization_epoch,
         created_at, OLD.created_at
  FROM account_grants
  WHERE tenant_id = OLD.tenant_id AND id = OLD.grant_id
  ON CONFLICT (tenant_id, authority_kind, authority_id) DO UPDATE SET
    epoch = outbound_authority_heads.epoch + 1,
    updated_at = excluded.updated_at;

  UPDATE account_grants
  SET authorization_epoch = (
    SELECT epoch
    FROM outbound_authority_heads
    WHERE tenant_id = OLD.tenant_id
      AND authority_kind = 'account_grant'
      AND authority_id = OLD.grant_id
  )
  WHERE tenant_id = OLD.tenant_id AND id = OLD.grant_id;
END;

CREATE TRIGGER outbound_account_grant_chat_epoch_update
AFTER UPDATE OF grant_id, tenant_id, account_id, chat_id ON account_grant_chats
WHEN NEW.grant_id <> OLD.grant_id
  OR NEW.tenant_id <> OLD.tenant_id
  OR NEW.account_id <> OLD.account_id
  OR NEW.chat_id <> OLD.chat_id
BEGIN
  INSERT INTO outbound_authority_heads (
    tenant_id, authority_kind, authority_id, epoch, created_at, updated_at
  )
  SELECT tenant_id, 'account_grant', id, authorization_epoch,
         created_at, NEW.created_at
  FROM account_grants
  WHERE tenant_id = NEW.tenant_id AND id = NEW.grant_id
  ON CONFLICT (tenant_id, authority_kind, authority_id) DO UPDATE SET
    epoch = outbound_authority_heads.epoch + 1,
    updated_at = excluded.updated_at;

  UPDATE account_grants
  SET authorization_epoch = (
    SELECT epoch
    FROM outbound_authority_heads
    WHERE tenant_id = NEW.tenant_id
      AND authority_kind = 'account_grant'
      AND authority_id = NEW.grant_id
  )
  WHERE tenant_id = NEW.tenant_id AND id = NEW.grant_id;
END;

CREATE TRIGGER outbound_membership_epoch_insert
AFTER INSERT ON memberships
BEGIN
  INSERT INTO outbound_authority_heads (
    tenant_id, authority_kind, authority_id, epoch, created_at, updated_at
  ) VALUES (
    NEW.tenant_id, 'membership', NEW.id, NEW.authority_epoch,
    NEW.created_at, NEW.updated_at
  )
  ON CONFLICT (tenant_id, authority_kind, authority_id) DO UPDATE SET
    epoch = MAX(outbound_authority_heads.epoch + 1, excluded.epoch),
    updated_at = excluded.updated_at;

  UPDATE memberships
  SET authority_epoch = (
    SELECT epoch
    FROM outbound_authority_heads
    WHERE tenant_id = NEW.tenant_id
      AND authority_kind = 'membership'
      AND authority_id = NEW.id
  )
  WHERE tenant_id = NEW.tenant_id AND id = NEW.id;
END;

CREATE TRIGGER outbound_membership_epoch_update
AFTER UPDATE OF id, tenant_id, principal_id, role, status, revoked_at,
  authority_epoch
ON memberships
WHEN NEW.authority_epoch <> OLD.authority_epoch
  OR NEW.id <> OLD.id
  OR NEW.tenant_id <> OLD.tenant_id
  OR NEW.principal_id <> OLD.principal_id
  OR NEW.role <> OLD.role
  OR NEW.status <> OLD.status
  OR NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
  INSERT INTO outbound_authority_heads (
    tenant_id, authority_kind, authority_id, epoch, created_at, updated_at
  ) VALUES (
    NEW.tenant_id, 'membership', NEW.id, NEW.authority_epoch,
    NEW.created_at, NEW.updated_at
  )
  ON CONFLICT (tenant_id, authority_kind, authority_id) DO UPDATE SET
    epoch = MAX(
      outbound_authority_heads.epoch + CASE
        WHEN NEW.authority_epoch = OLD.authority_epoch THEN 1
        ELSE 0
      END,
      excluded.epoch
    ),
    updated_at = excluded.updated_at;

  UPDATE memberships
  SET authority_epoch = (
    SELECT epoch
    FROM outbound_authority_heads
    WHERE tenant_id = NEW.tenant_id
      AND authority_kind = 'membership'
      AND authority_id = NEW.id
  )
  WHERE tenant_id = NEW.tenant_id AND id = NEW.id;
END;

CREATE TRIGGER outbound_membership_epoch_delete
AFTER DELETE ON memberships
BEGIN
  INSERT INTO outbound_authority_heads (
    tenant_id, authority_kind, authority_id, epoch, created_at, updated_at
  ) VALUES (
    OLD.tenant_id, 'membership', OLD.id, OLD.authority_epoch + 1,
    OLD.created_at, OLD.updated_at
  )
  ON CONFLICT (tenant_id, authority_kind, authority_id) DO UPDATE SET
    epoch = MAX(outbound_authority_heads.epoch + 1, excluded.epoch),
    updated_at = excluded.updated_at;
END;

-- A membership lifecycle change also changes every delegated capability issued
-- through that membership.  Keep this separate from the epoch-row trigger so
-- its internal authority_epoch update does not increment the grant twice.
CREATE TRIGGER outbound_membership_grant_epoch_update
AFTER UPDATE OF id, tenant_id, principal_id, role, status, revoked_at ON memberships
WHEN NEW.id <> OLD.id
  OR NEW.tenant_id <> OLD.tenant_id
  OR NEW.principal_id <> OLD.principal_id
  OR NEW.role <> OLD.role
  OR NEW.status <> OLD.status
  OR NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
  UPDATE account_grants
  SET authorization_epoch = authorization_epoch + 1
  WHERE tenant_id = NEW.tenant_id AND membership_id = NEW.id;
END;

-- Identity and principal lifecycle changes alter the effective capability,
-- even when the account grant row itself is untouched.
CREATE TRIGGER outbound_identity_grant_epoch_insert
AFTER INSERT ON identity_grants
BEGIN
  INSERT INTO outbound_authority_heads (
    tenant_id, authority_kind, authority_id, epoch, created_at, updated_at
  )
  SELECT g.tenant_id, 'account_grant', g.id, g.authorization_epoch,
         g.created_at, NEW.created_at
  FROM account_grants AS g
  WHERE g.tenant_id = NEW.tenant_id
    AND g.membership_id = NEW.membership_id
    AND g.identity_id = NEW.identity_id
  ON CONFLICT (tenant_id, authority_kind, authority_id) DO UPDATE SET
    epoch = outbound_authority_heads.epoch + 1,
    updated_at = excluded.updated_at;

  UPDATE account_grants
  SET authorization_epoch = (
    SELECT epoch FROM outbound_authority_heads
    WHERE tenant_id = NEW.tenant_id
      AND authority_kind = 'account_grant'
      AND authority_id = account_grants.id
  )
  WHERE tenant_id = NEW.tenant_id
    AND membership_id = NEW.membership_id
    AND identity_id = NEW.identity_id;
END;

CREATE TRIGGER outbound_identity_grant_epoch_delete
AFTER DELETE ON identity_grants
BEGIN
  INSERT INTO outbound_authority_heads (
    tenant_id, authority_kind, authority_id, epoch, created_at, updated_at
  )
  SELECT g.tenant_id, 'account_grant', g.id, g.authorization_epoch,
         g.created_at, OLD.created_at
  FROM account_grants AS g
  WHERE g.tenant_id = OLD.tenant_id
    AND g.membership_id = OLD.membership_id
    AND g.identity_id = OLD.identity_id
  ON CONFLICT (tenant_id, authority_kind, authority_id) DO UPDATE SET
    epoch = outbound_authority_heads.epoch + 1,
    updated_at = excluded.updated_at;

  UPDATE account_grants
  SET authorization_epoch = (
    SELECT epoch FROM outbound_authority_heads
    WHERE tenant_id = OLD.tenant_id
      AND authority_kind = 'account_grant'
      AND authority_id = account_grants.id
  )
  WHERE tenant_id = OLD.tenant_id
    AND membership_id = OLD.membership_id
    AND identity_id = OLD.identity_id;
END;

CREATE TRIGGER outbound_principal_epoch_update
AFTER UPDATE OF id, principal_type, status, revoked_at ON principals
WHEN NEW.id <> OLD.id
  OR NEW.principal_type <> OLD.principal_type
  OR NEW.status <> OLD.status
  OR NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
  UPDATE memberships
  SET authority_epoch = authority_epoch + 1
  WHERE principal_id = NEW.id;

  UPDATE account_grants
  SET authorization_epoch = authorization_epoch + 1
  WHERE membership_id IN (
    SELECT id FROM memberships WHERE principal_id = NEW.id
  );
END;

CREATE TRIGGER outbound_tenant_epoch_update
AFTER UPDATE OF id, status ON tenants
WHEN NEW.id <> OLD.id OR NEW.status <> OLD.status
BEGIN
  UPDATE memberships
  SET authority_epoch = authority_epoch + 1
  WHERE tenant_id = NEW.id;

  UPDATE account_grants
  SET authorization_epoch = authorization_epoch + 1
  WHERE tenant_id = NEW.id;
END;

CREATE TRIGGER outbound_identity_epoch_update
AFTER UPDATE OF id, tenant_id, identity_kind, status ON identities
WHEN NEW.id <> OLD.id
  OR NEW.tenant_id <> OLD.tenant_id
  OR NEW.identity_kind <> OLD.identity_kind
  OR NEW.status <> OLD.status
BEGIN
  UPDATE account_grants
  SET authorization_epoch = authorization_epoch + 1
  WHERE tenant_id = NEW.tenant_id AND identity_id = NEW.id;
END;

CREATE TRIGGER outbound_connection_epoch_update
AFTER UPDATE OF id, tenant_id, identity_id, status ON connections
WHEN NEW.id <> OLD.id
  OR NEW.tenant_id <> OLD.tenant_id
  OR NEW.identity_id <> OLD.identity_id
  OR NEW.status <> OLD.status
BEGIN
  UPDATE account_grants
  SET authorization_epoch = authorization_epoch + 1
  WHERE tenant_id = NEW.tenant_id
    AND account_id IN (
      SELECT account_id FROM connection_accounts WHERE connection_id = NEW.id
    );
END;

CREATE TRIGGER outbound_account_epoch_update
AFTER UPDATE OF account_id, connection_id, status ON connection_accounts
WHEN NEW.account_id <> OLD.account_id
  OR NEW.connection_id <> OLD.connection_id
  OR NEW.status <> OLD.status
BEGIN
  UPDATE account_grants
  SET authorization_epoch = authorization_epoch + 1
  WHERE account_id = NEW.account_id OR account_id = OLD.account_id;
END;

CREATE INDEX outbound_authority_heads_lookup_idx
  ON outbound_authority_heads(tenant_id, authority_kind, authority_id, epoch);

CREATE TABLE outbound_acceptance_intents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  grant_id TEXT,
  capability_kind TEXT NOT NULL CHECK (capability_kind IN ('account_grant', 'owner_admin')),
  capability_id TEXT NOT NULL,
  capability_epoch INTEGER NOT NULL CHECK (capability_epoch >= 1),
  authority_id TEXT,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  body_digest TEXT NOT NULL CHECK (length(body_digest) = 64),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'uncertain')),
  command_id TEXT,
  message_id TEXT,
  dispatch_id TEXT,
  transaction_id TEXT,
  uncertain_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, id),
  CHECK (
    (capability_kind = 'account_grant' AND grant_id = capability_id AND authority_id IS NULL) OR
    (capability_kind = 'owner_admin' AND grant_id IS NULL AND authority_id = capability_id)
  ),
  FOREIGN KEY (tenant_id, membership_id)
    REFERENCES memberships(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, identity_id)
    REFERENCES identities(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES connections(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id) REFERENCES connection_accounts(account_id) ON DELETE RESTRICT
);

CREATE INDEX outbound_acceptance_intents_tuple_idx
  ON outbound_acceptance_intents(
    tenant_id, membership_id, identity_id, account_id, conversation_id,
    connection_id, status, id
  );

CREATE INDEX outbound_acceptance_intents_capability_idx
  ON outbound_acceptance_intents(
    tenant_id, capability_kind, capability_id, capability_epoch, status, id
  );

CREATE TABLE outbound_dispatch_claims (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  grant_id TEXT,
  capability_kind TEXT NOT NULL CHECK (capability_kind IN ('account_grant', 'owner_admin')),
  capability_id TEXT NOT NULL,
  capability_epoch INTEGER NOT NULL CHECK (capability_epoch >= 1),
  authority_id TEXT,
  command_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  body_digest TEXT NOT NULL CHECK (length(body_digest) = 64),
  status TEXT NOT NULL CHECK (status IN ('claimed', 'uncertain')),
  uncertain_reason TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, reservation_id),
  UNIQUE (tenant_id, transaction_id),
  CHECK (
    (capability_kind = 'account_grant' AND grant_id = capability_id AND authority_id IS NULL) OR
    (capability_kind = 'owner_admin' AND grant_id IS NULL AND authority_id = capability_id)
  ),
  FOREIGN KEY (tenant_id, reservation_id)
    REFERENCES outbound_acceptance_intents(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, membership_id)
    REFERENCES memberships(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, identity_id)
    REFERENCES identities(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES connections(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id) REFERENCES connection_accounts(account_id) ON DELETE RESTRICT
);

CREATE INDEX outbound_dispatch_claims_tuple_idx
  ON outbound_dispatch_claims(
    tenant_id, membership_id, identity_id, account_id, conversation_id,
    connection_id, status, id
  );

CREATE INDEX outbound_dispatch_claims_expiry_idx
  ON outbound_dispatch_claims(tenant_id, expires_at, status, id);
