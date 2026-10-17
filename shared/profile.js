"use strict";

const { randomUUID } = require("crypto");
const { PROFILE_SCHEMA_VERSION, normalizeProfileState } = require("./profile-state.js");

const NAME_PATTERN = /^[\p{L}\p{N}_ -]{3,16}$/u;
// These are permanent utility weapons. The game server never consumes them,
// but Flash hides an equipped weapon unless it is present in userWeaponsOwned.
const STARTER_WEAPON_COUNTS = Object.freeze({
  walk: 99,
  bone: 99,
  superjump: 99,
  climb: 99,
  punch: 99,
  dig: 99,
  scratch: 99,
  fly: 99,
  giant: 99,
  spit: 99,
  flood: 99,
  howl: 99,
  dinoquake: 99,
  tailwhip: 99,
  battle: 99,
  punchsmack: 99,
  headbutt: 99,
  tailspin: 99,
  superspin: 99,
  fishspit: 99,
  tongue: 99,
  acornschild: 99,
  mortar: 99
});

function normalizeName(value) {
  return String(value || "").normalize("NFKC").trim();
}

function canonicalName(value) {
  return normalizeName(value).toLocaleLowerCase("en-US");
}

function validateCredentials(dname, password) {
  const name = normalizeName(dname);
  const passwordBytes = Buffer.byteLength(String(password || ""), "utf8");
  if (!NAME_PATTERN.test(name)) return { ok: false, code: "invalid_name", reason: "Usernames are 3-16 letters, numbers, spaces, _ or -." };
  if (passwordBytes < 8 || passwordBytes > 72) return { ok: false, code: "invalid_password", reason: "Passwords must be 8-72 characters." };
  return { ok: true, dname: name, dnameCanonical: canonicalName(name) };
}

function createProfile({ id, dname, passwordHash, starterInventory = {} }) {
  const inventory = {
    gold: 200,
    treats: 15,
    userAccessories: ["head_ninjaA_white"],
    durability: { head_ninjaA_white: 30 },
    ownedPets: {
      "1": {
        gender: "M", id: "1", pers: "brave", name: "Heroes", accessories: [],
        color2: "0xFFFFFF", type: "rabbit", played: 0, wins: 0, losses: 0,
        deaths: 0, kills: 0, gold: 0, lastPlayed: 0, color1: "0x4b0000"
      }
    },
    userWeaponsOwned: { ...STARTER_WEAPON_COUNTS },
    userWeaponsEquipped: ["walk", "bone", "superjump", "climb", "punch", "dig", "mortar"],
    allowedMaps: ["Critter Falls"],
    equippedFoods: {},
    cookingFoods: [],
    eatenFoods: [],
    statPoints: 50,
    combos: {},
    hotkeys: {},
    sandbox: false,
    stats: { games: 0, wins: 0, losses: 0, kills: 0, deaths: 0 },
    medals: { medalList: {}, medalCounts: {}, totalMedals: 0 },
    membership: { active: false, lastClaimAt: 0 },
    promos: {},
    mysteryGift: { claimed: false, nextAt: 0 },
    idleGift: { lastClaimAt: 0 },
    weaponUnlocks: {},
    transactions: {},
    collections: {},
    ...starterInventory
  };
  const profile = {
    id,
    dname,
    dnameCanonical: canonicalName(dname),
    passwordHash,
    serialNumber: randomUUID(),
    schemaVersion: PROFILE_SCHEMA_VERSION,
    usr: dname,
    nw: -1,
    level: 0,
    currentPet: inventory.currentPet || "1",
    nextPetId: 2,
    login_streak: 1,
    playerStatus: "playing",
    status: "playing",
    net: "M",
    gamecount: 0,
    gold: inventory.gold,
    treats: inventory.treats,
    hp: 500000,
    wins: 0,
    sesscount: 0,
    losses: 0,
    kills: 0,
    deaths: 0,
    speed: 5,
    attack: 100,
    defence: 5,
    jump: 5,
    xp: 0,
    userAccessories: inventory.userAccessories,
    durability: inventory.durability,
    ownedPets: inventory.ownedPets,
    userWeaponsOwned: inventory.userWeaponsOwned,
    userWeaponsEquipped: inventory.userWeaponsEquipped,
    allowedMaps: inventory.allowedMaps,
    equippedFoods: inventory.equippedFoods,
    cookingFoods: inventory.cookingFoods,
    eatenFoods: inventory.eatenFoods,
    statPoints: inventory.statPoints,
    combos: inventory.combos,
    hotkeys: inventory.hotkeys,
    sandbox: Boolean(inventory.sandbox || inventory.unlimitedInventory),
    unlimitedInventory: Boolean(inventory.sandbox || inventory.unlimitedInventory),
    stats: inventory.stats,
    medals: inventory.medals,
    membership: inventory.membership,
    promos: inventory.promos,
    mysteryGift: inventory.mysteryGift,
    idleGift: inventory.idleGift,
    weaponUnlocks: inventory.weaponUnlocks,
    transactions: inventory.transactions,
    collections: inventory.collections,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  return normalizeProfileState(profile);
}

const PLAYER_FIELDS = ["id", "schemaVersion", "nw", "level", "currentPet", "nextPetId", "login_streak", "playerStatus", "status", "net", "gamecount", "gold", "treats", "hp", "wins", "sesscount", "losses", "kills", "deaths", "speed", "attack", "defence", "jump", "xp", "userAccessories", "durability", "ownedPets", "userWeaponsOwned", "userWeaponsEquipped", "allowedMaps", "equippedFoods", "cookingFoods", "eatenFoods", "statPoints", "combos", "hotkeys", "sandbox", "unlimitedInventory", "stats", "medals", "membership", "promos", "mysteryGift", "idleGift", "weaponUnlocks", "transactions", "collections", "dname"];

function playerDto(user, { command = "setPlayer", snum = user.serialNumber, online = 0 } = {}) {
  const dto = { command, online, snum };
  for (const key of PLAYER_FIELDS) dto[key] = user[key];
  return dto;
}

const MUTABLE_PLAYER_FIELDS = new Set(PLAYER_FIELDS.filter((key) => !["id", "dname", "net"].includes(key)));
function mutablePlayerUpdate(player) {
  const update = { updatedAt: new Date() };
  for (const key of MUTABLE_PLAYER_FIELDS) if (Object.hasOwn(player, key)) update[key] = player[key];
  return update;
}

module.exports = { createProfile, validateCredentials, canonicalName, playerDto, mutablePlayerUpdate, STARTER_WEAPON_COUNTS };
