import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FabricDaemon } from "../src/daemon.js";
import { formatProjectResult, parseProjectCliArgs, runProjectCommand, type ProjectToolCaller } from "../src/runtime/project-cli.js";
import type { BridgeRegister, BridgeSession } from "../src/types.js";

describe("project CLI runner", () => {
  const originalSeniorMode = process.env.AGENT_FABRIC_SENIOR_MODE;
  const originalSeniorNonDeepSeek = process.env.AGENT_FABRIC_SENIOR_ALLOW_NON_DEEPSEEK_WORKERS;
  const originalSeniorDefaultWorker = process.env.AGENT_FABRIC_SENIOR_DEFAULT_WORKER;
  const originalSeniorDefaultLaneCount = process.env.AGENT_FABRIC_SENIOR_DEFAULT_LANE_COUNT;
  const originalSeniorLaneCount = process.env.AGENT_FABRIC_SENIOR_LANE_COUNT;
  const originalSeniorMaxLaneCount = process.env.AGENT_FABRIC_SENIOR_MAX_LANE_COUNT;
  const originalQueueMaxAgents = process.env.AGENT_FABRIC_QUEUE_MAX_AGENTS;

  beforeEach(() => {
    delete process.env.AGENT_FABRIC_SENIOR_MODE;
    delete process.env.AGENT_FABRIC_SENIOR_ALLOW_NON_DEEPSEEK_WORKERS;
    delete process.env.AGENT_FABRIC_SENIOR_DEFAULT_WORKER;
    delete process.env.AGENT_FABRIC_SENIOR_DEFAULT_LANE_COUNT;
    delete process.env.AGENT_FABRIC_SENIOR_LANE_COUNT;
    delete process.env.AGENT_FABRIC_SENIOR_MAX_LANE_COUNT;
    delete process.env.AGENT_FABRIC_QUEUE_MAX_AGENTS;
  });

  it("redacts approval tokens from JSON output", () => {
    const output = formatProjectResult(
      {
        action: "senior_run",
        message: "ok",
        data: {
          approvalToken: "queue-secret",
          modelApproval: {
            approvalToken: "top-secret",
            approval: {
              approvalToken: "nested-secret",
              tokenExpiresAt: "2026-05-07T00:00:00.000Z"
            }
          }
        }
      },
      true
    );

    expect(output).not.toContain("queue-secret");
    expect(output).not.toContain("top-secret");
    expect(output).not.toContain("nested-secret");
    expect(output).toContain("[redacted]");
    expect(output).toContain("tokenExpiresAt");
  });

  afterEach(() => {
    if (originalSeniorMode === undefined) delete process.env.AGENT_FABRIC_SENIOR_MODE;
    else process.env.AGENT_FABRIC_SENIOR_MODE = originalSeniorMode;
    if (originalSeniorNonDeepSeek === undefined) delete process.env.AGENT_FABRIC_SENIOR_ALLOW_NON_DEEPSEEK_WORKERS;
    else process.env.AGENT_FABRIC_SENIOR_ALLOW_NON_DEEPSEEK_WORKERS = originalSeniorNonDeepSeek;
    if (originalSeniorDefaultWorker === undefined) delete process.env.AGENT_FABRIC_SENIOR_DEFAULT_WORKER;
    else process.env.AGENT_FABRIC_SENIOR_DEFAULT_WORKER = originalSeniorDefaultWorker;
    if (originalSeniorDefaultLaneCount === undefined) delete process.env.AGENT_FABRIC_SENIOR_DEFAULT_LANE_COUNT;
    else process.env.AGENT_FABRIC_SENIOR_DEFAULT_LANE_COUNT = originalSeniorDefaultLaneCount;
    if (originalSeniorLaneCount === undefined) delete process.env.AGENT_FABRIC_SENIOR_LANE_COUNT;
    else process.env.AGENT_FABRIC_SENIOR_LANE_COUNT = originalSeniorLaneCount;
    if (originalSeniorMaxLaneCount === undefined) delete process.env.AGENT_FABRIC_SENIOR_MAX_LANE_COUNT;
    else process.env.AGENT_FABRIC_SENIOR_MAX_LANE_COUNT = originalSeniorMaxLaneCount;
    if (originalQueueMaxAgents === undefined) delete process.env.AGENT_FABRIC_QUEUE_MAX_AGENTS;
    else process.env.AGENT_FABRIC_QUEUE_MAX_AGENTS = originalQueueMaxAgents;
  });

  it("parses create and launch commands", () => {
    expect(
      parseProjectCliArgs([
        "create",
        "--project",
        "/tmp/workspace/app",
        "--prompt-summary",
        "Build queue",
        "--profile",
        "careful",
        "--max-agents",
        "6",
        "--json"
      ])
    ).toMatchObject({
      command: "create",
      projectPath: "/tmp/workspace/app",
      promptSummary: "Build queue",
      pipelineProfile: "careful",
      maxParallelAgents: 6,
      json: true
    });

    expect(parseProjectCliArgs(["demo-seed", "--project", "/tmp/workspace/demo", "--title", "Demo Queue", "--max-agents", "3", "--json"])).toMatchObject({
      command: "demo-seed",
      projectPath: "/tmp/workspace/demo",
      title: "Demo Queue",
      maxParallelAgents: 3,
      json: true
    });

    expect(parseProjectCliArgs(["doctor", "local-config", "--project", "/tmp/workspace/app", "--json"])).toMatchObject({
      command: "local-config-doctor",
      projectPath: "/tmp/workspace/app",
      json: true
    });

    expect(parseProjectCliArgs(["launch", "--queue", "pqueue_1", "--worker", "manual", "--workspace-mode", "in_place"])).toMatchObject({
      command: "launch",
      queueId: "pqueue_1",
      worker: "manual",
      workspaceMode: "in_place",
      modelProfile: "execute.cheap"
    });

    expect(
      parseProjectCliArgs(["improve-prompt", "--queue", "pqueue_1", "--prompt", "rough", "--model-alias", "execute.cheap", "--accept"])
    ).toMatchObject({
      command: "improve-prompt",
      queueId: "pqueue_1",
      prompt: "rough",
      modelAlias: "execute.cheap",
      accept: true
    });

    expect(parseProjectCliArgs(["configure", "--queue", "pqueue_1", "--title", "Desktop Queue", "--profile", "fast", "--max-agents", "2"])).toMatchObject({
      command: "configure",
      queueId: "pqueue_1",
      title: "Desktop Queue",
      pipelineProfile: "fast",
      maxParallelAgents: 2
    });

    expect(parseProjectCliArgs(["generate-tasks", "--queue", "pqueue_1", "--plan-file", "plan.md", "--approve-queue"])).toMatchObject({
      command: "generate-tasks",
      queueId: "pqueue_1",
      planFile: "plan.md",
      modelAlias: "task.writer",
      approveQueue: true
    });

    expect(parseProjectCliArgs(["decide-queue", "--queue", "pqueue_1", "--decision", "pause", "--note", "Hold execution"])).toMatchObject({
      command: "decide-queue",
      queueId: "pqueue_1",
      decision: "pause",
      note: "Hold execution"
    });

    expect(
      parseProjectCliArgs([
        "claim-next",
        "--queue",
        "pqueue_1",
        "--worker",
        "local-cli",
        "--workspace-mode",
        "git_worktree",
        "--workspace-path",
        "/tmp/worktree",
        "--model-profile",
        "execute.cheap",
        "--context-policy",
        "tool_context:approved",
        "--command",
        "local-cli run"
      ])
    ).toMatchObject({
      command: "claim-next",
      queueId: "pqueue_1",
      worker: "local-cli",
      workspaceMode: "git_worktree",
      workspacePath: "/tmp/worktree",
      modelProfile: "execute.cheap",
      contextPolicy: "tool_context:approved",
      commandLine: "local-cli run"
    });

    expect(
      parseProjectCliArgs([
        "recover-stale",
        "--queue",
        "pqueue_1",
        "--stale-after-minutes",
        "10",
        "--recovery-action",
        "fail",
        "--dry-run"
      ])
    ).toMatchObject({
      command: "recover-stale",
      queueId: "pqueue_1",
      staleAfterMinutes: 10,
      action: "fail",
      dryRun: true
    });

    expect(
      parseProjectCliArgs([
        "cleanup-queues",
        "--project",
        "/tmp/workspace/app",
        "--queue-status",
        "completed",
        "--older-than-days",
        "0",
        "--limit",
        "5",
        "--delete-linked-task-history",
        "--apply",
        "--json"
      ])
    ).toMatchObject({
      command: "cleanup-queues",
      projectPath: "/tmp/workspace/app",
      statuses: ["completed"],
      olderThanDays: 0,
      limit: 5,
      deleteLinkedTaskHistory: true,
      dryRun: false,
      json: true
    });

    expect(parseProjectCliArgs(["retry-task", "--queue", "pqueue_1", "--queue-task", "pqtask_1", "--reason", "Try smaller patch", "--keep-outputs"])).toMatchObject({
      command: "retry-task",
      queueId: "pqueue_1",
      queueTaskId: "pqtask_1",
      reason: "Try smaller patch",
      clearOutputs: false
    });

    expect(parseProjectCliArgs(["prepare-ready", "--queue", "pqueue_1", "--limit", "3"])).toMatchObject({
      command: "prepare-ready",
      queueId: "pqueue_1",
      limit: 3
    });
    expect(parseProjectCliArgs(["launch-plan", "--queue", "pqueue_1", "--limit", "3"])).toMatchObject({
      command: "launch-plan",
      queueId: "pqueue_1",
      limit: 3
    });

    expect(parseProjectCliArgs(["edit-task", "--queue", "pqueue_1", "--queue-task", "pqtask_1", "--metadata-file", "task-meta.json", "--note", "Reviewed"])).toMatchObject({
      command: "edit-task",
      queueId: "pqueue_1",
      queueTaskId: "pqtask_1",
      metadataFile: "task-meta.json",
      note: "Reviewed"
    });

    expect(
      parseProjectCliArgs([
        "run-ready",
        "--queue",
        "pqueue_1",
        "--command-template",
        "echo {{queueTaskId}}",
        "--parallel",
        "2",
        "--cwd-template",
        "/tmp/{{queueTaskId}}",
        "--cwd-prep",
        "mkdir",
        "--task-packet-dir",
        "/tmp/packets",
        "--approve-tool-context"
      ])
    ).toMatchObject({
      command: "run-ready",
      queueId: "pqueue_1",
      commandTemplate: "echo {{queueTaskId}}",
      parallel: 2,
      cwdTemplate: "/tmp/{{queueTaskId}}",
      cwdPrep: "mkdir",
      taskPacketDir: "/tmp/packets",
      approveToolContext: true
    });

    expect(
      parseProjectCliArgs(["review-patches", "--queue", "pqueue_1", "--accept-task", "pqtask_1", "--apply-patch", "--apply-cwd", "/tmp/worktree"])
    ).toMatchObject({
      command: "review-patches",
      queueId: "pqueue_1",
      acceptTaskId: "pqtask_1",
      applyPatch: true,
      applyCwd: "/tmp/worktree"
    });

    expect(parseProjectCliArgs(["run-ready", "--queue", "pqueue_1", "--worker", "deepseek-direct", "--task-packet-dir", "/tmp/packets"])).toMatchObject({
      command: "run-ready",
      queueId: "pqueue_1",
      worker: "deepseek-direct",
      taskPacketDir: "/tmp/packets"
    });
    expect(parseProjectCliArgs(["run-ready", "--queue", "pqueue_1", "--worker", "jcode-deepseek", "--task-packet-dir", "/tmp/packets"])).toMatchObject({
      command: "run-ready",
      queueId: "pqueue_1",
      worker: "jcode-deepseek",
      taskPacketDir: "/tmp/packets"
    });
    expect(parseProjectCliArgs(["run-ready", "--queue", "pqueue_1", "--worker", "codex-app-server", "--command-template", "codex app-server run"])).toMatchObject({
      command: "run-ready",
      queueId: "pqueue_1",
      worker: "codex-app-server",
      commandTemplate: "codex app-server run"
    });
    expect(parseProjectCliArgs(["run-ready", "--queue", "pqueue_1", "--parallel", "20"])).toMatchObject({
      command: "run-ready",
      queueId: "pqueue_1",
      parallel: 20
    });

    expect(
      parseProjectCliArgs([
        "factory-run",
        "--queue",
        "pqueue_1",
        "--start-execution",
        "--parallel",
        "8",
        "--min-parallel",
        "2",
        "--deepseek-worker-command",
        "npx tsx src/bin/deepseek-worker.ts",
        "--patch-mode",
        "report",
        "--deepseek-role",
        "reviewer",
        "--sensitive-context-mode",
        "strict",
        "--allow-sensitive-context",
        "--no-adaptive-rate-limit",
        "--allow-concurrent-runner"
      ])
    ).toMatchObject({
      command: "factory-run",
      queueId: "pqueue_1",
      startExecution: true,
      parallel: 8,
      minParallel: 2,
      deepSeekWorkerCommand: "npx tsx src/bin/deepseek-worker.ts",
      deepSeekRole: "reviewer",
      sensitiveContextMode: "off",
      patchMode: "report",
      allowSensitiveContext: true,
      adaptiveRateLimit: false,
      allowConcurrentRunner: true
    });

    const previousSeniorMode = process.env.AGENT_FABRIC_SENIOR_MODE;
    process.env.AGENT_FABRIC_SENIOR_MODE = "permissive";
    try {
      expect(parseProjectCliArgs(["factory-run", "--queue", "pqueue_1"])).toMatchObject({
        command: "factory-run",
        queueId: "pqueue_1",
        allowSensitiveContext: true,
        sensitiveContextMode: "off"
      });
      expect(parseProjectCliArgs(["factory-run", "--queue", "pqueue_1", "--sensitive-context-mode", "strict"])).toMatchObject({
        command: "factory-run",
        queueId: "pqueue_1",
        allowSensitiveContext: false,
        sensitiveContextMode: "strict"
      });
    } finally {
      if (previousSeniorMode === undefined) delete process.env.AGENT_FABRIC_SENIOR_MODE;
      else process.env.AGENT_FABRIC_SENIOR_MODE = previousSeniorMode;
    }

    expect(parseProjectCliArgs(["set-tool-policy", "--project", "/tmp/workspace/app", "--kind", "mcp_server", "--value", "github", "--status", "rejected"])).toMatchObject({
      command: "set-tool-policy",
      projectPath: "/tmp/workspace/app",
      grantKind: "mcp_server",
      value: "github",
      status: "rejected"
    });

    expect(parseProjectCliArgs(["list", "--project", "/tmp/workspace/app", "--queue-status", "running", "--include-closed", "--limit", "5"])).toMatchObject({
      command: "list",
      projectPath: "/tmp/workspace/app",
      statuses: ["running"],
      includeClosed: true,
      limit: 5
    });

    expect(parseProjectCliArgs(["approval-inbox", "--project", "/tmp/workspace/app", "--queue", "pqueue_1", "--limit", "5"])).toMatchObject({
      command: "approval-inbox",
      projectPath: "/tmp/workspace/app",
      queueId: "pqueue_1",
      limit: 5
    });

    expect(parseProjectCliArgs(["memory-inbox", "--status", "pending_review", "--limit", "5"])).toMatchObject({
      command: "memory-inbox",
      status: "pending_review",
      limit: 5
    });

    expect(parseProjectCliArgs(["review-memory", "mem_1", "--decision", "archive", "--reason", "Too specific"])).toMatchObject({
      command: "review-memory",
      memoryId: "mem_1",
      decision: "archive",
      reason: "Too specific"
    });

    expect(parseProjectCliArgs(["queue-approvals", "--queue", "pqueue_1", "--include-expired", "--limit", "5"])).toMatchObject({
      command: "queue-approvals",
      queueId: "pqueue_1",
      includeExpired: true,
      limit: 5
    });

    expect(parseProjectCliArgs(["lanes", "--queue", "pqueue_1", "--include-completed", "--max-events", "3"])).toMatchObject({
      command: "lanes",
      queueId: "pqueue_1",
      includeCompleted: true,
      maxEventsPerLane: 3
    });

    expect(parseProjectCliArgs(["fabric-spawn-agents", "--queue", "pqueue_1", "--count", "10"])).toMatchObject({
      command: "fabric-spawn-agents",
      queueId: "pqueue_1",
      count: 10,
      worker: "deepseek-direct",
      workspaceMode: "git_worktree",
      modelProfile: "deepseek-v4-pro:max"
    });

    expect(parseProjectCliArgs(["fabric-message-agent", "--queue", "pqueue_1", "--agent", "@af/rami-123", "--body", "revise", "--ask"])).toMatchObject({
      command: "fabric-message-agent",
      queueId: "pqueue_1",
      agent: "@af/rami-123",
      body: "revise",
      ask: true
    });

    expect(parseProjectCliArgs(["dashboard", "--queue", "pqueue_1", "--include-completed", "--max-events", "2"])).toMatchObject({
      command: "dashboard",
      queueId: "pqueue_1",
      includeCompletedLanes: true,
      maxEventsPerLane: 2
    });

    expect(parseProjectCliArgs(["review-matrix", "--queue", "pqueue_1", "--limit", "4"])).toMatchObject({
      command: "review-matrix",
      queueId: "pqueue_1",
      limit: 4
    });

    expect(parseProjectCliArgs(["task-detail", "--queue", "pqueue_1", "--queue-task", "pqtask_1", "--include-resume", "--worker", "local-cli", "--max-events", "4"])).toMatchObject({
      command: "task-detail",
      queueId: "pqueue_1",
      queueTaskId: "pqtask_1",
      includeResume: true,
      preferredWorker: "local-cli",
      maxEventsPerRun: 4
    });

    expect(parseProjectCliArgs(["timeline", "--queue", "pqueue_1", "--limit", "20"])).toMatchObject({
      command: "timeline",
      queueId: "pqueue_1",
      limit: 20
    });

    expect(
      parseProjectCliArgs([
        "resume-task",
        "--queue",
        "pqueue_1",
        "--queue-task",
        "pqtask_1",
        "--worker",
        "local-cli",
        "--output-file",
        "resume.md",
        "--format",
        "markdown"
      ])
    ).toMatchObject({
      command: "resume-task",
      queueId: "pqueue_1",
      queueTaskId: "pqtask_1",
      preferredWorker: "local-cli",
      outputFile: "resume.md",
      format: "markdown"
    });

    expect(parseProjectCliArgs(["decide-tool", "tcprop_1", "--decision", "reject", "--remember", "--note", "Not needed"])).toMatchObject({
      command: "decide-tool",
      proposalId: "tcprop_1",
      decision: "reject",
      remember: true,
      note: "Not needed"
    });
  });

  it("parses version, help, Senior doctor, Senior run, and reviewed patch acceptance commands", () => {
    expect(parseProjectCliArgs(["--version"])).toMatchObject({ command: "version" });
    expect(parseProjectCliArgs(["factory-run", "--help"])).toMatchObject({ command: "help" });
    expect(parseProjectCliArgs(["senior-doctor", "--project", "/tmp/workspace/app", "--queue", "pqueue_1"])).toMatchObject({
      command: "senior-doctor",
      projectPath: "/tmp/workspace/app",
      queueId: "pqueue_1"
    });
    expect(
      parseProjectCliArgs([
        "senior-run",
        "--project",
        "/tmp/workspace/app",
        "--plan-file",
        "plan.md",
        "--count",
        "10",
        "--worker",
        "jcode-deepseek",
        "--approve-model-calls",
        "--progress-file",
        ".agent-fabric/progress.md",
        "--dry-run"
      ])
    ).toMatchObject({
      command: "senior-run",
      projectPath: "/tmp/workspace/app",
      planFile: "plan.md",
      count: 10,
      worker: "jcode-deepseek",
      approveModelCalls: true,
      progressFile: ".agent-fabric/progress.md",
      dryRun: true
    });
    expect(
      parseProjectCliArgs([
        "fabric-accept-patch",
        "--queue",
        "pqueue_1",
        "--queue-task",
        "pqtask_1",
        "--reviewed-by",
        "Codex",
        "--review-summary",
        "Reviewed patch and tests."
      ])
    ).toMatchObject({
      command: "fabric-accept-patch",
      reviewedBy: "Codex",
      reviewSummary: "Reviewed patch and tests."
    });
  });

  it("defaults Senior mode worker execution to queue-backed DeepSeek lanes", () => {
    process.env.AGENT_FABRIC_SENIOR_MODE = "permissive";

    expect(parseProjectCliArgs(["claim-next", "--queue", "pqueue_1"])).toMatchObject({
      command: "claim-next",
      queueId: "pqueue_1",
      worker: "deepseek-direct",
      workspaceMode: "git_worktree",
      modelProfile: "deepseek-v4-pro:max"
    });

    expect(parseProjectCliArgs(["launch", "--queue", "pqueue_1"])).toMatchObject({
      command: "launch",
      queueId: "pqueue_1",
      worker: "deepseek-direct",
      workspaceMode: "git_worktree",
      modelProfile: "deepseek-v4-pro:max"
    });

    expect(parseProjectCliArgs(["run-ready", "--queue", "pqueue_1"])).toMatchObject({
      command: "run-ready",
      queueId: "pqueue_1",
      worker: "deepseek-direct",
      workspaceMode: "git_worktree",
      modelProfile: "deepseek-v4-pro:max",
      parallel: 10,
      taskPacketDir: join(tmpdir(), "agent-fabric-factory", "pqueue_1", "task-packets"),
      cwdTemplate: join(tmpdir(), "agent-fabric-factory", "pqueue_1", "worktrees", "{{queueTaskId}}")
    });

    expect(parseProjectCliArgs(["factory-run", "--queue", "pqueue_1"])).toMatchObject({
      command: "factory-run",
      queueId: "pqueue_1",
      parallel: 10,
      allowSensitiveContext: true,
      sensitiveContextMode: "off"
    });
  });

  it("allows the local Senior default worker to prefer Jcode DeepSeek lanes", () => {
    process.env.AGENT_FABRIC_SENIOR_MODE = "permissive";
    process.env.AGENT_FABRIC_SENIOR_DEFAULT_WORKER = "jcode-deepseek";

    expect(parseProjectCliArgs(["claim-next", "--queue", "pqueue_1"])).toMatchObject({
      command: "claim-next",
      worker: "jcode-deepseek",
      workspaceMode: "git_worktree",
      modelProfile: "deepseek-v4-pro:max"
    });

    expect(parseProjectCliArgs(["run-ready", "--queue", "pqueue_1"])).toMatchObject({
      command: "run-ready",
      worker: "jcode-deepseek",
      workspaceMode: "git_worktree"
    });

    expect(parseProjectCliArgs(["senior-run", "--project", "/tmp/workspace/app"])).toMatchObject({
      command: "senior-run",
      worker: "jcode-deepseek"
    });

    expect(() => {
      process.env.AGENT_FABRIC_SENIOR_DEFAULT_WORKER = "claude";
      parseProjectCliArgs(["run-ready", "--queue", "pqueue_1"]);
    }).toThrow("AGENT_FABRIC_SENIOR_DEFAULT_WORKER must be deepseek-direct or jcode-deepseek");
  });

  it("keeps high-scale Senior caps separate from default launch counts", () => {
    process.env.AGENT_FABRIC_SENIOR_MODE = "permissive";
    process.env.AGENT_FABRIC_QUEUE_MAX_AGENTS = "1000";

    expect(parseProjectCliArgs(["run-ready", "--queue", "pqueue_1"])).toMatchObject({
      command: "run-ready",
      parallel: 10
    });
    expect(parseProjectCliArgs(["factory-run", "--queue", "pqueue_1"])).toMatchObject({
      command: "factory-run",
      parallel: 10
    });
    expect(parseProjectCliArgs(["senior-run", "--project", "/tmp/workspace/app"])).toMatchObject({
      command: "senior-run",
      count: 10
    });

    process.env.AGENT_FABRIC_SENIOR_DEFAULT_LANE_COUNT = "250";

    expect(parseProjectCliArgs(["run-ready", "--queue", "pqueue_1"])).toMatchObject({
      command: "run-ready",
      parallel: 250
    });
    expect(parseProjectCliArgs(["senior-run", "--project", "/tmp/workspace/app"])).toMatchObject({
      command: "senior-run",
      count: 250
    });

    delete process.env.AGENT_FABRIC_SENIOR_DEFAULT_LANE_COUNT;
    process.env.AGENT_FABRIC_SENIOR_MAX_LANE_COUNT = "5";

    expect(parseProjectCliArgs(["run-ready", "--queue", "pqueue_1"])).toMatchObject({
      command: "run-ready",
      parallel: 5
    });
    expect(parseProjectCliArgs(["senior-run", "--project", "/tmp/workspace/app"])).toMatchObject({
      command: "senior-run",
      count: 5
    });
  });

  it("rejects non-DeepSeek execution workers in Senior mode unless explicitly allowed", async () => {
    process.env.AGENT_FABRIC_SENIOR_MODE = "permissive";

    expect(() => parseProjectCliArgs(["run-ready", "--queue", "pqueue_1", "--worker", "local-cli"])).toThrow(
      "must use Agent Fabric queue-backed DeepSeek workers"
    );
    expect(() => parseProjectCliArgs(["run-ready", "--queue", "pqueue_1", "--worker", "codex-app-server"])).toThrow(
      "must use Agent Fabric queue-backed DeepSeek workers"
    );
    expect(() =>
      parseProjectCliArgs(["run-ready", "--queue", "pqueue_1", "--worker", "deepseek-direct", "--command-template", "codex exec {{taskPacket}}"])
    ).toThrow("cannot record worker=deepseek-direct");
    expect(() => parseProjectCliArgs(["factory-run", "--queue", "pqueue_1", "--deepseek-worker-command", "claude"])).toThrow(
      "must launch agent-fabric-deepseek-worker"
    );

    await expect(
      runProjectCommand(
        {
          command: "run-ready",
          json: false,
          queueId: "pqueue_1",
          worker: "ramicode",
          workspaceMode: "in_place",
          modelProfile: "execute.cheap",
          taskPacketFormat: "json",
          parallel: 1,
          allowSharedCwd: false,
          successStatus: "patch_ready",
          maxOutputChars: 8_000,
          approveToolContext: false,
          rememberToolContext: false,
          continueOnFailure: false
        },
        async () => {
          throw new Error("run-ready should fail before tool calls");
        }
      )
    ).rejects.toThrow("must use Agent Fabric queue-backed DeepSeek workers");

    process.env.AGENT_FABRIC_SENIOR_ALLOW_NON_DEEPSEEK_WORKERS = "1";
    expect(parseProjectCliArgs(["run-ready", "--queue", "pqueue_1", "--worker", "local-cli"])).toMatchObject({
      command: "run-ready",
      worker: "local-cli"
    });
  });

  it("lists and reviews pending memories from the project CLI", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const write = await call<{ id: string; status: string }>("memory_write", {
      type: "procedural",
      body: "For login tests, isolate fixture state.",
      intent_keys: ["login tests"],
      source: "auto",
      derivation: "session_transcript"
    });
    expect(write.status).toBe("pending_review");

    const inbox = await runProjectCommand({ command: "memory-inbox", json: false, status: "pending_review", archived: false, limit: 5 }, call);
    expect(inbox.message).toContain(write.id);

    const reviewed = await runProjectCommand({ command: "review-memory", json: false, memoryId: write.id, decision: "approve", reason: "CLI accepted" }, call);
    expect(reviewed.data).toMatchObject({ id: write.id, status: "active" });
    expect(reviewed.message).toContain("pending_review -> active");
    daemon.close();
  });

  it("creates a queue and starts a plan chain", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);

    const created = await runProjectCommand(
      {
        command: "create",
        json: false,
        projectPath: "/tmp/workspace/app",
        prompt: "Build a project queue.",
        pipelineProfile: "balanced",
        maxParallelAgents: 4
      },
      call
    );
    expect(created.action).toBe("created");
    const queueId = created.data.queueId as string;

    const configured = await runProjectCommand(
      {
        command: "configure",
        json: false,
        queueId,
        title: "Configured queue",
        pipelineProfile: "careful",
        maxParallelAgents: 3
      },
      call
    );
    expect(configured.action).toBe("queue_configured");
    expect(configured.message).toContain("maxAgents=3");

    const planned = await runProjectCommand(
      {
        command: "start-plan",
        json: false,
        queueId,
        task: "Plan the project queue implementation.",
        maxRounds: 2,
        budgetUsd: 1,
        outputFormat: "markdown"
      },
      call
    );
    expect(planned.action).toBe("plan_started");

    const status = await call<{ queue: { planChainId?: string; title?: string; maxParallelAgents?: number }; stages: Array<{ stage: string; status: string }> }>(
      "project_queue_status",
      { queueId }
    );
    expect(status.queue.planChainId).toBe(planned.data.chainId);
    expect(status.queue).toMatchObject({ title: "Configured queue", maxParallelAgents: 3 });
    expect(status.stages.map((stage) => [stage.stage, stage.status])).toContainEqual(["prompt_improvement", "pending"]);
    expect(status.stages.map((stage) => [stage.stage, stage.status])).toContainEqual(["planning", "running"]);
    daemon.close();
  });

  it("seeds a realistic Desktop demo queue from the project CLI", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-project-cli-demo-"));

    const seeded = await runProjectCommand(
      {
        command: "demo-seed",
        json: false,
        projectPath,
        title: "Demo queue",
        maxParallelAgents: 4
      },
      call
    );

    expect(seeded.action).toBe("demo_seeded");
    expect(seeded.data).toMatchObject({
      projectPath,
      title: "Demo queue",
      activeWorkers: 2,
      pendingApprovalCount: 1,
      laneCount: 2
    });
    const queueId = seeded.data.queueId as string;
    const dashboard = await call<{
      queue: { status: string; maxParallelAgents: number };
      pendingApprovals: unknown[];
      activeWorkers: number;
      agentLaneCount: number;
      pipeline: Array<{ stage: string; status: string }>;
      queueBoard: { review: unknown[]; failed: unknown[]; blocked: unknown[]; running: unknown[] };
    }>("project_queue_dashboard", {
      queueId,
      includeCompletedLanes: false,
      maxEventsPerLane: 5
    });

    expect(dashboard.queue).toMatchObject({ status: "running", maxParallelAgents: 4 });
    expect(dashboard.activeWorkers).toBe(2);
    expect(dashboard.agentLaneCount).toBe(2);
    expect(dashboard.pendingApprovals).toHaveLength(1);
    expect(dashboard.queueBoard.running).toHaveLength(2);
    expect(dashboard.queueBoard.review).toHaveLength(1);
    expect(dashboard.queueBoard.failed).toHaveLength(1);
    expect(dashboard.queueBoard.blocked.length).toBeGreaterThanOrEqual(2);
    expect(dashboard.pipeline.map((stage) => [stage.stage, stage.status])).toContainEqual(["tool_context", "needs_review"]);
    expect(dashboard.pipeline.map((stage) => [stage.stage, stage.status])).toContainEqual(["execution", "running"]);

    const approvals = await runProjectCommand({ command: "queue-approvals", json: false, queueId, includeExpired: false, limit: 10 }, call);
    expect(approvals.message).toContain("Tool/context: 1; model calls: 0");
    expect(approvals.message).toContain("mcp_server:github");

    const lanes = await runProjectCommand({ command: "lanes", json: false, queueId, includeCompleted: false, maxEventsPerLane: 5 }, call);
    expect(lanes.message).toContain("Wire live agent lane telemetry");
    expect(lanes.message).toContain("Surface queue health and cost/risk strip");
    daemon.close();
  });

  it("imports tasks and launches only tasks with approved tool/context bundles", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const tmp = mkdtempSync(join(tmpdir(), "agent-fabric-project-cli-"));
    const tasksFile = join(tmp, "tasks.json");

    const created = await runProjectCommand(
      {
        command: "create",
        json: false,
        projectPath: "/tmp/workspace/app",
        promptSummary: "Queue import test.",
        pipelineProfile: "balanced",
        maxParallelAgents: 4
      },
      call
    );
    const queueId = created.data.queueId as string;
    writeFileSync(
      tasksFile,
      JSON.stringify(
        {
          tasks: [
            {
              clientKey: "free",
              title: "No tool task",
              goal: "Can launch immediately.",
              risk: "low"
            },
            {
              clientKey: "tool",
              title: "Needs approved tool",
              goal: "Must wait for approval.",
              risk: "medium",
              requiredTools: ["fabric_task_event"],
              requiredMcpServers: ["github"],
              requiredMemories: ["memory:user-review-style"],
              requiredContextRefs: ["context:repo-map"]
            }
          ]
        },
        null,
        2
      )
    );

    const imported = await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    expect(imported.action).toBe("tasks_imported");
    const toolTask = (imported.data.created as Array<{ queueTaskId: string; title: string }>).find((task) => task.title === "Needs approved tool");
    if (!toolTask) throw new Error("tool task missing");
    const metadataFile = join(tmp, "task-meta.json");
    writeFileSync(
      metadataFile,
      JSON.stringify(
        {
          title: "Reviewed tool task",
          requiredTools: ["fabric_task_event"],
          requiredMcpServers: ["github"],
          requiredMemories: ["memory:user-review-style"],
          requiredContextRefs: ["context:repo-map"]
        },
        null,
        2
      )
    );
    const edited = await runProjectCommand(
      { command: "edit-task", json: false, queueId, queueTaskId: toolTask.queueTaskId, metadataFile, note: "Human reviewed generated metadata." },
      call
    );
    expect(edited.action).toBe("task_metadata_updated");
    expect(edited.message).toContain("Reviewed tool task");
    const prepared = await runProjectCommand({ command: "prepare-ready", json: false, queueId, limit: 2 }, call);
    expect(prepared.action).toBe("ready_tasks_prepared");
    expect(prepared.message).toContain("approvals=1");
    const launchPlanBeforeStart = await runProjectCommand({ command: "launch-plan", json: false, queueId, limit: 2 }, call);
    expect(launchPlanBeforeStart.action).toBe("launch_plan");
    expect(launchPlanBeforeStart.message).toContain("launchable=0");
    expect(launchPlanBeforeStart.message).toContain("waiting-start=1");
    expect(launchPlanBeforeStart.message).toContain("approvals=1");
    expect(launchPlanBeforeStart.message).toContain("queue is waiting for start_execution");
    const reviewMatrix = await runProjectCommand({ command: "review-matrix", json: false, queueId, limit: 2 }, call);
    expect(reviewMatrix.action).toBe("review_matrix");
    expect(reviewMatrix.message).toContain("Tool/context: required-tasks=1");
    expect(reviewMatrix.message).toContain("pending=1");
    expect(reviewMatrix.message).toContain("Preview: launchable=0, approvals=1");
    const preparedTool = (prepared.data.prepared as Array<{ task?: { queueTaskId?: string }; toolContextProposal?: { proposalId?: string } }>).find(
      (entry) => entry.task?.queueTaskId === toolTask.queueTaskId
    );
    expect(preparedTool?.toolContextProposal?.proposalId).toBeTruthy();

    const launchBeforeStart = await runProjectCommand(
      {
        command: "launch",
        json: false,
        queueId,
        worker: "manual",
        workspaceMode: "in_place",
        modelProfile: "execute.cheap"
      },
      call
    );
    expect(launchBeforeStart.data.started).toHaveLength(0);
    expect(launchBeforeStart.message).toContain("queue is waiting for start_execution");

    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);
    const launchPlanAfterStart = await runProjectCommand({ command: "launch-plan", json: false, queueId, limit: 2 }, call);
    expect(launchPlanAfterStart.message).toContain("launchable=1");
    expect(launchPlanAfterStart.message).toContain("approvals=1");

    const firstLaunch = await runProjectCommand(
      {
        command: "launch",
        json: false,
        queueId,
        worker: "manual",
        workspaceMode: "in_place",
        modelProfile: "execute.cheap"
      },
      call
    );
    expect(firstLaunch.data.started).toHaveLength(1);
    expect(firstLaunch.data.skipped).toHaveLength(1);
    const skipped = (firstLaunch.data.skipped as Array<{ proposalId: string; missingGrants: Array<{ grantKey: string }> }>)[0];
    expect(skipped.proposalId).toBe(preparedTool?.toolContextProposal?.proposalId);
    expect(skipped.missingGrants.map((grant) => grant.grantKey).sort()).toEqual([
      "context:context:repo-map",
      "mcp_server:github",
      "memory:memory:user-review-style",
      "tool:fabric_task_event"
    ]);

    const inbox = await runProjectCommand({ command: "approval-inbox", json: false, queueId, limit: 10 }, call);
    expect(inbox.message).toContain(skipped.proposalId);
    expect(inbox.message).toContain("mcp_server:github");

    const queueApprovals = await runProjectCommand({ command: "queue-approvals", json: false, queueId, includeExpired: false, limit: 10 }, call);
    expect(queueApprovals.message).toContain("Tool/context: 1; model calls: 0");
    expect(queueApprovals.message).toContain(skipped.proposalId);

    const listed = await runProjectCommand({ command: "list", json: false, statuses: [], includeClosed: false, limit: 10 }, call);
    expect(listed.message).toContain("approvals=1");

    await runProjectCommand({ command: "approve-tool", json: false, proposalId: skipped.proposalId, remember: true }, call);

    const noToolTask = (firstLaunch.data.started as Array<{ queueTaskId: string }>)[0];
    await call("project_queue_update_task", {
      queueId,
      queueTaskId: noToolTask.queueTaskId,
      status: "completed",
      summary: "Done."
    });

    const secondLaunch = await runProjectCommand(
      {
        command: "launch",
        json: false,
        queueId,
        worker: "manual",
        workspaceMode: "in_place",
        modelProfile: "execute.cheap"
      },
      call
    );
    expect(secondLaunch.data.started).toHaveLength(1);
    expect(secondLaunch.data.skipped).toHaveLength(0);

    const toggled = await runProjectCommand(
      {
        command: "set-tool-policy",
        json: false,
        projectPath: "/tmp/workspace/app",
        grantKind: "mcp_server",
        value: "github",
        status: "rejected"
      },
      call
    );
    expect(toggled.action).toBe("tool_context_policy_set");
    expect(toggled.data).toMatchObject({ grantKey: "mcp_server:github", status: "rejected" });

    const statusAfterToggle = await runProjectCommand({ command: "status", json: false, queueId }, call);
    expect(statusAfterToggle.message).toContain("policies: approved=3, rejected=1");

    const extraProposal = await call<{ proposalId: string }>("tool_context_propose", { queueId, tools: ["manual-extra"] });
    const rejected = await runProjectCommand(
      { command: "decide-tool", json: false, proposalId: extraProposal.proposalId, decision: "reject", remember: true, note: "Not needed." },
      call
    );
    expect(rejected.action).toBe("tool_context_reject");
    expect(rejected.data).toMatchObject({ decision: "reject", status: "rejected", rememberedGrants: 1 });
    daemon.close();
  });

  it("improves prompts through preflight and a configured model runner", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const tmp = mkdtempSync(join(tmpdir(), "agent-fabric-project-cli-"));
    const outputFile = join(tmp, "improved.md");
    const created = await runProjectCommand(
      {
        command: "create",
        json: false,
        projectPath: "/tmp/workspace/app",
        promptSummary: "Prompt improve test.",
        pipelineProfile: "balanced",
        maxParallelAgents: 4
      },
      call
    );
    const queueId = created.data.queueId as string;

    const result = await runProjectCommand(
      {
        command: "improve-prompt",
        json: false,
        queueId,
        prompt: "make app",
        modelAlias: "execute.cheap",
        accept: true,
        outputFile
      },
      call,
      {
        runModel: async (request) => ({
          improvedPrompt: `Improved: ${String(request.input.prompt)} with acceptance criteria.`,
          summary: "Prompt clarified.",
          warnings: ["Review scope."]
        })
      }
    );

    expect(result.action).toBe("prompt_improved");
    expect(readFileSync(outputFile, "utf8")).toContain("Improved: make app");
    const status = await call<{ queue: { status: string }; stages: Array<{ stage: string; status: string }> }>("project_queue_status", { queueId });
    expect(status.queue.status).toBe("planning");
    expect(status.stages.map((stage) => [stage.stage, stage.status])).toContainEqual(["prompt_improvement", "accepted"]);
    daemon.close();
  });

  it("blocks high-risk prompt improvement before running the model", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const created = await runProjectCommand(
      {
        command: "create",
        json: false,
        projectPath: "/tmp/workspace/app",
        promptSummary: "Approval gate test.",
        pipelineProfile: "careful",
        maxParallelAgents: 4
      },
      call
    );
    const queueId = created.data.queueId as string;
    let called = false;

    const result = await runProjectCommand(
      {
        command: "improve-prompt",
        json: false,
        queueId,
        prompt: "Use the strong default alias.",
        modelAlias: "prompt.improve.strong",
        accept: false
      },
      call,
      {
        runModel: async () => {
          called = true;
          return { improvedPrompt: "should not happen" };
        }
      }
    );

    expect(result.action).toBe("prompt_improvement_blocked");
    expect(result.message).toContain("needs_user_approval");
    expect(called).toBe(false);

    const queueApprovals = await runProjectCommand({ command: "queue-approvals", json: false, queueId, includeExpired: false, limit: 10 }, call);
    expect(queueApprovals.message).toContain("Tool/context: 0; model calls: 1");
    expect(queueApprovals.message).toContain("model ");
    const dashboard = await runProjectCommand({ command: "dashboard", json: false, queueId, includeCompletedLanes: false, maxEventsPerLane: 3 }, call);
    expect(dashboard.message).toContain("Health: waiting_on_human attention");
    expect(dashboard.message).toContain("preflights=1");
    daemon.close();
  });

  it("generates task JSON, imports it, reviews the queue, and reviews patches", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const tmp = mkdtempSync(join(tmpdir(), "agent-fabric-project-cli-"));
    const planFile = join(tmp, "plan.md");
    const tasksFile = join(tmp, "tasks.json");
    writeFileSync(planFile, "Plan: add queue review and patch review commands.", "utf8");
    const created = await runProjectCommand(
      {
        command: "create",
        json: false,
        projectPath: "/tmp/workspace/app",
        promptSummary: "Task generation test.",
        pipelineProfile: "balanced",
        maxParallelAgents: 4
      },
      call
    );
    const queueId = created.data.queueId as string;

    const generated = await runProjectCommand(
      {
        command: "generate-tasks",
        json: false,
        queueId,
        planFile,
        modelAlias: "execute.cheap",
        tasksFile,
        approveQueue: true
      },
      call,
      {
        runModel: async () => ({
          phases: [{ name: "CLI" }],
          tasks: [
            {
              clientKey: "review",
              title: "Add review command",
              goal: "Print queue review.",
              risk: "low",
              priority: "normal",
              acceptanceCriteria: ["Review prints ready tasks."],
              parallelSafe: true
            }
          ]
        })
      }
    );
    expect(generated.action).toBe("tasks_generated");
    expect(JSON.parse(readFileSync(tasksFile, "utf8")).tasks).toHaveLength(1);

    const reviewed = await runProjectCommand({ command: "review-queue", json: false, queueId, approveQueue: true }, call);
    expect(reviewed.message).toContain("Ready now: 1");
    const paused = await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "pause", note: "Hold for review." }, call);
    expect(paused.action).toBe("queue_decided");
    expect(paused.message).toContain("status=paused");
    const pausedReview = await runProjectCommand({ command: "review-queue", json: false, queueId, approveQueue: false }, call);
    expect(pausedReview.message).toContain("Execution blocked: queue is paused.");
    const resumed = await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "resume" }, call);
    expect(resumed.message).toContain("status=running");
    const task = (generated.data.added as { created: Array<{ queueTaskId: string }> }).created[0];
    const claimed = await runProjectCommand({ command: "claim-next", json: false, queueId }, call);
    expect(claimed.action).toBe("task_claimed");
    expect(claimed.message).toContain(task.queueTaskId);
    const stale = await runProjectCommand(
      { command: "recover-stale", json: false, queueId, staleAfterMinutes: 1, action: "requeue", dryRun: true },
      call
    );
    expect(stale.action).toBe("stale_recovered");
    expect(stale.message).toContain("dry run");
    expect(stale.message).toContain("missing worker run");
    await call("project_queue_update_task", {
      queueId,
      queueTaskId: task.queueTaskId,
      status: "patch_ready",
      summary: "Patch is ready.",
      patchRefs: ["patch:review-command"],
      testRefs: ["npm test -- project-cli"]
    });
    const patches = await runProjectCommand({ command: "review-patches", json: false, queueId }, call);
    expect(patches.message).toContain("patch:review-command");
    const accepted = await runProjectCommand({ command: "review-patches", json: false, queueId, acceptTaskId: task.queueTaskId }, call);
    expect(accepted.action).toBe("patch_accepted");
    const completed = await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "complete" }, call);
    expect(completed.message).toContain("status=completed");
    daemon.db.db.prepare("UPDATE project_queues SET ts_updated = datetime('now', '-10 days') WHERE id = ?").run(queueId);
    const cleanupPreview = await runProjectCommand(
      { command: "cleanup-queues", json: false, projectPath: "/tmp/workspace/app", olderThanDays: 7, dryRun: true, deleteLinkedTaskHistory: false },
      call
    );
    expect(cleanupPreview.action).toBe("queue_cleanup_preview");
    expect(cleanupPreview.message).toContain("1 queue");
    const cleanupApplied = await runProjectCommand(
      { command: "cleanup-queues", json: false, projectPath: "/tmp/workspace/app", olderThanDays: 7, dryRun: false, deleteLinkedTaskHistory: false },
      call
    );
    expect(cleanupApplied.action).toBe("queue_cleanup_applied");
    expect(cleanupApplied.message).toContain("1 queue");
    daemon.close();
  });

  it("runs a queue task command and records worker events, checkpoint, and patch-ready state", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-project-cli-run-"));
    const created = await runProjectCommand(
      {
        command: "create",
        json: false,
        projectPath,
        promptSummary: "Run task test.",
        pipelineProfile: "balanced",
        maxParallelAgents: 4
      },
      call
    );
    const queueId = created.data.queueId as string;
    const imported = await runProjectCommand(
      {
        command: "import-tasks",
        json: false,
        queueId,
        tasksFile: writeTasksFile(projectPath),
        approveQueue: true
      },
      call
    );
    const task = (imported.data.created as Array<{ queueTaskId: string; fabricTaskId: string }>)[0];
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);

    const blocked = await runProjectCommand(
      {
        command: "run-task",
        json: false,
        queueId,
        queueTaskId: task.queueTaskId,
        commandLine: "node -e \"require('node:fs').writeFileSync('changed.txt','ok')\"",
        cwd: projectPath,
        worker: "manual",
        workspaceMode: "in_place",
        modelProfile: "execute.cheap",
        successStatus: "patch_ready",
        maxOutputChars: 4_000,
        approveToolContext: false,
        rememberToolContext: false
      },
      call
    );
    expect(blocked.action).toBe("run_task_blocked");

    const ran = await runProjectCommand(
      {
        command: "run-task",
        json: false,
        queueId,
        queueTaskId: task.queueTaskId,
        commandLine: "node -e \"require('node:fs').writeFileSync('changed.txt','ok')\"",
        cwd: projectPath,
        worker: "manual",
        workspaceMode: "in_place",
        modelProfile: "execute.cheap",
        successStatus: "patch_ready",
        maxOutputChars: 4_000,
        approveToolContext: true,
        rememberToolContext: false
      },
      call
    );
    expect(ran.action).toBe("task_run_completed");
    expect(ran.data.changedFiles).toEqual(["changed.txt"]);

    const status = await call<{ status: string; events: Array<{ kind: string }>; checkpoints: unknown[] }>("fabric_task_status", {
      taskId: task.fabricTaskId,
      includeEvents: true,
      includeCheckpoints: true
    });
    expect(status.status).toBe("patch_ready");
    expect(status.events.map((event) => event.kind)).toEqual([
      "started",
      "command_started",
      "command_spawned",
      "command_finished",
      "file_changed",
      "patch_ready"
    ]);
    expect(status.checkpoints).toHaveLength(1);

    const lanes = await runProjectCommand({ command: "lanes", json: false, queueId, includeCompleted: false, maxEventsPerLane: 3 }, call);
    expect(lanes.action).toBe("agent_lanes");
    expect(lanes.message).toContain("Patch ready Run command");
    expect(lanes.message).toContain("latest: patch_ready");
    expect(lanes.data.count).toBe(1);

    const dashboard = await runProjectCommand({ command: "dashboard", json: false, queueId, includeCompletedLanes: false, maxEventsPerLane: 3 }, call);
    expect(dashboard.action).toBe("dashboard");
    expect(dashboard.message).toContain("Board: ready=0, running=0, review=1");
    expect(dashboard.message).toContain("lane ");

    const timeline = await runProjectCommand({ command: "timeline", json: false, queueId, limit: 10 }, call);
    expect(timeline.action).toBe("timeline");
    expect(timeline.message).toContain("worker_event worker.patch_ready");
    expect(timeline.message).toContain("Run command");

    const resumeFile = join(projectPath, "resume.md");
    const resume = await runProjectCommand(
      {
        command: "resume-task",
        json: false,
        queueId,
        queueTaskId: task.queueTaskId,
        preferredWorker: "manual",
        outputFile: resumeFile,
        format: "markdown"
      },
      call
    );
    expect(resume.action).toBe("resume_task");
    expect(resume.message).toContain("Wrote markdown resume packet");
    expect(readFileSync(resumeFile, "utf8")).toContain("# Resume Run command");
    expect(readFileSync(resumeFile, "utf8")).toContain("## Resume Prompt");
    daemon.close();
  });

  it("runs worker shell commands without inheriting hostile shell aliases", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-project-cli-alias-"));
    const aliasFile = join(projectPath, "bash-env");
    writeFileSync(join(projectPath, "source.txt"), "copied\n", "utf8");
    writeFileSync(aliasFile, "shopt -s expand_aliases\nalias cp='false'\n", "utf8");
    const oldBashEnv = process.env.BASH_ENV;
    process.env.BASH_ENV = aliasFile;

    try {
      const created = await runProjectCommand(
        {
          command: "create",
          json: false,
          projectPath,
          promptSummary: "Alias hardening test.",
          pipelineProfile: "balanced",
          maxParallelAgents: 4
        },
        call
      );
      const queueId = created.data.queueId as string;
      const imported = await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile: writeTasksFile(projectPath), approveQueue: true }, call);
      const task = (imported.data.created as Array<{ queueTaskId: string }>)[0];
      await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);

      const ran = await runProjectCommand(
        {
          command: "run-task",
          json: false,
          queueId,
          queueTaskId: task.queueTaskId,
          commandLine: "cp source.txt copied.txt",
          cwd: projectPath,
          worker: "manual",
          workspaceMode: "in_place",
          modelProfile: "execute.cheap",
          successStatus: "patch_ready",
          maxOutputChars: 4_000,
          approveToolContext: true,
          rememberToolContext: false
        },
        call
      );

      expect(ran.action).toBe("task_run_completed");
      expect(readFileSync(join(projectPath, "copied.txt"), "utf8")).toBe("copied\n");
    } finally {
      if (oldBashEnv === undefined) delete process.env.BASH_ENV;
      else process.env.BASH_ENV = oldBashEnv;
      daemon.close();
    }
  });

  it("blocks parallel ready task runs that share a cwd unless explicitly allowed", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-project-cli-shared-"));
    const tasksFile = join(projectPath, "tasks.json");
    writeFileSync(
      tasksFile,
      JSON.stringify({
        tasks: [
          { clientKey: "a", title: "Task A", goal: "Write first file.", risk: "low" },
          { clientKey: "b", title: "Task B", goal: "Write second file.", risk: "low" }
        ]
      })
    );
    const created = await runProjectCommand(
      {
        command: "create",
        json: false,
        projectPath,
        promptSummary: "Shared cwd guard test.",
        pipelineProfile: "balanced",
        maxParallelAgents: 4
      },
      call
    );
    const queueId = created.data.queueId as string;
    await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);

    await expect(
      runProjectCommand(
        {
          command: "run-ready",
          json: false,
          queueId,
          limit: 2,
          parallel: 2,
          commandTemplate: "echo {{queueTaskId}}",
          worker: "manual",
          workspaceMode: "in_place",
          modelProfile: "execute.cheap",
          successStatus: "patch_ready",
          maxOutputChars: 4_000,
          approveToolContext: true,
          rememberToolContext: false,
          continueOnFailure: false,
          allowSharedCwd: false
        },
        call
      )
    ).rejects.toThrow("Parallel run-ready would execute multiple tasks in the same cwd");
    daemon.close();
  });

  it("writes task packets for queue tasks", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-project-cli-packets-"));
    const packetsDir = join(projectPath, "packets");
    const tasksFile = writeTasksFile(projectPath);
    const created = await runProjectCommand(
      {
        command: "create",
        json: false,
        projectPath,
        promptSummary: "Packet test.",
        pipelineProfile: "balanced",
        maxParallelAgents: 4
      },
      call
    );
    const queueId = created.data.queueId as string;
    const imported = await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    const task = (imported.data.created as Array<{ queueTaskId: string }>)[0];

    const result = await runProjectCommand(
      { command: "write-task-packets", json: false, queueId, outDir: packetsDir, format: "markdown", readyOnly: true },
      call
    );

    expect(result.action).toBe("task_packets_written");
    const packetPath = join(packetsDir, `${task.queueTaskId}.md`);
    expect(readFileSync(packetPath, "utf8")).toContain("---\nschema: agent-fabric.task-packet.v1");
    expect(readFileSync(packetPath, "utf8")).toContain(`queueTaskId: "${task.queueTaskId}"`);
    expect(readFileSync(packetPath, "utf8")).toContain(`contextFilePath: "${join(packetsDir, `${task.queueTaskId}.context.md`)}"`);
    expect(readFileSync(packetPath, "utf8")).toContain("# Run command");
    expect(readFileSync(packetPath, "utf8")).toContain("Use only approved tools and context.");
    expect(readFileSync(packetPath, "utf8")).toContain("## Terminal Tool Guidance");
    expect(readFileSync(packetPath, "utf8")).toContain("`rg`: Use for source/text search.");
    expect(readFileSync(packetPath, "utf8")).toContain("`fd`: Use for filename/path discovery.");
    expect(readFileSync(packetPath, "utf8")).toContain("`jq`: Use for JSON payloads, logs, and config.");
    expect(readFileSync(packetPath, "utf8")).toContain("`gh`: Use only for explicit GitHub work.");
    expect(readFileSync(packetPath, "utf8")).toContain("`glab`: GitLab-only and non-default; use only for explicit GitLab tasks.");
    expect(readFileSync(packetPath, "utf8")).toContain("Do not run git operations unless the task or project rules explicitly allow them.");
    expect(readFileSync(packetPath, "utf8")).toContain("## Acceptance Criteria");
    expect(readFileSync(packetPath, "utf8")).toContain("- Patch-ready file exists.");
    daemon.close();
  });

  it("runs multiple ready tasks in parallel from a command template", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-project-cli-ready-"));
    const tasksFile = join(projectPath, "tasks.json");
    writeFileSync(
      tasksFile,
      JSON.stringify({
        tasks: [
          { clientKey: "a", title: "Task A", goal: "Write first file.", risk: "low" },
          { clientKey: "b", title: "Task B", goal: "Write second file.", risk: "low" }
        ]
      })
    );
    const created = await runProjectCommand(
      {
        command: "create",
        json: false,
        projectPath,
        promptSummary: "Run ready test.",
        pipelineProfile: "balanced",
        maxParallelAgents: 4
      },
      call
    );
    const queueId = created.data.queueId as string;
    await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);
    const status = await call<{ tasks: Array<{ queueTaskId: string }> }>("project_queue_status", { queueId });
    for (const task of status.tasks) {
      mkdirSync(join(projectPath, task.queueTaskId), { recursive: true });
    }

    const result = await runProjectCommand(
      {
        command: "run-ready",
        json: false,
        queueId,
        limit: 2,
        parallel: 2,
        commandTemplate: "node -e \"require('node:fs').writeFileSync({{queueTaskId}} + '.txt', {{title}})\"",
        cwdTemplate: `${projectPath}/{{queueTaskId}}`,
        worker: "manual",
        workspaceMode: "in_place",
        modelProfile: "execute.cheap",
        successStatus: "patch_ready",
        maxOutputChars: 4_000,
        approveToolContext: true,
        rememberToolContext: true,
        continueOnFailure: false,
        allowSharedCwd: false
      },
      call
    );

    expect(result.action).toBe("ready_tasks_run");
    expect(result.data.runCount).toBe(2);
    const runs = result.data.runs as Array<{ queueTaskId: string; changedFiles: string[] }>;
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run.changedFiles).toEqual([`${run.queueTaskId}.txt`]);
      expect(readFileSync(join(projectPath, run.queueTaskId, `${run.queueTaskId}.txt`), "utf8")).toMatch(/^Task [AB]$/);
    }
    daemon.close();
  });

  it("prepares sandbox cwd-template directories for parallel run-ready", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-project-cli-sandbox-ready-"));
    const tasksFile = join(projectPath, "tasks.json");
    writeFileSync(
      tasksFile,
      JSON.stringify({
        tasks: [
          { clientKey: "a", title: "Task A", goal: "Write first sandbox file.", risk: "low" },
          { clientKey: "b", title: "Task B", goal: "Write second sandbox file.", risk: "low" }
        ]
      })
    );
    const created = await runProjectCommand(
      {
        command: "create",
        json: false,
        projectPath,
        promptSummary: "Sandbox ready test.",
        pipelineProfile: "balanced",
        maxParallelAgents: 4
      },
      call
    );
    const queueId = created.data.queueId as string;
    await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);

    const result = await runProjectCommand(
      {
        command: "run-ready",
        json: false,
        queueId,
        limit: 2,
        parallel: 2,
        commandTemplate: "node -e \"require('node:fs').writeFileSync({{queueTaskId}} + '.txt', {{title}})\"",
        cwdTemplate: `${projectPath}/sandboxes/{{queueTaskId}}`,
        worker: "manual",
        workspaceMode: "sandbox",
        modelProfile: "execute.cheap",
        successStatus: "patch_ready",
        maxOutputChars: 4_000,
        approveToolContext: true,
        rememberToolContext: true,
        continueOnFailure: false,
        allowSharedCwd: false
      },
      call
    );

    expect(result.action).toBe("ready_tasks_run");
    expect(result.data.runCount).toBe(2);
    const runs = result.data.runs as Array<{ queueTaskId: string; changedFiles: string[] }>;
    for (const run of runs) {
      const sandboxFile = join(projectPath, "sandboxes", run.queueTaskId, `${run.queueTaskId}.txt`);
      expect(readFileSync(sandboxFile, "utf8")).toMatch(/^Task [AB]$/);
      expect(run.changedFiles).toEqual([`${run.queueTaskId}.txt`]);
    }
    daemon.close();
  });

  it("reduces run-ready parallelism after DeepSeek rate-limit failures when adaptive mode is enabled", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-project-cli-adaptive-ready-"));
    const tasksFile = join(projectPath, "tasks.json");
    writeFileSync(
      tasksFile,
      JSON.stringify({
        tasks: [
          { clientKey: "a", title: "Rate Limited", goal: "Simulate DeepSeek 429.", risk: "low" },
          { clientKey: "b", title: "Task B", goal: "Write second file.", risk: "low" },
          { clientKey: "c", title: "Task C", goal: "Write third file.", risk: "low" }
        ]
      })
    );
    const created = await runProjectCommand(
      {
        command: "create",
        json: false,
        projectPath,
        promptSummary: "Adaptive ready test.",
        pipelineProfile: "balanced",
        maxParallelAgents: 4
      },
      call
    );
    const queueId = created.data.queueId as string;
    await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);

    const result = await runProjectCommand(
      {
        command: "run-ready",
        json: false,
        queueId,
        limit: 3,
        parallel: 2,
        minParallel: 1,
        adaptiveRateLimit: true,
        commandTemplate:
          "node -e \"const fs=require('node:fs');const title=process.argv[1];if(title==='Rate Limited'){console.error('DEEPSEEK_RATE_LIMITED 429');process.exit(1)}fs.writeFileSync(title + '.txt','ok')\" {{title}}",
        cwdTemplate: `${projectPath}/sandboxes/{{queueTaskId}}`,
        worker: "manual",
        workspaceMode: "sandbox",
        modelProfile: "execute.cheap",
        successStatus: "patch_ready",
        maxOutputChars: 4_000,
        approveToolContext: true,
        rememberToolContext: false,
        continueOnFailure: false,
        allowSharedCwd: false
      },
      call
    );

    expect(result.action).toBe("ready_tasks_run");
    expect(result.data.runCount).toBe(3);
    expect(result.data.rateLimitSignals).toBe(1);
    expect(result.data.finalParallel).toBe(1);
    expect(result.data.parallelAdjustments).toMatchObject([{ reason: "deepseek_rate_limit", from: 2, to: 1 }]);
    daemon.close();
  });

  it("guards broad queue runners with a local per-queue lock", async () => {
    const queueId = "pqueue_lock_test";
    const lockDir = join(tmpdir(), "agent-fabric-runner-locks", `${queueId}.lock`);
    rmSync(lockDir, { recursive: true, force: true });
    mkdirSync(lockDir, { recursive: true });
    const call: ProjectToolCaller = async () => {
      throw new Error("runner lock should prevent project tool calls");
    };

    await expect(
      runProjectCommand(
        {
          command: "run-ready",
          json: false,
          queueId,
          limit: 1,
          parallel: 1,
          minParallel: 1,
          adaptiveRateLimit: false,
          commandTemplate: "echo ok",
          taskPacketFormat: "json",
          worker: "manual",
          workspaceMode: "sandbox",
          modelProfile: "execute.cheap",
          successStatus: "patch_ready",
          maxOutputChars: 4_000,
          approveToolContext: true,
          rememberToolContext: false,
          continueOnFailure: false,
          allowSharedCwd: false
        },
        call
      )
    ).rejects.toThrow("Another local queue runner");
    rmSync(lockDir, { recursive: true, force: true });
  });

  it("previews a DeepSeek factory-run without launching workers", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-project-cli-factory-preview-"));
    const created = await runProjectCommand(
      {
        command: "create",
        json: false,
        projectPath,
        promptSummary: "Factory preview test.",
        pipelineProfile: "balanced",
        maxParallelAgents: 4
      },
      call
    );
    const queueId = created.data.queueId as string;
    await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile: writeTasksFile(projectPath), approveQueue: true }, call);

    const result = await runProjectCommand(
      {
        command: "factory-run",
        json: false,
        queueId,
        limit: 1,
        parallel: 4,
        minParallel: 1,
        adaptiveRateLimit: true,
        deepSeekWorkerCommand: "agent-fabric-deepseek-worker",
        deepSeekRole: "auto",
        sensitiveContextMode: "strict",
        patchMode: "write",
        taskPacketDir: "relative-packets",
        cwdTemplate: "relative-worktrees/{{queueTaskId}}",
        maxOutputChars: 4_000,
        approveToolContext: true,
        rememberToolContext: false,
        continueOnFailure: false,
        startExecution: false,
        dryRun: true,
        allowSensitiveContext: false
      },
      call
    );

    expect(result.action).toBe("factory_run_preview");
    expect(result.message).toContain("factory-run preview");
    expect(result.data.commandTemplate).toContain("AGENT_FABRIC_DEEPSEEK_AUTO_QUEUE=off");
    expect(result.data.commandTemplate).toContain("--json");
    expect(result.data.commandTemplate).toContain("--role {{deepseekRole}}");
    expect(result.data.commandTemplate).toContain("--sensitive-context-mode strict");
    expect(result.data.packetDir).toBe(resolve("relative-packets"));
    expect(result.data.cwdTemplate).toBe(resolve("relative-worktrees/{{queueTaskId}}"));
    daemon.close();
  });

  it("passes generated task packet paths into run-ready templates", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-project-cli-packet-run-"));
    const packetDir = join(projectPath, "packets");
    const tasksFile = writeTasksFile(projectPath);
    const created = await runProjectCommand(
      {
        command: "create",
        json: false,
        projectPath,
        promptSummary: "Packet run test.",
        pipelineProfile: "balanced",
        maxParallelAgents: 4
      },
      call
    );
    const queueId = created.data.queueId as string;
    await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);

    const result = await runProjectCommand(
      {
        command: "run-ready",
        json: false,
        queueId,
        limit: 1,
        parallel: 1,
        taskPacketDir: packetDir,
        taskPacketFormat: "json",
        commandTemplate:
          "node -e \"const fs=require('node:fs');const p=process.argv[1];const data=JSON.parse(fs.readFileSync(p,'utf8'));fs.writeFileSync('packet-title.txt',data.task.title)\" {{taskPacket}}",
        cwd: projectPath,
        worker: "manual",
        workspaceMode: "in_place",
        modelProfile: "execute.cheap",
        successStatus: "patch_ready",
        maxOutputChars: 4_000,
        approveToolContext: true,
        rememberToolContext: false,
        continueOnFailure: false,
        allowSharedCwd: false
      },
      call
    );

    expect(result.action).toBe("ready_tasks_run");
    expect(readFileSync(join(projectPath, "packet-title.txt"), "utf8")).toBe("Run command");
    const packets = result.data.runs as Array<{ queueTaskId: string; fabricTaskId: string; taskPacketPath: string; taskPacketFormat: string }>;
    expect(packets[0].taskPacketPath).toBe(join(packetDir, `${packets[0].queueTaskId}.json`));
    expect(packets[0].taskPacketFormat).toBe("json");
    expect(readFileSync(join(packetDir, `${packets[0].queueTaskId}.json`), "utf8")).toContain("agent-fabric.task-packet.v1");
    const workerStatus = await call<{ workerRuns: Array<{ metadata: Record<string, unknown> }> }>("fabric_task_status", {
      taskId: packets[0].fabricTaskId,
      includeWorkerRuns: true
    });
    expect(workerStatus.workerRuns[0].metadata).toMatchObject({ taskPacketPath: packets[0].taskPacketPath, taskPacketFormat: "json" });
    daemon.close();
  });

  it("writes bounded task context files for queue-visible DeepSeek style lanes", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-project-cli-context-run-"));
    mkdirSync(join(projectPath, "src"), { recursive: true });
    writeFileSync(join(projectPath, "src", "example.ts"), "export function answer() { return 42; }\n", "utf8");
    writeFileSync(join(projectPath, "README.md"), "# Context readme\n", "utf8");
    const packetDir = join(projectPath, "packets");
    const tasksFile = join(projectPath, "tasks.json");
    writeFileSync(
      tasksFile,
      JSON.stringify({
        tasks: [
          {
            clientKey: "context",
            title: "Use source context",
            goal: "Use concrete source context.",
            risk: "low",
            priority: "normal",
            expectedFiles: ["src/example.ts"],
            acceptanceCriteria: ["Context includes source file."],
            requiredTools: ["shell"],
            requiredContextRefs: ["README.md"]
          }
        ]
      }),
      "utf8"
    );
    const created = await runProjectCommand(
      {
        command: "create",
        json: false,
        projectPath,
        promptSummary: "Context run test.",
        pipelineProfile: "balanced",
        maxParallelAgents: 4
      },
      call
    );
    const queueId = created.data.queueId as string;
    await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);

    const result = await runProjectCommand(
      {
        command: "run-ready",
        json: false,
        queueId,
        limit: 1,
        parallel: 1,
        taskPacketDir: packetDir,
        taskPacketFormat: "json",
        commandTemplate:
          "node -e \"const fs=require('node:fs');fs.copyFileSync(process.argv[2],'context-copy.md');fs.writeFileSync('packet-title.txt',JSON.parse(fs.readFileSync(process.argv[1],'utf8')).task.title)\" {{taskPacket}} {{contextFile}}",
        cwd: projectPath,
        worker: "manual",
        workspaceMode: "in_place",
        modelProfile: "execute.cheap",
        successStatus: "patch_ready",
        maxOutputChars: 4_000,
        approveToolContext: true,
        rememberToolContext: false,
        continueOnFailure: false,
        allowSharedCwd: false
      },
      call
    );

    expect(result.action).toBe("ready_tasks_run");
    expect(readFileSync(join(projectPath, "context-copy.md"), "utf8")).toContain("export function answer");
    const runs = result.data.runs as Array<{ taskContextPath: string; taskContextFiles: string[] }>;
    expect(readFileSync(runs[0].taskContextPath, "utf8")).toContain("README.md");
    expect(runs[0].taskContextFiles).toEqual(expect.arrayContaining(["src/example.ts", "README.md"]));
    daemon.close();
  });

  it("runs jcode-deepseek ready tasks through the configured dispatcher", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-project-cli-jcode-ready-"));
    const packetDir = join(projectPath, "packets");
    const sandboxDir = join(projectPath, "sandboxes");
    const dispatcher = join(projectPath, "fake-jcode-deepseek.sh");
    const oldDispatcher = process.env.AGENT_FABRIC_JCODE_DEEPSEEK_DISPATCHER;
    writeFileSync(
      dispatcher,
      [
        "#!/bin/sh",
        "set -eu",
        "packet=\"$1\"",
        "result=\"$PWD/jcode-worker-result.json\"",
        "node -e 'const fs=require(\"node:fs\");const packet=process.argv[1];const result=process.argv[2];fs.writeFileSync(result, JSON.stringify({schema:\"agent-fabric.deepseek-worker-result.v1\", result:{status:\"completed\", summary:\"jcode dispatcher completed.\", changedFilesSuggested:[packet], testsSuggested:[\"dispatcher smoke\"]}}));' \"$packet\" \"$result\"",
        "echo \"$result\"",
        ""
      ].join("\n"),
      "utf8"
    );
    chmodSync(dispatcher, 0o755);
    process.env.AGENT_FABRIC_JCODE_DEEPSEEK_DISPATCHER = dispatcher;

    try {
      const created = await runProjectCommand(
        {
          command: "create",
          json: false,
          projectPath,
          promptSummary: "jcode DeepSeek run-ready test.",
          pipelineProfile: "balanced",
          maxParallelAgents: 4
        },
        call
      );
      const queueId = created.data.queueId as string;
      await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile: writeTasksFile(projectPath), approveQueue: true }, call);
      await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);

      const blocked = await runProjectCommand(
        {
          command: "run-ready",
          json: false,
          queueId,
          limit: 1,
          parallel: 1,
          taskPacketDir: packetDir,
          taskPacketFormat: "markdown",
          cwdTemplate: `${sandboxDir}/{{queueTaskId}}`,
          worker: "jcode-deepseek",
          workspaceMode: "sandbox",
          modelProfile: "deepseek-v4-pro:max",
          successStatus: "patch_ready",
          maxOutputChars: 4_000,
          approveToolContext: true,
          rememberToolContext: false,
          continueOnFailure: false,
          allowSharedCwd: false
        },
        call
      );
      const skipped = blocked.data.skipped as Array<{ requestId?: string; reason?: string }>;
      expect(skipped[0]).toMatchObject({ reason: "model approval required" });
      expect(typeof skipped[0].requestId).toBe("string");
      const approval = await call<{ approvalToken: string }>("llm_approve", {
        requestId: skipped[0].requestId,
        decision: "allow",
        scope: "call",
        expiresInSeconds: 60
      });

      const result = await runProjectCommand(
        {
          command: "run-ready",
          json: false,
          queueId,
          limit: 1,
          parallel: 1,
          taskPacketDir: packetDir,
          taskPacketFormat: "markdown",
          cwdTemplate: `${sandboxDir}/{{queueTaskId}}`,
          worker: "jcode-deepseek",
          workspaceMode: "sandbox",
          modelProfile: "deepseek-v4-pro:max",
          approvalToken: approval.approvalToken,
          successStatus: "patch_ready",
          maxOutputChars: 4_000,
          approveToolContext: true,
          rememberToolContext: false,
          continueOnFailure: false,
          allowSharedCwd: false
        },
        call
      );

      expect(result.action).toBe("ready_tasks_run");
      expect(result.data.runCount).toBe(1);
      const runs = result.data.runs as Array<{ queueTaskId: string; taskPacketPath: string; taskPacketFormat: string; structuredResult: Record<string, unknown> }>;
      expect(runs[0].taskPacketFormat).toBe("markdown");
      expect(readFileSync(runs[0].taskPacketPath, "utf8")).toContain("# Run command");
      expect(runs[0].structuredResult).toMatchObject({
        status: "completed",
        summary: "jcode dispatcher completed."
      });
      expect(String(runs[0].structuredResult.source)).toMatch(new RegExp(`/sandboxes/${runs[0].queueTaskId}/jcode-worker-result\\.json$`));
    } finally {
      if (oldDispatcher === undefined) delete process.env.AGENT_FABRIC_JCODE_DEEPSEEK_DISPATCHER;
      else process.env.AGENT_FABRIC_JCODE_DEEPSEEK_DISPATCHER = oldDispatcher;
      daemon.close();
    }
  });

  it("captures structured DeepSeek worker result artifacts in task checkpoints", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-project-cli-structured-"));
    const tasksFile = writeTasksFile(projectPath);
    const created = await runProjectCommand(
      {
        command: "create",
        json: false,
        projectPath,
        promptSummary: "Structured worker output test.",
        pipelineProfile: "balanced",
        maxParallelAgents: 4
      },
      call
    );
    const queueId = created.data.queueId as string;
    const imported = await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    const task = (imported.data.created as Array<{ queueTaskId: string; fabricTaskId: string }>)[0];
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);

    const artifact = {
      schema: "agent-fabric.deepseek-worker-result.v1",
      status: "completed",
      result: {
        status: "completed",
        summary: "DeepSeek direct worker completed the task.",
        changedFilesSuggested: ["src/runtime/deepseek-worker.ts"],
        testsSuggested: ["npm test -- project-cli"]
      }
    };
    const artifactInput = join(projectPath, "artifact-input.json");
    writeFileSync(artifactInput, JSON.stringify(artifact), "utf8");
    const commandLine = `node -e "const fs=require('node:fs');fs.writeFileSync('deepseek-result.json', fs.readFileSync(process.argv[1], 'utf8'))" ${artifactInput}`;
    const ran = await runProjectCommand(
      {
        command: "run-task",
        json: false,
        queueId,
        queueTaskId: task.queueTaskId,
        commandLine,
        cwd: projectPath,
        worker: "manual",
        workspaceMode: "in_place",
        modelProfile: "deepseek-v4-pro:max",
        successStatus: "patch_ready",
        maxOutputChars: 4_000,
        approveToolContext: true,
        rememberToolContext: false
      },
      call
    );

    expect(ran.action).toBe("task_run_completed");
    expect(ran.data.structuredResult).toMatchObject({ status: "completed", summary: "DeepSeek direct worker completed the task." });
    const status = await call<{ status: string; events: Array<{ kind: string; metadata?: Record<string, unknown> }>; checkpoints: Array<{ summary: Record<string, unknown> }> }>(
      "fabric_task_status",
      {
        taskId: task.fabricTaskId,
        includeEvents: true,
        includeCheckpoints: true
      }
    );
    expect(status.status).toBe("completed");
    expect(status.events.map((event) => event.kind)).toContain("checkpoint");
    expect(status.checkpoints[0].summary).toMatchObject({
      structuredResult: {
        status: "completed",
        changedFilesSuggested: ["src/runtime/deepseek-worker.ts"]
      },
      testsSuggested: ["npm test -- project-cli"]
    });
    daemon.close();
  });

  it("applies a reviewed DeepSeek write-mode patch through review-patches", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-project-cli-reviewed-apply-"));
    const tasksFile = writeTasksFile(projectPath);
    writeFileSync(join(projectPath, "hello.txt"), "old\n", "utf8");
    const created = await runProjectCommand(
      {
        command: "create",
        json: false,
        projectPath,
        promptSummary: "Reviewed apply test.",
        pipelineProfile: "balanced",
        maxParallelAgents: 4
      },
      call
    );
    const queueId = created.data.queueId as string;
    const imported = await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    const task = (imported.data.created as Array<{ queueTaskId: string; fabricTaskId: string }>)[0];
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);

    const proposedPatch = [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new"
    ].join("\n");
    const artifact = {
      schema: "agent-fabric.deepseek-worker-result.v1",
      status: "patch_ready",
      patchMode: "write",
      patchFile: "result.patch",
      result: {
        status: "patch_ready",
        summary: "Reviewed patch is ready.",
        proposedPatch,
        changedFilesSuggested: ["hello.txt"],
        testsSuggested: ["npm test -- project-cli"]
      }
    };
    const artifactInput = join(projectPath, "artifact-input.json");
    const patchInput = join(projectPath, "patch-input.patch");
    writeFileSync(artifactInput, JSON.stringify(artifact), "utf8");
    writeFileSync(patchInput, proposedPatch, "utf8");
    const commandLine =
      `node -e "const fs=require('node:fs');fs.writeFileSync('deepseek-result.json', fs.readFileSync(process.argv[1], 'utf8'));fs.writeFileSync('result.patch', fs.readFileSync(process.argv[2], 'utf8'))" ${artifactInput} ${patchInput}`;

    const ran = await runProjectCommand(
      {
        command: "run-task",
        json: false,
        queueId,
        queueTaskId: task.queueTaskId,
        commandLine,
        cwd: projectPath,
        worker: "manual",
        workspaceMode: "in_place",
        modelProfile: "deepseek-v4-pro:max",
        successStatus: "patch_ready",
        maxOutputChars: 4_000,
        approveToolContext: true,
        rememberToolContext: false
      },
      call
    );

    expect(ran.action).toBe("task_run_completed");
    expect(readFileSync(join(projectPath, "hello.txt"), "utf8")).toBe("old\n");

    const applied = await runProjectCommand(
      {
        command: "review-patches",
        json: false,
        queueId,
        acceptTaskId: task.queueTaskId,
        applyPatch: true
      },
      call
    );

    expect(applied.action).toBe("patch_applied_and_accepted");
    expect(applied.message).toContain("Applied patch:");
    expect(readFileSync(join(projectPath, "hello.txt"), "utf8")).toBe("new");
    const queue = await call<{ tasks: Array<{ queueTaskId: string; status: string }> }>("project_queue_status", { queueId });
    expect(queue.tasks.find((entry) => entry.queueTaskId === task.queueTaskId)?.status).toBe("accepted");
    const fabric = await call<{
      status: string;
      events: Array<{ kind: string; metadata?: Record<string, unknown> }>;
      checkpoints: Array<{ summary: Record<string, unknown> }>;
    }>("fabric_task_status", {
      taskId: task.fabricTaskId,
      includeEvents: true,
      includeCheckpoints: true
    });
    expect(fabric.status).toBe("completed");
    expect(fabric.events.some((event) => event.metadata?.action === "review_patch_apply")).toBe(true);
    expect(fabric.checkpoints.some((checkpoint) => checkpoint.summary.patchFile === join(projectPath, "result.patch"))).toBe(true);
    daemon.close();
  });

  it("rejects review-patches apply when only report-mode proposedPatch exists", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-project-cli-report-apply-"));
    const tasksFile = writeTasksFile(projectPath);
    writeFileSync(join(projectPath, "hello.txt"), "old\n", "utf8");
    const created = await runProjectCommand(
      {
        command: "create",
        json: false,
        projectPath,
        promptSummary: "Report apply reject test.",
        pipelineProfile: "balanced",
        maxParallelAgents: 4
      },
      call
    );
    const queueId = created.data.queueId as string;
    const imported = await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    const task = (imported.data.created as Array<{ queueTaskId: string; fabricTaskId: string }>)[0];
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);

    const artifact = {
      schema: "agent-fabric.deepseek-worker-result.v1",
      status: "patch_ready",
      patchMode: "report",
      result: {
        status: "patch_ready",
        summary: "Report-only proposed patch.",
        proposedPatch: [
          "diff --git a/hello.txt b/hello.txt",
          "--- a/hello.txt",
          "+++ b/hello.txt",
          "@@ -1 +1 @@",
          "-old",
          "+new"
        ].join("\n")
      }
    };
    const artifactInput = join(projectPath, "artifact-input.json");
    writeFileSync(artifactInput, JSON.stringify(artifact), "utf8");
    const commandLine = `node -e "const fs=require('node:fs');fs.writeFileSync('deepseek-result.json', fs.readFileSync(process.argv[1], 'utf8'))" ${artifactInput}`;
    await runProjectCommand(
      {
        command: "run-task",
        json: false,
        queueId,
        queueTaskId: task.queueTaskId,
        commandLine,
        cwd: projectPath,
        worker: "manual",
        workspaceMode: "in_place",
        modelProfile: "deepseek-v4-pro:max",
        successStatus: "patch_ready",
        maxOutputChars: 4_000,
        approveToolContext: true,
        rememberToolContext: false
      },
      call
    );

    await expect(
      runProjectCommand(
        {
          command: "review-patches",
          json: false,
          queueId,
          acceptTaskId: task.queueTaskId,
          applyPatch: true
        },
        call
      )
    ).rejects.toThrow("No reviewed patch file");
    expect(readFileSync(join(projectPath, "hello.txt"), "utf8")).toBe("old\n");
    const queue = await call<{ tasks: Array<{ queueTaskId: string; status: string }> }>("project_queue_status", { queueId });
    expect(queue.tasks.find((entry) => entry.queueTaskId === task.queueTaskId)?.status).toBe("patch_ready");
    daemon.close();
  });

  it("rejects review-patches apply when the reviewed patch file is outside apply cwd", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-project-cli-outside-patch-"));
    const tasksFile = writeTasksFile(projectPath);
    const outsidePatch = join(tmpdir(), `agent-fabric-outside-${Date.now()}.patch`);
    writeFileSync(join(projectPath, "hello.txt"), "old\n", "utf8");
    writeFileSync(
      outsidePatch,
      [
        "diff --git a/hello.txt b/hello.txt",
        "--- a/hello.txt",
        "+++ b/hello.txt",
        "@@ -1 +1 @@",
        "-old",
        "+new"
      ].join("\n"),
      "utf8"
    );
    const created = await runProjectCommand(
      {
        command: "create",
        json: false,
        projectPath,
        promptSummary: "Outside patch reject test.",
        pipelineProfile: "balanced",
        maxParallelAgents: 4
      },
      call
    );
    const queueId = created.data.queueId as string;
    const imported = await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    const task = (imported.data.created as Array<{ queueTaskId: string; fabricTaskId: string }>)[0];
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);

    const artifact = {
      schema: "agent-fabric.deepseek-worker-result.v1",
      status: "patch_ready",
      patchMode: "write",
      patchFile: outsidePatch,
      result: {
        status: "patch_ready",
        summary: "Outside patch file.",
        changedFilesSuggested: ["hello.txt"]
      }
    };
    const artifactInput = join(projectPath, "artifact-input.json");
    writeFileSync(artifactInput, JSON.stringify(artifact), "utf8");
    const commandLine = `node -e "const fs=require('node:fs');fs.writeFileSync('deepseek-result.json', fs.readFileSync(process.argv[1], 'utf8'))" ${artifactInput}`;
    await runProjectCommand(
      {
        command: "run-task",
        json: false,
        queueId,
        queueTaskId: task.queueTaskId,
        commandLine,
        cwd: projectPath,
        worker: "manual",
        workspaceMode: "in_place",
        modelProfile: "deepseek-v4-pro:max",
        successStatus: "patch_ready",
        maxOutputChars: 4_000,
        approveToolContext: true,
        rememberToolContext: false
      },
      call
    );

    await expect(
      runProjectCommand(
        {
          command: "review-patches",
          json: false,
          queueId,
          acceptTaskId: task.queueTaskId,
          applyPatch: true
        },
        call
      )
    ).rejects.toThrow("Reviewed patch file must be inside apply cwd");
    expect(readFileSync(join(projectPath, "hello.txt"), "utf8")).toBe("old\n");
    daemon.close();
  });

  it("preflights deepseek-direct worker commands before shell execution", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-project-cli-deepseek-preflight-"));
    const created = await runProjectCommand(
      {
        command: "create",
        json: false,
        projectPath,
        promptSummary: "DeepSeek preflight test.",
        pipelineProfile: "balanced",
        maxParallelAgents: 4
      },
      call
    );
    const queueId = created.data.queueId as string;
    const imported = await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile: writeTasksFile(projectPath), approveQueue: true }, call);
    const task = (imported.data.created as Array<{ queueTaskId: string }>)[0];
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);

    const blocked = await runProjectCommand(
      {
        command: "run-task",
        json: false,
        queueId,
        queueTaskId: task.queueTaskId,
        commandLine: "node -e \"require('node:fs').writeFileSync('should-not-run.txt','no')\"",
        cwd: projectPath,
        worker: "deepseek-direct",
        workspaceMode: "in_place",
        modelProfile: "deepseek-v4-pro:max",
        successStatus: "patch_ready",
        maxOutputChars: 4_000,
        approveToolContext: true,
        rememberToolContext: false
      },
      call
    );

    expect(blocked.action).toBe("run_task_blocked");
    expect(blocked.message).toContain("DeepSeek direct model approval required");
    expect(existsSync(join(projectPath, "should-not-run.txt"))).toBe(false);
    daemon.close();
  });

  it("auto-injects fabric task linkage into custom deepseek-direct run-ready templates", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-project-cli-deepseek-template-"));
    const packetDir = join(projectPath, "packets");
    const fakeWorker = join(projectPath, "agent-fabric-deepseek-worker");
    writeFileSync(
      fakeWorker,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$@\" > deepseek-args.txt",
        "printf '%s\\n' '{\"schema\":\"agent-fabric.deepseek-worker-result.v1\",\"status\":\"completed\",\"result\":{\"status\":\"completed\",\"summary\":\"fake DeepSeek worker completed.\"}}' > fake-result.json",
        "printf '%s\\n' fake-result.json"
      ].join("\n")
    );
    chmodSync(fakeWorker, 0o755);
    const created = await runProjectCommand(
      {
        command: "create",
        json: false,
        projectPath,
        promptSummary: "DeepSeek template linkage test.",
        pipelineProfile: "balanced",
        maxParallelAgents: 20
      },
      call
    );
    const queueId = created.data.queueId as string;
    const imported = await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile: writeTasksFile(projectPath), approveQueue: true }, call);
    const task = (imported.data.created as Array<{ queueTaskId: string; fabricTaskId: string }>)[0];
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);

    const blocked = await runProjectCommand(
      {
        command: "run-ready",
        json: false,
        queueId,
        limit: 1,
        parallel: 1,
        taskPacketDir: packetDir,
        taskPacketFormat: "json",
        commandTemplate: `${fakeWorker} run-task --task-packet {{taskPacket}} --context-file {{contextFile}} --role planner`,
        cwd: projectPath,
        worker: "deepseek-direct",
        workspaceMode: "in_place",
        modelProfile: "deepseek-v4-pro:max",
        successStatus: "completed",
        maxOutputChars: 4_000,
        approveToolContext: true,
        rememberToolContext: false,
        continueOnFailure: false,
        allowSharedCwd: false
      },
      call
    );
    const skipped = blocked.data.skipped as Array<{ requestId?: string; reason?: string }>;
    expect(skipped[0]).toMatchObject({ reason: "model approval required" });
    const approval = await call<{ approvalToken: string }>("llm_approve", {
      requestId: skipped[0].requestId,
      decision: "allow",
      scope: "call",
      expiresInSeconds: 60
    });

    const result = await runProjectCommand(
      {
        command: "run-ready",
        json: false,
        queueId,
        limit: 1,
        parallel: 1,
        taskPacketDir: packetDir,
        taskPacketFormat: "json",
        commandTemplate: `${fakeWorker} run-task --task-packet {{taskPacket}} --context-file {{contextFile}} --role planner`,
        cwd: projectPath,
        worker: "deepseek-direct",
        workspaceMode: "in_place",
        modelProfile: "deepseek-v4-pro:max",
        approvalToken: approval.approvalToken,
        successStatus: "completed",
        maxOutputChars: 4_000,
        approveToolContext: true,
        rememberToolContext: false,
        continueOnFailure: false,
        allowSharedCwd: false
      },
      call
    );

    expect(result.action).toBe("ready_tasks_run");
    expect(readFileSync(join(projectPath, "deepseek-args.txt"), "utf8")).toContain(`--fabric-task\n${task.fabricTaskId}`);
    daemon.close();
  });

  it("parses merge-worker command and enforces review metadata for --apply", () => {
    expect(parseProjectCliArgs([
      "merge-worker", "--queue", "pqueue_1", "--agent", "@af/rami-abc123", "--json"
    ])).toMatchObject({
      command: "merge-worker",
      queueId: "pqueue_1",
      agent: "@af/rami-abc123",
      apply: false,
      json: true
    });

    expect(parseProjectCliArgs([
      "merge-worker", "--queue", "pqueue_1", "--agent", "@af/rami-abc123",
      "--apply", "--reviewed-by", "Codex", "--review-summary", "Reviewed.", "--run-tests"
    ])).toMatchObject({
      command: "merge-worker",
      queueId: "pqueue_1",
      agent: "@af/rami-abc123",
      apply: true,
      runTests: true,
      reviewedBy: "Codex",
      reviewSummary: "Reviewed."
    });

    expect(() =>
      parseProjectCliArgs([
        "merge-worker", "--queue", "pqueue_1", "--agent", "@af/rami-abc123", "--apply"
      ])
    ).toThrow("merge-worker --apply requires --reviewed-by");
  });

  it("merge-worker dry-run validates patch and returns conflict info", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-project-cli-merge-dry-"));
    const tasksFile = join(projectPath, "tasks.json");
    writeFileSync(
      tasksFile,
      JSON.stringify({
        tasks: [
          {
            clientKey: "merge",
            title: "Merge test task",
            goal: "Produce a patch for merge.",
            risk: "low",
            priority: "normal",
            expectedFiles: ["hello.txt"],
            acceptanceCriteria: ["Patch applies cleanly."]
          }
        ]
      })
    );
    const created = await runProjectCommand(
      {
        command: "create",
        json: false,
        projectPath,
        promptSummary: "Merge dry-run test.",
        pipelineProfile: "balanced",
        maxParallelAgents: 4
      },
      call
    );
    const queueId = created.data.queueId as string;
    await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);
    const status = await call<{ tasks: Array<{ queueTaskId: string }> }>("project_queue_status", { queueId });
    const task = status.tasks[0];
    writeFileSync(join(projectPath, "hello.txt"), "old\n", "utf8");

    const patch = [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new"
    ].join("\n");
    const patchFile = join(projectPath, "result.patch");
    writeFileSync(patchFile, patch, "utf8");

    await call("project_queue_update_task", {
      queueId,
      queueTaskId: task.queueTaskId,
      status: "patch_ready",
      summary: "Patch is ready.",
      patchRefs: [patchFile],
      testRefs: ["node -e \"process.exit(0)\""]
    });

    const agent = task.queueTaskId;

    const dryRun = await runProjectCommand(
      { command: "merge-worker", json: false, queueId, agent, apply: false, runTests: false, cwd: projectPath },
      call
    );
    expect(dryRun.action).toBe("merge_worker_dry_run");
    expect(readFileSync(join(projectPath, "hello.txt"), "utf8")).toBe("old\n");

    const withTests = await runProjectCommand(
      { command: "merge-worker", json: false, queueId, agent, apply: false, runTests: true, cwd: projectPath },
      call
    );
    expect(withTests.data.readyToApply).toBe(true);

    daemon.close();
  });

  it("merge-worker --apply applies patch and records acceptance", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-project-cli-merge-apply-"));
    const tasksFile = join(projectPath, "tasks.json");
    writeFileSync(
      tasksFile,
      JSON.stringify({
        tasks: [
          {
            clientKey: "merge",
            title: "Merge apply test task",
            goal: "Produce a patch for merge apply.",
            risk: "low",
            priority: "normal",
            expectedFiles: ["hello.txt"],
            acceptanceCriteria: ["Patch applies cleanly."]
          }
        ]
      })
    );
    const created = await runProjectCommand(
      {
        command: "create",
        json: false,
        projectPath,
        promptSummary: "Merge apply test.",
        pipelineProfile: "balanced",
        maxParallelAgents: 4
      },
      call
    );
    const queueId = created.data.queueId as string;
    await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);
    const status = await call<{ tasks: Array<{ queueTaskId: string }> }>("project_queue_status", { queueId });
    const task = status.tasks[0];
    writeFileSync(join(projectPath, "hello.txt"), "old\n", "utf8");

    const patch = [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new"
    ].join("\n");
    const patchFile = join(projectPath, "result.patch");
    writeFileSync(patchFile, patch, "utf8");

    await call("project_queue_update_task", {
      queueId,
      queueTaskId: task.queueTaskId,
      status: "patch_ready",
      summary: "Patch is ready.",
      patchRefs: [patchFile],
      testRefs: ["node -e \"process.exit(0)\""]
    });

    const agent = task.queueTaskId;

    const apply = await runProjectCommand(
      {
        command: "merge-worker",
        json: false,
        queueId,
        agent,
        apply: true,
        runTests: true,
        cwd: projectPath,
        reviewedBy: "Codex",
        reviewSummary: "Tests pass, diff is correct."
      },
      call
    );
    expect(apply.action).toBe("merge_worker_applied");
    expect(readFileSync(join(projectPath, "hello.txt"), "utf8")).toMatch("new");

    const qs = await call<{ tasks: Array<{ queueTaskId: string; status: string }> }>("project_queue_status", { queueId });
    const accepted = qs.tasks.find((entry) => entry.queueTaskId === task.queueTaskId);
    expect(accepted?.status).toBe("accepted");

    daemon.close();
  });

  it("merge-worker --apply blocks on test failure", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-project-cli-merge-testfail-"));
    const tasksFile = join(projectPath, "tasks.json");
    writeFileSync(
      tasksFile,
      JSON.stringify({
        tasks: [
          {
            clientKey: "merge",
            title: "Merge test-fail task",
            goal: "Produce a patch for merge with failing tests.",
            risk: "low",
            priority: "normal",
            expectedFiles: ["hello.txt"],
            acceptanceCriteria: ["Tests must pass before applying."]
          }
        ]
      })
    );
    const created = await runProjectCommand(
      {
        command: "create",
        json: false,
        projectPath,
        promptSummary: "Merge test fail test.",
        pipelineProfile: "balanced",
        maxParallelAgents: 4
      },
      call
    );
    const queueId = created.data.queueId as string;
    await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);
    const status = await call<{ tasks: Array<{ queueTaskId: string }> }>("project_queue_status", { queueId });
    const task = status.tasks[0];
    writeFileSync(join(projectPath, "hello.txt"), "old\n", "utf8");

    const patch = [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new"
    ].join("\n");
    const patchFile = join(projectPath, "result.patch");
    writeFileSync(patchFile, patch, "utf8");

    await call("project_queue_update_task", {
      queueId,
      queueTaskId: task.queueTaskId,
      status: "patch_ready",
      summary: "Patch is ready.",
      patchRefs: [patchFile],
      testRefs: ["node -e \"process.exit(1)\""]
    });

    const agent = task.queueTaskId;

    const apply = await runProjectCommand(
      {
        command: "merge-worker",
        json: false,
        queueId,
        agent,
        apply: true,
        runTests: true,
        cwd: projectPath,
        reviewedBy: "Codex",
        reviewSummary: "Should be blocked."
      },
      call
    );
    expect(apply.action).toBe("merge_worker_test_failed");
    expect(readFileSync(join(projectPath, "hello.txt"), "utf8")).toBe("old\n");

    daemon.close();
  });

  it("parses and runs merge-worker dry-run for a clean patch with diff stats", async () => {
    expect(
      parseProjectCliArgs(["merge-worker", "--queue", "pqueue_1", "--agent", "pqtask_1"])
    ).toMatchObject({ command: "merge-worker", queueId: "pqueue_1", agent: "pqtask_1" });

    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-merge-clean-"));
    const tasksFile = writeTasksFile(projectPath);
    writeFileSync(join(projectPath, "hello.txt"), "old\n", "utf8");
    const created = await runProjectCommand(
      { command: "create", json: false, projectPath, promptSummary: "Merge clean test.", pipelineProfile: "balanced", maxParallelAgents: 4 },
      call
    );
    const queueId = created.data.queueId as string;
    const imported = await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    const task = (imported.data.created as Array<{ queueTaskId: string; fabricTaskId: string }>)[0];
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);

    const proposedPatch = [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new"
    ].join("\n");
    const artifact = {
      schema: "agent-fabric.deepseek-worker-result.v1",
      status: "patch_ready",
      patchMode: "write",
      patchFile: "result.patch",
      result: { status: "patch_ready", summary: "Ready.", proposedPatch, changedFilesSuggested: ["hello.txt"], testsSuggested: ["npm test"] }
    };
    const artifactInput = join(projectPath, "artifact-input.json");
    const patchInput = join(projectPath, "patch-input.patch");
    writeFileSync(artifactInput, JSON.stringify(artifact), "utf8");
    writeFileSync(patchInput, proposedPatch, "utf8");
    const commandLine = `node -e "const fs=require('node:fs');fs.writeFileSync('deepseek-result.json', fs.readFileSync(process.argv[1], 'utf8'));fs.writeFileSync('result.patch', fs.readFileSync(process.argv[2], 'utf8'))" ${artifactInput} ${patchInput}`;
    await runProjectCommand(
      { command: "run-task", json: false, queueId, queueTaskId: task.queueTaskId, commandLine, cwd: projectPath, worker: "manual", workspaceMode: "in_place", modelProfile: "deepseek-v4-pro:max", successStatus: "patch_ready", maxOutputChars: 4_000, approveToolContext: true, rememberToolContext: false },
      call
    );

    const result = await runProjectCommand(
      { command: "merge-worker", json: false, queueId, agent: task.queueTaskId, apply: false, runTests: false, cwd: projectPath },
      call
    );

    expect(result.action).toBe("merge_worker_dry_run");
    // Verify no mutation
    expect(readFileSync(join(projectPath, "hello.txt"), "utf8")).toBe("old\n");
    daemon.close();
  });

  it("detects merge-worker conflicts without mutating", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-merge-conflict-"));
    const tasksFile = writeTasksFile(projectPath);
    writeFileSync(join(projectPath, "hello.txt"), "unexpected\n", "utf8");
    const created = await runProjectCommand(
      { command: "create", json: false, projectPath, promptSummary: "Merge conflict test.", pipelineProfile: "balanced", maxParallelAgents: 4 },
      call
    );
    const queueId = created.data.queueId as string;
    const imported = await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    const task = (imported.data.created as Array<{ queueTaskId: string; fabricTaskId: string }>)[0];
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);

    const proposedPatch = [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new"
    ].join("\n");
    const artifact = {
      schema: "agent-fabric.deepseek-worker-result.v1",
      status: "patch_ready",
      patchMode: "write",
      patchFile: "result.patch",
      result: { status: "patch_ready", summary: "Ready.", proposedPatch, changedFilesSuggested: ["hello.txt"], testsSuggested: ["npm test"] }
    };
    const artifactInput = join(projectPath, "artifact-input.json");
    const patchInput = join(projectPath, "patch-input.patch");
    writeFileSync(artifactInput, JSON.stringify(artifact), "utf8");
    writeFileSync(patchInput, proposedPatch, "utf8");
    const commandLine = `node -e "const fs=require('node:fs');fs.writeFileSync('deepseek-result.json', fs.readFileSync(process.argv[1], 'utf8'));fs.writeFileSync('result.patch', fs.readFileSync(process.argv[2], 'utf8'))" ${artifactInput} ${patchInput}`;
    await runProjectCommand(
      { command: "run-task", json: false, queueId, queueTaskId: task.queueTaskId, commandLine, cwd: projectPath, worker: "manual", workspaceMode: "in_place", modelProfile: "deepseek-v4-pro:max", successStatus: "patch_ready", maxOutputChars: 4_000, approveToolContext: true, rememberToolContext: false },
      call
    );

    const result = await runProjectCommand(
      { command: "merge-worker", json: false, queueId, agent: task.queueTaskId, apply: false, runTests: false, cwd: projectPath },
      call
    );

    expect(result.action).toBe("merge_worker_conflicts_detected");
    expect(result.message).toContain("CONFLICTS DETECTED");
    expect(result.data).toMatchObject({ clean: false, conflictsDetected: true });
    expect(readFileSync(join(projectPath, "hello.txt"), "utf8")).toBe("unexpected\n");
    daemon.close();
  });

  it("reports missing merge-worker artifact cleanly", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-merge-missing-"));
    const tasksFile = writeTasksFile(projectPath);
    writeFileSync(join(projectPath, "hello.txt"), "old\n", "utf8");
    const created = await runProjectCommand(
      { command: "create", json: false, projectPath, promptSummary: "Merge missing test.", pipelineProfile: "balanced", maxParallelAgents: 4 },
      call
    );
    const queueId = created.data.queueId as string;
    const imported = await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    const task = (imported.data.created as Array<{ queueTaskId: string; fabricTaskId: string }>)[0];
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);

    const artifact = {
      schema: "agent-fabric.deepseek-worker-result.v1",
      status: "patch_ready",
      patchMode: "write",
      patchFile: "result.patch",
      result: { status: "patch_ready", summary: "Ready." }
    };
    const artifactInput = join(projectPath, "artifact-input.json");
    writeFileSync(artifactInput, JSON.stringify(artifact), "utf8");
    const commandLine = `node -e "const fs=require('node:fs');fs.writeFileSync('deepseek-result.json', fs.readFileSync(process.argv[1], 'utf8'))" ${artifactInput}`;
    await runProjectCommand(
      { command: "run-task", json: false, queueId, queueTaskId: task.queueTaskId, commandLine, cwd: projectPath, worker: "manual", workspaceMode: "in_place", modelProfile: "deepseek-v4-pro:max", successStatus: "patch_ready", maxOutputChars: 4_000, approveToolContext: true, rememberToolContext: false },
      call
    );

    await expect(
      runProjectCommand({ command: "merge-worker", json: false, queueId, queueTaskId: task.queueTaskId }, call)
    ).rejects.toThrow("PATCH_ARTIFACT_MISSING");
    daemon.close();
  });

  it("resolves merge-worker by workerRunId", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-merge-worker-"));
    const tasksFile = writeTasksFile(projectPath);
    writeFileSync(join(projectPath, "hello.txt"), "old\n", "utf8");
    const created = await runProjectCommand(
      { command: "create", json: false, projectPath, promptSummary: "Merge worker run test.", pipelineProfile: "balanced", maxParallelAgents: 4 },
      call
    );
    const queueId = created.data.queueId as string;
    const imported = await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    const task = (imported.data.created as Array<{ queueTaskId: string; fabricTaskId: string }>)[0];
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);

    const proposedPatch = [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new"
    ].join("\n");
    const artifact = {
      schema: "agent-fabric.deepseek-worker-result.v1",
      status: "patch_ready",
      patchMode: "write",
      patchFile: "result.patch",
      result: { status: "patch_ready", summary: "Ready.", proposedPatch, changedFilesSuggested: ["hello.txt"], testsSuggested: ["npm test"] }
    };
    const artifactInput = join(projectPath, "artifact-input.json");
    const patchInput = join(projectPath, "patch-input.patch");
    writeFileSync(artifactInput, JSON.stringify(artifact), "utf8");
    writeFileSync(patchInput, proposedPatch, "utf8");
    const commandLine = `node -e "const fs=require('node:fs');fs.writeFileSync('deepseek-result.json', fs.readFileSync(process.argv[1], 'utf8'));fs.writeFileSync('result.patch', fs.readFileSync(process.argv[2], 'utf8'))" ${artifactInput} ${patchInput}`;
    const ran = await runProjectCommand(
      { command: "run-task", json: false, queueId, queueTaskId: task.queueTaskId, commandLine, cwd: projectPath, worker: "manual", workspaceMode: "in_place", modelProfile: "deepseek-v4-pro:max", successStatus: "patch_ready", maxOutputChars: 4_000, approveToolContext: true, rememberToolContext: false },
      call
    );

    const workerRunId = (ran.data as Record<string, unknown>).workerRunId as string;
    const result = await runProjectCommand(
      { command: "merge-worker", json: false, queueId, workerRunId },
      call
    );

    expect(result.action).toBe("merge_worker_clean");
    daemon.close();
  });
});

function caller(daemon: FabricDaemon, session: BridgeSession): ProjectToolCaller {
  let sequence = 0;
  return async (tool, input) => {
    sequence += 1;
    const result = daemon.callTool(tool, input, {
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      idempotencyKey: `project-cli-${sequence}-${tool}`
    });
    if (!result.ok) {
      throw new Error(`${result.code}: ${result.message}`);
    }
    return result.data as Record<string, unknown>;
  };
}

function registerPayload(): BridgeRegister {
  return {
    bridgeVersion: "0.1.0",
    agent: { id: "project-cli-test", displayName: "Project CLI Test", vendor: "test" },
    host: { name: "Project CLI Test Host", transport: "simulator" },
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
    notificationSelfTest: { observed: "yes", detail: "simulator" },
    testMode: true
  };
}

function writeTasksFile(projectPath: string): string {
  const file = join(projectPath, "tasks.json");
  writeFileSync(
    file,
    JSON.stringify({
      tasks: [
        {
          clientKey: "run",
          title: "Run command",
          goal: "Run one command and produce a patch-ready file.",
          risk: "low",
          priority: "normal",
          expectedFiles: ["result.txt"],
          acceptanceCriteria: ["Patch-ready file exists."],
          requiredTools: ["fabric_task_event"],
          requiredMcpServers: ["github"],
          requiredMemories: ["memory:user-review-style"],
          requiredContextRefs: ["context:repo-map"]
        }
      ]
    })
  );
  return file;
}
