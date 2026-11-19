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
  z.object({
    type: z.literal("grip"),
    state: z.enum(["open", "close"]),
    width_mm: z
      .number()
      .min(14)
      .max(84)
      .optional()
      .describe("Opening width for state open. Defaults to fully open (84 mm)."),
  }),
]);

const id = z.uuid().describe("A fresh UUID for this action. Reuse it when retrying the same call.");
const reportCamera = camera.default("overhead");
export const helpCategory = z.enum(["machine_fault", "debris", "part_quality", "other"]);
export const toolInputs = {
  get_assignment: z.object({}),
  get_work_instruction: z.object({}),
  observe: z.object({ camera }),
  act: z.object({ id, command, camera: reportCamera }),
  finish: z.object({
    id,
    camera: reportCamera,
    reject_reason: z
      .enum(["oversize", "left_hand", "other"])
      .optional()
      .describe("Work cell: why the part went to the reject bin."),
  }),
  request_help: z.object({
    id,
    category: helpCategory.describe("What you believe is wrong."),
    observation: z.string().max(600).describe("What you saw or measured."),
  }),
  run_routine: z.object({
    id,
    code: z
      .string()
      .min(1)
      .max(20_000)
      .describe("JavaScript defining async function run(robot, cycle). See get_assignment for the API."),
    cycles: z
      .number()
      .int()
      .min(1)
      .max(12)
      .describe("How many cycles to run, starting with the current one."),
  }),
  routine_status: z.object({
    wait_s: z
      .number()
      .min(0)
      .max(6)
      .default(5)
      .describe("Wait up to this long for the routine to change state."),
    answer: z.string().max(600).optional().describe("Answer to a question the routine asked with robot.ask."),
    question_id: z.number().int().optional().describe("The question_id of the question you are answering."),
    stop: z.boolean().optional().describe("Stop the routine. Control returns to you mid-cycle."),
  }),
};

export const operation = z.discriminatedUnion("tool", [
  toolInputs.get_assignment.extend({ tool: z.literal("get_assignment") }),
  toolInputs.get_work_instruction.extend({ tool: z.literal("get_work_instruction") }),
  toolInputs.observe.extend({ tool: z.literal("observe") }),
  toolInputs.act.extend({ tool: z.literal("act") }),
  toolInputs.finish.extend({ tool: z.literal("finish") }),
  toolInputs.request_help.extend({ tool: z.literal("request_help") }),
  toolInputs.run_routine.extend({ tool: z.literal("run_routine") }),
  toolInputs.routine_status.extend({ tool: z.literal("routine_status") }),
]);

export type Camera = z.infer<typeof camera>;
export type Command = z.infer<typeof command>;
export type Guard = z.infer<typeof guard>;
export type HelpCategoryName = z.infer<typeof helpCategory>;
export type Operation = z.infer<typeof operation>;

/** The reply the browser host sends back through the relay for one operation. */
export type ToolResult = { info: Record<string, unknown>; image?: string; error?: string };
export const failure = (error: string): ToolResult => ({ info: {}, error });

/** The response to `POST /api/runs`. */
export type Session = { socket: string; mcp: string; gameId: string };
