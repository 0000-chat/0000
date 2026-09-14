PRAGMA foreign_keys = ON;

-- Receipt and group provider calls have durable operation records, but they do
-- not have message command/dispatch rows. Keep their acceptance and one-shot
-- claim fences separate from message.send so an operation can never be made
-- to look like a text message merely to fit the older authority schema.
CREATE TABLE receipt_authority_intents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
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
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'uncertain')),
  uncertain_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, operation_id),
  FOREIGN KEY (tenant_id, operation_id)
    REFERENCES receipt_operations(tenant_id, operation_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, membership_id)
    REFERENCES memberships(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, identity_id)
    REFERENCES identities(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES connections(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX receipt_authority_intents_claim_idx
  ON receipt_authority_intents(tenant_id, status, updated_at, operation_id);

CREATE TABLE receipt_dispatch_claims (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
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
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('claimed', 'uncertain')),
  uncertain_reason TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, reservation_id),
  UNIQUE (tenant_id, operation_id),
  FOREIGN KEY (tenant_id, reservation_id)
    REFERENCES receipt_authority_intents(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX receipt_dispatch_claims_status_idx
  ON receipt_dispatch_claims(tenant_id, status, expires_at, operation_id);

-- Group creation and group management use different grant scopes and durable
-- operation tables. The operation_kind discriminator keeps those records
-- distinct while allowing the private claim protocol to share one bounded
-- route and one SQL implementation.
CREATE TABLE group_authority_intents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('group.create', 'group.manage')),
  operation_id TEXT NOT NULL,
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
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'uncertain')),
  uncertain_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, operation_kind, operation_id),
  FOREIGN KEY (tenant_id, membership_id)
    REFERENCES memberships(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, identity_id)
    REFERENCES identities(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES connections(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX group_authority_intents_claim_idx
  ON group_authority_intents(tenant_id, operation_kind, status, updated_at, operation_id);

CREATE TABLE group_dispatch_claims (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('group.create', 'group.manage')),
  operation_id TEXT NOT NULL,
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
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('claimed', 'uncertain')),
  uncertain_reason TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, reservation_id),
  UNIQUE (tenant_id, operation_kind, operation_id),
  FOREIGN KEY (tenant_id, reservation_id)
    REFERENCES group_authority_intents(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX group_dispatch_claims_status_idx
  ON group_dispatch_claims(tenant_id, operation_kind, status, expires_at, operation_id);
