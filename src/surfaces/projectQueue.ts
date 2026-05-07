import { existsSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { newId, stableHash } from "../ids.js";
import { FabricError } from "../runtime/errors.js";
import { formatMemory } from "../runtime/format.js";
import {
  asRecord,
  expandIntentString,
  getArray,
  getField,
  getOptionalBoolean,
  getOptionalNumber,
  getOptionalString,
  getString,
  getStringArray,
  intentKeysFromIntent,
  safeJsonArray,
  safeJsonRecord
} from "../runtime/input.js";
import { defaultMaxEventsPerLane, maxParallelAgentsLimit, maxQueueEventLimit, maxQueueListLimit } from "../runtime/limits.js";
import { countWhere } from "../runtime/queries.js";
import type { CallContext } from "../types.js";
import type { SurfaceHost } from "./host.js";
import { llmApprove, llmPreflight } from "./costPolicy.js";
import { fabricTaskResume } from "./worker.js";

type ProjectQueueRow = {
  id: string;
  workspace_root: string;
  project_path: string;
  title: string;
  prompt_summary: string;
  pipeline_profile: string;
  max_parallel_agents: number;
  status: string;
  plan_chain_id: string | null;
  created_by_session_id: string;
  created_by_agent_id: string;
  origin_peer_id: string;
  test_mode: 0 | 1;
  ts_created: string;
  ts_updated: string;
};

type ProjectQueueStageRow = {
  id: string;
  queue_id: string;
  stage: string;
  status: string;
  model_alias: string | null;
  input_summary: string | null;
  output_summary: string | null;
  artifacts_json: string;
  warnings_json: string;
  session_id: string;
  agent_id: string;
  ts_created: string;
};

type ProjectQueueTaskRow = {
  id: string;
  queue_id: string;
  fabric_task_id: string | null;
  client_key: string | null;
  title: string;
  goal: string;
  phase: string | null;
  manager_id: string | null;
  parent_manager_id: string | null;
  parent_queue_id: string | null;
  workstream: string | null;
  cost_center: string | null;
  escalation_target: string | null;
  category: string;
  status: string;
  priority: string;
  parallel_group: string | null;
  parallel_safe: 0 | 1;
  risk: string;
  expected_files_json: string;
  acceptance_criteria_json: string;
  required_tools_json: string;
  required_mcp_servers_json: string;
  required_memories_json: string;
  required_context_refs_json: string;
  depends_on_json: string;
  assigned_worker_run_id: string | null;
  patch_refs_json: string;
  test_refs_json: string;
  summary: string | null;
  session_id: string;
  agent_id: string;
  ts_created: string;
  ts_updated: string;
};

type ProjectQueueTaskAddResult = {
  queueTaskId: string;
  fabricTaskId?: string;
  clientKey?: string;
  title: string;
  status: string;
  phase?: string;
  managerId?: string;
  workstream?: string;
  dependsOn: unknown[];
  reused?: boolean;
};

type ProjectQueueDecisionRow = {
  id: string;
  queue_id: string;
  decision: string;
  note: string | null;
  metadata_json: string;
  session_id: string;
  agent_id: string;
  ts_created: string;
};

type ToolContextProposalRow = {
  id: string;
  queue_id: string;
  queue_task_id: string | null;
  fabric_task_id: string | null;
  status: string;
  mcp_servers_json: string;
  tools_json: string;
  memories_json: string;
  context_refs_json: string;
  model_alias: string | null;
  reasoning: string | null;
  safety_warnings_json: string;
  approval_required: 0 | 1;
  missing_grants_json: string;
  decision: string | null;
  decision_note: string | null;
  decided_by_session_id: string | null;
  decided_by_agent_id: string | null;
  ts_decided: string | null;
  session_id: string;
  agent_id: string;
  ts_created: string;
  ts_updated: string;
};

type ToolContextPolicyRow = {
  id: string;
  workspace_root: string;
  project_path: string;
  grant_key: string;
  grant_kind: string;
  value_json: string;
  status: string;
  decided_by_session_id: string;
  decided_by_agent_id: string;
  ts_decided: string;
};

type ApprovalRequestWithPreflightRow = {
  id: string;
  preflight_request_id: string;
  ts_created: string;
  expires_at: string;
  status: string;
  decision: string | null;
  decided_at: string | null;
  note: string | null;
  client: string;
  task_type: string;
  selected_provider: string;
  selected_model: string;
  selected_reasoning: string;
  input_tokens: number;
  reserved_output_tokens: number;
  estimated_cost_usd: number;
  risk: string;
  warnings_json: string;
  budget_scope: string;
  task_json: string;
};

type QueuePreflightRow = {
  decision: string;
  risk: string;
  estimated_cost_usd: number;
};

type QueueWorkerCostAttribution = {
  role: string;
  costUsd: number;
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
};

type QueueWorkerEventRow = WorkerEventRow & {
  queue_task_id: string;
  queue_task_title: string;
  queue_task_status: string;
  worker: string | null;
  worker_status: string | null;
};

type BlockedEntry = {
  task: ProjectQueueTaskRow;
  reasons: string[];
  blockers?: Array<Record<string, unknown>>;
};

type WorkerCheckpointRow = {
  id: string;
  task_id: string;
  worker_run_id: string;
  ts: string;
  summary_json: string;
};

type StaleWorkerRow = ProjectQueueTaskRow & {
  worker_run_id: string | null;
  worker_status: string | null;
  worker_ts_started: string | null;
  worker_ts_updated: string | null;
  worker_max_runtime_minutes: number | null;
  stale_reason: string;
};

type QueueCleanupCandidate = {
  queue: ProjectQueueRow;
  counts: QueueCleanupCounts;
};

type QueueCleanupCounts = {
  queueRows: number;
  queueTasks: number;
  stages: number;
  decisions: number;
  toolContextProposals: number;
  linkedFabricTasks: number;
  workerRuns: number;
  workerEvents: number;
  workerCheckpoints: number;
};

type MissingGrant = {
  kind: string;
  grantKey: string;
  value: unknown;
  policyStatus?: string;
};

const PIPELINE_PROFILES = new Set(["fast", "balanced", "careful", "custom"]);
const QUEUE_STATUSES = new Set(["created", "prompt_review", "planning", "plan_review", "queue_review", "running", "paused", "completed", "canceled"]);
const STAGES = new Set(["prompt_improvement", "planning", "phasing", "task_writing", "queue_shaping", "tool_context", "execution", "review", "decision"]);
const STAGE_STATUSES = new Set(["pending", "running", "completed", "needs_review", "accepted", "rejected", "failed", "skipped"]);
const TASK_STATUSES = new Set(["queued", "ready", "running", "blocked", "review", "patch_ready", "completed", "failed", "canceled", "accepted", "done"]);
const TASK_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const WORKER_PRIORITIES = new Set(["low", "normal", "high"]);
const WORKERS = new Set(["ramicode", "local-cli", "openhands", "aider", "smolagents", "codex-app-server", "deepseek-direct", "jcode-deepseek", "manual"]);
const WORKSPACE_MODES = new Set(["in_place", "git_worktree", "clone", "sandbox"]);
const PACKET_FORMATS = new Set(["json", "markdown"]);
const RISKS = new Set(["low", "medium", "high", "breakglass"]);
const TOOL_DECISIONS = new Set(["approve", "reject", "revise"]);
const GRANT_KINDS = new Set(["mcp_server", "tool", "memory", "context"]);
const POLICY_STATUSES = new Set(["approved", "rejected"]);
const RECOVERY_ACTIONS = new Set(["requeue", "fail"]);
const CLEANUP_QUEUE_STATUSES = new Set(["completed", "canceled"]);
const CLEANUP_BLOCKING_TASK_STATUSES = new Set(["queued", "ready", "running", "blocked", "review", "patch_ready", "failed"]);
const QUEUE_DECISIONS = new Set([
  "accept_improved_prompt",
  "request_prompt_revision",
  "accept_plan",
  "request_plan_revision",
  "approve_queue",
  "start_execution",
  "pause",
  "resume",
  "cancel",
  "complete"
]);
const DEPENDENCY_DONE = new Set(["completed", "done", "accepted"]);
const ACTIVE_WORKER_STATUSES = new Set(["running"]);
const CLOSED_LANE_TASK_STATUSES = new Set(["completed", "accepted", "done", "canceled"]);
const CLOSED_LANE_WORKER_STATUSES = new Set(["completed"]);
const EXECUTION_BLOCKED_QUEUE_STATUSES = new Set(["paused", "canceled", "completed"]);
const WORKER_START_OPEN_QUEUE_STATUSES = new Set(["running"]);
const RETRYABLE_TASK_STATUSES = new Set(["blocked", "review", "patch_ready", "failed", "canceled"]);
const TASK_METADATA_EDITABLE_STATUSES = new Set(["queued", "ready", "blocked", "review", "patch_ready", "failed", "canceled"]);

export function projectQueueCreate(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const projectPath = getString(input, "projectPath");
  const promptSummary = promptSummaryFromInput(input);
  const title = getOptionalString(input, "title") ?? defaultQueueTitle(projectPath);
  const pipelineProfile = normalizeValue(getOptionalString(input, "pipelineProfile") ?? "balanced", PIPELINE_PROFILES, "pipelineProfile");
  const maxParallelAgents = normalizeMaxParallelAgents(getOptionalNumber(input, "maxParallelAgents") ?? 4);
  const planChainId = getOptionalString(input, "planChainId") ?? null;

  return host.recordMutation("project_queue_create", input, context, (session) => {
    const queueId = newId("pqueue");
    host.db.db
      .prepare(
        `INSERT INTO project_queues (
          id, workspace_root, project_path, title, prompt_summary, pipeline_profile,
          max_parallel_agents, status, plan_chain_id, created_by_session_id,
          created_by_agent_id, origin_peer_id, test_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?)`
      )
      .run(
        queueId,
        session.workspace_root,
        projectPath,
        title,
        promptSummary,
        pipelineProfile,
        maxParallelAgents,
        planChainId,
        session.id,
        session.agent_id,
        host.originPeerId,
        session.test_mode
      );
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "project.queue.created",
      sourceTable: "project_queues",
      sourceId: queueId,
      eventType: "project.queue.created",
      payload: { queueId, projectPath, title, pipelineProfile, maxParallelAgents, rawPromptStored: false },
      testMode: session.test_mode === 1,
      context
    });
    return { queueId, status: "created", projectPath, title, pipelineProfile, maxParallelAgents, rawPromptStored: false };
  });
}

export function projectQueueList(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const projectPath = getOptionalString(input, "projectPath");
  const statuses = getStringArray(input, "statuses").map((status) => normalizeValue(status, QUEUE_STATUSES, "statuses"));
  const includeClosed = getOptionalBoolean(input, "includeClosed") ?? false;
  const limit = normalizeListLimit(getOptionalNumber(input, "limit") ?? 50);
  const params: Array<string | number> = [session.workspace_root, session.workspace_root];
  const where = ["(workspace_root = ? OR project_path = ?)"];

  if (projectPath) {
    where.push("project_path = ?");
    params.push(projectPath);
  }
  if (statuses.length > 0) {
    where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  } else if (!includeClosed) {
    where.push("status NOT IN ('completed', 'canceled')");
  }
  params.push(limit);

  const queues = host.db.db
    .prepare(`SELECT * FROM project_queues WHERE ${where.join(" AND ")} ORDER BY ts_updated DESC LIMIT ?`)
    .all(...params) as ProjectQueueRow[];

  return {
    workspaceRoot: session.workspace_root,
    projectPath: projectPath ?? undefined,
    count: queues.length,
    queues: queues.map((queue) => queueListItem(host, queue))
  };
}

export function projectQueueCleanup(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const queueId = getOptionalString(input, "queueId");
  const projectPath = getOptionalString(input, "projectPath");
  const rawStatuses = getStringArray(input, "statuses");
  const statuses = rawStatuses.length > 0 ? rawStatuses.map((status) => normalizeValue(status, CLEANUP_QUEUE_STATUSES, "statuses")) : ["completed", "canceled"];
  const olderThanDays = normalizeNonNegativeInteger(getOptionalNumber(input, "olderThanDays") ?? 7, "olderThanDays");
  const limit = normalizeListLimit(getOptionalNumber(input, "limit") ?? 50);
  const dryRun = getOptionalBoolean(input, "dryRun") ?? true;
  const deleteLinkedTaskHistory = getOptionalBoolean(input, "deleteLinkedTaskHistory") ?? false;
  const cutoff = new Date(host.now().getTime() - olderThanDays * 24 * 60 * 60 * 1000);
  const scope = { queueId: queueId ?? undefined, projectPath: projectPath ?? undefined, statuses, olderThanDays, cutoff: cutoff.toISOString(), limit };
  const evaluated = queueCleanupCandidates(host, session.workspace_root, {
    queueId,
    projectPath,
    statuses,
    cutoff,
    limit,
    deleteLinkedTaskHistory
  });

  if (dryRun) {
    return {
      dryRun: true,
      deleteLinkedTaskHistory,
      scope,
      candidateCount: evaluated.candidates.length,
      protectedCount: evaluated.protected.length,
      totals: sumCleanupCounts(evaluated.candidates.map((candidate) => candidate.counts), deleteLinkedTaskHistory),
      candidates: evaluated.candidates.map((candidate) => formatCleanupCandidate(candidate, deleteLinkedTaskHistory)),
      protected: evaluated.protected
    };
  }

  return host.recordMutation("project_queue_cleanup", input, context, (mutationSession) => {
    const latest = queueCleanupCandidates(host, mutationSession.workspace_root, {
      queueId,
      projectPath,
      statuses,
      cutoff,
      limit,
      deleteLinkedTaskHistory
    });
    const cleaned: Array<Record<string, unknown>> = [];
    const cleanedQueueIds: string[] = [];
    for (const candidate of latest.candidates) {
      const linkedTaskIds = linkedFabricTaskIds(host, candidate.queue.id);
      if (deleteLinkedTaskHistory) {
        deleteLinkedTaskRows(host, linkedTaskIds);
      }
      host.db.db.prepare("DELETE FROM project_queues WHERE id = ?").run(candidate.queue.id);
      cleanedQueueIds.push(candidate.queue.id);
      cleaned.push(formatCleanupCandidate(candidate, deleteLinkedTaskHistory));
    }
    const totals = sumCleanupCounts(latest.candidates.map((candidate) => candidate.counts), deleteLinkedTaskHistory);
    host.writeAuditAndEvent({
      sessionId: mutationSession.id,
      agentId: mutationSession.agent_id,
      hostName: mutationSession.host_name,
      workspaceRoot: mutationSession.workspace_root,
      action: "project.queue.cleanup",
      sourceTable: "project_queues",
      sourceId: queueId ?? "cleanup_batch",
      eventType: "project.queue.cleanup",
      payload: {
        dryRun: false,
        deleteLinkedTaskHistory,
        scope,
        cleanedQueueIds,
        protected: latest.protected,
        totals
      },
      testMode: mutationSession.test_mode === 1,
      context
    });
    return {
      dryRun: false,
      deleteLinkedTaskHistory,
      scope,
      cleanedCount: cleaned.length,
      protectedCount: latest.protected.length,
      totals,
      cleaned,
      protected: latest.protected
    };
  });
}

export function projectQueueStatus(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const queue = requireQueue(host, getString(input, "queueId"), session.workspace_root);
  const tasks = taskRows(host, queue.id);
  const stages = host.db.db
    .prepare("SELECT * FROM project_queue_stages WHERE queue_id = ? ORDER BY ts_created ASC")
    .all(queue.id) as ProjectQueueStageRow[];
  const decisions = host.db.db
    .prepare("SELECT * FROM project_queue_decisions WHERE queue_id = ? ORDER BY ts_created ASC")
    .all(queue.id) as ProjectQueueDecisionRow[];
  const proposals = host.db.db
    .prepare("SELECT * FROM tool_context_proposals WHERE queue_id = ? ORDER BY ts_created ASC")
    .all(queue.id) as ToolContextProposalRow[];
  const policies = host.db.db
    .prepare("SELECT * FROM tool_context_policies WHERE workspace_root = ? AND project_path = ? ORDER BY ts_decided ASC")
    .all(session.workspace_root, queue.project_path) as ToolContextPolicyRow[];

  return {
    queue: formatQueue(queue),
    counts: statusCounts(tasks),
    stages: stages.map(formatStage),
    tasks: tasks.map(formatQueueTask),
    decisions: decisions.map(formatDecision),
    toolContextProposals: proposals.map(formatProposal),
    toolContextPolicies: policies.map(formatPolicy)
  };
}

export function projectQueueUpdateSettings(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const queueId = getString(input, "queueId");
  const title = getOptionalString(input, "title");
  const pipelineProfile = optionalNormalized(input, "pipelineProfile", PIPELINE_PROFILES);
  const maxParallelAgentsInput = getOptionalNumber(input, "maxParallelAgents");
  const maxParallelAgents = maxParallelAgentsInput === undefined ? undefined : normalizeMaxParallelAgents(maxParallelAgentsInput);
  const note = getOptionalString(input, "note") ?? null;
  if (title === undefined && pipelineProfile === undefined && maxParallelAgents === undefined) {
    throw new FabricError("INVALID_INPUT", "Expected at least one setting: title, pipelineProfile, or maxParallelAgents", false);
  }
  if (title !== undefined && title.trim().length === 0) {
    throw new FabricError("INVALID_INPUT", "title must not be empty", false);
  }

  return host.recordMutation("project_queue_update_settings", input, context, (session) => {
    const queue = requireQueue(host, queueId, session.workspace_root);
    host.db.db
      .prepare(
        `UPDATE project_queues
         SET title = ?, pipeline_profile = ?, max_parallel_agents = ?, ts_updated = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(title?.trim() ?? queue.title, pipelineProfile ?? queue.pipeline_profile, maxParallelAgents ?? queue.max_parallel_agents, queue.id);
    const updated = requireQueue(host, queue.id, session.workspace_root);
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "project.queue.settings.updated",
      sourceTable: "project_queues",
      sourceId: queue.id,
      eventType: "project.queue.settings.updated",
      payload: {
        queueId: queue.id,
        previous: {
          title: queue.title,
          pipelineProfile: queue.pipeline_profile,
          maxParallelAgents: queue.max_parallel_agents
        },
        updated: {
          title: updated.title,
          pipelineProfile: updated.pipeline_profile,
          maxParallelAgents: updated.max_parallel_agents
        },
        note: note ?? undefined
      },
      testMode: session.test_mode === 1,
      context
    });
    return { queue: formatQueue(updated) };
  });
}

export function projectQueueDashboard(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const queue = requireQueue(host, getString(input, "queueId"), session.workspace_root);
  const includeCompletedLanes = getOptionalBoolean(input, "includeCompletedLanes") ?? false;
  const maxEventsPerLane = normalizeEventLimit(getOptionalNumber(input, "maxEventsPerLane") ?? defaultMaxEventsPerLane());
  const tasks = taskRows(host, queue.id);
  const stages = host.db.db
    .prepare("SELECT * FROM project_queue_stages WHERE queue_id = ? ORDER BY ts_created ASC")
    .all(queue.id) as ProjectQueueStageRow[];
  const policies = host.db.db
    .prepare("SELECT * FROM tool_context_policies WHERE workspace_root = ? AND project_path = ? ORDER BY ts_decided ASC")
    .all(session.workspace_root, queue.project_path) as ToolContextPolicyRow[];
  const pendingApprovals = host.db.db
    .prepare(
      `SELECT p.*, t.title AS queue_task_title, t.status AS queue_task_status
       FROM tool_context_proposals p
       LEFT JOIN project_queue_tasks t ON t.id = p.queue_task_id
       WHERE p.queue_id = ? AND p.status = 'proposed' AND p.approval_required = 1
       ORDER BY p.ts_created ASC`
    )
    .all(queue.id) as Array<
    ToolContextProposalRow & {
      queue_task_title: string | null;
      queue_task_status: string | null;
    }
  >;
  const activeWorkers = tasks.filter((task) => ACTIVE_WORKER_STATUSES.has(task.status)).length;
  const nowIso = host.now().toISOString();
  const modelApprovals = pendingModelApprovalRows(host, queue.id, session.workspace_root, false, 50, nowIso);
  const preflights = queuePreflightRows(host, queue.id, session.workspace_root);
  const workerCosts = queueWorkerCostAttributions(host, queue.id);
  const analyzed = analyzeReadiness(tasks);
  const executionBlock = queueExecutionBlockReason(queue.status);
  const scheduled = executionBlock
    ? { ready: [], blocked: [] }
    : selectSchedulableReadyTasks(analyzed.ready.sort(compareReadyTasks), tasks, Math.max(0, queue.max_parallel_agents - activeWorkers));
  const blockedEntries = executionBlock ? queueBlockedEntries(tasks, executionBlock) : [...analyzed.blocked, ...scheduled.blocked];
  const staleRunning = staleWorkerRows(host, queue.id, new Date(host.now().getTime() - 30 * 60_000).toISOString(), host.now().getTime());
  const counts = statusCounts(tasks);
  const lanes = projectQueueAgentLanes(
    host,
    { queueId: queue.id, includeCompleted: includeCompletedLanes, maxEventsPerLane },
    context
  ) as { count: number; lanes: unknown[] };

  return {
    queue: formatQueue(queue),
    counts,
    summaryStrip: queueSummaryStrip({
      queue,
      tasks,
      counts,
      activeWorkers,
      availableSlots: Math.max(0, queue.max_parallel_agents - activeWorkers),
      readyCount: scheduled.ready.length,
      blockedCount: blockedEntries.length,
      pendingToolApprovals: pendingApprovals.length,
      pendingModelApprovals: modelApprovals.length,
      staleRunningCount: staleRunning.length,
      preflights,
      workerCosts
    }),
    activeWorkers,
    availableSlots: Math.max(0, queue.max_parallel_agents - activeWorkers),
    pipeline: stages.map(formatStage),
    queueBoard: {
      ready: scheduled.ready.map(formatQueueTask),
      running: tasks.filter((task) => task.status === "running").map(formatQueueTask),
      review: tasks.filter((task) => task.status === "review" || task.status === "patch_ready").map(formatQueueTask),
      blocked: blockedEntries.map(formatBlockedEntry),
      done: tasks.filter((task) => DEPENDENCY_DONE.has(task.status)).map(formatQueueTask),
      failed: tasks.filter((task) => task.status === "failed" || task.status === "canceled").map(formatQueueTask)
    },
    pendingApprovals: pendingApprovals.map((row) => ({
      ...formatProposal(row),
      queueTaskTitle: row.queue_task_title ?? undefined,
      queueTaskStatus: row.queue_task_status ?? undefined
    })),
    modelApprovals: modelApprovals.map((row) => formatModelApproval(row, nowIso)),
    toolContextPolicies: policies.map(formatPolicy),
    memorySuggestions: queueMemorySuggestions(host, session.workspace_root, scheduled.ready, 2, 8),
    agentLanes: lanes.lanes,
    agentLaneCount: lanes.count
  };
}

export function projectQueueReviewMatrix(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const queue = requireQueue(host, getString(input, "queueId"), session.workspace_root);
  const requestedLimit = getOptionalNumber(input, "limit");
  const tasks = taskRows(host, queue.id);
  const activeWorkers = tasks.filter((task) => ACTIVE_WORKER_STATUSES.has(task.status)).length;
  const slots = Math.max(0, queue.max_parallel_agents - activeWorkers);
  const executionBlock = queueExecutionBlockReason(queue.status);
  const workerStartBlock = queueWorkerStartBlockReason(queue.status);
  const analyzed = analyzeReadiness(tasks);
  const limit = executionBlock ? 0 : Math.max(0, Math.min(normalizePositiveLimit(requestedLimit ?? queue.max_parallel_agents), slots));
  const scheduled = executionBlock
    ? { ready: [], blocked: [] }
    : selectSchedulableReadyTasks(analyzed.ready.sort(compareReadyTasks), tasks, limit);
  const launchEntries = scheduled.ready.map((task) => launchPlanEntry(host, queue, task, session.workspace_root, workerStartBlock));
  const pendingToolApprovals = pendingToolContextProposalRows(host, queue.id, 100);
  const toolContextTasks = tasks.map((task) => taskToolContextMatrixEntry(host, queue, task));
  const requiredGrantRefs = toolContextTasks.reduce((sum, entry) => sum + Number(entry.requiredGrantCount), 0);
  const openTasks = tasks.filter(isOpenQueueTask);
  const dependencyEdges = dependencyEdgesForTasks(tasks);
  const dependentCounts = dependentCountByTask(tasks);
  const fileScopes = fileScopeMatrix(tasks);

  return {
    queue: formatQueue(queue),
    counts: statusCounts(tasks),
    summary: {
      totalTasks: tasks.length,
      openTasks: openTasks.length,
      readyDependencyFree: analyzed.ready.length,
      blockedByDependencies: analyzed.blocked.length,
      schedulerBlocked: scheduled.blocked.length,
      scheduledPreview: launchEntries.length,
      launchable: launchEntries.filter((entry) => Boolean(entry.readyToLaunch)).length,
      waitingForStart: launchEntries.filter((entry) => Boolean(entry.workerStartBlocked)).length,
      approvalRequired: launchEntries.filter((entry) => Boolean(entry.approvalRequired)).length,
      pendingToolContextApprovals: pendingToolApprovals.length,
      tasksRequiringContext: toolContextTasks.filter((entry) => !entry.noContextRequired).length,
      tasksNeedingToolContextApproval: toolContextTasks.filter((entry) => entry.approvalRequired).length,
      tasksNeedingToolContextProposal: toolContextTasks.filter((entry) => entry.needsProposal).length,
      tasksWithApprovedToolContextProposal: toolContextTasks.filter((entry) => entry.proposalStatus === "approved").length,
      uniqueRequiredGrants: toolContextGrantMatrix(host, queue, tasks).length,
      requiredGrantRefs,
      fileScopes: fileScopes.length,
      overlappingFileScopes: fileScopes.filter((scope) => Boolean(scope.overlap)).length,
      dependencyEdges: dependencyEdges.length,
      rootTasks: tasks.filter((task) => safeJsonArray(task.depends_on_json).length === 0).length,
      leafTasks: tasks.filter((task) => (dependentCounts.get(task.id) ?? 0) === 0).length
    },
    buckets: {
	      status: groupTasks(tasks, (task) => task.status),
	      phase: groupTasks(tasks, (task) => task.phase ?? "unphased"),
	      manager: groupTasks(tasks, (task) => task.manager_id ?? "unmanaged"),
	      workstream: groupTasks(tasks, (task) => task.workstream ?? task.parallel_group ?? task.phase ?? "unassigned"),
	      category: groupTasks(tasks, (task) => task.category),
      risk: groupTasks(tasks, (task) => task.risk),
      priority: groupTasks(tasks, (task) => task.priority),
      parallelGroup: groupTasks(tasks, (task) => task.parallel_group ?? "ungrouped")
    },
    dependencies: {
      edgeCount: dependencyEdges.length,
      edges: dependencyEdges,
      rootTasks: tasks.filter((task) => safeJsonArray(task.depends_on_json).length === 0).map(formatQueueTaskLink),
      leafTasks: tasks.filter((task) => (dependentCounts.get(task.id) ?? 0) === 0).map(formatQueueTaskLink),
      blockedTasks: analyzed.blocked.map(formatBlockedEntry)
    },
    parallelism: {
      activeWorkers,
      availableSlots: slots,
      maxParallelAgents: queue.max_parallel_agents,
      workerStartBlocked: Boolean(workerStartBlock),
      workerStartBlockedReason: workerStartBlock,
      serialTasks: tasks.filter((task) => task.parallel_safe === 0).map(formatQueueTaskLink),
      parallelSafeTasks: tasks.filter((task) => task.parallel_safe === 1).map(formatQueueTaskLink),
      scheduledPreview: {
        launchable: launchEntries.filter((entry) => Boolean(entry.readyToLaunch)),
        waitingForStart: launchEntries.filter((entry) => Boolean(entry.workerStartBlocked)),
        approvalRequired: launchEntries.filter((entry) => Boolean(entry.approvalRequired)),
        blocked: [...analyzed.blocked, ...scheduled.blocked].map(formatBlockedEntry)
      }
    },
    fileScopes,
    toolContext: {
      grants: toolContextGrantMatrix(host, queue, tasks),
      tasks: toolContextTasks,
      pendingApprovals: pendingToolApprovals.map((row) => ({
        ...formatProposal(row),
        queueTaskTitle: row.queue_task_title ?? undefined,
        queueTaskStatus: row.queue_task_status ?? undefined
      }))
    },
    tasks: tasks.map((task) => ({
      task: formatQueueTask(task),
      readiness: queueTaskReadiness(queue, task, tasks),
      dependencyCount: safeJsonArray(task.depends_on_json).length,
      dependentCount: dependentCounts.get(task.id) ?? 0,
      expectedFileCount: safeJsonArray(task.expected_files_json).length,
      requiredGrantCount: requiredGrantsForTask(task).length
    })),
    executionBlocked: Boolean(executionBlock),
    blockedReason: executionBlock
  };
}

export function projectQueueTaskDetail(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const queue = requireQueue(host, getString(input, "queueId"), session.workspace_root);
  const task = requireQueueTask(host, queue.id, getString(input, "queueTaskId"));
  const includeResume = getOptionalBoolean(input, "includeResume") ?? false;
  const preferredWorker = optionalNormalized(input, "preferredWorker", WORKERS);
  const maxEventsPerRun = normalizeEventLimit(getOptionalNumber(input, "maxEventsPerRun") ?? 10);
  const maxModelApprovals = normalizeListLimit(getOptionalNumber(input, "maxModelApprovals") ?? 25);
  const tasks = taskRows(host, queue.id);
  const byId = new Map(tasks.map((entry) => [entry.id, entry]));
  const nowIso = host.now().toISOString();
  const runs = task.fabric_task_id ? workerRunRowsForFabricTask(host, task.fabric_task_id) : [];
  const resume =
    includeResume && task.fabric_task_id
      ? fabricTaskResume(
          host,
          {
            taskId: task.fabric_task_id,
            preferredWorker
          },
          context
        )
      : undefined;
  const resumePacket = resume ? buildQueueResumePacket(queue, task, resume) : undefined;

  return {
    queue: formatQueue(queue),
    task: formatQueueTask(task),
    graph: {
      dependencies: dependencyLinks(task, byId),
      dependents: dependentLinks(task, tasks)
    },
    readiness: queueTaskReadiness(queue, task, tasks),
    workerRuns: runs.map((run) => formatTaskWorkerRunDetail(host, task, run, maxEventsPerRun)),
    toolContextProposals: toolContextProposalRowsForTask(host, queue.id, task).map(formatProposal),
    modelApprovals: taskModelApprovalRows(host, queue, task, session.workspace_root, maxModelApprovals).map((row) => formatModelApproval(row, nowIso)),
    memorySuggestions: taskMemorySuggestions(host, session.workspace_root, task, 5),
    resume: resume
      ? {
          fabricResume: resume,
          taskPacket: resumePacket
        }
      : undefined
  };
}

export function projectQueueTimeline(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const queue = requireQueue(host, getString(input, "queueId"), session.workspace_root);
  const limit = normalizeListLimit(getOptionalNumber(input, "limit") ?? 100);
  const nowIso = host.now().toISOString();
  const stages = host.db.db
    .prepare("SELECT * FROM project_queue_stages WHERE queue_id = ? ORDER BY ts_created DESC LIMIT ?")
    .all(queue.id, limit) as ProjectQueueStageRow[];
  const decisions = host.db.db
    .prepare("SELECT * FROM project_queue_decisions WHERE queue_id = ? ORDER BY ts_created DESC LIMIT ?")
    .all(queue.id, limit) as ProjectQueueDecisionRow[];
  const proposals = host.db.db
    .prepare(
      `SELECT p.*, t.title AS queue_task_title, t.status AS queue_task_status
       FROM tool_context_proposals p
       LEFT JOIN project_queue_tasks t ON t.id = p.queue_task_id
       WHERE p.queue_id = ?
       ORDER BY p.ts_updated DESC
       LIMIT ?`
    )
    .all(queue.id, limit) as Array<
    ToolContextProposalRow & {
      queue_task_title: string | null;
      queue_task_status: string | null;
    }
  >;
  const modelApprovals = modelApprovalRows(host, queue.id, session.workspace_root, limit);
  const workerEvents = queueWorkerEventRows(host, queue.id, limit);
  const items = [
    ...stages.map(stageTimelineItem),
    ...decisions.map(decisionTimelineItem),
    ...proposals.map(proposalTimelineItem),
    ...modelApprovals.map((row) => modelApprovalTimelineItem(row, nowIso)),
    ...workerEvents.map(workerEventTimelineItem)
  ]
    .sort(compareTimelineItems)
    .slice(0, limit);

  return {
    queue: formatQueue(queue),
    count: items.length,
    items
  };
}

export function projectQueueApprovalInbox(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const queue = requireQueue(host, getString(input, "queueId"), session.workspace_root);
  const includeExpired = getOptionalBoolean(input, "includeExpired") ?? false;
  const limit = normalizeListLimit(getOptionalNumber(input, "limit") ?? 50);
  const nowIso = host.now().toISOString();
  const toolRows = host.db.db
    .prepare(
      `SELECT p.*, t.title AS queue_task_title, t.status AS queue_task_status
       FROM tool_context_proposals p
       LEFT JOIN project_queue_tasks t ON t.id = p.queue_task_id
       WHERE p.queue_id = ? AND p.status = 'proposed' AND p.approval_required = 1
       ORDER BY p.ts_created ASC
       LIMIT ?`
    )
    .all(queue.id, limit) as Array<
    ToolContextProposalRow & {
      queue_task_title: string | null;
      queue_task_status: string | null;
    }
  >;
  const modelRows = pendingModelApprovalRows(host, queue.id, session.workspace_root, includeExpired, limit, nowIso);
  const toolContext = toolRows.map((row) => ({
    kind: "tool_context",
    ...formatProposal(row),
    queueTaskTitle: row.queue_task_title ?? undefined,
    queueTaskStatus: row.queue_task_status ?? undefined
  }));
  const modelCalls = modelRows.map((row) => ({
    kind: "model_call",
    ...formatModelApproval(row, nowIso)
  }));
  return {
    queue: formatQueue(queue),
    count: toolContext.length + modelCalls.length,
    toolContextCount: toolContext.length,
    modelCallCount: modelCalls.length,
    toolContext,
    modelCalls
  };
}

export function projectQueueResumeTask(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const queue = requireQueue(host, getString(input, "queueId"), session.workspace_root);
  const task = requireQueueTask(host, queue.id, getString(input, "queueTaskId"));
  const preferredWorker = getOptionalString(input, "preferredWorker");
  if (!task.fabric_task_id) {
    throw new FabricError("FABRIC_TASK_NOT_FOUND", `Queue task has no linked fabric task: ${task.id}`, false);
  }
  const resume = fabricTaskResume(
    host,
    {
      taskId: task.fabric_task_id,
      preferredWorker
    },
    context
  );
  const queueTask = formatQueueTask(task);
  const packet = buildQueueResumePacket(queue, task, resume);
  return {
    queue: formatQueue(queue),
    queueTask,
    fabricResume: resume,
    taskPacket: packet
  };
}

export function projectQueueTaskPacket(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const queue = requireQueue(host, getString(input, "queueId"), session.workspace_root);
  const task = requireQueueTask(host, queue.id, getString(input, "queueTaskId"));
  const format = normalizeValue(getOptionalString(input, "format") ?? "json", PACKET_FORMATS, "format");
  const includeResume = getOptionalBoolean(input, "includeResume") ?? false;
  const preferredWorker = optionalNormalized(input, "preferredWorker", WORKERS) ?? "ramicode";
  const workspaceMode = optionalNormalized(input, "workspaceMode", WORKSPACE_MODES) ?? "git_worktree";
  const workspacePath = getOptionalString(input, "workspacePath");
  const modelProfile = getOptionalString(input, "modelProfile") ?? "execute.cheap";
  const packetPath = getOptionalString(input, "packetPath") ?? defaultTaskPacketPath(queue, task, format);
  const resume =
    includeResume && task.fabric_task_id
      ? fabricTaskResume(
          host,
          {
            taskId: task.fabric_task_id,
            preferredWorker
          },
          context
        )
      : undefined;
  const packet = resume ? buildQueueResumePacket(queue, task, resume) : buildQueueTaskPacket(queue, task);
  const markdown = resume ? formatQueueResumePacketMarkdown(packet) : formatQueueTaskPacketMarkdown(packet);
  const handoff = buildQueueWorkerHandoff(queue, task, {
    packetPath,
    format,
    worker: preferredWorker,
    workspaceMode,
    workspacePath,
    modelProfile,
    packetKind: resume ? "resume" : "task"
  });
  return {
    queue: formatQueue(queue),
    queueTask: formatQueueTask(task),
    packetKind: resume ? "resume" : "task",
    format,
    packet,
    handoff,
    markdown: format === "markdown" ? markdown : undefined,
    preview: markdown
  };
}

export function projectQueueRecordStage(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const queueId = getString(input, "queueId");
  const stage = normalizeValue(getString(input, "stage"), STAGES, "stage");
  const status = normalizeValue(getString(input, "status"), STAGE_STATUSES, "status");
  const modelAlias = getOptionalString(input, "modelAlias") ?? null;
  const inputSummary = getOptionalString(input, "inputSummary") ?? null;
  const outputSummary = getOptionalString(input, "outputSummary") ?? null;
  const planChainId = getOptionalString(input, "planChainId") ?? null;
  const artifacts = getArray(input, "artifacts");
  const warnings = getStringArray(input, "warnings");

  return host.recordMutation("project_queue_record_stage", input, context, (session) => {
    const queue = requireQueue(host, queueId, session.workspace_root);
    const stageId = newId("pqstage");
    host.db.db
      .prepare(
        `INSERT INTO project_queue_stages (
          id, queue_id, stage, status, model_alias, input_summary, output_summary,
          artifacts_json, warnings_json, session_id, agent_id, origin_peer_id, test_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        stageId,
        queue.id,
        stage,
        status,
        modelAlias,
        inputSummary,
        outputSummary,
        JSON.stringify(artifacts),
        JSON.stringify(warnings),
        session.id,
        session.agent_id,
        host.originPeerId,
        session.test_mode
      );
    host.db.db
      .prepare("UPDATE project_queues SET status = ?, plan_chain_id = COALESCE(?, plan_chain_id), ts_updated = CURRENT_TIMESTAMP WHERE id = ?")
      .run(queueStatusForStage(stage, status, queue.status), planChainId, queue.id);
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "project.queue.stage.recorded",
      sourceTable: "project_queue_stages",
      sourceId: stageId,
      eventType: "project.queue.stage.recorded",
      payload: { queueId: queue.id, stage, status, modelAlias, planChainId, warnings },
      testMode: session.test_mode === 1,
      context
    });
    return { stageId, queueId: queue.id, stage, status };
  });
}

export function projectQueueAddTasks(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const queueId = getString(input, "queueId");
  const rawTasks = getArray(input, "tasks");
  if (rawTasks.length === 0) {
    throw new FabricError("INVALID_INPUT", "tasks must contain at least one task", false);
  }

  return host.recordMutation("project_queue_add_tasks", input, context, (session) => {
    const queue = requireQueue(host, queueId, session.workspace_root);
    const existingTasks = taskRows(host, queue.id);
    const existingTaskIds = new Set(existingTasks.map((task) => task.id));
    const existingByClientKey = new Map(
      existingTasks.filter((task) => task.client_key).map((task) => [task.client_key as string, task])
    );
    const prepared = rawTasks.map((item) => prepareTask(item));
    const clientKeyToId = new Map<string, string>();
    const taskIdsToCreate = new Set<string>();
    for (const task of prepared) {
      if (task.clientKey) {
        const existing = existingByClientKey.get(task.clientKey);
        if (existing) {
          task.queueTaskId = existing.id;
          clientKeyToId.set(task.clientKey, task.queueTaskId);
          continue;
        }
        const previousPreparedId = clientKeyToId.get(task.clientKey);
        if (previousPreparedId) {
          task.queueTaskId = previousPreparedId;
          continue;
        }
      }
      task.queueTaskId = newId("pqtask");
      if (task.clientKey) clientKeyToId.set(task.clientKey, task.queueTaskId);
      taskIdsToCreate.add(task.queueTaskId);
    }
    const allTaskIds = new Set([...existingTaskIds, ...prepared.map((task) => task.queueTaskId)]);
    for (const task of prepared) {
      task.dependsOn = task.dependsOn.map((dependency) => clientKeyToId.get(dependency) ?? dependency);
      for (const dependency of task.dependsOn) {
        if (!allTaskIds.has(dependency)) {
          throw new FabricError("PROJECT_QUEUE_DEPENDENCY_NOT_FOUND", `Dependency not found in queue ${queue.id}: ${dependency}`, false);
        }
      }
    }

    const created: ProjectQueueTaskAddResult[] = [];
    const reused: ProjectQueueTaskAddResult[] = [];
    const createdByQueueTaskId = new Map<string, ProjectQueueTaskAddResult>();
    for (const task of prepared) {
      if (!taskIdsToCreate.has(task.queueTaskId)) {
        const existing = task.clientKey ? existingByClientKey.get(task.clientKey) : undefined;
        if (existing) {
          reused.push({
            queueTaskId: existing.id,
            fabricTaskId: existing.fabric_task_id ?? undefined,
            clientKey: task.clientKey,
            title: existing.title,
            status: existing.status,
            phase: existing.phase ?? undefined,
            managerId: existing.manager_id ?? undefined,
            workstream: existing.workstream ?? undefined,
            dependsOn: safeJsonArray(existing.depends_on_json),
            reused: true
          });
        }
        continue;
      }
      const alreadyCreated = createdByQueueTaskId.get(task.queueTaskId);
      if (alreadyCreated) {
        reused.push({ ...alreadyCreated, reused: true });
        continue;
      }

      const fabricTaskId = newId("task");
      const correlationId = context.correlationId ?? newId("corr");
      const refs = [`project_queue:${queue.id}`, `project_queue_task:${task.queueTaskId}`];
      host.db.db
        .prepare(
          `INSERT INTO tasks (
            id, requester_agent_id, assignee, kind, status, correlation_id,
            refs_json, artifacts_json, workspace_root, title, goal, project_path,
            priority, requested_by
          ) VALUES (?, ?, 'unassigned', 'worker_task', 'created', ?, ?, '[]', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          fabricTaskId,
          session.agent_id,
          correlationId,
          JSON.stringify(refs),
          session.workspace_root,
          task.title,
          task.goal,
          queue.project_path,
          toWorkerPriority(task.priority),
          "project_queue"
        );
      host.db.db
        .prepare(
          `INSERT INTO project_queue_tasks (
            id, queue_id, fabric_task_id, client_key, title, goal, phase, manager_id,
            parent_manager_id, parent_queue_id, workstream, cost_center,
            escalation_target, category, status, priority, parallel_group,
            parallel_safe, risk, expected_files_json,
            acceptance_criteria_json, required_tools_json, required_mcp_servers_json,
            required_memories_json, required_context_refs_json, depends_on_json,
            session_id, agent_id, origin_peer_id, test_mode
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          task.queueTaskId,
          queue.id,
          fabricTaskId,
          task.clientKey ?? null,
          task.title,
          task.goal,
          task.phase,
          task.managerId,
          task.parentManagerId,
          task.parentQueueId,
          task.workstream,
          task.costCenter,
          task.escalationTarget,
          task.category,
          task.status,
          task.priority,
          task.parallelGroup,
          task.parallelSafe ? 1 : 0,
          task.risk,
          JSON.stringify(task.expectedFiles),
          JSON.stringify(task.acceptanceCriteria),
          JSON.stringify(task.requiredTools),
          JSON.stringify(task.requiredMcpServers),
          JSON.stringify(task.requiredMemories),
          JSON.stringify(task.requiredContextRefs),
          JSON.stringify(task.dependsOn),
          session.id,
          session.agent_id,
          host.originPeerId,
          session.test_mode
        );
      const createdTask = {
        queueTaskId: task.queueTaskId,
        fabricTaskId,
        clientKey: task.clientKey,
        title: task.title,
        status: task.status,
        phase: task.phase ?? undefined,
        managerId: task.managerId ?? undefined,
        workstream: task.workstream ?? undefined,
        dependsOn: task.dependsOn
      };
      created.push(createdTask);
      createdByQueueTaskId.set(task.queueTaskId, createdTask);
    }
    host.db.db.prepare("UPDATE project_queues SET status = 'queue_review', ts_updated = CURRENT_TIMESTAMP WHERE id = ?").run(queue.id);
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "project.queue.tasks.added",
      sourceTable: "project_queue_tasks",
      sourceId: queue.id,
      eventType: "project.queue.tasks.added",
      payload: { queueId: queue.id, count: created.length, reused: reused.length, taskIds: created.map((task) => task.queueTaskId) },
      testMode: session.test_mode === 1,
      context
    });
    return { queueId: queue.id, created, reused };
  });
}

export function projectQueueNextReady(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const queue = requireQueue(host, getString(input, "queueId"), session.workspace_root);
  const requestedLimit = getOptionalNumber(input, "limit");
  const tasks = taskRows(host, queue.id);
  const active = tasks.filter((task) => ACTIVE_WORKER_STATUSES.has(task.status)).length;
  const slots = Math.max(0, queue.max_parallel_agents - active);
  const executionBlock = queueExecutionBlockReason(queue.status);
  const workerStartBlock = queueWorkerStartBlockReason(queue.status);
  if (executionBlock) {
    return {
      queueId: queue.id,
      maxParallelAgents: queue.max_parallel_agents,
      activeWorkers: active,
      availableSlots: slots,
      executionBlocked: true,
      blockedReason: executionBlock,
      workerStartBlocked: true,
      workerStartBlockedReason: workerStartBlock ?? executionBlock,
      ready: [],
      blocked: queueBlockedEntries(tasks, executionBlock).map(formatBlockedEntry)
    };
  }
  const limit = Math.max(0, Math.min(normalizePositiveLimit(requestedLimit ?? queue.max_parallel_agents), slots));
  const analyzed = analyzeReadiness(tasks);
  const scheduled = selectSchedulableReadyTasks(analyzed.ready.sort(compareReadyTasks), tasks, limit);

  return {
    queueId: queue.id,
    maxParallelAgents: queue.max_parallel_agents,
    activeWorkers: active,
    availableSlots: slots,
    executionBlocked: false,
    workerStartBlocked: Boolean(workerStartBlock),
    workerStartBlockedReason: workerStartBlock,
    ready: scheduled.ready.map(formatQueueTask),
    blocked: [...analyzed.blocked, ...scheduled.blocked].map(formatBlockedEntry)
  };
}

export function projectQueuePrepareReady(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const queueId = getString(input, "queueId");
  const requestedLimit = getOptionalNumber(input, "limit");

  return host.recordMutation("project_queue_prepare_ready", input, context, (session) => {
    const queue = requireQueue(host, queueId, session.workspace_root);
    const tasks = taskRows(host, queue.id);
    const active = tasks.filter((task) => ACTIVE_WORKER_STATUSES.has(task.status)).length;
    const slots = Math.max(0, queue.max_parallel_agents - active);
    const executionBlock = queueExecutionBlockReason(queue.status);
    const workerStartBlock = queueWorkerStartBlockReason(queue.status);
    if (executionBlock) {
      return {
        queueId: queue.id,
        maxParallelAgents: queue.max_parallel_agents,
        activeWorkers: active,
        availableSlots: slots,
        executionBlocked: true,
        blockedReason: executionBlock,
        workerStartBlocked: true,
        workerStartBlockedReason: workerStartBlock ?? executionBlock,
        prepared: [],
        blocked: queueBlockedEntries(tasks, executionBlock).map(formatBlockedEntry),
        summary: { readyToClaim: 0, readyToLaunch: 0, approvalRequired: 0, noContextRequired: 0, waitingForStart: 0 }
      };
    }

    const limit = Math.max(0, Math.min(normalizePositiveLimit(requestedLimit ?? queue.max_parallel_agents), slots));
    const analyzed = analyzeReadiness(tasks);
    const scheduled = selectSchedulableReadyTasks(analyzed.ready.sort(compareReadyTasks), tasks, limit);
    const prepared = scheduled.ready.map((task) => {
      const proposal = ensureTaskToolContextProposal(host, queue, task, session, context, "project_queue_prepare_ready");
      const linkIssues = linkIssuesForTask(host, queue, task);
      const contextRefIssues = contextRefIssuesForTask(queue, task);
      const linkBlocked = linkIssues.some((issue) => issue.severity === "error");
      const contextBlocked = contextRefIssues.some((issue) => issue.severity === "error");
      const launchBlockedReason = proposal.approvalRequired
        ? "tool_context_approval_required"
        : linkBlocked
          ? "fabric_task_link_missing"
          : contextBlocked
            ? "context_ref_missing"
            : workerStartBlock;
      return {
        task: formatQueueTask(task),
        toolContextProposal: proposal.proposal ? formatProposal(proposal.proposal) : undefined,
        approvalRequired: proposal.approvalRequired,
        readyToClaim: !proposal.approvalRequired && !linkBlocked && !contextBlocked && !workerStartBlock,
        readyToLaunch: !proposal.approvalRequired && !linkBlocked && !contextBlocked && !workerStartBlock,
        launchBlockedReason,
        linkIssues,
        contextRefIssues,
        noContextRequired: !proposal.proposal,
        reusedProposal: proposal.reused,
        missingGrants: proposal.missingGrants,
        memorySuggestions: taskMemorySuggestions(host, session.workspace_root, task, 3)
      };
    });
    const summary = {
      readyToClaim: prepared.filter((entry) => entry.readyToClaim).length,
      readyToLaunch: prepared.filter((entry) => entry.readyToLaunch).length,
      approvalRequired: prepared.filter((entry) => entry.approvalRequired).length,
      noContextRequired: prepared.filter((entry) => entry.noContextRequired).length,
      waitingForStart: prepared.filter((entry) => !entry.approvalRequired && workerStartBlock).length
    };
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "project.queue.ready.prepared",
      sourceTable: "project_queues",
      sourceId: queue.id,
      eventType: "project.queue.ready.prepared",
      payload: {
        queueId: queue.id,
        limit,
        preparedTaskIds: prepared.map((entry) => String(entry.task.queueTaskId)),
        proposalIds: prepared
          .map((entry) => entry.toolContextProposal)
          .filter((proposal): proposal is Record<string, unknown> => Boolean(proposal))
          .map((proposal) => proposal.proposalId),
        summary
      },
      testMode: session.test_mode === 1,
      context
    });
    return {
      queueId: queue.id,
      maxParallelAgents: queue.max_parallel_agents,
      activeWorkers: active,
      availableSlots: slots,
      executionBlocked: false,
      workerStartBlocked: Boolean(workerStartBlock),
      workerStartBlockedReason: workerStartBlock,
      prepared,
      blocked: [...analyzed.blocked, ...scheduled.blocked].map(formatBlockedEntry),
      summary
    };
  });
}

export function projectQueueLaunchPlan(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const queue = requireQueue(host, getString(input, "queueId"), session.workspace_root);
  const requestedLimit = getOptionalNumber(input, "limit");
  const tasks = taskRows(host, queue.id);
  const active = tasks.filter((task) => ACTIVE_WORKER_STATUSES.has(task.status)).length;
  const slots = Math.max(0, queue.max_parallel_agents - active);
  const executionBlock = queueExecutionBlockReason(queue.status);
  const workerStartBlock = queueWorkerStartBlockReason(queue.status);
  if (executionBlock) {
    return {
      queue: formatQueue(queue),
      queueId: queue.id,
      maxParallelAgents: queue.max_parallel_agents,
      activeWorkers: active,
      availableSlots: slots,
      executionBlocked: true,
      blockedReason: executionBlock,
      workerStartBlocked: true,
      workerStartBlockedReason: workerStartBlock ?? executionBlock,
      launchable: [],
      waitingForStart: [],
      approvalRequired: [],
      blocked: queueBlockedEntries(tasks, executionBlock).map(formatBlockedEntry),
      summary: { scheduled: 0, launchable: 0, waitingForStart: 0, approvalRequired: 0, needsProposal: 0 }
    };
  }

  const limit = Math.max(0, Math.min(normalizePositiveLimit(requestedLimit ?? queue.max_parallel_agents), slots));
  const analyzed = analyzeReadiness(tasks);
  const scheduled = selectSchedulableReadyTasks(analyzed.ready.sort(compareReadyTasks), tasks, limit);
  const entries = scheduled.ready.map((task) => launchPlanEntry(host, queue, task, session.workspace_root, workerStartBlock));
  const launchable = entries.filter((entry) => entry.readyToLaunch);
  const waitingForStart = entries.filter((entry) => entry.workerStartBlocked);
  const approvalRequired = entries.filter((entry) => entry.approvalRequired);

  return {
    queue: formatQueue(queue),
    queueId: queue.id,
    maxParallelAgents: queue.max_parallel_agents,
    activeWorkers: active,
    availableSlots: slots,
    executionBlocked: false,
    workerStartBlocked: Boolean(workerStartBlock),
    workerStartBlockedReason: workerStartBlock,
    launchable,
    waitingForStart,
    approvalRequired,
    blocked: [...analyzed.blocked, ...scheduled.blocked].map(formatBlockedEntry),
    summary: {
      scheduled: entries.length,
      launchable: launchable.length,
      waitingForStart: waitingForStart.length,
      approvalRequired: approvalRequired.length,
      needsProposal: entries.filter((entry) => entry.needsProposal).length
    }
  };
}

export function projectQueueValidateLinks(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const queue = requireQueue(host, getString(input, "queueId"), session.workspace_root);
  const readyOnly = getOptionalBoolean(input, "readyOnly") ?? false;
  const tasks = taskRows(host, queue.id).filter((task) => !readyOnly || task.status === "queued" || task.status === "ready");
  const issues = linkIssuesForTasks(host, queue, tasks);
  return {
    schema: "agent-fabric.project-queue-link-validation.v1",
    queueId: queue.id,
    ok: issues.length === 0,
    checked: tasks.length,
    issues,
    summary: {
      missingFabricTaskId: issues.filter((issue) => issue.type === "missing_fabric_task_id").length,
      orphanedFabricTask: issues.filter((issue) => issue.type === "orphaned_fabric_task").length
    }
  };
}

export function projectQueueValidateContextRefs(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const queueId = getString(input, "queueId");
  const readyOnly = getOptionalBoolean(input, "readyOnly") ?? false;
  const markBlocked = getOptionalBoolean(input, "markBlocked") ?? false;
  const validate = (session: ReturnType<SurfaceHost["requireSession"]>): Record<string, unknown> => {
    const queue = requireQueue(host, queueId, session.workspace_root);
    const tasks = taskRows(host, queue.id).filter((task) => !readyOnly || task.status === "queued" || task.status === "ready");
    const issues = contextRefIssuesForTasks(queue, tasks);
    if (markBlocked) {
      const ids = new Set(issues.map((issue) => issue.queueTaskId));
      for (const task of tasks) {
        if (!ids.has(task.id) || !TASK_METADATA_EDITABLE_STATUSES.has(task.status)) continue;
        host.db.db
          .prepare("UPDATE project_queue_tasks SET status = 'blocked', summary = ?, ts_updated = CURRENT_TIMESTAMP WHERE id = ?")
          .run("Blocked before launch: context_ref_missing", task.id);
      }
    }
    return {
      schema: "agent-fabric.project-queue-context-ref-validation.v1",
      queueId: queue.id,
      ok: issues.length === 0,
      checked: tasks.length,
      markedBlocked: markBlocked ? new Set(issues.map((issue) => issue.queueTaskId)).size : 0,
      issues,
      summary: {
        contextRefMissing: issues.filter((issue) => issue.type === "context_ref_missing").length
      }
    };
  };
  if (markBlocked) return host.recordMutation("project_queue_validate_context_refs", input, context, validate);
  return validate(host.requireSession(context));
}

export function projectQueueClaimNext(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const queueId = getString(input, "queueId");
  const workerRunId = getOptionalString(input, "workerRunId") ?? null;
  const worker = optionalNormalized(input, "worker", WORKERS);
  const workspaceMode = worker ? normalizeValue(getOptionalString(input, "workspaceMode") ?? "in_place", WORKSPACE_MODES, "workspaceMode") : undefined;
  const modelProfile = worker ? getOptionalString(input, "modelProfile") ?? "execute.cheap" : undefined;
  const workspacePath = getOptionalString(input, "workspacePath");
  const contextPolicy = getOptionalString(input, "contextPolicy") ?? null;
  const maxRuntimeMinutes = getOptionalNumber(input, "maxRuntimeMinutes") ?? null;
  const command = getArray(input, "command");
  const metadata = asRecord(getField(input, "metadata"));
  const skipQueueTaskIds = new Set(getStringArray(input, "skipQueueTaskIds"));
  if (workerRunId && worker) {
    throw new FabricError("INVALID_INPUT", "Pass either workerRunId or worker settings, not both", false);
  }
  if (command.length > 0 && !command.every((item) => typeof item === "string")) {
    throw new FabricError("INVALID_INPUT", "command must be an array of strings", false);
  }

  return host.recordMutation("project_queue_claim_next", input, context, (session) => {
    const queue = requireQueue(host, queueId, session.workspace_root);
    const tasks = taskRows(host, queue.id);
    const active = tasks.filter((task) => ACTIVE_WORKER_STATUSES.has(task.status)).length;
    const slots = Math.max(0, queue.max_parallel_agents - active);
    const executionBlock = queueWorkerStartBlockReason(queue.status);
    if (executionBlock) {
      return {
        queueId: queue.id,
        claimed: undefined,
        executionBlocked: true,
        blockedReason: executionBlock,
        activeWorkers: active,
        availableSlots: slots,
        blocked: queueBlockedEntries(tasks, executionBlock).map(formatBlockedEntry)
      };
    }
    const analyzed = analyzeReadiness(tasks);
    const scheduled =
      slots > 0
        ? selectSchedulableReadyTasks(analyzed.ready.sort(compareReadyTasks), tasks, Math.max(1, Math.min(queue.max_parallel_agents, skipQueueTaskIds.size + 1)))
        : { ready: [], blocked: [] };
    const blocked = [...analyzed.blocked, ...scheduled.blocked].map(formatBlockedEntry);
    const task = scheduled.ready.find((entry) => !skipQueueTaskIds.has(entry.id));

    if (slots <= 0 || !task) {
      return {
        queueId: queue.id,
        claimed: undefined,
        activeWorkers: active,
        availableSlots: slots,
        blocked
      };
    }

    if (workerRunId) requireWorkerRunForFabricTask(host, workerRunId, task.fabric_task_id);
    const newWorkerRunId = worker ? newId("wrun") : null;
    if (worker && !task.fabric_task_id) {
      throw new FabricError("FABRIC_TASK_NOT_FOUND", "Queue task has no linked fabric task", false);
    }
    const claimProposal = worker ? createClaimToolContextProposal(host, queue, task, session, context) : undefined;
    if (claimProposal?.approvalRequired) {
      return {
        queueId: queue.id,
        claimed: undefined,
        approvalRequired: true,
        toolContextProposal: {
          proposalId: claimProposal.proposalId,
          queueTaskId: task.id,
          fabricTaskId: task.fabric_task_id ?? undefined,
          approvalRequired: claimProposal.approvalRequired,
          missingGrants: claimProposal.missingGrants
        },
        activeWorkers: active,
        availableSlots: slots,
        blocked
      };
	    }
	    if (worker && task.fabric_task_id) {
	      const claimedWorkerRunId = newWorkerRunId as string;
	      const claimedWorkspaceMode = workspaceMode ?? "in_place";
	      const claimedModelProfile = modelProfile ?? "execute.cheap";
	      const resolvedContextPolicy = contextPolicy ?? (claimProposal?.proposalId ? `tool_context:${claimProposal.proposalId}` : null);
	      const claimedCommand = command.length > 0 ? command : defaultWorkerCommand(worker, task.fabric_task_id);
	      const workerMetadata = workerRunMetadataForTask(metadata, task);
	      host.db.db
        .prepare(
          `INSERT INTO worker_runs (
            id, task_id, worker, status, project_path, workspace_mode, workspace_path,
            model_profile, context_policy, max_runtime_minutes, command_json, metadata_json,
            started_by_session_id, started_by_agent_id, origin_peer_id, test_mode
          ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          claimedWorkerRunId,
          task.fabric_task_id,
          worker,
          queue.project_path,
          claimedWorkspaceMode,
          workspacePath ?? defaultWorkerWorkspacePath(queue.project_path, task.id, claimedWorkspaceMode),
          claimedModelProfile,
          resolvedContextPolicy,
	          maxRuntimeMinutes,
	          JSON.stringify(claimedCommand),
	          JSON.stringify(workerMetadata),
          session.id,
          session.agent_id,
          host.originPeerId,
          session.test_mode
        );
      host.db.db
        .prepare("UPDATE tasks SET status = 'running', assignee = ?, project_path = COALESCE(project_path, ?), ts_updated = CURRENT_TIMESTAMP WHERE id = ?")
        .run(worker, queue.project_path, task.fabric_task_id);
      host.writeAuditAndEvent({
        sessionId: session.id,
        agentId: session.agent_id,
        hostName: session.host_name,
        workspaceRoot: session.workspace_root,
        action: "fabric.worker.started",
        sourceTable: "worker_runs",
        sourceId: claimedWorkerRunId,
        eventType: "fabric.worker.started",
        payload: {
          taskId: task.fabric_task_id,
          worker,
          projectPath: queue.project_path,
          workspaceMode: claimedWorkspaceMode,
          workspacePath: workspacePath ?? defaultWorkerWorkspacePath(queue.project_path, task.id, claimedWorkspaceMode),
	          modelProfile: claimedModelProfile,
	          contextPolicy: resolvedContextPolicy,
	          command: claimedCommand,
	          metadata: workerMetadata,
          queueId: queue.id,
          queueTaskId: task.id
        },
        testMode: session.test_mode === 1,
        context
      });
    }
    const assignedWorkerRunId = workerRunId ?? newWorkerRunId;
    host.db.db
      .prepare(
        `UPDATE project_queue_tasks
         SET status = 'running', assigned_worker_run_id = COALESCE(?, assigned_worker_run_id), ts_updated = CURRENT_TIMESTAMP
         WHERE id = ? AND status IN ('queued', 'ready')`
      )
      .run(assignedWorkerRunId, task.id);
    host.db.db.prepare("UPDATE project_queues SET status = 'running', ts_updated = CURRENT_TIMESTAMP WHERE id = ?").run(queue.id);
    const claimedTask = requireQueueTask(host, queue.id, task.id);
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "project.queue.task.claimed",
      sourceTable: "project_queue_tasks",
      sourceId: task.id,
      eventType: "project.queue.task.claimed",
      payload: { queueId: queue.id, queueTaskId: task.id, fabricTaskId: task.fabric_task_id, workerRunId: assignedWorkerRunId },
      testMode: session.test_mode === 1,
      context
    });
    const workerRun = assignedWorkerRunId
      ? (host.db.db.prepare("SELECT * FROM worker_runs WHERE id = ?").get(assignedWorkerRunId) as WorkerRunRow | undefined)
      : undefined;
    return {
      queueId: queue.id,
      claimed: formatQueueTask(claimedTask),
      workerRun: workerRun ? formatWorkerRun(workerRun) : undefined,
      toolContextProposal: claimProposal
        ? {
            proposalId: claimProposal.proposalId,
            queueTaskId: task.id,
            fabricTaskId: task.fabric_task_id ?? undefined,
            approvalRequired: claimProposal.approvalRequired,
            missingGrants: claimProposal.missingGrants
          }
        : undefined,
      activeWorkers: active + 1,
      availableSlots: Math.max(0, slots - 1),
      blocked
    };
  });
}

export function projectQueueRecoverStale(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const queueId = getString(input, "queueId");
  const staleAfterMinutes = normalizeStaleAfterMinutes(getOptionalNumber(input, "staleAfterMinutes") ?? 30);
  const action = normalizeValue(getOptionalString(input, "action") ?? "requeue", RECOVERY_ACTIONS, "action");
  const dryRun = getOptionalBoolean(input, "dryRun") ?? false;

  return host.recordMutation("project_queue_recover_stale", input, context, (session) => {
    const queue = requireQueue(host, queueId, session.workspace_root);
    const cutoff = new Date(host.now().getTime() - staleAfterMinutes * 60_000).toISOString();
    const candidates = staleWorkerRows(host, queue.id, cutoff, host.now().getTime());
    if (!dryRun) {
      for (const candidate of candidates) {
        const summary = `${action === "requeue" ? "Requeued" : "Failed"} after stale worker recovery. Last worker update: ${
          candidate.worker_ts_updated ?? "missing"
        }. Reason: ${candidate.stale_reason}.`;
        if (candidate.worker_run_id) {
          host.db.db.prepare("UPDATE worker_runs SET status = 'stale', ts_updated = CURRENT_TIMESTAMP WHERE id = ?").run(candidate.worker_run_id);
        }
        if (action === "requeue") {
          host.db.db
            .prepare(
              `UPDATE project_queue_tasks
               SET status = 'queued', assigned_worker_run_id = NULL, summary = COALESCE(summary, ?), ts_updated = CURRENT_TIMESTAMP
               WHERE id = ?`
            )
            .run(summary, candidate.id);
          if (candidate.fabric_task_id) {
            host.db.db
              .prepare("UPDATE tasks SET status = 'created', assignee = 'unassigned', summary = COALESCE(summary, ?), ts_updated = CURRENT_TIMESTAMP WHERE id = ?")
              .run(summary, candidate.fabric_task_id);
          }
        } else {
          host.db.db
            .prepare("UPDATE project_queue_tasks SET status = 'failed', summary = COALESCE(summary, ?), ts_updated = CURRENT_TIMESTAMP WHERE id = ?")
            .run(summary, candidate.id);
          if (candidate.fabric_task_id) {
            host.db.db
              .prepare("UPDATE tasks SET status = 'failed', summary = COALESCE(summary, ?), finished_at = CURRENT_TIMESTAMP, ts_updated = CURRENT_TIMESTAMP WHERE id = ?")
              .run(summary, candidate.fabric_task_id);
          }
        }
      }
      updateQueueCompletionStatus(host, queue.id);
    }
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "project.queue.stale_recovered",
      sourceTable: "project_queue_tasks",
      sourceId: queue.id,
      eventType: "project.queue.stale_recovered",
      payload: {
        queueId: queue.id,
        staleAfterMinutes,
        action,
        dryRun,
        count: candidates.length,
        queueTaskIds: candidates.map((candidate) => candidate.id)
      },
      testMode: session.test_mode === 1,
      context
    });
    return {
      queueId: queue.id,
      staleAfterMinutes,
      action,
      dryRun,
      count: candidates.length,
      recovered: candidates.map(formatStaleRecovery)
    };
  });
}

export function projectQueueRetryTask(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const queueId = getString(input, "queueId");
  const queueTaskId = getString(input, "queueTaskId");
  const reason = getOptionalString(input, "reason") ?? "Retry requested; task returned to queued.";
  const clearOutputs = getOptionalBoolean(input, "clearOutputs") ?? true;

  return host.recordMutation("project_queue_retry_task", input, context, (session) => {
    const queue = requireQueue(host, queueId, session.workspace_root);
    if (queue.status === "canceled") {
      throw new FabricError("PROJECT_QUEUE_RETRY_BLOCKED", `Queue ${queue.id} is canceled; create a new queue or record a resume decision first`, false);
    }
    const task = requireQueueTask(host, queue.id, queueTaskId);
    if (!RETRYABLE_TASK_STATUSES.has(task.status)) {
      throw new FabricError("PROJECT_QUEUE_TASK_NOT_RETRYABLE", `Task ${task.id} cannot be retried from status ${task.status}`, false);
    }
    if (task.assigned_worker_run_id) {
      host.db.db.prepare("UPDATE worker_runs SET status = 'stale', ts_updated = CURRENT_TIMESTAMP WHERE id = ?").run(task.assigned_worker_run_id);
    }
    host.db.db
      .prepare(
        `UPDATE project_queue_tasks
         SET status = 'queued',
             assigned_worker_run_id = NULL,
             summary = ?,
             patch_refs_json = CASE WHEN ? = 1 THEN '[]' ELSE patch_refs_json END,
             test_refs_json = CASE WHEN ? = 1 THEN '[]' ELSE test_refs_json END,
             ts_updated = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(reason, clearOutputs ? 1 : 0, clearOutputs ? 1 : 0, task.id);
    if (task.fabric_task_id) {
      host.db.db
        .prepare(
          `UPDATE tasks
           SET status = 'created', assignee = 'unassigned', summary = ?, finished_at = NULL, ts_updated = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
        .run(reason, task.fabric_task_id);
    }
    const nextQueueStatus = queue.status === "completed" ? "queue_review" : queue.status;
    host.db.db.prepare("UPDATE project_queues SET status = ?, ts_updated = CURRENT_TIMESTAMP WHERE id = ?").run(nextQueueStatus, queue.id);
    const retriedTask = requireQueueTask(host, queue.id, task.id);
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "project.queue.task.retried",
      sourceTable: "project_queue_tasks",
      sourceId: task.id,
      eventType: "project.queue.task.retried",
      payload: {
        queueId: queue.id,
        queueTaskId: task.id,
        fabricTaskId: task.fabric_task_id,
        previousStatus: task.status,
        previousWorkerRunId: task.assigned_worker_run_id,
        clearOutputs
      },
      testMode: session.test_mode === 1,
      context
    });
    return {
      queue: formatQueue({ ...queue, status: nextQueueStatus }),
      task: formatQueueTask(retriedTask),
      previousStatus: task.status,
      previousWorkerRunId: task.assigned_worker_run_id ?? undefined,
      clearOutputs
    };
  });
}

export function projectQueueAgentLanes(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const queue = requireQueue(host, getString(input, "queueId"), session.workspace_root);
  const includeCompleted = getOptionalBoolean(input, "includeCompleted") ?? false;
  const maxEventsPerLane = normalizeEventLimit(getOptionalNumber(input, "maxEventsPerLane") ?? defaultMaxEventsPerLane());
  const tasks = taskRows(host, queue.id);
  const taskByFabricId = new Map(tasks.filter((task) => task.fabric_task_id).map((task) => [task.fabric_task_id as string, task]));
  const fabricTaskIds = [...taskByFabricId.keys()];

  if (fabricTaskIds.length === 0) {
    return { queue: formatQueue(queue), count: 0, lanes: [] };
  }

  const placeholders = fabricTaskIds.map(() => "?").join(", ");
  const runs = host.db.db
    .prepare(`SELECT * FROM worker_runs WHERE task_id IN (${placeholders}) ORDER BY ts_updated DESC, ts_started DESC`)
    .all(...fabricTaskIds) as WorkerRunRow[];
  const lanes = [];

  for (const run of runs) {
    const task = taskByFabricId.get(run.task_id);
    if (!task) continue;
    if (!includeCompleted && (CLOSED_LANE_TASK_STATUSES.has(task.status) || CLOSED_LANE_WORKER_STATUSES.has(run.status))) continue;
    const events = workerEventRows(host, run.task_id, run.id, maxEventsPerLane);
    const checkpoint = latestWorkerCheckpoint(host, run.task_id, run.id);
    const formattedEvents = events.map(formatWorkerEvent);
    const latestEvent = formattedEvents[0];
    const formattedCheckpoint = checkpoint ? formatWorkerCheckpoint(checkpoint) : undefined;
    lanes.push({
      laneId: run.id,
      queueId: queue.id,
      queueTask: formatQueueTask(task),
      workerRun: formatWorkerRun(run),
      latestEvent,
      recentEvents: formattedEvents,
      latestCheckpoint: formattedCheckpoint,
      progress: laneProgress(task, run, latestEvent, formattedCheckpoint)
    });
  }

  return { queue: formatQueue(queue), count: lanes.length, lanes };
}

export function projectQueueApproveModelCalls(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const queue = requireQueue(host, getString(input, "queueId"), session.workspace_root);
  const budgetScope = `project_queue:${queue.id}`;
  const candidateModel = getOptionalString(input, "candidateModel") ?? "deepseek-v4-pro";
  const requestedProvider = getOptionalString(input, "requestedProvider") ?? "deepseek";
  const requestedReasoning = getOptionalString(input, "requestedReasoning") ?? "max";
  const expiresInSeconds = getOptionalNumber(input, "expiresInSeconds");
  const note = getOptionalString(input, "note") ?? `Queue-scoped Senior-mode model approval for ${queue.id}.`;
  const preflight = llmPreflight(
    host,
    {
      task: {
        type: "worker_deepseek_direct",
        queueId: queue.id,
        purpose: "queue_model_approval"
      },
      client: "agent-fabric-project",
      candidateModel,
      requestedProvider,
      requestedReasoning,
      contextPackageSummary: {
        queueId: queue.id,
        title: queue.title,
        maxParallelAgents: queue.max_parallel_agents
      },
      budgetScope,
      boundResourceId: budgetScope,
      enforce: true
    },
    childContext(context, "model-preflight")
  );

  if (preflight.decision === "allow") {
    return {
      schema: "agent-fabric.project-queue-model-approval.v1",
      queue: formatQueue(queue),
      budgetScope,
      status: "not_required",
      preflight,
      approval: undefined,
      approvalToken: undefined
    };
  }

  const approval = asRecord(preflight.approval);
  const requestId = typeof approval?.requestId === "string" ? approval.requestId : String(preflight.requestId ?? "");
  if (!requestId) {
    throw new FabricError("MODEL_APPROVAL_REQUEST_MISSING", `Model preflight for queue ${queue.id} did not return an approval request id`, false);
  }
  const approved = llmApprove(
    host,
    {
      requestId,
      decision: "allow",
      scope: "queue",
      boundResourceId: budgetScope,
      expiresInSeconds,
      note
    },
    childContext(context, "model-approve")
  );

  return {
    schema: "agent-fabric.project-queue-model-approval.v1",
    queue: formatQueue(queue),
    budgetScope,
    status: "approved",
    preflight,
    approval: approved,
    approvalToken: typeof approved.approvalToken === "string" ? approved.approvalToken : undefined,
    audit: {
      scope: "queue",
      boundResourceId: budgetScope,
      candidateModel,
      requestedProvider,
      requestedReasoning
    }
  };
}

export function projectQueueProgressReport(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const queue = requireQueue(host, getString(input, "queueId"), session.workspace_root);
  const maxEventsPerLane = normalizeEventLimit(getOptionalNumber(input, "maxEventsPerLane") ?? defaultMaxEventsPerLane());
  const managerSummaryLimit = normalizeManagerSummaryLimit(getOptionalNumber(input, "managerSummaryLimit") ?? 10);
  const tasks = taskRows(host, queue.id);
  const counts = statusCounts(tasks);
  const activeWorkers = tasks.filter((task) => ACTIVE_WORKER_STATUSES.has(task.status)).length;
  const analyzed = analyzeReadiness(tasks);
  const executionBlock = queueExecutionBlockReason(queue.status);
  const scheduled = executionBlock
    ? { ready: [], blocked: [] }
    : selectSchedulableReadyTasks(analyzed.ready.sort(compareReadyTasks), tasks, Math.max(0, queue.max_parallel_agents - activeWorkers));
  const blockedEntries = executionBlock ? queueBlockedEntries(tasks, executionBlock) : [...analyzed.blocked, ...scheduled.blocked];
  const nowIso = host.now().toISOString();
  const modelApprovals = pendingModelApprovalRows(host, queue.id, session.workspace_root, false, 50, nowIso);
  const toolApprovals = host.db.db
    .prepare(
      `SELECT * FROM tool_context_proposals
       WHERE queue_id = ? AND status = 'proposed' AND approval_required = 1
       ORDER BY ts_created ASC`
    )
	    .all(queue.id) as ToolContextProposalRow[];
  const lanes = projectQueueAgentLanes(host, { queueId: queue.id, includeCompleted: true, maxEventsPerLane }, context);
  const preflights = queuePreflightRows(host, queue.id, session.workspace_root);
  const workerCosts = queueWorkerCostAttributions(host, queue.id);
  const patchReadyTasks = tasks.filter((task) => task.status === "patch_ready").map(formatQueueTask);
  const acceptedTasks = tasks.filter((task) => task.status === "accepted").map(formatQueueTask);
  const failedTasks = tasks.filter((task) => task.status === "failed" || task.status === "canceled").map(formatQueueTask);
  const pendingApprovalCount = modelApprovals.length + toolApprovals.length;
  const summary = queueSummaryStrip({
    queue,
    tasks,
    counts,
    activeWorkers,
    availableSlots: Math.max(0, queue.max_parallel_agents - activeWorkers),
    readyCount: scheduled.ready.length,
    blockedCount: blockedEntries.length,
    pendingToolApprovals: toolApprovals.length,
    pendingModelApprovals: modelApprovals.length,
    staleRunningCount: staleWorkerRows(host, queue.id, new Date(host.now().getTime() - 30 * 60_000).toISOString(), host.now().getTime()).length,
    preflights,
    workerCosts
  });
  const nextActions = nextProgressActions(queue, summary, pendingApprovalCount, patchReadyTasks.length, scheduled.ready.length);
  const laneRows = arrayRecordsFromUnknown(lanes.lanes);

  return {
    schema: "agent-fabric.project-queue-progress.v1",
    queue: formatQueue(queue),
    generatedAt: nowIso,
    summary,
    managerSummary: queueManagerSummary({
      tasks,
      lanes: laneRows,
      blockedEntries,
      toolApprovals,
      modelApprovals,
      maxItems: managerSummaryLimit
    }),
    counts,
    workers: lanes,
    blockers: blockedEntries.map(formatBlockedEntry),
    approvals: {
      pendingToolApprovals: toolApprovals.map(formatProposal),
      pendingModelApprovals: modelApprovals.map((row) => formatModelApproval(row, nowIso))
    },
    patchReadyTasks,
    acceptedTasks,
    failedTasks,
    nextActions,
    nextCommand: nextActions[0]?.command,
    verificationChecklist: [
      "Review every patch-ready task before acceptance.",
      "Run targeted tests or checks from each accepted worker result.",
      "Record accepted or rejected output in the queue before final handoff."
    ]
  };
}

export function projectQueueAssignWorker(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const queueId = getString(input, "queueId");
  const queueTaskId = getString(input, "queueTaskId");
  const workerRunId = getOptionalString(input, "workerRunId") ?? null;

  return host.recordMutation("project_queue_assign_worker", input, context, (session) => {
    const queue = requireQueue(host, queueId, session.workspace_root);
    const executionBlock = queueWorkerStartBlockReason(queue.status);
    if (executionBlock) {
      throw new FabricError("PROJECT_QUEUE_EXECUTION_BLOCKED", `Queue ${queue.id} cannot assign workers because ${executionBlock}`, false);
    }
    if (!workerRunId) {
      throw new FabricError(
        "PROJECT_QUEUE_WORKER_RUN_REQUIRED",
        "project_queue_assign_worker requires workerRunId; start/register the worker with fabric_task_start_worker or use project_queue_claim_next with worker settings.",
        false
      );
    }
    const task = requireQueueTask(host, queue.id, queueTaskId);
    if (!["queued", "ready", "running"].includes(task.status)) {
      throw new FabricError("PROJECT_QUEUE_TASK_NOT_READY", `Task ${task.id} cannot be assigned from status ${task.status}`, false);
    }
    if (task.status === "running" && task.assigned_worker_run_id && task.assigned_worker_run_id !== workerRunId) {
      throw new FabricError("PROJECT_QUEUE_TASK_ALREADY_ASSIGNED", `Task ${task.id} is already assigned to worker run ${task.assigned_worker_run_id}`, false);
    }
    if (task.status === "running" && task.assigned_worker_run_id && !workerRunId) {
      throw new FabricError("PROJECT_QUEUE_TASK_ALREADY_ASSIGNED", `Task ${task.id} is already assigned to worker run ${task.assigned_worker_run_id}`, false);
    }
    const tasks = taskRows(host, queue.id);
    if (!isTaskDependencyReady(task, tasks)) {
      throw new FabricError("PROJECT_QUEUE_TASK_BLOCKED", `Task ${task.id} has unmet dependencies`, false);
    }
    assertTaskSchedulable(task, tasks);
    if (workerRunId) requireWorkerRunForFabricTask(host, workerRunId, task.fabric_task_id);
    const assignmentProposal = ensureTaskToolContextProposal(host, queue, task, session, context, "project_queue_assign_worker");
    if (assignmentProposal.approvalRequired) {
      return {
        queueId: queue.id,
        queueTaskId: task.id,
        fabricTaskId: task.fabric_task_id ?? undefined,
        workerRunId,
        status: task.status,
        assigned: false,
        approvalRequired: true,
        toolContextProposal: assignmentProposal.proposal
          ? {
              proposalId: assignmentProposal.proposal.id,
              queueTaskId: task.id,
              fabricTaskId: task.fabric_task_id ?? undefined,
              approvalRequired: assignmentProposal.approvalRequired,
              missingGrants: assignmentProposal.missingGrants
            }
          : undefined
      };
    }
    host.db.db
      .prepare(
        `UPDATE project_queue_tasks
         SET status = 'running', assigned_worker_run_id = COALESCE(?, assigned_worker_run_id), ts_updated = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(workerRunId, task.id);
    host.db.db.prepare("UPDATE project_queues SET status = 'running', ts_updated = CURRENT_TIMESTAMP WHERE id = ?").run(queue.id);
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "project.queue.worker.assigned",
      sourceTable: "project_queue_tasks",
      sourceId: task.id,
      eventType: "project.queue.worker.assigned",
      payload: {
        queueId: queue.id,
        queueTaskId: task.id,
        fabricTaskId: task.fabric_task_id,
        workerRunId,
        toolContextProposalId: assignmentProposal.proposal?.id
      },
      testMode: session.test_mode === 1,
      context
    });
    return {
      queueId: queue.id,
      queueTaskId: task.id,
      fabricTaskId: task.fabric_task_id,
      workerRunId: workerRunId ?? undefined,
      status: "running",
      assigned: true,
      approvalRequired: false,
      toolContextProposal: assignmentProposal.proposal ? formatProposal(assignmentProposal.proposal) : undefined
    };
  });
}

export function projectQueueUpdateTask(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const queueId = getString(input, "queueId");
  const queueTaskId = getString(input, "queueTaskId");
  const status = normalizeValue(getString(input, "status"), TASK_STATUSES, "status");
  const summary = getOptionalString(input, "summary");
  const workerRunId = getOptionalString(input, "workerRunId") ?? null;
  const patchRefs = getStringArray(input, "patchRefs");
  const testRefs = getStringArray(input, "testRefs");

  return host.recordMutation("project_queue_update_task", input, context, (session) => {
    const queue = requireQueue(host, queueId, session.workspace_root);
    const task = requireQueueTask(host, queue.id, queueTaskId);
    if (workerRunId) requireWorkerRunForFabricTask(host, workerRunId, task.fabric_task_id);
    host.db.db
      .prepare(
        `UPDATE project_queue_tasks
         SET status = ?, summary = COALESCE(?, summary),
             assigned_worker_run_id = COALESCE(?, assigned_worker_run_id),
             patch_refs_json = CASE WHEN ? = '[]' THEN patch_refs_json ELSE ? END,
             test_refs_json = CASE WHEN ? = '[]' THEN test_refs_json ELSE ? END,
             ts_updated = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(
        status,
        summary ?? null,
        workerRunId,
        JSON.stringify(patchRefs),
        JSON.stringify(patchRefs),
        JSON.stringify(testRefs),
        JSON.stringify(testRefs),
        task.id
      );
    updateLinkedFabricTask(host, task.fabric_task_id, status, summary, patchRefs, testRefs);
    updateQueueCompletionStatus(host, queue.id);
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "project.queue.task.updated",
      sourceTable: "project_queue_tasks",
      sourceId: task.id,
      eventType: "project.queue.task.updated",
      payload: { queueId: queue.id, queueTaskId: task.id, fabricTaskId: task.fabric_task_id, status, workerRunId, patchRefs, testRefs },
      testMode: session.test_mode === 1,
      context
    });
    return { queueId: queue.id, queueTaskId: task.id, fabricTaskId: task.fabric_task_id, status };
  });
}

export function projectQueueUpdateTaskMetadata(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const queueId = getString(input, "queueId");
  const queueTaskId = getString(input, "queueTaskId");
  const title = getOptionalString(input, "title");
  const goal = getOptionalString(input, "goal");
  const phase = getOptionalString(input, "phase");
  const managerId = getOptionalString(input, "managerId") ?? getOptionalString(input, "manager");
  const parentManagerId = getOptionalString(input, "parentManagerId");
  const parentQueueId = getOptionalString(input, "parentQueueId");
  const workstream = getOptionalString(input, "workstream");
  const costCenter = getOptionalString(input, "costCenter");
  const escalationTarget = getOptionalString(input, "escalationTarget");
  const category = getOptionalString(input, "category");
  const priority = optionalNormalized(input, "priority", TASK_PRIORITIES);
  const parallelGroup = getOptionalString(input, "parallelGroup");
  const parallelSafe = getOptionalBoolean(input, "parallelSafe");
  const risk = optionalNormalized(input, "risk", RISKS);
  const clearPhase = getOptionalBoolean(input, "clearPhase") ?? false;
  const clearManagerId = getOptionalBoolean(input, "clearManagerId") ?? getOptionalBoolean(input, "clearManager") ?? false;
  const clearParentManagerId = getOptionalBoolean(input, "clearParentManagerId") ?? false;
  const clearParentQueueId = getOptionalBoolean(input, "clearParentQueueId") ?? false;
  const clearWorkstream = getOptionalBoolean(input, "clearWorkstream") ?? false;
  const clearCostCenter = getOptionalBoolean(input, "clearCostCenter") ?? false;
  const clearEscalationTarget = getOptionalBoolean(input, "clearEscalationTarget") ?? false;
  const clearParallelGroup = getOptionalBoolean(input, "clearParallelGroup") ?? false;
  const expectedFiles = optionalStringArrayInput(input, "expectedFiles");
  const acceptanceCriteria = optionalStringArrayInput(input, "acceptanceCriteria");
  const requiredTools = optionalStringArrayInput(input, "requiredTools");
  const requiredMcpServers = optionalStringArrayInput(input, "requiredMcpServers");
  const requiredMemories = optionalStringArrayInput(input, "requiredMemories");
  const requiredContextRefs = optionalStringArrayInput(input, "requiredContextRefs");
  const addRequiredTools = optionalStringArrayInput(input, "addRequiredTools");
  const addRequiredMcpServers = optionalStringArrayInput(input, "addRequiredMcpServers");
  const addRequiredMemories = optionalStringArrayInput(input, "addRequiredMemories");
  const addRequiredContextRefs = optionalStringArrayInput(input, "addRequiredContextRefs");
  const removeRequiredTools = optionalStringArrayInput(input, "removeRequiredTools");
  const removeRequiredMcpServers = optionalStringArrayInput(input, "removeRequiredMcpServers");
  const removeRequiredMemories = optionalStringArrayInput(input, "removeRequiredMemories");
  const removeRequiredContextRefs = optionalStringArrayInput(input, "removeRequiredContextRefs");
  const rewriteContextRefs = parseRewriteSpecs(getStringArray(input, "rewriteContextRefs"), "rewriteContextRefs");
  const dependsOn = optionalStringArrayInput(input, "dependsOn");
  const note = getOptionalString(input, "note") ?? null;
  if (title !== undefined && title.trim().length === 0) throw new FabricError("INVALID_INPUT", "title must not be empty", false);
  if (goal !== undefined && goal.trim().length === 0) throw new FabricError("INVALID_INPUT", "goal must not be empty", false);
  if (category !== undefined && category.trim().length === 0) throw new FabricError("INVALID_INPUT", "category must not be empty", false);
  if (phase !== undefined && clearPhase) throw new FabricError("INVALID_INPUT", "Pass either phase or clearPhase, not both", false);
  if (managerId !== undefined && clearManagerId) throw new FabricError("INVALID_INPUT", "Pass either managerId or clearManagerId, not both", false);
  if (parentManagerId !== undefined && clearParentManagerId) throw new FabricError("INVALID_INPUT", "Pass either parentManagerId or clearParentManagerId, not both", false);
  if (parentQueueId !== undefined && clearParentQueueId) throw new FabricError("INVALID_INPUT", "Pass either parentQueueId or clearParentQueueId, not both", false);
  if (workstream !== undefined && clearWorkstream) throw new FabricError("INVALID_INPUT", "Pass either workstream or clearWorkstream, not both", false);
  if (costCenter !== undefined && clearCostCenter) throw new FabricError("INVALID_INPUT", "Pass either costCenter or clearCostCenter, not both", false);
  if (escalationTarget !== undefined && clearEscalationTarget) throw new FabricError("INVALID_INPUT", "Pass either escalationTarget or clearEscalationTarget, not both", false);
  if (parallelGroup !== undefined && clearParallelGroup) throw new FabricError("INVALID_INPUT", "Pass either parallelGroup or clearParallelGroup, not both", false);
  rejectSetAndPatch(requiredTools, addRequiredTools, removeRequiredTools, "requiredTools");
  rejectSetAndPatch(requiredMcpServers, addRequiredMcpServers, removeRequiredMcpServers, "requiredMcpServers");
  rejectSetAndPatch(requiredMemories, addRequiredMemories, removeRequiredMemories, "requiredMemories");
  rejectSetAndPatch(requiredContextRefs, addRequiredContextRefs, removeRequiredContextRefs, "requiredContextRefs");

  return host.recordMutation("project_queue_update_task_metadata", input, context, (session) => {
    const queue = requireQueue(host, queueId, session.workspace_root);
    const task = requireQueueTask(host, queue.id, queueTaskId);
    if (!TASK_METADATA_EDITABLE_STATUSES.has(task.status)) {
      throw new FabricError("PROJECT_QUEUE_TASK_METADATA_LOCKED", `Task ${task.id} metadata cannot be edited from status ${task.status}`, false);
    }
    const allTasks = taskRows(host, queue.id);
    const nextDependsOn = dependsOn ?? safeJsonArray(task.depends_on_json).filter((value): value is string => typeof value === "string");
    validateDependencyPatch(task.id, nextDependsOn, allTasks);
    const nextTitle = title?.trim() ?? task.title;
    const nextGoal = goal?.trim() ?? task.goal;
    const nextPriority = priority ?? task.priority;
    const nextRequiredTools = nextSetAddRemove(task.required_tools_json, requiredTools, addRequiredTools, removeRequiredTools);
    const nextRequiredMcpServers = nextSetAddRemove(task.required_mcp_servers_json, requiredMcpServers, addRequiredMcpServers, removeRequiredMcpServers);
    const nextRequiredMemories = nextSetAddRemove(task.required_memories_json, requiredMemories, addRequiredMemories, removeRequiredMemories);
    const nextRequiredContextRefs = applyRewriteSpecs(
      nextSetAddRemove(task.required_context_refs_json, requiredContextRefs, addRequiredContextRefs, removeRequiredContextRefs),
      rewriteContextRefs
    );
    const toolContextRequirementsChanged =
      !jsonArraysEqual(task.required_tools_json, nextRequiredTools) ||
      !jsonArraysEqual(task.required_mcp_servers_json, nextRequiredMcpServers) ||
      !jsonArraysEqual(task.required_memories_json, nextRequiredMemories) ||
      !jsonArraysEqual(task.required_context_refs_json, nextRequiredContextRefs);
    host.db.db
      .prepare(
        `UPDATE project_queue_tasks
	         SET title = ?,
	             goal = ?,
	             phase = ?,
	             manager_id = ?,
	             parent_manager_id = ?,
	             parent_queue_id = ?,
	             workstream = ?,
	             cost_center = ?,
	             escalation_target = ?,
	             category = ?,
             priority = ?,
             parallel_group = ?,
             parallel_safe = ?,
             risk = ?,
             expected_files_json = ?,
             acceptance_criteria_json = ?,
             required_tools_json = ?,
             required_mcp_servers_json = ?,
             required_memories_json = ?,
             required_context_refs_json = ?,
             depends_on_json = ?,
             ts_updated = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(
	        nextTitle,
	        nextGoal,
	        clearPhase ? null : phase ?? task.phase,
	        clearManagerId ? null : managerId ?? task.manager_id,
	        clearParentManagerId ? null : parentManagerId ?? task.parent_manager_id,
	        clearParentQueueId ? null : parentQueueId ?? task.parent_queue_id,
	        clearWorkstream ? null : workstream ?? task.workstream,
	        clearCostCenter ? null : costCenter ?? task.cost_center,
	        clearEscalationTarget ? null : escalationTarget ?? task.escalation_target,
	        category?.trim() ?? task.category,
        nextPriority,
        clearParallelGroup ? null : parallelGroup ?? task.parallel_group,
        parallelSafe === undefined ? task.parallel_safe : parallelSafe ? 1 : 0,
        risk ?? task.risk,
        JSON.stringify(expectedFiles ?? safeJsonArray(task.expected_files_json)),
        JSON.stringify(acceptanceCriteria ?? safeJsonArray(task.acceptance_criteria_json)),
        JSON.stringify(nextRequiredTools),
        JSON.stringify(nextRequiredMcpServers),
        JSON.stringify(nextRequiredMemories),
        JSON.stringify(nextRequiredContextRefs),
        JSON.stringify(nextDependsOn),
        task.id
      );
    if (task.fabric_task_id) {
      host.db.db
        .prepare("UPDATE tasks SET title = ?, goal = ?, priority = ?, ts_updated = CURRENT_TIMESTAMP WHERE id = ?")
        .run(nextTitle, nextGoal, toWorkerPriority(nextPriority), task.fabric_task_id);
    }
    host.db.db.prepare("UPDATE project_queues SET status = 'queue_review', ts_updated = CURRENT_TIMESTAMP WHERE id = ?").run(queue.id);
    const updated = requireQueueTask(host, queue.id, task.id);
    const staleToolContextProposalIds = toolContextRequirementsChanged
      ? markPendingTaskToolContextProposalsForRevision(
          host,
          queue,
          task,
          session,
          context,
          note ?? "Task tool/context requirements changed during queue review."
        )
      : [];
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "project.queue.task.metadata_updated",
      sourceTable: "project_queue_tasks",
      sourceId: task.id,
      eventType: "project.queue.task.metadata_updated",
      payload: {
        queueId: queue.id,
        queueTaskId: task.id,
        fabricTaskId: task.fabric_task_id,
        note: note ?? undefined,
        previous: taskMetadataSnapshot(task),
        updated: taskMetadataSnapshot(updated),
        staleToolContextProposalIds: staleToolContextProposalIds.length > 0 ? staleToolContextProposalIds : undefined
      },
      testMode: session.test_mode === 1,
      context
    });
    return {
      queue: formatQueue(requireQueue(host, queue.id, session.workspace_root)),
      task: formatQueueTask(updated),
      previousTask: formatQueueTask(task),
      staleToolContextProposalIds
    };
  });
}

export function projectQueueDecide(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const queueId = getString(input, "queueId");
  const decision = normalizeValue(getString(input, "decision"), QUEUE_DECISIONS, "decision");
  const note = getOptionalString(input, "note") ?? null;
  const metadata = asRecord(getField(input, "metadata"));

  return host.recordMutation("project_queue_decide", input, context, (session) => {
    const queue = requireQueue(host, queueId, session.workspace_root);
    const decisionId = newId("pqdec");
    host.db.db
      .prepare(
        `INSERT INTO project_queue_decisions (
          id, queue_id, decision, note, metadata_json, session_id, agent_id,
          origin_peer_id, test_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(decisionId, queue.id, decision, note, JSON.stringify(metadata), session.id, session.agent_id, host.originPeerId, session.test_mode);
    host.db.db.prepare("UPDATE project_queues SET status = ?, ts_updated = CURRENT_TIMESTAMP WHERE id = ?").run(queueStatusForDecision(decision, queue.status), queue.id);
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "project.queue.decision.recorded",
      sourceTable: "project_queue_decisions",
      sourceId: decisionId,
      eventType: "project.queue.decision.recorded",
      payload: { queueId: queue.id, decision, note },
      testMode: session.test_mode === 1,
      context
    });
    return { decisionId, queueId: queue.id, decision, status: queueStatusForDecision(decision, queue.status) };
  });
}

export function toolContextPropose(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const queueId = getString(input, "queueId");
  const queueTaskId = getOptionalString(input, "queueTaskId") ?? null;
  const explicitFabricTaskId = getOptionalString(input, "fabricTaskId") ?? null;
  const mcpServers = jsonArray(input, "mcpServers");
  const tools = jsonArray(input, "tools");
  const memories = jsonArray(input, "memories");
  const contextRefs = jsonArray(input, "contextRefs");
  const modelAlias = getOptionalString(input, "modelAlias") ?? null;
  const reasoning = getOptionalString(input, "reasoning") ?? null;
  const safetyWarnings = getStringArray(input, "safetyWarnings");
  const requestedApproval = getOptionalBoolean(input, "approvalRequired");

  return host.recordMutation("tool_context_propose", input, context, (session) => {
    const queue = requireQueue(host, queueId, session.workspace_root);
    const queueTask = queueTaskId ? requireQueueTask(host, queue.id, queueTaskId) : undefined;
    const fabricTaskId = explicitFabricTaskId ?? queueTask?.fabric_task_id ?? null;
    if (fabricTaskId) requireFabricTask(host, fabricTaskId, session.workspace_root);
    const grants = [
      ...mcpServers.map((value) => grant("mcp_server", value)),
      ...tools.map((value) => grant("tool", value)),
      ...memories.map((value) => grant("memory", value)),
      ...contextRefs.map((value) => grant("context", value))
    ];
    const policyStatuses = policyGrantStatuses(host, queue);
    const missingGrants = grants
      .filter((entry) => policyStatuses.get(entry.grantKey) !== "approved")
      .map((entry) => ({ ...entry, policyStatus: policyStatuses.get(entry.grantKey) ?? "missing" }));
    const approvalRequired = requestedApproval === true || missingGrants.length > 0 || safetyWarnings.length > 0;
    const proposalId = newId("tcprop");
    host.db.db
      .prepare(
        `INSERT INTO tool_context_proposals (
          id, queue_id, queue_task_id, fabric_task_id, status, mcp_servers_json,
          tools_json, memories_json, context_refs_json, model_alias, reasoning,
          safety_warnings_json, approval_required, missing_grants_json, session_id,
          agent_id, origin_peer_id, test_mode
        ) VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        proposalId,
        queue.id,
        queueTask?.id ?? null,
        fabricTaskId,
        JSON.stringify(mcpServers),
        JSON.stringify(tools),
        JSON.stringify(memories),
        JSON.stringify(contextRefs),
        modelAlias,
        reasoning,
        JSON.stringify(safetyWarnings),
        approvalRequired ? 1 : 0,
        JSON.stringify(missingGrants),
        session.id,
        session.agent_id,
        host.originPeerId,
        session.test_mode
      );
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "tool.context.proposed",
      sourceTable: "tool_context_proposals",
      sourceId: proposalId,
      eventType: "tool.context.proposed",
      payload: { queueId: queue.id, queueTaskId: queueTask?.id, fabricTaskId, approvalRequired, missingGrants },
      testMode: session.test_mode === 1,
      context
    });
    return { proposalId, queueId: queue.id, queueTaskId: queueTask?.id, fabricTaskId: fabricTaskId ?? undefined, approvalRequired, missingGrants };
  });
}

export function toolContextDecide(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const proposalId = getString(input, "proposalId");
  const decision = normalizeValue(getString(input, "decision"), TOOL_DECISIONS, "decision");
  const note = getOptionalString(input, "note") ?? null;
  const remember = getOptionalBoolean(input, "remember") ?? false;

  return host.recordMutation("tool_context_decide", input, context, (session) => {
    const proposal = requireProposal(host, proposalId);
    const queue = requireQueue(host, proposal.queue_id, session.workspace_root);
    const status = proposalStatusForDecision(decision);
    host.db.db
      .prepare(
        `UPDATE tool_context_proposals
         SET status = ?, decision = ?, decision_note = ?, decided_by_session_id = ?,
             decided_by_agent_id = ?, ts_decided = CURRENT_TIMESTAMP, ts_updated = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(status, decision, note, session.id, session.agent_id, proposal.id);
    let rememberedGrants = 0;
    const rememberedStatus = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : undefined;
    if (rememberedStatus && remember) {
      for (const entry of proposalGrants(proposal)) {
        host.db.db
          .prepare(
            `INSERT INTO tool_context_policies (
              id, workspace_root, project_path, grant_key, grant_kind, value_json,
              status, decided_by_session_id, decided_by_agent_id, origin_peer_id, test_mode
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(workspace_root, project_path, grant_key) DO UPDATE SET
              grant_kind = excluded.grant_kind,
              value_json = excluded.value_json,
              status = excluded.status,
              decided_by_session_id = excluded.decided_by_session_id,
              decided_by_agent_id = excluded.decided_by_agent_id,
              origin_peer_id = excluded.origin_peer_id,
              test_mode = excluded.test_mode,
              ts_decided = CURRENT_TIMESTAMP`
          )
          .run(
            newId("tcpol"),
            queue.workspace_root,
            queue.project_path,
            entry.grantKey,
            entry.kind,
            JSON.stringify(entry.value),
            rememberedStatus,
            session.id,
            session.agent_id,
            host.originPeerId,
            session.test_mode
          );
        rememberedGrants += 1;
      }
    }
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "tool.context.decided",
      sourceTable: "tool_context_proposals",
      sourceId: proposal.id,
      eventType: "tool.context.decided",
      payload: { proposalId: proposal.id, queueId: queue.id, decision, remember, rememberedGrants },
      testMode: session.test_mode === 1,
      context
    });
    return { proposalId: proposal.id, queueId: queue.id, decision, status, rememberedGrants };
  });
}

export function toolContextPending(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const projectPath = getOptionalString(input, "projectPath");
  const queueId = getOptionalString(input, "queueId");
  const limit = normalizeListLimit(getOptionalNumber(input, "limit") ?? 50);
  if (queueId) requireQueue(host, queueId, session.workspace_root);

  const params: Array<string | number> = [session.workspace_root];
  const where = ["q.workspace_root = ?", "p.status = 'proposed'", "p.approval_required = 1"];
  if (projectPath) {
    where.push("q.project_path = ?");
    params.push(projectPath);
  }
  if (queueId) {
    where.push("p.queue_id = ?");
    params.push(queueId);
  }
  params.push(limit);

  const rows = host.db.db
    .prepare(
      `SELECT p.*, q.project_path, q.title AS queue_title, t.title AS queue_task_title, t.status AS queue_task_status
       FROM tool_context_proposals p
       JOIN project_queues q ON q.id = p.queue_id
       LEFT JOIN project_queue_tasks t ON t.id = p.queue_task_id
       WHERE ${where.join(" AND ")}
       ORDER BY p.ts_created ASC
       LIMIT ?`
    )
    .all(...params) as Array<
    ToolContextProposalRow & {
      project_path: string;
      queue_title: string;
      queue_task_title: string | null;
      queue_task_status: string | null;
    }
  >;

  return {
    workspaceRoot: session.workspace_root,
    projectPath: projectPath ?? undefined,
    queueId: queueId ?? undefined,
    count: rows.length,
    pending: rows.map((row) => ({
      ...formatProposal(row),
      projectPath: row.project_path,
      queueTitle: row.queue_title,
      queueTaskTitle: row.queue_task_title ?? undefined,
      queueTaskStatus: row.queue_task_status ?? undefined
    }))
  };
}

export function toolContextPolicySet(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const projectPath = getString(input, "projectPath");
  const grantKind = normalizeValue(getString(input, "grantKind"), GRANT_KINDS, "grantKind");
  const status = normalizeValue(getString(input, "status"), POLICY_STATUSES, "status");
  const value = getField(input, "value");
  if (value === undefined || value === null) {
    throw new FabricError("INVALID_INPUT", "Expected value for tool/context policy grant", false);
  }
  const entry = grant(grantKind, value);

  return host.recordMutation("tool_context_policy_set", input, context, (session) => {
    const policyId = newId("tcpol");
    host.db.db
      .prepare(
        `INSERT INTO tool_context_policies (
          id, workspace_root, project_path, grant_key, grant_kind, value_json,
          status, decided_by_session_id, decided_by_agent_id, origin_peer_id, test_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_root, project_path, grant_key) DO UPDATE SET
          grant_kind = excluded.grant_kind,
          value_json = excluded.value_json,
          status = excluded.status,
          decided_by_session_id = excluded.decided_by_session_id,
          decided_by_agent_id = excluded.decided_by_agent_id,
          origin_peer_id = excluded.origin_peer_id,
          test_mode = excluded.test_mode,
          ts_decided = CURRENT_TIMESTAMP`
      )
      .run(
        policyId,
        session.workspace_root,
        projectPath,
        entry.grantKey,
        grantKind,
        JSON.stringify(value),
        status,
        session.id,
        session.agent_id,
        host.originPeerId,
        session.test_mode
      );
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "tool.context.policy.set",
      sourceTable: "tool_context_policies",
      sourceId: entry.grantKey,
      eventType: "tool.context.policy.set",
      payload: { projectPath, grantKind, grantKey: entry.grantKey, status },
      testMode: session.test_mode === 1,
      context
    });
    return { workspaceRoot: session.workspace_root, projectPath, grantKind, grantKey: entry.grantKey, value, status };
  });
}

export function toolContextPolicyStatus(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const projectPath = getOptionalString(input, "projectPath");
  const rows = projectPath
    ? (host.db.db
        .prepare("SELECT * FROM tool_context_policies WHERE workspace_root = ? AND project_path = ? ORDER BY ts_decided ASC")
        .all(session.workspace_root, projectPath) as ToolContextPolicyRow[])
    : (host.db.db
        .prepare("SELECT * FROM tool_context_policies WHERE workspace_root = ? ORDER BY project_path ASC, ts_decided ASC")
        .all(session.workspace_root) as ToolContextPolicyRow[]);
  return { workspaceRoot: session.workspace_root, projectPath: projectPath ?? undefined, grants: rows.map(formatPolicy) };
}

function prepareTask(input: unknown): {
  queueTaskId: string;
  clientKey?: string;
  title: string;
  goal: string;
  phase: string | null;
  managerId: string | null;
  parentManagerId: string | null;
  parentQueueId: string | null;
  workstream: string | null;
  costCenter: string | null;
  escalationTarget: string | null;
  category: string;
  status: string;
  priority: string;
  parallelGroup: string | null;
  parallelSafe: boolean;
  risk: string;
  expectedFiles: string[];
  acceptanceCriteria: string[];
  requiredTools: string[];
  requiredMcpServers: string[];
  requiredMemories: string[];
  requiredContextRefs: string[];
  dependsOn: string[];
} {
  const record = asRecord(input);
  if (!record || Object.keys(record).length === 0) {
    throw new FabricError("INVALID_INPUT", "Each task must be an object", false);
  }
  const title = stringField(record, "title");
  const goal = stringField(record, "goal");
  const status = normalizeValue(optionalStringField(record, "status") ?? "queued", TASK_STATUSES, "task.status");
  return {
    queueTaskId: "",
    clientKey: optionalStringField(record, "clientKey"),
    title,
    goal,
    phase: optionalStringField(record, "phase") ?? null,
    managerId: optionalStringField(record, "managerId") ?? optionalStringField(record, "manager") ?? null,
    parentManagerId: optionalStringField(record, "parentManagerId") ?? null,
    parentQueueId: optionalStringField(record, "parentQueueId") ?? null,
    workstream: optionalStringField(record, "workstream") ?? null,
    costCenter: optionalStringField(record, "costCenter") ?? null,
    escalationTarget: optionalStringField(record, "escalationTarget") ?? null,
    category: optionalStringField(record, "category") ?? "implementation",
    status,
    priority: normalizeValue(optionalStringField(record, "priority") ?? "normal", TASK_PRIORITIES, "task.priority"),
    parallelGroup: optionalStringField(record, "parallelGroup") ?? null,
    parallelSafe: optionalBooleanField(record, "parallelSafe") ?? true,
    risk: normalizeValue(optionalStringField(record, "risk") ?? "medium", RISKS, "task.risk"),
    expectedFiles: stringArrayField(record, "expectedFiles"),
    acceptanceCriteria: stringArrayField(record, "acceptanceCriteria"),
    requiredTools: stringArrayField(record, "requiredTools"),
    requiredMcpServers: stringArrayField(record, "requiredMcpServers"),
    requiredMemories: stringArrayField(record, "requiredMemories"),
    requiredContextRefs: stringArrayField(record, "requiredContextRefs"),
    dependsOn: stringArrayField(record, "dependsOn")
  };
}

function promptSummaryFromInput(input: unknown): string {
  const explicitSummary = getOptionalString(input, "promptSummary");
  if (explicitSummary && explicitSummary.trim().length > 0) return explicitSummary.trim();
  const prompt = getOptionalString(input, "prompt");
  if (!prompt) {
    throw new FabricError("INVALID_INPUT", "Expected promptSummary or prompt", false);
  }
  return `Raw prompt intentionally not stored; received ${prompt.length} characters for prompt-improvement pipeline.`;
}

function defaultQueueTitle(projectPath: string): string {
  const name = basename(projectPath);
  return name.length > 0 ? `${name} project queue` : "Project queue";
}

function normalizeMaxParallelAgents(value: number): number {
  const max = maxParallelAgentsLimit();
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new FabricError("INVALID_INPUT", `maxParallelAgents must be an integer between 1 and ${max}`, false);
  }
  return value;
}

function normalizePositiveLimit(value: number): number {
  const max = maxQueueListLimit();
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new FabricError("INVALID_INPUT", `limit must be an integer between 1 and ${max}`, false);
  }
  return value;
}

function normalizeListLimit(value: number): number {
  const max = maxQueueListLimit();
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new FabricError("INVALID_INPUT", `limit must be an integer between 1 and ${max}`, false);
  }
  return value;
}

function normalizeNonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new FabricError("INVALID_INPUT", `${field} must be a non-negative integer`, false);
  }
  return value;
}

function normalizeStaleAfterMinutes(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 24 * 60) {
    throw new FabricError("INVALID_INPUT", "staleAfterMinutes must be an integer between 1 and 1440", false);
  }
  return value;
}

function normalizeEventLimit(value: number): number {
  const max = maxQueueEventLimit();
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new FabricError("INVALID_INPUT", `maxEventsPerLane must be an integer between 1 and ${max}`, false);
  }
  return value;
}

function normalizeManagerSummaryLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new FabricError("INVALID_INPUT", "managerSummaryLimit must be an integer between 1 and 100", false);
  }
  return value;
}

function normalizeValue(value: string, allowed: Set<string>, field: string): string {
  if (allowed.has(value)) return value;
  throw new FabricError("INVALID_INPUT", `${field} must be one of: ${[...allowed].join(", ")}`, false);
}

function optionalNormalized(input: unknown, field: string, allowed: Set<string>): string | undefined {
  const value = getOptionalString(input, field);
  return value ? normalizeValue(value, allowed, field) : undefined;
}

function optionalStringArrayInput(input: unknown, field: string): string[] | undefined {
  const value = getField(input, field);
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new FabricError("INVALID_INPUT", `Expected optional string array field: ${field}`, false);
  }
  return value;
}

function validateDependencyPatch(taskId: string, dependsOn: string[], tasks: ProjectQueueTaskRow[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const uniqueDependsOn = new Set<string>();
  for (const dependency of dependsOn) {
    if (dependency === taskId) {
      throw new FabricError("PROJECT_QUEUE_DEPENDENCY_CYCLE", `Task ${taskId} cannot depend on itself`, false);
    }
    if (uniqueDependsOn.has(dependency)) continue;
    uniqueDependsOn.add(dependency);
    if (!byId.has(dependency)) {
      throw new FabricError("PROJECT_QUEUE_DEPENDENCY_NOT_FOUND", `Dependency not found in queue: ${dependency}`, false);
    }
  }

  const dependencyMap = new Map(
    tasks.map((task) => [
      task.id,
      safeJsonArray(task.depends_on_json).filter((dependency): dependency is string => typeof dependency === "string")
    ])
  );
  dependencyMap.set(taskId, [...uniqueDependsOn]);

  const visited = new Set<string>();
  const visitDependency = (current: string, path: string[]): void => {
    if (current === taskId) {
      throw new FabricError("PROJECT_QUEUE_DEPENDENCY_CYCLE", `Dependency cycle detected: ${[taskId, ...path].join(" -> ")}`, false);
    }
    if (visited.has(current)) return;
    visited.add(current);
    for (const dependency of dependencyMap.get(current) ?? []) {
      if (!byId.has(dependency)) continue;
      visitDependency(dependency, [...path, dependency]);
    }
  };

  for (const dependency of uniqueDependsOn) {
    visitDependency(dependency, [dependency]);
  }
}

function taskMetadataSnapshot(task: ProjectQueueTaskRow): Record<string, unknown> {
  return {
	    title: task.title,
	    goal: task.goal,
	    phase: task.phase ?? undefined,
	    managerId: task.manager_id ?? undefined,
	    parentManagerId: task.parent_manager_id ?? undefined,
	    parentQueueId: task.parent_queue_id ?? undefined,
	    workstream: task.workstream ?? undefined,
	    costCenter: task.cost_center ?? undefined,
	    escalationTarget: task.escalation_target ?? undefined,
	    category: task.category,
    priority: task.priority,
    parallelGroup: task.parallel_group ?? undefined,
    parallelSafe: task.parallel_safe === 1,
    risk: task.risk,
    expectedFiles: safeJsonArray(task.expected_files_json),
    acceptanceCriteria: safeJsonArray(task.acceptance_criteria_json),
    requiredTools: safeJsonArray(task.required_tools_json),
    requiredMcpServers: safeJsonArray(task.required_mcp_servers_json),
    requiredMemories: safeJsonArray(task.required_memories_json),
    requiredContextRefs: safeJsonArray(task.required_context_refs_json),
    dependsOn: safeJsonArray(task.depends_on_json)
  };
}

function workerRunMetadataForTask(inputMetadata: Record<string, unknown>, task: ProjectQueueTaskRow): Record<string, unknown> {
  const orchestration = {
    ...asRecord(inputMetadata.orchestration),
    phase: task.phase ?? undefined,
    managerId: task.manager_id ?? undefined,
    parentManagerId: task.parent_manager_id ?? undefined,
    parentQueueId: task.parent_queue_id ?? undefined,
    workstream: task.workstream ?? task.parallel_group ?? task.phase ?? undefined,
    costCenter: task.cost_center ?? undefined,
    escalationTarget: task.escalation_target ?? undefined,
    category: task.category,
    priority: task.priority,
    risk: task.risk
  };
  return {
    ...inputMetadata,
    managerId: inputMetadata.managerId ?? task.manager_id ?? undefined,
    parentManagerId: inputMetadata.parentManagerId ?? task.parent_manager_id ?? undefined,
    parentQueueId: inputMetadata.parentQueueId ?? task.parent_queue_id ?? undefined,
    workstream: inputMetadata.workstream ?? task.workstream ?? task.parallel_group ?? task.phase ?? undefined,
    costCenter: inputMetadata.costCenter ?? task.cost_center ?? undefined,
    escalationTarget: inputMetadata.escalationTarget ?? task.escalation_target ?? undefined,
    costRole: inputMetadata.costRole ?? (task.category.includes("manager") ? "manager" : undefined),
    orchestration
  };
}

function toWorkerPriority(priority: string): string {
  if (WORKER_PRIORITIES.has(priority)) return priority;
  return "high";
}

function queueStatusForStage(stage: string, status: string, current: string): string {
  if (!STAGE_STATUSES.has(status)) return current;
  if (stage === "prompt_improvement" && status === "needs_review") return "prompt_review";
  if (stage === "planning" && ["running", "completed", "needs_review"].includes(status)) return status === "running" ? "planning" : "plan_review";
  if (["phasing", "task_writing", "queue_shaping"].includes(stage) && ["completed", "needs_review"].includes(status)) return "queue_review";
  if (stage === "execution" && status === "running") return "running";
  if (stage === "execution" && status === "completed") return "completed";
  return current;
}

function queueStatusForDecision(decision: string, current: string): string {
  if (decision === "accept_improved_prompt" || decision === "request_plan_revision") return "planning";
  if (decision === "request_prompt_revision") return "prompt_review";
  if (decision === "accept_plan" || decision === "approve_queue") return "queue_review";
  if (decision === "start_execution" || decision === "resume") return "running";
  if (decision === "pause") return "paused";
  if (decision === "cancel") return "canceled";
  if (decision === "complete") return "completed";
  return current;
}

function proposalStatusForDecision(decision: string): string {
  if (decision === "approve") return "approved";
  if (decision === "reject") return "rejected";
  return "revision_requested";
}

function requireQueue(host: SurfaceHost, queueId: string, workspaceRoot: string): ProjectQueueRow {
  const row = host.db.db.prepare("SELECT * FROM project_queues WHERE id = ?").get(queueId) as ProjectQueueRow | undefined;
  if (!row) {
    throw new FabricError("PROJECT_QUEUE_NOT_FOUND", `Project queue not found: ${queueId}`, false);
  }
  if (queueVisibleToWorkspace(row, workspaceRoot)) return row;
  throw new FabricError(
    "PROJECT_QUEUE_NOT_FOUND",
    [
      `Project queue not found from workspace ${workspaceRoot}: ${queueId}.`,
      `The queue exists for workspace ${row.workspace_root} and project ${row.project_path}.`,
      `Re-run from that project or pass --project ${row.project_path}.`
    ].join(" "),
    false
  );
}

function queueVisibleToWorkspace(queue: ProjectQueueRow, workspaceRoot: string): boolean {
  return samePath(queue.workspace_root, workspaceRoot) || samePath(queue.project_path, workspaceRoot);
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function requireQueueTask(host: SurfaceHost, queueId: string, queueTaskId: string): ProjectQueueTaskRow {
  const row = host.db.db.prepare("SELECT * FROM project_queue_tasks WHERE id = ? AND queue_id = ?").get(queueTaskId, queueId) as
    | ProjectQueueTaskRow
    | undefined;
  if (!row) {
    throw new FabricError("PROJECT_QUEUE_TASK_NOT_FOUND", `Project queue task not found: ${queueTaskId}`, false);
  }
  return row;
}

function childContext(context: CallContext, suffix: string): CallContext {
  return { ...context, idempotencyKey: context.idempotencyKey ? `${context.idempotencyKey}:${suffix}` : suffix };
}

function requireFabricTask(host: SurfaceHost, taskId: string, workspaceRoot: string): void {
  const row = host.db.db.prepare("SELECT id, workspace_root FROM tasks WHERE id = ?").get(taskId) as { id: string; workspace_root: string } | undefined;
  if (!row || row.workspace_root !== workspaceRoot) {
    throw new FabricError("FABRIC_TASK_NOT_FOUND", `Task not found: ${taskId}`, false);
  }
}

function requireWorkerRunForFabricTask(host: SurfaceHost, workerRunId: string, fabricTaskId: string | null): void {
  if (!fabricTaskId) {
    throw new FabricError("FABRIC_TASK_NOT_FOUND", "Queue task has no linked fabric task", false);
  }
  const row = host.db.db.prepare("SELECT id FROM worker_runs WHERE id = ? AND task_id = ?").get(workerRunId, fabricTaskId) as
    | { id: string }
    | undefined;
  if (!row) {
    throw new FabricError("FABRIC_WORKER_RUN_NOT_FOUND", `Worker run not found: ${workerRunId}`, false);
  }
}

function requireProposal(host: SurfaceHost, proposalId: string): ToolContextProposalRow {
  const row = host.db.db.prepare("SELECT * FROM tool_context_proposals WHERE id = ?").get(proposalId) as ToolContextProposalRow | undefined;
  if (!row) {
    throw new FabricError("TOOL_CONTEXT_PROPOSAL_NOT_FOUND", `Tool/context proposal not found: ${proposalId}`, false);
  }
  return row;
}

function taskRows(host: SurfaceHost, queueId: string): ProjectQueueTaskRow[] {
  return host.db.db.prepare("SELECT * FROM project_queue_tasks WHERE queue_id = ? ORDER BY ts_created ASC").all(queueId) as ProjectQueueTaskRow[];
}

function workerEventRows(host: SurfaceHost, taskId: string, workerRunId: string, limit: number): WorkerEventRow[] {
  return host.db.db
    .prepare("SELECT * FROM worker_events WHERE task_id = ? AND worker_run_id = ? ORDER BY ts DESC LIMIT ?")
    .all(taskId, workerRunId, limit) as WorkerEventRow[];
}

function latestWorkerCheckpoint(host: SurfaceHost, taskId: string, workerRunId: string): WorkerCheckpointRow | undefined {
  return host.db.db
    .prepare("SELECT * FROM worker_checkpoints WHERE task_id = ? AND worker_run_id = ? ORDER BY ts DESC LIMIT 1")
    .get(taskId, workerRunId) as WorkerCheckpointRow | undefined;
}

function pendingModelApprovalRows(
  host: SurfaceHost,
  queueId: string,
  workspaceRoot: string,
  includeExpired: boolean,
  limit: number,
  nowIso: string
): ApprovalRequestWithPreflightRow[] {
  const taskPattern = `%"queueId":"${queueId}"%`;
  return host.db.db
    .prepare(
      `SELECT a.*, p.budget_scope, p.task_json
       FROM approval_requests a
       JOIN llm_preflight_requests p ON p.id = a.preflight_request_id
       WHERE a.workspace_root = ?
         AND a.status = 'pending'
         AND (? = 1 OR a.expires_at > ?)
         AND (p.budget_scope = ? OR p.task_json LIKE ?)
       ORDER BY a.ts_created ASC
       LIMIT ?`
    )
    .all(workspaceRoot, includeExpired ? 1 : 0, nowIso, `project_queue:${queueId}`, taskPattern, limit) as ApprovalRequestWithPreflightRow[];
}

function modelApprovalRows(host: SurfaceHost, queueId: string, workspaceRoot: string, limit: number): ApprovalRequestWithPreflightRow[] {
  const taskPattern = `%"queueId":"${queueId}"%`;
  return host.db.db
    .prepare(
      `SELECT a.*, p.budget_scope, p.task_json
       FROM approval_requests a
       JOIN llm_preflight_requests p ON p.id = a.preflight_request_id
       WHERE a.workspace_root = ?
         AND (p.budget_scope = ? OR p.task_json LIKE ?)
       ORDER BY COALESCE(a.decided_at, a.ts_created) DESC
       LIMIT ?`
    )
    .all(workspaceRoot, `project_queue:${queueId}`, taskPattern, limit) as ApprovalRequestWithPreflightRow[];
}

function queuePreflightRows(host: SurfaceHost, queueId: string, workspaceRoot: string): QueuePreflightRow[] {
  const taskPattern = `%"queueId":"${queueId}"%`;
  return host.db.db
    .prepare(
      `SELECT decision, risk, estimated_cost_usd
       FROM llm_preflight_requests
       WHERE workspace_root = ?
         AND (budget_scope = ? OR task_json LIKE ?)
       ORDER BY ts ASC`
    )
    .all(workspaceRoot, `project_queue:${queueId}`, taskPattern) as QueuePreflightRow[];
}

function queueWorkerCostAttributions(host: SurfaceHost, queueId: string): QueueWorkerCostAttribution[] {
  const rows = host.db.db
    .prepare(
      `SELECT e.cost_usd, e.metadata_json, wr.worker, wr.metadata_json AS worker_metadata_json, t.category
       FROM worker_events e
       JOIN worker_runs wr ON wr.id = e.worker_run_id
       JOIN project_queue_tasks t ON t.fabric_task_id = e.task_id
       WHERE t.queue_id = ?
       ORDER BY e.ts ASC`
    )
    .all(queueId) as Array<{
    cost_usd: number | null;
    metadata_json: string;
    worker: string | null;
    worker_metadata_json: string;
    category: string | null;
  }>;
  const attributions: QueueWorkerCostAttribution[] = [];
  for (const row of rows) {
    const eventMetadata = safeJsonRecord(row.metadata_json);
    const workerMetadata = safeJsonRecord(row.worker_metadata_json);
    const costUsd = row.cost_usd ?? costFromWorkerEventMetadata(eventMetadata);
    if (costUsd === undefined || costUsd <= 0) continue;
    attributions.push({
      role: costRoleFromMetadata(workerMetadata, row.category, row.worker),
      costUsd
    });
  }
  return attributions;
}

function queueWorkerEventRows(host: SurfaceHost, queueId: string, limit: number): QueueWorkerEventRow[] {
  return host.db.db
    .prepare(
      `SELECT
         e.*,
         t.id AS queue_task_id,
         t.title AS queue_task_title,
         t.status AS queue_task_status,
         wr.worker AS worker,
         wr.status AS worker_status
       FROM worker_events e
       JOIN project_queue_tasks t ON t.fabric_task_id = e.task_id
       LEFT JOIN worker_runs wr ON wr.id = e.worker_run_id
       WHERE t.queue_id = ?
       ORDER BY e.ts DESC
       LIMIT ?`
    )
    .all(queueId, limit) as QueueWorkerEventRow[];
}

function workerRunRowsForFabricTask(host: SurfaceHost, fabricTaskId: string): WorkerRunRow[] {
  return host.db.db
    .prepare("SELECT * FROM worker_runs WHERE task_id = ? ORDER BY ts_updated DESC, ts_started DESC")
    .all(fabricTaskId) as WorkerRunRow[];
}

function toolContextProposalRowsForTask(host: SurfaceHost, queueId: string, task: ProjectQueueTaskRow): ToolContextProposalRow[] {
  if (task.fabric_task_id) {
    return host.db.db
      .prepare(
        `SELECT * FROM tool_context_proposals
         WHERE queue_id = ? AND (queue_task_id = ? OR fabric_task_id = ?)
         ORDER BY ts_updated DESC, ts_created DESC`
      )
      .all(queueId, task.id, task.fabric_task_id) as ToolContextProposalRow[];
  }
  return host.db.db
    .prepare(
      `SELECT * FROM tool_context_proposals
       WHERE queue_id = ? AND queue_task_id = ?
       ORDER BY ts_updated DESC, ts_created DESC`
    )
    .all(queueId, task.id) as ToolContextProposalRow[];
}

function taskModelApprovalRows(
  host: SurfaceHost,
  queue: ProjectQueueRow,
  task: ProjectQueueTaskRow,
  workspaceRoot: string,
  limit: number
): ApprovalRequestWithPreflightRow[] {
  const filters = ["p.budget_scope = ?", "p.task_json LIKE ?"];
  const params: Array<string | number> = [workspaceRoot, `project_queue_task:${task.id}`, `%"queueTaskId":"${task.id}"%`];
  if (task.fabric_task_id) {
    filters.push("p.budget_scope = ?", "p.task_json LIKE ?");
    params.push(`fabric_task:${task.fabric_task_id}`, `%"fabricTaskId":"${task.fabric_task_id}"%`);
  }
  filters.push("p.task_json LIKE ?");
  params.push(`%"queueId":"${queue.id}"%"queueTaskId":"${task.id}"%`);
  params.push(limit);
  return host.db.db
    .prepare(
      `SELECT a.*, p.budget_scope, p.task_json
       FROM approval_requests a
       JOIN llm_preflight_requests p ON p.id = a.preflight_request_id
       WHERE a.workspace_root = ?
         AND (${filters.join(" OR ")})
       ORDER BY COALESCE(a.decided_at, a.ts_created) DESC
       LIMIT ?`
    )
    .all(...params) as ApprovalRequestWithPreflightRow[];
}

function staleWorkerRows(host: SurfaceHost, queueId: string, cutoffIso: string, nowMs: number): StaleWorkerRow[] {
  const rows = host.db.db
    .prepare(
      `SELECT
         t.*,
         wr.id AS worker_run_id,
         wr.status AS worker_status,
         wr.ts_started AS worker_ts_started,
         wr.ts_updated AS worker_ts_updated,
         wr.max_runtime_minutes AS worker_max_runtime_minutes
       FROM project_queue_tasks t
       LEFT JOIN worker_runs wr ON wr.id = t.assigned_worker_run_id
       WHERE t.queue_id = ?
         AND t.status = 'running'
       ORDER BY t.ts_updated ASC`
    )
    .all(queueId) as Array<ProjectQueueTaskRow & {
    worker_run_id: string | null;
    worker_status: string | null;
    worker_ts_started: string | null;
    worker_ts_updated: string | null;
    worker_max_runtime_minutes: number | null;
  }>;
  return rows
    .map((row) => ({ ...row, stale_reason: staleReason(row, cutoffIso, nowMs) }))
    .filter((row): row is StaleWorkerRow => Boolean(row.stale_reason));
}

function staleReason(
  row: {
    worker_run_id: string | null;
    worker_status: string | null;
    worker_ts_started: string | null;
    worker_ts_updated: string | null;
    worker_max_runtime_minutes: number | null;
  },
  cutoffIso: string,
  nowMs: number
): string {
  if (!row.worker_run_id) return "missing worker run";
  if (row.worker_status && row.worker_status !== "running") return `worker status is ${row.worker_status}`;
  if (row.worker_ts_updated && parseDbTimestamp(row.worker_ts_updated) <= parseDbTimestamp(cutoffIso)) return "worker heartbeat stale";
  if (
    row.worker_max_runtime_minutes &&
    row.worker_ts_started &&
    parseDbTimestamp(row.worker_ts_started) + row.worker_max_runtime_minutes * 60_000 <= nowMs
  ) {
    return "worker exceeded max runtime";
  }
  return "";
}

function queueExecutionBlockReason(status: string): string | undefined {
  if (!EXECUTION_BLOCKED_QUEUE_STATUSES.has(status)) return undefined;
  return `queue is ${status}`;
}

function queueWorkerStartBlockReason(status: string): string | undefined {
  if (WORKER_START_OPEN_QUEUE_STATUSES.has(status)) return undefined;
  if (status === "queue_review") return "queue is waiting for start_execution";
  if (status === "prompt_review") return "queue is waiting for prompt approval";
  if (status === "planning") return "queue is still planning";
  if (status === "plan_review") return "queue is waiting for plan approval";
  if (status === "created") return "queue has not reached execution";
  return queueExecutionBlockReason(status) ?? `queue is ${status}`;
}

function defaultWorkerWorkspacePath(projectPath: string, queueTaskId: string, mode: string): string {
  if (mode === "in_place") return projectPath;
  return `${projectPath}.worktrees/${queueTaskId}`;
}

function defaultWorkerCommand(worker: string, fabricTaskId: string): string[] {
  if (worker === "manual") return [];
  if (worker === "aider") return ["aider", "--message", `Work on fabric task ${fabricTaskId}`];
  if (worker === "deepseek-direct") return ["agent-fabric-deepseek-worker", "run-task", "--fabric-task", fabricTaskId];
  if (worker === "jcode-deepseek") return [jcodeDeepSeekDispatcherPath(), "<task-packet>"];
  return [worker, "run", "--fabric-task", fabricTaskId];
}

function jcodeDeepSeekDispatcherPath(): string {
  const configured = process.env.AGENT_FABRIC_JCODE_DEEPSEEK_DISPATCHER?.trim();
  return configured || "agent-fabric-jcode-deepseek-worker";
}

function queueBlockedEntries(tasks: ProjectQueueTaskRow[], reason: string): Array<{ task: ProjectQueueTaskRow; reasons: string[] }> {
  return tasks
    .filter((task) => !DEPENDENCY_DONE.has(task.status) && task.status !== "failed" && task.status !== "canceled")
    .map((task) => ({ task, reasons: [reason] }));
}

function parseDbTimestamp(value: string): number {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return Date.parse(`${value.replace(" ", "T")}Z`);
  }
  return Date.parse(value);
}

function createClaimToolContextProposal(
  host: SurfaceHost,
  queue: ProjectQueueRow,
  task: ProjectQueueTaskRow,
  session: { id: string; agent_id: string; host_name: string | null; test_mode: 0 | 1 },
  context: CallContext
): { proposalId: string; approvalRequired: boolean; missingGrants: MissingGrant[] } | undefined {
  const prepared = ensureTaskToolContextProposal(host, queue, task, session, context, "project_queue_claim_next");
  if (!prepared.proposal) return undefined;
  return { proposalId: prepared.proposal.id, approvalRequired: prepared.approvalRequired, missingGrants: prepared.missingGrants };
}

function launchPlanEntry(
  host: SurfaceHost,
  queue: ProjectQueueRow,
  task: ProjectQueueTaskRow,
  workspaceRoot: string,
  workerStartBlock: string | undefined
): Record<string, unknown> {
  const readiness = taskToolContextLaunchReadiness(host, queue, task);
  const linkIssues = linkIssuesForTask(host, queue, task);
  const contextRefIssues = contextRefIssuesForTask(queue, task);
  const linkBlocked = linkIssues.some((issue) => issue.severity === "error");
  const contextBlocked = contextRefIssues.some((issue) => issue.severity === "error");
  const workerStartBlocked = !readiness.approvalRequired && !linkBlocked && !contextBlocked && Boolean(workerStartBlock);
  const launchBlockedReason = readiness.approvalRequired
    ? "tool_context_approval_required"
    : linkBlocked
      ? "fabric_task_link_missing"
      : contextBlocked
        ? "context_ref_missing"
        : workerStartBlock;
  return {
    task: formatQueueTask(task),
    toolContextProposal: readiness.proposal ? formatProposal(readiness.proposal) : undefined,
    approvalRequired: readiness.approvalRequired,
    readyToLaunch: !readiness.approvalRequired && !linkBlocked && !contextBlocked && !workerStartBlock,
    workerStartBlocked,
    launchBlockedReason,
    linkIssues,
    contextRefIssues,
    noContextRequired: readiness.noContextRequired,
    needsProposal: readiness.needsProposal,
    missingGrants: readiness.missingGrants,
    memorySuggestions: taskMemorySuggestions(host, workspaceRoot, task, 3)
  };
}

function linkIssuesForTasks(host: SurfaceHost, queue: ProjectQueueRow, tasks: ProjectQueueTaskRow[]): Array<Record<string, unknown>> {
  return tasks.flatMap((task) => linkIssuesForTask(host, queue, task));
}

function linkIssuesForTask(host: SurfaceHost, queue: ProjectQueueRow, task: ProjectQueueTaskRow): Array<Record<string, unknown>> {
  if (!task.fabric_task_id) {
    return [
      {
        type: "missing_fabric_task_id",
        severity: "error",
        queueId: queue.id,
        queueTaskId: task.id,
        title: task.title
      }
    ];
  }
  const row = host.db.db
    .prepare("SELECT id, workspace_root, project_path FROM tasks WHERE id = ?")
    .get(task.fabric_task_id) as { id: string; workspace_root: string; project_path: string | null } | undefined;
  if (!row) {
    return [
      {
        type: "orphaned_fabric_task",
        severity: "error",
        queueId: queue.id,
        queueTaskId: task.id,
        fabricTaskId: task.fabric_task_id,
        title: task.title
      }
    ];
  }
  return [];
}

function contextRefIssuesForTasks(queue: ProjectQueueRow, tasks: ProjectQueueTaskRow[]): Array<Record<string, unknown>> {
  return tasks.flatMap((task) => contextRefIssuesForTask(queue, task));
}

function contextRefIssuesForTask(queue: ProjectQueueRow, task: ProjectQueueTaskRow): Array<Record<string, unknown>> {
  const issues: Array<Record<string, unknown>> = [];
  for (const value of safeJsonArray(task.required_context_refs_json)) {
    if (typeof value !== "string") continue;
    const path = contextRefPathForValidation(queue.project_path, value);
    if (!path) continue;
    if (!existsSync(path)) {
      issues.push({
        type: "context_ref_missing",
        severity: "error",
        queueId: queue.id,
        queueTaskId: task.id,
        fabricTaskId: task.fabric_task_id ?? undefined,
        title: task.title,
        ref: value,
        path
      });
    }
  }
  return issues;
}

function contextRefPathForValidation(projectPath: string, ref: string): string | undefined {
  const trimmed = ref.trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return undefined;
  if (/[*?\[\]{}]/.test(trimmed) || trimmed.includes("\0")) return undefined;
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(projectPath, trimmed);
}

function taskToolContextLaunchReadiness(
  host: SurfaceHost,
  queue: ProjectQueueRow,
  task: ProjectQueueTaskRow
): { proposal?: ToolContextProposalRow; approvalRequired: boolean; noContextRequired: boolean; needsProposal: boolean; missingGrants: MissingGrant[] } {
  const mcpServers = safeJsonArray(task.required_mcp_servers_json);
  const tools = safeJsonArray(task.required_tools_json);
  const memories = safeJsonArray(task.required_memories_json);
  const contextRefs = safeJsonArray(task.required_context_refs_json);
  if (mcpServers.length === 0 && tools.length === 0 && memories.length === 0 && contextRefs.length === 0) {
    return { approvalRequired: false, noContextRequired: true, needsProposal: false, missingGrants: [] };
  }
  const grants = [
    ...mcpServers.map((value) => grant("mcp_server", value)),
    ...tools.map((value) => grant("tool", value)),
    ...memories.map((value) => grant("memory", value)),
    ...contextRefs.map((value) => grant("context", value))
  ];
  const policyStatuses = policyGrantStatuses(host, queue);
  const missingGrants = grants
    .filter((entry) => policyStatuses.get(entry.grantKey) !== "approved")
    .map((entry) => ({ ...entry, policyStatus: policyStatuses.get(entry.grantKey) ?? "missing" }));
  const proposal = matchingTaskToolContextProposal(host, queue.id, task.id, mcpServers, tools, memories, contextRefs);
  if (proposal?.status === "approved") {
    return { proposal, approvalRequired: false, noContextRequired: false, needsProposal: false, missingGrants: [] };
  }
  const safetyWarnings = proposal ? safeJsonArray(proposal.safety_warnings_json) : [];
  return {
    proposal,
    approvalRequired: missingGrants.length > 0 || safetyWarnings.length > 0,
    noContextRequired: false,
    needsProposal: !proposal && missingGrants.length > 0,
    missingGrants
  };
}

function ensureTaskToolContextProposal(
  host: SurfaceHost,
  queue: ProjectQueueRow,
  task: ProjectQueueTaskRow,
  session: { id: string; agent_id: string; host_name: string | null; test_mode: 0 | 1 },
  context: CallContext,
  source: string
): { proposal?: ToolContextProposalRow; approvalRequired: boolean; missingGrants: MissingGrant[]; reused: boolean } {
  const mcpServers = safeJsonArray(task.required_mcp_servers_json);
  const tools = safeJsonArray(task.required_tools_json);
  const memories = safeJsonArray(task.required_memories_json);
  const contextRefs = safeJsonArray(task.required_context_refs_json);
  if (mcpServers.length === 0 && tools.length === 0 && memories.length === 0 && contextRefs.length === 0) {
    return { approvalRequired: false, missingGrants: [], reused: false };
  }
  const grants = [
    ...mcpServers.map((value) => grant("mcp_server", value)),
    ...tools.map((value) => grant("tool", value)),
    ...memories.map((value) => grant("memory", value)),
    ...contextRefs.map((value) => grant("context", value))
  ];
  const policyStatuses = policyGrantStatuses(host, queue);
  const missingGrants = grants
    .filter((entry) => policyStatuses.get(entry.grantKey) !== "approved")
    .map((entry) => ({ ...entry, policyStatus: policyStatuses.get(entry.grantKey) ?? "missing" }));
  const approvalRequired = missingGrants.length > 0;
  const reusable = matchingTaskToolContextProposal(host, queue.id, task.id, mcpServers, tools, memories, contextRefs);
  if (reusable?.status === "proposed") {
    host.db.db
      .prepare("UPDATE tool_context_proposals SET approval_required = ?, missing_grants_json = ?, ts_updated = CURRENT_TIMESTAMP WHERE id = ?")
      .run(approvalRequired ? 1 : 0, JSON.stringify(missingGrants), reusable.id);
    return { proposal: requireProposal(host, reusable.id), approvalRequired, missingGrants, reused: true };
  }
  if (reusable?.status === "approved") {
    return { proposal: reusable, approvalRequired: false, missingGrants: [], reused: true };
  }

  const proposalId = newId("tcprop");
  host.db.db
    .prepare(
      `INSERT INTO tool_context_proposals (
        id, queue_id, queue_task_id, fabric_task_id, status, mcp_servers_json,
        tools_json, memories_json, context_refs_json, model_alias, reasoning,
        safety_warnings_json, approval_required, missing_grants_json, session_id,
        agent_id, origin_peer_id, test_mode
      ) VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      proposalId,
      queue.id,
      task.id,
      task.fabric_task_id,
      JSON.stringify(mcpServers),
      JSON.stringify(tools),
      JSON.stringify(memories),
      JSON.stringify(contextRefs),
      "tool.context.manager",
      `Prepare least-necessary tools and context before claiming ${task.id}.`,
      approvalRequired ? 1 : 0,
      JSON.stringify(missingGrants),
      session.id,
      session.agent_id,
      host.originPeerId,
      session.test_mode
    );
  host.writeAuditAndEvent({
    sessionId: session.id,
    agentId: session.agent_id,
    hostName: session.host_name,
    workspaceRoot: queue.workspace_root,
    action: "tool.context.proposed",
    sourceTable: "tool_context_proposals",
    sourceId: proposalId,
    eventType: "tool.context.proposed",
    payload: { queueId: queue.id, queueTaskId: task.id, fabricTaskId: task.fabric_task_id, approvalRequired, missingGrants, source },
    testMode: session.test_mode === 1,
    context
  });
  return { proposal: requireProposal(host, proposalId), approvalRequired, missingGrants, reused: false };
}

function matchingTaskToolContextProposal(
  host: SurfaceHost,
  queueId: string,
  queueTaskId: string,
  mcpServers: unknown[],
  tools: unknown[],
  memories: unknown[],
  contextRefs: unknown[]
): ToolContextProposalRow | undefined {
  const rows = host.db.db
    .prepare(
      `SELECT * FROM tool_context_proposals
       WHERE queue_id = ? AND queue_task_id = ? AND status IN ('proposed', 'approved')
       ORDER BY ts_updated DESC, ts_created DESC`
    )
    .all(queueId, queueTaskId) as ToolContextProposalRow[];
  return rows.find(
    (row) =>
      jsonArraysEqual(row.mcp_servers_json, mcpServers) &&
      jsonArraysEqual(row.tools_json, tools) &&
      jsonArraysEqual(row.memories_json, memories) &&
      jsonArraysEqual(row.context_refs_json, contextRefs)
  );
}

function jsonArraysEqual(stored: string, expected: unknown[]): boolean {
  return JSON.stringify(safeJsonArray(stored)) === JSON.stringify(expected);
}

function rejectSetAndPatch(setValue: string[] | undefined, addValue: string[] | undefined, removeValue: string[] | undefined, setField: string): void {
  if (setValue !== undefined && (addValue !== undefined || removeValue !== undefined)) {
    throw new FabricError("INVALID_INPUT", `Pass either ${setField} or additive/removal patch fields, not both`, false);
  }
}

function nextSetAddRemove(stored: string, setValue?: string[], addValue?: string[], removeValue?: string[]): string[] {
  if (setValue !== undefined) return setValue;
  const current = safeJsonArray(stored).filter((value): value is string => typeof value === "string");
  const added = addValue && addValue.length > 0 ? [...new Set([...current, ...addValue])] : current;
  if (!removeValue || removeValue.length === 0) return added;
  const removed = new Set(removeValue);
  return added.filter((value) => !removed.has(value));
}

function parseRewriteSpecs(values: string[], field: string): Array<{ oldRef: string; newRef: string }> {
  return values.map((value) => {
    const index = value.indexOf("=");
    if (index <= 0 || index === value.length - 1) {
      throw new FabricError("INVALID_INPUT", `${field} entries must use old=new`, false);
    }
    return { oldRef: value.slice(0, index), newRef: value.slice(index + 1) };
  });
}

function applyRewriteSpecs(values: string[], rewrites: Array<{ oldRef: string; newRef: string }>): string[] {
  if (rewrites.length === 0) return values;
  const rewriteMap = new Map(rewrites.map((entry) => [entry.oldRef, entry.newRef]));
  return values.map((value) => rewriteMap.get(value) ?? value).filter((value, index, all) => all.indexOf(value) === index);
}

function markPendingTaskToolContextProposalsForRevision(
  host: SurfaceHost,
  queue: ProjectQueueRow,
  task: ProjectQueueTaskRow,
  session: { id: string; agent_id: string; host_name: string | null; test_mode: 0 | 1 },
  context: CallContext,
  reason: string
): string[] {
  const rows = host.db.db
    .prepare(
      `SELECT id FROM tool_context_proposals
       WHERE queue_id = ? AND queue_task_id = ? AND status = 'proposed'
       ORDER BY ts_created ASC`
    )
    .all(queue.id, task.id) as Array<{ id: string }>;
  if (rows.length === 0) return [];

  const proposalIds = rows.map((row) => row.id);
  host.db.db
    .prepare(
      `UPDATE tool_context_proposals
       SET status = 'revision_requested',
           decision = 'revise',
           decision_note = ?,
           decided_by_session_id = ?,
           decided_by_agent_id = ?,
           ts_decided = CURRENT_TIMESTAMP,
           ts_updated = CURRENT_TIMESTAMP
       WHERE id IN (${proposalIds.map(() => "?").join(", ")})`
    )
    .run(reason, session.id, session.agent_id, ...proposalIds);
  host.writeAuditAndEvent({
    sessionId: session.id,
    agentId: session.agent_id,
    hostName: session.host_name,
    workspaceRoot: queue.workspace_root,
    action: "tool.context.proposals.revision_requested",
    sourceTable: "project_queue_tasks",
    sourceId: task.id,
    eventType: "tool.context.proposals.revision_requested",
    payload: {
      queueId: queue.id,
      queueTaskId: task.id,
      fabricTaskId: task.fabric_task_id,
      proposalIds,
      reason
    },
    testMode: session.test_mode === 1,
    context
  });
  return proposalIds;
}

function isTaskDependencyReady(task: ProjectQueueTaskRow, tasks: ProjectQueueTaskRow[]): boolean {
  const byId = new Map(tasks.map((entry) => [entry.id, entry]));
  return safeJsonArray(task.depends_on_json).every((dependency) => typeof dependency === "string" && DEPENDENCY_DONE.has(byId.get(dependency)?.status ?? ""));
}

function queueTaskReadiness(queue: ProjectQueueRow, task: ProjectQueueTaskRow, tasks: ProjectQueueTaskRow[]): Record<string, unknown> {
  const byId = new Map(tasks.map((entry) => [entry.id, entry]));
  const dependencyState = taskDependencyState(task, byId);
  const executionBlock = queueExecutionBlockReason(queue.status);
  const workerStartBlock = queueWorkerStartBlockReason(queue.status);
  if (executionBlock) {
    return {
      readyNow: false,
      state: "execution_blocked",
      executionBlocked: true,
      blockedReason: executionBlock,
      reasons: [executionBlock, ...dependencyState.reasons],
      blockers: dependencyState.blockers,
      dependenciesReady: dependencyState.ready
    };
  }
  if (!["queued", "ready"].includes(task.status)) {
    return {
      readyNow: false,
      state: task.status,
      reasons: [`task is ${task.status}`, ...dependencyState.reasons],
      blockers: dependencyState.blockers,
      dependenciesReady: dependencyState.ready
    };
  }
  if (!dependencyState.ready) {
    return {
      readyNow: false,
      state: "blocked",
      reasons: dependencyState.reasons,
      blockers: dependencyState.blockers,
      dependenciesReady: false
    };
  }
  if (workerStartBlock) {
    return {
      readyNow: false,
      state: "worker_start_blocked",
      workerStartBlocked: true,
      workerStartBlockedReason: workerStartBlock,
      reasons: [workerStartBlock],
      blockers: [],
      dependenciesReady: true
    };
  }
  const scheduled = selectSchedulableReadyTasks([task], tasks, 1);
  if (scheduled.ready.some((entry) => entry.id === task.id)) {
    return {
      readyNow: true,
      state: "ready",
      reasons: [],
      blockers: [],
      dependenciesReady: true
    };
  }
  const schedulingBlock = scheduled.blocked.find((entry) => entry.task.id === task.id);
  return {
    readyNow: false,
    state: "scheduler_blocked",
    reasons: schedulingBlock?.reasons ?? ["task is not schedulable now"],
    blockers: schedulingBlock?.blockers ?? [],
    dependenciesReady: true
  };
}

function analyzeReadiness(tasks: ProjectQueueTaskRow[]): {
  ready: ProjectQueueTaskRow[];
  blocked: BlockedEntry[];
} {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const ready: ProjectQueueTaskRow[] = [];
  const blocked: BlockedEntry[] = [];
  for (const task of tasks) {
    if (!["queued", "ready"].includes(task.status)) continue;
    const dependencyState = taskDependencyState(task, byId);
    if (dependencyState.ready) ready.push(task);
    else blocked.push({ task, reasons: dependencyState.reasons, blockers: dependencyState.blockers });
  }
  return { ready, blocked };
}

function taskDependencyState(
  task: ProjectQueueTaskRow,
  byId: Map<string, ProjectQueueTaskRow>
): { ready: boolean; reasons: string[]; blockers: Array<Record<string, unknown>> } {
  const reasons = [];
  const blockers: Array<Record<string, unknown>> = [];
  for (const dependency of safeJsonArray(task.depends_on_json)) {
    if (typeof dependency !== "string") continue;
    const dependencyTask = byId.get(dependency);
    if (!dependencyTask) {
      reasons.push(`missing dependency ${dependency}`);
      blockers.push({ queueTaskId: dependency, missing: true });
    } else if (!DEPENDENCY_DONE.has(dependencyTask.status)) {
      reasons.push(`waiting on ${dependencyTask.id} (${dependencyTask.status})`);
      blockers.push({
        queueTaskId: dependencyTask.id,
        fabricTaskId: dependencyTask.fabric_task_id ?? undefined,
        title: dependencyTask.title,
        status: dependencyTask.status,
        phase: dependencyTask.phase ?? undefined,
        risk: dependencyTask.risk
      });
    }
  }
  return { ready: reasons.length === 0, reasons, blockers };
}

function dependencyLinks(task: ProjectQueueTaskRow, byId: Map<string, ProjectQueueTaskRow>): Array<Record<string, unknown>> {
  return safeJsonArray(task.depends_on_json)
    .filter((dependency): dependency is string => typeof dependency === "string")
    .map((dependency) => {
      const dependencyTask = byId.get(dependency);
      if (!dependencyTask) return { queueTaskId: dependency, missing: true, satisfied: false };
      return {
        ...formatQueueTaskLink(dependencyTask),
        satisfied: DEPENDENCY_DONE.has(dependencyTask.status)
      };
    });
}

function dependentLinks(task: ProjectQueueTaskRow, tasks: ProjectQueueTaskRow[]): Array<Record<string, unknown>> {
  return tasks
    .filter((candidate) => safeJsonArray(candidate.depends_on_json).includes(task.id))
    .map((candidate) => ({
      ...formatQueueTaskLink(candidate),
      unblockedByCurrentTask: DEPENDENCY_DONE.has(task.status)
    }));
}

function selectSchedulableReadyTasks(
  candidates: ProjectQueueTaskRow[],
  tasks: ProjectQueueTaskRow[],
  limit: number
): {
  ready: ProjectQueueTaskRow[];
  blocked: BlockedEntry[];
} {
  if (limit <= 0) return { ready: [], blocked: [] };
  const active = tasks.filter((task) => ACTIVE_WORKER_STATUSES.has(task.status));
  const activeSerial = active.some((task) => task.parallel_safe === 0);
  if (activeSerial) {
    return {
      ready: [],
      blocked: candidates.map((task) => ({ task, reasons: ["serial task already running"] }))
    };
  }
  const activeBreakglass = active.some((task) => task.risk === "breakglass");
  if (activeBreakglass) {
    return {
      ready: [],
      blocked: candidates.map((task) => ({ task, reasons: ["breakglass task already running"] }))
    };
  }

  const activeGroups = new Set(active.map((task) => task.parallel_group).filter((group): group is string => typeof group === "string" && group.length > 0));
  const activeHighRisk = active.some((task) => task.risk === "high" || task.risk === "breakglass");
  const selectedGroups = new Set<string>();
  let selectedHighRisk = false;
  const ready: ProjectQueueTaskRow[] = [];
  const blocked: BlockedEntry[] = [];

  for (const task of candidates) {
    if (ready.length >= limit) break;
    if (task.parallel_safe === 0 || task.risk === "breakglass") {
      if (active.length > 0) {
        blocked.push({ task, reasons: [task.risk === "breakglass" ? "breakglass task waits for active workers" : "serial task waits for active workers"] });
        continue;
      }
      if (ready.length > 0) {
        blocked.push({ task, reasons: [task.risk === "breakglass" ? "breakglass task waits for selected ready work" : "serial task waits for selected ready work"] });
        continue;
      }
      ready.push(task);
      break;
    }

    if (task.risk === "high" && (activeHighRisk || selectedHighRisk)) {
      blocked.push({ task, reasons: [activeHighRisk ? "high-risk task already running" : "high-risk task already selected"] });
      continue;
    }

    if (task.parallel_group && activeGroups.has(task.parallel_group)) {
      blocked.push({ task, reasons: [`parallel group ${task.parallel_group} already running`] });
      continue;
    }
    if (task.parallel_group && selectedGroups.has(task.parallel_group)) {
      blocked.push({ task, reasons: [`parallel group ${task.parallel_group} already selected`] });
      continue;
    }

    ready.push(task);
    if (task.parallel_group) selectedGroups.add(task.parallel_group);
    if (task.risk === "high") selectedHighRisk = true;
  }

  return { ready, blocked };
}

function assertTaskSchedulable(task: ProjectQueueTaskRow, tasks: ProjectQueueTaskRow[]): void {
  const active = tasks.filter((entry) => entry.id !== task.id && ACTIVE_WORKER_STATUSES.has(entry.status));
  const activeSerial = active.find((entry) => entry.parallel_safe === 0);
  if (activeSerial) {
    throw new FabricError("PROJECT_QUEUE_PARALLEL_CONFLICT", `Task ${task.id} waits for serial task ${activeSerial.id}`, false);
  }
  const activeBreakglass = active.find((entry) => entry.risk === "breakglass");
  if (activeBreakglass) {
    throw new FabricError("PROJECT_QUEUE_RISK_CONFLICT", `Task ${task.id} waits for breakglass task ${activeBreakglass.id}`, false);
  }
  if (task.parallel_safe === 0 && active.length > 0) {
    throw new FabricError("PROJECT_QUEUE_PARALLEL_CONFLICT", `Serial task ${task.id} waits for active workers`, false);
  }
  if (task.risk === "breakglass" && active.length > 0) {
    throw new FabricError("PROJECT_QUEUE_RISK_CONFLICT", `Breakglass task ${task.id} waits for active workers`, false);
  }
  if (task.risk === "high" && active.some((entry) => entry.risk === "high" || entry.risk === "breakglass")) {
    throw new FabricError("PROJECT_QUEUE_RISK_CONFLICT", `High-risk task ${task.id} waits for active high-risk work`, false);
  }
  if (task.parallel_group) {
    const activeInGroup = active.find((entry) => entry.parallel_group === task.parallel_group);
    if (activeInGroup) {
      throw new FabricError("PROJECT_QUEUE_PARALLEL_CONFLICT", `Task ${task.id} waits for parallel group ${task.parallel_group}`, false);
    }
  }
}

function compareReadyTasks(a: ProjectQueueTaskRow, b: ProjectQueueTaskRow): number {
  const priorityRank: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  const riskRank: Record<string, number> = { low: 0, medium: 1, high: 2, breakglass: 3 };
  const priority = (priorityRank[a.priority] ?? 2) - (priorityRank[b.priority] ?? 2);
  if (priority !== 0) return priority;
  const risk = (riskRank[a.risk] ?? 1) - (riskRank[b.risk] ?? 1);
  if (risk !== 0) return risk;
  return a.ts_created.localeCompare(b.ts_created);
}

function updateLinkedFabricTask(host: SurfaceHost, fabricTaskId: string | null, status: string, summary: string | undefined, patchRefs: string[], testRefs: string[]): void {
  if (!fabricTaskId) return;
  const taskStatus = ["completed", "failed", "canceled", "patch_ready", "running"].includes(status) ? status : undefined;
  if (!taskStatus) return;
  const task = host.db.db.prepare("SELECT artifacts_json FROM tasks WHERE id = ?").get(fabricTaskId) as { artifacts_json: string } | undefined;
  if (!task) return;
  const artifacts = [
    ...safeJsonArray(task.artifacts_json),
    ...patchRefs.map((ref) => ({ kind: "patch", ref })),
    ...testRefs.map((ref) => ({ kind: "test", ref }))
  ];
  host.db.db
    .prepare(
      `UPDATE tasks
       SET status = ?, summary = COALESCE(?, summary), artifacts_json = ?, ts_updated = CURRENT_TIMESTAMP,
           finished_at = CASE WHEN ? IN ('completed', 'failed', 'canceled') THEN CURRENT_TIMESTAMP ELSE finished_at END
       WHERE id = ?`
    )
    .run(taskStatus, summary ?? null, JSON.stringify(artifacts), taskStatus, fabricTaskId);
}

function updateQueueCompletionStatus(host: SurfaceHost, queueId: string): void {
  const tasks = taskRows(host, queueId);
  if (tasks.length === 0) return;
  if (tasks.every((task) => DEPENDENCY_DONE.has(task.status))) {
    host.db.db.prepare("UPDATE project_queues SET status = 'completed', ts_updated = CURRENT_TIMESTAMP WHERE id = ?").run(queueId);
  } else {
    host.db.db.prepare("UPDATE project_queues SET ts_updated = CURRENT_TIMESTAMP WHERE id = ?").run(queueId);
  }
}

function statusCounts(tasks: ProjectQueueTaskRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
  }
  return counts;
}

function queueSummaryStrip(input: {
  queue: ProjectQueueRow;
  tasks: ProjectQueueTaskRow[];
  counts: Record<string, number>;
  activeWorkers: number;
  availableSlots: number;
  readyCount: number;
  blockedCount: number;
  pendingToolApprovals: number;
  pendingModelApprovals: number;
  staleRunningCount: number;
  preflights: QueuePreflightRow[];
  workerCosts: QueueWorkerCostAttribution[];
}): Record<string, unknown> {
  const reviewCount = (input.counts.review ?? 0) + (input.counts.patch_ready ?? 0);
  const doneCount = input.tasks.filter((task) => DEPENDENCY_DONE.has(task.status)).length;
  const failedCount = (input.counts.failed ?? 0) + (input.counts.canceled ?? 0);
  const pendingApprovalCount = input.pendingToolApprovals + input.pendingModelApprovals;
  const workerStartBlock = queueWorkerStartBlockReason(input.queue.status);
  const reasons: string[] = [];
  let status = "idle";
  let severity = "idle";
  let nextAction = "Add tasks or advance the pipeline.";

  if (input.queue.status === "paused") {
    status = "paused";
    severity = "attention";
    nextAction = "Resume the queue before starting more workers.";
    reasons.push("queue_paused");
  } else if (input.queue.status === "canceled") {
    status = "canceled";
    severity = "warning";
    nextAction = "Queue is canceled.";
    reasons.push("queue_canceled");
  } else if (input.queue.status === "completed") {
    status = "complete";
    severity = "ok";
    nextAction = "Queue is complete.";
  } else if (input.staleRunningCount > 0) {
    status = "needs_recovery";
    severity = "warning";
    nextAction = "Review stale workers and run stale recovery.";
    reasons.push("stale_running_tasks");
  } else if (pendingApprovalCount > 0) {
    status = "waiting_on_human";
    severity = "attention";
    nextAction = "Review the approval inbox.";
    reasons.push("pending_approvals");
  } else if (failedCount > 0) {
    status = "has_failures";
    severity = "warning";
    nextAction = "Review failed or canceled tasks.";
    reasons.push("failed_tasks");
  } else if (reviewCount > 0) {
    status = "review_ready";
    severity = "attention";
    nextAction = "Review patch-ready output.";
    reasons.push("reviewable_tasks");
  } else if (workerStartBlock && input.readyCount > 0) {
    status = "waiting_on_start";
    severity = "attention";
    nextAction = workerStartBlock === "queue is waiting for start_execution" ? "Record start_execution before launching workers." : "Advance the queue gate before launching workers.";
    reasons.push("worker_start_blocked");
  } else if (input.activeWorkers > 0) {
    status = "running";
    severity = "ok";
    nextAction = "Watch active worker lanes.";
  } else if (input.readyCount > 0) {
    status = "ready";
    severity = "ok";
    nextAction = "Claim the next ready task.";
  } else if (input.tasks.length > 0 && doneCount === input.tasks.length) {
    status = "complete";
    severity = "ok";
    nextAction = "Queue is complete.";
  } else if (input.blockedCount > 0) {
    status = "blocked";
    severity = "warning";
    nextAction = "Resolve blockers or complete dependencies.";
    reasons.push("blocked_tasks");
  }

  return {
    status,
    severity,
    nextAction,
    reasons,
    counts: {
      ready: input.readyCount,
      running: input.counts.running ?? 0,
      blocked: input.blockedCount,
      review: reviewCount,
      done: doneCount,
      failed: failedCount,
      staleRunning: input.staleRunningCount,
      pendingApprovals: pendingApprovalCount,
      pendingToolApprovals: input.pendingToolApprovals,
      pendingModelApprovals: input.pendingModelApprovals,
      activeWorkers: input.activeWorkers,
      availableSlots: input.availableSlots,
      maxParallelAgents: input.queue.max_parallel_agents
    },
    risk: queueRiskStrip(input.tasks),
    cost: queueCostStrip(input.preflights, input.workerCosts)
  };
}

function queueManagerSummary(input: {
  tasks: ProjectQueueTaskRow[];
  lanes: Record<string, unknown>[];
  blockedEntries: BlockedEntry[];
  toolApprovals: ToolContextProposalRow[];
  modelApprovals: ApprovalRequestWithPreflightRow[];
  maxItems: number;
}): Record<string, unknown> {
  const laneByTaskId = new Map<string, Record<string, unknown>>();
  for (const lane of input.lanes) {
    const task = asRecord(lane.queueTask);
    const queueTaskId = stringFromUnknown(task.queueTaskId);
    if (queueTaskId) laneByTaskId.set(queueTaskId, lane);
  }
  const items = input.tasks.map((task) => managerTaskItem(task, laneByTaskId.get(task.id)));
  const blockedTaskIds = new Set(input.blockedEntries.map((entry) => entry.task.id));
  const approvalTaskIds = new Set(input.toolApprovals.map((approval) => approval.queue_task_id).filter((id): id is string => Boolean(id)));
  const failedItems = items.filter((item) => item.status === "failed" || item.status === "canceled");
  const patchReadyItems = items.filter((item) => item.status === "patch_ready" || item.status === "review");
  const blockedItems = items.filter((item) => blockedTaskIds.has(String(item.queueTaskId)) || item.status === "blocked");
  const approvalItems = items.filter((item) => approvalTaskIds.has(String(item.queueTaskId)));
  const escalationItems = items.filter((item) => {
    const risk = String(item.risk ?? "");
    const status = String(item.status ?? "");
    return risk === "high" || risk === "breakglass" || status === "failed" || status === "blocked";
  });
  const evidenceItems = items.filter((item) => valuesFromUnknown(item.patchRefs).length > 0 || valuesFromUnknown(item.testRefs).length > 0);

  return {
    bounded: true,
    maxItemsPerSection: input.maxItems,
    totals: {
      tasks: input.tasks.length,
      lanes: input.lanes.length,
      phases: new Set(items.map((item) => String(item.phase ?? "unassigned"))).size,
      pendingToolApprovals: input.toolApprovals.length,
      pendingModelApprovals: input.modelApprovals.length
    },
    groups: {
      byStatus: groupedManagerItems(items, (item) => String(item.status ?? "unknown"), input.maxItems),
      byManager: groupedManagerItems(items, (item) => String(item.managerId ?? "unmanaged"), input.maxItems),
      byPhase: groupedManagerItems(items, (item) => String(item.phase ?? "unassigned"), input.maxItems),
      byWorkstream: groupedManagerItems(items, (item) => String(item.workstream ?? item.parallelGroup ?? item.phase ?? "unassigned"), input.maxItems)
    },
    attention: {
      blocked: boundedItems(blockedItems, input.maxItems),
      patchReady: boundedItems(patchReadyItems, input.maxItems),
      failed: boundedItems(failedItems, input.maxItems),
      approvals: {
        toolContext: boundedItems(
          input.toolApprovals.map((approval) => ({
            proposalId: approval.id,
            queueTaskId: approval.queue_task_id ?? undefined,
            fabricTaskId: approval.fabric_task_id ?? undefined,
            modelAlias: approval.model_alias ?? undefined,
            status: approval.status
          })),
          input.maxItems
        ),
        modelCalls: boundedItems(
          input.modelApprovals.map((approval) => ({
            requestId: approval.id,
            preflightRequestId: approval.preflight_request_id,
            status: approval.status,
            decision: approval.decision ?? undefined,
            risk: approval.risk,
            estimatedCostUsd: roundUsd(approval.estimated_cost_usd)
          })),
          input.maxItems
        )
      },
      escalationNeeded: boundedItems(escalationItems, input.maxItems)
    },
    evidence: boundedItems(evidenceItems, input.maxItems)
  };
}

function managerTaskItem(task: ProjectQueueTaskRow, lane?: Record<string, unknown>): Record<string, unknown> {
  const progress = asRecord(lane?.progress);
  const run = asRecord(lane?.workerRun);
  const patchRefs = safeJsonArray(task.patch_refs_json).filter((ref): ref is string => typeof ref === "string");
  const testRefs = safeJsonArray(task.test_refs_json).filter((ref): ref is string => typeof ref === "string");
  return {
    queueTaskId: task.id,
    fabricTaskId: task.fabric_task_id ?? undefined,
    title: task.title,
    status: task.status,
    phase: task.phase ?? "unassigned",
    managerId: task.manager_id ?? undefined,
    parentManagerId: task.parent_manager_id ?? undefined,
    parentQueueId: task.parent_queue_id ?? undefined,
    workstream: task.workstream ?? undefined,
    costCenter: task.cost_center ?? undefined,
    escalationTarget: task.escalation_target ?? undefined,
    category: task.category,
    priority: task.priority,
    risk: task.risk,
    parallelGroup: task.parallel_group ?? undefined,
    workerRunId: stringFromUnknown(run.workerRunId),
    workerKind: stringFromUnknown(run.worker),
    workerStatus: stringFromUnknown(run.status),
    workspaceMode: stringFromUnknown(run.workspaceMode),
    lastActivityAt: stringFromUnknown(progress.lastActivityAt) ?? stringFromUnknown(run.updatedAt) ?? task.ts_updated,
    summary: task.summary ?? stringFromUnknown(progress.summary) ?? undefined,
    nextAction: stringFromUnknown(progress.nextAction),
    patchRefs,
    testRefs
  };
}

function groupedManagerItems(
  items: Record<string, unknown>[],
  keyFor: (item: Record<string, unknown>) => string,
  maxItems: number
): Array<Record<string, unknown>> {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const item of items) {
    const key = keyFor(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
    .map(([key, group]) => ({
      key,
      count: group.length,
      items: boundedItems(group, maxItems)
    }));
}

function boundedItems(items: Record<string, unknown>[], maxItems: number): Record<string, unknown> {
  return {
    count: items.length,
    omitted: Math.max(0, items.length - maxItems),
    items: items.slice(0, maxItems)
  };
}

function nextProgressActions(
  queue: ProjectQueueRow,
  summary: Record<string, unknown>,
  pendingApprovalCount: number,
  patchReadyCount: number,
  readyCount: number
): Array<Record<string, unknown>> {
  if (pendingApprovalCount > 0) {
    return [
      {
        label: "Approve pending model/tool requests",
        command: `agent-fabric-project senior-run --queue ${queue.id} --approve-model-calls`
      }
    ];
  }
  if (patchReadyCount > 0) {
    return [
      {
        label: "Review patch-ready workers before accepting output",
        command: `agent-fabric-project review-patches --queue ${queue.id}`
      }
    ];
  }
  if (queue.status !== "running" && readyCount > 0) {
    return [
      {
        label: "Start Senior worker execution",
        command: `agent-fabric-project senior-run --queue ${queue.id} --approve-model-calls`
      }
    ];
  }
  if (readyCount > 0) {
    return [
      {
        label: "Launch remaining ready Senior workers",
        command: `agent-fabric-project senior-run --queue ${queue.id} --approve-model-calls`
      }
    ];
  }
  return [
    {
      label: String(summary.nextAction ?? "Inspect queue status"),
      command: `agent-fabric-project status --queue ${queue.id}`
    }
  ];
}

function queueRiskStrip(tasks: ProjectQueueTaskRow[]): Record<string, unknown> {
  const order = ["low", "medium", "high", "breakglass"];
  const openTasks = tasks.filter((task) => !DEPENDENCY_DONE.has(task.status) && task.status !== "failed" && task.status !== "canceled");
  const openByRisk = countBy(openTasks, (task) => task.risk);
  const runningByRisk = countBy(tasks.filter((task) => task.status === "running"), (task) => task.risk);
  const reviewByRisk = countBy(tasks.filter((task) => task.status === "review" || task.status === "patch_ready"), (task) => task.risk);
  const highestOpenRisk = [...order].reverse().find((risk) => (openByRisk[risk] ?? 0) > 0) ?? "none";
  return {
    highestOpenRisk,
    openByRisk,
    runningByRisk,
    reviewByRisk,
    highRiskOpenCount: (openByRisk.high ?? 0) + (openByRisk.breakglass ?? 0),
    breakglassOpenCount: openByRisk.breakglass ?? 0
  };
}

function queueCostStrip(preflights: QueuePreflightRow[], workerCosts: QueueWorkerCostAttribution[]): Record<string, unknown> {
  const workerCostByRole = aggregateWorkerCosts(workerCosts);
  return {
    preflightCount: preflights.length,
    estimatedCostUsd: roundUsd(sumNumbers(preflights.map((row) => row.estimated_cost_usd))),
    byDecision: aggregatePreflightRows(preflights, (row) => row.decision),
    byRisk: aggregatePreflightRows(preflights, (row) => row.risk),
    byRole: workerCostByRole,
    roleWarnings: costRoleWarnings(workerCostByRole)
  };
}

function costFromWorkerEventMetadata(metadata: Record<string, unknown>): number | undefined {
  const direct = typeof metadata.costUsd === "number" ? metadata.costUsd : undefined;
  if (direct !== undefined) return direct;
  const structured = asRecord(metadata.structuredResult);
  const raw = asRecord(structured.raw);
  const rawCost = raw.costUsd;
  return typeof rawCost === "number" && Number.isFinite(rawCost) ? rawCost : undefined;
}

function costRoleFromMetadata(workerMetadata: Record<string, unknown>, category: string | null, worker: string | null): string {
  const explicit =
    stringFromUnknown(workerMetadata.costRole) ??
    stringFromUnknown(workerMetadata.role) ??
    stringFromUnknown(asRecord(workerMetadata.orchestration).costRole) ??
    stringFromUnknown(asRecord(workerMetadata.codexBridge).role);
  if (explicit === "senior" || explicit === "manager" || explicit === "worker") return explicit;
  const normalizedCategory = (category ?? "").toLowerCase();
  if (normalizedCategory.includes("manager")) return "manager";
  if (normalizedCategory.includes("adjudicator") || normalizedCategory.includes("reviewer") || normalizedCategory.includes("planner")) return "worker";
  return worker && worker !== "manual" ? "worker" : "unknown";
}

function aggregateWorkerCosts(rows: QueueWorkerCostAttribution[]): Record<string, { count: number; costUsd: number }> {
  const grouped: Record<string, { count: number; costUsd: number }> = {};
  for (const row of rows) {
    grouped[row.role] ??= { count: 0, costUsd: 0 };
    grouped[row.role].count += 1;
    grouped[row.role].costUsd += row.costUsd;
  }
  for (const value of Object.values(grouped)) value.costUsd = roundUsd(value.costUsd);
  return grouped;
}

function costRoleWarnings(grouped: Record<string, { count: number; costUsd: number }>): string[] {
  const warnings: string[] = [];
  const managerCost = grouped.manager?.costUsd ?? 0;
  const workerCost = grouped.worker?.costUsd ?? 0;
  if (managerCost > 0 && managerCost > workerCost) {
    warnings.push("manager_cost_exceeds_worker_cost");
  }
  if ((grouped.worker?.count ?? 0) > 0 && workerCost === 0) {
    warnings.push("worker_cost_missing_or_unreported");
  }
  return warnings;
}

function aggregatePreflightRows(rows: QueuePreflightRow[], keyFor: (row: QueuePreflightRow) => string): Record<string, { count: number; estimatedCostUsd: number }> {
  const grouped: Record<string, { count: number; estimatedCostUsd: number }> = {};
  for (const row of rows) {
    const key = keyFor(row);
    grouped[key] ??= { count: 0, estimatedCostUsd: 0 };
    grouped[key].count += 1;
    grouped[key].estimatedCostUsd += row.estimated_cost_usd;
  }
  for (const value of Object.values(grouped)) value.estimatedCostUsd = roundUsd(value.estimatedCostUsd);
  return grouped;
}

function countBy<T>(values: T[], keyFor: (value: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const key = keyFor(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function sumNumbers(values: number[]): number {
  return values.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
}

function roundUsd(value: number): number {
  return Number(value.toFixed(6));
}

function jsonArray(input: unknown, field: string): unknown[] {
  return getArray(input, field);
}

function grant(kind: string, value: unknown): MissingGrant {
  const stringValue = typeof value === "string" ? value : stableHash(value);
  return { kind, grantKey: `${kind}:${stringValue}`, value };
}

function proposalGrants(row: ToolContextProposalRow): MissingGrant[] {
  return [
    ...safeJsonArray(row.mcp_servers_json).map((value) => grant("mcp_server", value)),
    ...safeJsonArray(row.tools_json).map((value) => grant("tool", value)),
    ...safeJsonArray(row.memories_json).map((value) => grant("memory", value)),
    ...safeJsonArray(row.context_refs_json).map((value) => grant("context", value))
  ];
}

function queueMemorySuggestions(
  host: SurfaceHost,
  workspaceRoot: string,
  tasks: ProjectQueueTaskRow[],
  perTaskLimit: number,
  totalLimit: number
): Array<Record<string, unknown>> {
  const suggestions: Array<Record<string, unknown>> = [];
  for (const task of tasks) {
    for (const suggestion of taskMemorySuggestions(host, workspaceRoot, task, perTaskLimit)) {
      suggestions.push({
        queueTaskId: task.id,
        queueTaskTitle: task.title,
        ...suggestion
      });
      if (suggestions.length >= totalLimit) return suggestions;
    }
  }
  return suggestions;
}

function taskMemorySuggestions(host: SurfaceHost, workspaceRoot: string, task: ProjectQueueTaskRow, limit: number): Array<Record<string, unknown>> {
  const intentKeys = intentKeysFromIntent(taskMemoryIntent(task)).slice(0, 40);
  if (intentKeys.length === 0 || limit <= 0) return [];

  const params: Array<string | number> = [workspaceRoot];
  params.push(...intentKeys.map((key) => `%${escapeProjectQueueLike(key)}%`));
  params.push(Math.min(100, Math.max(5, limit * 20)));
  const rows = host.db.db
    .prepare(
      `SELECT * FROM memories
       WHERE namespace = ?
         AND archived = 0
         AND invalid_at IS NULL
         AND recorded_until IS NULL
         AND status = 'active'
         AND (${intentKeys.map(() => "intent_keys_json LIKE ? ESCAPE '\\'").join(" OR ")})
       ORDER BY confidence DESC, COALESCE(last_seen_at, created_at) DESC
       LIMIT ?`
    )
    .all(...params) as Array<Record<string, unknown>>;

  return rows
    .map((row) => {
      const memoryIntentKeys = safeJsonArray(row.intent_keys_json).flatMap((key) => expandIntentString(String(key)));
      const matchedIntentKeys = [...new Set(memoryIntentKeys.filter((key) => intentKeys.includes(key)))].sort();
      return {
        row,
        matchedIntentKeys,
        score: Number((matchedIntentKeys.length + Number(row.confidence ?? 0)).toFixed(3))
      };
    })
    .filter((entry) => entry.matchedIntentKeys.length > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => {
      const memoryRef = String(entry.row.id);
      return {
        memoryRef,
        memory: formatMemory(entry.row),
        matchedIntentKeys: entry.matchedIntentKeys,
        score: entry.score,
        approvalRequired: true,
        attachByUpdating: {
          tool: "project_queue_update_task_metadata",
          field: "requiredMemories",
          value: memoryRef
        }
      };
    });
}

function taskMemoryIntent(task: ProjectQueueTaskRow): Record<string, unknown> {
  return {
    title: task.title,
    goal: task.goal,
    phase: task.phase,
    managerId: task.manager_id,
    workstream: task.workstream,
    category: task.category,
    risk: task.risk,
    expectedFiles: safeJsonArray(task.expected_files_json),
    acceptanceCriteria: safeJsonArray(task.acceptance_criteria_json)
  };
}

function escapeProjectQueueLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function policyGrantStatuses(host: SurfaceHost, queue: ProjectQueueRow): Map<string, string> {
  const rows = host.db.db
    .prepare("SELECT grant_key, status FROM tool_context_policies WHERE workspace_root = ? AND project_path = ?")
    .all(queue.workspace_root, queue.project_path) as Array<{ grant_key: string; status: string }>;
  return new Map(rows.map((row) => [row.grant_key, row.status]));
}

function pendingToolContextProposalRows(
  host: SurfaceHost,
  queueId: string,
  limit: number
): Array<ToolContextProposalRow & { queue_task_title?: string | null; queue_task_status?: string | null }> {
  return host.db.db
    .prepare(
      `SELECT p.*, t.title AS queue_task_title, t.status AS queue_task_status
       FROM tool_context_proposals p
       LEFT JOIN project_queue_tasks t ON t.id = p.queue_task_id
       WHERE p.queue_id = ? AND p.status = 'proposed' AND p.approval_required = 1
       ORDER BY p.ts_created ASC
       LIMIT ?`
    )
    .all(queueId, limit) as Array<ToolContextProposalRow & { queue_task_title?: string | null; queue_task_status?: string | null }>;
}

function isOpenQueueTask(task: ProjectQueueTaskRow): boolean {
  return !DEPENDENCY_DONE.has(task.status) && task.status !== "failed" && task.status !== "canceled";
}

function groupTasks(tasks: ProjectQueueTaskRow[], keyFor: (task: ProjectQueueTaskRow) => string): Array<Record<string, unknown>> {
  const groups = new Map<string, ProjectQueueTaskRow[]>();
  for (const task of tasks) {
    const key = keyFor(task) || "none";
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  return [...groups.entries()]
    .map(([key, groupTasks]) => ({
      key,
      count: groupTasks.length,
      openCount: groupTasks.filter(isOpenQueueTask).length,
      runningCount: groupTasks.filter((task) => task.status === "running").length,
      reviewCount: groupTasks.filter((task) => task.status === "review" || task.status === "patch_ready").length,
      tasks: groupTasks.map(formatQueueTaskLink)
    }))
    .sort((left, right) => Number(right.count) - Number(left.count) || String(left.key).localeCompare(String(right.key)));
}

function dependencyEdgesForTasks(tasks: ProjectQueueTaskRow[]): Array<Record<string, unknown>> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const edges: Array<Record<string, unknown>> = [];
  for (const task of tasks) {
    for (const dependency of safeJsonArray(task.depends_on_json)) {
      if (typeof dependency !== "string") continue;
      const dependencyTask = byId.get(dependency);
      edges.push({
        from: dependency,
        to: task.id,
        dependency: dependencyTask ? formatQueueTaskLink(dependencyTask) : { queueTaskId: dependency, missing: true },
        task: formatQueueTaskLink(task),
        satisfied: dependencyTask ? DEPENDENCY_DONE.has(dependencyTask.status) : false
      });
    }
  }
  return edges;
}

function dependentCountByTask(tasks: ProjectQueueTaskRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) counts.set(task.id, 0);
  for (const task of tasks) {
    for (const dependency of safeJsonArray(task.depends_on_json)) {
      if (typeof dependency === "string") counts.set(dependency, (counts.get(dependency) ?? 0) + 1);
    }
  }
  return counts;
}

function fileScopeMatrix(tasks: ProjectQueueTaskRow[]): Array<Record<string, unknown>> {
  const scopes = new Map<string, ProjectQueueTaskRow[]>();
  for (const task of tasks) {
    for (const file of safeJsonArray(task.expected_files_json)) {
      if (typeof file !== "string" || file.length === 0) continue;
      scopes.set(file, [...(scopes.get(file) ?? []), task]);
    }
  }
  return [...scopes.entries()]
    .map(([path, scopedTasks]) => {
      const openTasks = scopedTasks.filter(isOpenQueueTask);
      const risks = [...new Set(scopedTasks.map((task) => task.risk))].sort();
      const statuses = [...new Set(scopedTasks.map((task) => task.status))].sort();
      return {
        path,
        taskCount: scopedTasks.length,
        openTaskCount: openTasks.length,
        runningTaskCount: scopedTasks.filter((task) => task.status === "running").length,
        overlap: openTasks.length > 1,
        risks,
        statuses,
        tasks: scopedTasks.map(formatQueueTaskLink)
      };
    })
    .sort((left, right) => Number(right.openTaskCount) - Number(left.openTaskCount) || String(left.path).localeCompare(String(right.path)));
}

function requiredGrantsForTask(task: ProjectQueueTaskRow): MissingGrant[] {
  return [
    ...safeJsonArray(task.required_mcp_servers_json).map((value) => grant("mcp_server", value)),
    ...safeJsonArray(task.required_tools_json).map((value) => grant("tool", value)),
    ...safeJsonArray(task.required_memories_json).map((value) => grant("memory", value)),
    ...safeJsonArray(task.required_context_refs_json).map((value) => grant("context", value))
  ];
}

function toolContextGrantMatrix(host: SurfaceHost, queue: ProjectQueueRow, tasks: ProjectQueueTaskRow[]): Array<Record<string, unknown>> {
  const policyStatuses = policyGrantStatuses(host, queue);
  const byGrant = new Map<string, { grant: MissingGrant; tasks: ProjectQueueTaskRow[] }>();
  for (const task of tasks) {
    for (const grantEntry of requiredGrantsForTask(task)) {
      const existing = byGrant.get(grantEntry.grantKey);
      if (existing) existing.tasks.push(task);
      else byGrant.set(grantEntry.grantKey, { grant: grantEntry, tasks: [task] });
    }
  }
  return [...byGrant.values()]
    .map((entry) => {
      const policyStatus = policyStatuses.get(entry.grant.grantKey) ?? "missing";
      return {
        grantKey: entry.grant.grantKey,
        kind: entry.grant.kind,
        value: entry.grant.value,
        policyStatus,
        approvedByPolicy: policyStatus === "approved",
        rejectedByPolicy: policyStatus === "rejected",
        taskCount: entry.tasks.length,
        openTaskCount: entry.tasks.filter(isOpenQueueTask).length,
        tasks: entry.tasks.map(formatQueueTaskLink)
      };
    })
    .sort((left, right) => String(left.kind).localeCompare(String(right.kind)) || String(left.grantKey).localeCompare(String(right.grantKey)));
}

function taskToolContextMatrixEntry(host: SurfaceHost, queue: ProjectQueueRow, task: ProjectQueueTaskRow): Record<string, unknown> {
  const readiness = taskToolContextLaunchReadiness(host, queue, task);
  const requiredGrants = requiredGrantsForTask(task);
  const policyStatuses = policyGrantStatuses(host, queue);
  const grants = requiredGrants.map((entry) => ({
    ...entry,
    policyStatus: policyStatuses.get(entry.grantKey) ?? "missing"
  }));
  return {
    task: formatQueueTaskLink(task),
    requiredGrantCount: requiredGrants.length,
    noContextRequired: readiness.noContextRequired,
    approvalRequired: readiness.approvalRequired,
    needsProposal: readiness.needsProposal,
    missingGrants: readiness.missingGrants,
    grants,
    proposalId: readiness.proposal?.id,
    proposalStatus: readiness.proposal?.status,
    approvedByProposal: readiness.proposal?.status === "approved"
  };
}

function queueListItem(host: SurfaceHost, queue: ProjectQueueRow): Record<string, unknown> {
  const tasks = taskRows(host, queue.id);
  const activeWorkers = tasks.filter((task) => ACTIVE_WORKER_STATUSES.has(task.status)).length;
  const analyzed = analyzeReadiness(tasks);
  const executionBlock = queueExecutionBlockReason(queue.status);
  const scheduled = executionBlock
    ? { ready: [], blocked: [] }
    : selectSchedulableReadyTasks(analyzed.ready.sort(compareReadyTasks), tasks, Math.max(0, queue.max_parallel_agents - activeWorkers));
  const blockedCount = executionBlock ? queueBlockedEntries(tasks, executionBlock).length : analyzed.blocked.length + scheduled.blocked.length;
  const pendingApprovals = host.db.db
    .prepare("SELECT COUNT(*) AS count FROM tool_context_proposals WHERE queue_id = ? AND status = 'proposed' AND approval_required = 1")
    .get(queue.id) as { count: number };
  const policies = host.db.db
    .prepare("SELECT status, COUNT(*) AS count FROM tool_context_policies WHERE workspace_root = ? AND project_path = ? GROUP BY status")
    .all(queue.workspace_root, queue.project_path) as Array<{ status: string; count: number }>;
  const policyCounts: Record<string, number> = {};
  for (const row of policies) policyCounts[row.status] = row.count;

  return {
    ...formatQueue(queue),
    counts: statusCounts(tasks),
    activeWorkers,
    availableSlots: Math.max(0, queue.max_parallel_agents - activeWorkers),
    readyCount: scheduled.ready.length,
    blockedCount,
    pendingApprovals: pendingApprovals.count,
    policyCounts
  };
}

function queueCleanupCandidates(
  host: SurfaceHost,
  workspaceRoot: string,
  options: {
    queueId?: string;
    projectPath?: string;
    statuses: string[];
    cutoff: Date;
    limit: number;
    deleteLinkedTaskHistory: boolean;
  }
): { candidates: QueueCleanupCandidate[]; protected: Array<Record<string, unknown>> } {
  const queues = queueCleanupScopeRows(host, workspaceRoot, options);
  const candidates: QueueCleanupCandidate[] = [];
  const protectedRows: Array<Record<string, unknown>> = [];

  for (const queue of queues) {
    const protectedReason = queueCleanupProtectedReason(host, queue, options.statuses, options.cutoff);
    if (protectedReason) {
      protectedRows.push({ queue: formatQueue(queue), reason: protectedReason });
      continue;
    }
    candidates.push({ queue, counts: queueCleanupCounts(host, queue.id) });
  }

  return { candidates, protected: protectedRows };
}

function queueCleanupScopeRows(
  host: SurfaceHost,
  workspaceRoot: string,
  options: {
    queueId?: string;
    projectPath?: string;
    statuses: string[];
    limit: number;
  }
): ProjectQueueRow[] {
  if (options.queueId) {
    return [requireQueue(host, options.queueId, workspaceRoot)];
  }

  const params: Array<string | number> = [workspaceRoot, workspaceRoot];
  const where = ["(workspace_root = ? OR project_path = ?)"];
  if (options.projectPath) {
    where.push("project_path = ?");
    params.push(options.projectPath);
  }
  where.push(`status IN (${options.statuses.map(() => "?").join(", ")})`);
  params.push(...options.statuses, options.limit);
  return host.db.db
    .prepare(`SELECT * FROM project_queues WHERE ${where.join(" AND ")} ORDER BY ts_updated ASC LIMIT ?`)
    .all(...params) as ProjectQueueRow[];
}

function queueCleanupProtectedReason(host: SurfaceHost, queue: ProjectQueueRow, statuses: string[], cutoff: Date): string | undefined {
  if (!statuses.includes(queue.status)) return `queue status is ${queue.status}, not cleanup-eligible`;
  const updatedAt = Date.parse(queue.ts_updated);
  if (Number.isFinite(updatedAt) && updatedAt > cutoff.getTime()) return `queue updated after retention cutoff ${cutoff.toISOString()}`;
  const blockingTaskStatuses = [...CLEANUP_BLOCKING_TASK_STATUSES];
  const blockingTasks = countWhere(
    host.db,
    "project_queue_tasks",
    `queue_id = ? AND status IN (${blockingTaskStatuses.map(() => "?").join(", ")})`,
    [queue.id, ...blockingTaskStatuses]
  );
  if (blockingTasks > 0) return `queue has ${blockingTasks} active or reviewable task(s)`;
  const linkedTaskIds = linkedFabricTaskIds(host, queue.id);
  const runningWorkers = countWorkerRunsForTaskIds(host, linkedTaskIds, ["running"]);
  if (runningWorkers > 0) return `queue has ${runningWorkers} running linked worker(s)`;
  return undefined;
}

function queueCleanupCounts(host: SurfaceHost, queueId: string): QueueCleanupCounts {
  const linkedTaskIds = linkedFabricTaskIds(host, queueId);
  return {
    queueRows: 1,
    queueTasks: countWhere(host.db, "project_queue_tasks", "queue_id = ?", [queueId]),
    stages: countWhere(host.db, "project_queue_stages", "queue_id = ?", [queueId]),
    decisions: countWhere(host.db, "project_queue_decisions", "queue_id = ?", [queueId]),
    toolContextProposals: countWhere(host.db, "tool_context_proposals", "queue_id = ?", [queueId]),
    linkedFabricTasks: linkedTaskIds.length,
    workerRuns: countRowsForTaskIds(host, "worker_runs", linkedTaskIds),
    workerEvents: countRowsForTaskIds(host, "worker_events", linkedTaskIds),
    workerCheckpoints: countRowsForTaskIds(host, "worker_checkpoints", linkedTaskIds)
  };
}

function linkedFabricTaskIds(host: SurfaceHost, queueId: string): string[] {
  const rows = host.db.db
    .prepare("SELECT DISTINCT fabric_task_id AS task_id FROM project_queue_tasks WHERE queue_id = ? AND fabric_task_id IS NOT NULL")
    .all(queueId) as Array<{ task_id: string }>;
  return rows.map((row) => row.task_id);
}

function countRowsForTaskIds(host: SurfaceHost, table: "worker_runs" | "worker_events" | "worker_checkpoints", taskIds: string[]): number {
  if (taskIds.length === 0) return 0;
  const placeholders = taskIds.map(() => "?").join(", ");
  const row = host.db.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE task_id IN (${placeholders})`).get(...taskIds) as { count: number };
  return row.count;
}

function countWorkerRunsForTaskIds(host: SurfaceHost, taskIds: string[], statuses: string[]): number {
  if (taskIds.length === 0 || statuses.length === 0) return 0;
  const taskPlaceholders = taskIds.map(() => "?").join(", ");
  const statusPlaceholders = statuses.map(() => "?").join(", ");
  const row = host.db.db
    .prepare(`SELECT COUNT(*) AS count FROM worker_runs WHERE task_id IN (${taskPlaceholders}) AND status IN (${statusPlaceholders})`)
    .get(...taskIds, ...statuses) as { count: number };
  return row.count;
}

function deleteLinkedTaskRows(host: SurfaceHost, taskIds: string[]): void {
  if (taskIds.length === 0) return;
  const placeholders = taskIds.map(() => "?").join(", ");
  host.db.db.prepare(`DELETE FROM worker_checkpoints WHERE task_id IN (${placeholders})`).run(...taskIds);
  host.db.db.prepare(`DELETE FROM worker_events WHERE task_id IN (${placeholders})`).run(...taskIds);
  host.db.db.prepare(`DELETE FROM worker_runs WHERE task_id IN (${placeholders})`).run(...taskIds);
  host.db.db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...taskIds);
}

function formatCleanupCandidate(candidate: QueueCleanupCandidate, deleteLinkedTaskHistory: boolean): Record<string, unknown> {
  return {
    queue: formatQueue(candidate.queue),
    counts: candidate.counts,
    estimatedDeletedRows: cleanupDeletedRowEstimate(candidate.counts, deleteLinkedTaskHistory),
    retainedLinkedTaskHistoryRows: deleteLinkedTaskHistory ? 0 : cleanupLinkedTaskHistoryRows(candidate.counts)
  };
}

function sumCleanupCounts(counts: QueueCleanupCounts[], deleteLinkedTaskHistory: boolean): Record<string, unknown> {
  const totals: QueueCleanupCounts = {
    queueRows: 0,
    queueTasks: 0,
    stages: 0,
    decisions: 0,
    toolContextProposals: 0,
    linkedFabricTasks: 0,
    workerRuns: 0,
    workerEvents: 0,
    workerCheckpoints: 0
  };
  for (const count of counts) {
    totals.queueRows += count.queueRows;
    totals.queueTasks += count.queueTasks;
    totals.stages += count.stages;
    totals.decisions += count.decisions;
    totals.toolContextProposals += count.toolContextProposals;
    totals.linkedFabricTasks += count.linkedFabricTasks;
    totals.workerRuns += count.workerRuns;
    totals.workerEvents += count.workerEvents;
    totals.workerCheckpoints += count.workerCheckpoints;
  }
  return {
    ...totals,
    estimatedDeletedRows: cleanupDeletedRowEstimate(totals, deleteLinkedTaskHistory),
    retainedLinkedTaskHistoryRows: deleteLinkedTaskHistory ? 0 : cleanupLinkedTaskHistoryRows(totals)
  };
}

function cleanupDeletedRowEstimate(counts: QueueCleanupCounts, deleteLinkedTaskHistory: boolean): number {
  const queueRows = counts.queueRows + counts.queueTasks + counts.stages + counts.decisions + counts.toolContextProposals;
  if (!deleteLinkedTaskHistory) return queueRows;
  return queueRows + cleanupLinkedTaskHistoryRows(counts);
}

function cleanupLinkedTaskHistoryRows(counts: QueueCleanupCounts): number {
  return counts.linkedFabricTasks + counts.workerRuns + counts.workerEvents + counts.workerCheckpoints;
}

function formatQueue(row: ProjectQueueRow): Record<string, unknown> {
  return {
    queueId: row.id,
    workspaceRoot: row.workspace_root,
    projectPath: row.project_path,
    title: row.title,
    promptSummary: row.prompt_summary,
    rawPromptStored: false,
    pipelineProfile: row.pipeline_profile,
    maxParallelAgents: row.max_parallel_agents,
    status: row.status,
    planChainId: row.plan_chain_id ?? undefined,
    createdBySessionId: row.created_by_session_id,
    createdByAgentId: row.created_by_agent_id,
    createdAt: row.ts_created,
    updatedAt: row.ts_updated
  };
}

function formatStage(row: ProjectQueueStageRow): Record<string, unknown> {
  return {
    stageId: row.id,
    queueId: row.queue_id,
    stage: row.stage,
    status: row.status,
    modelAlias: row.model_alias ?? undefined,
    inputSummary: row.input_summary ?? undefined,
    outputSummary: row.output_summary ?? undefined,
    artifacts: safeJsonArray(row.artifacts_json),
    warnings: safeJsonArray(row.warnings_json),
    sessionId: row.session_id,
    agentId: row.agent_id,
    createdAt: row.ts_created
  };
}

function formatQueueTask(row: ProjectQueueTaskRow): Record<string, unknown> {
  return {
    queueTaskId: row.id,
    queueId: row.queue_id,
    fabricTaskId: row.fabric_task_id ?? undefined,
    clientKey: row.client_key ?? undefined,
    title: row.title,
    goal: row.goal,
    phase: row.phase ?? undefined,
    managerId: row.manager_id ?? undefined,
    parentManagerId: row.parent_manager_id ?? undefined,
    parentQueueId: row.parent_queue_id ?? undefined,
    workstream: row.workstream ?? undefined,
    costCenter: row.cost_center ?? undefined,
    escalationTarget: row.escalation_target ?? undefined,
    category: row.category,
    status: row.status,
    priority: row.priority,
    parallelGroup: row.parallel_group ?? undefined,
    parallelSafe: row.parallel_safe === 1,
    risk: row.risk,
    expectedFiles: safeJsonArray(row.expected_files_json),
    acceptanceCriteria: safeJsonArray(row.acceptance_criteria_json),
    requiredTools: safeJsonArray(row.required_tools_json),
    requiredMcpServers: safeJsonArray(row.required_mcp_servers_json),
    requiredMemories: safeJsonArray(row.required_memories_json),
    requiredContextRefs: safeJsonArray(row.required_context_refs_json),
    dependsOn: safeJsonArray(row.depends_on_json),
    assignedWorkerRunId: row.assigned_worker_run_id ?? undefined,
    patchRefs: safeJsonArray(row.patch_refs_json),
    testRefs: safeJsonArray(row.test_refs_json),
    summary: row.summary ?? undefined,
    createdAt: row.ts_created,
    updatedAt: row.ts_updated
  };
}

function formatQueueTaskLink(row: ProjectQueueTaskRow): Record<string, unknown> {
  return {
    queueTaskId: row.id,
    fabricTaskId: row.fabric_task_id ?? undefined,
    clientKey: row.client_key ?? undefined,
    title: row.title,
    status: row.status,
    phase: row.phase ?? undefined,
    managerId: row.manager_id ?? undefined,
    workstream: row.workstream ?? undefined,
    priority: row.priority,
    risk: row.risk,
    parallelGroup: row.parallel_group ?? undefined,
    parallelSafe: row.parallel_safe === 1
  };
}

function formatBlockedEntry(entry: BlockedEntry): Record<string, unknown> {
  return {
    task: formatQueueTask(entry.task),
    reasons: entry.reasons,
    blockers: entry.blockers ?? []
  };
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

function formatWorkerEvent(row: WorkerEventRow): Record<string, unknown> {
  return {
    eventId: row.id,
    taskId: row.task_id,
    workerRunId: row.worker_run_id,
    timestamp: row.ts,
    kind: row.kind,
    body: row.body ?? undefined,
    refs: safeJsonArray(row.refs_json),
    metadata: safeJsonRecord(row.metadata_json),
    traceId: row.trace_id ?? undefined,
    costUsd: row.cost_usd ?? undefined
  };
}

function formatWorkerCheckpoint(row: WorkerCheckpointRow): Record<string, unknown> {
  return {
    checkpointId: row.id,
    taskId: row.task_id,
    workerRunId: row.worker_run_id,
    timestamp: row.ts,
    summary: safeJsonRecord(row.summary_json)
  };
}

function formatTaskWorkerRunDetail(host: SurfaceHost, task: ProjectQueueTaskRow, run: WorkerRunRow, maxEventsPerRun: number): Record<string, unknown> {
  const events = workerEventRows(host, run.task_id, run.id, maxEventsPerRun);
  const checkpoint = latestWorkerCheckpoint(host, run.task_id, run.id);
  const formattedEvents = events.map(formatWorkerEvent);
  const latestEvent = formattedEvents[0];
  const formattedCheckpoint = checkpoint ? formatWorkerCheckpoint(checkpoint) : undefined;
  return {
    workerRun: formatWorkerRun(run),
    latestEvent,
    recentEvents: formattedEvents,
    latestCheckpoint: formattedCheckpoint,
    progress: laneProgress(task, run, latestEvent, formattedCheckpoint)
  };
}

function buildQueueResumePacket(queue: ProjectQueueRow, task: ProjectQueueTaskRow, resume: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: "agent-fabric.queue-resume-packet.v1",
    queue: formatQueue(queue),
    task: formatQueueTask(task),
    fabricResume: resume,
    requiredTools: safeJsonArray(task.required_tools_json),
    requiredMcpServers: safeJsonArray(task.required_mcp_servers_json),
    requiredMemories: safeJsonArray(task.required_memories_json),
    requiredContextRefs: safeJsonArray(task.required_context_refs_json),
    operatorInstructions: [
      "Resume only this queue task unless the queue state has changed.",
      "Use the latest checkpoint and events as the starting point; do not repeat completed work.",
      "Use only approved tools, MCP servers, memories, and context.",
      "Write a new checkpoint before long-running work, context compaction, or handoff.",
      "Return patch-ready output with test evidence or record an explicit blocker."
    ]
  };
}

function buildQueueTaskPacket(queue: ProjectQueueRow, task: ProjectQueueTaskRow): Record<string, unknown> {
  return {
    schema: "agent-fabric.task-packet.v1",
    queue: formatQueue(queue),
    task: formatQueueTask(task),
    requiredTools: safeJsonArray(task.required_tools_json),
    requiredMcpServers: safeJsonArray(task.required_mcp_servers_json),
    requiredMemories: safeJsonArray(task.required_memories_json),
    requiredContextRefs: safeJsonArray(task.required_context_refs_json),
    operatorInstructions: [
      "Work only on this queue task unless the queue state says otherwise.",
      "Use only approved tools, MCP servers, memories, and context.",
      "Record command, file, test, checkpoint, patch-ready, failed, or completed events through agent-fabric.",
      "Return patch-ready output with test evidence or an explicit blocker."
    ]
  };
}

function formatQueueTaskPacketMarkdown(packet: Record<string, unknown>): string {
  const queue = asObject(packet.queue) ?? {};
  const task = asObject(packet.task) ?? {};
  const instructions = Array.isArray(packet.operatorInstructions) ? packet.operatorInstructions : [];
  return [
    `# ${String(task.title ?? "Queue task")}`,
    "",
    `Queue: ${String(queue.queueId ?? "")}`,
    `Project: ${String(queue.projectPath ?? "")}`,
    `Queue task: ${String(task.queueTaskId ?? "")}`,
    `Fabric task: ${String(task.fabricTaskId ?? "")}`,
    `Status: ${String(task.status ?? "")}`,
    `Risk: ${String(task.risk ?? "medium")}`,
    "",
    "## Goal",
    "",
    String(task.goal ?? ""),
    "",
    "## Task Metadata",
    "",
    `Phase: ${String(task.phase ?? "")}`,
    `Priority: ${String(task.priority ?? "normal")}`,
    `Parallel safe: ${String(task.parallelSafe ?? true)}`,
    `Depends on: ${JSON.stringify(safePacketArray(task.dependsOn))}`,
    `Required tools: ${JSON.stringify(safePacketArray(task.requiredTools))}`,
    `Required MCP servers: ${JSON.stringify(safePacketArray(task.requiredMcpServers))}`,
    `Required memories: ${JSON.stringify(safePacketArray(task.requiredMemories))}`,
    `Required context refs: ${JSON.stringify(safePacketArray(task.requiredContextRefs))}`,
    "",
    "## Expected Files",
    "",
    ...formatPacketList(safePacketArray(task.expectedFiles)),
    "",
    "## Acceptance Criteria",
    "",
    ...formatPacketList(safePacketArray(task.acceptanceCriteria)),
    "",
    "## Instructions",
    "",
    ...instructions.map((instruction) => `- ${String(instruction)}`),
    ""
  ].join("\n");
}

function formatQueueResumePacketMarkdown(packet: Record<string, unknown>): string {
  const task = asObject(packet.task) ?? {};
  const resume = asObject(packet.fabricResume) ?? {};
  return [
    `# Resume ${String(task.title ?? "queue task")}`,
    "",
    formatQueueTaskPacketMarkdown({ ...packet, schema: "agent-fabric.task-packet.v1" }),
    "",
    "## Resume Prompt",
    "",
    String(resume.resumePrompt ?? ""),
    ""
  ].join("\n");
}

function buildQueueWorkerHandoff(
  queue: ProjectQueueRow,
  task: ProjectQueueTaskRow,
  options: {
    packetPath: string;
    format: string;
    worker: string;
    workspaceMode: string;
    workspacePath?: string;
    modelProfile: string;
    packetKind: string;
  }
): Record<string, unknown> {
  const packetDir = dirnameFromPath(options.packetPath);
  const deepseekCommand = options.worker === "deepseek-direct";
  const jcodeDeepSeekCommand = options.worker === "jcode-deepseek";
  const jcodeDispatcher = jcodeDeepSeekDispatcherPath();
  const runReadyCommandTemplate =
    deepseekCommand
      ? "agent-fabric-deepseek-worker run-task --task-packet {{taskPacket}} --fabric-task {{fabricTaskId}} --role implementer"
      : jcodeDeepSeekCommand
        ? `${shellQuote(jcodeDispatcher)} {{taskPacket}}`
        : `<${options.worker} command using {{taskPacket}}>`;
  const runTaskCommand = deepseekCommand
    ? `agent-fabric-deepseek-worker run-task --task-packet ${shellQuote(options.packetPath)} --fabric-task ${shellQuote(task.fabric_task_id ?? "")} --role implementer`
    : jcodeDeepSeekCommand
      ? `${shellQuote(jcodeDispatcher)} ${shellQuote(options.packetPath)}`
      : runReadyCommandTemplate;
  const claimArgs = [
    "npm",
    "run",
    "dev:project",
    "--",
    "claim-next",
    "--queue",
    queue.id,
    "--worker",
    options.worker,
    "--workspace-mode",
    options.workspaceMode,
    "--model-profile",
    options.modelProfile
  ];
  if (options.workspacePath) claimArgs.push("--workspace-path", options.workspacePath);
  const runTaskArgs = [
    "npm",
    "run",
    "dev:project",
    "--",
    "run-task",
    "--queue",
    queue.id,
    "--queue-task",
    task.id,
    "--worker",
    options.worker,
    "--workspace-mode",
    options.workspaceMode,
    "--model-profile",
    options.modelProfile,
    "--task-packet",
    options.packetPath,
    "--task-packet-format",
    options.format,
    "--command",
    runTaskCommand,
    "--approve-tool-context"
  ];
  const runReadyArgs = [
    "npm",
    "run",
    "dev:project",
    "--",
    "run-ready",
    "--queue",
    queue.id,
    "--parallel",
    String(queue.max_parallel_agents),
    "--worker",
    options.worker,
    "--workspace-mode",
    options.workspaceMode,
    "--model-profile",
    options.modelProfile,
    "--task-packet-dir",
    packetDir,
    "--task-packet-format",
    options.format,
    "--command-template",
    runReadyCommandTemplate,
    "--approve-tool-context"
  ];
  return {
    packetPath: options.packetPath,
    packetDirectory: packetDir,
    packetKind: options.packetKind,
    worker: options.worker,
    workspaceMode: options.workspaceMode,
    modelProfile: options.modelProfile,
    commands: [
      {
        key: "write_ready_packets",
        label: "Write ready task packets",
        command: shellCommand([
          "npm",
          "run",
          "dev:project",
          "--",
          "write-task-packets",
          "--queue",
          queue.id,
          "--out-dir",
          packetDir,
          "--format",
          options.format,
          "--ready-only"
        ]),
        editRequired: false
      },
      {
        key: "claim_next_worker",
        label: "Claim and register next worker",
        command: shellCommand(claimArgs),
        editRequired: false
      },
      {
        key: "run_this_task",
        label: "Run this task with a packet",
        command: shellCommand(runTaskArgs),
        editRequired: !(deepseekCommand || jcodeDeepSeekCommand)
      },
      {
        key: "run_ready_parallel",
        label: "Run ready tasks in parallel",
        command: shellCommand(runReadyArgs),
        editRequired: !(deepseekCommand || jcodeDeepSeekCommand)
      }
    ],
    notes: [
      deepseekCommand || jcodeDeepSeekCommand
        ? "DeepSeek-backed commands call the OpenAI-compatible DeepSeek API and require DEEPSEEK_API_KEY or DEEPSEEK_TOKEN in the environment."
        : "Commands marked editRequired contain a worker command placeholder that should be replaced with the real local worker invocation.",
      "The packet path is a handoff convention; write the packet first or copy the packet body into the worker UI."
    ]
  };
}

function safePacketArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function formatPacketList(values: unknown[]): string[] {
  return values.length > 0 ? values.map((value) => `- ${String(value)}`) : ["- none"];
}

function defaultTaskPacketPath(queue: ProjectQueueRow, task: ProjectQueueTaskRow, format: string): string {
  const extension = format === "markdown" ? "md" : "json";
  return `${queue.project_path.replace(/\/+$/, "")}/.agent-fabric/task-packets/${task.id}.${extension}`;
}

function dirnameFromPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : ".";
}

function shellCommand(args: string[]): string {
  return args.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function laneProgress(
  task: ProjectQueueTaskRow,
  run: WorkerRunRow,
  latestEvent?: Record<string, unknown>,
  latestCheckpoint?: Record<string, unknown>
): Record<string, unknown> {
  const checkpointSummary = asObject(latestCheckpoint?.summary);
  const filesTouched = stringArrayFromUnknown(checkpointSummary?.filesTouched);
  const testsRun = stringArrayFromUnknown(checkpointSummary?.testsRun);
  const patchRefs = safeJsonArray(task.patch_refs_json).filter((ref): ref is string => typeof ref === "string");
  const testRefs = safeJsonArray(task.test_refs_json).filter((ref): ref is string => typeof ref === "string");
  return {
    status: run.status,
    taskStatus: task.status,
    label: laneLabel(task.status, run.status),
    lastActivityAt: stringFromUnknown(latestEvent?.timestamp) ?? stringFromUnknown(latestCheckpoint?.timestamp) ?? run.ts_updated,
    summary: task.summary ?? stringFromUnknown(checkpointSummary?.currentGoal) ?? stringFromUnknown(latestEvent?.body) ?? task.goal,
    nextAction: stringFromUnknown(checkpointSummary?.nextAction),
    filesTouched: filesTouched.length > 0 ? filesTouched : patchRefs,
    testsRun: testsRun.length > 0 ? testsRun : testRefs,
    patchRefs,
    testRefs
  };
}

function laneLabel(taskStatus: string, workerStatus: string): string {
  if (taskStatus === "patch_ready") return "Patch ready";
  if (taskStatus === "review") return "Review";
  if (taskStatus === "failed" || workerStatus === "failed") return "Failed";
  if (taskStatus === "completed" || taskStatus === "accepted" || taskStatus === "done" || workerStatus === "completed") return "Completed";
  if (taskStatus === "canceled" || workerStatus === "canceled") return "Canceled";
  if (taskStatus === "running" || workerStatus === "running") return "Running";
  return taskStatus;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function arrayRecordsFromUnknown(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry));
}

function valuesFromUnknown(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function formatDecision(row: ProjectQueueDecisionRow): Record<string, unknown> {
  return {
    decisionId: row.id,
    queueId: row.queue_id,
    decision: row.decision,
    note: row.note ?? undefined,
    metadata: safeJsonRecord(row.metadata_json),
    sessionId: row.session_id,
    agentId: row.agent_id,
    createdAt: row.ts_created
  };
}

function formatProposal(row: ToolContextProposalRow): Record<string, unknown> {
  return {
    proposalId: row.id,
    queueId: row.queue_id,
    queueTaskId: row.queue_task_id ?? undefined,
    fabricTaskId: row.fabric_task_id ?? undefined,
    status: row.status,
    mcpServers: safeJsonArray(row.mcp_servers_json),
    tools: safeJsonArray(row.tools_json),
    memories: safeJsonArray(row.memories_json),
    contextRefs: safeJsonArray(row.context_refs_json),
    modelAlias: row.model_alias ?? undefined,
    reasoning: row.reasoning ?? undefined,
    safetyWarnings: safeJsonArray(row.safety_warnings_json),
    approvalRequired: row.approval_required === 1,
    missingGrants: safeJsonArray(row.missing_grants_json),
    decision: row.decision ?? undefined,
    decisionNote: row.decision_note ?? undefined,
    decidedBySessionId: row.decided_by_session_id ?? undefined,
    decidedByAgentId: row.decided_by_agent_id ?? undefined,
    decidedAt: row.ts_decided ?? undefined,
    createdAt: row.ts_created,
    updatedAt: row.ts_updated
  };
}

function stageTimelineItem(row: ProjectQueueStageRow): Record<string, unknown> {
  const stage = formatStage(row);
  return {
    timelineId: `stage:${row.id}`,
    source: "pipeline_stage",
    kind: `stage.${row.status}`,
    timestamp: row.ts_created,
    title: `${row.stage}: ${row.status}`,
    summary: row.output_summary ?? row.input_summary ?? undefined,
    severity: row.status === "failed" ? "warning" : row.status === "needs_review" ? "attention" : "info",
    stage: row.stage,
    status: row.status,
    data: stage
  };
}

function decisionTimelineItem(row: ProjectQueueDecisionRow): Record<string, unknown> {
  return {
    timelineId: `decision:${row.id}`,
    source: "human_decision",
    kind: `decision.${row.decision}`,
    timestamp: row.ts_created,
    title: `Decision: ${row.decision}`,
    summary: row.note ?? undefined,
    severity: decisionSeverity(row.decision),
    decision: row.decision,
    data: formatDecision(row)
  };
}

function proposalTimelineItem(
  row: ToolContextProposalRow & { queue_task_title?: string | null; queue_task_status?: string | null }
): Record<string, unknown> {
  const timestamp = row.ts_decided ?? row.ts_updated ?? row.ts_created;
  const action = row.decision ?? row.status;
  const approvalPending = row.status === "proposed" && row.approval_required === 1;
  return {
    timelineId: `tool_context:${row.id}:${action}`,
    source: "tool_context",
    kind: `tool_context.${action}`,
    timestamp,
    title: approvalPending ? "Tool/context approval required" : `Tool/context ${action}`,
    summary: row.queue_task_title ?? row.decision_note ?? undefined,
    severity: approvalPending ? "attention" : row.decision === "reject" ? "warning" : "info",
    queueTaskId: row.queue_task_id ?? undefined,
    queueTaskTitle: row.queue_task_title ?? undefined,
    queueTaskStatus: row.queue_task_status ?? undefined,
    data: formatProposal(row)
  };
}

function modelApprovalTimelineItem(row: ApprovalRequestWithPreflightRow, nowIso: string): Record<string, unknown> {
  const timestamp = row.decided_at ?? row.ts_created;
  const formatted = formatModelApproval(row, nowIso);
  return {
    timelineId: `model_approval:${row.id}:${row.status}`,
    source: "model_approval",
    kind: `model_approval.${row.status}`,
    timestamp,
    title: `Model approval: ${row.risk} ${row.selected_model}`,
    summary: `Estimated $${row.estimated_cost_usd.toFixed(6)} for ${row.selected_provider}/${row.selected_model}`,
    severity: row.status === "pending" ? "attention" : row.status === "rejected" || row.status === "canceled" ? "warning" : "info",
    approvalRequestId: row.id,
    requestId: row.preflight_request_id,
    data: formatted
  };
}

function workerEventTimelineItem(row: QueueWorkerEventRow): Record<string, unknown> {
  return {
    timelineId: `worker_event:${row.id}`,
    source: "worker_event",
    kind: `worker.${row.kind}`,
    timestamp: row.ts,
    title: `${row.worker ?? "worker"}: ${row.kind}`,
    summary: row.body ?? row.queue_task_title,
    severity: row.kind === "failed" ? "warning" : row.kind === "patch_ready" ? "attention" : "info",
    queueTaskId: row.queue_task_id,
    queueTaskTitle: row.queue_task_title,
    queueTaskStatus: row.queue_task_status,
    workerRunId: row.worker_run_id,
    worker: row.worker ?? undefined,
    workerStatus: row.worker_status ?? undefined,
    data: formatWorkerEvent(row)
  };
}

function decisionSeverity(decision: string): string {
  if (decision === "cancel" || decision.includes("revision")) return "warning";
  if (decision === "approve_queue" || decision === "start_execution" || decision.startsWith("accept")) return "attention";
  return "info";
}

function compareTimelineItems(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const left = parseDbTimestamp(stringFromUnknown(a.timestamp) ?? "");
  const right = parseDbTimestamp(stringFromUnknown(b.timestamp) ?? "");
  if (right !== left) return right - left;
  return String(b.timelineId ?? "").localeCompare(String(a.timelineId ?? ""));
}

function formatPolicy(row: ToolContextPolicyRow): Record<string, unknown> {
  return {
    policyId: row.id,
    workspaceRoot: row.workspace_root,
    projectPath: row.project_path,
    grantKey: row.grant_key,
    grantKind: row.grant_kind,
    value: safeJsonValue(row.value_json),
    status: row.status,
    decidedBySessionId: row.decided_by_session_id,
    decidedByAgentId: row.decided_by_agent_id,
    decidedAt: row.ts_decided
  };
}

function formatStaleRecovery(row: StaleWorkerRow): Record<string, unknown> {
  return {
    queueTask: formatQueueTask(row),
    queueTaskId: row.id,
    fabricTaskId: row.fabric_task_id ?? undefined,
    workerRunId: row.worker_run_id ?? undefined,
    workerStatus: row.worker_status ?? undefined,
    workerStartedAt: row.worker_ts_started ?? undefined,
    workerUpdatedAt: row.worker_ts_updated ?? undefined,
    workerMaxRuntimeMinutes: row.worker_max_runtime_minutes ?? undefined,
    reason: row.stale_reason
  };
}

function formatModelApproval(row: ApprovalRequestWithPreflightRow, nowIso: string): Record<string, unknown> {
  return {
    requestId: row.preflight_request_id,
    approvalRequestId: row.id,
    createdAt: row.ts_created,
    expiresAt: row.expires_at,
    expired: Date.parse(row.expires_at) <= Date.parse(nowIso),
    status: row.status,
    client: row.client,
    taskType: row.task_type,
    budgetScope: row.budget_scope,
    task: safeJsonValue(row.task_json),
    selected: {
      provider: row.selected_provider,
      model: row.selected_model,
      reasoning: row.selected_reasoning
    },
    estimate: {
      inputTokens: row.input_tokens,
      reservedOutputTokens: row.reserved_output_tokens,
      estimatedCostUsd: row.estimated_cost_usd
    },
    risk: row.risk,
    warnings: safeJsonArray(row.warnings_json)
  };
}

function safeJsonValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new FabricError("INVALID_INPUT", `Expected string field: ${field}`, false);
  }
  return value;
}

function optionalStringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new FabricError("INVALID_INPUT", `Expected optional string field: ${field}`, false);
  }
  return value;
}

function optionalBooleanField(record: Record<string, unknown>, field: string): boolean | undefined {
  const value = record[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new FabricError("INVALID_INPUT", `Expected optional boolean field: ${field}`, false);
  }
  return value;
}

function stringArrayField(record: Record<string, unknown>, field: string): string[] {
  const value = record[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new FabricError("INVALID_INPUT", `Expected string array field: ${field}`, false);
  }
  return value;
}
