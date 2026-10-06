// Draws SVGs as PNGs, in a process of its own (see svg.mjs, which starts it and
// talks to it). An SVG is a program for a renderer, and a hostile one can ask
// for more memory than the machine has, which ends the process rather than
// throwing, or keep it busy for good. Here that costs this process, and the one
// file it was drawing.
//
// In:  one message per drawing: JSON { svg, longest, exact }
// Out: two messages per drawing: JSON { ok, width, height, … } or
//      { ok: false, error }, and then the PNG (empty when there is none)
// (frames.mjs says what a message is.)

import { Resvg, renderAsync } from "@resvg/resvg-js";
import { FrameReader, frame } from "./frames.mjs";

const MEMORY_LIMIT = (Number(process.env.HUB_SVG_MEMORY_MB) || 1536) * 1024 * 1024;
// After a drawing this large the process is not kept: what it took is not all
// given back, and the next drawing would start close to the limit.
const KEEP_BELOW = MEMORY_LIMIT / 3;

// No fonts of the machine's: what is drawn must not depend on where it is
// drawn. Text that was not turned into shapes is left out (svg.mjs says so).
const OPTIONS = { font: { loadSystemFonts: false }, logLevel: "off" };

let drawing = false;
// The drawing itself runs on another thread (renderAsync), so this still ticks
// while it does, and can end a drawing that is eating the machine.
setInterval(() => {
  if (drawing && process.memoryUsage.rss() > MEMORY_LIMIT) process.exit(70);
}, 20).unref();

const reply = (header, png = Buffer.alloc(0)) => new Promise((resolve) => {
  process.stdout.write(Buffer.concat([frame(Buffer.from(JSON.stringify(header))), frame(png)]), resolve);
});

const draw = async ({ svg, longest, exact }) => {
  // The size first, without drawing: an SVG may say it is 200,000 pixels wide,
  // and drawing it at that size is the allocation that ends the process.
  const { width, height } = new Resvg(svg, { ...OPTIONS, fitTo: { mode: "original" } });
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) throw new Error("it has no size");
  const larger = Math.max(width, height);
  // `exact`: the longer side becomes `longest`, up or down (a flag, a cover).
  // Otherwise the SVG keeps its own size unless it is larger (a basemap).
  const scale = exact || larger > longest ? longest / larger : 1;
  const fitTo = width >= height
    ? { mode: "width", value: Math.max(1, Math.round(width * scale)) }
    : { mode: "height", value: Math.max(1, Math.round(height * scale)) };
  const image = await renderAsync(svg, { ...OPTIONS, fitTo });
  const pixels = image.pixels;
  let blank = true;
  for (let at = 3; at < pixels.length; at += 4) {
    if (pixels[at]) {
      blank = false;
      break;
    }
  }
  return { header: { ok: true, width: image.width, height: image.height, sourceWidth: width, sourceHeight: height, blank }, png: image.asPng() };
};

const incoming = new FrameReader();
let working = Promise.resolve();
process.stdin.on("data", (chunk) => {
  incoming.push(chunk);
  for (let request = incoming.take(); request; request = incoming.take()) {
    const bytes = request;
    working = working.then(async () => {
      drawing = true;
      let answer;
      try {
        answer = await draw(JSON.parse(bytes.toString("utf8")));
      } catch (error) {
        answer = { header: { ok: false, error: String(error?.message || error).slice(0, 300) } };
      }
      drawing = false;
      // Said in the answer, so nothing more is sent to a process that is
      // about to go.
      const leaving = process.memoryUsage.rss() > KEEP_BELOW;
      await reply({ ...answer.header, leaving }, answer.png);
      if (leaving) process.exit(0);
    });
  }
});
// Whoever asked has gone (or was stopped for taking too long over its file):
// there is nobody to answer, and a drawing still going is not finished.
process.stdin.on("end", () => process.exit(0));
