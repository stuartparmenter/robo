import {
  type Command,
  command,
  failure,
  type Operation,
  operation,
  reach,
  type Session,
  type ToolResult,
} from "../src/protocol";
import {
  type Frame,
  listRuns,
  loadRun,
  type RecordedCall,
  type RunFrame,
  type RunSummary,
  saveRun,
} from "./history";
import { defaultLayout, guardSeconds, type Layout, loadPhysics, Simulation } from "./physics";
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

function layoutFromInputs(): Layout {
  return {
    task: taskFromValue(task.value),
    seed: seed.valueAsNumber,
    angle: angle.valueAsNumber,
    shift: task.value !== "machine" && shift.checked,
    cadence: cadence.value === "3" ? 3 : 1,
    calibration: calibration.checked,
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
shift.checked = task.value !== "machine" && initial.get("shift") === "1";
function updateLayoutOptions() {
  shift.disabled = task.value === "machine";
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
      score.textContent = `${resultLabel[run.result]} · ${run.moves} / ${run.budget} moves · ${date}`;
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
  status.textContent = archived ? "Loading replay…" : "Loading simulator…";
  page.hidden = false;
  const mj = await physics;
  const sim = new Simulation(mj, layout);
  const view = new FieldView(sim, element<HTMLCanvasElement>("perspective"));
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
    element("move-counter").textContent = `Move ${moves} / ${budget}`;
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

  function record(label: string, samples?: FieldPose[]) {
    const frame: Frame = {
      label,
      readings: sim.readings(),
      poses: {
        qpos: Array.from(sim.data.qpos),
        mocap_pos: Array.from(sim.data.mocap_pos),
        mocap_quat: Array.from(sim.data.mocap_quat),
      },
      images: {
        overhead: view.capture(sim, "overhead"),
        side: view.capture(sim, "side"),
        ...(layout.task === "machine" && { inspection: view.capture(sim, "inspection") }),
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
    };
    updateProgress();
    return { frame, saved: saveRun(summary, entry).catch(storageWarning) };
  }

  function perform(input: Operation): ToolResult {
    if ("camera" in input && input.camera === "inspection" && layout.task !== "machine") {
      return failure("The inspection camera is available for Machine loading.");
    }
    // Readings captured by this call's frame, so they are not computed twice.
    let readings: Frame["readings"] | undefined;
    switch (input.tool) {
      case "act": {
        if (sim.ended) return failure("This run has ended.");
        const move = input.command;
        const samples: FieldPose[] = [];
        sim.act(move, () => samples.push(fieldPose(sim)));
        samples.push(fieldPose(sim));
        if (playback === undefined && timeline.value === timeline.max) playMotion(samples);
        readings = record(
          move.type === "grip"
            ? `Grip ${move.state}`
            : `Move to ${move.x_mm}, ${move.y_mm}, ${move.z_mm} mm · ${move.yaw_deg}°${move.pitch_deg || move.roll_deg ? ` / ${move.pitch_deg ?? 0}° / ${move.roll_deg ?? 0}°` : ""}`,
          samples,
        ).frame.readings;
        break;
      }
      case "finish":
        if (!sim.ended) {
          sim.finish();
          readings = record("Finish").frame.readings;
        }
        break;
    }
    const camera = input.tool === "get_assignment" ? "overhead" : input.camera;
    const info: Record<string, unknown> = {
      ...(readings ?? sim.readings()),
      camera,
      image_tick: imageFrame.readings.tick,
    };
    if (input.tool === "get_assignment") {
      Object.assign(info, {
        goal: puzzle[sim.layout.task].goal,
        success_criteria: puzzle[sim.layout.task].criteria,
        axes: "Overhead: +X right, +Y up. +Z is height above the table. Positive yaw rotates counterclockwise above +X. Pitch and roll are optional local Y and X rotations after yaw. Zero pitch and roll point the fingers down. Use mm and degrees. Z is the wrist's gripper target, 7 mm below the finger center.",
        feedback:
          "Wrist force (N) and torque (N·m) are in world XYZ and tared for the empty tool. The gripper reports jaw width, motor effort, and object_detected when the closing jaws stall on something before reaching their closed position. Joint readings report controller angles and limits. Numerical readings are fresh even if the image is stale.",
        guarded_move: `Optional move_to guard: {force_n, speed_mm_s}. Moves slowly and stops and backs away when the wrist-force vector changes by force_n N relative to the start of the move. Guarded motion is limited to ${guardSeconds} seconds of travel per action.`,
        calibration_error_enabled: Boolean(layout.calibration),
        budget: sim.moveBudget,
        image_cadence: sim.layout.cadence,
      });
      if (layout.task === "machine") {
        info.inspection_camera =
          "Use observe with camera inspection to check that the part is flush with the slot floor before closing the cover. This view looks into the front of the machine below the rails.";
        info.latch_controls =
          "Use closed jaws with the fingers pointing down. Center them over the red button and press it down. A full press releases the cover and the button stays down on its own.";
      }
    }
    return { info, image: imageFrame.images[camera]?.split(",")[1] };
  }

  function execute(input: Operation): ToolResult {
    if (!("id" in input)) return perform(input);

    const signature = JSON.stringify(input);
    const prior = cached.get(input.id);
    if (prior) {
      return prior.signature === signature ? prior.reply : failure("Use a fresh id for a different action.");
    }
    let reply: ToolResult;
    try {
      reply = perform(input);
    } catch (error) {
      // Physics can advance before frame capture fails. Preserve the outcome for retries.
      const message = errorMessage(error, "Simulation error.");
      status.textContent = message;
      reply = failure(message);
    }
    if (cached.size <= sim.moveBudget + 1) cached.set(input.id, { signature, reply });
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
    attached.onmessage = (event) => {
      if (socket !== attached) return;
      const envelope = JSON.parse(event.data);
      const input = operation.safeParse(envelope.operation);
      let reply: ToolResult;
      try {
        const { moves, ended } = sim;
        reply = input.success
          ? manual.checked && "id" in input.data
            ? failure("The host is using manual controls.")
            : execute(input.data)
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
          void saveRun(summary, undefined, { runId: id, calls, omittedCalls }).catch(storageWarning);
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
    if (!controls.disabled) execute({ tool: "act", id: crypto.randomUUID(), command, camera: "overhead" });
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
    if (!controls.disabled) execute({ tool: "finish", id: crypto.randomUUID(), camera: "overhead" });
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
  } else {
    addEventListener("pagehide", () => {
      const previous = socket;
      socket = undefined;
      previous?.close();
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
