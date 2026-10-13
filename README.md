# Open Historia — Community Hub

Community content for [Open Historia](https://github.com/Open-Historia/open-historia).
Every **issue** on this repo is a post the game reads directly, so the in-game **Community**
tabs show what's posted here for everyone:

- Issues labeled **`scenario`** → the **Community** tab (playable scenarios).
- Issues labeled **`flag`** → the map editor's **Flags → Community** browser (country flags anyone
  can apply to any country on their map)
- Issues labeled **`basemap`** → the map editor's **Basemaps → Community** browser (custom map
  backgrounds you can build maps on).
- Issues labeled **`detailed map`** → **Maps → Community → Detailed maps** (large, sharp terrain
  maps that scenarios are drawn on).
- Issues labeled **`music`** → the game's music list for scenario makers (background music a
  scenario can play; posted by the hub's contributors only).

**📜 [Every detailed map, with its credits and licence](https://github.com/Open-Historia/Open-historia-scenarios/blob/detailed-maps-index/DETAILED-MAPS.md)**

**🎵 [Every music track, with its credit and licence](https://github.com/Open-Historia/Open-historia-scenarios/blob/music-index/MUSIC.md)**

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

## Post a detailed map

The maps already shared, with their credits and licences, are in
[**DETAILED-MAPS.md**](https://github.com/Open-Historia/Open-historia-scenarios/blob/detailed-maps-index/DETAILED-MAPS.md).

> **Two different things:**
> - A **basemap** is the flat map drawn under the countries: a built-in Earth map, an uploaded
>   picture, or a painted map. Every scenario has one, and a custom one travels inside the scenario.
> - A **detailed map** is an optional layer drawn **on top of** a scenario's basemap: a large set of
>   picture tiles (often hundreds of MB) that stays sharp from the whole world down to single castles.
>   It's far too big to go inside a scenario, so it lives here, and a scenario only names it: "this
>   map, version 1 or newer".

Every scenario on a detailed map **must also have its own basemap**. Players who don't download the
detailed map, or whose game can't show it, see the basemap instead.

**Using one in a scenario:** in the Map Editor, press **Basemap: …** in the bottom bar. Give your
scenario a basemap of its own first (**My Maps → Your basemaps**). Then **Community → Detailed maps**,
download the map, and pick it under **My Maps → Your detailed maps**. Your scenario only names it, so
players are offered the download (with its size) when they install your scenario, or later from
**Settings → Map → Detailed maps**. A detailed map downloads once, however many scenarios use it.

**Making one:** a **raster `.pmtiles` file** (PNG, JPEG, WebP or AVIF tiles) of **500 MB or less**.
Extra detail can be drawn only around important places: where a close-up tile is missing, the game
enlarges the nearest one. Try it in your own game first with **⬆ Add basemap or detailed map** in the
Maps window. You must have the right to share everything in it: credit every source and follow its
licence (a map built on CC BY-NC-SA material must be CC BY-NC-SA too).

**Posting it:**

1. Put the `.pmtiles` file online as a **direct download**. It's too big to drag into a post. A
   release on your own GitHub works best; Google Drive often doesn't work for big files. You can
   delete your copy once the map is on the list.
2. Open a [**new detailed map post**](https://github.com/Open-Historia/Open-historia-scenarios/issues/new?template=detailed-map.yml),
   or press **⤴** on your map in the game's Maps window (**My Maps → Your detailed maps**), which
   fills in the name, size and checksum for you.
3. Fill in the download link, a map ID if you want one (lower-case letters, digits and dashes, like
   `got-world`; empty makes one from the name), what it shows, screenshots, credits and licence.
   The first screenshot becomes the map's picture in the game. Don't delete or rename the form's headings: the bot reads your answers under them.
4. Submit. Within minutes the bot downloads the file and checks it the way the game will (a real map
   of picture tiles, 500 MB or less, matching the checksum if you gave one), and either puts it on the
   list (✅ **This map is on the list**) or says exactly what to fix (❌ **This post needs changes**,
   with the `needs changes` label). To fix something, edit the post: the checks run again.

**The map ID and who owns a map:** the ID is how scenarios find your map. No two maps share one, and
once your map is on the list its ID never changes. The map belongs to its post: only you (and the
hub's moderators) can edit the post, so only you can release new versions.

**Updating it:** edit your post with the **new download link**, and replace **What changed?** with
what's new. The new file becomes the next version (version 2, 3…). Players see what changed in the
game before downloading, and the bot's comment on the post keeps it, so the comments build up into
the map's history. Editing only the words (name, credits, licence) changes the
map's details and downloads nothing. Players who have an older version keep it; the game offers the
update with its size, and never downloads it without asking. Scenarios name the lowest version they
need, so scenarios made on version 1 keep working.

**Taking it down:** close the post as **not planned**. That deletes the map **for good**: its files
go, and its ID is never used again (it stays on the list as removed, so scenarios that name it can say
so). Players who already have it keep their copy. Deleting the issue or removing its label does
**not** remove the map; close it as not planned instead.

## Post background music

The tracks already shared, with their credits and licences, are in
[**MUSIC.md**](https://github.com/Open-Historia/Open-historia-scenarios/blob/music-index/MUSIC.md).

Background music is tracks a scenario can play: while a game loads, in the game, at war and in the
war room. A scenario never carries music. It only **names** tracks from the hub's music list, by
their ID, and the game downloads those from here.

> **Only the hub's contributors can post music** (people the maintainers have given access to this
> repository). A flag or a map is usually its author's own to share. A piece of music almost always
> belongs to someone else, and the hub hands a copy of it to every player, so every track has to be
> one the hub is allowed to share, checked by someone the maintainers know. A music post from anyone
> else is closed with a note, and nothing of it is downloaded.
>
> **To propose a track, ask on [Discord](https://discord.gg/QaqAK7fQAg):** say where the track is
> and what its licence is, and a contributor can post it.

**What can be posted:** an **`.mp3`** or **`.ogg`** file (Vorbis or Opus) of **20 MB or less**, under
a licence that lets the hub share it and games play it: CC0, CC BY, CC BY-SA, public domain, your
own work released under CC BY 4.0 or CC0 1.0, or another free licence, which you name. Music that
may be used but not passed on ("royalty free" from a paid library, a game's or a film's soundtrack,
anything from a streaming service) can't be posted.

**Posting it:**

1. Put the file online as a **direct download**. It's too big to drag into a post. A release on
   your own GitHub works best. You can delete your copy once the track is on the list.
2. Open a [**new music post**](https://github.com/Open-Historia/Open-historia-scenarios/issues/new?template=music.yml)
   and fill in:
   - **Track name**, and a **Track ID** if you want one (lower-case letters, digits and dashes,
     like `passage-of-time`; empty makes one from the name).
   - **Composer / artist** and **Licence**.
   - **Source:** the page where the track and its licence can be seen.
   - **Credit line:** the attribution to show for the track, worded the way its licence or its
     composer asks, for example
     `'Passage Of Time' by Scott Buckley - released under CC-BY 4.0. www.scottbuckley.com.au`.
   - **Download link to the audio file.**
   - **Fits** (optional): where the track suits: the menu, a game loading, in the game, at war, in
     the war room. Scenario makers see these as suggestions, and can still use a track anywhere.
   - **Notes** (optional), and the box that says you have checked the licence and the credit.

   Don't delete or rename the form's headings: the bot reads your answers under them.
3. Submit. Within minutes the bot checks the post and either puts the track on the list
   (✅ **This track is on the music list**) or says exactly what to fix (❌ **This post needs
   changes**, with the `needs changes` label). To fix something, edit the post: the checks run again.

**What is checked:** that the post's author is one of the hub's contributors, by what GitHub itself
reports of them (nothing a post says about its author counts). Then that the composer, licence,
source (a link) and credit line are filled in and the box is ticked; that the file downloads from
the link (an `https://` link to a public address); that it is 20 MB or less; and that it really is
an MP3 or an Ogg Vorbis or Opus file, told by what is in it and not by its name, so a file that was
only renamed is refused. The bot can't tell whether a licence is true: that is what the box, and the
rule about who can post, are for.

**The track ID:** the ID is how scenarios find a track. No two tracks share one, and once a track is
on the list its ID never changes.

**Updating it:** edit your post. A **new download link** to a different file makes the next version
(version 2, 3…), which takes the place of the last one: the list points at the new file, and the old
file is deleted. Editing only the words (name, composer, licence, source, credit, where it fits)
changes the track's details and downloads nothing. Scenarios that use the track keep working: they
name it by its ID.

**Taking it down:** close the post as **not planned**. That removes the track **for good**: its file
is deleted, and it stays on the list marked as removed, so its ID is never used again and a scenario
that names it simply plays without it. Deleting the issue or removing its label does **not** remove
the track; close it as not planned instead.

**Where the list and the credits are:** on the `music-index` branch.
[`music.json`](https://github.com/Open-Historia/Open-historia-scenarios/blob/music-index/music.json)
is what the game reads, and
[`MUSIC.md`](https://github.com/Open-Historia/Open-historia-scenarios/blob/music-index/MUSIC.md)
beside it lists every track with its composer, licence, source and credit line: that page is how
the hub credits the music. The files themselves are in the
[`music` release](https://github.com/Open-Historia/Open-historia-scenarios/releases/tag/music).

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
- **A scenario's music is named, never carried.** A scenario may name tracks of the hub's
  [music list](#post-background-music) for a game loading, in the game, at war and in the war room
  (`loading`, `game`, `atWar`, `battle`: at most 12 tracks each), every one by its ID and version
  and nothing else. It may not hold a sound file, or the address of one: every player's game would
  fetch it from wherever the scenario's author liked, and it would be music nobody checked the hub
  may share. A track that has since been taken down is not a problem: the game skips it.
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

In-game: **Community tab → Import** on a scenario card, **Basemaps → Community → Install** on a
basemap card, or **Maps → Community → Detailed maps → Download** on a detailed map. (Manually: download the attached file and use **Scenarios → Import JSON**.)

## Maintainer setup

The `basemap.yml` form applies a **`basemap`** label to every basemap post. A form can only apply a
label that already exists, so this repo must have a label named exactly **`basemap`**
(Issues → Labels → New label). Without it, basemap posts submit unlabeled and the in-game Basemaps
browser (which queries `labels=basemap`) stays empty. The `scenario` and **`flag`** labels work the
same way — **`flag` must be created before the first flag post**, or the Flags → Community browser
stays empty no matter how many people post. **`detailed map`** must exist too, before the first
detailed map post, and **`music`** before the first music post.

### Detailed maps

Detailed map posts have a workflow of their own, [**Detailed maps**](.github/workflows/detailed-maps.yml),
apart from **Copy post files to releases** (which looks at scenario, flag and basemap posts only).
It checks each new or edited post, copies the map file into a `detailed-maps-<n>` release as
`<id>-v<version>.pmtiles`, and writes the list the game reads, `detailed-maps.json`, with
`DETAILED-MAPS.md` for people, to the **`detailed-maps-index`** branch. Don't edit that branch or
those releases by hand. There is no approval step: a map that passes the checks is on the list at
once. Moderate it like any other post.

Two more workflows, for maintainers (**Actions → the workflow → Run workflow**):

- **Archive or restore a detailed map:** archived, a map stays on the list but is no longer offered
  for download, and its file moves to the draft release `detailed-maps-archived` (kept, not deleted).
  Players who have it keep using it. Restoring offers it again. One version or the whole map.
- **Delete a detailed map:** deletes a map (or one version) for good, like closing its post as not
  planned. Type the ID again to confirm.

Both post a comment on the map's post saying what was done, by whom, and why.

### Background music

Music posts have a workflow of their own too, [**Background music**](.github/workflows/music.yml),
which looks at issues labelled `music` and at nothing else. For each new or edited post it:

- **turns the post away unless its author is a contributor**: GitHub has to report the author as
  the repository's `OWNER`, a `MEMBER` of the organisation or a `COLLABORATOR` (the issue's
  `author_association`; the list is `ALLOWED_ASSOCIATIONS` in `scripts/music/music.mjs`). Anyone
  else's post gets one comment, the `needs changes` label, and is closed as not planned, and its
  link is never followed;
- checks a contributor's post and its file, copies the file into the **`music`** release as
  `<id>-v<version>-<start of its checksum>.<mp3|ogg>`, and writes the list the game reads,
  `music.json`, with `MUSIC.md` for people, to the **`music-index`** branch. Don't edit that branch
  or that release by hand.

There is no approval step: a contributor's track that passes the checks is on the list at once.
**Giving someone access to this repository therefore also lets them post music**, and they are
trusted to post only what the hub may share. To take a track down, close its post as not planned
(anyone with triage access can). A track stays on the list if its author later stops being a
contributor; only that post's later edits are no longer read.

If a contributor's post is turned away, look at what GitHub reports for them: a member whose
membership of the organisation is private may be reported as not being one.

`npm run sync:music:dry-run` (or `node scripts/sync-music.mjs --dry-run`) reads the real music
posts, downloads and checks their files, and prints what a run would do, changing nothing.

## Posting a composer's whole library (maintainers)

`scripts/import-scott-buckley.mjs` posts Scott Buckley's library
([www.scottbuckley.com.au/library](https://www.scottbuckley.com.au/library/)) on the music list, a
track a post, the way a contributor would by hand. Every track there is released under CC BY 4.0,
and each of its pages says so and gives its credit line: the tool takes a track only if its page
says it, and uses the page's own credit.

Run it from your own machine, signed in to the `gh` CLI as one of the hub's contributors:

```bash
node scripts/import-scott-buckley.mjs                 # what it would post; changes nothing
node scripts/import-scott-buckley.mjs --go --limit 5  # post the first five not on the hub yet
node scripts/import-scott-buckley.mjs --go            # post all of them
node scripts/import-scott-buckley.mjs --clean-inbox   # delete inbox files of tracks now listed
```

It reads the composer's own posts list, downloads each MP3 from his site once (one at a time, with
a pause, under a name that says who is asking), puts it in the `music-inbox` release so the
workflow fetches it from GitHub, and opens the music post. Tracks already on the hub, or with a
post already made, are skipped, so a run that stopped can be run again. The workflow then checks
and lists each post like any other.

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
