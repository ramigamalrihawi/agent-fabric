# API — Project queue and tool/context MCP tools

This surface is the durable queue substrate for Agent Fabric Console. The desktop app should render and drive this state; `agent-fabric` remains the source of truth.

Raw prompts, secrets, large file bodies, and full context blobs are not stored in these tables. Store summaries, stage outputs, decisions, task metadata, grant records, checkpoints, and links to worker tasks.

Harnesses can use this API to run high-context parallel side lanes while keeping the primary session focused on integration. DeepSeek V4 Pro is one supported lane via `agent-fabric-deepseek-worker`, but the queue model is intentionally worker-neutral.

All mutating calls require the bridge/session idempotency key from ADR-0008.

## DeepSeek factory orchestration

The project queue is the control plane for factory-style parallel execution. A factory run should use the queue to hold the plan, task DAG, dependencies, tool/context grants, task packets, worker runs, checkpoints, patch artifacts, reviewer results, adjudication decisions, and final verification evidence.

Recommended factory flow:

1. Use DeepSeek V4 Pro max-reasoning as `AGENT_FABRIC_PROJECT_MODEL_COMMAND` for `improve-prompt` and `generate-tasks`.
2. Generate independent implementer tasks plus explicit reviewer, risk-reviewer, docs/test-reviewer, and adjudicator tasks for high-impact changes.
3. Run `review-matrix`, `prepare-ready`, and `launch-plan` before starting workers so expected-file overlaps, dependency blockers, and tool/context approval gaps are visible.
4. Record `decide-queue --decision start_execution` only after the queue shape is accepted.
5. Launch implementers with `run-ready --project <path> --worker deepseek-direct --workspace-mode git_worktree --parallel <n>` and prefer `--patch-mode write` for patch-producing work.
6. Feed concrete evidence to review lanes: task packets, structured worker results, patch files, command output, failing tests, and accepted constraints.
7. Apply only accepted write-mode patches through `review-patches --accept-task <queueTaskId> --apply-patch`.
8. Run local checks/tests and close with a handoff that lists lanes, costs if available, incorporated/deferred findings, and remaining limitations.

If the `agent-fabric-deepseek-worker` binary is not on PATH, use an explicit command template with the repo-local fallback, for example `npx tsx /path/to/agent-fabric/src/bin/deepseek-worker.ts run-task ...`.

The Codex/Claude-friendly shortcut is `senior-run`. It runs doctor-friendly defaults, imports task JSON or locally scaffolds from an MD plan, uses `.agent-fabric/task-packets`, `.agent-fabric/worktrees/<queueTaskId>`, and `.agent-fabric/progress.md`, and can issue one audited queue-scoped model approval:

```bash
npm run dev:project -- senior-run --project <path> --tasks-file .agent-fabric/tasks/tasks.json --count 10 --approve-model-calls --progress-file .agent-fabric/progress.md
```

Run `senior-doctor --project <path> [--queue <id>]` before launch. It checks daemon/source parity, required Senior bridge tools, DeepSeek auth, queue visibility, and whether the project can support mutating `git_worktree` lanes. A queue created from another harness workspace remains accessible when the caller's workspace root is the queue `projectPath`; use `agent-fabric-project --project <path> --queue <id>` for cross-harness resumes.

For non-git folders, report-only planner/reviewer work should use `sandbox` and the `research-planner` alias. Mutating implementation work still requires `git_worktree`.

The lower-level terminal shortcut for this control-plane flow is `factory-run`. It performs the queue preview reads (`review-matrix`, `prepare-ready`, `launch-plan`), optionally records `start_execution`, writes task packets, runs ready DeepSeek lanes in git worktrees, and defaults to adaptive rate-limit backoff:

```bash
npm run dev:project -- factory-run --queue <queueId> --start-execution --parallel 8 --min-parallel 1 --task-packet-dir .agent-fabric/task-packets --cwd-template ".agent-fabric/worktrees/{{queueTaskId}}" --approve-model-calls --approve-tool-context
```

Use `--dry-run` to inspect the factory plan without launching workers, `--no-adaptive-rate-limit` to keep fixed parallelism, `--sensitive-context-mode strict` for high-entropy packet scanning, `--allow-sensitive-context` to explicitly pass the DeepSeek worker's sensitive-context override, `--deepseek-role <role>` to force a homogeneous lane role, and `--deepseek-worker-command "<cmd>"` when the global worker binary is not installed.

CLI JSON output redacts approval/session token fields before printing. Approval tokens remain process-local plumbing between `--approve-model-calls` and the worker preflight, not operator-facing handoff material.

Run only one `factory-run` or broad `run-ready` scheduler against a queue at a time. The CLI creates a local per-queue runner lock by default; pass `--allow-concurrent-runner` only when overlapping schedulers are intentional. Queue assignment gates still reject duplicate worker assignment if another host bypasses the local lock.

When `AGENT_FABRIC_SENIOR_MODE=permissive` is set, queue-backed DeepSeek execution is the default and the guardrail:

- `claim-next`, `launch`, `run-ready`, and `run-task` default or validate execution workers as `deepseek-direct`.
- `run-ready` and `factory-run` default to 10 parallel lanes, git worktree paths under the local factory temp directory, and `deepseek-v4-pro:max`.
- Explicit `ramicode`, `local-cli`, `openhands`, `aider`, `smolagents`, or `manual` execution workers are rejected before tool calls or shell execution.
- Explicit Senior-mode command templates that record `deepseek-direct` or `jcode-deepseek` while launching Codex, Claude, or another local harness are rejected before shell execution.
- Use `AGENT_FABRIC_SENIOR_ALLOW_NON_DEEPSEEK_WORKERS=1` only for an explicit human-approved fallback.
- Do not launch Senior Jcode lanes with manual `nohup jcode ...`; use `run-ready --worker jcode-deepseek` or `senior-run` so Agent Fabric records heartbeats, timeout failures, patch artifacts, and review state.

The practical invariant is simple: a "Senior mode 10 DeepSeek lanes" request must create queue-backed worker runs that are visible through `lanes`, `dashboard`, worker checkpoints, and queue task state. Built-in side pools, unregistered background workers, or reports that never call the Agent Fabric queue are not valid substitutes.

## Pipeline model

Recommended stages:

1. `project_queue_create`
2. `project_queue_record_stage` for `prompt_improvement`
3. `project_queue_record_stage` for `planning` plus `plan_chain_*`
4. `project_queue_record_stage` for `phasing`
5. `project_queue_record_stage` for `task_writing`
6. `project_queue_add_tasks`
7. `project_queue_update_task_metadata` for human queue-review corrections
8. `project_queue_review_matrix` to inspect phase/risk/file/tool/context shape before approving parallel execution
9. `project_queue_decide` with `approve_queue` or `start_execution`
10. `project_queue_prepare_ready` and `project_queue_launch_plan` before worker launch
11. `tool_context_propose` before each worker
12. `tool_context_decide` when approval is required
13. `fabric_task_start_worker`, `project_queue_assign_worker`, and `fabric_task_*` events/checkpoints

The first terminal gateway for this flow is:

```bash
npm run dev:project -- create --project /path/to/project --prompt-file prompt.md
npm run dev:project -- configure --queue <queueId> --profile careful --max-agents 4
npm run dev:project -- improve-prompt --queue <queueId> --prompt-file prompt.md --output-file improved-prompt.md
npm run dev:project -- start-plan --queue <queueId> --task-file prompt.md
npm run dev:project -- generate-tasks --queue <queueId> --plan-file accepted-plan.md --tasks-file tasks.json
npm run dev:project -- review-queue --queue <queueId> --approve-queue
npm run dev:project -- decide-queue --queue <queueId> --decision start_execution
npm run dev:project -- decide-queue --queue <queueId> --decision pause --note "Hold workers before review"
npm run dev:project -- import-tasks --queue <queueId> --tasks-file tasks.json --approve-queue
npm run dev:project -- list --project /path/to/project
npm run dev:project -- approval-inbox --queue <queueId>
npm run dev:project -- memory-inbox --status pending_review
npm run dev:project -- review-memory <memoryId> --decision approve --reason "Reusable project fact"
npm run dev:project -- queue-approvals --queue <queueId>
npm run dev:project -- dashboard --queue <queueId>
npm run dev:project -- review-matrix --queue <queueId>
npm run dev:project -- task-detail --queue <queueId> --queue-task <queueTaskId> --include-resume
npm run dev:project -- timeline --queue <queueId> --limit 50
npm run dev:project -- lanes --queue <queueId>
npm run dev:project -- prepare-ready --queue <queueId> --limit 4
npm run dev:project -- launch-plan --queue <queueId> --limit 4
npm run dev:project -- claim-next --queue <queueId> --worker local-cli --workspace-mode git_worktree --workspace-path /path/to/worktree --model-profile execute.cheap
npm run dev:project -- recover-stale --queue <queueId> --stale-after-minutes 30 --dry-run
npm run dev:project -- cleanup-queues --project /path/to/project --older-than-days 7 --json
npm run dev:project -- cleanup-queues --project /path/to/project --older-than-days 7 --apply --json
npm run dev:project -- retry-task --queue <queueId> --queue-task <queueTaskId> --reason "Address review comments"
npm run dev:project -- edit-task --queue <queueId> --queue-task <queueTaskId> --metadata-file task-metadata.json
npm run dev:project -- write-task-packets --queue <queueId> --out-dir .agent-fabric/task-packets --format markdown --ready-only
npm run dev:project -- resume-task --queue <queueId> --queue-task <queueTaskId> --output-file resume.md
npm run dev:project -- launch --queue <queueId> --worker local-cli --workspace-mode git_worktree
npm run dev:project -- run-task --queue <queueId> --queue-task <queueTaskId> --command "npm test" --approve-tool-context
npm run dev:project -- run-ready --project <path> --queue <queueId> --parallel 4 --workspace-mode git_worktree --cwd-template ".agent-fabric/worktrees/{{queueTaskId}}" --task-packet-dir .agent-fabric/task-packets --command-template "local-cli run --fabric-task {{fabricTaskId}} --task-packet {{taskPacket}}" --approve-tool-context
npm run dev:project -- run-ready --project <path> --queue <queueId> --worker deepseek-direct --parallel 4 --workspace-mode git_worktree --cwd-template ".agent-fabric/worktrees/{{queueTaskId}}" --task-packet-dir .agent-fabric/task-packets --approve-tool-context
npm run dev:project -- factory-run --queue <queueId> --start-execution --parallel 8 --task-packet-dir .agent-fabric/task-packets --cwd-template ".agent-fabric/worktrees/{{queueTaskId}}" --approve-model-calls --approve-tool-context
npm run dev:project -- fabric-spawn-agents --queue <queueId> --count 10 --worker deepseek-direct --workspace-mode git_worktree
npm run dev:project -- fabric-list-agents --queue <queueId>
npm run dev:project -- fabric-open-agent --queue <queueId> --agent @af/rami-123abc
npm run dev:project -- fabric-message-agent --queue <queueId> --agent @af/rami-123abc --body "Please revise the patch scope."
npm run dev:project -- review-patches --queue <queueId>
npm run dev:project -- review-patches --queue <queueId> --accept-task <queueTaskId> --apply-patch
```

`launch` will skip tasks that need unapproved tool/context grants and print the proposal id. Approve a grant with:

```bash
npm run dev:project -- approve-tool <proposalId> --remember
npm run dev:project -- decide-tool <proposalId> --decision reject --remember --note "Not needed for this project"
npm run dev:project -- set-tool-policy --project /path/to/project --kind mcp_server --value github --status rejected
```

Model-backed `improve-prompt` and `generate-tasks` use the project model runner command:

```bash
AGENT_FABRIC_PROJECT_MODEL_COMMAND=/path/to/model-runner npm run dev:project -- improve-prompt --queue <queueId> --prompt-file prompt.md
```

DeepSeek direct can be used as the project model command:

```bash
export AGENT_FABRIC_PROJECT_MODEL_COMMAND="agent-fabric-deepseek-worker model-command --model deepseek-v4-pro --reasoning-effort max"
npm run dev:project -- generate-tasks --queue <queueId> --plan-file accepted-plan.md --tasks-file tasks.json
```

The command receives JSON on stdin:

```ts
{
  kind: "prompt_improvement" | "task_generation";
  modelAlias: string;
  route: { provider: string; model: string; reasoning: string };
  queue: Record<string, unknown>;
  input: Record<string, unknown>;
}
```

For `prompt_improvement`, it must return:

```ts
{
  improvedPrompt: string;
  summary?: string;
  warnings?: string[];
}
```

For `task_generation`, it must return:

```ts
{
  phases?: unknown[];
  tasks: Array<{
    clientKey?: string;
    title: string;
	    goal: string;
	    phase?: string;
	    managerId?: string;
	    parentManagerId?: string;
	    parentQueueId?: string;
	    workstream?: string;
	    costCenter?: string;
	    escalationTarget?: string;
	    category?: string;
    priority?: "low" | "normal" | "high" | "urgent";
    risk?: "low" | "medium" | "high" | "breakglass";
    parallelSafe?: boolean;
    expectedFiles?: string[];
    acceptanceCriteria?: string[];
    requiredTools?: string[];
    requiredMcpServers?: string[];
    requiredMemories?: string[];
    requiredContextRefs?: string[];
    dependsOn?: string[];
  }>;
}
```

High-risk aliases still go through `llm_preflight`. If the command reports `needs_user_approval`, approve with `agent-fabric-approve` and rerun with `--approval-token <token>`.

`run-task` wraps an explicit local command for one queue task. It proposes a `shell` tool/context grant plus the task's required MCP servers, tools, memories, and context refs; without existing grants, pass `--approve-tool-context` for a one-shot human-approved run, and optionally `--remember-tool-context` to save those grants for the project. If a task packet already exists, pass `--task-packet <path>` so the worker run and events retain a durable handoff reference. During execution it records:

- `fabric_task_event` `command_started`
- `fabric_task_event` `command_spawned` with process evidence such as pid
- `fabric_task_event` `command_finished`
- `fabric_task_event` `file_changed` for filesystem-detected changes
- `fabric_task_event` `test_result` when the command looks like a test command
- `fabric_task_checkpoint`
- final `patch_ready`, `completed`, or `failed` task state

`run-ready` pulls dependency-free ready tasks and calls the same command wrapper for each one. `--parallel <n>` runs batches concurrently. When `--parallel` is greater than 1, tasks must resolve to distinct working directories unless `--allow-shared-cwd` is passed explicitly. With `--workspace-mode sandbox`, the runner creates missing `cwd-template` directories before starting each task. With `git_worktree`, auto prep creates a detached worktree from the queue project when the path is missing and refuses non-git projects or invalid existing paths. Override with `--cwd-prep none` for externally managed paths, or `--cwd-prep mkdir` for explicit sandbox-style directory creation.

Pass `--adaptive-rate-limit` to reduce later batch parallelism when failed DeepSeek lanes include structured or textual 429/rate-limit evidence. Use `--min-parallel <n>` to set the lower bound. This does not retry already-failed queue tasks automatically; use `retry-task` after review when a lane should be requeued.

With `--worker deepseek-direct`, `run-ready` defaults to `agent-fabric-deepseek-worker run-task --task-packet {{taskPacket}} --context-file {{contextFile}} --fabric-task {{fabricTaskId}} --role implementer`, so `--task-packet-dir` is required unless an explicit `--command-template` is supplied. Custom templates that invoke `agent-fabric-deepseek-worker` are automatically linked with `--fabric-task {{fabricTaskId}}` when omitted. For each generated packet, the CLI also writes Markdown frontmatter plus `<queueTaskId>.context.md` with bounded local contents from `expectedFiles` and file-like `requiredContextRefs`; unsupported, missing, large, binary, outside-project, or secret-looking paths are listed as omitted. Missing file-like `requiredContextRefs` block launch and mark affected ready tasks `blocked`. The default DeepSeek task mode is report-only: structured worker results can include a proposed patch, but no files are edited unless an explicit command template passes `--patch-mode apply`. Commands that invoke `agent-fabric-deepseek-worker` get an `llm_preflight` gate before the shell command runs; pass `--approval-token <token>` after approving the model-call request when the route is high risk.

To collect proposed patches for human review without editing the worktree, override the command template with `--patch-mode write`:

```bash
npm run dev:project -- run-ready --queue <queueId> --worker deepseek-direct --parallel 4 --cwd-template "/path/to/worktrees/{{queueTaskId}}" --task-packet-dir task-packets --command-template "agent-fabric-deepseek-worker run-task --task-packet {{taskPacket}} --context-file {{contextFile}} --fabric-task {{fabricTaskId}} --role implementer --patch-mode write" --approve-tool-context
```

To apply after review, prefer the queue gate:

```bash
npm run dev:project -- review-patches --queue <queueId> --accept-task <queueTaskId> --apply-patch
```

The apply gate requires the queue task to be `patch_ready`, `review`, or already `accepted`, plus a prior `--patch-mode write` artifact. It validates the patch, requires the patch file to be inside the apply cwd, runs a dry-run first, applies with the system `patch` tool, records a checkpoint/event, marks the linked fabric task completed, and then accepts the queue task. `--apply-cwd <path>` overrides the default apply cwd, which is the worker run workspace.

`prepare-ready` creates or reuses tool/context proposals for the next schedulable tasks without claiming them. Use it before `launch` so the approval inbox is populated while the human is still reviewing the queue. `claim-next`, `launch`, and `run-task` require an explicit `decide-queue --decision start_execution` or `resume` decision first.

`project_queue_launch_plan` is the read-only companion for Desktop and launchers. It does not create proposals or claim tasks; it only classifies the next schedulable tasks as launchable, waiting for the start gate, waiting for tool/context approval, missing a linked fabric task, or blocked by missing context refs.

Use `project_queue_validate_links` and `project_queue_validate_context_refs` before custom launchers start shells. `project_queue_validate_context_refs` accepts `markBlocked: true` to move affected ready tasks to `blocked` with a `context_ref_missing` summary. Repair moved files with `edit-task --rewrite-context-ref old=new` or the corresponding `rewriteContextRefs` API field.

`write-task-packets` writes one worker handoff file per queue task. Use `--format json` for machine workers and `--format markdown` for manual or chat-style handoff. Add `--ready-only` to emit packets only for dependency-free ready tasks.

`run-ready` can also write task packets immediately before each worker command with `--task-packet-dir <dir>` and `--task-packet-format json|markdown`. Use `--command-template` and `--cwd-template` with placeholders:

- `{{queueTaskId}}`
- `{{fabricTaskId}}`
- `{{title}}`
- `{{goal}}`
- `{{projectPath}}`
- `{{taskPacket}}` for command templates only; requires `--task-packet-dir`
- `{{deepseekRole}}` for command templates; exact task categories named `planner`, `implementer`, `reviewer`, `risk-reviewer`, or `adjudicator` win first, then category/phase/title heuristics are used

Command-template values are shell-quoted before substitution. Cwd-template values are substituted as raw path components. Without `--command-template`, the runner uses the worker default command where one exists.

Packet JSON has schema `agent-fabric.task-packet.v1` and includes queue metadata, the full queue task record, context file path, and operator instructions. The Markdown format carries machine-readable frontmatter (`queueId`, `queueTaskId`, `fabricTaskId`, `projectPath`, `contextFilePath`) plus the task goal, metadata, expected files, acceptance criteria, and execution rules in a human-readable form. When `run-ready` creates a packet, each run result includes `taskPacketPath`, `taskPacketFormat`, and context file data for UI links and supervisor review.

`resume-task` builds a recovery handoff for one queue task from the latest worker run/checkpoint. Use it after reloads, crashes, interrupted workers, or manual handoff:

```bash
npm run dev:project -- resume-task --queue <queueId> --queue-task <queueTaskId> --worker local-cli --output-file resume.md
```

The JSON packet schema is `agent-fabric.queue-resume-packet.v1`.

## `project_queue_create`

Create one project-scoped queue keyed by project folder.

```ts
{
  projectPath: string;
  prompt?: string;          // accepted for caller convenience; raw prompt is not stored
  promptSummary?: string;   // preferred stored summary
  title?: string;
  pipelineProfile?: "fast" | "balanced" | "careful" | "custom";
  maxParallelAgents?: number; // default 4, configurable range 1-1000
  planChainId?: string;
}
```

Returns:

```ts
{
  queueId: string;
  status: "created";
  projectPath: string;
  title: string;
  pipelineProfile: string;
  maxParallelAgents: number;
  rawPromptStored: false;
}
```

## `project_queue_status`

Read queue metadata, stage history, task list, human decisions, tool/context proposals, and remembered project-level tool/context policies.

```ts
{ queueId: string }
```

## `project_queue_update_settings`

Update mutable queue-level settings after creation. This is the substrate for Desktop controls that change the visible title, pipeline profile, or project worker concurrency without recreating the queue or touching task state.

```ts
{
  queueId: string;
  title?: string;
  pipelineProfile?: "fast" | "balanced" | "careful" | "custom";
  maxParallelAgents?: number; // configurable range 1-1000
  note?: string;
}
```

At least one setting is required. Lowering `maxParallelAgents` below the current active worker count is allowed; the scheduler simply returns no additional slots until active workers drop below the new cap.

Returns:

```ts
{
  queue: unknown;
}
```

## `project_queue_dashboard`

Read the combined Agent Fabric Console detail view model for one queue. It includes queue metadata, status counts, a compact `summaryStrip`, pipeline stages, queue board columns, pending tool/context approvals, remembered project policy, read-only memory suggestions for ready tasks, and agent lanes.

```ts
{
  queueId: string;
  includeCompletedLanes?: boolean;
  maxEventsPerLane?: number;
}
```

Use this as the first Desktop detail-screen call. Use the narrower tools when a panel needs targeted refresh.

`summaryStrip` is intended for the always-visible command-center status bar. It includes:

- `status`, `severity`, `nextAction`, and machine-readable `reasons`.
- compact counts for ready/running/blocked/review/done/failed work, stale running tasks, approvals, active workers, and slots.
- risk summary: highest open risk, high-risk open count, breakglass open count, and risk counts by queue state.
- model-cost summary from queue-scoped `llm_preflight` rows and worker events: preflight count, estimated cost, aggregates by decision/risk, worker cost by senior/manager/worker role when available, and warnings for missing worker cost coverage.

`project_queue_progress_report` also returns a bounded `managerSummary` for senior and phase-manager harnesses. It groups tasks by status, manager, phase, and workstream, highlights blocked, patch-ready, failed, approval-needed, escalation-needed, and evidence-bearing items, and leaves raw worker events behind the lane/task detail tools.

`memorySuggestions` is advisory. It surfaces active memories whose intent keys match ready task metadata, but it does not attach memory automatically. The user should explicitly update task `requiredMemories` and approve any resulting tool/context grant.

## `project_queue_task_detail`

Read the task drawer/detail model for one queue task. This is the focused Desktop call after a user clicks a task card.

```ts
{
  queueId: string;
  queueTaskId: string;
  includeResume?: boolean; // include a recovery packet from fabric_task_resume
  preferredWorker?: "ramicode" | "local-cli" | "openhands" | "aider" | "smolagents" | "codex-app-server" | "deepseek-direct" | "jcode-deepseek" | "manual";
  maxEventsPerRun?: number; // default 10, max 50
  maxModelApprovals?: number; // default 25, max 200
}
```

Returns:

```ts
{
  queue: unknown;
  task: unknown;
  graph: {
    dependencies: Array<{
      queueTaskId: string;
      title?: string;
      status?: string;
      satisfied: boolean;
      missing?: boolean;
    }>;
    dependents: Array<{
      queueTaskId: string;
      title?: string;
      status?: string;
      unblockedByCurrentTask: boolean;
    }>;
  };
  readiness: {
    readyNow: boolean;
    state: "ready" | "blocked" | "scheduler_blocked" | "execution_blocked" | "worker_start_blocked" | string;
    reasons: string[];
    dependenciesReady: boolean;
    executionBlocked?: boolean;
    blockedReason?: string;
    workerStartBlocked?: boolean;
    workerStartBlockedReason?: string;
    blockers?: unknown[];
  };
  workerRuns: Array<{
    workerRun: unknown;
    latestEvent?: unknown;
    recentEvents: unknown[];
    latestCheckpoint?: unknown;
    progress: unknown;
  }>;
  toolContextProposals: unknown[];
  modelApprovals: unknown[];
  memorySuggestions: Array<{
    memoryRef: string;
    memory: unknown;
    matchedIntentKeys: string[];
    score: number;
    approvalRequired: true;
    attachByUpdating: {
      tool: "project_queue_update_task_metadata";
      field: "requiredMemories";
      value: string;
    };
  }>;
  resume?: {
    fabricResume: unknown;
    taskPacket: {
      schema: "agent-fabric.queue-resume-packet.v1";
      queue: unknown;
      task: unknown;
      fabricResume: unknown;
      requiredTools: unknown[];
      requiredMcpServers: unknown[];
      requiredMemories: unknown[];
      requiredContextRefs: unknown[];
      operatorInstructions: string[];
    };
  };
}
```

Use `project_queue_dashboard` for the whole board, `project_queue_review_matrix` for the human queue-shaping review gate, `project_queue_task_detail` for one expanded task, and `project_queue_timeline` for theater/activity feeds.

## `project_queue_review_matrix`

Read the queue-shaping matrix used before humans approve parallel work. This is read-only and does not create tool/context proposals or claim tasks.

```ts
{
  queueId: string;
  limit?: number; // defaults to queue max parallel agents, capped by available slots
}
```

Returns:

```ts
{
  queue: unknown;
  counts: Record<string, number>;
  summary: {
    totalTasks: number;
    openTasks: number;
    readyDependencyFree: number;
    blockedByDependencies: number;
    schedulerBlocked: number;
    scheduledPreview: number;
    launchable: number;
    waitingForStart: number;
    approvalRequired: number;
    pendingToolContextApprovals: number;
    tasksRequiringContext: number;
    tasksNeedingToolContextApproval: number;
    tasksNeedingToolContextProposal: number;
    tasksWithApprovedToolContextProposal: number;
    uniqueRequiredGrants: number;
    requiredGrantRefs: number;
    fileScopes: number;
    overlappingFileScopes: number;
    dependencyEdges: number;
    rootTasks: number;
    leafTasks: number;
  };
  buckets: {
    status: unknown[];
    phase: unknown[];
    category: unknown[];
    risk: unknown[];
    priority: unknown[];
    parallelGroup: unknown[];
  };
  dependencies: {
    edgeCount: number;
    edges: unknown[];
    rootTasks: unknown[];
    leafTasks: unknown[];
    blockedTasks: unknown[];
  };
  parallelism: {
    activeWorkers: number;
    availableSlots: number;
    maxParallelAgents: number;
    workerStartBlocked: boolean;
    workerStartBlockedReason?: string;
    serialTasks: unknown[];
    parallelSafeTasks: unknown[];
    scheduledPreview: {
      launchable: unknown[];
      waitingForStart: unknown[];
      approvalRequired: unknown[];
      blocked: unknown[];
    };
  };
  fileScopes: unknown[];
  toolContext: {
    grants: unknown[];
    tasks: unknown[];
    pendingApprovals: unknown[];
  };
  tasks: unknown[];
  executionBlocked: boolean;
  blockedReason?: string;
}
```

Use this view to check whether a generated queue is truly parallel-safe before `start_execution`: duplicate expected-file scopes, serial tasks, high-risk buckets, blocked dependencies, missing grants, rejected project policies, and pending approval proposals are all visible from one response.

## `project_queue_timeline`

Read an ordered queue feed for Agent Fabric Console theater mode, terminal monitoring, and lightweight activity panels.

The timeline combines:

- pipeline stage records
- human queue decisions
- tool/context proposals and decisions
- model-call approval requests
- worker lifecycle events joined to queue task and worker metadata

```ts
{
  queueId: string;
  limit?: number; // default 100, max 200
}
```

Returns:

```ts
{
  queue: unknown;
  count: number;
  items: Array<{
    timelineId: string;
    source: "pipeline_stage" | "human_decision" | "tool_context" | "model_approval" | "worker_event";
    kind: string;
    timestamp: string;
    title: string;
    summary?: string;
    severity: "info" | "attention" | "warning";
    queueTaskId?: string;
    queueTaskTitle?: string;
    workerRunId?: string;
    data: unknown;
  }>;
}
```

## `project_queue_approval_inbox`

Read one queue-scoped approval inbox that combines:

- tool/context proposals from `tool_context_proposals`
- model-call approvals from `llm_preflight` / `approval_requests`

```ts
{
  queueId: string;
  includeExpired?: boolean;
  limit?: number;
}
```

Model-call approvals are associated by `budgetScope: "project_queue:<queueId>"` or a preflight task payload containing the queue id. This is the preferred Desktop approval panel source because it lets one human gateway approve MCP/tool/memory/context grants and expensive model routes from the same queue view.

## `project_queue_resume_task`

Build a queue-level resume packet for one task by combining queue metadata, queue task requirements, and `fabric_task_resume`.

```ts
{
  queueId: string;
  queueTaskId: string;
  preferredWorker?: "ramicode" | "local-cli" | "openhands" | "aider" | "smolagents" | "codex-app-server" | "deepseek-direct" | "jcode-deepseek" | "manual";
}
```

Returns:

```ts
{
  queue: unknown;
  queueTask: unknown;
  fabricResume: {
    taskId: string;
    projectPath: string;
    workspacePath?: string;
    modelProfile?: string;
    contextPolicy?: string;
    resumePrompt: string;
    latestCheckpoint?: unknown;
  };
  taskPacket: {
    schema: "agent-fabric.queue-resume-packet.v1";
    queue: unknown;
    task: unknown;
    fabricResume: unknown;
    requiredTools: unknown[];
    requiredMcpServers: unknown[];
    requiredMemories: unknown[];
    requiredContextRefs: unknown[];
    operatorInstructions: string[];
  };
}
```

## `project_queue_list`

List queues for the Desktop project sidebar or terminal overview. Closed queues are hidden unless `includeClosed` is true or explicit statuses are supplied.

```ts
{
  projectPath?: string;
  statuses?: Array<"created" | "prompt_review" | "planning" | "plan_review" | "queue_review" | "running" | "paused" | "completed" | "canceled">;
  includeClosed?: boolean;
  limit?: number; // default 50, max 200
}
```

Each row includes queue metadata, task status counts, active worker count, available slots, ready/blocked counts, pending approval count, and policy counts.

## `project_queue_cleanup`

Dry-run or apply cleanup for finished project queues. This first retention pass is database-only: it deletes eligible completed/canceled queue rows and their queue-owned rows through foreign-key cascades. It does not remove filesystem worktrees, task packets, logs, or patch artifacts.

Dry-run is the default. Active, paused, review, running, patch-ready, and other non-finished queues are protected even when a `queueId` is supplied.

```ts
{
  queueId?: string;
  projectPath?: string;
  statuses?: Array<"completed" | "canceled">; // default ["completed", "canceled"]
  olderThanDays?: number; // default 7; use 0 for immediate cleanup
  limit?: number; // default 50, max 200
  dryRun?: boolean; // default true
  deleteLinkedTaskHistory?: boolean; // default false
}
```

By default, cleanup preserves linked `tasks`, `worker_runs`, `worker_events`, and `worker_checkpoints` so completed worker evidence remains available after the queue shell is removed. Set `deleteLinkedTaskHistory` only for an intentional deeper compaction pass after review; that removes linked worker history as well.

The response includes `candidateCount` or `cleanedCount`, `protectedCount`, per-queue counts, `estimatedDeletedRows`, and `retainedLinkedTaskHistoryRows`.

## `project_queue_record_stage`

Append a pipeline stage result.

```ts
{
  queueId: string;
  stage: "prompt_improvement" | "planning" | "phasing" | "task_writing" | "queue_shaping" | "tool_context" | "execution" | "review" | "decision";
  status: "pending" | "running" | "completed" | "needs_review" | "accepted" | "rejected" | "failed" | "skipped";
  modelAlias?: string;
  inputSummary?: string;
  outputSummary?: string;
  planChainId?: string; // when stage is planning
  artifacts?: unknown[];
  warnings?: string[];
}
```

## `project_queue_add_tasks`

Add concrete coding tasks. Each queue task is linked to a durable `fabric_task_*` task.

`clientKey` lets one batch refer to other new tasks in `dependsOn` without knowing generated IDs.

Tool/context requirements are separated so approval policy can make precise decisions:

- `requiredTools` for tool names exposed to the worker.
- `requiredMcpServers` for MCP servers that may need enabling.
- `requiredMemories` for memory ids or memory selectors to attach.
- `requiredContextRefs` for context bundles, files, or sanitized package refs.

```ts
{
  queueId: string;
  tasks: Array<{
    clientKey?: string;
    title: string;
    goal: string;
    phase?: string;
    manager?: string;
    managerId?: string;
    parentManagerId?: string;
    parentQueueId?: string;
    workstream?: string;
    costCenter?: string;
    escalationTarget?: string;
    category?: string;
    status?: "queued" | "ready" | "running" | "blocked" | "review" | "patch_ready" | "completed" | "failed" | "canceled" | "accepted" | "done";
    priority?: "low" | "normal" | "high" | "urgent";
    parallelGroup?: string;
    parallelSafe?: boolean;
    risk?: "low" | "medium" | "high" | "breakglass";
    expectedFiles?: string[];
    acceptanceCriteria?: string[];
    requiredTools?: string[];
    requiredMcpServers?: string[];
    requiredMemories?: string[];
    requiredContextRefs?: string[];
    dependsOn?: string[]; // queue task IDs or batch clientKeys
  }>;
}
```

Returns generated `queueTaskId` and linked `fabricTaskId` per task.

## `project_queue_next_ready`

Return tasks that can be safely started now, capped by available project concurrency slots. Only tasks currently in `running` consume worker slots; `patch_ready` and `review` wait for human review without blocking new worker starts.

Readiness applies four gates:

- Dependencies must be completed, accepted, or done.
- A task with `parallelSafe: false` runs alone; it waits for active workers, and if selected it is the only ready task returned.
- Tasks with the same `parallelGroup` are not returned together.
- Tasks whose `parallelGroup` is already active are blocked until that group clears.
- `breakglass` tasks run alone.
- At most one `high` or `breakglass` task can be running or selected at a time.
- Queues in `paused`, `canceled`, or `completed` status return no ready work and include `executionBlocked` plus `blockedReason`.
- Queues still waiting at human gates such as `queue_review` may return scheduler-ready tasks for planning, but also include `workerStartBlocked` so callers know workers cannot claim them yet.

```ts
{
  queueId: string;
  limit?: number;
}
```

The response includes `workerStartBlocked` and `workerStartBlockedReason` alongside the ready and blocked lists.

Blocked entries include both display reasons and structured dependency metadata:

```ts
{
  task: unknown;
  reasons: string[];
  blockers: Array<{
    queueTaskId: string;
    fabricTaskId?: string;
    title?: string;
    status?: string;
    phase?: string;
    risk?: string;
    missing?: boolean;
  }>;
}
```

## `project_queue_prepare_ready`

Create or reuse tool/context proposals for the next schedulable ready tasks without claiming them. This lets Agent Fabric Console show the approval inbox before launching `N` workers and is allowed while a queue is still in review.

```ts
{
  queueId: string;
  limit?: number;
}
```

The scheduler and execution gates are identical to `project_queue_next_ready`. Tasks with no required tool/context bundle return `noContextRequired: true`. Tasks with required MCP servers, tools, memories, or context refs include a `toolContextProposal`; if a matching proposal is already open, it is reused instead of creating duplicates.

`prepare_ready` is allowed during queue review, but worker start still requires `project_queue_decide` with `start_execution` or `resume`. Use `workerStartBlocked`, `readyToLaunch`, and `waitingForStart` to distinguish "approval bundle is ready" from "workers may actually claim this task now."

Returns:

```ts
{
  queueId: string;
  activeWorkers: number;
  availableSlots: number;
  executionBlocked?: boolean;
  blockedReason?: string;
  workerStartBlocked: boolean;
  workerStartBlockedReason?: string;
  prepared: Array<{
    task: unknown;
    toolContextProposal?: unknown;
    approvalRequired: boolean;
    readyToClaim: boolean;
    readyToLaunch: boolean;
    launchBlockedReason?: string;
    noContextRequired: boolean;
    reusedProposal: boolean;
    missingGrants: unknown[];
    memorySuggestions: unknown[];
  }>;
  blocked: unknown[];
  summary: {
    readyToClaim: number;
    readyToLaunch: number;
    approvalRequired: number;
    noContextRequired: number;
    waitingForStart: number;
  };
}
```

## `project_queue_launch_plan`

Read a non-mutating launch plan for Desktop, IDE panels, or external launchers.

```ts
{
  queueId: string;
  limit?: number;
}
```

The scheduler is identical to `project_queue_next_ready`, but the response is grouped for launch decisions:

```ts
{
  queue: unknown;
  queueId: string;
  activeWorkers: number;
  availableSlots: number;
  executionBlocked: boolean;
  blockedReason?: string;
  workerStartBlocked: boolean;
  workerStartBlockedReason?: string;
  launchable: unknown[];
  waitingForStart: unknown[];
  approvalRequired: unknown[];
  blocked: unknown[];
  summary: {
    scheduled: number;
    launchable: number;
    waitingForStart: number;
    approvalRequired: number;
    needsProposal: number;
  };
}
```

Each grouped entry includes the formatted task, optional matching `toolContextProposal`, `missingGrants`, `needsProposal`, `readyToLaunch`, `workerStartBlocked`, `launchBlockedReason`, and advisory `memorySuggestions`.

## `project_queue_claim_next`

Atomically claim one dependency-free ready task for a worker gateway. This closes the race between reading `project_queue_next_ready` and later assigning a task when multiple agents, Desktop, terminal runners, or IDE panels are pulling from the same queue.

Worker start is a separate human gate from readiness. `project_queue_claim_next` and `project_queue_assign_worker` require the queue to be `running`; record `project_queue_decide` with `start_execution` after queue review, or `resume` after a pause. Queues in `queue_review`, `plan_review`, `prompt_review`, `planning`, `created`, `paused`, `canceled`, or `completed` do not claim or assign workers.

The claim uses the same scheduler as `project_queue_next_ready`: dependencies, project concurrency, serial tasks, `parallelGroup`, `high`, `breakglass`, and queue execution gates all apply. A successful claim marks the queue task `running` and consumes a project worker slot. If `workerRunId` is supplied, it is attached to the claimed queue task. If `worker` settings are supplied instead, the daemon first checks required MCP/tool/memory/context grants. Missing grants create a tool/context proposal and return `approvalRequired` without claiming the task. Once grants are approved or remembered in project policy, the daemon creates the durable `worker_runs` row in the same mutation and returns it.

Use `skipQueueTaskIds` when a launcher is trying to fill multiple worker slots and has already skipped a ready task because it needs approval. This lets the launcher ask for the next schedulable task without racing another worker gateway.

```ts
{
  queueId: string;
  workerRunId?: string;
  worker?: "ramicode" | "local-cli" | "openhands" | "aider" | "smolagents" | "codex-app-server" | "deepseek-direct" | "jcode-deepseek" | "manual";
  workspaceMode?: "in_place" | "git_worktree" | "clone" | "sandbox";
  workspacePath?: string;
  modelProfile?: string;
  contextPolicy?: string;
  maxRuntimeMinutes?: number;
  command?: string[];
  skipQueueTaskIds?: string[];
  metadata?: Record<string, unknown>;
}
```

Returns:

```ts
{
  queueId: string;
  claimed?: unknown; // formatted queue task
  approvalRequired?: boolean;
  toolContextProposal?: unknown;
  workerRun?: unknown; // when workerRunId or worker settings were supplied
  activeWorkers: number;
  availableSlots: number;
  blocked: Array<{ task: unknown; reasons: string[] }>;
}
```

## `project_queue_recover_stale`

Dry-run or recover running queue tasks whose worker run is no longer healthy. This is the queue-level crash/reload recovery control for Desktop, terminal runners, and external worker gateways.

A running queue task is considered stale when:

- It has no assigned worker run.
- Its assigned worker run is no longer `running`.
- Its worker heartbeat is older than `staleAfterMinutes`. `fabric_task_heartbeat`, `fabric_task_event`, and `fabric_task_checkpoint` refresh this liveness timestamp.
- Its worker exceeded `maxRuntimeMinutes`.

Use `dryRun: true` first for UI previews or terminal confirmation. With `action: "requeue"`, the queue task returns to `queued`, the linked fabric task returns to `created`, and the worker run is marked `stale`. With `action: "fail"`, the queue task and linked fabric task are marked failed, and the worker run is marked `stale`.

```ts
{
  queueId: string;
  staleAfterMinutes?: number; // default 30, range 1-1440
  action?: "requeue" | "fail"; // default requeue
  dryRun?: boolean;
}
```

Returns:

```ts
{
  queueId: string;
  staleAfterMinutes: number;
  action: "requeue" | "fail";
  dryRun: boolean;
  count: number;
  recovered: Array<{
    queueTask: unknown;
    queueTaskId: string;
    fabricTaskId?: string;
    workerRunId?: string;
    workerStatus?: string;
    workerStartedAt?: string;
    workerUpdatedAt?: string;
    workerMaxRuntimeMinutes?: number;
    reason: string;
  }>;
}
```

## `project_queue_retry_task`

Return one retryable queue task to `queued` for another worker attempt. This is the manual recovery control for failed, canceled, blocked, review, or patch-ready tasks after a human decides the work should be attempted again.

```ts
{
  queueId: string;
  queueTaskId: string;
  reason?: string;
  clearOutputs?: boolean; // default true; clears patchRefs/testRefs but leaves durable events/checkpoints intact
}
```

The previous assigned worker run is marked `stale`, the linked fabric task is reset to `created`, and the queue is reopened to `queue_review` when it had already been completed. Canceled queues reject retries until the user records a queue decision that reopens execution.

Returns:

```ts
{
  queue: unknown;
  task: unknown; // queued task
  previousStatus: string;
  previousWorkerRunId?: string;
  clearOutputs: boolean;
}
```

## `project_queue_agent_lanes`

Read the queue-to-worker lane model for Desktop, terminal dashboards, and theater mode. The response joins queue tasks to worker runs, recent worker events, and the latest checkpoint summary.

Completed, accepted, done, canceled, and completed-worker lanes are hidden by default so the view focuses on active and reviewable work. Pass `includeCompleted` for a full history.

```ts
{
  queueId: string;
  includeCompleted?: boolean;
  maxEventsPerLane?: number; // default 5, configurable max 500
}
```

Each lane includes:

- `queueTask`: full queue task metadata.
- `workerRun`: worker id, mode, workspace, model profile, command, and metadata.
- `recentEvents`: newest-first `fabric_task_event` rows.
- `latestCheckpoint`: newest checkpoint summary when available.
- `progress`: display-oriented status, label, last activity time, summary, next action, files touched, test refs, and patch refs.

## `project_queue_progress_report`

Read the compact Senior-mode progress packet for one queue. This is the default supervisor context for Codex, Claude Code, desktop, and plugin surfaces that need a high-level state summary without reading every worker transcript.

```ts
{
  queueId: string;
  maxEventsPerLane?: number; // default 5, configurable max 500
  managerSummaryLimit?: number; // default 10, max 100
}
```

Returns:

```ts
{
  schema: "agent-fabric.project-queue-progress.v1";
  queue: unknown;
  generatedAt: string;
  summary: {
    status: string;
    severity: "ok" | "attention" | "warning" | "error";
    nextAction: string;
    reasons: string[];
    counts: unknown;
    risk: unknown;
    cost: unknown; // includes by-role worker spend when reported
  };
  managerSummary: {
    bounded: true;
    maxItemsPerSection: number;
    totals: unknown;
    groups: {
      byStatus: unknown[];
      byManager: unknown[];
      byPhase: unknown[];
      byWorkstream: unknown[];
    };
    attention: unknown;
    evidence: unknown[];
  };
  workers: unknown; // project_queue_agent_lanes response
  blockers: unknown[];
  approvals: unknown;
  patchReadyTasks: unknown[];
  acceptedTasks: unknown[];
  failedTasks: unknown[];
  nextActions: unknown[];
  nextCommand?: string;
  verificationChecklist: string[];
}
```

Use `managerSummary` for phase-manager handoffs and root-senior review. Use `workers.lanes` or `project_queue_task_detail` only when the summary points to a specific lane that needs deeper inspection.

## `project_queue_assign_worker`

Mark a ready queue task as running and optionally attach the worker run that was created by `fabric_task_start_worker`.

This call enforces the same safety invariant as `project_queue_next_ready`: unmet dependencies, active serial tasks, serial tasks waiting behind active workers, active `parallelGroup` conflicts, risk-class conflicts, and duplicate worker assignment are rejected. It also enforces required tool/context approval. If the task needs unapproved MCP servers, tools, memories, or context refs, the call returns `assigned: false` with a `toolContextProposal` instead of marking the task running.

```ts
{
  queueId: string;
  queueTaskId: string;
  workerRunId?: string;
}
```

Returns:

```ts
{
  queueId: string;
  queueTaskId: string;
  fabricTaskId?: string;
  workerRunId?: string;
  status: string;
  assigned: boolean;
  approvalRequired: boolean;
  toolContextProposal?: unknown;
}
```

## `project_queue_update_task`

Update queue task state after worker progress, patch readiness, or completion.

```ts
{
  queueId: string;
  queueTaskId: string;
  status: "queued" | "ready" | "running" | "blocked" | "review" | "patch_ready" | "completed" | "failed" | "canceled" | "accepted" | "done";
  workerRunId?: string;
  summary?: string;
  patchRefs?: string[];
  testRefs?: string[];
}
```

Terminal statuses update the linked `tasks` row as well.

## `project_queue_update_task_metadata`

Edit generated queue-task metadata during human queue review before a worker claims the task.

```ts
{
  queueId: string;
  queueTaskId: string;
  title?: string;
  goal?: string;
  phase?: string;
  clearPhase?: boolean;
  manager?: string;
  managerId?: string;
  clearManager?: boolean;
  clearManagerId?: boolean;
  parentManagerId?: string;
  clearParentManagerId?: boolean;
  parentQueueId?: string;
  clearParentQueueId?: boolean;
  workstream?: string;
  clearWorkstream?: boolean;
  costCenter?: string;
  clearCostCenter?: boolean;
  escalationTarget?: string;
  clearEscalationTarget?: boolean;
  category?: string;
  priority?: "low" | "normal" | "high" | "urgent";
  parallelGroup?: string;
  clearParallelGroup?: boolean;
  parallelSafe?: boolean;
  risk?: "low" | "medium" | "high" | "breakglass";
  expectedFiles?: string[];
  acceptanceCriteria?: string[];
  requiredTools?: string[];
  requiredMcpServers?: string[];
  requiredMemories?: string[];
  requiredContextRefs?: string[];
  addRequiredTools?: string[];
  addRequiredMcpServers?: string[];
  addRequiredMemories?: string[];
  addRequiredContextRefs?: string[];
  removeRequiredTools?: string[];
  removeRequiredMcpServers?: string[];
  removeRequiredMemories?: string[];
  removeRequiredContextRefs?: string[];
  rewriteContextRefs?: string[]; // old=new entries for moved files
  dependsOn?: string[];
  note?: string;
}
```

This is the durable API behind the Desktop queue-review editor and the terminal `edit-task` command:

```bash
npm run dev:project -- edit-task --queue <queueId> --queue-task <queueTaskId> --metadata-file task-metadata.json --rewrite-context-ref old.md=new.md --note "Human queue review"
```

Edits are allowed only while the queue task is `queued`, `ready`, `blocked`, `review`, `patch_ready`, `failed`, or `canceled`. Running, completed, accepted, and done tasks are locked because workers or reviewers have already acted on the metadata. Dependency edits must point to tasks in the same queue and cannot introduce cycles. Title, goal, and priority updates are mirrored to the linked `tasks` row so worker handoff packets stay consistent. `requiredTools`, `requiredMcpServers`, `requiredMemories`, and `requiredContextRefs` replace the full generated bundle; `addRequired*` appends unique entries, `removeRequired*` removes specific entries, and `rewriteContextRefs` rewrites exact `old=new` context refs after files move. These patch fields are useful for toggling one tool/MCP server/memory/context ref or attaching/removing a single memory suggestion without rewriting the generated bundle. Changing any required tool/context bundle marks pending tool/context proposals for that task as `revision_requested`; run `project_queue_prepare_ready` again to create a fresh proposal for the new bundle.

Returns:

```ts
{
  queue: unknown;
  task: unknown;         // updated queue task
  previousTask: unknown; // previous queue task snapshot
  staleToolContextProposalIds: string[];
}
```

## `project_queue_decide`

Record a human gate decision.

```ts
{
  queueId: string;
  decision:
    | "accept_improved_prompt"
    | "request_prompt_revision"
    | "accept_plan"
    | "request_plan_revision"
    | "approve_queue"
    | "start_execution"
    | "pause"
    | "resume"
    | "cancel"
    | "complete";
  note?: string;
  metadata?: Record<string, unknown>;
}
```

`approve_queue` keeps the queue in human review. `start_execution` opens worker claims and assignment. `pause`, `cancel`, and `complete` close execution again; once recorded, `project_queue_next_ready` returns no ready work, `project_queue_claim_next` does not claim work, and `project_queue_assign_worker` rejects new assignments. Record `resume` to reopen a paused queue.

## `tool_context_propose`

Before a worker starts, propose the least-necessary bundle of MCP servers, tools, memories, context refs, and model alias.

```ts
{
  queueId: string;
  queueTaskId?: string;
  fabricTaskId?: string;
  mcpServers?: unknown[];
  tools?: unknown[];
  memories?: unknown[];
  contextRefs?: unknown[];
  modelAlias?: string;
  reasoning?: string;
  safetyWarnings?: string[];
  approvalRequired?: boolean;
}
```

Returns `approvalRequired` plus `missingGrants`. Each missing grant includes `policyStatus: "missing" | "rejected"` so UIs can distinguish first use from an explicit human disable. First use of any MCP server, tool, memory, or context ref requires approval unless a project policy already remembers the grant.

## `tool_context_decide`

Approve, reject, or request revision for a proposal. When `remember` is true, approved grants become reusable project policy and rejected grants are remembered as disabled for the project.

```ts
{
  proposalId: string;
  decision: "approve" | "reject" | "revise";
  note?: string;
  remember?: boolean;
}
```

## `tool_context_pending`

List pending approval proposals for a Desktop approval inbox or terminal prompt gateway.

```ts
{
  projectPath?: string;
  queueId?: string;
  limit?: number; // default 50, max 200
}
```

Each pending item includes the proposal, queue/project context, queue task title/status when available, missing grants, and safety warnings.

## `tool_context_policy_set`

Explicitly toggle one project-level grant without going through a proposal. This is the substrate for the Desktop MCP/tool switch UI.

```ts
{
  projectPath: string;
  grantKind: "mcp_server" | "tool" | "memory" | "context";
  value: unknown;
  status: "approved" | "rejected";
}
```

## `tool_context_policy_status`

List remembered project-level grants, including both approved and rejected toggles.

```ts
{
  projectPath?: string;
}
```

## Model aliases

Queue pipelines should use aliases rather than provider-specific names:

- `prompt.improve.strong`
- `plan.strong`
- `phase.splitter`
- `task.writer`
- `tool.context.manager`
- `execute.cheap`
- `review.strong`
