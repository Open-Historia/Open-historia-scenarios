// A music post's body as the form (.github/ISSUE_TEMPLATE/music.yml) writes
// it: the headings the workflow reads its answers under (form.mjs), in the
// form's order. For a maintainer's tool that posts tracks without filling the
// form in by hand (scripts/import-scott-buckley.mjs).
//
// The box under "Before you post" is written ticked: whoever runs such a tool
// is saying what the box says, for every track it posts.

import { FITS } from "./music.mjs";

const CONFIRMED = "I have checked that this track's licence allows the hub to share it and games to play it, and that the credit line above is the one it asks for.";
// The form's own name for each licence the list knows by its short name.
const FORM_LICENCE = { "CC0 1.0": "CC0 1.0 (public domain)", "CC BY 4.0": "CC BY 4.0", "CC BY-SA 4.0": "CC BY-SA 4.0", "Public domain": "Public domain (expired or dedicated)" };

export const postTitleOf = (track) => `[Music] ${track.name}`;

// track: { id, name, artist, licence (the list's short name), source, credit,
//         download, fits, genres, moods, instruments, notes }
export const postBodyOf = (track) => {
  const licence = FORM_LICENCE[track.licence];
  if (!licence) throw new Error(`"${track.licence}" is not a licence a tool may post under`);
  const fits = new Set(track.fits ?? []);
  // As GitHub writes a choice of several from a list.
  const chosen = (tags) => (tags?.length ? tags.join(", ") : "_No response_");
  return [
    "### Track name", "", track.name, "",
    "### Track ID", "", track.id || "_No response_", "",
    "### Composer / artist", "", track.artist, "",
    "### Licence", "", licence, "",
    "### Source", "", track.source, "",
    "### Credit line", "", track.credit, "",
    "### Download link to the audio file", "", track.download, "",
    "### Fits", "", ...[...FITS].map(([label, fit]) => `- [${fits.has(fit) ? "x" : " "}] ${label}`), "",
    "### Genre", "", chosen(track.genres), "",
    "### Mood", "", chosen(track.moods), "",
    "### Instruments", "", chosen(track.instruments), "",
    "### Notes", "", track.notes || "_No response_", "",
    "### Before you post", "", `- [x] ${CONFIRMED}`, "",
  ].join("\n");
};
