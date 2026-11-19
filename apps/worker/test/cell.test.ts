import { expect, test } from "bun:test";
import { closeCover, move, referenceCycle } from "../../../tooling/cell-route";
import { gaugePockets, shiftPlan } from "../sim/cell";
import { cyclePoints, type Layout, loadPhysics, Simulation } from "../sim/physics";

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

test.each([1, 2])(
  "the reference route completes shift %d with a perfect score",
  (seed) => {
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
  },
  60_000,
);

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
    // Unlatch, then pull the cover open with a steady force: a seized slide must not creep.
    const cell = sim.cellGeometry;
    if (!cell) throw new Error("Missing cell");
    sim.act(move(cell.latchX, cell.latchY, 150, 90));
    sim.act({ type: "grip", state: "close" });
    sim.act(move(cell.latchX, cell.latchY, 93, 90));
    sim.act(move(cell.latchX, cell.latchY, 150, 90));
    const pull = () => {
      // biome-ignore lint/suspicious/noExplicitAny: the test pulls the cover body directly.
      const internal = sim as any;
      const cover = mj.mj_name2id(internal.model, mj.mjtObj.mjOBJ_BODY.value, "cover");
      const before = sim.groundTruth().cover ?? 0;
      internal.data.xfrc_applied[cover * 6] = 10 * cell.direction;
      for (let i = 0; i < 1000; i++) mj.mj_step(internal.model, internal.data);
      internal.data.xfrc_applied[cover * 6] = 0;
      return (sim.groundTruth().cover ?? 0) - before;
    };
    expect(pull()).toBeLessThan(0.001);
    const right = sim.requestHelp("machine_fault", "The cover will not move.");
    expect(right).toMatchObject({ matched: true, required: true });
    expect(sim.readings().shift?.cycle_seconds).toBeGreaterThanOrEqual(180);
    expect(pull()).toBeGreaterThan(0.01);
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

test("the clamped back stop holds against a sustained push", () => {
  withSim(layout(1), (sim) => {
    // biome-ignore lint/suspicious/noExplicitAny: the test pushes the stop body directly.
    const internal = sim as any;
    const body = internal.cell.ids.stopBody;
    sim.act({ type: "grip", state: "open" });
    const before = sim.groundTruth().stopFace ?? 0;
    internal.data.xfrc_applied[body * 6 + 1] = -5;
    for (let i = 0; i < 2500; i++) mj.mj_step(internal.model, internal.data);
    internal.data.xfrc_applied[body * 6 + 1] = 0;
    expect(Math.abs((sim.groundTruth().stopFace ?? 0) - before)).toBeLessThan(0.0002);
  });
});

test("asking a technician to inspect every part costs half the score", () => {
  withSim(layout(1), (sim) => {
    while (!sim.ended) {
      const help = sim.requestHelp("part_quality", "Please check this part.");
      if (help.response.includes("quarantined")) sim.finish();
      else referenceCycle(sim);
    }
    expect(sim.shiftSummary()).toMatchObject({ score: 0.5, avoidable_visits: 8 });
    expect(sim.success).toBe(false);
  });
}, 60_000);

test("a collision trips a protective stop that holds the arm, and the next move resumes", () => {
  withSim(layout(1), (sim) => {
    const cell = sim.cellGeometry;
    if (!cell) throw new Error("Missing cell");
    sim.act({ type: "grip", state: "close" });
    sim.act(move(cell.loadX, cell.loadY, 150, 90));
    sim.act(move(cell.loadX, cell.loadY, 60, 90));
    const stopped = sim.readings();
    expect(stopped.controller.stop_reason).toBe("protective_stop");
    expect(stopped.stopped_short).toBe(true);
    expect(stopped.shift?.protective_stops_cycle).toBe(1);
    const { x, y, z } = stopped.wrist_force_n;
    expect(Math.hypot(x, y, z)).toBeLessThan(20);
    sim.act(move(cell.loadX, cell.loadY, 150, 90));
    expect(sim.readings().controller.stop_reason).toBe("target_reached");
    expect(sim.readings().shift?.protective_stops_shift).toBe(1);
  });
});

test("the first cycle and the first cycle of a new revision get a double move budget", () => {
  withSim(layout(1), (sim) => {
    expect(sim.readings().moves_remaining).toBe(120);
    referenceCycle(sim);
    expect(sim.readings().moves_remaining).toBe(60);
    while (sim.cycleSpec?.revision === "A") referenceCycle(sim);
    expect(sim.readings().moves_remaining).toBe(120);
  });
}, 60_000);

test("the machine refuses cycle start with the cover open, and QC reports on the first article", () => {
  withSim(layout(1), (sim) => {
    referenceCycle(sim, { leaveCoverOpen: true });
    expect(sim.finish().refused).toContain("cover not closed and latched");
    expect(sim.cycleIndex).toBe(0);
    closeCover(sim);
    expect(sim.finish().refused).toBeUndefined();
    expect(sim.shiftSummary()?.results[0]).toMatchObject({
      outcome: "good",
      refusals: 1,
      first_article: "in spec",
    });
    referenceCycle(sim);
    expect(sim.shiftSummary()?.results[1].first_article).toBeUndefined();
  });
}, 60_000);

test("a stop set off its marks runs as scrap and QC names the stop", () => {
  withSim(layout(2), (sim) => {
    referenceCycle(sim, { stopOffset: 0.003 });
    expect(sim.shiftSummary()?.results[0]).toMatchObject({
      outcome: "scrap",
      first_article: "out of spec: stop position",
    });
  });
}, 60_000);

test("a reject with the wrong reason earns half credit", () => {
  withSim(layout(1), (sim) => {
    advanceTo(sim, "wrong_hand");
    referenceCycle(sim, { rejectReason: "oversize" });
    const result = sim.shiftSummary()?.results.at(-1);
    expect(result).toMatchObject({
      outcome: "correct_reject",
      declared_reason: "oversize",
      reason_correct: false,
    });
    if (result) expect(cyclePoints(result)).toBe(0.5);
  });
}, 60_000);

test("model calls are counted per cycle and summed for the shift", () => {
  withSim(layout(1, 2), (sim) => {
    for (let i = 0; i < 3; i++) sim.noteModelCall();
    referenceCycle(sim);
    sim.noteModelCall();
    referenceCycle(sim);
    const summary = sim.shiftSummary();
    expect(summary?.results.map((result) => result.model_calls)).toEqual([3, 1]);
    expect(summary?.model_calls).toBe(4);
  });
}, 60_000);

test("the door interlock reports locked until the latch is pressed, and again once the cover closes", () => {
  withSim(layout(1), (sim) => {
    const cell = sim.cellGeometry;
    if (!cell) throw new Error("Missing cell");
    expect(sim.readings().machine).toEqual({ door_locked: true });
    sim.act(move(cell.latchX, cell.latchY, 150, 90));
    sim.act({ type: "grip", state: "close" });
    sim.act(move(cell.latchX, cell.latchY, 93, 90));
    sim.act(move(cell.latchX, cell.latchY, 150, 90));
    expect(sim.readings().machine?.door_locked).toBe(false);
    referenceCycle(sim);
    expect(sim.readings().machine?.door_locked).toBe(true);
  });
}, 60_000);

test("a cycle that runs out of moves leaves a loaded part unstarted, even a nonconforming one", () => {
  withSim(layout(1), (sim) => {
    advanceTo(sim, "wrong_hand");
    referenceCycle(sim, { loadDefects: true, leaveCoverOpen: true });
    closeCover(sim);
    while (sim.cycleSpec?.condition === "wrong_hand") sim.act({ type: "grip", state: "open" });
    expect(sim.shiftSummary()?.results.at(-1)).toMatchObject({
      outcome: "incomplete",
      ended_by: "move_budget",
      machine_report: "Cycle start was not pressed; the machine did not run.",
    });
  });
}, 60_000);

test("a routine can finish a cycle that began after a budget-ended cycle", () => {
  withSim(layout(1), (sim) => {
    while (sim.cycleIndex === 0) sim.act({ type: "grip", state: "open" });
    expect(() => sim.finish()).toThrow("already ended at its move budget");
    sim.routineDriving = true;
    sim.finish();
    sim.routineDriving = false;
    expect(sim.shiftSummary()?.results.map((result) => result.by_routine)).toEqual([false, true]);
  });
});

test("after the last cycle, protective stops are counted once", () => {
  withSim(layout(1, 4), (sim) => {
    const cell = sim.cellGeometry;
    if (!cell) throw new Error("Missing cell");
    while (sim.cycleIndex < 3) referenceCycle(sim);
    sim.act({ type: "grip", state: "close" });
    sim.act(move(cell.loadX, cell.loadY, 150, 90));
    sim.act(move(cell.loadX, cell.loadY, 60, 90));
    sim.finish();
    expect(sim.ended).toBe(true);
    expect(sim.readings().shift).toMatchObject({ protective_stops_cycle: 0, protective_stops_shift: 1 });
    expect(sim.shiftSummary()?.safety_events).toBe(1);
  });
}, 60_000);
