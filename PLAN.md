# Roadmap

Agent Fabric is currently an early local-first control plane. The implemented base is useful, but the project is still pre-1.0.

## Implemented

- Authenticated bridge sessions with idempotent mutation calls.
- SQLite migrations and canonical state tables.
- Collaboration inboxes, asks, replies, decisions, path claims, and live SSE fan-out.
- Project queue DAGs with readiness, dependencies, risk, concurrency, launch gates, and recovery.
- High-scale Senior queue orchestration with configurable local caps, manager/workstream metadata, paged worker cards, and bounded manager summaries.
- Worker lifecycle events, heartbeats, checkpoints, resume packets, and finish records.
- Model preflight, approval tokens, context inspection, and cost ledgers.
- Typed memory review, confirmation, invalidation, and outcome hooks.
- Local command center over daemon APIs.
- Optional DeepSeek-direct worker lanes with task-packet scanning.
- Additive Elixir orchestration preview with `WORKFLOW.md` parsing, Linear issue normalization, deterministic workspace setup, Codex App Server runner lifecycle glue, and read-only dashboard projection.
- Elixir OTP runner pool for Codex App Server lanes, including one-runner-per-issue guards, start/stop/list/status APIs, exit monitoring, and runner-pool state in orchestrator status.
- Elixir dry-run workspace cleanup previews exposed through `mix af.status --workspace-cleanup-dry-run` and the lightweight dashboard `GET /api/workspaces` endpoint. Actual deletion remains gated outside Elixir.
- Roadmap-aware Elixir issue task planning for dependency hints, verification hints, and manager metadata while keeping TypeScript Agent Fabric queues canonical.
- Tests for the current daemon, CLI, queue, worker, cost, memory, collab, and desktop surfaces.

## Near-Term

- Better package ergonomics for first-time users.
- Cleaner command center onboarding.
- More examples for MCP bridge integration.
- Connection limits and metrics for live fan-out.
- More queue recipes for common implementation/review workflows.
- Patch-review UX improvements.
- Harden the Elixir orchestrator into a full runtime: real Linear sync state, deeper FabricGateway queue projections, crash recovery semantics, Phoenix LiveView monitoring after runtime APIs stabilize, and queue-visible Codex App Server launch recipes.
- First-class manager-run lifecycle entities if task labels and worker-run metadata stop being enough for phase managers.

## Codex/Claude Experience Plan

This plan remains open after the initial Elixir migration work. The Elixir pass
closed the local runner-pool seam, workspace cleanup preview, dashboard runtime
preview endpoint, and roadmap-aware issue shaping. The remaining work is mostly
TypeScript daemon, bridge, CLI, and MCP ergonomics.

### Still Open

- Make `fabric_status` compact by default for MCP callers, add `verbose?: boolean`, keep full session dumps behind `verbose: true` or `includeSessions: true`, and dedupe warnings by default.
- Add a small read-only starter surface such as `fabric_starter_kit` so Codex and Claude can discover the happy-path queue tools without scanning the whole bridge.
- Add `fabric_task_tail` for safe worker log tailing by `workerRunId`, `taskId`, or `queueId + queueTaskId`.
- Persist stdout/stderr logs for every shell-backed `run-task`, `run-ready`, `factory-run`, and Senior lane, not only Jcode paths, and store pid/log metadata on worker runs.
- Add `project_queue_worker_health` with process, heartbeat, output, diff, and recovery classification. Reuse Elixir `RunnerPool` state where the worker is Elixir-owned, but keep Agent Fabric as the durable source of truth.
- Add `agent-fabric-project watch-workers` for coordinator-side monitoring, stale/blocked recommendations, and optional non-destructive stale marking.
- Add `agent-fabric-project dispatch` as the documented launch wrapper over `run-ready`; keep `senior-run` as create/import-and-dispatch, and mark older dispatch scripts as legacy in docs and packets.
- Make `senior-run` final output compact: queue id, lane counts, failed/stale/patch-ready summaries, progress file, and next actions.
- Add default artifact ignore globs for patch harvesting, plus `AGENT_FABRIC_ARTIFACT_IGNORE_GLOBS` and `--artifact-ignore` for project-specific additions.
- Add `agent-fabric-project merge-worker --dry-run|--apply` to locate a worker worktree or patch artifact, summarize a clean diff, detect conflicts, optionally run tests, and record accept/reject through the existing patch acceptance flow.
- Add MCP read-only `project_queue_patch_review_plan` with changed files, patch refs, risk notes, tests, and exact CLI apply commands.
- Finish cost visibility across queue status, task detail, lanes, dashboard, and Codex-style cards. Worker cost attribution already exists in queue summaries, but task/lane/card coverage still needs source-labeled fields.
- Add `project_queue_collab_summary` and update dispatch packets so worker asks/replies flow through Agent Fabric APIs with queue and task refs instead of only local artifacts.
- Accept `priority: "medium"` everywhere queue tasks can be added, updated, imported, or generated; normalize it to stored `"normal"` with a compatibility warning.
- Add `project_queue_add_task_batch` for shared defaults plus per-lane variants, validated through the same queue task schema.
- Tighten bridge descriptions and generated docs around the essential Codex/Claude queue tools.
- Add Elixir read-only gateway wrappers for the new worker health, tail, patch-review, and collab-summary tools after the TypeScript public APIs exist.

### Test Coverage Still Needed

- Bridge tests for compact `fabric_status`, verbose sessions, deduped warnings, and starter-kit discovery.
- Project CLI tests for `dispatch`, log path recording, safe tailing, git-worktree launch, compact `senior-run` output, artifact ignore filtering, and `merge-worker --dry-run`.
- Project queue tests for worker health classification, priority alias normalization, task batch templating, per-task cost fields, and collab summary grouping.
- Worker tests proving quiet long-running Jcode/DeepSeek/shell processes keep heartbeats, write tailable logs, and report controlled timeout failure.
- A smoke fixture that creates a queue, adds templated parallel tasks, launches mock workers through `dispatch`, tails a worker, checks health, and dry-runs merge review.

## Later

- Cross-machine sync.
- Pluggable worker backends.
- OpenTelemetry export.
- Policy packs for different teams and risk profiles.
- Stronger memory evaluation suites.
- Hosted or team modes if the local-first contract remains clear.
