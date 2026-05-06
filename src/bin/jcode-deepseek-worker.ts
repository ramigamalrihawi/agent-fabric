#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type Options = {
  taskPacket?: string;
  outputDir?: string;
  resultFile?: string;
  jcodeBin: string;
  provider: string;
  model: string;
  cwd: string;
  maxTailChars: number;
  maxRuntimeMinutes?: number;
};

try {
  const options = parseArgs(process.argv.slice(2));
  const resultFile = run(options);
  console.log(resultFile);
} catch (error) {
  const record = error as { message?: string };
  console.error(record.message ?? String(error));
  process.exitCode = 1;
}

function run(options: Options): string {
  const taskPacket = required(options.taskPacket, "Usage: agent-fabric-jcode-deepseek-worker <task-packet> [--result-file <path>]");
  const packetPath = resolve(taskPacket);
  if (!existsSync(packetPath)) throw new Error(`Task packet not found: ${packetPath}`);

  const outputDir = resolve(options.outputDir ?? mkdtempSync(join(tmpdir(), "agent-fabric-jcode-deepseek-")));
  mkdirSync(outputDir, { recursive: true });
  const resultFile = resolve(options.resultFile ?? join(outputDir, "worker-result.json"));
  const ndjsonLog = join(outputDir, "jcode.ndjson");
  const stderrLog = join(outputDir, "jcode.stderr.log");
  const patchFile = join(outputDir, "worker.patch");
  const prompt = formatPrompt(packetPath);

  const child = spawnSync(
    options.jcodeBin,
    ["run", "--provider", options.provider, "--model", options.model, "--ndjson", "--no-update", "--quiet", prompt],
    {
      cwd: options.cwd,
      env: {
        ...process.env,
        AGENT_FABRIC_SENIOR_MODE: process.env.AGENT_FABRIC_SENIOR_MODE ?? "permissive"
      },
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      timeout: options.maxRuntimeMinutes ? options.maxRuntimeMinutes * 60_000 : undefined,
      killSignal: "SIGTERM"
    }
  );

  writeFileSync(ndjsonLog, child.stdout ?? "", "utf8");
  writeFileSync(stderrLog, child.stderr ?? "", "utf8");
  const changedFiles = gitLines(["diff", "--name-only"], options.cwd);
  const patch = gitText(["diff", "--binary"], options.cwd);
  if (patch.trim()) writeFileSync(patchFile, patch, "utf8");
  const exitCode = child.status ?? 1;
  const status = exitCode === 0 ? "completed" : "failed";
  const timedOut = child.error && "code" in child.error && child.error.code === "ETIMEDOUT";
  const blockers = exitCode === 0 ? [] : [timedOut ? `Jcode timed out after ${options.maxRuntimeMinutes} minute(s).` : `Jcode exited ${exitCode}`];
  const artifact = {
    schema: "agent-fabric.deepseek-worker-result.v1",
    result: {
      status,
      summary:
        exitCode === 0
          ? "Jcode DeepSeek worker completed through the bundled Agent Fabric adapter."
          : `Jcode DeepSeek worker failed with exit code ${exitCode}.`,
      changedFilesSuggested: changedFiles,
      testsSuggested: [],
      blockers,
      taskPacket: packetPath,
      stdoutTail: tail(child.stdout ?? "", options.maxTailChars),
      stderrTail: tail(child.stderr ?? "", options.maxTailChars),
      timedOut,
      artifacts: {
        ndjsonLog,
        stderrLog,
        patchFile: patch.trim() ? patchFile : undefined
      }
    }
  };
  writeFileSync(resultFile, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  if (exitCode !== 0) process.exitCode = exitCode;
  return resultFile;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    jcodeBin: process.env.JCODE_BIN || process.env.JCODE || "jcode",
    provider: process.env.AGENT_FABRIC_JCODE_PROVIDER || "deepseek",
    model: process.env.AGENT_FABRIC_JCODE_MODEL || "deepseek-v4-pro",
    cwd: process.cwd(),
    maxTailChars: 12_000
  };
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(helpText());
      process.exit(0);
    } else if (arg === "--task-packet") {
      options.taskPacket = required(argv[++index], "--task-packet requires a path");
    } else if (arg === "--output-dir") {
      options.outputDir = required(argv[++index], "--output-dir requires a path");
    } else if (arg === "--result-file") {
      options.resultFile = required(argv[++index], "--result-file requires a path");
    } else if (arg === "--jcode-bin") {
      options.jcodeBin = required(argv[++index], "--jcode-bin requires a path");
    } else if (arg === "--provider") {
      options.provider = required(argv[++index], "--provider requires a value");
    } else if (arg === "--model") {
      options.model = required(argv[++index], "--model requires a value");
    } else if (arg === "--cwd") {
      options.cwd = resolve(required(argv[++index], "--cwd requires a path"));
    } else if (arg === "--max-tail-chars") {
      options.maxTailChars = Number(required(argv[++index], "--max-tail-chars requires a number"));
      if (!Number.isFinite(options.maxTailChars) || options.maxTailChars < 0) throw new Error("--max-tail-chars must be a non-negative number");
    } else if (arg === "--max-runtime-minutes") {
      const value = Number(required(argv[++index], "--max-runtime-minutes requires a number"));
      if (!Number.isFinite(value) || value <= 0) throw new Error("--max-runtime-minutes must be a positive number");
      options.maxRuntimeMinutes = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  options.taskPacket ??= positional[0];
  return options;
}

function formatPrompt(taskPacketPath: string): string {
  return [
    "You are a Jcode DeepSeek worker running under Agent Fabric.",
    "",
    "Follow the task packet exactly. Work only in the assigned workspace. Return concise evidence: files inspected or changed, commands run, tests/checks run, blockers, and the next recommended queue action.",
    "",
    `Task packet (${basename(taskPacketPath)}):`,
    "",
    readFileSync(taskPacketPath, "utf8")
  ].join("\n");
}

function gitLines(args: string[], cwd: string): string[] {
  const text = gitText(args, cwd);
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function gitText(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout : "";
}

function tail(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(value.length - maxChars) : value;
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function helpText(): string {
  return [
    "Usage:",
    "  agent-fabric-jcode-deepseek-worker <task-packet> [--result-file <path>] [--output-dir <dir>]",
    "",
    "Runs one Agent Fabric task packet through Jcode's DeepSeek provider.",
    "Agent Fabric should own queue state, worktree setup, patch review, and acceptance.",
    "",
    "Environment:",
    "  JCODE_BIN                         Jcode binary path, default: jcode",
    "  AGENT_FABRIC_JCODE_PROVIDER      Provider, default: deepseek",
    "  AGENT_FABRIC_JCODE_MODEL         Model, default: deepseek-v4-pro",
    "  --max-runtime-minutes <n>        Kill Jcode and return a structured timeout failure"
  ].join("\n");
}
