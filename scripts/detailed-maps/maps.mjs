// The detailed maps list (detailed-maps.json, on the detailed-maps-index
// branch) and what changes it: adding a checked version, archiving, restoring
// and deleting. The game reads the list (server/officialBasemaps.js in
// open-historia), so its shape stays the one the game parses:
//
//   { format: 1, basemaps: [{ id, name, author, owners, license, post,
//       archived?, deleted?,
//       versions: [{ version, url, bytes, sha256, released, archived? }
//                  | { version, deleted }] }] }
//
// A map's ID never changes and is never used again: a deleted map stays in the
// list as a tombstone with no links, so a scenario that names it is told the
// map was removed instead of being given someone else's.

import crypto from "node:crypto";
import fs from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MAX_MAP_BYTES, megabytes } from "./pmtiles.mjs";

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const LABEL = "detailed map";
export const PROBLEM_LABEL = "needs changes";
export const DATA_BRANCH = "detailed-maps-index";
export const LIST_FILE = "detailed-maps.json";
export const PAGE_FILE = "DETAILED-MAPS.md";
export const STATE_FILE = "state.json";

// The releases the map files go in: "detailed-maps-<n>", a new one once the
// last is nearly full (a release holds 1000 files), like the hub's own.
// Archived files wait in one draft release, which nobody can download from.
export const RELEASE_PREFIX = "detailed-maps-";
export const RELEASE_FILE_LIMIT = 900;
export const ARCHIVE_RELEASE = "detailed-maps-archived";

export const assetNameOf = (id, version) => `${id}-v${version}.pmtiles`;

// ---- text from a post ---------------------------------------------------------

export const plain = (text) => String(text ?? "")
  .replace(/<[^>]*>/g, " ")
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/[*_`#>|]/g, "")
  .replace(/\s+/g, " ")
  .trim();

export const slugify = (text) => String(text ?? "")
  .normalize("NFKD")
  .replace(/[̀-ͯ]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 64)
  .replace(/-+$/g, "");

export const sha256Text = (text) => crypto.createHash("sha256").update(String(text ?? "")).digest("hex");

export const sha256File = async (file) => {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
};

// ---- downloading a designer's file ---------------------------------------------

// A download that failed for a reason that may pass (GitHub or the host being
// unwell): the post is looked at again on the next run, without an edit.
export class PassingError extends Error {}

// https only, every redirect too; streamed to disk and stopped the moment it
// passes the cap; a web page instead of a file is named as such. Never sent a
// token: the link is the designer's, and may be anywhere.
export const downloadMap = async (link, dest, { fetchImpl = fetch } = {}) => {
  let url;
  try {
    url = new URL(String(link ?? "").trim());
  } catch {
    throw new Error("The download link isn't a web address.");
  }
  let response;
  for (let hop = 0; ; hop += 1) {
    if (url.protocol !== "https:") throw new Error("The download link must start with https://.");
    if (hop > 8) throw new Error("The download link redirects too many times.");
    try {
      response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(30 * 60 * 1000) });
    } catch (error) {
      throw new PassingError(`The download link couldn't be reached just now (${error?.cause?.code || error?.message || error}).`);
    }
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location) break;
    url = new URL(location, url);
  }
  if (response.status >= 500 || response.status === 429) throw new PassingError(`The download link answered HTTP ${response.status}; it is tried again later.`);
  if (!response.ok) throw new Error(`The download link answered HTTP ${response.status}. Is it public, and still there?`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_MAP_BYTES) throw new Error(`The file is ${megabytes(declared)} MB; the game downloads at most 500 MB.`);
  if (/text\/html/i.test(response.headers.get("content-type") || "")) {
    throw new Error("The link opens a web page, not the file itself. Use a direct download link (for example a file in a GitHub release); Google Drive links often don't work for big files.");
  }
  let received = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > MAX_MAP_BYTES) callback(new Error("The file is over 500 MB; the game downloads at most 500 MB."));
      else callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(dest));
  } catch (error) {
    fs.rmSync(dest, { force: true });
    if (/over 500 MB/.test(error?.message)) throw error;
    throw new PassingError(`The download stopped part way (${error?.message || error}); it is tried again later.`);
  }
  return received;
};

// ---- the list -----------------------------------------------------------------

export const emptyList = () => ({ format: 1, basemaps: [] });

export const findMap = (list, id) => list.basemaps.find((map) => map.id === id) ?? null;

export const liveVersions = (map) => (map?.versions ?? []).filter((entry) => !entry.deleted);
export const latestVersion = (map) => liveVersions(map).at(-1) ?? null;

export const nextVersion = (map) => (map?.versions?.length ? Math.max(...map.versions.map((entry) => entry.version)) + 1 : 1);

// Why `id` can't be the ID of a new map, or "" when it can.
export const idProblem = (list, id, name = "") => {
  if (!ID_PATTERN.test(id)) return `"${id || name}" can't be a map ID: use lower-case letters, digits and dashes (at most 64).`;
  const map = findMap(list, id);
  if (!map) return "";
  if (map.deleted) return `"${id}" was the ID of a map that has been deleted, so choose a different one. Map IDs are never used again.`;
  return `"${id}" is already the ID of another map${map.post ? ` (#${map.post})` : ""}. Choose a different one.`;
};

// Adds one checked version, making the map when it is new.
export const addVersion = (list, { id, version, url, bytes, sha256, preview, name, author, license, post, released }) => {
  let map = findMap(list, id);
  if (map?.deleted) throw new Error(`${id} was deleted, so it can't have new versions.`);
  if (map?.versions.some((entry) => entry.version === version)) throw new Error(`${id} already has a version ${version}.`);
  if (!map) {
    map = { id, name, ...(author ? { author, owners: [author] } : {}), license, post, versions: [] };
    list.basemaps.push(map);
  }
  map.versions.push({ version, url, bytes, sha256, ...(preview ? { preview } : {}), released });
  map.versions.sort((a, b) => a.version - b.version);
  return map;
};

// What a post's edit can change without a new file: the name and the licence.
export const updateDetails = (map, { name, license }) => {
  let changed = false;
  if (name && map.name !== name) {
    map.name = name;
    changed = true;
  }
  if (license && map.license !== license) {
    map.license = license;
    changed = true;
  }
  return changed;
};

// The versions an archive, restore or delete applies to: one, or every
// version still there. Throws a reason when there is nothing to change.
export const versionsFor = (map, version, action) => {
  if (!map) throw new Error("There is no such map in the list.");
  if (map.deleted) throw new Error(`${map.id} was deleted on ${map.deleted.date}; a deleted map can't be changed.`);
  const versions = liveVersions(map).filter((entry) => version == null || entry.version === version);
  if (!versions.length) throw new Error(version == null ? `${map.id} has no versions left.` : `${map.id} has no version ${version}, or it was deleted.`);
  if (action === "archive" && versions.every((entry) => entry.archived)) throw new Error(`${map.id}${version == null ? "" : ` version ${version}`} is already archived.`);
  if (action === "restore" && !map.archived && !versions.some((entry) => entry.archived)) throw new Error(`${map.id}${version == null ? "" : ` version ${version}`} isn't archived.`);
  return versions;
};

const stampOf = (reason, date) => ({ ...(reason ? { reason } : {}), date });

// Archived: kept, with its file, but never offered for download; players who
// have it keep using it. `url` is where the file now is (the draft release).
export const archive = (map, versions, { reason, date, urls = {} }) => {
  const whole = versions.length === liveVersions(map).length;
  for (const entry of versions) {
    entry.archived = stampOf(reason, date);
    if (urls[entry.version]) entry.url = urls[entry.version];
  }
  if (whole) map.archived = stampOf(reason, date);
};

export const restore = (map, versions, { urls = {} }) => {
  for (const entry of versions) {
    delete entry.archived;
    if (urls[entry.version]) entry.url = urls[entry.version];
  }
  // Restoring any version brings the map back with it.
  delete map.archived;
};

// Deleted: a tombstone with no link or checksum, for good.
export const remove = (map, versions, { reason, date }) => {
  const stamp = stampOf(reason, date);
  map.versions = map.versions.map((entry) => (versions.includes(entry) ? { version: entry.version, deleted: stamp } : entry));
  if (map.versions.every((entry) => entry.deleted)) {
    delete map.archived;
    map.deleted = stamp;
  }
};
