-- Phase 0A.1 follow-up: bridge sessions get an explicit `expires_at` so the
-- daemon can age out unused sessions without relying on heartbeat-only logic.
-- The runner ALTERs only when the column is missing on legacy installs;
-- fresh installs already include the column from 0001.
-- (column-existence guard lives in db.ts because SQLite has no IF NOT EXISTS
-- for columns.)

ALTER TABLE bridge_sessions ADD COLUMN expires_at TEXT;
