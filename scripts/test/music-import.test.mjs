// Run: node --test scripts/test/music-import.test.mjs
//
// The tool that posts a composer's library (scripts/import-scott-buckley.mjs):
// what it reads from the composer's posts, what it leaves out, and that the
// post it writes is one the music workflow reads as if the form had made it.

import test from "node:test";
import assert from "node:assert/strict";

import { checkForm, parseForm } from "../music/form.mjs";
import { emptyList } from "../music/music.mjs";
import { creditOf, decodeEntities, idOf, mainMixOf, mp3LinksOf, planImport, readPost } from "../music/importers/scott-buckley.mjs";
import { postBodyOf, postTitleOf } from "../music/post-body.mjs";

// A post shaped as the library's posts list gives them (the wording is made up).
const LICENCE = `<p><a rel="license" href="http://creativecommons.org/licenses/by/4.0/"><img alt="Creative Commons License" src="https://i.creativecommons.org/l/by/4.0/88x31.png" /></a><br />This work is licensed under a <a rel="license" href="http://creativecommons.org/licenses/by/4.0/">Creative Commons Attribution 4.0 International License</a>; meaning it&#8217;s free for use in any project as long as I&#8217;m credited.</p>`;
const post = ({ slug, title, links, credit = undefined, licence = LICENCE }) => ({
  id: 1,
  slug,
  link: `https://www.scottbuckley.com.au/library/${slug}/`,
  title: { rendered: title },
  content: {
    rendered: `<p>A piece for strings.</p>${links.map(([file, label]) => `<p><a class="button" href="https://www.scottbuckley.com.au/library/wp-content/uploads/2026/01/${file}">Download ${label}</a></p>`).join("")}${licence}`
      + (credit === null ? "" : `<p>Attribution format:<br />${credit ?? `&#8216;${title}&#8217; by Scott Buckley &#8211; released under CC-BY 4.0. www.scottbuckley.com.au`}</p>`),
  },
});

test("a post is read for its name, its page, its file and the credit it asks for", () => {
  const { track } = readPost(post({ slug: "katabasis-ii", title: "The Weight of Air &#8211; Katabasis II", links: [["Katabasis_II.mp3", "MP3 (Full Mix)"]], credit: "'Katabasis_II' by Scott Buckley - released under CC-BY 4.0. www.scottbuckley.com.au" }));
  assert.deepEqual(track, {
    id: "katabasis-ii",
    name: "The Weight of Air – Katabasis II",
    artist: "Scott Buckley",
    licence: "CC BY 4.0",
    source: "https://www.scottbuckley.com.au/library/katabasis-ii/",
    // The composer's own wording, as it is.
    credit: "'Katabasis_II' by Scott Buckley - released under CC-BY 4.0. www.scottbuckley.com.au",
    original: "https://www.scottbuckley.com.au/library/wp-content/uploads/2026/01/Katabasis_II.mp3",
    fits: [],
  });
  assert.equal(decodeEntities("it&#8217;s &amp; &#x2014; &ndash;"), "it’s & — –");
  assert.equal(idOf("Light_in Dark--Places"), "light-in-dark-places");
});

test("of several mixes the full one is taken, wherever it stands", () => {
  const html = post({ slug: "icarus", title: "Icarus", links: [["icarus_nochoir.mp3", "No Choir Mix"], ["icarus.mp3", "MP3 (Full Mix)"], ["icarus_piano.mp3", "Piano Only"]] }).content.rendered;
  const links = mp3LinksOf(html);
  assert.deepEqual(links.map((link) => link.label), ["Download No Choir Mix", "Download MP3 (Full Mix)", "Download Piano Only"]);
  // (The site's own links say "MP3 (Full Mix)" or "MP3" with nothing before.)
  const plain = [{ address: "a", label: "No Choir Mix" }, { address: "b", label: "MP3 (Full Mix)" }];
  assert.equal(mainMixOf(plain).address, "b");
  assert.equal(mainMixOf([{ address: "a", label: "2010 Mix" }, { address: "b", label: "MP3" }]).address, "b");
  assert.equal(mainMixOf([{ address: "a", label: "2010 Mix" }]).address, "a", "with no full mix, the first");
  assert.equal(mainMixOf([]), null);
});

test("a post that does not say CC BY 4.0, or says another licence, is left out; one with no credit line gets the usual form", () => {
  const silent = readPost(post({ slug: "x", title: "X", links: [["x.mp3", "MP3"]], licence: "<p>All rights reserved.</p>" }));
  assert.match(silent.skipped, /does not say it is released under CC BY 4\.0/);
  const other = readPost(post({ slug: "y", title: "Y", links: [["y.mp3", "MP3"]], licence: `${LICENCE}<a href="https://creativecommons.org/licenses/by-nc/4.0/">non-commercial</a>` }));
  assert.match(other.skipped, /another Creative Commons licence/);
  const noFile = readPost(post({ slug: "z", title: "Z", links: [] }));
  assert.match(noFile.skipped, /no MP3 link/);
  const elsewhere = readPost({ ...post({ slug: "w", title: "W", links: [["w.mp3", "MP3"]] }), link: "https://example.org/w/" });
  assert.match(elsewhere.skipped, /not a library post/);
  const uncredited = readPost(post({ slug: "latin-dish-pigs", title: "Latin Dish Pigs", links: [["ldp.mp3", "MP3"]], credit: null }));
  assert.equal(uncredited.track.credit, "'Latin Dish Pigs' by Scott Buckley - released under CC-BY 4.0. www.scottbuckley.com.au");
  assert.equal(creditOf("<p>Attribution format: somebody else entirely</p>"), "", "a line that is not his credit is not used");
});

test("what is already on the hub is not posted again, and an ID that is taken is never reused", () => {
  const posts = [
    post({ slug: "passage-of-time", title: "Passage of Time", links: [["sb_passageoftime.mp3", "MP3 (Full Mix)"]] }),
    post({ slug: "legionnaire", title: "Legionnaire", links: [["sb_legionnaire.mp3", "MP3"]] }),
    post({ slug: "neon", title: "Neon", links: [["neon.mp3", "MP3"]] }),
  ];
  const plan = planImport(posts, {
    listedSources: new Set(["https://www.scottbuckley.com.au/library/passage-of-time/"]),
    // The remaster was posted by hand under the ID the original's page would have had.
    takenIds: new Set(["passage-of-time", "legionnaire"]),
  });
  assert.deepEqual(plan.tracks.map((track) => track.id), ["legionnaire-scott-buckley", "neon"]);
  assert.deepEqual(plan.skipped.map((entry) => entry.skipped), ["already on the hub"]);
  // Two posts of the library can never land on one ID either.
  const twice = planImport([posts[2], { ...posts[2], link: "https://www.scottbuckley.com.au/library/neon-2/" }]);
  assert.deepEqual(twice.tracks.map((track) => track.id), ["neon", "neon-scott-buckley"]);
});

test("the post the tool writes is read by the workflow as a form post with nothing to fix", () => {
  const { track } = readPost(post({ slug: "katabasis-ii", title: "The Weight of Air &#8211; Katabasis II", links: [["Katabasis_II.mp3", "MP3 (Full Mix)"]] }));
  const body = postBodyOf({ ...track, download: "https://github.com/Open-Historia/Open-historia-scenarios/releases/download/music-inbox/katabasis-ii.mp3", fits: ["game", "battle"], notes: "From the composer's library." });
  assert.equal(postTitleOf(track), "[Music] The Weight of Air – Katabasis II");
  const form = parseForm(body);
  const checked = checkForm(form, emptyList());
  assert.deepEqual(checked.problems, []);
  assert.equal(checked.id, "katabasis-ii");
  assert.deepEqual(checked.details, {
    name: "The Weight of Air – Katabasis II",
    artist: "Scott Buckley",
    licence: "CC BY 4.0",
    source: "https://www.scottbuckley.com.au/library/katabasis-ii/",
    credit: track.credit,
    fits: ["game", "battle"],
  });
  assert.equal(form.download, "https://github.com/Open-Historia/Open-historia-scenarios/releases/download/music-inbox/katabasis-ii.mp3");
  assert.throws(() => postBodyOf({ ...track, licence: "All rights reserved" }), /not a licence a tool may post under/);
});
