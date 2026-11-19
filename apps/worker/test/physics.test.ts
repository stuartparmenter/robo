import { expect, test } from "bun:test";
import { move as moveCommand } from "../../../tooling/machine-route";
import { defaultLayout, type Layout, layoutGeometry, loadPhysics, Simulation } from "../sim/physics";

const mj = await loadPhysics();

function exercise(
  overrides: Partial<Layout>,
  run: (sim: Simulation, move: (x: number, y: number, z: number, yaw: number) => void) => void,
) {
  const layout: Layout = { ...defaultLayout, ...overrides };
  const sim = new Simulation(mj, layout);
  const move = (x: number, y: number, z: number, yaw: number) => sim.act(moveCommand(x, y, z, yaw));
  const { x, y, yaw } = layoutGeometry(layout);
  try {
    move(x, y, 120, yaw);
    move(x, y, layout.task === "block" ? 18 : 44, yaw);
    sim.act({ type: "grip", state: "close" });
    expect(sim.readings().gripper.object_detected).toBe(true);
    move(x, y, 120, yaw);
    expect(sim.readings().gripper.object_detected).toBe(true);
    run(sim, move);
  } finally {
    sim.dispose();
  }
}

function release(sim: Simulation) {
  sim.act({ type: "grip", state: "open" });
  sim.finish();
}

test("a centered, aligned peg only passes after release", () => {
  exercise({}, (sim, move) => {
    const { socketX, socketY } = layoutGeometry(sim.layout);
    move(socketX, socketY, 120, sim.layout.angle);
    move(socketX, socketY, 46, sim.layout.angle);
    expect(sim.success).toBe(false);
    release(sim);
    expect(sim.readings()).toMatchObject({ success: true, ended: true, declared: true });
  });
});

test("contact stops a crosswise move and a peg released on the lip fails", () => {
  exercise({}, (sim, move) => {
    const { socketX, socketY } = layoutGeometry(sim.layout);
    move(socketX, socketY, 120, sim.layout.angle - 90);
    move(socketX, socketY, 46, sim.layout.angle - 90);
    expect(sim.readings().stopped_short).toBe(true);
    release(sim);
    expect(sim.readings().success).toBe(false);
  });
});

test.each([1, 7, 42])("a shifted fixture is solvable on seed %d", (seed) => {
  exercise({ seed, shift: true }, (sim, move) => {
    const { socketX, socketY } = layoutGeometry(sim.layout);
    move(socketX, socketY, 120, sim.layout.angle);
    move(socketX, socketY, 46, sim.layout.angle);
    expect(sim.readings().stopped_short).toBe(true);
    move(socketX, socketY, 120, sim.layout.angle);
    move(socketX, socketY + 0.012, 120, sim.layout.angle + 9);
    move(socketX, socketY + 0.012, 46, sim.layout.angle + 9);
    release(sim);
    expect(sim.readings().success).toBe(true);
  });
});

test("a block can be picked up and released on the pad", () => {
  exercise({ task: "block" }, (sim, move) => {
    const { socketX, socketY } = layoutGeometry(sim.layout);
    move(socketX, socketY, 120, sim.layout.angle);
    move(socketX, socketY, 20, sim.layout.angle);
    release(sim);
    expect(sim.readings().success).toBe(true);
  });
});

test("the articulated wrist reaches the edges of the command envelope", () => {
  const sim = new Simulation(mj, defaultLayout);
  try {
    for (const x_mm of [-220, 220]) {
      for (const y_mm of [-160, 160]) {
        sim.act({ type: "move_to", x_mm, y_mm, z_mm: 155, yaw_deg: 175 });
        for (const z_mm of [18, 220]) {
          sim.act({ type: "move_to", x_mm, y_mm, z_mm, yaw_deg: -175 });
          expect(sim.readings()).toMatchObject({ x_mm, y_mm, z_mm, yaw_deg: -175, stopped_short: false });
        }
      }
    }
  } finally {
    sim.dispose();
  }
});

test.each([-32, 26, 110])("a correctly aligned keyed peg seats at %d degrees", (angle) => {
  exercise({ task: "keyed", angle }, (sim, move) => {
    const { socketX, socketY } = layoutGeometry(sim.layout);
    move(socketX, socketY, 120, angle);
    move(socketX, socketY, 46, angle);
    release(sim);
    expect(sim.readings().success).toBe(true);
  });
});

test("releasing a backwards keyed peg on the lip fails", () => {
  exercise({ task: "keyed" }, (sim, move) => {
    const { angle } = sim.layout;
    const { socketX, socketY } = layoutGeometry(sim.layout);
    move(socketX, socketY, 120, angle - 180);
    move(socketX, socketY, 46, angle - 180);
    expect(sim.readings().stopped_short).toBe(true);
    release(sim);
    expect(sim.readings().success).toBe(false);
  });
});

test("contact can move the keyed socket and the peg can be seated at its new position", () => {
  exercise({ task: "keyed" }, (sim, move) => {
    const { angle } = sim.layout;
    const { socketX, socketY } = layoutGeometry(sim.layout);
    const fixture = sim.data.body("fixture");
    try {
      move(socketX, socketY, 120, angle - 180);
      move(socketX, socketY, 46, angle - 180);
      expect(sim.readings().stopped_short).toBe(true);
      expect(Math.hypot(fixture.xpos[0] - socketX, fixture.xpos[1] - socketY)).toBeGreaterThan(0.01);

      move(socketX, socketY, 120, angle - 180);
      const [x, y] = fixture.xpos;
      move(x, y, 120, angle);
      move(x, y, 46, angle);
      release(sim);
      expect(sim.readings().success).toBe(true);
    } finally {
      fixture.delete();
    }
  });
});
