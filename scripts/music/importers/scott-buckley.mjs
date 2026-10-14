// Reading Scott Buckley's music library (www.scottbuckley.com.au/library) as
// its own website publishes it: the WordPress posts list, one post a track.
//
// Every track there is released under CC BY 4.0, and each post says so in a
// sentence of its own and gives the credit line to use. Nothing is assumed:
// a post is taken only if it carries that sentence, and its credit line is the
// one the post gives. A post that does not say it is left out and reported.
//
// Pure functions over the posts' JSON, so the tests can feed them saved posts.
// The fetching, the uploads and the posts on the hub are in
// scripts/import-scott-buckley.mjs.

export const LIBRARY_API = "https://www.scottbuckley.com.au/library/wp-json/wp/v2/posts";
export const ARTIST = "Scott Buckley";
export const LICENCE = "CC BY 4.0";
// The sentence each post carries. Read without its markup.
const LICENCE_SENTENCE = /Creative Commons Attribution 4\.0 International/i;
// Any other Creative Commons licence linked from a post would contradict it.
const OTHER_LICENCE = /creativecommons\.org\/licenses\/(?!by\/4\.0)/i;

const ENTITIES = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
export const decodeEntities = (text) => String(text ?? "")
  .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
  .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);

const textOf = (html) => decodeEntities(String(html ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

// The post's links to MP3 files, with what each link says.
// Older posts wrote their links with http://; the site answers the same file
// over https, and only that is asked for. A link to anywhere but the
// composer's own site is not one of his files.
export const mp3LinksOf = (html) => [...String(html ?? "").matchAll(/<a[^>]+href="(https?:\/\/[^"]+\.mp3)"[^>]*>([\s\S]*?)<\/a>/gi)]
  .map(([, address, label]) => ({ address: address.replace(/^http:\/\//i, "https://"), label: textOf(label) }))
  .filter((link) => /^https:\/\/(?:www\.)?scottbuckley\.com\.au\//i.test(link.address));

// The piece as its composer means it heard: the link called "MP3 (Full Mix)",
// "Full Mix" or just "MP3"; a post with several mixes lists the others after
// it ("No Choir Mix", "Piano Only", an older year's mix).
const MAIN_MIX = /^(?:download )?(?:mp3(?: \(full mix\))?|full mix)$/i;
export const mainMixOf = (links) => links.find((link) => MAIN_MIX.test(link.label)) ?? links[0] ?? null;

// The credit the post asks for, after "Attribution format:".
export const creditOf = (html) => {
  const match = /Attribution format:?\s*(?:<[^>]+>\s*)*([^<]+)/i.exec(String(html ?? ""));
  const credit = match ? decodeEntities(match[1]).replace(/\s+/g, " ").trim() : "";
  return /Scott Buckley/i.test(credit) && /CC-?BY/i.test(credit) ? credit : "";
};

// A track ID from the post's own address: lower-case letters, digits, dashes.
export const idOf = (slug) => String(slug ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

// One post → { track } or { skipped: why }. `track` is what a music post on
// the hub needs, with `original` the address of the file on the composer's site.
export const readPost = (post) => {
  const html = post?.content?.rendered ?? "";
  const name = decodeEntities(post?.title?.rendered ?? "").replace(/\s+/g, " ").trim();
  const source = String(post?.link ?? "");
  const id = idOf(post?.slug);
  if (!name || !id || !/^https:\/\/www\.scottbuckley\.com\.au\/library\//.test(source)) return { skipped: "not a library post", name, source };
  if (!LICENCE_SENTENCE.test(textOf(html))) return { skipped: "the post does not say it is released under CC BY 4.0", name, source };
  if (OTHER_LICENCE.test(html)) return { skipped: "the post links to another Creative Commons licence", name, source };
  const mix = mainMixOf(mp3LinksOf(html));
  if (!mix) return { skipped: "the post has no MP3 link", name, source };
  // The one post without a credit line of its own gets the form the others use.
  const credit = creditOf(html) || `'${name}' by ${ARTIST} - released under CC-BY 4.0. www.scottbuckley.com.au`;
  return { track: { id, name: name.slice(0, 80), artist: ARTIST, licence: LICENCE, source, credit, original: mix.address, fits: [] } };
};

// Every post → what to import and what was left out. Tracks already on the
// hub (by their source page, or because a post for that page already exists)
// are left out as "already there"; an ID another track holds gets the
// composer's name on its end, since an ID is for ever.
export const planImport = (posts, { listedSources = new Set(), takenIds = new Set() } = {}) => {
  const tracks = [];
  const skipped = [];
  const ids = new Set(takenIds);
  for (const post of posts) {
    const read = readPost(post);
    if (read.skipped) { skipped.push(read); continue; }
    const { track } = read;
    if (listedSources.has(track.source)) { skipped.push({ skipped: "already on the hub", name: track.name, source: track.source }); continue; }
    if (ids.has(track.id)) track.id = `${track.id.slice(0, 50)}-scott-buckley`;
    if (ids.has(track.id)) { skipped.push({ skipped: `its ID ${track.id} is taken`, name: track.name, source: track.source }); continue; }
    ids.add(track.id);
    tracks.push(track);
  }
  return { tracks, skipped };
};
