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
        description:
          "Declare the attempt complete. The simulator scores the result. In a work cell shift this presses cycle start and ends the current cycle; the machine may refuse to start, and then the cycle continues.",
        inputSchema: toolInputs.finish.extend(game),
      },
      ({ game_id, ...args }) => call(game_id, { tool: "finish", ...args }),
    );
    server.registerTool(
      "get_work_instruction",
      {
        description: "Work cell shift: the current work instruction text and its part drawing.",
        inputSchema: toolInputs.get_work_instruction.extend(game),
      },
      ({ game_id }) => call(game_id, { tool: "get_work_instruction" }),
    );
    server.registerTool(
      "request_help",
      {
        description:
          "Work cell shift: call a technician for the current cycle. Each visit costs 90 seconds of shift time. The technician fixes the problem only if your category matches what is wrong.",
        inputSchema: toolInputs.request_help.extend(game),
      },
      ({ game_id, ...args }) => call(game_id, { tool: "request_help", ...args }),
    );
    server.registerTool(
      "run_routine",
      {
        description:
          "Work cell shift: start a routine you wrote that runs whole cycles without you. It starts at the beginning of a cycle and returns immediately; poll routine_status.",
        inputSchema: toolInputs.run_routine.extend(game),
      },
      ({ game_id, ...args }) => call(game_id, { tool: "run_routine", ...args }),
    );
    server.registerTool(
      "routine_status",
      {
        description:
          "Work cell shift: wait for the running routine to change state, answer its question (pass its question_id), or stop it.",
        inputSchema: toolInputs.routine_status.extend(game),
      },
      ({ game_id, ...args }) => call(game_id, { tool: "routine_status", ...args }),
    );
    return server;
  });
  return handler.fetch(request);
}
