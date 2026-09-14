/**
 * Migration contract for the controlled-copy retention ledger.
 *
 * The numbered D1 migration is intentionally owned by the integration worker.
 * Keeping the SQL here lets that worker register the exact schema without
 * making this feature silently create shared tables at runtime.
 */
export const CONTROLLED_COPY_RETENTION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS controlled_copy_operations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    removal_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    content_generation TEXT NOT NULL,
    deletion_epoch INTEGER NOT NULL CHECK (deletion_epoch >= 1),
    store TEXT NOT NULL CHECK (
      store IN (
        'projection_backup', 'synapse', 'bridge_database',
        'media_store', 'queue', 'restic_snapshot',
        'session_credentials', 'account_keys'
      )
    ),
    owner TEXT NOT NULL,
    content_class TEXT NOT NULL CHECK (
      content_class IN (
        'message', 'attachment', 'bridge_mapping', 'queue_item',
        'session_credential', 'account_key', 'inventory'
      )
    ),
    reference TEXT NOT NULL,
    deletion_method TEXT NOT NULL CHECK (
      deletion_method IN ('delete', 'quarantine', 'expire', 'age_out', 'preserve')
    ),
    required INTEGER NOT NULL CHECK (required IN (0, 1)),
    copy_created_at TEXT NOT NULL,
    cleanup_margin_ms INTEGER NOT NULL CHECK (
      cleanup_margin_ms >= 0 AND cleanup_margin_ms < 2592000000
    ),
    cleanup_deadline TEXT NOT NULL,
    retention_deadline TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN ('planned', 'leased', 'complete', 'preserved', 'incomplete', 'failed')
    ),
    lease_token TEXT,
    lease_expires_at TEXT,
    last_error TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (
      tenant_id, removal_id, store, resource_id, content_generation, reference
    )
  )`,
  `CREATE INDEX IF NOT EXISTS controlled_copy_operations_due_idx
    ON controlled_copy_operations(status, cleanup_deadline, lease_expires_at, id)`,
  `CREATE INDEX IF NOT EXISTS controlled_copy_operations_resource_idx
    ON controlled_copy_operations(
      tenant_id, removal_id, resource_id, content_generation, store, id
    )`,
  `CREATE TABLE IF NOT EXISTS controlled_copy_evidence (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    removal_id TEXT NOT NULL,
    store TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    content_generation TEXT NOT NULL,
    deletion_epoch INTEGER NOT NULL CHECK (deletion_epoch >= 1),
    status TEXT NOT NULL CHECK (
      status IN (
        'deleted', 'quarantined', 'expired', 'aged_out', 'preserved',
        'missing', 'permission_denied', 'lifecycle_pending', 'unknown', 'failed'
      )
    ),
    content_present INTEGER NOT NULL CHECK (content_present IN (0, 1)),
    evidence_source TEXT NOT NULL,
    object_reference TEXT,
    detail TEXT,
    worker_token TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    FOREIGN KEY (operation_id) REFERENCES controlled_copy_operations(id)
  )`,
  `CREATE INDEX IF NOT EXISTS controlled_copy_evidence_operation_idx
    ON controlled_copy_evidence(operation_id, observed_at, id)`,
  `CREATE INDEX IF NOT EXISTS controlled_copy_evidence_resource_idx
    ON controlled_copy_evidence(
      tenant_id, removal_id, resource_id, content_generation, store, observed_at
    )`,
] as const;

export const CONTROLLED_COPY_RETENTION_SCHEMA_VERSION = "controlled-copy-v1";
