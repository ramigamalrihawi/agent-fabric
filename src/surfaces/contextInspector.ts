import { newId } from "../ids.js";
import { FabricError } from "../runtime/errors.js";
import { asRecord, getArray, getField, getOptionalString, getString, safeJsonArray, safeJsonRecord } from "../runtime/input.js";
import type { CallContext } from "../types.js";
import type { SurfaceHost } from "./host.js";

type ContextPackageInput = {
  preflightId: string;
  sessionId: string;
  agentId: string;
  hostName: string | null;
  workspaceRoot: string;
  client: string;
  taskType: string;
  inputTokens: number;
  contextPackage: Record<string, unknown>;
  contextSummary: Record<string, unknown>;
  toolSchemas: unknown[];
  mcpServers: unknown[];
  memories: unknown[];
  sensitiveFlags: string[];
  originPeerId: string;
  traceId?: string;
  correlationId?: string;
  testMode: boolean;
};

type ContextPackageRow = {
  id: string;
  preflight_request_id: string;
  ts: string;
  session_id: string;
  agent_id: string;
  host_name: string | null;
  workspace_root: string;
  client: string;
  task_type: string;
  input_tokens: number;
  raw_content_stored: 0 | 1;
  context_summary_json: string;
  token_breakdown_json: string;
  files_json: string;
  tool_schemas_json: string;
  mcp_servers_json: string;
  memories_json: string;
  sensitive_flags_json: string;
  repeated_regions_json: string;
  stale_items_json: string;
  trace_id: string | null;
  correlation_id: string | null;
};

const SAFE_KEYS = new Set([
  "id",
  "name",
  "path",
  "uri",
  "kind",
  "type",
  "source",
  "reason",
  "tokens",
  "estimatedTokens",
  "inputTokens",
  "bytes",
  "server",
  "tool",
  "ageTurns",
  "lastUsedAt",
  "verified",
  "verifierStatus",
  "status"
]);

export function recordContextPackage(host: SurfaceHost, input: ContextPackageInput): { contextPackageId: string; stored: boolean } {
  const contextPackageId = newId("ctxpkg");
  const files = sanitizedArray(input.contextPackage.files ?? input.contextPackage.fileRefs ?? input.contextPackage.contextFiles);
  const packageToolSchemas = input.toolSchemas.length > 0 ? input.toolSchemas : getArray(input.contextPackage, "toolSchemas");
  const packageMcpServers = input.mcpServers.length > 0 ? input.mcpServers : getArray(input.contextPackage, "mcpServers");
  const packageMemories = input.memories.length > 0 ? input.memories : getArray(input.contextPackage, "memories");
  const repeatedRegions = sanitizedArray(input.contextPackage.repeatedRegions ?? input.contextPackage.duplicates ?? input.contextPackage.repeatedContext);
  const staleItems = sanitizedArray(input.contextPackage.staleItems ?? input.contextPackage.staleContext);
  const tokenBreakdown = sanitizeTokenBreakdown(input.contextPackage.tokenBreakdown ?? input.contextSummary.tokenBreakdown ?? {});

  host.db.db
    .prepare(
      `INSERT INTO context_packages (
        id, preflight_request_id, session_id, agent_id, host_name, workspace_root,
        client, task_type, input_tokens, raw_content_stored, context_summary_json,
        token_breakdown_json, files_json, tool_schemas_json, mcp_servers_json,
        memories_json, sensitive_flags_json, repeated_regions_json, stale_items_json,
        origin_peer_id, trace_id, correlation_id, test_mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      contextPackageId,
      input.preflightId,
      input.sessionId,
      input.agentId,
      input.hostName,
      input.workspaceRoot,
      input.client,
      input.taskType,
      input.inputTokens,
      JSON.stringify(sanitizedRecord(input.contextSummary)),
      JSON.stringify(tokenBreakdown),
      JSON.stringify(files),
      JSON.stringify(sanitizedArray(packageToolSchemas)),
      JSON.stringify(sanitizedArray(packageMcpServers)),
      JSON.stringify(sanitizedArray(packageMemories)),
      JSON.stringify(input.sensitiveFlags),
      JSON.stringify(repeatedRegions),
      JSON.stringify(staleItems),
      input.originPeerId,
      input.traceId ?? null,
      input.correlationId ?? null,
      input.testMode ? 1 : 0
    );
  return { contextPackageId, stored: true };
}

export function fabricInspectContextPackage(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  const session = host.requireSession(context);
  const requestId = getString(input, "requestId");
  const workspaceRoot = getOptionalString(input, "workspaceRoot") ?? context.workspaceRoot ?? session.workspace_root;
  const row = host.db.db
    .prepare("SELECT * FROM context_packages WHERE preflight_request_id = ? AND workspace_root = ?")
    .get(requestId, workspaceRoot) as ContextPackageRow | undefined;
  if (!row) {
    throw new FabricError("CONTEXT_PACKAGE_NOT_FOUND", `Context package not found for preflight: ${requestId}`, false);
  }

  const files = safeJsonArray(row.files_json);
  const toolSchemas = safeJsonArray(row.tool_schemas_json);
  const mcpServers = safeJsonArray(row.mcp_servers_json);
  const memories = safeJsonArray(row.memories_json);
  const sensitiveFlags = safeJsonArray(row.sensitive_flags_json).filter((item): item is string => typeof item === "string");
  const repeatedRegions = safeJsonArray(row.repeated_regions_json);
  const staleItems = safeJsonArray(row.stale_items_json);
  const tokenBreakdown = safeJsonRecord(row.token_breakdown_json);
  const warnings = contextWarnings({
    inputTokens: row.input_tokens,
    files,
    toolSchemas,
    mcpServers,
    memories,
    sensitiveFlags,
    repeatedRegions,
    staleItems,
    tokenBreakdown
  });
  const analysis = contextAnalysis({
    inputTokens: row.input_tokens,
    files,
    toolSchemas,
    mcpServers,
    memories,
    sensitiveFlags,
    repeatedRegions,
    staleItems,
    tokenBreakdown,
    warnings
  });

  return {
    requestId,
    contextPackageId: row.id,
    capturedAt: row.ts,
    workspaceRoot: row.workspace_root,
    client: row.client,
    taskType: row.task_type,
    rawContentStored: row.raw_content_stored === 1,
    summary: {
      inputTokens: row.input_tokens,
      fileCount: files.length,
      toolSchemaCount: toolSchemas.length,
      mcpServerCount: mcpServers.length,
      memoryCount: memories.length,
      sensitiveFlagCount: sensitiveFlags.length,
      repeatedRegionCount: repeatedRegions.length,
      staleItemCount: staleItems.length
    },
    tokenBreakdown,
    files,
    toolSchemas,
    mcpServers,
    memories,
    sensitiveFlags,
    repeatedRegions,
    staleItems,
    warnings,
    analysis
  };
}

function sanitizedArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => sanitizeItem(item)).filter((item) => Object.keys(item).length > 0);
}

function sanitizedRecord(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (SAFE_KEYS.has(key) || /tokens|count|bytes|size|reason|source|kind|type|status/i.test(key)) {
      result[key] = sanitizeScalar(item);
    }
  }
  return result;
}

function sanitizeTokenBreakdown(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "number" && Number.isFinite(item)) {
      result[key] = item;
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const nested = sanitizeTokenBreakdown(item);
      if (Object.keys(nested).length > 0) result[key] = nested;
    }
  }
  return result;
}

function sanitizeItem(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { name: value };
  const record = asRecord(value);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (SAFE_KEYS.has(key) || /tokens|count|bytes|size|reason|source|kind|type|status/i.test(key)) {
      result[key] = sanitizeScalar(item);
    }
  }
  return result;
}

function sanitizeScalar(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(sanitizeScalar).filter((item) => item !== undefined);
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? sanitizedRecord(record) : undefined;
}

function contextWarnings(input: {
  inputTokens: number;
  files: unknown[];
  toolSchemas: unknown[];
  mcpServers: unknown[];
  memories: unknown[];
  sensitiveFlags: string[];
  repeatedRegions: unknown[];
  staleItems: unknown[];
  tokenBreakdown: Record<string, unknown>;
}): string[] {
  const warnings: string[] = [];
  if (input.inputTokens >= 50_000) warnings.push(`Large context package (${input.inputTokens} tokens).`);
  if (input.toolSchemas.length > 5) warnings.push(`Large tool schema set (${input.toolSchemas.length}); consider dropping unused tools.`);
  if (input.sensitiveFlags.length > 0) warnings.push(`Sensitive flags present: ${input.sensitiveFlags.join(", ")}.`);
  if (input.repeatedRegions.length > 0) warnings.push(`Repeated context detected (${input.repeatedRegions.length} regions).`);
  if (input.staleItems.length > 0) warnings.push(`Stale context detected (${input.staleItems.length} items).`);
  if (input.memories.some((memory) => asRecord(memory).verified === false || asRecord(memory).verifierStatus === "unverified")) {
    warnings.push("Unverified memory is present in the context package.");
  }
  if (
    input.files.length === 0 &&
    input.toolSchemas.length === 0 &&
    input.mcpServers.length === 0 &&
    Object.keys(input.tokenBreakdown).length === 0
  ) {
    warnings.push("Client did not provide file/tool/MCP/token breakdown details.");
  }
  return warnings;
}

function contextAnalysis(input: {
  inputTokens: number;
  files: unknown[];
  toolSchemas: unknown[];
  mcpServers: unknown[];
  memories: unknown[];
  sensitiveFlags: string[];
  repeatedRegions: unknown[];
  staleItems: unknown[];
  tokenBreakdown: Record<string, unknown>;
  warnings: string[];
}): Record<string, unknown> {
  const repeatedTokens = sumTokenHints(input.repeatedRegions);
  const staleTokens = sumTokenHints(input.staleItems);
  const unverifiedMemories = input.memories.filter((memory) => asRecord(memory).verified === false || asRecord(memory).verifierStatus === "unverified");
  const knownBreakdownTokens = sumBreakdownTokens(input.tokenBreakdown);
  const estimatedWasteTokens = Math.min(
    input.inputTokens,
    repeatedTokens + staleTokens + sumTokenHints(unverifiedMemories) + Math.max(0, input.toolSchemas.length - 5) * 1_000
  );
  const severity =
    input.sensitiveFlags.length > 0 || input.inputTokens >= 200_000
      ? "blocker"
      : estimatedWasteTokens >= 20_000 || input.inputTokens >= 50_000 || input.toolSchemas.length > 8
        ? "high"
        : estimatedWasteTokens > 0 || input.toolSchemas.length > 5 || unverifiedMemories.length > 0
          ? "medium"
          : "low";
  return {
    severity,
    shouldCompactBeforeModel: severity === "blocker" || input.inputTokens >= 50_000 || input.sensitiveFlags.length > 0,
    estimatedWasteTokens,
    estimatedWasteRatio: input.inputTokens > 0 ? roundRatio(estimatedWasteTokens / input.inputTokens) : 0,
    knownBreakdownTokens,
    breakdownCoverage: input.inputTokens > 0 ? roundRatio(knownBreakdownTokens / input.inputTokens) : 0,
    largestFiles: largestByTokens(input.files, 8),
    largestToolSchemas: largestByTokens(input.toolSchemas, 8),
    largestMemories: largestByTokens(input.memories, 8),
    repeatedTokenEstimate: repeatedTokens,
    staleTokenEstimate: staleTokens,
    unverifiedMemoryCount: unverifiedMemories.length,
    suggestedActions: contextSuggestedActions(input, {
      severity,
      estimatedWasteTokens,
      repeatedTokens,
      staleTokens,
      unverifiedMemoryCount: unverifiedMemories.length
    })
  };
}

function contextSuggestedActions(
  input: {
    inputTokens: number;
    files: unknown[];
    toolSchemas: unknown[];
    mcpServers: unknown[];
    memories: unknown[];
    sensitiveFlags: string[];
    repeatedRegions: unknown[];
    staleItems: unknown[];
    warnings: string[];
  },
  analysis: { severity: string; estimatedWasteTokens: number; repeatedTokens: number; staleTokens: number; unverifiedMemoryCount: number }
): Array<Record<string, unknown>> {
  const actions: Array<Record<string, unknown>> = [];
  if (input.sensitiveFlags.length > 0) {
    actions.push({
      action: "remove_sensitive_context",
      priority: "blocker",
      reason: `Sensitive flags present: ${input.sensitiveFlags.join(", ")}`,
      expectedImpact: "Required before model routing."
    });
  }
  if (input.inputTokens >= 50_000) {
    actions.push({
      action: "compact_context",
      priority: analysis.severity === "blocker" ? "high" : analysis.severity,
      reason: `Context package is ${input.inputTokens} tokens.`,
      expectedImpact: "Lower cost and approval risk."
    });
  }
  if (input.toolSchemas.length > 5) {
    actions.push({
      action: "trim_tool_schemas",
      priority: input.toolSchemas.length > 8 ? "high" : "medium",
      reason: `${input.toolSchemas.length} tool schemas are attached.`,
      expectedImpact: "Expose only task-relevant tools/MCP servers."
    });
  }
  if (analysis.repeatedTokens > 0 || input.repeatedRegions.length > 0) {
    actions.push({
      action: "deduplicate_context",
      priority: "medium",
      reason: `${input.repeatedRegions.length} repeated region(s) detected.`,
      expectedImpact: "Remove repeated file or message regions."
    });
  }
  if (analysis.staleTokens > 0 || input.staleItems.length > 0) {
    actions.push({
      action: "drop_stale_context",
      priority: "medium",
      reason: `${input.staleItems.length} stale item(s) detected.`,
      expectedImpact: "Prefer current files, recent commands, and fresh checkpoints."
    });
  }
  if (analysis.unverifiedMemoryCount > 0) {
    actions.push({
      action: "review_memory",
      priority: "medium",
      reason: `${analysis.unverifiedMemoryCount} unverified memory item(s) attached.`,
      expectedImpact: "Avoid polluting the request with untrusted memory."
    });
  }
  if (actions.length === 0 && input.warnings.length === 0) {
    actions.push({
      action: "proceed",
      priority: "low",
      reason: "No obvious context waste was detected.",
      expectedImpact: "Proceed through the model gate."
    });
  }
  return actions;
}

function largestByTokens(values: unknown[], limit: number): Array<Record<string, unknown>> {
  return values
    .map((value) => {
      const record = asRecord(value);
      return {
        ...record,
        tokens: tokenHint(record)
      };
    })
    .filter((record) => record.tokens > 0)
    .sort((left, right) => Number(right.tokens) - Number(left.tokens))
    .slice(0, limit);
}

function sumTokenHints(values: unknown[]): number {
  return values.reduce<number>((sum, value) => sum + tokenHint(asRecord(value)), 0);
}

function tokenHint(record: Record<string, unknown>): number {
  for (const key of ["tokens", "estimatedTokens", "inputTokens"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
  }
  return 0;
}

function sumBreakdownTokens(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  return Object.values(value as Record<string, unknown>).reduce<number>((sum, item) => sum + sumBreakdownTokens(item), 0);
}

function roundRatio(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
