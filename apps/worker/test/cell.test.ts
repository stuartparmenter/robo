import { expect, test } from "bun:test";
import { move, referenceCycle } from "../../../tooling/cell-route";
import { gaugePockets, shiftPlan } from "../sim/cell";
import { type Layout, loadPhysics, Simulation } from "../sim/physics";

const mj = await loadPhysics();
const layout = (seed: number, cycles = 8): Layout => ({
  task: "cell",
  seed,
  angle: 0,
  shift: false,
  cadence: 1,
  cycles,
});

function withSim(l: Layout, run: (sim: Simulation) => void) {
  const sim = new Simulation(mj, l);
  try {
    run(sim);
  } finally {
    sim.dispose();
  }
}

/** Run reference cycles until the current one has the condition. */
function advanceTo(sim: Simulation, condition: string) {
  while (sim.cycleSpec && sim.cycleSpec.condition !== condition && !sim.ended) referenceCycle(sim);
  if (sim.cycleSpec?.condition !== condition) throw new Error(`No ${condition} cycle`);
}

test("each eight-cycle shift has one of each condition, a normal first cycle, and a changeover", () => {
  for (const seed of [1, 2, 3, 99, 4242]) {
    const plan = shiftPlan(seed, 8);
    expect(plan[0].condition).toBe("normal");
    const conditions = plan.map((cycle) => cycle.condition);
    for (const condition of ["oversize", "wrong_hand", "debris"]) expect(conditions).toContain(condition);
    expect(conditions.some((condition) => condition === "cover_seized" || condition === "latch_stuck")).toBe(
      true,
    );
    expect(plan[0].revision).toBe("A");
    expect(plan.at(-1)?.revision).toBe("B");
  }
});

test.each([1, 2])("the reference route completes shift %d with a perfect score", (seed) => {
  withSim(layout(seed), (sim) => {
    while (!sim.ended) referenceCycle(sim);
    const summary = sim.shiftSummary();
    expect(summary).toMatchObject({
      completed: 8,
      escapes: 0,
      scrap: 0,
      safety_events: 0,
      help_precision: 1,
    });
    expect(summary?.score).toBe(1);
    expect(sim.success).toBe(true);
  });
});

test("loading an oversize part is a silent escape", () => {
  withSim(layout(3), (sim) => {
    advanceTo(sim, "oversize");
    referenceCycle(sim, { loadDefects: true });
    const result = sim.shiftSummary()?.results.at(-1);
    expect(result).toMatchObject({ outcome: "escape", machine_report: "Machine cycle started." });
  });
});

test("a seized cover needs a technician, and a mismatched request only costs time", () => {
  withSim(layout(2), (sim) => {
    advanceTo(sim, "cover_seized");
    const wrong = sim.requestHelp("debris", "The cover will not move.");
    expect(wrong.matched).toBe(false);
    expect(wrong.response).toContain("found nothing");
    const right = sim.requestHelp("machine_fault", "The cover will not move.");
    expect(right).toMatchObject({ matched: true, required: true });
    expect(sim.readings().shift?.cycle_seconds).toBeGreaterThanOrEqual(180);
  });
});

test("the back stop stays clamped unless the gripper squeezes its knob", () => {
  withSim(layout(1), (sim) => {
    const cell = sim.cellGeometry;
    if (!cell) throw new Error("Missing cell");
    referenceCycle(sim);
    const face = sim.groundTruth().stopFace ?? 0;
    // Push the stop face from the front with closed fingers.
    sim.act({ type: "grip", state: "close" });
    sim.act(move(cell.loadX, face - 0.012, 150, 90));
    sim.act(move(cell.loadX, face - 0.012, 30, 90));
    sim.act(move(cell.loadX, face + 0.01, 30, 90));
    expect(Math.abs((sim.groundTruth().stopFace ?? 0) - face)).toBeLessThan(0.0005);
  });
});

test("a conforming part drops into the gauge pocket and an oversize part perches", () => {
  withSim(layout(1), (sim) => {
    const gauge = (offset: number) => {
      const spec = sim.cycleSpec;
      const cell = sim.cellGeometry;
      if (!spec || !cell) throw new Error("Missing cell");
      const pocket = gaugePockets(cell)[spec.revision];
      const part = sim.groundTruth().piece;
      let yaw = (part.yaw * 180) / Math.PI;
      while (yaw > 90) yaw -= 180;
      while (yaw <= -90) yaw += 180;
      sim.act(move(part.x, part.y, 150, yaw));
      sim.act(move(part.x, part.y, 21, yaw));
      sim.act({ type: "grip", state: "close" });
      sim.act(move(part.x, part.y, 150, yaw));
      sim.act(move(pocket.x, pocket.y + offset, 150));
      sim.act(move(pocket.x, pocket.y + offset, 33));
      sim.act({ type: "grip", state: "open" });
      sim.act(move(pocket.x, pocket.y + offset, 150));
      return sim.groundTruth().piece.z;
    };
    expect(gauge(0.0015)).toBeLessThan(0.0135);
    sim.finish();
    advanceTo(sim, "oversize");
    expect(gauge(0)).toBeGreaterThan(0.017);
  });
});
