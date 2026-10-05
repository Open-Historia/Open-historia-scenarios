// Run: npm test
import assert from "node:assert/strict";
import test from "node:test";

import { COMMENT_MARKER, PROBLEM_LABEL, TRANSIENT_RUNS_BEFORE_COMMENT, syncHub } from "../lib/sync.mjs";
import { fakeHub, jsonBytes, pngBytes, post, zipBytes } from "./fake-client.mjs";

const REPO = "Open-Historia/Open-historia-scenarios";
const FILE = "https://github.com/user-attachments/files/501/world-scenario.zip";
const FILE_V2 = "https://github.com/user-attachments/files/502/world-scenario.zip";
const COVER = "https://github.com/user-attachments/assets/aaaaaaaa-1111-2222-3333-444444444444";
const run = (hub, options = {}) => syncHub({ client: hub.client, now: new Date("2026-10-05T12:00:00Z"), ...options });
// A hub the workflow has already run on once, so posts added afterwards are new.
const installed = async (setup = {}) => {
  const hub = fakeHub(setup);
  await run(hub);
  hub.calls.length = 0;
  return hub;
};

test("a post's file is copied into a release, and the index says where", async () => {
  const hub = fakeHub({
    issues: [post(12, "scenario", `![cover](${COVER})\n[file](${FILE})`)],
    files: { [FILE]: zipBytes(), [COVER]: pngBytes() },
  });
  const { summary } = await run(hub);
  assert.equal(summary.copied, 2);
  assert.deepEqual(hub.did("createRelease"), [["createRelease", "scenarios-1"]]);
  assert.deepEqual(hub.did("uploadAsset").map(([, name, type]) => [name, type]), [
    ["p12-501-world-scenario.zip", "application/zip"],
    ["p12-aaaaaaaa.png", "image/png"],
  ]);
  assert.deepEqual(hub.index().files, {
    [FILE]: `https://github.com/${REPO}/releases/download/scenarios-1/p12-501-world-scenario.zip`,
    [COVER]: `https://github.com/${REPO}/releases/download/scenarios-1/p12-aaaaaaaa.png`,
  });
  assert.deepEqual(hub.index().imports, {}, "nothing downloaded yet");
  assert.equal(hub.did("createComment").length, 0);
});

test("a run with nothing to do downloads nothing and writes nothing", async () => {
  const hub = await installed({ issues: [post(12, "scenario", FILE)], files: { [FILE]: zipBytes() } });
  const { summary } = await run(hub);
  assert.deepEqual(hub.calls, []);
  assert.equal(summary.written, undefined);
});

test("imports are the file's downloads, on top of what the old counter had", async () => {
  const hub = await installed({ issues: [post(12, "scenario", `![c](${COVER})\n${FILE}`)], files: { [FILE]: zipBytes(), [COVER]: pngBytes() } });
  hub.downloaded("p12-501-world-scenario.zip", 5);
  hub.downloaded("p12-aaaaaaaa.png", 40); // a picture being looked at is not an import
  await run(hub, { legacy: { 12: 100 } });
  assert.deepEqual(hub.index().imports, { 12: 105 });
});

test("only scenario posts are counted", async () => {
  const hub = await installed({ issues: [post(3, "flag", `![f](${COVER})`)], files: { [COVER]: pngBytes() } });
  hub.downloaded("p3-aaaaaaaa.png", 9);
  await run(hub);
  assert.deepEqual(hub.index().imports, {});
  assert.deepEqual(Object.keys(hub.index().files), [COVER]);
  assert.match(hub.index().files[COVER], /\/flags-1\/p3-aaaaaaaa\.png$/);
});

test("a new version replaces the old file, and keeps its downloads", async () => {
  const hub = await installed({ issues: [post(12, "scenario", FILE)], files: { [FILE]: zipBytes(), [FILE_V2]: zipBytes(90) } });
  hub.downloaded("p12-501-world-scenario.zip", 7);
  hub.issues.get(12).body = FILE_V2;
  await run(hub);
  assert.equal(hub.did("deleteAsset").length, 1);
  assert.deepEqual(Object.keys(hub.index().files), [FILE_V2]);
  assert.deepEqual(hub.index().imports, { 12: 7 });
  hub.downloaded("p12-502-world-scenario.zip", 2);
  await run(hub);
  assert.deepEqual(hub.index().imports, { 12: 9 });
});

test("a closed post's files are deleted; reopened, it is copied again and keeps its count", async () => {
  const hub = await installed({ issues: [post(12, "scenario", FILE)], files: { [FILE]: zipBytes() } });
  hub.downloaded("p12-501-world-scenario.zip", 4);
  hub.issues.get(12).state = "closed";
  const closed = await run(hub);
  assert.equal(closed.summary.retired, 1);
  assert.equal(hub.releases[0].assets.length, 0);
  assert.deepEqual(hub.index(), { version: 1, files: {}, imports: {}, generatedAt: "2026-10-05T12:00:00.000Z" });
  hub.issues.get(12).state = "open";
  await run(hub);
  assert.equal(hub.releases[0].assets.length, 1);
  assert.deepEqual(hub.index().imports, { 12: 4 });
});

test("a deleted post's files are deleted too", async () => {
  const hub = await installed({ issues: [post(12, "scenario", FILE)], files: { [FILE]: zipBytes() } });
  hub.issues.delete(12);
  await run(hub);
  assert.equal(hub.releases[0].assets.length, 0);
  assert.deepEqual(hub.state().posts, {});
});

test("a post only missing from the list is left alone", async () => {
  const hub = await installed({ issues: [post(12, "scenario", FILE)], files: { [FILE]: zipBytes() } });
  const listOpenPosts = hub.client.listOpenPosts;
  hub.client.listOpenPosts = async () => []; // a list that came back short
  await run(hub);
  assert.equal(hub.did("deleteAsset").length, 0);
  assert.equal(hub.releases[0].assets.length, 1);
  hub.client.listOpenPosts = listOpenPosts;
  hub.client.getIssue = async () => { throw new Error("GitHub answered 502"); };
  hub.issues.get(12).state = "closed";
  await run(hub);
  assert.equal(hub.did("deleteAsset").length, 0, "nothing is deleted on a lookup that failed");
});

test("a new post with no file gets a comment and the label; fixed, both go", async () => {
  const hub = await installed();
  hub.issues.set(20, post(20, "scenario", "### Description\n\nMy world, no file."));
  await run(hub);
  assert.equal(hub.did("createComment").length, 1);
  const [comment] = hub.comments.values();
  assert.ok(comment.body.startsWith(COMMENT_MARKER));
  assert.match(comment.body, /No scenario file is attached/);
  assert.match(comment.body, /Edit this post/);
  assert.ok(hub.issues.get(20).labels.some((label) => label.name === PROBLEM_LABEL));
  // The same problem on the next run: not said twice.
  await run(hub);
  assert.equal(hub.did("createComment").length, 1);
  assert.equal(hub.did("updateComment").length, 0);
  // The author attaches the file.
  hub.issues.get(20).body = `My world. ${FILE}`;
  hub.files.set(FILE, jsonBytes());
  await run(hub);
  assert.equal(hub.comments.size, 0);
  assert.ok(!hub.issues.get(20).labels.some((label) => label.name === PROBLEM_LABEL));
  assert.match(hub.index().files[FILE], /p20-501-world-scenario\.json$/, "named for what it is, not what it was called");
});

test("a post that was already broken when this started is labelled, not commented on, until it is edited", async () => {
  const hub = fakeHub({ issues: [post(5, "flag", "### Flag image\n\n_No response_")] });
  await run(hub);
  assert.equal(hub.comments.size, 0);
  assert.ok(hub.issues.get(5).labels.some((label) => label.name === PROBLEM_LABEL));
  await run(hub);
  assert.equal(hub.comments.size, 0);
  hub.issues.get(5).body = "### Flag image\n\nstill nothing";
  await run(hub);
  assert.equal(hub.comments.size, 1);
  assert.match([...hub.comments.values()][0].body, /No flag image is attached/);
});

test("a file that is gone, too large or the wrong thing is said plainly", async () => {
  const hub = await installed();
  const big = "https://github.com/user-attachments/files/601/huge-scenario.zip";
  const wrong = "https://github.com/user-attachments/files/602/picture.zip";
  hub.issues.set(31, post(31, "scenario", FILE)); // 404
  hub.issues.set(32, post(32, "scenario", big));
  hub.issues.set(33, post(33, "scenario", wrong));
  hub.files.set(big, { tooLarge: 231 * 1048576 });
  hub.files.set(wrong, pngBytes());
  await run(hub);
  const bodies = Object.fromEntries([...hub.comments.values()].map((comment) => [comment.number, comment.body]));
  assert.match(bodies[31], /`world-scenario\.zip` can't be downloaded any more \(GitHub answered 404\)\. Attach it again\./);
  assert.match(bodies[32], /`huge-scenario\.zip` can't be used: it is 231 MB, and the game can import 200 MB at most\./);
  assert.match(bodies[33], /`picture\.zip` can't be used: it is a picture, not a scenario file/);
  for (const body of Object.values(bodies)) {
    // The game reads a comment that carries a .zip attachment's address as a
    // suggestion on the post. These must never be one.
    assert.doesNotMatch(body, /https?:\/\//);
  }
  assert.deepEqual(hub.index().files, {});
});

test("GitHub not answering is not the author's problem: no comment until it has lasted", async () => {
  const hub = await installed();
  hub.issues.set(40, post(40, "scenario", FILE));
  hub.files.set(FILE, Object.assign(new Error("GitHub answered 502"), { transient: true }));
  for (let attempt = 1; attempt < TRANSIENT_RUNS_BEFORE_COMMENT; attempt += 1) {
    await run(hub);
    assert.equal(hub.comments.size, 0, `run ${attempt}`);
    assert.ok(!hub.issues.get(40).labels.some((label) => label.name === PROBLEM_LABEL));
  }
  await run(hub);
  assert.equal(hub.comments.size, 1);
  assert.match([...hub.comments.values()][0].body, /Nothing needs changing in the post/);
  hub.files.set(FILE, zipBytes());
  await run(hub);
  assert.equal(hub.comments.size, 0);
  assert.equal(Object.keys(hub.index().files).length, 1);
});

test("something else attached that will not copy is skipped without a word", async () => {
  const notes = "https://github.com/user-attachments/files/700/notes.txt";
  const gone = "https://github.com/user-attachments/assets/bbbbbbbb-1111-2222-3333-444444444444";
  const hub = await installed();
  hub.issues.set(41, post(41, "scenario", `${FILE}\n[notes](${notes})\n![shot](${gone})`));
  hub.files.set(FILE, zipBytes());
  hub.files.set(notes, Buffer.from("just some notes"));
  await run(hub);
  assert.equal(hub.comments.size, 0);
  assert.deepEqual(Object.keys(hub.index().files), [FILE]);
});

test("a post whose file is already in this repository's releases is not copied, only counted from here on", async () => {
  const old = "https://github.com/Arkniem/pax-historia-scenarios/releases/download/bundles/roman-117.json";
  const hub = fakeHub({
    issues: [post(4, "scenario", `Scenario file: ${old}`)],
    releases: [{ id: 1, tag: "bundles", assets: [{ id: 11, name: "roman-117.json", url: `https://github.com/${REPO}/releases/download/bundles/roman-117.json`, size: 9, downloads: 379 }] }],
  });
  const options = { aliases: ["Arkniem/pax-historia-scenarios"], legacy: { 4: 209 } };
  await run(hub, options);
  assert.equal(hub.did("download").length, 0);
  assert.equal(hub.did("uploadAsset").length, 0);
  assert.deepEqual(hub.index().files, { [old]: `https://github.com/${REPO}/releases/download/bundles/roman-117.json` });
  assert.deepEqual(hub.index().imports, { 4: 209 }, "its 379 downloads so far are what the old counter already counted");
  hub.downloaded("roman-117.json", 3);
  await run(hub, options);
  assert.deepEqual(hub.index().imports, { 4: 212 });
  // A release in somebody else's repository is copied like any other file.
  const foreign = "https://github.com/someone/their-maps/releases/download/v1/big-scenario.zip";
  hub.issues.set(50, post(50, "scenario", foreign));
  hub.files.set(foreign, zipBytes());
  await run(hub, options);
  assert.match(hub.index().files[foreign], /\/scenarios-1\/p50-[0-9a-f]{8}-big-scenario\.zip$/);
});

test("a file copied by a run that then failed is taken as it is, not copied twice", async () => {
  const hub = fakeHub({
    issues: [post(12, "scenario", FILE)],
    files: { [FILE]: zipBytes() },
    releases: [{ id: 1, tag: "scenarios-1", assets: [{ id: 77, name: "p12-501-world-scenario.zip", url: `https://github.com/${REPO}/releases/download/scenarios-1/p12-501-world-scenario.zip`, size: 64, downloads: 2 }] }],
  });
  await run(hub);
  assert.equal(hub.did("download").length, 0);
  assert.equal(hub.did("uploadAsset").length, 0);
  assert.deepEqual(hub.index().imports, { 12: 2 });
});

test("a run copies at most so many files and leaves the rest for the next", async () => {
  const a = "https://github.com/user-attachments/files/801/a.zip";
  const b = "https://github.com/user-attachments/files/802/b.zip";
  const hub = fakeHub({ issues: [post(1, "scenario", a), post(2, "scenario", b)], files: { [a]: zipBytes(), [b]: zipBytes() } });
  const first = await run(hub, { maxUploads: 1 });
  assert.equal(first.summary.copied, 1);
  assert.equal(first.summary.deferred, 1);
  assert.equal(hub.comments.size, 0, "a file not reached yet is not a problem with the post");
  await run(hub, { maxUploads: 1 });
  assert.equal(Object.keys(hub.index().files).length, 2);
});

test("a listing that fails ends the run before anything is changed", async () => {
  const hub = await installed({ issues: [post(12, "scenario", FILE)], files: { [FILE]: zipBytes() } });
  hub.client.listReleases = async () => { throw new Error("GitHub answered 500"); };
  await assert.rejects(run(hub), /500/);
  assert.deepEqual(hub.calls, []);
});
