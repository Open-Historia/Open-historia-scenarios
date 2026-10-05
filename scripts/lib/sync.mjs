// Keeps the hub's releases in step with its posts.
//
// Every run looks at ALL the open posts and brings the releases up to date,
// whatever started it (a post opened or edited, the half-hourly timer, a
// maintainer): a run that was skipped or failed is made up by the next one.
//
//   - a file attached to a post is copied into a release, once;
//   - a file the post no longer carries is deleted from the release, and its
//     download count is kept;
//   - a closed or deleted post's files are deleted;
//   - a post whose file cannot be copied gets a comment saying why (one
//     comment, updated in place, removed once the post is fixed) and the
//     "file problem" label;
//   - index.json is rewritten: where the game finds each file, and how many
//     times each scenario's file has been downloaded.
//
// GitHub is reached only through `client` (lib/github.mjs), so all of this runs
// against a stand-in in the tests.

import crypto from "node:crypto";
import {
  KINDS,
  MAX_FILE_BYTES,
  assetName,
  assetPrefix,
  checkFile,
  chooseRelease,
  contentTypeOf,
  kindOfIssue,
  parseReleaseLink,
  postFiles,
  releaseNotes,
  releaseTitle,
  sniffType,
} from "./posts.mjs";

export const STATE_FILE = "state.json";
export const INDEX_FILE = "index.json";
export const PROBLEM_LABEL = "file problem";
export const COMMENT_MARKER = "<!-- hub-files -->";
// A problem that may pass by itself (GitHub not answering) is commented on only
// after this many runs in a row.
export const TRANSIENT_RUNS_BEFORE_COMMENT = 3;

const sha256 = (text) => crypto.createHash("sha256").update(String(text ?? "")).digest("hex");
const plainObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

export const normalizeState = (raw) => {
  const state = plainObject(raw);
  return {
    version: 1,
    installedAt: typeof state.installedAt === "string" ? state.installedAt : "",
    posts: plainObject(state.posts),
    retired: plainObject(state.retired),
  };
};

const newRecord = (kind, { existedBefore, retired }) => ({
  kind,
  bodyHash: "",
  // A post that was already there when this workflow first ran is never
  // commented on until its author edits it: nobody asked for a remark on a
  // post they made months ago.
  quiet: Boolean(existedBefore),
  files: [],
  carried: Number(retired?.carried) || 0,
  skip: plainObject(retired?.skip),
  problems: [],
  failures: 0,
  comment: null,
});

const fileName = (source) => {
  try {
    const segment = new URL(source).pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
};
// How a file is named in a comment: by its name when it has one. Never by its
// address: a comment that carries a post's .zip address would be read by the
// game as a suggestion.
const spoken = (source, fallback) => {
  const name = fileName(source);
  return /\.[A-Za-z0-9]{1,8}$/.test(name) ? `\`${name.replace(/`/g, "")}\`` : fallback;
};

const NO_FILE = {
  scenario: "No scenario file is attached to this post, so nobody can import it. Edit the post and drag your exported `.json` or `.zip` into the Description box.",
  flag: "No flag image is attached to this post. Edit the post and drag your image into the Flag image box.",
  basemap: "No basemap is attached to this post. Edit the post and drag your image (or the `.zip` the editor gave you) into the Basemap image box.",
};

export const problemComment = (kind, problems) => [
  COMMENT_MARKER,
  `### ⚠️ This post's ${kind === "scenario" ? "scenario file" : kind === "flag" ? "flag" : "basemap"} could not be added to the hub`,
  "",
  ...problems.map((problem) => `- ${problem.text}`),
  "",
  problems.every((problem) => problem.transient)
    ? "Nothing needs changing in the post: this is tried again automatically, and this comment goes away once it works."
    : "Edit this post (⋯ → Edit) to fix it. It is checked again on every edit, and this comment goes away once the file is in.",
].join("\n");

export const syncHub = async ({
  client,
  aliases = [],
  legacy = {},
  now = new Date(),
  log = () => {},
  maxUploads = 400,
}) => {
  const state = normalizeState(await client.readData(STATE_FILE));
  const firstRun = !state.installedAt;
  if (firstRun) state.installedAt = now.toISOString();
  const before = JSON.stringify(state);

  // Everything is read before anything is changed: a listing that fails ends
  // the run here, with nothing deleted on the strength of half a list.
  const open = new Map();
  for (const kind of KINDS) {
    for (const issue of await client.listOpenPosts(kind)) {
      if (issue?.pull_request || open.has(Number(issue.number))) continue;
      if (kindOfIssue(issue)) open.set(Number(issue.number), issue);
    }
  }
  const releases = await client.listReleases();
  const assetsById = new Map();
  const assetsByName = new Map(); // "tag/name" -> asset
  for (const release of releases) {
    for (const asset of release.assets) {
      assetsById.set(asset.id, { ...asset, tag: release.tag });
      assetsByName.set(`${release.tag}/${asset.name}`, { ...asset, tag: release.tag });
    }
  }
  const ownRepos = new Set([client.repo, ...aliases].map((name) => String(name).toLowerCase()));
  const hostedAsset = (source) => {
    const link = parseReleaseLink(source);
    if (!link || !ownRepos.has(`${link.owner}/${link.repo}`.toLowerCase())) return null;
    return assetsByName.get(`${link.tag}/${link.name}`) ?? null;
  };

  const summary = { posts: open.size, copied: 0, deleted: 0, retired: 0, commented: 0, problems: 0, deferred: 0 };
  const downloadsOf = (assetId) => assetsById.get(assetId)?.downloads ?? 0;
  const counted = (record, file) => {
    const id = file.asset?.id ?? file.hosted?.id;
    return id ? Math.max(0, downloadsOf(id) - (Number(record.skip?.[id]) || 0)) : 0;
  };
  // A copied file that is no longer wanted: deleted, its downloads kept.
  const dropFile = async (record, file) => {
    if (file.primary) record.carried += counted(record, file);
    if (file.asset && assetsById.has(file.asset.id)) {
      await client.deleteAsset(file.asset.id);
      assetsById.delete(file.asset.id);
      assetsByName.delete(`${file.asset.tag}/${file.asset.name}`);
      const release = releases.find((entry) => entry.tag === file.asset.tag);
      if (release) release.assets = release.assets.filter((asset) => asset.id !== file.asset.id);
      summary.deleted += 1;
    }
    const id = file.asset?.id ?? file.hosted?.id;
    if (id && record.skip) delete record.skip[id];
  };

  const copyFile = async (post, kind, want) => {
    // A file by this attachment's name is this very attachment (an attachment
    // never changes), left by a run that copied it and failed before it could
    // say so: taken as it is, without downloading it again.
    const prefix = assetPrefix({ post, source: want.source });
    const left = [...assetsByName.values()].find((asset) => asset.name.startsWith(`${prefix}.`) || asset.name.startsWith(`${prefix}-`));
    if (left) return { asset: { id: left.id, tag: left.tag, name: left.name, url: left.url, size: left.size } };
    const downloaded = await client.download(want.source);
    try {
      if (downloaded.tooLarge) {
        if (!want.primary) return { skipped: true };
        return { problem: `it is ${Math.round(downloaded.size / 1048576)} MB, and the game can import ${Math.round(MAX_FILE_BYTES / 1048576)} MB at most` };
      }
      const type = sniffType(downloaded.head);
      const verdict = checkFile({ kind, primary: want.primary, type, size: downloaded.size });
      if (verdict.skip) return { skipped: true };
      if (verdict.problem) return { problem: verdict.problem };
      const name = assetName({ post, source: want.source, type });
      const chosen = chooseRelease(releases, kind);
      let release = releases.find((entry) => entry.tag === chosen.tag);
      if (!release) {
        release = await client.createRelease({ tag: chosen.tag, title: releaseTitle(kind, chosen.tag), notes: releaseNotes(kind) });
        release.assets = release.assets ?? [];
        releases.push(release);
      }
      const asset = { ...(await client.uploadAsset(release.id, { name, contentType: contentTypeOf(type), file: downloaded.file })), tag: release.tag };
      release.assets.push(asset);
      assetsById.set(asset.id, asset);
      assetsByName.set(`${asset.tag}/${asset.name}`, asset);
      summary.copied += 1;
      return { asset: { id: asset.id, tag: asset.tag, name: asset.name, url: asset.url, size: downloaded.size, sha256: downloaded.sha256 } };
    } finally {
      await client.discard?.(downloaded.file);
    }
  };

  // New and edited posts first: their authors are waiting.
  const ordered = [...open.values()].sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
  for (const issue of ordered) {
    const number = Number(issue.number);
    const { kind, files: wanted } = postFiles(issue);
    const record = state.posts[number]
      ?? newRecord(kind, { existedBefore: firstRun, retired: state.retired[number] });
    delete state.retired[number];
    state.posts[number] = record;
    record.kind = kind;
    const bodyHash = sha256(issue.body);
    if (record.bodyHash && record.bodyHash !== bodyHash) record.quiet = false;
    record.bodyHash = bodyHash;

    const problems = [];
    const files = [];
    for (const want of wanted) {
      const known = record.files.find((file) => file.source === want.source);
      if (known?.asset && assetsById.has(known.asset.id)) {
        files.push({ ...known, primary: want.primary });
        continue;
      }
      const hosted = hostedAsset(want.source);
      if (hosted) {
        // Already a file in this repository's releases: nothing to copy. What it
        // was downloaded before today is in the old counter's number, when the
        // post has one, so only downloads from here on are added to it.
        if (!(hosted.id in record.skip)) record.skip[hosted.id] = String(number) in legacy ? hosted.downloads : 0;
        files.push({ source: want.source, primary: want.primary, hosted: { id: hosted.id, tag: hosted.tag, name: hosted.name, url: hosted.url } });
        continue;
      }
      if (summary.copied >= maxUploads) {
        summary.deferred += 1;
        continue;
      }
      try {
        const result = await copyFile(number, kind, want);
        if (result.asset) files.push({ source: want.source, primary: want.primary, asset: result.asset });
        else if (result.problem && want.primary) {
          problems.push({ text: `${spoken(want.source, "The attached file")} can't be used: ${result.problem}.`, transient: false });
        }
      } catch (error) {
        const transient = error?.transient !== false;
        // Something else attached that will not download is not the post's
        // problem; THE file is.
        if (want.primary) {
          problems.push({
            text: transient
              ? `${spoken(want.source, "The attached file")} could not be fetched from GitHub just now (${error?.message || error}).`
              : `${spoken(want.source, "The attached file")} can't be downloaded any more (${error?.message || error}). Attach it again.`,
            transient,
          });
        } else {
          log(`#${number}: skipped ${fileName(want.source) || "an attachment"} (${error?.message || error})`);
        }
      }
    }
    if (!wanted.some((file) => file.primary)) problems.push({ text: NO_FILE[kind], transient: false });

    // What the post no longer carries. Not while this run was cut short: a file
    // it did not get to is not a file the post dropped.
    for (const old of record.files) {
      if (!files.some((file) => file.source === old.source) && !wanted.some((file) => file.source === old.source)) {
        await dropFile(record, old);
      } else if (!files.some((file) => file.source === old.source)) {
        // Still wanted, could not be re-established this run: keep what we knew.
        if (old.asset && assetsById.has(old.asset.id)) files.push(old);
      }
    }
    for (const problem of problems) log(`#${number} (${kind}): ${problem.text}`);
    record.files = files;
    record.problems = problems;
    record.failures = problems.length && problems.every((problem) => problem.transient) ? record.failures + 1 : 0;
    summary.problems += problems.length ? 1 : 0;

    // The comment and the label.
    const speak = problems.length > 0
      && !record.quiet
      && (problems.some((problem) => !problem.transient) || record.failures >= TRANSIENT_RUNS_BEFORE_COMMENT);
    const hasLabel = (issue.labels ?? []).some((label) => String(label?.name ?? label).toLowerCase() === PROBLEM_LABEL);
    try {
      if (speak) {
        const body = problemComment(kind, problems);
        const hash = sha256(body);
        if (!record.comment) {
          const created = await client.createComment(number, body);
          record.comment = { id: created.id, hash };
          summary.commented += 1;
        } else if (record.comment.hash !== hash) {
          await client.updateComment(record.comment.id, body);
          record.comment.hash = hash;
          summary.commented += 1;
        }
      } else if (record.comment && !problems.length) {
        await client.deleteComment(record.comment.id);
        record.comment = null;
      }
      const definite = problems.some((problem) => !problem.transient);
      if (definite && !hasLabel) await client.addLabel(number, PROBLEM_LABEL);
      if (!problems.length && hasLabel) await client.removeLabel(number, PROBLEM_LABEL);
    } catch (error) {
      log(`#${number}: could not update its comment or label (${error?.message || error})`);
    }
  }

  // Posts that are no longer open posts. Each is looked up by itself first: a
  // post missing from a list is deleted only once GitHub says it is closed, has
  // lost its label, or is gone.
  for (const key of Object.keys(state.posts)) {
    const number = Number(key);
    if (open.has(number)) continue;
    let issue;
    try {
      issue = await client.getIssue(number);
    } catch (error) {
      log(`#${number}: could not be looked up (${error?.message || error}); left as it is`);
      continue;
    }
    if (issue && issue.state === "open" && kindOfIssue(issue)) continue;
    const record = state.posts[key];
    for (const file of record.files ?? []) await dropFile(record, file);
    if (record.comment && issue) {
      await client.deleteComment(record.comment.id).catch((error) => log(`#${number}: ${error?.message || error}`));
    }
    if (record.carried > 0 || Object.keys(record.skip ?? {}).length) state.retired[key] = { carried: record.carried, skip: record.skip };
    delete state.posts[key];
    summary.retired += 1;
  }

  // The index the game reads.
  const files = {};
  const imports = {};
  for (const [key, record] of Object.entries(state.posts)) {
    let downloads = 0;
    for (const file of record.files) {
      const url = file.asset?.url ?? file.hosted?.url;
      if (url) files[file.source] = url;
      if (file.primary) downloads += counted(record, file);
    }
    if (record.kind === "scenario") {
      const total = (Number(legacy[key]) || 0) + (Number(record.carried) || 0) + downloads;
      if (total > 0) imports[key] = total;
    }
  }
  const index = { version: 1, files, imports };
  const previousIndex = plainObject(await client.readData(INDEX_FILE));
  const sameIndex = JSON.stringify({ files: previousIndex.files, imports: previousIndex.imports }) === JSON.stringify({ files, imports });
  const sameState = JSON.stringify(state) === before;
  if (!sameIndex || !sameState) {
    await client.writeData({
      [STATE_FILE]: `${JSON.stringify(state, null, 1)}\n`,
      [INDEX_FILE]: `${JSON.stringify({ ...index, generatedAt: now.toISOString() })}\n`,
    });
    summary.written = true;
  }
  return { summary, state, index };
};
