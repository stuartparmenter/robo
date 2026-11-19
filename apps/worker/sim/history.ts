import type { Camera, Operation } from "../src/protocol";
import type { Layout, Simulation } from "./physics";
import type { FieldPose } from "./view";

export type Frame = {
  label: string;
  /** Zero-based work cell cycle the frame belongs to. */
  cycle?: number;
  readings: ReturnType<Simulation["readings"]>;
  poses: { qpos: number[]; mocap_pos: number[]; mocap_quat: number[] };
  images: Record<Exclude<Camera, "inspection">, string> & { inspection?: string };
};

export type RecordedCall = {
  operation: Operation;
  info: Record<string, unknown>;
  error?: string;
  elapsed_ms: number;
};

export type RunSummary = {
  id: string;
  createdAt: number;
  layout: Layout;
  moves: number;
  budget: number;
  thumbnail: string;
  result: "passed" | "failed" | "unfinished";
  /** Work cell shift metrics, saved so replays can show them. */
  shift?: ReturnType<Simulation["shiftSummary"]>;
};

export type RunFrame = {
  runId: string;
  index: number;
  frame: Frame;
  perspective: FieldPose;
  motion?: FieldPose[];
};
export type RoutineRecord = {
  code: string;
  cycles: number;
  status: string;
  message?: string;
  log: string[];
  cyclesDone?: number;
  reports?: unknown[];
};
type RunTrace = { runId: string; calls: RecordedCall[]; omittedCalls: number; routines?: RoutineRecord[] };

let database: Promise<IDBDatabase> | undefined;

function openDatabase() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("robo-run-history", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("runs", { keyPath: "id" });
      db.createObjectStore("frames", { keyPath: ["runId", "index"] }).createIndex("runId", "runId");
      db.createObjectStore("traces", { keyPath: "runId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function listRuns() {
  const db = await openDatabase();
  const runs: RunSummary[] = await result(db.transaction("runs").objectStore("runs").getAll());
  return runs.sort((a, b) => b.createdAt - a.createdAt);
}

export async function loadRun(id: string) {
  const db = await openDatabase();
  const tx = db.transaction(["runs", "frames", "traces"]);
  const [summary, frames, trace] = await Promise.all([
    result<RunSummary | undefined>(tx.objectStore("runs").get(id)),
    result<RunFrame[]>(tx.objectStore("frames").index("runId").getAll(id)),
    result<RunTrace | undefined>(tx.objectStore("traces").get(id)),
  ]);
  return summary && { summary, frames, trace };
}

export async function saveRun(summary: RunSummary, frame?: RunFrame, trace?: RunTrace) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["runs", "frames", "traces"], "readwrite");
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.objectStore("runs").put(summary);
    if (frame) tx.objectStore("frames").put(frame);
    if (trace) tx.objectStore("traces").put(trace);
  });
}
