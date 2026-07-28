"use strict";

const { MEDAL_CATALOG, isKnownMedal } = require("./medals.js");
const {
  normalizeProfileState,
  recordPlayerStat,
  recordActivePetStat
} = require("./profile-state.js");

const STAT_POINT_PACKAGES = Object.freeze({ 20: 16, 45: 33, 100: 66 });
const SLOT_REELS = Object.freeze(["bone", "grenade", "teleport", "goo", "mirv", "drill", "lasercannon"]);

function ensureProgression(player) {
  normalizeProfileState(player);
  if (!player.medals || typeof player.medals !== "object") player.medals = {};
  if (!player.medals.medalList || typeof player.medals.medalList !== "object") player.medals.medalList = {};
  if (!player.medals.medalCounts || typeof player.medals.medalCounts !== "object") player.medals.medalCounts = {};
  if (!Number.isFinite(Number(player.medals.totalMedals))) player.medals.totalMedals = 0;
  if (!player.membership || typeof player.membership !== "object") player.membership = { active: false, lastClaimAt: 0 };
  if (!player.promos || typeof player.promos !== "object") player.promos = {};
  if (!player.weaponUnlocks || typeof player.weaponUnlocks !== "object") player.weaponUnlocks = {};
  if (!player.transactions || typeof player.transactions !== "object") player.transactions = {};
  if (!player.collections || typeof player.collections !== "object") player.collections = {};
  return player;
}

function rewardPlayer(player, reward) {
  ensureProgression(player);
  const granted = {};
  for (const [type, rawAmount] of Object.entries(reward || {})) {
    const amount = Math.max(0, Math.floor(Number(rawAmount) || 0));
    if (!amount) continue;
    if (type === "gold" || type === "treats" || type === "xp") player[type] = Math.max(0, Number(player[type] || 0) + amount);
    else {
      if (!player.userWeaponsOwned || typeof player.userWeaponsOwned !== "object") player.userWeaponsOwned = {};
      player.userWeaponsOwned[type] = Math.max(0, Number(player.userWeaponsOwned[type] || 0) + amount);
    }
    granted[type] = amount;
  }
  return granted;
}

function recordMedalEvent(player, type, amount = 1, now = Date.now()) {
  ensureProgression(player);
  type = String(type || "");
  amount = Math.max(0, Math.floor(Number(amount) || 0));
  if (!isKnownMedal(type) || amount < 1) return { count: 0, unlocked: [] };

  const count = Math.max(0, Number(player.medals.medalCounts[type] || 0)) + amount;
  const medals = player.medals.medalList[type] || (player.medals.medalList[type] = {});
  const unlocked = [];
  for (const tier of MEDAL_CATALOG[type]) {
    if (count >= tier && !medals[tier]) {
      medals[tier] = now;
      unlocked.push(tier);
    }
  }
  player.medals.medalCounts[type] = count;
  player.medals.totalMedals += unlocked.length;
  return { count, unlocked };
}

function awardMedal(player, type, amount = 1, now = Date.now()) {
  return recordMedalEvent(player, type, amount, now).unlocked.length > 0;
}

module.exports = {
  STAT_POINT_PACKAGES, SLOT_REELS, MEDAL_CATALOG,
  ensureProgression, rewardPlayer, recordMedalEvent, awardMedal,
  recordPlayerStat, recordActivePetStat
};
