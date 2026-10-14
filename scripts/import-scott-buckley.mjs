// Posts Scott Buckley's music library (www.scottbuckley.com.au/library) on the
// hub's music list, a track a post, the way a contributor would by hand.
//
// For a maintainer to run from their own machine, signed in to the `gh` CLI as
// one of the hub's contributors (the music workflow reads only their posts):
//
//   node scripts/import-scott-buckley.mjs                 what it would post (changes nothing)
//   node scripts/import-scott-buckley.mjs --go            post every track not on the hub yet
//   node scripts/import-scott-buckley.mjs --go --limit 5  post the first five of them
//   node scripts/import-scott-buckley.mjs --clean-inbox   delete inbox files of tracks now on the list
//
// What a run does, for each track not already on the hub:
//   1. reads the track from the composer's own posts list (music/importers/
//      scott-buckley.mjs): its name, its page, the credit line the page asks
//      for, and its MP3. A page that does not say "released under CC BY 4.0"
//      is left out and named;
//   2. downloads the MP3 from the composer's site, once, and checks it the way
//      the workflow will (really an MP3, 20 MB or less);
//   3. uploads it to the `music-inbox` release, so that the workflow fetches
//      it from GitHub and the composer's site is asked for each file only once;
//   4. opens the music post, with the form's headings.
// The workflow then checks each post and puts the track on the list as it does
// any other. Once a track is on the list its inbox file is no longer needed
// (--clean-inbox).
//
// It is polite to the composer's site: one request at a time, a pause between
// tracks, and a name in its requests that says who is asking.
// A track already on the hub, or with a post already open, is skipped, so a
// run that stopped can be run again.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { MAX_TRACK_BYTES, inspectAudio, megabytesText } from "./music/audio.mjs";
import { parseForm } from "./music/form.mjs";
import { DATA_BRANCH, LABEL, LIST_FILE } from "./music/music.mjs";
import { LIBRARY_API, LIBRARY_FIELDS, planImport } from "./music/importers/scott-buckley.mjs";
import { postBodyOf, postTitleOf } from "./music/post-body.mjs";

const REPO = process.env.GITHUB_REPOSITORY || "Open-Historia/Open-historia-scenarios";
const INBOX = "music-inbox";
const AGENT = `OpenHistoriaMusicImporter/1.0 (+https://github.com/${REPO})`;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name, fallback) => { const at = args.indexOf(name); return at >= 0 && args[at + 1] ? Number(args[at + 1]) : fallback; };
const go = flag("--go");
const limit = valueOf("--limit", Infinity);
const pauseMs = valueOf("--pause", 6) * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gh = (...parts) => execFileSync("gh", parts, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

const getJson = async (address) => {
  const response = await fetch(address, { headers: { "User-Agent": AGENT, Accept: "application/json" } });
  if (!response.ok) throw new Error(`${address} answered ${response.status}`);
  return { json: await response.json(), pages: Number(response.headers.get("x-wp-totalpages") || 1) };
};

// Every post of the library, a hundred at a time.
const readLibrary = async () => {
  const fields = LIBRARY_FIELDS;
  const first = await getJson(`${LIBRARY_API}?per_page=100&page=1&_fields=${fields}`);
  const posts = [...first.json];
  for (let page = 2; page <= first.pages; page += 1) {
    await sleep(1500);
    posts.push(...(await getJson(`${LIBRARY_API}?per_page=100&page=${page}&_fields=${fields}`)).json);
  }
  return posts;
};

// What the hub already has: the tracks on the list, and every music post
// (listed or still being checked), by the page each gives as its source.
const readHub = async () => {
  const listedSources = new Set();
  const takenIds = new Set();
  const listed = new Map();
  const response = await fetch(`https://raw.githubusercontent.com/${REPO}/${DATA_BRANCH}/${LIST_FILE}`, { headers: { "User-Agent": AGENT } });
  if (response.ok) {
    for (const track of (await response.json()).tracks ?? []) {
      takenIds.add(track.id);
      if (!track.removed) { listedSources.add(track.source); listed.set(track.id, track); }
    }
  }
  const issues = JSON.parse(gh("issue", "list", "-R", REPO, "--label", LABEL, "--state", "all", "--limit", "2000", "--json", "number,body,state,stateReason"));
  for (const issue of issues) {
    if (issue.state === "CLOSED" && issue.stateReason === "NOT_PLANNED") continue;
    const form = parseForm(issue.body ?? "");
    if (form.source) listedSources.add(form.source);
    if (form.trackId) takenIds.add(String(form.trackId).trim().toLowerCase());
  }
  return { listedSources, takenIds, listed };
};

const download = async (address, file) => {
  const response = await fetch(address, { headers: { "User-Agent": AGENT } });
  if (!response.ok || !response.body) throw new Error(`the file answered ${response.status}`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_TRACK_BYTES) throw new Error(`the file is ${megabytesText(declared)} MB; a track can be 20 MB at most`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file));
};

const inboxAssets = () => {
  try {
    return JSON.parse(gh("release", "view", INBOX, "-R", REPO, "--json", "assets")).assets.map((asset) => asset.name);
  } catch {
    return null;
  }
};

if (flag("--clean-inbox")) {
  const { listed } = await readHub();
  const assets = inboxAssets() ?? [];
  let removed = 0;
  for (const name of assets) {
    if (!listed.has(name.replace(/\.(mp3|ogg)$/i, ""))) continue;
    gh("release", "delete-asset", INBOX, name, "-R", REPO, "--yes");
    removed += 1;
  }
  console.log(`${removed} inbox file(s) of listed tracks deleted; ${assets.length - removed} kept.`);
  process.exit(0);
}

const posts = await readLibrary();
const hub = await readHub();
const { tracks, skipped } = planImport(posts, hub);
const alreadyThere = skipped.filter((entry) => entry.skipped === "already on the hub");
const leftOut = skipped.filter((entry) => entry.skipped !== "already on the hub");
console.log(`${posts.length} track(s) in the library: ${tracks.length} to post, ${alreadyThere.length} already on the hub, ${leftOut.length} left out.`);
for (const entry of leftOut) console.log(`  left out: ${entry.name || "(no name)"} — ${entry.skipped} (${entry.source})`);
// A genre, mood or instrument the hub's lists (scripts/music/tags.mjs) do not
// know yet is left out of the post: add it to the lists and the form.
for (const track of tracks) if (track.unknownTags?.length) console.log(`  not on the hub's lists, left out of ${track.id}: ${track.unknownTags.join(", ")}`);

if (!go) {
  for (const track of tracks.slice(0, 12)) console.log(`  would post: ${track.id} — ${track.name}`);
  if (tracks.length > 12) console.log(`  … and ${tracks.length - 12} more.`);
  console.log("Nothing was changed. Run with --go to post them.");
  process.exit(0);
}

if (inboxAssets() === null) {
  gh("release", "create", INBOX, "-R", REPO, "--prerelease", "--title", "Music inbox", "--notes", "Files waiting to be checked by the music workflow. A track's own copy, once it is on the list, is in the `music` release; what is here can be deleted afterwards.");
}
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "music-import-"));
const done = { posted: 0, failed: [] };
for (const track of tracks.slice(0, limit)) {
  const file = path.join(workDir, `${track.id}.mp3`);
  try {
    await download(track.original, file);
    const { type, seconds } = await inspectAudio(file);
    if (type !== "mp3") throw new Error("the file is not an MP3");
    gh("release", "upload", INBOX, file, "-R", REPO, "--clobber");
    const body = postBodyOf({
      ...track,
      download: `https://github.com/${REPO}/releases/download/${INBOX}/${track.id}.mp3`,
      notes: `Posted from the composer's own library by scripts/import-scott-buckley.mjs. The file is the composer's own, unchanged: ${track.original}`,
    });
    const bodyFile = path.join(workDir, `${track.id}.md`);
    fs.writeFileSync(bodyFile, body);
    const address = gh("issue", "create", "-R", REPO, "--title", postTitleOf(track), "--label", LABEL, "--body-file", bodyFile).trim().split("\n").at(-1);
    done.posted += 1;
    console.log(`posted ${track.id} (${megabytesText(fs.statSync(file).size)} MB${seconds ? `, ${seconds} s` : ""}): ${address}`);
  } catch (error) {
    done.failed.push(`${track.id}: ${String(error?.message || error).split("\n")[0]}`);
    console.log(`FAILED ${track.id}: ${String(error?.message || error).split("\n")[0]}`);
  } finally {
    fs.rmSync(file, { force: true });
  }
  await sleep(pauseMs);
}
fs.rmSync(workDir, { recursive: true, force: true });
console.log(`${done.posted} track(s) posted, ${done.failed.length} failed.`);
for (const line of done.failed) console.log(`  ${line}`);
