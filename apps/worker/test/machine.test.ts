import { expect, test } from "bun:test";
import { coverMoves, machineRoute } from "../../../tooling/machine-route";
import { defaultLayout, type Layout, loadPhysics, Simulation } from "../sim/physics";

const mj = await loadPhysics();
const first: Layout = { ...defaultLayout, task: "machine" };

test.each([first, { ...first, seed: 2, angle: 60 }])(
  "staging, loading, and relatching works on seed $seed",
  (layout) => {
    const sim = new Simulation(mj, layout);
    try {
      const route = machineRoute(layout);
      // Stop with the loaded part released and the cover still open.
      for (const action of route.slice(0, -6)) sim.act(action);
      expect(sim.success).toBe(false);

      for (const action of route.slice(-6)) sim.act(action);
      sim.finish();
      expect(sim.readings()).toMatchObject({ success: true, ended: true, declared: true });
      expect(sim.moves).toBeLessThan(sim.moveBudget);
    } finally {
      sim.dispose();
    }
  },
);

test("the cover cannot slide open while the latch is engaged", () => {
  const sim = new Simulation(mj, first);
  const cover = sim.data.jnt("cover_slide");
  try {
    for (const action of coverMoves(first, true)) sim.act(action);
    expect(cover.qpos[0]).toBeLessThan(0.006);
  } finally {
    cover.delete();
    sim.dispose();
  }
});

test("pressing the latch again after loading fails only the final latch and settling checks", () => {
  const sim = new Simulation(mj, first);
  try {
    const route = machineRoute(first);
    for (const action of route) sim.act(action);
    expect(sim.success).toBe(true);
    expect(sim.readings()).not.toHaveProperty("checks");

    for (const action of route.slice(0, 5)) sim.act(action);
    sim.finish();
    expect(sim.readings()).toMatchObject({
      success: false,
      checks: {
        cradle_settled: true,
        cover_opened: true,
        part_released: true,
        part_seated: true,
        cover_closed: true,
        latch_engaged: false,
        all_conditions_held_for_250ms: false,
      },
    });
  } finally {
    sim.dispose();
  }
});

test("a partial press reports contact and a full press reports that the cover is unlocked", () => {
  const sim = new Simulation(mj, first);
  try {
    const [hover, close, press, lift] = machineRoute(first);
    if (press.type !== "move_to") throw new Error("Expected a press move");
    sim.act(hover);
    sim.act(close);
    sim.act({ ...press, z_mm: 112 });
    const partial = sim.readings().latch;
    expect(partial).toMatchObject({ finger_contact: true, unlocked: false, release_travel_mm: 20 });
    expect(partial?.depression_mm).toBeGreaterThan(0);
    expect(partial?.depression_mm).toBeLessThan(20);
    sim.act(press);
    expect(sim.readings().latch?.unlocked).toBe(true);
    sim.act(lift);
    expect(sim.readings().latch).toMatchObject({ finger_contact: false, unlocked: true });
  } finally {
    sim.dispose();
  }
});
