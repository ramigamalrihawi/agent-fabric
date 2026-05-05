import { describe, expect, it } from "vitest";
import { FabricDaemon } from "../src/daemon.js";
import type { BridgeRegister } from "../src/types.js";

describe("Lane C sustained collab integration", () => {
  it("runs the 12-step ask/reply/claim/decision loop across two bridges", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const bridgeA = daemon.registerBridge(registerPayload("codex-a"));
    const bridgeB = daemon.registerBridge(registerPayload("claude-b"));

    const ask = daemon.callTool(
      "collab_ask",
      { to: "claude-b", kind: "review", question: "Review the cost substrate", refs: ["src/surfaces/costs.ts"] },
      contextFor(bridgeA, "step-2-ask")
    );
    expect(ask.ok).toBe(true);
    if (!ask.ok) throw new Error("ask failed");

    const inboxB = daemon.callTool("collab_inbox", {}, contextFor(bridgeB));
    expect(inboxB.ok).toBe(true);
    if (!inboxB.ok) throw new Error("inbox B failed");
    const openAsk = (inboxB.data.openAsks as Array<{ askId: string; question: string }>)[0];
    expect(openAsk.question).toBe("Review the cost substrate");

    const reply = daemon.callTool(
      "collab_reply",
      { askId: openAsk.askId, status: "answered", message: "Looks coherent; fix idle-audit tests." },
      contextFor(bridgeB, "step-4-reply")
    );
    expect(reply.ok).toBe(true);

    const inboxA = daemon.callTool("collab_inbox", {}, contextFor(bridgeA));
    expect(inboxA.ok).toBe(true);
    if (!inboxA.ok) throw new Error("inbox A failed");
    expect((inboxA.data.messages as Array<{ body: string }>).map((message) => message.body)).toContain(
      "Looks coherent; fix idle-audit tests."
    );

    const claimA = daemon.callTool("claim_path", { paths: ["src/foo.ts"] }, contextFor(bridgeA, "step-6-claim-a"));
    expect(claimA.ok).toBe(true);
    if (!claimA.ok) throw new Error("claim A failed");
    expect(claimA.data).toHaveProperty("claimId");

    const conflictB = daemon.callTool("claim_path", { paths: ["src/foo.ts"] }, contextFor(bridgeB, "step-7-conflict-b"));
    expect(conflictB.ok).toBe(true);
    if (!conflictB.ok) throw new Error("conflict B failed");
    expect(conflictB.data).not.toHaveProperty("claimId");
    expect(conflictB.data.conflicts as unknown[]).toHaveLength(1);

    const handoffB = daemon.callTool(
      "claim_path",
      { paths: ["src/foo.ts"], mode: "handoff", note: "requesting handoff after review" },
      contextFor(bridgeB, "step-8-handoff-b")
    );
    expect(handoffB.ok).toBe(true);
    if (!handoffB.ok) throw new Error("handoff B failed");
    expect(handoffB.data).toHaveProperty("claimId");

    const releaseA = daemon.callTool("release_path", { claimId: claimA.data.claimId }, contextFor(bridgeA, "step-9-release-a"));
    expect(releaseA.ok).toBe(true);

    const reclaimB = daemon.callTool("claim_path", { paths: ["src/foo.ts"] }, contextFor(bridgeB, "step-10-reclaim-b"));
    expect(reclaimB.ok).toBe(true);
    if (!reclaimB.ok) throw new Error("reclaim B failed");
    expect(reclaimB.data).toHaveProperty("claimId");

    const decision = daemon.callTool(
      "collab_decision",
      {
        title: "Cost substrate lane",
        decided: "Ship async-only collab with cached provider cost audit",
        participants: ["codex-a", "claude-b"],
        rationale: "Real live push is Phase 2; cost visibility is the MVP pillar."
      },
      contextFor(bridgeA, "step-11-decision")
    );
    expect(decision.ok).toBe(true);

    const statusA = daemon.callTool("collab_status", {}, contextFor(bridgeA));
    const statusB = daemon.callTool("collab_status", {}, contextFor(bridgeB));
    expect(statusA.ok).toBe(true);
    expect(statusB.ok).toBe(true);
    if (!statusA.ok || !statusB.ok) throw new Error("status failed");
    expect(statusA.data.myOpenAsks as unknown[]).toHaveLength(0);
    expect((statusA.data.activeClaimsByOthers as Array<{ agentId: string }>).some((claim) => claim.agentId === "claude-b")).toBe(true);
    expect((statusB.data.myClaims as Array<{ agentId: string }>).every((claim) => claim.agentId === "claude-b")).toBe(true);
    expect(tableCount(daemon, "decisions")).toBe(1);
    daemon.close();
  });
});

function registerPayload(agentId: string): BridgeRegister {
  return {
    bridgeVersion: "0.1.0",
    agent: { id: agentId, displayName: agentId, vendor: agentId.startsWith("codex") ? "openai" : "anthropic" },
    host: { name: "Integration Test Host", transport: "simulator" },
    workspace: { root: "/tmp/workspace", source: "explicit" },
    capabilities: {
      roots: true,
      notifications: true,
      notificationsVisibleToAgent: { declared: "yes", observed: "yes" },
      sampling: false,
      streamableHttp: false,
      litellmRouteable: false,
      outcomeReporting: "explicit"
    },
    notificationSelfTest: { observed: "yes", detail: "simulated" },
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
