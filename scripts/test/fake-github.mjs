// GitHub, in memory, as the detailed maps and the background music runs use it
// (a stand-in for scripts/detailed-maps/github.mjs): posts, comments, labels,
// releases and the data branch. Nothing here reaches the network.

import assert from "node:assert/strict";
import fs from "node:fs";

export const REPO = "Open-Historia/Open-historia-scenarios";

// `label` is the label the run lists its posts by; `listFile` and `stateFile`
// are the two data files `list()` and `state()` read back.
export const fakeGitHub = ({ label, listFile, stateFile }) => {
  let nextId = 1;
  const posts = [];
  // Who put which label on which post, and what each person may do in the repository (none unless said).
  const events = new Map();
  const permissions = new Map();
  const labelled = (number, event, name, by) => events.set(number, [...(events.get(number) ?? []), { id: String(nextId++), event, label: name, by }]);
  const comments = new Map();
  const releases = [];
  const data = {};
  const commits = [];
  const attachments = {};
  const client = {
    repo: REPO,
    dataBranch: "the-data-branch",
    listPosts: async () => posts.filter((post) => post.labels.some((entry) => entry.name === label)).map((post) => ({ ...post })),
    listComments: async (number) => comments.get(number) ?? [],
    createComment: async (number, text) => {
      comments.set(number, [...(comments.get(number) ?? []), { id: nextId++, body: text, user: { login: "github-actions[bot]" } }]);
    },
    updateComment: async (id, text) => {
      for (const list of comments.values()) for (const comment of list) if (comment.id === id) comment.body = text;
    },
    addLabel: async (number, name) => {
      const post = posts.find((entry) => entry.number === number);
      if (!post.labels.some((entry) => entry.name === name)) {
        post.labels.push({ name });
        labelled(number, "labeled", name, "github-actions[bot]");
      }
    },
    removeLabel: async (number, name) => {
      const post = posts.find((entry) => entry.number === number);
      if (post.labels.some((entry) => entry.name === name)) labelled(number, "unlabeled", name, "github-actions[bot]");
      post.labels = post.labels.filter((entry) => entry.name !== name);
    },
    closeAsNotPlanned: async (number) => {
      Object.assign(posts.find((entry) => entry.number === number), { state: "closed", state_reason: "not_planned" });
    },
    closeAsCompleted: async (number) => {
      Object.assign(posts.find((entry) => entry.number === number), { state: "closed", state_reason: "completed" });
    },
    reopen: async (number) => {
      Object.assign(posts.find((entry) => entry.number === number), { state: "open", state_reason: null });
    },
    labelEvents: async (number) => (events.get(number) ?? []).map((event) => ({ ...event })),
    permissionOf: async (login) => permissions.get(login) ?? "none",
    listReleases: async () => releases.map((release) => ({ ...release, assets: [...release.assets] })),
    createRelease: async ({ tag, draft = false }) => {
      const release = { id: nextId++, tag, draft, assets: [] };
      releases.push(release);
      return { ...release, assets: [] };
    },
    uploadAsset: async (release, name, file) => {
      const stored = releases.find((entry) => entry.id === release.id);
      assert.ok(!stored.assets.some((asset) => asset.name === name), `${name} uploaded twice to ${release.tag}`);
      const asset = { id: nextId++, name, tag: release.tag, url: `https://github.com/${REPO}/releases/download/${release.tag}/${name}`, bytes: fs.readFileSync(file) };
      stored.assets.push(asset);
      return asset;
    },
    deleteAsset: async (id) => {
      for (const release of releases) release.assets = release.assets.filter((asset) => asset.id !== id);
    },
    downloadAsset: async (asset, dest) => {
      const stored = releases.flatMap((release) => release.assets).find((entry) => entry.id === asset.id);
      fs.writeFileSync(dest, stored.bytes);
    },
    // Pictures dragged into posts: served when they are in `attachments`.
    downloadAttachment: async (url, dest) => {
      if (!attachments[url]) throw new Error("GitHub answered 404");
      fs.writeFileSync(dest, attachments[url]);
    },
    readData: async (file) => (data[file] ? JSON.parse(data[file]) : null),
    writeData: async (files, message) => {
      Object.assign(data, files);
      commits.push(message);
      return true;
    },
  };
  // `extra` is whatever else GitHub says of the post (its author's
  // `author_association`, a title).
  // A post, labelled by its own form: the label is its author's doing.
  const addPost = (number, text, user = "designer", extra = {}, labels = [label]) => {
    posts.push({ number, body: text, state: "open", state_reason: null, user: { login: user }, labels: labels.map((name) => ({ name })), ...extra });
    for (const name of labels) labelled(number, "labeled", name, user);
  };
  const editPost = (number, changes) => Object.assign(posts.find((entry) => entry.number === number), changes);
  // Someone (`by`) putting a label on a post, or taking it off.
  const labelPost = (number, name, by) => {
    const post = posts.find((entry) => entry.number === number);
    if (!post.labels.some((entry) => entry.name === name)) post.labels.push({ name });
    labelled(number, "labeled", name, by);
  };
  const unlabelPost = (number, name, by) => {
    const post = posts.find((entry) => entry.number === number);
    post.labels = post.labels.filter((entry) => entry.name !== name);
    labelled(number, "unlabeled", name, by);
  };
  return { client, posts, comments, releases, data, commits, attachments, events, permissions, addPost, editPost, label: labelPost, unlabel: unlabelPost, list: () => JSON.parse(data[listFile]), state: () => JSON.parse(data[stateFile]) };
};

// Downloads served from local files, counted.
export const fakeDownloads = (files) => {
  const calls = [];
  const download = async (link, dest) => {
    calls.push(link);
    if (!files[link]) throw new Error("The download link answered HTTP 404. Is it public, and still there?");
    fs.copyFileSync(files[link], dest);
    return fs.statSync(dest).size;
  };
  return { download, calls };
};
