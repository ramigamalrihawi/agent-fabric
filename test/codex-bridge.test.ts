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

  it("supports high-scale card pagination, grouping, manager summaries, and cost role attribution", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const queueId = createQueue(daemon, session, "hundred-create", 100);
    const tasks = addReadyTasks(daemon, session, queueId, 100, (index) => ({
      managerId: index < 50 ? "manager-a" : "manager-b",
      workstream: index % 2 === 0 ? "frontend" : "backend"
    }));
    startExecution(daemon, session, queueId, "hundred-start");

    const planned = daemon.callTool(
      "fabric_spawn_agents",
      { queueId, count: 100, worker: "deepseek-direct", workspaceMode: "git_worktree", planOnly: true },
      contextFor(session, "hundred-plan")
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error("spawn failed");
    expect(planned.data).toMatchObject({ status: "planned", requested: 100, planned: 100, queued: 0 });

    for (let index = 0; index < tasks.length; index += 1) {
      const claim = daemon.callTool(
        "project_queue_claim_next",
        {
          queueId,
          worker: "deepseek-direct",
          workspaceMode: "git_worktree",
          modelProfile: "deepseek-v4-pro:max",
          metadata: { costRole: "worker", codexBridge: { managerId: "manager-a" } }
        },
        contextFor(session, `hundred-claim-${index}`)
      );
      expect(claim.ok).toBe(true);
      if (!claim.ok) throw new Error("claim failed");
      const claimed = claim.data.claimed as { fabricTaskId: string };
      const workerRun = claim.data.workerRun as { workerRunId: string };
      const event = daemon.callTool(
        "fabric_task_event",
        {
          taskId: claimed.fabricTaskId,
          workerRunId: workerRun.workerRunId,
          kind: "command_started",
          body: `worker ${index + 1} started`,
          costUsd: index === 0 ? 0.01 : undefined
        },
        contextFor(session, `hundred-event-${index}`)
      );
      expect(event.ok).toBe(true);
    }

    const page = daemon.callTool(
      "fabric_list_agents",
      { queueId, includeCompleted: true, page: 2, pageSize: 25, groupBy: "status", maxEventsPerLane: 1 },
      contextFor(session, "hundred-list")
    );
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error("list failed");
    expect(page.data).toMatchObject({
      count: 100,
      returnedCount: 25,
      pagination: { page: 2, pageSize: 25, total: 100, pageCount: 4, hasNextPage: true, hasPreviousPage: true }
    });
    expect(page.data.cards).toHaveLength(25);
    expect(page.data.groups[0]).toMatchObject({ key: "running", count: 100, omitted: 75 });
    expect(page.data.cards[0].orchestration).toMatchObject({ risk: "low", category: "implementation" });

    const progress = daemon.callTool(
      "project_queue_progress_report",
      { queueId, maxEventsPerLane: 1, managerSummaryLimit: 3 },
      contextFor(session, "hundred-progress")
    );
    expect(progress.ok).toBe(true);
    if (!progress.ok) throw new Error("progress failed");
    expect(progress.data.managerSummary).toMatchObject({
      bounded: true,
      maxItemsPerSection: 3,
      totals: { tasks: 100, lanes: 100 }
    });
    expect(progress.data.managerSummary.groups.byStatus[0]).toMatchObject({ key: "running", count: 100 });
    expect(progress.data.managerSummary.groups.byStatus[0].items).toMatchObject({ count: 100, omitted: 97 });
    expect(progress.data.managerSummary.groups.byManager).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "manager-a", count: 50 }), expect.objectContaining({ key: "manager-b", count: 50 })])
    );
    expect(progress.data.summary.cost.byRole.worker).toMatchObject({ count: 1, costUsd: 0.01 });
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

    const asked = daemon.callTool(
      "fabric_message_agent",
      { queueId, agent: listed.data.cards[0].handle, body: "Please confirm the verification scope.", kind: "review", ask: true },
      contextFor(session, "codex-message-ask")
    );
    expect(asked.ok).toBe(true);
    if (!asked.ok) throw new Error("ask failed");

    const collabSummary = daemon.callTool("project_queue_collab_summary", { queueId }, contextFor(session, "codex-message-summary"));
    expect(collabSummary.ok).toBe(true);
    if (!collabSummary.ok) throw new Error("collab summary failed");
    const collabGroups = collabSummary.data.groups as Array<Record<string, unknown>>;
    const workerGroup = collabGroups.find((group) => {
      const queueTask = group.queueTask as Record<string, unknown> | undefined;
      return String(queueTask?.queueTaskId) === claimed.queueTaskId;
    });
    expect(workerGroup).toBeDefined();
    expect(workerGroup?.openAsks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          question: "Please confirm the verification scope.",
          refs: expect.arrayContaining([`project_queue:${queueId}`, `project_queue_task:${claimed.queueTaskId}`])
        })
      ])
    );

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

describe("Bridge ergonomics: compact status, verbose, deduped warnings, and starter kit", () => {
  it("fabric_status returns compact by default: no sessions, no runtime, warnings deduped", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    for (let i = 0; i < 3; i += 1) {
      daemon.registerBridge(registerPayload());
    }

    const result = daemon.callTool("fabric_status", {}, contextFor(session));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("status failed");

    // Default compact: no sessions
    expect(result.data.bridgeSessions.sessions).toHaveLength(0);
    expect(result.data.bridgeSessions.active).toBe(4);

    // Runtime omitted when sessions not included
    expect(result.data.daemon.runtime).toBeUndefined();

    // Warnings deduped by default. All sessions use registerPayload which has
    // observed="yes", so no notification warnings will appear; we assert
    // there are no duplicates of any warning.
    const uniqueWarnings = new Set(result.data.warnings as string[]);
    expect(uniqueWarnings.size).toBe((result.data.warnings as string[]).length);

    daemon.close();
  });

  it("fabric_status with includeSessions: true returns sessions and runtime", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload({ agentId: "test-1" }));

    const result = daemon.callTool("fabric_status", { includeSessions: true }, contextFor(session));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("status failed");

    expect(result.data.bridgeSessions.sessions).toHaveLength(1);
    expect(result.data.bridgeSessions.returned).toBe(1);
    expect(result.data.daemon.runtime).toBeDefined();
    expect(result.data.daemon.runtime.pid).toBe(process.pid);

    daemon.close();
  });

  it("fabric_starter_kit returns essential tool list", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());

    const result = daemon.callTool("fabric_starter_kit", {}, contextFor(session));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("starter_kit failed");

    expect(result.data.kit).toBe("agent-fabric");
    expect(result.data.essentialTools).toBeInstanceOf(Array);
    expect(result.data.essentialTools.length).toBeGreaterThan(10);

    for (const tool of result.data.essentialTools) {
      expect(tool).toHaveProperty("tool");
      expect(tool).toHaveProperty("description");
      expect(tool).toHaveProperty("readOnly");
      expect(tool).toHaveProperty("guidance");
    }

    // Check key tools are present
    const toolNames = result.data.essentialTools.map((t: { tool: string }) => t.tool);
    expect(toolNames).toContain("fabric_status");
    expect(toolNames).toContain("fabric_senior_start");
    expect(toolNames).toContain("fabric_list_agents");
    expect(toolNames).toContain("fabric_spawn_agents");
    expect(toolNames).toContain("project_queue_create");
    expect(toolNames).toContain("project_queue_progress_report");
    expect(toolNames).toContain("collab_send");

    // verify read-only flags for specific tools
    const statusTool = result.data.essentialTools.find((t: { tool: string }) => t.tool === "fabric_status");
    expect(statusTool.readOnly).toBe(true);
    const spawnTool = result.data.essentialTools.find((t: { tool: string }) => t.tool === "fabric_spawn_agents");
    expect(spawnTool.readOnly).toBe(false);

    daemon.close();
  });
});

describe("Cost visibility: per-task, per-lane, per-card, and coverage warnings", () => {

  it("propagates source-labeled cost fields through task detail, lane cards, progress reports, and Codex-style bridge cards", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const queueId = createQueue(daemon, session, "cost-vis-create", 4);
    const tasks = addReadyTasks(daemon, session, queueId, 2);
    startExecution(daemon, session, queueId, "cost-vis-start");

    // Claim two tasks with different cost-role metadata
    const claimA = daemon.callTool(
      "project_queue_claim_next",
      {
        queueId,
        worker: "deepseek-direct",
        workspaceMode: "git_worktree",
        modelProfile: "deepseek-v4-pro:max",
        metadata: { costRole: "worker" }
      },
      contextFor(session, "cost-vis-claim-a")
    );
    expect(claimA.ok).toBe(true);
    if (!claimA.ok) throw new Error("claim a failed");
    const runA = claimA.data.workerRun as { workerRunId: string };
    const claimedA = claimA.data.claimed as { fabricTaskId: string; queueTaskId: string };

    const claimB = daemon.callTool(
      "project_queue_claim_next",
      {
        queueId,
        worker: "jcode-deepseek",
        workspaceMode: "git_worktree",
        modelProfile: "deepseek-v4-pro:max",
        metadata: { costRole: "manager" }
      },
      contextFor(session, "cost-vis-claim-b")
    );
    expect(claimB.ok).toBe(true);
    if (!claimB.ok) throw new Error("claim b failed");
    const runB = claimB.data.workerRun as { workerRunId: string };
    const claimedB = claimB.data.claimed as { fabricTaskId: string; queueTaskId: string };

    // Record cost-attributed events on task A
    daemon.callTool("fabric_task_event", {
      taskId: claimedA.fabricTaskId,
      workerRunId: runA.workerRunId,
      kind: "command_started",
      body: "task a started",
      costUsd: 0.015
    }, contextFor(session, "cost-vis-event-a1"));
    daemon.callTool("fabric_task_event", {
      taskId: claimedA.fabricTaskId,
      workerRunId: runA.workerRunId,
      kind: "file_changed",
      body: "task a edited src/app.ts",
      costUsd: 0.003
    }, contextFor(session, "cost-vis-event-a2"));

    // Record an event on task B without cost data
    daemon.callTool("fabric_task_event", {
      taskId: claimedB.fabricTaskId,
      workerRunId: runB.workerRunId,
      kind: "command_started",
      body: "task b started without cost"
    }, contextFor(session, "cost-vis-event-b1"));

    // Verify per-task cost via task detail
    const detailA = daemon.callTool(
      "project_queue_task_detail",
      { queueId, queueTaskId: claimedA.queueTaskId, includeResume: false, maxEventsPerRun: 5 },
      contextFor(session, "cost-vis-detail-a")
    );
    expect(detailA.ok).toBe(true);
    if (!detailA.ok) throw new Error("detail a failed");
    expect(detailA.data.cost).toMatchObject({
      sourceLabel: "worker_event",
      totalCostUsd: 0.018,
      eventCount: 2,
      eventsWithCost: 2,
      coverageWarning: null
    });
    expect(detailA.data.cost.byRole.worker).toMatchObject({ count: 2, costUsd: 0.018 });

    // Verify coverage warning on task B
    const detailB = daemon.callTool(
      "project_queue_task_detail",
      { queueId, queueTaskId: claimedB.queueTaskId, includeResume: false, maxEventsPerRun: 5 },
      contextFor(session, "cost-vis-detail-b")
    );
    expect(detailB.ok).toBe(true);
    if (!detailB.ok) throw new Error("detail b failed");
    expect(detailB.data.cost.sourceLabel).toBe("none");
    expect(detailB.data.cost.coverageWarning).toContain("worker_cost_missing");

    // Verify lanes include cost data
    const lanes = daemon.callTool(
      "project_queue_agent_lanes",
      { queueId, includeCompleted: false, maxEventsPerLane: 5 },
      contextFor(session, "cost-vis-lanes")
    );
    expect(lanes.ok).toBe(true);
    if (!lanes.ok) throw new Error("lanes failed");
    expect(lanes.data.count).toBe(2);
    const laneA = lanes.data.lanes.find((l: Record<string, unknown>) => l.laneId === runA.workerRunId);
    expect(laneA.cost).toMatchObject({ sourceLabel: "worker_event", totalCostUsd: 0.018, coverageWarning: null });
    const laneB = lanes.data.lanes.find((l: Record<string, unknown>) => l.laneId === runB.workerRunId);
    expect(laneB.cost.coverageWarning).toContain("worker_cost_missing");

    // Verify Codex-style bridge cards include cost
    const cards = daemon.callTool(
      "fabric_list_agents",
      { queueId, includeCompleted: true, maxEventsPerLane: 5 },
      contextFor(session, "cost-vis-cards")
    );
    expect(cards.ok).toBe(true);
    if (!cards.ok) throw new Error("cards failed");
    expect(cards.data.count).toBe(2);
    const cardA = cards.data.cards.find((c: Record<string, unknown>) => c.agentId === runA.workerRunId);
    expect(cardA.cost).toMatchObject({ sourceLabel: "worker_event", totalCostUsd: 0.018 });
    const cardB = cards.data.cards.find((c: Record<string, unknown>) => c.agentId === runB.workerRunId);
    expect(cardB.cost.coverageWarning).toContain("worker_cost_missing");

    // Verify progress report includes taskCostCoverage
    const progress = daemon.callTool(
      "project_queue_progress_report",
      { queueId, maxEventsPerLane: 5, managerSummaryLimit: 10 },
      contextFor(session, "cost-vis-progress")
    );
    expect(progress.ok).toBe(true);
    if (!progress.ok) throw new Error("progress failed");
    expect(progress.data.taskCostCoverage).toMatchObject({
      sourceLabel: "worker_event_details",
      totalTasks: 2,
      tasksWithCost: 1,
      tasksWithWorkerRuns: 2,
      tasksWithoutCostEvents: 1
    });
    expect(progress.data.summary.cost.byRole.worker).toMatchObject({ count: 2, costUsd: 0.018 });

    daemon.close();
  });

  it("returns cost=none with coverage warning for planned cards with no worker runs", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const queueId = createQueue(daemon, session, "cost-vis-planned", 4);
    addReadyTasks(daemon, session, queueId, 2);
    startExecution(daemon, session, queueId, "cost-vis-planned-start");

    const planned = daemon.callTool(
      "fabric_spawn_agents",
      { queueId, count: 2, worker: "deepseek-direct", workspaceMode: "git_worktree", planOnly: true },
      contextFor(session, "cost-vis-planned-spawn")
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error("spawn failed");
    expect(planned.data.cards).toHaveLength(2);
    for (const card of planned.data.cards) {
      expect(card.cost).toMatchObject({
        sourceLabel: "none",
        totalCostUsd: 0,
        eventCount: 0,
        eventsWithCost: 0
      });
      expect(card.cost.coverageWarning).toContain("planned");
    }

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
  count: number,
  taskOverrides: (index: number) => Record<string, unknown> = () => ({})
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
	        risk: "low",
	        ...taskOverrides(index)
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

describe("project_queue_worker_health", () => {
  it("classifies a worker with no runner evidence as quiet", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const queueId = createQueue(daemon, session, "health-quiet-create", 4);
    const tasks = addReadyTasks(daemon, session, queueId, 1);
    startExecution(daemon, session, queueId, "health-quiet-start");

    const claim = daemon.callTool(
      "project_queue_claim_next",
      { queueId, worker: "deepseek-direct", workspaceMode: "git_worktree", modelProfile: "deepseek-v4-pro:max", metadata: { source: "test" } },
      contextFor(session, "health-quiet-claim")
    );
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error("claim failed");

    // No events recorded - should be "quiet" (no runner evidence)

    const health = daemon.callTool(
      "project_queue_worker_health",
      { queueId },
      contextFor(session, "health-quiet-check")
    );
    expect(health.ok).toBe(true);
    if (!health.ok) throw new Error("health failed");
    expect(health.data).toMatchObject({ schema: "agent-fabric.project-queue-worker-health.v1" });
    expect(health.data.summary).toMatchObject({ total: 1, quiet: 1, healthy: 0, stale: 0 });
    expect(health.data.workers).toHaveLength(1);
    expect(health.data.workers[0]).toMatchObject({
      classification: "quiet",
      healthLabel: "Quiet",
      evidence: expect.objectContaining({ processPresent: false, hasRunnerEvidence: false })
    });
    daemon.close();
  });

  it("classifies a worker with process evidence and recent heartbeat as healthy", () => {
    const now = new Date("2026-05-07T18:00:00.000Z");
    const daemon = new FabricDaemon({ dbPath: ":memory:", now: () => new Date(now) });
    const session = daemon.registerBridge(registerPayload());
    const queueId = createQueue(daemon, session, "health-healthy-create", 4);
    const tasks = addReadyTasks(daemon, session, queueId, 1);
    startExecution(daemon, session, queueId, "health-healthy-start");

    const claim = daemon.callTool(
      "project_queue_claim_next",
      { queueId, worker: "deepseek-direct", workspaceMode: "git_worktree", modelProfile: "deepseek-v4-pro:max", metadata: { source: "test" } },
      contextFor(session, "health-healthy-claim")
    );
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error("claim failed");
    const claimed = claim.data.claimed as { fabricTaskId: string };
    const workerRun = claim.data.workerRun as { workerRunId: string };

    // Record command_spawned with pid
    daemon.callTool(
      "fabric_task_event",
      { taskId: claimed.fabricTaskId, workerRunId: workerRun.workerRunId, kind: "command_spawned", body: "spawned", metadata: { pid: 12345 } },
      contextFor(session, "health-healthy-spawned")
    );
    // Record command_started
    daemon.callTool(
      "fabric_task_event",
      { taskId: claimed.fabricTaskId, workerRunId: workerRun.workerRunId, kind: "command_started", body: "started" },
      contextFor(session, "health-healthy-started")
    );

    const health = daemon.callTool(
      "project_queue_worker_health",
      { queueId },
      contextFor(session, "health-healthy-check")
    );
    expect(health.ok).toBe(true);
    if (!health.ok) throw new Error("health failed");
    expect(health.data.summary).toMatchObject({ total: 1, healthy: 1, quiet: 0, stale: 0 });
    expect(health.data.workers[0]).toMatchObject({
      classification: "healthy",
      healthLabel: "Running / healthy",
      evidence: expect.objectContaining({ processPresent: true, hasRunnerEvidence: true, pid: 12345 })
    });
    daemon.close();
  });

  it("classifies a worker with stale heartbeat as stale", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const queueId = createQueue(daemon, session, "health-stale-create", 4);
    const tasks = addReadyTasks(daemon, session, queueId, 1);
    startExecution(daemon, session, queueId, "health-stale-start");

    const claim = daemon.callTool(
      "project_queue_claim_next",
      { queueId, worker: "deepseek-direct", workspaceMode: "git_worktree", modelProfile: "deepseek-v4-pro:max", metadata: { source: "test" } },
      contextFor(session, "health-stale-claim")
    );
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error("claim failed");
    const claimed = claim.data.claimed as { fabricTaskId: string };
    const workerRun = claim.data.workerRun as { workerRunId: string };

    // Record runner evidence with a spawn event
    daemon.callTool(
      "fabric_task_event",
      { taskId: claimed.fabricTaskId, workerRunId: workerRun.workerRunId, kind: "command_spawned", body: "spawned", metadata: { pid: 12345 } },
      contextFor(session, "health-stale-spawned")
    );

    // Verify healthy first
    const health1 = daemon.callTool(
      "project_queue_worker_health",
      { queueId },
      contextFor(session, "health-stale-check-1")
    );
    expect(health1.ok).toBe(true);
    expect(health1.data.summary.healthy).toBe(1);

    // Artificially age the worker_run ts_updated past the 30-min default threshold
    daemon["db"].db
      .prepare("UPDATE worker_runs SET ts_updated = datetime('now', '-60 minutes') WHERE id = ?")
      .run(workerRun.workerRunId);

    const health2 = daemon.callTool(
      "project_queue_worker_health",
      { queueId },
      contextFor(session, "health-stale-check-2")
    );
    expect(health2.ok).toBe(true);
    if (!health2.ok) throw new Error("health2 failed");
    expect(health2.data.summary).toMatchObject({ total: 1, healthy: 0, stale: 1 });
    expect(health2.data.workers[0]).toMatchObject({
      classification: "stale",
      healthLabel: "Stale heartbeat",
      evidence: expect.objectContaining({ processPresent: true, hasRunnerEvidence: true })
    });
    expect(health2.data.nextActions[0]).toMatchObject({ severity: "warning" });
    daemon.close();
  });

  it("classifies a failed worker from task status and failure events", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const queueId = createQueue(daemon, session, "health-fail-create", 4);
    const tasks = addReadyTasks(daemon, session, queueId, 1);
    startExecution(daemon, session, queueId, "health-fail-start");

    const claim = daemon.callTool(
      "project_queue_claim_next",
      { queueId, worker: "deepseek-direct", workspaceMode: "git_worktree", modelProfile: "deepseek-v4-pro:max", metadata: { source: "test" } },
      contextFor(session, "health-fail-claim")
    );
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error("claim failed");
    const claimed = claim.data.claimed as { fabricTaskId: string };
    const workerRun = claim.data.workerRun as { workerRunId: string };

    // Record spawn evidence then a failed event
    daemon.callTool(
      "fabric_task_event",
      { taskId: claimed.fabricTaskId, workerRunId: workerRun.workerRunId, kind: "command_spawned", body: "spawned", metadata: { pid: 12345 } },
      contextFor(session, "health-fail-spawned")
    );
    daemon.callTool(
      "fabric_task_event",
      { taskId: claimed.fabricTaskId, workerRunId: workerRun.workerRunId, kind: "failed", body: "Out of memory" },
      contextFor(session, "health-fail-event")
    );

    const health = daemon.callTool(
      "project_queue_worker_health",
      { queueId },
      contextFor(session, "health-fail-check")
    );
    expect(health.ok).toBe(true);
    if (!health.ok) throw new Error("health failed");
    expect(health.data.summary).toMatchObject({ total: 1, failed: 1, healthy: 0 });
    expect(health.data.workers[0]).toMatchObject({
      classification: "failed",
      healthLabel: "Failed",
      reason: expect.stringContaining("Out of memory")
    });
    daemon.close();
  });

  it("classifies completed and patch-ready workers correctly", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const queueId = createQueue(daemon, session, "health-done-create", 4);
    const tasks = addReadyTasks(daemon, session, queueId, 2);
    startExecution(daemon, session, queueId, "health-done-start");

    // Task 1: claim, record evidence, mark patch_ready
    const claim1 = daemon.callTool(
      "project_queue_claim_next",
      { queueId, worker: "deepseek-direct", workspaceMode: "git_worktree", modelProfile: "deepseek-v4-pro:max", metadata: { source: "test" } },
      contextFor(session, "health-done-claim-1")
    );
    expect(claim1.ok).toBe(true);
    const c1 = claim1.data.claimed as { fabricTaskId: string; queueTaskId: string };
    const r1 = claim1.data.workerRun as { workerRunId: string };
    daemon.callTool("fabric_task_event",
      { taskId: c1.fabricTaskId, workerRunId: r1.workerRunId, kind: "command_spawned", body: "spawned", metadata: { pid: 1 } },
      contextFor(session, "health-done-ev-1"));
    daemon.callTool("project_queue_update_task",
      { queueId, queueTaskId: c1.queueTaskId, status: "patch_ready", summary: "Patch done", patchRefs: ["patch.diff"] },
      contextFor(session, "health-done-update-1"));

    // Task 2: claim, record evidence, mark completed
    const claim2 = daemon.callTool(
      "project_queue_claim_next",
      { queueId, worker: "jcode-deepseek", workspaceMode: "git_worktree", modelProfile: "deepseek-v4-pro:max", metadata: { source: "test" } },
      contextFor(session, "health-done-claim-2")
    );
    expect(claim2.ok).toBe(true);
    const c2 = claim2.data.claimed as { fabricTaskId: string; queueTaskId: string };
    const r2 = claim2.data.workerRun as { workerRunId: string };
    daemon.callTool("fabric_task_event",
      { taskId: c2.fabricTaskId, workerRunId: r2.workerRunId, kind: "command_spawned", body: "spawned", metadata: { pid: 2 } },
      contextFor(session, "health-done-ev-2"));
    daemon.callTool("project_queue_update_task",
      { queueId, queueTaskId: c2.queueTaskId, status: "completed", summary: "Done" },
      contextFor(session, "health-done-update-2"));

    const health = daemon.callTool(
      "project_queue_worker_health",
      { queueId },
      contextFor(session, "health-done-check")
    );
    expect(health.ok).toBe(true);
    if (!health.ok) throw new Error("health failed");
    expect(health.data.summary).toMatchObject({ total: 2, patchReady: 1, completed: 1 });
    const workers = health.data.workers as Array<Record<string, unknown>>;
    expect(workers.find((w) => w.classification === "patch_ready")?.evidence).toMatchObject(
      expect.objectContaining({ patchRefs: expect.arrayContaining(["patch.diff"]) })
    );
    expect(workers.find((w) => w.classification === "completed")?.healthLabel).toBe("Completed");
    daemon.close();
  });

  it("classifies queued/ready tasks with no worker runs as blocked", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const queueId = createQueue(daemon, session, "health-empty-create", 4);
    addReadyTasks(daemon, session, queueId, 3);
    startExecution(daemon, session, queueId, "health-empty-start");

    const health = daemon.callTool(
      "project_queue_worker_health",
      { queueId },
      contextFor(session, "health-empty-check")
    );
    expect(health.ok).toBe(true);
    if (!health.ok) throw new Error("health failed");
    expect(health.data.summary.total).toBe(3);
    expect(health.data.summary.blocked).toBe(3);
    expect(health.data.workers).toHaveLength(3);
    for (const w of health.data.workers as Array<Record<string, unknown>>) {
      expect(w.classification).toBe("blocked");
      expect(w.workerRunId).toBeUndefined();
    }
    daemon.close();
  });
});

describe("Log path visibility in bridge cards and worker health", () => {
  it("exposes stdoutLogPath and stderrLogPath from command_finished event metadata in bridge cards and worker health evidence", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const queueId = createQueue(daemon, session, "logpath-create", 4);
    const tasks = addReadyTasks(daemon, session, queueId, 1);
    startExecution(daemon, session, queueId, "logpath-start");

    const claim = daemon.callTool(
      "project_queue_claim_next",
      {
        queueId,
        worker: "deepseek-direct",
        workspaceMode: "git_worktree",
        modelProfile: "deepseek-v4-pro:max",
        metadata: { source: "test-runner" }
      },
      contextFor(session, "logpath-claim")
    );
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error("claim failed");
    const claimed = claim.data.claimed as { fabricTaskId: string; queueTaskId: string };
    const workerRun = claim.data.workerRun as { workerRunId: string };

    // Record command_spawned
    daemon.callTool(
      "fabric_task_event",
      {
        taskId: claimed.fabricTaskId,
        workerRunId: workerRun.workerRunId,
        kind: "command_spawned",
        body: "spawned",
        metadata: { pid: 12345 }
      },
      contextFor(session, "logpath-spawned")
    );

    // Record command_started
    daemon.callTool(
      "fabric_task_event",
      {
        taskId: claimed.fabricTaskId,
        workerRunId: workerRun.workerRunId,
        kind: "command_started",
        body: "echo test",
        metadata: { cwd: "/tmp/workspace" }
      },
      contextFor(session, "logpath-started")
    );

    // Record command_finished with log paths
    const stdoutLogPath = "/tmp/workspace/.agent-fabric/logs/task-1-run-1-stdout.log";
    const stderrLogPath = "/tmp/workspace/.agent-fabric/logs/task-1-run-1-stderr.log";
    daemon.callTool(
      "fabric_task_event",
      {
        taskId: claimed.fabricTaskId,
        workerRunId: workerRun.workerRunId,
        kind: "command_finished",
        body: "test output",
        metadata: {
          cwd: "/tmp/workspace",
          command: "echo test",
          exitCode: 0,
          durationMs: 100,
          stdoutTail: "test output",
          stderrTail: "",
          stdoutLogPath,
          stderrLogPath
        }
      },
      contextFor(session, "logpath-finished")
    );

    // Bridge cards should include log paths
    const cards = daemon.callTool(
      "fabric_list_agents",
      { queueId, includeCompleted: true, maxEventsPerLane: 5 },
      contextFor(session, "logpath-cards")
    );
    expect(cards.ok).toBe(true);
    if (!cards.ok) throw new Error("cards failed");
    expect(cards.data.cards).toHaveLength(1);
    expect(cards.data.cards[0].stdoutLogPath).toBe(stdoutLogPath);
    expect(cards.data.cards[0].stderrLogPath).toBe(stderrLogPath);

    // Worker health should include log paths in evidence
    const health = daemon.callTool(
      "project_queue_worker_health",
      { queueId },
      contextFor(session, "logpath-health")
    );
    expect(health.ok).toBe(true);
    if (!health.ok) throw new Error("health failed");
    expect(health.data.workers).toHaveLength(1);
    expect(health.data.workers[0].evidence).toMatchObject({
      stdoutLogPath,
      stderrLogPath
    });

    daemon.close();
  });

  it("returns undefined log paths for planned cards and workers with no command_finished event", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const queueId = createQueue(daemon, session, "logpath-nofin-create", 4);
    addReadyTasks(daemon, session, queueId, 1);
    startExecution(daemon, session, queueId, "logpath-nofin-start");

    const planned = daemon.callTool(
      "fabric_spawn_agents",
      { queueId, count: 1, worker: "deepseek-direct", workspaceMode: "git_worktree", planOnly: true },
      contextFor(session, "logpath-nofin-spawn")
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error("spawn failed");

    // Planned cards should have undefined log paths
    expect(planned.data.cards[0].stdoutLogPath).toBeUndefined();
    expect(planned.data.cards[0].stderrLogPath).toBeUndefined();

    daemon.close();
  });
});
