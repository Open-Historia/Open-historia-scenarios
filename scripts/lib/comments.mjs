// Everything the workflow says on GitHub: the comment on a post whose file has
// a problem, the notice that a suggestion was removed, and the result of a
// test post.
//
// The first two are read by players, who posted a scenario or suggested a
// change from inside the game and may never have used GitHub for anything
// else: they say what is wrong with the file and what to do about it. The
// third is read by a maintainer who attached a file to see what the checks do
// with it.
//
// None of them may carry the address of a .zip attachment. The game reads a
// comment with one as a suggestion on the post, whoever wrote it. A file is
// named by its name; a link to a checked copy in a release is fine, because
// that is not an attachment's address.

import { TEST_LABEL, TEST_RELEASE, fileNameOf, withoutZipAttachments } from "./posts.mjs";
import { quoted } from "./util.mjs";

export const COMMENT_MARKER = "<!-- hub-files -->";
export const NOTICE_MARKER = "<!-- hub-suggestion -->";
export const TEST_MARKER = "<!-- hub-test -->";

const WHAT = { scenario: "scenario file", flag: "flag", basemap: "basemap" };

export const NO_FILE = {
  scenario: "No scenario file is attached to this post, so nobody can import it. Edit the post and drag your exported `.json` or `.zip` into the Description box.",
  flag: "No flag image is attached to this post. Edit the post and drag your image into the Flag image box.",
  basemap: "No basemap is attached to this post. Edit the post and drag your image (or the `.zip` the editor gave you) into the Basemap image box.",
};

// A post whose text is written so that looking for its file takes minutes
// (posts.mjs, slowToRead).
export const SLOW_TEXT = "This post's text can't be searched for its file: it repeats the start of a link so many times that looking through it would take minutes, here and in the game. Edit the post: keep your description and the attached file, and take the repeated links out.";

// How a file is named in a sentence: by its name when it has one, never by
// its address. An image dragged into a post has an id and no name.
export const spoken = (source, { kind = "", primary = true, ordinal = 0 } = {}) => {
  const name = fileNameOf(source);
  if (/\.[A-Za-z0-9]{1,8}$/.test(name)) return quoted(name, 80);
  const picture = /\/user-attachments\/assets\/|user-images\.githubusercontent\.com/i.test(String(source)) || (primary && kind === "flag");
  return `The attached ${picture ? "image" : "file"}${ordinal ? ` ${ordinal}` : ""}`;
};

// On a post whose file cannot be released. `released`: the post has a version
// on the hub already, which stays there.
export const problemComment = (kind, problems, { released = false } = {}) => withoutZipAttachments([
  COMMENT_MARKER,
  released
    ? `### ⚠️ The new version of this post's ${WHAT[kind]} could not be added to the hub`
    : `### ⚠️ This post's ${WHAT[kind]} could not be added to the hub`,
  "",
  ...problems.map((problem) => `- ${problem.text}`),
  "",
  problems.every((problem) => problem.transient)
    ? "Nothing needs changing in the post: this is tried again automatically, and this comment goes away once it works."
    : "Edit this post (⋯ → Edit) to fix it. It is checked again on every edit, and this comment goes away once the file is in.",
  ...(released ? ["", "Until then the hub keeps the version of this post that was released before."] : []),
].join("\n"));

// On a scenario post, once for each person whose suggestion was removed.
export const suggestionNotice = (login, problems) => withoutZipAttachments([
  NOTICE_MARKER,
  `### ⚠️ Suggested changes from @${login} were removed`,
  "",
  `@${login}, the changes you suggested here were removed automatically, because the game could not have used their file:`,
  "",
  ...problems.map((problem) => `- ${problem}`),
  "",
  "Nothing is wrong with the scenario itself. You can suggest your changes again from the game (**Suggest changes** on your copy of the scenario), and post the new file in a new comment.",
].join("\n"));

// On a test post: what the checks did with each of its files.
//   files: [{ label, primary, outcome, repairs, problems, url }]
//   outcome: "as is" | "repaired" | "refused" | "left alone" | "waiting"
export const testComment = ({ kind, files = [], note = "" }) => {
  const lines = [TEST_MARKER, "### 🧪 Security test: what the checks did with this issue's files", ""];
  if (note) return withoutZipAttachments([...lines, note].join("\n"));
  lines.push(
    `Checked as a **${kind}** post. Nothing here is on the hub: the checked copies are in the \`${TEST_RELEASE}\` release only, no game lists this issue, and the copies are deleted when it is closed.`,
    "",
  );
  for (const file of files) {
    const name = `**${file.label.replace(/^The /, "the ")}**${file.primary ? " (the post's file)" : ""}`;
    const copy = file.url ? ` [Checked copy](${file.url})` : "";
    if (file.outcome === "as is") lines.push(`- ${name}: released as it was.${copy}`);
    else if (file.outcome === "repaired") lines.push(`- ${name}: repaired.${copy}`, ...file.repairs.map((repair) => `  - ${repair}`));
    else if (file.outcome === "refused") lines.push(`- ${name}: refused.`, ...file.problems.map((problem) => `  - ${problem}`));
    else if (file.outcome === "waiting") lines.push(`- ${name}: not checked yet.`, ...file.problems.map((problem) => `  - ${problem}`));
    else lines.push(`- ${name}: left alone (neither a picture nor a data file, so the hub copies nothing of it).`);
  }
  return withoutZipAttachments(lines.join("\n"));
};

export const TEST_NOTES = {
  noKind: `This issue is labelled \`${TEST_LABEL}\`, but its title does not start with \`[Scenario]\`, \`[Flag]\` or \`[Basemap]\`, so the checks cannot tell what to check its files as. Edit the title and they run.`,
  real: (kind) => `This issue carries the \`${kind}\` label as well as \`${TEST_LABEL}\`, so it is a real post: games list it, and its file was handled like any other post's. Remove the \`${kind}\` label to test without publishing anything.`,
};
