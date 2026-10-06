// Run: npm test
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";

import { readImage } from "../lib/images.mjs";
import { Rasteriser, closeSharedRasteriser, looksLikeSvg, redrawSmaller, sanitizeSvg, sharedRasteriser, svgToPng } from "../lib/svg.mjs";
import { Problem } from "../lib/util.mjs";
import { REAL_JPEG, SVG, gif, pixelsOfColor, png, webp } from "./fixtures.mjs";

after(() => closeSharedRasteriser());

const RED = [200, 30, 30];
const GREEN = [20, 180, 60];
const svg = (inside, attributes = 'width="90" height="60"') => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attributes}>${inside}</svg>`;
const redBox = '<rect width="30" height="60" fill="#c81e1e"/>';

// A picture on this machine's disk that no SVG may get at: all green, so one
// green pixel in a drawing means it was read.
const folder = fs.mkdtempSync(path.join(os.tmpdir(), "hub-svg-test-"));
const secret = path.join(folder, "secret.png");
fs.writeFileSync(secret, png({ width: 64, height: 64, color: [...GREEN, 255] }));
after(() => fs.rmSync(folder, { recursive: true, force: true }));
const secretPath = secret.replace(/\\/g, "/");
const secretUrl = pathToFileURL(secret).href;

test("an SVG is told by what it starts with", () => {
  assert.ok(looksLikeSvg(Buffer.from(SVG)));
  assert.ok(looksLikeSvg(Buffer.from(`\xef\xbb\xbf<?xml version="1.0" encoding="UTF-8"?>\n<!-- made by hand -->\n${SVG}`, "latin1")));
  // A drawing program's DOCTYPE, longer than anything a short look would get past.
  const entities = Array.from({ length: 40 }, (_, index) => `\t<!ENTITY ns_${index} "http://ns.example.com/${"x".repeat(30)}/${index}/">`).join("\n");
  assert.ok(looksLikeSvg(Buffer.from(`<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [\n${entities}\n]>\n${SVG}`)));
  assert.ok(!looksLikeSvg(Buffer.from("<!DOCTYPE html><html><body><svg></svg></body></html>")));
  assert.ok(!looksLikeSvg(Buffer.from('{"svg":"<svg>"}')));
  assert.ok(!looksLikeSvg(png()));
});

test("an address in an SVG is blanked unless it is a name inside the SVG or a picture carried in it", () => {
  const picture = `data:image/png;base64,${png().toString("base64")}`;
  const kept = svg(`<defs><g id="a.b-1"/></defs><use xlink:href="#a.b-1"/><use href='#a.b-1'/><image href="${picture}"/>`);
  assert.equal(sanitizeSvg(kept).svg, kept);

  const blanked = (inside) => {
    const { svg: out } = sanitizeSvg(svg(inside));
    assert.doesNotMatch(out, /secret|example\.com|javascript/, inside);
    return out;
  };
  blanked(`<image href="${secretUrl}"/>`);
  blanked(`<image xlink:href="${secretPath}"/>`);
  blanked(`<image xmlns:a="http://www.w3.org/1999/xlink" a:href='${secretUrl}'/>`);
  blanked(`<image href\n=\t"${secretPath}"/>`);
  blanked('<image href="https://example.com/track.png"/>');
  blanked('<a href="javascript:alert(1)"><rect/></a>');
  blanked(`<filter id="f"><feImage href="${secretPath}"/></filter>`);
  // What only becomes an allowed address once a reference is expanded does not pass.
  assert.match(blanked(`<image href="&#100;ata:image/png;base64,${png().toString("base64")}"/>`), /href=""/);
  assert.match(blanked('<use href="&#35;a"/>'), /href=""/);
  // A picture that is not one, or not the kind it says, is not handed on either.
  assert.match(sanitizeSvg(svg(`<image href="data:image/png;base64,${Buffer.from("<html>").toString("base64")}"/>`)).svg, /href=""/);
  assert.match(sanitizeSvg(svg(`<image href="data:image/png;base64,${REAL_JPEG.toString("base64")}"/>`)).svg, /href=""/);
  assert.match(sanitizeSvg(svg(`<image href="data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}"/>`)).svg, /href=""/);
});

test("url(...) in a style stays only when it names something inside the SVG", () => {
  const { svg: out } = sanitizeSvg(svg(`<style>.a{fill:url(#g)} .b{fill:url("#g")} .c{background:url(${secretUrl})} @import url('https://example.com/x.css');</style><rect style="fill:url('#g');mask:url(https://example.com/m.svg#m)"/>`));
  assert.equal((out.match(/url\(#_\)/g) ?? []).length, 3);
  assert.match(out, /\.a\{fill:url\(#g\)\} \.b\{fill:url\("#g"\)\}/);
  assert.match(out, /style="fill:url\('#g'\);mask:url\(#_\)"/);
  assert.doesNotMatch(out, /secret|example\.com/);
});

test("an SVG made to be slow to read is read once", () => {
  const started = Date.now();
  for (const piece of ["url(", "url(#a", "href=\"", "href='x' src=\"", "<!ENTITY ", "&a", "<text"]) {
    try {
      assert.ok(sanitizeSvg(svg(`<style>${piece.repeat(Math.ceil(2000000 / piece.length))}</style>`)).svg.length > 0, piece);
    } catch (error) {
      assert.ok(error instanceof Problem, `${piece}: ${error}`); // refused is as good, when it is quick
    }
  }
  assert.ok(Date.now() - started < 10000, `${Date.now() - started} ms`);
});

test("the DOCTYPE is taken out, and only entities that are plain text are put back", () => {
  const illustrator = `<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [\n\t<!ENTITY ns_svg "http://www.w3.org/2000/svg">\n\t<!ENTITY q 'a "quoted" &lt;word>'>\n]>\n<svg xmlns="&ns_svg;" width="9" height="6"><title>&q;</title><rect width="9" height="6"/></svg>`;
  const { svg: out } = sanitizeSvg(illustrator);
  assert.doesNotMatch(out, /DOCTYPE|ENTITY|&ns_svg;/);
  assert.match(out, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="9"/);

  // An entity that holds markup, or names another, or a file, is not put back:
  // the reference to it stays, and the renderer then refuses the SVG.
  const hidden = sanitizeSvg(`<!DOCTYPE svg [<!ENTITY e "<image href='${secretUrl}'/>"><!ENTITY x SYSTEM "${secretUrl}"><!ENTITY b "&a;&a;">]>${svg("&e;&x;&b;")}`).svg;
  assert.doesNotMatch(hidden, /secret|DOCTYPE|ENTITY/);
  assert.match(hidden, /&e;&x;&b;/);
  // An address that arrives through an entity is still an address.
  assert.match(sanitizeSvg(`<!DOCTYPE svg [<!ENTITY e "${secretUrl}">]>${svg('<image href="&e;"/>')}`).svg, /href=""/);
  assert.match(sanitizeSvg(`<!DOCTYPE svg [<!ENTITY e "href">]>${svg(`<image &e;="${secretUrl}"/>`)}`).svg, /href=""/);
  // Declarations anywhere else, or a DOCTYPE that never ends, are refused outright.
  assert.throws(() => sanitizeSvg(svg('<!DOCTYPE svg [<!ENTITY c "red">]><rect fill="&c;"/>').replace("<svg", "<!DOCTYPE a><svg")), Problem);
  assert.throws(() => sanitizeSvg(`<!DOCTYPE svg [<!ENTITY e "x">${svg("")}`), Problem);
  assert.throws(() => sanitizeSvg(Buffer.from([0xff, 0xfe, 0x3c, 0x00, 0x73, 0x00])), /not UTF-8/);
});

test("an SVG is drawn as a PNG of the size its use asks for", async () => {
  const flag = await svgToPng(Buffer.from(SVG), { longest: 1024 });
  assert.deepEqual([flag.width, flag.height, flag.lostText], [1024, 683, false]);
  assert.deepEqual(readImage(flag.bytes), { type: "png", width: 1024, height: 683, length: flag.bytes.length });
  assert.equal(pixelsOfColor(flag.bytes, RED), 1024 * 683);
  // A basemap keeps its own size, unless that is larger than a basemap may be.
  const own = await svgToPng(svg(redBox, 'width="300" height="200"'), { longest: 8192, exact: false });
  assert.deepEqual([own.width, own.height], [300, 200]);
  const tall = await svgToPng(svg(redBox, 'width="10" height="40"'), { longest: 100 });
  assert.deepEqual([tall.width, tall.height], [25, 100]);
  // Text is left out (the renderer is given no fonts), and that is said.
  const worded = await svgToPng(svg(`${redBox}<text x="40" y="30" font-size="20">Hi</text>`), { longest: 90 });
  assert.equal(worded.lostText, true);
});

test("script in an SVG is never run, and what is released is only pixels", async () => {
  const drawn = await svgToPng(svg(`<script>require("fs").writeFileSync("${secretPath}.ran", "1")</script>${redBox}<foreignObject width="90" height="60"><iframe xmlns="http://www.w3.org/1999/xhtml" src="${secretUrl}"/></foreignObject>`, 'width="90" height="60" onload="alert(1)"'), { longest: 90 });
  assert.equal(readImage(drawn.bytes).type, "png");
  assert.equal(pixelsOfColor(drawn.bytes, RED), 30 * 60);
  assert.ok(!fs.existsSync(`${secretPath}.ran`));
});

test("no SVG gets at a file on the machine that draws it", async () => {
  const picture = (attribute) => `<image width="60" height="60" x="30" ${attribute}/>`;
  // Every way found of naming a file to the renderer. Handed one of these as it
  // came, the renderer reads the file and draws it: that is checked first for
  // each, or the rest would prove nothing.
  const reads = {
    "a path": svg(`${redBox}${picture(`href="${secretPath}"`)}`),
    "a path, as Windows writes one": svg(`${redBox}${picture(`href="${secret}"`)}`),
    "under the xlink prefix": svg(`${redBox}${picture(`xlink:href="${secretPath}"`)}`),
    "under a prefix of its own": svg(`${redBox}<g xmlns:zz="http://www.w3.org/1999/xlink">${picture(`zz:href="${secretPath}"`)}</g>`),
    "written with a character reference": svg(`${redBox}${picture(`href="&#${secretPath.charCodeAt(0)};${secretPath.slice(1)}"`)}`),
    "in a filter": svg(`${redBox}<filter id="f"><feImage href="${secretPath}"/></filter><rect x="30" width="60" height="60" filter="url(#f)"/>`),
    "in a pattern": svg(`${redBox}<pattern id="p" width="60" height="60" patternUnits="userSpaceOnUse">${picture(`href="${secretPath}"`).replace(' x="30"', "")}</pattern><rect x="30" width="60" height="60" fill="url(#p)"/>`),
    "through an entity for the address": `<!DOCTYPE svg [<!ENTITY e "${secretPath}">]>${svg(`${redBox}${picture('href="&e;"')}`)}`,
    "through an entity for the whole element": `<!DOCTYPE svg [<!ENTITY e "<image width='60' height='60' x='30' href='${secretPath}'/>">]>${svg(`${redBox}&e;`)}`,
  };
  for (const [name, text] of Object.entries(reads)) {
    const unguarded = await sharedRasteriser().draw({ svg: text, longest: 90, exact: true });
    assert.ok(pixelsOfColor(unguarded.png, GREEN) > 500, `the renderer by itself reads the file: ${name}`);
    try {
      // The SVG's own red box is drawn, and the file is not.
      const drawn = await svgToPng(text, { longest: 90 });
      assert.equal(pixelsOfColor(drawn.bytes, GREEN), 0, name);
      assert.equal(pixelsOfColor(drawn.bytes, RED), 30 * 60, name);
    } catch (error) {
      // Or the SVG is refused as a whole (an entity that is not plain text).
      assert.ok(error instanceof Problem, `${name}: ${error}`);
    }
  }
  // Addresses the renderer does not follow today are blanked all the same.
  for (const address of [secretUrl, `file:${secretPath}`, "https://example.com/x.png", "//example.com/x.png", "../secret.png"]) {
    const drawn = await svgToPng(svg(`${redBox}${picture(`href="${address}"`)}`), { longest: 90 });
    assert.equal(pixelsOfColor(drawn.bytes, GREEN), 0, address);
  }
  // An SVG with nothing of its own, only what it would have loaded, is refused.
  await assert.rejects(svgToPng(svg(picture(`href="${secretPath}"`)), { longest: 90 }), /nothing is left to draw/);
  // An entity that reads a file itself fails the drawing.
  await assert.rejects(svgToPng(`<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "${secretUrl}">]>${svg(`${redBox}<text>&xxe;</text>`)}`, { longest: 90 }), Problem);
});

test("an SVG built to exhaust the machine fails by itself, and the next one is drawn", async () => {
  const bomb = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"><!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;"><!ENTITY e "&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;"><!ENTITY f "&e;&e;&e;&e;&e;&e;&e;&e;&e;&e;">]>${svg("<text>&f;</text>")}`;
  await assert.rejects(svgToPng(bomb, { longest: 90 }), Problem, "entities that multiply");
  const nodes = svg(`<defs><g id="a"><rect width="1" height="1"/></g>${Array.from({ length: 12 }, (_, level) => `<g id="l${level}">${`<use xlink:href="#${level ? `l${level - 1}` : "a"}"/>`.repeat(10)}</g>`).join("")}</defs><use xlink:href="#l11"/>`);
  await assert.rejects(svgToPng(nodes, { longest: 90 }), Problem, "elements that multiply");
  // 200,000 pixels a side: drawn at that size it would ask for 160 GB.
  const giant = svg('<rect width="200000" height="200000" fill="#c81e1e"/>', 'width="200000" height="200000"');
  const flag = await svgToPng(giant, { longest: 1024 });
  assert.deepEqual([flag.width, flag.height], [1024, 1024]);
  const basemap = await svgToPng(giant, { longest: 8192, exact: false });
  assert.deepEqual([basemap.width, basemap.height], [8192, 8192]);
  await assert.rejects(svgToPng(svg("", 'width="0" height="0"'), { longest: 90 }), Problem);
  await assert.rejects(svgToPng("<svg", { longest: 90 }), Problem);
  // A carried picture that is small to send and enormous to decode is refused
  // before the renderer sees it.
  const lying = png({ says: [20000, 20000] });
  assert.equal(readImage(lying).width, 20000);
  assert.throws(() => sanitizeSvg(svg(`${redBox}<image href="data:image/png;base64,${lying.toString("base64")}"/>`)), /too large/);
});

test("a drawing that takes too long is stopped, and costs only itself", async () => {
  const quick = new Rasteriser({ timeoutMs: 1200 });
  const slow = svg(`<defs><filter id="f"><feGaussianBlur stdDeviation="900"/><feMorphology radius="400"/><feTurbulence baseFrequency="0.9" numOctaves="12"/></filter></defs>${'<rect width="4000" height="4000" filter="url(#f)"/>'.repeat(400)}`, 'width="4000" height="4000"');
  const started = Date.now();
  await assert.rejects(svgToPng(slow, { longest: 8192, exact: false, rasteriser: quick }), /took more than/);
  assert.ok(Date.now() - started < 10000);
  const next = await svgToPng(Buffer.from(SVG), { longest: 60, rasteriser: quick });
  assert.deepEqual([next.width, next.height], [60, 40]);
  quick.close();
});

test("a picture is drawn again smaller, when the renderer can read its kind", async () => {
  const heavy = png({ width: 600, height: 400, color: [...GREEN, 255] });
  const lighter = await redrawSmaller(heavy, { width: 600, height: 400, longest: 300 });
  assert.deepEqual([lighter.width, lighter.height], [300, 200]);
  assert.equal(pixelsOfColor(lighter.bytes, GREEN), 300 * 200);
  const still = await redrawSmaller(gif({ width: 120, height: 80 }), { width: 120, height: 80, longest: 60 });
  assert.deepEqual([still.width, still.height], [60, 40]);
  assert.ok(pixelsOfColor(still.bytes, [30, 160, 60]) > 2000, "the GIF's own colour");
  const photo = await redrawSmaller(REAL_JPEG, { width: 16, height: 8, longest: 1024 });
  assert.deepEqual([photo.width, photo.height], [16, 8], "never larger than it was");
  assert.ok(pixelsOfColor(photo.bytes, [255, 255, 255]) > 30, "the JPEG's white half");
  // The renderer draws nothing for a WebP, and that is not taken for a picture.
  assert.equal(await redrawSmaller(webp(), { width: 4, height: 3, longest: 2 }), null);
});
