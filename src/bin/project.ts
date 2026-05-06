#!/usr/bin/env node
import { resolve } from "node:path";
import { FabricClient } from "../client.js";
import { defaultPaths } from "../paths.js";
import { bridgeCallContext } from "../runtime/bridge-context.js";
import { formatLocalConfigDoctor, runLocalConfigDoctor } from "../runtime/local-config-doctor.js";
import { formatProjectResult, parseProjectCliArgs, projectHelp, runProjectCommand } from "../runtime/project-cli.js";
import type { BridgeRegister, BridgeSession } from "../types.js";

const paths = defaultPaths();
const client = new FabricClient(paths.socketPath);

try {
  const command = parseProjectCliArgs(process.argv.slice(2));
  if (command.command === "help") {
    console.log(projectHelp());
  } else if (command.command === "version") {
    console.log("agent-fabric-project 0.1.0");
  } else if (command.command === "local-config-doctor") {
    const result = runLocalConfigDoctor({ projectPath: command.projectPath });
    console.log(command.json ? JSON.stringify(result, null, 2) : formatLocalConfigDoctor(result));
    process.exitCode = result.ok ? 0 : 1;
  } else {
    const session = await register(projectWorkspaceRoot(command));
    try {
      const result = await runProjectCommand(command, (tool, input) => call(session, tool, input));
      console.log(formatProjectResult(result, command.json));
    } finally {
      await closeSession(session).catch(() => undefined);
    }
  }
} catch (error) {
  const record = error as { code?: string; message?: string };
  const prefix = record.code ? `${record.code}: ` : "";
  console.error(`${prefix}${record.message ?? String(error)}`);
  process.exitCode = 1;
}

async function register(projectRoot?: string): Promise<BridgeSession> {
  const workspaceRoot = process.env.AGENT_FABRIC_WORKSPACE_ROOT ?? projectRoot ?? process.cwd();
  const payload: BridgeRegister = {
    bridgeVersion: "0.1.0",
    agent: {
      id: process.env.AGENT_FABRIC_AGENT_ID ?? "project-cli",
      displayName: process.env.AGENT_FABRIC_AGENT_NAME ?? "agent-fabric project CLI",
      vendor: "local"
    },
    host: {
      name: "Project CLI",
      transport: "uds"
    },
    workspace: {
      root: workspaceRoot,
      source: process.env.AGENT_FABRIC_WORKSPACE_ROOT || projectRoot ? "explicit" : "cwd"
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
      detail: "terminal project CLI is request/response only"
    },
    testMode: process.env.AGENT_FABRIC_TEST_MODE === "1"
  };
  return client.register(payload);
}

async function call<T>(session: BridgeSession, tool: string, input: Record<string, unknown>): Promise<T> {
  const cleaned = dropUndefined(input);
  return client.call<T>(tool, cleaned, bridgeCallContext(session, { tool, input: cleaned }));
}

async function closeSession(session: BridgeSession): Promise<void> {
  await client.call("fabric_session_close", {}, bridgeCallContext(session, { tool: "fabric_session_close", input: {} }));
}

function projectWorkspaceRoot(command: ReturnType<typeof parseProjectCliArgs>): string | undefined {
  if ("projectPath" in command && typeof command.projectPath === "string") return resolve(command.projectPath);
  return undefined;
}

function dropUndefined(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}
