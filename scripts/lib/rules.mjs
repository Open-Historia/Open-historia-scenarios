// The rules that hold everywhere in a file's JSON, whatever the file is, and
// the list of what a check found.
//
// A scenario is mostly text and numbers the game shows or computes with, and
// none of that can do harm. What can:
//
//   - a field named __proto__, constructor or prototype, which changes what
//     the object it sits in IS when a careless reader copies it;
//   - a data: address of anything but a picture (a page, a script);
//   - a javascript: or vbscript: address;
//   - a picture loaded from another website: the game would fetch it, and
//     whoever runs that website would learn of every player who opens the
//     scenario. So a flag or a logo has to be carried in the file, and text
//     may not embed a remote picture (Markdown's ![..](http..), an <img>);
//     flagcdn.com is the one exception, because the game ships those flags and
//     never fetches them. Plain links in text are fine: nothing follows a link
//     until a player clicks it.
//
// An SVG written as a data: address is drawn as a PNG wherever it stands, and
// every other picture is checked as the picture it is (pictures.mjs).
//
// Documents are walked with a list of what is still to visit, not by a
// function calling itself: a file may be 70 MB of JSON, nested as deep as its
// author liked.

import { USES, checkPictureAddress, isDataAddress, parseDataAddress } from "./pictures.mjs";
import { Problem, count, plural, quoted } from "./util.mjs";

// ---- what a check found -------------------------------------------------------

const MAX_PROBLEMS = 12;

export class Findings {
  problems = [];
  #more = 0;
  #known = new Set();
  #repairs = new Map(); // what was put right -> how many times
  renamed = []; // [from, to] for entries of a zip

  // A whole sentence, without its full stop.
  problem(sentence) {
    if (this.#known.has(sentence)) return;
    this.#known.add(sentence);
    if (this.problems.length < MAX_PROBLEMS) this.problems.push(`${sentence[0].toUpperCase()}${sentence.slice(1)}.`);
    else this.#more += 1;
  }

  repaired(kind, times = 1) {
    this.#repairs.set(kind, (this.#repairs.get(kind) ?? 0) + times);
  }

  get failed() {
    return this.problems.length > 0;
  }

  // The problems, with a last line for those there was no room for.
  sentences() {
    return this.#more ? [...this.problems, `And ${plural(this.#more, "more problem")} of the same kinds.`] : [...this.problems];
  }

  // What was put right inside a document, as short phrases.
  repairPhrases() {
    const phrases = this.renamed.map(([from, to]) => `${quoted(from)} → ${quoted(to)}`);
    const say = (kind, one, many) => {
      const times = this.#repairs.get(kind);
      if (times) phrases.push(times === 1 ? one : many.replace("#", count(times)));
    };
    say("svg:flag", "1 flag converted", "# flags converted");
    say("svg:logo", "1 logo converted", "# logos converted");
    say("svg:cover", "the cover converted to a PNG", "# covers converted to PNG");
    say("svg:basemap", "the basemap converted to a PNG", "# basemaps converted to PNG");
    say("svg:picture", "1 SVG picture converted to a PNG", "# SVG pictures converted to PNG");
    say("trimmed", "bytes after the end of 1 picture cut off", "bytes after the end of # pictures cut off");
    say("lighter", "1 flag over 2 MB made smaller", "# flags over 2 MB made smaller");
    say("relabelled", "1 picture's type corrected", "# pictures' types corrected");
    say("coverType", "the cover's type corrected", "the cover's type corrected");
    say("hubOrigin", "`hubOrigin` removed", "`hubOrigin` removed");
    return phrases;
  }
}

// ---- what some strings are ----------------------------------------------------

// Most strings in a scenario are just text. A few are known to be something
// else, by where they stand: every value of the flags list is a flag, a
// polity's `flag` is one too, an asset's `data` is a payload checked for what
// it is. `whole` marks an object all of whose strings are one thing; `fields`
// marks single fields of an object.
export class Slots {
  whole = new WeakMap();
  fields = new WeakMap();

  of(container, key) {
    return this.whole.get(container) ?? this.fields.get(container)?.[key];
  }
}

// ---- walking a document -------------------------------------------------------

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_DEPTH = 200;

// "data.world.polityOverrides.France.flag", from the visit that reached it.
const pathOf = (frame, key) => {
  const parts = [key];
  for (let at = frame; at && at.parent; at = at.parent) parts.push(at.key);
  return quoted(parts.reverse().map((part, index) => (typeof part === "number" ? `[${part}]` : `${index ? "." : ""}${part}`)).join(""), 90);
};

// A pair or triple of numbers: one point of a shape. A map has millions, and
// none needs a visit of its own.
const isPoint = (value) => value.length <= 4 && typeof value[0] === "number" && (value.length < 2 || typeof value[1] === "number")
  && (value.length < 3 || typeof value[2] === "number") && (value.length < 4 || typeof value[3] === "number");

// Walks `root`, calling onKey(frame, key) for a forbidden key and
// onString(frame, key, value) for every string. Returns false when the
// document is nested too deeply to go on.
const walk = (root, { onKey, onString }) => {
  const stack = [{ node: root, parent: null, key: "", depth: 0 }];
  while (stack.length) {
    const frame = stack.pop();
    const { node } = frame;
    if (frame.depth > MAX_DEPTH) return false;
    const list = Array.isArray(node);
    const keys = list ? null : Object.keys(node);
    const length = list ? node.length : keys.length;
    for (let index = 0; index < length; index += 1) {
      const key = list ? index : keys[index];
      if (!list && FORBIDDEN_KEYS.has(key)) onKey(frame, key);
      const value = node[key];
      if (typeof value === "string") onString(frame, key, value);
      else if (value !== null && typeof value === "object") {
        if (Array.isArray(value) && (!value.length || isPoint(value))) continue;
        stack.push({ node: value, parent: frame, key, depth: frame.depth + 1 });
      }
    }
  }
  return true;
};

// ---- addresses ----------------------------------------------------------------

// The flags the game ships: stored as their flagcdn.com address, and drawn
// from the copy in the game (the game's own pattern, countryFlags.js).
const BUILT_IN_FLAG = /^https:\/\/flagcdn\.com\/(?:(?:[wh]\d+|\d+x\d+)\/)?[a-z]{2}(?:-[a-z]{2,3})?\.(?:svg|png|webp|jpe?g)$/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const REMOTE = /^(?:https?:)?\/\//i;
// Whether `value` may stand where a flag or a logo is named, when it is not a
// picture carried in the file: nothing, a flag of the game's own, or a path
// with no scheme, no "//" and no "..", which can only lead into the game.
const flagAddressProblem = (value) => {
  const address = value.trim();
  if (!address || BUILT_IN_FLAG.test(address)) return "";
  if (REMOTE.test(address)) return "remote";
  if (HAS_SCHEME.test(address) || address.includes("//") || address.includes("..") || address.includes("\\")) return "odd";
  return "";
};

// A browser drops tabs and line breaks from an address, and the blanks and
// control characters in front of it, before it looks at what kind it is.
const isScriptAddress = (value) => /^(?:javascript|vbscript):/i.test(value.slice(0, 120).replace(/[\t\n\r]/g, "").replace(/^[\x00-\x20]+/, ""));
const SCRIPT_IN_TEXT = /(?:\]\(\s*<?|\b(?:href|src|action|formaction|poster|data)\s*=\s*["']?)\s*(?:javascript|vbscript)\s*:/i;
// A picture embedded in text: Markdown's ![alt](address), an <img src>, and
// Markdown's ![alt][name] with "[name]: address" somewhere below.
const MARKDOWN_PICTURE = /!\[[^\]\n]{0,1000}\]\(\s*<?\s*((?:https?:)?\/\/[^\s)>"']+)/gi;
const HTML_PICTURE = /<img\b[^>]{0,2000}?\bsrc\s*=\s*["']?\s*((?:https?:)?\/\/[^\s"'>]+)/gi;
const NAMED_PICTURE = /!\[[^\]\n]{0,1000}\]\s?\[[^\]\n]{0,200}\]/;
const NAMED_ADDRESS = /^[ \t]{0,3}\[[^\]\n]{1,200}\]:\s*<?\s*((?:https?:)?\/\/[^\s>"']+)/gim;
const SHIPPED_HOST = /^https:\/\/flagcdn\.com\//i;
const hostOf = (address) => address.replace(REMOTE, "").split(/[/?#:@]/)[0];

const remotePictures = (value) => {
  const found = [];
  if (value.includes("![")) {
    for (const match of value.matchAll(MARKDOWN_PICTURE)) found.push(match[1]);
    if (NAMED_PICTURE.test(value)) for (const match of value.matchAll(NAMED_ADDRESS)) found.push(match[1]);
  }
  if (value.includes("<")) for (const match of value.matchAll(HTML_PICTURE)) found.push(match[1]);
  return found.filter((address) => !SHIPPED_HOST.test(address));
};

// ---- one document -------------------------------------------------------------

const SLOT_USE = { flag: "flag", emblem: "picture", logo: "logo", basemap: "basemap", cover: "cover", picture: "picture" };
// More SVGs than this in one file are not drawn: each takes a moment, and a
// file made of them would keep a run busy for as long as its author liked.
const MAX_DRAWINGS = 600;

// Applies the rules to one parsed document, `label` being how it is named in
// a sentence. Problems go to `findings`; pictures that had to be put right are
// replaced in place. Returns whether the document was changed.
export const checkDocument = async (root, { label, findings, slots = new Slots(), ctx, drawn = { count: 0, cache: new Map() } }) => {
  if (root === null || typeof root !== "object") return false;
  const pictures = [];
  const complete = walk(root, {
    onKey: (frame, key) => {
      findings.problem(`${label} has a field named ${quoted(key)} (at ${pathOf(frame, key)}), a name that can break the program that reads it`);
    },
    onString: (frame, key, value) => {
      const slot = slots.of(frame.node, key);
      if (slot === "payload") return;
      // Which one it is: the key of a list of flags, the name a polity's or an
      // institution's record is kept under, or else the place in the document.
      const where = slots.whole.has(frame.node) ? `key ${quoted(key)}` : slot && typeof frame.key === "string" ? `${quoted(frame.key)}` : `at ${pathOf(frame, key)}`;
      if (isDataAddress(value)) {
        const parsed = parseDataAddress(value);
        if (!parsed || !parsed.mime.startsWith("image/")) {
          findings.problem(`${label} holds a \`data:\` address that is not a picture (${quoted(parsed?.mime || "of no kind")}, ${where})`);
        } else {
          pictures.push({ container: frame.node, key, value, use: SLOT_USE[slot] ?? "picture", where });
        }
        return;
      }
      if (slot === "flag" || slot === "emblem") {
        const what = slot === "flag" ? "flag" : "logo";
        const wrong = flagAddressProblem(value);
        if (wrong === "remote") findings.problem(`${label} holds a ${what} that is loaded from another website (${quoted(hostOf(value.trim()))}, ${where}): a ${what} has to be carried in the file itself`);
        else if (wrong) findings.problem(`${label} holds a ${what} that is not an image the game can show (${where})`);
        return;
      }
      if (slot === "logo" || slot === "basemap" || slot === "cover" || slot === "picture") {
        if (value.trim()) findings.problem(`${label} holds a ${USES[SLOT_USE[slot]].what} that is not a picture carried in the file (${where})`);
        return;
      }
      if (value.length < 8) return;
      if (isScriptAddress(value) || (value.includes(":") && SCRIPT_IN_TEXT.test(value))) {
        findings.problem(`${label} holds a script address (\`javascript:\` or \`vbscript:\`, ${where})`);
      }
      for (const address of remotePictures(value)) {
        findings.problem(`${label} has text that shows a picture from another website (${quoted(hostOf(address))}, ${where}): the game would load it from there for every player`);
      }
    },
  });
  if (!complete) {
    findings.problem(`${label} is nested more than ${MAX_DEPTH} levels deep, which nothing the game writes is`);
    return false;
  }

  let changed = false;
  for (const picture of pictures) {
    const what = USES[picture.use].what;
    let result = drawn.cache.get(`${picture.use}\n${picture.value}`);
    if (!result) {
      const isSvg = parseDataAddress(picture.value)?.mime === "image/svg+xml";
      if (isSvg && ctx.repair !== false && (drawn.count += 1) > MAX_DRAWINGS) {
        findings.problem(`${label} holds more than ${count(MAX_DRAWINGS)} SVG pictures, more than the hub converts in one file: save them as PNG`);
        continue;
      }
      try {
        result = await checkPictureAddress(picture.value, picture.use, ctx);
      } catch (error) {
        if (!(error instanceof Problem)) throw error;
        result = { problem: error.message };
      }
      drawn.cache.set(`${picture.use}\n${picture.value}`, result);
    }
    if (result.problem) {
      findings.problem(`${label} holds a ${what} that can't be used (${picture.where}): ${result.problem}`);
      continue;
    }
    if (result.text === picture.value) continue;
    picture.container[picture.key] = result.text;
    changed = true;
    for (const change of result.changes) findings.repaired(change.kind === "svg" ? `svg:${picture.use}` : change.kind);
  }
  return changed;
};
