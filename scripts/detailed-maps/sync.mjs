// What a run of the "Detailed maps" workflow does. It looks at every detailed
// map post, so a run that was skipped is made up by the next one, and acts on
// the ones that changed since it last looked:
//
//   - a new post, or an edited one, is checked: its answers, then the map file,
//     downloaded from the link given and looked into the way the game does.
//     If all is well the file is copied into a "detailed-maps-<n>" release as
//     "<id>-v<version>.pmtiles" and added to the list; if not, the post gets a
//     comment saying what to fix. An edit with a new file makes the next
//     version; an edit to the words only changes the map's details.
//   - a post closed as "not planned" (by its author or a moderator) has its
//     map deleted for good: its files go, and the list keeps a tombstone so
//     its ID is never used again.
//
// The file is downloaded only when the post's link or checksum changed, never
// again on every run. Archiving, restoring and deleting by hand are the
// "Archive or restore a detailed map" and "Delete a detailed map" workflows
// (changeMap below).

import fs from "node:fs";
import path from "node:path";
import { checkForm, parseForm } from "./form.mjs";
import {
  ARCHIVE_RELEASE,
  LIST_FILE,
  PAGE_FILE,
  PassingError,
  PROBLEM_LABEL,
  RELEASE_FILE_LIMIT,
  RELEASE_PREFIX,
  STATE_FILE,
  addVersion,
  archive,
  assetNameOf,
  downloadMap,
  emptyList,
  findMap,
  latestVersion,
  plain,
  remove,
  restore,
  sha256File,
  sha256Text,
  updateDetails,
  versionsFor,
} from "./maps.mjs";
import { buildPage } from "./page.mjs";
import { inspectMap, megabytes } from "./pmtiles.mjs";
import { imageType } from "../lib/images.mjs";
import { firstHubImage } from "../lib/posts.mjs";

export const MARKER = "<!-- detailed-map-check -->";
const BOT = "github-actions[bot]";

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const todayText = () => new Date().toISOString().slice(0, 10);

// ---- the list and its files, read once per run ----------------------------------

export const openStore = async ({ client, workDir, log = console.log }) => {
  const list = (await client.readData(LIST_FILE)) ?? emptyList();
  const state = (await client.readData(STATE_FILE)) ?? { version: 1, posts: {} };
  let releases = null;
  const releasesNow = async () => {
    releases ??= (await client.listReleases()).filter((release) => release.tag.startsWith(RELEASE_PREFIX));
    return releases;
  };
  const releaseNumber = (tag) => Number(/^detailed-maps-(\d+)$/.exec(tag)?.[1] ?? 0);

  // The release a new file goes in: the last one, or a new one once it is
  // nearly full.
  const currentRelease = async () => {
    const own = (await releasesNow()).filter((release) => releaseNumber(release.tag) > 0).sort((a, b) => releaseNumber(b.tag) - releaseNumber(a.tag));
    if (own[0] && own[0].assets.length < RELEASE_FILE_LIMIT) return own[0];
    const number = (own[0] ? releaseNumber(own[0].tag) : 0) + 1;
    const release = await client.createRelease({
      tag: `${RELEASE_PREFIX}${number}`,
      title: `Detailed map files (${number})`,
      notes: [
        "The files of the hub's **detailed map** posts, checked and copied here automatically so the game can download them.",
        "",
        `Each map's credits and licence: [DETAILED-MAPS.md](https://github.com/${client.repo}/blob/detailed-maps-index/${PAGE_FILE}).`,
        "",
        "Do not upload, rename or delete files here by hand: the **Detailed maps** workflow owns this release. To change a map, edit its post.",
      ].join("\n"),
    });
    releases.push(release);
    return release;
  };
  const archiveRelease = async () => {
    const found = (await releasesNow()).find((release) => release.tag === ARCHIVE_RELEASE);
    if (found) return found;
    const release = await client.createRelease({
      tag: ARCHIVE_RELEASE,
      title: "Archived detailed maps",
      notes: "Files of archived detailed maps, kept but not downloadable while they are archived. The **Archive or restore a detailed map** workflow moves them; don't change this release by hand.",
      draft: true,
    });
    releases.push(release);
    return release;
  };

  // Map files are named for their map and version, so a name is found in
  // whichever of these releases it is in.
  const assetNamed = async (name) => {
    for (const release of await releasesNow()) {
      const asset = release.assets.find((entry) => entry.name === name);
      if (asset) return { release, asset };
    }
    return null;
  };
  const dropAsset = async (name) => {
    const found = await assetNamed(name);
    if (!found) return;
    await client.deleteAsset(found.asset.id);
    found.release.assets = found.release.assets.filter((entry) => entry.id !== found.asset.id);
  };
  const putAsset = async (release, name, file) => {
    // A file of this name with no version in the list is left from a run that
    // stopped half way: it goes.
    await dropAsset(name);
    const asset = await client.uploadAsset(release, name, file);
    release.assets.push(asset);
    return asset;
  };
  const moveAsset = async (name, to) => {
    const found = await assetNamed(name);
    if (!found) throw new Error(`The file ${name} is missing from the releases.`);
    if (found.release.id === to.id) return found.asset;
    const file = path.join(workDir, name);
    await client.downloadAsset(found.asset, file);
    try {
      const asset = await client.uploadAsset(to, name, file);
      to.assets.push(asset);
      await client.deleteAsset(found.asset.id);
      found.release.assets = found.release.assets.filter((entry) => entry.id !== found.asset.id);
      return asset;
    } finally {
      fs.rmSync(file, { force: true });
    }
  };

  const save = (message) => client.writeData({
    [LIST_FILE]: json(list),
    [STATE_FILE]: json(state),
    [PAGE_FILE]: buildPage(list, state, { repo: client.repo }),
  }, message).then((written) => {
    log(written ? `Saved: ${message}` : "The list is unchanged.");
  });

  return { list, state, currentRelease, archiveRelease, putAsset, moveAsset, dropAsset, save };
};

// ---- comments ---------------------------------------------------------------------

// The one status comment the workflow keeps on a post, made or updated.
// Resolves true when it was made (which notifies the post's author). It is
// found again by the hidden line it starts with (`marker`, which `body` has to
// start with: the background music workflow keeps its own the same way).
export const setStatus = async (client, number, body, marker = MARKER) => {
  const comments = await client.listComments(number);
  const own = comments.find((comment) => comment.user?.login === BOT && String(comment.body ?? "").startsWith(marker));
  if (own) {
    if (own.body !== body) await client.updateComment(own.id, body);
    return false;
  }
  await client.createComment(number, body);
  return true;
};

const row = (label, value) => `| ${label} | ${value} |`;
const detailsTable = ({ id, version, name, check, license }) => [
  "| | |",
  "|---|---|",
  row("Map ID", id ? `\`${id}\` (it never changes)` : "—"),
  row("Version", version ? String(version) : "—"),
  row("Name", plain(name) || "—"),
  row("File", check ? `${check.tileType} tiles, ${megabytes(check.bytes)} MB (${check.bytes} bytes)` : "—"),
  row("Zooms", check ? `${check.minzoom}–${check.maxzoom}` : "—"),
  row("Covers", check ? `longitude ${check.bounds[0]} to ${check.bounds[2]}, latitude ${check.bounds[1]} to ${check.bounds[3]}` : "—"),
  row("SHA-256", check?.sha256 ? `\`${check.sha256}\`` : "—"),
  row("Licence", plain(license) || "—"),
].join("\n");

const listedComment = ({ note = "", ...details }) => [
  MARKER,
  "### ✅ This map is on the list",
  "",
  "Players can download it in the game (**Maps → Community → Detailed maps**), and scenarios can use it.",
  ...(note ? ["", note] : []),
  "",
  "To release an update, edit this post with the new download link. The checks run again on every edit.",
  "",
  detailsTable(details),
].join("\n");

const problemComment = ({ problems, offered, ...details }) => [
  MARKER,
  "### ❌ This post needs changes",
  "",
  "Fix the points below by editing this post (⋯ → Edit). The checks run again on every edit.",
  ...(offered ? ["", `Until then, players are still offered version ${offered}.`] : []),
  "",
  ...problems.map((problem) => `- ${problem}`),
  "",
  detailsTable(details),
].join("\n");

const waitingComment = (reason) => [
  MARKER,
  "### ⏳ The map couldn't be checked just now",
  "",
  reason,
  "",
  "It is tried again automatically; there's nothing to do.",
].join("\n");

// ---- one post ---------------------------------------------------------------------

// The first screenshot in the post, copied next to the version's file as
// "<id>-v<version>.<type>" so the game can show it on the map's card (it shows
// pictures from the hub's releases only, as it does a scenario's cover).
// Resolves its address, or "" when there is no picture to copy: a screenshot
// is a nicety, and never holds a map back.
const copyPreview = async ({ client, store, release, form, id, version, workDir, log }) => {
  const source = firstHubImage(form.preview);
  if (!source) return "";
  const file = path.join(workDir, `${id}-preview`);
  try {
    await client.downloadAttachment(source, file);
    const type = imageType(fs.readFileSync(file));
    if (!type) return "";
    return (await store.putAsset(release, `${id}-v${version}.${type}`, file)).url;
  } catch (error) {
    log(`${id} version ${version}: no preview (${error?.message || error})`);
    return "";
  } finally {
    fs.rmSync(file, { force: true });
  }
};

const checkPost = async ({ client, store, issue, record, workDir, download, inspect, hashFile, today, log }) => {
  const { list, state } = store;
  const number = issue.number;
  const form = parseForm(issue.body);
  const map = record.id ? findMap(list, record.id) : null;
  const { id, sha256: asked, problems } = checkForm(form, list, { ownId: map ? map.id : "" });
  const latest = latestVersion(map);
  const name = plain(form.name).slice(0, 80);
  const license = plain(form.licence).slice(0, 200);
  const author = String(issue.user?.login ?? "");
  record.credits = String(form.credits ?? "").slice(0, 3000);

  if (problems.length) {
    await setStatus(client, number, problemComment({ problems, offered: latest && !latest.archived ? latest.version : 0, id, name, license }));
    return "problem";
  }

  // The same link (and no other checksum asked for) as the version on the
  // list: only the words changed, and the file is not downloaded again.
  if (map && latest && record.link === form.download && (!asked || asked === latest.sha256)) {
    updateDetails(map, { name, license });
    await setStatus(client, number, listedComment({ id, version: latest.version, name, license, check: record.check, note: "Your last edit changed the details only (the download link is the same), so there is no new version." }));
    return "details";
  }

  const file = path.join(workDir, `post-${number}.pmtiles`);
  let check;
  try {
    const bytes = await download(form.download, file);
    const info = await inspect(file);
    check = { ...info, bytes, sha256: await hashFile(file) };
  } catch (error) {
    fs.rmSync(file, { force: true });
    if (error instanceof PassingError) {
      await setStatus(client, number, waitingComment(error.message));
      return "waiting";
    }
    await setStatus(client, number, problemComment({ problems: [error.message], offered: latest && !latest.archived ? latest.version : 0, id, name, license }));
    return "problem";
  }
  try {
    if (asked && asked !== check.sha256) {
      await setStatus(client, number, problemComment({
        problems: [`The file's SHA-256 is \`${check.sha256}\`, not the one in the post. The file may have changed, or the checksum was copied wrong.`],
        offered: latest && !latest.archived ? latest.version : 0, id, name, license, check,
      }));
      return "problem";
    }
    // The same file as another map's version: most likely an update posted as
    // a new map, which scenarios naming the old ID would never be offered.
    const copied = list.basemaps.find((other) => other !== map && other.versions.some((entry) => entry.sha256 === check.sha256));
    if (copied) {
      const { version: copiedVersion } = copied.versions.find((entry) => entry.sha256 === check.sha256);
      await setStatus(client, number, problemComment({
        problems: [`This file is already version ${copiedVersion} of \`${copied.id}\`${copied.post ? ` (#${copied.post})` : ""}. To release an update, edit that map's post with the new download link instead of making a new post.`],
        offered: latest && !latest.archived ? latest.version : 0, id, name, license, check,
      }));
      return "problem";
    }
    if (map && latest && check.sha256 === latest.sha256) {
      updateDetails(map, { name, license });
      record.link = form.download;
      record.check = check;
      await setStatus(client, number, listedComment({ id, version: latest.version, name, license, check, note: `The file at the link is the same as version ${latest.version}, so there is no new version.` }));
      return "details";
    }

    const version = map ? Math.max(...map.versions.map((entry) => entry.version)) + 1 : 1;
    const release = await store.currentRelease();
    const asset = await store.putAsset(release, assetNameOf(id, version), file);
    const preview = await copyPreview({ client, store, release, form, id, version, workDir, log });
    // "What changed?" belongs to the version it came with (the game shows it as
    // "New in v2: …"). A first version has nothing to compare with, and a box
    // left as it was for the last version says nothing about this one.
    const changes = plain(form.changes).slice(0, 500);
    const notes = version > 1 && changes !== (record.changes ?? "") ? changes : "";
    record.changes = changes;
    const entry = addVersion(list, { id, version, url: asset.url, bytes: check.bytes, sha256: check.sha256, preview, notes, name, author, license, post: number, released: today });
    if (map) updateDetails(entry, { name, license });
    record.id = id;
    record.link = form.download;
    record.check = check;
    state.posts[number] = record;
    log(`#${number}: released ${id} version ${version} (${megabytes(check.bytes)} MB)`);
    const made = await setStatus(client, number, listedComment({ id, version, name, license, check }));
    if (!made) {
      await client.createComment(number, version === 1
        ? `✅ \`${id}\` is on the list.`
        : `✅ Version ${version} of \`${id}\` is released. Players who have an older version are offered the update.${notes ? `\n\n**What changed:** ${notes}` : ""}`);
    }
    return "released";
  } finally {
    fs.rmSync(file, { force: true });
  }
};

// Archive, restore or delete a map (or one version of it), its files with it.
// Used by the workflows maintainers run, and when a post is closed as not
// planned. Resolves the versions it changed.
export const changeMap = async ({ store, action, id, version = null, reason = "", today }) => {
  const map = findMap(store.list, id);
  if (!map) throw new Error(`There is no map "${id}" in the list.`);
  const versions = versionsFor(map, version, action);
  // A version's screenshot (copyPreview) goes wherever its file goes.
  const previewName = (entry) => (entry.preview ? decodeURIComponent(entry.preview.split("/").pop()) : "");
  const movePreview = async (entry, to) => {
    if (entry.preview) entry.preview = (await store.moveAsset(previewName(entry), to)).url;
  };
  if (action === "archive") {
    const to = await store.archiveRelease();
    const urls = {};
    for (const entry of versions.filter((item) => !item.archived)) {
      urls[entry.version] = (await store.moveAsset(assetNameOf(id, entry.version), to)).url;
      await movePreview(entry, to);
    }
    archive(map, versions, { reason, date: today, urls });
  } else if (action === "restore") {
    const to = await store.currentRelease();
    const back = versions.filter((entry) => entry.archived);
    const urls = {};
    for (const entry of back) {
      urls[entry.version] = (await store.moveAsset(assetNameOf(id, entry.version), to)).url;
      await movePreview(entry, to);
    }
    restore(map, back, { urls });
  } else if (action === "delete") {
    for (const entry of versions) {
      await store.dropAsset(assetNameOf(id, entry.version));
      if (entry.preview) await store.dropAsset(previewName(entry));
    }
    remove(map, versions, { reason, date: today });
  } else {
    throw new Error(`"${action}" is not archive, restore or delete.`);
  }
  return { map, versions: versions.map((entry) => entry.version) };
};

// ---- a run ------------------------------------------------------------------------

export const syncDetailedMaps = async ({
  client,
  workDir,
  download = downloadMap,
  inspect = inspectMap,
  hashFile = sha256File,
  today = todayText(),
  log = console.log,
}) => {
  fs.mkdirSync(workDir, { recursive: true });
  const store = await openStore({ client, workDir, log });
  const { list, state } = store;
  const summary = { posts: 0, released: 0, details: 0, problem: 0, waiting: 0, deleted: 0, unchanged: 0 };

  for (const issue of await client.listPosts()) {
    summary.posts += 1;
    const number = issue.number;
    const record = state.posts[number] ?? {};
    const map = record.id ? findMap(list, record.id) : null;

    // Closed as not planned: the map goes, for good.
    if (issue.state === "closed" && issue.state_reason === "not_planned") {
      if (map && !map.deleted) {
        const reason = `Its post #${number} was closed as not planned.`;
        await changeMap({ store, action: "delete", id: map.id, reason, today });
        await setStatus(client, number, [
          MARKER,
          "### 🗑️ This map was deleted",
          "",
          `Closing this post as not planned deleted \`${map.id}\` for good. Players who already have it keep their copy; nobody else can download it. Its ID is never used again.`,
        ].join("\n"));
        await store.save(`Delete ${map.id} (#${number} closed as not planned)`);
        summary.deleted += 1;
      } else {
        summary.unchanged += 1;
      }
      continue;
    }

    // A deleted map's post edited or reopened: it is said once.
    if (map?.deleted) {
      if (!record.toldDeleted) {
        await setStatus(client, number, [
          MARKER,
          "### 🗑️ This map was deleted",
          "",
          `\`${map.id}\` was deleted on ${map.deleted.date}${map.deleted.reason ? ` (${map.deleted.reason})` : ""}, and a deleted map can't come back. To share it again, make a new post: it gets a new ID.`,
        ].join("\n"));
        record.toldDeleted = true;
        state.posts[number] = record;
        await store.save(`Tell #${number} its map was deleted`);
      }
      summary.unchanged += 1;
      continue;
    }

    const bodyHash = sha256Text(issue.body);
    if (record.bodyHash === bodyHash) {
      summary.unchanged += 1;
      continue;
    }

    let outcome;
    try {
      outcome = await checkPost({ client, store, issue, record, workDir, download, inspect, hashFile, today, log });
    } catch (error) {
      // Something on GitHub's side: the post is looked at again next run.
      log(`#${number}: could not be finished (${error?.stack || error})`);
      summary.waiting += 1;
      continue;
    }
    summary[outcome] += 1;
    // A post that is waiting is looked at again on the next run.
    if (outcome !== "waiting") record.bodyHash = bodyHash;
    state.posts[number] = record;
    if (outcome === "problem") await client.addLabel(number, PROBLEM_LABEL).catch(() => {});
    else if (outcome !== "waiting" && (issue.labels ?? []).some((label) => (label?.name ?? label) === PROBLEM_LABEL)) await client.removeLabel(number, PROBLEM_LABEL).catch(() => {});
    await store.save(outcome === "released" ? `Release ${record.id} version ${latestVersion(findMap(list, record.id)).version} (#${number})` : `Check #${number}`);
  }
  return summary;
};
