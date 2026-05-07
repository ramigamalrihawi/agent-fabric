# Agent Fabric Senior Mode

When the user asks for Senior mode, use Agent Fabric as the worker substrate and keep Codex as the senior harness.

This checkout is the active source tree. Do not switch to another local clone
or private overlay unless the operator explicitly asks for that.

Private operating material stays in this checkout as gitignored files. Source
`agent-fabric.local.env` when local preferences are needed, and read the local
gitignored `decisions/` directory when present for architecture intent and
roadmap context. Those decision records are agent memory, not public release
material.

## Senior-Mode Defaults

- Spawn execution workers through Agent Fabric tools or `agent-fabric-project`, not through untracked native Codex subagents.
- A worker counts toward "DeepSeek workers" only after it is visible in Agent Fabric queue state with a worker run, workspace mode, runner process evidence, lifecycle events, heartbeats, and artifacts.
- Use `deepseek-direct` or `jcode-deepseek` for Senior-mode execution lanes. Do not record a DeepSeek worker while launching `codex`, `claude`, or another local CLI.
- In this local checkout, source `agent-fabric.local.env` to prefer `jcode-deepseek` for large Senior implementation lanes. Use `deepseek-direct` explicitly for cheap planner/reviewer lanes.
- Use `git_worktree` for mutating worker lanes. Use `sandbox` only for report-only planner/reviewer lanes that will not edit project files.
- Use `research-planner` for report-only DeepSeek planner/reviewer routing; pair it with `sandbox` for non-git projects.
- Keep Codex native subagents for supervisor-side exploration, review, and adjudication. They do not satisfy a requested DeepSeek lane count unless explicitly registered as Agent Fabric workers.

## Codex Worker Controls

Use the high-level Senior happy path before assembling low-level commands by hand:

```bash
agent-fabric-project senior-doctor --project <path> [--queue <id>]
agent-fabric-project senior-run --project <path> --tasks-file .agent-fabric/tasks/tasks.json --count 10 --approve-model-calls --progress-file .agent-fabric/progress.md
```

Use `senior-run --dry-run` first when task JSON is not already prepared. If only an MD plan is supplied, `senior-run` uses a local scaffold by default and avoids a project-model task-generation charge.

If `senior-doctor` reports daemon/source drift, stale Senior tools, or a queue namespace mismatch, fix that before launching workers. The daemon/socket is shared local infrastructure: do not kill, restart, or remove the shared daemon/socket from an automated agent session. Ask the operator to restart or relink the canonical daemon, switch to the checkout that already owns the daemon, or use an isolated `AGENT_FABRIC_HOME`/socket for experiments. Queue IDs are resumable across Codex, Claude Code, and `agent-fabric-project --project <path>` when the project path matches the queue.

Prefer these compact Agent Fabric tools from Codex:

- `fabric_senior_start`, `fabric_senior_status`, `fabric_senior_resume`: start or resume a Senior queue and return worker cards/progress.
- `fabric_spawn_agents`: preview runner-backed Agent Fabric worker cards, usually `count=10`, `workspaceMode=git_worktree`; it must never claim `running` without runner evidence. Start real shells with `senior-run` or `run-ready`.
- `fabric_list_agents`: show Codex-style worker cards with `@af/<name>` handles.
- `fabric_open_agent`: open one worker's task, transcript, checkpoints, and artifacts.
- `fabric_message_agent`: send a durable revision, note, or ask to an `@af/<name>` worker.
- `fabric_wait_agents`: poll worker cards until they reach closed or target statuses.
- `fabric_accept_patch`: accept a patch-ready worker result only after supplying `reviewedBy` and `reviewSummary`.

If the user tags `@af/<name>`, resolve it with `fabric_open_agent` or `fabric_message_agent`. If the user tags a native Codex subagent, treat that as a Codex-only helper unless the worker is also registered in Agent Fabric.

## Worktree Discipline

- Every mutating Agent Fabric worker must have a unique worktree path.
- Do not share an in-place checkout across parallel execution lanes.
- Patch-ready means a patch artifact exists and is linked to the queue task; report-only output should remain completed/report state.
- Never apply a worker patch without a senior review step.
- Mutating factory examples should use `.agent-fabric/worktrees/<queueTaskId>` or another git worktree root, not a generic sandbox directory.
- Do not bypass Agent Fabric with manual `nohup jcode ...` Senior launches. Use `senior-run` or `run-ready --worker jcode-deepseek` so the queue records lifecycle events, heartbeats, timeout failures, and patch artifacts.
- If files move after queue creation, run `project_queue_validate_context_refs` or repair with `edit-task --rewrite-context-ref old=new` before launching. Missing context refs block runner launch.
