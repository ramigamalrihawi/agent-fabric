import { describe, expect, it } from "vitest";
import { FabricDaemon } from "../src/daemon.js";
import type { BridgeRegister } from "../src/types.js";

describe("worker/task substrate", () => {
  it("creates a durable task and returns status", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());

    const created = daemon.callTool(
      "fabric_task_create",
      {
        title: "Add approval panel",
        goal: "Build a VS Code approval panel for pending LLM approvals.",
        projectPath: "/tmp/workspace",
        priority: "high",
        refs: ["docs/vision-status-and-roadmap.md"],
        requestedBy: "user"
      },
      contextFor(session, "task-create")
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("task create failed");

    const status = daemon.callTool("fabric_task_status", { taskId: created.data.taskId }, contextFor(session));
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error("task status failed");
    expect(status.data).toMatchObject({
      taskId: created.data.taskId,
      status: "created",
      title: "Add approval panel",
      goal: "Build a VS Code approval panel for pending LLM approvals.",
      projectPath: "/tmp/workspace",
      priority: "high",
      requestedBy: "user",
      workerRuns: []
    });
    daemon.close();
  });

  it("records worker run, event, checkpoint, resume, and finish lifecycle", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createTask(daemon, session, "task-lifecycle-create");
    if (!created.ok) throw new Error("task create failed");

    const started = daemon.callTool(
      "fabric_task_start_worker",
      {
        taskId: created.data.taskId,
        worker: "local-cli",
        projectPath: "/tmp/workspace",
        workspaceMode: "git_worktree",
        workspacePath: "/tmp/workspace-task",
        modelProfile: "deepseek-api",
        contextPolicy: "lean",
        command: ["local-cli", "run"],
        metadata: { taskPacketPath: "/tmp/packet.json" }
      },
      contextFor(session, "task-start")
    );
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("worker start failed");
    expect(started.data).toMatchObject({ taskId: created.data.taskId, status: "running", workspacePath: "/tmp/workspace-task" });

    daemon.db.db.prepare("UPDATE worker_runs SET ts_updated = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", started.data.workerRunId);
    const heartbeat = daemon.callTool(
      "fabric_task_heartbeat",
      {
        taskId: created.data.taskId,
        workerRunId: started.data.workerRunId,
        task: "Editing approval panel",
        progress: 0.25,
        metadata: { phase: "edit" }
      },
      contextFor(session, "task-heartbeat")
    );
    expect(heartbeat.ok).toBe(true);
    if (!heartbeat.ok) throw new Error("heartbeat failed");
    expect(heartbeat.data).toMatchObject({ taskId: created.data.taskId, workerRunId: started.data.workerRunId, status: "running", ack: true });
    const afterHeartbeat = daemon.callTool("fabric_task_status", { taskId: created.data.taskId }, contextFor(session));
    expect(afterHeartbeat.ok).toBe(true);
    if (!afterHeartbeat.ok) throw new Error("status after heartbeat failed");
    expect(afterHeartbeat.data.workerRuns[0].updatedAt).not.toBe("2000-01-01T00:00:00.000Z");

    const event = daemon.callTool(
      "fabric_task_event",
      {
        taskId: created.data.taskId,
        workerRunId: started.data.workerRunId,
        kind: "patch_ready",
        body: "Patch is ready for review.",
        refs: ["src/foo.ts"],
        metadata: { changedFiles: 1 },
        costUsd: 0.05
      },
      contextFor(session, "task-event")
    );
    expect(event.ok).toBe(true);

    daemon.db.db.prepare("UPDATE worker_runs SET ts_updated = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", started.data.workerRunId);
    const checkpoint = daemon.callTool(
      "fabric_task_checkpoint",
      {
        taskId: created.data.taskId,
        workerRunId: started.data.workerRunId,
        summary: {
          currentGoal: "Finish approval panel",
          filesTouched: ["src/foo.ts"],
          commandsRun: ["npm test"],
          testsRun: ["npm test"],
          decisions: ["Use MCP polling first"],
          assumptions: [],
          blockers: [],
          nextAction: "Review patch"
        }
      },
      contextFor(session, "task-checkpoint")
    );
    expect(checkpoint.ok).toBe(true);
    const afterCheckpoint = daemon.callTool("fabric_task_status", { taskId: created.data.taskId }, contextFor(session));
    expect(afterCheckpoint.ok).toBe(true);
    if (!afterCheckpoint.ok) throw new Error("status after checkpoint failed");
    expect(afterCheckpoint.data.workerRuns[0].updatedAt).not.toBe("2000-01-01T00:00:00.000Z");

    const withDetails = daemon.callTool(
      "fabric_task_status",
      { taskId: created.data.taskId, includeEvents: true, includeCheckpoints: true },
      contextFor(session)
    );
    expect(withDetails.ok).toBe(true);
    if (!withDetails.ok) throw new Error("detailed status failed");
    expect(withDetails.data.status).toBe("patch_ready");
    expect(withDetails.data.workerRuns[0]).toMatchObject({
      worker: "local-cli",
      status: "patch_ready",
      workspaceMode: "git_worktree",
      workspacePath: "/tmp/workspace-task",
      metadata: { taskPacketPath: "/tmp/packet.json" }
    });
    expect(withDetails.data.events).toHaveLength(1);
    expect(withDetails.data.checkpoints).toHaveLength(1);

    const resume = daemon.callTool("fabric_task_resume", { taskId: created.data.taskId, preferredWorker: "local-cli" }, contextFor(session));
    expect(resume.ok).toBe(true);
    if (!resume.ok) throw new Error("resume failed");
    expect(resume.data.resumePrompt).toContain("Next action: Review patch");
    expect(resume.data).toMatchObject({ workspacePath: "/tmp/workspace-task", modelProfile: "deepseek-api", contextPolicy: "lean" });

    const finished = daemon.callTool(
      "fabric_task_finish",
      {
        taskId: created.data.taskId,
        workerRunId: started.data.workerRunId,
        status: "completed",
        summary: "Patch reviewed and accepted.",
        patchRefs: ["patch:approval-panel"],
        testRefs: ["npm test"],
        followups: ["Wire VS Code client UI"]
      },
      contextFor(session, "task-finish")
    );
    expect(finished.ok).toBe(true);
    if (!finished.ok) throw new Error("finish failed");
    expect(finished.data).toEqual({ taskId: created.data.taskId, status: "completed" });

    const finalStatus = daemon.callTool("fabric_task_status", { taskId: created.data.taskId }, contextFor(session));
    expect(finalStatus.ok).toBe(true);
    if (!finalStatus.ok) throw new Error("final status failed");
    expect(finalStatus.data).toMatchObject({
      status: "completed",
      summary: "Patch reviewed and accepted.",
      followups: ["Wire VS Code client UI"]
    });

    const eventAfterFinish = daemon.callTool(
      "fabric_task_event",
      {
        taskId: created.data.taskId,
        workerRunId: started.data.workerRunId,
        kind: "checkpoint",
        body: "Late runner cleanup checkpoint."
      },
      contextFor(session, "task-event-final")
    );
    expect(eventAfterFinish.ok).toBe(true);
    const afterFinalEvent = daemon.callTool("fabric_task_status", { taskId: created.data.taskId }, contextFor(session));
    expect(afterFinalEvent.ok).toBe(true);
    if (!afterFinalEvent.ok) throw new Error("status after final event failed");
    expect(afterFinalEvent.data.status).toBe("completed");
    expect(afterFinalEvent.data.workerRuns[0].status).toBe("completed");

    const failedEventAfterFinish = daemon.callTool(
      "fabric_task_event",
      {
        taskId: created.data.taskId,
        workerRunId: started.data.workerRunId,
        kind: "failed",
        body: "Late failure from cleanup path."
      },
      contextFor(session, "task-event-final-failed")
    );
    expect(failedEventAfterFinish.ok).toBe(true);
    const afterLateFailure = daemon.callTool("fabric_task_status", { taskId: created.data.taskId }, contextFor(session));
    expect(afterLateFailure.ok).toBe(true);
    if (!afterLateFailure.ok) throw new Error("status after late failure failed");
    expect(afterLateFailure.data.status).toBe("completed");
    expect(afterLateFailure.data.workerRuns[0].status).toBe("completed");

    const heartbeatAfterFinish = daemon.callTool(
      "fabric_task_heartbeat",
      { taskId: created.data.taskId, workerRunId: started.data.workerRunId, task: "Should not be accepted" },
      contextFor(session, "task-heartbeat-final")
    );
    expect(heartbeatAfterFinish.ok).toBe(false);
    if (heartbeatAfterFinish.ok) throw new Error("final heartbeat unexpectedly accepted");
    expect(heartbeatAfterFinish.code).toBe("FABRIC_WORKER_RUN_FINAL");
    daemon.close();
  });

  it("replays idempotent task creation without duplicating tasks", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const input = {
      title: "Same task",
      goal: "Create once.",
      projectPath: "/tmp/workspace"
    };

    const first = daemon.callTool("fabric_task_create", input, contextFor(session, "task-idem"));
    const replay = daemon.callTool("fabric_task_create", input, contextFor(session, "task-idem"));

    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    if (!first.ok || !replay.ok) throw new Error("task creation failed");
    expect(replay.data.taskId).toBe(first.data.taskId);
    expect(tableCount(daemon, "tasks")).toBe(1);
    daemon.close();
  });

  it("rejects worker start for missing tasks", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());

    const result = daemon.callTool(
      "fabric_task_start_worker",
      {
        taskId: "task_missing",
        worker: "openhands",
        projectPath: "/tmp/workspace",
        workspaceMode: "git_worktree",
        modelProfile: "deepseek-api"
      },
      contextFor(session, "task-missing")
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("missing task unexpectedly started");
    expect(result.code).toBe("FABRIC_TASK_NOT_FOUND");
    daemon.close();
  });

  it("accepts smolagents as a lightweight worker type", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createTask(daemon, session, "task-smolagents-create");
    if (!created.ok) throw new Error("task create failed");

    const started = daemon.callTool(
      "fabric_task_start_worker",
      {
        taskId: created.data.taskId,
        worker: "smolagents",
        projectPath: "/tmp/workspace",
        workspaceMode: "in_place",
        modelProfile: "research.cheap",
        contextPolicy: "read_only_project_mining",
        command: ["uv", "run", "agent-fabric-smolagents-worker", "run-project-mining"],
        metadata: { permissionTier: "read_only" }
      },
      contextFor(session, "task-smolagents-start")
    );

    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("smolagents worker start failed");
    expect(started.data).toMatchObject({ taskId: created.data.taskId, status: "running", workspacePath: "/tmp/workspace" });

    const resume = daemon.callTool("fabric_task_resume", { taskId: created.data.taskId, preferredWorker: "smolagents" }, contextFor(session));
    expect(resume.ok).toBe(true);
    if (!resume.ok) throw new Error("smolagents resume failed");
    expect(resume.data).toMatchObject({ workspacePath: "/tmp/workspace", modelProfile: "research.cheap", contextPolicy: "read_only_project_mining" });
    daemon.close();
  });

  it("accepts codex-app-server as a queue-visible worker type", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createTask(daemon, session, "task-codex-app-server-create");
    if (!created.ok) throw new Error("task create failed");

    const started = daemon.callTool(
      "fabric_task_start_worker",
      {
        taskId: created.data.taskId,
        worker: "codex-app-server",
        projectPath: "/tmp/workspace",
        workspaceMode: "git_worktree",
        workspacePath: "/tmp/worktrees/codex-app-server",
        modelProfile: "codex.app-server",
        contextPolicy: "workflow:linear",
        command: ["codex", "app-server", "run", "--fabric-task", created.data.taskId],
        metadata: { runner: "elixir-orchestrator" }
      },
      contextFor(session, "task-codex-app-server-start")
    );

    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("codex-app-server worker start failed");
    expect(started.data).toMatchObject({ taskId: created.data.taskId, status: "running", workspacePath: "/tmp/worktrees/codex-app-server" });

    const resume = daemon.callTool("fabric_task_resume", { taskId: created.data.taskId, preferredWorker: "codex-app-server" }, contextFor(session));
    expect(resume.ok).toBe(true);
    if (!resume.ok) throw new Error("codex-app-server resume failed");
    expect(resume.data).toMatchObject({ workspacePath: "/tmp/worktrees/codex-app-server", modelProfile: "codex.app-server", contextPolicy: "workflow:linear" });
    daemon.close();
  });
});

function createTask(daemon: FabricDaemon, session: { sessionId: string; sessionToken: string }, idempotencyKey: string) {
  return daemon.callTool(
    "fabric_task_create",
    {
      title: "Implement task lifecycle",
      goal: "Exercise worker task state.",
      projectPath: "/tmp/workspace",
      priority: "normal"
    },
    contextFor(session, idempotencyKey)
  );
}

function registerPayload(): BridgeRegister {
  return {
    bridgeVersion: "0.1.0",
    agent: { id: "worker-test", displayName: "Worker Test", vendor: "test" },
    host: { name: "Worker Test Host", transport: "simulator" },
    workspace: { root: "/tmp/workspace", source: "explicit" },
    capabilities: {
      roots: true,
      notifications: true,
      notificationsVisibleToAgent: { declared: "yes", observed: "yes" },
      sampling: false,
      streamableHttp: false,
      litellmRouteable: true,
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
