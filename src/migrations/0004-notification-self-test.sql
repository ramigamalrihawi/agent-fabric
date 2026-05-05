-- Phase 0A.1 acceptance gate: the notification self-test table backs the
-- declared-vs-observed capability split. Fresh installs already include this
-- table from 0001; the runner only re-runs the CREATE on legacy installs.

CREATE TABLE IF NOT EXISTS notification_self_tests (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  host_name TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  challenge TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  observed TEXT NOT NULL DEFAULT 'unknown',
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_notification_self_tests_session ON notification_self_tests(session_id, requested_at);
