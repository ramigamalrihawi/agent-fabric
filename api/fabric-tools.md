# API — Fabric MCP tools

Shared substrate tools. These are not a fourth pillar; they make the daemon's health, coverage, and cross-pillar correlation visible.

All tools return the standard result envelope used by the pillar APIs.

## `fabric_status`

Fast status for agents and humans. Should be safe to call at session start and after reconnect.

**Input:**
```ts
{
  includeSessions?: boolean; // default false — sessions and runtime only included when true or verbose
  verbose?: boolean;         // default false — implies includeSessions:true, dedupeWarnings:false
  sessionLimit?: number;     // default 50, max 500
  sessionOffset?: number;    // default 0
  dedupeWarnings?: boolean;  // default true
}
```

**Output:**
```ts
{
  daemon: {
    status: "ok" | "degraded";
    version: string;
    uptimeSeconds: number;
    dbPath: string;
    schemaVersion: number;
    originPeerId: string;
    runtime?: {
      pid: number;
      cwd: string;
      entrypoint?: string;
      node: string;
      packageRoot?: string;
    };
    tools?: {
      seniorRequired: string[];
      missingSeniorRequired: string[];
    };
  };
  bridgeSessions: {
    active: number;
    returned?: number;
    offset?: number;
    limit?: number;
    sessions: {
      sessionId: string;
      agentId: string;
      host: string;
      workspaceRoot: string;
      startedAt: string;
      lastHeartbeatAt?: string;
      notificationsVisibleToAgent: {
        declared: "yes" | "no" | "unknown";
        observed: "yes" | "no" | "unknown";
      };
      litellmRouteable: boolean;
      warnings: string[];
    }[];
  };
  coverage: {
    litellmCoveragePct: number;
    uncoveredAgents: string[];
    outcomeCoveragePct: number;
  };
  storage: {
    auditBacklog: number;
    outboxEventsLast24h: number;
    oldestUncompactedEvent?: string;
  };
  billing: {
    lastPollAt?: string;
    freshness: "live" | "1h-old" | "azure-24h-lag" | "missing";
  };
  warnings: string[];
}
```

## `fabric_doctor`

Status plus actionable diagnostics.

`fabric_doctor` always includes a shared-daemon-control diagnostic. The daemon/socket is shared local infrastructure for Codex, Claude Code, desktop, project CLI, and live queues; automated agents must not kill, restart, or remove it. Source drift and missing Senior tools should be handled by read-only inspection, operator restart/relink, or an isolated `AGENT_FABRIC_HOME`/socket for experiments.

**Input:**
```ts
{
  includeActions?: boolean;           // default true
}
```

**Output:**
```ts
{
  status: ReturnType<typeof fabric_status>;
  diagnostics: {
    id: string;
    severity: "info" | "warning" | "error";
    message: string;
    evidence: Record<string, unknown>;
    suggestedAction?: {
      actionKind: "config" | "restart" | "route" | "auth" | "inspect";
      risk: "safe" | "low" | "medium" | "high";
      dryRunCommand?: string;
      applyCommand?: string;
    };
  }[];
}
```

Examples:

- "LiteLLM coverage is 23% because Cursor is not routeable."
- "Claude Code declares notifications, but observed delivery is unknown; run notification self-test."
- "Azure billing poll has never succeeded; `AZURE_SUBSCRIPTION_ID` missing."

## `fabric_starter_kit`

Read-only happy-path tool discovery for Codex and Claude bridge callers. Returns a non-exhaustive list of essential queue tools with concise one-line guidance.

**Input:** `{}` (no parameters required)

**Output:**
```ts
{
  kit: "agent-fabric";
  essentialTools: {
    tool: string;
    description: string;
    readOnly: boolean;
    guidance: string;
  }[];
}
```

## `fabric_explain_memory`

Explain where a memory came from and what happened around it.

**Input:**
```ts
{ memoryId: string }
```

**Output:**
```ts
{
  memory: {
    id: string;
    type: string;
    status: "pending_review" | "active" | "archived" | "quarantined";
    source: "auto" | "user" | "transferred";
    namespace: string;
    createdBy?: { sessionId: string; agentId: string; host: string };
  };
  causalChain: {
    session?: BridgeSessionRef;
    task?: TaskRef;
    trace?: TraceRef;
    costRows: CostRef[];
    events: FabricEventRef[];
  };
  coverageWarnings: string[];
}
```

## `fabric_explain_session`

Summarize what a session did across all pillars.

**Input:**
```ts
{ sessionId: string }
```

**Output:**
```ts
{
  session: BridgeSessionRef;
  collab: {
    messagesSent: number;
    asksCreated: number;
    repliesSent: number;
    claimsAcquired: number;
    decisionsRecorded: number;
  };
  memory: {
    checks: number;
    hintsReturned: number;
    memoriesWritten: number;
    outcomesReported: number;
  };
  costs: {
    ledgers: CostLedgers;
    coveragePct: number;
  };
  events: FabricEventRef[];
  warnings: string[];
}
```

## `fabric_trace`

Follow one correlation ID across pillars.

**Input:**
```ts
{ correlationId: string }
```

**Output:**
```ts
{
  correlationId: string;
  sessions: BridgeSessionRef[];
  tasks: TaskRef[];
  messages: MessageRef[];
  memories: MemoryRef[];
  memoryInjections: MemoryInjectionRef[];
  costs: CostRef[];
  events: FabricEventRef[];
  coverageWarnings: string[];
}
```

## `fabric_inspect_context_package`

Inspect the sanitized context package captured for an `llm_preflight` request. The daemon stores identifiers, counts, token estimates, and caller-provided reasons; it does not store raw prompt, message, or file bodies.

**Input:**
```ts
{
  requestId: string;
  workspaceRoot?: string;
}
```

**Output:**
```ts
{
  requestId: string;
  contextPackageId: string;
  capturedAt: string;
  workspaceRoot: string;
  client: string;
  taskType: string;
  rawContentStored: false;
  summary: {
    inputTokens: number;
    fileCount: number;
    toolSchemaCount: number;
    mcpServerCount: number;
    memoryCount: number;
    sensitiveFlagCount: number;
    repeatedRegionCount: number;
    staleItemCount: number;
  };
  tokenBreakdown: Record<string, unknown>;
  files: Record<string, unknown>[];
  toolSchemas: Record<string, unknown>[];
  mcpServers: Record<string, unknown>[];
  memories: Record<string, unknown>[];
  sensitiveFlags: string[];
  repeatedRegions: Record<string, unknown>[];
  staleItems: Record<string, unknown>[];
  warnings: string[];
  analysis: {
    severity: "low" | "medium" | "high" | "blocker";
    shouldCompactBeforeModel: boolean;
    estimatedWasteTokens: number;
    estimatedWasteRatio: number;
    knownBreakdownTokens: number;
    breakdownCoverage: number;
    largestFiles: Record<string, unknown>[];
    largestToolSchemas: Record<string, unknown>[];
    largestMemories: Record<string, unknown>[];
    repeatedTokenEstimate: number;
    staleTokenEstimate: number;
    unverifiedMemoryCount: number;
    suggestedActions: {
      action: "proceed" | "remove_sensitive_context" | "compact_context" | "trim_tool_schemas" | "deduplicate_context" | "drop_stale_context" | "review_memory";
      priority: "low" | "medium" | "high" | "blocker";
      reason: string;
      expectedImpact: string;
    }[];
  };
}
```

## `fabric_route_outcomes_summary`

Human-glanceable aggregate of post-call route feedback. This is intentionally descriptive only; no automatic routing policy is changed by this tool.

**Input:**
```ts
{
  workspaceRoot?: string;
  since?: string;
  sinceDays?: number;
}
```

**Output:**
```ts
{
  workspaceRoot: string;
  since: string;
  totalOutcomes: number;
  byRoute: {
    provider: string;
    model: string;
    taskType: string;
    outcome: string;
    count: number;
    avgQualityScore: number | null;
    avgCostUsd: number | null;
    avgLatencyMs: number | null;
    totalRetries: number;
  }[];
}
```

## `fabric_session_close`

Close this Agent Fabric bridge session so status output does not accumulate stale short-lived clients. Safe to call at session end.

**Input:** `{}` (no parameters required)

**Output:**
```ts
{
  sessionId: string;
  closed: true;
}
```

## `fabric_notification_self_test_start`

Create a notification visibility challenge for this bridge session. The bridge receives a challenge string that it should display for the agent; call `fabric_notification_self_test_complete` after agent-visible delivery is confirmed.

**Input:**
```ts
{
  ttlSeconds?: number;
}
```

**Output:**
```ts
{
  testId: string;
  challenge: string;
}
```

## `fabric_notification_self_test_complete`

Complete a notification visibility challenge after agent-visible delivery is confirmed.

**Input:**
```ts
{
  testId: string;
  observed: "yes" | "no" | "unknown";
  detail?: string;
}
```

**Output:**
```ts
{
  testId: string;
  sessionId: string;
  observed: "yes" | "no" | "unknown";
  completed: true;
}
```

## Shared reference types

```ts
type BridgeSessionRef = {
  sessionId: string;
  agentId: string;
  host: string;
  workspaceRoot: string;
  startedAt: string;
};

type TraceRef = {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  correlationId?: string;
};

type TaskRef = {
  taskId: string;
  kind: string;
  status: string;
  requester: string;
  assignee: string;
};

type MessageRef = { messageId: string; sender: string; recipient: string | null; ts: string };
type MemoryRef = { memoryId: string; type: string; status: string };
type MemoryInjectionRef = { injectionId: string; silentAb: boolean; outcome?: string };
type CostRef = { id: string; provider: string; model?: string; costUsd?: number; coverageSource: string };
type FabricEventRef = { eventId: string; eventType: string; sourceTable: string; sourceId: string; ts: string };
```

## Errors

| Code | Meaning |
|---|---|
| `SESSION_NOT_FOUND` | Requested session does not exist |
| `MEMORY_NOT_FOUND` | Requested memory does not exist |
| `TRACE_NOT_FOUND` | Requested correlation or trace ID does not exist |
| `DAEMON_UNREACHABLE` | Bridge could not reach the daemon |
