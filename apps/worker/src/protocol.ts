import * as z from "zod/v4";

export const budget = 40;
export const machineBudget = 60;
export const reach = { x_mm: 220, y_mm: 160 };

export const camera = z.enum(["overhead", "side", "inspection"]);
const guard = z.object({
  force_n: z.number().min(0.2).max(25),
  speed_mm_s: z.number().min(5).max(120).default(35),
});
export const command = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("move_to"),
    x_mm: z.number().min(-reach.x_mm).max(reach.x_mm),
    y_mm: z.number().min(-reach.y_mm).max(reach.y_mm),
    z_mm: z.number().min(18).max(220),
    yaw_deg: z.number().min(-180).max(180),
    pitch_deg: z.number().min(-90).max(90).optional(),
    roll_deg: z.number().min(-90).max(90).optional(),
    guard: guard.optional(),
  }),
  z.object({ type: z.literal("grip"), state: z.enum(["open", "close"]) }),
]);

const id = z.uuid().describe("A fresh UUID for this action. Reuse it when retrying the same call.");
const reportCamera = camera.default("overhead");
export const toolInputs = {
  get_assignment: z.object({}),
  observe: z.object({ camera }),
  act: z.object({ id, command, camera: reportCamera }),
  finish: z.object({ id, camera: reportCamera }),
};

export const operation = z.discriminatedUnion("tool", [
  toolInputs.get_assignment.extend({ tool: z.literal("get_assignment") }),
  toolInputs.observe.extend({ tool: z.literal("observe") }),
  toolInputs.act.extend({ tool: z.literal("act") }),
  toolInputs.finish.extend({ tool: z.literal("finish") }),
]);

export type Camera = z.infer<typeof camera>;
export type Command = z.infer<typeof command>;
export type Guard = z.infer<typeof guard>;
export type Operation = z.infer<typeof operation>;

/** The reply the browser host sends back through the relay for one operation. */
export type ToolResult = { info: Record<string, unknown>; image?: string; error?: string };
export const failure = (error: string): ToolResult => ({ info: {}, error });

/** The response to `POST /api/runs`. */
export type Session = { socket: string; mcp: string; gameId: string };
