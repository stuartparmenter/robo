# Robot Arm Playground

Drive a six-axis articulated arm through four simulated puzzles. Inverse kinematics maps gripper position and orientation to joint targets. Wrist position is reported to 0.1 mm. Machine loading enables contact between the arm links and the machine or table.

| Puzzle          | What it tests                                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Block transfer  | Grip, lift, and release the block upright on a marked pad.                                                                                                              |
| Peg insertion   | Align the rectangular peg with the socket and verify that it seats after release.                                                                                       |
| Keyed socket    | Match the marked corner to an asymmetric notch. Contact can push the socket along its track, so a jam can require lifting and finding the new position before retrying. |
| Machine loading | Unlatch and slide open a cover, turn the part on edge, release and regrasp it in a cradle, load it, then close and relatch.                                             |

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

| Tool             | Input                                              | Result                                                                  |
| ---------------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| `get_assignment` | `{}`                                               | Goal, controls, budget, measured state and overhead image               |
| `observe`        | `{"camera":"side"}` or `{"camera":"overhead"}`     | Measured state and selected image without advancing time                |
| `act`            | Fresh UUID in `id`, a `command`, optional `camera` | Advances fixed simulation ticks and returns measured state and an image |
| `finish`         | Fresh UUID in `id`, optional `camera`              | Records the agent's declaration and returns the independent result      |

Move commands use `{"type":"move_to","x_mm":0,"y_mm":-90,"z_mm":155,"yaw_deg":0}`. Optional `pitch_deg` and `roll_deg` (each −90 to 90) tilt the tool after yaw. Omitting them sets them to zero. Jaw commands use `{"type":"grip","state":"close"}` or `"open"`. Reuse the same UUID and arguments when retrying a mutation. With **Every 3 moves**, both `act` and `observe` return an image from the latest eligible tick and fresh numerical readings. Compare `image_tick` with `tick` to tell when an image is stale.

The Worker serves the page and the MCP endpoint. One Durable Object per session relays commands to the host over WebSocket. The host owns MuJoCo, renders its geometry via Three.js and returns the requested JPEG and gripper readings. It advances simulated time only on actions. A transient connection loss can reconnect to the same running tab. Closing or reloading the tab ends the live simulation. Its saved frames remain available from run history.

## Force and controller feedback

MCP and frame telemetry report the world-XYZ wrist force in newtons and torque in newton-metres, tared for the empty gripper. The readings include payload and contact effects. Gripper telemetry reports left and right actuator effort and flags when a held workpiece slides or loses bilateral contact. Controller telemetry includes angles, limits, and the reason the last move stopped.

Add `"guard":{"force_n":2,"speed_mm_s":25}` to a `move_to`, or use **Stop on force** in manual controls. It moves at the requested speed for up to four seconds, monitors the change from its starting wrist force, and stops and backs away when the threshold is reached. The threshold triggers the simulated response and some force overshoot is possible.

Enable **Calibration error** for a repeatable, seed-dependent offset between the reported and physical tool positions, a slight jaw closure asymmetry, and variation in the part's starting angle. Leave it off for the existing reference routes.

## Machine-loading benchmark

Odd seeds open toward +X and even seeds toward −X, along the exposed gold rails. Press the red latch until it stays down on its own, then grip the handle to move the cover. The two raised blue supports share one cradle base. The seed and **Part rotation** setting vary the starting part pose. The simulator checks that the part settled on edge in the blue cradle, then independently scores its final seating and the latched cover after release. When the cover closes, the latch springs up to lock it. Pressing it again unlocks it. The final result includes a checklist in the UI, replay export, and MCP response. It reports slot depth, centering, and alignment separately. Use `observe({"camera":"inspection"})` for a close-up view into the slot before closing the cover.

Run the reference route with `bun tooling/benchmark-machine.ts 1 2 7 42`. It uses exact fixture coordinates and the same gripper commands as MCP. Its move count is a verified upper bound for those layouts. Start agent attempts in fresh conversations and keep the reference route outside the agent’s workspace if you want it to solve from camera and gripper feedback.

## Check and deploy

```sh
bun run check
bun run typecheck
bun test
bun run deploy
```

The deployment command uses your Wrangler Cloudflare account and provisions the SQLite Durable Object through the migration in `apps/worker/wrangler.jsonc`. Wrangler builds the browser bundle and stages the single-threaded MuJoCo assets automatically.
