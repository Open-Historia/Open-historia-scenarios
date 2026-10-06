// Checks the files attached to the hub's posts, copies the checked files into
// this repository's releases, and writes the index the game reads. Run by the
// "Copy post files to releases" workflow whenever a post is opened, edited,
// closed or reopened, whenever a comment is made or edited, and every half
// hour; see scripts/lib/sync.mjs for what a run does.
//
//   GITHUB_TOKEN=... node scripts/sync-hub.mjs
//   node scripts/sync-hub.mjs --dry-run [--posts 12,34] [--report report.json]
//
// --dry-run reads and downloads and checks everything but changes nothing (no
// release, no upload, no comment made or deleted, no post closed, no commit),
// and needs no token for a public repository. It prints, for each post, what
// a real run would do with it: release its file as it is, repair it (and
// how), or refuse it (and why); and for each suggestion, keep it or delete it.
// With --posts it looks at those posts only. --report writes the same as data,
// and --keep <folder> saves there each file it would have uploaded, under the
// name it would have had in the release, to be looked at.
//
// HUB_AUTOCLOSE=1 has released posts closed. It is a repository variable, off
// until the games that can list closed posts are the ones people have: every
// build before them lists open posts only.

import fs from "node:fs";
import path from "node:path";
import { closeSharedChecker, sharedChecker } from "./lib/checker.mjs";
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
  console.error("--posts is for --dry-run only: a real run has to see every post, or it would take the others for gone.");
  process.exit(2);
}
const reportFile = option("report");
const keepFolder = dryRun ? option("keep") : undefined;

const repo = process.env.GITHUB_REPOSITORY || "Open-Historia/Open-historia-scenarios";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
if (!token && !dryRun) {
  console.error("GITHUB_TOKEN is not set.");
  process.exit(2);
}
const autoClose = process.env.HUB_AUTOCLOSE === "1";

// What this repository was called before it moved: posts made then link to its
// releases under the old name, and GitHub redirects them here.
const ALIASES = ["Arkniem/pax-historia-scenarios"];
// What the game's own counter had counted for each scenario post when counting
// moved to release downloads (2026-10-05), so no post's number started again
// from nothing. Never updated.
const legacy = JSON.parse(fs.readFileSync(new URL("../data/legacy-import-counts.json", import.meta.url), "utf8"));

const started = Date.now();
// In a dry run the client's own "would ..." lines are kept out of the way of
// the per-post account below, which says the same more briefly.
const client = createClient({ repo, token, dryRun, log: dryRun ? () => {} : console.log });
if (keepFolder) {
  fs.mkdirSync(keepFolder, { recursive: true });
  const uploadAsset = client.uploadAsset;
  client.uploadAsset = (releaseId, file) => {
    // The name is the workflow's own (letters, digits, dots and dashes), never a name from a file.
    fs.writeFileSync(path.join(keepFolder, file.name), file.bytes);
    return uploadAsset(releaseId, file);
  };
}
// The workflow gives a run 90 minutes. After 50 it starts nothing new, so
// that what it has done is written down in time.
const deadline = started + 50 * 60000;
const { summary, index, report } = await syncHub({ client, aliases: ALIASES, legacy, log: dryRun ? () => {} : console.log, autoClose, only: only.size ? only : null, deadline });
const checkerMemoryMb = sharedChecker().peakMemoryMb;
closeSharedChecker();

const seconds = Math.round((Date.now() - started) / 1000);
const peakMemoryMb = Math.round(process.resourceUsage().maxRSS / 1024);

// What happened to each post, one line each and a line for each file, repair
// and problem.
const fileLine = (file) => {
  const name = file.label.replace(/^`|`$/g, "");
  if (file.outcome === "as is") return `    ${name}: as it is -> ${file.copy}`;
  if (file.outcome === "repaired") return `    ${name}: repaired -> ${file.copy}`;
  if (file.outcome === "refused") return `    ${name}: refused`;
  if (file.outcome === "waiting") return `    ${name}: not done yet`;
  return `    ${name}: left alone`;
};
const account = [];
const describe = (what, entry) => {
  // A post nothing happened to is not listed, unless it still has a problem.
  if (entry.outcome === "unchanged" && !entry.problems.length && !entry.closed) return;
  const outcome = entry.outcome === "unchanged" && entry.problems.length ? "unchanged, still refused" : entry.outcome;
  account.push(`#${entry.number} ${what}${entry.kind ? ` (${entry.kind})` : ""}: ${outcome}${entry.closed ? ", then closed" : ""}${entry.reopened ? ", and reopened" : ""}  ${JSON.stringify(entry.title)}`);
  for (const file of entry.files) {
    account.push(fileLine(file));
    for (const repair of file.repairs) account.push(`      ~ ${repair}`);
    if (!file.primary) for (const problem of file.problems) account.push(`      (not copied) ${problem}`);
  }
  for (const problem of entry.problems) account.push(`      ! ${problem}`);
};
for (const entry of report.posts) describe("post", entry);
for (const entry of report.tests) describe("test", entry);
for (const entry of report.suggestions) {
  account.push(`suggestion ${entry.comment} on #${entry.post} by ${entry.by}${entry.test ? " (test post)" : ""}: ${entry.outcome}  ${entry.file}`);
  for (const problem of entry.problems) account.push(`      ! ${problem}`);
}
if (dryRun || account.length) console.log(account.join("\n"));

const unchanged = report.posts.filter((entry) => entry.outcome === "unchanged").length;
const lines = [
  `${summary.posts} post(s) on the hub; ${index.posts.length} released, with ${Object.keys(index.files).length} file(s) in the releases.`,
  `${summary.copied} checked file(s) uploaded, ${summary.kept} kept as they were, ${summary.deleted} deleted; ${unchanged} post(s) unchanged; ${summary.retired} post(s) off the hub cleared.`,
  `${summary.problems} post(s) with a file problem; ${summary.commented} comment(s) written.`,
  `${summary.suggestionsKept} suggestion(s) checked and kept, ${summary.suggestionsDeleted} deleted; ${Object.keys(index.suggestions).length} listed.`,
  ...(autoClose ? [`${summary.closed} post(s) closed, ${summary.reopened} reopened.`] : []),
  ...(summary.tests ? [`${summary.tests} test post(s).`] : []),
  ...(summary.deferred ? [`${summary.deferred} left for the next run.`] : []),
  dryRun ? "A dry run: nothing was changed." : summary.written ? "The index was updated." : "The index is unchanged.",
  `${seconds} s; ${peakMemoryMb} MB of memory at most here, and ${checkerMemoryMb} MB in the process that checks the files.`,
];
console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.map((line) => `- ${line}`).join("\n")}\n`);
if (reportFile) fs.writeFileSync(reportFile, `${JSON.stringify({ generatedAt: new Date().toISOString(), repo, dryRun, autoClose, seconds, peakMemoryMb, checkerMemoryMb, summary, ...report }, null, 1)}\n`);
