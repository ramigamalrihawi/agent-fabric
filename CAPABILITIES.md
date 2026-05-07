# Agent Fabric Capabilities

Public quick reference for Codex, Claude Code, and other senior harnesses.

## Senior Mode Happy Path

```bash
agent-fabric doctor local-config --project <path>
agent-fabric-project senior-doctor --project <path> [--queue <id>]
agent-fabric-project senior-run --dry-run --project <path> --plan-file <plan.md> --count 10
agent-fabric-project senior-run --project <path> --tasks-file .agent-fabric/tasks/tasks.json --count 10 --worker jcode-deepseek --approve-model-calls --progress-file .agent-fabric/progress.md
```

`senior-run` is the high-level wrapper for Codex and Claude Code. It diagnoses the environment, creates or reuses a queue, imports task JSON or creates a local scaffold from an MD plan, starts execution, validates fabric task links and context refs, uses git worktrees for mutating lanes, launches queue-visible DeepSeek/Jcode workers, and writes a bounded progress file.

`senior-doctor` also checks that the running daemon, global CLI, and MCP bridge are from the same checkout and that the daemon exposes the Senior bridge tools. If it reports a daemon/source mismatch, treat that as an operator-only shared-daemon problem: automated agents must not kill, restart, or remove the shared daemon/socket. Ask the operator to restart or relink the canonical daemon, switch to the checkout that already owns the daemon, or run experiments with an isolated `AGENT_FABRIC_HOME`/socket.

Use `factory-run` only when you need the lower-level primitive:

```bash
agent-fabric-project factory-run --queue <queueId> --start-execution --parallel 10 --approve-model-calls --approve-tool-context
```

## Worker Cards

Codex-like and Claude-like integrations should call:

- `fabric_senior_start`
- `fabric_senior_status`
- `fabric_senior_resume`
- `fabric_spawn_agents`
- `fabric_list_agents`
- `fabric_open_agent`
- `fabric_message_agent`
- `fabric_wait_agents`
- `fabric_accept_patch`

Cards use stable `@af/<name>` handles. Default names are assigned in this order: `Rami`, `Belle`, `Amir`, `Falak`, `Gamal`, `Angela`, then deterministic numeric suffixes.

Cards must be process-evidence based. Native projections should show `planned`, `starting`, `running`, `no_runner`, `stale`, `failed`, `completed`, or `patch_ready` from runner state, not queue task status alone. `fabric_spawn_agents` may return planned cards and a `run-ready` command, but it must not create fake running cards.

## Rules

- Agent Fabric queue state is the source of truth for Senior-mode workers.
- Native Codex or Claude helper agents do not count as DeepSeek workers unless registered as Agent Fabric worker runs.
- Mutating workers use `git_worktree`; report-only planner/reviewer workers may use `sandbox`.
- DeepSeek Senior execution workers are `deepseek-direct` or `jcode-deepseek`.
- Use `research-planner` for report-only DeepSeek planner/reviewer routing; pair it with `sandbox` when the target project is not a Git checkout.
- Local operator preference may set `AGENT_FABRIC_SENIOR_DEFAULT_WORKER=jcode-deepseek` so broad implementation lanes use Jcode by default; use `--worker deepseek-direct` explicitly for cheaper one-shot planning/review lanes.
- Patch-ready output must stay pending until a senior review records `reviewedBy` and `reviewSummary`.
- Queue-scoped model approval is auditable: use `--approve-model-calls` instead of manually approving ten duplicate DeepSeek preflights.
- Do not launch Senior Jcode lanes with manual `nohup jcode ...` commands. Use `senior-run` or `run-ready --worker jcode-deepseek` so heartbeats, timeout handling, patch artifacts, and review gates stay queue-visible.
- Do not launch Senior DeepSeek direct lanes with bare `agent-fabric-deepseek-worker run-task`. Queue runners mark the shell as `AGENT_FABRIC_WORKER_QUEUE_VISIBLE=1`, and untracked direct runs require the explicit `AGENT_FABRIC_DEEPSEEK_ALLOW_UNTRACKED=1` escape hatch.
- DeepSeek direct task packets include a bounded generated context sidecar from `expectedFiles` and file-like `requiredContextRefs`; use `{{contextFile}}` in custom command templates when overriding the default runner.
- Custom `deepseek-direct` templates that invoke `agent-fabric-deepseek-worker` are linked with `--fabric-task {{fabricTaskId}}`; missing fabric task links or moved required context refs block launch.
- Senior concurrency defaults to 10 lanes and accepts explicit 20-lane requests; the hard local cap is 32.
- Daemon/source drift, stale Senior tools, or socket refusal are not permission for an agent to kill/restart the shared daemon. Use doctor/status reads, isolate the runtime, or ask the operator before any daemon control action.
