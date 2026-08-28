PRAGMA foreign_keys = ON;

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('human', 'service', 'agent', 'operator')),
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (issuer, subject)
);

CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (tenant_id, principal_id),
  UNIQUE (tenant_id, id)
);

CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  identity_kind TEXT NOT NULL CHECK (identity_kind IN ('human', 'agent')),
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, id)
);

CREATE TABLE identity_grants (
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  operation_scope TEXT NOT NULL CHECK (operation_scope IN (
    'conversation.read', 'message.send', 'message.mutate', 'receipt.send',
    'connection.read', 'connection.manage', 'export.create', 'replay.run',
    'retention.manage', 'break_glass.inspect'
  )),
  created_at TEXT NOT NULL,
  -- Composite references prevent a grant from crossing tenant ownership boundaries.
  FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, identity_id) REFERENCES identities(tenant_id, id) ON DELETE CASCADE,
  PRIMARY KEY (tenant_id, membership_id, identity_id, operation_scope)
);

CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  identity_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('whatsapp', 'telegram', 'messenger', 'linkedin')),
  display_label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'connected', 'syncing', 'ready', 'attention_required',
    'disconnected', 'revoked', 'unlinked'
  )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, identity_id) REFERENCES identities(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE connection_routes (
  connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
  gateway_route_id TEXT NOT NULL,
  bridge_instance_id TEXT NOT NULL,
  matrix_user_id TEXT NOT NULL,
  matrix_room_namespace TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE break_glass_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  operator_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  identity_id TEXT,
  operation_scope TEXT NOT NULL CHECK (operation_scope = 'break_glass.inspect'),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, identity_id) REFERENCES identities(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE revoked_tokens (
  issuer TEXT NOT NULL,
  token_id TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  revoked_at TEXT NOT NULL,
  PRIMARY KEY (issuer, token_id)
);

CREATE TABLE directory_mutations (
  idempotency_key TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  mutation_type TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  created_at TEXT NOT NULL
);

CREATE TRIGGER directory_mutation_idempotency_conflict
BEFORE UPDATE OF request_hash ON directory_mutations
WHEN OLD.request_hash <> NEW.request_hash
BEGIN
  SELECT RAISE(ABORT, 'idempotency_key_conflict');
END;

CREATE TABLE control_event_outbox (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  occurred_at TEXT NOT NULL
);

CREATE INDEX memberships_principal_status_idx
  ON memberships(principal_id, status, tenant_id);
CREATE INDEX identities_tenant_status_idx
  ON identities(tenant_id, status, id);
CREATE INDEX identity_grants_membership_idx
  ON identity_grants(membership_id, identity_id, operation_scope);
CREATE INDEX connections_identity_status_idx
  ON connections(identity_id, status, id);
CREATE INDEX break_glass_active_idx
  ON break_glass_grants(operator_principal_id, tenant_id, expires_at, revoked_at);
CREATE INDEX revoked_tokens_principal_idx
  ON revoked_tokens(principal_id, revoked_at);
CREATE INDEX outbox_pending_idx
  ON control_event_outbox(delivered_at, created_at, event_id);
CREATE INDEX audit_tenant_time_idx
  ON audit_events(tenant_id, occurred_at, id);
