import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("bundled Jcode DeepSeek worker adapter", () => {
  it("runs Jcode in the assigned workspace and writes a structured result", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-jcode-worker-"));
    try {
      const projectPath = join(dir, "project");
      const outputDir = join(dir, "out");
      mkdirSync(projectPath);
      mkdirSync(outputDir);
      writeFileSync(join(projectPath, "tracked.txt"), "before\n", "utf8");
      spawnSync("git", ["init"], { cwd: projectPath, stdio: "ignore" });
      spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: projectPath, stdio: "ignore" });
      spawnSync("git", ["config", "user.name", "Agent Fabric Test"], { cwd: projectPath, stdio: "ignore" });
      spawnSync("git", ["add", "tracked.txt"], { cwd: projectPath, stdio: "ignore" });
      spawnSync("git", ["commit", "-m", "initial"], { cwd: projectPath, stdio: "ignore" });

      const fakeJcode = join(dir, "fake-jcode.sh");
      writeFileSync(
        fakeJcode,
        [
          "#!/bin/sh",
          "set -eu",
          "printf '{\"event\":\"started\"}\\n'",
          "printf 'fake stderr\\n' >&2",
          "printf 'after\\n' > tracked.txt",
          ""
        ].join("\n"),
        "utf8"
      );
      chmodSync(fakeJcode, 0o755);
      const packet = join(dir, "task.md");
      writeFileSync(packet, "# Task\n\nEdit the tracked file.\n", "utf8");
      const resultFile = join(outputDir, "result.json");

      const result = spawnSync(
        "npx",
        [
          "tsx",
          "src/bin/jcode-deepseek-worker.ts",
          packet,
          "--cwd",
          projectPath,
          "--output-dir",
          outputDir,
          "--result-file",
          resultFile,
          "--jcode-bin",
          fakeJcode
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, npm_config_yes: "true" }
        }
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(resultFile);
      const artifact = JSON.parse(readFileSync(resultFile, "utf8")) as {
        result: { status: string; changedFilesSuggested: string[]; artifacts: { patchFile: string } };
      };
      expect(artifact.result.status).toBe("completed");
      expect(artifact.result.changedFilesSuggested).toContain("tracked.txt");
      expect(readFileSync(artifact.result.artifacts.patchFile, "utf8")).toContain("+after");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a structured timeout failure when Jcode exceeds max runtime", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-jcode-timeout-"));
    try {
      const projectPath = join(dir, "project");
      const outputDir = join(dir, "out");
      mkdirSync(projectPath);
      mkdirSync(outputDir);
      spawnSync("git", ["init"], { cwd: projectPath, stdio: "ignore" });

      const fakeJcode = join(dir, "slow-jcode.sh");
      writeFileSync(
        fakeJcode,
        ["#!/bin/sh", "sleep 2", ""].join("\n"),
        "utf8"
      );
      chmodSync(fakeJcode, 0o755);
      const packet = join(dir, "task.md");
      writeFileSync(packet, "# Task\n\nWait too long.\n", "utf8");
      const resultFile = join(outputDir, "result.json");

      const result = spawnSync(
        "npx",
        [
          "tsx",
          "src/bin/jcode-deepseek-worker.ts",
          packet,
          "--cwd",
          projectPath,
          "--output-dir",
          outputDir,
          "--result-file",
          resultFile,
          "--jcode-bin",
          fakeJcode,
          "--max-runtime-minutes",
          "0.001"
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, npm_config_yes: "true" }
        }
      );

      expect(result.status).not.toBe(0);
      const artifact = JSON.parse(readFileSync(resultFile, "utf8")) as {
        result: { status: string; blockers: string[]; timedOut: boolean };
      };
      expect(artifact.result.status).toBe("failed");
      expect(artifact.result.timedOut).toBe(true);
      expect(artifact.result.blockers[0]).toContain("timed out");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
