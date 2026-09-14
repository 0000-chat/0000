PRAGMA foreign_keys = OFF;

-- 0022 added group.manage to the account and permission grant checks.  Keep
-- receipt.send a separate account/chat grant while retaining the authority
-- epochs introduced by 0025.  The epoch columns and authority triggers are
-- copied explicitly so a receipt migration cannot invalidate an existing
-- outbound capability fence.
DROP TRIGGER IF EXISTS account_grants_tenant_match;
DROP TRIGGER IF EXISTS permission_requests_tenant_match;
DROP TRIGGER IF EXISTS outbound_account_grant_epoch_insert;
DROP TRIGGER IF EXISTS outbound_account_grant_epoch_update;
DROP TRIGGER IF EXISTS outbound_account_grant_epoch_delete;
DROP TRIGGER IF EXISTS outbound_account_grant_chat_epoch_insert;
DROP TRIGGER IF EXISTS outbound_account_grant_chat_epoch_delete;
DROP TRIGGER IF EXISTS outbound_account_grant_chat_epoch_update;
DROP TRIGGER IF EXISTS outbound_membership_grant_epoch_update;
DROP TRIGGER IF EXISTS outbound_identity_grant_epoch_insert;
DROP TRIGGER IF EXISTS outbound_identity_grant_epoch_delete;
DROP TRIGGER IF EXISTS outbound_principal_epoch_update;
DROP TRIGGER IF EXISTS outbound_tenant_epoch_update;
DROP TRIGGER IF EXISTS outbound_identity_epoch_update;
DROP TRIGGER IF EXISTS outbound_connection_epoch_update;
DROP TRIGGER IF EXISTS outbound_account_epoch_update;

ALTER TABLE account_grant_chats RENAME TO account_grant_chats_v3;
ALTER TABLE account_grants RENAME TO account_grants_v3;
ALTER TABLE permission_requests RENAME TO permission_requests_v3;

CREATE TABLE account_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES connection_accounts(account_id) ON DELETE RESTRICT,
  operation_scope TEXT NOT NULL CHECK (operation_scope IN (
    'conversation.read', 'conversation.create', 'group.create', 'group.manage',
    'message.send', 'receipt.send', 'webhook.manage'
  )),
  chat_scope TEXT NOT NULL CHECK (chat_scope IN ('all_chats', 'selected_chats')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  authorization_epoch INTEGER NOT NULL DEFAULT 1 CHECK (authorization_epoch >= 1),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, membership_id, identity_id, account_id, operation_scope),
  UNIQUE (tenant_id, id, account_id),
  FOREIGN KEY (tenant_id, membership_id)
    REFERENCES memberships(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, identity_id)
    REFERENCES identities(tenant_id, id) ON DELETE CASCADE,
  CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL) OR
    (status = 'active' AND revoked_at IS NULL)
  )
);

INSERT INTO account_grants (
  id, tenant_id, membership_id, identity_id, account_id, operation_scope,
  chat_scope, status, created_at, updated_at, revoked_at, authorization_epoch
)
SELECT
  id, tenant_id, membership_id, identity_id, account_id, operation_scope,
  chat_scope, status, created_at, updated_at, revoked_at, authorization_epoch
FROM account_grants_v3;

CREATE TABLE account_grant_chats (
  grant_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (grant_id, chat_id),
  FOREIGN KEY (tenant_id, grant_id, account_id)
    REFERENCES account_grants(tenant_id, id, account_id) ON DELETE CASCADE
);

INSERT INTO account_grant_chats (grant_id, tenant_id, account_id, chat_id, created_at)
SELECT grant_id, tenant_id, account_id, chat_id, created_at
FROM account_grant_chats_v3;

DROP TABLE account_grant_chats_v3;
DROP TABLE account_grants_v3;

CREATE INDEX account_grants_membership_scope_idx
  ON account_grants(tenant_id, membership_id, identity_id, operation_scope, status, account_id, id);
CREATE INDEX account_grants_account_idx
  ON account_grants(tenant_id, account_id, status, id);
CREATE INDEX account_grant_chats_account_idx
  ON account_grant_chats(tenant_id, account_id, chat_id, grant_id);

CREATE TRIGGER account_grants_tenant_match
BEFORE INSERT ON account_grants
WHEN NOT EXISTS (
  SELECT 1 FROM connection_accounts AS ca
  JOIN connections AS c ON c.id = ca.connection_id
  WHERE ca.account_id = NEW.account_id AND c.tenant_id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'account_grant_tenant_mismatch');
END;

-- Reattach the authority epoch fence to the rebuilt account rows.  The
-- IF-NOT-EXISTS form keeps this migration executable in a pre-authority test
-- database while the production sequence always receives the 0025 table.
CREATE TABLE IF NOT EXISTS outbound_authority_heads (
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
FROM account_grants
WHERE 1 = 1
ON CONFLICT (tenant_id, authority_kind, authority_id) DO UPDATE SET
  epoch = MAX(outbound_authority_heads.epoch, excluded.epoch),
  updated_at = excluded.updated_at;

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
  UPDATE account_grants SET authorization_epoch = (
    SELECT epoch FROM outbound_authority_heads
    WHERE tenant_id = NEW.tenant_id AND authority_kind = 'account_grant' AND authority_id = NEW.id
  ) WHERE tenant_id = NEW.tenant_id AND id = NEW.id;
END;

CREATE TRIGGER outbound_account_grant_epoch_update
AFTER UPDATE OF id, tenant_id, membership_id, identity_id, account_id,
  operation_scope, chat_scope, status, revoked_at, authorization_epoch
ON account_grants
WHEN NEW.authorization_epoch <> OLD.authorization_epoch
  OR NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
  OR NEW.membership_id <> OLD.membership_id OR NEW.identity_id <> OLD.identity_id
  OR NEW.account_id <> OLD.account_id OR NEW.operation_scope <> OLD.operation_scope
  OR NEW.chat_scope <> OLD.chat_scope OR NEW.status <> OLD.status
  OR NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
  INSERT INTO outbound_authority_heads (
    tenant_id, authority_kind, authority_id, epoch, created_at, updated_at
  ) VALUES (
    NEW.tenant_id, 'account_grant', NEW.id, NEW.authorization_epoch,
    NEW.created_at, NEW.updated_at
  )
  ON CONFLICT (tenant_id, authority_kind, authority_id) DO UPDATE SET
    epoch = MAX(outbound_authority_heads.epoch + CASE WHEN NEW.authorization_epoch = OLD.authorization_epoch THEN 1 ELSE 0 END, excluded.epoch),
    updated_at = excluded.updated_at;
  UPDATE account_grants SET authorization_epoch = (
    SELECT epoch FROM outbound_authority_heads
    WHERE tenant_id = NEW.tenant_id AND authority_kind = 'account_grant' AND authority_id = NEW.id
  ) WHERE tenant_id = NEW.tenant_id AND id = NEW.id;
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

CREATE TRIGGER outbound_account_grant_chat_epoch_insert
AFTER INSERT ON account_grant_chats
BEGIN
  INSERT INTO outbound_authority_heads (
    tenant_id, authority_kind, authority_id, epoch, created_at, updated_at
  )
  SELECT tenant_id, 'account_grant', id, authorization_epoch, created_at, NEW.created_at
  FROM account_grants WHERE tenant_id = NEW.tenant_id AND id = NEW.grant_id
  ON CONFLICT (tenant_id, authority_kind, authority_id) DO UPDATE SET
    epoch = outbound_authority_heads.epoch + 1, updated_at = excluded.updated_at;
  UPDATE account_grants SET authorization_epoch = (
    SELECT epoch FROM outbound_authority_heads
    WHERE tenant_id = NEW.tenant_id AND authority_kind = 'account_grant' AND authority_id = NEW.grant_id
  ) WHERE tenant_id = NEW.tenant_id AND id = NEW.grant_id;
END;

CREATE TRIGGER outbound_account_grant_chat_epoch_delete
AFTER DELETE ON account_grant_chats
BEGIN
  INSERT INTO outbound_authority_heads (
    tenant_id, authority_kind, authority_id, epoch, created_at, updated_at
  )
  SELECT tenant_id, 'account_grant', id, authorization_epoch, created_at, OLD.created_at
  FROM account_grants WHERE tenant_id = OLD.tenant_id AND id = OLD.grant_id
  ON CONFLICT (tenant_id, authority_kind, authority_id) DO UPDATE SET
    epoch = outbound_authority_heads.epoch + 1, updated_at = excluded.updated_at;
  UPDATE account_grants SET authorization_epoch = (
    SELECT epoch FROM outbound_authority_heads
    WHERE tenant_id = OLD.tenant_id AND authority_kind = 'account_grant' AND authority_id = OLD.grant_id
  ) WHERE tenant_id = OLD.tenant_id AND id = OLD.grant_id;
END;

CREATE TRIGGER outbound_account_grant_chat_epoch_update
AFTER UPDATE OF grant_id, tenant_id, account_id, chat_id ON account_grant_chats
WHEN NEW.grant_id <> OLD.grant_id OR NEW.tenant_id <> OLD.tenant_id
  OR NEW.account_id <> OLD.account_id OR NEW.chat_id <> OLD.chat_id
BEGIN
  INSERT INTO outbound_authority_heads (
    tenant_id, authority_kind, authority_id, epoch, created_at, updated_at
  )
  SELECT tenant_id, 'account_grant', id, authorization_epoch, created_at, NEW.created_at
  FROM account_grants WHERE tenant_id = NEW.tenant_id AND id = NEW.grant_id
  ON CONFLICT (tenant_id, authority_kind, authority_id) DO UPDATE SET
    epoch = outbound_authority_heads.epoch + 1, updated_at = excluded.updated_at;
  UPDATE account_grants SET authorization_epoch = (
    SELECT epoch FROM outbound_authority_heads
    WHERE tenant_id = NEW.tenant_id AND authority_kind = 'account_grant' AND authority_id = NEW.grant_id
  ) WHERE tenant_id = NEW.tenant_id AND id = NEW.grant_id;
END;

CREATE TRIGGER outbound_membership_grant_epoch_update
AFTER UPDATE OF id, tenant_id, principal_id, role, status, revoked_at ON memberships
WHEN NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
  OR NEW.principal_id <> OLD.principal_id OR NEW.role <> OLD.role
  OR NEW.status <> OLD.status OR NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
  UPDATE account_grants SET authorization_epoch = authorization_epoch + 1
  WHERE tenant_id = NEW.tenant_id AND membership_id = NEW.id;
END;

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
  UPDATE account_grants SET authorization_epoch = (
    SELECT epoch FROM outbound_authority_heads
    WHERE tenant_id = NEW.tenant_id
      AND authority_kind = 'account_grant'
      AND authority_id = account_grants.id
  ) WHERE tenant_id = NEW.tenant_id
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
  UPDATE account_grants SET authorization_epoch = (
    SELECT epoch FROM outbound_authority_heads
    WHERE tenant_id = OLD.tenant_id
      AND authority_kind = 'account_grant'
      AND authority_id = account_grants.id
  ) WHERE tenant_id = OLD.tenant_id
    AND membership_id = OLD.membership_id
    AND identity_id = OLD.identity_id;
END;

CREATE TRIGGER outbound_principal_epoch_update
AFTER UPDATE OF id, principal_type, status, revoked_at ON principals
WHEN NEW.id <> OLD.id OR NEW.principal_type <> OLD.principal_type
  OR NEW.status <> OLD.status OR NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
  UPDATE memberships SET authority_epoch = authority_epoch + 1
  WHERE principal_id = NEW.id;
  UPDATE account_grants SET authorization_epoch = authorization_epoch + 1
  WHERE membership_id IN (SELECT id FROM memberships WHERE principal_id = NEW.id);
END;

CREATE TRIGGER outbound_tenant_epoch_update
AFTER UPDATE OF id, status ON tenants
WHEN NEW.id <> OLD.id OR NEW.status <> OLD.status
BEGIN
  UPDATE memberships SET authority_epoch = authority_epoch + 1 WHERE tenant_id = NEW.id;
  UPDATE account_grants SET authorization_epoch = authorization_epoch + 1 WHERE tenant_id = NEW.id;
END;

CREATE TRIGGER outbound_identity_epoch_update
AFTER UPDATE OF id, tenant_id, identity_kind, status ON identities
WHEN NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
  OR NEW.identity_kind <> OLD.identity_kind OR NEW.status <> OLD.status
BEGIN
  UPDATE account_grants SET authorization_epoch = authorization_epoch + 1
  WHERE tenant_id = NEW.tenant_id AND identity_id = NEW.id;
END;

CREATE TRIGGER outbound_connection_epoch_update
AFTER UPDATE OF id, tenant_id, identity_id, status ON connections
WHEN NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
  OR NEW.identity_id <> OLD.identity_id OR NEW.status <> OLD.status
BEGIN
  UPDATE account_grants SET authorization_epoch = authorization_epoch + 1
  WHERE tenant_id = NEW.tenant_id AND account_id IN (
    SELECT account_id FROM connection_accounts WHERE connection_id = NEW.id
  );
END;

CREATE TRIGGER outbound_account_epoch_update
AFTER UPDATE OF account_id, connection_id, status ON connection_accounts
WHEN NEW.account_id <> OLD.account_id OR NEW.connection_id <> OLD.connection_id
  OR NEW.status <> OLD.status
BEGIN
  UPDATE account_grants SET authorization_epoch = authorization_epoch + 1
  WHERE account_id = NEW.account_id OR account_id = OLD.account_id;
END;

CREATE TABLE permission_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  requester_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  requester_membership_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES connection_accounts(account_id) ON DELETE RESTRICT,
  operation_scope TEXT NOT NULL CHECK (operation_scope IN (
    'conversation.read', 'conversation.create', 'group.create', 'group.manage',
    'message.send', 'receipt.send', 'webhook.manage'
  )),
  chat_scope TEXT NOT NULL CHECK (chat_scope IN ('all_chats', 'selected_chats')),
  chat_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(chat_ids_json)),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by_principal_id TEXT REFERENCES principals(id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, requester_membership_id)
    REFERENCES memberships(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, identity_id)
    REFERENCES identities(tenant_id, id) ON DELETE CASCADE
);

INSERT INTO permission_requests (
  id, tenant_id, requester_principal_id, requester_membership_id, identity_id,
  account_id, operation_scope, chat_scope, chat_ids_json, reason, status,
  created_at, updated_at, decided_at, decided_by_principal_id
)
SELECT id, tenant_id, requester_principal_id, requester_membership_id, identity_id,
  account_id, operation_scope, chat_scope, chat_ids_json, reason, status,
  created_at, updated_at, decided_at, decided_by_principal_id
FROM permission_requests_v3;
DROP TABLE permission_requests_v3;

CREATE TRIGGER permission_requests_tenant_match
BEFORE INSERT ON permission_requests
WHEN NOT EXISTS (
  SELECT 1 FROM connection_accounts AS ca
  JOIN connections AS c ON c.id = ca.connection_id
  WHERE ca.account_id = NEW.account_id AND c.tenant_id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'permission_request_tenant_mismatch');
END;

CREATE INDEX permission_requests_requester_idx
  ON permission_requests(tenant_id, requester_membership_id, status, created_at, id);
CREATE INDEX permission_requests_tenant_idx
  ON permission_requests(tenant_id, status, created_at, id);

CREATE TABLE receipt_operations (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  matrix_room_id TEXT,
  matrix_event_id TEXT,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested', 'dispatching', 'accepted', 'observed', 'unknown', 'rejected')),
  matrix_stage TEXT NOT NULL CHECK (matrix_stage IN ('unknown', 'accepted')),
  bridge_stage TEXT NOT NULL CHECK (bridge_stage IN ('unknown', 'observed')),
  provider_stage TEXT NOT NULL CHECK (provider_stage IN ('unknown', 'confirmed')),
  failure_code TEXT,
  failure_reason TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_json)),
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, operation_id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, identity_id) REFERENCES identities(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, connection_id) REFERENCES connections(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX receipt_operations_status_idx
  ON receipt_operations(tenant_id, status, updated_at DESC, operation_id);
CREATE INDEX receipt_operations_resource_idx
  ON receipt_operations(tenant_id, account_id, conversation_id, message_id, updated_at DESC);

CREATE TABLE receipt_operation_evidence (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('matrix', 'bridge', 'provider')),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'observed', 'confirmed', 'uncertain')),
  evidence_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  reason TEXT,
  provider_operation_id TEXT,
  UNIQUE (tenant_id, operation_id, source, evidence_id),
  FOREIGN KEY (tenant_id, operation_id) REFERENCES receipt_operations(tenant_id, operation_id) ON DELETE CASCADE
);

CREATE INDEX receipt_operation_evidence_idx
  ON receipt_operation_evidence(tenant_id, operation_id, observed_at, id);

PRAGMA foreign_keys = ON;
