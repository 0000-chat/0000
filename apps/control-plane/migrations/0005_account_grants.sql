PRAGMA foreign_keys = ON;

-- Account and chat grants are deliberately separate from identity_grants. The
-- identity grant answers whether a logical identity may perform an operation;
-- these rows answer which connected account (and which chats) that operation
-- may reach.
CREATE TABLE account_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES connection_accounts(account_id) ON DELETE RESTRICT,
  operation_scope TEXT NOT NULL CHECK (operation_scope IN (
    'conversation.read', 'message.send', 'webhook.manage'
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

-- SQLite does not have a composite reference to the account's owning tenant in
-- connection_accounts, so keep the cross-tenant check explicit at the schema
-- boundary as well as in the repository.
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

CREATE TABLE permission_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  requester_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  requester_membership_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES connection_accounts(account_id) ON DELETE RESTRICT,
  operation_scope TEXT NOT NULL CHECK (operation_scope IN (
    'conversation.read', 'message.send', 'webhook.manage'
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

CREATE INDEX account_grants_membership_scope_idx
  ON account_grants(tenant_id, membership_id, identity_id, operation_scope, status, account_id, id);
CREATE INDEX account_grants_account_idx
  ON account_grants(tenant_id, account_id, status, id);
CREATE INDEX account_grant_chats_account_idx
  ON account_grant_chats(tenant_id, account_id, chat_id, grant_id);
CREATE INDEX permission_requests_requester_idx
  ON permission_requests(tenant_id, requester_membership_id, status, created_at, id);
CREATE INDEX permission_requests_tenant_idx
  ON permission_requests(tenant_id, status, created_at, id);
