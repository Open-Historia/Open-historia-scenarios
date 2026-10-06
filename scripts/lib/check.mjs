// One file attached to a post: what it is, whether it can be released, and the
// bytes that are released, which are the checked ones and not always the ones
// that were attached (an SVG is released as its PNG, a .zip as the zip written
// again from its checked entries).
//
// Everything here works on bytes in memory, with the code in this folder and
// one renderer for SVGs (svg.mjs). Nothing an author sent is handed to a
// shell, written to disk under a name it chose, or followed to an address it
// names.

import { checkBasemapFile, checkScenarioFile, checkSuggestionFile } from "./content.mjs";
import { imageType } from "./images.mjs";
import { checkPicture, describeChange } from "./pictures.mjs";
import { looksLikeSvg, sharedRasteriser, withinBudget } from "./svg.mjs";
import { Problem } from "./util.mjs";

// What a file is, from its first bytes: the game tells a scenario .zip from a
// .json the same way, never by its name. "zip", "json", "svg", a picture's
// kind ("png", "jpg", "gif", "webp", "avif"), or "".
export const sniffType = (bytes) => {
  // Only this: the game takes a file for a zip when it starts with a zip
  // entry, so an archive with anything in front of it is not one to the game.
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06))) return "zip";
  const picture = imageType(bytes);
  if (picture) return picture;
  if (looksLikeSvg(bytes)) return "svg";
  // JSON: after a byte order mark and blanks, an object or a list.
  let at = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (at < bytes.length && at < 4096 && (bytes[at] === 0x20 || bytes[at] === 0x09 || bytes[at] === 0x0a || bytes[at] === 0x0d)) at += 1;
  return bytes[at] === 0x7b || bytes[at] === 0x5b ? "json" : "";
};

const PICTURES = new Set(["png", "jpg", "gif", "webp", "avif", "svg"]);

const CONTENT_TYPES = {
  zip: "application/zip",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
export const contentTypeOf = (type) => CONTENT_TYPES[type] ?? "application/octet-stream";

const refused = (label, reason) => ({ released: false, problems: [`${label} can't be used: ${reason}.`], repairs: [] });
const skipped = () => ({ released: false, skip: true, problems: [], repairs: [] });

const picture = async (bytes, use, { label, rasteriser }) => {
  try {
    const checked = await checkPicture(bytes, use, { rasteriser });
    return { released: true, type: checked.type, bytes: checked.bytes, pixels: [checked.width, checked.height], problems: [], repairs: checked.changes.map(describeChange) };
  } catch (error) {
    if (!(error instanceof Problem)) throw error;
    return refused(label, error.message);
  }
};

const dataFile = async (check, bytes, type, ctx) => {
  const { type: releasedType, bytes: releasedBytes, findings } = await check(bytes, type, ctx);
  if (findings.failed) return { released: false, problems: findings.sentences(), repairs: [] };
  const phrases = findings.repairPhrases();
  // A zip is always written again, so that is always said; a .json only says
  // what was put right in it.
  const repairs = releasedType === "zip" ? [`zip rebuilt${phrases.length ? `: ${phrases.join(", ")}` : " from its checked entries"}`] : phrases;
  return { released: true, type: releasedType, bytes: releasedBytes, problems: [], repairs };
};

// Checks one file of a post of `kind`. `primary` is THE file (the one the game
// imports); anything else attached is copied when it is a picture or a data
// file that passes, and left alone (`skip`) when it is neither.
//
// { released, type, bytes, repairs, problems, skip, pixels }: `problems` are
// whole sentences for the post's author, `repairs` short lines of what was put
// right; `bytes` and `type` are what goes into the release, and `pixels` the
// width and height of a picture.
export const checkPostFile = async ({ kind, primary, bytes, label, rasteriser, isHubAddress, drawingMs }) => {
  if (!bytes.length) return primary ? refused(label, "it is empty") : skipped();
  const type = sniffType(bytes);
  // Every SVG in the file is drawn within one allowance of time (svg.mjs).
  const ctx = { label, rasteriser: withinBudget(rasteriser ?? sharedRasteriser(), drawingMs), isHubAddress };

  if (PICTURES.has(type)) {
    if (kind === "scenario" && primary) return refused(label, "it is a picture, not a scenario file (.json or .zip)");
    // A flag post's picture is a flag; a basemap post's is the basemap, or
    // its preview, which may be as large; anything else is a picture on a card.
    return picture(bytes, primary && kind === "flag" ? "flag" : kind === "basemap" ? "basemap" : "picture", ctx);
  }
  if (type === "zip" || type === "json") {
    if (kind === "flag") return primary ? refused(label, "it is not an image (.png, .jpg, .webp, .gif or .svg)") : skipped();
    return dataFile(kind === "basemap" ? checkBasemapFile : checkScenarioFile, bytes, type, ctx);
  }
  if (!primary) return skipped();
  if (kind === "scenario") return refused(label, "it is not a scenario file: the game exports a .json or a .zip");
  if (kind === "flag") return refused(label, "it is not an image the game can read (.png, .jpg, .webp, .gif or .svg)");
  return refused(label, "it is not a basemap the game can read (an image, or the .zip the editor gave you)");
};

// Checks the file of a suggestion (a comment's .zip on a scenario post):
// { ok, problems }. Nothing is put right in one and nothing of it is released.
export const checkSuggestion = async ({ bytes, label, rasteriser, isHubAddress }) => {
  if (!bytes.length) return { ok: false, problems: [`${label} can't be used: it is empty.`] };
  const type = sniffType(bytes);
  // The game reads a suggestion's .zip, or a bare suggestion.json under a .zip's name.
  if (type !== "zip" && type !== "json") return { ok: false, problems: [`${label} can't be used: it is not a suggestion file (the .zip that Suggest changes saves).`] };
  const { findings } = await checkSuggestionFile(bytes, type, { label, rasteriser, isHubAddress });
  return { ok: !findings.failed, problems: findings.sentences() };
};
