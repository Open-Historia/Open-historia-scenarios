// Run: npm test
import assert from "node:assert/strict";
import test from "node:test";

import {
  RELEASE_FILE_LIMIT,
  assetName,
  assetPrefix,
  checkFile,
  chooseRelease,
  kindOfIssue,
  parseReleaseLink,
  postFiles,
  sniffType,
  sourceKey,
} from "../lib/posts.mjs";

const issue = (kind, body) => ({ number: 7, labels: [{ name: kind }], body });
const FILE = "https://github.com/user-attachments/files/33077896/Modern-Japan-in-a-New-World-scenario.zip";
const IMAGE = "https://github.com/user-attachments/assets/ca7dfbf4-e719-4cf9-ad2b-234fcdb3fd3e";

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

test("a release link is read into its parts", () => {
  assert.deepEqual(parseReleaseLink("https://github.com/Open-Historia/Open-historia-scenarios/releases/download/bundles/the%20war.zip"), {
    owner: "Open-Historia",
    repo: "Open-historia-scenarios",
    tag: "bundles",
    name: "the war.zip",
  });
  assert.equal(parseReleaseLink(FILE), null);
});

test("a copied file is named for its post, its attachment and itself", () => {
  assert.equal(sourceKey(FILE), "33077896");
  assert.equal(sourceKey(IMAGE), "ca7dfbf4");
  assert.equal(assetName({ post: 193, source: FILE, type: "zip" }), "p193-33077896-Modern-Japan-in-a-New-World-scenario.zip");
  // An image dragged in has an id and no name.
  assert.equal(assetName({ post: 190, source: IMAGE, type: "jpg" }), "p190-ca7dfbf4.jpg");
  // Whatever the name is made of, the release keeps it as given.
  const odd = "https://github.com/user-attachments/files/9/%D0%9C%D0%B8%D1%80%20%231%20(final).json";
  assert.match(assetName({ post: 2, source: odd, type: "json" }), /^p2-9(?:-[A-Za-z0-9._-]+)?\.json$/);
  assert.ok(assetName({ post: 193, source: FILE, type: "zip" }).startsWith(`${assetPrefix({ post: 193, source: FILE })}-`));
});

test("a file is what its first bytes say", () => {
  assert.equal(sniffType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])), "zip");
  assert.equal(sniffType(Buffer.from([0x89, 0x50, 0x4e, 0x47])), "png");
  assert.equal(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "jpg");
  assert.equal(sniffType(Buffer.from("GIF89a")), "gif");
  assert.equal(sniffType(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])), "webp");
  assert.equal(sniffType(Buffer.from('﻿  {"schema":"x"}')), "json");
  assert.equal(sniffType(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg">')), "svg");
  assert.equal(sniffType(Buffer.from("<!DOCTYPE html><html>Not Found")), "");
});

test("what cannot be copied, and why", () => {
  assert.equal(checkFile({ kind: "scenario", primary: true, type: "zip", size: 10 }).problem, "");
  assert.match(checkFile({ kind: "scenario", primary: true, type: "png", size: 10 }).problem, /picture/);
  assert.match(checkFile({ kind: "scenario", primary: true, type: "", size: 10 }).problem, /not a scenario file/);
  assert.match(checkFile({ kind: "scenario", primary: true, type: "zip", size: 300 * 1048576 }).problem, /300 MB.*200 MB/);
  assert.match(checkFile({ kind: "flag", primary: true, type: "zip", size: 10 }).problem, /not an image/);
  assert.match(checkFile({ kind: "flag", primary: true, type: "png", size: 0 }).problem, /empty/);
  assert.equal(checkFile({ kind: "basemap", primary: true, type: "zip", size: 10 }).problem, "");
  // Something else attached that the game has no use for is left where it is.
  assert.deepEqual(checkFile({ kind: "scenario", primary: false, type: "", size: 10 }), { problem: "", skip: true });
});

test("a kind's files go in its release, and a new one once that is nearly full", () => {
  assert.deepEqual(chooseRelease([], "flag"), { tag: "flags-1", create: true });
  const some = [{ tag: "flags-1", assets: new Array(10) }, { tag: "scenarios-1", assets: [] }, { tag: "bundles", assets: [] }];
  assert.deepEqual(chooseRelease(some, "flag"), { tag: "flags-1", create: false });
  const full = [{ tag: "flags-1", assets: new Array(RELEASE_FILE_LIMIT) }, { tag: "flags-2", assets: new Array(RELEASE_FILE_LIMIT) }];
  assert.deepEqual(chooseRelease(full, "flag"), { tag: "flags-3", create: true });
});
