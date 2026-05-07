# Architecture

Agent Fabric is a local daemon with a durable SQLite core. Runtime clients connect through a Unix-domain socket, MCP bridge, or local HTTP endpoints.

## Components

```text
senior harness / client
  -> MCP bridge / Unix socket / local HTTP
  -> FabricDaemon
  -> SQLite
  -> projections: SSE events, generated views, task packets, command center reads
  -> optional worker lanes: DeepSeek, local models, CLI harnesses, custom runners
```

## Design Principles

- **SQLite is canonical.** Live pushes, generated markdown views, and worker packets are projections.
- **Durable first.** Mutations commit before best-effort fan-out or external worker activity.
- **Runtime agnostic.** Agent Fabric tracks work; coding harnesses perform the work.
- **Hybrid orchestration allowed.** Elixir can supervise long-lived tracker and runner processes, but it must use Agent Fabric APIs rather than writing SQLite directly.
- **Senior model stays in judgment.** Premium supervisor lanes can coordinate cheaper parallel workers while retaining final patch and risk decisions.
- **Idempotent mutation surface.** Session-scoped idempotency keys protect callers from retry duplication.
- **Explicit trust gates.** Model calls, tool grants, worker patches, and memory promotion can require approval.
- **Coverage-honest costs.** Estimated model spend and provider billing data are separate ledgers, not blended fiction.

## Senior Supervisor Topology

Agent Fabric supports a supervisor-worker pattern for high-quality work at lower blended cost:

1. A senior harness, such as a GPT-5.5 or Claude Opus 4.7 session, owns prompt improvement, decomposition, risk judgment, and final integration.
2. Optional manager harnesses own roadmap phases or workstreams and supervise their own queue-visible Agent Fabric worker batches.
3. The queue fans out independent tasks to cheaper DeepSeek V4 Pro max-reasoning workers with focused task packets and approved context.
4. The senior harness, manager harnesses, and DeepSeek workers can communicate bidirectionally through `collab_send`, durable inbox reads, live SSE fan-out, asks/replies, decisions, and checkpoints.
5. Review lanes inspect implementation outputs, test logs, risks, docs, and patch artifacts before anything is applied.
6. The senior harness reviews the evidence, accepts or rejects findings, runs final checks, and hands off the result.

This keeps expensive senior-model tokens focused on judgment while allowing liberal DeepSeek token use for breadth, adversarial review, and long-context investigation.

## Elixir Orchestration Layer

The `elixir/` application is an optional runtime layer inspired by Symphony-style issue automation. It loads a repo-owned `WORKFLOW.md`, normalizes Linear issues, derives per-issue workspaces, supervises Codex App Server style worker processes, and projects progress into a lightweight dashboard shape.

It does not replace the TypeScript daemon, SQLite migrations, approvals, cost controls, patch review, memory, or queue scheduling. Elixir may own processes, timers, and runner supervision; Agent Fabric remains the source of truth for tasks, worker runs, lifecycle events, heartbeats, checkpoints, artifacts, and final review state.

Elixir also owns the tracker-to-task shaping seam. `IssueTaskPlanner` turns
normalized Linear issues, workflow defaults, labels, and issue Markdown sections
into richer Agent Fabric queue tasks with priority, risk, category, workstream,
expected files, required context refs, acceptance criteria, and parallel-safety
metadata. This borrows Symphony's "manage work, not sessions" posture while
keeping all durable queue state and patch review inside Agent Fabric.

Workspace preparation is also an Elixir-owned runtime seam. The workflow contract
can request legacy `directory` workspaces or isolated `git_worktree` workspaces
created from `workspace.source_project`; the latter is preferred for mutating
Codex App Server runners because each issue gets a deterministic checkout and
invalid existing paths fail closed. After-create hooks support argv execution
without shell interpolation, while legacy shell strings remain visibly marked as
shell-backed metadata. Queue cleanup and stale running-lane recovery stay on the
TypeScript side; Elixir only exposes dry-run previews through public Agent Fabric
tools.

High-scale Senior queues are organized around lightweight orchestration labels rather than raw transcript replay. Queue tasks can carry `managerId`, `parentManagerId`, `parentQueueId`, `phase`, `workstream`, `costCenter`, and `escalationTarget`; worker runs inherit those labels for card projection and reporting. `fabric_list_agents` paginates and groups cards, `project_queue_progress_report` returns a bounded `managerSummary`, and cost summaries separate senior, manager, and worker spend where worker events report cost data. These projections let Codex, Claude Code, desktop views, and future plugin surfaces supervise hundreds of lanes without forcing the senior model to read every raw worker log.

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
