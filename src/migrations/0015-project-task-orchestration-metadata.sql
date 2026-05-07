-- Optional manager/workstream metadata for token-efficient Senior-mode queues.
-- These fields are lightweight routing labels; raw prompts and context stay out of the queue tables.

ALTER TABLE project_queue_tasks ADD COLUMN manager_id TEXT;
ALTER TABLE project_queue_tasks ADD COLUMN parent_manager_id TEXT;
ALTER TABLE project_queue_tasks ADD COLUMN parent_queue_id TEXT;
ALTER TABLE project_queue_tasks ADD COLUMN workstream TEXT;
ALTER TABLE project_queue_tasks ADD COLUMN cost_center TEXT;
ALTER TABLE project_queue_tasks ADD COLUMN escalation_target TEXT;

CREATE INDEX IF NOT EXISTS idx_project_queue_tasks_manager ON project_queue_tasks(queue_id, manager_id);
CREATE INDEX IF NOT EXISTS idx_project_queue_tasks_workstream ON project_queue_tasks(queue_id, workstream);
