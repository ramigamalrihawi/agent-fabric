import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FabricDaemon } from "../src/daemon.js";
import { startFabricServer } from "../src/server.js";
import type { BridgeRegister, FabricStatus } from "../src/types.js";

describe("Phase 0A.3 cost substrate", () => {
  it("ingests LiteLLM spend logs through the daemon HTTP endpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-cost-http-"));
    const runtime = await startFabricServer({ socketPath: join(dir, "agent.sock"), dbPath: join(dir, "db.sqlite"), httpPort: 0, costIngestToken: "test-token" });
    try {
      const response = await fetch(`http://127.0.0.1:${runtime.httpPort}/cost/ingest/litellm`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({
          records: [
            {
              request_id: "req_http_1",
              provider: "openrouter",
              model: "x-ai/grok-4.1-fast",
              prompt_tokens: 100,
              completion_tokens: 20,
              spend: 0.0012,
              metadata: { feature_tag: "agent-fabric", agent_id: "browser-agent", workspace_root: "/tmp/workspace" }
            }
          ]
        })
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ inserted: 1, skipped: 0 });
      const row = runtime.daemon.db.db.prepare("SELECT * FROM cost_events WHERE request_id = 'req_http_1'").get() as Record<string, unknown>;
      expect(row).toMatchObject({
        provider: "openrouter",
        model: "x-ai/grok-4.1-fast",
        prompt_tokens: 100,
        completion_tokens: 20,
        feature_tag: "agent-fabric",
        agent_id: "browser-agent"
      });
    } finally {
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unauthenticated HTTP cost ingest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-cost-http-auth-"));
    const runtime = await startFabricServer({ socketPath: join(dir, "agent.sock"), dbPath: join(dir, "db.sqlite"), httpPort: 0, costIngestToken: "test-token" });
    try {
      const response = await fetch(`http://127.0.0.1:${runtime.httpPort}/cost/ingest/litellm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ records: [] })
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    } finally {
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ingests LiteLLM spend logs idempotently from duplicate request ids", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const payload = {
      request_id: "req_dupe",
      provider: "openai",
      model: "gpt-5.4",
      prompt_tokens: 10,
      completion_tokens: 3,
      cost_usd: 0.02,
      metadata: { agent_id: "codex", feature_tag: "dupe-test" }
    };
    daemon.ingestLiteLlmSpendLogs([payload]);
    daemon.ingestLiteLlmSpendLogs([payload]);
    expect(tableCount(daemon, "cost_events")).toBe(1);
    daemon.close();
  });

  it("ingests Azure Cost Management query rows into billed ledger rows", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const result = daemon.ingestAzureCostQuery(
      {
        properties: {
          columns: [{ name: "ResourceId" }, { name: "MeterSubCategory" }, { name: "CostUSD" }, { name: "UsageQuantity" }],
          rows: [["/subscriptions/sub/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/a", "Tokens", 12.34, 1000]]
        }
      },
      { periodStart: "2026-04-01T00:00:00.000Z", periodEnd: "2026-04-28T00:00:00.000Z" }
    );
    expect(result.inserted).toBe(1);
    const row = daemon.db.db.prepare("SELECT * FROM cost_billing WHERE source = 'azure-cost-mgmt'").get() as Record<string, unknown>;
    expect(row).toMatchObject({ cost_usd: 12.34, meter_subcategory: "Tokens", usage_qty: 1000 });
    daemon.close();
  });

  it("returns four cost ledgers and marks static routeability without recent spend as uncovered", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const covered = daemon.registerBridge(registerPayload({ agentId: "browser-agent", litellmRouteable: true }));
    daemon.registerBridge(registerPayload({ agentId: "codex-direct", litellmRouteable: false }));
    daemon.ingestLiteLlmSpendLogs([
      {
        request_id: "req_month",
        provider: "openrouter",
        model: "x-ai/grok-4.1-fast",
        prompt_tokens: 100,
        completion_tokens: 25,
        spend: 0.005,
        metadata: { agent_id: "browser-agent", feature_tag: "agent-fabric" }
      }
    ]);
    daemon.ingestAzureCostQuery({
      properties: {
        columns: [{ name: "ResourceId" }, { name: "MeterSubCategory" }, { name: "CostUSD" }],
        rows: [["azure:deployment", "Tokens", 9]]
      }
    });
    daemon.ingestRunPodInventory({ pods: [{ id: "pod-1", desiredStatus: "STOPPED", volumeSizeGB: 100 }] });

    const month = daemon.callTool("pp_cost_month", {}, contextFor(covered));
    expect(month.ok).toBe(true);
    if (!month.ok) throw new Error("cost month failed");
    expect(month.data).not.toHaveProperty("bestEffortTotal");
    const ledgers = month.data.ledgers as Record<string, { usd: number } | Record<string, unknown>>;
    expect((ledgers.billed as { usd: number }).usd).toBe(9);
    expect((ledgers.estimated_live as { usd: number }).usd).toBe(0.005);
    expect((ledgers.fixed_capacity as { usd: number }).usd).toBe(10);
    expect((ledgers.uncovered as { knownSessions: number }).knownSessions).toBe(1);
    daemon.close();
  });

  it("idle audit finds stopped GPU pod storage waste from cached provider inventory", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "codex" }));
    daemon.ingestRunPodInventory({ pods: [{ id: "stopped-pod", desiredStatus: "EXITED", volumeSizeGB: 80 }] });
    const audit = daemon.callTool("pp_cost_idle_audit", {}, contextFor(session));
    expect(audit.ok).toBe(true);
    if (!audit.ok) throw new Error("idle audit failed");
    expect(audit.data.totalEstimatedMonthlyWaste).toBe(8);
    expect((audit.data.findings as Array<Record<string, unknown>>)[0]).toMatchObject({
      kind: "stopped-gpu-pod",
      resource: "runpod:stopped-pod",
      estimatedMonthlyWasteUsd: 8
    });
    daemon.close();
  });

  it("idle audit flags unused OpenRouter virtual keys without inventing dollar waste", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "codex" }));
    daemon.ingestOpenRouterKeys({ keys: [{ hash: "key-empty", name: "old-key", requests30d: 0 }] });
    const audit = daemon.callTool("pp_cost_idle_audit", {}, contextFor(session));
    expect(audit.ok).toBe(true);
    if (!audit.ok) throw new Error("idle audit failed");
    expect((audit.data.findings as Array<Record<string, unknown>>)[0]).toMatchObject({
      kind: "unused-openrouter-key",
      estimatedMonthlyWasteUsd: 0
    });
    daemon.close();
  });

  it("fabric_status coverage is based on recent observed cost_events, not only routeable declarations", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "browser-agent", litellmRouteable: true }));
    const before = daemon.callTool<FabricStatus>("fabric_status", { includeSessions: true }, contextFor(session));
    expect(before.ok).toBe(true);
    if (!before.ok) throw new Error("status failed");
    expect(before.data.coverage.byAgent["browser-agent"]).toBe(0);
    expect(before.data.warnings).toContain("browser-agent: LiteLLM routeable but no cost_events observed in the last hour");

    daemon.ingestLiteLlmSpendLogs([
      { request_id: "req_status", provider: "openrouter", model: "x-ai/grok-4.1-fast", cost_usd: 0.01, metadata: { agent_id: "browser-agent" } }
    ]);
    const after = daemon.callTool<FabricStatus>("fabric_status", { includeSessions: true }, contextFor(session));
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error("status failed");
    expect(after.data.coverage.byAgent["browser-agent"]).toBe(100);
    daemon.close();
  });
});

function registerPayload(overrides: { agentId?: string; litellmRouteable?: boolean } = {}): BridgeRegister {
  return {
    bridgeVersion: "0.1.0",
    agent: { id: overrides.agentId ?? "codex", displayName: overrides.agentId ?? "Codex", vendor: "openai" },
    host: { name: "Cost Test Host", transport: "simulator" },
    workspace: { root: "/tmp/workspace", source: "explicit" },
    capabilities: {
      roots: true,
      notifications: true,
      notificationsVisibleToAgent: { declared: "yes", observed: "yes" },
      sampling: false,
      streamableHttp: false,
      litellmRouteable: overrides.litellmRouteable ?? false,
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
