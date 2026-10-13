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
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
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

// A file over the cap: no later run finds it smaller.
class TooBigError extends Error {}

// Whether an address is this machine's, a private network's, or one a network
// keeps for itself (169.254.x.x is where a cloud answers a machine's questions
// about itself): nowhere a public download is.
const privateV4 = (address) => {
  const [a, b, c] = address.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 0)
    || (a === 198 && (b === 18 || b === 19));
};
const privateV6 = (address) => {
  const text = address.toLowerCase().split("%")[0];
  // An IPv4 address written as an IPv6 one, in either of the ways it is written.
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) return privateV4(dotted[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(text);
  if (hex) {
    const [high, low] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
    return privateV4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return text === "::" || text === "::1" || /^f[cd]/.test(text) || /^fe[89ab]/.test(text) || /^ff/.test(text);
};
// A name is looked up first, so that one which only stands for such an address
// is refused with it. (A name that cannot be found is left for the download
// itself to report.)
const isPrivateHost = async (hostname, lookup) => {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || /\.(?:localhost|local|internal)$/.test(host)) return true;
  const kind = net.isIP(host);
  if (kind) return kind === 4 ? privateV4(host) : privateV6(host);
  let found;
  try {
    found = await lookup(host, { all: true });
  } catch {
    return false;
  }
  return found.some(({ address, family }) => (family === 4 ? privateV4(address) : privateV6(address)));
};

// https only, and never a private or local address, every redirect too;
// streamed to disk and stopped the moment it passes the cap; a web page
// instead of a file is named as such. Never sent a token: the link is the
// poster's, and may be anywhere.
//
// The cap is the caller's (a map's, or a track's: scripts/music), and so are
// the words for a file over it: tooBig(bytes) for a file that says how big it
// is, tooBig(0) for one that only turned out to be over.
export const downloadLink = async (link, dest, { maxBytes, tooBig, fetchImpl = fetch, lookup = dns.lookup }) => {
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
    if (await isPrivateHost(url.hostname, lookup)) throw new Error("The download link leads to a private or local address. Use a link anyone on the internet can open.");
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
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(tooBig(declared));
  if (/text\/html/i.test(response.headers.get("content-type") || "")) {
    throw new Error("The link opens a web page, not the file itself. Use a direct download link (for example a file in a GitHub release); Google Drive links often don't work for big files.");
  }
  let received = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) callback(new TooBigError(tooBig(0)));
      else callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(dest));
  } catch (error) {
    fs.rmSync(dest, { force: true });
    if (error instanceof TooBigError) throw error;
    throw new PassingError(`The download stopped part way (${error?.message || error}); it is tried again later.`);
  }
  return received;
};

export const downloadMap = (link, dest, options = {}) => downloadLink(link, dest, {
  maxBytes: MAX_MAP_BYTES,
  tooBig: (bytes) => (bytes ? `The file is ${megabytes(bytes)} MB; the game downloads at most 500 MB.` : "The file is over 500 MB; the game downloads at most 500 MB."),
  ...options,
});

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
export const addVersion = (list, { id, version, url, bytes, sha256, preview, notes, name, author, license, post, released }) => {
  let map = findMap(list, id);
  if (map?.deleted) throw new Error(`${id} was deleted, so it can't have new versions.`);
  if (map?.versions.some((entry) => entry.version === version)) throw new Error(`${id} already has a version ${version}.`);
  if (!map) {
    map = { id, name, ...(author ? { author, owners: [author] } : {}), license, post, versions: [] };
    list.basemaps.push(map);
  }
  map.versions.push({ version, url, bytes, sha256, ...(preview ? { preview } : {}), ...(notes ? { notes } : {}), released });
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
