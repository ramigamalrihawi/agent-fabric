-- Deterministic policy aliases for higher-level workflows.
-- Alias resolution is explainable and audited; learned routing comes later.

CREATE TABLE IF NOT EXISTS policy_aliases (
  alias TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  billing_mode TEXT NOT NULL DEFAULT 'metered',
  source TEXT NOT NULL DEFAULT 'runtime_seed',
  priority INTEGER NOT NULL DEFAULT 100,
  max_input_tokens INTEGER,
  max_estimated_cost_usd REAL,
  risk_ceiling TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_policy_aliases_provider_model ON policy_aliases(provider, model);
