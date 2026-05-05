-- Initial schema (Phase 0A.1). Snapshot of all tables as they should look on a
-- fresh install. Subsequent migrations target upgrade-only callers.

CREATE TABLE IF NOT EXISTS _schema_versions (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bridge_sessions (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT,
  origin_peer_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  vendor TEXT,
  host_name TEXT NOT NULL,
  host_version TEXT,
  transport TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  workspace_source TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  notifications_declared TEXT NOT NULL DEFAULT 'unknown',
  notifications_observed TEXT NOT NULL DEFAULT 'unknown',
  notification_self_test_json TEXT,
  litellm_routeable INTEGER NOT NULL DEFAULT 0,
  outcome_reporting TEXT NOT NULL DEFAULT 'none',
  session_token_hash TEXT NOT NULL,
  expires_at TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_heartbeat_at TEXT,
  ended_at TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  test_mode INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_bridge_sessions_agent ON bridge_sessions(agent_id, started_at);
CREATE INDEX IF NOT EXISTS idx_bridge_sessions_workspace ON bridge_sessions(workspace_root, started_at);

CREATE TABLE IF NOT EXISTS agent_cards (
  agent_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  host_name TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  source_session_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS presence (
  agent_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  current_task TEXT,
  eta TEXT
);

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

CREATE TABLE IF NOT EXISTS idempotency_keys (
  session_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (session_id, tool, idempotency_key)
);

CREATE TABLE IF NOT EXISTS peer_watermarks (
  peer_id TEXT PRIMARY KEY,
  last_event_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  session_id TEXT,
  agent_id TEXT,
  host_name TEXT,
  workspace_root TEXT,
  action TEXT NOT NULL,
  source_table TEXT,
  source_id TEXT,
  redacted_payload_json TEXT NOT NULL,
  test_mode INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  origin_peer_id TEXT NOT NULL,
  session_id TEXT,
  turn_id TEXT,
  trace_id TEXT,
  span_id TEXT,
  parent_span_id TEXT,
  correlation_id TEXT,
  workspace_root TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  host TEXT,
  event_type TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  idempotency_key TEXT,
  payload_json TEXT NOT NULL,
  redaction_state TEXT NOT NULL DEFAULT 'redacted',
  test_mode INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_source ON events(source_table, source_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_trace ON events(trace_id, span_id);
CREATE INDEX IF NOT EXISTS idx_events_workspace_ts ON events(workspace_root, ts);
CREATE INDEX IF NOT EXISTS idx_events_session_ts ON events(session_id, ts);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sender_agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  origin_peer_id TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  recipient TEXT,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  refs_json TEXT NOT NULL DEFAULT '[]',
  ask_id TEXT,
  task_id TEXT,
  correlation_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_recipient_ts ON messages(workspace_root, recipient, ts);

CREATE TABLE IF NOT EXISTS asks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  ts_created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ts_updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  asker_agent_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  kind TEXT NOT NULL,
  urgency TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open',
  question TEXT NOT NULL,
  refs_json TEXT NOT NULL DEFAULT '[]',
  workspace_root TEXT NOT NULL,
  correlation_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asks_recipient_status ON asks(workspace_root, recipient, status);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  ts_created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ts_updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  requester_agent_id TEXT NOT NULL,
  assignee TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  refs_json TEXT NOT NULL DEFAULT '[]',
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  workspace_root TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_status ON tasks(workspace_root, assignee, status);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  ts_created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ts_expires TEXT,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  paths_json TEXT NOT NULL,
  note TEXT,
  mode TEXT NOT NULL DEFAULT 'normal',
  overlapping INTEGER NOT NULL DEFAULT 0,
  released INTEGER NOT NULL DEFAULT 0,
  released_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_claims_active ON claims(workspace_root, released, ts_expires) WHERE released = 0;

CREATE TABLE IF NOT EXISTS cursors (
  agent_id TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  last_read_message_id TEXT,
  last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (agent_id, workspace_root)
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  title TEXT NOT NULL,
  decided TEXT NOT NULL,
  recorded_by_agent_id TEXT NOT NULL,
  participants_json TEXT NOT NULL DEFAULT '[]',
  rationale TEXT,
  supersedes TEXT,
  workspace_root TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  namespace TEXT NOT NULL,
  body TEXT NOT NULL,
  body_embedding BLOB,
  intent_keys_json TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'pending_review',
  severity TEXT NOT NULL DEFAULT 'normal',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  access_count INTEGER NOT NULL DEFAULT 0,
  confirmations_json TEXT NOT NULL DEFAULT '[]',
  contradictions_json TEXT NOT NULL DEFAULT '[]',
  tool_version_json TEXT,
  refs_json TEXT NOT NULL DEFAULT '[]',
  valid_from TEXT,
  invalid_at TEXT,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  recorded_until TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  transferred_from TEXT,
  created_by_session_id TEXT,
  created_by_agent_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_type_ns ON memories(type, namespace, archived, status);
CREATE INDEX IF NOT EXISTS idx_memories_ns_active ON memories(namespace, archived, invalid_at);
CREATE INDEX IF NOT EXISTS idx_memories_system_time ON memories(namespace, recorded_at, recorded_until);
CREATE INDEX IF NOT EXISTS idx_memories_bitemporal ON memories(namespace, valid_from, invalid_at, recorded_at, recorded_until);

CREATE TABLE IF NOT EXISTS memory_injections (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  turn_id TEXT,
  session_id TEXT,
  agent_id TEXT NOT NULL,
  host_name TEXT,
  namespace TEXT NOT NULL,
  trace_id TEXT,
  span_id TEXT,
  correlation_id TEXT,
  intent_hash TEXT NOT NULL,
  intent_payload_json TEXT NOT NULL,
  memories_returned_json TEXT NOT NULL DEFAULT '[]',
  silent_ab INTEGER NOT NULL DEFAULT 0,
  silent_ab_eligible INTEGER NOT NULL DEFAULT 0,
  outcome TEXT,
  outcome_detail TEXT,
  outcome_reported_at TEXT,
  test_mode INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_memory_injections_window ON memory_injections(namespace, ts);

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

CREATE TABLE IF NOT EXISTS cost_events (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  session_id TEXT,
  origin_peer_id TEXT NOT NULL,
  trace_id TEXT,
  span_id TEXT,
  parent_span_id TEXT,
  correlation_id TEXT,
  coverage_source TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  agent_id TEXT,
  workspace_root TEXT,
  feature_tag TEXT,
  branch TEXT,
  commit_sha TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cached_tokens INTEGER,
  cost_usd REAL,
  request_id TEXT,
  raw_meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_cost_events_ts ON cost_events(ts);
CREATE INDEX IF NOT EXISTS idx_cost_events_feature ON cost_events(feature_tag, ts);

CREATE TABLE IF NOT EXISTS cost_billing (
  id TEXT PRIMARY KEY,
  ts_polled TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  meter_subcategory TEXT,
  cost_usd REAL,
  usage_qty REAL,
  usage_unit TEXT,
  period_start TEXT,
  period_end TEXT,
  raw_meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_cost_billing_resource ON cost_billing(resource_id, ts_polled);
