"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Handler = require("../game/handler.js");
const legacyCollections = require("../shared/legacy-chance-collections.json");
const accessoryManifest = require("../shared/bot-accessory-assets.json");
const weaponManifest = require("../shared/weapon-assets.json");
const { buildWeaponCatalog } = require("../shared/weapon-catalog.js");

const root = path.resolve(__dirname, "..");

function pathValue(target, dottedPath) {
  return String(dottedPath).split(".").reduce((value, part) => value == null ? undefined : value[part], target);
}

function setPath(target, dottedPath, value) {
  const parts = String(dottedPath).split(".");
  const final = parts.pop();
  let cursor = target;
  for (const part of parts) cursor = cursor[part] || (cursor[part] = {});
  cursor[final] = value;
}

function purchaseDb(player) {
  return {
    async applyPurchase(spec) {
      const key = crypto.createHash("sha256").update(`${spec.kind}:${spec.requestId}`).digest("hex");
      if (player.transactions[key]) {
        return { ok: player.transactions[key].ok !== false, duplicate: true, user: player, transaction: player.transactions[key] };
      }
      for (const [field, condition] of Object.entries(spec.filter || {})) {
        const current = pathValue(player, field);
        if (condition && Array.isArray(condition.$in) && !condition.$in.includes(current == null ? null : current)) {
          return { ok: false, reason: "conflict", user: player };
        }
        if (typeof condition !== "object" && current !== condition) {
          return { ok: false, reason: "conflict", user: player };
        }
      }
      if (Number(player[spec.currency] || 0) < spec.cost) {
        return { ok: false, reason: "insufficient_funds", user: player };
      }
      player[spec.currency] -= spec.cost;
      for (const [field, amount] of Object.entries(spec.update.$inc || {})) {
        setPath(player, field, (Number(pathValue(player, field)) || 0) + Number(amount));
      }
      for (const [field, value] of Object.entries(spec.update.$set || {})) setPath(player, field, value);
      for (const [field, value] of Object.entries(spec.update.$addToSet || {})) {
        const current = Array.isArray(pathValue(player, field)) ? pathValue(player, field) : [];
        const additions = value && Array.isArray(value.$each) ? value.$each : [value];
        for (const item of additions) if (!current.includes(item)) current.push(item);
        setPath(player, field, current);
      }
      const transaction = { ok: true, requestId: spec.requestId, kind: spec.kind, receipt: spec.receipt };
      player.transactions[key] = transaction;
      return { ok: true, duplicate: false, user: player, transaction };
    }
  };
}

function collectionFixture() {
  const accessories = JSON.parse(fs.readFileSync(path.join(root, "web", "assets", "json", "Accessories.dat"), "utf8"));
  const weapons = JSON.parse(fs.readFileSync(path.join(root, "web", "assets", "json", "WeaponsGrid.dat"), "utf8"));
  const pets = JSON.parse(fs.readFileSync(path.join(root, "web", "assets", "json", "Pets.dat"), "utf8"));
  const player = {
    id: 501,
    gold: 0,
    treats: 100,
    xp: 0,
    currentPet: "1",
    nextPetId: 2,
    ownedPets: { "1": { id: "1", type: "rabbit", name: "Rabbit", accessories: [] } },
    userAccessories: [],
    userWeaponsOwned: {},
    durability: {},
    transactions: {},
    collections: {},
    stats: {}
  };
  const sent = [];
  const rolls = [0, 1, 2, 3, 4, 5, 6, 7];
  const client = {
    connectionType: "lobby",
    player,
    db: purchaseDb(player),
    sendPacket(packet) { sent.push(packet); },
    sendUpdate() {},
    updatePlayerData() {}
  };
  const handler = new Handler({
    otherObj: { chanceCollections: legacyCollections },
    accessoriesObj: Object.fromEntries(accessories.map((item) => [item.type, item])),
    accessoryAssetManifest: accessoryManifest,
    weaponAssetManifest: weaponManifest,
    weaponCatalog: buildWeaponCatalog(weapons),
    petsObj: Object.fromEntries(pets.map((item) => [item.type, item])),
    config: { petMainColors: ["0x999999"], petDetailColors: ["0xFFFFFF"] },
    randomInt() { return rolls.shift() ?? 0; }
  });
  return { client, handler, player, sent };
}

test("original Collection Raffle products and final prizes are restored", () => {
  assert.deepEqual(legacyCollections.collectionKeys,
    ["chanceCollection1", "chanceCollection2", "chanceCollection3"]);
  assert.deepEqual(legacyCollections.chanceCollection1.finalPrize, { acidcloud: 40 });
  assert.deepEqual(legacyCollections.chanceCollection2.finalPrize, { platypus: 1 });
  assert.deepEqual(legacyCollections.chanceCollection3.finalPrize, { dragon: 1 });
  assert.equal(legacyCollections.chanceCollection1.prize.length, 8);
  assert.equal(legacyCollections.chanceCollection2.prize.length, 8);
  assert.equal(legacyCollections.chanceCollection3.prize.length, 8);
});

test("legacy raffle charges nine treats, grants Platypus once, and replays duplicate requests", async () => {
  const fixture = collectionFixture();
  for (let index = 0; index < 8; index++) {
    await fixture.handler.handleCollectionRoll(fixture.client, {
      requestId: `spaniard-${index}`,
      setType: "chanceCollection2"
    });
    assert.equal(fixture.sent.at(-1).value, true);
  }
  assert.equal(fixture.player.treats, 28);
  assert.equal(fixture.player.userAccessories.length, 8);
  assert.equal(fixture.player.collections.chanceCollection2.finalClaimed, true);
  assert.equal(fixture.player.ownedPets["2"].type, "platypus");
  assert.equal(fixture.player.nextPetId, 3);
  const finalResponse = fixture.sent.at(-1);
  assert.deepEqual(finalResponse.finalReward, { platypus: 1 });

  await fixture.handler.handleCollectionRoll(fixture.client, {
    requestId: "spaniard-7",
    setType: "chanceCollection2"
  });
  assert.equal(fixture.player.treats, 28);
  assert.deepEqual(Object.keys(fixture.player.ownedPets), ["1", "2"]);
  assert.deepEqual(fixture.sent.at(-1).finalReward, { platypus: 1 });
});

test("30 Hz presentation preserves the authored 24 Hz animation clock", () => {
  const web = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
  const build = fs.readFileSync(path.join(root, "scripts", "build-ruffle-v26.js"), "utf8");
  assert.match(web, /frameRate:30/);
  assert.doesNotMatch(web, /frameRate:60/);
  assert.match(build, /LEGACY_ANIMATION_FPS:Number = 24/);
  assert.match(build, /getTimer\(\) - legacyAnimationStartedAt/);
  assert.match(build, /48 \* _loc5_ \/ 1000/);
  const elapsedMs = 60_000;
  assert.equal(Math.floor(elapsedMs * 24 / 1000), 1440);
  assert.equal(Math.floor(elapsedMs * 30 / 1000), 1800);
});
