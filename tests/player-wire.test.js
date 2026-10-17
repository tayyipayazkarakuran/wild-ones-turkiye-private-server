"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { playerWireDto } = require("../shared/player-wire");
const { applyMovieCompatibility } = require("../game/client/player.compat");

test("v26 player wire always supplies compact inventory and null-safe lobby fields", () => {
  const player = playerWireDto({
    userWeaponsOwned: { grenade: 5, mortar: -1 },
    userWeaponsEquipped: ["grenade", "mortar"],
    allowedMaps: ["Critter Falls", "Lab Rats"],
    weaponUnlocks: { grenade: true },
    userAccessories: ["mini_falcon", "mini_falcon", 7],
    ownedPets: { 1: { type: "rabbit" } }
  });

  for (const shortType of ["wa", "bo", "su", "cm", "pu", "di", "fly", "howl", "tailwhip"]) {
    assert.equal(player.wf[shortType], 99, `${shortType} must be visible to the v26 movie`);
  }
  for (const type of [
    "walk", "bone", "superjump", "climb", "punch", "dig", "mortar",
    "fly", "spit", "howl", "tailwhip", "punchsmack", "headbutt", "tailspin"
  ]) {
    assert.equal(player.userWeaponsOwned[type], 99, `${type} must be available to the active-pet UI`);
  }
  assert.equal(player.userWeaponsOwned.grenade, 5);
  assert.deepEqual(player.uwe, ["grenade", "mortar"]);
  assert.deepEqual(player.userWeaponsEquipped, player.uwe);
  assert.deepEqual(player.allowedMaps, {
    "Critter Falls": "Critter Falls", "Lab Rats": "Lab Rats",
    // Free maps are owned by every profile.
    Swamp: "Swamp", "Haunted Mansion": "Haunted Mansion"
  });
  assert.deepEqual(player.attributes, {});
  assert.deepEqual(player.games, []);
  assert.deepEqual(player.ut, ["grenade"]);
  assert.deepEqual(player.us, []);
  assert.deepEqual(player.userAccessories, ["mini_falcon", "7"]);
  assert.deepEqual(player.durability, {});
  assert.equal(player.currentPet, "1");
  assert.equal(player.ownedPets["1"].id, "1");
  assert.equal(player.ownedPets["1"].last, 0);
});

test("v26 hotkeys always remain an ActionScript-compatible array", () => {
  assert.deepEqual(playerWireDto({ us: 0 }).us, []);
  assert.deepEqual(playerWireDto({ us: ["grenade", 7] }).us, ["grenade", "7"]);
  assert.deepEqual(playerWireDto({ hotKeys: ["mortar"] }).us, ["mortar"]);
});

test("map arrays remain canonical on the server while the legacy SWF receives named keys", () => {
  const player = { allowedMaps: ["Critter Falls"] };
  applyMovieCompatibility(player);
  assert.deepEqual(player.allowedMaps, ["Critter Falls"]);
  assert.deepEqual(playerWireDto(player).allowedMaps, {
    "Critter Falls": "Critter Falls", Swamp: "Swamp", "Haunted Mansion": "Haunted Mansion"
  });
});

test("retired map names never reach the movie and free maps are always owned", () => {
  const maps = playerWireDto({ allowedMaps: ["Kennel", "Big Tops"] }).allowedMaps;
  assert.equal(Object.hasOwn(maps, "Kennel"), false);
  assert.equal(maps["Big Tops"], "Big Tops");
  assert.equal(maps.Swamp, "Swamp");
});

test("legacy accorn spellings are merged into the real acornschild asset key", () => {
  const player = {
    userWeaponsOwned: { accorn: 4, accorns: 7, acornschild: 2 },
    userWeaponsEquipped: ["mortar", "accorns", "accorn"]
  };
  const dto = playerWireDto(player);
  assert.equal(dto.userWeaponsOwned.acornschild, 99);
  assert.equal(Object.hasOwn(dto.userWeaponsOwned, "accorn"), false);
  assert.equal(Object.hasOwn(dto.userWeaponsOwned, "accorns"), false);
  assert.deepEqual(dto.userWeaponsEquipped, ["mortar", "acornschild", "acornschild"]);
  assert.equal(Object.hasOwn(player.userWeaponsOwned, "accorn"), false);
  assert.equal(Object.hasOwn(player.userWeaponsOwned, "accorns"), false);
});
