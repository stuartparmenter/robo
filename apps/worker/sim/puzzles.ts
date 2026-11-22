import type { Layout } from "./physics";

type Puzzle = {
  title: string;
  description: string;
  steps?: string[];
  success: string;
  goal: string;
  criteria: string;
};

export const puzzle: Record<Layout["task"], Puzzle> = {
  peg: {
    title: "Peg insertion",
    description: "Pick up a rectangular peg and fit it into the matching hole.",
    success: "The peg reaches the bottom of the hole and stays there when the gripper lets go.",
    goal: "Pick up the peg, align it with the socket, and release it once seated.",
    criteria:
      "Peg seated at the socket floor, approximately aligned, released and stationary for 250 simulated milliseconds.",
  },
  block: {
    title: "Block transfer",
    description: "Move a block from the table to a marked pad.",
    success: "The block stands upright in the center of the pad and stays put when the gripper lets go.",
    goal: "Pick up the block and release it upright in the center of the marked pad.",
    criteria: "Block centered on the pad, upright, released and stationary for 250 simulated milliseconds.",
  },
  keyed: {
    title: "Keyed socket",
    description:
      "Line up the peg’s marked corner with the notch in the hole. If the holder slides, find its new position before trying again.",
    success: "The peg rests at the bottom with its tab in the notch and stays there after release.",
    goal: "Match the peg’s marked corner to the socket notch. The socket can slide when pushed. Check its position again after contact.",
    criteria:
      "Keyed peg seated at the socket floor with the tab in the matching notch, released and stationary for 250 simulated milliseconds.",
  },
  machine: {
    title: "Machine loading",
    description:
      "Press the red latch and slide the cover open. Stand the orange part on its edge in the blue holder, let go, then pick it back up and put it in the machine’s slot.",
    success:
      "The part rests fully in the slot on its edge, the gripper has released it, and the cover is closed and locked.",
    goal: "Press the red latch until it stays down on its own. Grip the handle and slide the cover along X toward the exposed gold rails. Stand the orange part on edge across both supports of the blue cradle, release and regrasp it, then load the machine and close the cover. Closing it lets the latch spring back up and lock. Leave it up.",
    criteria:
      "The part was released on edge in the blue cradle, then loaded on edge in the machine. Finish with the part released, cover closed, and latch engaged.",
  },
  cell: {
    title: "Work cell shift",
    description: "Run a small factory station for a whole shift. A new part arrives each round.",
    steps: [
      "Check each part against the worksheet. Put parts that are too long or marked with a backwards F in the red bin.",
      "Load and run good parts. Clear anything blocking the slot, and call a technician for faults the arm can’t fix.",
      "When the worksheet changes, use the new size guide and adjust the machine to hold the new part size.",
      "Once the model knows the setup, it can write code and run it in a sandbox to handle repeat cycles on its own.",
    ],
    success:
      "A perfect shift scores 1.0. Every good part runs correctly, every bad part is rejected for the right reason, and the arm avoids safety stops and unnecessary technician visits.",
    goal: "Run a shift in this single-arm work cell. Each cycle a part arrives in the infeed nest. Follow the current work instruction: check the part, put nonconforming parts in the red reject bin, or load conforming parts into the machine and close it. Call finish to end each cycle. The work instruction can change during the shift.",
    criteria:
      "Score per cycle: a conforming part loaded and run correctly, or a nonconforming part rejected in the bin with the right reject_reason, +1 (a bin reject with a missing or wrong reason +0.5). A nonconforming part run in the machine (escape) −3. A conforming part run with the stop off its marks, off centre, or with debris in the slot (scrap) −1. A false reject or unfinished cycle 0. Each protective stop −0.5. Each technician visit −0.5, except one that clears a machine fault you cannot clear yourself. Shift score = total ÷ cycles. Time and model calls are reported, not scored. The machine reports only what its own sensors can see.",
  },
};
