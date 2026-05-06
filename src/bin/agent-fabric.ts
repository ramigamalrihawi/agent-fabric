#!/usr/bin/env node
import { formatLocalConfigDoctor, localConfigDoctorHelp, runLocalConfigDoctor } from "../runtime/local-config-doctor.js";

try {
  const command = parseRootArgs(process.argv.slice(2));
  if (command.kind === "help") {
    console.log(rootHelp());
  } else if (command.kind === "version") {
    console.log("agent-fabric 0.1.0");
  } else if (command.kind === "local-config-help") {
    console.log(localConfigDoctorHelp());
  } else if (command.kind === "doctor-local-config") {
    const report = runLocalConfigDoctor({ projectPath: command.projectPath });
    console.log(command.json ? JSON.stringify(report, null, 2) : formatLocalConfigDoctor(report));
    process.exitCode = report.ok ? 0 : 1;
  }
} catch (error) {
  const record = error as { message?: string };
  console.error(record.message ?? String(error));
  process.exitCode = 1;
}

type RootCommand =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "local-config-help" }
  | {
      kind: "doctor-local-config";
      projectPath?: string;
      json: boolean;
    };

function parseRootArgs(argv: string[]): RootCommand {
  const args = [...argv];
  const command = args.shift() ?? "help";
  if (command === "help" || command === "--help" || command === "-h") return { kind: "help" };
  if (command === "version" || command === "--version" || command === "-v") return { kind: "version" };
  if (command === "doctor") {
    const topic = args.shift();
    if (topic === "local-config") {
      return parseDoctorLocalConfig(args);
    }
    if (topic === "--help" || topic === "-h" || topic === undefined) {
      return { kind: "local-config-help" };
    }
    throw new Error(`Unknown doctor topic: ${topic}`);
  }
  throw new Error(`Unknown agent-fabric command: ${command}\n\n${rootHelp()}`);
}

function parseDoctorLocalConfig(args: string[]): RootCommand {
  let projectPath: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") json = true;
    else if (arg === "--project") {
      const value = args[++i];
      if (!value) throw new Error("--project requires a value");
      projectPath = value;
    } else if (arg === "--help" || arg === "-h") {
      return { kind: "local-config-help" };
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return { kind: "doctor-local-config", projectPath, json };
}

function rootHelp(): string {
  return [
    "Usage:",
    "  agent-fabric --version",
    "  agent-fabric doctor local-config [--project <path>] [--json]",
    "",
    "Common commands:",
    "  agent-fabric-project senior-doctor --project <path>",
    "  agent-fabric-project senior-run --project <path> --count 10 --approve-model-calls",
    "  agent-fabric-bridge",
    "",
    localConfigDoctorHelp()
  ].join("\n");
}
