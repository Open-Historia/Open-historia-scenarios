// Checks the hub's detailed map posts, copies their map files into the
// "detailed-maps-<n>" releases and writes the list the game reads
// (detailed-maps.json on the detailed-maps-index branch). Run by the
// "Detailed maps" workflow; see scripts/detailed-maps/sync.mjs for what a run
// does.
//
//   GITHUB_TOKEN=... node scripts/sync-detailed-maps.mjs
//   node scripts/sync-detailed-maps.mjs --dry-run
//
// --dry-run reads, downloads and checks everything but changes nothing (no
// release, upload, comment, label or commit), and needs no token for a public
// repository. It prints what a real run would do.

import os from "node:os";
import path from "node:path";
import { createClient, dryRunOf } from "./detailed-maps/github.mjs";
import { syncDetailedMaps } from "./detailed-maps/sync.mjs";

const dryRun = process.argv.includes("--dry-run");
const repo = process.env.GITHUB_REPOSITORY || "Open-Historia/Open-historia-scenarios";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
if (!token && !dryRun) {
  console.error("GITHUB_TOKEN is not set.");
  process.exit(2);
}

let client = createClient({ repo, token });
if (dryRun) client = dryRunOf(client);

const workDir = path.join(process.env.RUNNER_TEMP || os.tmpdir(), "detailed-maps");
const summary = await syncDetailedMaps({ client, workDir });
const lines = [
  `${summary.posts} detailed map post(s); ${summary.unchanged} unchanged.`,
  `${summary.released} version(s) released, ${summary.details} post(s) with new details only, ${summary.problem} needing changes, ${summary.waiting} to try again, ${summary.deleted} map(s) deleted.`,
  ...(dryRun ? ["A dry run: nothing was changed."] : []),
];
console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) {
  const fs = await import("node:fs");
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.map((line) => `- ${line}`).join("\n")}\n`);
}
