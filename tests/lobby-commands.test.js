"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Handler = require("../game/handler.js");

function pathValue(target, dottedPath) {
  return String(dottedPath).split(".").reduce((value, part) => value == null ? undefined : value[part], target);
}

function setPath(target, dottedPath, value) {
  const parts = String(dottedPath).split(".");
  const finalPart = parts.pop();
  let cursor = target;
  for (const part of parts) cursor = cursor[part] || (cursor[part] = {});
  cursor[finalPart] = value;
}

function inMemoryPurchaseDatabase(player) {
  const receipts = new Map();
  return {
    async applyPurchase(spec) {
      const key = `${spec.kind}:${spec.requestId}`;
      if (receipts.has(key)) {
        return { ...receipts.get(key), duplicate: true, user: player };
      }
      const balance = Math.max(0, Number(player[spec.currency]) || 0);
      if (balance < spec.cost) {
        const failed = { ok: false, reason: "insufficient_funds", transaction: { receipt: spec.receipt } };
        receipts.set(key, failed);
        return { ...failed, duplicate: false, user: player };
      }
      for (const [field, condition] of Object.entries(spec.filter || {})) {
        if (field === "$or") continue;
        const current = pathValue(player, field);
        if (condition && Object.hasOwn(condition, "$ne") &&
            (Array.isArray(current) ? current.includes(condition.$ne) : current === condition.$ne)) {
          return { ok: false, reason: "conflict", duplicate: false, user: player };
        }
        if (condition && condition.$exists === false && current !== undefined) {
          return { ok: false, reason: "conflict", duplicate: false, user: player };
        }
      }
      player[spec.currency] = balance - spec.cost;
      for (const [field, value] of Object.entries(spec.update.$set || {})) setPath(player, field, value);
      for (const [field, value] of Object.entries(spec.update.$inc || {})) {
        setPath(player, field, (Number(pathValue(player, field)) || 0) + Number(value));
      }
      for (const [field, value] of Object.entries(spec.update.$addToSet || {})) {
        const values = Array.isArray(pathValue(player, field)) ? pathValue(player, field) : [];
        if (!values.includes(value)) values.push(value);
        setPath(player, field, values);
      }
      const transaction = { receipt: spec.receipt };
      const result = { ok: true, duplicate: false, user: player, transaction };
      receipts.set(key, result);
      return result;
    }
  };
}

function makeClient() {
  const sent = [];
  let updates = 0;
  let writes = 0;
  return {
    connectionType: "lobby",
    loggedIn: true,
    player: {
      id: 7,
      speed: 5,
      attack: 5,
      defence: 5,
      jump: 5,
      statPoints: 2,
      gold: 1500,
      treats: 20,
      allowedMaps: ["Critter Falls"],
      userWeaponsOwned: { grenade: 5 },
      ownedPets: { 1: { id: 1, type: "rabbit" } },
      currentPet: "1"
    },
    sent,
    get updates() { return updates; },
    get writes() { return writes; },
    db: null,
    sendPacket(packet) { sent.push(packet); },
    sendUpdate() { updates++; },
    updatePlayerData() { writes++; },
    chargeGold(amount) {
      if (this.player.gold < amount) return false;
      this.player.gold -= amount;
      return true;
    }
  };
}

function handler() {
  const wheelPrizes = [
    { slots: 1, reward: { teleport: 4 } },
    { slots: 3, reward: { grappling: 2 } },
    { slots: 1, reward: { grenade: 2 } },
    { slots: 1, reward: { grenade: 50 }, special: "true" },
    { slots: 1, reward: { flamethrower: 3 } },
    { slots: 1, reward: { goo: 3 } },
    { slots: 2, reward: { mirv: 1 } },
    { slots: 1, reward: { drill: 1 } },
    { slots: 1, reward: { lasercannon: 1 }, special: "true" }
  ];
  return new Handler({
    mapsObj: { "Critter Falls": {}, "Sink or Swim": { price: 75 } },
    weaponsObj: {
      teleport: {}, grappling: {}, grenade: {}, flamethrower: {}, goo: {},
      mirv: {}, drill: {}, lasercannon: {}
    },
    weaponCatalog: { entries: new Map([
      ["grenade", { selectable: true, runtimeSupported: true, iconSupported: true }],
      ["teleport", { selectable: true, runtimeSupported: true, iconSupported: true }],
      ["grappling", { selectable: true, runtimeSupported: true, iconSupported: true }],
      ["goo", { selectable: true, runtimeSupported: true, iconSupported: true }],
      ["mirv", { selectable: true, runtimeSupported: true, iconSupported: true }],
      ["drill", { selectable: true, runtimeSupported: true, iconSupported: true }],
      ["lasercannon", { selectable: true, runtimeSupported: true, iconSupported: true }],
      ["flamethrower", { selectable: true, runtimeSupported: true, iconSupported: true }]
    ]) },
    otherObj: { chanceWheel: { prize: wheelPrizes } },
    assetsObj: { Other: {
      comboTypes: [{ type: "comboA", currency: "gold", price: 1000, rewards: { common: 1 } }],
      comboRewards: { common: [{ grenade: 18 }] }
    } }
  });
}

test("private-server lobby commands persist local maps, stat packs, bundles, hotkeys and pet levels", async () => {
  const client = makeClient();
  client.db = inMemoryPurchaseDatabase(client.player);
  const target = handler();
  await target.handleLobbyCommand(client, { command: "buy_map", mapName: "Sink or Swim", requestId: "map-1" });
  target.handleLobbyCommand(client, { command: "buy_stat_point", count: 20 });
  target.handleLobbyCommand(client, { command: "buy_stat_point", type: "0" });
  target.handleLobbyCommand(client, { command: "buy_combo", type: "comboA" });
  target.handleLobbyCommand(client, { command: "set_hotkeys", value: { 1: "grenade", 2: "walk" } });
  target.handleLobbyCommand(client, { command: "levelup_pet", petId: "1" });
  target.handleLobbyCommand(client, { command: "levelup_pet", pet: "1", type: "st" });

  assert.deepEqual(client.player.allowedMaps, ["Critter Falls", "Sink or Swim"]);
  assert.equal(client.player.gold, 425);
  assert.equal(client.player.treats, 4);
  assert.equal(client.player.speed, 6);
  assert.equal(client.player.statPoints, 20);
  assert.equal(client.player.combos.comboA, 1);
  assert.deepEqual(client.player.userWeaponsOwned, { grenade: 23 });
  assert.deepEqual(client.player.hotkeys, { 1: "grenade", 2: "walk" });
  assert.equal(client.player.ownedPets[1].level, 2);
  assert.equal(client.player.ownedPets[1].st, 1);
  assert.equal(client.player.ownedPets[1].strength, 1);
  assert.equal(client.player.statPoints, 20);
  assert.equal(client.player.st, 20);
  assert.equal(client.updates, 7);
  assert.equal(client.writes, 6);
});

test("unsupported maps are rejected and the prize wheel is one server-side transaction", async () => {
  const client = makeClient();
  client.db = inMemoryPurchaseDatabase(client.player);
  const target = handler();

  assert.equal(await target.handleBuyMap(client, {
    command: "buy_map", mapName: "Moon Lake", requestId: "bad-map"
  }), false);
  assert.deepEqual(client.player.allowedMaps, ["Critter Falls"]);
  assert.deepEqual(client.sent.pop(), {
    command: "mapPurchase",
    requestId: "bad-map",
    value: false,
    reason: "unknown_item",
    item: "Moon Lake",
    quantity: 1,
    currency: "gold",
    balance: 1500
  });

  const crypto = require("node:crypto");
  const originalRandomInt = crypto.randomInt;
  crypto.randomInt = () => 5;
  try {
    assert.equal(target.handleChanceWheel(client, { command: "chance_wheel" }), true);
  } finally {
    crypto.randomInt = originalRandomInt;
  }

  assert.equal(client.player.treats, 18);
  assert.equal(client.player.userWeaponsOwned.grenade, 55);
  assert.deepEqual(client.sent.pop(), {
    command: "chance_wheel_return",
    value: { reward: { grenade: 50 }, special: "true" }
  });
  assert.equal(client.updates, 1);
  assert.equal(client.writes, 1);
});

test("lobby prize flags are persisted once and repeat frames are idempotent", () => {
  const client = makeClient();
  const target = handler();

  assert.equal(target.handleLobbyCommand(client, { command: "set_prize_flag", type: "gold" }), undefined);
  assert.equal(target.handleLobbyCommand(client, { command: "set_prize_flag", type: "treats" }), undefined);
  target.handleLobbyCommand(client, { command: "set_prize_flag", type: "gold" });

  assert.ok(client.player.promos["prize_flag:gold"]);
  assert.ok(client.player.promos["prize_flag:treats"]);
  assert.equal(client.updates, 2);
  assert.equal(client.writes, 2);
});

test("legacy member and pet-pruning requests cannot remove private-server progress", () => {
  const client = makeClient();
  const target = handler();
  target.handleLobbyCommand(client, { command: "neuter_pet", petId: 1 });
  target.handleLobbyCommand(client, { command: "member", type: 0 });

  assert.deepEqual(Object.keys(client.player.ownedPets), ["1"]);
  assert.equal(client.updates, 2);
  assert.equal(client.writes, 2);
  assert.equal(client.player.membership.active, true);
  assert.deepEqual(client.sent, [{ command: "member_return", value: true }]);
});

test("real mini-pets persist, equip in their own slot, and pet purchases identify the popup chassis", async () => {
  const client = makeClient();
  client.db = inMemoryPurchaseDatabase(client.player);
  client.player.userAccessories = [];
  client.player.ownedPets[1].accessories = [];
  const target = new Handler({
    accessoriesObj: {
      mini_falcon: { type: "mini_falcon", category: "minipets", currency: "gold", price: 500 }
    },
    petsObj: {
      rabbit: { type: "rabbit", currency: "gold", price: 100 }
    },
    config: {
      petMainColors: ["bc4234"],
      petDetailColors: ["fcd1d6"]
    }
  });

  assert.equal(await target.handleBuyAccessory(client, {
    type: "mini_falcon", requestId: "accessory-1"
  }), true);
  assert.deepEqual(client.player.userAccessories, ["mini_falcon"]);
  assert.equal(target.handleAccLoad(client, { pet: "1", load: ["mini_falcon"] }), true);
  assert.deepEqual(client.player.ownedPets[1].accessories, ["mini_falcon"]);

  assert.equal(await target.handleBuyPet(client, {
    type: "rabbit",
    name: "Buddy",
    color1: 0xbc4234,
    color2: 0xfcd1d6,
    requestId: "pet-1"
  }), true);
  assert.deepEqual(client.sent.at(-1), {
    command: "petPurchase",
    requestId: "pet-1",
    value: true,
    reason: null,
    item: "rabbit",
    quantity: 1,
    currency: "gold",
    balance: 900,
    pet: "2",
    type: "rabbit",
    name: "Buddy",
    duplicate: false
  });
  assert.equal(client.player.ownedPets[2].type, "rabbit");
  assert.equal(client.updates, 3);
  assert.equal(client.writes, 2);
});

test("duplicate purchase request ids replay the receipt without charging twice", async () => {
  const client = makeClient();
  client.player.userAccessories = [];
  client.player.ownedPets[1].accessories = [];
  client.db = inMemoryPurchaseDatabase(client.player);
  const target = new Handler({
    accessoriesObj: {
      mini_falcon: { type: "mini_falcon", category: "minipets", currency: "gold", price: 500 }
    },
    levelsObj: [{ xp: 0 }],
    itemLevel: {}
  });
  const request = { type: "mini_falcon", requestId: "same-request" };
  assert.equal(await target.handleBuyAccessory(client, request), true);
  assert.equal(await target.handleBuyAccessory(client, request), true);
  assert.equal(client.player.gold, 1000);
  assert.deepEqual(client.player.userAccessories, ["mini_falcon"]);
  const responses = client.sent.filter((packet) => packet.command === "accessoryPurchase");
  assert.equal(responses.length, 2);
  assert.equal(responses[0].duplicate, false);
  assert.equal(responses[1].duplicate, true);
  assert.equal(responses[1].balance, 1000);
});
