// Small things every check needs: a reason a file cannot be used, checksums,
// and how a name or a size is written in a sentence.

import crypto from "node:crypto";
import zlib from "node:zlib";

// Why a file cannot be used. Its message finishes the sentence "<the file>
// can't be used: ...", in words for the person who attached it.
export class Problem extends Error {}

export const sha256 = (data) => crypto.createHash("sha256").update(data ?? "").digest("hex");

// CRC-32, as PNG chunks and zip entries carry it. Node has had its own since
// 22.2; the table is for a Node that has not.
let table = null;
const slowCrc32 = (bytes) => {
  if (!table) {
    table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
      table[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) crc = table[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
export const crc32 = typeof zlib.crc32 === "function" ? (bytes) => zlib.crc32(bytes) >>> 0 : slowCrc32;

export const KIB = 1024;
export const MIB = 1024 * 1024;

export const count = (number) => Number(number).toLocaleString("en-US");
export const plural = (number, one, many = `${one}s`) => `${count(number)} ${number === 1 ? one : many}`;
// "734 KB", "4.3 MB", "231 MB", "1 GB".
export const sizeText = (bytes) => {
  if (bytes < MIB) return `${Math.max(1, Math.round(bytes / KIB))} KB`;
  const megabytes = bytes / MIB;
  if (megabytes >= 1024) return `${(megabytes / 1024).toFixed(1).replace(/\.0$/, "")} GB`;
  return `${megabytes < 10 ? megabytes.toFixed(1).replace(/\.0$/, "") : Math.round(megabytes)} MB`;
};

// Characters that have no place in a name: the control characters, and the
// invisible ones that hide or reorder what is written (zero-width marks, line
// separators, the overrides that turn "gpj.exe" into "exe.jpg").
export const UNPRINTABLE = /[\x00-\x1f\x7f-\x9f\u{200b}-\u{200f}\u{2028}-\u{202e}\u{2066}-\u{2069}\u{feff}]/u;
const UNPRINTABLE_ALL = new RegExp(UNPRINTABLE.source, "gu");
export const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const ELLIPSIS = String.fromCharCode(0x2026);

// A name, a key or a value taken from a file, as it may be written in a comment
// on GitHub: in a code span, so nothing in it is read as Markdown or as a
// mention, short, and never an address. The game reads a comment that carries
// a .zip attachment's address as a suggestion, and a file can name an entry or
// a key anything it likes.
export const quoted = (value, max = 60) => {
  // (Only its start is read: a name can be as long as the file it stands in.)
  let text = String(value ?? "").slice(0, max * 4 + 200).replace(UNPRINTABLE_ALL, " ").replace(/`/g, "'").replace(/\s+/g, " ").trim();
  const address = text.search(/:\/\/|github\.com|githubusercontent/i);
  if (address >= 0) text = `${text.slice(0, address)}${ELLIPSIS}`;
  if (text.length > max) text = `${text.slice(0, max - 1)}${ELLIPSIS}`;
  return `\`${text || " "}\``;
};

// The first `wanted` characters of an address as a browser reads one: the
// blanks and control characters in front of it are passed over, and tabs and
// line breaks are left out wherever they stand ("java<tab>script:" is
// "javascript:" to a browser), however many of them there are.
export const addressStart = (text, wanted) => {
  let start = "";
  for (let at = 0; at < text.length && start.length < wanted; at += 1) {
    const code = text.charCodeAt(at);
    if (code === 0x09 || code === 0x0a || code === 0x0d || (!start && code <= 0x20)) continue;
    start += text[at];
  }
  return start;
};

// Text decoded as UTF-8 (a byte order mark at its start left out), or null
// when the bytes are not UTF-8.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
export const utf8OrNull = (bytes) => {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
};

export const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
