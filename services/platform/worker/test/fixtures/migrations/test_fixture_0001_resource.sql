-- This table belongs only to the Platform protected-resource fixture.
CREATE TABLE IF NOT EXISTS fixture_resource (
  id TEXT PRIMARY KEY NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('organization', 'guest')),
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
