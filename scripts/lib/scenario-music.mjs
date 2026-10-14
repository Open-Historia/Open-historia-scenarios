// The music a scenario names: the `music` record of its `scenario` part.
//
// A scenario never carries music and never points at a sound file. It names
// tracks of the hub's music list (music.json on the music-index branch, which
// only the hub's contributors can add to: scripts/music) by their ID and
// version, for each situation the game plays music in:
//
//   { loading: [...], game: [...], atWar: [...], battle: [...] }
//   each a list of at most 12 entries { id, version }
//
// Anything else in it is refused. An address there would have every player's
// game fetch a file from wherever the scenario's author liked, and would get
// round the one thing the music list is for: that every track is one the hub
// is allowed to share.
//
// Whether an ID is on the list is NOT checked. A track can be taken down after
// a scenario named it, and the game skips an ID it cannot find.

import { count, isRecord, quoted } from "./util.mjs";

// A track's ID, as the music list gives them out: lower-case letters, digits
// and dashes (scripts/music/music.mjs uses this same pattern).
export const TRACK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MUSIC_SITUATIONS = ["loading", "game", "atWar", "battle"];
export const MAX_TRACKS_PER_SITUATION = 12;

const SITUATION_NAMES = MUSIC_SITUATIONS.map((name) => `\`${name}\``).join(", ");

// Checks the `music` record of a scenario; `label` is how the scenario is named
// in a sentence. Problems go to `findings`. Nothing is put right here: a
// record that is not what the game writes is the author's to fix.
export const checkScenarioMusic = (music, { label, findings }) => {
  if (music === undefined || music === null) return;
  if (!isRecord(music)) {
    findings.problem(`${label} is damaged: its ${quoted("scenario.music")} is not what the game writes there`);
    return;
  }
  for (const [situation, tracks] of Object.entries(music)) {
    if (!MUSIC_SITUATIONS.includes(situation)) {
      findings.problem(`${label} has music for ${quoted(situation)}, which is not something a scenario can set music for (only ${SITUATION_NAMES})`);
      continue;
    }
    const named = `the ${quoted(situation)} music of ${label}`;
    if (!Array.isArray(tracks)) {
      findings.problem(`${named} is not a list of tracks`);
      continue;
    }
    if (tracks.length > MAX_TRACKS_PER_SITUATION) {
      findings.problem(`${named} names ${count(tracks.length)} tracks, and a scenario can name ${MAX_TRACKS_PER_SITUATION} at most for one situation`);
    }
    for (const [index, entry] of tracks.slice(0, MAX_TRACKS_PER_SITUATION).entries()) {
      const which = `track ${index + 1}`;
      if (!isRecord(entry)) {
        findings.problem(`${named} has an entry that does not name a track of the hub's music list (${which}): a track is named by its \`id\` and \`version\`, and never by an address`);
        continue;
      }
      const other = Object.keys(entry).find((key) => key !== "id" && key !== "version");
      if (other !== undefined) {
        findings.problem(`${named} has an entry with a field other than \`id\` and \`version\` (${quoted(other)}, ${which}): a scenario only names tracks of the hub's music list, and carries no address or file for one`);
      }
      if (typeof entry.id !== "string" || !TRACK_ID.test(entry.id)) {
        findings.problem(`${named} names a track by ${typeof entry.id === "string" ? quoted(entry.id) : "something that is not text"} (${which}), which is not a track's ID: an ID is lower-case letters, digits and dashes`);
      }
      if (!Number.isSafeInteger(entry.version) || entry.version < 1) {
        findings.problem(`${named} has an entry whose \`version\` is not a whole number from 1 up (${which})`);
      }
    }
  }
};
