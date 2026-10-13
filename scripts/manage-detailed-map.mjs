// Archives, restores or deletes a detailed map (or one version of it), for the
// "Archive or restore a detailed map" and "Delete a detailed map" workflows.
//
//   GITHUB_TOKEN=... node scripts/manage-detailed-map.mjs archive|restore|delete
//     --id got-world [--version 2] [--reason "why"] [--by <login>]
//
// Archived: kept in the list and never offered for download; its file moves
// to a draft release nobody can download from. Players who have it keep using
// it. Restored: offered again, its file back in a public release.
// Deleted: its files are deleted and the list keeps a tombstone, so its ID and
// version numbers are never used again. A deletion can't be undone.
// The map's post gets a comment saying what was done, and why.

import os from "node:os";
import path from "node:path";
import { createClient } from "./detailed-maps/github.mjs";
import { ID_PATTERN } from "./detailed-maps/maps.mjs";
import { changeMap, openStore, todayText } from "./detailed-maps/sync.mjs";

const fail = (message) => {
  console.error(`::error::${message}`);
  process.exit(1);
};

const [action, ...args] = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? String(args[at + 1] ?? "").trim() : "";
};
if (!["archive", "restore", "delete"].includes(action)) fail("Say archive, restore or delete.");
const id = option("id");
const versionText = option("version");
const reason = option("reason").replace(/\s+/g, " ").slice(0, 300);
const by = option("by");
if (!ID_PATTERN.test(id)) fail(`"${id}" is not a map ID.`);
if (versionText && !/^[1-9][0-9]{0,5}$/.test(versionText)) fail(`"${versionText}" is not a version number. Leave it empty for the whole map.`);
if (action !== "restore" && !reason) fail(`Give a reason for ${action === "archive" ? "archiving" : "deleting"} it.`);
const version = versionText ? Number(versionText) : null;

const repo = process.env.GITHUB_REPOSITORY || "Open-Historia/Open-historia-scenarios";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
if (!token) fail("GITHUB_TOKEN is not set.");
const client = createClient({ repo, token });
const workDir = path.join(process.env.RUNNER_TEMP || os.tmpdir(), "detailed-maps");
const store = await openStore({ client, workDir });

let result;
try {
  result = await changeMap({ store, action, id, version, reason, today: todayText() });
} catch (error) {
  fail(error.message);
}
const what = `${id}${version == null ? "" : ` version ${version}`}`;
await store.save(`${action[0].toUpperCase()}${action.slice(1)} ${what}`);

const who = by ? ` by @${by}` : "";
const comment = {
  archive: `📦 **Archived**${who}: ${what} is no longer offered for download. Players who already have it keep using it. Reason: ${reason}`,
  restore: `♻️ **Restored**${who}: ${what} is offered for download again.`,
  delete: `🗑️ **Deleted**${who}: ${what} was removed for good. Players who already have it keep their copy; nobody else can download it. Reason: ${reason}`,
}[action];
if (result.map.post) await client.createComment(result.map.post, comment);
console.log(`${action}: ${what} (versions ${result.versions.join(", ")})`);
