// The music list (music.json, on the music-index branch) and what changes it:
// publishing a checked track, changing its details, taking it down. The game
// reads the list, to offer the tracks to scenario makers and to play them, so
// its shape stays exactly this:
//
//   { schema: "open-historia-music-index/1", updated: <ISO time>,
//     tracks: [{ id, name, artist, licence, source, credit, fits, version,
//                file, type, bytes, sha256, seconds, post, postedBy, removed }] }
//
// A track's ID never changes and is never used again: a track that is taken
// down stays in the list with `removed: true`, no file, and null for its
// bytes, sha256 and seconds, so a scenario that names it is never given
// someone else's music instead.
//
// Only the hub's contributors can post music (ALLOWED_ASSOCIATIONS below).
// A picture or a map is its author's to share. A piece of music is almost
// always someone else's, and the hub hands a copy of it to every player: so
// somebody the maintainers know has to have checked that it may.

import { downloadLink } from "../detailed-maps/maps.mjs";
import { TRACK_ID } from "../lib/scenario-music.mjs";
import { MAX_TRACK_BYTES, megabytesText } from "./audio.mjs";

export const SCHEMA = "open-historia-music-index/1";
export const LABEL = "music";
export const DATA_BRANCH = "music-index";
export const LIST_FILE = "music.json";
export const PAGE_FILE = "MUSIC.md";
// The one release the tracks' files go in.
export const RELEASE_TAG = "music";
// Where someone who is not a contributor proposes a track.
export const DISCORD = "https://discord.gg/QaqAK7fQAg";

// Who may post music, by what GitHub itself says the post's author is to this
// repository (`author_association` on the issue): its owner, a member of the
// organisation it belongs to, or someone invited to work on it. Nothing a post
// says of itself counts: only GitHub fills this in.
export const ALLOWED_ASSOCIATIONS = Object.freeze(["OWNER", "MEMBER", "COLLABORATOR"]);
export const mayPostMusic = (issue) => ALLOWED_ASSOCIATIONS.includes(issue?.author_association);

// The licences the form offers (.github/ISSUE_TEMPLATE/music.yml), and the
// short name the list gives each. Keep the two in step.
export const LICENCES = new Map([
  ["CC0 1.0 (public domain)", "CC0 1.0"],
  ["CC BY 4.0", "CC BY 4.0"],
  ["CC BY-SA 4.0", "CC BY-SA 4.0"],
  ["Public domain (expired or dedicated)", "Public domain"],
  ["My own work, released under CC BY 4.0", "CC BY 4.0"],
  ["My own work, released under CC0 1.0", "CC0 1.0"],
  ["Other free licence (say which under Credits)", "Other free licence"],
]);

// The form's "Fits" boxes and what the list calls each, in the order the list
// writes them.
export const FITS = new Map([
  ["The menu", "menu"],
  ["A game loading", "loading"],
  ["In the game", "game"],
  ["At war", "atWar"],
  ["In the war room", "battle"],
]);

// "<id>-v<version>-<the first 8 characters of its SHA-256>.<mp3|ogg>": the
// checksum makes an address mean one file for good, so a copy kept by its
// address is never a different file from the one the list describes.
export const assetNameOf = ({ id, version, sha256, type }) => `${id}-v${version}-${String(sha256).slice(0, 8)}.${type}`;
export const CONTENT_TYPES = { mp3: "audio/mpeg", ogg: "audio/ogg" };

// A contributor's file, to disk: as a detailed map's is downloaded (https
// only, never a private address, stopped at the cap), with a track's cap.
export const downloadTrack = (link, dest, options = {}) => downloadLink(link, dest, {
  maxBytes: MAX_TRACK_BYTES,
  tooBig: (bytes) => `The file is ${bytes ? `${megabytesText(bytes)} MB` : "over 20 MB"}; a track can be 20 MB at most.`,
  ...options,
});

// ---- the list -----------------------------------------------------------------

export const emptyList = () => ({ schema: SCHEMA, updated: "", tracks: [] });

export const findTrack = (list, id) => list.tracks.find((track) => track.id === id) ?? null;

// Why `id` can't be the ID of a new track, or "" when it can.
export const idProblem = (list, id, name = "") => {
  if (!TRACK_ID.test(id)) return `"${id || name}" can't be a track ID: use lower-case letters, digits and dashes (at most 64).`;
  const track = findTrack(list, id);
  if (!track) return "";
  if (track.removed) return `"${id}" was the ID of a track that has been removed, so choose a different one. Track IDs are never used again.`;
  return `"${id}" is already the ID of another track${track.post ? ` (#${track.post})` : ""}. Choose a different one.`;
};

// One track as the list holds it, its fields always in the same order.
const trackOf = ({ id, name, artist, licence, source, credit, fits, version, file, type, bytes, sha256, seconds, post, postedBy, removed = false }) => ({
  id, name, artist, licence, source, credit, fits, version, file, type, bytes, sha256, seconds, post, postedBy, removed,
});

// Puts one checked file on the list: a new track, or the next version of one
// that is there, in its place.
export const publish = (list, track) => {
  const at = list.tracks.findIndex((entry) => entry.id === track.id);
  if (at >= 0 && list.tracks[at].removed) throw new Error(`${track.id} was removed, so it can't be published again.`);
  if (at >= 0 && list.tracks[at].version >= track.version) throw new Error(`${track.id} already has a version ${track.version}.`);
  const entry = trackOf(track);
  if (at >= 0) list.tracks[at] = entry;
  else list.tracks.push(entry);
  return entry;
};

// What a post's edit can change without a new file: everything but the file.
export const DETAILS = ["name", "artist", "licence", "source", "credit", "fits"];
export const updateDetails = (track, details) => {
  for (const key of DETAILS) track[key] = details[key];
};

// Taken down, for good: no file, and nothing that describes one.
export const takeDown = (track) => {
  Object.assign(track, { file: "", bytes: null, sha256: null, seconds: null, removed: true });
};

// By name, as people read them; by ID where two share a name.
export const sortTracks = (list) => {
  list.tracks.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};
