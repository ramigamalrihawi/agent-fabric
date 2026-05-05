export type YesNoUnknown = "yes" | "no" | "unknown";

export type NotificationVisibility = {
  declared: YesNoUnknown;
  observed: YesNoUnknown;
};

export type BridgeRegister = {
  bridgeVersion: string;
  agent: {
    id: string;
    displayName: string;
    vendor?: string;
  };
  host: {
    name: string;
    version?: string;
    transport: "mcp-stdio" | "mcp-streamable-http" | "uds" | "ws-compat" | "simulator";
  };
  workspace: {
    root: string;
    source: "mcp_roots" | "ide_workspace" | "nearest_git" | "explicit" | "cwd";
  };
  capabilities: {
    roots: boolean;
    notifications: boolean;
    notificationsVisibleToAgent: NotificationVisibility;
    sampling: boolean;
    streamableHttp: boolean;
    litellmRouteable: boolean;
    outcomeReporting: "tool_return_code" | "explicit" | "none";
  };
  notificationSelfTest?: {
    observed: YesNoUnknown;
    detail?: string;
    checkedAt?: string;
  };
  testMode?: boolean;
};

export type BridgeSession = {
  sessionId: string;
  sessionToken: string;
  originPeerId: string;
  expiresAt: string;
  heartbeatEveryMs: number;
  warnings: string[];
};

export type CallContext = {
  sessionId: string;
  sessionToken?: string;
  turnId?: string;
  idempotencyKey?: string;
  workspaceRoot?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  correlationId?: string;
  featureTag?: string;
  branch?: string;
  commitSha?: string;
};

export type ResultEnvelope<T> =
  | { ok: true; tool: string; data: T; warnings?: string[] }
  | { ok: false; tool: string; code: string; message: string; retryable: boolean };

export type FabricStatus = {
  daemon: {
    status: "ok" | "degraded";
    version: string;
    uptimeSeconds: number;
    dbPath: string;
    schemaVersion: number;
    originPeerId: string;
  };
  bridgeSessions: {
    active: number;
    sessions: FabricSessionSummary[];
  };
  coverage: {
    litellmCoveragePct: number;
    byAgent: Record<string, number>;
    observedRouteableAgents: string[];
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
};

export type FabricSessionSummary = {
  sessionId: string;
  agentId: string;
  host: string;
  workspaceRoot: string;
  startedAt: string;
  lastHeartbeatAt?: string;
  notificationsVisibleToAgent: NotificationVisibility;
  litellmRouteable: boolean;
  warnings: string[];
};

export type FabricDoctor = {
  status: FabricStatus;
  diagnostics: FabricDiagnostic[];
};

export type FabricDiagnostic = {
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
};

export type DaemonRequest =
  | { id: string | number; type: "register"; payload: BridgeRegister }
  | { id: string | number; type: "call"; tool: string; input: unknown; context: CallContext };

export type DaemonResponse =
  | { id: string | number; ok: true; result: unknown }
  | { id: string | number; ok: false; error: { code: string; message: string; retryable: boolean } };
