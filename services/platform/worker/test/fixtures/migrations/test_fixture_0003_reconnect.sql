-- This table belongs only to the Platform reconnect proof fixture.
CREATE TABLE IF NOT EXISTS fixture_reconnect_resource (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  audience TEXT NOT NULL,
  payload TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
