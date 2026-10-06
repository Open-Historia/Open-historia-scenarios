// What a picture is, how large, and where it ends: read from the file's own
// structure, never from its name or from what it says it is.
//
// Each format is walked from its first byte to its last (a PNG's chunks to
// IEND, a JPEG's markers to the end of image, a GIF's blocks to the trailer, a
// WebP's chunks to the end of its RIFF, an AVIF's boxes to the end of the
// file). A file that does not get there is refused. A file that goes on after
// its end is cut there: a picture with something appended is the usual way to
// carry a second file inside an innocent one, and a picture loses nothing by it.
//
// Nothing here decodes pixels. The size comes from the header, which is enough
// to refuse a picture too large for its use before anything tries to draw it.

import { Problem, crc32 } from "./util.mjs";

const cut = () => new Problem("it is cut short: the file ends before the picture does");
const damaged = (what) => new Problem(`it is damaged (${what})`);
const empty = () => new Problem("it holds no picture");

const ascii = (bytes, from, to) => bytes.toString("latin1", from, to);

// ---- PNG ----------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const readPng = (bytes) => {
  let at = 8;
  let width = 0;
  let height = 0;
  let pixels = false;
  for (let first = true; ; first = false) {
    if (at + 12 > bytes.length) throw cut();
    const length = bytes.readUInt32BE(at);
    const type = ascii(bytes, at + 4, at + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw damaged("one of its parts has no name");
    const end = at + 12 + length;
    if (end > bytes.length) throw cut();
    if (crc32(bytes.subarray(at + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw damaged(`its ${type} part fails its checksum`);
    if (first) {
      if (type !== "IHDR" || length !== 13) throw damaged("it does not start with its header");
      width = bytes.readUInt32BE(at + 8);
      height = bytes.readUInt32BE(at + 12);
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) throw damaged("its header gives no size");
    } else if (type === "IHDR") {
      throw damaged("it has two headers");
    } else if (type === "IDAT") {
      pixels = true;
    } else if (type === "IEND") {
      if (!pixels) throw empty();
      return { type: "png", width, height, length: end };
    }
    at = end;
  }
};

// ---- JPEG ---------------------------------------------------------------------

// The markers that start a frame and carry its size: SOF0 to SOF15, without
// the three in that range that mean something else (DHT, JPG, DAC).
const startsFrame = (marker) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

const readJpeg = (bytes) => {
  let at = 2;
  let width = 0;
  let height = 0;
  let scans = 0;
  for (;;) {
    if (at >= bytes.length) throw cut();
    if (bytes[at] !== 0xff) throw damaged("something that is not part of a JPEG sits between its parts");
    while (at < bytes.length && bytes[at] === 0xff) at += 1; // a marker may be padded with more 0xFF
    if (at >= bytes.length) throw cut();
    const marker = bytes[at];
    at += 1;
    if (marker === 0xd9) {
      if (!width || !height || !scans) throw empty();
      return { type: "jpg", width, height, length: at };
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // these stand alone
    if (marker === 0x00 || marker === 0xd8) throw damaged("its parts are out of order");
    if (at + 2 > bytes.length) throw cut();
    const length = bytes.readUInt16BE(at);
    if (length < 2) throw damaged("one of its parts gives no length");
    if (at + length > bytes.length) throw cut();
    if (startsFrame(marker)) {
      if (length < 8) throw damaged("its frame header is too short");
      height = bytes.readUInt16BE(at + 3);
      width = bytes.readUInt16BE(at + 5);
    }
    at += length;
    if (marker !== 0xda) continue;
    // After a start of scan comes the compressed picture: everything up to the
    // next marker. Inside it 0xFF is always followed by 0x00 (a literal 0xFF)
    // or by a restart marker.
    scans += 1;
    for (;;) {
      const mark = bytes.indexOf(0xff, at);
      if (mark < 0 || mark + 1 >= bytes.length) throw cut();
      const next = bytes[mark + 1];
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) at = mark + 2;
      else if (next === 0xff) at = mark + 1;
      else {
        at = mark;
        break;
      }
    }
  }
};

// ---- GIF ----------------------------------------------------------------------

const readGif = (bytes) => {
  if (bytes.length < 13) throw cut();
  let width = bytes.readUInt16LE(6);
  let height = bytes.readUInt16LE(8);
  const tableSize = (flags) => (flags & 0x80 ? 3 * (2 << (flags & 7)) : 0);
  let at = 13 + tableSize(bytes[10]);
  let frames = 0;
  // Data in a GIF comes in runs of up to 255 bytes, each led by its length; a
  // length of zero ends them.
  const skipRuns = () => {
    for (;;) {
      if (at >= bytes.length) throw cut();
      const size = bytes[at];
      at += 1 + size;
      if (!size) return;
    }
  };
  for (;;) {
    if (at >= bytes.length) throw cut();
    const block = bytes[at];
    at += 1;
    if (block === 0x3b) {
      if (!frames || !width || !height) throw empty();
      return { type: "gif", width, height, length: at };
    }
    if (block === 0x21) {
      at += 1; // which extension it is
      skipRuns();
    } else if (block === 0x2c) {
      if (at + 9 > bytes.length) throw cut();
      // A few GIFs leave the screen size empty and size the picture by its
      // first frame.
      if (!width) width = bytes.readUInt16LE(at + 4);
      if (!height) height = bytes.readUInt16LE(at + 6);
      at += 9 + tableSize(bytes[at + 8]) + 1; // the frame's header, its colours, the code size
      skipRuns();
      frames += 1;
    } else {
      throw damaged("something that is not part of a GIF sits between its parts");
    }
  }
};

// ---- WebP ---------------------------------------------------------------------

const readWebp = (bytes) => {
  if (bytes.length < 20) throw cut();
  const end = 8 + bytes.readUInt32LE(4);
  if (end > bytes.length) throw cut();
  if (end < 20) throw damaged("it says it is shorter than its own header");
  let at = 12;
  let width = 0;
  let height = 0;
  let pixels = false;
  for (let first = true; at < end; first = false) {
    if (at + 8 > end) throw damaged("its last part is incomplete");
    const type = ascii(bytes, at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    const data = at + 8;
    // (A part's name is four bytes of the file's own: said only when it is a name.)
    if (data + size > end) throw damaged(/^[A-Za-z0-9]{3,4} ?$/.test(type) ? `its ${type.trim()} part runs past the end` : "one of its parts runs past the end");
    if (first) {
      if (type === "VP8 ") {
        if (size < 10 || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) throw damaged("its picture has no header");
        width = bytes.readUInt16LE(data + 6) & 0x3fff;
        height = bytes.readUInt16LE(data + 8) & 0x3fff;
        pixels = true;
      } else if (type === "VP8L") {
        if (size < 5 || bytes[data] !== 0x2f) throw damaged("its picture has no header");
        const bits = bytes.readUInt32LE(data + 1);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
        pixels = true;
      } else if (type === "VP8X") {
        if (size < 10) throw damaged("its header is too short");
        width = bytes.readUIntLE(data + 4, 3) + 1;
        height = bytes.readUIntLE(data + 7, 3) + 1;
      } else {
        throw damaged("it does not start with a picture");
      }
    } else if (type === "VP8 " || type === "VP8L" || type === "ANMF") {
      pixels = true;
    }
    at = data + size + (size & 1); // parts are padded to an even length
  }
  if (!pixels || !width || !height) throw empty();
  return { type: "webp", width, height, length: end };
};

// ---- AVIF ---------------------------------------------------------------------

// One box of an ISO media file: four bytes of length, four of name, and then
// its contents, which for some boxes are more boxes.
const readBox = (bytes, at, limit) => {
  if (at + 8 > limit) throw cut();
  const name = ascii(bytes, at + 4, at + 8);
  if (!/^[\x20-\x7e]{4}$/.test(name)) throw damaged("one of its parts has no name");
  let size = bytes.readUInt32BE(at);
  let header = 8;
  if (size === 1) {
    if (at + 16 > limit) throw cut();
    const large = bytes.readBigUInt64BE(at + 8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw cut();
    size = Number(large);
    header = 16;
  } else if (size === 0) {
    size = limit - at; // "to the end of the file"
  }
  if (size < header) throw damaged("one of its parts gives no length");
  if (at + size > limit) throw cut();
  return { name, start: at + header, end: at + size };
};
const boxesIn = (bytes, from, to) => {
  const boxes = [];
  for (let at = from; at < to; ) {
    const box = readBox(bytes, at, to);
    boxes.push(box);
    at = box.end;
  }
  return boxes;
};
const AVIF_BRANDS = new Set(["avif", "avis"]);
const avifBrands = (bytes) => {
  if (bytes.length < 16 || ascii(bytes, 4, 8) !== "ftyp") return [];
  const end = Math.min(bytes.length, bytes.readUInt32BE(0));
  const brands = [ascii(bytes, 8, 12)];
  for (let at = 16; at + 4 <= end; at += 4) brands.push(ascii(bytes, at, at + 4));
  return brands;
};

const readAvif = (bytes) => {
  const top = boxesIn(bytes, 0, bytes.length);
  const meta = top.find((box) => box.name === "meta");
  if (!meta) throw empty();
  // meta > iprp > ipco holds one "ispe" (a width and a height) for each picture
  // in the file; the largest is the picture itself, the others its thumbnails.
  let width = 0;
  let height = 0;
  for (const properties of boxesIn(bytes, meta.start + 4, meta.end).filter((box) => box.name === "iprp")) {
    for (const container of boxesIn(bytes, properties.start, properties.end).filter((box) => box.name === "ipco")) {
      for (const property of boxesIn(bytes, container.start, container.end)) {
        if (property.name !== "ispe" || property.end - property.start < 12) continue;
        const w = bytes.readUInt32BE(property.start + 4);
        const h = bytes.readUInt32BE(property.start + 8);
        if (w * h > width * height) {
          width = w;
          height = h;
        }
      }
    }
  }
  if (!width || !height) throw damaged("it does not say how large it is");
  return { type: "avif", width, height, length: bytes.length };
};

// ---- all of them --------------------------------------------------------------

// "png", "jpg", "gif", "webp", "avif", or "" for anything else. An SVG is
// text, and is told apart in svg.mjs.
export const imageType = (bytes) => {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return "gif";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "webp";
  if (avifBrands(bytes).some((brand) => AVIF_BRANDS.has(brand))) return "avif";
  return "";
};

const READERS = { png: readPng, jpg: readJpeg, gif: readGif, webp: readWebp, avif: readAvif };

// { type, width, height, length } for a picture that is whole; `length` is
// where it ends, which is less than the file's when something follows it.
// Throws a Problem for a picture that is cut short or damaged, and for bytes
// that are no picture at all.
export const readImage = (bytes) => {
  const type = imageType(bytes);
  if (!type) throw new Problem("it is not a picture");
  try {
    return READERS[type](bytes);
  } catch (error) {
    if (error instanceof Problem) throw error;
    // A length that points outside the file, read before it could be checked.
    if (error instanceof RangeError) throw cut();
    throw error;
  }
};

export const IMAGE_MIME = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif" };
export const MIME_IMAGE = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif" };
