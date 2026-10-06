// Run: npm test
import assert from "node:assert/strict";
import test from "node:test";

import { spoken } from "../lib/comments.mjs";
import { limitedBody } from "../lib/index.mjs";
import {
  RELEASE_FILE_LIMIT,
  assetName,
  assetPrefix,
  chooseRelease,
  fileNameOf,
  isOwnRelease,
  kindOfIssue,
  parseReleaseLink,
  postFiles,
  slowToRead,
  sourceKey,
  withoutZipAttachments,
} from "../lib/posts.mjs";

const issue = (kind, body) => ({ number: 7, labels: [{ name: kind }], body });
const FILE = "https://github.com/user-attachments/files/33077896/Modern-Japan-in-a-New-World-scenario.zip";
const IMAGE = "https://github.com/user-attachments/assets/ca7dfbf4-e719-4cf9-ad2b-234fcdb3fd3e";
const HASH = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809";

test("a post is told by its label, as the game lists them", () => {
  assert.equal(kindOfIssue(issue("scenario", "")), "scenario");
  assert.equal(kindOfIssue({ labels: ["Flag"] }), "flag");
  assert.equal(kindOfIssue({ labels: [{ name: "bug" }], title: "[Scenario] not labelled" }), null);
  assert.deepEqual(postFiles({ labels: [], body: FILE }), { kind: null, files: [] });
});

test("a scenario post: its file first, then everything else attached", () => {
  const body = `### Description\n\nA world.\n\n![cover](${IMAGE})\n[the file](${FILE})\n\n### Made by\n\nme`;
  assert.deepEqual(postFiles(issue("scenario", body)), {
    kind: "scenario",
    files: [
      { source: FILE, primary: true },
      { source: IMAGE, primary: false },
    ],
  });
});

test("a scenario's file may be a release or a raw link; the first one in the post is the file", () => {
  const release = "https://github.com/Arkniem/pax-historia-scenarios/releases/download/bundles/roman-117.json";
  const raw = "https://raw.githubusercontent.com/Arkniem/pax-historia-scenarios/main/bundles/roman-117.json";
  const files = postFiles(issue("scenario", `Download: ${release}\nMirror: ${raw}`)).files;
  assert.deepEqual(files, [{ source: release, primary: true }]);
});

test("a flag post: the image shown, or an .svg attached as a file", () => {
  assert.deepEqual(postFiles(issue("flag", `### Flag image\n\n<img width="300" alt="x" src="${IMAGE}" />`)).files, [{ source: IMAGE, primary: true }]);
  const svg = "https://github.com/user-attachments/files/123/arland.svg";
  assert.deepEqual(postFiles(issue("flag", `### Flag image\n\n[arland.svg](${svg})`)).files, [{ source: svg, primary: true }]);
  // A file that is not an image is not the flag, but it is still attached.
  const notes = "https://github.com/user-attachments/files/124/notes.zip";
  assert.deepEqual(postFiles(issue("flag", `[notes](${notes})`)).files, [{ source: notes, primary: false }]);
});

test("a basemap post: the data file is the file when there is one, else the image", () => {
  const zip = "https://github.com/user-attachments/files/55/vector.zip";
  assert.deepEqual(postFiles(issue("basemap", `![map](${IMAGE})\n[vector](${zip})`)).files, [
    { source: zip, primary: true },
    { source: IMAGE, primary: false },
  ]);
  assert.deepEqual(postFiles(issue("basemap", `![map](${IMAGE})`)).files, [{ source: IMAGE, primary: true }]);
});

test("a text written to keep the search for its file busy is not searched", () => {
  // The game's own patterns would take more than a minute over this one.
  const body = `${"https://github.com/".repeat(1700)}${"/releases/download/".repeat(1700)}`;
  const started = Date.now();
  for (const kind of ["scenario", "flag", "basemap"]) assert.deepEqual(postFiles(issue(kind, body)), { kind, files: [], slow: true });
  assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
  // The same again with a real file after it: still not searched.
  assert.deepEqual(postFiles(issue("scenario", `${body} ${FILE}`)).files, []);
  // A post with a great many links of its own is nowhere near.
  const pictures = Array.from({ length: 60 }, (_, index) => `![shot ${index}](https://github.com/user-attachments/assets/${String(index).padStart(8, "0")}-1111-2222-3333-444444444444)`).join("\n");
  const preset = "https://github.com/Open-Historia/Open-historia-scenarios/releases/download/bundles/modern-day.zip";
  const long = `${"A long description. ".repeat(3000)}\n${pictures}\n[modern-day.zip](${preset})`;
  assert.equal(slowToRead(long), false);
  const read = postFiles(issue("scenario", long));
  assert.equal(read.slow, undefined);
  assert.deepEqual(read.files[0], { source: preset, primary: true });
});

test("a release link is read into its parts", () => {
  assert.deepEqual(parseReleaseLink("https://github.com/Open-Historia/Open-historia-scenarios/releases/download/bundles/the%20war.zip"), {
    owner: "Open-Historia",
    repo: "Open-historia-scenarios",
    tag: "bundles",
    name: "the war.zip",
  });
  assert.equal(parseReleaseLink(FILE), null);
});

test("a checked copy is named for its post, its attachment, itself and its bytes", () => {
  assert.equal(sourceKey(FILE), "33077896");
  assert.equal(sourceKey(IMAGE), "ca7dfbf4");
  assert.equal(assetName({ post: 193, source: FILE, type: "zip", sha256: HASH }), "p193-33077896-Modern-Japan-in-a-New-World-scenario-1a2b3c4d.zip");
  // An image dragged in has an id and no name.
  assert.equal(fileNameOf(IMAGE), "");
  assert.equal(assetName({ post: 190, source: IMAGE, type: "jpg", sha256: HASH }), "p190-ca7dfbf4-1a2b3c4d.jpg");
  // The extension is what the copy is, which is not always what was attached.
  assert.equal(assetName({ post: 5, source: "https://github.com/user-attachments/files/123/arland.svg", type: "png", sha256: HASH }), "p5-123-arland-1a2b3c4d.png");
  // Whatever the name is made of, the release keeps it as given.
  const odd = "https://github.com/user-attachments/files/9/%D0%9C%D0%B8%D1%80%20%231%20(final).json";
  assert.match(assetName({ post: 2, source: odd, type: "json", sha256: HASH }), /^p2-9(?:-[A-Za-z0-9._-]+)?-1a2b3c4d\.json$/);
  assert.ok(assetName({ post: 193, source: FILE, type: "zip", sha256: HASH }).startsWith(`${assetPrefix({ post: 193, source: FILE })}-`));
  // A test post's copies are told apart by their first letter.
  assert.equal(assetName({ post: 200, source: FILE, type: "zip", sha256: HASH, test: true }), "t200-33077896-Modern-Japan-in-a-New-World-scenario-1a2b3c4d.zip");
  // A file of a branch has no attachment number: a few characters of its address stand in.
  assert.match(assetName({ post: 200, source: "https://github.com/Open-Historia/Open-historia-scenarios/raw/security-tests/files/evil.zip", type: "zip", sha256: HASH, test: true }), /^t200-[0-9a-f]{8}-evil-1a2b3c4d\.zip$/);
});

test("a kind's files go in its release, and a new one once that is nearly full", () => {
  assert.deepEqual(chooseRelease([], "flag"), { tag: "flags-1", create: true });
  const some = [{ tag: "flags-1", assets: new Array(10) }, { tag: "scenarios-1", assets: [] }, { tag: "bundles", assets: [] }];
  assert.deepEqual(chooseRelease(some, "flag"), { tag: "flags-1", create: false });
  const full = [{ tag: "flags-1", assets: new Array(RELEASE_FILE_LIMIT) }, { tag: "flags-2", assets: new Array(RELEASE_FILE_LIMIT) }];
  assert.deepEqual(chooseRelease(full, "flag"), { tag: "flags-3", create: true });
  assert.deepEqual(["scenarios-1", "flags-12", "basemaps-2", "security-test", "bundles", "v1.0"].map(isOwnRelease), [true, true, true, true, false, false]);
});

test("a file is named in a sentence by its name, never by its address", () => {
  assert.equal(spoken(FILE), "`Modern-Japan-in-a-New-World-scenario.zip`");
  assert.equal(spoken(IMAGE), "The attached image");
  assert.equal(spoken(IMAGE, { ordinal: 2 }), "The attached image 2");
  assert.equal(spoken("https://github.com/user-attachments/files/12/README", { kind: "scenario" }), "The attached file");
  assert.equal(spoken("https://github.com/user-attachments/files/12/a%60b%5D(x).zip"), "`a'b](x).zip`");
  // And should an address ever get into a comment, it is taken out before the comment is posted.
  assert.equal(withoutZipAttachments(`see ${FILE} and https://github.com/Open-Historia/Open-historia-scenarios/releases/download/security-test/t1-x-1a2b3c4d.zip`),
    "see (an address, left out) and https://github.com/Open-Historia/Open-historia-scenarios/releases/download/security-test/t1-x-1a2b3c4d.zip");
});

test("a long post is cut for the index around what the game reads from it", () => {
  assert.equal(limitedBody("short", [FILE]), "short");
  const long = `${"x".repeat(25000)}\n![c](${IMAGE})\n${FILE}\nScenario-Key: oh-0123456789abcdef\n`;
  const cut = limitedBody(long, [FILE, IMAGE]);
  assert.equal(cut.length <= 20000, true);
  assert.ok(cut.endsWith(`\n\n[Modern-Japan-in-a-New-World-scenario.zip](${FILE})\n![](${IMAGE})\nScenario-Key: oh-0123456789abcdef`));
  // What survives the cut by itself is not repeated.
  const early = `${FILE}\n${"x".repeat(25000)}`;
  assert.equal(limitedBody(early, [FILE]).split(FILE).length, 2);
});
