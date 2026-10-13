import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createClient, dryRunOf } from "../detailed-maps/github.mjs";
import { PROBLEM_LABEL, PassingError, STATE_FILE, downloadMap } from "../detailed-maps/maps.mjs";
import { MAX_TRACK_BYTES, inspectAudio } from "../music/audio.mjs";
import { checkForm, parseForm } from "../music/form.mjs";
import { ALLOWED_ASSOCIATIONS, DATA_BRANCH, FITS, LABEL, LICENCES, LIST_FILE, PAGE_FILE, downloadTrack, emptyList, findTrack, mayPostMusic } from "../music/music.mjs";
import { MARKER, syncMusic } from "../music/sync.mjs";
import { sha256 } from "../lib/util.mjs";
import { REPO, fakeDownloads, fakeGitHub as fakePosts } from "./fake-github.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "music-test-"));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

// ---- sound files, made here ---------------------------------------------------

// An MP3 in structure only (its sound would not decode): an ID3 tag, then
// frames of MPEG-1 Layer III at 128 kbit/s and 44.1 kHz, which are 417 bytes
// each. `counted` writes an "Info" header into the first frame saying the
// track has that many frames; `fill` makes one file differ from another.
const mp3 = ({ frames = 3, id3 = true, counted = 0, fill = 0 } = {}) => {
  const frame = (first) => {
    const bytes = Buffer.alloc(417, fill);
    bytes.set([0xff, 0xfb, 0x90, 0x00]);
    if (first && counted) {
      bytes.write("Info", 36, "latin1");
      bytes.writeUInt32BE(1, 40);
      bytes.writeUInt32BE(counted, 44);
    }
    return bytes;
  };
  const tag = id3 ? Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 20]), Buffer.alloc(20)]) : Buffer.alloc(0);
  return Buffer.concat([tag, ...Array.from({ length: frames }, (_, index) => frame(index === 0))]);
};

// An Ogg file in structure only: a first page holding the header that says
// what the sound is, and a last page whose position says how long it runs.
const oggPage = ({ flags, position, sequence, packet, serial = 0x1234 }) => {
  const header = Buffer.alloc(27);
  header.write("OggS", 0, "latin1");
  header[5] = flags;
  header.writeBigInt64LE(BigInt(position), 6);
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(sequence, 18);
  header[26] = 1;
  return Buffer.concat([header, Buffer.from([packet.length]), packet]);
};
const vorbisHead = (rate = 44100) => {
  const packet = Buffer.alloc(30);
  packet[0] = 1;
  packet.write("vorbis", 1, "latin1");
  packet[11] = 2;
  packet.writeUInt32LE(rate, 12);
  packet[29] = 1;
  return packet;
};
const opusHead = (skipped = 312) => {
  const packet = Buffer.alloc(19);
  packet.write("OpusHead", 0, "latin1");
  packet[8] = 1;
  packet[9] = 2;
  packet.writeUInt16LE(skipped, 10);
  packet.writeUInt32LE(44100, 12);
  return packet;
};
const ogg = ({ head = vorbisHead(), position = 44100 * 90 } = {}) => Buffer.concat([
  oggPage({ flags: 2, position: 0, sequence: 0, packet: head }),
  oggPage({ flags: 4, position, sequence: 1, packet: Buffer.from("SOUND") }),
]);

const saved = (name, bytes) => {
  const file = path.join(temp, name);
  fs.writeFileSync(file, bytes);
  return file;
};

// ---- posts ----------------------------------------------------------------------

const CREDIT = "'Passage Of Time' by Scott Buckley - released under CC-BY 4.0. www.scottbuckley.com.au";
const SOURCE = "https://www.scottbuckley.com.au/library/passage-of-time/";
const CONFIRMATION = "I have checked that this track's licence allows the hub to share it and games to play it, and that the credit line above is the one it asks for.";

// A post as GitHub writes one made with the form.
const body = ({ name = "Passage Of Time", id = "", artist = "Scott Buckley", licence = "CC BY 4.0", source = SOURCE, credit = CREDIT, link = "https://example.com/passage.mp3", fits = ["The menu", "A game loading"], confirmed = true } = {}) => [
  "### Track name", "", name, "",
  "### Track ID", "", id || "_No response_", "",
  "### Composer / artist", "", artist, "",
  "### Licence", "", licence, "",
  "### Source", "", source, "",
  "### Credit line", "", credit, "",
  "### Download link to the audio file", "", link, "",
  "### Fits", "", ...[...FITS.keys()].map((label) => `- [${fits.includes(label) ? "X" : " "}] ${label}`), "",
  "### Notes", "", "_No response_", "",
  "### Before you post", "", `- [${confirmed ? "X" : " "}] ${CONFIRMATION}`,
].join("\n");

// GitHub, in memory (fake-github.mjs), listing the music posts. `post` adds
// one by a contributor, unless it says who else wrote it.
const fakeGitHub = () => {
  const github = fakePosts({ label: LABEL, listFile: LIST_FILE, stateFile: STATE_FILE });
  const post = (number, text, { user = "Arkniem", association = "OWNER", ...extra } = {}) => github.addPost(number, text, user, { author_association: association, ...extra });
  return { ...github, post };
};
const NOON = new Date("2026-10-13T12:00:00.000Z");
const runner = (github, download, options = {}) => () => syncMusic({ client: github.client, workDir: path.join(temp, "work"), download, now: () => NOON, log: () => {}, ...options });
const statusOf = (github, number) => (github.comments.get(number) ?? []).find((comment) => comment.body.startsWith(MARKER))?.body ?? "";
const labelled = (github, number, name) => github.posts.find((post) => post.number === number).labels.some((label) => label.name === name);
const filesIn = (github) => github.releases.flatMap((release) => release.assets.map((asset) => `${release.tag}/${asset.name}`)).sort();

// ---- the gate -------------------------------------------------------------------

test("who may post music is what GitHub says the author is to the repository, and nothing else", () => {
  assert.deepEqual([...ALLOWED_ASSOCIATIONS], ["OWNER", "MEMBER", "COLLABORATOR"]);
  for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) assert.equal(mayPostMusic({ author_association: association }), true, association);
  for (const association of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "MANNEQUIN", "NONE", "owner", "", null, undefined]) {
    assert.equal(mayPostMusic({ author_association: association }), false, String(association));
  }
  assert.equal(mayPostMusic({}), false);
  assert.equal(mayPostMusic(null), false);
  // What the post says of itself is not asked.
  assert.equal(mayPostMusic({ title: "[Music] OWNER", body: "author_association: OWNER", user: { login: "OWNER" }, author_association: "NONE" }), false);
});

test("a contributor's post is published, whichever kind of contributor; anyone else's is turned away", async () => {
  const file = saved("gate.mp3", mp3());
  for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    const github = fakeGitHub();
    const { download, calls } = fakeDownloads({ "https://example.com/passage.mp3": file });
    github.post(1, body(), { association });
    const summary = await runner(github, download)();
    assert.equal(summary.released, 1, association);
    assert.equal(summary.turnedAway, 0, association);
    assert.equal(calls.length, 1, association);
    assert.equal(github.list().tracks.length, 1, association);
  }
  // (The last is a post GitHub says nothing of at all.)
  for (const association of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "MANNEQUIN", "NONE", null, undefined]) {
    const github = fakeGitHub();
    const { download, calls } = fakeDownloads({ "https://example.com/passage.mp3": file });
    github.addPost(1, body(), "someone", association === undefined ? {} : { author_association: association });
    const summary = await runner(github, download)();
    assert.equal(summary.turnedAway, 1, String(association));
    assert.equal(summary.released, 0, String(association));
    assert.equal(calls.length, 0, String(association));
    assert.equal(github.posts[0].state_reason, "not_planned", String(association));
  }
});

test("an outsider's post gets one comment and the label, is closed as not planned, and nothing of it is downloaded", async () => {
  const github = fakeGitHub();
  const { download, calls } = fakeDownloads({ "https://example.com/passage.mp3": saved("outsider.mp3", mp3()) });
  const inspected = [];
  const run = runner(github, download, { inspect: async (file) => inspected.push(file) });
  // The post says it is the owner's, everywhere a post can say anything.
  github.post(31, `${body()}\n\nauthor_association: OWNER\n<!-- author_association: "OWNER" -->`, { user: "OWNER", association: "NONE", title: "[Music] OWNER MEMBER COLLABORATOR" });

  const summary = await run();
  assert.deepEqual(summary, { posts: 1, released: 0, details: 0, problem: 0, waiting: 0, turnedAway: 1, removed: 0, unchanged: 0 });
  const comments = github.comments.get(31);
  assert.equal(comments.length, 1);
  assert.ok(comments[0].body.startsWith("<!-- hub-music -->\n"));
  assert.match(comments[0].body, /can only be posted by the hub's contributors/);
  assert.match(comments[0].body, /for copyright reasons/);
  assert.match(comments[0].body, /To propose a track\*\*, ask on \[Discord\]\(https:\/\/discord\.gg\//);
  assert.ok(labelled(github, 31, "needs changes"));
  assert.equal(PROBLEM_LABEL, "needs changes");
  assert.equal(github.posts[0].state, "closed");
  assert.equal(github.posts[0].state_reason, "not_planned");

  // Nothing downloaded, looked into, released or written to the list's branch.
  assert.deepEqual(calls, []);
  assert.deepEqual(inspected, []);
  assert.deepEqual(github.releases, []);
  assert.deepEqual(github.data, {});
  assert.deepEqual(github.commits, []);

  // Later runs leave it alone.
  assert.equal((await run()).unchanged, 1);
  assert.equal(github.comments.get(31).length, 1);

  // Reopened by a maintainer, or edited: it is still not a contributor's, and
  // is closed again without a second comment.
  github.editPost(31, { state: "open", state_reason: null, body: body({ name: "Another go" }) });
  assert.equal((await run()).turnedAway, 1);
  assert.equal(github.posts[0].state_reason, "not_planned");
  assert.equal(github.comments.get(31).length, 1);
  assert.deepEqual(calls, []);

  // Closed some other way before the run got to it: turned away all the same.
  github.post(32, body(), { user: "someone", association: "CONTRIBUTOR", state: "closed", state_reason: "completed" });
  assert.equal((await run()).turnedAway, 1);
  assert.equal(github.posts[1].state_reason, "not_planned");
  assert.equal(github.comments.get(32).length, 1);
  assert.deepEqual(calls, []);
});

test("a post turned away is read once its author is a contributor and reopens it", async () => {
  const github = fakeGitHub();
  const { download } = fakeDownloads({ "https://example.com/passage.mp3": saved("later.mp3", mp3()) });
  const run = runner(github, download);
  github.post(33, body(), { user: "newcomer", association: "NONE" });
  assert.equal((await run()).turnedAway, 1);
  github.editPost(33, { author_association: "COLLABORATOR", state: "open", state_reason: null });
  assert.equal((await run()).released, 1);
  assert.equal(github.list().tracks[0].postedBy, "newcomer");
  assert.ok(!labelled(github, 33, PROBLEM_LABEL));
  assert.match(statusOf(github, 33), /This track is on the music list/);
});

test("a track stays on the list when its author stops being a contributor, and that post's edits are not read", async () => {
  const github = fakeGitHub();
  const { download, calls } = fakeDownloads({ "https://example.com/passage.mp3": saved("held.mp3", mp3()), "https://example.com/other.mp3": saved("held-2.mp3", mp3({ fill: 5 })) });
  const run = runner(github, download);
  github.post(34, body(), { user: "member", association: "MEMBER" });
  await run();
  github.editPost(34, { author_association: "NONE" });
  assert.equal((await run()).unchanged, 1);
  assert.equal(github.posts[0].state, "open");
  assert.match(statusOf(github, 34), /on the music list/);

  github.editPost(34, { body: body({ name: "Renamed", link: "https://example.com/other.mp3" }) });
  await run();
  await run();
  assert.equal(calls.length, 1);
  assert.equal(github.posts[0].state, "open");
  assert.equal(github.list().tracks[0].name, "Passage Of Time");
  assert.equal(github.list().tracks[0].removed, false);
  assert.match(statusOf(github, 34), /last edit was not read[\s\S]*`passage-of-time` stays on the music list/);
  assert.equal(github.comments.get(34).length, 1);

  // Taking it down still works: that is only ever less music on the hub.
  github.editPost(34, { state: "closed", state_reason: "not_planned" });
  assert.equal((await run()).removed, 1);
  assert.equal(github.list().tracks[0].removed, true);
});

// ---- the bytes ------------------------------------------------------------------

test("an MP3 is told by its frames, and its length by its frame count or its bitrate", async () => {
  // 10,000 frames of 1,152 samples at 44,100 a second.
  assert.deepEqual(await inspectAudio(saved("counted.mp3", mp3({ counted: 10000 }))), { type: "mp3", seconds: 261 });
  // No count: 100 frames of 417 bytes at 128,000 bits a second.
  assert.deepEqual(await inspectAudio(saved("plain.mp3", mp3({ frames: 100, id3: false }))), { type: "mp3", seconds: 3 });
  // An old-style tag at the end is not sound.
  const tagged = Buffer.concat([mp3({ frames: 100, id3: false }), Buffer.from("TAG"), Buffer.alloc(125)]);
  assert.deepEqual(await inspectAudio(saved("tagged.mp3", tagged)), { type: "mp3", seconds: 3 });
  // A few bytes that are no frame in front of the first one.
  assert.equal((await inspectAudio(saved("lead-in.mp3", Buffer.concat([Buffer.alloc(300), mp3({ id3: false })])))).type, "mp3");

  // One frame's header and nothing where the next should be: any file can have four such bytes.
  const lone = Buffer.concat([mp3({ frames: 1, id3: false }), Buffer.alloc(900, 0x41)]);
  await assert.rejects(inspectAudio(saved("lone.mp3", lone)), /not an MP3 or an Ogg/);
  // A second header of another kind (48 kHz after 44.1 kHz) is not the same sound going on.
  const mixed = mp3({ frames: 2, id3: false });
  mixed[417 + 2] = 0x94;
  await assert.rejects(inspectAudio(saved("mixed.mp3", mixed)), /not an MP3 or an Ogg/);
  // An ID3 tag with no sound after it.
  await assert.rejects(inspectAudio(saved("tag-only.mp3", mp3({ frames: 0 }))), /not an MP3 or an Ogg/);
  // Layer II is MPEG sound, but not an MP3.
  const layer2 = mp3({ id3: false });
  for (const at of [1, 417 + 1, 834 + 1]) layer2[at] = 0xfd;
  await assert.rejects(inspectAudio(saved("layer2.mp3", layer2)), /not an MP3 or an Ogg/);
});

test("an Ogg file is told by its first page, and has to hold Vorbis or Opus", async () => {
  assert.deepEqual(await inspectAudio(saved("vorbis.ogg", ogg())), { type: "ogg", seconds: 90 });
  // Opus counts at 48,000 a second, after the samples it skips at the start.
  assert.deepEqual(await inspectAudio(saved("opus.ogg", ogg({ head: opusHead(312), position: 48000 * 60 + 312 }))), { type: "ogg", seconds: 60 });
  // A last page with no position of its own: the length is not known, and the file is still sound.
  assert.deepEqual(await inspectAudio(saved("open.ogg", ogg({ position: -1 }))), { type: "ogg", seconds: null });
  const video = Buffer.alloc(42);
  video[0] = 0x80;
  video.write("theora", 1, "latin1");
  await assert.rejects(inspectAudio(saved("video.ogg", ogg({ head: video }))), /an Ogg file, but the sound in it is neither Vorbis nor Opus/);
  await assert.rejects(inspectAudio(saved("cut.ogg", ogg().subarray(0, 40))), /first page is damaged/);
  const noRate = vorbisHead(0);
  await assert.rejects(inspectAudio(saved("no-rate.ogg", ogg({ head: noRate }))), /first page is damaged/);
});

test("a file renamed to .mp3 or .ogg is refused, and so is one over 20 MB", async () => {
  const text = Buffer.from("This is not music.\nIt is a text file somebody renamed.\n".repeat(200));
  await assert.rejects(inspectAudio(saved("renamed.mp3", text)), /The file is not an MP3 or an Ogg \(Vorbis or Opus\) file\. It is told by what is in it, not by its name/);
  await assert.rejects(inspectAudio(saved("renamed.ogg", text)), /not an MP3 or an Ogg/);
  await assert.rejects(inspectAudio(saved("page.mp3", Buffer.from("<!DOCTYPE html><html><body>Not Found</body></html>"))), /not an MP3 or an Ogg/);
  await assert.rejects(inspectAudio(saved("empty.mp3", Buffer.alloc(0))), /not an MP3 or an Ogg/);
  const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(64)]);
  await assert.rejects(inspectAudio(saved("really-a-wav.mp3", wav)), /\(it is a WAV file\)/);
  await assert.rejects(inspectAudio(saved("really-flac.ogg", Buffer.concat([Buffer.from("fLaC"), Buffer.alloc(64)]))), /\(it is a FLAC file\)/);

  assert.equal(MAX_TRACK_BYTES, 20 * 1024 * 1024);
  // Exactly 20 MB is allowed; real frames at its start, so it is an MP3.
  const full = Buffer.alloc(MAX_TRACK_BYTES);
  mp3({ id3: false }).copy(full);
  assert.equal((await inspectAudio(saved("full.mp3", full))).type, "mp3");
  const over = Buffer.alloc(21 * 1024 * 1024);
  mp3({ id3: false }).copy(over);
  await assert.rejects(inspectAudio(saved("over.mp3", over)), /The file is 21\.0 MB; a track can be 20 MB at most\./);
});

// ---- the download ---------------------------------------------------------------

// The web, in memory: a page for each address, and a note of every address asked for.
const fakeWeb = (pages) => {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    const page = pages[String(url)];
    return page ? page() : new Response("", { status: 404 });
  };
  // Names are public unless `pages` says where one leads.
  const lookup = async (host) => [{ address: pages[`dns:${host}`] ?? "93.184.216.34", family: 4 }];
  return { asked, options: { fetchImpl, lookup } };
};

test("a track is downloaded over https from a public address only, and never past 20 MB", async () => {
  const sound = mp3();
  const dest = path.join(temp, "downloaded.audio");
  const web = fakeWeb({
    "https://example.com/a.mp3": () => new Response(sound),
    "https://example.com/moved": () => new Response(null, { status: 302, headers: { location: "https://cdn.example.com/a.mp3" } }),
    "https://cdn.example.com/a.mp3": () => new Response(sound),
    "https://example.com/inward": () => new Response(null, { status: 302, headers: { location: "https://192.168.1.10/a.mp3" } }),
    "https://example.com/downgrade": () => new Response(null, { status: 302, headers: { location: "http://example.com/a.mp3" } }),
    "https://example.com/big.mp3": () => new Response("x", { headers: { "content-length": String(21 * 1024 * 1024) } }),
    "https://example.com/endless.mp3": () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_TRACK_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    })),
    "https://example.com/page": () => new Response("<html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
    "https://example.com/unwell": () => new Response("", { status: 503 }),
    "dns:intranet.example.com": "10.20.30.40",
  });
  const get = (link) => downloadTrack(link, dest, web.options);

  assert.equal(await get("https://example.com/a.mp3"), sound.length);
  assert.ok(fs.readFileSync(dest).equals(sound));
  assert.equal(await get("https://example.com/moved"), sound.length);

  await assert.rejects(get("http://example.com/a.mp3"), /must start with https:\/\//);
  await assert.rejects(get("ftp://example.com/a.mp3"), /must start with https:\/\//);
  await assert.rejects(get("file:///etc/passwd"), /must start with https:\/\//);
  await assert.rejects(get("not a link"), /isn't a web address/);
  await assert.rejects(get("https://example.com/downgrade"), /must start with https:\/\//);

  web.asked.length = 0;
  for (const link of [
    "https://localhost/a.mp3", "https://127.0.0.1/a.mp3", "https://10.1.2.3/a.mp3", "https://172.16.0.9/a.mp3", "https://192.168.0.5/a.mp3",
    "https://169.254.169.254/latest/meta-data", "https://100.64.0.1/a.mp3", "https://0.0.0.0/a.mp3", "https://2130706433/a.mp3",
    "https://[::1]/a.mp3", "https://[fd00::1]/a.mp3", "https://[fe80::1]/a.mp3", "https://[::ffff:10.0.0.1]/a.mp3",
    "https://printer.local/a.mp3", "https://intranet.example.com/a.mp3",
  ]) {
    await assert.rejects(get(link), /leads to a private or local address/, link);
  }
  // Refused before anything was asked of them.
  assert.deepEqual(web.asked, []);
  // A public link that sends the download inward is refused where it turns.
  await assert.rejects(get("https://example.com/inward"), /private or local address/);
  assert.deepEqual(web.asked, ["https://example.com/inward"]);
  // A public address beside a private range is not caught with it.
  assert.equal(await downloadTrack("https://192.0.78.9/a.mp3", dest, { ...web.options, fetchImpl: async () => new Response(sound) }), sound.length);

  await assert.rejects(get("https://example.com/big.mp3"), /The file is 21\.0 MB; a track can be 20 MB at most\./);
  await assert.rejects(get("https://example.com/endless.mp3"), (error) => !(error instanceof PassingError) && /The file is over 20 MB; a track can be 20 MB at most\./.test(error.message));
  assert.equal(fs.existsSync(dest), false);
  await assert.rejects(get("https://example.com/page"), /opens a web page, not the file itself/);
  await assert.rejects(get("https://example.com/gone.mp3"), /answered HTTP 404/);
  await assert.rejects(get("https://example.com/unwell"), (error) => error instanceof PassingError && /HTTP 503/.test(error.message));

  // The detailed maps' download is the same one, with a map's limit and words.
  const maps = fakeWeb({ "https://example.com/huge.pmtiles": () => new Response("x", { headers: { "content-length": String(600 * 1024 * 1024) } }) });
  await assert.rejects(downloadMap("https://example.com/huge.pmtiles", dest, maps.options), /The file is 600 MB; the game downloads at most 500 MB\./);
  await assert.rejects(downloadMap("https://127.0.0.1/a.pmtiles", dest, maps.options), /private or local address/);
});

// ---- the form -------------------------------------------------------------------

test("the form: its answers, the licence's short name, where a track fits, and what is missing", () => {
  const list = emptyList();
  const read = (options) => checkForm(parseForm(body(options)), list);
  const { id, details, problems } = read();
  assert.deepEqual(problems, []);
  assert.equal(id, "passage-of-time");
  assert.deepEqual(details, { name: "Passage Of Time", artist: "Scott Buckley", licence: "CC BY 4.0", source: SOURCE, credit: CREDIT, fits: ["menu", "loading"] });

  // Each licence of the dropdown, and nothing that is not in it.
  assert.deepEqual([...LICENCES.keys()].map((licence) => read({ licence }).details.licence), ["CC0 1.0", "CC BY 4.0", "CC BY-SA 4.0", "Public domain", "CC BY 4.0", "CC0 1.0", "Other free licence"]);
  assert.match(read({ licence: "All rights reserved" }).problems.join(" "), /Choose the track's licence from the form's list/);
  assert.match(read({ licence: "None" }).problems.join(" "), /Choose the track's licence/);

  // Where it fits: in the list's order, whatever order the boxes were ticked in, and [] for none.
  assert.deepEqual(read({ fits: ["In the war room", "At war", "In the game", "A game loading", "The menu"] }).details.fits, ["menu", "loading", "game", "atWar", "battle"]);
  assert.deepEqual(read({ fits: ["At war"] }).details.fits, ["atWar"]);
  assert.deepEqual(read({ fits: [] }).details.fits, []);
  assert.deepEqual(read({ fits: [] }).problems, []);

  assert.match(read({ name: "_No response_" }).problems.join(" "), /The track needs a name/);
  assert.match(read({ artist: "_No response_" }).problems.join(" "), /Say who composed or performs the track/);
  assert.match(read({ credit: "_No response_" }).problems.join(" "), /Give the credit to show for the track/);
  assert.match(read({ confirmed: false }).problems.join(" "), /Tick the box under \*\*Before you post\*\*/);
  for (const source of ["_No response_", "Scott Buckley's website", "ftp://example.com/track", "javascript:alert(1)", "www.scottbuckley.com.au"]) {
    assert.match(read({ source }).problems.join(" "), /Under \*\*Source\*\*, give the page/, source);
  }
  assert.equal(read({ source: "http://example.com/track" }).details.source, "http://example.com/track");
  assert.equal(read({ source: "[the page](https://example.com/my_track)" }).details.source, "https://example.com/my_track");
  for (const link of ["_No response_", "http://example.com/a.mp3", "example.com/a.mp3"]) {
    assert.match(read({ link }).problems.join(" "), /The download link must start with https:\/\//, link);
  }
  assert.equal(parseForm(body({ link: "[file](https://example.com/my_track.mp3)" })).download, "https://example.com/my_track.mp3");
  // A credit line is kept as it was written, on one line.
  assert.equal(read({ credit: "Music by Kevin_M\n(https://example.com/kevin_m)  CC BY 4.0" }).details.credit, "Music by Kevin_M (https://example.com/kevin_m) CC BY 4.0");

  // The ID: asked for, or made from the name; never one that is taken, or was.
  assert.equal(read({ id: "PoT-1" }).id, "pot-1");
  assert.match(read({ id: "not ok!" }).problems.join(" "), /can't be a track ID/);
  assert.match(read({ name: "!!!" }).problems.join(" "), /can't be a track ID/);
  list.tracks.push({ id: "taken", name: "Taken", post: 3, removed: false }, { id: "gone", name: "Gone", post: 4, removed: true });
  assert.match(read({ id: "taken" }).problems.join(" "), /already the ID of another track \(#3\)/);
  assert.match(read({ id: "gone" }).problems.join(" "), /Track IDs are never used again/);
  assert.match(checkForm(parseForm(body({ id: "other" })), list, { ownId: "taken" }).problems.join(" "), /a track's ID never changes/);
  assert.deepEqual(checkForm(parseForm(body({ id: "taken" })), list, { ownId: "taken" }).problems, []);
  assert.deepEqual(checkForm(parseForm(body()), list, { ownId: "taken" }).id, "taken");
});

test("the form on GitHub offers what the checks read: the same headings, licences and boxes", () => {
  const form = fs.readFileSync(fileURLToPath(new URL("../../.github/ISSUE_TEMPLATE/music.yml", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
  assert.match(form, /^name: Share background music$/m);
  assert.match(form, /^title: "\[Music\] "$/m);
  assert.match(form, /^labels: \["music"\]$/m);
  for (const heading of ["Track name", "Track ID", "Composer / artist", "Licence", "Source", "Credit line", "Download link to the audio file", "Fits", "Notes", "Before you post"]) {
    assert.match(form, new RegExp(`^      label: ${heading}$`, "m"), heading);
  }
  const options = [...form.matchAll(/^        - "(.*)"$/gm)].map((match) => match[1]);
  assert.deepEqual(options, [...LICENCES.keys()]);
  const boxes = [...form.matchAll(/^        - label: "?(.*?)"?$/gm)].map((match) => match[1]);
  assert.deepEqual(boxes, [...FITS.keys(), CONFIRMATION]);
});

// ---- publishing -----------------------------------------------------------------

test("the list the game reads has exactly this shape", async () => {
  const github = fakeGitHub();
  const sound = mp3({ counted: 10374 });
  const digest = sha256(sound);
  const { download } = fakeDownloads({ "https://example.com/passage.mp3": saved("contract.mp3", sound), "https://example.com/zebra.ogg": saved("zebra.ogg", ogg()), "https://example.com/alpha.mp3": saved("alpha.mp3", mp3({ frames: 100, id3: false, fill: 2 })) });
  const run = runner(github, download);
  github.post(260, body());
  assert.equal((await run()).released, 1);

  const text = github.data[LIST_FILE];
  const list = JSON.parse(text);
  assert.deepEqual(list, {
    schema: "open-historia-music-index/1",
    updated: "2026-10-13T12:00:00.000Z",
    tracks: [{
      id: "passage-of-time",
      name: "Passage Of Time",
      artist: "Scott Buckley",
      licence: "CC BY 4.0",
      source: SOURCE,
      credit: CREDIT,
      fits: ["menu", "loading"],
      version: 1,
      file: `https://github.com/Open-Historia/Open-historia-scenarios/releases/download/music/passage-of-time-v1-${digest.slice(0, 8)}.mp3`,
      type: "mp3",
      bytes: sound.length,
      sha256: digest,
      seconds: 271,
      post: 260,
      postedBy: "Arkniem",
      removed: false,
    }],
  });
  // The order of the fields too, and the way the file is written.
  assert.deepEqual(Object.keys(list), ["schema", "updated", "tracks"]);
  assert.deepEqual(Object.keys(list.tracks[0]), ["id", "name", "artist", "licence", "source", "credit", "fits", "version", "file", "type", "bytes", "sha256", "seconds", "post", "postedBy", "removed"]);
  assert.equal(text, `${JSON.stringify(list, null, 2)}\n`);
  assert.match(digest, /^[0-9a-f]{64}$/);
  // The file is where the list says it is, and is the one that was checked.
  assert.equal(REPO, "Open-Historia/Open-historia-scenarios");
  assert.deepEqual(filesIn(github), [`music/passage-of-time-v1-${digest.slice(0, 8)}.mp3`]);
  assert.ok(github.releases[0].assets[0].bytes.equals(sound));
  assert.equal(github.releases[0].assets[0].url, list.tracks[0].file);

  // Sorted by name, as people read names; an Ogg file is "ogg", and nothing ticked is [].
  github.post(261, body({ name: "Zebra crossing", artist: "Someone Else", licence: "My own work, released under CC0 1.0", link: "https://example.com/zebra.ogg", fits: [] }), { user: "mapmaker", association: "COLLABORATOR" });
  github.post(262, body({ name: "alpha waves", link: "https://example.com/alpha.mp3", fits: ["In the war room"] }), { association: "MEMBER" });
  await run();
  const all = github.list().tracks;
  assert.deepEqual(all.map((track) => track.name), ["alpha waves", "Passage Of Time", "Zebra crossing"]);
  assert.deepEqual(all.map((track) => [track.id, track.type, track.seconds, track.licence, track.fits, track.post, track.postedBy]), [
    ["alpha-waves", "mp3", 3, "CC BY 4.0", ["battle"], 262, "Arkniem"],
    ["passage-of-time", "mp3", 271, "CC BY 4.0", ["menu", "loading"], 260, "Arkniem"],
    ["zebra-crossing", "ogg", 90, "CC0 1.0", [], 261, "mapmaker"],
  ]);
  assert.match(all[2].file, /\/releases\/download\/music\/zebra-crossing-v1-[0-9a-f]{8}\.ogg$/);
  for (const track of all) assert.deepEqual(Object.keys(track), Object.keys(list.tracks[0]));
});

test("the music page credits every track: its composer, licence, source and credit line", async () => {
  const github = fakeGitHub();
  const { download } = fakeDownloads({ "https://example.com/passage.mp3": saved("page.mp3", mp3({ counted: 10374 })) });
  github.post(260, body());
  await runner(github, download)();
  const page = github.data[PAGE_FILE];
  assert.match(page, /^# Background music\n/);
  assert.match(page, /\| \[Passage Of Time\]\(https:\/\/github\.com\/Open-Historia\/Open-historia-scenarios\/issues\/260\) \| `passage-of-time` \| Scott Buckley \| CC BY 4\.0 \| 4:31 \| 0\.0 MB \| The menu, A game loading \|/);
  assert.match(page, /### Passage Of Time \(`passage-of-time`\)\n\n- \*\*Composer \/ artist:\*\* Scott Buckley\n- \*\*Licence:\*\* CC BY 4\.0\n- \*\*Source:\*\* <https:\/\/www\.scottbuckley\.com\.au\/library\/passage-of-time\/>\n- \*\*Credit:\*\*\n\n> 'Passage Of Time' by Scott Buckley - released under CC-BY 4\.0\. www\.scottbuckley\.com\.au\n/);
  assert.match(page, /posted by @Arkniem/);
  // And the post is told where that is.
  assert.match(statusOf(github, 260), /This track is on the music list[\s\S]*blob\/music-index\/MUSIC\.md[\s\S]*\| Track ID \| `passage-of-time` \(it never changes\) \|[\s\S]*\| File \| MP3, 0\.0 MB \(\d+ bytes\), 4:31 long \|/);
});

test("the version goes up when the link leads to a different file, and only then", async () => {
  const github = fakeGitHub();
  const one = mp3({ fill: 1 });
  const two = mp3({ fill: 2, counted: 5000 });
  const { download, calls } = fakeDownloads({
    "https://example.com/v1.mp3": saved("v1.mp3", one),
    "https://example.com/v2.mp3": saved("v2.mp3", two),
    "https://example.com/v2-again.mp3": saved("v2-again.mp3", two),
  });
  const run = runner(github, download);
  const name = (version, bytes) => `music/tune-v${version}-${sha256(bytes).slice(0, 8)}.mp3`;

  github.post(7, body({ id: "tune", link: "https://example.com/v1.mp3" }));
  assert.equal((await run()).released, 1);
  assert.equal(findTrack(github.list(), "tune").version, 1);
  assert.deepEqual(filesIn(github), [name(1, one)]);

  // Nothing changed: nothing downloaded, nothing written.
  const commits = github.commits.length;
  assert.equal((await run()).unchanged, 1);
  assert.equal(calls.length, 1);
  assert.equal(github.commits.length, commits);

  // The words changed, the link didn't: the details change, and nothing is downloaded.
  github.editPost(7, { body: body({ id: "tune", name: "Tune, renamed", artist: "Somebody Else", licence: "CC BY-SA 4.0", source: "https://example.com/tune", credit: "Tune by Somebody Else, CC BY-SA 4.0", fits: ["At war"], link: "https://example.com/v1.mp3" }) });
  assert.equal((await run()).details, 1);
  assert.equal(calls.length, 1);
  let track = findTrack(github.list(), "tune");
  assert.deepEqual([track.name, track.artist, track.licence, track.source, track.credit, track.fits], ["Tune, renamed", "Somebody Else", "CC BY-SA 4.0", "https://example.com/tune", "Tune by Somebody Else, CC BY-SA 4.0", ["atWar"]]);
  assert.deepEqual([track.id, track.version, track.sha256, track.bytes], ["tune", 1, sha256(one), one.length]);
  assert.match(statusOf(github, 7), /changed the details only/);

  // A different file at a new link: version 2, in place of version 1, whose file goes.
  github.editPost(7, { body: body({ link: "https://example.com/v2.mp3" }) });
  assert.equal((await run()).released, 1);
  track = findTrack(github.list(), "tune");
  assert.deepEqual([track.version, track.sha256, track.bytes, track.seconds], [2, sha256(two), two.length, 131]);
  assert.equal(track.file, `https://github.com/${REPO}/releases/download/${name(2, two)}`);
  assert.equal(track.name, "Passage Of Time");
  assert.deepEqual(filesIn(github), [name(2, two)]);
  assert.match(github.comments.get(7).at(-1).body, /^✅ Version 2 of `tune` is on the music list, in place of version 1\.$/);
  assert.equal(github.list().tracks.length, 1);

  // A new link to the same file: no version 3.
  github.editPost(7, { body: body({ link: "https://example.com/v2-again.mp3" }) });
  assert.equal((await run()).details, 1);
  assert.equal(findTrack(github.list(), "tune").version, 2);
  assert.deepEqual(filesIn(github), [name(2, two)]);
  assert.match(statusOf(github, 7), /the same as version 2, so there is no new version/);
});

test("a post with a problem is told exactly what to fix, and labelled until it is fixed", async () => {
  const github = fakeGitHub();
  const { download, calls } = fakeDownloads({
    "https://example.com/notes.mp3": saved("notes.mp3", Buffer.from("just some notes about the track\n".repeat(50))),
    "https://example.com/huge.mp3": saved("huge.mp3", Buffer.concat([mp3({ id3: false }), Buffer.alloc(21 * 1024 * 1024)])),
    "https://example.com/fix.ogg": saved("fix.ogg", ogg()),
  });
  const run = runner(github, download);

  // Answers missing: every one is named, and the link is not followed.
  github.post(9, body({ artist: "_No response_", licence: "None", source: "_No response_", credit: "_No response_", link: "https://example.com/fix.ogg", confirmed: false }));
  assert.equal((await run()).problem, 1);
  const first = statusOf(github, 9);
  assert.match(first, /This post needs changes/);
  assert.deepEqual(first.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2, 30)), [
    "Say who composed or performs", "Choose the track's licence f", "Under **Source**, give the p", "Give the credit to show for ", "Tick the box under **Before ",
  ]);
  assert.deepEqual(calls, []);
  assert.ok(labelled(github, 9, PROBLEM_LABEL));
  assert.equal(github.list().tracks.length, 0);

  // A file that is not sound, whatever it is called.
  github.editPost(9, { body: body({ link: "https://example.com/notes.mp3" }) });
  assert.equal((await run()).problem, 1);
  assert.match(statusOf(github, 9), /needs changes[\s\S]*- The file is not an MP3 or an Ogg \(Vorbis or Opus\) file/);
  // One over the limit.
  github.editPost(9, { body: body({ link: "https://example.com/huge.mp3" }) });
  assert.equal((await run()).problem, 1);
  assert.match(statusOf(github, 9), /- The file is 21\.0 MB; a track can be 20 MB at most\./);
  // A link that leads nowhere.
  github.editPost(9, { body: body({ link: "https://example.com/missing.mp3" }) });
  assert.equal((await run()).problem, 1);
  assert.match(statusOf(github, 9), /- The download link answered HTTP 404/);
  assert.equal(github.comments.get(9).length, 1);
  assert.deepEqual(github.releases, []);

  github.editPost(9, { body: body({ link: "https://example.com/fix.ogg" }) });
  assert.equal((await run()).released, 1);
  assert.ok(!labelled(github, 9, PROBLEM_LABEL));
  assert.match(statusOf(github, 9), /on the music list/);
  // The status comment was edited, which notifies no one, so a new one says so.
  assert.match(github.comments.get(9).at(-1).body, /^✅ `passage-of-time` is on the music list\.$/);

  // A problem in an update leaves the version on the list alone.
  github.editPost(9, { body: body({ link: "https://example.com/notes.mp3", credit: "_No response_" }) });
  assert.equal((await run()).problem, 1);
  assert.match(statusOf(github, 9), /Until then, the list keeps version 1 of this track as it is\./);
  assert.equal(github.list().tracks[0].version, 1);
  assert.equal(github.list().tracks[0].credit, CREDIT);
  assert.equal(filesIn(github).length, 1);
});

test("two posts can't share an ID or a file, and the older one has it", async () => {
  const github = fakeGitHub();
  const { download } = fakeDownloads({ "https://example.com/a.mp3": saved("a.mp3", mp3({ fill: 3 })), "https://example.com/b.mp3": saved("b.mp3", mp3({ fill: 4 })) });
  const run = runner(github, download);
  github.post(1, body({ id: "same", link: "https://example.com/a.mp3" }));
  github.post(2, body({ id: "same", link: "https://example.com/b.mp3" }), { user: "other", association: "MEMBER" });
  const summary = await run();
  assert.equal(summary.released, 1);
  assert.equal(summary.problem, 1);
  assert.equal(findTrack(github.list(), "same").post, 1);
  assert.match(statusOf(github, 2), /already the ID of another track \(#1\)/);

  github.post(3, body({ id: "copy", link: "https://example.com/a.mp3" }), { user: "other", association: "MEMBER" });
  assert.equal((await run()).problem, 1);
  assert.match(statusOf(github, 3), /already on the list as `same` \(#1\)[\s\S]*edit its own post/);
  assert.equal(findTrack(github.list(), "copy"), null);
  assert.equal(filesIn(github).length, 1);
});

test("closing a post as not planned removes its track for good, and its ID is never used again", async () => {
  const github = fakeGitHub();
  const { download } = fakeDownloads({ "https://example.com/passage.mp3": saved("bye.mp3", mp3({ fill: 6 })), "https://example.com/new.mp3": saved("new.mp3", mp3({ fill: 7 })) });
  const run = runner(github, download);
  github.post(4, body({ id: "bye" }));
  await run();
  const before = findTrack(github.list(), "bye");
  assert.equal(filesIn(github).length, 1);

  github.editPost(4, { state: "closed", state_reason: "not_planned" });
  assert.equal((await run()).removed, 1);
  const track = findTrack(github.list(), "bye");
  assert.deepEqual(track, { ...before, file: "", bytes: null, sha256: null, seconds: null, removed: true });
  assert.deepEqual(Object.keys(track), Object.keys(before));
  assert.deepEqual(filesIn(github), []);
  assert.match(statusOf(github, 4), /This track was removed[\s\S]*its file is deleted/);
  assert.match(github.data[PAGE_FILE], /_No music yet\._[\s\S]*## Removed tracks[\s\S]*- `bye` \(Passage Of Time\), removed 2026-10-13/);
  assert.deepEqual(github.state().posts[4].removed, { date: "2026-10-13", reason: "Its post #4 was closed as not planned." });
  assert.equal((await run()).unchanged, 1);

  // Reopened and edited: told once that it can't come back, and nothing is published.
  github.editPost(4, { state: "open", state_reason: null, body: body({ id: "bye", name: "Back again", link: "https://example.com/new.mp3" }) });
  await run();
  await run();
  assert.match(statusOf(github, 4), /a removed track can't come back/);
  assert.equal(github.state().posts[4].toldRemoved, true);
  assert.equal(findTrack(github.list(), "bye").removed, true);
  assert.deepEqual(filesIn(github), []);

  // Nobody else gets the ID either.
  github.post(5, body({ id: "bye", link: "https://example.com/new.mp3" }));
  assert.equal((await run()).problem, 1);
  assert.match(statusOf(github, 5), /Track IDs are never used again/);
  assert.equal(github.list().tracks.length, 1);

  // A post that never had a track is simply closed.
  github.post(6, body({ link: "https://example.com/missing.mp3" }));
  await run();
  github.editPost(6, { state: "closed", state_reason: "not_planned" });
  assert.equal((await run()).removed, 0);
});

test("a download that fails for a passing reason is tried again on the next run, without an edit", async () => {
  const github = fakeGitHub();
  const file = saved("later.ogg", ogg());
  let unwell = true;
  const download = async (link, dest) => {
    if (unwell) throw new PassingError("The download link answered HTTP 503; it is tried again later.");
    fs.copyFileSync(file, dest);
    return fs.statSync(dest).size;
  };
  const run = runner(github, download);
  github.post(8, body({ id: "later" }));
  assert.equal((await run()).waiting, 1);
  assert.match(statusOf(github, 8), /couldn't be checked just now[\s\S]*HTTP 503/);
  assert.ok(!labelled(github, 8, PROBLEM_LABEL));
  unwell = false;
  assert.equal((await run()).released, 1);
});

test("GitHub is asked for the posts labelled music, and a post is closed as not planned", async () => {
  // GitHub's answers, in memory: what the client sends is what is looked at.
  const asked = [];
  const fetchImpl = async (url, { method, body }) => {
    asked.push({ method, url: String(url), body: body ? JSON.parse(body) : null });
    return new Response(JSON.stringify(method === "GET" ? [{ number: 1, author_association: "NONE" }, { number: 2, pull_request: {} }] : {}));
  };
  const client = createClient({ repo: REPO, token: "not-a-token", label: LABEL, dataBranch: DATA_BRANCH, fetchImpl });
  assert.equal(LABEL, "music");
  assert.equal(client.dataBranch, "music-index");
  // What GitHub says of each author comes with the list; a pull request is no post.
  assert.deepEqual(await client.listPosts(), [{ number: 1, author_association: "NONE" }]);
  await client.closeAsNotPlanned(1);
  assert.deepEqual(asked, [
    { method: "GET", url: `https://api.github.com/repos/${REPO}/issues?state=all&labels=music&sort=created&direction=asc&per_page=100&page=1`, body: null },
    { method: "PATCH", url: `https://api.github.com/repos/${REPO}/issues/1`, body: { state: "closed", state_reason: "not_planned" } },
  ]);
});

test("a dry run downloads and checks, and changes nothing", async () => {
  const github = fakeGitHub();
  const { download, calls } = fakeDownloads({ "https://example.com/passage.mp3": saved("dry.mp3", mp3()) });
  github.post(1, body());
  github.post(2, body({ name: "An outsider's" }), { user: "someone", association: "NONE" });
  const said = [];
  const summary = await syncMusic({ client: dryRunOf(github.client, { log: (line) => said.push(line) }), workDir: path.join(temp, "work"), download, now: () => NOON, log: () => {} });
  assert.equal(summary.released, 1);
  assert.equal(summary.turnedAway, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(github.comments.size, 0);
  assert.deepEqual(github.releases, []);
  assert.deepEqual(github.data, {});
  assert.ok(github.posts.every((post) => post.state === "open" && post.labels.length === 1));
  assert.match(said.join("\n"), /would create the release music[\s\S]*would upload passage-of-time-v1-[0-9a-f]{8}\.mp3 to music[\s\S]*would commit "Publish passage-of-time version 1 \(#1\)" to the /);
  assert.match(said.join("\n"), /would close #2 as not planned/);
});
