// Reading a .zip strictly, and writing one.
//
// A zip that is released is never the zip that was attached. It is read here,
// entry by entry, each entry is checked (content.mjs), and a new zip is written
// from what passed: so nothing that was not looked at rides along, whether in
// an entry, between two entries, before the first one, or in a field only some
// readers look at.
//
// The reader refuses what a zip the game wrote never has, and what two readers
// could understand in two ways: an archive in several parts or in the 64-bit
// format, encryption, a compression other than "stored" or "deflate", names
// that leave their folder, two entries by one name, links and devices, a
// directory that says one thing about an entry while the entry's own header
// says another. Sizes are bounded before anything is unpacked, and again while
// it is.
//
// Nothing is ever written to disk under an entry's name.

import zlib from "node:zlib";

import { MIB, Problem, UNPRINTABLE, crc32, plural, quoted, sizeText, utf8OrNull } from "./util.mjs";

export const MAX_ENTRIES = 2000;
export const MAX_UNPACKED_BYTES = 1024 * MIB;
export const MAX_ENTRY_BYTES = 600 * MIB;
export const MAX_NAME_LENGTH = 240;

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const END64_LOCATOR = 0x07064b50;

const broken = (what) => new Problem(`it is not a zip the game can open (${what})`);

// Why a name cannot be an entry's, or "" when it can.
const nameProblem = (name) => {
  if (!name) return "it has an entry with no name";
  const said = quoted(name);
  if (name.length > MAX_NAME_LENGTH) return `it has an entry with a name of more than ${MAX_NAME_LENGTH} characters (${said})`;
  if (UNPRINTABLE.test(name)) return `it has an entry whose name holds characters that cannot be shown (${said})`;
  if (name.includes("\\")) return `it has an entry whose name holds a backslash (${said})`;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return `it has an entry whose name is a full path (${said})`;
  if (name.includes("..")) return `it has an entry whose name holds ".." (${said})`;
  return "";
};

// The file types a Unix zip can record that are not a plain file or a folder.
const SPECIAL_FILE = new Set([0o120000, 0o060000, 0o020000, 0o010000, 0o140000]);

// The entries of a zip: [{ name, directory, size, read() }], in the order of
// its directory. read() unpacks one entry and proves its checksum; a caller
// that releases the zip reads every entry. Throws a Problem for an archive
// that is refused.
export const readZip = (bytes, { maxEntries = MAX_ENTRIES, maxUnpacked = MAX_UNPACKED_BYTES, maxEntry = MAX_ENTRY_BYTES } = {}) => {
  if (bytes.length < 22) throw broken("it is too short");
  // The game tells a zip by these four bytes at its very start.
  if (bytes.readUInt32LE(0) !== LOCAL) {
    throw bytes.readUInt32LE(0) === END ? new Problem("it is an empty zip") : broken("something comes before its first entry");
  }

  // The end record is the last thing in the file, after a comment of up to
  // 65,535 bytes whose length it gives.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
    if (bytes.readUInt32LE(at) === END && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) {
      end = at;
      break;
    }
  }
  if (end < 0) throw broken("its list of entries is missing or something follows it");
  const total = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryStart = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== total) {
    throw new Problem("it is one part of an archive split over several files");
  }
  if (total === 0xffff || directorySize === 0xffffffff || directoryStart === 0xffffffff || (end >= 20 && bytes.readUInt32LE(end - 20) === END64_LOCATOR)) {
    throw new Problem("it is in the 64-bit zip format, which the game does not write");
  }
  if (!total) throw new Problem("it is an empty zip");
  if (total > maxEntries) throw new Problem(`it holds ${plural(total, "entry", "entries")}, and a file for the hub may hold ${plural(maxEntries, "entry", "entries")} at most`);
  if (directoryStart + directorySize !== end) throw broken("its list of entries is not where it says");

  const entries = [];
  const names = new Set();
  let declared = 0;
  let at = directoryStart;
  for (let index = 0; index < total; index += 1) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== CENTRAL) throw broken("its list of entries is damaged");
    const flags = bytes.readUInt16LE(at + 8);
    const method = bytes.readUInt16LE(at + 10);
    const crc = bytes.readUInt32LE(at + 16);
    const packed = bytes.readUInt32LE(at + 20);
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const disk = bytes.readUInt16LE(at + 34);
    const attributes = bytes.readUInt32LE(at + 38);
    const offset = bytes.readUInt32LE(at + 42);
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength);
    const extraEnd = at + 46 + nameLength + extraLength;
    if (extraEnd + commentLength > end) throw broken("its list of entries is damaged");

    const name = utf8OrNull(nameBytes);
    if (name === null) throw new Problem("it has an entry whose name is not readable text");
    const directory = name.endsWith("/");
    const wrong = nameProblem(directory ? name.slice(0, -1) : name);
    if (wrong) throw new Problem(wrong);
    const said = quoted(name);
    if (flags & 0x2041) throw new Problem(`it has an entry that is encrypted (${said})`);
    if (disk) throw new Problem("it is one part of an archive split over several files");
    if (packed === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw new Problem("it is in the 64-bit zip format, which the game does not write");
    for (let field = at + 46 + nameLength; field + 4 <= extraEnd; field += 4 + bytes.readUInt16LE(field + 2)) {
      if (bytes.readUInt16LE(field) === 0x0001) throw new Problem("it is in the 64-bit zip format, which the game does not write");
    }
    if (method !== 0 && method !== 8) throw new Problem(`it has an entry packed in a way the game cannot unpack (${said})`);
    if (SPECIAL_FILE.has((attributes >>> 16) & 0o170000)) throw new Problem(`it has an entry that is a link or a device, not a file (${said})`);
    // Two names that differ only in case, or in how an accent is written, are
    // one file on most disks, and which of the two a reader gets is its choice.
    const key = name.normalize("NFC").toLowerCase();
    if (names.has(key)) throw new Problem(`it has two entries with the same name (${said})`);
    names.add(key);
    if (directory && (size || packed > 2)) throw new Problem(`it has a folder that holds data (${said})`);
    if (size > maxEntry) throw new Problem(`it has an entry that unpacks to ${sizeText(size)}, more than the ${sizeText(maxEntry)} one entry may be (${said})`);
    declared += size;
    if (declared > maxUnpacked) throw new Problem(`it unpacks to more than ${sizeText(maxUnpacked)}`);

    // The entry's own header, which has to say what the directory said.
    if (offset + 30 > directoryStart || bytes.readUInt32LE(offset) !== LOCAL) throw broken(`the entry ${said} is not where the list says`);
    const localFlags = bytes.readUInt16LE(offset + 6);
    const localNameLength = bytes.readUInt16LE(offset + 26);
    const dataStart = offset + 30 + localNameLength + bytes.readUInt16LE(offset + 28);
    if (dataStart + packed > directoryStart) throw broken(`the entry ${said} runs past the end`);
    const sizesLater = Boolean(localFlags & 0x08); // written after the data instead, and zero here
    const agrees = (centralValue, localValue) => localValue === centralValue || (sizesLater && localValue === 0);
    if (
      !bytes.subarray(offset + 30, offset + 30 + localNameLength).equals(nameBytes)
      || bytes.readUInt16LE(offset + 8) !== method
      || (localFlags & 0x2041)
      || !agrees(packed, bytes.readUInt32LE(offset + 18))
      || !agrees(size, bytes.readUInt32LE(offset + 22))
      || !agrees(crc, bytes.readUInt32LE(offset + 14))
    ) {
      throw new Problem(`it says two different things about one entry (${said}): its list of entries and the entry itself disagree`);
    }
    if (method === 0 && packed !== size) throw new Problem(`it says two different things about one entry (${said}): its two sizes disagree`);

    entries.push({ name, directory, size, method, crc, start: offset, dataStart, dataEnd: dataStart + packed });
    at = extraEnd + commentLength;
  }
  if (at !== end) throw broken("its list of entries is longer than it says");

  // No two entries may share bytes: that is how a small file is made to unpack
  // to an enormous one, and nothing honest does it.
  const inOrder = [...entries].sort((a, b) => a.start - b.start);
  if (inOrder[0].start !== 0) throw broken("something comes before its first entry");
  for (let index = 1; index < inOrder.length; index += 1) {
    if (inOrder[index].start < inOrder[index - 1].dataEnd) {
      throw new Problem(`it has two entries made of the same bytes (${quoted(inOrder[index - 1].name)} and ${quoted(inOrder[index].name)})`);
    }
  }

  return entries.map((entry) => ({
    name: entry.name,
    directory: entry.directory,
    size: entry.size,
    read: () => {
      const packed = bytes.subarray(entry.dataStart, entry.dataEnd);
      let data = packed;
      if (entry.method === 8) {
        try {
          // The limit stops an entry that unpacks to more than it said before
          // the memory for it is taken. (The sizes the entries say were added
          // up above, so all of them together stay under the limit too.)
          data = zlib.inflateRawSync(packed, { maxOutputLength: Math.max(1, entry.size) });
        } catch {
          throw new Problem(`it has an entry that does not unpack, or unpacks to more than it says (${quoted(entry.name)})`);
        }
      }
      if (data.length !== entry.size) throw new Problem(`it has an entry that does not unpack to the size it says (${quoted(entry.name)})`);
      if (crc32(data) !== entry.crc) throw new Problem(`it has an entry that is damaged: it fails its checksum (${quoted(entry.name)})`);
      return data;
    },
  }));
};

// ---- writing ------------------------------------------------------------------

// One entry ready to be written: packed now, so the caller can let go of what
// it was packed from. Text is deflated; what is already compressed (a picture,
// a tile archive) is stored as it is, which is also what the game does.
export const packEntry = (name, data, { store = false } = {}) => {
  const packed = store ? data : zlib.deflateRawSync(data, { level: 6 });
  // Deflate can make a small or random file larger; such an entry is stored.
  const smaller = !store && packed.length < data.length;
  return { name, method: smaller ? 8 : 0, crc: crc32(data), size: data.length, packed: smaller ? packed : data };
};

// A zip of those entries, in their order: no comment, no extra fields, no
// dates (two zips of the same entries are the same bytes, so the same file
// checked twice gets the same name in the release).
export const writeZip = (packedEntries) => {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const entry of packedEntries) {
    const name = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4); // the version needed to unpack it
    local.writeUInt16LE(0x0800, 6); // the name is UTF-8
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(0, 10); // midnight,
    local.writeUInt16LE(0x0021, 12); // the first of January 1980: the earliest date a zip can say
    local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(entry.packed.length, 18);
    local.writeUInt32LE(entry.size, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, entry.packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    local.copy(central, 6, 4, 30); // the same fields, from the version needed to the name's length
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += 30 + name.length + entry.packed.length;
  }
  const directorySize = directory.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(packedEntries.length, 8);
  end.writeUInt16LE(packedEntries.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...directory, end]);
};
