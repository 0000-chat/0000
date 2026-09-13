PRAGMA foreign_keys = ON;

-- A delivery carries the tenant removal epoch observed when it was queued.  A
-- later provider-request claim can therefore compare the durable expectation
-- with the current authority in one write instead of relying on an async read.
ALTER TABLE webhook_deliveries
  ADD COLUMN removal_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE webhook_deliveries
  ADD COLUMN provider_request_started_at TEXT;

-- Rows created before this fence existed must retain the epoch that was
-- current at migration time.  A source-specific authority check still
-- suppresses rows whose source was already removed.
UPDATE webhook_deliveries
SET removal_epoch = COALESCE(
  (
    SELECT MAX(removal_authority.deletion_epoch)
    FROM removal_authority
    WHERE removal_authority.tenant_id = webhook_deliveries.tenant_id
  ),
  0
);

CREATE INDEX webhook_deliveries_removal_fence_idx
  ON webhook_deliveries(
    tenant_id, status, provider_request_started_at, removal_epoch, id
  );
