-- Outcome feedback for cost-aware route decisions.
-- This is the data substrate for future routing intelligence; no automatic
-- rerouting is performed in this migration or surface.

CREATE TABLE IF NOT EXISTS route_outcomes (
  id TEXT PRIMARY KEY,
  preflight_request_id TEXT NOT NULL REFERENCES llm_preflight_requests(id),
  ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  host_name TEXT,
  workspace_root TEXT NOT NULL,
  client TEXT NOT NULL,
  task_type TEXT NOT NULL,
  selected_provider TEXT NOT NULL,
  selected_model TEXT NOT NULL,
  selected_reasoning TEXT NOT NULL,
  outcome TEXT NOT NULL,
  quality_score REAL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  cost_usd REAL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  trace_id TEXT,
  correlation_id TEXT,
  origin_peer_id TEXT NOT NULL,
  test_mode INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_route_outcomes_preflight ON route_outcomes(preflight_request_id, ts);
CREATE INDEX IF NOT EXISTS idx_route_outcomes_workspace_ts ON route_outcomes(workspace_root, ts);
CREATE INDEX IF NOT EXISTS idx_route_outcomes_route ON route_outcomes(selected_provider, selected_model, task_type, outcome);
