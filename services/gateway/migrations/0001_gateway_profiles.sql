CREATE TABLE IF NOT EXISTS gateway_profiles (
  organization_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, profile_id)
);

CREATE TABLE IF NOT EXISTS gateway_profile_tool_grants (
  organization_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, profile_id, operation_id),
  FOREIGN KEY (organization_id, profile_id)
    REFERENCES gateway_profiles (organization_id, profile_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS gateway_profile_tool_grants_operation
  ON gateway_profile_tool_grants (operation_id);
