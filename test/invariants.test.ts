import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FabricClient } from "../src/client.js";
import { FabricDaemon, FabricError } from "../src/daemon.js";
import { startFabricServer } from "../src/server.js";
import type { BridgeRegister, FabricStatus } from "../src/types.js";

describe("Phase 0A substrate invariants", () => {
  it("Invariant: host-declared notification support does not become observed without daemon challenge completion", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ transport: "uds", declared: "yes", claimedObserved: "yes" }));

    const status = daemon.callTool<FabricStatus>("fabric_status", {}, contextFor(session));
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error("status failed");
    expect(status.data.bridgeSessions.sessions[0].notificationsVisibleToAgent).toEqual({
      declared: "yes",
      observed: "unknown"
    });
    daemon.close();
  });

  it("Invariant: notification self-test completion is what graduates observed=yes", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ transport: "uds", declared: "yes" }));

    const start = daemon.callTool("fabric_notification_self_test_start", { ttlSeconds: 30 }, contextFor(session));
    expect(start.ok).toBe(true);
    if (!start.ok) throw new Error("self-test start failed");
    const complete = daemon.callTool(
      "fabric_notification_self_test_complete",
      { testId: start.data.testId, observed: "yes", detail: "agent saw challenge" },
      contextFor(session)
    );
    expect(complete.ok).toBe(true);

    const status = daemon.fabricStatus();
    expect(status.bridgeSessions.sessions[0].notificationsVisibleToAgent.observed).toBe("yes");
    daemon.close();
  });

  it("Invariant: notification self-test timeout records observed=no instead of trusting declarations", () => {
    let now = new Date("2026-04-27T10:00:00.000Z");
    const daemon = new FabricDaemon({ dbPath: ":memory:", now: () => now });
    const session = daemon.registerBridge(registerPayload({ transport: "uds", declared: "yes" }));
    const start = daemon.callTool("fabric_notification_self_test_start", { ttlSeconds: 1 }, contextFor(session));
    expect(start.ok).toBe(true);

    now = new Date("2026-04-27T10:00:02.000Z");
    const status = daemon.fabricStatus();
    expect(status.bridgeSessions.sessions[0].notificationsVisibleToAgent.observed).toBe("no");
    daemon.close();
  });

  it("Invariant: canonical row and outbox event roll back together when a mutation fails", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ transport: "simulator" }));
    const context = contextFor(session, "atomic-fail");
    const startingEvents = tableCount(daemon, "events");

    expect(() =>
      daemon.recordMutation("atomic_failure", { value: 1 }, context, (activeSession) => {
        daemon.db.db
          .prepare(
            "INSERT INTO messages (id, sender_agent_id, session_id, origin_peer_id, workspace_root, recipient, kind, body) VALUES ('msg_fail', ?, ?, ?, ?, '*', 'broadcast', 'will rollback')"
          )
          .run(activeSession.agent_id, activeSession.id, daemon.originPeerId, activeSession.workspace_root);
        daemon.writeAuditAndEvent({
          sessionId: activeSession.id,
          agentId: activeSession.agent_id,
          hostName: activeSession.host_name,
          workspaceRoot: activeSession.workspace_root,
          action: "test.atomic_failure",
          sourceTable: "messages",
          sourceId: "msg_fail",
          eventType: "test.atomic_failure",
          payload: {},
          testMode: true,
          context
        });
        throw new Error("forced rollback");
      })
    ).toThrow("forced rollback");

    expect(tableCount(daemon, "messages")).toBe(0);
    expect(tableCount(daemon, "events")).toBe(startingEvents);
    expect(tableCount(daemon, "idempotency_keys")).toBe(0);
    daemon.close();
  });

  it("Invariant: bridge retry after daemon restart returns the original idempotent mutation result", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-restart-"));
    const dbPath = join(dir, "db.sqlite");
    const daemon = new FabricDaemon({ dbPath });
    const session = daemon.registerBridge(registerPayload({ transport: "simulator" }));
    const context = contextFor(session, "restart-send");
    const first = daemon.callTool("collab_send", { to: "*", body: "persisted" }, context);
    expect(first.ok).toBe(true);
    daemon.close();

    const reopened = new FabricDaemon({ dbPath });
    const replay = reopened.callTool("collab_send", { to: "*", body: "persisted" }, context);
    expect(replay).toEqual(first);
    expect(tableCount(reopened, "messages")).toBe(1);
    expect(tableCount(reopened, "events")).toBe(2);
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("Invariant: same idempotency key with different payload returns IDEMPOTENCY_CONFLICT", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ transport: "simulator" }));
    const context = contextFor(session, "idem-conflict");

    daemon.recordMutation("conflict_test", { value: 1 }, context, () => ({ value: 1 }));
    expect(() => daemon.recordMutation("conflict_test", { value: 2 }, context, () => ({ value: 2 }))).toThrow(FabricError);
    daemon.close();
  });

  it("Invariant: socket reconnect with same session and idempotency key replays the original result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-reconnect-"));
    const socketPath = join(dir, "agent.sock");
    const dbPath = join(dir, "db.sqlite");
    const runtime = await startFabricServer({ socketPath, dbPath });
    const client = new FabricClient(socketPath);
    const session = await client.register(registerPayload({ transport: "simulator" }));
    const context = contextFor(session, "socket-reconnect");

    const first = await client.call("collab_send", { to: "*", body: "retry me" }, context);
    const secondClient = new FabricClient(socketPath);
    const replay = await secondClient.call("collab_send", { to: "*", body: "retry me" }, context);
    expect(replay).toEqual(first);

    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("Invariant: fan-out cannot be reported before durable commit in async-only mode", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ transport: "simulator" }));
    const result = daemon.callTool("collab_send", { to: "*", body: "durable first" }, contextFor(session, "fanout-1"));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("send failed");
    expect(result.data).toMatchObject({ mode: "async-only", fanoutAttempted: false, fanoutAckedCount: 0 });
    expect((result.data as Record<string, unknown>).deliveryCaveats).toBeUndefined();
    expect(tableCount(daemon, "messages")).toBe(1);
    expect(tableCount(daemon, "events")).toBe(2);
    daemon.close();
  });

  it("Invariant: partial-state migration repair runs idempotent statements even when guarded ALTER is skipped", () => {
    // Simulate a DB where the v3 ALTER landed (column exists) but the
    // sibling memory_eval_reports table did NOT. Older runner skipped the
    // whole migration; new runner must still create the missing table.
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-migrate-"));
    const dbPath = join(dir, "db.sqlite");

    {
      const daemon = new FabricDaemon({ dbPath });
      // Drop memory_eval_reports out from under the schema and rewind to v2
      // so the v3 migration runs again on next open.
      daemon.db.db.exec("DROP TABLE memory_eval_reports;");
      daemon.db.db.exec("DELETE FROM _schema_versions WHERE version >= 3;");
      // Confirm the partial-state precondition we're testing.
      const tableRow = daemon.db.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_eval_reports'")
        .get();
      expect(tableRow).toBeUndefined();
      const cols = daemon.db.db.prepare("PRAGMA table_info(memory_injections)").all() as { name: string }[];
      expect(cols.some((c) => c.name === "test_mode")).toBe(true);
      daemon.close();
    }

    {
      const reopened = new FabricDaemon({ dbPath });
      const tableRow = reopened.db.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_eval_reports'")
        .get();
      expect(tableRow).toBeDefined();
      reopened.close();
    }

    rmSync(dir, { recursive: true, force: true });
  });

  it("Invariant: idempotency replay returns the seeded result without redoing the mutation, even via the in-transaction re-check path", async () => {
    // Property under test: when an idempotency_keys row exists with a matching
    // payload hash, recordMutation must replay it from the cached result and
    // must NOT insert a second row or attempt the mutation again. Both the
    // outer fast-path lookup and the in-transaction re-check rely on this
    // behavior; if either is broken we'd see a duplicate row, a fresh
    // mutation result, or an INTERNAL_ERROR from a unique-constraint violation.
    const { stableHash } = await import("../src/ids.js");
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ transport: "simulator" }));
    const input = { to: "*", body: "seeded-by-test" };
    const context = contextFor(session, "race-key");

    // Pre-seed the idempotency row that a "racing peer" would have written.
    // The payload_hash matches what the daemon will compute for `input`, so
    // both the outer pre-check AND the in-tx re-check should find this row
    // and replay rather than mutating.
    const seededResult = { messageId: "msg_peer_seed", ts: "2026-01-01T00:00:00.000Z", peer: true };
    daemon.db.db
      .prepare(
        "INSERT INTO idempotency_keys (session_id, tool, idempotency_key, payload_hash, result_json) VALUES (?, ?, ?, ?, ?)"
      )
      .run(session.sessionId, "collab_send", "race-key", stableHash(input), JSON.stringify(seededResult));

    const result = daemon.callTool("collab_send", input, context);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toEqual(seededResult);

    // Replay must not have written a second idempotency row, audit row, or
    // message row. The seeded result is the only side effect.
    const idempCount = (daemon.db.db
      .prepare("SELECT COUNT(*) AS count FROM idempotency_keys WHERE idempotency_key = ?")
      .get("race-key") as { count: number }).count;
    expect(idempCount).toBe(1);
    expect(tableCount(daemon, "messages")).toBe(0);
    daemon.close();
  });

  it("Invariant: bi-temporal supersession closes the previous belief without rewriting it", () => {
    let now = new Date("2026-04-28T10:00:00.000Z");
    const daemon = new FabricDaemon({ dbPath: ":memory:", now: () => now });
    const session = daemon.registerBridge(registerPayload({ transport: "simulator" }));

    const first = daemon.callTool(
      "memory_write",
      { type: "semantic", body: "Model X costs $1/M input.", intent_keys: ["model-x pricing"], source: "user" },
      contextFor(session, "bitemporal-first")
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("first write failed");

    now = new Date("2026-04-28T11:00:00.000Z");
    const second = daemon.callTool(
      "memory_write",
      {
        type: "semantic",
        body: "Model X costs $2/M input.",
        intent_keys: ["model-x pricing"],
        source: "user",
        supersedes: first.data.id
      },
      contextFor(session, "bitemporal-second")
    );
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("second write failed");

    const previous = daemon.db.db.prepare("SELECT body, recorded_at, recorded_until FROM memories WHERE id = ?").get(first.data.id) as {
      body: string;
      recorded_at: string;
      recorded_until: string;
    };
    const current = daemon.db.db.prepare("SELECT body, recorded_at, recorded_until FROM memories WHERE id = ?").get(second.data.id) as {
      body: string;
      recorded_at: string;
      recorded_until: string | null;
    };
    expect(previous.body).toBe("Model X costs $1/M input.");
    expect(previous.recorded_at).toBe("2026-04-28T10:00:00.000Z");
    expect(previous.recorded_until).toBe("2026-04-28T11:00:00.000Z");
    expect(current.recorded_at).toBe("2026-04-28T11:00:00.000Z");
    expect(current.recorded_until).toBeNull();

    const check = daemon.callTool("memory_check", { intent: { goal: "model-x pricing" } }, contextFor(session));
    expect(check.ok).toBe(true);
    if (!check.ok) throw new Error("memory check failed");
    expect((check.data.hints as Array<{ body: string }>).map((hint) => hint.body)).toEqual(["Model X costs $2/M input."]);
    daemon.close();
  });

  it("Invariant: bi-temporal as-of queries reconstruct prior beliefs", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    daemon.db.db
      .prepare(
        `INSERT INTO memories (
          id, type, namespace, body, intent_keys_json, confidence, status, severity,
          refs_json, source, valid_from, invalid_at, recorded_at, recorded_until
        ) VALUES (?, 'semantic', '/tmp/workspace', ?, '["pricing"]', 0.8, 'active', 'normal', '[]', 'user', ?, NULL, ?, ?)`
      )
      .run("mem_old", "Model X costs $1/M input.", "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z");
    daemon.db.db
      .prepare(
        `INSERT INTO memories (
          id, type, namespace, body, intent_keys_json, confidence, status, severity,
          refs_json, source, valid_from, invalid_at, recorded_at, recorded_until
        ) VALUES (?, 'semantic', '/tmp/workspace', ?, '["pricing"]', 0.8, 'active', 'normal', '[]', 'user', ?, NULL, ?, NULL)`
      )
      .run("mem_new", "Model X costs $2/M input.", "2026-01-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z");

    const query = `
      SELECT body FROM memories
      WHERE namespace = ?
        AND valid_from <= ?
        AND (invalid_at IS NULL OR invalid_at > ?)
        AND recorded_at <= ?
        AND (recorded_until IS NULL OR recorded_until > ?)
      ORDER BY recorded_at DESC
    `;
    const prior = daemon.db.db
      .prepare(query)
      .all(
        "/tmp/workspace",
        "2026-02-15T00:00:00.000Z",
        "2026-02-15T00:00:00.000Z",
        "2026-02-15T00:00:00.000Z",
        "2026-02-15T00:00:00.000Z"
      ) as { body: string }[];
    const current = daemon.db.db
      .prepare(query)
      .all(
        "/tmp/workspace",
        "2026-02-15T00:00:00.000Z",
        "2026-02-15T00:00:00.000Z",
        "2026-04-01T00:00:00.000Z",
        "2026-04-01T00:00:00.000Z"
      ) as { body: string }[];

    expect(prior.map((row) => row.body)).toEqual(["Model X costs $1/M input."]);
    expect(current.map((row) => row.body)).toEqual(["Model X costs $2/M input."]);
    daemon.close();
  });
});

function registerPayload(
  overrides: {
    transport?: "mcp-stdio" | "mcp-streamable-http" | "uds" | "ws-compat" | "simulator";
    declared?: "yes" | "no" | "unknown";
    claimedObserved?: "yes" | "no" | "unknown";
  } = {}
): BridgeRegister {
  return {
    bridgeVersion: "0.1.0",
    agent: { id: "codex", displayName: "Codex", vendor: "openai" },
    host: { name: "Codex Test Host", version: "1.0.0", transport: overrides.transport ?? "simulator" },
    workspace: { root: "/tmp/workspace", source: "explicit" },
    capabilities: {
      roots: true,
      notifications: true,
      notificationsVisibleToAgent: { declared: overrides.declared ?? "yes", observed: overrides.claimedObserved ?? "unknown" },
      sampling: false,
      streamableHttp: false,
      litellmRouteable: false,
      outcomeReporting: "explicit"
    },
    notificationSelfTest: { observed: overrides.claimedObserved ?? "unknown", detail: "claimed by test payload" },
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
