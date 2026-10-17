"use strict";

const { execFileSync } = require("node:child_process");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { V26_MAP_NAMES } = require("../shared/map-manifest.js");

const root = path.resolve(__dirname, "..");
const ffdec = process.env.FFDEC_CLI || path.join(root, ".tools", "ffdec", "ffdec-cli.exe");
const swf = path.join(root, "web", "web", "gamewo-v26.swf");
assert.ok(fs.existsSync(swf), "gamewo-v26.swf is missing");
assert.ok(fs.statSync(swf).size > 1_500_000, "gamewo-v26.swf is unexpectedly small");

const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "wild-ones-v26-"));
try {
  execFileSync(ffdec, ["-export", "script", exportDir, swf], { cwd: root, stdio: "inherit" });
  const binaryDir = path.join(exportDir, "binary");
  execFileSync(ffdec, ["-export", "binaryData", binaryDir, swf], { cwd: root, stdio: "inherit" });
  const mapsBinary = fs.readdirSync(binaryDir)
    .map((entry) => path.join(binaryDir, entry))
    .find((file) => /_Ballistics_MapsJSON\.bin$/i.test(path.basename(file)));
  const otherBinary = fs.readdirSync(binaryDir)
    .map((entry) => path.join(binaryDir, entry))
    .find((file) => /_Ballistics_OtherJSON\.bin$/i.test(path.basename(file)));
  const accessoriesBinary = fs.readdirSync(binaryDir)
    .map((entry) => path.join(binaryDir, entry))
    .find((file) => /_Ballistics_AccessoriesJSON\.bin$/i.test(path.basename(file)));
  assert.ok(mapsBinary, "v26 embedded map catalogue is missing");
  assert.ok(otherBinary, "v26 embedded Other catalogue is missing");
  assert.ok(accessoriesBinary, "v26 embedded accessory catalogue is missing");
  const movieMaps = JSON.parse(fs.readFileSync(mapsBinary, "utf8"));
  const movieOther = JSON.parse(fs.readFileSync(otherBinary, "utf8"));
  const movieAccessories = JSON.parse(fs.readFileSync(accessoriesBinary, "utf8"));
  assert.deepEqual(movieMaps.map((map) => map.name), V26_MAP_NAMES, "movie and server must expose the same seven maps");
  assert.equal(movieMaps.some((map) => map.name === "Ice Bridges"), false, "retired Ice Bridges must not be advertised");
  const player = fs.readFileSync(path.join(exportDir, "scripts", "Player.as"), "utf8");
  const launcher = fs.readFileSync(path.join(exportDir, "scripts", "com", "playdom", "ballistics", "shared", "ApplicationLauncher.as"), "utf8");
  const field = fs.readFileSync(path.join(exportDir, "scripts", "com", "playdom", "ballistics", "game", "Field.as"), "utf8");
  const processor = fs.readFileSync(path.join(exportDir, "scripts", "CommandProcessor.as"), "utf8");
  const battlefield = fs.readFileSync(path.join(exportDir, "scripts", "Battlefield.as"), "utf8");
  const avatar = fs.readFileSync(path.join(exportDir, "scripts", "com", "playdom", "ballistics", "avatar", "Avatar.as"), "utf8");
  const timeLoop = fs.readFileSync(path.join(exportDir, "scripts", "com", "playdom", "ballistics", "game", "TimeLoop.as"), "utf8");
  const aiCommands = fs.readFileSync(path.join(exportDir, "scripts", "com", "playdom", "ballistics", "AI", "AICommands.as"), "utf8");
  const foodBowl = fs.readFileSync(path.join(exportDir, "scripts", "com", "playdom", "ballistics", "feeding", "PetFoodBowl.as"), "utf8");
  const foodProperties = fs.readFileSync(path.join(exportDir, "scripts", "PetFoodProperties.as"), "utf8");
  const slotMachine = fs.readFileSync(path.join(exportDir, "scripts", "com", "playdom", "slotmachine", "SlotMachine.as"), "utf8");
  const externalCalls = fs.readFileSync(path.join(exportDir, "scripts", "com", "playdom", "ballistics", "shared", "ExternalCalls.as"), "utf8");
  const makeWeapon = fs.readFileSync(path.join(exportDir, "scripts", "com", "playdom", "ballistics", "weapons", "MakeWeapon.as"), "utf8");
  const drill = fs.readFileSync(path.join(exportDir, "scripts", "com", "playdom", "ballistics", "weapons", "Drill.as"), "utf8");
  const prizeData = fs.readFileSync(path.join(exportDir, "scripts", "com", "playdom", "ballistics", "chance", "PrizeData.as"), "utf8");
  const wheel = fs.readFileSync(path.join(exportDir, "scripts", "com", "playdom", "ballistics", "chance", "Wheel.as"), "utf8");
  const leaderBoard = fs.readFileSync(path.join(exportDir, "scripts", "com", "playdom", "ballistics", "leaderboard", "LeaderBoard.as"), "utf8");
  const shopWeapons = fs.readFileSync(path.join(exportDir, "scripts", "com", "playdom", "ballistics", "shop", "Weapons", "ShopWeaponsConveyor.as"), "utf8");
  const weaponProperties = fs.readFileSync(path.join(exportDir, "scripts", "WeaponProperties.as"), "utf8");
  const gooShot = fs.readFileSync(path.join(exportDir, "scripts", "com", "playdom", "ballistics", "weapons", "GooShot.as"), "utf8");
  const accessoryProperties = fs.readFileSync(path.join(exportDir, "scripts", "AccessoriesProperties.as"), "utf8");
  const shopAccessories = fs.readFileSync(path.join(exportDir, "scripts", "com", "playdom", "ballistics", "shop", "ShopAccessoriesConveyor.as"), "utf8");
  const petAccessories = fs.readFileSync(path.join(exportDir, "scripts", "com", "playdom", "ballistics", "pet", "PetAccessoriesConveyor.as"), "utf8");
  const accessoryBonus = fs.readFileSync(path.join(exportDir, "scripts", "com", "playdom", "ballistics", "avatar", "AccessoryBonus.as"), "utf8");
  const animalGraphics = fs.readFileSync(path.join(exportDir, "scripts", "com", "playdom", "ballistics", "avatar", "AnimalGraphics.as"), "utf8");
  const miniPet = fs.readFileSync(path.join(exportDir, "scripts", "com", "playdom", "ballistics", "avatar", "MiniPet.as"), "utf8");
  const overlay = fs.readFileSync(path.join(exportDir, "scripts", "com", "playdom", "ballistics", "home", "OverlayView.as"), "utf8");
  const collection = fs.readFileSync(path.join(exportDir, "scripts", "com", "playdom", "ballistics", "collection", "CollectionPopup.as"), "utf8");
  const collectionReel = fs.readFileSync(path.join(exportDir, "scripts", "com", "playdom", "ballistics", "collection", "Reel.as"), "utf8");
  const assetLoadView = fs.readFileSync(path.join(exportDir, "scripts", "com", "playdom", "ballistics", "home", "AssetLoadView.as"), "utf8");
  const bannerView = fs.readFileSync(path.join(exportDir, "scripts", "com", "playdom", "ballistics", "home", "BannerView.as"), "utf8");
  assert.match(player, /_obj\.allowedMaps is Array/, "v26 must accept array-backed owned maps");
  assert.match(player, /v26OwnedWeapons:Object/, "v26 must accept canonical server weapon inventories");
  assert.match(player, /v26AllowedMap:String/, "v26 must keep array-backed maps in the owned-item cache");
  assert.match(player, /v26RawEquipped:Object/, "v26 must normalize object-backed equipped weapon arrays");
  assert.match(player, /_loc5_ == null && Boolean\(Ballistics\.weaponObject\[_loc4_\]\)/, "v26 must accept canonical server weapon unlocks");
  assert.match(player, /!\(_obj\.us is Array\)/, "v26 hot keys must reject scalar profile values");
  assert.match(launcher, /com\.adobe\.serialization\.json\.JSON\.decode\(param1\)/, "v26 must use the explicit JSON decoder after the map BinaryData is normalized");
  assert.match(field, /foregroundBitmapData/, "v26 must rasterize visible terrain");
  assert.match(field, /function clearExplosionCircle/, "v26 must clear collision and foreground pixels");
  assert.match(field, /rowRect\.x = rowStart/, "v26 crater rows must use the target runtime's Rectangle API");
  assert.match(field, /rowRect\.width = rowEnd - rowStart \+ 1/, "v26 crater rows must preserve the calculated scanline width");
  assert.doesNotMatch(field, /rowRect\.setTo/, "v26 must not call the unavailable Rectangle.setTo API");
  assert.match(field, /target\.fillRect\(rowRect,0\)/, "v26 crater pixels must become transparent");
  assert.doesNotMatch(field, /setPixel32\(px,py,0\)/, "v26 crater removal must avoid per-pixel ActionScript calls");
  assert.match(field, /wakeAfterTerrainChange/, "v26 crater removal must wake unsupported avatars");
  assert.match(field, /"command":"terrain_explosion_batch"/, "v26 batched terrain damage must reach server bot physics");
  assert.match(field, /pendingTerrainEvents/, "v26 terrain rendering must coalesce crater work");
  assert.match(field, /function applyServerTerrainEvents/, "v26 must accept authoritative terrain convergence records");
  assert.match(field, /currentExplosionType/, "terrain batches must carry the weapon type for server bot knockback");
  assert.doesNotMatch(field, /cacheAsBitmap = true/, "the full-map terrain must not be cached as a second bitmap");
  assert.match(field, /clearExplosionCircle\(this\.bitmapData,Number\(v26ServerEvent\[0\]\)/,
    "authoritative terrain convergence must update the collision bitmap without echoing a new client batch");
  assert.match(field, /Boolean\(Battlefield\.timeLoop\) \? Battlefield\.timeLoop\.currentTick : 0/,
    "v26 terrain batching must read the static Battlefield time loop");
  assert.doesNotMatch(field, /this\.main\.timeLoop/,
    "v26 terrain batching must not raise AVM2 #1069 by reading timeLoop through a Battlefield instance");
  assert.doesNotMatch(field, /BlendMode\.ERASE/, "v26 terrain must not depend on Ruffle ERASE compositing");
  assert.match(processor, /case "bot_state"/, "v26 must apply server bot snapshots");
  assert.match(processor, /case "world_state"/, "v26 must apply periodic authoritative world snapshots");
  assert.match(processor, /lastWorldStateSequence/, "v26 must reject reordered world snapshots");
  assert.match(processor, /param1\.terrainFrom/, "world snapshots must apply terrain deltas only on top of their base revision");
  assert.match(processor, /applyServerTerrainEvents\(param1\.terrain as Array\)/,
    "world snapshots must repair terrain missed by one renderer");
  assert.match(processor, /applyServerBotSnapshot/, "v26 bot snapshots must use visual interpolation");
  assert.match(processor, /!v26BotAvatar\.isGhost/, "dead bot snapshots must not pin an angel in place");
  assert.doesNotMatch(processor, /v26BotAvatar\.applyServerHealth/, "bot position snapshots must not rewrite HP");
  assert.match(processor, /case "map_unavailable"/, "retired map requests must leave finding-match state");
  assert.match(processor, /applyServerHealth\(Number\(param1\.hp\),Number\(param1\.maxHp\),Number\(param1\.generation\),Number\(param1\.revision\)\)/,
    "set_health must pass exactly four arguments");
  assert.match(avatar, /public function applyServerHealth\(param1:Number, param2:Number, param3:Number, param4:Number = -1\)/,
    "applyServerHealth must accept exactly four arguments");
  assert.match(battlefield, /Ballistics\.registerServerBot\(_loc6_,game\)/, "v26 must register multiplayer bots with the rendering loop");
  assert.match(battlefield, /v26RespawnAvatar\.applyServerRespawn/, "v26 respawn must use the atomic avatar restore");
  assert.match(battlefield, /clientAvatar\.player\.id == param1/, "the owning renderer must recover its detached local avatar");
  assert.match(battlefield, /"set_health":true[\s\S]*?"respawn_player":true/, "self health and respawn packets must bypass the legacy echo filter");
  assert.match(battlefield, /avatars\.addChild\(v26RespawnAvatar\)/, "respawn must restore the avatar display object");
  assert.match(battlefield, /timeLoop\.addObject\(v26RespawnAvatar\)/, "respawn must restore the avatar simulation object");
  assert.match(battlefield, /param4 == v26PreviousGeneration[\s\S]*?queueRespawnAck/, "duplicate respawn packets must be re-queued for observation");
  assert.match(battlefield, /respawnPlayer\(param1:String, param2:Number, param3:Number, param4:Number, param5:Number, param6:Number, param7:String, param8:Number, param9:Boolean = true\)/,
    "respawn must receive its one-time token, terrain revision and acknowledgement policy");
  assert.match(battlefield, /if\(param9\)[\s\S]*?queueRespawnAck/,
    "normal respawns must ACK while world-state recovery remains feedback-free");
  assert.match(battlefield, /v26RespawnAvatar\.isGroundedForRespawn\(\)[\s\S]*?"respawnToken":v26RespawnState\.respawnToken[\s\S]*?"grounded":true/,
    "respawn acknowledgement must wait for ground and echo its token");
  assert.match(avatar, /function isGroundedForRespawn[\s\S]*?v26Ground\.nP > 0/,
    "respawn ground observation must use the live collision mask");
  assert.match(avatar, /function applyServerRespawn/, "v26 avatar must expose an atomic respawn transition");
  assert.match(avatar, /v26ReportsBotHealth/, "v26 selected renderer must report bot health");
  assert.match(avatar, /function wakeAfterTerrainChange/, "v26 avatar must leave its resting state when terrain support disappears");
  assert.match(avatar, /this\.lastHealth = this\.healthPoints/, "respawn must not render a fake positive heal");
  assert.match(avatar, /param3 != this\.respawnGeneration/, "stale health packets must not cross a life generation");
  assert.match(avatar, /param4 <= this\.lastServerHealthRevision/, "stale health revisions must not overwrite a newer value");
  assert.match(avatar, /function applyServerPosition/, "v26 avatar must accept generation-bound position reconciliation");
  assert.match(avatar, /param4 <= this\.lastServerPositionRevision/,
    "stale position revisions must not overwrite a newer remote position");
  assert.match(avatar, /"command":"world_fall"/, "v26 must explicitly report a local avatar leaving the world");
  assert.match(avatar, /ghostStartY = Y/, "v26 ghost ascent must retain its death position");
  assert.match(avatar, /v26GhostProgress[\s\S]*?v26GhostEase[\s\S]*?main\.isMultiPlayerMode[\s\S]*?return;/,
    "v26 multiplayer ghosts must complete an eased ascent before server respawn");
  assert.match(avatar, /function advanceServerBotSnapshot/, "v26 bots must interpolate authoritative positions");
  assert.match(timeLoop, /else if\(!\(main\.isMultiPlayerMode && phyObj is Avatar && Avatar\(phyObj\)\.player\.isBot\)\)/, "v26 must not run multiplayer bot collision twice");
  assert.match(timeLoop, /advanceServerBotSnapshot/, "v26 must smooth server bot motion between snapshots");
  assert.match(timeLoop, /v26Steps < 10/, "v26 must cap fixed physics work per rendered frame");
  assert.match(timeLoop, /currentTick <= delayBeforeGame && param1 - lastTime > 250/,
    "a new battlefield must align its application and simulation clocks before the countdown");
  assert.match(timeLoop, /forceEffectCleanup\("lag_budget"\)/, "v26 must terminate effects that exceed the lag budget");
  assert.match(timeLoop, /public function forceEffectCleanup/, "v26 must expose bounded server cleanup");
  assert.match(drill, /properties\.timeout > 0 \? properties\.timeout : 6500/, "v26 Drill must always have a finite lifetime");
  assert.match(timeLoop, /"respawn_player":true/, "respawn must bypass a stalled dead-owner command queue");
  assert.match(timeLoop, /"command":"turn_complete"[\s\S]*?"generation":\(?Boolean\(main\.clientAvatar\)/, "human completion must identify the restored life");
  assert.match(timeLoop, /"command":"bot_turn_complete"[\s\S]*?"generation":\(?Boolean\(Battlefield\.main\.getAvatarByGuid/, "bot completion must identify the restored life");
  assert.match(aiCommands, /if\(this\.serverBot\)[\s\S]*?prevFrameTime = getTimer\(\);[\s\S]*?return;/, "v26 server bots must not run the native action FSM");
  assert.match(foodBowl, /timeLeft > -expireTime/, "v26 food must use an explicit ready interval");
  assert.match(foodProperties, /expireTime:int = 3600/, "v26 food config must expose expiry");
  assert.match(slotMachine, /350 \+ _loc2_ \* 150/, "v26 slot reels must use short staggered timings");
  assert.match(externalCalls, /"command":"local_offer"/, "v26 bank controls must use local offers");
  assert.match(externalCalls, /"command":"member"/, "v26 member purchase must stay local");
  assert.match(externalCalls, /function privateFeatureUnavailable/, "legacy social controls must have a local response");
  assert.match(externalCalls, /"command":"private_feature"/, "legacy social controls must report unsupported actions");
  assert.match(fs.readFileSync(path.join(exportDir, "scripts", "Ballistics.as"), "utf8"),
    /Unavailable on this private server/, "unsupported controls must show an English popup");
  assert.match(makeWeapon, /Boolean\(projectileClass\[type\]\) \? type : \(properties\.baseType == "null" \? type : properties\.baseType\)/,
    "dedicated weapon classes must win over catalogue inheritance");
  assert.match(makeWeapon, /"accorn":"acornschild"[\s\S]*?"accorns":"acornschild"/,
    "all legacy Squirrel spellings must resolve before projectile construction");
  assert.match(makeWeapon, /v26_weapon_rejected reason=missing_properties/,
    "invalid weapon rows must terminate without an AVM2 null dereference");
  assert.match(weaponProperties, /type == "accorn" \|\| type == "accorns" \|\| type == "acornschild"/,
    "the Squirrel icon and ammo must resolve through the real acornschild symbols");
  assert.match(weaponProperties, /return type;/,
    "weapon graphics must keep each catalogue item's own visual identity");
  assert.doesNotMatch(weaponProperties, /return effectiveType/,
    "runtime behavior aliases must never replace weapon graphics");
  assert.doesNotMatch(weaponProperties, /accorns_(?:icon|ammo)/,
    "the movie must not request undefined accorns symbols");
  assert.match(gooShot, /v26_goo_rejected reason=missing_ammo_graphic/,
    "GooShot must reject a missing visual before touching it");
  assert.match(gooShot, /v26_goo_child_rejected/,
    "GooShot must reject an invalid child projectile without dereferencing it");
  assert.match(prizeData, /valid = Boolean\(_loc2_\)/, "PrizeData must tolerate missing weapon rows");
  assert.match(wheel, /Prize Wheel is currently unavailable/, "Prize Wheel must explain an empty or invalid catalogue");
  assert.match(leaderBoard, /pendingPage = _loc3_;[\s\S]*?_loc4_\.command = "leaderboard_fetch"/,
    "leaderboard pages must always refresh");
  assert.match(leaderBoard, /Number\(param1\.revision\) < lastRevision/, "leaderboard must reject stale responses");
  assert.match(leaderBoard, /public function invalidate\(\)/, "match progression must be able to invalidate leaderboard caches");
  assert.match(shopWeapons, /v26HasIcon/, "shop must hide weapons without a real icon");
  assert.match(shopWeapons, /v26ShopWeaponType == "accorn" \|\| v26ShopWeaponType == "accorns"/,
    "shop icon lookup must normalize both legacy Squirrel spellings");
  assert.match(shopWeapons, /modelArray = newArray\.length > 0 \? newArray : group1Array;/,
    "an empty featured shop tab must fall back to supported level-one inventory");
  assert.equal([...movieOther.assetFiles, ...movieOther.assetFiles2]
    .some((asset) => /^accessories_turkiye\.swf(?:\?|$)/i.test(asset)), false,
    "retired TURKIYE accessories must not be loaded");
  assert.equal([...movieOther.assetFiles, ...movieOther.assetFiles2]
    .filter((asset) => /\.swf\?v=/.test(asset))
    .every((asset) => /\?v=[0-9a-f]{12}$/.test(asset)), true,
    "every external SWF must use its content hash as the cache key");
  assert.deepEqual(movieOther.chanceCollections.collectionKeys,
    ["chanceCollection1", "chanceCollection2", "chanceCollection3"],
    "the three original Collection Raffle sets must be restored");
  const turkiyeRows = movieAccessories.filter((item) => /_turkiye_/.test(item.type));
  assert.equal(turkiyeRows.length, 0, "retired TURKIYE objects must not remain in the catalogue");
  const legacyRows = movieAccessories;
  const unsupportedLegacyRows = legacyRows.filter((item) => !item.rendererSupported);
  assert.equal(legacyRows.length, 248, "all legacy accessory rows must remain in the embedded catalogue");
  assert.equal(new Set(legacyRows.filter((item) => item.rendererSupported).map((item) => item.type)).size, 160,
    "exactly 160 unique legacy accessory ids have complete renderer support");
  assert.equal(unsupportedLegacyRows.length, 87,
    "87 legacy rows (86 unique ids because the source has duplicates) must stay hidden");
  assert.equal(new Set(unsupportedLegacyRows.map((item) => item.type)).size, 86,
    "unsupported legacy ownership ids must remain stable");
  assert.match(accessoryProperties, /shopVisible:Boolean = false/);
  assert.match(accessoryProperties, /equipVisible:Boolean = false/);
  assert.match(shopAccessories, /_loc3_\.shopVisible/);
  assert.match(petAccessories, /accessoryProperties\.equipVisible/);
  assert.match(accessoryBonus, /"jump":"% jump"/);
  assert.match(accessoryBonus, /public var jump:Number = 0/);
  assert.match(miniPet, /cosmeticOnly:Boolean = true/);
  assert.match(overlay, /activeNotification\.forceClose\(\)/,
    "Games must keep a single active modal");
  assert.match(collection, /"command":"collection_roll"[\s\S]*?"requestId":pendingRequestId/,
    "Collection Raffle requests must be correlated and server-authoritative");
  assert.match(collectionReel, /v26_collection_reel_rejected reason=no_valid_icons/);
  assert.match(collectionReel, /48 \* _loc5_ \/ 1000/,
    "Collection reel drift must retain its authored 24 Hz speed at 30 Hz");
  assert.match(animalGraphics, /LEGACY_ANIMATION_FPS:Number = 24/);
  assert.match(animalGraphics, /getTimer\(\) - legacyAnimationStartedAt/,
    "avatar timelines must use elapsed real time rather than rendered frame count");
  assert.match(assetLoadView, /pre_flash-turkiye\.png/, "loading screen must use the TURKIYE illustration");
  assert.match(bannerView, /wild-ones-turkiye-banner\.png/, "movie banner must use the TURKIYE logo");
  console.log(`Verified ${path.relative(root, swf)} (${fs.statSync(swf).size} bytes)`);
} finally {
  fs.rmSync(exportDir, { recursive: true, force: true });
}
