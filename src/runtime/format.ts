// Row → DTO formatters. Pure functions: take a SQLite row, return the shape
// the surface API exposes. No DB access, no input validation.

import type { FabricSessionSummary } from "../types.js";
import { safeJsonArray, safeJsonRecord } from "./input.js";
import type { SessionRow } from "./rows.js";

export function rowToSessionSummary(row: SessionRow): FabricSessionSummary {
  return {
    sessionId: row.id,
    agentId: row.agent_id,
    host: row.host_name,
    workspaceRoot: row.workspace_root,
    startedAt: row.started_at,
    lastHeartbeatAt: row.last_heartbeat_at ?? undefined,
    notificationsVisibleToAgent: {
      declared: row.notifications_declared,
      observed: row.notifications_observed
    },
    litellmRouteable: row.litellm_routeable === 1,
    warnings: JSON.parse(row.warnings_json) as string[]
  };
}

export function formatMessage(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    ts: row.ts,
    from: row.sender_agent_id,
    to: row.recipient,
    kind: row.kind,
    body: row.body,
    refs: safeJsonArray(row.refs_json),
    askId: row.ask_id ?? undefined,
    taskId: row.task_id ?? undefined,
    correlationId: row.correlation_id ?? undefined
  };
}

export function formatAsk(row: Record<string, unknown>): Record<string, unknown> {
  return {
    askId: row.id,
    taskId: row.task_id,
    tsCreated: row.ts_created,
    tsUpdated: row.ts_updated,
    from: row.asker_agent_id,
    to: row.recipient,
    kind: row.kind,
    urgency: row.urgency,
    status: row.status,
    question: row.question,
    refs: safeJsonArray(row.refs_json),
    correlationId: row.correlation_id
  };
}

export function formatClaim(row: Record<string, unknown>): Record<string, unknown> {
  return {
    claimId: row.id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    paths: safeJsonArray(row.paths_json),
    note: row.note ?? undefined,
    mode: row.mode,
    overlapping: row.overlapping === 1,
    expiresAt: row.ts_expires,
    released: row.released === 1
  };
}

export function formatMemory(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    type: row.type,
    namespace: row.namespace,
    body: row.body,
    intentKeys: safeJsonArray(row.intent_keys_json),
    confidence: row.confidence,
    status: row.status,
    severity: row.severity,
    refs: safeJsonArray(row.refs_json),
    source: row.source,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    validFrom: row.valid_from ?? undefined,
    invalidAt: row.invalid_at ?? undefined,
    recordedAt: row.recorded_at ?? undefined,
    recordedUntil: row.recorded_until ?? undefined,
    createdBySessionId: row.created_by_session_id ?? undefined,
    createdByAgentId: row.created_by_agent_id ?? undefined,
    injectable: row.status === "active" && row.archived !== 1 && !row.invalid_at && !row.recorded_until
  };
}

export function formatMemoryInjection(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    ts: row.ts,
    turnId: row.turn_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    agentId: row.agent_id,
    hostName: row.host_name ?? undefined,
    traceId: row.trace_id ?? undefined,
    spanId: row.span_id ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    intentHash: row.intent_hash,
    memoriesReturned: safeJsonArray(row.memories_returned_json),
    silentAb: row.silent_ab === 1,
    outcome: row.outcome ?? undefined,
    outcomeDetail: row.outcome_detail ?? undefined
  };
}

export function formatMemoryEvalReport(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    suite: row.suite,
    generatedAt: row.generated_at,
    passed: row.passed === 1,
    cases: safeJsonArray(row.cases_json),
    warnings: safeJsonArray(row.warnings_json),
    source: row.source
  };
}

export function formatEvent(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    ts: row.ts,
    eventType: row.event_type,
    sourceTable: row.source_table,
    sourceId: row.source_id,
    actorId: row.actor_id,
    host: row.host ?? undefined,
    traceId: row.trace_id ?? undefined,
    spanId: row.span_id ?? undefined,
    parentSpanId: row.parent_span_id ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    payload: safeJsonRecord(row.payload_json)
  };
}

export function formatAudit(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    ts: row.ts,
    action: row.action,
    sourceTable: row.source_table,
    sourceId: row.source_id,
    agentId: row.agent_id,
    hostName: row.host_name ?? undefined,
    payload: safeJsonRecord(row.redacted_payload_json),
    testMode: row.test_mode === 1
  };
}
