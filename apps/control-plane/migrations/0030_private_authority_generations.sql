PRAGMA foreign_keys = OFF;

-- Private provider authority is pinned to the connection generation that was
-- current when the operation was accepted. Existing rows remain readable but
-- have an empty generation and therefore cannot pass a later claim.
ALTER TABLE receipt_authority_intents
  ADD COLUMN session_generation TEXT NOT NULL DEFAULT '';
ALTER TABLE receipt_dispatch_claims
  ADD COLUMN session_generation TEXT NOT NULL DEFAULT '';
ALTER TABLE group_authority_intents
  ADD COLUMN session_generation TEXT NOT NULL DEFAULT '';
ALTER TABLE group_dispatch_claims
  ADD COLUMN session_generation TEXT NOT NULL DEFAULT '';
ALTER TABLE receipt_operations
  ADD COLUMN session_generation TEXT NOT NULL DEFAULT '';
ALTER TABLE group_creation_operations
  ADD COLUMN session_generation TEXT NOT NULL DEFAULT '';
ALTER TABLE group_management_operations
  ADD COLUMN session_generation TEXT NOT NULL DEFAULT '';

-- Direct-chat operations predate membership and generation binding. Preserve
-- populated rows while making all new private reservations exact.
ALTER TABLE direct_chat_creation_operations
  ADD COLUMN membership_id TEXT NOT NULL DEFAULT '';
ALTER TABLE direct_chat_creation_operations
  ADD COLUMN session_generation TEXT NOT NULL DEFAULT '';

CREATE INDEX direct_chat_creation_authority_idx
  ON direct_chat_creation_operations(
    tenant_id, membership_id, identity_id, account_id, connection_id,
    conversation_id, request_hash
  );

CREATE UNIQUE INDEX direct_chat_creation_tenant_operation_idx
  ON direct_chat_creation_operations(tenant_id, operation_id);

CREATE TABLE contact_authority_intents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  session_generation TEXT NOT NULL,
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
    REFERENCES direct_chat_creation_operations(tenant_id, operation_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, membership_id)
    REFERENCES memberships(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, identity_id)
    REFERENCES identities(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES connections(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX contact_authority_intents_claim_idx
  ON contact_authority_intents(tenant_id, status, updated_at, operation_id);

CREATE TABLE contact_dispatch_claims (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  session_generation TEXT NOT NULL,
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
    REFERENCES contact_authority_intents(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX contact_dispatch_claims_status_idx
  ON contact_dispatch_claims(tenant_id, status, expires_at, operation_id);

PRAGMA foreign_keys = ON;
