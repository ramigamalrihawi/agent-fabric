# API — Costs MCP tools

Tool schemas for the costs pillar.

All cost outputs are coverage-aware. The daemon must not collapse billed data, live estimates, fixed-capacity burn, and uncovered traffic into one scalar without exposing source and freshness.

## `pp_cost_month`

Month-to-date spend across all providers, with split ledgers and breakdowns.

**Input:**
```ts
{
  asOf?: string;                      // ISO ts; default 'now'
}
```

**Output:**
```ts
{
  ledgers: CostLedgers;
  coverage: CoverageSummary;
  byProvider: ProviderSpend[];
  byDeployment: DeploymentSpend[];
  byFeatureTag: Record<string, number>;
  byAgent: Record<string, number>;
  warnings: string[];                 // e.g. "Azure data is 18h old; LiteLLM-derived data flags preliminary"
}

type CostLedgers = {
  billed: LedgerTotal;
  estimated_live: LedgerTotal;
  fixed_capacity: LedgerTotal;
  uncovered: { knownSessions: number; estimatedUsd?: number; reason: string };
};

type LedgerTotal = {
  usd: number;
  freshness: "live" | "1h-old" | "azure-24h-lag" | "provider-cache";
  sources: string[];
};

type TraceRef = {
  traceId: string;
  spanId?: string;
  correlationId?: string;
};

type CoverageSummary = {
  coveragePct: number;                // observed covered calls / known model-call sessions
  byAgent: Record<string, number>;
  byProvider: Record<string, number>;
  uncoveredAgents: string[];
};

type ProviderSpend = {
  provider: "anthropic" | "azure" | "openrouter" | "runpod" | "vultr" | "openai-direct";
  usd: number;
  ledger: "billed" | "estimated_live" | "fixed_capacity";
  freshness: string;
  coveragePct: number;
};

type DeploymentSpend = {
  resourceId: string;                 // Azure resource id, or "runpod:<podId>"
  displayName: string;
  usd: number;
  ledger: "billed" | "estimated_live" | "fixed_capacity";
  source: "azure-cost-mgmt" | "litellm-derived" | "runpod-graphql" | "vultr-billing" | "openrouter-credits";
  exemplarTrace?: TraceRef;
};
```

## `pp_cost_by_feature`

Cost filtered by a feature tag.

**Input:**
```ts
{
  tag: string;                        // e.g. "sam-summarizer", "power-platform-mcp:phase0"
  since?: string;                     // ISO ts; default month-start
  groupBy?: "deployment" | "model" | "day" | "agent";
}
```

**Output:**
```ts
{
  tag: string;
  windowStart: string;
  windowEnd: string;
  ledgers: CostLedgers;
  coverage: CoverageSummary;
  rows: { key: string; usd: number; ledger: string; calls?: number; coveragePct?: number }[];
}
```

## `pp_cost_by_branch` (Phase 4)

Cost filtered by git branch. Requires git pre-commit hook + agent header propagation.

**Input:**
```ts
{
  branch: string;
  since?: string;                     // default 7 days ago
}
```

**Output:** same shape as `pp_cost_by_feature`.

## `pp_cost_idle_audit`

Find waste. Three sub-checks: idle Foundry deployments, stopped GPU pods burning storage, unused virtual keys.

**Input:**
```ts
{
  thresholdDays?: number;             // default 7 — "no activity in N days"
  estimateForwardMonths?: number;     // default 1 — projected waste over the next N months
}
```

**Output:**
```ts
{
  totalEstimatedMonthlyWaste: number;
  findings: IdleFinding[];
}

type IdleFinding = {
  kind: "idle-foundry-deployment" | "stopped-gpu-pod" | "unused-openrouter-key" | "low-utilization-ptu";
  resource: string;
  detail: string;                     // human-readable
  estimatedMonthlyWasteUsd: number;
  suggestedAction: {
    actionKind: "inspect" | "scale_down" | "stop" | "terminate" | "delete" | "configure_budget";
    risk: "safe" | "low" | "medium" | "high";
    dryRunCommand?: string;
    applyCommand?: string;
  };
  evidence: Record<string, any>;      // raw signals (last activity ts, util %, etc.)
};
```

Example output:

```json
{
  "totalEstimatedMonthlyWaste": 47.5,
  "findings": [
    {
      "kind": "stopped-gpu-pod",
      "resource": "runpod:fzw6pfj1s7w6lr",
      "detail": "Pod stopped 14 days ago, 80GB volume still allocated",
      "estimatedMonthlyWasteUsd": 8.0,
      "suggestedAction": {
        "actionKind": "terminate",
        "risk": "high",
        "dryRunCommand": "node bin/runpod.js inspect fzw6pfj1s7w6lr",
        "applyCommand": "node bin/runpod.js terminate fzw6pfj1s7w6lr"
      },
      "evidence": { "lastActivityTs": "2026-04-12T...", "volumeGb": 80, "rateGbMo": 0.10 }
    },
    {
      "kind": "idle-foundry-deployment",
      "resource": "/subscriptions/.../accounts/kloeckner/deployments/gpt5-pro-old",
      "detail": "0 ProcessedInferenceTokens in last 7 days; PTU reservation $X/mo",
      "estimatedMonthlyWasteUsd": 39.5,
      "suggestedAction": {
        "actionKind": "delete",
        "risk": "high",
        "dryRunCommand": "az cognitiveservices account deployment show -g rg-comserv-prod -n kloeckner --deployment-name gpt5-pro-old",
        "applyCommand": "az cognitiveservices account deployment delete -g rg-comserv-prod -n kloeckner --deployment-name gpt5-pro-old"
      },
      "evidence": { "tokensLast7d": 0, "ptuReserved": 100 }
    }
  ]
}
```

## `pp_cost_anomaly`

Daily total vs 7-day rolling baseline per deployment. Flags >2σ deviations.

**Input:**
```ts
{
  since?: string;                     // default 1 day ago
  threshold?: number;                 // sigmas; default 2
}
```

**Output:**
```ts
{
  anomalies: Anomaly[];
}

type Anomaly = {
  resourceId: string;
  todayUsd: number;
  rolling7dAvgUsd: number;
  rolling7dStdUsd: number;
  sigmas: number;
  likelyCauseHints: string[];         // heuristic; "feature_tag X tripled call rate today"
};
```

## `pp_cost_quota_status`

Azure Monitor `TokenTransaction` rate vs TPM quota per deployment.

**Input:** `{}`

**Output:**
```ts
{
  deployments: QuotaStatus[];
}

type QuotaStatus = {
  deploymentId: string;
  tpmQuota: number;
  currentRateTpm: number;
  utilizationPct: number;
  warning?: string;                   // ">80% — throttle imminent"
};
```

## `pp_cost_suggest` (Phase 4)

Quality-cost Pareto: "this prompt works on a cheaper model with measured quality delta of X%."

**Input:**
```ts
{
  promptId?: string;                  // langfuse trace id or template id
  featureTag?: string;
  topN?: number;                      // default 3 most-expensive
}
```

**Output:**
```ts
{
  suggestions: CostSuggestion[];
}

type CostSuggestion = {
  scope: { promptId?: string; featureTag?: string };
  current: { model: string; estimatedMonthlyUsd: number };
  proposed: { model: string; estimatedMonthlyUsd: number; savingsPct: number };
  qualityDelta: { score: number; sampleSize: number; methodology: string };
  recommendedAction: string;
};
```

## `pp_cost_caching_audit` (Phase 4)

Top 10 prompt templates by call volume; recommends prompt-cache breakpoints.

**Input:**
```ts
{
  windowDays?: number;                // default 7
}
```

**Output:**
```ts
{
  templates: CachingCandidate[];
}

type CachingCandidate = {
  templateHash: string;
  exemplarPrompt: string;             // truncated
  callsLast7d: number;
  estimatedSavingsUsd: number;        // if cached prefix at first stable boundary
  recommendedPrefixLen: number;       // tokens
  agent: string;
};
```

## Configuration

The cost tools depend on:

- LiteLLM proxy running at `127.0.0.1:4000` for coverable clients (configured in [decisions/0003](../decisions/0003-litellm-as-universal-proxy.md)).
- Agent-fabric daemon HTTP ingest on `127.0.0.1:4521` unless disabled with `AGENT_FABRIC_HTTP_PORT=off`. HTTP ingest requires `AGENT_FABRIC_COST_INGEST_TOKEN`; POST callers send `Authorization: Bearer <token>`.
- `agent-fabric-cost-poll` for cache refreshes from LiteLLM, Azure Cost Management, RunPod, and OpenRouter.
- Azure Cost Management API access via either `AZURE_SUBSCRIPTION_ID` + service-principal credentials or the active `az` CLI login. Without `AZURE_SUBSCRIPTION_ID`, the poller checks every enabled CLI subscription it can read.
- RunPod API key (`RUNPOD_API_KEY`) when RunPod polling is enabled.
- Vultr API key (`VULTR_API_KEY`) when Vultr polling is enabled.
- OpenRouter API key (`OPENROUTER_API_KEY`).

Implemented ingest paths:

- `POST /cost/ingest/litellm` accepts LiteLLM spend-log payloads and writes `cost_events`.
- `browser-agent` can use the same endpoint as a fallback when `LITELLM_ENABLED=1` and the LiteLLM proxy has no database-backed `/spend/logs`.
- `POST /cost/ingest/azure-query` accepts Azure Cost Management Query API responses and writes `cost_billing`.
- `agent-fabric-cost-poll` can ingest LiteLLM, Azure, RunPod, and OpenRouter data directly into the default local database. Azure service-name matching includes current Foundry labels (`Foundry Models`, `Foundry Tools`) as well as older Cognitive/OpenAI labels.
- OpenRouter key discovery can use `OPENROUTER_API_KEY`, tries discovered candidates only when configured, uses `/api/v1/keys` when a management key is available, and falls back to `/api/v1/auth/key` snapshots for regular keys.

Tools degrade gracefully:

- If Azure access is unavailable: real billing data is absent; LiteLLM-derived estimates appear only in `estimated_live` and warnings explain that `billed` is unavailable.
- If RunPod/Vultr/OpenRouter access is unavailable: that provider is omitted from output with a warning.
- If a client cannot route through LiteLLM: feature/agent attribution reports lower `coveragePct`; do not infer per-feature spend.

## Errors

| Code | Meaning |
|---|---|
| `BILLING_API_UNAUTHORIZED` | Azure / RunPod / Vultr credentials missing or invalid |
| `BILLING_API_RATE_LIMITED` | Provider rate limit hit; serve cached data |
| `STALE_DATA` | All sources are >24h old; user explicitly opted into stale freshness |
| `LITELLM_DOWN` | Cannot reach proxy for live trace data; per-feature attribution unavailable |
| `LOW_COVERAGE` | Coverage is below the caller's requested threshold |
| `DAEMON_UNREACHABLE` | Bridge couldn't reach the daemon |

## Performance targets

- `pp_cost_month` p95 < 100 ms (cache-only).
- `pp_cost_idle_audit` p95 < 1 s (multi-provider join, allowed to be slow).
- `pp_cost_anomaly` p95 < 200 ms.
- Hourly billing poll p95 < 60 s.
