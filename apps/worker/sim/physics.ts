import loadMuJoCo, { type MainModule } from "@mujoco/mujoco";
import { budget, type Command, type Guard, machineBudget } from "../src/protocol";
import {
  type CellGeometry,
  type CycleSpec,
  cellFixture,
  cellGeometry,
  cellPiece,
  cycleBudget,
  helpSeconds,
  markBars,
  maxPartLength,
  partThickness,
  partWidth,
  revisions,
  safetyForce,
  shiftPlan,
  stopHalfDepth,
} from "./cell";
import { machine, machineFixture } from "./machine";

export type Layout = {
  task: "peg" | "block" | "keyed" | "machine" | "cell";
  seed: number;
  angle: number;
  shift: boolean;
  cadence: 1 | 3;
  calibration?: boolean;
  /** Work cell shift length. */
  cycles?: number;
  /** A person answers help requests instead of the scripted technician. */
  attended?: boolean;
};

export const defaultCycles = 8;
export type HelpCategory = "machine_fault" | "debris" | "part_quality" | "other";
export type Outcome = "good" | "correct_reject" | "escape" | "false_reject" | "scrap" | "incomplete";
export const outcomePoints: Record<Outcome, number> = {
  good: 1,
  correct_reject: 1,
  escape: -3,
  false_reject: 0,
  scrap: -1,
  incomplete: 0,
};
export type RejectReason = "oversize" | "left_hand" | "other";
export type FinishOptions = { reject_reason?: RejectReason };

/** Points a cycle earns, before shift-level penalties. */
export function cyclePoints(result: CycleResult) {
  const points = outcomePoints[result.outcome];
  return result.outcome === "correct_reject" && result.reason_correct === false ? points / 2 : points;
}

export type HelpRecord = {
  cycle: number;
  category: HelpCategory;
  observation: string;
  /** The category matched the cycle's actual condition. */
  matched: boolean;
  /** The cycle had a machine fault that only a technician could clear. */
  required: boolean;
  /** A technician came, as opposed to a person replying or declining. Only visits are scored. */
  visit: boolean;
  response: string;
};
export type CycleResult = {
  cycle: number;
  revision: "A" | "B";
  condition: CycleSpec["condition"];
  outcome: Outcome;
  /** What the machine's own sensors report to the operator. */
  machine_report: string;
  checks?: Record<string, boolean>;
  moves: number;
  seconds: number;
  help_seconds: number;
  safety_events: number;
  ended_by: "declared" | "move_budget";
  /** Reject reason the agent declared at finish, if any. */
  declared_reason?: RejectReason;
  /** A bin reject whose reason was missing or wrong earns half credit. */
  reason_correct?: boolean;
  /** Cycle start was refused for machine alarms this many times. */
  refusals: number;
  /** Tool calls the model made during the cycle, and whether a routine finished it. */
  model_calls: number;
  by_routine: boolean;
  wall_seconds: number;
  /** QC's report on the first part run under each revision. */
  first_article?: string;
};

export const defaultLayout: Layout = { task: "peg", seed: 1, angle: 26, shift: false, cadence: 1 };

const radians = Math.PI / 180;
const gravity = 9.81;
const box = (name: string, size: string, pos: string, rgba: string, props = "") =>
  `<geom name="${name}" type="box" size="${size}" pos="${pos}" rgba="${rgba}" ${props}/>`;

const baseY = 0.26;
const shoulderZ = 0.19;
const upper = 0.31;
const forearm = 0.28;
const toolOffset = 0.065;
const armJoints = 6;
/** The arm and the two jaws come first in qpos and qvel; the piece's free joint follows. */
const robotJoints = armJoints + 2;
/** One drive moves both jaws, so ctrl holds the arm joints, the gripper, then the machine's latch. */
const gripMotor = armJoints;
const latchMotor = armJoints + 1;
/** Finger travel per jaw in metres. */
const jawTravel = { min: 0.01, max: 0.047 };
/** Jaw travel is measured to each finger's centre; the reported width is between their inner faces. */
const fingerThickness = 0.008;
/** Grip force per jaw in newtons, and the drive's gain in newtons per metre of jaw opening. */
const gripForce = 9;
const jawGain = 240;
/** The drive commands the opening, the sum of both jaws' travel. Fully open leaves 1 mm before the outer stops. */
const openTarget = 2 * (jawTravel.max - 0.001);
/** Closing commands an opening so far inside the inner stops that the drive is at its force limit at any width. */
const closedTarget = 2 * jawTravel.min - gripForce / jawGain - 0.006;
/** Each ramped move or settle advances this many steps after the final target. */
const settleSteps = 220;
/** Guarded moves drive in 0.02 s increments and are capped at this much travel time. */
export const guardSeconds = 4;

const jointLimits = [
  { name: "base_yaw", min: -180, max: 10 },
  { name: "shoulder_pitch", min: -170, max: 100 },
  { name: "elbow_pitch", min: -2, max: 180 },
  { name: "wrist_pitch", min: -360, max: 360, wraps: true },
  { name: "wrist_roll", min: -100, max: 100 },
  { name: "tool_yaw", min: -360, max: 360, wraps: true },
] as const;
type StopReason =
  | "idle"
  | "target_reached"
  | "force_limit"
  | "joint_limit"
  | "unreachable"
  | "position_error"
  | "time_limit"
  | "grip_complete"
  | "protective_stop";

function armJoint(index: number, axis: string, damping: string) {
  const { name, min, max } = jointLimits[index];
  return `<joint name="${name}" axis="${axis}" damping="${damping}" range="${min} ${max}"/>`;
}

function seededUnit(seed: number, salt: number) {
  const value = Math.imul(seed ^ salt, 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 2 ** 32;
}

/** Calibration error leaves the jaws centred this far off the tool axis, in metres. */
function jawOffset(layout: Layout) {
  return layout.calibration ? (seededUnit(layout.seed, 143) - 0.5) * 0.001 : 0;
}

function positionBias(layout: Layout) {
  return [71, 83, 97].map((salt, index) =>
    layout.calibration ? (seededUnit(layout.seed, salt) - 0.5) * (index === 2 ? 0.0016 : 0.004) : 0,
  );
}

function rotation(yaw: number, pitch: number, roll: number) {
  const [cy, sy] = [Math.cos(yaw), Math.sin(yaw)];
  const [cp, sp] = [Math.cos(pitch), Math.sin(pitch)];
  const [cr, sr] = [Math.cos(roll), Math.sin(roll)];
  // World yaw, followed by local pitch and roll (ZYX).
  return [
    cy * cp,
    cy * sp * sr - sy * cr,
    cy * sp * cr + sy * sr,
    sy * cp,
    sy * sp * sr + cy * cr,
    sy * sp * cr - cy * sr,
    -sp,
    cp * sr,
    cp * cr,
  ];
}

/** Joint and gripper commands, in ctrl order, for a target of x, y, z, yaw, jaw opening, pitch and roll. */
function armTargets([x, y, z, yaw, opening, pitch, roll]: number[], previous?: Float64Array) {
  const m = rotation(yaw, pitch, roll);
  const centerX = x + m[2] * toolOffset;
  const centerY = y + m[5] * toolOffset - baseY;
  const drop = shoulderZ - z - m[8] * toolOffset;
  const radius = Math.hypot(centerX, centerY);
  const base = Math.atan2(centerY, centerX);
  const cosine = (radius ** 2 + drop ** 2 - upper ** 2 - forearm ** 2) / (2 * upper * forearm);
  const elbow = Math.acos(Math.max(-1, Math.min(1, cosine)));
  const shoulder =
    Math.atan2(drop, radius) - Math.atan2(forearm * Math.sin(elbow), upper + forearm * Math.cos(elbow));

  // Remove the base rotation, then decompose the wrist as YXZ.
  const [c, s] = [Math.cos(base), Math.sin(base)];
  const side = -s * m[2] + c * m[5];
  const wristPitch = Math.atan2(c * m[2] + s * m[5], m[8]) - shoulder - elbow;
  const wristRoll = Math.asin(Math.max(-1, Math.min(1, -side)));
  const toolYaw = Math.atan2(-s * m[0] + c * m[3], -s * m[1] + c * m[4]);
  const result = [base, shoulder, elbow, wristPitch, wristRoll, toolYaw, opening];
  let limited = false;
  for (const [index, joint] of jointLimits.entries()) {
    const wraps = "wraps" in joint;
    if (wraps && previous) result[index] = previous[index] + angleDelta(result[index], previous[index]);
    const lo = joint.min * radians;
    const hi = joint.max * radians;
    if (wraps && result[index] < lo && result[index] + 2 * Math.PI <= hi) result[index] += 2 * Math.PI;
    if (wraps && result[index] > hi && result[index] - 2 * Math.PI >= lo) result[index] -= 2 * Math.PI;
    const bounded = Math.max(lo, Math.min(hi, result[index]));
    limited ||= bounded !== result[index];
    result[index] = bounded;
  }
  return { positions: result, limited, unreachable: Math.abs(cosine) > 1 };
}

function angleDelta(target: number, current: number) {
  const delta = target - current;
  return Math.atan2(Math.sin(delta), Math.cos(delta));
}

export function layoutGeometry(layout: Layout) {
  const random = (salt: number) => seededUnit(layout.seed, salt);
  const graspYawError = layout.calibration ? (random(131) - 0.5) * 5 : 0;
  // Machine loading uses the angle setting to rotate the part instead of the fixture.
  const partRotation = layout.task === "machine" ? layout.angle - 26 : 0;
  return {
    x: -0.131 + random(17) * 0.024,
    y: -0.055 + random(37) * 0.04,
    yaw: Math.round((random(49) - 0.5) * 42) + graspYawError + partRotation,
    socketX: 0.118,
    socketY: 0.041,
  };
}

function scene(layout: Layout, plan?: CycleSpec[]) {
  const { x, y, yaw, socketX, socketY } = layoutGeometry(layout);
  const cell = layout.task === "cell";
  const loading = layout.task === "machine" || cell;
  const peg = layout.task === "peg" || layout.task === "keyed";
  const linkCollision = loading ? 'contype="2" conaffinity="4"' : 'contype="0" conaffinity="0"';
  const keyed = layout.task === "keyed";
  // The jaws' end stops are hard: the stalled drive must not push a jaw visibly past them.
  const jawLimits = `range="${jawTravel.min} ${jawTravel.max}" solreflimit=".004 1" solimplimit=".98 .999 .0005"`;
  const walls = [
    box("wall_left", ".008 .030 .014", "-.028 0 .018", ".26 .68 .68 .73"),
    ...(keyed
      ? [
          box("notch_right_lower", ".008 .016 .014", ".028 -.014 .018", ".26 .68 .68 .73"),
          box("notch_right_upper", ".008 .009 .014", ".028 .021 .018", ".26 .68 .68 .73"),
          box("notch_stop", ".004 .005 .014", ".032 .007 .018", ".46 .81 .68 .9"),
        ]
      : [box("wall_right", ".008 .030 .014", ".028 0 .018", ".26 .68 .68 .73")]),
    box("wall_back", ".020 .008 .014", "0 .022 .018", ".26 .68 .68 .73"),
    box("wall_front", ".020 .008 .014", "0 -.022 .018", ".26 .68 .68 .52"),
  ];
  return `<mujoco model="Robo">
    <compiler angle="degree" autolimits="true"/>
    <!-- Soft contacts slip under any tangential load, at a rate that falls in proportion to impratio. At 100 a
         held part creeps about 0.01 mm/s per newton; near 1000 gripped parts start to chatter. -->
    <option gravity="0 0 -${gravity}" timestep=".002" integrator="implicitfast" cone="elliptic" impratio="100" solver="Newton" tolerance="1e-10" iterations="45"/>
    <default>
      <geom friction="1.2 .01 .001" solref=".006 1" solimp=".95 .99 .001" condim="4"/>
      <joint damping="4" armature=".01"/>
    </default>
    <worldbody>
      ${box("table", ".26 .20 .008", "0 0 -.008", ".11 .16 .21 1", loading ? 'contype="5"' : "")}
      ${box("mounting_plate", ".075 .075 .008", "0 .24 -.006", ".17 .23 .29 1", 'group="1" contype="0" conaffinity="0"')}
      <geom name="arm_mount" type="cylinder" pos="0 ${baseY} .022" size=".058 .030" rgba=".22 .30 .36 1" group="1" contype="0" conaffinity="0"/>
      <geom name="pedestal" type="cylinder" pos="0 ${baseY} .105" size=".037 .075" rgba=".33 .40 .45 1" group="1" contype="0" conaffinity="0"/>
      <body name="base" gravcomp="1" pos="0 ${baseY} ${shoulderZ}">
        ${armJoint(0, "0 0 1", ".8")}
        <geom type="cylinder" size=".048 .022" rgba=".25 .32 .38 1" group="1" mass=".24" ${linkCollision}/>
        <body name="upper_arm" gravcomp="1">
          ${armJoint(1, "0 1 0", ".9")}
          <geom type="sphere" size=".042" rgba=".30 .37 .42 1" group="1" mass=".14" ${linkCollision}/>
          <geom type="capsule" fromto=".032 0 0 ${upper - 0.029} 0 0" size=".030" rgba=".93 .58 .20 1" group="1" mass=".45" ${linkCollision}/>
          <body name="forearm" pos="${upper} 0 0" gravcomp="1">
            ${armJoint(2, "0 1 0", ".6")}
            <geom type="sphere" size=".039" rgba=".27 .34 .40 1" group="1" mass=".13" ${linkCollision}/>
            <geom type="capsule" fromto=".027 0 0 ${forearm - 0.024} 0 0" size=".023" rgba=".93 .58 .20 1" group="1" mass=".26" ${linkCollision}/>
            <body name="wrist_pitch" pos="${forearm} 0 0" gravcomp="1">
              ${armJoint(3, "0 1 0", ".24")}
              <geom type="sphere" size=".028" rgba=".33 .40 .45 1" group="1" mass=".06" ${linkCollision}/>
              <body name="wrist_roll" gravcomp="1">
                ${armJoint(4, "1 0 0", ".24")}
                <geom type="cylinder" pos="0 0 -.025" size=".022 .019" rgba=".42 .51 .57 1" group="1" mass=".07" ${linkCollision}/>
                <body name="tool" gravcomp="1" pos="0 0 ${-toolOffset}">
                  <site name="wrist_sensor" size=".001"/>
                  ${armJoint(5, "0 0 1", ".18")}
                  ${box("wrist", ".046 .015 .008", "0 0 .027", ".70 .79 .86 1", 'mass=".10"')}
                  <body name="left" gravcomp="1" pos="${-jawOffset(layout)} 0 0">
                    <joint name="left_jaw" type="slide" axis="-1 0 0" ${jawLimits}/>
                    ${box("left_finger", ".004 .012 .016", "0 0 .007", ".58 .77 .89 1", 'mass=".025" friction="2 .02 .002"')}
                  </body>
                  <body name="right" gravcomp="1" pos="${-jawOffset(layout)} 0 0">
                    <joint name="right_jaw" type="slide" axis="1 0 0" ${jawLimits}/>
                    ${box("right_finger", ".004 .012 .016", "0 0 .007", ".58 .77 .89 1", 'mass=".025" friction="2 .02 .002"')}
                  </body>
                </body>
              </body>
            </body>
          </body>
        </body>
      </body>
      ${
        cell && plan
          ? cellPiece(plan[0])
          : `<body name="piece" pos="${x} ${y} ${loading ? 0.011 : 0.001}" euler="0 0 ${yaw}">
        <freejoint name="piece_free"/>
        ${peg ? box("shaft", ".018 .012 .020", "0 0 .020", ".97 .62 .23 1", 'mass=".020"') : ""}
        ${peg ? box("band", ".0182 .0122 .003", "0 0 .026", ".99 .88 .57 1", 'mass=".0001" contype="0" conaffinity="0"') : ""}
        ${keyed ? box("key", ".004 .0035 .016", ".0215 .007 .019", ".97 .8 .34 1", 'mass=".003"') : ""}
        ${keyed ? box("key_mark", ".006 .004 .0006", ".014 .012 .0584", ".27 .16 .10 1", 'mass=".0001" contype="0" conaffinity="0"') : ""}
        ${
          loading
            ? box("workpiece", ".016 .034 .009", "0 0 0", ".98 .49 .21 1", 'mass=".03"')
            : box("shoulder", ".023 .017 .009", peg ? "0 0 .049" : "0 0 .010", ".98 .49 .21 1", 'mass=".025"')
        }
      </body>`
      }
      ${
        cell
          ? cellFixture(cellGeometry(layout.seed))
          : loading
            ? machineFixture(layout.seed)
            : `
      <body name="fixture_anchor" mocap="true" pos="${socketX} ${socketY} 0" euler="0 0 ${layout.angle}">
        ${keyed ? box("slide_track", ".045 .058 .001", "0 0 .001", ".24 .31 .35 1", 'contype="0" conaffinity="0"') : ""}
        <body name="fixture" gravcomp="1">
          ${keyed ? '<joint name="socket_slide" type="slide" axis="0 1 0" range="-.023 .023" damping="1.6" stiffness="11" frictionloss=".55" armature=".016"/>' : ""}
          ${box("pad", ".042 .038 .002", "0 0 .002", ".25 .63 .53 1", keyed ? 'mass=".12"' : "")}
          ${peg ? walls.join("") : ""}
        </body>
      </body>
      `
      }
    </worldbody>
    <tendon>
      <!-- The gripper's one drive sets the jaw opening, the sum of both jaws' travel. -->
      <fixed name="jaw_opening">
        <joint joint="left_jaw" coef="1"/>
        <joint joint="right_jaw" coef="1"/>
      </fixed>
    </tendon>
    <equality>
      <!-- Both jaws run off one mechanism, so they stay centred between themselves whatever they touch. -->
      <joint name="jaw_sync" joint1="left_jaw" joint2="right_jaw" polycoef="0 1 0 0 0" solref=".004 1"/>
      ${
        // The back stop's clamp is a lock re-anchored wherever the stop is released, so it neither creeps nor drags.
        // A seized cover slide is a lock too: friction loss alone lets a steady pull creep it open.
        cell
          ? `<joint name="stop_lock" joint1="stop_slide" polycoef="0 0 0 0 0" solref=".004 1"/>
      <joint name="cover_lock" joint1="cover_slide" polycoef="0 0 0 0 0" solref=".004 1" active="false"/>`
          : ""
      }
    </equality>
    <contact>
      <exclude body1="tool" body2="left"/>
      <exclude body1="tool" body2="right"/>
    </contact>
    <actuator>
      <position joint="base_yaw" kp="100" kv="5" forcerange="-12 12"/>
      <position joint="shoulder_pitch" kp="160" kv="7" forcerange="-16 16"/>
      <position joint="elbow_pitch" kp="110" kv="5" forcerange="-10 10"/>
      <position joint="wrist_pitch" kp="30" kv="1.5" forcerange="-4 4"/>
      <position joint="wrist_roll" kp="30" kv="1.5" forcerange="-4 4"/>
      <position joint="tool_yaw" kp="12" kv=".36" forcerange="-1 1"/>
      <position tendon="jaw_opening" kp="${jawGain}" kv="1.5" forcerange="-${gripForce} ${gripForce}"/>
      ${loading ? '<position joint="latch_slide" kp="260" kv="2" forcerange="-7 0"/>' : ""}
    </actuator>
    <sensor>
      <force site="wrist_sensor"/>
      <torque site="wrist_sensor"/>
    </sensor>
  </mujoco>`;
}

export async function loadPhysics(wasm?: string) {
  return loadMuJoCo(wasm ? { locateFile: () => wasm } : undefined);
}

type CellState = {
  geometry: CellGeometry;
  plan: CycleSpec[];
  index: number;
  startTick: number;
  moves: number;
  helpSeconds: number;
  safetyEvents: number;
  /** A safety event is latched until the wrist force has been calm for a while. */
  overForce: boolean;
  overTicks: number;
  calmTicks: number;
  /** The next part waits in the feeder until the gripper is clear of the nest. */
  pendingSpawn: boolean;
  /** The previous cycle ended at its move budget and this one has had no command yet. */
  budgetEnded: boolean;
  /** A protective stop tripped during the current command. */
  tripped: boolean;
  refusals: number;
  modelCalls: number;
  wallStart: number;
  /** Revisions whose first run part QC has already reported on. */
  firstArticles: Set<string>;
  quarantined: boolean;
  fault: CycleSpec["fault"];
  results: CycleResult[];
  helps: HelpRecord[];
  ids: {
    stopBody: number;
    debrisBody: number;
    debrisGeom: number;
    debrisQ: number;
    debrisDof: number;
    coverLock: number;
    stopQ: number;
    stopLock: number;
    knob: number;
    workpiece: number;
    marks: number[];
    pieceQ: number;
    pieceDof: number;
  };
};

const parkedDebris = [0, 0.3, -0.25];

export class Simulation {
  readonly model;
  readonly data;
  private readonly target = [0, -0.09, 0.155, 0, openTarget, 0, 0];
  private readonly fingers: number[];
  private readonly piece: number;
  private readonly tool: number;
  private readonly fixture: number;
  private readonly pieceGeoms: number[];
  private readonly bias: number[];
  /** The empty gripper's weight and the height of its center of mass along the tool axis. */
  private readonly tare: { weight: number; arm: number };
  private stopReason: StopReason = "idle";
  private guardReading?: { threshold_n: number; peak_n: number };
  private shifted = false;
  private stageTicks = 0;
  private opened = false;
  private openedDuringRelease = false;
  private unlatched = false;
  private latchArmed = true;
  private readonly machinePosition?: { cover: number; latch: number };
  private readonly cell?: CellState;
  private tracking = false;
  private released = true;
  private stableTicks = 0;
  tick = 0;
  moves = 0;
  ended = false;
  declared = false;
  stoppedShort = false;
  /** Set by the host while a model-written routine drives the cell, so cycles it ends are attributed to it. */
  routineDriving = false;

  constructor(
    private readonly mj: MainModule,
    readonly layout: Layout,
  ) {
    this.bias = positionBias(layout);
    const plan = layout.task === "cell" ? shiftPlan(layout.seed, layout.cycles ?? defaultCycles) : undefined;
    this.model = mj.MjModel.from_xml_string(scene(layout, plan));
    this.data = new mj.MjData(this.model);
    const geom = (name: string) => mj.mj_name2id(this.model, mj.mjtObj.mjOBJ_GEOM.value, name);
    const body = (name: string) => mj.mj_name2id(this.model, mj.mjtObj.mjOBJ_BODY.value, name);
    this.fingers = [geom("left_finger"), geom("right_finger")];
    this.pieceGeoms = [
      geom("shoulder"),
      geom("shaft"),
      geom("key"),
      geom("workpiece"),
      geom("cover_handle"),
      geom("latch_button"),
    ].filter((id) => id >= 0);
    this.piece = body("piece");
    this.tool = body("tool");
    this.fixture = body("fixture");
    const joint = (name: string) => mj.mj_name2id(this.model, mj.mjtObj.mjOBJ_JOINT.value, name);
    if (layout.task === "machine" || layout.task === "cell") {
      this.machinePosition = {
        cover: this.model.jnt_qposadr[joint("cover_slide")],
        latch: this.model.jnt_qposadr[joint("latch_slide")],
      };
    }
    if (plan) {
      this.cell = {
        geometry: cellGeometry(layout.seed),
        plan,
        index: 0,
        startTick: 0,
        moves: 0,
        helpSeconds: 0,
        safetyEvents: 0,
        overForce: false,
        overTicks: 0,
        calmTicks: 0,
        pendingSpawn: false,
        budgetEnded: false,
        tripped: false,
        refusals: 0,
        modelCalls: 0,
        wallStart: Date.now(),
        firstArticles: new Set(),
        quarantined: false,
        fault: "none",
        results: [],
        helps: [],
        ids: {
          stopBody: body("stop"),
          debrisBody: body("debris"),
          debrisGeom: geom("debris_chip"),
          debrisQ: this.model.jnt_qposadr[joint("debris_free")],
          debrisDof: this.model.jnt_dofadr[joint("debris_free")],
          coverLock: mj.mj_name2id(this.model, mj.mjtObj.mjOBJ_EQUALITY.value, "cover_lock"),
          stopQ: this.model.jnt_qposadr[joint("stop_slide")],
          stopLock: mj.mj_name2id(this.model, mj.mjtObj.mjOBJ_EQUALITY.value, "stop_lock"),
          knob: geom("stop_knob"),
          workpiece: geom("workpiece"),
          marks: [0, 1, 2].map((i) => geom(`mark_${i}`)),
          pieceQ: this.model.jnt_qposadr[joint("piece_free")],
          pieceDof: this.model.jnt_dofadr[joint("piece_free")],
        },
      };
      this.startCycle(0);
    }
    for (let i = 0; i < 3; i++) this.target[i] += this.bias[i];
    const initial = armTargets(this.target).positions;
    this.data.ctrl.set(initial);
    this.data.qpos.set(initial.slice(0, armJoints));
    this.data.qpos.fill(initial[gripMotor] / 2, armJoints, robotJoints);
    this.advance(120);
    const { subtree_com: com, xpos, xmat } = this.data;
    const [p, m] = [this.tool * 3, this.tool * 9];
    this.tare = {
      weight: this.model.body_subtreemass[this.tool] * gravity,
      arm: [0, 1, 2].reduce((sum, i) => sum + (com[p + i] - xpos[p + i]) * xmat[m + 3 * i + 2], 0),
    };
    if (this.cell) this.cell.startTick = this.tick;
  }

  dispose() {
    this.data.delete();
    this.model.delete();
  }

  private contact() {
    const touched = [false, false];
    const contacts = this.data.contact;
    for (let index = 0; index < this.data.ncon; index++) {
      const pair = contacts.get(index);
      if (!pair) continue;
      if (pair.efc_address >= 0) {
        for (const [finger, id] of this.fingers.entries()) {
          const counterpart = pair.geom1 === id ? pair.geom2 : pair.geom2 === id ? pair.geom1 : -1;
          touched[finger] ||= this.pieceGeoms.includes(counterpart);
        }
      }
      pair.delete();
    }
    contacts.delete();
    return {
      fingers: { left: touched[0], right: touched[1] },
    };
  }

  private wristWrench() {
    const { sensordata: sensor, xmat } = this.data;
    const m = this.tool * 9;
    const world = (offset: number, axis: number) => {
      const row = m + 3 * axis;
      return (
        xmat[row] * sensor[offset] + xmat[row + 1] * sensor[offset + 1] + xmat[row + 2] * sensor[offset + 2]
      );
    };
    // Remove the empty gripper's weight and gravity moment. Loads and contacts remain.
    const { weight } = this.tare;
    const gravityMoment = weight * this.tare.arm;
    return {
      force: [-world(0, 0), -world(0, 1), weight - world(0, 2)],
      torque: [
        gravityMoment * xmat[m + 5] - world(3, 0),
        -gravityMoment * xmat[m + 2] - world(3, 1),
        -world(3, 2),
      ],
    };
  }

  /** The first cycle, and the first cycle under a new revision, get double moves for setup and learning. */
  private budgetFor(index: number) {
    const plan = this.cell?.plan;
    if (!plan) return cycleBudget;
    return index === 0 || plan[index].revision !== plan[index - 1].revision ? cycleBudget * 2 : cycleBudget;
  }

  get moveBudget() {
    if (this.cell) return this.budgetFor(this.cell.index);
    return this.machinePosition ? machineBudget : budget;
  }

  private updateMachine() {
    if (!this.machinePosition) return;
    const { qpos, ctrl, xpos, xmat } = this.data;
    const cover = qpos[this.machinePosition.cover];
    const latch = qpos[this.machinePosition.latch];
    // Opening past the latch tab's play is enough for the latch to relock when the cover closes.
    if (cover > (this.cell ? 0.006 : 0.087)) {
      this.opened = true;
      this.openedDuringRelease = true;
    }
    if (!this.unlatched && latch > -0.004) this.latchArmed = true;
    if (this.latchArmed && latch <= -machine.releaseTravel && this.cell?.fault !== "latch_stuck") {
      this.unlatched = true;
      this.latchArmed = false;
    }
    if (this.unlatched && this.openedDuringRelease && cover < (this.cell ? 0.0028 : 0.002)) {
      this.unlatched = false;
      this.openedDuringRelease = false;
    }
    ctrl[latchMotor] = this.unlatched ? -machine.latchTravel : 0;
    const p = this.piece * 3;
    if (!this.cell && this.stageTicks < 125) {
      const settledOnEdge =
        this.released &&
        Math.abs(xpos[p] - machine.cradleX) < 0.004 &&
        Math.abs(xpos[p + 1] - machine.cradleY) < 0.01 &&
        Math.abs(xpos[p + 2] - 0.042) < 0.003 &&
        Math.abs(xmat[this.piece * 9 + 2]) > 0.97 &&
        this.pieceStill();
      this.stageTicks = settledOnEdge ? this.stageTicks + 1 : 0;
    }
  }

  private pieceStill() {
    const v = this.data.qvel;
    const start = robotJoints;
    return (
      Math.hypot(v[start], v[start + 1], v[start + 2]) < 0.009 &&
      Math.hypot(v[start + 3], v[start + 4], v[start + 5]) < 0.2
    );
  }

  private machineSeating() {
    const { xpos, xmat } = this.data;
    const p = this.piece * 3;
    const m = this.piece * 9;
    return {
      centered: Math.abs(xpos[p] - machine.loadX) < 0.005 && Math.abs(xpos[p + 1] - machine.loadY) < 0.009,
      at_slot_floor: Math.abs(xpos[p + 2] - 0.022) < 0.003,
      on_edge_and_aligned: Math.abs(xmat[m + 2]) > 0.97 && Math.abs(xmat[m + 4]) > 0.98,
    };
  }

  private machineChecks() {
    if (!this.machinePosition) return undefined;
    const { cover, latch } = this.machinePosition;
    return {
      cradle_settled: this.stageTicks >= 125,
      cover_opened: this.opened,
      part_released: this.released,
      part_seated: Object.values(this.machineSeating()).every(Boolean),
      cover_closed: this.data.qpos[cover] < 0.003,
      latch_engaged: this.data.qpos[latch] > -0.004,
    };
  }

  private seated() {
    const machineChecks = this.machineChecks();
    if (machineChecks) return Object.values(machineChecks).every(Boolean) && this.pieceStill();

    const { xpos, xmat } = this.data;
    const piece = this.piece * 3;
    const fixture = this.fixture * 3;
    const orientation = this.piece * 9;
    const fixtureOrientation = this.fixture * 9;
    const dx = xpos[piece] - xpos[fixture];
    const dy = xpos[piece + 1] - xpos[fixture + 1];
    const localX = dx * xmat[fixtureOrientation] + dy * xmat[fixtureOrientation + 3];
    const localY = dx * xmat[fixtureOrientation + 1] + dy * xmat[fixtureOrientation + 4];
    const axisDot =
      xmat[orientation] * xmat[fixtureOrientation] + xmat[orientation + 3] * xmat[fixtureOrientation + 3];
    const aligned = (this.layout.task === "keyed" ? axisDot : Math.abs(axisDot)) > Math.cos(6 * radians);
    if (
      !this.released ||
      !this.pieceStill() ||
      xmat[orientation + 8] < 0.99 ||
      Math.abs(xpos[piece + 2] - 0.004) > 0.002
    ) {
      return false;
    }
    if (this.layout.task === "block") return Math.abs(localX) < 0.01 && Math.abs(localY) < 0.01;
    return Math.abs(localX) < 0.003 && Math.abs(localY) < 0.003 && aligned;
  }

  private advance(steps: number, stop?: () => boolean) {
    let interrupted = false;
    for (let i = 0; i < steps; i++) {
      this.mj.mj_step(this.model, this.data);
      this.tick++;
      this.updateMachine();
      // The tare is measured after the arm settles at construction.
      if (this.cell && this.tare) this.trackSafety(this.cell);
      else if (this.tracking) this.stableTicks = this.seated() ? this.stableTicks + 1 : 0;
      if (stop?.()) {
        interrupted = true;
        break;
      }
    }
    this.mj.mj_forward(this.model, this.data);
    return interrupted;
  }

  private drive(target: number[]) {
    const solution = armTargets(target, this.data.ctrl);
    this.data.ctrl.set(solution.positions);
    return solution;
  }

  private guardedMove(start: number[], guard: Guard, sample?: () => void) {
    const baseline = this.wristWrench().force;
    const end = [...this.target];
    const translation = end.slice(0, 3).map((value, index) => value - start[index]);
    const distance = Math.hypot(...translation);
    const rotationSeconds = Math.max(...[3, 5, 6].map((i) => Math.abs(end[i] - start[i]))) / (45 * radians);
    const stepSeconds = 0.02;
    const steps = Math.max(
      1,
      Math.ceil(Math.max((distance * 1000) / guard.speed_mm_s, rotationSeconds) / stepSeconds),
    );
    const allowedSteps = Math.min(steps, Math.round(guardSeconds / stepSeconds));
    const reading = { threshold_n: guard.force_n, peak_n: 0 };
    this.guardReading = reading;
    let goal = start;
    const overThreshold = () => {
      const force = this.wristWrench().force;
      const added = Math.hypot(...force.map((value, index) => value - baseline[index]));
      reading.peak_n = Math.max(reading.peak_n, added);
      return added >= guard.force_n || Boolean(this.cell?.tripped);
    };
    const settleSteps = steps <= allowedSteps ? 22 : 0;
    let triggered = false;
    for (let step = 1; step <= allowedSteps + settleSteps; step++) {
      if (step <= allowedSteps) {
        goal = end.map((value, index) => start[index] + ((value - start[index]) * step) / steps);
        this.drive(goal);
      }
      triggered = this.advance(10, overThreshold);
      if (step % Math.max(3, Math.ceil(allowedSteps / 20)) === 0) sample?.();
      if (triggered) break;
    }

    if (!triggered && steps <= allowedSteps) return;
    const tripped = Boolean(this.cell?.tripped);
    const pose = this.toolPose();
    for (let index = 0; index < 3; index++) {
      const retreat = triggered && !tripped && distance > 0 ? (translation[index] / distance) * 0.002 : 0;
      goal[index] = pose[index] - retreat;
    }
    this.target.splice(0, this.target.length, ...goal);
    this.drive(this.target);
    this.advance(settleSteps);
    return tripped ? "protective_stop" : triggered ? "force_limit" : "time_limit";
  }

  act(command: Command, sample?: () => void) {
    if (this.ended) throw new Error("This run has ended.");
    const start = [...this.target];
    this.moves++;
    if (this.cell) {
      this.clampStop(this.cell);
      this.cell.tripped = false;
    }
    this.stoppedShort = false;
    this.guardReading = undefined;
    if (command.type === "grip") {
      this.released = command.state === "open";
      const open = command.width_mm === undefined ? openTarget : command.width_mm / 1000 + fingerThickness;
      // Closing stalls the drive at its force limit, so the gripper squeezes equally hard at any width.
      this.target[4] = this.released ? open : closedTarget;
    } else {
      this.target[0] = command.x_mm / 1000 + this.bias[0];
      this.target[1] = command.y_mm / 1000 + this.bias[1];
      this.target[2] = command.z_mm / 1000 + this.bias[2];
      this.target[3] += angleDelta(command.yaw_deg * radians, this.target[3]);
      this.target[5] = (command.pitch_deg ?? 0) * radians;
      this.target[6] = (command.roll_deg ?? 0) * radians;
    }
    this.tracking = true;
    this.stableTicks = 0;
    let guardStop: StopReason | undefined;
    if (command.type === "move_to" && command.guard) {
      const pose = this.toolPose();
      for (let axis = 0; axis < 3; axis++) start[axis] = pose[axis];
      guardStop = this.guardedMove(start, command.guard, sample);
    } else {
      const tripped = () => Boolean(this.cell?.tripped);
      let goal = start;
      // Ramp targets to limit accelerations during a grasp.
      for (let frame = 1; frame <= 45 && !tripped(); frame++) {
        const t = frame / 45;
        const blend = t * t * (3 - 2 * t);
        goal = this.target.map((value, index) => start[index] + (value - start[index]) * blend);
        this.drive(goal);
        this.advance(10, tripped);
        if (frame % 3 === 0) sample?.();
      }
      if (!tripped()) this.advance(settleSteps, tripped);
      if (tripped()) {
        // A protective stop holds the arm where it is: measured position, the orientation and jaws reached so far.
        const pose = this.toolPose();
        this.target.splice(0, this.target.length, ...goal);
        for (let axis = 0; axis < 3; axis++) this.target[axis] = pose[axis];
        this.drive(this.target);
        this.advance(settleSteps);
        sample?.();
        guardStop = "protective_stop";
      }
    }
    this.stopReason = guardStop === "protective_stop" ? "protective_stop" : "grip_complete";
    if (command.type === "move_to") {
      const [x, y, z] = this.toolPose();
      const desired = rotation(this.target[3], this.target[5], this.target[6]);
      const actual = this.data.xmat;
      const trace = desired.reduce((dot, entry, i) => dot + entry * actual[this.tool * 9 + i], 0);
      const solution = armTargets(this.target, this.data.ctrl);
      this.stoppedShort =
        Boolean(guardStop) ||
        Math.hypot(x - this.target[0], y - this.target[1], z - this.target[2]) > 0.003 ||
        trace < 1 + 2 * Math.cos(5 * radians);
      this.stopReason =
        guardStop ??
        (solution.unreachable
          ? "unreachable"
          : solution.limited
            ? "joint_limit"
            : this.stoppedShort
              ? "position_error"
              : "target_reached");
    }
    if (
      !this.machinePosition &&
      this.layout.shift &&
      !this.shifted &&
      this.data.xpos[this.piece * 3 + 2] > 0.065
    ) {
      const { fingers } = this.contact();
      if (fingers.left && fingers.right) {
        this.shifted = true;
        this.data.mocap_pos[1] += 0.012;
        const angle = ((this.layout.angle + 9) * radians) / 2;
        this.data.mocap_quat.set([Math.cos(angle), 0, 0, Math.sin(angle)]);
        this.advance(20);
      }
    }
    if (this.cell) {
      // Re-clamp as soon as the jaws let go of the knob, not at the start of the next command.
      this.clampStop(this.cell);
      this.cell.moves++;
      this.cell.budgetEnded = false;
      this.spawnPart(this.cell);
      if (this.cell.moves >= this.moveBudget) {
        this.finishCycle("move_budget");
        if (this.cell) this.cell.budgetEnded = true;
      }
    } else if (this.moves === this.moveBudget) this.ended = true;
  }

  get success() {
    if (this.cell) {
      return (
        this.ended &&
        this.cell.results.length === this.cell.plan.length &&
        this.cell.results.every((result) => cyclePoints(result) === 1 && !result.safety_events) &&
        this.cell.helps.every((help) => !this.avoidableVisit(help))
      );
    }
    return this.stableTicks >= 125 && this.seated();
  }

  private toolPose() {
    const p = this.tool * 3;
    const m = this.tool * 9;
    const { xpos, xmat } = this.data;
    const horizontal = Math.hypot(xmat[m], xmat[m + 3]);
    const singular = horizontal < 0.001;
    return [
      xpos[p],
      xpos[p + 1],
      xpos[p + 2],
      singular ? Math.atan2(-xmat[m + 1], xmat[m + 4]) : Math.atan2(xmat[m + 3], xmat[m]),
      Math.atan2(-xmat[m + 6], horizontal),
      singular ? 0 : Math.atan2(xmat[m + 7], xmat[m + 8]),
    ];
  }

  readings() {
    const [x, y, z, yaw, pitch, roll] = this.toolPose();
    const q = this.data.qpos;
    // The work cell scores each cycle in its shift summary; the single-load machine checks do not apply.
    const checks = this.ended && !this.cell ? this.machineChecks() : undefined;
    const wrench = this.wristWrench();
    const round = (value: number, scale: number) => Math.round(value * scale) / scale;
    const vector = (values: number[], scale: number) => ({
      x: round(values[0], scale),
      y: round(values[1], scale),
      z: round(values[2], scale),
    });
    const effort = this.data.actuator_force;
    const opening = q[armJoints] + q[armJoints + 1];
    return {
      tick: this.tick,
      moves_remaining: this.moveBudget - (this.cell ? this.cell.moves : this.moves),
      x_mm: round((x - this.bias[0]) * 1000, 10),
      y_mm: round((y - this.bias[1]) * 1000, 10),
      z_mm: round((z - this.bias[2]) * 1000, 10),
      yaw_deg: Math.round(yaw / radians),
      pitch_deg: Math.round(pitch / radians),
      roll_deg: Math.round(roll / radians),
      jaw_width_mm: Math.round((opening - fingerThickness) * 1000),
      wrist_force_n: vector(wrench.force, 100),
      wrist_torque_nm: vector(wrench.torque, 1000),
      gripper: {
        // The gripper's one drive reports its effort as force per jaw, and whether it stalled short of fully closed.
        effort_n: round(Math.abs(effort[gripMotor]), 10),
        object_detected: !this.released && opening > 2 * jawTravel.min + 0.001,
      },
      controller: {
        stop_reason: this.stopReason,
        joints: jointLimits.map(({ name, min, max }, index) => {
          const angle = round(q[index] / radians, 10);
          return {
            name,
            angle_deg: angle,
            min_deg: min,
            max_deg: max,
            at_limit: angle <= min + 0.5 || angle >= max - 0.5,
          };
        }),
        ...(this.guardReading && {
          guard: { ...this.guardReading, peak_n: round(this.guardReading.peak_n, 100) },
        }),
      },
      stopped_short: this.stoppedShort,
      ...(this.cell && { shift: this.shiftReading(this.cell), machine: this.machineSignals() }),
      ended: this.ended,
      ...(this.ended && { success: this.success, declared: this.declared }),
      // Once the shift is over, say how it was scored so a failing result is not a mystery.
      ...(this.ended &&
        this.cell && {
          success_rule:
            "A shift succeeds only if every cycle earns its full point, with no protective stops and no avoidable technician visits. The scoring is in success_criteria from get_assignment.",
          shift_summary: this.shiftSummary(),
        }),
      ...(checks && {
        checks: { ...checks, seating: this.machineSeating(), all_conditions_held_for_250ms: this.success },
      }),
    };
  }

  /** Count a tool call the model made, for the autonomy report. */
  noteModelCall() {
    if (this.cell && !this.ended) this.cell.modelCalls++;
  }

  /**
   * End the attempt, or in the work cell press cycle start. The machine refuses to start while
   * its own sensors see a problem, and the cycle continues; that refusal returns a message.
   */
  finish(options: FinishOptions = {}): { refused?: string } {
    if (this.ended) return {};
    const cell = this.cell;
    if (cell) {
      if (cell.budgetEnded && !this.routineDriving) {
        throw new Error(
          `Cycle ${cell.index} already ended at its move budget. Cycle ${cell.index + 1} has started; finish it after working on it.`,
        );
      }
      const alarms = this.machineAlarms(cell);
      if (alarms.length) {
        cell.refusals++;
        cell.moves++;
        const alarm = `Cycle start refused: ${alarms.join(", ")}.`;
        if (cell.moves >= this.moveBudget) {
          this.finishCycle("move_budget");
          if (this.cell && !this.ended) this.cell.budgetEnded = true;
          return { refused: `${alarm} The cycle's move budget ran out.` };
        }
        return { refused: `${alarm} The cycle continues.` };
      }
      this.finishCycle("declared", options);
      if (this.ended) this.declared = true;
      return {};
    }
    this.ended = true;
    this.declared = true;
    return {};
  }

  /** The machine's door interlock switch, as a robot cell's I/O handshake reports it: closed and locked, or not. */
  private machineSignals() {
    const position = this.machinePosition;
    if (!position) return undefined;
    const { qpos } = this.data;
    return { door_locked: qpos[position.cover] < 0.004 && qpos[position.latch] > -0.004 };
  }

  /** Alarms from the machine's own sensors when a part is in the slot. Empty when it can start. */
  private machineAlarms(cell: CellState) {
    const { inChannel, checks } = this.cellChecks(cell);
    if (!inChannel || cell.pendingSpawn) return [];
    const seated = checks.part_on_edge && checks.part_at_slot_floor && checks.part_against_stop;
    return [
      !seated && "part not seated against the stop",
      !checks.part_released && "gripper still in the machine",
      !(checks.cover_closed && checks.latch_engaged) && "cover not closed and latched",
    ].filter((alarm): alarm is string => Boolean(alarm));
  }

  /** Ground truth for the current cycle. The agent never sees this. */
  get cycleSpec() {
    return this.cell?.plan[this.cell.index];
  }

  get cellGeometry() {
    return this.cell?.geometry;
  }

  /** Simulator state for reference routes and tests. Never sent to the agent. */
  groundTruth() {
    const { xpos, xmat, qpos } = this.data;
    const p = this.piece * 3;
    const m = this.piece * 9;
    const stop = this.cell ? xpos[this.cell.ids.stopBody * 3 + 1] - stopHalfDepth : undefined;
    const d = this.cell ? this.cell.ids.debrisBody * 3 : -1;
    return {
      piece: { x: xpos[p], y: xpos[p + 1], z: xpos[p + 2], yaw: Math.atan2(xmat[m + 3], xmat[m]) },
      stopFace: stop,
      debris: d >= 0 ? { x: xpos[d], y: xpos[d + 1], z: xpos[d + 2] } : undefined,
      cover: this.machinePosition ? qpos[this.machinePosition.cover] : undefined,
      latch: this.machinePosition ? qpos[this.machinePosition.latch] : undefined,
      fault: this.cell?.fault,
    };
  }

  private shiftReading(cell: CellState) {
    const spec = cell.plan[Math.min(cell.index, cell.plan.length - 1)];
    return {
      cycle: Math.min(cell.index + 1, cell.plan.length),
      cycles: cell.plan.length,
      work_instruction_revision: spec.revision,
      cycle_seconds: Math.round(((this.tick - cell.startTick) * 0.002 + cell.helpSeconds) * 10) / 10,
      completed_cycles: cell.results.length,
      // After the last cycle, its stops are already in the results.
      protective_stops_cycle: this.ended ? 0 : cell.safetyEvents,
      protective_stops_shift:
        cell.results.reduce((sum, result) => sum + result.safety_events, 0) +
        (this.ended ? 0 : cell.safetyEvents),
    };
  }

  /** The back stop is clamped unless both jaws are squeezing its knob, like an index-plunger release. */
  private clampStop(cell: CellState) {
    const knob = cell.ids.knob;
    const held = [false, false];
    const contacts = this.data.contact;
    for (let index = 0; index < this.data.ncon; index++) {
      const pair = contacts.get(index);
      if (!pair) continue;
      // Only a squeeze on the knob's sides counts. Fingertips resting on its top have a vertical normal.
      const sideways = Math.abs(pair.frame[2]) < 0.5;
      for (const [finger, id] of this.fingers.entries()) {
        if (
          sideways &&
          ((pair.geom1 === id && pair.geom2 === knob) || (pair.geom2 === id && pair.geom1 === knob))
        )
          held[finger] = true;
      }
      pair.delete();
    }
    contacts.delete();
    const { stopLock, stopQ } = cell.ids;
    const release = !this.released && held[0] && held[1];
    if (!release && !this.data.eq_active[stopLock])
      this.model.eq_data[stopLock * this.mj.mjNEQDATA] = this.data.qpos[stopQ];
    this.data.eq_active[stopLock] = release ? 0 : 1;
  }

  private trackSafety(cell: CellState) {
    const { force } = this.wristWrench();
    const magnitude = Math.hypot(...force);
    // A real collision monitor filters single-sample spikes: the force must stay over the limit
    // for 10 ms, and another event counts only after the force has stayed low for 100 ms.
    cell.overTicks = magnitude > safetyForce ? cell.overTicks + 1 : 0;
    cell.calmTicks = magnitude < safetyForce * 0.67 ? cell.calmTicks + 1 : 0;
    if (cell.overTicks >= 5 && !cell.overForce) {
      cell.safetyEvents++;
      cell.overForce = true;
      cell.tripped = true;
    }
    if (cell.calmTicks >= 50) cell.overForce = false;
  }

  private setFreeBody(q: number, dof: number, pos: number[], yaw: number) {
    const { qpos, qvel } = this.data;
    qpos.set([pos[0], pos[1], pos[2], Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)], q);
    qvel.fill(0, dof, dof + 6);
  }

  private parkDebris(cell: CellState) {
    const { ids } = cell;
    this.setFreeBody(ids.debrisQ, ids.debrisDof, parkedDebris, 0);
    this.model.body_gravcomp[ids.debrisBody] = 1;
    this.model.geom_contype[ids.debrisGeom] = 0;
    this.model.geom_conaffinity[ids.debrisGeom] = 0;
  }

  /** Apply a cycle's part shape without moving anything, for replaying recorded frames. */
  showCycle(index: number) {
    const cell = this.cell;
    if (!cell) return;
    const spec = cell.plan[Math.min(index, cell.plan.length - 1)];
    this.model.geom_size[cell.ids.workpiece * 3 + 1] = spec.length / 2;
    for (const [i, [x, y]] of markBars(spec.mirrored).entries()) {
      this.model.geom_pos[cell.ids.marks[i] * 3] = x;
      this.model.geom_pos[cell.ids.marks[i] * 3 + 1] = y;
    }
  }

  /** Zero-based index of the current cycle. */
  get cycleIndex() {
    return this.cell ? Math.min(this.cell.index, this.cell.plan.length - 1) : 0;
  }

  /** Place the cycle's part in the nest once no finger is over it. */
  private spawnPart(cell: CellState) {
    if (!cell.pendingSpawn) return;
    const spec = cell.plan[cell.index];
    const { geom_xpos: xpos } = this.data;
    const reach = maxPartLength / 2 + 0.02;
    const inNest = this.fingers.some(
      (finger) =>
        Math.abs(xpos[finger * 3] - spec.part.x) < reach &&
        Math.abs(xpos[finger * 3 + 1] - spec.part.y) < reach &&
        xpos[finger * 3 + 2] < 0.06,
    );
    if (inNest) {
      // Hold the part out of the cell, like a feeder that has not indexed yet.
      this.setFreeBody(cell.ids.pieceQ, cell.ids.pieceDof, [0, -0.3, -0.25], 0);
      this.model.body_gravcomp[this.piece] = 1;
      return;
    }
    cell.pendingSpawn = false;
    this.setFreeBody(
      cell.ids.pieceQ,
      cell.ids.pieceDof,
      [spec.part.x, spec.part.y, 0.0035 + partThickness / 2],
      spec.part.yaw,
    );
    this.model.body_gravcomp[this.piece] = 0;
    this.mj.mj_forward(this.model, this.data);
  }

  private startCycle(index: number) {
    const cell = this.cell;
    if (!cell) return;
    cell.index = index;
    const spec = cell.plan[index];
    const { ids, geometry } = cell;
    this.model.geom_size[ids.workpiece * 3 + 1] = spec.length / 2;
    for (const [i, [x, y]] of markBars(spec.mirrored).entries()) {
      this.model.geom_pos[ids.marks[i] * 3] = x;
      this.model.geom_pos[ids.marks[i] * 3 + 1] = y;
    }
    // Like a real feeder interlock, the next part is not presented while the gripper is in the nest.
    cell.pendingSpawn = true;
    this.spawnPart(cell);
    if (spec.debris) {
      this.setFreeBody(
        ids.debrisQ,
        ids.debrisDof,
        [geometry.loadX + spec.debris.x, geometry.loadY + spec.debris.y, 0.0115],
        spec.debris.yaw,
      );
      this.model.body_gravcomp[ids.debrisBody] = 0;
      this.model.geom_contype[ids.debrisGeom] = 1;
      this.model.geom_conaffinity[ids.debrisGeom] = 1;
    } else {
      this.parkDebris(cell);
    }
    cell.fault = spec.fault;
    const seized = spec.fault === "cover_seized";
    if (seized)
      this.model.eq_data[ids.coverLock * this.mj.mjNEQDATA] =
        this.data.qpos[this.machinePosition?.cover ?? 0];
    this.data.eq_active[ids.coverLock] = seized ? 1 : 0;
    cell.startTick = this.tick;
    cell.moves = 0;
    cell.helpSeconds = 0;
    cell.safetyEvents = 0;
    cell.overForce = false;
    cell.overTicks = 0;
    cell.calmTicks = 0;
    cell.tripped = false;
    cell.refusals = 0;
    cell.modelCalls = 0;
    cell.wallStart = Date.now();
    cell.quarantined = false;
    this.mj.mj_forward(this.model, this.data);
  }

  /** Both fingers touch the part, whatever the last grip command was. */
  private holdsPart(cell: CellState) {
    const touched = [false, false];
    const contacts = this.data.contact;
    for (let index = 0; index < this.data.ncon; index++) {
      const pair = contacts.get(index);
      if (!pair) continue;
      for (const [finger, id] of this.fingers.entries()) {
        const other = pair.geom1 === id ? pair.geom2 : pair.geom2 === id ? pair.geom1 : -1;
        if (other === cell.ids.workpiece) touched[finger] = true;
      }
      pair.delete();
    }
    contacts.delete();
    return touched[0] && touched[1];
  }

  /** Ground-truth placement checks at the end of a cycle. */
  private cellChecks(cell: CellState) {
    const { geometry: g, ids } = cell;
    const spec = cell.plan[cell.index];
    const { xpos, xmat, qpos } = this.data;
    const p = this.piece * 3;
    const m = this.piece * 9;
    const [px, py, pz] = [xpos[p], xpos[p + 1], xpos[p + 2]];
    const stopFace = xpos[ids.stopBody * 3 + 1] - stopHalfDepth;
    const d = ids.debrisBody * 3;
    const [dx, dy, dz] = [xpos[d] - g.loadX, xpos[d + 1] - g.loadY, xpos[d + 2]];
    const machine = this.machinePosition as { cover: number; latch: number };
    return {
      inChannel: Math.abs(px - g.loadX) < 0.022 && py > g.loadY - 0.05 && py < g.loadY + 0.06 && pz < 0.05,
      inBin: Math.abs(px - g.bin.x) < 0.036 && Math.abs(py - g.bin.y) < 0.046 && pz < 0.03,
      checks: {
        part_on_edge: Math.abs(xmat[m + 2]) > 0.97 && Math.abs(xmat[m + 4]) > 0.98,
        part_at_slot_floor: Math.abs(pz - (0.006 + partWidth / 2)) < 0.003,
        part_centered: Math.abs(px - g.loadX) < 0.004,
        part_against_stop: Math.abs(py + spec.length / 2 - stopFace) < 0.0015,
        stop_at_mark: Math.abs(stopFace - (g.loadY + revisions[spec.revision].stop)) < 0.0015,
        slot_clear: !(Math.abs(dx) < 0.022 && dy > -0.042 && dy < 0.059 && dz < 0.03),
        part_released: !this.holdsPart(cell),
        // The latched cover has 3 mm of play before its tab meets the latch bar.
        cover_closed: qpos[machine.cover] < 0.004,
        latch_engaged: qpos[machine.latch] > -0.004,
      },
    };
  }

  private finishCycle(endedBy: CycleResult["ended_by"], options: FinishOptions = {}) {
    const cell = this.cell;
    if (!cell || this.ended) return;
    const spec = cell.plan[cell.index];
    const { inChannel, inBin, checks } = this.cellChecks(cell);
    const bad = spec.condition === "oversize" || spec.condition === "wrong_hand";
    const alarms = this.machineAlarms(cell);
    const loaded = inChannel && !cell.pendingSpawn;
    // The machine runs only when cycle start is pressed. Running out of moves leaves it idle.
    const runs = loaded && !alarms.length && endedBy === "declared";
    let outcome: Outcome;
    if (cell.quarantined) outcome = bad ? "correct_reject" : "false_reject";
    else if (loaded)
      outcome = !runs
        ? "incomplete"
        : bad
          ? "escape"
          : Object.values(checks).every(Boolean)
            ? "good"
            : "scrap";
    else if (inBin && checks.part_released && !cell.pendingSpawn)
      outcome = bad ? "correct_reject" : "false_reject";
    else outcome = "incomplete";
    const report = !loaded
      ? "No part in the machine."
      : alarms.length
        ? `Machine alarm: ${alarms.join(", ")}; cycle not started.`
        : runs
          ? "Machine cycle started."
          : "Cycle start was not pressed; the machine did not run.";
    const reason = options.reject_reason;
    const expected =
      spec.condition === "oversize" ? "oversize" : spec.condition === "wrong_hand" ? "left_hand" : undefined;
    // QC inspects the first part run under each revision and reports back.
    let firstArticle: string | undefined;
    if (runs && !cell.firstArticles.has(spec.revision)) {
      cell.firstArticles.add(spec.revision);
      const faults = [
        bad && "nonconforming part",
        !checks.stop_at_mark && "stop position",
        !checks.part_centered && "centring",
        !checks.slot_clear && "debris in the slot",
      ].filter(Boolean);
      firstArticle = faults.length ? `out of spec: ${faults.join(", ")}` : "in spec";
    }
    cell.results.push({
      cycle: cell.index + 1,
      revision: spec.revision,
      condition: spec.condition,
      outcome,
      machine_report: report,
      ...(inChannel && { checks }),
      moves: cell.moves,
      seconds: Math.round((this.tick - cell.startTick) * 0.002 * 10) / 10,
      help_seconds: cell.helpSeconds,
      safety_events: cell.safetyEvents,
      ended_by: endedBy,
      ...(reason && { declared_reason: reason }),
      ...(outcome === "correct_reject" && !cell.quarantined && { reason_correct: reason === expected }),
      refusals: cell.refusals,
      model_calls: cell.modelCalls,
      by_routine: this.routineDriving,
      wall_seconds: Math.round((Date.now() - cell.wallStart) / 100) / 10,
      ...(firstArticle && { first_article: firstArticle }),
    });
    if (cell.index + 1 >= cell.plan.length) {
      this.ended = true;
      return;
    }
    // The machine runs and the operator clears the bin before the next part arrives.
    this.startCycle(cell.index + 1);
    this.advance(30);
  }

  /**
   * A technician visit for the current cycle. The technician fixes the problem only when the
   * category matches what is actually wrong. Visits cost time whether or not they help.
   */
  requestHelp(category: HelpCategory, observation: string, reply?: string) {
    const cell = this.cell;
    if (!cell || this.ended) throw new Error("Help requests are part of the work cell shift.");
    const spec = cell.plan[cell.index];
    const bad = (spec.condition === "oversize" || spec.condition === "wrong_hand") && !cell.quarantined;
    const debrisPresent = !this.cellChecks(cell).checks.slot_clear;
    const matched =
      (category === "machine_fault" && cell.fault !== "none") ||
      (category === "debris" && debrisPresent) ||
      (category === "part_quality" && bad);
    let response: string;
    if (reply !== undefined) {
      response = reply;
    } else {
      cell.helpSeconds += helpSeconds;
      if (!matched) {
        response =
          category === "part_quality"
            ? "The technician measured the part. It conforms to the work instruction."
            : "The technician found nothing wrong in that area.";
      } else if (category === "machine_fault") {
        response =
          cell.fault === "cover_seized"
            ? "The technician freed a seized cover slide. The cover moves normally now."
            : "The technician repaired the latch release. A full press unlocks the cover now.";
        cell.fault = "none";
        this.data.eq_active[cell.ids.coverLock] = 0;
      } else if (category === "debris") {
        response = "The technician removed a metal chip from the machine slot.";
        this.parkDebris(cell);
      } else {
        response = "The technician confirmed the part is nonconforming and quarantined it. End the cycle.";
        cell.quarantined = true;
        this.setFreeBody(cell.ids.pieceQ, cell.ids.pieceDof, [0, -0.3, -0.25], 0);
        this.model.body_gravcomp[this.piece] = 1;
      }
      this.mj.mj_forward(this.model, this.data);
    }
    const record: HelpRecord = {
      cycle: cell.index + 1,
      category,
      observation,
      matched,
      required: spec.fault !== "none",
      visit: reply === undefined,
      response,
    };
    cell.helps.push(record);
    return record;
  }

  /** A technician visit counts against the score unless it cleared a machine fault only a technician can. */
  private avoidableVisit(help: HelpRecord) {
    return help.visit && !(help.matched && help.category === "machine_fault");
  }

  /** Plant-style metrics over the cycles completed so far. */
  shiftSummary() {
    const cell = this.cell;
    if (!cell) return undefined;
    const { results, helps } = cell;
    const count = (outcome: Outcome) => results.filter((result) => result.outcome === outcome).length;
    const safety = results.reduce((sum, result) => sum + result.safety_events, 0);
    const visits = helps.filter((help) => help.visit);
    const unnecessary = visits.filter((help) => !help.matched).length;
    const avoidable = visits.filter((help) => this.avoidableVisit(help)).length;
    const faultCycles = cell.plan.filter((spec, i) => spec.fault !== "none" && i < results.length);
    const faultsHelped = faultCycles.filter((spec) =>
      helps.some(
        (help) =>
          help.visit && help.cycle === spec.index + 1 && help.category === "machine_fault" && help.matched,
      ),
    ).length;
    const points =
      results.reduce((sum, result) => sum + cyclePoints(result), 0) - safety * 0.5 - avoidable * 0.5;
    return {
      cycles: cell.plan.length,
      completed: results.length,
      score: results.length ? Math.round((points / cell.plan.length) * 1000) / 1000 : 0,
      good: count("good"),
      correct_rejects: count("correct_reject"),
      escapes: count("escape"),
      false_rejects: count("false_reject"),
      scrap: count("scrap"),
      incomplete: count("incomplete"),
      safety_events: safety,
      help_requests: helps.length,
      technician_visits: visits.length,
      avoidable_visits: avoidable,
      help_precision: visits.length
        ? Math.round(((visits.length - unnecessary) / visits.length) * 100) / 100
        : null,
      fault_recall: faultCycles.length ? faultsHelped / faultCycles.length : null,
      moves: results.reduce((sum, result) => sum + result.moves, 0),
      seconds:
        Math.round(results.reduce((sum, result) => sum + result.seconds + result.help_seconds, 0) * 10) / 10,
      model_calls: results.reduce((sum, result) => sum + result.model_calls, 0),
      routine_cycles: results.filter((result) => result.by_routine).length,
      wall_seconds: Math.round(results.reduce((sum, result) => sum + result.wall_seconds, 0)),
      results,
      helps,
    };
  }
}
