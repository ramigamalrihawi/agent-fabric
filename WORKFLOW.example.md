---
tracker:
  type: linear
  team_key: ENG
  active_states: ["Todo", "In Progress"]
  blocked_states: ["Blocked"]
  terminal_states: ["Done", "Canceled"]
workspace:
  root: ~/.agent-fabric/workspaces/agent-fabric
  after_create: npm install
codex:
  command: codex
  args: ["app-server"]
agent_fabric:
  project_path: /Users/example/projects/agent-fabric
  queue_profile: fast
---

Work on {{ issue.identifier }}: {{ issue.title }}

Issue state: {{ issue.state }}
Issue URL: {{ issue.url }}
Labels: {{ issue.labels }}

Use Agent Fabric for queue state, worker lifecycle, checkpoints, patch artifacts, and final review gates.
