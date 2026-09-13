PRAGMA foreign_keys = ON;

-- The provider identity is a keyed digest. Raw WhatsApp JIDs, phone numbers,
-- QR payloads, and bridge process handles never enter the control directory.
CREATE TABLE connection_provider_identities (
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('whatsapp', 'telegram', 'messenger', 'linkedin')),
  identity_key TEXT NOT NULL CHECK (length(identity_key) = 64),
  connection_id TEXT NOT NULL,
  link_session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, provider, identity_key),
  UNIQUE (tenant_id, link_session_id),
  UNIQUE (tenant_id, connection_id),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES connections(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX connection_provider_identities_connection_idx
  ON connection_provider_identities(tenant_id, connection_id);
