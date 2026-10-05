// A stand-in for lib/github.mjs: the hub as plain data the tests set up, and a
// record of everything a run did to it.

import crypto from "node:crypto";

const REPO = "Open-Historia/Open-historia-scenarios";

export const zipBytes = (size = 64) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(Math.max(0, size - 4), 7)]);
export const pngBytes = (size = 64) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(Math.max(0, size - 8), 3)]);
export const jsonBytes = () => Buffer.from('{"schema":"open-historia-scenario-bundle/2"}');

export const post = (number, kind, body, extra = {}) => ({
  number,
  state: "open",
  title: `[${kind}] Post ${number}`,
  body,
  labels: [{ name: kind }],
  updated_at: `2026-10-05T00:00:${String(number % 60).padStart(2, "0")}Z`,
  ...extra,
});

export const fakeHub = ({ issues = [], releases = [], data = {}, files = {} } = {}) => {
  const hub = {
    repo: REPO,
    issues: new Map(issues.map((issue) => [issue.number, issue])),
    releases: releases.map((release) => ({ ...release, assets: [...(release.assets ?? [])] })),
    data: { ...data },
    // source URL -> Buffer, or an Error to throw
    files: new Map(Object.entries(files)),
    comments: new Map(), // id -> { number, body }
    calls: [],
    nextId: 1000,
  };
  const call = (name, ...args) => hub.calls.push([name, ...args]);
  hub.client = {
    repo: REPO,
    listOpenPosts: async (kind) => [...hub.issues.values()].filter((issue) => issue.state === "open" && issue.labels.some((label) => label.name === kind)),
    getIssue: async (number) => hub.issues.get(number) ?? null,
    listReleases: async () => hub.releases.map((release) => ({ ...release, assets: release.assets.map((asset) => ({ ...asset })) })),
    createRelease: async ({ tag, title, notes }) => {
      call("createRelease", tag);
      const release = { id: hub.nextId++, tag, title, notes, assets: [] };
      hub.releases.push(release);
      return { id: release.id, tag, assets: [] };
    },
    uploadAsset: async (releaseId, { name, contentType, file }) => {
      call("uploadAsset", name, contentType);
      const release = hub.releases.find((entry) => entry.id === releaseId);
      const asset = { id: hub.nextId++, name, url: `https://github.com/${REPO}/releases/download/${release.tag}/${name}`, size: file.length, downloads: 0 };
      release.assets.push(asset);
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
      if (!bytes) throw Object.assign(new Error("GitHub answered 404"), { transient: false });
      if (bytes.tooLarge) return { file: null, size: bytes.tooLarge, sha256: "", head: Buffer.alloc(0), tooLarge: true };
      return { file: bytes, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), head: bytes.subarray(0, 512) };
    },
    discard: async () => {},
    createComment: async (number, body) => {
      call("createComment", number);
      const id = hub.nextId++;
      hub.comments.set(id, { number, body });
      return { id };
    },
    updateComment: async (id, body) => {
      call("updateComment", id);
      hub.comments.get(id).body = body;
    },
    deleteComment: async (id) => {
      call("deleteComment", id);
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
  // A download of an asset, as GitHub would count it.
  hub.downloaded = (assetName, times = 1) => {
    for (const release of hub.releases) for (const asset of release.assets) if (asset.name === assetName) asset.downloads += times;
  };
  return hub;
};
