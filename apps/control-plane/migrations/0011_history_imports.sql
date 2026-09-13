PRAGMA foreign_keys = ON;

-- Provider evidence is account-scoped and separate from the legacy list of
-- connection operations. A source can describe an upstream feature without
-- proving that this deployment can use it for a linked account.
CREATE TABLE provider_capability_records (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES connection_accounts(account_id) ON DELETE RESTRICT,
  connection_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('whatsapp', 'telegram', 'messenger', 'linkedin')),
  capability TEXT NOT NULL CHECK (capability IN (
    'history.import', 'media.read', 'contact.lookup', 'group.manage', 'receipt.read'
  )),
  status TEXT NOT NULL CHECK (status IN ('supported', 'conditional', 'unverified', 'unsupported')),
  freshness TEXT NOT NULL CHECK (freshness IN ('fresh', 'stale', 'unknown', 'unavailable')),
  provider_version TEXT CHECK (provider_version IS NULL OR length(provider_version) BETWEEN 1 AND 128),
  proof_source TEXT NOT NULL CHECK (length(proof_source) BETWEEN 1 AND 512),
  provider_evidence_json TEXT NOT NULL CHECK (json_valid(provider_evidence_json)),
  product_claim TEXT NOT NULL CHECK (length(product_claim) BETWEEN 1 AND 2000),
  observed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, account_id, capability),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES connections(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX provider_capability_records_connection_idx
  ON provider_capability_records(tenant_id, connection_id, capability);

CREATE TABLE history_imports (
  import_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES connection_accounts(account_id) ON DELETE RESTRICT,
  connection_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('whatsapp', 'telegram', 'messenger', 'linkedin')),
  status TEXT NOT NULL CHECK (status IN ('started', 'active', 'completed', 'partial', 'failed')),
  availability TEXT NOT NULL CHECK (availability IN ('available', 'blocked', 'unavailable')),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  requested_start_at TEXT NOT NULL,
  requested_end_at TEXT NOT NULL,
  source_start_at TEXT,
  source_end_at TEXT,
  max_events INTEGER NOT NULL CHECK (max_events BETWEEN 1 AND 100000),
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  completed_range_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_range_count >= 0),
  total_range_count INTEGER NOT NULL DEFAULT 1 CHECK (total_range_count >= 1),
  gap_count INTEGER NOT NULL DEFAULT 0 CHECK (gap_count >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code IN (
    'runtime_unavailable', 'provider_refused', 'provider_timeout',
    'provider_error', 'malformed_range', 'duplicate_event_conflict',
    'interrupted', 'bounded_retry_exhausted'
  )),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (tenant_id, account_id, idempotency_key),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES connections(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX history_imports_account_idx
  ON history_imports(tenant_id, account_id, updated_at DESC, import_id DESC);

CREATE UNIQUE INDEX history_imports_active_account_idx
  ON history_imports(tenant_id, account_id)
  WHERE status IN ('started', 'active');

CREATE TABLE history_import_ranges (
  range_id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES history_imports(import_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES connection_accounts(account_id) ON DELETE RESTRICT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'completed', 'partial', 'failed', 'gap')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10),
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  source_cursor TEXT,
  gap_code TEXT CHECK (gap_code IS NULL OR length(gap_code) BETWEEN 1 AND 128),
  error_code TEXT CHECK (error_code IS NULL OR error_code IN (
    'runtime_unavailable', 'provider_refused', 'provider_timeout',
    'provider_error', 'malformed_range', 'duplicate_event_conflict',
    'interrupted', 'bounded_retry_exhausted'
  )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (start_at < end_at),
  UNIQUE (import_id, start_at, end_at)
);

CREATE INDEX history_import_ranges_import_idx
  ON history_import_ranges(import_id, status, start_at, range_id);

CREATE TABLE history_import_events (
  import_id TEXT NOT NULL REFERENCES history_imports(import_id) ON DELETE CASCADE,
  range_id TEXT NOT NULL REFERENCES history_import_ranges(range_id) ON DELETE CASCADE,
  source_event_id TEXT NOT NULL CHECK (length(source_event_id) BETWEEN 1 AND 1024),
  event_hash TEXT NOT NULL CHECK (length(event_hash) = 64),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (import_id, source_event_id)
);

CREATE INDEX history_import_events_range_idx
  ON history_import_events(import_id, range_id, occurred_at, source_event_id);

CREATE TRIGGER history_import_account_binding_insert
BEFORE INSERT ON history_imports
WHEN NOT EXISTS (
  SELECT 1 FROM connection_accounts AS ca
  JOIN connections AS c ON c.id = ca.connection_id
  WHERE ca.account_id = NEW.account_id
    AND ca.connection_id = NEW.connection_id
    AND c.tenant_id = NEW.tenant_id
    AND c.identity_id = NEW.identity_id
    AND c.provider = NEW.provider
)
BEGIN
  SELECT RAISE(ABORT, 'history_import_account_binding_mismatch');
END;

CREATE TRIGGER history_import_range_account_binding_insert
BEFORE INSERT ON history_import_ranges
WHEN NOT EXISTS (
  SELECT 1 FROM history_imports
  WHERE import_id = NEW.import_id AND account_id = NEW.account_id
)
BEGIN
  SELECT RAISE(ABORT, 'history_import_range_account_binding_mismatch');
END;

CREATE TRIGGER history_import_event_range_binding_insert
BEFORE INSERT ON history_import_events
WHEN NOT EXISTS (
  SELECT 1 FROM history_import_ranges
  WHERE import_id = NEW.import_id AND range_id = NEW.range_id
)
BEGIN
  SELECT RAISE(ABORT, 'history_import_event_range_binding_mismatch');
END;
