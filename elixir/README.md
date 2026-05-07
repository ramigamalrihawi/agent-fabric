# Agent Fabric Elixir Orchestrator

This directory contains the first Elixir slice for Agent Fabric. It is a hybrid orchestration layer, not a replacement for the TypeScript daemon.

The boundary is:

- TypeScript Agent Fabric daemon and SQLite remain canonical for queues, tasks, approvals, heartbeats, artifacts, patch review, memory, and cost.
- Elixir owns long-lived supervision, issue polling, per-issue workspace setup, Codex App Server style runner processes, and lightweight read-only observability.
- Workers must still register through Agent Fabric before they count as queue-visible work. The `CodexRunner` preview can attach to an existing `task_id`/`worker_run_id`, or start a `codex-app-server` run through `fabric_task_start_worker` when given an Agent Fabric task id.
- The orchestrator creates or reuses an Agent Fabric queue, maps each Linear issue to a queue task and linked fabric task, claims queue work before runner launch, and records worker metadata with `launchSource=agent_fabric_elixir_orchestrator`.
- Local crash-recovery state is stored under `~/.agent-fabric/elixir/` or `runner.state_dir`; it stores issue mappings and cursors only. The TypeScript daemon remains the source of truth for durable task, worker, event, approval, cost, and patch state.

## Setup

Install the `.tool-versions` runtime, then fetch dependencies:

```bash
asdf install
cd elixir
mix deps.get
mix test
```

This checkout currently expects Erlang/OTP 25 and Elixir 1.15. The Elixir app can be developed while the existing Node daemon is running.

## Operator Commands

The Elixir runtime has day-to-day Mix entrypoints. CLI flags override environment variables, and environment variables override `config/*.exs`. The workflow file remains the project contract.

```bash
cd elixir

mix af.workflow.check --workflow ../WORKFLOW.example.md
mix af.orchestrator.run --workflow ../WORKFLOW.example.md --once --dry-run
mix af.orchestrator.run --workflow ../WORKFLOW.example.md --once --start
mix af.orchestrator.run --workflow ../WORKFLOW.example.md --watch --concurrency 4
mix af.status --queue pqueue_123
mix af.status --queue pqueue_123 --project .. --stale-dry-run --stale-after-minutes 30
mix af.status --queue pqueue_123 --project .. --cleanup-dry-run --cleanup-older-than-days 7
```

A typical operator sequence is:

1. Preflight the workflow and daemon socket: `mix af.workflow.check --workflow ../WORKFLOW.example.md`
2. Confirm launch configuration without side effects: `mix af.orchestrator.run --workflow ../WORKFLOW.example.md --once --dry-run`
3. Run one queue-visible poll: `mix af.orchestrator.run --workflow ../WORKFLOW.example.md --once --start`
4. Run continuously: `mix af.orchestrator.run --workflow ../WORKFLOW.example.md --watch --concurrency 4`
5. Monitor runtime and queue health: `mix af.status --queue <pqueue_id> --project ..`
6. Preview stale running-lane recovery: `mix af.status --queue <pqueue_id> --project .. --stale-dry-run --stale-after-minutes 30`
7. Preview completed/canceled queue cleanup before deleting anything: `mix af.status --queue <pqueue_id> --project .. --cleanup-dry-run`

Cleanup and stale recovery remain daemon-owned. The Elixir status task only calls
the public `project_queue_cleanup` and `project_queue_recover_stale` tools in
dry-run mode so operators can spot queue buildup, stale runners, and row-count
impact without deleting or rewriting Agent Fabric evidence from Elixir. Pass
`--project` when running from `elixir/` so Agent Fabric namespace checks use the
repository root rather than the Elixir subdirectory.

## Source Parity

The Elixir runtime calls the TypeScript Agent Fabric daemon through public bridge tools. After rebuilding or relinking Agent Fabric, make sure the running daemon and global CLI still point at the active checkout:

```bash
agent-fabric-project senior-doctor --project /path/to/agent-fabric --json
agent-fabric-project doctor local-config --project /path/to/agent-fabric --json
```

If the doctor reports source drift, stale bridge schemas, or missing Senior tools, rebuild and relink from the active checkout, then restart the daemon before running Elixir orchestration:

```bash
npm run build && npm link
launchctl bootout gui/$UID ~/Library/LaunchAgents/com.agent-fabric.daemon.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.agent-fabric.daemon.plist
```

`mix af.workflow.check` reports socket reachability failures and points operators back to the doctor commands. Do not work around source drift by writing SQLite directly from Elixir.

## Workflow Contract

`WORKFLOW.md` files use YAML front matter followed by a Markdown issue prompt template:

```markdown
---
tracker:
  type: linear
  team_key: ENG
  active_states: ["Todo", "In Progress"]
  terminal_states: ["Done", "Canceled"]
  page_size: 50
  after_cursor:
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
  queue_id:
  queue_profile: fast
  auto_start_execution: false
  task_defaults:
    phase: linear
    category: implementation
    priority: normal
    risk: medium
    parallel_safe: true
    expected_files: []
    required_context_refs: []
    acceptance_criteria:
      - Provide changed files, verification commands, risks, and follow-ups.
      - Keep patch acceptance inside Agent Fabric review gates.
---

Work on {{ issue.identifier }}: {{ issue.title }}
```

The prompt renderer supports `identifier`, `title`, `description`, `state`, `url`, and `labels`.

`workspace.mode` defaults to `directory` for legacy workflows. Use
`git_worktree` for mutating runners so every Linear issue gets an isolated Git
worktree created from `workspace.source_project`. Existing workspace paths are
reused only when they are valid Git worktrees; plain directories fail closed so a
runner cannot accidentally mutate an unsafe checkout. `workspace.after_create`
may be an argv list such as `["npm", "install"]`, an explicit command map, a test
function hook, or a legacy shell string. Prefer argv lists for operator workflows;
shell strings are still supported but are marked as shell-backed hook metadata.

### Issue Task Planning

The Elixir orchestrator now shapes each normalized Linear issue into a richer
Agent Fabric queue task before handing it to the TypeScript daemon. Labels can
drive `priority`, `risk`, `category`, `workstream`, and `parallelSafe` values,
while issue Markdown sections can provide worker context:

```markdown
Expected files:
- elixir/lib/agent_fabric_orchestrator/orchestrator.ex

Context refs:
- elixir/README.md

Acceptance criteria:
- Run the focused Elixir tests.
- Summarize risks and follow-ups.
```

Supported label forms include `priority:urgent`, `risk:high`, `type:docs`,
`area:elixir`, `file:path/to/file`, `context:path/to/file`, and `serial`.
The optional `agent_fabric.task_defaults` block supplies conservative defaults
for every issue, so workers receive useful queue metadata and proof requirements
without requiring humans to supervise every session directly.

### Cursor-Aware Watch Mode

Linear polling reads one issue page per orchestrator poll. The next `after`
cursor is stored in the local Elixir state file under
`~/.agent-fabric/elixir/` or `runner.state_dir`; when Linear reports no next
page, the next poll wraps back to the first page. Poll failures do not advance
the stored cursor.

Use `tracker.page_size` to tune page size. `tracker.after_cursor` is only a
starting cursor; after the first successful poll, the state store owns resume
position. Reset watch-mode pagination by deleting the workflow state JSON under
`runner.state_dir`, or by starting with a fresh workflow/state directory. Do not
reset cursor state by editing Agent Fabric SQLite.

Cursor state is visible in `mix af.status --json`, `/api/status`, and
`/api/issues` as `poll_cursor` and the compatibility alias
`last_poll_cursor`.

## Roadmap

1. Current slice: Mix operator entrypoints, queue-visible Linear-to-Codex App Server orchestration, UDS FabricGateway seam, runner supervision, local state store, and lightweight JSON dashboard.
2. Next slice: stronger daemon proxy coverage, retry policy controls, event-stream/SSE dashboard APIs, and richer queue health aggregation.
3. Following slice: Phoenix LiveView preview for read-only lane and queue monitoring once runtime APIs stabilize.

**Phoenix LiveView is the target dashboard UI**; the current `:gen_tcp`-based HTTP server is a placeholder to avoid Phoenix dependencies in this pass.

### Current: `AgentFabricOrchestrator.Dashboard`

A GenServer that starts an HTTP server on configurable port (default `4574`) and serves
JSON endpoints:

| Endpoint | State Kind | Description |
|---|---|---|
| `GET /health` | Runtime | Liveness check, version, status |
| `GET /api/status` | Runtime | Orchestrator runtime state (active issues, errors) |
| `GET /api/lanes` | Runtime | Active tracked issues with workspace info |
| `GET /api/progress` | Combined | Runtime state + daemon summary |
| `GET /api/workflow` | Runtime | Workflow path, project path, queue id, runner config |
| `GET /api/runners` | Runtime | Runner pool state and active worker mappings |
| `GET /api/issues` | Runtime | Linear issue to queue/fabric task mapping |
| `GET /api/failures` | Runtime | Recent poll, claim, launch, and runner failures |
| `GET /api/queue-health/:id` | Durable | Proxy to TypeScript daemon queue health API |

Runtime state comes from the `AgentFabricOrchestrator.Orchestrator` GenServer.
Durable state is proxied from the TypeScript daemon (SQLite canonical).

**Runtime and durable state are clearly separated** in all responses.

Responses expose the correctly spelled `orchestrator_alive` field. The misspelled
`orchestator_alive` key remains as a deprecated compatibility alias for early consumers.

```bash
# Check dashboard health
curl http://127.0.0.1:4574/health
# {"status":"ok","application":"agent_fabric_orchestrator","version":"0.1.0"}

# Runtime status
curl http://127.0.0.1:4574/api/status

# Combined progress
curl http://127.0.0.1:4574/api/progress

# Daemon queue health
curl http://127.0.0.1:4574/api/queue-health/pqueue_mov7ew6n
```

### Configuration

```elixir
config :agent_fabric_orchestrator,
  dashboard_port: 4574  # env: AGENT_FABRIC_DASHBOARD_PORT
  daemon_endpoint: "http://127.0.0.1:4573"  # env: AGENT_FABRIC_DAEMON_ENDPOINT
```

### Target: Phoenix LiveView Dashboard

Once orchestration APIs stabilize, migrate the HTTP surface to Phoenix LiveView
to provide:

- Real-time lane/queue status via PubSub
- Interactive process listing and management
- Cost and rate-limit dashboards
- GraphQL/Schema-aware API
