# Jcode DeepSeek Worker Adapter

Agent Fabric ships a bundled adapter binary for the `jcode-deepseek` worker preset:

```bash
agent-fabric-jcode-deepseek-worker <task-packet>
```

Use this lane when a queue task should run through Jcode's DeepSeek provider/runtime and still stay inside Agent Fabric's queue, preflight, checkpoint, worktree, and review gates. The focused one-shot DeepSeek lane remains `deepseek-direct`; `jcode-deepseek` is for longer-running coding workers where Jcode's tool loop, sessions, MCP pool, browser support, and richer runtime are useful.

## Setup

Install or link Agent Fabric so `agent-fabric-jcode-deepseek-worker` is on `PATH`, and make sure Jcode is available:

```bash
export JCODE_BIN="$HOME/.local/bin/jcode"
export AGENT_FABRIC_SENIOR_DEFAULT_WORKER="jcode-deepseek"
```

Required runtime inputs:

- `DEEPSEEK_API_KEY` or whichever DeepSeek token variable your Jcode provider expects
- `jcode` on `PATH`, or `JCODE_BIN=/path/to/jcode`
- one Agent Fabric task packet path as the first argument

Optional integration hooks:

- `AGENT_FABRIC_AGENT_ID`: stable worker identity for collab and logs
- `AGENT_FABRIC_OUTPUT_DIR`: directory for the NDJSON log and structured result
- `AGENT_FABRIC_COLLAB_ASK_LISTENER`: executable helper that listens for Agent Fabric collab asks while Jcode runs
- `AGENT_FABRIC_JCODE_DEEPSEEK_DISPATCHER`: legacy/private dispatcher override; leave unset for the bundled adapter

## Queue Usage

```bash
agent-fabric-project run-ready \
  --queue <queueId> \
  --worker jcode-deepseek \
  --parallel 4 \
  --workspace-mode git_worktree \
  --cwd-template "/path/to/worktrees/{{queueTaskId}}" \
  --task-packet-dir task-packets \
  --task-packet-format markdown \
  --approve-tool-context
```

The adapter prints the structured result JSON path on stdout. Agent Fabric reads that artifact into the worker checkpoint, so callers can review summaries, suggested files, suggested tests, blockers, and patch artifacts through the normal queue surfaces.

When launched through `run-ready` or `senior-run`, Agent Fabric records periodic Jcode heartbeats/checkpoints while the command is running and enforces `--max-runtime-minutes` as a structured timeout failure. The adapter also accepts `--max-runtime-minutes <n>` directly for standalone smoke tests.

In Senior mode, mutating Jcode DeepSeek lanes should use git worktrees and the same task-packet, lifecycle, checkpoint, and patch artifact rules as `deepseek-direct`. Use sandbox paths only for report-only planner or reviewer runs.

`dispatch-deepseek-with-collab.example.sh` is retained as a legacy example for private/local experiments. Do not use manual `nohup jcode ...` launches for Senior lanes; they bypass queue-visible lifecycle, timeout, artifact, and review state. The default path should use the bundled adapter, and the next target is a native Jcode `fabric-worker run` command that removes the wrapper layer entirely.

## Safety

Do not put API keys, local tokens, shell history, or personal machine paths in this repo. Keep real local wiring in ignored config such as `agent-fabric.local.env`.
