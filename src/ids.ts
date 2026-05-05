import { randomBytes, randomUUID, createHash } from "node:crypto";

export function newId(prefix = "af"): string {
  const now = Date.now().toString(36);
  const rand = randomBytes(8).toString("hex");
  return `${prefix}_${now}_${rand}`;
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sortForHash(value)))
    .digest("hex");
}

export function newTraceId(): string {
  return randomUUID().replaceAll("-", "");
}

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

function sortForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForHash);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortForHash(item)])
    );
  }
  return value;
}
