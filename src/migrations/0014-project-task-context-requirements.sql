-- First-class tool/context requirements for project queue tasks.
-- These stay as metadata/grant requests; raw context bodies are not stored.

ALTER TABLE project_queue_tasks ADD COLUMN required_mcp_servers_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE project_queue_tasks ADD COLUMN required_memories_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE project_queue_tasks ADD COLUMN required_context_refs_json TEXT NOT NULL DEFAULT '[]';
