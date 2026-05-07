import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import { startDesktopServer, type DesktopServerOptions, type DesktopToolCaller } from "../src/runtime/desktop-server.js";

describe("desktop command center server", () => {
  it("serves the static command center shell", async () => {
    await withDesktop(async ({ url }) => {
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      const html = await response.text();
      expect(html).toContain("Agent Fabric Console");
      expect(html).toContain('data-tab="theater"');
      expect(html).toContain('id="notice-stack"');
      expect(html).toContain('id="queue-health-strip"');
      expect(html).toContain('id="seed-demo-queue"');
      expect(html).toContain('id="command-palette"');
      expect(html).toContain("Connecting");

      const appJs = await fetch(`${url}app.js`);
      expect(appJs.status).toBe(200);
      const appBody = await appJs.text();
      expect(appBody).toContain("Desktop Server Required");
      expect(appBody).toContain("upsertNotice");
      expect(appBody).toContain("data-dismiss-notice");
      expect(appBody).toContain("Project Tool Policy");
      expect(appBody).toContain("project-policy-form");
      expect(appBody).toContain("Policy Summary");
      expect(appBody).toContain("data-policy-bulk");
      expect(appBody).toContain("Quick Toggles");
      expect(appBody).toContain("tool_context_policy_status");
      expect(appBody).toContain("renderTabBadges");
      expect(appBody).toContain("queueHealthData");
      expect(appBody).toContain("tab-badge");
      expect(appBody).toContain("openCommandPalette");
      expect(appBody).toContain("Senior Factory defaults applied");
      expect(appBody).toContain("copySeniorFactoryCommand");
      expect(appBody).toContain("Copy Senior Factory Command");
      expect(appBody).toContain("syncPendingButtons");
      expect(appBody).toContain("confirmQueueDecision");
      expect(appBody).toContain("confirmModelDecision");
      expect(appBody).toContain("routeResolution");
      expect(appBody).toContain("data-theater-active-toggle");
      expect(appBody).toContain("Pipeline Gate");
      expect(appBody).toContain("Copy Pipeline Brief");
      expect(appBody).toContain("data-copy-pipeline-brief");
      expect(appBody).toContain("Cost / Risk");
      expect(appBody).toContain("data-cost-inspect-request");
      expect(appBody).toContain("Launch Readiness");
      expect(appBody).toContain("data-launch-plan-preview");
      expect(appBody).toContain("Worker Handoff Brief");
      expect(appBody).toContain("data-copy-worker-brief");
      expect(appBody).toContain("Task Brief");
      expect(appBody).toContain("data-task-brief-copy");
      expect(appBody).toContain("copySelectedTaskBrief");
      expect(appBody).toContain("Patch Review");
      expect(appBody).toContain("data-review-accept");
      expect(appBody).toContain("Recovery Center");
      expect(appBody).toContain("data-recovery-copy");
      expect(appBody).toContain("project_queue_retry_task");
      expect(appBody).toContain("Parallel Work Preview");
      expect(appBody).toContain("parallelWorkPreview");
      expect(appBody).toContain("Operator Brief");
      expect(appBody).toContain("data-copy-operator-brief");
      expect(appBody).toContain("Copy Lane Brief");
      expect(appBody).toContain("data-copy-lane-brief");
      expect(appBody).toContain("laneBriefText");
      expect(appBody).toContain("seedDemoQueue");
      expect(appBody).toContain("/api/demo-seed");
      expect(appBody).toContain("postProjectCreate");
      expect(appBody).toContain("/api/project-create");
      expect(appBody).toContain("prompt-improve-form");
      expect(appBody).toContain("postProjectImprovePrompt");
      expect(appBody).toContain("/api/project-improve-prompt");
      expect(appBody).toContain("start-plan-form");
      expect(appBody).toContain("postProjectStartPlan");
      expect(appBody).toContain("/api/project-start-plan");
      expect(appBody).toContain("theater-fullscreen");
      expect(appBody).toContain("data-open-theater");
      expect(appBody).toContain("Live Lanes");
      expect(appBody).toContain("liveLaneDashboardData");
      expect(appBody).toContain("data-live-refresh");
      expect(appBody).toContain("copyActiveLaneBriefs");
      expect(appBody).toContain("Copy Active Lane Briefs");
    });
  });

  it("exposes a desktop readiness contract for native wrappers", async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    await withDesktop(async ({ url }) => {
      const readiness = await getJson(`${url}api/readiness`);
      expect(readiness).toMatchObject({
        ok: true,
        data: {
          schema: "agent-fabric.desktop-api.v1",
          ready: true,
          daemon: { daemon: { status: "ok" } },
          server: { status: "ok", transport: "http", apiAuth: { required: true, header: "x-agent-fabric-desktop-token" } },
          features: { queueSnapshot: true, batchClaimApprovalRetry: true, actionInbox: true, taskPacketReadRoute: true, readyPacketLinks: true, projectCreateFlow: true, promptImproveFlow: true, planningFlow: true, demoSeed: true, managerHealth: true }
        }
      });
      const data = (readiness as { data: { api: { callTools: string[]; readRoutes: string[] } } }).data;
      expect(data.api.callTools).toContain("project_queue_claim_next");
      expect(data.api.callTools).toContain("model_brain_route");
      expect(data.api.readRoutes).toContain("/api/bootstrap");
      expect(data.api.readRoutes).toContain("/api/queues/:queueId/snapshot");
      expect(data.api.readRoutes).toContain("/api/queues/:queueId/action-inbox");
      expect(data.api.readRoutes).toContain("/api/queues/:queueId/health");
      expect(data.api.readRoutes).toContain("/api/queues/:queueId/tasks/:queueTaskId/packet");
      expect(data.api.readRoutes).toContain("/api/queues/:queueId/ready-packet-links");
    }, fakeCaller(calls));

    expect(calls).toEqual([{ tool: "fabric_status", input: {} }]);
  });

  it("creates project queues through the prompt-improvement pipeline route", async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    await withDesktop(async ({ url }) => {
      const created = await postJson(`${url}api/project-create`, {
        projectPath: "/tmp/app",
        title: "Pipeline queue",
        prompt: "Build the command center queue.",
        pipelineProfile: "careful",
        maxParallelAgents: 4
      });
      expect(created.status).toBe(200);
      expect(created.body).toMatchObject({ ok: true, data: { queueId: "queue_created" } });
    }, fakeCaller(calls));

    expect(calls).toEqual([
      {
        tool: "project_queue_create",
        input: {
          projectPath: "/tmp/app",
          prompt: "Build the command center queue.",
          promptSummary: undefined,
          title: "Pipeline queue",
          pipelineProfile: "careful",
          maxParallelAgents: 4
        }
      },
      {
        tool: "project_queue_record_stage",
        input: {
          queueId: "queue_created",
          stage: "prompt_improvement",
          status: "pending",
          modelAlias: "prompt.improve.strong",
          inputSummary: "Prompt captured by project CLI; raw prompt remains outside agent-fabric storage.",
          warnings: ["Review the improved prompt before planning."]
        }
      }
    ]);
  });

  it("runs prompt improvement through the desktop project pipeline route", async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const caller: DesktopToolCaller = async (tool, input) => {
      calls.push({ tool, input });
      if (tool === "project_queue_status") return { queue: { queueId: input.queueId, projectPath: "/tmp/app", status: "prompt_review", maxParallelAgents: 4 }, tasks: [] };
      if (tool === "policy_resolve_alias") return { alias: input.alias, provider: "test", model: "cheap-model", reasoning: "low" };
      if (tool === "llm_preflight") return { requestId: "llm_1", decision: "allow", risk: "medium", warnings: [] };
      if (tool === "project_queue_record_stage") return { stageId: "stage_prompt", queueId: input.queueId, stage: input.stage, status: input.status };
      if (tool === "project_queue_decide") return { decision: input.decision, status: "planning" };
      throw new Error(`Unexpected prompt improve call: ${tool}`);
    };

    await withDesktop(
      async ({ url }) => {
        const improved = await postJson(`${url}api/project-improve-prompt`, {
          queueId: "queue_1",
          prompt: "make app",
          modelAlias: "execute.cheap",
          accept: true
        });
        expect(improved.status).toBe(200);
        expect(improved.body).toMatchObject({
          ok: true,
          data: {
            action: "prompt_improved",
            improvedPrompt: "Improved: make app with clear acceptance criteria.",
            summary: "Prompt clarified."
          }
        });
      },
      caller,
      {
        projectModelRunner: async (request) => ({
          improvedPrompt: `Improved: ${String(request.input.prompt)} with clear acceptance criteria.`,
          summary: "Prompt clarified.",
          warnings: ["Review scope."]
        })
      }
    );

    expect(calls.map((call) => call.tool)).toEqual([
      "project_queue_status",
      "policy_resolve_alias",
      "llm_preflight",
      "project_queue_record_stage",
      "project_queue_decide"
    ]);
  });

  it("starts a plan chain through the desktop project pipeline route", async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const caller: DesktopToolCaller = async (tool, input) => {
      calls.push({ tool, input });
      if (tool === "plan_chain_start") return { chainId: "chain_1", status: "running" };
      if (tool === "project_queue_record_stage") return { stageId: "stage_plan", queueId: input.queueId, stage: input.stage, status: input.status };
      throw new Error(`Unexpected start plan call: ${tool}`);
    };

    await withDesktop(async ({ url }) => {
      const planned = await postJson(`${url}api/project-start-plan`, {
        queueId: "queue_1",
        task: "Plan the accepted Desktop command center prompt.",
        maxRounds: 3,
        budgetUsd: 1.25,
        outputFormat: "adr"
      });
      expect(planned.status).toBe(200);
      expect(planned.body).toMatchObject({
        ok: true,
        data: {
          action: "plan_started",
          chainId: "chain_1",
          status: "running"
        }
      });
    }, caller);

    expect(calls).toEqual([
      {
        tool: "plan_chain_start",
        input: {
          task: "Plan the accepted Desktop command center prompt.",
          models: { a: "plan.strong", b: "plan.strong", c: "plan.strong" },
          maxRounds: 3,
          budgetUsd: 1.25,
          outputFormat: "adr"
        }
      },
      {
        tool: "project_queue_record_stage",
        input: {
          queueId: "queue_1",
          stage: "planning",
          status: "running",
          modelAlias: "plan.strong",
          planChainId: "chain_1",
          inputSummary: "Plan chain started from project CLI.",
          artifacts: [{ kind: "plan_chain", chainId: "chain_1" }]
        }
      }
    ]);
  });

  it("seeds a realistic demo queue through the authenticated desktop route", async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    let claimCount = 0;
    const caller: DesktopToolCaller = async (tool, input) => {
      calls.push({ tool, input });
      if (tool === "project_queue_create") return { queueId: "queue_demo" };
      if (tool === "project_queue_record_stage") return { stageId: `stage_${calls.length}` };
      if (tool === "project_queue_decide") return { decision: input.decision, status: input.decision === "start_execution" ? "running" : "queue_review" };
      if (tool === "memory_write") return { id: "mem_demo" };
      if (tool === "project_queue_add_tasks") {
        const tasks = Array.isArray(input.tasks) ? input.tasks : [];
        return {
          queueId: "queue_demo",
          created: tasks.map((task) => {
            const record = task as Record<string, unknown>;
            return {
              clientKey: record.clientKey,
              queueTaskId: `task_${String(record.clientKey)}`,
              fabricTaskId: `fabric_${String(record.clientKey)}`,
              title: record.title,
              status: record.status ?? "queued"
            };
          })
        };
      }
      if (tool === "tool_context_policy_set") return { grantKey: `${input.grantKind}:${input.value}`, status: input.status };
      if (tool === "project_queue_prepare_ready") return { queueId: "queue_demo", prepared: [{}], blocked: [], activeWorkers: 0, availableSlots: 4, summary: { approvalRequired: 1 } };
      if (tool === "project_queue_claim_next") {
        claimCount += 1;
        const key = claimCount === 1 ? "lane-telemetry" : "queue-health";
        return {
          queueId: "queue_demo",
          claimed: {
            queueTaskId: `task_${key}`,
            fabricTaskId: `fabric_${key}`,
            title: key,
            goal: `Demo goal for ${key}.`
          },
          workerRun: { workerRunId: `wrun_${key}`, worker: input.worker, status: "running" },
          activeWorkers: claimCount,
          availableSlots: 4 - claimCount,
          blocked: []
        };
      }
      if (tool === "fabric_task_event") return { eventId: `event_${calls.length}`, taskId: input.taskId, workerRunId: input.workerRunId };
      if (tool === "fabric_task_checkpoint") return { checkpointId: `checkpoint_${calls.length}`, taskId: input.taskId };
      if (tool === "project_queue_update_task") return { queueTaskId: input.queueTaskId, status: input.status };
      if (tool === "project_queue_dashboard")
        return {
          queue: { queueId: "queue_demo", projectPath: "/tmp/desktop-demo", status: "running", maxParallelAgents: 4 },
          activeWorkers: 2,
          counts: { running: 2, queued: 3, patch_ready: 1, failed: 1 }
        };
      if (tool === "project_queue_approval_inbox")
        return {
          count: 1,
          toolContextCount: 1,
          modelCallCount: 0,
          toolContext: [{ proposalId: "proposal_github", missingGrants: [{ grantKey: "mcp_server:github" }] }],
          modelCalls: []
        };
      if (tool === "project_queue_agent_lanes") return { count: 2, lanes: [] };
      throw new Error(`Unexpected demo seed call: ${tool}`);
    };

    await withDesktop(async ({ url }) => {
      const seeded = await postJson(`${url}api/demo-seed`, {
        projectPath: "/tmp/desktop-demo",
        title: "Desktop Demo",
        maxParallelAgents: 4
      });
      expect(seeded.status).toBe(200);
      expect(seeded.body).toMatchObject({
        ok: true,
        data: {
          queueId: "queue_demo",
          projectPath: "/tmp/desktop-demo",
          title: "Desktop Demo",
          activeWorkers: 2,
          pendingApprovalCount: 1,
          laneCount: 2
        }
      });
    }, caller);

    expect(calls.map((call) => call.tool)).toContain("memory_write");
    expect(calls.map((call) => call.tool)).toContain("project_queue_prepare_ready");
    expect(calls.filter((call) => call.tool === "project_queue_claim_next")).toHaveLength(2);
    expect(calls.filter((call) => call.tool === "fabric_task_event").length).toBeGreaterThanOrEqual(10);
    expect(calls.filter((call) => call.tool === "fabric_task_checkpoint")).toHaveLength(2);
  });

  it("exposes a bootstrap payload for first desktop render", async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    await withDesktop(async ({ url }) => {
      const bootstrap = await getJson(`${url}api/bootstrap?projectPath=%2Ftmp%2Fapp&queueId=queue_1&queueTaskId=task_1&timelineLimit=20&maxEvents=3&memoryMax=7&maxTaskEvents=4`);
      expect(bootstrap).toMatchObject({
        ok: true,
        data: {
          readiness: { ready: true },
          queues: { queues: [{ queueId: "queue_1" }] },
          selectedQueueId: "queue_1",
          snapshot: {
            dashboard: { queue: { queueId: "queue_1" } },
            memoryInbox: { total: 1 },
            actionInbox: { schema: "agent-fabric.desktop-action-inbox.v1", total: 2 }
          },
          taskDetail: { task: { queueTaskId: "task_1" } }
        }
      });
    }, fakeCaller(calls));

    expect(calls).toEqual([
      { tool: "fabric_status", input: {} },
      {
        tool: "project_queue_list",
        input: { projectPath: "/tmp/app", includeClosed: undefined, statuses: [], limit: undefined }
      },
      { tool: "project_queue_dashboard", input: { queueId: "queue_1" } },
      {
        tool: "project_queue_review_matrix",
        input: { queueId: "queue_1", limit: undefined }
      },
      {
        tool: "project_queue_approval_inbox",
        input: { queueId: "queue_1", includeExpired: false }
      },
      {
        tool: "project_queue_timeline",
        input: { queueId: "queue_1", limit: 20 }
      },
      {
        tool: "project_queue_agent_lanes",
        input: { queueId: "queue_1", maxEventsPerLane: 3 }
      },
      {
        tool: "memory_list",
        input: { status: "pending_review", max: 7 }
      },
      {
        tool: "project_queue_task_detail",
        input: { queueId: "queue_1", queueTaskId: "task_1", includeResume: true, maxEventsPerRun: 4 }
      }
    ]);
  });

  it("builds a desktop action inbox from queue snapshot inputs", async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    await withDesktop(async ({ url }) => {
      const inbox = await getJson(`${url}api/queues/queue_1/action-inbox?timelineLimit=10&maxEvents=2&memoryMax=5`);
      expect(inbox).toMatchObject({
        ok: true,
        data: {
          schema: "agent-fabric.desktop-action-inbox.v1",
          queueId: "queue_1",
          total: 2,
          counts: { attention: 2 },
          items: [
            { kind: "patch_review", title: "Review patch-ready output", queueTaskId: "task_1" },
            { kind: "memory_review", title: "Review pending memories" }
          ]
        }
      });
    }, fakeCaller(calls));

    expect(calls).toEqual([
      { tool: "project_queue_dashboard", input: { queueId: "queue_1" } },
      {
        tool: "project_queue_review_matrix",
        input: { queueId: "queue_1", limit: undefined }
      },
      {
        tool: "project_queue_approval_inbox",
        input: { queueId: "queue_1", includeExpired: false }
      },
      {
        tool: "project_queue_timeline",
        input: { queueId: "queue_1", limit: 10 }
      },
      {
        tool: "project_queue_agent_lanes",
        input: { queueId: "queue_1", maxEventsPerLane: 2 }
      },
      {
        tool: "memory_list",
        input: { status: "pending_review", max: 5 }
      }
    ]);
  });

  it("exposes a compact manager health endpoint for queue dashboards", async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    await withDesktop(async ({ url }) => {
      const health = await getJson(`${url}api/queues/queue_1/health?maxEvents=7&managerSummaryLimit=4`);
      expect(health).toMatchObject({
        ok: true,
        data: {
          schema: "agent-fabric.desktop-manager-health.v1",
          queue: { queueId: "queue_1" },
          summary: { status: "running", nextAction: "Watch active worker lanes." },
          managerSummary: { bounded: true, maxItemsPerSection: 4 },
          nextActions: [{ label: "Open active lanes" }],
          verificationChecklist: ["Review every patch-ready task before acceptance."]
        }
      });
    }, fakeCaller(calls));

    expect(calls).toEqual([
      {
        tool: "project_queue_progress_report",
        input: { queueId: "queue_1", maxEventsPerLane: 7, managerSummaryLimit: 4 }
      }
    ]);
  });

  it("exposes focused queue read endpoints through the fabric caller", async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    await withDesktop(async ({ url }) => {
      const status = await getJson(`${url}api/status`);
      expect(status).toMatchObject({ ok: true, data: { daemon: { status: "ok" } } });

      const queues = await getJson(`${url}api/queues?projectPath=%2Ftmp%2Fapp&includeClosed=true&status=active&limit=8`);
      expect(queues).toMatchObject({ ok: true, data: { queues: [{ queueId: "queue_1" }] } });

      const snapshot = await getJson(`${url}api/queues/queue_1/snapshot?timelineLimit=40&maxEvents=5&memoryMax=25`);
      expect(snapshot).toMatchObject({ ok: true, data: { dashboard: { queue: { queueId: "queue_1" } }, memoryInbox: { total: 1 } } });

      const task = await getJson(`${url}api/queues/queue_1/tasks/task_1?includeResume=1&maxEventsPerRun=5`);
      expect(task).toMatchObject({ ok: true, data: { task: { queueTaskId: "task_1" } } });

      const packet = await getJson(
        `${url}api/queues/queue_1/tasks/task_1/packet?format=markdown&includeResume=1&preferredWorker=openhands&workspaceMode=sandbox&workspacePath=%2Ftmp%2Fwork&modelProfile=execute.cheap`
      );
      expect(packet).toMatchObject({ ok: true, data: { packetKind: "task", markdown: "# Task" } });

      const readyLinks = await getJson(
        `${url}api/queues/queue_1/ready-packet-links?limit=3&format=markdown&includeResume=1&preferredWorker=local-cli&workspaceMode=git_worktree&modelProfile=execute.cheap`
      );
      expect(readyLinks).toMatchObject({
        ok: true,
        data: {
          schema: "agent-fabric.desktop-ready-packet-links.v1",
          queueId: "queue_1",
          count: 1,
          links: [{ queueTaskId: "task_1", packetApiPath: "/api/queues/queue_1/tasks/task_1/packet?format=markdown&includeResume=1&preferredWorker=local-cli&workspaceMode=git_worktree&modelProfile=execute.cheap" }]
        }
      });

      const memory = await getJson(`${url}api/memory/pending?max=25`);
      expect(memory).toMatchObject({ ok: true, data: { total: 1 } });
    }, fakeCaller(calls));

    expect(calls).toEqual([
      { tool: "fabric_status", input: {} },
      {
        tool: "project_queue_list",
        input: { projectPath: "/tmp/app", includeClosed: true, statuses: ["active"], limit: 8 }
      },
      { tool: "project_queue_dashboard", input: { queueId: "queue_1" } },
      {
        tool: "project_queue_review_matrix",
        input: { queueId: "queue_1", limit: undefined }
      },
      {
        tool: "project_queue_approval_inbox",
        input: { queueId: "queue_1", includeExpired: false }
      },
      {
        tool: "project_queue_timeline",
        input: { queueId: "queue_1", limit: 40 }
      },
      {
        tool: "project_queue_agent_lanes",
        input: { queueId: "queue_1", maxEventsPerLane: 5 }
      },
      {
        tool: "memory_list",
        input: { status: "pending_review", max: 25 }
      },
      {
        tool: "project_queue_task_detail",
        input: { queueId: "queue_1", queueTaskId: "task_1", includeResume: true, maxEventsPerRun: 5 }
      },
      {
        tool: "project_queue_task_packet",
        input: {
          queueId: "queue_1",
          queueTaskId: "task_1",
          format: "markdown",
          includeResume: true,
          preferredWorker: "openhands",
          workspaceMode: "sandbox",
          workspacePath: "/tmp/work",
          modelProfile: "execute.cheap"
        }
      },
      {
        tool: "project_queue_launch_plan",
        input: { queueId: "queue_1", limit: 3 }
      },
      {
        tool: "memory_list",
        input: { status: "pending_review", max: 25 }
      }
    ]);
  });

  it("allows only the desktop-safe API call surface", async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    await withDesktop(async ({ url }) => {
      const blocked = await postJson(`${url}api/call`, { tool: "memory_write", input: { body: "secret" } });
      expect(blocked.status).toBe(400);
      expect(blocked.body).toMatchObject({
        ok: false,
        error: { code: "TOOL_NOT_ALLOWED" }
      });

      const allowed = await postJson(`${url}api/call`, {
        tool: "project_queue_decide",
        input: { queueId: "queue_1", decision: "start_execution" }
      });
      expect(allowed.status).toBe(200);
      expect(allowed.body).toMatchObject({ ok: true, data: { decided: true } });

      const created = await postJson(`${url}api/call`, {
        tool: "project_queue_create",
        input: {
          projectPath: "/tmp/app",
          prompt: "Build the command center queue.",
          pipelineProfile: "balanced",
          maxParallelAgents: 4
        }
      });
      expect(created.status).toBe(200);
      expect(created.body).toMatchObject({ ok: true, data: { queueId: "queue_created" } });

      const stage = await postJson(`${url}api/call`, {
        tool: "project_queue_record_stage",
        input: { queueId: "queue_1", stage: "task_writing", status: "completed" }
      });
      expect(stage.status).toBe(200);
      expect(stage.body).toMatchObject({ ok: true, data: { stageId: "stage_1" } });

      const added = await postJson(`${url}api/call`, {
        tool: "project_queue_add_tasks",
        input: { queueId: "queue_1", tasks: [{ title: "Task", goal: "Do work." }] }
      });
      expect(added.status).toBe(200);
      expect(added.body).toMatchObject({ ok: true, data: { created: [{ queueTaskId: "task_created" }] } });

      const updated = await postJson(`${url}api/call`, {
        tool: "project_queue_update_task_metadata",
        input: { queueId: "queue_1", queueTaskId: "task_created", risk: "low" }
      });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ ok: true, data: { task: { risk: "low" } } });

      const packet = await postJson(`${url}api/call`, {
        tool: "project_queue_task_packet",
        input: { queueId: "queue_1", queueTaskId: "task_created", format: "markdown" }
      });
      expect(packet.status).toBe(200);
      expect(packet.body).toMatchObject({ ok: true, data: { packetKind: "task", markdown: "# Task" } });

      const claimed = await postJson(`${url}api/call`, {
        tool: "project_queue_claim_next",
        input: { queueId: "queue_1", worker: "local-cli", workspaceMode: "git_worktree", modelProfile: "execute.cheap" }
      });
      expect(claimed.status).toBe(200);
      expect(claimed.body).toMatchObject({ ok: true, data: { claimed: { queueTaskId: "task_created" }, workerRun: { worker: "local-cli" } } });

      const outcome = await postJson(`${url}api/call`, {
        tool: "project_queue_update_task",
        input: { queueId: "queue_1", queueTaskId: "task_created", status: "patch_ready", patchRefs: ["patch.diff"], testRefs: ["npm test"] }
      });
      expect(outcome.status).toBe(200);
      expect(outcome.body).toMatchObject({ ok: true, data: { status: "patch_ready" } });

      const retried = await postJson(`${url}api/call`, {
        tool: "project_queue_retry_task",
        input: { queueId: "queue_1", queueTaskId: "task_created", reason: "Retry from test.", clearOutputs: true }
      });
      expect(retried.status).toBe(200);
      expect(retried.body).toMatchObject({ ok: true, data: { task: { status: "queued" } } });

      const recovered = await postJson(`${url}api/call`, {
        tool: "project_queue_recover_stale",
        input: { queueId: "queue_1", staleAfterMinutes: 30, action: "requeue", dryRun: true }
      });
      expect(recovered.status).toBe(200);
      expect(recovered.body).toMatchObject({ ok: true, data: { count: 0, dryRun: true } });

      const policy = await postJson(`${url}api/call`, {
        tool: "tool_context_policy_set",
        input: { projectPath: "/tmp/app", grantKind: "mcp_server", value: "github", status: "approved" }
      });
      expect(policy.status).toBe(200);
      expect(policy.body).toMatchObject({ ok: true, data: { grantKey: "mcp_server:github", status: "approved" } });

      const policyStatus = await postJson(`${url}api/call`, {
        tool: "tool_context_policy_status",
        input: { projectPath: "/tmp/app" }
      });
      expect(policyStatus.status).toBe(200);
      expect(policyStatus.body).toMatchObject({ ok: true, data: { projectPath: "/tmp/app", grants: [{ grantKey: "mcp_server:github", status: "approved" }] } });

      const proposal = await postJson(`${url}api/call`, {
        tool: "tool_context_propose",
        input: { queueId: "queue_1", queueTaskId: "task_created", tools: ["shell"], mcpServers: ["github"] }
      });
      expect(proposal.status).toBe(200);
      expect(proposal.body).toMatchObject({ ok: true, data: { proposalId: "proposal_1", approvalRequired: true } });

      const brain = await postJson(`${url}api/call`, {
        tool: "model_brain_route",
        input: {
          roleAlias: "execute.cheap",
          task: { type: "code_edit", goal: "Edit code." },
          contextPackageSummary: { inputTokens: 8000 },
          risk: "medium",
          enforce: true
        }
      });
      expect(brain.status).toBe(200);
      expect(brain.body).toMatchObject({ ok: true, data: { schema: "agent-fabric.model-brain-route.v1" } });

      const memories = await postJson(`${url}api/call`, {
        tool: "memory_list",
        input: { status: "pending_review", max: 25 }
      });
      expect(memories.status).toBe(200);
      expect(memories.body).toMatchObject({ ok: true, data: { total: 1 } });

      const reviewed = await postJson(`${url}api/call`, {
        tool: "memory_review",
        input: { id: "mem_1", decision: "approve", reason: "desktop test" }
      });
      expect(reviewed.status).toBe(200);
      expect(reviewed.body).toMatchObject({ ok: true, data: { id: "mem_1", status: "active" } });
    }, fakeCaller(calls));

    expect(calls).toEqual([
      {
        tool: "project_queue_decide",
        input: { queueId: "queue_1", decision: "start_execution" }
      },
      {
        tool: "project_queue_create",
        input: {
          projectPath: "/tmp/app",
          prompt: "Build the command center queue.",
          pipelineProfile: "balanced",
          maxParallelAgents: 4
        }
      },
      {
        tool: "project_queue_record_stage",
        input: { queueId: "queue_1", stage: "task_writing", status: "completed" }
      },
      {
        tool: "project_queue_add_tasks",
        input: { queueId: "queue_1", tasks: [{ title: "Task", goal: "Do work." }] }
      },
      {
        tool: "project_queue_update_task_metadata",
        input: { queueId: "queue_1", queueTaskId: "task_created", risk: "low" }
      },
      {
        tool: "project_queue_task_packet",
        input: { queueId: "queue_1", queueTaskId: "task_created", format: "markdown" }
      },
      {
        tool: "project_queue_claim_next",
        input: { queueId: "queue_1", worker: "local-cli", workspaceMode: "git_worktree", modelProfile: "execute.cheap" }
      },
      {
        tool: "project_queue_update_task",
        input: { queueId: "queue_1", queueTaskId: "task_created", status: "patch_ready", patchRefs: ["patch.diff"], testRefs: ["npm test"] }
      },
      {
        tool: "project_queue_retry_task",
        input: { queueId: "queue_1", queueTaskId: "task_created", reason: "Retry from test.", clearOutputs: true }
      },
      {
        tool: "project_queue_recover_stale",
        input: { queueId: "queue_1", staleAfterMinutes: 30, action: "requeue", dryRun: true }
      },
      {
        tool: "tool_context_policy_set",
        input: { projectPath: "/tmp/app", grantKind: "mcp_server", value: "github", status: "approved" }
      },
      {
        tool: "tool_context_policy_status",
        input: { projectPath: "/tmp/app" }
      },
      {
        tool: "tool_context_propose",
        input: { queueId: "queue_1", queueTaskId: "task_created", tools: ["shell"], mcpServers: ["github"] }
      },
      {
        tool: "model_brain_route",
        input: {
          roleAlias: "execute.cheap",
          task: { type: "code_edit", goal: "Edit code." },
          contextPackageSummary: { inputTokens: 8000 },
          risk: "medium",
          enforce: true
        }
      },
      {
        tool: "memory_list",
        input: { status: "pending_review", max: 25 }
      },
      {
        tool: "memory_review",
        input: { id: "mem_1", decision: "approve", reason: "desktop test" }
      }
    ]);
  });

  it("requires a local mutation token for the API call surface", async () => {
    await withDesktop(async ({ url }) => {
      const unauthorized = await postJson(`${url}api/call`, { tool: "project_queue_decide", input: { queueId: "queue_1", decision: "start_execution" } }, null);
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.body).toMatchObject({
        ok: false,
        error: { code: "DESKTOP_AUTH_REQUIRED" }
      });

      const unauthorizedProjectCreate = await postJson(`${url}api/project-create`, { projectPath: "/tmp/app", prompt: "Build." }, null);
      expect(unauthorizedProjectCreate.status).toBe(401);
      expect(unauthorizedProjectCreate.body).toMatchObject({
        ok: false,
        error: { code: "DESKTOP_AUTH_REQUIRED" }
      });

      const unauthorizedPromptImprove = await postJson(`${url}api/project-improve-prompt`, { queueId: "queue_1", prompt: "Build." }, null);
      expect(unauthorizedPromptImprove.status).toBe(401);
      expect(unauthorizedPromptImprove.body).toMatchObject({
        ok: false,
        error: { code: "DESKTOP_AUTH_REQUIRED" }
      });

      const unauthorizedStartPlan = await postJson(`${url}api/project-start-plan`, { queueId: "queue_1", task: "Plan." }, null);
      expect(unauthorizedStartPlan.status).toBe(401);
      expect(unauthorizedStartPlan.body).toMatchObject({
        ok: false,
        error: { code: "DESKTOP_AUTH_REQUIRED" }
      });

      const unauthorizedDemoSeed = await postJson(`${url}api/demo-seed`, { projectPath: "/tmp/demo" }, null);
      expect(unauthorizedDemoSeed.status).toBe(401);
      expect(unauthorizedDemoSeed.body).toMatchObject({
        ok: false,
        error: { code: "DESKTOP_AUTH_REQUIRED" }
      });
    });
  });

  it("rejects non-loopback Host headers before serving the desktop UI or API", async () => {
    await withDesktop(async ({ url }) => {
      const blocked = await rawRequest(url, { host: "example.test" });
      expect(blocked.status).toBe(403);
      expect(blocked.body).toMatchObject({ ok: false, error: { code: "DESKTOP_HOST_FORBIDDEN" } });

      const allowed = await getJson(`${url}api/readiness`);
      expect(allowed).toMatchObject({ ok: true, data: { ready: true } });
    });
  });

  it("returns explicit API errors for malformed mutation request bodies", async () => {
    await withDesktop(async ({ url, apiToken }) => {
      const nonJson = await postRaw(`${url}api/call`, "tool=project_queue_decide", apiToken, "text/plain");
      expect(nonJson.status).toBe(415);
      expect(nonJson.body).toMatchObject({ ok: false, error: { code: "DESKTOP_JSON_REQUIRED" } });

      const malformed = await postRaw(`${url}api/call`, "{", apiToken);
      expect(malformed.status).toBe(400);
      expect(malformed.body).toMatchObject({ ok: false, error: { code: "INVALID_JSON" } });

      const wrongShape = await postRaw(`${url}api/call`, "[]", apiToken);
      expect(wrongShape.status).toBe(400);
      expect(wrongShape.body).toMatchObject({ ok: false, error: { code: "INVALID_JSON_BODY" } });

      const tooLarge = await postRaw(`${url}api/call`, JSON.stringify({ tool: "project_queue_decide", input: { padding: "x".repeat(1_000_001) } }), apiToken);
      expect(tooLarge.status).toBe(413);
      expect(tooLarge.body).toMatchObject({ ok: false, error: { code: "PAYLOAD_TOO_LARGE" } });
    });
  });

  it("validates the desktop mutation envelope before dispatching tools", async () => {
    await withDesktop(async ({ url }) => {
      const missingTool = await postJson(`${url}api/call`, { input: {} });
      expect(missingTool.status).toBe(400);
      expect(missingTool.body).toMatchObject({ ok: false, error: { code: "INVALID_TOOL_NAME" } });

      const blankTool = await postJson(`${url}api/call`, { tool: "  ", input: {} });
      expect(blankTool.status).toBe(400);
      expect(blankTool.body).toMatchObject({ ok: false, error: { code: "INVALID_TOOL_NAME" } });

      const arrayInput = await postJson(`${url}api/call`, { tool: "project_queue_decide", input: [] });
      expect(arrayInput.status).toBe(400);
      expect(arrayInput.body).toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });

      const scalarInput = await postJson(`${url}api/call`, { tool: "project_queue_decide", input: "queue_1" });
      expect(scalarInput.status).toBe(400);
      expect(scalarInput.body).toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    });
  });

  it("rejects non-loopback binds before exposing the mutating API call surface", async () => {
    await expect(startDesktopServer({ host: "0.0.0.0", port: 0, toolCaller: fakeCaller([]) })).rejects.toThrow(/loopback/i);
  });

  it("inspects captured context packages by request id", async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    await withDesktop(async ({ url }) => {
      const inspected = await getJson(`${url}api/context/preflight_123`);
      expect(inspected).toMatchObject({
        ok: true,
        data: { requestId: "preflight_123", wasteAnalysis: { severity: "low" } }
      });
    }, fakeCaller(calls));

    expect(calls).toEqual([
      {
        tool: "fabric_inspect_context_package",
        input: { requestId: "preflight_123" }
      }
    ]);
  });
});

const desktopApiTokens = new Map<string, string>();

async function withDesktop<T>(
  fn: (ctx: { url: string; apiToken: string }) => Promise<T>,
  caller: DesktopToolCaller = fakeCaller([]),
  options: Omit<DesktopServerOptions, "host" | "port" | "toolCaller"> = {}
): Promise<T> {
  const runtime = await startDesktopServer({ host: "127.0.0.1", port: 0, toolCaller: caller, ...options });
  desktopApiTokens.set(runtime.url, runtime.apiToken);
  try {
    return await fn({ url: runtime.url, apiToken: runtime.apiToken });
  } finally {
    desktopApiTokens.delete(runtime.url);
    await runtime.close();
  }
}

function fakeCaller(calls: Array<{ tool: string; input: Record<string, unknown> }>): DesktopToolCaller {
  return async (tool, input) => {
    calls.push({ tool, input });
    if (tool === "fabric_status") return { daemon: { status: "ok" } };
    if (tool === "project_queue_list") return { queues: [{ queueId: "queue_1", title: "Desktop queue" }] };
    if (tool === "project_queue_dashboard")
      return {
        queue: { queueId: input.queueId, status: "running", maxParallelAgents: 4 },
        summaryStrip: {
          status: "review_ready",
          nextAction: "Review patch-ready output.",
          counts: { ready: 0, availableSlots: 4, staleRunning: 0, pendingApprovals: 0, failed: 0 }
        },
        queueBoard: {
          ready: [],
          running: [],
          review: [{ queueTaskId: "task_1", title: "Patch-ready task", status: "patch_ready" }],
          blocked: []
        }
      };
    if (tool === "project_queue_review_matrix") return { queue: { queueId: input.queueId }, buckets: [] };
    if (tool === "project_queue_approval_inbox") return { queueId: input.queueId, toolContext: [], modelCalls: [] };
    if (tool === "project_queue_timeline") return { queueId: input.queueId, items: [] };
    if (tool === "project_queue_agent_lanes") return { queueId: input.queueId, lanes: [] };
    if (tool === "project_queue_progress_report")
      return {
        schema: "agent-fabric.project-queue-progress.v1",
        queue: { queueId: input.queueId },
        generatedAt: "2026-05-07T00:00:00.000Z",
        summary: { status: "running", nextAction: "Watch active worker lanes." },
        counts: { running: 2 },
        managerSummary: { bounded: true, maxItemsPerSection: input.managerSummaryLimit, groups: { byManager: [] } },
        nextActions: [{ label: "Open active lanes" }],
        verificationChecklist: ["Review every patch-ready task before acceptance."]
      };
    if (tool === "project_queue_launch_plan")
      return {
        queueId: input.queueId,
        summary: { launchable: 1, scheduled: 1 },
        availableSlots: 1,
        maxParallelAgents: 4,
        launchable: [{ task: { queueTaskId: "task_1", title: "Ready task", status: "queued", risk: "low", priority: "normal" } }]
      };
    if (tool === "project_queue_task_detail") return { task: { queueTaskId: input.queueTaskId } };
    if (tool === "project_queue_decide") return { decided: true };
    if (tool === "project_queue_create") return { queueId: "queue_created", rawPromptStored: false };
    if (tool === "project_queue_record_stage") return { stageId: "stage_1" };
    if (tool === "project_queue_add_tasks") return { created: [{ queueTaskId: "task_created" }] };
    if (tool === "project_queue_update_task_metadata") return { task: { queueTaskId: input.queueTaskId, risk: input.risk } };
    if (tool === "project_queue_task_packet") return { packetKind: "task", markdown: "# Task", packet: { schema: "agent-fabric.task-packet.v1" } };
    if (tool === "project_queue_claim_next") return { claimed: { queueTaskId: "task_created" }, workerRun: { worker: input.worker, workerRunId: "wrun_1" } };
    if (tool === "project_queue_update_task") return { queueTaskId: input.queueTaskId, status: input.status };
    if (tool === "project_queue_retry_task") return { task: { queueTaskId: input.queueTaskId, status: "queued" } };
    if (tool === "project_queue_recover_stale") return { count: 0, dryRun: input.dryRun, action: input.action, recovered: [] };
    if (tool === "tool_context_propose") return { proposalId: "proposal_1", approvalRequired: true, missingGrants: [{ grantKey: "tool:shell" }] };
    if (tool === "tool_context_policy_set") return { grantKey: `${input.grantKind}:${input.value}`, status: input.status };
    if (tool === "tool_context_policy_status") return { projectPath: input.projectPath, grants: [{ grantKey: "mcp_server:github", grantKind: "mcp_server", value: "github", status: "approved" }] };
    if (tool === "model_brain_route") return { schema: "agent-fabric.model-brain-route.v1", decision: "allow", route: { model: "deepseek-v4-pro" } };
    if (tool === "memory_list") return { memories: [{ id: "mem_1", status: "pending_review", body: "Use isolated fixture state.", type: "procedural" }], total: 1 };
    if (tool === "memory_review") return { id: input.id, decision: input.decision, previousStatus: "pending_review", status: input.decision === "approve" ? "active" : "archived" };
    if (tool === "fabric_inspect_context_package") return { requestId: input.requestId, wasteAnalysis: { severity: "low" } };
    throw new Error(`Unexpected tool call: ${tool}`);
  };
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return response.json();
}

async function postJson(url: string, body: unknown, apiToken: string | null | undefined = tokenForUrl(url)): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(apiToken ? { "x-agent-fabric-desktop-token": apiToken } : {}) },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function postRaw(
  url: string,
  body: string,
  apiToken: string | null | undefined = tokenForUrl(url),
  contentType = "application/json"
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": contentType, ...(apiToken ? { "x-agent-fabric-desktop-token": apiToken } : {}) },
    body
  });
  return { status: response.status, body: await response.json() };
}

function tokenForUrl(url: string): string | undefined {
  const parsed = new URL(url);
  return desktopApiTokens.get(`${parsed.origin}/`);
}

function rawRequest(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, body: body ? JSON.parse(body) : undefined });
        });
      }
    );
    request.on("error", reject);
    request.end();
  });
}
