import { DurableObject } from "cloudflare:workers";
import { failure, type Operation, type ToolResult } from "./protocol";

type Secrets = { host: string; agent: string };
const disconnected = "Host disconnected. Retry with the same id.";
type Pending = {
  socket: WebSocket;
  receive: (result: ToolResult) => void;
};

export class RunRelay extends DurableObject<Env> {
  private readonly pending = new Map<string, Pending>();

  create(gameId: string): Promise<Secrets | null> {
    return this.ctx.storage.transaction(async (tx) => {
      if (await tx.get("secrets")) return null;
      const secrets = { host: crypto.randomUUID(), agent: gameId };
      await tx.put("secrets", secrets);
      return secrets;
    });
  }

  async authorize(agent: string) {
    const secrets = await this.ctx.storage.get<Secrets>("secrets");
    return secrets?.agent === agent;
  }

  async fetch(request: Request): Promise<Response> {
    const secrets = await this.ctx.storage.get<Secrets>("secrets");
    if (!secrets || new URL(request.url).searchParams.get("host") !== secrets.host) {
      return new Response("Unknown run", { status: 404 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }
    const pair = new WebSocketPair();
    for (const old of this.ctx.getWebSockets()) old.close(4001, "Host reconnected");
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async relay(operation: Operation): Promise<ToolResult> {
    const socket = this.ctx.getWebSockets().find((candidate) => candidate.readyState === WebSocket.OPEN);
    if (!socket)
      return failure(
        "The host is disconnected. If the original tab was closed or reset, start a new session.",
      );
    if (this.pending.size) return failure("A tool call is in progress. Retry with the same id.");

    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => receive(failure("Host timed out. Retry with the same id.")), 8_000);
      const receive = (result: ToolResult) => {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        resolve(result);
      };
      this.pending.set(requestId, { receive, socket });
      try {
        socket.send(JSON.stringify({ requestId, operation }));
      } catch {
        receive(failure(disconnected));
      }
    });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string" || message.length > 600_000) return;
    try {
      const { requestId, result } = JSON.parse(message);
      const pending = this.pending.get(requestId);
      if (pending?.socket === socket && result && typeof result.info === "object") {
        pending.receive(result);
      }
    } catch {
      // Unrecognized messages cannot complete a request.
    }
  }

  webSocketClose(socket: WebSocket) {
    for (const pending of this.pending.values()) {
      if (pending.socket === socket) pending.receive(failure(disconnected));
    }
  }

  webSocketError(socket: WebSocket) {
    this.webSocketClose(socket);
  }
}
