import { newId } from "../ids.js";

export type CollabFanoutPayload = {
  workspaceRoot: string;
  message: Record<string, unknown>;
};

export type CollabFanoutEnvelope = {
  type: "collab.message";
  messageId: string;
  recipient: string;
  workspaceRoot: string;
  message: Record<string, unknown>;
};

export type CollabFanoutResult = {
  acked: number;
  attempted: number;
};

export type CollabFanout = {
  publish(messageId: string, recipient: string, payload: CollabFanoutPayload): CollabFanoutResult;
  closeAll?(): void;
};

export type FanoutSubscription = {
  connectionId?: string;
  sessionId: string;
  agentId: string;
  workspaceRoot: string;
  notificationsDeclared: "yes" | "no" | "unknown";
  send: (envelope: CollabFanoutEnvelope) => boolean | void;
  close?: () => void;
};

type FanoutEntry = Required<Pick<FanoutSubscription, "connectionId">> &
  Omit<FanoutSubscription, "connectionId"> & {
    lastSeenMs: number;
  };

export const noopFanout: CollabFanout = {
  publish: () => ({ acked: 0, attempted: 0 })
};

export class InMemoryFanoutRegistry implements CollabFanout {
  private readonly entries = new Map<string, FanoutEntry>();
  private readonly sessionIndex = new Map<string, Set<string>>();
  private readonly staleMs: number;
  private readonly now: () => number;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(options: { staleMs?: number; now?: () => number } = {}) {
    this.staleMs = options.staleMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  subscribe(subscription: FanoutSubscription): () => void {
    const connectionId = subscription.connectionId ?? newId("fanout");
    this.remove(connectionId, false);
    const entry: FanoutEntry = {
      ...subscription,
      connectionId,
      lastSeenMs: this.now()
    };
    this.entries.set(connectionId, entry);
    const sessionConnections = this.sessionIndex.get(entry.sessionId) ?? new Set<string>();
    sessionConnections.add(connectionId);
    this.sessionIndex.set(entry.sessionId, sessionConnections);
    return () => this.remove(connectionId, false);
  }

  heartbeat(sessionId: string, connectionId?: string): boolean {
    const ids = connectionId ? new Set([connectionId]) : this.sessionIndex.get(sessionId);
    if (!ids) return false;
    let touched = false;
    const now = this.now();
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry?.sessionId !== sessionId) continue;
      entry.lastSeenMs = now;
      touched = true;
    }
    return touched;
  }

  publish(messageId: string, recipient: string, payload: CollabFanoutPayload): CollabFanoutResult {
    this.sweep();
    const envelope: CollabFanoutEnvelope = {
      type: "collab.message",
      messageId,
      recipient,
      workspaceRoot: payload.workspaceRoot,
      message: payload.message
    };
    let attempted = 0;
    let acked = 0;
    for (const entry of [...this.entries.values()]) {
      if (!this.matches(entry, recipient, payload.workspaceRoot)) continue;
      attempted += 1;
      try {
        const accepted = entry.send(envelope);
        if (accepted !== false) {
          entry.lastSeenMs = this.now();
          acked += 1;
        }
      } catch {
        this.remove(entry.connectionId);
      }
    }
    return { acked, attempted };
  }

  sweep(now = this.now()): number {
    let evicted = 0;
    for (const entry of [...this.entries.values()]) {
      if (now - entry.lastSeenMs <= this.staleMs) continue;
      this.remove(entry.connectionId);
      evicted += 1;
    }
    return evicted;
  }

  startSweep(intervalMs = 15_000): () => void {
    this.stopSweep();
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref?.();
    return () => this.stopSweep();
  }

  stopSweep(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  closeAll(): void {
    for (const entry of [...this.entries.values()]) {
      this.remove(entry.connectionId);
    }
    this.stopSweep();
  }

  size(): number {
    return this.entries.size;
  }

  private matches(entry: FanoutEntry, recipient: string, workspaceRoot: string): boolean {
    if (entry.notificationsDeclared !== "yes") return false;
    if (entry.workspaceRoot !== workspaceRoot) return false;
    return recipient === "*" || entry.agentId === recipient;
  }

  private remove(connectionId: string, close = true): void {
    const entry = this.entries.get(connectionId);
    if (!entry) return;
    this.entries.delete(connectionId);
    const sessionConnections = this.sessionIndex.get(entry.sessionId);
    sessionConnections?.delete(connectionId);
    if (sessionConnections?.size === 0) {
      this.sessionIndex.delete(entry.sessionId);
    }
    if (close) {
      try {
        entry.close?.();
      } catch {
        // Best-effort cleanup: registry state is already released.
      }
    }
  }
}
