# API — Memory MCP tools

Tool schemas for the memory pillar.

Caller identity, workspace/project namespace, turn ID, and idempotency metadata come from the bridge/session protocol. Tool inputs do not accept caller-controlled agent names or workspace roots except in test mode.

V1 retrieval policy is conservative: auto-injectable hints are limited to `anti_pattern`, user-authored preferences/rules, and mechanically verifiable `semantic` facts. Other types can be written and browsed, but stay passive until paired evals promote them.

## `memory_check`

Retrieve typed memories ranked for the given intent. The hot-path tool — agents call this before tool execution, plan generation, or output start.

**Input:**
```ts
{
  intent: {
    kind: "tool_call" | "plan" | "output" | "implicit";
    tool?: string;                    // for tool_call
    cmd_pattern?: string;             // for tool_call (e.g. "rm -rf")
    args_signature?: string;          // for tool_call
    goal?: string;                    // for plan
    paths?: string[];                 // current paths in scope
    entities?: string[];              // function names, classes, etc.
  };
  types?: ("anti_pattern" | "preference" | "procedural" | "style" | "episodic" | "semantic")[];
  max_tokens?: number;                // default 200
  max_hints?: number;                 // default 2
}
```

**Output:**
```ts
{
  hints: MemoryHint[];
  injectionId: string;                // links to memory_injections table
  traceId?: string;                   // local trace context for this check
  correlationId?: string;             // task/session grouping
  silent_ab: boolean;                 // true if A/B suppressed real returns
}

type MemoryHint = {
  id: string;
  type: string;
  body: string;
  confidence: number;                 // post-decay, post-verify [0,1]
  provenance: {
    source: "auto" | "user" | "transferred";
    confirmedBy: string[];            // agents
    createdAt: string;
    lastSeenAt: string;
  };
  verifierStatus: "pass" | "soft_fail" | "unverifiable" | "unverified";
  refs: string[];
};
```

If `silent_ab` is true, hints will be empty. The agent must not retry — silent A/B is the control arm and the daemon will not return memories for this `intent_hash` for the duration of the turn.

Silent A/B is only allowed for discretionary hints. User-authored preferences, explicit safety rules, and high-severity anti-patterns are never suppressed by the canary arm.

After the agent acts on (or ignores) the hints, it should call `memory_outcome(injectionId, ...)`.

## `memory_outcome`

Best-effort outcome reporting tied to an `injectionId`. Powers counterfactual lift measurement.

**Input:**
```ts
{
  injectionId: string;
  outcome: "success" | "failure" | "abandoned";
  detail?: string;                    // free-text evidence
}
```

**Output:**
```ts
{ ack: true }
```

## `memory_write`

Add a new memory. Goes through the dedup pipeline: an LLM proposes ADD/UPDATE/DELETE/NOOP against existing memories with overlapping intent_keys.

**Input:**
```ts
{
  type: "anti_pattern" | "preference" | "procedural" | "style" | "episodic" | "semantic";
  body: string;
  intent_keys: string[];              // ["bash:rm -rf", "path:/tmp/throwaway/"]
  refs?: string[];                    // citations the verifier will check
  tool_version?: Record<string, string>;  // {pac: "2.5.1"}
  initialConfidence?: number;         // default 0.5; user-curated may set 0.8
  source?: "auto" | "user";           // default 'auto'
  derivation?: "explicit_user_text" | "structured_tool_outcome" | "session_transcript" | "agent_inferred";
  severity?: "low" | "normal" | "high";
  supersedes?: string;                // prior memory id this row corrects; closes prior recorded_until
}
```

**Output:**
```ts
{
  action: "added" | "updated" | "noop" | "deleted";
  id: string;                         // memory id (existing if updated)
  status: "pending_review" | "active" | "quarantined" | "archived";
  injectable: boolean;
  conflicts?: string[];               // ids of memories that contradict this write
}
```

If `action = "deleted"`, the write triggered the deletion of a contradicted memory; the new memory may or may not have been added depending on the dedup verdict.

Auto-written memories start `pending_review` unless derived from explicit user text or a structured tool outcome. Session-transcript and agent-inferred memories are not injectable until user review, paired eval promotion, or independent evidence confirms them.

Corrections are append-only. Passing `supersedes` inserts a new memory row and sets the superseded row's `recorded_until`; it does not rewrite the old row's body.

## `memory_invalidate`

Mark a memory invalid (sets `invalid_at`). Does not delete.

**Input:**
```ts
{
  id: string;
  reason: string;                     // free-text; logged to audit
  evidence?: string[];                // refs that support invalidation
}
```

**Output:**
```ts
{ ack: true; previousConfidence: number }
```

## `memory_confirm`

Increment confidence + add to confirmations list. Used when an agent observes the memory's claim hold.

**Input:**
```ts
{
  id: string;
  evidence?: string;
}
```

**Output:**
```ts
{ newConfidence: number; confirmationCount: number; status: "pending_review" | "active" | "archived" | "quarantined" }
```

## `memory_review`

Direct human review for pending memories. This is the one-developer local-tool path; it does not require two independent agent confirmations.

**Input:**
```ts
{
  id: string;
  decision: "approve" | "reject" | "archive";
  reason?: string;
  evidence?: string[];
}
```

**Output:**
```ts
{
  id: string;
  decision: "approve" | "reject" | "archive";
  previousStatus: string;
  status: "pending_review" | "active" | "archived" | "quarantined";
  memory: MemoryRecord;
}
```

`approve` promotes a current, non-archived memory to `active` and raises confidence to at least `0.8`. `reject` archives and invalidates a noisy/wrong candidate. `archive` hides a candidate without marking it false.

## `memory_audit_lift`

Live counterfactual lift report. This is a drift canary, not the release gate for retrieval changes.

**Input:**
```ts
{
  windowDays?: number;                // default 30
  type?: string;                      // optional type filter
  agent?: string;                     // optional agent filter
}
```

**Output:**
```ts
{
  windowDays: number;
  successWithMemory: number;          // [0,1]
  successWithoutMemory: number;       // [0,1] (silent A/B arm)
  liftPct: number;                    // (with - without) * 100
  nWith: number;
  nWithout: number;
  outcomeCoveragePct: number;
  outcomeCoverageByAgent: Record<string, number>;
  outcomeCoverageByHost: Record<string, number>;
  perTypeLift: Record<string, { lift: number; n: number }>;
  warnings: string[];                 // e.g. "n_without < 30; weak signal"
}
```

## `memory_eval_report`

Paired eval report for retrieval/type-policy changes. This is the release gate before broadening auto-injection classes.

**Input:**
```ts
{
  suite?: string;                     // default "memory-v1"
  since?: string;                     // optional, return recent reports
}
```

**Output:**
```ts
{
  suite: string;
  generatedAt: string;
  passed: boolean;
  cases: {
    id: string;
    category: "anti_pattern" | "stale_memory" | "wrong_type" | "namespace" | "preference";
    withMemory: { passed: boolean; score?: number };
    withoutMemory: { passed: boolean; score?: number };
    delta?: number;
  }[];
  warnings: string[];
}
```

## `memory_list`

Browse memories. For user inspection at end-of-session, or for agents to enumerate.

**Input:**
```ts
{
  type?: string;
  status?: "pending_review" | "active" | "archived" | "quarantined";
  namespace?: string;                 // default: current workspace
  since?: string;                     // ISO ts
  archived?: boolean;                 // default false
  max?: number;                       // default 50
}
```

**Output:**
```ts
{
  memories: MemoryRecord[];           // full records, not just hints
  total: number;
}
```

## `memory_check_plan` (Phase 3)

Higher-level retrieval for planning. Same shape as `memory_check` but `kind: "plan"` defaults change which types are queried.

## `memory_check_style` (Phase 3)

Session-start style memory fetch. Cached for the session; no per-call latency cost.

**Input:** `{}`

**Output:**
```ts
{ stylePreferences: MemoryHint[] }
```

## `memory_export` (Phase 3)

Manual cross-project transfer. Not auto-invoked.

**Input:**
```ts
{
  from_ns: string;
  to_ns: string;
  ids: string[];
}
```

**Output:**
```ts
{
  transferred: { id: string; newId: string; newConfidence: number }[];
}
```

Imported memories carry `transferred_from = from_ns` and confidence × 0.6.

## `memory_diff` (Phase 3)

What was learned this session — for end-of-session review.

**Input:**
```ts
{
  since?: string;                     // default: session start
}
```

**Output:**
```ts
{
  added: MemoryRecord[];
  updated: { id: string; diff: string }[];
  invalidated: { id: string; reason: string }[];
  injectionsByType: Record<string, number>;
  liftEstimate?: { lift: number; n: number };  // partial, this-session-only
}
```

## Errors

Common error codes:

| Code | Meaning |
|---|---|
| `MEMORY_NOT_FOUND` | `id` doesn't exist |
| `INVALID_INTENT` | `intent.kind` missing or unknown |
| `WARM_UP_GATED` | Store has too few high-confidence memories of this type; no retrieval yet |
| `VERIFIER_FAILED` | Verifier itself errored (network, missing tool); transient |
| `DAEMON_UNREACHABLE` | Bridge couldn't reach the daemon; agent should proceed without memory |
| `MEMORY_TYPE_PASSIVE` | Requested type is stored but not auto-injectable under current eval policy |
| `IDEMPOTENCY_CONFLICT` | Same idempotency key was reused with different payload |

## Performance targets

- `memory_check` p95 < 100 ms warm cache, < 250 ms cold.
- `memory_write` p95 < 300 ms (includes dedup LLM call).
- `memory_audit_lift` p95 < 500 ms.

`memory_check` failure or timeout returns empty hints rather than blocking the agent.
