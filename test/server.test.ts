import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FabricClient } from "../src/client.js";
import { startFabricServer, type FabricServer } from "../src/server.js";
import type { BridgeRegister, FabricStatus } from "../src/types.js";

describe("UDS daemon transport", () => {
  it("registers and calls fabric_status over the socket", async () => {
    await withServer(async ({ socketPath }) => {
      const client = new FabricClient(socketPath);
      const session = await client.register(registerPayload());
      const status = await client.call<FabricStatus>("fabric_status", { includeSessions: true }, {
        sessionId: session.sessionId,
        sessionToken: session.sessionToken
      });

      expect(status.daemon.status).toBe("ok");
      expect(status.daemon.tools?.missingSeniorRequired).toEqual([]);
      expect(status.daemon.tools?.seniorRequired).toEqual(
        expect.arrayContaining(["fabric_senior_start", "fabric_spawn_agents", "project_queue_approve_model_calls"])
      );
      expect(status.daemon.runtime?.cwd).toBeTruthy();
      expect(status.bridgeSessions.active).toBe(1);
      expect(status.bridgeSessions.sessions[0].agentId).toBe("simulator");
    });
  });

  it("returns BAD_JSON envelope when a frame is not valid JSON", async () => {
    await withServer(async ({ socketPath }) => {
      const response = await sendRaw(socketPath, "{not-valid-json}\n");
      expect(response.ok).toBe(false);
      if (response.ok) throw new Error("expected error");
      expect(response.error.code).toBe("BAD_JSON");
      expect(response.error.retryable).toBe(false);
    });
  });

  it("rejects oversized request frames with PAYLOAD_TOO_LARGE and closes the socket", async () => {
    await withServer(async ({ socketPath }) => {
      const huge = "a".repeat((1 << 20) + 16);
      // Don't terminate with a newline — the size cap must trip before parse.
      const response = await sendRaw(socketPath, huge);
      expect(response.ok).toBe(false);
      if (response.ok) throw new Error("expected error");
      expect(response.error.code).toBe("PAYLOAD_TOO_LARGE");
    });
  });

  it("rejects mutations called without a session token", async () => {
    await withServer(async ({ socketPath }) => {
      const client = new FabricClient(socketPath);
      const session = await client.register(registerPayload());
      // Same session id, but no token. requireSession should reject.
      await expect(
        client.call("collab_send", { to: "*", body: "should fail" }, { sessionId: session.sessionId })
      ).rejects.toMatchObject({ code: "SESSION_UNAUTHORIZED" });
    });
  });

  it("handles two concurrent client connections without crossing wires", async () => {
    await withServer(async ({ socketPath }) => {
      const clientA = new FabricClient(socketPath);
      const clientB = new FabricClient(socketPath);

      const [sessionA, sessionB] = await Promise.all([
        clientA.register(registerPayload({ agentId: "sim-a" })),
        clientB.register(registerPayload({ agentId: "sim-b" }))
      ]);

      expect(sessionA.sessionId).not.toBe(sessionB.sessionId);

      const [statusA, statusB] = await Promise.all([
        clientA.call<FabricStatus>("fabric_status", { includeSessions: true }, {
          sessionId: sessionA.sessionId,
          sessionToken: sessionA.sessionToken
        }),
        clientB.call<FabricStatus>("fabric_status", { includeSessions: true }, {
          sessionId: sessionB.sessionId,
          sessionToken: sessionB.sessionToken
        })
      ]);

      expect(statusA.daemon.status).toBe("ok");
      expect(statusB.daemon.status).toBe("ok");
      expect(statusA.bridgeSessions.active).toBe(2);
      expect(statusB.bridgeSessions.active).toBe(2);
    });
  });
});

async function withServer<T>(fn: (ctx: { runtime: FabricServer; socketPath: string }) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "agent-fabric-uds-"));
  const socketPath = join(dir, "agent.sock");
  const dbPath = join(dir, "db.sqlite");
  const runtime = await startFabricServer({ socketPath, dbPath });
  try {
    return await fn({ runtime, socketPath });
  } finally {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function sendRaw(socketPath: string, payload: string): Promise<{ id: string; ok: boolean; error: { code: string; retryable: boolean } } | { id: string; ok: true; result: unknown }> {
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(payload);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index === -1) return;
      const line = buffer.slice(0, index);
      socket.end();
      try {
        resolve(JSON.parse(line));
      } catch (e) {
        reject(e);
      }
    });
    socket.on("error", reject);
    socket.on("close", () => {
      if (buffer && !buffer.includes("\n")) {
        // Server closed without a complete frame. Surface as raw close.
        reject(new Error("socket closed before response framed"));
      }
    });
  });
}

function registerPayload(overrides: { agentId?: string } = {}): BridgeRegister {
  const agentId = overrides.agentId ?? "simulator";
  return {
    bridgeVersion: "0.1.0",
    agent: { id: agentId, displayName: agentId, vendor: "local" },
    host: { name: "Simulator", transport: "simulator" },
    workspace: { root: "/tmp/workspace", source: "explicit" },
    capabilities: {
      roots: false,
      notifications: true,
      notificationsVisibleToAgent: { declared: "yes", observed: "yes" },
      sampling: false,
      streamableHttp: false,
      litellmRouteable: true,
      outcomeReporting: "explicit"
    },
    notificationSelfTest: { observed: "yes", detail: "simulated" },
    testMode: true
  };
}
