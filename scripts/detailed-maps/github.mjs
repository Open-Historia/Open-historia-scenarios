// GitHub, as the detailed maps scripts need it: the posts and their comments,
// the releases the map files go in, and the files on the detailed-maps-index
// branch. Kept apart from the hub's own client (scripts/lib/github.mjs): the
// two workflows share nothing but the repository.

import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DATA_BRANCH, LABEL } from "./maps.mjs";

const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";

export class GitHubError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const createClient = ({ repo, token, dataBranch = DATA_BRANCH, fetchImpl = fetch }) => {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "open-historia-detailed-maps",
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
          headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...extraHeaders },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        if (attempt >= 4) throw new GitHubError(`GitHub could not be reached (${error?.cause?.code || error?.message || error})`);
        await sleep(1500 * attempt);
        continue;
      }
      if (response.ok || okStatuses.includes(response.status)) {
        if (response.status === 204 || response.status === 404 || method === "DELETE") return null;
        return raw ? response.text() : response.json().catch(() => null);
      }
      const limited = response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
      if ((response.status >= 500 || limited) && attempt < 4) {
        await sleep(limited ? 20000 : 1500 * attempt);
        continue;
      }
      const text = await response.text().catch(() => "");
      throw new GitHubError(`GitHub answered ${response.status} to ${method} ${url}: ${text.slice(0, 300)}`, response.status);
    }
  };

  const paged = async (url) => {
    const all = [];
    for (let page = 1; page < 100; page += 1) {
      const batch = await api("GET", `${url}${url.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      all.push(...(batch ?? []));
      if (!batch || batch.length < 100) break;
    }
    return all;
  };

  const toAsset = (asset, tag) => ({ id: asset.id, name: asset.name, size: asset.size, tag, url: asset.browser_download_url });

  return {
    repo,

    // Every detailed map post, open or closed, oldest first: when two posts ask
    // for the same ID, the older one has it.
    listPosts: async () => (await paged(`/repos/${repo}/issues?state=all&labels=${encodeURIComponent(LABEL)}&sort=created&direction=asc`))
      .filter((issue) => !issue.pull_request),

    permissionOf: async (login) => {
      const answer = await api("GET", `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`, { okStatuses: [404] });
      return answer?.permission ?? "none";
    },

    listComments: (number) => paged(`/repos/${repo}/issues/${number}/comments`),
    createComment: (number, body) => api("POST", `/repos/${repo}/issues/${number}/comments`, { body: { body } }),
    updateComment: (id, body) => api("PATCH", `/repos/${repo}/issues/comments/${id}`, { body: { body } }),

    addLabel: async (number, name) => {
      // The label has to exist, or GitHub answers 422 for the issue.
      await api("POST", `/repos/${repo}/labels`, {
        body: { name, color: "d93f0b", description: "A detailed map post with something to fix" },
        okStatuses: [422],
      });
      return api("POST", `/repos/${repo}/issues/${number}/labels`, { body: { labels: [name] } });
    },
    removeLabel: (number, name) => api("DELETE", `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(name)}`, { okStatuses: [404] }),

    // Drafts too: archived maps wait in one.
    listReleases: async () => (await paged(`/repos/${repo}/releases`)).map((release) => ({
      id: release.id,
      tag: release.tag_name,
      draft: release.draft,
      assets: (release.assets ?? []).map((asset) => toAsset(asset, release.tag_name)),
    })),

    createRelease: async ({ tag, title, notes, draft = false }) => {
      // Not "latest": the Releases page should not lead with a storage release.
      const release = await api("POST", `/repos/${repo}/releases`, {
        body: { tag_name: tag, name: title, body: notes, draft, make_latest: "false" },
      });
      return { id: release.id, tag: release.tag_name, draft: release.draft, assets: [] };
    },

    // Streamed from disk: a map is up to 500 MB.
    uploadAsset: async (release, name, file) => {
      const { size } = fs.statSync(file);
      for (let attempt = 1; ; attempt += 1) {
        const response = await fetchImpl(`${UPLOADS}/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/octet-stream", "Content-Length": String(size) },
          body: Readable.toWeb(fs.createReadStream(file)),
          duplex: "half",
        }).catch((error) => ({ ok: false, status: 0, text: async () => String(error?.message || error) }));
        if (response.ok) return toAsset(await response.json(), release.tag);
        if ((response.status >= 500 || response.status === 0) && attempt < 3) {
          await sleep(5000 * attempt);
          continue;
        }
        throw new GitHubError(`GitHub answered ${response.status} to uploading ${name}: ${(await response.text()).slice(0, 300)}`, response.status);
      }
    },

    deleteAsset: (id) => api("DELETE", `/repos/${repo}/releases/assets/${id}`, { okStatuses: [404] }),

    // A release file to disk (one in a draft release too, which needs the token).
    downloadAsset: async (asset, dest) => {
      const response = await fetchImpl(`${API}/repos/${repo}/releases/assets/${asset.id}`, {
        headers: { ...headers, Accept: "application/octet-stream" },
      });
      if (!response.ok) throw new GitHubError(`GitHub answered ${response.status} to downloading ${asset.name}`, response.status);
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(dest));
    },

    // A JSON file from the data branch, or null before the first run.
    readData: async (file) => {
      try {
        const text = await api("GET", `/repos/${repo}/contents/${file}?ref=${encodeURIComponent(dataBranch)}`, {
          raw: true,
          extraHeaders: { Accept: "application/vnd.github.raw+json" },
        });
        return text == null ? null : JSON.parse(text);
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    },

    // One commit on the data branch with these files (path -> text), on top of
    // what is there, so the list keeps its history. The branch is made the
    // first time.
    writeData: async (files, message) => {
      const ref = await api("GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(dataBranch)}`, { okStatuses: [404] });
      const parent = ref?.object?.sha ?? null;
      const base = parent ? (await api("GET", `/repos/${repo}/git/commits/${parent}`)).tree.sha : undefined;
      const tree = await api("POST", `/repos/${repo}/git/trees`, {
        body: {
          ...(base ? { base_tree: base } : {}),
          tree: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })),
        },
      });
      if (base && tree.sha === base) return false;
      const commit = await api("POST", `/repos/${repo}/git/commits`, {
        body: { message, tree: tree.sha, parents: parent ? [parent] : [] },
      });
      if (parent) await api("PATCH", `/repos/${repo}/git/refs/heads/${encodeURIComponent(dataBranch)}`, { body: { sha: commit.sha } });
      else await api("POST", `/repos/${repo}/git/refs`, { body: { ref: `refs/heads/${dataBranch}`, sha: commit.sha } });
      return true;
    },
  };
};
