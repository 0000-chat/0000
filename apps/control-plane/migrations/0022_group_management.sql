PRAGMA foreign_keys = OFF;

-- Group management is a separate authority from group creation. Rebuild the
-- grant tables so existing grants, selected-chat rows, requests, and mutation
-- history survive while identity and account grants can carry group.manage.
DROP TRIGGER IF EXISTS account_grants_tenant_match;
DROP TRIGGER IF EXISTS permission_requests_tenant_match;

ALTER TABLE account_grant_chats RENAME TO account_grant_chats_v2;
ALTER TABLE account_grants RENAME TO account_grants_v2;
ALTER TABLE permission_requests RENAME TO permission_requests_v2;
ALTER TABLE identity_grants RENAME TO identity_grants_v2;

CREATE TABLE identity_grants (
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  operation_scope TEXT NOT NULL CHECK (operation_scope IN (
    'conversation.read', 'conversation.create', 'group.create', 'group.manage',
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
FROM identity_grants_v2;
DROP TABLE identity_grants_v2;

CREATE INDEX identity_grants_membership_idx
  ON identity_grants(membership_id, identity_id, operation_scope);

CREATE TABLE account_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES connection_accounts(account_id) ON DELETE RESTRICT,
  operation_scope TEXT NOT NULL CHECK (operation_scope IN (
    'conversation.read', 'conversation.create', 'group.create', 'group.manage',
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
FROM account_grants_v2;

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
FROM account_grant_chats_v2;

DROP TABLE account_grant_chats_v2;
DROP TABLE account_grants_v2;

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
    'conversation.read', 'conversation.create', 'group.create', 'group.manage',
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
FROM permission_requests_v2;
DROP TABLE permission_requests_v2;

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

-- This row is the account-bound group target. It is seeded lazily from the
-- positively evidenced #23 creation row, then advanced only by a newer
-- provider revision under the operation's exclusive claim.
CREATE TABLE group_management_groups (
  tenant_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES connection_accounts(account_id) ON DELETE RESTRICT,
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('whatsapp', 'telegram', 'messenger', 'linkedin')),
  conversation_id TEXT NOT NULL,
  provider_group_id TEXT NOT NULL,
  matrix_room_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  current_revision TEXT NOT NULL CHECK (length(current_revision) BETWEEN 1 AND 128),
  current_member_provider_ids_json TEXT NOT NULL CHECK (json_valid(current_member_provider_ids_json)),
  current_evidence_json TEXT CHECK (current_evidence_json IS NULL OR json_valid(current_evidence_json)),
  active_operation_id TEXT,
  active_claim_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, conversation_id),
  UNIQUE (tenant_id, account_id, provider_group_id),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES connections(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX group_management_groups_account_idx
  ON group_management_groups(tenant_id, account_id, updated_at DESC, conversation_id);

CREATE TABLE group_management_operations (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('whatsapp', 'telegram', 'messenger', 'linkedin')),
  conversation_id TEXT NOT NULL,
  provider_group_id TEXT NOT NULL,
  matrix_room_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('rename', 'add_participants', 'remove_participants')),
  requested_name TEXT CHECK (requested_name IS NULL OR length(requested_name) BETWEEN 1 AND 100),
  requested_member_provider_ids_json TEXT NOT NULL CHECK (json_valid(requested_member_provider_ids_json)),
  expected_revision TEXT NOT NULL CHECK (length(expected_revision) BETWEEN 1 AND 128),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'human_action_required')),
  result_revision TEXT,
  result_member_provider_ids_json TEXT CHECK (result_member_provider_ids_json IS NULL OR json_valid(result_member_provider_ids_json)),
  evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
  evidence_path TEXT CHECK (evidence_path IS NULL OR evidence_path IN ('provider', 'event', 'refresh')),
  duplicate_risk INTEGER NOT NULL CHECK (duplicate_risk IN (0, 1)),
  human_action_required INTEGER NOT NULL CHECK (human_action_required IN (0, 1)),
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, operation_id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, membership_id)
    REFERENCES memberships(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES connections(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES group_management_groups(tenant_id, conversation_id) ON DELETE CASCADE
);

CREATE INDEX group_management_operations_status_idx
  ON group_management_operations(tenant_id, status, updated_at DESC, operation_id);
CREATE INDEX group_management_operations_group_idx
  ON group_management_operations(tenant_id, conversation_id, updated_at DESC, operation_id);

CREATE TABLE group_management_evidence (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('provider', 'event', 'refresh')),
  evidence_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  account_id TEXT,
  connection_id TEXT,
  provider_group_id TEXT,
  matrix_room_id TEXT,
  revision TEXT,
  name TEXT,
  member_provider_ids_json TEXT CHECK (member_provider_ids_json IS NULL OR json_valid(member_provider_ids_json)),
  accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, operation_id, evidence_id),
  FOREIGN KEY (tenant_id, operation_id)
    REFERENCES group_management_operations(tenant_id, operation_id) ON DELETE CASCADE
);

CREATE INDEX group_management_evidence_operation_idx
  ON group_management_evidence(tenant_id, operation_id, observed_at, id);

PRAGMA foreign_keys = ON;
