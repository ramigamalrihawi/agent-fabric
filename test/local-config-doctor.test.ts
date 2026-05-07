import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { formatLocalConfigDoctor, runLocalConfigDoctor } from "../src/runtime/local-config-doctor.js";

describe("local config doctor", () => {
  it("reports single-checkout local config without printing secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-local-doctor-"));
    try {
      const projectPath = join(dir, "agent-fabric");
      const homeDir = join(dir, "home");
      mkdirSync(projectPath, { recursive: true });
      mkdirSync(homeDir, { recursive: true });
      spawnSync("git", ["init"], { cwd: projectPath, stdio: "ignore" });
      writeFileSync(join(projectPath, ".gitignore"), "agent-fabric.local.env\ndecisions/\n", "utf8");
      writeFileSync(
        join(projectPath, "agent-fabric.local.env"),
        [
          'export AGENT_FABRIC_HOME="$HOME/.agent-fabric"',
          `export AGENT_FABRIC_WORKSPACE_ROOT="${projectPath}"`,
          'export AGENT_FABRIC_PROJECT_MODEL_COMMAND="agent-fabric-deepseek-worker model-command --model deepseek-v4-pro --reasoning-effort max"',
          'export AGENT_FABRIC_SENIOR_MODE="permissive"',
          'export AGENT_FABRIC_SENIOR_DEFAULT_WORKER="jcode-deepseek"',
          'export JCODE_BIN="$HOME/.local/bin/jcode"',
          '# export AGENT_FABRIC_JCODE_DEEPSEEK_DISPATCHER="/private/dispatcher.sh"'
        ].join("\n"),
        "utf8"
      );
      mkdirSync(join(projectPath, "decisions"));
      mkdirSync(join(homeDir, ".agent-fabric"), { recursive: true });
      writeFileSync(join(homeDir, ".agent-fabric", "cost-ingest-token"), "local-token\n", "utf8");
      chmodSync(join(homeDir, ".agent-fabric", "cost-ingest-token"), 0o600);
      writeFileSync(join(homeDir, ".ramicode.env"), "export DEEPSEEK_API_KEY=super-secret-key\n", "utf8");
      const codexConfig = join(homeDir, ".codex", "config.toml");
      const claudeConfig = join(homeDir, ".claude.json");
      mkdirSync(join(homeDir, ".codex"), { recursive: true });
      writeFileSync(
        codexConfig,
        `[mcp_servers."agent-fabric"]\ncommand = "node"\nargs = ["${projectPath}/dist/bin/bridge.js"]\n[mcp_servers."agent-fabric".env]\nAGENT_FABRIC_WORKSPACE_ROOT = "${projectPath}"\n`,
        "utf8"
      );
      writeFileSync(
        claudeConfig,
        `{"mcpServers":{"agent-fabric":{"command":"node","args":["${projectPath}/dist/bin/bridge.js"],"env":{"AGENT_FABRIC_WORKSPACE_ROOT":"${projectPath}"}}}}`,
        "utf8"
      );

      const report = runLocalConfigDoctor({
        projectPath,
        homeDir,
        env: { PATH: process.env.PATH },
        mcpConfigPaths: [codexConfig, claudeConfig],
        checkBinaries: false
      });
      const formatted = formatLocalConfigDoctor(report);

      expect(report.ok).toBe(true);
      expect(report.localConfig.gitIgnored).toBe(true);
      expect(report.runtime.costIngestToken).toBe("file");
      expect(report.deepseek.apiKey).toBe("local-env-file");
      expect(report.jcodeDispatcher.status).toBe("disabled");
      expect(report.daemonControl).toMatchObject({
        scope: "shared-local-daemon",
        requiresOperatorApproval: true,
        agentsMayRestart: false,
        agentsMayKill: false,
        agentsMayRemoveSocket: false
      });
      expect(report.localConfig.configuredKeys).toContain("AGENT_FABRIC_SENIOR_DEFAULT_WORKER");
      expect(report.localConfig.configuredKeys).toContain("JCODE_BIN");
      expect(report.mcpConfigs.every((item) => item.hasAgentFabric && item.bridgePathMatches && item.workspaceRootMatches)).toBe(true);
      expect(formatted).not.toContain("super-secret-key");
      expect(formatted).not.toContain("local-token");
      expect(formatted).toContain("Automated agents must not kill, restart, or remove the shared daemon/socket");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns when an optional jcode dispatcher path is configured but missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-local-doctor-jcode-"));
    try {
      const report = runLocalConfigDoctor({
        projectPath: dir,
        homeDir: dir,
        env: {
          PATH: process.env.PATH,
          AGENT_FABRIC_JCODE_DEEPSEEK_DISPATCHER: join(dir, "missing-dispatcher.sh")
        },
        mcpConfigPaths: [],
        checkBinaries: false
      });

      expect(report.jcodeDispatcher).toMatchObject({
        status: "configured",
        exists: false,
        executable: false
      });
      expect(report.checks.find((item) => item.id === "jcode_dispatcher")).toMatchObject({ status: "warn" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
