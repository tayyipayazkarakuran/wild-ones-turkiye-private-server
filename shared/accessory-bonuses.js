"use strict";

const accessoryAssetManifest = require("./bot-accessory-assets.json");

const SUPPORTED_BONUSES = Object.freeze([
  "damage_taken",
  "walk_speed",
  "jump",
  "health_points",
  "fall_damage",
  "gamma_damage",
  "fish_damage",
  "gravity"
]);

function manifestRecord(type, manifest = accessoryAssetManifest) {
  const id = String(type || "");
  const records = manifest && manifest.accessories;
  if (records && records[id]) return records[id];
  const legacyTypes = new Set(manifest && manifest.types || []);
  return legacyTypes.has(id)
    ? {
        rendererSupported: true,
        shopVisible: true,
        equipVisible: true,
        rewardEligible: true,
        effectiveType: id,
        reason: null
      }
    : null;
}

function isRendererSupported(type, manifest = accessoryAssetManifest) {
  const record = manifestRecord(type, manifest);
  return Boolean(record && record.rendererSupported);
}

function sanitizeEquippedAccessories(values, definitions, manifest = accessoryAssetManifest, limit = 6) {
  const result = [];
  const categories = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const type = String(raw || "");
    const definition = definitions && definitions[type];
    const record = manifestRecord(type, manifest);
    const category = String(definition && definition.category || record && record.category || "");
    if (!type || !record || !record.equipVisible || !category || categories.has(category)) continue;
    categories.add(category);
    result.push(type);
    if (result.length >= limit) break;
  }
  return result;
}

function calculateAccessoryBonuses(values, definitions, options = {}) {
  const result = Object.fromEntries(SUPPORTED_BONUSES.map((key) => [key, 0]));
  if (options.balanced) return result;
  const manifest = options.manifest || accessoryAssetManifest;
  const categories = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const type = String(raw || "");
    const definition = definitions && definitions[type];
    const record = manifestRecord(type, manifest);
    const category = String(definition && definition.category || record && record.category || "");
    if (!definition || !record || !record.equipVisible || !category || categories.has(category)) continue;
    categories.add(category);
    for (const key of SUPPORTED_BONUSES) {
      const value = Number(definition.stats && definition.stats[key]);
      if (Number.isFinite(value)) result[key] += value;
    }
  }
  return result;
}

module.exports = {
  SUPPORTED_BONUSES,
  manifestRecord,
  isRendererSupported,
  sanitizeEquippedAccessories,
  calculateAccessoryBonuses
};
