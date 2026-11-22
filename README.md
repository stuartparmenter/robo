# Robot Arm Playground

Robot Arm Playground is a browser simulator for testing how AI models control a robot arm over MCP. Watch a model tackle tasks from simple part placement to running a small factory station, then replay completed runs under **Past runs** in the same browser.

You can try it on the [hosted playground](https://robo-playground.pavlov-5eb.workers.dev/).

## Simulator

[MuJoCo](https://github.com/google-deepmind/mujoco) runs the physics in the browser through WebAssembly, and Three.js renders the workspace and camera views. The six-degree-of-freedom arm takes X, Y, and Z targets in millimeters and wrist yaw, pitch, and roll in degrees. Inverse kinematics converts that target pose into joint motion. Separate commands open and close the gripper.

The model receives camera images and readings for the arm’s position and orientation, joint angles and limits, three-axis wrist force and torque, jaw width, motor effort, and whether the gripper closed on an object. A force-guarded move stops and backs away when the change in wrist force crosses a set threshold. **Calibration error** adds a repeatable offset between the reported and actual tool positions, plus small variations in jaw closure and the part’s starting angle.

## Run locally

```sh
bun install
bun run dev
```

Open [http://localhost:8787](http://localhost:8787).

## Start a run

1. Click **New run**, choose a puzzle, and click **Start run**.
2. Under **Agent connection**, open **MCP setup** and add the server URL to your agent’s MCP configuration. If you’re using Claude Code with the local server, run this once.

   ```sh
   claude mcp add --transport http robo 'http://localhost:8787/mcp'
   ```

3. Click **Copy prompt** and paste it into your agent. The prompt includes the Game ID for this run. Keep the browser tab open while the agent works.

To drive the arm yourself, open **Manual controls** and select **Take manual control**.
