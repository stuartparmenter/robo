import { defaultLayout, type Layout, loadPhysics, Simulation } from "../apps/worker/sim/physics";
import { machineRoute } from "./machine-route";

const seeds = Bun.argv.slice(2).map(Number);
if (seeds.some((seed) => !Number.isInteger(seed) || seed < 1 || seed > 999_999)) {
  throw new Error("Pass seed numbers from 1 to 999999.");
}
const mj = await loadPhysics();
for (const seed of seeds.length ? seeds : [1, 2]) {
  const layout: Layout = { ...defaultLayout, task: "machine", seed };
  const sim = new Simulation(mj, layout);
  try {
    const route = machineRoute(layout);
    for (const action of route) sim.act(action);
    sim.finish();
    console.log(JSON.stringify({ layout, moves: sim.moves, success: sim.success }));
    if (!sim.success) process.exitCode = 1;
  } finally {
    sim.dispose();
  }
}
