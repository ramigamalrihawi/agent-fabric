import { FabricError } from "./errors.js";

const ABSOLUTE_AGENT_CAP = 1000;
const ABSOLUTE_LIST_LIMIT = 5000;
const ABSOLUTE_EVENT_LIMIT = 500;

export function maxParallelAgentsLimit(env: NodeJS.ProcessEnv = process.env): number {
  return envInteger(env, ["AGENT_FABRIC_MAX_PARALLEL_AGENTS", "AGENT_FABRIC_QUEUE_MAX_AGENTS"], 1000, 1, ABSOLUTE_AGENT_CAP);
}

export function maxCodexAgentCount(env: NodeJS.ProcessEnv = process.env): number {
  return envInteger(env, ["AGENT_FABRIC_MAX_CODEX_AGENT_COUNT", "AGENT_FABRIC_QUEUE_MAX_AGENTS"], 1000, 1, ABSOLUTE_AGENT_CAP);
}

export function seniorMaxLaneCount(env: NodeJS.ProcessEnv = process.env): number {
  return envInteger(env, ["AGENT_FABRIC_SENIOR_MAX_LANE_COUNT", "AGENT_FABRIC_QUEUE_MAX_AGENTS"], 1000, 1, ABSOLUTE_AGENT_CAP);
}

export function seniorDefaultLaneCount(env: NodeJS.ProcessEnv = process.env): number {
  const max = seniorMaxLaneCount(env);
  return envInteger(env, ["AGENT_FABRIC_SENIOR_DEFAULT_LANE_COUNT", "AGENT_FABRIC_SENIOR_LANE_COUNT"], Math.min(10, max), 1, max);
}

export function maxQueueListLimit(env: NodeJS.ProcessEnv = process.env): number {
  return envInteger(env, ["AGENT_FABRIC_MAX_QUEUE_LIST_LIMIT"], 1000, 1, ABSOLUTE_LIST_LIMIT);
}

export function maxQueueEventLimit(env: NodeJS.ProcessEnv = process.env): number {
  return envInteger(env, ["AGENT_FABRIC_MAX_QUEUE_EVENT_LIMIT"], 100, 1, ABSOLUTE_EVENT_LIMIT);
}

export function defaultMaxEventsPerLane(env: NodeJS.ProcessEnv = process.env): number {
  return envInteger(env, ["AGENT_FABRIC_DEFAULT_MAX_EVENTS_PER_LANE"], 5, 1, maxQueueEventLimit(env));
}

function envInteger(env: NodeJS.ProcessEnv, names: string[], fallback: number, min: number, max: number): number {
  for (const name of names) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new FabricError("INVALID_CONFIGURATION", `${name} must be an integer between ${min} and ${max}`, false);
    }
    return parsed;
  }
  return fallback;
}
