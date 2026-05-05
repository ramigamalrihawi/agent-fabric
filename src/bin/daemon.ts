#!/usr/bin/env node
import { startFabricServer } from "../server.js";
import { defaultPaths } from "../paths.js";

const paths = defaultPaths();
const httpPort = process.env.AGENT_FABRIC_HTTP_PORT === "off" ? false : Number(process.env.AGENT_FABRIC_HTTP_PORT ?? 4521);
const runtime = await startFabricServer({
  socketPath: paths.socketPath,
  dbPath: paths.dbPath,
  httpPort,
  costIngestToken: process.env.AGENT_FABRIC_COST_INGEST_TOKEN
});

console.error(`agent-fabric daemon listening on ${paths.socketPath}`);
console.error(`agent-fabric db at ${paths.dbPath}`);
if (runtime.httpPort) {
  console.error(`agent-fabric cost ingest HTTP listening on 127.0.0.1:${runtime.httpPort}`);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void runtime.close().finally(() => process.exit(0));
  });
}
