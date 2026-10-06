// An SVG is never released: every one becomes a PNG.
//
// An SVG is not a picture but instructions for drawing one, and those can say
// "run this script", "load that address" or "read this file". In a game that
// shows it, the first two reach the player; here, the third reaches the machine
// the workflow runs on. So an SVG is drawn once, here, and what is released is
// the drawing.
//
// The renderer (resvg) never runs script and ignores foreignObject. What it
// does do, and what this file is for:
//
//   - it reads local files: an <image>, an <feImage> or a pattern whose address
//     is a path on the machine (absolute, or relative to where the renderer
//     runs) has that picture, or that SVG, drawn into the output. So before it
//     sees an SVG, every address in it is blanked unless it points inside the
//     SVG itself (#name) or carries a picture in itself (a data: address of a
//     PNG, JPEG, GIF or WebP); and the renderer runs in an empty folder;
//   - it expands entities, and an entity may hold markup, so an address can be
//     hidden in one. So the DOCTYPE is taken out first, and only entities that
//     are plain text (the namespace shorthands drawing programs write) are put
//     back, as text;
//   - drawn at the size it says it has, an SVG can ask for more memory than
//     there is, and that ends the process instead of throwing. So the drawing
//     happens in another process (svg-worker.mjs), at a size chosen here, with
//     a limit on its time and its memory.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FrameReader, frame } from "./frames.mjs";
import { imageType, readImage } from "./images.mjs";
import { BYTE_ORDER_MARK, MIB, Problem, utf8OrNull } from "./util.mjs";

const cannotDraw = (why) => new Problem(`it is an SVG the hub could not draw, so it cannot be turned into a PNG (${why}). Save it as a PNG and attach that instead`);
// Why the renderer could not draw an SVG, in words of this file's own. The
// renderer's words are not passed on: they quote the names the SVG uses, and
// what an author's file says must not be what a comment on GitHub says.
const rendererSaid = (error) => {
  const said = String(error ?? "");
  if (/pars|token|entit|xml|element|attribute|namespace|unexpected|malformed|utf-?8|root node/i.test(said)) return "it is not well-formed SVG";
  if (/\bsize\b|width|height|dimension/i.test(said)) return "it has no size the renderer can use";
  return "the renderer could not read it";
};

// ---- is it an SVG? ------------------------------------------------------------

// What may come before an SVG's first element: a byte order mark, an XML
// declaration, comments, processing instructions and a DOCTYPE, which can be
// long (drawing programs list their namespaces in it). Looked for in the first
// part of the file only.
const PROLOG_LIMIT = 256 * 1024;
export const looksLikeSvg = (bytes) => {
  const marked = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const text = bytes.toString("latin1", marked ? 3 : 0, Math.min(bytes.length, PROLOG_LIMIT));
  let at = 0;
  for (;;) {
    while (at < text.length && /\s/.test(text[at])) at += 1;
    if (text.startsWith("<?", at)) {
      const end = text.indexOf("?>", at);
      if (end < 0) return false;
      at = end + 2;
    } else if (text.startsWith("<!--", at)) {
      const end = text.indexOf("-->", at);
      if (end < 0) return false;
      at = end + 3;
    } else if (/^<!DOCTYPE/i.test(text.slice(at, at + 9))) {
      const end = doctypeEnd(text, at);
      if (end < 0) return false;
      at = end;
    } else {
      return /^<(?:[A-Za-z_][\w.-]*:)?svg[\s>/]/.test(text.slice(at, at + 80));
    }
  }
};

// Where a DOCTYPE that starts at `start` ends: at the first ">" that is not
// inside a quoted string or inside its [ ... ] of declarations. -1 when it
// never does.
const doctypeEnd = (text, start) => {
  let depth = 0;
  for (let at = start + 9; at < text.length; at += 1) {
    const char = text[at];
    if (char === '"' || char === "'") {
      const close = text.indexOf(char, at + 1);
      if (close < 0) return -1;
      at = close;
    } else if (char === "[") depth += 1;
    else if (char === "]") depth -= 1;
    else if (char === "<" && text.startsWith("<!--", at)) {
      const close = text.indexOf("-->", at + 4);
      if (close < 0) return -1;
      at = close + 2;
    } else if (char === ">" && depth <= 0) return at + 1;
  }
  return -1;
};

// ---- making an SVG safe to draw -----------------------------------------------

const PREDEFINED = new Set(["amp", "lt", "gt", "quot", "apos"]);
// An entity whose value is plain text: no markup, no reference to another
// entity. Anything else declared in a DOCTYPE is simply not carried over, and
// a reference to it then fails the drawing.
const PLAIN_ENTITY = /<!ENTITY\s+([A-Za-z_][\w.-]*)\s+(?:"([^"<&%]*)"|'([^'<&%]*)')\s*>/g;
const escapeXml = (text) => text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);
const MAX_SVG_TEXT = 64 * MIB;

// An address that stays: a name inside the SVG, or a picture carried in the
// address itself. Decided on the text as written: an address that only becomes
// one of these after a reference is expanded ("&#100;ata:…", "&e;") does not
// pass.
const LOCAL_NAME = /^#[\w.:-]+$/;
const INLINE_PICTURE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=\s]*)$/i;
// Any attribute whose name ends in "href" or "src", whatever its prefix
// (xlink:href, a:href). It also finds text that only looks like one, in a
// comment or a value; blanking that harms nothing.
const ADDRESS_ATTRIBUTE = /(href|src)(\s*=\s*)("[^"]*"|'[^']*')/gi;
// url(...) in a style, wherever it stands: kept when it names something
// inside the SVG, and made to name nothing otherwise. Each "url(" is taken to
// its ")" and the next looked for after that, so the text is read once however
// many there are (one pattern for the whole of "url(...)" reads an SVG made of
// "url(" again from every one of them).
const LOCAL_URL = /^(?:(["'])#[\w.:-]+\1|&quot;#[\w.:-]+&quot;|&apos;#[\w.:-]+&apos;|#[\w.:-]+)$/;
const blankUrls = (text) => {
  const opening = /url\(/gi;
  let out = "";
  let done = 0;
  for (let match = opening.exec(text); match; match = opening.exec(text)) {
    const close = text.indexOf(")", match.index);
    if (close < 0) break; // never closed, and so is nothing after it
    const target = text.slice(match.index + 4, close).trim();
    out += `${text.slice(done, match.index)}${target.length < 300 && LOCAL_URL.test(target) ? text.slice(match.index, close + 1) : "url(#_)"}`;
    done = close + 1;
    opening.lastIndex = done;
  }
  return out + text.slice(done);
};

// The most pixels the pictures carried inside one SVG may add up to: each is
// decoded in full to be drawn.
const MAX_INLINE_PIXELS = 64e6;

// The SVG as it is handed to the renderer, and whether it has text in it (the
// renderer is given no fonts, so text that was not turned into shapes is left
// out of the drawing). Throws a Problem for an SVG that cannot be made safe.
export const sanitizeSvg = (input) => {
  let text = typeof input === "string" ? input : utf8OrNull(input);
  if (text === null) throw cannotDraw("it is not UTF-8 text");
  if (text.startsWith(BYTE_ORDER_MARK)) text = text.slice(1);
  if (text.includes("\x00")) throw cannotDraw("it is not text");

  const start = text.search(/<!DOCTYPE/i);
  if (start >= 0) {
    const end = doctypeEnd(text, start);
    if (end < 0) throw cannotDraw("its DOCTYPE never ends");
    const entities = new Map();
    for (const [, name, double, single] of text.slice(start, end).matchAll(PLAIN_ENTITY)) {
      if (!PREDEFINED.has(name) && !entities.has(name)) entities.set(name, double ?? single ?? "");
    }
    text = text.slice(0, start) + text.slice(end);
    if (entities.size) {
      let size = text.length;
      text = text.replace(/&([A-Za-z_][\w.-]*);/g, (reference, name) => {
        if (!entities.has(name)) return reference;
        const value = escapeXml(entities.get(name));
        size += value.length;
        if (size > MAX_SVG_TEXT) throw cannotDraw("its entities expand to too much text");
        return value;
      });
    }
  }
  // Nothing may be left that declares an entity: with none declared, every
  // reference still in the text is one of XML's own five or a mistake.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw cannotDraw("it declares entities in a way the hub does not take apart");

  let pixels = 0;
  text = text.replace(ADDRESS_ATTRIBUTE, (whole, name, equals, value) => {
    const address = value.slice(1, -1).trim();
    if (LOCAL_NAME.test(address)) return whole;
    const picture = INLINE_PICTURE.exec(address);
    if (picture) {
      // A picture inside the SVG is read here first, so the renderer is only
      // ever handed one that is whole and of a size it can decode.
      try {
        const bytes = Buffer.from(picture[2], "base64");
        const { type, width, height } = readImage(bytes);
        const said = picture[1].toLowerCase();
        if (type === (said === "jpeg" ? "jpg" : said)) {
          pixels += width * height;
          return whole;
        }
      } catch {
        // Blanked, below.
      }
    }
    return `${name}${equals}""`;
  });
  if (pixels > MAX_INLINE_PIXELS) throw cannotDraw("the pictures inside it are too large");
  text = blankUrls(text);

  return { svg: text, hasText: /<(?:[A-Za-z_][\w.-]*:)?text[\s>]/.test(text) };
};

// ---- the drawing process ------------------------------------------------------

const WORKER = fileURLToPath(new URL("./svg-worker.mjs", import.meta.url));
const DRAW_TIMEOUT_MS = 20000;

// An empty folder for the renderer to run in: an address that is a relative
// path leads nowhere from there, should one ever get past the blanking.
let emptyFolder = null;
const rendererFolder = () => {
  if (!emptyFolder) {
    emptyFolder = fs.mkdtempSync(path.join(os.tmpdir(), "hub-svg-"));
    process.once("exit", () => {
      try {
        fs.rmdirSync(emptyFolder);
      } catch {
        // Still the folder of a renderer that has not gone yet: left behind, empty.
      }
    });
  }
  return emptyFolder;
};

// Starts svg-worker.mjs when the first SVG needs drawing and keeps it for the
// next ones; a drawing that takes too long, or takes the process down, fails
// that one SVG, and the next gets a new process.
export class Rasteriser {
  #child = null;
  #waiting = null; // { resolve, reject, timer, header }
  #queue = Promise.resolve();
  #timeoutMs;
  #memoryMb;

  constructor({ timeoutMs = DRAW_TIMEOUT_MS, memoryMb = 1536 } = {}) {
    this.#timeoutMs = timeoutMs;
    this.#memoryMb = memoryMb;
  }

  #start() {
    const child = spawn(process.execPath, ["--max-old-space-size=1024", WORKER], {
      cwd: rendererFolder(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // The renderer has no use for the token this process may hold.
      env: { ...process.env, HUB_SVG_MEMORY_MB: String(this.#memoryMb), GITHUB_TOKEN: "", GH_TOKEN: "" },
    });
    const reader = new FrameReader();
    let complaint = "";
    child.stdout.on("data", (chunk) => {
      reader.push(chunk);
      for (let message = reader.take(); message; message = reader.take()) this.#received(message);
    });
    child.stderr.on("data", (chunk) => {
      complaint = `${complaint}${chunk}`.slice(-400);
    });
    child.stdin.on("error", () => {}); // the process went away mid-write: "exit" says so
    const gone = (why) => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#fail(why);
    };
    child.on("error", (error) => gone(`the renderer could not be started: ${error?.message || error}`));
    // "close", not "exit": by then everything it wrote has been read, so an
    // answer it gave just before leaving is not taken for a failure.
    child.on("close", (code, signal) => {
      const reason = /memory allocation/i.test(complaint) || code === 70
        ? "it needs more memory than a drawing may take"
        : `the renderer stopped${signal ? ` (${signal})` : code ? ` (code ${code})` : ""}`;
      gone(reason);
    });
    // While nothing is being drawn the process must not keep this one alive: a
    // drawing in progress holds it open with its own timer instead.
    child.unref();
    for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe.unref?.();
    this.#child = child;
  }

  #received(message) {
    const waiting = this.#waiting;
    if (!waiting) return;
    if (!waiting.header) {
      try {
        waiting.header = JSON.parse(message.toString("utf8"));
      } catch {
        waiting.header = { ok: false, error: "the renderer answered with something else" };
      }
      return;
    }
    this.#waiting = null;
    clearTimeout(waiting.timer);
    // After a large drawing the process says it is leaving: the next drawing
    // must start a new one rather than write to one that is on its way out.
    if (waiting.header.leaving) this.#child = null;
    if (waiting.header.ok) waiting.resolve({ ...waiting.header, png: Buffer.from(message) });
    else waiting.reject(cannotDraw(rendererSaid(waiting.header.error)));
  }

  #fail(why) {
    const waiting = this.#waiting;
    if (!waiting) return;
    this.#waiting = null;
    clearTimeout(waiting.timer);
    waiting.reject(cannotDraw(why));
  }

  #one(request) {
    return new Promise((resolve, reject) => {
      if (!this.#child) this.#start();
      const child = this.#child;
      const timer = setTimeout(() => {
        // Not asked to stop, stopped: a drawing that hangs is not listening.
        if (this.#child === child) this.#child = null;
        child.kill("SIGKILL");
        this.#fail(`drawing it took more than ${Math.round(this.#timeoutMs / 1000)} seconds`);
      }, this.#timeoutMs);
      this.#waiting = { resolve, reject, timer, header: null };
      child.stdin.write(frame(Buffer.from(JSON.stringify(request))));
    });
  }

  // { png, width, height, sourceWidth, sourceHeight, blank }. One at a time.
  draw(request) {
    const result = this.#queue.then(() => this.#one(request));
    this.#queue = result.catch(() => {});
    return result;
  }

  close() {
    const child = this.#child;
    this.#child = null;
    child?.stdin.end();
  }
}

// A renderer that draws for one file, for so long in all. A drawing has its
// own limit (twenty seconds), and a file can hold hundreds: a dozen lines of
// SVG can keep the renderer busy for minutes, and a file made of those would
// keep a run busy for hours.
export const FILE_DRAWING_MS = 60000;
export const withinBudget = (rasteriser, budgetMs = FILE_DRAWING_MS) => {
  let spent = 0;
  return {
    draw: async (request) => {
      if (spent >= budgetMs) throw cannotDraw("the SVGs in this file together take too long to draw");
      const started = Date.now();
      try {
        return await rasteriser.draw(request);
      } finally {
        spent += Date.now() - started;
      }
    },
  };
};

let shared = null;
export const sharedRasteriser = () => (shared ??= new Rasteriser());
export const closeSharedRasteriser = () => {
  shared?.close();
  shared = null;
};

// ---- what is asked of it ------------------------------------------------------

// The PNG an SVG becomes. `longest` is the size of its longer side; with
// `exact` false the SVG keeps its own size when that is smaller (a basemap).
export const svgToPng = async (input, { longest, exact = true, rasteriser = sharedRasteriser() }) => {
  const { svg, hasText } = sanitizeSvg(input);
  const drawn = await rasteriser.draw({ svg, longest, exact });
  if (drawn.blank) throw cannotDraw("nothing is left to draw once what it loads from elsewhere is taken out");
  return { bytes: drawn.png, width: drawn.width, height: drawn.height, lostText: hasText };
};

// A PNG, JPEG or GIF drawn again as a PNG whose longer side is `longest`: how
// a flag too heavy for the game's flag library is made lighter. The renderer
// cannot read a WebP, and draws nothing for one: null says so.
export const redrawSmaller = async (bytes, { width, height, longest, rasteriser = sharedRasteriser() }) => {
  const type = imageType(bytes);
  if (!["png", "jpg", "gif"].includes(type)) return null;
  const mime = type === "jpg" ? "image/jpeg" : `image/${type}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image width="${width}" height="${height}" href="data:${mime};base64,${bytes.toString("base64")}"/></svg>`;
  const drawn = await rasteriser.draw({ svg, longest: Math.min(longest, Math.max(width, height)), exact: true });
  if (drawn.blank) return null;
  return { bytes: drawn.png, width: drawn.width, height: drawn.height };
};
