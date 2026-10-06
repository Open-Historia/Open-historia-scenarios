// A watch on all the memory a process uses, for the two that work on files
// their authors wrote (check-worker.mjs, svg-worker.mjs): past `megabytes` the
// process says why, on its error output, and stops at once.
//
// The watch is a thread of its own, and it stops the process the hard way,
// because neither of the gentler ways works when it matters:
//
//   - a timer on the main thread does not run while the main thread is busy,
//     and reading 250 MB of JSON, or an SVG, is one long piece of work;
//   - process.exit() waits for work already handed to other threads to finish,
//     and the work is what is using the memory: an SVG of forty lines, patterns
//     filled with patterns, takes 3 GB a second to draw for as long as it is
//     let, and a renderer told to exit at 1.5 GB went on to the end of its
//     twenty seconds.
//
// What it says begins "out of memory", which is what checker.mjs and svg.mjs
// look for to tell this from a process that failed.

import { Worker } from "node:worker_threads";

export const watchMemory = (megabytes) => {
  new Worker(
    `const { workerData } = require("node:worker_threads");
    const fs = require("node:fs");
    setInterval(() => {
      if (process.memoryUsage.rss() <= workerData.limit) return;
      try { fs.writeSync(2, "out of memory: more than this process may use\\n"); } catch {}
      process.kill(process.pid, "SIGKILL");
    }, 25);`,
    { eval: true, workerData: { limit: megabytes * 1024 * 1024 } },
  ).unref();
};
