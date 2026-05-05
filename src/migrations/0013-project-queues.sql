-- Project-level queue substrate for Agent Fabric Console orchestration.
-- Raw prompts and large context bodies are intentionally not stored here.

CREATE TABLE IF NOT EXISTS project_queues (
  id TEXT PRIMARY KEY,
  workspace_root TEXT NOT NULL,
  project_path TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt_summary TEXT NOT NULL,
  pipeline_profile TEXT NOT NULL DEFAULT 'balanced',
  max_parallel_agents INTEGER NOT NULL DEFAULT 4,
  status TEXT NOT NULL DEFAULT 'created',
  plan_chain_id TEXT,
  created_by_session_id TEXT NOT NULL,
  created_by_agent_id TEXT NOT NULL,
  origin_peer_id TEXT NOT NULL,
  test_mode INTEGER NOT NULL DEFAULT 0,
  ts_created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ts_updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_project_queues_workspace_project ON project_queues(workspace_root, project_path);
CREATE INDEX IF NOT EXISTS idx_project_queues_status ON project_queues(status);

CREATE TABLE IF NOT EXISTS project_queue_stages (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL REFERENCES project_queues(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  model_alias TEXT,
  input_summary TEXT,
  output_summary TEXT,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  origin_peer_id TEXT NOT NULL,
  test_mode INTEGER NOT NULL DEFAULT 0,
  ts_created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_project_queue_stages_queue ON project_queue_stages(queue_id, ts_created);

CREATE TABLE IF NOT EXISTS project_queue_tasks (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL REFERENCES project_queues(id) ON DELETE CASCADE,
  fabric_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  phase TEXT,
  category TEXT NOT NULL DEFAULT 'implementation',
  status TEXT NOT NULL DEFAULT 'queued',
  priority TEXT NOT NULL DEFAULT 'normal',
  parallel_group TEXT,
  parallel_safe INTEGER NOT NULL DEFAULT 1,
  risk TEXT NOT NULL DEFAULT 'medium',
  expected_files_json TEXT NOT NULL DEFAULT '[]',
  acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
  required_tools_json TEXT NOT NULL DEFAULT '[]',
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  assigned_worker_run_id TEXT,
  patch_refs_json TEXT NOT NULL DEFAULT '[]',
  test_refs_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  origin_peer_id TEXT NOT NULL,
  test_mode INTEGER NOT NULL DEFAULT 0,
  ts_created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ts_updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_project_queue_tasks_queue_status ON project_queue_tasks(queue_id, status);
CREATE INDEX IF NOT EXISTS idx_project_queue_tasks_fabric_task ON project_queue_tasks(fabric_task_id);

CREATE TABLE IF NOT EXISTS project_queue_decisions (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL REFERENCES project_queues(id) ON DELETE CASCADE,
  decision TEXT NOT NULL,
  note TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  origin_peer_id TEXT NOT NULL,
  test_mode INTEGER NOT NULL DEFAULT 0,
  ts_created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_project_queue_decisions_queue ON project_queue_decisions(queue_id, ts_created);

CREATE TABLE IF NOT EXISTS tool_context_proposals (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL REFERENCES project_queues(id) ON DELETE CASCADE,
  queue_task_id TEXT REFERENCES project_queue_tasks(id) ON DELETE SET NULL,
  fabric_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  mcp_servers_json TEXT NOT NULL DEFAULT '[]',
  tools_json TEXT NOT NULL DEFAULT '[]',
  memories_json TEXT NOT NULL DEFAULT '[]',
  context_refs_json TEXT NOT NULL DEFAULT '[]',
  model_alias TEXT,
  reasoning TEXT,
  safety_warnings_json TEXT NOT NULL DEFAULT '[]',
  approval_required INTEGER NOT NULL DEFAULT 1,
  missing_grants_json TEXT NOT NULL DEFAULT '[]',
  decision TEXT,
  decision_note TEXT,
  decided_by_session_id TEXT,
  decided_by_agent_id TEXT,
  ts_decided TEXT,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  origin_peer_id TEXT NOT NULL,
  test_mode INTEGER NOT NULL DEFAULT 0,
  ts_created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ts_updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tool_context_proposals_queue ON tool_context_proposals(queue_id, ts_created);
CREATE INDEX IF NOT EXISTS idx_tool_context_proposals_status ON tool_context_proposals(status);

CREATE TABLE IF NOT EXISTS tool_context_policies (
  id TEXT PRIMARY KEY,
  workspace_root TEXT NOT NULL,
  project_path TEXT NOT NULL,
  grant_key TEXT NOT NULL,
  grant_kind TEXT NOT NULL,
  value_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved',
  decided_by_session_id TEXT NOT NULL,
  decided_by_agent_id TEXT NOT NULL,
  origin_peer_id TEXT NOT NULL,
  test_mode INTEGER NOT NULL DEFAULT 0,
  ts_decided TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_root, project_path, grant_key)
);
CREATE INDEX IF NOT EXISTS idx_tool_context_policies_project ON tool_context_policies(workspace_root, project_path);
