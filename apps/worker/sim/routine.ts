/**
 * Runs model-written cell routines. The code runs in a Web Worker created inside a sandboxed iframe
 * with an opaque origin, so it cannot reach this page's storage, the relay or the network. It talks to
 * the robot only through a MessagePort.
 */

import type { RejectReason } from "./physics";

export type RoutineCalls = {
  act(command: unknown): Promise<unknown>;
  readings(): unknown;
  ask(question: string, camera: string): Promise<string>;
  requestHelp(category: string, observation: string): Promise<string>;
  log(line: string): void;
};

export type CycleOutcome =
  | { kind: "done"; rejectReason?: RejectReason }
  | { kind: "handed_back"; message: string }
  | { kind: "error"; message: string }
  | { kind: "timeout" }
  | { kind: "stopped" };

/** A robot call must arrive at least this often, or the routine is presumed stuck. */
const watchdogMs = 20_000;

const workerSource = `
"use strict";
for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "indexedDB", "caches", "importScripts", "BroadcastChannel", "Worker"]) {
  try { Object.defineProperty(self, name, { value: undefined, configurable: false }); } catch {}
}
const pending = new Map();
let sequence = 0;
const call = (method, ...args) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  postMessage({ type: "call", id, method, args });
});
const robot = Object.freeze({
  act: (command) => call("act", command),
  readings: () => call("readings"),
  ask: (question, camera = "overhead") => call("ask", String(question), String(camera)),
  requestHelp: (category, observation = "") => call("requestHelp", String(category), String(observation)),
  handBack: (message = "") => call("handBack", String(message)),
  log: (...parts) => postMessage({ type: "log", text: parts.map((part) => typeof part === "string" ? part : JSON.stringify(part)).join(" ").slice(0, 500) }),
});
onmessage = async (event) => {
  const message = event.data;
  if (message.type === "reply") {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (!entry) return;
    if (message.error) entry.reject(new Error(message.error));
    else entry.resolve(message.value);
    return;
  }
  if (message.type !== "run") return;
  try {
    const run = new Function(message.code + "\\n;return typeof run === 'function' ? run : undefined;")();
    if (typeof run !== "function") throw new Error("Define async function run(robot, cycle).");
    const result = await run(robot, message.cycle);
    postMessage({ type: "done", rejectReason: result && typeof result === "object" ? String(result.reject_reason ?? "") : "" });
  } catch (error) {
    postMessage({ type: "error", message: String(error && error.stack || error).slice(0, 1500) });
  }
};
`;

// Blob workers inherit this policy, which blocks every network fetch, socket and remote import.
const frameSource = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:"><script>
let worker;
onmessage = (event) => {
  const port = event.ports[0];
  if (!port || event.data !== "robo-routine") return;
  port.onmessage = (inner) => {
    const message = inner.data;
    if (message.type === "start") {
      worker?.terminate();
      worker = new Worker(URL.createObjectURL(new Blob([message.source], { type: "text/javascript" })));
      // Tag everything this worker sends with its run, so late messages from a finished cycle are dropped.
      const run = message.run;
      worker.onmessage = (reply) => port.postMessage({ ...reply.data, run });
      worker.onerror = (error) => {
        error.preventDefault();
        port.postMessage({ type: "error", message: error.message || "Routine error.", run });
      };
      worker.postMessage({ type: "run", code: message.code, cycle: message.cycle });
    } else if (message.type === "reply") {
      worker?.postMessage(message);
    } else if (message.type === "stop") {
      worker?.terminate();
      worker = undefined;
    }
  };
  port.postMessage({ type: "ready" });
};
</script>`;

export class RoutineSandbox {
  private frame?: HTMLIFrameElement;
  private port?: MessagePort;
  private finishCycle?: (outcome: CycleOutcome) => void;
  private runs = 0;

  private async connect() {
    if (this.port) return this.port;
    const frame = document.createElement("iframe");
    frame.sandbox.add("allow-scripts");
    frame.hidden = true;
    frame.srcdoc = frameSource;
    const loaded = new Promise<void>((resolve) => {
      frame.onload = () => resolve();
    });
    document.body.append(frame);
    await loaded;
    const channel = new MessageChannel();
    const ready = new Promise<void>((resolve) => {
      channel.port1.onmessage = (event) => {
        if (event.data?.type === "ready") resolve();
      };
    });
    frame.contentWindow?.postMessage("robo-routine", "*", [channel.port2]);
    await ready;
    this.frame = frame;
    this.port = channel.port1;
    return this.port;
  }

  /** Run one cycle of the routine. Resolves when it returns, throws, hands back, stalls or is stopped. */
  async runCycle(code: string, cycle: unknown, calls: RoutineCalls): Promise<CycleOutcome> {
    const port = await this.connect();
    const run = ++this.runs;
    return new Promise<CycleOutcome>((resolve) => {
      let watchdog = 0;
      // Calls waiting on a person or the model (ask, requestHelp) pause the watchdog until all resolve.
      let waiting = 0;
      // Calls that resume after this cycle settles must not touch the port, which a later cycle may own.
      let settled = false;
      const arm = () => {
        clearTimeout(watchdog);
        if (!waiting && !settled) watchdog = window.setTimeout(() => settle({ kind: "timeout" }), watchdogMs);
      };
      const settle = (outcome: CycleOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        port.onmessage = null;
        if (this.finishCycle === settle) this.finishCycle = undefined;
        // Terminate the worker even after a normal return, so leftover timers cannot act in the next cycle.
        port.postMessage({ type: "stop" });
        resolve(outcome);
      };
      this.finishCycle = settle;
      const reply = (id: number, value: unknown, error?: string) =>
        port.postMessage({ type: "reply", id, value, error });
      port.onmessage = async (event) => {
        const message = event.data;
        if (message.run !== run) return;
        if (message.type === "done") {
          const reason = String(message.rejectReason ?? "");
          return settle({
            kind: "done",
            ...(["oversize", "left_hand", "other"].includes(reason) && {
              rejectReason: reason as RejectReason,
            }),
          });
        }
        if (message.type === "error") return settle({ kind: "error", message: String(message.message) });
        if (message.type === "log") return calls.log(String(message.text));
        if (message.type !== "call") return;
        const { id, method, args } = message as { id: number; method: string; args: unknown[] };
        arm();
        if (method === "handBack") return settle({ kind: "handed_back", message: String(args[0] ?? "") });
        const waits = method === "ask" || method === "requestHelp";
        if (waits) waiting++;
        arm();
        let value: unknown;
        let failure: string | undefined;
        try {
          value =
            method === "act"
              ? await calls.act(args[0])
              : method === "readings"
                ? calls.readings()
                : method === "ask"
                  ? await calls.ask(String(args[0]), String(args[1]))
                  : method === "requestHelp"
                    ? await calls.requestHelp(String(args[0]), String(args[1]))
                    : undefined;
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
        if (waits) waiting--;
        if (settled) return;
        arm();
        reply(id, value, failure);
      };
      arm();
      port.postMessage({ type: "start", source: workerSource, code, cycle, run });
    });
  }

  stop() {
    this.finishCycle?.({ kind: "stopped" });
  }

  dispose() {
    this.stop();
    this.frame?.remove();
    this.frame = undefined;
    this.port = undefined;
  }
}
