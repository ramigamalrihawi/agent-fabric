-- ADR-0014 / Lane D: durable plan-chain state.
-- The model-calling orchestrator can be a separate application; these tables
-- are the local source of truth for chain state, revisions, critiques,
-- questions, decisions, and accepted-plan memory refs.

CREATE TABLE IF NOT EXISTS plan_chains (
  id TEXT PRIMARY KEY,
  ts_started TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ts_ended TEXT,
  task TEXT NOT NULL,
  models_json TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  state TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 1,
  max_rounds INTEGER NOT NULL DEFAULT 3,
  budget_usd REAL NOT NULL DEFAULT 5,
  total_spent_usd REAL NOT NULL DEFAULT 0,
  output_format TEXT NOT NULL DEFAULT 'markdown',
  show_lineage_to_a INTEGER NOT NULL DEFAULT 0,
  halt_reason TEXT,
  final_memory_id TEXT,
  origin_peer_id TEXT NOT NULL,
  session_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_chains_workspace_state ON plan_chains(workspace_root, state, ts_started);

CREATE TABLE IF NOT EXISTS plan_revisions (
  id TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL REFERENCES plan_chains(id),
  round INTEGER NOT NULL,
  step TEXT NOT NULL,
  model TEXT NOT NULL,
  body TEXT NOT NULL,
  change_log_json TEXT,
  confidence REAL,
  least_confident_about_json TEXT,
  cost_usd REAL,
  trace_id TEXT,
  ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_plan_revisions_chain ON plan_revisions(chain_id, round, step);

CREATE TABLE IF NOT EXISTS plan_critiques (
  id TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL REFERENCES plan_chains(id),
  round INTEGER NOT NULL,
  reviewing_revision_id TEXT NOT NULL REFERENCES plan_revisions(id),
  structured_json TEXT NOT NULL,
  body TEXT NOT NULL,
  model TEXT,
  cost_usd REAL,
  trace_id TEXT,
  ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_plan_critiques_chain ON plan_critiques(chain_id, round);

CREATE TABLE IF NOT EXISTS plan_questions (
  id TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL REFERENCES plan_chains(id),
  raised_at_step TEXT NOT NULL,
  raised_by_model TEXT NOT NULL,
  severity TEXT NOT NULL,
  body TEXT NOT NULL,
  collab_ask_id TEXT,
  answered_at TEXT,
  answer TEXT,
  ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_plan_questions_chain ON plan_questions(chain_id, answered_at, severity);
