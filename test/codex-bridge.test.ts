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

  it("plans explicit 20-lane DeepSeek requests without hitting the old 16-lane cap", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const queueId = createQueue(daemon, session, "twenty-create", 20);
    addReadyTasks(daemon, session, queueId, 20);
    startExecution(daemon, session, queueId, "twenty-start");

    const result = daemon.callTool(
      "fabric_spawn_agents",
      { queueId, count: 20, worker: "deepseek-direct", workspaceMode: "git_worktree", planOnly: true },
      contextFor(session, "twenty-spawn")
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("spawn failed");
    expect(result.data).toMatchObject({ status: "planned", requested: 20, started: 0, planned: 20, queued: 0 });
    expect(result.data.cards).toHaveLength(20);
    daemon.close();
  });

  it("plans bridge cards without fake runners, then opens a real runner-backed @af worker", () => {
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
    expect(spawned.data).toMatchObject({ status: "runner_required", requested: 2, started: 0, planned: 2, queued: 0 });
    expect(spawned.data.cards[0]).toMatchObject({
      rawStatus: "planned",
      runnerProcessState: "planned",
      workerKind: "deepseek-direct"
    });

    const claim = daemon.callTool(
      "project_queue_claim_next",
      {
        queueId,
        worker: "deepseek-direct",
        workspaceMode: "git_worktree",
        modelProfile: "deepseek-v4-pro:max",
        metadata: { source: "test-runner" }
      },
      contextFor(session, "codex-claim-real-runner")
    );
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error("claim failed");
    const claimed = claim.data.claimed as { fabricTaskId: string; queueTaskId: string };
    const workerRun = claim.data.workerRun as { workerRunId: string };
    const spawnedEvent = daemon.callTool(
      "fabric_task_event",
      {
        taskId: claimed.fabricTaskId,
        workerRunId: workerRun.workerRunId,
        kind: "command_spawned",
        body: "agent-fabric-deepseek-worker run-task",
        metadata: { pid: 12345, taskPacketPath: "/tmp/task.json", contextFilePath: "/tmp/task.context.md" }
      },
      contextFor(session, "codex-command-spawned")
    );
    expect(spawnedEvent.ok).toBe(true);
    const startedEvent = daemon.callTool(
      "fabric_task_event",
      {
        taskId: claimed.fabricTaskId,
        workerRunId: workerRun.workerRunId,
        kind: "command_started",
        body: "agent-fabric-deepseek-worker run-task",
        metadata: { taskPacketPath: "/tmp/task.json", contextFilePath: "/tmp/task.context.md" }
      },
      contextFor(session, "codex-command-started")
    );
    expect(startedEvent.ok).toBe(true);

    const listed = daemon.callTool("fabric_list_agents", { queueId, includeCompleted: true }, contextFor(session));
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error("list failed");
    expect(listed.data.cards).toHaveLength(1);
    expect(listed.data.cards[0].handle).toMatch(/^@af\//);
    expect(listed.data.cards[0]).toMatchObject({
      workerKind: "deepseek-direct",
      runnerProcessState: "running",
      pid: 12345,
      taskPacketPath: "/tmp/task.json",
      contextFilePath: "/tmp/task.context.md",
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
