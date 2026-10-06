// Map data a scenario or a basemap carries: GeoJSON the game draws, and the
// tile archives (PMTiles) it reads tiles from.

import { count, isRecord } from "./util.mjs";

// How deep each kind of geometry nests its points: a Point is one, a
// LineString a list of them, a Polygon a list of rings, and so on.
const POINT_DEPTH = { Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 };

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isPoint = (value) => Array.isArray(value) && value.length >= 2 && isNumber(value[0]) && isNumber(value[1]) && (value.length < 3 || value.every(isNumber));
const pointsOk = (value, depth) => {
  if (depth === 0) return isPoint(value);
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) if (!pointsOk(value[index], depth - 1)) return false;
  return true;
};

// Why a geometry cannot be drawn, or "".
const geometryProblem = (geometry) => {
  // A collection may hold collections; they are taken one after another.
  const waiting = [geometry];
  while (waiting.length) {
    const next = waiting.pop();
    if (!isRecord(next)) return "a shape that is not a shape";
    if (next.type === "GeometryCollection") {
      if (!Array.isArray(next.geometries)) return "a collection of shapes with no list of shapes";
      for (const part of next.geometries) waiting.push(part);
    } else if (!Object.hasOwn(POINT_DEPTH, next.type)) {
      return "a shape of a kind the game does not draw";
    } else if (!pointsOk(next.coordinates, POINT_DEPTH[next.type])) {
      return "a shape whose points are not all numbers";
    }
  }
  return "";
};

// Why `value` is not a map the game can draw (a GeoJSON FeatureCollection whose
// features each have no shape or a whole one), or "". The words finish
// "<the file> is not a map the game can draw: ".
export const featureCollectionProblem = (value) => {
  if (typeof value === "string") return "it is text (an address the game would load) where the map itself has to be";
  if (!isRecord(value) || value.type !== "FeatureCollection" || !Array.isArray(value.features)) return "it is not a GeoJSON FeatureCollection";
  for (let index = 0; index < value.features.length; index += 1) {
    const feature = value.features[index];
    if (!isRecord(feature)) return `its feature ${count(index + 1)} is not a feature`;
    if (feature.geometry === null || feature.geometry === undefined) continue;
    const wrong = geometryProblem(feature.geometry);
    if (wrong) return `its feature ${count(index + 1)} has ${wrong}`;
  }
  return "";
};

// A basemap's own file may also be a bare list of features (the game takes
// either: communityBasemaps.js readBasemapDataFile).
export const looksLikeFeatureCollection = (value) => isRecord(value) && (value.type === "FeatureCollection" || Array.isArray(value.features));

// Why `bytes` are not a tile archive the game can read (PMTiles, version 3),
// or "". The header is 127 bytes; after its name and version come the places
// and lengths of the archive's four parts, each of which has to lie inside
// the file.
export const pmtilesProblem = (bytes) => {
  if (bytes.length < 127 || bytes.toString("latin1", 0, 7) !== "PMTiles") return "it is not a PMTiles archive";
  if (bytes[7] !== 3) return `it is a PMTiles archive of version ${bytes[7]}, and the game reads version 3`;
  for (let at = 8; at < 72; at += 16) {
    const start = bytes.readBigUInt64LE(at);
    const length = bytes.readBigUInt64LE(at + 8);
    if (start + length > BigInt(bytes.length)) return "it is cut short: the archive says it is longer than the file is";
  }
  return "";
};
