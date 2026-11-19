import { lengthTolerance, markBars, partThickness, partWidth, type Revision, revisions } from "./cell";

const width = 760;
const height = 520;

/** Render the work instruction's part drawing as a JPEG data URL. */
export function drawWorkInstruction(revision: Revision) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const pen = canvas.getContext("2d");
  if (!pen) throw new Error("Canvas 2D is unavailable.");
  const rev = revisions[revision];
  const ink = "#1d2327";
  pen.fillStyle = "#f4f1e8";
  pen.fillRect(0, 0, width, height);
  pen.strokeStyle = ink;
  pen.fillStyle = ink;
  pen.lineWidth = 2;
  pen.strokeRect(12, 12, width - 24, height - 24);
  pen.font = "bold 20px monospace";
  pen.fillText(`WORK INSTRUCTION  ·  BRACKET BLANK  ·  REV ${revision}`, 30, 46);
  pen.font = "15px monospace";
  pen.fillText("TOP VIEW (marked face up), RIGHT-HAND PART. 4 px = 1 mm.", 30, 72);

  // Top view: X across, Y up the page, scaled 4 px/mm and centred.
  const scale = 4000;
  const cx = 230;
  const cy = 290;
  const w = partWidth * scale;
  const l = rev.nominal * scale;
  pen.lineWidth = 2.5;
  pen.strokeRect(cx - w / 2, cy - l / 2, w, l);
  for (const [x, y, hx, hy] of markBars(false)) {
    pen.fillRect(cx + (x - hx) * scale, cy - (y + hy) * scale, hx * 2 * scale, hy * 2 * scale);
  }

  // Dimensions.
  pen.lineWidth = 1.2;
  const dimX = cx + w / 2 + 40;
  pen.beginPath();
  pen.moveTo(cx + w / 2 + 6, cy - l / 2);
  pen.lineTo(dimX + 8, cy - l / 2);
  pen.moveTo(cx + w / 2 + 6, cy + l / 2);
  pen.lineTo(dimX + 8, cy + l / 2);
  pen.moveTo(dimX, cy - l / 2);
  pen.lineTo(dimX, cy + l / 2);
  const dimY = cy + l / 2 + 34;
  pen.moveTo(cx - w / 2, cy + l / 2 + 6);
  pen.lineTo(cx - w / 2, dimY + 8);
  pen.moveTo(cx + w / 2, cy + l / 2 + 6);
  pen.lineTo(cx + w / 2, dimY + 8);
  pen.moveTo(cx - w / 2, dimY);
  pen.lineTo(cx + w / 2, dimY);
  pen.stroke();
  pen.font = "bold 16px monospace";
  pen.fillText(
    `${(rev.nominal * 1000).toFixed(1)} ±${(lengthTolerance * 1000).toFixed(1)}`,
    dimX + 14,
    cy + 6,
  );
  pen.fillText(`${partWidth * 1000}`, cx - 10, dimY + 26);

  // Notes.
  pen.font = "15px monospace";
  const notes = [
    `THICKNESS ${partThickness * 1000} mm.`,
    `LENGTH ${(rev.nominal * 1000).toFixed(1)} ±${(lengthTolerance * 1000).toFixed(1)} mm.`,
    `GO/NO-GO: ${rev.color.toUpperCase()} POCKET.`,
    `  Conforming parts drop flat`,
    `  onto the pocket floor.`,
    `BACK STOP: ${rev.color.toUpperCase()} MARKS.`,
    `LOAD ON THE 18 mm EDGE, LENGTH`,
    `  ALONG THE SLOT, AGAINST THE STOP.`,
    `MIRRORED MARKING = LEFT-HAND`,
    `  PART. REJECT IT.`,
  ];
  for (const [i, note] of notes.entries()) pen.fillText(note, 420, 120 + i * 26);
  return canvas.toDataURL("image/jpeg", 0.9);
}
