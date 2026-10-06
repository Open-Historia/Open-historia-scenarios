// The checks, run in a process of their own.
//
// check.mjs is what a file is checked with. A run does not call it directly:
// it hands each file to check-worker.mjs, a second `node` running the same
// code, and waits for the verdict. The reason is the one the SVG renderer has
// a process of its own for (svg.mjs), a level up: a file is written by whoever
// posts it, and a hundred megabytes of "[{},{},{},...]" need more memory to
// read than a machine has. That does not throw, it ends the process; and a
// run that ended on one post's file would end on it again half an hour later,
// and the hub would stand still for everyone until someone took the post
// down. So:
//
//   - a file whose check takes more memory than the checker is given, or more
//     than a few minutes, is refused, with a sentence that says so; the
//     checker is started again for the next file;
//   - the checker runs with no token and in an empty folder: it is given
//     bytes and gives back a verdict and bytes;
//   - a fault of the checks' own (an exception) comes back as an Error, as it
//     would from check.mjs, and the run treats it as it always did: not the
//     author's problem, tried again next time.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FrameReader, writeFrames } from "./frames.mjs";

const WORKER = fileURLToPath(new URL("./check-worker.mjs", import.meta.url));

// What one file's check may take. The largest files on the hub (70 MB of
// JSON, a 20 MB .zip) take from two to five seconds and well under a gigabyte.
export const CHECK_MINUTES = 3;
export const CHECK_MEMORY_MB = 3072;

// Why a file's check was stopped: the words finish "<the file> can't be used: ".
class Stopped extends Error {}
const TOO_MUCH_MEMORY = "checking it takes more memory than the hub has for one file, far more than any file the game makes";

let emptyFolder = null;
const workFolder = () => {
  if (!emptyFolder) {
    emptyFolder = fs.mkdtempSync(path.join(os.tmpdir(), "hub-check-"));
    process.once("exit", () => {
      try {
        fs.rmdirSync(emptyFolder);
      } catch {
        // Still the folder of a checker that has not gone yet: left behind, empty.
      }
    });
  }
  return emptyFolder;
};

// "3 minutes", "40 seconds".
export const duration = (ms) => (ms >= 120000 ? `${Math.round(ms / 60000)} minutes` : `${Math.max(1, Math.round(ms / 1000))} second${Math.round(ms / 1000) > 1 ? "s" : ""}`);

export class Checker {
  #child = null;
  #waiting = null; // { resolve, reject, timer, header }
  #queue = Promise.resolve();
  #timeoutMs;
  #memoryMb;
  #worker;
  // The most memory a checker has said it used, in megabytes (one stopped for
  // using too much never says).
  peakMemoryMb = 0;

  // (`worker` is for the tests: a checker that fails.)
  constructor({ timeoutMs = CHECK_MINUTES * 60000, memoryMb = CHECK_MEMORY_MB, worker = WORKER } = {}) {
    this.#timeoutMs = timeoutMs;
    this.#memoryMb = memoryMb;
    this.#worker = worker;
  }

  #start() {
    const child = spawn(process.execPath, [`--max-old-space-size=${this.#memoryMb}`, this.#worker], {
      cwd: workFolder(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // The checker has no use for the token this process may hold.
      env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "", NODE_OPTIONS: "" },
    });
    const reader = new FrameReader();
    let complaint = "";
    let outOfMemory = false;
    child.stdout.on("data", (chunk) => {
      reader.push(chunk);
      for (let message = reader.take(); message; message = reader.take()) this.#received(child, message);
    });
    child.stderr.on("data", (chunk) => {
      const said = `${complaint}${chunk}`;
      // How Node ends when its memory is used up: it says so, and aborts.
      // (Looked for as it is said: a long trace follows it.)
      outOfMemory ||= /out of memory|allocation failed/i.test(said);
      complaint = said.slice(-2000);
    });
    // The process went away with a pipe still in use (it was stopped, or it
    // ended): "close" says so, and a pipe's own complaint must not end the run.
    for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe.on("error", () => {});
    const gone = (error) => {
      if (this.#child === child) this.#child = null;
      this.#fail(child, error);
    };
    child.on("error", (error) => gone(new Error(`the checker could not be started: ${error?.message || error}`)));
    // "close", not "exit": by then everything it wrote has been read, so an
    // answer it gave just before leaving is not taken for a failure.
    child.on("close", (code, signal) => {
      gone(outOfMemory
        ? new Stopped(TOO_MUCH_MEMORY)
        : new Error(`the checker stopped${signal ? ` (${signal})` : code ? ` (code ${code})` : ""}${complaint ? `: ${complaint.trim().slice(-600)}` : ""}`));
    });
    // While nothing is being checked the process must not keep this one alive:
    // a check in progress holds it open with its own timer instead.
    child.unref();
    for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe.unref?.();
    this.#child = child;
    return child;
  }

  #received(child, message) {
    const waiting = this.#waiting;
    if (!waiting || waiting.child !== child) return;
    if (!waiting.header) {
      try {
        waiting.header = JSON.parse(message.toString("utf8"));
      } catch {
        waiting.header = { ok: false, error: "the checker answered with something else" };
      }
      return;
    }
    this.#waiting = null;
    clearTimeout(waiting.timer);
    // After a heavy file the process says it is leaving: the next file must
    // start a new one rather than write to one that is on its way out.
    if (waiting.header.leaving && this.#child === child) this.#child = null;
    this.peakMemoryMb = Math.max(this.peakMemoryMb, Math.round((Number(waiting.header.peak) || 0) / 1024));
    if (waiting.header.ok) waiting.resolve({ header: waiting.header, bytes: message });
    else if (waiting.header.stopped === "memory") waiting.reject(new Stopped(TOO_MUCH_MEMORY));
    else waiting.reject(new Error(`the checks failed: ${String(waiting.header.error || "no reason given")}`));
  }

  #fail(child, error) {
    const waiting = this.#waiting;
    if (!waiting || waiting.child !== child) return;
    this.#waiting = null;
    clearTimeout(waiting.timer);
    waiting.reject(error);
  }

  #one(header, bytes, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = this.#child ?? this.#start();
      // (`timeoutMs`: less than a file's own time, when its post has less left.)
      const limit = Math.max(1, Math.min(this.#timeoutMs, timeoutMs ?? Infinity));
      const timer = setTimeout(() => {
        // Not asked to stop, stopped: a check that hangs is not listening.
        if (this.#child === child) this.#child = null;
        child.kill("SIGKILL");
        this.#fail(child, new Stopped(`checking it took more than ${duration(limit)}, far longer than any file the game makes`));
      }, limit);
      this.#waiting = { child, resolve, reject, timer, header: null };
      writeFrames(child.stdin, [Buffer.from(JSON.stringify(header)), bytes]);
    });
  }

  // One file at a time.
  #ask(header, bytes, timeoutMs) {
    const result = this.#queue.then(() => this.#one(header, bytes, timeoutMs));
    this.#queue = result.catch(() => {});
    return result;
  }

  // As checkPostFile (check.mjs), with `hub` (the lists posts.mjs's
  // hubAddressTest takes) where that takes a function.
  async postFile({ kind, primary, bytes, label, hub, drawingMs, timeoutMs }) {
    try {
      const answer = await this.#ask({ task: "post", kind, primary, label, hub, drawingMs }, bytes, timeoutMs);
      const result = answer.header.result ?? {};
      if (result.released === true && !answer.header.has) throw new Error("the checks released a file and gave no bytes for it");
      return {
        released: result.released === true,
        problems: Array.isArray(result.problems) ? result.problems.map(String) : [],
        repairs: Array.isArray(result.repairs) ? result.repairs.map(String) : [],
        ...(result.skip ? { skip: true } : {}),
        ...(typeof result.type === "string" ? { type: result.type } : {}),
        ...(Array.isArray(result.pixels) ? { pixels: result.pixels.map(Number) } : {}),
        ...(answer.header.has ? { bytes: answer.header.same ? bytes : answer.bytes } : {}),
      };
    } catch (error) {
      if (!(error instanceof Stopped)) throw error;
      return { released: false, problems: [`${label} can't be used: ${error.message}.`], repairs: [] };
    }
  }

  // As checkSuggestion (check.mjs).
  async suggestion({ bytes, label, hub, timeoutMs }) {
    try {
      const answer = await this.#ask({ task: "suggestion", label, hub }, bytes, timeoutMs);
      const result = answer.header.result ?? {};
      return { ok: result.ok === true, problems: Array.isArray(result.problems) ? result.problems.map(String) : [] };
    } catch (error) {
      if (!(error instanceof Stopped)) throw error;
      return { ok: false, problems: [`${label} can't be used: ${error.message}.`] };
    }
  }

  close() {
    const child = this.#child;
    this.#child = null;
    child?.stdin.end();
  }
}

let shared = null;
export const sharedChecker = () => (shared ??= new Checker());
export const closeSharedChecker = () => {
  shared?.close();
  shared = null;
};
