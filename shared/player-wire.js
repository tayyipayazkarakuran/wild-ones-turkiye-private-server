"use strict";

const { STARTER_WEAPON_COUNTS } = require("./profile");
const { normalizeProfileState, comparePetIds } = require("./profile-state");
const { sanitizeEquippedAccessories } = require("./accessory-bonuses");

// The original SWF uses compact two-letter inventory keys. Keep canonical
// names in Mongo/server code, but send this exact compatibility vocabulary in
// `wf` so WeaponOwned can resolve every market and bot weapon under Ruffle.
const FLASH_WEAPON_ALIASES = Object.freeze(Object.fromEntries(
  "candy_grenade:cc,batton:be,mallet:ma,starfield:st,heartdynamite:he,mortar:mo,shotgun:si,spider:sp,teleport:te,jet:je,goopuddle:go,fishspit:fj,superjump:su,drillstrike:ds,rubbergrenades:rv,quintuplets:qu,gas:ge,airstrike:ai,acidcloud:ac,multishot:mu,grappling:gs,shield:sj,chainsaw:ch,slingshot:sl,blunderbuss:bm,cranberry:cr,climb:cm,candy_mines:ca,goolake:gt,boomerang:bp,meganinjastar:mf,potato1:po,potato2:pp,lasercannon:la,trick_bag:ts,spit:sq,rubbermirv:rw,healthEquipA:hf,jumbomissile:ju,scratch:sc,clustergrenade:cn,trout:tr,razor_apple:ra,turkey1:tu,turkey2:tv,anvil:ao,turkey3:tw,turkey4:tx,grenadeshower:gv,dynamite:dy,grenadeEL1:gw,tornadocluster:tp,shuriken:sh,blizzard:bl,minigun:mi,earthquake:ea,cow:co,superspin:sv,napalm:na,meganuke:me,babybeehive:ba,lantern:lb,dart:da,rubbergrenadestrike:ru,kame:ka,clustermissile:cl,invisibility:io,candy_corn_mirv:cb,punch:pu,mines:mj,tongue:tq,pumpkin:pv,drillcluster:dr,harpoon:ha,dualpistol:du,babyflame:bb,gammabeam:ga,lightning:li,gooshotKI1:gp,goo:gq,flood:fn,nuke:nu,grenade:gr,walk:wa,mirvSC1:mk,tornadogrenade:to,kissgoodby:ki,antigravmissile:an,flame:fl,gameovernuke:gb,blackbeauty:bn,gravbubble:gx,hamsterball:hb,bone:bo,megamirv:mg,drill:dt,dig:di,minestrike:ml,candycane:cd,bakersdozen:bc,gammaray:gc,marshmallow:mb,broom:br,mirv:mm,gammastar:gd,queenbee:qv,goostrike:gu,ninjastar:ni,babynuke:bd,flamethrower:fm,freeze:fr,zoobomb:zo,fireworks:fi,jinglebell:ji,snowman:sn,giant:gi"
    .split(",").map((entry) => entry.split(":"))
));

function asNonNegativeInt(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function normalizedMedals(player) {
  const medals = player.medals && typeof player.medals === "object" ? player.medals : {};
  const medalList = medals.medalList && typeof medals.medalList === "object" ? medals.medalList : {};
  const medalCounts = medals.medalCounts && typeof medals.medalCounts === "object" ? medals.medalCounts : {};
  return { medalList, medalCounts, total: asNonNegativeInt(medals.totalMedals) };
}

function normalizedWeapons(value) {
  const weapons = value && typeof value === "object" ? value : {};
  // Legacy accounts used an empty inventory despite having these defaults
  // equipped. v26 hides absent `wf` entries, so repair only permanent tools.
  const normalized = { ...STARTER_WEAPON_COUNTS };
  for (const [type, amount] of Object.entries(weapons)) {
    if (!type) continue;
    const rawKey = String(type);
    const key = rawKey === "accorn" || rawKey === "accorns" ? "acornschild" : rawKey;
    const quantity = asNonNegativeInt(amount);
    const repairedQuantity = Math.max(asNonNegativeInt(normalized[key]), quantity);
    normalized[key] = Object.hasOwn(STARTER_WEAPON_COUNTS, key) && repairedQuantity === 0
      ? STARTER_WEAPON_COUNTS[key]
      : repairedQuantity;
  }
  return normalized;
}

function normalizedWeaponEquip(value) {
  if (!Array.isArray(value)) return ["walk", "bone", "superjump", "climb", "punch", "dig", "mortar"];
  return value.map(String).map((type) =>
    type === "accorn" || type === "accorns" ? "acornschild" : type
  ).filter(Boolean);
}

function flashWeaponInventory(value) {
  const inventory = normalizedWeapons(value);
  const wire = {};
  for (const [type, amount] of Object.entries(inventory)) {
    wire[FLASH_WEAPON_ALIASES[type] || type] = amount;
  }
  return wire;
}

function normalizedAllowedMaps(value) {
  // The movie's legacy JSON decoder turns an Array into a numeric-keyed
  // Object. Its map conveyor enumerates keys, so use an explicit name-keyed
  // object on the wire while the persisted/server representation stays Array.
  const names = Array.isArray(value)
    ? value
    : (value && typeof value === "object" ? Object.keys(value) : []);
  const maps = {};
  for (const name of names) {
    const normalized = String(name || "").trim();
    if (normalized) maps[normalized] = normalized;
  }
  return maps;
}

// Server bookkeeping that the movie never reads. `transactions` grows with
// every purchase, so sending it made each profile packet larger over time.
const SERVER_ONLY_FIELDS = ["transactions", "passwordHash", "serialNumber", "_id", "gkey", "progressionDirty"];
// Fields that describe only the owner's private account state. Room rosters
// (startGame/changeTurn playerlist) go to every opponent and must omit them.
const PRIVATE_FIELDS = ["snum", "collections", "promos", "mysteryGift", "idleGift", "combos", "hotkeys",
  "cookingFoods", "eatenFoods", "weaponUnlocks", "online"];

function publicPlayerRecord(player) {
  const source = player && typeof player === "object" ? player : {};
  const record = {};
  for (const [key, value] of Object.entries(source)) {
    if (SERVER_ONLY_FIELDS.includes(key) || PRIVATE_FIELDS.includes(key)) continue;
    record[key] = value;
  }
  return record;
}

// The database retains readable canonical fields.  This adapter is the sole
// place that derives compact Flash fields, so purchases made after login are
// immediately visible without polluting persisted documents with socket data.
function playerWireDto(player, overrides = {}) {
  const source = player && typeof player === "object" ? player : {};
  normalizeProfileState(source);
  const dto = Object.assign({}, source, overrides);
  for (const field of SERVER_ONLY_FIELDS) {
    if (!Object.hasOwn(overrides, field)) delete dto[field];
  }
  dto.time = Date.now();
  dto.statPoints = asNonNegativeInt(source.statPoints, 50);
  dto.st = dto.statPoints;
  // v26 reads the compact `wf`/`uwe` fields first. Keep their readable
  // equivalents too, because older movie code and saved profiles use those.
  dto.userWeaponsOwned = normalizedWeapons(source.userWeaponsOwned);
  dto.wf = flashWeaponInventory(dto.userWeaponsOwned);
  dto.uwe = normalizedWeaponEquip(source.userWeaponsEquipped);
  dto.userWeaponsEquipped = dto.uwe;
  dto.allowedMaps = normalizedAllowedMaps(source.allowedMaps);
  dto.userAccessories = Array.isArray(source.userAccessories)
    ? [...new Set(source.userAccessories.map(String).filter(Boolean))]
    : [];
  dto.durability = source.durability && typeof source.durability === "object" ? source.durability : {};
  dto.currentPet = String(source.currentPet || "");
  dto.ownedPets = {};
  for (const petId of Object.keys(source.ownedPets || {}).sort(comparePetIds)) {
    const pet = { ...(source.ownedPets[petId] || {}) };
    dto.ownedPets[petId] = pet;
    pet.st = asNonNegativeInt(pet.st, asNonNegativeInt(pet.strength));
    pet.de = asNonNegativeInt(pet.de, asNonNegativeInt(pet.dexterity));
    pet.vi = asNonNegativeInt(pet.vi, asNonNegativeInt(pet.vitality));
    pet.strength = pet.st;
    pet.dexterity = pet.de;
    pet.vitality = pet.vi;
    // OwnedPet in the v26 movie names this timestamp `last`, while the
    // canonical database field is `lastPlayed`.
    pet.last = asNonNegativeInt(pet.lastPlayed, asNonNegativeInt(pet.last));
    pet.accessories = sanitizeEquippedAccessories(pet.accessories, null);
  }

  const medals = normalizedMedals(source);
  dto.me = medals.total;
  dto.medals = { medalList: medals.medalList, medalCounts: medals.medalCounts, totalMedals: medals.total };
  const membership = source.membership && typeof source.membership === "object" ? source.membership : {};
  const nextMemberGiftAt = Math.max(0, Number(membership.lastClaimAt || 0)) + (24 * 60 * 60 * 1000);
  dto.im = membership.active ? 1 : 0;
  // Membership is permanent on this server; the movie still requires a
  // future expiry timestamp to render the active-member layout.
  dto.mf = membership.active ? 4102444800000 : 0;
  dto.ne = membership.active ? nextMemberGiftAt : 0;
  dto.my = source.mysteryGift && Number(source.mysteryGift.nextAt || 0) <= Date.now() ? 1 : 0;
  dto.mz = source.mysteryGift && source.mysteryGift.claimed ? 1 : 0;
  dto.ulp = Array.isArray(source.unlockedPets) ? source.unlockedPets : [];
  dto.ut = Object.keys(source.weaponUnlocks && typeof source.weaponUnlocks === "object" ? source.weaponUnlocks : {});
  // Some v26 accessors enumerate these objects without null guards during
  // lobby construction. Supply neutral values for legacy profiles.
  dto.attributes = source.attributes && typeof source.attributes === "object" ? source.attributes : {};
  dto.games = Array.isArray(source.games) ? source.games : [];
  dto.fi = Number.isFinite(Number(source.fi)) ? Number(source.fi) : 0;
  dto.pr = asNonNegativeInt(source.pr);
  dto.mo = asNonNegativeInt(source.mo);
  dto.la = asNonNegativeInt(source.la);
  dto.ld = asNonNegativeInt(source.ld);
  // `Player.hotKeys` assigns this compact field directly to an ActionScript
  // Array. Sending the old numeric default (0) throws TypeError #1034 while
  // constructing the Change Weapon popup.
  dto.us = Array.isArray(source.us)
    ? source.us.map(String)
    : (Array.isArray(source.hotKeys) ? source.hotKeys.map(String) : []);
  return dto;
}

module.exports = { playerWireDto, publicPlayerRecord, SERVER_ONLY_FIELDS, PRIVATE_FIELDS, asNonNegativeInt, normalizedMedals, normalizedWeapons, normalizedWeaponEquip, normalizedAllowedMaps, flashWeaponInventory, FLASH_WEAPON_ALIASES };
