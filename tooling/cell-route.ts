import { revisions } from "../apps/worker/sim/cell";
import type { RejectReason, Simulation } from "../apps/worker/sim/physics";
import type { Command } from "../apps/worker/src/protocol";

const mm = (value: number) => Math.round(value * 10000) / 10;
export const move = (x: number, y: number, z: number, yaw_deg = 0, pitch_deg = 0): Command => ({
  type: "move_to",
  x_mm: mm(x),
  y_mm: mm(y),
  z_mm: z,
  yaw_deg,
  pitch_deg,
});
const close: Command = { type: "grip", state: "close" };
const openTo = (width_mm?: number): Command => ({ type: "grip", state: "open", width_mm });
/** Fingers clear every fixture in the cell at this height, at any yaw. */
const safeZ = 150;

/** Fold a part yaw into the gripper's symmetric range, in degrees. */
function graspYaw(yaw: number) {
  let degrees = (yaw * 180) / Math.PI;
  while (degrees > 90) degrees -= 180;
  while (degrees <= -90) degrees += 180;
  return Math.round(degrees * 10) / 10;
}

/**
 * Reference route for one cycle using exact simulator state. It proves each condition is
 * solvable and gives an upper bound on moves. It is not available to the agent.
 */
export type ReferenceOptions = {
  /** Load nonconforming parts instead of rejecting them. */
  loadDefects?: boolean;
  /** Stop before closing the cover, without pressing cycle start. */
  leaveCoverOpen?: boolean;
  rejectReason?: RejectReason;
  /** Set the back stop this far off its marks, in metres. */
  stopOffset?: number;
};

export function referenceCycle(sim: Simulation, options: ReferenceOptions = {}) {
  const cell = sim.cellGeometry;
  const spec = sim.cycleSpec;
  if (!cell || !spec) throw new Error("Not a work cell run.");
  const act = (command: Command) => sim.act(command);
  const truth = () => sim.groundTruth();
  let pose = { yaw: 0, pitch: 0 };
  /** Lift, traverse and rotate at a safe height, then descend. */
  const goto = (x: number, y: number, z: number, yaw = 0, pitch = 0) => {
    const r = sim.readings();
    const same = Math.hypot(r.x_mm - mm(x), r.y_mm - mm(y)) < 1 && pose.yaw === yaw && pose.pitch === pitch;
    if (!same) {
      if (r.z_mm < safeZ - 10) act(move(r.x_mm / 1000, r.y_mm / 1000, safeZ, pose.yaw, pose.pitch));
      act(move(x, y, Math.max(z, safeZ), yaw, pitch));
    }
    pose = { yaw, pitch };
    if (Math.abs(sim.readings().z_mm - z) > 0.5) act(move(x, y, z, yaw, pitch));
  };
  if (spec.fault !== "none") sim.requestHelp("machine_fault", "Reference route.");
  const bad = !options.loadDefects && (spec.condition === "oversize" || spec.condition === "wrong_hand");

  const pick = () => {
    const { x, y, yaw } = truth().piece;
    const a = graspYaw(yaw);
    goto(x, y, safeZ, a);
    if (sim.readings().jaw_width_mm < 60) act(openTo());
    act(move(x, y, 21, a));
    act(close);
  };

  if (bad) {
    pick();
    goto(cell.bin.x, cell.bin.y, 32);
    act(openTo());
    act(move(cell.bin.x, cell.bin.y, safeZ));
    sim.finish({
      reject_reason: options.rejectReason ?? (spec.condition === "oversize" ? "oversize" : "left_hand"),
    });
    return;
  }

  const { loadX, loadY, latchX, latchY, direction, coverTravel } = cell;
  const parked = loadX + coverTravel * direction;
  if ((truth().cover ?? 0) < 0.05) {
    goto(latchX, latchY, 145, 90);
    act(close);
    act(move(latchX, latchY, 93, 90));
    act(move(latchX, latchY, safeZ, 90));
    goto(loadX, loadY, safeZ, 90);
    act(openTo());
    act(move(loadX, loadY, 118, 90));
    act(close);
    act(move(parked, loadY, 118, 90));
    act(openTo());
  }

  const target = loadY + revisions[spec.revision].stop + (options.stopOffset ?? 0);
  const face = truth().stopFace ?? target;
  if (Math.abs(face - target) > 0.0007) {
    // The knob's centre is 10 mm behind the stop face. Turned 90°, the wrist clears the latch.
    goto(loadX, face + 0.01, safeZ, 90);
    act(openTo(26));
    act(move(loadX, face + 0.01, 33, 90));
    act(close);
    act(move(loadX, target + 0.01, 33, 90));
    act(openTo(26));
  }

  const chip = truth().debris;
  if (chip && chip.z < 0.03 && Math.abs(chip.x - loadX) < 0.022) {
    // The leading finger's front face lands 2 mm behind the chip; the trailing one stays clear of the stop.
    const start = chip.y + 0.026;
    // Turned 90°, the leading finger is a solid plate across the slot.
    goto(loadX, start, 60, 90);
    act(close);
    // The fingertip runs 2 mm above the bed. Pushed any higher, the chip tips and can wedge under the finger.
    act(move(loadX, start, 17, 90));
    act(move(loadX, loadY - 0.075, 17, 90));
  }

  pick();
  const tipX = cell.cradle.x + 0.009;
  const retractX = cell.cradle.x + 0.034;
  goto(tipX, cell.cradle.y, 49, 0, 90);
  act(openTo(40));
  act(move(retractX, cell.cradle.y, 49, 0, 90));
  const staged = truth().piece;
  goto(staged.x, staged.y, 120);
  act(openTo(40));
  act(move(staged.x, staged.y, 43));
  act(close);
  const stop = truth().stopFace ?? target;
  const loadAt = stop - spec.length / 2 - 0.0003;
  goto(loadX, loadAt, 23);
  act(openTo(26));
  if (options.leaveCoverOpen) {
    act(move(loadX, loadAt, safeZ));
    return;
  }
  closeCover(sim);
  sim.finish();
}

/** Slide the parked cover shut by its handle and lift clear. */
export function closeCover(sim: Simulation) {
  const cell = sim.cellGeometry;
  if (!cell) throw new Error("Not a work cell run.");
  const act = (command: Command) => sim.act(command);
  const { loadX, loadY, direction, coverTravel } = cell;
  const parked = loadX + coverTravel * direction;
  const r = sim.readings();
  if (r.z_mm < safeZ - 10) act(move(r.x_mm / 1000, r.y_mm / 1000, safeZ, r.yaw_deg));
  act(move(parked, loadY, safeZ, 90));
  act(openTo());
  act(move(parked, loadY, 118, 90));
  act(close);
  act(move(loadX, loadY, 118, 90));
  act(openTo());
  act(move(loadX, loadY, safeZ, 90));
}
