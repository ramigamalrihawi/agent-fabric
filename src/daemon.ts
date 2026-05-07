import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { FabricDb, SCHEMA_VERSION } from "./db.js";
import {
  ingestAzureCostQueryResponse,
  ingestLiteLlmSpendLogs,
  ingestOpenRouterKeys,
  ingestRunPodInventory,
  type CostIngestResult
} from "./costing.js";
import { fabricInspectContextPackage } from "./surfaces/contextInspector.js";
import {
  fabricAcceptPatch,
  fabricListAgents,
  fabricMessageAgent,
  fabricOpenAgent,
  fabricSeniorResume,
  fabricSeniorStart,
  fabricSeniorStatus,
  fabricSpawnAgents,
  fabricWaitAgents
} from "./surfaces/codexBridge.js";
import { hashSecret, newId, newSessionToken, stableHash } from "./ids.js";
import type {
  BridgeRegister,
  BridgeSession,
  CallContext,
  FabricDiagnostic,
  FabricDoctor,
  FabricSessionSummary,
  FabricStatus,
  ResultEnvelope
} from "./types.js";
import { FabricError } from "./runtime/errors.js";
import { noopFanout, type CollabFanout } from "./runtime/fanout.js";
import {
  asRecord,
  expandIntentString,
  getArray,
  getField,
  getOptionalBoolean,
  getOptionalNumber,
  getOptionalString,
  getRequiredStringArray,
  getString,
  getStringArray,
  intentKeysFromIntent,
  normalizeIntentKey,
  redact,
  safeJsonArray,
  uniqueStrings
} from "./runtime/input.js";
import {
  formatAsk,
  formatAudit,
  formatClaim,
  formatEvent,
  formatMemory,
  formatMemoryEvalReport,
  formatMemoryInjection,
  formatMessage,
  rowToSessionSummary
} from "./runtime/format.js";
import {
  activeClaimConflicts,
  costCoverage,
  costFeatureRows,
  count,
  countWhere,
  deploymentSpendRows,
  detectCostAnomalies,
  monthStartIso,
  providerSpendRows,
  sumBy,
  sumReturnedHints,
  sumRows
} from "./runtime/queries.js";
import type { NotificationSelfTestRow, SessionRow } from "./runtime/rows.js";
import {
  claimPath,
  collabAsk,
  collabDecision,
  collabHeartbeat,
  collabInbox,
  collabReply,
  collabSend,
  collabStatus,
  releasePath
} from "./surfaces/collab.js";
import {
  fabricRouteOutcomesSummary,
  llmApprove,
  llmApprovePending,
  llmBudgetStatus,
  llmHardGate,
  llmPreflight,
  llmRouteFeedback,
  modelBrainRoute,
  policyResolveAlias
} from "./surfaces/costPolicy.js";
import { ppCostAnomaly, ppCostByFeature, ppCostIdleAudit, ppCostMonth, ppCostQuotaStatus } from "./surfaces/costs.js";
import {
  memoryAuditLift,
  memoryCheck,
  memoryConfirm,
  memoryEvalReport,
  memoryInvalidate,
  memoryList,
  memoryOutcome,
  memoryReview,
  memoryWrite
} from "./surfaces/memory.js";
import {
  planChainAnswerQuestion,
  planChainDecide,
  planChainExplain,
  planChainRecordCritique,
  planChainRecordRevision,
  planChainStart,
  planChainStatus
} from "./surfaces/plan.js";
import {
  projectQueueAddTasks,
  projectQueueAgentLanes,
  projectQueueApproveModelCalls,
  projectQueueApprovalInbox,
  projectQueueAssignWorker,
  projectQueueClaimNext,
  projectQueueCreate,
  projectQueueDashboard,
  projectQueueDecide,
  projectQueueList,
  projectQueueLaunchPlan,
  projectQueueNextReady,
  projectQueuePrepareReady,
  projectQueueProgressReport,
  projectQueueRecordStage,
  projectQueueRecoverStale,
  projectQueueResumeTask,
  projectQueueRetryTask,
  projectQueueReviewMatrix,
  projectQueueStatus,
  projectQueueTaskPacket,
  projectQueueTaskDetail,
  projectQueueTimeline,
  projectQueueUpdateSettings,
  projectQueueUpdateTask,
  projectQueueUpdateTaskMetadata,
  projectQueueValidateContextRefs,
  projectQueueValidateLinks,
  toolContextDecide,
  toolContextPending,
  toolContextPolicySet,
  toolContextPolicyStatus,
  toolContextPropose
} from "./surfaces/projectQueue.js";
import {
  fabricTaskCheckpoint,
  fabricTaskCreate,
  fabricTaskEvent,
  fabricTaskFinish,
  fabricTaskHeartbeat,
  fabricTaskResume,
  fabricTaskStartWorker,
  fabricTaskStatus
} from "./surfaces/worker.js";

export { FabricError } from "./runtime/errors.js";

const VERSION = "0.1.0";
const SENIOR_REQUIRED_TOOLS = [
  "fabric_senior_start",
  "fabric_senior_status",
  "fabric_senior_resume",
  "fabric_spawn_agents",
  "fabric_list_agents",
  "fabric_open_agent",
  "fabric_message_agent",
  "fabric_wait_agents",
  "fabric_accept_patch",
  "project_queue_approve_model_calls",
  "project_queue_validate_links",
  "project_queue_validate_context_refs"
];
const SUPPORTED_TOOLS = new Set([
  "fabric_status",
  "fabric_session_close",
  "fabric_doctor",
  "fabric_explain_session",
  "fabric_explain_memory",
  "fabric_trace",
  "fabric_inspect_context_package",
  "fabric_spawn_agents",
  "fabric_list_agents",
  "fabric_open_agent",
  "fabric_message_agent",
  "fabric_wait_agents",
  "fabric_accept_patch",
  "fabric_senior_start",
  "fabric_senior_status",
  "fabric_senior_resume",
  "fabric_notification_self_test_start",
  "fabric_notification_self_test_complete",
  "collab_send",
  "collab_inbox",
  "collab_ask",
  "collab_reply",
  "claim_path",
  "release_path",
  "collab_status",
  "collab_decision",
  "collab_heartbeat",
  "memory_write",
  "memory_check",
  "memory_outcome",
  "memory_list",
  "memory_audit_lift",
  "memory_invalidate",
  "memory_confirm",
  "memory_review",
  "memory_eval_report",
  "pp_cost_month",
  "pp_cost_by_feature",
  "pp_cost_idle_audit",
  "pp_cost_anomaly",
  "pp_cost_quota_status",
  "llm_preflight",
  "llm_approve",
  "llm_hard_gate",
  "model_brain_route",
  "policy_resolve_alias",
  "tool_context_propose",
  "tool_context_decide",
  "tool_context_status",
  "project_queue_create",
  "project_queue_list",
  "project_queue_status",
  "project_queue_update_settings",
  "project_queue_dashboard",
  "project_queue_review_matrix",
  "project_queue_task_detail",
  "project_queue_resume_task",
  "project_queue_task_packet",
  "project_queue_record_stage",
  "project_queue_add_tasks",
  "project_queue_next_ready",
  "project_queue_write_ready_packets",
  "project_queue_improve_prompt",
  "project_queue_start_plan",
  "project_queue_generate_tasks",
  "project_queue_review_queue",
  "project_queue_decide",
  "project_queue_prepare_ready",
  "project_queue_launch_plan",
  "project_queue_validate_links",
  "project_queue_validate_context_refs",
  "project_queue_claim_next",
  "project_queue_recover_stale",
  "project_queue_retry_task",
  "project_queue_agent_lanes",
  "project_queue_approve_model_calls",
  "project_queue_progress_report",
  "project_queue_approval_inbox",
  "project_queue_assign_worker",
  "project_queue_update_task",
  "project_queue_update_task_metadata",
  "project_queue_edit_task_metadata",
  "project_queue_review_patches",
  "project_queue_accept_patch",
  "project_queue_approvals",
  "project_queue_timeline",
  "fabric_task_create",
  "fabric_task_start_worker",
  "fabric_task_event",
  "fabric_task_checkpoint",
  "fabric_task_heartbeat",
  "fabric_task_status",
  "fabric_task_resume",
  "fabric_task_finish"
]);

export type DaemonOptions = {
  dbPath?: string;
  originPeerId?: string;
  now?: () => Date;
  fanout?: CollabFanout;
};

type FabricStatusOptions = {
  includeSessions?: boolean;
  sessionLimit?: number;
  sessionOffset?: number;
  dedupeWarnings?: boolean;
};

export class FabricDaemon {
  readonly db: FabricDb;
  readonly originPeerId: string;
  private readonly startedAt: Date;
  readonly now: () => Date;
  readonly fanout: CollabFanout;

  constructor(options: DaemonOptions = {}) {
    this.db = new FabricDb(options.dbPath ?? ":memory:");
    this.originPeerId = options.originPeerId ?? newId("peer");
    this.startedAt = new Date();
    this.now = options.now ?? (() => new Date());
    this.fanout = options.fanout ?? noopFanout;
  }

  close(): void {
    this.fanout.closeAll?.();
    this.db.close();
  }

  registerBridge(input: BridgeRegister): BridgeSession {
    const sessionId = newId("sess");
    const token = newSessionToken();
    const tokenHash = hashSecret(token);
    const expiresAt = new Date(this.now().getTime() + 1000 * 60 * 60 * 12).toISOString();
    const declared = input.capabilities.notificationsVisibleToAgent.declared;
    const observed = input.host.transport === "simulator" ? (input.notificationSelfTest?.observed ?? "unknown") : "unknown";
    const warnings = this.registrationWarnings(input, observed);
    const selfTest = input.notificationSelfTest
      ? { ...input.notificationSelfTest, checkedAt: input.notificationSelfTest.checkedAt ?? this.now().toISOString() }
      : { observed, detail: "self-test not run", checkedAt: this.now().toISOString() };

    this.db.transaction(() => {
      this.db.db
        .prepare(
          `INSERT INTO bridge_sessions (
            id, origin_peer_id, agent_id, display_name, vendor, host_name, host_version, transport,
            workspace_root, workspace_source, capabilities_json, notifications_declared,
            notifications_observed, notification_self_test_json, litellm_routeable, outcome_reporting,
            session_token_hash, expires_at, last_heartbeat_at, warnings_json, test_mode
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          sessionId,
          this.originPeerId,
          input.agent.id,
          input.agent.displayName,
          input.agent.vendor ?? null,
          input.host.name,
          input.host.version ?? null,
          input.host.transport,
          input.workspace.root,
          input.workspace.source,
          JSON.stringify(input.capabilities),
          declared,
          observed,
          JSON.stringify(selfTest),
          input.capabilities.litellmRouteable ? 1 : 0,
          input.capabilities.outcomeReporting,
          tokenHash,
          expiresAt,
          this.now().toISOString(),
          JSON.stringify(warnings),
          input.testMode ? 1 : 0
        );

      this.db.db
        .prepare(
          `INSERT INTO agent_cards (
            agent_id, display_name, host_name, capabilities_json, workspace_root, last_seen_at, source_session_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(agent_id) DO UPDATE SET
            display_name = excluded.display_name,
            host_name = excluded.host_name,
            capabilities_json = excluded.capabilities_json,
            workspace_root = excluded.workspace_root,
            last_seen_at = excluded.last_seen_at,
            source_session_id = excluded.source_session_id`
        )
        .run(
          input.agent.id,
          input.agent.displayName,
          input.host.name,
          JSON.stringify(input.capabilities),
          input.workspace.root,
          this.now().toISOString(),
          sessionId
        );

      this.db.db
        .prepare(
          `INSERT INTO presence (agent_id, session_id, last_seen_at)
          VALUES (?, ?, ?)
          ON CONFLICT(agent_id) DO UPDATE SET
            session_id = excluded.session_id,
            last_seen_at = excluded.last_seen_at`
        )
        .run(input.agent.id, sessionId, this.now().toISOString());

      this.writeAuditAndEvent({
        sessionId,
        agentId: input.agent.id,
        hostName: input.host.name,
        workspaceRoot: input.workspace.root,
        action: "bridge.session.started",
        sourceTable: "bridge_sessions",
        sourceId: sessionId,
        eventType: "bridge.session.started",
        payload: {
          agentId: input.agent.id,
          host: input.host.name,
          workspaceRoot: input.workspace.root,
          notificationsDeclared: declared,
          notificationsObserved: observed,
          warnings
        },
        testMode: input.testMode ?? false
      });
    });

    return {
      sessionId,
      sessionToken: token,
      originPeerId: this.originPeerId,
      expiresAt,
      heartbeatEveryMs: 30_000,
      warnings
    };
  }

  callTool<T = unknown>(tool: string, input: unknown, context: CallContext): ResultEnvelope<T> {
    try {
      const session = this.requireSession(context);
      if (tool === "fabric_status") {
        return { ok: true, tool, data: this.fabricStatus(fabricStatusOptions(input)) as T };
      }
      if (tool === "fabric_session_close") {
        return { ok: true, tool, data: this.closeBridgeSession(session, context) as T };
      }
      if (tool === "fabric_doctor") {
        return { ok: true, tool, data: this.fabricDoctor() as T };
      }
      if (tool === "fabric_explain_session") {
        const sessionId = getString(input, "sessionId");
        return { ok: true, tool, data: this.explainSession(sessionId) as T };
      }
      if (tool === "fabric_explain_memory") {
        const memoryId = getString(input, "memoryId");
        return { ok: true, tool, data: this.explainMemory(memoryId) as T };
      }
      if (tool === "fabric_trace") {
        const correlationId = getString(input, "correlationId");
        return { ok: true, tool, data: this.fabricTrace(correlationId) as T };
      }
      if (tool === "fabric_inspect_context_package") {
        return { ok: true, tool, data: fabricInspectContextPackage(this, input, context) as T };
      }
      if (tool === "fabric_spawn_agents") {
        return { ok: true, tool, data: fabricSpawnAgents(this, input, context) as T };
      }
      if (tool === "fabric_list_agents") {
        return { ok: true, tool, data: fabricListAgents(this, input, context) as T };
      }
      if (tool === "fabric_open_agent") {
        return { ok: true, tool, data: fabricOpenAgent(this, input, context) as T };
      }
      if (tool === "fabric_message_agent") {
        return { ok: true, tool, data: fabricMessageAgent(this, input, context) as T };
      }
      if (tool === "fabric_wait_agents") {
        return { ok: true, tool, data: fabricWaitAgents(this, input, context) as T };
      }
      if (tool === "fabric_accept_patch") {
        return { ok: true, tool, data: fabricAcceptPatch(this, input, context) as T };
      }
      if (tool === "fabric_senior_start") {
        return { ok: true, tool, data: fabricSeniorStart(this, input, context) as T };
      }
      if (tool === "fabric_senior_status") {
        return { ok: true, tool, data: fabricSeniorStatus(this, input, context) as T };
      }
      if (tool === "fabric_senior_resume") {
        return { ok: true, tool, data: fabricSeniorResume(this, input, context) as T };
      }
      if (tool === "fabric_notification_self_test_start") {
        return { ok: true, tool, data: this.startNotificationSelfTest(input, context) as T };
      }
      if (tool === "fabric_notification_self_test_complete") {
        return { ok: true, tool, data: this.completeNotificationSelfTest(input, context) as T };
      }
      if (tool === "collab_send") {
        return { ok: true, tool, data: collabSend(this, input, context) as T };
      }
      if (tool === "collab_inbox") {
        return { ok: true, tool, data: collabInbox(this, input, context) as T };
      }
      if (tool === "collab_ask") {
        return { ok: true, tool, data: collabAsk(this, input, context) as T };
      }
      if (tool === "collab_reply") {
        return { ok: true, tool, data: collabReply(this, input, context) as T };
      }
      if (tool === "claim_path") {
        return { ok: true, tool, data: claimPath(this, input, context) as T };
      }
      if (tool === "release_path") {
        return { ok: true, tool, data: releasePath(this, input, context) as T };
      }
      if (tool === "collab_status") {
        return { ok: true, tool, data: collabStatus(this, context) as T };
      }
      if (tool === "collab_decision") {
        return { ok: true, tool, data: collabDecision(this, input, context) as T };
      }
      if (tool === "collab_heartbeat") {
        return { ok: true, tool, data: collabHeartbeat(this, input, context) as T };
      }
      if (tool === "memory_write") {
        return { ok: true, tool, data: memoryWrite(this, input, context) as T };
      }
      if (tool === "memory_check") {
        return { ok: true, tool, data: memoryCheck(this, input, context) as T };
      }
      if (tool === "memory_outcome") {
        return { ok: true, tool, data: memoryOutcome(this, input, context) as T };
      }
      if (tool === "memory_list") {
        return { ok: true, tool, data: memoryList(this, input, context) as T };
      }
      if (tool === "memory_audit_lift") {
        return { ok: true, tool, data: memoryAuditLift(this, input, context) as T };
      }
      if (tool === "memory_invalidate") {
        return { ok: true, tool, data: memoryInvalidate(this, input, context) as T };
      }
      if (tool === "memory_confirm") {
        return { ok: true, tool, data: memoryConfirm(this, input, context) as T };
      }
      if (tool === "memory_review") {
        return { ok: true, tool, data: memoryReview(this, input, context) as T };
      }
      if (tool === "memory_eval_report") {
        return { ok: true, tool, data: memoryEvalReport(this, input, context) as T };
      }
      if (tool === "pp_cost_month") {
        return { ok: true, tool, data: ppCostMonth(this, input, context) as T };
      }
      if (tool === "pp_cost_by_feature") {
        return { ok: true, tool, data: ppCostByFeature(this, input, context) as T };
      }
      if (tool === "pp_cost_idle_audit") {
        return { ok: true, tool, data: ppCostIdleAudit(this, input, context) as T };
      }
      if (tool === "pp_cost_anomaly") {
        return { ok: true, tool, data: ppCostAnomaly(this, input, context) as T };
      }
      if (tool === "pp_cost_quota_status") {
        return { ok: true, tool, data: ppCostQuotaStatus(this, input, context) as T };
      }
      if (tool === "llm_preflight") {
        return { ok: true, tool, data: llmPreflight(this, input, context) as T };
      }
      if (tool === "llm_hard_gate") {
        return { ok: true, tool, data: llmHardGate(this, input, context) as T };
      }
      if (tool === "model_brain_route") {
        return { ok: true, tool, data: modelBrainRoute(this, input, context) as T };
      }
      if (tool === "llm_budget_status") {
        return { ok: true, tool, data: llmBudgetStatus(this, input, context) as T };
      }
      if (tool === "llm_approve_pending") {
        return { ok: true, tool, data: llmApprovePending(this, input, context) as T };
      }
      if (tool === "llm_approve") {
        return { ok: true, tool, data: llmApprove(this, input, context) as T };
      }
      if (tool === "llm_route_feedback") {
        return { ok: true, tool, data: llmRouteFeedback(this, input, context) as T };
      }
      if (tool === "fabric_route_outcomes_summary") {
        return { ok: true, tool, data: fabricRouteOutcomesSummary(this, input, context) as T };
      }
      if (tool === "policy_resolve_alias") {
        return { ok: true, tool, data: policyResolveAlias(this, input, context) as T };
      }
      if (tool === "plan_chain_start") {
        return { ok: true, tool, data: planChainStart(this, input, context) as T };
      }
      if (tool === "plan_chain_status") {
        return { ok: true, tool, data: planChainStatus(this, input, context) as T };
      }
      if (tool === "plan_chain_record_revision") {
        return { ok: true, tool, data: planChainRecordRevision(this, input, context) as T };
      }
      if (tool === "plan_chain_record_critique") {
        return { ok: true, tool, data: planChainRecordCritique(this, input, context) as T };
      }
      if (tool === "plan_chain_answer_question") {
        return { ok: true, tool, data: planChainAnswerQuestion(this, input, context) as T };
      }
      if (tool === "plan_chain_decide") {
        return { ok: true, tool, data: planChainDecide(this, input, context) as T };
      }
      if (tool === "plan_chain_explain") {
        return { ok: true, tool, data: planChainExplain(this, input, context) as T };
      }
      if (tool === "project_queue_create") {
        return { ok: true, tool, data: projectQueueCreate(this, input, context) as T };
      }
      if (tool === "project_queue_list") {
        return { ok: true, tool, data: projectQueueList(this, input, context) as T };
      }
      if (tool === "project_queue_status") {
        return { ok: true, tool, data: projectQueueStatus(this, input, context) as T };
      }
      if (tool === "project_queue_update_settings") {
        return { ok: true, tool, data: projectQueueUpdateSettings(this, input, context) as T };
      }
      if (tool === "project_queue_dashboard") {
        return { ok: true, tool, data: projectQueueDashboard(this, input, context) as T };
      }
      if (tool === "project_queue_review_matrix") {
        return { ok: true, tool, data: projectQueueReviewMatrix(this, input, context) as T };
      }
      if (tool === "project_queue_task_detail") {
        return { ok: true, tool, data: projectQueueTaskDetail(this, input, context) as T };
      }
      if (tool === "project_queue_task_packet") {
        return { ok: true, tool, data: projectQueueTaskPacket(this, input, context) as T };
      }
      if (tool === "project_queue_timeline") {
        return { ok: true, tool, data: projectQueueTimeline(this, input, context) as T };
      }
      if (tool === "project_queue_resume_task") {
        return { ok: true, tool, data: projectQueueResumeTask(this, input, context) as T };
      }
      if (tool === "project_queue_record_stage") {
        return { ok: true, tool, data: projectQueueRecordStage(this, input, context) as T };
      }
      if (tool === "project_queue_add_tasks") {
        return { ok: true, tool, data: projectQueueAddTasks(this, input, context) as T };
      }
      if (tool === "project_queue_next_ready") {
        return { ok: true, tool, data: projectQueueNextReady(this, input, context) as T };
      }
      if (tool === "project_queue_prepare_ready") {
        return { ok: true, tool, data: projectQueuePrepareReady(this, input, context) as T };
      }
      if (tool === "project_queue_launch_plan") {
        return { ok: true, tool, data: projectQueueLaunchPlan(this, input, context) as T };
      }
      if (tool === "project_queue_validate_links") {
        return { ok: true, tool, data: projectQueueValidateLinks(this, input, context) as T };
      }
      if (tool === "project_queue_validate_context_refs") {
        return { ok: true, tool, data: projectQueueValidateContextRefs(this, input, context) as T };
      }
      if (tool === "project_queue_claim_next") {
        return { ok: true, tool, data: projectQueueClaimNext(this, input, context) as T };
      }
      if (tool === "project_queue_recover_stale") {
        return { ok: true, tool, data: projectQueueRecoverStale(this, input, context) as T };
      }
      if (tool === "project_queue_retry_task") {
        return { ok: true, tool, data: projectQueueRetryTask(this, input, context) as T };
      }
      if (tool === "project_queue_agent_lanes") {
        return { ok: true, tool, data: projectQueueAgentLanes(this, input, context) as T };
      }
      if (tool === "project_queue_approve_model_calls") {
        return { ok: true, tool, data: projectQueueApproveModelCalls(this, input, context) as T };
      }
      if (tool === "project_queue_progress_report") {
        return { ok: true, tool, data: projectQueueProgressReport(this, input, context) as T };
      }
      if (tool === "project_queue_approval_inbox") {
        return { ok: true, tool, data: projectQueueApprovalInbox(this, input, context) as T };
      }
      if (tool === "project_queue_assign_worker") {
        return { ok: true, tool, data: projectQueueAssignWorker(this, input, context) as T };
      }
      if (tool === "project_queue_update_task") {
        return { ok: true, tool, data: projectQueueUpdateTask(this, input, context) as T };
      }
      if (tool === "project_queue_update_task_metadata") {
        return { ok: true, tool, data: projectQueueUpdateTaskMetadata(this, input, context) as T };
      }
      if (tool === "project_queue_decide") {
        return { ok: true, tool, data: projectQueueDecide(this, input, context) as T };
      }
      if (tool === "tool_context_propose") {
        return { ok: true, tool, data: toolContextPropose(this, input, context) as T };
      }
      if (tool === "tool_context_decide") {
        return { ok: true, tool, data: toolContextDecide(this, input, context) as T };
      }
      if (tool === "tool_context_pending") {
        return { ok: true, tool, data: toolContextPending(this, input, context) as T };
      }
      if (tool === "tool_context_policy_set") {
        return { ok: true, tool, data: toolContextPolicySet(this, input, context) as T };
      }
      if (tool === "tool_context_policy_status") {
        return { ok: true, tool, data: toolContextPolicyStatus(this, input, context) as T };
      }
      if (tool === "fabric_task_create") {
        return { ok: true, tool, data: fabricTaskCreate(this, input, context) as T };
      }
      if (tool === "fabric_task_start_worker") {
        return { ok: true, tool, data: fabricTaskStartWorker(this, input, context) as T };
      }
      if (tool === "fabric_task_event") {
        return { ok: true, tool, data: fabricTaskEvent(this, input, context) as T };
      }
      if (tool === "fabric_task_checkpoint") {
        return { ok: true, tool, data: fabricTaskCheckpoint(this, input, context) as T };
      }
      if (tool === "fabric_task_heartbeat") {
        return { ok: true, tool, data: fabricTaskHeartbeat(this, input, context) as T };
      }
      if (tool === "fabric_task_status") {
        return { ok: true, tool, data: fabricTaskStatus(this, input, context) as T };
      }
      if (tool === "fabric_task_resume") {
        return { ok: true, tool, data: fabricTaskResume(this, input, context) as T };
      }
      if (tool === "fabric_task_finish") {
        return { ok: true, tool, data: fabricTaskFinish(this, input, context) as T };
      }
      return {
        ok: false,
        tool,
        code: "TOOL_NOT_IMPLEMENTED",
        message: `${tool} is not implemented by the running Agent Fabric daemon. If this tool exists in the current checkout, rebuild/relink and restart the daemon so Codex, Claude Code, and agent-fabric-project talk to the same source tree.`,
        retryable: false
      };
    } catch (error) {
      return {
        ok: false,
        tool,
        code: error instanceof FabricError ? error.code : "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
        retryable: error instanceof FabricError ? error.retryable : false
      };
    }
  }

  recordMutation<T>(tool: string, input: unknown, context: CallContext, mutate: (session: SessionRow) => T): T {
    if (!context.idempotencyKey) {
      throw new FabricError("MISSING_IDEMPOTENCY_KEY", "Mutation requires an idempotency key", false);
    }
    const idempotencyKey = context.idempotencyKey;
    const session = this.requireSession(context);
    const payloadHash = stableHash(input);
    const lookup = (): { payload_hash: string; result_json: string } | undefined =>
      this.db.db
        .prepare("SELECT payload_hash, result_json FROM idempotency_keys WHERE session_id = ? AND tool = ? AND idempotency_key = ?")
        .get(session.id, tool, idempotencyKey) as { payload_hash: string; result_json: string } | undefined;

    // Fast path: most retries don't actually race. Skip the transaction lock
    // when we can confidently replay.
    const earlyHit = lookup();
    if (earlyHit) {
      return assertReplayMatch(earlyHit, payloadHash) as T;
    }

    // Slow path: take BEGIN IMMEDIATE, re-check inside the lock so a racing
    // peer that committed between our pre-check and our transaction is seen,
    // and we replay rather than redo the work and fail the unique insert.
    return this.db.transaction(() => {
      const innerHit = lookup();
      if (innerHit) {
        return assertReplayMatch(innerHit, payloadHash) as T;
      }
      const result = mutate(session);
      this.db.db
        .prepare(
          "INSERT INTO idempotency_keys (session_id, tool, idempotency_key, payload_hash, result_json) VALUES (?, ?, ?, ?, ?)"
        )
        .run(session.id, tool, idempotencyKey, payloadHash, JSON.stringify(result));
      return result;
    });
  }

  fabricStatus(options: FabricStatusOptions = {}): FabricStatus {
    this.expireNotificationSelfTests();
    const rows = (this.db.db
      .prepare("SELECT * FROM bridge_sessions WHERE ended_at IS NULL ORDER BY started_at DESC")
      .all() as SessionRow[]).filter((row) => !row.expires_at || Date.parse(row.expires_at) > this.now().getTime());
    const sessionOffset = normalizeStatusOffset(options.sessionOffset);
    const sessionLimit = normalizeStatusLimit(options.sessionLimit);
    const includeSessions = options.includeSessions ?? true;
    const sessions = includeSessions ? rows.slice(sessionOffset, sessionOffset + sessionLimit).map(rowToSessionSummary) : [];
    const allSessions = rows.map(rowToSessionSummary);
    const recentCostRows = this.db.db
      .prepare("SELECT DISTINCT agent_id FROM cost_events WHERE agent_id IS NOT NULL AND ts >= ?")
      .all(new Date(this.now().getTime() - 60 * 60 * 1000).toISOString()) as { agent_id: string }[];
    const observedRouteableAgents = uniqueStrings(recentCostRows.map((row) => row.agent_id));
    const byAgent = Object.fromEntries(
      allSessions.map((session) => [session.agentId, observedRouteableAgents.includes(session.agentId) ? 100 : 0])
    );
    const coveragePct = allSessions.length === 0 ? 0 : Math.round((observedRouteableAgents.length / allSessions.length) * 100);
    const auditBacklog = count(this.db, "audit");
    const outboxEventsLast24h = this.db.db
      .prepare("SELECT COUNT(*) AS count FROM events WHERE ts >= datetime('now', '-1 day')")
      .get() as { count: number };
    const oldest = this.db.db.prepare("SELECT MIN(ts) AS ts FROM events").get() as { ts: string | null };
    const lastBilling = this.db.db.prepare("SELECT MAX(ts_polled) AS ts FROM cost_billing").get() as { ts: string | null };
    const warnings = options.dedupeWarnings === false
      ? this.statusWarnings(allSessions, lastBilling.ts, observedRouteableAgents)
      : uniqueStrings(this.statusWarnings(allSessions, lastBilling.ts, observedRouteableAgents));
    const missingSeniorRequired = SENIOR_REQUIRED_TOOLS.filter((tool) => !SUPPORTED_TOOLS.has(tool));

    return {
      daemon: {
        status: warnings.some((warning) => warning.startsWith("error:")) ? "degraded" : "ok",
        version: VERSION,
        uptimeSeconds: Math.max(0, Math.floor((this.now().getTime() - this.startedAt.getTime()) / 1000)),
        dbPath: this.db.path,
        schemaVersion: this.db.schemaVersion(),
        originPeerId: this.originPeerId,
        runtime: daemonRuntimeInfo(),
        tools: {
          seniorRequired: SENIOR_REQUIRED_TOOLS,
          missingSeniorRequired
        }
      },
      bridgeSessions: {
        active: rows.length,
        returned: sessions.length,
        offset: includeSessions ? sessionOffset : undefined,
        limit: includeSessions ? sessionLimit : undefined,
        sessions
      },
      coverage: {
        litellmCoveragePct: coveragePct,
        byAgent,
        observedRouteableAgents,
        uncoveredAgents: uniqueStrings(allSessions.filter((session) => byAgent[session.agentId] !== 100).map((session) => session.agentId)),
        outcomeCoveragePct: this.outcomeCoveragePct()
      },
      storage: {
        auditBacklog,
        outboxEventsLast24h: outboxEventsLast24h.count,
        oldestUncompactedEvent: oldest.ts ?? undefined
      },
      billing: {
        lastPollAt: lastBilling.ts ?? undefined,
        freshness: lastBilling.ts ? "1h-old" : "missing"
      },
      warnings
    };
  }

  fabricDoctor(): FabricDoctor {
    const status = this.fabricStatus({ includeSessions: true, sessionLimit: 500, dedupeWarnings: true });
    const diagnostics: FabricDiagnostic[] = [];
    for (const session of status.bridgeSessions.sessions) {
      if (session.notificationsVisibleToAgent.declared === "yes" && session.notificationsVisibleToAgent.observed !== "yes") {
        diagnostics.push({
          id: `notifications-${session.sessionId}`,
          severity: "warning",
          message: `${session.host} declares notifications but observed delivery is ${session.notificationsVisibleToAgent.observed}.`,
          evidence: {
            agentId: session.agentId,
            declared: session.notificationsVisibleToAgent.declared,
            observed: session.notificationsVisibleToAgent.observed
          },
          suggestedAction: {
            actionKind: "inspect",
            risk: "safe",
            dryRunCommand: "agent-fabric-sim notification-self-test"
          }
        });
      }
      if (!session.litellmRouteable) {
        diagnostics.push({
          id: `litellm-${session.sessionId}`,
          severity: "info",
          message: `${session.agentId} is not routeable through LiteLLM; cost coverage will be partial.`,
          evidence: { agentId: session.agentId, host: session.host }
        });
      }
    }
    if (status.billing.freshness === "missing") {
      diagnostics.push({
        id: "billing-missing",
        severity: "warning",
        message: "No billing poll has been recorded yet.",
        evidence: {},
        suggestedAction: {
          actionKind: "auth",
          risk: "safe",
          dryRunCommand: "agent-fabric-bridge fabric_status"
        }
      });
    }
    return { status, diagnostics };
  }

  ingestLiteLlmSpendLogs(input: unknown): CostIngestResult {
    return ingestLiteLlmSpendLogs(this.db, input, { originPeerId: this.originPeerId });
  }

  ingestAzureCostQuery(input: unknown, options: { periodStart?: string; periodEnd?: string } = {}): CostIngestResult {
    return ingestAzureCostQueryResponse(this.db, input, options);
  }

  ingestRunPodInventory(input: unknown): CostIngestResult {
    return ingestRunPodInventory(this.db, input);
  }

  ingestOpenRouterKeys(input: unknown): CostIngestResult {
    return ingestOpenRouterKeys(this.db, input);
  }

  startNotificationSelfTest(input: unknown, context: CallContext): Record<string, unknown> {
    const session = this.requireSession(context);
    const ttlSeconds = Math.min(getOptionalNumber(input, "ttlSeconds") ?? 30, 300);
    const testId = newId("ntf");
    const challenge = `agent-fabric notification self-test ${testId}`;
    const expiresAt = new Date(this.now().getTime() + ttlSeconds * 1000).toISOString();
    this.db.transaction(() => {
      this.db.db
        .prepare(
          `INSERT INTO notification_self_tests (
            id, session_id, agent_id, host_name, workspace_root, challenge,
            status, expires_at, observed
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'unknown')`
        )
        .run(testId, session.id, session.agent_id, session.host_name, session.workspace_root, challenge, expiresAt);
      this.writeAuditAndEvent({
        sessionId: session.id,
        agentId: session.agent_id,
        hostName: session.host_name,
        workspaceRoot: session.workspace_root,
        action: "bridge.notification_self_test.started",
        sourceTable: "notification_self_tests",
        sourceId: testId,
        eventType: "bridge.notification_self_test.started",
        payload: { testId, expiresAt },
        testMode: session.test_mode === 1,
        context
      });
    });
    return {
      testId,
      challenge,
      expiresAt,
      instructions: "Show this exact challenge in an agent-visible channel, then call fabric_notification_self_test_complete."
    };
  }

  completeNotificationSelfTest(input: unknown, context: CallContext): Record<string, unknown> {
    const session = this.requireSession(context);
    const testId = getString(input, "testId");
    const observed = getString(input, "observed");
    if (!["yes", "no", "unknown"].includes(observed)) {
      throw new FabricError("INVALID_INPUT", "observed must be yes, no, or unknown", false);
    }
    const detail = getOptionalString(input, "detail") ?? null;
    return this.db.transaction(() => {
      const row = this.db.db.prepare("SELECT * FROM notification_self_tests WHERE id = ?").get(testId) as NotificationSelfTestRow | undefined;
      if (!row || row.session_id !== session.id) {
        throw new FabricError("NOTIFICATION_SELF_TEST_NOT_FOUND", `Notification self-test not found: ${testId}`, false);
      }
      const expired = Date.parse(row.expires_at) <= this.now().getTime();
      const finalObserved = expired && observed === "yes" ? "no" : observed;
      const status = expired ? "expired" : "completed";
      this.db.db
        .prepare("UPDATE notification_self_tests SET status = ?, completed_at = CURRENT_TIMESTAMP, observed = ?, detail = ? WHERE id = ?")
        .run(status, finalObserved, detail, testId);
      this.updateSessionNotificationObservation(session, finalObserved as "yes" | "no" | "unknown", {
        testId,
        challenge: row.challenge,
        observed: finalObserved,
        detail: detail ?? (expired ? "self-test completed after expiry" : undefined),
        checkedAt: this.now().toISOString()
      });
      this.writeAuditAndEvent({
        sessionId: session.id,
        agentId: session.agent_id,
        hostName: session.host_name,
        workspaceRoot: session.workspace_root,
        action: "bridge.notification_self_test.completed",
        sourceTable: "notification_self_tests",
        sourceId: testId,
        eventType: "bridge.notification_self_test.completed",
        payload: { testId, observed: finalObserved, status },
        testMode: session.test_mode === 1,
        context
      });
      return { testId, observed: finalObserved, status, accepted: finalObserved === "yes" && status === "completed" };
    });
  }

  explainSession(sessionId: string): Record<string, unknown> {
    const session = this.db.db.prepare("SELECT * FROM bridge_sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
    if (!session) {
      throw new FabricError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`, false);
    }
    const events = this.db.db
      .prepare("SELECT id, event_type, source_table, source_id, ts FROM events WHERE session_id = ? ORDER BY ts")
      .all(sessionId);
    const auditRows = this.db.db.prepare("SELECT id, action, source_table, source_id, ts FROM audit WHERE session_id = ? ORDER BY ts").all(sessionId);
    return {
      session: rowToSessionSummary(session),
      collab: {
        messagesSent: countWhere(this.db, "messages", "session_id = ?", [sessionId]),
        asksCreated: countWhere(this.db, "asks", "asker_agent_id = ? AND workspace_root = ?", [session.agent_id, session.workspace_root]),
        repliesSent: countWhere(this.db, "messages", "session_id = ? AND ask_id IS NOT NULL", [sessionId]),
        claimsAcquired: countWhere(this.db, "claims", "session_id = ?", [sessionId]),
        decisionsRecorded: countWhere(this.db, "decisions", "recorded_by_agent_id = ? AND workspace_root = ?", [session.agent_id, session.workspace_root])
      },
      memory: {
        checks: countWhere(this.db, "memory_injections", "session_id = ?", [sessionId]),
        hintsReturned: sumReturnedHints(this.db, sessionId),
        memoriesWritten: countWhere(this.db, "memories", "created_by_session_id = ?", [sessionId]),
        outcomesReported: countWhere(this.db, "memory_injections", "session_id = ? AND outcome IS NOT NULL", [sessionId])
      },
      costs: { ledgers: {}, coveragePct: rowToSessionSummary(session).litellmRouteable ? 100 : 0 },
      events,
      audit: auditRows,
      warnings: rowToSessionSummary(session).warnings
    };
  }

  explainMemory(memoryId: string): Record<string, unknown> {
    const memory = this.db.db.prepare("SELECT * FROM memories WHERE id = ?").get(memoryId) as Record<string, unknown> | undefined;
    if (!memory) {
      throw new FabricError("MEMORY_NOT_FOUND", `Memory not found: ${memoryId}`, false);
    }
    const session = memory.created_by_session_id
      ? (this.db.db.prepare("SELECT * FROM bridge_sessions WHERE id = ?").get(memory.created_by_session_id as string) as SessionRow | undefined)
      : undefined;
    const events = this.db.db
      .prepare("SELECT * FROM events WHERE source_table = 'memories' AND source_id = ? ORDER BY ts")
      .all(memoryId) as Record<string, unknown>[];
    const audit = this.db.db
      .prepare("SELECT * FROM audit WHERE source_table = 'memories' AND source_id = ? ORDER BY ts")
      .all(memoryId) as Record<string, unknown>[];
    const injections = (this.db.db
      .prepare("SELECT * FROM memory_injections WHERE namespace = ? ORDER BY ts")
      .all(memory.namespace as string) as Record<string, unknown>[]).filter((row) => {
      const returned = safeJsonArray(row.memories_returned_json);
      return returned.some((item) => asRecord(item).id === memoryId);
    });
    const traceIds = uniqueStrings([
      ...events.map((event) => event.trace_id),
      ...injections.map((injection) => injection.trace_id)
    ]);
    const correlationIds = uniqueStrings([
      ...events.map((event) => event.correlation_id),
      ...injections.map((injection) => injection.correlation_id)
    ]);
    const warnings =
      memory.status === "pending_review"
        ? ["memory is pending_review and is not injectable"]
        : memory.archived === 1
          ? ["memory is archived"]
          : [];
    return {
      memory: formatMemory(memory),
      createdBy: session ? rowToSessionSummary(session) : null,
      causalChain: {
        session: session ? rowToSessionSummary(session) : null,
        trace: { traceIds, correlationIds },
        costRows: this.costRowsForTraceOrCorrelation(traceIds, correlationIds),
        events: events.map(formatEvent)
      },
      lifecycleEvents: events.map(formatEvent),
      audit: audit.map(formatAudit),
      injections: injections.map(formatMemoryInjection),
      correlatedCosts: this.costRowsForTraceOrCorrelation(traceIds, correlationIds),
      coverageWarnings: warnings,
      warnings
    };
  }

  fabricTrace(correlationId: string): Record<string, unknown> {
    const events = this.db.db
      .prepare("SELECT * FROM events WHERE correlation_id = ? ORDER BY ts")
      .all(correlationId) as Record<string, unknown>[];
    const messages = this.db.db
      .prepare("SELECT * FROM messages WHERE correlation_id = ? ORDER BY ts")
      .all(correlationId) as Record<string, unknown>[];
    const asks = this.db.db.prepare("SELECT * FROM asks WHERE correlation_id = ? ORDER BY ts_created").all(correlationId) as Record<string, unknown>[];
    const tasks = this.db.db
      .prepare("SELECT * FROM tasks WHERE correlation_id = ? ORDER BY ts_created")
      .all(correlationId) as Record<string, unknown>[];
    const memoryChecks = this.db.db
      .prepare("SELECT * FROM memory_injections WHERE correlation_id = ? ORDER BY ts")
      .all(correlationId) as Record<string, unknown>[];
    const costs = this.db.db.prepare("SELECT * FROM cost_events WHERE correlation_id = ? ORDER BY ts").all(correlationId);
    const sessions = uniqueStrings(events.map((event) => event.session_id))
      .map((sessionId) => this.db.db.prepare("SELECT * FROM bridge_sessions WHERE id = ?").get(sessionId) as SessionRow | undefined)
      .filter((session): session is SessionRow => Boolean(session))
      .map(rowToSessionSummary);
    const coverageWarnings =
      events.length === 0 && messages.length === 0 && asks.length === 0 && memoryChecks.length === 0 ? ["no rows matched correlationId"] : [];
    return {
      correlationId,
      sessions,
      tasks,
      messages: messages.map(formatMessage),
      memoryInjections: memoryChecks.map(formatMemoryInjection),
      coverageWarnings,
      events: events.map(formatEvent),
      collab: {
        messages: messages.map(formatMessage),
        asks: asks.map(formatAsk),
        tasks
      },
      memory: {
        checks: memoryChecks.map(formatMemoryInjection)
      },
      costs,
      warnings: coverageWarnings
    };
  }

  private costRowsForTraceOrCorrelation(traceIds: string[], correlationIds: string[]): Record<string, unknown>[] {
    const rows: Record<string, unknown>[] = [];
    for (const traceId of traceIds) {
      rows.push(...(this.db.db.prepare("SELECT * FROM cost_events WHERE trace_id = ? ORDER BY ts").all(traceId) as Record<string, unknown>[]));
    }
    for (const correlationId of correlationIds) {
      rows.push(...(this.db.db.prepare("SELECT * FROM cost_events WHERE correlation_id = ? ORDER BY ts").all(correlationId) as Record<string, unknown>[]));
    }
    const seen = new Set<string>();
    return rows.filter((row) => {
      const id = String(row.id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  writeAuditAndEvent(input: {
    sessionId: string | null;
    agentId: string;
    hostName: string | null;
    workspaceRoot: string;
    action: string;
    sourceTable: string;
    sourceId: string;
    eventType: string;
    payload: Record<string, unknown>;
    testMode: boolean;
    context?: CallContext;
  }): void {
    const auditId = newId("audit");
    const eventId = newId("evt");
    const payload = JSON.stringify(redact(input.payload));
    this.db.db
      .prepare(
        `INSERT INTO audit (
          id, session_id, agent_id, host_name, workspace_root, action,
          source_table, source_id, redacted_payload_json, test_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        auditId,
        input.sessionId,
        input.agentId,
        input.hostName,
        input.workspaceRoot,
        input.action,
        input.sourceTable,
        input.sourceId,
        payload,
        input.testMode ? 1 : 0
      );
    this.db.db
      .prepare(
        `INSERT INTO events (
          id, origin_peer_id, session_id, turn_id, trace_id, span_id, parent_span_id,
          correlation_id, workspace_root, actor_id, host, event_type, source_table,
          source_id, idempotency_key, payload_json, test_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        eventId,
        this.originPeerId,
        input.sessionId,
        input.context?.turnId ?? null,
        input.context?.traceId ?? null,
        input.context?.spanId ?? null,
        input.context?.parentSpanId ?? null,
        input.context?.correlationId ?? null,
        input.workspaceRoot,
        input.agentId,
        input.hostName,
        input.eventType,
        input.sourceTable,
        input.sourceId,
        input.context?.idempotencyKey ?? null,
        payload,
        input.testMode ? 1 : 0
      );
  }

  requireSession(context: CallContext): SessionRow {
    const row = this.db.db.prepare("SELECT * FROM bridge_sessions WHERE id = ? AND ended_at IS NULL").get(context.sessionId) as
      | SessionRow
      | undefined;
    if (!row) {
      throw new FabricError("SESSION_NOT_FOUND", `Active session not found: ${context.sessionId}`, false);
    }
    if (!context.sessionToken) {
      throw new FabricError("SESSION_UNAUTHORIZED", "Session token is required", false);
    }
    if (hashSecret(context.sessionToken) !== row.session_token_hash) {
      throw new FabricError("SESSION_UNAUTHORIZED", "Session token mismatch", false);
    }
    if (row.expires_at && Date.parse(row.expires_at) <= this.now().getTime()) {
      this.db.db.prepare("UPDATE bridge_sessions SET ended_at = CURRENT_TIMESTAMP WHERE id = ?").run(row.id);
      throw new FabricError("SESSION_EXPIRED", `Session expired: ${context.sessionId}`, false);
    }
    return row;
  }

  closeBridgeSession(session: SessionRow, context?: CallContext): Record<string, unknown> {
    this.db.db.prepare("UPDATE bridge_sessions SET ended_at = CURRENT_TIMESTAMP WHERE id = ? AND ended_at IS NULL").run(session.id);
    this.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "bridge.session.ended",
      sourceTable: "bridge_sessions",
      sourceId: session.id,
      eventType: "bridge.session.ended",
      payload: { sessionId: session.id, agentId: session.agent_id },
      testMode: session.test_mode === 1,
      context
    });
    return { sessionId: session.id, status: "ended" };
  }

  private registrationWarnings(input: BridgeRegister, observed: "yes" | "no" | "unknown"): string[] {
    const warnings: string[] = [];
    if (input.workspace.source === "cwd") {
      warnings.push("workspace root came from cwd fallback");
    }
    if (input.capabilities.notificationsVisibleToAgent.declared === "yes" && observed !== "yes") {
      warnings.push(`notifications declared yes but observed ${observed}`);
    }
    if (!input.capabilities.litellmRouteable) {
      warnings.push("LiteLLM routeability is false; cost coverage will be partial");
    }
    return warnings;
  }

  private statusWarnings(sessions: FabricSessionSummary[], lastBilling: string | null, observedRouteableAgents: string[]): string[] {
    const warnings: string[] = [];
    if (sessions.length === 0) {
      warnings.push("no active bridge sessions");
    }
    for (const session of sessions) {
      if (session.notificationsVisibleToAgent.declared === "yes" && session.notificationsVisibleToAgent.observed !== "yes") {
        warnings.push(`${session.agentId}: notifications declared yes but observed ${session.notificationsVisibleToAgent.observed}`);
      }
      if (session.litellmRouteable && !observedRouteableAgents.includes(session.agentId)) {
        warnings.push(`${session.agentId}: LiteLLM routeable but no cost_events observed in the last hour`);
      }
    }
    if (!lastBilling) {
      warnings.push("billing poll missing");
    }
    return warnings;
  }

  private updateSessionNotificationObservation(
    session: SessionRow,
    observed: "yes" | "no" | "unknown",
    selfTest: Record<string, unknown>
  ): void {
    const warnings = (JSON.parse(session.warnings_json) as string[]).filter((warning) => !warning.startsWith("notifications declared yes"));
    if (session.notifications_declared === "yes" && observed !== "yes") {
      warnings.push(`notifications declared yes but observed ${observed}`);
    }
    this.db.db
      .prepare("UPDATE bridge_sessions SET notifications_observed = ?, notification_self_test_json = ?, warnings_json = ? WHERE id = ?")
      .run(observed, JSON.stringify(selfTest), JSON.stringify(warnings), session.id);
  }

  private expireNotificationSelfTests(): void {
    const expired = this.db.db
      .prepare("SELECT * FROM notification_self_tests WHERE status = 'pending' AND datetime(expires_at) <= datetime(?)")
      .all(this.now().toISOString()) as NotificationSelfTestRow[];
    for (const row of expired) {
      const session = this.db.db.prepare("SELECT * FROM bridge_sessions WHERE id = ?").get(row.session_id) as SessionRow | undefined;
      if (!session) continue;
      this.db.transaction(() => {
        this.db.db
          .prepare("UPDATE notification_self_tests SET status = 'expired', completed_at = CURRENT_TIMESTAMP, observed = 'no', detail = ? WHERE id = ?")
          .run("self-test timed out before bridge confirmed agent-visible delivery", row.id);
        this.updateSessionNotificationObservation(session, "no", {
          testId: row.id,
          challenge: row.challenge,
          observed: "no",
          detail: "self-test timed out before bridge confirmed agent-visible delivery",
          checkedAt: this.now().toISOString()
        });
        this.writeAuditAndEvent({
          sessionId: session.id,
          agentId: session.agent_id,
          hostName: session.host_name,
          workspaceRoot: session.workspace_root,
          action: "bridge.notification_self_test.expired",
          sourceTable: "notification_self_tests",
          sourceId: row.id,
          eventType: "bridge.notification_self_test.expired",
          payload: { testId: row.id },
          testMode: session.test_mode === 1
        });
      });
    }
  }

  private outcomeCoveragePct(): number {
    const row = this.db.db
      .prepare(
        "SELECT COUNT(*) AS total, SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) AS reported FROM memory_injections WHERE test_mode = 0"
      )
      .get() as { total: number; reported: number | null };
    return row.total === 0 ? 0 : Math.round(((row.reported ?? 0) / row.total) * 100);
  }

  exportCollabView(workspaceRoot: string): void {
    if (this.db.path === ":memory:") return;
    const viewDir = join(dirname(this.db.path), "views");
    mkdirSync(viewDir, { recursive: true, mode: 0o700 });
    const messages = this.db.db
      .prepare("SELECT * FROM messages WHERE workspace_root = ? ORDER BY ts DESC LIMIT 50")
      .all(workspaceRoot) as Record<string, unknown>[];
    const asks = this.db.db
      .prepare("SELECT * FROM asks WHERE workspace_root = ? AND status = 'open' ORDER BY ts_created DESC LIMIT 50")
      .all(workspaceRoot) as Record<string, unknown>[];
    const claims = this.db.db
      .prepare(
        "SELECT * FROM claims WHERE workspace_root = ? AND released = 0 AND (ts_expires IS NULL OR datetime(ts_expires) > CURRENT_TIMESTAMP) ORDER BY ts_created DESC LIMIT 50"
      )
      .all(workspaceRoot) as Record<string, unknown>[];
    const decisions = this.db.db
      .prepare("SELECT * FROM decisions WHERE workspace_root = ? ORDER BY ts DESC LIMIT 50")
      .all(workspaceRoot) as Record<string, unknown>[];
    const lines = [
      "# Agent Fabric Channel",
      "",
      `Workspace: ${workspaceRoot}`,
      `Generated: ${this.now().toISOString()}`,
      "",
      "## Open Asks",
      ...asks.map((ask) => `- [${ask.urgency}] ${ask.id} from ${ask.asker_agent_id} to ${ask.recipient}: ${ask.question}`),
      ...(asks.length ? [] : ["- None"]),
      "",
      "## Active Claims",
      ...claims.map((claim) => `- ${claim.id} by ${claim.agent_id}: ${safeJsonArray(claim.paths_json).join(", ")}`),
      ...(claims.length ? [] : ["- None"]),
      "",
      "## Recent Decisions",
      ...decisions.map((decision) => `- ${decision.ts} ${decision.title}: ${decision.decided}`),
      ...(decisions.length ? [] : ["- None"]),
      "",
      "## Recent Messages",
      ...messages.map((message) => `- ${message.ts} ${message.sender_agent_id} -> ${message.recipient}: ${String(message.body).replace(/\s+/g, " ")}`),
      ...(messages.length ? [] : ["- None"]),
      ""
    ];
    writeFileSync(join(viewDir, "channel.md"), `${lines.join("\n")}\n`, { mode: 0o600 });
  }
}

function fabricStatusOptions(input: unknown): FabricStatusOptions {
  return {
    includeSessions: getOptionalBoolean(input, "includeSessions"),
    sessionLimit: getOptionalNumber(input, "sessionLimit"),
    sessionOffset: getOptionalNumber(input, "sessionOffset"),
    dedupeWarnings: getOptionalBoolean(input, "dedupeWarnings")
  };
}

function normalizeStatusLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isFinite(value)) return 50;
  return Math.min(Math.max(Math.floor(value), 0), 500);
}

function normalizeStatusOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(Math.floor(value), 0);
}

function daemonRuntimeInfo(): NonNullable<FabricStatus["daemon"]["runtime"]> {
  const entrypoint = process.argv[1] ? resolve(process.argv[1]) : undefined;
  return {
    pid: process.pid,
    cwd: process.cwd(),
    entrypoint,
    node: process.execPath,
    packageRoot: entrypoint ? inferPackageRoot(entrypoint) : undefined
  };
}

function inferPackageRoot(entrypoint: string): string | undefined {
  const marker = `${join("dist", "bin")}${entrypoint.includes("/") ? "/" : "\\"}`;
  const index = entrypoint.lastIndexOf(marker);
  if (index === -1) return undefined;
  return entrypoint.slice(0, index).replace(/[\\/]$/, "");
}

function assertReplayMatch(
  hit: { payload_hash: string; result_json: string },
  payloadHash: string
): unknown {
  if (hit.payload_hash !== payloadHash) {
    throw new FabricError("IDEMPOTENCY_CONFLICT", "Same idempotency key was reused with a different payload", false);
  }
  return JSON.parse(hit.result_json);
}
