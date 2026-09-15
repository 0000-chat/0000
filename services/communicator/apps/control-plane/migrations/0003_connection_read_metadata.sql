PRAGMA foreign_keys = ON;

ALTER TABLE connections ADD COLUMN last_synced_at TEXT;
ALTER TABLE connections ADD COLUMN attention_code TEXT
  CHECK (attention_code IS NULL OR length(attention_code) BETWEEN 1 AND 100);
ALTER TABLE connections ADD COLUMN sort_position INTEGER NOT NULL DEFAULT 0
  CHECK (sort_position >= 0);

CREATE TABLE connection_capabilities (
  tenant_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (capability IN (
    'message.send', 'message.edit', 'message.delete',
    'reaction.add', 'reaction.remove', 'receipt.read',
    'typing.send', 'attachment.send'
  )),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, connection_id, capability),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES connections(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX connection_capabilities_connection_idx
  ON connection_capabilities(connection_id, capability);
