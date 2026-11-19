import { machineGeometry } from "../apps/worker/sim/machine";
import { type Layout, layoutGeometry } from "../apps/worker/sim/physics";
import type { Command } from "../apps/worker/src/protocol";

export const move = (x: number, y: number, z: number, yaw_deg = 0, pitch_deg = 0): Command => ({
  type: "move_to",
  x_mm: x * 1000,
  y_mm: y * 1000,
  z_mm: z,
  yaw_deg,
  pitch_deg,
});

const close = { type: "grip", state: "close" } as const;
const open = { type: "grip", state: "open" } as const;

export function coverMoves(layout: Layout, opening: boolean): Command[] {
  const { loadX, loadY, coverTravel, direction } = machineGeometry(layout.seed);
  const parkedX = loadX + coverTravel * direction;
  const [start, end] = opening ? [loadX, parkedX] : [parkedX, loadX];
  return [
    move(start, loadY, 155, 90),
    move(start, loadY, 118, 90),
    close,
    move(end, loadY, 118, 90),
    open,
    move(end, loadY, 155, 90),
  ];
}

export function machineRoute(layout: Layout): Command[] {
  const { x, y, yaw } = layoutGeometry(layout);
  const { cradleX, cradleY, loadX, loadY, latchX, latchY } = machineGeometry(layout.seed);
  const partYaw = ((((yaw + 180) % 360) + 360) % 360) - 180;
  const tipX = cradleX + 0.009;
  const retractX = cradleX + 0.065;
  return [
    move(latchX, latchY, 145, 90),
    close,
    move(latchX, latchY, 93, 90),
    move(latchX, latchY, 155, 90),
    open,
    ...coverMoves(layout, true),
    move(x, y, 150, partYaw),
    move(x, y, 18, partYaw),
    close,
    move(x, y, 135, partYaw),
    move(tipX, cradleY, 115, 0, 90),
    move(tipX, cradleY, 49, 0, 90),
    open,
    // Withdraw the horizontal jaws before lifting past the cradle.
    move(retractX, cradleY, 49, 0, 90),
    move(retractX, cradleY, 110, 0, 90),
    move(cradleX, cradleY, 120),
    move(cradleX, cradleY, 43),
    close,
    move(cradleX, cradleY, 130),
    move(loadX, loadY, 142),
    move(loadX, loadY, 23),
    open,
    move(loadX, loadY, 155),
    ...coverMoves(layout, false),
  ];
}
