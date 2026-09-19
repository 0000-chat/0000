-- Realtime ticket rows retain only the verified Platform tuple and expiry.
-- The opaque credential is handed to the Durable Object in trusted memory and
-- is never persisted here.
ALTER TABLE realtime_tickets ADD COLUMN platform_json TEXT;

