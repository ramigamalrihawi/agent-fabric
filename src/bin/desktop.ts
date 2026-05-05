#!/usr/bin/env node
import { spawn } from "node:child_process";
import { startDesktopServer } from "../runtime/desktop-server.js";

const flags = parseArgs(process.argv.slice(2));

try {
  const runtime = await startDesktopServer({
    host: flags.host,
    port: flags.port,
    workspaceRoot: flags.workspaceRoot
  });
  console.error(`agent-fabric desktop listening on ${runtime.url}`);
  if (flags.open) openUrl(runtime.url);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void runtime.close().finally(() => process.exit(0));
    });
  }
} catch (error) {
  const record = error as { code?: string; message?: string };
  const prefix = record.code ? `${record.code}: ` : "";
  console.error(`${prefix}${record.message ?? String(error)}`);
  process.exitCode = 1;
}

type DesktopFlags = {
  host: string;
  port: number;
  workspaceRoot?: string;
  open: boolean;
};

function parseArgs(args: string[]): DesktopFlags {
  const flags: DesktopFlags = {
    host: process.env.AGENT_FABRIC_DESKTOP_HOST ?? "127.0.0.1",
    port: Number(process.env.AGENT_FABRIC_DESKTOP_PORT ?? 4573),
    workspaceRoot: process.env.AGENT_FABRIC_WORKSPACE_ROOT,
    open: process.env.AGENT_FABRIC_DESKTOP_OPEN !== "0"
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--host") flags.host = requireValue(args, ++i, arg);
    else if (arg === "--port") flags.port = positivePort(requireValue(args, ++i, arg));
    else if (arg === "--workspace") flags.workspaceRoot = requireValue(args, ++i, arg);
    else if (arg === "--no-open") flags.open = false;
    else if (arg === "--open") flags.open = true;
    else if (arg === "--help") {
      console.log(help());
      process.exit(0);
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }
  flags.port = positivePort(String(flags.port));
  return flags;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function positivePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) throw new Error("port must be an integer between 0 and 65535");
  return parsed;
}

function openUrl(url: string): void {
  if (process.platform !== "darwin") return;
  const child = spawn("open", [url], { stdio: "ignore", detached: true });
  child.unref();
}

function help(): string {
  return [
    "Usage:",
    "  agent-fabric-desktop [--host 127.0.0.1] [--port 4573|0] [--workspace <path>] [--open|--no-open]",
    "",
    "Use --port 0 to let the OS choose a free local port.",
    "Starts the local Agent Fabric Console command center UI backed by the agent-fabric daemon."
  ].join("\n");
}
