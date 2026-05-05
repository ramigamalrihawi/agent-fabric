-- ADR-0018: add system-time columns to memories.
--
-- SQLite cannot ADD COLUMN with DEFAULT CURRENT_TIMESTAMP, so legacy upgrades
-- add a constant default and immediately backfill. Fresh installs get the
-- CURRENT_TIMESTAMP default from 0001-init.sql.

ALTER TABLE memories ADD COLUMN recorded_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE memories ADD COLUMN recorded_until TEXT;

UPDATE memories
SET recorded_at = COALESCE(valid_from, created_at, CURRENT_TIMESTAMP)
WHERE recorded_at IS NULL OR recorded_at = '' OR recorded_at = '1970-01-01T00:00:00.000Z';

CREATE INDEX IF NOT EXISTS idx_memories_system_time
  ON memories(namespace, recorded_at, recorded_until);

CREATE INDEX IF NOT EXISTS idx_memories_bitemporal
  ON memories(namespace, valid_from, invalid_at, recorded_at, recorded_until);
