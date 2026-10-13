// Reading a detailed map post (.github/ISSUE_TEMPLATE/detailed-map.yml) and
// what is wrong with its answers, if anything. The file itself is checked once
// it is downloaded (sync.mjs).

import { findMap, idProblem, plain, slugify } from "./maps.mjs";

// GitHub writes each form field as "### <label>" and its answer, and an empty
// optional answer as "_No response_".
const FIELDS = {
  name: "Map name",
  mapId: "Map ID",
  download: "Download link to the .pmtiles file",
  size: "File size",
  sha256: "SHA-256 checksum (optional)",
  description: "What does the map show?",
  changes: "What changed? (updates only)",
  preview: "Screenshots",
  credits: "Who made it, and what is it based on?",
  licence: "Licence",
  checks: "Before you post",
};
export const CHECKBOX_COUNT = 4;

// The answers of a post made with an issue form, by the headings they stand
// under: `fields` is { key: heading }, and the result { key: answer }. (The
// background music form is read with this too: scripts/music/form.mjs.)
export const readAnswers = (body, fields) => {
  const sections = {};
  let current = null;
  for (const line of String(body ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const heading = /^###\s+(.*?)\s*$/.exec(line);
    if (heading) {
      current = heading[1];
      sections[current] = [];
    } else if (current) {
      sections[current].push(line);
    }
  }
  const field = (label) => {
    const value = (sections[label] ?? []).join("\n").trim();
    return value === "_No response_" ? "" : value;
  };
  const form = {};
  for (const [key, label] of Object.entries(fields)) form[key] = field(label);
  return form;
};

// The address in an answer, as it was given: GitHub may have made it a link.
export const linkOf = (answer) => /\]\((https?:\/\/[^\s)]+)\)/.exec(answer)?.[1] ?? /\S+/.exec(answer.replace(/^<|>$/g, ""))?.[0] ?? "";

// The boxes of a checkbox answer that are ticked, by what is written beside them.
export const tickedIn = (answer) => [...String(answer ?? "").matchAll(/^- \[[xX]\][ \t]*(.*?)[ \t]*$/gm)].map((match) => match[1]);

export const parseForm = (body) => {
  const form = readAnswers(body, FIELDS);
  form.download = linkOf(form.download);
  form.ticked = tickedIn(form.checks).length;
  return form;
};

// { id, sha256, problems }. `ownId` is the ID this post's map already has,
// which can't change; a new post's ID is the one asked for, or one made from
// the name.
export const checkForm = (form, list, { ownId = "" } = {}) => {
  const problems = [];
  const asked = plain(form.mapId).toLowerCase();
  let id = ownId;
  if (ownId) {
    if (asked && asked !== ownId) problems.push(`This post's map has the ID \`${ownId}\`, and a map's ID never changes. Put \`${ownId}\` back under **Map ID** (or leave it empty). For a different map, make a new post.`);
    if (findMap(list, ownId)?.archived) problems.push(`\`${ownId}\` is archived, so it can't get a new version. Ask a maintainer to restore it first.`);
  } else {
    id = asked || slugify(form.name);
    const problem = idProblem(list, id, plain(form.name));
    if (problem) problems.push(problem);
  }
  if (!plain(form.name)) problems.push("The map needs a name.");
  if (!/^https:\/\//i.test(form.download)) problems.push("The download link must start with https://.");
  if (!plain(form.description)) problems.push("Say what the map shows.");
  if (!plain(form.credits)) problems.push("Say who made the map and what it is based on.");
  if (!plain(form.licence)) problems.push("Give the map's licence.");
  if (!form.preview.trim()) problems.push("Add one or two screenshots.");
  if (form.ticked < CHECKBOX_COUNT) problems.push("Tick all the boxes under **Before you post**.");
  // A release page on GitHub shows a file's checksum as "sha256:<64 characters>".
  const sha256 = plain(form.sha256).toLowerCase().replace(/^sha-?256:\s*/, "");
  if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) problems.push("The SHA-256 checksum should be 64 letters and digits (or leave it empty).");
  return { id, sha256: /^[a-f0-9]{64}$/.test(sha256) ? sha256 : "", problems };
};
