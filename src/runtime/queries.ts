// SQL query helpers, row-grouping primitives, claim overlap checks, and the
// cost-pillar analytics that consume row arrays. Anything that touches the DB
// or aggregates row sets lives here.

import { FabricDb } from "../db.js";
import type { FabricStatus } from "../types.js";
import { safeJsonArray } from "./input.js";
import { formatClaim } from "./format.js";

// -- DB primitives -----------------------------------------------------

export function count(db: FabricDb, table: string): number {
  const row = db.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

export function countWhere(db: FabricDb, table: string, where: string, params: Array<string | number | null>): number {
  const row = db.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(...params) as { count: number };
  return row.count;
}

export function sumReturnedHints(db: FabricDb, sessionId: string): number {
  const rows = db.db.prepare("SELECT memories_returned_json FROM memory_injections WHERE session_id = ?").all(sessionId) as {
    memories_returned_json: string;
  }[];
  return rows.reduce((total, row) => total + safeJsonArray(row.memories_returned_json).length, 0);
}

// -- Row grouping primitives ------------------------------------------

export function sumRows(rows: Record<string, unknown>[], column: string): number {
  return Number(rows.reduce((total, row) => total + Number(row[column] ?? 0), 0).toFixed(6));
}

export function sumBy(rows: Record<string, unknown>[], field: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const row of rows) {
    const key = row[field] === null || row[field] === undefined || row[field] === "" ? "unattributed" : String(row[field]);
    result[key] = Number(((result[key] ?? 0) + Number(row.cost_usd ?? 0)).toFixed(6));
  }
  return result;
}

export function groupByRows(rows: Record<string, unknown>[], field: string): Record<string, Record<string, unknown>[]> {
  const groups: Record<string, Record<string, unknown>[]> = {};
  for (const row of rows) {
    const key = row[field] === null || row[field] === undefined || row[field] === "" ? "unattributed" : String(row[field]);
    groups[key] = [...(groups[key] ?? []), row];
  }
  return groups;
}

export function monthStartIso(asOf: string): string {
  const date = new Date(asOf);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0)).toISOString();
}

// -- Claims ------------------------------------------------------------

export function activeClaimConflicts(db: FabricDb, workspaceRoot: string, paths: string[]): Record<string, unknown>[] {
  const rows = db.db
    .prepare(
      "SELECT * FROM claims WHERE workspace_root = ? AND released = 0 AND (ts_expires IS NULL OR datetime(ts_expires) > CURRENT_TIMESTAMP)"
    )
    .all(workspaceRoot) as Record<string, unknown>[];
  return rows
    .filter((row) => {
      const claimed = safeJsonArray(row.paths_json).map((path) => String(path));
      return paths.some((candidate) => claimed.some((existing) => pathsOverlap(candidate, existing)));
    })
    .map(formatClaim);
}

function pathsOverlap(left: string, right: string): boolean {
  const a = normalizePathClaim(left);
  const b = normalizePathClaim(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function normalizePathClaim(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

// -- Cost analytics ----------------------------------------------------

export function costCoverage(status: FabricStatus): Record<string, unknown> {
  return {
    coveragePct: status.coverage.litellmCoveragePct,
    litellmCoveragePct: status.coverage.litellmCoveragePct,
    outcomeCoveragePct: status.coverage.outcomeCoveragePct,
    byAgent: Object.fromEntries(
      status.bridgeSessions.sessions.map((session) => [session.agentId, session.litellmRouteable ? 100 : 0])
    ),
    byProvider: {},
    uncoveredAgents: status.coverage.uncoveredAgents
  };
}

export function providerSpendRows(
  eventRows: Record<string, unknown>[],
  billingRows: Record<string, unknown>[],
  status: FabricStatus
): Record<string, unknown>[] {
  const estimated = Object.entries(sumBy(eventRows, "provider")).map(([provider, usd]) => ({
    provider,
    usd,
    ledger: "estimated_live",
    freshness: "live",
    coveragePct: status.coverage.litellmCoveragePct
  }));
  const billed = Object.entries(sumBy(billingRows, "source")).map(([provider, usd]) => ({
    provider,
    usd,
    ledger: "billed",
    freshness: status.billing.freshness,
    coveragePct: 100
  }));
  return [...billed, ...estimated];
}

export function deploymentSpendRows(
  eventRows: Record<string, unknown>[],
  billingRows: Record<string, unknown>[]
): Record<string, unknown>[] {
  const billed = Object.entries(groupByRows(billingRows, "resource_id")).map(([resourceId, rows]) => ({
    resourceId,
    displayName: resourceId,
    usd: sumRows(rows, "cost_usd"),
    ledger: "billed",
    source: rows[0]?.source ?? "cost_billing"
  }));
  const estimated = Object.entries(groupByRows(eventRows, "model")).map(([model, rows]) => ({
    resourceId: `${rows[0]?.provider ?? "provider"}:${model}`,
    displayName: model,
    usd: sumRows(rows, "cost_usd"),
    ledger: "estimated_live",
    source: "litellm-derived",
    exemplarTrace: {
      traceId: rows[0]?.trace_id ?? undefined,
      spanId: rows[0]?.span_id ?? undefined,
      correlationId: rows[0]?.correlation_id ?? undefined
    }
  }));
  return [...billed, ...estimated];
}

export function costFeatureRows(rows: Record<string, unknown>[], groupBy: string): Record<string, unknown>[] {
  const field =
    groupBy === "model"
      ? "model"
      : groupBy === "day"
        ? "day"
        : groupBy === "agent"
          ? "agent_id"
          : "model";
  const shaped = groupBy === "day" ? rows.map((row) => ({ ...row, day: String(row.ts).slice(0, 10) })) : rows;
  return Object.entries(groupByRows(shaped, field)).map(([key, items]) => ({
    key,
    usd: sumRows(items, "cost_usd"),
    ledger: "estimated_live",
    calls: items.length,
    coveragePct: 100
  }));
}

export function detectCostAnomalies(
  rows: Record<string, unknown>[],
  since: string,
  threshold: number
): Record<string, unknown>[] {
  const byResource = groupByRows(rows, "model");
  return Object.entries(byResource).flatMap(([model, items]) => {
    const current = items.filter((row) => String(row.ts) >= since);
    const baseline = items.filter((row) => String(row.ts) < since);
    const todayUsd = sumRows(current, "cost_usd");
    const daily = Object.values(
      groupByRows(
        baseline.map((row) => ({ ...row, day: String(row.ts).slice(0, 10) })),
        "day"
      )
    ).map((dayRows) => sumRows(dayRows, "cost_usd"));
    const avg = daily.length ? daily.reduce((total, value) => total + value, 0) / daily.length : 0;
    const variance = daily.length ? daily.reduce((total, value) => total + (value - avg) ** 2, 0) / daily.length : 0;
    const std = Math.sqrt(variance);
    const sigmas = std === 0 ? (todayUsd > avg && todayUsd > 0 ? Number.POSITIVE_INFINITY : 0) : (todayUsd - avg) / std;
    if (sigmas < threshold) return [];
    const provider = current[0]?.provider ?? baseline[0]?.provider ?? "provider";
    const featureSpend = sumBy(current, "feature_tag");
    const topFeature = Object.entries(featureSpend).sort((a, b) => b[1] - a[1])[0]?.[0];
    return [
      {
        resourceId: `${provider}:${model}`,
        todayUsd,
        rolling7dAvgUsd: Number(avg.toFixed(6)),
        rolling7dStdUsd: Number(std.toFixed(6)),
        sigmas: Number.isFinite(sigmas) ? Number(sigmas.toFixed(3)) : "infinity",
        likelyCauseHints: topFeature ? [`feature_tag ${topFeature} is the largest contributor in the current window`] : []
      }
    ];
  });
}
