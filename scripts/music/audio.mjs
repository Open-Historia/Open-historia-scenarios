// Telling whether a file is really sound the game can play (an MP3, or an Ogg
// file holding Vorbis or Opus), from its bytes and never from its name, and how
// long it runs where that is cheap to tell. Kept here, with no package, so the
// workflow installs nothing.
//
// An MP3 is a row of frames, each starting with a four-byte header that says
// how long the frame is, often after an ID3 tag (the title, the artist, a
// picture). An Ogg file is a row of pages starting "OggS"; the first holds a
// header that says what the sound is.

import fs from "node:fs";

export const MAX_TRACK_BYTES = 20 * 1024 * 1024;

// "10.4": megabytes to one place, so a file just over the limit does not read
// as being exactly on it.
export const megabytesText = (bytes) => (bytes / 1048576).toFixed(1);

// Whole seconds, or null for a length that cannot be right.
const whole = (seconds) => (Number.isFinite(seconds) && seconds >= 0 && seconds < 24 * 3600 ? Math.round(seconds) : null);

// ---- MP3 ----------------------------------------------------------------------

// Kilobits a second by the header's bitrate number, for Layer III: MPEG-1, and
// MPEG-2 with its low-rate extension "2.5". (0 is "free format", which nothing
// plays reliably, and 15 is not allowed.)
const BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };

// The frame whose header is at `at`, or null when those four bytes are not
// the header of an MP3 frame: eleven set bits, then a version, a layer (III:
// that is what an MP3 is), a bitrate and a sample rate that all exist.
const frameAt = (bytes, at) => {
  if (at < 0 || at + 4 > bytes.length || bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) return null;
  const versionBits = (bytes[at + 1] >> 3) & 3;
  const layerBits = (bytes[at + 1] >> 1) & 3;
  const bitrateIndex = bytes[at + 2] >> 4;
  const rateIndex = (bytes[at + 2] >> 2) & 3;
  if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const bitrate = BITRATES[version === 1 ? 1 : 2][bitrateIndex] * 1000;
  const sampleRate = SAMPLE_RATES[version][rateIndex];
  const samples = version === 1 ? 1152 : 576;
  return {
    version,
    bitrate,
    sampleRate,
    samples,
    mono: bytes[at + 3] >> 6 === 3,
    checksum: (bytes[at + 1] & 1) === 0,
    length: Math.floor(((samples / 8) * bitrate) / sampleRate) + ((bytes[at + 2] >> 1) & 1),
  };
};

// How long an ID3 tag at `at` is, or 0 when there is none. Its size is written
// seven bits to a byte.
const id3Length = (bytes, at) => {
  if (at + 10 > bytes.length || bytes[at] !== 0x49 || bytes[at + 1] !== 0x44 || bytes[at + 2] !== 0x33) return 0;
  if ((bytes[at + 6] | bytes[at + 7] | bytes[at + 8] | bytes[at + 9]) & 0x80) return 0;
  const size = (bytes[at + 6] << 21) | (bytes[at + 7] << 14) | (bytes[at + 8] << 7) | bytes[at + 9];
  return 10 + size + (bytes[at + 5] & 0x10 ? 10 : 0);
};

// A few bytes that are no frame may stand before the first one.
const MAX_LEAD_IN = 16 * 1024;

const mp3Seconds = (bytes, at, frame) => {
  // An encoder that knows the whole track writes a "Xing" or "Info" header
  // into the first frame, with the number of frames: the only way to tell the
  // length of a track whose bitrate varies without reading all of it.
  const tag = at + 4 + (frame.checksum ? 2 : 0) + (frame.version === 1 ? (frame.mono ? 17 : 32) : (frame.mono ? 9 : 17));
  if (tag + 12 <= bytes.length) {
    const name = bytes.toString("latin1", tag, tag + 4);
    if ((name === "Xing" || name === "Info") && (bytes.readUInt32BE(tag + 4) & 1) === 1) {
      const frames = bytes.readUInt32BE(tag + 8);
      if (frames > 0) return whole((frames * frame.samples) / frame.sampleRate);
    }
  }
  // Without one, every frame is taken to be as heavy as the first: the size
  // of the sound (not counting an old-style tag at the very end) over its bitrate.
  let end = bytes.length;
  if (end >= at + 128 && bytes.toString("latin1", end - 128, end - 125) === "TAG") end -= 128;
  return whole(((end - at) * 8) / frame.bitrate);
};

// { type: "mp3", seconds }, or null when the bytes are not an MP3: after any
// ID3 tag, a frame, and a second one exactly where the first says it ends,
// of the same kind. One header by itself can turn up in any file by chance.
const readMp3 = (bytes) => {
  let start = 0;
  for (let tags = 0; tags < 4; tags += 1) {
    const length = id3Length(bytes, start);
    if (!length) break;
    start += length;
  }
  const last = Math.min(bytes.length - 4, start + MAX_LEAD_IN);
  for (let at = start; at <= last; at += 1) {
    const first = frameAt(bytes, at);
    if (!first) continue;
    const second = frameAt(bytes, at + first.length);
    if (!second || second.version !== first.version || second.sampleRate !== first.sampleRate) continue;
    return { type: "mp3", seconds: mp3Seconds(bytes, at, first) };
  }
  return null;
};

// ---- Ogg ----------------------------------------------------------------------

const OGG_PAGE = Buffer.from("OggS", "latin1");
const NOT_OGG_SOUND = "The file is an Ogg file, but the sound in it is neither Vorbis nor Opus (it may be a video, or FLAC or Speex in an Ogg file). Export the track as .mp3, or as .ogg with Vorbis or Opus.";
const DAMAGED_OGG = "The file starts like an Ogg file, but its first page is damaged. Export the track again.";

// { type: "ogg", seconds }, or null when the bytes are not an Ogg file at all.
// Throws a reason for an Ogg file that is not Vorbis or Opus sound.
const readOgg = (bytes) => {
  if (bytes.length < 4 || !bytes.subarray(0, 4).equals(OGG_PAGE)) return null;
  // The first page: a version (0), a flag that says a stream begins here, and
  // the list of how long its pieces are. The stream's first packet is the
  // pieces up to the first one shorter than 255 bytes.
  if (bytes.length < 28 || bytes[4] !== 0 || !(bytes[5] & 0x02)) throw new Error(DAMAGED_OGG);
  const serial = bytes.readUInt32LE(14);
  const pieces = bytes[26];
  const data = 27 + pieces;
  let length = 0;
  for (let piece = 0; piece < pieces; piece += 1) {
    length += bytes[27 + piece];
    if (bytes[27 + piece] < 255) break;
  }
  if (data + length > bytes.length) throw new Error(DAMAGED_OGG);
  const packet = bytes.subarray(data, data + length);

  // What a position in the stream counts in: samples a second, after a few
  // samples at the start that are not played (Opus).
  let rate = 0;
  let skipped = 0;
  if (packet.length >= 30 && packet[0] === 1 && packet.toString("latin1", 1, 7) === "vorbis") {
    // Vorbis: version 0, at least one channel, a sample rate, and the bit that ends the header.
    if (packet.readUInt32LE(7) !== 0 || packet[11] === 0 || packet.readUInt32LE(12) === 0 || !(packet[29] & 1)) throw new Error(DAMAGED_OGG);
    rate = packet.readUInt32LE(12);
  } else if (packet.length >= 19 && packet.toString("latin1", 0, 8) === "OpusHead") {
    // Opus: a version below 16, at least one channel. Its positions are always
    // counted at 48,000 a second, whatever the track was recorded at.
    if (packet[8] > 15 || packet[9] === 0) throw new Error(DAMAGED_OGG);
    rate = 48000;
    skipped = packet.readUInt16LE(10);
  } else {
    throw new Error(NOT_OGG_SOUND);
  }

  // The length: the position the last page of the stream ends at. (A page
  // with no position of its own says -1, and the one before it is asked; the
  // pages of the headers say 0, which is no length.)
  let seconds = null;
  for (let at = bytes.lastIndexOf(OGG_PAGE), tries = 0; at >= 0 && tries < 64; at = at > 0 ? bytes.lastIndexOf(OGG_PAGE, at - 1) : -1, tries += 1) {
    if (at + 27 > bytes.length || bytes[at + 4] !== 0 || bytes.readUInt32LE(at + 14) !== serial) continue;
    const position = bytes.readBigInt64LE(at + 6);
    if (position <= 0n) continue;
    seconds = whole((Number(position) - skipped) / rate);
    break;
  }
  return { type: "ogg", seconds };
};

// ---- a file ---------------------------------------------------------------------

// What the file is instead, where that is plain: the kinds a track is most
// often saved as.
const otherKind = (bytes) => {
  const head = bytes.toString("latin1", 0, 12);
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WAVE") return " (it is a WAV file)";
  if (head.startsWith("fLaC")) return " (it is a FLAC file)";
  if (head.slice(4, 8) === "ftyp") return " (it is an MP4 or M4A file)";
  return "";
};

// Resolves to { type: "mp3" | "ogg", seconds }, `seconds` being null when the
// length could not be told, or throws a reason to show the person who posted
// the track.
export const inspectAudio = async (file) => {
  const { size } = fs.statSync(file);
  if (size > MAX_TRACK_BYTES) throw new Error(`The file is ${megabytesText(size)} MB; a track can be 20 MB at most.`);
  const bytes = await fs.promises.readFile(file);
  const found = readOgg(bytes) ?? readMp3(bytes);
  if (!found) {
    throw new Error(`The file is not an MP3 or an Ogg (Vorbis or Opus) file${otherKind(bytes)}. It is told by what is in it, not by its name, so renaming a file does not make it one: export the track as .mp3 or .ogg.`);
  }
  return found;
};
