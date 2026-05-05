import { createConnection } from "node:net";
import type { BridgeRegister, BridgeSession, CallContext, DaemonRequest, DaemonResponse } from "./types.js";

export class FabricClient {
  private nextRequestId = 0;

  constructor(private readonly socketPath: string) {}

  register(payload: BridgeRegister): Promise<BridgeSession> {
    return this.request<BridgeSession>({ id: this.requestId(), type: "register", payload });
  }

  call<T>(tool: string, input: unknown, context: CallContext): Promise<T> {
    return this.request<T>({ id: this.requestId(), type: "call", tool, input, context });
  }

  private requestId(): number {
    this.nextRequestId += 1;
    return this.nextRequestId;
  }

  private request<T>(request: DaemonRequest): Promise<T> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(JSON.stringify(request) + "\n");
      });
      socket.on("data", (chunk) => {
        buffer += chunk;
        const index = buffer.indexOf("\n");
        if (index === -1) {
          return;
        }
        const line = buffer.slice(0, index);
        socket.end();
        const response = JSON.parse(line) as DaemonResponse;
        if (response.ok) {
          resolve(response.result as T);
        } else {
          const error = new Error(response.error.message);
          Object.assign(error, { code: response.error.code, retryable: response.error.retryable });
          reject(error);
        }
      });
      socket.on("error", reject);
    });
  }
}
