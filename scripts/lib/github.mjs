// GitHub, as lib/sync.mjs needs it: the posts, the releases and their files,
// comments and labels, and the two data files on the `hub-index` branch.
//
//   createClient({ repo, token, dataBranch, dryRun })
//
// With `dryRun`, everything is read and every file is downloaded and checked,
// but nothing is changed: no release, no upload, no comment, no commit. What
// would have been done is logged instead.

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

  const paged = async (url) => {
    const items = [];
    for (let page = 1; page <= 50; page += 1) {
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

    listOpenPosts: (kind) => paged(`/repos/${repo}/issues?state=open&labels=${encodeURIComponent(kind)}`),

    // null once the post is gone (deleted, or moved to another repository).
    getIssue: async (number) => {
      try {
        return await api("GET", `/repos/${repo}/issues/${number}`);
      } catch (error) {
        if (error.status === 404 || error.status === 410 || error.status === 301) return null;
        throw error;
      }
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

    uploadAsset: async (releaseId, { name, contentType, file }) => {
      if (dryRun) {
        would(`upload ${name} (${fs.statSync(file).size} bytes)`);
        return { id: fakeId--, name, url: `https://github.com/${repo}/releases/download/dry-run/${name}`, size: fs.statSync(file).size, downloads: 0 };
      }
      const asset = await api("POST", `${UPLOADS}/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, {
        body: fs.readFileSync(file),
        extraHeaders: { "Content-Type": contentType },
      });
      return toAsset(asset);
    },

    deleteAsset: async (assetId) => {
      if (dryRun) return would(`delete the release file ${assetId}`);
      return api("DELETE", `/repos/${repo}/releases/assets/${assetId}`, { okStatuses: [404] });
    },

    // A post's attachment, saved to a temporary file (lib/download.mjs). Never
    // sent the token: these are public, and some are served from outside GitHub.
    download: (url, { maxBytes = MAX_FILE_BYTES } = {}) => downloadFile(url, { maxBytes }),
    discard: async (file) => discardFile(file),

    createComment: async (number, body) => {
      if (dryRun) {
        would(`comment on #${number}:\n${body}`);
        return { id: fakeId-- };
      }
      const comment = await api("POST", `/repos/${repo}/issues/${number}/comments`, { body: { body } });
      return { id: comment.id };
    },
    updateComment: async (id, body) => {
      if (dryRun) return would(`update the comment ${id}`);
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
          "- `index.json`: where the game finds each post's file in the releases, and how many times each scenario's file has been downloaded.",
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
