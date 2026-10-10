// DETAILED-MAPS.md on the detailed-maps-index branch: the list of detailed
// maps for people to read, with each map's credits and licence. Written from
// the list and the posts' own words on every change; the README links to it.

import { latestVersion, liveVersions } from "./maps.mjs";
import { megabytes } from "./pmtiles.mjs";

const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

// A post's credits, shown quoted: its own words and links, no HTML, not too long.
const quoted = (text) => {
  const clean = String(text ?? "").replace(/\r\n/g, "\n").replace(/<[^>]*>/g, "").trim().slice(0, 3000);
  return clean ? clean.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n") : "> _No credits given._";
};

export const buildPage = (list, state, { repo }) => {
  const postUrl = (number) => `https://github.com/${repo}/issues/${number}`;
  const shown = list.basemaps.filter((map) => !map.deleted);
  const removed = list.basemaps.filter((map) => map.deleted);
  const lines = [
    "# Detailed maps",
    "",
    "Large, sharp terrain maps that scenarios are drawn on. In the game: **Maps → Community → Detailed maps**. A scenario that uses one also has its own basemap, for players who don't download it.",
    "",
    `To share one, make a [detailed map post](https://github.com/${repo}/issues/new?template=detailed-map.yml). This page is written by the **Detailed maps** workflow; don't edit it by hand.`,
    "",
  ];
  if (!shown.length) {
    lines.push("_No detailed maps yet._", "");
  } else {
    lines.push("| Map | ID | Status | Latest | Size | By | Licence |", "|---|---|---|---|---|---|---|");
    for (const map of shown) {
      const live = liveVersions(map).filter((entry) => !entry.archived);
      const latest = live.at(-1) ?? latestVersion(map);
      const status = map.archived || !live.length ? "Archived" : "Available";
      const name = map.post ? `[${cell(map.name)}](${postUrl(map.post)})` : cell(map.name);
      const by = (map.owners ?? []).map((login) => `@${cell(login)}`).join(", ") || "—";
      lines.push(`| ${name} | \`${cell(map.id)}\` | ${status} | v${latest?.version ?? "—"} | ${latest ? `${megabytes(latest.bytes)} MB` : "—"} | ${by} | ${cell(map.license) || "—"} |`);
    }
    lines.push("", "## Credits and licences", "");
    for (const map of shown) {
      const post = map.post ? state.posts?.[map.post] : null;
      lines.push(`### ${cell(map.name)} (\`${cell(map.id)}\`)`, "", `**Licence:** ${cell(map.license) || "—"}`, "", quoted(post?.credits), "");
      if (map.post) lines.push(`[The map's post](${postUrl(map.post)})`, "");
    }
  }
  if (removed.length) {
    lines.push("## Removed maps", "", "These IDs are never used again, so scenarios that name them are told the map was removed.", "");
    for (const map of removed) lines.push(`- \`${cell(map.id)}\` (${cell(map.name)}), removed ${cell(map.deleted.date)}`);
    lines.push("");
  }
  return lines.join("\n");
};
