// Checks files, in a process of its own (see checker.mjs, which starts it and
// talks to it). A file is whatever its author made it: one written to need
// more memory than the machine has ends the process that reads it, rather
// than throwing, and one written to be slow keeps it busy. Here that costs
// this process and that one file, and the run that asked goes on to the next.
// This process is given no token and no address to fetch: bytes come in, a
// verdict and the checked bytes go out.
//
// In:  two messages per file: JSON { task, kind, primary, label, hub,
//      drawingMs }, then the file's bytes
// Out: two messages per file: JSON { ok: true, result, has, same } or
//      { ok: false, error } or { ok: false, stopped: "memory" }, each with
//      `leaving` and `peak` (the most memory this process has used, in KB),
//      then the checked bytes (none when the file is released as it came,
//      `same`, or is not released at all)
// (frames.mjs says what a message is.)

import { Worker } from "node:worker_threads";

import { checkPostFile, checkSuggestion } from "./check.mjs";
import { FrameReader, writeFrames } from "./frames.mjs";
import { hubAddressTest } from "./posts.mjs";
import { closeSharedRasteriser } from "./svg.mjs";

// All the memory this process may use, whatever it is used for. What its
// JavaScript holds has a limit already (--max-old-space-size, which checker.mjs
// sets), but not everything is held there: the bytes of files are not, nor
// what the parts of Node written in C++ keep for themselves. The checks run on
// the main thread and do not pause to look, so the watch is kept on a thread
// of its own; it says why on the way out, in the words checker.mjs looks for.
const MEMORY_LIMIT = (Number(process.env.HUB_CHECK_RSS_MB) || 5120) * 1024 * 1024;
new Worker(
  `const { workerData } = require("node:worker_threads");
  const fs = require("node:fs");
  setInterval(() => {
    if (process.memoryUsage.rss() <= workerData.limit) return;
    try { fs.writeSync(2, "out of memory: more than the checker may use\\n"); } catch {}
    process.kill(process.pid, "SIGKILL");
  }, 50);`,
  { eval: true, workerData: { limit: MEMORY_LIMIT } },
).unref();

// After a file this heavy the process is not kept: the next one starts with
// all of its memory to itself.
const KEEP_BELOW = (Number(process.env.HUB_CHECK_KEEP_MB) || 1024) * 1024 * 1024;
const NOTHING = Buffer.alloc(0);
const tooLarge = (error) => (error instanceof RangeError && /invalid (?:string|array|typed array) length|allocation failed/i.test(String(error.message)))
  || ["ERR_STRING_TOO_LONG", "ERR_BUFFER_TOO_LARGE", "ERR_MEMORY_ALLOCATION_FAILED"].includes(error?.code);

const check = async (request, bytes) => {
  const isHubAddress = hubAddressTest(request.hub);
  if (request.task === "suggestion") return { header: { ok: true, result: await checkSuggestion({ bytes, label: request.label, isHubAddress }) } };
  const { bytes: checked, ...result } = await checkPostFile({ kind: request.kind, primary: request.primary, bytes, label: request.label, isHubAddress, drawingMs: request.drawingMs });
  const has = Buffer.isBuffer(checked);
  const same = has && checked.length === bytes.length && (checked.buffer === bytes.buffer && checked.byteOffset === bytes.byteOffset ? true : checked.equals(bytes));
  return { header: { ok: true, result, has, same }, bytes: has && !same ? checked : NOTHING };
};

const answer = async (head, bytes) => {
  let reply;
  try {
    reply = await check(JSON.parse(head.toString("utf8")), bytes);
  } catch (error) {
    // Too much of something for a string or a block of memory to hold: the
    // file's doing. Anything else is a fault of the checks' own, said as it
    // is for the run's log.
    reply = { header: tooLarge(error) ? { ok: false, stopped: "memory" } : { ok: false, error: String(error?.stack || error).slice(0, 4000) }, bytes: NOTHING };
  }
  // Said in the answer, so nothing more is sent to a process that is about
  // to go.
  const leaving = process.memoryUsage.rss() > KEEP_BELOW;
  await new Promise((resolve) => {
    writeFrames(process.stdout, [Buffer.from(JSON.stringify({ ...reply.header, leaving, peak: process.resourceUsage().maxRSS })), reply.bytes ?? NOTHING], resolve);
  });
  if (leaving) {
    closeSharedRasteriser();
    process.exit(0);
  }
};

const incoming = new FrameReader();
let head = null;
let working = Promise.resolve();
process.stdin.on("data", (chunk) => {
  incoming.push(chunk);
  for (let message = incoming.take(); message; message = incoming.take()) {
    if (!head) {
      head = message;
      continue;
    }
    const request = head;
    const bytes = message;
    head = null;
    working = working.then(() => answer(request, bytes));
  }
});
// Whoever asked has gone: there is nobody to answer.
process.stdin.on("end", () => process.exit(0));
process.stdout.on("error", () => process.exit(0));
