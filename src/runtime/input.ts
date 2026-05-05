// Input parsing, JSON helpers, redaction, intent-key normalization.
// These shape raw caller input and stored JSON columns into typed values
// before the surface modules touch them.

import { FabricError } from "./errors.js";

export function getField(input: unknown, field: string): unknown {
  if (!input || typeof input !== "object") return undefined;
  return (input as Record<string, unknown>)[field];
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function getString(input: unknown, field: string): string {
  if (!input || typeof input !== "object" || typeof (input as Record<string, unknown>)[field] !== "string") {
    throw new FabricError("INVALID_INPUT", `Expected string field: ${field}`, false);
  }
  return (input as Record<string, string>)[field];
}

export function getOptionalString(input: unknown, field: string): string | undefined {
  const value = getField(input, field);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new FabricError("INVALID_INPUT", `Expected optional string field: ${field}`, false);
  }
  return value;
}

export function getOptionalNumber(input: unknown, field: string): number | undefined {
  const value = getField(input, field);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FabricError("INVALID_INPUT", `Expected optional number field: ${field}`, false);
  }
  return value;
}

export function getOptionalBoolean(input: unknown, field: string): boolean | undefined {
  const value = getField(input, field);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new FabricError("INVALID_INPUT", `Expected optional boolean field: ${field}`, false);
  }
  return value;
}

export function getStringArray(input: unknown, field: string): string[] {
  const value = getField(input, field);
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new FabricError("INVALID_INPUT", `Expected string array field: ${field}`, false);
  }
  return value;
}

export function getRequiredStringArray(input: unknown, field: string): string[] {
  const value = getStringArray(input, field);
  if (value.length === 0) {
    throw new FabricError("INVALID_INPUT", `Expected non-empty string array field: ${field}`, false);
  }
  return value;
}

export function getArray(input: unknown, field: string): unknown[] {
  const value = getField(input, field);
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new FabricError("INVALID_INPUT", `Expected array field: ${field}`, false);
  }
  return value;
}

export function safeJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function safeJsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "string") return {};
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

export function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

export function redact(payload: Record<string, unknown>): Record<string, unknown> {
  return redactRecord(payload, new WeakSet<object>());
}

function redactRecord(payload: Record<string, unknown>, seen: WeakSet<object>): Record<string, unknown> {
  if (seen.has(payload)) return { circular: "[REDACTED]" };
  seen.add(payload);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (/token|secret|api[_-]?key|password/i.test(key)) {
      result[key] = "[REDACTED]";
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) => redactValue(item, seen));
    } else if (value && typeof value === "object") {
      result[key] = redactRecord(value as Record<string, unknown>, seen);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));
  if (value && typeof value === "object") return redactRecord(value as Record<string, unknown>, seen);
  return value;
}

export function intentKeysFromIntent(intent: Record<string, unknown>): string[] {
  const keys = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      for (const key of expandIntentString(value)) {
        keys.add(key);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const nested of Object.values(value)) visit(nested);
    }
  };
  visit(intent);
  return [...keys];
}

export function expandIntentString(value: string): string[] {
  const normalized = normalizeIntentKey(value);
  if (!normalized) return [];
  const tokens = normalized.split(/[^a-z0-9._/-]+/).filter((token) => token.length > 1);
  return [normalized, ...tokens];
}

export function normalizeIntentKey(value: string): string {
  return value.trim().toLowerCase();
}
