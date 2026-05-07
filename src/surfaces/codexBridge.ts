import { FabricError } from "../runtime/errors.js";
import { getOptionalBoolean, getOptionalNumber, getOptionalString, getString, getStringArray } from "../runtime/input.js";
import { defaultMaxEventsPerLane, maxCodexAgentCount } from "../runtime/limits.js";
import type { CallContext } from "../types.js";
import { collabAsk, collabSend } from "./collab.js";
import type { SurfaceHost } from "./host.js";
import {
  projectQueueApproveModelCalls,
  projectQueueAgentLanes,
  projectQueueCreate,
  projectQueueLaunchPlan,
  projectQueueNextReady,
  projectQueueProgressReport,
  projectQueueTaskDetail,
  projectQueueUpdateTask
} from "./projectQueue.js";

const WORKERS = new Set(["deepseek-direct", "jcode-deepseek"]);
const SENIOR_DEFAULT_WORKER_ENV = "AGENT_FABRIC_SENIOR_DEFAULT_WORKER";
const WORKSPACE_MODES = new Set(["git_worktree", "sandbox"]);
const CARD_GROUPS = new Set(["status", "phase", "workstream", "worker", "risk", "category"]);
const DEFAULT_AGENT_NAMES = [
  "Rami",
  "Belle",
  "Amir",
  "Falak",
  "Gamal",
  "Angela"
];
const CLOSED_STATUSES = new Set(["completed", "done", "failed", "canceled", "cancelled", "accepted"]);

type AgentCard = Record<string, unknown> & {
  agentId: string;
  handle: string;
  displayName: string;
  rawStatus: string;
};

export function fabricSpawnAgents(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const queueId = getString(input, "queueId");
  const count = normalizeCount(getOptionalNumber(input, "count") ?? 10);
  const worker = normalizeValue(getOptionalString(input, "worker") ?? seniorDefaultWorker(), WORKERS, "worker");
  const workspaceMode = normalizeValue(getOptionalString(input, "workspaceMode") ?? "git_worktree", WORKSPACE_MODES, "workspaceMode");
  const modelProfile = getOptionalString(input, "modelProfile") ?? "deepseek-v4-pro:max";
  const maxRuntimeMinutes = getOptionalNumber(input, "maxRuntimeMinutes");
  const allowPartial = getOptionalBoolean(input, "allowPartial") ?? false;
  const planOnly = getOptionalBoolean(input, "planOnly") ?? false;
  const next = projectQueueNextReady(host, { queueId, limit: count }, context);
  const ready = arrayFrom(next.ready);
  const existing = numberFrom(projectQueueAgentLanes(host, { queueId, includeCompleted: true, maxEventsPerLane: 1 }, context).count);
  const availableSlots = numberFrom(next.availableSlots);
  const activeWorkers = numberFrom(next.activeWorkers);
  const capacity = Math.min(ready.length, availableSlots);
  if (next.executionBlocked || next.workerStartBlocked) {
    return {
      schema: "agent-fabric.codex-agents.v1",
      status: "capacity_blocked",
      queueId,
      requested: count,
      started: 0,
      queued: count,
      activeWorkers,
      availableSlots,
      readyCount: ready.length,
      executionBlocked: true,
      blockedReason: stringFrom(next.blockedReason) ?? stringFrom(next.workerStartBlockedReason) ?? "queue is not open for worker starts",
      nextAction: "Approve the queue and issue start_execution, or use senior-run to prepare and start the queue.",
      cards: []
    };
  }

  if (!allowPartial && capacity < count) {
    return {
      schema: "agent-fabric.codex-agents.v1",
      status: "capacity_blocked",
      queueId,
      requested: count,
      started: 0,
      queued: Math.max(0, count - capacity),
      activeWorkers,
      availableSlots,
      readyCount: ready.length,
      executionBlocked: Boolean(next.executionBlocked || next.workerStartBlocked),
      blockedReason: stringFrom(next.blockedReason) ?? stringFrom(next.workerStartBlockedReason) ?? (ready.length === 0 ? "no ready tasks are available" : "not enough ready worker slots"),
      nextAction: ready.length === 0 ? "Add/import queue tasks, approve the queue, and start execution before spawning Senior workers." : "Reduce count, enable allowPartial, or wait for worker slots.",
      cards: []
    };
  }

  const toStart = Math.min(count, capacity);
  const launchPlan = projectQueueLaunchPlan(host, { queueId, limit: toStart }, childContext(context, "launch-plan"));
  const queue = objectFrom(launchPlan.queue);
  const projectPath = stringFrom(queue.projectPath);
  const planned = arrayFrom(launchPlan.launchable).slice(0, toStart);
  const blocked = [...arrayFrom(launchPlan.approvalRequired), ...arrayFrom(launchPlan.waitingForStart), ...arrayFrom(launchPlan.blocked)];
  const plannedCards = planned.map((entry, index) =>
    plannedAgentCard(queueId, entry, existing + index, { worker, workspaceMode, modelProfile, maxRuntimeMinutes })
  );
  const listed = fabricListAgents(host, { queueId, includeCompleted: true, maxEventsPerLane: defaultMaxEventsPerLane() }, context);
  const runnerCommand = [
    "agent-fabric-project",
    "run-ready",
    ...(projectPath ? ["--project", projectPath] : []),
    "--queue",
    queueId,
    "--worker",
    worker,
    "--workspace-mode",
    workspaceMode,
    "--model-profile",
    modelProfile,
    "--parallel",
    String(toStart),
    "--task-packet-dir",
    projectPath ? `${projectPath.replace(/\/+$/, "")}/.agent-fabric/task-packets` : ".agent-fabric/task-packets",
    "--cwd-template",
    projectPath ? `${projectPath.replace(/\/+$/, "")}/.agent-fabric/worktrees/{{queueTaskId}}` : ".agent-fabric/worktrees/{{queueTaskId}}",
    "--approve-tool-context"
  ];
  if (maxRuntimeMinutes) runnerCommand.push("--max-runtime-minutes", String(maxRuntimeMinutes));
  return {
    schema: "agent-fabric.codex-agents.v1",
    status: planOnly ? "planned" : "runner_required",
    queueId,
    requested: count,
    started: 0,
    planned: plannedCards.length,
    queued: Math.max(0, count - plannedCards.length),
    activeWorkers,
    availableSlots,
    readyCount: ready.length,
    planOnly,
    runnerBacked: false,
    launchSource: "fabric_spawn_agents",
    nextAction:
      plannedCards.length === 0
        ? "No launchable tasks are ready. Add/import tasks, approve required tool/model context, and start queue execution."
        : "Start real runner processes with agent-fabric-project run-ready; fabric_spawn_agents does not create runnerless running cards.",
    runnerCommand: runnerCommand.map(shellQuoteIfNeeded).join(" "),
    launchPlan,
    blocked,
    cards: [...plannedCards, ...arrayFrom(listed.cards)]
  };
}

export function fabricSeniorStart(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  let queueId = getOptionalString(input, "queueId");
  if (!queueId) {
    const projectPath = getString(input, "projectPath");
    const created = projectQueueCreate(
      host,
      {
        projectPath,
        promptSummary: getOptionalString(input, "promptSummary") ?? "Senior-mode Agent Fabric run.",
        title: getOptionalString(input, "title") ?? "Senior Agent Fabric run",
        pipelineProfile: "fast",
        maxParallelAgents: getOptionalNumber(input, "count") ?? 10
      },
      childContext(context, "create")
    );
    queueId = String(created.queueId);
  }
  const approveModelCalls = getOptionalBoolean(input, "approveModelCalls") ?? false;
  const modelApproval = approveModelCalls
    ? projectQueueApproveModelCalls(host, { queueId, note: "Approved by fabric_senior_start." }, childContext(context, "approve-model-calls"))
    : undefined;
  const spawn = fabricSpawnAgents(
    host,
    {
      queueId,
      count: getOptionalNumber(input, "count") ?? 10,
      worker: getOptionalString(input, "worker") ?? seniorDefaultWorker(),
      workspaceMode: "git_worktree",
      modelProfile: getOptionalString(input, "modelProfile") ?? "deepseek-v4-pro:max",
      allowPartial: getOptionalBoolean(input, "allowPartial") ?? false
    },
    childContext(context, "spawn")
  );
  const progress = projectQueueProgressReport(host, { queueId, maxEventsPerLane: defaultMaxEventsPerLane() }, context);
  return {
    schema: "agent-fabric.senior-start.v1",
    queueId,
    sourceOfTruth: "agent-fabric.queue",
    modelApproval,
    spawn,
    progress
  };
}

function seniorDefaultWorker(): "deepseek-direct" | "jcode-deepseek" {
  const configured = process.env[SENIOR_DEFAULT_WORKER_ENV]?.trim();
  if (!configured) return "deepseek-direct";
  if (configured === "deepseek-direct" || configured === "jcode-deepseek") return configured;
  throw new FabricError("INVALID_INPUT", `${SENIOR_DEFAULT_WORKER_ENV} must be deepseek-direct or jcode-deepseek`, false);
}

export function fabricSeniorStatus(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const queueId = getString(input, "queueId");
  const maxEventsPerLane = getOptionalNumber(input, "maxEventsPerLane") ?? defaultMaxEventsPerLane();
  const cards = fabricListAgents(host, { queueId, includeCompleted: true, maxEventsPerLane }, context);
  const progress = projectQueueProgressReport(host, { queueId, maxEventsPerLane }, context);
  return {
    schema: "agent-fabric.senior-status.v1",
    queueId,
    sourceOfTruth: "agent-fabric.queue",
    cards,
    progress
  };
}

export function fabricSeniorResume(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const status = fabricSeniorStatus(host, input, context);
  const progress = objectFrom(status.progress);
  return {
    schema: "agent-fabric.senior-resume.v1",
    ...status,
    nextCommand: stringFrom(progress.nextCommand),
    resumeHint: "Use fabric_open_agent for worker detail, fabric_message_agent for revisions, and fabric_accept_patch only after senior review metadata is present."
  };
}

export function fabricListAgents(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const queueId = getString(input, "queueId");
  const includeCompleted = getOptionalBoolean(input, "includeCompleted") ?? false;
  const maxEventsPerLane = getOptionalNumber(input, "maxEventsPerLane") ?? defaultMaxEventsPerLane();
  const pageSize = normalizeOptionalPageSize(getOptionalNumber(input, "pageSize"));
  const page = normalizeOptionalPage(getOptionalNumber(input, "page"), pageSize);
  const groupBy = normalizeOptionalGroupBy(getOptionalString(input, "groupBy"));
  const lanes = projectQueueAgentLanes(host, { queueId, includeCompleted, maxEventsPerLane }, context);
  const laneRows = arrayFrom(lanes.lanes);
  const cards = laneRows
    .map((lane, index) => laneCard(queueId, lane, index))
    .sort((left, right) => numberFrom(left.nameIndex) - numberFrom(right.nameIndex) || left.displayName.localeCompare(right.displayName));
  const visibleCards = pageSize ? cards.slice((page - 1) * pageSize, page * pageSize) : cards;
  return {
    schema: "agent-fabric.codex-agents.v1",
    queue: lanes.queue,
    queueId,
    mentionPrefix: "@af/",
    count: cards.length,
    returnedCount: visibleCards.length,
    activeCount: cards.filter((card) => !CLOSED_STATUSES.has(String(card.rawStatus).toLowerCase())).length,
    pagination: pageSize
      ? {
          page,
          pageSize,
          total: cards.length,
          pageCount: Math.ceil(cards.length / pageSize),
          hasNextPage: page * pageSize < cards.length,
          hasPreviousPage: page > 1
        }
      : undefined,
    groupBy: groupBy ?? undefined,
    groups: groupBy ? groupAgentCards(cards, groupBy, pageSize ?? 20) : undefined,
    cards: visibleCards
  };
}

export function fabricOpenAgent(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const queueId = getString(input, "queueId");
  const agent = getString(input, "agent");
  const resolved = resolveAgentLane(host, queueId, agent, context);
  const task = objectFrom(resolved.lane.queueTask);
  const run = objectFrom(resolved.lane.workerRun);
  const detail = projectQueueTaskDetail(
    host,
    {
      queueId,
      queueTaskId: String(task.queueTaskId),
      includeResume: true,
      preferredWorker: stringFrom(run.worker),
      maxEventsPerRun: getOptionalNumber(input, "maxEventsPerRun") ?? 10
    },
    context
  );
  return {
    schema: "agent-fabric.codex-agent-detail.v1",
    queueId,
    card: resolved.card,
    detail,
    transcript: {
      latestEvent: resolved.lane.latestEvent,
      recentEvents: resolved.lane.recentEvents,
      latestCheckpoint: resolved.lane.latestCheckpoint
    },
    artifacts: {
      patchRefs: valuesFrom(task.patchRefs),
      testRefs: valuesFrom(task.testRefs)
    }
  };
}

export function fabricMessageAgent(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const queueId = getString(input, "queueId");
  const agent = getString(input, "agent");
  const body = getString(input, "body");
  const kind = getOptionalString(input, "kind") ?? "worker_revision";
  const ask = getOptionalBoolean(input, "ask") ?? false;
  const resolved = resolveAgentLane(host, queueId, agent, context);
  const task = objectFrom(resolved.lane.queueTask);
  const queueTaskId = String(task.queueTaskId ?? "");
  const refs = [
    `project_queue:${queueId}`,
    queueTaskId ? `project_queue_task:${queueTaskId}` : undefined,
    `queue:${queueId}`,
    queueTaskId ? `queueTask:${queueTaskId}` : undefined,
    `workerRun:${resolved.card.agentId}`,
    ...getStringArray(input, "refs")
  ].filter((ref): ref is string => Boolean(ref));
  const payload = ask
    ? collabAsk(
        host,
        {
          to: resolved.card.handle,
          kind,
          question: body,
          refs,
          urgency: getOptionalString(input, "urgency")
        },
        childContext(context, "ask")
      )
    : collabSend(
        host,
        {
          to: resolved.card.handle,
          body,
          refs,
          kind
        },
        childContext(context, "send")
      );
  return {
    schema: "agent-fabric.codex-agent-message.v1",
    queueId,
    card: resolved.card,
    deliveredTo: resolved.card.handle,
    mode: ask ? "ask" : "send",
    result: payload
  };
}

export function fabricWaitAgents(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const queueId = getString(input, "queueId");
  const requestedAgents = getStringArray(input, "agents");
  const targetStatuses = new Set(getStringArray(input, "targetStatuses").map((status) => status.toLowerCase()));
  const listed = fabricListAgents(host, { queueId, includeCompleted: true, maxEventsPerLane: getOptionalNumber(input, "maxEventsPerLane") ?? defaultMaxEventsPerLane() }, context);
  const cards = arrayFrom(listed.cards).filter((card) => requestedAgents.length === 0 || requestedAgents.some((agent) => agentMatchesCard(agent, card)));
  const done = cards.every((card) => {
    const status = String(card.rawStatus ?? "").toLowerCase();
    return targetStatuses.size > 0 ? targetStatuses.has(status) : CLOSED_STATUSES.has(status);
  });
  return {
    schema: "agent-fabric.codex-agent-wait.v1",
    queueId,
    status: done ? "done" : "waiting",
    done,
    count: cards.length,
    cards
  };
}

export function fabricAcceptPatch(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const queueId = getString(input, "queueId");
  const agent = getOptionalString(input, "agent");
  const queueTaskId = getOptionalString(input, "queueTaskId");
  const reviewedBy = getOptionalString(input, "reviewedBy");
  const reviewSummary = getOptionalString(input, "reviewSummary") ?? getOptionalString(input, "summary");
  if (!agent && !queueTaskId) {
    throw new FabricError("INVALID_INPUT", "fabric_accept_patch requires agent or queueTaskId", false);
  }
  if (!reviewedBy || !reviewSummary) {
    throw new FabricError("PATCH_REVIEW_REQUIRED", "fabric_accept_patch requires reviewedBy and reviewSummary so worker output cannot be accepted without senior review metadata.", false);
  }
  const resolved = agent ? resolveAgentLane(host, queueId, agent, context) : resolveAgentLane(host, queueId, queueTaskId as string, context);
  const task = objectFrom(resolved.lane.queueTask);
  const status = String(task.status ?? "");
  if (!["patch_ready", "review", "accepted"].includes(status)) {
    throw new FabricError("PATCH_NOT_READY", `Agent ${resolved.card.handle} is attached to task ${String(task.queueTaskId)} with status ${status}`, false);
  }
  const patchRefs = valuesFrom(task.patchRefs).filter((ref): ref is string => typeof ref === "string");
  if (patchRefs.length === 0) {
    throw new FabricError("PATCH_NOT_READY", `Task ${String(task.queueTaskId)} has no patch refs to accept`, false);
  }
  const updated = projectQueueUpdateTask(
    host,
    {
      queueId,
      queueTaskId: String(task.queueTaskId),
      status: "accepted",
      summary: `Accepted patch from ${resolved.card.handle}. Reviewed by ${reviewedBy}: ${reviewSummary}`,
      patchRefs,
      testRefs: valuesFrom(task.testRefs).filter((ref): ref is string => typeof ref === "string")
    },
    childContext(context, "accept")
  );
  return {
    schema: "agent-fabric.codex-agent-accept-patch.v1",
    queueId,
    card: resolved.card,
    acceptedTask: updated,
    patchRefs,
    review: {
      reviewedBy,
      reviewSummary
    }
  };
}

function resolveAgentLane(
  host: SurfaceHost,
  queueId: string,
  agent: string,
  context: CallContext
): { lane: Record<string, unknown>; card: AgentCard } {
  const listed = fabricListAgents(host, { queueId, includeCompleted: true, maxEventsPerLane: 10 }, context);
  const cards = arrayFrom(listed.cards);
  const lanes = arrayFrom(projectQueueAgentLanes(host, { queueId, includeCompleted: true, maxEventsPerLane: 10 }, context).lanes);
  const cardIndex = cards.findIndex((card) => agentMatchesCard(agent, card));
  if (cardIndex < 0) throw new FabricError("FABRIC_AGENT_NOT_FOUND", `No Agent Fabric worker matches ${agent}`, false);
  const card = cards[cardIndex] as AgentCard;
  const cardTaskId = objectFrom(card.task).queueTaskId;
  const lane =
    lanes.find((candidate) => String(objectFrom(candidate.queueTask).queueTaskId ?? "") === String(cardTaskId ?? "")) ??
    lanes.find((candidate) => String(objectFrom(candidate.workerRun).workerRunId ?? candidate.laneId ?? "") === card.agentId);
  if (!lane) throw new FabricError("FABRIC_AGENT_NOT_FOUND", `No Agent Fabric lane matches ${agent}`, false);
  return { lane, card };
}

function laneCard(queueId: string, lane: Record<string, unknown>, index: number): AgentCard {
  const task = objectFrom(lane.queueTask);
  const run = objectFrom(lane.workerRun);
  const progress = objectFrom(lane.progress);
  const metadata = objectFrom(run.metadata);
  const orchestrationMetadata = objectFrom(metadata.orchestration);
  const codexBridge = objectFrom(metadata.codexBridge);
  const agentId = String(run.workerRunId ?? lane.laneId ?? task.queueTaskId ?? `agent-${index + 1}`);
  const displayName = stringFrom(codexBridge.displayName) ?? agentNameForIndex(index);
  const handle = `@af/${slug(displayName)}-${agentId.slice(-6)}`;
  const rawStatus = String(task.status ?? run.status ?? progress.status ?? "unknown");
  const patchRefs = valuesFrom(task.patchRefs);
  const recentEvents = valuesFrom(lane.recentEvents);
  const latestCheckpoint = objectFrom(lane.latestCheckpoint);
  const eventKinds = new Set(recentEvents.map((event) => stringFrom(objectFrom(event).kind)).filter((kind): kind is string => Boolean(kind)));
  const latestEvent = objectFrom(lane.latestEvent);
  const spawnedEvent = recentEvents.find((event) => stringFrom(objectFrom(event).kind) === "command_spawned");
  const spawnedMetadata = objectFrom(objectFrom(spawnedEvent).metadata);
  const hasRunnerEvidence =
    eventKinds.has("command_spawned") ||
    eventKinds.has("command_started") ||
    eventKinds.has("command_finished") ||
    eventKinds.has("test_result") ||
    eventKinds.has("file_changed") ||
    eventKinds.has("checkpoint") ||
    Object.keys(latestCheckpoint).length > 0;
  const runnerProcessState = runnerState(rawStatus, String(run.status ?? ""), hasRunnerEvidence);
  const noRunner = runnerProcessState === "no_runner";
  const pid = numberFrom(spawnedMetadata.pid);
  const laneCost = objectFrom(lane.cost);
  const costByRole = objectFrom(laneCost.byRole) as Record<string, { count: number; costUsd: number }> | undefined;
  const aggregatedCostRoles: Record<string, unknown> = {};
  if (costByRole) {
    for (const [role, entry] of Object.entries(costByRole)) {
      aggregatedCostRoles[role] = { count: entry.count, costUsd: entry.costUsd };
    }
  }
  return {
    agentId,
    handle,
    displayName,
    nameIndex: typeof codexBridge.nameIndex === "number" ? codexBridge.nameIndex : index,
    role: stringFrom(metadata.role) ?? stringFrom(codexBridge.role) ?? "worker",
    workerKind: stringFrom(run.worker) ?? "worker",
    modelProfile: stringFrom(run.modelProfile),
    rawStatus,
    status: noRunner ? "No runner" : stringFrom(progress.label) ?? rawStatus,
    currentStep: noRunner
      ? "Worker card is registered, but no runner process evidence has been recorded."
      : stringFrom(progress.nextAction) ?? stringFrom(progress.summary) ?? stringFrom(latestEvent.body),
    runnerProcessState,
    pid: pid > 0 ? pid : undefined,
    runnerStartedAt: stringFrom(run.startedAt),
    lastHeartbeatAt: stringFrom(run.updatedAt) ?? stringFrom(progress.lastActivityAt),
    runnerLogPath: stringFrom(metadata.runnerLogPath) ?? stringFrom(spawnedMetadata.runnerLogPath),
    taskPacketPath: stringFrom(metadata.taskPacketPath) ?? stringFrom(spawnedMetadata.taskPacketPath),
    contextFilePath: stringFrom(metadata.contextFilePath) ?? stringFrom(spawnedMetadata.contextFilePath),
    launchSource: stringFrom(metadata.source) ?? stringFrom(objectFrom(metadata.codexBridge).source),
    unreadAskCount: 0,
    patchState: patchRefs.length > 0 ? (rawStatus === "accepted" ? "accepted" : "ready") : "none",
    patchReady: rawStatus === "patch_ready" && patchRefs.length > 0,
    reviewState: rawStatus === "accepted" ? "accepted_after_review" : rawStatus === "patch_ready" ? "needs_senior_review" : "not_ready",
    sourceOfTruth: "agent-fabric.queue",
    cost: {
      sourceLabel: stringFrom(laneCost.sourceLabel) ?? "none",
      totalCostUsd: numberFrom(laneCost.totalCostUsd),
      byRole: aggregatedCostRoles,
      eventCount: numberFrom(laneCost.eventCount),
      eventsWithCost: numberFrom(laneCost.eventsWithCost),
      coverageWarning: stringFrom(laneCost.coverageWarning) ?? null
    },
    task: {
      queueTaskId: task.queueTaskId,
      title: task.title,
      status: task.status,
      phase: task.phase,
      managerId: task.managerId,
      parentManagerId: task.parentManagerId,
      parentQueueId: task.parentQueueId,
      workstream: task.workstream,
      costCenter: task.costCenter,
      escalationTarget: task.escalationTarget,
      category: task.category,
      priority: task.priority,
      risk: task.risk,
      parallelGroup: task.parallelGroup
    },
    orchestration: {
      phase: task.phase,
      workstream: task.workstream ?? orchestrationMetadata.workstream ?? task.parallelGroup ?? task.phase,
      category: task.category,
      priority: task.priority,
      risk: task.risk,
      managerId: stringFrom(task.managerId) ?? stringFrom(metadata.managerId) ?? stringFrom(orchestrationMetadata.managerId) ?? stringFrom(codexBridge.managerId),
      parentManagerId:
        stringFrom(task.parentManagerId) ?? stringFrom(metadata.parentManagerId) ?? stringFrom(orchestrationMetadata.parentManagerId) ?? stringFrom(codexBridge.parentManagerId),
      parentQueueId: stringFrom(task.parentQueueId) ?? stringFrom(metadata.parentQueueId) ?? stringFrom(orchestrationMetadata.parentQueueId) ?? stringFrom(codexBridge.parentQueueId),
      costCenter: stringFrom(task.costCenter) ?? stringFrom(metadata.costCenter) ?? stringFrom(orchestrationMetadata.costCenter) ?? stringFrom(codexBridge.costCenter),
      escalationTarget:
        stringFrom(task.escalationTarget) ?? stringFrom(metadata.escalationTarget) ?? stringFrom(orchestrationMetadata.escalationTarget) ?? stringFrom(codexBridge.escalationTarget)
    },
    workspace: {
      mode: run.workspaceMode,
      path: run.workspacePath
    },
    open: {
      tool: "fabric_open_agent",
      input: { queueId, agent: handle },
      desktopPath: task.queueTaskId ? `/api/queues/${encodeURIComponent(queueId)}/tasks/${encodeURIComponent(String(task.queueTaskId))}` : undefined
    },
    lifecycleEvents: recentEvents,
    checkpoint: latestCheckpoint,
    artifacts: {
      patchRefs,
      testRefs: valuesFrom(task.testRefs)
    }
  };
}

function plannedAgentCard(
  queueId: string,
  entry: Record<string, unknown>,
  index: number,
  options: { worker: string; workspaceMode: string; modelProfile: string; maxRuntimeMinutes?: number }
): AgentCard {
  const task = objectFrom(entry.task);
  const queueTaskId = String(task.queueTaskId ?? `planned-${index + 1}`);
  const displayName = agentNameForIndex(index);
  const agentId = `planned:${queueTaskId}`;
  return {
    agentId,
    handle: `@af/${slug(displayName)}-${queueTaskId.slice(-6)}`,
    displayName,
    nameIndex: index,
    role: "worker",
    workerKind: options.worker,
    modelProfile: options.modelProfile,
    rawStatus: "planned",
    status: "planned",
    currentStep: "Ready to launch through agent-fabric-project run-ready.",
    runnerProcessState: "planned",
    pid: undefined,
    runnerStartedAt: undefined,
    lastHeartbeatAt: undefined,
    runnerLogPath: undefined,
    taskPacketPath: undefined,
    contextFilePath: undefined,
    launchSource: "fabric_spawn_agents:plan",
    unreadAskCount: 0,
    patchState: "none",
    patchReady: false,
    reviewState: "not_ready",
    sourceOfTruth: "agent-fabric.queue",
    cost: {
      sourceLabel: "none",
      totalCostUsd: 0,
      byRole: {},
      eventCount: 0,
      eventsWithCost: 0,
      coverageWarning: "planned: task has not been claimed by a worker run yet"
    },
    task: {
      queueTaskId,
      title: task.title,
      status: task.status ?? "queued",
      phase: task.phase,
      managerId: task.managerId,
      parentManagerId: task.parentManagerId,
      parentQueueId: task.parentQueueId,
      workstream: task.workstream,
      costCenter: task.costCenter,
      escalationTarget: task.escalationTarget,
      category: task.category,
      priority: task.priority,
      risk: task.risk,
      parallelGroup: task.parallelGroup
    },
    orchestration: {
      phase: task.phase,
      managerId: task.managerId,
      parentManagerId: task.parentManagerId,
      parentQueueId: task.parentQueueId,
      workstream: task.workstream ?? task.parallelGroup ?? task.phase,
      costCenter: task.costCenter,
      escalationTarget: task.escalationTarget,
      category: task.category,
      priority: task.priority,
      risk: task.risk
    },
    workspace: {
      mode: options.workspaceMode,
      path: undefined
    },
    maxRuntimeMinutes: options.maxRuntimeMinutes,
    open: {
      tool: "fabric_open_agent",
      input: { queueId, agent: queueTaskId },
      desktopPath: `/api/queues/${encodeURIComponent(queueId)}/tasks/${encodeURIComponent(queueTaskId)}`
    },
    lifecycleEvents: [],
    checkpoint: {},
    artifacts: {
      patchRefs: [],
      testRefs: []
    }
  };
}

function runnerState(rawTaskStatus: string, rawRunStatus: string, hasRunnerEvidence: boolean): string {
  const taskStatus = rawTaskStatus.toLowerCase();
  const runStatus = rawRunStatus.toLowerCase();
  if (taskStatus === "patch_ready" || runStatus === "patch_ready") return "patch_ready";
  if (CLOSED_STATUSES.has(taskStatus) || CLOSED_STATUSES.has(runStatus)) return taskStatus || runStatus;
  if ((taskStatus === "running" || runStatus === "running") && !hasRunnerEvidence) return "no_runner";
  if (taskStatus === "running" || runStatus === "running") return "running";
  if (taskStatus === "queued" || taskStatus === "ready") return "planned";
  return taskStatus || runStatus || "unknown";
}

function agentMatchesCard(agent: string, card: Record<string, unknown>): boolean {
  const normalized = agent.toLowerCase();
  return [card.agentId, card.handle, card.displayName, objectFrom(card.task).queueTaskId]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase() === normalized || value.toLowerCase().replace(/^@af\//, "") === normalized.replace(/^@af\//, ""));
}

function normalizeCount(value: number): number {
  const max = maxCodexAgentCount();
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new FabricError("INVALID_INPUT", `count must be an integer between 1 and ${max}`, false);
  }
  return value;
}

function normalizeOptionalPage(value: number | undefined, pageSize: number | undefined): number {
  if (value === undefined) return pageSize ? 1 : 1;
  if (!Number.isInteger(value) || value < 1) {
    throw new FabricError("INVALID_INPUT", "page must be a positive integer", false);
  }
  return value;
}

function normalizeOptionalPageSize(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new FabricError("INVALID_INPUT", "pageSize must be an integer between 1 and 500", false);
  }
  return value;
}

function normalizeOptionalGroupBy(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (CARD_GROUPS.has(value)) return value;
  throw new FabricError("INVALID_INPUT", `groupBy must be one of: ${[...CARD_GROUPS].join(", ")}`, false);
}

function groupAgentCards(cards: AgentCard[], groupBy: string, maxItemsPerGroup: number): Array<Record<string, unknown>> {
  const groups = new Map<string, AgentCard[]>();
  for (const card of cards) {
    const key = cardGroupKey(card, groupBy);
    const group = groups.get(key) ?? [];
    group.push(card);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
    .map(([key, group]) => ({
      key,
      count: group.length,
      omitted: Math.max(0, group.length - maxItemsPerGroup),
      cards: group.slice(0, maxItemsPerGroup)
    }));
}

function cardGroupKey(card: AgentCard, groupBy: string): string {
  const task = objectFrom(card.task);
  const orchestration = objectFrom(card.orchestration);
  if (groupBy === "status") return String(card.rawStatus ?? "unknown");
  if (groupBy === "worker") return String(card.workerKind ?? "unknown");
  if (groupBy === "phase") return stringFrom(orchestration.phase) ?? stringFrom(task.phase) ?? "unassigned";
  if (groupBy === "workstream") return stringFrom(orchestration.workstream) ?? stringFrom(task.parallelGroup) ?? stringFrom(task.phase) ?? "unassigned";
  if (groupBy === "risk") return stringFrom(orchestration.risk) ?? stringFrom(task.risk) ?? "unknown";
  if (groupBy === "category") return stringFrom(orchestration.category) ?? stringFrom(task.category) ?? "unknown";
  return "unknown";
}

function normalizeValue(value: string, allowed: Set<string>, field: string): string {
  if (allowed.has(value)) return value;
  throw new FabricError("INVALID_INPUT", `${field} must be one of: ${[...allowed].join(", ")}`, false);
}

function childContext(context: CallContext, suffix: string): CallContext {
  return { ...context, idempotencyKey: context.idempotencyKey ? `${context.idempotencyKey}:${suffix}` : suffix };
}

function arrayFrom(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function valuesFrom(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function objectFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberFrom(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function agentNameForIndex(index: number): string {
  const base = DEFAULT_AGENT_NAMES[index % DEFAULT_AGENT_NAMES.length];
  const round = Math.floor(index / DEFAULT_AGENT_NAMES.length);
  return round === 0 ? base : `${base}-${round + 1}`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

function shellQuoteIfNeeded(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
