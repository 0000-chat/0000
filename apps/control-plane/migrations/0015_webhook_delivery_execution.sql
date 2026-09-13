PRAGMA foreign_keys = ON;

-- Ticket 26 extends the T13 delivery skeleton with enough source identity and
-- outcome state for durable initial delivery. Retry policy remains owned by a
-- later ticket, so these columns stay nullable where that policy will fill
-- them in.
ALTER TABLE webhook_deliveries ADD COLUMN source_message_id TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN source_identity_id TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN source_account_id TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN source_conversation_id TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN source_revision TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN lease_id TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN lease_expires_at TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN last_attempt_at TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN delivered_at TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN http_status INTEGER;
ALTER TABLE webhook_deliveries ADD COLUMN error_code TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN payload_json TEXT;

CREATE INDEX webhook_deliveries_pending_idx
  ON webhook_deliveries(tenant_id, status, next_attempt_at, first_pending_at, id);

CREATE INDEX webhook_deliveries_source_message_idx
  ON webhook_deliveries(tenant_id, source_message_id, source_revision, id);
