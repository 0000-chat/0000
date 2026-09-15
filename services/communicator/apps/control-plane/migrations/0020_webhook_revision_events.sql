PRAGMA foreign_keys = ON;

-- Preserve the canonical source event id while recording which webhook
-- payload contract the durable worker must produce after a restart.
ALTER TABLE webhook_deliveries
  ADD COLUMN event_type TEXT NOT NULL DEFAULT 'message.created'
  CHECK (event_type IN (
    'message.created', 'message.edited', 'message.deleted', 'deletion.tombstone'
  ));

CREATE INDEX webhook_deliveries_event_type_idx
  ON webhook_deliveries(tenant_id, source_message_id, event_type, id);
