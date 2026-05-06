# API — Cost Policy MCP tools

These tools are the pre-call guardrail from ADR-0017 Lane H.1. They do not call models. They estimate cost/risk from the context package, candidate route, reasoning level, tool schema load, and known sensitive flags, then record the decision for audit and budget views.

All mutating calls require the bridge/session idempotency key from ADR-0008.

## `llm_preflight`

Estimate a model call before the client sends context to the provider.

**Input:**
```ts
{
  task: { type: "code_edit" | "plan" | "review" | string; [key: string]: unknown } | string;
  client: "codex" | "codex_vscode" | "claude_code" | "claude_code_vscode" | "local-cli" | "jcode" | "browser-agent" | string;
  workspaceRoot?: string;
  candidateModel: "worker.deepseek.max" | "worker.deepseek.openrouter" | "deepseek-v4-pro" | "deepseek/deepseek-v4-pro" | "anthropic/claude-4.7-opus" | "breakglass.pro" | string;
  requestedReasoning?: "low" | "medium" | "high" | "xhigh" | "max";
  requestedProvider?: "deepseek" | "openrouter" | "anthropic" | "openai" | "azure" | "copilot";
  billingPreference?: "metered" | "included" | "ptu" | string;
  budgetScope?: "session" | "day" | "month" | "chain" | string;
  contextPackage?: {
    estimatedTokens?: number;
    inputTokens?: number;
    sensitiveFlags?: string[];
    memories?: { verified?: boolean; verifierStatus?: string }[];
    toolSchemas?: unknown[];
    mcpServers?: unknown[];
    [key: string]: unknown;
  };
  contextPackageSummary?: {
    inputTokens?: number;
    estimatedTokens?: number;
    [key: string]: unknown;
  };
  toolSchemas?: unknown[];
  mcpServers?: unknown[];
  sensitiveFlags?: string[];
  approvalToken?: string;
}
```

**Output:**
```ts
{
  requestId: string;
  decision: "allow" | "needs_user_approval" | "compact_first";
  risk: "low" | "medium" | "high" | "breakglass";
  advisoryOnly: boolean;
  selected: {
    provider: string;
    model: string;
    reasoning: "low" | "medium" | "high" | "xhigh" | "max";
    billingMode: string;
    priceSource: string;
    priceConfidence: string;
    discountExpiresAt?: string;
  };
  estimate: {
    inputTokens: number;
    reservedOutputTokens: number;
    estimatedCostUsd: number;
  };
  budgetScope: string;
  warnings: string[];
  approval?: {
    required?: boolean;
    accepted?: boolean;
    requestId: string;
    scope?: "call" | "chain" | "session" | "day";
    expiresAt: string;
    usesRemaining?: number;
  };
  contextPackage: {
    contextPackageId: string;
    inspectTool: "fabric_inspect_context_package";
  };
  fastPathLatencyMs: number;
}
```

Risk rules are intentionally simple in H.1:

- `breakglass`: estimated cost at least `$2`, input context at least `200k` tokens, `breakglass.pro`, or sensitive flags such as `api_key`, `cookies`, `secrets`, `external_action`, or `production_data`.
- `high`: estimated cost at least `$0.50`, input context at least `50k` tokens, `high`/`xhigh`/`max` reasoning, or task type `review`.
- `medium`: estimated cost at least `$0.10`, input context at least `20k` tokens, more than five tool schemas, or unverified memory.
- `low`: none of the above.

`codex`, `codex_vscode`, `claude_code`, and `claude_code_vscode` sessions that are not LiteLLM-routeable return `advisoryOnly: true`; the daemon records the decision, but it cannot enforce the route unless the participating extension obeys the hard-gate contract below.

When the decision is `needs_user_approval`, the daemon also creates one `approval_requests` row. Clients can list it with `llm_approve_pending`, ask the human through any available gateway (VS Code, terminal, mobile notification, or another client), then call `llm_approve`. The repo ships a first terminal gateway as `agent-fabric-approve` / `npm run dev:approve -- ...`.

When `approvalToken` is present, `llm_preflight` validates it against the approved request's workspace, selected route, selected reasoning, token expiry, token use count, and approved cost/token ceiling. A valid token changes a `needs_user_approval` decision to `allow`. Invalid or expired tokens do not fail the preflight; the response remains `needs_user_approval` and includes a warning.

## `llm_hard_gate`

Fail-closed wrapper around `llm_preflight` for participating clients such as Codex and Claude Code VS Code adapters. It still does not call the model. It tells the adapter whether it is allowed to send the request.

**Input:** same as `llm_preflight`, plus:

```ts
{
  enforce?: boolean; // default true
}
```

**Output:**

```ts
{
  gate: {
    schema: "agent-fabric.llm-hard-gate.v1";
    client: string;
    enforced: boolean;
    enforcementMode: "participating_client" | "gateway_or_participating_client";
    participatingClientRequired: true;
    allowModelCall: boolean;
    mustBlock: boolean;
    blockReason?: "human_approval_required" | "compact_or_remove_sensitive_context" | string;
    requiresApproval: boolean;
    requiresCompaction: boolean;
    adapterContract: string[];
  };
  preflight: unknown; // full llm_preflight result
}
```

The contract for Codex/Claude Code VS Code extensions is simple: call `llm_hard_gate` before every metered model request; if `gate.allowModelCall` is false, do not send the request. If approval is required, show or delegate to the approval inbox, then retry with the issued `approvalToken`.

## `model_brain_route`

Centralized model brain for model selection and gating. It resolves a role alias such as `plan.strong`, estimates cost/risk, runs the hard gate, and returns one compact route decision for clients.

**Input:**

```ts
{
  task: { type?: string; [key: string]: unknown } | string;
  client: string;
  roleAlias?: "prompt.improve.strong" | "plan.strong" | "phase.splitter" | "task.writer" | "tool.context.manager" | "execute.cheap" | "review.strong" | string;
  candidateModel?: string; // required when roleAlias is omitted
  requestedProvider?: string;
  requestedReasoning?: "low" | "medium" | "high" | "xhigh" | "max";
  contextPackage?: Record<string, unknown>;
  contextPackageSummary?: Record<string, unknown>;
  toolSchemas?: unknown[];
  mcpServers?: unknown[];
  budgetScope?: string;
  risk?: "low" | "medium" | "high" | "breakglass";
  sensitiveFlags?: string[];
  approvalToken?: string;
  enforce?: boolean;
}
```

**Output:**

```ts
{
  schema: "agent-fabric.model-brain-route.v1";
  roleAlias?: string;
  taskType: string;
  route: {
    provider: string;
    model: string;
    reasoning: string;
    billingMode: string;
    priceSource: string;
    priceConfidence: string;
    aliasSource?: string;
    reasonCodes: string[];
  };
  gate: unknown;       // hard-gate contract
  estimate: unknown;   // token and cost estimate
  risk: string;
  decision: "allow" | "needs_user_approval" | "compact_first";
  budgetScope: string;
  warnings: string[];
  contextPackage: { contextPackageId: string; inspectTool: "fabric_inspect_context_package" };
  approval?: unknown;
  recommendations: string[];
  preflightRequestId: string;
}
```

Use `model_brain_route` when a client wants one central decision instead of separately calling `policy_resolve_alias`, `llm_preflight`, and `llm_hard_gate`.

## `llm_budget_status`

Aggregate recorded preflights for local budget visibility.

**Input:**
```ts
{
  workspaceRoot?: string;
  sessionId?: string;
  chainId?: string;          // reserved for later orchestrator linkage
  model?: string;
  scope?: "session" | "day" | "month" | "all";
  since?: string;
}
```

**Output:**
```ts
{
  workspaceRoot: string;
  scope: string;
  since: string | null;
  preflightCount: number;
  estimatedCostUsd: number;
  byDecision: Record<string, { count: number; estimatedCostUsd: number }>;
  byModel: Record<string, { count: number; estimatedCostUsd: number }>;
  byProvider: Record<string, { count: number; estimatedCostUsd: number }>;
  highRiskCount: number;
  breakglassCount: number;
  warnings: string[];
}
```

## `llm_approve_pending`

List pending approval requests for the current workspace. This is read-only and does not require an idempotency key.

Terminal gateway:

```bash
npm run dev:approve -- list
npm run dev:approve -- list --workspace /path/to/project --json
npm run dev:approve -- prompt --scope call --note "approved from terminal"
```

**Input:**
```ts
{
  workspaceRoot?: string;
  includeExpired?: boolean;  // default false
  max?: number;              // default 20, max 100
}
```

**Output:**
```ts
{
  workspaceRoot: string;
  count: number;
  requests: {
    requestId: string;          // llm_preflight request id
    approvalRequestId: string;
    createdAt: string;
    expiresAt: string;
    expired: boolean;
    status: "pending";
    client: string;
    taskType: string;
    selected: {
      provider: string;
      model: string;
      reasoning: "low" | "medium" | "high" | "xhigh" | "max";
    };
    estimate: {
      inputTokens: number;
      reservedOutputTokens: number;
      estimatedCostUsd: number;
    };
    risk: "high" | "breakglass";
    warnings: string[];
  }[];
}
```

## `llm_approve`

Record a human decision for one pending approval request. This is the durable state transition behind multiple possible human-input gateways; the daemon does not render UI.

Terminal gateway:

```bash
npm run dev:approve -- approve <requestId> --scope call
npm run dev:approve -- approve <requestId> --scope queue --queue <queueId>
npm run dev:approve -- compact <requestId> --note "drop logs and retry"
npm run dev:approve -- downgrade <requestId>
npm run dev:approve -- cancel <requestId>
```

**Input:**
```ts
{
  requestId: string;          // llm_preflight request id
  decision: "allow" | "compact" | "downgrade" | "cancel";
  scope?: "call" | "chain" | "queue" | "session" | "day";  // default "call"
  boundResourceId?: string;   // default requestId for call scope; default budgetScope for non-call scopes
  expiresInSeconds?: number;  // default 900, max 86400
  note?: string;
}
```

**Output:**
```ts
{
  requestId: string;
  status: "approved" | "compact_requested" | "downgrade_requested" | "canceled";
  decision: "allow" | "compact" | "downgrade" | "cancel";
  scope: "call" | "chain" | "queue" | "session" | "day";
  boundResourceId: string;
  approvalToken?: string;     // only for decision "allow"; store only the hash
  tokenExpiresAt: string | null;
  expiresAt: string;          // approval request expiry
}
```

Queue-scoped approvals are intended for Senior-mode worker batches. A token bound to `project_queue:<queueId>` can satisfy multiple matching DeepSeek preflights for that queue while preserving audit rows and token use counts.

Token use limits are conservative in this server-side slice: `call` allows one matching preflight, `chain` allows 50, `session` allows 100, and `day` allows 200. Wider semantics can be revised once the VS Code client approval panel and plan-chain runner are calling the tool.

## `llm_route_feedback`

Record what happened after a preflighted model call. This is evidence for future routing policy; it does not perform automatic rerouting.

**Input:**
```ts
{
  requestId: string;  // llm_preflight request id
  outcome:
    | "succeeded"
    | "failed"
    | "regressed"
    | "retried"
    | "user_accepted"
    | "user_rejected"
    | "canceled"
    | "errored";
  evidence?: Record<string, unknown>;
  qualityScore?: number;  // 0..1 when the caller has a meaningful score
  retryCount?: number;
  latencyMs?: number;
  costUsd?: number;
}
```

**Output:**
```ts
{
  outcomeId: string;
  requestId: string;
  outcome: string;
}
```

The request must refer to an existing `llm_preflight` row in the caller's workspace. Evidence should be small structured metadata such as `{testsPass:true}`, `{userAcceptedPatch:false}`, or `{errorCode:"rate_limit"}`; do not store raw prompts.

## `fabric_route_outcomes_summary`

Summarize route outcomes by provider, model, task type, and outcome.

**Input:**
```ts
{
  workspaceRoot?: string;
  since?: string;
  sinceDays?: number;  // default 7
}
```

**Output:**
```ts
{
  workspaceRoot: string;
  since: string;
  totalOutcomes: number;
  byRoute: {
    provider: string;
    model: string;
    taskType: string;
    outcome: string;
    count: number;
    avgQualityScore: number | null;
    avgCostUsd: number | null;
    avgLatencyMs: number | null;
    totalRetries: number;
  }[];
}
```

## `policy_resolve_alias`

Resolve a deterministic model-policy alias for higher-level workflows. This is explainable substitution only; it does not call models and does not learn from outcomes yet.

**Input:**
```ts
{
  alias:
    | "prompt.improve.strong"
    | "plan.strong"
    | "phase.splitter"
    | "task.writer"
    | "tool.context.manager"
    | "review.strong"
    | "execute.cheap"
    | "debug.balanced"
    | "summarize.cheap"
    | "breakglass.pro"
    | string;
  taskType?: string;
  contextSize?: number;
  estimatedCostUsd?: number;
  risk?: "low" | "medium" | "high" | "breakglass";
}
```

**Output:**
```ts
{
  alias: string;
  provider: string;
  model: string;
  reasoning: "low" | "medium" | "high" | "xhigh" | "max";
  billingMode: string;
  source: string;
  taskType: string;
  reasonCodes: string[];
  warnings: string[];
  metadata: Record<string, unknown>;
}
```

Runtime seeds currently define:

- `execute.cheap` -> direct DeepSeek, medium reasoning.
- `summarize.cheap` -> direct DeepSeek, low reasoning.
- `debug.balanced` -> OpenRouter DeepSeek, xhigh reasoning.
- `phase.splitter` and `task.writer` -> direct DeepSeek, max reasoning.
- `tool.context.manager` -> direct DeepSeek, medium reasoning.
- `prompt.improve.strong` -> OpenRouter Claude Opus 4.7, xhigh reasoning.
- `plan.strong`, `review.strong`, and `breakglass.pro` -> OpenRouter Claude Opus 4.7, xhigh reasoning.

## Seeded H.1 Routes

Runtime seed data currently covers the routes needed for dogfooding:

- Direct DeepSeek: `deepseek` / `deepseek-v4-pro`, metered, public API pricing, `$1.74/MTok cache-miss input`, `$0.145/MTok cache-hit input`, `$3.48/MTok output`.
- OpenRouter DeepSeek: `openrouter` / `deepseek/deepseek-v4-pro`, OpenRouter catalog, same input/output price.
- OpenRouter Claude: `openrouter` / `anthropic/claude-4.7-opus`, OpenRouter catalog, `$5/MTok input`, `$25/MTok output`.

## Non-Goals

H.1 does not implement automatic model calls, prompt rewriting, LiteLLM policy enforcement, semantic context pruning, graph-based memory retrieval, or provider credential management. Those belong in later routing/orchestrator work.
