import { FabricError } from "./errors.js";

export type ApprovalCliDecision = "allow" | "compact" | "downgrade" | "cancel";
type ApprovalScope = "call" | "chain" | "queue" | "session" | "day";

export type ApprovalCliCommand =
  | {
      command: "list";
      json: boolean;
      workspaceRoot?: string;
      includeExpired: boolean;
      max?: number;
    }
  | {
      command: "prompt";
      json: boolean;
      workspaceRoot?: string;
      scope: ApprovalScope;
      boundResourceId?: string;
      expiresInSeconds?: number;
      note?: string;
    }
  | {
      command: "decide";
      json: boolean;
      requestId: string;
      decision: ApprovalCliDecision;
      scope: ApprovalScope;
      boundResourceId?: string;
      expiresInSeconds?: number;
      note?: string;
    }
  | { command: "help"; json: boolean };

type PendingApproval = {
  requestId: string;
  expiresAt: string;
  expired?: boolean;
  client: string;
  taskType: string;
  selected: { provider: string; model: string; reasoning: string };
  estimate: { inputTokens: number; reservedOutputTokens: number; estimatedCostUsd: number };
  risk: string;
  warnings?: string[];
};

export function parseApprovalCliArgs(argv: string[]): ApprovalCliCommand {
  const args = [...argv];
  const command = args.shift() ?? "list";
  if (command === "help" || command === "--help" || command === "-h") return { command: "help", json: false };

  if (command === "list") {
    const flags = parseFlags(args);
    return {
      command: "list",
      json: flags.json,
      workspaceRoot: flags.workspaceRoot,
      includeExpired: flags.includeExpired,
      max: flags.max
    };
  }

  if (command === "prompt") {
    const flags = parseFlags(args);
    return {
      command: "prompt",
      json: flags.json,
      workspaceRoot: flags.workspaceRoot,
      scope: flags.scope,
      boundResourceId: flags.boundResourceId,
      expiresInSeconds: flags.expiresInSeconds,
      note: flags.note
    };
  }

  if (["approve", "compact", "downgrade", "cancel"].includes(command)) {
    const requestId = args.shift();
    if (!requestId) throw new FabricError("INVALID_INPUT", `${command} requires a requestId`, false);
    const flags = parseFlags(args);
    return {
      command: "decide",
      json: flags.json,
      requestId,
      decision: command === "approve" ? "allow" : (command as ApprovalCliDecision),
      scope: flags.scope,
      boundResourceId: flags.boundResourceId,
      expiresInSeconds: flags.expiresInSeconds,
      note: flags.note
    };
  }

  throw new FabricError("INVALID_INPUT", `Unknown approval CLI command: ${command}`, false);
}

export function formatPendingApprovals(result: { count: number; workspaceRoot: string; requests: PendingApproval[] }): string {
  if (result.requests.length === 0) {
    return `No pending approvals for ${result.workspaceRoot}.`;
  }
  const lines = [`Pending approvals for ${result.workspaceRoot}:`];
  for (const request of result.requests) {
    lines.push(formatPendingApproval(request));
  }
  return lines.join("\n");
}

export function formatPendingApproval(request: PendingApproval): string {
  const route = `${request.selected.provider}/${request.selected.model} (${request.selected.reasoning})`;
  const estimate = `$${request.estimate.estimatedCostUsd.toFixed(6)} est, ${request.estimate.inputTokens} in / ${request.estimate.reservedOutputTokens} out tokens`;
  const warnings = request.warnings?.length ? `\n    warnings: ${request.warnings.join(" | ")}` : "";
  const expired = request.expired ? " expired" : "";
  return `  ${request.requestId}${expired}\n    ${request.client} ${request.taskType} -> ${route}\n    risk: ${request.risk}; ${estimate}; expires: ${request.expiresAt}${warnings}`;
}

export function formatDecisionResult(result: Record<string, unknown>): string {
  const token = typeof result.approvalToken === "string" ? `\napprovalToken: ${result.approvalToken}` : "";
  return `requestId: ${String(result.requestId)}\nstatus: ${String(result.status)}\ndecision: ${String(result.decision)}\nscope: ${String(result.scope)}${token}`;
}

export function approvalHelp(): string {
  return [
    "Usage:",
    "  agent-fabric-approve list [--json] [--workspace <path>] [--include-expired] [--max <n>]",
    "  agent-fabric-approve prompt [--workspace <path>] [--scope call|chain|queue|session|day] [--queue <queueId>] [--bound-resource <id>] [--expires <seconds>] [--note <text>]",
    "  agent-fabric-approve approve <requestId> [--scope call|chain|queue|session|day] [--queue <queueId>] [--bound-resource <id>] [--expires <seconds>] [--note <text>] [--json]",
    "  agent-fabric-approve compact <requestId> [--note <text>] [--json]",
    "  agent-fabric-approve downgrade <requestId> [--note <text>] [--json]",
    "  agent-fabric-approve cancel <requestId> [--note <text>] [--json]"
  ].join("\n");
}

type ParsedFlags = {
  json: boolean;
  workspaceRoot?: string;
  includeExpired: boolean;
  max?: number;
  scope: ApprovalScope;
  boundResourceId?: string;
  expiresInSeconds?: number;
  note?: string;
};

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = {
    json: false,
    includeExpired: false,
    scope: "call"
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--include-expired") {
      flags.includeExpired = true;
    } else if (arg === "--workspace") {
      flags.workspaceRoot = requiredValue(args, ++i, arg);
    } else if (arg === "--max") {
      flags.max = parsePositiveInt(requiredValue(args, ++i, arg), "max");
    } else if (arg === "--scope") {
      flags.scope = parseScope(requiredValue(args, ++i, arg));
    } else if (arg === "--bound-resource") {
      flags.boundResourceId = requiredValue(args, ++i, arg);
    } else if (arg === "--queue") {
      const queueId = requiredValue(args, ++i, arg);
      flags.scope = "queue";
      flags.boundResourceId = `project_queue:${queueId}`;
    } else if (arg === "--expires") {
      flags.expiresInSeconds = parsePositiveInt(requiredValue(args, ++i, arg), "expires");
    } else if (arg === "--note") {
      flags.note = requiredValue(args, ++i, arg);
    } else {
      throw new FabricError("INVALID_INPUT", `Unknown flag: ${arg}`, false);
    }
  }

  return flags;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new FabricError("INVALID_INPUT", `${flag} requires a value`, false);
  return value;
}

function parseScope(value: string): ApprovalScope {
  if (["call", "chain", "queue", "session", "day"].includes(value)) return value as ApprovalScope;
  throw new FabricError("INVALID_INPUT", "scope must be call, chain, queue, session, or day", false);
}

function parsePositiveInt(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new FabricError("INVALID_INPUT", `${field} must be a positive integer`, false);
  }
  return parsed;
}
