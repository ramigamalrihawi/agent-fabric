import { spawn } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { FabricError } from "./errors.js";

export function validateGitStylePatch(patch: string, cwd?: string): void {
  if (!/^diff --git /m.test(patch)) {
    throw new FabricError("INVALID_PATCH", "patch apply requires a git-style unified diff with diff --git headers", false);
  }
  const paths = extractPatchPaths(patch);
  if (paths.length === 0) {
    throw new FabricError("INVALID_PATCH", "patch contained no file paths", false);
  }
  for (const path of paths) {
    validatePatchPath(path);
    if (cwd) validatePatchTargetUnderCwd(path, cwd);
  }
}

export async function applyPatchWithSystemPatch(patch: string, cwd: string): Promise<Record<string, unknown>> {
  validateGitStylePatch(patch, cwd);
  const dryRun = await runPatch(patch, cwd, true);
  const applied = await runPatch(patch, cwd, false);
  return {
    applied: true,
    command: "patch -p1 -N -t -s -F 0",
    dryRun,
    ...applied
  };
}

export function resolvePatchFilePath(requestedPatchFile: string | undefined, outputFile: string, cwd: string): string {
  const resolvedCwd = resolve(cwd);
  const resolvedOutputFile = isAbsolute(outputFile) ? resolve(outputFile) : resolve(cwd, outputFile);
  const outputDir = dirname(resolvedOutputFile);
  const target = requestedPatchFile
    ? isAbsolute(requestedPatchFile)
      ? resolve(requestedPatchFile)
      : resolve(cwd, requestedPatchFile)
    : `${resolvedOutputFile.replace(/\.json$/i, "")}.patch`;
  if (!isPathInside(target, resolvedCwd) && !isPathInside(target, outputDir)) {
    throw new FabricError("INVALID_PATCH_PATH", `patch file must stay under cwd or output directory: ${target}`, false);
  }
  return target;
}

function runPatch(patch: string, cwd: string, checkOnly: boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const args = ["-p1", "-N", "-t", "-s", "-F", "0"];
    if (checkOnly) args.push("-C");
    const child = spawn("patch", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(new FabricError("PATCH_APPLY_FAILED", error.message, false));
    });
    child.on("close", (code, signal) => {
      if (code !== 0) {
        reject(new FabricError("PATCH_APPLY_FAILED", stderr.trim() || stdout.trim() || `patch exited ${code}`, false));
        return;
      }
      resolve({
        checkOnly,
        exitCode: code,
        signal,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
    child.stdin.end(patch);
  });
}

function extractPatchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const tokens = line.trim().split(/\s+/);
      if (tokens.length !== 4) {
        throw new FabricError("INVALID_PATCH_PATH", `unsupported patch path syntax: ${line}`, false);
      }
      paths.add(stripDiffPrefix(tokens[2]));
      paths.add(stripDiffPrefix(tokens[3]));
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const tokens = line.trim().split(/\s+/);
      if (tokens.length !== 2) {
        throw new FabricError("INVALID_PATCH_PATH", `unsupported patch path syntax: ${line}`, false);
      }
      if (tokens[1] !== "/dev/null") {
        paths.add(stripDiffPrefix(tokens[1]));
      }
    }
  }
  return [...paths].filter(Boolean);
}

function stripDiffPrefix(path: string): string {
  if (path === "/dev/null") return "";
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

function validatePatchPath(path: string): void {
  if (!path || path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("\0") || /^[A-Za-z]:/.test(path)) {
    throw new FabricError("INVALID_PATCH_PATH", `unsafe patch path: ${path}`, false);
  }
  const parts = path.split("/");
  if (parts.includes("..") || parts.includes(".git")) {
    throw new FabricError("INVALID_PATCH_PATH", `unsafe patch path: ${path}`, false);
  }
}

function validatePatchTargetUnderCwd(path: string, cwd: string): void {
  const resolvedCwd = resolve(cwd);
  if (!existsSync(resolvedCwd)) {
    throw new FabricError("INVALID_PATCH_PATH", `patch cwd does not exist: ${cwd}`, false);
  }
  if (lstatSync(resolvedCwd).isSymbolicLink()) {
    throw new FabricError("INVALID_PATCH_PATH", `patch cwd is a symlink: ${cwd}`, false);
  }
  const target = resolve(resolvedCwd, path);
  if (!isPathInside(target, resolvedCwd)) {
    throw new FabricError("INVALID_PATCH_PATH", `patch target escapes cwd: ${path}`, false);
  }
  const relativeTarget = relative(resolvedCwd, target);
  const segments = relativeTarget.split(sep).filter(Boolean);
  let current = resolvedCwd;
  for (const segment of segments) {
    current = resolve(current, segment);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) {
      throw new FabricError("INVALID_PATCH_PATH", `patch target uses symlink path segment: ${path}`, false);
    }
  }
}

function isPathInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
