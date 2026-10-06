// Run: npm test
import assert from "node:assert/strict";
import test from "node:test";

import { imageType, readImage } from "../lib/images.mjs";
import { Problem } from "../lib/util.mjs";
import { REAL_JPEG, avif, gif, jpeg, png, webp } from "./fixtures.mjs";

const PICTURES = {
  png: png({ width: 300, height: 200 }),
  jpg: jpeg({ width: 300, height: 200 }),
  gif: gif({ width: 300, height: 200 }),
  webp: webp({ width: 300, height: 200 }),
};

test("each kind of picture is read to its end, and says how large it is", () => {
  for (const [type, bytes] of Object.entries(PICTURES)) {
    assert.equal(imageType(bytes), type);
    assert.deepEqual(readImage(bytes), { type, width: 300, height: 200, length: bytes.length }, type);
  }
  assert.deepEqual(readImage(webp({ width: 5000, height: 20000, extended: true })).width, 5000, "a WebP with a header of its own");
  assert.deepEqual(readImage(REAL_JPEG), { type: "jpg", width: 16, height: 8, length: REAL_JPEG.length }, "a JPEG from a real encoder");
  const still = avif({ width: 1600, height: 900 });
  assert.deepEqual(readImage(still), { type: "avif", width: 1600, height: 900, length: still.length });
  assert.equal(imageType(avif({ brand: "avis" })), "avif");
});

test("a picture that stops before its end is refused, wherever it stops", () => {
  for (const [type, bytes] of Object.entries({ ...PICTURES, gif: gif({ width: 40, height: 30 }) })) {
    for (let length = 12; length < bytes.length; length += 1) {
      assert.throws(() => readImage(bytes.subarray(0, length)), Problem, `${type} cut at ${length} of ${bytes.length}`);
    }
  }
  assert.throws(() => readImage(REAL_JPEG.subarray(0, REAL_JPEG.length - 2)), /cut short/);
  const still = avif();
  assert.throws(() => readImage(still.subarray(0, still.length - 5)), /cut short/);
});

test("where a picture ends is found when something follows it", () => {
  const hidden = Buffer.from("PK\x03\x04 a second file, riding along");
  for (const [type, bytes] of Object.entries(PICTURES)) {
    const read = readImage(Buffer.concat([bytes, hidden]));
    assert.equal(read.length, bytes.length, type);
    assert.equal(read.width, 300, type);
  }
});

test("a picture that is damaged, empty or of an unknown kind is refused", () => {
  const damaged = Buffer.from(PICTURES.png);
  damaged[damaged.length - 20] ^= 0xff; // inside its pixels: the checksum no longer holds
  assert.throws(() => readImage(damaged), /fails its checksum/);
  // A PNG with a header and an end and no pixels between them.
  const hollow = Buffer.concat([PICTURES.png.subarray(0, 33), PICTURES.png.subarray(PICTURES.png.length - 12)]);
  assert.throws(() => readImage(hollow), /holds no picture/);
  const noFrame = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([4, 0, 3, 0, 0, 0, 0, 0x3b])]);
  assert.throws(() => readImage(noFrame), /holds no picture/);
  // A JPEG whose parts are not where a reader expects them.
  const stray = Buffer.concat([PICTURES.jpg.subarray(0, 20), Buffer.from([1, 2, 3]), PICTURES.jpg.subarray(20)]);
  assert.throws(() => readImage(stray), Problem);
  assert.equal(imageType(Buffer.from("<html><body>not a picture</body></html>")), "");
  assert.throws(() => readImage(Buffer.from("MZ\x90\x00 a program")), /not a picture/);
  assert.equal(imageType(Buffer.alloc(0)), "");
  // An ISO media file that is not an AVIF (a video) is not a picture.
  assert.equal(imageType(avif({ brand: "isom" })), "");
});
