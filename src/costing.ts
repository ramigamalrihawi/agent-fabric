import type { FabricDb } from "./db.js";
import { newId, stableHash } from "./ids.js";
import { asRecord, redact, safeJsonArray, safeJsonRecord } from "./runtime/input.js";

export type CostIngestResult = {
  inserted: number;
  skipped: number;
  ids: string[];
  warnings: string[];
};

export type IdleAuditOptions = {
  thresholdDays?: number;
  estimateForwardMonths?: number;
};

export type IdleAuditResult = {
  totalEstimatedMonthlyWaste: number;
  findings: Record<string, unknown>[];
  warnings: string[];
};

const STOPPED_VOLUME_RATE_USD_GB_MONTH = 0.1;

export function ingestLiteLlmSpendLogs(
  db: FabricDb,
  input: unknown,
  defaults: { agentId?: string; workspaceRoot?: string; featureTag?: string; originPeerId?: string } = {}
): CostIngestResult {
  const logs = extractRecords(input);
  const result = emptyIngestResult();
  for (const item of logs) {
    const row = asRecord(item);
    const metadata = metadataFrom(row);
    const requestId = firstString(row.request_id, row.requestId, row.id, metadata.request_id, metadata.requestId);
    const provider = firstString(row.provider, row.custom_llm_provider, row.llm_provider, metadata.provider, metadata.custom_llm_provider);
    const model = firstString(row.model, row.model_name, metadata.model, metadata.model_name);
    const costUsd = firstNumber(row.cost_usd, row.spend, row.cost, row.total_cost, row.totalCost, metadata.cost_usd);
    if (!provider || !model || costUsd === undefined) {
      result.skipped += 1;
      result.warnings.push(`skipped LiteLLM spend log missing provider/model/cost: ${requestId ?? "unknown-request"}`);
      continue;
    }
    const id = `cost_${stableHash({ source: "litellm", requestId: requestId ?? row }).slice(0, 32)}`;
    const ts = firstString(row.ts, row.startTime, row.start_time, row.created_at, row.createdAt, row.endTime) ?? new Date().toISOString();
    const promptTokens = firstNumber(row.prompt_tokens, row.promptTokens, row.input_tokens, row.inputTokens, metadata.prompt_tokens);
    const completionTokens = firstNumber(
      row.completion_tokens,
      row.completionTokens,
      row.output_tokens,
      row.outputTokens,
      metadata.completion_tokens
    );
    const cachedTokens = firstNumber(row.cached_tokens, row.cache_read_input_tokens, row.cacheReadInputTokens, metadata.cached_tokens);
    const featureTag = firstString(row.feature_tag, row.featureTag, metadata.feature_tag, metadata.featureTag, defaults.featureTag);
    const agentId = firstString(row.agent_id, row.agentId, row.user, metadata.agent_id, metadata.agentId, defaults.agentId);
    const workspaceRoot = firstString(row.workspace_root, row.workspaceRoot, metadata.workspace_root, metadata.workspaceRoot, defaults.workspaceRoot);
    const traceId = firstString(row.trace_id, row.traceId, metadata.trace_id, metadata.traceId);
    const spanId = firstString(row.span_id, row.spanId, metadata.span_id, metadata.spanId);
    const correlationId = firstString(row.correlation_id, row.correlationId, metadata.correlation_id, metadata.correlationId);

    db.db
      .prepare(
        `INSERT OR REPLACE INTO cost_events (
          id, ts, session_id, origin_peer_id, trace_id, span_id, parent_span_id,
          correlation_id, coverage_source, provider, model, agent_id, workspace_root,
          feature_tag, branch, commit_sha, prompt_tokens, completion_tokens,
          cached_tokens, cost_usd, request_id, raw_meta
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'litellm', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        ts,
        null,
        defaults.originPeerId ?? "local",
        traceId ?? null,
        spanId ?? null,
        firstString(row.parent_span_id, row.parentSpanId, metadata.parent_span_id, metadata.parentSpanId) ?? null,
        correlationId ?? null,
        provider,
        model,
        agentId ?? null,
        workspaceRoot ?? null,
        featureTag ?? null,
        firstString(row.branch, metadata.branch) ?? null,
        firstString(row.commit_sha, row.commitSha, metadata.commit_sha, metadata.commitSha) ?? null,
        promptTokens ?? null,
        completionTokens ?? null,
        cachedTokens ?? null,
        costUsd,
        requestId ?? null,
        JSON.stringify(redact(row))
      );
    result.inserted += 1;
    result.ids.push(id);
  }
  return result;
}

export function ingestAzureCostQueryResponse(
  db: FabricDb,
  input: unknown,
  options: { periodStart?: string; periodEnd?: string; source?: string } = {}
): CostIngestResult {
  const result = emptyIngestResult();
  const properties = asRecord(asRecord(input).properties ?? input);
  const columns = safeJsonArray(properties.columns).map((column) => String(asRecord(column).name ?? ""));
  const rows = safeJsonArray(properties.rows);
  if (columns.length === 0 || rows.length === 0) {
    return { ...result, warnings: ["Azure Cost Management response contained no rows"] };
  }

  for (const rawRow of rows) {
    const values = Array.isArray(rawRow) ? rawRow : [];
    const row = Object.fromEntries(columns.map((name, index) => [name, values[index]]));
    const resourceId = firstString(row.ResourceId, row.ResourceID, row.resourceId, row.Resource) ?? "unattributed";
    const meter = firstString(row.MeterSubCategory, row.meterSubCategory, row.Meter) ?? null;
    const costUsd = firstNumber(row.CostUSD, row.PreTaxCost, row.Cost, row.cost, row.cost_usd);
    if (costUsd === undefined) {
      result.skipped += 1;
      result.warnings.push(`skipped Azure cost row without cost for ${resourceId}`);
      continue;
    }
    const id = `bill_${stableHash({ source: options.source ?? "azure-cost-mgmt", resourceId, meter, row }).slice(0, 32)}`;
    db.db
      .prepare(
        `INSERT OR REPLACE INTO cost_billing (
          id, source, resource_id, meter_subcategory, cost_usd, usage_qty,
          usage_unit, period_start, period_end, raw_meta
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        options.source ?? "azure-cost-mgmt",
        resourceId,
        meter,
        costUsd,
        firstNumber(row.UsageQuantity, row.usageQuantity) ?? null,
        firstString(row.UsageUnit, row.usageUnit) ?? null,
        options.periodStart ?? null,
        options.periodEnd ?? null,
        JSON.stringify(redact(row))
      );
    result.inserted += 1;
    result.ids.push(id);
  }
  return result;
}

export function ingestRunPodInventory(db: FabricDb, input: unknown): CostIngestResult {
  const result = emptyIngestResult();
  for (const item of extractRecords(input)) {
    const pod = asRecord(item);
    const idValue = firstString(pod.id, pod.podId, pod.name);
    if (!idValue) {
      result.skipped += 1;
      result.warnings.push("skipped RunPod entry without id");
      continue;
    }
    const volumeGb = firstNumber(pod.volumeGb, pod.volumeGB, pod.volumeSizeGB, pod.volumeInGb) ?? 0;
    const desiredStatus = firstString(pod.desiredStatus, pod.status, pod.runtimeStatus) ?? "unknown";
    const monthly = isStoppedGpuStatus(desiredStatus) ? volumeGb * STOPPED_VOLUME_RATE_USD_GB_MONTH : 0;
    const id = `bill_${stableHash({ source: "runpod-graphql", idValue }).slice(0, 32)}`;
    db.db
      .prepare(
        `INSERT OR REPLACE INTO cost_billing (
          id, source, resource_id, meter_subcategory, cost_usd, usage_qty, usage_unit, raw_meta
        ) VALUES (?, 'runpod-graphql', ?, 'stopped-volume-storage', ?, ?, 'GB-month', ?)`
      )
      .run(id, `runpod:${idValue}`, monthly, volumeGb, JSON.stringify(redact(pod)));
    result.inserted += 1;
    result.ids.push(id);
  }
  return result;
}

export function ingestOpenRouterKeys(db: FabricDb, input: unknown): CostIngestResult {
  const result = emptyIngestResult();
  for (const item of extractRecords(input)) {
    const key = asRecord(item);
    const keyId = firstString(key.hash, key.id, key.name, key.label);
    if (!keyId) {
      result.skipped += 1;
      result.warnings.push("skipped OpenRouter key without id");
      continue;
    }
    const id = `bill_${stableHash({ source: "openrouter-keys", keyId }).slice(0, 32)}`;
    db.db
      .prepare(
        `INSERT OR REPLACE INTO cost_billing (
          id, source, resource_id, meter_subcategory, cost_usd, usage_qty, usage_unit, raw_meta
        ) VALUES (?, 'openrouter-keys', ?, 'virtual-key-usage', 0, ?, 'requests-30d', ?)`
      )
      .run(id, `openrouter:${keyId}`, firstNumber(key.requests30d, key.usage, key.requests) ?? 0, JSON.stringify(redact(key)));
    result.inserted += 1;
    result.ids.push(id);
  }
  return result;
}

export function idleAuditFromBillingRows(rows: Record<string, unknown>[], options: IdleAuditOptions = {}): IdleAuditResult {
  const findings: Record<string, unknown>[] = [];
  const thresholdDays = options.thresholdDays ?? 7;
  for (const row of rows) {
    const source = String(row.source ?? "");
    const raw = safeJsonRecord(row.raw_meta);
    if (source === "runpod-graphql" || source === "vultr-billing") {
      const status = firstString(raw.desiredStatus, raw.status, raw.runtimeStatus) ?? "";
      const volumeGb = firstNumber(raw.volumeGb, raw.volumeGB, raw.volumeSizeGB, raw.volumeInGb, row.usage_qty) ?? 0;
      const recordedWaste = firstNumber(row.cost_usd);
      const waste = Number(((recordedWaste && recordedWaste > 0 ? recordedWaste : volumeGb * STOPPED_VOLUME_RATE_USD_GB_MONTH)).toFixed(2));
      if (isStoppedGpuStatus(status) && volumeGb > 0 && waste > 0) {
        const resource = String(row.resource_id);
        findings.push({
          kind: "stopped-gpu-pod",
          resource,
          detail: `${resource} is stopped with ${volumeGb}GB volume still allocated`,
          estimatedMonthlyWasteUsd: waste,
          suggestedAction: {
            actionKind: "terminate",
            risk: "high",
            dryRunCommand: `node gpu-manager/bin/runpod.js inspect ${resource.replace(/^runpod:/, "")}`,
            applyCommand: `node gpu-manager/bin/runpod.js terminate ${resource.replace(/^runpod:/, "")}`
          },
          evidence: { ...raw, volumeGb, rateGbMo: STOPPED_VOLUME_RATE_USD_GB_MONTH }
        });
      }
    }
    if (source === "azure-monitor") {
      const tokensLast7d = firstNumber(raw.tokensLast7d, raw.ProcessedInferenceTokens) ?? 0;
      const waste = firstNumber(row.cost_usd) ?? 0;
      if (tokensLast7d === 0 && waste > 0) {
        findings.push({
          kind: "idle-foundry-deployment",
          resource: row.resource_id,
          detail: `0 ProcessedInferenceTokens in the last ${thresholdDays} days`,
          estimatedMonthlyWasteUsd: waste,
          suggestedAction: {
            actionKind: "delete",
            risk: "high",
            dryRunCommand: `az cognitiveservices account deployment show --ids ${row.resource_id}`,
            applyCommand: `az cognitiveservices account deployment delete --ids ${row.resource_id}`
          },
          evidence: raw
        });
      }
    }
    if (source === "openrouter-keys") {
      const requests30d = firstNumber(raw.requests30d, raw.usage, raw.requests, row.usage_qty) ?? 0;
      if (requests30d === 0) {
        findings.push({
          kind: "unused-openrouter-key",
          resource: row.resource_id,
          detail: "OpenRouter virtual key has 0 requests in 30 days",
          estimatedMonthlyWasteUsd: 0,
          suggestedAction: {
            actionKind: "delete",
            risk: "low",
            dryRunCommand: "curl -s https://openrouter.ai/api/v1/keys",
            applyCommand: "delete in OpenRouter dashboard after confirming ownership"
          },
          evidence: raw
        });
      }
    }
  }
  return {
    totalEstimatedMonthlyWaste: Number(
      findings.reduce((total, finding) => total + Number(finding.estimatedMonthlyWasteUsd ?? 0), 0).toFixed(2)
    ),
    findings,
    warnings: findings.length === 0 ? ["no idle findings in cached provider data; run provider pollers or check credentials"] : []
  };
}

function emptyIngestResult(): CostIngestResult {
  return { inserted: 0, skipped: 0, ids: [], warnings: [] };
}

function extractRecords(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  const record = asRecord(input);
  for (const key of ["records", "logs", "data", "spend_logs", "spendLogs", "pods", "keys", "items"]) {
    const value = record[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object" && Array.isArray(asRecord(value).data)) return asRecord(value).data as unknown[];
    if (value && typeof value === "object" && Array.isArray(asRecord(value).pods)) return asRecord(value).pods as unknown[];
  }
  return Object.keys(record).length ? [record] : [];
}

function metadataFrom(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...safeJsonRecord(row.metadata),
    ...safeJsonRecord(row.raw_meta),
    ...asRecord(row.metadata),
    ...asRecord(row.raw_meta),
    ...asRecord(row.request_metadata),
    ...asRecord(row.requestMetadata)
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function isStoppedGpuStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized.includes("stop") || normalized === "exited" || normalized === "idle";
}
