import { stableHash, newSpanId, newTraceId } from "../ids.js";
import type { BridgeSession, CallContext } from "../types.js";

export type BridgeContextInput = {
  tool: string;
  input: unknown;
};

export function bridgeCallContext(session: BridgeSession, call: BridgeContextInput): CallContext {
  const provided = providedIdempotencyKey(call.input);
  const fingerprint = stableHash({ tool: call.tool, input: stripControlFields(call.input) }).slice(0, 32);
  const turnId = `turn_${fingerprint}`;
  return {
    sessionId: session.sessionId,
    sessionToken: session.sessionToken,
    turnId,
    idempotencyKey: provided ?? `bridge:${session.sessionId}:${call.tool}:${fingerprint}`,
    traceId: providedTraceId(call.input) ?? newTraceId(),
    spanId: newSpanId(),
    correlationId: providedCorrelationId(call.input) ?? `corr_${fingerprint}`
  };
}

function providedIdempotencyKey(input: unknown): string | undefined {
  const value = controlRecord(input).idempotencyKey ?? controlRecord(input)._idempotencyKey;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function providedTraceId(input: unknown): string | undefined {
  const value = controlRecord(input).traceId ?? controlRecord(input)._traceId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function providedCorrelationId(input: unknown): string | undefined {
  const value = controlRecord(input).correlationId ?? controlRecord(input)._correlationId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function controlRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function stripControlFields(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (["idempotencyKey", "_idempotencyKey", "traceId", "_traceId", "correlationId", "_correlationId"].includes(key)) continue;
    result[key] = value;
  }
  return result;
}
