# Agent Fabric Elixir Orchestrator

This directory contains the first Elixir slice for Agent Fabric. It is a hybrid orchestration layer, not a replacement for the TypeScript daemon.

The boundary is:

- TypeScript Agent Fabric daemon and SQLite remain canonical for queues, tasks, approvals, heartbeats, artifacts, patch review, memory, and cost.
- Elixir owns long-lived supervision, issue polling, per-issue workspace setup, Codex App Server style runner processes, and lightweight read-only observability.
- Workers must still register through Agent Fabric before they count as queue-visible work. The `CodexRunner` preview can attach to an existing `task_id`/`worker_run_id`, or start a `codex-app-server` run through `fabric_task_start_worker` when given an Agent Fabric task id.

## Setup

Install the `.tool-versions` runtime, then fetch dependencies:

```bash
asdf install
cd elixir
mix deps.get
mix test
```

This checkout currently expects Erlang/OTP 25 and Elixir 1.15. The Elixir app can be developed while the existing Node daemon is running.

## Workflow Contract

`WORKFLOW.md` files use YAML front matter followed by a Markdown issue prompt template:

```markdown
---
tracker:
  type: linear
  team_key: ENG
  active_states: ["Todo", "In Progress"]
  terminal_states: ["Done", "Canceled"]
workspace:
  root: ~/.agent-fabric/workspaces
  after_create: npm install
codex:
  command: codex
  args: ["app-server"]
agent_fabric:
  project_path: /path/to/project
  queue_profile: fast
---

Work on {{ issue.identifier }}: {{ issue.title }}
```

The prompt renderer supports `identifier`, `title`, `description`, `state`, `url`, and `labels`.

## Roadmap

A minimal HTTP observability surface (`AgentFabricOrchestrator.Dashboard`) ships now.
**Phoenix LiveView is the target dashboard UI**; the current `:gen_tcp`-based HTTP server
is a placeholder to avoid Phoenix dependencies in this pass.

### Current: `AgentFabricOrchestrator.Dashboard`

A GenServer that starts an HTTP server on configurable port (default `4574`) and serves
JSON endpoints:

| Endpoint | State Kind | Description |
|---|---|---|
| `GET /health` | Runtime | Liveness check, version, status |
| `GET /api/status` | Runtime | Orchestrator runtime state (active issues, errors) |
| `GET /api/lanes` | Runtime | Active tracked issues with workspace info |
| `GET /api/progress` | Combined | Runtime state + daemon summary |
| `GET /api/queue-health/:id` | Durable | Proxy to TypeScript daemon queue health API |

Runtime state comes from the `AgentFabricOrchestrator.Orchestrator` GenServer.
Durable state is proxied from the TypeScript daemon (SQLite canonical).

**Runtime and durable state are clearly separated** in all responses.

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
