// Reading a hub post (an issue labelled "scenario", "flag" or "basemap"): which
// files are attached to it, which one is THE file the game downloads, and what
// each is called when its checked copy goes into a release.
//
// The patterns here are the game's own (src/runtime/hubPosts.js,
// communityFlags.js, communityBasemaps.js, hubIssues.js in the game's
// repository): the game looks a file up by the exact address it found in the
// post, so both sides have to find the same address.
//
// A comment on a scenario post is read only to tell whether it is a suggestion
// (a .zip with suggested changes, by the game's rule): a suggestion is checked
// where it is and never copied.

export const KINDS = ["scenario", "flag", "basemap"];
// An issue with this label and no kind label is a test post: its files go
// through the same checks as a real post's, and nothing of it reaches a game
// (games list posts by the three kind labels, and it has none).
export const TEST_LABEL = "security test";

const labelsOf = (issue) => (issue?.labels ?? []).map((label) => String(label?.name ?? label ?? "").toLowerCase());
export const hasLabel = (issue, name) => labelsOf(issue).includes(String(name).toLowerCase());

// The post's kind, from its labels: the game lists posts by label, so a post
// without one is not a post to the game either.
export const kindOfIssue = (issue) => KINDS.find((kind) => labelsOf(issue).includes(kind)) ?? null;

// A test post's kind, from the start of its title: the prefix the issue forms
// write ("[Scenario] ", "[Flag] ", "[Basemap] ").
export const kindOfTitle = (title) => /^\s*\[(scenario|flag|basemap)\]/i.exec(String(title ?? ""))?.[1].toLowerCase() ?? null;
export const isTestPost = (issue) => hasLabel(issue, TEST_LABEL) && !kindOfIssue(issue) && !issue?.pull_request;

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

// The patterns above are the game's, and they are kept as they are so that
// both sides find the same address. One kind of text they cannot be given:
// the scenario and basemap patterns take time that grows with the cube of a
// text made for them. 65,000 characters of "https://github.com/" and
// "/releases/download/", over and over, keep one busy for more than a
// minute, here and in every game that reads the post. What such a search can
// cost is at most its starts, times the places it can turn at, times the
// length of the text; an ordinary post has a handful of each. A text over the
// limit is not searched: it has no files, and `slow` says why.
const MAX_SEARCH = 2e8;
const occurrences = (text, piece) => {
  let found = 0;
  for (let at = text.indexOf(piece); at >= 0; at = text.indexOf(piece, at + piece.length)) found += 1;
  return found;
};
export const slowToRead = (body) => {
  const text = String(body ?? "").toLowerCase();
  return occurrences(text, "https://github.com/") * (occurrences(text, "/releases/download/") + 1) * text.length > MAX_SEARCH;
};

// At most this many files are copied for one post, THE file first.
export const MAX_FILES_PER_POST = 12;

// The addresses to copy for a post, THE file (the one the game imports, and the
// one whose downloads count as imports) first and marked `primary`. `kind` is
// given for a test post, which has no kind label to tell it by.
export const postFiles = (issue, kind = kindOfIssue(issue)) => {
  if (!kind) return { kind: null, files: [] };
  const body = String(issue?.body ?? "");
  if (slowToRead(body)) return { kind, files: [], slow: true };
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

// ---- suggestions ----------------------------------------------------------------

// The game's rule for a suggestion (hubPosts.js parseSuggestionComment), to the
// letter: a comment with a .zip attachment that is named like a suggestion, or
// any .zip attachment when the comment carries the marker line the game writes.
const SUGGESTION_MARKER_PATTERN = /^\s*Open-Historia-Suggestion:\s*([A-Za-z0-9-]{4,80})\s*$/im;
const ZIP_ATTACHMENT_PATTERN = /https:\/\/github\.com\/(?:user-attachments\/files|[^\s)<>"'/]+\/[^\s)<>"'/]+\/files)\/[^\s)<>"']+\.zip/gi;

// The address of a comment's suggestion file, or null when the game would not
// take the comment for a suggestion.
export const suggestionZipOf = (body) => {
  const text = String(body ?? "");
  const zips = text.match(ZIP_ATTACHMENT_PATTERN) ?? [];
  if (!zips.length) return null;
  return zips.find((url) => /suggestion[^/]*\.zip$/i.test(url)) ?? (SUGGESTION_MARKER_PATTERN.test(text) ? zips[0] : null);
};

// A comment of the workflow's own must never be one: whatever it quotes, any
// address in it that the rule above would pick up is taken out before it is
// posted.
export const withoutZipAttachments = (text) => String(text).replace(ZIP_ATTACHMENT_PATTERN, "(an address, left out)");

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

// Whether an address is a file of this hub: the address of a file of one of
// its posts, or a file in this repository's releases. (A scenario may share a
// community basemap only by such an address.) The test is made from plain
// lists, so that it can be handed to the process that checks files
// (checker.mjs): the post files' addresses, this repository's names in lower
// case, and "tag/name" for each file in its releases.
export const hubAddressTest = ({ addresses = [], repos = [], assets = [] } = {}) => {
  const posted = new Set(addresses);
  const ours = new Set(repos);
  const released = new Set(assets);
  return (url) => {
    if (posted.has(url)) return true;
    const link = parseReleaseLink(url);
    return Boolean(link) && ours.has(`${link.owner}/${link.repo}`.toLowerCase()) && released.has(`${link.tag}/${link.name}`);
  };
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

// The last part of an address, as a name: "" for an image dragged into a post,
// which has an id and no name.
export const fileNameOf = (source) => {
  try {
    const { pathname } = new URL(source);
    const segment = pathname.split("/").filter(Boolean).pop() ?? "";
    let name = segment;
    try { name = decodeURIComponent(segment); } catch { /* as it is */ }
    return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(name) ? "" : name;
  } catch {
    return "";
  }
};

const EXTENSION = /\.([A-Za-z0-9]{1,8})$/;
export const extensionOf = (name) => EXTENSION.exec(String(name ?? ""))?.[1].toLowerCase() ?? "";

export const MAX_FILE_BYTES = 200 * 1024 * 1024; // the game refuses a larger scenario file

// The name a checked copy gets in its release: the post it belongs to, the
// attachment it is, its own name, and the start of the SHA-256 of its bytes, in
// characters a release keeps as given. The hash makes an address mean one
// file for good (the game keeps what it downloaded by its address), and the
// extension says what the copy is, which is not always what was attached (an
// SVG's copy is a PNG).
export const assetName = ({ post, source, type, sha256 = "", test = false }) => {
  const original = fileNameOf(source);
  const stem = (extensionOf(original) ? original.replace(EXTENSION, "") : original)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  const extension = type || extensionOf(original) || "bin";
  return [assetPrefix({ post, source, test }), stem, String(sha256).slice(0, 8)].filter(Boolean).join("-") + `.${extension}`;
};
// What every name of one attachment of one post starts with ("t" for a test
// post's, which live in a release of their own).
export const assetPrefix = ({ post, source, test = false }) => `${test ? "t" : "p"}${Number(post)}-${sourceKey(source)}`;

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
  `The files attached to the hub's **${kind}** posts, checked and copied here automatically so the game can download them and GitHub can count the downloads.`,
  "",
  "Do not upload, rename or delete files here by hand: the **Copy post files to releases** workflow owns this release. To change a file, edit the post it came from.",
].join("\n");

// The one release test posts' checked copies go in.
export const TEST_RELEASE = "security-test";
export const TEST_RELEASE_TITLE = "Security test files";
export const TEST_RELEASE_NOTES = [
  `What the checks made of the files attached to issues labelled **${TEST_LABEL}**: files made to be refused or repaired, to see that they are.`,
  "",
  "Nothing here is on the hub. No game lists these issues or downloads these files, and each file is deleted when its issue is closed.",
].join("\n");
// Whether a release is one the workflow fills (and so one whose files are its
// own copies, not files a post can adopt by linking to them).
export const isOwnRelease = (tag) => tag === TEST_RELEASE || KINDS.some((kind) => releaseNumberOf(tag, kind) > 0);
