import { newId, stableHash } from "../ids.js";
import { FabricError } from "../runtime/errors.js";
import {
  asRecord,
  expandIntentString,
  getField,
  getOptionalBoolean,
  getOptionalNumber,
  getOptionalString,
  getRequiredStringArray,
  getString,
  getStringArray,
  intentKeysFromIntent,
  normalizeIntentKey,
  safeJsonArray
} from "../runtime/input.js";
import { formatMemory, formatMemoryEvalReport } from "../runtime/format.js";
import type { CallContext } from "../types.js";
import type { SurfaceHost } from "./host.js";

export function memoryWrite(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const type = getString(input, "type");
  const body = getString(input, "body");
  const intentKeys = getRequiredStringArray(input, "intent_keys").map(normalizeIntentKey);
  const refs = getStringArray(input, "refs");
  const source = getOptionalString(input, "source") ?? "auto";
  const derivation = getOptionalString(input, "derivation");
  const severity = getOptionalString(input, "severity") ?? "normal";
  const confidence = getOptionalNumber(input, "initialConfidence") ?? (source === "user" ? 0.8 : 0.5);
  const status = source === "user" || derivation === "explicit_user_text" || derivation === "structured_tool_outcome" ? "active" : "pending_review";
  const supersedes = getOptionalString(input, "supersedes");
  return host.recordMutation("memory_write", input, context, (session) => {
    const id = newId("mem");
    const recordedAt = host.now().toISOString();
    if (supersedes) {
      const previous = host.db.db
        .prepare("SELECT id, recorded_until FROM memories WHERE id = ? AND namespace = ?")
        .get(supersedes, session.workspace_root) as { id: string; recorded_until: string | null } | undefined;
      if (!previous) {
        throw new FabricError("MEMORY_NOT_FOUND", `Superseded memory not found: ${supersedes}`, false);
      }
      if (previous.recorded_until) {
        throw new FabricError("MEMORY_ALREADY_SUPERSEDED", `Memory is already superseded: ${supersedes}`, false);
      }
      host.db.db.prepare("UPDATE memories SET recorded_until = ? WHERE id = ?").run(recordedAt, supersedes);
    }
    host.db.db
      .prepare(
        "INSERT INTO memories (id, type, namespace, body, intent_keys_json, confidence, status, severity, refs_json, source, created_by_session_id, created_by_agent_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(id, type, session.workspace_root, body, JSON.stringify(intentKeys), confidence, status, severity, JSON.stringify(refs), source, session.id, session.agent_id, recordedAt);
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: status === "active" ? "memory.written" : "memory.quarantined",
      sourceTable: "memories",
      sourceId: id,
      eventType: status === "active" ? "memory.written" : "memory.quarantined",
      payload: { type, source, status, severity, refs, supersedes },
      testMode: session.test_mode === 1,
      context
    });
    return { action: "added", id, status, injectable: status === "active", conflicts: [], superseded: supersedes };
  });
}

export function memoryCheck(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const intent = asRecord(getField(input, "intent") ?? {});
  const types = getStringArray(input, "types");
  const maxHints = getOptionalNumber(input, "max_hints") ?? 2;
  const intentKeys = intentKeysFromIntent(intent);
  const candidateLimit = Math.min(250, Math.max(50, maxHints * 25));
  const where = ["namespace = ?", "archived = 0", "invalid_at IS NULL", "recorded_until IS NULL", "status = 'active'"];
  const params: Array<string | number> = [session.workspace_root];
  if (types.length) {
    where.push(`type IN (${types.map(() => "?").join(", ")})`);
    params.push(...types);
  }
  if (intentKeys.length) {
    where.push(`(${intentKeys.map(() => "intent_keys_json LIKE ? ESCAPE '\\'").join(" OR ")})`);
    params.push(...intentKeys.map((key) => `%${escapeLike(key)}%`));
  }
  const candidates = host.db.db
    .prepare(`SELECT * FROM memories WHERE ${where.join(" AND ")} ORDER BY confidence DESC, last_seen_at DESC LIMIT ?`)
    .all(...params, candidateLimit) as Record<string, unknown>[];
  const filtered = candidates.filter((memory) => {
    const keys = safeJsonArray(memory.intent_keys_json).flatMap((key) => expandIntentString(String(key)));
    return intentKeys.length === 0 || keys.some((key) => intentKeys.includes(key));
  });
  const hints = filtered.slice(0, maxHints).map((memory) => ({
    id: memory.id,
    type: memory.type,
    body: memory.body,
    confidence: memory.confidence,
    provenance: {
      source: memory.source,
      confirmedBy: JSON.parse(memory.confirmations_json as string),
      createdAt: memory.created_at,
      lastSeenAt: memory.last_seen_at
    },
    verifierStatus: "unverified",
    refs: JSON.parse(memory.refs_json as string)
  }));
  const injectionId = newId("inj");
  const intentHash = stableHash(intent);
  host.db.transaction(() => {
    host.db.db
      .prepare(
        "INSERT INTO memory_injections (id, turn_id, session_id, agent_id, host_name, namespace, trace_id, span_id, correlation_id, intent_hash, intent_payload_json, memories_returned_json, test_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        injectionId,
        context.turnId ?? null,
        session.id,
        session.agent_id,
        session.host_name,
        session.workspace_root,
        context.traceId ?? null,
        context.spanId ?? null,
        context.correlationId ?? null,
        intentHash,
        JSON.stringify(intent),
        JSON.stringify(hints.map((hint) => ({ id: hint.id, confidence: hint.confidence }))),
        session.test_mode
      );
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "memory.checked",
      sourceTable: "memory_injections",
      sourceId: injectionId,
      eventType: "memory.checked",
      payload: { intentHash, returned: hints.length },
      testMode: session.test_mode === 1,
      context
    });
  });
  return { hints, injectionId, traceId: context.traceId, correlationId: context.correlationId, silent_ab: false };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function normalizeReviewDecision(value: string): "approve" | "reject" | "archive" {
  if (value === "approve" || value === "reject" || value === "archive") {
    return value;
  }
  throw new FabricError("INVALID_MEMORY_REVIEW_DECISION", `Unsupported memory review decision: ${value}`, false);
}

export function memoryOutcome(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const injectionId = getString(input, "injectionId");
  const outcome = getString(input, "outcome");
  const detail = getOptionalString(input, "detail") ?? null;
  const injection = host.db.db
    .prepare("SELECT id, namespace FROM memory_injections WHERE id = ?")
    .get(injectionId) as { id: string; namespace: string } | undefined;
  if (!injection || injection.namespace !== session.workspace_root) {
    throw new FabricError("MEMORY_INJECTION_NOT_FOUND", `Memory injection not found: ${injectionId}`, false);
  }
  host.db.transaction(() => {
    host.db.db
      .prepare("UPDATE memory_injections SET outcome = ?, outcome_detail = ?, outcome_reported_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(outcome, detail, injectionId);
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "memory.outcome_reported",
      sourceTable: "memory_injections",
      sourceId: injectionId,
      eventType: "memory.outcome_reported",
      payload: { outcome },
      testMode: session.test_mode === 1,
      context
    });
  });
  return { ack: true };
}

export function memoryList(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const type = getOptionalString(input, "type");
  const status = getOptionalString(input, "status");
  const since = getOptionalString(input, "since");
  const archived = getOptionalBoolean(input, "archived") ?? false;
  const max = getOptionalNumber(input, "max") ?? 50;
  const params: Array<string | number> = [session.workspace_root, archived ? 1 : 0];
  let where = "namespace = ? AND archived = ?";
  if (type) {
    where += " AND type = ?";
    params.push(type);
  }
  if (status) {
    where += " AND status = ?";
    params.push(status);
  }
  if (since) {
    where += " AND created_at >= ?";
    params.push(since);
  }
  const rows = host.db.db
    .prepare(`SELECT * FROM memories WHERE ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, max) as Record<string, unknown>[];
  return { memories: rows.map(formatMemory), total: rows.length };
}

export function memoryReview(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const id = getString(input, "id");
  const decision = normalizeReviewDecision(getString(input, "decision"));
  const reason = getOptionalString(input, "reason");
  const evidence = getStringArray(input, "evidence");
  return host.recordMutation("memory_review", input, context, (session) => {
    const memory = host.db.db.prepare("SELECT * FROM memories WHERE id = ? AND namespace = ?").get(id, session.workspace_root) as
      | Record<string, unknown>
      | undefined;
    if (!memory) throw new FabricError("MEMORY_NOT_FOUND", `Memory not found: ${id}`, false);
    if (decision === "approve" && (memory.archived === 1 || memory.invalid_at || memory.recorded_until)) {
      throw new FabricError("MEMORY_NOT_REVIEWABLE", `Memory cannot be approved in its current state: ${id}`, false);
    }

    const previousStatus = String(memory.status);
    const now = host.now().toISOString();
    if (decision === "approve") {
      const confirmation = { agentId: session.agent_id, sessionId: session.id, evidence: reason ?? (evidence.join("; ") || "human review"), ts: now };
      const confirmations = [...safeJsonArray(memory.confirmations_json), confirmation];
      const confidence = Math.max(Number(memory.confidence ?? 0.5), 0.8);
      host.db.db
        .prepare("UPDATE memories SET status = 'active', confidence = ?, confirmations_json = ?, last_seen_at = ? WHERE id = ?")
        .run(confidence, JSON.stringify(confirmations), now, id);
    } else if (decision === "reject") {
      const contradiction = { agentId: session.agent_id, sessionId: session.id, reason: reason ?? "rejected during memory review", evidence, ts: now };
      const contradictions = [...safeJsonArray(memory.contradictions_json), contradiction];
      host.db.db
        .prepare("UPDATE memories SET status = 'archived', archived = 1, invalid_at = ?, confidence = 0, contradictions_json = ?, last_seen_at = ? WHERE id = ?")
        .run(now, JSON.stringify(contradictions), now, id);
    } else {
      host.db.db.prepare("UPDATE memories SET status = 'archived', archived = 1, last_seen_at = ? WHERE id = ?").run(now, id);
    }

    const updated = host.db.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Record<string, unknown>;
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: `memory.review.${decision}`,
      sourceTable: "memories",
      sourceId: id,
      eventType: `memory.review.${decision}`,
      payload: { id, decision, previousStatus, status: updated.status, reason, evidence },
      testMode: session.test_mode === 1,
      context
    });
    return { id, decision, previousStatus, status: updated.status, memory: formatMemory(updated) };
  });
}

export function memoryAuditLift(host: SurfaceHost, _input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const rows = host.db.db.prepare("SELECT outcome, silent_ab FROM memory_injections WHERE namespace = ? AND outcome IS NOT NULL").all(
    session.workspace_root
  ) as { outcome: string; silent_ab: 0 | 1 }[];
  const withRows = rows.filter((row) => row.silent_ab === 0);
  const withoutRows = rows.filter((row) => row.silent_ab === 1);
  const success = (items: typeof rows) => (items.length ? items.filter((item) => item.outcome === "success").length / items.length : 0);
  return {
    windowDays: 30,
    successWithMemory: success(withRows),
    successWithoutMemory: success(withoutRows),
    liftPct: (success(withRows) - success(withoutRows)) * 100,
    nWith: withRows.length,
    nWithout: withoutRows.length,
    outcomeCoveragePct: rows.length === 0 ? 0 : 100,
    outcomeCoverageByAgent: { [session.agent_id]: rows.length === 0 ? 0 : 100 },
    outcomeCoverageByHost: { [session.host_name]: rows.length === 0 ? 0 : 100 },
    perTypeLift: {},
    warnings: withoutRows.length < 30 ? ["n_without < 30; weak signal"] : []
  };
}

export function memoryInvalidate(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const id = getString(input, "id");
  const reason = getString(input, "reason");
  const evidence = getStringArray(input, "evidence");
  return host.recordMutation("memory_invalidate", input, context, (session) => {
    const memory = host.db.db.prepare("SELECT * FROM memories WHERE id = ? AND namespace = ?").get(id, session.workspace_root) as
      | Record<string, unknown>
      | undefined;
    if (!memory) throw new FabricError("MEMORY_NOT_FOUND", `Memory not found: ${id}`, false);
    const previousConfidence = Number(memory.confidence ?? 0);
    const contradiction = { agentId: session.agent_id, sessionId: session.id, reason, evidence, ts: host.now().toISOString() };
    const contradictions = [...safeJsonArray(memory.contradictions_json), contradiction];
    host.db.db
      .prepare("UPDATE memories SET invalid_at = CURRENT_TIMESTAMP, confidence = 0, contradictions_json = ? WHERE id = ?")
      .run(JSON.stringify(contradictions), id);
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "memory.invalidated",
      sourceTable: "memories",
      sourceId: id,
      eventType: "memory.invalidated",
      payload: { id, reason, evidence },
      testMode: session.test_mode === 1,
      context
    });
    return { ack: true, previousConfidence };
  });
}

export function memoryConfirm(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const id = getString(input, "id");
  const evidence = getOptionalString(input, "evidence");
  return host.recordMutation("memory_confirm", input, context, (session) => {
    const memory = host.db.db.prepare("SELECT * FROM memories WHERE id = ? AND namespace = ?").get(id, session.workspace_root) as
      | Record<string, unknown>
      | undefined;
    if (!memory) throw new FabricError("MEMORY_NOT_FOUND", `Memory not found: ${id}`, false);
    if (memory.invalid_at) throw new FabricError("MEMORY_INVALID", `Memory is invalidated: ${id}`, false);
    const confirmation = { agentId: session.agent_id, sessionId: session.id, evidence, ts: host.now().toISOString() };
    const confirmations = [...safeJsonArray(memory.confirmations_json), confirmation];
    const newConfidence = Math.min(1, Number(memory.confidence ?? 0.5) + 0.1);
    const uniqueAgents = new Set(confirmations.map((item) => String(asRecord(item).agentId)).filter(Boolean));
    const shouldPromote = memory.status === "pending_review" && newConfidence >= 0.7 && uniqueAgents.size >= 2;
    const status = shouldPromote ? "active" : String(memory.status);
    host.db.db
      .prepare("UPDATE memories SET confidence = ?, confirmations_json = ?, status = ?, last_seen_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(newConfidence, JSON.stringify(confirmations), status, id);
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: shouldPromote ? "memory.confirmed_and_promoted" : "memory.confirmed",
      sourceTable: "memories",
      sourceId: id,
      eventType: shouldPromote ? "memory.confirmed_and_promoted" : "memory.confirmed",
      payload: { id, evidence, newConfidence, confirmationCount: confirmations.length, status },
      testMode: session.test_mode === 1,
      context
    });
    return { newConfidence, confirmationCount: confirmations.length, status };
  });
}

export function memoryEvalReport(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  host.requireSession(context);
  const suite = getOptionalString(input, "suite") ?? "memory-v1";
  const since = getOptionalString(input, "since");
  const rows = since
    ? (host.db.db
        .prepare("SELECT * FROM memory_eval_reports WHERE suite = ? AND generated_at >= ? ORDER BY generated_at DESC")
        .all(suite, since) as Record<string, unknown>[])
    : (host.db.db
        .prepare("SELECT * FROM memory_eval_reports WHERE suite = ? ORDER BY generated_at DESC LIMIT 1")
        .all(suite) as Record<string, unknown>[]);
  if (rows.length === 0) {
    return {
      suite,
      generatedAt: host.now().toISOString(),
      passed: false,
      cases: [],
      warnings: ["no paired eval report has been recorded for this suite"]
    };
  }
  const latest = rows[0];
  return {
    suite,
    generatedAt: latest.generated_at,
    passed: latest.passed === 1,
    cases: safeJsonArray(latest.cases_json),
    warnings: safeJsonArray(latest.warnings_json),
    reports: rows.map(formatMemoryEvalReport)
  };
}
