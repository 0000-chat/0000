ALTER TABLE creation_idempotency ADD COLUMN lease_token TEXT NOT NULL DEFAULT '';

ALTER TABLE abuse_reports ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS abuse_reports_expiry ON abuse_reports(expires_at);

ALTER TABLE operator_audit ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS operator_audit_expiry ON operator_audit(expires_at);
