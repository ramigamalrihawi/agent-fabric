import { existsSync, unlinkSync, chmodSync, mkdirSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { createServer as createNetServer, type Server, type Socket } from "node:net";
import { FabricDaemon } from "./daemon.js";
import { InMemoryFanoutRegistry } from "./runtime/fanout.js";
import { handleSseEventsRequest, handleSsePingRequest } from "./runtime/transports/sse.js";
import type { DaemonRequest, DaemonResponse } from "./types.js";

export type FabricServer = {
  server: Server;
  httpServer?: HttpServer;
  httpPort?: number;
  daemon: FabricDaemon;
  fanout: InMemoryFanoutRegistry;
  close: () => Promise<void>;
};

export async function startFabricServer(options: { socketPath: string; dbPath: string; httpPort?: number | false; costIngestToken?: string }): Promise<FabricServer> {
  mkdirSync(dirname(options.socketPath), { recursive: true, mode: 0o700 });
  if (existsSync(options.socketPath)) {
    unlinkSync(options.socketPath);
  }

  const fanout = new InMemoryFanoutRegistry();
  const daemon = new FabricDaemon({ dbPath: options.dbPath, fanout });
  const server = createNetServer((socket) => handleSocket(daemon, socket));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      chmodSync(options.socketPath, 0o600);
      resolve();
    });
  });

  const httpPort = options.httpPort === undefined || options.httpPort === false ? undefined : options.httpPort;
  if (httpPort !== undefined && !options.costIngestToken) {
    throw new Error("AGENT_FABRIC_COST_INGEST_TOKEN is required when HTTP cost ingest is enabled");
  }
  const httpServer = httpPort === undefined ? undefined : createHttpApiServer(daemon, fanout, options.costIngestToken);
  const stopFanoutSweep = httpServer ? fanout.startSweep() : undefined;
  if (httpServer) {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(httpPort, "127.0.0.1", () => {
        httpServer.off("error", reject);
        resolve();
      });
    });
  }

  return {
    server,
    httpServer,
    httpPort: httpServer ? (httpServer.address() as { port: number }).port : undefined,
    daemon,
    fanout,
    close: async () => {
      stopFanoutSweep?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      fanout.closeAll();
      if (httpServer) {
        await new Promise<void>((resolve, reject) => {
          httpServer.close((error) => (error ? reject(error) : resolve()));
        });
      }
      daemon.close();
      if (existsSync(options.socketPath)) {
        unlinkSync(options.socketPath);
      }
    }
  };
}

function createHttpApiServer(daemon: FabricDaemon, fanout: InMemoryFanoutRegistry, costIngestToken = ""): HttpServer {
  return createHttpServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      writeJson(res, 200, { status: "ok" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/events") {
      handleSseEventsRequest(daemon, fanout, req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/events/ping") {
      handleSsePingRequest(daemon, fanout, req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/cost/ingest/litellm") {
      if (!authorized(req, costIngestToken)) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
      try {
        const body = JSON.parse(await readRequestBody(req));
        writeJson(res, 200, daemon.ingestLiteLlmSpendLogs(body));
      } catch (error) {
        writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (req.method === "POST" && req.url === "/cost/ingest/azure-query") {
      if (!authorized(req, costIngestToken)) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
      try {
        const body = JSON.parse(await readRequestBody(req));
        writeJson(res, 200, daemon.ingestAzureCostQuery(body));
      } catch (error) {
        writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    writeJson(res, 404, { error: "not found" });
  });
}

function authorized(req: IncomingMessage, token: string): boolean {
  return req.headers.authorization === `Bearer ${token}`;
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > MAX_FRAME_BYTES) {
        reject(new Error(`request body exceeded ${MAX_FRAME_BYTES} bytes`));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(`${JSON.stringify(body)}\n`);
}

// 1 MiB ceiling per request frame. Local-only daemon, single-developer
// workload — no legitimate request approaches this. The cap prevents a
// runaway producer from buffering unbounded data inside the daemon.
const MAX_FRAME_BYTES = 1 << 20;

function handleSocket(daemon: FabricDaemon, socket: Socket): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_FRAME_BYTES) {
      socket.write(
        JSON.stringify({
          id: "unknown",
          ok: false,
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: `request frame exceeded ${MAX_FRAME_BYTES} bytes`,
            retryable: false
          }
        }) + "\n"
      );
      socket.destroy();
      return;
    }
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        void handleLine(daemon, socket, line);
      }
      index = buffer.indexOf("\n");
    }
  });
}

async function handleLine(daemon: FabricDaemon, socket: Socket, line: string): Promise<void> {
  let request: DaemonRequest;
  try {
    request = JSON.parse(line) as DaemonRequest;
  } catch {
    socket.write(JSON.stringify({ id: "unknown", ok: false, error: { code: "BAD_JSON", message: "Invalid JSON", retryable: false } }) + "\n");
    return;
  }

  const response = dispatch(daemon, request);
  socket.write(JSON.stringify(response) + "\n");
}

function dispatch(daemon: FabricDaemon, request: DaemonRequest): DaemonResponse {
  try {
    if (request.type === "register") {
      return { id: request.id, ok: true, result: daemon.registerBridge(request.payload) };
    }
    const result = daemon.callTool(request.tool, request.input, request.context);
    return result.ok
      ? { id: request.id, ok: true, result: result.data }
      : { id: request.id, ok: false, error: { code: result.code, message: result.message, retryable: result.retryable } };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
        retryable: false
      }
    };
  }
}
