"use strict";

const POST_CATALOG_XP_STEP = 5580;

function thresholdForLevel(level, levels) {
  const records = Array.isArray(levels) ? levels : [];
  const requested = Math.max(0, Math.floor(Number(level) || 0));
  if (!records.length) return requested * POST_CATALOG_XP_STEP;
  const lastIndex = records.length - 1;
  if (requested <= lastIndex) return Math.max(0, Number(records[requested] && records[requested].xp) || 0);
  return Math.max(0, Number(records[lastIndex] && records[lastIndex].xp) || 0)
    + ((requested - lastIndex) * POST_CATALOG_XP_STEP);
}

function levelFromXp(value, levels) {
  const xp = Math.max(0, Math.floor(Number(value) || 0));
  for (let level = 1; level < 1000; level++) {
    if (xp < thresholdForLevel(level, levels)) return level;
  }
  return 1001;
}

module.exports = { POST_CATALOG_XP_STEP, thresholdForLevel, levelFromXp };
