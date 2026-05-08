import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FabricClient } from "../client.js";
import { defaultPaths } from "../paths.js";
import { bridgeCallContext } from "./bridge-context.js";
import { runProjectCommand, type ProjectModelRunner } from "./project-cli.js";
import type { BridgeRegister, BridgeSession } from "../types.js";

export type DesktopToolCaller = (tool: string, input: Record<string, unknown>) => Promise<unknown>;

export type DesktopServerOptions = {
  host?: string;
  port?: number;
  socketPath?: string;
  workspaceRoot?: string;
  toolCaller?: DesktopToolCaller;
  apiToken?: string;
  projectModelRunner?: ProjectModelRunner;
};

export type DesktopServerRuntime = {
  server: Server;
  host: string;
  port: number;
  url: string;
  apiToken: string;
  close: () => Promise<void>;
};

const API_CALL_TOOLS = new Set([
  "fabric_status",
  "fabric_spawn_agents",
  "fabric_list_agents",
  "fabric_open_agent",
  "fabric_message_agent",
  "fabric_wait_agents",
  "fabric_accept_patch",
  "fabric_senior_start",
  "fabric_senior_status",
  "fabric_senior_resume",
  "project_queue_create",
  "project_queue_update_settings",
  "project_queue_record_stage",
  "project_queue_add_tasks",
  "project_queue_list",
  "project_queue_dashboard",
  "project_queue_review_matrix",
  "project_queue_task_detail",
  "project_queue_task_packet",
  "project_queue_approval_inbox",
  "project_queue_timeline",
  "project_queue_agent_lanes",
  "project_queue_approve_model_calls",
  "project_queue_progress_report",
  "project_queue_collab_summary",
  "project_queue_prepare_ready",
  "project_queue_launch_plan",
  "project_queue_validate_links",
  "project_queue_validate_context_refs",
  "project_queue_claim_next",
  "project_queue_recover_stale",
  "project_queue_update_task",
  "project_queue_retry_task",
  "project_queue_decide",
  "project_queue_update_task_metadata",
  "tool_context_propose",
  "tool_context_decide",
  "tool_context_policy_set",
  "tool_context_policy_status",
  "llm_approve",
  "fabric_inspect_context_package",
  "memory_list",
  "memory_review",
  "model_brain_route",
  "llm_hard_gate"
]);

const DESKTOP_API_VERSION = "agent-fabric.desktop-api.v1";
const DESKTOP_MAX_JSON_BODY_BYTES = 1_000_000;
const DESKTOP_SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data:; connect-src 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff"
};

const DESKTOP_READ_ROUTES = [
  "/api/bootstrap",
  "/api/readiness",
  "/api/status",
  "/api/queues",
  "/api/queues/:queueId/snapshot",
  "/api/queues/:queueId/action-inbox",
  "/api/queues/:queueId/health",
  "/api/queues/:queueId/dashboard",
  "/api/queues/:queueId/review-matrix",
  "/api/queues/:queueId/approvals",
  "/api/queues/:queueId/launch-plan",
  "/api/queues/:queueId/ready-packet-links",
  "/api/queues/:queueId/timeline",
  "/api/queues/:queueId/lanes",
  "/api/queues/:queueId/tasks/:queueTaskId",
  "/api/queues/:queueId/tasks/:queueTaskId/packet",
  "/api/context/:requestId",
  "/api/memory/pending"
];

const DESKTOP_FEATURES = {
  queueSnapshot: true,
  projectQueues: true,
  pipelineStages: true,
  taskReview: true,
  bootstrapTaskDetail: true,
  workerClaims: true,
  batchClaimApprovalRetry: true,
  toolContextApprovals: true,
  modelApprovals: true,
  modelBrain: true,
  contextInspector: true,
  actionInbox: true,
  memoryReview: true,
  agentLanes: true,
  projectCreateFlow: true,
  promptImproveFlow: true,
  planningFlow: true,
  demoSeed: true,
  taskPackets: true,
  taskPacketReadRoute: true,
  readyPacketLinks: true,
  staleWorkerRecovery: true,
  codexWorkerBridge: true,
  managerHealth: true
};

export async function createDesktopFabricCaller(options: DesktopServerOptions = {}): Promise<DesktopToolCaller> {
  const paths = defaultPaths();
  const client = new FabricClient(options.socketPath ?? paths.socketPath);
  const session = await client.register(desktopBridgeRegister(options.workspaceRoot ?? process.cwd()));
  return async (tool, input) => {
    const cleaned = dropUndefined(input);
    return client.call(tool, cleaned, bridgeCallContext(session, { tool, input: cleaned }));
  };
}

export async function startDesktopServer(options: DesktopServerOptions = {}): Promise<DesktopServerRuntime> {
  const host = normalizeLoopbackHost(options.host ?? "127.0.0.1");
  if (!isLoopbackHost(host)) {
    throw new Error(`Desktop server host must be loopback-only before exposing /api/call: ${host}`);
  }
  const requestedPort = options.port ?? 4573;
  const apiToken = options.apiToken ?? randomBytes(32).toString("base64url");
  const caller = options.toolCaller ?? (await createDesktopFabricCaller(options));
  const server = createServer((request, response) => {
    void handleRequest(request, response, caller, apiToken, options.projectModelRunner);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requestedPort;
  const url = `http://${urlHost(host)}:${port}/`;
  return {
    server,
    host,
    port,
    url,
    apiToken,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeLoopbackHost(host);
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function normalizeLoopbackHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

function urlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function validApiToken(request: IncomingMessage, expected: string): boolean {
  const header = request.headers["x-agent-fabric-desktop-token"];
  const actual = Array.isArray(header) ? header[0] : header;
  const actualBytes = actual ? Buffer.from(actual) : undefined;
  const expectedBytes = Buffer.from(expected);
  if (!actualBytes || actualBytes.byteLength !== expectedBytes.byteLength) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}

function validHostHeader(request: IncomingMessage): boolean {
  const header = request.headers.host;
  const host = Array.isArray(header) ? header[0] : header;
  if (!host) return false;
  try {
    return isLoopbackHost(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  caller: DesktopToolCaller,
  apiToken: string,
  projectModelRunner?: ProjectModelRunner
): Promise<void> {
  try {
    if (!validHostHeader(request)) {
      return writeJson(response, 403, { ok: false, error: { code: "DESKTOP_HOST_FORBIDDEN", message: "Desktop server only accepts loopback Host headers." } });
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return await serveAsset(response, "index.html");
    }
    if (request.method === "GET" && ["/app.css", "/app.js"].includes(url.pathname)) {
      return await serveAsset(response, url.pathname.slice(1));
    }
    if (url.pathname.startsWith("/api/")) {
      return await handleApi(request, response, url, caller, apiToken, projectModelRunner);
    }
    writeJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Route not found." } });
  } catch (error) {
    const record = error as { code?: string; message?: string };
    writeJson(response, statusForDesktopError(record.code), {
      ok: false,
      error: { code: record.code ?? "DESKTOP_SERVER_ERROR", message: record.message ?? String(error) }
    });
  }
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  caller: DesktopToolCaller,
  apiToken: string,
  projectModelRunner?: ProjectModelRunner
): Promise<void> {
  if (request.method === "GET" && url.pathname === "/api/readiness") {
    return writeToolResponse(response, desktopReadiness(await caller("fabric_status", {}), apiToken));
  }
  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    const statuses = url.searchParams.getAll("status");
    const [daemonStatus, queueList] = await Promise.all([
      caller("fabric_status", {}),
      caller("project_queue_list", {
        projectPath: optionalQuery(url, "projectPath"),
        includeClosed: boolQuery(url, "includeClosed"),
        statuses,
        limit: numberQuery(url, "limit")
      })
    ]);
    const queues = queueListRows(queueList);
    const requestedQueueId = optionalQuery(url, "queueId");
    const requestedQueueTaskId = optionalQuery(url, "queueTaskId");
    const selectedQueueId = requestedQueueId && hasQueueId(queues, requestedQueueId) ? requestedQueueId : firstQueueId(queues);
    const snapshot = selectedQueueId
      ? await desktopQueueSnapshot(caller, selectedQueueId, {
          matrixLimit: numberQuery(url, "matrixLimit"),
          includeExpired: boolQuery(url, "includeExpired") ?? false,
          timelineLimit: numberQuery(url, "timelineLimit") ?? 40,
          maxEvents: numberQuery(url, "maxEvents") ?? 5,
          memoryMax: numberQuery(url, "memoryMax") ?? 25
        })
      : undefined;
    const taskDetail =
      selectedQueueId && requestedQueueTaskId
        ? await desktopTaskDetail(caller, selectedQueueId, requestedQueueTaskId, {
            includeResume: boolQuery(url, "includeTaskResume") ?? true,
            maxEventsPerRun: numberQuery(url, "maxTaskEvents") ?? 5
          })
        : undefined;
    return writeToolResponse(response, {
      readiness: desktopReadiness(daemonStatus, apiToken),
      queues: queueList,
      selectedQueueId,
      snapshot,
      ...taskDetail
    });
  }
  if (request.method === "GET" && url.pathname === "/api/status") {
    return writeToolResponse(response, await caller("fabric_status", {}));
  }
  if (request.method === "GET" && url.pathname === "/api/queues") {
    const statuses = url.searchParams.getAll("status");
    return writeToolResponse(
      response,
      await caller("project_queue_list", {
        projectPath: optionalQuery(url, "projectPath"),
        includeClosed: boolQuery(url, "includeClosed"),
        statuses,
        limit: numberQuery(url, "limit")
      })
    );
  }

  const taskPacketMatch = url.pathname.match(/^\/api\/queues\/([^/]+)\/tasks\/([^/]+)\/packet$/);
  if (request.method === "GET" && taskPacketMatch) {
    const [, queueId, queueTaskId] = taskPacketMatch;
    return writeToolResponse(
      response,
      await caller(
        "project_queue_task_packet",
        dropUndefined({
          queueId,
          queueTaskId,
          format: optionalQuery(url, "format"),
          includeResume: boolQuery(url, "includeResume"),
          preferredWorker: optionalQuery(url, "preferredWorker"),
          workspaceMode: optionalQuery(url, "workspaceMode"),
          workspacePath: optionalQuery(url, "workspacePath"),
          modelProfile: optionalQuery(url, "modelProfile"),
          packetPath: optionalQuery(url, "packetPath")
        })
      )
    );
  }

  const queueMatch = url.pathname.match(/^\/api\/queues\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/);
  if (request.method === "GET" && queueMatch) {
    const [, queueId, section, extra] = queueMatch;
    if (section === "snapshot") {
      return writeToolResponse(
        response,
        await desktopQueueSnapshot(caller, queueId, {
          matrixLimit: numberQuery(url, "matrixLimit"),
          includeExpired: boolQuery(url, "includeExpired") ?? false,
          timelineLimit: numberQuery(url, "timelineLimit") ?? 40,
          maxEvents: numberQuery(url, "maxEvents") ?? 5,
          memoryMax: numberQuery(url, "memoryMax") ?? 25
        })
      );
    }
    if (section === "action-inbox") {
      const snapshot = await desktopQueueSnapshot(caller, queueId, {
        matrixLimit: numberQuery(url, "matrixLimit"),
        includeExpired: boolQuery(url, "includeExpired") ?? false,
        timelineLimit: numberQuery(url, "timelineLimit") ?? 20,
        maxEvents: numberQuery(url, "maxEvents") ?? 3,
        memoryMax: numberQuery(url, "memoryMax") ?? 25
      });
      return writeToolResponse(response, snapshot.actionInbox);
    }
    if (section === "health") {
      return writeToolResponse(
        response,
        await desktopQueueHealth(caller, queueId, {
          maxEvents: numberQuery(url, "maxEvents") ?? 1,
          managerSummaryLimit: numberQuery(url, "managerSummaryLimit") ?? 10
        })
      );
    }
    if (section === "dashboard") return writeToolResponse(response, await caller("project_queue_dashboard", { queueId }));
    if (section === "review-matrix") return writeToolResponse(response, await caller("project_queue_review_matrix", { queueId, limit: numberQuery(url, "limit") }));
    if (section === "approvals") return writeToolResponse(response, await caller("project_queue_approval_inbox", { queueId, includeExpired: boolQuery(url, "includeExpired") ?? false }));
    if (section === "launch-plan") return writeToolResponse(response, await caller("project_queue_launch_plan", { queueId, limit: numberQuery(url, "limit") }));
    if (section === "ready-packet-links") {
      return writeToolResponse(
        response,
        await desktopReadyPacketLinks(caller, queueId, {
          limit: numberQuery(url, "limit"),
          format: optionalQuery(url, "format") ?? "markdown",
          includeResume: boolQuery(url, "includeResume") ?? true,
          preferredWorker: optionalQuery(url, "preferredWorker") ?? "ramicode",
          workspaceMode: optionalQuery(url, "workspaceMode") ?? "git_worktree",
          workspacePath: optionalQuery(url, "workspacePath"),
          modelProfile: optionalQuery(url, "modelProfile") ?? "execute.cheap"
        })
      );
    }
    if (section === "timeline") return writeToolResponse(response, await caller("project_queue_timeline", { queueId, limit: numberQuery(url, "limit") ?? 50 }));
    if (section === "lanes") return writeToolResponse(response, await caller("project_queue_agent_lanes", { queueId, maxEventsPerLane: numberQuery(url, "maxEvents") ?? 5 }));
    if (section === "tasks" && extra) {
      return writeToolResponse(
        response,
        await caller("project_queue_task_detail", {
          queueId,
          queueTaskId: extra,
          includeResume: boolQuery(url, "includeResume"),
          maxEventsPerRun: numberQuery(url, "maxEventsPerRun")
        })
      );
    }
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/context/")) {
    const requestId = decodeURIComponent(url.pathname.slice("/api/context/".length));
    return writeToolResponse(response, await caller("fabric_inspect_context_package", { requestId }));
  }

  if (request.method === "GET" && url.pathname === "/api/memory/pending") {
    return writeToolResponse(response, await caller("memory_list", { status: "pending_review", max: numberQuery(url, "max") ?? 25 }));
  }

  if (request.method === "POST" && url.pathname === "/api/project-create") {
    if (!validApiToken(request, apiToken)) {
      return writeJson(response, 401, { ok: false, error: { code: "DESKTOP_AUTH_REQUIRED", message: "Desktop API mutation token is required." } });
    }
    if (!isJsonRequest(request)) {
      return writeJson(response, 415, { ok: false, error: { code: "DESKTOP_JSON_REQUIRED", message: "Desktop API mutations require application/json." } });
    }
    const body = await readJsonBody(request);
    return writeToolResponse(response, await desktopProjectCreate(caller, body));
  }

  if (request.method === "POST" && url.pathname === "/api/project-improve-prompt") {
    if (!validApiToken(request, apiToken)) {
      return writeJson(response, 401, { ok: false, error: { code: "DESKTOP_AUTH_REQUIRED", message: "Desktop API mutation token is required." } });
    }
    if (!isJsonRequest(request)) {
      return writeJson(response, 415, { ok: false, error: { code: "DESKTOP_JSON_REQUIRED", message: "Desktop API mutations require application/json." } });
    }
    const body = await readJsonBody(request);
    return writeToolResponse(response, await desktopImprovePrompt(caller, body, projectModelRunner));
  }

  if (request.method === "POST" && url.pathname === "/api/project-start-plan") {
    if (!validApiToken(request, apiToken)) {
      return writeJson(response, 401, { ok: false, error: { code: "DESKTOP_AUTH_REQUIRED", message: "Desktop API mutation token is required." } });
    }
    if (!isJsonRequest(request)) {
      return writeJson(response, 415, { ok: false, error: { code: "DESKTOP_JSON_REQUIRED", message: "Desktop API mutations require application/json." } });
    }
    const body = await readJsonBody(request);
    return writeToolResponse(response, await desktopStartPlan(caller, body));
  }

  if (request.method === "POST" && url.pathname === "/api/demo-seed") {
    if (!validApiToken(request, apiToken)) {
      return writeJson(response, 401, { ok: false, error: { code: "DESKTOP_AUTH_REQUIRED", message: "Desktop API mutation token is required." } });
    }
    if (!isJsonRequest(request)) {
      return writeJson(response, 415, { ok: false, error: { code: "DESKTOP_JSON_REQUIRED", message: "Desktop API mutations require application/json." } });
    }
    const body = await readJsonBody(request);
    return writeToolResponse(response, await desktopDemoSeed(caller, body));
  }

  if (request.method === "POST" && url.pathname === "/api/call") {
    if (!validApiToken(request, apiToken)) {
      return writeJson(response, 401, { ok: false, error: { code: "DESKTOP_AUTH_REQUIRED", message: "Desktop API mutation token is required." } });
    }
    if (!isJsonRequest(request)) {
      return writeJson(response, 415, { ok: false, error: { code: "DESKTOP_JSON_REQUIRED", message: "Desktop API mutations require application/json." } });
    }
    const body = await readJsonBody(request);
    const tool = typeof body.tool === "string" ? body.tool.trim() : "";
    if (!tool) {
      return writeJson(response, 400, { ok: false, error: { code: "INVALID_TOOL_NAME", message: "Desktop API mutation tool must be a non-empty string." } });
    }
    if (!API_CALL_TOOLS.has(tool)) {
      return writeJson(response, 400, { ok: false, error: { code: "TOOL_NOT_ALLOWED", message: `Desktop API does not expose tool: ${tool}` } });
    }
    if (body.input !== undefined && (!body.input || typeof body.input !== "object" || Array.isArray(body.input))) {
      return writeJson(response, 400, { ok: false, error: { code: "INVALID_TOOL_INPUT", message: "Desktop API mutation input must be a JSON object when provided." } });
    }
    return writeToolResponse(response, await caller(tool, asObject(body.input)));
  }

  writeJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "API route not found." } });
}

async function desktopProjectCreate(caller: DesktopToolCaller, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const maxParallelAgents = numberFromUnknown(body.maxParallelAgents) ?? 4;
  const projectCall = desktopProjectCaller(caller);
  const result = await runProjectCommand(
    {
      command: "create",
      json: false,
      projectPath: stringFromUnknown(body.projectPath) ?? "",
      prompt: stringFromUnknown(body.prompt),
      promptSummary: stringFromUnknown(body.promptSummary),
      title: stringFromUnknown(body.title),
      pipelineProfile: desktopPipelineProfile(body.pipelineProfile),
      maxParallelAgents: Number.isInteger(maxParallelAgents) ? maxParallelAgents : 4
    },
    projectCall
  );
  return result.data;
}

async function desktopImprovePrompt(caller: DesktopToolCaller, body: Record<string, unknown>, projectModelRunner?: ProjectModelRunner): Promise<Record<string, unknown>> {
  const projectCall = desktopProjectCaller(caller);
  const result = await runProjectCommand(
    {
      command: "improve-prompt",
      json: false,
      queueId: stringFromUnknown(body.queueId) ?? "",
      prompt: stringFromUnknown(body.prompt),
      modelAlias: stringFromUnknown(body.modelAlias) ?? "prompt.improve.strong",
      approvalToken: stringFromUnknown(body.approvalToken),
      accept: body.accept === true,
      outputFile: undefined
    },
    projectCall,
    projectModelRunner ? { runModel: projectModelRunner } : {}
  );
  return { action: result.action, message: result.message, ...result.data };
}

async function desktopStartPlan(caller: DesktopToolCaller, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const projectCall = desktopProjectCaller(caller);
  const result = await runProjectCommand(
    {
      command: "start-plan",
      json: false,
      queueId: stringFromUnknown(body.queueId) ?? "",
      task: stringFromUnknown(body.task),
      maxRounds: integerFromUnknown(body.maxRounds),
      budgetUsd: numberFromUnknown(body.budgetUsd),
      outputFormat: desktopOutputFormat(body.outputFormat)
    },
    projectCall
  );
  return { action: result.action, message: result.message, ...result.data };
}

async function desktopDemoSeed(caller: DesktopToolCaller, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const maxParallelAgents = numberFromUnknown(body.maxParallelAgents) ?? 4;
  const projectCall = desktopProjectCaller(caller);
  const result = await runProjectCommand(
    {
      command: "demo-seed",
      json: false,
      projectPath: stringFromUnknown(body.projectPath) ?? "/tmp/agent-fabric-desktop-demo",
      title: stringFromUnknown(body.title) ?? "Agent Fabric Console Demo",
      maxParallelAgents: Number.isInteger(maxParallelAgents) ? maxParallelAgents : 4
    },
    projectCall
  );
  return result.data;
}

function desktopProjectCaller(caller: DesktopToolCaller) {
  return async <T = Record<string, unknown>>(tool: string, input: Record<string, unknown>): Promise<T> => asObject(await caller(tool, input)) as T;
}

function desktopPipelineProfile(value: unknown): "fast" | "balanced" | "careful" | "custom" {
  if (value === "fast" || value === "careful" || value === "custom") return value;
  return "balanced";
}

function desktopOutputFormat(value: unknown): "markdown" | "adr" | undefined {
  if (value === "markdown" || value === "adr") return value;
  return undefined;
}

async function serveAsset(response: ServerResponse, fileName: string): Promise<void> {
  const assetPath = join(dirname(fileURLToPath(import.meta.url)), "..", "desktop", "public", fileName);
  const body = await readFile(assetPath);
  response.writeHead(200, {
    ...DESKTOP_SECURITY_HEADERS,
    "content-type": contentType(fileName),
    "cache-control": "no-store"
  });
  response.end(body);
}

function writeToolResponse(response: ServerResponse, data: unknown): void {
  writeJson(response, 200, { ok: true, data });
}

function desktopReadiness(daemonStatus: unknown, apiToken: string): Record<string, unknown> {
  const daemon = asObject(daemonStatus);
  const daemonRecord = asObject(daemon.daemon);
  const daemonReady = daemonRecord.status === "ok" || daemonRecord.status === "ready";
  return {
    schema: DESKTOP_API_VERSION,
    ready: daemonReady,
    generatedAt: new Date().toISOString(),
    daemon,
    server: {
      status: "ok",
      transport: "http",
      safeToolCount: API_CALL_TOOLS.size,
      apiAuth: { required: true, header: "x-agent-fabric-desktop-token" },
      apiToken
    },
    api: {
      readRoutes: DESKTOP_READ_ROUTES,
      callTools: [...API_CALL_TOOLS].sort()
    },
    features: DESKTOP_FEATURES
  };
}

async function desktopQueueSnapshot(
  caller: DesktopToolCaller,
  queueId: string,
  options: {
    matrixLimit?: number;
    includeExpired: boolean;
    timelineLimit: number;
    maxEvents: number;
    memoryMax: number;
  }
): Promise<Record<string, unknown>> {
  const [dashboard, matrix, approvals, timeline, lanes, memoryInbox] = await Promise.all([
    caller("project_queue_dashboard", { queueId }),
    caller("project_queue_review_matrix", { queueId, limit: options.matrixLimit }),
    caller("project_queue_approval_inbox", { queueId, includeExpired: options.includeExpired }),
    caller("project_queue_timeline", { queueId, limit: options.timelineLimit }),
    caller("project_queue_agent_lanes", { queueId, maxEventsPerLane: options.maxEvents }),
    caller("memory_list", { status: "pending_review", max: options.memoryMax })
  ]);
  return {
    dashboard,
    matrix,
    approvals,
    timeline,
    lanes,
    memoryInbox,
    actionInbox: desktopActionInbox({ queueId, dashboard, matrix, approvals, lanes, memoryInbox })
  };
}

function desktopActionInbox(input: {
  queueId: string;
  dashboard: unknown;
  matrix: unknown;
  approvals: unknown;
  lanes: unknown;
  memoryInbox: unknown;
}): Record<string, unknown> {
  const dashboard = asObject(input.dashboard);
  const matrix = asObject(input.matrix);
  const approvals = asObject(input.approvals);
  const memoryInbox = asObject(input.memoryInbox);
  const queue = asObject(dashboard.queue);
  const summaryStrip = asObject(dashboard.summaryStrip);
  const summaryCounts = asObject(summaryStrip.counts);
  const matrixSummary = asObject(matrix.summary);
  const queueBoard = asObject(dashboard.queueBoard);
  const toolContext = arrayFromUnknown(approvals.toolContext);
  const modelCalls = arrayFromUnknown(approvals.modelCalls);
  const pendingMemories = arrayFromUnknown(memoryInbox.memories);
  const reviewTasks = arrayFromUnknown(queueBoard.review);
  const readyTasks = arrayFromUnknown(queueBoard.ready);
  const blockedTasks = arrayFromUnknown(queueBoard.blocked);
  const taskCostCoverage = asObject(dashboard.taskCostCoverage);
  const items: Array<Record<string, unknown>> = [];

  const addItem = (item: Record<string, unknown>) => {
    items.push({
      priority: numberFromUnknown(item.priority) ?? 100,
      severity: item.severity ?? "info",
      ...item
    });
  };

  const staleRunning = numberFromUnknown(summaryCounts.staleRunning) ?? 0;
  if (staleRunning > 0) {
    addItem({
      id: "stale-workers",
      kind: "stale_workers",
      priority: 5,
      severity: "warning",
      title: "Recover stale workers",
      detail: `${staleRunning} running task(s) appear stale.`,
      tab: "dashboard",
      actionLabel: "Open Recovery"
    });
  }

  const tasksWithoutCost = numberFromUnknown(taskCostCoverage.tasksWithoutCostEvents) ?? 0;
  if (tasksWithoutCost > 0) {
    const pct = numberFromUnknown(taskCostCoverage.costCoveragePercent) ?? 0;
    addItem({
      id: "cost-coverage",
      kind: "cost_coverage",
      priority: 6,
      severity: "warning",
      title: "Worker cost data missing",
      detail: `${tasksWithoutCost} of ${numberFromUnknown(taskCostCoverage.tasksWithWorkerRuns) ?? "?"} task(s) with worker runs lack cost-attributed events (${pct}% coverage).`,
      tab: "dashboard",
      actionLabel: "Inspect Cost"
    });
  }

  if (toolContext.length > 0) {
    addItem({
      id: "tool-context-approvals",
      kind: "tool_context_approval",
      priority: 10,
      severity: "attention",
      title: "Approve tool/context bundles",
      detail: `${toolContext.length} proposal(s) need a human decision before workers can start.`,
      tab: "approvals",
      actionLabel: "Open Approvals",
      proposalIds: compactStringArray(toolContext.map((item) => asObject(item).proposalId))
    });
  }

  if (modelCalls.length > 0) {
    addItem({
      id: "model-approvals",
      kind: "model_approval",
      priority: 11,
      severity: "attention",
      title: "Approve model calls",
      detail: `${modelCalls.length} model request(s) are waiting on cost/risk approval.`,
      tab: "approvals",
      actionLabel: "Open Approvals",
      requestIds: compactStringArray(modelCalls.map((item) => asObject(item).requestId))
    });
  }

  const failed = (numberFromUnknown(summaryCounts.failed) ?? 0) + (numberFromUnknown(summaryCounts.canceled) ?? 0);
  if (failed > 0) {
    addItem({
      id: "failed-tasks",
      kind: "failed_tasks",
      priority: 20,
      severity: "warning",
      title: "Review failed work",
      detail: `${failed} failed or canceled task(s) need retry, edit, or acceptance.`,
      tab: "tasks",
      actionLabel: "Open Tasks"
    });
  }

  if (reviewTasks.length > 0) {
    addItem({
      id: "patch-review",
      kind: "patch_review",
      priority: 30,
      severity: "attention",
      title: "Review patch-ready output",
      detail: `${reviewTasks.length} task(s) are waiting for patch/test review.`,
      tab: "dashboard",
      actionLabel: reviewTasks.length === 1 ? "Open Task" : "Open Review",
      queueTaskId: reviewTasks.length === 1 ? stringFromUnknown(asObject(reviewTasks[0]).queueTaskId) : undefined,
      taskIds: compactStringArray(reviewTasks.map((item) => asObject(item).queueTaskId)).slice(0, 8)
    });
  }

  const tasksNeedingProposal = numberFromUnknown(matrixSummary.tasksNeedingToolContextProposal) ?? 0;
  if (tasksNeedingProposal > 0) {
    addItem({
      id: "tool-context-proposals",
      kind: "tool_context_proposal",
      priority: 35,
      severity: "attention",
      title: "Prepare missing tool/context proposals",
      detail: `${tasksNeedingProposal} task(s) still need a proposed bundle before launch.`,
      tab: "matrix",
      actionLabel: "Open Matrix"
    });
  }

  if (pendingMemories.length > 0) {
    addItem({
      id: "memory-review",
      kind: "memory_review",
      priority: 40,
      severity: "attention",
      title: "Review pending memories",
      detail: `${pendingMemories.length} memory candidate(s) need approve, archive, or reject.`,
      tab: "memory",
      actionLabel: "Open Memory"
    });
  }

  if (summaryStrip.status === "waiting_on_start") {
    addItem({
      id: "start-gate",
      kind: "start_gate",
      priority: 50,
      severity: "attention",
      title: "Open the worker start gate",
      detail: stringFromUnknown(summaryStrip.nextAction) ?? "Record start_execution or resume before claiming workers.",
      tab: "pipeline",
      actionLabel: "Open Pipeline"
    });
  }

  const ready = numberFromUnknown(summaryCounts.ready) ?? readyTasks.length;
  const availableSlots = numberFromUnknown(summaryCounts.availableSlots) ?? 0;
  if (ready > 0 && availableSlots > 0 && summaryStrip.status !== "waiting_on_start") {
    addItem({
      id: "claim-ready-work",
      kind: "claim_ready_work",
      priority: 60,
      severity: "info",
      title: "Claim ready work",
      detail: `${ready} ready task(s), ${availableSlots} available worker slot(s).`,
      tab: "dashboard",
      actionLabel: "Open Claim"
    });
  }

  if (blockedTasks.length > 0) {
    addItem({
      id: "blocked-tasks",
      kind: "blocked_tasks",
      priority: 70,
      severity: "info",
      title: "Inspect blocked tasks",
      detail: `${blockedTasks.length} task(s) are blocked by dependencies, gates, or scheduling limits.`,
      tab: "matrix",
      actionLabel: "Open Matrix"
    });
  }

  const overlappingFileScopes = numberFromUnknown(matrixSummary.overlappingFileScopes) ?? 0;
  if (overlappingFileScopes > 0) {
    addItem({
      id: "file-scope-overlap",
      kind: "file_scope_overlap",
      priority: 80,
      severity: "info",
      title: "Check file-scope overlap",
      detail: `${overlappingFileScopes} expected file scope(s) overlap across queued tasks.`,
      tab: "matrix",
      actionLabel: "Open Matrix"
    });
  }

  items.sort((left, right) => Number(left.priority) - Number(right.priority) || String(left.id).localeCompare(String(right.id)));
  return {
    schema: "agent-fabric.desktop-action-inbox.v1",
    queueId: input.queueId,
    projectPath: stringFromUnknown(queue.projectPath),
    generatedAt: new Date().toISOString(),
    topAction: items[0],
    total: items.length,
    counts: {
      bySeverity: countBy(items, "severity"),
      byKind: countBy(items, "kind"),
      attention: items.filter((item) => item.severity === "attention").length,
      warning: items.filter((item) => item.severity === "warning").length,
      info: items.filter((item) => item.severity === "info").length
    },
    items
  };
}

async function desktopQueueHealth(
  caller: DesktopToolCaller,
  queueId: string,
  options: { maxEvents: number; managerSummaryLimit: number }
): Promise<Record<string, unknown>> {
  const progress = asObject(
    await caller("project_queue_progress_report", {
      queueId,
      maxEventsPerLane: options.maxEvents,
      managerSummaryLimit: options.managerSummaryLimit
    })
  );
  return {
    schema: "agent-fabric.desktop-manager-health.v1",
    queue: progress.queue,
    generatedAt: progress.generatedAt,
    summary: progress.summary,
    counts: progress.counts,
    managerSummary: progress.managerSummary,
    taskCostCoverage: progress.taskCostCoverage,
    nextActions: progress.nextActions,
    verificationChecklist: progress.verificationChecklist
  };
}

async function desktopTaskDetail(
  caller: DesktopToolCaller,
  queueId: string,
  queueTaskId: string,
  options: { includeResume: boolean; maxEventsPerRun: number }
): Promise<Record<string, unknown>> {
  try {
    const detail = await caller("project_queue_task_detail", {
      queueId,
      queueTaskId,
      includeResume: options.includeResume,
      maxEventsPerRun: options.maxEventsPerRun
    });
    return { taskDetail: detail };
  } catch (error) {
    const record = error as { code?: string; message?: string };
    return {
      taskDetailError: {
        code: record.code ?? "TASK_DETAIL_UNAVAILABLE",
        message: record.message ?? String(error),
        queueTaskId
      }
    };
  }
}

async function desktopReadyPacketLinks(
  caller: DesktopToolCaller,
  queueId: string,
  options: {
    limit?: number;
    format: string;
    includeResume: boolean;
    preferredWorker: string;
    workspaceMode: string;
    workspacePath?: string;
    modelProfile: string;
  }
): Promise<Record<string, unknown>> {
  const launchPlan = asObject(await caller("project_queue_launch_plan", { queueId, limit: options.limit }));
  const launchable = arrayFromUnknown(launchPlan.launchable);
  const links: Array<Record<string, unknown>> = [];
  for (const entry of launchable) {
    const task = asObject(asObject(entry).task ?? entry);
    const queueTaskId = stringFromUnknown(task.queueTaskId);
    if (!queueTaskId) continue;
    const packetApiPath = desktopTaskPacketPath(queueId, queueTaskId, options);
    links.push({
      queueTaskId,
      title: stringFromUnknown(task.title),
      status: stringFromUnknown(task.status),
      risk: stringFromUnknown(task.risk),
      priority: stringFromUnknown(task.priority),
      phase: stringFromUnknown(task.phase),
      packetApiPath,
      packetUrl: packetApiPath
    });
  }
  return {
    schema: "agent-fabric.desktop-ready-packet-links.v1",
    queueId,
    generatedAt: new Date().toISOString(),
    count: links.length,
    workerDefaults: dropUndefined({
      format: options.format,
      includeResume: options.includeResume,
      preferredWorker: options.preferredWorker,
      workspaceMode: options.workspaceMode,
      workspacePath: options.workspacePath,
      modelProfile: options.modelProfile
    }),
    summary: launchPlan.summary ?? {},
    launchPlan: {
      workerStartBlocked: launchPlan.workerStartBlocked,
      workerStartBlockedReason: launchPlan.workerStartBlockedReason,
      availableSlots: launchPlan.availableSlots,
      maxParallelAgents: launchPlan.maxParallelAgents
    },
    links
  };
}

function desktopTaskPacketPath(
  queueId: string,
  queueTaskId: string,
  options: {
    format: string;
    includeResume: boolean;
    preferredWorker: string;
    workspaceMode: string;
    workspacePath?: string;
    modelProfile: string;
  }
): string {
  const params = new URLSearchParams();
  params.set("format", options.format);
  params.set("includeResume", options.includeResume ? "1" : "0");
  params.set("preferredWorker", options.preferredWorker);
  params.set("workspaceMode", options.workspaceMode);
  params.set("modelProfile", options.modelProfile);
  if (options.workspacePath) params.set("workspacePath", options.workspacePath);
  return `/api/queues/${encodeURIComponent(queueId)}/tasks/${encodeURIComponent(queueTaskId)}/packet?${params.toString()}`;
}

function queueListRows(queueList: unknown): Record<string, unknown>[] {
  const rows = asObject(queueList).queues;
  return Array.isArray(rows) ? rows.map(asObject) : [];
}

function firstQueueId(queues: Record<string, unknown>[]): string | undefined {
  const queueId = queues[0]?.queueId;
  return typeof queueId === "string" && queueId.length > 0 ? queueId : undefined;
}

function hasQueueId(queues: Record<string, unknown>[], queueId: string): boolean {
  return queues.some((queue) => queue.queueId === queueId);
}

function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { ...DESKTOP_SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.byteLength;
    if (bytes > DESKTOP_MAX_JSON_BODY_BYTES) {
      throw Object.assign(new Error("Request body is too large."), { code: "PAYLOAD_TOO_LARGE" });
    }
    body += buffer.toString("utf8");
  }
  if (!body.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw Object.assign(new Error("Malformed JSON body."), { code: "INVALID_JSON" });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("Desktop API body must be a JSON object."), { code: "INVALID_JSON_BODY" });
  }
  return asObject(parsed);
}

function isJsonRequest(request: IncomingMessage): boolean {
  const contentType = request.headers["content-type"];
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  return typeof value === "string" && value.toLowerCase().includes("application/json");
}

function statusForDesktopError(code: string | undefined): number {
  if (code === "PAYLOAD_TOO_LARGE") return 413;
  if (code === "INVALID_JSON" || code === "INVALID_JSON_BODY") return 400;
  return 500;
}

function desktopBridgeRegister(workspaceRoot: string): BridgeRegister {
  return {
    bridgeVersion: "0.1.0",
    agent: {
      id: process.env.AGENT_FABRIC_AGENT_ID ?? "local-cli-desktop",
      displayName: process.env.AGENT_FABRIC_AGENT_NAME ?? "Agent Fabric Console",
      vendor: "local"
    },
    host: {
      name: "Agent Fabric Console Command Center",
      transport: "uds"
    },
    workspace: {
      root: workspaceRoot,
      source: "cwd"
    },
    capabilities: {
      roots: true,
      notifications: false,
      notificationsVisibleToAgent: { declared: "no", observed: "no" },
      sampling: false,
      streamableHttp: false,
      litellmRouteable: false,
      outcomeReporting: "explicit"
    },
    notificationSelfTest: {
      observed: "no",
      detail: "desktop command center uses local HTTP polling"
    },
    testMode: process.env.AGENT_FABRIC_TEST_MODE === "1"
  };
}

function contentType(fileName: string): string {
  const ext = extname(fileName);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

function optionalQuery(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  return value && value.length > 0 ? value : undefined;
}

function boolQuery(url: URL, key: string): boolean | undefined {
  const value = url.searchParams.get(key);
  if (value === null) return undefined;
  return value === "1" || value === "true";
}

function numberQuery(url: URL, key: string): number | undefined {
  const value = url.searchParams.get(key);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arrayFromUnknown(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integerFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function compactStringArray(values: unknown[]): string[] {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function countBy(items: Array<Record<string, unknown>>, key: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const value = stringFromUnknown(item[key]) ?? "unknown";
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function dropUndefined(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}
