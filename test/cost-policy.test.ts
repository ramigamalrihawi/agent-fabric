import { describe, expect, it } from "vitest";
import { FabricDaemon } from "../src/daemon.js";
import type { BridgeRegister } from "../src/types.js";

describe("ADR-0017 cost-aware routing preflight", () => {
  it("resolves worker.deepseek.max to direct DeepSeek with max reasoning", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "worker", litellmRouteable: true }));

    const result = daemon.callTool(
      "llm_preflight",
      preflightPayload({ candidateModel: "worker.deepseek.max", requestedProvider: "deepseek", taskType: "code_edit" }),
      contextFor(session, "pf-direct")
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("preflight failed");
    expect(result.data.selected).toMatchObject({ provider: "deepseek", model: "deepseek-v4-pro", reasoning: "max" });
    daemon.close();
  });

  it("resolves worker.deepseek.openrouter to OpenRouter DeepSeek with xhigh reasoning", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "worker", litellmRouteable: true }));

    const result = daemon.callTool(
      "llm_preflight",
      preflightPayload({ candidateModel: "worker.deepseek.openrouter", requestedProvider: "openrouter", taskType: "code_edit" }),
      contextFor(session, "pf-openrouter")
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("preflight failed");
    expect(result.data.selected).toMatchObject({ provider: "openrouter", model: "deepseek/deepseek-v4-pro", reasoning: "xhigh" });
    daemon.close();
  });

  it("rejects unknown provider aliases without inserting a preflight row", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "worker", litellmRouteable: true }));

    const result = daemon.callTool(
      "llm_preflight",
      preflightPayload({ requestedProvider: "mystery-provider" }),
      contextFor(session, "pf-unknown-provider")
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unknown provider unexpectedly succeeded");
    expect(result.code).toBe("UNKNOWN_PROVIDER_ALIAS");
    expect(tableCount(daemon, "llm_preflight_requests")).toBe(0);
    daemon.close();
  });

  it("does not silently substitute direct DeepSeek to OpenRouter", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "worker", litellmRouteable: true }));

    const result = daemon.callTool(
      "llm_preflight",
      preflightPayload({ candidateModel: "deepseek-v4-pro", requestedProvider: "openrouter" }),
      contextFor(session, "pf-conflict")
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("provider conflict unexpectedly succeeded");
    expect(result.code).toBe("PROVIDER_MODEL_CONFLICT");
    expect(tableCount(daemon, "llm_preflight_requests")).toBe(0);
    daemon.close();
  });

  it("requires user approval for high/max reasoning", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "worker", litellmRouteable: true }));

    const result = daemon.callTool(
      "llm_preflight",
      preflightPayload({ candidateModel: "worker.deepseek.max", requestedProvider: "deepseek", requestedReasoning: "max" }),
      contextFor(session, "pf-high")
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("preflight failed");
    expect(result.data).toMatchObject({ risk: "high", decision: "needs_user_approval" });
    daemon.close();
  });

  it("creates a pending approval request when preflight needs user approval", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "worker", litellmRouteable: true }));

    const result = daemon.callTool(
      "llm_preflight",
      preflightPayload({ candidateModel: "worker.deepseek.max", requestedProvider: "deepseek", requestedReasoning: "max" }),
      contextFor(session, "pf-approval-pending")
    );
    const pending = daemon.callTool("llm_approve_pending", {}, contextFor(session));

    expect(result.ok).toBe(true);
    expect(pending.ok).toBe(true);
    if (!result.ok || !pending.ok) throw new Error("approval setup failed");
    expect(tableCount(daemon, "approval_requests")).toBe(1);
    expect(result.data.approval).toMatchObject({ required: true, requestId: result.data.requestId });
    expect(pending.data.requests).toHaveLength(1);
    expect(pending.data.requests[0]).toMatchObject({
      requestId: result.data.requestId,
      status: "pending",
      selected: { provider: "deepseek", model: "deepseek-v4-pro", reasoning: "max" }
    });
    daemon.close();
  });

  it("stores and inspects a sanitized context package for preflight", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "worker", litellmRouteable: true }));

    const result = daemon.callTool(
      "llm_preflight",
      preflightPayload({
        candidateModel: "deepseek-v4-pro",
        requestedProvider: "deepseek",
        requestedReasoning: "medium",
        contextPackage: {
          inputTokens: 60_000,
          tokenBreakdown: { system: 1_000, files: 40_000, tools: 19_000 },
          files: [
            { path: "src/server.ts", tokens: 18_000, reason: "open editor", content: "raw file content must not be stored" },
            { path: "logs/big.log", tokens: 22_000, reason: "diagnostic", body: "raw log content must not be stored" }
          ],
          toolSchemas: [
            { name: "read", estimatedTokens: 1_000, schema: { raw: "do not store" } },
            { name: "edit", estimatedTokens: 1_000 },
            { name: "search", estimatedTokens: 1_000 },
            { name: "shell", estimatedTokens: 1_000 },
            { name: "browser", estimatedTokens: 1_000 },
            { name: "gmail", estimatedTokens: 1_000 }
          ],
          mcpServers: [{ name: "agent-fabric", toolCount: 20 }],
          memories: [{ id: "mem_1", verified: false, body: "raw memory body must not be stored" }],
          repeatedRegions: [{ kind: "file", path: "src/server.ts", tokens: 1_000 }],
          staleItems: [{ kind: "log", path: "logs/big.log", ageTurns: 10 }]
        },
        sensitiveFlags: ["production_data"]
      }),
      contextFor(session, "pf-context-inspect")
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("preflight failed");
    expect(result.data.contextPackage).toMatchObject({ inspectTool: "fabric_inspect_context_package" });

    const inspected = daemon.callTool(
      "fabric_inspect_context_package",
      { requestId: result.data.requestId },
      contextFor(session)
    );
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) throw new Error("inspect failed");
    expect(inspected.data).toMatchObject({
      requestId: result.data.requestId,
      rawContentStored: false,
      summary: {
        inputTokens: 60_000,
        fileCount: 2,
        toolSchemaCount: 6,
        mcpServerCount: 1,
        memoryCount: 1,
        sensitiveFlagCount: 1,
        repeatedRegionCount: 1,
        staleItemCount: 1
      },
      tokenBreakdown: { system: 1_000, files: 40_000, tools: 19_000 }
    });
    expect(JSON.stringify(inspected.data)).not.toContain("raw file content");
    expect(JSON.stringify(inspected.data)).not.toContain("raw log content");
    expect(JSON.stringify(inspected.data)).not.toContain("raw memory body");
    expect(inspected.data.warnings as string[]).toEqual(
      expect.arrayContaining([
        "Large context package (60000 tokens).",
        "Large tool schema set (6); consider dropping unused tools.",
        "Sensitive flags present: production_data.",
        "Repeated context detected (1 regions).",
        "Stale context detected (1 items).",
        "Unverified memory is present in the context package."
      ])
    );
    expect(inspected.data.analysis).toMatchObject({
      severity: "blocker",
      shouldCompactBeforeModel: true,
      estimatedWasteTokens: 2000,
      knownBreakdownTokens: 60000,
      breakdownCoverage: 1,
      repeatedTokenEstimate: 1000,
      staleTokenEstimate: 0,
      unverifiedMemoryCount: 1
    });
    expect(inspected.data.analysis.largestFiles[0]).toMatchObject({ path: "logs/big.log", tokens: 22000 });
    expect(inspected.data.analysis.suggestedActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "remove_sensitive_context", priority: "blocker" }),
        expect.objectContaining({ action: "compact_context" }),
        expect.objectContaining({ action: "trim_tool_schemas" }),
        expect.objectContaining({ action: "deduplicate_context" }),
        expect.objectContaining({ action: "drop_stale_context" }),
        expect.objectContaining({ action: "review_memory" })
      ])
    );
    daemon.close();
  });

  it("hard-gates participating Codex and Claude VS Code clients fail closed until approval", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "codex-vscode", litellmRouteable: false }));

    const blocked = daemon.callTool(
      "llm_hard_gate",
      preflightPayload({ client: "codex_vscode", candidateModel: "worker.deepseek.max", requestedProvider: "deepseek", requestedReasoning: "max" }),
      contextFor(session, "hard-gate-block")
    );
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) throw new Error("hard gate failed");
    expect(blocked.data.gate).toMatchObject({
      enforced: true,
      enforcementMode: "participating_client",
      allowModelCall: false,
      mustBlock: true,
      blockReason: "human_approval_required",
      requiresApproval: true
    });
    expect(blocked.data.preflight).toMatchObject({ decision: "needs_user_approval", advisoryOnly: true });

    const approval = daemon.callTool(
      "llm_approve",
      { requestId: blocked.data.preflight.requestId, decision: "allow", scope: "call", expiresInSeconds: 60 },
      contextFor(session, "hard-gate-approve")
    );
    expect(approval.ok).toBe(true);
    if (!approval.ok) throw new Error("approval failed");

    const allowed = daemon.callTool(
      "llm_hard_gate",
      preflightPayload({
        client: "codex_vscode",
        candidateModel: "worker.deepseek.max",
        requestedProvider: "deepseek",
        requestedReasoning: "max",
        approvalToken: approval.data.approvalToken
      }),
      contextFor(session, "hard-gate-allowed")
    );
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) throw new Error("approved hard gate failed");
    expect(allowed.data.gate).toMatchObject({ allowModelCall: true, mustBlock: false });
    expect(allowed.data.preflight.approval).toMatchObject({ accepted: true, requestId: blocked.data.preflight.requestId });
    daemon.close();
  });

  it("model brain resolves role aliases, estimates cost, and returns the hard gate contract", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "claude-code-vscode", litellmRouteable: false }));

    const result = daemon.callTool(
      "model_brain_route",
      {
        task: { type: "plan", goal: "Plan a risky extension integration." },
        client: "claude_code_vscode",
        roleAlias: "plan.strong",
        contextPackageSummary: { inputTokens: 5_000 },
        risk: "high",
        enforce: true
      },
      contextFor(session, "model-brain-plan")
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("model brain route failed");
    expect(result.data).toMatchObject({
      schema: "agent-fabric.model-brain-route.v1",
      roleAlias: "plan.strong",
      taskType: "plan",
      requested: {
        source: "role_alias",
        candidateModel: "anthropic/claude-4.7-opus",
        provider: "openrouter",
        reasoning: "xhigh",
        roleAlias: "plan.strong",
        aliasSource: "runtime_seed"
      },
      route: {
        provider: "openrouter",
        model: "anthropic/claude-4.7-opus",
        reasoning: "xhigh",
        reasonCodes: ["alias_match", "source:runtime_seed"]
      },
      routeResolution: {
        changed: false,
        providerChanged: false,
        modelChanged: false,
        reasoningChanged: false,
        summary: "Requested route matches selected route."
      },
      gate: {
        enforcementMode: "participating_client",
        allowModelCall: false,
        requiresApproval: true
      },
      decision: "needs_user_approval"
    });
    expect(result.data.recommendations as string[]).toEqual(
      expect.arrayContaining([
        "Pause the client request, show the approval inbox, and retry with the issued approval token.",
        "This route is not gateway-enforced; the participating VS Code extension must fail closed locally."
      ])
    );
    daemon.close();
  });

  it("approves a pending preflight and accepts the one-call approval token on the next matching preflight", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "worker", litellmRouteable: true }));
    const payload = preflightPayload({ candidateModel: "worker.deepseek.max", requestedProvider: "deepseek", requestedReasoning: "max" });

    const requested = daemon.callTool("llm_preflight", payload, contextFor(session, "pf-approve-request"));
    expect(requested.ok).toBe(true);
    if (!requested.ok) throw new Error("preflight failed");
    const approval = daemon.callTool(
      "llm_approve",
      { requestId: requested.data.requestId, decision: "allow", scope: "call", expiresInSeconds: 60 },
      contextFor(session, "approve-call")
    );
    expect(approval.ok).toBe(true);
    if (!approval.ok) throw new Error("approval failed");
    expect(approval.data).toMatchObject({ requestId: requested.data.requestId, status: "approved", decision: "allow", scope: "call" });
    expect(typeof approval.data.approvalToken).toBe("string");

    const allowed = daemon.callTool(
      "llm_preflight",
      preflightPayload({
        candidateModel: "worker.deepseek.max",
        requestedProvider: "deepseek",
        requestedReasoning: "max",
        approvalToken: approval.data.approvalToken
      }),
      contextFor(session, "pf-approved-token")
    );
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) throw new Error("approved preflight failed");
    expect(allowed.data.decision).toBe("allow");
    expect(allowed.data.approval).toMatchObject({ accepted: true, requestId: requested.data.requestId, usesRemaining: 0 });

    const reused = daemon.callTool(
      "llm_preflight",
      preflightPayload({
        candidateModel: "worker.deepseek.max",
        requestedProvider: "deepseek",
        requestedReasoning: "max",
        approvalToken: approval.data.approvalToken
      }),
      contextFor(session, "pf-token-reuse")
    );
    expect(reused.ok).toBe(true);
    if (!reused.ok) throw new Error("reused preflight failed");
    expect(reused.data.decision).toBe("needs_user_approval");
    expect(reused.data.warnings as string[]).toContain("Approval token was not accepted: token already used.");
    daemon.close();
  });

  it("queue-scoped approval accepts multiple matching DeepSeek preflights for the same project queue", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "worker", litellmRouteable: true }));
    const budgetScope = "project_queue:pqueue_123";

    const requested = daemon.callTool(
      "llm_preflight",
      preflightPayload({
        candidateModel: "worker.deepseek.max",
        requestedProvider: "deepseek",
        requestedReasoning: "max",
        budgetScope,
        boundResourceId: "pqtask_1"
      }),
      contextFor(session, "pf-queue-approval-request")
    );
    expect(requested.ok).toBe(true);
    if (!requested.ok) throw new Error("preflight failed");
    const approval = daemon.callTool(
      "llm_approve",
      { requestId: requested.data.requestId, decision: "allow", scope: "queue" },
      contextFor(session, "approve-queue")
    );
    expect(approval.ok).toBe(true);
    if (!approval.ok) throw new Error("queue approval failed");
    expect(approval.data).toMatchObject({ scope: "queue", boundResourceId: budgetScope });

    for (const taskId of ["pqtask_2", "pqtask_3"]) {
      const allowed = daemon.callTool(
        "llm_preflight",
        preflightPayload({
          candidateModel: "worker.deepseek.max",
          requestedProvider: "deepseek",
          requestedReasoning: "max",
          budgetScope,
          boundResourceId: taskId,
          approvalToken: approval.data.approvalToken
        }),
        contextFor(session, `pf-approved-${taskId}`)
      );
      expect(allowed.ok).toBe(true);
      if (!allowed.ok) throw new Error("approved preflight failed");
      expect(allowed.data.decision).toBe("allow");
      expect(allowed.data.approval).toMatchObject({ accepted: true, scope: "queue" });
    }
    daemon.close();
  });

  it("deduplicates equivalent pending queue approval requests across retries", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "worker", litellmRouteable: true }));
    const budgetScope = "project_queue:pqueue_retry";

    const first = daemon.callTool(
      "llm_preflight",
      preflightPayload({
        candidateModel: "worker.deepseek.max",
        requestedProvider: "deepseek",
        requestedReasoning: "max",
        budgetScope,
        boundResourceId: "pqtask_1"
      }),
      contextFor(session, "pf-retry-1")
    );
    const second = daemon.callTool(
      "llm_preflight",
      preflightPayload({
        candidateModel: "worker.deepseek.max",
        requestedProvider: "deepseek",
        requestedReasoning: "max",
        budgetScope,
        boundResourceId: "pqtask_2"
      }),
      contextFor(session, "pf-retry-2")
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("preflight failed");
    expect(tableCount(daemon, "approval_requests")).toBe(1);
    expect(second.data.approval).toMatchObject({ required: true, reused: true, requestId: first.data.requestId });
    daemon.close();
  });

  it("does not accept expired approval tokens", () => {
    let now = new Date("2026-04-29T10:00:00.000Z");
    const daemon = new FabricDaemon({ dbPath: ":memory:", now: () => now });
    const session = daemon.registerBridge(registerPayload({ agentId: "worker", litellmRouteable: true }));
    const payload = preflightPayload({ candidateModel: "worker.deepseek.max", requestedProvider: "deepseek", requestedReasoning: "max" });

    const requested = daemon.callTool("llm_preflight", payload, contextFor(session, "pf-expiring-token"));
    expect(requested.ok).toBe(true);
    if (!requested.ok) throw new Error("preflight failed");
    const approval = daemon.callTool(
      "llm_approve",
      { requestId: requested.data.requestId, decision: "allow", scope: "call", expiresInSeconds: 1 },
      contextFor(session, "approve-expiring-token")
    );
    expect(approval.ok).toBe(true);
    if (!approval.ok) throw new Error("approval failed");

    now = new Date("2026-04-29T10:00:02.000Z");
    const expired = daemon.callTool(
      "llm_preflight",
      preflightPayload({
        candidateModel: "worker.deepseek.max",
        requestedProvider: "deepseek",
        requestedReasoning: "max",
        approvalToken: approval.data.approvalToken
      }),
      contextFor(session, "pf-expired-token")
    );
    expect(expired.ok).toBe(true);
    if (!expired.ok) throw new Error("expired-token preflight failed");
    expect(expired.data.decision).toBe("needs_user_approval");
    expect(expired.data.warnings as string[]).toContain("Approval token was not accepted: token expired.");
    daemon.close();
  });

  it("rejects approval idempotency keys reused with a different decision", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "worker", litellmRouteable: true }));

    const requested = daemon.callTool(
      "llm_preflight",
      preflightPayload({ candidateModel: "worker.deepseek.max", requestedProvider: "deepseek", requestedReasoning: "max" }),
      contextFor(session, "pf-approval-idem")
    );
    expect(requested.ok).toBe(true);
    if (!requested.ok) throw new Error("preflight failed");
    const approved = daemon.callTool(
      "llm_approve",
      { requestId: requested.data.requestId, decision: "allow" },
      contextFor(session, "approval-idem")
    );
    const conflict = daemon.callTool(
      "llm_approve",
      { requestId: requested.data.requestId, decision: "cancel" },
      contextFor(session, "approval-idem")
    );

    expect(approved.ok).toBe(true);
    expect(conflict.ok).toBe(false);
    if (conflict.ok) throw new Error("approval idempotency conflict unexpectedly succeeded");
    expect(conflict.code).toBe("IDEMPOTENCY_CONFLICT");
    daemon.close();
  });

  it("records route feedback and summarizes outcomes by route", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "worker", litellmRouteable: true }));
    const preflight = daemon.callTool(
      "llm_preflight",
      preflightPayload({ candidateModel: "deepseek-v4-pro", requestedProvider: "deepseek", requestedReasoning: "medium" }),
      contextFor(session, "pf-route-outcome")
    );
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) throw new Error("preflight failed");

    const outcome = daemon.callTool(
      "llm_route_feedback",
      {
        requestId: preflight.data.requestId,
        outcome: "succeeded",
        evidence: { testsPass: true, userAcceptedPatch: true },
        qualityScore: 0.9,
        retryCount: 1,
        latencyMs: 1234,
        costUsd: 0.012345
      },
      contextFor(session, "route-feedback")
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("route feedback failed");
    expect(outcome.data).toMatchObject({ requestId: preflight.data.requestId, outcome: "succeeded" });

    const summary = daemon.callTool("fabric_route_outcomes_summary", { sinceDays: 30 }, contextFor(session));
    expect(summary.ok).toBe(true);
    if (!summary.ok) throw new Error("summary failed");
    expect(summary.data).toMatchObject({
      totalOutcomes: 1,
      byRoute: [
        {
          provider: "deepseek",
          model: "deepseek-v4-pro",
          taskType: "code_edit",
          outcome: "succeeded",
          count: 1,
          avgQualityScore: 0.9,
          avgCostUsd: 0.012345,
          avgLatencyMs: 1234,
          totalRetries: 1
        }
      ]
    });
    daemon.close();
  });

  it("rejects route feedback for missing preflight requests", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "worker", litellmRouteable: true }));

    const outcome = daemon.callTool(
      "llm_route_feedback",
      { requestId: "llmpf_missing", outcome: "failed", evidence: { errorCode: "not_found" } },
      contextFor(session, "route-feedback-missing")
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("missing preflight unexpectedly accepted feedback");
    expect(outcome.code).toBe("PREFLIGHT_REQUEST_NOT_FOUND");
    daemon.close();
  });

  it("resolves deterministic policy aliases with reason codes", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "worker", litellmRouteable: true }));

    const result = daemon.callTool(
      "policy_resolve_alias",
      { alias: "execute.cheap", taskType: "code_edit", contextSize: 10_000, estimatedCostUsd: 0.01, risk: "low" },
      contextFor(session)
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("alias resolution failed");
    expect(result.data).toMatchObject({
      alias: "execute.cheap",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      reasoning: "medium",
      billingMode: "metered",
      taskType: "code_edit",
      reasonCodes: ["alias_match", "source:runtime_seed"],
      warnings: []
    });
    daemon.close();
  });

  it("resolves project queue pipeline aliases", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "worker", litellmRouteable: true }));

    const aliases = ["prompt.improve.strong", "phase.splitter", "task.writer", "tool.context.manager"];
    for (const alias of aliases) {
      const result = daemon.callTool("policy_resolve_alias", { alias, taskType: "project_queue", risk: "medium" }, contextFor(session));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`alias resolution failed for ${alias}`);
      expect(result.data).toMatchObject({ alias, source: "runtime_seed", taskType: "project_queue" });
    }
    daemon.close();
  });

  it("warns when alias constraints are exceeded", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "worker", litellmRouteable: true }));

    const result = daemon.callTool(
      "policy_resolve_alias",
      { alias: "execute.cheap", taskType: "code_edit", contextSize: 10_000, risk: "high" },
      contextFor(session)
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("alias resolution failed");
    expect(result.data.reasonCodes as string[]).toContain("risk_exceeds_alias_ceiling");
    expect(result.data.warnings as string[]).toContain("Risk high exceeds alias risk ceiling medium.");
    daemon.close();
  });

  it("asks for compaction before routing sensitive context", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "worker", litellmRouteable: true }));

    const result = daemon.callTool(
      "llm_preflight",
      preflightPayload({
        candidateModel: "deepseek-v4-pro",
        requestedProvider: "deepseek",
        requestedReasoning: "medium",
        sensitiveFlags: ["api_key", "cookies"]
      }),
      contextFor(session, "pf-sensitive")
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("preflight failed");
    expect(result.data).toMatchObject({ risk: "breakglass", decision: "compact_first" });
    expect(result.data.warnings as string[]).toContain("Sensitive context flagged (api_key, cookies); compact or remove before routing.");
    daemon.close();
  });

  it("marks native non-routeable Codex and Claude sessions as advisory only", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "codex", litellmRouteable: false }));

    const result = daemon.callTool(
      "llm_preflight",
      preflightPayload({ client: "codex", candidateModel: "deepseek-v4-pro", requestedProvider: "deepseek" }),
      contextFor(session, "pf-advisory")
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("preflight failed");
    expect(result.data.advisoryOnly).toBe(true);
    expect((result.data.warnings as string[]).some((warning) => warning.includes("advisory only"))).toBe(true);
    daemon.close();
  });

  it("aggregates preflight estimates in llm_budget_status", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "worker", litellmRouteable: true }));

    daemon.callTool(
      "llm_preflight",
      preflightPayload({ candidateModel: "deepseek-v4-pro", requestedProvider: "deepseek", requestedReasoning: "medium" }),
      contextFor(session, "pf-budget-1")
    );
    daemon.callTool(
      "llm_preflight",
      preflightPayload({ candidateModel: "anthropic/claude-4.7-opus", requestedProvider: "openrouter", taskType: "review" }),
      contextFor(session, "pf-budget-2")
    );

    const status = daemon.callTool("llm_budget_status", { scope: "session" }, contextFor(session));
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error("budget status failed");
    expect(status.data.preflightCount).toBe(2);
    expect(status.data.byProvider).toHaveProperty("deepseek");
    expect(status.data.byProvider).toHaveProperty("openrouter");
    expect(status.data.highRiskCount).toBeGreaterThanOrEqual(1);
    daemon.close();
  });

  it("replays idempotent preflights with the same request id", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "worker", litellmRouteable: true }));
    const payload = preflightPayload({ candidateModel: "deepseek-v4-pro", requestedProvider: "deepseek" });

    const first = daemon.callTool("llm_preflight", payload, contextFor(session, "pf-idem"));
    const replay = daemon.callTool("llm_preflight", payload, contextFor(session, "pf-idem"));

    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    if (!first.ok || !replay.ok) throw new Error("preflight failed");
    expect(replay.data.requestId).toBe(first.data.requestId);
    expect(tableCount(daemon, "llm_preflight_requests")).toBe(1);
    daemon.close();
  });

  it("rejects idempotency keys reused with a different payload", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "worker", litellmRouteable: true }));

    const first = daemon.callTool(
      "llm_preflight",
      preflightPayload({ candidateModel: "deepseek-v4-pro", requestedProvider: "deepseek" }),
      contextFor(session, "pf-idem-conflict")
    );
    const conflict = daemon.callTool(
      "llm_preflight",
      preflightPayload({ candidateModel: "worker.deepseek.max", requestedProvider: "deepseek" }),
      contextFor(session, "pf-idem-conflict")
    );

    expect(first.ok).toBe(true);
    expect(conflict.ok).toBe(false);
    if (conflict.ok) throw new Error("idempotency conflict unexpectedly succeeded");
    expect(conflict.code).toBe("IDEMPOTENCY_CONFLICT");
    daemon.close();
  });
});

function preflightPayload(
  overrides: {
    client?: string;
    candidateModel?: string;
    requestedProvider?: string;
    requestedReasoning?: string;
    taskType?: string;
    sensitiveFlags?: string[];
    approvalToken?: string;
    contextPackage?: Record<string, unknown>;
    budgetScope?: string;
    boundResourceId?: string;
  } = {}
) {
  return {
    task: { type: overrides.taskType ?? "code_edit", goal: "Implement a bounded feature." },
    client: overrides.client ?? "worker",
    workspaceRoot: "/tmp/workspace",
    candidateModel: overrides.candidateModel ?? "deepseek-v4-pro",
    requestedProvider: overrides.requestedProvider,
    requestedReasoning: overrides.requestedReasoning,
    contextPackage: overrides.contextPackage,
    contextPackageSummary: overrides.contextPackage ? undefined : { inputTokens: 1_000 },
    toolSchemas: overrides.contextPackage ? undefined : [{ name: "read" }, { name: "edit" }],
    mcpServers: overrides.contextPackage ? undefined : ["agent-fabric"],
    budgetScope: overrides.budgetScope ?? "session",
    boundResourceId: overrides.boundResourceId,
    sensitiveFlags: overrides.sensitiveFlags,
    approvalToken: overrides.approvalToken
  };
}

function registerPayload(overrides: { agentId?: string; litellmRouteable?: boolean } = {}): BridgeRegister {
  return {
    bridgeVersion: "0.1.0",
    agent: { id: overrides.agentId ?? "worker", displayName: overrides.agentId ?? "Worker", vendor: "test" },
    host: { name: "Cost Policy Test Host", transport: "simulator" },
    workspace: { root: "/tmp/workspace", source: "explicit" },
    capabilities: {
      roots: true,
      notifications: true,
      notificationsVisibleToAgent: { declared: "yes", observed: "yes" },
      sampling: false,
      streamableHttp: false,
      litellmRouteable: overrides.litellmRouteable ?? true,
      outcomeReporting: "explicit"
    },
    notificationSelfTest: { observed: "yes", detail: "test" },
    testMode: true
  };
}

function contextFor(session: { sessionId: string; sessionToken: string }, idempotencyKey?: string) {
  return {
    sessionId: session.sessionId,
    sessionToken: session.sessionToken,
    idempotencyKey
  };
}

function tableCount(daemon: FabricDaemon, table: string): number {
  const row = daemon.db.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}
