// Downloads one post attachment to a temporary file.
//
// With node:https rather than fetch: a file is streamed to disk under
// backpressure, and fetch's HTTP parser (undici) fails an internal assertion,
// taking the whole run down, when a server closes the connection while the
// stream is paused. Plain streams have no such trap.

import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

// Where a post's attachment may be downloaded from: GitHub's own hosts, and
// the storage GitHub redirects to.
const DOWNLOAD_HOSTS = /^(?:github\.com|(?:[a-z0-9-]+\.)*githubusercontent\.com|github-production-[a-z0-9-]+\.s3\.amazonaws\.com)$/i;
const HOP_TIMEOUT_MS = 180000;
const USER_AGENT = "open-historia-hub-files";

export class DownloadError extends Error {
  constructor(message, { status = 0, transient = true } = {}) {
    super(message);
    this.status = status;
    this.transient = transient;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One GET, redirects not followed: resolves with the response (a stream).
const get = (url) => new Promise((resolve, reject) => {
  const request = https.get(url, { headers: { "User-Agent": USER_AGENT, Accept: "*/*" }, timeout: HOP_TIMEOUT_MS }, resolve);
  request.on("timeout", () => request.destroy(new Error("timed out")));
  request.on("error", reject);
});

const attempt = async (source, maxBytes) => {
  let current = new URL(source);
  let response;
  for (let hop = 0; ; hop += 1) {
    if (current.protocol !== "https:" || !DOWNLOAD_HOSTS.test(current.hostname)) {
      throw new DownloadError("it is not hosted by GitHub", { transient: false });
    }
    response = await get(current);
    const status = response.statusCode ?? 0;
    if (status < 300 || status >= 400) break;
    response.resume(); // a redirect's body is nothing we want
    const location = response.headers.location;
    if (!location || hop >= 5) throw new DownloadError("it redirects too many times", { transient: false });
    current = new URL(location, current);
  }
  const status = response.statusCode ?? 0;
  if (status < 200 || status >= 300) {
    response.resume();
    // Gone is gone; anything else may pass.
    throw new DownloadError(`GitHub answered ${status}`, { status, transient: ![401, 403, 404, 410].includes(status) });
  }
  const declared = Number(response.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.destroy();
    return { file: null, size: declared, sha256: "", head: Buffer.alloc(0), tooLarge: true };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-file-"));
  const file = path.join(dir, "download");
  const hash = crypto.createHash("sha256");
  let size = 0;
  let head = Buffer.alloc(0);
  let tooLarge = false;
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(file);
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          tooLarge = true;
          response.destroy();
          out.destroy();
          resolve();
          return;
        }
        if (head.length < 512) head = Buffer.concat([head, chunk]).subarray(0, 512);
        hash.update(chunk);
      });
      response.on("error", reject);
      response.on("aborted", () => reject(new Error("the connection was cut")));
      out.on("error", reject);
      out.on("finish", resolve);
      response.pipe(out);
    });
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  if (tooLarge) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { file: null, size, sha256: "", head: Buffer.alloc(0), tooLarge: true };
  }
  if (Number.isFinite(declared) && declared !== size) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new DownloadError(`the download stopped at ${size} of ${declared} bytes`);
  }
  return { file, size, sha256: hash.digest("hex"), head };
};

// { file, size, sha256, head }, or { tooLarge: true, size } for a file over
// `maxBytes`. Tried three times when the failure may pass; throws a
// DownloadError whose `transient` says whether trying later could help.
export const downloadFile = async (source, { maxBytes }) => {
  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt(source, maxBytes);
    } catch (error) {
      const transient = error instanceof DownloadError ? error.transient : true;
      if (!transient || tries >= 3) {
        throw error instanceof DownloadError ? error : new DownloadError(String(error?.code || error?.message || error));
      }
      await sleep(2000 * tries);
    }
  }
};

export const discardFile = (file) => {
  if (file) fs.rmSync(path.dirname(file), { recursive: true, force: true });
};
