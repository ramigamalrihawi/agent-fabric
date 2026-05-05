# Agent Fabric

Local-first coordination infrastructure for serious multi-agent software work.

Agent Fabric is a TypeScript daemon and CLI toolkit that gives coding agents a shared operating layer: durable queues, live collaboration, memory review, cost preflight, worker checkpoints, approval gates, and an auditable SQLite record of what happened.

It is built for developers who already use tools like Claude Code, Codex, OpenHands, Aider, OpenCode-style shells, local model runners, or custom workers, and want those tools to cooperate instead of starting over in isolated sessions.

## Why It Exists

Most agent tooling focuses on the runtime: prompts, personas, swarms, hooks, or a single IDE integration. Agent Fabric focuses on the missing substrate beneath those runtimes.

It answers operational questions that become painful as soon as more than one agent is involved:

- Which worker owns this task?
- Which files are claimed or risky to touch in parallel?
- What did the worker try before it crashed?
- Which prompt, model, and context package led to this cost?
- Which memories are trusted enough to inject again?
- Did a collaborator receive the handoff live, or should it read the durable inbox?
- Which generated patch has passed review and is safe to apply?

## What Makes It Different

Projects such as [Ruflo](https://github.com/ruvnet/ruflo) emphasize Claude-oriented orchestration, swarms, plugins, federation, and self-learning workflows. Agent Fabric takes a different position:

| Agent Fabric | Swarm-first orchestration projects |
|---|---|
| Runtime-agnostic substrate for many harnesses | Usually optimized around one runtime or ecosystem |
| SQLite-first durable state, queues, checkpoints, and audit rows | Often prompt/plugin/hook-first |
| Live plus async collaboration with durable inbox fallback | Often live coordination or chat without the same local database contract |
| Cost preflight, approval tokens, and coverage-honest ledgers | Cost tracking is often an add-on |
| Review-gated patch lanes and task packets | Worker output may be more directly applied |
| Local-first, single-developer control plane | Often designed as a broader swarm platform |

The point is not to replace agent runtimes. The point is to make them safer and more useful together.

## Current Capabilities

- **Collaboration:** `collab_send`, inbox reads, asks/replies, decisions, path claims, live SSE fan-out, and durable fallback.
- **Project queues:** dependency-aware task DAGs, concurrency gates, risk buckets, task packets, ready queues, retries, stale-worker recovery, review matrix, and patch review.
- **Worker lifecycle:** task creation, start, heartbeat, events, checkpoints, resume packets, and finish records.
- **Memory:** typed memories, pending-review promotion, confirmations, invalidation, outcome reporting, and guarded injection.
- **Cost control:** model preflight, budget checks, approval tokens, context inspection, provider spend ingestion, anomaly detection, and coverage reporting.
- **Command center:** local browser console over the same daemon APIs for queues, approvals, lanes, memory review, and patch review.
- **DeepSeek side lanes:** optional direct DeepSeek worker adapter for high-context planning, implementation, and review tasks, with sensitive-context scanning.
- **MCP bridge:** stdio MCP surface so IDEs and harnesses can call Agent Fabric tools.

## Architecture

```text
IDE / CLI / worker harness
        |
        | MCP, Unix socket, or local HTTP
        v
Agent Fabric daemon
        |
        +-- SQLite canonical state
        +-- transactional audit and event rows
        +-- live SSE collaboration fan-out
        +-- project queue and worker lifecycle APIs
        +-- cost, memory, and approval surfaces
```

SQLite is canonical. Generated views, SSE pushes, and worker packets are projections over durable state.

## Quick Start

Agent Fabric requires Node.js 24+ because it uses `node:sqlite`.

```bash
npm install
npm run build
npm test
```

Start the daemon:

```bash
AGENT_FABRIC_COST_INGEST_TOKEN="$(openssl rand -base64 32)" npm run dev:daemon
```

If you do not need the HTTP cost-ingest and SSE endpoints, disable HTTP:

```bash
AGENT_FABRIC_HTTP_PORT=off npm run dev:daemon
```

In another shell:

```bash
npm run dev:sim -- status
npm run dev:sim -- doctor
```

Start the local command center:

```bash
npm run dev:desktop -- --port 4573
```

Open `http://127.0.0.1:4573/`.

## Typical Workflow

Create a queue:

```bash
npm run dev:project -- create \
  --project /path/to/project \
  --prompt-file prompt.md \
  --profile careful \
  --max-agents 4
```

Generate and review work:

```bash
npm run dev:project -- start-plan --queue <queueId> --task-file prompt.md
npm run dev:project -- generate-tasks --queue <queueId> --plan-file accepted-plan.md --tasks-file tasks.json
npm run dev:project -- review-queue --queue <queueId> --approve-queue
npm run dev:project -- decide-queue --queue <queueId> --decision start_execution
```

Run ready tasks:

```bash
npm run dev:project -- run-ready \
  --queue <queueId> \
  --parallel 4 \
  --workspace-mode sandbox \
  --cwd-template "/tmp/agent-fabric-sandboxes/{{queueTaskId}}" \
  --task-packet-dir task-packets \
  --command-template "your-worker --task-packet {{taskPacket}}" \
  --approve-tool-context
```

Review proposed patches:

```bash
npm run dev:project -- review-patches --queue <queueId>
npm run dev:project -- review-patches --queue <queueId> --accept-task <queueTaskId> --apply-patch
```

## Optional DeepSeek Worker

For broad tasks, Agent Fabric can delegate planning, implementation, review, risk review, and adjudication to DeepSeek through a direct worker adapter.

```bash
export DEEPSEEK_API_KEY="..."
export AGENT_FABRIC_PROJECT_MODEL_COMMAND="agent-fabric-deepseek-worker model-command --model deepseek-v4-pro --reasoning-effort max"
```

Then run queue lanes with:

```bash
npm run dev:project -- run-ready \
  --queue <queueId> \
  --worker deepseek-direct \
  --parallel 4 \
  --workspace-mode sandbox \
  --task-packet-dir task-packets \
  --approve-tool-context
```

The DeepSeek worker rejects task packets that appear to include secrets unless explicitly overridden.

## Repository Map

| Path | Purpose |
|---|---|
| `src/` | daemon, server, surfaces, CLI, MCP bridge, command center server |
| `src/migrations/` | SQLite schema migrations |
| `test/` | Vitest coverage for daemon, queues, collab, cost, memory, workers, desktop, and DeepSeek adapter |
| `api/` | public tool surface notes |
| `pillars/` | design notes for collaboration, memory, and cost pillars |
| `decisions/` | ADR-style records for architecture decisions |
| `workers/` | optional worker adapters |

## Safety Model

- Mutating tools require authenticated sessions and idempotency keys.
- Messages are inserted durably before live fan-out is attempted.
- Live fan-out is best-effort; the durable inbox remains the source of truth.
- Worker patches are reviewed before application.
- Model calls can be preflighted and gated by approval tokens.
- Cost and context records are stored as sanitized metadata, not raw prompt dumps.
- Sensitive worker packets are scanned before leaving the machine.

## Status

This is an early but working local-first implementation. The test suite covers the current daemon and CLI surfaces, including live collaboration fan-out, project queues, worker lifecycle, approval gates, memory review, cost preflight, and patch review.

Known limitations:

- It is not a multi-tenant service.
- Live fan-out acknowledgements mean the daemon accepted the event, not that a human or agent processed it.
- Cross-machine sync and hosted deployment are future work.
- The command center is intentionally local and utilitarian.

## License

MIT. See [LICENSE](LICENSE).
