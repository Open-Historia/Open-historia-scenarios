// One picture, checked for what it is used as: a flag, a scenario's cover, a
// basemap, an institution's logo, or simply a picture attached to a post.
//
// Whatever comes out of here is a PNG, JPEG, GIF or WebP (or, for a cover
// only, an AVIF) that reaches its own end and is no larger than its use
// allows. Three things are put right rather than refused:
//
//   - an SVG is drawn as a PNG (svg.mjs);
//   - bytes after the end of the picture are cut off;
//   - a flag heavier than the game's flag library takes (2 MiB) is drawn again
//     smaller.
//
// A suggestion cannot be put right (it stays its author's attachment), so
// there, with `repair` off, each of these is a reason to refuse it instead.

import { IMAGE_MIME, MIME_IMAGE, imageType, readImage } from "./images.mjs";
import { looksLikeSvg, redrawSmaller, svgToPng } from "./svg.mjs";
import { KIB, MIB, Problem, count, sizeText } from "./util.mjs";

const RASTER = new Set(["png", "jpg", "gif", "webp"]);
export const MAX_PICTURE_BYTES = 30 * MIB;

// `what` is how the use is named in a sentence; `svg` is how an SVG is drawn
// for it (the size of its longer side; `exact: false` keeps the SVG's own size
// when that is smaller).
export const USES = {
  // The game's own limit (MAX_FLAG_BYTES): a heavier flag cannot be kept in a
  // player's flag library.
  flag: { what: "flag", maxBytes: 2 * MIB, lighter: [1024, 768, 512, 384, 256], maxPixels: 16e6, svg: { longest: 1024, exact: true }, types: RASTER },
  // The game serves a logo only up to 512 KiB (MAX_INSTITUTION_LOGO_BYTES).
  logo: { what: "logo", maxBytes: 512 * KIB, lighter: [384, 256, 128], maxPixels: 16e6, svg: { longest: 512, exact: true }, types: RASTER },
  cover: { what: "cover", maxBytes: MAX_PICTURE_BYTES, maxPixels: 40e6, svg: { longest: 1600, exact: true }, types: new Set([...RASTER, "avif"]) },
  basemap: { what: "basemap", maxBytes: MAX_PICTURE_BYTES, maxPixels: 150e6, maxSide: 16384, svg: { longest: 8192, exact: false }, types: RASTER },
  picture: { what: "picture", maxBytes: MAX_PICTURE_BYTES, maxPixels: 40e6, svg: { longest: 1600, exact: true }, types: RASTER },
};

const megapixels = (pixels) => `${Math.round(pixels / 1e6)} megapixels`;

// { bytes, type, width, height, changes } for a picture that can be released
// as `use`; `changes` lists what was put right ({ kind: "svg" | "trimmed" |
// "lighter", ... }). Throws a Problem, which finishes "... can't be used: ",
// for one that cannot.
export const checkPicture = async (input, useName, { rasteriser, repair = true } = {}) => {
  const use = USES[useName];
  let bytes = input;
  if (!bytes.length) throw new Problem("it is empty");
  if (bytes.length > MAX_PICTURE_BYTES) throw new Problem(`it is ${sizeText(bytes.length)}, and a picture can be ${sizeText(MAX_PICTURE_BYTES)} at most`);
  const changes = [];
  let type = imageType(bytes);
  let width;
  let height;

  if (!type && looksLikeSvg(bytes)) {
    if (!repair) throw new Problem("it is an SVG, and an SVG cannot be used here: save it as a PNG and use that instead");
    const drawn = await svgToPng(bytes, { ...use.svg, rasteriser });
    changes.push({ kind: "svg", width: drawn.width, height: drawn.height, lostText: drawn.lostText });
    ({ bytes, width, height } = drawn);
    type = "png";
  } else {
    if (!type) throw new Problem("it is not a picture the game can show (a PNG, JPEG, WebP or GIF)");
    if (!use.types.has(type)) throw new Problem(`it is an ${type.toUpperCase()}, which the game shows only as a scenario's cover: save it as a PNG or a JPEG`);
    const read = readImage(bytes);
    ({ width, height } = read);
    if (read.length < bytes.length) {
      const extra = bytes.length - read.length;
      if (!repair) throw new Problem(`${count(extra)} bytes follow the end of the picture in it, which a picture has no use for`);
      changes.push({ kind: "trimmed", bytes: extra });
      bytes = bytes.subarray(0, read.length);
    }
  }

  if (use.maxSide && Math.max(width, height) > use.maxSide) {
    throw new Problem(`it is ${count(width)}×${count(height)} pixels, and a ${use.what} can be ${count(use.maxSide)} pixels a side at most`);
  }
  if (width * height > use.maxPixels) {
    throw new Problem(`it is ${count(width)}×${count(height)} pixels (${megapixels(width * height)}), and a ${use.what} can be ${megapixels(use.maxPixels)} at most`);
  }
  if (bytes.length > use.maxBytes) {
    const tooHeavy = new Problem(`it is ${sizeText(bytes.length)}, and a ${use.what} can be ${sizeText(use.maxBytes)} at most`);
    // A flag is made lighter. A logo only when it has just been drawn from an
    // SVG, where the size was this file's choice and not its author's.
    const drawnHere = changes.some((change) => change.kind === "svg");
    if (!use.lighter || !repair || (useName !== "flag" && !drawnHere)) throw tooHeavy;
    const before = bytes.length;
    let lighter = null;
    for (const longest of use.lighter) {
      if (longest > Math.max(width, height) && lighter) continue;
      lighter = await redrawSmaller(bytes, { width, height, longest, rasteriser });
      // null: the renderer cannot read this kind of picture (a WebP).
      if (!lighter || lighter.bytes.length <= use.maxBytes) break;
    }
    if (!lighter || lighter.bytes.length > use.maxBytes) {
      throw new Problem(`it is ${sizeText(before)}, and a ${use.what} can be ${sizeText(use.maxBytes)} at most${type === "webp" ? " (the hub can make a PNG, JPEG or GIF smaller, but not a WebP)" : ""}`);
    }
    // Drawn from an SVG a moment ago, it was never that heavy as far as its
    // author is concerned: the line about the SVG gives the final size instead.
    if (drawnHere) Object.assign(changes.find((change) => change.kind === "svg"), { width: lighter.width, height: lighter.height });
    else changes.push({ kind: "lighter", from: before, width: lighter.width, height: lighter.height });
    ({ bytes, width, height } = lighter);
    type = "png";
  }
  return { bytes, type, width, height, changes };
};

// What was put right, each as a line for the person reading the result.
export const describeChange = (change) => {
  if (change.kind === "svg") {
    return `SVG drawn as a ${change.width}×${change.height} PNG${change.lostText ? " (its text is left out: text in an SVG has to be turned into shapes before it can be drawn)" : ""}`;
  }
  if (change.kind === "trimmed") return `${count(change.bytes)} ${change.bytes === 1 ? "byte" : "bytes"} after the end of the image ${change.bytes === 1 ? "was" : "were"} cut off`;
  if (change.kind === "lighter") return `shrunk from ${sizeText(change.from)} to a ${change.width}×${change.height} PNG`;
  if (change.kind === "relabelled") return `its type corrected to ${change.to}`;
  return String(change.kind);
};

// ---- pictures written as data: addresses --------------------------------------

// Text in base64 as the strictest of the game's readers takes it (the
// browser's atob): the 64 characters, "=" only as padding at the end, spaces
// and line breaks ignored. The bytes, or null for anything else.
const BASE64_CHARACTER = new Uint8Array(128);
for (const char of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/") BASE64_CHARACTER[char.charCodeAt(0)] = 1;
for (const char of " \t\n\f\r") BASE64_CHARACTER[char.charCodeAt(0)] = 2;
export const base64Bytes = (text) => {
  let symbols = 0;
  let padding = 0;
  let spaces = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const kind = code < 128 ? BASE64_CHARACTER[code] : 0;
    if (kind === 1) {
      if (padding) return null;
      symbols += 1;
    } else if (kind === 2) spaces = true;
    else if (code === 61 && padding < 2) padding += 1;
    else return null;
  }
  if (symbols % 4 === 1 || (padding && (symbols + padding) % 4)) return null;
  return Buffer.from(spaces ? text.replace(/[ \t\n\f\r]+/g, "") : text, "base64");
};

// "data:<type>[;parameters][;base64],<data>" in its parts, or null.
const DATA_ADDRESS = /^\s*data:([^,;]*)((?:;[^,;]*)*),/i;
export const isDataAddress = (text) => text.length >= 5 && /^\s*data:/i.test(text.slice(0, 16));
export const parseDataAddress = (text) => {
  const head = DATA_ADDRESS.exec(text.slice(0, 300));
  if (!head) return null;
  return { mime: head[1].trim().toLowerCase(), base64: /;\s*base64\s*$/i.test(head[2]), start: head[0].length };
};
const percentDecoded = (text) => {
  const bytes = [];
  const plain = Buffer.from(text, "utf8");
  for (let index = 0; index < plain.length; index += 1) {
    const hex = plain[index] === 0x25 ? plain.toString("latin1", index + 1, index + 3) : "";
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      index += 2;
    } else bytes.push(plain[index]);
  }
  return Buffer.from(bytes);
};

// A picture's data: address, checked as `use`: the address to keep (the same
// text when nothing had to be put right) and what was put right. Throws a
// Problem that finishes "... is not a picture the game can show: ...".
export const checkPictureAddress = async (text, useName, options = {}) => {
  const parsed = parseDataAddress(text);
  if (!parsed) throw new Problem("it is not a complete data: address");
  const payload = text.slice(parsed.start);
  const bytes = parsed.base64 ? base64Bytes(payload) : percentDecoded(payload);
  if (!bytes) throw new Problem("what it carries is not base64");
  const checked = await checkPicture(bytes, useName, options);
  const said = parsed.mime === "image/svg+xml" ? "svg" : MIME_IMAGE[parsed.mime] ?? "";
  const changes = [...checked.changes];
  // An address that says "image/png" and carries a JPEG is shown all the same;
  // one that says "svg+xml" and carries a PNG is not. Put right either way.
  if (!changes.length && said !== checked.type && options.repair !== false) changes.push({ kind: "relabelled", from: parsed.mime, to: IMAGE_MIME[checked.type] });
  if (!changes.length) return { text, changes, type: checked.type, bytes: checked.bytes };
  return { text: `data:${IMAGE_MIME[checked.type]};base64,${checked.bytes.toString("base64")}`, changes, type: checked.type, bytes: checked.bytes };
};
