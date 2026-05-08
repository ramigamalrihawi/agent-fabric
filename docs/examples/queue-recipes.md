# Queue Recipes

Copy-paste recipes for common Agent Fabric project-queue workflows. Every command
here matches the current CLI, tool names, and Senior-mode guardrails. Use
`senior-doctor --project <path>` before any Senior launch.

## Senior 20-Lane Execution

Full factory run with 20 parallel DeepSeek V4 Pro max-reasoning workers in
isolated git worktrees. Use this when a roadmap phase or broad refactor benefits
from parallel implementation, review, risk-review, and adjudication lanes.

### Prerequisites

```bash
# One-time: set local caps if you need more than the default 10
export AGENT_FABRIC_SENIOR_MAX_LANE_COUNT=100
# Optional: use Jcode runtime for implementation lanes
export AGENT_FABRIC_SENIOR_DEFAULT_WORKER=jcode-deepseek
# Required for Senior-mode enforcement
export AGENT_FABRIC_SENIOR_MODE=permissive
export DEEPSEEK_API_KEY="sk-..."
```

### Recipe

```bash
# 1. Preflight the project
agent-fabric-project senior-doctor --project /path/to/project

# 2. Dry-run to inspect queue shape without launching workers
agent-fabric-project senior-run \
  --dry-run \
  --project /path/to/project \
  --plan-file plan.md \
  --count 20

# 3. Launch 20 workers
agent-fabric-project senior-run \
  --project /path/to/project \
  --tasks-file .agent-fabric/tasks/tasks.json \
  --count 20 \
  --worker deepseek-direct \
  --approve-model-calls \
  --progress-file .agent-fabric/progress.md

# 4. Monitor progress
agent-fabric-project progress-report --queue <queueId>
# or via Codex/Claude bridge
fabric_senior_status --queue <queueId>
```

### Lower-Level Alternative

```bash
# Prepare and launch with factory-run
agent-fabric-project factory-run \
  --queue <queueId> \
  --start-execution \
  --parallel 20 \
  --task-packet-dir .agent-fabric/task-packets \
  --cwd-template ".agent-fabric/worktrees/{{queueTaskId}}" \
  --approve-model-calls \
  --approve-tool-context
```

### Scaling Notes

- Default parallelism is 10; explicit 20-lane requests are supported.
- Set `AGENT_FABRIC_SENIOR_DEFAULT_LANE_COUNT` only when the local default
  should intentionally exceed 10.
- Caps are configurable up to 1000 via `AGENT_FABRIC_SENIOR_MAX_LANE_COUNT`,
  `AGENT_FABRIC_MAX_PARALLEL_AGENTS`, `AGENT_FABRIC_MAX_CODEX_AGENT_COUNT`, or
  `AGENT_FABRIC_QUEUE_MAX_AGENTS`.
- Use `AGENT_FABRIC_SENIOR_DEFAULT_WORKER=jcode-deepseek` to route
  implementation lanes through Jcode by default.
- Never launch Senior lanes with manual `nohup jcode ...`. Use `senior-run` or
  `run-ready --worker jcode-deepseek` so heartbeats, timeout handling, and
  patch artifacts stay queue-visible.

---

## Review-Only Lanes

Launch report-only reviewer lanes that receive focused evidence context files
instead of broad raw repo dumps. Reviewers never edit files; they produce
structured findings for the senior harness to adjudicate.

### Prerequisites

```bash
export AGENT_FABRIC_SENIOR_MODE=permissive
export DEEPSEEK_API_KEY="sk-..."
```

### Recipe: Dedicated Review Lane

```bash
# Create a review task in the queue with explicit evidence context refs
agent-fabric-project run-ready \
  --project /path/to/project \
  --queue <queueId> \
  --worker deepseek-direct \
  --parallel 1 \
  --workspace-mode sandbox \
  --task-packet-dir .agent-fabric/task-packets \
  --command-template "agent-fabric-deepseek-worker run-task --task-packet {{taskPacket}} --context-file {{contextFile}} --fabric-task {{fabricTaskId}} --role reviewer" \
  --approve-tool-context
```

### Recipe: Code Reviewer + Risk Reviewer + Test Reviewer

```bash
# Launch three review lanes from a single launch plan
for role in reviewer risk-reviewer docs-test-reviewer; do
  agent-fabric-project run-ready \
    --project /path/to/project \
    --queue <queueId> \
    --worker deepseek-direct \
    --parallel 1 \
    --workspace-mode sandbox \
    --task-packet-dir .agent-fabric/task-packets \
    --command-template "agent-fabric-deepseek-worker run-task --task-packet {{taskPacket}} --context-file {{contextFile}} --fabric-task {{fabricTaskId}} --role ${role}" \
    --approve-tool-context
done
```

### Recipe: Research Planner (Non-Git Projects)

```bash
# For report-only planning/review when the target is not a Git checkout
agent-fabric-project run-ready \
  --project /path/to/non-git-folder \
  --queue <queueId> \
  --worker deepseek-direct \
  --parallel 1 \
  --workspace-mode sandbox \
  --task-packet-dir .agent-fabric/task-packets \
  --command-template "agent-fabric-deepseek-worker run-task --task-packet {{taskPacket}} --context-file {{contextFile}} --fabric-task {{fabricTaskId}} --role planner --reasoning-effort max" \
  --approve-tool-context
```

### Rules

- Review lanes must use `sandbox` or a non-mutating workspace.
- Use `research-planner` alias for report-only planner/reviewer routing.
- Patch mode defaults to `report`; reviewer lanes never apply patches.
- Adjudicator lanes compare implementer and reviewer evidence before the senior
  harness makes the final integration decision.

---

## Patch-Review Recipe

The review-gated patch pipeline: workers produce write-mode patches, the senior
harness or human reviews them, and only reviewed patches are applied through the
queue gate.

### Worker Side: Produce a Patch

```bash
# Implementer writes a patch artifact (does NOT edit workspace)
agent-fabric-deepseek-worker run-task \
  --task-packet .agent-fabric/task-packets/pqtask_abc123.md \
  --context-file .agent-fabric/task-packets/pqtask_abc123.context.md \
  --fabric-task task_abc123 \
  --role implementer \
  --patch-mode write
```

For queue-driven runs, use the command-template override:

```bash
agent-fabric-project run-ready \
  --queue <queueId> \
  --worker deepseek-direct \
  --parallel 4 \
  --workspace-mode git_worktree \
  --cwd-template ".agent-fabric/worktrees/{{queueTaskId}}" \
  --task-packet-dir .agent-fabric/task-packets \
  --command-template "agent-fabric-deepseek-worker run-task --task-packet {{taskPacket}} --context-file {{contextFile}} --fabric-task {{fabricTaskId}} --role implementer --patch-mode write" \
  --approve-tool-context
```

### Senior Side: Review Patches

```bash
# List patches pending review
agent-fabric-project review-patches --queue <queueId>

# Inspect one patch
agent-fabric-project task-detail \
  --queue <queueId> \
  --queue-task <queueTaskId> \
  --include-resume
```

### Senior Side: Accept and Apply

```bash
# Accept and apply a reviewed patch through the queue gate
agent-fabric-project review-patches \
  --queue <queueId> \
  --accept-task <queueTaskId> \
  --apply-patch
```

### Via Codex/Claude Bridge

```
fabric_open_agent @af/rami-abc123
# Review the worker's patch artifact
fabric_accept_patch \
  --agent @af/rami-abc123 \
  --reviewedBy "senior-harness" \
  --reviewSummary "Patch scope is correct, tests pass, no regressions."
```

### Patch-Mode Reference

| Mode | Behavior | Use Case |
|---|---|---|
| `report` (default) | Writes structured result JSON only; patch stays inside report. | Review lanes, planners, adjudicators. |
| `write` | Validates diff and writes `.patch` file beside JSON artifact. Does not edit workspace. | Implementers producing reviewable patches. |
| `apply` | Validates, dry-runs, and applies with system `patch`. Implementer-only, isolated directory only. | Standalone worker directories. Not for queue-driven work. |

For queue-driven work, prefer `write` mode + `review-patches --accept-task
--apply-patch`. The apply gate requires the queue task to be `patch_ready`,
`review`, or `accepted`, plus a prior `write`-mode artifact.

---

## Elixir Runtime Integration

Recipe for running the Elixir OTP hybrid orchestrator alongside the TypeScript
Agent Fabric daemon. The Elixir runtime supervises long-lived Codex App Server
runner processes and maps Linear issues to queue-visible Agent Fabric tasks.

### Setup

```bash
# Install Elixir toolchain
asdf install
cd elixir
mix deps.get
mix test
```

### Start the TypeScript Daemon

```bash
# In terminal 1: start the canonical daemon
AGENT_FABRIC_COST_INGEST_TOKEN="$(openssl rand -base64 32)" npm run dev:daemon
```

### Preflight and Launch

```bash
cd elixir

# 1. Check workflow validity and daemon socket
mix af.workflow.check --workflow ../WORKFLOW.example.md

# 2. Dry-run to confirm configuration
mix af.orchestrator.run --workflow ../WORKFLOW.example.md --once --dry-run

# 3. Run one queue-visible poll cycle
mix af.orchestrator.run --workflow ../WORKFLOW.example.md --once --start

# 4. Run continuously with concurrency 4
mix af.orchestrator.run --workflow ../WORKFLOW.example.md --watch --concurrency 4
```

### Monitor Runtime

```bash
# Orchestrator status and runtime health
mix af.status --queue <pqueue_id> --project ..

# Stale runner recovery preview (dry-run only from Elixir)
mix af.status --queue <pqueue_id> --project .. \
  --stale-dry-run --stale-after-minutes 30

# Queue cleanup preview
mix af.status --queue <pqueue_id> --project .. \
  --cleanup-dry-run --cleanup-older-than-days 7

# Workspace cleanup preview
mix af.status --workspace-cleanup-dry-run \
  --workspace-root ~/.agent-fabric/workspaces
```

### Dashboard Endpoints (port 4574)

```bash
curl http://127.0.0.1:4574/health
curl http://127.0.0.1:4574/api/status
curl http://127.0.0.1:4574/api/lanes
curl http://127.0.0.1:4574/api/progress
curl http://127.0.0.1:4574/api/runners
curl http://127.0.0.1:4574/api/issues
curl http://127.0.0.1:4574/api/failures
curl http://127.0.0.1:4574/api/workspaces
curl http://127.0.0.1:4574/api/queue-health/<pqueue_id>
```

### Source Parity Check

After rebuilding Agent Fabric, verify daemon/source parity before running
Elixir orchestration:

```bash
agent-fabric-project senior-doctor --project /path/to/agent-fabric --json
agent-fabric-project doctor local-config --project /path/to/agent-fabric --json
```

If the doctor reports source drift, rebuild and restart:

```bash
npm run build && npm link
# Restart daemon via launchctl or your process manager
```

### WORKFLOW.md Contract

The Elixir orchestrator reads a `WORKFLOW.md` with YAML front matter:

```markdown
---
tracker:
  type: linear
  team_key: ENG
  active_states: ["Todo", "In Progress"]
  terminal_states: ["Done", "Canceled"]
workspace:
  root: ~/.agent-fabric/workspaces
  mode: git_worktree
  source_project: /path/to/project
  after_create: ["npm", "install"]
codex:
  command: codex
  args: ["app-server"]
  model_profile: codex-app-server
  max_runtime_minutes: 30
runner:
  concurrency: 4
  heartbeat_ms: 30000
  state_dir: ~/.agent-fabric/elixir
agent_fabric:
  project_path: /path/to/project
  queue_title: Linear to Codex App Server
  queue_profile: fast
  auto_start_execution: false
---
```

### Boundary

- TypeScript daemon and SQLite remain canonical for queues, tasks, approvals,
  heartbeats, artifacts, patch review, memory, and cost.
- Elixir owns long-lived supervision, issue polling, per-issue workspace setup,
  Codex App Server runner processes, and lightweight read-only observability.
- `codex-app-server` is a generic worker kind for externally supervised runners;
  it does not count as a DeepSeek Senior lane.
- Cleanup and stale recovery remain daemon-owned. Elixir status commands call
  public daemon tools in dry-run mode only.

---

## MCP Bridge Integration

Recipes for IDEs and harnesses to call Agent Fabric tools through the stdio MCP
bridge.

### Quick Health Check

```
fabric_status { includeSessions: false }
fabric_doctor {}
```

### Codex/Claude Worker Card Tools

These compact bridge tools expose queue-visible workers as `@af/<name>`
background-agent cards with process-evidence based state:

```
# Start a Senior queue
fabric_senior_start --project /path/to/project --plan-file plan.md --count 10

# Check queue status
fabric_senior_status --queue <queueId>

# Resume an existing queue
fabric_senior_resume --queue <queueId>

# Spawn planned worker cards (returns run-ready to start real shells)
fabric_spawn_agents --queue <queueId> --count 10 --worker deepseek-direct --workspaceMode git_worktree

# List workers with pagination and grouping
fabric_list_agents --queue <queueId> --page 1 --pageSize 20 --groupBy status

# Open one worker's task, transcript, checkpoints, and artifacts
fabric_open_agent @af/rami-abc123

# Send a revision or note to a worker
fabric_message_agent @af/rami-abc123 --body "Please narrow the patch scope."

# Wait for workers to finish
fabric_wait_agents --queue <queueId> --targetStatus patch_ready,completed,failed

# Accept a reviewed patch
fabric_accept_patch \
  --agent @af/rami-abc123 \
  --reviewedBy "senior-harness" \
  --reviewSummary "Patch looks good. Scope is correct and tests pass."
```

### Project Queue Tools via MCP

```
# Create a queue
project_queue_create { projectPath: "/path/to/project", title: "My Queue", pipelineProfile: "careful", maxParallelAgents: 10 }

# Add tasks
project_queue_add_tasks { queueId: "<queueId>", tasks: [{ title: "Add tests", goal: "...", phase: "execution", priority: "normal", risk: "low", parallelSafe: true }] }

# Review queue shape before launch
project_queue_review_matrix { queueId: "<queueId>" }

# Check launch readiness
project_queue_launch_plan { queueId: "<queueId>", limit: 10 }

# Prepare tool/context approvals
project_queue_prepare_ready { queueId: "<queueId>", limit: 10 }

# Start execution
project_queue_decide { queueId: "<queueId>", decision: "start_execution" }

# Monitor progress
project_queue_progress_report { queueId: "<queueId>" }
project_queue_agent_lanes { queueId: "<queueId>" }

# Review and apply patches (use task-detail to inspect, review-patches to apply)
project_queue_task_detail { queueId: "<queueId>", queueTaskId: "<queueTaskId>", includeResume: true }
project_queue_agent_lanes { queueId: "<queueId>" }
```

### Cost and Memory Tools via MCP

```
# Preflight a model call
llm_preflight { provider: "deepseek", model: "deepseek-v4-pro", estimatedInputTokens: 50000, workspaceRoot: "/path/to/project" }

# Inspect sanitized context package
fabric_inspect_context_package { requestId: "<requestId>" }

# Route outcome summary
fabric_route_outcomes_summary { workspaceRoot: "/path/to/project", sinceDays: 7 }

# Memory explainer
fabric_explain_memory { memoryId: "<memoryId>" }
```

### Session Diagnostics via MCP

```
# Explain what a session did
fabric_explain_session { sessionId: "<sessionId>" }

# Follow one correlation ID across pillars
fabric_trace { correlationId: "<correlationId>" }
```

---

## Quick Reference: CLI Shortcuts

```bash
# Doctor
agent-fabric-project senior-doctor --project <path>

# Senior launch (dry-run first)
agent-fabric-project senior-run --dry-run --project <path> --plan-file plan.md --count 10

# Senior launch (with tasks JSON)
agent-fabric-project senior-run --project <path> --tasks-file tasks.json --count 20 --approve-model-calls

# Lower-level factory run
agent-fabric-project factory-run --queue <queueId> --start-execution --parallel 10 --approve-model-calls --approve-tool-context

# Review patches
agent-fabric-project review-patches --queue <queueId>
agent-fabric-project review-patches --queue <queueId> --accept-task <queueTaskId> --apply-patch

# Queue cleanup (dry-run first)
agent-fabric-project cleanup-queues --project <path> --older-than-days 7 --json
agent-fabric-project cleanup-queues --project <path> --older-than-days 7 --apply --json

# Stale recovery
agent-fabric-project recover-stale --queue <queueId> --stale-after-minutes 30 --dry-run

# Worker health (via bridge)
project_queue_worker_health { queueId: "<queueId>" }

# Batch task import
agent-fabric-project import-tasks --queue <queueId> --tasks-file tasks.json --approve-queue
```

---
