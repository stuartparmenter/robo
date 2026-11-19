import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("../apps/worker/", import.meta.url));
const dist = join(worker, "dist");
const scratch = join(worker, ".wrangler");
await mkdir(scratch, { recursive: true });
const staging = await mkdtemp(join(scratch, "assets-"));

try {
  await cp(join(worker, "public"), staging, { recursive: true });

  const result = await Bun.build({
    entrypoints: [join(worker, "sim/browser.ts")],
    outdir: staging,
    target: "browser",
    minify: true,
    plugins: [
      {
        name: "mujoco-browser-module",
        setup(build) {
          build.onResolve({ filter: /^@mujoco\/mujoco$/ }, () => ({ path: "/mujoco.js", external: true }));
        },
      },
    ],
  });
  if (!result.success) throw new AggregateError(result.logs, "Browser build failed");

  const module = Bun.resolveSync("@mujoco/mujoco", worker);
  await cp(module, join(staging, "mujoco.js"));
  const wasm = Bun.resolveSync("@mujoco/mujoco/mujoco.wasm", worker);
  await cp(wasm, join(staging, "mujoco.wasm"));

  // Wrangler dev, types, and deploy can build independently. Publish complete files
  // without deleting assets the dev server or another build may be reading.
  for await (const file of new Bun.Glob("**/*").scan({ cwd: staging, dot: true, onlyFiles: true })) {
    const destination = join(dist, file);
    await mkdir(dirname(destination), { recursive: true });
    await rename(join(staging, file), destination);
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}
