import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FabricDaemon } from "../src/daemon.js";
import { redact } from "../src/runtime/input.js";
import type { BridgeRegister, BridgeSession, ResultEnvelope } from "../src/types.js";

describe("phase 1 correctness regressions", () => {
  it("preserves runtime-customized route seed rows across daemon restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-phase1-"));
    const dbPath = join(dir, "fabric.db");
    let daemon = new FabricDaemon({ dbPath });
    try {
      const session = daemon.registerBridge(registerPayload());
      expectOk(daemon.callTool("policy_resolve_alias", { alias: "execute.cheap" }, contextFor(session, "seed-cost-policy")));
      daemon.db.db
        .prepare(
          `UPDATE route_cheapness
           SET source = 'runtime_override',
               confidence = 0.11,
               input_price_per_mtok_micros = 123456
           WHERE provider = 'deepseek' AND model = 'deepseek-v4-pro'`
        )
        .run();
      daemon.close();

      daemon = new FabricDaemon({ dbPath });
      const reopenedSession = daemon.registerBridge(registerPayload({ agentId: "worker-reopened" }));
      expectOk(daemon.callTool("policy_resolve_alias", { alias: "execute.cheap" }, contextFor(reopenedSession, "reseed-cost-policy")));
      const row = daemon.db.db
        .prepare("SELECT source, confidence, input_price_per_mtok_micros FROM route_cheapness WHERE provider = ? AND model = ?")
        .get("deepseek", "deepseek-v4-pro") as Record<string, unknown>;

      expect(row.source).toBe("runtime_override");
      expect(Number(row.confidence)).toBeCloseTo(0.11);
      expect(row.input_price_per_mtok_micros).toBe(123456);
    } finally {
      daemon.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects approval tokens when bound resource does not match the retry request", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    try {
      const session = daemon.registerBridge(registerPayload());
      const firstPreflight = expectOk<Record<string, unknown>>(
        daemon.callTool(
          "llm_preflight",
          preflightPayload({ budgetScope: "project-task-a" }),
          contextFor(session, "approval-resource-a")
        )
      );
      expect(firstPreflight.decision).toBe("needs_user_approval");

      const approval = expectOk<Record<string, unknown>>(
        daemon.callTool(
          "llm_approve",
          {
            requestId: firstPreflight.requestId,
            decision: "allow",
            scope: "chain",
            boundResourceId: "project-task-a"
          },
          contextFor(session, "approve-resource-a")
        )
      );
      expect(typeof approval.approvalToken).toBe("string");

      const retriedPreflight = expectOk<Record<string, unknown>>(
        daemon.callTool(
          "llm_preflight",
          preflightPayload({ budgetScope: "project-task-b", approvalToken: String(approval.approvalToken) }),
          contextFor(session, "approval-resource-b")
        )
      );

      expect(retriedPreflight.decision).toBe("needs_user_approval");
      expect(retriedPreflight.approval).toMatchObject({ required: true });
    } finally {
      daemon.close();
    }
  });

  it("rejects ask replies from sessions that are not the ask recipient", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    try {
      const asker = daemon.registerBridge(registerPayload({ agentId: "planner" }));
      const recipient = daemon.registerBridge(registerPayload({ agentId: "reviewer" }));
      const outsider = daemon.registerBridge(registerPayload({ agentId: "outsider" }));
      expect(recipient.sessionId).toMatch(/^sess_/);

      const ask = expectOk<Record<string, unknown>>(
        daemon.callTool(
          "collab_ask",
          { to: "reviewer", kind: "review", question: "Please review this plan.", refs: ["PLAN.md"] },
          contextFor(asker, "ask-recipient-check")
        )
      );

      const reply = daemon.callTool(
        "collab_reply",
        { askId: ask.askId, status: "answered", message: "Answer from the wrong session." },
        contextFor(outsider, "reply-from-outsider")
      );

      expect(reply.ok).toBe(false);
      if (!reply.ok) {
        expect(reply.code).toBe("ASK_FORBIDDEN");
      }
    } finally {
      daemon.close();
    }
  });

  it("rejects path claim releases from non-owning sessions", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    try {
      const owner = daemon.registerBridge(registerPayload({ agentId: "owner" }));
      const outsider = daemon.registerBridge(registerPayload({ agentId: "outsider" }));
      const claim = expectOk<Record<string, unknown>>(
        daemon.callTool("claim_path", { paths: ["src/surfaces/collab.ts"], ttl: 600 }, contextFor(owner, "claim-owner"))
      );

      const release = daemon.callTool("release_path", { claimId: claim.claimId }, contextFor(outsider, "release-outsider"));

      expect(release.ok).toBe(false);
      if (!release.ok) {
        expect(release.code).toBe("CLAIM_FORBIDDEN");
      }
    } finally {
      daemon.close();
    }
  });

  it("deep-redacts nested secrets before storing cost metadata", () => {
    const payload = {
      request_id: "req-secret-redaction",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      cost_usd: 0.25,
      metadata: {
        apiKey: "nested-api-key",
        auth: { password: "nested-password" },
        events: [{ token: "nested-token" }]
      }
    };

    const redacted = redact(payload);
    expect(JSON.stringify(redacted)).not.toContain("nested-api-key");
    expect(JSON.stringify(redacted)).not.toContain("nested-password");
    expect(JSON.stringify(redacted)).not.toContain("nested-token");

    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    try {
      daemon.ingestLiteLlmSpendLogs([payload]);
      const row = daemon.db.db.prepare("SELECT raw_meta FROM cost_events WHERE request_id = ?").get("req-secret-redaction") as
        | { raw_meta: string }
        | undefined;
      expect(row?.raw_meta).toBeDefined();
      expect(row?.raw_meta).not.toContain("nested-api-key");
      expect(row?.raw_meta).not.toContain("nested-password");
      expect(row?.raw_meta).not.toContain("nested-token");
    } finally {
      daemon.close();
    }
  });
});

function registerPayload(overrides: { agentId?: string; root?: string; litellmRouteable?: boolean } = {}): BridgeRegister {
  return {
    bridgeVersion: "0.1.0",
    agent: { id: overrides.agentId ?? "worker", displayName: overrides.agentId ?? "Worker", vendor: "test" },
    host: { name: "Phase 1 Correctness Test Host", transport: "simulator" },
    workspace: { root: overrides.root ?? "/tmp/workspace", source: "explicit" },
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

function contextFor(session: Pick<BridgeSession, "sessionId" | "sessionToken">, idempotencyKey?: string) {
  return {
    sessionId: session.sessionId,
    sessionToken: session.sessionToken,
    idempotencyKey
  };
}

function preflightPayload(
  overrides: { budgetScope?: string; approvalToken?: string; candidateModel?: string; requestedProvider?: string; requestedReasoning?: string } = {}
) {
  return {
    task: { type: "code_edit", goal: "Implement a bounded feature." },
    client: "worker",
    workspaceRoot: "/tmp/workspace",
    candidateModel: overrides.candidateModel ?? "worker.deepseek.max",
    requestedProvider: overrides.requestedProvider ?? "deepseek",
    requestedReasoning: overrides.requestedReasoning ?? "max",
    contextPackageSummary: { inputTokens: 1_000 },
    toolSchemas: [{ name: "read" }, { name: "edit" }],
    mcpServers: ["agent-fabric"],
    budgetScope: overrides.budgetScope ?? "session",
    approvalToken: overrides.approvalToken
  };
}

function expectOk<T>(result: ResultEnvelope<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.data;
}
