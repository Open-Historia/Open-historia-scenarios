// Run: npm test
import assert from "node:assert/strict";
import test from "node:test";

import { readImage } from "../lib/images.mjs";
import { assetName } from "../lib/posts.mjs";
import { COMMENT_MARKER, PIPELINE, PROBLEM_LABEL, REPLACED_COPY_MINUTES, TRANSIENT_RUNS_BEFORE_COMMENT, normalizeState } from "../lib/sync.mjs";
import { sha256 } from "../lib/util.mjs";
import { readZip } from "../lib/zip.mjs";
import { REPO, at, fakeHub, installed, post, run } from "./fake-client.mjs";
import { SVG, png, rawZip, scenario, scenarioJson, scenarioZip, zip } from "./fixtures.mjs";


const FILE = "https://github.com/user-attachments/files/501/world-scenario.zip";
const FILE_V2 = "https://github.com/user-attachments/files/502/world-scenario.zip";
const COVER = "https://github.com/user-attachments/assets/aaaaaaaa-1111-2222-3333-444444444444";
const ZIP = scenarioZip();
const ZIP_V2 = scenarioZip({ scenario: { id: "test-world", name: "Test world, second edition" } });
const PNG = png({ width: 60, height: 40 });

const entriesOf = (bytes) => Object.fromEntries(readZip(bytes).filter((entry) => !entry.directory).map((entry) => [entry.name, entry.read().toString("utf8")]));
const labelled = (hub, number) => hub.issues.get(number).labels.some((label) => label.name === PROBLEM_LABEL);

test("a post's file is checked, and its checked copy goes into a release", async () => {
  // As the game's zip writer leaves one: a folder entry, and a comment here.
  const attached = rawZip([{ name: "assets/" }, { name: "scenario.json", data: JSON.stringify(scenario()), method: 8 }], { comment: "exported" });
  const hub = fakeHub({
    issues: [post(12, "scenario", `![cover](${COVER})\n[file](${FILE})`)],
    files: { [FILE]: attached, [COVER]: PNG },
  });
  const { summary } = await run(hub);
  assert.equal(summary.copied, 2);
  assert.deepEqual(hub.did("createRelease"), [["createRelease", "scenarios-1"]]);
  const file = hub.asset("p12-501-");
  const cover = hub.asset("p12-aaaaaaaa-");
  // Named for the post, the attachment, itself, and the bytes it holds.
  assert.match(file.name, /^p12-501-world-scenario-[0-9a-f]{8}\.zip$/);
  assert.match(cover.name, /^p12-aaaaaaaa-[0-9a-f]{8}\.png$/);
  assert.equal(file.name, `p12-501-world-scenario-${sha256(hub.uploaded.get(file.name)).slice(0, 8)}.zip`);
  assert.deepEqual(hub.did("uploadAsset").map(([, , type]) => type), ["application/zip", "image/png"]);
  // The picture is the attached one. The zip is not: it was written again from
  // its entries, and holds what they held.
  assert.ok(hub.uploaded.get(cover.name).equals(PNG));
  assert.ok(!hub.uploaded.get(file.name).equals(attached));
  assert.deepEqual(entriesOf(hub.uploaded.get(file.name)), { "scenario.json": JSON.stringify(scenario()) });
  const index = hub.index();
  assert.equal(index.version, 2);
  assert.deepEqual(index.files, { [FILE]: file.url, [COVER]: cover.url });
  assert.deepEqual(index.imports, {}, "nothing downloaded yet");
  assert.deepEqual(index.posts.map((entry) => entry.number), [12]);
  assert.equal(hub.did("createComment").length, 0);
  assert.equal(hub.did("closeIssue").length, 0, "nothing is closed unless the hub is set to");
});

test("a run with nothing to do downloads nothing and writes nothing", async () => {
  const hub = await installed({ issues: [post(12, "scenario", `![c](${COVER})\n${FILE}`), post(3, "flag", `![f](${COVER})`)], files: { [FILE]: ZIP, [COVER]: PNG } });
  const { summary } = await run(hub, { now: at(30) });
  assert.deepEqual(hub.calls, []);
  assert.equal(summary.written, undefined);
});

test("what is released is the checked file, not always the attached one", async () => {
  const drawn = "https://github.com/user-attachments/files/123/arland.svg";
  const padded = "https://github.com/user-attachments/assets/bbbbbbbb-1111-2222-3333-444444444444";
  const hub = fakeHub({
    issues: [post(5, "flag", `### Flag image\n\n[arland.svg](${drawn})`), post(6, "flag", `<img width="300" alt="x" src="${padded}" />`)],
    files: { [drawn]: Buffer.from(SVG), [padded]: Buffer.concat([PNG, Buffer.from("PK\x03\x04 and a second file")]) },
  });
  await run(hub);
  // An SVG's copy is the PNG it was drawn as.
  const flag = hub.asset("p5-123-");
  assert.match(flag.name, /^p5-123-arland-[0-9a-f]{8}\.png$/);
  assert.deepEqual(hub.did("uploadAsset").find(([, name]) => name === flag.name), ["uploadAsset", flag.name, "image/png"]);
  assert.deepEqual(readImage(hub.uploaded.get(flag.name)), { type: "png", width: 1024, height: 683, length: flag.size });
  assert.equal(hub.index().files[drawn], flag.url);
  // A picture with something after its end is released without it.
  assert.ok(hub.uploaded.get(hub.asset("p6-bbbbbbbb-").name).equals(PNG));
  assert.deepEqual(hub.state().posts[5].files[0].repairs, ["SVG drawn as a 1024×683 PNG"]);
  assert.equal(hub.comments.size, 0, "a repair is not a problem");
});

test("a file with a problem is not released, and the post is told what is wrong with it", async () => {
  const hub = await installed();
  hub.issues.set(20, post(20, "scenario", `![c](${COVER})\n${FILE}`));
  hub.files.set(COVER, PNG);
  hub.files.set(FILE, scenarioZip({ assets: { flags: { data: { France: "https://evil.example/track.png" }, fileName: "flags.json", mode: "embedded" } } }, { "setup.exe": "MZ" }));
  await run(hub);
  assert.equal(hub.assets().length, 0, "nothing of the post is released, its cover neither");
  const index = hub.index();
  assert.deepEqual([index.files, index.posts], [{}, []]);
  const [comment] = hub.said(20);
  assert.ok(comment.startsWith(COMMENT_MARKER));
  assert.match(comment, /This post's scenario file could not be added to the hub/);
  assert.match(comment, /- `scenario\.json` holds a flag that is loaded from another website \(`evil\.example`, key `France`\): a flag has to be carried in the file itself\./);
  assert.match(comment, /- `setup\.exe` is not something the game uses/);
  assert.match(comment, /Edit this post/);
  assert.ok(labelled(hub, 20));
  // The same problem on the next runs: not looked at again, not said twice.
  hub.calls.length = 0;
  await run(hub, { now: at(20) });
  assert.deepEqual(hub.calls, [["writeData", "index.json,state.json"]], "only that the post has one more comment now");
  await run(hub, { now: at(30) });
  assert.equal(hub.calls.length, 1);
  // The author attaches a file that is right.
  hub.issues.get(20).body = `![c](${COVER})\n${FILE_V2}`;
  hub.files.set(FILE_V2, ZIP);
  await run(hub, { now: at(60) });
  assert.equal(hub.comments.size, 0);
  assert.ok(!labelled(hub, 20));
  assert.deepEqual(Object.keys(hub.index().files), [FILE_V2, COVER]);
});

test("nothing a file names can turn the workflow's comment into a suggestion", async () => {
  const hub = await installed();
  hub.issues.set(21, post(21, "scenario", FILE));
  hub.files.set(FILE, scenarioZip({ assets: { flags: { data: { "https://github.com/user-attachments/files/9/key-suggestion.zip": "ftp://x" }, fileName: "flags.json", mode: "embedded" } } }, {
    "https://github.com/user-attachments/files/9/world-suggestion.zip": "x",
    "a`b](https://evil.example) @everyone.exe": "x",
  }));
  await run(hub);
  const [comment] = hub.said(21);
  assert.match(comment, /is not something the game uses/);
  // The game reads a comment that carries a .zip attachment's address as a
  // suggestion on the post, and anything with an address in it as a link.
  assert.doesNotMatch(comment, /https?:\/\/|github\.com/);
  // And what is quoted stands in code spans, where nothing is a link or a mention.
  assert.doesNotMatch(comment.replace(/`[^`\n]*`/g, ""), /\]\(|@|evil/);
  assert.equal(comment.split("`").length % 2, 1, "every code span is closed");
});

test("imports are the file's downloads, on top of what the old counter had", async () => {
  const hub = await installed({ issues: [post(12, "scenario", `![c](${COVER})\n${FILE}`)], files: { [FILE]: ZIP, [COVER]: PNG } });
  hub.downloaded("p12-501-", 5);
  hub.downloaded("p12-aaaaaaaa-", 40); // a picture being looked at is not an import
  await run(hub, { legacy: { 12: 100 } });
  assert.deepEqual(hub.index().imports, { 12: 105 });
});

test("only scenario posts are counted", async () => {
  const hub = await installed({ issues: [post(3, "flag", `![f](${COVER})`)], files: { [COVER]: PNG } });
  hub.downloaded("p3-aaaaaaaa-", 9);
  await run(hub);
  assert.deepEqual(hub.index().imports, {});
  assert.deepEqual(Object.keys(hub.index().files), [COVER]);
  assert.match(hub.index().files[COVER], /\/flags-1\/p3-aaaaaaaa-[0-9a-f]{8}\.png$/);
});

test("a new version replaces the old copy, which is deleted a run later, and no download is lost", async () => {
  const hub = await installed({ issues: [post(12, "scenario", FILE)], files: { [FILE]: ZIP, [FILE_V2]: ZIP_V2 } });
  hub.downloaded("p12-501-", 7);
  hub.issues.get(12).body = FILE_V2;
  await run(hub, { now: at(1) });
  // The index names the new copy. The old one is still there: a game holds the
  // index for five minutes, and may ask for what the old one named.
  assert.deepEqual(Object.keys(hub.index().files), [FILE_V2]);
  assert.ok(hub.asset("p12-501-") && hub.asset("p12-502-"));
  assert.equal(hub.did("deleteAsset").length, 0);
  assert.deepEqual(hub.index().imports, { 12: 7 });
  hub.downloaded("p12-501-", 1); // just such a game
  hub.downloaded("p12-502-", 2);
  await run(hub, { now: at(2) });
  assert.equal(hub.did("deleteAsset").length, 0, "a run a minute later is too soon");
  assert.deepEqual(hub.index().imports, { 12: 10 });
  await run(hub, { now: at(1 + REPLACED_COPY_MINUTES) });
  assert.equal(hub.did("deleteAsset").length, 1);
  assert.ok(!hub.asset("p12-501-") && hub.asset("p12-502-"));
  assert.deepEqual(hub.index().imports, { 12: 10 }, "what the old copy had counted is carried");
  hub.downloaded("p12-502-", 5);
  await run(hub, { now: at(60) });
  assert.deepEqual(hub.index().imports, { 12: 15 });
});

test("a copy deleted by hand is made again, and what it had counted is kept", async () => {
  const hub = await installed({ issues: [post(12, "scenario", FILE)], files: { [FILE]: ZIP } });
  hub.downloaded("p12-501-", 6);
  await run(hub);
  assert.deepEqual(hub.index().imports, { 12: 6 });
  hub.releases[0].assets = [];
  await run(hub, { now: at(30) });
  assert.ok(hub.asset("p12-501-"));
  assert.deepEqual(hub.index().imports, { 12: 6 });
});

test("a closed post's files are deleted; reopened, it is checked again and keeps its count", async () => {
  const hub = await installed({ issues: [post(12, "scenario", FILE)], files: { [FILE]: ZIP } });
  hub.downloaded("p12-501-", 4);
  Object.assign(hub.issues.get(12), { state: "closed", state_reason: "completed" });
  const closed = await run(hub);
  assert.equal(closed.summary.retired, 1);
  assert.equal(hub.assets().length, 0);
  assert.deepEqual(hub.index(), { version: 2, files: {}, imports: {}, posts: [], suggestions: {}, generatedAt: at(0).toISOString() });
  Object.assign(hub.issues.get(12), { state: "open", state_reason: "reopened" });
  await run(hub, { now: at(30) });
  assert.equal(hub.assets().length, 1);
  assert.deepEqual(hub.index().imports, { 12: 4 });
  assert.deepEqual(hub.index().posts.map((entry) => entry.number), [12]);
});

test("a post that lost its label, or was deleted, leaves the hub too", async () => {
  const hub = await installed({ issues: [post(12, "scenario", FILE), post(13, "scenario", FILE_V2)], files: { [FILE]: ZIP, [FILE_V2]: ZIP_V2 } });
  hub.issues.get(12).labels = [{ name: "question" }];
  hub.issues.delete(13);
  await run(hub);
  assert.equal(hub.assets().length, 0);
  assert.deepEqual(hub.state().posts, {});
  assert.deepEqual(hub.index().posts, []);
});

test("a post only missing from the list is left alone", async () => {
  const hub = await installed({ issues: [post(12, "scenario", FILE)], files: { [FILE]: ZIP } });
  hub.client.listPosts = async () => []; // a list that came back short
  await run(hub);
  assert.equal(hub.did("deleteAsset").length, 0);
  assert.equal(hub.assets().length, 1);
  assert.deepEqual(Object.keys(hub.index().files), [FILE]);
  hub.client.getIssue = async () => { throw new Error("GitHub answered 502"); };
  await run(hub);
  assert.equal(hub.did("deleteAsset").length, 0, "nothing is deleted on a lookup that failed");
});

test("a post with no file gets a comment and the label; fixed, both go", async () => {
  // Whether the post is new or was there before the checks were: an old post
  // with a problem is told like any other.
  const hub = fakeHub({ issues: [post(20, "scenario", "### Description\n\nMy world, no file."), post(5, "flag", "### Flag image\n\n_No response_")] });
  await run(hub);
  assert.equal(hub.did("createComment").length, 2);
  assert.ok(hub.said(20)[0].startsWith(COMMENT_MARKER));
  assert.match(hub.said(20)[0], /No scenario file is attached/);
  assert.match(hub.said(20)[0], /Edit this post/);
  assert.match(hub.said(5)[0], /No flag image is attached/);
  assert.ok(labelled(hub, 20) && labelled(hub, 5));
  // The same problem on the next run: not said twice.
  await run(hub, { now: at(30) });
  assert.equal(hub.did("createComment").length, 2);
  assert.equal(hub.did("updateComment").length, 0);
  // The author attaches the file.
  hub.issues.get(20).body = `My world. ${FILE}`;
  hub.files.set(FILE, scenarioJson());
  await run(hub, { now: at(60) });
  assert.deepEqual(hub.said(20), []);
  assert.ok(!labelled(hub, 20) && labelled(hub, 5));
  assert.match(hub.index().files[FILE], /p20-501-world-scenario-[0-9a-f]{8}\.json$/, "named for what it is, not what it was called");
});

test("a post whose text is written to be slow to search is told so, and is not searched again", async () => {
  const slow = `${"https://github.com/".repeat(1700)}${"/releases/download/".repeat(1700)} ${FILE}`;
  const hub = fakeHub({ issues: [post(21, "scenario", slow), post(22, "scenario", FILE_V2)], files: { [FILE]: ZIP, [FILE_V2]: ZIP_V2 } });
  const started = Date.now();
  await run(hub);
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
  assert.match(hub.said(21)[0], /This post's text can't be searched for its file: it repeats the start of a link so many times/);
  assert.ok(labelled(hub, 21));
  assert.deepEqual(hub.index().posts.map((entry) => entry.number), [22], "the other post is released, and this one is not on the hub");
  assert.deepEqual(hub.did("download").map(([, url]) => url), [FILE_V2]);
  // Edited to plain text and the file, it is released like any other.
  hub.issues.get(21).body = `My world. ${FILE}`;
  await run(hub, { now: at(30) });
  assert.deepEqual(hub.said(21), []);
  assert.ok(!labelled(hub, 21));
  assert.deepEqual(hub.index().posts.map((entry) => entry.number).sort(), [21, 22]);
});

test("a file that is gone, too large or the wrong thing is said plainly", async () => {
  const hub = await installed();
  const big = "https://github.com/user-attachments/files/601/huge-scenario.zip";
  const wrong = "https://github.com/user-attachments/files/602/picture.zip";
  hub.issues.set(31, post(31, "scenario", FILE)); // 404
  hub.issues.set(32, post(32, "scenario", big));
  hub.issues.set(33, post(33, "scenario", wrong));
  hub.issues.set(34, post(34, "flag", `![f](${COVER})`));
  hub.files.set(big, { tooLarge: 231 * 1048576 });
  hub.files.set(wrong, PNG);
  hub.files.set(COVER, Buffer.from("<html>Not Found</html>"));
  await run(hub);
  assert.match(hub.said(31)[0], /`world-scenario\.zip` can't be downloaded any more \(GitHub answered 404\)\. Attach it again\./);
  assert.match(hub.said(32)[0], /`huge-scenario\.zip` can't be used: it is 231 MB, and the game can import 200 MB at most\./);
  assert.match(hub.said(33)[0], /`picture\.zip` can't be used: it is a picture, not a scenario file/);
  assert.match(hub.said(34)[0], /The attached image can't be used: it is not an image the game can read/);
  for (const number of [31, 32, 33, 34]) {
    // The game reads a comment that carries a .zip attachment's address as a
    // suggestion on the post. These must never be one.
    assert.doesNotMatch(hub.said(number)[0], /https?:\/\//);
  }
  assert.deepEqual(hub.index().files, {});
});

test("GitHub not answering is not the author's problem: no comment until it has lasted", async () => {
  const hub = await installed();
  hub.issues.set(40, post(40, "scenario", FILE));
  hub.files.set(FILE, Object.assign(new Error("GitHub answered 502"), { transient: true }));
  for (let attempt = 1; attempt < TRANSIENT_RUNS_BEFORE_COMMENT; attempt += 1) {
    await run(hub, { now: at(30 * attempt) });
    assert.equal(hub.comments.size, 0, `run ${attempt}`);
    assert.ok(!labelled(hub, 40));
  }
  await run(hub, { now: at(200) });
  assert.equal(hub.comments.size, 1);
  assert.match(hub.said(40)[0], /Nothing needs changing in the post/);
  hub.files.set(FILE, ZIP);
  await run(hub, { now: at(230) });
  assert.equal(hub.comments.size, 0);
  assert.equal(Object.keys(hub.index().files).length, 1);
});

test("something else attached that will not copy is skipped without a word", async () => {
  const notes = "https://github.com/user-attachments/files/700/notes.txt";
  const gone = "https://github.com/user-attachments/assets/bbbbbbbb-1111-2222-3333-444444444444";
  const broken = "https://github.com/user-attachments/assets/cccccccc-1111-2222-3333-444444444444";
  const hub = await installed();
  hub.issues.set(41, post(41, "scenario", `${FILE}\n[notes](${notes})\n![shot](${gone})\n![cut](${broken})`));
  hub.files.set(FILE, ZIP);
  hub.files.set(notes, Buffer.from("just some notes"));
  hub.files.set(broken, PNG.subarray(0, 40));
  await run(hub);
  assert.equal(hub.comments.size, 0);
  assert.deepEqual(Object.keys(hub.index().files), [FILE]);
  assert.deepEqual(hub.index().posts.map((entry) => entry.number), [41]);
});

test("a file linked from this repository's older releases is checked and copied like any other", async () => {
  const old = "https://github.com/Arkniem/pax-historia-scenarios/releases/download/bundles/roman-117.json";
  const bundle = scenarioJson({ hubOrigin: { postId: 4, bundleUrl: old } });
  const hub = fakeHub({
    issues: [post(4, "scenario", `Scenario file: ${old}`)],
    releases: [{ id: 1, tag: "bundles", assets: [{ id: 11, name: "roman-117.json", url: `https://github.com/${REPO}/releases/download/bundles/roman-117.json`, size: bundle.length, downloads: 379 }] }],
    files: { [old]: bundle },
  });
  const options = { aliases: ["Arkniem/pax-historia-scenarios"], legacy: { 4: 209 } };
  await run(hub, options);
  // Downloaded from where the post links it, checked, put right, and released
  // under the workflow's own name.
  assert.deepEqual(hub.did("download"), [["download", old]]);
  const copy = hub.asset("p4-");
  assert.match(copy.name, /^p4-[0-9a-f]{8}-roman-117-[0-9a-f]{8}\.json$/);
  assert.equal(copy.tag, "scenarios-1");
  assert.equal(JSON.parse(hub.uploaded.get(copy.name)).hubOrigin, undefined);
  assert.deepEqual(hub.index().files, { [old]: copy.url });
  assert.deepEqual(hub.index().imports, { 4: 209 }, "its 379 downloads so far are what the old counter already counted");
  // The old file stays where it is: games from before the index download it directly.
  assert.ok(hub.asset("roman-117.json"));
  assert.equal(hub.did("deleteAsset").length, 0);
  hub.downloaded("roman-117.json", 3); // an older game
  hub.downloaded("p4-", 2); // a newer one
  await run(hub, options);
  assert.deepEqual(hub.index().imports, { 4: 214 }, "both are the post's imports");
  // The link taken out of the post and put back: nothing is counted twice.
  hub.issues.get(4).body = "Scenario file: coming back soon";
  await run(hub, { ...options, now: at(30) });
  hub.issues.get(4).body = `Scenario file: ${old}`;
  hub.downloaded("roman-117.json", 1);
  await run(hub, { ...options, now: at(60) });
  assert.deepEqual(hub.index().imports, { 4: 215 });

  // A release in somebody else's repository is a file like any other.
  const foreign = "https://github.com/someone/their-maps/releases/download/v1/big-scenario.zip";
  hub.issues.set(50, post(50, "scenario", foreign));
  hub.files.set(foreign, ZIP);
  // And so is a link to one of the workflow's own copies: it brings no count with it.
  hub.downloaded("p4-", 100);
  hub.issues.set(51, post(51, "scenario", copy.url));
  hub.files.set(copy.url, hub.uploaded.get(copy.name));
  await run(hub, { ...options, now: at(90) });
  assert.match(hub.index().files[foreign], /\/scenarios-1\/p50-[0-9a-f]{8}-big-scenario-[0-9a-f]{8}\.zip$/);
  assert.match(hub.index().files[copy.url], /\/scenarios-1\/p51-[0-9a-f]{8}-p4-/);
  assert.equal(hub.index().imports[51], undefined);
  assert.equal(hub.index().imports[4], 315);
});

test("a copy uploaded by a run that then failed is taken as it is, not uploaded twice", async () => {
  const name = assetName({ post: 12, source: FILE, type: "zip", sha256: sha256(ZIP) });
  const hub = fakeHub({
    issues: [post(12, "scenario", FILE)],
    files: { [FILE]: ZIP },
    releases: [{ id: 1, tag: "scenarios-1", assets: [{ id: 77, name, url: `https://github.com/${REPO}/releases/download/scenarios-1/${name}`, size: ZIP.length, downloads: 2 }] }],
  });
  await run(hub);
  assert.equal(hub.did("uploadAsset").length, 0);
  assert.deepEqual(hub.index().files, { [FILE]: `https://github.com/${REPO}/releases/download/scenarios-1/${name}` });
  assert.deepEqual(hub.index().imports, { 12: 2 });
});

test("a run uploads at most so many files and leaves the rest for the next", async () => {
  const a = "https://github.com/user-attachments/files/801/a.zip";
  const b = "https://github.com/user-attachments/files/802/b.zip";
  const hub = fakeHub({ issues: [post(1, "scenario", a), post(2, "scenario", b)], files: { [a]: ZIP, [b]: ZIP_V2 } });
  const first = await run(hub, { maxUploads: 1 });
  assert.equal(first.summary.copied, 1);
  assert.equal(first.summary.deferred, 1);
  assert.equal(hub.comments.size, 0, "a file not reached yet is not a problem with the post");
  assert.equal(hub.index().posts.length, 1);
  await run(hub, { maxUploads: 1, now: at(30) });
  assert.equal(Object.keys(hub.index().files).length, 2);
});

test("a listing that fails ends the run before anything is changed", async () => {
  const hub = await installed({ issues: [post(12, "scenario", FILE)], files: { [FILE]: ZIP } });
  hub.issues.get(12).body = FILE_V2;
  hub.client.listReleases = async () => { throw new Error("GitHub answered 500"); };
  await assert.rejects(run(hub), /500/);
  assert.deepEqual(hub.calls, []);
});

test("a release that will not take a file is not the author's problem either", async () => {
  const hub = await installed();
  hub.issues.set(40, post(40, "scenario", FILE));
  hub.files.set(FILE, ZIP);
  const uploadAsset = hub.client.uploadAsset;
  hub.client.uploadAsset = async () => { throw Object.assign(new Error("POST /repos/x/releases/1/assets answered 422: validation failed"), { status: 422, transient: false }); };
  const lines = [];
  await run(hub, { log: (line) => lines.push(line) });
  await run(hub, { now: at(30) });
  assert.match(lines.join("\n"), /#40: p40-501-world-scenario-[0-9a-f]{8}\.zip could not be uploaded \(POST .* answered 422/);
  assert.equal(hub.comments.size, 0);
  assert.ok(!labelled(hub, 40));
  assert.deepEqual(hub.index().posts, []);
  await run(hub, { now: at(60) });
  assert.match(hub.said(40)[0], /`world-scenario\.zip` is in order, but could not be put into the hub's releases just now\.[\s\S]*Nothing needs changing in the post/);
  hub.client.uploadAsset = uploadAsset;
  await run(hub, { now: at(90) });
  assert.equal(hub.comments.size, 0);
  assert.deepEqual(hub.index().posts.map((entry) => entry.number), [40]);
});

test("a run that is out of time starts nothing new, and writes down what it did", async () => {
  const hub = await installed({ issues: [post(12, "scenario", FILE)], files: { [FILE]: ZIP, [FILE_V2]: ZIP_V2 } });
  hub.issues.set(13, post(13, "scenario", FILE_V2));
  hub.downloaded("p12-501-", 3);
  const out = await run(hub, { now: at(30), deadline: 0 });
  assert.deepEqual(hub.did("download"), []);
  assert.equal(out.summary.deferred, 1);
  assert.equal(hub.comments.size, 0, "a post not reached is not a post with a problem");
  assert.deepEqual(hub.index().imports, { 12: 3 }, "what needs no work is still brought up to date");
  await run(hub, { now: at(60) });
  assert.deepEqual(hub.index().posts.map((entry) => entry.number).sort(), [12, 13]);
});

test("a fault in the checks costs one post a run, not the run", async () => {
  const hub = await installed();
  hub.issues.set(60, post(60, "scenario", FILE));
  hub.issues.set(61, post(61, "flag", `![f](${COVER})`));
  hub.files.set(FILE, ZIP);
  hub.files.set(COVER, PNG);
  // Something the checks were not written for: a download that hands back no bytes.
  const download = hub.client.download;
  let tries = 0;
  hub.client.download = async (url) => (url === FILE ? (tries += 1, { bytes: null, size: 1, sha256: "" }) : download(url));
  const lines = [];
  await run(hub, { log: (line) => lines.push(line) });
  assert.match(lines.join("\n"), /#60: `world-scenario\.zip` could not be checked: TypeError/);
  assert.equal(hub.comments.size, 0, "not the author's problem");
  assert.deepEqual(hub.index().posts.map((entry) => entry.number), [61], "the other post is released all the same");
  // A fault does not mend by being tried at once: the post is tried again
  // after half an hour, then an hour after that, then two, and so on.
  const triedAt = [];
  for (const minute of [5, 30, 45, 60, 90, 120, 180, 210]) {
    const before = tries;
    await run(hub, { now: at(minute) });
    if (tries > before) triedAt.push(minute);
  }
  assert.deepEqual(triedAt, [30, 90, 210]);
  assert.match(hub.said(60)[0], /could not be checked just now \(an error on the hub's side\)[\s\S]*Nothing needs changing in the post/);
  // Mended (or the post edited): it goes through at its next try.
  hub.client.download = download;
  await run(hub, { now: at(215) });
  assert.deepEqual(hub.index().posts.map((entry) => entry.number).sort(), [61], "not before its time");
  hub.issues.get(60).body = `My world, attached again. ${FILE}`;
  await run(hub, { now: at(216) });
  assert.deepEqual(hub.index().posts.map((entry) => entry.number).sort(), [60, 61]);
  assert.deepEqual(hub.said(60), []);
});

// ---- the index ------------------------------------------------------------------

test("the index lists the released posts as the game reads them", async () => {
  const hub = fakeHub({
    issues: [
      post(12, "scenario", `### Description\n\nA world.\n\n![cover](${COVER})\n[file](${FILE})\n\n### Made by\n\nme`, {
        title: "[Scenario] The long war",
        labels: [{ name: "scenario" }, { name: "pinned" }],
        user: { login: "arkniem", type: "User", avatar_url: "https://avatars.githubusercontent.com/u/9?v=4" },
        author_association: "OWNER",
        reactions: { "+1": 3, rocket: 1 },
        comments: 11,
        created_at: "2026-09-01T10:00:00Z",
        updated_at: "2026-10-04T09:00:00Z",
      }),
      post(30, "flag", `![f](${COVER})`, { user: { login: "someone", avatar_url: "https://evil.example/avatar.png" }, created_at: "2026-09-20T10:00:00Z" }),
      post(31, "flag", "no image here", { created_at: "2026-09-25T10:00:00Z" }),
    ],
    files: { [FILE]: ZIP, [COVER]: PNG },
  });
  await run(hub);
  const { posts } = hub.index();
  assert.deepEqual(posts.map((entry) => entry.number), [30, 12], "released posts only, newest first");
  assert.deepEqual(posts[1], {
    number: 12,
    kind: "scenario",
    state: "open",
    title: "[Scenario] The long war",
    body: `### Description\n\nA world.\n\n![cover](${COVER})\n[file](${FILE})\n\n### Made by\n\nme`,
    user: { login: "arkniem", avatar_url: "https://avatars.githubusercontent.com/u/9?v=4" },
    html_url: `https://github.com/${REPO}/issues/12`,
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-10-04T09:00:00Z",
    labels: ["scenario", "pinned"],
    author_association: "OWNER",
    reactions: { "+1": 3 },
    comments: 11,
  });
  assert.deepEqual(posts[0].user, { login: "someone" }, "an avatar only from GitHub's own avatars");

  // What changes on a released post without its files changing shows at once:
  // its title, a label a maintainer gave it, its likes.
  Object.assign(hub.issues.get(30), { title: "[Flag] Renamed", labels: [{ name: "flag" }, { name: "pinned" }], reactions: { "+1": 5 }, comments: 2, updated_at: "2026-10-05T12:10:00Z" });
  hub.calls.length = 0;
  await run(hub, { now: at(30) });
  assert.deepEqual(hub.did("download"), []);
  const [flag] = hub.index().posts;
  assert.deepEqual([flag.title, flag.labels, flag.reactions, flag.comments, flag.updated_at], ["[Flag] Renamed", ["flag", "pinned"], { "+1": 5 }, 2, "2026-10-05T12:10:00Z"]);
});

test("a post's text in the index is cut at 20,000 characters, without losing what the game looks for", async () => {
  const body = `### Description\n\n${"A very long story. ".repeat(1500)}\n\n![cover](${COVER})\n[file](${FILE})\n\n### Basemap info\n\nBasemap-Hash: abcdef0123456789\nScenario-Key: oh-0123456789abcdef\nFlags-Count: 12`;
  assert.ok(body.length > 28000);
  const hub = fakeHub({ issues: [post(12, "scenario", body)], files: { [FILE]: ZIP, [COVER]: PNG } });
  await run(hub);
  const [listed] = hub.index().posts;
  assert.ok(listed.body.length <= 20000);
  assert.ok(listed.body.startsWith("### Description\n\nA very long story."));
  assert.ok(listed.body.includes(`[world-scenario.zip](${FILE})`) && listed.body.includes(`![](${COVER})`));
  assert.match(listed.body, /^Scenario-Key: oh-0123456789abcdef$/m);
  assert.match(listed.body, /^Basemap-Hash: abcdef0123456789$/m);
  assert.match(listed.body, /^Flags-Count: 12$/m);
  assert.equal(hub.state().posts[12].released.body, body, "the workflow's own notes keep all of it");
});

// ---- coming from version 1 --------------------------------------------------------

test("what version 1 copied is checked, and no post's count drops on the way", async () => {
  const flagUrl = "https://github.com/user-attachments/assets/dddddddd-1111-2222-3333-444444444444";
  const badFile = "https://github.com/user-attachments/files/503/broken-scenario.zip";
  const official = "https://github.com/Arkniem/pax-historia-scenarios/releases/download/bundles/roman-117.json";
  const attached = rawZip([{ name: "assets/" }, { name: "scenario.json", data: JSON.stringify(scenario()), method: 8 }]);
  const broken = scenarioZip({}, { "setup.exe": "MZ" });
  const bundle = scenarioJson();
  const release = (name, bytes, downloads) => ({ id: 0, name, url: `https://github.com/${REPO}/releases/download/TAG/${name}`, size: bytes.length, downloads });
  const copied = (id, tag, asset, bytes) => ({ id, tag, name: asset.name, url: asset.url.replace("TAG", tag), size: bytes.length, sha256: sha256(bytes) });
  const assets = {
    zip: { ...release("p12-501-world-scenario.zip", attached, 40), id: 501 },
    flag: { ...release("p30-dddddddd.png", PNG, 9), id: 502 },
    bad: { ...release("p13-503-broken-scenario.zip", broken, 25), id: 503 },
    official: { ...release("roman-117.json", bundle, 379), id: 504 },
  };
  const v1 = {
    version: 1,
    installedAt: "2026-10-05T22:39:11.753Z",
    posts: {
      1: { kind: "scenario", bodyHash: "x", quiet: true, files: [{ source: official, primary: true, hosted: { id: 504, tag: "bundles", name: "roman-117.json", url: assets.official.url.replace("TAG", "bundles") } }], carried: 0, skip: { 504: 379 }, problems: [], failures: 0, comment: null },
      12: { kind: "scenario", bodyHash: "x", quiet: true, files: [{ source: FILE, primary: true, asset: copied(501, "scenarios-1", assets.zip, attached) }], carried: 6, skip: {}, problems: [], failures: 0, comment: null },
      13: { kind: "scenario", bodyHash: "x", quiet: true, files: [{ source: badFile, primary: true, asset: copied(503, "scenarios-1", assets.bad, broken) }], carried: 0, skip: {}, problems: [], failures: 0, comment: null },
      24: { kind: "flag", bodyHash: "x", quiet: true, files: [], carried: 0, skip: {}, problems: [{ text: "No flag image is attached to this post.", transient: false }], failures: 0, comment: null },
      30: { kind: "flag", bodyHash: "x", quiet: true, files: [{ source: flagUrl, primary: true, asset: copied(502, "flags-1", assets.flag, PNG) }], carried: 0, skip: {}, problems: [], failures: 0, comment: null },
    },
    retired: { 99: { carried: 14, skip: {} } },
  };
  const hub = fakeHub({
    issues: [post(1, "scenario", official), post(12, "scenario", FILE), post(13, "scenario", badFile), post(24, "flag", "_No response_"), post(30, "flag", `![f](${flagUrl})`)],
    files: { [official]: bundle, [FILE]: attached, [badFile]: broken, [flagUrl]: PNG },
    releases: [
      { id: 1, tag: "bundles", assets: [{ ...assets.official, url: assets.official.url.replace("TAG", "bundles") }] },
      { id: 2, tag: "scenarios-1", assets: [assets.zip, assets.bad].map((asset) => ({ ...asset, url: asset.url.replace("TAG", "scenarios-1") })) },
      { id: 3, tag: "flags-1", assets: [{ ...assets.flag, url: assets.flag.url.replace("TAG", "flags-1") }] },
    ],
    data: { "state.json": JSON.stringify(v1), "index.json": JSON.stringify({ version: 1, files: {}, imports: { 1: 289, 12: 46, 13: 25 } }) },
  });
  const options = { aliases: ["Arkniem/pax-historia-scenarios"], legacy: { 1: 289 } };

  // The notes of version 1 are read without a count changing.
  const read = normalizeState(v1);
  assert.equal(read.version, 2);
  assert.deepEqual([read.posts[12].carried, read.posts[1].skip, read.retired], [6, { 504: 379 }, { 99: { carried: 14, skip: {} } }]);
  assert.deepEqual(read.posts[12].pipeline, 1);

  await run(hub, options);
  const state = hub.state();
  assert.equal(state.version, 2);
  assert.deepEqual(Object.values(state.posts).map((record) => record.pipeline), [PIPELINE, PIPELINE, PIPELINE, PIPELINE, PIPELINE]);
  assert.deepEqual(state.retired, { 99: { carried: 14, skip: {} } });
  // The flag was a whole PNG: its copy is the checked bytes already, and is kept.
  assert.deepEqual(hub.index().files[flagUrl], assets.flag.url.replace("TAG", "flags-1"));
  assert.ok(!hub.did("uploadAsset").some(([, name]) => name.startsWith("p30-")));
  // The zip is written again, so it gets a new copy; the old one waits its turn.
  assert.match(hub.index().files[FILE], /p12-501-world-scenario-[0-9a-f]{8}\.zip$/);
  assert.ok(hub.asset("p12-501-world-scenario.zip"));
  // The official preset gets a checked copy beside the file in the old release.
  assert.match(hub.index().files[official], /scenarios-1\/p1-[0-9a-f]{8}-roman-117-[0-9a-f]{8}\.json$/);
  // The post with a program in its zip is released no longer, and is told so:
  // being there before the checks were is no reason to be left alone.
  assert.equal(hub.index().files[badFile], undefined);
  assert.deepEqual(hub.index().posts.map((entry) => entry.number).sort((a, b) => a - b), [1, 12, 30]);
  assert.match(hub.said(13)[0], /`setup\.exe` is not something the game uses/);
  assert.match(hub.said(24)[0], /No flag image is attached/);
  // Every count is what it was.
  assert.deepEqual(hub.index().imports, { 1: 289, 12: 46, 13: 25 });

  // Later: downloads of the old copies (games holding the old index) and of the
  // new ones all count, and the old copies go without taking anything with them.
  hub.downloaded("p12-501-world-scenario.zip", 2);
  hub.downloaded("p12-501-world-scenario-", 3);
  hub.downloaded("roman-117.json", 4);
  await run(hub, { ...options, now: at(30) });
  assert.ok(!hub.asset("p12-501-world-scenario.zip") && !hub.asset("p13-503-"));
  assert.ok(hub.asset("roman-117.json"), "the old release is not the workflow's to tidy");
  assert.deepEqual(hub.index().imports, { 1: 293, 12: 51, 13: 25 });
  await run(hub, { ...options, now: at(60) });
  assert.deepEqual(hub.index().imports, { 1: 293, 12: 51, 13: 25 });
});
