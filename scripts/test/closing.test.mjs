// Run: npm test
//
// Released posts are closed when the hub is set to close them (autoClose, the
// HUB_AUTOCLOSE switch), and a post is looked at again whenever its text
// changes, open or closed.
import assert from "node:assert/strict";
import test from "node:test";

import { PROBLEM_LABEL } from "../lib/sync.mjs";
import { at, fakeHub, installed, post, run } from "./fake-client.mjs";
import { scenarioZip } from "./fixtures.mjs";

const FILE = "https://github.com/user-attachments/files/501/world-scenario.zip";
const FILE_V2 = "https://github.com/user-attachments/files/502/world-scenario.zip";
const BROKEN = "https://github.com/user-attachments/files/503/world-scenario.zip";
const ZIP = scenarioZip();
const ZIP_V2 = scenarioZip({ scenario: { id: "test-world", name: "Test world, second edition" } });
const FILES = { [FILE]: ZIP, [FILE_V2]: ZIP_V2, [BROKEN]: scenarioZip({}, { "setup.exe": "MZ" }) };
const on = { autoClose: true };
const stateOf = (hub, number) => [hub.issues.get(number).state, hub.issues.get(number).state_reason];
const close = (hub, number, reason = "completed") => Object.assign(hub.issues.get(number), { state: "closed", state_reason: reason });
const listed = (hub) => hub.index().posts.map((entry) => [entry.number, entry.state]);

test("with the switch off, nothing is closed or reopened", async () => {
  const hub = fakeHub({ issues: [post(12, "scenario", FILE)], files: FILES });
  await run(hub);
  await run(hub, { now: at(30) });
  assert.deepEqual(stateOf(hub, 12), ["open", null]);
  assert.deepEqual([hub.did("closeIssue"), hub.did("reopenIssue")], [[], []]);
  assert.equal(hub.state().posts[12].closedByUs, false);
  assert.deepEqual(listed(hub), [[12, "open"]]);
});

test("with the switch on, a released post is closed as completed, and stays on the hub", async () => {
  const hub = fakeHub({ issues: [post(12, "scenario", FILE), post(20, "scenario", "no file yet")], files: FILES });
  await run(hub, on);
  assert.deepEqual(hub.did("closeIssue"), [["closeIssue", 12]], "the post with a problem is left open");
  assert.deepEqual(stateOf(hub, 12), ["closed", "completed"]);
  assert.deepEqual(stateOf(hub, 20), ["open", null]);
  assert.equal(hub.state().posts[12].closedByUs, true);
  assert.deepEqual(listed(hub), [[12, "closed"]]);
  assert.deepEqual(Object.keys(hub.index().files), [FILE]);
  // The next runs find it closed, which is how a released post looks.
  hub.calls.length = 0;
  await run(hub, { ...on, now: at(30) });
  await run(hub, { ...on, now: at(60) });
  assert.deepEqual(hub.did("closeIssue").concat(hub.did("download"), hub.did("deleteAsset")), []);
  assert.deepEqual(listed(hub), [[12, "closed"]]);
});

test("a closed post is looked at again when its author edits it, and stays closed", async () => {
  const hub = await installed({ issues: [post(12, "scenario", FILE)], files: FILES }, on);
  // Its author cannot reopen an issue someone else closed: editing is the update.
  Object.assign(hub.issues.get(12), { title: "[Scenario] Post 12, second edition", body: `Better now. ${FILE_V2}` });
  await run(hub, { ...on, now: at(30) });
  assert.deepEqual(hub.did("download"), [["download", FILE_V2]]);
  assert.deepEqual(stateOf(hub, 12), ["closed", "completed"]);
  assert.deepEqual([hub.did("closeIssue"), hub.did("reopenIssue")], [[], []]);
  assert.deepEqual(Object.keys(hub.index().files), [FILE_V2]);
  assert.equal(hub.index().posts[0].title, "[Scenario] Post 12, second edition");
  assert.equal(hub.state().posts[12].closedByUs, true);
});

test("an update with a problem reopens the post, and its last good release stays on the hub", async () => {
  const hub = await installed({ issues: [post(12, "scenario", `My world. ${FILE}`)], files: FILES }, on);
  const good = hub.asset("p12-501-");
  Object.assign(hub.issues.get(12), { title: "[Scenario] Post 12, with a surprise", body: `My world, improved. ${BROKEN}` });
  await run(hub, { ...on, now: at(30) });
  assert.deepEqual(hub.did("reopenIssue"), [["reopenIssue", 12]]);
  assert.equal(hub.issues.get(12).state, "open");
  assert.equal(hub.state().posts[12].closedByUs, false);
  const [comment] = hub.said(12);
  assert.match(comment, /The new version of this post's scenario file could not be added to the hub/);
  assert.match(comment, /- `setup\.exe` is not something the game uses/);
  assert.match(comment, /Until then the hub keeps the version of this post that was released before\./);
  assert.ok(hub.issues.get(12).labels.some((label) => label.name === PROBLEM_LABEL));
  // The hub still shows what was released: the old file, under the old title and text.
  const index = hub.index();
  assert.deepEqual(index.files, { [FILE]: good.url });
  assert.deepEqual([index.posts[0].title, index.posts[0].body, index.posts[0].state, index.posts[0].labels], ["[Scenario] Post 12", `My world. ${FILE}`, "open", ["scenario"]]);
  // And goes on showing it, for as long as the update is not fixed.
  hub.calls.length = 0;
  await run(hub, { ...on, now: at(60) });
  await run(hub, { ...on, now: at(90) });
  assert.ok(hub.asset("p12-501-"));
  assert.deepEqual(hub.did("download").concat(hub.did("closeIssue"), hub.did("deleteAsset")), []);
  assert.deepEqual(hub.index().files, { [FILE]: good.url });

  // Fixed: released, closed again, and the comment and the label go.
  hub.issues.get(12).body = `My world, improved. ${FILE_V2}`;
  await run(hub, { ...on, now: at(120) });
  assert.deepEqual(stateOf(hub, 12), ["closed", "completed"]);
  assert.deepEqual(hub.said(12), []);
  assert.ok(!hub.issues.get(12).labels.some((label) => label.name === PROBLEM_LABEL));
  assert.deepEqual(Object.keys(hub.index().files), [FILE_V2]);
  assert.equal(hub.index().posts[0].title, "[Scenario] Post 12, with a surprise");
  assert.equal(hub.state().posts[12].closedByUs, true);
});

test("with the switch off, an update with a problem keeps the last good release too, and reopens nothing", async () => {
  const hub = await installed({ issues: [post(12, "scenario", FILE)], files: FILES });
  hub.issues.get(12).body = BROKEN;
  await run(hub, { now: at(30) });
  assert.deepEqual(hub.did("reopenIssue"), []);
  assert.match(hub.said(12)[0], /The new version of this post's scenario file could not be added/);
  assert.deepEqual(Object.keys(hub.index().files), [FILE]);
  assert.deepEqual(listed(hub), [[12, "open"]]);
  // A post the workflow closed while the switch was on, and that fails after
  // the switch went off: told, and left closed.
  const closed = await installed({ issues: [post(13, "scenario", FILE)], files: FILES }, on);
  closed.issues.get(13).body = BROKEN;
  await run(closed, { now: at(30) });
  assert.deepEqual(closed.did("reopenIssue"), []);
  assert.equal(closed.issues.get(13).state, "closed");
  assert.match(closed.said(13)[0], /could not be added/);
  assert.deepEqual(listed(closed), [[13, "closed"]], "closed by the workflow, it is still on the hub");
});

test("a post leaves the hub when it is closed as not planned, or loses its label", async () => {
  const hub = await installed({ issues: [post(12, "scenario", FILE), post(13, "scenario", FILE_V2), post(14, "scenario", FILE)], files: FILES }, on);
  assert.equal(hub.assets().length, 3);
  close(hub, 12, "not_planned");
  hub.issues.get(13).labels = [];
  await run(hub, { ...on, now: at(30) });
  assert.deepEqual(listed(hub), [[14, "closed"]]);
  assert.deepEqual(hub.assets().map((asset) => asset.name.slice(0, 4)), ["p14-"]);
  assert.deepEqual(Object.keys(hub.state().posts), ["14"]);
  // Closed as not planned while still open to the workflow: the same.
  const open = await installed({ issues: [post(12, "scenario", FILE)], files: FILES });
  close(open, 12, "not_planned");
  await run(open, { ...on, now: at(30) });
  assert.deepEqual(listed(open), []);
});

test("closed by someone else as completed, a released post stays while the hub closes its posts", async () => {
  const hub = await installed({ issues: [post(12, "scenario", FILE)], files: FILES });
  close(hub, 12); // by its author, say, before the workflow got to it
  await run(hub, { ...on, now: at(30) });
  assert.deepEqual(listed(hub), [[12, "closed"]]);
  assert.equal(hub.did("deleteAsset").length, 0);
  assert.equal(hub.state().posts[12].closedByUs, false);
  // With the switch off, a post closed by anyone but the workflow is gone.
  await run(hub, { now: at(60) });
  assert.deepEqual(listed(hub), []);
  assert.equal(hub.assets().length, 0);
});

test("turning the switch on brings back nothing that was closed before", async () => {
  // One post closed long ago and never seen by the workflow, one it cleared
  // away when it was closed.
  const hub = await installed({ issues: [post(7, "scenario", FILE, { state: "closed", state_reason: "completed" }), post(12, "scenario", FILE_V2)], files: FILES });
  close(hub, 12);
  await run(hub, { now: at(30) });
  assert.deepEqual(listed(hub), []);
  hub.calls.length = 0;
  await run(hub, { ...on, now: at(60) });
  assert.deepEqual(hub.did("download"), []);
  assert.deepEqual(listed(hub), []);
  // Reopened by hand, such a post is a post again.
  Object.assign(hub.issues.get(7), { state: "open", state_reason: "reopened" });
  await run(hub, { ...on, now: at(90) });
  assert.deepEqual(listed(hub), [[7, "closed"]]);
});

test("a post a maintainer reopens is checked afresh and closed again", async () => {
  const hub = await installed({ issues: [post(12, "scenario", FILE)], files: FILES }, on);
  Object.assign(hub.issues.get(12), { state: "open", state_reason: "reopened" });
  await run(hub, { ...on, now: at(30) });
  assert.deepEqual(hub.did("download"), [["download", FILE]]);
  assert.equal(hub.did("uploadAsset").length, 0, "the same bytes: the copy it has is kept");
  assert.deepEqual(hub.did("closeIssue"), [["closeIssue", 12]]);
  assert.deepEqual(stateOf(hub, 12), ["closed", "completed"]);
});

test("a post taken down while a run was looking at it is not closed over", async () => {
  const hub = fakeHub({ issues: [post(12, "scenario", FILE)], files: FILES });
  // By the time the run is ready to close it, a maintainer has closed it as not planned.
  const getIssue = hub.client.getIssue;
  hub.client.getIssue = async (number) => {
    close(hub, number, "not_planned");
    return getIssue(number);
  };
  await run(hub, on);
  assert.deepEqual(hub.did("closeIssue"), []);
  assert.deepEqual(stateOf(hub, 12), ["closed", "not_planned"]);
  await run(hub, { ...on, now: at(30) });
  assert.deepEqual(listed(hub), []);
  assert.equal(hub.assets().length, 0);
});
