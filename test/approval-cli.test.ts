import { describe, expect, it } from "vitest";
import {
  approvalHelp,
  formatDecisionResult,
  formatPendingApproval,
  formatPendingApprovals,
  parseApprovalCliArgs
} from "../src/runtime/approval-cli.js";
import { FabricError } from "../src/runtime/errors.js";

describe("approval CLI runtime", () => {
  it("parses list flags", () => {
    expect(parseApprovalCliArgs(["list", "--json", "--workspace", "/tmp/project", "--include-expired", "--max", "5"])).toEqual({
      command: "list",
      json: true,
      workspaceRoot: "/tmp/project",
      includeExpired: true,
      max: 5
    });
  });

  it("parses direct approval decisions", () => {
    expect(parseApprovalCliArgs(["approve", "pf_123", "--scope", "chain", "--expires", "600", "--note", "approved by terminal", "--json"])).toEqual({
      command: "decide",
      json: true,
      requestId: "pf_123",
      decision: "allow",
      scope: "chain",
      boundResourceId: undefined,
      expiresInSeconds: 600,
      note: "approved by terminal"
    });
    expect(parseApprovalCliArgs(["approve", "pf_queue", "--queue", "pqueue_1"])).toMatchObject({
      command: "decide",
      requestId: "pf_queue",
      decision: "allow",
      scope: "queue",
      boundResourceId: "project_queue:pqueue_1"
    });
    expect(parseApprovalCliArgs(["compact", "pf_456"])).toMatchObject({ command: "decide", requestId: "pf_456", decision: "compact" });
  });

  it("parses prompt defaults", () => {
    expect(parseApprovalCliArgs(["prompt"])).toEqual({
      command: "prompt",
      json: false,
      workspaceRoot: undefined,
      scope: "call",
      boundResourceId: undefined,
      expiresInSeconds: undefined,
      note: undefined
    });
  });

  it("formats pending approvals for terminal review", () => {
    const request = {
      requestId: "pf_123",
      expiresAt: "2026-04-29T10:30:00.000Z",
      client: "local-cli",
      taskType: "code_edit",
      selected: { provider: "deepseek", model: "deepseek-v4-pro", reasoning: "max" },
      estimate: { inputTokens: 42000, reservedOutputTokens: 8000, estimatedCostUsd: 0.55 },
      risk: "high",
      warnings: ["High reasoning requested."]
    };

    expect(formatPendingApproval(request)).toContain("pf_123");
    expect(formatPendingApproval(request)).toContain("deepseek/deepseek-v4-pro (max)");
    expect(formatPendingApprovals({ workspaceRoot: "/tmp/project", count: 1, requests: [request] })).toContain(
      "Pending approvals for /tmp/project:"
    );
    expect(formatPendingApprovals({ workspaceRoot: "/tmp/project", count: 0, requests: [] })).toBe("No pending approvals for /tmp/project.");
  });

  it("formats decision results", () => {
    expect(
      formatDecisionResult({
        requestId: "pf_123",
        status: "approved",
        decision: "allow",
        scope: "call",
        approvalToken: "secret-token"
      })
    ).toContain("approvalToken: secret-token");
  });

  it("returns help text", () => {
    expect(approvalHelp()).toContain("agent-fabric-approve list");
    expect(parseApprovalCliArgs(["--help"])).toEqual({ command: "help", json: false });
  });

  it("rejects invalid commands and flag values", () => {
    expect(() => parseApprovalCliArgs(["approve"])).toThrow(FabricError);
    expect(() => parseApprovalCliArgs(["list", "--max", "0"])).toThrow("max must be a positive integer");
    expect(() => parseApprovalCliArgs(["prompt", "--scope", "forever"])).toThrow("scope must be call, chain, queue, session, or day");
    expect(() => parseApprovalCliArgs(["wat"])).toThrow("Unknown approval CLI command: wat");
  });
});
