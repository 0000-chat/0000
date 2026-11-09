-- Discovery progress is independent of outbound execution and authority.
CREATE TABLE tenant_wakeup_bootstrap (
    version INTEGER PRIMARY KEY CHECK (version = 1),
    directory_cursor TEXT NOT NULL DEFAULT '',
    discovery_complete INTEGER NOT NULL DEFAULT 0 CHECK (discovery_complete IN (0, 1))
);
INSERT INTO tenant_wakeup_bootstrap (version) VALUES (1);

-- No tenant FK: independently identified historical/orphan names must remain
-- representable without creating directory membership or send authority.
CREATE TABLE tenant_wakeup_targets (
    tenant_id TEXT PRIMARY KEY,
    source TEXT NOT NULL CHECK (source IN ('directory', 'historical')),
    state TEXT NOT NULL DEFAULT 'queued'
        CHECK (state IN ('queued', 'running', 'retry', 'scheduled', 'idle', 'gap')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
    due_at_ms INTEGER NOT NULL DEFAULT 0,
    claim_token TEXT,
    lease_until_ms INTEGER,
    outcome TEXT,
    alarm_at_ms INTEGER,
    checked_at_ms INTEGER,
    CHECK ((state = 'running' AND claim_token IS NOT NULL AND lease_until_ms IS NOT NULL)
        OR (state <> 'running' AND claim_token IS NULL AND lease_until_ms IS NULL))
);
CREATE INDEX tenant_wakeup_targets_due ON tenant_wakeup_targets (state, due_at_ms, tenant_id);
CREATE INDEX tenant_wakeup_targets_leases ON tenant_wakeup_targets (state, lease_until_ms);

-- Close concurrent directory admission, including IDs behind the scan cursor.
-- This registry proves future admission only, never historical completeness.
CREATE TRIGGER tenant_wakeup_directory_insert AFTER INSERT ON tenants BEGIN
    INSERT OR IGNORE INTO tenant_wakeup_targets (tenant_id, source)
        VALUES (NEW.id, 'directory');
END;
