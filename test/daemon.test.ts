import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FabricDaemon, FabricError } from "../src/daemon.js";
import { SCHEMA_VERSION } from "../src/db.js";
import type { BridgeRegister } from "../src/types.js";

describe("FabricDaemon Phase 0A.1", () => {
  it("creates the v1 schema", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    expect(daemon.db.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(tableCount(daemon, "bridge_sessions")).toBe(0);
    daemon.close();
  });

  it("registers a bridge, writes audit and outbox rows, and reports status", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:", originPeerId: "peer_test" });
    const session = daemon.registerBridge(registerPayload());

    expect(session.sessionId).toMatch(/^sess_/);
    expect(session.sessionToken.length).toBeGreaterThan(20);
    expect(tableCount(daemon, "bridge_sessions")).toBe(1);
    expect(tableCount(daemon, "audit")).toBe(1);
    expect(tableCount(daemon, "events")).toBe(1);

    const status = daemon.fabricStatus();
    expect(status.bridgeSessions.active).toBe(1);
    expect(status.bridgeSessions.sessions[0].notificationsVisibleToAgent).toEqual({
      declared: "yes",
      observed: "unknown"
    });
    expect(status.coverage.litellmCoveragePct).toBe(0);
    expect(status.storage.outboxEventsLast24h).toBe(1);
    daemon.close();
  });

  it("surfaces doctor diagnostics for unobserved notifications and missing billing", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    daemon.registerBridge(registerPayload());
    const doctor = daemon.fabricDoctor();

    expect(doctor.diagnostics.map((diag) => diag.id)).toContain("billing-missing");
    expect(doctor.diagnostics.some((diag) => diag.id.startsWith("notifications-"))).toBe(true);
    daemon.close();
  });

  it("requires session tokens and expires bridge sessions", () => {
    let now = new Date("2026-04-26T10:00:00.000Z");
    const daemon = new FabricDaemon({ dbPath: ":memory:", now: () => now });
    const session = daemon.registerBridge(registerPayload({ observed: "yes" }));

    const missingToken = daemon.callTool("fabric_status", {}, { sessionId: session.sessionId });
    expect(missingToken.ok).toBe(false);
    if (missingToken.ok) throw new Error("missing token unexpectedly accepted");
    expect(missingToken.code).toBe("SESSION_UNAUTHORIZED");

    now = new Date("2026-04-27T00:00:01.000Z");
    const expired = daemon.callTool("fabric_status", {}, contextFor(session));
    expect(expired.ok).toBe(false);
    if (expired.ok) throw new Error("expired token unexpectedly accepted");
    expect(expired.code).toBe("SESSION_EXPIRED");
    daemon.close();
  });

  it("replays matching idempotent mutations and rejects conflicting payloads", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ observed: "yes" }));
    const context = {
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      idempotencyKey: "idem-1"
    };

    const first = daemon.recordMutation("test_mutation", { value: 1 }, context, () => ({ ok: true, value: 1 }));
    const replay = daemon.recordMutation("test_mutation", { value: 1 }, context, () => ({ ok: false }));
    expect(replay).toEqual(first);

    expect(() =>
      daemon.recordMutation("test_mutation", { value: 2 }, context, () => ({ ok: false }))
    ).toThrow(FabricError);
    daemon.close();
  });

  it("persists to a file-backed database", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-test-"));
    const dbPath = join(dir, "db.sqlite");
    const daemon = new FabricDaemon({ dbPath });
    daemon.registerBridge(registerPayload({ observed: "yes" }));
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    daemon.close();

    const reopened = new FabricDaemon({ dbPath });
    expect(tableCount(reopened, "bridge_sessions")).toBe(1);
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores collab messages durably and replays idempotent sends", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const sender = daemon.registerBridge(registerPayload({ observed: "yes", agentId: "codex" }));
    const recipient = daemon.registerBridge(registerPayload({ observed: "yes", agentId: "claude" }));
    const senderContext = contextFor(sender, "send-1");

    const first = daemon.callTool("collab_send", { to: "claude", body: "handoff", refs: ["README.md"] }, senderContext);
    const replay = daemon.callTool("collab_send", { to: "claude", body: "handoff", refs: ["README.md"] }, senderContext);
    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    if (!first.ok || !replay.ok) throw new Error("send failed");
    expect(replay.data).toEqual(first.data);

    const inbox = daemon.callTool("collab_inbox", {}, contextFor(recipient));
    expect(inbox.ok).toBe(true);
    if (!inbox.ok) throw new Error("inbox failed");
    expect((inbox.data.messages as Array<{ body: string }>)[0].body).toBe("handoff");
    expect(tableCount(daemon, "messages")).toBe(1);
    expect(tableCount(daemon, "events")).toBe(3);
    daemon.close();
  });

  it("advances inbox cursors and reports unread messages", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const sender = daemon.registerBridge(registerPayload({ observed: "yes", agentId: "codex" }));
    const recipient = daemon.registerBridge(registerPayload({ observed: "yes", agentId: "claude" }));

    daemon.callTool("collab_send", { to: "claude", body: "first" }, contextFor(sender, "cursor-send-1"));
    const firstInbox = daemon.callTool("collab_inbox", {}, contextFor(recipient));
    expect(firstInbox.ok).toBe(true);
    if (!firstInbox.ok) throw new Error("first inbox failed");
    expect((firstInbox.data.messages as Array<{ body: string }>).map((message) => message.body)).toEqual(["first"]);

    daemon.callTool("collab_send", { to: "claude", body: "second" }, contextFor(sender, "cursor-send-2"));
    const status = daemon.callTool("collab_status", {}, contextFor(recipient));
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error("status failed");
    expect((status.data.channelCursor as { unreadCount: number }).unreadCount).toBe(1);

    const secondInbox = daemon.callTool("collab_inbox", {}, contextFor(recipient));
    expect(secondInbox.ok).toBe(true);
    if (!secondInbox.ok) throw new Error("second inbox failed");
    expect((secondInbox.data.messages as Array<{ body: string }>).map((message) => message.body)).toEqual(["second"]);
    daemon.close();
  });

  it("records heartbeat presence and session heartbeat time", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ observed: "yes", agentId: "codex" }));

    const heartbeat = daemon.callTool("collab_heartbeat", { task: "implement daemon", eta: "PT20M" }, contextFor(session));
    expect(heartbeat.ok).toBe(true);
    const status = daemon.callTool("collab_status", {}, contextFor(session));
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error("status failed");
    expect((status.data.presence as Array<{ agent: string; currentTask?: string }>)[0]).toMatchObject({
      agent: "codex",
      currentTask: "implement daemon"
    });
    expect(daemon.fabricStatus().bridgeSessions.sessions[0].lastHeartbeatAt).toBeTruthy();
    daemon.close();
  });

  it("exports a generated markdown collab view for file-backed databases", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-view-"));
    const dbPath = join(dir, "db.sqlite");
    const daemon = new FabricDaemon({ dbPath });
    const session = daemon.registerBridge(registerPayload({ observed: "yes", agentId: "codex" }));

    const result = daemon.callTool("collab_send", { to: "*", body: "visible in generated view" }, contextFor(session, "view-1"));
    expect(result.ok).toBe(true);
    const viewPath = join(dir, "views", "channel.md");
    expect(existsSync(viewPath)).toBe(true);
    expect(readFileSync(viewPath, "utf8")).toContain("visible in generated view");

    daemon.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("prevents normal overlapping path claims", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const firstSession = daemon.registerBridge(registerPayload({ observed: "yes", agentId: "codex" }));
    const secondSession = daemon.registerBridge(registerPayload({ observed: "yes", agentId: "claude" }));

    const first = daemon.callTool("claim_path", { paths: ["src"], ttl: 600 }, contextFor(firstSession, "claim-1"));
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("first claim failed");
    expect(first.data).toHaveProperty("claimId");

    const second = daemon.callTool("claim_path", { paths: ["src/daemon.ts"], ttl: 600 }, contextFor(secondSession, "claim-2"));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("second claim failed");
    expect(second.data).not.toHaveProperty("claimId");
    expect(second.data.conflicts as unknown[]).toHaveLength(1);
    expect(tableCount(daemon, "claims")).toBe(1);
    daemon.close();
  });

  it("quarantines auto memory and only injects active memories", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ observed: "yes", agentId: "codex" }));

    const auto = daemon.callTool(
      "memory_write",
      { type: "anti_pattern", body: "Do not trust scraped pricing tables.", intent_keys: ["pricing"], source: "auto" },
      contextFor(session, "mem-auto")
    );
    const user = daemon.callTool(
      "memory_write",
      { type: "preference", body: "Prefer explicit ledgers over blended cost totals.", intent_keys: ["pricing"], source: "user" },
      contextFor(session, "mem-user")
    );
    expect(auto.ok).toBe(true);
    expect(user.ok).toBe(true);
    if (!auto.ok || !user.ok) throw new Error("memory write failed");
    expect(auto.data.status).toBe("pending_review");
    expect(auto.data.injectable).toBe(false);
    expect(user.data.status).toBe("active");
    expect(user.data.injectable).toBe(true);

    const check = daemon.callTool("memory_check", { intent: { task: "pricing report" } }, contextFor(session));
    expect(check.ok).toBe(true);
    if (!check.ok) throw new Error("memory check failed");
    expect((check.data.hints as Array<{ body: string }>).map((hint) => hint.body)).toEqual([
      "Prefer explicit ledgers over blended cost totals."
    ]);
    daemon.close();
  });

  it("confirms pending memories before injection and invalidates them without deletion", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const firstSession = daemon.registerBridge(registerPayload({ observed: "yes", agentId: "codex" }));
    const secondSession = daemon.registerBridge(registerPayload({ observed: "yes", agentId: "claude" }));

    const write = daemon.callTool(
      "memory_write",
      { type: "anti_pattern", body: "Always check the daemon socket before blaming MCP.", intent_keys: ["daemon socket"], source: "auto" },
      contextFor(firstSession, "confirm-write")
    );
    expect(write.ok).toBe(true);
    if (!write.ok) throw new Error("write failed");
    const memoryId = write.data.id as string;

    daemon.callTool("memory_confirm", { id: memoryId, evidence: "observed by codex" }, contextFor(firstSession, "confirm-1"));
    const secondConfirm = daemon.callTool("memory_confirm", { id: memoryId, evidence: "observed by claude" }, contextFor(secondSession, "confirm-2"));
    expect(secondConfirm.ok).toBe(true);
    if (!secondConfirm.ok) throw new Error("confirm failed");
    expect(secondConfirm.data.status).toBe("active");

    const activeCheck = daemon.callTool("memory_check", { intent: { goal: "daemon socket diagnostics" } }, contextFor(firstSession));
    expect(activeCheck.ok).toBe(true);
    if (!activeCheck.ok) throw new Error("active check failed");
    expect(activeCheck.data.hints as unknown[]).toHaveLength(1);

    const invalidate = daemon.callTool(
      "memory_invalidate",
      { id: memoryId, reason: "new bridge no longer uses that socket path", evidence: ["test"] },
      contextFor(firstSession, "invalidate-1")
    );
    expect(invalidate.ok).toBe(true);
    if (!invalidate.ok) throw new Error("invalidate failed");
    expect(invalidate.data.previousConfidence).toBeGreaterThan(0);

    const inactiveCheck = daemon.callTool("memory_check", { intent: { goal: "daemon socket diagnostics" } }, contextFor(firstSession));
    expect(inactiveCheck.ok).toBe(true);
    if (!inactiveCheck.ok) throw new Error("inactive check failed");
    expect(inactiveCheck.data.hints as unknown[]).toHaveLength(0);
    daemon.close();
  });

  it("lets a human review pending memories and filter the review inbox", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ observed: "yes", agentId: "codex" }));

    const write = daemon.callTool(
      "memory_write",
      { type: "procedural", body: "For login tests, isolate fixture state.", intent_keys: ["login tests"], source: "auto", derivation: "session_transcript" },
      contextFor(session, "review-write")
    );
    expect(write.ok).toBe(true);
    if (!write.ok) throw new Error("write failed");
    const memoryId = write.data.id as string;

    const pending = daemon.callTool("memory_list", { status: "pending_review" }, contextFor(session));
    expect(pending.ok).toBe(true);
    if (!pending.ok) throw new Error("pending list failed");
    expect((pending.data.memories as Array<{ id: string }>).map((memory) => memory.id)).toEqual([memoryId]);

    const approve = daemon.callTool("memory_review", { id: memoryId, decision: "approve", reason: "human accepted candidate" }, contextFor(session, "review-approve"));
    expect(approve.ok).toBe(true);
    if (!approve.ok) throw new Error("review failed");
    expect(approve.data.status).toBe("active");
    expect((approve.data.memory as { injectable: boolean }).injectable).toBe(true);

    const activeCheck = daemon.callTool("memory_check", { intent: { task: "login tests" } }, contextFor(session));
    expect(activeCheck.ok).toBe(true);
    if (!activeCheck.ok) throw new Error("active check failed");
    expect((activeCheck.data.hints as Array<{ body: string }>).map((hint) => hint.body)).toEqual(["For login tests, isolate fixture state."]);

    const noisy = daemon.callTool(
      "memory_write",
      { type: "episodic", body: "Completed one smoke task.", intent_keys: ["smoke"], source: "auto", derivation: "session_transcript" },
      contextFor(session, "review-noisy")
    );
    expect(noisy.ok).toBe(true);
    if (!noisy.ok) throw new Error("noisy write failed");
    const reject = daemon.callTool("memory_review", { id: noisy.data.id as string, decision: "reject", reason: "too noisy", evidence: ["smoke"] }, contextFor(session, "review-reject"));
    expect(reject.ok).toBe(true);
    if (!reject.ok) throw new Error("reject failed");
    expect(reject.data.status).toBe("archived");

    const archived = daemon.callTool("memory_list", { status: "archived", archived: true }, contextFor(session));
    expect(archived.ok).toBe(true);
    if (!archived.ok) throw new Error("archived list failed");
    expect(archived.data.total).toBe(1);
    daemon.close();
  });

  it("filters memory checks with SQL-level type and intent predicates before returning hints", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ observed: "yes", agentId: "codex" }));
    for (let i = 0; i < 400; i += 1) {
      daemon.db.db
        .prepare(
          "INSERT INTO memories (id, type, namespace, body, intent_keys_json, confidence, status, severity, refs_json, source) VALUES (?, 'semantic', '/tmp/workspace', ?, ?, 0.9, 'active', 'normal', '[]', 'test')"
        )
        .run(`mem_bulk_${i}`, `Unrelated memory ${i}`, JSON.stringify([`unrelated-${i}`]));
    }
    daemon.db.db
      .prepare(
        "INSERT INTO memories (id, type, namespace, body, intent_keys_json, confidence, status, severity, refs_json, source) VALUES ('mem_target', 'preference', '/tmp/workspace', 'Use the cheap router for routine planning.', ?, 0.1, 'active', 'normal', '[]', 'test')"
      )
      .run(JSON.stringify(["routing cost"]));

    const check = daemon.callTool("memory_check", { intent: { task: "routing cost reduction" }, types: ["preference"], max_hints: 2 }, contextFor(session));
    expect(check.ok).toBe(true);
    if (!check.ok) throw new Error("memory check failed");
    expect((check.data.hints as Array<{ id: string; body: string }>)).toEqual([
      { id: "mem_target", body: "Use the cheap router for routine planning.", confidence: 0.1, provenance: expect.any(Object), refs: [], type: "preference", verifierStatus: "unverified" }
    ]);
    daemon.close();
  });

  it("returns a gated memory eval report when no paired eval has been recorded", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ observed: "yes", agentId: "codex" }));
    const report = daemon.callTool("memory_eval_report", { suite: "memory-v1" }, contextFor(session));
    expect(report.ok).toBe(true);
    if (!report.ok) throw new Error("eval report failed");
    expect(report.data.passed).toBe(false);
    expect(report.data.warnings as string[]).toContain("no paired eval report has been recorded for this suite");
    daemon.close();
  });

  it("reports separated cost ledgers without best-effort totals", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ observed: "yes", agentId: "codex", litellmRouteable: true }));
    daemon.db.db
      .prepare("INSERT INTO cost_billing (id, source, resource_id, cost_usd) VALUES ('bill_1', 'azure', 'resource_1', 12.5)")
      .run();
    daemon.db.db
      .prepare(
        "INSERT INTO cost_events (id, origin_peer_id, coverage_source, provider, model, cost_usd) VALUES ('cost_1', 'peer_test', 'litellm', 'openai', 'gpt-test', 1.25)"
      )
      .run();

    const result = daemon.callTool("pp_cost_month", {}, contextFor(session));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("cost month failed");
    expect(result.data).not.toHaveProperty("bestEffortTotal");
    expect((result.data.ledgers as Record<string, { usd: number }>).billed.usd).toBe(12.5);
    expect((result.data.ledgers as Record<string, { usd: number }>).estimated_live.usd).toBe(1.25);
    expect(result.data.byFeatureTag).toEqual({ unattributed: 1.25 });
    expect(result.data.byAgent).toEqual({ unattributed: 1.25 });
    daemon.close();
  });

  it("reports feature cost rows and detects local cost anomalies", () => {
    const now = new Date("2026-04-27T12:00:00.000Z");
    const daemon = new FabricDaemon({ dbPath: ":memory:", now: () => now, originPeerId: "peer_test" });
    const session = daemon.registerBridge(registerPayload({ observed: "yes", agentId: "codex", litellmRouteable: true }));
    for (const day of ["20", "21", "22", "23", "24", "25", "26"]) {
      daemon.db.db
        .prepare(
          "INSERT INTO cost_events (id, ts, origin_peer_id, coverage_source, provider, model, agent_id, feature_tag, cost_usd) VALUES (?, ?, 'peer_test', 'litellm', 'openai', 'gpt-test', 'codex', 'feature-x', 1)"
        )
        .run(`cost_base_${day}`, `2026-04-${day}T12:00:00.000Z`);
    }
    daemon.db.db
      .prepare(
        "INSERT INTO cost_events (id, ts, origin_peer_id, coverage_source, provider, model, agent_id, feature_tag, cost_usd) VALUES ('cost_spike', '2026-04-27T10:00:00.000Z', 'peer_test', 'litellm', 'openai', 'gpt-test', 'codex', 'feature-x', 10)"
      )
      .run();

    const feature = daemon.callTool(
      "pp_cost_by_feature",
      { tag: "feature-x", since: "2026-04-27T00:00:00.000Z", groupBy: "model" },
      contextFor(session)
    );
    expect(feature.ok).toBe(true);
    if (!feature.ok) throw new Error("feature cost failed");
    expect((feature.data.ledgers as Record<string, { usd: number }>).estimated_live.usd).toBe(10);
    expect(feature.data.rows).toEqual([{ key: "gpt-test", usd: 10, ledger: "estimated_live", calls: 1, coveragePct: 100 }]);

    const anomaly = daemon.callTool("pp_cost_anomaly", { since: "2026-04-27T00:00:00.000Z", threshold: 2 }, contextFor(session));
    expect(anomaly.ok).toBe(true);
    if (!anomaly.ok) throw new Error("anomaly failed");
    expect((anomaly.data.anomalies as Array<{ resourceId: string }>)[0].resourceId).toBe("openai:gpt-test");
    daemon.close();
  });
});

function registerPayload(
  overrides: { observed?: "yes" | "no" | "unknown"; agentId?: string; litellmRouteable?: boolean } = {}
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
      litellmRouteable: overrides.litellmRouteable ?? false,
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

function tableCount(daemon: FabricDaemon, table: string): number {
  const row = daemon.db.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}
