PRAGMA foreign_keys = ON;

-- Durable archive-side evidence is separate from the rebuildable projection
-- and the active removal authority.  A purge can crash after a replacement is
-- written or after the old manifest is hidden; these rows make both states
-- resumable and keep an incomplete result visible to administrators.
CREATE TABLE archive_purge_operations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  removal_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  content_generation TEXT NOT NULL,
  deletion_epoch INTEGER NOT NULL CHECK (deletion_epoch >= 1),
  status TEXT NOT NULL CHECK (
    status IN ('planned', 'rewritten', 'pending_deletion', 'complete', 'incomplete')
  ),
  safety_deadline TEXT NOT NULL,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (tenant_id, removal_id)
);

CREATE INDEX archive_purge_operations_status_idx
  ON archive_purge_operations(tenant_id, status, updated_at, id);

CREATE TABLE archive_purge_objects (
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  original_manifest_key TEXT NOT NULL,
  original_data_key TEXT NOT NULL,
  replacement_manifest_key TEXT,
  replacement_data_key TEXT,
  original_canonical_sha256 TEXT NOT NULL,
  replacement_canonical_sha256 TEXT,
  original_first_event_id TEXT NOT NULL,
  original_last_event_id TEXT NOT NULL,
  replacement_first_event_id TEXT,
  replacement_last_event_id TEXT,
  original_event_count INTEGER NOT NULL CHECK (original_event_count >= 1),
  replacement_event_count INTEGER NOT NULL CHECK (replacement_event_count >= 0),
  removed_event_ids_json TEXT NOT NULL,
  retained_event_ids_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('planned', 'replacement_written', 'manifest_deleted', 'data_deleted', 'incomplete')
  ),
  manifest_deleted_at TEXT,
  data_deleted_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (operation_id, original_manifest_key),
  FOREIGN KEY (operation_id) REFERENCES archive_purge_operations(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, original_manifest_key)
);

CREATE INDEX archive_purge_objects_state_idx
  ON archive_purge_objects(operation_id, state, original_manifest_key);

-- A tenant has one canonical archive namespace.  This lease serializes
-- replacement rewrites for different removals so two authorities cannot
-- publish sibling replacements that each retain the other authority's data.
-- Expiry makes the lock recoverable after a crashed worker.
CREATE TABLE archive_purge_locks (
  tenant_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
