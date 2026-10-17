"use strict";

// These are the only maps for which the current Ruffle movie, server asset
// package and authored multiplayer data form one complete contract.  Keeping
// this list in code makes unsupported legacy maps impossible to advertise.
const V26_MAP_NAMES = Object.freeze([
  "Critter Falls",
  "Sink or Swim",
  "Crash Landing",
  "Creepy Crawly",
  "Hot and Spicy",
  "Lab Rats",
  "Big Tops",
  // Re-enabled with spawn/crate zones derived from their own collision
  // masks (scripts/derive-map-layout.js); the legacy entries had positions
  // copied from other maps.
  "Swamp",
  "Haunted Mansion",
  "Tower Tops",
  "Pumpkin Patch"
]);

// Enabled maps with price 0 in Maps.dat. Every profile owns them, so they are
// never shown locked; priced maps are bought in the shop.
const V26_FREE_MAP_NAMES = Object.freeze([
  "Critter Falls",
  "Swamp",
  "Haunted Mansion"
]);

const REQUIRED_FIELDS = Object.freeze([
  "name", "positions", "background", "foreground", "mask", "preview",
  "width", "height", "wind"
]);

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function mapValidationError(map) {
  if (!map || typeof map !== "object") return "not_an_object";
  for (const field of REQUIRED_FIELDS) {
    if (map[field] === undefined || map[field] === null || map[field] === "") return `missing_${field}`;
  }
  if (!Array.isArray(map.positions) || map.positions.length < 2) return "missing_spawns";
  if (!isFiniteNumber(map.width) || !isFiniteNumber(map.height) || Number(map.width) <= 0 || Number(map.height) <= 0) return "invalid_bounds";
  if (!isFiniteNumber(map.wind)) return "invalid_wind";
  for (const position of map.positions) {
    if (!Array.isArray(position) || position.length < 2 || !isFiniteNumber(position[0]) || !isFiniteNumber(position[1])) return "invalid_spawn";
  }
  return null;
}

function mapAssetError(map, assetExists) {
  if (typeof assetExists !== "function") return null;
  for (const field of ["background", "foreground", "mask", "preview"]) {
    if (!assetExists(String(map[field]))) return `missing_asset_${field}`;
  }
  return null;
}

function buildMapManifest(records, options = {}) {
  const byName = new Map((Array.isArray(records) ? records : []).map((record) => [record && record.name, record]));
  const maps = [];
  const rejected = [];
  for (const name of V26_MAP_NAMES) {
    const map = byName.get(name);
    const error = mapValidationError(map) || mapAssetError(map, options.assetExists);
    if (error) {
      rejected.push({ name, error });
      continue;
    }
    maps.push(map);
  }
  return Object.freeze({
    names: Object.freeze(maps.map((map) => map.name)),
    maps: Object.freeze(maps),
    rejected: Object.freeze(rejected)
  });
}

function isSupportedMapName(name) {
  return V26_MAP_NAMES.includes(String(name || ""));
}

module.exports = { V26_MAP_NAMES, V26_FREE_MAP_NAMES, buildMapManifest, isSupportedMapName, mapValidationError, mapAssetError };
