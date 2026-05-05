import { describe, expect, it } from "vitest";
import { bridgeCallContext } from "../src/runtime/bridge-context.js";
import type { BridgeSession } from "../src/types.js";

describe("MCP bridge context", () => {
  it("derives stable idempotency and correlation keys from identical tool input", () => {
    const session = bridgeSession();
    const first = bridgeCallContext(session, { tool: "collab_send", input: { to: "*", body: "retry-safe" } });
    const retry = bridgeCallContext(session, { tool: "collab_send", input: { body: "retry-safe", to: "*" } });

    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
    expect(retry.correlationId).toBe(first.correlationId);
    expect(retry.turnId).toBe(first.turnId);
    expect(first.spanId).not.toBe(retry.spanId);
    expect(first.traceId).toMatch(/^[a-f0-9]{32}$/);
  });

  it("lets callers supply explicit control ids without polluting the content fingerprint", () => {
    const session = bridgeSession();
    const explicit = bridgeCallContext(session, {
      tool: "memory_write",
      input: {
        type: "preference",
        body: "Prefer stable idempotency.",
        intent_keys: ["idempotency"],
        idempotencyKey: "caller-key",
        traceId: "trace-explicit",
        correlationId: "corr-explicit"
      }
    });
    const withUnderscoreControls = bridgeCallContext(session, {
      tool: "memory_write",
      input: {
        type: "preference",
        body: "Prefer stable idempotency.",
        intent_keys: ["idempotency"],
        _idempotencyKey: "caller-key-2",
        _traceId: "trace-explicit-2",
        _correlationId: "corr-explicit-2"
      }
    });

    expect(explicit.idempotencyKey).toBe("caller-key");
    expect(explicit.traceId).toBe("trace-explicit");
    expect(explicit.correlationId).toBe("corr-explicit");
    expect(withUnderscoreControls.idempotencyKey).toBe("caller-key-2");
    expect(withUnderscoreControls.traceId).toBe("trace-explicit-2");
    expect(withUnderscoreControls.correlationId).toBe("corr-explicit-2");
  });
});

function bridgeSession(): BridgeSession {
  return {
    sessionId: "sess_test",
    sessionToken: "token",
    originPeerId: "peer_test",
    expiresAt: "2026-04-28T00:00:00.000Z",
    heartbeatEveryMs: 30_000,
    warnings: []
  };
}
