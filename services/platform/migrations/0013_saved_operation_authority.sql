-- References retain authority lineage, never bearer credentials or copied grants.
CREATE TABLE platform_saved_operation (
  id TEXT PRIMARY KEY NOT NULL,
  authority TEXT NOT NULL,
  service_id TEXT NOT NULL REFERENCES platform_service(service_id),
  subject_id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organization(id),
  audience TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES platform_credential(id),
  lineage_kind TEXT NOT NULL CHECK (lineage_kind IN ('session', 'installation', 'grant')),
  lineage_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (service_id, operation_id)
);

CREATE TRIGGER platform_saved_operation_immutable
BEFORE UPDATE ON platform_saved_operation
BEGIN
  SELECT RAISE(ABORT, 'saved operation authority is immutable');
END;
