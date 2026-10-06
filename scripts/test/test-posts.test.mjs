// Run: npm test
//
// An issue labelled "security test" (and with no kind label) has its files put
// through the same checks as a real post's, to see what they do with a file
// made to be refused or repaired. Nothing of it reaches a game.
import assert from "node:assert/strict";
import test from "node:test";

import { TEST_MARKER } from "../lib/comments.mjs";
import { readImage } from "../lib/images.mjs";
import { TEST_LABEL, TEST_RELEASE, isTestPost, kindOfTitle, postFiles } from "../lib/posts.mjs";
import { PROBLEM_LABEL } from "../lib/sync.mjs";
import { REPO, at, fakeHub, installed, post, run } from "./fake-client.mjs";
import { SVG, dataUrl, png, scenario, scenarioZip, suggestionZip, zip } from "./fixtures.mjs";


const PNG = png({ width: 60, height: 40 });
const PADDED = "https://github.com/user-attachments/assets/aaaaaaaa-1111-2222-3333-444444444444";
const DRAWN = "https://github.com/user-attachments/files/123/evil.svg";
const FILE = "https://github.com/user-attachments/files/501/hostile-scenario.zip";
const FILE_V2 = "https://github.com/user-attachments/files/502/hostile-scenario.zip";
// A test issue: the test label, no kind label, and the kind in its title.
const testIssue = (number, title, body, extra = {}) => post(number, "scenario", body, { title, labels: [{ name: TEST_LABEL }], ...extra });
const results = (hub, number) => hub.said(number).filter((body) => body.startsWith(TEST_MARKER));
const HOSTILE = scenarioZip({
  hubOrigin: { postId: 1, bundleUrl: FILE },
  assets: { flags: { data: { A: dataUrl("image/svg+xml", SVG), B: dataUrl("image/svg+xml", SVG.replace("c81e1e", "1e3ac8")) }, fileName: "flags.json", mode: "embedded" } },
}, { "basemap.svg": SVG.replace("viewBox", 'width="300" height="200" viewBox') });
const REFUSED = scenarioZip({ assets: { flags: { data: { France: "https://evil.example/track.png" }, fileName: "flags.json", mode: "embedded" } } }, { "setup.exe": "MZ" });

test("a test post is told by its label, and its kind by its title", () => {
  assert.equal(kindOfTitle("[Scenario] a zip with a program in it"), "scenario");
  assert.equal(kindOfTitle("  [flag] lower case"), "flag");
  assert.equal(kindOfTitle("[Basemap]"), "basemap");
  assert.equal(kindOfTitle("Scenario: no brackets"), null);
  assert.ok(isTestPost(testIssue(1, "[Flag] x", "")));
  assert.ok(!isTestPost(post(1, "flag", "", { labels: [{ name: "flag" }, { name: TEST_LABEL }] })), "a kind label makes it a real post");
  assert.ok(!isTestPost(post(1, "flag", "")));
  // Its files may be files of a branch rather than attachments: the game's own patterns take those.
  const branchFile = `https://github.com/${REPO}/raw/security-tests/files/evil-scenario.zip`;
  const rawFlag = `https://raw.githubusercontent.com/${REPO}/security-tests/files/evil.svg`;
  assert.deepEqual(postFiles(testIssue(1, "[Scenario] x", `the file: ${branchFile}`), "scenario").files, [{ source: branchFile, primary: true }]);
  assert.deepEqual(postFiles(testIssue(1, "[Flag] x", `the flag: ${rawFlag}`), "flag").files, [{ source: rawFlag, primary: true }]);
});

test("a test post's files are checked into a release of their own, and nothing of it reaches the index", async () => {
  const hub = fakeHub({
    issues: [testIssue(200, "[Flag] an SVG and a picture with something behind it", `<img src="${PADDED}" />\n[evil.svg](${DRAWN})`)],
    files: { [PADDED]: Buffer.concat([PNG, Buffer.alloc(12044, 7)]), [DRAWN]: Buffer.from(SVG) },
  });
  await run(hub, { autoClose: true });
  assert.deepEqual(hub.did("createRelease"), [["createRelease", TEST_RELEASE]]);
  assert.equal(hub.releases[0].title, "Security test files");
  const copies = hub.assets();
  assert.deepEqual(copies.map((asset) => asset.tag), [TEST_RELEASE, TEST_RELEASE]);
  assert.match(copies[0].name, /^t200-aaaaaaaa-[0-9a-f]{8}\.png$/);
  assert.match(copies[1].name, /^t200-123-evil-[0-9a-f]{8}\.png$/);
  assert.ok(hub.uploaded.get(copies[0].name).equals(PNG));
  assert.equal(readImage(hub.uploaded.get(copies[1].name)).type, "png");
  // Not in the index in any way, never labelled, never closed.
  const { files, imports, posts, suggestions } = hub.index();
  assert.deepEqual([files, imports, posts, suggestions], [{}, {}, [], {}]);
  assert.deepEqual(hub.state().posts, {});
  assert.deepEqual(hub.did("closeIssue").concat(hub.did("addLabel")), []);
  assert.equal(hub.issues.get(200).state, "open");
  // One result, for a maintainer: what happened to each file, and where its checked copy is.
  assert.deepEqual(results(hub, 200), [[
    TEST_MARKER,
    "### 🧪 Security test: what the checks did with this issue's files",
    "",
    "Checked as a **flag** post. Nothing here is on the hub: the checked copies are in the `security-test` release only, no game lists this issue, and the copies are deleted when it is closed.",
    "",
    `- **the attached image 1** (the post's file): repaired. [Checked copy](${copies[0].url})`,
    "  - 12,044 bytes after the end of the image were cut off",
    `- **\`evil.svg\`**: repaired. [Checked copy](${copies[1].url})`,
    "  - SVG drawn as a 1600×1067 PNG",
  ].join("\n")]);
  // Nothing more on the next runs: the first only notes that it has seen its own comment.
  hub.calls.length = 0;
  await run(hub, { autoClose: true, now: at(30) });
  assert.deepEqual(hub.calls, [["writeData", "index.json,state.json"]]);
  await run(hub, { autoClose: true, now: at(60) });
  assert.equal(hub.calls.length, 1);
});

test("a refused test file is said to be refused, with every problem; the result is written once and kept up to date", async () => {
  const hub = await installed({ files: { [FILE]: REFUSED, [FILE_V2]: HOSTILE } });
  hub.issues.set(201, testIssue(201, "[Scenario] a program and a remote flag", `[hostile-scenario.zip](${FILE})`));
  await run(hub);
  assert.equal(hub.assets().length, 0);
  assert.deepEqual(results(hub, 201), [[
    TEST_MARKER,
    "### 🧪 Security test: what the checks did with this issue's files",
    "",
    "Checked as a **scenario** post. Nothing here is on the hub: the checked copies are in the `security-test` release only, no game lists this issue, and the copies are deleted when it is closed.",
    "",
    "- **`hostile-scenario.zip`** (the post's file): refused.",
    "  - `scenario.json` holds a flag that is loaded from another website (`evil.example`, key `France`): a flag has to be carried in the file itself.",
    "  - `setup.exe` is not something the game uses: a .zip for the hub holds JSON, pictures, map tiles and plain text, and nothing else.",
  ].join("\n")]);
  assert.ok(!hub.issues.get(201).labels.some((label) => label.name === PROBLEM_LABEL));
  const [resultId] = [...hub.comments.keys()];

  // The issue is edited to carry another file: the same comment says what became of that one.
  hub.issues.get(201).body = `[hostile-scenario.zip](${FILE_V2})`;
  hub.calls.length = 0;
  await run(hub, { now: at(30) });
  assert.deepEqual([hub.did("createComment").length, hub.did("updateComment")], [0, [["updateComment", resultId]]]);
  const copy = hub.asset("t201-502-");
  assert.equal(copy.tag, TEST_RELEASE);
  assert.match(copy.url, /\/releases\/download\/security-test\/t201-502-hostile-scenario-[0-9a-f]{8}\.zip$/);
  assert.deepEqual(results(hub, 201)[0].split("\n").slice(5), [
    `- **\`hostile-scenario.zip\`** (the post's file): repaired. [Checked copy](${copy.url})`,
    "  - zip rebuilt: `basemap.svg` → `basemap.png`, 2 flags converted, the basemap converted to a PNG, `hubOrigin` removed",
  ]);
  assert.deepEqual(hub.index().posts, []);
  // Someone deletes the result: it is written again when there is something to say.
  hub.comments.delete(resultId);
  hub.issues.get(201).title = "[Basemap] the same file, as a basemap";
  await run(hub, { now: at(60) });
  assert.match(results(hub, 201)[0], /Checked as a \*\*basemap\*\* post/);
  assert.ok(!hub.asset("t201-502-hostile-scenario-") || hub.assets().length === 1, "the copy made for the scenario is not kept beside the basemap's");
});

test("a test post with nothing to check is told why", async () => {
  const hub = fakeHub({
    issues: [testIssue(202, "an SVG to try", `[evil.svg](${DRAWN})`), testIssue(203, "[Scenario] no file yet", "coming")],
    files: { [DRAWN]: Buffer.from(SVG) },
  });
  await run(hub);
  assert.match(results(hub, 202)[0], /its title does not start with `\[Scenario\]`, `\[Flag\]` or `\[Basemap\]`, so the checks cannot tell what to check its files as/);
  assert.match(results(hub, 203)[0], /Checked as a \*\*scenario\*\* post\. No scenario file is attached to this post, so nobody can import it\. Attach one/);
  assert.deepEqual(hub.did("download").concat(hub.did("uploadAsset")), []);
  // Given a title, it is checked.
  hub.issues.get(202).title = "[Flag] an SVG to try";
  await run(hub, { now: at(30) });
  assert.match(results(hub, 202)[0], /- \*\*`evil\.svg`\*\* \(the post's file\): repaired\.[^\n]*\n  - SVG drawn as a 1024×683 PNG/);
});

test("a test issue that is closed, deleted or unlabelled has its copies deleted, and its result stays", async () => {
  const hub = fakeHub({
    issues: [204, 205, 206].map((number) => testIssue(number, "[Flag] an SVG", `[evil.svg](${DRAWN})`)),
    files: { [DRAWN]: Buffer.from(SVG) },
  });
  await run(hub);
  assert.equal(hub.assets().length, 3);
  Object.assign(hub.issues.get(204), { state: "closed", state_reason: "completed" });
  hub.issues.get(205).labels = [];
  hub.issues.delete(206);
  await run(hub, { now: at(30) });
  assert.equal(hub.assets().length, 0);
  assert.deepEqual(hub.state().tests, {});
  assert.equal(results(hub, 204).length, 1);
  assert.equal(hub.did("deleteComment").length, 0);
  // Reopened, it is checked again, and the same comment is its result.
  Object.assign(hub.issues.get(204), { state: "open", state_reason: "reopened" });
  await run(hub, { now: at(60) });
  assert.equal(hub.assets().length, 1);
  assert.equal(results(hub, 204).length, 1);
});

test("a suggestion on a test post is checked and deleted like any other, and one that passes is not listed", async () => {
  const bad = "https://github.com/user-attachments/files/901/x-suggestion.zip";
  const good = "https://github.com/user-attachments/files/902/y-suggestion.zip";
  const hub = await installed({
    issues: [testIssue(207, "[Scenario] for suggestions", `[hostile-scenario.zip](${FILE_V2})`)],
    files: { [FILE_V2]: HOSTILE, [bad]: suggestionZip({}, { "run-me.exe": "MZ" }), [good]: suggestionZip() },
  });
  hub.time = at(5).toISOString();
  const removed = hub.comment(207, `Open-Historia-Suggestion: sug-0001\n${bad}`, "tester");
  const kept = hub.comment(207, `Open-Historia-Suggestion: sug-0002\n${good}`, "tester");
  const { report } = await run(hub, { now: at(10) });
  assert.ok(!hub.comments.has(removed) && hub.comments.has(kept));
  const [notice] = hub.said(207).filter((body) => body.startsWith("<!-- hub-suggestion -->"));
  assert.match(notice, /@tester[\s\S]*- `run-me\.exe` is not something the game uses/);
  assert.deepEqual(report.suggestions.map((entry) => [entry.outcome, entry.test]), [["deleted", true], ["kept", true]]);
  assert.deepEqual(hub.index().suggestions, {}, "a test post's suggestions are never offered to a game");
  assert.equal(hub.state().suggestions[kept].test, true);
});

test("a test issue that also carries a kind label is a real post, and is told so", async () => {
  const hub = fakeHub({
    issues: [post(208, "scenario", `[hostile-scenario.zip](${FILE_V2})`, { title: "[Scenario] labelled twice", labels: [{ name: "scenario" }, { name: TEST_LABEL }] })],
    files: { [FILE_V2]: HOSTILE },
  });
  await run(hub);
  // Games list it by its kind label, so it is handled as what they would see.
  const copy = hub.asset("p208-502-");
  assert.equal(copy.tag, "scenarios-1");
  assert.deepEqual(hub.index().posts.map((entry) => entry.number), [208]);
  assert.deepEqual(hub.index().files, { [FILE_V2]: copy.url });
  assert.deepEqual(results(hub, 208), [[
    TEST_MARKER,
    "### 🧪 Security test: what the checks did with this issue's files",
    "",
    "This issue carries the `scenario` label as well as `security test`, so it is a real post: games list it, and its file was handled like any other post's. Remove the `scenario` label to test without publishing anything.",
  ].join("\n")]);
  // The kind label taken off: it is a test post now, and leaves the hub.
  hub.issues.get(208).labels = [{ name: TEST_LABEL }];
  await run(hub, { now: at(30) });
  assert.deepEqual(hub.index().posts, []);
  assert.deepEqual(hub.assets().map((asset) => [asset.tag, asset.name.slice(0, 9)]), [[TEST_RELEASE, "t208-502-"]]);
  assert.equal(results(hub, 208).length, 1, "the one comment is its result from here on");
  assert.match(results(hub, 208)[0], /Checked as a \*\*scenario\*\* post/);
});

test("what a real scenario zip with every repair in it becomes", async () => {
  // The example in the owner's own words: a basemap SVG, three SVG flags, and a link to a post.
  const flags = Object.fromEntries(["c81e1e", "1e3ac8", "1ec83a"].map((color, index) => [`Land ${index + 1}`, dataUrl("image/svg+xml", SVG.replace("c81e1e", color))]));
  const attached = zip({ "scenario.json": scenario({ hubOrigin: { postId: 3, bundleUrl: FILE }, assets: { flags: { data: flags, fileName: "flags.json", mode: "embedded" } } }), "basemap.svg": SVG });
  const hub = fakeHub({ issues: [testIssue(209, "[Scenario] every repair", `[hostile-scenario.zip](${FILE})`)], files: { [FILE]: attached } });
  await run(hub);
  assert.match(results(hub, 209)[0], /\n {2}- zip rebuilt: `basemap\.svg` → `basemap\.png`, 3 flags converted, the basemap converted to a PNG, `hubOrigin` removed$/);
});
