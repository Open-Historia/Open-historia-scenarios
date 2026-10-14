// Checks the hub's background music posts, copies their files into the "music"
// release and writes the list the game reads (music.json on the music-index
// branch, with MUSIC.md for people). Run by the "Background music" workflow;
// see scripts/music/sync.mjs for what a run does.
//
//   GITHUB_TOKEN=... node scripts/sync-music.mjs
//   node scripts/sync-music.mjs --dry-run
//
// --dry-run reads, downloads and checks everything but changes nothing (no
// release, upload, comment, label, closing or commit), and needs no token for
// a public repository. It prints what a real run would do.

import os from "node:os";
import path from "node:path";
import { createClient, dryRunOf } from "./detailed-maps/github.mjs";
import { DATA_BRANCH, LABEL } from "./music/music.mjs";
import { syncMusic } from "./music/sync.mjs";

const dryRun = process.argv.includes("--dry-run");
const repo = process.env.GITHUB_REPOSITORY || "Open-Historia/Open-historia-scenarios";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
if (!token && !dryRun) {
  console.error("GITHUB_TOKEN is not set.");
  process.exit(2);
}

let client = createClient({ repo, token, label: LABEL, dataBranch: DATA_BRANCH, problemNote: "A post with something for its author to fix" });
if (dryRun) client = dryRunOf(client);

const workDir = path.join(process.env.RUNNER_TEMP || os.tmpdir(), "music");
const summary = await syncMusic({ client, workDir });
const lines = [
  `${summary.posts} music post(s); ${summary.unchanged} unchanged.`,
  `${summary.released} track file(s) published, ${summary.details} post(s) with new details only, ${summary.problem} needing changes, ${summary.waiting} to try again, ${summary.turnedAway} turned away (not from a contributor), ${summary.removed} track(s) removed.`,
  ...(dryRun ? ["A dry run: nothing was changed."] : []),
];
console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) {
  const fs = await import("node:fs");
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.map((line) => `- ${line}`).join("\n")}\n`);
}
