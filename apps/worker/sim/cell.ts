/**
 * Work cell shift: a randomized single-arm cell with an infeed nest, a go/no-go length gauge,
 * a staging cradle, a reject bin and the latched machine with an adjustable back stop.
 * Each shift is a seeded stream of cycles with part variation, quality defects and machine faults.
 */

export type Revision = "A" | "B";
export type Fault = "none" | "cover_seized" | "latch_stuck";
export type Condition = "normal" | "oversize" | "wrong_hand" | "debris" | Exclude<Fault, "none">;

export type CycleSpec = {
  /** Zero-based cycle index. */
  index: number;
  revision: Revision;
  condition: Condition;
  /** Actual part length in metres. */
  length: number;
  /** True when the part carries the mirrored marking. */
  mirrored: boolean;
  /** Part centre and yaw (radians) in the infeed nest. */
  part: { x: number; y: number; yaw: number };
  /** Chip position relative to the machine load point, when present. */
  debris?: { x: number; y: number; yaw: number };
  fault: Fault;
};

export const partWidth = 0.032;
export const partThickness = 0.018;
export const revisions = {
  A: { nominal: 0.068, pocket: 0.07, stop: 0.034, color: "white" },
  B: { nominal: 0.076, pocket: 0.078, stop: 0.043, color: "yellow" },
} as const;
export const lengthTolerance = 0.0005;
/** The longest part the scene must hold. Geometry is built at this size and shrunk per cycle. */
export const maxPartLength = revisions.B.nominal + 0.0045;
export const cycleBudget = 60;
export const helpSeconds = 90;
/** A wrist force above this is recorded as a safety event. */
export const safetyForce = 30;

const stopRange = { min: 0.028, max: 0.049 };
export const stopHalfDepth = 0.004;

function unit(seed: number, salt: number) {
  const value = Math.imul((seed * 2654435761) ^ salt, 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 2 ** 32;
}

export function cellGeometry(seed: number) {
  const r = (salt: number) => unit(seed, salt);
  const direction = r(1) < 0.5 ? 1 : -1;
  const loadX = direction * (0.055 + r(2) * 0.03);
  const loadY = 0.03 + r(3) * 0.025;
  const slots = [-0.13, 0, 0.13];
  const order = [0, 1, 2].sort((a, b) => r(10 + a) - r(10 + b));
  const frontY = -0.115 + (r(6) - 0.5) * 0.01;
  const station = (slot: number, salt: number) => ({
    x: slots[order[slot]] + (r(salt) - 0.5) * 0.016,
    y: frontY + (r(salt + 1) - 0.5) * 0.01,
  });
  const nestTurned = r(7) < 0.5;
  return {
    direction,
    loadX,
    loadY,
    latchX: loadX + direction * 0.048,
    latchY: loadY + 0.099,
    coverTravel: 0.115,
    releaseTravel: 0.02,
    latchTravel: 0.028,
    gauge: { x: -direction * (0.12 + r(4) * 0.03), y: 0.06 + r(5) * 0.03 },
    nest: { ...station(0, 20), yaw: nestTurned ? Math.PI / 2 : 0 },
    cradle: station(1, 22),
    bin: station(2, 24),
    initialStop: [0.029, 0.039, 0.048][Math.floor(r(8) * 3)],
  };
}
export type CellGeometry = ReturnType<typeof cellGeometry>;

/** Pocket centres in the gauge, one per revision. */
export function gaugePockets(cell: CellGeometry) {
  return {
    A: { x: cell.gauge.x - 0.032, y: cell.gauge.y },
    B: { x: cell.gauge.x + 0.032, y: cell.gauge.y },
  };
}

export function changeoverCycle(seed: number, cycles: number) {
  return Math.max(2, Math.floor(cycles / 2) + (unit(seed, 31) < 0.5 ? 0 : 1));
}

export function shiftPlan(seed: number, cycles: number): CycleSpec[] {
  const cell = cellGeometry(seed);
  const r = (salt: number) => unit(seed, salt);
  const abnormal: Condition[] = [
    "oversize",
    "wrong_hand",
    "debris",
    r(40) < 0.5 ? "cover_seized" : "latch_stuck",
  ];
  const conditions: Condition[] = Array.from({ length: cycles }, () => "normal");
  const slots = Array.from({ length: cycles - 1 }, (_, i) => i + 1).sort((a, b) => r(50 + a) - r(50 + b));
  for (const [i, condition] of abnormal.entries()) {
    if (i < slots.length && i < Math.floor(cycles / 2)) conditions[slots[i]] = condition;
  }
  const changeover = changeoverCycle(seed, cycles);
  return conditions.map((condition, index) => {
    const c = (salt: number) => r(100 + index * 17 + salt);
    const revision: Revision = index >= changeover ? "B" : "A";
    const nominal = revisions[revision].nominal;
    const length =
      condition === "oversize" ? nominal + 0.0035 + c(1) * 0.001 : nominal + (c(1) - 0.5) * 2 * 0.0004;
    const flip = c(2) < 0.5 ? Math.PI : 0;
    const along = (c(3) - 0.5) * 0.008;
    const across = (c(4) - 0.5) * 0.003;
    const [cos, sin] = [Math.cos(cell.nest.yaw), Math.sin(cell.nest.yaw)];
    const fault: Fault = condition === "cover_seized" || condition === "latch_stuck" ? condition : "none";
    return {
      index,
      revision,
      condition,
      length,
      mirrored: condition === "wrong_hand",
      part: {
        // The nest's long axis is local Y.
        x: cell.nest.x + across * cos - along * sin,
        y: cell.nest.y + across * sin + along * cos,
        yaw: cell.nest.yaw + flip + (c(5) - 0.5) * 0.1,
      },
      ...(condition === "debris" && {
        debris: {
          x: (c(6) - 0.5) * 0.008,
          // In front of the stop with room to sweep it out of the open front of the slot.
          y: -0.032 + c(7) * 0.02,
          yaw: (c(8) < 0.5 ? 0 : Math.PI / 2) + (c(9) - 0.5) * 0.6,
        },
      }),
      fault,
    };
  });
}

const box = (size: string, pos: string, rgba: string, props = "") =>
  `<geom type="box" size="${size}" pos="${pos}" rgba="${rgba}" ${props}/>`;
const solid = 'contype="5"';
const colors = { white: ".93 .93 .9 1", yellow: ".95 .8 .2 1" };

/**
 * Pocket end walls with a 3 mm 45° lead-in cut into their inner top edge, so a conforming part
 * released near the centre drops onto the floor and an oversize one perches on the lead-ins.
 */
function pocket(x: number, y: number, length: number, color: string) {
  const half = length / 2;
  const lead = 0.003;
  const walls = [-1, 1].map((side) => {
    const wallY = y + side * (half + 0.004);
    const chamferY = y + side * (half + lead);
    return `
      ${box(".024 .004 .004", `${x} ${wallY} .008`, color, solid)}
      <geom type="box" size=".024 ${lead / Math.SQRT2} ${lead / Math.SQRT2}" pos="${x} ${chamferY} .012" euler="45 0 0" rgba="${color}" friction=".1 .01 .001" priority="1" ${solid}/>`;
  });
  return `${box(".026 .046 .002", `${x} ${y} .002`, ".22 .27 .3 1", solid)}${walls.join("")}`;
}

export function cellFixture(cell: CellGeometry) {
  const { loadX, loadY, latchX, latchY, coverTravel, latchTravel, direction, nest, cradle, bin } = cell;
  const pockets = gaugePockets(cell);
  const railX = loadX + (direction * coverTravel) / 2;
  const railHalfLength = 0.046 + coverTravel / 2;
  const railEnd = railX + direction * (railHalfLength - 0.008);
  const [nc, ns] = [Math.cos(nest.yaw), Math.sin(nest.yaw)];
  const nestPoint = (u: number, v: number) => `${nest.x + u * nc - v * ns} ${nest.y + u * ns + v * nc}`;
  const nestYawDeg = (nest.yaw * 180) / Math.PI;
  const stopPos = cell.initialStop + stopHalfDepth;
  return `
    <body name="nest" pos="${nestPoint(0, 0)} 0" euler="0 0 ${nestYawDeg}">
      ${box(".026 .046 .0015", "0 0 .0015", ".25 .34 .29 1", solid)}
      ${[-1, 1]
        .flatMap((u) =>
          [-1, 1].map((v) => box(".004 .004 .006", `${u * 0.024} ${v * 0.042} .006`, ".45 .52 .44 1", solid)),
        )
        .join("")}
    </body>
    <body name="gauge" pos="0 0 0">
      ${pocket(pockets.A.x, pockets.A.y, revisions.A.pocket, colors.white)}
      ${pocket(pockets.B.x, pockets.B.y, revisions.B.pocket, colors.yellow)}
    </body>
    <body name="cradle" pos="${cradle.x} ${cradle.y} 0">
      <geom type="box" size=".029 .038 .0005" pos="0 0 .0005" rgba=".31 .53 .74 1" contype="0" conaffinity="0"/>
      ${[-0.026, 0.026]
        .map(
          (y) => `
        <geom type="box" size=".028 .010 .013" pos="0 ${y} .013" rgba=".29 .40 .54 1" ${solid}/>
        <geom type="box" size=".008 .010 .010" pos="-.019 ${y} .036" rgba=".34 .64 .84 1" ${solid}/>
        <geom type="box" size=".008 .010 .010" pos=".019 ${y} .036" rgba=".34 .64 .84 1" ${solid}/>`,
        )
        .join("")}
    </body>
    <body name="bin" pos="${bin.x} ${bin.y} 0">
      ${box(".04 .05 .0015", "0 0 .0015", ".42 .2 .2 1", solid)}
      ${box(".002 .05 .01", ".038 0 .01", ".62 .25 .22 1", solid)}
      ${box(".002 .05 .01", "-.038 0 .01", ".62 .25 .22 1", solid)}
      ${box(".04 .002 .01", "0 .048 .01", ".62 .25 .22 1", solid)}
      ${box(".04 .002 .01", "0 -.048 .01", ".62 .25 .22 1", solid)}
    </body>
    <body name="fixture" pos="${loadX} ${loadY} 0">
      ${box(".065 .065 .003", "0 0 .003", ".23 .37 .37 1", solid)}
      <geom type="box" size=".020 .038 .0006" pos="0 0 .0064" rgba=".30 .68 .56 1" contype="0" conaffinity="0"/>
      ${box(".009 .042 .010", "-.031 0 .016", ".31 .69 .66 .86", solid)}
      ${box(".009 .042 .010", ".031 0 .016", ".31 .69 .66 .86", solid)}
      ${(["A", "B"] as const)
        .map((rev) =>
          [-1, 1]
            .map((side) =>
              box(
                ".006 .0008 .0006",
                `${side * 0.031} ${revisions[rev].stop} .0266`,
                colors[revisions[rev].color],
                'contype="0" conaffinity="0"',
              ),
            )
            .join(""),
        )
        .join("")}
    </body>
    <body name="stop" pos="${loadX} ${loadY + stopPos} .0065">
      <joint name="stop_slide" type="slide" axis="0 1 0" range="${stopRange.min + stopHalfDepth - stopPos} ${stopRange.max + stopHalfDepth - stopPos}" damping="4" frictionloss="60" armature=".02"/>
      ${box(".019 .004 .008", "0 0 .008", ".55 .58 .62 1", 'mass=".08" contype="5"')}
      <geom name="stop_knob" type="box" size=".010 .010 .006" pos="0 .006 .022" rgba=".85 .45 .2 1" mass=".01" contype="5" friction="3 .02 .002"/>
    </body>
    <body name="debris" pos="${loadX} ${loadY} .2">
      <freejoint name="debris_free"/>
      <geom name="debris_chip" type="box" size=".009 .004 .005" rgba=".75 .76 .8 1" mass=".003"/>
    </body>
    ${[-0.058, 0.058]
      .map(
        (offset) => `
      <geom type="box" pos="${railX} ${loadY + offset} .087" size="${railHalfLength} .004 .004" rgba=".72 .64 .39 1" contype="0" conaffinity="0"/>
      <geom type="box" pos="${railEnd} ${loadY + offset} .042" size=".008 .007 .042" rgba=".30 .44 .46 1" contype="0" conaffinity="0"/>`,
      )
      .join("")}
    <body name="cover" pos="${loadX} ${loadY} .098" gravcomp="1">
      <joint name="cover_slide" type="slide" axis="${direction} 0 0" range="0 ${coverTravel}" damping="1.4" frictionloss=".35" armature=".02"/>
      <geom type="box" size=".046 .055 .006" rgba=".35 .56 .61 1" mass=".16" contype="5"/>
      <geom name="cover_handle" type="box" size=".015 .010 .012" pos="0 0 .018" rgba=".74 .83 .87 1" mass=".025" contype="5" friction="3 .02 .002"/>
      <geom type="box" size=".006 .012 .008" pos="${direction * 0.033} .063 0" rgba=".52 .62 .67 1" mass=".006" contype="5"/>
    </body>
    <geom type="box" pos="${latchX} ${latchY} .006" size=".019 .021 .006" rgba=".24 .39 .41 1" contype="5"/>
    <geom type="cylinder" pos="${latchX} ${latchY} .036" size=".015 .025" rgba=".30 .44 .46 1" contype="5"/>
    <body name="latch" pos="${latchX} ${latchY} .097" gravcomp="1">
      <joint name="latch_slide" type="slide" axis="0 0 1" range="${-latchTravel} 0" damping="1" stiffness="80" armature=".004"/>
      <geom type="cylinder" pos="0 0 -.021" size=".005 .022" rgba=".62 .72 .76 1" mass="0" contype="0" conaffinity="0"/>
      <geom name="latch_button" type="box" size=".011 .012 .009" pos="0 0 .007" rgba=".85 .25 .25 1" mass=".02"/>
      <geom type="box" size=".006 .016 .007" pos="0 -.016 0" rgba=".75 .30 .30 1" mass=".012"/>
    </body>
  `;
}

/** The part with an asymmetric "F" marking on its top face. Built at the longest size. */
export function cellPiece(spec: CycleSpec) {
  const { x, y, yaw } = spec.part;
  return `
    <body name="piece" pos="${x} ${y} .012" euler="0 0 ${(yaw * 180) / Math.PI}">
      <freejoint name="piece_free"/>
      <geom name="workpiece" type="box" size="${partWidth / 2} ${maxPartLength / 2} ${partThickness / 2}" rgba=".98 .49 .21 1" mass=".03"/>
      ${markBars(false)
        .map(
          ([bx, by, sx, sy], i) =>
            `<geom name="mark_${i}" type="box" size="${sx} ${sy} .0003" pos="${bx} ${by} ${partThickness / 2 + 0.0003}" rgba=".12 .1 .1 1" contype="0" conaffinity="0"/>`,
        )
        .join("")}
    </body>`;
}

/** An "F" on the part's top face: [x, y, halfX, halfY] per bar. Mirrored parts negate X. */
export function markBars(mirrored: boolean) {
  const s = mirrored ? -1 : 1;
  return [
    [s * -0.006, 0, 0.0015, 0.014],
    [s * 0.0005, 0.0125, 0.0065, 0.0015],
    [s * -0.0005, 0.001, 0.0045, 0.0015],
  ];
}

export function workInstruction(revision: Revision) {
  const rev = revisions[revision];
  const length = (rev.nominal * 1000).toFixed(1);
  return {
    revision,
    part: `Bracket blank, revision ${revision}: ${length} ± ${(lengthTolerance * 1000).toFixed(1)} mm long, ${partWidth * 1000} mm wide, ${partThickness * 1000} mm thick. Right-hand parts only: the top face carries an "F" marking that reads correctly as drawn. A mirrored marking is a left-hand part.`,
    steps: [
      "Take the part from the infeed nest.",
      `Check its length in the ${rev.color} pocket of the go/no-go gauge. A conforming part drops fully into the pocket. A part that rests on the lead-ins is oversize.`,
      "Put oversize and left-hand parts in the red reject bin, flat, then end the cycle.",
      `Before loading, set the machine's adjustable back stop so its front face is on the ${rev.color} marks on top of the slot walls. The stop is clamped; squeezing its orange knob with the gripper releases the clamp so it can slide, and it locks again when released.`,
      "Clear anything in the slot before loading.",
      "Load conforming parts on edge in the machine slot, standing on their long 18 mm edge with the length along the slot, pushed back against the stop and centred between the walls.",
      "Close the cover and let the latch lock, then end the cycle.",
    ],
    disposition:
      "Call for help when the cell has a fault you cannot clear. A technician visit costs 90 seconds.",
  };
}
