import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { FabricClient } from "../client.js";
import { defaultPaths } from "../paths.js";
import type { BridgeRegister, BridgeSession } from "../types.js";
import { bridgeCallContext } from "./bridge-context.js";
import { FabricError } from "./errors.js";
import { maxParallelAgentsLimit, seniorDefaultLaneCount } from "./limits.js";
import { applyPatchWithSystemPatch, resolvePatchFilePath, validateGitStylePatch } from "./patches.js";
import type { ProjectModelRequest } from "./project-cli.js";

type FetchLike = (input: string, init: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  headers?: {
    get: (name: string) => string | null;
  };
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

export type DeepSeekWorkerCommand =
  | {
      command: "model-command";
      json: boolean;
      model: string;
      reasoningEffort: "high" | "max";
      maxTokens: number;
      temperature: number;
	      baseUrl: string;
	      timeoutMs: number;
	      allowSensitiveContext: boolean;
	      sensitiveContextMode: SensitiveContextMode;
	      sensitiveContextModeExplicit: boolean;
	    }
  | {
      command: "run-task";
      json: boolean;
      taskPacketPath: string;
      outputFile?: string;
      role: "implementer" | "reviewer" | "risk-reviewer" | "adjudicator" | "planner";
      model: string;
      reasoningEffort: "high" | "max";
      maxTokens: number;
      temperature: number;
      baseUrl: string;
      timeoutMs: number;
      contextFile?: string;
      fabricTaskId?: string;
	      patchMode: PatchMode;
	      patchFile?: string;
	      allowSensitiveContext: boolean;
	      sensitiveContextMode: SensitiveContextMode;
	      sensitiveContextModeExplicit: boolean;
	    }
  | {
      command: "doctor";
      json: boolean;
      baseUrl: string;
      checkApi: boolean;
      model: string;
      timeoutMs: number;
    }
  | { command: "help"; json: boolean };

type DeepSeekUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
};

type DeepSeekCallResult = {
  content: string;
	  usage: DeepSeekUsage;
	  costUsd: number;
	  costEstimateSource: string;
	  responseId?: string;
	  finishReason?: string;
	};

type PatchMode = "report" | "write" | "apply";
type SensitiveContextMode = "basic" | "strict" | "off";

type RunOptions = {
  stdin?: string;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
};

type QueueBackedDirectRun = {
  client: FabricClient;
  session: BridgeSession;
  queueId: string;
  queueTaskId: string;
  fabricTaskId: string;
  workerRunId: string;
  taskDir: string;
};

type SeniorTaskDirQueueMetadata = {
  schema: "agent-fabric.senior-task-dir-queue.v1";
  queueId: string;
  projectPath: string;
  title: string;
  taskDir: string;
  createdAt: string;
  tasks: Record<string, { queueTaskId: string; fabricTaskId: string; title: string; packetPath: string }>;
};

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_MAX_TOKENS = 32_000;
const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const SENIOR_MODE_ENV = "AGENT_FABRIC_SENIOR_MODE";
const DEEPSEEK_AUTO_QUEUE_ENV = "AGENT_FABRIC_DEEPSEEK_AUTO_QUEUE";
const QUEUE_VISIBLE_ENV = "AGENT_FABRIC_WORKER_QUEUE_VISIBLE";
const DIRECT_OVERRIDE_ENV = "AGENT_FABRIC_DEEPSEEK_ALLOW_UNTRACKED";

export function parseDeepSeekWorkerArgs(argv: string[]): DeepSeekWorkerCommand {
  const args = [...argv];
  const command = args.shift() ?? "help";
  if (command === "help" || command === "--help" || command === "-h") return { command: "help", json: false };
  const flags = parseFlags(args);
  if (command === "model-command") {
    return {
      command: "model-command",
      json: flags.json,
      model: flags.model ?? DEFAULT_MODEL,
      reasoningEffort: parseReasoningEffort(flags.reasoningEffort ?? "max"),
      maxTokens: flags.maxTokens ?? DEFAULT_MAX_TOKENS,
	      temperature: flags.temperature ?? 0,
	      baseUrl: flags.baseUrl ?? DEFAULT_BASE_URL,
	      timeoutMs: flags.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	      allowSensitiveContext: flags.allowSensitiveContext,
	      sensitiveContextMode: parseSensitiveContextMode(flags.sensitiveContextMode, flags.allowSensitiveContext),
	      sensitiveContextModeExplicit: flags.sensitiveContextMode !== undefined
	    };
  }
  if (command === "run-task") {
    return {
      command: "run-task",
      json: flags.json,
      taskPacketPath: required(flags.taskPacketPath, "run-task requires --task-packet <path>"),
      outputFile: flags.outputFile,
      role: parseWorkerRole(flags.role ?? "implementer"),
      model: flags.model ?? DEFAULT_MODEL,
      reasoningEffort: parseReasoningEffort(flags.reasoningEffort ?? "max"),
      maxTokens: flags.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: flags.temperature ?? 0,
      baseUrl: flags.baseUrl ?? DEFAULT_BASE_URL,
      timeoutMs: flags.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      contextFile: flags.contextFile,
      fabricTaskId: flags.fabricTaskId,
	      patchMode: parsePatchMode(flags.patchMode ?? "report"),
	      patchFile: flags.patchFile,
	      allowSensitiveContext: flags.allowSensitiveContext,
	      sensitiveContextMode: parseSensitiveContextMode(flags.sensitiveContextMode, flags.allowSensitiveContext),
	      sensitiveContextModeExplicit: flags.sensitiveContextMode !== undefined
	    };
  }
  if (command === "doctor") {
    return {
      command: "doctor",
      json: flags.json,
      baseUrl: flags.baseUrl ?? DEFAULT_BASE_URL,
      checkApi: flags.checkApi,
      model: flags.model ?? DEFAULT_MODEL,
      timeoutMs: flags.timeoutMs ?? 30_000
    };
  }
  throw new FabricError("INVALID_INPUT", `Unknown deepseek-worker command: ${command}`, false);
}

export async function runDeepSeekWorkerCommand(command: DeepSeekWorkerCommand, options: RunOptions = {}): Promise<Record<string, unknown>> {
  if (command.command === "help") {
    return { help: deepSeekWorkerHelp() };
  }
  if (command.command === "doctor") {
    return runDoctor(command, options);
  }
  if (command.command === "model-command") {
    const request = parseModelRequest(options.stdin ?? "");
    return runProjectModelCommand(command, request, options);
  }
  return runTaskPacket(command, options);
}

export function formatDeepSeekWorkerResult(result: Record<string, unknown>, json: boolean): string {
  if (json) return `${JSON.stringify(result, null, 2)}\n`;
  if (typeof result.help === "string") return `${result.help}\n`;
  if (result.kind === "doctor") {
    return `deepseek worker doctor: apiKey=${result.apiKeyPresent ? "present" : "missing"} baseUrl=${String(result.baseUrl)}${result.apiOk === undefined ? "" : ` apiOk=${String(result.apiOk)}`}\n`;
  }
  if (typeof result.outputFile === "string") {
    return `DeepSeek ${String(result.role ?? "worker")} report written to ${result.outputFile} status=${String(result.status ?? "unknown")} cost=$${String(result.costUsd ?? "0")}\n`;
  }
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function deepSeekWorkerHelp(): string {
  return [
    "agent-fabric-deepseek-worker",
    "",
    "Commands:",
    "  model-command [--model deepseek-v4-pro] [--reasoning-effort max]",
    "  run-task --task-packet <json> [--role implementer|reviewer|risk-reviewer|adjudicator|planner] [--output <file>] [--patch-mode report|write|apply] [--patch-file <file>]",
    "  doctor [--check-api]",
    "",
    "Environment:",
	    "  DEEPSEEK_API_KEY or DEEPSEEK_TOKEN must be set for API calls.",
	    "  Patch mode defaults to report. apply is implementer-only and requires a patch_ready report.",
	    "  Task packets and context files are scanned for common secret patterns unless --allow-sensitive-context is passed.",
	    "  Use --sensitive-context-mode strict to add high-entropy token detection for sanitized review packets.",
	    "  Cost estimates use built-in defaults unless AGENT_FABRIC_DEEPSEEK_PRICING_JSON or AGENT_FABRIC_DEEPSEEK_PRICING_FILE is set.",
	    "  Calls retry transient 429 rate limits and empty JSON content up to 3 attempts.",
    "",
    "Examples:",
    "  AGENT_FABRIC_PROJECT_MODEL_COMMAND='agent-fabric-deepseek-worker model-command' agent-fabric-project generate-tasks --queue <id> --plan-file plan.md",
    "  agent-fabric-project run-ready --queue <id> --worker deepseek-direct --task-packet-dir packets --cwd-template '/tmp/worktrees/{{queueTaskId}}' --parallel 4 --approve-tool-context"
  ].join("\n");
}

async function runDoctor(command: Extract<DeepSeekWorkerCommand, { command: "doctor" }>, options: RunOptions): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  const apiKey = deepSeekApiKey(env);
  const result: Record<string, unknown> = {
    kind: "doctor",
    apiKeyPresent: Boolean(apiKey),
    baseUrl: command.baseUrl,
    model: command.model
  };
  if (!command.checkApi) return result;
  if (!apiKey) throw new FabricError("DEEPSEEK_API_KEY_MISSING", "DEEPSEEK_API_KEY or DEEPSEEK_TOKEN must be set", false);
  const call = await callDeepSeek({
    apiKey,
    baseUrl: command.baseUrl,
    model: command.model,
    reasoningEffort: "high",
    maxTokens: 256,
    temperature: 0,
    timeoutMs: command.timeoutMs,
	    messages: [
	      { role: "system", content: "Return one JSON object only: {\"ok\":true}." },
	      { role: "user", content: "Return JSON now." }
	    ],
	    fetchImpl: options.fetchImpl,
	    env
	  });
	  return { ...result, apiOk: true, usage: call.usage, costUsd: call.costUsd, costEstimateSource: call.costEstimateSource };
}

async function runProjectModelCommand(
  command: Extract<DeepSeekWorkerCommand, { command: "model-command" }>,
  request: ProjectModelRequest,
  options: RunOptions
): Promise<Record<string, unknown>> {
  const apiKey = deepSeekApiKey(options.env ?? process.env);
  if (!apiKey) throw new FabricError("DEEPSEEK_API_KEY_MISSING", "DEEPSEEK_API_KEY or DEEPSEEK_TOKEN must be set", false);
	  assertNoSensitiveContext("model-command stdin", options.stdin ?? "", effectiveSensitiveContextMode(command, options.env ?? process.env));
  const messages =
    request.kind === "prompt_improvement"
      ? promptImprovementMessages(request)
      : taskGenerationMessages(request);
  const call = await callDeepSeek({
    apiKey,
    baseUrl: command.baseUrl,
    model: command.model,
    reasoningEffort: command.reasoningEffort,
    maxTokens: command.maxTokens,
    temperature: command.temperature,
    timeoutMs: command.timeoutMs,
	    messages,
	    fetchImpl: options.fetchImpl,
	    env: options.env ?? process.env
	  });
  const parsed = parseJsonObject(call.content, "DeepSeek model-command response");
  const data =
    request.kind === "prompt_improvement"
      ? normalizePromptImprovement(parsed)
      : normalizeTaskGeneration(parsed);
  return {
    ...data,
    _meta: {
      provider: "deepseek",
      model: command.model,
      reasoningEffort: command.reasoningEffort,
	      usage: call.usage,
	      costUsd: call.costUsd,
	      costEstimateSource: call.costEstimateSource,
	      responseId: call.responseId,
      finishReason: call.finishReason
    }
  };
}

async function runTaskPacket(command: Extract<DeepSeekWorkerCommand, { command: "run-task" }>, options: RunOptions): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  assertSeniorDirectRunTracked(env);
  const envFabricTaskId = typeof env.AGENT_FABRIC_FABRIC_TASK_ID === "string" && env.AGENT_FABRIC_FABRIC_TASK_ID.length > 0 ? env.AGENT_FABRIC_FABRIC_TASK_ID : undefined;
  const apiKey = deepSeekApiKey(env);
  if (!apiKey) throw new FabricError("DEEPSEEK_API_KEY_MISSING", "DEEPSEEK_API_KEY or DEEPSEEK_TOKEN must be set", false);
  const packetText = readFileSync(command.taskPacketPath, "utf8");
  const packet = parseTaskPacket(packetText, command.taskPacketPath);
  const contextText = command.contextFile ? readFileSync(command.contextFile, "utf8") : undefined;
	  const sensitiveContextMode = effectiveSensitiveContextMode(command, env);
	  assertNoSensitiveContext(command.taskPacketPath, packetText, sensitiveContextMode);
	  if (contextText !== undefined) assertNoSensitiveContext(command.contextFile ?? "context file", contextText, sensitiveContextMode);
  const queueRun = await maybeStartQueueBackedDirectRun(command, packet, options);
  const messages = taskPacketMessages(command.role, packet, packetText, contextText);
  try {
    const call = await callDeepSeek({
      apiKey,
      baseUrl: command.baseUrl,
      model: command.model,
      reasoningEffort: command.reasoningEffort,
      maxTokens: command.maxTokens,
      temperature: command.temperature,
      timeoutMs: command.timeoutMs,
	      messages,
	      fetchImpl: options.fetchImpl,
	      env
	    });
    const parsed = normalizeTaskReport(parseJsonObject(call.content, "DeepSeek run-task response"));
    const outputFile = command.outputFile ?? defaultOutputFile(command, packet, options.cwd ?? process.cwd(), env);
    const patchAction = await handleProposedPatch(command, parsed, outputFile, options.cwd ?? process.cwd());
    const artifact = {
      schema: "agent-fabric.deepseek-worker-result.v1",
      role: command.role,
      provider: "deepseek",
      model: command.model,
      reasoningEffort: command.reasoningEffort,
      taskPacketPath: command.taskPacketPath,
      fabricTaskId: queueRun?.fabricTaskId ?? command.fabricTaskId ?? envFabricTaskId ?? getNestedString(packet, ["task", "fabricTaskId"]),
      queueTaskId: queueRun?.queueTaskId ?? getNestedString(packet, ["task", "queueTaskId"]),
      status: parsed.status,
      result: parsed,
      patchMode: command.patchMode,
      patchFile: patchAction.patchFile,
	      patchApply: patchAction.patchApply,
	      usage: call.usage,
	      costUsd: call.costUsd,
	      costEstimateSource: call.costEstimateSource,
	      responseId: call.responseId,
      finishReason: call.finishReason
    };
    mkdirSync(dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    await finishQueueBackedDirectRun(queueRun, parsed, artifact, outputFile, patchAction.patchFile);
    return {
      kind: "run-task",
      role: command.role,
      status: parsed.status,
      outputFile,
      patchMode: command.patchMode,
      patchFile: patchAction.patchFile,
	      patchApply: patchAction.patchApply,
	      costUsd: call.costUsd,
	      costEstimateSource: call.costEstimateSource,
	      usage: call.usage,
      queueTaskId: artifact.queueTaskId,
      fabricTaskId: artifact.fabricTaskId,
      workerRunId: queueRun?.workerRunId,
      queueBacked: queueRun
        ? { queueId: queueRun.queueId, queueTaskId: queueRun.queueTaskId, fabricTaskId: queueRun.fabricTaskId, workerRunId: queueRun.workerRunId }
        : undefined,
      untrackedSeniorDirect: queueRun ? undefined : seniorUntrackedOverride(env) || undefined,
      summary: parsed.summary
    };
  } catch (error) {
    await failQueueBackedDirectRun(queueRun, error);
    throw error;
  }
}

function assertSeniorDirectRunTracked(env: NodeJS.ProcessEnv): void {
  if (env[SENIOR_MODE_ENV] !== "permissive") return;
  if (truthyEnv(env[QUEUE_VISIBLE_ENV]) || truthyEnv(env.AGENT_FABRIC_QUEUE_VISIBLE)) return;
  if (seniorUntrackedOverride(env)) return;
  const autoQueueMode = String(env[DEEPSEEK_AUTO_QUEUE_ENV] ?? "auto").toLowerCase();
  const autoQueueDisabled = ["0", "false", "off", "no", "disabled"].includes(autoQueueMode);
  if (!autoQueueDisabled && env.TASK_DIR) return;
  throw new FabricError(
    "DEEPSEEK_UNTRACKED_SENIOR_RUN",
    [
      "Senior-mode DeepSeek direct run is not queue-visible.",
      "Launch it through agent-fabric-project run-ready/senior-run, keep auto queueing enabled with TASK_DIR, or set AGENT_FABRIC_DEEPSEEK_ALLOW_UNTRACKED=1 for an explicit local escape hatch.",
      "Untracked direct runs do not count as Senior DeepSeek lanes."
    ].join(" "),
    false
  );
}

function seniorUntrackedOverride(env: NodeJS.ProcessEnv): boolean {
  return truthyEnv(env[DIRECT_OVERRIDE_ENV]) || truthyEnv(env.AGENT_FABRIC_WORKER_DIRECT_OVERRIDE);
}

function truthyEnv(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

async function maybeStartQueueBackedDirectRun(
  command: Extract<DeepSeekWorkerCommand, { command: "run-task" }>,
  packet: Record<string, unknown>,
  options: RunOptions
): Promise<QueueBackedDirectRun | undefined> {
  const env = options.env ?? process.env;
  const taskDir = seniorTaskDir(env);
  if (!taskDir) return undefined;
  const cwd = options.cwd ?? process.cwd();
  const client = new FabricClient(env.AGENT_FABRIC_SOCKET ?? defaultPaths().socketPath);
  const session = await registerQueueBackedDirectWorker(client, env, cwd);
  const metadata = await ensureSeniorTaskDirQueue(client, session, taskDir, packet, command.taskPacketPath, env, cwd);
  const taskKey = taskPacketKey(packet, command.taskPacketPath);
  const task = metadata.tasks[taskKey] ?? (await addSeniorPacketTask(client, session, metadata, packet, command.taskPacketPath, taskKey));
  const workspaceMode = command.patchMode === "report" ? "sandbox" : "git_worktree";
  const worker = await fabricCall<Record<string, unknown>>(client, session, "fabric_task_start_worker", {
    taskId: task.fabricTaskId,
    worker: "deepseek-direct",
    projectPath: metadata.projectPath,
    workspaceMode,
    workspacePath: cwd,
    modelProfile: command.model,
    contextPolicy: "senior-mode:queue-backed-direct",
    command: ["agent-fabric-deepseek-worker", "run-task", "--task-packet", command.taskPacketPath],
    metadata: {
      source: "deepseek-worker-direct-senior",
      role: command.role,
      taskDir,
      taskPacketPath: command.taskPacketPath,
      patchMode: command.patchMode,
      externalTaskKey: taskKey,
      queueBacked: true
    }
  });
  const workerRunId = String(worker.workerRunId ?? "");
  if (!workerRunId) throw new FabricError("DEEPSEEK_QUEUE_BACKING_FAILED", "fabric_task_start_worker did not return workerRunId", true);
  await fabricCall(client, session, "project_queue_assign_worker", {
    queueId: metadata.queueId,
    queueTaskId: task.queueTaskId,
    workerRunId
  });
  await fabricCall(client, session, "fabric_task_event", {
    taskId: task.fabricTaskId,
    workerRunId,
    kind: "started",
    body: "Senior-mode DeepSeek direct run registered as a queue-backed worker lane.",
    metadata: { queueId: metadata.queueId, queueTaskId: task.queueTaskId, taskDir, taskPacketPath: command.taskPacketPath, role: command.role }
  });
  return {
    client,
    session,
    queueId: metadata.queueId,
    queueTaskId: task.queueTaskId,
    fabricTaskId: task.fabricTaskId,
    workerRunId,
    taskDir
  };
}

function seniorTaskDir(env: NodeJS.ProcessEnv): string | undefined {
  const mode = String(env.AGENT_FABRIC_DEEPSEEK_AUTO_QUEUE ?? "auto").toLowerCase();
  if (["0", "false", "off", "no", "disabled"].includes(mode)) return undefined;
  if (env.AGENT_FABRIC_SENIOR_MODE !== "permissive" && mode !== "required") return undefined;
  if (!env.TASK_DIR) {
    if (mode === "required") {
      throw new FabricError("DEEPSEEK_QUEUE_BACKING_REQUIRED", "AGENT_FABRIC_DEEPSEEK_AUTO_QUEUE=required needs TASK_DIR to create queue-backed lanes.", false);
    }
    return undefined;
  }
  return resolve(env.TASK_DIR);
}

async function ensureSeniorTaskDirQueue(
  client: FabricClient,
  session: BridgeSession,
  taskDir: string,
  packet: Record<string, unknown>,
  taskPacketPath: string,
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<SeniorTaskDirQueueMetadata> {
  mkdirSync(taskDir, { recursive: true });
  const metadataPath = seniorQueueMetadataPath(taskDir);
  const lockDir = join(taskDir, ".agent-fabric-queue.lock");
  return withDirectoryLock(lockDir, async () => {
    const existing = readSeniorQueueMetadata(metadataPath);
    if (existing) return existing;
    const projectPath = seniorProjectPath(packet, env, cwd);
    const title = env.AGENT_FABRIC_QUEUE_TITLE || `Senior DeepSeek lanes: ${basename(taskDir)}`;
    const queue = await fabricCall<Record<string, unknown>>(client, session, "project_queue_create", {
      projectPath,
      title,
      promptSummary: seniorPromptSummary(packet, taskDir),
      pipelineProfile: "careful",
      maxParallelAgents: seniorMaxParallelAgents(env)
    });
    const queueId = String(queue.queueId ?? "");
    if (!queueId) throw new FabricError("DEEPSEEK_QUEUE_BACKING_FAILED", "project_queue_create did not return queueId", true);
    const packets = seniorTaskDirPackets(taskDir, packet, taskPacketPath);
    const added = await fabricCall<Record<string, unknown>>(client, session, "project_queue_add_tasks", {
      queueId,
      tasks: packets.map((entry) => queueTaskFromPacket(entry.packet, entry.path))
    });
    const created = Array.isArray(added.created) ? added.created : [];
    const tasks: SeniorTaskDirQueueMetadata["tasks"] = {};
    for (const item of created) {
      const record = asRecord(item);
      const key = typeof record.clientKey === "string" ? record.clientKey : "";
      const queueTaskId = typeof record.queueTaskId === "string" ? record.queueTaskId : "";
      const fabricTaskId = typeof record.fabricTaskId === "string" ? record.fabricTaskId : "";
      if (!key || !queueTaskId || !fabricTaskId) continue;
      const source = packets.find((entry) => taskPacketKey(entry.packet, entry.path) === key);
      tasks[key] = { queueTaskId, fabricTaskId, title: typeof record.title === "string" ? record.title : key, packetPath: source?.path ?? "" };
    }
    await fabricCall(client, session, "project_queue_decide", {
      queueId,
      decision: "start_execution",
      note: "Started automatically for Senior-mode DeepSeek TASK_DIR lanes."
    });
    const metadata: SeniorTaskDirQueueMetadata = {
      schema: "agent-fabric.senior-task-dir-queue.v1",
      queueId,
      projectPath,
      title,
      taskDir,
      createdAt: new Date().toISOString(),
      tasks
    };
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    return metadata;
  });
}

async function addSeniorPacketTask(
  client: FabricClient,
  session: BridgeSession,
  metadata: SeniorTaskDirQueueMetadata,
  packet: Record<string, unknown>,
  taskPacketPath: string,
  taskKey: string
): Promise<{ queueTaskId: string; fabricTaskId: string; title: string; packetPath: string }> {
  const lockDir = join(metadata.taskDir, `.agent-fabric-task-${safeFilePart(taskKey)}.lock`);
  return withDirectoryLock(lockDir, async () => {
    const current = readSeniorQueueMetadata(seniorQueueMetadataPath(metadata.taskDir)) ?? metadata;
    if (current.tasks[taskKey]) return current.tasks[taskKey];
    const added = await fabricCall<Record<string, unknown>>(client, session, "project_queue_add_tasks", {
      queueId: current.queueId,
      tasks: [queueTaskFromPacket(packet, taskPacketPath)]
    });
    const record = asRecord(Array.isArray(added.created) ? added.created[0] : undefined);
    const task = {
      queueTaskId: String(record.queueTaskId ?? ""),
      fabricTaskId: String(record.fabricTaskId ?? ""),
      title: String(record.title ?? taskKey),
      packetPath: taskPacketPath
    };
    if (!task.queueTaskId || !task.fabricTaskId) throw new FabricError("DEEPSEEK_QUEUE_BACKING_FAILED", "project_queue_add_tasks did not return task ids", true);
    current.tasks[taskKey] = task;
    writeFileSync(seniorQueueMetadataPath(metadata.taskDir), `${JSON.stringify(current, null, 2)}\n`, "utf8");
    await fabricCall(client, session, "project_queue_decide", {
      queueId: current.queueId,
      decision: "start_execution",
      note: "Resumed execution after adding a late Senior-mode DeepSeek packet."
    });
    return task;
  });
}

async function finishQueueBackedDirectRun(
  queueRun: QueueBackedDirectRun | undefined,
  parsed: Record<string, unknown>,
  artifact: Record<string, unknown>,
  outputFile: string,
  patchFile?: string
): Promise<void> {
  if (!queueRun) return;
  const summary = typeof parsed.summary === "string" ? parsed.summary : "DeepSeek direct worker completed.";
  const status = queueTaskStatusForDeepSeekStatus(String(parsed.status || ""));
  const changedFiles = stringArray(parsed.changedFilesSuggested);
  const tests = stringArray(parsed.testsSuggested);
  const refs = uniqueStrings([outputFile, patchFile, ...changedFiles].filter((value): value is string => Boolean(value)));
  await fabricCall(queueRun.client, queueRun.session, "fabric_task_checkpoint", {
    taskId: queueRun.fabricTaskId,
    workerRunId: queueRun.workerRunId,
    summary: {
      currentGoal: "Senior-mode DeepSeek direct lane.",
      filesTouched: refs,
      commandsRun: ["agent-fabric-deepseek-worker run-task"],
      testsRun: tests,
      failingTests: [],
      decisions: [],
      assumptions: [],
      blockers: stringArray(parsed.blockers),
      nextAction: status === "failed" ? "Inspect DeepSeek result and retry or split the lane." : "Review queue-backed DeepSeek result.",
      structuredResult: artifact
    }
  });
  await fabricCall(queueRun.client, queueRun.session, "fabric_task_event", {
    taskId: queueRun.fabricTaskId,
    workerRunId: queueRun.workerRunId,
    kind: status === "failed" ? "failed" : status === "completed" ? "completed" : "patch_ready",
    body: summary,
    refs,
    metadata: { taskDir: queueRun.taskDir, queueBacked: true, deepseekStatus: parsed.status }
  });
  await fabricCall(queueRun.client, queueRun.session, "project_queue_update_task", {
    queueId: queueRun.queueId,
    queueTaskId: queueRun.queueTaskId,
    workerRunId: queueRun.workerRunId,
    status,
    summary,
    patchRefs: refs,
    testRefs: tests
  });
}

async function failQueueBackedDirectRun(queueRun: QueueBackedDirectRun | undefined, error: unknown): Promise<void> {
  if (!queueRun) return;
  const message = error instanceof Error ? error.message : String(error);
  await fabricCall(queueRun.client, queueRun.session, "fabric_task_event", {
    taskId: queueRun.fabricTaskId,
    workerRunId: queueRun.workerRunId,
    kind: "failed",
    body: message,
    metadata: { taskDir: queueRun.taskDir, queueBacked: true }
  }).catch(() => undefined);
  await fabricCall(queueRun.client, queueRun.session, "project_queue_update_task", {
    queueId: queueRun.queueId,
    queueTaskId: queueRun.queueTaskId,
    workerRunId: queueRun.workerRunId,
    status: "failed",
    summary: message,
    patchRefs: [],
    testRefs: []
  }).catch(() => undefined);
}

function queueTaskStatusForDeepSeekStatus(status: string): string {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "blocked") return "failed";
  return "patch_ready";
}

async function registerQueueBackedDirectWorker(client: FabricClient, env: NodeJS.ProcessEnv, cwd: string): Promise<BridgeSession> {
  const payload: BridgeRegister = {
    bridgeVersion: "0.1.0",
    agent: {
      id: env.AGENT_FABRIC_AGENT_ID ?? "deepseek-direct-senior",
      displayName: env.AGENT_FABRIC_AGENT_NAME ?? "DeepSeek direct Senior worker",
      vendor: "deepseek"
    },
    host: { name: "DeepSeek Direct Worker", transport: "uds" },
    workspace: { root: env.AGENT_FABRIC_WORKSPACE_ROOT ?? cwd, source: env.AGENT_FABRIC_WORKSPACE_ROOT ? "explicit" : "cwd" },
    capabilities: {
      roots: false,
      notifications: false,
      notificationsVisibleToAgent: { declared: "no", observed: "no" },
      sampling: false,
      streamableHttp: false,
      litellmRouteable: false,
      outcomeReporting: "explicit"
    },
    notificationSelfTest: { observed: "no", detail: "DeepSeek direct worker is request/response only" },
    testMode: env.AGENT_FABRIC_TEST_MODE === "1"
  };
  try {
    return await client.register(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FabricError(
      "DEEPSEEK_QUEUE_BACKING_FAILED",
      `Senior-mode TASK_DIR DeepSeek lanes must be queue-backed, but agent-fabric registration failed: ${message}. Start the daemon or set AGENT_FABRIC_DEEPSEEK_AUTO_QUEUE=off to intentionally allow file-only lanes.`,
      true
    );
  }
}

async function fabricCall<T>(client: FabricClient, session: BridgeSession, tool: string, input: Record<string, unknown>): Promise<T> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) cleaned[key] = value;
  }
  return client.call<T>(tool, cleaned, bridgeCallContext(session, { tool, input: cleaned }));
}

function seniorTaskDirPackets(taskDir: string, currentPacket: Record<string, unknown>, currentPath: string): Array<{ path: string; packet: Record<string, unknown> }> {
  const entries: Array<{ path: string; packet: Record<string, unknown> }> = [];
  for (const name of readdirSync(taskDir)) {
    if (!name.endsWith(".json") || name.endsWith(".result.json") || name.endsWith(".stdout.json")) continue;
    const path = join(taskDir, name);
    try {
      const parsed = parseTaskPacket(readFileSync(path, "utf8"), path);
      const task = asRecord(parsed.task);
      if (task.queueTaskId || task.clientKey || task.title || task.goal) entries.push({ path, packet: parsed });
    } catch {
      continue;
    }
  }
  if (!entries.some((entry) => resolve(entry.path) === resolve(currentPath))) entries.push({ path: currentPath, packet: currentPacket });
  return entries;
}

function queueTaskFromPacket(packet: Record<string, unknown>, taskPacketPath: string): Record<string, unknown> {
  const task = asRecord(packet.task);
  const title = typeof task.title === "string" && task.title.trim() ? task.title.trim() : taskPacketKey(packet, taskPacketPath);
  const goal = typeof task.goal === "string" && task.goal.trim() ? task.goal.trim() : title;
  return {
    clientKey: taskPacketKey(packet, taskPacketPath),
    title,
    goal,
    phase: typeof task.phase === "string" ? task.phase : "senior-mode",
    category: typeof task.category === "string" ? task.category : "deepseek-direct",
    priority: normalizeEnum(task.priority, ["low", "normal", "high", "urgent"], "high"),
    risk: normalizeEnum(task.risk, ["low", "medium", "high", "breakglass"], "medium"),
    parallelSafe: typeof task.parallelSafe === "boolean" ? task.parallelSafe : true,
    expectedFiles: stringArray(task.expectedFiles),
    acceptanceCriteria: stringArray(task.acceptanceCriteria),
    requiredTools: uniqueStrings(["shell", ...stringArray(task.requiredTools)]),
    requiredMcpServers: stringArray(task.requiredMcpServers),
    requiredMemories: stringArray(task.requiredMemories),
    requiredContextRefs: stringArray(task.requiredContextRefs),
    dependsOn: stringArray(task.dependsOn)
  };
}

function taskPacketKey(packet: Record<string, unknown>, taskPacketPath: string): string {
  return getNestedString(packet, ["task", "queueTaskId"]) ?? getNestedString(packet, ["task", "clientKey"]) ?? basename(taskPacketPath).replace(/\.json$/i, "");
}

function seniorProjectPath(packet: Record<string, unknown>, env: NodeJS.ProcessEnv, cwd: string): string {
  return env.AGENT_FABRIC_PROJECT_PATH ?? getNestedString(packet, ["queue", "projectPath"]) ?? getNestedString(packet, ["queue", "project_path"]) ?? cwd;
}

function seniorPromptSummary(packet: Record<string, unknown>, taskDir: string): string {
  const goal = getNestedString(packet, ["task", "goal"]);
  const summary = goal ? goal.slice(0, 600) : `Senior-mode DeepSeek lanes from ${taskDir}`;
  return summary.trim() || `Senior-mode DeepSeek lanes from ${taskDir}`;
}

function seniorMaxParallelAgents(env: NodeJS.ProcessEnv): number {
  return Math.min(maxParallelAgentsLimit(env), seniorDefaultLaneCount(env));
}

function seniorQueueMetadataPath(taskDir: string): string {
  return join(taskDir, ".agent-fabric-queue.json");
}

function readSeniorQueueMetadata(path: string): SeniorTaskDirQueueMetadata | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as SeniorTaskDirQueueMetadata;
    if (record.schema !== "agent-fabric.senior-task-dir-queue.v1" || !record.queueId || !record.taskDir) return undefined;
    return record;
  } catch {
    return undefined;
  }
}

async function withDirectoryLock<T>(lockDir: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      mkdirSync(lockDir, { recursive: false });
      try {
        return await run();
      } finally {
        rmSync(lockDir, { recursive: true, force: true });
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "EEXIST") throw error;
      await delay(100);
    }
  }
  throw new FabricError("DEEPSEEK_QUEUE_BACKING_LOCKED", `Timed out waiting for queue backing lock ${lockDir}`, true);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function promptImprovementMessages(request: ProjectModelRequest): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: [
        "You improve rough project prompts for agent-fabric project queues.",
        "Return strict JSON only. The JSON object must match this example:",
        "{\"improvedPrompt\":\"...\",\"summary\":\"...\",\"warnings\":[\"...\"]}",
        "Preserve explicit user intent, constraints, approvals, and forbidden actions.",
        "Make the prompt executable: include acceptance criteria, quality gates, worker/reviewer lanes, and edge cases."
      ].join("\n")
    },
    {
      role: "user",
      content: `Improve this queue prompt as JSON.\n\n${JSON.stringify(request, null, 2)}`
    }
  ];
}

function taskGenerationMessages(request: ProjectModelRequest): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: [
        "You split a project plan into an agent-fabric task DAG.",
        "Return strict JSON only. The JSON object must match this example:",
        "{\"phases\":[{\"name\":\"...\"}],\"tasks\":[{\"clientKey\":\"impl-a\",\"title\":\"...\",\"goal\":\"...\",\"phase\":\"implementation\",\"category\":\"implementer\",\"priority\":\"high\",\"risk\":\"medium\",\"parallelSafe\":true,\"expectedFiles\":[\"src/example.ts\"],\"acceptanceCriteria\":[\"Tests pass\"],\"requiredTools\":[\"shell\"],\"requiredMcpServers\":[],\"dependsOn\":[]}]}.",
        "Use small independent tasks with disjoint expected files where possible.",
        "Add reviewer and risk-reviewer tasks for high-impact implementation tasks.",
        "Do not invent secrets. Do not require broad MCP access unless the task needs it."
      ].join("\n")
    },
    {
      role: "user",
      content: `Generate queue tasks as JSON.\n\n${JSON.stringify(request, null, 2)}`
    }
  ];
}

function taskPacketMessages(
  role: "implementer" | "reviewer" | "risk-reviewer" | "adjudicator" | "planner",
  packet: Record<string, unknown>,
  packetText: string,
  contextText?: string
): Array<{ role: "system" | "user"; content: string }> {
  const roleInstruction = {
    implementer: "Produce a precise implementation packet. Include proposed patches only when you can make them concrete from the supplied context.",
    reviewer: "Review the task or proposed patch. Focus on correctness bugs, integration risks, and missing tests.",
    "risk-reviewer": "Review blast radius, security, concurrency, cost, token/context, and operational risks.",
    adjudicator: "Combine implementer and reviewer evidence into a decision: accept, revise, split, retry, or escalate.",
    planner: "Refine the task into executable substeps and handoff guidance."
  }[role];
  return [
    {
      role: "system",
      content: [
        `You are a DeepSeek V4 Pro ${role} lane inside agent-fabric.`,
        roleInstruction,
        "Return strict JSON only. The JSON object must match this example:",
        "{\"status\":\"patch_ready\",\"summary\":\"...\",\"findings\":[],\"proposedPatch\":\"\",\"changedFilesSuggested\":[],\"commandsSuggested\":[],\"testsSuggested\":[],\"risks\":[],\"followups\":[],\"handover\":\"...\"}",
        "If you include proposedPatch, make it a git-style unified diff with diff --git headers and relative paths only.",
        "Never claim tests passed unless supplied evidence proves it.",
        "Prefer specific file paths, commands, and acceptance checks over generic advice."
      ].join("\n")
    },
    {
      role: "user",
      content: [
        "Task packet JSON/text:",
        packetText,
        "",
        "Parsed packet summary:",
        JSON.stringify(packet, null, 2),
        contextText ? `\nAdditional context:\n${contextText}` : "",
        "",
        "Return the result as JSON."
      ].join("\n")
    }
  ];
}

async function callDeepSeek(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  reasoningEffort: "high" | "max";
  maxTokens: number;
  temperature: number;
	  timeoutMs: number;
	  messages: Array<{ role: "system" | "user"; content: string }>;
	  fetchImpl?: FetchLike;
	  env?: NodeJS.ProcessEnv;
	}): Promise<DeepSeekCallResult> {
  const fetchImpl = input.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!fetchImpl) throw new FabricError("FETCH_UNAVAILABLE", "global fetch is unavailable in this Node runtime", false);
  const url = `${input.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  for (let attempt = 1; attempt <= DEFAULT_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${input.apiKey}`
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: input.model,
          messages: input.messages,
          thinking: {
            type: "enabled",
            reasoning_effort: input.reasoningEffort
          },
          response_format: { type: "json_object" },
          max_tokens: input.maxTokens,
          temperature: input.temperature,
          stream: false
        })
      });
      if (!response.ok) {
        const body = await response.text();
        if (response.status === 429 && attempt < DEFAULT_MAX_ATTEMPTS) {
          await sleep(deepSeekRetryDelayMs(response, attempt));
          continue;
        }
        const code = response.status === 429 ? "DEEPSEEK_RATE_LIMITED" : "DEEPSEEK_API_ERROR";
        const suffix = response.status === 429 ? ` after ${attempt} attempts` : "";
        throw new FabricError(code, `DeepSeek API returned ${response.status}${suffix}: ${body.slice(0, 500)}`, response.status === 429);
      }
      const data = (await response.json()) as Record<string, unknown>;
      const choice = firstChoice(data);
      const message = asRecord(choice.message);
      const content = typeof message.content === "string" ? message.content : "";
      if (!content.trim()) {
        if (attempt < DEFAULT_MAX_ATTEMPTS) {
          await sleep(deepSeekRetryDelayMs(response, attempt));
          continue;
        }
        throw new FabricError("DEEPSEEK_EMPTY_CONTENT", `DeepSeek returned empty content after ${attempt} attempts; retry with a clearer JSON prompt or higher max tokens`, true);
      }
	      const usage = asRecord(data.usage) as DeepSeekUsage;
	      const costEstimate = estimateDeepSeekCost(input.model, usage, input.env ?? process.env);
	      return {
	        content,
	        usage,
	        costUsd: costEstimate.costUsd,
	        costEstimateSource: costEstimate.source,
	        responseId: typeof data.id === "string" ? data.id : undefined,
        finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : undefined
      };
    } catch (error) {
      if (error instanceof FabricError) throw error;
      const record = error as { name?: string; message?: string };
      if (record.name === "AbortError") {
        throw new FabricError("DEEPSEEK_TIMEOUT", `DeepSeek API call timed out after ${input.timeoutMs} ms`, true);
      }
      throw new FabricError("DEEPSEEK_CALL_FAILED", record.message ?? String(error), true);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new FabricError("DEEPSEEK_CALL_FAILED", "DeepSeek call exhausted retry attempts", true);
}

function deepSeekRetryDelayMs(response: { headers?: { get: (name: string) => string | null } }, attempt: number): number {
  const retryAfter = response.headers?.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 2_000);
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) return Math.min(Math.max(0, timestamp - Date.now()), 2_000);
  }
  return Math.min(50 * 2 ** (attempt - 1), 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

type SensitiveContextFinding = {
  label: string;
  pattern: string;
  index: number;
};

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "private-key-block", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
  { name: "openai-style-secret-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { name: "bearer-token", pattern: /\bBearer\s+(?!<|test\b|example\b|redacted\b|placeholder\b)[A-Za-z0-9._~+/=-]{24,}\b/gi },
  {
    name: "secret-assignment",
    pattern:
      /\b(?:api[_-]?key|secret|token|password|client[_-]?secret|authorization)\b\s*[:=]\s*['"]?(?!<|test\b|example\b|redacted\b|placeholder\b|xxxx\b)[A-Za-z0-9_./+=:-]{24,}/gi
  }
];

const STRICT_SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "jwt-token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "generic-live-key", pattern: /\b(?:live|prod|production)[_-]?[A-Za-z0-9_./+=:-]{32,}\b/gi }
];

function assertNoSensitiveContext(label: string, text: string, mode: SensitiveContextMode): void {
  if (mode === "off" || !text) return;
  const findings = scanSensitiveContext(label, text, mode);
  if (findings.length === 0) return;
  const summary = findings
    .slice(0, 5)
    .map((finding) => `${finding.label}:${finding.pattern}@${finding.index}`)
    .join(", ");
  throw new FabricError(
    "SENSITIVE_CONTEXT_DETECTED",
    `DeepSeek context appears to contain sensitive material (${summary}). Redact the packet/context or pass --allow-sensitive-context for an explicit override.`,
    false
  );
}

function scanSensitiveContext(label: string, text: string, mode: SensitiveContextMode): SensitiveContextFinding[] {
  const findings: SensitiveContextFinding[] = [];
  for (const secretPattern of mode === "strict" ? [...SECRET_PATTERNS, ...STRICT_SECRET_PATTERNS] : SECRET_PATTERNS) {
    secretPattern.pattern.lastIndex = 0;
    for (const match of text.matchAll(secretPattern.pattern)) {
      findings.push({ label, pattern: secretPattern.name, index: match.index ?? 0 });
      if (findings.length >= 10) return findings;
    }
  }
  if (mode === "strict") {
    for (const finding of highEntropyFindings(label, text)) {
      findings.push(finding);
      if (findings.length >= 10) return findings;
    }
  }
  return findings;
}

function highEntropyFindings(label: string, text: string): SensitiveContextFinding[] {
  const findings: SensitiveContextFinding[] = [];
  const tokenPattern = /\b[A-Za-z0-9_+/=-]{36,200}\b/g;
  for (const match of text.matchAll(tokenPattern)) {
    const token = match[0];
    if (!/[A-Za-z]/.test(token) || !/[0-9]/.test(token)) continue;
    if (/^[a-f0-9]{36,}$/i.test(token)) continue;
    if (shannonEntropy(token) < 4.25) continue;
    findings.push({ label, pattern: "high-entropy-token", index: match.index ?? 0 });
  }
  return findings;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function parseModelRequest(stdin: string): ProjectModelRequest {
  const parsed = parseJsonObject(stdin, "model-command stdin");
  if (parsed.kind !== "prompt_improvement" && parsed.kind !== "task_generation") {
    throw new FabricError("INVALID_INPUT", "model-command stdin must contain kind prompt_improvement or task_generation", false);
  }
  return parsed as unknown as ProjectModelRequest;
}

function normalizePromptImprovement(input: Record<string, unknown>): Record<string, unknown> {
  const improvedPrompt = typeof input.improvedPrompt === "string" ? input.improvedPrompt : "";
  if (!improvedPrompt.trim()) throw new FabricError("DEEPSEEK_INVALID_OUTPUT", "DeepSeek response missing improvedPrompt", true);
  return {
    improvedPrompt,
    summary: typeof input.summary === "string" ? input.summary : "Prompt improved by DeepSeek direct worker.",
    warnings: stringArray(input.warnings)
  };
}

function normalizeTaskGeneration(input: Record<string, unknown>): Record<string, unknown> {
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  if (tasks.length === 0) throw new FabricError("DEEPSEEK_INVALID_OUTPUT", "DeepSeek response missing tasks array", true);
  return {
    phases: Array.isArray(input.phases) ? input.phases : [],
    tasks: tasks.map((task, index) => normalizeGeneratedTask(asRecord(task), index))
  };
}

function normalizeGeneratedTask(task: Record<string, unknown>, index: number): Record<string, unknown> {
  const title = typeof task.title === "string" && task.title.trim() ? task.title : `Generated task ${index + 1}`;
  const goal = typeof task.goal === "string" && task.goal.trim() ? task.goal : title;
  return {
    clientKey: typeof task.clientKey === "string" ? task.clientKey : `deepseek-${index + 1}`,
    title,
    goal,
    phase: typeof task.phase === "string" ? task.phase : undefined,
    category: typeof task.category === "string" ? task.category : undefined,
    priority: normalizeEnum(task.priority, ["low", "normal", "high", "urgent"], "normal"),
    risk: normalizeEnum(task.risk, ["low", "medium", "high", "breakglass"], "medium"),
    parallelSafe: typeof task.parallelSafe === "boolean" ? task.parallelSafe : true,
    expectedFiles: stringArray(task.expectedFiles),
    acceptanceCriteria: stringArray(task.acceptanceCriteria),
    requiredTools: stringArray(task.requiredTools),
    requiredMcpServers: stringArray(task.requiredMcpServers),
    requiredMemories: stringArray(task.requiredMemories),
    requiredContextRefs: stringArray(task.requiredContextRefs),
    dependsOn: stringArray(task.dependsOn)
  };
}

function normalizeTaskReport(input: Record<string, unknown>): Record<string, unknown> {
  return {
    status: normalizeEnum(input.status, ["patch_ready", "needs_review", "blocked", "failed", "completed"], "needs_review"),
    summary: typeof input.summary === "string" ? input.summary : "DeepSeek worker returned a structured report.",
    findings: arrayValue(input.findings),
    proposedPatch: typeof input.proposedPatch === "string" ? input.proposedPatch : "",
    changedFilesSuggested: stringArray(input.changedFilesSuggested),
    commandsSuggested: stringArray(input.commandsSuggested),
    testsSuggested: stringArray(input.testsSuggested),
    risks: arrayValue(input.risks),
    followups: arrayValue(input.followups),
    handover: typeof input.handover === "string" ? input.handover : ""
  };
}

async function handleProposedPatch(
  command: Extract<DeepSeekWorkerCommand, { command: "run-task" }>,
  report: Record<string, unknown>,
  outputFile: string,
  cwd: string
): Promise<{ patchFile?: string; patchApply?: Record<string, unknown> }> {
  const proposedPatch = typeof report.proposedPatch === "string" ? report.proposedPatch.trim() : "";
  if (command.patchMode === "report" || !proposedPatch) return {};
  if (command.patchMode === "apply") {
    if (command.role !== "implementer") {
      throw new FabricError("PATCH_APPLY_REJECTED", "patch-mode apply is only allowed for implementer task reports", false);
    }
    if (report.status !== "patch_ready") {
      throw new FabricError("PATCH_APPLY_REJECTED", "patch-mode apply requires a patch_ready task report", false);
    }
  }
  validateGitStylePatch(proposedPatch, cwd);
  const patchFile = resolvePatchFilePath(command.patchFile, outputFile, cwd);
  mkdirSync(dirname(patchFile), { recursive: true });
  writeFileSync(patchFile, `${proposedPatch}\n`, "utf8");
  if (command.patchMode === "write") return { patchFile };
  return { patchFile, patchApply: await applyPatchWithSystemPatch(proposedPatch, cwd) };
}

function parseTaskPacket(text: string, path: string): Record<string, unknown> {
  if (path.endsWith(".json")) return parseJsonObject(text, "task packet");
  const frontmatter = parseTaskPacketFrontmatter(text);
  if (frontmatter) {
    return {
      schema: "agent-fabric.task-packet.text",
      sourcePath: path,
      text,
      queue: {
        queueId: frontmatter.queueId,
        projectPath: frontmatter.projectPath
      },
      task: {
        queueTaskId: frontmatter.queueTaskId,
        fabricTaskId: frontmatter.fabricTaskId
      },
      contextFilePath: frontmatter.contextFilePath
    };
  }
  return {
    schema: "agent-fabric.task-packet.text",
    sourcePath: path,
    text
  };
}

function parseTaskPacketFrontmatter(text: string): Record<string, string> | undefined {
  if (!text.startsWith("---\n")) return undefined;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return undefined;
  const body = text.slice(4, end);
  const record: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) continue;
    record[match[1]] = unquoteFrontmatterValue(match[2].trim());
  }
  return record;
}

function unquoteFrontmatterValue(value: string): string {
  if (!value) return "";
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value.replace(/^['"]|['"]$/g, "");
  }
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  const trimmed = stripJsonFence(text.trim());
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new FabricError("INVALID_JSON_OBJECT", `${label} must be a JSON object`, false);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof FabricError) throw error;
    throw new FabricError("INVALID_JSON", `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, false);
  }
}

function stripJsonFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1].trim() : text;
}

function defaultOutputFile(
  command: Extract<DeepSeekWorkerCommand, { command: "run-task" }>,
  packet: Record<string, unknown>,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const id =
    command.fabricTaskId ??
    env.AGENT_FABRIC_FABRIC_TASK_ID ??
    getNestedString(packet, ["task", "fabricTaskId"]) ??
    getNestedString(packet, ["task", "queueTaskId"]) ??
    basename(command.taskPacketPath);
  return join(cwd, `deepseek-${command.role}-${safeFilePart(id)}.json`);
}

type DeepSeekPrice = { hit: number; miss: number; output: number };
type DeepSeekCostEstimate = { costUsd: number; source: string };

function estimateDeepSeekCost(model: string, usage: DeepSeekUsage, env: NodeJS.ProcessEnv): DeepSeekCostEstimate {
  const promptTokens = usage.prompt_tokens ?? 0;
  const hitTokens = usage.prompt_cache_hit_tokens ?? 0;
  const missTokens = usage.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - hitTokens);
  const completionTokens = usage.completion_tokens ?? 0;
  const { price, source } = deepSeekPriceForModel(model, env);
  const cost = (hitTokens * price.hit + missTokens * price.miss + completionTokens * price.output) / 1_000_000;
  return { costUsd: Number(cost.toFixed(6)), source };
}

function deepSeekPriceForModel(model: string, env: NodeJS.ProcessEnv): { price: DeepSeekPrice; source: string } {
  const override = loadDeepSeekPricingOverride(env);
  const overridePrice = priceFromTable(model, override.table);
  if (overridePrice) return { price: overridePrice, source: override.source };
  return {
    price: model.includes("flash") ? { hit: 0.028, miss: 0.14, output: 0.28 } : { hit: 0.145, miss: 1.74, output: 3.48 },
    source: "built-in-default"
  };
}

function loadDeepSeekPricingOverride(env: NodeJS.ProcessEnv): { table: Record<string, unknown>; source: string } {
  if (env.AGENT_FABRIC_DEEPSEEK_PRICING_JSON) {
    return { table: parsePricingTable(env.AGENT_FABRIC_DEEPSEEK_PRICING_JSON, "AGENT_FABRIC_DEEPSEEK_PRICING_JSON"), source: "env:AGENT_FABRIC_DEEPSEEK_PRICING_JSON" };
  }
  if (env.AGENT_FABRIC_DEEPSEEK_PRICING_FILE) {
    const path = env.AGENT_FABRIC_DEEPSEEK_PRICING_FILE;
    return { table: parsePricingTable(readFileSync(path, "utf8"), `file:${path}`), source: `file:${path}` };
  }
  return { table: {}, source: "built-in-default" };
}

function parsePricingTable(text: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new FabricError("INVALID_INPUT", `${label} must be a JSON object`, false);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof FabricError) throw error;
    throw new FabricError("INVALID_INPUT", `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, false);
  }
}

function priceFromTable(model: string, table: Record<string, unknown>): DeepSeekPrice | undefined {
  const exact = parsePrice(table[model]);
  if (exact) return exact;
  const family = model.includes("flash") ? parsePrice(table.flash ?? table["deepseek-v4-flash"]) : parsePrice(table.pro ?? table["deepseek-v4-pro"]);
  return family;
}

function parsePrice(value: unknown): DeepSeekPrice | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const hit = numberField(record, "hit");
  const miss = numberField(record, "miss");
  const output = numberField(record, "output");
  if (hit === undefined || miss === undefined || output === undefined) return undefined;
  return { hit, miss, output };
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function deepSeekApiKey(env: NodeJS.ProcessEnv): string | undefined {
  return env.DEEPSEEK_API_KEY || env.DEEPSEEK_TOKEN;
}

function firstChoice(data: Record<string, unknown>): Record<string, unknown> {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  return asRecord(choices[0]);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function getNestedString(value: Record<string, unknown>, path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : undefined;
}

function normalizeEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function parseWorkerRole(value: string): Extract<DeepSeekWorkerCommand, { command: "run-task" }>["role"] {
  if (["implementer", "reviewer", "risk-reviewer", "adjudicator", "planner"].includes(value)) {
    return value as Extract<DeepSeekWorkerCommand, { command: "run-task" }>["role"];
  }
  throw new FabricError("INVALID_INPUT", "role must be implementer, reviewer, risk-reviewer, adjudicator, or planner", false);
}

function parseReasoningEffort(value: string): "high" | "max" {
  if (value === "high" || value === "max") return value;
  throw new FabricError("INVALID_INPUT", "reasoning-effort must be high or max", false);
}

function parsePatchMode(value: string): PatchMode {
  if (value === "report" || value === "write" || value === "apply") return value;
  throw new FabricError("INVALID_INPUT", "patch-mode must be report, write, or apply", false);
}

function parseSensitiveContextMode(value: string | undefined, allowSensitiveContext: boolean): SensitiveContextMode {
  if (allowSensitiveContext) return "off";
  if (value === undefined) return "basic";
  if (value === "basic" || value === "strict" || value === "off") return value;
  throw new FabricError("INVALID_INPUT", "sensitive-context-mode must be basic, strict, or off", false);
}

function effectiveSensitiveContextMode(
  command: Extract<DeepSeekWorkerCommand, { command: "model-command" | "run-task" }>,
  env: NodeJS.ProcessEnv
): SensitiveContextMode {
  if (command.allowSensitiveContext) return "off";
  if (env.AGENT_FABRIC_SENIOR_MODE === "permissive" && !command.sensitiveContextModeExplicit) return "off";
  return command.sensitiveContextMode;
}

type ParsedFlags = {
  json: boolean;
  checkApi: boolean;
  allowSensitiveContext: boolean;
  sensitiveContextMode?: string;
  model?: string;
  reasoningEffort?: string;
  maxTokens?: number;
  temperature?: number;
  baseUrl?: string;
  timeoutMs?: number;
  taskPacketPath?: string;
  outputFile?: string;
  role?: string;
  contextFile?: string;
  fabricTaskId?: string;
  patchMode?: string;
  patchFile?: string;
};

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = { json: false, checkApi: false, allowSensitiveContext: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") flags.json = true;
    else if (arg === "--check-api") flags.checkApi = true;
    else if (arg === "--allow-sensitive-context") flags.allowSensitiveContext = true;
    else if (arg === "--sensitive-context-mode") flags.sensitiveContextMode = requiredValue(args, ++i, arg);
    else if (arg === "--model") flags.model = requiredValue(args, ++i, arg);
    else if (arg === "--reasoning-effort") flags.reasoningEffort = requiredValue(args, ++i, arg);
    else if (arg === "--max-tokens") flags.maxTokens = parsePositiveInteger(requiredValue(args, ++i, arg), arg);
    else if (arg === "--temperature") flags.temperature = parseNumber(requiredValue(args, ++i, arg), arg);
    else if (arg === "--base-url") flags.baseUrl = requiredValue(args, ++i, arg);
    else if (arg === "--timeout-ms") flags.timeoutMs = parsePositiveInteger(requiredValue(args, ++i, arg), arg);
    else if (arg === "--task-packet") flags.taskPacketPath = requiredValue(args, ++i, arg);
    else if (arg === "--output") flags.outputFile = requiredValue(args, ++i, arg);
    else if (arg === "--role") flags.role = requiredValue(args, ++i, arg);
    else if (arg === "--context-file") flags.contextFile = requiredValue(args, ++i, arg);
    else if (arg === "--fabric-task") flags.fabricTaskId = requiredValue(args, ++i, arg);
    else if (arg === "--patch-mode") flags.patchMode = requiredValue(args, ++i, arg);
    else if (arg === "--patch-file") flags.patchFile = requiredValue(args, ++i, arg);
    else throw new FabricError("INVALID_INPUT", `Unknown flag: ${arg}`, false);
  }
  return flags;
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined || value === "") throw new FabricError("INVALID_INPUT", message, false);
  return value;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new FabricError("INVALID_INPUT", `${flag} requires a value`, false);
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new FabricError("INVALID_INPUT", `${flag} must be a positive integer`, false);
  return parsed;
}

function parseNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new FabricError("INVALID_INPUT", `${flag} must be a number`, false);
  return parsed;
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 96) || "task";
}
