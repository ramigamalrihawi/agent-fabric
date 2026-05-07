ALTER TABLE project_queue_tasks ADD COLUMN client_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_queue_tasks_queue_client_key
ON project_queue_tasks(queue_id, client_key)
WHERE client_key IS NOT NULL;
