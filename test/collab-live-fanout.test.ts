import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { FabricDaemon } from "../src/daemon.js";
import { InMemoryFanoutRegistry, type CollabFanoutEnvelope } from "../src/runtime/fanout.js";
import { startFabricServer, type FabricServer } from "../src/server.js";
import type { BridgeRegister } from "../src/types.js";

describe("collab live fan-out", () => {
  const daemons: FabricDaemon[] = [];

  afterEach(() => {
    while (daemons.length > 0) {
      daemons.pop()?.close();
    }
  });

  it("pushes to one online recipient in under 100ms", () => {
    const registry = new InMemoryFanoutRegistry();
    const daemon = track(new FabricDaemon({ dbPath: ":memory:", fanout: registry }));
    const sender = daemon.registerBridge(registerPayload({ agentId: "codex" }));
    const recipient = daemon.registerBridge(registerPayload({ agentId: "claude" }));
    const received: CollabFanoutEnvelope[] = [];
    let receivedAt = 0;
    registry.subscribe({
      sessionId: recipient.sessionId,
      agentId: "claude",
      workspaceRoot: "/tmp/workspace",
      notificationsDeclared: "yes",
      send: (envelope) => {
        receivedAt = performance.now();
        received.push(envelope);
      }
    });

    const startedAt = performance.now();
    const result = sendOk(daemon, sender, { to: "claude", body: "handoff" }, "live-one");

    expect(result).toMatchObject({ mode: "live", fanoutAttempted: true, fanoutAckedCount: 1 });
    expect(received).toHaveLength(1);
    expect(received[0].message).toMatchObject({ body: "handoff", to: "claude", from: "codex" });
    expect(receivedAt - startedAt).toBeLessThan(100);
  });

  it("broadcasts to multiple online recipients", () => {
    const registry = new InMemoryFanoutRegistry();
    const daemon = track(new FabricDaemon({ dbPath: ":memory:", fanout: registry }));
    const sender = daemon.registerBridge(registerPayload({ agentId: "sender" }));
    const first = daemon.registerBridge(registerPayload({ agentId: "first" }));
    const second = daemon.registerBridge(registerPayload({ agentId: "second" }));
    const received: CollabFanoutEnvelope[] = [];
    for (const session of [first, second]) {
      registry.subscribe({
        sessionId: session.sessionId,
        agentId: session.agentId,
        workspaceRoot: "/tmp/workspace",
        notificationsDeclared: "yes",
        send: (envelope) => {
          received.push(envelope);
        }
      });
    }

    const result = sendOk(daemon, sender, { to: "*", body: "broadcast" }, "broadcast");

    expect(result).toMatchObject({ mode: "live", fanoutAttempted: true, fanoutAckedCount: 2 });
    expect(received.map((event) => event.message.body)).toEqual(["broadcast", "broadcast"]);
    expect(received.map((event) => event.recipient)).toEqual(["*", "*"]);
  });

  it("delivers to multiple live connections for one recipient session", () => {
    const registry = new InMemoryFanoutRegistry();
    const daemon = track(new FabricDaemon({ dbPath: ":memory:", fanout: registry }));
    const sender = daemon.registerBridge(registerPayload({ agentId: "codex" }));
    const recipient = daemon.registerBridge(registerPayload({ agentId: "claude" }));
    const received: CollabFanoutEnvelope[] = [];
    for (const connectionId of ["conn-a", "conn-b"]) {
      registry.subscribe({
        connectionId,
        sessionId: recipient.sessionId,
        agentId: "claude",
        workspaceRoot: "/tmp/workspace",
        notificationsDeclared: "yes",
        send: (envelope) => {
          received.push(envelope);
        }
      });
    }

    const result = sendOk(daemon, sender, { to: "claude", body: "two tabs" }, "multi-connection");

    expect(result).toMatchObject({ mode: "live", fanoutAttempted: true, fanoutAckedCount: 2 });
    expect(received).toHaveLength(2);
  });

  it("replays the live fan-out result idempotently without sending twice", () => {
    const registry = new InMemoryFanoutRegistry();
    const daemon = track(new FabricDaemon({ dbPath: ":memory:", fanout: registry }));
    const sender = daemon.registerBridge(registerPayload({ agentId: "codex" }));
    const recipient = daemon.registerBridge(registerPayload({ agentId: "claude" }));
    let pushed = 0;
    registry.subscribe({
      sessionId: recipient.sessionId,
      agentId: "claude",
      workspaceRoot: "/tmp/workspace",
      notificationsDeclared: "yes",
      send: () => {
        pushed += 1;
      }
    });

    const first = sendOk(daemon, sender, { to: "claude", body: "retry-safe live" }, "live-replay");
    const replay = sendOk(daemon, sender, { to: "claude", body: "retry-safe live" }, "live-replay");

    expect(first).toMatchObject({ mode: "live", fanoutAttempted: true, fanoutAckedCount: 1 });
    expect(replay).toEqual(first);
    expect(pushed).toBe(1);
  });

  it("keeps offline recipients async-only while storing the message", () => {
    const registry = new InMemoryFanoutRegistry();
    const daemon = track(new FabricDaemon({ dbPath: ":memory:", fanout: registry }));
    const sender = daemon.registerBridge(registerPayload({ agentId: "codex" }));
    const recipient = daemon.registerBridge(registerPayload({ agentId: "offline" }));

    const result = sendOk(daemon, sender, { to: "offline", body: "check inbox" }, "offline");

    expect(result).toMatchObject({ mode: "async-only", fanoutAttempted: false, fanoutAckedCount: 0 });
    const inbox = daemon.callTool("collab_inbox", {}, contextFor(recipient));
    expect(inbox.ok).toBe(true);
    if (!inbox.ok) throw new Error("inbox failed");
    expect((inbox.data.messages as Array<{ body: string }>)[0].body).toBe("check inbox");
  });

  it("stays durable-first when the transport throws", () => {
    const registry = new InMemoryFanoutRegistry();
    const daemon = track(new FabricDaemon({ dbPath: ":memory:", fanout: registry }));
    const sender = daemon.registerBridge(registerPayload({ agentId: "codex" }));
    const recipient = daemon.registerBridge(registerPayload({ agentId: "claude" }));
    let attempted = 0;
    registry.subscribe({
      sessionId: recipient.sessionId,
      agentId: "claude",
      workspaceRoot: "/tmp/workspace",
      notificationsDeclared: "yes",
      send: () => {
        attempted += 1;
        throw new Error("transport failed");
      }
    });

    const result = sendOk(daemon, sender, { to: "claude", body: "durable" }, "throwing-transport");

    expect(result).toMatchObject({ mode: "async-only", fanoutAttempted: true, fanoutAckedCount: 0 });
    expect(attempted).toBe(1);
    const row = daemon.db.db.prepare("SELECT body FROM messages WHERE recipient = ?").get("claude") as { body: string };
    expect(row.body).toBe("durable");
  });

  it("treats a transport false return as attempted but not acked", () => {
    const registry = new InMemoryFanoutRegistry();
    const daemon = track(new FabricDaemon({ dbPath: ":memory:", fanout: registry }));
    const sender = daemon.registerBridge(registerPayload({ agentId: "codex" }));
    const recipient = daemon.registerBridge(registerPayload({ agentId: "claude" }));
    registry.subscribe({
      sessionId: recipient.sessionId,
      agentId: "claude",
      workspaceRoot: "/tmp/workspace",
      notificationsDeclared: "yes",
      send: () => false
    });

    const result = sendOk(daemon, sender, { to: "claude", body: "backpressure" }, "false-return");

    expect(result).toMatchObject({ mode: "async-only", fanoutAttempted: true, fanoutAckedCount: 0 });
  });

  it("does not push to sessions without declared notification capability", () => {
    const registry = new InMemoryFanoutRegistry();
    const daemon = track(new FabricDaemon({ dbPath: ":memory:", fanout: registry }));
    const sender = daemon.registerBridge(registerPayload({ agentId: "codex" }));
    const recipient = daemon.registerBridge(registerPayload({ agentId: "claude", declared: "no" }));
    let pushed = false;
    registry.subscribe({
      sessionId: recipient.sessionId,
      agentId: "claude",
      workspaceRoot: "/tmp/workspace",
      notificationsDeclared: "no",
      send: () => {
        pushed = true;
      }
    });

    const result = sendOk(daemon, sender, { to: "claude", body: "capability filter" }, "capability");

    expect(result).toMatchObject({ mode: "async-only", fanoutAttempted: false, fanoutAckedCount: 0 });
    expect(pushed).toBe(false);
  });

  it("evicts stale connections after the heartbeat window", () => {
    let now = 1_000;
    let closed = 0;
    const registry = new InMemoryFanoutRegistry({ now: () => now, staleMs: 60_000 });
    registry.subscribe({
      connectionId: "conn-1",
      sessionId: "session-1",
      agentId: "claude",
      workspaceRoot: "/tmp/workspace",
      notificationsDeclared: "yes",
      send: () => undefined,
      close: () => {
        closed += 1;
      }
    });

    expect(registry.size()).toBe(1);
    now += 60_001;
    expect(registry.sweep()).toBe(1);
    expect(registry.size()).toBe(0);
    expect(closed).toBe(1);
  });

  it("serves live fan-out over the daemon SSE endpoint", async () => {
    await withServer(async ({ runtime }) => {
      const sender = runtime.daemon.registerBridge(registerPayload({ agentId: "codex" }));
      const recipient = runtime.daemon.registerBridge(registerPayload({ agentId: "claude" }));
      const abort = new AbortController();
      const response = await fetch(`http://127.0.0.1:${runtime.httpPort}/events?sessionId=${encodeURIComponent(recipient.sessionId)}`, {
        headers: { authorization: `Bearer ${recipient.sessionToken}` },
        signal: abort.signal
      });
      expect(response.status).toBe(200);
      const eventPromise = readCollabEvent(response);

      const result = sendOk(runtime.daemon, sender, { to: "claude", body: "from http" }, "sse-http");
      const event = await eventPromise;
      abort.abort();

      expect(result).toMatchObject({ mode: "live", fanoutAttempted: true, fanoutAckedCount: 1 });
      expect(event.message).toMatchObject({ body: "from http", to: "claude", from: "codex" });
    });
  });

  it("refreshes an SSE connection through the ping endpoint", async () => {
    await withServer(async ({ runtime }) => {
      const recipient = runtime.daemon.registerBridge(registerPayload({ agentId: "claude" }));
      const abort = new AbortController();
      const response = await fetch(`http://127.0.0.1:${runtime.httpPort}/events?sessionId=${encodeURIComponent(recipient.sessionId)}`, {
        headers: { authorization: `Bearer ${recipient.sessionToken}` },
        signal: abort.signal
      });
      expect(response.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const ping = await fetch(`http://127.0.0.1:${runtime.httpPort}/events/ping`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${recipient.sessionToken}`,
          "x-agent-fabric-session-id": recipient.sessionId
        }
      });
      abort.abort();

      expect(ping.status).toBe(200);
      await expect(ping.json()).resolves.toMatchObject({ ok: true, touched: true, connectionId: null });
    });
  });

  function track(daemon: FabricDaemon): FabricDaemon {
    daemons.push(daemon);
    return daemon;
  }
});

function sendOk(
  daemon: FabricDaemon,
  session: { sessionId: string; sessionToken: string },
  input: { to: string; body: string },
  idempotencyKey: string
): Record<string, unknown> {
  const result = daemon.callTool("collab_send", input, contextFor(session, idempotencyKey));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.data;
}

async function withServer<T>(fn: (ctx: { runtime: FabricServer }) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "agent-fabric-sse-"));
  const runtime = await startFabricServer({
    socketPath: join(dir, "agent.sock"),
    dbPath: join(dir, "db.sqlite"),
    httpPort: 0,
    costIngestToken: "test-token"
  });
  try {
    return await fn({ runtime });
  } finally {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function readCollabEvent(response: Response): Promise<CollabFanoutEnvelope> {
  return readSseEvent(response, "collab.message") as Promise<CollabFanoutEnvelope>;
}

async function readSseEvent(response: Response, eventName: string): Promise<unknown> {
  if (!response.body) throw new Error("missing response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pattern = new RegExp(`event: ${eventName.replace(".", "\\.")}\\ndata: ([^\\n]+)\\n\\n`);
  return withTimeout(
    (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) throw new Error("SSE stream ended before collab event");
        buffer += decoder.decode(value, { stream: true });
        const match = pattern.exec(buffer);
        if (match) {
          await reader.cancel();
          return JSON.parse(match[1]) as unknown;
        }
      }
    })(),
    1_000
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function registerPayload(
  overrides: { agentId?: string; declared?: "yes" | "no" | "unknown"; observed?: "yes" | "no" | "unknown" } = {}
): BridgeRegister {
  const agentId = overrides.agentId ?? "codex";
  return {
    bridgeVersion: "0.1.0",
    agent: { id: agentId, displayName: agentId, vendor: "local" },
    host: { name: "Simulator", transport: "simulator" },
    workspace: { root: "/tmp/workspace", source: "explicit" },
    capabilities: {
      roots: false,
      notifications: true,
      notificationsVisibleToAgent: { declared: overrides.declared ?? "yes", observed: "unknown" },
      sampling: false,
      streamableHttp: false,
      litellmRouteable: true,
      outcomeReporting: "explicit"
    },
    notificationSelfTest: { observed: overrides.observed ?? "yes", detail: "simulated" },
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
