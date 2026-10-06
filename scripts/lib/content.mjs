// What is inside a post's file: a scenario, a basemap's data file, a
// suggestion. Each is read the way the game reads it, and has to be something
// the game could use.
//
// The shapes here are the game's own (its importers in server/libraryStore.js
// and src/runtime/web/libraryStore.js, bundleFiles.js, communityBasemaps.js,
// scenarioSuggestion.js):
//
//   a scenario   { schema, version, mode, exportedAt, scenario, data, assets },
//                as one .json, or as a .zip holding it as scenario.json beside
//                its basemap (basemap.png, basemap.geojson), a preview, and its
//                heavy assets as entries of their own, which scenario.json
//                points at ({ mode: "file", file: "assets/regions.geojson" });
//   a basemap    a .zip holding basemap.geojson or a picture; or the old JSON
//                { basemap, payload: { dataUrl | geojson } }; or bare GeoJSON;
//   a suggestion a .zip holding suggestion.json and the files it names.
//
// A scenario or a basemap that passes is released as checked: a .zip is
// written again from its checked entries (zip.mjs), a .json only when
// something in it was put right. A suggestion is only judged: it stays its
// author's attachment, so in one, what would be put right elsewhere is a
// reason to refuse it.

import { featureCollectionProblem, looksLikeFeatureCollection, pmtilesProblem } from "./geodata.mjs";
import { IMAGE_MIME } from "./images.mjs";
import { base64Bytes, checkPicture, isDataAddress } from "./pictures.mjs";
import { Findings, Slots, checkDocument } from "./rules.mjs";
import { MIB, Problem, count, isRecord, quoted, sizeText, utf8OrNull } from "./util.mjs";
import { packEntry, readZip, writeZip } from "./zip.mjs";

// ---- JSON ---------------------------------------------------------------------

// The game holds a document in one string, and a string has a limit; well
// under it, so that reading one here cannot take the run down either.
export const MAX_JSON_BYTES = 256 * MIB;

// A .json file is decoded as the game decodes one (a byte order mark dropped);
// JSON inside a .zip or inside another document is not, because there the game
// does not drop one either, and fails on it.
const fileDecoder = new TextDecoder("utf-8");
const parseJson = (bytes, { file = false } = {}) => {
  if (bytes.length > MAX_JSON_BYTES) throw new Problem(`it is ${sizeText(bytes.length)} of JSON, and the game could not read more than ${sizeText(MAX_JSON_BYTES)}`);
  try {
    return JSON.parse(file ? fileDecoder.decode(bytes) : bytes.toString("utf8"));
  } catch (error) {
    const at = /position (\d+)/.exec(String(error?.message))?.[1];
    throw new Problem(`it is not valid JSON${at ? ` (it goes wrong at character ${count(Number(at) + 1)})` : ""}`);
  }
};
const toJsonBytes = (value) => Buffer.from(JSON.stringify(value), "utf8");

// Runs `work`; a Problem it throws becomes a sentence about `label`, and FAILED
// comes back (not null: a JSON file may hold null, and that is not a failure
// to read it).
const FAILED = Symbol("failed");
const attempt = async (findings, label, work) => {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof Problem)) throw error;
    findings.problem(`${label} can't be used: ${error.message}`);
    return FAILED;
  }
};

// ---- a .zip being checked -----------------------------------------------------

const extensionOf = (name) => /\.([A-Za-z0-9]+)$/.exec(name)?.[1].toLowerCase() ?? "";
const JSON_NAMES = new Set(["json", "geojson"]);
const PICTURE_NAMES = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg", "bin"]);
const TEXT_NAMES = new Set(["txt", "md"]);
const usable = (name) => JSON_NAMES.has(extensionOf(name)) || PICTURE_NAMES.has(extensionOf(name)) || TEXT_NAMES.has(extensionOf(name)) || extensionOf(name) === "pmtiles";
const NOT_USED = "is not something the game uses: a .zip for the hub holds JSON, pictures, map tiles and plain text, and nothing else";

// Where the game looks for a zipped scenario's basemap (hubPosts.js), at any depth.
const BASEMAP_PICTURE = /(^|\/)basemap\.(?:png|jpe?g|webp|gif|svg)$/i;
const BASEMAP_MAP = /(^|\/)basemap\.geojson$/i;
const COVER_PICTURE = /(^|\/)cover\.[a-z]+$/i;

// The files of a zip (folders left out), each to be given its checked content
// once, and the new zip written from them in their old order.
class Archive {
  #files;
  #byName;
  #findings;
  #rebuild;

  constructor(entries, findings, { rebuild = true } = {}) {
    this.#files = entries.filter((entry) => !entry.directory).map((entry) => ({ entry, name: entry.name, as: entry.name, packed: null, taken: false }));
    this.#byName = new Map(this.#files.map((file) => [file.name, file]));
    this.#findings = findings;
    this.#rebuild = rebuild;
  }

  get names() {
    return this.#files.map((file) => file.name);
  }

  has(name) {
    return this.#byName.has(name);
  }

  // The entries nothing has read yet.
  get untouched() {
    return this.#files.filter((file) => !file.taken).map((file) => file.name);
  }

  // An entry's bytes: unpacked now, its checksum proved (zip.mjs).
  read(name) {
    const file = this.#byName.get(name);
    file.taken = true;
    return file.entry.read();
  }

  // What the entry holds in the zip that is released. `store` for what is
  // compressed already; `as` to give it another name.
  keep(name, bytes, { store = false, as = name } = {}) {
    const file = this.#byName.get(name);
    if (as !== name) {
      const key = as.normalize("NFC").toLowerCase();
      if (this.#files.some((other) => other !== file && (other.name.normalize("NFC").toLowerCase() === key || other.as.normalize("NFC").toLowerCase() === key))) {
        throw new Problem(`it holds ${quoted(name)}, which would become ${quoted(as)}, and it has an entry by that name already`);
      }
      file.as = as;
      this.#findings.renamed.push([name, as]);
    }
    // Packed at once, so what it was packed from can be let go; not at all for
    // a zip that is not going to be written again.
    if (this.#rebuild && !this.#findings.failed) file.packed = packEntry(as, bytes, { store });
  }

  build() {
    // Every entry has been looked at, or this is not a zip to release.
    const missed = this.#files.find((file) => !file.packed);
    if (missed) throw new Error(`the entry ${missed.name} was not checked`);
    return writeZip(this.#files.map((file) => file.packed));
  }
}

const openZip = (bytes, findings, label, options) => {
  try {
    return new Archive(readZip(bytes), findings, options);
  } catch (error) {
    if (!(error instanceof Problem)) throw error;
    findings.problem(`${label} can't be used: ${error.message}`);
    return null;
  }
};

// The name a picture entry is released under. An entry called ".svg" is no
// longer one once it is drawn (and the game reads a basemap's kind off its
// name, so a PNG left under ".svg" would not show). Any other name is kept,
// even over another kind of picture: the game itself writes a cover of any
// kind as "cover.jpg", and shows a picture whatever its name says.
// (".bin" for an AVIF, which is a picture only as a cover, and has no name of
// its own among the names a zip for the hub may hold.)
const pictureName = (name, type) => (extensionOf(name) === "svg" ? `${name.slice(0, -3)}${type === "avif" ? "bin" : type}` : name);

// A picture entry, checked for its use. Returns the checked picture, or null
// when it has a problem.
const keepPicture = async (archive, name, bytes, use, { findings, ctx }) => {
  const checked = await attempt(findings, quoted(name), () => checkPicture(bytes, use, ctx));
  if (checked === FAILED) return null;
  for (const change of checked.changes) findings.repaired(change.kind === "svg" ? `svg:${use}` : change.kind);
  // In a suggestion nothing is renamed: nothing in one is put right.
  const as = ctx.repair === false ? name : pictureName(name, checked.type);
  archive.keep(name, checked.bytes, { store: true, as });
  return { ...checked, name: as };
};

// An entry nothing points at: it has to be one of the things a zip for the hub
// may hold, by its name and by its bytes.
const checkLooseEntry = async (archive, name, { findings, ctx, drawn, use = null, isMap = false }) => {
  const label = quoted(name);
  const extension = extensionOf(name);
  if (!usable(name)) {
    findings.problem(`${label} ${NOT_USED}`);
    return;
  }
  const bytes = archive.read(name);
  if (JSON_NAMES.has(extension)) {
    const json = await attempt(findings, label, () => parseJson(bytes));
    if (json === FAILED) return;
    if (isMap || BASEMAP_MAP.test(name)) {
      const wrong = featureCollectionProblem(json);
      if (wrong) findings.problem(`${label} is not a map the game can draw: ${wrong}`);
    }
    const changed = await checkDocument(json, { label, findings, ctx, drawn });
    archive.keep(name, changed ? toJsonBytes(json) : bytes);
  } else if (PICTURE_NAMES.has(extension)) {
    await keepPicture(archive, name, bytes, use ?? (BASEMAP_PICTURE.test(name) ? "basemap" : COVER_PICTURE.test(name) ? "cover" : "picture"), { findings, ctx });
  } else if (extension === "pmtiles") {
    const wrong = pmtilesProblem(bytes);
    if (wrong) findings.problem(`${label} can't be used: ${wrong}`);
    else archive.keep(name, bytes, { store: true });
  } else {
    const text = utf8OrNull(bytes);
    if (text === null || /[\x00-\x08\x0b\x0e-\x1f]/.test(text)) findings.problem(`${label} is not plain text, as its name says it is`);
    else archive.keep(name, bytes);
  }
};

// ---- a basemap's payload ------------------------------------------------------

// A basemap as background.json holds it: { dataUrl } for a picture, { geojson }
// for a map. `kind` is which of the two the file says it is, when it says.
const checkBasemapPayload = (payload, { label, findings, slots, kind = null }) => {
  if (!isRecord(payload)) {
    findings.problem(`${label} is not a basemap: it holds neither a picture nor a map`);
    return;
  }
  const hasPicture = payload.dataUrl !== undefined && payload.dataUrl !== null && payload.dataUrl !== "";
  const hasMap = payload.geojson !== undefined && payload.geojson !== null;
  if ((!hasPicture && !hasMap) || (kind === "image" && !hasPicture) || (kind === "vector" && !hasMap)) {
    findings.problem(`${label} is a basemap with nothing in it: ${kind === "image" ? "it has no picture" : kind === "vector" ? "it has no map" : "it holds neither a picture nor a map"}`);
  }
  if (hasPicture) {
    // Anything but a picture carried in the file would be loaded by the game
    // from wherever it points.
    if (typeof payload.dataUrl !== "string" || !isDataAddress(payload.dataUrl)) findings.problem(`${label} names its basemap by an address, where the picture itself has to be carried in the file`);
    else slots.fields.set(payload, { ...slots.fields.get(payload), dataUrl: "basemap" });
  }
  if (hasMap) {
    const wrong = featureCollectionProblem(payload.geojson);
    if (wrong) findings.problem(`the basemap in ${label} is not a map the game can draw: ${wrong}`);
  }
};

// ---- a scenario ---------------------------------------------------------------

// Read by pattern, as the game reads it: files written before the project took
// its present name carry the earlier one, and both are scenarios.
const SCENARIO_SCHEMA = /^[a-z][a-z0-9-]*-scenario-bundle(?:\/2)?$/;

// What each asset of a scenario is. The rest of `assets` the game ignores.
const FILE_ASSETS = { cover: "cover", cities: "tiles", countries: "tiles", regions: "tiles" };
const LIST_ASSETS = new Set(["colors", "flags", "institutionLogos", "tags", "stats"]);
const MAP_ASSETS = new Set(["regionsGeojson", "citiesGeojson", "backgroundData"]);
const EMBLEM_FIELDS = { logoUrl: "emblem", logo: "emblem", emblemUrl: "emblem", emblem: "emblem" };

// The addresses a scenario may share a community basemap by, when the caller
// does not know the hub's posts: something GitHub stores.
const GITHUB_FILE = /^https:\/\/(?:github\.com|(?:[a-z0-9-]+\.)*githubusercontent\.com)\//i;

// Checks one scenario document. `archive` is its zip, when it came in one.
// Returns whether the document itself was changed.
const checkScenario = async (bundle, { label, findings, ctx, drawn, archive }) => {
  if (!isRecord(bundle)) {
    findings.problem(`${label} is not a scenario: it holds ${Array.isArray(bundle) ? "a list" : "a single value"} where a scenario's parts should be`);
    return false;
  }
  if (typeof bundle.schema !== "string" || !SCENARIO_SCHEMA.test(bundle.schema)) {
    findings.problem(bundle.schema === undefined
      ? `${label} is not a scenario the game can import: it does not say what it is (it has no \`schema\`)`
      : `${label} is not a scenario the game can import: its \`schema\` is ${quoted(typeof bundle.schema === "string" ? bundle.schema : JSON.stringify(bundle.schema))}, which is not a scenario's`);
    return false;
  }
  const part = (holder, key, path) => {
    const value = holder?.[key];
    if (value === undefined || value === null) return null;
    if (isRecord(value)) return value;
    findings.problem(`${label} is damaged: its ${quoted(path)} is not what the game writes there`);
    return null;
  };
  const scenario = part(bundle, "scenario", "scenario");
  const data = part(bundle, "data", "data");
  const assets = part(bundle, "assets", "assets");
  if (!scenario && !data && !assets) {
    if (!findings.failed) findings.problem(`${label} is not a scenario: it has none of \`scenario\`, \`data\` and \`assets\``);
    return false;
  }
  const world = part(data, "world", "data.world");
  part(data, "game", "data.game");
  part(data, "prompts", "data.prompts");

  let changed = false;
  const slots = new Slots();
  // A file must not carry its own link to a post: the game writes that link
  // itself, when it downloads the post's file.
  if (Object.hasOwn(bundle, "hubOrigin")) {
    delete bundle.hubOrigin;
    findings.repaired("hubOrigin");
    changed = true;
  }

  if (world) {
    for (const record of Object.values(isRecord(world.polityOverrides) ? world.polityOverrides : {})) {
      if (isRecord(record)) slots.fields.set(record, { flag: "flag" });
    }
    const institutions = isRecord(world.institutions?.byId) ? world.institutions.byId : world.institutions;
    for (const record of Object.values(institutions && typeof institutions === "object" ? institutions : {})) {
      if (isRecord(record)) slots.fields.set(record, EMBLEM_FIELDS);
    }
  }

  const claimed = new Set();
  const checkFile = async (key, bytes, named) => {
    if (key !== "cover") {
      const wrong = pmtilesProblem(bytes);
      if (wrong) findings.problem(`${named} can't be used: ${wrong}`);
      return wrong ? null : { bytes };
    }
    const checked = await attempt(findings, named, () => checkPicture(bytes, "cover", ctx));
    if (checked === FAILED) return null;
    for (const change of checked.changes) findings.repaired(change.kind === "svg" ? "svg:cover" : change.kind);
    return checked;
  };
  // The game refuses a cover whose type it does not know, and with it the whole
  // scenario: the type is made to say what the picture is.
  const coverSays = (descriptor, type) => {
    if (String(descriptor.contentType ?? "").split(";")[0].trim().toLowerCase() === IMAGE_MIME[type]) return;
    descriptor.contentType = IMAGE_MIME[type];
    findings.repaired("coverType");
    changed = true;
  };
  const checkMap = (key, json, named) => {
    if (key === "backgroundData") return checkBasemapPayload(json, { label: named, findings, slots });
    const wrong = featureCollectionProblem(json);
    if (wrong) findings.problem(`${named} is not a map the game can draw: ${wrong}`);
    return undefined;
  };

  for (const [key, descriptor] of Object.entries(assets ?? {})) {
    const known = Object.hasOwn(FILE_ASSETS, key) || LIST_ASSETS.has(key) || MAP_ASSETS.has(key);
    if (!known || !isRecord(descriptor)) continue;
    const named = `the ${quoted(key)} asset of ${label}`;
    const { mode } = descriptor;

    if (mode === undefined || mode === null) {
      // A bare list of flags, with no mode: what a hand-built file has, and the
      // game's flag browser reads it as one.
      if (key === "flags") slots.whole.set(descriptor, "flag");
    } else if (mode === "default") {
      // The game's own: nothing travels.
    } else if (mode === "communityRef" && key === "backgroundData") {
      // A basemap shared by its post instead of carried: the game downloads it
      // on import, so it has to be a file of this hub, which is checked there.
      const ours = typeof descriptor.url === "string" && (ctx.isHubAddress ? ctx.isHubAddress(descriptor.url.trim()) : GITHUB_FILE.test(descriptor.url.trim()));
      if (!ours) findings.problem(`${named} points at a basemap that is not a file of this hub: a scenario can only share a basemap that is posted here`);
      if (descriptor.via !== undefined && descriptor.via !== "image" && descriptor.via !== "dataFile") findings.problem(`${named} does not say how its shared basemap is read`);
      slots.fields.set(descriptor, { url: "payload" });
    } else if (mode === "embedded") {
      const payload = descriptor.data;
      slots.fields.set(descriptor, { data: "payload" });
      if (payload === undefined || payload === null) continue; // nothing in it: the game uses its own
      // A tile archive with nothing in it is what the game's own exporter
      // writes for a world that has none of its own (one drawn by hand, on its
      // own regions): nothing to check, and nothing to refuse.
      if (payload === "" && FILE_ASSETS[key] === "tiles") continue;
      if (Object.hasOwn(FILE_ASSETS, key)) {
        const bytes = typeof payload === "string" ? base64Bytes(payload) : null;
        if (!bytes) {
          findings.problem(`${named} is not base64, as a file carried inside a scenario has to be`);
          continue;
        }
        const checked = await checkFile(key, bytes, named);
        if (!checked) continue;
        if (checked.bytes !== bytes) {
          descriptor.data = checked.bytes.toString("base64");
          descriptor.encoding = "base64";
          changed = true;
        }
        if (key === "cover") coverSays(descriptor, checked.type);
      } else if (LIST_ASSETS.has(key)) {
        if (!isRecord(payload)) {
          findings.problem(`${named} is ${typeof payload === "string" ? "text" : "a list"} where the game expects named entries, so the game could not use it`);
          continue;
        }
        if (key === "flags") slots.whole.set(payload, "flag");
        if (key === "institutionLogos") slots.whole.set(payload, "logo");
      } else if (typeof payload === "string") {
        // A map that travels as base64: how files written before maps travelled
        // as JSON carry theirs.
        const bytes = base64Bytes(payload);
        if (!bytes) {
          findings.problem(`${named} is not base64, as a file carried inside a scenario has to be`);
          continue;
        }
        const json = await attempt(findings, named, () => parseJson(bytes));
        if (json === FAILED) continue;
        checkMap(key, json, named);
        if (await checkDocument(json, { label: named, findings, slots, ctx, drawn })) {
          descriptor.data = toJsonBytes(json).toString("base64");
          descriptor.encoding = "base64";
          changed = true;
        }
      } else {
        checkMap(key, payload, named);
      }
    } else if (mode === "file") {
      const { file, format } = descriptor;
      slots.fields.set(descriptor, { file: "payload" });
      if (!archive) {
        findings.problem(`${named} points at a file (${quoted(file)}), which only a .zip can carry: the game would import the scenario without it`);
        continue;
      }
      if (typeof file !== "string" || !archive.has(file) || file === "scenario.json") {
        findings.problem(`${named} points at ${quoted(file)}, which is not in the zip: the game would import the scenario without it`);
        continue;
      }
      const entry = quoted(file);
      if (claimed.has(file)) {
        findings.problem(`${label} points at ${entry} from two of its assets`);
        continue;
      }
      claimed.add(file);
      if (!usable(file)) {
        findings.problem(`${entry} ${NOT_USED}`);
        continue;
      }
      // As the game puts an entry back (bundleFiles.js): "base64" is the
      // entry's bytes, "text" an entry that holds base64, anything else JSON.
      const bytes = archive.read(file);
      const inText = format === "text";
      const fileBytes = inText ? base64Bytes(bytes.toString("latin1")) : bytes;
      if (!fileBytes) {
        findings.problem(`${entry} is not base64, as ${label} says it is`);
        continue;
      }
      if (Object.hasOwn(FILE_ASSETS, key)) {
        if (format !== "base64" && !inText) {
          findings.problem(`${named} points at ${entry} as JSON, and it has to be a file`);
          continue;
        }
        const checked = await checkFile(key, fileBytes, entry);
        if (!checked) continue;
        const as = key === "cover" ? pictureName(file, checked.type) : file;
        archive.keep(file, inText ? Buffer.from(checked.bytes.toString("base64")) : checked.bytes, { store: !inText, as });
        if (as !== file) {
          descriptor.file = as;
          changed = true;
        }
        if (key === "cover") coverSays(descriptor, checked.type);
      } else {
        if (LIST_ASSETS.has(key) && (format === "base64" || inText)) {
          findings.problem(`${named} points at ${entry} as a file, where the game expects JSON, so the game could not use it`);
          continue;
        }
        const json = await attempt(findings, entry, () => parseJson(fileBytes));
        if (json === FAILED) continue;
        if (LIST_ASSETS.has(key)) {
          if (!isRecord(json)) {
            findings.problem(`${entry} is ${typeof json === "string" ? "text" : "a list"} where the game expects named entries, so the game could not use it`);
            continue;
          }
          if (key === "flags") slots.whole.set(json, "flag");
          if (key === "institutionLogos") slots.whole.set(json, "logo");
        } else {
          checkMap(key, json, entry);
        }
        const rewritten = await checkDocument(json, { label: entry, findings, slots, ctx, drawn });
        const out = rewritten ? toJsonBytes(json) : fileBytes;
        archive.keep(file, inText ? (rewritten ? Buffer.from(out.toString("base64")) : bytes) : out);
      }
    } else if (Object.hasOwn(descriptor, "data") || Object.hasOwn(descriptor, "file")) {
      findings.problem(`${named} is in a form the game does not read (mode ${quoted(mode)}), so the game would import the scenario without it`);
    }
  }

  if (await checkDocument(bundle, { label, findings, slots, ctx, drawn })) changed = true;
  return changed;
};

const result = (type, bytes, findings, changed) => ({ type, bytes, findings, changed });

// A scenario file: `kind` is "zip" or "json", which the caller told by the
// file's first bytes. { type, bytes, findings, changed }: `bytes` are what is
// released when `findings` has no problem.
export const checkScenarioFile = async (bytes, kind, ctx) => {
  const findings = new Findings();
  const drawn = { count: 0, cache: new Map() };
  const { label } = ctx;
  if (kind === "json") {
    const bundle = await attempt(findings, label, () => parseJson(bytes, { file: true }));
    if (bundle === FAILED) return result("json", bytes, findings, false);
    const changed = await checkScenario(bundle, { label, findings, ctx, drawn, archive: null });
    return result("json", changed && !findings.failed ? toJsonBytes(bundle) : bytes, findings, changed);
  }
  const archive = openZip(bytes, findings, label);
  if (!archive) return result("zip", bytes, findings, false);
  if (!archive.has("scenario.json")) {
    findings.problem(`${label} is a .zip with no \`scenario.json\` in it, so it is not a scenario`);
    return result("zip", bytes, findings, false);
  }
  const built = await attempt(findings, label, async () => {
    const raw = archive.read("scenario.json");
    const bundle = await attempt(findings, "`scenario.json`", () => parseJson(raw));
    if (bundle === FAILED) return null;
    const changed = await checkScenario(bundle, { label: "`scenario.json`", findings, ctx, drawn, archive });
    for (const name of archive.untouched) await checkLooseEntry(archive, name, { findings, ctx, drawn });
    archive.keep("scenario.json", changed ? toJsonBytes(bundle) : raw);
    return findings.failed ? null : archive.build();
  });
  return result("zip", Buffer.isBuffer(built) ? built : bytes, findings, true);
};

// A basemap post's data file: a .zip or a .json.
export const checkBasemapFile = async (bytes, kind, ctx) => {
  const findings = new Findings();
  const drawn = { count: 0, cache: new Map() };
  const { label } = ctx;
  if (kind === "json") {
    const json = await attempt(findings, label, () => parseJson(bytes, { file: true }));
    if (json === FAILED) return result("json", bytes, findings, false);
    const slots = new Slots();
    if (isRecord(json) && json.payload) {
      // The old form: { basemap: { name, kind, thumbnail, ... }, payload }.
      checkBasemapPayload(json.payload, { label, findings, slots, kind: json.basemap?.kind === "vector" ? "vector" : "image" });
      if (isRecord(json.basemap)) slots.fields.set(json.basemap, { thumbnail: "picture" });
    } else if (looksLikeFeatureCollection(json)) {
      const wrong = featureCollectionProblem(json);
      if (wrong) findings.problem(`${label} is not a map the game can draw: ${wrong}`);
    } else {
      // The game's own words for it.
      findings.problem(`${label} can't be used: that basemap file is missing its data`);
    }
    const changed = await checkDocument(json, { label, findings, slots, ctx, drawn });
    return result("json", changed && !findings.failed ? toJsonBytes(json) : bytes, findings, changed);
  }
  const archive = openZip(bytes, findings, label);
  if (!archive) return result("zip", bytes, findings, false);
  // As the game looks for it (communityBasemaps.js): basemap.geojson, else any
  // .geojson, else the first picture.
  const map = archive.names.find((name) => BASEMAP_MAP.test(name)) ?? archive.names.find((name) => /\.geojson$/i.test(name));
  const picture = map ? null : archive.names.find((name) => /\.(?:png|jpe?g|webp|gif|svg)$/i.test(name));
  if (!map && !picture) findings.problem(`${label} can't be used: that .zip has no basemap inside it`);
  const built = await attempt(findings, label, async () => {
    for (const name of archive.names) {
      await checkLooseEntry(archive, name, { findings, ctx, drawn, use: name === picture ? "basemap" : null, isMap: name === map });
    }
    return findings.failed ? null : archive.build();
  });
  return result("zip", Buffer.isBuffer(built) ? built : bytes, findings, true);
};

// ---- a suggestion -------------------------------------------------------------

export const SUGGESTION_SCHEMA = "open-historia-scenario-suggestion/1";
const MAX_CHANGES = 20000;

// A suggestion's file: the .zip Suggest changes saves, or (the game reads that
// too) a bare suggestion.json. Only `findings` matters: nothing is released.
export const checkSuggestionFile = async (bytes, kind, ctx) => {
  const findings = new Findings();
  const drawn = { count: 0, cache: new Map() };
  const quiet = { ...ctx, repair: false };
  const { label } = ctx;
  const slots = new Slots();
  const archive = kind === "zip" ? openZip(bytes, findings, label, { rebuild: false }) : null;
  if (kind === "zip" && !archive) return { findings };
  if (archive && !archive.has("suggestion.json")) {
    findings.problem(`${label} holds no suggestion (\`suggestion.json\` is missing)`);
    return { findings };
  }
  const document = archive ? "`suggestion.json`" : label;
  await attempt(findings, label, async () => {
    const suggestion = await attempt(findings, document, () => (archive ? parseJson(archive.read("suggestion.json")) : parseJson(bytes, { file: true })));
    if (suggestion === FAILED) return;
    if (!isRecord(suggestion) || suggestion.schema !== SUGGESTION_SCHEMA) {
      findings.problem(`${document} is not a scenario suggestion the game can read`);
      return;
    }
    if (suggestion.scenario !== undefined && suggestion.scenario !== null && !isRecord(suggestion.scenario)) {
      findings.problem(`${document} is damaged: its \`scenario\` is not what the game writes there`);
    }
    const changes = Array.isArray(suggestion.changes) ? suggestion.changes : null;
    if (!changes) findings.problem(`${document} has no list of changes`);
    else if (changes.length > MAX_CHANGES) findings.problem(`${document} holds ${count(changes.length)} changes, and the game reads ${count(MAX_CHANGES)} at most`);
    const named = new Map(); // entry -> what the change that names it says it is
    for (const [index, change] of (changes ?? []).slice(0, MAX_CHANGES).entries()) {
      if (!isRecord(change) || typeof change.id !== "string" || !change.id || typeof change.kind !== "string" || (change.area !== "details" && change.area !== "map")) {
        findings.problem(`${document} has a change the game cannot read (change ${count(index + 1)})`);
        continue;
      }
      // Where a change carries a flag or logos, as scenarioChanges.js writes them.
      if (typeof change.flag === "string") slots.fields.set(change, { flag: "flag" });
      if (isRecord(change.fields?.flag)) slots.fields.set(change.fields.flag, { to: "flag" });
      if (change.kind === "institutionLogos") for (const side of [change.from, change.to]) if (isRecord(side)) slots.whole.set(side, "logo");
      const to = isRecord(change.to) ? change.to : null;
      if (typeof to?.file === "string") {
        slots.fields.set(to, { ...slots.fields.get(to), file: "payload" });
        if (!archive?.has(to.file) || to.file === "suggestion.json") findings.problem(`${document} names a file that is not in the zip (${quoted(to.file)})`);
        else if (!named.has(to.file)) named.set(to.file, change.kind);
      }
      // A bare suggestion.json carries its cover and its basemap in itself.
      if (change.kind === "cover" && typeof to?.base64 === "string") {
        slots.fields.set(to, { ...slots.fields.get(to), base64: "payload" });
        const picture = base64Bytes(to.base64);
        if (!picture) findings.problem(`${document} holds a cover that is not base64`);
        else await attempt(findings, `the cover in ${document}`, () => checkPicture(picture, "cover", quiet));
      }
      if (change.kind === "background" && to && to.data !== undefined) checkBasemapPayload(to.data, { label: document, findings, slots });
    }
    await checkDocument(suggestion, { label: document, findings, slots, ctx: quiet, drawn });

    for (const name of archive?.untouched ?? []) {
      const entry = quoted(name);
      const what = named.get(name);
      if (what === "background" && usable(name)) {
        const json = await attempt(findings, entry, () => parseJson(archive.read(name)));
        if (json === FAILED) continue;
        const inner = new Slots();
        checkBasemapPayload(json, { label: entry, findings, slots: inner });
        await checkDocument(json, { label: entry, findings, slots: inner, ctx: quiet, drawn });
      } else {
        await checkLooseEntry(archive, name, { findings, ctx: quiet, drawn, use: what === "cover" ? "cover" : null });
      }
    }
  });
  return { findings };
};
