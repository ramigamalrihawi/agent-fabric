import { describe, expect, it } from "vitest";
import { FabricDaemon } from "../src/daemon.js";
import type { BridgeRegister } from "../src/types.js";

describe("ADR-0014 plan-chain surface", () => {
  it("records a full A-B-C-A plan chain with durable spend and explainability", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ observed: "yes", agentId: "orchestrator" }));

    const start = daemon.callTool(
      "plan_chain_start",
      {
        task: "Design a cost-aware model router.",
        models: { a: "gpt-5.5", b: "deepseek-chat", c: "openrouter/qwen" },
        budgetUsd: 2,
        outputFormat: "markdown"
      },
      contextFor(session, "plan-start")
    );
    expect(start.ok).toBe(true);
    if (!start.ok) throw new Error("plan start failed");
    const chainId = start.data.chainId as string;

    const first = daemon.callTool(
      "plan_chain_record_revision",
      {
        chainId,
        step: "a_draft",
        body: "Plan A: route every task to the strongest model.",
        confidence: 0.7,
        costUsd: 0.4
      },
      contextFor(session, "plan-a")
    );
    expect(first.ok).toBe(true);
    expect(first.ok ? first.data.state : undefined).toBe("drafting_b");

    const second = daemon.callTool(
      "plan_chain_record_revision",
      {
        chainId,
        step: "b_improve",
        body: "Plan B: add cheap default routing with escalation.",
        changeLog: { kept_from_previous: ["strong-model escape hatch"], added: ["cheap default"] },
        leastConfidentAbout: ["quality guardrails"],
        confidence: 0.8,
        costUsd: 0.2
      },
      contextFor(session, "plan-b")
    );
    expect(second.ok).toBe(true);
    expect(second.ok ? second.data.state : undefined).toBe("drafting_c");

    const third = daemon.callTool(
      "plan_chain_record_revision",
      {
        chainId,
        step: "c_improve",
        body: "Plan C: route cheap first, escalate on risk, and keep human approvals for expensive contexts.",
        changeLog: { changed: [{ what: "approval gate", because: "prevents runaway context spend" }] },
        confidence: 0.86,
        costUsd: 0.25
      },
      contextFor(session, "plan-c")
    );
    expect(third.ok).toBe(true);
    expect(third.ok ? third.data.state : undefined).toBe("critiquing_a");

    const critique = daemon.callTool(
      "plan_chain_record_critique",
      {
        chainId,
        body: "Plan C improves cost control while preserving quality gates.",
        structured: {
          chainImprovedMyOriginal: "yes",
          lostFromV1: [],
          valuablyAdded: ["cheap default", "human expensive-context gate"],
          wouldSignOff: true,
          wouldSignOffReason: "It preserves the strong-model path while cutting routine spend.",
          confidence: 0.9
        },
        costUsd: 0.35
      },
      contextFor(session, "plan-critique")
    );
    expect(critique.ok).toBe(true);
    expect(critique.ok ? critique.data.haltReason : undefined).toBe("a_signoff");

    const status = daemon.callTool("plan_chain_status", { chainId }, contextFor(session));
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error("plan status failed");
    expect(status.data.state).toBe("awaiting_user");
    expect(status.data.haltReason).toBe("a_signoff");
    expect(status.data.totalSpentUsd).toBeCloseTo(1.2);
    expect(status.data.drafts as unknown[]).toHaveLength(3);
    expect(status.data.critiques as unknown[]).toHaveLength(1);

    const explain = daemon.callTool("plan_chain_explain", { chainId }, contextFor(session));
    expect(explain.ok).toBe(true);
    if (!explain.ok) throw new Error("plan explain failed");
    expect((explain.data.sourceIds as string[]).length).toBeGreaterThanOrEqual(5);
    expect((explain.data.events as Array<{ eventType: string }>).map((event) => event.eventType)).toContain("plan.chain.critique_recorded");
    daemon.close();
  });

  it("turns blocking model questions into collab asks and resumes after answer", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const orchestrator = daemon.registerBridge(registerPayload({ observed: "yes", agentId: "orchestrator" }));
    const user = daemon.registerBridge(registerPayload({ observed: "yes", agentId: "codex" }));
    const start = daemon.callTool("plan_chain_start", { task: "Pick a deployment strategy." }, contextFor(orchestrator, "question-start"));
    expect(start.ok).toBe(true);
    if (!start.ok) throw new Error("plan start failed");
    const chainId = start.data.chainId as string;

    const revision = daemon.callTool(
      "plan_chain_record_revision",
      {
        chainId,
        step: "a_draft",
        body: "Plan A: deploy immediately.",
        questionsForUser: [{ severity: "blocking", body: "Can production tolerate downtime?" }],
        questionRecipient: "codex"
      },
      contextFor(orchestrator, "question-revision")
    );
    expect(revision.ok).toBe(true);
    expect(revision.ok ? revision.data.state : undefined).toBe("awaiting_user");

    const status = daemon.callTool("plan_chain_status", { chainId }, contextFor(orchestrator));
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error("plan status failed");
    const [question] = status.data.pendingQuestions as Array<{ questionId: string; collabAskId?: string }>;
    expect(question.collabAskId).toMatch(/^ask_/);

    const inbox = daemon.callTool("collab_inbox", {}, contextFor(user));
    expect(inbox.ok).toBe(true);
    if (!inbox.ok) throw new Error("inbox failed");
    expect((inbox.data.openAsks as Array<{ askId: string; question: string }>)[0]).toMatchObject({
      askId: question.collabAskId,
      question: "Can production tolerate downtime?"
    });

    const answer = daemon.callTool(
      "plan_chain_answer_question",
      { questionId: question.questionId, answer: "No. Use blue-green or maintenance windows." },
      contextFor(user, "question-answer")
    );
    expect(answer.ok).toBe(true);
    expect(answer.ok ? answer.data.state : undefined).toBe("drafting_b");

    const ask = daemon.db.db.prepare("SELECT status FROM asks WHERE id = ?").get(question.collabAskId) as { status: string };
    const task = daemon.db.db
      .prepare("SELECT status FROM tasks WHERE id = (SELECT task_id FROM asks WHERE id = ?)")
      .get(question.collabAskId) as { status: string };
    expect(ask.status).toBe("answered");
    expect(task.status).toBe("completed");
    daemon.close();
  });

  it("accepting a plan writes pending procedural memory and keeps the chain trace", () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const daemon = new FabricDaemon({ dbPath: ":memory:", now: () => now });
    const session = daemon.registerBridge(registerPayload({ observed: "yes", agentId: "orchestrator" }));
    const start = daemon.callTool("plan_chain_start", { task: "Create a testing policy." }, contextFor(session, "accept-start"));
    expect(start.ok).toBe(true);
    if (!start.ok) throw new Error("plan start failed");
    const chainId = start.data.chainId as string;

    const draft = daemon.callTool(
      "plan_chain_record_revision",
      {
        chainId,
        step: "a_draft",
        body: "Initial policy: require tests for every change.",
        costUsd: 0.02
      },
      contextFor(session, "accept-draft")
    );
    expect(draft.ok).toBe(true);
    const improve = daemon.callTool(
      "plan_chain_record_revision",
      {
        chainId,
        step: "b_improve",
        body: "Improved policy: target deterministic logic and storage contracts first.",
        costUsd: 0.03
      },
      contextFor(session, "accept-improve")
    );
    expect(improve.ok).toBe(true);
    const revision = daemon.callTool(
      "plan_chain_record_revision",
      {
        chainId,
        step: "c_improve",
        body: "Final policy: require unit tests for deterministic logic and invariant tests for daemon storage contracts.",
        costUsd: 0.1
      },
      contextFor(session, "accept-revision")
    );
    expect(revision.ok).toBe(true);

    const decision = daemon.callTool("plan_chain_decide", { chainId, decision: "accept" }, contextFor(session, "accept-decision"));
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error("plan decision failed");
    expect(decision.data.memoryWritten).toMatchObject({ status: "pending_review" });

    const memoryId = decision.data.finalPlanRef as string;
    const memory = daemon.db.db.prepare("SELECT * FROM memories WHERE id = ?").get(memoryId) as {
      type: string;
      status: string;
      source: string;
      body: string;
      refs_json: string;
      recorded_at: string;
    };
    expect(memory).toMatchObject({
      type: "procedural",
      status: "pending_review",
      source: "user-confirmed-plan",
      body: "Final policy: require unit tests for deterministic logic and invariant tests for daemon storage contracts.",
      recorded_at: "2026-04-28T12:00:00.000Z"
    });
    expect(JSON.parse(memory.refs_json)).toEqual([`plan_chain:${chainId}`]);

    const status = daemon.callTool("plan_chain_status", { chainId }, contextFor(session));
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error("plan status failed");
    expect(status.data.state).toBe("accepted");
    expect(status.data.finalMemoryId).toBe(memoryId);
    daemon.close();
  });

  it("enforces hard halt rules for budget and convergence", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ observed: "yes", agentId: "orchestrator" }));

    const budgetStart = daemon.callTool("plan_chain_start", { task: "Spend carefully.", budgetUsd: 0.5 }, contextFor(session, "budget-start"));
    expect(budgetStart.ok).toBe(true);
    if (!budgetStart.ok) throw new Error("budget start failed");
    const budgetChainId = budgetStart.data.chainId as string;
    const overBudget = daemon.callTool(
      "plan_chain_record_revision",
      { chainId: budgetChainId, step: "a_draft", body: "Expensive draft.", costUsd: 0.6 },
      contextFor(session, "budget-draft")
    );
    expect(overBudget.ok).toBe(true);
    expect(overBudget.ok ? overBudget.data.haltReason : undefined).toBe("budget");
    const budgetNext = daemon.callTool("plan_chain_decide", { chainId: budgetChainId, decision: "another_round" }, contextFor(session, "budget-next"));
    expect(budgetNext.ok).toBe(false);
    expect(budgetNext.ok ? undefined : budgetNext.code).toBe("PLAN_CHAIN_HALTED");

    const convergedStart = daemon.callTool("plan_chain_start", { task: "Detect convergence.", maxRounds: 2 }, contextFor(session, "conv-start"));
    expect(convergedStart.ok).toBe(true);
    if (!convergedStart.ok) throw new Error("converged start failed");
    const convergedChainId = convergedStart.data.chainId as string;
    recordRound(daemon, session, convergedChainId, 1, "Stable final plan with one small detail.", "conv-r1");
    const another = daemon.callTool("plan_chain_decide", { chainId: convergedChainId, decision: "another_round" }, contextFor(session, "conv-next"));
    expect(another.ok).toBe(true);
    recordRevision(daemon, session, convergedChainId, "b_improve", "Stable final plan with one small detail.", "conv-r2-b");
    const roundTwoC = daemon.callTool(
      "plan_chain_record_revision",
      { chainId: convergedChainId, step: "c_improve", body: "Stable final plan with one small detail!", costUsd: 0.01 },
      contextFor(session, "conv-r2-c")
    );
    expect(roundTwoC.ok).toBe(true);
    expect(roundTwoC.ok ? roundTwoC.data.haltReason : undefined).toBe("converged");
    const afterConverged = daemon.callTool(
      "plan_chain_decide",
      { chainId: convergedChainId, decision: "another_round" },
      contextFor(session, "conv-after")
    );
    expect(afterConverged.ok).toBe(false);
    expect(afterConverged.ok ? undefined : afterConverged.code).toBe("PLAN_CHAIN_HALTED");
    daemon.close();
  });
});

function registerPayload(
  overrides: { observed?: "yes" | "no" | "unknown"; agentId?: string } = {}
): BridgeRegister {
  return {
    bridgeVersion: "0.1.0",
    agent: { id: overrides.agentId ?? "codex", displayName: overrides.agentId ?? "Codex", vendor: "openai" },
    host: { name: "Codex Test Host", version: "1.0.0", transport: "simulator" },
    workspace: { root: "/tmp/workspace", source: "explicit" },
    capabilities: {
      roots: true,
      notifications: true,
      notificationsVisibleToAgent: { declared: "yes", observed: "unknown" },
      sampling: false,
      streamableHttp: false,
      litellmRouteable: true,
      outcomeReporting: "explicit"
    },
    notificationSelfTest: { observed: overrides.observed ?? "unknown", detail: "test" },
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

function recordRound(
  daemon: FabricDaemon,
  session: { sessionId: string; sessionToken: string },
  chainId: string,
  round: number,
  finalBody: string,
  keyPrefix: string
): void {
  if (round === 1) {
    recordRevision(daemon, session, chainId, "a_draft", `A draft before ${finalBody}`, `${keyPrefix}-a`);
  }
  recordRevision(daemon, session, chainId, "b_improve", `B improves toward ${finalBody}`, `${keyPrefix}-b`);
  recordRevision(daemon, session, chainId, "c_improve", finalBody, `${keyPrefix}-c`);
  const critique = daemon.callTool(
    "plan_chain_record_critique",
    {
      chainId,
      body: "More work could still help.",
      structured: {
        chainImprovedMyOriginal: "mixed",
        lostFromV1: [],
        valuablyAdded: [],
        wouldSignOff: false,
        wouldSignOffReason: "Not final yet.",
        confidence: 0.6
      }
    },
    contextFor(session, `${keyPrefix}-critique`)
  );
  expect(critique.ok).toBe(true);
}

function recordRevision(
  daemon: FabricDaemon,
  session: { sessionId: string; sessionToken: string },
  chainId: string,
  step: "a_draft" | "b_improve" | "c_improve",
  body: string,
  idempotencyKey: string
): void {
  const result = daemon.callTool("plan_chain_record_revision", { chainId, step, body, costUsd: 0.01 }, contextFor(session, idempotencyKey));
  expect(result.ok).toBe(true);
}
