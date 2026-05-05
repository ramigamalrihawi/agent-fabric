import type { IncomingMessage, ServerResponse } from "node:http";
import { FabricDaemon } from "../../daemon.js";
import { newId } from "../../ids.js";
import { FabricError } from "../errors.js";
import type { InMemoryFanoutRegistry } from "../fanout.js";

export function handleSseEventsRequest(
  daemon: FabricDaemon,
  fanout: InMemoryFanoutRegistry,
  req: IncomingMessage,
  res: ServerResponse
): void {
  let session;
  try {
    session = daemon.requireSession(readSessionContext(req));
  } catch (error) {
    writeAuthError(res, error);
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  const connectionId = newId("sse");
  res.write(`event: connected\ndata: ${JSON.stringify({ connectionId })}\n\n`);

  const unsubscribe = fanout.subscribe({
    connectionId,
    sessionId: session.id,
    agentId: session.agent_id,
    workspaceRoot: session.workspace_root,
    notificationsDeclared: session.notifications_declared,
    send: (envelope) => {
      res.write(`event: collab.message\ndata: ${JSON.stringify(envelope)}\n\n`);
      return true;
    },
    close: () => {
      if (!res.destroyed && !res.writableEnded) {
        res.end();
      }
    }
  });

  const keepAlive = setInterval(() => {
    if (res.destroyed || res.writableEnded) {
      clearInterval(keepAlive);
      unsubscribe();
      return;
    }
    const accepted = res.write(": heartbeat\n\n");
    if (accepted !== false) {
      fanout.heartbeat(session.id, connectionId);
    }
  }, 15_000);
  keepAlive.unref?.();

  req.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
}

export function handleSsePingRequest(
  daemon: FabricDaemon,
  fanout: InMemoryFanoutRegistry,
  req: IncomingMessage,
  res: ServerResponse
): void {
  try {
    const context = readSessionContext(req);
    const session = daemon.requireSession(context);
    const connectionId = readConnectionId(req);
    writeJson(res, 200, { ok: true, touched: fanout.heartbeat(session.id, connectionId), connectionId: connectionId ?? null });
  } catch (error) {
    writeAuthError(res, error);
  }
}

function readSessionContext(req: IncomingMessage): { sessionId: string; sessionToken: string } {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const sessionId = header(req, "x-agent-fabric-session-id") ?? url.searchParams.get("sessionId");
  const sessionToken = bearerToken(req) ?? header(req, "x-agent-fabric-session-token");
  if (!sessionId) {
    throw new FabricError("SESSION_UNAUTHORIZED", "Session id is required for event subscription", false);
  }
  if (!sessionToken) {
    throw new FabricError("SESSION_UNAUTHORIZED", "Session token is required for event subscription", false);
  }
  return { sessionId, sessionToken };
}

function readConnectionId(req: IncomingMessage): string | undefined {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  return header(req, "x-agent-fabric-connection-id") ?? url.searchParams.get("connectionId") ?? undefined;
}

function bearerToken(req: IncomingMessage): string | undefined {
  const authorization = header(req, "authorization");
  if (!authorization?.startsWith("Bearer ")) return undefined;
  return authorization.slice("Bearer ".length);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function writeAuthError(res: ServerResponse, error: unknown): void {
  const code = error instanceof FabricError ? error.code : "SESSION_UNAUTHORIZED";
  const message = error instanceof Error ? error.message : String(error);
  writeJson(res, 401, { error: code, message });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(`${JSON.stringify(body)}\n`);
}
