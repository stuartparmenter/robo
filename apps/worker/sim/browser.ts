import {
  type Camera,
  type Command,
  command,
  failure,
  type Operation,
  operation,
  reach,
  type Session,
  type ToolResult,
} from "../src/protocol";
import { cycleBudget, helpSeconds, safetyForce, workInstruction } from "./cell";
import { drawWorkInstruction } from "./drawing";
import {
  type Frame,
  listRuns,
  loadRun,
  type RecordedCall,
  type RoutineRecord,
  type RunFrame,
  type RunSummary,
  saveRun,
} from "./history";
import {
  defaultCycles,
  defaultLayout,
  type FinishOptions,
  guardSeconds,
  type HelpCategory,
  type Layout,
  loadPhysics,
  Simulation,
} from "./physics";
import { type CycleOutcome, RoutineSandbox } from "./routine";
import { type FieldPose, FieldView, fieldPose, overheadHalfExtent } from "./view";

function element<T extends HTMLElement>(id: string) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element ${id}`);
  return node as T;
}

const task = element<HTMLSelectElement>("task");
const seed = element<HTMLInputElement>("seed");
const angle = element<HTMLInputElement>("angle");
const cadence = element<HTMLSelectElement>("cadence");
const calibration = element<HTMLInputElement>("calibration");
const guarded = element<HTMLInputElement>("guard");
const shift = element<HTMLInputElement>("shift");
const cyclesInput = element<HTMLInputElement>("cycles");
const attended = element<HTMLInputElement>("attended");
const status = element("status");
const connection = element("connection");
const endpoint = element<HTMLInputElement>("endpoint");
const agentPrompt = element<HTMLTextAreaElement>("agent-prompt");
const manual = element<HTMLInputElement>("manual-mode");
const playReplay = element<HTMLButtonElement>("play-replay");
const connect = element<HTMLButtonElement>("connect");
const timeline = element<HTMLInputElement>("timeline");
const exportButton = element<HTMLButtonElement>("export");
const controls = element<HTMLFieldSetElement>("controls");
const fields = ["x", "y", "z", "yaw", "pitch", "roll"].map((id) => element<HTMLInputElement>(id));
const cameras = {
  overhead: element<HTMLImageElement>("overhead"),
  side: element<HTMLImageElement>("side"),
  inspection: element<HTMLImageElement>("inspection"),
};

const puzzle = {
  peg: {
    title: "Peg insertion",
    goal: "Pick up the peg, align it with the socket, and release it once seated.",
    criteria:
      "Peg seated at the socket floor, approximately aligned, released and stationary for 250 simulated milliseconds.",
  },
  block: {
    title: "Block transfer",
    goal: "Pick up the block and release it upright in the center of the marked pad.",
    criteria: "Block centered on the pad, upright, released and stationary for 250 simulated milliseconds.",
  },
  keyed: {
    title: "Keyed socket",
    goal: "Match the peg’s marked corner to the socket notch. The socket can slide when pushed. Check its position again after contact.",
    criteria:
      "Keyed peg seated at the socket floor with the tab in the matching notch, released and stationary for 250 simulated milliseconds.",
  },
  cell: {
    title: "Work cell shift",
    goal: "Run a shift in this single-arm work cell. Each cycle a part arrives in the infeed nest. Follow the current work instruction: check the part, put nonconforming parts in the red reject bin, or load conforming parts into the machine and close it. Call finish to end each cycle. The work instruction can change during the shift.",
    criteria:
      "Score per cycle: a conforming part loaded and run correctly, or a nonconforming part rejected in the bin with the right reject_reason, +1 (a bin reject with a missing or wrong reason +0.5). A nonconforming part run in the machine (escape) −3. A conforming part run with the stop off its marks, off centre, or with debris in the slot (scrap) −1. A false reject or unfinished cycle 0. Each protective stop −0.5. Each technician visit −0.5, except one that clears a machine fault you cannot clear yourself. Shift score = total ÷ cycles. Time and model calls are reported, not scored. The machine reports only what its own sensors can see.",
  },
  machine: {
    title: "Machine loading",
    goal: "Press the red latch until it stays down on its own. Grip the handle and slide the cover along X toward the exposed gold rails. Stand the orange part on edge across both supports of the blue cradle, release and regrasp it, then load the machine and close the cover. Closing it lets the latch spring back up and lock. Leave it up.",
    criteria:
      "The part was released on edge in the blue cradle, then loaded on edge in the machine. Finish with the part released, cover closed, and latch engaged.",
  },
} satisfies Record<Layout["task"], { title: string; goal: string; criteria: string }>;

function taskFromValue(value: string | null): Layout["task"] {
  return value && Object.hasOwn(puzzle, value) ? (value as Layout["task"]) : defaultLayout.task;
}

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

const isLoading = (value: string) => value === "machine" || value === "cell";

function layoutFromInputs(): Layout {
  const selected = taskFromValue(task.value);
  return {
    task: selected,
    seed: seed.valueAsNumber,
    angle: angle.valueAsNumber,
    shift: !isLoading(selected) && shift.checked,
    cadence: cadence.value === "3" ? 3 : 1,
    calibration: calibration.checked,
    ...(selected === "cell" && { cycles: cyclesInput.valueAsNumber, attended: attended.checked }),
  };
}

const initial = new URL(location.href).searchParams;
task.value = taskFromValue(initial.get("task"));
const bounded = (name: string, fallback: number, min: number, max: number) => {
  const value = Number(initial.get(name) ?? fallback);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
};
seed.value = String(bounded("seed", defaultLayout.seed, 1, 999999));
angle.value = String(bounded("angle", defaultLayout.angle, -180, 180));
calibration.checked = initial.get("calibration") === "1";
shift.checked = !isLoading(task.value) && initial.get("shift") === "1";
cyclesInput.value = String(bounded("cycles", defaultCycles, 4, 12));
attended.checked = initial.get("attended") === "1";
function updateLayoutOptions() {
  const cell = task.value === "cell";
  shift.disabled = isLoading(task.value);
  element("shift-field").hidden = cell;
  element("cycles-field").hidden = !cell;
  element("attended-field").hidden = !cell;
  angle.closest("label")?.toggleAttribute("hidden", cell);
  element("angle-label").textContent = shift.disabled ? "Part rotation" : "Fixture angle";
  if (shift.disabled) shift.checked = false;
}
task.onchange = updateLayoutOptions;
updateLayoutOptions();
cadence.value = initial.get("cadence") === "3" ? "3" : "1";

function layoutUrl(layout: Layout) {
  const url = new URL(location.pathname, location.origin);
  url.search = new URLSearchParams({
    task: layout.task,
    seed: String(layout.seed),
    angle: String(layout.angle),
    shift: layout.shift ? "1" : "0",
    cadence: String(layout.cadence),
    calibration: layout.calibration ? "1" : "0",
    ...(layout.task === "cell" && {
      cycles: String(layout.cycles ?? defaultCycles),
      attended: layout.attended ? "1" : "0",
    }),
  }).toString();
  return url;
}

const page = element("run-page");
const home = element("home");
const setup = element<HTMLDialogElement>("setup");
const runId = initial.get("run");

function runUrl(id: string) {
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set("run", id);
  return url;
}

function layoutDescription(layout: Layout) {
  if (layout.task === "cell") {
    const images = layout.cadence === 1 ? "images every move" : "images every 3 moves";
    return `Seed ${layout.seed} · ${layout.cycles ?? defaultCycles} cycles · ${images}${layout.calibration ? " · Calibration error" : ""}${layout.attended ? " · Attended" : ""}`;
  }
  const rotation = layout.task === "machine" ? "part rotation" : "fixture angle";
  const images = layout.cadence === 1 ? "images every move" : "images every 3 moves";
  return `Seed ${layout.seed} · ${layout.angle}° ${rotation} · ${images}${layout.shift ? " · Fixture shift" : ""}${layout.calibration ? " · Calibration error" : ""}`;
}

const resultLabel = { passed: "Passed", failed: "Failed", unfinished: "Unfinished" };

async function showHome() {
  home.hidden = false;
  const message = element("history-message");
  const list = element("run-list");
  try {
    const runs = (await listRuns()).filter((run) => run.result !== "unfinished");
    message.textContent = runs.length ? "" : "No completed runs saved in this browser yet.";
    list.replaceChildren();
    for (const run of runs) {
      const link = document.createElement("a");
      link.href = runUrl(run.id).href;
      link.className = "run-card";
      const image = document.createElement("img");
      image.src = run.thumbnail;
      image.alt = "";
      image.loading = "lazy";
      const body = document.createElement("div");
      body.className = "run-card-body";
      const title = document.createElement("strong");
      title.textContent = puzzle[run.layout.task].title;
      const layout = document.createElement("span");
      layout.className = "run-meta";
      layout.textContent = layoutDescription(run.layout);
      const score = document.createElement("span");
      score.className = "run-meta";
      const date = new Date(run.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
      score.textContent = run.shift
        ? `${resultLabel[run.result]} · score ${run.shift.score} · ${run.shift.completed}/${run.shift.cycles} cycles · ${date}`
        : `${resultLabel[run.result]} · ${run.moves} / ${run.budget} moves · ${date}`;
      body.append(title, layout, score);
      link.append(image, body);
      list.append(link);
    }
  } catch {
    message.textContent = "Could not read run history in this browser.";
  }
}

element<HTMLButtonElement>("new-run").onclick = () => setup.showModal();
element<HTMLButtonElement>("cancel-setup").onclick = () => setup.close();
element<HTMLFormElement>("layout").onsubmit = (event) => {
  event.preventDefault();
  const url = layoutUrl(layoutFromInputs());
  url.searchParams.set("run", crypto.randomUUID());
  location.assign(url);
};

async function start(id: string) {
  // Fetch and compile the simulator while run history is read.
  const physics = loadPhysics("/mujoco.wasm");
  physics.catch(() => {});
  const saved = await loadRun(id).catch(() => undefined);
  const archived = Boolean(saved);
  if (!saved && !initial.has("task")) throw new Error("This replay is not available in this browser.");
  const layout = saved?.summary.layout ?? layoutFromInputs();
  element("run-title").textContent = puzzle[layout.task].title;
  element("run-layout").textContent = layoutDescription(layout);
  element("goal").textContent = puzzle[layout.task].goal;
  element("shift-panel").hidden = layout.task !== "cell";
  status.textContent = archived ? "Loading replay…" : "Loading simulator…";
  page.hidden = false;
  const mj = await physics;
  const sim = new Simulation(mj, layout);
  const view = new FieldView(sim, element<HTMLCanvasElement>("perspective"));
  const cell = layout.task === "cell";
  /** The cycle whose part shape the 3D view currently shows. */
  let shownCycle = sim.cycleIndex;
  const sandbox = new RoutineSandbox();
  const routines: RoutineRecord[] = saved?.trace?.routines ?? [];
  let routine:
    | (RoutineRecord & {
        startRevision: string;
        cyclesDone: number;
        reports: unknown[];
        question?: { id: number; text: string; camera: string };
        answer?: (text: string) => void;
      })
    | undefined;
  const routineWaiters = new Set<() => void>();
  const routineChanged = () => {
    for (const wake of routineWaiters) wake();
    routineWaiters.clear();
    renderRoutine();
  };
  let pendingHelp:
    | { category: HelpCategory; observation: string; cycle: number; resolve?: (response: string) => void }
    | undefined;
  /** Help replies not yet delivered to the agent. */
  const helpInbox: string[] = [];
  const createdAt = saved?.summary.createdAt ?? Date.now();
  let summary: RunSummary | undefined = saved?.summary;
  let playback: number | undefined;
  const frames: RunFrame[] = saved?.frames ?? [];
  let motion: FieldPose[] = [];
  let animation = 0;
  let nextPoseAt = 0;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const calls: RecordedCall[] = saved?.trace?.calls ?? [];
  let omittedCalls = saved?.trace?.omittedCalls ?? 0;
  let imageFrame: Frame;
  let socket: WebSocket | undefined;
  let sessionActive = false;
  const startedAt = performance.now();
  const cached = new Map<string, { signature: string; reply: ToolResult }>();

  const sessionStatus = () =>
    manual.checked
      ? "Manual control enabled. Agent moves are paused."
      : "MCP session ready. Keep this tab open.";

  function syncTimeline() {
    timeline.max = String(frames.length - 1);
    timeline.disabled = frames.length < 2;
    playReplay.disabled = timeline.disabled;
    exportButton.disabled = false;
  }

  function storageWarning() {
    const warning = element("save-warning");
    warning.hidden = false;
    warning.textContent = "This browser could not save the latest replay. Download a copy to keep it.";
  }

  function updateProgress() {
    const moves = summary?.moves ?? sim.moves;
    const budget = summary?.budget ?? sim.moveBudget;
    const shiftSummary = summary?.shift;
    element("move-counter").textContent = shiftSummary
      ? `Cycle ${Math.min(shiftSummary.completed + 1, shiftSummary.cycles)} / ${shiftSummary.cycles}`
      : `Move ${moves} / ${budget}`;
    element("run-result").textContent = archived
      ? `Replay · ${resultLabel[summary?.result ?? "unfinished"]}`
      : sim.ended
        ? sim.success
          ? "Passed"
          : "Failed"
        : moves
          ? "In progress"
          : "Waiting to start";
  }

  function stopPlayback() {
    clearInterval(playback);
    playback = undefined;
    playReplay.textContent = "Play replay";
  }

  function cancelMotion() {
    cancelAnimationFrame(animation);
    animation = 0;
    motion = [];
    nextPoseAt = 0;
  }

  function playMotion(poses: FieldPose[]) {
    if (reducedMotion.matches) {
      cancelMotion();
      view.drawPerspective(poses[poses.length - 1]);
      return;
    }
    motion.push(...poses);
    if (animation) return;
    const advance = (now: number) => {
      if (now >= nextPoseAt) {
        // Catch up when an agent issues another command before playback finishes.
        const skip = Math.max(1, Math.ceil(motion.length / 24));
        const poses = motion.splice(0, skip);
        view.drawPerspective(poses[poses.length - 1]);
        nextPoseAt = now + 29;
      }
      animation = motion.length ? requestAnimationFrame(advance) : 0;
    };
    nextPoseAt = 0;
    animation = requestAnimationFrame(advance);
  }

  function showFrame(index: number) {
    const { frame, perspective } = frames[index];
    // Live runs keep the current part shape, since the model is still simulating.
    if (archived && frame.cycle !== undefined && frame.cycle !== shownCycle) {
      shownCycle = frame.cycle;
      sim.showCycle(frame.cycle);
      view.refreshShapes(sim);
    }
    element("frame-heading").textContent =
      archived || index < frames.length - 1 ? "Replay frame" : "Current frame";
    if (!animation) view.drawPerspective(perspective);
    const {
      x_mm,
      y_mm,
      z_mm,
      yaw_deg,
      pitch_deg,
      roll_deg,
      jaw_width_mm,
      stopped_short,
      moves_remaining,
      ended,
      success,
      checks,
      wrist_force_n,
      wrist_torque_nm,
      gripper,
      controller,
      shift: shiftReading,
      machine: machineSignals,
    } = frame.readings;
    for (const camera of ["overhead", "side"] as const) cameras[camera].src = frame.images[camera];
    element("inspection-view").hidden = !frame.images.inspection;
    if (frame.images.inspection) cameras.inspection.src = frame.images.inspection;
    const caption = element("frame-label");
    caption.textContent = `Frame ${index} / ${frames.length - 1} · ${frame.label}`;
    caption.title = caption.textContent;
    const lines = [
      `XYZ  ${x_mm}, ${y_mm}, ${z_mm} mm`,
      `Yaw  ${yaw_deg}°   Pitch  ${pitch_deg}°   Roll  ${roll_deg}°`,
      `Jaw  ${jaw_width_mm} mm`,
      `Moves left  ${moves_remaining}`,
    ];
    if (shiftReading) {
      lines.unshift(
        `Cycle  ${shiftReading.cycle} / ${shiftReading.cycles} · Rev ${shiftReading.work_instruction_revision} · ${shiftReading.cycle_seconds} s`,
      );
    }
    if (machineSignals) lines.push(`Door  ${machineSignals.door_locked ? "locked" : "unlocked"}`);
    if (wrist_force_n && wrist_torque_nm && gripper && controller) {
      const xyz = ({ x, y, z }: { x: number; y: number; z: number }) => `${x}, ${y}, ${z}`;
      lines.push(
        `Force XYZ  ${xyz(wrist_force_n)} N`,
        `Torque XYZ  ${xyz(wrist_torque_nm)} N·m`,
        `Grip effort  ${gripper.effort_n} N · object ${gripper.object_detected ? "detected" : "–"}`,
        `Controller  ${controller.stop_reason.replaceAll("_", " ")}`,
      );
      if (controller.guard) lines.push(`Guard peak  ${controller.guard.peak_n} N`);
    }
    element("joint-panel").hidden = !controller;
    element("joint-readings").textContent =
      controller?.joints
        .map(
          (joint) =>
            `${joint.name}  ${joint.angle_deg}°
  ${joint.min_deg}° to ${joint.max_deg}°${joint.at_limit ? " (at limit)" : ""}`,
        )
        .join("\n") ?? "";
    const yn = (value: boolean) => (value ? "yes" : "no");
    if (checks) {
      lines.push(
        "",
        `Cradle settled  ${yn(checks.cradle_settled)}`,
        `Cover opened  ${yn(checks.cover_opened)}`,
        `Part released  ${yn(checks.part_released)}`,
        `Part seated  ${yn(checks.part_seated)}`,
        ...(checks.seating
          ? [
              `  At slot floor  ${yn(checks.seating.at_slot_floor)}`,
              `  Centered  ${yn(checks.seating.centered)}`,
              `  On edge and aligned  ${yn(checks.seating.on_edge_and_aligned)}`,
            ]
          : []),
        `Cover closed  ${yn(checks.cover_closed)}`,
        `Latch engaged  ${yn(checks.latch_engaged)}`,
        `All checks held for 250 ms  ${yn(checks.all_conditions_held_for_250ms)}`,
      );
    }
    element("readings").textContent = lines.join("\n");
    status.textContent = ended
      ? success
        ? "Success. The piece stayed in place after release."
        : checks
          ? "Attempt ended. See the checks below."
          : "Attempt ended. The piece did not pass the placement check."
      : stopped_short
        ? "The arm stopped short of the requested target."
        : index < frames.length - 1
          ? "Viewing a recorded frame."
          : "";
    controls.disabled = archived || ended || !manual.checked || index < frames.length - 1;
  }

  const outcomeLabel: Record<string, string> = {
    good: "Good",
    correct_reject: "Rejected",
    escape: "Escape",
    false_reject: "False reject",
    scrap: "Scrap",
    incomplete: "Incomplete",
  };

  const formatDuration = (seconds: number) =>
    seconds >= 3600
      ? `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`
      : seconds >= 60
        ? `${Math.round(seconds / 60)} min`
        : `${Math.round(seconds)} s`;

  function renderShift() {
    const shiftSummary = summary?.shift;
    if (!cell || !shiftSummary) return;
    const body = element("shift-table").querySelector("tbody");
    if (!body) return;
    const rows = shiftSummary.results.map((result) => {
      const row = document.createElement("tr");
      const outcome = outcomeLabel[result.outcome];
      const helps = shiftSummary.helps.filter((help) => help.cycle === result.cycle).length;
      const cells = [
        String(result.cycle),
        result.revision,
        result.condition.replaceAll("_", " "),
        outcome +
          (result.reason_correct === false ? " (wrong reason)" : "") +
          (result.refusals ? ` · refused ×${result.refusals}` : "") +
          (helps ? ` · help ×${helps}` : "") +
          (result.safety_events
            ? ` · ${result.safety_events} stop${result.safety_events > 1 ? "s" : ""}`
            : "") +
          (result.by_routine ? " · routine" : ""),
        String(result.moves),
        `${Math.round(result.seconds + result.help_seconds)} s`,
      ];
      for (const [i, text] of cells.entries()) {
        const cellNode = document.createElement("td");
        cellNode.textContent = text;
        if (i === 3)
          cellNode.className =
            result.outcome === "good" || result.outcome === "correct_reject" ? "good" : "bad";
        cellNode.title =
          i === 3
            ? [
                result.machine_report,
                result.declared_reason && `Reason: ${result.declared_reason.replaceAll("_", " ")}`,
                result.refusals && `Cycle start refused ×${result.refusals}`,
                result.first_article && `First article: ${result.first_article}`,
              ]
                .filter(Boolean)
                .join("\n")
            : "";
        row.append(cellNode);
      }
      return row;
    });
    if (!sim.ended && !archived) {
      const spec = sim.cycleSpec;
      const reading = sim.readings().shift;
      if (spec && reading) {
        const row = document.createElement("tr");
        row.className = "current";
        for (const text of [
          String(reading.cycle),
          spec.revision,
          spec.condition.replaceAll("_", " "),
          "In progress",
          String(sim.moveBudget - sim.readings().moves_remaining),
          `${Math.round(reading.cycle_seconds)} s`,
        ]) {
          const cellNode = document.createElement("td");
          cellNode.textContent = text;
          row.append(cellNode);
        }
        rows.push(row);
      }
    }
    body.replaceChildren(...rows);
    const {
      score,
      good,
      correct_rejects,
      escapes,
      scrap,
      false_rejects,
      safety_events,
      help_requests,
      seconds,
      model_calls,
      routine_cycles,
      wall_seconds,
    } = shiftSummary;
    const done = shiftSummary.results.length;
    const autonomy =
      model_calls === undefined
        ? ""
        : ` · ${model_calls} model calls (${done ? Math.round(model_calls / done) : 0}/cycle) · ${routine_cycles ?? 0}/${done} cycles by routine · ${formatDuration(wall_seconds ?? 0)} wall clock`;
    element("shift-summary").textContent =
      `Score ${score} · good ${good} · rejected ${correct_rejects} · escapes ${escapes} · scrap ${scrap} · false rejects ${false_rejects} · protective stops ${safety_events} · help ${help_requests} · ${Math.round(seconds)} s of motion${autonomy}`;
  }

  function renderRoutine() {
    const latest = routine ?? routines.at(-1);
    element("routine-panel").hidden = !latest;
    if (!latest) return;
    element("routine-status").textContent = latest.status.replaceAll("_", " ");
    element("routine-code").textContent = latest.code;
    element("routine-log").textContent = [latest.message, ...latest.log.slice(-40)]
      .filter(Boolean)
      .join("\n");
  }

  /** Deliver a technician's or person's reply and record the visit. */
  function answerHelp(category: HelpCategory, observation: string, reply?: string) {
    const visit = sim.requestHelp(category, observation, reply);
    record(reply === undefined ? "Technician visit" : "Help reply");
    return visit.response;
  }

  let shownRevision: string | undefined;
  function showInstruction(revision: string | undefined) {
    if (!cell || !revision || revision === shownRevision) return;
    shownRevision = revision;
    const drawing = element<HTMLImageElement>("work-instruction-image");
    drawing.src = drawWorkInstruction(revision as "A" | "B");
    drawing.hidden = false;
  }

  function record(label: string, samples?: FieldPose[]) {
    showInstruction(sim.cycleSpec?.revision);
    if (cell && sim.cycleIndex !== shownCycle) {
      shownCycle = sim.cycleIndex;
      view.refreshShapes(sim);
    }
    const frame: Frame = {
      label,
      ...(cell && { cycle: sim.cycleIndex }),
      readings: sim.readings(),
      poses: {
        qpos: Array.from(sim.data.qpos),
        mocap_pos: Array.from(sim.data.mocap_pos),
        mocap_quat: Array.from(sim.data.mocap_quat),
      },
      images: {
        overhead: view.capture(sim, "overhead"),
        side: view.capture(sim, "side"),
        ...(isLoading(layout.task) && { inspection: view.capture(sim, "inspection") }),
      },
    };
    const follow = !frames.length || (playback === undefined && timeline.value === timeline.max);
    const index = frames.length;
    const entry: RunFrame = { runId: id, index, frame, perspective: fieldPose(sim), motion: samples };
    frames.push(entry);
    syncTimeline();
    if (follow) {
      timeline.value = timeline.max;
      showFrame(index);
    }
    if (!sim.moves || sim.moves % layout.cadence === 0) imageFrame = frame;
    summary = {
      id,
      createdAt,
      layout,
      moves: sim.moves,
      budget: sim.moveBudget,
      thumbnail: view.thumbnail(),
      result: sim.ended ? (sim.success ? "passed" : "failed") : "unfinished",
      ...(cell && { shift: sim.shiftSummary() }),
    };
    updateProgress();
    renderShift();
    return { frame, saved: saveRun(summary, entry).catch(storageWarning) };
  }

  const actLabel = (move: Command) =>
    move.type === "grip"
      ? `Grip ${move.state}${move.state === "open" && move.width_mm !== undefined ? ` to ${move.width_mm} mm` : ""}`
      : `Move to ${move.x_mm}, ${move.y_mm}, ${move.z_mm} mm · ${move.yaw_deg}°${move.pitch_deg || move.roll_deg ? ` / ${move.pitch_deg ?? 0}° / ${move.roll_deg ?? 0}°` : ""}${move.guard ? " · guarded" : ""}`;

  /** Advance the simulation by one command and record the frame. */
  function performAct(move: Command) {
    const samples: FieldPose[] = [];
    sim.act(move, () => samples.push(fieldPose(sim)));
    samples.push(fieldPose(sim));
    if (playback === undefined && timeline.value === timeline.max) playMotion(samples);
    return record(actLabel(move), samples).frame.readings;
  }

  function cycleReport() {
    const result = sim.shiftSummary()?.results.at(-1);
    return (
      result && {
        cycle: result.cycle,
        machine_report: result.machine_report,
        seconds: result.seconds + result.help_seconds,
        moves: result.moves,
        ended_by: result.ended_by,
        ...(result.first_article && { first_article: result.first_article }),
      }
    );
  }

  /** End the current cycle, or the whole attempt outside the work cell. */
  function performFinish(options: FinishOptions = {}) {
    const revision = sim.cycleSpec?.revision;
    const index = sim.cycleIndex;
    const { refused } = sim.finish(options);
    const readings = record(refused ? "Cycle start refused" : cell ? "Finish cycle" : "Finish").frame
      .readings;
    const ended = !cell || sim.ended || sim.cycleIndex !== index;
    return { readings, notice: revisionNotice(revision), refused, ended };
  }

  /** Tell the agent when a cycle boundary brought in a new work instruction revision. */
  function revisionNotice(before: string | undefined) {
    return cell && !sim.ended && sim.cycleSpec?.revision !== before
      ? `Work instruction revision ${sim.cycleSpec?.revision} is in effect from this cycle. Call get_work_instruction.`
      : undefined;
  }

  const routineActive = () =>
    routine !== undefined && ["running", "asking", "waiting_for_help"].includes(routine.status);

  function routineSnapshot() {
    const latest = routine ?? routines.at(-1);
    if (!latest) return { status: "idle" };
    return {
      status: latest.status,
      ...(latest.message && { message: latest.message }),
      ...(routine?.question && {
        question_id: routine.question.id,
        question: routine.question.text,
        camera: routine.question.camera,
      }),
      cycles_completed_by_routine: latest.cyclesDone ?? 0,
      cycle_reports: latest.reports ?? [],
      log_tail: latest.log.slice(-15),
    };
  }

  async function runRoutine(code: string, cycles: number) {
    const reading = sim.readings().shift;
    if (!reading) return;
    const active = {
      code,
      cycles,
      status: "running",
      log: [] as string[],
      startRevision: reading.work_instruction_revision,
      cyclesDone: 0,
      reports: [] as unknown[],
    } as NonNullable<typeof routine>;
    routine = active;
    routines.push(active);
    routineChanged();
    const stop = (status: string, message?: string) => {
      active.status = status;
      active.message = message;
      active.question = undefined;
      active.answer = undefined;
    };
    sim.routineDriving = true;
    try {
      await runRoutineCycles(code, cycles, active, stop);
    } catch (error) {
      // Never leave the routine marked running: that would refuse every later act and finish.
      sandbox.stop();
      stop("error", errorMessage(error, "The routine host failed."));
    } finally {
      sim.routineDriving = false;
    }
    if (active.status === "running") stop("completed", `Ran ${active.cyclesDone} cycles.`);
    routine = undefined;
    // A stopped routine can no longer receive the reply to its open help request.
    if (pendingHelp?.resolve) {
      pendingHelp = undefined;
      element("help-panel").hidden = true;
    }
    routineChanged();
    if (summary)
      void saveRun(summary, undefined, { runId: id, calls, omittedCalls, routines: routineRecords() }).catch(
        storageWarning,
      );
  }

  let questions = 0;

  async function runRoutineCycles(
    code: string,
    cycles: number,
    active: NonNullable<typeof routine>,
    stop: (status: string, message?: string) => void,
  ) {
    for (let done = 0; done < cycles; done++) {
      const current = sim.readings().shift;
      if (sim.ended || !current) {
        stop("completed", "The shift is complete.");
        break;
      }
      if (current.work_instruction_revision !== active.startRevision) {
        stop(
          "revision_changed",
          `Work instruction revision ${current.work_instruction_revision} took effect. The routine paused before cycle ${current.cycle}.`,
        );
        break;
      }
      const index = sim.cycleIndex;
      const outcome: CycleOutcome = await sandbox.runCycle(
        code,
        { number: current.cycle, of: current.cycles, revision: current.work_instruction_revision },
        {
          act: async (raw) => {
            if (manual.checked) throw new Error("The host took manual control.");
            if (sim.ended || sim.cycleIndex !== index) throw new Error("The cycle has ended.");
            const parsed = command.safeParse(raw);
            if (!parsed.success)
              throw new Error(`Invalid command: ${parsed.error.issues[0]?.message ?? "unknown"}`);
            const readings = performAct(parsed.data);
            if (sim.cycleIndex !== index || sim.ended) {
              throw new Error("The cycle's move budget ran out and the cycle ended.");
            }
            return readings;
          },
          readings: () => sim.readings(),
          ask: (text, camera) =>
            new Promise<string>((resolve) => {
              active.status = "asking";
              active.question = {
                id: ++questions,
                text,
                camera: ["overhead", "side", "inspection"].includes(camera) ? camera : "overhead",
              };
              active.answer = (answer) => {
                active.status = "running";
                active.question = undefined;
                active.answer = undefined;
                routineChanged();
                resolve(answer);
              };
              routineChanged();
            }),
          requestHelp: async (category, observation) => {
            const parsed = helpCategoryOf(category);
            if (!parsed) throw new Error("Category must be machine_fault, debris, part_quality or other.");
            if (!layout.attended) return answerHelp(parsed, observation);
            if (pendingHelp) throw new Error("A help request is already open.");
            active.status = "waiting_for_help";
            routineChanged();
            const response = await new Promise<string>((resolve) => {
              openHelp(parsed, observation, resolve);
            });
            active.status = "running";
            routineChanged();
            return response;
          },
          log: (line) => {
            active.log.push(line);
            if (active.log.length > 200) active.log.splice(0, active.log.length - 200);
            renderRoutine();
          },
        },
      );
      if (outcome.kind === "done") {
        if (!sim.ended && sim.cycleIndex === index) {
          const finished = performFinish({ reject_reason: outcome.rejectReason });
          if (finished.refused && !finished.ended) {
            stop("handed_back", finished.refused);
            break;
          }
        }
        active.cyclesDone++;
        active.reports.push(cycleReport());
        routineChanged();
        continue;
      }
      if (outcome.kind === "handed_back")
        stop("handed_back", outcome.message || "The routine handed control back.");
      else if (outcome.kind === "error") stop("error", outcome.message);
      else if (outcome.kind === "timeout")
        stop("timeout", "The routine made no robot call for 20 seconds and was stopped.");
      else stop("stopped", "The routine was stopped.");
      break;
    }
  }

  /** Storable copies of the routine records, without the live question callback IndexedDB cannot clone. */
  const routineRecords = (): RoutineRecord[] =>
    routines.map(({ code, cycles, status, message, log, cyclesDone, reports }) => ({
      code,
      cycles,
      status,
      ...(message !== undefined && { message }),
      log: [...log],
      ...(cyclesDone !== undefined && { cyclesDone }),
      ...(reports && { reports: [...reports] }),
    }));

  const helpCategoryOf = (value: string): HelpCategory | undefined =>
    ["machine_fault", "debris", "part_quality", "other"].includes(value)
      ? (value as HelpCategory)
      : undefined;

  function openHelp(category: HelpCategory, observation: string, resolve?: (response: string) => void) {
    pendingHelp = { category, observation, cycle: sim.cycleIndex, resolve };
    element("help-request").textContent =
      `Cycle ${sim.readings().shift?.cycle}: ${category.replaceAll("_", " ")}. ${observation || "No details."}`;
    element<HTMLTextAreaElement>("help-reply").value = "";
    element("help-panel").hidden = false;
  }

  function closeHelp(response: string) {
    const open = pendingHelp;
    if (!open) return;
    pendingHelp = undefined;
    element("help-panel").hidden = true;
    if (open.resolve) open.resolve(response);
    else helpInbox.push(response);
  }

  /** Answer the open request, unless its cycle ended first; a late visit must not act on another cycle. */
  function answerPending(reply?: string) {
    const open = pendingHelp;
    if (!open) return;
    if (sim.ended || sim.cycleIndex !== open.cycle) {
      closeHelp("The help request lapsed because its cycle ended before anyone answered.");
      return;
    }
    closeHelp(answerHelp(open.category, open.observation, reply));
  }

  element<HTMLButtonElement>("help-dispatch").onclick = () => answerPending();
  element<HTMLButtonElement>("help-send").onclick = () => {
    const text = element<HTMLTextAreaElement>("help-reply").value.trim();
    if (text) answerPending(text);
  };
  element<HTMLButtonElement>("help-decline").onclick = () => answerPending("No one is available to help.");

  /** Wait for a running routine to change state; `stopping` also waits out a paused one that was just stopped. */
  function waitForRoutine(seconds: number, stopping = false) {
    if (!routineActive() || (!stopping && routine?.status !== "running") || seconds <= 0)
      return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, seconds * 1000);
      function done() {
        clearTimeout(timer);
        routineWaiters.delete(done);
        resolve();
      }
      routineWaiters.add(done);
    });
  }

  async function perform(input: Operation): Promise<ToolResult> {
    if ("camera" in input && input.camera === "inspection" && !isLoading(layout.task)) {
      return failure("The inspection camera is available for Machine loading and the work cell.");
    }
    const cellOnly = ["get_work_instruction", "request_help", "run_routine", "routine_status"];
    if (!cell && cellOnly.includes(input.tool)) return failure("This tool is part of the work cell shift.");
    if (
      routineActive() &&
      (input.tool === "act" || input.tool === "finish" || input.tool === "run_routine")
    ) {
      return failure("A routine is running. Use routine_status to wait, answer, or stop it.");
    }
    if (input.tool !== "get_assignment") sim.noteModelCall();
    // Readings captured by this call's frame, so they are not computed twice.
    let readings: Frame["readings"] | undefined;
    const extra: Record<string, unknown> = {};
    let camera: Camera = "overhead";
    let image: string | undefined;
    switch (input.tool) {
      case "act": {
        if (sim.ended) return failure("This run has ended.");
        const cycle = sim.cycleIndex;
        const revision = sim.cycleSpec?.revision;
        readings = performAct(input.command);
        if (cell && (sim.cycleIndex !== cycle || sim.ended)) {
          extra.cycle_report = cycleReport();
          extra.notice = [
            "The cycle's move budget ran out, so the cycle ended without starting the machine.",
            revisionNotice(revision),
          ]
            .filter(Boolean)
            .join(" ");
        }
        camera = input.camera;
        break;
      }
      case "finish":
        if (!sim.ended) {
          const finished = performFinish({ reject_reason: input.reject_reason });
          readings = finished.readings;
          if (finished.refused) extra.machine_report = finished.refused;
          if (cell && finished.ended) {
            extra.cycle_report = cycleReport();
            if (finished.notice) extra.notice = finished.notice;
            if (sim.ended) extra.notice = "The shift is complete.";
          }
        }
        camera = input.camera;
        break;
      case "observe":
        camera = input.camera;
        break;
      case "get_work_instruction": {
        const revision = sim.cycleSpec?.revision ?? "A";
        Object.assign(extra, { work_instruction: workInstruction(revision) });
        image = drawWorkInstruction(revision);
        break;
      }
      case "request_help": {
        if (sim.ended) return failure("This run has ended.");
        if (layout.attended) {
          if (pendingHelp)
            return failure("A help request is already open. Its reply will arrive in a later result.");
          openHelp(input.category, input.observation);
          extra.help = "Request sent. A person will respond; the reply arrives in a later tool result.";
        } else {
          extra.help_response = answerHelp(input.category, input.observation);
          readings = frames[frames.length - 1].frame.readings;
        }
        break;
      }
      case "run_routine": {
        if (sim.ended) return failure("This run has ended.");
        if (sim.readings().moves_remaining !== sim.moveBudget) {
          return failure("Routines start at the beginning of a cycle. Finish the current cycle first.");
        }
        void runRoutine(input.code, input.cycles);
        extra.routine = routineSnapshot();
        break;
      }
      case "routine_status": {
        if (input.stop && routineActive()) sandbox.stop();
        if (input.answer !== undefined) {
          if (!routine?.answer || !routine.question)
            return failure("The routine is not waiting for an answer.");
          if (input.question_id !== routine.question.id)
            return failure(
              `That answer is for question ${input.question_id ?? "(none)"}, but the open question is ${routine.question.id}. Read it with routine_status and answer with its question_id.`,
            );
          routine.answer(input.answer);
        }
        await waitForRoutine(input.wait_s);
        if (input.stop) await waitForRoutine(1, true);
        extra.routine = routineSnapshot();
        if (routine?.question) camera = routine.question.camera as Camera;
        break;
      }
    }
    const latest = frames[frames.length - 1].frame;
    const info: Record<string, unknown> = {
      ...(readings ?? sim.readings()),
      ...(image ? {} : { camera, image_tick: imageFrame.readings.tick }),
      ...extra,
    };
    if (helpInbox.length) info.help_responses = helpInbox.splice(0);
    if (input.tool === "get_assignment") {
      Object.assign(info, {
        goal: puzzle[sim.layout.task].goal,
        success_criteria: puzzle[sim.layout.task].criteria,
        axes: "Overhead: +X right, +Y up. +Z is height above the table. Positive yaw rotates counterclockwise above +X. Pitch and roll are optional local Y and X rotations after yaw. Zero pitch and roll point the fingers down. Use mm and degrees. Z is the wrist's gripper target, 7 mm below the finger center. The fingertips are 9 mm below Z, and each finger is 32 mm long, 24 mm wide and 8 mm thick.",
        feedback:
          "Wrist force (N) and torque (N·m) are in world XYZ and tared for the empty tool. The gripper reports jaw width, motor effort, and object_detected when the closing jaws stall on something before reaching their closed position. Joint readings report controller angles and limits. Numerical readings are fresh even if the image is stale.",
        guarded_move: `Optional move_to guard: {force_n, speed_mm_s}. Moves slowly and stops and backs away when the wrist-force vector changes by force_n N relative to the start of the move. Guarded motion is limited to ${guardSeconds} seconds of travel per action.`,
        grip_commands:
          "grip open takes an optional width_mm (14–84) to open partway. grip close squeezes with a set force.",
        calibration_error_enabled: Boolean(layout.calibration),
        budget: sim.moveBudget,
        image_cadence: sim.layout.cadence,
      });
      if (isLoading(layout.task)) {
        info.inspection_camera =
          "Use observe with camera inspection to check that the part is flush with the slot floor before closing the cover. This view looks into the front of the machine below the rails.";
        info.latch_controls =
          "Use closed jaws with the fingers pointing down. Center them over the red button and press it down. A full press releases the cover and the button stays down on its own.";
      }
      if (cell) {
        Object.assign(info, {
          budget: `${cycleBudget} moves per cycle, ${cycleBudget * 2} on the first cycle and on the first cycle after a work instruction revision change. A cycle that runs out of moves ends as it stands, without starting the machine.`,
          machine_signals:
            "machine.door_locked is the machine's door interlock switch: true when the cover is closed and latched.",
          finish:
            "finish presses cycle start, or ends a cycle with no part in the machine. Pass reject_reason (oversize, left_hand or other) when the part went to the reject bin. The machine refuses to start with the cover unlatched, the gripper inside, or the part unseated; the cycle then continues and the refusal costs one move. QC reports on the first part run under each revision in cycle_report.first_article.",
          cell: "Stations: an infeed nest (grey-green plate with four corner pins) where each part arrives; a blue cradle with two raised supports for standing a part on edge; a red reject bin; a go/no-go length gauge with a white pocket (revision A) and a yellow pocket (revision B); and the machine: a teal plate with a slot between two low walls, an adjustable back stop with an orange knob, a sliding cover on gold rails and a red latch button. Find their positions from the cameras.",
          work_instruction:
            "Call get_work_instruction for the current revision's text and drawing. finish replies say when a new revision takes effect.",
          help: `request_help(category, observation) calls a technician for the current cycle. Categories: machine_fault, debris, part_quality, other. Each visit costs ${helpSeconds} s of shift time and 0.5 points, unless it clears a machine fault you cannot clear yourself. The technician only fixes what your category names.${layout.attended ? " A person answers requests in this run; replies arrive in later tool results as help_responses." : ""}`,
          safety: `A wrist force held above ${safetyForce} N for 10 ms trips a protective stop: the move halts where it is and stop_reason is protective_stop. Each one costs 0.5. Your next command resumes. shift.protective_stops_cycle and protective_stops_shift count them.`,
          routines:
            "run_routine(code, cycles) runs your JavaScript `async function run(robot, cycle)` once per cycle, starting with the current cycle (only before its first move). cycle = {number, of, revision}. robot.act(command) performs one command and resolves to the readings (no images). await robot.readings() for current readings (it returns a promise, like every robot call). robot.ask(question, camera) pauses and asks you; answer with routine_status({answer, question_id}), which shows you that camera. robot.requestHelp(category, observation) resolves to the technician's reply. robot.handBack(message) returns control to you mid-cycle. robot.log(...) adds to the status log. Returning from run presses cycle start like finish; return {reject_reason} after binning a part. If the machine refuses to start, control returns to you mid-cycle. A thrown error returns control to you mid-cycle. A routine pauses before any cycle with a different work instruction revision. Moves count against each cycle's budget as usual. The code runs in a sandbox without network access. Poll routine_status while it runs.",
        });
      }
    }
    // Routine questions and help replies show the current scene; other replies follow the image cadence.
    const fresh = input.tool === "routine_status" || input.tool === "request_help";
    const source = image ?? (fresh ? latest.images[camera] : imageFrame.images[camera]);
    return { info, image: source?.split(",")[1] };
  }

  async function execute(input: Operation): Promise<ToolResult> {
    if (!("id" in input)) return perform(input);

    const signature = JSON.stringify(input);
    const prior = cached.get(input.id);
    if (prior) {
      return prior.signature === signature ? prior.reply : failure("Use a fresh id for a different action.");
    }
    let reply: ToolResult;
    try {
      reply = await perform(input);
    } catch (error) {
      // Physics can advance before frame capture fails. Preserve the outcome for retries.
      const message = errorMessage(error, "Simulation error.");
      status.textContent = message;
      reply = failure(message);
    }
    if (cached.size <= 2000) cached.set(input.id, { signature, reply });
    return reply;
  }

  function attach(path: string, delay = 500) {
    const url = new URL(path, location.origin);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(url);
    const attached = socket;
    attached.onopen = () => {
      if (socket === attached) connection.textContent = sessionStatus();
    };
    attached.onmessage = async (event) => {
      if (socket !== attached) return;
      const envelope = JSON.parse(event.data);
      const input = operation.safeParse(envelope.operation);
      let reply: ToolResult;
      try {
        const { moves, ended } = sim;
        reply = input.success
          ? manual.checked && "id" in input.data
            ? failure("The host is using manual controls.")
            : await execute(input.data)
          : failure("Invalid operation.");
        if (input.success && (calls.length < 240 || sim.moves !== moves || sim.ended !== ended)) {
          calls.push({
            operation: input.data,
            info: reply.info,
            error: reply.error,
            elapsed_ms: Math.round(performance.now() - startedAt),
          });
        } else {
          omittedCalls++;
        }
        if (summary)
          void saveRun(summary, undefined, {
            runId: id,
            calls,
            omittedCalls,
            routines: routineRecords(),
          }).catch(storageWarning);
      } catch (error) {
        reply = failure(errorMessage(error, "Simulation error."));
      }
      if (attached.readyState === WebSocket.OPEN)
        attached.send(JSON.stringify({ requestId: envelope.requestId, result: reply }));
    };
    attached.onclose = () => {
      if (socket !== attached) return;
      connection.textContent = "Connection lost. Reconnecting…";
      setTimeout(() => {
        if (socket === attached) attach(path, Math.min(delay * 2, 8000));
      }, delay);
    };
  }

  function useSession(session: Session) {
    sessionActive = true;
    connect.disabled = true;
    connect.hidden = true;
    connection.textContent = "Connecting…";
    endpoint.value = new URL(session.mcp, location.origin).href;
    agentPrompt.value = `Use the robo MCP server to play using Game ID ${session.gameId}. Start with get_assignment and include this game_id in every tool call.`;
    element("agent-prompt-group").hidden = false;
    element("endpoint-setup").hidden = false;
    attach(session.socket);
  }

  async function connectAgent() {
    connect.disabled = true;
    connection.textContent = "Connecting…";
    try {
      const result = await fetch("/api/runs", { method: "POST" });
      if (!result.ok) throw new Error(await result.text());
      const session = (await result.json()) as Session;
      useSession(session);
    } catch (error) {
      connection.textContent = errorMessage(error, "Connection failed.");
      connect.hidden = false;
      connect.disabled = false;
    }
  }

  connect.onclick = connectAgent;
  element<HTMLButtonElement>("copy-prompt").onclick = async () => {
    try {
      await navigator.clipboard.writeText(agentPrompt.value);
      connection.textContent = "Prompt copied. Keep this tab open while the agent runs.";
    } catch {
      agentPrompt.select();
    }
  };
  manual.onchange = () => {
    showFrame(timeline.valueAsNumber);
    if (sessionActive) connection.textContent = sessionStatus();
  };

  element<HTMLButtonElement>("share").onclick = async () => {
    try {
      await navigator.clipboard.writeText(layoutUrl(sim.layout).href);
      status.textContent = "Layout link copied.";
    } catch {
      status.textContent = `Layout link: ${layoutUrl(sim.layout).href}`;
    }
  };
  endpoint.onclick = () => endpoint.select();
  guarded.onchange = () => {
    element("guard-settings").hidden = !guarded.checked;
    for (const id of ["guard-force", "guard-speed"])
      element<HTMLInputElement>(id).disabled = !guarded.checked;
  };
  const manualAct = (command: Command) => {
    if (!controls.disabled)
      void execute({ tool: "act", id: crypto.randomUUID(), command, camera: "overhead" });
  };
  element<HTMLFormElement>("move").onsubmit = (event) => {
    event.preventDefault();
    const [x_mm, y_mm, z_mm, yaw_deg, pitch_deg, roll_deg] = fields.map((field) => field.valueAsNumber);
    const guard = guarded.checked
      ? {
          force_n: element<HTMLInputElement>("guard-force").valueAsNumber,
          speed_mm_s: element<HTMLInputElement>("guard-speed").valueAsNumber,
        }
      : undefined;
    const move = command.safeParse({
      type: "move_to",
      x_mm,
      y_mm,
      z_mm,
      yaw_deg,
      pitch_deg,
      roll_deg,
      guard,
    });
    if (move.success) manualAct(move.data);
  };
  for (const state of ["open", "close"] as const) {
    element<HTMLButtonElement>(state).onclick = () => manualAct({ type: "grip", state });
  }
  element<HTMLButtonElement>("finish").onclick = () => {
    if (!controls.disabled) void execute({ tool: "finish", id: crypto.randomUUID(), camera: "overhead" });
  };
  cameras.overhead.onclick = (event) => {
    if (controls.disabled) return;
    const box = cameras.overhead.getBoundingClientRect();
    const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, Math.round(value)));
    const u = (event.clientX - box.left) / box.width - 0.5;
    const v = 0.5 - (event.clientY - box.top) / box.height;
    fields[0].value = String(clamp(u * overheadHalfExtent.x * 2000, reach.x_mm));
    fields[1].value = String(clamp(v * overheadHalfExtent.y * 2000, reach.y_mm));
  };
  element<HTMLButtonElement>("reset-view").onclick = () => view.resetCamera();
  timeline.oninput = () => {
    stopPlayback();
    cancelMotion();
    showFrame(timeline.valueAsNumber);
  };
  playReplay.onclick = () => {
    if (playback !== undefined) {
      stopPlayback();
      cancelMotion();
      showFrame(timeline.valueAsNumber);
      return;
    }
    cancelMotion();
    let index = timeline.valueAsNumber;
    if (index >= frames.length - 1) index = 0;
    timeline.value = String(index);
    showFrame(index);
    playReplay.textContent = "Pause replay";
    playback = window.setInterval(() => {
      timeline.value = String(++index);
      const samples = frames[index].motion;
      if (samples?.length) playMotion(samples);
      showFrame(index);
      if (index >= frames.length - 1) stopPlayback();
    }, 650);
  };
  exportButton.onclick = () => {
    const data = JSON.stringify({
      version: 1,
      layout: sim.layout,
      frames: frames.map((entry) => entry.frame),
      calls,
      omitted_calls: omittedCalls,
      ...(cell && { shift: summary?.shift, routines }),
    });
    const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `robo-${sim.layout.task}-${sim.layout.seed}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (saved) {
    if (!frames.length) throw new Error("This replay has no saved frames.");
    syncTimeline();
    timeline.value = timeline.max;
    const repeat = element<HTMLAnchorElement>("repeat-run");
    repeat.href = layoutUrl(layout).href;
    repeat.hidden = false;
    showFrame(frames.length - 1);
    updateProgress();
    renderShift();
    renderRoutine();
    showInstruction(frames[frames.length - 1].frame.readings.shift?.work_instruction_revision);
  } else {
    addEventListener("pagehide", () => {
      const previous = socket;
      socket = undefined;
      previous?.close();
      sandbox.dispose();
      stopPlayback();
    });
    addEventListener("pageshow", (event) => {
      if (event.persisted) location.reload();
    });
    const firstFrame = record("Start");
    const { x_mm, y_mm, z_mm, yaw_deg, pitch_deg, roll_deg } = firstFrame.frame.readings;
    for (const [index, value] of [x_mm, y_mm, z_mm, yaw_deg, pitch_deg, roll_deg].entries()) {
      fields[index].value = String(value);
    }
    void firstFrame.saved.then(() => {
      if (element("save-warning").hidden) history.replaceState(null, "", runUrl(id));
    });
    element("manual-panel").hidden = false;
    element("agent-panel").hidden = false;
    void connectAgent();
  }
}

if (runId) {
  start(runId).catch((error) => {
    page.hidden = false;
    status.textContent = errorMessage(error, "The run could not be opened.");
  });
} else {
  void showHome();
  if (initial.has("task")) setup.showModal();
  addEventListener("pageshow", (event) => {
    if (event.persisted) void showHome();
  });
}
