# Open Historia — Community Hub

Community content for [Open Historia](https://github.com/Open-Historia/open-historia).
Every **issue** on this repo is a post the game reads directly, so the in-game **Community**
tabs show what's posted here for everyone:

- Issues labeled **`scenario`** → the **Community** tab (playable scenarios).
- Issues labeled **`flag`** → the map editor's **Flags → Community** browser (country flags anyone
  can apply to any country on their map)
- Issues labeled **`basemap`** → the map editor's **Basemaps → Community** browser (custom map
  backgrounds you can build maps on).

## Post a scenario

1. In the game: **Community tab → ⬆ Publish to Hub** (it does the export + opens the form for you).
   Or export manually: **Scenarios → your scenario → Edit → Bundles → Download**.
2. Open a [**new scenario post**](https://github.com/Open-Historia/Open-historia-scenarios/issues/new?template=scenario.yml).
3. **Drag your exported file into the description box.** It's a **`.json`**, or a **`.zip`** if your
   scenario uses a custom basemap (the zip bundles the map image too). GitHub uploads it and inserts a
   link — without that link nobody can import your scenario.
4. Submit. It now appears in the game's Community tab.

If your scenario uses a custom basemap, that basemap also shows up on its own in the editor's
**Basemaps → Community** browser (installable straight from the scenario's zip) — no separate upload
needed.

## Post a basemap

Share a fantasy/alternate map background others can build scenarios on.

1. In the map editor: **Basemap picker → your basemap → ⤴ (publish)** — it hands you the image file
   and opens the form.
2. Open a [**new basemap post**](https://github.com/Open-Historia/Open-historia-scenarios/issues/new?template=basemap.yml).
3. **Drag the image file into the "Basemap image" box** (a `.png`/`.jpg`, or a `.geojson` for a vector
   basemap). The image is both the map and its preview. Don't edit the auto-filled **Technical info** lines.
4. Submit. It appears in the editor's **Basemaps → Community** browser.

## Post a flag

A flag is just an image — no bundle, no hash, nothing to prepare.

1. In the map editor: click a region, then **Flag → Choose flag → Community → ⬆ Share a flag**.
   (It opens the form below with the name prefilled. You can also open it by hand.)
2. Open a [**new flag post**](https://github.com/Open-Historia/Open-historia-scenarios/issues/new?template=flag.yml).
3. **Drag your flag image into the "Flag image" box** — `.png`, `.jpg`, `.webp`, `.gif` or `.svg`
   (an `.svg` is turned into a `.png` for you). That image is both the flag and its preview, so
   there's nothing else to upload. Roughly 3:2 looks best; large images are scaled down to 256px when
   someone applies one.
4. Submit. It appears in the editor's **Flags → Community** browser.

Flags posted here are usable on **any** country in **any** scenario — the `Flag-Code` line is only a
hint about what you drew it for, not a restriction.

## Vote & discuss

- 👍 **react on an issue** to upvote it — the in-game *Most Liked* row uses these.
- 🚀 react if you played it.
- Comment on an issue to review or give feedback.

## Pinned & Official

- **📌 Pinned** posts carry the `pinned` label, which **only hub collaborators can apply** —
  GitHub silently drops labels set by anyone without write access (via the API, issue forms
  or URL parameters alike), so you cannot pin your own post. Great community posts get pinned
  by the moderators.
- **✓ Official** (purple in-game) marks posts whose author is the hub owner or a repo
  collaborator, as reported by GitHub's `author_association` — writing "official" in a
  title does nothing.

## Where the files are kept

You attach your file to your post, as described above, and that is all you do. A workflow
([**Copy post files to releases**](.github/workflows/copy-post-files.yml)) then **checks** every file
attached to a scenario, flag or basemap post, and copies the checked file into this repository's
[releases](https://github.com/Open-Historia/Open-historia-scenarios/releases) (`scenarios-1`,
`flags-1`, `basemaps-1`, and a `-2` once one is full), and the game downloads it from there.
It runs when a post is opened or edited, when someone comments, and every half hour.

- **What the game downloads is the checked copy**, which is not always byte for byte what you
  attached: see [What is repaired](#what-is-repaired).
- **Editing your post** with a new file is how you release an update. The new file is checked and
  takes the old copy's place; if it has a problem, the hub keeps the version it had until you fix
  it. You never need to open a second post, and you do not need to reopen a closed one.
- **If your file has a problem** it is not released, and the workflow says what is wrong in a
  comment on your post: see [If your post gets a "file problem" comment](#if-your-post-gets-a-file-problem-comment).
- A post whose file passed is in the hub's index a minute or so after you submit it. Game builds
  from before the index listed posts read the list of open posts from GitHub itself, and download a
  file straight from its post until its checked copy is there.

The game finds everything through [`index.json`](https://github.com/Open-Historia/Open-historia-scenarios/blob/hub-index/index.json)
on the `hub-index` branch, which the workflow rewrites: the released posts, where the checked copy
of each of their files is, how often each scenario has been downloaded, and which suggestions passed
the checks. Do not edit that branch, or upload, rename or delete files in those releases, by hand.

## What is checked

Every file of every post is looked into before it is released, and has to be something the game
can use and nothing else.

- **Pictures** (a flag, a basemap image, a scenario's cover, the flags and logos inside a scenario,
  pictures in a post) have to be a PNG, JPEG, WebP or GIF (an AVIF only as a scenario's cover),
  whole from their first byte to their last, and no larger than what they are used as allows: a
  flag 16 megapixels, a cover or a picture 40, a basemap 16,384 pixels a side and 150 megapixels,
  and any picture 30 MB.
- **A scenario file** (`.json` or `.zip`) has to be a scenario the game can import: its parts the
  way the game writes them, its cover a picture, its maps GeoJSON the game can draw, its tile
  archives PMTiles, and every file its `scenario.json` points at really in the `.zip`.
- **A scenario's flags and logos are carried in the file** (or are the game's own built-in flags).
  A scenario may not have the game load a picture from another website, and its text may not embed
  one (`![…](https://…)`, `<img>`): whoever runs that website would see every player who opens the
  scenario. Ordinary links in text are fine. (Once a text has opened a picture with `![`, every
  link after it is read as a picture's: which bracket closes which is easy to write so that two
  readers disagree, and the checks do not try to out-read the game.)
- **A `.zip`** may hold JSON, pictures, tile archives and plain text files, each really what its
  name says, and nothing else: no programs, scripts, web pages, or archives inside the archive. It
  may not be encrypted or split, no entry may leave its folder, and it may hold 2,000 entries and
  unpack to 1 GB at most.
- **A basemap file** is an image, or the `.zip` the editor gives you for a vector basemap (the
  older `.json` forms are read too), with a map in it the game can draw.
- **Nothing in a file may be something a program could be made to run or follow**: no `javascript:`
  addresses, no `data:` addresses other than pictures, no fields named `__proto__`, `constructor`
  or `prototype`.
- **A file has to be one that can be checked.** Each file is checked by itself, with three minutes
  and a few gigabytes of memory to do it in (the largest scenarios on the hub take five seconds
  and one gigabyte), and JSON may be nested 200 levels deep. A file made to need more is refused,
  and costs no other post anything.
- **The post's own text** is searched for its file the way the game searches it. A text that
  repeats the start of a link thousands of times, which would keep the game busy for minutes, is
  not searched, and the post is not released until it is edited.

## What is repaired

A few things are put right rather than refused. The copy the game downloads is the repaired one;
your attachment is not touched.

- **An SVG becomes a PNG.** An SVG is not a picture but instructions for drawing one, and those can
  load things and run things, so the hub never serves one. Every SVG (a flag you post, a basemap,
  an SVG inside a scenario's `.zip` or written into its JSON) is drawn once and released as a PNG:
  a flag 1024 pixels on its longer side, a cover 1600, a basemap at its own size up to 8192. Text
  in an SVG is drawn only if it was turned into shapes ("convert to outlines") first.
- **Whatever follows the end of a picture is cut off.**
- **A flag over 2 MB** (more than the game's flag library takes) is drawn again as a PNG of at most
  1024 pixels. A WebP that heavy cannot be made smaller here: post it as a PNG or a JPEG.
- **A `.zip` is written again** from its checked contents, so nothing that was not looked at
  travels with it. An SVG inside becomes a `.png`, and the scenario points at the new name.
- **A scenario's link to a post of its own** is taken out, and **its cover is made to say what kind
  of picture it is** (the game refuses a cover that does not).

## If your post gets a "file problem" comment

The comment names the file, or the entry inside your `.zip`, and says what is wrong with it. Put
that right in the game, export the scenario again, then **edit your post** (⋯ → Edit) and drag the
new file in where the old one was. The post is checked again on every edit, and the comment and the
`file problem` label go away by themselves once the file is in.

While an update has a problem, the version of your post that was released before stays on the hub.
If the comment says GitHub could not be reached, you need not do anything: it is tried again.

## Suggestions

A suggestion is a comment on a scenario post that carries the `…-suggestion.zip` saved by the
game's **Suggest changes**. It is never copied: it stays where its author put it, and the author
of the scenario reads it from there. It is checked all the same, by the rules above, and one the
game could not use (or that holds something it should not) is **deleted**, with a notice on the
post telling whoever suggested it why. Nothing can be repaired in a suggestion, so an SVG in one
counts as a problem: use a PNG. You can always suggest again from the game.

## Closed posts

The workflow can close a post once its file has been released, so that the open issues are the
ones that still need something. A closed post is on the hub like any other; "closed as completed"
then simply means "released". This is **off** for now, and is turned on by setting the repository
variable **`HUB_AUTOCLOSE`** to `1` (Settings → Secrets and variables → Actions → Variables) once
the game builds that list closed posts are the ones people have: every build before them lists
open posts only, and would show an empty hub.

- To update a closed post, **edit it**. You do not need to reopen it (and GitHub would not let you
  reopen a post someone else closed). The edit is checked like a new post; if it has a problem, the
  workflow reopens the post with its comment, and closes it again once the problem is fixed.

## Taking a post down

- **Your own post:** close it. While posts are not closed automatically, any closed post is off the
  hub; once they are, choose **Close as not planned** (the arrow beside *Close issue*).
- **Moderators:** close the post as **not planned**, or remove its `scenario` / `flag` / `basemap`
  label. Deleting the issue does it too.

On the next run the post's files are deleted from the releases and it is gone from the index. Its
download count is kept, should it come back.

## Install counts

A scenario's install count is **how many times its file has been downloaded from the release**,
as GitHub counts it. The workflow adds the counts up every half hour and writes them into
`index.json`, and the in-game **⬇ Most Installed** row shows them. A new version of a scenario
keeps the count of the versions before it.

Counting used to be done by a counter of the game's own. What it had counted for each post on
5 October 2026 is kept in [`data/legacy-import-counts.json`](data/legacy-import-counts.json) and
added in, so no post's number started again from nothing.

The official preset bundles live on the older
[**`bundles` release**](https://github.com/Open-Historia/Open-historia-scenarios/releases/tag/bundles).
Their posts link them there; like every other file they are checked and get a checked copy, and
downloads of either count. (The `bundles/` folder in this repo is a mirror for older game versions
and is not counted.)

## Import

In-game: **Community tab → Import** on a scenario card, or **Basemaps → Community → Install** on a
basemap card. (Manually: download the attached file and use **Scenarios → Import JSON**.)

## Maintainer setup

The `basemap.yml` form applies a **`basemap`** label to every basemap post. A form can only apply a
label that already exists, so this repo must have a label named exactly **`basemap`**
(Issues → Labels → New label). Without it, basemap posts submit unlabeled and the in-game Basemaps
browser (which queries `labels=basemap`) stays empty. The `scenario` and **`flag`** labels work the
same way — **`flag` must be created before the first flag post**, or the Flags → Community browser
stays empty no matter how many people post.

## Testing the checks

To see what the checks do with a file made to be refused or repaired, without anything of it
reaching a player:

1. Open an issue and give it the label **`security test`**, and **none** of `scenario`, `flag`
   and `basemap`. Games list posts by those three labels, so an issue without them is in no game.
   (The label has to exist first: Issues → Labels → New label, named exactly `security test`.)
2. Start its title with **`[Scenario]`**, **`[Flag]`** or **`[Basemap]`**: that says what its
   files are checked as.
3. Attach the files, as in a real post. A file kept on a branch of this repository works too:
   `https://github.com/Open-Historia/Open-historia-scenarios/raw/<branch>/files/<name>`.

The workflow answers with **one result comment**, brought up to date whenever the issue is edited.
For each file it says whether it was *released as it was*, *repaired* (each repair on a line of
its own, and a link to the checked copy), or *refused* (every problem, in the words a post's author
would get). The checked copies go into a release of their own, `security-test`, and into nothing
else: a test issue is not in the index, is never counted, closed or labelled `file problem`.

- **Suggestions** are tested by commenting on a test issue the way a suggestion is posted (a
  comment with a `…-suggestion.zip`). One with a problem is deleted with its notice, exactly as on
  a real post; one that passes stays, and is not listed for any game.
- An issue that carries a kind label as well as `security test` is a **real post**: games would
  list it, so it is handled as one, and its result comment says so.
- **A file made to break the checks themselves** (to use up the memory, or never to finish) is
  refused like any other, in so many words ("checking it takes more memory than the hub has for one
  file", "checking it took more than 3 minutes"), and the run goes on to the next file. If a
  result ever says a file *could not be checked just now (an error on the hub's side)*, that is a
  fault in the checks: the run's log has the details, and it is worth reporting.
- **To clean up**, close the issue (or delete it, or take the label off): its copies in the
  `security-test` release are deleted on the next run. The result comment stays as the record.

The same checks can be run on your own machine against the real hub, changing nothing:
`npm ci`, then `node scripts/sync-hub.mjs --dry-run` (add `--posts 12,34` for a few posts, and
`--report report.json` for the result as data). `npm test` runs the tests.

---

Scenarios and basemaps are player-made content. The hub is moderated; broken or abusive posts are
closed as not planned.
