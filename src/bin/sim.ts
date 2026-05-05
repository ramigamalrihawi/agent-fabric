#!/usr/bin/env node
import { FabricClient } from "../client.js";
import { defaultPaths } from "../paths.js";
import type { BridgeRegister } from "../types.js";

const paths = defaultPaths();
const client = new FabricClient(paths.socketPath);
const command = process.argv[2] ?? "status";

const registerPayload: BridgeRegister = {
  bridgeVersion: "0.1.0",
  agent: { id: "simulator", displayName: "agent-fabric simulator", vendor: "local" },
  host: { name: "Simulator", transport: "simulator" },
  workspace: { root: process.cwd(), source: "cwd" },
  capabilities: {
    roots: false,
    notifications: true,
    notificationsVisibleToAgent: { declared: "yes", observed: "unknown" },
    sampling: false,
    streamableHttp: false,
    litellmRouteable: false,
    outcomeReporting: "explicit"
  },
  notificationSelfTest: {
    observed: "unknown",
    detail: "simulator starts unknown unless notification-self-test command is run"
  },
  testMode: true
};

const session = await client.register(registerPayload);

if (command === "register") {
  console.log(JSON.stringify(session, null, 2));
} else if (command === "doctor") {
  console.log(JSON.stringify(await client.call("fabric_doctor", {}, sessionContext(session)), null, 2));
} else if (command === "notification-self-test") {
  const start = await client.call<{ testId: string; challenge: string }>(
    "fabric_notification_self_test_start",
    { ttlSeconds: 30 },
    sessionContext(session)
  );
  const complete = await client.call(
    "fabric_notification_self_test_complete",
    {
      testId: start.testId,
      observed: "yes",
      detail: `simulator displayed challenge: ${start.challenge}`
    },
    sessionContext(session)
  );
  console.log(JSON.stringify({ start, complete }, null, 2));
} else {
  console.log(JSON.stringify(await client.call("fabric_status", {}, sessionContext(session)), null, 2));
}

function sessionContext(session: { sessionId: string; sessionToken: string }) {
  return {
    sessionId: session.sessionId,
    sessionToken: session.sessionToken,
    idempotencyKey: `sim-${Date.now()}`
  };
}
