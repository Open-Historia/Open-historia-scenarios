# Open Historia — Community Hub

Community content for [Open Historia](https://github.com/Open-Historia/open-historia).
Every **issue** on this repo is a post the game reads directly, so the in-game **Community**
tabs show what's posted here for everyone:

- Issues labeled **`scenario`** → the **Community** tab (playable scenarios).
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

## Install counts

The official preset bundles live as assets on the
[**`bundles` release**](https://github.com/Open-Historia/Open-historia-scenarios/releases/tag/bundles);
GitHub counts every download of those files, and the in-game **⬇ Most Installed** row shows
that count. (The `bundles/` folder in this repo is a mirror for older game versions and is
not counted.) Note: replacing a release asset resets its counter — install numbers count
since the bundle's last update.

## Import

In-game: **Community tab → Import** on a scenario card, or **Basemaps → Community → Install** on a
basemap card. (Manually: download the attached file and use **Scenarios → Import JSON**.)

## Maintainer setup

The `basemap.yml` form applies a **`basemap`** label to every basemap post. A form can only apply a
label that already exists, so this repo must have a label named exactly **`basemap`**
(Issues → Labels → New label). Without it, basemap posts submit unlabeled and the in-game Basemaps
browser (which queries `labels=basemap`) stays empty. The `scenario` label works the same way.

---

Scenarios and basemaps are player-made content. The hub is moderated; broken or abusive posts are closed.
