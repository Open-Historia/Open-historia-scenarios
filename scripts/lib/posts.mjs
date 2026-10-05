// Reading a hub post (an issue labelled "scenario", "flag" or "basemap"): which
// files are attached to it, which one is THE file the game downloads, and what
// each becomes when it is copied into a release.
//
// The patterns here are the game's own (src/runtime/hubPosts.js,
// communityFlags.js, communityBasemaps.js, hubIssues.js in the game's
// repository): the game looks a file up by the exact address it found in the
// post, so both sides have to find the same address.
//
// Comments are never read. A suggestion is a comment with a .zip, and it stays
// a comment attachment: only what is attached to the post itself is copied.

export const KINDS = ["scenario", "flag", "basemap"];

// The post's kind, from its labels: the game lists posts by label, so a post
// without one is not a post to the game either.
export const kindOfIssue = (issue) => {
  const labels = (issue?.labels ?? []).map((label) => String(label?.name ?? label ?? "").toLowerCase());
  return KINDS.find((kind) => labels.includes(kind)) ?? null;
};

const URL_CHARS = `[^\\s)<>"']+`;

// The scenario file (hubPosts.js BUNDLE_LINK_PATTERN).
const SCENARIO_FILE = new RegExp(
  `https://(?:github\\.com/${URL_CHARS}/releases/download/${URL_CHARS}\\.(?:json|zip)|github\\.com/${URL_CHARS}/files/${URL_CHARS}|github\\.com/user-attachments/files/${URL_CHARS}|raw\\.githubusercontent\\.com/${URL_CHARS}\\.json)`,
  "i",
);
// A flag attached as a file rather than shown as an image (communityFlags.js FILE_LINK_PATTERN).
const FLAG_FILE = new RegExp(
  `https://(?:github\\.com/${URL_CHARS}/files/${URL_CHARS}|github\\.com/user-attachments/files/${URL_CHARS}|raw\\.githubusercontent\\.com/${URL_CHARS})`,
  "i",
);
// A basemap's data file (communityBasemaps.js BUNDLE_LINK_PATTERN).
const BASEMAP_FILE = new RegExp(
  `https://(?:github\\.com/${URL_CHARS}/releases/download/${URL_CHARS}\\.(?:json|geojson|zip)|github\\.com/${URL_CHARS}/files/${URL_CHARS}|github\\.com/user-attachments/files/${URL_CHARS}|raw\\.githubusercontent\\.com/${URL_CHARS}\\.(?:json|geojson))`,
  "i",
);
const IMAGE_NAME = /\.(?:png|jpe?g|webp|gif|svg)(?:[?#]|$)/i;

// The first image GitHub hosts (hubIssues.js firstHubImage).
const IMAGE_MARKUP = /!\[[^\]]*\]\((https:\/\/[^\s)]+)\)|<img[^>]+src=["']([^"']+)["']/gi;
const GITHUB_IMAGE = /^https:\/\/(?:github\.com\/|(?:[a-z0-9-]+\.)*githubusercontent\.com\/)/i;
export const firstHubImage = (body) => {
  for (const match of String(body ?? "").matchAll(IMAGE_MARKUP)) {
    const url = String(match[1] ?? match[2] ?? "").trim();
    if (GITHUB_IMAGE.test(url)) return url;
  }
  return null;
};

// Everything GitHub itself stores for a post: files and images dragged into it.
const ATTACHMENT = new RegExp(
  `https://(?:github\\.com/user-attachments/(?:files|assets)/${URL_CHARS}|github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/files/${URL_CHARS}|user-images\\.githubusercontent\\.com/${URL_CHARS})`,
  "gi",
);

// At most this many files are copied for one post, THE file first.
export const MAX_FILES_PER_POST = 12;

// The addresses to copy for a post, THE file (the one the game imports, and the
// one whose downloads count as imports) first and marked `primary`.
export const postFiles = (issue) => {
  const kind = kindOfIssue(issue);
  if (!kind) return { kind: null, files: [] };
  const body = String(issue?.body ?? "");
  const primaries = [];
  if (kind === "scenario") {
    primaries.push(body.match(SCENARIO_FILE)?.[0]);
  } else if (kind === "flag") {
    const file = body.match(FLAG_FILE)?.[0];
    primaries.push(firstHubImage(body) ?? (file && IMAGE_NAME.test(file) ? file : null));
  } else {
    // A basemap is a data file (a vector's .zip, an old .json) or, for an image
    // basemap, the image itself; the game reads the data file first.
    primaries.push(body.match(BASEMAP_FILE)?.[0], firstHubImage(body));
  }
  const ordered = [];
  const seen = new Set();
  const add = (source, primary) => {
    const url = String(source ?? "").trim();
    if (!url || seen.has(url)) return;
    seen.add(url);
    ordered.push({ source: url, primary });
  };
  let first = true;
  for (const source of primaries) {
    if (!source) continue;
    add(source, first);
    first = false;
  }
  for (const match of body.matchAll(ATTACHMENT)) add(match[0], false);
  return { kind, files: ordered.slice(0, MAX_FILES_PER_POST) };
};

// ---- release assets ---------------------------------------------------------

// A link to a release asset: { owner, repo, tag, name } or null.
export const parseReleaseLink = (url) => {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/?#]+)/i.exec(String(url ?? ""));
  if (!match) return null;
  const decode = (part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  };
  return { owner: match[1], repo: match[2], tag: decode(match[3]), name: decode(match[4]) };
};

// Short and stable for one attachment: its file number, the start of an image's
// id, or a few characters of anything else's address.
const hashText = (text) => {
  let hash = 0x811c9dc5;
  for (const char of String(text)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};
export const sourceKey = (source) => {
  const url = String(source ?? "");
  const file = /\/files\/(\d+)\//.exec(url);
  if (file) return file[1];
  const asset = /\/user-attachments\/assets\/([0-9a-f]{8})/i.exec(url);
  if (asset) return asset[1].toLowerCase();
  return hashText(url);
};

const lastSegment = (source) => {
  try {
    const { pathname } = new URL(source);
    const segment = pathname.split("/").filter(Boolean).pop() ?? "";
    try { return decodeURIComponent(segment); } catch { return segment; }
  } catch {
    return "";
  }
};

const EXTENSION = /\.([A-Za-z0-9]{1,8})$/;
export const extensionOf = (name) => EXTENSION.exec(String(name ?? ""))?.[1].toLowerCase() ?? "";

// What a file is, from its first bytes: the game tells a scenario .zip from a
// .json the same way, never by its name.
export const sniffType = (bytes) => {
  const head = bytes.subarray(0, 512);
  const startsWith = (...values) => values.every((value, index) => head[index] === value);
  if (startsWith(0x50, 0x4b, 0x03, 0x04) || startsWith(0x50, 0x4b, 0x05, 0x06)) return "zip";
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return "png";
  if (startsWith(0xff, 0xd8, 0xff)) return "jpg";
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return "gif";
  if (startsWith(0x52, 0x49, 0x46, 0x46) && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return "webp";
  const text = Buffer.from(head).toString("utf8").replace(/^﻿/, "").trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(text)) return "svg";
  if (text.startsWith("{") || text.startsWith("[")) return "json";
  return "";
};

const IMAGE_TYPES = new Set(["png", "jpg", "gif", "webp", "svg"]);
const DATA_TYPES = new Set(["zip", "json"]);
export const MAX_FILE_BYTES = 200 * 1024 * 1024; // the game refuses a larger scenario file
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

// Why a downloaded file cannot be copied, or "" when it can. THE file of a post
// has to be what the game can import; anything else attached is copied only if
// it is a picture or a data file, and skipped quietly otherwise (`skip`).
export const checkFile = ({ kind, primary, type, size }) => {
  const megabytes = (bytes) => `${Math.max(1, Math.round(bytes / 1048576))} MB`;
  if (!size) return { problem: "it is empty" };
  if (IMAGE_TYPES.has(type)) {
    if (size > MAX_IMAGE_BYTES) return { problem: `it is ${megabytes(size)}, and an image can be ${megabytes(MAX_IMAGE_BYTES)} at most` };
    if (primary && kind === "scenario") return { problem: "it is a picture, not a scenario file (.json or .zip)" };
    return { problem: "" };
  }
  if (DATA_TYPES.has(type)) {
    if (size > MAX_FILE_BYTES) return { problem: `it is ${megabytes(size)}, and the game can import ${megabytes(MAX_FILE_BYTES)} at most` };
    if (primary && kind === "flag") return { problem: "it is not an image (.png, .jpg, .webp, .gif or .svg)" };
    return { problem: "" };
  }
  if (!primary) return { problem: "", skip: true };
  if (kind === "scenario") return { problem: "it is not a scenario file: the game exports a .json or a .zip" };
  if (kind === "flag") return { problem: "it is not an image the game can read (.png, .jpg, .webp, .gif or .svg)" };
  return { problem: "it is not a basemap the game can read (an image, or the .zip the editor gave you)" };
};

const CONTENT_TYPES = {
  zip: "application/zip",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};
export const contentTypeOf = (type) => CONTENT_TYPES[type] ?? "application/octet-stream";

// The name a copied file gets in its release: the post it belongs to, the
// attachment it is, and its own name, in characters a release keeps as given.
export const assetName = ({ post, source, type }) => {
  const original = lastSegment(source);
  const stem = (extensionOf(original) ? original.replace(EXTENSION, "") : original)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  // An image dragged into a post has an id and no name.
  const named = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(original) ? "" : stem;
  const extension = type || extensionOf(original) || "bin";
  return [assetPrefix({ post, source }), named].filter(Boolean).join("-") + `.${extension}`;
};
// What every name of one attachment of one post starts with.
export const assetPrefix = ({ post, source }) => `p${Number(post)}-${sourceKey(source)}`;

// The release a kind's files go in: "<prefix>-<n>", a new one once the last is
// nearly full (a release holds 1000 files).
export const RELEASE_PREFIX = { scenario: "scenarios", flag: "flags", basemap: "basemaps" };
export const RELEASE_FILE_LIMIT = 900;
export const releaseNumberOf = (tag, kind) => {
  const match = new RegExp(`^${RELEASE_PREFIX[kind]}-(\\d+)$`).exec(String(tag ?? ""));
  return match ? Number(match[1]) : 0;
};
export const chooseRelease = (releases, kind) => {
  const own = releases
    .map((release) => ({ release, number: releaseNumberOf(release.tag, kind) }))
    .filter((entry) => entry.number > 0)
    .sort((a, b) => b.number - a.number);
  const last = own[0];
  if (last && last.release.assets.length < RELEASE_FILE_LIMIT) return { tag: last.release.tag, create: false };
  return { tag: `${RELEASE_PREFIX[kind]}-${(last?.number ?? 0) + 1}`, create: true };
};
export const releaseTitle = (kind, tag) => {
  const label = { scenario: "Scenario files", flag: "Flag files", basemap: "Basemap files" }[kind];
  return `${label} (${releaseNumberOf(tag, kind)})`;
};
export const releaseNotes = (kind) => [
  `The files attached to the hub's **${kind}** posts, copied here automatically so the game can download them and GitHub can count the downloads.`,
  "",
  "Do not upload, rename or delete files here by hand: the **Copy post files to releases** workflow owns this release. To change a file, edit the post it came from.",
].join("\n");
