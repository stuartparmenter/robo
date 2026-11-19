import { loadPhysics, Simulation } from "../apps/worker/sim/physics";
import { referenceCycle } from "./cell-route";

const seeds = Bun.argv.slice(2).map(Number);
const mj = await loadPhysics();
for (const seed of seeds.length ? seeds : [1, 2]) {
  const sim = new Simulation(mj, { task: "cell", seed, angle: 0, shift: false, cadence: 1, cycles: 8 });
  try {
    while (!sim.ended) referenceCycle(sim);
    const summary = sim.shiftSummary();
    if (!summary) throw new Error("Missing shift summary");
    const { results, helps, ...totals } = summary;
    console.log(JSON.stringify({ seed, ...totals }));
    for (const result of results) {
      if (result.outcome === "good" || result.outcome === "correct_reject") continue;
      console.log("  ", JSON.stringify(result));
    }
    if (!sim.success) process.exitCode = 1;
  } finally {
    sim.dispose();
  }
}
