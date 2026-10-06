// GitHub, as lib/sync.mjs needs it: the posts and their comments, the releases
// and their files, labels, closing and reopening, and the two data files on the
// `hub-index` branch.
//
//   createClient({ repo, token, dataBranch, dryRun })
//
// With `dryRun`, everything is read and every file is downloaded and checked,
// but nothing is changed: no release, no upload, no comment made or deleted,
// no post closed, no commit. What would have been done is logged instead.

import fs from "node:fs";
import { discardFile, downloadFile } from "./download.mjs";
import { MAX_FILE_BYTES } from "./posts.mjs";

const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";

export class GitHubError extends Error {
  constructor(message, { status = 0, transient = true } = {}) {
    super(message);
    this.status = status;
    this.transient = transient;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const createClient = ({ repo, token, dataBranch = "hub-index", dryRun = false, log = console.log, fetchImpl = fetch }) => {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "open-historia-hub-files",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  // One API call, retried while GitHub is unwell or asks to slow down.
  const api = async (method, url, { body, raw = false, extraHeaders = {}, okStatuses = [] } = {}) => {
    const target = url.startsWith("http") ? url : `${API}${url}`;
    for (let attempt = 1; ; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(target, {
          method,
          headers: { ...headers, ...(body !== undefined && !Buffer.isBuffer(body) ? { "Content-Type": "application/json" } : {}), ...extraHeaders },
          body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
        });
      } catch (error) {
        if (attempt >= 4) throw new GitHubError(`GitHub could not be reached (${error?.cause?.code || error?.message || error})`);
        await sleep(1500 * attempt);
        continue;
      }
      if (response.ok || okStatuses.includes(response.status)) {
        if (response.status === 204 || method === "DELETE") return null;
        return raw ? response.text() : response.json().catch(() => null);
      }
      const limited = response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
      if ((response.status >= 500 || limited) && attempt < 4) {
        await sleep(limited ? 20000 : 1500 * attempt);
        continue;
      }
      const detail = await response.text().catch(() => "");
      throw new GitHubError(`${method} ${target.replace(API, "")} answered ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`, {
        status: response.status,
        transient: response.status >= 500 || limited,
      });
    }
  };

  // Every page of a list. A list longer than `maxPages` pages is an error, not
  // a short list: what a run does not see, it would take for gone.
  const paged = async (url, { maxPages = 200 } = {}) => {
    const items = [];
    for (let page = 1; ; page += 1) {
      if (page > maxPages) throw new GitHubError(`${url} is longer than ${maxPages} pages`, { transient: false });
      const batch = await api("GET", `${url}${url.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      if (!Array.isArray(batch) || !batch.length) break;
      items.push(...batch);
      if (batch.length < 100) break;
    }
    return items;
  };

  const toAsset = (asset) => ({
    id: asset.id,
    name: asset.name,
    url: asset.browser_download_url,
    size: asset.size,
    downloads: Number(asset.download_count) || 0,
  });

  const would = (what) => log(`[dry run] would ${what}`);
  let fakeId = -1;

  return {
    repo,
    dryRun,

    // Every post with this label, open or closed: a released post is closed
    // (when the hub closes them), and its author may still update it.
    listPosts: (label) => paged(`/repos/${repo}/issues?state=all&labels=${encodeURIComponent(label)}`),

    // null once the post is gone (deleted, or moved to another repository).
    getIssue: async (number) => {
      try {
        return await api("GET", `/repos/${repo}/issues/${number}`);
      } catch (error) {
        if (error.status === 404 || error.status === 410 || error.status === 301) return null;
        throw error;
      }
    },

    closeIssue: async (number) => {
      if (dryRun) return would(`close #${number} as completed`);
      return api("PATCH", `/repos/${repo}/issues/${number}`, { body: { state: "closed", state_reason: "completed" } });
    },
    reopenIssue: async (number) => {
      if (dryRun) return would(`reopen #${number}`);
      return api("PATCH", `/repos/${repo}/issues/${number}`, { body: { state: "open" } });
    },

    listReleases: async () => (await paged(`/repos/${repo}/releases`))
      .filter((release) => !release.draft)
      .map((release) => ({ id: release.id, tag: release.tag_name, assets: (release.assets ?? []).map(toAsset) })),

    createRelease: async ({ tag, title, notes }) => {
      if (dryRun) {
        would(`create the release ${tag}`);
        return { id: fakeId--, tag, assets: [] };
      }
      // Not "latest": the Releases page should not lead with a storage release.
      const release = await api("POST", `/repos/${repo}/releases`, {
        body: { tag_name: tag, name: title, body: notes, make_latest: "false" },
      });
      return { id: release.id, tag: release.tag_name, assets: [] };
    },

    // `bytes` are the checked ones: what is uploaded is what was looked at.
    uploadAsset: async (releaseId, { name, contentType, bytes, tag = "dry-run" }) => {
      if (dryRun) {
        would(`upload ${name} (${bytes.length} bytes)`);
        return { id: fakeId--, name, url: `https://github.com/${repo}/releases/download/${tag}/${name}`, size: bytes.length, downloads: 0 };
      }
      const asset = await api("POST", `${UPLOADS}/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, {
        body: bytes,
        extraHeaders: { "Content-Type": contentType },
      });
      return toAsset(asset);
    },

    deleteAsset: async (assetId) => {
      if (dryRun) return would(`delete the release file ${assetId}`);
      return api("DELETE", `/repos/${repo}/releases/assets/${assetId}`, { okStatuses: [404] });
    },

    // An attachment's bytes: { bytes, size, sha256 }, or { tooLarge: true,
    // size } for one over `maxBytes`. Saved to a temporary file on the way
    // (lib/download.mjs) and read from there. Never sent the token: these are
    // public, and some are served from outside GitHub.
    download: async (url, { maxBytes = MAX_FILE_BYTES } = {}) => {
      const downloaded = await downloadFile(url, { maxBytes });
      if (downloaded.tooLarge) return { tooLarge: true, size: downloaded.size };
      try {
        return { bytes: fs.readFileSync(downloaded.file), size: downloaded.size, sha256: downloaded.sha256 };
      } finally {
        discardFile(downloaded.file);
      }
    },

    // The comments on issues that were made or edited since `since` (an ISO
    // time; all of them without one), oldest change first: how suggestions
    // are found without reading every post's comments on every run.
    listComments: (since) => paged(`/repos/${repo}/issues/comments?sort=updated&direction=asc${since ? `&since=${encodeURIComponent(since)}` : ""}`),
    listPostComments: (number) => paged(`/repos/${repo}/issues/${number}/comments`),

    createComment: async (number, body) => {
      if (dryRun) {
        would(`comment on #${number}:\n${body}`);
        return { id: fakeId-- };
      }
      const comment = await api("POST", `/repos/${repo}/issues/${number}/comments`, { body: { body } });
      return { id: comment.id };
    },
    updateComment: async (id, body) => {
      if (dryRun) return would(`update the comment ${id}:\n${body}`);
      return api("PATCH", `/repos/${repo}/issues/comments/${id}`, { body: { body } });
    },
    deleteComment: async (id) => {
      if (dryRun) return would(`delete the comment ${id}`);
      return api("DELETE", `/repos/${repo}/issues/comments/${id}`, { okStatuses: [404] });
    },

    addLabel: async (number, name) => {
      if (dryRun) return would(`label #${number} "${name}"`);
      // The label has to exist, or GitHub answers 422 for the issue.
      await api("POST", `/repos/${repo}/labels`, {
        body: { name, color: "d93f0b", description: "The file attached to this post could not be added to the hub" },
        okStatuses: [422],
      });
      return api("POST", `/repos/${repo}/issues/${number}/labels`, { body: { labels: [name] } });
    },
    removeLabel: async (number, name) => {
      if (dryRun) return would(`remove the label "${name}" from #${number}`);
      return api("DELETE", `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(name)}`, { okStatuses: [404] });
    },

    // A data file from the hub-index branch, or null before the first run.
    readData: async (file) => {
      try {
        const text = await api("GET", `/repos/${repo}/contents/${file}?ref=${encodeURIComponent(dataBranch)}`, {
          raw: true,
          extraHeaders: { Accept: "application/vnd.github.raw+json" },
        });
        return JSON.parse(text);
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    },

    // Replaces the branch with ONE commit holding these files. The branch is
    // data, rewritten every half hour: its history would only be weight for
    // everyone who clones the repository, so it keeps none.
    writeData: async (files) => {
      if (dryRun) return would(`write ${Object.keys(files).join(" and ")} to the ${dataBranch} branch`);
      const tree = [];
      for (const [name, content] of Object.entries(files)) {
        const blob = await api("POST", `/repos/${repo}/git/blobs`, { body: { content, encoding: "utf-8" } });
        tree.push({ path: name, mode: "100644", type: "blob", sha: blob.sha });
      }
      tree.push({
        path: "README.md",
        mode: "100644",
        type: "blob",
        content: [
          "# Hub index",
          "",
          "Written by the **Copy post files to releases** workflow; do not edit by hand.",
          "",
          "- `index.json`: what the game reads. The hub's released posts, where the checked copy of each of their files is in the releases, how many times each scenario's file has been downloaded, and which suggestions passed the checks.",
          "- `state.json`: the workflow's own notes.",
          "",
        ].join("\n"),
      });
      const created = await api("POST", `/repos/${repo}/git/trees`, { body: { tree } });
      const commit = await api("POST", `/repos/${repo}/git/commits`, {
        body: { message: "Update the hub index", tree: created.sha, parents: [] },
      });
      try {
        await api("PATCH", `/repos/${repo}/git/refs/heads/${dataBranch}`, { body: { sha: commit.sha, force: true } });
      } catch (error) {
        if (error.status !== 422 && error.status !== 404) throw error;
        await api("POST", `/repos/${repo}/git/refs`, { body: { ref: `refs/heads/${dataBranch}`, sha: commit.sha } });
      }
      return null;
    },
  };
};
