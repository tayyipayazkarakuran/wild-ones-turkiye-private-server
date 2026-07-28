"use strict";

const PROFILE_SCHEMA_VERSION = 3;
const PLAYER_COUNTER_FIELDS = Object.freeze(["games", "wins", "losses", "kills", "deaths"]);
const PET_COUNTER_FIELDS = Object.freeze(["played", "wins", "losses", "kills", "deaths", "gold"]);

function nonNegativeInt(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function comparePetIds(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  const leftNumeric = Number.isInteger(leftNumber) && leftNumber >= 0;
  const rightNumeric = Number.isInteger(rightNumber) && rightNumber >= 0;
  if (leftNumeric && rightNumeric) return leftNumber - rightNumber;
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return String(left).localeCompare(String(right), "en-US");
}

function normalizePet(pet, id) {
  const normalized = pet && typeof pet === "object" && !Array.isArray(pet) ? pet : {};
  normalized.id = String(id);
  normalized.accessories = Array.isArray(normalized.accessories)
    ? [...new Set(normalized.accessories.map(String).filter(Boolean))]
    : [];

  const nested = normalized.stats && typeof normalized.stats === "object" ? normalized.stats : {};
  for (const field of PET_COUNTER_FIELDS) {
    normalized[field] = Math.max(nonNegativeInt(normalized[field]), nonNegativeInt(nested[field]));
  }
  normalized.lastPlayed = nonNegativeInt(normalized.lastPlayed, nonNegativeInt(nested.lastPlayed));
  delete normalized.stats;
  return normalized;
}

function normalizeOwnedPets(player) {
  const source = player.ownedPets && typeof player.ownedPets === "object" && !Array.isArray(player.ownedPets)
    ? player.ownedPets
    : {};
  const normalized = {};
  for (const id of Object.keys(source).sort(comparePetIds)) {
    const canonicalId = String(id);
    normalized[canonicalId] = normalizePet(source[id], canonicalId);
  }
  player.ownedPets = normalized;

  const requested = String(player.currentPet == null ? "" : player.currentPet);
  const ids = Object.keys(normalized).sort(comparePetIds);
  player.currentPet = Object.hasOwn(normalized, requested) ? requested : (ids[0] || "");
  player.nextPetId = Math.max(
    nonNegativeInt(player.nextPetId, 1),
    ...ids.map(Number).filter((value) => Number.isInteger(value) && value >= 0).map((value) => value + 1),
    1
  );
  return player;
}

function synchronizeLegacyStats(player) {
  player.wins = nonNegativeInt(player.stats.wins);
  player.losses = nonNegativeInt(player.stats.losses);
  player.gamecount = nonNegativeInt(player.stats.games);
  player.kills = nonNegativeInt(player.stats.kills);
  player.deaths = nonNegativeInt(player.stats.deaths);
  return player;
}

function normalizeProfileState(player) {
  if (!player || typeof player !== "object") return player;
  const stats = player.stats && typeof player.stats === "object" && !Array.isArray(player.stats)
    ? player.stats
    : {};

  stats.wins = Math.max(nonNegativeInt(stats.wins), nonNegativeInt(player.wins));
  stats.losses = Math.max(nonNegativeInt(stats.losses), nonNegativeInt(player.losses));
  stats.kills = Math.max(nonNegativeInt(stats.kills), nonNegativeInt(player.kills));
  stats.deaths = Math.max(nonNegativeInt(stats.deaths), nonNegativeInt(player.deaths));
  stats.games = Math.max(
    nonNegativeInt(stats.games),
    nonNegativeInt(player.gamecount),
    stats.wins + stats.losses
  );
  for (const field of ["damageDealt", "damageTaken", "shotsFired", "moves", "crates", "purchases"]) {
    stats[field] = nonNegativeInt(stats[field]);
  }

  player.stats = stats;
  synchronizeLegacyStats(player);
  normalizeOwnedPets(player);
  if (player.userWeaponsOwned && typeof player.userWeaponsOwned === "object" && !Array.isArray(player.userWeaponsOwned)) {
    const canonicalAcorns = Math.max(
      nonNegativeInt(player.userWeaponsOwned.acornschild),
      nonNegativeInt(player.userWeaponsOwned.accorn),
      nonNegativeInt(player.userWeaponsOwned.accorns)
    );
    if (canonicalAcorns > 0) player.userWeaponsOwned.acornschild = canonicalAcorns;
    delete player.userWeaponsOwned.accorn;
    delete player.userWeaponsOwned.accorns;
  }
  if (Array.isArray(player.userWeaponsEquipped)) {
    player.userWeaponsEquipped = player.userWeaponsEquipped.map((type) =>
      type === "accorn" || type === "accorns" ? "acornschild" : type
    );
  }
  player.schemaVersion = PROFILE_SCHEMA_VERSION;
  return player;
}

function recordPlayerStat(player, field, amount = 1) {
  normalizeProfileState(player);
  const increment = Number(amount);
  if (!Number.isFinite(increment) || !field) return 0;
  player.stats[field] = Math.max(0, Number(player.stats[field] || 0) + increment);
  if (PLAYER_COUNTER_FIELDS.includes(field)) synchronizeLegacyStats(player);
  return player.stats[field];
}

function activePet(player) {
  normalizeProfileState(player);
  return player.ownedPets && player.ownedPets[String(player.currentPet)] || null;
}

function recordActivePetStat(player, field, amount = 1, now = Date.now()) {
  const pet = activePet(player);
  if (!pet || !PET_COUNTER_FIELDS.includes(field)) return 0;
  const increment = Number(amount);
  if (!Number.isFinite(increment)) return pet[field];
  pet[field] = Math.max(0, Number(pet[field] || 0) + increment);
  if (field === "played") pet.lastPlayed = nonNegativeInt(now);
  return pet[field];
}

function profileStateSnapshot(player) {
  return JSON.stringify({
    schemaVersion: player && player.schemaVersion,
    currentPet: player && player.currentPet,
    nextPetId: player && player.nextPetId,
    ownedPets: player && player.ownedPets,
    stats: player && player.stats,
    wins: player && player.wins,
    losses: player && player.losses,
    gamecount: player && player.gamecount,
    kills: player && player.kills,
    deaths: player && player.deaths
  });
}

function profileStateUpdate(player) {
  normalizeProfileState(player);
  return {
    schemaVersion: player.schemaVersion,
    currentPet: player.currentPet,
    nextPetId: player.nextPetId,
    ownedPets: player.ownedPets,
    stats: player.stats,
    wins: player.wins,
    losses: player.losses,
    gamecount: player.gamecount,
    kills: player.kills,
    deaths: player.deaths,
    updatedAt: new Date()
  };
}

module.exports = {
  PROFILE_SCHEMA_VERSION,
  PLAYER_COUNTER_FIELDS,
  PET_COUNTER_FIELDS,
  nonNegativeInt,
  comparePetIds,
  normalizePet,
  normalizeOwnedPets,
  normalizeProfileState,
  synchronizeLegacyStats,
  recordPlayerStat,
  activePet,
  recordActivePetStat,
  profileStateSnapshot,
  profileStateUpdate
};
