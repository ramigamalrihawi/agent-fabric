import { newId, stableHash } from "../ids.js";
import { FabricError } from "../runtime/errors.js";
import {
  getArray,
  getOptionalNumber,
  getOptionalString,
  getRequiredStringArray,
  getString,
  getStringArray
} from "../runtime/input.js";
import { formatAsk, formatClaim, formatMessage } from "../runtime/format.js";
import { activeClaimConflicts, countWhere } from "../runtime/queries.js";
import type { CallContext } from "../types.js";
import type { SurfaceHost } from "./host.js";

export function collabSend(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const body = getString(input, "body");
  const to = getString(input, "to");
  const refs = getStringArray(input, "refs");
  const kind = getOptionalString(input, "kind") ?? (to === "*" ? "broadcast" : "dm");

  if (!context.idempotencyKey) {
    throw new FabricError("MISSING_IDEMPOTENCY_KEY", "Mutation requires an idempotency key", false);
  }

  const idempotencyKey = context.idempotencyKey;
  const session = host.requireSession(context);
  const payloadHash = stableHash(input);
  const lookup = (): { payload_hash: string; result_json: string } | undefined =>
    host.db.db
      .prepare("SELECT payload_hash, result_json FROM idempotency_keys WHERE session_id = ? AND tool = ? AND idempotency_key = ?")
      .get(session.id, "collab_send", idempotencyKey) as { payload_hash: string; result_json: string } | undefined;

  const earlyHit = lookup();
  if (earlyHit) {
    return assertReplayMatch(earlyHit, payloadHash) as Record<string, unknown>;
  }

  const mutation = host.db.transaction<CollabSendMutation>(() => {
    const innerHit = lookup();
    if (innerHit) {
      return { replayed: true, result: assertReplayMatch(innerHit, payloadHash) as Record<string, unknown> };
    }

    const messageId = newId("msg");
    const correlationId = context.correlationId ?? newId("corr");
    const recipient = to === "*" ? "*" : to;
    host.db.db
      .prepare(
        `INSERT INTO messages (
          id, sender_agent_id, session_id, origin_peer_id, workspace_root, recipient,
          kind, body, refs_json, correlation_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        messageId,
        session.agent_id,
        session.id,
        host.originPeerId,
        session.workspace_root,
        recipient,
        kind,
        body,
        JSON.stringify(refs),
        correlationId
      );
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "collab.message.sent",
      sourceTable: "messages",
      sourceId: messageId,
      eventType: "collab.message.sent",
      payload: { to, kind, refs, bodyPreview: body.slice(0, 120) },
      testMode: session.test_mode === 1,
      context: { ...context, correlationId }
    });
    host.exportCollabView(session.workspace_root);
    const messageRow = host.db.db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as Record<string, unknown>;
    const baseResult = {
      messageId,
      ts: messageRow.ts,
      mode: "async-only" as const,
      fanoutAttempted: false,
      fanoutAckedCount: 0
    };
    host.db.db
      .prepare("INSERT INTO idempotency_keys (session_id, tool, idempotency_key, payload_hash, result_json) VALUES (?, ?, ?, ?, ?)")
      .run(session.id, "collab_send", idempotencyKey, payloadHash, JSON.stringify(baseResult));
    return {
      replayed: false,
      result: baseResult,
      sessionId: session.id,
      idempotencyKey,
      payloadHash,
      messageId,
      recipient,
      payload: {
        workspaceRoot: session.workspace_root,
        message: formatMessage(messageRow)
      }
    };
  });

  if (mutation.replayed) {
    return mutation.result;
  }

  let fanoutResult = { acked: 0, attempted: 0 };
  try {
    fanoutResult = host.fanout.publish(mutation.messageId, mutation.recipient, mutation.payload);
  } catch {
    fanoutResult = { acked: 0, attempted: 0 };
  }

  const result = {
    ...mutation.result,
    mode: fanoutResult.acked > 0 ? ("live" as const) : ("async-only" as const),
    fanoutAttempted: fanoutResult.attempted > 0,
    fanoutAckedCount: fanoutResult.acked
  };

  if (fanoutResult.attempted > 0 || fanoutResult.acked > 0) {
    try {
      host.db.db
        .prepare(
          "UPDATE idempotency_keys SET result_json = ? WHERE session_id = ? AND tool = ? AND idempotency_key = ? AND payload_hash = ?"
        )
        .run(JSON.stringify(result), mutation.sessionId, "collab_send", mutation.idempotencyKey, mutation.payloadHash);
    } catch {
      // Fan-out is best-effort metadata. The durable message and base
      // idempotency result already committed before live delivery was tried.
    }
  }

  return result;
}

type CollabSendMutation =
  | { replayed: true; result: Record<string, unknown> }
  | {
      replayed: false;
      result: Record<string, unknown>;
      sessionId: string;
      idempotencyKey: string;
      payloadHash: string;
      messageId: string;
      recipient: string;
      payload: { workspaceRoot: string; message: Record<string, unknown> };
    };

function assertReplayMatch(hit: { payload_hash: string; result_json: string }, payloadHash: string): unknown {
  if (hit.payload_hash !== payloadHash) {
    throw new FabricError("IDEMPOTENCY_CONFLICT", "Same idempotency key was reused with a different payload", false);
  }
  return JSON.parse(hit.result_json);
}

export function collabInbox(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const max = getOptionalNumber(input, "max") ?? 50;
  const since = getOptionalString(input, "since");
  const cursorRow = host.db.db
    .prepare("SELECT last_read_message_id FROM cursors WHERE agent_id = ? AND workspace_root = ?")
    .get(session.agent_id, session.workspace_root) as { last_read_message_id: string | null } | undefined;
  const params: Array<string | number | null> = [session.workspace_root, session.agent_id, "*"];
  let where = "workspace_root = ? AND (recipient = ? OR recipient = ? OR recipient IS NULL)";
  if (since) {
    where += " AND ts > ?";
    params.push(since);
  } else if (cursorRow?.last_read_message_id) {
    where += " AND rowid > (SELECT rowid FROM messages WHERE id = ?)";
    params.push(cursorRow.last_read_message_id);
  }
  const messages = host.db.db
    .prepare(`SELECT * FROM messages WHERE ${where} ORDER BY ts ASC LIMIT ?`)
    .all(...params, max) as Record<string, unknown>[];
  const cursor = messages.at(-1)?.id as string | undefined;
  if (cursor) {
    host.db.db
      .prepare(
        `INSERT INTO cursors (agent_id, workspace_root, last_read_message_id, last_seen)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(agent_id, workspace_root) DO UPDATE SET
          last_read_message_id = excluded.last_read_message_id,
          last_seen = excluded.last_seen`
      )
      .run(session.agent_id, session.workspace_root, cursor);
  }
  const asks = host.db.db
    .prepare("SELECT * FROM asks WHERE workspace_root = ? AND (recipient = ? OR recipient = '*') AND status = 'open' ORDER BY ts_created ASC")
    .all(session.workspace_root, session.agent_id) as Record<string, unknown>[];
  return {
    messages: messages.map(formatMessage),
    cursorAdvancedTo: cursor ?? null,
    openAsks: asks.map(formatAsk)
  };
}

export function collabAsk(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const to = getString(input, "to");
  const kind = getString(input, "kind");
  const question = getString(input, "question");
  const refs = getStringArray(input, "refs");
  const urgency = getOptionalString(input, "urgency") ?? "normal";
  const artifacts = getArray(input, "artifacts");
  return host.recordMutation("collab_ask", input, context, (session) => {
    const askId = newId("ask");
    const taskId = newId("task");
    const correlationId = context.correlationId ?? newId("corr");
    host.db.db
      .prepare(
        "INSERT INTO tasks (id, requester_agent_id, assignee, kind, status, correlation_id, refs_json, artifacts_json, workspace_root) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(taskId, session.agent_id, to, kind, "submitted", correlationId, JSON.stringify(refs), JSON.stringify(artifacts), session.workspace_root);
    host.db.db
      .prepare(
        "INSERT INTO asks (id, task_id, asker_agent_id, recipient, kind, urgency, status, question, refs_json, workspace_root, correlation_id) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)"
      )
      .run(askId, taskId, session.agent_id, to, kind, urgency, question, JSON.stringify(refs), session.workspace_root, correlationId);
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "collab.task.created",
      sourceTable: "asks",
      sourceId: askId,
      eventType: "collab.task.created",
      payload: { to, kind, urgency, refs, questionPreview: question.slice(0, 120) },
      testMode: session.test_mode === 1,
      context: { ...context, correlationId }
    });
    host.exportCollabView(session.workspace_root);
    return { askId, taskId, correlationId, warnings: [] };
  });
}

export function collabReply(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const askId = getString(input, "askId");
  const status = getString(input, "status");
  const message = getString(input, "message");
  return host.recordMutation("collab_reply", input, context, (session) => {
    const ask = host.db.db.prepare("SELECT * FROM asks WHERE id = ?").get(askId) as Record<string, unknown> | undefined;
    if (!ask) throw new FabricError("ASK_NOT_FOUND", `Ask not found: ${askId}`, false);
    if (ask.workspace_root !== session.workspace_root || ask.recipient !== session.agent_id) {
      throw new FabricError("ASK_FORBIDDEN", `Session ${session.agent_id} cannot reply to ask ${askId}`, false);
    }
    const messageId = newId("msg");
    const taskStatus = status === "answered" ? "completed" : status === "blocked" ? "input_required" : status;
    host.db.db.prepare("UPDATE asks SET status = ?, ts_updated = CURRENT_TIMESTAMP WHERE id = ?").run(status, askId);
    host.db.db.prepare("UPDATE tasks SET status = ?, ts_updated = CURRENT_TIMESTAMP WHERE id = ?").run(taskStatus, ask.task_id as string);
    host.db.db
      .prepare(
        "INSERT INTO messages (id, sender_agent_id, session_id, origin_peer_id, workspace_root, recipient, kind, body, refs_json, ask_id, task_id, correlation_id) VALUES (?, ?, ?, ?, ?, ?, 'dm', ?, '[]', ?, ?, ?)"
      )
      .run(
        messageId,
        session.agent_id,
        session.id,
        host.originPeerId,
        session.workspace_root,
        ask.asker_agent_id as string,
        message,
        askId,
        ask.task_id as string,
        ask.correlation_id as string
      );
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "collab.task.status_changed",
      sourceTable: "asks",
      sourceId: askId,
      eventType: "collab.task.status_changed",
      payload: { status, taskStatus, messagePreview: message.slice(0, 120) },
      testMode: session.test_mode === 1,
      context: { ...context, correlationId: ask.correlation_id as string }
    });
    host.exportCollabView(session.workspace_root);
    return { messageId, askStatus: status, taskStatus };
  });
}

export function claimPath(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const paths = getRequiredStringArray(input, "paths");
  const note = getOptionalString(input, "note") ?? null;
  const mode = getOptionalString(input, "mode") ?? "normal";
  const ttl = getOptionalNumber(input, "ttl") ?? 1800;
  return host.recordMutation("claim_path", input, context, (session) => {
    const conflicts = activeClaimConflicts(host.db, session.workspace_root, paths).filter((claim) => claim.agentId !== session.agent_id);
    if (conflicts.length > 0 && mode === "normal") {
      host.writeAuditAndEvent({
        sessionId: session.id,
        agentId: session.agent_id,
        hostName: session.host_name,
        workspaceRoot: session.workspace_root,
        action: "collab.claim.conflict_detected",
        sourceTable: "claims",
        sourceId: "none",
        eventType: "collab.claim.conflict_detected",
        payload: { paths, conflicts },
        testMode: session.test_mode === 1,
        context
      });
      return { conflicts };
    }
    const claimId = newId("claim");
    const expiresAt = new Date(host.now().getTime() + ttl * 1000).toISOString();
    host.db.db
      .prepare(
        "INSERT INTO claims (id, ts_expires, agent_id, session_id, workspace_root, paths_json, note, mode, overlapping) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(claimId, expiresAt, session.agent_id, session.id, session.workspace_root, JSON.stringify(paths), note, mode, conflicts.length ? 1 : 0);
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "collab.claim.acquired",
      sourceTable: "claims",
      sourceId: claimId,
      eventType: "collab.claim.acquired",
      payload: { paths, note, mode, conflicts },
      testMode: session.test_mode === 1,
      context
    });
    host.exportCollabView(session.workspace_root);
    return { claimId, expiresAt, conflicts: conflicts.length ? conflicts : undefined };
  });
}

export function releasePath(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const claimId = getString(input, "claimId");
  return host.recordMutation("release_path", input, context, (session) => {
    const row = host.db.db.prepare("SELECT released, agent_id, session_id FROM claims WHERE id = ? AND workspace_root = ?").get(claimId, session.workspace_root) as
      | { released: 0 | 1; agent_id: string; session_id: string }
      | undefined;
    if (!row) throw new FabricError("CLAIM_NOT_FOUND", `Claim not found: ${claimId}`, false);
    if (row.agent_id !== session.agent_id || row.session_id !== session.id) {
      throw new FabricError("CLAIM_FORBIDDEN", `Session ${session.agent_id} cannot release claim ${claimId}`, false);
    }
    if (row.released) return { released: true, alreadyReleased: true };
    host.db.db.prepare("UPDATE claims SET released = 1, released_at = CURRENT_TIMESTAMP WHERE id = ?").run(claimId);
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "collab.claim.released",
      sourceTable: "claims",
      sourceId: claimId,
      eventType: "collab.claim.released",
      payload: { claimId },
      testMode: session.test_mode === 1,
      context
    });
    host.exportCollabView(session.workspace_root);
    return { released: true };
  });
}

export function collabStatus(host: SurfaceHost, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const claims = host.db.db
    .prepare("SELECT * FROM claims WHERE workspace_root = ? AND released = 0 AND (ts_expires IS NULL OR datetime(ts_expires) > CURRENT_TIMESTAMP)")
    .all(session.workspace_root) as Record<string, unknown>[];
  const asks = host.db.db
    .prepare("SELECT * FROM asks WHERE workspace_root = ? AND (recipient = ? OR recipient = '*') AND status = 'open'")
    .all(session.workspace_root, session.agent_id) as Record<string, unknown>[];
  const cursor = host.db.db.prepare("SELECT last_read_message_id FROM cursors WHERE agent_id = ? AND workspace_root = ?").get(
    session.agent_id,
    session.workspace_root
  ) as { last_read_message_id: string | null } | undefined;
  const unreadCount = cursor?.last_read_message_id
    ? countWhere(
        host.db,
        "messages",
        "workspace_root = ? AND (recipient = ? OR recipient = '*' OR recipient IS NULL) AND rowid > (SELECT rowid FROM messages WHERE id = ?)",
        [session.workspace_root, session.agent_id, cursor.last_read_message_id]
      )
    : countWhere(host.db, "messages", "workspace_root = ? AND (recipient = ? OR recipient = '*' OR recipient IS NULL)", [
        session.workspace_root,
        session.agent_id
      ]);
  const presence = host.db.db.prepare("SELECT * FROM presence ORDER BY last_seen_at DESC").all() as Record<string, unknown>[];
  return {
    myOpenAsks: asks.map(formatAsk),
    activeClaimsByOthers: claims.filter((claim) => claim.agent_id !== session.agent_id).map(formatClaim),
    myClaims: claims.filter((claim) => claim.agent_id === session.agent_id).map(formatClaim),
    presence: presence.map((row) => ({ agent: row.agent_id, lastSeen: row.last_seen_at, currentTask: row.current_task ?? undefined })),
    channelCursor: { lastReadMessageId: cursor?.last_read_message_id ?? null, unreadCount }
  };
}

export function collabDecision(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const title = getString(input, "title");
  const decided = getString(input, "decided");
  const participants = getStringArray(input, "participants");
  const rationale = getOptionalString(input, "rationale") ?? null;
  const supersedes = getOptionalString(input, "supersedes") ?? null;
  return host.recordMutation("collab_decision", input, context, (session) => {
    const decisionId = newId("dec");
    host.db.db
      .prepare(
        "INSERT INTO decisions (id, title, decided, recorded_by_agent_id, participants_json, rationale, supersedes, workspace_root) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(decisionId, title, decided, session.agent_id, JSON.stringify(participants), rationale, supersedes, session.workspace_root);
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "collab.decision.recorded",
      sourceTable: "decisions",
      sourceId: decisionId,
      eventType: "collab.decision.recorded",
      payload: { title, participants, supersedes },
      testMode: session.test_mode === 1,
      context
    });
    host.exportCollabView(session.workspace_root);
    const ts = (host.db.db.prepare("SELECT ts FROM decisions WHERE id = ?").get(decisionId) as { ts: string }).ts;
    return { decisionId, ts, recordedBy: session.agent_id, participants };
  });
}

export function collabHeartbeat(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const task = getOptionalString(input, "task") ?? null;
  const eta = getOptionalString(input, "eta") ?? null;
  host.db.transaction(() => {
    host.db.db.prepare("UPDATE bridge_sessions SET last_heartbeat_at = CURRENT_TIMESTAMP WHERE id = ?").run(session.id);
    host.db.db
      .prepare(
        `INSERT INTO presence (agent_id, session_id, last_seen_at, current_task, eta)
        VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          session_id = excluded.session_id,
          last_seen_at = excluded.last_seen_at,
          current_task = excluded.current_task,
          eta = excluded.eta`
      )
      .run(session.agent_id, session.id, task, eta);
    host.writeAuditAndEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      hostName: session.host_name,
      workspaceRoot: session.workspace_root,
      action: "collab.heartbeat",
      sourceTable: "presence",
      sourceId: session.agent_id,
      eventType: "collab.heartbeat",
      payload: { task, eta },
      testMode: session.test_mode === 1,
      context
    });
  });
  return { ack: true, lastSeenAt: host.now().toISOString() };
}
