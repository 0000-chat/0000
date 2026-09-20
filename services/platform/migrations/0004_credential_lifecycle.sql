-- T04 credential metadata and mutation-level rotation invariants.
ALTER TABLE platform_service ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE platform_service ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE platform_service ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;

ALTER TABLE platform_credential ADD COLUMN name TEXT NOT NULL DEFAULT 'Personal API credential';
ALTER TABLE platform_credential ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE platform_credential ADD COLUMN revoked_reason TEXT;
ALTER TABLE platform_credential ADD COLUMN replaced_by_id TEXT;
ALTER TABLE platform_credential ADD COLUMN predecessor_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS platform_credential_predecessor_unique
  ON platform_credential(predecessor_id)
  WHERE predecessor_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS platform_credential_replacement_unique
  ON platform_credential(replaced_by_id)
  WHERE replaced_by_id IS NOT NULL;
