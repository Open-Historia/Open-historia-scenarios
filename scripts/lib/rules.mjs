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
import { Problem, addressStart, count, plural, quoted } from "./util.mjs";

// ---- what a check found -------------------------------------------------------

const MAX_PROBLEMS = 12;

export class Findings {
  problems = [];
  #more = 0;
  #known = new Set();
  #repairs = new Map(); // what was put right -> how many times
  renamed = []; // [from, to] for entries of a zip

  // A whole sentence, without its full stop. The first dozen are kept and the
  // rest only counted: a file can be made to have millions.
  problem(sentence) {
    if (this.problems.length >= MAX_PROBLEMS) {
      this.#more += 1;
      return;
    }
    if (this.#known.has(sentence)) return;
    this.#known.add(sentence);
    this.problems.push(`${sentence[0].toUpperCase()}${sentence.slice(1)}.`);
  }

  repaired(kind, times = 1) {
    this.#repairs.set(kind, (this.#repairs.get(kind) ?? 0) + times);
  }

  get failed() {
    return this.problems.length > 0;
  }

  // One more problem, where it has been found and what it says is `say()`:
  // once the list is full the sentence is not even written, because a file can
  // be made to have a problem in every one of its millions of values.
  found(say) {
    if (this.problems.length >= MAX_PROBLEMS) this.#more += 1;
    else this.problem(say());
  }

  // The problems, with a last line for those there was no room for.
  sentences() {
    return this.#more ? [...this.problems, `And ${plural(this.#more, "more problem")} of the same kinds.`] : [...this.problems];
  }

  // What was put right inside a document, as short phrases.
  repairPhrases() {
    // (The first few names: a zip may hold hundreds of SVGs, and this is one line.)
    const phrases = this.renamed.slice(0, 4).map(([from, to]) => `${quoted(from)} → ${quoted(to)}`);
    if (this.renamed.length > 4) phrases.push(`${plural(this.renamed.length - 4, "more entry", "more entries")} renamed the same way`);
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
    const whole = this.whole.get(container);
    if (whole) return whole;
    // (A key is whatever the file's author wrote: "constructor" is a key too.)
    const fields = this.fields.get(container);
    return fields && Object.hasOwn(fields, key) ? fields[key] : undefined;
  }
}

// ---- walking a document -------------------------------------------------------

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
// (Nothing the game writes is nested a tenth as deep.)
export const MAX_DEPTH = 200;

// "data.world.polityOverrides.France.flag", from the visit that reached it.
// (Each name only by its start: a name can be as long as the file.)
const pathOf = (frame, key) => {
  const parts = [key];
  for (let at = frame; at && at.parent; at = at.parent) parts.push(at.key);
  return quoted(parts.reverse().map((part, index) => (typeof part === "number" ? `[${part}]` : `${index ? "." : ""}${part.slice(0, 60)}`)).join(""), 90);
};

// A pair or triple of numbers: one point of a shape. A map has millions, and
// none needs a visit of its own.
const isPoint = (value) => value.length <= 4 && typeof value[0] === "number" && (value.length < 2 || typeof value[1] === "number")
  && (value.length < 3 || typeof value[2] === "number") && (value.length < 4 || typeof value[3] === "number");

// Walks `root` in the order it is written, calling onKey(frame, key) for a
// forbidden key and onString(frame, key, value) for every string. Returns
// false when the document is nested too deeply to go on. What is kept while
// walking is one frame for each level it is inside of, and not one for every
// value still to come: a list can have ten million.
const frameOf = (node, parent, key) => ({ node, keys: Array.isArray(node) ? null : Object.keys(node), next: 0, parent, key, depth: parent ? parent.depth + 1 : 0 });
const walk = (root, { onKey, onString }) => {
  let frame = frameOf(root, null, "");
  while (frame) {
    const { node, keys } = frame;
    if (frame.next >= (keys ? keys.length : node.length)) {
      frame = frame.parent;
      continue;
    }
    const key = keys ? keys[frame.next] : frame.next;
    frame.next += 1;
    if (keys && FORBIDDEN_KEYS.has(key)) onKey(frame, key);
    const value = node[key];
    if (typeof value === "string") onString(frame, key, value);
    else if (value !== null && typeof value === "object") {
      if (Array.isArray(value) && (!value.length || isPoint(value))) continue;
      if (frame.depth >= MAX_DEPTH) return false;
      frame = frameOf(value, frame, key);
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
const SCRIPT = /^(?:javascript|vbscript):/i;
const SHIPPED_HOST = /^https:\/\/flagcdn\.com\//i;
const hostOf = (address) => address.replace(REMOTE, "").replace(/^\/+/, "").split(/[/?#:@]/)[0];

// An address as a browser reads it: tabs and line breaks dropped wherever they
// stand, and the blanks and control characters in front of it.
const asBrowserReads = (address) => address.replace(/[\t\n\r]/g, "").replace(/^[\x00-\x20]+/, "").trimEnd();

// Whether `value` may stand where a flag or a logo is named, when it is not a
// picture carried in the file: nothing, a flag of the game's own, or a path
// with no scheme, no "//", no ".." and no backslash (which a browser reads as
// a slash), which can only lead into the game.
const flagAddressProblem = (value) => {
  const address = asBrowserReads(value);
  if (!address || BUILT_IN_FLAG.test(address)) return "";
  if (REMOTE.test(address)) return "remote";
  if (HAS_SCHEME.test(address) || address.includes("//") || address.includes("..") || address.includes("\\")) return "odd";
  return "";
};

// The start of an address written inside text, in each way it may be read:
// with characters written as references read as the characters ("&#104;ttps:",
// "&colon;"), as HTML and Markdown both do, and then also with Markdown's
// backslashes undone ("https\://"). Either reading counts.
const NAMED_CHARACTERS = { colon: ":", sol: "/", bsol: "\\", Tab: "", NewLine: "", period: ".", amp: "&" };
const character = (code) => (code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "");
const readings = (raw) => {
  // (Most have neither a reference nor a backslash in them, and are what they say.)
  if (!raw.includes("&") && !raw.includes("\\")) return [raw];
  const plain = asBrowserReads(raw
    .replace(/&#x([0-9a-f]{1,6});?/gi, (whole, hex) => character(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});?/g, (whole, digits) => character(Number(digits)))
    .replace(/&([A-Za-z]{2,8});/g, (whole, name) => (Object.hasOwn(NAMED_CHARACTERS, name) ? NAMED_CHARACTERS[name] : whole)));
  const unescaped = asBrowserReads(plain.replace(/\\([!-/:-@[-`{-~])/g, "$1"));
  return unescaped === plain ? [plain] : [plain, unescaped];
};

// What a text embeds or links that it may not: the websites it would load a
// picture from, and whether it carries a script address where a browser would
// follow one.
//
// The game shows text as Markdown. Telling exactly which "](" closes a picture
// takes all of Markdown's rules (a "]" inside a code span closes nothing, a
// picture's caption may hold links and brackets of its own), and a text made
// to slip past a reader that follows fewer rules than the game's would. So a
// picture is told by the least it needs: after a "![" that is not written
// "\![", every "](address)" is taken for a picture's, and every "[name]:
// address" anywhere in such a text too (a picture can be given its address by
// name, on another line, in a quote). A text with a "![" in it and a plain
// link to a website after it is refused with the rest; a link alone never is.
//
// HTML the game does not render, and is read the same way in case something
// ever does: in a text with an <img>, every src and srcset after it.
//
// Each is found in passes that read no part of the text twice, however long
// it is and whatever it is made of.

// Where an address is written (after "](" or "]:"), its first 300 characters
// as a browser would be handed them: the blanks and the "<" in front of it
// passed over, tabs and line breaks left out, to the end of the link. It stops
// at a "]" in any case, where the next link could begin, so that a text made
// of nothing but links is still read once.
const targetAt = (text, from) => {
  let target = "";
  for (let at = from; at < text.length && target.length < 300; at += 1) {
    const code = text.charCodeAt(at);
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code === 0x29 || code === 0x3e || code === 0x5d) break;
    if (!target && (code <= 0x20 || code === 0x3c)) continue;
    target += text[at];
  }
  return target;
};

const ATTRIBUTE = /\b(src|srcset|href|action|formaction|poster|data)\s*=\s*(?:"([^"]*)|'([^']*)|([^\s"'>]{1,300}))/gi;
const IMAGE_TAG = /<(?:img|image)\b/i;
const CANDIDATE = /(?:^|,)\s*([^,]{0,300})/g;
const scanText = (text) => {
  const hosts = new Set();
  let script = false;
  // An address found in the text, its start as targetAt or addressStart gives
  // it: a link's, and when `shown` a picture's, which the game would load.
  const found = (raw, shown) => {
    if (raw.length < 2) return;
    for (const reading of readings(raw)) {
      if (SCRIPT.test(reading)) script = true;
      if (!shown) continue;
      // (A browser reads a backslash in an address as a slash.)
      const address = reading.replace(/\\/g, "/");
      if (REMOTE.test(address) && !SHIPPED_HOST.test(address)) hosts.add(hostOf(address));
    }
  };

  const named = text.includes("]:");
  if (named || text.includes("](")) {
    let pictures = false; // a "![" has been passed
    for (let at = 0; at < text.length; at += 1) {
      const code = text.charCodeAt(at);
      if (code === 0x5c) at += 1; // a backslash: the next character is only itself
      else if (code === 0x21) pictures ||= text.charCodeAt(at + 1) === 0x5b;
      else if (code === 0x5d && text.charCodeAt(at + 1) === 0x28) found(targetAt(text, at + 2), pictures);
    }
    if (named) {
      for (let at = text.indexOf("]:"); at >= 0; at = text.indexOf("]:", at + 2)) found(targetAt(text, at + 2), pictures);
    }
  }
  // HTML: only a text with a tag in it can have an attribute a browser follows.
  if (text.includes("<")) {
    const image = text.search(IMAGE_TAG);
    for (const attribute of text.matchAll(ATTRIBUTE)) {
      const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
      const name = attribute[1].toLowerCase();
      const inImage = image >= 0 && attribute.index > image;
      found(addressStart(value, 300), inImage && name === "src");
      // (A srcset names several pictures, each with a size after it.)
      if (inImage && name === "srcset") for (const candidate of value.matchAll(CANDIDATE)) found(addressStart(candidate[1], 300), true);
    }
  }
  return { hosts: [...hosts], script };
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
  // Which one a string is: the key of a list of flags, the name a polity's or
  // an institution's record is kept under, or else the place in the document.
  // (Worked out only for a string that is spoken of: a document has millions.)
  const whereOf = (frame, key, slot) => (slots.whole.has(frame.node) ? `key ${quoted(key)}` : slot && typeof frame.key === "string" ? quoted(frame.key) : `at ${pathOf(frame, key)}`);
  const complete = walk(root, {
    onKey: (frame, key) => {
      findings.found(() => `${label} has a field named ${quoted(key)} (at ${pathOf(frame, key)}), a name that can break the program that reads it`);
    },
    onString: (frame, key, value) => {
      const slot = slots.of(frame.node, key);
      if (slot === "payload") return;
      const where = () => whereOf(frame, key, slot);
      if (isDataAddress(value)) {
        const parsed = parseDataAddress(value);
        if (!parsed || !parsed.mime.startsWith("image/")) {
          findings.found(() => `${label} holds a \`data:\` address that is not a picture (${quoted(parsed?.mime || "of no kind")}, ${where()})`);
        } else {
          pictures.push({ container: frame.node, key, value, use: SLOT_USE[slot] ?? "picture", where });
        }
        return;
      }
      if (slot === "flag" || slot === "emblem") {
        const what = slot === "flag" ? "flag" : "logo";
        const wrong = flagAddressProblem(value);
        if (wrong === "remote") findings.found(() => `${label} holds a ${what} that is loaded from another website (${quoted(hostOf(asBrowserReads(value).replace(/\\/g, "/")))}, ${where()}): a ${what} has to be carried in the file itself`);
        else if (wrong) findings.found(() => `${label} holds a ${what} that is not an image the game can show (${where()})`);
        return;
      }
      if (slot === "logo" || slot === "basemap" || slot === "cover" || slot === "picture") {
        if (value.trim()) findings.found(() => `${label} holds a ${USES[SLOT_USE[slot]].what} that is not a picture carried in the file (${where()})`);
        return;
      }
      if (value.length < 8) return;
      const inText = scanText(value);
      if (inText.script || SCRIPT.test(addressStart(value, 12))) {
        findings.found(() => `${label} holds a script address (\`javascript:\` or \`vbscript:\`, ${where()})`);
      }
      for (const host of inText.hosts) {
        findings.found(() => `${label} has text that shows a picture from another website (${quoted(host)}, ${where()}): the game would load it from there for every player`);
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
    // The same picture used again (one flag for several countries) is checked once.
    if (!drawn.cache.has(picture.use)) drawn.cache.set(picture.use, new Map());
    const checkedBefore = drawn.cache.get(picture.use);
    let result = checkedBefore.get(picture.value);
    if (!result) {
      const isSvg = parseDataAddress(picture.value)?.mime === "image/svg+xml";
      if (isSvg && ctx.repair !== false && (drawn.count += 1) > MAX_DRAWINGS) {
        findings.problem(`${label} holds more than ${count(MAX_DRAWINGS)} SVG pictures, more than the hub converts in one file: save them as PNG`);
        continue;
      }
      try {
        const { text, changes } = await checkPictureAddress(picture.value, picture.use, ctx);
        result = { text, changes };
      } catch (error) {
        if (!(error instanceof Problem)) throw error;
        result = { problem: error.message };
      }
      checkedBefore.set(picture.value, result);
    }
    if (result.problem) {
      findings.found(() => `${label} holds a ${what} that can't be used (${picture.where()}): ${result.problem}`);
      continue;
    }
    if (result.text === picture.value) continue;
    picture.container[picture.key] = result.text;
    changed = true;
    for (const change of result.changes) findings.repaired(change.kind === "svg" ? `svg:${picture.use}` : change.kind);
  }
  return changed;
};
