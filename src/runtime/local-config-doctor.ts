import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export type LocalConfigDoctorStatus = "ok" | "warn" | "missing" | "disabled";

export type LocalConfigDoctorCheck = {
  id: string;
  status: LocalConfigDoctorStatus;
  detail: string;
  path?: string;
  recommendation?: string;
};

export type LocalConfigDoctorDaemonControl = {
  scope: "shared-local-daemon";
  requiresOperatorApproval: true;
  agentsMayRestart: false;
  agentsMayKill: false;
  agentsMayRemoveSocket: false;
  warning: string;
  safeActions: string[];
  forbiddenActions: string[];
};

export type LocalConfigDoctorMcpConfig = {
  client: "codex" | "codex-foundry" | "claude" | "unknown";
  path: string;
  exists: boolean;
  hasAgentFabric: boolean;
  bridgePathMatches: boolean;
  workspaceRootMatches: boolean;
};

export type LocalConfigDoctorReport = {
  schema: "agent-fabric.local-config-doctor.v1";
  ok: boolean;
  projectPath: string;
  gitRoot?: string;
  localConfig: {
    path: string;
    exists: boolean;
    gitIgnored: boolean | null;
    configuredKeys: string[];
  };
  runtime: {
    home: string;
    dbPath: string;
    socketPath: string;
    costIngestTokenPath: string;
    costIngestToken: "env" | "file" | "missing";
    costIngestTokenMode?: string;
  };
  daemon: {
    status: "running" | "not-running" | "unknown";
    pid?: number;
    cwd?: string;
    entrypoint?: string;
    command?: string;
    sourceMatches?: boolean;
    requiredSeniorToolsInBuild?: boolean;
  };
  daemonControl: LocalConfigDoctorDaemonControl;
  deepseek: {
    apiKey: "env" | "local-env-file" | "missing";
    defaultModel?: string;
    baseUrl?: string;
  };
  jcodeDispatcher: {
    status: "configured" | "disabled" | "missing";
    source?: "env" | "local-config";
    path?: string;
    exists?: boolean;
    executable?: boolean;
  };
  elixir?: {
    present: boolean;
    mixfilePath?: string;
    depsReady?: boolean;
  };
  seniorMode?: {
    configured: boolean;
    source?: "env" | "local-config";
  };
  mcpConfigs: LocalConfigDoctorMcpConfig[];
  checks: LocalConfigDoctorCheck[];
  recommendations: string[];
};

export type LocalConfigDoctorOptions = {
  projectPath?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  mcpConfigPaths?: string[];
  checkBinaries?: boolean;
};

const LOCAL_CONFIG_FILE = "agent-fabric.local.env";
const LOCAL_CONFIG_KEYS = [
  "AGENT_FABRIC_HOME",
  "AGENT_FABRIC_WORKSPACE_ROOT",
  "AGENT_FABRIC_PROJECT_MODEL_COMMAND",
  "AGENT_FABRIC_SENIOR_MODE",
  "AGENT_FABRIC_SENIOR_DEFAULT_WORKER",
  "JCODE_BIN",
  "AGENT_FABRIC_JCODE_DEEPSEEK_DISPATCHER"
];

const SHARED_DAEMON_WARNING =
  "The Agent Fabric daemon/socket is shared across Codex, Claude Code, project CLI sessions, and live queues. Automated agents must not kill, restart, or remove the shared daemon/socket.";
const SHARED_DAEMON_OPERATOR_REMEDIATION =
  "Do not kill/restart the shared daemon from an agent session. Ask the operator to restart/relink the canonical daemon, or rerun this experiment with an isolated AGENT_FABRIC_HOME/socket.";

export function runLocalConfigDoctor(options: LocalConfigDoctorOptions = {}): LocalConfigDoctorReport {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const requestedProjectPath = resolve(options.projectPath ?? env.AGENT_FABRIC_WORKSPACE_ROOT ?? process.cwd());
  const projectPath = existsSync(requestedProjectPath) ? realpathSync(requestedProjectPath) : requestedProjectPath;
  const localConfigPath = join(projectPath, LOCAL_CONFIG_FILE);
  const localConfigText = readIfExists(localConfigPath);
  const localConfig = localConfigText ? parseShellExports(localConfigText) : {};
  const configuredKeys = LOCAL_CONFIG_KEYS.filter((key) => localConfig[key] !== undefined);
  const gitRoot = gitRootFor(projectPath);
  const localConfigIgnored = gitRoot ? gitIgnored(gitRoot, localConfigPath) : null;
  const decisionsPath = join(projectPath, "decisions");
  const decisionsIgnored = gitRoot ? gitIgnored(gitRoot, decisionsPath) : null;
  const runtimeHome = expandHome(env.AGENT_FABRIC_HOME ?? localConfig.AGENT_FABRIC_HOME ?? join(homeDir, ".agent-fabric"), homeDir);
  const costIngestTokenPath = join(runtimeHome, "cost-ingest-token");
  const socketPath = join(runtimeHome, "agent.sock");
  const costTokenMode = fileMode(costIngestTokenPath);
  const daemon = runningDaemonStatus(socketPath, projectPath);
  const daemonControl = sharedDaemonControlPolicy(runtimeHome, socketPath);
  const deepseekKeySource = env.DEEPSEEK_API_KEY ? "env" : localEnvFileHasKey(homeDir, "DEEPSEEK_API_KEY") ? "local-env-file" : "missing";
  const jcode = jcodeDispatcherStatus(env, localConfig);
  const mcpConfigs = mcpConfigReport(options.mcpConfigPaths ?? defaultMcpConfigPaths(homeDir), projectPath, [projectPath, requestedProjectPath]);
  const checks: LocalConfigDoctorCheck[] = [
    check("project_path", existsSync(projectPath), `Project path: ${projectPath}`, "Pass --project <path> for the active checkout."),
    check("git_checkout", Boolean(gitRoot), gitRoot ? `Git root: ${gitRoot}` : "Project is not inside a Git checkout.", "Run from the Agent Fabric checkout."),
    check("local_config", existsSync(localConfigPath), `Local config: ${localConfigPath}`, `Create ${LOCAL_CONFIG_FILE} for local defaults.`),
    check("local_config_ignored", localConfigIgnored === true, localConfigIgnored === null ? "Git ignore status unavailable." : `${LOCAL_CONFIG_FILE} gitignored: ${String(localConfigIgnored)}`, `Add ${LOCAL_CONFIG_FILE} or *.env to .gitignore.`),
    check("decisions_local_memory", existsSync(decisionsPath), `Local decisions directory: ${decisionsPath}`, "Keep local architecture memory under decisions/ when useful."),
    check("decisions_ignored", decisionsIgnored === true, decisionsIgnored === null ? "Git ignore status unavailable." : `decisions/ gitignored: ${String(decisionsIgnored)}`, "Add decisions/ to .gitignore."),
    check("cost_ingest_token", env.AGENT_FABRIC_COST_INGEST_TOKEN || existsSync(costIngestTokenPath), `Cost ingest token: ${env.AGENT_FABRIC_COST_INGEST_TOKEN ? "env" : existsSync(costIngestTokenPath) ? costIngestTokenPath : "missing"}`, "Create ~/.agent-fabric/cost-ingest-token or export AGENT_FABRIC_COST_INGEST_TOKEN before enabling HTTP ingest."),
    check("daemon_source", daemon.status !== "running" || daemon.sourceMatches !== false, daemon.status === "running" ? `Daemon pid ${daemon.pid}; cwd=${daemon.cwd ?? "unknown"}; entrypoint=${daemon.entrypoint ?? daemon.command ?? "unknown"}` : "Agent Fabric daemon is not running.", SHARED_DAEMON_OPERATOR_REMEDIATION),
    check("senior_tool_build", daemon.requiredSeniorToolsInBuild !== false, daemon.requiredSeniorToolsInBuild === false ? "Built daemon is missing Senior-mode bridge tools." : "Built daemon contains Senior-mode bridge tools.", `Run npm run build && npm link, then ask the operator to restart/relink the canonical daemon. ${SHARED_DAEMON_WARNING}`),
    check("deepseek_key", deepseekKeySource !== "missing", `DeepSeek API key source: ${deepseekKeySource}`, "Set DEEPSEEK_API_KEY in a private shell/env file."),
    check("codex_mcp", mcpConfigs.some((item) => item.client !== "claude" && item.hasAgentFabric && item.bridgePathMatches), "Codex MCP config points at this checkout.", "Update Codex MCP config to use dist/bin/bridge.js from this checkout."),
    check("claude_mcp", mcpConfigs.some((item) => item.client === "claude" && item.hasAgentFabric && item.bridgePathMatches), "Claude MCP config points at this checkout.", "Update Claude Code MCP config to use dist/bin/bridge.js from this checkout.")
  ];

  if (options.checkBinaries ?? true) {
    checks.push(binaryCheck("agent-fabric-project"));
    checks.push(binaryCheck("agent-fabric-deepseek-worker"));
    checks.push(binaryCheck("agent-fabric"));
  }

  checks.push(jcodeDispatcherCheck(jcode));

  const elixir = elixirStatus(projectPath);
  const seniorMode = seniorModeStatus(env, localConfig);
  const recommendations = recommendationsFor(checks, jcode, localConfig);
  return {
    schema: "agent-fabric.local-config-doctor.v1",
    ok: checks.every((item) => item.status === "ok" || item.status === "disabled"),
    projectPath,
    gitRoot,
    localConfig: {
      path: localConfigPath,
      exists: existsSync(localConfigPath),
      gitIgnored: localConfigIgnored,
      configuredKeys
    },
    runtime: {
      home: runtimeHome,
      dbPath: join(runtimeHome, "db.sqlite"),
      socketPath,
      costIngestTokenPath,
      costIngestToken: env.AGENT_FABRIC_COST_INGEST_TOKEN ? "env" : existsSync(costIngestTokenPath) ? "file" : "missing",
      costIngestTokenMode: costTokenMode
    },
    daemon,
    daemonControl,
    deepseek: {
      apiKey: deepseekKeySource,
      defaultModel: env.DEEPSEEK_DEFAULT_MODEL,
      baseUrl: env.DEEPSEEK_BASE_URL
    },
    jcodeDispatcher: jcode,
    elixir,
    seniorMode,
    mcpConfigs,
    checks,
    recommendations
  };
}

export function formatLocalConfigDoctor(report: LocalConfigDoctorReport): string {
  const lines = [`Agent Fabric local config doctor: ${report.ok ? "ok" : "attention needed"}`, `Project: ${report.projectPath}`];
  if (report.gitRoot) lines.push(`Git root: ${report.gitRoot}`);
  lines.push("", "Checks:");
  for (const item of report.checks) {
    lines.push(`- ${statusLabel(item.status)} ${item.id}: ${item.detail}`);
    if (item.recommendation && item.status !== "ok" && item.status !== "disabled") lines.push(`  Next: ${item.recommendation}`);
  }
  lines.push("", "Local config:");
  lines.push(`- ${report.localConfig.path}`);
  lines.push(`- configured keys: ${report.localConfig.configuredKeys.length ? report.localConfig.configuredKeys.join(", ") : "(none)"}`);
  lines.push("", "Runtime:");
  lines.push(`- home: ${report.runtime.home}`);
  lines.push(`- db: ${report.runtime.dbPath}`);
  lines.push(`- socket: ${report.runtime.socketPath}`);
  lines.push(`- cost ingest token: ${report.runtime.costIngestToken}${report.runtime.costIngestTokenMode ? ` (${report.runtime.costIngestTokenMode})` : ""}`);
  lines.push("", "Daemon:");
  lines.push(`- status: ${report.daemon.status}`);
  if (report.daemon.pid) lines.push(`- pid: ${report.daemon.pid}`);
  if (report.daemon.cwd) lines.push(`- cwd: ${report.daemon.cwd}`);
  if (report.daemon.entrypoint) lines.push(`- entrypoint: ${report.daemon.entrypoint}`);
  if (report.daemon.command) lines.push(`- command: ${report.daemon.command}`);
  if (report.daemon.sourceMatches !== undefined) lines.push(`- source matches this checkout: ${String(report.daemon.sourceMatches)}`);
  if (report.daemon.requiredSeniorToolsInBuild !== undefined) lines.push(`- Senior tools in build: ${String(report.daemon.requiredSeniorToolsInBuild)}`);
  lines.push("", "Shared daemon control:");
  lines.push(`- ${report.daemonControl.warning}`);
  lines.push(`- agents may restart: ${String(report.daemonControl.agentsMayRestart)}`);
  lines.push(`- agents may kill: ${String(report.daemonControl.agentsMayKill)}`);
  lines.push(`- agents may remove socket: ${String(report.daemonControl.agentsMayRemoveSocket)}`);
  lines.push(`- safe actions: ${report.daemonControl.safeActions.join("; ")}`);
  lines.push("", "MCP configs:");
  for (const item of report.mcpConfigs) {
    if (!item.exists) {
      lines.push(`- ${item.client}: missing ${item.path}`);
    } else {
      lines.push(`- ${item.client}: ${item.hasAgentFabric ? "agent-fabric" : "no agent-fabric"}; bridge=${item.bridgePathMatches ? "this checkout" : "other/missing"}; workspace=${item.workspaceRootMatches ? "this checkout" : "other/missing"} (${item.path})`);
    }
  }
  if (report.recommendations.length > 0) {
    lines.push("", "Recommendations:");
    for (const recommendation of report.recommendations) lines.push(`- ${recommendation}`);
  }
  lines.push("", "Onboarding starter surface:");
  lines.push("  Essential queue tools:");
  lines.push("    agent-fabric-project senior-doctor --project .          — daemon/Senior bridge readiness");
  lines.push("    agent-fabric-project senior-run --dry-run --project .  — preview worker shape");
  lines.push("    npm run dev:desktop -- --port 4573                      — local command center");
  lines.push("  Where next after doctor passes:");
  lines.push("    1. Create a demo queue (click 'Seed Demo Queue' in the command center)");
  lines.push("    2. Review the [2-minute demo script](docs/demo-script.md)");
  lines.push("    3. Explore Senior mode with 10 DeepSeek workers: see README > Senior Mode");
  if (report.elixir?.present) {
    lines.push(`  Elixir orchestrator preview: mixfile found at ${report.elixir.mixfilePath}`);
    if (report.elixir.depsReady) {
      lines.push("    cd elixir && mix compile && mix af.status");
    } else {
      lines.push("    cd elixir && mix deps.get && mix compile && mix af.status");
    }
  }
  return lines.join("\n");
}

export function localConfigDoctorHelp(): string {
  return [
    "Usage:",
    "  agent-fabric doctor local-config [--project <path>] [--json]",
    "  agent-fabric-project doctor local-config [--project <path>] [--json]",
    "",
    "Reports active checkout wiring, local ignored config, Agent Fabric runtime state, MCP config paths, DeepSeek key presence, and optional Jcode dispatcher state.",
    "Daemon restarts, daemon kills, and shared socket removal are operator-only actions; agents should ask or use an isolated AGENT_FABRIC_HOME/socket.",
    "The report never prints API key or bearer token values.",
    "",
    "Onboarding next steps:",
    "  1. Create a local config:  echo 'export AGENT_FABRIC_SENIOR_MODE=permissive' > agent-fabric.local.env",
    "  2. Install, build, and test: npm install && npm run build && npm test",
    "  3. Start the daemon:      AGENT_FABRIC_COST_INGEST_TOKEN=\"$(openssl rand -base64 32)\" npm run dev:daemon",
    "  4. Run the doctor again:  agent-fabric doctor local-config --project .",
    "  5. Open command center:   npm run dev:desktop -- --port 4573  →  open http://127.0.0.1:4573/",
    "  6. Try Senior mode path:  AGENT_FABRIC_SENIOR_MODE=permissive agent-fabric-project senior-doctor --project <path>",
    "",
    "Elixir orchestration preview (optional):",
    "  cd elixir && mix deps.get && mix compile && mix af.status",
    "",
    "Quick tools:",
    "  agent-fabric doctor local-config --json  | jq .  — machine-readable wiring report",
    "  agent-fabric-project senior-doctor        — daemon/Senior bridge readiness",
    "  agent-fabric-project senior-run --dry-run — preview queue shape without launching workers",
    ""
  ].join("\n");
}

function elixirStatus(projectPath: string): LocalConfigDoctorReport["elixir"] {
  const mixfilePath = join(projectPath, "elixir", "mix.exs");
  if (!existsSync(mixfilePath)) return { present: false };
  const depsPath = join(projectPath, "elixir", "deps");
  return {
    present: true,
    mixfilePath,
    depsReady: existsSync(depsPath) && statSync(depsPath).isDirectory()
  };
}

function seniorModeStatus(env: NodeJS.ProcessEnv, localConfig: Record<string, string>): LocalConfigDoctorReport["seniorMode"] {
  const envValue = env.AGENT_FABRIC_SENIOR_MODE?.trim();
  const localValue = localConfig.AGENT_FABRIC_SENIOR_MODE?.trim();
  const configured = envValue === "permissive" || localValue === "permissive";
  return {
    configured,
    source: configured ? (envValue === "permissive" ? "env" : "local-config") : undefined
  };
}

function check(id: string, pass: unknown, detail: string, recommendation?: string): LocalConfigDoctorCheck {
  return { id, status: pass ? "ok" : "missing", detail, recommendation };
}

function binaryCheck(command: string): LocalConfigDoctorCheck {
  const args = command === "agent-fabric-deepseek-worker" ? ["doctor", "--json"] : ["--version"];
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 2_000 });
  const output = (result.stdout || result.stderr).trim();
  return {
    id: `binary_${command}`,
    status: result.status === 0 ? "ok" : "warn",
    detail: result.status === 0 ? `${command}: ${output || "available"}` : `${command}: not available on PATH`,
    recommendation: `Run npm link from the Agent Fabric checkout or call the bin through npm run dev:* during development.`
  };
}

function jcodeDispatcherCheck(jcode: LocalConfigDoctorReport["jcodeDispatcher"]): LocalConfigDoctorCheck {
  if (jcode.status === "disabled") {
    return {
      id: "jcode_dispatcher",
      status: "disabled",
      detail: "Legacy Jcode dispatcher is not configured; bundled agent-fabric-jcode-deepseek-worker will be used for jcode-deepseek."
    };
  }
  if (jcode.status === "configured" && jcode.exists && jcode.executable) {
    return {
      id: "jcode_dispatcher",
      status: "ok",
      detail: `Jcode dispatcher configured from ${jcode.source}: ${jcode.path}`
    };
  }
  return {
    id: "jcode_dispatcher",
    status: "warn",
    detail: `Jcode dispatcher configured but not executable: ${jcode.path ?? "(missing path)"}`,
    recommendation: "Leave AGENT_FABRIC_JCODE_DEEPSEEK_DISPATCHER unset to use the bundled agent-fabric-jcode-deepseek-worker adapter, or point it at an executable legacy dispatcher."
  };
}

function recommendationsFor(checks: LocalConfigDoctorCheck[], jcode: LocalConfigDoctorReport["jcodeDispatcher"], localConfig: Record<string, string>): string[] {
  const recommendations = checks
    .filter((item) => item.status === "missing" || item.status === "warn")
    .map((item) => item.recommendation)
    .filter((item): item is string => Boolean(item));
  if (jcode.status === "disabled" && localConfig.AGENT_FABRIC_SENIOR_DEFAULT_WORKER !== "jcode-deepseek") {
    recommendations.push("Use AGENT_FABRIC_SENIOR_DEFAULT_WORKER=jcode-deepseek locally when large implementation lanes should use the Jcode runtime by default.");
  }
  return [...new Set(recommendations)];
}

function gitRootFor(projectPath: string): string | undefined {
  const result = spawnSync("git", ["-C", projectPath, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function gitIgnored(gitRoot: string, path: string): boolean {
  const target = relative(gitRoot, path) || ".";
  const result = spawnSync("git", ["-C", gitRoot, "check-ignore", "-q", "--", target], { encoding: "utf8" });
  return result.status === 0;
}

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function parseShellExports(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith("#")) continue;
    values[match[1]] = stripShellQuotes(match[2]);
  }
  return values;
}

function stripShellQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

function expandHome(value: string, homeDir: string): string {
  if (value === "$HOME") return homeDir;
  if (value.startsWith("$HOME/")) return join(homeDir, value.slice("$HOME/".length));
  if (value.startsWith("~/")) return join(homeDir, value.slice(2));
  return value;
}

function localEnvFileHasKey(homeDir: string, key: string): boolean {
  for (const file of [join(homeDir, ".ramicode.env"), join(homeDir, ".zshrc"), join(homeDir, ".zprofile"), join(homeDir, ".bash_profile")]) {
    const text = readIfExists(file);
    if (text && parseShellExports(text)[key]) return true;
  }
  return false;
}

function fileMode(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return `0${(statSync(path).mode & 0o777).toString(8)}`;
}

function jcodeDispatcherStatus(env: NodeJS.ProcessEnv, localConfig: Record<string, string>): LocalConfigDoctorReport["jcodeDispatcher"] {
  const envValue = env.AGENT_FABRIC_JCODE_DEEPSEEK_DISPATCHER?.trim();
  const localValue = localConfig.AGENT_FABRIC_JCODE_DEEPSEEK_DISPATCHER?.trim();
  const value = envValue || localValue;
  if (!value) return { status: "disabled" };
  const path = resolve(value);
  const mode = existsSync(path) ? statSync(path).mode : 0;
  return {
    status: "configured",
    source: envValue ? "env" : "local-config",
    path,
    exists: existsSync(path),
    executable: Boolean(mode & 0o111)
  };
}

function sharedDaemonControlPolicy(runtimeHome: string, socketPath: string): LocalConfigDoctorDaemonControl {
  return {
    scope: "shared-local-daemon",
    requiresOperatorApproval: true,
    agentsMayRestart: false,
    agentsMayKill: false,
    agentsMayRemoveSocket: false,
    warning: SHARED_DAEMON_WARNING,
    safeActions: [
      "run read-only doctor/status commands",
      "ask the operator to restart or relink the canonical daemon",
      `use an isolated AGENT_FABRIC_HOME outside ${runtimeHome} for experiments`,
      `use an isolated socket instead of ${socketPath} for worktree-local tests`
    ],
    forbiddenActions: [
      "kill the daemon process",
      "restart the shared daemon",
      "remove or replace the shared daemon socket",
      "recover or requeue live queues without operator review"
    ]
  };
}

function runningDaemonStatus(socketPath: string, projectPath: string): LocalConfigDoctorReport["daemon"] {
  if (!existsSync(socketPath)) {
    return {
      status: "not-running",
      requiredSeniorToolsInBuild: builtDaemonHasSeniorTools(projectPath)
    };
  }
  const pidResult = spawnSync("lsof", ["-t", socketPath], { encoding: "utf8", timeout: 2_000 });
  const pid = Number(pidResult.stdout.trim().split(/\s+/).find(Boolean));
  if (!Number.isFinite(pid) || pid <= 0) {
    return {
      status: "unknown",
      requiredSeniorToolsInBuild: builtDaemonHasSeniorTools(projectPath)
    };
  }
  const commandResult = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2_000 });
  const command = commandResult.stdout.trim() || undefined;
  const lsofResult = spawnSync("lsof", ["-p", String(pid)], { encoding: "utf8", timeout: 2_000 });
  const cwd = lsofLinePath(lsofResult.stdout, "cwd");
  const entrypoint = command ? extractNodeEntrypoint(command) : undefined;
  const sourceMatches = Boolean(
    (cwd && sameOrUnder(cwd, projectPath)) ||
      (entrypoint && sameOrUnder(entrypoint, projectPath)) ||
      (command && command.includes(projectPath))
  );
  return {
    status: "running",
    pid,
    cwd,
    entrypoint,
    command,
    sourceMatches,
    requiredSeniorToolsInBuild: builtDaemonHasSeniorTools(projectPath)
  };
}

function lsofLinePath(text: string, fd: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns[3] === fd) return columns.slice(8).join(" ") || undefined;
  }
  return undefined;
}

function extractNodeEntrypoint(command: string): string | undefined {
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  for (const part of parts.slice(1)) {
    const value = part.replace(/^['"]|['"]$/g, "");
    if (value.endsWith(".js") || value.includes("/dist/bin/")) return resolve(value);
  }
  return undefined;
}

function sameOrUnder(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}/`);
}

function builtDaemonHasSeniorTools(projectPath: string): boolean | undefined {
  const daemonPath = join(projectPath, "dist", "daemon.js");
  const bridgePath = join(projectPath, "dist", "bin", "bridge.js");
  const daemonText = readIfExists(daemonPath);
  const bridgeText = readIfExists(bridgePath);
  if (!daemonText || !bridgeText) return undefined;
  return [
    "fabric_senior_start",
    "fabric_spawn_agents",
    "project_queue_approve_model_calls",
    "project_queue_validate_links",
    "project_queue_validate_context_refs"
  ].every((tool) => daemonText.includes(tool) && bridgeText.includes(tool));
}

function defaultMcpConfigPaths(homeDir: string): string[] {
  return [
    join(homeDir, ".codex", "config.toml"),
    join(homeDir, ".codex-foundry", "config.toml"),
    join(homeDir, ".claude.json"),
    join(homeDir, ".claude", ".mcp.json")
  ];
}

function mcpConfigReport(paths: string[], projectPath: string, projectPathAliases: string[]): LocalConfigDoctorMcpConfig[] {
  const bridgePath = join(projectPath, "dist", "bin", "bridge.js");
  const bridgePathAliases = [...new Set(projectPathAliases.map((path) => join(path, "dist", "bin", "bridge.js")))];
  return paths.map((path) => {
    const text = readIfExists(path);
    return {
      client: mcpClientFor(path),
      path,
      exists: text !== undefined,
      hasAgentFabric: Boolean(text?.includes("agent-fabric")),
      bridgePathMatches: Boolean(text && bridgePathAliases.some((candidate) => text.includes(candidate))),
      workspaceRootMatches: Boolean(text && projectPathAliases.some((candidate) => text.includes(candidate)))
    };
  });
}

function mcpClientFor(path: string): LocalConfigDoctorMcpConfig["client"] {
  if (path.includes(".codex-foundry")) return "codex-foundry";
  if (path.includes(".codex")) return "codex";
  if (path.includes(".claude")) return "claude";
  return "unknown";
}

function statusLabel(status: LocalConfigDoctorStatus): string {
  if (status === "ok") return "OK";
  if (status === "disabled") return "DISABLED";
  if (status === "warn") return "WARN";
  return "MISSING";
}
