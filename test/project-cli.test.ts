import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FabricDaemon } from "../src/daemon.js";
import {
  formatProjectResult,
  formatSeniorRun,
  matchesGlob,
  parseProjectCliArgs,
  resolveArtifactIgnoreGlobs,
  runProjectCommand,
  snapshotFiles,
  type ProjectToolCaller
} from "../src/runtime/project-cli.js";
import type { BridgeRegister, BridgeSession } from "../src/types.js";

describe("project CLI runner", () => {
  const originalSeniorMode = process.env.AGENT_FABRIC_SENIOR_MODE;
  const originalSeniorNonDeepSeek = process.env.AGENT_FABRIC_SENIOR_ALLOW_NON_DEEPSEEK_WORKERS;
  const originalSeniorDefaultWorker = process.env.AGENT_FABRIC_SENIOR_DEFAULT_WORKER;
  const originalSeniorDefaultLaneCount = process.env.AGENT_FABRIC_SENIOR_DEFAULT_LANE_COUNT;
  const originalSeniorLaneCount = process.env.AGENT_FABRIC_SENIOR_LANE_COUNT;
  const originalSeniorMaxLaneCount = process.env.AGENT_FABRIC_SENIOR_MAX_LANE_COUNT;
  const originalQueueMaxAgents = process.env.AGENT_FABRIC_QUEUE_MAX_AGENTS;
  const originalArtifactIgnoreGlobs = process.env.AGENT_FABRIC_ARTIFACT_IGNORE_GLOBS;

  beforeEach(() => {
    delete process.env.AGENT_FABRIC_SENIOR_MODE;
    delete process.env.AGENT_FABRIC_SENIOR_ALLOW_NON_DEEPSEEK_WORKERS;
    delete process.env.AGENT_FABRIC_SENIOR_DEFAULT_WORKER;
    delete process.env.AGENT_FABRIC_SENIOR_DEFAULT_LANE_COUNT;
    delete process.env.AGENT_FABRIC_SENIOR_LANE_COUNT;
    delete process.env.AGENT_FABRIC_SENIOR_MAX_LANE_COUNT;
    delete process.env.AGENT_FABRIC_QUEUE_MAX_AGENTS;
    delete process.env.AGENT_FABRIC_ARTIFACT_IGNORE_GLOBS;
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
    if (originalArtifactIgnoreGlobs === undefined) delete process.env.AGENT_FABRIC_ARTIFACT_IGNORE_GLOBS;
    else process.env.AGENT_FABRIC_ARTIFACT_IGNORE_GLOBS = originalArtifactIgnoreGlobs;
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

  it("treats stale daemon/source drift as operator-only daemon control", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-senior-doctor-"));
    try {
      const result = await runProjectCommand(
        { command: "senior-doctor", json: false, projectPath },
        async (tool) => {
          if (tool !== "fabric_status") throw new Error(`unexpected tool call: ${tool}`);
          return {
            daemon: {
              runtime: {
                cwd: "/private/other/agent-fabric",
                entrypoint: "/private/other/agent-fabric/dist/bin/daemon.js",
                packageRoot: "/private/other/agent-fabric"
              },
              tools: {
                seniorRequired: ["fabric_senior_start"],
                missingSeniorRequired: []
              }
            }
          };
        }
      );

      const checks = result.data.checks as Array<Record<string, unknown>>;
      const sourceCheck = checks.find((item) => item.id === "daemon_source");
      expect(sourceCheck).toMatchObject({
        ok: false,
        requiresOperatorApproval: true,
        agentsMayRestartDaemon: false,
        agentsMayKillDaemon: false,
        agentsMayRemoveSocket: false
      });
      expect(String(sourceCheck?.suggestedAction)).toContain("Automated agents must not kill, restart, or remove the shared Agent Fabric daemon/socket");
      expect(result.data.daemonControl).toMatchObject({
        requiresOperatorApproval: true,
        agentsMayRestart: false,
        agentsMayKill: false,
        agentsMayRemoveSocket: false
      });
      expect(result.message).toContain("Daemon control guardrail");
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
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

  describe("compact senior-run final output", () => {
    it("produces a compact status line with lane counts", () => {
      const run = { action: "ready_tasks_run", message: "ran 5 tasks", data: { runCount: 5 } };
      const progress = {
        counts: { total: 10, completed: 3, failed: 1, running: 1, stale: 0, patch_ready: 2 },
        nextActions: [
          { label: "Review failures", command: "agent-fabric-project recover-stale --queue q1" },
          { label: "Review patches", command: "agent-fabric-project review-patches --queue q1" }
        ],
        patchReadyTasks: [
          { queueTaskId: "t1", title: "Fix auth" },
          { queueTaskId: "t2", title: "Add tests" }
        ]
      };

      const output = formatSeniorRun("queue-1", 10, run, "progress.md", progress);

      expect(output).toContain("Senior-run queue queue-1");
      expect(output).toContain("Lanes: 10 requested, 5 ran");
      expect(output).toContain("completed=3, failed=1, running=1, stale=0, patch-ready=2");
      expect(output).toContain("Failed: 1 task(s)");
      expect(output).toContain("Patch-ready: 2 task(s)");
      expect(output).toContain("Fix auth");
      expect(output).toContain("Add tests");
      expect(output).toContain("Progress: progress.md");
      expect(output).toContain("recover-stale");
      expect(output).toContain("review-patches");
    });

    it("omits stale and failed warnings when counts are zero", () => {
      const run = { action: "ready_tasks_run", message: "ran 3 tasks", data: { runCount: 3 } };
      const progress = {
        counts: { total: 3, completed: 3, failed: 0, stale: 0, patch_ready: 0 },
        nextActions: [],
        patchReadyTasks: []
      };

      const output = formatSeniorRun("q1", 3, run, "p.md", progress);

      expect(output).toContain("completed=3, failed=0, running=0, stale=0, patch-ready=0");
      expect(output).not.toContain("Failed:");
      expect(output).not.toContain("Stale:");
      expect(output).not.toContain("Patch-ready:");
      expect(output).not.toContain("Next:");
    });

    it("handles missing progress data gracefully", () => {
      const run = { action: "ready_tasks_run", message: "ran tasks", data: {} };

      const output = formatSeniorRun("q1", 10, run, "p.md");

      expect(output).toContain("Lanes: 10 requested, n/a ran");
      expect(output).toContain("completed=0, failed=0");
      expect(output).not.toContain("Failed:");
      expect(output).not.toContain("Patch-ready:");
    });

    it("shows compact summary even with many failures and stale tasks", () => {
      const run = { action: "ready_tasks_run", message: "ran 50 tasks", data: { runCount: 50, rateLimitSignals: 2 } };
      const progress = {
        counts: { total: 50, completed: 30, failed: 8, running: 5, stale: 3, patch_ready: 4 },
        nextActions: [
          { label: "Retry", command: "retry --queue q1" },
          { label: "Stale", command: "recover-stale --queue q1" },
          { label: "Review", command: "review-patches --queue q1" }
        ],
        patchReadyTasks: [
          { queueTaskId: "t1", title: "Fix auth" },
          { queueTaskId: "t2", title: "Add tests" },
          { queueTaskId: "t3", title: "Docs" },
          { queueTaskId: "t4", title: "Review" }
        ]
      };

      const output = formatSeniorRun("big-queue", 50, run, "progress.md", progress);

      // Bounded - no full run.message dumped
      expect(output).not.toContain("ran 50 tasks"); // from run.message
      expect(output).toContain("Lanes: 50 requested, 50 ran");
      expect(output).toContain("completed=30, failed=8, running=5, stale=3, patch-ready=4");
      expect(output).toContain("Failed: 8 task(s)");
      expect(output).toContain("Stale: 3 task(s)");
      expect(output).toContain("Patch-ready: 4 task(s)");
      // Next actions are listed
      expect(output).toContain("`retry --queue q1`");
      expect(output).toContain("`recover-stale --queue q1`");
      expect(output).toContain("`review-patches --queue q1`");
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

  it("rejects unsafe patch paths (traversal and .git) in dry-run", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-merge-unsafe-"));
    const tasksFile = join(projectPath, "tasks.json");
    writeFileSync(tasksFile, JSON.stringify({ tasks: [{ clientKey: "merge", title: "Merge unsafe test task", goal: "Produce a patch for dry-run.", risk: "low", priority: "normal", expectedFiles: ["hello.txt"], acceptanceCriteria: ["Patch applies cleanly."] }] }));
    const created = await runProjectCommand({ command: "create", json: false, projectPath, promptSummary: "Merge unsafe test.", pipelineProfile: "balanced", maxParallelAgents: 4 }, call);
    const queueId = created.data.queueId as string;
    await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);
    const status = await call<{ tasks: Array<{ queueTaskId: string }> }>("project_queue_status", { queueId });
    const task = status.tasks[0];
    writeFileSync(join(projectPath, "hello.txt"), "old\n", "utf8");
    const patch = "diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-old\n+new\n";
    const safePatchFile = join(projectPath, "safe.patch");
    writeFileSync(safePatchFile, patch, "utf8");

    // Test 1: patch with traversal path via patchRefs
    await call("project_queue_update_task", { queueId, queueTaskId: task.queueTaskId, status: "patch_ready", summary: "Ready.", patchRefs: ["../escape.patch"], testRefs: [] });
    await expect(runProjectCommand({ command: "merge-worker", json: false, queueId, queueTaskId: task.queueTaskId, applyCwd: projectPath }, call)).rejects.toThrow(/inside apply cwd/);

    // Test 2: patch with .git path
    await call("project_queue_update_task", { queueId, queueTaskId: task.queueTaskId, status: "patch_ready", summary: "Ready.", patchRefs: [join(projectPath, ".git/config.patch")], testRefs: [] });
    await expect(runProjectCommand({ command: "merge-worker", json: false, queueId, queueTaskId: task.queueTaskId, applyCwd: projectPath }, call)).rejects.toThrow(/inside apply cwd/);

    // Test 3: a safe patch should pass dry-run cleanly
    await call("project_queue_update_task", { queueId, queueTaskId: task.queueTaskId, status: "patch_ready", summary: "Ready.", patchRefs: [safePatchFile], testRefs: [] });
    const ok = await runProjectCommand({ command: "merge-worker", json: false, queueId, queueTaskId: task.queueTaskId, applyCwd: projectPath }, call);
    expect(ok.action).toBe("merge_worker_clean");
    daemon.close();
  });

  it("dry-run rejects missing or non-existent cwd", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-merge-nocwd-"));
    const tasksFile = join(projectPath, "tasks.json");
    writeFileSync(tasksFile, JSON.stringify({ tasks: [{ clientKey: "merge", title: "Merge no-cwd task", goal: "Produce a patch for dry-run with missing cwd.", risk: "low", priority: "normal", expectedFiles: ["hello.txt"], acceptanceCriteria: ["Dry-run rejects missing cwd cleanly."] }] }));
    const created = await runProjectCommand({ command: "create", json: false, projectPath, promptSummary: "Merge no-cwd test.", pipelineProfile: "balanced", maxParallelAgents: 4 }, call);
    const queueId = created.data.queueId as string;
    await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);
    const status = await call<{ tasks: Array<{ queueTaskId: string }> }>("project_queue_status", { queueId });
    const task = status.tasks[0];
    const patchFile = join(projectPath, "result.patch");
    writeFileSync(patchFile, "diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-old\n+new\n", "utf8");
    await call("project_queue_update_task", { queueId, queueTaskId: task.queueTaskId, status: "patch_ready", summary: "Ready.", patchRefs: [patchFile], testRefs: [] });
    const badCwd = join(projectPath, "nonexistent");
    await expect(runProjectCommand({ command: "merge-worker", json: false, queueId, queueTaskId: task.queueTaskId, applyCwd: badCwd }, call)).rejects.toThrow(/Workspace cwd does not exist/);
    daemon.close();
  });

  it("merge-worker --apply rejects when conflicts are detected", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-merge-conflict-apply-"));
    const tasksFile = join(projectPath, "tasks.json");
    writeFileSync(tasksFile, JSON.stringify({ tasks: [{ clientKey: "merge", title: "Merge conflict apply task", goal: "Produce a conflicting patch.", risk: "low", priority: "normal", expectedFiles: ["hello.txt"], acceptanceCriteria: ["Apply blocked by conflicts."] }] }));
    const created = await runProjectCommand({ command: "create", json: false, projectPath, promptSummary: "Merge conflict apply test.", pipelineProfile: "balanced", maxParallelAgents: 4 }, call);
    const queueId = created.data.queueId as string;
    await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);
    const status = await call<{ tasks: Array<{ queueTaskId: string }> }>("project_queue_status", { queueId });
    const task = status.tasks[0];
    writeFileSync(join(projectPath, "hello.txt"), "unexpected content\n", "utf8");
    const patch = "diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-old\n+new\n";
    const patchFile = join(projectPath, "result.patch");
    writeFileSync(patchFile, patch, "utf8");
    await call("project_queue_update_task", { queueId, queueTaskId: task.queueTaskId, status: "patch_ready", summary: "Patch is ready.", patchRefs: [patchFile], testRefs: ["node -e \"process.exit(0)\""] });
    const agent = task.queueTaskId;
    await expect(runProjectCommand({ command: "merge-worker", json: false, queueId, agent, apply: true, runTests: true, cwd: projectPath, reviewedBy: "Codex", reviewSummary: "Should be blocked by conflicts." }, call)).rejects.toThrow("MERGE_WORKER_CONFLICTS");
    expect(readFileSync(join(projectPath, "hello.txt"), "utf8")).toBe("unexpected content\n");
    daemon.close();
  });

  it("imports batch tasks with defaults via the CLI, routing through project_queue_add_task_batch", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-batch-import-"));
    const tasksFile = writeBatchTasksFile(projectPath);
    const created = await runProjectCommand(
      { command: "create", json: false, projectPath, promptSummary: "Batch import test.", pipelineProfile: "balanced", maxParallelAgents: 4 },
      call
    );
    const queueId = created.data.queueId as string;
    const imported = await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    expect(imported.action).toBe("tasks_imported");
    const createdTasks = imported.data.created as Array<{ clientKey?: string; title: string; queueTaskId: string }>;
    expect(createdTasks).toHaveLength(3);

    const status = await runProjectCommand({ command: "status", json: false, queueId }, call);
    const tasks = (status.data as Record<string, unknown>).tasks as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(3);

    const taskA = tasks.find((t) => t.title === "Batch task A");
    const taskB = tasks.find((t) => t.title === "Batch task B");
    const taskC = tasks.find((t) => t.title === "Batch task C");
    expect(taskA).toBeDefined();
    expect(taskB).toBeDefined();
    expect(taskC).toBeDefined();

    // Inherited defaults
    expect(taskA?.phase).toBe("batch-phase");
    expect(taskA?.risk).toBe("medium");
    expect(taskA?.priority).toBe("normal");
    // Overridden risk
    expect(taskB?.risk).toBe("low");
    // Overridden priority
    expect(taskC?.priority).toBe("high");
    // Inherited defaults for C
    expect(taskC?.phase).toBe("batch-phase");
    expect(taskC?.risk).toBe("medium");

    daemon.close();
  });

  it("end-to-end dispatch tail health merge smoke: creates a queue, adds batch tasks, launches mock workers through run-ready, tails a worker, checks health, builds a patch review plan, and dry-runs merge-worker", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-e2e-smoke-"));
    const sandboxDir = join(projectPath, "sandboxes");

    // 1. Create queue
    const created = await runProjectCommand(
      {
        command: "create",
        json: false,
        projectPath,
        promptSummary: "End-to-end smoke test.",
        pipelineProfile: "balanced",
        maxParallelAgents: 4
      },
      call
    );
    expect(created.action).toBe("created");
    const queueId = created.data.queueId as string;

    // 2. Add templated parallel tasks via batch
    const batch = await call<{ created: Array<{ queueTaskId: string; fabricTaskId: string; title: string }> }>(
      "project_queue_add_task_batch",
      {
        queueId,
        defaults: {
          phase: "smoke",
          risk: "low",
          priority: "normal",
          expectedFiles: ["result.txt"],
          acceptanceCriteria: ["Result file exists."]
        },
        tasks: [
          {
            clientKey: "smoke-1",
            title: "Smoke task 1",
            goal: "Write file A.",
            expectedFiles: ["file-a.txt"]
          },
          {
            clientKey: "smoke-2",
            title: "Smoke task 2",
            goal: "Write file B.",
            expectedFiles: ["file-b.txt"]
          }
        ]
      }
    );
    expect(batch.created).toHaveLength(2);

    // 3. Start execution
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);

    // 4. Launch mock workers through run-ready (manual + sandbox)
    const runResult = await runProjectCommand(
      {
        command: "run-ready",
        json: false,
        queueId,
        limit: 2,
        parallel: 2,
        commandTemplate: "node -e \"require('node:fs').writeFileSync({{title}} + '-result.txt', 'smoke-output')\"",
        cwdTemplate: `${sandboxDir}/{{queueTaskId}}`,
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
    expect(runResult.action).toBe("ready_tasks_run");
    expect(runResult.data.runCount).toBe(2);

    const runs = runResult.data.runs as Array<{
      queueTaskId: string; fabricTaskId: string; workerRunId: string;
    }>;
    const firstRun = runs[0];

    // Attach patch refs to the queue tasks so merge-worker can resolve them
    for (const run of runs) {
      const patchFile = join(sandboxDir, run.queueTaskId, "result.patch");
      writeFileSync(patchFile, [
        "diff --git a/result.txt b/result.txt",
        "--- a/result.txt",
        "+++ b/result.txt",
        "@@ -0,0 +1 @@",
        "+smoke-output"
      ].join("\n"), "utf8");
      await call("project_queue_update_task", {
        queueId,
        queueTaskId: run.queueTaskId,
        status: "patch_ready",
        summary: "Smoke task complete.",
        patchRefs: [patchFile],
        testRefs: ["node -e \"true\""]
      });
    }

    // 5. Tail a worker via the daemon's fabric_task_tail tool
    const tailResult = await call<{
      resolveMode: string; taskId: string; eventCount: number; truncated: boolean;
    }>("fabric_task_tail", {
      queueId,
      queueTaskId: firstRun.queueTaskId
    });
    expect(tailResult.resolveMode).toBe("queueId");
    expect(tailResult.taskId).toBe(firstRun.fabricTaskId);
    expect(tailResult.eventCount).toBeGreaterThanOrEqual(2);
    expect(tailResult.truncated).toBe(false);

    // 6. Check worker health
    const health = await call<{
      summary: Record<string, number>; workers: Array<{ classification: string; workerRunId?: string }>;
    }>("project_queue_worker_health", { queueId });
    expect(health.summary.patchReady).toBe(2);
    expect(health.workers).toHaveLength(2);
    for (const w of health.workers) {
      expect(w.classification).toBe("patch_ready");
    }

    // 7. Build a patch review plan
    const reviewPlan = await call<{
      summary: Record<string, number>; entries: Array<Record<string, unknown>>;
    }>("project_queue_patch_review_plan", { queueId });
    expect(reviewPlan.summary.patchReadyCount).toBe(2);
    expect(reviewPlan.entries).toHaveLength(2);
    for (const entry of reviewPlan.entries) {
      expect(entry.workerRun).toBeDefined();
      expect(entry.worktreePath).toBeDefined();
    }

    // 8. Dry-run merge-worker for the first worker
    const merge = await runProjectCommand(
      { command: "merge-worker", json: false, queueId, workerRunId: firstRun.workerRunId, apply: false, runTests: false, cwd: sandboxDir },
      call
    );
    expect(merge.action).toBe("merge_worker_clean");

    // Verify sandbox files exist
    for (const run of runs) {
      const status = await call<{ tasks: Array<{ title: string; queueTaskId: string }> }>("project_queue_status", { queueId });
      const task = status.tasks.find((t) => t.queueTaskId === run.queueTaskId);
      const resultFile = join(sandboxDir, run.queueTaskId, `${task?.title ?? run.queueTaskId}-result.txt`);
      expect(readFileSync(resultFile, "utf8")).toBe("smoke-output");
    }

    daemon.close();
  });

  it("writes task packets and excludes private material from context bundles", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-secret-exclusion-"));
    const tasksFile = writeTasksFile(projectPath);
    writeFileSync(join(projectPath, "README.md"), "# Project\n\nPublic readme.\n", "utf8");
    mkdirSync(join(projectPath, "src"));
    writeFileSync(join(projectPath, "src/main.ts"), "export const main = (): string => 'hello';\n", "utf8");
    writeFileSync(join(projectPath, ".env"), "SECRET_KEY=test123\n", "utf8");
    writeFileSync(join(projectPath, ".secrets-config"), "api=abc\n", "utf8");
    writeFileSync(join(projectPath, "access-token.txt"), "tok=xyz\n", "utf8");
    writeFileSync(join(projectPath, "ssh-key.pem"), "-----BEGIN RSA PRIVATE KEY-----\n", "utf8");
    mkdirSync(join(projectPath, "decisions"));
    writeFileSync(join(projectPath, "decisions/local-plan.md"), "private architecture note\n", "utf8");
    mkdirSync(join(projectPath, ".agent-fabric-local"));
    writeFileSync(join(projectPath, ".agent-fabric-local/state.json"), '{"data":"private"}\n', "utf8");
    mkdirSync(join(projectPath, "artifacts"));
    writeFileSync(join(projectPath, "artifacts/output.txt"), "build output\n", "utf8");

    const created = await runProjectCommand(
      { command: "create", json: false, projectPath, promptSummary: "Secret exclusion test.", pipelineProfile: "balanced", maxParallelAgents: 4 },
      call
    );
    const queueId = created.data.queueId as string;
    await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);

    const outDir = join(projectPath, "packets");
    const status = await call<{ tasks: Array<{ queueTaskId: string }> }>("project_queue_status", { queueId });
    const task = status.tasks[0];
    await call("project_queue_update_task_metadata", {
      queueId,
      queueTaskId: task.queueTaskId,
      expectedFiles: ["README.md", ".env", "src/main.ts"],
      requiredContextRefs: ["decisions/local-plan.md", ".secrets-config", "access-token.txt", "ssh-key.pem", ".agent-fabric-local/state.json", "artifacts/output.txt"]
    });

    const result = await runProjectCommand(
      { command: "write-task-packets", json: false, queueId, outDir, format: "markdown", readyOnly: false },
      call
    );

    expect(result.action).toBe("task_packets_written");
    const contextPath = join(outDir, `${task.queueTaskId}.context.md`);
    const contextText = readFileSync(contextPath, "utf8");

    // Public files included
    expect(contextText).toContain("README.md");
    expect(contextText).toContain("Public readme");
    expect(contextText).toContain("src/main.ts");
    expect(contextText).toContain("const main");

    // Secret-like and private paths skipped
    expect(contextText).toContain("secret-like path skipped");
    expect(contextText).not.toContain("SECRET_KEY");
    expect(contextText).toContain("decisions/local-plan.md: secret-like path skipped");
    expect(contextText).toContain(".agent-fabric-local/state.json: secret-like path skipped");
    expect(contextText).toContain("artifacts/output.txt: secret-like path skipped");

    // Verify markdown packet has frontmatter
    const packetPath = join(outDir, `${task.queueTaskId}.md`);
    const packetText = readFileSync(packetPath, "utf8");
    expect(packetText).toContain("schema: agent-fabric.task-packet.v1");
    expect(packetText).toContain(`queueId: "${queueId}"`);
    expect(packetText).toContain(`contextFilePath: "${contextPath}"`);
    expect(packetText).toContain("## Goal");
    expect(packetText).toContain("## Terminal Tool Guidance");
    expect(packetText).toContain("### automationSafe");
    expect(packetText).toContain("### humanFacingOrOptional");

    daemon.close();
  });

  it("writes context bundle omitting large and binary files", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-bundle-cap-"));
    const tasksFile = writeTasksFile(projectPath);
    writeFileSync(join(projectPath, "README.md"), "# Hi\n", "utf8");
    const bigFile = join(projectPath, "huge.log");
    writeFileSync(bigFile, "x".repeat(50_000), "utf8");
    writeFileSync(join(projectPath, "data.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]), "binary");

    const created = await runProjectCommand(
      { command: "create", json: false, projectPath, promptSummary: "Bundle cap test.", pipelineProfile: "balanced", maxParallelAgents: 4 },
      call
    );
    const queueId = created.data.queueId as string;
    await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);
    const status = await call<{ tasks: Array<{ queueTaskId: string }> }>("project_queue_status", { queueId });
    const task = status.tasks[0];
    await call("project_queue_update_task_metadata", {
      queueId,
      queueTaskId: task.queueTaskId,
      expectedFiles: ["README.md", "huge.log", "data.bin"]
    });

    const outDir = join(projectPath, "packets");
    await runProjectCommand({ command: "write-task-packets", json: false, queueId, outDir, format: "json", readyOnly: false }, call);
    const contextText = readFileSync(join(outDir, `${task.queueTaskId}.context.md`), "utf8");

    expect(contextText).toContain("README.md");
    expect(contextText).toContain("huge.log: too large");
    expect(contextText).toContain("data.bin: binary-looking content");

    daemon.close();
  });

  it("writes JSON task packets with terminal tool guidance", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-json-packet-"));
    const tasksFile = writeTasksFile(projectPath);
    writeFileSync(join(projectPath, "README.md"), "# Public\n", "utf8");

    const created = await runProjectCommand(
      { command: "create", json: false, projectPath, promptSummary: "JSON packet test.", pipelineProfile: "balanced", maxParallelAgents: 4 },
      call
    );
    const queueId = created.data.queueId as string;
    await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);
    const status = await call<{ tasks: Array<{ queueTaskId: string }> }>("project_queue_status", { queueId });
    const task = status.tasks[0];
    await call("project_queue_update_task_metadata", { queueId, queueTaskId: task.queueTaskId, expectedFiles: ["README.md"] });

    const outDir = join(projectPath, "packets");
    await runProjectCommand({ command: "write-task-packets", json: false, queueId, outDir, format: "json", readyOnly: false }, call);

    const packetJson = JSON.parse(readFileSync(join(outDir, `${task.queueTaskId}.json`), "utf8"));
    expect(packetJson.schema).toBe("agent-fabric.task-packet.v1");
    expect(packetJson.queue.queueId).toBe(queueId);

    const guidance = packetJson.terminalToolGuidance;
    expect(guidance.automationSafe.rg).toBe("Use for source/text search.");
    expect(guidance.automationSafe.jq).toBe("Use for JSON payloads, logs, and config.");
    expect(guidance.humanFacingOrOptional.bat).toContain("Readable file viewing");
    expect(guidance.humanFacingOrOptional.tmux).toContain("Persistent human-facing sessions");
    expect(packetJson.operatorInstructions).toEqual(expect.arrayContaining([expect.stringContaining("Work only on this task")]));

    daemon.close();
  });

  it("blocks missing requiredContextRefs before launch", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-missing-refs-"));
    const tasksFile = writeTasksFile(projectPath);
    writeFileSync(join(projectPath, "README.md"), "# Public\n", "utf8");

    const created = await runProjectCommand(
      { command: "create", json: false, projectPath, promptSummary: "Missing refs test.", pipelineProfile: "balanced", maxParallelAgents: 4 },
      call
    );
    const queueId = created.data.queueId as string;
    await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);
    const status = await call<{ tasks: Array<{ queueTaskId: string }> }>("project_queue_status", { queueId });
    const task = status.tasks[0];
    await call("project_queue_update_task_metadata", {
      queueId,
      queueTaskId: task.queueTaskId,
      expectedFiles: ["README.md"],
      requiredContextRefs: ["does-not-exist.md", "also-missing.ts"]
    });

    const outDir = join(projectPath, "packets");
    const sandboxDir = join(projectPath, "sandbox");

    await expect(
      runProjectCommand(
        {
          command: "run-ready", json: false, queueId, limit: 1, parallel: 1,
          commandTemplate: "echo ok", cwdTemplate: `${sandboxDir}/{{queueTaskId}}`,
          taskPacketDir: outDir, taskPacketFormat: "json",
          worker: "manual", workspaceMode: "sandbox", modelProfile: "execute.cheap",
          successStatus: "completed", maxOutputChars: 100,
          approveToolContext: true, rememberToolContext: false,
          continueOnFailure: false, allowSharedCwd: false
        },
        call
      )
    ).rejects.toThrow("missing context refs");

    daemon.close();
  });

  it("writes context bundle with missing-file warnings for unsupported refs", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-unsupported-refs-"));
    const tasksFile = writeTasksFile(projectPath);
    writeFileSync(join(projectPath, "README.md"), "# Public\n", "utf8");

    const created = await runProjectCommand(
      { command: "create", json: false, projectPath, promptSummary: "Unsupported refs test.", pipelineProfile: "balanced", maxParallelAgents: 4 },
      call
    );
    const queueId = created.data.queueId as string;
    await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);
    const status = await call<{ tasks: Array<{ queueTaskId: string }> }>("project_queue_status", { queueId });
    const task = status.tasks[0];
    await call("project_queue_update_task_metadata", {
      queueId,
      queueTaskId: task.queueTaskId,
      expectedFiles: ["README.md"],
      requiredContextRefs: ["../outside-file.txt", "https://example.com/doc.md", "/etc/passwd"]
    });

    const outDir = join(projectPath, "packets");
    await runProjectCommand({ command: "write-task-packets", json: false, queueId, outDir, format: "markdown", readyOnly: false }, call);

    const contextText = readFileSync(join(outDir, `${task.queueTaskId}.context.md`), "utf8");
    expect(contextText).toContain("unsupported or outside project");
    expect(contextText).toContain("## README.md");
    expect(contextText).toContain("Public");

    daemon.close();
  });

  it("parses artifact ignore filters for run-task and run-ready", () => {
    expect(
      parseProjectCliArgs([
        "run-task",
        "--queue", "pqueue_1",
        "--queue-task", "pqtask_1",
        "--command", "npm test",
        "--artifact-ignore", "*.generated.md",
        "--artifact-ignore", "tmp/output"
      ])
    ).toMatchObject({
      command: "run-task",
      artifactIgnore: ["*.generated.md", "tmp/output"]
    });

    expect(
      parseProjectCliArgs([
        "run-ready",
        "--queue", "pqueue_1",
        "--artifact-ignore", "*.generated.md",
        "--artifact-ignore", "priv/static"
      ])
    ).toMatchObject({
      command: "run-ready",
      artifactIgnore: ["*.generated.md", "priv/static"]
    });
  });

  it("matches default, env, and CLI artifact ignore globs", () => {
    process.env.AGENT_FABRIC_ARTIFACT_IGNORE_GLOBS = "*.generated.md;priv/static";
    const globs = resolveArtifactIgnoreGlobs(["tmp/output", "*.generated.md"]);
    expect(globs).toContain("*.log");
    expect(globs).toContain("*.generated.md");
    expect(globs).toContain("priv/static");
    expect(globs).toContain("tmp/output");

    expect(matchesGlob("debug.log", "*.log")).toBe(true);
    expect(matchesGlob("nested/debug.log", "*.log")).toBe(true);
    expect(matchesGlob("priv/static/app.js", "priv/static")).toBe(true);
    expect(matchesGlob("app.generated.md", "*.generated.md")).toBe(true);
    expect(matchesGlob("app.generated.md.bak", "*.generated.md")).toBe(false);
  });

  it("filters artifact noise from run-task changed-file harvesting", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const session = daemon.registerBridge(registerPayload());
    const call = caller(daemon, session);
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-artifact-ignore-"));
    const tasksFile = writeTasksFile(projectPath);
    const created = await runProjectCommand(
      { command: "create", json: false, projectPath, promptSummary: "Artifact ignore test.", pipelineProfile: "balanced", maxParallelAgents: 4 },
      call
    );
    const queueId = created.data.queueId as string;
    const imported = await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    const task = (imported.data.created as Array<{ queueTaskId: string }>)[0];
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);

    const commandLine = [
      "node -e",
      JSON.stringify(
        "const fs=require('node:fs');fs.mkdirSync('generated',{recursive:true});fs.writeFileSync('keep.txt','ok');fs.writeFileSync('debug.log','noise');fs.writeFileSync('generated/asset.map','noise');"
      )
    ].join(" ");
    const result = await runProjectCommand(
      {
        command: "run-task",
        json: false,
        queueId,
        queueTaskId: task.queueTaskId,
        commandLine,
        cwd: projectPath,
        worker: "manual",
        workspaceMode: "in_place",
        modelProfile: "execute.cheap",
        successStatus: "completed",
        maxOutputChars: 4_000,
        approveToolContext: true,
        rememberToolContext: false,
        artifactIgnore: ["generated"]
      },
      call
    );

    expect(result.data.changedFiles).toEqual(["keep.txt"]);
    daemon.close();
  });

  it("persists run-task stdout and stderr logs and records their paths", async () => {
    const daemon = new FabricDaemon({ dbPath: ":memory:" });
    const projectPath = mkdtempSync(join(tmpdir(), "agent-fabric-task-logs-"));
    const payload = registerPayload();
    const session = daemon.registerBridge({ ...payload, workspace: { ...payload.workspace, root: projectPath } });
    const call = caller(daemon, session);
    const tasksFile = writeTasksFile(projectPath);
    const created = await runProjectCommand(
      { command: "create", json: false, projectPath, promptSummary: "Task log test.", pipelineProfile: "balanced", maxParallelAgents: 4 },
      call
    );
    const queueId = created.data.queueId as string;
    const imported = await runProjectCommand({ command: "import-tasks", json: false, queueId, tasksFile, approveQueue: true }, call);
    const task = (imported.data.created as Array<{ queueTaskId: string }>)[0];
    await runProjectCommand({ command: "decide-queue", json: false, queueId, decision: "start_execution" }, call);

    const result = await runProjectCommand(
      {
        command: "run-task",
        json: false,
        queueId,
        queueTaskId: task.queueTaskId,
        commandLine: "node -e \"process.stdout.write('visible out');process.stderr.write('visible err')\"",
        cwd: projectPath,
        worker: "manual",
        workspaceMode: "in_place",
        modelProfile: "execute.cheap",
        successStatus: "completed",
        maxOutputChars: 4_000,
        approveToolContext: true,
        rememberToolContext: false
      },
      call
    );
    const stdoutLogPath = result.data.stdoutLogPath as string;
    const stderrLogPath = result.data.stderrLogPath as string;
    expect(stdoutLogPath).toContain(join(projectPath, ".agent-fabric", "logs"));
    expect(stderrLogPath).toContain(join(projectPath, ".agent-fabric", "logs"));
    expect(readFileSync(stdoutLogPath, "utf8")).toBe("visible out");
    expect(readFileSync(stderrLogPath, "utf8")).toBe("visible err");

    const tail = await call<{ events: Array<{ kind: string; metadata: Record<string, unknown> }> }>("fabric_task_tail", {
      workerRunId: result.data.workerRunId as string
    });
    const finished = tail.events.find((event) => event.kind === "command_finished");
    expect(finished?.metadata.stdoutLogPath).toBe(stdoutLogPath);
    expect(finished?.metadata.stderrLogPath).toBe(stderrLogPath);

    const snap = snapshotFiles(projectPath);
    expect([...snap.entries.keys()].some((entry) => entry.includes(".agent-fabric/logs"))).toBe(false);
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

function writeBatchTasksFile(projectPath: string): string {
  const file = join(projectPath, "batch-tasks.json");
  writeFileSync(
    file,
    JSON.stringify({
      defaults: {
        phase: "batch-phase",
        risk: "medium",
        priority: "normal",
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
          priority: "high"
        }
      ]
    })
  );
  return file;
}
