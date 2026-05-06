#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { FabricClient } from "../client.js";
import { defaultPaths } from "../paths.js";
import {
  approvalHelp,
  formatDecisionResult,
  formatPendingApproval,
  formatPendingApprovals,
  parseApprovalCliArgs,
  type ApprovalCliDecision
} from "../runtime/approval-cli.js";
import { bridgeCallContext } from "../runtime/bridge-context.js";
import type { BridgeRegister, BridgeSession } from "../types.js";

const paths = defaultPaths();
const client = new FabricClient(paths.socketPath);

try {
  const command = parseApprovalCliArgs(process.argv.slice(2));
  if (command.command === "help") {
    console.log(approvalHelp());
  } else {
    const session = await register();
    if (command.command === "list") {
      const result = await call<Record<string, unknown>>(session, "llm_approve_pending", {
        workspaceRoot: command.workspaceRoot,
        includeExpired: command.includeExpired,
        max: command.max
      });
      writeResult(result, command.json, () => formatPendingApprovals(result as Parameters<typeof formatPendingApprovals>[0]));
    } else if (command.command === "decide") {
      const result = await decide(session, {
        requestId: command.requestId,
        decision: command.decision,
        scope: command.scope,
        boundResourceId: command.boundResourceId,
        expiresInSeconds: command.expiresInSeconds,
        note: command.note
      });
      writeResult(result, command.json, () => formatDecisionResult(result));
    } else if (command.command === "prompt") {
      await promptForApproval(session, command);
    }
  }
} catch (error) {
  const record = error as { code?: string; message?: string };
  const prefix = record.code ? `${record.code}: ` : "";
  console.error(`${prefix}${record.message ?? String(error)}`);
  process.exitCode = 1;
}

async function register(): Promise<BridgeSession> {
  const payload: BridgeRegister = {
    bridgeVersion: "0.1.0",
    agent: {
      id: process.env.AGENT_FABRIC_AGENT_ID ?? "approval-cli",
      displayName: process.env.AGENT_FABRIC_AGENT_NAME ?? "agent-fabric approval CLI",
      vendor: "local"
    },
    host: {
      name: "Approval CLI",
      transport: "uds"
    },
    workspace: {
      root: process.env.AGENT_FABRIC_WORKSPACE_ROOT ?? process.cwd(),
      source: process.env.AGENT_FABRIC_WORKSPACE_ROOT ? "explicit" : "cwd"
    },
    capabilities: {
      roots: false,
      notifications: false,
      notificationsVisibleToAgent: { declared: "no", observed: "no" },
      sampling: false,
      streamableHttp: false,
      litellmRouteable: false,
      outcomeReporting: "explicit"
    },
    notificationSelfTest: {
      observed: "no",
      detail: "terminal approval CLI is request/response only"
    },
    testMode: process.env.AGENT_FABRIC_TEST_MODE === "1"
  };
  return client.register(payload);
}

async function promptForApproval(
  session: BridgeSession,
  command: Extract<ReturnType<typeof parseApprovalCliArgs>, { command: "prompt" }>
): Promise<void> {
  const pending = await call<Parameters<typeof formatPendingApprovals>[0]>(session, "llm_approve_pending", {
    workspaceRoot: command.workspaceRoot,
    includeExpired: false,
    max: 20
  });
  if (pending.requests.length === 0) {
    console.log(formatPendingApprovals(pending));
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const request of pending.requests) {
      console.log(formatPendingApproval(request));
      const answer = await rl.question("Decision [a]pprove/[c]ompact/[d]owngrade/cancel/[s]kip: ");
      const decision = parsePromptDecision(answer);
      if (!decision) continue;
      const result = await decide(session, {
        requestId: request.requestId,
        decision,
        scope: command.scope,
        boundResourceId: command.boundResourceId,
        expiresInSeconds: command.expiresInSeconds,
        note: command.note
      });
      writeResult(result, command.json, () => formatDecisionResult(result));
      return;
    }
    console.log("No approval decision recorded.");
  } finally {
    rl.close();
  }
}

async function decide(
  session: BridgeSession,
  input: {
    requestId: string;
    decision: ApprovalCliDecision;
    scope: "call" | "chain" | "queue" | "session" | "day";
    boundResourceId?: string;
    expiresInSeconds?: number;
    note?: string;
  }
): Promise<Record<string, unknown>> {
  return call(session, "llm_approve", input);
}

async function call<T>(session: BridgeSession, tool: string, input: Record<string, unknown>): Promise<T> {
  return client.call<T>(tool, dropUndefined(input), bridgeCallContext(session, { tool, input }));
}

function writeResult(result: Record<string, unknown>, json: boolean, format: () => string): void {
  console.log(json ? JSON.stringify(result, null, 2) : format());
}

function parsePromptDecision(value: string): ApprovalCliDecision | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized === "s" || normalized === "skip") return undefined;
  if (normalized === "a" || normalized === "approve" || normalized === "allow") return "allow";
  if (normalized === "c" || normalized === "compact") return "compact";
  if (normalized === "d" || normalized === "downgrade") return "downgrade";
  if (normalized === "x" || normalized === "cancel") return "cancel";
  console.log("Skipping unknown decision.");
  return undefined;
}

function dropUndefined(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}
