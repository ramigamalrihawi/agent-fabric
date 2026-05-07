# API — Worker/task MCP tools

This is the MCP/daemon surface for integrating Local CLI Direct, OpenHands, Aider, and other coding workers with `agent-fabric`.

The tools do not make `agent-fabric` a coding agent. They let the daemon own durable worker state while external workers do the coding.

For project-level prompt pipelines, dependency-aware queues, and tool/context approval before worker start, see [project-queue-tools.md](project-queue-tools.md).

For project-level DeepSeek V4 Pro usage, register each lane as a normal worker run and attach focused context files rather than dumping broad private workspace state.

All mutating calls require the bridge/session idempotency key from ADR-0008.

## DeepSeek factory lane setup

In Full Parallel DeepSeek Factory Mode, the worker surface records each DeepSeek lane as a normal durable worker run. The important split is role and evidence:

- `planner` lanes should produce prompt, plan, task-DAG, dependency, and acceptance-criteria guidance.
- `implementer` lanes should work in isolated sandbox or prepared worktree paths and return structured reports; patch-producing implementers should default to `--patch-mode write`.
- `reviewer`, `risk-reviewer`, and docs/test-reviewer lanes should receive evidence context files rather than broad raw repo dumps.
- `adjudicator` lanes should compare implementer/reviewer evidence and produce a decision plus the next queue action.

Every long-running lane should emit worker events, heartbeats, and checkpoints through `fabric_task_*`. Review lanes should never directly apply patches. Direct `--patch-mode apply` remains implementer-only and is intended for isolated worker directories; queue-driven factory runs should prefer write-mode patch artifacts plus `agent-fabric-project review-patches`.

`agent-fabric-deepseek-worker` scans task packets and context files for common secret patterns before API calls in normal mode. In Senior mode, set `AGENT_FABRIC_SENIOR_MODE=permissive`; task-relevant sensitive context is authorized for DeepSeek-direct workers by default. Use `--sensitive-context-mode strict` only when sanitized review packets should also catch high-entropy token candidates. Transient HTTP 429 and empty JSON content responses are retried up to three attempts; persistent rate limits emit structured error codes and should become queue retry/review checkpoints.

DeepSeek cost estimates use built-in defaults unless the runner provides `AGENT_FABRIC_DEEPSEEK_PRICING_JSON` or `AGENT_FABRIC_DEEPSEEK_PRICING_FILE` with per-million-token `hit`, `miss`, and `output` prices. Worker artifacts include the cost estimate source so stale pricing can be spotted during review.

Use the separate `jcode-deepseek` worker value when a queue task should run through a Jcode DeepSeek provider/runtime while staying inside Agent Fabric's durable worker lifecycle. The default path uses the bundled `agent-fabric-jcode-deepseek-worker` adapter and `JCODE_BIN`; `AGENT_FABRIC_JCODE_DEEPSEEK_DISPATCHER` is only a legacy/private override. See [../workers/jcode-deepseek/README.md](../workers/jcode-deepseek/README.md).

Senior-mode supervisors should not substitute untracked local worker pools for DeepSeek lanes. With `AGENT_FABRIC_SENIOR_MODE=permissive`, the project CLI validates execution workers before they can start, rejects DeepSeek-labeled command templates that launch Codex/Claude/local harnesses, and defaults broad work to queue-backed `deepseek-direct` lanes in git worktrees. A worker counts only after `fabric_task_start_worker`, `project_queue_assign_worker`, and `fabric_task_*` events/checkpoints make it visible in the queue.

Senior-mode `agent-fabric-deepseek-worker run-task` calls require queue visibility. Queue runners set `AGENT_FABRIC_WORKER_QUEUE_VISIBLE=1` and queue/task/run ids before launching the worker. A manual direct run with `AGENT_FABRIC_SENIOR_MODE=permissive` is rejected unless `TASK_DIR` auto-queue registration is active or `AGENT_FABRIC_DEEPSEEK_ALLOW_UNTRACKED=1` is set as an explicit human escape hatch. DeepSeek task packet generation writes a bounded `{{contextFile}}` sidecar from expected source/context files so direct DeepSeek workers can produce concrete diffs instead of filename-only guesses.

Codex and Claude Code integrations should prefer the compact worker-card tools when they want native-feeling background agents:

- `fabric_spawn_agents`
- `fabric_senior_start`
- `fabric_senior_status`
- `fabric_senior_resume`
- `fabric_list_agents`
- `fabric_open_agent`
- `fabric_message_agent`
- `fabric_wait_agents`
- `fabric_accept_patch`

These tools expose `@af/<name>` handles and openable worker cards while preserving Agent Fabric as the durable source of truth. `fabric_accept_patch` requires senior review metadata (`reviewedBy`, `reviewSummary`).

For high-scale Senior queues, `fabric_list_agents` supports `page`, `pageSize`, and `groupBy` (`status`, `phase`, `workstream`, `worker`, `risk`, or `category`). Worker cards include orchestration labels such as manager, parent manager, parent queue, workstream, cost center, escalation target, risk, and category when the queue task provides them. Native Codex, Claude Code, desktop, or plugin surfaces should page/group these Agent Fabric cards instead of mirroring unbounded transcript lists.

## `fabric_task_create`

Create a durable task before assigning it to any worker.

**Input:**

```ts
{
  title: string;
  goal: string;
  projectPath: string;
  priority?: "low" | "normal" | "high";
  refs?: string[];
  requestedBy?: string;
}
```

**Output:**

```ts
{
  taskId: string;
  status: "created";
}
```

## `fabric_task_start_worker`

Start or register a worker run.

**Input:**

```ts
{
  taskId: string;
  worker: "ramicode" | "local-cli" | "openhands" | "aider" | "smolagents" | "codex-app-server" | "deepseek-direct" | "jcode-deepseek" | "manual";
  projectPath: string;
  workspaceMode: "in_place" | "git_worktree" | "clone" | "sandbox";
  modelProfile: string;
  workspacePath?: string;
  contextPolicy?: string;
  maxRuntimeMinutes?: number;
  command?: string[];
  metadata?: Record<string, unknown>;
}
```

**Output:**

```ts
{
  workerRunId: string;
  taskId: string;
  status: "running";
  workspacePath: string;
}
```

## `fabric_task_event`

Append one worker event. This is the core write path for OpenHands/Local CLI workers.

**Input:**

```ts
{
  taskId: string;
  workerRunId: string;
  kind:
    | "started"
    | "thought_summary"
    | "file_changed"
    | "command_spawned"
    | "command_started"
    | "command_finished"
    | "test_result"
    | "checkpoint"
    | "patch_ready"
    | "failed"
    | "completed";
  body?: string;
  refs?: string[];
  metadata?: Record<string, unknown>;
  traceId?: string;
  costUsd?: number;
}
```

**Output:**

```ts
{
  eventId: string;
  taskId: string;
  workerRunId: string;
}
```

For `command_started` and `command_finished` events emitted by shell-backed workers (`run-task`, `run-ready`, `factory-run`, Senior lanes), the metadata SHOULD include:

```ts
{
  cwd: string;              // working directory
  pid?: number;             // process id of the spawned shell
  command?: string;         // the command line executed
  exitCode?: number;        // command exit code (command_finished only)
  durationMs?: number;      // elapsed wall-clock ms (command_finished only)
  stdoutTail?: string;      // bounded tail of stdout (command_finished only)
  stderrTail?: string;      // bounded tail of stderr (command_finished only)
  stdoutLogPath?: string;   // path to persisted stdout log file (command_finished only)
  stderrLogPath?: string;   // path to persisted stderr log file (command_finished only)
}
```

Log files are written under `.agent-fabric/logs/` in the worker workspace directory with the pattern `<queueTaskId>-<workerRunId>-stdout.log` and `<queueTaskId>-<workerRunId>-stderr.log`. Log file content is bounded to the same `maxOutputChars` limit as the in-memory tails and does not contain environment variable dumps or secret material. Log persistence is best-effort; consumers should gracefully handle missing log paths.

## `fabric_task_checkpoint`

Write a resumable checkpoint summary.

**Input:**

```ts
{
  taskId: string;
  workerRunId: string;
  summary: {
    currentGoal: string;
    filesTouched: string[];
    commandsRun: string[];
    testsRun: string[];
    failingTests?: string[];
    decisions: string[];
    assumptions: string[];
    blockers: string[];
    nextAction: string;
    rollbackNotes?: string[];
  };
}
```

**Output:**

```ts
{
  checkpointId: string;
  taskId: string;
}
```

Writing a checkpoint also refreshes the worker run heartbeat timestamp used by stale-worker recovery.

## `fabric_task_heartbeat`

Refresh worker-run liveness without adding a full lifecycle event. Long-running Local CLI, OpenHands, Aider, smolagents, or manual adapters should call this periodically between meaningful events/checkpoints so queue recovery does not mistake healthy work for a crashed worker.

**Input:**

```ts
{
  taskId: string;
  workerRunId: string;
  task?: string;
  progress?: number; // 0-1
  metadata?: Record<string, unknown>;
}
```

**Output:**

```ts
{
  taskId: string;
  workerRunId: string;
  status: string;
  ack: true;
  updatedAt: string;
}
```

## `fabric_task_status`

Read current task and worker state.

**Input:**

```ts
{
  taskId: string;
  includeEvents?: boolean;
  includeCheckpoints?: boolean;
}
```

**Output:**

```ts
{
  taskId: string;
  status: "created" | "running" | "blocked" | "patch_ready" | "completed" | "failed" | "canceled";
  title?: string;
  goal?: string;
  projectPath: string;
  workerRuns: unknown[];
  latestCheckpoint?: unknown;
  events?: unknown[];
  checkpoints?: unknown[];
}
```

`fabric_task_status` is read-only. It can include events and checkpoints when requested; queue views should leave both false.

## `fabric_task_tail`

Read a bounded recent tail of worker events and checkpoints without returning a full task/session dump.

**Input:**

```ts
{
  workerRunId?: string;
  taskId?: string;
  queueId?: string;
  queueTaskId?: string;
  maxLines?: number; // default 200, capped at 200
  maxBytes?: number; // default 65536, capped at 65536
}
```

Exactly one lookup mode must be supplied: `workerRunId`, `taskId`, or `queueId` plus `queueTaskId`.

**Output:**

```ts
{
  resolveMode: "workerRunId" | "taskId" | "queueId";
  taskId: string;
  workerRunId?: string;
  events: unknown[];
  checkpoints: unknown[];
  truncated: boolean;
  limits: { maxLines: number; maxBytes: number };
  eventCount: number;
  checkpointCount: number;
  totalEventCount: number;
  totalCheckpointCount: number;
}
```

`fabric_task_tail` is read-only. Rows are newest-first, line/byte bounded, workspace scoped, and structured metadata paths outside the caller workspace are redacted.

## `fabric_task_resume`

Return the smallest useful state needed for a worker to continue.

**Input:**

```ts
{
  taskId: string;
  preferredWorker?: "ramicode" | "local-cli" | "openhands" | "aider" | "smolagents" | "codex-app-server" | "deepseek-direct" | "jcode-deepseek" | "manual";
}
```

**Output:**

```ts
{
  taskId: string;
  projectPath: string;
  workspacePath?: string;
  modelProfile?: string;
  contextPolicy?: string;
  resumePrompt: string;
  latestCheckpoint?: unknown;
}
```

## `fabric_task_finish`

Mark a task as complete or failed.

**Input:**

```ts
{
  taskId: string;
  workerRunId?: string;
  status: "completed" | "failed" | "canceled";
  summary: string;
  patchRefs?: string[];
  testRefs?: string[];
  followups?: string[];
}
```

**Output:**

```ts
{
  taskId: string;
  status: "completed" | "failed" | "canceled";
}
```

## DeepSeek direct worker patch modes

`agent-fabric-deepseek-worker run-task` defaults to `--patch-mode report`. In this mode it writes the structured `agent-fabric.deepseek-worker-result.v1` artifact only; any `proposedPatch` stays inside the report.

Use `--patch-mode write` to validate a proposed git-style unified diff and write it beside the JSON artifact, or to a specific path with `--patch-file <path>`. This is the review-friendly mode: it does not edit the workspace.

Use `--patch-mode apply` only in an isolated worker directory. It is implementer-only and requires the worker report status to be `patch_ready`. It validates patch paths, writes the patch file, dry-runs the patch, then applies it with the system `patch -p1 -N -t -s -F 0` command. Patch paths must be plain relative git-style path tokens and cannot be absolute, use Windows drive/backslash forms, traverse with `..`, contain NUL bytes, target `.git`, use ambiguous whitespace/quoted path syntax, pass through symlinked path segments, or run from a symlinked cwd.

For queue-driven work, prefer `--patch-mode write` followed by `agent-fabric-project review-patches --accept-task <queueTaskId> --apply-patch`. That gate applies only reviewed write-mode patch artifacts and records the acceptance in fabric events/checkpoints.

## State ownership

- `tasks` is the durable task intake table. It is also used by collab asks; worker tasks use `kind: "worker_task"`.
- `worker_runs` records one external execution attempt.
- `worker_events` records lifecycle events from the worker adapter.
- `worker_checkpoints` records resumable summaries. The daemon stores summaries; it does not interpret or execute them.

Status transitions are intentionally conservative:

- `fabric_task_start_worker` moves the task to `running`.
- `fabric_task_event(kind: "patch_ready")` moves the task and run to `patch_ready`.
- `fabric_task_event(kind: "failed" | "completed")` moves both to the matching final status.
- `fabric_task_heartbeat` and `fabric_task_checkpoint` refresh worker liveness without changing status.
- `fabric_task_finish` is the explicit human/worker finalization path and can attach patch refs, test refs, and follow-ups.

## Default worker policy

| Worker | Default workspace mode | Why |
|---|---|---|
| VS Code client/manual | `in_place` | User is actively supervising in the real editor. |
| Local CLI Direct | `in_place` or `git_worktree` | Headless work can be direct for small tasks or isolated for larger tasks. |
| OpenHands | `git_worktree` | Keep the dirty main workspace safe and review patch results before merge. |
| Aider | `git_worktree` | Good patch worker; isolation avoids accidental dirty-state collisions. |
| smolagents | `sandbox` or read-only `in_place` | Lightweight Python worker for project mining, context inspection, memory-candidate extraction, and explicit pending-review memory writes; no file edits unless later sandboxed. |
| Codex App Server | `git_worktree` | External Codex App Server style runners can be supervised by the Elixir orchestrator while Agent Fabric records worker lifecycle, checkpoints, artifacts, and review state. |
| DeepSeek direct | `sandbox` or prepared `git_worktree` | Direct API implementer/reviewer/adjudicator reports should stay isolated and evidence-backed before integration; sandbox dirs can be auto-created, while git worktrees must be prepared outside this runner. |

## Initial DeepSeek direct adapter behavior

1. Use `agent-fabric-deepseek-worker model-command` for model-backed prompt improvement and task generation through `AGENT_FABRIC_PROJECT_MODEL_COMMAND`.
2. Use `agent-fabric-deepseek-worker run-task --task-packet <path> --fabric-task <id> --role implementer|reviewer|risk-reviewer|adjudicator` for task-packet lanes.
3. Require `DEEPSEEK_API_KEY` or `DEEPSEEK_TOKEN`.
4. Write `agent-fabric.deepseek-worker-result.v1` JSON artifacts with summary, proposed files, suggested commands/tests, risks, follow-ups, usage, and estimated cost.
5. Let `agent-fabric-project run-task` / `run-ready` capture those artifacts into worker checkpoints; actual executed test commands remain separate evidence.
6. Prefer `deepseek-v4-pro --reasoning-effort max` for high-quality sidecar planning/review; use `factory-run` for broad queue-driven work and one-off `run-task` lanes for focused review checkpoints.
7. Use queue preflight and artifacts so cost is visible instead of hidden inside the primary harness session.

## Initial OpenHands adapter behavior

1. Create or reuse a git worktree.
2. Start OpenHands against that worktree.
3. Stream major lifecycle events into `fabric_task_event`.
4. Send `fabric_task_heartbeat` while working and write periodic `fabric_task_checkpoint` summaries.
5. On patch readiness, record changed files, test results, and branch/worktree refs.
6. Let VS Code client review and merge; do not auto-merge by default.

## Initial Local CLI Direct adapter behavior

1. Register a task/session with `agent-fabric`.
2. Use selected model profile, e.g. `pc-heretic` or `heretic-runpod-h200`.
3. Before each long turn, read `fabric_task_resume`.
4. After tool/command/test milestones, write task events.
5. Send heartbeats while running long model/tool loops, and on context pressure write a checkpoint before condensing.
6. On crash/reload, resume from the latest checkpoint.

## Initial smolagents adapter behavior

1. Start read-only by default against a declared project path and output directory.
2. Call `llm_preflight` before any metered model call; fail closed for premium uncovered routes.
3. Stream scan/analyze/write-report milestones into `fabric_task_event`.
4. Send heartbeats and write checkpoints with scanned file counts, artifacts, and next action.
5. Write reports under the declared output directory only by default.
6. If `--write-pending-memories` is explicitly set, call `memory_write` only with `source=auto` and `derivation=session_transcript` so rows remain `pending_review`.
7. Do not run shell commands, load remote Hub tools, or edit project files in the initial adapter slice.
