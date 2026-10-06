// Keeps the hub's releases in step with its posts, and lets nothing into them
// that was not checked.
//
// Every run looks at ALL the posts and brings everything up to date, whatever
// started it (a post opened or edited, a comment, the half-hourly timer, a
// maintainer): a run that was skipped or failed is made up by the next one.
//
//   - a file attached to a post is downloaded, checked, put right where that
//     is safe (lib/check.mjs, run in a process of its own by lib/checker.mjs,
//     so that a file made to break the checks costs only itself), and the
//     CHECKED bytes are uploaded to a release;
//   - a post whose file has a problem is not released: it gets a comment
//     saying what is wrong (one comment, updated in place, removed once the
//     post is fixed) and the "file problem" label. If an earlier version of it
//     was released, that version stays on the hub until the new one is right;
//   - a released post is closed, when the hub is set to close them (the
//     HUB_AUTOCLOSE switch). Open or closed, a post is looked at again
//     whenever its text changes, because its author cannot reopen it;
//   - a post that left the hub (its label removed, deleted, closed as "not
//     planned") has its copies deleted, and its download count kept;
//   - a suggestion (a comment with a .zip on a scenario post) is checked where
//     it is. One the game could not use, or should not, is deleted, and its
//     author told why in a notice on the post;
//   - an issue labelled "security test" has its files checked the same way,
//     into a release of its own, and is told what happened to each;
//   - index.json is rewritten: the released posts, where the game finds each
//     file, how often each scenario's file was downloaded, and the suggestions
//     that passed.
//
// GitHub is reached only through `client` (lib/github.mjs), so all of this runs
// against a stand-in in the tests.

import { contentTypeOf } from "./check.mjs";
import { duration, sharedChecker } from "./checker.mjs";
import { COMMENT_MARKER, NO_FILE, SLOW_TEXT, TEST_NOTES, problemComment, spoken, suggestionNotice, testComment } from "./comments.mjs";
import { buildIndex } from "./index.mjs";
import {
  KINDS,
  MAX_FILE_BYTES,
  TEST_LABEL,
  TEST_RELEASE,
  TEST_RELEASE_NOTES,
  TEST_RELEASE_TITLE,
  assetName,
  chooseRelease,
  fileNameOf,
  hasLabel,
  isOwnRelease,
  isTestPost,
  kindOfIssue,
  kindOfTitle,
  parseReleaseLink,
  postFiles,
  releaseNotes,
  releaseTitle,
  suggestionZipOf,
} from "./posts.mjs";
import { sha256, sizeText } from "./util.mjs";

export { COMMENT_MARKER };
export const STATE_FILE = "state.json";
export const INDEX_FILE = "index.json";
export const PROBLEM_LABEL = "file problem";
// The version of the checks. A post that an earlier version handled is handled
// again: what version 1 copied, it copied without looking inside.
export const PIPELINE = 2;
// A problem that may pass by itself (GitHub not answering) is commented on only
// after this many runs in a row.
export const TRANSIENT_RUNS_BEFORE_COMMENT = 3;
// A copy that a newer one replaced is kept this long before it is deleted: the
// game holds the index for five minutes, and for that long may still ask for
// the copy the old index named.
export const REPLACED_COPY_MINUTES = 10;
// All the files of one post are checked within this long between them. Each
// has its own limit (checker.mjs), and a post can name a dozen: one made of
// files that each use their time up would keep a run busy past the time the
// workflow gives it, and the run after it, and the one after that.
export const POST_CHECK_MINUTES = 8;
// A suggestion whose file will not download is tried again on so many runs,
// and then left where it is, unlisted.
export const SUGGESTION_TRIES = 20;

const plainObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const list = (value) => (Array.isArray(value) ? value : []);

// ---- the workflow's notes -------------------------------------------------------

// state.json, whatever version wrote it. Version 1 knew only open posts and
// copied their files unchecked: each of its posts keeps its counts (`carried`,
// `skip`) and its copies (so their downloads go on being counted, and a copy
// that turns out identical to the checked one is kept), and is marked as not
// yet handled by these checks.
export const normalizeState = (raw) => {
  const state = plainObject(raw);
  const posts = {};
  for (const [key, old] of Object.entries(plainObject(state.posts))) {
    const record = plainObject(old);
    const current = Number(record.pipeline) === PIPELINE;
    posts[key] = {
      kind: record.kind,
      pipeline: Number(record.pipeline) || 1,
      bodyHash: current ? String(record.bodyHash ?? "") : "",
      // The checked copies that are released (for a version 1 post: its unchecked ones).
      files: list(record.files).filter((file) => file?.asset).map((file) => ({ source: file.source, primary: Boolean(file.primary), asset: file.asset, ...(file.repairs ? { repairs: file.repairs } : {}), ...(file.seen !== undefined ? { seen: file.seen } : {}) })),
      // Files of this repository's older releases that the post links directly.
      hosted: [...list(record.hosted), ...list(record.files).filter((file) => file?.hosted).map((file) => ({ source: file.source, primary: Boolean(file.primary), ...file.hosted }))],
      released: record.released ?? null,
      live: plainObject(record.live),
      stale: list(record.stale),
      carried: Number(record.carried) || 0,
      skip: plainObject(record.skip),
      problems: list(record.problems),
      failures: Number(record.failures) || 0,
      comment: record.comment ?? null,
      closedByUs: Boolean(record.closedByUs),
    };
  }
  const comments = plainObject(state.comments);
  return {
    version: 2,
    installedAt: typeof state.installedAt === "string" ? state.installedAt : "",
    posts,
    retired: plainObject(state.retired),
    tests: plainObject(state.tests),
    testComments: plainObject(state.testComments),
    comments: { since: typeof comments.since === "string" ? comments.since : "", waiting: plainObject(comments.waiting), counts: plainObject(comments.counts) },
    suggestions: plainObject(state.suggestions),
    notices: plainObject(state.notices),
  };
};

const newRecord = (kind, retired) => ({
  kind,
  pipeline: PIPELINE,
  bodyHash: "",
  files: [],
  hosted: [],
  released: null,
  live: {},
  stale: [],
  carried: Number(retired?.carried) || 0,
  skip: plainObject(retired?.skip),
  problems: [],
  failures: 0,
  comment: null,
  closedByUs: false,
});

const AVATAR = /^https:\/\/avatars\.githubusercontent\.com\//i;
const labelNames = (issue) => (issue.labels ?? []).map((label) => String(label?.name ?? label ?? "")).filter((name) => name && name.toLowerCase() !== PROBLEM_LABEL);
// The post as it is released: what the index shows of it until its next release.
const snapshotOf = (issue, bodyHash) => ({
  bodyHash,
  title: String(issue.title ?? ""),
  body: String(issue.body ?? ""),
  labels: labelNames(issue),
  user: { login: String(issue.user?.login ?? ""), ...(AVATAR.test(String(issue.user?.avatar_url ?? "")) ? { avatar_url: issue.user.avatar_url } : {}) },
  html_url: String(issue.html_url ?? ""),
  created_at: String(issue.created_at ?? ""),
  author_association: String(issue.author_association ?? "NONE"),
});
const liveOf = (issue) => ({
  state: issue.state === "closed" ? "closed" : "open",
  updated_at: String(issue.updated_at ?? ""),
  upvotes: Number(issue.reactions?.["+1"]) || 0,
  comments: Number(issue.comments) || 0,
});

// Whether a post is on the hub. An open one is. A closed one is gone when it
// was closed as "not planned" (how a post is taken down); closed as completed,
// it stays when this workflow closed it, or, while the hub closes its posts,
// when it had been released: by then "closed" is how every released post looks,
// whoever closed it. A closed post the hub never released stays off: closing
// it was taking it away, and turning the switch on must not bring back every
// post that was ever closed.
const isOnHub = (issue, record, autoClose) => {
  if (issue.state !== "closed") return true;
  if (issue.state_reason === "not_planned" || issue.state_reason === "duplicate") return false;
  if (!record) return false;
  return autoClose ? Boolean(record.closedByUs || record.released) : Boolean(record.closedByUs);
};

export const syncHub = async ({
  client,
  aliases = [],
  legacy = {},
  now = new Date(),
  log = () => {},
  maxUploads = 400,
  autoClose = false,
  only = null,
  checker = sharedChecker(),
  postCheckMs = POST_CHECK_MINUTES * 60000,
  deadline = Infinity,
}) => {
  const state = normalizeState(await client.readData(STATE_FILE));
  if (!state.installedAt) state.installedAt = now.toISOString();
  const before = JSON.stringify(state);
  const wanted = (number) => !only || only.has(Number(number));
  // Past `deadline` (a time on the clock) nothing new is started: what is left
  // waits for the next run, and what was done is written down. A run cut off
  // by the workflow's own time limit would write nothing, and the next would
  // start on the same work again.
  const late = () => Date.now() >= deadline;

  // Everything is read before anything is changed: a listing that fails ends
  // the run here, with nothing deleted on the strength of half a list.
  const listed = new Map(); // number -> issue, for every post with a kind label
  for (const kind of KINDS) {
    for (const issue of await client.listPosts(kind)) {
      if (issue?.pull_request || listed.has(Number(issue.number))) continue;
      if (kindOfIssue(issue)) listed.set(Number(issue.number), issue);
    }
  }
  const tests = new Map(); // number -> issue, for every test post
  const labelledTest = await client.listPosts(TEST_LABEL);
  for (const issue of labelledTest) if (isTestPost(issue)) tests.set(Number(issue.number), issue);
  const releases = await client.listReleases();
  const recentComments = await client.listComments(state.comments.since || undefined);

  const assetsById = new Map();
  const assetsByName = new Map(); // "tag/name" -> asset
  for (const release of releases) {
    for (const asset of release.assets) {
      assetsById.set(asset.id, { ...asset, tag: release.tag });
      assetsByName.set(`${release.tag}/${asset.name}`, { ...asset, tag: release.tag });
    }
  }
  const ownRepos = new Set([client.repo, ...aliases].map((name) => String(name).toLowerCase()));
  const releaseFileOf = (source) => {
    const link = parseReleaseLink(source);
    if (!link || !ownRepos.has(`${link.owner}/${link.repo}`.toLowerCase())) return null;
    return assetsByName.get(`${link.tag}/${link.name}`) ?? null;
  };
  // A file of one of this repository's older releases that a post links
  // directly (the official presets on the `bundles` release). It is checked
  // and copied like any other; what this is for is its download count, which
  // goes on counting for the post beside its checked copy's.
  const hostedFileOf = (source) => {
    const asset = releaseFileOf(source);
    return asset && !isOwnRelease(asset.tag) ? asset : null;
  };

  const onHub = new Map();
  for (const [number, issue] of listed) if (isOnHub(issue, state.posts[number], autoClose)) onHub.set(number, issue);
  // What a scenario may share a community basemap by: the address of a file of
  // one of the hub's own posts, or a file in this repository's releases. For a
  // post already looked at as it stands, those are the files that were
  // released for it (none, when it has a problem); for a new or changed one,
  // the files its text names, which this run is about to look at. (So a post's
  // text is read for its files when it changes, and not again on every run.)
  const sameText = (number, issue) => state.posts[number]?.pipeline === PIPELINE && state.posts[number].bodyHash === sha256(issue.body);
  const postAddresses = new Set();
  for (const [number, issue] of onHub) {
    const record = state.posts[number];
    const sources = sameText(number, issue) ? [...record.files, ...record.hosted] : postFiles(issue).files;
    for (const file of sources) postAddresses.add(file.source);
  }
  // (As lists, for the process that checks the files: posts.mjs's hubAddressTest.)
  const hubRepos = [...ownRepos];
  const hubAddresses = [...postAddresses];
  const hub = () => ({ addresses: hubAddresses, repos: hubRepos, assets: [...assetsByName.keys()] });

  const summary = { posts: onHub.size, copied: 0, kept: 0, deleted: 0, retired: 0, commented: 0, problems: 0, deferred: 0, closed: 0, reopened: 0, tests: tests.size, suggestionsKept: 0, suggestionsDeleted: 0 };
  const report = { posts: [], tests: [], suggestions: [] };

  // ---- copies in the releases ---------------------------------------------------

  // What a copy has been downloaded, less what was counted before the post
  // linked it (`skip`). When the copy is gone (someone deleted it by hand),
  // the last count seen stands, so no post's number ever drops.
  const countOf = (record, entry, id = entry.asset?.id ?? entry.id) => {
    const copy = assetsById.get(id);
    if (copy) entry.seen = Math.max(0, copy.downloads - (Number(record.skip?.[id]) || 0));
    return Number(entry.seen) || 0;
  };
  const importsOf = (key, record) => (Number(legacy[key]) || 0)
    + (Number(record.carried) || 0)
    + record.files.reduce((sum, file) => sum + (file.primary ? countOf(record, file) : 0), 0)
    + record.hosted.reduce((sum, file) => sum + (file.primary ? countOf(record, file) : 0), 0)
    + record.stale.reduce((sum, copy) => sum + (copy.primary ? countOf(record, copy) : 0), 0);

  const removeAsset = async (id) => {
    const copy = assetsById.get(id);
    if (!copy) return;
    await client.deleteAsset(id);
    assetsById.delete(id);
    assetsByName.delete(`${copy.tag}/${copy.name}`);
    const release = releases.find((entry) => entry.tag === copy.tag);
    if (release) release.assets = release.assets.filter((asset) => asset.id !== id);
    summary.deleted += 1;
  };
  // A released copy that is no longer the post's: kept a while under `stale`
  // (a game may hold an index that still names it), its downloads still counted.
  const setAside = (record, files, kept = new Set()) => {
    for (const file of files) {
      if (kept.has(file.asset.id)) continue;
      const seen = countOf(record, file);
      if (assetsById.has(file.asset.id)) record.stale.push({ id: file.asset.id, name: file.asset.name, primary: file.primary, since: now.toISOString(), seen });
      else if (file.primary) record.carried += seen;
    }
  };
  // The copies set aside long enough ago are deleted, and their downloads carried.
  const deleteStale = async (record, { all = false } = {}) => {
    const keep = [];
    for (const copy of record.stale) {
      const waited = now.getTime() - Date.parse(copy.since) >= REPLACED_COPY_MINUTES * 60000;
      if (!all && !waited && assetsById.has(copy.id)) {
        keep.push(copy);
        continue;
      }
      if (copy.primary) record.carried += countOf(record, copy);
      await removeAsset(copy.id);
    }
    record.stale = keep;
  };
  // The files of the older releases that the post's text links now. One it
  // no longer links stops counting: what it had counted is carried, and where
  // its count stood is remembered, so linking it again does not count it twice.
  const followHosted = (record, number, files) => {
    const links = [];
    for (const file of files) {
      const asset = hostedFileOf(file.source);
      if (!asset || links.some((link) => link.id === asset.id)) continue;
      // What it was downloaded before today is in the old counter's number,
      // when the post has one, so only downloads from here on are added to it.
      if (!(asset.id in record.skip)) record.skip[asset.id] = String(number) in legacy ? asset.downloads : 0;
      const known = record.hosted.find((link) => link.id === asset.id);
      links.push({ source: file.source, primary: file.primary, id: asset.id, tag: asset.tag, name: asset.name, url: asset.url, ...(known?.seen !== undefined ? { seen: known.seen } : {}) });
    }
    for (const old of record.hosted) {
      if (links.some((link) => link.id === old.id)) continue;
      if (old.primary) record.carried += countOf(record, old);
      const copy = assetsById.get(old.id);
      if (copy) record.skip[old.id] = copy.downloads;
      else delete record.skip[old.id];
    }
    record.hosted = links;
  };

  const upload = async (tag, title, notes, { name, type, bytes }) => {
    let release = releases.find((entry) => entry.tag === tag);
    if (!release) {
      release = await client.createRelease({ tag, title, notes });
      release.assets = release.assets ?? [];
      releases.push(release);
    }
    const asset = { ...(await client.uploadAsset(release.id, { name, contentType: contentTypeOf(type), bytes, tag: release.tag })), tag: release.tag };
    release.assets.push(asset);
    assetsById.set(asset.id, asset);
    assetsByName.set(`${asset.tag}/${asset.name}`, asset);
    summary.copied += 1;
    return asset;
  };

  // ---- one post's files: download, check, release ------------------------------

  // Checks the files a post names and uploads the checked copies.
  //   { files, problems, deferred, results }
  // `files` are the copies to release when there is no problem; `results` say
  // what happened to each file, for the report and for a test post's comment.
  // For a real post only THE file's problems are the post's, and nothing else
  // is looked at until THE file is right; a test post has every file judged.
  const checkFiles = async ({ number, kind, files: named, slow = false, known, test = false }) => {
    const files = [];
    const problems = [];
    const results = [];
    let deferred = 0;
    let unnamed = 0;
    let spent = 0; // on checking this post's files, in milliseconds
    if (slow) problems.push({ text: SLOW_TEXT, transient: false });
    else if (!named.some((file) => file.primary)) problems.push({ text: NO_FILE[kind], transient: false });
    for (const want of named) {
      if (!test && problems.length && !want.primary) break;
      const label = spoken(want.source, { kind, primary: want.primary, ordinal: test && !fileNameOf(want.source) ? (unnamed += 1) : 0 });
      const result = { label, name: fileNameOf(want.source), primary: want.primary, outcome: "", repairs: [], problems: [] };
      results.push(result);
      const fail = (text, transient) => {
        result.outcome = transient ? "waiting" : "refused";
        result.problems.push(text);
        if (want.primary || test) problems.push({ text, transient });
        else log(`#${number}: not copied: ${text}`);
      };
      if (spent >= postCheckMs) {
        // THE file is first, so this is something else attached, and it is
        // not fetched: for a post it is only not copied.
        const text = `${label} was not checked: the files of this ${test ? "issue" : "post"} together took more than ${duration(postCheckMs)} to check.`;
        if (test) fail(text, false);
        else {
          result.outcome = "left alone";
          log(`#${number}: not copied: ${text}`);
        }
        continue;
      }
      let got;
      try {
        got = await client.download(want.source, { maxBytes: MAX_FILE_BYTES });
      } catch (error) {
        const transient = error?.transient !== false;
        fail(transient
          ? `${label} could not be fetched from GitHub just now (${error?.message || error}).`
          : `${label} can't be downloaded any more (${error?.message || error}). Attach it again.`, transient);
        continue;
      }
      try {
        if (got.tooLarge) {
          if (want.primary || test) fail(`${label} can't be used: it is ${sizeText(got.size)}, and the game can import ${sizeText(MAX_FILE_BYTES)} at most.`, false);
          else result.outcome = "left alone";
          continue;
        }
        result.size = got.bytes.length;
        const began = Date.now();
        const checked = await checker.postFile({ kind, primary: want.primary, bytes: got.bytes, label, hub: hub(), timeoutMs: postCheckMs - spent });
        spent += Date.now() - began;
        if (checked.skip) {
          result.outcome = "left alone";
          continue;
        }
        if (!checked.released) {
          result.outcome = "refused";
          result.problems = checked.problems;
          if (want.primary || test) problems.push(...checked.problems.map((text) => ({ text, transient: false })));
          else for (const text of checked.problems) log(`#${number}: not copied: ${text}`);
          continue;
        }
        const hash = sha256(checked.bytes);
        const had = known.find((file) => file.source === want.source)?.asset;
        const name = assetName({ post: number, source: want.source, type: checked.type, sha256: hash, test });
        // The copy the post has already, when it is these very bytes; or one
        // by this exact name, uploaded by a run that failed before it could
        // say so (the name carries the bytes' hash).
        let asset = had && had.sha256 === hash && assetsById.has(had.id) ? had : null;
        if (!asset) {
          const left = [...assetsByName.values()].find((copy) => copy.name === name && (test ? copy.tag === TEST_RELEASE : copy.tag !== TEST_RELEASE));
          if (left) asset = { id: left.id, tag: left.tag, name: left.name, url: left.url, size: checked.bytes.length, sha256: hash };
        }
        if (asset) summary.kept += 1;
        else if (summary.copied >= maxUploads) {
          deferred += 1;
          result.outcome = "waiting";
          continue;
        } else {
          const tag = test ? TEST_RELEASE : chooseRelease(releases, kind).tag;
          let made;
          try {
            made = await upload(tag, test ? TEST_RELEASE_TITLE : releaseTitle(kind, tag), test ? TEST_RELEASE_NOTES : releaseNotes(kind), { name, type: checked.type, bytes: checked.bytes });
          } catch (error) {
            // The file is fine and the release would not take it: GitHub's
            // side or the hub's, never the author's. Tried again next run.
            log(`#${number}: ${name} could not be uploaded (${error?.message || error})`);
            fail(`${label} is in order, but could not be put into the hub's releases just now.`, true);
            continue;
          }
          asset = { id: made.id, tag: made.tag, name: made.name, url: made.url, size: checked.bytes.length, sha256: hash };
        }
        files.push({ source: want.source, primary: want.primary, asset, ...(checked.repairs.length ? { repairs: checked.repairs } : {}) });
        result.outcome = checked.repairs.length ? "repaired" : "as is";
        result.repairs = checked.repairs;
        result.copy = asset.name;
        result.url = asset.url;
        result.type = checked.type;
        result.copySize = checked.bytes.length;
        if (checked.pixels) result.pixels = checked.pixels;
      } catch (error) {
        // A fault of this program's own. Not the author's problem, and not a
        // reason to end the run for every other post: said in the log, and
        // tried again next time.
        log(`#${number}: ${label} could not be checked: ${error?.stack || error}`);
        fail(`${label} could not be checked just now (an error on the hub's side).`, true);
      }
    }
    return { files, problems, deferred, results };
  };

  const outcomeOf = (problems, deferred, results) => {
    if (problems.some((problem) => !problem.transient)) return "refused";
    if (problems.length || deferred) return "waiting";
    return results.some((result) => result.outcome === "repaired") ? "repaired" : "released as is";
  };

  // ---- the posts ---------------------------------------------------------------

  const ownCommentIds = new Set();
  const putComment = async (number, slot, body) => {
    // `slot` is { id, hash } or null; returns the slot as it is afterwards.
    const hash = sha256(body);
    if (slot?.hash === hash) return slot;
    if (slot) {
      try {
        await client.updateComment(slot.id, body);
        summary.commented += 1;
        return { id: slot.id, hash };
      } catch (error) {
        if (error?.status !== 404) throw error; // someone deleted it: written again
      }
    }
    const created = await client.createComment(number, body);
    summary.commented += 1;
    return { id: created.id, hash };
  };

  // New and edited posts first: their authors are waiting.
  const ordered = [...onHub.values()].sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
  for (const issue of ordered) {
    const number = Number(issue.number);
    if (!wanted(number)) continue;
    const kind = kindOfIssue(issue);
    const record = state.posts[number] ?? newRecord(kind, state.retired[number]);
    delete state.retired[number];
    state.posts[number] = record;
    record.kind = kind;
    record.live = liveOf(issue);
    await deleteStale(record);

    const bodyHash = sha256(issue.body);
    // Reopened by someone after this workflow closed it: looked at afresh.
    const reopened = record.closedByUs && issue.state !== "closed";
    if (issue.state !== "closed") record.closedByUs = false;
    const intact = record.files.every((file) => assetsById.has(file.asset.id)) && record.hosted.every((link) => hostedFileOf(link.source)?.id === link.id);
    const settled = record.pipeline === PIPELINE && record.bodyHash === bodyHash && !reopened && intact;
    const entry = { number, kind, title: String(issue.title ?? ""), state: record.live.state, outcome: "unchanged", files: [], problems: [] };
    report.posts.push(entry);

    if (!settled && late()) {
      entry.outcome = "waiting";
      summary.deferred += 1;
    } else if (!settled) {
      const { files: named, slow } = postFiles(issue, kind);
      followHosted(record, number, named);
      const attempt = await checkFiles({ number, kind, files: named, slow, known: record.files });
      entry.files = attempt.results;
      entry.outcome = outcomeOf(attempt.problems, attempt.deferred, attempt.results);
      summary.deferred += attempt.deferred;
      if (entry.outcome === "waiting") {
        // Nothing is concluded: what was released stays, and the post is
        // looked at again on the next run.
        if (attempt.problems.length) {
          record.problems = attempt.problems;
          record.failures += 1;
        }
      } else {
        if (entry.outcome === "refused") {
          // What an earlier pipeline copied was never checked: it is no
          // release to keep. A version these checks released stays.
          if (record.pipeline !== PIPELINE) {
            setAside(record, record.files);
            record.files = [];
            record.released = null;
          }
        } else {
          const kept = new Set(attempt.files.map((file) => file.asset.id));
          setAside(record, record.files, kept);
          // A copy that is kept keeps the count last seen for it.
          const seenBefore = new Map(record.files.filter((file) => file.seen !== undefined).map((file) => [file.asset.id, file.seen]));
          record.files = attempt.files.map((file) => (seenBefore.has(file.asset.id) ? { ...file, seen: seenBefore.get(file.asset.id) } : file));
          record.released = snapshotOf(issue, bodyHash);
        }
        record.pipeline = PIPELINE;
        record.bodyHash = bodyHash;
        record.problems = attempt.problems;
        record.failures = 0;
      }
    } else if (record.released?.bodyHash === bodyHash) {
      // Nothing about its files changed: its title and labels may have (a
      // maintainer pinned it), and those are what is released too.
      record.released = snapshotOf(issue, bodyHash);
    }
    const problems = record.problems;
    entry.problems = problems.map((problem) => problem.text);
    for (const problem of problems) log(`#${number} (${kind}): ${problem.text}`);
    summary.problems += problems.length ? 1 : 0;
    const definite = problems.some((problem) => !problem.transient);

    // The comment and the label.
    const speak = problems.length > 0 && (definite || record.failures >= TRANSIENT_RUNS_BEFORE_COMMENT);
    const labelled = hasLabel(issue, PROBLEM_LABEL);
    try {
      if (speak) record.comment = await putComment(number, record.comment, problemComment(kind, problems, { released: Boolean(record.released) }));
      else if (record.comment && !problems.length) {
        await client.deleteComment(record.comment.id);
        record.comment = null;
      }
      if (definite && !labelled) await client.addLabel(number, PROBLEM_LABEL);
      if (!problems.length && labelled) await client.removeLabel(number, PROBLEM_LABEL);
      // A real post that also carries the test label is told that it is real.
      if (hasLabel(issue, TEST_LABEL)) state.testComments[number] = await putComment(number, state.testComments[number], testComment({ note: TEST_NOTES.real(kind) }));
    } catch (error) {
      log(`#${number}: could not update its comment or label (${error?.message || error})`);
    }

    // Closing and reopening, only while the hub is set to close its posts. The
    // post is looked up again first: closing a post that a maintainer has just
    // closed as "not planned" would undo taking it down.
    if (!autoClose) continue;
    try {
      const released = record.released?.bodyHash === bodyHash && record.bodyHash === bodyHash && !problems.length;
      if (released && issue.state !== "closed") {
        const fresh = await client.getIssue(number);
        if (fresh?.state === "open") {
          await client.closeIssue(number);
          record.closedByUs = true;
          record.live.state = "closed";
          entry.closed = true;
          summary.closed += 1;
        }
      } else if (definite && issue.state === "closed" && record.closedByUs) {
        const fresh = await client.getIssue(number);
        if (fresh?.state === "closed" && fresh.state_reason !== "not_planned" && fresh.state_reason !== "duplicate") {
          await client.reopenIssue(number);
          record.closedByUs = false;
          record.live.state = "open";
          entry.reopened = true;
          summary.reopened += 1;
        }
      }
    } catch (error) {
      log(`#${number}: could not be closed or reopened (${error?.message || error})`);
    }
  }

  // ---- test posts ----------------------------------------------------------------

  const dropTestCopies = async (record) => {
    for (const file of list(record?.files)) await removeAsset(file.asset.id);
  };
  for (const issue of [...tests.values()].sort((a, b) => Number(a.number) - Number(b.number))) {
    const number = Number(issue.number);
    if (!wanted(number) || issue.state === "closed") continue;
    const kind = kindOfTitle(issue.title);
    const record = state.tests[number] ?? { key: "", files: [] };
    state.tests[number] = record;
    // The title too: it is what says which kind of post the files are checked as.
    const key = sha256(`${PIPELINE}\n${kind}\n${issue.body ?? ""}`);
    const entry = { number, kind, title: String(issue.title ?? ""), outcome: "unchanged", files: [], problems: [] };
    report.tests.push(entry);
    if (record.key === key && record.files.every((file) => assetsById.has(file.asset.id))) continue;
    if (late()) {
      entry.outcome = "waiting";
      summary.deferred += 1;
      continue;
    }
    let body;
    if (!kind) {
      await dropTestCopies(record);
      record.files = [];
      record.key = key;
      entry.outcome = "no kind";
      body = testComment({ note: TEST_NOTES.noKind });
    } else {
      const { files: named, slow } = postFiles(issue, kind);
      const attempt = await checkFiles({ number, kind, files: named, slow, known: record.files, test: true });
      entry.files = attempt.results;
      entry.outcome = outcomeOf(attempt.problems, attempt.deferred, attempt.results);
      entry.problems = attempt.problems.map((problem) => problem.text);
      summary.deferred += attempt.deferred;
      // Nothing points at a test post's older copies: they go at once.
      const kept = new Set(attempt.files.map((file) => file.asset.id));
      for (const file of record.files) if (!kept.has(file.asset.id)) await removeAsset(file.asset.id);
      record.files = attempt.files;
      // Left unsettled while a file could not be fetched, so the next run tries again.
      record.key = entry.outcome === "waiting" ? "" : key;
      body = named.length
        ? testComment({ kind, files: attempt.results })
        : testComment({ note: slow ? `Checked as a **${kind}** post. ${SLOW_TEXT}` : `Checked as a **${kind}** post. ${NO_FILE[kind].replace(/ Edit the post.*$/, "")} Attach one, or link one of this repository's files, and the checks run.` });
    }
    try {
      state.testComments[number] = await putComment(number, state.testComments[number], body);
    } catch (error) {
      log(`#${number}: could not write its result (${error?.message || error})`);
    }
  }

  // ---- what left the hub -----------------------------------------------------------

  // Each post that is no longer on the hub is looked up by itself first, when
  // the lists did not have it: a post missing from a list is cleared only once
  // GitHub says it has lost its label or is gone.
  for (const key of Object.keys(state.posts)) {
    const number = Number(key);
    if (onHub.has(number) || !wanted(number)) continue;
    let issue = listed.get(number);
    if (!issue) {
      try {
        issue = await client.getIssue(number);
      } catch (error) {
        log(`#${number}: could not be looked up (${error?.message || error}); left as it is`);
        continue;
      }
      if (issue && kindOfIssue(issue) && isOnHub(issue, state.posts[key], autoClose)) continue;
    }
    const record = state.posts[key];
    for (const file of record.files) {
      if (file.primary) record.carried += countOf(record, file);
      await removeAsset(file.asset.id);
    }
    await deleteStale(record, { all: true });
    followHosted(record, number, []);
    if (record.comment && issue) {
      await client.deleteComment(record.comment.id).catch((error) => log(`#${number}: ${error?.message || error}`));
    }
    if (record.carried > 0 || Object.keys(record.skip).length) state.retired[key] = { carried: record.carried, skip: record.skip };
    for (const [id, suggestion] of Object.entries(state.suggestions)) if (Number(suggestion.post) === number) delete state.suggestions[id];
    delete state.posts[key];
    delete state.comments.counts[key];
    report.posts.push({ number, kind: record.kind, title: String(issue?.title ?? ""), outcome: "off the hub", files: [], problems: [] });
    summary.retired += 1;
  }
  // A test issue that was closed, deleted or lost its label (or gained a kind,
  // and is a real post now): its copies go; its result stays as the record.
  for (const key of Object.keys(state.tests)) {
    const number = Number(key);
    if (!wanted(number)) continue;
    let issue = tests.get(number);
    if (!issue && !listed.has(number)) {
      try {
        issue = await client.getIssue(number);
      } catch (error) {
        log(`#${number}: could not be looked up (${error?.message || error}); left as it is`);
        continue;
      }
      if (issue && !isTestPost(issue)) issue = null;
    }
    if (issue && issue.state !== "closed") continue;
    await dropTestCopies(state.tests[key]);
    for (const [id, suggestion] of Object.entries(state.suggestions)) if (suggestion.test && Number(suggestion.post) === number) delete state.suggestions[id];
    delete state.tests[key];
    delete state.comments.counts[key];
  }

  // ---- suggestions ---------------------------------------------------------------

  for (const slot of [...Object.values(state.testComments), ...Object.values(state.notices), ...Object.values(state.posts).map((record) => record.comment)]) {
    if (slot?.id) ownCommentIds.add(Number(slot.id));
  }
  const numberOf = (comment) => Number(/\/issues\/(\d+)$/.exec(String(comment?.issue_url ?? ""))?.[1]) || 0;
  // Where a suggestion can be: a scenario post that is on the hub, or an open
  // test post.
  const suggestable = (number) => (kindOfIssue(onHub.get(number)) === "scenario" ? "post" : tests.has(number) && tests.get(number).state !== "closed" ? "test" : "");
  let cursor = state.comments.since;
  let held = false; // a comment is waiting to be tried again: the cursor stays before it
  for (const comment of recentComments) {
    const id = Number(comment?.id);
    const number = numberOf(comment);
    const stamp = String(comment?.updated_at ?? "");
    const pass = () => {
      if (!held && stamp > cursor) cursor = stamp;
    };
    if (!id || !wanted(number)) continue;
    const where = suggestable(number);
    const login = String(comment.user?.login ?? "");
    // Never a comment this workflow wrote, and never a bot's: told by who
    // wrote it and by its id, not by its text, which anyone can imitate.
    if (!where || ownCommentIds.has(id) || comment.user?.type === "Bot" || /\[bot\]$/i.test(login)) {
      pass();
      continue;
    }
    const zip = suggestionZipOf(comment.body);
    if (!zip) {
      delete state.suggestions[id]; // edited, and no suggestion any more
      pass();
      continue;
    }
    const known = state.suggestions[id];
    if (known && known.at === stamp && known.zip === zip) {
      pass(); // looked at already, as it stands
      continue;
    }
    if (late()) {
      held = true; // looked at on the next run, from here
      continue;
    }
    const label = spoken(zip);
    const entry = { comment: id, post: number, by: login, file: fileNameOf(zip), outcome: "", problems: [], ...(where === "test" ? { test: true } : {}) };
    report.suggestions.push(entry);
    let verdict = null;
    try {
      const got = await client.download(zip, { maxBytes: MAX_FILE_BYTES });
      verdict = got.tooLarge
        ? { ok: false, problems: [`${label} can't be used: it is ${sizeText(got.size)}, and the game can import ${sizeText(MAX_FILE_BYTES)} at most.`] }
        : await checker.suggestion({ bytes: got.bytes, label, hub: hub() });
    } catch (error) {
      if (error?.transient === false) verdict = { ok: false, problems: [`${label} can't be downloaded any more (${error?.message || error}).`] };
      else if (typeof error?.transient !== "boolean") log(`#${number}: the suggestion ${id} could not be checked: ${error?.stack || error}`);
    }
    if (!verdict) {
      // Its file could not be fetched just now: nothing is decided, and
      // nothing is deleted. Tried again next run, a bounded number of times.
      const tries = (Number(state.comments.waiting[id]) || 0) + 1;
      if (tries < SUGGESTION_TRIES) {
        state.comments.waiting[id] = tries;
        held = true;
        entry.outcome = "waiting";
      } else {
        delete state.comments.waiting[id];
        // Remembered as looked at, and never listed for the game.
        state.suggestions[id] = { post: number, zip, by: login, at: stamp, unlisted: true, ...(where === "test" ? { test: true } : {}) };
        entry.outcome = "given up";
        log(`#${number}: the suggestion ${id} could not be fetched in ${SUGGESTION_TRIES} runs; it is left where it is, unlisted`);
        pass();
      }
      continue;
    }
    delete state.comments.waiting[id];
    entry.problems = verdict.problems;
    if (verdict.ok) {
      state.suggestions[id] = { post: number, zip, by: login, at: stamp, ...(where === "test" ? { test: true } : {}) };
      entry.outcome = "kept";
      summary.suggestionsKept += 1;
      pass();
      continue;
    }
    // A suggestion with a problem: the comment is deleted, and its author is
    // told in one notice on the post, written once and kept up to date.
    entry.outcome = "deleted";
    for (const problem of verdict.problems) log(`#${number}: suggestion ${id} by ${login}: ${problem}`);
    try {
      await client.deleteComment(id);
      delete state.suggestions[id];
      summary.suggestionsDeleted += 1;
      const slot = `${number}:${login.toLowerCase()}`;
      state.notices[slot] = await putComment(number, state.notices[slot], suggestionNotice(login, verdict.problems));
      pass();
    } catch (error) {
      log(`#${number}: the suggestion ${id} could not be removed (${error?.message || error}); tried again next run`);
      held = true;
    }
  }
  state.comments.since = cursor;
  for (const id of Object.keys(state.comments.waiting)) if (!recentComments.some((comment) => Number(comment?.id) === Number(id))) delete state.comments.waiting[id];

  // A suggestion whose comment its author deleted is no longer one. Comments
  // are listed again only for a post whose number of comments moved.
  const suggested = new Map(); // post -> [comment id]
  for (const [id, suggestion] of Object.entries(state.suggestions)) suggested.set(Number(suggestion.post), [...(suggested.get(Number(suggestion.post)) ?? []), id]);
  for (const [number, ids] of suggested) {
    const issue = listed.get(number) ?? tests.get(number);
    if (!issue || !wanted(number) || state.comments.counts[number] === Number(issue.comments)) continue;
    try {
      const present = new Set((await client.listPostComments(number)).map((comment) => String(comment.id)));
      for (const id of ids) if (!present.has(String(id))) delete state.suggestions[id];
      state.comments.counts[number] = Number(issue.comments);
    } catch (error) {
      log(`#${number}: its comments could not be listed (${error?.message || error})`);
    }
  }
  for (const key of Object.keys(state.comments.counts)) if (!suggested.has(Number(key))) delete state.comments.counts[key];
  for (const slot of Object.keys(state.notices)) if (!state.posts[slot.split(":")[0]] && !state.tests[slot.split(":")[0]]) delete state.notices[slot];

  // ---- the index the game reads ----------------------------------------------------

  const index = buildIndex(state, { pipeline: PIPELINE, importsOf });
  const previousIndex = plainObject(await client.readData(INDEX_FILE));
  const comparable = ({ files, imports, posts, suggestions }) => JSON.stringify({ files, imports, posts, suggestions });
  const sameIndex = Number(previousIndex.version) === index.version && comparable(previousIndex) === comparable(index);
  const sameState = JSON.stringify(state) === before;
  if (!sameIndex || !sameState) {
    await client.writeData({
      [STATE_FILE]: `${JSON.stringify(state, null, 1)}\n`,
      [INDEX_FILE]: `${JSON.stringify({ ...index, generatedAt: now.toISOString() })}\n`,
    });
    summary.written = true;
  }
  return { summary, state, index, report };
};
