// A scenario's own text in other languages: the `languages` record of its
// `scenario` part, made in the game's Workshop (its Languages tab) with the
// author's AI and shipped with the scenario, so every player reads its names,
// events and descriptions in their language without asking an AI themselves.
//
//   languages: {
//     de: { "Kingdom of Bohemia": "Königreich Böhmen", ... },
//     fr: { ... },
//   }
//
// Each language is a code as the game writes them (two or three lower-case
// letters, with a region or script after a dash) and holds text keyed by text:
// the English the scenario shows, and its translation. Only text: no list, no
// number, no record inside. English is the source and has no pack.
//
// The limits are the game's own (server/scenarioLanguages.js in the game), so
// what the hub releases the game keeps whole:
//   - at most 24 languages;
//   - at most 20,000 strings in one language;
//   - a source string at most 4,000 characters, a translation at most 8,000;
//   - every pack together at most 4 MiB.
//
// Keys that reach an object's prototype (__proto__, constructor, prototype)
// are refused wherever they stand by the walk every file gets (rules.mjs); the
// language codes are refused here too, since a code is a key. Every string is
// still text the game shows, and is walked like any other.

import { count, isRecord, quoted, sizeText } from "./util.mjs";

export const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
export const MAX_LANGUAGES = 24;
export const MAX_STRINGS_PER_LANGUAGE = 20000;
export const MAX_SOURCE_CHARACTERS = 4000;
export const MAX_TRANSLATION_CHARACTERS = 8000;
export const MAX_LANGUAGES_BYTES = 4 * 1024 * 1024;
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

// Checks the `languages` record of a scenario; `label` is how the scenario is
// named in a sentence. Problems go to `findings`. Returns the codes it has, in
// order, for the hub's index (the Community tab says "Languages: …"); none
// when the record has a problem.
export const checkScenarioLanguages = (languages, { label, findings }) => {
  if (languages === undefined || languages === null) return [];
  if (!isRecord(languages)) {
    findings.problem(`${label} is damaged: its ${quoted("scenario.languages")} is not what the game writes there`);
    return [];
  }
  const before = findings.failed;
  const codes = Object.keys(languages);
  if (codes.length > MAX_LANGUAGES) {
    findings.problem(`${label} has text in ${count(codes.length)} languages, and a scenario can carry ${MAX_LANGUAGES} at most`);
  }
  let bytes = 0;
  for (const code of codes) {
    if (FORBIDDEN.has(code) || !LANGUAGE_CODE.test(code) || code === "en") {
      findings.problem(`${label} has text for ${quoted(code)}, which is not a language the game can be played in${code === "en" ? " in translation (English is the original)" : ""}`);
      continue;
    }
    const pack = languages[code];
    const named = `the ${quoted(code)} text of ${label}`;
    if (!isRecord(pack)) {
      findings.problem(`${named} is not what the game writes there: it is the scenario's text, each English string with its translation`);
      continue;
    }
    const entries = Object.entries(pack);
    if (entries.length > MAX_STRINGS_PER_LANGUAGE) {
      findings.problem(`${named} has ${count(entries.length)} strings, and a language can carry ${count(MAX_STRINGS_PER_LANGUAGE)} at most`);
    }
    for (const [source, translation] of entries) {
      if (typeof translation !== "string") {
        findings.problem(`${named} has something that is not text for ${quoted(source)}: a translation is text`);
        continue;
      }
      if (source.length > MAX_SOURCE_CHARACTERS) {
        findings.problem(`${named} has a string of ${count(source.length)} characters (${quoted(source)}), and the game keeps ${count(MAX_SOURCE_CHARACTERS)} at most`);
      }
      if (translation.length > MAX_TRANSLATION_CHARACTERS) {
        findings.problem(`${named} translates ${quoted(source)} in ${count(translation.length)} characters, and the game keeps ${count(MAX_TRANSLATION_CHARACTERS)} at most`);
      }
      bytes += source.length + translation.length + 6;
    }
  }
  if (bytes > MAX_LANGUAGES_BYTES) {
    findings.problem(`the text of ${label} in other languages is ${sizeText(bytes)}, and a scenario can carry ${sizeText(MAX_LANGUAGES_BYTES)} of it at most`);
  }
  if (findings.failed && !before) return [];
  return languageCodesOf(codes.filter((code) => isRecord(languages[code]) && Object.keys(languages[code]).length));
};

// A list of language codes as the hub keeps it (a check's result, state.json,
// the index): codes only, each once, in order, as many as a scenario carries.
export const languageCodesOf = (value) => (Array.isArray(value)
  ? [...new Set(value.filter((code) => typeof code === "string" && LANGUAGE_CODE.test(code) && code !== "en" && !FORBIDDEN.has(code)))].sort().slice(0, MAX_LANGUAGES)
  : []);
