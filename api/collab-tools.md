# API — Collab MCP tools

Tool schemas for the collab pillar. Detailed enough that an implementing agent can stub them without further questions, brief enough not to dictate implementation.

All tools return a uniform envelope:

```ts
type ResultEnvelope<T> = { ok: true; tool: string; data: T; warnings?: string[] }
                      | { ok: false; tool: string; code: string; message: string; retryable: boolean };
```

Caller identity comes from the bridge/session protocol, not from tool input. Every mutation is bound to a server-issued `sessionId` and idempotency key as described in [decisions/0008](../decisions/0008-bridge-session-protocol.md).

## `collab_send`

Append a message to the workspace channel. Broadcast or addressed.

**Input:**
```ts
{
  to: string;                   // agent name, or '*' for broadcast
  body: string;                 // markdown
  refs?: string[];              // ["path:line", "path", ...]
  kind?: "broadcast" | "dm" | "decision";  // default 'broadcast' if to='*', else 'dm'
}
```

**Output:**
```ts
{
  messageId: string;
  ts: string;
  mode: "async-only" | "live-and-durable";
  fanoutAttempted: boolean;
  fanoutAckedCount: number;
  deliveryCaveats?: string[];         // present only when mode = "live-and-durable"
}
```

The daemon commits the canonical message row, audit row, and outbox event first. `mode` reports the delivery contract this call honored:

- `"async-only"` (Phase 0A.2): the daemon does not attempt fan-out at all. `fanoutAttempted = false`, `fanoutAckedCount = 0`. Recipients pick up the message via `collab_inbox`. `deliveryCaveats` is omitted — there's nothing live to caveat.
- `"live-and-durable"` (Phase 2+): after durable commit the daemon attempts fan-out to connected bridges. `fanoutAttempted` is `true`. `fanoutAckedCount > 0` means a connected bridge acknowledged receipt of the fan-out event; it does **not** guarantee the IDE surfaced the message to the agent. `deliveryCaveats` enumerates known capability gaps (e.g. `"Codex Desktop notifications observed=no; inbox polling required"`).

This is deliberate: the response shape never claims fan-out behavior the daemon didn't attempt.

## `collab_inbox`

Return messages addressed to the caller (or `*`) since the caller's last-read cursor.

**Input:**
```ts
{
  since?: string;               // ISO timestamp; overrides cursor if provided
  to?: string;                  // override caller identity (test-only)
  max?: number;                 // default 50
  includeAcked?: boolean;       // default false; include 'declined' asks etc.
}
```

**Output:**
```ts
{
  messages: Message[];          // ordered ascending
  cursorAdvancedTo: string | null;  // new last-read message id
  openAsks: AskSummary[];       // open asks addressed to me
}

type Message = {
  id: string;
  ts: string;
  sender: string;
  recipient: string | null;
  kind: "broadcast" | "dm" | "decision";
  body: string;
  refs: string[];
  askId?: string;               // present if this message replies to an ask
};

type AskSummary = {
  askId: string;
  asker: string;
  kind: "opinion" | "review" | "help" | "decision";
  question: string;
  urgency: "low" | "normal" | "high";
  ageMinutes: number;
};
```

## `collab_ask`

Create a tracked ask. Internally this is an A2A-shaped task with messages, status, refs, and artifacts. Returns an `askId` / `taskId` that the recipient will see in their inbox.

**Input:**
```ts
{
  to: string;                   // agent name, or '*' for any
  kind: "opinion" | "review" | "help" | "decision" | "handoff";
  question: string;
  refs?: string[];
  artifacts?: { name: string; uri?: string; mimeType?: string; summary?: string }[];
  urgency?: "low" | "normal" | "high";  // default 'normal'
}
```

**Output:**
```ts
{
  askId: string;
  taskId: string;
  correlationId: string;
  warnings?: string[];          // e.g. "addressee Codex last seen 4h ago, ask will queue"
}
```

## `collab_reply`

Link a reply to an existing ask.

**Input:**
```ts
{
  askId: string;
  status: "accepted" | "answered" | "declined" | "blocked" | "working";
  message: string;              // the reply body
  artifacts?: { name: string; uri?: string; mimeType?: string; summary?: string }[];
}
```

**Output:**
```ts
{ messageId: string; askStatus: string; taskStatus: string }
```

## `claim_path`

Soft-exclusive claim on a glob list. Overlap with another active claim returns the conflict. In `normal` mode, conflicts do **not** create a new active claim.

**Input:**
```ts
{
  paths: string[];              // glob patterns relative to workspace root
  ttl?: number;                 // seconds; default 1800 (30 min); max 3600
  note?: string;                // human-readable purpose
  mode?: "normal" | "handoff" | "supersede" | "force"; // default "normal"
}
```

**Output:**
```ts
{
  claimId?: string;                  // absent when normal-mode conflicts block creation
  expiresAt?: string;
  conflicts?: ClaimConflict[];  // if non-empty, caller must decide
}

type ClaimConflict = {
  claimId: string;
  agent: string;
  paths: string[];
  note: string | null;
  acquiredAt: string;
  expiresAt: string;
};
```

If `mode = "normal"` and `conflicts` is non-empty, no new active claim is recorded. Caller chooses to wait, ask the conflicting agent via `collab_ask`, or retry with an explicit `handoff`, `supersede`, or `force` mode. Those non-normal modes may write an overlapping claim and must emit an explicit reason in audit/outbox events.

## `release_path`

Release a previously-acquired claim.

**Input:**
```ts
{ claimId: string }
```

**Output:**
```ts
{ released: boolean; alreadyReleased?: boolean }
```

## `collab_status`

Active claims + recent heartbeats + open asks for the caller.

**Input:** `{}`

**Output:**
```ts
{
  myOpenAsks: AskSummary[];
  activeClaimsByOthers: ClaimSummary[];
  myClaims: ClaimSummary[];
  presence: PresenceEntry[];    // who's been seen recently

  channelCursor: {
    lastReadMessageId: string | null;
    unreadCount: number;
  };
}

type ClaimSummary = {
  claimId: string;
  agent: string;
  paths: string[];
  note: string | null;
  expiresAt: string;
};

type PresenceEntry = {
  agent: string;
  lastSeen: string;
  currentTask?: string;
};
```

## `collab_decision`

Append-only decision log. Stored in the `decisions` table, not `messages`.

**Input:**
```ts
{
  title: string;
  decided: string;              // the decision in one sentence
  participants?: string[];      // agents that participated; recordedBy comes from session
  rationale?: string;
  supersedes?: string;          // earlier decision id this replaces
}
```

**Output:**
```ts
{ decisionId: string; ts: string; recordedBy: string; participants: string[] }
```

## `collab_heartbeat` (Phase 2)

Publishes presence + current task. Recommended at session start and every N tool calls.

**Input:**
```ts
{
  task: string;                 // 1-line summary of current task
  eta?: string;                 // ISO duration ("PT30M") or absolute ts
}
```

**Output:**
```ts
{ ack: true }
```

## `collab_subscribe` (Phase 2)

Bridge subscribes to live WS topics. Default: bridge auto-subscribes to messages addressed to its agent + `collab.ask` for itself.

**Input:**
```ts
{
  topics: ("collab.message" | "collab.ask" | "collab.claim" | "memory.injected" | "cost.anomaly")[];
}
```

**Output:** `{ subscribed: string[] }`

## Errors

Common error codes:

| Code | Meaning |
|---|---|
| `DAEMON_UNREACHABLE` | Bridge couldn't reach the daemon; agent should bypass or retry |
| `INVALID_RECIPIENT` | `to` field not a known agent and not `*` |
| `ASK_NOT_FOUND` | `askId` doesn't exist or is archived |
| `CLAIM_EXPIRED` | Releasing a claim that already expired |
| `MAX_CLAIMS_EXCEEDED` | Per-agent claim cap (10) |
| `INVALID_GLOB` | A path glob failed to parse |
| `IDEMPOTENCY_CONFLICT` | Same idempotency key was reused with different payload |
| `MISSING_IDEMPOTENCY_KEY` | Mutation reached daemon without bridge idempotency metadata |
