import { newId } from "../ids.js";
import { FabricError } from "../runtime/errors.js";
import {
  asRecord,
  getArray,
  getField,
  getOptionalNumber,
  getOptionalString,
  getString,
  getStringArray,
  safeJsonArray,
  safeJsonRecord
} from "../runtime/input.js";
import type { CallContext } from "../types.js";
import type { SurfaceHost } from "./host.js";

type TaskRow = {
  id: string;
  ts_created: string;
  ts_updated: string;
  requester_agent_id: string;
  assignee: string;
  kind: string;
  status: string;
  correlation_id: string;
  refs_json: string;
  artifacts_json: string;
  workspace_root: string;
  title: string | null;
  goal: string | null;
  project_path: string | null;
  priority: string;
  requested_by: string | null;
  summary: string | null;
  followups_json: string;
  finished_at: string | null;
};

type WorkerRunRow = {
  id: string;
  task_id: string;
  ts_started: string;
  ts_updated: string;
  worker: string;
  status: string;
  project_path: string;
  workspace_mode: string;
  workspace_path: string;
  model_profile: string;
  context_policy: string | null;
  max_runtime_minutes: number | null;
  command_json: string;
  metadata_json: string;
  started_by_session_id: string;
  started_by_agent_id: string;
  origin_peer_id: string;
  test_mode: 0 | 1;
};

type WorkerEventRow = {
  id: string;
  task_id: string;
  worker_run_id: string;
  ts: string;
  kind: string;
  body: string | null;
  refs_json: string;
  metadata_json: string;
  trace_id: string | null;
  cost_usd: number | null;
  agent_id: string;
};

type WorkerCheckpointRow = {
  id: string;
  task_id: string;
  worker_run_id: string;
  ts: string;
  summary_json: string;
  agent_id: string;
};

const WORKERS = new Set(["local-cli", "openhands", "aider", "smolagents", "deepseek-direct", "manual"]);
const WORKSPACE_MODES = new Set(["in_place", "git_worktree", "clone", "sandbox"]);
const EVENT_KINDS = new Set([
  "started",
  "thought_summary",
  "file_changed",
  "command_started",
  "command_finished",
  "test_result",
  "checkpoint",
  "patch_ready",
  "failed",
  "completed"
]);
const FINAL_STATUSES = new Set(["completed", "failed", "canceled"]);

export function fabricTaskCreate(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const title = getString(input, "title");
  const goal = getString(input, "goal");
  const projectPath = getString(input, "projectPath");
  const priority = normalizePriority(getOptionalString(input, "priority"));
  const refs = getStringArray(input, "refs");
  const requestedBy = getOptionalString(input, "requestedBy");

  return host.recordMutation("fabric_task_create", input, context, (session) => {
    const taskId = newId("task");
    const correlationId = context.correlationId ?? newId("corr");
    host.db.db
      .prepare(
        `INSERT INTO tasks (
          id, requester_agent_id, assignee, kind, status, correlation_id,
          refs_json, artifacts_json, workspace_root, title, goal, project_path,
          priority, requested_by
        ) VALUES (?, ?, 'unassigned', 'worker_task', 'created', ?, ?, '[]', ?, ?, ?, ?, ?, ?)`
      )
      .run(taskId, session.agent_id, correlationId, JSON.stringify(refs), session.workspace_root, title, goal, projectPath, priority, requestedBy ?? null);
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "fabric.task.created",
      sourceTable: "tasks",
      sourceId: taskId,
      eventType: "fabric.task.created",
      payload: { title, projectPath, priority, refs, goalPreview: goal.slice(0, 160) },
      testMode: session.test_mode === 1,
      context: { ...context, correlationId }
    });
    return { taskId, status: "created" };
  });
}

export function fabricTaskStartWorker(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const taskId = getString(input, "taskId");
  const worker = normalizeValue(getString(input, "worker"), WORKERS, "worker");
  const projectPath = getString(input, "projectPath");
  const workspaceMode = normalizeValue(getString(input, "workspaceMode"), WORKSPACE_MODES, "workspaceMode");
  const modelProfile = getString(input, "modelProfile");
  const workspacePath = getOptionalString(input, "workspacePath") ?? projectPath;
  const contextPolicy = getOptionalString(input, "contextPolicy") ?? null;
  const maxRuntimeMinutes = getOptionalNumber(input, "maxRuntimeMinutes");
  const command = getArray(input, "command");
  const metadata = asRecord(getField(input, "metadata"));
  if (command.length > 0 && !command.every((item) => typeof item === "string")) {
    throw new FabricError("INVALID_INPUT", "command must be an array of strings", false);
  }

  return host.recordMutation("fabric_task_start_worker", input, context, (session) => {
    const task = requireTask(host, taskId, session.workspace_root);
    ensureNotFinal(task);
    const workerRunId = newId("wrun");
    host.db.db
      .prepare(
        `INSERT INTO worker_runs (
          id, task_id, worker, status, project_path, workspace_mode, workspace_path,
          model_profile, context_policy, max_runtime_minutes, command_json, metadata_json,
          started_by_session_id, started_by_agent_id, origin_peer_id, test_mode
        ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        workerRunId,
        taskId,
        worker,
        projectPath,
        workspaceMode,
        workspacePath,
        modelProfile,
        contextPolicy,
        maxRuntimeMinutes ?? null,
        JSON.stringify(command),
        JSON.stringify(metadata),
        session.id,
        session.agent_id,
        host.originPeerId,
        session.test_mode
      );
    host.db.db
      .prepare("UPDATE tasks SET status = 'running', assignee = ?, project_path = COALESCE(project_path, ?), ts_updated = CURRENT_TIMESTAMP WHERE id = ?")
      .run(worker, projectPath, taskId);
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "fabric.worker.started",
      sourceTable: "worker_runs",
      sourceId: workerRunId,
      eventType: "fabric.worker.started",
      payload: { taskId, worker, projectPath, workspaceMode, workspacePath, modelProfile, contextPolicy, metadata },
      testMode: session.test_mode === 1,
      context: { ...context, correlationId: task.correlation_id }
    });
    return { workerRunId, taskId, status: "running", workspacePath };
  });
}

export function fabricTaskEvent(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const taskId = getString(input, "taskId");
  const workerRunId = getString(input, "workerRunId");
  const kind = normalizeValue(getString(input, "kind"), EVENT_KINDS, "kind");
  const body = getOptionalString(input, "body") ?? null;
  const refs = getStringArray(input, "refs");
  const metadata = asRecord(getField(input, "metadata"));
  const traceId = getOptionalString(input, "traceId") ?? context.traceId ?? null;
  const costUsd = getOptionalNumber(input, "costUsd") ?? null;
  if (costUsd !== null && costUsd < 0) {
    throw new FabricError("INVALID_INPUT", "costUsd must be non-negative", false);
  }

  return host.recordMutation("fabric_task_event", input, context, (session) => {
    const task = requireTask(host, taskId, session.workspace_root);
    const run = requireWorkerRun(host, workerRunId, taskId);
    const eventId = newId("wevt");
    host.db.db
      .prepare(
        `INSERT INTO worker_events (
          id, task_id, worker_run_id, kind, body, refs_json, metadata_json,
          trace_id, cost_usd, session_id, agent_id, origin_peer_id, test_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(eventId, taskId, workerRunId, kind, body, JSON.stringify(refs), JSON.stringify(metadata), traceId, costUsd, session.id, session.agent_id, host.originPeerId, session.test_mode);
    const status = statusAfterEvent(kind, run.status);
    host.db.db.prepare("UPDATE worker_runs SET status = ?, ts_updated = CURRENT_TIMESTAMP WHERE id = ?").run(status.workerRunStatus, workerRunId);
    host.db.db.prepare("UPDATE tasks SET status = ?, ts_updated = CURRENT_TIMESTAMP WHERE id = ?").run(status.taskStatus, taskId);
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "fabric.worker.event",
      sourceTable: "worker_events",
      sourceId: eventId,
      eventType: "fabric.worker.event",
      payload: { taskId, workerRunId, kind, refs, metadata, costUsd },
      testMode: session.test_mode === 1,
      context: { ...context, traceId: traceId ?? undefined, correlationId: task.correlation_id }
    });
    return { eventId, taskId, workerRunId };
  });
}

export function fabricTaskCheckpoint(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const taskId = getString(input, "taskId");
  const workerRunId = getString(input, "workerRunId");
  const summary = asRecord(getField(input, "summary"));
  if (Object.keys(summary).length === 0) {
    throw new FabricError("INVALID_INPUT", "summary must be an object", false);
  }

  return host.recordMutation("fabric_task_checkpoint", input, context, (session) => {
    const task = requireTask(host, taskId, session.workspace_root);
    requireWorkerRun(host, workerRunId, taskId);
    const checkpointId = newId("wchk");
    host.db.db
      .prepare(
        `INSERT INTO worker_checkpoints (
          id, task_id, worker_run_id, summary_json, session_id, agent_id, origin_peer_id, test_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(checkpointId, taskId, workerRunId, JSON.stringify(summary), session.id, session.agent_id, host.originPeerId, session.test_mode);
    host.db.db.prepare("UPDATE worker_runs SET ts_updated = CURRENT_TIMESTAMP WHERE id = ?").run(workerRunId);
    host.db.db.prepare("UPDATE tasks SET ts_updated = CURRENT_TIMESTAMP WHERE id = ?").run(taskId);
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "fabric.worker.checkpointed",
      sourceTable: "worker_checkpoints",
      sourceId: checkpointId,
      eventType: "fabric.worker.checkpointed",
      payload: { taskId, workerRunId, nextAction: typeof summary.nextAction === "string" ? summary.nextAction : undefined },
      testMode: session.test_mode === 1,
      context: { ...context, correlationId: task.correlation_id }
    });
    return { checkpointId, taskId };
  });
}

export function fabricTaskHeartbeat(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const taskId = getString(input, "taskId");
  const workerRunId = getString(input, "workerRunId");
  const taskSummary = getOptionalString(input, "task") ?? null;
  const progress = getOptionalNumber(input, "progress");
  const metadata = asRecord(getField(input, "metadata"));
  if (progress !== undefined && (progress < 0 || progress > 1)) {
    throw new FabricError("INVALID_INPUT", "progress must be between 0 and 1", false);
  }

  return host.recordMutation("fabric_task_heartbeat", input, context, (session) => {
    const task = requireTask(host, taskId, session.workspace_root);
    const run = requireWorkerRun(host, workerRunId, taskId);
    if (FINAL_STATUSES.has(run.status)) {
      throw new FabricError("FABRIC_WORKER_RUN_FINAL", `Worker run ${workerRunId} is already ${run.status}`, false);
    }
    host.db.db.prepare("UPDATE worker_runs SET ts_updated = CURRENT_TIMESTAMP WHERE id = ?").run(workerRunId);
    host.db.db.prepare("UPDATE tasks SET ts_updated = CURRENT_TIMESTAMP WHERE id = ?").run(taskId);
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "fabric.worker.heartbeat",
      sourceTable: "worker_runs",
      sourceId: workerRunId,
      eventType: "fabric.worker.heartbeat",
      payload: { taskId, workerRunId, task: taskSummary, progress, metadata },
      testMode: session.test_mode === 1,
      context: { ...context, correlationId: task.correlation_id }
    });
    return { taskId, workerRunId, status: run.status, ack: true, updatedAt: host.now().toISOString() };
  });
}

export function fabricTaskStatus(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const task = requireTask(host, getString(input, "taskId"), session.workspace_root);
  const includeEvents = getField(input, "includeEvents") === true;
  const includeCheckpoints = getField(input, "includeCheckpoints") === true;
  return taskStatus(host, task, { includeEvents, includeCheckpoints });
}

export function fabricTaskResume(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const task = requireTask(host, getString(input, "taskId"), session.workspace_root);
  const preferredWorker = getOptionalString(input, "preferredWorker");
  if (preferredWorker) normalizeValue(preferredWorker, WORKERS, "preferredWorker");
  const run = latestWorkerRun(host, task.id, preferredWorker);
  const checkpoint = latestCheckpoint(host, task.id, run?.id);
  return {
    taskId: task.id,
    projectPath: task.project_path ?? task.workspace_root,
    workspacePath: run?.workspace_path,
    modelProfile: run?.model_profile,
    contextPolicy: run?.context_policy ?? undefined,
    resumePrompt: buildResumePrompt(task, run, checkpoint),
    latestCheckpoint: checkpoint ? formatCheckpoint(checkpoint) : undefined
  };
}

export function fabricTaskFinish(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const taskId = getString(input, "taskId");
  const workerRunId = getOptionalString(input, "workerRunId");
  const status = getString(input, "status");
  const summary = getString(input, "summary");
  const patchRefs = getStringArray(input, "patchRefs");
  const testRefs = getStringArray(input, "testRefs");
  const followups = getStringArray(input, "followups");
  if (!FINAL_STATUSES.has(status)) {
    throw new FabricError("INVALID_INPUT", "status must be completed, failed, or canceled", false);
  }

  return host.recordMutation("fabric_task_finish", input, context, (session) => {
    const task = requireTask(host, taskId, session.workspace_root);
    if (workerRunId) requireWorkerRun(host, workerRunId, taskId);
    const artifacts = [...safeJsonArray(task.artifacts_json), ...patchRefs.map((ref) => ({ kind: "patch", ref })), ...testRefs.map((ref) => ({ kind: "test", ref }))];
    host.db.db
      .prepare(
        `UPDATE tasks
         SET status = ?, summary = ?, followups_json = ?, artifacts_json = ?, finished_at = CURRENT_TIMESTAMP, ts_updated = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(status, summary, JSON.stringify(followups), JSON.stringify(artifacts), taskId);
    if (workerRunId) {
      host.db.db.prepare("UPDATE worker_runs SET status = ?, ts_updated = CURRENT_TIMESTAMP WHERE id = ?").run(status, workerRunId);
    }
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "fabric.task.finished",
      sourceTable: "tasks",
      sourceId: taskId,
      eventType: "fabric.task.finished",
      payload: { taskId, workerRunId, status, patchRefs, testRefs, followups, summaryPreview: summary.slice(0, 160) },
      testMode: session.test_mode === 1,
      context: { ...context, correlationId: task.correlation_id }
    });
    return { taskId, status };
  });
}

function normalizePriority(value: string | undefined): string {
  if (!value) return "normal";
  if (["low", "normal", "high"].includes(value)) return value;
  throw new FabricError("INVALID_INPUT", "priority must be low, normal, or high", false);
}

function normalizeValue(value: string, allowed: Set<string>, field: string): string {
  if (allowed.has(value)) return value;
  throw new FabricError("INVALID_INPUT", `${field} must be one of: ${[...allowed].join(", ")}`, false);
}

function requireTask(host: SurfaceHost, taskId: string, workspaceRoot: string): TaskRow {
  const row = host.db.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
  if (!row || row.workspace_root !== workspaceRoot) {
    throw new FabricError("FABRIC_TASK_NOT_FOUND", `Task not found: ${taskId}`, false);
  }
  return row;
}

function requireWorkerRun(host: SurfaceHost, workerRunId: string, taskId: string): WorkerRunRow {
  const row = host.db.db.prepare("SELECT * FROM worker_runs WHERE id = ? AND task_id = ?").get(workerRunId, taskId) as
    | WorkerRunRow
    | undefined;
  if (!row) {
    throw new FabricError("FABRIC_WORKER_RUN_NOT_FOUND", `Worker run not found: ${workerRunId}`, false);
  }
  return row;
}

function ensureNotFinal(task: TaskRow): void {
  if (FINAL_STATUSES.has(task.status)) {
    throw new FabricError("FABRIC_TASK_FINAL", `Task ${task.id} is already ${task.status}`, false);
  }
}

function statusAfterEvent(kind: string, currentRunStatus: string): { workerRunStatus: string; taskStatus: string } {
  if (kind === "patch_ready") return { workerRunStatus: "patch_ready", taskStatus: "patch_ready" };
  if (kind === "failed") return { workerRunStatus: "failed", taskStatus: "failed" };
  if (kind === "completed") return { workerRunStatus: "completed", taskStatus: "completed" };
  if (currentRunStatus === "patch_ready") return { workerRunStatus: "patch_ready", taskStatus: "patch_ready" };
  return { workerRunStatus: "running", taskStatus: "running" };
}

function latestWorkerRun(host: SurfaceHost, taskId: string, preferredWorker?: string): WorkerRunRow | undefined {
  if (preferredWorker) {
    return host.db.db
      .prepare("SELECT * FROM worker_runs WHERE task_id = ? AND worker = ? ORDER BY ts_started DESC LIMIT 1")
      .get(taskId, preferredWorker) as WorkerRunRow | undefined;
  }
  return host.db.db.prepare("SELECT * FROM worker_runs WHERE task_id = ? ORDER BY ts_started DESC LIMIT 1").get(taskId) as
    | WorkerRunRow
    | undefined;
}

function latestCheckpoint(host: SurfaceHost, taskId: string, workerRunId?: string): WorkerCheckpointRow | undefined {
  if (workerRunId) {
    return host.db.db
      .prepare("SELECT * FROM worker_checkpoints WHERE task_id = ? AND worker_run_id = ? ORDER BY ts DESC LIMIT 1")
      .get(taskId, workerRunId) as WorkerCheckpointRow | undefined;
  }
  return host.db.db
    .prepare("SELECT * FROM worker_checkpoints WHERE task_id = ? ORDER BY ts DESC LIMIT 1")
    .get(taskId) as WorkerCheckpointRow | undefined;
}

function taskStatus(
  host: SurfaceHost,
  task: TaskRow,
  options: { includeEvents: boolean; includeCheckpoints: boolean }
): Record<string, unknown> {
  const runs = host.db.db.prepare("SELECT * FROM worker_runs WHERE task_id = ? ORDER BY ts_started ASC").all(task.id) as WorkerRunRow[];
  const latest = latestCheckpoint(host, task.id);
  const result: Record<string, unknown> = {
    taskId: task.id,
    status: task.status,
    title: task.title,
    goal: task.goal,
    projectPath: task.project_path ?? task.workspace_root,
    priority: task.priority,
    requestedBy: task.requested_by,
    summary: task.summary,
    followups: safeJsonArray(task.followups_json),
    workerRuns: runs.map(formatWorkerRun),
    latestCheckpoint: latest ? formatCheckpoint(latest) : undefined
  };
  if (options.includeEvents) {
    const events = host.db.db.prepare("SELECT * FROM worker_events WHERE task_id = ? ORDER BY ts ASC").all(task.id) as WorkerEventRow[];
    result.events = events.map(formatEvent);
  }
  if (options.includeCheckpoints) {
    const checkpoints = host.db.db.prepare("SELECT * FROM worker_checkpoints WHERE task_id = ? ORDER BY ts ASC").all(task.id) as WorkerCheckpointRow[];
    result.checkpoints = checkpoints.map(formatCheckpoint);
  }
  return result;
}

function formatWorkerRun(row: WorkerRunRow): Record<string, unknown> {
  return {
    workerRunId: row.id,
    taskId: row.task_id,
    worker: row.worker,
    status: row.status,
    startedAt: row.ts_started,
    updatedAt: row.ts_updated,
    projectPath: row.project_path,
    workspaceMode: row.workspace_mode,
    workspacePath: row.workspace_path,
    modelProfile: row.model_profile,
    contextPolicy: row.context_policy ?? undefined,
    maxRuntimeMinutes: row.max_runtime_minutes ?? undefined,
    command: safeJsonArray(row.command_json),
    metadata: safeJsonRecord(row.metadata_json)
  };
}

function formatEvent(row: WorkerEventRow): Record<string, unknown> {
  return {
    eventId: row.id,
    taskId: row.task_id,
    workerRunId: row.worker_run_id,
    ts: row.ts,
    kind: row.kind,
    body: row.body ?? undefined,
    refs: safeJsonArray(row.refs_json),
    metadata: safeJsonRecord(row.metadata_json),
    traceId: row.trace_id ?? undefined,
    costUsd: row.cost_usd ?? undefined,
    agentId: row.agent_id
  };
}

function formatCheckpoint(row: WorkerCheckpointRow): Record<string, unknown> {
  return {
    checkpointId: row.id,
    taskId: row.task_id,
    workerRunId: row.worker_run_id,
    ts: row.ts,
    summary: safeJsonRecord(row.summary_json),
    agentId: row.agent_id
  };
}

function buildResumePrompt(task: TaskRow, run: WorkerRunRow | undefined, checkpoint: WorkerCheckpointRow | undefined): string {
  const parts = [
    `Resume fabric task ${task.id}.`,
    task.title ? `Title: ${task.title}` : undefined,
    task.goal ? `Goal: ${task.goal}` : undefined,
    `Status: ${task.status}.`,
    `Project path: ${task.project_path ?? task.workspace_root}.`
  ].filter((part): part is string => Boolean(part));
  if (run) {
    parts.push(`Preferred worker: ${run.worker}. Workspace path: ${run.workspace_path}. Model profile: ${run.model_profile}.`);
  }
  if (checkpoint) {
    const summary = safeJsonRecord(checkpoint.summary_json);
    const nextAction = typeof summary.nextAction === "string" ? summary.nextAction : typeof summary.next_action === "string" ? summary.next_action : undefined;
    parts.push(`Latest checkpoint: ${JSON.stringify(summary)}`);
    if (nextAction) parts.push(`Next action: ${nextAction}`);
  }
  return parts.join("\n");
}
