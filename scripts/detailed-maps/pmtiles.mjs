// Reading just enough of a PMTiles archive (version 3) to tell whether the game
// can use it as a detailed map: its header, and one tile found through its
// directories. Kept here, with no package, so the workflow installs nothing.
// The format: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
//
// Keep the limits the same as the game's (server/tiledBasemaps.js in
// open-historia), or the game refuses a map this has passed.

import fs from "node:fs";
import zlib from "node:zlib";

export const MAX_MAP_BYTES = 500 * 1024 * 1024;
const HEADER_BYTES = 127;
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;
const RASTER_TILE_TYPES = new Map([[2, "png"], [3, "jpeg"], [4, "webp"], [5, "avif"]]);

export const megabytes = (bytes) => Math.round(bytes / 1048576);

const readAt = async (handle, size, offset, length) => {
  if (!(offset >= 0) || !(length >= 0) || offset + length > size) throw new Error("The archive points outside itself.");
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  if (bytesRead !== length) throw new Error("The archive is incomplete.");
  return buffer;
};

const readVarint = (bytes, position) => {
  let value = 0;
  let scale = 1;
  for (let shift = 0; shift < 64; shift += 7) {
    if (position.at >= bytes.length) throw new Error("A directory of the archive is cut short.");
    const byte = bytes[position.at++];
    value += (byte & 0x7f) * scale;
    if (byte < 0x80) return value;
    scale *= 128;
  }
  throw new Error("A directory of the archive is damaged.");
};

const decompress = (bytes, compression) => {
  if (compression === 1 || compression === 0) return bytes;
  if (compression === 2) return zlib.gunzipSync(bytes, { maxOutputLength: MAX_DIRECTORY_BYTES });
  throw new Error("The archive's directories use a compression the game can't read (only gzip, or none).");
};

// [{ tileId, offset, length, runLength }], as the spec stores them: each column
// in turn, tile ids as differences, an offset of 0 meaning "right after the
// previous entry".
export const parseDirectory = (bytes) => {
  const position = { at: 0 };
  const count = readVarint(bytes, position);
  if (count > 10_000_000) throw new Error("A directory of the archive is damaged.");
  const entries = [];
  let tileId = 0;
  for (let i = 0; i < count; i += 1) {
    tileId += readVarint(bytes, position);
    entries.push({ tileId, offset: 0, length: 0, runLength: 0 });
  }
  for (const entry of entries) entry.runLength = readVarint(bytes, position);
  for (const entry of entries) entry.length = readVarint(bytes, position);
  for (let i = 0; i < count; i += 1) {
    const value = readVarint(bytes, position);
    entries[i].offset = value === 0 && i > 0 ? entries[i - 1].offset + entries[i - 1].length : value - 1;
  }
  return entries;
};

// The tile id of z/x/y: the tiles of every lower zoom, then the tile's place
// along the Hilbert curve of its own zoom.
export const zxyToTileId = (z, x, y) => {
  let id = (4 ** z - 1) / 3;
  const xy = [x, y];
  for (let s = 2 ** (z - 1); s >= 1; s /= 2) {
    const rx = (xy[0] & s) > 0 ? 1 : 0;
    const ry = (xy[1] & s) > 0 ? 1 : 0;
    id += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        xy[0] = s - 1 - xy[0];
        xy[1] = s - 1 - xy[1];
      }
      [xy[0], xy[1]] = [xy[1], xy[0]];
    }
  }
  return id;
};

const findEntry = (entries, tileId) => {
  let low = 0;
  let high = entries.length - 1;
  let found = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (entries[middle].tileId <= tileId) {
      found = entries[middle];
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (!found) return null;
  if (found.runLength === 0) return found; // a leaf directory
  return tileId < found.tileId + found.runLength ? found : null;
};

const round = (value) => Math.round(value * 1000) / 1000;

// Resolves to { tileType, minzoom, maxzoom, bounds }, or throws a reason to
// show the person who posted the map.
export const inspectMap = async (file) => {
  const { size } = fs.statSync(file);
  if (size > MAX_MAP_BYTES) throw new Error(`The file is ${megabytes(size)} MB; the game downloads at most 500 MB.`);
  if (size < HEADER_BYTES) throw new Error("The file is not a PMTiles archive.");
  const handle = await fs.promises.open(file, "r");
  try {
    const header = await readAt(handle, size, 0, HEADER_BYTES);
    if (header.subarray(0, 7).toString("latin1") !== "PMTiles") throw new Error("The file is not a PMTiles archive.");
    if (header[7] !== 3) throw new Error(`The file is a version ${header[7]} PMTiles archive; only version 3 is supported.`);
    const u64 = (at) => Number(header.readBigUInt64LE(at));
    const rootOffset = u64(8);
    const rootLength = u64(16);
    const leavesOffset = u64(40);
    const tilesOffset = u64(56);
    const tilesLength = u64(64);
    const compression = header[97];
    const tileType = RASTER_TILE_TYPES.get(header[99]);
    const minzoom = header[100];
    const maxzoom = header[101];
    const bounds = [header.readInt32LE(102), header.readInt32LE(106), header.readInt32LE(110), header.readInt32LE(114)].map((value) => value / 1e7);
    if (!tileType) throw new Error("The archive holds vector tiles; a detailed map needs raster tiles (PNG, JPEG, WebP or AVIF).");
    if (tilesOffset + tilesLength > size || rootOffset + rootLength > size) throw new Error("The archive is incomplete (it ends before its own tiles do).");
    if (!(minzoom <= maxzoom) || maxzoom > 30) throw new Error("The archive has no valid zoom range.");
    if (rootLength > MAX_DIRECTORY_BYTES) throw new Error("The archive's directory is too large.");

    // One tile at the lowest zoom, in the middle of the area the archive says
    // it covers: the game draws from there first.
    const [west, south, east, north] = bounds;
    const n = 2 ** minzoom;
    const lat = Math.max(-85, Math.min(85, (south + north) / 2)) * Math.PI / 180;
    const x = Math.min(n - 1, Math.max(0, Math.floor((((west + east) / 2 + 180) / 360) * n)));
    const y = Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n)));
    const tileId = zxyToTileId(minzoom, x, y);
    let directory = { offset: rootOffset, length: rootLength };
    let tile = null;
    for (let depth = 0; depth < 4 && directory; depth += 1) {
      const entries = parseDirectory(decompress(await readAt(handle, size, directory.offset, directory.length), compression));
      const entry = findEntry(entries, tileId);
      if (!entry) break;
      if (entry.runLength > 0) {
        tile = entry;
        break;
      }
      if (entry.length > MAX_DIRECTORY_BYTES) throw new Error("A directory of the archive is too large.");
      directory = { offset: leavesOffset + entry.offset, length: entry.length };
    }
    if (!tile || tile.length === 0) throw new Error("The archive has no tile where its own bounds say it should.");
    await readAt(handle, size, tilesOffset + tile.offset, tile.length);
    return { tileType, minzoom, maxzoom, bounds: bounds.map(round) };
  } catch (error) {
    if (error instanceof RangeError || error?.code === "Z_DATA_ERROR" || error?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error("The archive is damaged.");
    }
    throw error;
  } finally {
    await handle.close();
  }
};
