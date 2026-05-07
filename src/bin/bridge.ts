#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { FabricClient } from "../client.js";
import { defaultPaths } from "../paths.js";
import { bridgeCallContext } from "../runtime/bridge-context.js";
import type { BridgeRegister, BridgeSession } from "../types.js";

const paths = defaultPaths();
const client = new FabricClient(paths.socketPath);
const session = await register();

const server = new McpServer({
  name: "agent-fabric",
  version: "0.1.0"
});

proxyTool("fabric_status", "Report bounded agent-fabric daemon health, bridge sessions, coverage, and billing/storage status.", {
  includeSessions: z.boolean().optional(),
  verbose: z.boolean().optional(),
  sessionLimit: z.number().int().nonnegative().optional(),
  sessionOffset: z.number().int().nonnegative().optional(),
  dedupeWarnings: z.boolean().optional()
});
proxyTool("fabric_session_close", "Close this Agent Fabric bridge session so status output does not accumulate stale short-lived clients.", {});
proxyTool("fabric_doctor", "Report agent-fabric diagnostics and actionable safe next steps.", {
  includeActions: z.boolean().optional()
});
proxyTool("fabric_starter_kit", "Return a concise read-only discovery surface with the essential happy-path queue tools for Codex and Claude bridge callers.", {});
proxyTool("fabric_explain_session", "Explain what an agent-fabric session did across pillars.", {
  sessionId: z.string()
});
proxyTool("fabric_explain_memory", "Explain a memory's provenance, injections, audit rows, and correlated costs.", {
  memoryId: z.string()
});
proxyTool("fabric_trace", "Return all known rows for a correlation id across collab, memory, cost, audit, and outbox events.", {
  correlationId: z.string()
});
proxyTool("fabric_inspect_context_package", "Inspect the sanitized context package captured for an LLM preflight request.", {
  requestId: z.string(),
  workspaceRoot: z.string().optional()
});
proxyTool("fabric_spawn_agents", "Spawn queue-visible Agent Fabric worker lanes for Codex-style background work.", {
  queueId: z.string(),
  count: z.number().int().positive().max(1000).optional(),
  worker: z.enum(["deepseek-direct", "jcode-deepseek"]).optional(),
  workspaceMode: z.enum(["git_worktree", "sandbox"]).optional(),
  modelProfile: z.string().optional(),
  maxRuntimeMinutes: z.number().int().positive().optional(),
  allowPartial: z.boolean().optional(),
  planOnly: z.boolean().optional()
});
proxyTool("fabric_list_agents", "Return Codex-style Agent Fabric background worker cards for a project queue.", {
  queueId: z.string(),
  includeCompleted: z.boolean().optional(),
  maxEventsPerLane: z.number().int().positive().optional(),
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(500).optional(),
  groupBy: z.enum(["status", "phase", "workstream", "worker", "risk", "category"]).optional()
});
proxyTool("fabric_open_agent", "Open one Agent Fabric worker card with transcript, checkpoints, task detail, and artifacts.", {
  queueId: z.string(),
  agent: z.string(),
  maxEventsPerRun: z.number().int().positive().optional()
});
proxyTool("fabric_message_agent", "Send a durable message or ask to an Agent Fabric worker handle such as @af/rami-123abc.", {
  queueId: z.string(),
  agent: z.string(),
  body: z.string(),
  kind: z.string().optional(),
  ask: z.boolean().optional(),
  urgency: z.string().optional(),
  refs: z.array(z.string()).optional()
});
proxyTool("fabric_wait_agents", "Return a non-blocking wait snapshot for Agent Fabric worker cards.", {
  queueId: z.string(),
  agents: z.array(z.string()).optional(),
  targetStatuses: z.array(z.string()).optional(),
  maxEventsPerLane: z.number().int().positive().optional()
});
proxyTool("fabric_accept_patch", "Accept a patch-ready Agent Fabric worker result without applying files locally.", {
  queueId: z.string(),
  agent: z.string().optional(),
  queueTaskId: z.string().optional(),
  summary: z.string().optional(),
  reviewedBy: z.string().optional(),
  reviewSummary: z.string().optional()
});
proxyTool("fabric_senior_start", "Start or attach to a Senior-mode Agent Fabric queue and return Codex-like worker cards/progress.", {
  queueId: z.string().optional(),
  projectPath: z.string().optional(),
  promptSummary: z.string().optional(),
  title: z.string().optional(),
  count: z.number().int().positive().max(1000).optional(),
  worker: z.enum(["deepseek-direct", "jcode-deepseek"]).optional(),
  modelProfile: z.string().optional(),
  approveModelCalls: z.boolean().optional(),
  allowPartial: z.boolean().optional()
});
proxyTool("fabric_senior_status", "Return Senior-mode worker cards and resumable progress for an Agent Fabric queue.", {
  queueId: z.string(),
  maxEventsPerLane: z.number().int().positive().optional()
});
proxyTool("fabric_senior_resume", "Return the next Senior-mode command and progress snapshot for resuming an Agent Fabric queue.", {
  queueId: z.string(),
  maxEventsPerLane: z.number().int().positive().optional()
});
proxyTool("fabric_notification_self_test_start", "Create a notification visibility challenge for this bridge session.", {
  ttlSeconds: z.number().int().positive().optional()
});
proxyTool("fabric_notification_self_test_complete", "Complete a notification visibility challenge after agent-visible delivery is confirmed.", {
  testId: z.string(),
  observed: z.enum(["yes", "no", "unknown"]),
  detail: z.string().optional()
});

proxyTool("collab_send", "Append a durable collaboration message, then attempt best-effort fan-out.", {
  to: z.string(),
  body: z.string(),
  refs: z.array(z.string()).optional(),
  kind: z.string().optional()
});
proxyTool("collab_inbox", "Read messages and open asks for this bridge session.", {
  since: z.string().optional(),
  max: z.number().int().positive().optional()
});
proxyTool("collab_ask", "Create an async task/ask for another agent.", {
  to: z.string(),
  kind: z.string(),
  question: z.string(),
  refs: z.array(z.string()).optional(),
  urgency: z.string().optional(),
  artifacts: z.array(z.unknown()).optional()
});
proxyTool("collab_reply", "Reply to an open ask and update task status.", {
  askId: z.string(),
  status: z.string(),
  message: z.string()
});
proxyTool("claim_path", "Claim one or more workspace paths before editing.", {
  paths: z.array(z.string()).min(1),
  note: z.string().optional(),
  mode: z.string().optional(),
  ttl: z.number().int().positive().optional()
});
proxyTool("release_path", "Release a prior workspace path claim.", {
  claimId: z.string()
});
proxyTool("collab_status", "Show open asks, active claims, presence, and channel cursor state.", {});
proxyTool("collab_decision", "Record a durable collaboration decision.", {
  title: z.string(),
  decided: z.string(),
  participants: z.array(z.string()).optional(),
  rationale: z.string().optional(),
  supersedes: z.string().optional()
});
proxyTool("collab_heartbeat", "Update bridge presence and current task.", {
  task: z.string().optional(),
  eta: z.string().optional()
});

proxyTool("memory_write", "Write a typed memory; auto-derived memories are pending_review unless explicitly trusted.", {
  type: z.string(),
  body: z.string(),
  intent_keys: z.array(z.string()).min(1),
  refs: z.array(z.string()).optional(),
  source: z.string().optional(),
  derivation: z.string().optional(),
  severity: z.string().optional(),
  initialConfidence: z.number().min(0).max(1).optional(),
  supersedes: z.string().optional()
});
proxyTool("memory_check", "Return limited active memory hints for the current intent.", {
  intent: z.record(z.string(), z.unknown()).optional(),
  types: z.array(z.string()).optional(),
  max_hints: z.number().int().positive().optional()
});
proxyTool("memory_outcome", "Report the outcome of a memory injection.", {
  injectionId: z.string(),
  outcome: z.string(),
  detail: z.string().optional()
});
proxyTool("memory_list", "List memories in the current workspace namespace.", {
  type: z.string().optional(),
  status: z.string().optional(),
  since: z.string().optional(),
  archived: z.boolean().optional(),
  max: z.number().int().positive().optional()
});
proxyTool("memory_audit_lift", "Summarize memory outcome lift using current local evidence.", {});
proxyTool("memory_invalidate", "Mark a memory invalid without deleting it.", {
  id: z.string(),
  reason: z.string(),
  evidence: z.array(z.string()).optional()
});
proxyTool("memory_confirm", "Confirm that a memory held in observed use.", {
  id: z.string(),
  evidence: z.string().optional()
});
proxyTool("memory_review", "Human-review a pending memory: approve, reject, or archive.", {
  id: z.string(),
  decision: z.enum(["approve", "reject", "archive"]),
  reason: z.string().optional(),
  evidence: z.array(z.string()).optional()
});
proxyTool("memory_eval_report", "Return the latest paired memory eval report for a suite.", {
  suite: z.string().optional(),
  since: z.string().optional()
});

proxyTool("pp_cost_month", "Return month-to-date cost ledgers without blending billed, live estimated, and fixed-capacity spend.", {
  asOf: z.string().optional()
});
proxyTool("pp_cost_by_feature", "Return cost rows for a feature tag from attributed live estimates.", {
  tag: z.string(),
  since: z.string().optional(),
  groupBy: z.string().optional()
});
proxyTool("pp_cost_idle_audit", "Return idle-cost findings; Phase 0A returns an empty audited result until provider pollers exist.", {});
proxyTool("pp_cost_anomaly", "Detect cost anomalies from local cost_events history.", {
  since: z.string().optional(),
  threshold: z.number().optional()
});
proxyTool("pp_cost_quota_status", "Report Azure token quota utilization when Azure Monitor polling is configured.", {});
proxyTool("llm_preflight", "Estimate model-call cost/risk and return a cost-aware routing decision before sending context to a model.", {
  task: z.union([z.string(), z.record(z.string(), z.unknown())]),
  client: z.string(),
  workspaceRoot: z.string().optional(),
  candidateModel: z.string(),
  requestedReasoning: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  contextPackage: z.record(z.string(), z.unknown()).optional(),
  contextPackageSummary: z.record(z.string(), z.unknown()).optional(),
  toolSchemas: z.array(z.unknown()).optional(),
  mcpServers: z.array(z.unknown()).optional(),
  budgetScope: z.string().optional(),
  requestedProvider: z.string().optional(),
  billingPreference: z.string().optional(),
  sensitiveFlags: z.array(z.string()).optional(),
  approvalToken: z.string().optional()
});
proxyTool("llm_hard_gate", "Fail-closed model-call gate for participating clients such as Codex or Claude Code VS Code adapters.", {
  task: z.union([z.string(), z.record(z.string(), z.unknown())]),
  client: z.string(),
  workspaceRoot: z.string().optional(),
  candidateModel: z.string(),
  requestedReasoning: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  contextPackage: z.record(z.string(), z.unknown()).optional(),
  contextPackageSummary: z.record(z.string(), z.unknown()).optional(),
  toolSchemas: z.array(z.unknown()).optional(),
  mcpServers: z.array(z.unknown()).optional(),
  budgetScope: z.string().optional(),
  requestedProvider: z.string().optional(),
  billingPreference: z.string().optional(),
  sensitiveFlags: z.array(z.string()).optional(),
  approvalToken: z.string().optional(),
  enforce: z.boolean().optional()
});
proxyTool("model_brain_route", "Central route brain that resolves role aliases, estimates cost/risk, and returns the hard-gate decision.", {
  task: z.union([z.string(), z.record(z.string(), z.unknown())]),
  client: z.string(),
  workspaceRoot: z.string().optional(),
  roleAlias: z.string().optional(),
  candidateModel: z.string().optional(),
  requestedReasoning: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  contextPackage: z.record(z.string(), z.unknown()).optional(),
  contextPackageSummary: z.record(z.string(), z.unknown()).optional(),
  toolSchemas: z.array(z.unknown()).optional(),
  mcpServers: z.array(z.unknown()).optional(),
  budgetScope: z.string().optional(),
  requestedProvider: z.string().optional(),
  billingPreference: z.string().optional(),
  sensitiveFlags: z.array(z.string()).optional(),
  risk: z.enum(["low", "medium", "high", "breakglass"]).optional(),
  approvalToken: z.string().optional(),
  enforce: z.boolean().optional()
});
proxyTool("llm_budget_status", "Aggregate recent LLM preflight estimates by decision, model, and provider.", {
  workspaceRoot: z.string().optional(),
  sessionId: z.string().optional(),
  chainId: z.string().optional(),
  model: z.string().optional(),
  scope: z.enum(["session", "day", "month", "all"]).optional(),
  since: z.string().optional()
});
proxyTool("llm_approve_pending", "List pending LLM approval requests for IDE or terminal approval UX.", {
  workspaceRoot: z.string().optional(),
  includeExpired: z.boolean().optional(),
  max: z.number().int().positive().optional()
});
proxyTool("llm_approve", "Record a human decision for a pending LLM approval request and optionally issue an approval token.", {
  requestId: z.string(),
  decision: z.enum(["allow", "compact", "downgrade", "cancel"]),
  scope: z.enum(["call", "chain", "queue", "session", "day"]).optional(),
  boundResourceId: z.string().optional(),
  expiresInSeconds: z.number().int().positive().optional(),
  note: z.string().optional()
});
proxyTool("llm_route_feedback", "Record outcome feedback for a completed model call route.", {
  requestId: z.string(),
  outcome: z.enum(["succeeded", "failed", "regressed", "retried", "user_accepted", "user_rejected", "canceled", "errored"]),
  evidence: z.record(z.string(), z.unknown()).optional(),
  qualityScore: z.number().min(0).max(1).optional(),
  retryCount: z.number().int().nonnegative().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional()
});
proxyTool("fabric_route_outcomes_summary", "Summarize route outcomes by provider, model, task type, and outcome.", {
  workspaceRoot: z.string().optional(),
  since: z.string().optional(),
  sinceDays: z.number().positive().optional()
});
proxyTool("policy_resolve_alias", "Resolve a deterministic model policy alias such as plan.strong or execute.cheap.", {
  alias: z.string(),
  taskType: z.string().optional(),
  contextSize: z.number().nonnegative().optional(),
  estimatedCostUsd: z.number().nonnegative().optional(),
  risk: z.enum(["low", "medium", "high", "breakglass"]).optional()
});

proxyTool("plan_chain_start", "Start a durable best-plan chain per ADR-0014.", {
  task: z.string(),
  models: z
    .object({
      a: z.string().optional(),
      b: z.string().optional(),
      c: z.string().optional()
    })
    .optional(),
  maxRounds: z.number().int().positive().optional(),
  budgetUsd: z.number().positive().optional(),
  outputFormat: z.enum(["markdown", "adr"]).optional(),
  showLineageToA: z.boolean().optional()
});
proxyTool("plan_chain_status", "Return durable plan-chain state, revisions, critiques, questions, and spend.", {
  chainId: z.string()
});
proxyTool("plan_chain_record_revision", "Record a plan-chain draft/improvement revision from the orchestrator.", {
  chainId: z.string(),
  step: z.enum(["a_draft", "b_improve", "c_improve"]),
  body: z.string(),
  model: z.string().optional(),
  round: z.number().int().positive().optional(),
  changeLog: z.unknown().optional(),
  confidence: z.number().min(0).max(1).optional(),
  leastConfidentAbout: z.unknown().optional(),
  costUsd: z.number().nonnegative().optional(),
  questionsForUser: z.array(z.unknown()).optional(),
  questionRecipient: z.string().optional()
});
proxyTool("plan_chain_record_critique", "Record the final A-critique for a plan-chain round.", {
  chainId: z.string(),
  body: z.string(),
  structured: z.record(z.string(), z.unknown()),
  reviewingRevisionId: z.string().optional(),
  model: z.string().optional(),
  round: z.number().int().positive().optional(),
  costUsd: z.number().nonnegative().optional()
});
proxyTool("plan_chain_answer_question", "Answer a blocking or preference question raised during a plan chain.", {
  questionId: z.string(),
  answer: z.string()
});
proxyTool("plan_chain_decide", "Accept, abandon, or run another round of a plan chain.", {
  chainId: z.string(),
  decision: z.enum(["accept", "abandon", "another_round"]),
  writeMemory: z.boolean().optional()
});
proxyTool("plan_chain_explain", "Return a causal trace for a plan chain.", {
  chainId: z.string()
});

proxyTool("project_queue_create", "Create a durable project-scoped queue for a Agent Fabric Console prompt pipeline.", {
  projectPath: z.string(),
  prompt: z.string().optional(),
  promptSummary: z.string().optional(),
  title: z.string().optional(),
  pipelineProfile: z.enum(["fast", "balanced", "careful", "custom"]).optional(),
  maxParallelAgents: z.number().int().positive().optional(),
  planChainId: z.string().optional()
});
proxyTool("project_queue_list", "List project queues for the Desktop project sidebar.", {
  projectPath: z.string().optional(),
  statuses: z.array(z.enum(["created", "prompt_review", "planning", "plan_review", "queue_review", "running", "paused", "completed", "canceled"])).optional(),
  includeClosed: z.boolean().optional(),
  limit: z.number().int().positive().optional()
});
proxyTool("project_queue_cleanup", "Dry-run or apply cleanup for completed/canceled project queues after a retention window.", {
  queueId: z.string().optional(),
  projectPath: z.string().optional(),
  statuses: z.array(z.enum(["completed", "canceled"])).optional(),
  olderThanDays: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
  dryRun: z.boolean().optional(),
  deleteLinkedTaskHistory: z.boolean().optional()
});
proxyTool("project_queue_status", "Read project queue stages, tasks, decisions, tool/context proposals, and project policies.", {
  queueId: z.string()
});
proxyTool("project_queue_update_settings", "Update project queue title, pipeline profile, or worker concurrency settings.", {
  queueId: z.string(),
  title: z.string().optional(),
  pipelineProfile: z.enum(["fast", "balanced", "careful", "custom"]).optional(),
  maxParallelAgents: z.number().int().positive().optional(),
  note: z.string().optional()
});
proxyTool("project_queue_dashboard", "Read the combined Agent Fabric Console queue board, approvals, and agent lanes view model.", {
  queueId: z.string(),
  includeCompletedLanes: z.boolean().optional(),
  maxEventsPerLane: z.number().int().positive().optional()
});
proxyTool("project_queue_review_matrix", "Read a queue-review matrix grouped by phase, risk, dependency, file scope, and tool/context grants.", {
  queueId: z.string(),
  limit: z.number().int().positive().optional()
});
proxyTool("project_queue_task_detail", "Read one queue task drawer/detail model with graph links, workers, approvals, and optional resume packet.", {
  queueId: z.string(),
  queueTaskId: z.string(),
  includeResume: z.boolean().optional(),
  preferredWorker: z.enum(["ramicode", "local-cli", "openhands", "aider", "smolagents", "codex-app-server", "deepseek-direct", "jcode-deepseek", "manual"]).optional(),
  maxEventsPerRun: z.number().int().positive().optional(),
  maxModelApprovals: z.number().int().positive().optional()
});
proxyTool("project_queue_resume_task", "Build a queue-level resume packet from the latest worker checkpoint.", {
  queueId: z.string(),
  queueTaskId: z.string(),
  preferredWorker: z.enum(["ramicode", "local-cli", "openhands", "aider", "smolagents", "codex-app-server", "deepseek-direct", "jcode-deepseek", "manual"]).optional()
});
proxyTool("project_queue_task_packet", "Build a copyable queue task or resume packet for worker handoff.", {
  queueId: z.string(),
  queueTaskId: z.string(),
  format: z.enum(["json", "markdown"]).optional(),
  includeResume: z.boolean().optional(),
  preferredWorker: z.enum(["ramicode", "local-cli", "openhands", "aider", "smolagents", "codex-app-server", "deepseek-direct", "jcode-deepseek", "manual"]).optional(),
  workspaceMode: z.enum(["in_place", "git_worktree", "clone", "sandbox"]).optional(),
  workspacePath: z.string().optional(),
  modelProfile: z.string().optional(),
  packetPath: z.string().optional()
});
proxyTool("project_queue_record_stage", "Record one prompt, planning, phasing, task-writing, shaping, or execution stage result.", {
  queueId: z.string(),
  stage: z.enum(["prompt_improvement", "planning", "phasing", "task_writing", "queue_shaping", "tool_context", "execution", "review", "decision"]),
  status: z.enum(["pending", "running", "completed", "needs_review", "accepted", "rejected", "failed", "skipped"]),
  modelAlias: z.string().optional(),
  inputSummary: z.string().optional(),
  outputSummary: z.string().optional(),
  planChainId: z.string().optional(),
  artifacts: z.array(z.unknown()).optional(),
  warnings: z.array(z.string()).optional()
});
proxyTool("project_queue_add_task_batch", "Add dependency-aware coding tasks with shared defaults plus per-lane variants, validated through the same queue task schema as project_queue_add_tasks.", {
  queueId: z.string(),
  defaults: z.object({
    phase: z.string().optional(),
    manager: z.string().optional(),
    managerId: z.string().optional(),
    parentManagerId: z.string().optional(),
    parentQueueId: z.string().optional(),
    workstream: z.string().optional(),
    costCenter: z.string().optional(),
    escalationTarget: z.string().optional(),
    category: z.string().optional(),
    status: z.enum(["queued", "ready", "running", "blocked", "review", "patch_ready", "completed", "failed", "canceled", "accepted", "done"]).optional(),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    parallelGroup: z.string().optional(),
    parallelSafe: z.boolean().optional(),
    risk: z.enum(["low", "medium", "high", "breakglass"]).optional(),
    expectedFiles: z.array(z.string()).optional(),
    acceptanceCriteria: z.array(z.string()).optional(),
    requiredTools: z.array(z.string()).optional(),
    requiredMcpServers: z.array(z.string()).optional(),
    requiredMemories: z.array(z.string()).optional(),
    requiredContextRefs: z.array(z.string()).optional(),
    dependsOn: z.array(z.string()).optional()
  }).optional(),
  tasks: z.array(
    z.object({
      clientKey: z.string().optional(),
      title: z.string(),
      goal: z.string(),
      phase: z.string().optional(),
      manager: z.string().optional(),
      managerId: z.string().optional(),
      parentManagerId: z.string().optional(),
      parentQueueId: z.string().optional(),
      workstream: z.string().optional(),
      costCenter: z.string().optional(),
      escalationTarget: z.string().optional(),
      category: z.string().optional(),
      status: z.enum(["queued", "ready", "running", "blocked", "review", "patch_ready", "completed", "failed", "canceled", "accepted", "done"]).optional(),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
      parallelGroup: z.string().optional(),
      parallelSafe: z.boolean().optional(),
      risk: z.enum(["low", "medium", "high", "breakglass"]).optional(),
      expectedFiles: z.array(z.string()).optional(),
      acceptanceCriteria: z.array(z.string()).optional(),
      requiredTools: z.array(z.string()).optional(),
      requiredMcpServers: z.array(z.string()).optional(),
      requiredMemories: z.array(z.string()).optional(),
      requiredContextRefs: z.array(z.string()).optional(),
      dependsOn: z.array(z.string()).optional()
    })
  )
});
proxyTool("project_queue_add_tasks", "Add dependency-aware coding tasks to a project queue and link each one to a fabric task.", {
  queueId: z.string(),
  tasks: z.array(
    z.object({
      clientKey: z.string().optional(),
      title: z.string(),
	      goal: z.string(),
	      phase: z.string().optional(),
	      manager: z.string().optional(),
	      managerId: z.string().optional(),
	      parentManagerId: z.string().optional(),
	      parentQueueId: z.string().optional(),
	      workstream: z.string().optional(),
	      costCenter: z.string().optional(),
	      escalationTarget: z.string().optional(),
	      category: z.string().optional(),
      status: z.enum(["queued", "ready", "running", "blocked", "review", "patch_ready", "completed", "failed", "canceled", "accepted", "done"]).optional(),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
      parallelGroup: z.string().optional(),
      parallelSafe: z.boolean().optional(),
      risk: z.enum(["low", "medium", "high", "breakglass"]).optional(),
      expectedFiles: z.array(z.string()).optional(),
      acceptanceCriteria: z.array(z.string()).optional(),
      requiredTools: z.array(z.string()).optional(),
      requiredMcpServers: z.array(z.string()).optional(),
      requiredMemories: z.array(z.string()).optional(),
      requiredContextRefs: z.array(z.string()).optional(),
      dependsOn: z.array(z.string()).optional()
    })
  )
});
proxyTool("project_queue_next_ready", "Return dependency-free queue tasks respecting project concurrency slots.", {
  queueId: z.string(),
  limit: z.number().int().positive().optional()
});
proxyTool("project_queue_prepare_ready", "Prepare tool/context proposals for the next schedulable ready queue tasks before worker launch.", {
  queueId: z.string(),
  limit: z.number().int().positive().optional()
});
proxyTool("project_queue_launch_plan", "Read a non-mutating launch plan with launchable, approval-needed, and start-gate-blocked queue tasks.", {
  queueId: z.string(),
  limit: z.number().int().positive().optional()
});
proxyTool("project_queue_validate_links", "Validate ready queue tasks have linked fabric tasks before runner launch.", {
  queueId: z.string(),
  readyOnly: z.boolean().optional()
});
proxyTool("project_queue_validate_context_refs", "Validate required context refs resolve before runner launch.", {
  queueId: z.string(),
  readyOnly: z.boolean().optional(),
  markBlocked: z.boolean().optional()
});
proxyTool("project_queue_claim_next", "Atomically claim one dependency-free ready queue task for a worker gateway.", {
  queueId: z.string(),
  workerRunId: z.string().optional(),
  worker: z.enum(["ramicode", "local-cli", "openhands", "aider", "smolagents", "codex-app-server", "deepseek-direct", "jcode-deepseek", "manual"]).optional(),
  workspaceMode: z.enum(["in_place", "git_worktree", "clone", "sandbox"]).optional(),
  workspacePath: z.string().optional(),
  modelProfile: z.string().optional(),
  contextPolicy: z.string().optional(),
  maxRuntimeMinutes: z.number().int().positive().optional(),
  command: z.array(z.string()).optional(),
  skipQueueTaskIds: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});
proxyTool("project_queue_recover_stale", "Dry-run or recover stale running queue tasks whose workers stopped updating.", {
  queueId: z.string(),
  staleAfterMinutes: z.number().int().positive().optional(),
  action: z.enum(["requeue", "fail"]).optional(),
  dryRun: z.boolean().optional()
});
proxyTool("project_queue_worker_health", "Read-only health classification for every queue worker using durable Agent Fabric evidence: process metadata, heartbeat/checkpoint recency, output/log metadata, patch refs, failure events, stale/quiet/running/completed states, and recommended non-destructive next actions.", {
  queueId: z.string(),
  staleAfterMinutes: z.number().int().positive().optional()
});
proxyTool("project_queue_retry_task", "Return one failed, canceled, blocked, review, or patch-ready queue task to queued state for another worker attempt.", {
  queueId: z.string(),
  queueTaskId: z.string(),
  reason: z.string().optional(),
  clearOutputs: z.boolean().optional()
});
proxyTool("project_queue_timeline", "Read an ordered project queue timeline for Desktop theater mode and terminal status feeds.", {
  queueId: z.string(),
  limit: z.number().int().positive().optional()
});
proxyTool("project_queue_agent_lanes", "Read per-worker lanes for the Agent Fabric Console project queue surface.", {
  queueId: z.string(),
  includeCompleted: z.boolean().optional(),
  maxEventsPerLane: z.number().int().positive().optional()
});
proxyTool("project_queue_approve_model_calls", "Issue one audited queue-scoped model approval token for matching Senior DeepSeek worker calls.", {
  queueId: z.string(),
  candidateModel: z.string().optional(),
  requestedProvider: z.string().optional(),
  requestedReasoning: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  expiresInSeconds: z.number().int().positive().optional(),
  note: z.string().optional()
});
proxyTool("project_queue_progress_report", "Return a resumable Senior-mode queue progress report with worker cards, blockers, patch-ready tasks, and next commands.", {
  queueId: z.string(),
  maxEventsPerLane: z.number().int().positive().optional(),
  managerSummaryLimit: z.number().int().positive().max(100).optional()
});
proxyTool("project_queue_collab_summary", "Return a queue-scoped collab summary grouping open asks, replies, decisions, path claims, and worker handoff notes by queue task.", {
  queueId: z.string()
});
proxyTool("project_queue_approval_inbox", "Read queue-scoped tool/context and model-call approvals.", {
  queueId: z.string(),
  includeExpired: z.boolean().optional(),
  limit: z.number().int().positive().optional()
});
proxyTool("project_queue_assign_worker", "Mark a ready queue task as assigned to a live worker run.", {
  queueId: z.string(),
  queueTaskId: z.string(),
  workerRunId: z.string()
});
proxyTool("project_queue_update_task", "Update queue-task status, worker link, summary, patch refs, and test refs.", {
  queueId: z.string(),
  queueTaskId: z.string(),
  status: z.enum(["queued", "ready", "running", "blocked", "review", "patch_ready", "completed", "failed", "canceled", "accepted", "done"]),
  workerRunId: z.string().optional(),
  summary: z.string().optional(),
  patchRefs: z.array(z.string()).optional(),
  testRefs: z.array(z.string()).optional()
});
proxyTool("project_queue_update_task_metadata", "Edit queue-task planning metadata during human queue review.", {
  queueId: z.string(),
  queueTaskId: z.string(),
  title: z.string().optional(),
  goal: z.string().optional(),
	  phase: z.string().optional(),
	  clearPhase: z.boolean().optional(),
	  manager: z.string().optional(),
	  managerId: z.string().optional(),
	  clearManager: z.boolean().optional(),
	  clearManagerId: z.boolean().optional(),
	  parentManagerId: z.string().optional(),
	  clearParentManagerId: z.boolean().optional(),
	  parentQueueId: z.string().optional(),
	  clearParentQueueId: z.boolean().optional(),
	  workstream: z.string().optional(),
	  clearWorkstream: z.boolean().optional(),
	  costCenter: z.string().optional(),
	  clearCostCenter: z.boolean().optional(),
	  escalationTarget: z.string().optional(),
	  clearEscalationTarget: z.boolean().optional(),
	  category: z.string().optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  parallelGroup: z.string().optional(),
  clearParallelGroup: z.boolean().optional(),
  parallelSafe: z.boolean().optional(),
  risk: z.enum(["low", "medium", "high", "breakglass"]).optional(),
  expectedFiles: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  requiredTools: z.array(z.string()).optional(),
  requiredMcpServers: z.array(z.string()).optional(),
  requiredMemories: z.array(z.string()).optional(),
  requiredContextRefs: z.array(z.string()).optional(),
  addRequiredTools: z.array(z.string()).optional(),
  addRequiredMcpServers: z.array(z.string()).optional(),
  addRequiredMemories: z.array(z.string()).optional(),
  addRequiredContextRefs: z.array(z.string()).optional(),
  removeRequiredTools: z.array(z.string()).optional(),
  removeRequiredMcpServers: z.array(z.string()).optional(),
  removeRequiredMemories: z.array(z.string()).optional(),
  removeRequiredContextRefs: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).optional(),
  note: z.string().optional()
});
proxyTool("project_queue_decide", "Record a human queue gate decision such as accepting the plan or starting execution.", {
  queueId: z.string(),
  decision: z.enum([
    "accept_improved_prompt",
    "request_prompt_revision",
    "accept_plan",
    "request_plan_revision",
    "approve_queue",
    "start_execution",
    "pause",
    "resume",
    "cancel",
    "complete"
  ]),
  note: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});
proxyTool("project_queue_patch_review_plan", "Read-only review plan for patch-ready, failed-with-artifact, completed, and no-artifact queue tasks with changed files, patch refs, worker worktree/log refs, risk notes, suggested tests, and exact CLI dry-run/apply commands. Does not apply patches.", {
  queueId: z.string()
});
proxyTool("tool_context_propose", "Propose least-necessary tools, MCP servers, memories, context, and model alias for a queue task.", {
  queueId: z.string(),
  queueTaskId: z.string().optional(),
  fabricTaskId: z.string().optional(),
  mcpServers: z.array(z.unknown()).optional(),
  tools: z.array(z.unknown()).optional(),
  memories: z.array(z.unknown()).optional(),
  contextRefs: z.array(z.unknown()).optional(),
  modelAlias: z.string().optional(),
  reasoning: z.string().optional(),
  safetyWarnings: z.array(z.string()).optional(),
  approvalRequired: z.boolean().optional()
});
proxyTool("tool_context_decide", "Approve, reject, or request revision for a tool/context proposal and optionally remember grants.", {
  proposalId: z.string(),
  decision: z.enum(["approve", "reject", "revise"]),
  note: z.string().optional(),
  remember: z.boolean().optional()
});
proxyTool("tool_context_pending", "List pending tool/context approval proposals for an approval inbox.", {
  projectPath: z.string().optional(),
  queueId: z.string().optional(),
  limit: z.number().int().positive().optional()
});
proxyTool("tool_context_policy_set", "Explicitly approve or reject one project-level MCP/tool/memory/context grant.", {
  projectPath: z.string(),
  grantKind: z.enum(["mcp_server", "tool", "memory", "context"]),
  value: z.unknown(),
  status: z.enum(["approved", "rejected"])
});
proxyTool("tool_context_policy_status", "List remembered project-level tool/context grants.", {
  projectPath: z.string().optional()
});

proxyTool("fabric_task_create", "Create a durable fabric task before assigning it to any worker gateway.", {
  title: z.string(),
  goal: z.string(),
  projectPath: z.string(),
  priority: z.enum(["low", "normal", "high"]).optional(),
  refs: z.array(z.string()).optional(),
  requestedBy: z.string().optional()
});
proxyTool("fabric_task_start_worker", "Start or register an external worker run for a durable fabric task.", {
  taskId: z.string(),
  worker: z.enum(["ramicode", "local-cli", "openhands", "aider", "smolagents", "codex-app-server", "deepseek-direct", "jcode-deepseek", "manual"]),
  projectPath: z.string(),
  workspaceMode: z.enum(["in_place", "git_worktree", "clone", "sandbox"]),
  modelProfile: z.string(),
  workspacePath: z.string().optional(),
  contextPolicy: z.string().optional(),
  maxRuntimeMinutes: z.number().int().positive().optional(),
  command: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});
proxyTool("fabric_task_event", "Append one external worker event to a durable fabric task.", {
  taskId: z.string(),
  workerRunId: z.string(),
  kind: z.enum([
    "started",
    "thought_summary",
    "file_changed",
    "command_spawned",
    "command_started",
    "command_finished",
    "test_result",
    "checkpoint",
    "patch_ready",
    "failed",
    "completed"
  ]),
  body: z.string().optional(),
  refs: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  traceId: z.string().optional(),
  costUsd: z.number().nonnegative().optional()
});
proxyTool("fabric_task_checkpoint", "Write a resumable checkpoint summary for a durable fabric task.", {
  taskId: z.string(),
  workerRunId: z.string(),
  summary: z.record(z.string(), z.unknown())
});
proxyTool("fabric_task_heartbeat", "Refresh worker-run liveness without adding a full lifecycle event.", {
  taskId: z.string(),
  workerRunId: z.string(),
  task: z.string().optional(),
  progress: z.number().min(0).max(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});
proxyTool("fabric_task_status", "Read durable task, worker run, event, and checkpoint state.", {
  taskId: z.string(),
  includeEvents: z.boolean().optional(),
  includeCheckpoints: z.boolean().optional()
});
proxyTool("fabric_task_resume", "Return the smallest useful prompt/state for a worker to continue a durable task.", {
  taskId: z.string(),
  preferredWorker: z.enum(["ramicode", "local-cli", "openhands", "aider", "smolagents", "codex-app-server", "deepseek-direct", "jcode-deepseek", "manual"]).optional()
});
proxyTool("fabric_task_finish", "Mark a durable fabric task completed, failed, or canceled.", {
  taskId: z.string(),
  workerRunId: z.string().optional(),
  status: z.enum(["completed", "failed", "canceled"]),
  summary: z.string(),
  patchRefs: z.array(z.string()).optional(),
  testRefs: z.array(z.string()).optional(),
  followups: z.array(z.string()).optional()
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("agent-fabric MCP bridge running on stdio");

if (process.env.AGENT_FABRIC_NOTIFICATION_SELF_TEST === "stdout-visible") {
  void runStdoutVisibleNotificationSelfTest();
}

function proxyTool(name: string, description: string, inputSchema: Record<string, unknown>): void {
  const register = server.registerTool.bind(server) as (
    toolName: string,
    config: { description: string; inputSchema: Record<string, unknown> },
    callback: (input: Record<string, unknown>) => Promise<ReturnType<typeof asMcpResult>>
  ) => void;
  register(
    name,
    {
      description,
      inputSchema
    },
    async (input) => asMcpResult(await client.call(name, input, context(session, name, input)))
  );
}

async function register(): Promise<BridgeSession> {
  const payload: BridgeRegister = {
    bridgeVersion: "0.1.0",
    agent: {
      id: process.env.AGENT_FABRIC_AGENT_ID ?? "agent-fabric-bridge",
      displayName: process.env.AGENT_FABRIC_AGENT_NAME ?? "Agent Fabric Bridge",
      vendor: process.env.AGENT_FABRIC_AGENT_VENDOR
    },
    host: {
      name: process.env.AGENT_FABRIC_HOST_NAME ?? "MCP host",
      version: process.env.AGENT_FABRIC_HOST_VERSION,
      transport: "mcp-stdio"
    },
    workspace: {
      root: process.env.AGENT_FABRIC_WORKSPACE_ROOT ?? process.cwd(),
      source: process.env.AGENT_FABRIC_WORKSPACE_ROOT ? "explicit" : "cwd"
    },
    capabilities: {
      roots: process.env.AGENT_FABRIC_CAP_ROOTS === "1",
      notifications: process.env.AGENT_FABRIC_CAP_NOTIFICATIONS === "1",
      notificationsVisibleToAgent: {
        declared: process.env.AGENT_FABRIC_CAP_NOTIFICATIONS === "1" ? "yes" : "unknown",
        observed: "unknown"
      },
      sampling: false,
      streamableHttp: false,
      litellmRouteable: process.env.LITELLM_BYPASS === "1" ? false : process.env.AGENT_FABRIC_LITELLM_ROUTEABLE === "1",
      outcomeReporting: "explicit"
    },
    notificationSelfTest: {
      observed: "unknown",
      detail: "MCP bridge waits for explicit fabric_notification_self_test completion"
    },
    testMode: process.env.AGENT_FABRIC_TEST_MODE === "1"
  };
  return client.register(payload);
}

async function runStdoutVisibleNotificationSelfTest(): Promise<void> {
  const start = await client.call<{ testId: string; challenge: string }>(
    "fabric_notification_self_test_start",
    { ttlSeconds: 30 },
    context(session, "fabric_notification_self_test_start", { ttlSeconds: 30 })
  );
  console.error(start.challenge);
  await client.call(
    "fabric_notification_self_test_complete",
    {
      testId: start.testId,
      observed: "yes",
      detail: "challenge was printed to bridge stderr/stdout-visible startup path"
    },
    context(session, "fabric_notification_self_test_complete", {
      testId: start.testId,
      observed: "yes",
      detail: "challenge was printed to bridge stderr/stdout-visible startup path"
    })
  );
}

function context(session: BridgeSession, tool: string, input: unknown) {
  return bridgeCallContext(session, { tool, input });
}

function asMcpResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2)
      }
    ],
    structuredContent: data as Record<string, unknown>
  };
}
