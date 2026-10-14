import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkForm, parseForm } from "../detailed-maps/form.mjs";
import { ARCHIVE_RELEASE, LABEL, LIST_FILE, PAGE_FILE, PROBLEM_LABEL, STATE_FILE, emptyList, findMap } from "../detailed-maps/maps.mjs";
import { inspectMap, zxyToTileId } from "../detailed-maps/pmtiles.mjs";
import { MARKER, changeMap, openStore, syncDetailedMaps } from "../detailed-maps/sync.mjs";
import { REPO, fakeDownloads, fakeGitHub as fakePosts } from "./fake-github.mjs";
import { png } from "./fixtures.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "detailed-maps-test-"));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

// A PMTiles archive with one tile at zoom 0: a header, a root directory with
// one entry (stored as is), and the tile.
const makeMap = (name, { tileType = 2, tile = "TILE-A" } = {}) => {
  const tileBytes = Buffer.from(tile);
  const directory = Buffer.from([1, 0, 1, tileBytes.length, 1]);
  const header = Buffer.alloc(127);
  header.write("PMTiles", 0, "latin1");
  header[7] = 3;
  header.writeBigUInt64LE(127n, 8);
  header.writeBigUInt64LE(BigInt(directory.length), 16);
  header.writeBigUInt64LE(BigInt(127 + directory.length), 56);
  header.writeBigUInt64LE(BigInt(tileBytes.length), 64);
  header[97] = 1;
  header[98] = 1;
  header[99] = tileType;
  header[100] = 0;
  header[101] = 0;
  header.writeInt32LE(-100000000, 102);
  header.writeInt32LE(-50000000, 106);
  header.writeInt32LE(100000000, 110);
  header.writeInt32LE(50000000, 114);
  const file = path.join(temp, name);
  fs.writeFileSync(file, Buffer.concat([header, directory, tileBytes]));
  return file;
};

const body = ({ name = "Test world", id = "", link = "https://example.com/a.pmtiles", sha = "", credits = "Made by me, from [OSM](https://osm.org)", licence = "CC BY-SA 4.0", ticks = 4, changes = "" } = {}) => [
  "### Map name", "", name, "",
  "### Map ID", "", id || "_No response_", "",
  "### Download link to the .pmtiles file", "", link, "",
  "### File size", "", "1 MB", "",
  "### SHA-256 checksum (optional)", "", sha || "_No response_", "",
  "### What does the map show?", "", "A test world.", "",
  "### What changed? (updates only)", "", changes || "_No response_", "",
  "### Screenshots", "", "![a](https://github.com/user-attachments/assets/0000)", "",
  "### Who made it, and what is it based on?", "", credits, "",
  "### Licence", "", licence, "",
  "### Scenarios that use it (optional)", "", "_No response_", "",
  "### Before you post", "",
  ...Array.from({ length: 4 }, (_, i) => `- [${i < ticks ? "X" : " "}] box ${i}`),
].join("\n");

// GitHub, in memory (fake-github.mjs), listing the detailed map posts.
const fakeGitHub = () => fakePosts({ label: LABEL, listFile: LIST_FILE, stateFile: STATE_FILE });

const statusOf = (github, number) => (github.comments.get(number) ?? []).find((comment) => comment.body.startsWith(MARKER))?.body ?? "";

test("the PMTiles reader finds tiles where the format puts them", async () => {
  assert.equal(zxyToTileId(0, 0, 0), 0);
  assert.deepEqual([[0, 0], [0, 1], [1, 1], [1, 0]].map(([x, y]) => zxyToTileId(1, x, y)), [1, 2, 3, 4]);
  assert.equal(zxyToTileId(2, 0, 0), 5);
  const info = await inspectMap(makeMap("ok.pmtiles"));
  assert.deepEqual(info, { tileType: "png", minzoom: 0, maxzoom: 0, bounds: [-10, -5, 10, 5] });
  await assert.rejects(inspectMap(makeMap("vector.pmtiles", { tileType: 1 })), /vector tiles/);
  const notMap = path.join(temp, "not.pmtiles");
  fs.writeFileSync(notMap, Buffer.alloc(200, 65));
  await assert.rejects(inspectMap(notMap), /not a PMTiles archive/);
  const cut = path.join(temp, "cut.pmtiles");
  fs.writeFileSync(cut, fs.readFileSync(makeMap("whole.pmtiles")).subarray(0, 130));
  await assert.rejects(inspectMap(cut), /incomplete|outside/);
});

test("the form: an ID from the name, IDs that are taken, and an ID that can't change", () => {
  const list = emptyList();
  list.basemaps.push({ id: "taken", name: "Taken", versions: [{ version: 1 }], post: 3 });
  list.basemaps.push({ id: "gone", name: "Gone", deleted: { date: "2026-01-01" }, versions: [] });
  assert.equal(checkForm(parseForm(body({ name: "Game of Thrones world map" })), list).id, "game-of-thrones-world-map");
  assert.match(checkForm(parseForm(body({ id: "taken" })), list).problems.join(" "), /already the ID of another map \(#3\)/);
  assert.match(checkForm(parseForm(body({ id: "gone" })), list).problems.join(" "), /never used again/);
  assert.match(checkForm(parseForm(body({ id: "Not OK" })), list).problems.join(" "), /can't be a map ID/);
  assert.match(checkForm(parseForm(body({ id: "other" })), list, { ownId: "taken" }).problems.join(" "), /never changes/);
  assert.deepEqual(checkForm(parseForm(body({ id: "taken" })), list, { ownId: "taken" }).problems, []);
  assert.match(checkForm(parseForm(body({ ticks: 3 })), list).problems.join(" "), /Tick all the boxes/);
  // A checksum copied from a GitHub release page, label and all.
  const copied = checkForm(parseForm(body({ sha: `sha256:${"Ab".repeat(32)}` })), list);
  assert.deepEqual(copied.problems, []);
  assert.equal(copied.sha256, "ab".repeat(32));
  const linked = parseForm(body({ link: "[file](https://example.com/my_map.pmtiles)" }));
  assert.equal(linked.download, "https://example.com/my_map.pmtiles");
});

test("a post is released, its words edited without a download, and a new file becomes version 2", async () => {
  const github = fakeGitHub();
  const v1 = makeMap("v1.pmtiles", { tile: "ONE" });
  const v2 = makeMap("v2.pmtiles", { tile: "TWO!" });
  const { download, calls } = fakeDownloads({ "https://example.com/v1.pmtiles": v1, "https://example.com/v2.pmtiles": v2 });
  const run = () => syncDetailedMaps({ client: github.client, workDir: path.join(temp, "work"), download, today: "2026-10-10", log: () => {} });

  github.addPost(7, body({ id: "test-world", link: "https://example.com/v1.pmtiles" }));
  assert.equal((await run()).released, 1);
  let map = findMap(github.list(), "test-world");
  assert.equal(map.post, 7);
  assert.deepEqual(map.owners, ["designer"]);
  assert.equal(map.versions[0].url, `https://github.com/${REPO}/releases/download/detailed-maps-1/test-world-v1.pmtiles`);
  assert.equal(map.versions[0].bytes, fs.statSync(v1).size);
  assert.match(statusOf(github, 7), /This map is on the list/);
  assert.match(github.data[PAGE_FILE], /Made by me, from \[OSM\]\(https:\/\/osm.org\)/);

  // Nothing changed: nothing downloaded.
  assert.equal((await run()).unchanged, 1);
  assert.equal(calls.length, 1);

  // The words changed, the link didn't: no download, no new version.
  github.editPost(7, { body: body({ id: "test-world", name: "Test world, renamed", link: "https://example.com/v1.pmtiles" }) });
  assert.equal((await run()).details, 1);
  assert.equal(calls.length, 1);
  map = findMap(github.list(), "test-world");
  assert.equal(map.name, "Test world, renamed");
  assert.equal(map.versions.length, 1);

  // A new link: version 2, and a comment that notifies.
  github.editPost(7, { body: body({ link: "https://example.com/v2.pmtiles" }) });
  assert.equal((await run()).released, 1);
  map = findMap(github.list(), "test-world");
  assert.deepEqual(map.versions.map((entry) => entry.version), [1, 2]);
  assert.equal(github.releases[0].assets.length, 2);
  assert.match(github.comments.get(7).at(-1).body, /Version 2 of `test-world` is released/);

  // A new link to the same file: no version 3.
  fs.copyFileSync(v2, path.join(temp, "v2-again.pmtiles"));
  const again = fakeDownloads({ "https://example.com/v2-again.pmtiles": path.join(temp, "v2-again.pmtiles") });
  github.editPost(7, { body: body({ link: "https://example.com/v2-again.pmtiles" }) });
  assert.equal((await syncDetailedMaps({ client: github.client, workDir: path.join(temp, "work"), download: again.download, log: () => {} })).details, 1);
  assert.equal(findMap(github.list(), "test-world").versions.length, 2);
});

test("what changed is kept with its version, shown in the post's history, and never carried to the next version", async () => {
  const github = fakeGitHub();
  const files = { "https://example.com/v1.pmtiles": makeMap("n1.pmtiles", { tile: "N1" }), "https://example.com/v2.pmtiles": makeMap("n2.pmtiles", { tile: "N2!" }), "https://example.com/v3.pmtiles": makeMap("n3.pmtiles", { tile: "N3!!" }) };
  const { download } = fakeDownloads(files);
  const run = () => syncDetailedMaps({ client: github.client, workDir: path.join(temp, "work"), download, log: () => {} });
  github.addPost(12, body({ id: "notes", link: "https://example.com/v1.pmtiles" }));
  await run();

  github.editPost(12, { body: body({ id: "notes", link: "https://example.com/v2.pmtiles", changes: "Sharper **coasts** around the bay." }) });
  await run();
  let map = findMap(github.list(), "notes");
  assert.equal(map.versions[0].notes, undefined);
  assert.equal(map.versions[1].notes, "Sharper coasts around the bay.");
  assert.match(github.comments.get(12).at(-1).body, /Version 2 of `notes` is released[\s\S]*\*\*What changed:\*\* Sharper coasts around the bay\./);

  // A new file, the box left as it was: the old note is not version 3's.
  github.editPost(12, { body: body({ id: "notes", link: "https://example.com/v3.pmtiles", changes: "Sharper **coasts** around the bay." }) });
  await run();
  map = findMap(github.list(), "notes");
  assert.equal(map.versions[2].notes, undefined);
  assert.doesNotMatch(github.comments.get(12).at(-1).body, /What changed/);
});

test("a post with a problem is told what to fix, and labelled until it is fixed", async () => {
  const github = fakeGitHub();
  const file = makeMap("fix.pmtiles");
  const { download } = fakeDownloads({ "https://example.com/fix.pmtiles": file });
  const run = () => syncDetailedMaps({ client: github.client, workDir: path.join(temp, "work"), download, log: () => {} });

  github.addPost(9, body({ link: "https://example.com/missing.pmtiles" }));
  assert.equal((await run()).problem, 1);
  assert.match(statusOf(github, 9), /needs changes[\s\S]*HTTP 404/);
  assert.ok(github.posts[0].labels.some((label) => label.name === PROBLEM_LABEL));
  assert.equal(github.data[LIST_FILE] && github.list().basemaps.length, 0);

  github.editPost(9, { body: body({ link: "https://example.com/fix.pmtiles", sha: "0".repeat(64) }) });
  assert.equal((await run()).problem, 1);
  assert.match(statusOf(github, 9), /SHA-256 is/);

  github.editPost(9, { body: body({ link: "https://example.com/fix.pmtiles" }) });
  assert.equal((await run()).released, 1);
  assert.ok(!github.posts[0].labels.some((label) => label.name === PROBLEM_LABEL));
  assert.match(statusOf(github, 9), /on the list/);
  // The status comment was edited, which notifies no one, so a new one says so.
  assert.match(github.comments.get(9).at(-1).body, /^✅ `test-world` is on the list\.$/);
});

test("a file that is already another map's version is refused, so an update goes on the map's own post", async () => {
  const github = fakeGitHub();
  const file = makeMap("original.pmtiles", { tile: "ORIGINAL" });
  const { download } = fakeDownloads({ "https://example.com/a.pmtiles": file });
  const run = () => syncDetailedMaps({ client: github.client, workDir: path.join(temp, "work"), download, log: () => {} });
  github.addPost(1, body({ id: "first" }));
  await run();
  github.addPost(2, body({ id: "second" }), "someone-else");
  assert.equal((await run()).problem, 1);
  assert.match(statusOf(github, 2), /already version 1 of `first` \(#1\)[\s\S]*edit that map's post/);
  assert.equal(findMap(github.list(), "second"), null);
});

test("two posts can't share an ID, and the older one has it", async () => {
  const github = fakeGitHub();
  const file = makeMap("shared.pmtiles");
  const { download } = fakeDownloads({ "https://example.com/a.pmtiles": file });
  github.addPost(1, body({ id: "same" }));
  github.addPost(2, body({ id: "same" }), "someone-else");
  const summary = await syncDetailedMaps({ client: github.client, workDir: path.join(temp, "work"), download, log: () => {} });
  assert.equal(summary.released, 1);
  assert.equal(summary.problem, 1);
  assert.equal(findMap(github.list(), "same").post, 1);
  assert.match(statusOf(github, 2), /already the ID of another map \(#1\)/);
});

test("closing a post as not planned deletes its map for good, and its ID is never used again", async () => {
  const github = fakeGitHub();
  const file = makeMap("bye.pmtiles");
  const { download } = fakeDownloads({ "https://example.com/a.pmtiles": file });
  const run = () => syncDetailedMaps({ client: github.client, workDir: path.join(temp, "work"), download, log: () => {} });
  github.addPost(4, body({ id: "bye" }));
  await run();
  github.editPost(4, { state: "closed", state_reason: "not_planned" });
  assert.equal((await run()).deleted, 1);
  const map = findMap(github.list(), "bye");
  assert.ok(map.deleted);
  assert.deepEqual(map.versions, [{ version: 1, deleted: map.deleted }]);
  assert.equal(github.releases[0].assets.length, 0);
  assert.match(github.data[PAGE_FILE], /Removed maps[\s\S]*`bye`/);

  // Reopened and edited: told once that it can't come back.
  github.editPost(4, { state: "open", state_reason: null, body: body({ id: "bye", name: "Back again" }) });
  await run();
  await run();
  assert.match(statusOf(github, 4), /can't come back/);
  assert.equal(github.state().posts[4].toldDeleted, true);

  github.addPost(5, body({ id: "bye" }));
  await run();
  assert.match(statusOf(github, 5), /never used again/);
});

test("archiving moves the file out of reach, and restoring brings it back", async () => {
  const github = fakeGitHub();
  const file = makeMap("arch.pmtiles");
  const { download } = fakeDownloads({ "https://example.com/a.pmtiles": file });
  github.addPost(6, body({ id: "arch" }));
  await syncDetailedMaps({ client: github.client, workDir: path.join(temp, "work"), download, log: () => {} });

  let store = await openStore({ client: github.client, workDir: path.join(temp, "work"), log: () => {} });
  await changeMap({ store, action: "archive", id: "arch", reason: "licence query", today: "2026-10-11" });
  await store.save("Archive arch");
  let map = findMap(github.list(), "arch");
  assert.deepEqual(map.archived, { reason: "licence query", date: "2026-10-11" });
  const archived = github.releases.find((release) => release.tag === ARCHIVE_RELEASE);
  assert.ok(archived.draft);
  assert.equal(archived.assets[0].name, "arch-v1.pmtiles");
  assert.equal(github.releases.find((release) => release.tag === "detailed-maps-1").assets.length, 0);

  // An edit can't release a new version while it is archived.
  github.editPost(6, { body: body({ id: "arch", link: "https://example.com/new.pmtiles" }) });
  await syncDetailedMaps({ client: github.client, workDir: path.join(temp, "work"), download, log: () => {} });
  assert.match(statusOf(github, 6), /is archived/);

  store = await openStore({ client: github.client, workDir: path.join(temp, "work"), log: () => {} });
  await changeMap({ store, action: "restore", id: "arch", today: "2026-10-12" });
  await store.save("Restore arch");
  map = findMap(github.list(), "arch");
  assert.equal(map.archived, undefined);
  assert.equal(map.versions[0].archived, undefined);
  assert.equal(map.versions[0].url, `https://github.com/${REPO}/releases/download/detailed-maps-1/arch-v1.pmtiles`);
  assert.equal(archived.assets.length, 0);
  await assert.rejects(changeMap({ store, action: "restore", id: "arch", today: "2026-10-12" }), /isn't archived/);
});

test("a version's first screenshot is copied next to its file, and the list points the game at the copy", async () => {
  const github = fakeGitHub();
  const file = makeMap("shot.pmtiles");
  const { download } = fakeDownloads({ "https://example.com/a.pmtiles": file });
  const picture = png({ width: 8, height: 6 });
  github.attachments["https://github.com/user-attachments/assets/0000"] = picture;
  github.addPost(10, body({ id: "shot" }));
  assert.equal((await syncDetailedMaps({ client: github.client, workDir: path.join(temp, "work"), download, log: () => {} })).released, 1);
  const url = `https://github.com/${REPO}/releases/download/detailed-maps-1/shot-v1.png`;
  assert.equal(findMap(github.list(), "shot").versions[0].preview, url);
  assert.ok(github.releases[0].assets.find((asset) => asset.url === url).bytes.equals(picture));
});

test("a screenshot is archived, restored and deleted with its map's file", async () => {
  const github = fakeGitHub();
  const { download } = fakeDownloads({ "https://example.com/a.pmtiles": makeMap("pic.pmtiles") });
  github.attachments["https://github.com/user-attachments/assets/0000"] = png();
  github.addPost(11, body({ id: "pic" }));
  await syncDetailedMaps({ client: github.client, workDir: path.join(temp, "work"), download, log: () => {} });
  const names = (tag) => github.releases.find((release) => release.tag === tag).assets.map((asset) => asset.name).sort();

  let store = await openStore({ client: github.client, workDir: path.join(temp, "work"), log: () => {} });
  await changeMap({ store, action: "archive", id: "pic", today: "2026-10-13" });
  await store.save("Archive pic");
  assert.deepEqual(names(ARCHIVE_RELEASE), ["pic-v1.pmtiles", "pic-v1.png"]);
  assert.deepEqual(names("detailed-maps-1"), []);

  store = await openStore({ client: github.client, workDir: path.join(temp, "work"), log: () => {} });
  await changeMap({ store, action: "restore", id: "pic", today: "2026-10-13" });
  await store.save("Restore pic");
  assert.equal(findMap(github.list(), "pic").versions[0].preview, `https://github.com/${REPO}/releases/download/detailed-maps-1/pic-v1.png`);
  assert.deepEqual(names("detailed-maps-1"), ["pic-v1.pmtiles", "pic-v1.png"]);

  github.editPost(11, { state: "closed", state_reason: "not_planned" });
  await syncDetailedMaps({ client: github.client, workDir: path.join(temp, "work"), download, log: () => {} });
  assert.deepEqual(names("detailed-maps-1"), []);
  assert.equal(findMap(github.list(), "pic").versions[0].preview, undefined);
});

test("a download that fails for a passing reason is tried again on the next run, without an edit", async () => {
  const { PassingError } = await import("../detailed-maps/maps.mjs");
  const github = fakeGitHub();
  const file = makeMap("later.pmtiles");
  let unwell = true;
  const download = async (link, dest) => {
    if (unwell) throw new PassingError("The download link answered HTTP 503; it is tried again later.");
    fs.copyFileSync(file, dest);
    return fs.statSync(dest).size;
  };
  github.addPost(8, body({ id: "later" }));
  assert.equal((await syncDetailedMaps({ client: github.client, workDir: path.join(temp, "work"), download, log: () => {} })).waiting, 1);
  assert.match(statusOf(github, 8), /couldn't be checked just now/);
  unwell = false;
  assert.equal((await syncDetailedMaps({ client: github.client, workDir: path.join(temp, "work"), download, log: () => {} })).released, 1);
});
