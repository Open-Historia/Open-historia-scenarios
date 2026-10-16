// What a run of the "Background music" workflow does. It looks at every music
// post (an issue labelled "music"), so a run that was skipped is made up by
// the next one, and acts on the ones that changed since it last looked:
//
//   - a post whose author is not one of the hub's contributors waits for a
//     maintainer: it is a song request ("song request" label; the request
//     form makes them, and a music post by anyone else becomes one, its music
//     label taken off), and nothing of it is downloaded until someone who may
//     write to the repository has checked that the hub may share the track
//     and labelled it music. That label is the approval, of the post as it
//     stood then: an edit after it waits for the label again.
//   - a contributor's new post, or an edited one (or an approved request), is checked: its answers,
//     then the file, downloaded from the link given and looked into (really
//     an MP3 or an Ogg file, 20 MB or less). If all is well the file is
//     copied into the "music" release as "<id>-v<version>-<checksum>.<type>"
//     and the track put on the list; if not, the post gets a comment saying
//     what to fix. An edit with a different file makes the next version, in
//     place of the last; an edit to the words only changes the details.
//   - a post whose track is on the list is closed as completed (autoClose: the
//     repository's HUB_AUTOCLOSE, as for the hub's other posts), and it is
//     still read when edited; one that then needs changes is reopened.
//   - a post closed as "not planned" (by its author or a maintainer) has its
//     track removed for good: its file is deleted, and the list keeps the
//     track as removed, so its ID is never used again.
//   - a post last read by an older version of this script (READER) is read
//     again once, quietly, for what this version reads that the older one did
//     not: its words only, never its file, and with no comment.
//
// The file is downloaded only when the post's link changed, never again on
// every run. This follows the detailed maps' run (scripts/detailed-maps/sync.mjs)
// and uses its parts.

import fs from "node:fs";
import path from "node:path";
import { PassingError, PROBLEM_LABEL, STATE_FILE, sha256File, sha256Text } from "../detailed-maps/maps.mjs";
import { setStatus } from "../detailed-maps/sync.mjs";
import { inspectAudio, megabytesText } from "./audio.mjs";
import { checkForm, parseForm } from "./form.mjs";
import {
  APPROVING_PERMISSIONS,
  CONTENT_TYPES,
  DATA_BRANCH,
  LABEL,
  REQUEST_FORM,
  REQUEST_LABEL,
  LIST_FILE,
  PAGE_FILE,
  RELEASE_TAG,
  SCHEMA,
  assetNameOf,
  downloadTrack,
  emptyList,
  findTrack,
  mayPostMusic,
  publish,
  shapeTracks,
  sortTracks,
  takeDown,
  updateDetails,
} from "./music.mjs";
import { buildPage, fitsText, lengthText, tagsText } from "./page.mjs";

export const MARKER = "<!-- hub-music -->";

// What this script reads from a post. 1: the first form; 2: genre, mood and
// instruments too. A post read by an older one is read again once (readAgain).
export const READER = 2;

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

// ---- the list and its files, read once per run ----------------------------------

export const openStore = async ({ client, now = () => new Date(), log = console.log }) => {
  const read = (await client.readData(LIST_FILE)) ?? emptyList();
  // Written back with its fields in the list's own order, whatever it was read with.
  const list = { schema: SCHEMA, updated: String(read.updated ?? ""), tracks: Array.isArray(read.tracks) ? shapeTracks(read.tracks) : [] };
  const state = (await client.readData(STATE_FILE)) ?? { version: 1, posts: {} };
  let tracksSaved = JSON.stringify(list.tracks);

  // The release is looked for when a file is first put in it or taken out of
  // it, and made the first time a track is published.
  let release;
  const releaseIfAny = async () => {
    if (release === undefined) release = (await client.listReleases()).find((entry) => entry.tag === RELEASE_TAG) ?? null;
    return release;
  };
  const releaseNow = async () => {
    if (await releaseIfAny()) return release;
    release = await client.createRelease({
      tag: RELEASE_TAG,
      title: "Background music",
      notes: [
        "The files of the hub's **background music** posts, checked and copied here automatically so the game can download them.",
        "",
        `Each track's composer, licence and credit: [${PAGE_FILE}](https://github.com/${client.repo}/blob/${DATA_BRANCH}/${PAGE_FILE}).`,
        "",
        "Do not upload, rename or delete files here by hand: the **Background music** workflow owns this release. To change a track, edit its post; to take it down, close its post as not planned.",
      ].join("\n"),
    });
    return release;
  };

  const dropAsset = async (name) => {
    const from = await releaseIfAny();
    const asset = from?.assets.find((entry) => entry.name === name);
    if (!asset) return;
    await client.deleteAsset(asset.id);
    from.assets = from.assets.filter((entry) => entry.id !== asset.id);
  };
  const putAsset = async (name, file, type) => {
    const into = await releaseNow();
    // A file of this name that the list does not point at is left from a run
    // that stopped half way: it goes.
    await dropAsset(name);
    const asset = await client.uploadAsset(into, name, file, { contentType: CONTENT_TYPES[type] });
    into.assets.push(asset);
    return asset;
  };

  // A version's file that a newer one took the place of is deleted only once
  // the list no longer points at it.
  const replaced = [];
  const save = async (message) => {
    sortTracks(list);
    // "updated" is when the tracks last changed, not when a post was last looked at.
    const tracks = JSON.stringify(list.tracks);
    if (tracks !== tracksSaved || !list.updated) list.updated = now().toISOString();
    tracksSaved = tracks;
    const written = await client.writeData({
      [LIST_FILE]: json(list),
      [STATE_FILE]: json(state),
      [PAGE_FILE]: buildPage(list, state, { repo: client.repo }),
    }, message);
    log(written ? `Saved: ${message}` : "The list is unchanged.");
    for (const name of replaced.splice(0)) await dropAsset(name);
  };

  return { list, state, putAsset, dropAsset, dropOnceSaved: (name) => replaced.push(name), save };
};

// ---- comments ---------------------------------------------------------------------

const row = (label, value) => `| ${label} | ${value} |`;
const detailsTable = ({ id, version, name, artist, licence, fits, genres, moods, instruments, type, bytes, sha256, seconds }) => [
  "| | |",
  "|---|---|",
  // (An ID is the track's for good only once the track is on the list.)
  row("Track ID", id ? `\`${id}\`${version ? " (it never changes)" : ""}` : "—"),
  row("Version", version ? String(version) : "—"),
  row("Name", name || "—"),
  row("Composer / artist", artist || "—"),
  row("File", type ? `${type === "mp3" ? "MP3" : "Ogg"}, ${megabytesText(bytes)} MB (${bytes} bytes), ${seconds === null ? "length not known" : `${lengthText(seconds)} long`}` : "—"),
  row("SHA-256", sha256 ? `\`${sha256}\`` : "—"),
  row("Licence", licence || "—"),
  row("Fits", fitsText(fits) || "—"),
  row("Genre", tagsText(genres) || "—"),
  row("Mood", tagsText(moods) || "—"),
  row("Instruments", tagsText(instruments) || "—"),
].join("\n");

const listedComment = ({ track, repo, note = "", closing = false }) => [
  MARKER,
  "### ✅ This track is on the music list",
  "",
  `Scenario makers can choose it for their scenarios, and it is credited on [the music page](https://github.com/${repo}/blob/${DATA_BRANCH}/${PAGE_FILE}). Its file is in the [music release](https://github.com/${repo}/releases/tag/${RELEASE_TAG}).`,
  ...(note ? ["", note] : []),
  ...(closing ? ["", "This post is closed now that its track is on the list, as every finished post on the hub is. It is still read when edited."] : []),
  "",
  "To replace the file, edit this post with the new download link; to change the name, the credit or anything else, edit the words. The checks run again on every edit. To take the track down, close this post as not planned.",
  "",
  detailsTable(track),
].join("\n");

const problemComment = ({ problems, listed, ...details }) => [
  MARKER,
  "### ❌ This post needs changes",
  "",
  "Fix the points below by editing this post (⋯ → Edit). The checks run again on every edit.",
  ...(listed ? ["", `Until then, the list keeps version ${listed} of this track as it is.`] : []),
  "",
  ...problems.map((problem) => `- ${problem}`),
  "",
  detailsTable(details),
].join("\n");

const waitingComment = (reason) => [
  MARKER,
  "### ⏳ The track couldn't be checked just now",
  "",
  reason,
  "",
  "It is tried again automatically; there's nothing to do.",
].join("\n");

const requestComment = ({ edited = false } = {}) => [
  MARKER,
  "### 🔎 Waiting for a maintainer to check this track",
  "",
  edited
    ? "This request was edited after a maintainer approved it, so the edit waits for their check like the request did."
    : "Thank you for this request. Every track on the hub is handed to every player, so before anything is downloaded a maintainer checks that its licence lets the hub share it and games play it: the **Licence**, **Source** and **Credit line** above are what they look at.",
  "",
  "Once it passes, they label it **music**: the track is then checked automatically, copied into the hub's music release and put on the music list, and this post is closed. Until then nothing in it is downloaded. If the licence doesn't allow it, the request is closed as not planned.",
  "",
  `(This post is now a song request. Anyone can [request a track](${REQUEST_FORM}).)`,
].join("\n");

const heldComment = (track) => [
  MARKER,
  "### ⏸️ This post's last edit was not read",
  "",
  `\`${track.id}\` stays on the music list as it was. A music post by someone who is not one of the hub's contributors is read as a maintainer approved it, and this edit came after that, so it changed nothing yet.`,
  "",
  "A maintainer approves the edit by taking the **music** label off this post and putting it back on. To take the track down, close this post as not planned.",
].join("\n");

// The latest time someone who may write to the repository put the music label on a post: their approval of the
// track, its copyright checked. { id, by }, or null for none. (A label the post's own form put on it is its
// author's, and approves nothing.) `permissions` keeps each person's answer for the run.
const approvalOf = async (client, number, permissions) => {
  const events = await client.labelEvents(number);
  for (const event of [...events].reverse()) {
    if (event.event !== "labeled" || event.label !== LABEL || !event.by) continue;
    if (!permissions.has(event.by)) permissions.set(event.by, await client.permissionOf(event.by));
    if (APPROVING_PERMISSIONS.includes(permissions.get(event.by))) return { id: event.id, by: event.by };
  }
  return null;
};

// ---- one post ---------------------------------------------------------------------

const checkPost = async ({ client, store, issue, record, workDir, download, inspect, hashFile, log, autoClose = false }) => {
  const { list, state } = store;
  const number = issue.number;
  const form = parseForm(issue.body);
  const track = record.id ? findTrack(list, record.id) : null;
  const { id, details, problems } = checkForm(form, list, { ownId: track ? track.id : "" });
  const listed = track ? track.version : 0;
  const say = (body) => setStatus(client, number, body, MARKER);
  const refuse = async (reasons) => {
    await say(problemComment({ problems: reasons, listed, id, ...details }));
    return "problem";
  };

  if (problems.length) return refuse(problems);

  // The same link as the file on the list: only the words changed, and the
  // file is not downloaded again.
  if (track && record.link === form.download) {
    updateDetails(track, details);
    await say(listedComment({ track, repo: client.repo, closing: autoClose, note: "Your last edit changed the details only (the download link is the same), so nothing was downloaded and there is no new version." }));
    return "details";
  }

  const file = path.join(workDir, `post-${number}.audio`);
  let check;
  try {
    const bytes = await download(form.download, file);
    const info = await inspect(file);
    check = { ...info, bytes, sha256: await hashFile(file) };
  } catch (error) {
    fs.rmSync(file, { force: true });
    if (error instanceof PassingError) {
      await say(waitingComment(error.message));
      return "waiting";
    }
    return refuse([error.message]);
  }
  try {
    // The same file as another track: most likely a new post made where the
    // track's own post should have been edited.
    const twin = list.tracks.find((other) => other !== track && !other.removed && other.sha256 === check.sha256);
    if (twin) return await refuse([`This file is already on the list as \`${twin.id}\` (#${twin.post}). To change that track, edit its own post instead of making a new one.`]);
    if (track && check.sha256 === track.sha256) {
      updateDetails(track, details);
      record.link = form.download;
      await say(listedComment({ track, repo: client.repo, closing: autoClose, note: `The file at the link is the same as version ${track.version}, so there is no new version.` }));
      return "details";
    }

    const version = track ? track.version + 1 : 1;
    const asset = await store.putAsset(assetNameOf({ id, version, ...check }), file, check.type);
    // The file this one takes the place of: the list points at one file for a
    // track, and the hub keeps no copy of music it no longer lists.
    if (track) store.dropOnceSaved(assetNameOf(track));
    const published = publish(list, {
      id,
      ...details,
      version,
      file: asset.url,
      ...check,
      post: number,
      postedBy: track ? track.postedBy : String(issue.user?.login ?? ""),
    });
    record.id = id;
    record.link = form.download;
    state.posts[number] = record;
    log(`#${number}: published ${id} version ${version} (${megabytesText(check.bytes)} MB)`);
    const made = await say(listedComment({ track: published, repo: client.repo, closing: autoClose }));
    // An edited comment notifies no one, so a new one says it.
    if (!made) await client.createComment(number, version === 1 ? `✅ \`${id}\` is on the music list.` : `✅ Version ${version} of \`${id}\` is on the music list, in place of version ${version - 1}.`);
    return "released";
  } finally {
    fs.rmSync(file, { force: true });
  }
};

// A listed track's post, unchanged since it was last read, read again for what
// a newer READER reads: its details only, from words that read cleanly and
// with the link of the file on the list. Anything else waits for the post's
// next edit, which is read in full. Nothing is said on the post. True when the
// track's details were read.
const readAgain = ({ store, issue, record }) => {
  const track = record.id ? findTrack(store.list, record.id) : null;
  if (!track || track.removed) return false;
  const form = parseForm(issue.body);
  const { details, problems } = checkForm(form, store.list, { ownId: track.id });
  if (problems.length || record.link !== form.download) return false;
  updateDetails(track, details);
  return true;
};

// ---- a run ------------------------------------------------------------------------

export const syncMusic = async ({
  client,
  workDir,
  autoClose = false,
  download = downloadTrack,
  inspect = inspectAudio,
  hashFile = sha256File,
  now = () => new Date(),
  log = console.log,
}) => {
  fs.mkdirSync(workDir, { recursive: true });
  const store = await openStore({ client, now, log });
  const { list, state } = store;
  const today = now().toISOString().slice(0, 10);
  const summary = { posts: 0, released: 0, details: 0, problem: 0, waiting: 0, requests: 0, removed: 0, unchanged: 0, readAgain: 0, closed: 0, reopened: 0 };
  // Who may write to the repository, asked once a run for each approver.
  const permissions = new Map();
  // Closed this run: kept with the posts' records, saved once at the end.
  let closedAny = false;
  // A post whose track is on the list is closed as completed, as the hub's other posts are once released.
  const closeIfListed = async (issue, record) => {
    const listed = record.id ? findTrack(list, record.id) : null;
    if (!autoClose || issue.state !== "open" || !listed || listed.removed) return;
    try {
      await client.closeAsCompleted(issue.number);
      record.closedByUs = true;
      state.posts[issue.number] = record;
      summary.closed += 1;
      closedAny = true;
    } catch (error) {
      log(`#${issue.number}: could not be closed (${error?.stack || error})`);
    }
  };
  // Posts read again by a newer READER this run: saved once, at the end.
  let readersMoved = false;

  for (const issue of await client.listPosts()) {
    summary.posts += 1;
    const number = issue.number;
    const record = state.posts[number] ?? {};
    const track = record.id ? findTrack(list, record.id) : null;

    // Closed as not planned: the track goes, for good. Its file first: that
    // is what a takedown is for, and the list follows.
    if (issue.state === "closed" && issue.state_reason === "not_planned") {
      if (track && !track.removed) {
        await store.dropAsset(assetNameOf(track));
        takeDown(track);
        record.removed = { date: today, reason: `Its post #${number} was closed as not planned.` };
        state.posts[number] = record;
        await setStatus(client, number, [
          MARKER,
          "### 🗑️ This track was removed",
          "",
          `Closing this post as not planned removed \`${track.id}\` for good: its file is deleted, and nobody can download it from the hub any more. It stays on the list as removed, so its ID is never used again.`,
        ].join("\n"), MARKER);
        await store.save(`Remove ${track.id} (#${number} closed as not planned)`);
        summary.removed += 1;
      } else {
        summary.unchanged += 1;
      }
      continue;
    }

    // A removed track's post edited or reopened: it is said once.
    if (track?.removed) {
      if (!record.toldRemoved) {
        await setStatus(client, number, [
          MARKER,
          "### 🗑️ This track was removed",
          "",
          `\`${track.id}\` was removed${record.removed?.date ? ` on ${record.removed.date}` : ""}, and a removed track can't come back. To share it again, make a new post: it gets a new ID.`,
        ].join("\n"), MARKER);
        record.toldRemoved = true;
        state.posts[number] = record;
        await store.save(`Tell #${number} its track was removed`);
      }
      summary.unchanged += 1;
      continue;
    }

    const bodyHash = sha256Text(issue.body);

    // The hub's contributors post music, by what GitHub says of the post's
    // author; anyone else's post is read once a maintainer has checked its
    // copyright and approved it by labelling it music, and only as it stood
    // then. Before anything in the post is read or followed.
    if (!mayPostMusic(issue)) {
      let approval = null;
      try {
        approval = await approvalOf(client, number, permissions);
      } catch (error) {
        log(`#${number}: who labelled it could not be read (${error?.stack || error})`);
        summary.waiting += 1;
        continue;
      }
      // A new approval is of the post as it stands now.
      if (approval && record.approvedEvent !== approval.id) {
        record.approvedEvent = approval.id;
        record.approvedBy = approval.by;
        record.approvedHash = bodyHash;
        state.posts[number] = record;
      }
      const approved = Boolean(approval) && record.approvedHash === bodyHash;
      if (!approved) {
        if (track) {
          // On the list as it was approved (or from when its author was a
          // contributor). The track stays; the edit is not read until a
          // maintainer approves it, and that is said once.
          if (record.bodyHash !== bodyHash && record.heldHash !== bodyHash) {
            await setStatus(client, number, heldComment(track), MARKER);
            await client.addLabel(number, REQUEST_LABEL, { description: "A track someone asks for: a maintainer checks its licence, then labels it music", color: "1d76db" }).catch(() => {});
            record.heldHash = bodyHash;
            state.posts[number] = record;
            await store.save(`Hold #${number}: an edit waiting for a maintainer`);
          }
          await closeIfListed(issue, record);
          summary.unchanged += 1;
          continue;
        }
        try {
          // A song request now: waiting for a maintainer, without the music label, which is theirs to put on.
          await setStatus(client, number, requestComment({ edited: Boolean(record.approvedEvent) }), MARKER);
          await client.addLabel(number, REQUEST_LABEL, { description: "A track someone asks for: a maintainer checks its licence, then labels it music", color: "1d76db" });
          await client.removeLabel(number, LABEL);
          if (issue.state === "closed" && issue.state_reason !== "not_planned") await client.reopen(number).catch(() => {});
          log(`#${number}: a song request, waiting for a maintainer`);
          summary.requests += 1;
        } catch (error) {
          // Something on GitHub's side: the post still has its label, so the next run comes back to it. (The
          // comment is found again, never made twice.)
          log(`#${number}: could not be made a request (${error?.stack || error})`);
          summary.waiting += 1;
        }
        continue;
      }
    }

    if (record.bodyHash === bodyHash) {
      await closeIfListed(issue, record);
      if ((record.reader ?? 1) < READER) {
        if (readAgain({ store, issue, record })) summary.readAgain += 1;
        record.reader = READER;
        state.posts[number] = record;
        readersMoved = true;
      }
      summary.unchanged += 1;
      continue;
    }

    let outcome;
    try {
      outcome = await checkPost({ client, store, issue, record, workDir, download, inspect, hashFile, log, autoClose });
    } catch (error) {
      // Something on GitHub's side: the post is looked at again next run.
      log(`#${number}: could not be finished (${error?.stack || error})`);
      summary.waiting += 1;
      continue;
    }
    summary[outcome] += 1;
    // A post that is waiting is looked at again on the next run.
    if (outcome !== "waiting") {
      record.bodyHash = bodyHash;
      record.reader = READER;
    }
    state.posts[number] = record;
    if (outcome === "problem") await client.addLabel(number, PROBLEM_LABEL).catch(() => {});
    else if (outcome !== "waiting" && (issue.labels ?? []).some((label) => (label?.name ?? label) === PROBLEM_LABEL)) await client.removeLabel(number, PROBLEM_LABEL).catch(() => {});
    await store.save(outcome === "released" ? `Publish ${record.id} version ${findTrack(list, record.id).version} (#${number})` : `Check #${number}`);
    if (outcome === "released" || outcome === "details") await closeIfListed(issue, record);
    // Closed by the hub and now needing changes: open again, where its author sees it (they can't reopen it).
    if (outcome === "problem" && autoClose && issue.state === "closed" && record.closedByUs) {
      await client.reopen(number).catch(() => {});
      record.closedByUs = false;
      state.posts[number] = record;
      summary.reopened += 1;
    }
  }
  if (readersMoved) await store.save(`Read the music posts again for their genre, mood and instruments (${summary.readAgain} tracks)`);
  if (closedAny) await store.save(`Close ${summary.closed} post(s) whose tracks are on the list`);
  return summary;
};
