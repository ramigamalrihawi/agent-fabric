# Pillar 3 — Costs

## Goal

Give the developer a unified, coverage-aware view of LLM + GPU spend across every provider in this workspace, with **real Azure billing data** (not synthetic token×price estimates), live estimates where instrumentation exists, per-feature attribution, idle-resource detection, and concrete cost-reduction suggestions that don't degrade quality.

Specifically:

- "What did I spend this month so far?" — answerable inline by any agent in 1 s, with source/freshness/coverage caveats visible.
- "What's costing me the most right now?" — top 5 deployments + top 5 features.
- "What's idle?" — Foundry deployments with 0 requests in 7 days, RunPod stopped pods burning storage, OpenRouter unused virtual keys.
- "Can I save money without quality loss?" — Pareto-curve answers, evidence-backed.

## Non-goals

- Not a billing portal replacement. Augments Azure / RunPod / Vultr / OpenRouter dashboards; doesn't replace them.
- Not a tax / accounting tool. Cost data is for engineering decisions, not finance.
- Not a multi-tenant FinOps platform. One developer's spend across their providers.

## Information gathered

The user runs models across at least:

- **Azure AI Foundry / Azure OpenAI** — production deployments (SAM v1.5.x, Copilot Studio agents, GPT-5.4 family).
- **OpenRouter** — for browser-agent and Continue agents (planner + vision).
- **RunPod GPU** — optional external GPU runtime with hourly and storage costs.
- **Vultr GPU** — optional external GPU runtime with hourly and snapshot costs.
- **Anthropic API** — direct provider billing when used by a harness.
- **OpenAI API** — direct or proxy-routed provider billing.

Existing pieces:

- `browser-agent/src/utils/costTracker.ts` — already tracks per-call cost for browser-agent.
- Provider credentials should come from explicit environment variables or a local secret manager, never from checked-in files.
- LiteLLM can be used as the managed proxy for controllable clients; expose uncovered clients explicitly.

Memory-relevant facts (per existing CLAUDE.md):

- **STOP vs TERMINATE** on RunPod/Vultr is documented: STOP preserves volume but still bills storage. The user already has a memory rule about this.
- **Stopped-pod storage drag**: ~$0.10/GB/mo. 100 GB volume × 5 stopped pods = $50/mo silent burn. Currently invisible to the user.

### Ecosystem survey

Closest projects:

- **LiteLLM Proxy** ([BerriAI/litellm](https://github.com/BerriAI/litellm)) — gateway for 100+ providers with built-in `/spend/logs`, virtual keys with budget caps, Prometheus metrics. **Adopted as the managed proxy for coverable traffic.**
- **Langfuse** ([langfuse/langfuse](https://github.com/langfuse/langfuse)) — per-trace cost attribution, evals, dashboards. Self-hostable. **Adopted in Phase 4 for per-feature tags + Pareto evals.**
- **OpenLIT** ([openlit/openlit](https://github.com/openlit/openlit)) — OpenTelemetry-native, tracks GPU power/util plus tokens. **Useful for GPU idle detection; Phase 4.**
- **Microsoft FinOps Toolkit** ([microsoft/finops-toolkit](https://github.com/microsoft/finops-toolkit)) — Power BI dashboards + KQL queries against Cost Management exports. **Adopted: steal the KQL queries; skip the Power BI part.**
- **Azure Cost Management REST API** — the *only* source of real Azure billing (PTU, pay-go, idle hours). **Polled hourly.**

## Decisions

| Decision | ADR |
|---|---|
| LiteLLM as managed proxy for coverable traffic | [decisions/0003](../decisions/0003-litellm-as-universal-proxy.md) |
| Real Azure data + cache, not live API per query | [ARCHITECTURE.md](../ARCHITECTURE.md#azure-cost-management-poller) |
| Bridge/session capability and coverage metadata | [decisions/0008](../decisions/0008-bridge-session-protocol.md) |
| Local trace context + OTel export adapter | [decisions/0010b](../decisions/0010b-trace-context-and-otel-export.md) |

## Cost-reduction patterns (used throughout the pillar)

These aren't tools but the principles the suggestions are based on:

1. **PTU vs pay-go**: Foundry PTU breaks even at ~30–40% sustained utilization. Below that, pay-go wins. Idle PTU = pure waste.
2. **Prompt caching**: Anthropic + Azure both offer ~90% discount on cached prefix. Agent loops with stable system prompts benefit massively. Caching is the single biggest no-quality-loss cost reduction.
3. **Tier routing**: cheap model classifies/routes; expensive model only for execution. LiteLLM's config supports this.
4. **Spot GPU**: RunPod community/spot ~50% off; OK for batch capture campaigns, not for live agent endpoints.
5. **Stop vs terminate** (already in user's memory): stopped pods bill storage. Audit weekly.
6. **Virtual keys with caps**: LiteLLM virtual keys can have daily/monthly budgets. Soft cap = warning; hard cap = throttle.

## Tool surface (Phase 0A.3)

All tools dispatched via the MCP bridge → daemon. Detailed schemas in [api/cost-tools.md](../api/cost-tools.md).

Implementation status after Lane B:

- LiteLLM spend-log ingest is implemented through the daemon HTTP endpoint and the `agent-fabric-cost-poll` CLI.
- The current local LiteLLM process accepts routed calls but returns a database-not-connected error for `/spend/logs`; `browser-agent` therefore posts observed LiteLLM usage directly to the same daemon ingest endpoint as an estimated-live fallback.
- Azure Cost Management Query response ingest is implemented and tested with fixtures; real subscription polling can use either service-principal env vars or the active `az` CLI login. The live account currently reports Foundry spend under `Foundry Models` / `Foundry Tools`, so those labels are part of the v1 filter.
- RunPod and OpenRouter inventory caching is implemented for idle-audit evidence; Vultr remains specified but not yet wired to a live API client.
- `fabric_status.coverage` is based on recent observed `cost_events` by agent, not just bridge-declared `litellmRouteable`.
- Provider credentials that are missing or invalid create warnings/coverage gaps, not fabricated zero-cost rows.

| Tool | Description |
|---|---|
| `pp_cost_month()` | Month-to-date ledgers + per-deployment + per-provider breakdown. Real Azure data + LiteLLM trace data, with freshness and coverage. |
| `pp_cost_by_feature({tag, since})` | Cost filtered by feature tag (e.g. `sam-summarizer`). |
| `pp_cost_by_branch({branch, since})` | Cost filtered by git branch (Phase 4). |
| `pp_cost_idle_audit()` | Foundry deployments with 0 requests in 7 days; stopped RunPod/Vultr pods burning storage; idle Foundry PTU. Suggests action per item. |
| `pp_cost_anomaly({since})` | Today vs 7-day rolling per deployment. Flags >2σ deviations. |
| `pp_cost_quota_status()` | Azure Monitor `TokenTransaction` rate vs TPM quota. Warns at 80%. |

## Tool surface (Phase 4)

| Tool | Description |
|---|---|
| `pp_cost_suggest({prompt_id})` | Quality-cost Pareto: "this prompt works on Haiku at 9% cost, observed quality delta 2%." Backed by Langfuse golden-set replay. |
| `pp_cost_caching_audit()` | Top 10 prompt templates by call volume; recommends prompt-cache breakpoints. |
| `pp_cost_route_optimize()` | LiteLLM config diff suggesting tier routing. |

## Cost ledgers

Cost answers never collapse incompatible truths into one scalar without source metadata. The API returns four ledgers:

| Ledger | Meaning | Typical source |
|---|---|---|
| `billed` | Provider billing facts already reported | Azure Cost Management, RunPod/Vultr billing, OpenRouter credits |
| `estimated_live` | Near-real-time token/call estimates | LiteLLM traces, Azure Monitor metrics |
| `fixed_capacity` | Reserved/standing cost independent of token count | Azure PTU, stopped GPU volume storage |
| `uncovered` | Known sessions/providers outside instrumentation | Bridge capability snapshots and manual config |

The caller can compute a single display number from compatible ledgers if it explicitly owns the caveat. The daemon does not return a `bestEffortTotal`.

## Per-feature attribution

Every covered LLM call through LiteLLM carries metadata:

```
X-Feature-Tag: <feature_id>
X-Branch: <git_branch>      # Phase 4
X-Commit: <short_sha>       # Phase 4
X-Agent: <agent_name>
```

Where a client can emit OpenTelemetry GenAI semantic attributes, store them in `raw_meta` for later export mapping and mirror to headers only for gateway/provider compatibility. Canonical `cost_events` rows use stable local fields. Aggregation queries are simple:

Minimum canonical trace fields:

```ts
{
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  provider: string;
  model: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  feature_tag?: string;
  agent_id?: string;
  coverage_source: "litellm" | "azure-monitor" | "manual" | "uncovered";
}
```

```sql
SELECT feature, SUM(cost_usd) FROM cost_events
WHERE ts > datetime('now','start of month')
GROUP BY feature ORDER BY SUM(cost_usd) DESC;
```

The agents must add the tag — the proxy doesn't infer. Default tag is the project root name. If a session is not LiteLLM-routeable, feature-level attribution is `uncovered` for that session rather than guessed.

## Per-commit attribution (Phase 4)

A git pre-commit hook stamps a `WORKSPACE_LLM_BRANCH` env var that LiteLLM clients read and include in headers. End of week:

```sql
SELECT branch, SUM(cost_usd) FROM cost_events
WHERE ts > datetime('now','-7 days')
GROUP BY branch;
```

Answers "what did this branch cost me." Nobody else does this.

## Idle-resource detection

`pp_cost_idle_audit` runs three sub-checks:

1. **Foundry idle deployments** — query Azure Monitor for `ProcessedInferenceTokens` per deployment over last 7 days. If sum is 0, flag for delete or scale-down.
2. **RunPod/Vultr stopped pods** — query GraphQL for pods where `desiredStatus = STOPPED` and `volumeSizeGB > 0`. Compute storage cost. Return typed inspect/terminate actions with risk, not raw shell strings.
3. **OpenRouter unused virtual keys** — list keys with 0 requests in 30 days. Recommend deletion.

Each finding ships with a one-line action: "you have $X/mo of waste here, run `Y` to clean it."

## Storage schema (cost tables)

```sql
CREATE TABLE cost_events (
  id TEXT PRIMARY KEY,                     -- UUIDv7
  ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  session_id TEXT,
  origin_peer_id TEXT NOT NULL,
  trace_id TEXT,
  span_id TEXT,
  parent_span_id TEXT,
  coverage_source TEXT NOT NULL,           -- 'litellm' | 'azure-monitor' | 'manual' | 'uncovered'
  provider TEXT NOT NULL,                  -- 'anthropic' | 'azure' | 'openrouter' | 'runpod-llama' | ...
  model TEXT NOT NULL,
  agent TEXT,
  feature_tag TEXT,
  branch TEXT,
  commit_sha TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cached_tokens INTEGER,
  cost_usd REAL,
  request_id TEXT,
  raw_meta JSON
);
CREATE INDEX idx_cost_events_ts ON cost_events(ts);
CREATE INDEX idx_cost_events_feature ON cost_events(feature_tag, ts);

CREATE TABLE cost_billing (
  id TEXT PRIMARY KEY,                     -- UUIDv7
  ts_polled TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source TEXT NOT NULL,                    -- 'azure-cost-mgmt' | 'runpod-graphql' | 'vultr-billing' | 'openrouter-credits'
  resource_id TEXT NOT NULL,
  meter_subcategory TEXT,
  cost_usd REAL,
  usage_qty REAL,
  usage_unit TEXT,
  period_start TIMESTAMP,
  period_end TIMESTAMP,
  raw_meta JSON
);
CREATE INDEX idx_cost_billing_resource ON cost_billing(resource_id, ts_polled);
```

Coverage metadata lives in `bridge_sessions`:

```sql
CREATE TABLE bridge_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  host TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  capabilities JSON NOT NULL,
  litellm_routeable BOOLEAN NOT NULL,
  started_at TIMESTAMP NOT NULL,
  ended_at TIMESTAMP
);
```

## Open questions

1. **Azure Cost Management API latency.** Documented at up to 24 hours. We cache hourly and report freshness; if the user wants live-ish numbers, we fall back to LiteLLM-derived estimates with a "preliminary" flag.
2. **Quality-cost evals: where to source the golden set?** A small per-feature golden set (10–30 prompts) would suffice for Pareto evals. Asking the user to curate it explicitly per feature is the honest path.
3. **GPU rental cost model.** RunPod is straightforward ($/hr × hours). Vultr is more variable. We compute, not estimate.
4. **Privacy of cost data.** It's the user's own data, but it can leak via shared logs. Same redaction rules as audit (no model output bodies, only meta).

## Risks specific to this pillar

- **LiteLLM as bottleneck/SPOF for covered traffic.** One-flag bypass per agent. Health probe in `pp_describe_backend_health` at the daemon level. Bypass windows reduce `coverage_pct`.
- **Provider API rate limits** (Azure Cost Mgmt, RunPod GraphQL). Hourly poll, exponential backoff on 429.
- **Unit drift.** Providers report in different units (Azure: USD; RunPod: USD; OpenRouter: credits). Daemon normalizes to USD at write time.
- **Per-feature tags get stale.** Agents forget to update them. Mitigation: default tag is the project root name; explicit tags only for important features.

## Done definition for Phase 0A.3

- LiteLLM proxy in front of every routeable model call from at least: browser-agent, Continue, local scripts, and any IDE profile with explicit base-url support.
- `pp_cost_month` returns separate ledgers whose `billed.azure` rows match Azure Cost Management portal within 5% for the same freshness window.
- `pp_cost_idle_audit` finds at least one piece of waste on first run (target: $50+/mo identifiable).
- LiteLLM virtual keys configured with daily soft caps per routeable agent.
- Every cost response includes `coverage_pct` and freshness metadata.

## Done definition for Phase 4

- Langfuse self-hosted with per-feature tags flowing.
- Pareto-curve report for at least the top 3 most-expensive prompt templates.
- Concrete cost-reduction suggestion accepted for at least one prompt (with measured quality delta).
- Per-commit cost attribution functioning on the git pre-commit hook.
