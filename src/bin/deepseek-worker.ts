#!/usr/bin/env node
import { deepSeekWorkerHelp, formatDeepSeekWorkerResult, parseDeepSeekWorkerArgs, runDeepSeekWorkerCommand } from "../runtime/deepseek-worker.js";

try {
  const command = parseDeepSeekWorkerArgs(process.argv.slice(2));
  if (command.command === "help") {
    console.log(deepSeekWorkerHelp());
  } else {
    const stdin = await readStdin();
    const result = await runDeepSeekWorkerCommand(command, { stdin });
    process.stdout.write(formatDeepSeekWorkerResult(result, command.json));
  }
} catch (error) {
  const record = error as { code?: string; message?: string };
  if (process.argv.includes("--json")) {
    console.error(
      JSON.stringify({
        schema: "agent-fabric.deepseek-worker-error.v1",
        code: record.code ?? "DEEPSEEK_WORKER_ERROR",
        message: record.message ?? String(error),
        retryable: typeof (error as { retryable?: unknown }).retryable === "boolean" ? (error as { retryable: boolean }).retryable : undefined
      })
    );
  } else {
    const prefix = record.code ? `${record.code}: ` : "";
    console.error(`${prefix}${record.message ?? String(error)}`);
  }
  process.exitCode = 1;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}
