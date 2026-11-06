// A scenario's own text in other languages (scripts/lib/scenario-languages.mjs):
// what the checks allow in `scenario.languages`, and that the hub's index lists
// the languages a scenario ships, for the game's Community tab.
import assert from "node:assert/strict";
import test, { after } from "node:test";

import { checkPostFile } from "../lib/check.mjs";
import { normalizeState } from "../lib/sync.mjs";
import { languageCodesOf } from "../lib/scenario-languages.mjs";
import { closeSharedRasteriser } from "../lib/svg.mjs";
import { sha256 } from "../lib/util.mjs";
import { fakeHub, post, run } from "./fake-client.mjs";
import { scenarioJson, scenarioZip } from "./fixtures.mjs";

after(() => closeSharedRasteriser());

const check = (bytes) => checkPostFile({ kind: "scenario", primary: true, bytes, label: "`the-file`", isHubAddress: () => false });
const released = async (bytes) => {
  const result = await check(bytes);
  assert.deepEqual(result.problems, []);
  assert.equal(result.released, true);
  return result;
};
const refused = async (bytes, pattern) => {
  const result = await check(bytes);
  assert.equal(result.released, false, `released, with ${JSON.stringify(result.repairs)}`);
  assert.match(result.problems.join("\n"), pattern);
  return result;
};
const withLanguages = (languages) => scenarioJson({ scenario: { id: "test-world", name: "Test world", description: "A world for the tests.", languages } });
const PACKS = {
  de: { "Test world": "Testwelt", "A world for the tests.": "Eine Welt für die Tests." },
  "zh-Hant": { "Test world": "測試世界" },
  fil: { "Test world": "Mundong pansubok" },
};

test("a scenario's language packs are text keyed by text, per language, and are released as they are", async () => {
  const bytes = withLanguages(PACKS);
  const result = await released(bytes);
  assert.equal(sha256(result.bytes), sha256(bytes), "nothing is changed in them");
  assert.deepEqual(result.languages, ["de", "fil", "zh-Hant"], "the codes, for the index");
  assert.deepEqual((await released(scenarioZip({ scenario: { id: "test-world", name: "Test world", languages: { fr: { "Test world": "Monde test" } } } }))).languages, ["fr"]);
  assert.equal((await released(withLanguages(null))).languages, undefined);
  assert.equal((await released(withLanguages({}))).languages, undefined);
  assert.equal((await released(withLanguages({ de: {} }))).languages, undefined, "an empty pack is no language");
  // A translation that is the English itself is a translation (a name the language keeps).
  await released(withLanguages({ de: { Berlin: "Berlin" } }));
});

test("anything else in them is refused", async () => {
  await refused(withLanguages(["de"]), /`the-file` is damaged: its `scenario\.languages` is not what the game writes there/);
  await refused(withLanguages("de"), /its `scenario\.languages` is not what the game writes there/);
  await refused(withLanguages({ en: { a: "b" } }), /has text for `en`, which is not a language the game can be played in in translation \(English is the original\)/);
  for (const code of ["DE", "deutsch", "../x", "de_DE", "x"]) {
    await refused(withLanguages({ [code]: { a: "b" } }), /which is not a language the game can be played in/);
  }
  await refused(withLanguages({ de: ["Testwelt"] }), /The `de` text of `the-file` is not what the game writes there/);
  await refused(withLanguages({ de: { "Test world": 4 } }), /has something that is not text for `Test world`: a translation is text/);
  await refused(withLanguages({ de: { "Test world": { text: "Testwelt" } } }), /a translation is text/);
  await refused(withLanguages({ de: { ["x".repeat(4001)]: "y" } }), /has a string of 4,001 characters/);
  await refused(withLanguages({ de: { "Test world": "y".repeat(8001) } }), /in 8,001 characters, and the game keeps 8,000 at most/);
  const many = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`a${String.fromCharCode(97 + index)}`, { a: "b" }]));
  await refused(withLanguages(many), /has text in 25 languages, and a scenario can carry 24 at most/);
  const big = Object.fromEntries(Array.from({ length: 20001 }, (_, index) => [`String ${index}`, "s"]));
  await refused(withLanguages({ de: big }), /has 20,001 strings, and a language can carry 20,000 at most/);
  const heavy = Object.fromEntries(Array.from({ length: 700 }, (_, index) => [`Event ${index} ${"t".repeat(3900)}`, "u".repeat(3000)]));
  await refused(withLanguages({ de: heavy, fr: heavy }), /in other languages is .* and a scenario can carry 4 MB of it at most/);
});

test("a key that reaches an object's prototype is refused, as a language and inside one", async () => {
  const written = (text) => Buffer.from(text, "utf8");
  const base = JSON.parse(withLanguages(PACKS).toString("utf8"));
  const raw = JSON.stringify(base);
  await refused(written(raw.replace('"languages":{', '"languages":{"__proto__":{"a":"b"},')), /__proto__/);
  await refused(written(raw.replace('"de":{', '"de":{"__proto__":"x",')), /__proto__/);
  await refused(withLanguages({ constructor: { a: "b" } }), /constructor/);
  await refused(withLanguages({ de: { prototype: "x" } }), /prototype/);
});

test("the hub's index lists the languages a scenario ships with its post", async () => {
  const FILE = "https://github.com/user-attachments/files/501/world-scenario.zip";
  const PLAIN = "https://github.com/user-attachments/files/502/plain-scenario.zip";
  const hub = fakeHub({
    issues: [post(12, "scenario", `[file](${FILE})`), post(13, "scenario", `[file](${PLAIN})`)],
    files: {
      [FILE]: scenarioZip({ scenario: { id: "test-world", name: "Test world", languages: PACKS } }),
      [PLAIN]: scenarioZip(),
    },
  });
  await run(hub);
  const listed = Object.fromEntries(hub.index().posts.map((entry) => [entry.number, entry.scenario_languages ?? null]));
  assert.deepEqual(listed, { 12: ["de", "fil", "zh-Hant"], 13: null });
  // Kept in the state between runs, and read back strictly.
  const state = normalizeState(hub.state());
  assert.deepEqual(state.posts[12].files.find((file) => file.primary).languages, ["de", "fil", "zh-Hant"]);
  assert.deepEqual(languageCodesOf(["de", "de", "en", "__proto__", 4, "fr"]), ["de", "fr"]);
  assert.deepEqual(languageCodesOf("de"), []);
});
