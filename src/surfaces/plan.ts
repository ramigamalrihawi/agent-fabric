import { newId } from "../ids.js";
import { FabricError } from "../runtime/errors.js";
import {
  asRecord,
  getArray,
  getField,
  getOptionalBoolean,
  getOptionalNumber,
  getOptionalString,
  getString,
  intentKeysFromIntent,
  safeJsonArray,
  safeJsonRecord
} from "../runtime/input.js";
import type { CallContext } from "../types.js";
import type { SurfaceHost } from "./host.js";

type ChainRow = {
  id: string;
  task: string;
  models_json: string;
  workspace_root: string;
  state: string;
  round: number;
  max_rounds: number;
  budget_usd: number;
  total_spent_usd: number;
  output_format: string;
  show_lineage_to_a: 0 | 1;
  halt_reason: string | null;
  final_memory_id: string | null;
  session_id: string;
};

const PLAN_TABLES = ["plan_chains", "plan_revisions", "plan_critiques", "plan_questions"];
const HARD_HALT_REASONS = new Set(["a_signoff", "budget", "converged", "max_rounds"]);

export function planChainStart(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const task = getString(input, "task");
  const models = parseModels(input);
  const maxRounds = getOptionalNumber(input, "maxRounds") ?? 3;
  const budgetUsd = getOptionalNumber(input, "budgetUsd") ?? 5;
  const outputFormat = getOptionalString(input, "outputFormat") ?? "markdown";
  const showLineageToA = getOptionalBoolean(input, "showLineageToA") ?? false;
  if (!Number.isInteger(maxRounds) || maxRounds <= 0) {
    throw new FabricError("INVALID_INPUT", "maxRounds must be a positive integer", false);
  }
  if (budgetUsd <= 0) {
    throw new FabricError("INVALID_INPUT", "budgetUsd must be positive", false);
  }

  return host.recordMutation("plan_chain_start", input, context, (session) => {
    const chainId = newId("chain");
    host.db.db
      .prepare(
        `INSERT INTO plan_chains (
          id, task, models_json, workspace_root, state, round, max_rounds, budget_usd,
          output_format, show_lineage_to_a, origin_peer_id, session_id
        ) VALUES (?, ?, ?, ?, 'drafting_a', 1, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        chainId,
        task,
        JSON.stringify(models),
        session.workspace_root,
        maxRounds,
        budgetUsd,
        outputFormat,
        showLineageToA ? 1 : 0,
        host.originPeerId,
        session.id
      );
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "plan.chain.started",
      sourceTable: "plan_chains",
      sourceId: chainId,
      eventType: "plan.chain.started",
      payload: { taskPreview: task.slice(0, 160), models, maxRounds, budgetUsd, outputFormat },
      testMode: session.test_mode === 1,
      context
    });
    return { chainId, round: 1, status: "drafting_a" };
  });
}

export function planChainStatus(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const chain = requireChain(host, getString(input, "chainId"), session.workspace_root);
  return buildStatus(host, chain);
}

export function planChainRecordRevision(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const chainId = getString(input, "chainId");
  const step = getString(input, "step");
  const body = getString(input, "body");
  const confidence = getOptionalNumber(input, "confidence");
  const costUsd = getOptionalNumber(input, "costUsd") ?? 0;
  const questionRecipient = getOptionalString(input, "questionRecipient") ?? "*";
  const traceId = getOptionalString(input, "traceId") ?? context.traceId ?? null;
  if (costUsd < 0) {
    throw new FabricError("INVALID_INPUT", "costUsd must be non-negative", false);
  }

  if (!["a_draft", "b_improve", "c_improve"].includes(step)) {
    throw new FabricError("INVALID_INPUT", `Invalid plan revision step: ${step}`, false);
  }

  return host.recordMutation("plan_chain_record_revision", input, context, (session) => {
    const chain = requireChain(host, chainId, session.workspace_root);
    ensureChainCanProgress(chain);
    const expectedState = expectedStateForStep(step);
    if (chain.state !== expectedState) {
      throw new FabricError("PLAN_CHAIN_STATE_CONFLICT", `Cannot record ${step} while chain ${chainId} is ${chain.state}`, false);
    }
    const models = safeJsonRecord(chain.models_json);
    const model = getOptionalString(input, "model") ?? modelForStep(step, models);
    const round = getOptionalNumber(input, "round") ?? chain.round;
    if (round !== chain.round) {
      throw new FabricError("PLAN_CHAIN_STATE_CONFLICT", `Cannot record round ${round}; chain ${chainId} is on round ${chain.round}`, false);
    }
    const revisionId = newId("prev");
    const questions = parseQuestions(input);
    const hasBlockingQuestion = questions.some((question) => question.severity === "blocking");

    host.db.db
      .prepare(
        `INSERT INTO plan_revisions (
          id, chain_id, round, step, model, body, change_log_json, confidence,
          least_confident_about_json, cost_usd, trace_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        revisionId,
        chainId,
        round,
        step,
        model,
        body,
        stringifyOptional(getField(input, "changeLog") ?? getField(input, "change_log")),
        confidence ?? null,
        stringifyOptional(getField(input, "leastConfidentAbout") ?? getField(input, "least_confident_about")),
        costUsd,
        traceId
      );

    for (const question of questions) {
      const collabAskId = question.severity === "blocking" ? createBlockingAsk(host, session, chain, questionRecipient, question.body, context) : null;
      host.db.db
        .prepare(
          `INSERT INTO plan_questions (
            id, chain_id, raised_at_step, raised_by_model, severity, body, collab_ask_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(newId("pq"), chainId, step, model, question.severity, question.body, collabAskId);
    }

    const totalAfter = Number(chain.total_spent_usd ?? 0) + costUsd;
    const haltReason = revisionHaltReason(host, chain, step, body, totalAfter);
    const nextState = hasBlockingQuestion || haltReason ? "awaiting_user" : nextStateAfterRevision(step);
    host.db.db
      .prepare("UPDATE plan_chains SET state = ?, halt_reason = ?, total_spent_usd = total_spent_usd + ? WHERE id = ?")
      .run(nextState, haltReason, costUsd, chainId);
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "plan.chain.revision_recorded",
      sourceTable: "plan_revisions",
      sourceId: revisionId,
      eventType: "plan.chain.revision_recorded",
      payload: { chainId, round, step, model, costUsd, questions: questions.length, nextState, haltReason },
      testMode: session.test_mode === 1,
      context
    });
    return { revisionId, chainId, round, step, state: nextState, haltReason: haltReason ?? undefined, questionsRaised: questions.length };
  });
}

export function planChainRecordCritique(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const chainId = getString(input, "chainId");
  const body = getString(input, "body");
  const structured = asRecord(getField(input, "structured"));
  if (Object.keys(structured).length === 0) {
    throw new FabricError("INVALID_INPUT", "Expected structured critique object", false);
  }
  const costUsd = getOptionalNumber(input, "costUsd") ?? 0;
  const traceId = getOptionalString(input, "traceId") ?? context.traceId ?? null;
  if (costUsd < 0) {
    throw new FabricError("INVALID_INPUT", "costUsd must be non-negative", false);
  }

  return host.recordMutation("plan_chain_record_critique", input, context, (session) => {
    const chain = requireChain(host, chainId, session.workspace_root);
    ensureChainCanProgress(chain);
    if (chain.state !== "critiquing_a") {
      throw new FabricError("PLAN_CHAIN_STATE_CONFLICT", `Cannot record critique while chain ${chainId} is ${chain.state}`, false);
    }
    const round = getOptionalNumber(input, "round") ?? chain.round;
    if (round !== chain.round) {
      throw new FabricError("PLAN_CHAIN_STATE_CONFLICT", `Cannot record round ${round}; chain ${chainId} is on round ${chain.round}`, false);
    }
    const reviewingRevisionId = getOptionalString(input, "reviewingRevisionId") ?? latestRevisionId(host, chainId, round);
    if (!reviewingRevisionId) {
      throw new FabricError("PLAN_REVISION_NOT_FOUND", `No revision found for chain ${chainId} round ${round}`, false);
    }
    const critiqueId = newId("pcrit");
    const model = getOptionalString(input, "model") ?? String(safeJsonRecord(chain.models_json).a ?? "plan.strong");
    const wouldSignOff = structured.wouldSignOff === true || structured.would_sign_off === true;
    const totalAfter = Number(chain.total_spent_usd ?? 0) + costUsd;
    const haltReason = wouldSignOff ? "a_signoff" : totalAfter > Number(chain.budget_usd ?? 0) ? "budget" : null;
    host.db.db
      .prepare(
        `INSERT INTO plan_critiques (
          id, chain_id, round, reviewing_revision_id, structured_json, body, model, cost_usd, trace_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(critiqueId, chainId, round, reviewingRevisionId, JSON.stringify(structured), body, model, costUsd, traceId);
    host.db.db
      .prepare("UPDATE plan_chains SET state = 'awaiting_user', halt_reason = ?, total_spent_usd = total_spent_usd + ? WHERE id = ?")
      .run(haltReason, costUsd, chainId);
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "plan.chain.critique_recorded",
      sourceTable: "plan_critiques",
      sourceId: critiqueId,
      eventType: "plan.chain.critique_recorded",
      payload: { chainId, round, model, reviewingRevisionId, wouldSignOff, costUsd },
      testMode: session.test_mode === 1,
      context
    });
    return { critiqueId, chainId, round, state: "awaiting_user", haltReason };
  });
}

export function planChainAnswerQuestion(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const questionId = getString(input, "questionId");
  const answer = getString(input, "answer");

  return host.recordMutation("plan_chain_answer_question", input, context, (session) => {
    const row = host.db.db
      .prepare(
        `SELECT q.*, c.workspace_root, c.state
        FROM plan_questions q
        JOIN plan_chains c ON c.id = q.chain_id
        WHERE q.id = ?`
      )
      .get(questionId) as (Record<string, unknown> & { chain_id: string; workspace_root: string; state: string; collab_ask_id: string | null }) | undefined;
    if (!row || row.workspace_root !== session.workspace_root) {
      throw new FabricError("PLAN_QUESTION_NOT_FOUND", `Plan question not found: ${questionId}`, false);
    }
    host.db.db
      .prepare("UPDATE plan_questions SET answer = ?, answered_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(answer, questionId);
    if (row.collab_ask_id) {
      host.db.db.prepare("UPDATE asks SET status = 'answered', ts_updated = CURRENT_TIMESTAMP WHERE id = ?").run(row.collab_ask_id);
      host.db.db.prepare("UPDATE tasks SET status = 'completed', ts_updated = CURRENT_TIMESTAMP WHERE id = (SELECT task_id FROM asks WHERE id = ?)").run(row.collab_ask_id);
    }
    const unanswered = host.db.db
      .prepare("SELECT COUNT(*) AS count FROM plan_questions WHERE chain_id = ? AND severity = 'blocking' AND answered_at IS NULL")
      .get(row.chain_id) as { count: number };
    let state = row.state;
    if (row.state === "awaiting_user" && unanswered.count === 0) {
      const latest = latestRevision(host, row.chain_id);
      state = latest ? nextStateAfterRevision(String(latest.step)) : row.state;
      host.db.db.prepare("UPDATE plan_chains SET state = ? WHERE id = ?").run(state, row.chain_id);
    }
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "plan.chain.question_answered",
      sourceTable: "plan_questions",
      sourceId: questionId,
      eventType: "plan.chain.question_answered",
      payload: { chainId: row.chain_id, state },
      testMode: session.test_mode === 1,
      context
    });
    return { questionId, chainId: row.chain_id, state, unansweredBlockingQuestions: unanswered.count };
  });
}

export function planChainDecide(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const chainId = getString(input, "chainId");
  const decision = getString(input, "decision");
  const writeMemory = getOptionalBoolean(input, "writeMemory") ?? true;

  if (!["accept", "abandon", "another_round"].includes(decision)) {
    throw new FabricError("INVALID_INPUT", `Invalid plan-chain decision: ${decision}`, false);
  }

  return host.recordMutation("plan_chain_decide", input, context, (session) => {
    const chain = requireChain(host, chainId, session.workspace_root);
    if (isTerminalState(chain.state)) {
      throw new FabricError("PLAN_CHAIN_TERMINAL", `Chain ${chainId} is already ${chain.state}`, false);
    }
    if (decision === "another_round") {
      if (chain.halt_reason && HARD_HALT_REASONS.has(chain.halt_reason)) {
        throw new FabricError("PLAN_CHAIN_HALTED", `Chain ${chainId} halted with reason ${chain.halt_reason}`, false);
      }
      if (chain.round >= chain.max_rounds) {
        throw new FabricError("PLAN_CHAIN_MAX_ROUNDS", `Chain ${chainId} already reached maxRounds`, false);
      }
      const nextRound = chain.round + 1;
      host.db.db
        .prepare("UPDATE plan_chains SET round = ?, state = 'drafting_b', halt_reason = NULL WHERE id = ?")
        .run(nextRound, chainId);
      return { chainId, round: nextRound, state: "drafting_b", costSummary: costSummary(chain) };
    }

    if (decision === "abandon") {
      host.db.db
        .prepare("UPDATE plan_chains SET state = 'abandoned', halt_reason = 'user_abandoned', ts_ended = CURRENT_TIMESTAMP WHERE id = ?")
        .run(chainId);
      return { chainId, haltReason: "user_abandoned", costSummary: costSummary(chain) };
    }

    const acceptedPlan = latestPlanBody(host, chainId);
    let memoryWritten: Record<string, unknown> | undefined;
    let finalMemoryId: string | null = null;
    if (writeMemory && acceptedPlan) {
      finalMemoryId = newId("mem");
      const intentKeys = intentKeysFromIntent({ task: chain.task }).slice(0, 20);
      host.db.db
        .prepare(
          `INSERT INTO memories (
            id, type, namespace, body, intent_keys_json, confidence, status, severity,
            refs_json, source, created_by_session_id, created_by_agent_id, recorded_at
          ) VALUES (?, 'procedural', ?, ?, ?, 0.8, 'pending_review', 'normal', ?, 'user-confirmed-plan', ?, ?, ?)`
        )
        .run(
          finalMemoryId,
          session.workspace_root,
          acceptedPlan,
          JSON.stringify(intentKeys.length ? intentKeys : ["plan-chain"]),
          JSON.stringify([`plan_chain:${chainId}`]),
          session.id,
          session.agent_id,
          host.now().toISOString()
        );
      memoryWritten = { id: finalMemoryId, status: "pending_review" };
    }
    host.db.db
      .prepare(
        "UPDATE plan_chains SET state = 'accepted', halt_reason = 'user_accepted', ts_ended = CURRENT_TIMESTAMP, final_memory_id = ? WHERE id = ?"
      )
      .run(finalMemoryId, chainId);
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "plan.chain.decided",
      sourceTable: "plan_chains",
      sourceId: chainId,
      eventType: "plan.chain.decided",
      payload: { chainId, decision, finalMemoryId },
      testMode: session.test_mode === 1,
      context
    });
    return { chainId, finalPlanRef: finalMemoryId ?? undefined, costSummary: costSummary(chain), memoryWritten };
  });
}

export function planChainExplain(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const chain = requireChain(host, getString(input, "chainId"), session.workspace_root);
  const sourceIds = collectPlanSourceIds(host, chain.id);
  const placeholders = sourceIds.map(() => "?").join(", ");
  const events = sourceIds.length
    ? host.db.db
        .prepare(`SELECT * FROM events WHERE source_table IN (${PLAN_TABLES.map(() => "?").join(", ")}) AND source_id IN (${placeholders}) ORDER BY ts`)
        .all(...PLAN_TABLES, ...sourceIds)
    : [];
  const audit = sourceIds.length
    ? host.db.db
        .prepare(`SELECT * FROM audit WHERE source_table IN (${PLAN_TABLES.map(() => "?").join(", ")}) AND source_id IN (${placeholders}) ORDER BY ts`)
        .all(...PLAN_TABLES, ...sourceIds)
    : [];
  return {
    status: buildStatus(host, chain),
    sourceIds,
    events: (events as Record<string, unknown>[]).map((row) => ({
      id: row.id,
      ts: row.ts,
      eventType: row.event_type,
      sourceTable: row.source_table,
      sourceId: row.source_id,
      payload: safeJsonRecord(row.payload_json)
    })),
    audit: (audit as Record<string, unknown>[]).map((row) => ({
      id: row.id,
      ts: row.ts,
      action: row.action,
      sourceTable: row.source_table,
      sourceId: row.source_id,
      payload: safeJsonRecord(row.redacted_payload_json)
    }))
  };
}

function requireChain(host: SurfaceHost, chainId: string, workspaceRoot: string): ChainRow {
  const chain = host.db.db.prepare("SELECT * FROM plan_chains WHERE id = ? AND workspace_root = ?").get(chainId, workspaceRoot) as ChainRow | undefined;
  if (!chain) throw new FabricError("PLAN_CHAIN_NOT_FOUND", `Plan chain not found: ${chainId}`, false);
  return chain;
}

function buildStatus(host: SurfaceHost, chain: ChainRow): Record<string, unknown> {
  const revisions = host.db.db
    .prepare("SELECT * FROM plan_revisions WHERE chain_id = ? ORDER BY round ASC, ts ASC")
    .all(chain.id) as Record<string, unknown>[];
  const critiques = host.db.db
    .prepare("SELECT * FROM plan_critiques WHERE chain_id = ? ORDER BY round ASC, ts ASC")
    .all(chain.id) as Record<string, unknown>[];
  const questions = host.db.db
    .prepare("SELECT * FROM plan_questions WHERE chain_id = ? ORDER BY ts ASC")
    .all(chain.id) as Record<string, unknown>[];
  return {
    chainId: chain.id,
    task: chain.task,
    models: safeJsonRecord(chain.models_json),
    round: chain.round,
    state: chain.state,
    maxRounds: chain.max_rounds,
    budgetUsd: chain.budget_usd,
    outputFormat: chain.output_format,
    showLineageToA: chain.show_lineage_to_a === 1,
    drafts: revisions.map(formatRevision),
    critiques: critiques.map(formatCritique),
    pendingQuestions: questions.filter((row) => !row.answered_at).map(formatQuestion),
    questions: questions.map(formatQuestion),
    totalSpentUsd: Number(chain.total_spent_usd ?? 0),
    haltReason: chain.halt_reason ?? undefined,
    finalMemoryId: chain.final_memory_id ?? undefined
  };
}

function parseModels(input: unknown): Record<string, string> {
  const raw = asRecord(getField(input, "models"));
  return {
    a: typeof raw.a === "string" ? raw.a : "plan.strong",
    b: typeof raw.b === "string" ? raw.b : "improve.cheap",
    c: typeof raw.c === "string" ? raw.c : "improve.cheap"
  };
}

function modelForStep(step: string, models: Record<string, unknown>): string {
  if (step === "a_draft") return String(models.a ?? "plan.strong");
  if (step === "b_improve") return String(models.b ?? "improve.cheap");
  return String(models.c ?? "improve.cheap");
}

function expectedStateForStep(step: string): string {
  if (step === "a_draft") return "drafting_a";
  if (step === "b_improve") return "drafting_b";
  return "drafting_c";
}

function nextStateAfterRevision(step: string): string {
  if (step === "a_draft") return "drafting_b";
  if (step === "b_improve") return "drafting_c";
  if (step === "c_improve") return "critiquing_a";
  return "awaiting_user";
}

function ensureChainCanProgress(chain: ChainRow): void {
  if (isTerminalState(chain.state)) {
    throw new FabricError("PLAN_CHAIN_TERMINAL", `Chain ${chain.id} is already ${chain.state}`, false);
  }
  if (chain.halt_reason && HARD_HALT_REASONS.has(chain.halt_reason)) {
    throw new FabricError("PLAN_CHAIN_HALTED", `Chain ${chain.id} halted with reason ${chain.halt_reason}`, false);
  }
}

function isTerminalState(state: string): boolean {
  return state === "accepted" || state === "abandoned";
}

function revisionHaltReason(host: SurfaceHost, chain: ChainRow, step: string, body: string, totalAfter: number): string | null {
  if (totalAfter > Number(chain.budget_usd ?? 0)) return "budget";
  if (step !== "c_improve" || chain.round <= 1) return null;
  const previous = previousPlanBody(host, chain.id, chain.round, "c_improve");
  if (!previous) return null;
  return normalizedLevenshteinDifference(previous, body) < 0.05 ? "converged" : null;
}

function stringifyOptional(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function parseQuestions(input: unknown): { severity: "blocking" | "preference"; body: string }[] {
  const raw = getArray({ values: getField(input, "questionsForUser") ?? getField(input, "questions_for_user") ?? [] }, "values");
  return raw.map((item) => {
    const record = asRecord(item);
    const body = typeof record.body === "string" ? record.body : typeof record.question === "string" ? record.question : "";
    if (!body) throw new FabricError("INVALID_INPUT", "Plan question requires body", false);
    const severity = record.severity === "blocking" ? "blocking" : "preference";
    return { severity, body };
  });
}

function createBlockingAsk(
  host: SurfaceHost,
  session: { id: string; agent_id: string; workspace_root: string },
  chain: ChainRow,
  recipient: string,
  question: string,
  context: CallContext
): string {
  const askId = newId("ask");
  const taskId = newId("task");
  const correlationId = context.correlationId ?? newId("corr");
  const refs = JSON.stringify([`plan_chain:${chain.id}`]);
  host.db.db
    .prepare(
      "INSERT INTO tasks (id, requester_agent_id, assignee, kind, status, correlation_id, refs_json, artifacts_json, workspace_root) VALUES (?, ?, ?, 'decision', 'submitted', ?, ?, '[]', ?)"
    )
    .run(taskId, session.agent_id, recipient, correlationId, refs, session.workspace_root);
  host.db.db
    .prepare(
      "INSERT INTO asks (id, task_id, asker_agent_id, recipient, kind, urgency, status, question, refs_json, workspace_root, correlation_id) VALUES (?, ?, ?, ?, 'decision', 'normal', 'open', ?, ?, ?, ?)"
    )
    .run(askId, taskId, session.agent_id, recipient, question, refs, session.workspace_root, correlationId);
  return askId;
}

function latestRevisionId(host: SurfaceHost, chainId: string, round: number): string | undefined {
  return (host.db.db
    .prepare("SELECT id FROM plan_revisions WHERE chain_id = ? AND round = ? ORDER BY CASE step WHEN 'c_improve' THEN 0 WHEN 'b_improve' THEN 1 ELSE 2 END, ts DESC LIMIT 1")
    .get(chainId, round) as { id: string } | undefined)?.id;
}

function latestRevision(host: SurfaceHost, chainId: string): Record<string, unknown> | undefined {
  return host.db.db.prepare("SELECT * FROM plan_revisions WHERE chain_id = ? ORDER BY round DESC, ts DESC LIMIT 1").get(chainId) as
    | Record<string, unknown>
    | undefined;
}

function latestPlanBody(host: SurfaceHost, chainId: string): string | undefined {
  const row = host.db.db
    .prepare("SELECT body FROM plan_revisions WHERE chain_id = ? ORDER BY round DESC, CASE step WHEN 'c_improve' THEN 0 WHEN 'b_improve' THEN 1 ELSE 2 END, ts DESC LIMIT 1")
    .get(chainId) as { body: string } | undefined;
  return row?.body;
}

function previousPlanBody(host: SurfaceHost, chainId: string, currentRound: number, step: string): string | undefined {
  const row = host.db.db
    .prepare("SELECT body FROM plan_revisions WHERE chain_id = ? AND round < ? AND step = ? ORDER BY round DESC, ts DESC LIMIT 1")
    .get(chainId, currentRound, step) as { body: string } | undefined;
  return row?.body;
}

function costSummary(chain: ChainRow): Record<string, number> {
  return {
    totalSpentUsd: Number(chain.total_spent_usd ?? 0),
    budgetUsd: Number(chain.budget_usd ?? 0),
    remainingUsd: Number((Number(chain.budget_usd ?? 0) - Number(chain.total_spent_usd ?? 0)).toFixed(6))
  };
}

function collectPlanSourceIds(host: SurfaceHost, chainId: string): string[] {
  const ids = [chainId];
  for (const table of ["plan_revisions", "plan_critiques", "plan_questions"]) {
    const rows = host.db.db.prepare(`SELECT id FROM ${table} WHERE chain_id = ?`).all(chainId) as { id: string }[];
    ids.push(...rows.map((row) => row.id));
  }
  return ids;
}

function normalizedLevenshteinDifference(left: string, right: string): number {
  if (left === right) return 0;
  const maxLength = Math.max(left.length, right.length);
  if (maxLength === 0) return 0;
  // Avoid quadratic surprises on very large plans. If plans are huge, the
  // orchestrator should use semantic or chunked convergence outside the daemon.
  if (maxLength > 12_000) return 1;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + substitutionCost
      );
    }
    previous = current;
  }
  return previous[right.length] / maxLength;
}

function formatRevision(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    round: row.round,
    step: row.step,
    model: row.model,
    body: row.body,
    changeLog: row.change_log_json ? safeJsonRecord(row.change_log_json) : undefined,
    confidence: row.confidence ?? undefined,
    leastConfidentAbout: row.least_confident_about_json ? safeJsonArray(row.least_confident_about_json) : undefined,
    costUsd: row.cost_usd ?? undefined,
    traceId: row.trace_id ?? undefined,
    ts: row.ts
  };
}

function formatCritique(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    round: row.round,
    reviewingRevisionId: row.reviewing_revision_id,
    structured: safeJsonRecord(row.structured_json),
    body: row.body,
    model: row.model ?? undefined,
    costUsd: row.cost_usd ?? undefined,
    traceId: row.trace_id ?? undefined,
    ts: row.ts
  };
}

function formatQuestion(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    questionId: row.id,
    raisedAtStep: row.raised_at_step,
    raisedByModel: row.raised_by_model,
    severity: row.severity,
    body: row.body,
    collabAskId: row.collab_ask_id ?? undefined,
    answeredAt: row.answered_at ?? undefined,
    answer: row.answer ?? undefined,
    ts: row.ts
  };
}
