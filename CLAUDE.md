# Agent Fabric Senior Mode For Claude Code

Claude Code should use Agent Fabric as the durable worker substrate when the user asks for Senior mode or DeepSeek/Jcode worker lanes.

## Rules

- Do not satisfy "10 DeepSeek workers" with Claude Code background tasks or ad hoc shells.
- Use Agent Fabric queue-visible workers: `deepseek-direct` or `jcode-deepseek`.
- Mutating workers use `git_worktree`; report-only planner/reviewer workers may use `sandbox`.
- Worker identity must be truthful. A lane recorded as DeepSeek must launch the Agent Fabric DeepSeek worker or Jcode DeepSeek dispatcher.
- Native Claude helpers may assist the senior review, but they do not count as Agent Fabric DeepSeek workers unless registered with worker runs, events, checkpoints, and artifacts.

## Bridge Workflow

Start with the cheap, resumable Senior path:

```bash
agent-fabric-project senior-doctor --project <path> [--queue <id>]
agent-fabric-project senior-run --dry-run --project <path> --plan-file <plan.md> --count 10
agent-fabric-project senior-run --project <path> --tasks-file .agent-fabric/tasks/tasks.json --count 10 --approve-model-calls --progress-file .agent-fabric/progress.md
```

This avoids manual task JSON discovery, repeated DeepSeek approval loops, and ambiguous sandbox paths. Use `--approve-model-calls` only with `AGENT_FABRIC_SENIOR_MODE=permissive` or an explicit queue approval.

- Spawn or resume lanes with `fabric_senior_start` / `fabric_senior_status` / `fabric_senior_resume`, or with `agent-fabric-project senior-run`.
- Use lower-level `fabric_spawn_agents` or `agent-fabric-project fabric-spawn-agents` only when a queue is already shaped and approved.
- Inspect workers with `fabric_list_agents` and `fabric_open_agent`.
- Send revisions with `fabric_message_agent` using the `@af/<worker-name>` handle.
- Poll with `fabric_wait_agents`.
- Accept patch-ready results with `fabric_accept_patch` only with `reviewedBy` and `reviewSummary`, or use the explicit review-patches flow.

Keep final integration in the senior harness: review patches, run tests, and summarize which worker outputs were accepted or rejected.
