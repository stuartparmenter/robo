# Robot Arm Playground

Drive a six-axis articulated arm through four simulated puzzles and a multi-cycle work cell shift. Inverse kinematics maps gripper position and orientation to joint targets. Wrist position is reported to 0.1 mm. Machine loading enables contact between the arm links and the machine or table.

| Puzzle          | What it tests                                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Block transfer  | Grip, lift, and release the block upright on a marked pad.                                                                                                              |
| Peg insertion   | Align the rectangular peg with the socket and verify that it seats after release.                                                                                       |
| Keyed socket    | Match the marked corner to an asymmetric notch. Contact can push the socket along its track, so a jam can require lifting and finding the new position before retrying. |
| Machine loading | Unlatch and slide open a cover, turn the part on edge, release and regrasp it in a cradle, load it, then close and relatch.                                             |
| Work cell shift | Run a randomized cell through a stream of cycles: gauge parts, reject defects, clear faults, change over mid-shift, and optionally hand cycles to a routine you wrote.  |

For a reproducible recovery case, choose **Keyed socket**, seed **1**, fixture angle **26°**, and leave **Shift after pickup** off. Approach with the peg turned 180° from the notch and watch the socket move as insertion stalls. The replay JSON records the puzzle, seed, camera cadence, actions, observations, and final placement result.

## Run locally

```sh
bun install
bun run dev
```

Open http://localhost:8787. The homepage lists completed runs saved in this browser. Click **New run**, choose the puzzle, seed, angle and image cadence, then click **Start run**. The run page creates the MCP connection and shows the live move count. Expand **Manual controls** and select **Take manual control** to drive the arm. Agent moves pause while manual control is enabled.

Drag the 3D workspace to orbit and scroll or pinch to zoom. In manual mode, click the overhead image to set X and Y, then enter Z and wrist orientation and click **Move arm**. Lift before traversing the table. **Finish** checks whether the placement stayed stable after release. The attempt also ends at the move limit of 40, or 60 for Machine loading.

Click a past run to open the same workspace in replay mode. Play the recorded frames or scrub to a particular frame. Run history is stored in this browser. Refreshing a live run opens the saved replay, and **Run this layout again** opens a fresh attempt with the same settings. **Copy layout link** shares the setup, and **Download replay** exports the recording with images, simulator poses, and the remote tool trace. The trace preserves state changes and counts requests omitted after 240 entries.

## Connect an agent

1. Register the shared endpoint once. For Claude Code:

   ```sh
   claude mcp add --transport http robo 'http://localhost:8787/mcp'
   ```

2. Start a new run and use **Copy prompt** on the live run page. The prompt includes a new Game ID. Paste it into your agent and keep the host tab open.

Treat the Game ID as a credential for controlling that game. The endpoint stays the same across runs. If your client is configured with an older per-run URL, replace that registration with `/mcp`.

Each tool on the shared endpoint takes a `game_id`. For example, call `get_assignment` with `{"game_id":"A1B2C3D4E5F6"}` using the actual code from the page.

| Tool                   | Input                                              | Result                                                                  |
| ---------------------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| `get_assignment`       | `{}`                                               | Goal, controls, budget, measured state and overhead image               |
| `observe`              | `{"camera":"side"}` or `{"camera":"overhead"}`     | Measured state and selected image without advancing time                |
| `act`                  | Fresh UUID in `id`, a `command`, optional `camera` | Advances fixed simulation ticks and returns measured state and an image |
| `finish`               | Fresh UUID in `id`, optional `camera`              | Records the agent's declaration and returns the independent result      |
| `get_work_instruction` | `{}`                                               | Work cell: the current revision's text and part drawing                 |
| `request_help`         | `id`, `category`, `observation`                    | Work cell: a technician visit for the current cycle                     |
| `run_routine`          | `id`, `code`, `cycles`                             | Work cell: start a routine that runs whole cycles                       |
| `routine_status`       | Optional `wait_s`, `answer`, `stop`                | Work cell: wait for, answer, or stop the running routine                |

Move commands use `{"type":"move_to","x_mm":0,"y_mm":-90,"z_mm":155,"yaw_deg":0}`. Optional `pitch_deg` and `roll_deg` (each −90 to 90) tilt the tool after yaw. Omitting them sets them to zero. Jaw commands use `{"type":"grip","state":"close"}` or `"open"`, and `open` takes an optional `width_mm` (14–84) to open partway. Closing squeezes with a set force at any width, like an electric parallel gripper. Reuse the same UUID and arguments when retrying a mutation. With **Every 3 moves**, both `act` and `observe` return an image from the latest eligible tick and fresh numerical readings. Compare `image_tick` with `tick` to tell when an image is stale.

The Worker serves the page and the MCP endpoint. One Durable Object per session relays commands to the host over WebSocket. The host owns MuJoCo, renders its geometry via Three.js and returns the requested JPEG and gripper readings. It advances simulated time only on actions. A transient connection loss can reconnect to the same running tab. Closing or reloading the tab ends the live simulation. Its saved frames remain available from run history.

## Force and controller feedback

MCP and frame telemetry report the world-XYZ wrist force in newtons and torque in newton-metres, tared for the empty gripper. The readings include payload and contact effects. Gripper telemetry reports jaw width, a single motor effort, and `object_detected` when the closing jaws stall before their closed position, as a typical electric parallel gripper does. Controller telemetry includes angles, limits, and the reason the last move stopped. Readings are limited to what a real arm, gripper and wrist sensor would provide: there is no tactile contact, slip detection, or latch button telemetry, so the agent infers these from the camera, jaw width and wrist force. In the work cell, the machine's door interlock reports `machine.door_locked` (closed and locked, or not), as a machine-tending I/O handshake would.

Add `"guard":{"force_n":2,"speed_mm_s":25}` to a `move_to`, or use **Stop on force** in manual controls. It moves at the requested speed for up to four seconds, monitors the change from its starting wrist force, and stops and backs away when the threshold is reached. The threshold triggers the simulated response and some force overshoot is possible.

Enable **Calibration error** for a repeatable, seed-dependent offset between the reported and physical tool positions, a slight jaw closure asymmetry, and variation in the part's starting angle. Leave it off for the existing reference routes.

## Machine-loading benchmark

Odd seeds open toward +X and even seeds toward −X, along the exposed gold rails. Press the red latch until it stays down on its own, then grip the handle to move the cover. The two raised blue supports share one cradle base. The seed and **Part rotation** setting vary the starting part pose. The simulator checks that the part settled on edge in the blue cradle, then independently scores its final seating and the latched cover after release. When the cover closes, the latch springs up to lock it. Pressing it again unlocks it. The final result includes a checklist in the UI, replay export, and MCP response. It reports slot depth, centering, and alignment separately. Use `observe({"camera":"inspection"})` for a close-up view into the slot before closing the cover.

Run the reference route with `bun tooling/benchmark-machine.ts 1 2 7 42`. It uses exact fixture coordinates and the same gripper commands as MCP. Its move count is a verified upper bound for those layouts. Start agent attempts in fresh conversations and keep the reference route outside the agent’s workspace if you want it to solve from camera and gripper feedback.

## Work cell shift

The work cell tests running a production cell rather than a single manipulation. Each seed randomizes the cell layout: which side the machine opens to, where the machine sits, the order of the infeed nest, staging cradle and reject bin along the front, the nest's orientation, and the gauge's position. A shift is a stream of cycles (8 by default). Each cycle a part arrives in the nest and the agent follows the current work instruction:

- Gauge the part's length in the go/no-go gauge. A conforming part drops into the pocket for the current revision; an oversize part perches on the lead-ins.
- Reject oversize parts and left-hand parts, which carry a mirrored "F" marking, by putting them in the red bin.
- Load conforming parts on edge in the machine against an adjustable back stop. The stop is clamped until the gripper squeezes its knob, and it must sit on the marks for the current revision.
- Close the cover so the latch locks, then call `finish` to press cycle start. For a rejected part, `finish` takes a `reject_reason` (`oversize`, `left_hand` or `other`).

Every eight-cycle shift includes one oversize part, one left-hand part, a metal chip left in the slot, and one machine fault that only a technician can clear (a seized cover or a latch that will not release). It also includes a changeover from revision A (68 mm parts, white pocket and marks) to revision B (76 mm, yellow) partway through. Cycle 1 is always normal. Each cycle has its own 60-move budget, doubled to 120 on cycle 1 and on the first cycle after a revision change so the agent has room to learn the cell and set up. A cycle that runs out of moves ends where it stands without starting the machine, so it counts as unfinished. The next part is fed into the nest only once the fingers are clear of it, and a cycle counts as released only if the jaws are no longer holding the part.

The machine checks what its own sensors can see before it starts: the cover is closed and latched, the gripper is out, and the part is seated against the stop. If any fails, it refuses cycle start, the refusal costs one move, and the cycle continues so the agent can fix it. It cannot see the stop's position, centring or a chip, so a part run with those wrong is scrap. QC inspects the first part run under each revision and reports "in spec" or what was out of spec in that cycle's `first_article`.

A wrist force held above 30 N for 10 ms trips a protective stop. The move halts where it is, `stop_reason` is `protective_stop`, and the next command resumes. Another stop can trip only after the force has stayed below 20 N for 100 ms. The `shift` readings count stops for the cycle and the shift.

Scoring follows plant metrics, and the agent is told the formula in `get_assignment`:

- **Per cycle:** a conforming part loaded and run correctly, or a nonconforming part rejected with the right reason, earns 1; a bin reject with a missing or wrong reason earns 0.5. An escape (a nonconforming part loaded and run) costs 3. Scrap (a good part run with the stop off its marks, off centre, or with a chip in the slot) costs 1. False rejects and unfinished cycles earn 0.
- **Per shift:** each protective stop costs 0.5, and so does each technician visit, except one that clears a machine fault the agent cannot clear itself.

The shift score is the total divided by the number of cycles, so 1.0 is perfect. Time and model calls are reported but not scored. The run page shows model calls per cycle, how many cycles a routine finished, and the wall-clock time alongside the simulated motion time. The agent sees only what the machine and QC would report; escapes and the correctness of rejects stay hidden from it. The run page shows the full table, including each cycle's hidden condition.

`request_help` sends a technician who fixes the problem only when the category matches what is actually wrong (`machine_fault`, `debris`, `part_quality` or `other`). Every visit adds 90 seconds to the cycle time and, unless it clears a machine fault, costs 0.5 points. With **A person answers help requests** checked, a banner on the run page lets a person send the technician, reply with text, or decline. Replies reach the agent in its next tool result as `help_responses`. Attended runs are labelled in run history.

`run_routine` is "commission, then run": once the agent understands the cell, it can submit JavaScript defining `async function run(robot, cycle)`, and the page runs it once per cycle without the model. `robot.act` and `robot.readings` drive and read the arm (both return promises), `robot.ask(question, camera)` pauses to ask the agent (which sees that camera through `routine_status` and answers with the question's `question_id`), `robot.requestHelp` calls a technician, and `robot.handBack(message)` returns control mid-cycle. Returning from `run` presses cycle start; it can return `{reject_reason}` after binning a part, and a refused start hands control back. A routine pauses before any cycle with a new work instruction revision. Routine code runs in a Web Worker inside a sandboxed iframe with an opaque origin, without network or storage access, and a watchdog stops a routine that makes no robot call for 20 seconds.

Run the reference route with `bun tooling/benchmark-cell.ts 1 2 3`. It uses exact simulator state to prove that every cycle condition on those seeds can be solved within the move budget, and it should report a score of 1 for each seed.

## Check and deploy

```sh
bun run check
bun run typecheck
bun test
bun run deploy
```

The deployment command uses your Wrangler Cloudflare account and provisions the SQLite Durable Object through the migration in `apps/worker/wrangler.jsonc`. Wrangler builds the browser bundle and stages the single-threaded MuJoCo assets automatically.
