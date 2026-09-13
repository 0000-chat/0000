PRAGMA foreign_keys = ON;

-- This ledger is independent of rebuildable tenant projections.  Its
-- presence is the durable suppression authority; physical purge is a later
-- operation and is represented separately by purge_status.
CREATE TABLE removal_authority (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (
    length(resource_type) BETWEEN 1 AND 64 AND
    resource_type GLOB '[a-z]*' AND
    resource_type NOT GLOB '*[^a-z0-9_.-]*'
  ),
  resource_id TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 2048),
  content_generation TEXT NOT NULL CHECK (length(content_generation) BETWEEN 1 AND 256),
  account_id TEXT,
  conversation_id TEXT,
  source_event_id TEXT,
  source_object_key TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('requested', 'expired', 'retention')),
  removed_at TEXT NOT NULL,
  deletion_epoch INTEGER NOT NULL CHECK (deletion_epoch >= 1),
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'failed')),
  purge_status TEXT NOT NULL CHECK (
    purge_status IN ('not_started', 'pending', 'complete', 'failed')
  ),
  failure_code TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, resource_type, resource_id, content_generation)
);

CREATE INDEX removal_authority_resource_idx
  ON removal_authority(tenant_id, resource_type, resource_id, deletion_epoch DESC);
CREATE INDEX removal_authority_scope_idx
  ON removal_authority(
    tenant_id, account_id, conversation_id, resource_type, resource_id,
    content_generation
  );
CREATE INDEX removal_authority_epoch_idx
  ON removal_authority(tenant_id, deletion_epoch, id);

-- Expiry scheduling is a durable wakeup boundary.  A scheduler only claims a
-- row here; it must record removal_authority through the same authority path
-- before marking the schedule complete.
CREATE TABLE removal_expiry_schedule (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  content_generation TEXT NOT NULL,
  account_id TEXT,
  conversation_id TEXT,
  source_event_id TEXT,
  source_object_key TEXT,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('scheduled', 'processing', 'completed', 'failed')
  ),
  lease_token TEXT,
  lease_expires_at TEXT,
  removal_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, resource_type, resource_id, content_generation)
);

CREATE INDEX removal_expiry_due_idx
  ON removal_expiry_schedule(status, expires_at, lease_expires_at, id);
CREATE INDEX removal_expiry_tenant_idx
  ON removal_expiry_schedule(tenant_id, status, expires_at, id);
