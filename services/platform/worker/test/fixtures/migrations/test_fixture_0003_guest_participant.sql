-- T08 stores service-owned participant proof separately from Platform identity.
CREATE TABLE IF NOT EXISTS fixture_resource_participant (
  resource_id TEXT NOT NULL REFERENCES fixture_resource(id) ON DELETE CASCADE,
  guest_id TEXT NOT NULL REFERENCES platform_guest(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES platform_service(service_id),
  audience TEXT NOT NULL,
  link_token TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (resource_id, guest_id, service_id),
  UNIQUE (resource_id, service_id, link_token)
);

CREATE INDEX IF NOT EXISTS fixture_resource_participant_guest_idx
  ON fixture_resource_participant(guest_id, service_id, audience, resource_id);
