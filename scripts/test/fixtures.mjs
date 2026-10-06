// Files for the tests, made here rather than kept as binaries: pictures of each
// kind, zips (well made, and deliberately not), and scenarios.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { crc32 } from "../lib/util.mjs";
import { packEntry, writeZip } from "../lib/zip.mjs";

const u16le = (value) => Buffer.from([value & 0xff, (value >>> 8) & 0xff]);
const u32le = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0);
  return bytes;
};
const u32be = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value >>> 0);
  return bytes;
};

// ---- pictures -----------------------------------------------------------------

const pngChunk = (type, data = Buffer.alloc(0)) => {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  return Buffer.concat([u32be(data.length), body, u32be(crc32(body))]);
};
// A real PNG of one colour, or of noise (which does not compress, for a file
// that has to be heavy). `says` is a size for its header to claim that its
// pixels do not have: a picture that is small to send and enormous to decode.
export const png = ({ width = 4, height = 3, color = [200, 30, 30, 255], noise = false, says = [width, height] } = {}) => {
  const raw = Buffer.alloc(height * (1 + width * 4));
  let seed = 12345;
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4);
    for (let x = 0; x < width * 4; x += 1) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      raw[row + 1 + x] = noise ? (x % 4 === 3 ? 255 : seed >>> 24) : color[x % 4];
    }
  }
  const header = Buffer.concat([u32be(says[0]), u32be(says[1]), Buffer.from([8, 6, 0, 0, 0])]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: noise ? 1 : 9 })),
    pngChunk("IEND"),
  ]);
};

// The pixels of a PNG as this file and the renderer write them (8 bits, with
// alpha, not interlaced): [r, g, b, a, r, g, b, a, ...].
export const pngPixels = (bytes) => {
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (bytes[24] !== 8 || bytes[25] !== 6 || bytes[28] !== 0) throw new Error("not an 8-bit RGBA PNG");
  const parts = [];
  for (let at = 8; at < bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    if (bytes.toString("latin1", at + 4, at + 8) === "IDAT") parts.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const stride = width * 4;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const up = y ? pixels[(y - 1) * stride + x] : 0;
      const corner = y && x >= 4 ? pixels[(y - 1) * stride + x - 4] : 0;
      const estimate = left + up - corner;
      const paeth = Math.abs(estimate - left) <= Math.abs(estimate - up) && Math.abs(estimate - left) <= Math.abs(estimate - corner) ? left : Math.abs(estimate - up) <= Math.abs(estimate - corner) ? up : corner;
      const predicted = [0, left, up, (left + up) >> 1, paeth][filter];
      pixels[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + predicted) & 0xff;
    }
  }
  return { width, height, pixels };
};
// How many pixels of a PNG are (nearly) the colour [r, g, b].
export const pixelsOfColor = (bytes, [r, g, b]) => {
  const { pixels } = pngPixels(bytes);
  let found = 0;
  for (let at = 0; at < pixels.length; at += 4) {
    if (pixels[at + 3] > 200 && Math.abs(pixels[at] - r) < 24 && Math.abs(pixels[at + 1] - g) < 24 && Math.abs(pixels[at + 2] - b) < 24) found += 1;
  }
  return found;
};

// A JPEG in structure only (its picture would not decode): every part a reader
// has to step over, a frame that gives the size, a scan with a stuffed 0xFF
// and a restart marker in it, and the end.
const jpegPart = (marker, body) => Buffer.concat([Buffer.from([0xff, marker]), Buffer.from([(body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
export const jpeg = ({ width = 4, height = 3 } = {}) => Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  jpegPart(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
  jpegPart(0xdb, Buffer.alloc(65, 1)),
  jpegPart(0xc0, Buffer.from([8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0])),
  jpegPart(0xc4, Buffer.alloc(20, 1)),
  jpegPart(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
  Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a]),
  Buffer.from([0xff, 0xd9]),
]);
// A JPEG that decodes: 16 by 8, white on the left and red on the right.
export const REAL_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDABwTFRgVERwYFhgfHRwhKUUtKSYmKVQ8QDJFZFhpZ2JYYF9ufJ6GbnWWd19giruLlqOpsbOxa4TC0MGszp6usar/2wBDAR0fHykkKVEtLVGqcmByqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr/wAARCAAIABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDpK46iis5nZhep/9k=",
  "base64",
);

// A real GIF of one colour. Its pixels are written without compression: one
// 9-bit code each, and a "clear" before the code table could grow.
export const gif = ({ width = 4, height = 3, color = [30, 160, 60] } = {}) => {
  const codes = [];
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    if (pixel % 250 === 0) codes.push(256);
    codes.push(1);
  }
  codes.push(257);
  const packed = Buffer.alloc(Math.ceil((codes.length * 9) / 8));
  codes.forEach((code, index) => {
    for (let bit = 0; bit < 9; bit += 1) if (code & (1 << bit)) packed[(index * 9 + bit) >> 3] |= 1 << ((index * 9 + bit) & 7);
  });
  const runs = [];
  for (let at = 0; at < packed.length; at += 255) runs.push(Buffer.from([Math.min(255, packed.length - at)]), packed.subarray(at, at + 255));
  const colors = Buffer.alloc(256 * 3);
  colors.set(color, 3);
  return Buffer.concat([
    Buffer.from("GIF89a", "latin1"),
    u16le(width), u16le(height), Buffer.from([0xf7, 0, 0]),
    colors,
    Buffer.from([0x21, 0xf9, 4, 0, 0, 0, 0, 0]),
    Buffer.from([0x2c]), u16le(0), u16le(0), u16le(width), u16le(height), Buffer.from([0]),
    Buffer.from([8]), ...runs, Buffer.from([0]),
    Buffer.from([0x3b]),
  ]);
};

// A WebP in structure only: the lossless kind, or the extended kind that
// states its size in a header of its own. `weight` adds that many bytes of
// metadata, for a WebP that has to be heavy.
const riffChunk = (name, data) => Buffer.concat([Buffer.from(name, "latin1"), u32le(data.length), data, Buffer.alloc(data.length & 1)]);
export const webp = ({ width = 4, height = 3, extended = false, weight = 0 } = {}) => {
  const picture = riffChunk("VP8L", Buffer.concat([Buffer.from([0x2f]), u32le(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)), Buffer.from([0, 0, 0])]));
  const size = Buffer.concat([u32le(0), Buffer.from([(width - 1) & 0xff, ((width - 1) >> 8) & 0xff, (width - 1) >> 16, (height - 1) & 0xff, ((height - 1) >> 8) & 0xff, (height - 1) >> 16])]);
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), ...(extended || weight ? [riffChunk("VP8X", size)] : []), picture, ...(weight ? [riffChunk("EXIF", Buffer.alloc(weight, 1))] : [])]);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), u32le(body.length), body]);
};

// An AVIF in structure only.
const box = (name, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32be(body.length + 8), Buffer.from(name, "latin1"), body]);
};
export const avif = ({ width = 4, height = 3, brand = "avif" } = {}) => Buffer.concat([
  box("ftyp", Buffer.from(brand, "latin1"), u32be(0), Buffer.from(`${brand}mif1miaf`, "latin1")),
  box("meta", u32be(0), box("hdlr", Buffer.alloc(24)), box("iprp", box("ipco", box("ispe", u32be(0), u32be(width), u32be(height))))),
  box("mdat", Buffer.alloc(16, 7)),
]);

export const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 2"><rect width="3" height="2" fill="#c81e1e"/></svg>';
export const dataUrl = (mime, bytes) => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

// A tile archive in structure only: the header, and four parts inside the file.
export const pmtiles = ({ longer = 0 } = {}) => {
  const header = Buffer.alloc(127);
  header.write("PMTiles", 0, "latin1");
  header[7] = 3;
  [[127, 10], [137, 2], [139, 0], [139, 5 + longer]].forEach(([start, length], index) => {
    header.writeBigUInt64LE(BigInt(start), 8 + index * 16);
    header.writeBigUInt64LE(BigInt(length), 16 + index * 16);
  });
  return Buffer.concat([header, Buffer.alloc(17, 9)]);
};

// ---- zips ---------------------------------------------------------------------

const bytesOf = (data) => (Buffer.isBuffer(data) ? data : Buffer.from(typeof data === "string" ? data : JSON.stringify(data), "utf8"));

// A zip as the hub writes one, from { name: bytes | text | JSON }.
export const zip = (files) => writeZip(Object.entries(files).map(([name, data]) => packEntry(name, bytesOf(data), { store: /\.(?:png|jpe?g|gif|webp|bin|pmtiles)$/i.test(name) })));

// A zip written field by field, for the ones that have to be wrong. Each entry
// is { name, data } plus whatever it should lie about:
//   method, flags, crc, size, packedSize   what both its headers say
//   localName, localSize, localMethod      what only the entry's own header says
//   attributes, madeBy, extra, disk        fields of the list of entries
//   offset                                 where the list says the entry is
// and the archive takes { before, comment, after, count, disk, locator }.
export const rawZip = (entries, { before = Buffer.alloc(0), comment = "", after = Buffer.alloc(0), count = null, disk = 0, locator = false } = {}) => {
  const parts = [before];
  const directory = [];
  let offset = before.length;
  for (const entry of entries) {
    const data = bytesOf(entry.data ?? "");
    const method = entry.method ?? 0;
    const packed = entry.packed ?? (method === 8 ? zlib.deflateRawSync(data) : data);
    const name = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name, "utf8");
    const localName = entry.localName === undefined ? name : Buffer.from(entry.localName, "utf8");
    const crc = entry.crc ?? crc32(data);
    const size = entry.size ?? data.length;
    const packedSize = entry.packedSize ?? packed.length;
    const flags = entry.flags ?? 0;
    const local = Buffer.concat([
      u32le(0x04034b50), u16le(20), u16le(flags), u16le(entry.localMethod ?? method), u16le(0), u16le(0x21),
      u32le(crc), u32le(packedSize), u32le(entry.localSize ?? size), u16le(localName.length), u16le(0), localName, packed,
    ]);
    const extra = entry.extra ?? Buffer.alloc(0);
    directory.push(Buffer.concat([
      u32le(0x02014b50), u16le(entry.madeBy ?? 20), u16le(20), u16le(flags), u16le(method), u16le(0), u16le(0x21),
      u32le(crc), u32le(packedSize), u32le(size), u16le(name.length), u16le(extra.length), u16le(0), u16le(entry.disk ?? 0), u16le(0),
      u32le(entry.attributes ?? 0), u32le(entry.offset ?? offset), name, extra,
    ]));
    parts.push(local);
    offset += local.length;
  }
  const list = Buffer.concat(directory);
  const note = Buffer.from(comment, "utf8");
  const total = count ?? entries.length;
  return Buffer.concat([
    ...parts, list,
    ...(locator ? [Buffer.concat([u32le(0x07064b50), Buffer.alloc(16)])] : []),
    u32le(0x06054b50), u16le(disk), u16le(disk), u16le(total), u16le(total), u32le(list.length), u32le(offset), u16le(note.length), note,
    after,
  ]);
};

// The game opens zips with JSZip. It is no dependency of this repository; where
// a copy can be found (HUB_TEST_JSZIP names a folder whose node_modules has it,
// or the game's checkout sits beside this one), the tests open with it what the
// hub writes, and are skipped where it cannot.
const jszipHome = [process.env.HUB_TEST_JSZIP, path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "alpha2")]
  .filter(Boolean)
  .find((folder) => fs.existsSync(path.join(folder, "node_modules", "jszip", "package.json")));
export const JSZIP_MISSING = jszipHome ? false : "JSZip is not installed here (set HUB_TEST_JSZIP to a folder that has it)";
export const loadJSZip = () => createRequire(path.join(jszipHome, "package.json"))("jszip");

// ---- scenarios ----------------------------------------------------------------

export const featureCollection = (features = 1) => ({
  type: "FeatureCollection",
  features: Array.from({ length: features }, (_, index) => ({
    type: "Feature",
    properties: { name: `Region ${index + 1}` },
    geometry: { type: "Polygon", coordinates: [[[index, 0], [index + 1, 0], [index + 1, 1], [index, 0]]] },
  })),
});

// A scenario as the game exports one, with `assets` and `world` to add to it
// and anything else laid over the top.
export const scenario = ({ assets = {}, world = {}, ...top } = {}) => ({
  schema: "open-historia-scenario-bundle/2",
  version: 2,
  mode: "full",
  exportedAt: "2026-10-01T00:00:00.000Z",
  scenario: { id: "test-world", name: "Test world", description: "A world for the tests." },
  data: { actions: [], advisor: [], chat: [], events: [], game: {}, prompts: {}, world: { language: "en", ...world } },
  assets: {
    cover: { fileName: "cover-image.bin", mode: "default" },
    colors: { data: { France: [0, 85, 164] }, fileName: "colors.json", mode: "embedded" },
    flags: { fileName: "flags.json", mode: "default" },
    regionsGeojson: { fileName: "regions.geojson", mode: "default" },
    backgroundData: { fileName: "background.json", mode: "default" },
    ...assets,
  },
  ...top,
});
export const scenarioJson = (options) => Buffer.from(JSON.stringify(scenario(options)), "utf8");
export const scenarioZip = (options, files = {}) => zip({ "scenario.json": scenario(options), ...files });

export const suggestion = ({ changes = [], ...top } = {}) => ({
  schema: "open-historia-scenario-suggestion/1",
  id: "sug-0123456789abcdef",
  createdAt: "2026-10-02T00:00:00.000Z",
  scenario: { name: "Test world", title: "Test world", postId: 12, bundleUrl: "" },
  by: "someone",
  note: "A few changes.",
  changes: [{ id: "scenario:description", area: "details", kind: "field", path: ["scenario", "description"], from: "Old.", to: "New." }, ...changes],
  ...top,
});
export const suggestionZip = (options, files = {}) => zip({ "suggestion.json": suggestion(options), ...files });
