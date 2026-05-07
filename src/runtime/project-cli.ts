import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { FabricError } from "./errors.js";
import { formatLocalConfigDoctor, runLocalConfigDoctor } from "./local-config-doctor.js";
import { defaultMaxEventsPerLane, seniorDefaultLaneCount, seniorMaxLaneCount } from "./limits.js";
import { applyPatchWithSystemPatch, checkPatchWithSystemPatch, computePatchDiffStats, validateGitStylePatch } from "./patches.js";

type WorkerKind =
  | "ramicode"
  | "local-cli"
  | "openhands"
  | "aider"
  | "smolagents"
  | "codex-app-server"
  | "deepseek-direct"
  | "jcode-deepseek"
  | "manual";
type CwdPrepMode = "auto" | "none" | "mkdir";
type DeepSeekRole = "auto" | "implementer" | "reviewer" | "risk-reviewer" | "adjudicator" | "planner";
type SensitiveContextMode = "basic" | "strict" | "off";
const SENIOR_MODE_ENV = "AGENT_FABRIC_SENIOR_MODE";
const SENIOR_ALLOW_NON_DEEPSEEK_WORKERS_ENV = "AGENT_FABRIC_SENIOR_ALLOW_NON_DEEPSEEK_WORKERS";
const SENIOR_DEFAULT_WORKER_ENV = "AGENT_FABRIC_SENIOR_DEFAULT_WORKER";
const SENIOR_DEFAULT_WORKER = "deepseek-direct" as const;
const SENIOR_DEFAULT_WORKSPACE_MODE: "git_worktree" = "git_worktree";
const SENIOR_DEFAULT_MODEL_PROFILE = "deepseek-v4-pro:max";
const SENIOR_DEFAULT_LANE_COUNT = 10;
const SENIOR_DEEPSEEK_WORKERS = new Set<WorkerKind>(["deepseek-direct", "jcode-deepseek"]);
const WORKER_HEARTBEAT_MS = Number(process.env.AGENT_FABRIC_WORKER_HEARTBEAT_MS ?? process.env.AGENT_FABRIC_JCODE_HEARTBEAT_MS ?? 30_000);
const TASK_CONTEXT_MAX_FILE_BYTES = 48_000;
const TASK_CONTEXT_MAX_TOTAL_BYTES = 180_000;
const SHARED_DAEMON_GUARDRAIL =
  "Automated agents must not kill, restart, or remove the shared Agent Fabric daemon/socket. Ask the operator to restart/relink the canonical daemon, or use an isolated AGENT_FABRIC_HOME/socket for experiments.";
const SHARED_DAEMON_FORBIDDEN_AGENT_ACTIONS = ["kill-daemon", "restart-shared-daemon", "remove-shared-socket", "recover-live-queue-without-review"];
const SHARED_DAEMON_SAFE_AGENT_ACTIONS = [
  "run read-only doctor/status checks",
  "switch to the checkout that already owns the daemon",
  "ask the operator to restart or relink the canonical daemon",
  "use an isolated AGENT_FABRIC_HOME/socket before running worktree-local experiments"
];

export type ProjectCliCommand =
  | { command: "version"; json: boolean }
  | {
      command: "local-config-doctor";
      json: boolean;
      projectPath?: string;
    }
  | {
      command: "create";
      json: boolean;
      projectPath: string;
      prompt?: string;
      promptFile?: string;
      promptSummary?: string;
      title?: string;
      pipelineProfile: "fast" | "balanced" | "careful" | "custom";
      maxParallelAgents: number;
    }
  | {
      command: "demo-seed";
      json: boolean;
      projectPath: string;
      title?: string;
      maxParallelAgents: number;
    }
  | {
      command: "start-plan";
      json: boolean;
      queueId: string;
      task?: string;
      taskFile?: string;
      maxRounds?: number;
      budgetUsd?: number;
      outputFormat?: "markdown" | "adr";
    }
  | {
      command: "configure";
      json: boolean;
      queueId: string;
      title?: string;
      pipelineProfile?: "fast" | "balanced" | "careful" | "custom";
      maxParallelAgents?: number;
      note?: string;
    }
  | {
      command: "improve-prompt";
      json: boolean;
      queueId: string;
      prompt?: string;
      promptFile?: string;
      factorsFile?: string;
      modelAlias: string;
      approvalToken?: string;
      accept: boolean;
      outputFile?: string;
    }
  | {
      command: "generate-tasks";
      json: boolean;
      queueId: string;
      planFile: string;
      modelAlias: string;
      approvalToken?: string;
      tasksFile?: string;
      approveQueue: boolean;
    }
  | {
      command: "review-queue";
      json: boolean;
      queueId: string;
      approveQueue: boolean;
    }
  | {
      command: "decide-queue";
      json: boolean;
      queueId: string;
      decision: string;
      note?: string;
    }
  | {
      command: "claim-next";
      json: boolean;
      queueId: string;
      workerRunId?: string;
      worker?: WorkerKind;
      workspaceMode?: "in_place" | "git_worktree" | "clone" | "sandbox";
      workspacePath?: string;
      modelProfile?: string;
      contextPolicy?: string;
      maxRuntimeMinutes?: number;
      commandLine?: string;
    }
  | {
      command: "prepare-ready";
      json: boolean;
      queueId: string;
      limit?: number;
    }
  | {
      command: "launch-plan";
      json: boolean;
      queueId: string;
      limit?: number;
    }
  | {
      command: "recover-stale";
      json: boolean;
      queueId: string;
      staleAfterMinutes?: number;
      action: "requeue" | "fail";
      dryRun: boolean;
    }
  | {
      command: "cleanup-queues";
      json: boolean;
      projectPath?: string;
      queueId?: string;
      statuses?: string[];
      olderThanDays: number;
      limit?: number;
      dryRun: boolean;
      deleteLinkedTaskHistory: boolean;
    }
  | {
      command: "retry-task";
      json: boolean;
      queueId: string;
      queueTaskId: string;
      reason?: string;
      clearOutputs: boolean;
    }
  | {
      command: "edit-task";
      json: boolean;
      queueId: string;
      queueTaskId: string;
      metadataFile: string;
      rewriteContextRefs?: string[];
      note?: string;
    }
  | {
      command: "review-patches";
      json: boolean;
      queueId: string;
      acceptTaskId?: string;
      applyPatch: boolean;
      applyCwd?: string;
    }
  | {
      command: "write-task-packets";
      json: boolean;
      queueId: string;
      outDir: string;
      format: "json" | "markdown";
      readyOnly: boolean;
    }
  | {
      command: "resume-task";
      json: boolean;
      queueId: string;
      queueTaskId: string;
      preferredWorker?: WorkerKind;
      outputFile?: string;
      format: "json" | "markdown";
    }
  | {
      command: "run-task";
      json: boolean;
      queueId: string;
      queueTaskId: string;
      commandLine: string;
      cwd?: string;
      cwdPrep?: CwdPrepMode;
      taskPacketPath?: string;
      taskPacketFormat?: "json" | "markdown";
      taskContextPath?: string;
      worker: WorkerKind;
      workspaceMode: "in_place" | "git_worktree" | "clone" | "sandbox";
      modelProfile: string;
      maxRuntimeMinutes?: number;
      approvalToken?: string;
      successStatus: "patch_ready" | "completed";
      maxOutputChars: number;
      approveToolContext: boolean;
      rememberToolContext: boolean;
    }
  | {
      command: "run-ready";
      json: boolean;
      projectPath?: string;
      queueId: string;
      commandTemplate?: string;
      cwd?: string;
      cwdTemplate?: string;
      cwdPrep?: CwdPrepMode;
      taskPacketDir?: string;
      taskPacketFormat: "json" | "markdown";
      limit?: number;
      parallel: number;
      allowSharedCwd: boolean;
      worker: WorkerKind;
      workspaceMode: "in_place" | "git_worktree" | "clone" | "sandbox";
      modelProfile: string;
      maxRuntimeMinutes?: number;
      approvalToken?: string;
      successStatus: "patch_ready" | "completed";
      maxOutputChars: number;
      approveToolContext: boolean;
      rememberToolContext: boolean;
      continueOnFailure: boolean;
      adaptiveRateLimit?: boolean;
      minParallel?: number;
      allowConcurrentRunner?: boolean;
    }
  | {
      command: "factory-run";
      json: boolean;
      queueId: string;
      limit?: number;
      parallel: number;
      minParallel: number;
      adaptiveRateLimit: boolean;
      taskPacketDir?: string;
      cwdTemplate?: string;
      deepSeekWorkerCommand: string;
      deepSeekRole: DeepSeekRole;
      sensitiveContextMode: SensitiveContextMode;
      patchMode: "report" | "write";
      approvalToken?: string;
      maxRuntimeMinutes?: number;
      maxOutputChars: number;
      approveToolContext: boolean;
      rememberToolContext: boolean;
      continueOnFailure: boolean;
      startExecution: boolean;
      dryRun: boolean;
      allowSensitiveContext: boolean;
      approveModelCalls: boolean;
      allowConcurrentRunner?: boolean;
    }
  | {
      command: "senior-doctor";
      json: boolean;
      projectPath: string;
      queueId?: string;
    }
  | {
      command: "senior-run";
      json: boolean;
      projectPath?: string;
      queueId?: string;
      planFile?: string;
      tasksFile?: string;
      count: number;
      worker: "deepseek-direct" | "jcode-deepseek";
      approveModelCalls: boolean;
      dryRun: boolean;
      progressFile?: string;
      allowPartial: boolean;
    }
  | {
      command: "progress-report";
      json: boolean;
      queueId: string;
      progressFile?: string;
      maxEventsPerLane?: number;
      managerSummaryLimit?: number;
    }
  | {
      command: "import-tasks";
      json: boolean;
      queueId: string;
      tasksFile: string;
      approveQueue: boolean;
    }
  | {
      command: "list";
      json: boolean;
      projectPath?: string;
      statuses: string[];
      includeClosed: boolean;
      limit?: number;
    }
  | {
      command: "approval-inbox";
      json: boolean;
      projectPath?: string;
      queueId?: string;
      limit?: number;
    }
  | {
      command: "memory-inbox";
      json: boolean;
      status?: string;
      archived: boolean;
      limit?: number;
    }
  | {
      command: "review-memory";
      json: boolean;
      memoryId: string;
      decision: "approve" | "reject" | "archive";
      reason?: string;
    }
  | {
      command: "queue-approvals";
      json: boolean;
      queueId: string;
      includeExpired: boolean;
      limit?: number;
    }
  | {
      command: "lanes";
      json: boolean;
      queueId: string;
      includeCompleted: boolean;
      maxEventsPerLane?: number;
    }
  | {
      command: "fabric-spawn-agents";
      json: boolean;
      queueId: string;
      count: number;
      worker: "deepseek-direct" | "jcode-deepseek";
      workspaceMode: "git_worktree" | "sandbox";
      modelProfile: string;
      maxRuntimeMinutes?: number;
      allowPartial: boolean;
    }
  | {
      command: "fabric-list-agents";
      json: boolean;
      queueId: string;
      includeCompleted: boolean;
      maxEventsPerLane?: number;
    }
  | {
      command: "fabric-open-agent";
      json: boolean;
      queueId: string;
      agent: string;
      maxEventsPerRun?: number;
    }
  | {
      command: "fabric-message-agent";
      json: boolean;
      queueId: string;
      agent: string;
      body: string;
      kind?: string;
      ask: boolean;
      urgency?: string;
      refs: string[];
    }
  | {
      command: "fabric-wait-agents";
      json: boolean;
      queueId: string;
      agents: string[];
      targetStatuses: string[];
      maxEventsPerLane?: number;
    }
  | {
      command: "fabric-accept-patch";
      json: boolean;
      queueId: string;
      agent?: string;
      queueTaskId?: string;
      summary?: string;
      reviewedBy?: string;
      reviewSummary?: string;
    }
  | {
      command: "dashboard";
      json: boolean;
      queueId: string;
      includeCompletedLanes: boolean;
      maxEventsPerLane?: number;
    }
  | {
      command: "review-matrix";
      json: boolean;
      queueId: string;
      limit?: number;
    }
  | {
      command: "task-detail";
      json: boolean;
      queueId: string;
      queueTaskId: string;
      includeResume: boolean;
      preferredWorker?: WorkerKind;
      maxEventsPerRun?: number;
    }
  | {
      command: "timeline";
      json: boolean;
      queueId: string;
      limit?: number;
    }
  | {
      command: "status";
      json: boolean;
      queueId: string;
    }
  | {
      command: "launch";
      json: boolean;
      queueId: string;
      limit?: number;
      worker: WorkerKind;
      workspaceMode: "in_place" | "git_worktree" | "clone" | "sandbox";
      modelProfile: string;
      workspacePath?: string;
      maxRuntimeMinutes?: number;
    }
  | {
      command: "approve-tool";
      json: boolean;
      proposalId: string;
      remember: boolean;
      note?: string;
    }
  | {
      command: "decide-tool";
      json: boolean;
      proposalId: string;
      decision: "approve" | "reject" | "revise";
      remember: boolean;
      note?: string;
    }
  | {
      command: "set-tool-policy";
      json: boolean;
      projectPath: string;
      grantKind: string;
      value: string;
      status: "approved" | "rejected";
    }
  | {
      command: "merge-worker";
      json: boolean;
      queueId: string;
      queueTaskId?: string;
      workerRunId?: string;
      taskId?: string;
      applyCwd?: string;
      agent?: string;
      apply?: boolean;
      cwd?: string;
      runTests?: boolean;
      reviewedBy?: string;
      reviewSummary?: string;
    }
  | { command: "help"; json: boolean };

export type ProjectToolCaller = <T = Record<string, unknown>>(tool: string, input: Record<string, unknown>) => Promise<T>;

export type ProjectModelRequest = {
  kind: "prompt_improvement" | "task_generation";
  modelAlias: string;
  route: {
    provider: string;
    model: string;
    reasoning: string;
  };
  queue: Record<string, unknown>;
  input: Record<string, unknown>;
};

export type ProjectModelRunner = (request: ProjectModelRequest) => Promise<Record<string, unknown>>;

export type ProjectRunResult = {
  action: string;
  message: string;
  data: Record<string, unknown>;
};

const RUNNER_LOCK_STALE_MS = 6 * 60 * 60 * 1000;

type QueueStatus = {
  queue: {
    queueId: string;
    projectPath: string;
    maxParallelAgents: number;
    status: string;
    promptSummary?: string;
    planChainId?: string;
  };
  tasks: QueueTask[];
  toolContextProposals?: Array<Record<string, unknown>>;
  toolContextPolicies?: Array<{ status?: unknown } & Record<string, unknown>>;
};

type QueueListResult = {
  count: number;
  queues: Array<{
    queueId: string;
    projectPath: string;
    title: string;
    status: string;
    activeWorkers?: number;
    availableSlots?: number;
    readyCount?: number;
    blockedCount?: number;
    pendingApprovals?: number;
    counts?: Record<string, number>;
  }>;
};

type PendingApprovalInbox = {
  count: number;
  pending: Array<{
    proposalId: string;
    queueId: string;
    queueTitle?: string;
    projectPath?: string;
    queueTaskId?: string;
    queueTaskTitle?: string;
    missingGrants?: unknown[];
    safetyWarnings?: unknown[];
  }>;
};

type QueueApprovalInbox = {
  count: number;
  toolContextCount: number;
  modelCallCount: number;
  toolContext: Array<{
    proposalId?: string;
    queueTaskId?: string;
    queueTaskTitle?: string;
    missingGrants?: unknown[];
    safetyWarnings?: unknown[];
  }>;
  modelCalls: Array<{
    requestId?: string;
    approvalRequestId?: string;
    client?: string;
    taskType?: string;
    risk?: string;
    selected?: { provider?: string; model?: string; reasoning?: string };
    estimate?: { estimatedCostUsd?: number; inputTokens?: number };
    warnings?: unknown[];
  }>;
};

type AgentLanesResult = {
  count: number;
  lanes: Array<{
    laneId: string;
    queueTask?: {
      queueTaskId?: string;
      title?: string;
      status?: string;
    };
    workerRun?: {
      workerRunId?: string;
      worker?: string;
      status?: string;
    };
    latestEvent?: {
      kind?: string;
      body?: string;
    };
    progress?: {
      label?: string;
      lastActivityAt?: string;
      summary?: string;
      nextAction?: string;
    };
  }>;
};

type DashboardResult = {
  queue: {
    queueId: string;
    projectPath: string;
    status: string;
    maxParallelAgents: number;
  };
  counts?: Record<string, number>;
  activeWorkers?: number;
  availableSlots?: number;
  summaryStrip?: {
    status?: string;
    severity?: string;
    nextAction?: string;
    counts?: {
      pendingApprovals?: number;
      staleRunning?: number;
      failed?: number;
    };
    risk?: {
      highestOpenRisk?: string;
      highRiskOpenCount?: number;
      breakglassOpenCount?: number;
    };
    cost?: {
      preflightCount?: number;
      estimatedCostUsd?: number;
    };
  };
  pipeline?: Array<{ stage?: string; status?: string }>;
  queueBoard?: {
    ready?: QueueTask[];
    running?: QueueTask[];
    review?: QueueTask[];
    blocked?: Array<{ task?: QueueTask; reasons?: string[] }>;
    done?: QueueTask[];
    failed?: QueueTask[];
  };
  pendingApprovals?: Array<{ proposalId?: string }>;
  agentLaneCount?: number;
  agentLanes?: AgentLanesResult["lanes"];
};

type ReviewMatrixResult = {
  queue: {
    queueId: string;
    projectPath: string;
    status: string;
  };
  summary?: {
    totalTasks?: number;
    openTasks?: number;
    readyDependencyFree?: number;
    blockedByDependencies?: number;
    schedulerBlocked?: number;
    scheduledPreview?: number;
    launchable?: number;
    waitingForStart?: number;
    approvalRequired?: number;
    pendingToolContextApprovals?: number;
    tasksRequiringContext?: number;
    tasksNeedingToolContextApproval?: number;
    tasksNeedingToolContextProposal?: number;
    uniqueRequiredGrants?: number;
    fileScopes?: number;
    overlappingFileScopes?: number;
    dependencyEdges?: number;
    rootTasks?: number;
    leafTasks?: number;
  };
  buckets?: {
    risk?: Array<{ key?: string; count?: number; openCount?: number }>;
    phase?: Array<{ key?: string; count?: number; openCount?: number }>;
    category?: Array<{ key?: string; count?: number; openCount?: number }>;
    parallelGroup?: Array<{ key?: string; count?: number; openCount?: number }>;
  };
  dependencies?: {
    edgeCount?: number;
    blockedTasks?: unknown[];
  };
  parallelism?: {
    activeWorkers?: number;
    availableSlots?: number;
    maxParallelAgents?: number;
    workerStartBlocked?: boolean;
    workerStartBlockedReason?: string;
    serialTasks?: unknown[];
    parallelSafeTasks?: unknown[];
    scheduledPreview?: {
      launchable?: unknown[];
      waitingForStart?: unknown[];
      approvalRequired?: unknown[];
      blocked?: unknown[];
    };
  };
  fileScopes?: Array<{
    path?: string;
    taskCount?: number;
    openTaskCount?: number;
    overlap?: boolean;
  }>;
  toolContext?: {
    grants?: Array<{
      grantKey?: string;
      kind?: string;
      policyStatus?: string;
      taskCount?: number;
      openTaskCount?: number;
    }>;
    tasks?: unknown[];
    pendingApprovals?: unknown[];
  };
  executionBlocked?: boolean;
  blockedReason?: string;
};

type TimelineResult = {
  queue: {
    queueId: string;
    projectPath: string;
  };
  count: number;
  items: Array<{
    timelineId?: string;
    source?: string;
    kind?: string;
    timestamp?: string;
    title?: string;
    summary?: string;
    severity?: string;
    queueTaskTitle?: string;
  }>;
};

type TaskDetailResult = {
  queue: {
    queueId: string;
    projectPath: string;
    status: string;
  };
  task: QueueTask;
  graph?: {
    dependencies?: Array<{ queueTaskId?: string; title?: string; status?: string; satisfied?: boolean; missing?: boolean }>;
    dependents?: Array<{ queueTaskId?: string; title?: string; status?: string; unblockedByCurrentTask?: boolean }>;
  };
  readiness?: {
    readyNow?: boolean;
    state?: string;
    reasons?: string[];
    dependenciesReady?: boolean;
  };
  workerRuns?: Array<{
    workerRun?: {
      workerRunId?: string;
      worker?: string;
      status?: string;
      workspacePath?: string;
    };
    latestEvent?: {
      kind?: string;
      body?: string;
    };
    progress?: {
      label?: string;
      summary?: string;
      nextAction?: string;
    };
  }>;
  toolContextProposals?: Array<{ proposalId?: string; status?: string; approvalRequired?: boolean }>;
  modelApprovals?: Array<{ requestId?: string; status?: string; risk?: string; estimate?: { estimatedCostUsd?: number } }>;
  resume?: {
    fabricResume?: {
      resumePrompt?: string;
    };
    taskPacket?: Record<string, unknown>;
  };
};

type QueueResumeResult = {
  queueTask: QueueTask;
  fabricResume: {
    resumePrompt: string;
    projectPath: string;
    workspacePath?: string;
    modelProfile?: string;
    contextPolicy?: string;
    latestCheckpoint?: unknown;
  };
  taskPacket: Record<string, unknown>;
};

type FabricTaskStatusResult = {
  taskId: string;
  status: string;
  projectPath?: string;
  workerRuns?: Array<{ workerRunId?: string; workspacePath?: string; status?: string }>;
  latestCheckpoint?: { workerRunId?: string; summary?: Record<string, unknown> };
  checkpoints?: Array<{ workerRunId?: string; summary?: Record<string, unknown> }>;
};

type ReviewedPatchApplyResult = {
  queueTaskId: string;
  fabricTaskId: string;
  workerRunId: string;
  patchFile: string;
  cwd: string;
  patchApply: Record<string, unknown>;
};

type QueueTask = {
  queueTaskId: string;
  fabricTaskId?: string;
  title: string;
  goal: string;
  status: string;
  category?: string;
  risk?: string;
  phase?: string;
  managerId?: string;
  parentManagerId?: string;
  parentQueueId?: string;
  workstream?: string;
  costCenter?: string;
  escalationTarget?: string;
  priority?: string;
  parallelGroup?: string;
  parallelSafe?: boolean;
  dependsOn?: unknown[];
  expectedFiles?: unknown[];
  acceptanceCriteria?: unknown[];
  patchRefs?: unknown[];
  testRefs?: unknown[];
  summary?: string;
  requiredTools?: unknown[];
  requiredMcpServers?: unknown[];
  requiredMemories?: unknown[];
  requiredContextRefs?: unknown[];
  assignedWorkerRunId?: string;
};

type NextReadyResult = {
  ready: QueueTask[];
  blocked: unknown[];
  activeWorkers: number;
  availableSlots: number;
  executionBlocked?: boolean;
  blockedReason?: string;
  workerStartBlocked?: boolean;
  workerStartBlockedReason?: string;
};

type LaunchPlanResult = {
  queueId: string;
  launchable: Array<LaunchPlanEntry>;
  waitingForStart: Array<LaunchPlanEntry>;
  approvalRequired: Array<LaunchPlanEntry>;
  blocked: unknown[];
  activeWorkers: number;
  availableSlots: number;
  executionBlocked?: boolean;
  blockedReason?: string;
  workerStartBlocked?: boolean;
  workerStartBlockedReason?: string;
  summary?: {
    scheduled?: number;
    launchable?: number;
    waitingForStart?: number;
    approvalRequired?: number;
    needsProposal?: number;
  };
};

type LaunchPlanEntry = {
  task?: QueueTask;
  toolContextProposal?: {
    proposalId?: string;
    status?: string;
    approvalRequired?: boolean;
    missingGrants?: unknown[];
  };
  approvalRequired?: boolean;
  readyToLaunch?: boolean;
  workerStartBlocked?: boolean;
  launchBlockedReason?: string;
  noContextRequired?: boolean;
  needsProposal?: boolean;
  missingGrants?: unknown[];
};

type PrepareReadyResult = {
  queueId: string;
  prepared: Array<{
    task?: QueueTask;
    toolContextProposal?: {
      proposalId?: string;
      status?: string;
      approvalRequired?: boolean;
      missingGrants?: unknown[];
    };
    approvalRequired?: boolean;
    readyToClaim?: boolean;
    readyToLaunch?: boolean;
    launchBlockedReason?: string;
    noContextRequired?: boolean;
    reusedProposal?: boolean;
    missingGrants?: unknown[];
    memorySuggestions?: unknown[];
  }>;
  blocked: unknown[];
  activeWorkers: number;
  availableSlots: number;
  executionBlocked?: boolean;
  blockedReason?: string;
  workerStartBlocked?: boolean;
  workerStartBlockedReason?: string;
  summary?: {
    readyToClaim?: number;
    readyToLaunch?: number;
    approvalRequired?: number;
    noContextRequired?: number;
    waitingForStart?: number;
  };
};

type ClaimNextResult = {
  queueId: string;
  claimed?: QueueTask;
  executionBlocked?: boolean;
  blockedReason?: string;
  approvalRequired?: boolean;
  toolContextProposal?: {
    proposalId?: string;
    queueTaskId?: string;
    fabricTaskId?: string;
    approvalRequired?: boolean;
    missingGrants?: unknown[];
  };
  workerRun?: {
    workerRunId?: string;
    worker?: string;
    status?: string;
    workspacePath?: string;
  };
  blocked: unknown[];
  activeWorkers: number;
  availableSlots: number;
};

type RecoverStaleResult = {
  queueId: string;
  staleAfterMinutes: number;
  action: "requeue" | "fail";
  dryRun: boolean;
  count: number;
  recovered: Array<{
    queueTaskId?: string;
    workerRunId?: string;
    workerStatus?: string;
    workerUpdatedAt?: string;
    reason?: string;
    queueTask?: { title?: string; status?: string };
  }>;
};

type QueueCleanupResult = {
  dryRun: boolean;
  candidateCount?: number;
  cleanedCount?: number;
  protectedCount?: number;
  totals?: Record<string, unknown>;
  candidates?: unknown[];
  cleaned?: unknown[];
  protected?: unknown[];
};

type RetryTaskResult = {
  queue?: {
    queueId?: string;
    status?: string;
  };
  task?: QueueTask;
  previousStatus?: string;
  previousWorkerRunId?: string;
  clearOutputs?: boolean;
};

type ToolContextProposal = {
  proposalId: string;
  approvalRequired: boolean;
  missingGrants?: unknown[];
};

type PolicyAliasResult = {
  alias: string;
  provider: string;
  model: string;
  reasoning: string;
};

type PreflightResult = {
  requestId: string;
  decision: "allow" | "needs_user_approval" | "compact_first";
  risk: string;
  warnings?: string[];
  estimate?: {
    inputTokens?: number;
    estimatedCostUsd?: number;
  };
  selected?: {
    provider?: string;
    model?: string;
    reasoning?: string;
  };
};

export function parseProjectCliArgs(argv: string[]): ProjectCliCommand {
  const args = [...argv];
  const command = args.shift() ?? "help";
  if (command === "help" || command === "--help" || command === "-h") return { command: "help", json: false };
  if (command === "version" || command === "--version" || command === "-v") return { command: "version", json: false };
  if (args.includes("--help") || args.includes("-h")) return { command: "help", json: args.includes("--json") };
  if (command === "doctor" && args[0] === "local-config") {
    args.shift();
    const flags = parseFlags(args);
    return {
      command: "local-config-doctor",
      json: flags.json,
      projectPath: flags.projectPath
    };
  }
  if (command === "local-config-doctor") {
    const flags = parseFlags(args);
    return {
      command: "local-config-doctor",
      json: flags.json,
      projectPath: flags.projectPath
    };
  }
  if (command === "create") {
    const flags = parseFlags(args);
    return {
      command: "create",
      json: flags.json,
      projectPath: required(flags.projectPath, "create requires --project <path>"),
      prompt: flags.prompt,
      promptFile: flags.promptFile,
      promptSummary: flags.promptSummary,
      title: flags.title,
      pipelineProfile: parseProfile(flags.profile ?? "balanced"),
      maxParallelAgents: flags.maxAgents ?? 4
    };
  }

  if (command === "demo-seed") {
    const flags = parseFlags(args);
    return {
      command: "demo-seed",
      json: flags.json,
      projectPath: flags.projectPath ?? "/tmp/agent-fabric-desktop-demo",
      title: flags.title,
      maxParallelAgents: flags.maxAgents ?? 4
    };
  }

  if (command === "start-plan") {
    const flags = parseFlags(args);
    return {
      command: "start-plan",
      json: flags.json,
      queueId: required(flags.queueId, "start-plan requires --queue <id>"),
      task: flags.task,
      taskFile: flags.taskFile,
      maxRounds: flags.maxRounds,
      budgetUsd: flags.budgetUsd,
      outputFormat: flags.outputFormat ? parseOutputFormat(flags.outputFormat) : undefined
    };
  }

  if (command === "configure") {
    const flags = parseFlags(args);
    return {
      command: "configure",
      json: flags.json,
      queueId: required(flags.queueId, "configure requires --queue <id>"),
      title: flags.title,
      pipelineProfile: flags.profile ? parseProfile(flags.profile) : undefined,
      maxParallelAgents: flags.maxAgents,
      note: flags.note
    };
  }

  if (command === "improve-prompt") {
    const flags = parseFlags(args);
    return {
      command: "improve-prompt",
      json: flags.json,
      queueId: required(flags.queueId, "improve-prompt requires --queue <id>"),
      prompt: flags.prompt,
      promptFile: flags.promptFile,
      factorsFile: flags.factorsFile,
      modelAlias: flags.modelAlias ?? "prompt.improve.strong",
      approvalToken: flags.approvalToken,
      accept: flags.accept,
      outputFile: flags.outputFile
    };
  }

  if (command === "generate-tasks") {
    const flags = parseFlags(args);
    return {
      command: "generate-tasks",
      json: flags.json,
      queueId: required(flags.queueId, "generate-tasks requires --queue <id>"),
      planFile: required(flags.planFile, "generate-tasks requires --plan-file <path>"),
      modelAlias: flags.modelAlias ?? "task.writer",
      approvalToken: flags.approvalToken,
      tasksFile: flags.tasksFile,
      approveQueue: flags.approveQueue
    };
  }

  if (command === "review-queue") {
    const flags = parseFlags(args);
    return {
      command: "review-queue",
      json: flags.json,
      queueId: required(flags.queueId, "review-queue requires --queue <id>"),
      approveQueue: flags.approveQueue
    };
  }

  if (command === "claim-next") {
    const flags = parseFlags(args);
    const queueId = required(flags.queueId, "claim-next requires --queue <id>");
    return {
      command: "claim-next",
      json: flags.json,
      queueId,
      workerRunId: flags.workerRunId,
      worker: defaultOptionalSeniorWorker(flags, "claim-next"),
      workspaceMode: defaultOptionalSeniorWorkspaceMode(flags),
      workspacePath: flags.workspacePath,
      modelProfile: defaultOptionalSeniorModelProfile(flags),
      contextPolicy: flags.contextPolicy,
      maxRuntimeMinutes: flags.maxRuntimeMinutes,
      commandLine: flags.commandLine
    };
  }

  if (command === "prepare-ready") {
    const flags = parseFlags(args);
    return {
      command: "prepare-ready",
      json: flags.json,
      queueId: required(flags.queueId, "prepare-ready requires --queue <id>"),
      limit: flags.limit
    };
  }

  if (command === "decide-queue") {
    const flags = parseFlags(args);
    return {
      command: "decide-queue",
      json: flags.json,
      queueId: required(flags.queueId, "decide-queue requires --queue <id>"),
      decision: required(flags.decision, "decide-queue requires --decision <decision>"),
      note: flags.note
    };
  }

  if (command === "recover-stale") {
    const flags = parseFlags(args);
    return {
      command: "recover-stale",
      json: flags.json,
      queueId: required(flags.queueId, "recover-stale requires --queue <id>"),
      staleAfterMinutes: flags.staleAfterMinutes,
      action: parseRecoveryAction(flags.recoveryAction ?? "requeue"),
      dryRun: flags.dryRun
    };
  }

  if (command === "cleanup-queues") {
    const flags = parseFlags(args);
    return {
      command: "cleanup-queues",
      json: flags.json,
      projectPath: flags.projectPath,
      queueId: flags.queueId,
      statuses: flags.queueStatuses,
      olderThanDays: flags.olderThanDays ?? 7,
      limit: flags.limit,
      dryRun: flags.dryRun || !flags.apply,
      deleteLinkedTaskHistory: flags.deleteLinkedTaskHistory
    };
  }

  if (command === "retry-task") {
    const flags = parseFlags(args);
    return {
      command: "retry-task",
      json: flags.json,
      queueId: required(flags.queueId, "retry-task requires --queue <id>"),
      queueTaskId: required(flags.queueTaskId, "retry-task requires --queue-task <id>"),
      reason: flags.reason,
      clearOutputs: !flags.keepOutputs
    };
  }

  if (command === "edit-task") {
    const flags = parseFlags(args);
    return {
      command: "edit-task",
      json: flags.json,
      queueId: required(flags.queueId, "edit-task requires --queue <id>"),
      queueTaskId: required(flags.queueTaskId, "edit-task requires --queue-task <id>"),
      metadataFile: required(flags.metadataFile, "edit-task requires --metadata-file <path>"),
      rewriteContextRefs: flags.rewriteContextRefs,
      note: flags.note
    };
  }

  if (command === "review-patches") {
    const flags = parseFlags(args);
    if (flags.applyPatch && !flags.acceptTaskId) {
      throw new FabricError("INVALID_INPUT", "review-patches --apply-patch requires --accept-task <queueTaskId>", false);
    }
    return {
      command: "review-patches",
      json: flags.json,
      queueId: required(flags.queueId, "review-patches requires --queue <id>"),
      acceptTaskId: flags.acceptTaskId,
      applyPatch: flags.applyPatch,
      applyCwd: flags.applyCwd
    };
  }

  if (command === "write-task-packets") {
    const flags = parseFlags(args);
    return {
      command: "write-task-packets",
      json: flags.json,
      queueId: required(flags.queueId, "write-task-packets requires --queue <id>"),
      outDir: required(flags.outDir, "write-task-packets requires --out-dir <path>"),
      format: parsePacketFormat(flags.format ?? "json"),
      readyOnly: flags.readyOnly
    };
  }

  if (command === "resume-task") {
    const flags = parseFlags(args);
    return {
      command: "resume-task",
      json: flags.json,
      queueId: required(flags.queueId, "resume-task requires --queue <id>"),
      queueTaskId: required(flags.queueTaskId, "resume-task requires --queue-task <id>"),
      preferredWorker: flags.worker ? parseWorker(flags.worker) : undefined,
      outputFile: flags.outputFile,
      format: parsePacketFormat(flags.format ?? "markdown")
    };
  }

  if (command === "run-task") {
    const flags = parseFlags(args);
    const worker = defaultSeniorWorker(flags, "run-task");
    return {
      command: "run-task",
      json: flags.json,
      queueId: required(flags.queueId, "run-task requires --queue <id>"),
      queueTaskId: required(flags.queueTaskId, "run-task requires --queue-task <id>"),
      commandLine: required(flags.commandLine, "run-task requires --command <command>"),
      cwd: flags.cwd,
      cwdPrep: parseCwdPrep(flags.cwdPrep ?? "auto"),
      taskPacketPath: flags.taskPacketPath,
      taskPacketFormat: parsePacketFormat(flags.taskPacketFormat ?? "json"),
      worker,
      workspaceMode: defaultSeniorWorkspaceMode(flags, "in_place"),
      modelProfile: defaultSeniorModelProfile(flags, "execute.cheap"),
      maxRuntimeMinutes: flags.maxRuntimeMinutes,
      approvalToken: flags.approvalToken,
      successStatus: parseSuccessStatus(flags.successStatus ?? "patch_ready"),
      maxOutputChars: flags.maxOutputChars ?? 8_000,
      approveToolContext: flags.approveToolContext,
      rememberToolContext: flags.rememberToolContext
    };
  }

  if (command === "run-ready") {
    const flags = parseFlags(args);
    const queueId = required(flags.queueId, "run-ready requires --queue <id>");
    const worker = defaultSeniorWorker(flags, "run-ready");
    assertSeniorModeDeepSeekCommandTemplate(worker, flags.commandTemplate, "run-ready");
    const seniorDeepSeekDefault = seniorModePermissive(process.env) && SENIOR_DEEPSEEK_WORKERS.has(worker) && !flags.commandTemplate;
    return {
      command: "run-ready",
      json: flags.json,
      projectPath: flags.projectPath,
      queueId,
      commandTemplate: flags.commandTemplate,
      cwd: flags.cwd,
      cwdTemplate: flags.cwdTemplate ?? (seniorDeepSeekDefault ? defaultSeniorCwdTemplate(queueId) : undefined),
      cwdPrep: parseCwdPrep(flags.cwdPrep ?? "auto"),
      taskPacketDir: flags.taskPacketDir ?? (seniorDeepSeekDefault ? defaultSeniorTaskPacketDir(queueId) : undefined),
      taskPacketFormat: parsePacketFormat(flags.taskPacketFormat ?? "json"),
      limit: flags.limit,
      parallel: flags.parallel ?? defaultSeniorLaneCount(1),
      allowSharedCwd: flags.allowSharedCwd,
      worker,
      workspaceMode: defaultSeniorWorkspaceMode(flags, "in_place"),
      modelProfile: defaultSeniorModelProfile(flags, "execute.cheap"),
      maxRuntimeMinutes: flags.maxRuntimeMinutes,
      approvalToken: flags.approvalToken,
      successStatus: parseSuccessStatus(flags.successStatus ?? "patch_ready"),
      maxOutputChars: flags.maxOutputChars ?? 8_000,
      approveToolContext: flags.approveToolContext,
      rememberToolContext: flags.rememberToolContext,
      continueOnFailure: flags.continueOnFailure,
      adaptiveRateLimit: flags.adaptiveRateLimit,
      minParallel: flags.minParallel ?? 1,
      allowConcurrentRunner: flags.allowConcurrentRunner
    };
  }

  if (command === "factory-run") {
    const flags = parseFlags(args);
    const allowSensitiveContext = defaultAllowSensitiveContext(flags);
    const deepSeekWorkerCommand = flags.deepSeekWorkerCommand ?? "agent-fabric-deepseek-worker";
    assertSeniorModeDeepSeekBinaryCommand(deepSeekWorkerCommand, "factory-run");
    return {
      command: "factory-run",
      json: flags.json,
      queueId: required(flags.queueId, "factory-run requires --queue <id>"),
      limit: flags.limit,
      parallel: flags.parallel ?? defaultSeniorLaneCount(4),
      minParallel: flags.minParallel ?? 1,
      adaptiveRateLimit: !flags.noAdaptiveRateLimit,
      taskPacketDir: flags.taskPacketDir,
      cwdTemplate: flags.cwdTemplate,
      deepSeekWorkerCommand,
      deepSeekRole: parseDeepSeekRole(flags.deepSeekRole ?? "auto"),
      sensitiveContextMode: parseSensitiveContextMode(flags.sensitiveContextMode ?? "basic", allowSensitiveContext),
      patchMode: parseFactoryPatchMode(flags.patchMode ?? "write"),
      approvalToken: flags.approvalToken,
      maxRuntimeMinutes: flags.maxRuntimeMinutes,
      maxOutputChars: flags.maxOutputChars ?? 8_000,
      approveToolContext: flags.approveToolContext,
      rememberToolContext: flags.rememberToolContext,
      continueOnFailure: flags.continueOnFailure,
      startExecution: flags.startExecution,
      dryRun: flags.dryRun,
      allowSensitiveContext,
      approveModelCalls: flags.approveModelCalls,
      allowConcurrentRunner: flags.allowConcurrentRunner
    };
  }

  if (command === "senior-doctor") {
    const flags = parseFlags(args);
    return {
      command: "senior-doctor",
      json: flags.json,
      projectPath: flags.projectPath ?? process.cwd(),
      queueId: flags.queueId
    };
  }

  if (command === "senior-run") {
    const flags = parseFlags(args);
    return {
      command: "senior-run",
      json: flags.json,
      projectPath: flags.projectPath,
      queueId: flags.queueId,
      planFile: flags.planFile,
      tasksFile: flags.tasksFile,
      count: flags.count ?? (seniorModePermissive(process.env) ? seniorDefaultLaneCount() : SENIOR_DEFAULT_LANE_COUNT),
      worker: parseCodexBridgeWorker(flags.worker ?? seniorDefaultWorker(process.env)),
      approveModelCalls: flags.approveModelCalls,
      dryRun: flags.dryRun,
      progressFile: flags.progressFile,
      allowPartial: flags.allowPartial
    };
  }

  if (command === "progress-report") {
    const flags = parseFlags(args);
    return {
      command: "progress-report",
      json: flags.json,
      queueId: required(flags.queueId, "progress-report requires --queue <id>"),
      progressFile: flags.progressFile,
      maxEventsPerLane: flags.maxEventsPerLane,
      managerSummaryLimit: flags.managerSummaryLimit
    };
  }

  if (command === "launch-plan") {
    const flags = parseFlags(args);
    return {
      command: "launch-plan",
      json: flags.json,
      queueId: required(flags.queueId, "launch-plan requires --queue <id>"),
      limit: flags.limit
    };
  }

  if (command === "import-tasks") {
    const flags = parseFlags(args);
    return {
      command: "import-tasks",
      json: flags.json,
      queueId: required(flags.queueId, "import-tasks requires --queue <id>"),
      tasksFile: required(flags.tasksFile, "import-tasks requires --tasks-file <path>"),
      approveQueue: flags.approveQueue
    };
  }

  if (command === "list") {
    const flags = parseFlags(args);
    return {
      command: "list",
      json: flags.json,
      projectPath: flags.projectPath,
      statuses: flags.queueStatuses ?? [],
      includeClosed: flags.includeClosed,
      limit: flags.limit
    };
  }

  if (command === "approval-inbox") {
    const flags = parseFlags(args);
    return {
      command: "approval-inbox",
      json: flags.json,
      projectPath: flags.projectPath,
      queueId: flags.queueId,
      limit: flags.limit
    };
  }

  if (command === "memory-inbox") {
    const flags = parseFlags(args);
    return {
      command: "memory-inbox",
      json: flags.json,
      status: flags.status ?? "pending_review",
      archived: flags.archived,
      limit: flags.limit
    };
  }

  if (command === "review-memory") {
    const flags = parseFlags(args);
    const memoryId = args.shift() ?? flags.memoryId ?? flags.proposalId;
    return {
      command: "review-memory",
      json: flags.json,
      memoryId: required(memoryId, "review-memory requires <memoryId>"),
      decision: parseMemoryReviewDecision(flags.decision ?? "approve"),
      reason: flags.reason ?? flags.note
    };
  }

  if (command === "queue-approvals") {
    const flags = parseFlags(args);
    return {
      command: "queue-approvals",
      json: flags.json,
      queueId: required(flags.queueId, "queue-approvals requires --queue <id>"),
      includeExpired: flags.includeExpired,
      limit: flags.limit
    };
  }

  if (command === "lanes") {
    const flags = parseFlags(args);
    return {
      command: "lanes",
      json: flags.json,
      queueId: required(flags.queueId, "lanes requires --queue <id>"),
      includeCompleted: flags.includeCompleted,
      maxEventsPerLane: flags.maxEventsPerLane
    };
  }

  if (command === "fabric-spawn-agents") {
    const flags = parseFlags(args);
    return {
      command: "fabric-spawn-agents",
      json: flags.json,
      queueId: required(flags.queueId, "fabric-spawn-agents requires --queue <id>"),
      count: flags.count ?? 10,
      worker: parseCodexBridgeWorker(flags.worker ?? seniorDefaultWorker(process.env)),
      workspaceMode: parseCodexBridgeWorkspaceMode(flags.workspaceMode ?? "git_worktree"),
      modelProfile: flags.modelProfile ?? SENIOR_DEFAULT_MODEL_PROFILE,
      maxRuntimeMinutes: flags.maxRuntimeMinutes,
      allowPartial: flags.allowPartial
    };
  }

  if (command === "fabric-list-agents") {
    const flags = parseFlags(args);
    return {
      command: "fabric-list-agents",
      json: flags.json,
      queueId: required(flags.queueId, "fabric-list-agents requires --queue <id>"),
      includeCompleted: flags.includeCompleted,
      maxEventsPerLane: flags.maxEventsPerLane
    };
  }

  if (command === "fabric-open-agent") {
    const flags = parseFlags(args);
    return {
      command: "fabric-open-agent",
      json: flags.json,
      queueId: required(flags.queueId, "fabric-open-agent requires --queue <id>"),
      agent: required(flags.agent ?? args.shift(), "fabric-open-agent requires --agent <handle>"),
      maxEventsPerRun: flags.maxEventsPerLane
    };
  }

  if (command === "fabric-message-agent") {
    const flags = parseFlags(args);
    return {
      command: "fabric-message-agent",
      json: flags.json,
      queueId: required(flags.queueId, "fabric-message-agent requires --queue <id>"),
      agent: required(flags.agent, "fabric-message-agent requires --agent <handle>"),
      body: required(flags.body ?? flags.message, "fabric-message-agent requires --body <text>"),
      kind: flags.grantKind,
      ask: flags.ask,
      urgency: flags.urgency,
      refs: flags.refs ?? []
    };
  }

  if (command === "fabric-wait-agents") {
    const flags = parseFlags(args);
    return {
      command: "fabric-wait-agents",
      json: flags.json,
      queueId: required(flags.queueId, "fabric-wait-agents requires --queue <id>"),
      agents: flags.agents ?? [],
      targetStatuses: flags.targetStatuses ?? [],
      maxEventsPerLane: flags.maxEventsPerLane
    };
  }

  if (command === "fabric-accept-patch") {
    const flags = parseFlags(args);
    return {
      command: "fabric-accept-patch",
      json: flags.json,
      queueId: required(flags.queueId, "fabric-accept-patch requires --queue <id>"),
      agent: flags.agent,
      queueTaskId: flags.queueTaskId,
      summary: flags.summary ?? flags.note,
      reviewedBy: flags.reviewedBy,
      reviewSummary: flags.reviewSummary
    };
  }

  if (command === "dashboard") {
    const flags = parseFlags(args);
    return {
      command: "dashboard",
      json: flags.json,
      queueId: required(flags.queueId, "dashboard requires --queue <id>"),
      includeCompletedLanes: flags.includeCompleted,
      maxEventsPerLane: flags.maxEventsPerLane
    };
  }

  if (command === "review-matrix") {
    const flags = parseFlags(args);
    return {
      command: "review-matrix",
      json: flags.json,
      queueId: required(flags.queueId, "review-matrix requires --queue <id>"),
      limit: flags.limit
    };
  }

  if (command === "task-detail") {
    const flags = parseFlags(args);
    return {
      command: "task-detail",
      json: flags.json,
      queueId: required(flags.queueId, "task-detail requires --queue <id>"),
      queueTaskId: required(flags.queueTaskId, "task-detail requires --queue-task <id>"),
      includeResume: flags.includeResume,
      preferredWorker: flags.worker ? parseWorker(flags.worker) : undefined,
      maxEventsPerRun: flags.maxEventsPerLane
    };
  }

  if (command === "timeline") {
    const flags = parseFlags(args);
    return {
      command: "timeline",
      json: flags.json,
      queueId: required(flags.queueId, "timeline requires --queue <id>"),
      limit: flags.limit
    };
  }

  if (command === "status") {
    const flags = parseFlags(args);
    return {
      command: "status",
      json: flags.json,
      queueId: required(flags.queueId, "status requires --queue <id>")
    };
  }

  if (command === "launch") {
    const flags = parseFlags(args);
    const worker = defaultSeniorWorker(flags, "launch");
    return {
      command: "launch",
      json: flags.json,
      queueId: required(flags.queueId, "launch requires --queue <id>"),
      limit: flags.limit,
      worker,
      workspaceMode: defaultSeniorWorkspaceMode(flags, "git_worktree"),
      modelProfile: defaultSeniorModelProfile(flags, "execute.cheap"),
      workspacePath: flags.workspacePath,
      maxRuntimeMinutes: flags.maxRuntimeMinutes
    };
  }

  if (command === "approve-tool") {
    const flags = parseFlags(args);
    const proposalId = args.shift() ?? flags.proposalId;
    return {
      command: "approve-tool",
      json: flags.json,
      proposalId: required(proposalId, "approve-tool requires <proposalId>"),
      remember: flags.remember,
      note: flags.note
    };
  }

  if (command === "decide-tool") {
    const flags = parseFlags(args);
    const proposalId = args.shift() ?? flags.proposalId;
    return {
      command: "decide-tool",
      json: flags.json,
      proposalId: required(proposalId, "decide-tool requires <proposalId>"),
      decision: parseToolDecision(flags.decision ?? "approve"),
      remember: flags.remember,
      note: flags.note
    };
  }

  if (command === "set-tool-policy") {
    const flags = parseFlags(args);
    return {
      command: "set-tool-policy",
      json: flags.json,
      projectPath: required(flags.projectPath, "set-tool-policy requires --project <path>"),
      grantKind: required(flags.grantKind, "set-tool-policy requires --kind <mcp_server|tool|memory|context>"),
      value: required(flags.value, "set-tool-policy requires --value <value>"),
      status: parsePolicyStatus(flags.status ?? "approved")
    };
  }

  if (command === "merge-worker") {
    const flags = parseFlags(args);
    const hasRef = !!(flags.queueTaskId || flags.workerRunId || flags.taskId);
    const isDryRun = hasRef && !flags.apply;
    if (isDryRun) {
      if (!hasRef) {
        throw new FabricError("INVALID_INPUT", "merge-worker requires one of --queue-task, --worker-run, or --task for dry-run", false);
      }
      return {
        command: "merge-worker",
        json: flags.json,
        queueId: required(flags.queueId, "merge-worker requires --queue <id>"),
        queueTaskId: flags.queueTaskId,
        workerRunId: flags.workerRunId,
        taskId: flags.taskId,
        applyCwd: flags.applyCwd
      };
    }
    const apply = flags.apply;
    if (apply && (!flags.reviewedBy || !flags.reviewSummary)) {
      throw new FabricError("INVALID_INPUT", "merge-worker --apply requires --reviewed-by <name> and --review-summary <text> for senior review metadata", false);
    }
    return {
      command: "merge-worker",
      json: flags.json,
      queueId: required(flags.queueId, "merge-worker requires --queue <id>"),
      agent: required(flags.agent, "merge-worker requires --agent <@af/handle>"),
      apply,
      cwd: flags.cwd,
      runTests: flags.runTests,
      reviewedBy: flags.reviewedBy,
      reviewSummary: flags.reviewSummary
    };
  }

  throw new FabricError("INVALID_INPUT", `Unknown project CLI command: ${command}`, false);
}

export async function runProjectCommand(
  command: ProjectCliCommand,
  call: ProjectToolCaller,
  options: { runModel?: ProjectModelRunner } = {}
): Promise<ProjectRunResult> {
  if (command.command === "help") {
    return { action: "help", message: projectHelp(), data: {} };
  }
  if (command.command === "version") {
    return { action: "version", message: "agent-fabric-project 0.1.0", data: { version: "0.1.0" } };
  }
  if (command.command === "local-config-doctor") {
    const report = runLocalConfigDoctor({ projectPath: command.projectPath });
    return {
      action: "local_config_doctor",
      message: formatLocalConfigDoctor(report),
      data: report as unknown as Record<string, unknown>
    };
  }
  if (command.command === "create") {
    return createQueue(command, call);
  }
  if (command.command === "demo-seed") {
    return seedDemoProject(command, call);
  }
  if (command.command === "start-plan") {
    return startPlan(command, call);
  }
  if (command.command === "configure") {
    const result = await call<{ queue?: { queueId?: string; title?: string; pipelineProfile?: string; maxParallelAgents?: number } }>(
      "project_queue_update_settings",
      {
        queueId: command.queueId,
        title: command.title,
        pipelineProfile: command.pipelineProfile,
        maxParallelAgents: command.maxParallelAgents,
        note: command.note
      }
    );
    const queue = result.queue ?? {};
    return {
      action: "queue_configured",
      message: `Configured queue ${queue.queueId ?? command.queueId}: title=${queue.title ?? "unchanged"}, profile=${
        queue.pipelineProfile ?? "unchanged"
      }, maxAgents=${queue.maxParallelAgents ?? "unchanged"}`,
      data: result as unknown as Record<string, unknown>
    };
  }
  if (command.command === "improve-prompt") {
    return improvePrompt(command, call, options.runModel ?? defaultModelRunner);
  }
  if (command.command === "generate-tasks") {
    return generateTasks(command, call, options.runModel ?? defaultModelRunner);
  }
  if (command.command === "review-queue") {
    return reviewQueue(command, call);
  }
  if (command.command === "decide-queue") {
    const result = await call<Record<string, unknown>>("project_queue_decide", {
      queueId: command.queueId,
      decision: command.decision,
      note: command.note
    });
    return {
      action: "queue_decided",
      message: `Queue ${command.queueId} decision ${command.decision}; status=${result.status ?? "unknown"}`,
      data: result
    };
  }
  if (command.command === "claim-next") {
    const worker = resolveOptionalSeniorWorker(command.worker, "claim-next");
    const claimed = await call<ClaimNextResult>("project_queue_claim_next", {
      queueId: command.queueId,
      workerRunId: command.workerRunId,
      worker,
      workspaceMode: resolveOptionalSeniorWorkspaceMode(command.workspaceMode),
      workspacePath: command.workspacePath,
      modelProfile: resolveOptionalSeniorModelProfile(command.modelProfile),
      contextPolicy: command.contextPolicy,
      maxRuntimeMinutes: command.maxRuntimeMinutes,
      command: command.commandLine ? [command.commandLine] : undefined
    });
    return { action: "task_claimed", message: formatClaimNext(claimed), data: claimed as unknown as Record<string, unknown> };
  }
  if (command.command === "prepare-ready") {
    const prepared = await call<PrepareReadyResult>("project_queue_prepare_ready", {
      queueId: command.queueId,
      limit: command.limit
    });
    return { action: "ready_tasks_prepared", message: formatPrepareReady(prepared), data: prepared as unknown as Record<string, unknown> };
  }
  if (command.command === "recover-stale") {
    const recovered = await call<RecoverStaleResult>("project_queue_recover_stale", {
      queueId: command.queueId,
      staleAfterMinutes: command.staleAfterMinutes,
      action: command.action,
      dryRun: command.dryRun
    });
    return { action: "stale_recovered", message: formatRecoverStale(recovered), data: recovered as unknown as Record<string, unknown> };
  }
  if (command.command === "cleanup-queues") {
    const cleaned = await call<QueueCleanupResult>("project_queue_cleanup", {
      projectPath: command.projectPath,
      queueId: command.queueId,
      statuses: command.statuses,
      olderThanDays: command.olderThanDays,
      limit: command.limit,
      dryRun: command.dryRun,
      deleteLinkedTaskHistory: command.deleteLinkedTaskHistory
    });
    return {
      action: command.dryRun ? "queue_cleanup_preview" : "queue_cleanup_applied",
      message: formatQueueCleanup(cleaned),
      data: cleaned as unknown as Record<string, unknown>
    };
  }
  if (command.command === "retry-task") {
    const retried = await call<RetryTaskResult>("project_queue_retry_task", {
      queueId: command.queueId,
      queueTaskId: command.queueTaskId,
      reason: command.reason,
      clearOutputs: command.clearOutputs
    });
    return { action: "task_retried", message: formatRetryTask(retried), data: retried as unknown as Record<string, unknown> };
  }
  if (command.command === "edit-task") {
    const metadata = parseTaskMetadataFile(command.metadataFile);
    const edited = await call<{ queue?: { queueId?: string; status?: string }; task?: QueueTask; previousTask?: QueueTask }>("project_queue_update_task_metadata", {
      queueId: command.queueId,
      queueTaskId: command.queueTaskId,
      note: command.note,
      rewriteContextRefs: command.rewriteContextRefs,
      ...metadata
    });
    return {
      action: "task_metadata_updated",
      message: formatTaskMetadataUpdated(edited),
      data: edited as unknown as Record<string, unknown>
    };
  }
  if (command.command === "review-patches") {
    return reviewPatches(command, call);
  }
  if (command.command === "write-task-packets") {
    return writeTaskPackets(command, call);
  }
  if (command.command === "resume-task") {
    return resumeQueueTask(command, call);
  }
  if (command.command === "run-task") {
    assertSeniorModeDeepSeekWorker(command.worker, "run-task");
    return runTask(command, call);
  }
  if (command.command === "run-ready") {
    assertSeniorModeDeepSeekWorker(command.worker, "run-ready");
    return withQueueRunnerLock("run-ready", command.queueId, command.allowConcurrentRunner === true, () => runReady(command, call));
  }
  if (command.command === "factory-run") {
    if (command.dryRun) return factoryRun(command, call);
    return withQueueRunnerLock("factory-run", command.queueId, command.allowConcurrentRunner === true, () => factoryRun(command, call));
  }
  if (command.command === "senior-doctor") {
    return seniorDoctor(command, call);
  }
  if (command.command === "senior-run") {
    return seniorRun(command, call);
  }
  if (command.command === "progress-report") {
    return writeProgressReport(command, call);
  }
  if (command.command === "launch-plan") {
    const plan = await call<LaunchPlanResult>("project_queue_launch_plan", {
      queueId: command.queueId,
      limit: command.limit
    });
    return { action: "launch_plan", message: formatLaunchPlan(plan), data: plan as unknown as Record<string, unknown> };
  }
  if (command.command === "import-tasks") {
    return importTasks(command, call);
  }
  if (command.command === "list") {
    const list = await call<QueueListResult>("project_queue_list", {
      projectPath: command.projectPath,
      statuses: command.statuses,
      includeClosed: command.includeClosed,
      limit: command.limit
    });
    return { action: "queues_listed", message: formatQueueList(list), data: list as unknown as Record<string, unknown> };
  }
  if (command.command === "approval-inbox") {
    const inbox = await call<PendingApprovalInbox>("tool_context_pending", {
      projectPath: command.projectPath,
      queueId: command.queueId,
      limit: command.limit
    });
    return { action: "approval_inbox", message: formatApprovalInbox(inbox), data: inbox as unknown as Record<string, unknown> };
  }
  if (command.command === "memory-inbox") {
    const inbox = await call<{ memories?: Record<string, unknown>[]; total?: number }>("memory_list", {
      status: command.status,
      archived: command.archived,
      max: command.limit
    });
    return { action: "memory_inbox", message: formatMemoryInbox(inbox), data: inbox as unknown as Record<string, unknown> };
  }
  if (command.command === "review-memory") {
    const reviewed = await call<Record<string, unknown>>("memory_review", {
      id: command.memoryId,
      decision: command.decision,
      reason: command.reason
    });
    return { action: "memory_reviewed", message: formatMemoryReview(reviewed), data: reviewed };
  }
  if (command.command === "queue-approvals") {
    const inbox = await call<QueueApprovalInbox>("project_queue_approval_inbox", {
      queueId: command.queueId,
      includeExpired: command.includeExpired,
      limit: command.limit
    });
    return { action: "queue_approval_inbox", message: formatQueueApprovalInbox(command.queueId, inbox), data: inbox as unknown as Record<string, unknown> };
  }
  if (command.command === "lanes") {
    const lanes = await call<AgentLanesResult>("project_queue_agent_lanes", {
      queueId: command.queueId,
      includeCompleted: command.includeCompleted,
      maxEventsPerLane: command.maxEventsPerLane
    });
    return { action: "agent_lanes", message: formatAgentLanes(command.queueId, lanes), data: lanes as unknown as Record<string, unknown> };
  }
  if (command.command === "fabric-spawn-agents") {
    const result = await call<Record<string, unknown>>("fabric_spawn_agents", {
      queueId: command.queueId,
      count: command.count,
      worker: command.worker,
      workspaceMode: command.workspaceMode,
      modelProfile: command.modelProfile,
      maxRuntimeMinutes: command.maxRuntimeMinutes,
      allowPartial: command.allowPartial
    });
    return { action: "fabric_agents_spawned", message: formatCodexAgents(result), data: result };
  }
  if (command.command === "fabric-list-agents") {
    const result = await call<Record<string, unknown>>("fabric_list_agents", {
      queueId: command.queueId,
      includeCompleted: command.includeCompleted,
      maxEventsPerLane: command.maxEventsPerLane
    });
    return { action: "fabric_agents_listed", message: formatCodexAgents(result), data: result };
  }
  if (command.command === "fabric-open-agent") {
    const result = await call<Record<string, unknown>>("fabric_open_agent", {
      queueId: command.queueId,
      agent: command.agent,
      maxEventsPerRun: command.maxEventsPerRun
    });
    return { action: "fabric_agent_opened", message: formatCodexAgentDetail(result), data: result };
  }
  if (command.command === "fabric-message-agent") {
    const result = await call<Record<string, unknown>>("fabric_message_agent", {
      queueId: command.queueId,
      agent: command.agent,
      body: command.body,
      kind: command.kind,
      ask: command.ask,
      urgency: command.urgency,
      refs: command.refs
    });
    return { action: "fabric_agent_messaged", message: `Sent ${command.ask ? "ask" : "message"} to ${String(result.deliveredTo ?? command.agent)}.`, data: result };
  }
  if (command.command === "fabric-wait-agents") {
    const result = await call<Record<string, unknown>>("fabric_wait_agents", {
      queueId: command.queueId,
      agents: command.agents,
      targetStatuses: command.targetStatuses,
      maxEventsPerLane: command.maxEventsPerLane
    });
    return { action: "fabric_agents_wait", message: formatCodexAgents(result), data: result };
  }
  if (command.command === "fabric-accept-patch") {
    const result = await call<Record<string, unknown>>("fabric_accept_patch", {
      queueId: command.queueId,
      agent: command.agent,
      queueTaskId: command.queueTaskId,
      summary: command.summary,
      reviewedBy: command.reviewedBy,
      reviewSummary: command.reviewSummary
    });
    return { action: "fabric_agent_patch_accepted", message: `Accepted patch for ${String(result.card ? (result.card as { handle?: string }).handle : command.agent ?? command.queueTaskId)}.`, data: result };
  }
  if (command.command === "dashboard") {
    const dashboard = await call<DashboardResult>("project_queue_dashboard", {
      queueId: command.queueId,
      includeCompletedLanes: command.includeCompletedLanes,
      maxEventsPerLane: command.maxEventsPerLane
    });
    return { action: "dashboard", message: formatDashboard(dashboard), data: dashboard as unknown as Record<string, unknown> };
  }
  if (command.command === "review-matrix") {
    const matrix = await call<ReviewMatrixResult>("project_queue_review_matrix", {
      queueId: command.queueId,
      limit: command.limit
    });
    return { action: "review_matrix", message: formatReviewMatrix(matrix), data: matrix as unknown as Record<string, unknown> };
  }
  if (command.command === "task-detail") {
    const detail = await call<TaskDetailResult>("project_queue_task_detail", {
      queueId: command.queueId,
      queueTaskId: command.queueTaskId,
      includeResume: command.includeResume,
      preferredWorker: command.preferredWorker,
      maxEventsPerRun: command.maxEventsPerRun
    });
    return { action: "task_detail", message: formatTaskDetail(detail), data: detail as unknown as Record<string, unknown> };
  }
  if (command.command === "timeline") {
    const timeline = await call<TimelineResult>("project_queue_timeline", {
      queueId: command.queueId,
      limit: command.limit
    });
    return { action: "timeline", message: formatTimeline(timeline), data: timeline as unknown as Record<string, unknown> };
  }
  if (command.command === "status") {
    const status = await call<QueueStatus>("project_queue_status", { queueId: command.queueId });
    return { action: "status", message: formatStatus(status), data: status as unknown as Record<string, unknown> };
  }
  if (command.command === "launch") {
    assertSeniorModeDeepSeekWorker(command.worker, "launch");
    return launchReadyWorkers(command, call);
  }
  if (command.command === "set-tool-policy") {
    return setToolPolicy(command, call);
  }
  if (command.command === "merge-worker") {
    if (command.queueTaskId || command.workerRunId || command.taskId) {
      return mergeWorkerDryRun(command, call);
    }
    return mergeWorker(command, call);
  }
  return decideToolProposal(command, call);
}

export function formatProjectResult(result: ProjectRunResult, json: boolean): string {
  if (json) return JSON.stringify(redactProjectJson(result.data), null, 2);
  return result.message;
}

function redactProjectJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactProjectJson);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = secretOutputKey(key) ? "[redacted]" : redactProjectJson(nested);
  }
  return output;
}

function secretOutputKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized === "token" || normalized === "approvaltoken" || normalized === "sessiontoken" || normalized.endsWith("_token") || normalized.endsWith("token");
}

export function projectHelp(): string {
  return [
    "Usage:",
    "  agent-fabric-project --version",
    "  agent-fabric-project doctor local-config [--project <path>] [--json]",
    "  agent-fabric-project senior-doctor --project <path> [--queue <id>] [--json]",
    "  agent-fabric-project senior-run [--project <path>] [--queue <id>] [--plan-file <md>|--tasks-file <json>] [--count 10] [--worker deepseek-direct|jcode-deepseek] [--approve-model-calls] [--dry-run] [--progress-file <path>] [--json]",
    "  agent-fabric-project progress-report --queue <id> [--progress-file <path>] [--json]",
    "  agent-fabric-project create --project <path> (--prompt <text>|--prompt-file <file>|--prompt-summary <text>) [--title <text>] [--profile fast|balanced|careful|custom] [--max-agents <n>] [--json]",
    "  agent-fabric-project demo-seed [--project <path>] [--title <text>] [--max-agents <n>] [--json]",
    "  agent-fabric-project configure --queue <id> [--title <text>] [--profile fast|balanced|careful|custom] [--max-agents <n>] [--note <text>] [--json]",
    "  agent-fabric-project improve-prompt --queue <id> (--prompt <text>|--prompt-file <file>) [--factors-file <file>] [--model-alias <alias>] [--approval-token <token>] [--accept] [--output-file <file>] [--json]",
    "  agent-fabric-project start-plan --queue <id> (--task <text>|--task-file <file>) [--max-rounds <n>] [--budget-usd <n>] [--output-format markdown|adr] [--json]",
    "  agent-fabric-project generate-tasks --queue <id> --plan-file <file> [--model-alias <alias>] [--approval-token <token>] [--tasks-file <file>] [--approve-queue] [--json]",
    "  agent-fabric-project review-queue --queue <id> [--approve-queue] [--json]",
    "  agent-fabric-project decide-queue --queue <id> --decision accept_improved_prompt|request_prompt_revision|accept_plan|request_plan_revision|approve_queue|start_execution|pause|resume|cancel|complete [--note <text>] [--json]",
    "  agent-fabric-project claim-next --queue <id> [--worker-run <workerRunId>] [--worker ramicode|local-cli|openhands|aider|smolagents|codex-app-server|deepseek-direct|jcode-deepseek|manual] [--workspace-mode in_place|git_worktree|clone|sandbox] [--workspace-path <path>] [--model-profile <alias>] [--context-policy <policy>] [--command <cmd>] [--json]",
    "  agent-fabric-project prepare-ready --queue <id> [--limit <n>] [--json]",
    "  agent-fabric-project recover-stale --queue <id> [--stale-after-minutes <n>] [--recovery-action requeue|fail] [--dry-run] [--json]",
    "  agent-fabric-project cleanup-queues [--project <path>] [--queue <id>] [--queue-status completed|canceled] [--older-than-days <n>] [--limit <n>] [--delete-linked-task-history] [--apply] [--json]",
    "  agent-fabric-project retry-task --queue <id> --queue-task <queueTaskId> [--reason <text>] [--keep-outputs] [--json]",
    "  agent-fabric-project edit-task --queue <id> --queue-task <queueTaskId> --metadata-file <file> [--rewrite-context-ref old=new] [--note <text>] [--json]",
    "  agent-fabric-project import-tasks --queue <id> --tasks-file <file> [--approve-queue] [--json]",
    "  agent-fabric-project list [--project <path>] [--queue-status <status>] [--include-closed] [--limit <n>] [--json]",
    "  agent-fabric-project approval-inbox [--project <path>] [--queue <id>] [--limit <n>] [--json]",
    "  agent-fabric-project memory-inbox [--status pending_review|active|archived] [--archived] [--limit <n>] [--json]",
    "  agent-fabric-project review-memory <memoryId> --decision approve|reject|archive [--reason <text>] [--json]",
    "  agent-fabric-project queue-approvals --queue <id> [--include-expired] [--limit <n>] [--json]",
    "  agent-fabric-project lanes --queue <id> [--include-completed] [--max-events <n>] [--json]",
    "  agent-fabric-project fabric-spawn-agents --queue <id> [--count 10] [--worker deepseek-direct|jcode-deepseek] [--workspace-mode git_worktree|sandbox] [--allow-partial] [--json]",
    "  agent-fabric-project fabric-list-agents --queue <id> [--include-completed] [--max-events <n>] [--json]",
    "  agent-fabric-project fabric-open-agent --queue <id> --agent <@af/handle|workerRunId|queueTaskId> [--json]",
    "  agent-fabric-project fabric-message-agent --queue <id> --agent <@af/handle> --body <text> [--ask] [--json]",
    "  agent-fabric-project fabric-wait-agents --queue <id> [--agent-filter <handle>] [--target-status <status>] [--json]",
    "  agent-fabric-project fabric-accept-patch --queue <id> [--agent <@af/handle>|--queue-task <id>] --reviewed-by <name> --review-summary <text> [--json]",
    "  agent-fabric-project dashboard --queue <id> [--include-completed] [--max-events <n>] [--json]",
    "  agent-fabric-project review-matrix --queue <id> [--limit <n>] [--json]",
    "  agent-fabric-project task-detail --queue <id> --queue-task <queueTaskId> [--include-resume] [--worker ramicode|local-cli|openhands|aider|smolagents|codex-app-server|deepseek-direct|jcode-deepseek|manual] [--max-events <n>] [--json]",
    "  agent-fabric-project timeline --queue <id> [--limit <n>] [--json]",
    "  agent-fabric-project review-patches --queue <id> [--accept-task <queueTaskId>] [--apply-patch] [--apply-cwd <path>] [--json]",
    "  agent-fabric-project write-task-packets --queue <id> --out-dir <dir> [--format json|markdown] [--ready-only] [--json]",
    "  agent-fabric-project resume-task --queue <id> --queue-task <queueTaskId> [--worker ramicode|local-cli|openhands|aider|smolagents|codex-app-server|deepseek-direct|jcode-deepseek|manual] [--output-file <file>] [--format json|markdown] [--json]",
    "  agent-fabric-project run-task --queue <id> --queue-task <queueTaskId> --command <cmd> [--cwd <path>] [--cwd-prep auto|none|mkdir] [--task-packet <path>] [--task-packet-format json|markdown] [--approval-token <token>] [--approve-tool-context] [--remember-tool-context] [--success-status patch_ready|completed] [--json]",
    "  agent-fabric-project run-ready --queue <id> [--project <path>] [--limit <n>] [--parallel <n>] [--min-parallel <n>] [--adaptive-rate-limit] [--command-template <cmd>] [--cwd-template <path>] [--cwd-prep auto|none|mkdir] [--task-packet-dir <dir>] [--task-packet-format json|markdown] [--worker ramicode|local-cli|openhands|aider|smolagents|codex-app-server|deepseek-direct|jcode-deepseek|manual] [--approval-token <token>] [--approve-tool-context] [--allow-concurrent-runner] [--continue-on-failure] [--json]",
    "  agent-fabric-project factory-run --queue <id> [--start-execution] [--dry-run] [--limit <n>] [--parallel <n>] [--min-parallel <n>] [--task-packet-dir <dir>] [--cwd-template <path>] [--deepseek-worker-command <cmd>] [--deepseek-role auto|implementer|reviewer|risk-reviewer|adjudicator|planner] [--sensitive-context-mode basic|strict|off] [--patch-mode report|write] [--approval-token <token>|--approve-model-calls] [--approve-tool-context] [--allow-sensitive-context] [--allow-concurrent-runner] [--continue-on-failure] [--no-adaptive-rate-limit] [--json]",
    "  agent-fabric-project launch-plan --queue <id> [--limit <n>] [--json]",
    "  agent-fabric-project status --queue <id> [--json]",
    "  agent-fabric-project collab-summary --queue <id> [--json]",
    "  agent-fabric-project launch --queue <id> [--limit <n>] [--worker ramicode|local-cli|openhands|aider|smolagents|codex-app-server|deepseek-direct|jcode-deepseek|manual] [--workspace-mode in_place|git_worktree|clone|sandbox] [--model-profile <alias>] [--workspace-path <path>] [--max-runtime-minutes <n>] [--json]",
    "  agent-fabric-project approve-tool <proposalId> [--remember] [--note <text>] [--json]",
    "  agent-fabric-project decide-tool <proposalId> --decision approve|reject|revise [--remember] [--note <text>] [--json]",
    "  agent-fabric-project set-tool-policy --project <path> --kind mcp_server|tool|memory|context --value <value> --status approved|rejected [--json]",
    "  agent-fabric-project merge-worker --queue <id> --queue-task <queueTaskId>|--worker-run <workerRunId>|--task-id <fabricTaskId> [--apply-cwd <path>] [--json]",
    "",
    `Environment: set ${SENIOR_MODE_ENV}=permissive to default worker execution to queue-backed ${SENIOR_DEFAULT_WORKER} lanes (${SENIOR_DEFAULT_WORKSPACE_MODE}, ${SENIOR_DEFAULT_MODEL_PROFILE}, ${SENIOR_DEFAULT_LANE_COUNT} parallel lanes) and allow task-relevant sensitive context for DeepSeek workers by default. Set ${SENIOR_DEFAULT_WORKER_ENV}=jcode-deepseek locally when large implementation lanes should use Jcode by default.`,
    `Escape hatch: set ${SENIOR_ALLOW_NON_DEEPSEEK_WORKERS_ENV}=1 only when a human explicitly wants non-DeepSeek worker execution in Senior mode.`
  ].join("\n");
}

async function createQueue(
  command: Extract<ProjectCliCommand, { command: "create" }>,
  call: ProjectToolCaller
): Promise<ProjectRunResult> {
  const prompt = command.prompt ?? (command.promptFile ? readFile(command.promptFile) : undefined);
  if (!prompt && !command.promptSummary) {
    throw new FabricError("INVALID_INPUT", "create requires prompt, promptFile, or promptSummary", false);
  }
  const created = await call<Record<string, unknown>>("project_queue_create", {
    projectPath: command.projectPath,
    prompt,
    promptSummary: command.promptSummary,
    title: command.title,
    pipelineProfile: command.pipelineProfile,
    maxParallelAgents: command.maxParallelAgents
  });
  await call("project_queue_record_stage", {
    queueId: created.queueId,
    stage: "prompt_improvement",
    status: "pending",
    modelAlias: "prompt.improve.strong",
    inputSummary: "Prompt captured by project CLI; raw prompt remains outside agent-fabric storage.",
    warnings: ["Review the improved prompt before planning."]
  });
  return {
    action: "created",
    message: `Created queue ${String(created.queueId)} for ${command.projectPath}.\nNext: run start-plan after prompt improvement is accepted.`,
    data: created
  };
}

async function seedDemoProject(
  command: Extract<ProjectCliCommand, { command: "demo-seed" }>,
  call: ProjectToolCaller
): Promise<ProjectRunResult> {
  mkdirSync(command.projectPath, { recursive: true });
  const title = command.title ?? "Agent Fabric Console demo command center";
  const created = await call<Record<string, unknown>>("project_queue_create", {
    projectPath: command.projectPath,
    promptSummary: "Demo a project-level Agent Fabric Console queue with live worker lanes, approvals, patch review, recovery, memory, and cost/risk surfaces.",
    title,
    pipelineProfile: "careful",
    maxParallelAgents: command.maxParallelAgents
  });
  const queueId = String(created.queueId);

  await recordDemoStage(call, queueId, {
    stage: "prompt_improvement",
    status: "completed",
    modelAlias: "prompt.improve.strong",
    outputSummary: "Improved prompt keeps the user's Desktop command-center goal and makes approval gates explicit."
  });
  await call("project_queue_decide", {
    queueId,
    decision: "accept_improved_prompt",
    note: "Accepted by project CLI demo seed."
  });
  await recordDemoStage(call, queueId, {
    stage: "planning",
    status: "completed",
    modelAlias: "plan.strong",
    outputSummary: "Accepted plan keeps agent-fabric as durable substrate and Agent Fabric Console as the first command-center UI.",
    artifacts: [{ kind: "demo_plan", ref: "agent-fabric-project demo-seed" }]
  });
  await call("project_queue_decide", {
    queueId,
    decision: "accept_plan",
    note: "Accepted by project CLI demo seed."
  });
  await recordDemoStage(call, queueId, {
    stage: "phasing",
    status: "completed",
    modelAlias: "phase.splitter",
    outputSummary: "Plan split into Desktop telemetry, approval, review, recovery, queue health, and memory-context slices."
  });
  await recordDemoStage(call, queueId, {
    stage: "task_writing",
    status: "completed",
    modelAlias: "task.writer",
    outputSummary: "Concrete coding tasks include acceptance criteria, risk, dependencies, files, and required tools."
  });
  await recordDemoStage(call, queueId, {
    stage: "queue_shaping",
    status: "needs_review",
    modelAlias: "tool.context.manager",
    outputSummary: "Queue is shaped by dependency, risk, parallel safety, tool needs, and review state.",
    warnings: ["GitHub MCP remains intentionally unapproved so the approval inbox has real work."]
  });

  const memory = await call<{ id?: string }>("memory_write", {
    type: "procedural",
    body: "For Agent Fabric Console demos, show real queue state: active lanes, approval inbox, patch-ready review, failed recovery, queue health, and memory suggestions.",
    intent_keys: ["deepseek-direct", "desktop", "demo", "queue", "review"],
    refs: ["demo://agent-fabric-desktop-command-center"],
    source: "auto",
    derivation: "demo_seed",
    initialConfidence: 0.72
  });
  const memoryId = String(memory.id ?? "");
  if (!memoryId) throw new FabricError("PROJECT_DEMO_SEED_FAILED", "memory_write did not return a memory id", false);

  const added = await call<Record<string, unknown>>("project_queue_add_tasks", {
    queueId,
    tasks: demoSeedTasks(memoryId)
  });
  const tasks = demoCreatedTaskMap(added);
  const laneTelemetry = requireDemoTask(tasks, "lane-telemetry");
  const toolApproval = requireDemoTask(tasks, "tool-approval");
  const patchReview = requireDemoTask(tasks, "patch-review");
  const recoveryDemo = requireDemoTask(tasks, "recovery-demo");
  const queueHealth = requireDemoTask(tasks, "queue-health");
  const blockedFollowup = requireDemoTask(tasks, "blocked-followup");
  const memoryContext = requireDemoTask(tasks, "memory-context");

  await call("tool_context_policy_set", {
    projectPath: command.projectPath,
    grantKind: "tool",
    value: "shell",
    status: "approved"
  });
  const prepared = await call<PrepareReadyResult>("project_queue_prepare_ready", {
    queueId,
    limit: command.maxParallelAgents
  });
  await recordDemoStage(call, queueId, {
    stage: "tool_context",
    status: "needs_review",
    modelAlias: "tool.context.manager",
    outputSummary: `Prepared ${prepared.prepared.length} ready task(s); approvals=${prepared.summary?.approvalRequired ?? 0}.`
  });
  await call("project_queue_decide", {
    queueId,
    decision: "approve_queue",
    note: "Approved by project CLI demo seed after queue shaping."
  });
  await call("project_queue_decide", {
    queueId,
    decision: "start_execution",
    note: "Started by project CLI demo seed."
  });
  await recordDemoStage(call, queueId, {
    stage: "execution",
    status: "running",
    modelAlias: "execute.cheap",
    outputSummary: "Two demo workers are running while approval, patch review, recovery, and blocked work remain visible."
  });

  const laneClaim = await claimDemoTask(call, queueId, {
    worker: "deepseek-direct",
    modelProfile: "review.strong",
    workspacePath: join(command.projectPath, "worktrees", "lane-telemetry"),
    command: "demo-run lane-telemetry",
    skipQueueTaskIds: [toolApproval.queueTaskId, patchReview.queueTaskId, recoveryDemo.queueTaskId, memoryContext.queueTaskId, blockedFollowup.queueTaskId]
  });
  await seedDemoLane(call, queueId, laneClaim, {
    summary: "Mapped project_queue_agent_lanes and worker checkpoint state into the Desktop lane strip.",
    file: "src/desktop/public/index.html",
    command: "npm test -- project-cli",
    nextAction: "Review the live lane state and keep checkpoint updates flowing."
  });

  const healthClaim = await claimDemoTask(call, queueId, {
    worker: "openhands",
    modelProfile: "execute.cheap",
    workspacePath: join(command.projectPath, "worktrees", "queue-health"),
    command: "demo-run queue-health",
    skipQueueTaskIds: [
      toolApproval.queueTaskId,
      laneTelemetry.queueTaskId,
      patchReview.queueTaskId,
      recoveryDemo.queueTaskId,
      memoryContext.queueTaskId,
      blockedFollowup.queueTaskId
    ]
  });
  await seedDemoLane(call, queueId, healthClaim, {
    summary: "Validated queue health, pending approvals, and patch-ready counts for the Desktop dashboard.",
    file: "src/surfaces/projectQueue.ts",
    command: "npm test -- project-queue",
    nextAction: "Use the health strip to decide whether to approve tools, review patches, or recover failed work."
  });

  await call("project_queue_update_task", {
    queueId,
    queueTaskId: patchReview.queueTaskId,
    status: "patch_ready",
    summary: "Seeded patch-ready output for the Desktop review surface.",
    patchRefs: ["demo:patch-review/diff-summary.md"],
    testRefs: ["npm test -- project-cli"]
  });
  await call("project_queue_update_task", {
    queueId,
    queueTaskId: recoveryDemo.queueTaskId,
    status: "failed",
    summary: "Seeded failed worker output so recovery and resume controls have real state.",
    patchRefs: ["demo:recovery/partial-output.md"],
    testRefs: ["npm test -- recovery-demo (failed intentionally)"]
  });

  const dashboard = await call<DashboardResult>("project_queue_dashboard", {
    queueId,
    includeCompletedLanes: false,
    maxEventsPerLane: defaultMaxEventsPerLane()
  });
  const approvals = await call<QueueApprovalInbox>("project_queue_approval_inbox", {
    queueId,
    includeExpired: false,
    limit: 10
  });
  const lanes = await call<AgentLanesResult>("project_queue_agent_lanes", {
    queueId,
    includeCompleted: false,
    maxEventsPerLane: defaultMaxEventsPerLane()
  });

  return {
    action: "demo_seeded",
    message: [
      `Seeded demo queue ${queueId} for ${command.projectPath}.`,
      `Active lanes: ${lanes.count}; pending approvals: ${approvals.count}; active workers: ${dashboard.activeWorkers ?? 0}.`,
      "Open the Desktop dashboard and select this queue to demo the full command-center flow."
    ].join("\n"),
    data: {
      queueId,
      projectPath: command.projectPath,
      title,
      memoryId,
      activeWorkers: dashboard.activeWorkers ?? 0,
      pendingApprovalCount: approvals.count,
      laneCount: lanes.count,
      counts: dashboard.counts,
      tasks: {
        laneTelemetry: laneTelemetry.queueTaskId,
        toolApproval: toolApproval.queueTaskId,
        patchReview: patchReview.queueTaskId,
        recoveryDemo: recoveryDemo.queueTaskId,
        queueHealth: queueHealth.queueTaskId,
        blockedFollowup: blockedFollowup.queueTaskId,
        memoryContext: memoryContext.queueTaskId
      }
    }
  };
}

async function recordDemoStage(
  call: ProjectToolCaller,
  queueId: string,
  stage: {
    stage: string;
    status: string;
    modelAlias: string;
    outputSummary: string;
    artifacts?: unknown[];
    warnings?: string[];
  }
): Promise<void> {
  await call("project_queue_record_stage", {
    queueId,
    stage: stage.stage,
    status: stage.status,
    modelAlias: stage.modelAlias,
    outputSummary: stage.outputSummary,
    artifacts: stage.artifacts ?? [],
    warnings: stage.warnings ?? []
  });
}

function demoSeedTasks(memoryId: string): Array<Record<string, unknown>> {
  return [
    {
      clientKey: "lane-telemetry",
      title: "Wire live agent lane telemetry",
      goal: "Keep Agent Fabric Console lane cards backed by real worker events, checkpoints, and queue task state.",
      phase: "Desktop command center",
      category: "desktop",
      priority: "urgent",
      parallelGroup: "desktop-lanes",
      parallelSafe: true,
      risk: "low",
      expectedFiles: ["src/desktop/public/index.html", "src/runtime/project-cli.ts"],
      acceptanceCriteria: ["Dashboard shows active lanes from worker runs.", "Each lane has latest event, checkpoint summary, and next action."],
      requiredTools: ["shell"]
    },
    {
      clientKey: "tool-approval",
      title: "Gate GitHub MCP for issue-backed task intake",
      goal: "Require a human approval before a worker can use the GitHub MCP integration for project task intake.",
      phase: "Tool/context policy",
      category: "approval",
      priority: "high",
      parallelGroup: "integrations",
      parallelSafe: true,
      risk: "medium",
      expectedFiles: ["src/surfaces/projectQueue.ts"],
      acceptanceCriteria: ["Approval inbox shows the missing GitHub MCP grant.", "The worker is not launched until the grant is approved."],
      requiredTools: ["shell"],
      requiredMcpServers: ["github"]
    },
    {
      clientKey: "patch-review",
      title: "Review patch-ready Desktop output",
      goal: "Show a patch-ready result with test evidence so the review surface has real queue state.",
      phase: "Review",
      category: "review",
      status: "patch_ready",
      priority: "normal",
      parallelSafe: true,
      risk: "low",
      expectedFiles: ["src/desktop/public/index.html"],
      acceptanceCriteria: ["Patch-ready board column lists patch refs and test refs."]
    },
    {
      clientKey: "recovery-demo",
      title: "Recover interrupted worker run",
      goal: "Expose a failed task with partial output so recovery and resume controls are visible.",
      phase: "Recovery",
      category: "recovery",
      status: "failed",
      priority: "normal",
      parallelSafe: true,
      risk: "medium",
      expectedFiles: ["src/runtime/project-cli.ts"],
      acceptanceCriteria: ["Recovery center can identify failed work.", "Resume packet can be generated for the task."]
    },
    {
      clientKey: "queue-health",
      title: "Surface queue health and cost/risk strip",
      goal: "Validate the Desktop health strip from live queue counts, approvals, worker slots, risk, and cost estimates.",
      phase: "Desktop command center",
      category: "dashboard",
      priority: "high",
      parallelGroup: "queue-health",
      parallelSafe: true,
      risk: "low",
      expectedFiles: ["src/surfaces/projectQueue.ts", "src/desktop/public/index.html"],
      acceptanceCriteria: ["Health strip identifies pending approval and failed work.", "Queue board badges match substrate counts."],
      requiredTools: ["shell"]
    },
    {
      clientKey: "blocked-followup",
      title: "Add lane checkpoint drilldown",
      goal: "Add a follow-up lane drilldown once live lane telemetry is accepted.",
      phase: "Desktop command center",
      category: "desktop",
      priority: "normal",
      parallelGroup: "desktop-lanes",
      parallelSafe: true,
      risk: "low",
      dependsOn: ["lane-telemetry"],
      expectedFiles: ["src/desktop/public/index.html"],
      acceptanceCriteria: ["Blocked task is hidden from ready work until the lane telemetry task is done."]
    },
    {
      clientKey: "memory-context",
      title: "Attach demo memory to future workers",
      goal: "Use saved user preference memory only after the prerequisite tool approval path is reviewed.",
      phase: "Memory",
      category: "context",
      priority: "low",
      parallelSafe: true,
      risk: "medium",
      dependsOn: ["tool-approval"],
      expectedFiles: ["src/runtime/project-cli.ts"],
      acceptanceCriteria: ["Memory is proposed as context instead of attached by default."],
      requiredMemories: [memoryId]
    }
  ];
}

function demoCreatedTaskMap(added: Record<string, unknown>): Map<string, { queueTaskId: string; fabricTaskId?: string; clientKey?: string }> {
  const created = Array.isArray(added.created) ? added.created : [];
  const mapped = new Map<string, { queueTaskId: string; fabricTaskId?: string; clientKey?: string }>();
  for (const task of created) {
    if (!task || typeof task !== "object" || Array.isArray(task)) continue;
    const entry = task as Record<string, unknown>;
    if (typeof entry.clientKey !== "string" || typeof entry.queueTaskId !== "string") continue;
    mapped.set(entry.clientKey, {
      queueTaskId: entry.queueTaskId,
      fabricTaskId: typeof entry.fabricTaskId === "string" ? entry.fabricTaskId : undefined,
      clientKey: entry.clientKey
    });
  }
  return mapped;
}

function requireDemoTask(
  tasks: Map<string, { queueTaskId: string; fabricTaskId?: string; clientKey?: string }>,
  clientKey: string
): { queueTaskId: string; fabricTaskId?: string; clientKey?: string } {
  const task = tasks.get(clientKey);
  if (!task) throw new FabricError("PROJECT_DEMO_SEED_FAILED", `demo task not created: ${clientKey}`, false);
  return task;
}

async function claimDemoTask(
  call: ProjectToolCaller,
  queueId: string,
  options: {
    worker: WorkerKind;
    modelProfile: string;
    workspacePath: string;
    command: string;
    skipQueueTaskIds: string[];
  }
): Promise<ClaimNextResult> {
  const claim = await call<ClaimNextResult>("project_queue_claim_next", {
    queueId,
    worker: options.worker,
    workspaceMode: "git_worktree",
    workspacePath: options.workspacePath,
    modelProfile: options.modelProfile,
    command: [options.command],
    skipQueueTaskIds: options.skipQueueTaskIds,
    metadata: { source: "project-cli-demo-seed", demo: true }
  });
  if (!claim.claimed?.fabricTaskId || !claim.workerRun?.workerRunId) {
    throw new FabricError("PROJECT_DEMO_SEED_FAILED", `could not claim demo task for ${options.worker}`, false);
  }
  return claim;
}

async function seedDemoLane(
  call: ProjectToolCaller,
  queueId: string,
  claim: ClaimNextResult,
  lane: {
    summary: string;
    file: string;
    command: string;
    nextAction: string;
  }
): Promise<void> {
  const task = claim.claimed;
  const workerRunId = claim.workerRun?.workerRunId;
  if (!task?.fabricTaskId || !workerRunId) {
    throw new FabricError("PROJECT_DEMO_SEED_FAILED", "claimed demo lane is missing worker state", false);
  }
  const metadata = { queueId, queueTaskId: task.queueTaskId, source: "project-cli-demo-seed" };
  await call("fabric_task_event", {
    taskId: task.fabricTaskId,
    workerRunId,
    kind: "started",
    body: "Demo worker lane started from seeded project queue state.",
    metadata
  });
  await call("fabric_task_event", {
    taskId: task.fabricTaskId,
    workerRunId,
    kind: "thought_summary",
    body: lane.summary,
    metadata
  });
  await call("fabric_task_event", {
    taskId: task.fabricTaskId,
    workerRunId,
    kind: "file_changed",
    refs: [lane.file],
    metadata
  });
  await call("fabric_task_event", {
    taskId: task.fabricTaskId,
    workerRunId,
    kind: "command_finished",
    body: `${lane.command} passed in the seeded demo run.`,
    metadata: { ...metadata, command: lane.command, exitCode: 0 }
  });
  await call("fabric_task_event", {
    taskId: task.fabricTaskId,
    workerRunId,
    kind: "test_result",
    body: "Seeded demo test evidence passed.",
    metadata: { ...metadata, command: lane.command, exitCode: 0 }
  });
  await call("fabric_task_checkpoint", {
    taskId: task.fabricTaskId,
    workerRunId,
    summary: {
      currentGoal: task.goal,
      filesTouched: [lane.file],
      commandsRun: [lane.command],
      testsRun: [lane.command],
      failingTests: [],
      decisions: ["Kept demo state backed by agent-fabric queue, worker, event, and checkpoint records."],
      assumptions: ["This is seeded state for demo and QA, not a generated code patch."],
      blockers: [],
      summary: lane.summary,
      nextAction: lane.nextAction
    }
  });
}

async function startPlan(
  command: Extract<ProjectCliCommand, { command: "start-plan" }>,
  call: ProjectToolCaller
): Promise<ProjectRunResult> {
  const task = command.task ?? (command.taskFile ? readFile(command.taskFile) : undefined);
  if (!task) throw new FabricError("INVALID_INPUT", "start-plan requires task or taskFile", false);
  const chain = await call<Record<string, unknown>>("plan_chain_start", {
    task,
    models: { a: "plan.strong", b: "plan.strong", c: "plan.strong" },
    maxRounds: command.maxRounds,
    budgetUsd: command.budgetUsd,
    outputFormat: command.outputFormat
  });
  await call("project_queue_record_stage", {
    queueId: command.queueId,
    stage: "planning",
    status: "running",
    modelAlias: "plan.strong",
    planChainId: chain.chainId,
    inputSummary: "Plan chain started from project CLI.",
    artifacts: [{ kind: "plan_chain", chainId: chain.chainId }]
  });
  return {
    action: "plan_started",
    message: `Started plan chain ${String(chain.chainId)} for queue ${command.queueId}.`,
    data: chain
  };
}

async function improvePrompt(
  command: Extract<ProjectCliCommand, { command: "improve-prompt" }>,
  call: ProjectToolCaller,
  runModel: ProjectModelRunner
): Promise<ProjectRunResult> {
  const prompt = command.prompt ?? (command.promptFile ? readFile(command.promptFile) : undefined);
  if (!prompt) throw new FabricError("INVALID_INPUT", "improve-prompt requires prompt or promptFile", false);
  const queueStatus = await call<QueueStatus>("project_queue_status", { queueId: command.queueId });
  const factors = command.factorsFile ? readFile(command.factorsFile) : undefined;
  const route = await resolveAlias(command.modelAlias, "prompt_improvement", prompt.length, "medium", call);
  const preflight = await preflightProjectModel({
    call,
    queueId: command.queueId,
    taskType: "prompt_improvement",
    modelAlias: command.modelAlias,
    route,
    text: prompt,
    approvalToken: command.approvalToken,
    contextSummary: {
      inputTokens: estimateTokens(prompt) + estimateTokens(factors ?? ""),
      source: "agent-fabric-project improve-prompt",
      hasFactors: Boolean(factors)
    }
  });
  if (preflight.decision !== "allow") {
    await call("project_queue_record_stage", {
      queueId: command.queueId,
      stage: "prompt_improvement",
      status: "needs_review",
      modelAlias: command.modelAlias,
      inputSummary: "Prompt improvement preflight requires human action before model execution.",
      artifacts: [{ kind: "llm_preflight", requestId: preflight.requestId, decision: preflight.decision, risk: preflight.risk }],
      warnings: preflight.warnings ?? []
    });
    return preflightBlockedResult("prompt_improvement_blocked", preflight);
  }

  const generated = await runModel({
    kind: "prompt_improvement",
    modelAlias: command.modelAlias,
    route,
    queue: queueStatus.queue as unknown as Record<string, unknown>,
    input: {
      prompt,
      factors,
      instructions: promptImprovementInstructions()
    }
  });
  const improvedPrompt = requiredGeneratedString(generated, "improvedPrompt");
  const summary = typeof generated.summary === "string" ? generated.summary : summarizeText(improvedPrompt);
  const warnings = stringArray(generated.warnings);
  if (command.outputFile) writeFileSync(command.outputFile, improvedPrompt, "utf8");
  await call("project_queue_record_stage", {
    queueId: command.queueId,
    stage: "prompt_improvement",
    status: command.accept ? "accepted" : "needs_review",
    modelAlias: command.modelAlias,
    inputSummary: "Prompt improved by configured project model runner.",
    outputSummary: summary,
    artifacts: [
      { kind: "llm_preflight", requestId: preflight.requestId, decision: preflight.decision, risk: preflight.risk },
      { kind: "improved_prompt", outputFile: command.outputFile, characterCount: improvedPrompt.length }
    ],
    warnings
  });
  if (command.accept) {
    await call("project_queue_decide", {
      queueId: command.queueId,
      decision: "accept_improved_prompt",
      note: "Accepted by project CLI improve-prompt command."
    });
  }
  return {
    action: "prompt_improved",
    message: command.outputFile
      ? `Improved prompt written to ${command.outputFile}.`
      : `Improved prompt ready for review:\n\n${improvedPrompt}`,
    data: { queueId: command.queueId, improvedPrompt, summary, warnings, outputFile: command.outputFile, preflight }
  };
}

async function generateTasks(
  command: Extract<ProjectCliCommand, { command: "generate-tasks" }>,
  call: ProjectToolCaller,
  runModel: ProjectModelRunner
): Promise<ProjectRunResult> {
  const plan = readFile(command.planFile);
  const queueStatus = await call<QueueStatus>("project_queue_status", { queueId: command.queueId });
  const route = await resolveAlias(command.modelAlias, "task_generation", plan.length, "medium", call);
  const preflight = await preflightProjectModel({
    call,
    queueId: command.queueId,
    taskType: "task_generation",
    modelAlias: command.modelAlias,
    route,
    text: plan,
    approvalToken: command.approvalToken,
    contextSummary: {
      inputTokens: estimateTokens(plan),
      source: "agent-fabric-project generate-tasks",
      planFile: command.planFile
    }
  });
  if (preflight.decision !== "allow") {
    await call("project_queue_record_stage", {
      queueId: command.queueId,
      stage: "task_writing",
      status: "needs_review",
      modelAlias: command.modelAlias,
      inputSummary: "Task-generation preflight requires human action before model execution.",
      artifacts: [{ kind: "llm_preflight", requestId: preflight.requestId, decision: preflight.decision, risk: preflight.risk }],
      warnings: preflight.warnings ?? []
    });
    return preflightBlockedResult("task_generation_blocked", preflight);
  }

  const generated = await runModel({
    kind: "task_generation",
    modelAlias: command.modelAlias,
    route,
    queue: queueStatus.queue as unknown as Record<string, unknown>,
    input: {
      plan,
      instructions: taskGenerationInstructions()
    }
  });
  const payload = normalizeGeneratedTasks(generated);
  if (command.tasksFile) writeFileSync(command.tasksFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await call("project_queue_record_stage", {
    queueId: command.queueId,
    stage: "phasing",
    status: "completed",
    modelAlias: "phase.splitter",
    outputSummary: `Generated ${payload.phases.length} phase(s).`
  });
  await call("project_queue_record_stage", {
    queueId: command.queueId,
    stage: "task_writing",
    status: "completed",
    modelAlias: command.modelAlias,
    outputSummary: `Generated ${payload.tasks.length} coding task(s).`
  });
  const added = await call<Record<string, unknown>>("project_queue_add_tasks", {
    queueId: command.queueId,
    tasks: payload.tasks
  });
  await call("project_queue_record_stage", {
    queueId: command.queueId,
    stage: "queue_shaping",
    status: "completed",
    modelAlias: command.modelAlias,
    outputSummary: "Generated tasks were validated and added to the dependency-aware queue.",
    artifacts: [
      { kind: "llm_preflight", requestId: preflight.requestId, decision: preflight.decision, risk: preflight.risk },
      { kind: "generated_tasks", tasksFile: command.tasksFile, taskCount: payload.tasks.length }
    ]
  });
  if (command.approveQueue) {
    await call("project_queue_decide", {
      queueId: command.queueId,
      decision: "approve_queue",
      note: "Approved by project CLI generate-tasks command."
    });
  }
  return {
    action: "tasks_generated",
    message: `Generated and imported ${payload.tasks.length} task(s) for queue ${command.queueId}.`,
    data: { queueId: command.queueId, phases: payload.phases, tasks: payload.tasks, added, tasksFile: command.tasksFile, preflight }
  };
}

async function reviewQueue(
  command: Extract<ProjectCliCommand, { command: "review-queue" }>,
  call: ProjectToolCaller
): Promise<ProjectRunResult> {
  const status = await call<QueueStatus>("project_queue_status", { queueId: command.queueId });
  const next = await call<NextReadyResult>("project_queue_next_ready", { queueId: command.queueId });
  if (command.approveQueue) {
    await call("project_queue_decide", {
      queueId: command.queueId,
      decision: "approve_queue",
      note: "Approved by project CLI review-queue command."
    });
  }
  return {
    action: command.approveQueue ? "queue_reviewed_and_approved" : "queue_reviewed",
    message: formatQueueReview(status, next, command.approveQueue),
    data: { status, nextReady: next, approved: command.approveQueue }
  };
}

async function reviewPatches(
  command: Extract<ProjectCliCommand, { command: "review-patches" }>,
  call: ProjectToolCaller
): Promise<ProjectRunResult> {
  const status = await call<QueueStatus>("project_queue_status", { queueId: command.queueId });
  let applyResult: ReviewedPatchApplyResult | undefined;
  if (command.acceptTaskId) {
    const task = status.tasks.find((entry) => entry.queueTaskId === command.acceptTaskId);
    if (!task) throw new FabricError("PROJECT_QUEUE_TASK_NOT_FOUND", `Queue task not found: ${command.acceptTaskId}`, false);
    if (command.applyPatch) {
      applyResult = await applyReviewedPatch(command, status, task, call);
    }
    await call("project_queue_update_task", {
      queueId: command.queueId,
      queueTaskId: command.acceptTaskId,
      status: "accepted",
      summary: applyResult ? `Applied reviewed patch ${applyResult.patchFile}.` : "Accepted by project CLI review-patches command.",
      patchRefs: applyResult ? uniqueStrings([...stringArray(task.patchRefs), applyResult.patchFile]) : [],
      testRefs: stringArray(task.testRefs)
    });
  }
  const refreshed = await call<QueueStatus>("project_queue_status", { queueId: command.queueId });
  const patchReady = refreshed.tasks.filter((task) => ["patch_ready", "review", "accepted"].includes(task.status));
  return {
    action: applyResult ? "patch_applied_and_accepted" : command.acceptTaskId ? "patch_accepted" : "patches_reviewed",
    message: formatPatchReview(refreshed.queue.queueId, patchReady, command.acceptTaskId, applyResult),
    data: { queueId: command.queueId, patchReady, acceptedTaskId: command.acceptTaskId, appliedPatch: applyResult }
  };
}

async function applyReviewedPatch(
  command: Extract<ProjectCliCommand, { command: "review-patches" }>,
  status: QueueStatus,
  task: QueueTask,
  call: ProjectToolCaller
): Promise<ReviewedPatchApplyResult> {
  if (!task.fabricTaskId) throw new FabricError("FABRIC_TASK_NOT_FOUND", `Queue task has no linked fabric task: ${task.queueTaskId}`, false);
  if (!["patch_ready", "review", "accepted"].includes(task.status)) {
    throw new FabricError("PATCH_NOT_APPLYABLE", `Task ${task.queueTaskId} is not patch-ready`, false);
  }
  const fabricStatus = await call<FabricTaskStatusResult>("fabric_task_status", {
    taskId: task.fabricTaskId,
    includeEvents: true,
    includeCheckpoints: true
  });
  const candidate = resolveReviewedPatchCandidate(task, fabricStatus);
  const candidateWorkerRunId = candidate.workerRunId;
  if (!candidateWorkerRunId) {
    throw new FabricError("PATCH_NOT_APPLYABLE", "No worker run is available for reviewed patch application", false);
  }
  if (candidate.structuredResult?.patchMode !== "write") {
    throw new FabricError("PATCH_NOT_APPLYABLE", "review-patches --apply-patch requires a worker artifact from --patch-mode write", false);
  }
  const cwd = command.applyCwd ?? candidate.workspacePath ?? fabricStatus.projectPath ?? status.queue.projectPath;
  const patchFile = resolveReviewPatchFile(candidate.patchFile, cwd);
  const patch = readFileSync(patchFile, "utf8");
  validateGitStylePatch(patch, cwd);
  const patchApply = await applyPatchWithSystemPatch(patch, cwd);
  await call("fabric_task_event", {
    taskId: task.fabricTaskId,
    workerRunId: candidateWorkerRunId,
    kind: "checkpoint",
    body: `Applied reviewed patch ${patchFile}.`,
    metadata: {
      action: "review_patch_apply",
      queueId: command.queueId,
      queueTaskId: task.queueTaskId,
      patchFile,
      cwd,
      patchApply
    }
  });
  await call("fabric_task_checkpoint", {
    taskId: task.fabricTaskId,
    workerRunId: candidateWorkerRunId,
    summary: {
      currentGoal: task.goal,
      filesTouched: uniqueStrings([...stringArray(task.patchRefs), patchFile]),
      commandsRun: ["review-patches --apply-patch"],
      testsRun: stringArray(task.testRefs),
      decisions: ["Applied reviewed patch after explicit review-patches acceptance."],
      assumptions: [],
      blockers: [],
      nextAction: "Run final verification for the accepted patch.",
      patchApply,
      patchFile,
      cwd
    }
  });
  await call("fabric_task_finish", {
    taskId: task.fabricTaskId,
    workerRunId: candidateWorkerRunId,
    status: "completed",
    summary: `Applied reviewed patch ${patchFile}.`,
    patchRefs: uniqueStrings([...stringArray(task.patchRefs), patchFile]),
    testRefs: stringArray(task.testRefs)
  });
  return {
    queueTaskId: task.queueTaskId,
    fabricTaskId: task.fabricTaskId,
    workerRunId: candidateWorkerRunId,
    patchFile,
    cwd,
    patchApply
  };
}

function resolveReviewedPatchCandidate(
  task: QueueTask,
  fabricStatus: FabricTaskStatusResult,
  options: { requireWorkerRun?: boolean } = {}
): { workerRunId?: string; patchFile: string; workspacePath?: string; structuredResult?: StructuredWorkerResult } {
  const structured = latestStructuredResultFromCheckpoints(fabricStatus);
  const patchFile = structured?.patchFile ?? stringArray(task.patchRefs).find((ref) => ref.endsWith(".patch"));
  if (!patchFile) {
    throw new FabricError("PATCH_NOT_APPLYABLE", "No reviewed patch file is available for this task", false);
  }
  const workerRunId = checkpointWorkerRunIdForStructuredResult(fabricStatus, structured) ?? task.assignedWorkerRunId;
  if (!workerRunId && options.requireWorkerRun !== false) {
    throw new FabricError("PATCH_NOT_APPLYABLE", "No worker run is available for reviewed patch application", false);
  }
  const workspacePath = fabricStatus.workerRuns?.find((run) => run.workerRunId === workerRunId)?.workspacePath;
  return { workerRunId, patchFile, workspacePath, structuredResult: structured };
}

function latestStructuredResultFromCheckpoints(fabricStatus: FabricTaskStatusResult): StructuredWorkerResult | undefined {
  const checkpoints = [...(fabricStatus.checkpoints ?? [])].reverse();
  for (const checkpoint of checkpoints) {
    const structured = structuredResultFromCheckpointSummary(checkpoint.summary);
    if (structured) return structured;
  }
  return structuredResultFromCheckpointSummary(fabricStatus.latestCheckpoint?.summary);
}

function checkpointWorkerRunIdForStructuredResult(fabricStatus: FabricTaskStatusResult, structured: StructuredWorkerResult | undefined): string | undefined {
  if (!structured) return undefined;
  const checkpoints = [...(fabricStatus.checkpoints ?? [])].reverse();
  for (const checkpoint of checkpoints) {
    if (structuredResultFromCheckpointSummary(checkpoint.summary)?.source === structured.source) return checkpoint.workerRunId;
  }
  return fabricStatus.latestCheckpoint?.workerRunId;
}

function structuredResultFromCheckpointSummary(summary: Record<string, unknown> | undefined): StructuredWorkerResult | undefined {
  if (!summary) return undefined;
  const value = summary.structuredResult;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as StructuredWorkerResult;
}

function resolveReviewPatchFile(patchFile: string, cwd: string): string {
  const resolved = isAbsolute(patchFile) ? resolve(patchFile) : resolve(cwd, patchFile);
  if (!isPathInside(resolved, cwd)) {
    throw new FabricError("PATCH_NOT_APPLYABLE", `Reviewed patch file must be inside apply cwd: ${resolved}`, false);
  }
  return resolved;
}

async function validateStructuredPatchArtifact(cwd: string, patchFile: string): Promise<string> {
  const resolved = resolveReviewPatchFile(patchFile, cwd);
  const patch = readFileSync(resolved, "utf8");
  await checkPatchWithSystemPatch(patch, cwd);
  return patchFile;
}

function isPathInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function writeTaskPackets(
  command: Extract<ProjectCliCommand, { command: "write-task-packets" }>,
  call: ProjectToolCaller
): Promise<ProjectRunResult> {
  const status = await call<QueueStatus>("project_queue_status", { queueId: command.queueId });
  const next = command.readyOnly ? await call<NextReadyResult>("project_queue_next_ready", { queueId: command.queueId }) : undefined;
  const readyIds = new Set(next?.ready.map((task) => task.queueTaskId));
  const tasks = command.readyOnly ? status.tasks.filter((task) => readyIds.has(task.queueTaskId)) : status.tasks;
  const packets = tasks.map((task) => writeTaskPacket(status, task, command.outDir, command.format));
  return {
    action: "task_packets_written",
    message: formatTaskPacketsWritten(command.queueId, packets),
    data: { queueId: command.queueId, outDir: command.outDir, format: command.format, packets }
  };
}

async function resumeQueueTask(
  command: Extract<ProjectCliCommand, { command: "resume-task" }>,
  call: ProjectToolCaller
): Promise<ProjectRunResult> {
  const result = await call<QueueResumeResult>("project_queue_resume_task", {
    queueId: command.queueId,
    queueTaskId: command.queueTaskId,
    preferredWorker: command.preferredWorker
  });
  if (command.outputFile) {
    const body =
      command.format === "markdown"
        ? formatResumePacketMarkdown(result.taskPacket)
        : `${JSON.stringify(result.taskPacket, null, 2)}\n`;
    writeFileSync(command.outputFile, body, "utf8");
  }
  return {
    action: "resume_task",
    message: formatResumeTaskResult(command, result),
    data: { ...result, outputFile: command.outputFile, format: command.format } as unknown as Record<string, unknown>
  };
}

async function runTask(
  command: Extract<ProjectCliCommand, { command: "run-task" }>,
  call: ProjectToolCaller
): Promise<ProjectRunResult> {
  const status = await call<QueueStatus>("project_queue_status", { queueId: command.queueId });
  const task = status.tasks.find((entry) => entry.queueTaskId === command.queueTaskId);
  if (!task) throw new FabricError("PROJECT_QUEUE_TASK_NOT_FOUND", `Queue task not found: ${command.queueTaskId}`, false);
  if (!task.fabricTaskId) throw new FabricError("FABRIC_TASK_NOT_FOUND", `Queue task has no linked fabric task: ${command.queueTaskId}`, false);
  assertQueueRunnable(status.queue.status);
  const cwd = command.cwd ?? status.queue.projectPath;
  const proposal = await call<ToolContextProposal>("tool_context_propose", {
    queueId: command.queueId,
    queueTaskId: task.queueTaskId,
    fabricTaskId: task.fabricTaskId,
    mcpServers: stringArray(task.requiredMcpServers),
    tools: uniqueStrings(["shell", ...stringArray(task.requiredTools)]),
    memories: stringArray(task.requiredMemories),
    contextRefs: stringArray(task.requiredContextRefs),
    modelAlias: "tool.context.manager",
    reasoning: `Run explicit command for queue task ${task.queueTaskId}.`
  });
  if (proposal.approvalRequired) {
    if (!command.approveToolContext) {
      return {
        action: "run_task_blocked",
        message: `Tool/context approval required before running shell command. proposal=${proposal.proposalId}`,
        data: { queueId: command.queueId, queueTaskId: task.queueTaskId, proposalId: proposal.proposalId, missingGrants: proposal.missingGrants ?? [] }
      };
    }
    await call("tool_context_decide", {
      proposalId: proposal.proposalId,
      decision: "approve",
      remember: command.rememberToolContext,
      note: "Approved by project CLI run-task command."
    });
  }

  const modelPreflight = await preflightDeepSeekWorkerCommand(command, task, status, call);
  if (modelPreflight && modelPreflight.decision !== "allow") {
    return {
      action: "run_task_blocked",
      message: `DeepSeek direct model approval required before running worker command. request=${modelPreflight.requestId}`,
      data: { queueId: command.queueId, queueTaskId: task.queueTaskId, preflight: modelPreflight }
    };
  }

  prepareRunWorkspace(command.workspaceMode, cwd, command.cwdPrep ?? "auto", status.queue.projectPath);

  let workerRunId = task.assignedWorkerRunId;
  if (!workerRunId) {
    const worker = await call<Record<string, unknown>>("fabric_task_start_worker", {
      taskId: task.fabricTaskId,
      worker: command.worker,
      projectPath: status.queue.projectPath,
      workspaceMode: command.workspaceMode,
      workspacePath: cwd,
      modelProfile: command.modelProfile,
      contextPolicy: `tool_context:${proposal.proposalId}`,
      maxRuntimeMinutes: command.maxRuntimeMinutes,
      command: [command.commandLine],
      metadata: taskPacketMetadata(command.taskPacketPath, command.taskPacketFormat, command.taskContextPath)
    });
    workerRunId = String(worker.workerRunId);
    await call("project_queue_assign_worker", {
      queueId: command.queueId,
      queueTaskId: task.queueTaskId,
      workerRunId
    });
    await call("fabric_task_event", {
      taskId: task.fabricTaskId,
      workerRunId,
      kind: "started",
      body: "Worker run started by project CLI run-task command.",
      metadata: {
        queueId: command.queueId,
        queueTaskId: task.queueTaskId,
        toolContextProposalId: proposal.proposalId,
        ...taskPacketMetadata(command.taskPacketPath, command.taskPacketFormat, command.taskContextPath)
      }
    });
  }

  const before = snapshotFiles(cwd);
  await call("fabric_task_event", {
    taskId: task.fabricTaskId,
    workerRunId,
    kind: "command_started",
    body: command.commandLine,
    metadata: { cwd, queueId: command.queueId, queueTaskId: task.queueTaskId, ...taskPacketMetadata(command.taskPacketPath, command.taskPacketFormat, command.taskContextPath) }
  });
  const startedAt = Date.now();
  const stopHeartbeat = startWorkerHeartbeat(command, task, workerRunId, cwd, call);
  const result = await runShellCommand(
    command.commandLine,
    cwd,
    command.maxOutputChars,
    command.maxRuntimeMinutes,
    queueVisibleWorkerEnv(command, task, status.queue, workerRunId),
    {
      onSpawn: (pid) => {
        void call("fabric_task_event", {
          taskId: task.fabricTaskId,
          workerRunId,
          kind: "command_spawned",
          body: command.commandLine,
          metadata: {
            cwd,
            pid,
            queueId: command.queueId,
            queueTaskId: task.queueTaskId,
            ...taskPacketMetadata(command.taskPacketPath, command.taskPacketFormat, command.taskContextPath)
          }
        }).catch(() => undefined);
      }
    }
  ).finally(stopHeartbeat);
  const durationMs = Date.now() - startedAt;
  await call("fabric_task_event", {
    taskId: task.fabricTaskId,
    workerRunId,
    kind: "command_finished",
    body: tailText(result.stdout || result.stderr, command.maxOutputChars),
    metadata: {
      cwd,
      command: command.commandLine,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs,
      stdoutTail: tailText(result.stdout, command.maxOutputChars),
      stderrTail: tailText(result.stderr, command.maxOutputChars)
    }
  });
  if (looksLikeTestCommand(command.commandLine)) {
    await call("fabric_task_event", {
      taskId: task.fabricTaskId,
      workerRunId,
      kind: "test_result",
      body: result.exitCode === 0 ? "Test command passed." : "Test command failed.",
      metadata: { command: command.commandLine, exitCode: result.exitCode, durationMs }
    });
  }

  const changedFiles = diffSnapshots(before, snapshotFiles(cwd));
  const structuredResult = loadStructuredWorkerResult(cwd, result.stdout, changedFiles);
  const structuredStatus = structuredResult?.status;
  const structuredSummary = structuredResult?.summary;
  const suggestedFiles = structuredResult?.changedFilesSuggested ?? [];
  const suggestedTests = structuredResult?.testsSuggested ?? [];
  let patchValidationError: string | undefined;
  let structuredPatchRefs: string[] = [];
  if (structuredResult?.patchFile) {
    if (SENIOR_DEEPSEEK_WORKERS.has(command.worker)) {
      try {
        structuredPatchRefs = [await validateStructuredPatchArtifact(cwd, structuredResult.patchFile)];
      } catch (error) {
        patchValidationError = error instanceof Error ? error.message : String(error);
      }
    } else {
      structuredPatchRefs = [structuredResult.patchFile];
    }
  }
  for (const file of changedFiles.slice(0, 50)) {
    await call("fabric_task_event", {
      taskId: task.fabricTaskId,
      workerRunId,
      kind: "file_changed",
      refs: [file],
      metadata: { cwd }
    });
  }
  if (structuredResult) {
    await call("fabric_task_event", {
      taskId: task.fabricTaskId,
      workerRunId,
      kind: "checkpoint",
      body: structuredSummary,
      metadata: {
        cwd,
        structuredResult,
        structuredResultSource: structuredResult.source
      }
    });
  }
  const deepSeekPatchReadyRequiresPatch = SENIOR_DEEPSEEK_WORKERS.has(command.worker) && command.successStatus === "patch_ready";
  const finalStatus =
    result.exitCode !== 0 || structuredStatus === "failed" || structuredStatus === "blocked" || patchValidationError
      ? "failed"
      : structuredStatus === "completed"
        ? "completed"
        : deepSeekPatchReadyRequiresPatch && structuredPatchRefs.length === 0
          ? "completed"
          : command.successStatus;
  await call("fabric_task_checkpoint", {
    taskId: task.fabricTaskId,
    workerRunId,
    summary: {
      currentGoal: task.goal,
      filesTouched: uniqueStrings([...changedFiles, ...suggestedFiles, ...structuredPatchRefs]),
      commandsRun: [command.commandLine],
      testsRun: looksLikeTestCommand(command.commandLine) ? [command.commandLine] : [],
      failingTests: looksLikeTestCommand(command.commandLine) && result.exitCode !== 0 ? [command.commandLine] : [],
      decisions: [],
      assumptions: [],
      blockers: uniqueStrings([...workerBlockers(result.exitCode, structuredStatus, structuredResult), ...(patchValidationError ? [patchValidationError] : [])]),
      nextAction:
        finalStatus === "failed"
          ? "Inspect command failure or structured blocker and rerun."
          : finalStatus === "patch_ready"
            ? "Review patch-ready output."
            : "Review completed worker report.",
      structuredResult,
      testsSuggested: suggestedTests,
      stdoutTail: tailText(result.stdout, command.maxOutputChars),
      stderrTail: tailText(result.stderr, command.maxOutputChars)
    }
  });
  await call("fabric_task_event", {
    taskId: task.fabricTaskId,
    workerRunId,
    kind: finalStatus === "failed" ? "failed" : finalStatus === "completed" ? "completed" : "patch_ready",
    body: structuredSummary ?? (result.exitCode === 0 ? "Worker command completed." : `Worker command failed with exit code ${result.exitCode}.`),
    refs: uniqueStrings([...changedFiles, ...suggestedFiles, ...structuredPatchRefs])
  });
  await call("project_queue_update_task", {
    queueId: command.queueId,
    queueTaskId: task.queueTaskId,
    workerRunId,
    status: finalStatus,
    summary: structuredSummary ?? (result.exitCode === 0 ? "Worker command completed." : `Worker command failed with exit code ${result.exitCode}.`),
    patchRefs: uniqueStrings([...changedFiles, ...suggestedFiles, ...structuredPatchRefs]),
    testRefs: looksLikeTestCommand(command.commandLine) ? [command.commandLine] : []
  });

  return {
    action: finalStatus === "failed" ? "task_run_failed" : "task_run_completed",
    message: formatRunTaskResult(task, workerRunId, result.exitCode, changedFiles),
    data: {
      queueId: command.queueId,
      queueTaskId: task.queueTaskId,
      fabricTaskId: task.fabricTaskId,
      workerRunId,
      exitCode: result.exitCode,
      changedFiles,
      structuredResult,
      stdoutTail: tailText(result.stdout, command.maxOutputChars),
      stderrTail: tailText(result.stderr, command.maxOutputChars),
      ...taskPacketMetadata(command.taskPacketPath, command.taskPacketFormat, command.taskContextPath)
    }
  };
}

async function runReady(
  command: Extract<ProjectCliCommand, { command: "run-ready" }>,
  call: ProjectToolCaller
): Promise<ProjectRunResult> {
  const status = await call<QueueStatus>("project_queue_status", { queueId: command.queueId });
  const next = await call<NextReadyResult>("project_queue_next_ready", { queueId: command.queueId, limit: command.limit });
  let currentParallel = normalizeParallel(command.parallel);
  const minParallel = normalizeMinParallel(command.minParallel ?? 1, currentParallel);
  const ready = next.ready;
  assertParallelCwdPolicy(command, ready, status.queue.projectPath, currentParallel);
  await blockMissingReadyContextRefs(command.queueId, status.queue.projectPath, ready, call);
  const runs: ProjectRunResult[] = [];
  const skipped: Record<string, unknown>[] = [];
  const parallelAdjustments: Record<string, unknown>[] = [];
  let rateLimitSignals = 0;

  for (let index = 0; index < ready.length; ) {
    const batchParallel = currentParallel;
    const batch = ready.slice(index, index + batchParallel);
    const batchResults = await Promise.all(
      batch.map(async (task) => {
        if (!task.fabricTaskId) {
          return { skipped: { queueTaskId: task.queueTaskId, title: task.title, reason: "missing fabricTaskId" } };
        }
        const taskPacket = command.taskPacketDir ? writeTaskPacket(status, task, command.taskPacketDir, command.taskPacketFormat) : undefined;
        const commandLine = commandLineForReadyTask(command, task, status.queue.projectPath, taskPacket?.path, taskPacket?.contextPath);
        const result = await runTask(
          {
            command: "run-task",
            json: command.json,
            queueId: command.queueId,
            queueTaskId: task.queueTaskId,
            commandLine,
            taskPacketPath: taskPacket?.path,
            taskPacketFormat: taskPacket?.format === "markdown" ? "markdown" : "json",
            taskContextPath: taskPacket?.contextPath,
            cwd: cwdForReadyTask(command, task, status.queue.projectPath),
            cwdPrep: command.cwdPrep ?? "auto",
            worker: command.worker,
            workspaceMode: command.workspaceMode,
            modelProfile: command.modelProfile,
            maxRuntimeMinutes: command.maxRuntimeMinutes,
            approvalToken: command.approvalToken,
            successStatus: command.successStatus,
            maxOutputChars: command.maxOutputChars,
            approveToolContext: command.approveToolContext,
            rememberToolContext: command.rememberToolContext
          },
          call
        );
        return {
          result: taskPacket
            ? {
                ...result,
                data: {
                  ...result.data,
                  taskPacketPath: taskPacket.path,
                  taskPacketFormat: taskPacket.format,
                  taskContextPath: taskPacket.contextPath,
                  taskContextFiles: taskPacket.contextFiles
                }
              }
            : result
        };
      })
    );
    index += batch.length;
    for (const entry of batchResults) {
      if (entry.skipped) skipped.push(entry.skipped);
      if (entry.result) {
        if (entry.result.action === "run_task_blocked") {
          const preflight = entry.result.data.preflight as Record<string, unknown> | undefined;
          skipped.push({
            queueTaskId: entry.result.data.queueTaskId,
            reason: preflight ? "model approval required" : "tool/context approval required",
            proposalId: entry.result.data.proposalId,
            requestId: typeof preflight?.requestId === "string" ? preflight.requestId : undefined
          });
        } else {
          runs.push(entry.result);
        }
      }
    }
    const batchRateLimitSignals = batchResults.filter((entry) => entry.result && isRateLimitRunResult(entry.result)).length;
    rateLimitSignals += batchRateLimitSignals;
    if (command.adaptiveRateLimit === true && batchRateLimitSignals > 0 && currentParallel > minParallel) {
      const nextParallel = Math.max(minParallel, Math.floor(currentParallel / 2));
      parallelAdjustments.push({
        reason: "deepseek_rate_limit",
        batchStart: index,
        signals: batchRateLimitSignals,
        from: currentParallel,
        to: nextParallel
      });
      currentParallel = nextParallel;
    }
    const failed = batchResults.some((entry) => entry.result?.action === "task_run_failed");
    if (!command.continueOnFailure && failed && !(command.adaptiveRateLimit === true && batchRateLimitSignals > 0)) break;
  }

  return {
    action: "ready_tasks_run",
    message: formatRunReadyResult(command.queueId, runs, skipped, next),
    data: {
      queueId: command.queueId,
      runCount: runs.length,
      skipped,
      runs: runs.map((result) => ({ action: result.action, ...result.data })),
      activeWorkers: next.activeWorkers,
      availableSlots: next.availableSlots,
      initialParallel: normalizeParallel(command.parallel),
      finalParallel: currentParallel,
      minParallel,
      adaptiveRateLimit: command.adaptiveRateLimit === true,
      rateLimitSignals,
      parallelAdjustments
    }
  };
}

async function withQueueRunnerLock<T>(commandName: string, queueId: string, allowConcurrentRunner: boolean, run: () => Promise<T>): Promise<T> {
  if (allowConcurrentRunner) return run();
  const root = join(tmpdir(), "agent-fabric-runner-locks");
  mkdirSync(root, { recursive: true });
  const lockDir = join(root, `${safePathPart(queueId)}.lock`);
  acquireQueueRunnerLock(commandName, queueId, lockDir);
  try {
    return await run();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function acquireQueueRunnerLock(commandName: string, queueId: string, lockDir: string): void {
  try {
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, "owner.json"),
      `${JSON.stringify({ command: commandName, queueId, pid: process.pid, createdAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8"
    );
    return;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "EEXIST") throw error;
  }

  const ageMs = Date.now() - statSync(lockDir).mtimeMs;
  if (ageMs > RUNNER_LOCK_STALE_MS) {
    rmSync(lockDir, { recursive: true, force: true });
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, "owner.json"),
      `${JSON.stringify({ command: commandName, queueId, pid: process.pid, createdAt: new Date().toISOString(), replacedStaleLock: true }, null, 2)}\n`,
      "utf8"
    );
    return;
  }

  throw new FabricError(
    "PROJECT_QUEUE_RUNNER_ACTIVE",
    `Another local queue runner appears active for ${queueId}. Use --allow-concurrent-runner only when you intentionally want overlapping schedulers.`,
    true
  );
}

async function factoryRun(
  command: Extract<ProjectCliCommand, { command: "factory-run" }>,
  call: ProjectToolCaller
): Promise<ProjectRunResult> {
  const status = await call<QueueStatus>("project_queue_status", { queueId: command.queueId });
  const reviewMatrix = await call<ReviewMatrixResult>("project_queue_review_matrix", { queueId: command.queueId, limit: command.limit });
  const prepared = await call<PrepareReadyResult>("project_queue_prepare_ready", { queueId: command.queueId, limit: command.limit });
  const launchPlan = await call<LaunchPlanResult>("project_queue_launch_plan", { queueId: command.queueId, limit: command.limit });
  let startDecision: Record<string, unknown> | undefined;
  if (command.startExecution && status.queue.status !== "running") {
    startDecision = await call<Record<string, unknown>>("project_queue_decide", {
      queueId: command.queueId,
      decision: "start_execution",
      note: "Started by project CLI factory-run."
    });
  }

  const packetDir = command.taskPacketDir ? resolve(command.taskPacketDir) : join(tmpdir(), "agent-fabric-factory", command.queueId, "task-packets");
  const cwdTemplate = command.cwdTemplate ? resolve(command.cwdTemplate) : defaultSeniorCwdTemplate(command.queueId);
  const commandTemplate = [
    "AGENT_FABRIC_DEEPSEEK_AUTO_QUEUE=off",
    command.deepSeekWorkerCommand,
    "run-task",
    "--json",
    "--task-packet",
    "{{taskPacket}}",
    "--context-file",
    "{{contextFile}}",
    "--fabric-task",
    "{{fabricTaskId}}",
    "--role",
    command.deepSeekRole === "auto" ? "{{deepseekRole}}" : command.deepSeekRole,
    "--patch-mode",
    command.patchMode
  ].join(" ");
  const sensitiveFlag =
    command.allowSensitiveContext || command.sensitiveContextMode === "off"
      ? "--allow-sensitive-context"
      : command.sensitiveContextMode === "strict"
        ? "--sensitive-context-mode strict"
        : "";
  const commandTemplateWithFlags = [commandTemplate, sensitiveFlag].filter(Boolean).join(" ");

  if (command.dryRun) {
    return {
      action: "factory_run_preview",
      message: formatFactoryRunPreview(command.queueId, reviewMatrix, prepared, launchPlan, packetDir, cwdTemplate),
      data: {
        queueId: command.queueId,
        reviewMatrix: reviewMatrix as unknown as Record<string, unknown>,
        prepared: prepared as unknown as Record<string, unknown>,
        launchPlan: launchPlan as unknown as Record<string, unknown>,
        packetDir,
        cwdTemplate,
        commandTemplate: commandTemplateWithFlags,
        startDecision
      }
    };
  }

  let modelApproval: Record<string, unknown> | undefined;
  let approvalToken = command.approvalToken;
  if (command.approveModelCalls && !approvalToken) {
    modelApproval = await call<Record<string, unknown>>("project_queue_approve_model_calls", {
      queueId: command.queueId,
      candidateModel: "deepseek-v4-pro",
      requestedProvider: "deepseek",
      requestedReasoning: "max",
      note: "Approved by project CLI factory-run --approve-model-calls."
    });
    approvalToken = typeof modelApproval.approvalToken === "string" ? modelApproval.approvalToken : undefined;
  }

  const run = await runReady(
    {
      command: "run-ready",
      json: command.json,
      queueId: command.queueId,
      commandTemplate: commandTemplateWithFlags,
      cwdTemplate,
      cwdPrep: "auto",
      taskPacketDir: packetDir,
      taskPacketFormat: "json",
      limit: command.limit,
      parallel: command.parallel,
      minParallel: command.minParallel,
      adaptiveRateLimit: command.adaptiveRateLimit,
      allowSharedCwd: false,
      worker: "deepseek-direct",
      workspaceMode: SENIOR_DEFAULT_WORKSPACE_MODE,
      modelProfile: "deepseek-v4-pro:max",
      maxRuntimeMinutes: command.maxRuntimeMinutes,
      approvalToken,
      successStatus: command.patchMode === "write" ? "patch_ready" : "completed",
      maxOutputChars: command.maxOutputChars,
      approveToolContext: command.approveToolContext,
      rememberToolContext: command.rememberToolContext,
      continueOnFailure: command.continueOnFailure
    },
    call
  );

  return {
    action: "factory_run_completed",
    message: formatFactoryRunCompleted(command.queueId, run, reviewMatrix, prepared, launchPlan),
    data: {
      queueId: command.queueId,
      packetDir,
      cwdTemplate,
      commandTemplate: commandTemplateWithFlags,
      startDecision,
      modelApproval,
      reviewMatrix: reviewMatrix as unknown as Record<string, unknown>,
      prepared: prepared as unknown as Record<string, unknown>,
      launchPlan: launchPlan as unknown as Record<string, unknown>,
      run: run.data
    }
  };
}

async function seniorDoctor(
  command: Extract<ProjectCliCommand, { command: "senior-doctor" }>,
  call: ProjectToolCaller
): Promise<ProjectRunResult> {
  const checks: Array<Record<string, unknown>> = [];
  const projectPath = resolve(command.projectPath);
  const daemonControl = sharedDaemonControlPolicy(projectPath);
  checks.push(checkResult("project_path", existsSync(projectPath), projectPath, existsSync(projectPath) ? undefined : "Pass --project <path> with an existing checkout."));
  checks.push(checkResult("senior_mode", process.env[SENIOR_MODE_ENV] === "permissive", process.env[SENIOR_MODE_ENV] ?? "missing", `Set ${SENIOR_MODE_ENV}=permissive or source the Senior-mode env script.`));
  const deepseekKeyPresent = Boolean(process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_TOKEN);
  checks.push(checkResult("deepseek_auth", deepseekKeyPresent, deepseekKeyPresent ? "present" : "missing", "Export DEEPSEEK_API_KEY or DEEPSEEK_TOKEN before launching workers."));
  const git = spawnSync("git", ["-C", projectPath, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  const gitReady = git.status === 0 && git.stdout.trim() === "true";
  checks.push(checkResult("git_worktree_mutating_lanes", gitReady, git.stderr.trim() || git.stdout.trim() || String(git.status), "Mutating Senior workers require a git checkout so worktrees can be prepared."));
  checks.push(checkResult("sandbox_report_only_lanes", true, gitReady ? "sandbox available; git worktrees also available" : "sandbox available for report-only planner/reviewer lanes; mutating lanes remain blocked"));
  const binary = spawnSync("agent-fabric-project", ["--version"], { encoding: "utf8" });
  checks.push(checkResult("global_project_cli", binary.status === 0, binary.stdout.trim() || binary.stderr.trim() || String(binary.status), "Install or relink the global agent-fabric-project binary."));
  const deepseekDoctor = spawnSync("agent-fabric-deepseek-worker", ["doctor", "--json"], { encoding: "utf8" });
  checks.push(checkResult("deepseek_worker_doctor", deepseekDoctor.status === 0, (deepseekDoctor.stdout || deepseekDoctor.stderr).trim() || String(deepseekDoctor.status), "Run agent-fabric-deepseek-worker doctor and fix auth/runtime issues."));

  let daemonStatus: Record<string, unknown> | undefined;
  try {
    daemonStatus = await call<Record<string, unknown>>("fabric_status", { includeSessions: false });
    checks.push(checkResult("daemon", true, "reachable"));
    const daemon = objectFrom(daemonStatus.daemon);
    const runtime = objectFrom(daemon.runtime);
    const tools = objectFrom(daemon.tools);
    const missingSeniorTools = stringArray(tools.missingSeniorRequired);
    const seniorToolsReported = Array.isArray(tools.seniorRequired);
    checks.push(
      checkResult(
        "daemon_senior_tools",
        seniorToolsReported && missingSeniorTools.length === 0,
        !seniorToolsReported
          ? "running daemon does not report Senior tool parity; it is likely stale"
          : missingSeniorTools.length === 0 ? "all required Senior bridge tools are exposed" : `missing: ${missingSeniorTools.join(", ")}`,
        SHARED_DAEMON_GUARDRAIL,
        daemonControlCheckMetadata()
      )
    );
    const localRoot = localPackageRoot();
    const daemonPackageRoot = stringFrom(runtime.packageRoot);
    const daemonCwd = stringFrom(runtime.cwd);
    const daemonRuntimeReported = Boolean(daemonPackageRoot || daemonCwd || stringFrom(runtime.entrypoint));
    const sourceMatches =
      !localRoot ||
      (daemonPackageRoot ? sameOrUnder(daemonPackageRoot, localRoot) : daemonCwd ? sameOrUnder(daemonCwd, localRoot) : true);
    checks.push(
      checkResult(
        "daemon_source",
        daemonRuntimeReported && sourceMatches,
        `daemon cwd=${daemonCwd ?? "unknown"} entrypoint=${stringFrom(runtime.entrypoint) ?? "unknown"} packageRoot=${daemonPackageRoot ?? "unknown"} cliRoot=${localRoot ?? "unknown"}`,
        SHARED_DAEMON_GUARDRAIL,
        daemonControlCheckMetadata()
      )
    );
  } catch (error) {
    checks.push(
      checkResult(
        "daemon",
        false,
        error instanceof Error ? error.message : String(error),
        `Agent Fabric daemon is unreachable. ${SHARED_DAEMON_GUARDRAIL}`,
        daemonControlCheckMetadata()
      )
    );
  }

  let queueStatus: Record<string, unknown> | undefined;
  if (command.queueId) {
    try {
      queueStatus = await call<Record<string, unknown>>("project_queue_status", { queueId: command.queueId });
      checks.push(checkResult("queue", true, command.queueId));
    } catch (error) {
      checks.push(checkResult("queue", false, command.queueId, error instanceof Error ? error.message : String(error)));
    }
  }

  const failed = checks.filter((check) => check.ok === false);
  return {
    action: "senior_doctor",
    message: formatSeniorDoctor(projectPath, failed.length === 0, checks),
    data: {
      schema: "agent-fabric.senior-doctor.v1",
      projectPath,
      ok: failed.length === 0,
      daemonControl,
      checks,
      daemonStatus,
      queueStatus
    }
  };
}

async function seniorRun(
  command: Extract<ProjectCliCommand, { command: "senior-run" }>,
  call: ProjectToolCaller
): Promise<ProjectRunResult> {
  const projectPath = resolve(command.projectPath ?? process.cwd());
  const count = Math.min(Math.max(command.count, 1), seniorMaxLaneCount());
  const progressFile = command.progressFile ?? join(projectPath, ".agent-fabric", "progress.md");
  const taskPacketDir = join(projectPath, ".agent-fabric", "task-packets");
  const cwdTemplate = join(projectPath, ".agent-fabric", "worktrees", "{{queueTaskId}}");
  const tasksFile = command.tasksFile ?? (command.planFile ? join(projectPath, ".agent-fabric", "tasks", `${safePathPart(basename(command.planFile))}.tasks.json`) : undefined);

  if (command.dryRun) {
    const previewTasks = command.tasksFile ? parseTasksFile(command.tasksFile).tasks : command.planFile ? scaffoldSeniorTasks(command.planFile, count) : [];
    const progress = command.queueId ? await call<Record<string, unknown>>("project_queue_progress_report", { queueId: command.queueId }) : undefined;
    const git = spawnSync("git", ["-C", projectPath, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
    const mutatingWorktreeReady = git.status === 0 && git.stdout.trim() === "true";
    return {
      action: "senior_run_preview",
      message: [
        "Senior-run preview.",
        `Project: ${projectPath}`,
        `Queue: ${command.queueId ?? "will create"}`,
        `Worker: ${command.worker}; requested lanes=${count}; workspaceMode=git_worktree`,
        `Mutating git-worktree lanes: ${mutatingWorktreeReady ? "ready" : "blocked - project is not a git checkout"}`,
        `Report-only planner/reviewer lanes: ${mutatingWorktreeReady ? "git_worktree or sandbox" : "sandbox only"}`,
        `Task source: ${command.tasksFile ? command.tasksFile : command.planFile ? `${command.planFile} (local scaffold)` : "existing queue"}`,
        `Task preview count: ${previewTasks.length}`,
        `Task packets: ${taskPacketDir}`,
        `Worktrees: ${cwdTemplate}`,
        `Progress: ${progressFile}`
      ].join("\n"),
      data: {
        schema: "agent-fabric.senior-run-preview.v1",
        projectPath,
        queueId: command.queueId,
        requested: count,
        worker: command.worker,
        workspaceMode: "git_worktree",
        mutatingWorktreeReady,
        reportOnlyWorkspaceMode: mutatingWorktreeReady ? "git_worktree_or_sandbox" : "sandbox",
        tasks: previewTasks,
        taskPacketDir,
        cwdTemplate,
        progressFile,
        progress
      }
    };
  }

  let queueId = command.queueId;
  let created: Record<string, unknown> | undefined;
  if (!queueId) {
    const promptSummary = command.planFile ? summarizeText(readFile(command.planFile)) : "Senior-mode Agent Fabric worker run.";
    created = await call<Record<string, unknown>>("project_queue_create", {
      projectPath,
      promptSummary,
      title: `Senior run - ${basename(projectPath)}`,
      pipelineProfile: "fast",
      maxParallelAgents: count
    });
    queueId = String(created.queueId);
  }

  if (!queueId) throw new FabricError("SENIOR_QUEUE_MISSING", "senior-run could not resolve or create a queue", false);

  let imported: Record<string, unknown> | undefined;
  if (command.tasksFile || command.planFile) {
    const tasks = command.tasksFile ? parseTasksFile(command.tasksFile).tasks : scaffoldSeniorTasks(command.planFile as string, count);
    if (tasksFile && !command.tasksFile) writeTasksFile(tasksFile, tasks);
    await call("project_queue_record_stage", {
      queueId,
      stage: "task_writing",
      status: "completed",
      modelAlias: "senior.local_scaffold",
      outputSummary: `Imported ${tasks.length} Senior task(s) without model-generated expansion.`
    });
    imported = await call<Record<string, unknown>>("project_queue_add_tasks", { queueId, tasks });
    await call("project_queue_record_stage", {
      queueId,
      stage: "queue_shaping",
      status: "completed",
      modelAlias: "senior.local_scaffold",
      outputSummary: "Senior-run queue scaffold is ready for execution.",
      artifacts: [{ kind: "tasks_file", path: command.tasksFile ?? tasksFile }]
    });
    await call("project_queue_decide", {
      queueId,
      decision: "approve_queue",
      note: "Approved by senior-run local scaffold/import."
    });
  }

  const run =
    command.worker === "jcode-deepseek"
      ? await seniorRunJcode(queueId, count, taskPacketDir, cwdTemplate, command.approveModelCalls, command.json, call)
      : await factoryRun(
          {
            command: "factory-run",
            json: command.json,
            queueId,
            limit: count,
            parallel: count,
            minParallel: 1,
            adaptiveRateLimit: true,
            taskPacketDir,
            cwdTemplate,
            deepSeekWorkerCommand: "agent-fabric-deepseek-worker",
            deepSeekRole: "auto",
            sensitiveContextMode: "off",
            patchMode: "write",
            approvalToken: undefined,
            maxOutputChars: 8_000,
            approveToolContext: true,
            rememberToolContext: false,
            continueOnFailure: true,
            startExecution: true,
            dryRun: false,
            allowSensitiveContext: true,
            approveModelCalls: command.approveModelCalls,
            allowConcurrentRunner: false
          },
          call
        );
  const progress = await call<Record<string, unknown>>("project_queue_progress_report", { queueId, maxEventsPerLane: defaultMaxEventsPerLane() });
  writeProgressMarkdown(progressFile, progress);

  return {
    action: "senior_run_completed",
    message: formatSeniorRun(queueId, count, run, progressFile, progress),
    data: {
      schema: "agent-fabric.senior-run.v1",
      queueId,
      created,
      imported,
      run: run.data,
      progress,
      progressFile,
      requested: count,
      worker: command.worker,
      workspaceMode: "git_worktree"
    }
  };
}

async function writeProgressReport(
  command: Extract<ProjectCliCommand, { command: "progress-report" }>,
  call: ProjectToolCaller
): Promise<ProjectRunResult> {
  const report = await call<Record<string, unknown>>("project_queue_progress_report", {
    queueId: command.queueId,
    maxEventsPerLane: command.maxEventsPerLane,
    managerSummaryLimit: command.managerSummaryLimit
  });
  if (command.progressFile) writeProgressMarkdown(command.progressFile, report);
  return {
    action: "progress_report",
    message: formatProgressReport(report, command.progressFile),
    data: report
  };
}

async function seniorRunJcode(
  queueId: string,
  count: number,
  taskPacketDir: string,
  cwdTemplate: string,
  approveModelCalls: boolean,
  json: boolean,
  call: ProjectToolCaller
): Promise<ProjectRunResult> {
  const status = await call<QueueStatus>("project_queue_status", { queueId });
  let startDecision: Record<string, unknown> | undefined;
  if (status.queue.status !== "running") {
    startDecision = await call<Record<string, unknown>>("project_queue_decide", {
      queueId,
      decision: "start_execution",
      note: "Started by project CLI senior-run jcode lane."
    });
  }
  let modelApproval: Record<string, unknown> | undefined;
  let approvalToken: string | undefined;
  if (approveModelCalls) {
    modelApproval = await call<Record<string, unknown>>("project_queue_approve_model_calls", {
      queueId,
      candidateModel: "deepseek-v4-pro",
      requestedProvider: "deepseek",
      requestedReasoning: "max",
      note: "Approved by project CLI senior-run --approve-model-calls."
    });
    approvalToken = typeof modelApproval.approvalToken === "string" ? modelApproval.approvalToken : undefined;
  }
  const run = await runReady(
    {
      command: "run-ready",
      json,
      queueId,
      taskPacketDir,
      taskPacketFormat: "markdown",
      cwdTemplate,
      cwdPrep: "auto",
      limit: count,
      parallel: count,
      minParallel: 1,
      adaptiveRateLimit: true,
      allowSharedCwd: false,
      worker: "jcode-deepseek",
      workspaceMode: SENIOR_DEFAULT_WORKSPACE_MODE,
      modelProfile: SENIOR_DEFAULT_MODEL_PROFILE,
      approvalToken,
      successStatus: "patch_ready",
      maxOutputChars: 8_000,
      approveToolContext: true,
      rememberToolContext: false,
      continueOnFailure: true
    },
    call
  );
  return {
    action: "senior_jcode_run_completed",
    message: run.message,
    data: {
      queueId,
      startDecision,
      modelApproval,
      run: run.data,
      taskPacketDir,
      cwdTemplate
    }
  };
}

async function importTasks(
  command: Extract<ProjectCliCommand, { command: "import-tasks" }>,
  call: ProjectToolCaller
): Promise<ProjectRunResult> {
  const payload = parseTasksFile(command.tasksFile);
  await call("project_queue_record_stage", {
    queueId: command.queueId,
    stage: "task_writing",
    status: "completed",
    modelAlias: "task.writer",
    outputSummary: `Imported ${payload.tasks.length} task(s) from ${command.tasksFile}.`
  });
  const added = await call<Record<string, unknown>>("project_queue_add_tasks", {
    queueId: command.queueId,
    tasks: payload.tasks
  });
  await call("project_queue_record_stage", {
    queueId: command.queueId,
    stage: "queue_shaping",
    status: "completed",
    modelAlias: "task.writer",
    outputSummary: "Tasks are dependency-aware and ready for review."
  });
  if (command.approveQueue) {
    await call("project_queue_decide", {
      queueId: command.queueId,
      decision: "approve_queue",
      note: "Approved by project CLI import."
    });
  }
  const created = Array.isArray(added.created) ? added.created.length : payload.tasks.length;
  return {
    action: "tasks_imported",
    message: `Imported ${created} task(s) into queue ${command.queueId}.`,
    data: added
  };
}

async function launchReadyWorkers(
  command: Extract<ProjectCliCommand, { command: "launch" }>,
  call: ProjectToolCaller
): Promise<ProjectRunResult> {
  const next = await call<NextReadyResult>("project_queue_next_ready", { queueId: command.queueId, limit: command.limit });
  const started: Record<string, unknown>[] = [];
  const skipped: Record<string, unknown>[] = [];
  const skipQueueTaskIds: string[] = [];
  const limit = command.limit ?? next.ready.length;

  for (let index = 0; index < limit; index += 1) {
    const claimed = await call<ClaimNextResult>("project_queue_claim_next", {
      queueId: command.queueId,
      worker: command.worker,
      workspaceMode: command.workspaceMode,
      workspacePath: command.workspacePath,
      modelProfile: command.modelProfile,
      maxRuntimeMinutes: command.maxRuntimeMinutes,
      command: [],
      skipQueueTaskIds,
      metadata: { source: "project-cli-launch" }
    });
    if (claimed.approvalRequired && claimed.toolContextProposal) {
      const proposal = claimed.toolContextProposal;
      const queueTaskId = proposal.queueTaskId ?? "unknown";
      skipped.push({
        queueTaskId,
        reason: "tool/context approval required",
        proposalId: proposal.proposalId,
        missingGrants: proposal.missingGrants ?? []
      });
      if (proposal.queueTaskId) {
        skipQueueTaskIds.push(proposal.queueTaskId);
        continue;
      }
      break;
    }
    if (claimed.executionBlocked) {
      skipped.push({ queueTaskId: "queue", reason: claimed.blockedReason ?? "queue is not runnable", executionBlocked: true });
      break;
    }
    if (!claimed.claimed) break;
    if (!claimed.workerRun?.workerRunId || !claimed.claimed.fabricTaskId) {
      skipped.push({ queueTaskId: claimed.claimed.queueTaskId, title: claimed.claimed.title, reason: "missing worker run or fabricTaskId" });
      continue;
    }
    await call("fabric_task_event", {
      taskId: claimed.claimed.fabricTaskId,
      workerRunId: claimed.workerRun.workerRunId,
      kind: "started",
      body: "Worker run registered by project CLI launcher.",
      metadata: { queueId: command.queueId, queueTaskId: claimed.claimed.queueTaskId, toolContextProposalId: claimed.toolContextProposal?.proposalId }
    });
    started.push({
      queueTaskId: claimed.claimed.queueTaskId,
      fabricTaskId: claimed.claimed.fabricTaskId,
      workerRunId: claimed.workerRun.workerRunId,
      title: claimed.claimed.title
    });
  }

  return {
    action: "workers_launched",
    message: formatLaunchResult(command.queueId, started, skipped, next),
    data: { queueId: command.queueId, started, skipped, activeWorkers: next.activeWorkers, availableSlots: next.availableSlots }
  };
}

async function decideToolProposal(
  command: Extract<ProjectCliCommand, { command: "approve-tool" | "decide-tool" }>,
  call: ProjectToolCaller
): Promise<ProjectRunResult> {
  const decision = command.command === "approve-tool" ? "approve" : command.decision;
  const result = await call<Record<string, unknown>>("tool_context_decide", {
    proposalId: command.proposalId,
    decision,
    remember: command.remember,
    note: command.note
  });
  return {
    action: `tool_context_${decision}`,
    message: `Recorded ${decision} for tool/context proposal ${command.proposalId}${command.remember ? " and remembered grants" : ""}.`,
    data: result
  };
}

async function setToolPolicy(
  command: Extract<ProjectCliCommand, { command: "set-tool-policy" }>,
  call: ProjectToolCaller
): Promise<ProjectRunResult> {
  const result = await call<Record<string, unknown>>("tool_context_policy_set", {
    projectPath: command.projectPath,
    grantKind: command.grantKind,
    value: command.value,
    status: command.status
  });
  return {
    action: "tool_context_policy_set",
    message: `Set ${command.grantKind}:${command.value} to ${command.status} for ${command.projectPath}.`,
    data: result
  };
}

async function mergeWorkerDryRun(
  command: Extract<ProjectCliCommand, { command: "merge-worker" }>,
  call: ProjectToolCaller
): Promise<ProjectRunResult> {
  const status = await call<QueueStatus>("project_queue_status", { queueId: command.queueId });
  let task: QueueTask | undefined;
  if (command.queueTaskId) {
    task = status.tasks.find((entry) => entry.queueTaskId === command.queueTaskId);
  } else if (command.workerRunId) {
    task = status.tasks.find((entry) => entry.assignedWorkerRunId === command.workerRunId);
  } else if (command.taskId) {
    task = status.tasks.find((entry) => entry.fabricTaskId === command.taskId);
  }
  if (!task) {
    throw new FabricError("PROJECT_QUEUE_TASK_NOT_FOUND", "No queue task matched the merge-worker dry-run reference", false);
  }
  if (!task.fabricTaskId) {
    throw new FabricError("FABRIC_TASK_NOT_FOUND", `Queue task has no linked fabric task: ${task.queueTaskId}`, false);
  }
  if (!["patch_ready", "review", "accepted"].includes(task.status)) {
    throw new FabricError("PATCH_NOT_APPLYABLE", `Task ${task.queueTaskId} is not patch-ready`, false);
  }

  const fabricStatus = await call<FabricTaskStatusResult>("fabric_task_status", {
    taskId: task.fabricTaskId,
    includeEvents: true,
    includeCheckpoints: true
  });
  const candidate = resolveReviewedPatchCandidate(task, fabricStatus);
  const cwd = command.applyCwd ?? candidate.workspacePath ?? fabricStatus.projectPath ?? status.queue.projectPath;
  const patchFile = resolveReviewPatchFile(candidate.patchFile, cwd);
  if (!existsSync(patchFile)) {
    throw new FabricError("PATCH_ARTIFACT_MISSING", `PATCH_ARTIFACT_MISSING: Patch artifact not found: ${patchFile}`, false);
  }
  const patch = readFileSync(patchFile, "utf8");
  validateGitStylePatch(patch, cwd);

  let conflictCheck: Record<string, unknown> | undefined;
  let conflictMessage: string | undefined;
  try {
    conflictCheck = await checkPatchWithSystemPatch(patch, cwd);
  } catch (error) {
    conflictMessage = error instanceof Error ? error.message : String(error);
  }
  const diffStats = computePatchDiffStats(patch);
  const clean = conflictMessage === undefined;
  const nextCommand = clean
    ? `agent-fabric-project review-patches --queue ${command.queueId} --accept-task ${task.queueTaskId} --apply-patch --apply-cwd ${cwd}`
    : `Review conflicts for ${patchFile}`;

  return {
    action: clean ? "merge_worker_clean" : "merge_worker_conflicts_detected",
    message: [
      `merge-worker --dry-run for ${task.queueTaskId}`,
      `Patch: ${patchFile}`,
      `CWD: ${cwd}`,
      `Diff stats: ${diffStats.filesChanged} files, +${diffStats.insertions} -${diffStats.deletions}`,
      clean ? "Clean: no conflicts detected." : `Conflicts detected: ${conflictMessage}`,
      `Next: ${nextCommand}`
    ].join("\n"),
    data: {
      queueId: command.queueId,
      queueTaskId: task.queueTaskId,
      fabricTaskId: task.fabricTaskId,
      workerRunId: candidate.workerRunId,
      cwd,
      patchFile,
      clean,
      conflictsDetected: !clean,
      conflictMessage,
      conflictCheck,
      diffStats,
      nextCommands: [nextCommand]
    }
  };
}

async function mergeWorker(
  command: Extract<ProjectCliCommand, { command: "merge-worker" }>,
  call: ProjectToolCaller
): Promise<ProjectRunResult> {
  const status = await call<QueueStatus>("project_queue_status", { queueId: command.queueId });
  const agentId = command.agent!;

  let task: QueueTask | undefined;
  if (agentId.startsWith("@af/")) {
    try {
      const agent = await call<Record<string, unknown>>("fabric_open_agent", {
        queueId: command.queueId,
        agent: agentId,
        maxEventsPerRun: 5
      });
      const detail = objectFrom(agent.detail);
      const resolvedTask = objectFrom(detail.task);
      const queueTaskId = stringFrom(resolvedTask.queueTaskId);
      if (queueTaskId) {
        task = status.tasks.find((entry) => entry.queueTaskId === queueTaskId);
      }
    } catch {
      // Fall back to direct task lookup
    }
  }
  if (!task) {
    task = status.tasks.find((entry) => entry.queueTaskId === agentId);
  }
  if (!task) {
    task = status.tasks.find((entry) =>
      entry.title === agentId || entry.summary === agentId || (entry.assignedWorkerRunId === agentId)
    );
  }
  if (!task) {
    throw new FabricError("MERGE_WORKER_NO_TASK", `Agent ${agentId} has no associated queue task`, false);
  }
  const queueTaskId = task.queueTaskId;
  if (!task.fabricTaskId) {
    throw new FabricError("FABRIC_TASK_NOT_FOUND", `Queue task has no linked fabric task: ${queueTaskId}`, false);
  }
  const fabricStatus = await call<FabricTaskStatusResult>("fabric_task_status", {
    taskId: task.fabricTaskId,
    includeEvents: true,
    includeCheckpoints: true
  });
  const candidate = resolveReviewedPatchCandidate(task, fabricStatus, { requireWorkerRun: false });
  const cwd = command.cwd ?? candidate.workspacePath ?? fabricStatus.projectPath ?? status.queue.projectPath;
  if (!cwd) {
    throw new FabricError("MERGE_WORKER_NO_CWD", `No workspace or --cwd available for agent ${agentId}`, false);
  }
  if (!existsSync(cwd)) {
    throw new FabricError("MERGE_WORKER_CWD_MISSING", `Workspace cwd does not exist: ${cwd}`, false);
  }

  const patchPath = resolveReviewPatchFile(candidate.patchFile, cwd);
  if (!existsSync(patchPath)) {
    throw new FabricError("PATCH_ARTIFACT_MISSING", `PATCH_ARTIFACT_MISSING: Patch artifact not found: ${patchPath}`, false);
  }
  const patch = readFileSync(patchPath, "utf8");
  validateGitStylePatch(patch, cwd);

  let dryRun: Record<string, unknown> | undefined;
  let conflictMessage: string | undefined;
  try {
    dryRun = await checkPatchWithSystemPatch(patch, cwd);
  } catch (error) {
    conflictMessage = error instanceof Error ? error.message : String(error);
  }

  let testResults: Record<string, unknown> | undefined;
  const testRefs = stringArray(task.testRefs).filter((ref): ref is string => typeof ref === "string");
  if (command.runTests && testRefs.length > 0) {
    const testOutputs: Array<{ command: string; exitCode: number; stdout: string; stderr: string }> = [];
    for (const testCmd of testRefs) {
      try {
        const result = await runShellCommand(testCmd, cwd, 8_000, undefined, {}, {});
        testOutputs.push({
          command: testCmd,
          exitCode: result.exitCode ?? -1,
          stdout: tailText(result.stdout ?? "", 4_000),
          stderr: tailText(result.stderr ?? "", 4_000)
        });
      } catch (error) {
        testOutputs.push({
          command: testCmd,
          exitCode: -1,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error)
        });
      }
    }
    testResults = { outputs: testOutputs, allPassed: testOutputs.every((entry) => entry.exitCode === 0) };
  }

  if (command.apply) {
    const reviewedBy = command.reviewedBy as string;
    const reviewSummary = command.reviewSummary as string;

    if (conflictMessage) {
      throw new FabricError("MERGE_WORKER_CONFLICTS", conflictMessage, false);
    }

    if (testResults && !testResults.allPassed) {
      return {
        action: "merge_worker_test_failed",
        message: `Test failures prevent merge-worker apply for ${agentId}. Fix tests before applying.`,
        data: {
          queueId: command.queueId,
          agent: agentId,
          queueTaskId,
          cwd,
          patchFile: patchPath,
          dryRun: dryRun ?? {},
          testResults,
          applyBlocked: true,
          blockReason: "test_failures"
        }
      };
    }

    const patchApply = await applyPatchWithSystemPatch(patch, cwd);

    let acceptResult: Record<string, unknown> = {};
    try {
      acceptResult = await call<Record<string, unknown>>("fabric_accept_patch", {
        queueId: command.queueId,
        agent: agentId,
        reviewedBy,
        reviewSummary
      });
    } catch {
      await call("project_queue_update_task", {
        queueId: command.queueId,
        queueTaskId,
        status: "accepted",
        summary: `Accepted patch from ${agentId}. Reviewed by ${reviewedBy}: ${reviewSummary}`,
        patchRefs: uniqueStrings([...stringArray(task.patchRefs), candidate.patchFile]),
        testRefs: stringArray(task.testRefs).filter((ref): ref is string => typeof ref === "string")
      });
      acceptResult = { accepted: true, queueTaskId };
    }

    return {
      action: "merge_worker_applied",
      message: `Applied and accepted merge-worker patch for ${agentId}. Reviewed by ${reviewedBy}: ${reviewSummary}.${testResults ? ` Tests: ${testResults.allPassed ? "passed" : "failed"}.` : ""}`,
      data: {
        queueId: command.queueId,
        agent: agentId,
        queueTaskId,
        cwd,
        patchFile: patchPath,
        dryRun: dryRun ?? {},
        patchApply,
        testResults,
        acceptance: acceptResult
      }
    };
  }

  if (conflictMessage) {
    return {
      action: "merge_worker_conflicts_detected",
      message: `Merge-worker dry-run for ${agentId}: CONFLICTS DETECTED: ${conflictMessage}`,
      data: {
        queueId: command.queueId,
        agent: agentId,
        queueTaskId,
        cwd,
        patchFile: patchPath,
        dryRun: dryRun ?? {},
        clean: false,
        conflictsDetected: true,
        conflictMessage,
        testResults,
        readyToApply: false
      }
    };
  }

  return {
    action: "merge_worker_dry_run",
    message: `Merge-worker dry-run for ${agentId}: patch ${patchPath} checked cleanly.${testResults ? ` Tests: ${testResults.allPassed ? "passed" : "failed"}.` : ""}`,
    data: {
      queueId: command.queueId,
      agent: agentId,
      queueTaskId,
      cwd,
      patchFile: patchPath,
      dryRun: dryRun ?? {},
      clean: true,
      conflictsDetected: false,
      testResults,
      readyToApply: !testResults || testResults.allPassed
    }
  };
}

function parseTasksFile(path: string): { tasks: unknown[] } {
  const parsed = JSON.parse(readFile(path)) as unknown;
  if (Array.isArray(parsed)) return { tasks: parsed };
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { tasks?: unknown }).tasks)) {
    return { tasks: (parsed as { tasks: unknown[] }).tasks };
  }
  throw new FabricError("INVALID_INPUT", "tasks file must be a JSON array or an object with a tasks array", false);
}

function parseTaskMetadataFile(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFile(path)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FabricError("INVALID_INPUT", "metadata file must be a JSON object", false);
  }
  return parsed as Record<string, unknown>;
}

function formatStatus(status: QueueStatus): string {
  const counts = status.tasks.reduce<Record<string, number>>((acc, task) => {
    acc[task.status] = (acc[task.status] ?? 0) + 1;
    return acc;
  }, {});
  const policies = status.toolContextPolicies ?? [];
  const approvedPolicies = policies.filter((policy) => policy.status === "approved").length;
  const rejectedPolicies = policies.filter((policy) => policy.status === "rejected").length;
  const lines = [
    `Queue ${status.queue.queueId}`,
    `Project: ${status.queue.projectPath}`,
    `Status: ${status.queue.status}`,
    `Max parallel agents: ${status.queue.maxParallelAgents}`,
    `Tool/context proposals: ${status.toolContextProposals?.length ?? 0}; policies: approved=${approvedPolicies}, rejected=${rejectedPolicies}`,
    `Tasks: ${Object.entries(counts)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ")}`
  ];
  for (const task of status.tasks) {
    lines.push(`  ${task.queueTaskId} ${task.status} ${task.title}`);
  }
  return lines.join("\n");
}

function formatQueueList(result: QueueListResult): string {
  const lines = [`Project queues: ${result.count}`];
  if (result.queues.length === 0) {
    lines.push("No queues.");
    return lines.join("\n");
  }
  for (const queue of result.queues) {
    const counts = queue.counts
      ? Object.entries(queue.counts)
          .map(([key, value]) => `${key}=${value}`)
          .join(",")
      : "";
    lines.push(
      `  ${queue.queueId} ${queue.status} ready=${queue.readyCount ?? 0} blocked=${queue.blockedCount ?? 0} active=${queue.activeWorkers ?? 0} approvals=${
        queue.pendingApprovals ?? 0
      } ${queue.title} (${queue.projectPath})${counts ? ` [${counts}]` : ""}`
    );
  }
  return lines.join("\n");
}

function formatApprovalInbox(result: PendingApprovalInbox): string {
  const lines = [`Pending tool/context approvals: ${result.count}`];
  if (result.pending.length === 0) {
    lines.push("No pending approvals.");
    return lines.join("\n");
  }
  for (const item of result.pending) {
    lines.push(`  ${item.proposalId} queue=${item.queueId} task=${item.queueTaskId ?? ""} ${item.queueTaskTitle ?? item.queueTitle ?? ""}`);
    const missing = Array.isArray(item.missingGrants) ? item.missingGrants : [];
    if (missing.length > 0) lines.push(`    missing: ${missing.map((grant) => grantSummary(grant)).join(", ")}`);
    const warnings = Array.isArray(item.safetyWarnings) ? item.safetyWarnings : [];
    if (warnings.length > 0) lines.push(`    warnings: ${warnings.join(", ")}`);
  }
  return lines.join("\n");
}

function formatMemoryInbox(result: { memories?: Record<string, unknown>[]; total?: number }): string {
  const memories = result.memories ?? [];
  const lines = [`Pending memory review: ${result.total ?? memories.length}`];
  if (memories.length === 0) {
    lines.push("No pending memories.");
    return lines.join("\n");
  }
  for (const memory of memories) {
    const confidence = typeof memory.confidence === "number" ? memory.confidence.toFixed(2) : String(memory.confidence ?? "?");
    lines.push(`  ${memory.id ?? ""} ${memory.type ?? "memory"} ${memory.status ?? ""} confidence=${confidence}`);
    lines.push(`    ${memory.body ?? ""}`);
  }
  return lines.join("\n");
}

function formatMemoryReview(result: Record<string, unknown>): string {
  return `Memory ${result.id ?? ""} ${result.decision ?? "reviewed"}: ${result.previousStatus ?? "unknown"} -> ${result.status ?? "unknown"}`;
}

function formatQueueApprovalInbox(queueId: string, result: QueueApprovalInbox): string {
  const lines = [
    `Queue ${queueId} approvals: ${result.count}`,
    `Tool/context: ${result.toolContextCount}; model calls: ${result.modelCallCount}`
  ];
  if (result.count === 0) {
    lines.push("No pending queue approvals.");
    return lines.join("\n");
  }
  for (const item of result.toolContext) {
    lines.push(`  tool ${item.proposalId ?? ""} task=${item.queueTaskId ?? ""} ${item.queueTaskTitle ?? ""}`);
    const missing = Array.isArray(item.missingGrants) ? item.missingGrants : [];
    if (missing.length > 0) lines.push(`    missing: ${missing.map((grant) => grantSummary(grant)).join(", ")}`);
    const warnings = Array.isArray(item.safetyWarnings) ? item.safetyWarnings : [];
    if (warnings.length > 0) lines.push(`    warnings: ${warnings.join(", ")}`);
  }
  for (const item of result.modelCalls) {
    const selected = item.selected ? `${item.selected.provider ?? ""}/${item.selected.model ?? ""}/${item.selected.reasoning ?? ""}` : "unknown";
    const cost = typeof item.estimate?.estimatedCostUsd === "number" ? ` $${item.estimate.estimatedCostUsd.toFixed(4)}` : "";
    lines.push(`  model ${item.requestId ?? item.approvalRequestId ?? ""} ${item.risk ?? "risk"} ${selected}${cost}`);
    const warnings = Array.isArray(item.warnings) ? item.warnings : [];
    if (warnings.length > 0) lines.push(`    warnings: ${warnings.join(", ")}`);
  }
  return lines.join("\n");
}

function formatAgentLanes(queueId: string, result: AgentLanesResult): string {
  const lines = [`Queue ${queueId} agent lanes: ${result.count}`];
  if (result.lanes.length === 0) {
    lines.push("No active lanes.");
    return lines.join("\n");
  }
  for (const lane of result.lanes) {
    const task = lane.queueTask;
    const worker = lane.workerRun;
    const progress = lane.progress;
    const title = task?.title ?? task?.queueTaskId ?? lane.laneId;
    lines.push(
      `  ${lane.laneId} ${worker?.worker ?? "worker"} ${progress?.label ?? worker?.status ?? task?.status ?? "unknown"} ${title}`
    );
    if (progress?.summary) lines.push(`    summary: ${progress.summary}`);
    if (lane.latestEvent?.kind) lines.push(`    latest: ${lane.latestEvent.kind}${lane.latestEvent.body ? ` - ${lane.latestEvent.body}` : ""}`);
    if (progress?.nextAction) lines.push(`    next: ${progress.nextAction}`);
    if (progress?.lastActivityAt) lines.push(`    updated: ${progress.lastActivityAt}`);
  }
  return lines.join("\n");
}

function formatCodexAgents(result: Record<string, unknown>): string {
  const queueId = String(result.queueId ?? "");
  const cards = Array.isArray(result.cards) ? (result.cards as Record<string, unknown>[]) : [];
  const status = String(result.status ?? "listed");
  const lines = [`Agent Fabric background agents${queueId ? ` for ${queueId}` : ""}: ${cards.length}${status ? ` (${status})` : ""}`];
  if (typeof result.requested === "number") {
    lines.push(`Requested=${result.requested} started=${String(result.started ?? cards.length)} queued=${String(result.queued ?? 0)}`);
  }
  if (cards.length === 0) {
    const reason = result.blockedReason ? ` ${String(result.blockedReason)}` : "";
    lines.push(`No Agent Fabric workers visible.${reason}`);
    return lines.join("\n");
  }
  for (const card of cards) {
    const task = card.task && typeof card.task === "object" && !Array.isArray(card.task) ? (card.task as Record<string, unknown>) : {};
    const workspace = card.workspace && typeof card.workspace === "object" && !Array.isArray(card.workspace) ? (card.workspace as Record<string, unknown>) : {};
    lines.push(`  ${String(card.handle ?? card.agentId)} ${String(card.workerKind ?? "worker")} ${String(card.status ?? card.rawStatus ?? "")} ${String(task.title ?? task.queueTaskId ?? "")}`);
    if (card.currentStep) lines.push(`    step: ${String(card.currentStep)}`);
    if (workspace.path) lines.push(`    workspace: ${String(workspace.mode ?? "")} ${String(workspace.path)}`.trimEnd());
  }
  return lines.join("\n");
}

function formatCodexAgentDetail(result: Record<string, unknown>): string {
  const card = result.card && typeof result.card === "object" && !Array.isArray(result.card) ? (result.card as Record<string, unknown>) : {};
  const detail = result.detail && typeof result.detail === "object" && !Array.isArray(result.detail) ? (result.detail as Record<string, unknown>) : {};
  const task = detail.task && typeof detail.task === "object" && !Array.isArray(detail.task) ? (detail.task as Record<string, unknown>) : {};
  const transcript = result.transcript && typeof result.transcript === "object" && !Array.isArray(result.transcript) ? (result.transcript as Record<string, unknown>) : {};
  const events = Array.isArray(transcript.recentEvents) ? transcript.recentEvents : [];
  return [
    `Agent ${String(card.handle ?? card.agentId ?? "")} ${String(card.status ?? "")}`,
    `Task: ${String(task.title ?? task.queueTaskId ?? "")}`,
    card.currentStep ? `Current step: ${String(card.currentStep)}` : undefined,
    `Recent events: ${events.length}`
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function formatDashboard(result: DashboardResult): string {
  const board = result.queueBoard ?? {};
  const lines = [
    `Queue ${result.queue.queueId} dashboard`,
    `Project: ${result.queue.projectPath}`,
    `Status: ${result.queue.status}`,
    `Workers: active=${result.activeWorkers ?? 0}, slots=${result.availableSlots ?? 0}, lanes=${result.agentLaneCount ?? 0}`,
    `Board: ready=${board.ready?.length ?? 0}, running=${board.running?.length ?? 0}, review=${board.review?.length ?? 0}, blocked=${
      board.blocked?.length ?? 0
    }, done=${board.done?.length ?? 0}, failed=${board.failed?.length ?? 0}`,
    `Approvals: ${result.pendingApprovals?.length ?? 0}`
  ];
  if (result.summaryStrip) {
    const summary = result.summaryStrip;
    const cost = summary.cost?.estimatedCostUsd;
    lines.push(
      `Health: ${summary.status ?? "unknown"} ${summary.severity ?? "unknown"}; risk=${summary.risk?.highestOpenRisk ?? "none"}; preflights=${
        summary.cost?.preflightCount ?? 0
      }${typeof cost === "number" ? `; estimated=$${cost.toFixed(6)}` : ""}`
    );
    if (summary.nextAction) lines.push(`Next: ${summary.nextAction}`);
  }
  if (result.pipeline?.length) {
    lines.push(`Pipeline: ${result.pipeline.map((stage) => `${stage.stage ?? "stage"}=${stage.status ?? "unknown"}`).join(", ")}`);
  }
  for (const task of board.ready ?? []) {
    lines.push(`  ready ${task.queueTaskId} ${task.title}`);
  }
  for (const lane of result.agentLanes ?? []) {
    lines.push(`  lane ${lane.laneId} ${lane.progress?.label ?? lane.workerRun?.status ?? "unknown"} ${lane.queueTask?.title ?? ""}`);
  }
  return lines.join("\n");
}

function formatReviewMatrix(result: ReviewMatrixResult): string {
  const summary = result.summary ?? {};
  const parallelism = result.parallelism ?? {};
  const scheduled = parallelism.scheduledPreview ?? {};
  const lines = [
    `Queue ${result.queue.queueId} review matrix`,
    `Project: ${result.queue.projectPath}`,
    `Status: ${result.queue.status}`,
    `Tasks: total=${summary.totalTasks ?? 0}, open=${summary.openTasks ?? 0}, roots=${summary.rootTasks ?? 0}, leaves=${summary.leafTasks ?? 0}, edges=${
      summary.dependencyEdges ?? result.dependencies?.edgeCount ?? 0
    }`,
    `Readiness: dependency-free=${summary.readyDependencyFree ?? 0}, dependency-blocked=${summary.blockedByDependencies ?? 0}, scheduler-blocked=${
      summary.schedulerBlocked ?? 0
    }, launchable=${summary.launchable ?? 0}, approvals=${summary.approvalRequired ?? 0}, waiting-start=${summary.waitingForStart ?? 0}`,
    `Parallelism: active=${parallelism.activeWorkers ?? 0}, slots=${parallelism.availableSlots ?? 0}, max=${parallelism.maxParallelAgents ?? 0}, serial=${
      parallelism.serialTasks?.length ?? 0
    }, parallel-safe=${parallelism.parallelSafeTasks?.length ?? 0}`,
    `Tool/context: required-tasks=${summary.tasksRequiringContext ?? 0}, approval-tasks=${
      summary.tasksNeedingToolContextApproval ?? 0
    }, proposal-needed=${summary.tasksNeedingToolContextProposal ?? 0}, pending=${summary.pendingToolContextApprovals ?? 0}, grants=${
      summary.uniqueRequiredGrants ?? 0
    }`,
    `Files: scopes=${summary.fileScopes ?? 0}, overlaps=${summary.overlappingFileScopes ?? 0}`
  ];
  if (result.executionBlocked) lines.push(`Execution blocked: ${result.blockedReason ?? "queue is not runnable"}.`);
  if (parallelism.workerStartBlocked) lines.push(`Worker start blocked: ${parallelism.workerStartBlockedReason ?? "queue gate is not open"}.`);
  const risk = bucketLine("Risk", result.buckets?.risk);
  const phase = bucketLine("Phase", result.buckets?.phase);
  const category = bucketLine("Category", result.buckets?.category);
  if (risk) lines.push(risk);
  if (phase) lines.push(phase);
  if (category) lines.push(category);
  const launchable = scheduled.launchable?.length ?? 0;
  const approvals = scheduled.approvalRequired?.length ?? 0;
  const blocked = scheduled.blocked?.length ?? 0;
  lines.push(`Preview: launchable=${launchable}, approvals=${approvals}, blocked=${blocked}`);
  const overlappingFiles = (result.fileScopes ?? []).filter((scope) => scope.overlap).slice(0, 5);
  for (const scope of overlappingFiles) {
    lines.push(`  file-overlap ${scope.openTaskCount ?? scope.taskCount ?? 0} ${scope.path ?? ""}`.trimEnd());
  }
  const rejectedGrants = (result.toolContext?.grants ?? []).filter((grant) => grant.policyStatus === "rejected").slice(0, 5);
  for (const grant of rejectedGrants) {
    lines.push(`  rejected ${grant.kind ?? "grant"} ${grant.grantKey ?? ""} tasks=${grant.taskCount ?? 0}`.trimEnd());
  }
  return lines.join("\n");
}

function bucketLine(label: string, buckets: Array<{ key?: string; count?: number; openCount?: number }> | undefined): string | undefined {
  if (!buckets || buckets.length === 0) return undefined;
  return `${label}: ${buckets
    .slice(0, 6)
    .map((bucket) => `${bucket.key ?? "none"}=${bucket.count ?? 0}${bucket.openCount !== undefined ? `/${bucket.openCount}` : ""}`)
    .join(", ")}`;
}

function formatTaskDetail(result: TaskDetailResult): string {
  const task = result.task;
  const readiness = result.readiness;
  const lines = [
    `Queue ${result.queue.queueId} task ${task.queueTaskId}`,
    `Project: ${result.queue.projectPath}`,
    `Task: ${task.title}`,
    `Status: ${task.status}; risk=${task.risk ?? "medium"}; priority=${task.priority ?? "normal"}`,
    `Ready now: ${String(readiness?.readyNow ?? false)}${readiness?.state ? ` (${readiness.state})` : ""}`
  ];
  if (readiness?.reasons?.length) lines.push(`Reasons: ${readiness.reasons.join("; ")}`);
  const dependencies = result.graph?.dependencies ?? [];
  const dependents = result.graph?.dependents ?? [];
  lines.push(`Dependencies: ${dependencies.length}; dependents: ${dependents.length}`);
  for (const dependency of dependencies) {
    const status = dependency.missing ? "missing" : dependency.status ?? "unknown";
    lines.push(`  depends ${dependency.queueTaskId ?? ""} ${status} ${dependency.title ?? ""}`.trimEnd());
  }
  for (const run of result.workerRuns ?? []) {
    const worker = run.workerRun;
    lines.push(`  worker ${worker?.workerRunId ?? ""} ${worker?.worker ?? "worker"} ${worker?.status ?? "unknown"} ${worker?.workspacePath ?? ""}`.trimEnd());
    if (run.latestEvent?.kind) lines.push(`    latest: ${run.latestEvent.kind}${run.latestEvent.body ? ` - ${run.latestEvent.body}` : ""}`);
    if (run.progress?.nextAction) lines.push(`    next: ${run.progress.nextAction}`);
  }
  const pendingTools = (result.toolContextProposals ?? []).filter((proposal) => proposal.status === "proposed" && proposal.approvalRequired);
  const pendingModels = (result.modelApprovals ?? []).filter((approval) => approval.status === "pending");
  lines.push(`Approvals: tool/context=${pendingTools.length}; model=${pendingModels.length}`);
  if (result.resume?.taskPacket) lines.push("Resume packet: included");
  return lines.join("\n");
}

function formatTimeline(result: TimelineResult): string {
  const lines = [`Queue ${result.queue.queueId} timeline: ${result.count}`];
  if (result.items.length === 0) {
    lines.push("No timeline items.");
    return lines.join("\n");
  }
  for (const item of result.items) {
    const prefix = item.timestamp ? `${item.timestamp} ` : "";
    lines.push(`  ${prefix}${item.source ?? "event"} ${item.kind ?? "event"} ${item.title ?? item.timelineId ?? ""}`.trimEnd());
    if (item.summary) lines.push(`    ${item.summary}`);
  }
  return lines.join("\n");
}

function grantSummary(value: unknown): string {
  if (value && typeof value === "object" && typeof (value as { grantKey?: unknown }).grantKey === "string") {
    return (value as { grantKey: string }).grantKey;
  }
  return String(value);
}

function formatQueueReview(status: QueueStatus, next: NextReadyResult, approved: boolean): string {
  const highRisk = status.tasks.filter((task) => task.risk === "high" || task.risk === "breakglass");
  const parallelSafe = status.tasks.filter((task) => task.parallelSafe !== false);
  const serial = status.tasks.filter((task) => task.parallelSafe === false);
  const lines = [
    `Queue ${status.queue.queueId} review${approved ? " (approved)" : ""}`,
    `Project: ${status.queue.projectPath}`,
    `Status: ${status.queue.status}`,
    `Ready now: ${next.ready.length}; blocked: ${next.blocked.length}; active workers: ${next.activeWorkers}; slots: ${next.availableSlots}`,
    `Parallel-safe: ${parallelSafe.length}; serial: ${serial.length}; high-risk: ${highRisk.length}`
  ];
  if (next.executionBlocked) lines.push(`Execution blocked: ${next.blockedReason ?? "queue is not runnable"}.`);
  if (next.ready.length > 0) {
    lines.push("Ready tasks:");
    for (const task of next.ready) {
      lines.push(`  ${task.queueTaskId} ${task.priority ?? "normal"} ${task.risk ?? "medium"} ${task.title}`);
    }
  }
  if (highRisk.length > 0) {
    lines.push("High-risk tasks:");
    for (const task of highRisk) {
      lines.push(`  ${task.queueTaskId} ${task.risk} ${task.title}`);
    }
  }
  return lines.join("\n");
}

function formatClaimNext(result: ClaimNextResult): string {
  const lines = [
    `Queue ${result.queueId} claim-next`,
    `Active workers: ${result.activeWorkers}; slots: ${result.availableSlots}`
  ];
  if (!result.claimed) {
    if (result.executionBlocked) {
      lines.push(`Execution blocked: ${result.blockedReason ?? "queue is not runnable"}.`);
      return lines.join("\n");
    }
    if (result.approvalRequired && result.toolContextProposal?.proposalId) {
      lines.push(`Tool/context approval required before claim. proposal=${result.toolContextProposal.proposalId}`);
      const missing = Array.isArray(result.toolContextProposal.missingGrants) ? result.toolContextProposal.missingGrants : [];
      if (missing.length > 0) lines.push(`Missing: ${missing.map((grant) => grantSummary(grant)).join(", ")}`);
      return lines.join("\n");
    }
    lines.push(`No task claimed. Blocked: ${result.blocked.length}.`);
    return lines.join("\n");
  }
  lines.push(`Claimed ${result.claimed.queueTaskId} ${result.claimed.priority ?? "normal"} ${result.claimed.risk ?? "medium"} ${result.claimed.title}`);
  if (result.claimed.fabricTaskId) lines.push(`Fabric task: ${result.claimed.fabricTaskId}`);
  if (result.workerRun?.workerRunId) {
    lines.push(`Worker run: ${result.workerRun.workerRunId} ${result.workerRun.worker ?? ""} ${result.workerRun.workspacePath ?? ""}`.trim());
  }
  return lines.join("\n");
}

function formatPrepareReady(result: PrepareReadyResult): string {
  const lines = [
    `Queue ${result.queueId} prepare-ready`,
    `Prepared: ${result.prepared.length}; launchable=${result.summary?.readyToLaunch ?? result.summary?.readyToClaim ?? 0}; approvals=${
      result.summary?.approvalRequired ?? 0
    }; waiting-start=${result.summary?.waitingForStart ?? 0}; no-context=${result.summary?.noContextRequired ?? 0}`,
    `Active workers: ${result.activeWorkers}; slots: ${result.availableSlots}`
  ];
  if (result.executionBlocked) {
    lines.push(`Execution blocked: ${result.blockedReason ?? "queue is not runnable"}.`);
    return lines.join("\n");
  }
  if (result.workerStartBlocked) {
    lines.push(`Worker start blocked: ${result.workerStartBlockedReason ?? "queue gate is not open"}.`);
  }
  for (const item of result.prepared) {
    const task = item.task;
    const proposal = item.toolContextProposal;
    const status = item.approvalRequired ? "approval_required" : item.readyToLaunch ? "launchable" : "waiting_start";
    const reused = item.reusedProposal ? " reused" : "";
    lines.push(`  ${status}${reused} ${task?.queueTaskId ?? ""} ${task?.title ?? ""}`.trimEnd());
    if (proposal?.proposalId) lines.push(`    proposal: ${proposal.proposalId}${proposal.status ? ` (${proposal.status})` : ""}`);
    const missing = Array.isArray(item.missingGrants) ? item.missingGrants : [];
    if (missing.length > 0) lines.push(`    missing: ${missing.map((grant) => grantSummary(grant)).join(", ")}`);
  }
  if (result.blocked.length > 0) lines.push(`Blocked: ${result.blocked.length}`);
  return lines.join("\n");
}

function formatLaunchPlan(result: LaunchPlanResult): string {
  const lines = [
    `Queue ${result.queueId} launch plan`,
    `Scheduled: ${result.summary?.scheduled ?? 0}; launchable=${result.summary?.launchable ?? result.launchable.length}; approvals=${
      result.summary?.approvalRequired ?? result.approvalRequired.length
    }; waiting-start=${result.summary?.waitingForStart ?? result.waitingForStart.length}; needs-proposal=${result.summary?.needsProposal ?? 0}`,
    `Active workers: ${result.activeWorkers}; slots: ${result.availableSlots}`
  ];
  if (result.executionBlocked) {
    lines.push(`Execution blocked: ${result.blockedReason ?? "queue is not runnable"}.`);
  } else if (result.workerStartBlocked) {
    lines.push(`Worker start blocked: ${result.workerStartBlockedReason ?? "queue gate is not open"}.`);
  }
  appendLaunchPlanGroup(lines, "Launchable", result.launchable);
  appendLaunchPlanGroup(lines, "Waiting for start", result.waitingForStart);
  appendLaunchPlanGroup(lines, "Approval required", result.approvalRequired);
  if (result.blocked.length > 0) lines.push(`Blocked: ${result.blocked.length}`);
  return lines.join("\n");
}

function appendLaunchPlanGroup(lines: string[], label: string, entries: Array<LaunchPlanEntry>): void {
  if (entries.length === 0) return;
  lines.push(`${label}:`);
  for (const entry of entries) {
    const task = entry.task;
    lines.push(`  ${task?.queueTaskId ?? "unknown"} ${task?.priority ?? "normal"} ${task?.risk ?? "medium"} ${task?.title ?? ""}`.trimEnd());
    if (entry.launchBlockedReason) lines.push(`    blocked: ${entry.launchBlockedReason}`);
    if (entry.toolContextProposal?.proposalId) lines.push(`    proposal: ${entry.toolContextProposal.proposalId}${entry.toolContextProposal.status ? ` (${entry.toolContextProposal.status})` : ""}`);
    const missing = Array.isArray(entry.missingGrants) ? entry.missingGrants : [];
    if (missing.length > 0) lines.push(`    missing: ${missing.map((grant) => grantSummary(grant)).join(", ")}`);
  }
}

function formatRecoverStale(result: RecoverStaleResult): string {
  const lines = [
    `Queue ${result.queueId} stale recovery${result.dryRun ? " (dry run)" : ""}`,
    `Action: ${result.action}; stale after: ${result.staleAfterMinutes} minute(s); matched: ${result.count}`
  ];
  if (result.recovered.length === 0) {
    lines.push("No stale running tasks.");
    return lines.join("\n");
  }
  for (const item of result.recovered) {
    const title = item.queueTask?.title ? ` ${item.queueTask.title}` : "";
    const worker = item.workerRunId ? ` worker=${item.workerRunId}` : "";
    const reason = item.reason ? ` reason=${item.reason}` : "";
    lines.push(`  ${item.queueTaskId ?? "unknown"}${title}${worker}${reason}`);
  }
  return lines.join("\n");
}

function formatQueueCleanup(result: QueueCleanupResult): string {
  const action = result.dryRun ? "Queue cleanup preview" : "Queue cleanup applied";
  const matched = result.dryRun ? result.candidateCount ?? 0 : result.cleanedCount ?? 0;
  const protectedCount = result.protectedCount ?? 0;
  const estimatedDeletedRows = typeof result.totals?.estimatedDeletedRows === "number" ? result.totals.estimatedDeletedRows : undefined;
  const retainedLinkedRows =
    typeof result.totals?.retainedLinkedTaskHistoryRows === "number" ? result.totals.retainedLinkedTaskHistoryRows : undefined;
  const lines = [`${action}: ${matched} queue(s); protected=${protectedCount}`];
  if (estimatedDeletedRows !== undefined) lines.push(`Estimated deleted rows: ${estimatedDeletedRows}`);
  if (retainedLinkedRows !== undefined && retainedLinkedRows > 0) lines.push(`Retained linked task history rows: ${retainedLinkedRows}`);
  const items = (result.dryRun ? result.candidates : result.cleaned) ?? [];
  for (const item of items.slice(0, 10)) {
    if (!item || typeof item !== "object") continue;
    const queue = (item as { queue?: { queueId?: string; status?: string; title?: string } }).queue;
    if (queue?.queueId) lines.push(`  ${queue.queueId} ${queue.status ?? "unknown"} ${queue.title ?? ""}`.trimEnd());
  }
  return lines.join("\n");
}

function formatRetryTask(result: RetryTaskResult): string {
  const task = result.task;
  const lines = [
    `Retried task ${task?.queueTaskId ?? "unknown"}${task?.title ? ` (${task.title})` : ""}.`,
    `Previous status: ${result.previousStatus ?? "unknown"}; current status: ${task?.status ?? "unknown"}.`
  ];
  if (result.previousWorkerRunId) lines.push(`Previous worker run marked stale: ${result.previousWorkerRunId}.`);
  if (result.clearOutputs === false) lines.push("Patch and test refs were retained.");
  if (result.queue?.status) lines.push(`Queue status: ${result.queue.status}.`);
  return lines.join("\n");
}

function formatTaskMetadataUpdated(result: { queue?: { queueId?: string; status?: string }; task?: QueueTask; previousTask?: QueueTask }): string {
  const task = result.task;
  const previous = result.previousTask;
  const lines = [`Updated task metadata ${task?.queueTaskId ?? "unknown"}${task?.title ? ` (${task.title})` : ""}.`];
  if (previous && task) {
    const changed: string[] = [];
    if (previous.title !== task.title) changed.push("title");
	    if (previous.goal !== task.goal) changed.push("goal");
	    if (previous.phase !== task.phase) changed.push("phase");
	    if (previous.managerId !== task.managerId) changed.push("managerId");
	    if (previous.parentManagerId !== task.parentManagerId) changed.push("parentManagerId");
	    if (previous.parentQueueId !== task.parentQueueId) changed.push("parentQueueId");
	    if (previous.workstream !== task.workstream) changed.push("workstream");
	    if (previous.costCenter !== task.costCenter) changed.push("costCenter");
	    if (previous.escalationTarget !== task.escalationTarget) changed.push("escalationTarget");
	    if (previous.category !== task.category) changed.push("category");
    if (previous.priority !== task.priority) changed.push("priority");
    if (previous.parallelGroup !== task.parallelGroup) changed.push("parallelGroup");
    if (previous.parallelSafe !== task.parallelSafe) changed.push("parallelSafe");
    if (previous.risk !== task.risk) changed.push("risk");
    if (JSON.stringify(previous.dependsOn ?? []) !== JSON.stringify(task.dependsOn ?? [])) changed.push("dependsOn");
    if (JSON.stringify(previous.requiredTools ?? []) !== JSON.stringify(task.requiredTools ?? [])) changed.push("requiredTools");
    if (JSON.stringify(previous.requiredMcpServers ?? []) !== JSON.stringify(task.requiredMcpServers ?? [])) changed.push("requiredMcpServers");
    if (JSON.stringify(previous.requiredMemories ?? []) !== JSON.stringify(task.requiredMemories ?? [])) changed.push("requiredMemories");
    if (JSON.stringify(previous.requiredContextRefs ?? []) !== JSON.stringify(task.requiredContextRefs ?? [])) changed.push("requiredContextRefs");
    if (changed.length > 0) lines.push(`Changed: ${changed.join(", ")}.`);
  }
  if (result.queue?.status) lines.push(`Queue status: ${result.queue.status}.`);
  return lines.join("\n");
}

function formatPatchReview(queueId: string, tasks: QueueTask[], acceptedTaskId: string | undefined, appliedPatch?: ReviewedPatchApplyResult): string {
  const lines = [`Queue ${queueId} patch review${acceptedTaskId ? ` accepted=${acceptedTaskId}` : ""}`];
  if (appliedPatch) {
    lines.push(`Applied patch: ${appliedPatch.patchFile}`);
    lines.push(`Apply cwd: ${appliedPatch.cwd}`);
  }
  if (tasks.length === 0) {
    lines.push("No patch-ready tasks.");
    return lines.join("\n");
  }
  for (const task of tasks) {
    lines.push(`  ${task.queueTaskId} ${task.status} ${task.title}`);
    if (task.summary) lines.push(`    summary: ${task.summary}`);
    if (task.patchRefs?.length) lines.push(`    patches: ${task.patchRefs.join(", ")}`);
    if (task.testRefs?.length) lines.push(`    tests: ${task.testRefs.join(", ")}`);
  }
  return lines.join("\n");
}

function formatRunTaskResult(task: QueueTask, workerRunId: string, exitCode: number, changedFiles: string[]): string {
  const lines = [
    `Ran task ${task.queueTaskId} (${task.title}) with worker run ${workerRunId}.`,
    `Exit code: ${exitCode}. Changed files: ${changedFiles.length}.`
  ];
  for (const file of changedFiles.slice(0, 20)) {
    lines.push(`  ${file}`);
  }
  if (changedFiles.length > 20) lines.push(`  ...and ${changedFiles.length - 20} more`);
  return lines.join("\n");
}

function formatTaskPacketsWritten(queueId: string, packets: Array<{ queueTaskId: string; path: string }>): string {
  const lines = [`Queue ${queueId}: wrote ${packets.length} task packet(s).`];
  for (const packet of packets.slice(0, 20)) {
    lines.push(`  ${packet.queueTaskId}: ${packet.path}`);
  }
  if (packets.length > 20) lines.push(`  ...and ${packets.length - 20} more`);
  return lines.join("\n");
}

function formatResumeTaskResult(command: Extract<ProjectCliCommand, { command: "resume-task" }>, result: QueueResumeResult): string {
  const lines = [
    `Resume packet for ${result.queueTask.queueTaskId} (${result.queueTask.title}).`,
    `Workspace: ${result.fabricResume.workspacePath ?? result.fabricResume.projectPath}.`,
    `Model profile: ${result.fabricResume.modelProfile ?? "unspecified"}.`
  ];
  if (command.outputFile) lines.push(`Wrote ${command.format} resume packet to ${command.outputFile}.`);
  else lines.push(result.fabricResume.resumePrompt);
  return lines.join("\n");
}

function formatRunReadyResult(queueId: string, runs: ProjectRunResult[], skipped: Record<string, unknown>[], next: NextReadyResult): string {
  const lines = [
    `Queue ${queueId}: ran ${runs.length} ready task(s), skipped ${skipped.length}.`,
    `Active before run: ${next.activeWorkers}; slots before run: ${next.availableSlots}.`
  ];
  if (next.executionBlocked) lines.push(`Execution blocked: ${next.blockedReason ?? "queue is not runnable"}.`);
  for (const run of runs) {
    lines.push(`  ${run.action} ${String(run.data.queueTaskId)} exit=${String(run.data.exitCode ?? "n/a")}`);
  }
  for (const item of skipped) {
    lines.push(`  skipped ${String(item.queueTaskId)}: ${String(item.reason)}`);
  }
  return lines.join("\n");
}

function formatFactoryRunPreview(
  queueId: string,
  reviewMatrix: ReviewMatrixResult,
  prepared: PrepareReadyResult,
  launchPlan: LaunchPlanResult,
  packetDir: string,
  cwdTemplate: string
): string {
  const lines = [
    `Queue ${queueId}: factory-run preview.`,
    `Tasks: ${reviewMatrix.summary?.totalTasks ?? "unknown"} total; ready=${reviewMatrix.summary?.readyDependencyFree ?? "unknown"}; overlaps=${
      reviewMatrix.summary?.overlappingFileScopes ?? 0
    }.`,
    `Prepared: ${prepared.prepared.length}; launchable=${launchPlan.launchable.length}; approvals=${launchPlan.approvalRequired.length}; waiting-start=${launchPlan.waitingForStart.length}.`,
    `Packet dir: ${packetDir}`,
    `Sandbox template: ${cwdTemplate}`
  ];
  if (launchPlan.executionBlocked) lines.push(`Execution blocked: ${launchPlan.blockedReason ?? "queue is not runnable"}.`);
  return lines.join("\n");
}

function formatFactoryRunCompleted(
  queueId: string,
  run: ProjectRunResult,
  reviewMatrix: ReviewMatrixResult,
  prepared: PrepareReadyResult,
  launchPlan: LaunchPlanResult
): string {
  const data = run.data;
  const lines = [
    `Queue ${queueId}: factory-run completed.`,
    `Runs: ${String(data.runCount ?? 0)}; skipped=${Array.isArray(data.skipped) ? data.skipped.length : 0}; initialParallel=${String(data.initialParallel ?? "unknown")}; finalParallel=${String(data.finalParallel ?? "unknown")}.`,
    `Rate-limit signals: ${String(data.rateLimitSignals ?? 0)}; adjustments=${Array.isArray(data.parallelAdjustments) ? data.parallelAdjustments.length : 0}.`,
    `Review matrix: tasks=${reviewMatrix.summary?.totalTasks ?? "unknown"}; overlap scopes=${reviewMatrix.summary?.overlappingFileScopes ?? 0}.`,
    `Prepared: ${prepared.prepared.length}; launchable before run=${launchPlan.launchable.length}; approvals before run=${launchPlan.approvalRequired.length}.`
  ];
  if (run.message) lines.push("", run.message);
  return lines.join("\n");
}

function checkResult(id: string, ok: boolean, evidence: unknown, suggestedAction?: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    ok,
    severity: ok ? "ok" : "error",
    evidence,
    suggestedAction,
    ...extra
  };
}

function formatSeniorDoctor(projectPath: string, ok: boolean, checks: Array<Record<string, unknown>>): string {
  const lines = [`Senior doctor for ${projectPath}: ${ok ? "ok" : "blocked"}`];
  for (const check of checks) {
    lines.push(`  ${check.ok ? "ok" : "fail"} ${String(check.id)}: ${String(check.evidence ?? "")}`);
    if (!check.ok && check.suggestedAction) lines.push(`    next: ${String(check.suggestedAction)}`);
  }
  lines.push("", `Daemon control guardrail: ${SHARED_DAEMON_GUARDRAIL}`);
  return lines.join("\n");
}

function sharedDaemonControlPolicy(projectPath: string): Record<string, unknown> {
  return {
    scope: "shared-local-daemon",
    projectPath,
    requiresOperatorApproval: true,
    agentsMayRestart: false,
    agentsMayKill: false,
    agentsMayRemoveSocket: false,
    forbiddenAgentActions: SHARED_DAEMON_FORBIDDEN_AGENT_ACTIONS,
    safeAgentActions: SHARED_DAEMON_SAFE_AGENT_ACTIONS,
    warning: SHARED_DAEMON_GUARDRAIL
  };
}

function daemonControlCheckMetadata(): Record<string, unknown> {
  return {
    requiresOperatorApproval: true,
    agentsMayRestartDaemon: false,
    agentsMayKillDaemon: false,
    agentsMayRemoveSocket: false,
    forbiddenAgentActions: SHARED_DAEMON_FORBIDDEN_AGENT_ACTIONS,
    safeAgentActions: SHARED_DAEMON_SAFE_AGENT_ACTIONS
  };
}

function scaffoldSeniorTasks(planFile: string, count: number): unknown[] {
  const plan = readFile(planFile);
  const headings = plan
    .split(/\r?\n/)
    .map((line) => line.match(/^#{1,3}\s+(.+)$/)?.[1]?.trim())
    .filter((line): line is string => Boolean(line))
    .filter((line) => !/^summary$/i.test(line))
    .slice(0, Math.max(1, count));
  const seeds = headings.length > 0 ? headings : [`Continue implementing ${basename(planFile)}`];
  return seeds.slice(0, count).map((title, index) => ({
    clientKey: `senior-local-${index + 1}`,
    title,
    goal: `Implement a reviewable slice from ${planFile}: ${title}. Keep changes scoped, write checkpoints, and return patch-ready evidence.`,
    category: "implementation",
    phase: "senior-run",
    priority: "normal",
    parallelSafe: true,
    risk: "medium",
    expectedFiles: [],
    acceptanceCriteria: [
      "Implementation is scoped to the assigned slice.",
      "Changed files, commands, and tests are reported in the worker result.",
      "Patch output is reviewable by the senior coordinator before acceptance."
    ],
    requiredTools: ["shell", "read", "edit"],
    requiredMcpServers: [],
    requiredMemories: [],
    requiredContextRefs: [planFile]
  }));
}

function writeTasksFile(path: string, tasks: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ schema: "agent-fabric.senior-tasks.v1", tasks }, null, 2)}\n`, "utf8");
}

function writeProgressMarkdown(path: string, report: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${formatProgressMarkdown(report)}\n`, "utf8");
}

function formatProgressMarkdown(report: Record<string, unknown>): string {
  const queue = recordFrom(report.queue);
  const summary = recordFrom(report.summary);
  const counts = recordFrom(report.counts);
  const nextActions = arrayRecords(report.nextActions);
  const patchReadyTasks = arrayRecords(report.patchReadyTasks);
  const workers = recordFrom(report.workers);
  const cards = arrayRecords(workers.cards ?? workers.lanes);
  return [
    "# Agent Fabric Senior Progress",
    "",
    `Queue: ${String(queue.queueId ?? queue.id ?? "")}`,
    `Project: ${String(queue.projectPath ?? "")}`,
    `Status: ${String(summary.status ?? queue.status ?? "")}`,
    `Generated: ${String(report.generatedAt ?? new Date().toISOString())}`,
    "",
    "## Counts",
    "",
    ...Object.entries(counts).map(([key, value]) => `- ${key}: ${String(value)}`),
    "",
    "## Workers",
    "",
    ...(cards.length > 0
      ? cards.map((card) => `- ${String(card.handle ?? card.laneId ?? card.agentId ?? "")}: ${String(card.status ?? card.rawStatus ?? "")}`)
      : ["- none"]),
    "",
    "## Patch Review",
    "",
    ...(patchReadyTasks.length > 0
      ? patchReadyTasks.map((task) => `- ${String(task.queueTaskId ?? "")}: ${String(task.title ?? "")}`)
      : ["- no patch-ready tasks"]),
    "",
    "## Next Actions",
    "",
    ...(nextActions.length > 0
      ? nextActions.map((action) => `- ${String(action.label ?? "Continue")}: \`${String(action.command ?? "")}\``)
      : ["- inspect queue status"]),
    "",
    "Patch acceptance requires senior review metadata (`reviewedBy` and `reviewSummary`)."
  ].join("\n");
}

export function formatSeniorRun(
  queueId: string,
  requested: number,
  run: ProjectRunResult,
  progressFile: string,
  progress?: Record<string, unknown>
): string {
  const counts = recordFrom(progress?.counts);
  const nextActions = arrayRecords(progress?.nextActions);
  const patchReadyTasks = arrayRecords(progress?.patchReadyTasks);
  const runData = recordFrom(run.data ?? {});

  const ran = typeof runData.runCount === "number" ? String(runData.runCount) : "n/a";
  const failed = counts.failed ?? 0;
  const stale = counts.stale ?? 0;
  const completed = counts.completed ?? 0;
  const running = counts.running ?? 0;
  const patchReadyCount = counts.patch_ready ?? patchReadyTasks.length;

  const lines = [
    `Senior-run queue ${queueId}.`,
    `Lanes: ${requested} requested, ${ran} ran.`,
    `Status: completed=${completed}, failed=${failed}, running=${running}, stale=${stale}, patch-ready=${patchReadyCount}.`
  ];

  if (Number(failed) > 0) lines.push(`Failed: ${failed} task(s) — review queue and retry.`);
  if (Number(stale) > 0) lines.push(`Stale: ${stale} task(s) — run recover-stale.`);
  if (patchReadyTasks.length > 0) {
    const summary = patchReadyTasks
      .slice(0, 5)
      .map((t) => `${String(t.queueTaskId ?? "")} ${String(t.title ?? "")}`.trim())
      .join(", ");
    lines.push(`Patch-ready: ${patchReadyTasks.length} task(s): ${summary}`);
    if (patchReadyTasks.length > 5) lines.push(`  ...and ${patchReadyTasks.length - 5} more`);
  }

  if (nextActions.length > 0) {
    lines.push("Next:");
    for (const action of nextActions.slice(0, 3)) {
      lines.push(`  \`${String(action.command ?? "")}\``);
    }
  }

  lines.push(`Progress: ${progressFile}`);
  return lines.join("\n");
}

function formatProgressReport(report: Record<string, unknown>, progressFile?: string): string {
  const queue = recordFrom(report.queue);
  const summary = recordFrom(report.summary);
  const nextCommand = typeof report.nextCommand === "string" ? report.nextCommand : undefined;
  return [
    `Queue ${String(queue.queueId ?? queue.id ?? "")} progress: ${String(summary.status ?? "unknown")}.`,
    `Next: ${nextCommand ?? String(summary.nextAction ?? "inspect queue")}.`,
    progressFile ? `Wrote ${progressFile}.` : ""
  ].filter(Boolean).join("\n");
}

function recordFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function formatLaunchResult(
  queueId: string,
  started: Record<string, unknown>[],
  skipped: Record<string, unknown>[],
  next: NextReadyResult
): string {
  const lines = [
    `Queue ${queueId}: launched ${started.length} worker(s), skipped ${skipped.length}.`,
    `Active before launch: ${next.activeWorkers}; slots before launch: ${next.availableSlots}.`
  ];
  if (next.executionBlocked) lines.push(`Execution blocked: ${next.blockedReason ?? "queue is not runnable"}.`);
  for (const item of started) {
    lines.push(`  started ${String(item.queueTaskId)} -> ${String(item.workerRunId)} ${String(item.title)}`);
  }
  for (const item of skipped) {
    const proposal = item.proposalId ? ` proposal=${String(item.proposalId)}` : "";
    lines.push(`  skipped ${String(item.queueTaskId)}: ${String(item.reason)}${proposal}`);
  }
  return lines.join("\n");
}

function defaultWorkspacePath(projectPath: string, queueTaskId: string, mode: string): string {
  if (mode === "in_place") return projectPath;
  return join(`${projectPath}.worktrees`, queueTaskId);
}

function defaultWorkerCommand(worker: string, fabricTaskId: string): string[] {
  if (worker === "manual") return [];
  if (worker === "aider") return ["aider", "--message", `Work on fabric task ${fabricTaskId}`];
  if (worker === "deepseek-direct") return ["agent-fabric-deepseek-worker", "run-task", "--fabric-task", fabricTaskId];
  if (worker === "jcode-deepseek") return [jcodeDeepSeekDispatcherPath(), "<task-packet>"];
  return [worker, "run", "--fabric-task", fabricTaskId];
}

function commandLineForReadyTask(
  command: Extract<ProjectCliCommand, { command: "run-ready" }>,
  task: QueueTask,
  projectPath: string,
  taskPacketPath?: string,
  contextFilePath?: string
): string {
  if (!command.commandTemplate && command.worker === "deepseek-direct") {
    if (!taskPacketPath) {
      throw new FabricError("INVALID_INPUT", "deepseek-direct run-ready requires --task-packet-dir or an explicit --command-template", false);
    }
    const sensitiveFlag = seniorModePermissive(process.env) ? " --allow-sensitive-context" : "";
    const contextFlag = contextFilePath ? " --context-file {{contextFile}}" : "";
    return expandCommandTemplate(
      `AGENT_FABRIC_DEEPSEEK_AUTO_QUEUE=off agent-fabric-deepseek-worker run-task --task-packet {{taskPacket}}${contextFlag} --fabric-task {{fabricTaskId}} --role {{deepseekRole}}${sensitiveFlag}`,
      task,
      projectPath,
      taskPacketPath,
      contextFilePath
    );
  }
  if (!command.commandTemplate && command.worker === "jcode-deepseek") {
    if (!taskPacketPath) {
      throw new FabricError("INVALID_INPUT", "jcode-deepseek run-ready requires --task-packet-dir or an explicit --command-template", false);
    }
    const args = [jcodeDeepSeekDispatcherPath(), taskPacketPath];
    if (command.maxRuntimeMinutes) args.push("--max-runtime-minutes", String(command.maxRuntimeMinutes));
    return args.map(shellQuote).join(" ");
  }
  const template = command.commandTemplate ?? defaultWorkerCommand(command.worker, task.fabricTaskId ?? "").map(shellQuote).join(" ");
  if (!template) {
    throw new FabricError("INVALID_INPUT", "run-ready requires --command-template when worker has no default command", false);
  }
  const expanded = expandCommandTemplate(template, task, projectPath, taskPacketPath, contextFilePath);
  if (command.worker === "deepseek-direct" && /\bagent-fabric-deepseek-worker\b/.test(expanded)) {
    const linked = hasFabricTaskArgument(expanded) ? expanded : `${expanded} --fabric-task ${shellQuote(task.fabricTaskId ?? "")}`;
    return withDeepSeekAutoQueueOff(linked);
  }
  return expanded;
}

function hasFabricTaskArgument(commandLine: string): boolean {
  return /(^|\s)--fabric-task(?:=|\s|$)/.test(commandLine);
}

function withDeepSeekAutoQueueOff(commandLine: string): string {
  return /\bAGENT_FABRIC_DEEPSEEK_AUTO_QUEUE=/.test(commandLine)
    ? commandLine
    : `AGENT_FABRIC_DEEPSEEK_AUTO_QUEUE=off ${commandLine}`;
}

function cwdForReadyTask(command: Extract<ProjectCliCommand, { command: "run-ready" }>, task: QueueTask, projectPath: string): string {
  if (command.cwdTemplate) return expandPathTemplate(command.cwdTemplate, task, projectPath);
  return command.cwd ?? projectPath;
}

function prepareRunWorkspace(
  workspaceMode: "in_place" | "git_worktree" | "clone" | "sandbox",
  cwd: string,
  cwdPrep: CwdPrepMode,
  projectPath: string
): void {
  if (cwdPrep === "none" || workspaceMode === "in_place") return;
  if (cwdPrep === "mkdir") {
    if (workspaceMode === "git_worktree" || workspaceMode === "clone") {
      throw new FabricError("INVALID_INPUT", "cwd-prep mkdir cannot create git_worktree or clone workspaces", false);
    }
    mkdirSync(cwd, { recursive: true });
    return;
  }
  if (workspaceMode === "sandbox") {
    mkdirSync(cwd, { recursive: true });
    return;
  }
  if (workspaceMode === "git_worktree") {
    prepareGitWorktree(projectPath, cwd);
    return;
  }
  assertWorkspaceDirectoryExists(cwd, workspaceMode);
}

function prepareGitWorktree(projectPath: string, cwd: string): void {
  const resolvedProject = resolve(projectPath);
  const resolvedCwd = resolve(cwd);
  const root = gitOutput(["-C", resolvedProject, "rev-parse", "--show-toplevel"], "PROJECT_NOT_GIT_REPO").trim();
  if (!root) {
    throw new FabricError("PROJECT_NOT_GIT_REPO", `Project path is not a git repository: ${projectPath}`, false);
  }
  if (existsSync(resolvedCwd)) {
    assertWorkspaceDirectoryExists(resolvedCwd, "git_worktree");
    gitOutput(["-C", resolvedCwd, "rev-parse", "--is-inside-work-tree"], "WORKSPACE_NOT_GIT_WORKTREE");
    return;
  }
  const result = spawnSync("git", ["-C", resolvedProject, "worktree", "add", "--detach", resolvedCwd, "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new FabricError(
      "WORKTREE_PREP_FAILED",
      (result.stderr || result.stdout || `git worktree add failed for ${resolvedCwd}`).trim(),
      false
    );
  }
}

function gitOutput(args: string[], code: string): string {
  const result = spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw new FabricError(code, (result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim(), false);
  }
  return result.stdout;
}

function assertWorkspaceDirectoryExists(cwd: string, workspaceMode: string): void {
  try {
    if (statSync(cwd).isDirectory()) return;
  } catch {
    // Fall through to a clear error below.
  }
  throw new FabricError("WORKSPACE_NOT_FOUND", `${workspaceMode} workspace does not exist: ${cwd}`, false);
}

function assertParallelCwdPolicy(
  command: Extract<ProjectCliCommand, { command: "run-ready" }>,
  tasks: QueueTask[],
  projectPath: string,
  parallel: number
): void {
  if (parallel <= 1 || tasks.length <= 1 || command.allowSharedCwd) return;
  const cwds = tasks.map((task) => cwdForReadyTask(command, task, projectPath));
  if (new Set(cwds).size !== cwds.length) {
    throw new FabricError(
      "PROJECT_RUN_READY_SHARED_CWD",
      "Parallel run-ready would execute multiple tasks in the same cwd; pass --cwd-template for isolated directories or --allow-shared-cwd explicitly",
      false
    );
  }
}

async function blockMissingReadyContextRefs(
  queueId: string,
  projectPath: string,
  tasks: QueueTask[],
  call: ProjectToolCaller
): Promise<void> {
  const issues = missingContextRefIssues(projectPath, tasks);
  if (issues.length === 0) return;

  const grouped = new Map<string, string[]>();
  for (const issue of issues) {
    grouped.set(issue.queueTaskId, [...(grouped.get(issue.queueTaskId) ?? []), `${issue.ref} (${issue.reason})`]);
  }
  for (const task of tasks) {
    const taskIssues = grouped.get(task.queueTaskId);
    if (!taskIssues) continue;
    await call("project_queue_update_task", {
      queueId,
      queueTaskId: task.queueTaskId,
      status: "blocked",
      summary: `Blocked before launch: missing context refs: ${taskIssues.join(", ")}`
    });
  }

  const sample = issues.slice(0, 5).map((issue) => `${issue.queueTaskId}:${issue.ref}`).join(", ");
  throw new FabricError(
    "PROJECT_QUEUE_CONTEXT_REF_MISSING",
    `Refusing to launch ${grouped.size} task(s) with missing context refs. Repair or rewrite the refs before running workers. Sample: ${sample}`,
    false
  );
}

function missingContextRefIssues(
  projectPath: string,
  tasks: QueueTask[]
): Array<{ queueTaskId: string; ref: string; reason: string; path?: string }> {
  const issues: Array<{ queueTaskId: string; ref: string; reason: string; path?: string }> = [];
  for (const task of tasks) {
    for (const ref of uniqueStrings(stringArray(task.requiredContextRefs))) {
      const path = contextRefPathForValidation(projectPath, ref);
      if (!path) continue;
      if (!existsSync(path)) {
        issues.push({ queueTaskId: task.queueTaskId, ref, reason: "missing", path });
      }
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

function normalizeParallel(value: number): number {
  const max = seniorMaxLaneCount();
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new FabricError("INVALID_INPUT", `parallel must be an integer between 1 and ${max}`, false);
  }
  return value;
}

function normalizeMinParallel(value: number, maxParallel: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maxParallel) {
    throw new FabricError("INVALID_INPUT", "min-parallel must be an integer between 1 and parallel", false);
  }
  return value;
}

function isRateLimitRunResult(result: ProjectRunResult): boolean {
  if (result.action !== "task_run_failed") return false;
  if (structuredRateLimitSignal(result.data.structuredResult)) return true;
  if (jsonErrorRateLimitSignal(String(result.data.stderrTail ?? "")) || jsonErrorRateLimitSignal(String(result.data.stdoutTail ?? ""))) return true;
  const haystack = [
    result.message,
    result.data.stderrTail,
    result.data.stdoutTail,
    result.data.structuredResult ? JSON.stringify(result.data.structuredResult) : ""
  ].join("\n");
  return /DEEPSEEK_RATE_LIMITED|DeepSeek API returned 429|Too Many Requests/i.test(haystack);
}

function structuredRateLimitSignal(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const error = record.error && typeof record.error === "object" && !Array.isArray(record.error) ? (record.error as Record<string, unknown>) : {};
  const codes = [record.code, record.errorCode, record.status, error.code].filter((entry): entry is string => typeof entry === "string");
  return codes.some((code) => code === "DEEPSEEK_RATE_LIMITED" || /rate[_ -]?limit|too many requests/i.test(code));
}

function jsonErrorRateLimitSignal(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      if (structuredRateLimitSignal(JSON.parse(trimmed) as unknown)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function expandCommandTemplate(template: string, task: QueueTask, projectPath: string, taskPacketPath?: string, contextFilePath?: string): string {
  const values: Record<string, string> = {
    queueTaskId: task.queueTaskId,
    fabricTaskId: task.fabricTaskId ?? "",
    title: task.title,
    goal: task.goal,
    projectPath,
    taskPacket: taskPacketPath ?? "",
    contextFile: contextFilePath ?? "",
    deepseekRole: deepSeekRoleForTask(task)
  };
  if (template.includes("{{taskPacket") && !taskPacketPath) {
    throw new FabricError("INVALID_INPUT", "--task-packet-dir is required when command-template uses {{taskPacket}}", false);
  }
  if (template.includes("{{contextFile") && !contextFilePath) {
    throw new FabricError("INVALID_INPUT", "--task-packet-dir is required when command-template uses {{contextFile}}", false);
  }
  return template.replace(/\{\{\s*(queueTaskId|fabricTaskId|title|goal|projectPath|taskPacket|contextFile|deepseekRole)\s*\}\}/g, (_match, key: string) =>
    shellQuote(values[key] ?? "")
  );
}

function deepSeekRoleForTask(task: QueueTask): "implementer" | "reviewer" | "risk-reviewer" | "adjudicator" | "planner" {
  const exactCategory = (task.category ?? "").toLowerCase();
  if (["implementer", "reviewer", "risk-reviewer", "adjudicator", "planner"].includes(exactCategory)) {
    return exactCategory as "implementer" | "reviewer" | "risk-reviewer" | "adjudicator" | "planner";
  }
  const value = `${task.category ?? ""} ${task.phase ?? ""} ${task.title ?? ""}`.toLowerCase();
  if (value.includes("risk")) return "risk-reviewer";
  if (value.includes("adjudicat")) return "adjudicator";
  if (value.includes("plan")) return "planner";
  if (value.includes("review") || value.includes("test") || value.includes("docs")) return "reviewer";
  return "implementer";
}

function expandPathTemplate(template: string, task: QueueTask, projectPath: string): string {
  const values: Record<string, string> = {
    queueTaskId: task.queueTaskId,
    fabricTaskId: task.fabricTaskId ?? "",
    title: task.title,
    goal: task.goal,
    projectPath
  };
  return template.replace(/\{\{\s*(queueTaskId|fabricTaskId|title|goal|projectPath)\s*\}\}/g, (_match, key: string) => values[key] ?? "");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function jcodeDeepSeekDispatcherPath(): string {
  const configured = process.env.AGENT_FABRIC_JCODE_DEEPSEEK_DISPATCHER?.trim();
  return configured || "agent-fabric-jcode-deepseek-worker";
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 96) || "queue";
}

type WrittenTaskPacket = {
  queueTaskId: string;
  path: string;
  format: string;
  contextPath: string;
  contextFiles: string[];
};

function writeTaskPacket(
  status: QueueStatus,
  task: QueueTask,
  outDir: string,
  format: "json" | "markdown"
): WrittenTaskPacket {
  mkdirSync(outDir, { recursive: true });
  const extension = format === "markdown" ? "md" : "json";
  const path = join(outDir, `${task.queueTaskId}.${extension}`);
  const context = taskContextBundle(status.queue.projectPath, task);
  const contextPath = join(outDir, `${task.queueTaskId}.context.md`);
  writeFileSync(contextPath, context.body, "utf8");
  const packet = taskPacket(status, task, contextPath);
  const body = format === "markdown" ? formatTaskPacketMarkdown(packet) : `${JSON.stringify(packet, null, 2)}\n`;
  writeFileSync(path, body, "utf8");
  return { queueTaskId: task.queueTaskId, path, format, contextPath, contextFiles: context.included };
}

function taskPacketMetadata(taskPacketPath?: string, taskPacketFormat?: "json" | "markdown", taskContextPath?: string): Record<string, string> {
  if (!taskPacketPath) return {};
  return {
    taskPacketPath,
    taskPacketFormat: taskPacketFormat ?? "json",
    ...(taskContextPath ? { contextFilePath: taskContextPath } : {})
  };
}

function taskPacket(status: QueueStatus, task: QueueTask, contextFilePath?: string): Record<string, unknown> {
  return {
    schema: "agent-fabric.task-packet.v1",
    queue: {
      queueId: status.queue.queueId,
      projectPath: status.queue.projectPath,
      status: status.queue.status,
      planChainId: status.queue.planChainId
    },
    task,
    contextFilePath,
    terminalToolGuidance: {
      automationSafe: {
        rg: "Use for source/text search.",
        fd: "Use for filename/path discovery.",
        jq: "Use for JSON payloads, logs, and config.",
        gh: "Use only for explicit GitHub work.",
        btop: "Use only for human-supervised resource diagnostics."
      },
      humanFacingOrOptional: {
        bat: "Readable file viewing; do not depend on aliases or colorized output in automation.",
        eza: "Readable directory listings; do not depend on aliases or icons in automation.",
        fzf: "Interactive operator selection only.",
        zoxide: "Human shell navigation only; unattended workers should use explicit paths.",
        atuin: "Interactive shell history only; do not use as task memory or evidence.",
        tmux: "Persistent human-facing sessions only.",
        zellij: "Optional human-facing terminal workspace.",
        delta: "Human diff review when git/diff work is explicitly allowed.",
        glab: "GitLab-only and non-default; use only for explicit GitLab tasks."
      }
    },
    operatorInstructions: [
      "Work only on this task unless the queue state says otherwise.",
      "Use only approved tools and context.",
      "Prefer rg for source/text search, fd for filename/path discovery, and jq for JSON payloads/logs/config.",
      "Use gh only for explicit GitHub work, btop only for human-supervised diagnostics, and glab only for explicit GitLab work.",
      "Do not run git operations unless the task or project rules explicitly allow them.",
      "Treat bat, eza, fzf, zoxide, atuin, tmux, and zellij as human-facing or optional helpers; do not depend on aliases or shell history for unattended execution.",
      "Record command, file, test, checkpoint, patch-ready, failed, or completed events through agent-fabric.",
      "Return patch-ready output with test evidence or an explicit blocker."
    ]
  };
}

function taskContextBundle(projectPath: string, task: QueueTask): { body: string; included: string[] } {
  const refs = uniqueStrings([...stringArray(task.expectedFiles), ...stringArray(task.requiredContextRefs)]);
  const included: string[] = [];
  const skipped: string[] = [];
  const sections: string[] = [
    "# Agent Fabric Task Context",
    "",
    `Project: ${projectPath}`,
    `Task: ${task.queueTaskId} ${task.title}`,
    "",
    "This file is generated from expectedFiles and requiredContextRefs so file-only DeepSeek lanes have concrete source context. It is bounded and may omit large, missing, binary, unsafe, or secret-looking files.",
    ""
  ];
  let totalBytes = 0;
  for (const ref of refs) {
    const candidate = resolveTaskContextPath(projectPath, ref);
    if (!candidate) {
      skipped.push(`${ref}: unsupported or outside project`);
      continue;
    }
    if (secretLikeContextPath(candidate)) {
      skipped.push(`${ref}: secret-like path skipped`);
      continue;
    }
    if (!existsSync(candidate)) {
      skipped.push(`${ref}: missing`);
      continue;
    }
    let stat;
    try {
      stat = statSync(candidate);
    } catch {
      skipped.push(`${ref}: unreadable`);
      continue;
    }
    if (!stat.isFile()) {
      skipped.push(`${ref}: not a file`);
      continue;
    }
    if (stat.size > TASK_CONTEXT_MAX_FILE_BYTES) {
      skipped.push(`${ref}: too large (${stat.size} bytes)`);
      continue;
    }
    if (totalBytes + stat.size > TASK_CONTEXT_MAX_TOTAL_BYTES) {
      skipped.push(`${ref}: total context cap reached`);
      continue;
    }
    let text: string;
    try {
      text = readFileSync(candidate, "utf8");
    } catch {
      skipped.push(`${ref}: unreadable`);
      continue;
    }
    if (text.includes("\0")) {
      skipped.push(`${ref}: binary-looking content`);
      continue;
    }
    totalBytes += Buffer.byteLength(text, "utf8");
    const rel = relative(projectPath, candidate) || ref;
    included.push(rel);
    sections.push(`## ${rel}`, "", "```text", text, "```", "");
  }
  if (included.length === 0) {
    sections.push("## Included Files", "", "- none", "");
  }
  if (skipped.length > 0) {
    sections.push("## Omitted Context", "", ...skipped.map((item) => `- ${item}`), "");
  }
  return { body: `${sections.join("\n")}\n`, included };
}

function resolveTaskContextPath(projectPath: string, ref: string): string | undefined {
  const trimmed = ref.trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return undefined;
  if (trimmed.includes("\0")) return undefined;
  const resolvedProject = resolve(projectPath);
  const resolved = isAbsolute(trimmed) ? resolve(trimmed) : resolve(resolvedProject, trimmed);
  return isPathInside(resolved, resolvedProject) ? resolved : undefined;
}

function secretLikeContextPath(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (name === ".env" || name.endsWith(".env") || name === "agent-fabric.local.env" || name === "cost-ingest-token") return true;
  if (/\.(pem|key|p12|pfx)$/.test(name)) return true;
  return /(^|[._-])(secret|secrets|credential|credentials|api-key|private-key|access-token|refresh-token|auth-token)([._-]|$)/.test(name);
}

function formatTaskPacketMarkdown(packet: Record<string, unknown>): string {
  const queue = packet.queue as Record<string, unknown>;
  const task = packet.task as QueueTask;
  const instructions = Array.isArray(packet.operatorInstructions) ? packet.operatorInstructions : [];
  const terminalToolGuidance = packet.terminalToolGuidance as Record<string, Record<string, string>> | undefined;
  const contextFilePath = typeof packet.contextFilePath === "string" ? packet.contextFilePath : "";
  return [
    "---",
    "schema: agent-fabric.task-packet.v1",
    `queueId: ${frontmatterValue(String(queue.queueId))}`,
    `queueTaskId: ${frontmatterValue(task.queueTaskId)}`,
	    `fabricTaskId: ${frontmatterValue(task.fabricTaskId ?? "")}`,
	    `projectPath: ${frontmatterValue(String(queue.projectPath))}`,
	    `contextFilePath: ${frontmatterValue(contextFilePath)}`,
	    `managerId: ${frontmatterValue(task.managerId ?? "")}`,
	    `workstream: ${frontmatterValue(task.workstream ?? task.parallelGroup ?? "")}`,
	    "---",
    "",
    `# ${task.title}`,
    "",
    `Queue: ${String(queue.queueId)}`,
    `Project: ${String(queue.projectPath)}`,
    `Queue task: ${task.queueTaskId}`,
    `Fabric task: ${task.fabricTaskId ?? ""}`,
    `Context file: ${contextFilePath}`,
    `Status: ${task.status}`,
    `Risk: ${task.risk ?? "medium"}`,
    "",
    "## Goal",
    "",
    task.goal,
    "",
	    "## Task Metadata",
	    "",
	    `Phase: ${task.phase ?? ""}`,
	    `Manager: ${task.managerId ?? ""}`,
	    `Parent manager: ${task.parentManagerId ?? ""}`,
	    `Parent queue: ${task.parentQueueId ?? ""}`,
	    `Workstream: ${task.workstream ?? task.parallelGroup ?? ""}`,
	    `Cost center: ${task.costCenter ?? ""}`,
	    `Escalation target: ${task.escalationTarget ?? ""}`,
	    `Priority: ${task.priority ?? "normal"}`,
    `Parallel safe: ${String(task.parallelSafe ?? true)}`,
    `Depends on: ${JSON.stringify(task.dependsOn ?? [])}`,
    `Required tools: ${JSON.stringify(task.requiredTools ?? [])}`,
    `Required MCP servers: ${JSON.stringify(task.requiredMcpServers ?? [])}`,
    `Required memories: ${JSON.stringify(task.requiredMemories ?? [])}`,
    `Required context refs: ${JSON.stringify(task.requiredContextRefs ?? [])}`,
    "",
    "## Expected Files",
    "",
    ...formatPacketList(task.expectedFiles),
    "",
    "## Acceptance Criteria",
    "",
    ...formatPacketList(task.acceptanceCriteria),
    "",
    "## Terminal Tool Guidance",
    "",
    ...formatTerminalToolGuidance(terminalToolGuidance),
    "",
    "## Instructions",
    "",
    ...instructions.map((instruction) => `- ${String(instruction)}`),
    ""
  ].join("\n");
}

function frontmatterValue(value: string): string {
  return JSON.stringify(value);
}

function formatResumePacketMarkdown(packet: Record<string, unknown>): string {
  const queue = packet.queue as Record<string, unknown>;
  const task = packet.task as QueueTask;
  const resume = packet.fabricResume as QueueResumeResult["fabricResume"];
  const instructions = Array.isArray(packet.operatorInstructions) ? packet.operatorInstructions : [];
  const terminalToolGuidance = packet.terminalToolGuidance as Record<string, Record<string, string>> | undefined;
  return [
    `# Resume ${task.title}`,
    "",
    `Queue: ${String(queue.queueId)}`,
    `Project: ${String(queue.projectPath)}`,
    `Queue task: ${task.queueTaskId}`,
    `Fabric task: ${task.fabricTaskId ?? ""}`,
    `Task status: ${task.status}`,
    `Workspace: ${resume.workspacePath ?? resume.projectPath}`,
    `Model profile: ${resume.modelProfile ?? ""}`,
    `Context policy: ${resume.contextPolicy ?? ""}`,
    "",
    "## Resume Prompt",
    "",
    resume.resumePrompt,
    "",
    "## Latest Checkpoint",
    "",
    "```json",
    JSON.stringify(resume.latestCheckpoint ?? null, null, 2),
    "```",
    "",
    "## Required Context",
    "",
    `Required tools: ${JSON.stringify(packet.requiredTools ?? [])}`,
    `Required MCP servers: ${JSON.stringify(packet.requiredMcpServers ?? [])}`,
    `Required memories: ${JSON.stringify(packet.requiredMemories ?? [])}`,
    `Required context refs: ${JSON.stringify(packet.requiredContextRefs ?? [])}`,
    "",
    "## Terminal Tool Guidance",
    "",
    ...formatTerminalToolGuidance(terminalToolGuidance),
    "",
    "## Instructions",
    "",
    ...instructions.map((instruction) => `- ${String(instruction)}`),
    ""
  ].join("\n");
}

function formatPacketList(values: unknown[] | undefined): string[] {
  if (!values || values.length === 0) return ["- (unspecified)"];
  return values.map((value) => `- ${String(value)}`);
}

function formatTerminalToolGuidance(guidance: Record<string, Record<string, string>> | undefined): string[] {
  if (!guidance) return ["- (unspecified)"];
  const lines: string[] = [];
  for (const [group, tools] of Object.entries(guidance)) {
    lines.push(`### ${group}`);
    for (const [tool, note] of Object.entries(tools)) {
      lines.push(`- \`${tool}\`: ${note}`);
    }
    lines.push("");
  }
  return lines;
}

type ShellResult = {
  exitCode: number;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type StructuredWorkerResult = {
  source: string;
  status?: string;
  summary?: string;
  patchMode?: string;
  patchFile?: string;
  proposedPatch?: string;
  patchApply?: unknown;
  changedFilesSuggested?: string[];
  testsSuggested?: string[];
  blockers?: string[];
  raw: Record<string, unknown>;
};

async function runShellCommand(
  command: string,
  cwd: string,
  maxOutputChars: number,
  maxRuntimeMinutes?: number,
  envOverrides: Record<string, string> = {},
  lifecycle: { onSpawn?: (pid: number) => void } = {}
): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: "/bin/bash",
      env: {
        ...process.env,
        BASH_ENV: "",
        ENV: "",
        ZDOTDIR: "/var/empty",
        ...envOverrides
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (typeof child.pid === "number") lifecycle.onSpawn?.(child.pid);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeoutMs = maxRuntimeMinutes ? maxRuntimeMinutes * 60_000 : undefined;
    const timeout = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          stderr = tailText(`${stderr}\nCommand timed out after ${maxRuntimeMinutes} minute(s).`, maxOutputChars);
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL");
          }, 5_000).unref();
        }, timeoutMs)
      : undefined;
    timeout?.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = tailText(stdout + chunk, maxOutputChars);
    });
    child.stderr.on("data", (chunk) => {
      stderr = tailText(stderr + chunk, maxOutputChars);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      resolve({ exitCode: timedOut ? 124 : (code ?? 1), signal, stdout, stderr, timedOut });
    });
  });
}

function queueVisibleWorkerEnv(
  command: Extract<ProjectCliCommand, { command: "run-task" }>,
  task: QueueTask,
  queue: QueueStatus["queue"],
  workerRunId: string
): Record<string, string> {
  if (!SENIOR_DEEPSEEK_WORKERS.has(command.worker) && !/\bagent-fabric-deepseek-worker\b/.test(command.commandLine)) {
    return {};
  }
  return {
    AGENT_FABRIC_WORKER_QUEUE_VISIBLE: "1",
    AGENT_FABRIC_QUEUE_ID: command.queueId,
    AGENT_FABRIC_QUEUE_TASK_ID: task.queueTaskId,
    AGENT_FABRIC_FABRIC_TASK_ID: task.fabricTaskId ?? "",
    AGENT_FABRIC_WORKER_RUN_ID: workerRunId,
    AGENT_FABRIC_PROJECT_PATH: queue.projectPath,
    AGENT_FABRIC_WORKSPACE_ROOT: queue.projectPath
  };
}

type SnapshotEntry = {
  size: number;
  mtimeMs: number;
};

type FileSnapshot = {
  root: string;
  entries: Map<string, SnapshotEntry>;
  truncated: boolean;
};

const SNAPSHOT_SKIP_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".nuxt",
  ".turbo",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".agent-fabric"
]);

function snapshotFiles(root: string): FileSnapshot {
  const entries = new Map<string, SnapshotEntry>();
  let truncated = false;
  const maxFiles = 10_000;
  const visit = (dir: string): void => {
    if (entries.size >= maxFiles) {
      truncated = true;
      return;
    }
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (SNAPSHOT_SKIP_NAMES.has(name)) continue;
      const path = join(dir, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isFile()) {
        const ref = relative(root, path);
        entries.set(ref, { size: stat.size, mtimeMs: stat.mtimeMs });
      }
      if (entries.size >= maxFiles) {
        truncated = true;
        return;
      }
    }
  };
  visit(root);
  return { root, entries, truncated };
}

function diffSnapshots(before: FileSnapshot, after: FileSnapshot): string[] {
  const changed = new Set<string>();
  for (const [path, current] of after.entries.entries()) {
    const previous = before.entries.get(path);
    if (!previous || previous.size !== current.size || previous.mtimeMs !== current.mtimeMs) {
      changed.add(path);
    }
  }
  for (const path of before.entries.keys()) {
    if (!after.entries.has(path)) changed.add(path);
  }
  return [...changed].sort();
}

function looksLikeTestCommand(command: string): boolean {
  return /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(vitest|pytest|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test)\b/.test(command);
}

function loadStructuredWorkerResult(cwd: string, stdout: string, changedFiles: string[]): StructuredWorkerResult | undefined {
  const stdoutResult = parseStructuredWorkerJson(stdout, "stdout");
  if (stdoutResult) return stdoutResult;
  const stdoutPathResult = loadStructuredWorkerResultFromStdoutPath(cwd, stdout);
  if (stdoutPathResult) return stdoutPathResult;
  for (const file of changedFiles) {
    if (!file.endsWith(".json")) continue;
    try {
      const body = readFileSync(join(cwd, file), "utf8");
      const parsed = parseStructuredWorkerJson(body, file);
      if (parsed) return parsed;
    } catch {
      continue;
    }
  }
  return undefined;
}

function loadStructuredWorkerResultFromStdoutPath(cwd: string, stdout: string): StructuredWorkerResult | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.endsWith(".json") || /[\0\r\n]/.test(trimmed)) continue;
    const path = isAbsolute(trimmed) ? trimmed : join(cwd, trimmed);
    try {
      const parsed = parseStructuredWorkerJson(readFileSync(path, "utf8"), path);
      if (parsed) return parsed;
    } catch {
      continue;
    }
  }
  return undefined;
}

function parseStructuredWorkerJson(value: string, source: string): StructuredWorkerResult | undefined {
  const trimmed = stripJsonFence(value.trim());
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const isDeepSeekArtifact = record.schema === "agent-fabric.deepseek-worker-result.v1";
    const payload = isDeepSeekArtifact && record.result && typeof record.result === "object" && !Array.isArray(record.result)
      ? (record.result as Record<string, unknown>)
      : record;
    if (!isDeepSeekArtifact && !("status" in payload) && !("summary" in payload)) return undefined;
    return {
      source,
      status: typeof payload.status === "string" ? payload.status : undefined,
      summary: typeof payload.summary === "string" ? payload.summary : undefined,
      patchMode: typeof record.patchMode === "string" ? record.patchMode : typeof payload.patchMode === "string" ? payload.patchMode : undefined,
      patchFile: typeof record.patchFile === "string" ? record.patchFile : typeof payload.patchFile === "string" ? payload.patchFile : undefined,
      proposedPatch: typeof payload.proposedPatch === "string" ? payload.proposedPatch : undefined,
      patchApply: record.patchApply,
      changedFilesSuggested: stringArray(payload.changedFilesSuggested),
      testsSuggested: stringArray(payload.testsSuggested),
      blockers: stringArray(payload.blockers),
      raw: record
    };
  } catch {
    return undefined;
  }
}

function stripJsonFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1].trim() : text;
}

function workerBlockers(exitCode: number, status?: string, result?: StructuredWorkerResult): string[] {
  if (exitCode !== 0) return [`Command exited ${exitCode}`];
  if (status === "blocked") return result?.blockers?.length ? result.blockers : ["Structured worker result reported blocked."];
  if (status === "failed") return result?.blockers?.length ? result.blockers : ["Structured worker result reported failed."];
  return [];
}

function tailText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(value.length - maxChars);
}

async function resolveAlias(
  alias: string,
  taskType: string,
  contextSize: number,
  risk: string,
  call: ProjectToolCaller
): Promise<PolicyAliasResult> {
  return call<PolicyAliasResult>("policy_resolve_alias", {
    alias,
    taskType,
    contextSize,
    risk
  });
}

async function preflightProjectModel(input: {
  call: ProjectToolCaller;
  queueId: string;
  taskType: string;
  modelAlias: string;
  route: PolicyAliasResult;
  text: string;
  contextSummary: Record<string, unknown>;
  approvalToken?: string;
}): Promise<PreflightResult> {
  return input.call<PreflightResult>("llm_preflight", {
    task: {
      type: input.taskType,
      queueId: input.queueId,
      modelAlias: input.modelAlias
    },
    client: "agent-fabric-project",
    candidateModel: input.route.model,
    requestedProvider: input.route.provider,
    requestedReasoning: input.route.reasoning,
    contextPackageSummary: input.contextSummary,
    budgetScope: `project_queue:${input.queueId}`,
    approvalToken: input.approvalToken
  });
}

async function preflightDeepSeekWorkerCommand(
  command: Extract<ProjectCliCommand, { command: "run-task" }>,
  task: QueueTask,
  status: QueueStatus,
  call: ProjectToolCaller
): Promise<PreflightResult | undefined> {
  if (command.worker !== "deepseek-direct" && command.worker !== "jcode-deepseek" && !/\bagent-fabric-deepseek-worker\b/.test(command.commandLine)) return undefined;
  const contextText = [task.title, task.goal, command.commandLine, command.taskPacketPath ?? ""].join("\n");
  return call<PreflightResult>("llm_preflight", {
    task: {
      type: task.risk === "high" || task.risk === "breakglass" ? "code_edit" : "worker_deepseek_direct",
      queueId: command.queueId,
      queueTaskId: task.queueTaskId,
      modelAlias: command.modelProfile
    },
    client: "agent-fabric-project",
    candidateModel: "deepseek-v4-pro",
    requestedProvider: "deepseek",
    requestedReasoning: "max",
    contextPackageSummary: {
      taskTitle: task.title,
      taskRisk: task.risk ?? "medium",
      taskPacketPath: command.taskPacketPath,
      commandPreview: summarizeText(command.commandLine),
      estimatedTokens: estimateTokens(contextText)
    },
    budgetScope: `project_queue:${command.queueId}`,
    boundResourceId: command.queueTaskId,
    approvalToken: command.approvalToken
  });
}

function preflightBlockedResult(action: string, preflight: PreflightResult): ProjectRunResult {
  const request = preflight.requestId ? ` request=${preflight.requestId}` : "";
  return {
    action,
    message: `Preflight returned ${preflight.decision} (${preflight.risk}).${request}`,
    data: { preflight }
  };
}

async function defaultModelRunner(request: ProjectModelRequest): Promise<Record<string, unknown>> {
  const command = process.env.AGENT_FABRIC_PROJECT_MODEL_COMMAND;
  if (!command) {
    throw new FabricError(
      "PROJECT_MODEL_COMMAND_MISSING",
      "AGENT_FABRIC_PROJECT_MODEL_COMMAND is required for model-backed project generation",
      false
    );
  }
  return runJsonCommand(command, request);
}

async function runJsonCommand(command: string, payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new FabricError("PROJECT_MODEL_COMMAND_FAILED", stderr.trim() || `model command exited ${code}`, false));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new FabricError("PROJECT_MODEL_COMMAND_INVALID_JSON", "model command must return a JSON object", false));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch (error) {
        reject(new FabricError("PROJECT_MODEL_COMMAND_INVALID_JSON", error instanceof Error ? error.message : String(error), false));
      }
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

function promptImprovementInstructions(): string {
  return [
    "Improve the user prompt for a project-level coding queue.",
    "Preserve user intent and explicit decisions.",
    "Clarify goals, constraints, acceptance criteria, risk gates, and missing questions.",
    "Return JSON with improvedPrompt, summary, and optional warnings."
  ].join(" ");
}

function taskGenerationInstructions(): string {
  return [
    "Split the accepted plan into phases and concrete coding tasks.",
    "Every task must include title, goal, acceptanceCriteria, risk, priority, expectedFiles, requiredTools, requiredMcpServers, requiredMemories, requiredContextRefs, parallelSafe, and dependsOn.",
    "Use clientKey values for dependencies within the generated batch.",
    "Return JSON with phases and tasks."
  ].join(" ");
}

function requiredGeneratedString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new FabricError("PROJECT_MODEL_OUTPUT_INVALID", `model output must contain non-empty ${field}`, false);
  }
  return value;
}

function normalizeGeneratedTasks(record: Record<string, unknown>): { phases: unknown[]; tasks: unknown[] } {
  const phases = Array.isArray(record.phases) ? record.phases : [];
  const tasks = Array.isArray(record.tasks) ? record.tasks : [];
  if (tasks.length === 0) {
    throw new FabricError("PROJECT_MODEL_OUTPUT_INVALID", "model output must contain a non-empty tasks array", false);
  }
  for (const [index, task] of tasks.entries()) {
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      throw new FabricError("PROJECT_MODEL_OUTPUT_INVALID", `tasks[${index}] must be an object`, false);
    }
    const item = task as Record<string, unknown>;
    if (typeof item.title !== "string" || typeof item.goal !== "string") {
      throw new FabricError("PROJECT_MODEL_OUTPUT_INVALID", `tasks[${index}] must contain title and goal`, false);
    }
  }
  return { phases, tasks };
}

function summarizeText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function startWorkerHeartbeat(
  command: Extract<ProjectCliCommand, { command: "run-task" }>,
  task: QueueTask,
  workerRunId: string,
  cwd: string,
  call: ProjectToolCaller
): () => void {
  if (!task.fabricTaskId || !Number.isFinite(WORKER_HEARTBEAT_MS) || WORKER_HEARTBEAT_MS <= 0) {
    return () => undefined;
  }
  const label =
    command.worker === "jcode-deepseek"
      ? "Jcode DeepSeek worker"
      : command.worker === "deepseek-direct" || /\bagent-fabric-deepseek-worker\b/.test(command.commandLine)
        ? "DeepSeek worker"
        : "Worker command";
  let count = 0;
  const timer = setInterval(() => {
    count += 1;
    void call("fabric_task_heartbeat", {
      taskId: task.fabricTaskId,
      workerRunId,
      task: `${label} still running.`,
      metadata: {
        queueId: command.queueId,
        queueTaskId: task.queueTaskId,
        cwd,
        worker: command.worker,
        heartbeatCount: count
      }
    }).catch(() => undefined);
    if (count % 2 === 0) {
      void call("fabric_task_checkpoint", {
        taskId: task.fabricTaskId,
        workerRunId,
        summary: {
          currentGoal: task.goal,
          filesTouched: [],
          commandsRun: [command.commandLine],
          testsRun: [],
          decisions: [],
          assumptions: [],
          blockers: [],
          nextAction: `${label} is still running.`,
          cwd,
          heartbeatCount: count
        }
      }).catch(() => undefined);
    }
  }, WORKER_HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

function objectFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sameOrUnder(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}/`);
}

function localPackageRoot(): string | undefined {
  const runtimeFile = fileURLToPath(import.meta.url);
  for (const marker of [`${join("dist", "runtime")}${runtimeFile.includes("/") ? "/" : "\\"}`, `${join("src", "runtime")}${runtimeFile.includes("/") ? "/" : "\\"}`]) {
    const index = runtimeFile.lastIndexOf(marker);
    if (index !== -1) return runtimeFile.slice(0, index).replace(/[\\/]$/, "");
  }
  return undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function readFile(path: string): string {
  return readFileSync(path, "utf8");
}

type ParsedFlags = {
  json: boolean;
  projectPath?: string;
  prompt?: string;
  promptFile?: string;
  promptSummary?: string;
  factorsFile?: string;
  title?: string;
  profile?: string;
  modelAlias?: string;
  approvalToken?: string;
  accept: boolean;
  apply: boolean;
  outputFile?: string;
  maxAgents?: number;
  queueId?: string;
  task?: string;
  taskFile?: string;
  taskId?: string;
  planFile?: string;
  maxRounds?: number;
  budgetUsd?: number;
  outputFormat?: string;
  tasksFile?: string;
  metadataFile?: string;
  approveQueue: boolean;
  acceptTaskId?: string;
  applyPatch: boolean;
  applyCwd?: string;
  queueTaskId?: string;
  commandLine?: string;
  commandTemplate?: string;
  cwd?: string;
  cwdTemplate?: string;
  cwdPrep?: string;
  taskPacketPath?: string;
  taskPacketDir?: string;
  taskPacketFormat?: string;
  outDir?: string;
  format?: string;
  readyOnly: boolean;
  successStatus?: string;
  patchMode?: string;
  maxOutputChars?: number;
  parallel?: number;
  minParallel?: number;
  adaptiveRateLimit: boolean;
  noAdaptiveRateLimit: boolean;
  deepSeekWorkerCommand?: string;
  deepSeekRole?: string;
  sensitiveContextMode?: string;
  startExecution: boolean;
  allowSensitiveContext: boolean;
  approveModelCalls: boolean;
  allowConcurrentRunner: boolean;
  allowSharedCwd: boolean;
  allowPartial: boolean;
  approveToolContext: boolean;
  rememberToolContext: boolean;
  continueOnFailure: boolean;
  limit?: number;
  count?: number;
  worker?: string;
  workerRunId?: string;
  agent?: string;
  body?: string;
  message?: string;
  summary?: string;
  ask: boolean;
  urgency?: string;
  refs?: string[];
  agents?: string[];
  targetStatuses?: string[];
  workspaceMode?: string;
  modelProfile?: string;
  contextPolicy?: string;
  workspacePath?: string;
  maxRuntimeMinutes?: number;
  proposalId?: string;
  memoryId?: string;
  grantKind?: string;
  value?: string;
  status?: string;
  decision?: string;
  queueStatuses?: string[];
  includeClosed: boolean;
  includeCompleted: boolean;
  includeExpired: boolean;
  includeResume: boolean;
  archived: boolean;
  maxEventsPerLane?: number;
  managerSummaryLimit?: number;
  staleAfterMinutes?: number;
  olderThanDays?: number;
  recoveryAction?: string;
  dryRun: boolean;
  deleteLinkedTaskHistory: boolean;
  remember: boolean;
  keepOutputs: boolean;
  progressFile?: string;
  reviewedBy?: string;
  reviewSummary?: string;
  runTests?: boolean;
  reason?: string;
  note?: string;
  rewriteContextRefs?: string[];
};

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = {
    json: false,
    approveQueue: false,
    remember: false,
    accept: false,
    apply: false,
    applyPatch: false,
    approveToolContext: false,
    rememberToolContext: false,
    continueOnFailure: false,
    adaptiveRateLimit: false,
    noAdaptiveRateLimit: false,
    startExecution: false,
    allowSensitiveContext: false,
    approveModelCalls: false,
    allowConcurrentRunner: false,
    allowSharedCwd: false,
    allowPartial: false,
    readyOnly: false,
    includeClosed: false,
    includeCompleted: false,
    includeExpired: false,
    includeResume: false,
    archived: false,
    dryRun: false,
    deleteLinkedTaskHistory: false,
    keepOutputs: false,
    ask: false
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") flags.json = true;
    else if (arg === "--project") flags.projectPath = requiredValue(args, ++i, arg);
    else if (arg === "--prompt") flags.prompt = requiredValue(args, ++i, arg);
    else if (arg === "--prompt-file") flags.promptFile = requiredValue(args, ++i, arg);
    else if (arg === "--prompt-summary") flags.promptSummary = requiredValue(args, ++i, arg);
    else if (arg === "--factors-file") flags.factorsFile = requiredValue(args, ++i, arg);
    else if (arg === "--title") flags.title = requiredValue(args, ++i, arg);
    else if (arg === "--profile") flags.profile = requiredValue(args, ++i, arg);
    else if (arg === "--model-alias") flags.modelAlias = requiredValue(args, ++i, arg);
    else if (arg === "--approval-token") flags.approvalToken = requiredValue(args, ++i, arg);
    else if (arg === "--accept") flags.accept = true;
    else if (arg === "--apply") flags.apply = true;
    else if (arg === "--output-file") flags.outputFile = requiredValue(args, ++i, arg);
    else if (arg === "--max-agents") flags.maxAgents = positiveInt(requiredValue(args, ++i, arg), "max-agents");
    else if (arg === "--queue") flags.queueId = requiredValue(args, ++i, arg);
    else if (arg === "--task") flags.task = requiredValue(args, ++i, arg);
    else if (arg === "--task-id") flags.taskId = requiredValue(args, ++i, arg);
    else if (arg === "--task-file") flags.taskFile = requiredValue(args, ++i, arg);
    else if (arg === "--plan-file") flags.planFile = requiredValue(args, ++i, arg);
    else if (arg === "--max-rounds") flags.maxRounds = positiveInt(requiredValue(args, ++i, arg), "max-rounds");
    else if (arg === "--budget-usd") flags.budgetUsd = positiveNumber(requiredValue(args, ++i, arg), "budget-usd");
    else if (arg === "--output-format") flags.outputFormat = requiredValue(args, ++i, arg);
    else if (arg === "--tasks-file") flags.tasksFile = requiredValue(args, ++i, arg);
    else if (arg === "--metadata-file") flags.metadataFile = requiredValue(args, ++i, arg);
    else if (arg === "--approve-queue") flags.approveQueue = true;
    else if (arg === "--accept-task") flags.acceptTaskId = requiredValue(args, ++i, arg);
    else if (arg === "--apply-patch") flags.applyPatch = true;
    else if (arg === "--apply-cwd") flags.applyCwd = requiredValue(args, ++i, arg);
    else if (arg === "--queue-task") flags.queueTaskId = requiredValue(args, ++i, arg);
    else if (arg === "--command") flags.commandLine = requiredValue(args, ++i, arg);
    else if (arg === "--command-template") flags.commandTemplate = requiredValue(args, ++i, arg);
    else if (arg === "--cwd") flags.cwd = requiredValue(args, ++i, arg);
    else if (arg === "--cwd-template") flags.cwdTemplate = requiredValue(args, ++i, arg);
    else if (arg === "--cwd-prep") flags.cwdPrep = requiredValue(args, ++i, arg);
    else if (arg === "--task-packet") flags.taskPacketPath = requiredValue(args, ++i, arg);
    else if (arg === "--task-packet-dir") flags.taskPacketDir = requiredValue(args, ++i, arg);
    else if (arg === "--task-packet-format") flags.taskPacketFormat = requiredValue(args, ++i, arg);
    else if (arg === "--out-dir") flags.outDir = requiredValue(args, ++i, arg);
    else if (arg === "--format") flags.format = requiredValue(args, ++i, arg);
    else if (arg === "--ready-only") flags.readyOnly = true;
    else if (arg === "--success-status") flags.successStatus = requiredValue(args, ++i, arg);
    else if (arg === "--patch-mode") flags.patchMode = requiredValue(args, ++i, arg);
    else if (arg === "--max-output-chars") flags.maxOutputChars = positiveInt(requiredValue(args, ++i, arg), "max-output-chars");
    else if (arg === "--parallel") flags.parallel = positiveInt(requiredValue(args, ++i, arg), "parallel");
    else if (arg === "--min-parallel") flags.minParallel = positiveInt(requiredValue(args, ++i, arg), "min-parallel");
    else if (arg === "--adaptive-rate-limit") flags.adaptiveRateLimit = true;
    else if (arg === "--no-adaptive-rate-limit") flags.noAdaptiveRateLimit = true;
    else if (arg === "--deepseek-worker-command") flags.deepSeekWorkerCommand = requiredValue(args, ++i, arg);
    else if (arg === "--deepseek-role") flags.deepSeekRole = requiredValue(args, ++i, arg);
    else if (arg === "--sensitive-context-mode") flags.sensitiveContextMode = requiredValue(args, ++i, arg);
    else if (arg === "--start-execution") flags.startExecution = true;
    else if (arg === "--allow-sensitive-context") flags.allowSensitiveContext = true;
    else if (arg === "--approve-model-calls") flags.approveModelCalls = true;
    else if (arg === "--allow-concurrent-runner") flags.allowConcurrentRunner = true;
    else if (arg === "--allow-shared-cwd") flags.allowSharedCwd = true;
    else if (arg === "--allow-partial") flags.allowPartial = true;
    else if (arg === "--approve-tool-context") flags.approveToolContext = true;
    else if (arg === "--remember-tool-context") flags.rememberToolContext = true;
    else if (arg === "--continue-on-failure") flags.continueOnFailure = true;
    else if (arg === "--limit") flags.limit = positiveInt(requiredValue(args, ++i, arg), "limit");
    else if (arg === "--count") flags.count = positiveInt(requiredValue(args, ++i, arg), "count");
    else if (arg === "--worker") flags.worker = requiredValue(args, ++i, arg);
    else if (arg === "--worker-run") flags.workerRunId = requiredValue(args, ++i, arg);
    else if (arg === "--agent") flags.agent = requiredValue(args, ++i, arg);
    else if (arg === "--body") flags.body = requiredValue(args, ++i, arg);
    else if (arg === "--message") flags.message = requiredValue(args, ++i, arg);
    else if (arg === "--summary") flags.summary = requiredValue(args, ++i, arg);
    else if (arg === "--reviewed-by") flags.reviewedBy = requiredValue(args, ++i, arg);
    else if (arg === "--review-summary") flags.reviewSummary = requiredValue(args, ++i, arg);
    else if (arg === "--ask") flags.ask = true;
    else if (arg === "--urgency") flags.urgency = requiredValue(args, ++i, arg);
    else if (arg === "--ref") flags.refs = [...(flags.refs ?? []), requiredValue(args, ++i, arg)];
    else if (arg === "--agent-filter") flags.agents = [...(flags.agents ?? []), requiredValue(args, ++i, arg)];
    else if (arg === "--target-status") flags.targetStatuses = [...(flags.targetStatuses ?? []), requiredValue(args, ++i, arg)];
    else if (arg === "--workspace-mode") flags.workspaceMode = requiredValue(args, ++i, arg);
    else if (arg === "--model-profile") flags.modelProfile = requiredValue(args, ++i, arg);
    else if (arg === "--context-policy") flags.contextPolicy = requiredValue(args, ++i, arg);
    else if (arg === "--workspace-path") flags.workspacePath = requiredValue(args, ++i, arg);
    else if (arg === "--max-runtime-minutes") flags.maxRuntimeMinutes = positiveInt(requiredValue(args, ++i, arg), "max-runtime-minutes");
    else if (arg === "--proposal") flags.proposalId = requiredValue(args, ++i, arg);
    else if (arg === "--memory") flags.memoryId = requiredValue(args, ++i, arg);
    else if (arg === "--kind") flags.grantKind = requiredValue(args, ++i, arg);
    else if (arg === "--value") flags.value = requiredValue(args, ++i, arg);
    else if (arg === "--status") flags.status = requiredValue(args, ++i, arg);
    else if (arg === "--decision") flags.decision = requiredValue(args, ++i, arg);
    else if (arg === "--queue-status") flags.queueStatuses = [...(flags.queueStatuses ?? []), requiredValue(args, ++i, arg)];
    else if (arg === "--include-closed") flags.includeClosed = true;
    else if (arg === "--include-completed") flags.includeCompleted = true;
    else if (arg === "--include-expired") flags.includeExpired = true;
    else if (arg === "--include-resume") flags.includeResume = true;
    else if (arg === "--archived") flags.archived = true;
    else if (arg === "--max-events") flags.maxEventsPerLane = positiveInt(requiredValue(args, ++i, arg), "max-events");
    else if (arg === "--manager-summary-limit") flags.managerSummaryLimit = positiveInt(requiredValue(args, ++i, arg), "manager-summary-limit");
    else if (arg === "--stale-after-minutes") flags.staleAfterMinutes = positiveInt(requiredValue(args, ++i, arg), "stale-after-minutes");
    else if (arg === "--older-than-days") flags.olderThanDays = nonNegativeInt(requiredValue(args, ++i, arg), "older-than-days");
    else if (arg === "--recovery-action") flags.recoveryAction = requiredValue(args, ++i, arg);
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--delete-linked-task-history") flags.deleteLinkedTaskHistory = true;
    else if (arg === "--progress-file") flags.progressFile = requiredValue(args, ++i, arg);
    else if (arg === "--keep-outputs") flags.keepOutputs = true;
    else if (arg === "--reason") flags.reason = requiredValue(args, ++i, arg);
    else if (arg === "--rewrite-context-ref") flags.rewriteContextRefs = [...(flags.rewriteContextRefs ?? []), requiredValue(args, ++i, arg)];
    else if (arg === "--remember") flags.remember = true;
    else if (arg === "--note") flags.note = requiredValue(args, ++i, arg);
    else if (arg === "--run-tests") flags.runTests = true;
    else if (arg.startsWith("-")) throw new FabricError("INVALID_INPUT", `Unknown flag: ${arg}`, false);
    else if (!flags.proposalId) flags.proposalId = arg;
    else throw new FabricError("INVALID_INPUT", `Unexpected argument: ${arg}`, false);
  }
  return flags;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new FabricError("INVALID_INPUT", `${flag} requires a value`, false);
  return value;
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new FabricError("INVALID_INPUT", message, false);
  return value;
}

function positiveInt(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new FabricError("INVALID_INPUT", `${field} must be a positive integer`, false);
  return parsed;
}

function nonNegativeInt(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new FabricError("INVALID_INPUT", `${field} must be a non-negative integer`, false);
  return parsed;
}

function positiveNumber(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new FabricError("INVALID_INPUT", `${field} must be a positive number`, false);
  return parsed;
}

function parseProfile(value: string): "fast" | "balanced" | "careful" | "custom" {
  if (["fast", "balanced", "careful", "custom"].includes(value)) return value as "fast" | "balanced" | "careful" | "custom";
  throw new FabricError("INVALID_INPUT", "profile must be fast, balanced, careful, or custom", false);
}

function parseOutputFormat(value: string): "markdown" | "adr" {
  if (["markdown", "adr"].includes(value)) return value as "markdown" | "adr";
  throw new FabricError("INVALID_INPUT", "output-format must be markdown or adr", false);
}

function parseWorker(value: string): WorkerKind {
  if (["ramicode", "local-cli", "openhands", "aider", "smolagents", "codex-app-server", "deepseek-direct", "jcode-deepseek", "manual"].includes(value)) {
    return value as WorkerKind;
  }
  throw new FabricError(
    "INVALID_INPUT",
    "worker must be ramicode, local-cli, openhands, aider, smolagents, codex-app-server, deepseek-direct, jcode-deepseek, or manual",
    false
  );
}

function parseCodexBridgeWorker(value: string): "deepseek-direct" | "jcode-deepseek" {
  if (value === "deepseek-direct" || value === "jcode-deepseek") return value;
  throw new FabricError("INVALID_INPUT", "fabric-spawn-agents worker must be deepseek-direct or jcode-deepseek", false);
}

function parseCodexBridgeWorkspaceMode(value: string): "git_worktree" | "sandbox" {
  if (value === "git_worktree" || value === "sandbox") return value;
  throw new FabricError("INVALID_INPUT", "fabric-spawn-agents workspace-mode must be git_worktree or sandbox", false);
}

function parseWorkspaceMode(value: string): "in_place" | "git_worktree" | "clone" | "sandbox" {
  if (["in_place", "git_worktree", "clone", "sandbox"].includes(value)) return value as "in_place" | "git_worktree" | "clone" | "sandbox";
  throw new FabricError("INVALID_INPUT", "workspace-mode must be in_place, git_worktree, clone, or sandbox", false);
}

function parseCwdPrep(value: string): CwdPrepMode {
  if (["auto", "none", "mkdir"].includes(value)) return value as CwdPrepMode;
  throw new FabricError("INVALID_INPUT", "cwd-prep must be auto, none, or mkdir", false);
}

function parseSuccessStatus(value: string): "patch_ready" | "completed" {
  if (["patch_ready", "completed"].includes(value)) return value as "patch_ready" | "completed";
  throw new FabricError("INVALID_INPUT", "success-status must be patch_ready or completed", false);
}

function parseFactoryPatchMode(value: string): "report" | "write" {
  if (value === "report" || value === "write") return value;
  throw new FabricError("INVALID_INPUT", "factory-run patch-mode must be report or write", false);
}

function parseDeepSeekRole(value: string): DeepSeekRole {
  if (["auto", "implementer", "reviewer", "risk-reviewer", "adjudicator", "planner"].includes(value)) return value as DeepSeekRole;
  throw new FabricError("INVALID_INPUT", "deepseek-role must be auto, implementer, reviewer, risk-reviewer, adjudicator, or planner", false);
}

function parseSensitiveContextMode(value: string, allowSensitiveContext: boolean): SensitiveContextMode {
  if (allowSensitiveContext) return "off";
  if (value === "basic" || value === "strict" || value === "off") return value;
  throw new FabricError("INVALID_INPUT", "sensitive-context-mode must be basic, strict, or off", false);
}

function defaultAllowSensitiveContext(flags: ParsedFlags): boolean {
  if (flags.allowSensitiveContext) return true;
  if (flags.sensitiveContextMode !== undefined) return false;
  return seniorModePermissive(process.env);
}

function seniorModePermissive(env: NodeJS.ProcessEnv): boolean {
  return /^(1|true|yes|on|permissive|unrestricted|allow-sensitive)$/i.test(env[SENIOR_MODE_ENV] ?? "");
}

function seniorModeAllowsNonDeepSeekWorkers(env: NodeJS.ProcessEnv): boolean {
  return /^(1|true|yes|on)$/i.test(env[SENIOR_ALLOW_NON_DEEPSEEK_WORKERS_ENV] ?? "");
}

function assertSeniorModeDeepSeekWorker(worker: WorkerKind | undefined, commandName: string): void {
  if (!seniorModePermissive(process.env) || seniorModeAllowsNonDeepSeekWorkers(process.env)) return;
  if (worker && SENIOR_DEEPSEEK_WORKERS.has(worker)) return;
  const selected = worker ?? "unspecified";
  throw new FabricError(
    "SENIOR_MODE_REQUIRES_DEEPSEEK_WORKER",
    `${commandName} in Senior mode must use Agent Fabric queue-backed DeepSeek workers; selected=${selected}. Use --worker deepseek-direct or --worker jcode-deepseek, or set ${SENIOR_ALLOW_NON_DEEPSEEK_WORKERS_ENV}=1 only for an explicit human-approved fallback.`,
    false
  );
}

function assertSeniorModeDeepSeekCommandTemplate(worker: WorkerKind, commandTemplate: string | undefined, commandName: string): void {
  if (!commandTemplate || !seniorModePermissive(process.env) || seniorModeAllowsNonDeepSeekWorkers(process.env)) return;
  if (!SENIOR_DEEPSEEK_WORKERS.has(worker)) return;
  if (containsNonDeepSeekHarness(commandTemplate)) {
    throw new FabricError(
      "SENIOR_MODE_DEEPSEEK_IDENTITY_MISMATCH",
      `${commandName} in Senior mode cannot record worker=${worker} while launching Codex, Claude, or another non-DeepSeek harness. Use the real DeepSeek worker command or set ${SENIOR_ALLOW_NON_DEEPSEEK_WORKERS_ENV}=1 for an explicit fallback.`,
      false
    );
  }
  if (worker === "deepseek-direct" && !/\bagent-fabric-deepseek-worker\b/.test(commandTemplate)) {
    throw new FabricError(
      "SENIOR_MODE_DEEPSEEK_IDENTITY_MISMATCH",
      `${commandName} in Senior mode with worker=deepseek-direct must launch agent-fabric-deepseek-worker so the lane is queue-visible and DeepSeek-backed.`,
      false
    );
  }
  if (worker === "jcode-deepseek" && !/\b(jcode|dispatch-deepseek|jcode-deepseek)\b/.test(commandTemplate)) {
    throw new FabricError(
      "SENIOR_MODE_DEEPSEEK_IDENTITY_MISMATCH",
      `${commandName} in Senior mode with worker=jcode-deepseek must launch the configured Jcode DeepSeek dispatcher, not a generic local harness.`,
      false
    );
  }
}

function assertSeniorModeDeepSeekBinaryCommand(commandLine: string, commandName: string): void {
  if (!seniorModePermissive(process.env) || seniorModeAllowsNonDeepSeekWorkers(process.env)) return;
  if (containsNonDeepSeekHarness(commandLine) || !/(^|\/|\s)agent-fabric-deepseek-worker(\s|$)/.test(commandLine)) {
    throw new FabricError(
      "SENIOR_MODE_DEEPSEEK_IDENTITY_MISMATCH",
      `${commandName} in Senior mode must launch agent-fabric-deepseek-worker for DeepSeek lanes; selected command=${commandLine}. Set ${SENIOR_ALLOW_NON_DEEPSEEK_WORKERS_ENV}=1 only for an explicit fallback.`,
      false
    );
  }
}

function containsNonDeepSeekHarness(commandLine: string): boolean {
  return /\b(codex|claude|claude-code|opencode|openhands|aider|ramicode)\b/i.test(commandLine);
}

function defaultSeniorWorker(flags: ParsedFlags, commandName: string): WorkerKind {
  const worker = parseWorker(flags.worker ?? (seniorModePermissive(process.env) ? seniorDefaultWorker(process.env) : "ramicode"));
  assertSeniorModeDeepSeekWorker(worker, commandName);
  return worker;
}

function defaultOptionalSeniorWorker(flags: ParsedFlags, commandName: string): WorkerKind | undefined {
  const worker = flags.worker ? parseWorker(flags.worker) : seniorModePermissive(process.env) ? seniorDefaultWorker(process.env) : undefined;
  assertSeniorModeDeepSeekWorker(worker, commandName);
  return worker;
}

function resolveOptionalSeniorWorker(worker: WorkerKind | undefined, commandName: string): WorkerKind | undefined {
  const resolved = worker ?? (seniorModePermissive(process.env) ? seniorDefaultWorker(process.env) : undefined);
  assertSeniorModeDeepSeekWorker(resolved, commandName);
  return resolved;
}

function seniorDefaultWorker(env: NodeJS.ProcessEnv): "deepseek-direct" | "jcode-deepseek" {
  const configured = env[SENIOR_DEFAULT_WORKER_ENV]?.trim();
  if (!configured) return SENIOR_DEFAULT_WORKER;
  if (configured === "deepseek-direct" || configured === "jcode-deepseek") return configured;
  throw new FabricError("INVALID_INPUT", `${SENIOR_DEFAULT_WORKER_ENV} must be deepseek-direct or jcode-deepseek`, false);
}

function defaultSeniorWorkspaceMode(flags: ParsedFlags, fallback: "in_place" | "git_worktree" | "clone" | "sandbox"): "in_place" | "git_worktree" | "clone" | "sandbox" {
  return parseWorkspaceMode(flags.workspaceMode ?? (seniorModePermissive(process.env) ? SENIOR_DEFAULT_WORKSPACE_MODE : fallback));
}

function defaultOptionalSeniorWorkspaceMode(flags: ParsedFlags): "in_place" | "git_worktree" | "clone" | "sandbox" | undefined {
  return flags.workspaceMode ? parseWorkspaceMode(flags.workspaceMode) : seniorModePermissive(process.env) ? SENIOR_DEFAULT_WORKSPACE_MODE : undefined;
}

function resolveOptionalSeniorWorkspaceMode(mode: "in_place" | "git_worktree" | "clone" | "sandbox" | undefined): "in_place" | "git_worktree" | "clone" | "sandbox" | undefined {
  return mode ?? (seniorModePermissive(process.env) ? SENIOR_DEFAULT_WORKSPACE_MODE : undefined);
}

function defaultSeniorModelProfile(flags: ParsedFlags, fallback: string): string {
  return flags.modelProfile ?? (seniorModePermissive(process.env) ? SENIOR_DEFAULT_MODEL_PROFILE : fallback);
}

function defaultOptionalSeniorModelProfile(flags: ParsedFlags): string | undefined {
  return flags.modelProfile ?? (seniorModePermissive(process.env) ? SENIOR_DEFAULT_MODEL_PROFILE : undefined);
}

function resolveOptionalSeniorModelProfile(modelProfile: string | undefined): string | undefined {
  return modelProfile ?? (seniorModePermissive(process.env) ? SENIOR_DEFAULT_MODEL_PROFILE : undefined);
}

function defaultSeniorLaneCount(fallback: number): number {
  if (!seniorModePermissive(process.env)) return fallback;
  return seniorDefaultLaneCount();
}

function defaultSeniorTaskPacketDir(queueId: string): string {
  return join(tmpdir(), "agent-fabric-factory", queueId, "task-packets");
}

function defaultSeniorCwdTemplate(queueId: string): string {
  return join(tmpdir(), "agent-fabric-factory", queueId, "worktrees", "{{queueTaskId}}");
}

function parsePacketFormat(value: string): "json" | "markdown" {
  if (["json", "markdown"].includes(value)) return value as "json" | "markdown";
  throw new FabricError("INVALID_INPUT", "format must be json or markdown", false);
}

function parsePolicyStatus(value: string): "approved" | "rejected" {
  if (["approved", "rejected"].includes(value)) return value as "approved" | "rejected";
  throw new FabricError("INVALID_INPUT", "status must be approved or rejected", false);
}

function parseToolDecision(value: string): "approve" | "reject" | "revise" {
  if (["approve", "reject", "revise"].includes(value)) return value as "approve" | "reject" | "revise";
  throw new FabricError("INVALID_INPUT", "decision must be approve, reject, or revise", false);
}

function parseMemoryReviewDecision(value: string): "approve" | "reject" | "archive" {
  if (["approve", "reject", "archive"].includes(value)) return value as "approve" | "reject" | "archive";
  throw new FabricError("INVALID_INPUT", "decision must be approve, reject, or archive", false);
}

function assertQueueRunnable(status: string): void {
  if (status === "running") return;
  if (status === "queue_review") {
    throw new FabricError("PROJECT_QUEUE_EXECUTION_BLOCKED", "Queue is waiting for start_execution before starting work", false);
  }
  throw new FabricError("PROJECT_QUEUE_EXECUTION_BLOCKED", `Queue is ${status}; record start_execution or resume before starting work`, false);
}

function parseRecoveryAction(value: string): "requeue" | "fail" {
  if (["requeue", "fail"].includes(value)) return value as "requeue" | "fail";
  throw new FabricError("INVALID_INPUT", "recovery-action must be requeue or fail", false);
}

export function defaultQueueTitle(projectPath: string): string {
  return `${basename(projectPath)} project queue`;
}
