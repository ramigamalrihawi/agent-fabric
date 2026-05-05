# Pillar 1 — Collab

## Goal

Enable two or more agents (Claude Code, Codex VS Code extension, Codex desktop, Cursor, future Roo Code) running in the same workspace to:

- **Find each other's recent work** without reading 400 lines of `channel.md` every session start.
- **Address each other directly** with messages that have a clear addressee, not just broadcasts.
- **Ask questions and get tracked replies**, with correlation IDs so an unanswered ask is visible.
- **Represent handoffs as task-shaped work**, not just freeform chat, so agent-to-agent collaboration can later map to A2A without redesign.
- **Avoid duplicating each other's work** via path/lane claims with overlap detection.
- **See each other's presence** when sessions happen to overlap.
- **Receive each other's messages live** when both sessions are open simultaneously, while remaining fully functional when sessions don't overlap (the more common case).
- **Know what delivery mode is real per host** — live notifications where supported, polling where not, with capability metadata instead of assumptions.

## Non-goals

- Not a chat UI. Everything is MCP tools.
- Not a project-management system. Tasks belong to TodoWrite per session, not to the channel.
- Not a CRDT-backed shared editor. SQLite single-writer is fine for messaging.

## Information gathered

### Current state (`.ai-collab/`)

The workspace already has a homegrown collab system at `ai-collab/server.js`:

- 5 MCP tools: `collab_init`, `collab_send`, `collab_read`, `collab_digest_read`, `collab_digest_update`.
- Append-only Markdown files: `channel.md`, `project-digest.md`, `PROTOCOL.md`.
- `collab_send` accepts an optional `sender` field (default: "Claude Code"). All other agents must be addressed via plain English in the message body.

**Observed friction in production use** (this thread, late April 2026):
- `channel.md` is 400+ lines, mostly from March; new agents re-read everything to find recent work.
- Both agents have edited `project-digest.md` simultaneously, producing linter conflicts at least twice in this session.
- No way to know whether Codex saw a question; the only signal is whether they replied later.
- Near-misses on duplicate work (capture fixture, Phase 0 src/) — both agents reached for the same task within hours of each other.

### Ecosystem survey (see [research/ecosystem-survey.md](../research/ecosystem-survey.md))

Closest projects:

- **TeamMCP** ([cookjohn/teammcp](https://github.com/cookjohn/teammcp)) — SQLite WAL, 44 tools, validated on Claude Code + Codex over 5 days / 3000 messages. Best inbox-summarization-on-reconnect pattern in the field.
- **session-coord-mcp** ([LingFeng-Vels/session-coord-mcp](https://github.com/LingFeng-Vels/session-coord-mcp)) — exact use case (parallel Claude + Codex). Best `claim_path` / `release_path` semantics.
- **AgenticComm** ([agentralabs/agentic-comm](https://github.com/agentralabs/agentic-comm)) — minimal Rust+MCP, real pub/sub primitives.
- **AgentBridge** ([raysonmeng/agent-bridge](https://github.com/raysonmeng/agent-bridge)) — daemon-survival across IDE restarts, WS control channel.

## Decisions

| Decision | ADR |
|---|---|
| One daemon, three MCP surfaces (collab is one of them) | [decisions/0001](../decisions/0001-single-daemon-vs-three-mcp-servers.md) |
| SQLite WAL primary, Markdown view emitted on write | [decisions/0002](../decisions/0002-sqlite-wal-as-primary-store.md) |
| Bridge/session identity before pillar semantics | [decisions/0008](../decisions/0008-bridge-session-protocol.md) |
| Transactional outbox for audit/correlation | [decisions/0009](../decisions/0009-event-log-with-projections.md) |
| MCP + A2A-shaped tasks | [decisions/0010a](../decisions/0010a-mcp-and-a2a-task-envelope.md) |

## Tool surface (Phase 0A.2)

All tools dispatched via the MCP bridge → daemon WebSocket. Detailed schemas in [api/collab-tools.md](../api/collab-tools.md).

| Tool | Description |
|---|---|
| `collab_send({to, body, refs?, kind?})` | Append message to SQLite, commit, then attempt fan-out. Sender identity comes from the server-issued bridge session. Output reports `fanoutAttempted`, `fanoutAckedCount`, and delivery caveats rather than promising visible live delivery. |
| `collab_inbox({since?, to?})` | Return messages newer than the caller's last-read cursor (or `since`). Default: addressed-to-me + `*` since cursor. |
| `collab_ask({to, kind, question, refs?, urgency?})` | Creates a tracked ask backed by an A2A-shaped task with `askId` / `taskId`. `kind` ∈ {`opinion`, `review`, `help`, `decision`, `handoff`}. |
| `collab_reply({askId, status, message})` | Links to ask. `status` ∈ {`accepted`, `answered`, `declined`, `blocked`}. |
| `claim_path({paths, ttl?, note, mode?})` | Soft-exclusive claim on a glob list. In `normal` mode, overlap returns conflicts without creating a new active claim. `handoff`, `supersede`, and `force` can create overlapping claims with explicit audit reasons. |
| `release_path({claimId})` | Releases a claim. Auto-released after `ttl`. |
| `collab_status()` | Active claims + recent heartbeats + open asks for me. |
| `collab_decision({title, decided, participants?, rationale, supersedes?})` | Append-only decision log. `recordedBy` comes from the session; `participants` is caller-supplied context. |

## Tool surface (Phase 2)

| Tool | Description |
|---|---|
| `collab_heartbeat({task, eta?})` | Per-agent presence signal. Recommended at session start and tool boundaries. |
| `collab_subscribe({topics})` | Bridge subscribes to live WS topics; default behavior is store-and-forward via inbox. |
| `collab_archive({before})` | Move pre-`before` messages to `archive/` and reset cursor baseline. |

## Storage schema (collab tables)

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,                 -- UUIDv7
  ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sender TEXT NOT NULL,
  session_id TEXT NOT NULL,
  origin_peer_id TEXT NOT NULL,
  recipient TEXT,                    -- NULL = broadcast, '*' = explicit any
  kind TEXT NOT NULL,                -- 'broadcast' | 'dm' | 'decision'
  body TEXT NOT NULL,
  refs JSON,                         -- ["path:line", ...]
  ask_id TEXT                       -- non-null for replies
);
CREATE INDEX idx_messages_recipient_ts ON messages(recipient, ts);

CREATE TABLE asks (
  id TEXT PRIMARY KEY,                 -- UUIDv7
  ts_created TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ts_updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  asker TEXT NOT NULL,
  recipient TEXT NOT NULL,           -- agent name or '*'
  kind TEXT NOT NULL,                -- 'opinion' | 'review' | 'help' | 'decision'
  urgency TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open',
  question TEXT NOT NULL,
  refs JSON
);
CREATE INDEX idx_asks_recipient_status ON asks(recipient, status);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,                 -- UUIDv7
  ts_created TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ts_updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  requester TEXT NOT NULL,
  assignee TEXT NOT NULL,              -- agent name or '*'
  kind TEXT NOT NULL,                  -- 'opinion' | 'review' | 'help' | 'decision' | 'handoff'
  status TEXT NOT NULL,                -- A2A-shaped lifecycle: submitted|working|input_required|completed|failed|canceled
  correlation_id TEXT NOT NULL,
  refs JSON,
  artifacts JSON NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_tasks_assignee_status ON tasks(assignee, status);

CREATE TABLE claims (
  id TEXT PRIMARY KEY,                 -- UUIDv7
  ts_created TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ts_expires TIMESTAMP,
  agent TEXT NOT NULL,
  paths JSON NOT NULL,               -- glob list
  note TEXT,
  mode TEXT NOT NULL DEFAULT 'normal',
  overlapping BOOLEAN NOT NULL DEFAULT FALSE,
  released BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX idx_claims_active ON claims(released, ts_expires) WHERE released = FALSE;

CREATE TABLE cursors (
  agent TEXT PRIMARY KEY,
  last_read_message_id TEXT,
  last_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,                 -- UUIDv7
  ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  title TEXT NOT NULL,
  decided TEXT NOT NULL,             -- the decision itself
  recorded_by_agent_id TEXT NOT NULL,
  participants_json JSON NOT NULL DEFAULT '[]',
  rationale TEXT,
  supersedes TEXT
);
```

The implementation schema source of truth is [decisions/0012](../decisions/0012-schema-summary.md); the table snippets here describe pillar-specific intent.

## Live push: how it actually works

The default mode is **async-durable, opportunistically live.**

1. Agent A's bridge calls `collab_send`.
2. Daemon writes to `messages`, `audit`, and `events` in one transaction.
3. After commit, daemon broadcasts a `collab.message` event on WS.
4. Agent B's bridge:
   - If connected and subscribed: receives the event. If the IDE surfaces MCP `notifications/message`, the agent sees it without polling.
   - If connected but the IDE doesn't surface notifications well: the next `collab_inbox()` (or any other tool call) returns the new message.
   - If not connected (B's IDE not open): message persists; B sees it on session start.

The bridge polls inbox every 5 s as a safety net, configurable per IDE. The 5 s budget is below the threshold where users perceive lag in chat UX.

Live delivery status is reported by host capability, not promised globally. If Codex desktop does not surface MCP notifications, `collab_status` should say so and the polling fallback becomes the documented path for that host.

## Open questions

1. **MCP notifications surfacing varies wildly across IDEs.** Claude Code surfaces some, Codex extension less, desktop apps unknown. Should we instrument each IDE's behavior empirically before promising "live"?
2. **Heartbeat granularity.** Per-tool-call is too noisy; per-session-start is too coarse. Probably "every N tool calls or every M minutes." TBD.
3. **Path claim conflict actions.** Advisory remains the default, but the API needs explicit `handoff`, `supersede`, or `force` semantics so repeated collisions do not become clutter.
4. **Decision-log promotion from messages.** Should `collab_decision` be a fresh tool, or auto-promote messages tagged `kind='decision'`? Probably both.

## Risks specific to this pillar

- **Linter conflicts on the Markdown view.** Mitigated by exporting Markdown under `~/.agent-fabric/views/` as a read-only side-channel; agents must write through the daemon.
- **Sender spoofing.** Mitigated by binding writes to bridge sessions. Tool input does not accept caller-controlled sender identity.
- **Stale claims after IDE crash.** Claims have TTL; daemon prunes on every claim query. No zombie claims should exist > 1 hour past TTL.
- **Cross-IDE notification gap.** If MCP notifications truly don't surface in some IDE, we ship the polling fallback and document it as a known limit.

## Done definition for Phase 0A.2

- All eight v1 tools registered, functional, smoke-tested via two simulated bridge connections.
- Human-readable view exported under `~/.agent-fabric/views/channel.md`; optional compatibility export to `.ai-collab/channel.md` for one week without divergence.
- Cursor-based inbox returns 0 messages on the second consecutive call when no new activity.
- `claim_path` normal mode returns conflicts without recording a new claim; smoke test with two contending agents.

## Done definition for Phase 2

- Two simultaneously-open IDEs receive each other's messages within 1 s on at least one of {Claude Code, Codex} (the duo we actually use).
- `collab_ask` ID round-trips with `collab_reply` and `collab_status` shows the open count accurately.
- 1 week of usage with no manual intervention to clear stale state.
