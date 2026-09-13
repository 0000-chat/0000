PRAGMA foreign_keys = OFF;

-- Group creation is a distinct authority.  Rebuild the three historical
-- CHECK-constrained grant tables so an upgrade keeps every existing grant,
-- selected-chat row, permission request, and mutation record intact.
DROP TRIGGER IF EXISTS account_grants_tenant_match;
DROP TRIGGER IF EXISTS permission_requests_tenant_match;

ALTER TABLE account_grant_chats RENAME TO account_grant_chats_v1;
ALTER TABLE account_grants RENAME TO account_grants_v1;
ALTER TABLE permission_requests RENAME TO permission_requests_v1;
ALTER TABLE identity_grants RENAME TO identity_grants_v1;

CREATE TABLE identity_grants (
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  operation_scope TEXT NOT NULL CHECK (operation_scope IN (
    'conversation.read', 'conversation.create', 'group.create',
    'message.send', 'message.mutate', 'receipt.send',
    'connection.read', 'connection.manage', 'export.create', 'replay.run',
    'retention.manage', 'break_glass.inspect'
  )),
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, membership_id)
    REFERENCES memberships(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, identity_id)
    REFERENCES identities(tenant_id, id) ON DELETE CASCADE,
  PRIMARY KEY (tenant_id, membership_id, identity_id, operation_scope)
);

INSERT INTO identity_grants (
  tenant_id, membership_id, identity_id, operation_scope, created_at
)
SELECT tenant_id, membership_id, identity_id, operation_scope, created_at
FROM identity_grants_v1;
DROP TABLE identity_grants_v1;

CREATE INDEX identity_grants_membership_idx
  ON identity_grants(membership_id, identity_id, operation_scope);

CREATE TABLE account_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES connection_accounts(account_id) ON DELETE RESTRICT,
  operation_scope TEXT NOT NULL CHECK (operation_scope IN (
    'conversation.read', 'conversation.create', 'group.create',
    'message.send', 'webhook.manage'
  )),
  chat_scope TEXT NOT NULL CHECK (chat_scope IN ('all_chats', 'selected_chats')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
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
  chat_scope, status, created_at, updated_at, revoked_at
)
SELECT
  id, tenant_id, membership_id, identity_id, account_id, operation_scope,
  chat_scope, status, created_at, updated_at, revoked_at
FROM account_grants_v1;

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
FROM account_grant_chats_v1;

DROP TABLE account_grant_chats_v1;
DROP TABLE account_grants_v1;

CREATE INDEX account_grants_membership_scope_idx
  ON account_grants(tenant_id, membership_id, identity_id, operation_scope, status, account_id, id);
CREATE INDEX account_grants_account_idx
  ON account_grants(tenant_id, account_id, status, id);
CREATE INDEX account_grant_chats_account_idx
  ON account_grant_chats(tenant_id, account_id, chat_id, grant_id);

CREATE TRIGGER account_grants_tenant_match
BEFORE INSERT ON account_grants
WHEN NOT EXISTS (
  SELECT 1
  FROM connection_accounts AS ca
  JOIN connections AS c ON c.id = ca.connection_id
  WHERE ca.account_id = NEW.account_id
    AND c.tenant_id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'account_grant_tenant_mismatch');
END;

CREATE TABLE permission_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  requester_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  requester_membership_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES connection_accounts(account_id) ON DELETE RESTRICT,
  operation_scope TEXT NOT NULL CHECK (operation_scope IN (
    'conversation.read', 'conversation.create', 'group.create',
    'message.send', 'webhook.manage'
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
SELECT
  id, tenant_id, requester_principal_id, requester_membership_id, identity_id,
  account_id, operation_scope, chat_scope, chat_ids_json, reason, status,
  created_at, updated_at, decided_at, decided_by_principal_id
FROM permission_requests_v1;
DROP TABLE permission_requests_v1;

CREATE TRIGGER permission_requests_tenant_match
BEFORE INSERT ON permission_requests
WHEN NOT EXISTS (
  SELECT 1
  FROM connection_accounts AS ca
  JOIN connections AS c ON c.id = ca.connection_id
  WHERE ca.account_id = NEW.account_id
    AND c.tenant_id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'permission_request_tenant_mismatch');
END;

CREATE INDEX permission_requests_requester_idx
  ON permission_requests(tenant_id, requester_membership_id, status, created_at, id);
CREATE INDEX permission_requests_tenant_idx
  ON permission_requests(tenant_id, status, created_at, id);

-- This operation ledger is the single idempotency and uncertainty boundary.
-- The participant snapshots make later reconciliation independent of mutable
-- contact candidates and prevent a name-only match from being accepted.
CREATE TABLE group_creation_operations (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES connection_accounts(account_id) ON DELETE RESTRICT,
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('whatsapp', 'telegram', 'messenger', 'linkedin')),
  conversation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  participant_contacts_json TEXT NOT NULL CHECK (json_valid(participant_contacts_json)),
  participant_provider_ids_json TEXT NOT NULL CHECK (json_valid(participant_provider_ids_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'created', 'failed', 'human_action_required')),
  provider_group_id TEXT,
  matrix_room_id TEXT,
  evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
  evidence_path TEXT CHECK (evidence_path IS NULL OR evidence_path IN ('provider', 'event', 'refresh')),
  duplicate_risk INTEGER NOT NULL CHECK (duplicate_risk IN (0, 1)),
  human_action_required INTEGER NOT NULL CHECK (human_action_required IN (0, 1)),
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, operation_id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, conversation_id),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES connections(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX group_creation_account_idx
  ON group_creation_operations(tenant_id, account_id, status, updated_at, operation_id);

CREATE TABLE group_creation_access_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  operation_scope TEXT NOT NULL CHECK (operation_scope IN ('conversation.read', 'message.send')),
  grant_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source = 'group_creation'),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, operation_id, operation_scope),
  FOREIGN KEY (tenant_id, operation_id)
    REFERENCES group_creation_operations(tenant_id, operation_id) ON DELETE CASCADE
);

CREATE INDEX group_creation_access_grants_conversation_idx
  ON group_creation_access_grants(tenant_id, account_id, conversation_id, operation_scope);

CREATE TABLE group_creation_webhook_evaluations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  source TEXT NOT NULL CHECK (source IN ('chat', 'account', 'global')),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, operation_id, subscription_id),
  FOREIGN KEY (tenant_id, operation_id)
    REFERENCES group_creation_operations(tenant_id, operation_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, subscription_id)
    REFERENCES webhook_subscriptions(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX group_creation_webhook_evaluations_subscription_idx
  ON group_creation_webhook_evaluations(tenant_id, subscription_id, conversation_id);

PRAGMA foreign_keys = ON;
