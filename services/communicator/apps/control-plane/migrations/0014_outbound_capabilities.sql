PRAGMA foreign_keys = ON;

-- Extend the account capability evidence vocabulary without discarding
-- existing history/import observations.  The table is account-scoped, so the
-- primary key remains stable while the CHECK constraint is rebuilt.
ALTER TABLE provider_capability_records
  RENAME TO provider_capability_records_v1;

CREATE TABLE provider_capability_records (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES connection_accounts(account_id) ON DELETE RESTRICT,
  connection_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('whatsapp', 'telegram', 'messenger', 'linkedin')),
  capability TEXT NOT NULL CHECK (capability IN (
    'history.import', 'media.read', 'contact.lookup', 'group.manage', 'receipt.read',
    'message.send.text', 'account.route'
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

INSERT INTO provider_capability_records (
  tenant_id, account_id, connection_id, identity_id, provider, capability,
  status, freshness, provider_version, proof_source, provider_evidence_json,
  product_claim, observed_at, updated_at
)
SELECT tenant_id, account_id, connection_id, identity_id, provider, capability,
       status, freshness, provider_version, proof_source, provider_evidence_json,
       product_claim, observed_at, updated_at
FROM provider_capability_records_v1;

DROP TABLE provider_capability_records_v1;

CREATE INDEX provider_capability_records_connection_idx
  ON provider_capability_records(tenant_id, connection_id, capability);
