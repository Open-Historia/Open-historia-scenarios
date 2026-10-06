// Run: npm test
//
// A suggestion is a comment on a scenario post with a .zip of suggested
// changes. It is checked where it is; one the game could not use is deleted,
// and its author told why.
import assert from "node:assert/strict";
import test from "node:test";

import { NOTICE_MARKER } from "../lib/comments.mjs";
import { suggestionZipOf } from "../lib/posts.mjs";
import { SUGGESTION_TRIES } from "../lib/sync.mjs";
import { at, installed, post, run } from "./fake-client.mjs";
import { SVG, png, scenarioZip, suggestionZip } from "./fixtures.mjs";

const FILE = "https://github.com/user-attachments/files/501/world-scenario.zip";
const FLAG = "https://github.com/user-attachments/assets/aaaaaaaa-1111-2222-3333-444444444444";
const zipAt = (number, name = "test-world-suggestion.zip") => `https://github.com/user-attachments/files/${number}/${name}`;
// The comment the game has a player paste, with the file dragged into it.
const suggesting = (address) => `**Suggested changes** to this scenario (1 change), made with Open Historia's Suggest changes.\n\n- Description changed\n\n[${address.split("/").pop()}](${address})\n\nOpen-Historia-Suggestion: sug-0123456789abcdef`;
const GOOD = suggestionZip();
const WITH_SVG = suggestionZip({ changes: [{ id: "cover", area: "details", kind: "cover", from: null, to: { hash: "x", contentType: "image/svg+xml", file: "files/cover.svg" } }] }, { "files/cover.svg": SVG });
const WITH_PROGRAM = suggestionZip({}, { "run-me.exe": "MZ" });
const hubWithPost = (files = {}) => installed({
  issues: [post(12, "scenario", FILE), post(30, "flag", `![f](${FLAG})`)],
  files: { [FILE]: scenarioZip(), [FLAG]: png(), ...files },
});
const notices = (hub, number) => hub.said(number).filter((body) => body.startsWith(NOTICE_MARKER));

test("a comment is a suggestion by the game's own rule", () => {
  assert.equal(suggestionZipOf(suggesting(zipAt(1))), zipAt(1));
  // Named like one, without the line the game writes: a player who dragged the file in and wrote nothing.
  assert.equal(suggestionZipOf(`here you go ${zipAt(2)}`), zipAt(2));
  // Any .zip, with the line.
  assert.equal(suggestionZipOf(`[changes.zip](${zipAt(3, "changes.zip")})\nOpen-Historia-Suggestion: sug-1234`), zipAt(3, "changes.zip"));
  assert.equal(suggestionZipOf(`a mod of mine: ${zipAt(4, "my-mod.zip")}`), null);
  assert.equal(suggestionZipOf("Open-Historia-Suggestion: sug-1234, but no file"), null);
  assert.equal(suggestionZipOf("https://github.com/Open-Historia/Open-historia-scenarios/files/77/old-style-suggestion.zip"), "https://github.com/Open-Historia/Open-historia-scenarios/files/77/old-style-suggestion.zip");
  assert.equal(suggestionZipOf("https://github.com/Open-Historia/Open-historia-scenarios/releases/download/security-test/t1-suggestion.zip"), null, "a file in a release is not an attachment");
});

test("a suggestion that passes is kept, and listed for the game", async () => {
  const hub = await hubWithPost({ [zipAt(1)]: GOOD, [zipAt(2)]: GOOD });
  hub.time = at(5).toISOString();
  const id = hub.comment(12, suggesting(zipAt(1)), "ann");
  hub.comment(12, "Great scenario, thank you!", "bob");
  const { summary } = await run(hub, { now: at(10) });
  assert.equal(summary.suggestionsKept, 1);
  assert.deepEqual(hub.did("download"), [["download", zipAt(1)]]);
  assert.deepEqual(hub.did("deleteComment").concat(hub.did("createComment")), []);
  assert.deepEqual(hub.index().suggestions, { [id]: { post: 12, zip: zipAt(1) } });
  // Looked at once: the next runs do not fetch it again.
  hub.calls.length = 0;
  await run(hub, { now: at(40) });
  await run(hub, { now: at(70) });
  assert.deepEqual(hub.did("download"), []);
  // Edited, it is looked at again.
  hub.time = at(80).toISOString();
  hub.edit(id, suggesting(zipAt(2)));
  await run(hub, { now: at(90) });
  assert.deepEqual(hub.did("download"), [["download", zipAt(2)]]);
  assert.deepEqual(hub.index().suggestions, { [id]: { post: 12, zip: zipAt(2) } });
  // Edited so that it is no suggestion any more, it is no longer listed.
  hub.time = at(100).toISOString();
  hub.edit(id, "Never mind.");
  await run(hub, { now: at(110) });
  assert.deepEqual(hub.index().suggestions, {});
  assert.ok(hub.comments.has(id), "and it is nobody's to delete");
});

test("a suggestion with a problem is deleted, with one notice on the post for each suggester", async () => {
  const hub = await hubWithPost({ [zipAt(1)]: WITH_SVG, [zipAt(2)]: WITH_PROGRAM, [zipAt(3)]: WITH_PROGRAM, [zipAt(4)]: GOOD });
  hub.time = at(5).toISOString();
  const first = hub.comment(12, suggesting(zipAt(1)), "ann");
  const second = hub.comment(12, suggesting(zipAt(2)), "bob");
  const good = hub.comment(12, suggesting(zipAt(4)), "cy");
  const { summary } = await run(hub, { now: at(10) });
  assert.equal(summary.suggestionsDeleted, 2);
  assert.deepEqual(hub.did("deleteComment"), [["deleteComment", first], ["deleteComment", second]]);
  assert.ok(!hub.comments.has(first) && !hub.comments.has(second) && hub.comments.has(good));
  assert.equal(notices(hub, 12).length, 2);
  const [forAnn, forBob] = notices(hub, 12);
  assert.match(forAnn, /### ⚠️ Suggested changes from @ann were removed/);
  assert.match(forAnn, /@ann, the changes you suggested here were removed automatically, because the game could not have used their file:/);
  assert.match(forAnn, /- `files\/cover\.svg` can't be used: it is an SVG, and an SVG cannot be used here: save it as a PNG and use that instead\./);
  assert.match(forAnn, /You can suggest your changes again from the game/);
  assert.match(forBob, /@bob[\s\S]*- `run-me\.exe` is not something the game uses/);
  // No address in it: the game would read a notice that carried the .zip's as a suggestion itself.
  for (const notice of notices(hub, 12)) assert.doesNotMatch(notice, /https?:\/\//);
  assert.deepEqual(hub.index().suggestions, { [good]: { post: 12, zip: zipAt(4) } });
  assert.equal(hub.said(12).length, 2, "and nothing is said to the post's author: the scenario has no problem");

  // Ann tries again with another bad file: her notice is brought up to date, not doubled.
  hub.calls.length = 0;
  hub.time = at(20).toISOString();
  const third = hub.comment(12, suggesting(zipAt(3)), "Ann");
  await run(hub, { now: at(30) });
  assert.deepEqual(hub.did("deleteComment"), [["deleteComment", third]]);
  assert.deepEqual([hub.did("createComment").length, hub.did("updateComment").length], [0, 1]);
  assert.equal(notices(hub, 12).length, 2);
  assert.match(notices(hub, 12)[0], /@Ann[\s\S]*`run-me\.exe`/);
  assert.doesNotMatch(notices(hub, 12)[0], /cover\.svg/);
  // The notices are the workflow's own, and are not taken for anything on later runs.
  hub.calls.length = 0;
  await run(hub, { now: at(60) });
  assert.deepEqual(hub.did("deleteComment").concat(hub.did("download"), hub.did("createComment"), hub.did("updateComment")), []);
});

test("a suggestion whose file cannot be fetched just now is left alone, and tried again", async () => {
  const hub = await hubWithPost({ [zipAt(1)]: Object.assign(new Error("GitHub answered 502"), { transient: true }), [zipAt(2)]: WITH_PROGRAM });
  hub.time = at(5).toISOString();
  const waiting = hub.comment(12, suggesting(zipAt(1)), "ann");
  hub.time = at(6).toISOString();
  const bad = hub.comment(12, suggesting(zipAt(2)), "bob");
  await run(hub, { now: at(10) });
  // Nothing is decided about ann's, and nothing is deleted. Bob's, after it, is dealt with all the same.
  assert.ok(hub.comments.has(waiting));
  assert.deepEqual(hub.did("deleteComment"), [["deleteComment", bad]]);
  assert.deepEqual(hub.index().suggestions, {});
  assert.equal(hub.state().comments.since, "", "the place in the list stays before the one that is waiting");
  await run(hub, { now: at(40) });
  assert.ok(hub.comments.has(waiting));
  // GitHub answers again.
  hub.files.set(zipAt(1), GOOD);
  await run(hub, { now: at(70) });
  assert.deepEqual(hub.index().suggestions, { [waiting]: { post: 12, zip: zipAt(1) } });
  assert.ok(hub.state().comments.since >= at(6).toISOString());
  assert.deepEqual(hub.state().comments.waiting, {});
});

test("a suggestion whose file is gone for good is deleted; one that never arrives is left, unlisted", async () => {
  const hub = await hubWithPost({ [zipAt(2)]: Object.assign(new Error("GitHub answered 502"), { transient: true }) });
  hub.time = at(5).toISOString();
  const gone = hub.comment(12, suggesting(zipAt(1)), "ann"); // 404
  const never = hub.comment(12, suggesting(zipAt(2)), "bob");
  await run(hub, { now: at(10) });
  assert.ok(!hub.comments.has(gone));
  assert.match(notices(hub, 12)[0], /`test-world-suggestion\.zip` can't be downloaded any more \(GitHub answered 404\)\./);
  for (let attempt = 2; attempt <= SUGGESTION_TRIES; attempt += 1) await run(hub, { now: at(10 + 30 * attempt) });
  assert.ok(hub.comments.has(never), "never deleted for a file that could not be read");
  assert.deepEqual(hub.index().suggestions, {});
  hub.calls.length = 0;
  await run(hub, { now: at(9999) });
  assert.deepEqual(hub.did("download"), [], "and not tried for ever");
});

test("the workflow's own comments, and a bot's, are never scanned or deleted", async () => {
  const hub = await hubWithPost({ [zipAt(1)]: WITH_PROGRAM });
  hub.time = at(5).toISOString();
  // A bot that posts something the rule would take for a suggestion.
  const fromBot = hub.comment(12, suggesting(zipAt(1)), "some-app[bot]");
  hub.comments.get(fromBot).user.type = "Bot";
  // A problem comment of the workflow's own, on a post with no file.
  hub.issues.set(20, post(20, "scenario", "no file"));
  await run(hub, { now: at(10) });
  assert.equal(hub.said(20).length, 1);
  await run(hub, { now: at(40) });
  assert.deepEqual(hub.did("deleteComment").concat(hub.did("download")), []);
  assert.ok(hub.comments.has(fromBot));
  // A person who pastes the workflow's marker into their comment gains nothing by it.
  hub.time = at(50).toISOString();
  const disguised = hub.comment(12, `<!-- hub-files -->\n<!-- hub-suggestion -->\n${suggesting(zipAt(1))}`, "mallory");
  await run(hub, { now: at(60) });
  assert.deepEqual(hub.did("deleteComment"), [["deleteComment", disguised]]);
  assert.match(notices(hub, 12)[0], /@mallory/);
});

test("a suggestion its author deletes is no longer listed", async () => {
  const hub = await hubWithPost({ [zipAt(1)]: GOOD, [zipAt(2)]: GOOD });
  hub.time = at(5).toISOString();
  const kept = hub.comment(12, suggesting(zipAt(1)), "ann");
  const withdrawn = hub.comment(12, suggesting(zipAt(2)), "bob");
  await run(hub, { now: at(10) });
  assert.deepEqual(Object.keys(hub.index().suggestions), [String(kept), String(withdrawn)]);
  hub.comments.delete(withdrawn);
  hub.issues.get(12).comments -= 1;
  hub.calls.length = 0;
  await run(hub, { now: at(40) });
  assert.deepEqual(hub.did("listPostComments"), [["listPostComments", 12]]);
  assert.deepEqual(Object.keys(hub.index().suggestions), [String(kept)]);
  // Comments are listed again only when their number moved.
  hub.calls.length = 0;
  await run(hub, { now: at(70) });
  assert.deepEqual(hub.did("listPostComments"), []);
});

test("suggestions are looked for where the game reads them: on scenario posts that are on the hub", async () => {
  const hub = await hubWithPost({ [zipAt(1)]: WITH_PROGRAM, [zipAt(2, "my-mod.zip")]: WITH_PROGRAM });
  hub.issues.set(40, post(40, "scenario", FILE, { state: "closed", state_reason: "not_planned" }));
  hub.issues.set(41, { ...post(41, "scenario", "a question"), labels: [{ name: "question" }] });
  hub.time = at(5).toISOString();
  const onFlag = hub.comment(30, suggesting(zipAt(1)), "ann");
  const onTakenDown = hub.comment(40, suggesting(zipAt(1)), "ann");
  const onQuestion = hub.comment(41, suggesting(zipAt(1)), "ann");
  const notOne = hub.comment(12, `my mod of this: ${zipAt(2, "my-mod.zip")}`, "ann");
  await run(hub, { now: at(10) });
  assert.deepEqual(hub.did("download").concat(hub.did("deleteComment")), []);
  for (const id of [onFlag, onTakenDown, onQuestion, notOne]) assert.ok(hub.comments.has(id));
  // When a post leaves the hub, what was listed for it goes with it.
  hub.files.set(zipAt(3), GOOD);
  hub.time = at(20).toISOString();
  hub.comment(12, suggesting(zipAt(3)), "bob");
  await run(hub, { now: at(30) });
  assert.equal(Object.keys(hub.index().suggestions).length, 1);
  Object.assign(hub.issues.get(12), { state: "closed", state_reason: "not_planned" });
  await run(hub, { now: at(60) });
  assert.deepEqual(hub.index().suggestions, {});
  assert.deepEqual(hub.state().suggestions, {});
});
