-- Phase 0A.2 follow-up: add `test_mode` to `memory_injections` so test-mode
-- traffic is excludable from lift queries, and create the `memory_eval_reports`
-- table for the paired-eval gate. Fresh installs already have both from 0001;
-- the runner only applies these statements on legacy installs.
-- (column-existence guard lives in db.ts.)

ALTER TABLE memory_injections ADD COLUMN test_mode INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS memory_eval_reports (
  id TEXT PRIMARY KEY,
  suite TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  passed INTEGER NOT NULL,
  cases_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'local'
);

CREATE INDEX IF NOT EXISTS idx_memory_eval_reports_suite ON memory_eval_reports(suite, generated_at);
