import { expect, test } from "bun:test";
import { machineRoute, move } from "../../../tooling/machine-route";
import {
  type Layout,
  defaultLayout as layout,
  layoutGeometry,
  loadPhysics,
  Simulation,
} from "../sim/physics";

const mj = await loadPhysics();

test("a guarded press stops and backs off at the specified change in force", () => {
  const machine: Layout = { ...layout, task: "machine" };
  const sim = new Simulation(mj, machine);
  try {
    const [hover, close, press] = machineRoute(machine);
    if (press.type !== "move_to") throw new Error("Expected a press move");
    sim.act(hover);
    sim.act(close);
    expect(Math.abs(sim.readings().wrist_force_n.z)).toBeLessThan(0.05);

    sim.act({ ...press, z_mm: 88, guard: { force_n: 2, speed_mm_s: 25 } });
    const r = sim.readings();
    expect(r.controller.stop_reason).toBe("force_limit");
    expect(r.controller.guard?.peak_n).toBeGreaterThanOrEqual(2);
    expect(r.wrist_force_n.z).toBeGreaterThan(0.1);
    expect(Math.abs(r.wrist_torque_nm.x) + Math.abs(r.wrist_torque_nm.y)).toBeGreaterThan(0);
    expect(r.z_mm).toBeGreaterThan(press.z_mm);
  } finally {
    sim.dispose();
  }
});

test("grip effort, object detection, and arm stop reason reflect a held peg pressed into the table", () => {
  const sim = new Simulation(mj, layout);
  try {
    const { x, y, yaw } = layoutGeometry(layout);
    const moveTo = (z_mm: number) => sim.act(move(x, y, z_mm, yaw));
    moveTo(120);
    moveTo(44);
    sim.act({ type: "grip", state: "close" });
    moveTo(120);
    const lifted = sim.readings();
    expect(lifted.gripper.effort_n).toBeGreaterThan(1);
    expect(lifted.gripper.object_detected).toBe(true);
    expect(lifted.wrist_force_n.z).toBeLessThan(0);
    expect(lifted.controller.joints).toHaveLength(6);

    moveTo(18);
    const stalled = sim.readings();
    expect(stalled.stopped_short).toBe(true);
    expect(stalled.controller.stop_reason).toBe("position_error");
  } finally {
    sim.dispose();
  }
});

test("calibration error is repeatable and creates a physical offset from the reported tool position", () => {
  const target = { type: "move_to", x_mm: 90, y_mm: -90, z_mm: 175, yaw_deg: 0 } as const;
  const pose = (calibration: boolean, seed: number) => {
    const sim = new Simulation(mj, { ...layout, seed, calibration });
    try {
      sim.act(target);
      expect(sim.readings()).toMatchObject({ x_mm: 90, y_mm: -90, z_mm: 175 });
      const tool = sim.data.body("tool");
      try {
        return Array.from(tool.xpos as Float64Array);
      } finally {
        tool.delete();
      }
    } finally {
      sim.dispose();
    }
  };
  const calibrated = pose(false, 1);
  const biased = pose(true, 1);
  expect(Math.hypot(...biased.map((value, i) => value - calibrated[i]))).toBeGreaterThan(0.0002);
  expect(pose(true, 1)).toEqual(biased);
  expect(pose(true, 2)).not.toEqual(biased);
});
