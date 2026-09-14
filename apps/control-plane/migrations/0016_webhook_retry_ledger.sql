PRAGMA foreign_keys = ON;

-- The retry ledger is the source of truth for webhook delivery. Queue and
-- cron wakeups only ask this table what is due; they do not own retry age.
-- Rebuild the table so the in-flight uncertainty state is represented by the
-- schema rather than an overloaded error string.
DROP INDEX IF EXISTS webhook_deliveries_cancel_idx;
DROP INDEX IF EXISTS webhook_deliveries_pending_idx;
DROP INDEX IF EXISTS webhook_deliveries_source_message_idx;

ALTER TABLE webhook_deliveries RENAME TO webhook_deliveries_before_retry;

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_message_id TEXT,
  source_identity_id TEXT,
  source_account_id TEXT,
  source_conversation_id TEXT,
  source_revision TEXT,
  destination_version INTEGER NOT NULL CHECK (destination_version >= 1),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'leased', 'delivered', 'failed', 'uncertain', 'cancelled'
  )),
  first_pending_at TEXT NOT NULL,
  retry_deadline TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  cancelled_at TEXT,
  cancellation_reason TEXT,
  lease_id TEXT,
  lease_expires_at TEXT,
  last_attempt_at TEXT,
  delivered_at TEXT,
  http_status INTEGER,
  error_code TEXT,
  payload_json TEXT,
  last_response_body TEXT CHECK (
    last_response_body IS NULL OR length(last_response_body) <= 8192
  ),
  manual_retry_at TEXT,
  uncertain_at TEXT,
  uncertainty_reason TEXT,
  UNIQUE (subscription_id, source_event_id),
  FOREIGN KEY (tenant_id, subscription_id)
    REFERENCES webhook_subscriptions(tenant_id, id) ON DELETE CASCADE,
  CHECK (
    (status = 'cancelled' AND cancelled_at IS NOT NULL) OR
    (status <> 'cancelled' AND cancelled_at IS NULL)
  )
);

INSERT INTO webhook_deliveries (
  id, tenant_id, subscription_id, source_event_id, source_message_id,
  source_identity_id, source_account_id, source_conversation_id, source_revision,
  destination_version, status, first_pending_at, retry_deadline, attempt_count,
  next_attempt_at, cancelled_at, cancellation_reason, lease_id,
  lease_expires_at, last_attempt_at, delivered_at, http_status, error_code,
  payload_json, last_response_body, manual_retry_at, uncertain_at,
  uncertainty_reason
)
SELECT
  id, tenant_id, subscription_id, source_event_id, source_message_id,
  source_identity_id, source_account_id, source_conversation_id, source_revision,
  destination_version, status, first_pending_at,
  COALESCE(
    retry_deadline,
    strftime('%Y-%m-%dT%H:%M:%fZ', first_pending_at, '+24 hours')
  ),
  attempt_count, next_attempt_at, cancelled_at, cancellation_reason, lease_id,
  lease_expires_at, last_attempt_at, delivered_at, http_status, error_code,
  payload_json, NULL, NULL, NULL, NULL
FROM webhook_deliveries_before_retry;

DROP TABLE webhook_deliveries_before_retry;

CREATE INDEX webhook_deliveries_cancel_idx
  ON webhook_deliveries(subscription_id, destination_version, status, id);
CREATE INDEX webhook_deliveries_pending_idx
  ON webhook_deliveries(
    tenant_id, status, next_attempt_at, retry_deadline, first_pending_at, id
  );
CREATE INDEX webhook_deliveries_source_message_idx
  ON webhook_deliveries(tenant_id, source_message_id, source_revision, id);
CREATE INDEX webhook_deliveries_lease_idx
  ON webhook_deliveries(status, lease_expires_at, id);
