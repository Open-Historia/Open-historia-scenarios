// Run: npm test
//
// The checks in a process of their own (lib/checker.mjs): the same verdicts as
// the checks give directly, and a file made to break them costs only itself.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { checkPostFile, checkSuggestion } from "../lib/check.mjs";
import { Checker } from "../lib/checker.mjs";
import { closeSharedRasteriser } from "../lib/svg.mjs";
import { TEST_LABEL } from "../lib/posts.mjs";
import { PROBLEM_LABEL } from "../lib/sync.mjs";
import { REPO, fakeHub, post, run } from "./fake-client.mjs";
import { SVG, png, scenario, scenarioJson, scenarioZip, suggestionZip } from "./fixtures.mjs";

const checker = new Checker();
after(() => {
  checker.close();
  closeSharedRasteriser();
});

const HUB = { addresses: [], repos: [REPO.toLowerCase()], assets: [] };
const PNG = png({ width: 60, height: 40 });
// An SVG the renderer takes minutes over (a blur, a morphology and noise, four
// hundred times over): slow on any machine, and small.
const SLOW_SVG = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="4000"><defs><filter id="f"><feGaussianBlur stdDeviation="900"/><feMorphology radius="400"/><feTurbulence baseFrequency="0.9" numOctaves="12"/></filter></defs>${'<rect width="4000" height="4000" filter="url(#f)"/>'.repeat(400)}</svg>`);
// A scenario that is valid JSON and nothing else: a list of `megabytes` of "{},".
const heavy = (megabytes, piece = "{},") => {
  const head = Buffer.from('{"schema":"open-historia-scenario-bundle/2","scenario":{},"x":[');
  const tail = Buffer.from("0]}");
  const room = megabytes * 1024 * 1024 - head.length - tail.length;
  return Buffer.concat([head, Buffer.alloc(room - (room % piece.length), piece), tail]);
};

test("the checker gives the verdict the checks give, and the same bytes", async () => {
  const files = [
    ["flag", PNG],
    ["flag", Buffer.concat([PNG, Buffer.from("something appended")])],
    ["flag", Buffer.from(SVG)],
    ["scenario", scenarioJson()],
    ["scenario", scenarioJson({ hubOrigin: { postId: 12 } })],
    ["scenario", scenarioZip()],
    ["scenario", scenarioZip({}, { "setup.exe": Buffer.from("MZ") })],
    ["scenario", Buffer.from("not a scenario at all")],
    ["basemap", PNG],
  ];
  for (const [kind, bytes] of files) {
    const direct = await checkPostFile({ kind, primary: true, bytes, label: "`the-file`" });
    const { bytes: checked, ...verdict } = await checker.postFile({ kind, primary: true, bytes, label: "`the-file`", hub: HUB });
    const { bytes: expected, ...wanted } = direct;
    assert.deepEqual(verdict, wanted, kind);
    assert.equal(Boolean(checked), Boolean(expected));
    if (expected) assert.ok(checked.equals(expected), `${kind}: the same bytes`);
    // A file released as it came is the file that was sent, not a copy of it.
    if (expected === bytes) assert.equal(checked, bytes);
  }
  // Something else attached to a post, which is neither a picture nor a data file.
  assert.deepEqual(await checker.postFile({ kind: "flag", primary: false, bytes: Buffer.from("notes"), label: "`notes.txt`", hub: HUB }), { released: false, problems: [], repairs: [], skip: true });
  for (const bytes of [suggestionZip(), scenarioJson(), Buffer.alloc(0)]) {
    assert.deepEqual(await checker.suggestion({ bytes, label: "`changes.zip`", hub: HUB }), await checkSuggestion({ bytes, label: "`changes.zip`" }));
  }
});

test("the checker is told which addresses are the hub's, and decides by them", async () => {
  const posted = "https://github.com/user-attachments/files/55/vector.zip";
  const released = `https://github.com/${REPO}/releases/download/basemaps-1/p7-55-vector-0a1b2c3d.zip`;
  const shared = (url) => scenarioJson({ assets: { backgroundData: { mode: "communityRef", hash: "abc", via: "dataFile", url, fileName: "background.json" } } });
  const hub = { addresses: [posted], repos: [REPO.toLowerCase()], assets: ["basemaps-1/p7-55-vector-0a1b2c3d.zip"] };
  const check = (url) => checker.postFile({ kind: "scenario", primary: true, bytes: shared(url), label: "`the-file`", hub });
  assert.equal((await check(posted)).released, true);
  assert.equal((await check(released)).released, true);
  for (const url of ["https://github.com/user-attachments/files/999/elsewhere.zip", `https://github.com/${REPO}/releases/download/basemaps-1/another.zip`, "https://github.com/someone/else/releases/download/basemaps-1/p7-55-vector-0a1b2c3d.zip", "https://evil.example/map.zip"]) {
    const result = await check(url);
    assert.equal(result.released, false, url);
    assert.match(result.problems.join("\n"), /points at a basemap that is not a file of this hub/);
  }
});

test("a file that needs more memory than the checker has is refused, and the next file is checked", async () => {
  // Six megabytes of "{}," are two million objects: far more than 64 MB holds.
  const small = new Checker({ memoryMb: 64 });
  try {
    const result = await small.postFile({ kind: "scenario", primary: true, bytes: heavy(6), label: "`heavy.json`", hub: HUB });
    assert.deepEqual(result, { released: false, problems: ["`heavy.json` can't be used: checking it takes more memory than the hub has for one file, far more than any file the game makes."], repairs: [] });
    const verdict = await small.suggestion({ bytes: heavy(6), label: "`heavy.zip`", hub: HUB });
    assert.deepEqual(verdict, { ok: false, problems: ["`heavy.zip` can't be used: checking it takes more memory than the hub has for one file, far more than any file the game makes."] });
    const next = await small.postFile({ kind: "flag", primary: true, bytes: PNG, label: "`flag.png`", hub: HUB });
    assert.equal(next.released, true);
    assert.equal(next.bytes, PNG);
  } finally {
    small.close();
  }
});

test("all of the checker's memory is watched, not only what its JavaScript holds", async () => {
  // A file whose bytes alone are more than the checker may use, with all the
  // JavaScript memory it could want: the watch is on a thread of its own, and
  // stops the checker in the middle of reading.
  const tight = new Checker({ allMemoryMb: 200 });
  try {
    const bytes = Buffer.from(JSON.stringify(scenario({ world: { text: "a".repeat(120 * 1024 * 1024) } })));
    const result = await tight.postFile({ kind: "scenario", primary: true, bytes, label: "`long.json`", hub: HUB });
    assert.deepEqual(result, { released: false, problems: ["`long.json` can't be used: checking it takes more memory than the hub has for one file, far more than any file the game makes."], repairs: [] });
    assert.equal((await tight.postFile({ kind: "flag", primary: true, bytes: PNG, label: "`flag.png`", hub: HUB })).released, true);
  } finally {
    tight.close();
  }
});

test("a file that takes too long to check is refused, and the next file is checked", async () => {
  const hasty = new Checker({ timeoutMs: 1000 });
  try {
    const started = Date.now();
    const result = await hasty.postFile({ kind: "flag", primary: true, bytes: SLOW_SVG, label: "`slow.svg`", hub: HUB });
    assert.deepEqual(result, { released: false, problems: ["`slow.svg` can't be used: checking it took more than 1 second, far longer than any file the game makes."], repairs: [] });
    assert.ok(Date.now() - started < 8000, "it is stopped, not waited for");
    const next = await hasty.postFile({ kind: "flag", primary: true, bytes: PNG, label: "`flag.png`", hub: HUB });
    assert.equal(next.released, true);
    // A file may be given less than a file's own time (what its post has left).
    const less = await checker.postFile({ kind: "flag", primary: true, bytes: SLOW_SVG, label: "`slow.svg`", hub: HUB, timeoutMs: 1000 });
    assert.match(less.problems.join("\n"), /checking it took more than 1 second/);
    assert.equal((await checker.postFile({ kind: "flag", primary: true, bytes: PNG, label: "`flag.png`", hub: HUB })).released, true);
  } finally {
    hasty.close();
  }
});

test("a checker that fails is a fault of the hub's, not a verdict on the file", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "hub-test-"));
  const script = path.join(folder, "worker.mjs");
  fs.writeFileSync(script, 'process.stdin.once("data", () => { console.error("TypeError: something the checks were not written for"); process.exit(3); });\n');
  const broken = new Checker({ worker: script });
  try {
    await assert.rejects(broken.postFile({ kind: "flag", primary: true, bytes: PNG, label: "`flag.png`", hub: HUB }), /the checker stopped \(code 3\): TypeError: something the checks were not written for/);
    await assert.rejects(broken.suggestion({ bytes: PNG, label: "`changes.zip`", hub: HUB }), /the checker stopped/);
  } finally {
    broken.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("a post whose file is made to end the run gets its comment, and the run goes on", async () => {
  const BOMB = "https://github.com/user-attachments/files/701/heavy.json";
  const GOOD = "https://github.com/user-attachments/files/702/world-scenario.zip";
  const hub = fakeHub({
    issues: [post(70, "scenario", `[heavy.json](${BOMB})`), post(71, "scenario", `[world-scenario.zip](${GOOD})`)],
    files: { [BOMB]: heavy(6), [GOOD]: scenarioZip() },
  });
  const small = new Checker({ memoryMb: 64 });
  try {
    await run(hub, { checker: small });
    assert.deepEqual(hub.index().posts.map((entry) => entry.number), [71]);
    assert.match(hub.said(70)[0], /`heavy\.json` can't be used: checking it takes more memory than the hub has for one file/);
    assert.ok(hub.issues.get(70).labels.some((label) => label.name === PROBLEM_LABEL));
    // It is settled: the next run does not download it again.
    hub.calls.length = 0;
    await run(hub, { checker: small });
    assert.deepEqual(hub.did("download"), []);
  } finally {
    small.close();
  }
});

test("the files of one post have one allowance of time between them", async () => {
  const SLOW = "https://github.com/user-attachments/files/711/slow.svg";
  const GOOD = "https://github.com/user-attachments/files/712/world-scenario.zip";
  const FIRST = "https://github.com/user-attachments/assets/aaaaaaaa-1111-2222-3333-444444444444";
  const SECOND = "https://github.com/user-attachments/assets/bbbbbbbb-1111-2222-3333-444444444444";
  const files = { [SLOW]: SLOW_SVG, [GOOD]: scenarioZip(), [FIRST]: PNG, [SECOND]: png({ width: 30, height: 20 }) };
  // A real post: its file is in order, and something else attached uses the
  // time up. What comes after that is not fetched, and only not copied.
  const hub = fakeHub({ issues: [post(73, "scenario", `[world-scenario.zip](${GOOD})\n[slow.svg](${SLOW})\n![a](${FIRST})`)], files });
  const lines = [];
  await run(hub, { postCheckMs: 1000, log: (line) => lines.push(line) });
  assert.deepEqual(hub.index().posts.map((entry) => entry.number), [73]);
  assert.deepEqual(Object.keys(hub.index().files), [GOOD]);
  assert.deepEqual(hub.did("download").map(([, url]) => url), [GOOD, SLOW]);
  assert.equal(hub.comments.size, 0, "nothing the author has to do");
  assert.match(lines.join("\n"), /#73: not copied: `slow\.svg` can't be used: checking it took more than 1 second/);
  assert.match(lines.join("\n"), /#73: not copied: The attached image was not checked: the files of this post together took more than 1 second to check\./);

  // A test post has every file judged: the ones not reached are said too.
  const SLOW_IMAGE = "https://github.com/user-attachments/assets/cccccccc-1111-2222-3333-444444444444";
  const test = fakeHub({
    issues: [post(74, "flag", `![flag](${SLOW_IMAGE})\n![a](${FIRST})\n![b](${SECOND})`, { title: "[Flag] made to be slow", labels: [{ name: TEST_LABEL }] })],
    files: { ...files, [SLOW_IMAGE]: SLOW_SVG },
  });
  await run(test, { postCheckMs: 1000 });
  assert.deepEqual(test.did("download").map(([, url]) => url), [SLOW_IMAGE], "what is not reached is not fetched");
  const said = test.said(74)[0];
  assert.match(said, /\(the post's file\): refused\.\n {2}- The attached image 1 can't be used: checking it took more than 1 second, far longer than any file the game makes\./);
  assert.match(said, /refused\.\n {2}- The attached image 2 was not checked: the files of this issue together took more than 1 second to check\./);
  assert.match(said, /refused\.\n {2}- The attached image 3 was not checked/);
});

test("a scenario with a picture to draw is drawn by the checker's own renderer", async () => {
  const flag = `data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}`;
  const bytes = Buffer.from(JSON.stringify(scenario({ assets: { flags: { data: { France: flag }, fileName: "flags.json", mode: "embedded" } } })));
  const result = await checker.postFile({ kind: "scenario", primary: true, bytes, label: "`the-file`", hub: HUB });
  assert.deepEqual(result.repairs, ["1 flag converted"]);
  assert.match(JSON.parse(result.bytes.toString("utf8")).assets.flags.data.France, /^data:image\/png;base64,/);
});
