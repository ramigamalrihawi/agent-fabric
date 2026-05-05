# Architecture

Agent Fabric is a local daemon with a durable SQLite core. Runtime clients connect through a Unix-domain socket, MCP bridge, or local HTTP endpoints.

## Components

```text
client harness
  -> MCP bridge / Unix socket / local HTTP
  -> FabricDaemon
  -> SQLite
  -> projections: SSE events, generated views, task packets, command center reads
```

## Design Principles

- **SQLite is canonical.** Live pushes, generated markdown views, and worker packets are projections.
- **Durable first.** Mutations commit before best-effort fan-out or external worker activity.
- **Runtime agnostic.** Agent Fabric tracks work; coding harnesses perform the work.
- **Idempotent mutation surface.** Session-scoped idempotency keys protect callers from retry duplication.
- **Explicit trust gates.** Model calls, tool grants, worker patches, and memory promotion can require approval.
- **Coverage-honest costs.** Estimated model spend and provider billing data are separate ledgers, not blended fiction.

## Major Surfaces

- `collab_*`: live and async collaboration, inboxes, asks/replies, decisions, path claims.
- `project_queue_*`: project-scoped task DAGs, readiness, tool/context proposals, review matrix, worker launch, retry, recovery, and patch review.
- `fabric_task_*`: worker run lifecycle, heartbeats, events, checkpoints, resume, and finish.
- `memory_*`: typed memory writes, review, confirmation, invalidation, injection, and outcomes.
- `llm_*` / `model_brain_route`: preflight, approvals, budgets, and routing decisions.
- `pp_cost_*`: provider spend ingestion, cost views, anomaly detection, and idle-resource hints.

## Live Collaboration Fan-Out

`collab_send` commits the message and audit/event rows first. Only after the transaction commits does the daemon publish to online SSE subscribers whose session declares notification support and whose agent id matches the recipient or broadcast `"*"`.

If no recipient is online, or transport delivery fails, the message remains available through `collab_inbox`.

## Storage

The schema lives in `src/migrations`. The daemon applies migrations on startup. Database, socket, and generated view paths default under `~/.agent-fabric` and can be overridden with environment variables.

## Security Boundaries

- Session tokens are stored hashed.
- Mutations require a session token and idempotency key.
- HTTP mutation surfaces are local-only by default.
- The cost ingester requires a bearer token when HTTP is enabled.
- Worker context packets should include only task-relevant files and logs.
- Secret-looking task packets are rejected by the DeepSeek worker unless explicitly overridden.
