-- Worker/task substrate for external coding runtimes.
-- The daemon records durable lifecycle state; workers execute elsewhere.

ALTER TABLE tasks ADD COLUMN title TEXT;
ALTER TABLE tasks ADD COLUMN goal TEXT;
ALTER TABLE tasks ADD COLUMN project_path TEXT;
ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE tasks ADD COLUMN requested_by TEXT;
ALTER TABLE tasks ADD COLUMN summary TEXT;
ALTER TABLE tasks ADD COLUMN followups_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN finished_at TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_path, status, ts_created);

CREATE TABLE IF NOT EXISTS worker_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  ts_started TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ts_updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  worker TEXT NOT NULL,
  status TEXT NOT NULL,
  project_path TEXT NOT NULL,
  workspace_mode TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  model_profile TEXT NOT NULL,
  context_policy TEXT,
  max_runtime_minutes INTEGER,
  command_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  started_by_session_id TEXT NOT NULL,
  started_by_agent_id TEXT NOT NULL,
  origin_peer_id TEXT NOT NULL,
  test_mode INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_worker_runs_task ON worker_runs(task_id, ts_started);
CREATE INDEX IF NOT EXISTS idx_worker_runs_status ON worker_runs(status, ts_updated);

CREATE TABLE IF NOT EXISTS worker_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  worker_run_id TEXT NOT NULL REFERENCES worker_runs(id),
  ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  kind TEXT NOT NULL,
  body TEXT,
  refs_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  trace_id TEXT,
  cost_usd REAL,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  origin_peer_id TEXT NOT NULL,
  test_mode INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_worker_events_task_ts ON worker_events(task_id, ts);
CREATE INDEX IF NOT EXISTS idx_worker_events_run_ts ON worker_events(worker_run_id, ts);

CREATE TABLE IF NOT EXISTS worker_checkpoints (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  worker_run_id TEXT NOT NULL REFERENCES worker_runs(id),
  ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  summary_json TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  origin_peer_id TEXT NOT NULL,
  test_mode INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_worker_checkpoints_task_ts ON worker_checkpoints(task_id, ts);
CREATE INDEX IF NOT EXISTS idx_worker_checkpoints_run_ts ON worker_checkpoints(worker_run_id, ts);
