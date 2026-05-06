# agent-fabric workers

Optional sidecars live here. They are not part of the TypeScript daemon.

Workers let Agent Fabric keep durable state while external model runners, CLIs, and harnesses perform bounded execution. A worker should receive a focused task packet, report lifecycle events back to the daemon, and leave enough evidence for review.

Boundary:

- `agent-fabric` owns durable task/session state, collab, memory, costs, approvals, context metadata, checkpoints, and audit.
- Workers execute bounded jobs and report lifecycle through `fabric_task_*`.
- Workers must not bypass `llm_preflight` for metered model calls.
- Workers must not write active memories directly unless a later reviewed workflow explicitly allows it.
- Workers that edit files must use a git worktree or real sandbox and claim paths first.

## Current workers

| Worker | Status | Role |
|---|---|---|
| [smolagents-worker](smolagents-worker/README.md) | experimental safe scaffold | Project mining, context inspection, memory-candidate extraction, and explicit pending-review memory writes. |
| [jcode-deepseek](jcode-deepseek/README.md) | portable dispatcher example | Runs queue task packets through a configurable Jcode DeepSeek runtime while preserving Agent Fabric preflight, checkpoint, and review gates. |
| `agent-fabric-deepseek-worker` | first direct API scaffold | DeepSeek V4 Pro/Flash prompt improvement, task generation, structured task-packet reports, and opt-in proposed-patch write/apply modes. |

`agent-fabric-deepseek-worker run-task` is report-only by default. Pass `--patch-mode write` to save a validated proposed patch for review. Queue operators can then apply accepted write-mode patches with `agent-fabric-project review-patches --accept-task <queueTaskId> --apply-patch`. Direct `--patch-mode apply` remains available for isolated implementer runs, but it is guarded by status, role, path, symlink, and dry-run checks.

DeepSeek direct scans task packets and context files for common secret patterns before API calls in normal mode. In Senior mode, set `AGENT_FABRIC_SENIOR_MODE=permissive`; task-relevant sensitive context is authorized for DeepSeek-direct workers by default. Use `--sensitive-context-mode strict` only when the senior coordinator intentionally wants a sanitized review packet.

DeepSeek direct calls retry transient HTTP 429 rate limits and empty JSON content up to three attempts. `agent-fabric-project factory-run` and `run-ready --adaptive-rate-limit` reduce later batch parallelism when structured or textual 429 evidence appears. Broad queue runners also use a local per-queue lock by default; use `--allow-concurrent-runner` only for intentional overlapping schedulers. Missing API keys, persistent rate limits, unsafe patches, and failed test evidence should be treated as queue review/retry checkpoints rather than ignored worker noise.

## Host terminal tools

DeepSeek and other shell-capable workers should use the standard host tool baseline when task packets grant shell work:

- `rg` for source/text search
- `fd` for file/path discovery
- `jq` for JSON logs, API payloads, and config
- `gh` for explicit GitHub tasks
- `btop` for human-supervised diagnostics

Human-facing tools such as `bat`, `eza`, `fzf`, `zoxide`, `atuin`, `tmux`, and `zellij` are available, but workers should not depend on interactive aliases or shell history for unattended execution.

## Adding a worker

A worker adapter should provide:

- a README with install, safety, and validation commands
- a no-model dry-run mode where possible
- fabric lifecycle reporting through `fabric_task_start_worker`, `fabric_task_event`, `fabric_task_checkpoint`, and `fabric_task_finish`
- a fail-closed cost preflight path for model-backed calls
- tests that do not require real model keys
- one real-daemon smoke path before being considered daily-use
