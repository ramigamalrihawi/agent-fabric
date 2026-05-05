-- ADR-0017 / Lane H.1: preflight cost/risk decisions before model calls.
-- Prices and reservation defaults are seeded by runtime code, not hard-coded
-- in the migration, so pricing updates do not require schema churn.

CREATE TABLE IF NOT EXISTS route_cheapness (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  billing_mode TEXT NOT NULL DEFAULT 'metered',
  source TEXT NOT NULL,
  confidence TEXT NOT NULL,
  input_price_per_mtok_micros INTEGER NOT NULL,
  output_price_per_mtok_micros INTEGER NOT NULL,
  cache_read_price_per_mtok_micros INTEGER,
  discount_expires_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, model)
);
CREATE INDEX IF NOT EXISTS idx_route_cheapness_provider_model ON route_cheapness(provider, model);

CREATE TABLE IF NOT EXISTS output_reservations (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  task_type TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  p50_output_tokens INTEGER NOT NULL,
  p95_output_tokens INTEGER NOT NULL,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(model, task_type, reasoning)
);
CREATE INDEX IF NOT EXISTS idx_output_reservations_lookup ON output_reservations(model, task_type, reasoning);

CREATE TABLE IF NOT EXISTS llm_preflight_requests (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  host_name TEXT,
  workspace_root TEXT NOT NULL,
  client TEXT NOT NULL,
  task_type TEXT NOT NULL,
  task_json TEXT NOT NULL,
  candidate_model TEXT NOT NULL,
  requested_provider TEXT,
  selected_provider TEXT NOT NULL,
  selected_model TEXT NOT NULL,
  requested_reasoning TEXT,
  selected_reasoning TEXT NOT NULL,
  billing_preference TEXT,
  budget_scope TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  reserved_output_tokens INTEGER NOT NULL,
  estimated_cost_usd REAL NOT NULL,
  risk TEXT NOT NULL,
  decision TEXT NOT NULL,
  advisory_only INTEGER NOT NULL DEFAULT 0,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  sensitive_flags_json TEXT NOT NULL DEFAULT '[]',
  context_summary_json TEXT NOT NULL DEFAULT '{}',
  tool_schema_count INTEGER NOT NULL DEFAULT 0,
  mcp_server_count INTEGER NOT NULL DEFAULT 0,
  origin_peer_id TEXT NOT NULL,
  trace_id TEXT,
  correlation_id TEXT,
  idempotency_key TEXT,
  approval_token_hash TEXT,
  test_mode INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_llm_preflight_workspace_ts ON llm_preflight_requests(workspace_root, ts);
CREATE INDEX IF NOT EXISTS idx_llm_preflight_session ON llm_preflight_requests(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_llm_preflight_model ON llm_preflight_requests(selected_provider, selected_model, ts);
CREATE INDEX IF NOT EXISTS idx_llm_preflight_decision ON llm_preflight_requests(decision, ts);
