PRAGMA foreign_keys = ON;

-- A restore lease closes the gap between the last authority read and making
-- restored message state readable.  Removal writers check the same row in
-- their authority INSERT, so a new deletion epoch either wins before the
-- lease or is blocked until the restored service has been released.
CREATE TABLE restore_activation_leases (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  lease_token_hash TEXT NOT NULL CHECK (length(lease_token_hash) = 64),
  deletion_epoch INTEGER NOT NULL CHECK (deletion_epoch >= 0),
  ledger_head TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX restore_activation_leases_active_tenant_idx
  ON restore_activation_leases(tenant_id)
  WHERE status = 'active';

CREATE INDEX restore_activation_leases_expiry_idx
  ON restore_activation_leases(status, expires_at, tenant_id);
