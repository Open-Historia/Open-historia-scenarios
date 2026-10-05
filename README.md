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
3. **Drag your flag image into the "Flag image" box** — `.png`, `.jpg`, `.webp`, `.gif` or `.svg`.
   That image is both the flag and its preview, so there's nothing else to upload. Roughly 3:2 looks
   best; large images are scaled down to 256px when someone applies one.
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
([**Copy post files to releases**](.github/workflows/copy-post-files.yml)) then copies every file
attached to a scenario, flag or basemap post into this repository's
[releases](https://github.com/Open-Historia/Open-historia-scenarios/releases) (`scenarios-1`,
`flags-1`, `basemaps-1`, and a `-2` once one is full), and the game downloads it from there.
It runs when a post is opened, edited, closed or reopened, and every half hour.

- **Editing your post** with a new file replaces the copy. **Closing** a post deletes its copies.
- **If your file can't be copied** (nothing attached, not a scenario file, over 200 MB, or GitHub
  no longer has the attachment), the workflow says why in a comment on your post and adds the
  `file problem` label. Edit the post to fix it: it is checked again on every edit, and the
  comment and the label go away once the file is in.
- **Comments are never copied.** A suggestion on a scenario is a comment with a `.zip`, and it
  stays where its author put it.
- Until a new post's file has been copied (a minute or so), the game downloads it straight from
  the post, so a post is playable the moment it is submitted.

The game finds the copies through [`index.json`](https://github.com/Open-Historia/Open-historia-scenarios/blob/hub-index/index.json)
on the `hub-index` branch, which the workflow rewrites. Do not edit that branch, or upload,
rename or delete files in those releases, by hand.

## Install counts

A scenario's install count is **how many times its file has been downloaded from the release**,
as GitHub counts it. The workflow adds the counts up every half hour and writes them into
`index.json`, and the in-game **⬇ Most Installed** row shows them. A new version of a scenario
keeps the count of the versions before it.

Counting used to be done by a counter of the game's own. What it had counted for each post on
5 October 2026 is kept in [`data/legacy-import-counts.json`](data/legacy-import-counts.json) and
added in, so no post's number started again from nothing.

The official preset bundles live on the older
[**`bundles` release**](https://github.com/Open-Historia/Open-historia-scenarios/releases/tag/bundles);
they are counted the same way and are not copied again. (The `bundles/` folder in this repo is a
mirror for older game versions and is not counted.)

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

---

Scenarios and basemaps are player-made content. The hub is moderated; broken or abusive posts are closed.
