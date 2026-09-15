PRAGMA foreign_keys = OFF;

-- Contacting a new recipient is an explicit identity and account operation.
-- Rebuild the three historical CHECK-constrained grant tables so existing
-- rows and idempotency history survive the vocabulary extension.
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
    'conversation.read', 'conversation.create', 'message.send', 'message.mutate', 'receipt.send',
    'connection.read', 'connection.manage', 'export.create', 'replay.run',
    'retention.manage', 'break_glass.inspect'
  )),
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, identity_id) REFERENCES identities(tenant_id, id) ON DELETE CASCADE,
  PRIMARY KEY (tenant_id, membership_id, identity_id, operation_scope)
);

INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at)
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
    'conversation.read', 'conversation.create', 'message.send', 'webhook.manage'
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
    'conversation.read', 'conversation.create', 'message.send', 'webhook.manage'
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

-- Contact and DM provisioning must carry the exact verified bridge login for
-- the selected account. Existing rows remain unavailable to contact actions
-- until their connection is relinked, because the legacy directory stored
-- only the keyed identity digest.
ALTER TABLE connection_provider_identities
  ADD COLUMN provider_login_id TEXT
    CHECK (provider_login_id IS NULL OR length(provider_login_id) BETWEEN 1 AND 256);

CREATE INDEX connection_provider_identities_login_idx
  ON connection_provider_identities(tenant_id, provider, provider_login_id);

-- This snapshot is the account-bound source of truth for recipient selection.
-- Raw provider identifiers are retained only in this scoped directory; the
-- gateway still owns credentials and provider session state.
CREATE TABLE contact_resolution_candidates (
  contact_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES connection_accounts(account_id) ON DELETE RESTRICT,
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('whatsapp', 'telegram', 'messenger', 'linkedin')),
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 512),
  current_lid TEXT CHECK (current_lid IS NULL OR length(current_lid) BETWEEN 1 AND 512),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  identifiers_json TEXT NOT NULL CHECK (json_valid(identifiers_json)),
  stable_key TEXT NOT NULL CHECK (length(stable_key) BETWEEN 1 AND 512),
  match_reason TEXT NOT NULL CHECK (match_reason IN ('name', 'phone', 'provider_id')),
  candidate_revision TEXT NOT NULL CHECK (length(candidate_revision) = 64),
  observed_at TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  status TEXT NOT NULL CHECK (status IN ('active', 'stale')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, account_id, contact_id),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES connections(tenant_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX contact_resolution_stable_key_idx
  ON contact_resolution_candidates(tenant_id, account_id, stable_key);
CREATE INDEX contact_resolution_account_query_idx
  ON contact_resolution_candidates(tenant_id, account_id, status, display_name, contact_id);
CREATE INDEX contact_resolution_provider_idx
  ON contact_resolution_candidates(tenant_id, account_id, provider_id, current_lid);

CREATE TABLE direct_chat_creation_operations (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES connection_accounts(account_id) ON DELETE RESTRICT,
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('whatsapp', 'telegram', 'messenger', 'linkedin')),
  contact_id TEXT NOT NULL,
  candidate_revision TEXT NOT NULL CHECK (length(candidate_revision) = 64),
  conversation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('pending', 'created', 'already_exists', 'uncertain', 'failed')),
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 512),
  current_lid TEXT CHECK (current_lid IS NULL OR length(current_lid) BETWEEN 1 AND 512),
  matrix_room_id TEXT,
  evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, conversation_id),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES connections(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, account_id, contact_id)
    REFERENCES contact_resolution_candidates(tenant_id, account_id, contact_id)
      ON DELETE RESTRICT
);

CREATE INDEX direct_chat_creation_account_idx
  ON direct_chat_creation_operations(tenant_id, account_id, status, updated_at, operation_id);

PRAGMA foreign_keys = ON;
