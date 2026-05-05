# Pillar 2 — Memory

## Goal

Give the multi-agent workspace a typed, cross-session memory that:

- **Learns from mistakes** — when an agent runs a wrong command, realizes it, and corrects, that pair becomes a retrievable anti-pattern.
- **Learns preferences** — when the user says "I prefer HAR-driven RE for unknown APIs," that becomes a positive pattern injected on RE intent.
- **Checks at decision points, not at session start** — relevant memories arrive at the moment they matter (pre-tool-call, pre-plan, pre-output), capped at a hard token budget per turn.
- **Starts conservative** — v1 auto-injects only anti-patterns, explicit user rules/preferences, and mechanically verifiable semantic repo facts. Procedural, episodic, and style memories are stored/browseable until eval-backed.
- **Is advisory, never blocking** — agents see memories with confidence + provenance and decide. Memory loses to current-turn evidence.
- **Doesn't pollute** — namespaced by workspace, decayed by recency + access count, deletable on contradiction.
- **Is measured** — paired evals for release gates, counterfactual logging as live drift canary. Without both, we ship regressions silently.

## Non-goals

- Not a generic RAG system over the codebase. Code-aware retrieval is a *key*, not a content source.
- Not a knowledge graph over the world. Scope is `~/projects/Workspace/`.
- Not cross-project memory transfer in v1. Empirically pollutes; defer until evidence demands it.

## Information gathered

See [research/memory-deep-dive.md](../research/memory-deep-dive.md) for the full survey.

Key findings shaping the design:

- **Type-bind retrieval, don't similarity-only.** AutoGPT dropped vector DBs after similarity-only retrieval kept fetching wrong-type memories. Marco Somma's 500-experiment writeup nails it: *binding* is the bottleneck, not recall.
- **Verify-before-inject** is the load-bearing pattern. GitHub Copilot's agentic memory re-checks every memory's citation against live code before injection; stale memories self-rewrite.
- **Measurement needs both fixed evals and live canaries.** GitHub Copilot's published study (+7pp PR merge rate, p<0.00001) is the strongest large-scale evidence that this kind of system can work, while MemoryAgentBench shows it can regress. Most projects ship without measuring either.
- **MemoryAgentBench** (arXiv 2507.05257) found RAG-memory often *underperforms* simple long-context. If you don't measure, you ship a regression.
- **LangMem evidence:** procedural memory *hurts* QA tasks while helping planning. Wrong-type injection is actively harmful.
- **Memory poisoning** is a documented attack surface (MINJA: 95% ASR; Microsoft AI Recommendation Poisoning Feb 2026; eTAMP cross-session persistence). Tenant/session/project namespacing is the universal mitigation.

## Memory types (the typing matters more than the storage)

| Type | Example | Trigger signal | Lifetime |
|---|---|---|---|
| **Anti-pattern** | "Tried `pac canvas push` for component-heavy app, broke component refs, use solution-swap-import instead" | Tool-call intent matches a recorded failure | Decay after 60 days unless reconfirmed; tool-version-tagged |
| **Preference** | "User prefers HAR-driven RE for unknown APIs" | Task intent matches a stated preference | Long-lived; user can edit via `~/.workspace/preferences.yaml` |
| **Procedural** | "To list flows in CoE Dev: Dataverse `workflows` table, not connector (truncates at scale)" | Choosing between equivalent tools / methods | Long-lived; passive in v1 until eval-backed |
| **Style** | "User wants terse responses, no trailing summary" | Pre-output generation | Long-lived; user-curated; session-start only in v1 |
| **Episodic** | "On April 22, deploy of SAM v1.5.18 failed because Copilot quota exhausted; route via pipecat /summarize" | Recall on similar context | Decay after 90 days; passive in v1 |
| **Semantic** | "Repo uses pnpm + TS; existing daemon LaunchAgent is `ai.openclaw.gateway`" | Implicit context when working in workspace | Refresh on workspace fingerprint update |

The split matters because retrieval is type-aware. A `Bash` tool intent retrieves anti-patterns + procedural; a "starting a long answer" intent retrieves style. The wrong-type-hurts evidence from LangMem is the reason this matters.

## Decision-point injection

Memory is queried by the agent at three points, never automatically dumped:

1. **Pre-tool-call (`memory_check`)** — agent passes intent: `{tool, args_signature, paths, ts_intent}`. In v1, daemon returns up to 2 hints only from eligible classes: `anti_pattern`, explicit user rules/preferences, mechanically verifiable `semantic`.
2. **Pre-plan (`memory_check_plan`)** — agent passes high-level intent: `{goal, kind: "research" | "implement" | "debug"}`. Stored but not auto-injected until paired evals pass.
3. **Pre-output (`memory_check_style`)** — invoked once at session start to fetch user-curated style memories, then cached for the session. Auto-extracted style remains passive until eval-backed.

The agent decides when to call. We do *not* hide memories behind tool wrappers and force-inject — that breaks the "advisory not blocking" principle.

## V1 eligibility policy

| Type | V1 behavior | Why |
|---|---|---|
| `anti_pattern` | Auto-inject after verify-before-inject | Primary value: prevent repeated concrete mistakes. Usually references commands, paths, versions. |
| `preference` | Auto-inject only when user-authored or imported from `preferences.yaml` | User intent is explicit; auto-extracted preferences are too easy to overfit. |
| `semantic` | Auto-inject only when mechanically verifiable | Repo facts can be checked against files/lockfiles/commands. |
| `procedural` | Browseable/passive | Wrong-type procedural hints are documented to hurt QA/output tasks. |
| `episodic` | Browseable/passive | Useful context, but stale and hard to verify. |
| `style` | User-curated session-start only | Auto-extracted style can become sycophantic or contradictory. |

Auto-written memories start `pending_review` unless derived from explicit user text or a structured tool outcome. Memories inferred from session transcripts or untrusted content are quarantined from injection until user review, paired eval promotion, or independent evidence confirms them.

## Verify-before-inject

Each candidate memory goes through a typed verifier before it's returned:

| Memory references | Verifier |
|---|---|
| File path | `fs.existsSync` (cached for the request) |
| Command in PATH | `which $cmd` |
| Tool version (e.g. `pac 2.5.1`) | `pac --version` cached for 1 hour |
| Repo state ("we use pnpm") | `package.json` lockfile check |
| Specific commit hash | `git cat-file -e $sha` |
| External URL endpoint | not verified at inject time; flagged as unverifiable |

A memory whose verifier fails has its confidence reduced by 0.3 and is auto-marked `needs_review`. After three consecutive failures, it's archived.

## Confidence + provenance + decay

Every memory carries:

```json
{
  "id": "mem_2026-04-26_001",
  "type": "anti_pattern",
  "body": "...",
  "intent_keys": ["bash:rm -rf", "path:/tmp/throwaway/"],
  "confidence": 0.7,
  "created_at": "2026-04-26T...",
  "last_seen_at": "2026-04-28T...",
  "access_count": 4,
  "confirmations": [
    {"by": "Claude Code", "at": "2026-04-26T..."},
    {"by": "Codex", "at": "2026-04-28T..."}
  ],
  "contradictions": [],
  "tool_version": {"pac": "2.5.1"},
  "valid_from": "2026-04-26",
  "invalid_at": null,
  "namespace": "/path/to/workspace"
}
```

- **Confidence** ∈ [0,1]. +0.1 per confirmation, −0.2 per contradiction. Below 0.3 → archived.
- **Decay**: `effective_confidence = confidence × exp(-days_since_last_seen / 60)` for retrieval ranking.
- **Provenance**: distinct-agent confirmations add a small boost (+0.1 each, capped at +0.2). This is signal, not independent proof, because agents can share context.
- **Temporal invalidation**: when superseded, set `invalid_at` instead of deleting. Retrieval ignores invalidated; audit can still see them.

## Evaluation and counterfactual logging (the most important feature)

Paired evals are the release gate for retrieval changes and type-promotion changes. A Promptfoo-style local harness should run the same task pairs with memory enabled/disabled and assert against expected behavior. The first suite should cover:

- concrete anti-pattern avoidance
- stale path/version memory suppression
- wrong-type procedural memory not appearing in QA/output contexts
- project-root namespace isolation
- user preference precedence over auto-learned memories

Live counterfactual logging stays on from day one, but it is a canary for drift between evals and real work, not the primary proof that memory helps.

Silent A/B only applies to discretionary hints. The daemon must never suppress user-authored preferences, explicit safety rules, or high-severity anti-patterns, because hiding those can violate user intent or make destructive behavior more likely.

Every `memory_check` call writes a row:

```sql
CREATE TABLE memory_injections (
  id TEXT PRIMARY KEY,                         -- UUIDv7
  ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  turn_id TEXT NOT NULL,                     -- agent-supplied, links to session
  agent TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  intent_payload JSON NOT NULL,
  memories_returned JSON,                    -- list of {id, confidence}
  silent_ab BOOLEAN NOT NULL DEFAULT FALSE,  -- true if A/B suppressed eligible discretionary returns
  silent_ab_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  outcome TEXT,                              -- 'success' | 'failure' | 'abandoned' | NULL
  outcome_detail TEXT,
  reported_at TIMESTAMP
);
```

After the agent completes the action, an outcome callback (best-effort) updates the row.

**Lift query**:

```sql
SELECT
  COUNT(*) FILTER (WHERE memories_returned IS NOT NULL AND outcome = 'success') * 1.0 /
  COUNT(*) FILTER (WHERE memories_returned IS NOT NULL) AS success_with_memory,
  COUNT(*) FILTER (WHERE silent_ab AND outcome = 'success') * 1.0 /
  COUNT(*) FILTER (WHERE silent_ab) AS success_without_memory
FROM memory_injections
WHERE ts > datetime('now', '-30 days');
```

If `success_with_memory` is not directionally higher than `success_without_memory`, the system is at best neutral and at worst harmful. We act on the data, but we do not pretend one-developer live traffic gives clean statistical power.

## Cross-domain transfer

**Default: off.** Memories carry a `namespace` (project path) and retrieval scopes by namespace. The empirical evidence (eTAMP, MINJA) says cross-project transfer pollutes more than it helps.

Opt-in path: a manual `memory_export({from_ns, to_ns, ids})` tool the user invokes to copy specific memories across projects. Imported memories carry a `transferred_from` field and start at confidence × 0.6 until reconfirmed.

## User-curated preferences

A file at `~/.workspace/preferences.yaml`:

```yaml
preferences:
  - "I prefer HAR-driven approaches for reverse-engineering unknown APIs"
  - "Always commit small atomic changes; never amend a published commit"
  - "Terse responses, no emoji, no trailing summary"
  - "When editing canvas YAML, ctxEditRow over OnSuccess patches"
```

Daemon embeds + ingests these as `preference`-type memories. They always win on tie-break against auto-learned memories.

## Tool surface (Phase 1)

| Tool | Description |
|---|---|
| `memory_check({intent, paths?, types?, max_tokens?})` | Retrieve typed memories ranked by `confidence × recency × similarity`. V1 only returns auto-injectable classes listed above. Default 2 hints, 200-token cap. |
| `memory_write({type, body, intent_keys, refs?, derivation?, severity?})` | Add a new memory. Goes through dedup pipeline (mem0-style ADD/UPDATE/DELETE/NOOP). Auto-written memories start `pending_review` unless derived from explicit user text or structured tool outcomes. |
| `memory_invalidate({id, reason})` | Mark a memory invalid. Logs reason for audit. |
| `memory_confirm({id, evidence})` | Bump confidence + add to confirmations. |
| `memory_audit_lift({window_days})` | Counterfactual lift report. |
| `memory_list({type?, namespace?, since?})` | Browse memories for the user to review. |
| `memory_eval_report({suite?})` | Paired eval report for retrieval/type policy changes. Release gate for broadening injection. |

## Tool surface (Phase 3)

| Tool | Description |
|---|---|
| `memory_check_plan({goal, kind})` | Higher-level retrieval for planning. |
| `memory_check_style()` | Session-start style memory fetch. |
| `memory_export({from_ns, to_ns, ids})` | Manual cross-project transfer. |
| `memory_diff({since})` | What was learned this session — for end-of-session review. |

## Storage schema (memory tables)

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                      -- 'anti_pattern' | 'preference' | 'procedural' | 'style' | 'episodic' | 'semantic'
  namespace TEXT NOT NULL,
  body TEXT NOT NULL,
  body_embedding BLOB,                     -- nomic-embed-text vector
  intent_keys JSON NOT NULL,               -- ["bash:rm -rf", "path:/tmp/throwaway/"]
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'pending_review',
  severity TEXT NOT NULL DEFAULT 'normal',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  access_count INTEGER NOT NULL DEFAULT 0,
  confirmations JSON NOT NULL DEFAULT '[]',
  contradictions JSON NOT NULL DEFAULT '[]',
  tool_version JSON,
  refs JSON,
  valid_from TIMESTAMP,
  invalid_at TIMESTAMP,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  source TEXT NOT NULL,                    -- 'auto' | 'user' | 'transferred'
  transferred_from TEXT,
  created_by_session_id TEXT,
  created_by_agent_id TEXT
);
CREATE INDEX idx_memories_type_ns ON memories(type, namespace, archived);
CREATE INDEX idx_memories_intent ON memories(namespace, archived) WHERE archived = FALSE;
```

## Retrieval algorithm (v1)

```
1. Filter by namespace = workspace_root.
2. Filter by archived = FALSE, invalid_at IS NULL.
3. Filter by intent_keys overlap with request.intent_keys (set intersection).
4. For each candidate:
     score = effective_confidence(memory) × similarity(intent, memory.body_embedding)
     boost  = min(0.2, 0.1 * distinct_confirming_agents)
     final  = score + boost
5. Rank, take top-k where sum(estimated_tokens) ≤ max_tokens.
6. Verify each. Drop on verifier fail; flag confidence haircut.
7. Return [{id, body, confidence, provenance}], cap k=2 by default.
```

## Open questions

1. **Embedding model.** Nomic-embed-text (local, free) vs OpenAI text-embedding-3-small (API). Local is consistent with the local-first ethos but slower on first warm.
2. **AST keys (Phase 3) — incremental update story.** Tree-sitter is fast on save, but cross-file refactors invalidate many keys at once. Unclear if incremental is worth the complexity vs nightly rebuild.
3. **Outcome detection.** "Did this go well?" is the hardest input. Best-effort heuristics: tool-call return code, agent's next reflection, user confirmation. We accept noise here.
4. **Memory pollution from auto-extraction.** First two weeks will be noisy. Pending-review quarantine + confidence threshold + warm-up gate (no retrieval until N≥20 memories of high-confidence) is the mitigation. The user reviews diffs at session end.
5. **Eval suite location.** In-tree `agent-fabric/evals/` makes the design reproducible; `~/.agent-fabric/evals/` keeps personal traces out of the repo. Lean in-tree for sanitized fixtures.

## Risks specific to this pillar

- **Sycophantic confirmation bias.** Agent reads "X failed" and skips X, never discovers X works now. Mitigation: paired evals, silent A/B + visible memory metadata. Documented as an open area in the field.
- **Wrong-type injection** (LangMem evidence). Mitigation: `types` filter on every `memory_check` call; if intent is QA-shaped, don't return procedural.
- **Memory poisoning.** Even single-developer setups can ingest a malicious snippet. Mitigation: namespace strictly, log every `memory_write` source, quarantine auto-written memories unless derived from explicit user text or structured tool outcomes, audit periodically.
- **Latency.** 50–200 ms per `memory_check` call. Mitigation: in-process LRU cache keyed by `(intent_hash, paths_hash)`, 90% cache hit target.

## Done definition for Phase 1

- Three memory types live (`anti_pattern`, `preference`, `semantic`), with `procedural`/`episodic`/`style` stored but passive unless user-curated.
- `memory_check` returns eligible ranked hints in p95 < 100 ms (warm cache).
- `memory_injections` table populated; first lift report runs at week 2.
- Verify-before-inject implemented for at least: file paths, commands in PATH, `pac --version`.
- Paired eval harness exists and fails closed for retrieval/type-policy changes.
- Auto-written session-transcript memories are pending-review and never injectable by default.

## Done definition for Phase 3

- AST-based keys for code-tied memories work for at least TypeScript and Python.
- Procedural promotion: a memory confirmed by 2 distinct agents auto-upgrades from anti-pattern to procedural.
- Cross-agent confidence boost is observable in retrieval rankings.
- 30-day lift report shows positive lift on at least one defined metric, or we re-evaluate the pillar.
