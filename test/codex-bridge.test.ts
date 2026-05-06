import { describe, expect, it } from "vitest";
import { FabricDaemon } from "../src/daemon.js";
import type { BridgeRegister } from "../src/types.js";

describe("Codex-style Agent Fabric worker bridge", () => {
  it("returns a capacity error instead of silently shrinking a 10-worker Senior request", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const queueId = createQueue(daemon, session, "capacity-create", 4);
    addReadyTasks(daemon, session, queueId, 4);
    startExecution(daemon, session, queueId, "capacity-start");

    const result = daemon.callTool(
      "fabric_spawn_agents",
      { queueId, count: 10, worker: "deepseek-direct", workspaceMode: "git_worktree" },
      contextFor(session, "capacity-spawn")
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("spawn failed");
    expect(result.data).toMatchObject({
      status: "capacity_blocked",
      requested: 10,
      started: 0,
      queued: 6,
      activeWorkers: 0,
      availableSlots: 4,
      readyCount: 4
    });
    daemon.close();
  });

  it("spawns queue-visible cards, opens an @af worker, messages it, and accepts a patch-ready result", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const queueId = createQueue(daemon, session, "codex-create", 4);
    const tasks = addReadyTasks(daemon, session, queueId, 2);
    startExecution(daemon, session, queueId, "codex-start");

    const spawned = daemon.callTool(
      "fabric_spawn_agents",
      { queueId, count: 2, worker: "deepseek-direct", workspaceMode: "git_worktree" },
      contextFor(session, "codex-spawn")
    );
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error("spawn failed");
    expect(spawned.data).toMatchObject({ status: "started", requested: 2, started: 2, queued: 0 });

    const listed = daemon.callTool("fabric_list_agents", { queueId, includeCompleted: true }, contextFor(session));
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error("list failed");
    expect(listed.data.cards).toHaveLength(2);
    expect(listed.data.cards[0].handle).toMatch(/^@af\//);
    expect(listed.data.cards.map((card: { displayName: string }) => card.displayName)).toEqual(["Rami", "Belle"]);
    expect(listed.data.cards[0]).toMatchObject({
      workerKind: "deepseek-direct",
      workspace: { mode: "git_worktree" },
      sourceOfTruth: "agent-fabric.queue"
    });

    const opened = daemon.callTool(
      "fabric_open_agent",
      { queueId, agent: listed.data.cards[0].handle },
      contextFor(session, "codex-open")
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("open failed");
    expect(opened.data.card.handle).toBe(listed.data.cards[0].handle);
    expect(opened.data.detail.task.queueTaskId).toBeTruthy();

    const messaged = daemon.callTool(
      "fabric_message_agent",
      { queueId, agent: listed.data.cards[0].handle, body: "Please revise the patch scope.", kind: "revision" },
      contextFor(session, "codex-message")
    );
    expect(messaged.ok).toBe(true);
    if (!messaged.ok) throw new Error("message failed");
    expect(messaged.data).toMatchObject({ deliveredTo: listed.data.cards[0].handle, mode: "send" });

    const update = daemon.callTool(
      "project_queue_update_task",
      {
        queueId,
        queueTaskId: tasks[0].queueTaskId,
        status: "patch_ready",
        summary: "Patch is ready.",
        patchRefs: ["worker.patch"],
        testRefs: ["npm test"]
      },
      contextFor(session, "codex-patch-ready")
    );
    expect(update.ok).toBe(true);

    const blockedAcceptance = daemon.callTool(
      "fabric_accept_patch",
      { queueId, queueTaskId: tasks[0].queueTaskId, summary: "Accepted from Codex worker card." },
      contextFor(session, "codex-accept")
    );
    expect(blockedAcceptance.ok).toBe(false);
    if (blockedAcceptance.ok) throw new Error("accept unexpectedly succeeded without review");
    expect(blockedAcceptance.code).toBe("PATCH_REVIEW_REQUIRED");

    const accepted = daemon.callTool(
      "fabric_accept_patch",
      {
        queueId,
        queueTaskId: tasks[0].queueTaskId,
        reviewedBy: "Codex senior",
        reviewSummary: "Patch refs and test refs were reviewed."
      },
      contextFor(session, "codex-accept-reviewed")
    );
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error("accept failed");
    expect(accepted.data.acceptedTask).toMatchObject({ queueTaskId: tasks[0].queueTaskId, status: "accepted" });
    expect(accepted.data.review).toMatchObject({ reviewedBy: "Codex senior" });
    daemon.close();
  });
});

function createQueue(daemon: FabricDaemon, session: { sessionId: string; sessionToken: string }, idempotencyKey: string, maxParallelAgents: number): string {
  const created = daemon.callTool(
    "project_queue_create",
    {
      projectPath: "/tmp/workspace/app",
      prompt: "Build worker bridge.",
      title: "Worker bridge",
      pipelineProfile: "careful",
      maxParallelAgents
    },
    contextFor(session, idempotencyKey)
  );
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("queue create failed");
  return created.data.queueId;
}

function addReadyTasks(
  daemon: FabricDaemon,
  session: { sessionId: string; sessionToken: string },
  queueId: string,
  count: number
): Array<{ queueTaskId: string; fabricTaskId: string }> {
  const added = daemon.callTool(
    "project_queue_add_tasks",
    {
      queueId,
      tasks: Array.from({ length: count }, (_, index) => ({
        title: `Task ${index + 1}`,
        goal: `Implement independent slice ${index + 1}.`,
        category: "implementation",
        priority: "normal",
        parallelSafe: true,
        risk: "low"
      }))
    },
    contextFor(session, `tasks-${count}`)
  );
  expect(added.ok).toBe(true);
  if (!added.ok) throw new Error("add tasks failed");
  return added.data.created.map((task: { queueTaskId: string; fabricTaskId: string }) => ({
    queueTaskId: task.queueTaskId,
    fabricTaskId: task.fabricTaskId
  }));
}

function startExecution(daemon: FabricDaemon, session: { sessionId: string; sessionToken: string }, queueId: string, idempotencyKey: string): void {
  const started = daemon.callTool(
    "project_queue_decide",
    { queueId, decision: "start_execution", note: "Open execution for Codex bridge tests." },
    contextFor(session, idempotencyKey)
  );
  expect(started.ok).toBe(true);
}

function registerPayload(): BridgeRegister {
  return {
    bridgeVersion: "0.1.0",
    agent: { id: "codex-test", displayName: "Codex Test" },
    host: { name: "vitest", transport: "simulator" },
    workspace: { root: "/tmp/workspace", source: "test" },
    capabilities: {
      roots: true,
      notifications: true,
      notificationsVisibleToAgent: { declared: "yes", observed: "yes" },
      sampling: false,
      streamableHttp: false,
      litellmRouteable: true,
      outcomeReporting: "explicit"
    },
    budget: { canSeeCost: true, canApproveSpend: false },
    notificationSelfTest: { observed: "yes", detail: "simulator" },
    testMode: true
  };
}

function contextFor(session: { sessionId: string; sessionToken: string }, idempotencyKey = "read") {
  return { sessionId: session.sessionId, sessionToken: session.sessionToken, idempotencyKey };
}
