import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const FORBIDDEN_TRACKED_PATHS = [
  /^decisions(?:\/|$)/,
  /^agent-fabric\.local\.env$/,
  /^\.agent-fabric-local(?:\/|$)/
];
const FORBIDDEN_CONTENT_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "absolute home path", pattern: /\/Users\/ramirihawi\b/ },
  { label: "private overlay path", pattern: /agent-fabric-private\b/ },
  { label: "work email", pattern: /rami\.rihawi@kloeckner\.com/i }
];

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

describe("privacy guard", () => {
  it("does not track local private operating material", () => {
    const files = trackedFiles();
    const forbidden = files.filter((file) => FORBIDDEN_TRACKED_PATHS.some((pattern) => pattern.test(file)));
    expect(forbidden).toEqual([]);
  });

  it("does not contain known private path or identity markers in tracked text files", () => {
    const failures: string[] = [];
    for (const relativePath of trackedFiles()) {
      const absolutePath = join(REPO_ROOT, relativePath);
      let text: string;
      try {
        text = readFileSync(absolutePath, "utf8");
      } catch {
        continue;
      }
      for (const { label, pattern } of FORBIDDEN_CONTENT_PATTERNS) {
        if (pattern.test(text)) failures.push(`${relativePath}: ${label}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
