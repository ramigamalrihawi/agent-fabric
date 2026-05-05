import { homedir } from "node:os";
import { join } from "node:path";

export type FabricPaths = {
  home: string;
  dbPath: string;
  socketPath: string;
};

export function defaultPaths(): FabricPaths {
  const home = process.env.AGENT_FABRIC_HOME ?? join(homedir(), ".agent-fabric");
  return {
    home,
    dbPath: process.env.AGENT_FABRIC_DB ?? join(home, "db.sqlite"),
    socketPath: process.env.AGENT_FABRIC_SOCKET ?? join(home, "agent.sock")
  };
}
