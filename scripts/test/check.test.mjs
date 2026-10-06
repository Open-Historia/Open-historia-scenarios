// Run: npm test
import assert from "node:assert/strict";
import test, { after } from "node:test";

import { checkPostFile, checkSuggestion, sniffType } from "../lib/check.mjs";
import { readImage } from "../lib/images.mjs";
import { closeSharedRasteriser } from "../lib/svg.mjs";
import { MIB, sha256, sizeText } from "../lib/util.mjs";
import { readZip } from "../lib/zip.mjs";
import {
  JSZIP_MISSING, REAL_JPEG, SVG, avif, dataUrl, featureCollection, gif, jpeg, loadJSZip, pmtiles, png, rawZip, scenario, scenarioJson, scenarioZip,
  suggestion, suggestionZip, webp, zip,
} from "./fixtures.mjs";

after(() => closeSharedRasteriser());

const HUB_FILE = "https://github.com/user-attachments/files/55/vector.zip";
const check = (kind, bytes, { primary = true, label = "`the-file`" } = {}) => checkPostFile({ kind, primary, bytes, label, isHubAddress: (url) => url === HUB_FILE });
const released = async (kind, bytes, options) => {
  const result = await check(kind, bytes, options);
  assert.deepEqual(result.problems, []);
  assert.equal(result.released, true);
  return result;
};
const refused = async (kind, bytes, pattern, options) => {
  const result = await check(kind, bytes, options);
  assert.equal(result.released, false, `released, with ${JSON.stringify(result.repairs)}`);
  assert.match(result.problems.join("\n"), pattern);
  return result;
};
const unzipped = (bytes) => Object.fromEntries(readZip(bytes).map((entry) => [entry.name, entry.read()]));
const json = (bytes) => JSON.parse(bytes.toString("utf8"));
const PNG = png({ width: 60, height: 40 });
const svgUrl = dataUrl("image/svg+xml", SVG);
// A scenario's text, with one more field written into it by hand (a key such
// as __proto__ cannot be set on an object the ordinary way).
const withRawField = (field) => Buffer.from(JSON.stringify(scenario()).replace('"language":"en"', `"language":"en",${field}`));

test("a file is what its first bytes say", () => {
  assert.equal(sniffType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])), "zip");
  assert.equal(sniffType(PNG), "png");
  assert.equal(sniffType(jpeg()), "jpg");
  assert.equal(sniffType(gif()), "gif");
  assert.equal(sniffType(webp()), "webp");
  assert.equal(sniffType(avif()), "avif");
  assert.equal(sniffType(Buffer.from('\xef\xbb\xbf  {"schema":"x"}', "latin1")), "json");
  assert.equal(sniffType(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg">')), "svg");
  assert.equal(sniffType(Buffer.from("<!DOCTYPE html><html>Not Found")), "");
  assert.equal(sniffType(Buffer.from("MZ\x90\x00")), "");
});

// ---- pictures -------------------------------------------------------------------

test("a flag that is whole is released as it is", async () => {
  for (const [type, bytes] of Object.entries({ png: PNG, jpg: jpeg(), gif: gif(), webp: webp() })) {
    const result = await released("flag", bytes);
    assert.equal(result.type, type);
    assert.ok(result.bytes.equals(bytes), type);
    assert.deepEqual(result.repairs, []);
  }
});

test("what follows a picture's end is cut off", async () => {
  const hidden = Buffer.from("PK\x03\x04 a second file, riding along");
  for (const bytes of [PNG, jpeg(), gif(), webp()]) {
    const result = await released("flag", Buffer.concat([bytes, hidden]));
    assert.ok(result.bytes.equals(bytes));
    assert.deepEqual(result.repairs, [`${hidden.length} bytes after the end of the image were cut off`]);
  }
  assert.deepEqual((await released("flag", Buffer.concat([PNG, Buffer.from([0])]))).repairs, ["1 byte after the end of the image was cut off"]);
  // Megabytes of it: the picture is cut to itself, and then is no longer heavy.
  const padded = await released("flag", Buffer.concat([PNG, Buffer.alloc(3 * MIB, 7)]));
  assert.ok(padded.bytes.equals(PNG));
  assert.deepEqual(padded.repairs, ["3,145,728 bytes after the end of the image were cut off"]);
});

test("an SVG is released as the PNG it draws, at the size of its use", async () => {
  const flag = await released("flag", Buffer.from(SVG));
  assert.equal(flag.type, "png");
  assert.deepEqual(readImage(flag.bytes), { type: "png", width: 1024, height: 683, length: flag.bytes.length });
  assert.deepEqual(flag.repairs, ["SVG drawn as a 1024×683 PNG"]);
  const cover = await released("scenario", Buffer.from(SVG), { primary: false });
  assert.deepEqual(cover.repairs, ["SVG drawn as a 1600×1067 PNG"]);
  const sized = SVG.replace("viewBox", 'width="600" height="400" viewBox');
  assert.deepEqual((await released("basemap", Buffer.from(sized))).repairs, ["SVG drawn as a 600×400 PNG"]);
  await refused("flag", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="6"><image width="9" height="6" href="https://example.com/track.png"/></svg>'), /`the-file` can't be used: it is an SVG the hub could not draw.*Save it as a PNG/);
});

test("a flag too heavy for the game's flag library is drawn again smaller", async () => {
  const heavy = png({ width: 1100, height: 700, noise: true });
  assert.ok(heavy.length > 2 * MIB);
  const result = await released("flag", heavy);
  assert.ok(result.bytes.length <= 2 * MIB, `${result.bytes.length} bytes`);
  const { width, height } = readImage(result.bytes);
  assert.ok(width <= 1024 && width / height > 1.5 && width / height < 1.65, `${width} by ${height}`);
  assert.deepEqual(result.repairs, [`shrunk from ${sizeText(heavy.length)} to a ${width}×${height} PNG`]);
  // The same picture as a scenario's cover is no flag, and is left alone.
  assert.ok((await released("scenario", heavy, { primary: false })).bytes.equals(heavy));
  // The renderer cannot read a WebP, so a heavy one is refused, and told why.
  await refused("flag", webp({ width: 800, height: 600, weight: 2 * MIB + 100 }), /it is 2 MB, and a flag can be 2 MB at most \(the hub can make a PNG, JPEG or GIF smaller, but not a WebP\)/);
});

test("a picture too large for its use, or of a kind it cannot be, is refused", async () => {
  await refused("flag", png({ says: [5000, 4000] }), /it is 5,000×4,000 pixels \(20 megapixels\), and a flag can be 16 megapixels at most/);
  await refused("basemap", png({ says: [20000, 300] }), /a basemap can be 16,384 pixels a side at most/);
  await refused("basemap", png({ says: [16000, 12000] }), /192 megapixels.*150 megapixels at most/);
  await released("basemap", png({ says: [16000, 9000] }));
  await refused("flag", avif(), /it is an AVIF, which the game shows only as a scenario's cover/);
  await refused("flag", PNG.subarray(0, PNG.length - 9), /`the-file` can't be used: it is cut short/);
  await refused("flag", Buffer.alloc(0), /it is empty/);
  await refused("flag", zip({ "a.json": "{}" }), /it is not an image/);
  await refused("flag", Buffer.from("MZ\x90\x00 a program"), /it is not an image the game can read/);
  await refused("scenario", PNG, /it is a picture, not a scenario file/);
  await refused("scenario", Buffer.from("just some notes"), /it is not a scenario file/);
  await refused("basemap", Buffer.from("just some notes"), /it is not a basemap the game can read/);
  // Something else attached that is nothing the hub copies is left where it is.
  assert.deepEqual(await check("scenario", Buffer.from("just some notes"), { primary: false }), { released: false, skip: true, problems: [], repairs: [] });
});

// ---- a scenario as one .json -----------------------------------------------------

test("a scenario that is in order is released byte for byte", async () => {
  const bytes = scenarioJson({
    assets: {
      cover: { contentType: "image/png", data: PNG.toString("base64"), encoding: "base64", fileName: "cover-image.bin", mode: "embedded" },
      flags: { data: { France: dataUrl("image/png", PNG), Spain: "https://flagcdn.com/es.svg", Wales: "https://flagcdn.com/w160/gb-wls.png", Atlantis: "flags/atlantis.png", Nowhere: "" }, fileName: "flags.json", mode: "embedded" },
      institutionLogos: { data: { league: dataUrl("image/png", PNG) }, fileName: "institution-logos.json", mode: "embedded" },
      regionsGeojson: { contentType: "application/json", data: featureCollection(3), fileName: "regions.geojson", mode: "embedded" },
      citiesGeojson: { contentType: "application/json", data: Buffer.from(JSON.stringify(featureCollection(1))).toString("base64"), fileName: "cities.geojson", mode: "embedded" },
      backgroundData: { contentType: "application/json", data: { dataUrl: dataUrl("image/jpeg", REAL_JPEG) }, fileName: "background.json", mode: "embedded" },
      regions: { contentType: "application/octet-stream", data: pmtiles().toString("base64"), encoding: "base64", fileName: "regions.pmtiles", mode: "embedded" },
      cities: { droppedOverride: false, fileName: "cities.pmtiles", mode: "default" },
    },
    world: {
      polityOverrides: { France: { name: "France", flag: "https://flagcdn.com/fr.svg" }, Atlantis: { name: "Atlantis", flag: null } },
      institutions: { byId: { league: { id: "league", name: "The League", logoUrl: dataUrl("image/png", PNG) }, pact: { id: "pact", logoUrl: "logos/pact.png" } } },
      startingTimelineText: "Read more at https://example.com/history and [the wiki](https://example.com/wiki). ![a flag](https://flagcdn.com/fr.svg)",
    },
  });
  const result = await released("scenario", bytes);
  assert.equal(result.type, "json");
  assert.equal(sha256(result.bytes), sha256(bytes));
  assert.deepEqual(result.repairs, []);
  // The schema of files written under the project's earlier name is a scenario's too.
  await released("scenario", scenarioJson({ schema: "pax-historia-scenario-bundle", version: 1, mode: "light" }));
  await released("scenario", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), scenarioJson()]), {});
});

test("what is not a scenario is refused", async () => {
  await refused("scenario", Buffer.from('{"schema":"open-historia-scenario-bundle/2","scenario":'), /`the-file` can't be used: it is not valid JSON/);
  await refused("scenario", Buffer.from("[1,2,3]"), /is not a scenario: it holds a list/);
  await refused("scenario", scenarioJson({ schema: "open-historia-game-bundle/1" }), /its `schema` is `open-historia-game-bundle\/1`, which is not a scenario's/);
  await refused("scenario", scenarioJson({ schema: undefined }), /it has no `schema`/);
  await refused("scenario", scenarioJson({ schema: "open-historia-scenario-bundle/3" }), /is not a scenario's/);
  await refused("scenario", Buffer.from('{"schema":"open-historia-scenario-bundle/2","version":2}'), /it has none of `scenario`, `data` and `assets`/);
  await refused("scenario", scenarioJson({ data: [1, 2] }), /its `data` is not what the game writes there/);
  await refused("scenario", scenarioJson({ data: { world: "flat" } }), /its `data\.world` is not what the game writes there/);
  await refused("scenario", Buffer.from(`{"schema":"open-historia-scenario-bundle/2","scenario":{},"deep":${"[".repeat(300)}${"]".repeat(300)}}`), /nested more than 200 levels deep/);
});

test("a scenario's own link to a post is taken out", async () => {
  const result = await released("scenario", scenarioJson({ hubOrigin: { postId: 12, bundleUrl: "https://github.com/user-attachments/files/1/x.zip" } }));
  assert.deepEqual(result.repairs, ["`hubOrigin` removed"]);
  assert.deepEqual(json(result.bytes), scenario());
});

test("a scenario's cover is a picture, and says which kind", async () => {
  const cover = (fields) => scenarioJson({ assets: { cover: { fileName: "cover-image.bin", mode: "embedded", encoding: "base64", ...fields } } });
  // The exporter's "application/octet-stream" would have the game refuse the scenario.
  const typed = await released("scenario", cover({ contentType: "application/octet-stream", data: webp().toString("base64") }));
  assert.deepEqual(typed.repairs, ["the cover's type corrected"]);
  assert.equal(json(typed.bytes).assets.cover.contentType, "image/webp");
  const drawn = await released("scenario", cover({ contentType: "image/svg+xml", data: Buffer.from(SVG).toString("base64") }));
  assert.deepEqual(drawn.repairs, ["the cover converted to a PNG", "the cover's type corrected"]);
  const { contentType, data } = json(drawn.bytes).assets.cover;
  assert.equal(contentType, "image/png");
  assert.deepEqual(readImage(Buffer.from(data, "base64")).width, 1600);
  const cut = await released("scenario", cover({ contentType: "image/png", data: Buffer.concat([PNG, Buffer.from("<script>")]).toString("base64") }));
  assert.deepEqual(cut.repairs, ["bytes after the end of 1 picture cut off"]);
  assert.ok(Buffer.from(json(cut.bytes).assets.cover.data, "base64").equals(PNG));
  await released("scenario", cover({ contentType: "image/avif", data: avif({ width: 1600, height: 900 }).toString("base64") }));
  await refused("scenario", cover({ contentType: "image/png", data: Buffer.from("<html>").toString("base64") }), /The `cover` asset of `the-file` can't be used: it is not a picture the game can show/);
  await refused("scenario", cover({ contentType: "image/png", data: "not base64 at all!" }), /The `cover` asset of `the-file` is not base64/);
  await refused("scenario", cover({ contentType: "image/png", data: png({ says: [9000, 6000] }).toString("base64") }), /54 megapixels.*a cover can be 40 megapixels at most/);
});

test("a flag is a picture in the file, a flag of the game's own, or a path into the game", async () => {
  const flags = (data, world = {}) => scenarioJson({ assets: { flags: { data, fileName: "flags.json", mode: "embedded" } }, world });
  const drawn = await released("scenario", flags({ France: svgUrl, Spain: `data:image/svg+xml,${encodeURIComponent(SVG)}`, Italy: dataUrl("image/png", PNG), Wales: "https://flagcdn.com/gb-wls.svg" }));
  assert.deepEqual(drawn.repairs, ["2 flags converted"]);
  const out = json(drawn.bytes).assets.flags.data;
  for (const key of ["France", "Spain"]) {
    assert.match(out[key], /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
    assert.equal(readImage(Buffer.from(out[key].split(",")[1], "base64")).width, 1024);
  }
  assert.equal(out.Italy, dataUrl("image/png", PNG));
  assert.equal(out.Wales, "https://flagcdn.com/gb-wls.svg");

  await refused("scenario", flags({ France: "https://evil.example/track.png?player=1" }), /`the-file` holds a flag that is loaded from another website \(`evil\.example`, key `France`\): a flag has to be carried in the file itself/);
  await refused("scenario", flags({ France: "//evil.example/x.png" }), /loaded from another website/);
  await refused("scenario", flags({ France: "javascript:alert(1)" }), /holds a flag that is not an image the game can show \(key `France`\)/);
  await refused("scenario", flags({ France: "../../secrets.png" }), /not an image the game can show/);
  await refused("scenario", flags({ France: dataUrl("image/png", "<html>") }), /holds a flag that can't be used \(key `France`\): it is not a picture the game can show/);
  await refused("scenario", flags({ France: dataUrl("text/html", "<script>alert(1)</script>") }), /holds a `data:` address that is not a picture \(`text\/html`, key `France`\)/);
  await refused("scenario", flags({ France: dataUrl("image/png", png({ says: [5000, 4000] })) }), /a flag can be 16 megapixels at most/);
  await refused("scenario", scenarioJson({ assets: { flags: { data: "eyJhIjoxfQ==", fileName: "flags.json", mode: "embedded" } } }), /The `flags` asset of `the-file` is text where the game expects named entries/);
  // A polity's own flag, and an institution's logo, follow the same rule.
  await refused("scenario", flags({}, { polityOverrides: { Narnia: { name: "Narnia", flag: "http://evil.example/n.png" } } }), /holds a flag that is loaded from another website \(`evil\.example`, `Narnia`\)/);
  await refused("scenario", flags({}, { institutions: { byId: { pact: { id: "pact", logoUrl: "https://upload.example.org/pact.svg" } } } }), /holds a logo that is loaded from another website \(`upload\.example\.org`, `pact`\)/);
  const emblem = await released("scenario", flags({}, { institutions: { pact: { id: "pact", emblem: svgUrl } }, polityOverrides: { Narnia: { flag: svgUrl } } }));
  assert.deepEqual(emblem.repairs, ["1 flag converted", "1 SVG picture converted to a PNG"]);
  // A heavy flag is made lighter here too, and one with something appended is cut.
  const heavy = await released("scenario", flags({ Big: dataUrl("image/png", png({ width: 1100, height: 700, noise: true })), Odd: dataUrl("image/png", Buffer.concat([PNG, Buffer.from("more")])), Mislabelled: dataUrl("image/png", REAL_JPEG) }));
  assert.deepEqual(heavy.repairs, ["bytes after the end of 1 picture cut off", "1 flag over 2 MB made smaller", "1 picture's type corrected"]);
  const lighter = json(heavy.bytes).assets.flags.data;
  assert.ok(lighter.Big.length < 2.8 * MIB);
  assert.equal(lighter.Odd, dataUrl("image/png", PNG));
  assert.equal(lighter.Mislabelled, dataUrl("image/jpeg", REAL_JPEG));
});

test("an institution's logo is a picture in the file, of at most 512 KiB", async () => {
  const logos = (data) => scenarioJson({ assets: { institutionLogos: { data, fileName: "institution-logos.json", mode: "embedded" } } });
  const drawn = await released("scenario", logos({ league: svgUrl }));
  assert.deepEqual(drawn.repairs, ["1 logo converted"]);
  assert.equal(readImage(Buffer.from(json(drawn.bytes).assets.institutionLogos.data.league.split(",")[1], "base64")).width, 512);
  await refused("scenario", logos({ league: dataUrl("image/png", png({ width: 500, height: 400, noise: true })) }), /holds a logo that can't be used \(key `league`\): it is \d\d\d KB, and a logo can be 512 KB at most/);
  await refused("scenario", logos({ league: "https://upload.example.org/league.png" }), /holds a logo that is not a picture carried in the file \(key `league`\)/);
});

test("a scenario's maps are maps the game can draw", async () => {
  const regions = (data, extra = {}) => scenarioJson({ assets: { regionsGeojson: { contentType: "application/json", data, fileName: "regions.geojson", mode: "embedded", ...extra } } });
  const base64 = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64");
  await released("scenario", regions(featureCollection(2)));
  await released("scenario", regions(base64(featureCollection(2)), { encoding: "base64" }));
  await released("scenario", regions(base64(featureCollection(2)))); // older files do not say "base64"
  await released("scenario", regions({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: null }, { type: "Feature", geometry: { type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [1, 2, 3] }] } }] }));
  await refused("scenario", regions({ type: "Feature", geometry: null }), /The `regionsGeojson` asset of `the-file` is not a map the game can draw: it is not a GeoJSON FeatureCollection/);
  await refused("scenario", regions({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, "x"], [1, 1]]] } }] }), /its feature 1 has a shape whose points are not all numbers/);
  await refused("scenario", regions({ type: "FeatureCollection", features: [featureCollection().features[0], { type: "Feature", geometry: { type: "Circle", coordinates: [0, 0] } }] }), /its feature 2 has a shape of a kind the game does not draw/);
  await refused("scenario", regions({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [null, null] } }] }), /points are not all numbers/);
  // What a real post carries: an object written out as text, then taken for base64.
  await refused("scenario", regions("objectObject", { encoding: "base64" }), /The `regionsGeojson` asset of `the-file` can't be used: it is not valid JSON/);
  await refused("scenario", regions("[object Object]", { encoding: "base64" }), /is not base64/);
});

test("a scenario's basemap is carried in it, never fetched", async () => {
  const background = (data, extra = {}) => scenarioJson({ assets: { backgroundData: { contentType: "application/json", fileName: "background.json", mode: "embedded", data, ...extra } }, world: { background: { kind: "image" } } });
  const drawn = await released("scenario", background({ dataUrl: svgUrl }));
  assert.deepEqual(drawn.repairs, ["the basemap converted to a PNG"]);
  assert.match(json(drawn.bytes).assets.backgroundData.data.dataUrl, /^data:image\/png;base64,/);
  // The older way: the same JSON, as base64. What is put right is written back the same way.
  const wrapped = await released("scenario", background(Buffer.from(JSON.stringify({ dataUrl: svgUrl })).toString("base64"), { encoding: "base64" }));
  assert.deepEqual(wrapped.repairs, ["the basemap converted to a PNG"]);
  assert.match(JSON.parse(Buffer.from(json(wrapped.bytes).assets.backgroundData.data, "base64").toString()).dataUrl, /^data:image\/png;base64,/);
  await released("scenario", background({ geojson: featureCollection() }));
  // A string where the map should be is an address the game's map would load.
  await refused("scenario", background({ geojson: "https://evil.example/track.geojson" }), /the basemap in the `backgroundData` asset of `the-file` is not a map the game can draw: it is text \(an address the game would load\)/i);
  await refused("scenario", background({ dataUrl: "https://evil.example/map.png" }), /names its basemap by an address, where the picture itself has to be carried in the file/);
  await refused("scenario", background({}), /is a basemap with nothing in it/);
  await refused("scenario", background("objectObject", { encoding: "base64" }), /The `backgroundData` asset of `the-file` can't be used: it is not valid JSON/);
  // A basemap shared by its post: only one this hub has.
  const shared = (url) => scenarioJson({ assets: { backgroundData: { mode: "communityRef", hash: "abc", via: "dataFile", url, fileName: "background.json" } } });
  assert.deepEqual((await released("scenario", shared(HUB_FILE))).repairs, []);
  await refused("scenario", shared("https://github.com/user-attachments/files/999/elsewhere.zip"), /points at a basemap that is not a file of this hub/);
  await refused("scenario", shared("https://evil.example/map.zip"), /not a file of this hub/);
});

test("a scenario's tile archives are tile archives", async () => {
  const tiles = (bytes) => scenarioJson({ assets: { countries: { contentType: "application/octet-stream", data: bytes.toString("base64"), encoding: "base64", fileName: "countries.pmtiles", mode: "embedded" } } });
  await released("scenario", tiles(pmtiles()));
  await refused("scenario", tiles(Buffer.from("MZ\x90\x00 not tiles at all")), /The `countries` asset of `the-file` can't be used: it is not a PMTiles archive/);
  await refused("scenario", tiles(pmtiles({ longer: 4000 })), /it is cut short/);
});

test("the rules that hold everywhere in a scenario's JSON", async () => {
  await refused("scenario", withRawField('"__proto__":{"isAdmin":true}'), /`the-file` has a field named `__proto__` \(at `data\.world\.__proto__`\)/);
  await refused("scenario", withRawField('"units":[{"constructor":{"prototype":{"x":1}}}]'), /has a field named `constructor` \(at `data\.world\.units\[0\]\.constructor`\)[\s\S]*has a field named `prototype`/);
  await refused("scenario", withRawField(`"note":${JSON.stringify(dataUrl("text/html", "<script>alert(1)</script>"))}`), /holds a `data:` address that is not a picture \(`text\/html`, at `data\.world\.note`\)/);
  await refused("scenario", withRawField('"link":"  JavaScript:alert(document.cookie)"'), /holds a script address \(`javascript:` or `vbscript:`, at `data\.world\.link`\)/);
  await refused("scenario", withRawField('"link":"java\\tscript:alert(1)"'), /holds a script address/);
  await refused("scenario", withRawField('"text":"Click [here](javascript:alert(1)) to win."'), /holds a script address/);
  await refused("scenario", withRawField('"text":"<a href=\\"vbscript:msgbox(1)\\">x</a>"'), /holds a script address/);
  await refused("scenario", withRawField('"text":"The war. ![map](https://evil.example/pixel.png?who=player)"'), /has text that shows a picture from another website \(`evil\.example`, at `data\.world\.text`\): the game would load it from there for every player/);
  await refused("scenario", withRawField('"text":"<IMG alt=\\"x\\" SRC=\'http://evil.example/p.gif\'>"'), /shows a picture from another website/);
  await refused("scenario", withRawField('"text":"![map][m]\\n\\n[m]: https://evil.example/m.png"'), /shows a picture from another website/);
  // A picture anywhere is checked as a picture, and an SVG anywhere is drawn.
  const anywhere = await released("scenario", withRawField(`"markers":[{"icon":${JSON.stringify(svgUrl)}}]`));
  assert.deepEqual(anywhere.repairs, ["1 SVG picture converted to a PNG"]);
  assert.match(json(anywhere.bytes).data.world.markers[0].icon, /^data:image\/png;base64,/);
  await refused("scenario", withRawField(`"icon":${JSON.stringify(dataUrl("image/png", "MZ not a picture"))}`), /holds a picture that can't be used \(at `data\.world\.icon`\)/);
  // What is only text stays text.
  await released("scenario", withRawField('"text":"See https://example.com, mail:me@example.com, [a link](https://example.com/x.png), and `![not](a picture)`. The word javascript: alone is fine too."'));
  // Many of one problem: the first dozen are said, the rest counted.
  const many = await refused("scenario", scenarioJson({ assets: { flags: { data: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`Land ${index}`, `https://evil.example/${index}.png`])), fileName: "flags.json", mode: "embedded" } } }), /And 28 more problems of the same kinds\./);
  assert.equal(many.problems.length, 13);
});

// ---- a scenario as a .zip --------------------------------------------------------

test("a zipped scenario is written again from its checked entries", async () => {
  const regions = Buffer.from(JSON.stringify(featureCollection(4)));
  const bundle = scenario({
    assets: {
      cover: { contentType: "image/png", fileName: "cover-image.bin", mode: "file", file: "assets/cover-image.bin", format: "base64" },
      regionsGeojson: { contentType: "application/json", fileName: "regions.geojson", mode: "file", file: "assets/regions.geojson", format: "json" },
      regions: { contentType: "application/octet-stream", fileName: "regions.pmtiles", mode: "file", file: "assets/regions.pmtiles", format: "base64" },
    },
  });
  // As JSZip writes one: a folder entry, a comment, and the entries in its own order.
  const attached = rawZip([
    { name: "assets/" },
    { name: "assets/cover-image.bin", data: PNG },
    { name: "assets/regions.geojson", data: regions, method: 8 },
    { name: "assets/regions.pmtiles", data: pmtiles() },
    { name: "scenario.json", data: JSON.stringify(bundle), method: 8 },
    { name: "basemap.geojson", data: JSON.stringify(featureCollection(1)), method: 8 },
    { name: "preview.jpg", data: REAL_JPEG },
    { name: "README.md", data: "# My world\n\nHave fun." },
  ], { comment: "a comment that is not carried over" });
  const result = await released("scenario", attached);
  assert.equal(result.type, "zip");
  assert.deepEqual(result.repairs, ["zip rebuilt from its checked entries"]);
  const files = unzipped(result.bytes);
  assert.deepEqual(Object.keys(files), ["assets/cover-image.bin", "assets/regions.geojson", "assets/regions.pmtiles", "scenario.json", "basemap.geojson", "preview.jpg", "README.md"]);
  assert.deepEqual(json(files["scenario.json"]), bundle);
  assert.ok(files["assets/cover-image.bin"].equals(PNG));
  assert.ok(files["assets/regions.geojson"].equals(regions));
  assert.ok(!result.bytes.includes("a comment that is not carried over"));
  // Checked twice, it is the same file twice: the copy in the release keeps its name.
  assert.equal(sha256((await released("scenario", attached)).bytes), sha256(result.bytes));
  assert.equal(sha256((await released("scenario", result.bytes)).bytes), sha256(result.bytes));
});

test("an SVG in a zipped scenario becomes a PNG, and what pointed at it is rewritten", { skip: JSZIP_MISSING }, async () => {
  const bundle = scenario({
    hubOrigin: { postId: 7, bundleUrl: "https://github.com/user-attachments/files/7/old.zip" },
    assets: {
      cover: { contentType: "image/svg+xml", fileName: "cover.svg", mode: "file", file: "assets/cover.svg", format: "base64" },
      flags: { fileName: "flags.json", mode: "file", file: "assets/flags.json", format: "json" },
    },
  });
  const attached = zip({
    "scenario.json": bundle,
    "assets/cover.svg": SVG,
    "assets/flags.json": { France: svgUrl, Spain: dataUrl("image/svg+xml", SVG.replace("c81e1e", "ffcc00")), Italy: `data:image/svg+xml;utf8,${SVG}`, Wales: "https://flagcdn.com/gb-wls.svg" },
    "basemap.svg": SVG.replace("viewBox", 'width="900" height="600" viewBox'),
    "preview.jpg": REAL_JPEG,
  });
  const result = await released("scenario", attached);
  assert.deepEqual(result.repairs, ["zip rebuilt: `assets/cover.svg` → `assets/cover.png`, `basemap.svg` → `basemap.png`, 3 flags converted, the cover converted to a PNG, the basemap converted to a PNG, the cover's type corrected, `hubOrigin` removed"]);

  // Opened the way the game opens it.
  const JSZip = loadJSZip();
  const opened = await JSZip.loadAsync(result.bytes);
  assert.deepEqual(Object.keys(opened.files), ["scenario.json", "assets/cover.png", "assets/flags.json", "basemap.png", "preview.jpg"]);
  const written = JSON.parse(await opened.file("scenario.json").async("string"));
  assert.deepEqual(written.assets.cover, { contentType: "image/png", fileName: "cover.svg", mode: "file", file: "assets/cover.png", format: "base64" });
  assert.equal(written.hubOrigin, undefined);
  // The game's own search for the basemap finds the PNG.
  const basemapName = Object.keys(opened.files).find((name) => /(^|\/)basemap\.(png|jpe?g|webp|gif|svg)$/i.test(name));
  assert.deepEqual(readImage(await opened.file(basemapName).async("nodebuffer")), { type: "png", width: 900, height: 600, length: (await opened.file(basemapName).async("nodebuffer")).length });
  assert.equal(readImage(await opened.file(written.assets.cover.file).async("nodebuffer")).width, 1600);
  const flags = JSON.parse(await opened.file("assets/flags.json").async("string"));
  for (const key of ["France", "Spain", "Italy"]) assert.match(flags[key], /^data:image\/png;base64,/);
  assert.equal(flags.Wales, "https://flagcdn.com/gb-wls.svg");
  assert.notEqual(flags.France, flags.Spain);
  assert.ok(!result.bytes.includes("<svg"), "no SVG is left anywhere in what is released");
});

test("a zipped scenario is refused for what it points at and is not there", async () => {
  const pointing = (assets) => scenarioZip({ assets }, { "assets/regions.geojson": featureCollection(2) });
  await refused("scenario", pointing({ regionsGeojson: { mode: "file", file: "assets/regions.geo.json", format: "json", fileName: "regions.geojson" } }), /The `regionsGeojson` asset of `scenario\.json` points at `assets\/regions\.geo\.json`, which is not in the zip: the game would import the scenario without it/);
  await refused("scenario", pointing({ regionsGeojson: { mode: "file", format: "json" } }), /which is not in the zip/);
  await released("scenario", pointing({ regionsGeojson: { mode: "file", file: "assets/regions.geojson", format: "json", fileName: "regions.geojson" } }));
  await refused("scenario", pointing({ regionsGeojson: { mode: "file", file: "assets/regions.geojson", format: "json" }, citiesGeojson: { mode: "file", file: "assets/regions.geojson", format: "json" } }), /points at `assets\/regions\.geojson` from two of its assets/);
  // In a plain .json there is nothing to point into.
  await refused("scenario", scenarioJson({ assets: { regionsGeojson: { mode: "file", file: "assets/regions.geojson", format: "json" } } }), /points at a file \(`assets\/regions\.geojson`\), which only a \.zip can carry/);
  await refused("scenario", scenarioJson({ assets: { regionsGeojson: { mode: "linked", data: featureCollection() } } }), /is in a form the game does not read \(mode `linked`\)/);
  await refused("scenario", zip({ "world.json": scenario() }), /`the-file` is a \.zip with no `scenario\.json` in it/);
  await refused("scenario", zip({ "scenario.json": "{ not json" }), /`scenario\.json` can't be used: it is not valid JSON/);
  // An entry as each format the game puts back: bytes, base64 as text, JSON.
  const asBytes = { mode: "file", file: "assets/regions.geojson", format: "base64", fileName: "regions.geojson" };
  await released("scenario", scenarioZip({ assets: { regionsGeojson: asBytes } }, { "assets/regions.geojson": featureCollection(2) }));
  const asText = scenarioZip({ assets: { regionsGeojson: { ...asBytes, format: "text" } } }, { "assets/regions.geojson": Buffer.from(JSON.stringify(featureCollection(2))).toString("base64") });
  await released("scenario", asText);
  await refused("scenario", scenarioZip({ assets: { regionsGeojson: asBytes } }, { "assets/regions.geojson": { type: "Topology" } }), /`assets\/regions\.geojson` is not a map the game can draw/);
  await refused("scenario", scenarioZip({ assets: { flags: { ...asBytes, file: "assets/flags.json" } } }, { "assets/flags.json": { France: "https://flagcdn.com/fr.svg" } }), /points at `assets\/flags\.json` as a file, where the game expects JSON/);
});

test("a zip may hold only what the game uses, by name and by bytes", async () => {
  const holding = (files) => scenarioZip({}, files);
  await refused("scenario", holding({ "setup.exe": "MZ\x90\x00" }), /`setup\.exe` is not something the game uses: a \.zip for the hub holds JSON, pictures, map tiles and plain text, and nothing else/);
  await refused("scenario", holding({ "index.html": "<script>alert(1)</script>" }), /`index\.html` is not something the game uses/);
  await refused("scenario", holding({ "run.js": "process.exit()" }), /`run\.js` is not something the game uses/);
  await refused("scenario", holding({ "more/inner.zip": zip({ "a.json": "{}" }) }), /`more\/inner\.zip` is not something the game uses/);
  await refused("scenario", holding({ "__MACOSX/._scenario.json": Buffer.alloc(8) }), /`__MACOSX\/\._scenario\.json` can't be used: it is not valid JSON/);
  await refused("scenario", holding({ "noextension": "x" }), /`noextension` is not something the game uses/);
  // A name that says one thing over bytes that are another.
  await refused("scenario", holding({ "preview.jpg": "MZ\x90\x00 a program" }), /`preview\.jpg` can't be used: it is not a picture the game can show/);
  await refused("scenario", holding({ "assets/x.bin": "MZ\x90\x00 a program" }), /`assets\/x\.bin` can't be used: it is not a picture/);
  await refused("scenario", holding({ "notes.json": "MZ\x90\x00" }), /`notes\.json` can't be used: it is not valid JSON/);
  await refused("scenario", holding({ "tiles/world.pmtiles": "PK\x03\x04" }), /`tiles\/world\.pmtiles` can't be used: it is not a PMTiles archive/);
  await refused("scenario", holding({ "notes.txt": Buffer.from([0x4d, 0x5a, 0x00, 0x01, 0xff]) }), /`notes\.txt` is not plain text/);
  await refused("scenario", holding({ "extra.json": { icon: dataUrl("text/html", "<script>") } }), /`extra\.json` holds a `data:` address that is not a picture/);
  await refused("scenario", holding({ "basemap.geojson": { type: "FeatureCollection" } }), /`basemap\.geojson` is not a map the game can draw/);
  // A picture under another picture's name is given its own.
  const renamed = await released("scenario", holding({ "preview.png": REAL_JPEG, "art/photo.jpeg": REAL_JPEG, "assets/extra.bin": gif() }));
  assert.deepEqual(renamed.repairs, ["zip rebuilt: `preview.png` → `preview.jpg`"]);
  assert.deepEqual(Object.keys(unzipped(renamed.bytes)), ["scenario.json", "preview.jpg", "art/photo.jpeg", "assets/extra.bin"]);
  await refused("scenario", holding({ "basemap.svg": SVG, "basemap.png": PNG }), /it holds `basemap\.svg`, which would become `basemap\.png`, and it has an entry by that name already/);
  // What the zip reader refuses is the file's problem as a whole.
  await refused("scenario", rawZip([{ name: "scenario.json", data: JSON.stringify(scenario()), flags: 1 }]), /`the-file` can't be used: it has an entry that is encrypted \(`scenario\.json`\)/);
  await refused("scenario", rawZip([{ name: "scenario.json", data: JSON.stringify(scenario()) }, { name: "assets/cover.png", data: PNG, crc: 7 }]), /`the-file` can't be used: it has an entry that is damaged/);
});

// ---- a basemap --------------------------------------------------------------------

test("a basemap's data file is a zip with a map or a picture, the old JSON form, or bare GeoJSON", async () => {
  const vector = await released("basemap", zip({ "basemap.geojson": featureCollection(2) }));
  assert.deepEqual(vector.repairs, ["zip rebuilt from its checked entries"]);
  await released("basemap", zip({ "maps/anything.geojson": featureCollection(1) }));
  const drawn = await released("basemap", zip({ "world.svg": SVG.replace("viewBox", 'width="300" height="200" viewBox') }));
  assert.deepEqual(drawn.repairs, ["zip rebuilt: `world.svg` → `world.png`, the basemap converted to a PNG"]);
  assert.deepEqual(readImage(unzipped(drawn.bytes)["world.png"]).width, 300);
  await refused("basemap", zip({ "readme.txt": "no map here" }), /`the-file` can't be used: that \.zip has no basemap inside it/);
  await refused("basemap", zip({ "basemap.geojson": { type: "FeatureCollection", features: "none" } }), /`basemap\.geojson` is not a map the game can draw/);
  await refused("basemap", zip({ "basemap.geojson": featureCollection(), "tool.exe": "MZ" }), /`tool\.exe` is not something the game uses/);

  const old = (payload, basemap = { name: "Pangaea", kind: "image", thumbnail: svgUrl }) => Buffer.from(JSON.stringify({ basemap, payload }));
  const converted = await released("basemap", old({ dataUrl: svgUrl }));
  assert.equal(converted.type, "json");
  assert.deepEqual(converted.repairs, ["the basemap converted to a PNG", "1 SVG picture converted to a PNG"]);
  assert.match(json(converted.bytes).payload.dataUrl, /^data:image\/png;base64,/);
  assert.match(json(converted.bytes).basemap.thumbnail, /^data:image\/png;base64,/);
  const whole = old({ dataUrl: dataUrl("image/png", PNG) }, { name: "Pangaea", kind: "image" });
  assert.ok((await released("basemap", whole)).bytes.equals(whole));
  await released("basemap", old({ geojson: featureCollection() }, { name: "Lines", kind: "vector" }));
  await refused("basemap", old({ geojson: featureCollection() }, { name: "Lines", kind: "image" }), /is a basemap with nothing in it: it has no picture/);
  await refused("basemap", old({ geojson: "https://evil.example/map.geojson" }, { kind: "vector" }), /it is text \(an address the game would load\)/);
  await refused("basemap", old({ dataUrl: "https://evil.example/map.png" }), /names its basemap by an address/);
  await released("basemap", Buffer.from(JSON.stringify(featureCollection(3))));
  await refused("basemap", Buffer.from('{"name":"just a name"}'), /`the-file` can't be used: that basemap file is missing its data/);
});

// ---- a suggestion -----------------------------------------------------------------

const suggested = (bytes) => checkSuggestion({ bytes, label: "`world-suggestion.zip`", isHubAddress: () => false });
const kept = async (bytes) => {
  const result = await suggested(bytes);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
};
const unusable = async (bytes, pattern) => {
  const result = await suggested(bytes);
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), pattern);
};
const coverChange = (file) => ({ id: "cover", area: "details", kind: "cover", from: null, to: { hash: "abc-12", contentType: "image/png", file } });
const backgroundChange = { id: "map:background", area: "map", kind: "background", from: null, to: { kind: "image", hash: "abc", file: "files/background.json" } };

test("a suggestion the game could use is kept", async () => {
  await kept(suggestionZip());
  await kept(suggestionZip({
    changes: [
      coverChange("files/cover.png"),
      backgroundChange,
      { id: "polity-add:Narnia", area: "map", kind: "polity-add", key: "Narnia", record: { name: "Narnia" }, color: [1, 2, 3], flag: dataUrl("image/png", PNG), tags: null },
      { id: "polity-change:France", area: "map", kind: "polity-change", key: "France", fields: { flag: { from: "0123abcd", to: "https://flagcdn.com/fr.svg" } }, record: null },
      { id: "institutionLogos", area: "details", kind: "institutionLogos", from: {}, to: { league: dataUrl("image/png", PNG) } },
      { id: "something-new", area: "map", kind: "a-kind-a-newer-game-writes", to: 5 },
    ],
  }, { "files/cover.png": PNG, "files/background.json": { geojson: featureCollection() } }));
  // The game reads a bare suggestion.json too.
  await kept(Buffer.from(JSON.stringify(suggestion())));
});

test("a suggestion is refused for what the game could not read", async () => {
  await unusable(zip({ "changes.json": suggestion() }), /`world-suggestion\.zip` holds no suggestion \(`suggestion\.json` is missing\)/);
  await unusable(suggestionZip({ schema: "open-historia-scenario-suggestion/9" }), /`suggestion\.json` is not a scenario suggestion the game can read/);
  await unusable(scenarioZip(), /holds no suggestion/);
  await unusable(zip({ "suggestion.json": { ...suggestion(), changes: null, scenario: [] } }), /its `scenario` is not what the game writes there[\s\S]*has no list of changes/);
  await unusable(suggestionZip({ changes: [{ id: "x", area: "elsewhere", kind: "field" }, { area: "map", kind: "field" }] }), /has a change the game cannot read \(change 2\)[\s\S]*\(change 3\)/);
  await unusable(zip({ "suggestion.json": { ...suggestion(), changes: Array.from({ length: 20001 }, (_, index) => ({ id: `c${index}`, area: "map", kind: "region-name" })) } }), /holds 20,001 changes, and the game reads 20,000 at most/);
  await unusable(suggestionZip({ changes: [coverChange("files/cover.png")] }), /`suggestion\.json` names a file that is not in the zip \(`files\/cover\.png`\)/);
  await unusable(Buffer.from("MZ\x90\x00"), /it is not a suggestion file/);
  await unusable(rawZip([{ name: "suggestion.json", data: JSON.stringify(suggestion()), flags: 1 }]), /`world-suggestion\.zip` can't be used: it has an entry that is encrypted/);
  await unusable(suggestionZip({}, { "payload.exe": "MZ" }), /`payload\.exe` is not something the game uses/);
});

test("nothing is put right in a suggestion: what would be is a reason to refuse it", async () => {
  await unusable(suggestionZip({ changes: [coverChange("files/cover.svg")] }, { "files/cover.svg": SVG }), /`files\/cover\.svg` can't be used: it is an SVG, and an SVG cannot be used here: save it as a PNG and use that instead/);
  await unusable(suggestionZip({ changes: [coverChange("files/cover.png")] }, { "files/cover.png": Buffer.concat([PNG, Buffer.from("PK\x03\x04 more")]) }), /`files\/cover\.png` can't be used: 9 bytes follow the end of the picture/);
  await unusable(suggestionZip({ changes: [{ id: "polity-add:N", area: "map", kind: "polity-add", key: "N", flag: svgUrl }] }), /`suggestion\.json` holds a flag that can't be used \(at `changes\[1\]\.flag`\): it is an SVG, and an SVG cannot be used here: save it as a PNG/);
  await unusable(suggestionZip({ changes: [{ id: "polity-change:F", area: "map", kind: "polity-change", key: "F", fields: { flag: { from: null, to: "https://evil.example/f.png" } } }] }), /holds a flag that is loaded from another website/);
  await unusable(suggestionZip({ changes: [{ id: "institutionLogos", area: "details", kind: "institutionLogos", from: {}, to: { league: "https://evil.example/l.png" } }] }), /holds a logo that is not a picture carried in the file \(key `league`\)/);
  await unusable(suggestionZip({ changes: [backgroundChange] }, { "files/background.json": { geojson: "https://evil.example/map.geojson" } }), /the basemap in `files\/background\.json` is not a map the game can draw: it is text/i);
  await unusable(suggestionZip({ changes: [backgroundChange] }, { "files/background.json": { dataUrl: svgUrl } }), /`files\/background\.json` holds a basemap that can't be used.*it is an SVG/);
  await unusable(suggestionZip({ note: "Try [this](javascript:alert(1))" }), /`suggestion\.json` holds a script address/);
  await unusable(suggestionZip({ changes: [{ id: "f", area: "details", kind: "field", path: ["scenario", "description"], to: "![x](https://evil.example/p.png)" }] }), /shows a picture from another website/);
  await unusable(Buffer.from(JSON.stringify(suggestion({ changes: [{ id: "cover", area: "details", kind: "cover", to: { hash: "x", contentType: "image/svg+xml", base64: Buffer.from(SVG).toString("base64") } }] }))), /The cover in `world-suggestion\.zip` can't be used: it is an SVG/);
  // A flag heavier than the flag library takes cannot be made lighter here.
  await unusable(suggestionZip({ changes: [{ id: "polity-add:N", area: "map", kind: "polity-add", key: "N", flag: dataUrl("image/png", png({ width: 1100, height: 700, noise: true })) }] }), /it is 2\.\d MB, and a flag can be 2 MB at most/);
});
