PRAGMA foreign_keys = ON;

-- Established connection lifecycle changes are durable before any provider I/O.
-- The row is the replay/idempotency fence for relink and explicit disconnect;
-- it never stores QR payloads, bridge process handles, or provider credentials.
CREATE TABLE connection_lifecycle_operations (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('whatsapp', 'telegram', 'messenger', 'linkedin')),
  kind TEXT NOT NULL CHECK (kind IN ('relink', 'disconnect')),
  session_id TEXT,
  idempotency_key TEXT NOT NULL,
  expected_session_generation TEXT NOT NULL,
  provider_login_id TEXT NOT NULL CHECK (length(provider_login_id) BETWEEN 1 AND 512),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'provider_pending', 'succeeded',
    'reconciliation_required', 'failed'
  )),
  replacement_connection_id TEXT,
  error_code TEXT CHECK (error_code IS NULL OR error_code IN (
    'provider_unavailable', 'provider_error', 'provider_identity_mismatch',
    'stale_generation', 'reconciliation_required'
  )),
  evidence_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, operation_id),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES connections(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, identity_id)
    REFERENCES identities(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (replacement_connection_id)
    REFERENCES connections(id) ON DELETE RESTRICT
);

CREATE INDEX connection_lifecycle_operations_connection_idx
  ON connection_lifecycle_operations(tenant_id, connection_id, created_at DESC, operation_id);

CREATE INDEX connection_lifecycle_operations_status_idx
  ON connection_lifecycle_operations(tenant_id, status, updated_at, operation_id);

CREATE INDEX connection_lifecycle_operations_session_idx
  ON connection_lifecycle_operations(tenant_id, session_id);
