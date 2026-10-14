// Reading a background music post (.github/ISSUE_TEMPLATE/music.yml) and what
// is wrong with its answers, if anything. The file itself is checked once it
// is downloaded (sync.mjs).

import { linkOf, readAnswers, tickedIn } from "../detailed-maps/form.mjs";
import { plain, slugify } from "../detailed-maps/maps.mjs";
import { FITS, LICENCES, idProblem } from "./music.mjs";
import { GENRES, INSTRUMENTS, MOODS, tagsOf } from "./tags.mjs";

// The form's headings: the answers are read from under them.
const FIELDS = {
  name: "Track name",
  trackId: "Track ID",
  artist: "Composer / artist",
  licence: "Licence",
  source: "Source",
  credit: "Credit line",
  download: "Download link to the audio file",
  fits: "Fits",
  genres: "Genre",
  moods: "Mood",
  instruments: "Instruments",
  checks: "Before you post",
};

// The three lists a track can be found by, under the form's headings.
const TAG_FIELDS = [
  ["genres", "Genre", GENRES],
  ["moods", "Mood", MOODS],
  ["instruments", "Instruments", INSTRUMENTS],
];

// One line of text as it was written. Not `plain`, which reads Markdown and
// would take the underscores out of an address: a credit line is shown as it
// is, by the game and on the music page.
const line = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

export const parseForm = (body) => {
  const form = readAnswers(body, FIELDS);
  form.download = linkOf(form.download);
  form.source = linkOf(form.source);
  const ticked = new Set(tickedIn(form.fits));
  form.fits = [...FITS].filter(([label]) => ticked.has(label)).map(([, fit]) => fit);
  form.ticked = tickedIn(form.checks).length;
  // { tags, unknown } for each: the names chosen, and what named none.
  for (const [key, , names] of TAG_FIELDS) form[key] = tagsOf(form[key], names);
  return form;
};

// A page anyone can open: an http or https address, written out whole (and
// not so long that it is no address anyone would give).
const pageOf = (text) => {
  try {
    const url = new URL(text);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.includes(".") && url.href.length <= 500 ? url.href : "";
  } catch {
    return "";
  }
};

// { id, details, problems }. `details` is what the list says of the track
// apart from its file: { name, artist, licence, source, credit, fits, genres,
// moods, instruments }.
// `ownId` is the ID this post's track already has, which can't change; a new
// post's ID is the one asked for, or one made from the name.
export const checkForm = (form, list, { ownId = "" } = {}) => {
  const problems = [];
  const asked = plain(form.trackId).toLowerCase();
  let id = ownId;
  if (ownId) {
    if (asked && asked !== ownId) problems.push(`This post's track has the ID \`${ownId}\`, and a track's ID never changes. Put \`${ownId}\` back under **Track ID** (or leave it empty). For a different track, make a new post.`);
  } else {
    id = asked || slugify(form.name);
    const problem = idProblem(list, id, plain(form.name));
    if (problem) problems.push(problem);
  }
  const details = {
    name: plain(form.name).slice(0, 80),
    artist: plain(form.artist).slice(0, 120),
    licence: LICENCES.get(line(form.licence)) ?? "",
    source: pageOf(form.source),
    credit: line(form.credit).slice(0, 500),
    fits: form.fits,
    genres: form.genres.tags,
    moods: form.moods.tags,
    instruments: form.instruments.tags,
  };
  if (!details.name) problems.push("The track needs a name.");
  if (!details.artist) problems.push("Say who composed or performs the track, under **Composer / artist**.");
  if (!details.licence) problems.push(`Choose the track's licence from the form's list, under **Licence**: ${[...LICENCES.keys()].map((name) => `"${name}"`).join(", ")}.`);
  if (!details.source) problems.push("Under **Source**, give the page where the track and its licence can be seen, as a link starting with https:// (or http://).");
  if (!details.credit) problems.push("Give the credit to show for the track, under **Credit line**: the one its licence asks for.");
  if (!/^https:\/\//i.test(form.download)) problems.push("The download link must start with https://.");
  for (const [key, heading] of TAG_FIELDS) {
    const { unknown } = form[key];
    if (unknown.length) problems.push(`Under **${heading}**, ${unknown.map((word) => `"${word}"`).join(", ")} ${unknown.length === 1 ? "is" : "are"} not on the form's list. Choose from the list (edit the post, and pick from the menu under **${heading}**), or leave it empty.`);
  }
  if (form.ticked < 1) problems.push("Tick the box under **Before you post**.");
  return { id, details, problems };
};
