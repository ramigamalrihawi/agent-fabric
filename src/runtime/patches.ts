import { spawn } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { FabricError } from "./errors.js";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export interface PatchFileEntry {
  /** Relative path to the target file (new path for renames). */
  path: string;
  /** Source path for renames/deletions, otherwise null. */
  oldPath: string | null;
  /** Destination path for renames/additions, otherwise null. */
  newPath: string | null;
  changeType: "add" | "remove" | "modify" | "rename";
  additions: number;
  deletions: number;
}

export interface PatchDiffSummary {
  files: PatchFileEntry[];
  totalAdditions: number;
  totalDeletions: number;
  totalFiles: number;
}

/* ------------------------------------------------------------------ */
/*  Path safety (exported)                                            */
/* ------------------------------------------------------------------ */

export function extractPatchPaths(patch: string): string[] {
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

export function stripDiffPrefix(path: string): string {
  if (path === "/dev/null") return "";
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

export function validatePatchPath(path: string): void {
  if (!path || path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("\0") || /^[A-Za-z]:/.test(path)) {
    throw new FabricError("INVALID_PATCH_PATH", `unsafe patch path: ${path}`, false);
  }
  const parts = path.split("/");
  if (parts.includes("..") || parts.includes(".git")) {
    throw new FabricError("INVALID_PATCH_PATH", `unsafe patch path: ${path}`, false);
  }
}

/**
 * Check whether `path` is inside `root`, resolving symlinks.
 * Rejects absolute, traversal, symlink, and .git targets.
 * Returns true only when safe; false when any safety check fails.
 */
export function isPathSafeBelow(path: string, root: string): boolean {
  try {
    validatePatchPath(path);
  } catch {
    return false;
  }
  try {
    const resolvedRoot = resolve(root);
    if (!existsSync(resolvedRoot)) return false;
    if (lstatSync(resolvedRoot).isSymbolicLink()) return false;
    const target = resolve(resolvedRoot, path);
    if (!isPathInside(target, resolvedRoot)) return false;
    const relativeTarget = relative(resolvedRoot, target);
    const segments = relativeTarget.split(sep).filter(Boolean);
    let current = resolvedRoot;
    for (const segment of segments) {
      current = resolve(current, segment);
      if (!existsSync(current)) continue;
      if (lstatSync(current).isSymbolicLink()) return false;
    }
    for (const segment of segments) {
      if (segment === ".." || segment === ".git") return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function isPathInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/* ------------------------------------------------------------------ */
/*  Diff summary                                                      */
/* ------------------------------------------------------------------ */

const PLACEHOLDER_PATTERNS = [
  /HUNK_PLACEHOLDER/,
  /PLACEHOLDER/,
  /\[TODO:?\s*(add|fill|insert|write|implement)/i,
  /\[placeholder/i,
  /@@\s*-\d+,\d+\s+\+\d+,\d+\s*@@\s*TODO/i,
];

/** Detect patches composed entirely of placeholder instructions with no real hunks. */
export function hasPlaceholderHunks(patch: string): boolean {
  const lines = patch.split(/\r?\n/);
  let hunkCount = 0;
  let placeholderHunkCount = 0;

  for (const line of lines) {
    if (/^@@\s+-\d+.*\+\d+.*@@/.test(line)) {
      hunkCount++;
      for (const pattern of PLACEHOLDER_PATTERNS) {
        if (pattern.test(line)) {
          placeholderHunkCount++;
          break;
        }
      }
    }
  }

  // If every hunk is a placeholder, reject the entire patch.
  return hunkCount > 0 && hunkCount === placeholderHunkCount;
}

/**
 * Parse a git-style unified diff into a structured summary.
 * Returns null if the patch is malformed.
 */
export function summarizeDiff(patch: string): PatchDiffSummary | null {
  try {
    validateGitStylePatchHeader(patch);
  } catch {
    return null;
  }

  // Split into per-file sections by "diff --git" lines.
  const sections = splitDiffSections(patch);
  const files: PatchFileEntry[] = [];

  for (const section of sections) {
    const entry = parseFileSection(section);
    if (entry) files.push(entry);
  }

  if (files.length === 0) return null;

  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  return {
    files,
    totalAdditions,
    totalDeletions,
    totalFiles: files.length,
  };
}

function validateGitStylePatchHeader(patch: string): void {
  if (!/^diff --git /m.test(patch)) {
    throw new FabricError("INVALID_PATCH", "not a git-style unified diff", false);
  }
}

function splitDiffSections(patch: string): string[] {
  const lines = patch.split(/\r?\n/);
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      sections.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) {
    sections.push(current.join("\n"));
  }

  return sections;
}

function parseFileSection(section: string): PatchFileEntry | null {
  const lines = section.split(/\r?\n/);

  // Extract header paths. Use raw (unprefixed) values from ---/+++ lines
  // for /dev/null detection.
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let isRename = false;

  for (const line of lines) {
    if (line.startsWith("rename from ")) {
      oldPath = line.slice("rename from ".length).trim();
      isRename = true;
    } else if (line.startsWith("rename to ")) {
      newPath = line.slice("rename to ".length).trim();
      isRename = true;
    } else if (line.startsWith("diff --git ")) {
      const tokens = line.trim().split(/\s+/);
      if (tokens.length === 4 && !isRename) {
        const a = stripDiffPrefix(tokens[2]);
        const b = stripDiffPrefix(tokens[3]);
        if (a !== b) isRename = true;
        oldPath = a || null;
        newPath = b || null;
      }
    } else if (line.startsWith("--- ")) {
      const tokens = line.trim().split(/\s+/);
      if (tokens.length === 2) {
        oldPath = tokens[1] === "/dev/null" ? null : stripDiffPrefix(tokens[1]) || null;
      }
    } else if (line.startsWith("+++ ")) {
      const tokens = line.trim().split(/\s+/);
      if (tokens.length === 2) {
        newPath = tokens[1] === "/dev/null" ? null : stripDiffPrefix(tokens[1]) || null;
      }
    }
  }

  // Determine change type
  let changeType: PatchFileEntry["changeType"];
  if (isRename) {
    changeType = "rename";
  } else if (oldPath === null && newPath !== null) {
    changeType = "add";
  } else if (newPath === null && oldPath !== null) {
    changeType = "remove";
  } else {
    changeType = "modify";
  }

  // Count additions/deletions from hunk lines
  let additions = 0;
  let deletions = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++;
    }
  }

  const targetPath = newPath ?? oldPath ?? "";

  return {
    path: targetPath,
    oldPath: oldPath === "/dev/null" ? null : oldPath,
    newPath: newPath === "/dev/null" ? null : newPath,
    changeType,
    additions,
    deletions,
  };
}

/* ------------------------------------------------------------------ */
/*  Validation                                                        */
/* ------------------------------------------------------------------ */

export function validateGitStylePatch(patch: string, cwd?: string): void {
  validateGitStylePatchHeader(patch);

  // Reject patches with placeholder hunks (no real diff content).
  if (hasPlaceholderHunks(patch)) {
    throw new FabricError("INVALID_PATCH", "patch contains placeholder hunks instead of real diff content", false);
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

export async function checkPatchWithSystemPatch(patch: string, cwd: string): Promise<Record<string, unknown>> {
  validateGitStylePatch(patch, cwd);
  return runPatch(patch, cwd, true);
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

/* ------------------------------------------------------------------ */
/*  Artifact resolution                                               */
/* ------------------------------------------------------------------ */

/**
 * Defines the possible shapes of a DeepSeek worker result artifact.
 */
export interface DeepSeekWorkerArtifact {
  schema?: string;
  status?: string;
  patchMode?: string;
  patchFile?: string;
  result?: {
    status?: string;
    summary?: string;
    proposedPatch?: string;
    changedFilesSuggested?: string[];
    testsSuggested?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ResolvedArtifactPatch {
  /** The actual diff text, if resolvable. */
  patchText: string | null;
  /** Path to an on-disk patch file, if patchMode is "write" or "apply". */
  patchFilePath: string | null;
  /** The patch mode: report, write, or apply. */
  patchMode: string | null;
  /** Human-readable reason for resolution failure. */
  error: string | null;
}

/**
 * Extract patch content from a worker result artifact, supporting three
 * common shapes:
 *
 *  1. report mode: artifact.result.proposedPatch is inline text.
 *  2. write mode:  artifact.patchFile points to an on-disk path.
 *  3. apply mode:  artifact.patchFile points to an on-disk path.
 *
 * All resolved paths are checked for safety via `isPathSafeBelow`.
 */
export function resolveArtifactPatch(
  artifact: DeepSeekWorkerArtifact,
  cwd: string
): ResolvedArtifactPatch {
  const mode = artifact.patchMode ?? null;

  // Inline proposedPatch (report mode)
  const inlinePatch = artifact.result?.proposedPatch;
  if (typeof inlinePatch === "string" && inlinePatch.length > 0) {
    return {
      patchText: inlinePatch,
      patchFilePath: null,
      patchMode: mode,
      error: null,
    };
  }

  // On-disk patchFile (write/apply modes)
  const patchFile = artifact.patchFile;
  if (typeof patchFile === "string" && patchFile.length > 0) {
    if (!isPathSafeBelow(patchFile, cwd)) {
      return {
        patchText: null,
        patchFilePath: null,
        patchMode: mode,
        error: `Patch file path is unsafe or outside cwd: ${patchFile}`,
      };
    }
    const resolvedPath = resolve(cwd, patchFile);
    return {
      patchText: null,
      patchFilePath: resolvedPath,
      patchMode: mode,
      error: null,
    };
  }

  return {
    patchText: null,
    patchFilePath: null,
    patchMode: mode,
    error: "No patch content or file path found in artifact",
  };
}

/* ------------------------------------------------------------------ */
/*  Private helpers                                                   */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Lightweight diff stats for dry-run output                         */
/* ------------------------------------------------------------------ */

export interface PatchDiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
  affectedFiles: string[];
}

/* ------------------------------------------------------------------ */
/*  Artifact ignore globs for patch harvesting                        */
/* ------------------------------------------------------------------ */

/**
 * Default artifact ignore globs cover common generated artifacts.
 * These patterns are matched against basenames during recursive walks.
 * Exact names match as-is; patterns containing `*` or `?` are treated
 * as simple globs.
 */
export const DEFAULT_ARTIFACT_IGNORE_GLOBS = [
  "*.log",
  "*.tsbuildinfo",
  "*.pyc",
  "*.pyo",
  "*.class",
  "*.o",
  "*.a",
  "*.so",
  "*.dylib",
  "*.exe",
  "*.dll",
  "*.wasm",
  "*.map",
  "*.min.js",
  "*.min.css",
  "__pycache__",
  ".DS_Store",
  "Thumbs.db",
  "*.swp",
  "*.swo",
  "*~"
];

/**
 * Resolve merged artifact ignore globs from environment and CLI additions.
 *
 * Merge order (last wins for conflicts):
 * 1. DEFAULT_ARTIFACT_IGNORE_GLOBS (always applied)
 * 2. AGENT_FABRIC_ARTIFACT_IGNORE_GLOBS env var (colon, comma, space, or semicolon delimited)
 * 3. CLI-supplied additions (--artifact-ignore, repeatable)
 *
 * Returns a set of lowercase glob strings for efficient lookup.
 */
export function resolveArtifactIgnoreGlobs(cliAdditions?: string[]): Set<string> {
  const globs = new Set(DEFAULT_ARTIFACT_IGNORE_GLOBS.map((g) => g.toLowerCase()));

  const envValue = process.env.AGENT_FABRIC_ARTIFACT_IGNORE_GLOBS ?? "";
  for (const part of envValue.split(/[,:;\s]+/)) {
    const trimmed = part.trim();
    if (trimmed) globs.add(trimmed.toLowerCase());
  }

  if (cliAdditions) {
    for (const addition of cliAdditions) {
      const trimmed = addition.trim();
      if (trimmed) globs.add(trimmed.toLowerCase());
    }
  }

  return globs;
}

/**
 * Check whether a path segment (basename) should be ignored based on artifact globs.
 */
export function shouldIgnoreArtifact(name: string, ignoreGlobs: Set<string>): boolean {
  const lower = name.toLowerCase();
  if (ignoreGlobs.has(lower)) return true;

  // Check glob patterns (those containing * or ?)
  for (const pattern of ignoreGlobs) {
    if (!pattern.includes("*") && !pattern.includes("?")) continue;
    if (simpleGlobMatch(pattern, lower)) return true;
  }

  return false;
}

function simpleGlobMatch(pattern: string, value: string): boolean {
  const regexStr =
    "^" +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".") +
    "$";
  try {
    return new RegExp(regexStr).test(value);
  } catch {
    return false;
  }
}

/**
 * Compute diff stats from a patch without full file-entry parsing.
 * Returns basic counts and affected sorted paths for quick dry-run output.
 */
export function computePatchDiffStats(patch: string): PatchDiffStats {
  const paths = new Set<string>();
  let insertions = 0;
  let deletions = 0;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const tokens = line.trim().split(/\s+/);
      if (tokens.length === 4) {
        paths.add(stripDiffPrefix(tokens[2]));
      }
    } else if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    } else if (line.startsWith("@@")) {
      continue;
    } else if (line.startsWith("+")) {
      insertions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return {
    filesChanged: paths.size,
    insertions,
    deletions,
    affectedFiles: [...paths].sort()
  };
}
