// A stand-in for lib/github.mjs: the hub as plain data the tests set up, and a
// record of everything a run did to it.

import crypto from "node:crypto";

import { syncHub } from "../lib/sync.mjs";

export const REPO = "Open-Historia/Open-historia-scenarios";
const BOT = { login: "github-actions[bot]", type: "Bot" };

// Minutes after noon on the day of the tests.
export const at = (minutes) => new Date(Date.UTC(2026, 9, 5, 12, minutes));
// One run of the workflow, at a time the hub's own clock then shows too.
export const run = (hub, { now = at(0), ...options } = {}) => {
  hub.time = now.toISOString();
  return syncHub({ client: hub.client, now, ...options });
};
// A hub the workflow has already run on once, so what a test does comes after.
export const installed = async (setup = {}, options = {}) => {
  const hub = fakeHub(setup);
  await run(hub, options);
  hub.calls.length = 0;
  return hub;
};

export const post = (number, kind, body, extra = {}) => ({
  number,
  state: "open",
  state_reason: null,
  title: `[${kind[0].toUpperCase()}${kind.slice(1)}] Post ${number}`,
  body,
  labels: [{ name: kind }],
  user: { login: "author", type: "User", avatar_url: "https://avatars.githubusercontent.com/u/1?v=4" },
  html_url: `https://github.com/${REPO}/issues/${number}`,
  created_at: `2026-10-01T00:00:${String(number % 60).padStart(2, "0")}Z`,
  updated_at: `2026-10-05T00:00:${String(number % 60).padStart(2, "0")}Z`,
  author_association: "NONE",
  reactions: { "+1": 0 },
  comments: 0,
  ...extra,
});

export const fakeHub = ({ issues = [], releases = [], data = {}, files = {} } = {}) => {
  const hub = {
    repo: REPO,
    issues: new Map(issues.map((issue) => [issue.number, issue])),
    releases: releases.map((release) => ({ ...release, assets: [...(release.assets ?? [])] })),
    data: { ...data },
    // source URL -> Buffer, an Error to throw, or { tooLarge: bytes }
    files: new Map(Object.entries(files)),
    comments: new Map(), // id -> { number, body, user, created_at, updated_at }
    uploaded: new Map(), // asset name -> the bytes that were uploaded
    calls: [],
    nextId: 1000,
    // The time the hub's own clock shows: what a comment made now is stamped with.
    time: "2026-10-05T12:00:00.000Z",
  };
  const call = (name, ...args) => hub.calls.push([name, ...args]);
  const gone = () => Object.assign(new Error("GitHub answered 404"), { status: 404, transient: false });
  const shown = (id, comment) => ({
    id,
    body: comment.body,
    user: comment.user,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    issue_url: `https://api.github.com/repos/${REPO}/issues/${comment.number}`,
    html_url: `https://github.com/${REPO}/issues/${comment.number}#issuecomment-${id}`,
  });
  const addComment = (number, body, user) => {
    const id = hub.nextId++;
    hub.comments.set(id, { number, body, user, created_at: hub.time, updated_at: hub.time });
    if (hub.issues.has(number)) hub.issues.get(number).comments += 1;
    return id;
  };
  hub.client = {
    repo: REPO,
    listPosts: async (label) => [...hub.issues.values()].filter((issue) => issue.labels.some((entry) => entry.name === label)).map((issue) => ({ ...issue, labels: [...issue.labels] })),
    getIssue: async (number) => (hub.issues.has(number) ? { ...hub.issues.get(number) } : null),
    closeIssue: async (number) => {
      call("closeIssue", number);
      Object.assign(hub.issues.get(number), { state: "closed", state_reason: "completed" });
    },
    reopenIssue: async (number) => {
      call("reopenIssue", number);
      Object.assign(hub.issues.get(number), { state: "open", state_reason: "reopened" });
    },
    listReleases: async () => hub.releases.map((release) => ({ ...release, assets: release.assets.map((asset) => ({ ...asset })) })),
    createRelease: async ({ tag, title, notes }) => {
      call("createRelease", tag);
      const release = { id: hub.nextId++, tag, title, notes, assets: [] };
      hub.releases.push(release);
      return { id: release.id, tag, assets: [] };
    },
    uploadAsset: async (releaseId, { name, contentType, bytes }) => {
      call("uploadAsset", name, contentType);
      const release = hub.releases.find((entry) => entry.id === releaseId);
      if (release.assets.some((asset) => asset.name === name)) throw Object.assign(new Error("GitHub answered 422: already_exists"), { status: 422, transient: false });
      const asset = { id: hub.nextId++, name, url: `https://github.com/${REPO}/releases/download/${release.tag}/${name}`, size: bytes.length, downloads: 0 };
      release.assets.push(asset);
      hub.uploaded.set(name, Buffer.from(bytes));
      return { ...asset };
    },
    deleteAsset: async (assetId) => {
      call("deleteAsset", assetId);
      for (const release of hub.releases) release.assets = release.assets.filter((asset) => asset.id !== assetId);
    },
    download: async (url) => {
      call("download", url);
      const bytes = hub.files.get(url);
      if (bytes instanceof Error) throw bytes;
      if (!bytes) throw gone();
      if (bytes.tooLarge) return { tooLarge: true, size: bytes.tooLarge };
      return { bytes, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
    },
    listComments: async (since) => [...hub.comments.entries()]
      .filter(([, comment]) => !since || comment.updated_at >= since)
      .sort((a, b) => a[1].updated_at.localeCompare(b[1].updated_at) || a[0] - b[0])
      .map(([id, comment]) => shown(id, comment)),
    listPostComments: async (number) => {
      call("listPostComments", number);
      return [...hub.comments.entries()].filter(([, comment]) => comment.number === number).map(([id, comment]) => shown(id, comment));
    },
    createComment: async (number, body) => {
      call("createComment", number);
      return { id: addComment(number, body, BOT) };
    },
    updateComment: async (id, body) => {
      call("updateComment", id);
      if (!hub.comments.has(id)) throw gone();
      Object.assign(hub.comments.get(id), { body, updated_at: hub.time });
    },
    deleteComment: async (id) => {
      call("deleteComment", id);
      const comment = hub.comments.get(id);
      if (comment && hub.issues.has(comment.number)) hub.issues.get(comment.number).comments -= 1;
      hub.comments.delete(id);
    },
    addLabel: async (number, name) => {
      call("addLabel", number, name);
      hub.issues.get(number).labels.push({ name });
    },
    removeLabel: async (number, name) => {
      call("removeLabel", number, name);
      const issue = hub.issues.get(number);
      issue.labels = issue.labels.filter((label) => label.name !== name);
    },
    readData: async (file) => (hub.data[file] ? JSON.parse(hub.data[file]) : null),
    writeData: async (files) => {
      call("writeData", Object.keys(files).sort().join(","));
      Object.assign(hub.data, files);
    },
  };
  hub.did = (name) => hub.calls.filter(([what]) => what === name);
  hub.index = () => JSON.parse(hub.data["index.json"]);
  hub.state = () => JSON.parse(hub.data["state.json"]);
  // Someone comments on a post (or edits their comment), as a person would.
  hub.comment = (number, body, login = "suggester") => addComment(number, body, { login, type: "User" });
  hub.edit = (id, body) => Object.assign(hub.comments.get(id), { body, updated_at: hub.time });
  // The comments the workflow itself has on a post.
  hub.said = (number) => [...hub.comments.values()].filter((comment) => comment.number === number && comment.user.type === "Bot").map((comment) => comment.body);
  // Every file in the releases, by name; and one of them by the start of its name.
  hub.assets = () => hub.releases.flatMap((release) => release.assets.map((asset) => ({ ...asset, tag: release.tag })));
  hub.asset = (start) => hub.assets().find((asset) => asset.name.startsWith(start));
  // Downloads of an asset, as GitHub would count them.
  hub.downloaded = (start, times = 1) => {
    for (const release of hub.releases) for (const asset of release.assets) if (asset.name.startsWith(start)) asset.downloads += times;
  };
  return hub;
};
