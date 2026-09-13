PRAGMA foreign_keys = ON;

-- A range is also the durable unit of scheduled work. The cursor remains in
-- history_import_ranges, while these fields make the next page wakeable and
-- protect it from overlapping cron ticks or manual replays.
ALTER TABLE history_import_ranges ADD COLUMN next_attempt_at TEXT;
ALTER TABLE history_import_ranges ADD COLUMN lease_token TEXT;
ALTER TABLE history_import_ranges ADD COLUMN lease_until TEXT;
ALTER TABLE history_import_ranges ADD COLUMN operation_key TEXT;

CREATE INDEX history_import_ranges_scheduler_idx
  ON history_import_ranges(status, next_attempt_at, lease_until, updated_at, range_id);
