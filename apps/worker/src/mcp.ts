import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { gameIdPattern } from "./games";
import { type Operation, toolInputs } from "./protocol";
import type { RunRelay } from "./relay";

export function serveMcp(
  request: Request,
  resolveRun: (gameId?: string) => Promise<DurableObjectStub<RunRelay> | undefined>,
) {
  const handler = createMcpHandler(() => {
    const server = new McpServer(
      { name: "robo-playground", version: "0.1.0" },
      {
        instructions:
          "Ask for the Game ID shown on the live run page, then call get_assignment with that game_id. Include the same game_id on every tool call for that run. Keep the host tab open.",
      },
    );
    const toolError = (message: string) => ({
      isError: true,
      content: [{ type: "text" as const, text: message }],
    });
    const call = async (gameId: unknown, operation: Operation) => {
      const run = await resolveRun(typeof gameId === "string" ? gameId : undefined);
      if (!run) return toolError("Game ID not found. Check the code shown on the live run page.");
      const { info, image, error } = await run.relay(operation);
      if (error) return toolError(error);
      const text = { type: "text" as const, text: JSON.stringify(info) };
      return {
        content: image ? [text, { type: "image" as const, mimeType: "image/jpeg", data: image }] : [text],
      };
    };
    const gameId = z
      .string()
      .trim()
      .toUpperCase()
      .regex(gameIdPattern)
      .describe("The twelve-character Game ID from the live run page.");
    const game = { game_id: gameId };
    server.registerTool(
      "get_assignment",
      {
        description: "Get the goal, controls, budget and overhead image.",
        inputSchema: toolInputs.get_assignment.extend(game),
      },
      ({ game_id }) => call(game_id, { tool: "get_assignment" }),
    );
    server.registerTool(
      "observe",
      {
        description:
          "Read sensors and view a camera without advancing physics. Machine loading also has a close-up inspection view of the slot.",
        inputSchema: toolInputs.observe.extend(game),
      },
      ({ game_id, ...args }) => call(game_id, { tool: "observe", ...args }),
    );
    server.registerTool(
      "act",
      {
        description: "Move the wrist to an absolute target or open/close the jaws. Consumes one move.",
        inputSchema: toolInputs.act.extend(game),
      },
      ({ game_id, ...args }) => call(game_id, { tool: "act", ...args }),
    );
    server.registerTool(
      "finish",
      {
        description: "Declare the attempt complete. The simulator scores the result.",
        inputSchema: toolInputs.finish.extend(game),
      },
      ({ game_id, ...args }) => call(game_id, { tool: "finish", ...args }),
    );
    return server;
  });
  return handler.fetch(request);
}
