import { hashSecret, newId, newSessionToken } from "../ids.js";
import {
  asRecord,
  getArray,
  getField,
  getOptionalBoolean,
  getOptionalNumber,
  getOptionalString,
  getString,
  getStringArray,
  safeJsonArray,
  safeJsonRecord,
  uniqueStrings
} from "../runtime/input.js";
import { FabricError } from "../runtime/errors.js";
import type { CallContext } from "../types.js";
import { recordContextPackage } from "./contextInspector.js";
import type { SurfaceHost } from "./host.js";

type Reasoning = "low" | "medium" | "high" | "xhigh" | "max";
type Risk = "low" | "medium" | "high" | "breakglass";
type Decision = "allow" | "needs_user_approval" | "compact_first";
type ApprovalDecision = "allow" | "compact" | "downgrade" | "cancel";
type ApprovalStatus = "pending" | "approved" | "compact_requested" | "downgrade_requested" | "canceled";

type RouteSeed = {
  provider: string;
  model: string;
  billingMode: string;
  source: string;
  confidence: string;
  inputPricePerMtokMicros: number;
  outputPricePerMtokMicros: number;
  cacheReadPricePerMtokMicros?: number;
  discountExpiresAt?: string;
};

type ReservationSeed = {
  model: string;
  taskType: string;
  reasoning: Reasoning;
  p50OutputTokens: number;
  p95OutputTokens: number;
};

type PolicyAliasSeed = {
  alias: string;
  provider: string;
  model: string;
  reasoning: Reasoning;
  billingMode: string;
  source: string;
  priority: number;
  maxInputTokens?: number;
  maxEstimatedCostUsd?: number;
  riskCeiling?: Risk;
  metadata?: Record<string, unknown>;
};

type RouteRow = {
  provider: string;
  model: string;
  billing_mode: string;
  source: string;
  confidence: string;
  input_price_per_mtok_micros: number;
  output_price_per_mtok_micros: number;
  cache_read_price_per_mtok_micros: number | null;
  discount_expires_at: string | null;
};

type ReservationRow = {
  p50_output_tokens: number;
  p95_output_tokens: number;
};

type PolicyAliasRow = {
  alias: string;
  provider: string;
  model: string;
  reasoning: Reasoning;
  billing_mode: string;
  source: string;
  priority: number;
  max_input_tokens: number | null;
  max_estimated_cost_usd: number | null;
  risk_ceiling: Risk | null;
  metadata_json: string;
};

type PreflightRow = {
  selected_provider: string;
  selected_model: string;
  decision: string;
  risk: string;
  estimated_cost_usd: number;
};

type PreflightRequestRow = {
  id: string;
  session_id: string;
  agent_id: string;
  host_name: string | null;
  workspace_root: string;
  client: string;
  task_type: string;
  selected_provider: string;
  selected_model: string;
  selected_reasoning: string;
  trace_id: string | null;
  correlation_id: string | null;
  test_mode: 0 | 1;
};

type ApprovalRequestRow = {
  id: string;
  preflight_request_id: string;
  ts_created: string;
  expires_at: string;
  status: string;
  decision: string | null;
  decided_at: string | null;
  decided_by_session_id: string | null;
  decided_by_agent_id: string | null;
  note: string | null;
  scope: string | null;
  bound_resource_id: string | null;
  approval_token_hash: string | null;
  approval_token_expires_at: string | null;
  approval_token_max_uses: number;
  approval_token_uses: number;
  origin_peer_id: string;
  session_id: string;
  agent_id: string;
  host_name: string | null;
  workspace_root: string;
  client: string;
  task_type: string;
  selected_provider: string;
  selected_model: string;
  selected_reasoning: string;
  input_tokens: number;
  reserved_output_tokens: number;
  estimated_cost_usd: number;
  risk: string;
  warnings_json: string;
  test_mode: 0 | 1;
};

type RouteOutcomeSummaryRow = {
  selected_provider: string;
  selected_model: string;
  task_type: string;
  outcome: string;
  count: number;
  avg_quality_score: number | null;
  avg_cost_usd: number | null;
  avg_latency_ms: number | null;
  total_retries: number;
};

type ApprovalTokenResult =
  | { accepted: true; requestId: string; scope: string; expiresAt: string; usesRemaining: number }
  | { accepted: false; warning: string };

const KNOWN_PROVIDERS = new Set(["anthropic", "azure", "deepseek", "openai", "openrouter", "copilot"]);
const HIGH_REASONING = new Set(["high", "xhigh", "max"]);
const SENSITIVE_BREAKGLASS = new Set(["api_key", "apikey", "secret", "secrets", "cookies", "cookie", "external_action", "production_data"]);
const ROUTE_OUTCOMES = new Set(["succeeded", "failed", "regressed", "retried", "user_accepted", "user_rejected", "canceled", "errored"]);

const ROUTE_SEEDS: RouteSeed[] = [
  {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    billingMode: "metered",
    source: "public_api_pricing",
    confidence: "high",
    inputPricePerMtokMicros: 1_740_000,
    outputPricePerMtokMicros: 3_480_000,
    cacheReadPricePerMtokMicros: 145_000
  },
  {
    provider: "openrouter",
    model: "deepseek/deepseek-v4-pro",
    billingMode: "metered",
    source: "openrouter_catalog",
    confidence: "high",
    inputPricePerMtokMicros: 435_000,
    outputPricePerMtokMicros: 870_000
  },
  {
    provider: "openrouter",
    model: "anthropic/claude-4.7-opus",
    billingMode: "metered",
    source: "openrouter_catalog",
    confidence: "high",
    inputPricePerMtokMicros: 5_000_000,
    outputPricePerMtokMicros: 25_000_000
  }
];

const RESERVATION_SEEDS: ReservationSeed[] = [
  { model: "deepseek-v4-pro", taskType: "code_edit", reasoning: "max", p50OutputTokens: 2_500, p95OutputTokens: 9_000 },
  { model: "deepseek-v4-pro", taskType: "plan", reasoning: "max", p50OutputTokens: 3_000, p95OutputTokens: 12_000 },
  { model: "deepseek-v4-pro", taskType: "review", reasoning: "max", p50OutputTokens: 2_000, p95OutputTokens: 8_000 },
  { model: "deepseek/deepseek-v4-pro", taskType: "code_edit", reasoning: "xhigh", p50OutputTokens: 2_500, p95OutputTokens: 9_000 },
  { model: "anthropic/claude-4.7-opus", taskType: "plan", reasoning: "xhigh", p50OutputTokens: 2_000, p95OutputTokens: 8_000 },
  { model: "anthropic/claude-4.7-opus", taskType: "review", reasoning: "xhigh", p50OutputTokens: 1_800, p95OutputTokens: 7_000 }
];

const POLICY_ALIAS_SEEDS: PolicyAliasSeed[] = [
  {
    alias: "execute.cheap",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    reasoning: "medium",
    billingMode: "metered",
    source: "runtime_seed",
    priority: 100,
    riskCeiling: "medium",
    metadata: { purpose: "Routine edits and first-pass implementation" }
  },
  {
    alias: "summarize.cheap",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    reasoning: "low",
    billingMode: "metered",
    source: "runtime_seed",
    priority: 100,
    riskCeiling: "low",
    metadata: { purpose: "Summaries and context reduction" }
  },
  {
    alias: "prompt.improve.strong",
    provider: "openrouter",
    model: "anthropic/claude-4.7-opus",
    reasoning: "xhigh",
    billingMode: "metered",
    source: "runtime_seed",
    priority: 100,
    riskCeiling: "breakglass",
    metadata: { purpose: "Rewrite rough project prompts into reviewed implementation prompts" }
  },
  {
    alias: "debug.balanced",
    provider: "openrouter",
    model: "deepseek/deepseek-v4-pro",
    reasoning: "xhigh",
    billingMode: "metered",
    source: "runtime_seed",
    priority: 100,
    riskCeiling: "high",
    metadata: { purpose: "Debugging after cheap execution fails" }
  },
  {
    alias: "plan.strong",
    provider: "openrouter",
    model: "anthropic/claude-4.7-opus",
    reasoning: "xhigh",
    billingMode: "metered",
    source: "runtime_seed",
    priority: 100,
    riskCeiling: "breakglass",
    metadata: { purpose: "Architecture planning and high-risk reviews" }
  },
  {
    alias: "phase.splitter",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    reasoning: "max",
    billingMode: "metered",
    source: "runtime_seed",
    priority: 100,
    riskCeiling: "high",
    metadata: { purpose: "Split accepted plans into implementable phases" }
  },
  {
    alias: "task.writer",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    reasoning: "max",
    billingMode: "metered",
    source: "runtime_seed",
    priority: 100,
    riskCeiling: "high",
    metadata: { purpose: "Write concrete coding tasks with acceptance criteria" }
  },
  {
    alias: "tool.context.manager",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    reasoning: "medium",
    billingMode: "metered",
    source: "runtime_seed",
    priority: 100,
    riskCeiling: "high",
    metadata: { purpose: "Recommend least-necessary tool and context bundles before workers start" }
  },
  {
    alias: "review.strong",
    provider: "openrouter",
    model: "anthropic/claude-4.7-opus",
    reasoning: "xhigh",
    billingMode: "metered",
    source: "runtime_seed",
    priority: 100,
    riskCeiling: "breakglass",
    metadata: { purpose: "Final review and arbitration" }
  },
  {
    alias: "breakglass.pro",
    provider: "openrouter",
    model: "anthropic/claude-4.7-opus",
    reasoning: "xhigh",
    billingMode: "metered",
    source: "runtime_seed",
    priority: 100,
    riskCeiling: "breakglass",
    metadata: { purpose: "Explicit user-approved expensive path" }
  }
];

export function llmPreflight(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  ensureCostPolicySeeds(host);
  validateRequestedProvider(input);

  return host.recordMutation("llm_preflight", input, context, (session) => {
    const started = performance.now();
    const task = taskRecord(input);
    const taskType = normalizeTaskType(task);
    const client = getString(input, "client");
    const candidateModel = getString(input, "candidateModel");
    const requestedProvider = getOptionalString(input, "requestedProvider");
    const requestedReasoning = normalizeReasoning(getOptionalString(input, "requestedReasoning"));
    const selected = resolveRoute(candidateModel, requestedProvider, requestedReasoning);
    const route = routeRow(host, selected.provider, selected.model);
    if (!route) {
      throw new FabricError("UNKNOWN_MODEL_ROUTE", `No cost route is configured for ${selected.provider}/${selected.model}`, false);
    }

    const contextPackage = asRecord(getField(input, "contextPackage"));
    const contextSummary = contextPackageSummary(input, contextPackage);
    const toolSchemaCount = arrayFrom(input, "toolSchemas", contextPackage).length;
    const mcpServerCount = arrayFrom(input, "mcpServers", contextPackage).length;
    const inputTokens = estimateInputTokens(input, contextPackage, contextSummary);
    const reservation = reservationRow(host, selected.model, taskType, selected.reasoning);
    const reservedOutputTokens = reservation?.p95_output_tokens ?? fallbackOutputTokens(taskType, selected.reasoning);
    const estimatedCostUsd = estimateUsd(route, inputTokens, reservedOutputTokens);
    const sensitiveFlags = sensitiveFlagsFor(input, contextPackage, task);
    const unverifiedMemory = hasUnverifiedMemory(contextPackage);
    const warnings: string[] = [];
    const risk = classifyRisk({
      estimatedCostUsd,
      inputTokens,
      selectedReasoning: selected.reasoning,
      taskType,
      toolSchemaCount,
      sensitiveFlags,
      unverifiedMemory,
      candidateModel
    });

    if (sensitiveFlags.length > 0) {
      warnings.push(`Sensitive context flagged (${sensitiveFlags.join(", ")}); compact or remove before routing.`);
    }
    if (toolSchemaCount > 5) {
      warnings.push(`Large tool schema set (${toolSchemaCount}) may be inflating prompt cost.`);
    }
    if (unverifiedMemory) {
      warnings.push("Context package includes unverified memory.");
    }

    const advisoryOnly = isAdvisoryOnly(client, session.litellm_routeable === 1);
    if (advisoryOnly) {
      warnings.push(`${client} is not routeable through LiteLLM in this bridge session; decision is advisory only.`);
    }

    const preflightId = newId("llmpf");
    const workspaceRoot = getOptionalString(input, "workspaceRoot") ?? context.workspaceRoot ?? session.workspace_root;
    const budgetScope = getOptionalString(input, "budgetScope") ?? "session";
    const boundResourceId = getOptionalString(input, "boundResourceId") ?? budgetScope;
    const billingPreference = getOptionalString(input, "billingPreference") ?? route.billing_mode;
    const approvalToken = getOptionalString(input, "approvalToken");
    const baseDecision = decide(risk, sensitiveFlags.length > 0);
    const tokenResult = approvalToken && baseDecision === "needs_user_approval"
      ? consumeApprovalToken(host, approvalToken, {
          workspaceRoot,
          selectedProvider: selected.provider,
          selectedModel: selected.model,
          selectedReasoning: selected.reasoning,
          estimatedCostUsd,
          inputTokens,
          budgetScope,
          boundResourceId
        })
      : undefined;
    if (tokenResult && !tokenResult.accepted) {
      warnings.push(tokenResult.warning);
    }
    const decision: Decision = tokenResult?.accepted && baseDecision === "needs_user_approval" ? "allow" : baseDecision;

    host.db.db
      .prepare(
        `INSERT INTO llm_preflight_requests (
          id, session_id, agent_id, host_name, workspace_root, client, task_type,
          task_json, candidate_model, requested_provider, selected_provider, selected_model,
          requested_reasoning, selected_reasoning, billing_preference, budget_scope,
          input_tokens, reserved_output_tokens, estimated_cost_usd, risk, decision,
          advisory_only, warnings_json, sensitive_flags_json, context_summary_json,
          tool_schema_count, mcp_server_count, origin_peer_id, trace_id, correlation_id,
          idempotency_key, approval_token_hash, test_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        preflightId,
        session.id,
        session.agent_id,
        session.host_name,
        workspaceRoot,
        client,
        taskType,
        JSON.stringify(task),
        candidateModel,
        requestedProvider ?? null,
        selected.provider,
        selected.model,
        requestedReasoning ?? null,
        selected.reasoning,
        billingPreference,
        budgetScope,
        inputTokens,
        reservedOutputTokens,
        estimatedCostUsd,
        risk,
        decision,
        advisoryOnly ? 1 : 0,
        JSON.stringify(warnings),
        JSON.stringify(sensitiveFlags),
        JSON.stringify(contextSummary),
        toolSchemaCount,
        mcpServerCount,
        host.originPeerId,
        context.traceId ?? null,
        context.correlationId ?? null,
        context.idempotencyKey ?? null,
        approvalToken ? hashSecret(approvalToken) : null,
        session.test_mode
      );

    const memories = Array.isArray(contextPackage.memories) ? contextPackage.memories : [];
    const contextPackageRecord = recordContextPackage(host, {
      preflightId,
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot,
      client,
      taskType,
      inputTokens,
      contextPackage,
      contextSummary,
      toolSchemas: arrayFrom(input, "toolSchemas", contextPackage),
      mcpServers: arrayFrom(input, "mcpServers", contextPackage),
      memories,
      sensitiveFlags,
      originPeerId: host.originPeerId,
      traceId: context.traceId,
      correlationId: context.correlationId,
      testMode: session.test_mode === 1
    });

    const approvalRequest =
      decision === "needs_user_approval"
        ? createApprovalRequest(host, {
            preflightId,
            sessionId: session.id,
            agentId: session.agent_id,
            hostName: session.host_name,
            workspaceRoot,
            client,
            taskType,
            selectedProvider: selected.provider,
            selectedModel: selected.model,
            selectedReasoning: selected.reasoning,
            inputTokens,
            reservedOutputTokens,
            estimatedCostUsd,
            risk,
            warnings,
            testMode: session.test_mode === 1,
            context
          })
        : undefined;

    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot,
      action: "llm.preflight",
      sourceTable: "llm_preflight_requests",
      sourceId: preflightId,
      eventType: "llm.preflight",
      payload: {
        preflightId,
        client,
        taskType,
        candidateModel,
        selectedProvider: selected.provider,
        selectedModel: selected.model,
        selectedReasoning: selected.reasoning,
        inputTokens,
        reservedOutputTokens,
        estimatedCostUsd,
        risk,
        decision,
        advisoryOnly,
        warnings,
        contextPackageId: contextPackageRecord.contextPackageId
      },
      testMode: session.test_mode === 1,
      context
    });

    return {
      requestId: preflightId,
      decision,
      risk,
      advisoryOnly,
      selected: {
        provider: selected.provider,
        model: selected.model,
        reasoning: selected.reasoning,
        billingMode: route.billing_mode,
        priceSource: route.source,
        priceConfidence: route.confidence,
        discountExpiresAt: route.discount_expires_at ?? undefined
      },
      estimate: {
        inputTokens,
        reservedOutputTokens,
        estimatedCostUsd
      },
      budgetScope,
      warnings,
      contextPackage: {
        contextPackageId: contextPackageRecord.contextPackageId,
        inspectTool: "fabric_inspect_context_package"
      },
      approval: approvalRequest
        ? {
            required: true,
            requestId: preflightId,
            expiresAt: approvalRequest.expiresAt
          }
        : tokenResult?.accepted
          ? {
              accepted: true,
              requestId: tokenResult.requestId,
              scope: tokenResult.scope,
              expiresAt: tokenResult.expiresAt,
              usesRemaining: tokenResult.usesRemaining
            }
          : undefined,
      fastPathLatencyMs: Math.max(0, Math.round((performance.now() - started) * 100) / 100)
    };
  });
}

export function llmHardGate(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const preflight = llmPreflight(host, input, context);
  const decision = String(preflight.decision ?? "");
  const advisoryOnly = Boolean(preflight.advisoryOnly);
  const client = getString(input, "client");
  const enforce = getOptionalBoolean(input, "enforce") ?? true;
  const allowModelCall = decision === "allow";
  const requiresApproval = decision === "needs_user_approval";
  const requiresCompaction = decision === "compact_first";
  const blockReason = allowModelCall
    ? undefined
    : requiresCompaction
      ? "compact_or_remove_sensitive_context"
      : requiresApproval
        ? "human_approval_required"
        : `preflight_decision:${decision}`;
  return {
    gate: {
      schema: "agent-fabric.llm-hard-gate.v1",
      client,
      enforced: enforce,
      enforcementMode: advisoryOnly ? "participating_client" : "gateway_or_participating_client",
      participatingClientRequired: true,
      allowModelCall,
      mustBlock: enforce && !allowModelCall,
      blockReason,
      requiresApproval,
      requiresCompaction,
      adapterContract: [
        "Call llm_hard_gate before each metered model request.",
        "If allowModelCall is false, do not send the model request.",
        "If requiresApproval is true, surface the approval request and retry with approvalToken after llm_approve.",
        "If requiresCompaction is true, remove sensitive or wasteful context and run the gate again.",
        "Report the completed call through llm_route_feedback."
      ]
    },
    preflight
  };
}

export function modelBrainRoute(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  ensureCostPolicySeeds(host);
  const roleAlias = getOptionalString(input, "roleAlias");
  const candidateModelInput = getOptionalString(input, "candidateModel");
  if (!roleAlias && !candidateModelInput) {
    throw new FabricError("INVALID_INPUT", "model_brain_route requires roleAlias or candidateModel", false);
  }

  const alias = roleAlias ? policyAliasRow(host, roleAlias) : undefined;
  const task = taskRecord(input);
  const taskType = normalizeTaskType(task);
  const risk = normalizeRisk(getOptionalString(input, "risk"));
  const requestedReasoning = normalizeReasoning(getOptionalString(input, "requestedReasoning"));
  const candidateModel = candidateModelInput ?? alias?.model;
  if (!candidateModel) {
    throw new FabricError("INVALID_INPUT", "model_brain_route requires roleAlias or candidateModel", false);
  }

  const gateInput = {
    ...asRecord(input),
    task,
    candidateModel,
    requestedProvider: getOptionalString(input, "requestedProvider") ?? alias?.provider,
    requestedReasoning: requestedReasoning ?? alias?.reasoning,
    budgetScope: getOptionalString(input, "budgetScope") ?? (roleAlias ? `model_brain:${roleAlias}` : "model_brain")
  };
  const gated = llmHardGate(host, gateInput, context);
  const preflight = asRecord(gated.preflight);
  const selected = asRecord(preflight.selected);
  const estimate = asRecord(preflight.estimate);
  const aliasWarnings = alias
    ? aliasConstraintWarnings(alias, {
        taskType,
        contextSize: Number(estimate.inputTokens ?? 0),
        estimatedCostUsd: typeof estimate.estimatedCostUsd === "number" ? estimate.estimatedCostUsd : undefined,
        risk
      })
    : { reasonCodes: ["explicit_candidate_model"], warnings: [] };
  const brainRecommendations = modelBrainRecommendations(gated, aliasWarnings.warnings);

  return {
    schema: "agent-fabric.model-brain-route.v1",
    roleAlias,
    taskType,
    route: {
      provider: selected.provider,
      model: selected.model,
      reasoning: selected.reasoning,
      billingMode: selected.billingMode,
      priceSource: selected.priceSource,
      priceConfidence: selected.priceConfidence,
      aliasSource: alias?.source,
      reasonCodes: aliasWarnings.reasonCodes
    },
    gate: gated.gate,
    estimate,
    risk: preflight.risk,
    decision: preflight.decision,
    budgetScope: preflight.budgetScope,
    warnings: [...stringArray(preflight.warnings), ...aliasWarnings.warnings],
    contextPackage: preflight.contextPackage,
    approval: preflight.approval,
    recommendations: brainRecommendations,
    preflightRequestId: preflight.requestId
  };
}

export function llmApprovePending(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const workspaceRoot = getOptionalString(input, "workspaceRoot") ?? context.workspaceRoot ?? session.workspace_root;
  const includeExpired = getOptionalBoolean(input, "includeExpired") ?? false;
  const max = Math.min(Math.max(Math.round(getOptionalNumber(input, "max") ?? 20), 1), 100);
  const nowIso = host.now().toISOString();
  const rows = host.db.db
    .prepare(
      `SELECT * FROM approval_requests
       WHERE workspace_root = ?
         AND status = 'pending'
         AND (? = 1 OR expires_at > ?)
       ORDER BY ts_created ASC
       LIMIT ?`
    )
    .all(workspaceRoot, includeExpired ? 1 : 0, nowIso, max) as ApprovalRequestRow[];

  return {
    workspaceRoot,
    count: rows.length,
    requests: rows.map((row) => approvalRequestSummary(row, nowIso))
  };
}

export function llmApprove(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  return host.recordMutation("llm_approve", input, context, (session) => {
    const requestId = getString(input, "requestId");
    const decision = normalizeApprovalDecision(getString(input, "decision"));
    const scope = normalizeApprovalScope(getOptionalString(input, "scope"));
    const boundResourceId = getOptionalString(input, "boundResourceId") ?? requestId;
    const note = getOptionalString(input, "note") ?? null;
    const nowIso = host.now().toISOString();
    const row = host.db.db.prepare("SELECT * FROM approval_requests WHERE preflight_request_id = ?").get(requestId) as
      | ApprovalRequestRow
      | undefined;
    if (!row) {
      throw new FabricError("APPROVAL_REQUEST_NOT_FOUND", `Approval request not found for preflight: ${requestId}`, false);
    }
    if (row.status !== "pending") {
      throw new FabricError("APPROVAL_ALREADY_DECIDED", `Approval request ${requestId} is already ${row.status}`, false);
    }
    if (Date.parse(row.expires_at) <= host.now().getTime()) {
      throw new FabricError("APPROVAL_EXPIRED", `Approval request ${requestId} expired at ${row.expires_at}`, false);
    }

    const status = statusForApprovalDecision(decision);
    const token = decision === "allow" ? newSessionToken() : undefined;
    const tokenHash = token ? hashSecret(token) : null;
    const tokenExpiresAt = token ? tokenExpiry(host, getOptionalNumber(input, "expiresInSeconds")).toISOString() : null;
    const maxUses = tokenMaxUses(scope);

    host.db.db
      .prepare(
        `UPDATE approval_requests
         SET status = ?, decision = ?, decided_at = ?, decided_by_session_id = ?, decided_by_agent_id = ?,
             note = ?, scope = ?, bound_resource_id = ?, approval_token_hash = ?,
             approval_token_expires_at = ?, approval_token_max_uses = ?, approval_token_uses = 0
         WHERE preflight_request_id = ?`
      )
      .run(status, decision, nowIso, session.id, session.agent_id, note, scope, boundResourceId, tokenHash, tokenExpiresAt, maxUses, requestId);

    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: row.workspace_root,
      action: "llm.approval.decided",
      sourceTable: "approval_requests",
      sourceId: row.id,
      eventType: "llm.approval.decided",
      payload: {
        requestId,
        status,
        decision,
        scope,
        boundResourceId,
        tokenIssued: Boolean(token),
        tokenExpiresAt
      },
      testMode: session.test_mode === 1,
      context
    });

    return {
      requestId,
      status,
      decision,
      scope,
      boundResourceId,
      approvalToken: token,
      tokenExpiresAt,
      expiresAt: row.expires_at
    };
  });
}

export function llmBudgetStatus(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  ensureCostPolicySeeds(host);
  const session = host.requireSession(context);
  const workspaceRoot = getOptionalString(input, "workspaceRoot") ?? context.workspaceRoot ?? session.workspace_root;
  const scope = getOptionalString(input, "scope") ?? "month";
  const since = getOptionalString(input, "since") ?? sinceForScope(scope, host.now());
  const sessionId = getOptionalString(input, "sessionId");
  const chainId = getOptionalString(input, "chainId");
  const model = getOptionalString(input, "model");
  const warnings: string[] = [];
  if (chainId) warnings.push("chainId filtering is reserved for a later orchestrator integration; current totals are workspace/session scoped.");

  const clauses = ["workspace_root = ?"];
  const params: string[] = [workspaceRoot];
  if (since) {
    clauses.push("ts >= ?");
    params.push(since);
  }
  if (scope === "session") {
    clauses.push("session_id = ?");
    params.push(sessionId ?? session.id);
  } else if (sessionId) {
    clauses.push("session_id = ?");
    params.push(sessionId);
  }
  if (model) {
    clauses.push("selected_model = ?");
    params.push(model);
  }

  const rows = host.db.db
    .prepare(`SELECT selected_provider, selected_model, decision, risk, estimated_cost_usd FROM llm_preflight_requests WHERE ${clauses.join(" AND ")}`)
    .all(...params) as PreflightRow[];

  return {
    workspaceRoot,
    scope,
    since: since ?? null,
    preflightCount: rows.length,
    estimatedCostUsd: roundUsd(sum(rows.map((row) => row.estimated_cost_usd))),
    byDecision: aggregate(rows, (row) => row.decision),
    byModel: aggregate(rows, (row) => row.selected_model),
    byProvider: aggregate(rows, (row) => row.selected_provider),
    highRiskCount: rows.filter((row) => row.risk === "high").length,
    breakglassCount: rows.filter((row) => row.risk === "breakglass").length,
    warnings
  };
}

export function policyResolveAlias(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  ensureCostPolicySeeds(host);
  const session = host.requireSession(context);
  const alias = getString(input, "alias");
  const taskType = getOptionalString(input, "taskType") ?? "unknown";
  const contextSize = getOptionalNumber(input, "contextSize") ?? 0;
  const estimatedCostUsd = getOptionalNumber(input, "estimatedCostUsd");
  const risk = normalizeRisk(getOptionalString(input, "risk"));
  const row = policyAliasRow(host, alias);
  const route = routeRow(host, row.provider, row.model);
  if (!route) {
    throw new FabricError("UNKNOWN_MODEL_ROUTE", `Policy alias ${alias} points to missing route ${row.provider}/${row.model}`, false);
  }
  const { reasonCodes, warnings } = aliasConstraintWarnings(row, { taskType, contextSize, estimatedCostUsd, risk });
  const result = {
    alias,
    provider: row.provider,
    model: row.model,
    reasoning: row.reasoning,
    billingMode: row.billing_mode,
    source: row.source,
    taskType,
    reasonCodes,
    warnings,
    metadata: safeJsonRecord(row.metadata_json)
  };
  host.writeAuditAndEvent({
    sessionId: session.id,
    agentId: session.agent_id,
    hostName: session.host_name,
    workspaceRoot: session.workspace_root,
    action: "policy.alias.resolved",
    sourceTable: "policy_aliases",
    sourceId: alias,
    eventType: "policy.alias.resolved",
    payload: { alias, provider: row.provider, model: row.model, reasoning: row.reasoning, taskType, reasonCodes, warnings },
    testMode: session.test_mode === 1,
    context
  });
  return result;
}

export function llmRouteFeedback(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const requestId = getString(input, "requestId");
  const outcome = normalizeRouteOutcome(getString(input, "outcome"));
  const evidence = asRecord(getField(input, "evidence"));
  const qualityScore = getOptionalNumber(input, "qualityScore");
  const retryCount = getOptionalNumber(input, "retryCount") ?? 0;
  const latencyMs = getOptionalNumber(input, "latencyMs") ?? null;
  const costUsd = getOptionalNumber(input, "costUsd") ?? null;
  if (qualityScore !== undefined && (qualityScore < 0 || qualityScore > 1)) {
    throw new FabricError("INVALID_INPUT", "qualityScore must be between 0 and 1", false);
  }
  if (!Number.isInteger(retryCount) || retryCount < 0) {
    throw new FabricError("INVALID_INPUT", "retryCount must be a non-negative integer", false);
  }
  if (latencyMs !== null && (!Number.isInteger(latencyMs) || latencyMs < 0)) {
    throw new FabricError("INVALID_INPUT", "latencyMs must be a non-negative integer", false);
  }
  if (costUsd !== null && costUsd < 0) {
    throw new FabricError("INVALID_INPUT", "costUsd must be non-negative", false);
  }

  return host.recordMutation("llm_route_feedback", input, context, (session) => {
    const preflight = host.db.db.prepare("SELECT * FROM llm_preflight_requests WHERE id = ?").get(requestId) as
      | PreflightRequestRow
      | undefined;
    if (!preflight || preflight.workspace_root !== session.workspace_root) {
      throw new FabricError("PREFLIGHT_REQUEST_NOT_FOUND", `Preflight request not found: ${requestId}`, false);
    }
    const outcomeId = newId("rout");
    host.db.db
      .prepare(
        `INSERT INTO route_outcomes (
          id, preflight_request_id, session_id, agent_id, host_name, workspace_root,
          client, task_type, selected_provider, selected_model, selected_reasoning,
          outcome, quality_score, retry_count, latency_ms, cost_usd, evidence_json,
          trace_id, correlation_id, origin_peer_id, test_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        outcomeId,
        requestId,
        session.id,
        session.agent_id,
        session.host_name,
        preflight.workspace_root,
        preflight.client,
        preflight.task_type,
        preflight.selected_provider,
        preflight.selected_model,
        preflight.selected_reasoning,
        outcome,
        qualityScore ?? null,
        retryCount,
        latencyMs,
        costUsd,
        JSON.stringify(evidence),
        context.traceId ?? preflight.trace_id,
        context.correlationId ?? preflight.correlation_id,
        host.originPeerId,
        session.test_mode
      );
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: preflight.workspace_root,
      action: "llm.route_feedback",
      sourceTable: "route_outcomes",
      sourceId: outcomeId,
      eventType: "llm.route_feedback",
      payload: {
        requestId,
        outcome,
        qualityScore,
        retryCount,
        latencyMs,
        costUsd,
        selectedProvider: preflight.selected_provider,
        selectedModel: preflight.selected_model,
        taskType: preflight.task_type
      },
      testMode: session.test_mode === 1,
      context: { ...context, traceId: context.traceId ?? preflight.trace_id ?? undefined, correlationId: context.correlationId ?? preflight.correlation_id ?? undefined }
    });
    return { outcomeId, requestId, outcome };
  });
}

export function fabricRouteOutcomesSummary(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const workspaceRoot = getOptionalString(input, "workspaceRoot") ?? context.workspaceRoot ?? session.workspace_root;
  const since = getOptionalString(input, "since") ?? sinceForOutcomeWindow(host, getOptionalNumber(input, "sinceDays") ?? 7);
  const rows = host.db.db
    .prepare(
      `SELECT
        selected_provider,
        selected_model,
        task_type,
        outcome,
        COUNT(*) AS count,
        AVG(quality_score) AS avg_quality_score,
        AVG(cost_usd) AS avg_cost_usd,
        AVG(latency_ms) AS avg_latency_ms,
        SUM(retry_count) AS total_retries
      FROM route_outcomes
      WHERE workspace_root = ? AND ts >= ?
      GROUP BY selected_provider, selected_model, task_type, outcome
      ORDER BY count DESC, selected_provider, selected_model, task_type, outcome`
    )
    .all(workspaceRoot, since) as RouteOutcomeSummaryRow[];

  return {
    workspaceRoot,
    since,
    totalOutcomes: rows.reduce((total, row) => total + row.count, 0),
    byRoute: rows.map((row) => ({
      provider: row.selected_provider,
      model: row.selected_model,
      taskType: row.task_type,
      outcome: row.outcome,
      count: row.count,
      avgQualityScore: row.avg_quality_score === null ? null : roundMetric(row.avg_quality_score),
      avgCostUsd: row.avg_cost_usd === null ? null : roundUsd(row.avg_cost_usd),
      avgLatencyMs: row.avg_latency_ms === null ? null : Math.round(row.avg_latency_ms),
      totalRetries: row.total_retries ?? 0
    }))
  };
}

function ensureCostPolicySeeds(host: SurfaceHost): void {
  for (const route of ROUTE_SEEDS) {
    host.db.db
      .prepare(
        `INSERT INTO route_cheapness (
          id, provider, model, billing_mode, source, confidence,
          input_price_per_mtok_micros, output_price_per_mtok_micros,
          cache_read_price_per_mtok_micros, discount_expires_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')
        ON CONFLICT(provider, model) DO NOTHING`
      )
      .run(
        newId("route"),
        route.provider,
        route.model,
        route.billingMode,
        route.source,
        route.confidence,
        route.inputPricePerMtokMicros,
        route.outputPricePerMtokMicros,
        route.cacheReadPricePerMtokMicros ?? null,
        route.discountExpiresAt ?? null
      );
  }

  for (const reservation of RESERVATION_SEEDS) {
    host.db.db
      .prepare(
        `INSERT INTO output_reservations (
          id, model, task_type, reasoning, p50_output_tokens, p95_output_tokens, source
        ) VALUES (?, ?, ?, ?, ?, ?, 'runtime_seed')
        ON CONFLICT(model, task_type, reasoning) DO NOTHING`
      )
      .run(
        newId("outres"),
        reservation.model,
        reservation.taskType,
        reservation.reasoning,
        reservation.p50OutputTokens,
        reservation.p95OutputTokens
      );
  }

  for (const alias of POLICY_ALIAS_SEEDS) {
    host.db.db
      .prepare(
        `INSERT INTO policy_aliases (
          alias, provider, model, reasoning, billing_mode, source, priority,
          max_input_tokens, max_estimated_cost_usd, risk_ceiling, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(alias) DO NOTHING`
      )
      .run(
        alias.alias,
        alias.provider,
        alias.model,
        alias.reasoning,
        alias.billingMode,
        alias.source,
        alias.priority,
        alias.maxInputTokens ?? null,
        alias.maxEstimatedCostUsd ?? null,
        alias.riskCeiling ?? null,
        JSON.stringify(alias.metadata ?? {})
      );
  }
}

function policyAliasRow(host: SurfaceHost, alias: string): PolicyAliasRow {
  const row = host.db.db.prepare("SELECT * FROM policy_aliases WHERE alias = ?").get(alias) as PolicyAliasRow | undefined;
  if (!row) {
    throw new FabricError("POLICY_ALIAS_NOT_FOUND", `Policy alias not found: ${alias}`, false);
  }
  return row;
}

function aliasConstraintWarnings(
  row: PolicyAliasRow,
  input: { taskType: string; contextSize: number; estimatedCostUsd?: number; risk?: Risk }
): { reasonCodes: string[]; warnings: string[] } {
  const reasonCodes = ["alias_match", `source:${row.source}`];
  const warnings: string[] = [];
  if (row.max_input_tokens !== null && input.contextSize > row.max_input_tokens) {
    warnings.push(`Context size ${input.contextSize} exceeds alias max_input_tokens ${row.max_input_tokens}.`);
    reasonCodes.push("context_exceeds_alias_limit");
  }
  if (row.max_estimated_cost_usd !== null && input.estimatedCostUsd !== undefined && input.estimatedCostUsd > row.max_estimated_cost_usd) {
    warnings.push(`Estimated cost $${input.estimatedCostUsd} exceeds alias max_estimated_cost_usd $${row.max_estimated_cost_usd}.`);
    reasonCodes.push("cost_exceeds_alias_limit");
  }
  if (row.risk_ceiling && input.risk && riskRank(input.risk) > riskRank(row.risk_ceiling)) {
    warnings.push(`Risk ${input.risk} exceeds alias risk ceiling ${row.risk_ceiling}.`);
    reasonCodes.push("risk_exceeds_alias_ceiling");
  }
  return { reasonCodes, warnings };
}

function modelBrainRecommendations(gated: Record<string, unknown>, aliasWarnings: string[]): string[] {
  const gate = asRecord(gated.gate);
  const preflight = asRecord(gated.preflight);
  const recommendations: string[] = [];
  if (gate.allowModelCall === true) {
    recommendations.push("Proceed with the selected route and report outcome feedback after the call.");
  }
  if (gate.requiresApproval === true) {
    recommendations.push("Pause the client request, show the approval inbox, and retry with the issued approval token.");
  }
  if (gate.requiresCompaction === true) {
    recommendations.push("Run the context package inspector, remove sensitive or wasteful context, and preflight again.");
  }
  if (gate.enforcementMode === "participating_client") {
    recommendations.push("This route is not gateway-enforced; the participating VS Code extension must fail closed locally.");
  }
  if (aliasWarnings.length > 0) {
    recommendations.push("Review alias constraint warnings before sending the request.");
  }
  if (stringArray(preflight.warnings).some((warning) => /tool schema|context package|Sensitive|unverified/i.test(warning))) {
    recommendations.push("Inspect the context package before approving or retrying the model call.");
  }
  return recommendations;
}

function createApprovalRequest(
  host: SurfaceHost,
  input: {
    preflightId: string;
    sessionId: string;
    agentId: string;
    hostName: string | null;
    workspaceRoot: string;
    client: string;
    taskType: string;
    selectedProvider: string;
    selectedModel: string;
    selectedReasoning: string;
    inputTokens: number;
    reservedOutputTokens: number;
    estimatedCostUsd: number;
    risk: Risk;
    warnings: string[];
    testMode: boolean;
    context: CallContext;
  }
): { approvalRequestId: string; expiresAt: string } {
  const approvalRequestId = newId("appr");
  const expiresAt = new Date(host.now().getTime() + 60 * 60 * 1000).toISOString();
  host.db.db
    .prepare(
      `INSERT INTO approval_requests (
        id, preflight_request_id, expires_at, origin_peer_id, session_id, agent_id, host_name,
        workspace_root, client, task_type, selected_provider, selected_model, selected_reasoning,
        input_tokens, reserved_output_tokens, estimated_cost_usd, risk, warnings_json, test_mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      approvalRequestId,
      input.preflightId,
      expiresAt,
      host.originPeerId,
      input.sessionId,
      input.agentId,
      input.hostName,
      input.workspaceRoot,
      input.client,
      input.taskType,
      input.selectedProvider,
      input.selectedModel,
      input.selectedReasoning,
      input.inputTokens,
      input.reservedOutputTokens,
      input.estimatedCostUsd,
      input.risk,
      JSON.stringify(input.warnings),
      input.testMode ? 1 : 0
    );

  host.writeAuditAndEvent({
    sessionId: input.sessionId,
    agentId: input.agentId,
    hostName: input.hostName,
    workspaceRoot: input.workspaceRoot,
    action: "llm.approval.requested",
    sourceTable: "approval_requests",
    sourceId: approvalRequestId,
    eventType: "llm.approval.requested",
    payload: {
      requestId: input.preflightId,
      expiresAt,
      client: input.client,
      taskType: input.taskType,
      selectedProvider: input.selectedProvider,
      selectedModel: input.selectedModel,
      selectedReasoning: input.selectedReasoning,
      estimatedCostUsd: input.estimatedCostUsd,
      risk: input.risk
    },
    testMode: input.testMode,
    context: input.context
  });

  return { approvalRequestId, expiresAt };
}

function consumeApprovalToken(
  host: SurfaceHost,
  token: string,
  request: {
    workspaceRoot: string;
    selectedProvider: string;
    selectedModel: string;
    selectedReasoning: string;
    estimatedCostUsd: number;
    inputTokens: number;
    budgetScope: string;
    boundResourceId: string;
  }
): ApprovalTokenResult {
  const tokenHash = hashSecret(token);
  const row = host.db.db.prepare("SELECT * FROM approval_requests WHERE approval_token_hash = ?").get(tokenHash) as
    | ApprovalRequestRow
    | undefined;
  if (!row) {
    return { accepted: false, warning: "Approval token was not accepted: token not found." };
  }
  if (row.status !== "approved") {
    return { accepted: false, warning: `Approval token was not accepted: request is ${row.status}.` };
  }
  if (!row.approval_token_expires_at || Date.parse(row.approval_token_expires_at) <= host.now().getTime()) {
    return { accepted: false, warning: "Approval token was not accepted: token expired." };
  }
  if (row.approval_token_uses >= row.approval_token_max_uses) {
    return { accepted: false, warning: "Approval token was not accepted: token already used." };
  }
  if (!approvalTokenMatches(row, request)) {
    return { accepted: false, warning: "Approval token was not accepted: token does not match this route or budget." };
  }

  host.db.db
    .prepare("UPDATE approval_requests SET approval_token_uses = approval_token_uses + 1 WHERE id = ?")
    .run(row.id);
  return {
    accepted: true,
    requestId: row.preflight_request_id,
    scope: row.scope ?? "call",
    expiresAt: row.approval_token_expires_at,
    usesRemaining: Math.max(0, row.approval_token_max_uses - row.approval_token_uses - 1)
  };
}

function approvalTokenMatches(
  row: ApprovalRequestRow,
  request: {
    workspaceRoot: string;
    selectedProvider: string;
    selectedModel: string;
    selectedReasoning: string;
    estimatedCostUsd: number;
    inputTokens: number;
    budgetScope: string;
    boundResourceId: string;
  }
): boolean {
  const storedResource = row.bound_resource_id;
  const storedResourceIsOriginalRequest = storedResource === row.preflight_request_id;
  const resourceMatches = !storedResource || storedResourceIsOriginalRequest || storedResource === request.boundResourceId || storedResource === request.budgetScope;
  return (
    row.workspace_root === request.workspaceRoot &&
    row.selected_provider === request.selectedProvider &&
    row.selected_model === request.selectedModel &&
    row.selected_reasoning === request.selectedReasoning &&
    request.estimatedCostUsd <= row.estimated_cost_usd &&
    request.inputTokens <= row.input_tokens &&
    resourceMatches
  );
}

function normalizeApprovalDecision(value: string): ApprovalDecision {
  if (["allow", "compact", "downgrade", "cancel"].includes(value)) return value as ApprovalDecision;
  throw new FabricError("INVALID_INPUT", "decision must be allow, compact, downgrade, or cancel", false);
}

function normalizeRouteOutcome(value: string): string {
  if (ROUTE_OUTCOMES.has(value)) return value;
  throw new FabricError("INVALID_INPUT", `outcome must be one of: ${[...ROUTE_OUTCOMES].join(", ")}`, false);
}

function normalizeRisk(value: string | undefined): Risk | undefined {
  if (!value) return undefined;
  if (["low", "medium", "high", "breakglass"].includes(value)) return value as Risk;
  throw new FabricError("INVALID_INPUT", "risk must be low, medium, high, or breakglass", false);
}

function riskRank(value: Risk): number {
  return { low: 0, medium: 1, high: 2, breakglass: 3 }[value];
}

function statusForApprovalDecision(decision: ApprovalDecision): ApprovalStatus {
  if (decision === "allow") return "approved";
  if (decision === "compact") return "compact_requested";
  if (decision === "downgrade") return "downgrade_requested";
  return "canceled";
}

function normalizeApprovalScope(value: string | undefined): string {
  if (!value) return "call";
  if (["call", "chain", "session", "day"].includes(value)) return value;
  throw new FabricError("INVALID_INPUT", "scope must be call, chain, session, or day", false);
}

function tokenMaxUses(scope: string): number {
  if (scope === "call") return 1;
  if (scope === "chain") return 50;
  if (scope === "day") return 200;
  return 100;
}

function tokenExpiry(host: SurfaceHost, requestedSeconds: number | undefined): Date {
  const seconds = Math.min(Math.max(Math.round(requestedSeconds ?? 15 * 60), 1), 24 * 60 * 60);
  return new Date(host.now().getTime() + seconds * 1000);
}

function approvalRequestSummary(row: ApprovalRequestRow, nowIso: string): Record<string, unknown> {
  return {
    requestId: row.preflight_request_id,
    approvalRequestId: row.id,
    createdAt: row.ts_created,
    expiresAt: row.expires_at,
    expired: Date.parse(row.expires_at) <= Date.parse(nowIso),
    status: row.status,
    client: row.client,
    taskType: row.task_type,
    workspaceRoot: row.workspace_root,
    selected: {
      provider: row.selected_provider,
      model: row.selected_model,
      reasoning: row.selected_reasoning
    },
    estimate: {
      inputTokens: row.input_tokens,
      reservedOutputTokens: row.reserved_output_tokens,
      estimatedCostUsd: row.estimated_cost_usd
    },
    risk: row.risk,
    warnings: safeJsonArray(row.warnings_json)
  };
}

function validateRequestedProvider(input: unknown): void {
  const requestedProvider = getOptionalString(input, "requestedProvider");
  if (requestedProvider && !KNOWN_PROVIDERS.has(requestedProvider)) {
    throw new FabricError("UNKNOWN_PROVIDER_ALIAS", `Unknown provider alias: ${requestedProvider}`, false);
  }
}

function taskRecord(input: unknown): Record<string, unknown> {
  const task = getField(input, "task");
  if (typeof task === "string") return { type: "unknown", body: task };
  const record = asRecord(task);
  if (Object.keys(record).length === 0) {
    throw new FabricError("INVALID_INPUT", "Expected task object or string", false);
  }
  return record;
}

function normalizeTaskType(task: Record<string, unknown>): string {
  const type = typeof task.type === "string" ? task.type : typeof task.kind === "string" ? task.kind : "unknown";
  return type.trim().toLowerCase() || "unknown";
}

function normalizeReasoning(value: string | undefined): Reasoning | undefined {
  if (!value) return undefined;
  if (["low", "medium", "high", "xhigh", "max"].includes(value)) return value as Reasoning;
  throw new FabricError("INVALID_INPUT", "requestedReasoning must be low, medium, high, xhigh, or max", false);
}

function resolveRoute(
  candidateModel: string,
  requestedProvider: string | undefined,
  requestedReasoning: Reasoning | undefined
): { provider: string; model: string; reasoning: Reasoning } {
  if (candidateModel === "worker.deepseek.max") {
    assertProviderCompatible(candidateModel, requestedProvider, "deepseek");
    return { provider: "deepseek", model: "deepseek-v4-pro", reasoning: requestedReasoning ?? "max" };
  }
  if (candidateModel === "worker.deepseek.openrouter") {
    assertProviderCompatible(candidateModel, requestedProvider, "openrouter");
    return { provider: "openrouter", model: "deepseek/deepseek-v4-pro", reasoning: requestedReasoning ?? "xhigh" };
  }
  if (candidateModel === "deepseek-v4-pro") {
    assertProviderCompatible(candidateModel, requestedProvider, "deepseek");
    return { provider: "deepseek", model: "deepseek-v4-pro", reasoning: requestedReasoning ?? "medium" };
  }
  if (candidateModel === "deepseek/deepseek-v4-pro") {
    assertProviderCompatible(candidateModel, requestedProvider, "openrouter");
    return { provider: "openrouter", model: "deepseek/deepseek-v4-pro", reasoning: requestedReasoning ?? "medium" };
  }
  if (candidateModel === "anthropic/claude-4.7-opus") {
    assertProviderCompatible(candidateModel, requestedProvider, "openrouter");
    return { provider: "openrouter", model: "anthropic/claude-4.7-opus", reasoning: requestedReasoning ?? "xhigh" };
  }
  if (candidateModel === "breakglass.pro") {
    assertProviderCompatible(candidateModel, requestedProvider, "openrouter");
    return { provider: "openrouter", model: "anthropic/claude-4.7-opus", reasoning: requestedReasoning ?? "xhigh" };
  }
  throw new FabricError("UNKNOWN_MODEL_ROUTE", `Unknown candidate model or route alias: ${candidateModel}`, false);
}

function assertProviderCompatible(candidateModel: string, requestedProvider: string | undefined, expectedProvider: string): void {
  if (requestedProvider && requestedProvider !== expectedProvider) {
    throw new FabricError(
      "PROVIDER_MODEL_CONFLICT",
      `${candidateModel} is configured for ${expectedProvider}; refusing silent substitution to ${requestedProvider}`,
      false
    );
  }
}

function routeRow(host: SurfaceHost, provider: string, model: string): RouteRow | undefined {
  return host.db.db
    .prepare("SELECT * FROM route_cheapness WHERE provider = ? AND model = ?")
    .get(provider, model) as RouteRow | undefined;
}

function reservationRow(host: SurfaceHost, model: string, taskType: string, reasoning: Reasoning): ReservationRow | undefined {
  return host.db.db
    .prepare("SELECT p50_output_tokens, p95_output_tokens FROM output_reservations WHERE model = ? AND task_type = ? AND reasoning = ?")
    .get(model, taskType, reasoning) as ReservationRow | undefined;
}

function contextPackageSummary(input: unknown, contextPackage: Record<string, unknown>): Record<string, unknown> {
  const direct = asRecord(getField(input, "contextPackageSummary"));
  if (Object.keys(direct).length > 0) return direct;
  return asRecord(contextPackage.summary);
}

function estimateInputTokens(input: unknown, contextPackage: Record<string, unknown>, contextSummary: Record<string, unknown>): number {
  const summarized = numericField(contextSummary, "inputTokens") ?? numericField(contextSummary, "estimatedTokens");
  if (summarized !== undefined) return Math.max(0, Math.round(summarized));
  const packaged = numericField(contextPackage, "inputTokens") ?? numericField(contextPackage, "estimatedTokens");
  if (packaged !== undefined) return Math.max(0, Math.round(packaged));
  const fallback = JSON.stringify({ contextPackage: getField(input, "contextPackage"), toolSchemas: getField(input, "toolSchemas") }).length;
  return Math.max(0, Math.ceil(fallback / 4));
}

function numericField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayFrom(input: unknown, field: string, contextPackage: Record<string, unknown>): unknown[] {
  const direct = getArray(input, field);
  if (direct.length > 0) return direct;
  const packaged = contextPackage[field];
  return Array.isArray(packaged) ? packaged : [];
}

function fallbackOutputTokens(taskType: string, reasoning: Reasoning): number {
  const base: Record<string, number> = {
    chat: 2_000,
    code_edit: 6_000,
    plan: 8_000,
    plan_chain: 10_000,
    review: 7_000,
    unknown: 4_000
  };
  const multiplier = reasoning === "max" ? 1.25 : reasoning === "xhigh" ? 1.1 : 1;
  return Math.round((base[taskType] ?? base.unknown) * multiplier);
}

function estimateUsd(route: RouteRow, inputTokens: number, outputTokens: number): number {
  const inputUsd = (inputTokens / 1_000_000) * (route.input_price_per_mtok_micros / 1_000_000);
  const outputUsd = (outputTokens / 1_000_000) * (route.output_price_per_mtok_micros / 1_000_000);
  return roundUsd(inputUsd + outputUsd);
}

function sensitiveFlagsFor(input: unknown, contextPackage: Record<string, unknown>, task: Record<string, unknown>): string[] {
  const flags = [
    ...getStringArray(input, "sensitiveFlags"),
    ...stringArray(contextPackage.sensitiveFlags),
    ...stringArray(task.sensitiveFlags)
  ].map((flag) => flag.trim().toLowerCase());
  return uniqueStrings(flags).filter((flag) => flag.length > 0);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function hasUnverifiedMemory(contextPackage: Record<string, unknown>): boolean {
  const memories = Array.isArray(contextPackage.memories) ? contextPackage.memories : [];
  return memories.some((memory) => asRecord(memory).verified === false || asRecord(memory).verifierStatus === "unverified");
}

function classifyRisk(input: {
  estimatedCostUsd: number;
  inputTokens: number;
  selectedReasoning: Reasoning;
  taskType: string;
  toolSchemaCount: number;
  sensitiveFlags: string[];
  unverifiedMemory: boolean;
  candidateModel: string;
}): Risk {
  const hasBreakglassFlag = input.sensitiveFlags.some((flag) => SENSITIVE_BREAKGLASS.has(flag) || /api[_-]?key|secret|cookie|production/.test(flag));
  if (input.estimatedCostUsd >= 2 || input.inputTokens >= 200_000 || hasBreakglassFlag || input.candidateModel === "breakglass.pro") {
    return "breakglass";
  }
  if (
    input.estimatedCostUsd >= 0.5 ||
    input.inputTokens >= 50_000 ||
    HIGH_REASONING.has(input.selectedReasoning) ||
    input.taskType === "review"
  ) {
    return "high";
  }
  if (input.estimatedCostUsd >= 0.1 || input.inputTokens >= 20_000 || input.toolSchemaCount > 5 || input.unverifiedMemory) {
    return "medium";
  }
  return "low";
}

function isAdvisoryOnly(client: string, litellmRouteable: boolean): boolean {
  return !litellmRouteable && ["codex", "codex_vscode", "claude_code", "claude_code_vscode"].includes(client);
}

function decide(risk: Risk, hasSensitiveFlags: boolean): Decision {
  if (hasSensitiveFlags) return "compact_first";
  if (risk === "high" || risk === "breakglass") return "needs_user_approval";
  return "allow";
}

function sinceForScope(scope: string, now: Date): string | undefined {
  if (scope === "all") return undefined;
  if (scope === "session") return undefined;
  if (scope === "day") return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const start = new Date(now);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  return start.toISOString();
}

function sinceForOutcomeWindow(host: SurfaceHost, days: number): string {
  const bounded = Math.min(Math.max(days, 1), 365);
  return new Date(host.now().getTime() - bounded * 24 * 60 * 60 * 1000).toISOString();
}

function aggregate(rows: PreflightRow[], keyFor: (row: PreflightRow) => string): Record<string, { count: number; estimatedCostUsd: number }> {
  const grouped: Record<string, { count: number; estimatedCostUsd: number }> = {};
  for (const row of rows) {
    const key = keyFor(row);
    grouped[key] ??= { count: 0, estimatedCostUsd: 0 };
    grouped[key].count += 1;
    grouped[key].estimatedCostUsd += row.estimated_cost_usd;
  }
  for (const value of Object.values(grouped)) {
    value.estimatedCostUsd = roundUsd(value.estimatedCostUsd);
  }
  return grouped;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundMetric(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
