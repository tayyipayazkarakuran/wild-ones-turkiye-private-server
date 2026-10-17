"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const patchDir = path.join(root, "swf-patches", "v26");
const v26Build = path.join(root, "scripts", "build-ruffle-v26.js");

test("v26 SWF patch source is minimal and self-contained", () => {
  const fieldPath = path.join(patchDir, "com", "playdom", "ballistics", "game", "Field.as");
  const field = fs.readFileSync(fieldPath, "utf8");
  const build = fs.readFileSync(v26Build, "utf8");
  assert.match(field, /^package com\.playdom\.ballistics\.game\s*\{/);
  assert.ok(field.length > 5_000);
  assert.match(build, /swf-patches", "v26"/);
  assert.doesNotMatch(build, /swf-patches", "v20"/);
});

test("seven repaired pet powers share one web/server/SWF manifest", () => {
  const pets = JSON.parse(fs.readFileSync(path.join(root, "web", "assets", "json", "Pets.dat"), "utf8"));
  const weapons = JSON.parse(fs.readFileSync(path.join(root, "web", "assets", "json", "WeaponsGrid.dat"), "utf8"));
  const powers = new Map(pets.map((pet) => [pet.type, pet.petPower]));
  const byType = new Map(weapons.map((weapon) => [weapon.type, weapon]));
  const expected = {
    bat: ["fly", 8], dragon: ["spit", 3], werewolf: ["howl", 3],
    crocodile: ["tailwhip", 4], yeti: ["punchsmack", 4],
    sheep: ["headbutt", 4], raccoon: ["tailspin", 4]
  };
  for (const [petType, [power, clip]] of Object.entries(expected)) {
    assert.equal(powers.get(petType), power);
    assert.equal(Number(byType.get(power).clip), clip);
    assert.equal(String(byType.get(power).petWeapon), "true");
  }
});

test("pet power server gate requires the active pet and disables Skill Match powers", () => {
  const handler = fs.readFileSync(path.join(root, "game", "handler.js"), "utf8");
  const build = fs.readFileSync(v26Build, "utf8");
  assert.match(handler, /properties\.petWeapon/);
  assert.match(handler, /String\(petDefinition\.petPower \|\| ""\) !== String\(data\.ammo_type\)/);
  assert.match(handler, /game\.balancedGame \? "skill_match" : "inactive_pet_power"/);
  assert.match(handler, /reason: "pet_power_depleted"/);
  assert.match(build, /type == "punch" && source\.properties\.type != "panda"/);
  assert.match(build, /source\.processPunch\(type\)/);
  assert.match(build, /rotateToCurrentPet\(\);[\s\S]*v26 initial active pet carousel focus/);
  // Pet powers with their own icon symbol must not be aliased to another
  // weapon's art; only tailwhip and fly lack one.
  assert.match(build, /"tailwhip":"punch"/);
  assert.match(build, /"fly":"jetpack"/);
  assert.doesNotMatch(build, /"howl":"mortar"|"spit":"fireball"|"headbutt":"punch"/);
  assert.match(build, /v26 pet power icon aliases/);
});

test("v26 purchases carry request ids and wait for authoritative success", () => {
  const build = fs.readFileSync(v26Build, "utf8");
  assert.match(build, /function patchLobbyPurchaseResponses/);
  assert.match(build, /param1\.value === true/);
  assert.match(build, /requestId = String\(new Date\(\)\.time\)/);
  assert.match(build, /Keep the confirmation open until accessoryPurchase\.value/);
  assert.match(build, /mapPurchase\.value is the only purchase confirmation/);
});

test("v26 lobby consumes explicit room settings and join failures", () => {
  const build = fs.readFileSync(v26Build, "utf8");
  assert.match(build, /case "room_settings"/);
  assert.match(build, /case "game_join_failed"/);
  // Join and start failures are shown as readable text, not raw codes.
  assert.match(build, /v26JoinFailureText\(command\.code\)/);
  assert.match(build, /case "game_start_failed":/);
  assert.match(build, /case "game_start_rejected":/);
  assert.doesNotMatch(build, /Unable to join game: " \+ String/);
});

test("v26 build suppresses server-health echo packets and imports the guarded Avatar class", () => {
    const build = fs.readFileSync(v26Build, "utf8");
    assert.match(build, /function patchServerHealth\(file\)/);
    assert.match(build, /private var applyingServerHealth:Boolean = false/);
    assert.match(build, /v26ReportsBotHealth:Boolean/);
    assert.match(build, /main\.nativeBotRendererId == Ballistics\.player\.id/);
    assert.match(build, /\(this\.isClient \|\| v26ReportsBotHealth\) && !applyingServerHealth/);
    assert.match(build, /this\.lastDamgeFrom\.player\.id/);
    assert.match(build, /function applyServerRespawn/);
    assert.match(build, /this\.lastHealth = this\.healthPoints/);
    assert.match(build, /clientAvatar\.player\.id == param1/);
    assert.match(build, /v26 authoritative self packet loopback/);
    assert.match(build, /"set_health":true,[\s\S]*?"respawn_player":true/);
    assert.match(build, /avatars\.addChild\(v26RespawnAvatar\)/);
    assert.match(build, /timeLoop\.addObject\(v26RespawnAvatar\)/);
    assert.match(build, /"respawn_player":true/);
    assert.match(build, /Only respawn_player may revive a dead avatar/);
    assert.match(build, /param3 != this\.respawnGeneration/);
    assert.match(build, /"command":"world_fall"/);
    assert.match(build, /ghostStartY = Y/);
    assert.match(build, /v26GhostProgress[\s\S]*?v26GhostEase[\s\S]*?main\.isMultiPlayerMode/);
    assert.match(build, /function advanceServerBotSnapshot/);
    assert.match(build, /!v26BotAvatar\.isGhost/);
    assert.doesNotMatch(build, /v26BotAvatar\.applyServerHealth/);
    assert.match(build, /copy\(path\.join\(scriptsDir, "com", "playdom", "ballistics", "avatar", "Avatar\.as"\), avatar\)/);
});

test("v26 build converts object-backed equipped weapon arrays before rendering the loadout", () => {
  const build = fs.readFileSync(v26Build, "utf8");
  assert.match(build, /v26RawEquipped:Object/);
  assert.match(build, /v26 object-backed equipped weapons/);
  assert.match(build, /_loc1_\.push\(String\(v26RawEquipped\[v26EquippedKey\]\)\)/);
});

test("v26 rebuild replaces the commented map BinaryData with strict JSON for Ruffle", () => {
  const build = fs.readFileSync(v26Build, "utf8");
  assert.match(build, /function patchMaps\(file\)/);
  assert.match(build, /function patchMapCatalogue\(\)/);
  assert.match(build, /-export", "binaryData"/);
  assert.match(build, /-replace", accessoryPatchedSwf, mapPatchedSwf, "2932"/);
  assert.match(build, /V26_MAP_NAMES\.map/);
  assert.match(build, /web", "assets", "json", "Maps\.dat"/);
  assert.match(build, /JSON\.stringify\(maps\)/);
});

test("v26 terrain patch clears collision pixels and reports the crater to server bot physics", () => {
  const build = fs.readFileSync(v26Build, "utf8");
  assert.match(build, /function patchFieldRenderer/);
  assert.match(build, /function clearExplosionCircle/);
  assert.match(build, /rowRect\.x = rowStart/);
  assert.match(build, /rowRect\.y = py/);
  assert.match(build, /rowRect\.width = rowEnd - rowStart \+ 1/);
  assert.match(build, /rowRect\.height = 1/);
  assert.doesNotMatch(build, /rowRect\.setTo/);
  assert.match(build, /target\.fillRect\(rowRect,0\)/);
  assert.doesNotMatch(build, /target\.setPixel32\(px,py,0\)/);
  assert.match(build, /wakeAfterTerrainChange/);
  assert.match(build, /v26Ground\.nP == 0/);
  assert.match(build, /"command":"terrain_explosion_batch"/);
  assert.match(build, /pendingTerrainEvents/);
  assert.match(build, /flushTerrainEvents/);
  assert.match(build, /function applyServerTerrainEvents/);
  assert.match(build, /clearExplosionCircle\(this\.bitmapData,Number\(v26ServerEvent\[0\]\)/);
  assert.match(build, /Boolean\(Battlefield\.timeLoop\) \? Battlefield\.timeLoop\.currentTick : 0/);
  assert.doesNotMatch(build, /this\.main\.timeLoop/);
  assert.doesNotMatch(build, /copyPixels\(this\.bitmapData,this\.bitmapData/);
});

test("v26 bot rendering keeps server collision authority while extrapolating snapshots", () => {
  const build = fs.readFileSync(v26Build, "utf8");
  assert.match(build, /function patchBotHealthProtocol/);
  assert.match(build, /"protocol":4/);
  assert.match(build, /applyServerBotSnapshot/);
  assert.match(build, /advanceServerBotSnapshot/);
  assert.match(build, /serverBotTargetX \+= serverBotSnapshotVx \* dt/);
  assert.match(build, /bot_state is the sole multiplayer bot physics authority/);
});

test("v26 world-state snapshots converge human life, position and terrain without client echo", () => {
  const build = fs.readFileSync(v26Build, "utf8");
  assert.match(build, /case "world_state"/);
  assert.match(build, /lastWorldStateSequence/);
  assert.match(build, /lastWorldTerrainRevision/);
  assert.match(build, /applyServerTerrainEvents\(param1\.terrain as Array\)/);
  assert.match(build, /applyServerPosition/);
  assert.match(build, /param9:Boolean = true/);
  assert.match(build, /if\(param9\)[\s\S]*?queueRespawnAck/);
  assert.match(build, /"world_state":true/);
});

test("v26 human PvP renders locally and relays one canonical projectile snapshot", () => {
  const build = fs.readFileSync(v26Build, "utf8");
  assert.match(build, /function patchAuthoritativeHumanRelay/);
  assert.match(build, /param1\.command == "projectile"[\s\S]*?sourceX = Battlefield\.main\.clientAvatar\.X[\s\S]*?timeLoop\.addCommand\(param1\)[\s\S]*?sendCommand\(param1\)/);
  assert.match(build, /"command":"position"[\s\S]*?"sequence":\+\+humanPositionSequence/);
  assert.match(build, /case "projectile":[\s\S]*?if\(!_loc4_ \|\| _loc4_\.complete\)/);
  assert.match(build, /param1\.sourceX[\s\S]*?_loc4_\.trueGunAngle = Number\(param1\.angle\)/);
  assert.match(build, /v26WorldAvatar\.score = Math\.max\(0,Number\(v26WorldState\.score\)\)/);
});

test("v26 turn completion is bound to the exact turn and respawn generation", () => {
  const build = fs.readFileSync(v26Build, "utf8");
  assert.match(build, /"command":"turn_complete"[\s\S]*?"turnEpoch":main\.turnEpoch[\s\S]*?"generation":Boolean\(main\.clientAvatar\)/);
  assert.match(build, /"generation":Boolean\(Battlefield\.main\.getAvatarByGuid\(aiCom\.playerId\)\)/);
});

test("v26 dedicated weapon classes override catalogue inheritance at runtime", () => {
  const build = fs.readFileSync(v26Build, "utf8");
  assert.match(build, /function patchWeaponRuntimeClass/);
  assert.match(build, /Boolean\(projectileClass\[type\]\) \? type/);
  assert.match(build, /expected two matches/);
  assert.match(build, /weapons", "MakeWeapon\.as"\), makeWeapon/);
});

test("all twenty bot weapons resolve to the intended runtime effect family", () => {
  const weapons = JSON.parse(fs.readFileSync(path.join(root, "web", "assets", "json", "WeaponsGrid.dat"), "utf8"));
  const byType = new Map(weapons.map((weapon) => [weapon.type, weapon]));
  const dedicated = new Set([
    "grenade", "mortar", "mirv", "drill", "goo", "lasercannon", "shuriken",
    "minigun", "multishot", "ninjastar", "dart", "chainsaw", "boomerang",
    "acidcloud", "freeze", "gravbubble", "kame", "snowman"
  ]);
  const expectedRuntime = {
    mortar: "mortar",
    grenade: "grenade",
    minigun: "minigun",
    marshmallow: "marshmallow",
    chainsaw: "chainsaw",
    multishot: "multishot",
    ninjastar: "ninjastar",
    tornadogrenade: "grenade",
    mirv: "mirv",
    shuriken: "shuriken",
    drill: "drill",
    goo: "goo",
    lasercannon: "lasercannon",
    dart: "dart",
    gravbubble: "gravbubble",
    kame: "kame",
    freeze: "freeze",
    snowman: "snowman",
    acidcloud: "acidcloud",
    boomerang: "boomerang"
  };
  for (const [type, expected] of Object.entries(expectedRuntime)) {
    const properties = byType.get(type);
    assert.ok(properties, `${type} must exist in WeaponsGrid.dat`);
    const runtime = dedicated.has(type)
      ? type
      : (properties.baseType && properties.baseType !== "null" ? properties.baseType : type);
    assert.equal(runtime, expected, `${type} must preserve its damage/effect implementation`);
  }
});

test("v26 respawn retries wait for a verified terrain contact", () => {
  const build = fs.readFileSync(v26Build, "utf8");
  assert.match(build, /param4 == v26PreviousGeneration[\s\S]*?queueRespawnAck/);
  assert.match(build, /function processRespawnAcks/);
  assert.match(build, /v26RespawnAvatar\.isGroundedForRespawn\(\)/);
  assert.match(build, /v26Ground\.nP > 0/);
  assert.match(build, /v26RespawnAvatar\.applyServerRespawn/);
});

test("the shop resolves legacy Squirrel spellings before probing icon symbols", () => {
  const build = fs.readFileSync(v26Build, "utf8");
  assert.match(build, /v26ShopWeaponType:String/);
  assert.match(build, /v26ShopWeaponType == "accorn" \|\| v26ShopWeaponType == "accorns"/);
  assert.match(build, /v26ShopWeaponType \+ "_icon"/);
});

test("the global asset manager resolves legacy Squirrel symbols without a failed AVM2 lookup", () => {
  const build = fs.readFileSync(v26Build, "utf8");
  assert.match(build, /function patchAssetManagerAliases/);
  assert.match(build, /param1 == "accorns_icon"[\s\S]*?param1 = "acornschild_icon"/);
  assert.match(build, /param1 == "accorns_ammo"[\s\S]*?param1 = "acornschild_ammo"/);
  assert.match(build, /"com", "playdom", "asset", "AssetManager\.as"\), assetManager/);
});
