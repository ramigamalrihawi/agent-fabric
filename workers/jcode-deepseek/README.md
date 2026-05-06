# Jcode DeepSeek Worker Dispatcher

This folder contains a portable example dispatcher for the `jcode-deepseek` worker preset.

Use this lane when a queue task should run through Jcode's DeepSeek provider/runtime and still stay inside Agent Fabric's queue, preflight, checkpoint, and review gates. The focused one-shot DeepSeek lane remains `deepseek-direct`; this dispatcher is for longer-running coding workers where Jcode and bidirectional collaboration asks are useful.

## Setup

Copy or wrap `dispatch-deepseek-with-collab.example.sh` in your local automation workspace, then point Agent Fabric at it:

```bash
export AGENT_FABRIC_JCODE_DEEPSEEK_DISPATCHER="/path/to/dispatch-deepseek-with-collab.sh"
```

Required runtime inputs:

- `DEEPSEEK_API_KEY` or whichever DeepSeek token variable your Jcode provider expects
- `jcode` on `PATH`, or `JCODE_BIN=/path/to/jcode`
- one Agent Fabric task packet path as the first argument

Optional integration hooks:

- `AGENT_FABRIC_AGENT_ID`: stable worker identity for collab and logs
- `AGENT_FABRIC_OUTPUT_DIR`: directory for the NDJSON log and structured result
- `AGENT_FABRIC_COLLAB_ASK_LISTENER`: executable helper that listens for Agent Fabric collab asks while Jcode runs

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

The dispatcher prints the structured result JSON path on stdout. Agent Fabric reads that artifact into the worker checkpoint, so callers can review summaries, suggested files, suggested tests, blockers, and patch artifacts through the normal queue surfaces.

In Senior mode, mutating Jcode DeepSeek lanes should use git worktrees and the same task-packet, lifecycle, checkpoint, and patch artifact rules as `deepseek-direct`. Use sandbox paths only for report-only planner or reviewer runs.

## Safety

Do not put API keys, local tokens, shell history, or personal machine paths in this repo. Keep real local wiring in your private automation workspace and use `AGENT_FABRIC_JCODE_DEEPSEEK_DISPATCHER` to reference it.
