CREATE TABLE IF NOT EXISTS creation_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'complete')),
  response_envelope TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS creation_idempotency_expiry ON creation_idempotency(expires_at);

CREATE TABLE IF NOT EXISTS abuse_reports (
  id TEXT PRIMARY KEY,
  report_envelope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'reviewed', 'closed'))
);
CREATE INDEX IF NOT EXISTS abuse_reports_status_created ON abuse_reports(status, created_at);

CREATE TABLE IF NOT EXISTS operator_audit (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  target_fingerprint TEXT,
  created_at INTEGER NOT NULL,
  outcome TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS operator_audit_created ON operator_audit(created_at);
