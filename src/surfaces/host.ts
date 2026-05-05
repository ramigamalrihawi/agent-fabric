import type { FabricDb } from "../db.js";
import type { CallContext, FabricStatus } from "../types.js";
import type { SessionRow } from "../runtime/rows.js";
import type { CollabFanout } from "../runtime/fanout.js";

export type AuditEventInput = {
  sessionId: string | null;
  agentId: string;
  hostName: string | null;
  workspaceRoot: string;
  action: string;
  sourceTable: string;
  sourceId: string;
  eventType: string;
  payload: Record<string, unknown>;
  testMode: boolean;
  context?: CallContext;
};

export type SurfaceHost = {
  db: FabricDb;
  originPeerId: string;
  fanout: CollabFanout;
  now: () => Date;
  fabricStatus(): FabricStatus;
  requireSession(context: CallContext): SessionRow;
  recordMutation<T>(tool: string, input: unknown, context: CallContext, mutate: (session: SessionRow) => T): T;
  writeAuditAndEvent(input: AuditEventInput): void;
  exportCollabView(workspaceRoot: string): void;
};
