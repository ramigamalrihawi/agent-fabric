-- Recoverable human approval loop for llm_preflight decisions.
-- The daemon stores approval state and token hashes only. UI and terminal
-- prompts live in clients.

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  preflight_request_id TEXT NOT NULL UNIQUE REFERENCES llm_preflight_requests(id),
  ts_created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decision TEXT,
  decided_at TEXT,
  decided_by_session_id TEXT,
  decided_by_agent_id TEXT,
  note TEXT,
  scope TEXT,
  bound_resource_id TEXT,
  approval_token_hash TEXT,
  approval_token_expires_at TEXT,
  approval_token_max_uses INTEGER NOT NULL DEFAULT 1,
  approval_token_uses INTEGER NOT NULL DEFAULT 0,
  origin_peer_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  host_name TEXT,
  workspace_root TEXT NOT NULL,
  client TEXT NOT NULL,
  task_type TEXT NOT NULL,
  selected_provider TEXT NOT NULL,
  selected_model TEXT NOT NULL,
  selected_reasoning TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  reserved_output_tokens INTEGER NOT NULL,
  estimated_cost_usd REAL NOT NULL,
  risk TEXT NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  test_mode INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_approval_requests_pending ON approval_requests(workspace_root, status, ts_created);
CREATE INDEX IF NOT EXISTS idx_approval_requests_token ON approval_requests(approval_token_hash);
