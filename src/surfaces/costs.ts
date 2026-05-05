import { getOptionalNumber, getOptionalString, getString } from "../runtime/input.js";
import { idleAuditFromBillingRows } from "../costing.js";
import {
  costCoverage,
  costFeatureRows,
  deploymentSpendRows,
  detectCostAnomalies,
  monthStartIso,
  providerSpendRows,
  sumBy,
  sumRows
} from "../runtime/queries.js";
import type { CallContext } from "../types.js";
import type { SurfaceHost } from "./host.js";

export function ppCostMonth(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  host.requireSession(context);
  const asOf = getOptionalString(input, "asOf") ?? host.now().toISOString();
  const monthStart = monthStartIso(asOf);
  const billedRows = host.db.db
    .prepare(
      "SELECT * FROM cost_billing WHERE source IN ('azure-cost-mgmt', 'azure') AND datetime(COALESCE(period_start, ts_polled)) >= datetime(?) AND datetime(COALESCE(period_start, ts_polled)) <= datetime(?)"
    )
    .all(monthStart, asOf) as Record<string, unknown>[];
  const fixedRows = host.db.db
    .prepare(
      "SELECT * FROM cost_billing WHERE source IN ('runpod-graphql', 'vultr-billing', 'azure-monitor') AND datetime(COALESCE(period_start, ts_polled)) <= datetime(?)"
    )
    .all(asOf) as Record<string, unknown>[];
  const eventRows = host.db.db.prepare("SELECT * FROM cost_events WHERE datetime(ts) >= datetime(?) AND datetime(ts) <= datetime(?)").all(monthStart, asOf) as Record<string, unknown>[];
  const status = host.fabricStatus();
  const billed = sumRows(billedRows, "cost_usd");
  const estimated = sumRows(eventRows, "cost_usd");
  const fixed = sumRows(fixedRows, "cost_usd");
  return {
    ledgers: {
      billed: { usd: billed, freshness: billed ? "azure-24h-lag" : status.billing.freshness, sources: billed ? ["azure-cost-mgmt"] : [] },
      estimated_live: { usd: estimated, freshness: "live", sources: estimated ? ["cost_events"] : [] },
      fixed_capacity: { usd: fixed, freshness: "provider-cache", sources: fixed ? ["provider-inventory"] : [] },
      uncovered: {
        knownSessions: status.coverage.uncoveredAgents.length,
        reason: "sessions without recent LiteLLM cost_events are reported as coverage gaps, not guessed spend"
      }
    },
    coverage: costCoverage(status),
    byProvider: providerSpendRows(eventRows, [...billedRows, ...fixedRows], status),
    byDeployment: deploymentSpendRows(eventRows, [...billedRows, ...fixedRows]),
    byFeatureTag: sumBy(eventRows, "feature_tag"),
    byAgent: sumBy(eventRows, "agent_id"),
    warnings: status.warnings
  };
}

export function ppCostByFeature(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  host.requireSession(context);
  const tag = getString(input, "tag");
  const since = getOptionalString(input, "since") ?? monthStartIso(host.now().toISOString());
  const groupBy = getOptionalString(input, "groupBy") ?? "deployment";
  const now = host.now().toISOString();
  const rows = host.db.db
    .prepare("SELECT * FROM cost_events WHERE feature_tag = ? AND datetime(ts) >= datetime(?) AND datetime(ts) <= datetime(?) ORDER BY ts")
    .all(tag, since, now) as Record<string, unknown>[];
  const status = host.fabricStatus();
  const ledgers = {
    billed: { usd: 0, freshness: status.billing.freshness, sources: [] },
    estimated_live: { usd: sumRows(rows, "cost_usd"), freshness: "live", sources: rows.length ? ["cost_events"] : [] },
    fixed_capacity: { usd: 0, freshness: "provider-cache", sources: [] },
    uncovered: {
      knownSessions: status.bridgeSessions.sessions.filter((session) => !session.litellmRouteable).length,
      reason: "feature attribution only includes rows that reached cost_events with this feature_tag"
    }
  };
  return { tag, windowStart: since, windowEnd: now, ledgers, coverage: costCoverage(status), rows: costFeatureRows(rows, groupBy) };
}

export function ppCostAnomaly(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  host.requireSession(context);
  const since = getOptionalString(input, "since") ?? new Date(host.now().getTime() - 24 * 60 * 60 * 1000).toISOString();
  const threshold = getOptionalNumber(input, "threshold") ?? 2;
  const windowStart = new Date(Date.parse(since) - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = host.db.db.prepare("SELECT * FROM cost_events WHERE ts >= ? ORDER BY ts").all(windowStart) as Record<string, unknown>[];
  return { anomalies: detectCostAnomalies(rows, since, threshold) };
}

export function ppCostIdleAudit(host: SurfaceHost, input: unknown, context: CallContext): Record<string, unknown> {
  host.requireSession(context);
  const rows = host.db.db
    .prepare("SELECT * FROM cost_billing WHERE source IN ('runpod-graphql', 'vultr-billing', 'azure-monitor', 'openrouter-keys')")
    .all() as Record<string, unknown>[];
  return idleAuditFromBillingRows(rows, {
    thresholdDays: getOptionalNumber(input, "thresholdDays"),
    estimateForwardMonths: getOptionalNumber(input, "estimateForwardMonths")
  });
}

export function ppCostQuotaStatus(host: SurfaceHost, _input: unknown, context: CallContext): Record<string, unknown> {
  host.requireSession(context);
  return {
    deployments: [],
    warnings: ["Azure Monitor quota polling is not configured in Phase 0A.3 local substrate tests"]
  };
}
