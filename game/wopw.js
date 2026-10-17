var
    gameport                = Number(process.env.GAME_PORT || 8000),
    uuidv4                  = require('crypto').randomUUID,
    net                     = require('net'),
    http                    = require('http'),
    path                    = require('path'),
    fs                      = require('fs'),

    Database                = require('./database.js'),
    PacketHandler           = require('./handler.js'),
    Slot                    = require('./slot.js'),
    Utils                   = require('./helpers/utils.js'),

    Client                  = require('./client/client.abstract.js'),

    AccessoriesProperties   = require('./properties/accessories.properties.js'),
    WeaponProperties        = require('./properties/weapon.properties.js'),
    MapProperties           = require('./properties/map.properties.js'),
    PetFoodProperties       = require('./properties/pet.food.properties.js'),
    ChassisProperties       = require('./properties/chassis.properties.js');

const { buildWeaponCatalog } = require('../shared/weapon-catalog.js');
const { buildMapManifest } = require('../shared/map-manifest.js');
const weaponAssetManifest = require('../shared/weapon-assets.json');
const botAccessoryManifest = require('../shared/bot-accessory-assets.json');
const legacyChanceCollections = require('../shared/legacy-chance-collections.json');
const { manifestRecord } = require('../shared/accessory-bonuses.js');
const buildInfo = (() => {
    try { return require('../shared/build-info.json'); }
    catch (_) { return { buildId: 'development', swf: {} }; }
})();

var DEBUG = process.env.DEBUG === 'true' || false;

class WOPW{
    constructor() {
        this.lobbyClients = {};
        this.ladderClients = {};
        this.slots = {};

        this.db = new Database();
        this.packetHandler = new PacketHandler(this);

        this.assetsURL = process.env.ASSETS_URL || "";
        this.localAssetsPath = process.env.ASSETS_DIR || path.join(__dirname, '..', 'web', 'assets', 'json');
        this.assetsCacheVersion = "debug_0002";
        this.assetsList = ["Config", "Accessories", "Crate", "Gifts", "Levels", "Maps", "Other", "PetFoods", "Pets", "WeaponsGrid"];
        this.assetsObj = {};

        this.config         = {};
        this.accessoriesObj = {};
        this.crateObj       = {};
        this.levelsObj      = {};
        this.weaponsObj     = {};
        this.weaponCatalog  = null;
        this.weaponAssetManifest = weaponAssetManifest;
        this.mapsObj        = {};
        this.mapManifest    = { names: [], maps: [], rejected: [] };
        this.petFoodsObj    = {};
        this.petsObj    = {};
        this.otherObj   = {};
        this.botAccessoryTypes = new Set(botAccessoryManifest.types || []);
        this.accessoryAssetManifest = botAccessoryManifest;

        this.itemLevel = {};

        this.DEFAULT_TIME_AFTER_WEAPON = 400;
    }

    async start(){
        await this.db.connect();
        this.loadAssets(0);
        this.procTimer = setInterval(() => this.update(), 100);
    }

    loadAssets(pos){
        var item = this.assetsList[pos];
        var localPath = path.join(this.localAssetsPath, item + '.dat');

        if (fs.existsSync(localPath)) {
            try {
                var data = fs.readFileSync(localPath, 'utf8');
                this.assetsObj[item] = JSON.parse(data);
                console.log("Loaded asset (local): " + item);

                if(this.assetsList.length - 1 > pos)
                    this.loadAssets(pos + 1);
                else this.onAssetsLoaded();
            } catch(e) {
                console.log("!! Error loading local asset " + item + ": " + e);
                this.loadAssetsRemote(pos);
            }
        } else {
            this.loadAssetsRemote(pos);
        }
    }

    loadAssetsRemote(pos){
        var item = this.assetsList[pos];
        if(!this.assetsURL) throw new Error("Missing local asset " + item);
        var url = this.assetsURL + item + ".dat?cachev=" + this.assetsCacheVersion;

        fetch(url)
            .then(function(res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            }.bind(this))
            .then(function(data) {
                this.assetsObj[item] = data;
                console.log("Loaded asset (remote): " + item);

                if(this.assetsList.length - 1 > pos)
                    this.loadAssets(pos + 1);
                else this.onAssetsLoaded();
            }.bind(this))
            .catch(function(err) {
                console.log("!! Error loading remote asset " + item + ": " + err);
                if(this.assetsList.length - 1 > pos)
                    this.loadAssets(pos + 1);
                else this.onAssetsLoaded();
            }.bind(this));
    }

    onAssetsLoaded(){
        if(DEBUG) console.log("All assets loaded. Processing..");
        this.processConfig();
        this.processAccessories();
        this.processCrate();
        this.processLevels();
        this.processMaps();
        this.processPetFoods();
        this.processPets();
        this.processOther();
        this.processWeaponsGrid();
        if(DEBUG) console.log("Done processing.");
        this.run();
    }

    processConfig(){
        this.config = this.assetsObj["Config"];

        var crumbsPath = path.join(__dirname, 'crumbs', 'config.json');
        if (fs.existsSync(crumbsPath)) {
            try {
                var crumbs = JSON.parse(fs.readFileSync(crumbsPath, 'utf8'));
                for (var key in crumbs) {
                    if (this.config[key] === undefined) {
                        this.config[key] = crumbs[key];
                    }
                }
            } catch(e) {}
        }
    }

    processAccessories(){
        var definitions = this.assetsObj["Accessories"] || [];
        for(var i = 0; i < definitions.length; i++){
            var obj = new AccessoriesProperties();
            for(var property in definitions[i])
                obj[property] = definitions[i][property];
            var support = manifestRecord(obj.type, this.accessoryAssetManifest);
            obj.rendererSupported = Boolean(support && support.rendererSupported);
            obj.leftSymbolSupported = Boolean(support && support.leftSymbolSupported !== false);
            obj.shopVisible = Boolean(support && support.shopVisible);
            obj.equipVisible = Boolean(support && support.equipVisible);
            obj.rewardEligible = Boolean(support && support.rewardEligible);
            obj.effectiveType = support && support.effectiveType || obj.type;
            obj.assetReason = support && support.reason || "missing_manifest";
            this.accessoriesObj[obj.type] = obj;
        }
    }

    processCrate(){
        this.crateObj = this.assetsObj["Crate"];
    }

    processLevels(){
        this.levelsObj = this.assetsObj["Levels"];
        var _level = 1;
        for(var i in this.levelsObj){
            var level = this.levelsObj[i];
            for(var itemIndex in level.map){
                this.itemLevel[level.map[itemIndex]] = (_level);
            }
            for(var itemIndex in level.chassis){
                this.itemLevel[level.chassis[itemIndex]] = (_level);
            }
            for(var itemIndex in level.weapon){
                this.itemLevel[level.weapon[itemIndex]] = (_level);
            }
            _level++;
        }
    }

    processMaps(){
        var imagesRoot = path.resolve(process.env.IMAGES_DIR || path.join(__dirname, '..', 'web', 'images'));
        this.mapManifest = buildMapManifest(this.assetsObj["Maps"], {
            assetExists: function(relativePath){
                var resolved = path.resolve(imagesRoot, relativePath);
                return resolved.startsWith(imagesRoot + path.sep) && fs.existsSync(resolved);
            }
        });
        this.mapsObj = {};
        for(var i = 0; i < this.mapManifest.maps.length; i++){
            var obj = new MapProperties();
            for(var property in this.mapManifest.maps[i])
                obj[property] = this.mapManifest.maps[i][property];
            this.mapsObj[obj.name] = obj;
        }
        for(var rejectedIndex = 0; rejectedIndex < this.mapManifest.rejected.length; rejectedIndex++){
            var rejected = this.mapManifest.rejected[rejectedIndex];
            console.error("map_manifest_rejected map=" + JSON.stringify(rejected.name) + " code=" + rejected.error);
        }
        console.log("map_manifest_active maps=" + this.mapManifest.names.join(","));
    }

    processPetFoods(){
        for(var i = 0; i < this.assetsObj["PetFoods"].length; i++){
            var obj = new PetFoodProperties();
            for(var property in this.assetsObj["PetFoods"][i])
                obj[property] = this.assetsObj["PetFoods"][i][property];
            this.petFoodsObj[obj.type] = obj;
        }
    }

    processPets(){
        for(var i = 0; i < this.assetsObj["Pets"].length; i++){
            var obj = new ChassisProperties();
            for(var property in this.assetsObj["Pets"][i])
                obj[property] = this.assetsObj["Pets"][i][property];
            this.petsObj[obj.type] = obj;
        }
    }

    processOther(){
        this.otherObj = Object.assign({}, this.assetsObj["Other"] || {});
        this.otherObj.chanceCollections = legacyChanceCollections;
    }

    processWeaponsGrid(){
        this.weaponCatalog = buildWeaponCatalog(this.assetsObj["WeaponsGrid"]);
        for(const [type, entry] of this.weaponCatalog.entries){
            const support = weaponAssetManifest.weapons && weaponAssetManifest.weapons[type];
            entry.visualType = support ? support.visualType : type;
            entry.behaviorType = support ? support.behaviorType : entry.effectiveType;
            entry.runtimeSupported = Boolean(support && support.runtimeSupported);
            entry.iconSupported = Boolean(support && support.iconSupported);
            entry.shopVisible = Boolean(support && support.shopVisible);
        }
        for(var i = 0; i < this.weaponCatalog.records.length; i++){
            var obj = new WeaponProperties();
            for(var property in this.weaponCatalog.records[i])
                obj[property] = this.weaponCatalog.records[i][property];
            var support = weaponAssetManifest.weapons && weaponAssetManifest.weapons[obj.type];
            obj.visualType = support ? support.visualType : obj.type;
            obj.behaviorType = support ? support.behaviorType : obj.effectiveType;
            obj.runtimeSupported = Boolean(support && support.runtimeSupported);
            obj.iconSupported = Boolean(support && support.iconSupported);
            obj.shopVisible = Boolean(support && support.shopVisible);
            this.weaponsObj[obj.type] = obj;
        }
    }

    run(){
        console.log(">> Accepting clients on " + gameport + " buildId=" + buildInfo.buildId + " swf=" + (buildInfo.swf.sha256 || "unknown"));

        this.tcpServer = net.createServer(function (socket) {
            socket.name = socket.remoteAddress + ":" + socket.remotePort;
            socket.id = uuidv4();
            if(DEBUG) console.log("generated socket id: " + socket.id);
            var obj = new Client(socket, this.db, this);
            if(DEBUG) console.log(">> CLIENT " + socket.name + " " + obj.id);

            obj.eventTrigger.on('newScope', function(){
                if(DEBUG) console.log(">>> New object was assigned");
                obj = obj.newObject;
            });

            // Turn, shot and health packets are tiny; without TCP_NODELAY each
            // write can sit behind a delayed ACK on the bridge connection.
            socket.setNoDelay(true);
            // Detect half-open bridge connections long before the idle timeout.
            socket.setKeepAlive(true, 10000);
            socket.setTimeout(5 * 60 * 1000);
            socket.on('data', function (data) {
                try {
                    this.packetHandler.handle(obj, data);
                }
                catch(e){
                    this.packetHandler.handleProtocolError(obj, e);
                }
            }.bind(this));

            socket.on('error', function (e) {
                if(DEBUG) console.log("!! Sock error: " + e);
            }.bind(this));

            let removed = false;
            socket.on('close', function () {
                if(removed) return;
                removed = true;
                obj.disconnected = true;
                this.removeClientObj(obj);
            }.bind(this));
            socket.on('timeout', () => socket.destroy());
        }.bind(this));
        this.tcpServer.on('error', (error) => console.error("tcp_error", error.message));
        this.tcpServer.listen(gameport, process.env.GAME_HOST || "0.0.0.0");
    }

    update(){
        for (var key in this.slots) {
            var g = this.slots[key];
            g.update();
        }
    }

    validateMapDetails(client, data){
        var asBoolean = function(value){
            if(typeof value === "string") return value.toLowerCase() === "true" || value === "1";
            return value === true || value === 1;
        };
        data.nu = Number(data.nu) === 1 ? 1 : 0;
        data.te = asBoolean(data.te);
        data.ba = asBoolean(data.ba);
        data.wi = asBoolean(data.wi);

        if(!this.mapsObj[data.mapName]){
            data.mapError = "map_unavailable";
            return data;
        }

        var map = this.mapsObj[data.mapName];
        var availablePlayerCounts = this.config.maxPlayers.map(Number).filter(function(value){
            return Number.isInteger(value) && value >= 2 &&
                Array.isArray(map.positions) && value <= map.positions.length;
        }).sort(function(a, b){ return a - b; });
        if(!availablePlayerCounts.length){
            data.mapError = "capacity";
            return data;
        }

        var duration = Number(data.gameDuration);
        if(duration >= 60000 && duration % 60000 === 0) duration /= 60000;
        else if(duration >= 60 && duration % 60 === 0) duration /= 60;
        var allowedDurations = this.config.gameTimes.map(Number);
        if(duration === 0) duration = allowedDurations[Math.floor(Math.random() * allowedDurations.length)];
        if(allowedDurations.indexOf(duration) < 0){
            data.mapError = "invalid_settings";
            data.invalidSetting = "gameDuration";
            return data;
        }

        var turnDuration = Number(data.turnDuration);
        if(turnDuration >= 1000 && turnDuration % 1000 === 0) turnDuration /= 1000;
        var allowedTurns = this.config.turnTimes.map(Number);
        if(turnDuration === 0) turnDuration = allowedTurns[Math.floor(Math.random() * allowedTurns.length)];
        if(allowedTurns.indexOf(turnDuration) < 0){
            data.mapError = "invalid_settings";
            data.invalidSetting = "turnDuration";
            return data;
        }

        var requestedPlayerCount = Number(data.playerCount);
        var playerCount = requestedPlayerCount;
        if(playerCount === 0){
            playerCount = availablePlayerCounts[Math.floor(Math.random() * availablePlayerCounts.length)];
        }else if(this.config.maxPlayers.map(Number).indexOf(playerCount) < 0){
            data.mapError = "invalid_settings";
            data.invalidSetting = "playerCount";
            return data;
        }
        if(playerCount > availablePlayerCounts[availablePlayerCounts.length - 1]){
            playerCount = availablePlayerCounts[availablePlayerCounts.length - 1];
        }

        data.requestedPlayerCount = requestedPlayerCount;
        data.playerCount = playerCount;
        data.gameDuration = duration;
        data.turnDuration = turnDuration;
        data.capacityAdjusted = requestedPlayerCount > 0 && playerCount !== requestedPlayerCount;
        return data;
    }

    findSimilarSlot(map){
        if(!map) return 0;
        for(var existingId in this.slots){
            var existing = this.slots[existingId];
            if(existing === map || existing.mapName !== map.mapName ||
                existing.playerCount !== map.playerCount ||
                existing.gameDuration !== map.gameDuration ||
                existing.turnDuration !== map.turnDuration ||
                existing.numberOfDeaths !== map.nu ||
                existing.teamMode !== map.te ||
                existing.balancedGame !== map.ba ||
                existing.useWind !== map.wi) continue;
            if(!existing.isRunning() && !existing.isGameOver() && !existing.isFull()) return existingId;
        }

        var baseId = [map.mapName, map.playerCount, map.gameDuration, map.turnDuration, map.nu, map.te ? 1 : 0, map.ba ? 1 : 0, map.wi ? 1 : 0]
            .join("_").split(" ").join("-") + "_";
        var maxSlots = this.config.maxSlots || 100;
        for(var i = 0; i < maxSlots; i++){
            var tmpId = baseId + i;
            if(this.slots[tmpId]) continue;
            this.createSlot(tmpId, map.mapName, map.playerCount, map.gameDuration, map.turnDuration, map);
            return tmpId;
        }
        return 0;
    }

    findSlot(client, mapDetails, customName){
        if(!(mapDetails.hasOwnProperty('mapName') && mapDetails.hasOwnProperty('playerCount')
                && mapDetails.hasOwnProperty('gameDuration') && mapDetails.hasOwnProperty('turnDuration')))
            return 0;

        if(!this.mapsObj[mapDetails.mapName])                          return 0;
        if(this.config.gameTimes.indexOf(mapDetails.gameDuration) < 0) return 0;
        if(this.config.turnTimes.indexOf(mapDetails.turnDuration) < 0) return 0;
        if(this.config.maxPlayers.indexOf(mapDetails.playerCount) < 0) return 0;

        var mapName         = mapDetails.mapName,
            playerCount     = parseInt(mapDetails.playerCount),
            gameDuration    = parseInt(mapDetails.gameDuration) * 60 * 1000,
            turnDuration    = parseInt(mapDetails.turnDuration) * 1000;
        mapDetails.fillPolicy = customName ? "human_only" : "auto";
        var gameId          = null;

        if(customName){
            gameId = customName;

            if(this.slots[gameId]){
                if(this.slots[gameId].isRunning() || this.slots[gameId].isGameOver() || (this.slots[gameId].startingTime != 0 && this.slots[gameId].startingTime <= (Date.now() + 1000))){
                    return 0;
                }
            }else{
                this.createSlot(gameId, mapName, playerCount, gameDuration, turnDuration, mapDetails);
                if(DEBUG) console.log(">> Created slot with gameId = " + gameId);
                return gameId;
            }
        }else{
            gameId = [
                mapName, playerCount, gameDuration, turnDuration,
                mapDetails.nu, mapDetails.te ? 1 : 0,
                mapDetails.ba ? 1 : 0, mapDetails.wi ? 1 : 0
            ].join("_") + "_";

            gameId = gameId.split(' ').join('-');

            var maxSlots = this.config.maxSlots || 100;
            for(var i = 0; i < maxSlots; i++){
                var tmpId = gameId + i;
                if(this.slots[tmpId]){
                    if(this.slots[tmpId].isRunning() || this.slots[tmpId].isGameOver()  || (this.slots[tmpId].startingTime != 0 && this.slots[tmpId].startingTime <= (Date.now() + 1000))){
                        continue;
                    }

                    if(this.slots[tmpId].getPlayerCount() < playerCount){
                        return tmpId;
                    }else continue;
                }else{
                    this.createSlot(tmpId, mapName, playerCount, gameDuration, turnDuration, mapDetails);
                    return tmpId;
                }
            }
        }
    }

    createSlot(gameId, mapName, playerCount, gameDuration, turnDuration, rules){
        this.slots[gameId] = new Slot(this, gameId, mapName, playerCount, gameDuration, turnDuration, rules);
        this.slots[gameId].displayName = rules && rules.roomDisplayName ? rules.roomDisplayName : mapName;
    }

    getJoinCommand(gameId){
        return this.slots[gameId].getString("join");
    }

    getGame(gameId){
        return this.slots[gameId];
    }

    updateLobbyPlayer(newPlayer){
        for(var key in this.lobbyClients){
            var lc = this.lobbyClients[key];
            if(lc.player.id == newPlayer.id){
                lc.player = newPlayer;
                if(typeof lc.sendUpdate === "function") lc.sendUpdate();
                break;
            }
        }
    }

    sendLobbyPlayerPacket(playerId, packet){
        for(var key in this.lobbyClients){
            var lc = this.lobbyClients[key];
            if(lc.player && String(lc.player.id) === String(playerId) && typeof lc.sendPacket === "function"){
                lc.sendPacket(packet);
            }
        }
    }

    getLobbyLoad(){
        return Object.keys(this.lobbyClients).length;
    }

    addClient(obj){
        console.log("adding client UUID: " + obj.sock.id);
        if(obj.connectionType == "lobby")
            this.lobbyClients[obj.sock.id] = obj;
        else if(obj.connectionType == "ladder")
            this.ladderClients[obj.sock.id] = obj;
    }

    removeClientObj(obj){
        if(!obj) return false;
        obj.disconnected = true;

        // Docker's TCP health probe connects and closes before sending a
        // protocol handshake.  It was never registered, so there is nothing to
        // remove (and no useful disconnect event to log).
        if(!obj.connectionType || obj.connectionType == "abstract") return false;

        if(obj.connectionType == "lobby"){
            if(!obj.sock || this.lobbyClients[obj.sock.id] !== obj) return false;
            delete this.lobbyClients[obj.sock.id];
        } else if(obj.connectionType == "ladder"){
            if(!obj.sock || this.ladderClients[obj.sock.id] !== obj) return false;
            delete this.ladderClients[obj.sock.id];
        } else if(obj.connectionType == "game"){
            if(!obj.gameId || !this.slots[obj.gameId] || !obj.player || obj.player.id == null) return false;
            const slot = this.slots[obj.gameId];
            // A reconnect replaces slot.clients[playerId].  The old socket can
            // close later; only the exact object currently registered may tear
            // down player state, respawn timers, or the slot itself.
            if(!slot.clients || slot.clients[obj.player.id] !== obj) return false;
            slot.removeClient(obj);
        } else {
            return false;
        }

        console.log(">> disconnectClient was called");
        return true;
    }
};

module.exports = WOPW;
