// MUSIC.md on the music-index branch: the music list for people to read. This
// page is how the hub credits the music: every track with its composer, its
// licence, where it comes from, and the credit line its licence asks for.
// Written from the list on every change; the README links to it.

import { cell, quoted } from "../detailed-maps/page.mjs";
import { megabytesText } from "./audio.mjs";
import { DISCORD, FITS } from "./music.mjs";

// "4:31", or a dash for a length that could not be told.
export const lengthText = (seconds) => (Number.isInteger(seconds) ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "—");

// "The menu, A game loading": the form's own words for where a track fits.
const FIT_LABELS = new Map([...FITS].map(([label, fit]) => [fit, label]));
export const fitsText = (fits) => (fits ?? []).map((fit) => FIT_LABELS.get(fit) ?? fit).join(", ");

export const buildPage = (list, state, { repo }) => {
  const postUrl = (number) => `https://github.com/${repo}/issues/${number}`;
  const shown = list.tracks.filter((track) => !track.removed);
  const removed = list.tracks.filter((track) => track.removed);
  const lines = [
    "# Background music",
    "",
    "Music that scenario makers can choose for their scenarios: while a game loads, in the game, at war and in the war room. Each track is here with its composer, its licence, where it comes from and the credit its licence asks for: **this page is how the hub credits the music.**",
    "",
    `Music can be posted only by the hub's contributors, because every track must be one the hub is allowed to share. To propose a track, ask on [Discord](${DISCORD}). This page is written by the **Background music** workflow from the [music posts](https://github.com/${repo}/issues?q=label%3Amusic); don't edit it by hand.`,
    "",
  ];
  if (!shown.length) {
    lines.push("_No music yet._", "");
  } else {
    lines.push("| Track | ID | Composer / artist | Licence | Length | Size | Fits |", "|---|---|---|---|---|---|---|");
    for (const track of shown) {
      const name = track.post ? `[${cell(track.name)}](${postUrl(track.post)})` : cell(track.name);
      lines.push(`| ${name} | \`${cell(track.id)}\` | ${cell(track.artist)} | ${cell(track.licence)} | ${lengthText(track.seconds)} | ${megabytesText(track.bytes)} MB | ${cell(fitsText(track.fits)) || "—"} |`);
    }
    lines.push("", "## Credits and licences", "");
    for (const track of shown) {
      lines.push(
        `### ${cell(track.name)} (\`${cell(track.id)}\`)`,
        "",
        `- **Composer / artist:** ${cell(track.artist)}`,
        `- **Licence:** ${cell(track.licence)}`,
        `- **Source:** <${track.source}>`,
        "- **Credit:**",
        "",
        quoted(track.credit),
        "",
        `[The track's post](${postUrl(track.post)}) · [The file](${track.file}) (version ${track.version}, posted by @${cell(track.postedBy)})`,
        "",
      );
    }
  }
  if (removed.length) {
    lines.push("## Removed tracks", "", "These IDs are never used again, so a scenario that names one is never given other music in its place.", "");
    for (const track of removed) {
      const when = state.posts?.[track.post]?.removed?.date;
      lines.push(`- \`${cell(track.id)}\` (${cell(track.name)})${when ? `, removed ${cell(when)}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
};
