#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FabricDaemon } from "../daemon.js";
import { defaultPaths } from "../paths.js";

loadEnvIfPresent(join(workspaceRoot(), ".env.workspace"));
loadEnvIfPresent(join(workspaceRoot(), "gpu-manager", ".env"));
loadLiteLlmMasterKeyIfPresent(process.env.AGENT_FABRIC_LITELLM_CONFIG);

const paths = defaultPaths();
const daemon = new FabricDaemon({ dbPath: paths.dbPath });
const summaries: Record<string, unknown>[] = [];

try {
  summaries.push(await pollLiteLlm());
  summaries.push(await pollAzureCostManagement());
  summaries.push(await pollRunPod());
  summaries.push(await pollOpenRouterKeys());
  console.log(JSON.stringify({ ok: true, summaries }, null, 2));
} finally {
  daemon.close();
}

async function pollLiteLlm(): Promise<Record<string, unknown>> {
  const baseUrl = process.env.AGENT_FABRIC_LITELLM_BASE_URL ?? process.env.LITELLM_BASE_URL ?? "http://127.0.0.1:4000";
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/spend/logs`, {
      headers: process.env.LITELLM_MASTER_KEY ? { authorization: `Bearer ${process.env.LITELLM_MASTER_KEY}` } : {}
    });
    if (!response.ok) return { source: "litellm", ok: false, status: response.status };
    const result = daemon.ingestLiteLlmSpendLogs(await response.json());
    return { source: "litellm", ok: true, ...result };
  } catch (error) {
    return { source: "litellm", ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function pollAzureCostManagement(): Promise<Record<string, unknown>> {
  const subscriptionIds = azureSubscriptionIds();
  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  if (subscriptionIds.length === 0) {
    return { source: "azure-cost-mgmt", ok: false, missingCredentials: true, authMode: "none" };
  }
  try {
    const auth = await azureAccessToken({ tenantId, clientId, clientSecret });
    if (!auth.accessToken) return { source: "azure-cost-mgmt", ok: false, missingCredentials: true, authMode: auth.mode };
    const periodStart = monthStartIso(new Date());
    const periodEnd = new Date().toISOString();
    const perSubscription: Record<string, unknown>[] = [];
    let inserted = 0;
    let skipped = 0;
    const ids: string[] = [];
    const warnings: string[] = [];
    for (const subscriptionId of subscriptionIds) {
      const queryResponse = await fetch(
        `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${auth.accessToken}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            type: "ActualCost",
            timeframe: "Custom",
            timePeriod: { from: periodStart, to: periodEnd },
            dataset: {
              granularity: "None",
              aggregation: { totalCost: { name: "PreTaxCost", function: "Sum" } },
              grouping: [
                { type: "Dimension", name: "ServiceName" },
                { type: "Dimension", name: "ResourceId" },
                { type: "Dimension", name: "MeterSubCategory" }
              ],
              filter: {
                dimensions: {
                  name: "ServiceName",
                  operator: "In",
                  values: [
                    "Cognitive Services",
                    "Azure AI services",
                    "Azure OpenAI",
                    "Azure AI Foundry",
                    "Foundry Models",
                    "Foundry Tools",
                    "Machine Learning"
                  ]
                }
              }
            }
          })
        }
      );
      const redacted = redactSubscription(subscriptionId);
      if (!queryResponse.ok) {
        perSubscription.push({ subscriptionId: redacted, ok: false, status: queryResponse.status, error: await safeResponseMessage(queryResponse) });
        continue;
      }
      const result = daemon.ingestAzureCostQuery(await queryResponse.json(), { periodStart, periodEnd });
      inserted += result.inserted;
      skipped += result.skipped;
      ids.push(...result.ids);
      warnings.push(...result.warnings.map((warning) => `${redacted}: ${warning}`));
      perSubscription.push({ subscriptionId: redacted, ok: true, inserted: result.inserted, skipped: result.skipped });
    }
    return {
      source: "azure-cost-mgmt",
      ok: perSubscription.some((item) => (item as { ok?: boolean }).ok),
      authMode: auth.mode,
      attemptedSubscriptions: subscriptionIds.length,
      inserted,
      skipped,
      ids,
      warnings,
      subscriptions: perSubscription
    };
  } catch (error) {
    return { source: "azure-cost-mgmt", ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function pollRunPod(): Promise<Record<string, unknown>> {
  const apiKey = process.env.RUNPOD_API_KEY;
  if (!apiKey) return { source: "runpod-graphql", ok: false, missingCredentials: true };
  try {
    const response = await fetch("https://api.runpod.io/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        query: `query AgentFabricPods { myself { pods { id name desiredStatus runtime { uptimeInSeconds } volumeInGb } } }`
      })
    });
    if (!response.ok) return { source: "runpod-graphql", ok: false, status: response.status };
    const body = await response.json();
    const pods = ((body as { data?: { myself?: { pods?: unknown[] } } }).data?.myself?.pods ?? []).map((pod) => {
      const record = pod as Record<string, unknown>;
      return { ...record, volumeSizeGB: record.volumeInGb };
    });
    const result = daemon.ingestRunPodInventory({ pods });
    return { source: "runpod-graphql", ok: true, ...result };
  } catch (error) {
    return { source: "runpod-graphql", ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function pollOpenRouterKeys(): Promise<Record<string, unknown>> {
  const candidates = discoverOpenRouterKeys();
  if (candidates.length === 0) return { source: "openrouter-keys", ok: false, missingCredentials: true };
  const attempts: Record<string, unknown>[] = [];
  const validSnapshots: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    const response = await fetch("https://openrouter.ai/api/v1/keys", {
      headers: { authorization: `Bearer ${candidate.key}` }
    });
    if (response.ok) {
      const result = daemon.ingestOpenRouterKeys(await response.json());
      return { source: "openrouter-keys", ok: true, mode: "management-key", key: candidate.label, attemptedKeys: attempts.length + 1, ...result };
    }
    attempts.push({ key: candidate.label, endpoint: "/keys", status: response.status });

    const authResponse = await fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: { authorization: `Bearer ${candidate.key}` }
    });
    if (authResponse.ok) {
      const body = (await authResponse.json()) as Record<string, unknown>;
      validSnapshots.push({ ...body, id: candidate.fingerprint, label: candidate.label, discoveredFrom: candidate.source });
      attempts.push({ key: candidate.label, endpoint: "/auth/key", status: authResponse.status, valid: true });
      continue;
    }
    attempts.push({ key: candidate.label, endpoint: "/auth/key", status: authResponse.status });
  }
  if (validSnapshots.length > 0) {
    const result = daemon.ingestOpenRouterKeys({ keys: validSnapshots });
    return {
      source: "openrouter-keys",
      ok: true,
      mode: "single-key-auth",
      discoveredKeys: candidates.length,
      validKeys: validSnapshots.length,
      attemptedKeys: candidates.length,
      ...result
    };
  }
  return { source: "openrouter-keys", ok: false, attemptedKeys: candidates.length, attempts };
}

function loadEnvIfPresent(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^"|"$/g, "");
  }
}

function loadLiteLlmMasterKeyIfPresent(path: string | undefined): void {
  if (!path || process.env.LITELLM_MASTER_KEY || !existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*master_key:\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    process.env.LITELLM_MASTER_KEY = match[1].replace(/^["']|["']$/g, "");
    return;
  }
}

function workspaceRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..");
}

async function azureAccessToken(input: {
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
}): Promise<{ accessToken?: string; mode: "service-principal" | "az-cli" | "none" }> {
  if (input.tenantId && input.clientId && input.clientSecret) {
    const tokenResponse = await fetch(`https://login.microsoftonline.com/${input.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        scope: "https://management.azure.com/.default",
        grant_type: "client_credentials"
      })
    });
    if (!tokenResponse.ok) return { mode: "service-principal" };
    const token = (await tokenResponse.json()) as { access_token?: string };
    return { accessToken: token.access_token, mode: "service-principal" };
  }
  const token = azTsv(["account", "get-access-token", "--resource", "https://management.azure.com/", "--query", "accessToken", "-o", "tsv"]);
  return token ? { accessToken: token, mode: "az-cli" } : { mode: "none" };
}

function azTsv(args: string[]): string | undefined {
  try {
    return execFileSync("az", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function azureSubscriptionIds(): string[] {
  if (process.env.AZURE_SUBSCRIPTION_ID) return [process.env.AZURE_SUBSCRIPTION_ID];
  const listed = azTsv(["account", "list", "--query", "[?state=='Enabled'].id", "-o", "tsv"]);
  if (listed) return listed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const current = azTsv(["account", "show", "--query", "id", "-o", "tsv"]);
  return current ? [current] : [];
}

function discoverOpenRouterKeys(): Array<{ key: string; label: string; fingerprint: string; source: string }> {
  const candidates = new Map<string, { key: string; source: string }>();
  for (const [name, value] of Object.entries(process.env)) {
    if (name.includes("OPENROUTER") && typeof value === "string") {
      addOpenRouterKeys(candidates, value, `env:${name}`);
    }
  }
  const roots = uniquePaths([workspaceRoot(), resolve(workspaceRoot(), "..")]);
  for (const root of roots) {
    scanForOpenRouterKeys(candidates, root, 0);
  }
  return [...candidates.values()].map((candidate) => {
    const fingerprint = keyFingerprint(candidate.key);
    return {
      key: candidate.key,
      label: `openrouter:${fingerprint}`,
      fingerprint,
      source: candidate.source
    };
  });
}

function scanForOpenRouterKeys(candidates: Map<string, { key: string; source: string }>, dir: string, depth: number): void {
  if (depth > 5 || !existsSync(dir)) return;
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = entry.name;
    if ([".git", "node_modules", "dist", "coverage", "recordings", "artifacts", ".next"].includes(name)) continue;
    const path = join(dir, name);
    if (entry.isDirectory()) {
      scanForOpenRouterKeys(candidates, path, depth + 1);
      continue;
    }
    if (!shouldScanSecretFile(name)) continue;
    try {
      const stat = statSync(path);
      if (stat.size > 1024 * 1024) continue;
      addOpenRouterKeys(candidates, readFileSync(path, "utf8"), path);
    } catch {
      // Ignore unreadable files during opportunistic key discovery.
    }
  }
}

function shouldScanSecretFile(name: string): boolean {
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name.endsWith(".env") ||
    name.endsWith(".yaml") ||
    name.endsWith(".yml") ||
    name.endsWith(".json") ||
    name.endsWith(".md")
  );
}

function addOpenRouterKeys(candidates: Map<string, { key: string; source: string }>, text: string, source: string): void {
  for (const match of text.matchAll(/sk-or-v1-[A-Za-z0-9_-]+/g)) {
    if (!candidates.has(match[0])) candidates.set(match[0], { key: match[0], source });
  }
}

function keyFingerprint(key: string): string {
  return `${key.slice(0, 10)}...${key.slice(-6)}`;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

function redactSubscription(subscriptionId: string): string {
  return `${subscriptionId.slice(0, 8)}...${subscriptionId.slice(-4)}`;
}

async function safeResponseMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.slice(0, 500).replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [REDACTED]");
}

function monthStartIso(date: Date): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0)).toISOString();
}
