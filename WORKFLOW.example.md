---
tracker:
  type: linear
  team_key: ENG
  active_states: ["Todo", "In Progress"]
  blocked_states: ["Blocked"]
  terminal_states: ["Done", "Canceled"]
  page_size: 50
  # Optional starting cursor. After the first successful poll, runner.state_dir
  # stores the resume cursor for watch mode.
  after_cursor:
workspace:
  root: ../.agent-fabric/workspaces/agent-fabric
  # Use git_worktree for mutating runners so each Linear issue gets an isolated checkout.
  # Use directory for report-only or legacy plain-directory workflows.
  mode: git_worktree
  source_project: ..
  # Prefer argv hooks; shell-string hooks are supported but marked as shell-backed metadata.
  after_create: ["npm", "install"]
codex:
  command: codex
  args: ["app-server"]
  model_profile: codex-app-server
  max_runtime_minutes: 30
runner:
  concurrency: 4
  heartbeat_ms: 30000
  # Stores local issue-to-queue mappings and Linear poll cursor state.
  state_dir: ~/.agent-fabric/elixir
agent_fabric:
  project_path: ..
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

Issue state: {{ issue.state }}
Issue URL: {{ issue.url }}
Labels: {{ issue.labels }}

Use Agent Fabric for queue state, worker lifecycle, checkpoints, patch artifacts, and final review gates.

For operations hygiene, preview stale runner recovery and queue cleanup from `elixir/`:

```bash
mix af.status --queue <pqueue_id> --project .. --stale-dry-run --stale-after-minutes 30
mix af.status --queue <pqueue_id> --project .. --cleanup-dry-run --cleanup-older-than-days 7
```
