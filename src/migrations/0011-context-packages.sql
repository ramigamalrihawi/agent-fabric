-- Sanitized context-package summaries captured at preflight time.
-- Raw prompt/message/file content is intentionally not stored here.

CREATE TABLE IF NOT EXISTS context_packages (
  id TEXT PRIMARY KEY,
  preflight_request_id TEXT NOT NULL UNIQUE REFERENCES llm_preflight_requests(id),
  ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  host_name TEXT,
  workspace_root TEXT NOT NULL,
  client TEXT NOT NULL,
  task_type TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  raw_content_stored INTEGER NOT NULL DEFAULT 0,
  context_summary_json TEXT NOT NULL DEFAULT '{}',
  token_breakdown_json TEXT NOT NULL DEFAULT '{}',
  files_json TEXT NOT NULL DEFAULT '[]',
  tool_schemas_json TEXT NOT NULL DEFAULT '[]',
  mcp_servers_json TEXT NOT NULL DEFAULT '[]',
  memories_json TEXT NOT NULL DEFAULT '[]',
  sensitive_flags_json TEXT NOT NULL DEFAULT '[]',
  repeated_regions_json TEXT NOT NULL DEFAULT '[]',
  stale_items_json TEXT NOT NULL DEFAULT '[]',
  origin_peer_id TEXT NOT NULL,
  trace_id TEXT,
  correlation_id TEXT,
  test_mode INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_context_packages_workspace_ts ON context_packages(workspace_root, ts);
CREATE INDEX IF NOT EXISTS idx_context_packages_preflight ON context_packages(preflight_request_id);
