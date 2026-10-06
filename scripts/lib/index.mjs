// The index the game reads (index.json on the hub-index branch), made from the
// workflow's own notes (state.json).
//
//   files        attachment address, as written in a post -> its checked copy
//   imports      scenario post number -> how often its file was downloaded
//   posts        the hub's posts as the game lists them: released posts only,
//                newest first, each in the field names of a GitHub issue so
//                the game's own parsers read it
//   suggestions  comment id -> { post, zip } for suggestions that passed
//
// Only what was checked is in it: a post is listed once its file has been
// released, and with the text it had then. A post whose newer version has a
// problem stays as it last was until that is fixed.

import { fileNameOf } from "./posts.mjs";

export const INDEX_VERSION = 2;
export const MAX_BODY_CHARACTERS = 20000;

// The lines the game looks for anywhere in a post's body (hubPosts.js,
// communityFlags.js, communityBasemaps.js).
const TECHNICAL_LINE = /^[ \t]*(?:Scenario-Key|Flags-Count|Basemap-Hash|Basemap-Kind|Flag-Code|Flag-Polity):.*$/gim;

// A post's body, at most MAX_BODY_CHARACTERS long. A longer one is cut, and
// what the game needs from the part that was cut is put after it: the
// addresses of the post's files (as links, which the game leaves out of the
// description it shows) and the technical lines, in their order.
export const limitedBody = (body, sources = []) => {
  const text = String(body ?? "");
  if (text.length <= MAX_BODY_CHARACTERS) return text;
  const tailFor = (kept) => {
    const lost = text.slice(kept);
    const links = sources.filter((source) => !text.slice(0, kept).includes(source) && text.includes(source))
      .map((source) => (fileNameOf(source) ? `[${fileNameOf(source).replace(/[[\]]/g, "")}](${source})` : `![](${source})`));
    return ["", "", ...links, ...(lost.match(TECHNICAL_LINE) ?? []).map((line) => line.trim())].join("\n");
  };
  // What is appended depends on where the cut falls, and the cut on how much
  // is appended: settle it in two steps.
  let kept = MAX_BODY_CHARACTERS - tailFor(MAX_BODY_CHARACTERS).length;
  kept = Math.max(0, Math.min(kept, MAX_BODY_CHARACTERS - tailFor(Math.max(0, kept)).length));
  return `${text.slice(0, kept)}${tailFor(kept)}`.slice(0, MAX_BODY_CHARACTERS);
};

// One post as the index lists it: what was released (title, body, labels) and
// how it stands now (state, reactions, comments).
const listedPost = (number, record) => {
  const { released, live = {} } = record;
  return {
    number,
    kind: record.kind,
    state: live.state === "closed" ? "closed" : "open",
    title: released.title,
    body: limitedBody(released.body, record.files.map((file) => file.source)),
    user: released.user,
    html_url: released.html_url,
    created_at: released.created_at,
    updated_at: live.updated_at ?? released.created_at,
    labels: released.labels,
    author_association: released.author_association,
    reactions: { "+1": Number(live.upvotes) || 0 },
    comments: Number(live.comments) || 0,
  };
};

// { version, files, imports, posts, suggestions }. `importsOf(key, record)` is
// the count for one scenario post, which only the caller can know (it has the
// releases' download counts).
export const buildIndex = (state, { pipeline, importsOf }) => {
  const files = {};
  const imports = {};
  const posts = [];
  for (const [key, record] of Object.entries(state.posts)) {
    if (record.kind === "scenario") {
      const total = importsOf(key, record);
      if (total > 0) imports[key] = total;
    }
    // What an earlier pipeline copied was never checked, and is not offered.
    if (!record.released || record.pipeline !== pipeline) continue;
    for (const file of record.files) files[file.source] = file.asset.url;
    posts.push(listedPost(Number(key), record));
  }
  posts.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.number - a.number);
  const suggestions = {};
  for (const [id, suggestion] of Object.entries(state.suggestions)) {
    // Only on a post that is itself listed; a test post's are never listed.
    if (!suggestion.test && !suggestion.unlisted && state.posts[suggestion.post]?.released) suggestions[id] = { post: suggestion.post, zip: suggestion.zip };
  }
  return { version: INDEX_VERSION, files, imports, posts, suggestions };
};
