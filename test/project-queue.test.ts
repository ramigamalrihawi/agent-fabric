import { describe, expect, it } from "vitest";
import { FabricDaemon } from "../src/daemon.js";
import type { BridgeRegister } from "../src/types.js";

describe("project queue substrate", () => {
  it("creates a queue without storing the raw prompt and records pipeline stages", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());

    const created = createQueue(daemon, session, "queue-create");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("queue create failed");
    expect(created.data.rawPromptStored).toBe(false);

    const stage = daemon.callTool(
      "project_queue_record_stage",
      {
        queueId: created.data.queueId,
        stage: "prompt_improvement",
        status: "needs_review",
        modelAlias: "prompt.improve.strong",
        outputSummary: "Improved prompt is ready for review.",
        warnings: ["Human should approve before planning."]
      },
      contextFor(session, "stage-prompt")
    );
    expect(stage.ok).toBe(true);

    const status = daemon.callTool("project_queue_status", { queueId: created.data.queueId }, contextFor(session));
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error("queue status failed");
    expect(status.data.queue).toMatchObject({
      queueId: created.data.queueId,
      projectPath: "/tmp/workspace/app",
      pipelineProfile: "careful",
      maxParallelAgents: 4,
      rawPromptStored: false,
      status: "prompt_review"
    });
    expect(status.data.queue.promptSummary).toContain("Raw prompt intentionally not stored");
    expect(status.data.queue.promptSummary).not.toContain("Build a desktop command center");
    expect(status.data.stages[0]).toMatchObject({ stage: "prompt_improvement", status: "needs_review" });

    const configured = daemon.callTool(
      "project_queue_update_settings",
      {
        queueId: created.data.queueId,
        title: "Configured command center",
        pipelineProfile: "fast",
        maxParallelAgents: 2,
        note: "Use a faster profile for this queue."
      },
      contextFor(session, "queue-configure")
    );
    expect(configured.ok).toBe(true);
    if (!configured.ok) throw new Error("queue configure failed");
    expect(configured.data.queue).toMatchObject({
      queueId: created.data.queueId,
      title: "Configured command center",
      pipelineProfile: "fast",
      maxParallelAgents: 2
    });

    const configuredStatus = daemon.callTool("project_queue_status", { queueId: created.data.queueId }, contextFor(session));
    expect(configuredStatus.ok).toBe(true);
    if (!configuredStatus.ok) throw new Error("configured queue status failed");
    expect(configuredStatus.data.queue).toMatchObject({
      title: "Configured command center",
      pipelineProfile: "fast",
      maxParallelAgents: 2
    });
    daemon.close();
  });

  it("allows a project-root CLI session to resume a queue created from another harness workspace", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const codexSession = daemon.registerBridge(registerPayload({ root: "/Users/me/projects/agent-fabric", agentId: "codex" }));
    const cliSession = daemon.registerBridge(registerPayload({ root: "/tmp/workspace/app", agentId: "project-cli" }));
    const unrelatedSession = daemon.registerBridge(registerPayload({ root: "/tmp/other", agentId: "project-cli" }));

    const created = createQueue(daemon, codexSession, "cross-root-create");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("queue create failed");

    const resumed = daemon.callTool("project_queue_status", { queueId: created.data.queueId }, contextFor(cliSession, "cross-root-resume"));
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error("project-root resume failed");
    expect(resumed.data.queue).toMatchObject({ queueId: created.data.queueId, projectPath: "/tmp/workspace/app" });

    const hidden = daemon.callTool("project_queue_status", { queueId: created.data.queueId }, contextFor(unrelatedSession, "cross-root-hidden"));
    expect(hidden.ok).toBe(false);
    if (hidden.ok) throw new Error("unrelated workspace unexpectedly accessed queue");
    expect(hidden.message).toContain("The queue exists for workspace /Users/me/projects/agent-fabric and project /tmp/workspace/app");
    daemon.close();
  });

  it("previews and applies cleanup for completed queues while retaining linked task history by default", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "cleanup-create");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("queue create failed");
    const added = daemon.callTool(
      "project_queue_add_tasks",
      {
        queueId: created.data.queueId,
        tasks: [{ clientKey: "cleanup-task", title: "Cleanup task", goal: "Create linked task history.", risk: "low" }]
      },
      contextFor(session, "cleanup-add-task")
    );
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error("add task failed");
    const fabricTaskId = String(added.data.created[0].fabricTaskId);
    const queueTaskId = String(added.data.created[0].queueTaskId);
    const taskDone = daemon.callTool(
      "project_queue_update_task",
      { queueId: created.data.queueId, queueTaskId, status: "completed", summary: "Cleanup task done." },
      contextFor(session, "cleanup-task-done")
    );
    expect(taskDone.ok).toBe(true);

    const completed = daemon.callTool(
      "project_queue_decide",
      { queueId: created.data.queueId, decision: "complete", note: "Ready for cleanup." },
      contextFor(session, "cleanup-complete")
    );
    expect(completed.ok).toBe(true);
    daemon.db.db.prepare("UPDATE project_queues SET ts_updated = datetime('now', '-10 days') WHERE id = ?").run(created.data.queueId);

    const preview = daemon.callTool(
      "project_queue_cleanup",
      { projectPath: "/tmp/workspace/app", olderThanDays: 7 },
      contextFor(session, "cleanup-preview")
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error("cleanup preview failed");
    expect(preview.data).toMatchObject({
      dryRun: true,
      candidateCount: 1,
      protectedCount: 0,
      totals: expect.objectContaining({
        queueRows: 1,
        queueTasks: 1,
        linkedFabricTasks: 1,
        retainedLinkedTaskHistoryRows: 1
      })
    });
    expect(tableCount(daemon, "project_queues")).toBe(1);

    const applied = daemon.callTool(
      "project_queue_cleanup",
      { projectPath: "/tmp/workspace/app", olderThanDays: 7, dryRun: false },
      contextFor(session, "cleanup-apply")
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error("cleanup apply failed");
    expect(applied.data).toMatchObject({ dryRun: false, cleanedCount: 1, protectedCount: 0 });
    expect(tableCount(daemon, "project_queues")).toBe(0);
    expect(tableCount(daemon, "project_queue_tasks")).toBe(0);
    expect((daemon.db.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE id = ?").get(fabricTaskId) as { count: number }).count).toBe(1);
    daemon.close();
  });

  it("protects active queues and can delete linked task history only when explicitly requested", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const activeQueue = createQueue(daemon, session, "cleanup-active-create");
    expect(activeQueue.ok).toBe(true);
    if (!activeQueue.ok) throw new Error("active queue create failed");
    const protectedPreview = daemon.callTool(
      "project_queue_cleanup",
      { queueId: activeQueue.data.queueId, olderThanDays: 0 },
      contextFor(session, "cleanup-active-preview")
    );
    expect(protectedPreview.ok).toBe(true);
    if (!protectedPreview.ok) throw new Error("protected preview failed");
    expect(protectedPreview.data).toMatchObject({ dryRun: true, candidateCount: 0, protectedCount: 1 });
    expect(tableCount(daemon, "project_queues")).toBe(1);

    const completedQueue = createQueue(daemon, session, "cleanup-linked-create");
    expect(completedQueue.ok).toBe(true);
    if (!completedQueue.ok) throw new Error("completed queue create failed");
    const added = daemon.callTool(
      "project_queue_add_tasks",
      {
        queueId: completedQueue.data.queueId,
        tasks: [{ clientKey: "linked-history", title: "Linked history", goal: "Create worker history.", risk: "low" }]
      },
      contextFor(session, "cleanup-linked-add")
    );
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error("linked task add failed");
    const task = added.data.created[0] as { queueTaskId: string; fabricTaskId: string };
    const worker = startWorkerForQueueTask(daemon, session, task, "cleanup-linked-worker");
    const event = daemon.callTool(
      "fabric_task_event",
      { taskId: task.fabricTaskId, workerRunId: worker.workerRunId, kind: "checkpoint", body: "Worker history exists." },
      contextFor(session, "cleanup-linked-event")
    );
    expect(event.ok).toBe(true);
    const checkpoint = daemon.callTool(
      "fabric_task_checkpoint",
      { taskId: task.fabricTaskId, workerRunId: worker.workerRunId, summary: { currentGoal: "Cleanup test" } },
      contextFor(session, "cleanup-linked-checkpoint")
    );
    expect(checkpoint.ok).toBe(true);
    const finished = daemon.callTool(
      "fabric_task_finish",
      { taskId: task.fabricTaskId, workerRunId: worker.workerRunId, status: "completed", summary: "Worker history complete." },
      contextFor(session, "cleanup-linked-finish")
    );
    expect(finished.ok).toBe(true);
    const queueTaskDone = daemon.callTool(
      "project_queue_update_task",
      { queueId: completedQueue.data.queueId, queueTaskId: task.queueTaskId, status: "completed", summary: "Queue task complete." },
      contextFor(session, "cleanup-linked-task-done")
    );
    expect(queueTaskDone.ok).toBe(true);
    const completed = daemon.callTool(
      "project_queue_decide",
      { queueId: completedQueue.data.queueId, decision: "complete", note: "Ready for deep cleanup." },
      contextFor(session, "cleanup-linked-complete")
    );
    expect(completed.ok).toBe(true);
    daemon.db.db.prepare("UPDATE project_queues SET ts_updated = datetime('now', '-10 days') WHERE id = ?").run(completedQueue.data.queueId);

    const applied = daemon.callTool(
      "project_queue_cleanup",
      { queueId: completedQueue.data.queueId, olderThanDays: 7, deleteLinkedTaskHistory: true, dryRun: false },
      contextFor(session, "cleanup-linked-apply")
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error("linked cleanup apply failed");
    expect(applied.data).toMatchObject({
      dryRun: false,
      cleanedCount: 1,
      totals: expect.objectContaining({
        linkedFabricTasks: 1,
        workerRuns: 1,
        workerEvents: expect.any(Number),
        workerCheckpoints: 1,
        retainedLinkedTaskHistoryRows: 0
      })
    });
    expect(Number((applied.data.totals as Record<string, unknown>).workerEvents)).toBeGreaterThanOrEqual(1);
    expect((daemon.db.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE id = ?").get(task.fabricTaskId) as { count: number }).count).toBe(0);
    expect(tableCount(daemon, "worker_runs")).toBe(0);
    expect(tableCount(daemon, "worker_events")).toBe(0);
    expect(tableCount(daemon, "worker_checkpoints")).toBe(0);
    daemon.close();
  });

  it("does not clean completed queues that still contain reviewable task states", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "cleanup-reviewable-create");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("reviewable queue create failed");
    const added = daemon.callTool(
      "project_queue_add_tasks",
      {
        queueId: created.data.queueId,
        tasks: [{ clientKey: "reviewable-task", title: "Reviewable task", goal: "Preserve patch review.", risk: "high" }]
      },
      contextFor(session, "cleanup-reviewable-add")
    );
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error("reviewable task add failed");
    const queueTaskId = String(added.data.created[0].queueTaskId);
    const reviewable = daemon.callTool(
      "project_queue_update_task",
      { queueId: created.data.queueId, queueTaskId, status: "patch_ready", summary: "Awaiting senior review." },
      contextFor(session, "cleanup-reviewable-task")
    );
    expect(reviewable.ok).toBe(true);
    daemon.db.db
      .prepare("UPDATE project_queues SET status = 'completed', ts_updated = datetime('now', '-10 days') WHERE id = ?")
      .run(created.data.queueId);

    const preview = daemon.callTool(
      "project_queue_cleanup",
      { queueId: created.data.queueId, olderThanDays: 7 },
      contextFor(session, "cleanup-reviewable-preview")
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error("reviewable cleanup preview failed");
    expect(preview.data).toMatchObject({ dryRun: true, candidateCount: 0, protectedCount: 1 });
    expect(JSON.stringify(preview.data.protected)).toContain("active or reviewable task");
    expect(tableCount(daemon, "project_queues")).toBe(1);
    daemon.close();
  });

  it("validates queue task fabric links and missing context refs before launch", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "validate-create");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("queue create failed");
    const added = daemon.callTool(
      "project_queue_add_tasks",
      {
        queueId: created.data.queueId,
        tasks: [
          {
            title: "Use moved context",
            goal: "Read a context file before launch.",
            risk: "low",
            requiredContextRefs: ["docs/missing-after-move.md"]
          }
        ]
      },
      contextFor(session, "validate-add")
    );
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error("add task failed");
    const queueTaskId = added.data.created[0].queueTaskId as string;

    const contextRefs = daemon.callTool(
      "project_queue_validate_context_refs",
      { queueId: created.data.queueId, readyOnly: true },
      contextFor(session, "validate-context")
    );
    expect(contextRefs.ok).toBe(true);
    if (!contextRefs.ok) throw new Error("context validation failed");
    expect(contextRefs.data).toMatchObject({ ok: false, checked: 1 });
    expect(contextRefs.data.issues[0]).toMatchObject({
      type: "context_ref_missing",
      queueTaskId,
      ref: "docs/missing-after-move.md"
    });

    const marked = daemon.callTool(
      "project_queue_validate_context_refs",
      { queueId: created.data.queueId, readyOnly: true, markBlocked: true },
      contextFor(session, "validate-context-mark")
    );
    expect(marked.ok).toBe(true);
    const blockedStatus = daemon.callTool("project_queue_status", { queueId: created.data.queueId }, contextFor(session, "validate-status"));
    expect(blockedStatus.ok).toBe(true);
    if (!blockedStatus.ok) throw new Error("status failed");
    expect(blockedStatus.data.tasks[0]).toMatchObject({ queueTaskId, status: "blocked" });

    daemon.db.db.prepare("UPDATE project_queue_tasks SET status = 'queued', fabric_task_id = NULL WHERE id = ?").run(queueTaskId);
    const links = daemon.callTool(
      "project_queue_validate_links",
      { queueId: created.data.queueId, readyOnly: true },
      contextFor(session, "validate-links")
    );
    expect(links.ok).toBe(true);
    if (!links.ok) throw new Error("link validation failed");
    expect(links.data).toMatchObject({ ok: false, checked: 1 });
    expect(links.data.issues[0]).toMatchObject({ type: "missing_fabric_task_id", queueTaskId });
    daemon.close();
  });

  it("reuses existing queue tasks by durable clientKey", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "client-key-create");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("queue create failed");

    const first = daemon.callTool(
      "project_queue_add_tasks",
      {
        queueId: created.data.queueId,
        tasks: [
          {
            clientKey: "linear:ENG-1",
            title: "ENG-1: First import",
            goal: "Create the queue-visible task for ENG-1.",
            risk: "low"
          }
        ]
      },
      contextFor(session, "client-key-add-first")
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("first add task failed");
    expect(first.data.created).toHaveLength(1);
    expect(first.data.created[0]).toMatchObject({ clientKey: "linear:ENG-1" });

    const again = daemon.callTool(
      "project_queue_add_tasks",
      {
        queueId: created.data.queueId,
        tasks: [
          {
            clientKey: "linear:ENG-1",
            title: "ENG-1: Duplicate import",
            goal: "Should reuse the already-created queue task.",
            risk: "low"
          }
        ]
      },
      contextFor(session, "client-key-add-second")
    );
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error("second add task failed");
    expect(again.data.created).toHaveLength(0);
    expect(again.data.reused).toHaveLength(1);
    expect(again.data.reused[0]).toMatchObject({
      queueTaskId: first.data.created[0].queueTaskId,
      fabricTaskId: first.data.created[0].fabricTaskId,
      clientKey: "linear:ENG-1",
      reused: true
    });

    const status = daemon.callTool("project_queue_status", { queueId: created.data.queueId }, contextFor(session, "client-key-status"));
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error("queue status failed");
    expect(status.data.tasks).toHaveLength(1);
    expect(status.data.tasks[0]).toMatchObject({
      queueTaskId: first.data.created[0].queueTaskId,
      clientKey: "linear:ENG-1",
      title: "ENG-1: First import"
    });
    daemon.close();
  });



  it("adds tasks via batch with shared defaults plus per-task overrides", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "batch-create");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("queue create failed");

    const batch = daemon.callTool(
      "project_queue_add_task_batch",
      {
        queueId: created.data.queueId,
        defaults: {
          phase: "batch-phase",
          risk: "medium",
          priority: "high",
          expectedFiles: ["src/shared.ts"],
          acceptanceCriteria: ["Shared acceptance"]
        },
        tasks: [
          {
            clientKey: "batch-a",
            title: "Batch task A",
            goal: "First batch task.",
            expectedFiles: ["src/task-a.ts"],
            acceptanceCriteria: ["Task A specific"],
            dependsOn: ["batch-b"]
          },
          {
            clientKey: "batch-b",
            title: "Batch task B",
            goal: "Second batch task.",
            risk: "low",
            expectedFiles: ["src/task-b.ts"]
          },
          {
            clientKey: "batch-c",
            title: "Batch task C",
            goal: "Third batch task.",
            priority: "normal"
          }
        ]
      },
      contextFor(session, "batch-add")
    );
    expect(batch.ok).toBe(true);
    if (!batch.ok) throw new Error("batch add failed");
    expect(batch.data.created).toHaveLength(3);
    expect(batch.data.reused).toHaveLength(0);

    const tasks = batch.data.created as Array<Record<string, unknown>>;
    const taskA = tasks.find((t) => t.clientKey === "batch-a")!;
    const taskB = tasks.find((t) => t.clientKey === "batch-b")!;
    const taskC = tasks.find((t) => t.clientKey === "batch-c")!;

    // Task A: phase/risk inherited from defaults, expectedFiles concatenated, dependsOn resolved
    const status = daemon.callTool("project_queue_status", { queueId: created.data.queueId }, contextFor(session));
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error("queue status failed");
    const taskADetail = (status.data.tasks as Array<Record<string, unknown>>).find(
      (t) => t.queueTaskId === taskA.queueTaskId
    );
    expect(taskADetail).toMatchObject({
      queueTaskId: taskA.queueTaskId,
      title: "Batch task A",
      goal: "First batch task.",
      phase: "batch-phase",
      risk: "medium",
      priority: "high"
    });
    const taskBFiles = (status.data.tasks as Array<Record<string, unknown>>).find(
      (t) => t.queueTaskId === taskB.queueTaskId
    );
    // Task B overrode risk to low, inherited phase, concatenated expectedFiles
    expect(taskBFiles).toMatchObject({
      title: "Batch task B",
      phase: "batch-phase",
      risk: "low",
      priority: "high"
    });
    // Task C inherited phase/risk/priority/expectedFiles/acceptanceCriteria from defaults
    const taskCDetail = (status.data.tasks as Array<Record<string, unknown>>).find(
      (t) => t.queueTaskId === taskC.queueTaskId
    );
    expect(taskCDetail).toMatchObject({
      title: "Batch task C",
      phase: "batch-phase",
      risk: "medium",
      priority: "normal"
    });
    daemon.close();
  });

  it("reports which task failed in a batch when per-task data is invalid", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "batch-invalid-create");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("queue create failed");

    const batch = daemon.callTool(
      "project_queue_add_task_batch",
      {
        queueId: created.data.queueId,
        defaults: { phase: "test" },
        tasks: [
          { clientKey: "valid", title: "Valid", goal: "OK." },
          { clientKey: "bad", title: "", goal: "No title." }
        ]
      },
      contextFor(session, "batch-invalid-add")
    );
    expect(batch.ok).toBe(false);
    expect(batch.message).toContain("Task at index 1");
    expect(batch.message).toContain("string field");
    daemon.close();
  });

  it("resolves clientKey dependency references within a batch", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "batch-deps-create");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("queue create failed");

    const batch = daemon.callTool(
      "project_queue_add_task_batch",
      {
        queueId: created.data.queueId,
        defaults: { phase: "batch-phase", risk: "medium" },
        tasks: [
          {
            clientKey: "root",
            title: "Root task",
            goal: "No deps."
          },
          {
            clientKey: "child",
            title: "Child task",
            goal: "Depends on root.",
            dependsOn: ["root"]
          }
        ]
      },
      contextFor(session, "batch-deps-add")
    );
    expect(batch.ok).toBe(true);
    if (!batch.ok) throw new Error("batch deps add failed");
    expect(batch.data.created).toHaveLength(2);

    const status = daemon.callTool("project_queue_status", { queueId: created.data.queueId }, contextFor(session));
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error("queue status failed");
    const childTask = (status.data.tasks as Array<Record<string, unknown>>).find(
      (t) => (t as Record<string, unknown>).title === "Child task"
    );
    expect(childTask).toBeDefined();
    // Child should depend on root's real queueTaskId, not the clientKey
    const dependsOn = (childTask as Record<string, unknown>).dependsOn as string[];
    const rootTask = (status.data.tasks as Array<Record<string, unknown>>).find(
      (t) => (t as Record<string, unknown>).title === "Root task"
    );
    expect(dependsOn).toContain((rootTask as Record<string, unknown>).queueTaskId);

    // Verify next_ready: root is ready (no deps), child is blocked
    const nextReady = daemon.callTool("project_queue_next_ready", { queueId: created.data.queueId }, contextFor(session));
    expect(nextReady.ok).toBe(true);
    if (!nextReady.ok) throw new Error("next ready failed");
    const readyTasks = nextReady.data.ready as Array<Record<string, unknown>>;
    expect(readyTasks).toHaveLength(1);
    expect(readyTasks[0].title).toBe("Root task");
    daemon.close();
  });

  it("adds dependency-aware tasks and returns only ready work", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "ready-create");
    if (!created.ok) throw new Error("queue create failed");

    const add = addThreeTasks(daemon, session, created.data.queueId);
    expect(add.ok).toBe(true);
    if (!add.ok) throw new Error("add tasks failed");
    const memory = daemon.callTool(
      "memory_write",
      {
        type: "preference",
        body: "For queue surface work, show the approval panel and queue lifecycle state together.",
        intent_keys: ["queue surface", "queue lifecycle"],
        source: "user"
      },
      contextFor(session, "queue-surface-memory")
    );
    expect(memory.ok).toBe(true);
    if (!memory.ok) throw new Error("memory write failed");

    const firstReady = daemon.callTool("project_queue_next_ready", { queueId: created.data.queueId }, contextFor(session));
    expect(firstReady.ok).toBe(true);
    if (!firstReady.ok) throw new Error("next ready failed");
    expect(firstReady.data).toMatchObject({
      executionBlocked: false,
      workerStartBlocked: true,
      workerStartBlockedReason: "queue is waiting for start_execution"
    });
    expect(firstReady.data.ready.map((task: { title: string }) => task.title)).toEqual(["Create schema", "Add bridge definitions"]);
    expect(firstReady.data.blocked[0].task.title).toBe("Add queue surface");
    expect(firstReady.data.blocked[0].blockers).toEqual([
      expect.objectContaining({ title: "Create schema", status: "queued", risk: "medium" })
    ]);

    const schemaTask = add.data.created.find((task: { clientKey?: string }) => task.clientKey === "schema");
    const surfaceTask = add.data.created.find((task: { clientKey?: string }) => task.clientKey === "surface");
    const readyDetail = daemon.callTool(
      "project_queue_task_detail",
      { queueId: created.data.queueId, queueTaskId: schemaTask.queueTaskId },
      contextFor(session, "ready-task-detail-before-start")
    );
    expect(readyDetail.ok).toBe(true);
    if (!readyDetail.ok) throw new Error("ready task detail failed");
    expect(readyDetail.data.readiness).toMatchObject({
      readyNow: false,
      state: "worker_start_blocked",
      workerStartBlocked: true,
      workerStartBlockedReason: "queue is waiting for start_execution",
      dependenciesReady: true
    });
    const blockedDetail = daemon.callTool(
      "project_queue_task_detail",
      { queueId: created.data.queueId, queueTaskId: surfaceTask.queueTaskId },
      contextFor(session)
    );
    expect(blockedDetail.ok).toBe(true);
    if (!blockedDetail.ok) throw new Error("blocked task detail failed");
    expect(blockedDetail.data.graph.dependencies).toEqual([
      expect.objectContaining({ queueTaskId: schemaTask.queueTaskId, title: "Create schema", satisfied: false })
    ]);
    expect(blockedDetail.data.readiness).toMatchObject({
      readyNow: false,
      state: "blocked",
      dependenciesReady: false
    });
    expect(blockedDetail.data.memorySuggestions[0]).toMatchObject({
      memoryRef: memory.data.id,
      approvalRequired: true,
      attachByUpdating: {
        tool: "project_queue_update_task_metadata",
        field: "requiredMemories",
        value: memory.data.id
      }
    });
    expect(blockedDetail.data.readiness.reasons[0]).toContain(schemaTask.queueTaskId);

    const attachedMemory = daemon.callTool(
      "project_queue_update_task_metadata",
      {
        queueId: created.data.queueId,
        queueTaskId: surfaceTask.queueTaskId,
        addRequiredMemories: [memory.data.id],
        note: "Attach suggested memory after human review."
      },
      contextFor(session, "attach-suggested-memory")
    );
    expect(attachedMemory.ok).toBe(true);
    if (!attachedMemory.ok) throw new Error("attach memory failed");
    expect(attachedMemory.data.task).toMatchObject({
      queueTaskId: surfaceTask.queueTaskId,
      requiredTools: ["project_queue_status"],
      requiredMemories: [memory.data.id]
    });
    const removedMemory = daemon.callTool(
      "project_queue_update_task_metadata",
      {
        queueId: created.data.queueId,
        queueTaskId: surfaceTask.queueTaskId,
        removeRequiredMemories: [memory.data.id],
        note: "Remove suggested memory after review."
      },
      contextFor(session, "remove-suggested-memory")
    );
    expect(removedMemory.ok).toBe(true);
    if (!removedMemory.ok) throw new Error("remove memory failed");
    expect(removedMemory.data.task).toMatchObject({
      queueTaskId: surfaceTask.queueTaskId,
      requiredTools: ["project_queue_status"],
      requiredMemories: []
    });

    const updated = daemon.callTool(
      "project_queue_update_task",
      {
        queueId: created.data.queueId,
        queueTaskId: schemaTask.queueTaskId,
        status: "completed",
        summary: "Schema is complete.",
        testRefs: ["npm test -- project-queue"]
      },
      contextFor(session, "schema-complete")
    );
    expect(updated.ok).toBe(true);

    const secondReady = daemon.callTool("project_queue_next_ready", { queueId: created.data.queueId }, contextFor(session));
    expect(secondReady.ok).toBe(true);
    if (!secondReady.ok) throw new Error("next ready after completion failed");
    expect(secondReady.data.ready.map((task: { title: string }) => task.title)).toEqual(["Add queue surface", "Add bridge definitions"]);
    const bridgeTask = secondReady.data.ready.find((task: { title: string }) => task.title === "Add bridge definitions");
    expect(bridgeTask.requiredMcpServers).toEqual(["github"]);
    expect(bridgeTask.requiredMemories).toEqual(["memory:user-review-style"]);
    expect(bridgeTask.requiredContextRefs).toEqual(["context:repo-map"]);
    const dashboard = daemon.callTool("project_queue_dashboard", { queueId: created.data.queueId }, contextFor(session, "dashboard-memory-suggestions"));
    expect(dashboard.ok).toBe(true);
    if (!dashboard.ok) throw new Error("dashboard failed");
    expect(dashboard.data.summaryStrip).toMatchObject({
      status: "waiting_on_start",
      nextAction: "Record start_execution before launching workers.",
      reasons: ["worker_start_blocked"]
    });
    expect(
      dashboard.data.memorySuggestions.find((suggestion: { queueTaskId?: string; memoryRef?: string }) => suggestion.queueTaskId === surfaceTask.queueTaskId)
    ).toMatchObject({
      memoryRef: memory.data.id,
      queueTaskTitle: "Add queue surface"
    });
    daemon.close();
  });

  it("builds markdown task packets for worker handoff before launch", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "task-packet-create");
    if (!created.ok) throw new Error("queue create failed");
    const add = addThreeTasks(daemon, session, created.data.queueId);
    if (!add.ok) throw new Error("add tasks failed");
    const surfaceTask = add.data.created.find((task: { clientKey?: string }) => task.clientKey === "surface");

    const packet = daemon.callTool(
      "project_queue_task_packet",
      {
        queueId: created.data.queueId,
        queueTaskId: surfaceTask.queueTaskId,
        format: "markdown",
        preferredWorker: "local-cli",
        workspaceMode: "git_worktree",
        modelProfile: "execute.cheap"
      },
      contextFor(session, "task-packet")
    );

    expect(packet.ok).toBe(true);
    if (!packet.ok) throw new Error("task packet failed");
    expect(packet.data).toMatchObject({
      packetKind: "task",
      format: "markdown",
      queueTask: { queueTaskId: surfaceTask.queueTaskId, title: "Add queue surface" },
      packet: {
        schema: "agent-fabric.task-packet.v1",
        requiredTools: ["project_queue_status"]
      },
      handoff: {
        worker: "local-cli",
        workspaceMode: "git_worktree",
        modelProfile: "execute.cheap"
      }
    });
    expect(packet.data.handoff.packetPath).toContain(`${surfaceTask.queueTaskId}.md`);
    expect(packet.data.handoff.commands.map((entry: { key: string }) => entry.key)).toEqual([
      "write_ready_packets",
      "claim_next_worker",
      "run_this_task",
      "run_ready_parallel"
    ]);
    expect(packet.data.handoff.commands[1].command).toContain(`claim-next --queue ${created.data.queueId}`);
    expect(packet.data.handoff.commands[2].editRequired).toBe(true);
    expect(packet.data.markdown).toContain("# Add queue surface");
    expect(packet.data.markdown).toContain("Use only approved tools, MCP servers, memories, and context.");
    expect(packet.data.preview).toContain("## Acceptance Criteria");
    daemon.close();
  });

  it("edits task metadata during queue review and rejects dependency cycles", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "metadata-edit-create");
    if (!created.ok) throw new Error("queue create failed");
    const add = addThreeTasks(daemon, session, created.data.queueId);
    if (!add.ok) throw new Error("add tasks failed");

    const schemaTask = add.data.created.find((task: { clientKey?: string }) => task.clientKey === "schema");
    const surfaceTask = add.data.created.find((task: { clientKey?: string }) => task.clientKey === "surface");

    const cycle = daemon.callTool(
      "project_queue_update_task_metadata",
      {
        queueId: created.data.queueId,
        queueTaskId: schemaTask.queueTaskId,
        dependsOn: [surfaceTask.queueTaskId],
        note: "This would create a schema/surface cycle."
      },
      contextFor(session, "metadata-cycle")
    );
    expect(cycle.ok).toBe(false);
    if (cycle.ok) throw new Error("metadata cycle should have failed");
    expect(cycle.code).toBe("PROJECT_QUEUE_DEPENDENCY_CYCLE");

    const edited = daemon.callTool(
      "project_queue_update_task_metadata",
      {
        queueId: created.data.queueId,
        queueTaskId: surfaceTask.queueTaskId,
        title: "Reviewed queue surface",
        priority: "urgent",
        risk: "high",
        parallelSafe: false,
        dependsOn: [],
        requiredTools: ["project_queue_status", "project_queue_next_ready"],
        clearPhase: true,
        note: "Human queue review adjustment."
      },
      contextFor(session, "metadata-edit")
    );
    expect(edited.ok).toBe(true);
    if (!edited.ok) throw new Error("metadata edit failed");
    expect(edited.data.queue).toMatchObject({ queueId: created.data.queueId, status: "queue_review" });
    expect(edited.data.previousTask).toMatchObject({
      queueTaskId: surfaceTask.queueTaskId,
      title: "Add queue surface",
      dependsOn: [schemaTask.queueTaskId]
    });
    expect(edited.data.task).toMatchObject({
      queueTaskId: surfaceTask.queueTaskId,
      title: "Reviewed queue surface",
      priority: "urgent",
      risk: "high",
      parallelSafe: false,
      dependsOn: [],
      requiredTools: ["project_queue_status", "project_queue_next_ready"]
    });
    expect(edited.data.task.phase).toBeUndefined();

    const ready = daemon.callTool("project_queue_next_ready", { queueId: created.data.queueId }, contextFor(session));
    expect(ready.ok).toBe(true);
    if (!ready.ok) throw new Error("next ready after metadata edit failed");
    expect(ready.data.ready.map((task: { title: string }) => task.title)).toEqual(["Reviewed queue surface"]);
    daemon.close();
  });

  it("prepares tool/context proposals for ready tasks before launch", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "prepare-ready-create");
    if (!created.ok) throw new Error("queue create failed");
    const add = addThreeTasks(daemon, session, created.data.queueId);
    if (!add.ok) throw new Error("add tasks failed");
    const bridgeTask = add.data.created.find((task: { clientKey?: string }) => task.clientKey === "bridge");
    const memory = daemon.callTool(
      "memory_write",
      {
        type: "preference",
        body: "Bridge definitions should expose MCP proxy schemas with clear approval metadata.",
        intent_keys: ["bridge definitions", "mcp proxy"],
        source: "user"
      },
      contextFor(session, "prepare-ready-memory")
    );
    expect(memory.ok).toBe(true);
    if (!memory.ok) throw new Error("memory write failed");

    const prepared = daemon.callTool("project_queue_prepare_ready", { queueId: created.data.queueId, limit: 2 }, contextFor(session, "prepare-ready"));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("prepare ready failed");
    expect(prepared.data).toMatchObject({
      workerStartBlocked: true,
      workerStartBlockedReason: "queue is waiting for start_execution"
    });
    expect(prepared.data.summary).toMatchObject({ readyToClaim: 0, readyToLaunch: 0, approvalRequired: 1, noContextRequired: 1, waitingForStart: 1 });
    const bridgePrepared = prepared.data.prepared.find((entry: { task?: { queueTaskId?: string } }) => entry.task?.queueTaskId === bridgeTask.queueTaskId);
    expect(bridgePrepared).toMatchObject({
      approvalRequired: true,
      readyToClaim: false,
      readyToLaunch: false,
      launchBlockedReason: "tool_context_approval_required",
      toolContextProposal: expect.objectContaining({ queueTaskId: bridgeTask.queueTaskId, approvalRequired: true })
    });
    expect(bridgePrepared.memorySuggestions[0]).toMatchObject({
      memoryRef: memory.data.id,
      approvalRequired: true
    });
    expect(bridgePrepared.missingGrants.map((grant: { grantKey: string }) => grant.grantKey).sort()).toEqual([
      "context:context:repo-map",
      "mcp_server:github",
      "memory:memory:user-review-style"
    ]);

    const launchPlanBeforeStart = daemon.callTool("project_queue_launch_plan", { queueId: created.data.queueId, limit: 2 }, contextFor(session, "launch-plan-before-start"));
    expect(launchPlanBeforeStart.ok).toBe(true);
    if (!launchPlanBeforeStart.ok) throw new Error("launch plan before start failed");
    expect(launchPlanBeforeStart.data).toMatchObject({
      workerStartBlocked: true,
      workerStartBlockedReason: "queue is waiting for start_execution",
      summary: { scheduled: 2, launchable: 0, waitingForStart: 1, approvalRequired: 1, needsProposal: 0 }
    });
    expect(launchPlanBeforeStart.data.waitingForStart[0].task.title).toBe("Create schema");
    expect(launchPlanBeforeStart.data.approvalRequired[0]).toMatchObject({
      task: { queueTaskId: bridgeTask.queueTaskId },
      toolContextProposal: { proposalId: bridgePrepared.toolContextProposal.proposalId },
      launchBlockedReason: "tool_context_approval_required"
    });

    const reviewMatrix = daemon.callTool("project_queue_review_matrix", { queueId: created.data.queueId, limit: 2 }, contextFor(session, "review-matrix"));
    expect(reviewMatrix.ok).toBe(true);
    if (!reviewMatrix.ok) throw new Error("review matrix failed");
    expect(reviewMatrix.data.summary).toMatchObject({
      totalTasks: 3,
      openTasks: 3,
      readyDependencyFree: 2,
      blockedByDependencies: 1,
      scheduledPreview: 2,
      launchable: 0,
      waitingForStart: 1,
      approvalRequired: 1,
      pendingToolContextApprovals: 1,
      tasksRequiringContext: 2,
      tasksNeedingToolContextApproval: 2,
      tasksNeedingToolContextProposal: 1,
      uniqueRequiredGrants: 4
    });
    expect(reviewMatrix.data.buckets.risk).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "medium", count: 2, openCount: 2 }),
        expect.objectContaining({ key: "low", count: 1, openCount: 1 })
      ])
    );
    expect(reviewMatrix.data.dependencies.blockedTasks[0].task.title).toBe("Add queue surface");
    expect(reviewMatrix.data.parallelism.scheduledPreview.approvalRequired[0]).toMatchObject({
      task: { queueTaskId: bridgeTask.queueTaskId }
    });
    expect(reviewMatrix.data.toolContext.grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ grantKey: "mcp_server:github", policyStatus: "missing", taskCount: 1 }),
        expect.objectContaining({ grantKey: "tool:project_queue_status", policyStatus: "missing", taskCount: 1 })
      ])
    );
    expect(reviewMatrix.data.toolContext.pendingApprovals[0]).toMatchObject({
      proposalId: bridgePrepared.toolContextProposal.proposalId,
      queueTaskTitle: "Add bridge definitions"
    });

    const replay = daemon.callTool("project_queue_prepare_ready", { queueId: created.data.queueId, limit: 2 }, contextFor(session, "prepare-ready-replay"));
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("prepare ready replay failed");
    const replayBridge = replay.data.prepared.find((entry: { task?: { queueTaskId?: string } }) => entry.task?.queueTaskId === bridgeTask.queueTaskId);
    expect(replayBridge).toMatchObject({
      reusedProposal: true,
      toolContextProposal: expect.objectContaining({ proposalId: bridgePrepared.toolContextProposal.proposalId })
    });

    startExecution(daemon, session, created.data.queueId, "prepare-ready-start-execution");
    const afterStart = daemon.callTool("project_queue_prepare_ready", { queueId: created.data.queueId, limit: 2 }, contextFor(session, "prepare-ready-after-start"));
    expect(afterStart.ok).toBe(true);
    if (!afterStart.ok) throw new Error("prepare ready after start failed");
    expect(afterStart.data).toMatchObject({ workerStartBlocked: false, workerStartBlockedReason: undefined });
    expect(afterStart.data.summary).toMatchObject({ readyToClaim: 1, readyToLaunch: 1, approvalRequired: 1, waitingForStart: 0 });

    const launchPlanAfterStart = daemon.callTool("project_queue_launch_plan", { queueId: created.data.queueId, limit: 2 }, contextFor(session, "launch-plan-after-start"));
    expect(launchPlanAfterStart.ok).toBe(true);
    if (!launchPlanAfterStart.ok) throw new Error("launch plan after start failed");
    expect(launchPlanAfterStart.data.summary).toMatchObject({ launchable: 1, waitingForStart: 0, approvalRequired: 1 });

    const revised = daemon.callTool(
      "project_queue_update_task_metadata",
      {
        queueId: created.data.queueId,
        queueTaskId: bridgeTask.queueTaskId,
        addRequiredMcpServers: ["filesystem"],
        note: "Need filesystem context too."
      },
      contextFor(session, "prepare-ready-revise-context")
    );
    expect(revised.ok).toBe(true);
    if (!revised.ok) throw new Error("metadata revision failed");
    expect(revised.data.staleToolContextProposalIds).toEqual([bridgePrepared.toolContextProposal.proposalId]);

    const pendingAfterRevision = daemon.callTool("tool_context_pending", { queueId: created.data.queueId }, contextFor(session, "pending-after-revision"));
    expect(pendingAfterRevision.ok).toBe(true);
    if (!pendingAfterRevision.ok) throw new Error("pending after revision failed");
    expect(pendingAfterRevision.data.count).toBe(0);

    const statusAfterRevision = daemon.callTool("project_queue_status", { queueId: created.data.queueId }, contextFor(session, "status-after-revision"));
    expect(statusAfterRevision.ok).toBe(true);
    if (!statusAfterRevision.ok) throw new Error("status after revision failed");
    expect(
      statusAfterRevision.data.toolContextProposals.find(
        (proposal: { proposalId: string }) => proposal.proposalId === bridgePrepared.toolContextProposal.proposalId
      )
    ).toMatchObject({
      status: "revision_requested",
      decision: "revise",
      decisionNote: "Need filesystem context too."
    });

    const preparedAfterRevision = daemon.callTool(
      "project_queue_prepare_ready",
      { queueId: created.data.queueId, limit: 2 },
      contextFor(session, "prepare-ready-after-revision")
    );
    expect(preparedAfterRevision.ok).toBe(true);
    if (!preparedAfterRevision.ok) throw new Error("prepare ready after revision failed");
    const revisedBridge = preparedAfterRevision.data.prepared.find(
      (entry: { task?: { queueTaskId?: string } }) => entry.task?.queueTaskId === bridgeTask.queueTaskId
    );
    expect(revisedBridge.toolContextProposal.proposalId).not.toBe(bridgePrepared.toolContextProposal.proposalId);
    expect(revisedBridge.missingGrants.map((grant: { grantKey: string }) => grant.grantKey).sort()).toEqual([
      "context:context:repo-map",
      "mcp_server:filesystem",
      "mcp_server:github",
      "memory:memory:user-review-style"
    ]);
    daemon.close();
  });

  it("requires start_execution before claiming or assigning workers", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "start-gate-create");
    if (!created.ok) throw new Error("queue create failed");
    const add = addThreeTasks(daemon, session, created.data.queueId);
    if (!add.ok) throw new Error("add tasks failed");
    const schemaTask = add.data.created.find((task: { clientKey?: string }) => task.clientKey === "schema");

    const ready = daemon.callTool("project_queue_next_ready", { queueId: created.data.queueId }, contextFor(session));
    expect(ready.ok).toBe(true);
    if (!ready.ok) throw new Error("next ready failed");
    expect(ready.data.ready.map((task: { title: string }) => task.title)).toContain("Create schema");

    const prepared = daemon.callTool("project_queue_prepare_ready", { queueId: created.data.queueId, limit: 2 }, contextFor(session, "start-gate-prepare"));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("prepare ready failed");
    expect(prepared.data.executionBlocked).toBe(false);
    expect(prepared.data.workerStartBlocked).toBe(true);
    expect(prepared.data.summary.readyToClaim).toBe(0);

    const claimBeforeStart = daemon.callTool("project_queue_claim_next", { queueId: created.data.queueId }, contextFor(session, "start-gate-claim"));
    expect(claimBeforeStart.ok).toBe(true);
    if (!claimBeforeStart.ok) throw new Error("claim before start failed");
    expect(claimBeforeStart.data).toMatchObject({
      executionBlocked: true,
      blockedReason: "queue is waiting for start_execution",
      claimed: undefined
    });

    const assignBeforeStart = daemon.callTool(
      "project_queue_assign_worker",
      { queueId: created.data.queueId, queueTaskId: schemaTask.queueTaskId },
      contextFor(session, "start-gate-assign")
    );
    expect(assignBeforeStart.ok).toBe(false);
    if (assignBeforeStart.ok) throw new Error("assign before start should have failed");
    expect(assignBeforeStart.code).toBe("PROJECT_QUEUE_EXECUTION_BLOCKED");

    startExecution(daemon, session, created.data.queueId, "start-gate-start");
    const assignWithoutWorkerAfterStart = daemon.callTool(
      "project_queue_assign_worker",
      { queueId: created.data.queueId, queueTaskId: schemaTask.queueTaskId },
      contextFor(session, "start-gate-assign-no-worker")
    );
    expect(assignWithoutWorkerAfterStart.ok).toBe(false);
    if (assignWithoutWorkerAfterStart.ok) throw new Error("assignment without worker should have failed");
    expect(assignWithoutWorkerAfterStart.code).toBe("PROJECT_QUEUE_WORKER_RUN_REQUIRED");

    const claimAfterStart = daemon.callTool("project_queue_claim_next", { queueId: created.data.queueId }, contextFor(session, "start-gate-claim-after"));
    expect(claimAfterStart.ok).toBe(true);
    if (!claimAfterStart.ok) throw new Error("claim after start failed");
    expect(claimAfterStart.data.claimed).toMatchObject({ queueTaskId: schemaTask.queueTaskId, status: "running" });
    daemon.close();
  });

  it("claims one ready task atomically and preserves idempotent replay", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "claim-create");
    if (!created.ok) throw new Error("queue create failed");
    const add = addThreeTasks(daemon, session, created.data.queueId);
    if (!add.ok) throw new Error("add tasks failed");
    startExecution(daemon, session, created.data.queueId, "claim-start");

    const firstClaim = daemon.callTool("project_queue_claim_next", { queueId: created.data.queueId }, contextFor(session, "claim-one"));
    expect(firstClaim.ok).toBe(true);
    if (!firstClaim.ok) throw new Error("claim next failed");
    expect(firstClaim.data.claimed.title).toBe("Create schema");
    expect(firstClaim.data.claimed.status).toBe("running");

    const replay = daemon.callTool("project_queue_claim_next", { queueId: created.data.queueId }, contextFor(session, "claim-one"));
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("claim next replay failed");
    expect(replay.data.claimed.queueTaskId).toBe(firstClaim.data.claimed.queueTaskId);

    const secondClaim = daemon.callTool("project_queue_claim_next", { queueId: created.data.queueId }, contextFor(session, "claim-two"));
    expect(secondClaim.ok).toBe(true);
    if (!secondClaim.ok) throw new Error("second claim next failed");
    expect(secondClaim.data.claimed.title).toBe("Add bridge definitions");

    const afterClaims = daemon.callTool("project_queue_next_ready", { queueId: created.data.queueId }, contextFor(session));
    expect(afterClaims.ok).toBe(true);
    if (!afterClaims.ok) throw new Error("next ready after claims failed");
    expect(afterClaims.data.activeWorkers).toBe(2);
    expect(afterClaims.data.ready).toHaveLength(0);

    const completeSchema = daemon.callTool(
      "project_queue_update_task",
      {
        queueId: created.data.queueId,
        queueTaskId: firstClaim.data.claimed.queueTaskId,
        status: "completed",
        summary: "Schema is complete."
      },
      contextFor(session, "claim-schema-complete")
    );
    expect(completeSchema.ok).toBe(true);

    const thirdClaim = daemon.callTool("project_queue_claim_next", { queueId: created.data.queueId }, contextFor(session, "claim-three"));
    expect(thirdClaim.ok).toBe(true);
    if (!thirdClaim.ok) throw new Error("third claim next failed");
    expect(thirdClaim.data.claimed.title).toBe("Add queue surface");
    daemon.close();
  });

  it("claims and starts a worker run in one mutation", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "claim-worker-create");
    if (!created.ok) throw new Error("queue create failed");
    addThreeTasks(daemon, session, created.data.queueId);
    startExecution(daemon, session, created.data.queueId, "claim-worker-start");

    const claimed = daemon.callTool(
      "project_queue_claim_next",
      {
        queueId: created.data.queueId,
        worker: "local-cli",
        workspaceMode: "git_worktree",
        workspacePath: "/tmp/workspace/app-worktree-schema",
        modelProfile: "execute.cheap",
        contextPolicy: "tool_context:approved",
        command: ["local-cli", "run", "--fabric-task"],
        metadata: { source: "test" }
      },
      contextFor(session, "claim-worker")
    );
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error("claim worker failed");
    expect(claimed.data.claimed).toMatchObject({ title: "Create schema", status: "running" });
    expect(claimed.data.workerRun).toMatchObject({
      worker: "local-cli",
      status: "running",
      workspacePath: "/tmp/workspace/app-worktree-schema",
      modelProfile: "execute.cheap",
      contextPolicy: "tool_context:approved",
      command: ["local-cli", "run", "--fabric-task"],
      metadata: { source: "test" }
    });
    expect(claimed.data.claimed.assignedWorkerRunId).toBe(claimed.data.workerRun.workerRunId);

    const status = daemon.callTool("fabric_task_status", { taskId: claimed.data.claimed.fabricTaskId }, contextFor(session));
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error("fabric task status failed");
    expect(status.data.workerRuns[0]).toMatchObject({ workerRunId: claimed.data.workerRun.workerRunId, worker: "local-cli" });
    daemon.close();
  });

  it("treats paused and canceled queue decisions as execution gates", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "queue-gate-create");
    if (!created.ok) throw new Error("queue create failed");
    const add = addThreeTasks(daemon, session, created.data.queueId);
    if (!add.ok) throw new Error("add tasks failed");

    const paused = daemon.callTool(
      "project_queue_decide",
      { queueId: created.data.queueId, decision: "pause", note: "Pause before execution." },
      contextFor(session, "queue-gate-pause")
    );
    expect(paused.ok).toBe(true);
    if (!paused.ok) throw new Error("pause failed");
    expect(paused.data.status).toBe("paused");

    const pausedReady = daemon.callTool("project_queue_next_ready", { queueId: created.data.queueId }, contextFor(session));
    expect(pausedReady.ok).toBe(true);
    if (!pausedReady.ok) throw new Error("paused next-ready failed");
    expect(pausedReady.data).toMatchObject({ executionBlocked: true, blockedReason: "queue is paused", ready: [] });
    expect(pausedReady.data.blocked[0].reasons).toEqual(["queue is paused"]);
    const pausedDashboard = daemon.callTool("project_queue_dashboard", { queueId: created.data.queueId }, contextFor(session));
    expect(pausedDashboard.ok).toBe(true);
    if (!pausedDashboard.ok) throw new Error("paused dashboard failed");
    expect(pausedDashboard.data.summaryStrip).toMatchObject({ status: "paused", counts: { ready: 0 } });
    expect(pausedDashboard.data.queueBoard.ready).toHaveLength(0);
    expect(pausedDashboard.data.queueBoard.blocked[0].reasons).toEqual(["queue is paused"]);
    const pausedList = daemon.callTool("project_queue_list", {}, contextFor(session));
    expect(pausedList.ok).toBe(true);
    if (!pausedList.ok) throw new Error("paused list failed");
    expect(pausedList.data.queues[0]).toMatchObject({ queueId: created.data.queueId, readyCount: 0 });
    expect(pausedList.data.queues[0].blockedCount).toBeGreaterThan(0);

    const pausedClaim = daemon.callTool("project_queue_claim_next", { queueId: created.data.queueId }, contextFor(session, "queue-gate-claim"));
    expect(pausedClaim.ok).toBe(true);
    if (!pausedClaim.ok) throw new Error("paused claim failed");
    expect(pausedClaim.data).toMatchObject({ executionBlocked: true, blockedReason: "queue is paused" });
    expect(pausedClaim.data.claimed).toBeUndefined();

    const schemaTask = add.data.created.find((task: { clientKey?: string }) => task.clientKey === "schema");
    const pausedAssign = daemon.callTool(
      "project_queue_assign_worker",
      { queueId: created.data.queueId, queueTaskId: schemaTask.queueTaskId },
      contextFor(session, "queue-gate-assign")
    );
    expect(pausedAssign.ok).toBe(false);
    if (pausedAssign.ok) throw new Error("paused assignment should have failed");
    expect(pausedAssign.code).toBe("PROJECT_QUEUE_EXECUTION_BLOCKED");

    const resumed = daemon.callTool(
      "project_queue_decide",
      { queueId: created.data.queueId, decision: "resume", note: "Resume execution." },
      contextFor(session, "queue-gate-resume")
    );
    expect(resumed.ok).toBe(true);
    const resumedReady = daemon.callTool("project_queue_next_ready", { queueId: created.data.queueId }, contextFor(session));
    expect(resumedReady.ok).toBe(true);
    if (!resumedReady.ok) throw new Error("resumed next-ready failed");
    expect(resumedReady.data.executionBlocked).toBe(false);
    expect(resumedReady.data.ready.map((task: { title: string }) => task.title)).toContain("Create schema");

    const canceled = daemon.callTool(
      "project_queue_decide",
      { queueId: created.data.queueId, decision: "cancel", note: "Cancel queue." },
      contextFor(session, "queue-gate-cancel")
    );
    expect(canceled.ok).toBe(true);
    const canceledReady = daemon.callTool("project_queue_next_ready", { queueId: created.data.queueId }, contextFor(session));
    expect(canceledReady.ok).toBe(true);
    if (!canceledReady.ok) throw new Error("canceled next-ready failed");
    expect(canceledReady.data).toMatchObject({ executionBlocked: true, blockedReason: "queue is canceled", ready: [] });
    daemon.close();
  });

  it("dry-runs and recovers stale running queue tasks", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "recover-stale-create");
    if (!created.ok) throw new Error("queue create failed");
    addThreeTasks(daemon, session, created.data.queueId);
    startExecution(daemon, session, created.data.queueId, "recover-stale-start");

    const claimed = daemon.callTool(
      "project_queue_claim_next",
      {
        queueId: created.data.queueId,
        worker: "local-cli",
        workspaceMode: "git_worktree",
        workspacePath: "/tmp/workspace/app-worktree-stale",
        modelProfile: "execute.cheap"
      },
      contextFor(session, "recover-stale-claim")
    );
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error("claim worker failed");
    daemon.db.db
      .prepare("UPDATE worker_runs SET ts_started = ?, ts_updated = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", claimed.data.workerRun.workerRunId);

    const heartbeat = daemon.callTool(
      "fabric_task_heartbeat",
      {
        taskId: claimed.data.claimed.fabricTaskId,
        workerRunId: claimed.data.workerRun.workerRunId,
        task: "Still working."
      },
      contextFor(session, "recover-stale-heartbeat")
    );
    expect(heartbeat.ok).toBe(true);
    const freshDryRun = daemon.callTool(
      "project_queue_recover_stale",
      { queueId: created.data.queueId, staleAfterMinutes: 30, dryRun: true },
      contextFor(session, "recover-stale-fresh-dry-run")
    );
    expect(freshDryRun.ok).toBe(true);
    if (!freshDryRun.ok) throw new Error("fresh dry-run recovery failed");
    expect(freshDryRun.data.count).toBe(0);
    daemon.db.db
      .prepare("UPDATE worker_runs SET ts_started = ?, ts_updated = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", claimed.data.workerRun.workerRunId);

    const dryRun = daemon.callTool(
      "project_queue_recover_stale",
      { queueId: created.data.queueId, staleAfterMinutes: 30, dryRun: true },
      contextFor(session, "recover-stale-dry-run")
    );
    expect(dryRun.ok).toBe(true);
    if (!dryRun.ok) throw new Error("dry-run recovery failed");
    expect(dryRun.data.count).toBe(1);
    expect(dryRun.data.recovered[0]).toMatchObject({
      queueTaskId: claimed.data.claimed.queueTaskId,
      workerRunId: claimed.data.workerRun.workerRunId,
      reason: "worker heartbeat stale"
    });
    const statusAfterDryRun = daemon.callTool("project_queue_status", { queueId: created.data.queueId }, contextFor(session));
    expect(statusAfterDryRun.ok).toBe(true);
    if (!statusAfterDryRun.ok) throw new Error("queue status after dry-run failed");
    const taskAfterDryRun = statusAfterDryRun.data.tasks.find(
      (task: { queueTaskId: string }) => task.queueTaskId === claimed.data.claimed.queueTaskId
    );
    expect(taskAfterDryRun).toMatchObject({
      queueTaskId: claimed.data.claimed.queueTaskId,
      status: "running",
      assignedWorkerRunId: claimed.data.workerRun.workerRunId
    });

    const recovered = daemon.callTool(
      "project_queue_recover_stale",
      { queueId: created.data.queueId, staleAfterMinutes: 30, action: "requeue" },
      contextFor(session, "recover-stale-requeue")
    );
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error("stale recovery failed");
    expect(recovered.data.count).toBe(1);

    const status = daemon.callTool("project_queue_status", { queueId: created.data.queueId }, contextFor(session));
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error("queue status after recovery failed");
    const recoveredTask = status.data.tasks.find((task: { queueTaskId: string }) => task.queueTaskId === claimed.data.claimed.queueTaskId);
    expect(recoveredTask).toMatchObject({
      queueTaskId: claimed.data.claimed.queueTaskId,
      status: "queued"
    });
    expect(recoveredTask.assignedWorkerRunId).toBeUndefined();
    const taskStatus = daemon.callTool("fabric_task_status", { taskId: claimed.data.claimed.fabricTaskId }, contextFor(session));
    expect(taskStatus.ok).toBe(true);
    if (!taskStatus.ok) throw new Error("fabric task status failed");
    expect(taskStatus.data.status).toBe("created");
    expect(taskStatus.data.workerRuns[0]).toMatchObject({ workerRunId: claimed.data.workerRun.workerRunId, status: "stale" });
    daemon.close();
  });

  it("blocks claim-and-start until required tool/context grants are approved", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "claim-approval-create");
    if (!created.ok) throw new Error("queue create failed");
    const add = addThreeTasks(daemon, session, created.data.queueId);
    if (!add.ok) throw new Error("add tasks failed");
    startExecution(daemon, session, created.data.queueId, "claim-approval-start");
    const schemaTask = add.data.created.find((task: { clientKey?: string }) => task.clientKey === "schema");
    const completed = daemon.callTool(
      "project_queue_update_task",
      {
        queueId: created.data.queueId,
        queueTaskId: schemaTask.queueTaskId,
        status: "completed",
        summary: "Schema is complete."
      },
      contextFor(session, "claim-approval-schema-complete")
    );
    expect(completed.ok).toBe(true);

    const blocked = daemon.callTool(
      "project_queue_claim_next",
      {
        queueId: created.data.queueId,
        worker: "local-cli",
        workspaceMode: "git_worktree",
        workspacePath: "/tmp/workspace/app-worktree-surface",
        modelProfile: "execute.cheap"
      },
      contextFor(session, "claim-approval-blocked")
    );
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) throw new Error("blocked claim failed");
    expect(blocked.data.claimed).toBeUndefined();
    expect(blocked.data.approvalRequired).toBe(true);
    expect(blocked.data.toolContextProposal.missingGrants).toEqual([
      { kind: "tool", grantKey: "tool:project_queue_status", value: "project_queue_status", policyStatus: "missing" }
    ]);

    const approved = daemon.callTool(
      "tool_context_decide",
      { proposalId: blocked.data.toolContextProposal.proposalId, decision: "approve", remember: false, note: "Approve queue status tool for this task." },
      contextFor(session, "claim-approval-approve")
    );
    expect(approved.ok).toBe(true);

    const claimed = daemon.callTool(
      "project_queue_claim_next",
      {
        queueId: created.data.queueId,
        worker: "local-cli",
        workspaceMode: "git_worktree",
        workspacePath: "/tmp/workspace/app-worktree-surface",
        modelProfile: "execute.cheap"
      },
      contextFor(session, "claim-approval-after")
    );
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error("claim after approval failed");
    expect(claimed.data.claimed).toMatchObject({ title: "Add queue surface", status: "running" });
    expect(claimed.data.workerRun.contextPolicy).toMatch(/^tool_context:/);
    expect(claimed.data.toolContextProposal.approvalRequired).toBe(false);
    daemon.close();
  });

  it("blocks direct worker assignment until required tool/context grants are approved", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "assign-approval-create");
    if (!created.ok) throw new Error("queue create failed");
    const add = addThreeTasks(daemon, session, created.data.queueId);
    if (!add.ok) throw new Error("add tasks failed");
    startExecution(daemon, session, created.data.queueId, "assign-approval-start");
    const schemaTask = add.data.created.find((task: { clientKey?: string }) => task.clientKey === "schema");
    const surfaceTask = add.data.created.find((task: { clientKey?: string }) => task.clientKey === "surface");
    const completed = daemon.callTool(
      "project_queue_update_task",
      {
        queueId: created.data.queueId,
        queueTaskId: schemaTask.queueTaskId,
        status: "completed",
        summary: "Schema is complete."
      },
      contextFor(session, "assign-approval-schema-complete")
    );
    expect(completed.ok).toBe(true);

    const surfaceWorker = startWorkerForQueueTask(daemon, session, surfaceTask, "assign-approval-worker");
    const blocked = daemon.callTool(
      "project_queue_assign_worker",
      {
        queueId: created.data.queueId,
        queueTaskId: surfaceTask.queueTaskId,
        workerRunId: surfaceWorker.workerRunId
      },
      contextFor(session, "assign-approval-blocked")
    );
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) throw new Error("blocked assignment failed");
    expect(blocked.data).toMatchObject({
      assigned: false,
      approvalRequired: true,
      toolContextProposal: {
        queueTaskId: surfaceTask.queueTaskId,
        approvalRequired: true,
        missingGrants: [{ kind: "tool", grantKey: "tool:project_queue_status", value: "project_queue_status", policyStatus: "missing" }]
      }
    });

    const approved = daemon.callTool(
      "tool_context_decide",
      { proposalId: blocked.data.toolContextProposal.proposalId, decision: "approve", remember: false, note: "Approve this assignment once." },
      contextFor(session, "assign-approval-approve")
    );
    expect(approved.ok).toBe(true);

    const assigned = daemon.callTool(
      "project_queue_assign_worker",
      {
        queueId: created.data.queueId,
        queueTaskId: surfaceTask.queueTaskId,
        workerRunId: surfaceWorker.workerRunId
      },
      contextFor(session, "assign-approval-after")
    );
    expect(assigned.ok).toBe(true);
    if (!assigned.ok) throw new Error("assignment after approval failed");
    expect(assigned.data).toMatchObject({
      assigned: true,
      approvalRequired: false,
      status: "running",
      toolContextProposal: expect.objectContaining({ proposalId: blocked.data.toolContextProposal.proposalId, status: "approved" })
    });
    daemon.close();
  });

  it("respects serial tasks and parallel groups when selecting ready work", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "schedule-create");
    if (!created.ok) throw new Error("queue create failed");
    const add = addSchedulingTasks(daemon, session, created.data.queueId);
    expect(add.ok).toBe(true);
    if (!add.ok) throw new Error("add scheduling tasks failed");
    startExecution(daemon, session, created.data.queueId, "schedule-start");

    const firstReady = daemon.callTool("project_queue_next_ready", { queueId: created.data.queueId }, contextFor(session));
    expect(firstReady.ok).toBe(true);
    if (!firstReady.ok) throw new Error("next ready failed");
    expect(firstReady.data.ready.map((task: { title: string }) => task.title)).toEqual(["Run serial migration"]);

    const serialTask = add.data.created.find((task: { clientKey?: string }) => task.clientKey === "serial");
    const docsTask = add.data.created.find((task: { clientKey?: string }) => task.clientKey === "docs");
    const assignedSerial = daemon.callTool(
      "project_queue_assign_worker",
      {
        queueId: created.data.queueId,
        queueTaskId: serialTask.queueTaskId,
        workerRunId: startWorkerForQueueTask(daemon, session, serialTask, "serial-worker").workerRunId
      },
      contextFor(session, "serial-assign")
    );
    expect(assignedSerial.ok).toBe(true);

    const assignDuringSerial = daemon.callTool(
      "project_queue_assign_worker",
      {
        queueId: created.data.queueId,
        queueTaskId: docsTask.queueTaskId,
        workerRunId: startWorkerForQueueTask(daemon, session, docsTask, "docs-worker-during-serial").workerRunId
      },
      contextFor(session, "docs-assign-during-serial")
    );
    expect(assignDuringSerial.ok).toBe(false);
    if (assignDuringSerial.ok) throw new Error("parallel assignment should have failed");
    expect(assignDuringSerial.code).toBe("PROJECT_QUEUE_PARALLEL_CONFLICT");

    const duringSerial = daemon.callTool("project_queue_next_ready", { queueId: created.data.queueId }, contextFor(session));
    expect(duringSerial.ok).toBe(true);
    if (!duringSerial.ok) throw new Error("next ready during serial failed");
    expect(duringSerial.data.ready).toHaveLength(0);

    const completed = daemon.callTool(
      "project_queue_update_task",
      {
        queueId: created.data.queueId,
        queueTaskId: serialTask.queueTaskId,
        status: "completed",
        summary: "Serial migration completed."
      },
      contextFor(session, "serial-complete")
    );
    expect(completed.ok).toBe(true);

    const secondReady = daemon.callTool("project_queue_next_ready", { queueId: created.data.queueId }, contextFor(session));
    expect(secondReady.ok).toBe(true);
    if (!secondReady.ok) throw new Error("next ready after serial completion failed");
    expect(secondReady.data.ready.map((task: { title: string }) => task.title)).toEqual(["Update panel A", "Update docs"]);
    const groupedBlock = secondReady.data.blocked.find((entry: { task: { title: string } }) => entry.task.title === "Update panel B");
    expect(groupedBlock.reasons).toEqual(["parallel group ui already selected"]);
    daemon.close();
  });

  it("caps breakglass and high-risk ready work", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "risk-create");
    if (!created.ok) throw new Error("queue create failed");
    const add = addRiskTasks(daemon, session, created.data.queueId);
    expect(add.ok).toBe(true);
    if (!add.ok) throw new Error("add risk tasks failed");
    startExecution(daemon, session, created.data.queueId, "risk-start");

    const initial = daemon.callTool("project_queue_next_ready", { queueId: created.data.queueId }, contextFor(session));
    expect(initial.ok).toBe(true);
    if (!initial.ok) throw new Error("next ready failed");
    expect(initial.data.ready.map((task: { title: string }) => task.title)).toEqual(["Emergency database repair"]);

    const breakglassTask = add.data.created.find((task: { clientKey?: string }) => task.clientKey === "breakglass");
    const completed = daemon.callTool(
      "project_queue_update_task",
      {
        queueId: created.data.queueId,
        queueTaskId: breakglassTask.queueTaskId,
        status: "completed",
        summary: "Emergency repair completed."
      },
      contextFor(session, "breakglass-complete")
    );
    expect(completed.ok).toBe(true);

    const afterBreakglass = daemon.callTool("project_queue_next_ready", { queueId: created.data.queueId }, contextFor(session));
    expect(afterBreakglass.ok).toBe(true);
    if (!afterBreakglass.ok) throw new Error("next ready after breakglass failed");
    expect(afterBreakglass.data.ready.map((task: { title: string }) => task.title)).toEqual(["Risky migration A", "Low-risk docs"]);
    const blockedHigh = afterBreakglass.data.blocked.find((entry: { task: { title: string } }) => entry.task.title === "Risky migration B");
    expect(blockedHigh.reasons).toEqual(["high-risk task already selected"]);

    const highTask = add.data.created.find((task: { clientKey?: string }) => task.clientKey === "high-a");
    const assigned = daemon.callTool(
      "project_queue_assign_worker",
      {
        queueId: created.data.queueId,
        queueTaskId: highTask.queueTaskId,
        workerRunId: startWorkerForQueueTask(daemon, session, highTask, "high-worker").workerRunId
      },
      contextFor(session, "high-assign")
    );
    expect(assigned.ok).toBe(true);

    const duringHigh = daemon.callTool("project_queue_next_ready", { queueId: created.data.queueId }, contextFor(session));
    expect(duringHigh.ok).toBe(true);
    if (!duringHigh.ok) throw new Error("next ready during high-risk failed");
    expect(duringHigh.data.ready.map((task: { title: string }) => task.title)).toEqual(["Low-risk docs"]);
    const runningHighBlock = duringHigh.data.blocked.find((entry: { task: { title: string } }) => entry.task.title === "Risky migration B");
    expect(runningHighBlock.reasons).toEqual(["high-risk task already running"]);
    daemon.close();
  });

  it("links queue tasks to worker runs and tracks concurrency slots", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "worker-create");
    if (!created.ok) throw new Error("queue create failed");
    const add = addThreeTasks(daemon, session, created.data.queueId);
    if (!add.ok) throw new Error("add tasks failed");
    startExecution(daemon, session, created.data.queueId, "worker-start-execution");
    const bridgeTask = add.data.created.find((task: { clientKey?: string }) => task.clientKey === "bridge");
    const proposal = daemon.callTool(
      "tool_context_propose",
      {
        queueId: created.data.queueId,
        queueTaskId: bridgeTask.queueTaskId,
        mcpServers: ["github"],
        tools: [],
        memories: ["memory:user-review-style"],
        contextRefs: ["context:repo-map"]
      },
      contextFor(session, "worker-tool-proposal")
    );
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) throw new Error("worker tool proposal failed");
    const approved = daemon.callTool(
      "tool_context_decide",
      { proposalId: proposal.data.proposalId, decision: "approve", remember: false, note: "Approve this worker assignment." },
      contextFor(session, "worker-tool-proposal-approve")
    );
    expect(approved.ok).toBe(true);

    const started = daemon.callTool(
      "fabric_task_start_worker",
      {
        taskId: bridgeTask.fabricTaskId,
        worker: "local-cli",
        projectPath: "/tmp/workspace/app",
        workspaceMode: "git_worktree",
        workspacePath: "/tmp/workspace/app-worktree-bridge",
        modelProfile: "execute.cheap",
        contextPolicy: `tool_context:${proposal.data.proposalId}`,
        command: ["local-cli", "run", bridgeTask.fabricTaskId]
      },
      contextFor(session, "worker-start")
    );
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("worker start failed");

    const assigned = daemon.callTool(
      "project_queue_assign_worker",
      {
        queueId: created.data.queueId,
        queueTaskId: bridgeTask.queueTaskId,
        workerRunId: started.data.workerRunId
      },
      contextFor(session, "queue-assign")
    );
    expect(assigned.ok).toBe(true);

    const duplicateAssign = daemon.callTool(
      "project_queue_assign_worker",
      {
        queueId: created.data.queueId,
        queueTaskId: bridgeTask.queueTaskId
      },
      contextFor(session, "queue-assign-duplicate")
    );
    expect(duplicateAssign.ok).toBe(false);
    if (duplicateAssign.ok) throw new Error("duplicate assignment should have failed");
    expect(duplicateAssign.code).toBe("PROJECT_QUEUE_WORKER_RUN_REQUIRED");

    const ready = daemon.callTool("project_queue_next_ready", { queueId: created.data.queueId }, contextFor(session));
    expect(ready.ok).toBe(true);
    if (!ready.ok) throw new Error("next ready failed");
    expect(ready.data.activeWorkers).toBe(1);
    expect(ready.data.availableSlots).toBe(3);
    expect(ready.data.ready.map((task: { title: string }) => task.title)).toEqual(["Create schema"]);

    const event = daemon.callTool(
      "fabric_task_event",
      {
        taskId: bridgeTask.fabricTaskId,
        workerRunId: started.data.workerRunId,
        kind: "command_started",
        body: "npm test -- project-queue",
        metadata: { queueId: created.data.queueId, queueTaskId: bridgeTask.queueTaskId }
      },
      contextFor(session, "worker-command-started")
    );
    expect(event.ok).toBe(true);

    const checkpoint = daemon.callTool(
      "fabric_task_checkpoint",
      {
        taskId: bridgeTask.fabricTaskId,
        workerRunId: started.data.workerRunId,
        summary: {
          currentGoal: "Expose project queue lane state.",
          filesTouched: ["src/bin/bridge.ts"],
          testsRun: ["npm test -- project-queue"],
          nextAction: "Review lane output."
        }
      },
      contextFor(session, "worker-checkpoint")
    );
    expect(checkpoint.ok).toBe(true);

    const lanes = daemon.callTool("project_queue_agent_lanes", { queueId: created.data.queueId }, contextFor(session));
    expect(lanes.ok).toBe(true);
    if (!lanes.ok) throw new Error("agent lanes failed");
    expect(lanes.data.count).toBe(1);
    expect(lanes.data.lanes[0].queueTask).toMatchObject({ queueTaskId: bridgeTask.queueTaskId, title: "Add bridge definitions" });
    expect(lanes.data.lanes[0].workerRun).toMatchObject({ workerRunId: started.data.workerRunId, worker: "local-cli" });
    expect(lanes.data.lanes[0].latestEvent).toMatchObject({ kind: "command_started" });
    expect(lanes.data.lanes[0].latestCheckpoint.summary).toMatchObject({ nextAction: "Review lane output." });
    expect(lanes.data.lanes[0].progress).toMatchObject({
      label: "Running",
      filesTouched: ["src/bin/bridge.ts"],
      testsRun: ["npm test -- project-queue"],
      nextAction: "Review lane output."
    });

    const dashboard = daemon.callTool("project_queue_dashboard", { queueId: created.data.queueId }, contextFor(session));
    expect(dashboard.ok).toBe(true);
    if (!dashboard.ok) throw new Error("dashboard failed");
    expect(dashboard.data.queueBoard.running).toHaveLength(1);
    expect(dashboard.data.queueBoard.ready.map((task: { title: string }) => task.title)).toEqual(["Create schema"]);
    expect(dashboard.data.agentLaneCount).toBe(1);
    expect(dashboard.data.agentLanes[0].laneId).toBe(started.data.workerRunId);
    expect(dashboard.data.summaryStrip).toMatchObject({
      status: "running",
      severity: "ok",
      counts: { ready: 1, running: 1, staleRunning: 0, activeWorkers: 1, availableSlots: 3 },
      risk: { highestOpenRisk: "medium", highRiskOpenCount: 0 },
      cost: { preflightCount: 0, estimatedCostUsd: 0 }
    });

    const decision = daemon.callTool(
      "project_queue_decide",
      { queueId: created.data.queueId, decision: "start_execution", note: "Surface in timeline." },
      contextFor(session, "timeline-decision")
    );
    expect(decision.ok).toBe(true);
    const timeline = daemon.callTool("project_queue_timeline", { queueId: created.data.queueId, limit: 10 }, contextFor(session));
    expect(timeline.ok).toBe(true);
    if (!timeline.ok) throw new Error("timeline failed");
    expect(timeline.data.count).toBeGreaterThanOrEqual(2);
    expect(timeline.data.items.map((item: { source: string }) => item.source)).toEqual(
      expect.arrayContaining(["human_decision", "worker_event"])
    );
    expect(timeline.data.items.find((item: { source: string }) => item.source === "worker_event")).toMatchObject({
      kind: "worker.command_started",
      queueTaskTitle: "Add bridge definitions",
      worker: "local-cli"
    });

    const resume = daemon.callTool(
      "project_queue_resume_task",
      {
        queueId: created.data.queueId,
        queueTaskId: bridgeTask.queueTaskId,
        preferredWorker: "local-cli"
      },
      contextFor(session)
    );
    expect(resume.ok).toBe(true);
    if (!resume.ok) throw new Error("resume task failed");
    expect(resume.data.queueTask).toMatchObject({ queueTaskId: bridgeTask.queueTaskId, title: "Add bridge definitions" });
    expect(resume.data.fabricResume.resumePrompt).toContain("Latest checkpoint");
    expect(resume.data.taskPacket).toMatchObject({
      schema: "agent-fabric.queue-resume-packet.v1",
      requiredMcpServers: ["github"],
      requiredMemories: ["memory:user-review-style"]
    });

    const detail = daemon.callTool(
      "project_queue_task_detail",
      {
        queueId: created.data.queueId,
        queueTaskId: bridgeTask.queueTaskId,
        includeResume: true,
        preferredWorker: "local-cli",
        maxEventsPerRun: 5
      },
      contextFor(session)
    );
    expect(detail.ok).toBe(true);
    if (!detail.ok) throw new Error("task detail failed");
    expect(detail.data.task).toMatchObject({ queueTaskId: bridgeTask.queueTaskId, title: "Add bridge definitions" });
    expect(detail.data.workerRuns[0].workerRun).toMatchObject({ workerRunId: started.data.workerRunId, worker: "local-cli" });
    expect(detail.data.workerRuns[0].latestEvent).toMatchObject({ kind: "command_started" });
    expect(detail.data.workerRuns[0].latestCheckpoint.summary).toMatchObject({ nextAction: "Review lane output." });
    expect(detail.data.resume.taskPacket).toMatchObject({
      schema: "agent-fabric.queue-resume-packet.v1",
      requiredMcpServers: ["github"]
    });

    const codexPacket = daemon.callTool(
      "project_queue_task_packet",
      {
        queueId: created.data.queueId,
        queueTaskId: bridgeTask.queueTaskId,
        preferredWorker: "codex-app-server",
        workspaceMode: "git_worktree",
        modelProfile: "codex.app-server"
      },
      contextFor(session, "task-packet-codex-app-server")
    );
    expect(codexPacket.ok).toBe(true);
    if (!codexPacket.ok) throw new Error("codex app server task packet failed");
    expect(codexPacket.data.handoff.commands[1].command).toContain("--worker codex-app-server");

    const patchReady = daemon.callTool(
      "project_queue_update_task",
      {
        queueId: created.data.queueId,
        queueTaskId: bridgeTask.queueTaskId,
        workerRunId: started.data.workerRunId,
        status: "patch_ready",
        summary: "Ready for review."
      },
      contextFor(session, "bridge-patch-ready")
    );
    expect(patchReady.ok).toBe(true);
    const afterPatchReady = daemon.callTool("project_queue_next_ready", { queueId: created.data.queueId }, contextFor(session));
    expect(afterPatchReady.ok).toBe(true);
    if (!afterPatchReady.ok) throw new Error("next ready after patch-ready failed");
    expect(afterPatchReady.data.activeWorkers).toBe(0);
    expect(afterPatchReady.data.availableSlots).toBe(4);

    const retried = daemon.callTool(
      "project_queue_retry_task",
      {
        queueId: created.data.queueId,
        queueTaskId: bridgeTask.queueTaskId,
        reason: "Retry after review comments."
      },
      contextFor(session, "bridge-retry")
    );
    expect(retried.ok).toBe(true);
    if (!retried.ok) throw new Error("retry task failed");
    expect(retried.data).toMatchObject({
      previousStatus: "patch_ready",
      previousWorkerRunId: started.data.workerRunId,
      clearOutputs: true
    });
    expect(retried.data.task).toMatchObject({
      queueTaskId: bridgeTask.queueTaskId,
      status: "queued",
      patchRefs: [],
      testRefs: [],
      assignedWorkerRunId: undefined
    });
    const retriedFabric = daemon.callTool("fabric_task_status", { taskId: bridgeTask.fabricTaskId }, contextFor(session));
    expect(retriedFabric.ok).toBe(true);
    if (!retriedFabric.ok) throw new Error("fabric retry status failed");
    expect(retriedFabric.data.status).toBe("created");
    expect(retriedFabric.data.workerRuns[0].status).toBe("stale");
    daemon.close();
  });

  it("requires first-use tool/context approval and reuses remembered grants", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "tool-create");
    if (!created.ok) throw new Error("queue create failed");
    const add = addThreeTasks(daemon, session, created.data.queueId);
    if (!add.ok) throw new Error("add tasks failed");
    const bridgeTask = add.data.created.find((task: { clientKey?: string }) => task.clientKey === "bridge");

    const firstProposal = daemon.callTool(
      "tool_context_propose",
      {
        queueId: created.data.queueId,
        queueTaskId: bridgeTask.queueTaskId,
        mcpServers: ["github"],
        tools: ["fabric_task_event"],
        memories: ["memory:user-review-style"],
        contextRefs: ["context:repo-map"],
        modelAlias: "tool.context.manager",
        reasoning: "Use the least context needed to update bridge definitions."
      },
      contextFor(session, "tool-propose")
    );
    expect(firstProposal.ok).toBe(true);
    if (!firstProposal.ok) throw new Error("tool proposal failed");
    expect(firstProposal.data.approvalRequired).toBe(true);
    expect(firstProposal.data.missingGrants).toHaveLength(4);

    const pending = daemon.callTool("tool_context_pending", { queueId: created.data.queueId }, contextFor(session));
    expect(pending.ok).toBe(true);
    if (!pending.ok) throw new Error("pending approvals failed");
    expect(pending.data.count).toBe(1);
    expect(pending.data.pending[0]).toMatchObject({
      proposalId: firstProposal.data.proposalId,
      queueTaskTitle: "Add bridge definitions",
      projectPath: "/tmp/workspace/app"
    });

    const list = daemon.callTool("project_queue_list", { projectPath: "/tmp/workspace/app" }, contextFor(session));
    expect(list.ok).toBe(true);
    if (!list.ok) throw new Error("queue list failed");
    expect(list.data.queues[0]).toMatchObject({
      queueId: created.data.queueId,
      pendingApprovals: 1,
      readyCount: 2
    });

    const approved = daemon.callTool(
      "tool_context_decide",
      { proposalId: firstProposal.data.proposalId, decision: "approve", remember: true, note: "Approved for this project." },
      contextFor(session, "tool-approve")
    );
    expect(approved.ok).toBe(true);
    if (!approved.ok) throw new Error("tool approval failed");
    expect(approved.data.rememberedGrants).toBe(4);

    const policy = daemon.callTool("tool_context_policy_status", { projectPath: "/tmp/workspace/app" }, contextFor(session));
    expect(policy.ok).toBe(true);
    if (!policy.ok) throw new Error("policy status failed");
    expect(policy.data.grants.map((grant: { grantKey: string }) => grant.grantKey).sort()).toEqual([
      "context:context:repo-map",
      "mcp_server:github",
      "memory:memory:user-review-style",
      "tool:fabric_task_event"
    ]);

    const reusedProposal = daemon.callTool(
      "tool_context_propose",
      {
        queueId: created.data.queueId,
        queueTaskId: bridgeTask.queueTaskId,
        mcpServers: ["github"],
        tools: ["fabric_task_event"],
        memories: ["memory:user-review-style"],
        contextRefs: ["context:repo-map"]
      },
      contextFor(session, "tool-propose-reuse")
    );
    expect(reusedProposal.ok).toBe(true);
    if (!reusedProposal.ok) throw new Error("reused tool proposal failed");
    expect(reusedProposal.data.approvalRequired).toBe(false);
    expect(reusedProposal.data.missingGrants).toHaveLength(0);

    const rejected = daemon.callTool(
      "tool_context_policy_set",
      {
        projectPath: "/tmp/workspace/app",
        grantKind: "mcp_server",
        value: "github",
        status: "rejected"
      },
      contextFor(session, "tool-policy-reject")
    );
    expect(rejected.ok).toBe(true);

    const afterToggle = daemon.callTool(
      "tool_context_propose",
      {
        queueId: created.data.queueId,
        queueTaskId: bridgeTask.queueTaskId,
        mcpServers: ["github"],
        tools: ["fabric_task_event"],
        memories: ["memory:user-review-style"],
        contextRefs: ["context:repo-map"]
      },
      contextFor(session, "tool-propose-after-toggle")
    );
    expect(afterToggle.ok).toBe(true);
    if (!afterToggle.ok) throw new Error("tool proposal after toggle failed");
    expect(afterToggle.data.approvalRequired).toBe(true);
    expect(afterToggle.data.missingGrants).toEqual([{ kind: "mcp_server", grantKey: "mcp_server:github", value: "github", policyStatus: "rejected" }]);

    const statusWithPolicies = daemon.callTool("project_queue_status", { queueId: created.data.queueId }, contextFor(session));
    expect(statusWithPolicies.ok).toBe(true);
    if (!statusWithPolicies.ok) throw new Error("queue status with policies failed");
    expect(statusWithPolicies.data.toolContextPolicies.find((policy: { grantKey: string }) => policy.grantKey === "mcp_server:github")).toMatchObject({
      status: "rejected"
    });
    daemon.close();
  });

  it("replays idempotent queue creation without duplicating rows", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const input = {
      projectPath: "/tmp/workspace/app",
      promptSummary: "Create a queue once.",
      title: "One queue"
    };

    const first = daemon.callTool("project_queue_create", input, contextFor(session, "queue-idem"));
    const replay = daemon.callTool("project_queue_create", input, contextFor(session, "queue-idem"));

    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    if (!first.ok || !replay.ok) throw new Error("queue creation failed");
    expect(replay.data.queueId).toBe(first.data.queueId);
    expect(tableCount(daemon, "project_queues")).toBe(1);
    daemon.close();
  });

  it("issues queue-scoped model approvals and progress reports for Senior runs", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "senior-progress-create");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("queue create failed");
    const add = addThreeTasks(daemon, session, created.data.queueId);
    expect(add.ok).toBe(true);

    const approved = daemon.callTool(
      "project_queue_approve_model_calls",
      { queueId: created.data.queueId },
      contextFor(session, "senior-model-approval")
    );
    expect(approved.ok).toBe(true);
    if (!approved.ok) throw new Error("model approval failed");
    expect(approved.data).toMatchObject({
      schema: "agent-fabric.project-queue-model-approval.v1",
      budgetScope: `project_queue:${created.data.queueId}`,
      status: "approved"
    });
    expect(typeof approved.data.approvalToken).toBe("string");

    const report = daemon.callTool(
      "project_queue_progress_report",
      { queueId: created.data.queueId },
      contextFor(session, "senior-progress")
    );
    expect(report.ok).toBe(true);
    if (!report.ok) throw new Error("progress report failed");
    expect(report.data).toMatchObject({
      schema: "agent-fabric.project-queue-progress.v1",
      queue: { queueId: created.data.queueId },
      nextActions: expect.any(Array),
      verificationChecklist: expect.arrayContaining(["Review every patch-ready task before acceptance."])
    });
    daemon.close();
  });

  it("groups collab asks, replies, decisions, path claims, and handoff notes by queue task", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "collab-summary-queue");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("queue create failed");
    const queueId = created.data.queueId;

    const added = addThreeTasks(daemon, session, queueId);
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error("add tasks failed");

    // Get the task IDs so we can reference them
    const status = daemon.callTool("project_queue_status", { queueId }, contextFor(session, "collab-status"));
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error("queue status failed");
    const taskIds: string[] = (status.data.tasks as Array<Record<string, unknown>>).map((t) => String(t.queueTaskId));
    expect(taskIds.length).toBeGreaterThanOrEqual(1);
    const firstTaskId = taskIds[0];

    // Send an ask scoped to a specific queue task
    const ask = daemon.callTool("collab_ask", {
      to: "other-agent",
      kind: "review",
      question: "Please review this task implementation.",
      refs: [`project_queue:${queueId}`, `project_queue_task:${firstTaskId}`],
      urgency: "normal"
    }, contextFor(session, "collab-ask"));
    expect(ask.ok).toBe(true);
    if (!ask.ok) throw new Error("collab ask failed");

    const legacyAsk = daemon.callTool("collab_ask", {
      to: "other-agent",
      kind: "review",
      question: "Please review this worker card message.",
      refs: [`queue:${queueId}`, `queueTask:${firstTaskId}`],
      urgency: "normal"
    }, contextFor(session, "collab-legacy-ask"));
    expect(legacyAsk.ok).toBe(true);
    if (!legacyAsk.ok) throw new Error("legacy collab ask failed");

    // Send a message scoped to a task
    const message = daemon.callTool("collab_send", {
      to: "other-agent",
      body: "Handoff note for task.",
      refs: [`project_queue:${queueId}`, `project_queue_task:${firstTaskId}`],
      kind: "dm"
    }, contextFor(session, "collab-message"));
    expect(message.ok).toBe(true);

    // Record a collab decision
    const decision = daemon.callTool("collab_decision", {
      title: "Approach decision",
      decided: "Use streaming for collab fan-out.",
      participants: ["codex", "claude"]
    }, contextFor(session, "collab-decision"));
    expect(decision.ok).toBe(true);

    // Claim a path
    const claim = daemon.callTool("claim_path", {
      paths: ["src/surfaces/collab.ts"],
      note: "Working on collab summary feature."
    }, contextFor(session, "collab-claim"));
    expect(claim.ok).toBe(true);

    // Now query the collab summary
    const summary = daemon.callTool("project_queue_collab_summary", { queueId }, contextFor(session, "collab-summary"));
    expect(summary.ok).toBe(true);
    if (!summary.ok) throw new Error("collab summary failed");
    expect(summary.data).toMatchObject({
      schema: "agent-fabric.project-queue-collab-summary.v1",
      queue: { queueId }
    });

    const groups = summary.data.groups as Array<Record<string, unknown>>;
    // Should have at least one group for the task with the ask
    const taskGroup = groups.find((g) => String(g?.queueTask?.queueTaskId) === firstTaskId);
    expect(taskGroup).toBeDefined();
    if (!taskGroup) throw new Error("task group not found");

    const openAsks = taskGroup.openAsks as Array<Record<string, unknown>>;
    expect(openAsks.length).toBeGreaterThanOrEqual(1);
    expect(openAsks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          question: "Please review this task implementation.",
          kind: "review"
        }),
        expect.objectContaining({
          question: "Please review this worker card message.",
          kind: "review"
        })
      ])
    );

    // Unlinked should have decisions and path claims
    const unlinked = summary.data.unlinked as Record<string, unknown>;
    const unlinkedDecisions = unlinked.decisions as Array<Record<string, unknown>>;
    expect(unlinkedDecisions.length).toBeGreaterThanOrEqual(1);
    expect(unlinkedDecisions[0]).toMatchObject({
      title: "Approach decision",
      decided: "Use streaming for collab fan-out."
    });

    const unlinkedClaims = unlinked.pathClaims as Array<Record<string, unknown>>;
    expect(unlinkedClaims.length).toBeGreaterThanOrEqual(1);

    // Verify task packets include collab refs
    const packet = daemon.callTool("project_queue_task_packet", {
      queueId,
      queueTaskId: firstTaskId,
      format: "json"
    }, contextFor(session, "collab-packet"));
    expect(packet.ok).toBe(true);
    if (!packet.ok) throw new Error("packet failed");

    const pktCollab = (packet.data as Record<string, unknown>).packet as Record<string, unknown> | undefined;
    expect(pktCollab).toBeDefined();
    expect(pktCollab?.collab).toBeDefined();
    const collab = pktCollab?.collab as Record<string, unknown> | undefined;
    expect(collab?.queueRef).toBe(`project_queue:${queueId}`);
    expect(collab?.taskRef).toBe(`project_queue_task:${firstTaskId}`);
    expect(Array.isArray(collab?.instructions)).toBe(true);

    daemon.close();
  });

  it("returns empty groups for a queue with no tasks", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "empty-collab");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("queue create failed");

    const summary = daemon.callTool(
      "project_queue_collab_summary",
      { queueId: created.data.queueId },
      contextFor(session, "empty-collab-summary")
    );
    expect(summary.ok).toBe(true);
    if (!summary.ok) throw new Error("empty collab summary failed");
    expect(summary.data).toMatchObject({
      schema: "agent-fabric.project-queue-collab-summary.v1",
      groups: []
    });

    daemon.close();
  });

  it("returns a read-only patch review plan for patch-ready tasks with patch refs, worker worktree refs, risk notes, and CLI commands", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "patch-review-plan-create");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("queue create failed");
    const queueId = created.data.queueId;

    const added = addThreeTasks(daemon, session, queueId);
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error("add tasks failed");

    const started = startExecution(daemon, session, queueId, "patch-exec");
    const status = daemon.callTool("project_queue_status", { queueId }, contextFor(session, "patch-status"));
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error("queue status failed");
    const tasks = status.data.tasks as Array<Record<string, unknown>>;
    expect(tasks.length).toBeGreaterThanOrEqual(1);

    // Set first task to patch_ready with patch refs and start a worker
    const firstTask = tasks[0];
    const worker = startWorkerForQueueTask(
      daemon,
      session,
      { fabricTaskId: String(firstTask.fabricTaskId), queueTaskId: String(firstTask.queueTaskId) },
      "patch-review-plan-worker"
    );
    daemon.callTool(
      "fabric_task_event",
      {
        taskId: firstTask.fabricTaskId,
        workerRunId: worker.workerRunId,
        kind: "file_changed",
        refs: ["src/index.ts", "src/utils.ts"],
        metadata: { cwd: "/tmp/workspace/app" }
      },
      contextFor(session, "patch-event-files")
    );
    daemon.callTool(
      "fabric_task_checkpoint",
      {
        taskId: firstTask.fabricTaskId,
        workerRunId: worker.workerRunId,
        summary: {
          currentGoal: String(firstTask.goal),
          filesTouched: ["src/index.ts", "src/utils.ts", "src/patch.diff"],
          commandsRun: ["npm test"],
          testsRun: ["npm test"],
          failingTests: ["src/index.test.ts"],
          blockers: [],
          summary: "Implementation done, one test failing.",
          nextAction: "Review patch-ready output.",
          testsSuggested: ["npm test -- src/index.test.ts"]
        }
      },
      contextFor(session, "patch-checkpoint")
    );
    daemon.callTool(
      "project_queue_update_task",
      {
        queueId,
        queueTaskId: firstTask.queueTaskId,
        status: "patch_ready",
        workerRunId: worker.workerRunId,
        summary: "Task complete, patch ready for review.",
        patchRefs: ["src/patch.diff"],
        testRefs: ["npm test"]
      },
      contextFor(session, "patch-update-task")
    );

    // Set a second task to failed with an artifact
    const secondTask = tasks[1];
    if (secondTask) {
      daemon.callTool(
        "project_queue_update_task",
        {
          queueId,
          queueTaskId: secondTask.queueTaskId,
          status: "failed",
          summary: "Worker ran into an unexpected error.",
          patchRefs: ["partial-output.diff"],
          testRefs: []
        },
        contextFor(session, "patch-failed-task")
      );
    }

    const plan = daemon.callTool(
      "project_queue_patch_review_plan",
      { queueId },
      contextFor(session, "patch-review-plan")
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("patch review plan failed");
    expect(plan.data).toMatchObject({
      schema: "agent-fabric.project-queue-patch-review-plan.v1",
      queue: { queueId },
      summary: expect.objectContaining({
        patchReadyCount: 1,
        failedWithArtifactCount: 1,
        skippedCount: expect.any(Number)
      })
    });

    const entries = plan.data.entries as Array<Record<string, unknown>>;
    const patchReadyEntry = entries.find((entry) => entry.patchReady === true);
    expect(patchReadyEntry).toBeDefined();
    if (patchReadyEntry) {
      expect(patchReadyEntry).toMatchObject({
        status: "patch_ready",
        hasArtifact: true,
        patchRefs: ["src/patch.diff"]
      });
      expect(patchReadyEntry.workerRun).toBeDefined();
      expect(patchReadyEntry.worktreePath).toBeDefined();
      expect(patchReadyEntry.failingTests).toContain("src/index.test.ts");
      expect(patchReadyEntry.suggestedTests).toContain("npm test -- src/index.test.ts");
      expect(patchReadyEntry.riskNotes).toContain("1 failing test(s)");
      const commands = patchReadyEntry.commands as Record<string, unknown> | undefined;
      expect(commands?.reviewPatches).toContain("review-patches");
      expect(commands?.applyPatch).toContain("--apply-patch");
    }

    const failedEntry = entries.find((entry) => entry.status === "failed");
    expect(failedEntry).toBeDefined();
    if (failedEntry) {
      expect(failedEntry.patchReady).toBe(false);
      expect(failedEntry.hasArtifact).toBe(true);
    }

    expect(Array.isArray(plan.data.skipped)).toBe(true);

    daemon.close();
  });

  it("returns explicit reasons and no patch commands for no-artifact tasks", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "no-artifact-create");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("queue create failed");
    const queueId = created.data.queueId;

    const added = daemon.callTool(
      "project_queue_add_tasks",
      {
        queueId,
        tasks: [
          { title: "Unstarted queued item", goal: "A task still in queued state.", risk: "low" }
        ]
      },
      contextFor(session, "no-artifact-add")
    );
    expect(added.ok).toBe(true);

    const plan = daemon.callTool(
      "project_queue_patch_review_plan",
      { queueId },
      contextFor(session, "no-artifact-plan")
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("no-artifact review plan failed");
    expect(plan.data.summary).toMatchObject({
      patchReadyCount: 0,
      failedWithArtifactCount: 0,
      completedCount: 0,
      skippedCount: 1
    });
    expect(plan.data.entries).toHaveLength(0);
    expect(plan.data.skipped).toHaveLength(1);
    expect(plan.data.skipped[0]).toMatchObject({
      reason: expect.stringContaining("is not patch-ready, failed, or completed")
    });

    daemon.close();
  });

  it("is read-only and does not mutate queue state", () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const created = createQueue(daemon, session, "ro-create");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("queue create failed");
    const queueId = created.data.queueId;

    const added = addThreeTasks(daemon, session, queueId);
    expect(added.ok).toBe(true);

    const statusBefore = daemon.callTool("project_queue_status", { queueId }, contextFor(session, "ro-status-before"));
    expect(statusBefore.ok).toBe(true);
    if (!statusBefore.ok) throw new Error("status before failed");
    const tasksBefore = statusBefore.data.tasks as Array<Record<string, unknown>>;

    const plan = daemon.callTool(
      "project_queue_patch_review_plan",
      { queueId },
      contextFor(session, "ro-plan")
    );
    expect(plan.ok).toBe(true);

    const statusAfter = daemon.callTool("project_queue_status", { queueId }, contextFor(session, "ro-status-after"));
    expect(statusAfter.ok).toBe(true);
    if (!statusAfter.ok) throw new Error("status after failed");
    const tasksAfter = statusAfter.data.tasks as Array<Record<string, unknown>>;

    expect(tasksAfter).toEqual(tasksBefore);

    daemon.close();
  });
});

function createQueue(daemon: FabricDaemon, session: { sessionId: string; sessionToken: string }, idempotencyKey: string) {
  return daemon.callTool(
    "project_queue_create",
    {
      projectPath: "/tmp/workspace/app",
      prompt: "Build a desktop command center that turns project prompts into parallel worker queues.",
      title: "Desktop command center",
      pipelineProfile: "careful",
      maxParallelAgents: 4
    },
    contextFor(session, idempotencyKey)
  );
}

function startExecution(daemon: FabricDaemon, session: { sessionId: string; sessionToken: string }, queueId: string, idempotencyKey: string) {
  const started = daemon.callTool(
    "project_queue_decide",
    { queueId, decision: "start_execution", note: "Open queue execution for worker tests." },
    contextFor(session, idempotencyKey)
  );
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error("start execution failed");
  return started;
}

function startWorkerForQueueTask(
  daemon: FabricDaemon,
  session: { sessionId: string; sessionToken: string },
  task: { fabricTaskId: string; queueTaskId: string },
  idempotencyKey: string
): { workerRunId: string } {
  const started = daemon.callTool(
    "fabric_task_start_worker",
    {
      taskId: task.fabricTaskId,
      worker: "local-cli",
      projectPath: "/tmp/workspace/app",
      workspaceMode: "git_worktree",
      workspacePath: `/tmp/workspace/app-worktree-${task.queueTaskId}`,
      modelProfile: "execute.cheap",
      command: ["local-cli", "run", task.fabricTaskId]
    },
    contextFor(session, idempotencyKey)
  );
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error("worker start failed");
  return { workerRunId: String(started.data.workerRunId) };
}

function addThreeTasks(daemon: FabricDaemon, session: { sessionId: string; sessionToken: string }, queueId: string) {
  return daemon.callTool(
    "project_queue_add_tasks",
    {
      queueId,
      tasks: [
        {
          clientKey: "schema",
          title: "Create schema",
          goal: "Add queue and tool/context grant tables.",
          phase: "substrate",
          priority: "high",
          risk: "medium",
          expectedFiles: ["src/migrations/0013-project-queues.sql"],
          acceptanceCriteria: ["Migration applies cleanly."]
        },
        {
          clientKey: "surface",
          title: "Add queue surface",
          goal: "Expose queue lifecycle tools.",
          phase: "substrate",
          priority: "high",
          risk: "medium",
          dependsOn: ["schema"],
          requiredTools: ["project_queue_status"],
          acceptanceCriteria: ["Only dependency-free tasks are returned by next_ready."]
        },
        {
          clientKey: "bridge",
          title: "Add bridge definitions",
          goal: "Expose MCP proxy definitions for queue tools.",
          phase: "substrate",
          priority: "normal",
          risk: "low",
          parallelSafe: true,
          expectedFiles: ["src/bin/bridge.ts"],
          requiredMcpServers: ["github"],
          requiredMemories: ["memory:user-review-style"],
          requiredContextRefs: ["context:repo-map"],
          acceptanceCriteria: ["Bridge accepts the new tool schemas."]
        }
      ]
    },
    contextFor(session, `add-tasks-${queueId}`)
  );
}

function addSchedulingTasks(daemon: FabricDaemon, session: { sessionId: string; sessionToken: string }, queueId: string) {
  return daemon.callTool(
    "project_queue_add_tasks",
    {
      queueId,
      tasks: [
        {
          clientKey: "serial",
          title: "Run serial migration",
          goal: "Apply a database migration that must not run beside other work.",
          priority: "urgent",
          risk: "high",
          parallelSafe: false
        },
        {
          clientKey: "panel-a",
          title: "Update panel A",
          goal: "Update the first queue panel.",
          priority: "high",
          risk: "medium",
          parallelGroup: "ui"
        },
        {
          clientKey: "panel-b",
          title: "Update panel B",
          goal: "Update the second queue panel.",
          priority: "high",
          risk: "medium",
          parallelGroup: "ui"
        },
        {
          clientKey: "docs",
          title: "Update docs",
          goal: "Document the scheduling behavior.",
          priority: "normal",
          risk: "low"
        }
      ]
    },
    contextFor(session, `add-scheduling-tasks-${queueId}`)
  );
}

function addRiskTasks(daemon: FabricDaemon, session: { sessionId: string; sessionToken: string }, queueId: string) {
  return daemon.callTool(
    "project_queue_add_tasks",
    {
      queueId,
      tasks: [
        {
          clientKey: "breakglass",
          title: "Emergency database repair",
          goal: "Run a breakglass database repair.",
          priority: "urgent",
          risk: "breakglass"
        },
        {
          clientKey: "high-a",
          title: "Risky migration A",
          goal: "Change a risky migration.",
          priority: "high",
          risk: "high"
        },
        {
          clientKey: "high-b",
          title: "Risky migration B",
          goal: "Change another risky migration.",
          priority: "high",
          risk: "high"
        },
        {
          clientKey: "docs",
          title: "Low-risk docs",
          goal: "Document the migration.",
          priority: "normal",
          risk: "low"
        }
      ]
    },
    contextFor(session, `add-risk-tasks-${queueId}`)
  );
}

function registerPayload(options: { root?: string; agentId?: string } = {}): BridgeRegister {
  return {
    bridgeVersion: "0.1.0",
    agent: { id: options.agentId ?? "project-queue-test", displayName: "Project Queue Test", vendor: "test" },
    host: { name: "Project Queue Test Host", transport: "simulator" },
    workspace: { root: options.root ?? "/tmp/workspace", source: "explicit" },
    capabilities: {
      roots: true,
      notifications: true,
      notificationsVisibleToAgent: { declared: "yes", observed: "yes" },
      sampling: false,
      streamableHttp: false,
      litellmRouteable: true,
      outcomeReporting: "explicit"
    },
    notificationSelfTest: { observed: "yes", detail: "simulator" },
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
