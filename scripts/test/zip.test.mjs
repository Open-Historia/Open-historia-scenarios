// Run: npm test
import assert from "node:assert/strict";
import test from "node:test";

import { Problem } from "../lib/util.mjs";
import { MAX_ENTRIES, packEntry, readZip, writeZip } from "../lib/zip.mjs";
import { JSZIP_MISSING, loadJSZip, png, rawZip, zip } from "./fixtures.mjs";

const refuses = (bytes, pattern, options) => assert.throws(() => readZip(bytes, options).forEach((entry) => entry.directory || entry.read()), (error) => {
  assert.ok(error instanceof Problem, `a Problem, not ${error}`);
  assert.match(error.message, pattern);
  return true;
});
const text = (entry) => entry.read().toString("utf8");

test("a zip is read entry by entry, in the order of its list", () => {
  const picture = png();
  const entries = readZip(rawZip([
    { name: "assets/" },
    { name: "assets/cover-image.bin", data: picture },
    { name: "scenario.json", data: '{"schema":"x"}'.repeat(50), method: 8 },
    { name: "notes/läs mig.txt", data: "hej" },
  ], { comment: "made by hand" }));
  assert.deepEqual(entries.map((entry) => [entry.name, entry.directory, entry.size]), [
    ["assets/", true, 0],
    ["assets/cover-image.bin", false, picture.length],
    ["scenario.json", false, 700],
    ["notes/läs mig.txt", false, 3],
  ]);
  assert.ok(entries[1].read().equals(picture));
  assert.equal(text(entries[2]), '{"schema":"x"}'.repeat(50));
  // Sizes written after the data instead of before it, as a streaming writer does.
  const streamed = readZip(rawZip([{ name: "a.json", data: "{}", flags: 0x08, localSize: 0 }]));
  assert.equal(text(streamed[0]), "{}");
});

test("what is not a zip the game would open is refused", () => {
  const good = rawZip([{ name: "a.json", data: "{}" }]);
  refuses(rawZip([{ name: "a.json", data: "{}" }], { before: Buffer.from("MZ a program in front") }), /comes before its first entry/);
  refuses(rawZip([]), /empty zip/);
  refuses(Buffer.from("PK\x03\x04 and nothing else that a zip has"), /list of entries is missing/);
  refuses(Buffer.concat([good, Buffer.from("something after the end")]), /list of entries is missing or something follows/);
  refuses(good.subarray(0, good.length - 30), /list of entries is missing/);
  // An entry the list does not name sits in front of the one it does.
  const hidden = rawZip([{ name: "a.json", data: "{}" }], { before: rawZip([{ name: "hidden.exe", data: "MZ" }]).subarray(0, 40) });
  refuses(hidden, /comes before its first entry/);
});

test("an archive in parts, in the 64-bit format, or encrypted is refused", () => {
  refuses(rawZip([{ name: "a.json", data: "{}" }], { disk: 1 }), /split over several files/);
  refuses(rawZip([{ name: "a.json", data: "{}", disk: 2 }]), /split over several files/);
  refuses(rawZip([{ name: "a.json", data: "{}" }], { locator: true }), /64-bit/);
  refuses(rawZip([{ name: "a.json", data: "{}", extra: Buffer.from([1, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]) }]), /64-bit/);
  refuses(rawZip([{ name: "a.json", data: "{}", size: 0xffffffff }]), /64-bit/);
  refuses(rawZip([{ name: "a.json", data: "{}" }], { count: 0xffff }), /64-bit/);
  refuses(rawZip([{ name: "secret.json", data: "{}", flags: 0x01 }]), /encrypted \(`secret\.json`\)/);
  refuses(rawZip([{ name: "secret.json", data: "{}", flags: 0x40 }]), /encrypted/);
});

test("an entry packed another way than stored or deflated is refused", () => {
  refuses(rawZip([{ name: "a.json", data: "{}", method: 12 }]), /packed in a way the game cannot unpack \(`a\.json`\)/);
  refuses(rawZip([{ name: "a.json", data: "{}", method: 14 }]), /cannot unpack/);
});

test("too many entries, or too much once unpacked, is refused before it is unpacked", () => {
  const many = rawZip(Array.from({ length: MAX_ENTRIES + 1 }, (_, index) => ({ name: `f${index}.txt`, data: "" })));
  refuses(many, /holds 2,001 entries.*2,000 entries at most/);
  assert.equal(readZip(rawZip(Array.from({ length: 50 }, (_, index) => ({ name: `f${index}.txt`, data: "x" })))).length, 50);
  const megabyte = Buffer.alloc(1024 * 1024, 65);
  const three = rawZip([1, 2, 3].map((index) => ({ name: `big${index}.txt`, data: megabyte, method: 8 })));
  assert.ok(three.length < 20000, "three megabytes of one letter pack to almost nothing");
  refuses(three, /unpacks to more than 2 MB/, { maxUnpacked: 2 * 1024 * 1024 });
  refuses(three, /unpacks to 1 MB, more than the 512 KB one entry may be \(`big1\.txt`\)/, { maxEntry: 512 * 1024 });
  // An entry that says it is small and is not: stopped at the size it said.
  const lying = rawZip([{ name: "bomb.txt", data: megabyte, method: 8, size: 100, localSize: 100 }]);
  refuses(lying, /unpacks to more than it says \(`bomb\.txt`\)/);
  const short = rawZip([{ name: "short.txt", data: "abc", method: 8, size: 5, localSize: 5 }]);
  refuses(short, /does not unpack to the size it says/);
  refuses(rawZip([{ name: "odd.txt", data: "abc", size: 5, localSize: 5 }]), /its two sizes disagree/);
});

test("a name that leaves its folder, or cannot be shown, is refused", () => {
  const named = (name) => rawZip([{ name, data: "{}" }]);
  refuses(named(""), /an entry with no name/);
  refuses(named("/etc/passwd"), /full path/);
  refuses(named("C:/Windows/system.ini"), /full path/);
  refuses(named("c:evil.txt"), /full path/);
  refuses(named("../outside.json"), /holds "\.\."/);
  refuses(named("assets/../../outside.json"), /holds "\.\."/);
  refuses(named("assets\\cover.png"), /backslash/);
  refuses(named("a\0.json"), /cannot be shown/);
  refuses(named("line\nbreak.json"), /cannot be shown/);
  refuses(named(`gpj.${String.fromCharCode(0x202e)}exe`), /cannot be shown/);
  refuses(named(`${"a".repeat(241)}.json`), /more than 240 characters/);
  refuses(rawZip([{ name: Buffer.from([0x66, 0xff, 0xfe, 0x2e, 0x74, 0x78, 0x74]), data: "x" }]), /not readable text/);
  assert.equal(readZip(named(`${"a".repeat(235)}.json`)).length, 1);
  assert.equal(readZip(named("assets/sub.folder/a file (1).json")).length, 1);
});

test("two entries by one name are refused, however the name is written", () => {
  refuses(rawZip([{ name: "scenario.json", data: "{}" }, { name: "scenario.json", data: "[]" }]), /two entries with the same name \(`scenario\.json`\)/);
  refuses(rawZip([{ name: "Scenario.JSON", data: "{}" }, { name: "scenario.json", data: "[]" }]), /two entries with the same name/);
  // One "é" as a single character, the other as "e" and an accent.
  refuses(rawZip([{ name: "caf\xe9.json", data: "{}" }, { name: `cafe${String.fromCharCode(0x301)}.json`, data: "[]" }]), /two entries with the same name/);
});

test("a link or a device is refused; a folder is only a folder", () => {
  const unix = (mode) => ({ madeBy: (3 << 8) | 20, attributes: (mode << 16) >>> 0 });
  refuses(rawZip([{ name: "link", data: "/etc/passwd", ...unix(0o120777) }]), /a link or a device, not a file \(`link`\)/);
  refuses(rawZip([{ name: "tty", data: "", ...unix(0o020666) }]), /a link or a device/);
  refuses(rawZip([{ name: "pipe", data: "", ...unix(0o010644) }]), /a link or a device/);
  refuses(rawZip([{ name: "folder/", data: "not empty" }]), /a folder that holds data/);
  const plain = readZip(rawZip([{ name: "a.json", data: "{}", ...unix(0o100644) }, { name: "dir/", ...unix(0o040755) }]));
  assert.deepEqual(plain.map((entry) => entry.directory), [false, true]);
});

test("a list of entries and an entry that disagree are refused", () => {
  refuses(rawZip([{ name: "cover.png", data: "{}", localName: "cover.exe" }]), /says two different things about one entry \(`cover\.png`\)/);
  refuses(rawZip([{ name: "a.json", data: "{}", localSize: 99 }]), /says two different things/);
  refuses(rawZip([{ name: "a.json", data: "{}", method: 8, localMethod: 0 }]), /says two different things/);
  refuses(rawZip([{ name: "a.json", data: "{}", offset: 1000000 }]), /is not where the list says/);
  // Two names in the list for the same bytes: how a few kilobytes are made to
  // unpack to gigabytes.
  const twice = rawZip([{ name: "a.json", data: "{}" }, { name: "b.json", data: "{}", localName: "a.json", offset: 0 }]);
  refuses(twice, /says two different things|made of the same bytes/);
  const overlapping = rawZip([{ name: "a.json", data: "{}" }, { name: "a.json", data: "{}", offset: 0 }]);
  refuses(overlapping, /same name|same bytes/);
});

test("an entry that fails its checksum is refused", () => {
  refuses(rawZip([{ name: "a.json", data: "{}", crc: 0x12345678 }]), /fails its checksum \(`a\.json`\)/);
  const flipped = rawZip([{ name: "a.json", data: "x".repeat(400), method: 8 }]);
  flipped[40] ^= 0x10;
  refuses(flipped, /does not unpack|fails its checksum|does not unpack to the size/);
});

test("a zip that is written holds what it was given and nothing else", () => {
  const picture = png({ width: 64, height: 64, noise: true });
  const scenario = JSON.stringify({ schema: "open-historia-scenario-bundle/2", text: "na\xefve ".repeat(500) });
  const written = writeZip([
    packEntry("scenario.json", Buffer.from(scenario)),
    packEntry("assets/cover-image.bin", picture, { store: true }),
    packEntry("empty.txt", Buffer.alloc(0)),
    packEntry("noise.json", picture), // deflate would make it larger: stored instead
  ]);
  const entries = readZip(written);
  assert.deepEqual(entries.map((entry) => entry.name), ["scenario.json", "assets/cover-image.bin", "empty.txt", "noise.json"]);
  assert.equal(text(entries[0]), scenario);
  assert.ok(entries[1].read().equals(picture));
  assert.equal(entries[2].read().length, 0);
  assert.ok(entries[3].read().equals(picture));
  assert.ok(written.length < scenario.length + 2 * picture.length, "the text was deflated");
  assert.ok(written.indexOf(picture) > 0, "the picture is stored as it is");
  // The same entries are the same bytes, whenever they are written.
  assert.ok(writeZip([packEntry("scenario.json", Buffer.from(scenario))]).equals(writeZip([packEntry("scenario.json", Buffer.from(scenario))])));
  // No comment, no extra fields: the file ends with its 22-byte end record.
  assert.equal(written.readUInt32LE(written.length - 22), 0x06054b50);
  assert.equal(written.readUInt16LE(written.length - 2), 0);
});

test("a written zip opens in JSZip, the reader the game uses", { skip: JSZIP_MISSING }, async () => {
  const JSZip = loadJSZip();
  const picture = png({ width: 32, height: 32 });
  const opened = await JSZip.loadAsync(zip({ "scenario.json": { schema: "x", name: "Köln" }, "assets/cover-image.bin": picture, "basemap.png": picture, "notes/läs mig.txt": "hej" }));
  assert.deepEqual(Object.keys(opened.files), ["scenario.json", "assets/cover-image.bin", "basemap.png", "notes/läs mig.txt"]);
  assert.deepEqual(JSON.parse(await opened.file("scenario.json").async("string")), { schema: "x", name: "Köln" });
  assert.ok((await opened.file("assets/cover-image.bin").async("nodebuffer")).equals(picture));
  assert.equal(await opened.file("notes/läs mig.txt").async("string"), "hej");
  // And a zip JSZip writes, folders and all, is one this reader takes.
  const theirs = new JSZip();
  theirs.file("scenario.json", '{"schema":"x"}');
  theirs.file("assets/cover-image.bin", picture, { compression: "STORE" });
  const entries = readZip(await theirs.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  assert.deepEqual(entries.map((entry) => [entry.name, entry.directory]), [["scenario.json", false], ["assets/", true], ["assets/cover-image.bin", false]]);
  assert.ok(entries[2].read().equals(picture));
});
