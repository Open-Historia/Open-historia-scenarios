// Copies the files attached to the hub's posts into this repository's releases,
// and writes the index the game reads. Run by the "Copy post files to releases"
// workflow whenever a post is opened, edited, closed or reopened, and every
// half hour; see scripts/lib/sync.mjs for what a run does.
//
//   GITHUB_TOKEN=... node scripts/sync-hub.mjs
//   node scripts/sync-hub.mjs --dry-run [--posts 12,34]
//
// --dry-run reads and downloads everything but changes nothing (no release, no
// upload, no comment, no commit), and needs no token for a public repository.
// With --posts it looks at those posts only.

import fs from "node:fs";
import { createClient } from "./lib/github.mjs";
import { syncHub } from "./lib/sync.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const dryRun = args.includes("--dry-run");
const only = new Set(String(option("posts") ?? "").split(",").map((part) => Number(part.trim())).filter((number) => number > 0));
if (only.size && !dryRun) {
  console.error("--posts is for --dry-run only: a real run has to see every post, or it would take the others for closed.");
  process.exit(2);
}

const repo = process.env.GITHUB_REPOSITORY || "Open-Historia/Open-historia-scenarios";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
if (!token && !dryRun) {
  console.error("GITHUB_TOKEN is not set.");
  process.exit(2);
}

// What this repository was called before it moved: posts made then link to its
// releases under the old name, and GitHub redirects them here.
const ALIASES = ["Arkniem/pax-historia-scenarios"];
// What the game's own counter had counted for each scenario post when counting
// moved to release downloads (2026-10-05), so no post's number started again
// from nothing. Never updated.
const legacy = JSON.parse(fs.readFileSync(new URL("../data/legacy-import-counts.json", import.meta.url), "utf8"));

const client = createClient({ repo, token, dryRun, log: console.log });
if (only.size) {
  const listOpenPosts = client.listOpenPosts;
  client.listOpenPosts = async (kind) => (await listOpenPosts(kind)).filter((issue) => only.has(Number(issue.number)));
}

const { summary, index } = await syncHub({ client, aliases: ALIASES, legacy, log: console.log });
const lines = [
  `${summary.posts} open post(s); ${Object.keys(index.files).length} file(s) in the releases.`,
  `${summary.copied} copied, ${summary.deleted} deleted, ${summary.retired} closed post(s) cleared.`,
  `${summary.problems} post(s) with a file problem; ${summary.commented} comment(s) written.`,
  ...(summary.deferred ? [`${summary.deferred} file(s) left for the next run.`] : []),
  summary.written ? "The index was updated." : "The index is unchanged.",
];
console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.map((line) => `- ${line}`).join("\n")}\n`);
