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
import { createClient } from "./detailed-maps/github.mjs";
import { syncDetailedMaps } from "./detailed-maps/sync.mjs";

const dryRun = process.argv.includes("--dry-run");
const repo = process.env.GITHUB_REPOSITORY || "Open-Historia/Open-historia-scenarios";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
if (!token && !dryRun) {
  console.error("GITHUB_TOKEN is not set.");
  process.exit(2);
}

let client = createClient({ repo, token });
if (dryRun) {
  const would = (what) => console.log(`(dry run) would ${what}`);
  let fakeId = -1;
  client = {
    ...client,
    createComment: async (number, body) => would(`comment on #${number}:\n${body}\n`),
    updateComment: async (id, body) => would(`update comment ${id}:\n${body}\n`),
    addLabel: async (number, name) => would(`label #${number} "${name}"`),
    removeLabel: async (number, name) => would(`remove the label "${name}" from #${number}`),
    createRelease: async ({ tag, draft }) => {
      would(`create the ${draft ? "draft " : ""}release ${tag}`);
      return { id: fakeId--, tag, draft, assets: [] };
    },
    uploadAsset: async (release, name) => {
      would(`upload ${name} to ${release.tag}`);
      return { id: fakeId--, name, tag: release.tag, url: `https://github.com/${repo}/releases/download/${release.tag}/${name}` };
    },
    deleteAsset: async (id) => would(`delete the release file ${id}`),
    writeData: async (files, message) => {
      would(`commit "${message}" to the detailed-maps-index branch`);
      return true;
    },
  };
}

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
