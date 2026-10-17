"use strict";

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { V26_MAP_NAMES } = require("../shared/map-manifest.js");
const { buildManifest: buildWeaponAssetManifest } = require("./build-weapon-asset-manifest.js");
const { buildManifest: buildAccessoryAssetManifest } = require("./build-bot-accessory-manifest.js");
const legacyChanceCollections = require("../shared/legacy-chance-collections.json");

const root = path.resolve(__dirname, "..");
const ffdec = process.env.FFDEC_CLI || path.join(root, ".tools", "ffdec", "ffdec-cli.exe");
const baseSwf = path.join(root, "web", "web", "gamewo-v25.swf");
const outputSwf = path.join(root, "web", "web", "gamewo-v26.swf");
const workDir = path.join(root, ".tools", "ruffle-v26-build");
const scriptsDir = path.join(workDir, "scripts");
const importDir = path.join(workDir, "imports");

function run(args) { execFileSync(ffdec, args, { cwd: root, stdio: "inherit" }); }
function read(file) { return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"); }
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }
function copy(from, to) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
function fingerprintAsset(asset) {
  const name = String(asset || "").split("?")[0];
  const file = path.join(root, "web", "assets", name);
  if (!name || !fs.existsSync(file)) return asset;
  const digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 12);
  return `${name}?v=${digest}`;
}
function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, found ${count}`);
  return source.replace(needle, replacement);
}

function patchMaps(file) {
  let source = read(file);
  // FFDec sees both the top-level JSON class and Adobe's decoder after this
  // class participates in importScript, so retain an explicit decoder name.
  write(file, source.replaceAll("JSON.decode(", "com.adobe.serialization.json.JSON.decode("));
}

function patchMapCatalogue() {
  // The lobby must consume exactly the same reward, pet, weapon and map
  // manifests as the web and game services. Replacing the four embedded
  // BinaryData symbols also removes the old commented MapsJSON that Ruffle
  // cannot decode and prevents PrizeData from resolving removed rewards.
  const binaryDir = path.join(workDir, "binary");
  run(["-export", "binaryData", binaryDir, baseSwf]);
  const binaryFiles = fs.readdirSync(binaryDir).map((entry) => path.join(binaryDir, entry));
  const sourceMapBinary = binaryFiles.find((file) =>
    /_Ballistics_MapsJSON\.bin$/i.test(path.basename(file)));
  if (!sourceMapBinary) throw new Error("v26 MapsJSON BinaryData was not found");
  const legacyMapJson = read(sourceMapBinary)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\r\n]*/g, "");
  JSON.parse(legacyMapJson);

  const pets = JSON.parse(read(path.join(root, "web", "assets", "json", "Pets.dat")));
  const weapons = JSON.parse(read(path.join(root, "web", "assets", "json", "WeaponsGrid.dat")));
  const accessories = JSON.parse(read(path.join(root, "web", "assets", "json", "Accessories.dat")));
  const weaponAssetManifest = buildWeaponAssetManifest();
  const accessoryAssetManifest = buildAccessoryAssetManifest();
  for (const accessory of accessories) {
    const support = accessoryAssetManifest.accessories[accessory.type];
    accessory.rendererSupported = Boolean(support && support.rendererSupported);
    accessory.leftSymbolSupported = Boolean(support && support.leftSymbolSupported !== false);
    accessory.shopVisible = Boolean(support && support.shopVisible);
    accessory.equipVisible = Boolean(support && support.equipVisible);
    accessory.rewardEligible = Boolean(support && support.rewardEligible);
    accessory.effectiveType = support && support.effectiveType || accessory.type;
  }
  for (const weapon of weapons) {
    const support = weaponAssetManifest.weapons[weapon.type];
    weapon.runtimeSupported = Boolean(support && support.runtimeSupported);
    weapon.iconSupported = Boolean(support && support.iconSupported);
    weapon.shopVisible = Boolean(support && support.shopVisible);
  }
  const canonicalMaps = JSON.parse(read(path.join(root, "web", "assets", "json", "Maps.dat")));
  const other = JSON.parse(read(path.join(root, "web", "assets", "json", "Other.dat")));
  other.assetFiles = Array.isArray(other.assetFiles) ? other.assetFiles : [];
  other.assetFiles = other.assetFiles.filter((asset) => !/^accessories_turkiye\.swf(?:\?|$)/i.test(String(asset)));
  other.assetFiles2 = (Array.isArray(other.assetFiles2) ? other.assetFiles2 : [])
    .filter((asset) => !/^accessories_turkiye\.swf(?:\?|$)/i.test(String(asset)));
  // External SWFs are cached independently from the main movie. Content
  // hashes prevent an older weaponicons5.swf (with accorns spellings) from
  // surviving a new gamewo build under the legacy v=008 URL.
  other.assetFiles = other.assetFiles.map(fingerprintAsset);
  other.assetFiles2 = other.assetFiles2.map(fingerprintAsset);
  other.chanceCollections = legacyChanceCollections;
  const mapsByName = new Map(canonicalMaps.map((map) => [map && map.name, map]));
  const maps = V26_MAP_NAMES.map((name) => mapsByName.get(name));
  if (maps.some((map) => !map) || maps.length !== V26_MAP_NAMES.length) {
    throw new Error("v26 canonical Maps.dat catalogue is incomplete");
  }
  const petPowers = new Map(pets.map((pet) => [pet.type, pet.petPower]));
  const weaponsByType = new Map(weapons.map((weapon) => [weapon.type, weapon]));
  const requiredPowers = new Map([
    ["bat", "fly"], ["dragon", "spit"], ["werewolf", "howl"],
    ["crocodile", "tailwhip"], ["yeti", "punchsmack"],
    ["sheep", "headbutt"], ["raccoon", "tailspin"]
  ]);
  for (const [pet, power] of requiredPowers) {
    if (petPowers.get(pet) !== power || !weaponsByType.has(power)) {
      throw new Error(`v26 pet power catalogue is incomplete: ${pet}/${power}`);
    }
  }
  const wheelPrizes = other && other.chanceWheel && Array.isArray(other.chanceWheel.prize)
    ? other.chanceWheel.prize
    : [];
  if (!wheelPrizes.length) throw new Error("v26 Prize Wheel catalogue is empty");
  other.chanceWheel.prize = wheelPrizes.filter((prize) => {
    const rewardType = Object.keys(prize && prize.reward || {})[0];
    const support = rewardType && weaponAssetManifest.weapons[rewardType];
    return Boolean(rewardType && weaponsByType.has(rewardType) && support &&
      support.runtimeSupported && support.iconSupported);
  });
  if (!other.chanceWheel.prize.length) {
    throw new Error("v26 Prize Wheel has no asset-backed rewards");
  }

  const cleanOther = path.join(binaryDir, "2909_Ballistics_OtherJSON.v26.bin");
  const cleanPets = path.join(binaryDir, "2912_Ballistics_PetsJSON.v26.bin");
  const cleanWeapons = path.join(binaryDir, "2915_Ballistics_WeaponsGridJSON.v26.bin");
  const cleanAccessories = path.join(binaryDir, "2928_Ballistics_AccessoriesJSON.v26.bin");
  const cleanBinary = path.join(binaryDir, "2932_Ballistics_MapsJSON.v26.bin");
  write(cleanOther, JSON.stringify(other));
  write(cleanPets, JSON.stringify(pets));
  write(cleanWeapons, JSON.stringify(weapons));
  write(cleanAccessories, JSON.stringify(accessories));
  write(cleanBinary, JSON.stringify(maps));
  const otherPatchedSwf = path.join(workDir, "gamewo-v26-other.swf");
  const petPatchedSwf = path.join(workDir, "gamewo-v26-pets.swf");
  const weaponPatchedSwf = path.join(workDir, "gamewo-v26-weapons.swf");
  const accessoryPatchedSwf = path.join(workDir, "gamewo-v26-accessories.swf");
  const mapPatchedSwf = path.join(workDir, "gamewo-v26-maps.swf");
  run(["-replace", baseSwf, otherPatchedSwf, "2909", cleanOther]);
  run(["-replace", otherPatchedSwf, petPatchedSwf, "2912", cleanPets]);
  run(["-replace", petPatchedSwf, weaponPatchedSwf, "2915", cleanWeapons]);
  run(["-replace", weaponPatchedSwf, accessoryPatchedSwf, "2928", cleanAccessories]);
  run(["-replace", accessoryPatchedSwf, mapPatchedSwf, "2932", cleanBinary]);
  return mapPatchedSwf;
}

function patchOwnedMaps(file) {
  let source = read(file);
  source = replaceOnce(source,
    `         if(!lockCrateWeapon)
         {
            for(_loc5_ in _obj.wf)
            {
               _loc6_ = WeaponsOwned.alias[_loc5_];
               if(Boolean(_loc6_) && Boolean(Ballistics.weaponObject[_loc6_]))
               {
                  _loc1_[_loc6_] = 1;
               }
            }
         }
         for(_loc5_ in _obj.allowedMaps)
         {
            _loc1_[_loc5_] = 1;
         }`,
    `         if(!lockCrateWeapon)
         {
            var v26OwnedWeapons:Object = _obj.wf != null ? _obj.wf : _obj.userWeaponsOwned;
            if(v26OwnedWeapons != null)
            {
               for(_loc5_ in v26OwnedWeapons)
               {
                  _loc6_ = WeaponsOwned.alias[_loc5_];
                  if(_loc6_ == null && Boolean(Ballistics.weaponObject[_loc5_]))
                  {
                     _loc6_ = String(_loc5_);
                  }
                  if(Boolean(_loc6_) && Boolean(Ballistics.weaponObject[_loc6_]))
                  {
                     _loc1_[_loc6_] = 1;
                  }
               }
            }
         }
         var v26AllowedMap:String = null;
         if(_obj.allowedMaps is Array)
         {
            for each(v26AllowedMap in _obj.allowedMaps)
            {
               if(v26AllowedMap != null)
               {
                  _loc1_[v26AllowedMap] = 1;
               }
            }
         }
         else
         {
            for(_loc5_ in _obj.allowedMaps)
            {
               _loc1_[_loc5_] = 1;
            }
         }`,
    "v26 owned weapon/map bridge");
  source = replaceOnce(source,
    `         var _loc1_:Array = [];
         for(_loc2_ in _obj.allowedMaps)
         {
            _loc1_.push(_loc2_);
         }`,
    `         var _loc1_:Array = [];
         if(_obj.allowedMaps is Array)
         {
            for each(_loc3_ in _obj.allowedMaps)
            {
               _loc1_.push(_loc3_);
            }
         }
         else
         {
            for(_loc2_ in _obj.allowedMaps)
            {
               _loc1_.push(_loc2_);
            }
         }`,
    "v26 owned map array bridge");
  source = replaceOnce(source,
    `      private function get userWeaponsEquipped() : Array
      {
         var _loc1_:Array = _obj.uwe != null ? _obj.uwe : _obj.userWeaponsEquipped;
         if(_loc1_ == null)
         {
            _loc1_ = Ballistics.defaultWeaponArray == null ? [] : Ballistics.defaultWeaponArray.concat();
         }
         return _loc1_;
      }`,
    `      private function get userWeaponsEquipped() : Array
      {
         var v26RawEquipped:Object = _obj.uwe != null ? _obj.uwe : _obj.userWeaponsEquipped;
         var _loc1_:Array = [];
         var v26EquippedKey:String = null;
         if(v26RawEquipped is Array)
         {
            _loc1_ = v26RawEquipped as Array;
         }
         else if(v26RawEquipped != null)
         {
            for(v26EquippedKey in v26RawEquipped)
            {
               if(v26RawEquipped[v26EquippedKey] != null)
               {
                  _loc1_.push(String(v26RawEquipped[v26EquippedKey]));
               }
            }
         }
         if(_loc1_.length == 0)
         {
            _loc1_ = Ballistics.defaultWeaponArray == null ? [] : Ballistics.defaultWeaponArray.concat();
         }
         return _loc1_;
      }`,
    "v26 object-backed equipped weapons");
  source = replaceOnce(source,
    `            _loc4_ = _obj.ut[_loc3_];
            _loc5_ = WeaponsOwned.alias[_loc4_];
            if(_loc5_ != null && Boolean(Ballistics.weaponObject[_loc5_]))`,
    `            _loc4_ = _obj.ut[_loc3_];
            _loc5_ = WeaponsOwned.alias[_loc4_];
            if(_loc5_ == null && Boolean(Ballistics.weaponObject[_loc4_]))
            {
               _loc5_ = String(_loc4_);
            }
            if(_loc5_ != null && Boolean(Ballistics.weaponObject[_loc5_]))`,
    "v26 canonical weapon unlock bridge");
  source = replaceOnce(source,
    `      public function get hotKeys() : Array
      {
         var _loc1_:Array = _obj.us;
         if(!_loc1_)
         {
            _loc1_ = [];
         }
         return _loc1_;
      }`,
    `      public function get hotKeys() : Array
      {
         if(!(_obj.us is Array))
         {
            return [];
         }
         return _obj.us as Array;
      }`,
    "v26 hotkey array guard");
  write(file, source);
}

function patchBotState(file) {
  let source = read(file);
  source = replaceOnce(source,
    `      private static var requestedAllCommands:Boolean = false;`,
    `      private static var requestedAllCommands:Boolean = false;
      
      private static var lastWorldStateGame:String = "";
      
      private static var lastWorldStateSequence:Number = -1;
      
      private static var lastWorldTerrainRevision:Number = -1;`,
    "v26 world-state ordering");
  source = replaceOnce(source,
    `            case "move_jump":
               if(!_loc5_)
               {
                  return;
               }
               _loc4_.waitingForJump = true;`,
    `            case "world_state":
               if(!_loc3_ || !(param1.players is Array))
               {
                  return;
               }
               var v26WorldGame:String = String(param1.gameId);
               var v26WorldSequence:Number = Number(param1.sequence);
               if(v26WorldGame != lastWorldStateGame)
               {
                  lastWorldStateGame = v26WorldGame;
                  lastWorldStateSequence = -1;
                  lastWorldTerrainRevision = -1;
               }
               if(v26WorldSequence <= lastWorldStateSequence)
               {
                  return;
               }
               lastWorldStateSequence = v26WorldSequence;
               var v26WorldTerrainRevision:Number = Number(param1.terrainRevision);
               if(v26WorldTerrainRevision > lastWorldTerrainRevision && param1.terrain is Array && param1.terrain.length > 0)
               {
                  _loc3_.field.applyServerTerrainEvents(param1.terrain as Array);
                  lastWorldTerrainRevision = v26WorldTerrainRevision;
               }
               var v26WorldStates:Array = param1.players as Array;
               var v26WorldIndex:uint = 0;
               var v26WorldState:Object = null;
               var v26WorldAvatar:Avatar = null;
               while(v26WorldIndex < v26WorldStates.length)
               {
                  v26WorldState = v26WorldStates[v26WorldIndex];
                  v26WorldAvatar = _loc3_.getAvatarByGuid(String(v26WorldState.id));
                  if(Boolean(v26WorldAvatar))
                  {
                     if(Boolean(v26WorldState.dead))
                     {
                        v26WorldAvatar.applyServerHealth(0,Number(v26WorldState.maxHp),Number(v26WorldState.generation),Number(v26WorldState.healthRevision));
                     }
                     else
                     {
                        if(v26WorldAvatar.complete || v26WorldAvatar.isGhost || v26WorldAvatar.hp <= 0)
                        {
                           v26WorldAvatar = _loc3_.respawnPlayer(
                              String(v26WorldState.id),
                              Number(v26WorldState.x),
                              Number(v26WorldState.y),
                              Number(v26WorldState.generation),
                              Number(v26WorldState.hp),
                              Number(v26WorldState.maxHp),
                              "",
                              v26WorldTerrainRevision,
                              false
                           );
                        }
                        if(Boolean(v26WorldAvatar))
                        {
                           v26WorldAvatar.applyServerHealth(Number(v26WorldState.hp),Number(v26WorldState.maxHp),Number(v26WorldState.generation),Number(v26WorldState.healthRevision));
                           if(!v26WorldAvatar.player.isBot)
                           {
                              v26WorldAvatar.applyServerPosition(
                                 Number(v26WorldState.x),
                                 Number(v26WorldState.y),
                                 Number(v26WorldState.generation),
                                 Number(v26WorldState.positionRevision),
                                 !v26WorldAvatar.isClient
                              );
                           }
                        }
                     }
                  }
                  v26WorldIndex++;
               }
               break;
            case "bot_state":
               if(!_loc3_ || !(param1.bots is Array))
               {
                  return;
               }
               var v26BotStates:Array = param1.bots as Array;
               var v26BotIndex:uint = 0;
               var v26BotState:Object = null;
               var v26BotAvatar:Avatar = null;
               while(v26BotIndex < v26BotStates.length)
               {
                  v26BotState = v26BotStates[v26BotIndex];
                  v26BotAvatar = _loc3_.getAvatarByGuid(String(v26BotState.id));
                  if(Boolean(v26BotAvatar) && Boolean(v26BotAvatar.player) && Boolean(v26BotAvatar.player.isBot) && !v26BotAvatar.isGhost && !v26BotAvatar.complete)
                  {
                     v26BotAvatar.applyServerBotSnapshot(Number(v26BotState.x),Number(v26BotState.y),Number(v26BotState.vx),Number(v26BotState.vy));
                     // Position snapshots must never rewrite life state. A
                     // snapshot can overtake locally-rendered blast damage and
                     // visibly add back the exact HP that was just removed.
                     // set_health and respawn_player are the only HP/life
                     // protocols.
                  }
                  v26BotIndex++;
               }
               break;
            case "move_jump":
               if(!_loc5_)
               {
                  return;
               }
               _loc4_.waitingForJump = true;`,
    "v26 bot state protocol");
  source = replaceOnce(source,
    `            case "position":
               if(_loc4_ != null)
               {
                  _loc4_.X = Number(param1.x);
                  _loc4_.Y = Number(param1.y);
               }
               break;`,
    `            case "position":
               if(_loc4_ != null)
               {
                  _loc4_.applyServerPosition(
                     Number(param1.x),
                     Number(param1.y),
                     param1.generation == null ? _loc4_.respawnGeneration : Number(param1.generation),
                     param1.revision == null ? 0 : Number(param1.revision),
                     !_loc4_.isClient
                  );
               }
               break;`,
    "v26 generation-bound position relay");
  write(file, source);
}

function patchAuthoritativeHumanRelay(controlsFile, timeLoopFile, commandProcessorFile) {
  let controls = read(controlsFile);
  controls = replaceOnce(controls,
    `         Battlefield.timeLoop.addCommand(param1);
         if(Boolean(Ballistics.gameConnection))
         {
            Ballistics.gameConnection.sendCommand(param1);
         }`,
    `         if(param1.command == "projectile" && Boolean(Battlefield.main) && Battlefield.main.isMultiPlayerMode && Boolean(Ballistics.gameConnection))
         {
            // Render on the owning movie immediately, then relay this exact
            // launch snapshot to every other renderer.
            param1.generation = Boolean(Battlefield.main.clientAvatar) ? Battlefield.main.clientAvatar.respawnGeneration : 0;
            param1.turnEpoch = Battlefield.main.turnEpoch;
            param1.sourceX = Battlefield.main.clientAvatar.X;
            param1.sourceY = Battlefield.main.clientAvatar.Y;
            param1.sourceVx = Battlefield.main.clientAvatar.Vx;
            param1.sourceVy = Battlefield.main.clientAvatar.Vy;
            param1.angle = Battlefield.main.clientAvatar.trueGunAngle;
            param1.power = Battlefield.main.clientAvatar.firePower;
            Battlefield.timeLoop.addCommand(param1);
            Ballistics.gameConnection.sendCommand(param1);
            return;
         }
         Battlefield.timeLoop.addCommand(param1);
         if(Boolean(Ballistics.gameConnection))
         {
            Ballistics.gameConnection.sendCommand(param1);
         }`,
    "v26 server-echoed human projectile");
  write(controlsFile, controls);

  let timeLoop = read(timeLoopFile);
  timeLoop = replaceOnce(timeLoop,
    `      private var firstMoveError:Boolean = true;`,
    `      private var firstMoveError:Boolean = true;
      
      private var humanPositionSequence:Number = 0;`,
    "v26 human position sequence");
  timeLoop = replaceOnce(timeLoop,
    `         ++currentTick;
         if(clientsTurn && main.isMultiPlayerMode && currentTick % 50 == 0)`,
    `         ++currentTick;
         if(main.isMultiPlayerMode && Boolean(main.clientAvatar) && Boolean(Ballistics.gameConnection) && currentTick % 10 == 0)
         {
            Ballistics.gameConnection.sendCommand({
               "command":"position",
               "id":main.clientAvatar.player.id,
               "x":main.clientAvatar.X,
               "y":main.clientAvatar.Y,
               "vx":main.clientAvatar.Vx,
               "vy":main.clientAvatar.Vy,
               "generation":main.clientAvatar.respawnGeneration,
               "turnEpoch":main.turnEpoch,
               "sequence":++humanPositionSequence,
               "tick":currentTick
            });
         }
         if(clientsTurn && main.isMultiPlayerMode && currentTick % 50 == 0)`,
    "v26 owner position heartbeat");
  write(timeLoopFile, timeLoop);

  let commandProcessor = read(commandProcessorFile);
  commandProcessor = replaceOnce(commandProcessor,
    `            case "projectile":
               if(!_loc5_)
               {
                  return;
               }
               handleProjectile(param1,_loc4_,_loc3_,_loc2_);`,
    `            case "projectile":
               if(!_loc4_ || _loc4_.complete)
               {
                  return;
               }
               // This packet has already passed the server's authenticated
               // active-player, life-generation and turn checks. The local
               // currentTurn flag can lag one render frame behind changeTurn;
               // using it here made a valid canonical shot invisible on one
               // renderer while terrain and health still advanced.
               if(param1.generation != null && Number(param1.generation) != Number(_loc4_.respawnGeneration))
               {
                  return;
               }
               if(param1.sourceX != null && param1.sourceY != null && !isNaN(Number(param1.sourceX)) && !isNaN(Number(param1.sourceY)))
               {
                  _loc4_.X = Number(param1.sourceX);
                  _loc4_.Y = Number(param1.sourceY);
                  _loc4_.Vx = Number(param1.sourceVx);
                  _loc4_.Vy = Number(param1.sourceVy);
                  _loc4_.trueGunAngle = Number(param1.angle);
                  _loc4_.firePower = Number(param1.power);
               }
               handleProjectile(param1,_loc4_,_loc3_,_loc2_);`,
    "v26 canonical projectile launch");
  commandProcessor = replaceOnce(commandProcessor,
    `                           v26WorldAvatar.applyServerHealth(Number(v26WorldState.hp),Number(v26WorldState.maxHp),Number(v26WorldState.generation),Number(v26WorldState.healthRevision));
                           if(!v26WorldAvatar.player.isBot)`,
    `                           v26WorldAvatar.applyServerHealth(Number(v26WorldState.hp),Number(v26WorldState.maxHp),Number(v26WorldState.generation),Number(v26WorldState.healthRevision));
                           v26WorldAvatar.score = Math.max(0,Number(v26WorldState.score));
                           if(!v26WorldAvatar.player.isBot)`,
    "v26 authoritative combat score");
  write(commandProcessorFile, commandProcessor);
}

function patchMapUnavailable(file) {
  let source = read(file);
  source = replaceOnce(source,
    `            case "game_join_failed":
               Ballistics.mainmain.leaveBattlefield();`,
    `            case "map_unavailable":
               Ballistics.mainmain.leaveBattlefield();
               MainView.instance.setPageView("home",true);
               Ballistics.overlayView.alert = "This map is unavailable. Please choose one of the verified maps.";
               break;
            case "game_join_failed":
               Ballistics.mainmain.leaveBattlefield();`,
    "v26 unavailable map recovery");
  write(file, source);
}

function patchServerHealth(file) {
  let source = read(file);
  source = replaceOnce(source,
    `      private var healthSequence:Number = 0;`,
    `      private var healthSequence:Number = 0;
      
      // Server acknowledgements must update the local HUD without being
      // emitted as a new client health report. Without this guard a
      // set_health packet recursively generated another health_state packet
      // (normally marked as a heal), producing visible HP oscillation.
      private var applyingServerHealth:Boolean = false;
      
      private var lastServerHealthRevision:Number = -1;
      
      private var lastServerPositionRevision:Number = -1;
      
      // Server bots use a moving target rather than hard position assignment.
      // This keeps the authoritative collision result while removing the
      // visible 10 Hz snap/teleport between snapshots.
      private var serverBotTargetX:Number = 0;
      
      private var serverBotTargetY:Number = 0;
      
      private var serverBotSnapshotVx:Number = 0;
      
      private var serverBotSnapshotVy:Number = 0;
      
      private var serverBotSnapshotReady:Boolean = false;
      
      private var ghostStartY:Number = 0;`,
    "v26 server health acknowledgement guard");
  source = replaceOnce(source,
    `      public function applyServerHealth(param1:Number, param2:Number, param3:Number) : void`,
    `      public function applyServerBotSnapshot(param1:Number, param2:Number, param3:Number, param4:Number) : void
      {
         if(!serverBotSnapshotReady || Math.abs(param1 - X) > 180 || Math.abs(param2 - Y) > 180)
         {
            X = param1;
            Y = param2;
         }
         serverBotTargetX = param1;
         serverBotTargetY = param2;
         serverBotSnapshotVx = param3;
         serverBotSnapshotVy = param4;
         Vx = param3;
         Vy = param4;
         serverBotSnapshotReady = true;
      }
      
      public function applyServerPosition(param1:Number, param2:Number, param3:Number, param4:Number, param5:Boolean) : void
      {
         if(param3 != this.respawnGeneration || param4 <= this.lastServerPositionRevision)
         {
            return;
         }
         this.lastServerPositionRevision = param4;
         if(!param5 || isGhost || complete)
         {
            return;
         }
         if(Math.abs(param1 - X) > 12 || Math.abs(param2 - Y) > 12)
         {
            X = param1;
            Y = param2;
         }
      }
      
      public function advanceServerBotSnapshot() : void
      {
         if(!serverBotSnapshotReady || isGhost || complete)
         {
            return;
         }
         serverBotTargetX += serverBotSnapshotVx * dt;
         serverBotTargetY += serverBotSnapshotVy * dt;
         X += (serverBotTargetX - X) * 0.35;
         Y += (serverBotTargetY - Y) * 0.35;
      }
      
      public function applyServerHealth(param1:Number, param2:Number, param3:Number, param4:Number = -1) : void`,
    "v26 smooth server bot snapshots");
  source = replaceOnce(source,
    `      public function applyServerHealth(param1:Number, param2:Number, param3:Number, param4:Number = -1) : void
      {
         this.respawnGeneration = param3;
         this.maxHealth = param2;
         this.healthPoints = Math.max(0,Math.min(param2,param1));
      }`,
    `      public function applyServerHealth(param1:Number, param2:Number, param3:Number, param4:Number = -1) : void
      {
         // A set_health record belongs to exactly one life. A delayed death
         // from generation N must never kill the avatar restored as N+1.
         if(param3 != this.respawnGeneration)
         {
            return;
         }
         if(param4 >= 0 && param4 <= this.lastServerHealthRevision)
         {
            return;
         }
         if(param4 >= 0)
         {
            this.lastServerHealthRevision = param4;
         }
         this.maxHealth = param2;
         applyingServerHealth = true;
         if(param1 > 0 && healthPoints <= 0)
         {
            // Only respawn_player may revive a dead avatar. A delayed positive
            // set_health packet must not turn a ghost back into a full-health
            // participant.
            applyingServerHealth = false;
            return;
         }
         this.hp = Math.max(0,Math.min(param2,param1));
         applyingServerHealth = false;
      }
      
      public function applyServerRespawn(param1:Number, param2:Number, param3:Number, param4:Number, param5:Number) : Boolean
      {
         if(param5 < this.respawnGeneration)
         {
            return false;
         }
         this.respawnGeneration = param5;
         this.complete = false;
         this.maxHealth = Math.max(1,param4);
         if(this._isGhost)
         {
            this._isGhost = false;
            if(Boolean(ghostContainer) && contains(ghostContainer))
            {
               removeChild(ghostContainer);
            }
            if(!contains(avatarContainer))
            {
               addChildAt(avatarContainer,0);
            }
         }
         this.filters = [];
         this.controlLayer.visible = true;
         this.X = param1;
         this.Y = param2;
         this.serverBotSnapshotReady = false;
         this.Vx = 0;
         this.Vy = 0;
         this.Va = 0;
         this.shotSpent = false;
         this.waitingForJump = false;
         this.waitingForSuper = false;
         this.healthPoints = Math.max(1,Math.min(this.maxHealth,param3));
         this.lastHealth = this.healthPoints;
         return !this._isGhost && !this.complete && this.healthPoints > 0;
      }`,
    "v26 server health and respawn application");
  source = replaceOnce(source,
    `         if(Y > Battlefield.gameHeight + 10)
         {
            hp = 0;
         }`,
    `         if(Y > Battlefield.gameHeight + 10)
         {
            // Position packets are not guaranteed while a non-active avatar is
            // falling. Emit a dedicated, generation-bound death record before
            // entering ghost state so the server cannot miss the world fall.
            if(isClient && Boolean(main) && main.isMultiPlayerMode && Boolean(Ballistics.gameConnection) && healthPoints > 0)
            {
               Ballistics.gameConnection.sendCommand({
                  "command":"world_fall",
                  "id":player.id,
                  "x":X,
                  "y":Y,
                  "generation":respawnGeneration,
                  "turnEpoch":main.turnEpoch
               });
            }
            hp = 0;
         }`,
    "v26 explicit multiplayer world fall");
  source = replaceOnce(source,
    `         if(this.isClient && Boolean(Ballistics.gameConnection) && Boolean(main))`,
    `         var v26ReportsBotHealth:Boolean = Boolean(this.player) && this.player.isBot && Boolean(main) && main.isMultiPlayerMode && main.nativeBotRendererId == Ballistics.player.id;
         if((this.isClient || v26ReportsBotHealth) && !applyingServerHealth && Boolean(Ballistics.gameConnection) && Boolean(main))`,
    "v26 authoritative bot health reporter");
  source = replaceOnce(source,
    `               "sourceId":this.player.id,
               "reason":(_loc2_ ? "damage" : "heal")`,
    `               "sourceId":Boolean(this.lastDamgeFrom) && Boolean(this.lastDamgeFrom.player) ? this.lastDamgeFrom.player.id : Boolean(main.playOrder) && Boolean(main.playOrder.currentAvatar) ? main.playOrder.currentAvatar.player.id : this.player.id,
               "reason":(_loc2_ ? "damage" : "heal")`,
    "v26 bot damage source");
  source = replaceOnce(source,
    `      public function set climbing(param1:Boolean) : void`,
    `      public function wakeAfterTerrainChange(param1:Number, param2:Number, param3:Number) : void
      {
         if(isGhost || complete || frozen || Boolean(grappling) || jetting)
         {
            return;
         }
         var v26TerrainDX:Number = X - param1;
         var v26TerrainDY:Number = Y - param2;
         var v26WakeRadius:Number = param3 + boundRadius + 6;
         if(v26TerrainDX * v26TerrainDX + v26TerrainDY * v26TerrainDY > v26WakeRadius * v26WakeRadius)
         {
            return;
         }
         var v26Ground:CollisionAverage = main.getCollisionAverage(this,groundPoints,false,false,true,true);
         if(v26Ground.nP == 0)
         {
            if(climbing)
            {
               climbing = false;
            }
            if(digging)
            {
               digging = false;
            }
            waitingForJump = false;
            waitingForSuper = false;
            if(Vy < gravity * dt)
            {
               Vy = gravity * dt;
            }
         }
      }
      
      public function set climbing(param1:Boolean) : void`,
    "v26 wake unsupported avatar");
  write(file, source);
}

function patchBotHealthProtocol(file) {
  let source = read(file);
  const protocolCount = source.split(`"protocol":3`).length - 1;
  if (protocolCount !== 3) {
    throw new Error(`v26 bot health protocol: expected three matches, found ${protocolCount}`);
  }
  source = source.replaceAll(`"protocol":3`, `"protocol":4`);
  write(file, source);
}

function patchRespawnAuthority(battlefieldFile, avatarFile, timeLoopFile) {
  let battlefield = read(battlefieldFile);
  battlefield = replaceOnce(battlefield,
    `      private var respawnGenerations:Object = {};`,
    `      private var respawnGenerations:Object = {};
      
      private var pendingRespawnAcks:Object = {};`,
    "v26 grounded respawn acknowledgement state");
  battlefield = replaceOnce(battlefield,
    `         "alert":true,
         "game_stats":true`,
    `         "alert":true,
         "game_stats":true,
         // These packets are server authority, not echoes of a client input.
         // Their id is intentionally the affected player, including the
         // renderer's own id after taking damage or respawning.
         "set_health":true,
         "respawn_player":true,
         "world_state":true`,
    "v26 authoritative self packet loopback");
  battlefield = replaceOnce(battlefield,
    `               _loc7_ = addPlayerAvatar(_loc6_,_loc10_.x,_loc10_.y);
               if(!balanced)`,
    `               _loc7_ = addPlayerAvatar(_loc6_,_loc10_.x,_loc10_.y);
               if(_loc6_.isBot && isMultiPlayerMode)
               {
                  Ballistics.registerServerBot(_loc6_,game);
               }
               if(!balanced)`,
    "v26 multiplayer bot renderer registration");
  const respawnMethod = battlefield.match(/      public function respawnPlayer\(param1:String, param2:Number, param3:Number, param4:Number, param5:Number, param6:Number\) : Avatar\n      \{[\s\S]*?\n      \}\n      \n      public function explode/);
  if (!respawnMethod) throw new Error("v26 Battlefield respawn method was not found");
  battlefield = battlefield.replace(respawnMethod[0], `      public function respawnPlayer(param1:String, param2:Number, param3:Number, param4:Number, param5:Number, param6:Number, param7:String, param8:Number, param9:Boolean = true) : Avatar
      {
         var v26RespawnAvatar:Avatar = getAvatarByGuid(param1);
         var v26PreviousGeneration:Number = Number(respawnGenerations[param1]);
         if(respawnGenerations.hasOwnProperty(param1) && param4 < v26PreviousGeneration)
         {
            return v26RespawnAvatar;
         }
         if(Boolean(v26RespawnAvatar) && respawnGenerations.hasOwnProperty(param1) && param4 == v26PreviousGeneration && !v26RespawnAvatar.complete && !v26RespawnAvatar.isGhost && v26RespawnAvatar.hp > 0)
         {
            // A duplicate packet is queued again, but it is acknowledged only
            // after the physics body actually touches the current terrain.
            if(!avatars.contains(v26RespawnAvatar))
            {
               avatars.addChild(v26RespawnAvatar);
            }
            timeLoop.addObject(v26RespawnAvatar);
            if(param9)
            {
               queueRespawnAck(param1,param4,param7,param8);
            }
            return v26RespawnAvatar;
         }
         if(!v26RespawnAvatar && Boolean(clientAvatar) && Boolean(clientAvatar.player) && clientAvatar.player.id == param1)
         {
            // A local death can be removed from avatarList one frame before
            // the authoritative packet arrives. Keep the stable clientAvatar
            // reference so the owning renderer can restore and ACK itself.
            v26RespawnAvatar = clientAvatar;
            if(avatarList.indexOf(v26RespawnAvatar) < 0)
            {
               avatarList.push(v26RespawnAvatar);
            }
         }
         if(!v26RespawnAvatar)
         {
            var v26RespawnPlayer:Player = playerSet[param1] as Player;
            if(!v26RespawnPlayer && Boolean(player) && player.id == param1)
            {
               v26RespawnPlayer = player;
               playerSet[param1] = player;
            }
            if(!v26RespawnPlayer)
            {
               return null;
            }
            v26RespawnAvatar = addPlayerAvatar(v26RespawnPlayer,param2,param3);
         }
         respawnGenerations[param1] = param4;
         if(!v26RespawnAvatar.applyServerRespawn(param2,param3,param5,param6,param4))
         {
            return null;
         }
         if(!avatars.contains(v26RespawnAvatar))
         {
            avatars.addChild(v26RespawnAvatar);
         }
         timeLoop.addObject(v26RespawnAvatar);
         if(Boolean(playOrder))
         {
            playOrder.avatarList = avatarList;
            v26RespawnAvatar.currentTurn = playOrder.currentPlayerID == param1;
         }
         if(param9)
         {
            queueRespawnAck(param1,param4,param7,param8);
         }
         return v26RespawnAvatar;
      }
      
      private function queueRespawnAck(param1:String, param2:Number, param3:String, param4:Number) : void
      {
         pendingRespawnAcks[param1] = {
            "generation":param2,
            "respawnToken":param3,
            "terrainRevision":param4
         };
      }
      
      private function processRespawnAcks() : void
      {
         var v26RespawnId:String = null;
         var v26RespawnState:Object = null;
         var v26RespawnAvatar:Avatar = null;
         if(!Boolean(Ballistics.gameConnection))
         {
            return;
         }
         for(v26RespawnId in pendingRespawnAcks)
         {
            v26RespawnState = pendingRespawnAcks[v26RespawnId];
            v26RespawnAvatar = getAvatarByGuid(v26RespawnId);
            if(v26RespawnState == null || v26RespawnAvatar == null ||
               v26RespawnAvatar.complete || v26RespawnAvatar.isGhost ||
               Number(respawnGenerations[v26RespawnId]) != Number(v26RespawnState.generation))
            {
               delete pendingRespawnAcks[v26RespawnId];
            }
            else if(v26RespawnAvatar.isGroundedForRespawn())
            {
               Ballistics.gameConnection.sendCommand({
                  "command":"respawn_ready",
                  "id":v26RespawnId,
                  "generation":v26RespawnState.generation,
                  "respawnToken":v26RespawnState.respawnToken,
                  "terrainRevision":v26RespawnState.terrainRevision,
                  "x":v26RespawnAvatar.X,
                  "y":v26RespawnAvatar.Y,
                  "grounded":true
               });
               delete pendingRespawnAcks[v26RespawnId];
            }
         }
      }
      
      public function explode`);
  battlefield = replaceOnce(battlefield,
    `         var _loc8_:Boolean = timeLoop.process(_loc5_);`,
    `         var _loc8_:Boolean = timeLoop.process(_loc5_);
         processRespawnAcks();`,
    "v26 poll grounded respawn acknowledgements");
  write(battlefieldFile, battlefield);

  let avatar = read(avatarFile);
  avatar = replaceOnce(avatar,
    `      public function set climbing(param1:Boolean) : void`,
    `      public function isGroundedForRespawn() : Boolean
      {
         if(isGhost || complete || Boolean(grappling) || jetting || main == null || main.field == null)
         {
            return false;
         }
         var v26Ground:CollisionAverage = main.getCollisionAverage(this,groundPoints,false,false,true,true);
         return v26Ground.nP > 0 && !main.field.checkCollisionPoint(X,Y - Math.max(8,boundRadius * 0.5));
      }
      
      public function set climbing(param1:Boolean) : void`,
    "v26 grounded respawn probe");
  avatar = replaceOnce(avatar,
    `            ghostTick = timeLoop.currentTick;`,
    `            ghostStartY = Y;
            ghostTick = timeLoop.currentTick;`,
    "v26 capture ghost ascent origin");
  avatar = replaceOnce(avatar,
    `         if(isGhost)
         {
            Y -= 2;
            if(Y < 0)`,
    `         if(isGhost)
         {
            // Reach the sky before the three-second authoritative respawn.
            // Using the death Y as the animation origin gives identical
            // timing whether the avatar died on a platform or below the map.
            var v26GhostProgress:Number = Math.min(1,Math.max(0,(timeLoop.currentTick - ghostTick) * 10 / 2700));
            var v26GhostEase:Number = 1 - (1 - v26GhostProgress) * (1 - v26GhostProgress);
            Y = ghostStartY + (-boundRadius * 2 - ghostStartY) * v26GhostEase;
            if(Boolean(main) && main.isMultiPlayerMode)
            {
               return;
            }
            if(Y < 0)`,
    "v26 suppress multiplayer ghost self-respawn");
  write(avatarFile, avatar);

  let timeLoop = read(timeLoopFile);
  timeLoop = replaceOnce(timeLoop,
    `         "remove_player":true,
         "uph":true`,
    `         "remove_player":true,
         // A dead owner's simulation clock may be paused behind the server
         // tick. Respawn is a life-cycle command and must restore immediately,
         // just like game/player packets, rather than waiting in commandQueue.
         "respawn_player":true,
         "world_state":true,
         "uph":true`,
    "v26 immediate respawn command");
  write(timeLoopFile, timeLoop);
}

function patchServerBotRenderer(timeLoopFile, aiCommandsFile) {
  let timeLoop = read(timeLoopFile);
  timeLoop = replaceOnce(timeLoop,
    `                  "id":aiCom.playerId,
                  "turnEpoch":Battlefield.main.turnEpoch,
                  "controllerEpoch":Battlefield.main.botControllerEpoch`,
    `                  "id":aiCom.playerId,
                  "turnEpoch":Battlefield.main.turnEpoch,
                  "controllerEpoch":Battlefield.main.botControllerEpoch,
                  "generation":Boolean(Battlefield.main.getAvatarByGuid(aiCom.playerId)) ? Battlefield.main.getAvatarByGuid(aiCom.playerId).respawnGeneration : 0`,
    "v26 bot turn completion life identity");
  timeLoop = replaceOnce(timeLoop,
    `               _loc3_ = {
                  "command":"turn_complete",
                  "tick":(int(currentTick + 1)).toString()
               };`,
    `               _loc3_ = {
                  "command":"turn_complete",
                  "tick":(int(currentTick + 1)).toString(),
                  "turnEpoch":main.turnEpoch,
                  "generation":Boolean(main.clientAvatar) ? main.clientAvatar.respawnGeneration : 0
               };`,
    "v26 human turn completion life identity");
  timeLoop = replaceOnce(timeLoop,
    `               else if(!Ballistics.isQA)
               {
                  try
                  {
                     phyObj.step();`,
    `               else if(main.isMultiPlayerMode && phyObj is Avatar && Avatar(phyObj).player.isBot)
               {
                  // bot_state is the sole multiplayer bot physics authority
               }
               else if(!Ballistics.isQA)
               {
                  try
                  {
                     phyObj.step();`,
    "v26 skip local multiplayer bot step");
  timeLoop = replaceOnce(timeLoop,
    `            if(Boolean(phyObj))
            {
               if(!Ballistics.isQA)
               {
                  try
                  {
                     phyObj.move();`,
    `            if(Boolean(phyObj))
            {
               if(main.isMultiPlayerMode && phyObj is Avatar && Avatar(phyObj).player.isBot && !Avatar(phyObj).isGhost)
               {
                  // Collision remains server-owned. Interpolate towards a
                  // velocity-advanced snapshot target; ghost movement falls
                  // through to Avatar.move so its angel ascent still runs.
                  Avatar(phyObj).advanceServerBotSnapshot();
               }
               else if(!Ballistics.isQA)
               {
                  try
                  {
                     phyObj.move();`,
    "v26 extrapolate local multiplayer bot position");
  write(timeLoopFile, timeLoop);

  let aiCommands = read(aiCommandsFile);
  aiCommands = replaceOnce(aiCommands,
    `         Battlefield.main.bigMessage.text = "AI Turn";
         this.turnDelay = getTimer() + Battlefield.timeLoop.delayAfterTurn * TimeLoop.dt;`,
    `         Battlefield.main.bigMessage.text = "AI Turn";
         if(this.serverBot)
         {
            // The server chooses equip/aim/projectile commands. This instance
            // only lets TimeLoop observe when rendered effects have settled.
            prevFrameTime = getTimer();
            return;
         }
         this.turnDelay = getTimer() + Battlefield.timeLoop.delayAfterTurn * TimeLoop.dt;`,
    "v26 disable duplicate native bot FSM");
  write(aiCommandsFile, aiCommands);
}

function patchPhysicsStability(timeLoopFile, commandProcessorFile, drillFile, battlefieldFile) {
  let timeLoop = read(timeLoopFile);
  timeLoop = replaceOnce(timeLoop,
    `                  catch(e:Error)
                  {
                     if(firstStepError)
                     {
                        firstStepError = false;
                        Controls.finishCommand({
                           "command":"out_of_order",
                           "all_commands":["obj.step " + "type: " + phyObj.type + " line:" + phyObj.lineNumber + " " + e.toString()]
                        });
                     }
                  }`,
    `                  catch(e:Error)
                  {
                     if(firstStepError)
                     {
                        firstStepError = false;
                        Controls.finishCommand({
                           "command":"out_of_order",
                           "all_commands":["obj.step " + "type: " + phyObj.type + " line:" + phyObj.lineNumber + " " + e.toString()]
                        });
                     }
                     // A failing projectile must not remain in physicsObjects
                     // forever and hold weaponsComplete on every later frame.
                     if(!(phyObj is Avatar))
                     {
                        phyObj.complete = true;
                     }
                  }`,
    "v26 step error cleanup");
  timeLoop = replaceOnce(timeLoop,
    `                  catch(e:Error)
                  {
                     if(firstMoveError)
                     {
                        firstMoveError = false;
                        trace(e.toString());
                        Controls.finishCommand({
                           "command":"out_of_order",
                           "all_commands":["obj.move " + phyObj.type + e.toString()]
                        });
                     }
                  }`,
    `                  catch(e:Error)
                  {
                     if(firstMoveError)
                     {
                        firstMoveError = false;
                        trace(e.toString());
                        Controls.finishCommand({
                           "command":"out_of_order",
                           "all_commands":["obj.move " + phyObj.type + e.toString()]
                        });
                     }
                     if(!(phyObj is Avatar))
                     {
                        phyObj.complete = true;
                     }
                  }`,
    "v26 move error cleanup");
  timeLoop = replaceOnce(timeLoop,
    `      public function process(param1:Number) : Boolean
      {
         var _loc2_:int = lastCommandTick - currentTick;
         if(currentTick > delayBeforeGame && !gameIsOver)
         {
            notLagging = clientsTurn || _loc2_ < 100 || notLagging && _loc2_ < 200;
         }
         else
         {
            notLagging = true;
         }
         var _loc3_:Boolean = false;
         while(lastTime < param1)
         {
            if(canTick())
            {
               _loc3_ = true;
               oneTick();
            }
            lastTime += notLagging ? dt : dt * 0.25;
         }
         return _loc3_;
      }`,
    `      public function process(param1:Number) : Boolean
      {
         var _loc2_:int = lastCommandTick - currentTick;
         if(currentTick > delayBeforeGame && !gameIsOver)
         {
            notLagging = clientsTurn || _loc2_ < 100 || notLagging && _loc2_ < 200;
         }
         else
         {
            notLagging = true;
         }
         if(lastTime == Number.MAX_VALUE || lastTime > param1)
         {
            lastTime = param1;
         }
         if(currentTick <= delayBeforeGame && param1 - lastTime > 250)
         {
            // A new battlefield reuses the application timer but starts its
            // simulation clock at tick zero. Align the clocks before the
            // countdown so this transition is not reported as physics debt.
            lastTime = param1;
         }
         var _loc3_:Boolean = false;
         var v26Steps:int = 0;
         // At 24 fps four or five 10 ms simulation steps are normal. Ten
         // lets a slow device catch up after a 100 ms hitch without the old
         // 4x unbounded death spiral or a visible slow-motion projectile.
         while(lastTime + dt <= param1 && v26Steps < 10)
         {
            if(canTick())
            {
               _loc3_ = true;
               oneTick();
            }
            lastTime += dt;
            v26Steps++;
         }
         if(param1 - lastTime > 600)
         {
            // Never attempt hundreds of stale physics ticks in one render
            // frame. End the currently blocking effect and resume from now.
            // The budget tolerates ordinary GC/tab hitches on weak clients so
            // their explosions are not cut off mid-flight.
            forceEffectCleanup("lag_budget");
            lastTime = param1;
            Controls.finishCommand({
               "command":"runtime_metrics",
               "reason":"physics_debt",
               "turnEpoch":Boolean(main) ? main.turnEpoch : 0,
               "objects":physicsObjects.length
            });
         }
         if(Boolean(main) && Boolean(main.field))
         {
            main.field.flushTerrainEvents();
         }
         return _loc3_;
      }`,
    "v26 bounded fixed-step loop");
  timeLoop = replaceOnce(timeLoop,
    `      public function removeObject(param1:Physical) : void`,
    `      public function forceEffectCleanup(param1:String = "server") : void
      {
         var v26Index:int = physicsObjects.length - 1;
         var v26Physical:Physical = null;
         var v26Properties:WeaponProperties = null;
         while(v26Index >= 0)
         {
            v26Physical = physicsObjects[v26Index] as Physical;
            if(Boolean(v26Physical) && !(v26Physical is Avatar))
            {
               v26Properties = Ballistics.weaponObject[v26Physical.type];
               if(Boolean(v26Properties) && !v26Properties.allowTurn)
               {
                  try
                  {
                     v26Physical.complete = true;
                  }
                  catch(v26CleanupError:Error)
                  {
                     if(Boolean(v26Physical.parent))
                     {
                        v26Physical.parent.removeChild(v26Physical);
                     }
                  }
                  main.removeOnFrame(v26Physical);
                  physicsObjects.splice(v26Index,1);
               }
            }
            v26Index--;
         }
         if(Boolean(main) && Boolean(main.field))
         {
            main.field.flushTerrainEvents(true);
         }
      }
      
      public function removeObject(param1:Physical) : void`,
    "v26 forced effect cleanup");
  write(timeLoopFile, timeLoop);

  let commandProcessor = read(commandProcessorFile);
  commandProcessor = replaceOnce(commandProcessor,
    `_loc4_.applyServerHealth(Number(param1.hp),Number(param1.maxHp),Number(param1.generation));`,
    `_loc4_.applyServerHealth(Number(param1.hp),Number(param1.maxHp),Number(param1.generation),Number(param1.revision));`,
    "v26 health revision application");
  commandProcessor = replaceOnce(commandProcessor,
    `_loc3_.respawnPlayer(String(param1.id),Number(param1.x),Number(param1.y),Number(param1.generation),Number(param1.hp),Number(param1.maxHp));`,
    `_loc3_.respawnPlayer(String(param1.id),Number(param1.x),Number(param1.y),Number(param1.generation),Number(param1.hp),Number(param1.maxHp),String(param1.respawnToken),Number(param1.terrainRevision));`,
    "v26 respawn acknowledgement token");
  commandProcessor = replaceOnce(commandProcessor,
    `            case "set_health":`,
    `            case "force_effect_cleanup":
               if(Boolean(_loc3_) && Number(param1.turnEpoch) == Number(_loc3_.turnEpoch))
               {
                  _loc2_.forceEffectCleanup(String(param1.reason || "server"));
               }
               break;
            case "set_health":`,
    "v26 force effect cleanup command");
  write(commandProcessorFile, commandProcessor);

  let drill = read(drillFile);
  drill = replaceOnce(drill,
    `         timeToLive = properties.timeout;`,
    `         timeToLive = properties.timeout > 0 ? properties.timeout : 6500;`,
    "v26 drill bounded ttl");
  drill = replaceOnce(drill,
    `         totalTime += dt;
         var _loc1_:Array = main.checkAvatarCollision(X,Y,10);`,
    `         totalTime += dt;
         if(totalTime >= timeToLive)
         {
            complete = true;
            return;
         }
         var _loc1_:Array = main.checkAvatarCollision(X,Y,10);`,
    "v26 drill ttl completion");
  write(drillFile, drill);

  let battlefield = read(battlefieldFile);
  battlefield = replaceOnce(battlefield,
    `         Effects.drawEffect(param3.effect1,param1,param2,_loc12_);
         Effects.drawEffect(param3.effect2,param1,param2,_loc12_);`,
    `         // Drill can cut two hundred adjacent holes. Keep every collision
         // and crater but sample its decorative particles so Ruffle does not
         // allocate hundreds of overlapping MovieClips in the same effect.
         if(param3.type != "drillchild" || timeLoop.currentTick % 4 == 0)
         {
            Effects.drawEffect(param3.effect1,param1,param2,_loc12_);
            Effects.drawEffect(param3.effect2,param1,param2,_loc12_);
         }`,
    "v26 drill particle budget");
  write(battlefieldFile, battlefield);
}

function patchPrizeWheel(prizeDataFile, wheelFile) {
  let prizeData = read(prizeDataFile);
  prizeData = replaceOnce(prizeData,
    `      public var count:int;`,
    `      public var count:int;

      public var valid:Boolean = false;`,
    "v26 prize validity");
  prizeData = replaceOnce(prizeData,
    `         var _loc2_:WeaponProperties = Ballistics.weaponObject[type];
         title = _loc2_.alt + " x" + count.toString();`,
    `         var _loc2_:WeaponProperties = Ballistics.weaponObject[type];
         valid = Boolean(_loc2_);
         title = valid ? _loc2_.alt + " x" + count.toString() : "";`,
    "v26 null-safe prize title");
  write(prizeDataFile, prizeData);

  let wheel = read(wheelFile);
  wheel = replaceOnce(wheel,
    `            _loc7_ = new PrizeData(_loc6_);
            _loc5_ = 0;
            while(_loc5_ < _loc6_.slots)
            {
               _loc3_.push(_loc7_);
               _loc5_++;
            }`,
    `            _loc7_ = new PrizeData(_loc6_);
            if(_loc7_.valid)
            {
               _loc5_ = 0;
               while(_loc5_ < _loc6_.slots)
               {
                  _loc3_.push(_loc7_);
                  _loc5_++;
               }
            }`,
    "v26 invalid Prize Wheel row filter");
  wheel = replaceOnce(wheel,
    `         nItems = _loc3_.length;
         _loc3_ = shuffle(_loc3_);`,
    `         nItems = _loc3_.length;
         if(nItems == 0)
         {
            Ballistics.overlayView.setAlertPopup("Prize Wheel is currently unavailable");
            return;
         }
         _loc3_ = shuffle(_loc3_);`,
    "v26 empty Prize Wheel guard");
  wheel = replaceOnce(wheel,
    `         var _loc2_:PrizeData = new PrizeData(param1);
         isSpecial = _loc2_.special;
         spin(findWinner(_loc2_));`,
    `         var _loc2_:PrizeData = new PrizeData(param1);
         if(!_loc2_.valid)
         {
            Ballistics.overlayView.setAlertPopup("Prize Wheel is currently unavailable");
            return;
         }
         isSpecial = _loc2_.special;
         spin(findWinner(_loc2_));`,
    "v26 invalid Prize Wheel result guard");
  write(wheelFile, wheel);
}

function patchLeaderboardRefresh(file) {
  let source = read(file);
  source = replaceOnce(source,
    `      private var _tableSize:int = 0;`,
    `      private var _tableSize:int = 0;

      private var lastRevision:Number = 0;`,
    "v26 leaderboard revision state");
  source = replaceOnce(source,
    `      public function fetchTableDataSubset(param1:int) : void`,
    `      public function invalidate() : void
      {
         init();
         currentKey = "";
         currentPage = 0;
         pendingKey = "";
         pendingPage = -1;
         currentPlayer = null;
      }

      public function fetchTableDataSubset(param1:int) : void`,
    "v26 leaderboard cache invalidation");
  source = replaceOnce(source,
    `      public function processCommand(param1:Object) : void
      {
         var _loc2_:int = 0;`,
    `      public function processCommand(param1:Object) : void
      {
         var _loc2_:int = 0;
         if(param1.revision != null)
         {
            if(Number(param1.revision) < lastRevision)
            {
               return;
            }
            lastRevision = Number(param1.revision);
         }`,
    "v26 leaderboard stale response guard");
  source = replaceOnce(source, `         if(!playerData[param1])`, `         if(true)`,
    "v26 always refresh leaderboard player");
  source = replaceOnce(source, `         if(!leaderData[param1][_loc3_])`, `         if(true)`,
    "v26 always refresh leaderboard page");
  write(file, source);
}

function patchMatchProgressionRefresh(file) {
  let source = read(file);
  source = replaceOnce(source,
    `            case "leaderboard_return":
               leaderBoard.processCommand(param1);`,
    `            case "private_feature_hidden":
               if(Boolean(overlayView))
               {
                  overlayView.setAlertPopup("Unavailable on this private server");
               }
               break;
            case "match_progression_return":
               if(Boolean(leaderBoard))
               {
                  leaderBoard.invalidate();
               }
               break;
            case "leaderboard_return":
               leaderBoard.processCommand(param1);`,
    "v26 match progression leaderboard invalidation");
  write(file, source);
}

function patchShopWeaponVisibility(file) {
  let source = read(file);
  source = replaceOnce(source,
    `         if(!_loc3_ && !param1.ownedWeapon.properties.petWeapon && (param1.ownedWeapon.properties.memberOnly || param1.ownedWeapon.properties.price != 0))`,
    `         var v26ShopWeaponType:String = String(param1.ownedWeapon.properties.type);
         if(v26ShopWeaponType == "accorn" || v26ShopWeaponType == "accorns")
         {
            v26ShopWeaponType = "acornschild";
         }
         var v26HasIcon:Boolean = Boolean(Ballistics.assets.makeLibraryDisplayObject(v26ShopWeaponType + "_icon"));
         if(!_loc3_ && v26HasIcon && !param1.ownedWeapon.properties.petWeapon && (param1.ownedWeapon.properties.memberOnly || param1.ownedWeapon.properties.price != 0))`,
    "v26 shop icon support filter");
  source = replaceOnce(source,
    `            case CONVEYOR_KEY_NEW:
               modelArray = newArray;
               break;`,
    `            case CONVEYOR_KEY_NEW:
               // Seasonal featured rows may be empty after their authored
               // date window. Keep this tab useful with supported level-one
               // inventory instead of rendering fourteen blank cards.
               modelArray = newArray.length > 0 ? newArray : group1Array;
               break;`,
    "v26 shop new-tab supported fallback");
  write(file, source);
}

function patchTurkiyeBranding(assetLoadViewFile, bannerViewFile) {
  let loading = read(assetLoadViewFile);
  loading = replaceOnce(loading,
    `         var _loc2_:URLRequest = new URLRequest(Common.assetBaseURL + "pre_flash-v23.png");`,
    `         var _loc2_:URLRequest = new URLRequest(Common.assetBaseURL + "pre_flash-turkiye.png");`,
    "v26 TURKIYE loading illustration");
  loading = replaceOnce(loading,
    `         _loc1_.load(_loc2_);
         addChildAt(_loc1_,0);`,
    `         _loc1_.scaleX = 0.5;
         _loc1_.scaleY = 0.5;
         _loc1_.load(_loc2_);
         addChildAt(_loc1_,0);`,
    "v26 high-resolution loading illustration scale");
  loading = loading.replace("v23 loading art unavailable", "TURKIYE loading art unavailable");
  write(assetLoadViewFile, loading);

  let banner = read(bannerViewFile);
  banner = replaceOnce(banner,
    `   import flash.display.SimpleButton;
   import flash.display.Sprite;`,
    `   import flash.display.Loader;
   import flash.display.SimpleButton;
   import flash.display.Sprite;`,
    "v26 banner logo Loader import");
  banner = replaceOnce(banner,
    `   import flash.events.MouseEvent;
   import flash.text.TextField;`,
    `   import flash.events.MouseEvent;
   import flash.net.URLRequest;
   import flash.text.TextField;`,
    "v26 banner logo URLRequest import");
  banner = replaceOnce(banner,
    `         leaderBoard.addEventListener(MouseEvent.MOUSE_DOWN,onLeaderBoard);
         if(Ballistics.totalPlayersOnline > 1)`,
    `         leaderBoard.addEventListener(MouseEvent.MOUSE_DOWN,onLeaderBoard);
         var v26LogoBacking:Sprite = new Sprite();
         v26LogoBacking.graphics.beginFill(bgColor,1);
         v26LogoBacking.graphics.drawRect(0,0,280,50);
         v26LogoBacking.graphics.endFill();
         addChild(v26LogoBacking);
         var v26TurkiyeLogo:Loader = new Loader();
         // 272x88 banner art drawn at half scale: 136x44 inside the 50px bar.
         v26TurkiyeLogo.scaleX = 0.5;
         v26TurkiyeLogo.scaleY = 0.5;
         v26TurkiyeLogo.x = 8;
         v26TurkiyeLogo.y = 3;
         v26TurkiyeLogo.load(new URLRequest("/theme/wild-ones-turkiye-banner.png"));
         addChild(v26TurkiyeLogo);
         if(Ballistics.totalPlayersOnline > 1)`,
    "v26 in-movie TURKIYE logo");
  write(bannerViewFile, banner);
}

function patchWeaponRuntimeClass(file) {
  let source = read(file);
  const resolver = `properties.baseType == "null" ? type : properties.baseType`;
  const count = source.split(resolver).length - 1;
  if (count !== 2) {
    throw new Error(`v26 weapon runtime class resolver: expected two matches, found ${count}`);
  }
  source = source.replaceAll(resolver,
    `Boolean(projectileClass[type]) ? type : (properties.baseType == "null" ? type : properties.baseType)`);
  write(file, source);
}

function patchWeaponSafety(makeWeaponFile, gooShotFile) {
  let makeWeapon = read(makeWeaponFile);
  makeWeapon = replaceOnce(makeWeapon,
    `         var source:Avatar = param6;
         var properties:WeaponProperties = Ballistics.weaponObject[type];
         var classType:String = properties.baseType == "null" ? type : properties.baseType;`,
    `         var source:Avatar = param6;
         var v26WeaponAliases:Object = {
            "accorn":"acornschild",
            "accorns":"acornschild"
         };
         if(v26WeaponAliases[type] != null)
         {
            type = String(v26WeaponAliases[type]);
         }
         if(source == null)
         {
            trace("v26_weapon_rejected reason=missing_source type=" + type);
            return;
         }
         var properties:WeaponProperties = Ballistics.weaponObject[type];
         if(properties == null)
         {
            trace("v26_weapon_rejected reason=missing_properties type=" + type);
            return;
         }
         var classType:String = properties.baseType == "null" ? type : properties.baseType;`,
    "v26 null-safe weapon dispatch");
  write(makeWeaponFile, makeWeapon);

  let gooShot = read(gooShotFile);
  gooShot = replaceOnce(gooShot,
    `         properties = Ballistics.weaponObject[param1];
         gravity = properties.gravity;`,
    `         properties = Ballistics.weaponObject[param1];
         if(properties == null)
         {
            trace("v26_goo_rejected reason=missing_properties type=" + param1);
            complete = true;
            return;
         }
         gravity = properties.gravity;`,
    "v26 goo constructor guard");
  gooShot = replaceOnce(gooShot,
    `         main.explode(X,Y,properties,source);
         if(parent != null && parent.contains(this))`,
    `         if(properties == null || source == null)
         {
            trace("v26_goo_rejected reason=incomplete_state type=" + type);
            if(parent != null && parent.contains(this))
            {
               parent.removeChild(this);
            }
            return;
         }
         main.explode(X,Y,properties,source);
         if(parent != null && parent.contains(this))`,
    "v26 goo completion state guard");
  gooShot = replaceOnce(gooShot,
    `         image = properties.ammoGraphic;
         image.gotoAndStop(1);`,
    `         image = properties.ammoGraphic;
         if(image == null)
         {
            trace("v26_goo_rejected reason=missing_ammo_graphic type=" + param1);
            return;
         }
         image.gotoAndStop(1);`,
    "v26 goo ammo graphic guard");
  gooShot = replaceOnce(gooShot,
    `            MakeWeapon.FireWeapon(properties.childType,X,Y,_loc3_,_loc4_,source);
            _loc1_++;`,
    `            if(properties.childType != null && properties.childType != "null" &&
               Ballistics.weaponObject[properties.childType] != null)
            {
               MakeWeapon.FireWeapon(properties.childType,X,Y,_loc3_,_loc4_,source);
            }
            else
            {
               trace("v26_goo_child_rejected parent=" + type + " child=" + properties.childType);
               break;
            }
            _loc1_++;`,
    "v26 goo child catalog guard");
  write(gooShotFile, gooShot);
}

function patchWeaponGraphicsAliases(file) {
  let source = read(file);
  source = replaceOnce(source,
    `      public function get weaponGraphic() : MovieClip
      {
         var _loc1_:MovieClip = Ballistics.assets.makeLibraryDisplayObject(type + "_weapon") as MovieClip;`,
    `      private function get assetType() : String
      {
         if(type == "accorn" || type == "accorns" || type == "acornschild")
         {
            return "acornschild";
         }
         return type;
      }
      
      private function get fallbackAssetType() : String
      {
         if(baseType == null || baseType == "" || baseType == "null")
         {
            return assetType;
         }
         return baseType;
      }

      public function get weaponGraphic() : MovieClip
      {
         var v26AssetType:String = assetType;
         var v26FallbackAssetType:String = fallbackAssetType;
         var _loc1_:MovieClip = Ballistics.assets.makeLibraryDisplayObject(v26AssetType + "_weapon") as MovieClip;`,
    "v26 weapon graphic alias");
  source = replaceOnce(source,
    `         if(!_loc1_)
         {
            _loc1_ = Ballistics.assets.makeLibraryDisplayObject(type + "_icon") as MovieClip;
         }
         if(!_loc1_)
         {
            _loc1_ = Ballistics.assets.makeLibraryDisplayObject("unknown_weapon") as MovieClip;
         }`,
    `         if(!_loc1_)
         {
            _loc1_ = Ballistics.assets.makeLibraryDisplayObject(v26AssetType + "_icon") as MovieClip;
         }
         if(!_loc1_ && v26FallbackAssetType != v26AssetType)
         {
            _loc1_ = Ballistics.assets.makeLibraryDisplayObject(v26FallbackAssetType + "_weapon") as MovieClip;
         }
         if(!_loc1_)
         {
            _loc1_ = Ballistics.assets.makeLibraryDisplayObject("unknown_weapon") as MovieClip;
         }`,
    "v26 weapon exact-first graphic fallback");
  source = replaceOnce(source,
    `         var _loc1_:MovieClip = Ballistics.assets.makeLibraryDisplayObject(type + "_icon") as MovieClip;`,
    `         var _loc1_:MovieClip = Ballistics.assets.makeLibraryDisplayObject(assetType + "_icon") as MovieClip;`,
    "v26 weapon icon alias");
  source = replaceOnce(source,
    `         var _loc1_:MovieClip = Ballistics.assets.makeLibraryDisplayObject(type + "_ammo") as MovieClip;`,
    `         var v26AssetType:String = assetType;
         var _loc1_:MovieClip = Ballistics.assets.makeLibraryDisplayObject(v26AssetType + "_ammo") as MovieClip;
         if(!_loc1_ && fallbackAssetType != v26AssetType)
         {
            _loc1_ = Ballistics.assets.makeLibraryDisplayObject(fallbackAssetType + "_ammo") as MovieClip;
         }`,
    "v26 weapon ammo alias");
  source = replaceOnce(source,
    `         var _loc1_:MovieClip = Ballistics.assets.makeLibraryDisplayObject(type + "_gun") as MovieClip;`,
    `         var v26AssetType:String = assetType;
         var _loc1_:MovieClip = Ballistics.assets.makeLibraryDisplayObject(v26AssetType + "_gun") as MovieClip;
         if(!_loc1_ && fallbackAssetType != v26AssetType)
         {
            _loc1_ = Ballistics.assets.makeLibraryDisplayObject(fallbackAssetType + "_gun") as MovieClip;
         }`,
    "v26 weapon gun alias");
  write(file, source);
}

function patchAssetManagerAliases(file) {
  let source = read(file);
  source = replaceOnce(source,
    `      public function makeLibraryDisplayObject(param1:String) : DisplayObject
      {
         var _loc2_:Object = null;`,
    `      public function makeLibraryDisplayObject(param1:String) : DisplayObject
      {
         if(param1 == "accorns_icon" || param1 == "accorn_icon")
         {
            param1 = "acornschild_icon";
         }
         else if(param1 == "accorns_ammo" || param1 == "accorn_ammo")
         {
            param1 = "acornschild_ammo";
         }
         var _loc2_:Object = null;`,
    "v26 global acorn asset aliases");
  write(file, source);
}

function patchAvatarSafety(playerFile, avatarFile) {
  let player = read(playerFile);
  player = replaceOnce(player,
    `      public function getPet() : OwnedPet
      {
         return new OwnedPet(_obj.ownedPets[_obj.currentPet]);
      }`,
    `      public function getPet() : OwnedPet
      {
         var v26Pets:Object = _obj != null ? _obj.ownedPets : null;
         var v26Pet:Object = v26Pets != null ? v26Pets[_obj.currentPet] : null;
         var v26PetId:String = null;
         if(v26Pet == null && v26Pets != null)
         {
            for(v26PetId in v26Pets)
            {
               v26Pet = v26Pets[v26PetId];
               break;
            }
         }
         if(v26Pet == null)
         {
            v26Pet = {
               "id":"0",
               "type":"rabbit",
               "name":"Rabbit",
               "gender":"M",
               "pers":"brave",
               "color1":"0x79CBE6",
               "color2":"0xFFFFFF",
               "accessories":[],
               "st":0,
               "de":0,
               "vi":0
            };
         }
         if(v26Pet.accessories == null || !(v26Pet.accessories is Array))
         {
            v26Pet.accessories = [];
         }
         if(Ballistics.chassisObject[v26Pet.type] == null)
         {
            trace("v26_avatar_pet_fallback type=" + v26Pet.type);
            v26Pet.type = "rabbit";
         }
         return new OwnedPet(v26Pet);
      }`,
    "v26 safe active pet");
  write(playerFile, player);

  let avatar = read(avatarFile);
  avatar = replaceOnce(avatar,
    `         var _loc3_:Array = ownedPet.accessories;
         isSam = _loc3_.indexOf("head_sam") != -1`,
    `         if(ownedPet == null)
         {
            ownedPet = new OwnedPet();
         }
         var _loc3_:Array = ownedPet.accessories != null ? ownedPet.accessories : [];
         ownedPet.accessories = _loc3_;
         isSam = _loc3_.indexOf("head_sam") != -1`,
    "v26 avatar owned pet guard");
  avatar = replaceOnce(avatar,
    `               _loc6_ = Ballistics.accessoryObject[_loc3_[_loc5_]];
               if(_loc6_.category == "minipets")`,
    `               _loc6_ = Ballistics.accessoryObject[_loc3_[_loc5_]];
               if(_loc6_ != null && _loc6_.category == "minipets")`,
    "v26 avatar accessory guard");
  avatar = replaceOnce(avatar,
    `         properties = Ballistics.chassisObject[chassis];
         var _loc4_:Object = Ballistics.weaponObject;`,
    `         properties = Ballistics.chassisObject[chassis];
         if(properties == null)
         {
            trace("v26_avatar_chassis_fallback type=" + chassis);
            chassis = "rabbit";
            ownedPet.type = chassis;
            properties = Ballistics.chassisObject[chassis];
         }
         if(properties == null)
         {
            trace("v26_avatar_rejected reason=missing_rabbit_chassis");
            complete = true;
            return;
         }
         var _loc4_:Object = Ballistics.weaponObject;`,
    "v26 avatar chassis guard");
  avatar = replaceOnce(avatar,
    `         player = main.playerSet[param1.player];
         player.color = uint(param1.color);
         ownedPet = new OwnedPet(param1.ownedPet);`,
    `         player = main.playerSet[param1.player];
         var v26SynchPet:Object = param1.ownedPet;
         if(v26SynchPet == null)
         {
            v26SynchPet = {
               "id":"0",
               "type":"rabbit",
               "name":"Rabbit",
               "accessories":[]
            };
         }
         if(v26SynchPet.accessories == null || !(v26SynchPet.accessories is Array))
         {
            v26SynchPet.accessories = [];
         }
         if(Ballistics.chassisObject[v26SynchPet.type] == null)
         {
            v26SynchPet.type = "rabbit";
         }
         if(player == null)
         {
            trace("v26_avatar_player_fallback id=" + param1.player);
            player = new Player({
               "id":param1.player,
               "dname":"Unknown",
               "currentPet":"0",
               "ownedPets":{"0":v26SynchPet},
               "userAccessories":[],
               "userWeaponsOwned":{},
               "userWeaponsEquipped":[],
               "attributes":{}
            });
            main.playerSet[param1.player] = player;
         }
         player.color = uint(param1.color);
         ownedPet = new OwnedPet(v26SynchPet);`,
    "v26 synchronized avatar guard");
  write(avatarFile, avatar);
}

function patchModalAndCollectionRuntime(
  abstractNotificationFile,
  overlayFile,
  gambleFile,
  collectionFile,
  itemBoxFile
) {
  let abstractNotification = read(abstractNotificationFile);
  abstractNotification = replaceOnce(abstractNotification,
    `      public function onContinue(param1:MouseEvent = null) : void
      {
         slideOut();
      }`,
    `      public function forceClose() : void
      {
         removeEventListener(Event.ENTER_FRAME,onSlide,false);
         removeEventListener(Event.ENTER_FRAME,onSpin,false);
         isSliding = false;
         if(parent != null)
         {
            parent.removeChild(this);
         }
      }

      public function onContinue(param1:MouseEvent = null) : void
      {
         slideOut();
      }`,
    "v26 modal force close");
  write(abstractNotificationFile, abstractNotification);

  let overlay = read(overlayFile);
  overlay = replaceOnce(overlay,
    `      private var feedingAvailablePopup:FeedingAvailablePopup;`,
    `      private var activeNotification:AbstractNotificationView;

      private var feedingAvailablePopup:FeedingAvailablePopup;`,
    "v26 active modal state");
  overlay = replaceOnce(overlay,
    `      private function showNotification(param1:AbstractNotificationView) : void
      {
         if(contains(param1))
         {
            removeChild(param1);
         }
         addChild(param1);
         param1.slideIn();
      }`,
    `      private function showNotification(param1:AbstractNotificationView) : void
      {
         if(activeNotification != null && activeNotification != param1)
         {
            activeNotification.forceClose();
         }
         if(contains(param1))
         {
            removeChild(param1);
         }
         activeNotification = param1;
         addChild(param1);
         param1.slideIn();
      }`,
    "v26 single modal stack");
  write(overlayFile, overlay);

  let gamble = read(gambleFile);
  gamble = replaceOnce(gamble,
    `         if(Ballistics.player.isMember)
         {
            Ballistics.overlayView.showCollectionPopup();
            slideOut();
         }`,
    `         if(Ballistics.player.isMember)
         {
            var v26Collections:Object = Ballistics.otherObj != null ?
               Ballistics.otherObj["chanceCollections"] : null;
            if(v26Collections == null || !(v26Collections["collectionKeys"] is Array) ||
               v26Collections["collectionKeys"].length == 0)
            {
               Ballistics.overlayView.setAlertPopup("Collection Raffle is currently unavailable");
               slideOut();
               return;
            }
            Ballistics.overlayView.showCollectionPopup();
         }`,
    "v26 collection availability gate");
  gamble = gamble.replace(
    `         Ballistics.overlayView.showWheelPopup();
         slideOut();`,
    `         Ballistics.overlayView.showWheelPopup();`
  );
  gamble = gamble.replace(
    `         Ballistics.overlayView.showSlotMachine();
         slideOut();`,
    `         Ballistics.overlayView.showSlotMachine();`
  );
  write(gambleFile, gamble);

  let collection = read(collectionFile);
  collection = replaceOnce(collection,
    `      private var tabs:LadderTabs;`,
    `      private var tabs:LadderTabs;

      private var pendingRequestId:String = "";`,
    "v26 collection request id state");
  collection = replaceOnce(collection,
    `            Ballistics.lobbyConnection.sendCommand({
               "command":"collection_roll",
               "setType":type
            });`,
    `            pendingRequestId = type + "-" + new Date().time.toString();
            Ballistics.lobbyConnection.sendCommand({
               "command":"collection_roll",
               "requestId":pendingRequestId,
               "setType":type
            });`,
    "v26 idempotent collection command");
  collection = replaceOnce(collection,
    `      public function processCommand(param1:Object) : void
      {
         var _loc2_:String = null;`,
    `      public function processCommand(param1:Object) : void
      {
         var _loc2_:String = null;
         if(param1.requestId != null && pendingRequestId != "" &&
            String(param1.requestId) != pendingRequestId)
         {
            return;
         }
         pendingRequestId = "";`,
    "v26 collection response correlation");
  write(collectionFile, collection);

  let itemBox = read(itemBoxFile);
  itemBox = replaceOnce(itemBox,
    `         icon = Ballistics.assets.makeLibraryDisplayObject(param1) as MovieClip;
         addChild(icon);
         DrawUtil.fitToRectangle(icon,new Rectangle(10,5,W - 20,H - 10));`,
    `         icon = Ballistics.assets.makeLibraryDisplayObject(param1) as MovieClip;
         if(icon != null)
         {
            addChild(icon);
            DrawUtil.fitToRectangle(icon,new Rectangle(10,5,W - 20,H - 10));
         }
         else
         {
            trace("v26_collection_icon_rejected type=" + param1);
         }`,
    "v26 collection item icon guard");
  write(itemBoxFile, itemBox);
}

function patchAccessoryRuntime(
  propertiesFile,
  shopConveyorFile,
  petConveyorFile,
  bonusFile,
  avatarFile,
  miniPetFile
) {
  let properties = read(propertiesFile);
  properties = replaceOnce(properties,
    `      public var category:String = "";`,
    `      public var category:String = "";
      
      public var rendererSupported:Boolean = false;
      
      public var leftSymbolSupported:Boolean = false;
      
      public var shopVisible:Boolean = false;
      
      public var equipVisible:Boolean = false;
      
      public var rewardEligible:Boolean = false;
      
      public var effectiveType:String = "";
      
      public var newRelease:Boolean = false;
      
      public var cosmeticFollower:Boolean = false;`,
    "v26 accessory asset support fields");
  write(propertiesFile, properties);

  let shop = read(shopConveyorFile);
  shop = replaceOnce(shop,
    `            if(!(_loc3_.price == 0 && _loc3_.memberPrice == 0))
            {`,
    `            if(_loc3_.shopVisible && !(_loc3_.price == 0 && _loc3_.memberPrice == 0))
            {`,
    "v26 shop renderer-backed accessory filter");
  write(shopConveyorFile, shop);

  let pet = read(petConveyorFile);
  pet = replaceOnce(pet,
    `            if(_loc6_ != -1)
            {`,
    `            if(_loc6_ != -1 && _loc5_.accessoryProperties.equipVisible)
            {`,
    "v26 owned accessory renderer filter");
  write(petConveyorFile, pet);

  let bonus = read(bonusFile);
  const invalidBonusCatch = /         catch\(e:Error\)\n         \{\n[\s\S]*?            trace\("Invalid bonus type",bonusKey\);\n         \}/;
  if (!invalidBonusCatch.test(bonus)) {
    throw new Error("v26 accessory bonus FFDec stack cleanup: catch block not found");
  }
  bonus = bonus.replace(invalidBonusCatch,
    `         catch(e:Error)
         {
            trace("Invalid bonus type",bonusKey);
         }`);
  bonus = replaceOnce(bonus,
    `         "gravity":"% gravity"`,
    `         "gravity":"% gravity",
         "jump":"% jump"`,
    "v26 jump bonus label");
  bonus = replaceOnce(bonus,
    `      public var gravity:Number = 0;`,
    `      public var gravity:Number = 0;
      
      public var jump:Number = 0;`,
    "v26 jump bonus property");
  write(bonusFile, bonus);

  let avatar = read(avatarFile);
  avatar = replaceOnce(avatar,
    `         jump = properties.jump;
         maxWalkSpeed = properties.speed * (1 + (bonus.walk_speed + bonusDex) * 0.01);`,
    `         jump = properties.jump * (1 + bonus.jump * 0.01);
         maxWalkSpeed = properties.speed * (1 + (bonus.walk_speed + bonusDex) * 0.01);`,
    "v26 accessory jump impulse");
  write(avatarFile, avatar);

  let miniPet = read(miniPetFile);
  miniPet = replaceOnce(miniPet,
    `      public var properties:Object = {};`,
    `      public var properties:Object = {};
      
      private var cosmeticOnly:Boolean = true;`,
    "v26 cosmetic minipet state");
  miniPet = replaceOnce(miniPet,
    `         properties = Ballistics.miniPetsObject[param1];
         damage = properties.damage;
         pAttack = properties.pAttack;
         pGather = properties.pGather;
         dmgAttack = properties.dmgAttack;
         dmgGather = properties.dmgGather;`,
    `         properties = Ballistics.miniPetsObject != null ? Ballistics.miniPetsObject[param1] : null;
         if(properties == null)
         {
            properties = {
               "damage":0,
               "pAttack":0,
               "pGather":0,
               "dmgAttack":0,
               "dmgGather":0
            };
         }
         damage = 0;
         pAttack = 0;
         pGather = 0;
         dmgAttack = 0;
         dmgGather = 0;`,
    "v26 minipet metadata fallback");
  miniPet = replaceOnce(miniPet,
    `         var _loc4_:MovieClip = Ballistics.assets.makeLibraryDisplayObject(param1) as MovieClip;
         addChild(_loc4_);`,
    `         var _loc4_:MovieClip = Ballistics.assets.makeLibraryDisplayObject(param1) as MovieClip;
         if(_loc4_ != null)
         {
            addChild(_loc4_);
         }
         else
         {
            trace("v26_minipet_graphic_rejected type=" + param1);
         }`,
    "v26 minipet graphic guard");
  miniPet = replaceOnce(miniPet,
    `      public function getCrate() : void
      {
         var _loc3_:Physical = null;`,
    `      public function getCrate() : void
      {
         if(cosmeticOnly)
         {
            return;
         }
         var _loc3_:Physical = null;`,
    "v26 minipet gathering disabled");
  miniPet = replaceOnce(miniPet,
    `      public function gatherItem(param1:MysteryItem) : void
      {
         if(!param1)`,
    `      public function gatherItem(param1:MysteryItem) : void
      {
         if(cosmeticOnly)
         {
            home();
            return;
         }
         if(!param1)`,
    "v26 minipet gather command disabled");
  miniPet = replaceOnce(miniPet,
    `      public function attack(param1:Avatar) : void
      {
         if(!param1)`,
    `      public function attack(param1:Avatar) : void
      {
         if(cosmeticOnly)
         {
            home();
            return;
         }
         if(!param1)`,
    "v26 minipet attack disabled");
  write(miniPetFile, miniPet);
}

function patchCollectionVisualSafety(grandBoxFile, reelFile, prizeFile, finalFile) {
  let grand = read(grandBoxFile);
  grand = replaceOnce(grand,
    `         var _loc4_:MovieClip = Ballistics.assets.makeLibraryDisplayObject(param1) as MovieClip;
         content.addChild(_loc4_);
         DrawUtil.fitToRectangle(_loc4_,new Rectangle(-40,-40,80,80));`,
    `         var _loc4_:MovieClip = Ballistics.assets.makeLibraryDisplayObject(param1) as MovieClip;
         if(_loc4_ == null)
         {
            trace("v26_collection_grand_icon_rejected type=" + param1);
            return;
         }
         content.addChild(_loc4_);
         DrawUtil.fitToRectangle(_loc4_,new Rectangle(-40,-40,80,80));`,
    "v26 collection grand icon guard");
  grand = replaceOnce(grand,
    `         DisplayUtil.removeAllChildren(content);
         for(_loc2_ in param1)`,
    `         DisplayUtil.removeAllChildren(content);
         if(param1 == null)
         {
            return;
         }
         for(_loc2_ in param1)`,
    "v26 collection grand reward guard");
  write(grandBoxFile, grand);

  let reel = read(reelFile);
  reel = replaceOnce(reel,
    `         var _loc4_:uint = iconKeys.length;
         _loc2_ = 0;`,
    `         var _loc4_:uint = iconKeys.length;
         if(_loc4_ == 0)
         {
            drifting = false;
            trace("v26_collection_reel_rejected reason=no_valid_icons");
            return;
         }
         _loc2_ = 0;`,
    "v26 empty collection reel guard");
  reel = replaceOnce(reel,
    `         var _loc2_:int = itemTypes.indexOf(param1);
         drifting = false;`,
    `         var _loc2_:int = itemTypes.indexOf(param1);
         if(_loc2_ < 0 || totalW <= 0)
         {
            isSpinning = false;
            dispatchEvent(new Event(Event.COMPLETE));
            return;
         }
         drifting = false;`,
    "v26 collection reel target guard");
  reel = replaceOnce(reel,
    `      private var then:Date;
      
      private var xFinal:Number = 0;`,
    `      private var then:Date;
      
      private var lastPresentationTime:Number = 0;
      
      private var xFinal:Number = 0;`,
    "v26 collection reel presentation clock");
  reel = replaceOnce(reel,
    `         addEventListener(Event.ENTER_FRAME,onFrame,false,0,true);`,
    `         lastPresentationTime = new Date().time;
         addEventListener(Event.ENTER_FRAME,onFrame,false,0,true);`,
    "v26 collection reel initial presentation time");
  reel = replaceOnce(reel,
    `         var _loc4_:Number = NaN;
         if(isSpinning)
         {
            _loc2_ = new Date();
            _loc3_ = _loc2_.time - then.time;`,
    `         var _loc4_:Number = NaN;
         var _loc5_:Number = NaN;
         _loc2_ = new Date();
         _loc5_ = Math.max(0,Math.min(100,_loc2_.time - lastPresentationTime));
         lastPresentationTime = _loc2_.time;
         if(isSpinning)
         {
            _loc3_ = _loc2_.time - then.time;`,
    "v26 collection reel delta time");
  reel = replaceOnce(reel,
    `         else if(drifting)
         {
            setX(xLast - 2,false);
         }`,
    `         else if(drifting)
         {
            setX(xLast - 48 * _loc5_ / 1000,false);
         }`,
    "v26 collection reel frame-rate independent drift");
  write(reelFile, reel);

  for (const [file, label] of [[prizeFile, "prize"], [finalFile, "final"]]) {
    let source = read(file);
    source = replaceOnce(source,
      `         var _loc4_:MovieClip = Ballistics.assets.makeLibraryDisplayObject(param1) as MovieClip;
         content.addChild(_loc4_);
         DrawUtil.fitToRectangle(_loc4_,new Rectangle(-75,-75,150,150));`,
      `         var _loc4_:MovieClip = Ballistics.assets.makeLibraryDisplayObject(param1) as MovieClip;
         if(_loc4_ == null)
         {
            trace("v26_collection_${label}_icon_rejected type=" + param1);
            return;
         }
         content.addChild(_loc4_);
         DrawUtil.fitToRectangle(_loc4_,new Rectangle(-75,-75,150,150));`,
      `v26 collection ${label} icon guard`);
    source = replaceOnce(source,
      `         DisplayUtil.removeAllChildren(content);
         for(_loc2_ in param1)`,
      `         DisplayUtil.removeAllChildren(content);
         if(param1 == null)
         {
            return;
         }
         for(_loc2_ in param1)`,
      `v26 collection ${label} reward guard`);
    write(file, source);
  }
}

function patchLegacyAnimationClock(file) {
  let source = read(file);
  source = replaceOnce(source,
    `   import flash.utils.Timer;`,
    `   import flash.utils.Timer;
   import flash.utils.getTimer;`,
    "v26 animal animation wall clock import");
  source = replaceOnce(source,
    `      private var completeNextFrame:Boolean = false;
      
      private var _animation:String = "_idle";`,
    `      private var completeNextFrame:Boolean = false;
      
      private var legacyAnimationStartedAt:int = 0;
      
      private var legacyAnimationFrame:int = 1;
      
      private static const LEGACY_ANIMATION_FPS:Number = 24;
      
      private var _animation:String = "_idle";`,
    "v26 animal animation clock fields");
  source = replaceOnce(source,
    `         assets = _loc3_;
         setColors(color1,color2);`,
    `         assets = _loc3_;
         assets.stop();
         completeNextFrame = false;
         legacyAnimationStartedAt = getTimer();
         legacyAnimationFrame = 1;
         assets.gotoAndStop(1);
         setColors(color1,color2);`,
    "v26 animal animation clock reset");
  source = replaceOnce(source,
    `      public function onFrame(param1:Event = null) : void
      {
         var _loc4_:Number = NaN;`,
    `      private function syncLegacyChildren(param1:DisplayObjectContainer, param2:int) : void
      {
         var _loc3_:int = 0;
         var _loc4_:DisplayObject = null;
         var _loc5_:MovieClip = null;
         var _loc6_:int = 0;
         if(param1 == null)
         {
            return;
         }
         _loc3_ = 0;
         while(_loc3_ < param1.numChildren)
         {
            _loc4_ = param1.getChildAt(_loc3_);
            _loc5_ = _loc4_ as MovieClip;
            if(Boolean(_loc5_) && _loc5_ != assets && _loc5_.totalFrames > 1)
            {
               // gotoAndStop rebuilds the clip's display list in Ruffle even
               // when the frame is unchanged; most nested parts already sit on
               // the target frame, so only move the ones that differ.
               _loc6_ = (param2 - 1) % _loc5_.totalFrames + 1;
               _loc5_.stop();
               if(_loc5_.currentFrame != _loc6_)
               {
                  _loc5_.gotoAndStop(_loc6_);
               }
            }
            if(_loc4_ is DisplayObjectContainer && DisplayObjectContainer(_loc4_).numChildren > 0)
            {
               syncLegacyChildren(_loc4_ as DisplayObjectContainer,param2);
            }
            _loc3_++;
         }
      }
      
      private function advanceLegacyAnimation() : void
      {
         var _loc1_:int = 0;
         var _loc2_:int = 0;
         if(assets == null || assets.totalFrames <= 0)
         {
            return;
         }
         _loc1_ = int((getTimer() - legacyAnimationStartedAt) * LEGACY_ANIMATION_FPS / 1000) + 1;
         if(onCompleteLoad == "")
         {
            _loc2_ = (_loc1_ - 1) % assets.totalFrames + 1;
         }
         else
         {
            _loc2_ = Math.min(_loc1_,assets.totalFrames);
         }
         if(_loc2_ != legacyAnimationFrame)
         {
            legacyAnimationFrame = _loc2_;
            assets.gotoAndStop(_loc2_);
            syncLegacyChildren(assets,_loc1_);
         }
         if(onCompleteLoad != "" && _loc1_ > assets.totalFrames)
         {
            completeNextFrame = true;
         }
      }
      
      public function onFrame(param1:Event = null) : void
      {
         var _loc4_:Number = NaN;`,
    "v26 animal animation wall clock");
  source = replaceOnce(source,
    `         if(Boolean(assets) && assets.currentFrame == assets.totalFrames)
         {
            completeNextFrame = true;
         }
         var _loc2_:Point = defLH.clone();`,
    `         advanceLegacyAnimation();
         var _loc2_:Point = defLH.clone();`,
    "v26 animal animation completion");
  write(file, source);
}

function patchPetMeleeRuntime(makeWeaponFile, avatarFile) {
  let makeWeapon = read(makeWeaponFile);
  makeWeapon = replaceOnce(makeWeapon,
    `               if(source.properties.type != "panda")
               {
                  return;
               }
               source.processPunch();`,
    `               // The normal punch remains panda-only, while typed pet
               // melee powers are validated against the active pet by server.
               if(type == "punch" && source.properties.type != "panda")
               {
                  return;
               }
               source.processPunch();`,
    "v26 typed pet melee chassis gate");
  makeWeapon = replaceOnce(makeWeapon,
    `            source.processPunch();`,
    `            source.processPunch(type);`,
    "v26 typed pet melee dispatch");
  write(makeWeaponFile, makeWeapon);

  let avatar = read(avatarFile);
  avatar = replaceOnce(avatar,
    `      public function processPunch() : void`,
    `      public function processPunch(param1:String = "punch") : void`,
    "v26 typed pet melee signature");
  avatar = replaceOnce(avatar,
    `Ballistics.weaponObject["punch"]`,
    `Ballistics.weaponObject[param1] != null ? Ballistics.weaponObject[param1] : Ballistics.weaponObject["punch"]`,
    "v26 typed pet melee properties");
  write(avatarFile, avatar);
}

function patchPetCarouselRuntime(file) {
  let source = read(file);
  source = replaceOnce(source,
    `         super(_loc1_,objectToArray(_loc1_.ownedPets));
      }`,
    `         super(_loc1_,objectToArray(_loc1_.ownedPets));
         // The original only rotated after a later player CHANGE event, so
         // opening My Pets initially focused the first object key.
         rotateToCurrentPet();
      }`,
    "v26 initial active pet carousel focus");
  write(file, source);
}

function patchPetPowerIconRuntime(file) {
  let source = read(file);
  source = replaceOnce(source,
    `         else
         {
            icon = Ballistics.assets.makeLibraryDisplayObject(param1 + "_icon") as Sprite;
            if(Boolean(icon))
            {
               addChild(icon);
            }
         }`,
    `         else
         {
            var v26IconAliases:Object = {
               "accorn":"acornschild",
               "accorns":"acornschild",
               "acornschild":"acornschild",
               "spit":"fireball",
               "howl":"mortar",
               "tailwhip":"crocodilewhip",
               "punchsmack":"punch",
               "headbutt":"punch",
               "tailspin":"punch"
            };
            var v26IconType:String = v26IconAliases[param1] != null ? String(v26IconAliases[param1]) : param1;
            icon = Ballistics.assets.makeLibraryDisplayObject(v26IconType + "_icon") as Sprite;
            if(!icon && v26IconType != param1)
            {
               icon = Ballistics.assets.makeLibraryDisplayObject(param1 + "_icon") as Sprite;
            }
            if(!icon)
            {
               icon = Ballistics.assets.makeLibraryDisplayObject("punch_icon") as Sprite;
            }
            if(Boolean(icon))
            {
               addChild(icon);
            }
         }`,
    "v26 pet power icon aliases");
  write(file, source);
}

function patchLeaderboardPlayerDetails(file) {
  let source = read(file);
  source = replaceOnce(source,
    `         yourPet = new AnimalGraphics(player.getPet(),null);
         yourPet.x = 160;`,
    `         yourPet = new AnimalGraphics(player.getPet(),null);
         var v26Games:int = player.gamecount;
         var v26WinRate:Number = v26Games > 0 ? Math.round(player.wins * 1000 / v26Games) / 10 : 0;
         var v26Details:TextField = FontUtil.createLabel(
            "GAMES " + v26Games + "  WINS " + player.wins + "  LOSSES " + player.losses +
            "\\nKILLS " + player.kills + "  DEATHS " + player.deaths + "  WIN " + v26WinRate + "%",
            12,16777215,false,230,32,this
         );
         v26Details.antiAliasType = AntiAliasType.NORMAL;
         yourPet.x = 160;`,
    "v26 leaderboard selected-player details");
  write(file, source);
}

function patchLobbyPurchaseResponses(file) {
  let source = read(file);
  source = replaceOnce(source,
    `            case "accessoryPurchase":
               overlayView.setAccessoryPurchasePopup(param1.type);
               MedalManager.handleAccessoryBought();
               break;
            case "ammoPurchase":
               break;
            case "petPurchase":
               overlayView.setPetPurchasePopup(param1.type);
               break;`,
    `            case "accessoryPurchase":
               if(param1.value === true)
               {
                  overlayView.setAccessoryPurchasePopup(param1.type);
                  MedalManager.handleAccessoryBought();
               }
               else
               {
                  overlayView.setAlertPopup("Purchase failed: " + String(param1.reason));
               }
               break;
            case "ammoPurchase":
               if(param1.value === true)
               {
                  overlayView.setAlertPopup("Ammo purchased.");
               }
               else
               {
                  overlayView.setAlertPopup("Purchase failed: " + String(param1.reason));
               }
               break;
            case "petPurchase":
               if(param1.value === true)
               {
                  overlayView.setPetPurchasePopup(param1.type);
               }
               else
               {
                  overlayView.setAlertPopup("Purchase failed: " + String(param1.reason));
               }
               break;
            case "mapPurchase":
               overlayView.setAlertPopup(param1.value === true ? "Map purchased." : "Purchase failed: " + String(param1.reason));
               break;`,
    "v26 authoritative purchase responses");
  source = replaceOnce(source,
    `            case "join":
               trace("join command Ballistics.as");`,
    `            case "room_settings":
               // Informational acknowledgement of the resolved Any/capacity
               // choices. The following join packet owns the actual room view.
               break;
            case "game_join_failed":
               QuickPlayLobby.instance.onShowGameRoomLobby();
               overlayView.setAlertPopup("Unable to join game: " + String(command.code));
               break;
            case "join":
               trace("join command Ballistics.as");`,
    "v26 lobby join failure response");
  write(file, source);
}

function addPurchaseRequestId(source, commandLine, commandVariable, label) {
  return replaceOnce(source,
    commandLine,
    `${commandLine}
               ${commandVariable}.requestId = String(new Date().time) + "-" + String(Math.random());`,
    label);
}

function patchPurchaseControllers(accessoryFile, petFile, mapFile, featuredFile, loadoutFile) {
  let accessory = read(accessoryFile);
  accessory = addPurchaseRequestId(accessory,
    `               _loc6_.category = accessorySelected.accessoryProperties.category;`,
    "_loc6_",
    "v26 accessory request id");
  accessory = replaceOnce(accessory,
    `               _loc5_.hidePopUp();
               _loc5_.dispatchEvent(new PurchaseEvent(PurchaseEvent.BOUGHT_ITEM,_loc4_));`,
    `               // Keep the confirmation open until accessoryPurchase.value
               // arrives from the authoritative server.`,
    "v26 accessory optimistic success removal");
  write(accessoryFile, accessory);

  let pet = read(petFile);
  pet = addPurchaseRequestId(pet,
    `               _loc6_.color2 = _loc1_.getDetailColor();`,
    "_loc6_",
    "v26 pet request id");
  pet = replaceOnce(pet,
    `               _loc1_.exitCustomizationMode();
               _loc1_.dispatchEvent(new PurchaseEvent(PurchaseEvent.BOUGHT_PET,_loc4_,_loc5_));`,
    `               // petPurchase.value controls the success popup and the
               // profile packet controls the owned-pet carousel.`,
    "v26 pet optimistic success removal");
  write(petFile, pet);

  let map = read(mapFile);
  map = addPurchaseRequestId(map,
    `            _loc5_.mapName = _loc4_;`,
    "_loc5_",
    "v26 map request id");
  map = replaceOnce(map,
    `            _loc6_ = {"mapName":_loc4_};
            ExternalCalls.viral(ExternalCalls.MAP_PURCHASED,_loc6_);`,
    `            // mapPurchase.value is the only purchase confirmation.`,
    "v26 map optimistic success removal");
  write(mapFile, map);

  let featured = read(featuredFile);
  const featuredSend = `               Ballistics.lobbyConnection.sendCommand(_loc8_);`;
  const featuredCount = featured.split(featuredSend).length - 1;
  if (featuredCount !== 2) {
    throw new Error(`v26 featured purchase request ids: expected two matches, found ${featuredCount}`);
  }
  featured = featured.replaceAll(featuredSend,
    `               _loc8_.requestId = String(new Date().time) + "-" + String(Math.random());
${featuredSend}`);
  featured = featured.replace(`               buyVisible = false;\n`, "");
  write(featuredFile, featured);

  let loadout = read(loadoutFile);
  loadout = addPurchaseRequestId(loadout,
    `               _loc4_.ammoCount = shotsCount;`,
    "_loc4_",
    "v26 loadout ammo request id");
  loadout = replaceOnce(loadout,
    `               onCloseWeaponPopupClick();
               cashLabel.text = Formatter.commaCoder(String(_loc2_ - _loc3_));`,
    `               // Keep the purchase panel and displayed balance unchanged
               // until ammoPurchase.value arrives from the server.`,
    "v26 loadout optimistic balance removal");
  write(loadoutFile, loadout);
}

function patchFoodState(foodBowlFile, foodPropertiesFile) {
  let bowl = read(foodBowlFile);
  bowl = replaceOnce(bowl,
    `         return Ballistics.petFoodObject[foodType].expireTime * 1000;`,
    `         return Number(Ballistics.petFoodObject[foodType].expireTime || 3600) * 1000;`,
    "v26 food expiry default");
  bowl = replaceOnce(bowl,
    `         else if(timeLeft > -expireTime || prepTime == 0)`,
    `         else if(timeLeft > -expireTime || expireTime == 0)`,
    "v26 food ready interval");
  write(foodBowlFile, bowl);

  let properties = read(foodPropertiesFile);
  properties = replaceOnce(properties,
    `      public var expireTime:int = 86400;`,
    `      public var expireTime:int = 3600;`,
    "v26 food expiry property");
  write(foodPropertiesFile, properties);
}

function patchSlotMachine(file) {
  let source = read(file);
  // FFDec emits two AVM2 stack pseudo-operations for this legacy class.
  // Reconstruct their ordinary AS3 equivalents before importing the timing
  // patch; without this cleanup the whole SWF import is rejected.
  source = replaceOnce(source,
    `         §§push(creditsPlayedLED);
         §§push(creditsPlayedLED);
         var _temp_2:* = _loc5_;
         §§pop().scaleX = §§pop().scaleY = _loc5_;`,
    `         creditsPlayedLED.scaleX = creditsPlayedLED.scaleY = _loc5_;`,
    "v26 slot FFDec stack cleanup");
  source = replaceOnce(source,
    `            var _loc3_:* = §§findproperty(bet);`,
    `            var _loc3_:* = this;`,
    "v26 slot FFDec property cleanup");
  source = replaceOnce(source,
    `                  strips[_loc2_].spinTo(param1[_loc3_],1000 + Number(_loc2_) * 500);`,
    `                  strips[_loc2_].spinTo(param1[_loc3_],350 + Number(_loc2_) * 150);`,
    "v26 slot reel timing");
  write(file, source);
}

function patchFieldRenderer(file) {
  let source = read(file);
  source = replaceOnce(source,
    `package com.playdom.ballistics.game
{
   import flash.display.Bitmap;`,
    `package com.playdom.ballistics.game
{
   import com.playdom.ballistics.avatar.Avatar;
   import com.playdom.ballistics.physical.CollisionAverage;
   import flash.display.Bitmap;`,
    "v26 field collision import");
  source = replaceOnce(source,
    `      private var foregroundBitmap:Bitmap;
      `,
    `      private var foregroundBitmap:Bitmap;
      
      private var applyingSynchronization:Boolean = false;
      
      private var pendingTerrainEvents:Array = [];
      
      private var terrainBatchSequence:int = 0;
      
      private var lastTerrainFlushTick:int = -100;
      
      private var foregroundDirty:Boolean = false;
      `,
    "v26 terrain synchronization guard");
  source = replaceOnce(source,
    `         this.explosionMasks = [];
         if(this.explosionRecord.length > 0)`,
    `         this.explosionMasks = [];
         this.applyingSynchronization = true;
         if(this.explosionRecord.length > 0)`,
    "v26 terrain replay guard start");
  source = replaceOnce(source,
    `         for each(exp in synch.explosions)
         {
            this.explode(MathUtil.string2Number(exp[0]),MathUtil.string2Number(exp[1]),MathUtil.string2Number(exp[2]));
         }
      }`,
    `         for each(exp in synch.explosions)
         {
            this.explode(MathUtil.string2Number(exp[0]),MathUtil.string2Number(exp[1]),MathUtil.string2Number(exp[2]));
         }
         this.applyingSynchronization = false;
      }`,
    "v26 terrain replay guard end");
  const explodeMethod = source.match(/      public function explode\(X:Number, Y:Number, R:Number\) : void\n      \{[\s\S]*?\n      \}\n      \n      public function get synchronization/);
  if (!explodeMethod) throw new Error("v26 Field.explode was not found");
  source = source.replace(explodeMethod[0], `      private function clearExplosionCircle(target:BitmapData, X:Number, Y:Number, R:Number, lockTarget:Boolean = true) : void
      {
         if(!target)
         {
            return;
         }
         var r2:Number = R * R;
         var startY:int = Math.max(0,Math.floor(Y - R));
         var endY:int = Math.min(target.height - 1,Math.ceil(Y + R));
         var py:int = 0;
         var dy:Number = 0;
         var halfWidth:Number = 0;
         var rowStart:int = 0;
         var rowEnd:int = 0;
         var rowRect:Rectangle = new Rectangle();
         if(lockTarget)
         {
            target.lock();
         }
         py = startY;
         while(py <= endY)
         {
            dy = py - Y;
            halfWidth = Math.sqrt(Math.max(0,r2 - dy * dy));
            rowStart = Math.max(0,Math.floor(X - halfWidth));
            rowEnd = Math.min(target.width - 1,Math.ceil(X + halfWidth));
            if(rowEnd >= rowStart)
            {
               // Rectangle.setTo is unavailable in the Flash runtime targeted
               // by this movie. Ruffle raises #1069 here and aborts weapon
               // completion on every frame, so use legacy-compatible fields.
               rowRect.x = rowStart;
               rowRect.y = py;
               rowRect.width = rowEnd - rowStart + 1;
               rowRect.height = 1;
               target.fillRect(rowRect,0);
            }
            py++;
         }
         if(lockTarget)
         {
            target.unlock();
         }
      }
      
      public function explode(X:Number, Y:Number, R:Number) : void
      {
         if(R <= 1)
         {
            return;
         }
         this.explosionRecord.push([MathUtil.number2String(X),MathUtil.number2String(Y),MathUtil.number2String(R)]);
         this.clearExplosionCircle(this.bitmapData,X,Y,R);
         // Carve the visible layer in the same tick as the collision mask so
         // a crater never looks solid while avatars already fall through it.
         this.clearExplosionCircle(this.foregroundBitmapData,X,Y,R);
         if(this.applyingSynchronization)
         {
            this.foregroundBitmap.bitmapData = this.foregroundBitmapData;
            return;
         }
         this.foregroundDirty = true;
         var v26WakeAvatar:Avatar = null;
         if(Boolean(this.main) && Boolean(this.main.avatarList))
         {
            for each(v26WakeAvatar in this.main.avatarList)
            {
               if(Boolean(v26WakeAvatar))
               {
                  v26WakeAvatar.wakeAfterTerrainChange(X,Y,R);
               }
            }
         }
         this.pendingTerrainEvents.push([X,Y,R]);
      }
      
      public function flushTerrainEvents(force:Boolean = false) : void
      {
         if(this.foregroundDirty)
         {
            // One display refresh per rendered frame, however many craters.
            this.foregroundDirty = false;
            this.foregroundBitmap.bitmapData = this.foregroundBitmapData;
         }
         if(this.pendingTerrainEvents.length == 0)
         {
            return;
         }
         // timeLoop belongs to Battlefield as a static singleton. Reading it
         // through main raises AVM2 #1069 and aborts the entire frame loop.
         var currentTick:int = Boolean(Battlefield.timeLoop) ? Battlefield.timeLoop.currentTick : 0;
         if(!force && this.pendingTerrainEvents.length < 64 && currentTick - this.lastTerrainFlushTick < 10)
         {
            return;
         }
         var count:int = Math.min(64,this.pendingTerrainEvents.length);
         var batch:Array = this.pendingTerrainEvents.splice(0,count);
         this.lastTerrainFlushTick = currentTick;
         if(Boolean(Ballistics.gameConnection) && Boolean(this.main) && this.main.isMultiPlayerMode)
         {
            this.terrainBatchSequence++;
            Ballistics.gameConnection.sendCommand({
               "command":"terrain_explosion_batch",
               "batchSeq":this.terrainBatchSequence,
               "explosions":batch,
               "turnEpoch":this.main.turnEpoch
            });
         }
         if(force && this.pendingTerrainEvents.length > 0)
         {
            this.flushTerrainEvents(true);
         }
      }
      
      public function applyServerTerrainEvents(param1:Array) : void
      {
         if(param1 == null || param1.length == 0 || !this.bitmapData || !this.foregroundBitmapData)
         {
            return;
         }
         var v26ServerEvent:Array = null;
         var v26ServerAvatar:Avatar = null;
         this.bitmapData.lock();
         this.foregroundBitmapData.lock();
         for each(v26ServerEvent in param1)
         {
            if(v26ServerEvent == null || v26ServerEvent.length < 3)
            {
               continue;
            }
            this.clearExplosionCircle(this.bitmapData,Number(v26ServerEvent[0]),Number(v26ServerEvent[1]),Number(v26ServerEvent[2]),false);
            this.clearExplosionCircle(this.foregroundBitmapData,Number(v26ServerEvent[0]),Number(v26ServerEvent[1]),Number(v26ServerEvent[2]),false);
         }
         this.bitmapData.unlock();
         this.foregroundBitmapData.unlock();
         this.foregroundBitmap.bitmapData = this.foregroundBitmapData;
         if(Boolean(this.main) && Boolean(this.main.avatarList))
         {
            for each(v26ServerAvatar in this.main.avatarList)
            {
               if(Boolean(v26ServerAvatar))
               {
                  for each(v26ServerEvent in param1)
                  {
                     v26ServerAvatar.wakeAfterTerrainChange(Number(v26ServerEvent[0]),Number(v26ServerEvent[1]),Number(v26ServerEvent[2]));
                  }
               }
            }
         }
      }
      
      public function get synchronization`);
  write(file, source);
}

function patchExternalCalls(file) {
  let source = read(file);
  source = replaceOnce(source,
    `      public function ExternalCalls()
      {
         super();
      }`,
    `      public function ExternalCalls()
      {
         super();
      }

      private static function privateFeatureUnavailable(param1:String) : Boolean
      {
         if(Boolean(Ballistics.lobbyConnection))
         {
            Ballistics.lobbyConnection.sendCommand({
               "command":"private_feature",
               "feature":param1
            });
         }
         return true;
      }`,
    "v26 unavailable private feature bridge");
  source = replaceOnce(source,
    `      public static function showForum() : Boolean
      {
         setNormalScreen();
         return externalCall(FORUM);
      }`,
    `      public static function showForum() : Boolean
      {
         return privateFeatureUnavailable("forum");
      }`,
    "v26 unavailable forum message");
  source = replaceOnce(source,
    `      public static function showGiftee() : Boolean
      {
         return showView(GIFTEE_SELECTOR);
      }`,
    `      public static function showGiftee() : Boolean
      {
         return privateFeatureUnavailable("gift_recipient");
      }`,
    "v26 unavailable gift recipient message");
  source = replaceOnce(source,
    `      public static function showInviteAll() : Boolean
      {
         setNormalScreen();
         return externalCall(SHOW_INVITE_ALL);
      }`,
    `      public static function showInviteAll() : Boolean
      {
         return privateFeatureUnavailable("invite_all");
      }`,
    "v26 unavailable invite-all message");
  source = replaceOnce(source,
    `      public static function showInvite() : Boolean
      {
         return showView(INVITE);
      }`,
    `      public static function showInvite() : Boolean
      {
         return privateFeatureUnavailable("invite");
      }`,
    "v26 unavailable invite message");
  source = replaceOnce(source,
    `      public static function showSurvey() : Boolean
      {
         setNormalScreen();
         return externalCall(SURVEY);
      }`,
    `      public static function showSurvey() : Boolean
      {
         return privateFeatureUnavailable("survey");
      }`,
    "v26 unavailable survey message");
  source = replaceOnce(source,
    `      public static function showGiftType(param1:String) : void
      {
         var type:String = param1;
         setNormalScreen();
         try
         {
            trace("Calling showGiftType.",type);
            ExternalInterface.call("sendGift",type);
            trace("returned showGiftType.",type);
         }
         catch(e:Error)
         {
            trace("External Interface Failed. Show Gift: ",type);
         }
      }`,
    `      public static function showGiftType(param1:String) : void
      {
         privateFeatureUnavailable("gift_" + param1);
      }`,
    "v26 unavailable gift message");
  source = replaceOnce(source,
    `      public static function showHelp() : Boolean
      {
         setNormalScreen();
         return externalCall(HELP);
      }`,
    `      public static function showHelp() : Boolean
      {
         return privateFeatureUnavailable("help");
      }`,
    "v26 unavailable help message");
  source = replaceOnce(source,
    `      public static function showGift() : Boolean
      {
         return showView(GIFT_SELECTOR);
      }`,
    `      public static function showGift() : Boolean
      {
         return privateFeatureUnavailable("gift");
      }`,
    "v26 unavailable gift selector message");
  source = replaceOnce(source,
    `      public static function getMoreTreats() : Boolean
      {
         setNormalScreen();
         try
         {
            trace("Calling getMoreTreats.");
            ExternalInterface.call("switchView","bank");
         }
         catch(e:Error)
         {
            trace("External Interface Failed. : switchView bank");
            return false;
         }
         return true;
      }`,
    `      public static function getMoreTreats() : Boolean
      {
         if(Ballistics.lobbyConnection)
         {
            Ballistics.lobbyConnection.sendCommand({"command":"local_offer","type":"more_treats"});
         }
         return true;
      }`,
    "v26 local treat offer");
  source = replaceOnce(source,
    `      public static function openURL(param1:String) : Boolean
      {
         return ExternalInterface.call(OPEN_URL,param1);
      }`,
    `      public static function openURL(param1:String) : Boolean
      {
         // Cross-promo rewards are granted by the local xpromo command; no
         // browser navigation or ExternalInterface bridge is required.
         return true;
      }`,
    "v26 local xpromo link");
  source = replaceOnce(source,
    `      public static function getMoreFBCredits() : Boolean
      {
         setNormalScreen();
         return externalCall("getMoreFBCredits");
      }
      
      public static function showBank() : Boolean
      {
         return showView(BANK);
      }`,
    `      public static function getMoreFBCredits() : Boolean
      {
         return getMoreTreats();
      }
      
      public static function showBank() : Boolean
      {
         if(Ballistics.lobbyConnection)
         {
            Ballistics.lobbyConnection.sendCommand({"command":"local_offer","type":"more_gold"});
         }
         return true;
      }`,
    "v26 local bank offers");
  source = replaceOnce(source,
    `      public static function facebookPurchase(param1:String, param2:String, param3:String, param4:int, param5:int, param6:int) : Boolean
      {
         var genus:String = param1;
         var type:String = param2;
         var name:String = param3;
         var amount:int = param4;
         var fesos:int = param5;
         var treats:int = param6;
         setNormalScreen();
         try
         {
            ExternalInterface.call(FACEBOOK_PURCHASE_DIALOG,genus,type,name,amount,fesos,treats);
         }
         catch(e:Error)
         {
            trace("External Interface Failed.",FACEBOOK_PURCHASE_DIALOG,genus,type,name,amount,fesos,treats);
            return false;
         }
         return true;
      }`,
    `      public static function facebookPurchase(param1:String, param2:String, param3:String, param4:int, param5:int, param6:int) : Boolean
      {
         if(!Ballistics.lobbyConnection)
         {
            return false;
         }
         if(param1 == "member")
         {
            Ballistics.lobbyConnection.sendCommand({"command":"member"});
         }
         else
         {
            Ballistics.lobbyConnection.sendCommand({"command":"local_offer","type":param1 == "currency" ? "more_gold" : "more_treats"});
         }
         return true;
      }`,
    "v26 local purchase bridge");
  write(file, source);
}

function main() {
  if (!fs.existsSync(ffdec)) throw new Error(`FFDec was not found: ${ffdec}`);
  if (!fs.existsSync(baseSwf)) throw new Error(`v25 base SWF was not found: ${baseSwf}`);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  run(["-export", "script", workDir, baseSwf]);

  const applicationLauncher = path.join(importDir, "com", "playdom", "ballistics", "shared", "ApplicationLauncher.as");
  const player = path.join(importDir, "Player.as");
  const avatar = path.join(importDir, "com", "playdom", "ballistics", "avatar", "Avatar.as");
  const commandProcessor = path.join(importDir, "CommandProcessor.as");
  const battlefield = path.join(importDir, "Battlefield.as");
  const timeLoop = path.join(importDir, "com", "playdom", "ballistics", "game", "TimeLoop.as");
  const controls = path.join(importDir, "com", "playdom", "ballistics", "game", "control", "Controls.as");
  const aiCommands = path.join(importDir, "com", "playdom", "ballistics", "AI", "AICommands.as");
  const petFoodBowl = path.join(importDir, "com", "playdom", "ballistics", "feeding", "PetFoodBowl.as");
  const petFoodProperties = path.join(importDir, "PetFoodProperties.as");
  const slotMachine = path.join(importDir, "com", "playdom", "slotmachine", "SlotMachine.as");
  const externalCalls = path.join(importDir, "com", "playdom", "ballistics", "shared", "ExternalCalls.as");
  const makeWeapon = path.join(importDir, "com", "playdom", "ballistics", "weapons", "MakeWeapon.as");
  const gooShot = path.join(importDir, "com", "playdom", "ballistics", "weapons", "GooShot.as");
  const weaponProperties = path.join(importDir, "WeaponProperties.as");
  const drill = path.join(importDir, "com", "playdom", "ballistics", "weapons", "Drill.as");
  const ballistics = path.join(importDir, "Ballistics.as");
  const petCarousel = path.join(importDir, "com", "playdom", "ballistics", "pet", "PetCarousal.as");
  const petPowerIcon = path.join(importDir, "com", "playdom", "ballistics", "shop", "ShopPetPowerIcon.as");
  const leaderBar = path.join(importDir, "com", "playdom", "ballistics", "leaderboard", "LeaderBar.as");
  const shopAccessories = path.join(importDir, "com", "playdom", "ballistics", "shop", "ShopAccessoriesController.as");
  const shopPets = path.join(importDir, "com", "playdom", "ballistics", "shop", "ShopPetsController.as");
  const shopMaps = path.join(importDir, "com", "playdom", "ballistics", "shop", "ShopMapsController.as");
  const featuredItem = path.join(importDir, "com", "playdom", "ballistics", "home", "FeaturedItem.as");
  const weaponPurchase = path.join(importDir, "com", "playdom", "ballistics", "weaponLoadout", "WeaponPurchase.as");
  const prizeData = path.join(importDir, "com", "playdom", "ballistics", "chance", "PrizeData.as");
  const wheel = path.join(importDir, "com", "playdom", "ballistics", "chance", "Wheel.as");
  const leaderBoard = path.join(importDir, "com", "playdom", "ballistics", "leaderboard", "LeaderBoard.as");
  const shopWeaponsConveyor = path.join(importDir, "com", "playdom", "ballistics", "shop", "Weapons", "ShopWeaponsConveyor.as");
  const assetLoadView = path.join(importDir, "com", "playdom", "ballistics", "home", "AssetLoadView.as");
  const bannerView = path.join(importDir, "com", "playdom", "ballistics", "home", "BannerView.as");
  const abstractNotification = path.join(importDir, "com", "playdom", "ballistics", "notifications", "AbstractNotificationView.as");
  const overlayView = path.join(importDir, "com", "playdom", "ballistics", "home", "OverlayView.as");
  const gamblePopup = path.join(importDir, "com", "playdom", "ballistics", "notifications", "GamblePopup.as");
  const collectionPopup = path.join(importDir, "com", "playdom", "ballistics", "collection", "CollectionPopup.as");
  const collectionItemBox = path.join(importDir, "com", "playdom", "ballistics", "collection", "ItemBox.as");
  const collectionGrandBox = path.join(importDir, "com", "playdom", "ballistics", "collection", "GrandBox.as");
  const collectionReel = path.join(importDir, "com", "playdom", "ballistics", "collection", "Reel.as");
  const collectionPrize = path.join(importDir, "com", "playdom", "ballistics", "collection", "CollectionPrizePopup.as");
  const collectionFinal = path.join(importDir, "com", "playdom", "ballistics", "collection", "CollectionFinalPopup.as");
  const accessoryProperties = path.join(importDir, "AccessoriesProperties.as");
  const shopAccessoriesConveyor = path.join(importDir, "com", "playdom", "ballistics", "shop", "ShopAccessoriesConveyor.as");
  const petAccessoriesConveyor = path.join(importDir, "com", "playdom", "ballistics", "pet", "PetAccessoriesConveyor.as");
  const accessoryBonus = path.join(importDir, "com", "playdom", "ballistics", "avatar", "AccessoryBonus.as");
  const miniPet = path.join(importDir, "com", "playdom", "ballistics", "avatar", "MiniPet.as");
  const animalGraphics = path.join(importDir, "com", "playdom", "ballistics", "avatar", "AnimalGraphics.as");
  const assetManager = path.join(importDir, "com", "playdom", "asset", "AssetManager.as");
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "shared", "ApplicationLauncher.as"), applicationLauncher);
  copy(path.join(scriptsDir, "Player.as"), player);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "avatar", "Avatar.as"), avatar);
  copy(path.join(scriptsDir, "CommandProcessor.as"), commandProcessor);
  copy(path.join(scriptsDir, "Battlefield.as"), battlefield);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "game", "TimeLoop.as"), timeLoop);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "game", "control", "Controls.as"), controls);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "AI", "AICommands.as"), aiCommands);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "feeding", "PetFoodBowl.as"), petFoodBowl);
  copy(path.join(scriptsDir, "PetFoodProperties.as"), petFoodProperties);
  copy(path.join(scriptsDir, "com", "playdom", "slotmachine", "SlotMachine.as"), slotMachine);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "shared", "ExternalCalls.as"), externalCalls);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "weapons", "MakeWeapon.as"), makeWeapon);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "weapons", "GooShot.as"), gooShot);
  copy(path.join(scriptsDir, "WeaponProperties.as"), weaponProperties);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "weapons", "Drill.as"), drill);
  copy(path.join(scriptsDir, "Ballistics.as"), ballistics);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "pet", "PetCarousal.as"), petCarousel);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "shop", "ShopPetPowerIcon.as"), petPowerIcon);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "leaderboard", "LeaderBar.as"), leaderBar);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "shop", "ShopAccessoriesController.as"), shopAccessories);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "shop", "ShopPetsController.as"), shopPets);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "shop", "ShopMapsController.as"), shopMaps);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "home", "FeaturedItem.as"), featuredItem);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "weaponLoadout", "WeaponPurchase.as"), weaponPurchase);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "chance", "PrizeData.as"), prizeData);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "chance", "Wheel.as"), wheel);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "leaderboard", "LeaderBoard.as"), leaderBoard);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "shop", "Weapons", "ShopWeaponsConveyor.as"), shopWeaponsConveyor);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "home", "AssetLoadView.as"), assetLoadView);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "home", "BannerView.as"), bannerView);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "notifications", "AbstractNotificationView.as"), abstractNotification);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "home", "OverlayView.as"), overlayView);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "notifications", "GamblePopup.as"), gamblePopup);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "collection", "CollectionPopup.as"), collectionPopup);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "collection", "ItemBox.as"), collectionItemBox);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "collection", "GrandBox.as"), collectionGrandBox);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "collection", "Reel.as"), collectionReel);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "collection", "CollectionPrizePopup.as"), collectionPrize);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "collection", "CollectionFinalPopup.as"), collectionFinal);
  copy(path.join(scriptsDir, "AccessoriesProperties.as"), accessoryProperties);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "shop", "ShopAccessoriesConveyor.as"), shopAccessoriesConveyor);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "pet", "PetAccessoriesConveyor.as"), petAccessoriesConveyor);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "avatar", "AccessoryBonus.as"), accessoryBonus);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "avatar", "MiniPet.as"), miniPet);
  copy(path.join(scriptsDir, "com", "playdom", "ballistics", "avatar", "AnimalGraphics.as"), animalGraphics);
  copy(path.join(scriptsDir, "com", "playdom", "asset", "AssetManager.as"), assetManager);
  const field = path.join(importDir, "com", "playdom", "ballistics", "game", "Field.as");
  copy(path.join(root, "swf-patches", "v26", "com", "playdom", "ballistics", "game", "Field.as"), field);
  patchMaps(applicationLauncher);
  patchOwnedMaps(player);
  patchAvatarSafety(player, avatar);
  patchBotState(commandProcessor);
  patchAuthoritativeHumanRelay(controls, timeLoop, commandProcessor);
  patchMapUnavailable(commandProcessor);
  patchServerHealth(avatar);
  patchBotHealthProtocol(battlefield);
  patchRespawnAuthority(battlefield, avatar, timeLoop);
  patchServerBotRenderer(timeLoop, aiCommands);
  patchPhysicsStability(timeLoop, commandProcessor, drill, battlefield);
  patchFoodState(petFoodBowl, petFoodProperties);
  patchSlotMachine(slotMachine);
  patchFieldRenderer(field);
  patchExternalCalls(externalCalls);
  patchWeaponSafety(makeWeapon, gooShot);
  patchWeaponGraphicsAliases(weaponProperties);
  patchAssetManagerAliases(assetManager);
  patchWeaponRuntimeClass(makeWeapon);
  patchPetMeleeRuntime(makeWeapon, avatar);
  patchPetCarouselRuntime(petCarousel);
  patchPetPowerIconRuntime(petPowerIcon);
  patchLeaderboardPlayerDetails(leaderBar);
  patchLobbyPurchaseResponses(ballistics);
  patchMatchProgressionRefresh(ballistics);
  patchPurchaseControllers(shopAccessories, shopPets, shopMaps, featuredItem, weaponPurchase);
  patchPrizeWheel(prizeData, wheel);
  patchLeaderboardRefresh(leaderBoard);
  patchShopWeaponVisibility(shopWeaponsConveyor);
  patchModalAndCollectionRuntime(
    abstractNotification,
    overlayView,
    gamblePopup,
    collectionPopup,
    collectionItemBox
  );
  patchCollectionVisualSafety(collectionGrandBox, collectionReel, collectionPrize, collectionFinal);
  patchLegacyAnimationClock(animalGraphics);
  patchAccessoryRuntime(
    accessoryProperties,
    shopAccessoriesConveyor,
    petAccessoriesConveyor,
    accessoryBonus,
    avatar,
    miniPet
  );
  patchTurkiyeBranding(assetLoadView, bannerView);

  const staged = path.join(workDir, "gamewo-v26.swf");
  const mapPatchedSwf = patchMapCatalogue();
  run(["-importScript", mapPatchedSwf, staged, importDir]);
  if (!fs.existsSync(staged) || fs.statSync(staged).size < 1_500_000) throw new Error("FFDec did not produce a complete v26 SWF");
  fs.copyFileSync(staged, outputSwf);
  console.log(`Built ${path.relative(root, outputSwf)} (${fs.statSync(outputSwf).size} bytes)`);
}

main();
