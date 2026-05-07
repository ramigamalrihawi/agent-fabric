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
- Tests for the current daemon, CLI, queue, worker, cost, memory, collab, and desktop surfaces.

## Near-Term

- Better package ergonomics for first-time users.
- Cleaner command center onboarding.
- More examples for MCP bridge integration.
- Connection limits and metrics for live fan-out.
- More queue recipes for common implementation/review workflows.
- Patch-review UX improvements.
- Harden the Elixir orchestrator into a full runtime: real Linear sync state, supervised runner pools, Phoenix LiveView monitoring, and queue-visible Codex App Server launch recipes.
- First-class manager-run lifecycle entities if task labels and worker-run metadata stop being enough for phase managers.

## Later

- Cross-machine sync.
- Pluggable worker backends.
- OpenTelemetry export.
- Policy packs for different teams and risk profiles.
- Stronger memory evaluation suites.
- Hosted or team modes if the local-first contract remains clear.
