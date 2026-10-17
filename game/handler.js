"use strict";

var LobbyClient = require("./client/client.lobby.js"),
    LadderClient = require("./client/client.ladder.js"),
    GameClient = require("./client/client.game.js"),
    Utils = require('./helpers/utils.js'),
    Logger = require('./helpers/logger.js');
const crypto = require("crypto");
const {
    STAT_POINT_PACKAGES,
    ensureProgression,
    rewardPlayer,
    recordMedalEvent,
    recordPlayerStat
} = require("../shared/progression.js");
const { isSupportedMapName } = require("../shared/map-manifest.js");
const { levelFromXp } = require("../shared/levels.js");
const { canonicalRoomName } = require("../shared/room-name.js");
const {
    comparePetIds,
    normalizeProfileState
} = require("../shared/profile-state.js");
const {
    manifestRecord,
    sanitizeEquippedAccessories
} = require("../shared/accessory-bonuses.js");

var DEBUG = process.env.DEBUG === 'true' || false;


class Handler{

    constructor(wopw){
        if(DEBUG){
            console.log(">> Initialized Handler");
        }
        this.WOPW = wopw;
        this.randomInt = typeof wopw.randomInt === "function" ? wopw.randomInt : crypto.randomInt;
        this.invalidItemLog = new Logger("invalidItem");
    }

    queueDispatch(client, packet){
        const socket = client && client.sock;
        // A client changes from the abstract handshake object to a scoped
        // lobby/game object while keeping the same socket.  Keeping the queue
        // on that socket preserves ordering across the scope transition too.
        const queueOwner = socket || client;
        const previous = queueOwner._packetDispatchQueue || Promise.resolve();
        const current = previous.then(() => {
            if(queueOwner._protocolFailed || client.disconnected || (socket && socket.destroyed)) return;
            return this.dispatch(client, packet);
        });

        queueOwner._packetDispatchQueue = current.catch((error) => {
            this.handleProtocolError(client, error, packet);
        });
        client._packetDispatchQueue = queueOwner._packetDispatchQueue;
        return queueOwner._packetDispatchQueue;
    }

    handleProtocolError(client, error, packet){
        const socket = client && client.sock;
        const failureOwner = socket || client;
        if(failureOwner && failureOwner._protocolFailed) return;
        if(failureOwner) failureOwner._protocolFailed = true;
        if(client) client._protocolFailed = true;

        const message = error instanceof Error ? error.message : String(error);
        console.error("protocol_error", {
            clientId: client && (client.id || (client.player && client.player.id)),
            connectionType: client && client.connectionType,
            command: packet && packet.command,
            message: message
        });
        this.closeClientSocket(socket);
    }

    closeClientSocket(socket){
        if(!socket || socket.destroyed) return;
        try {
            // Flush any packet already queued for the peer, then close.  The
            // fallback timer prevents a half-open peer from holding resources.
            if(typeof socket.destroySoon === "function" && socket.writable !== false){
                socket.destroySoon();
                return;
            }
            if(typeof socket.end === "function" && socket.writable !== false && !socket.writableEnded){
                socket.end();
            }
            const closeTimer = setTimeout(() => {
                if(!socket.destroyed && typeof socket.destroy === "function") socket.destroy();
            }, 250);
            if(typeof closeTimer.unref === "function") closeTimer.unref();
        } catch(closeError){
            if(typeof socket.destroy === "function") socket.destroy();
        }
    }
    //### Packet processing ###

    handle(client, chunk){
        if(!chunk || !chunk.length) return;
        client._protocolBuffer = Buffer.concat([client._protocolBuffer || Buffer.alloc(0), Buffer.from(chunk)]);
        const policy = Buffer.from("<policy-file-request/>");
        if(!client.connectionType || client.connectionType === "abstract"){
            if(client._protocolBuffer.indexOf(policy) === 0){
                if(client._protocolBuffer.length < policy.length) return;
                client.write('<cross-domain-policy><allow-access-from domain="*" to-ports="80,8000" /></cross-domain-policy>\0');
                client._protocolBuffer = Buffer.alloc(0);
                return;
            }
            const marker = client._protocolBuffer.indexOf(Buffer.from("\r\n\r\n"));
            if(marker < 0){
                if(client._protocolBuffer.length > 8192) throw new Error("handshake too large");
                return;
            }
            const header = client._protocolBuffer.subarray(0, marker).toString("utf8");
            const match = /^POST\s+([^\s]+)\s+HTTP\/1\.1$/m.exec(header);
            if(!match) throw new Error("invalid handshake");
            client._protocolBuffer = client._protocolBuffer.subarray(marker + 4);
            client = this.initializeClient(client, match[1]);
        }
        while(client._protocolBuffer.length >= 6){
            const lengthText = client._protocolBuffer.subarray(0, 6).toString("ascii");
            if(!/^\d{6}$/.test(lengthText)) throw new Error("invalid frame length");
            const length = Number(lengthText);
            if(client._protocolBuffer.length < 6 + length) return;
            const body = client._protocolBuffer.subarray(6, 6 + length);
            client._protocolBuffer = client._protocolBuffer.subarray(6 + length);
            let packet;
            try { packet = JSON.parse(body.toString("utf8")); } catch { throw new Error("invalid json frame"); }
            this.queueDispatch(client, packet);
        }
    }

    initializeClient(client, requestPath){
        const url = new URL(requestPath, "http://protocol.local");
        const type = url.pathname.split("/")[2];
        if(!["lobby", "ladder", "game"].includes(type)) throw new Error("invalid connection type");
        client.connectionType = type;
        let state;
        if(type === "game"){
            const gameId = url.searchParams.get("guid");
            const session = url.searchParams.get("session");
            if(!gameId || !session) throw new Error("missing game session");
            state = new GameClient(client);
            state.gameId = gameId;
            state.gameSession = session;
        } else if(type === "lobby") state = new LobbyClient(client);
        else state = new LadderClient(client);
        state._protocolBuffer = client._protocolBuffer;
        client.fireChangeEvent();
        state.WOPW.addClient(state);
        return state;
    }

    dispatch(client, packet){
        if(!packet || typeof packet.command !== "string") throw new Error("invalid packet");
        if(client.connectionType === "lobby") return this.handleLobbyCommand(client, packet);
        if(client.connectionType === "ladder") return this.handleLadderCommand(client, packet);
        return this.handleGameCommand(client, packet);
    }

    //### Packet handling ###

    handleLobbyCommand(client, packet){
        if(!client.loggedIn && packet.command !== "logIn" && packet.command !== "ping") return;
        switch(packet.command) {
            case "logIn":
                console.log("handling login");
                return this.handleLogin(client, packet);
            case "leaderboard_fetch":
                return this.handleLeaderboardFetch(client, packet);
            case "leaderboard_player_fetch":
                return this.handleLeaderboardPlayerFetch(client, packet);
            case "dname":
                break;
            case "ping":
                this.handlePing(client);
                break;
            case "setNewPlayerFlag":
                this.handleNewPlayerFlag(client, packet);
                break;
            case "private_feature":
                this.handleHiddenLegacyFeature(client, packet);
                break;
            case "modify_pet":
                this.handlePetModification(client, packet);
                break;
            case "quick_play":
                return this.handleQuickPlay(client, packet);
            case "chance_wheel":
                this.handleChanceWheel(client, packet);
                break;
            case "slotmachine":
                this.handleSlotMachine(client, packet);
                break;
            case "collection_roll":
                return this.handleCollectionRoll(client, packet);
            case "get_medals":
                this.handleGetMedals(client, packet);
                break;
            case "xpromo_fetch":
                this.handleSetXPromoPopup(client, packet);
                break;
            case "set_prize_flag":
                this.handleSetPrizeFlag(client, packet);
                break;
            case "news":
                this.handleShowNewsPopUp(client, packet);
                break;   
            case "change_pet":
                this.handleChangePet(client, packet);
                break;
            case "buy_accessory":
                return this.handleBuyAccessory(client, packet);
            case "buy_unlock":
                this.handleBuyUnlock(client, packet);
                break;
            case "buy_map":
                return this.handleBuyMap(client, packet);
            case "buy_stat_point":
                this.handleBuyStatPoint(client, packet);
                break;
            case "buy_combo":
                this.handleBuyCombo(client, packet);
                break;
            case "buy_coin_pack":
            case "local_offer":
                this.handleLocalOffer(client, packet);
                break;
            case "set_hotkeys":
                this.handleSetHotkeys(client, packet);
                break;
            case "levelup_pet":
                this.handleLevelUpPet(client, packet);
                break;
            case "neuter_pet":
                this.handleLegacyPetPrune(client, packet);
                break;
            case "member":
                this.handleBecomeMember(client, packet);
                break;
            case "claim_member":
                this.handleClaimMember(client, packet);
                break;
            case "xpromo":
            case "xpromo_reward":
                this.handleXPromoReward(client, packet);
                break;
            case "idlegift":
                this.handleClaimIdleGift(client, packet);
                break;    
            case "claim_mystery":
                this.handleMysteryGift(client, packet);
                break;
            case "give_medal":
                // MedalManager is advisory client UI only. Progression medals
                // are awarded from validated server events below.
                client.sendPacket({ command: "medal_ignored" });
                break;
            case "set_acc_load":
                this.handleAccLoad(client, packet);
                break;
            case "buy_pet":
                return this.handleBuyPet(client, packet);
            case "delete_pet":
                return this.handleDeletePet(client, packet);
            case "buy_ammo":
                return this.handleBuyAmmo(client, packet);
            case "cook_food":
                this.handleCookFood(client, packet);
                break;
            case "harvest_food":
                this.handleHarvestFood(client, packet);
                break;
            case "eat_food":
                this.handleEatFood(client, packet);
                break;
            case "cancel_food":
                this.handleCancelFood(client);
                break;
            case "set_weapons_equipped":
                this.handleSetWeaponsEquipped(client, packet);
                break;
            case "game_name_check":
                this.handleGameNameCheck(client, packet);
                break;
            case "create_game":
                return this.handleCreateGame(client, packet);
            case "join_game":
                return this.handleJoinGame(client, packet);
            default:
                console.log("!! Unhandled lobby command: " + packet.command, packet);
                break;
        }
    }

    handleLadderCommand(client, packet){
        switch(packet.command){
            case "ping":
                this.handlePing(client);
                break;
        }
    }

    handleGameCommand(client, packet){
        //console.log("PACKET HANDLING: " + packet + "\n");
        client.lastMessageTime = Date.now();
        if(!client.loggedIn && packet.command !== "start_server_connect" && packet.command !== "ping") return;
        switch(packet.command){
            case "logIn":
                return this.handleLogin(client, packet);
            case "give_medal":
                // Client medals are advisory UI only. Awards are emitted from
                // validated combat, crate, purchase and match events.
                client.sendPacket({ command: "medal_ignored" });
                break;    
            case "ping":
                this.handlePing(client);
                break;
            case "start_server_connect":
                return this.handleStartServerConnect(client, packet);
            case "chat":
                this.handleChat(client, packet);
                break;
            case "on_ready":
                return this.handleOnReady(client, packet);
            case "not_ready":
                this.handleNotReady(client, packet);
                break;
            case "map_loaded":
                return this.handleMapLoad(client, packet);
            case "bot_ai_ready":
                if(client.getGame() && !client.isBot){
                    var readyGame = client.getGame();
                    client.botAiProtocol = Number(packet.protocol || 1);
                    readyGame.nativeBotAICapable = readyGame.getBotRendererId() != null;
                    // This packet only proves the renderer understands the
                    // protocol. Native AI is enabled later, after the exact
                    // server-created bot roster exists in that renderer.
                    readyGame.nativeBotAI = false;
                    readyGame.nativeBotRosterReady = false;
                    readyGame.nativeBotTimeouts = 0;
                    readyGame.botController.reset();
                    console.log(">> Native SWF bot AI capability v" + client.botAiProtocol + " received for game " + readyGame.gameId);
                }
                break;
            case "bot_roster_ready":
                if(client.getGame() && !client.isBot){
                    var rosterGame = client.getGame();
                    var rosterAccepted = rosterGame.acknowledgeBotRoster(client, packet);
                    console.log(">> Native SWF bot roster ready: game=" + rosterGame.gameId + "; renderer=" + client.player.id + "; accepted=" + rosterAccepted);
                }
                break;
            case "bot_action":
                this.handleBotAction(client, packet);
                break;
            case "bot_turn_complete":
                this.handleBotTurnComplete(client, packet);
                break;
            case "synch_check":
                this.handleSynchCheck(client, packet);
                break;
            /*have to be processed*/
            case "move_left":
                this.handleMoveLeft(client, packet);
                break;
            case "move_right":
                this.handleMoveRight(client, packet);
                break;
            case "move_stop":
                this.handleMoveStop(client, packet);
                break;
            case "move_jump":
                this.handleMoveJump(client, packet);
                break;
            case "projectile":
                this.handleProjectile(client, packet);
                break;
            case "damage":
                this.handleDamage(client, packet);
                break;
            case "health_state":
                this.handleHealthState(client, packet);
                break;
            case "world_fall":
                this.handleWorldFall(client, packet);
                break;
            /*need not to be processed*/
            case "turn_complete":
                this.handleTurnComplete(client, packet);
                break;
            case "position":
                this.handlePosition(client, packet);
                break;
            case "request_synch":
                this.handleRequestSynch(client, packet);
                break;
            case "set_aim":
                this.handleSetAim(client, packet);
                break;
            case "start_fire":
                this.handleStartFire(client, packet);
                break;
            case "cancel_fire":
                this.handleCancelFire(client, packet);
                break;
            case "equip":
                this.handleEquip(client, packet);
                break;
            case "toggle_weapon":
                this.handleToggleWeapon(client, packet);
                break;
            case "retract_rope":
                this.handleRetractRope(client, packet);
                break;
            case "release_rope":
                this.handleReleaseRope(client, packet);
                break;
            case "stop_rope":
                this.handleStopRope(client, packet);
                break;
            case "detach":
                this.handleDetach(client, packet);
                break;
            case "teleport_stop":
                this.handleTeleportStop(client, packet);
                break;
            case "player_died":
                this.handlePlayerDied(client, packet);
                break;
            case "player_kill":
            case "player_killed":
                this.handlePlayerKill(client, packet);
                break;
            case "respawn_ready":
                this.handleRespawnReady(client, packet);
                break;
            case "terrain_explosion":
                this.handleTerrainExplosion(client, packet);
                break;
            case "terrain_explosion_batch":
                this.handleTerrainExplosionBatch(client, packet);
                break;
            case "runtime_metrics":
                this.handleRuntimeMetrics(client, packet);
                break;
            case "client_finished_playing":
                client.getGame().sendPacketE({ command: "client_finished_playing", id: client.player.id }, client);
                break;
            case "synch_pts":
                this.handleSynchPts(client, packet);
                break;
            case "log_projectile":
                // Never use a client-controlled value as a log filename.
                break;
            case "synchronization":
                this.handleSynch(client, packet);
                break;
            case "exiting":
                this.handleExiting(client, packet);
                break;
        }
    }

    async handleLogin(client, data){
        if(!data.dname || !data.snum){
            return;
        }
        try {
            const session = await client.db.fetchSession(data.snum);
            if(!session) return;
            const doc = await client.db.fetch({"id" : session.userId});
            if(!doc) return;
            if(doc.dname !== data.dname) return;
            client.authToken = data.snum;
            client.loggedIn = true;
            if(client.setupPlayer(doc) == -1) return;
            // The v26 SWF consumes `player` as its initial profile command.
            // sendPlayerSetup already emits that full compatibility DTO. Sending
            // sendUpdate immediately afterwards sent the same ~22 KB packet a
            // second time during Flash/Ruffle startup, which made the client
            // abandon the socket at the 90% loading screen.
            client.sendPlayerSetup();
        } catch(e){
            throw e;
        }
    }

    handlePing(client){
        client.sendPacket({"command" : "ping_ack"});
    }

    async handleLeaderboardFetch(client, data){
        const requestedSort = String(data.sort_key || "wins").toLowerCase();
        const page = await client.db.leaderboardPage(
            requestedSort,
            data.start_rank,
            data.num_results,
            client.player.id
        );
        const results = page.results.map((player, index) => {
            const games = Math.max(0, Number(player.stats.games) || 0);
            const wins = Math.max(0, Number(player.stats.wins) || 0);
            return {
                rank: page.startRank + index,
                dname: String(player.dname || ""),
                level: levelFromXp(player.xp, this.WOPW.levelsObj),
                wins: wins,
                losses: Math.max(0, Number(player.stats.losses) || 0),
                kills: Math.max(0, Number(player.stats.kills) || 0),
                deaths: Math.max(0, Number(player.stats.deaths) || 0),
                games: games,
                winRate: games ? Math.round((wins / games) * 1000) / 10 : 0,
                neighbors: 0,
                snum: String(player.id),
                net: String(player.net || "M")
            };
        });
        client.sendPacket({
            command: "leaderboard_return",
            sort_key: page.sortKey,
            start_rank: page.startRank,
            results: results,
            table_size: page.tableSize,
            my_rank: page.myRank,
            revision: page.revision
        });
        return results;
    }

    async handleLeaderboardPlayerFetch(client, data){
        const playerId = Number(data.snum);
        if(!Number.isSafeInteger(playerId) || playerId < 0) return null;
        const player = await client.db.fetch({ id: playerId });
        if(!player) return null;
        normalizeProfileState(player);

        const games = Math.max(0, Number(player.stats.games) || 0);
        const wins = Math.max(0, Number(player.stats.wins) || 0);
        const currentPetId = String(player.currentPet || "");
        const currentPet = player.ownedPets && player.ownedPets[currentPetId];
        const safePet = currentPet ? {
            id: currentPetId,
            type: String(currentPet.type || "rabbit"),
            name: String(currentPet.name || ""),
            gender: String(currentPet.gender || "M"),
            pers: String(currentPet.pers || "brave"),
            color1: currentPet.color1,
            color2: currentPet.color2,
            accessories: Array.isArray(currentPet.accessories) ? currentPet.accessories.map(String) : [],
            played: Math.max(0, Number(currentPet.played) || 0),
            wins: Math.max(0, Number(currentPet.wins) || 0),
            losses: Math.max(0, Number(currentPet.losses) || 0),
            kills: Math.max(0, Number(currentPet.kills) || 0),
            deaths: Math.max(0, Number(currentPet.deaths) || 0),
            gold: Math.max(0, Number(currentPet.gold) || 0),
            last: Math.max(0, Number(currentPet.lastPlayed) || 0)
        } : null;
        const ownedPets = {};
        if(safePet) ownedPets[currentPetId] = safePet;

        const response = {
            command: "leaderboard_player",
            id: String(player.id),
            snum: String(player.id),
            dname: String(player.dname || ""),
            net: String(player.net || "M"),
            xp: Math.max(0, Number(player.xp) || 0),
            level: levelFromXp(player.xp, this.WOPW.levelsObj),
            gamecount: games,
            games: games,
            wins: wins,
            losses: Math.max(0, Number(player.stats.losses) || 0),
            kills: Math.max(0, Number(player.stats.kills) || 0),
            deaths: Math.max(0, Number(player.stats.deaths) || 0),
            winRate: games ? Math.round((wins / games) * 1000) / 10 : 0,
            neighbors: 0,
            currentPet: currentPetId,
            ownedPets: ownedPets
        };
        client.sendPacket(response);
        return response;
    }

    handleNewPlayerFlag(client, data){
        client.player.nw = -1;
        client.updatePlayerData();
    }

    handlePetModification(client, data){
        console.log("[" + client.connectionType  +"] handlePetModification");
        if(!client.player) console.log("no player data!");
        if(!client.player.ownedPets[data.petid]){
            console.log("*** Pet id is not valid");
            return;
        }

        client.player.ownedPets[data.petid].color1 = data.color1;
        client.player.ownedPets[data.petid].color2 = data.color2;
        client.player.ownedPets[data.petid].name   = data.name;
        client.updatePlayerData();
    }

    persistLobbyPlayer(client){
        ensureProgression(client.player);
        client.sendUpdate();
        client.updatePlayerData();
    }

    purchaseRequestId(data){
        const provided = String(data && data.requestId || "");
        return provided && provided.length <= 128 ? provided : crypto.randomUUID();
    }

    purchaseReply(client, command, requestId, value, reason, item, quantity, currency, details){
        const balance = currency === "treats"
            ? Math.max(0, Number(client.player.treats) || 0)
            : Math.max(0, Number(client.player.gold) || 0);
        client.sendPacket(Object.assign({
            command: command,
            requestId: requestId,
            value: Boolean(value),
            reason: value ? null : String(reason || "unknown_item"),
            item: String(item || ""),
            quantity: Math.max(1, Math.floor(Number(quantity) || 1)),
            currency: currency || "gold",
            balance: balance
        }, details || {}));
    }

    syncPurchaseUser(client, user){
        if(!user) return;
        for(const field of [
            "gold", "treats", "userAccessories", "durability", "allowedMaps",
            "userWeaponsOwned", "ownedPets", "currentPet", "nextPetId",
            "transactions", "collections", "stats", "wins", "losses", "gamecount",
            "kills", "deaths", "schemaVersion"
        ]){
            if(user[field] !== undefined) client.player[field] = user[field];
        }
        ensureProgression(client.player);
    }

    chargeCurrency(client, currency, amount){
        amount = Math.max(0, Math.floor(Number(amount) || 0));
        if(!amount || client.player.sandbox || client.player.unlimitedInventory) return true;
        if(currency !== "gold" && currency !== "treats") return false;
        var balance = Math.max(0, Math.floor(Number(client.player[currency]) || 0));
        if(balance < amount) return false;
        client.player[currency] = balance - amount;
        return true;
    }

    recordStat(client, name, amount){
        if(!client || !client.player) return;
        recordPlayerStat(client.player, name, amount);
    }

    awardProgressionMedal(client, type){
        if(!client || !client.player) return false;
        var event = recordMedalEvent(client.player, type);
        if(!event.unlocked.length) return false;
        client.sendPacket({
            command: "medal_unlock",
            ...this.medalCollectionPayload(client),
            newItems: [type]
        });
        return true;
    }

    async handleBuyMap(client, data){
        if(client.connectionType !== "lobby") return false;
        const requestId = this.purchaseRequestId(data);
        const mapName = String(data.mapName || data.name || "");
        const map = this.WOPW.mapsObj && this.WOPW.mapsObj[mapName];
        if(!isSupportedMapName(mapName)){
            this.purchaseReply(client, "mapPurchase", requestId, false, "unknown_item", mapName, 1, "gold");
            return false;
        }
        if(!map){
            this.purchaseReply(client, "mapPurchase", requestId, false, "unknown_item", mapName, 1, "gold");
            return false;
        }
        const currency = map.currency === "treats" ? "treats" : "gold";
        const price = client.player.unlimitedInventory ? 0 : Math.max(0, Number(map.price || 0) || 0);
        const result = await client.db.applyPurchase({
            userId: client.player.id,
            requestId,
            kind: "map",
            item: mapName,
            quantity: 1,
            currency,
            cost: price,
            filter: { allowedMaps: { $ne: mapName } },
            update: {
                $addToSet: { allowedMaps: mapName },
                $inc: { "stats.purchases": 1 }
            }
        });
        if(result.user) this.syncPurchaseUser(client, result.user);
        if(!result.ok){
            const owned = Array.isArray(client.player.allowedMaps) && client.player.allowedMaps.includes(mapName);
            this.purchaseReply(client, "mapPurchase", requestId, false, owned ? "already_owned" : result.reason, mapName, 1, currency);
            return false;
        }
        client.sendUpdate();
        this.purchaseReply(client, "mapPurchase", requestId, true, null, mapName, 1, currency, {
            mapName,
            duplicate: Boolean(result.duplicate)
        });
        return true;
    }

    handleBuyStatPoint(client, data){
        if(client.connectionType !== "lobby") return false;
        var count = Number(data.count);
        if(Object.prototype.hasOwnProperty.call(STAT_POINT_PACKAGES, count)){
            var treatCost = STAT_POINT_PACKAGES[count];
            if(!this.chargeCurrency(client, "treats", treatCost)){
                client.sendPacket({ command: "buy_stat_point_return", value: false, reason: "not_enough_treats" });
                return false;
            }
            client.player.statPoints = Math.max(0, Number(client.player.statPoints || 0)) + count;
            client.player.st = client.player.statPoints;
            this.persistLobbyPlayer(client);
            client.sendPacket({ command: "buy_stat_point_return", value: true, count: count, cost: treatCost });
            return true;
        }
        var aliases = { "0": "speed", "1": "attack", "2": "defence", "3": "jump", defence: "defence", defense: "defence", speed: "speed", attack: "attack", jump: "jump" };
        var statValue = data.stat != null ? data.stat : (data.type != null ? data.type : data.value);
        var stat = aliases[String(statValue == null ? "" : statValue).toLowerCase()];
        if(!stat) return false;
        var available = Number(client.player.statPoints);
        if(!Number.isFinite(available)) available = 50;
        if(available <= 0 || Number(client.player[stat] || 0) >= 200) return false;
        client.player[stat] = Number(client.player[stat] || 0) + 1;
        client.player.statPoints = available - 1;
        client.player.st = client.player.statPoints;
        this.persistLobbyPlayer(client);
        return true;
    }

    handleBuyCombo(client, data){
        if(client.connectionType !== "lobby") return false;
        var type = String(data.type || data.combo || data.value || "");
        var other = this.WOPW.assetsObj && this.WOPW.assetsObj.Other || {};
        var bundles = Array.isArray(other.comboTypes) ? other.comboTypes : [];
        var bundle = bundles.find(function(candidate){ return candidate && candidate.type === type; });
        if(!bundle){
            client.sendPacket({ command: "combo_return", type: type, value: { error: "unknown_bundle" } });
            return false;
        }
        var isMember = Boolean(client.player.membership && client.player.membership.active);
        var currency = isMember && bundle.memberCurrency ? bundle.memberCurrency : bundle.currency;
        var price = isMember && bundle.memberPrice != null ? bundle.memberPrice : bundle.price;
        var rewardGroups = bundle.rewards && typeof bundle.rewards === "object" ? bundle.rewards : {};
        var comboRewards = other.comboRewards && typeof other.comboRewards === "object" ? other.comboRewards : {};
        var accessories = this.WOPW.accessoriesObj || {};
        var draws = [];
        for(var rewardGroup in rewardGroups){
            var count = Math.max(0, Math.floor(Number(rewardGroups[rewardGroup]) || 0));
            var choices = (Array.isArray(comboRewards[rewardGroup]) ? comboRewards[rewardGroup] : []).filter(function(candidate){
                var candidateType = candidate && Object.keys(candidate)[0];
                var candidateEntry = this.WOPW.weaponCatalog && this.WOPW.weaponCatalog.entries.get(candidateType);
                return Boolean(candidateType && (accessories[candidateType] || (candidateEntry && candidateEntry.selectable)));
            }.bind(this));
            if(count > 0 && choices.length === 0){
                client.sendPacket({ command: "combo_return", type: type, value: { error: "invalid_bundle_catalog" } });
                return false;
            }
            for(var drawIndex = 0; drawIndex < count; drawIndex++){
                var picked = choices[crypto.randomInt(0, choices.length)];
                var rewardType = picked && Object.keys(picked)[0];
                var rewardAmount = Math.max(1, Math.floor(Number(picked && picked[rewardType]) || 1));
                draws.push({ type: rewardType, amount: rewardAmount, accessory: Boolean(accessories[rewardType]) });
            }
        }
        if(!draws.length){
            client.sendPacket({ command: "combo_return", type: type, value: { error: "empty_bundle" } });
            return false;
        }
        if(!this.chargeCurrency(client, currency, price)){
            client.sendPacket({ command: "combo_return", type: type, value: { error: "not_enough_currency" } });
            return false;
        }
        if(!client.player.combos || typeof client.player.combos !== "object") client.player.combos = {};
        client.player.combos[type] = Math.max(1, Number(client.player.combos[type] || 0) + 1);
        if(!Array.isArray(client.player.userAccessories)) client.player.userAccessories = [];
        if(!client.player.durability || typeof client.player.durability !== "object") client.player.durability = {};
        var reward = {};
        for(var resultIndex = 0; resultIndex < draws.length; resultIndex++){
            var result = draws[resultIndex];
            reward[result.type] = Number(reward[result.type] || 0) + result.amount;
            if(result.accessory){
                if(client.player.userAccessories.indexOf(result.type) < 0){
                    client.player.userAccessories.push(result.type);
                    client.player.durability[result.type] = Math.max(1, Number(client.player.durability[result.type] || 30));
                }
            }else{
                rewardPlayer(client.player, { [result.type]: result.amount });
            }
        }
        this.recordStat(client, "purchases", 1);
        this.persistLobbyPlayer(client);
        client.sendPacket({ command: "combo_return", type: type, value: reward });
        return true;
    }

    handleBuyUnlock(client, data){
        if(client.connectionType !== "lobby") return false;
        var type = String(data.type || "");
        var weapon = this.WOPW.weaponsObj[type];
        var entry = this.WOPW.weaponCatalog && this.WOPW.weaponCatalog.entries.get(type);
        if(!weapon || !entry || !entry.selectable || !entry.shopVisible) return false;
        ensureProgression(client.player);
        if(client.player.weaponUnlocks[type]){
            client.sendPacket({ command: "buy_unlock_return", type: type, value: true, duplicate: true });
            return true;
        }
        var price = Math.max(0, Number(weapon.unlockPrice != null ? weapon.unlockPrice : weapon.price) || 0);
        var currency = weapon.unlockCurrency || weapon.currency || "gold";
        if(!this.chargeCurrency(client, currency, price)){
            client.sendPacket({ command: "buy_unlock_return", type: type, value: false, reason: "not_enough_currency" });
            return false;
        }
        client.player.weaponUnlocks[type] = true;
        var initialAmmo = Math.max(1, Number(weapon.purchaseAmount || weapon.initAmmo || 1));
        client.player.userWeaponsOwned[type] = Math.max(initialAmmo, Number(client.player.userWeaponsOwned[type] || 0));
        this.persistLobbyPlayer(client);
        client.sendPacket({ command: "buy_unlock_return", type: type, value: true, ammo: initialAmmo });
        return true;
    }

    handleSlotMachine(client, data){
        if(client.connectionType !== "lobby") return false;
        ensureProgression(client.player);
        if(client._slotSpinPending) return false;
        var bet = Math.max(1, Math.min(3, Math.floor(Number(data.credits) || 1)));
        if(!this.chargeCurrency(client, "treats", bet)){
            client.sendPacket({ command: "slotmachine_return", error: "not_enough_treats" });
            return false;
        }
        client._slotSpinPending = true;
        var reels = [crypto.randomInt(0, 6), crypto.randomInt(0, 6), crypto.randomInt(0, 6)];
        var creditsWon = reels[0] === reels[1] && reels[1] === reels[2] ? bet * 10 : (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2] ? bet * 2 : 0);
        var gold = creditsWon > 0 ? creditsWon * 15 : 0;
        var xp = creditsWon > 0 ? creditsWon * 10 : 0;
        rewardPlayer(client.player, { treats: creditsWon, gold: gold, xp: xp });
        this.persistLobbyPlayer(client);
        client._slotSpinPending = false;
        client.sendPacket({ command: "slotmachine_return", reel0: reels[0], reel1: reels[1], reel2: reels[2], creditsWon: creditsWon, xp: xp, gold: gold });
        return true;
    }

    handleLocalOffer(client, data){
        if(client.connectionType !== "lobby") return false;
        var type = String(data.type || data.offer || "");
        var offers = { more_gold: { gold: 1000 }, more_xp: { xp: 1000 }, more_treats: { treats: 25 }, cart: { gold: 500, treats: 10 } };
        var reward = offers[type];
        if(!reward) return false;
        ensureProgression(client.player);
        var lastClaim = Number(client.player.promos["offer:" + type] || 0);
        if(Date.now() - lastClaim < 60 * 60 * 1000){
            client.sendPacket({ command: "local_offer_return", type: type, value: false, reason: "cooldown" });
            return false;
        }
        client.player.promos["offer:" + type] = Date.now();
        var granted = rewardPlayer(client.player, reward);
        this.persistLobbyPlayer(client);
        client.sendPacket({ command: "local_offer_return", type: type, value: granted });
        return true;
    }

    handleSetHotkeys(client, data){
        if(client.connectionType !== "lobby") return false;
        var entries = data.hotkeys || data.value;
        if(!entries || typeof entries !== "object" || Array.isArray(entries)) return false;
        var hotkeys = {};
        var utility = ["walk", "bone", "superjump", "climb", "punch", "dig", "mortar", "empty"];
        for(var key in entries){
            if(!/^[1-8]$/.test(String(key))) return false;
            var weapon = String(entries[key] || "");
            if(utility.indexOf(weapon) < 0 && !client.player.userWeaponsOwned[weapon]) return false;
            hotkeys[key] = weapon;
        }
        client.player.hotkeys = hotkeys;
        this.persistLobbyPlayer(client);
        return true;
    }

    handleLevelUpPet(client, data){
        if(client.connectionType !== "lobby") return false;
        // v23 sends `pet` and compact stat names (st/de/vi).  Older clients
        // used petId and a generic level button; keep that path intact.
        var petId = String(data.pet || data.petId || client.player.currentPet);
        var pet = client.player.ownedPets && client.player.ownedPets[petId];
        if(!pet) return false;

        var statNames = { st: "strength", de: "dexterity", vi: "vitality" };
        var statKey = statNames[String(data.type || "").toLowerCase()];
        if(statKey){
            var available = Number(client.player.statPoints);
            if(!Number.isFinite(available)) available = 50;
            var compactKey = String(data.type).toLowerCase();
            var current = Number(pet[compactKey]);
            if(!Number.isFinite(current)) current = Number(pet[statKey] || 0);
            if(available <= 0 || current >= 100) return false;
            current += 1;
            pet[compactKey] = current;
            pet[statKey] = current;
            client.player.statPoints = available - 1;
            // The movie reads this compact field directly on every player
            // update, while the database keeps statPoints as the canonical
            // descriptive field.
            client.player.st = client.player.statPoints;
            this.persistLobbyPlayer(client);
            return true;
        }

        pet.level = Math.min(100, Math.max(1, Number(pet.level || 1) + 1));
        this.persistLobbyPlayer(client);
        return true;
    }

    handleLegacyPetPrune(client, data){
        if(client.connectionType !== "lobby") return false;
        // The old member-only clean-up command must never delete a private
        // server player's pet collection. A normal profile update lets the
        // client dismiss its legacy prompt without losing data.
        this.persistLobbyPlayer(client);
        return true;
    }

    handleHiddenLegacyFeature(client, data){
        if(client.connectionType !== "lobby") return false;
        client.sendPacket({ command: "private_feature_hidden", feature: data.command });
        return true;
    }

    async handleQuickPlay(client, packet){
        var mapDetails = this.WOPW.validateMapDetails(client, packet);
        if(mapDetails.mapError){
            this.sendGameJoinFailed(client, mapDetails.mapError, {
                map: packet.mapName || null,
                setting: mapDetails.invalidSetting || null
            });
            return false;
        }
        if(DEBUG)
            console.log(">> Validated map details");
        var gameId = this.WOPW.findSlot(client, mapDetails, null);

        if(DEBUG)
            console.log(">> Found slot");
        if(gameId == 0){
            this.sendGameJoinFailed(client, "capacity");
            return false;
        }

        this.sendResolvedRoomSettings(client, mapDetails);
        client.gameId  = gameId;
        await client.sendJoinGame();
        return true;
    }

    async handleStartServerConnect(client, data){
        if(!client) return;
        try {
            const session = await client.db.fetchSession(client.gameSession, client.gameId);
            if(session && session.gameJoinExpiresAt && session.gameJoinExpiresAt > new Date()){
                const doc = await client.db.fetch({"id" : session.userId});
                if(!doc) return;
                if(doc.dname !== data.userId) return;
                if(!client.getGame()) return;
                if(client.setupPlayer(doc) == -1 || !client.player.id) return;

                // The game socket has its own authenticated state.  Without
                // setting it here, handleGameCommand accepts the handshake and
                // then silently drops every map, shot, damage, death and turn
                // packet sent over the same validated connection.
                client.loggedIn = true;

                if(client.getGame().isFull()){
                    // The session token is scoped to the lobby-selected game.
                    // Redirecting after authentication admitted the socket to a
                    // different room without a token for that room.
                    client.sendPacket({
                        command: "game_join_failed",
                        code: "full"
                    });
                    return;
                }

                client.getGame().addClient(client);
                client.sendGamePlayers();
                client.sendToGame(client.player);
                client.updateGame();
                client.getGame().stopGameStart();
            }
        } catch(e){
            throw e;
        }
    }

    handleChat(client, data) {
        const text = String(data.text || "").trim().slice(0, 200);
        if (!text || !client.getGame()) return;
        data.text = text;
        // The sender must receive this too: its own SWF is responsible for
        // rendering the speech bubble above the avatar.
        client.getGame().sendPacket(data);
        client.lastMessageTime = Date.now();
    }

    foodState(client) {
        if (!client.player.equippedFoods) client.player.equippedFoods = {};
        if (!Array.isArray(client.player.cookingFoods)) client.player.cookingFoods = [];
        if (!Array.isArray(client.player.eatenFoods)) client.player.eatenFoods = [];
    }

    handleCookFood(client, data) {
        if (client.connectionType !== "lobby") return;
        const food = this.WOPW.petFoodsObj[data.type];
        if (!food) return;
        this.foodState(client);
        if (client.player.cookingFoods.length > 0) return;
        const price = Number(food.price);
        const paid = this.chargeCurrency(client, food.currency === "treats" ? "treats" : "gold", price);
        if (!paid) return;
        client.player.cookingFoods.push([food.type, Date.now()]);
        this.persistLobbyPlayer(client);
    }

    handleHarvestFood(client, data) {
        if (client.connectionType !== "lobby") return;
        const food = this.WOPW.petFoodsObj[data.type];
        if (!food) return;
        this.foodState(client);
        const order = client.player.cookingFoods[client.player.cookingFoods.length - 1];
        // The SWF serializes startTime with its own time offset.  The stored
        // order is the identity; never let a client timestamp decide freshness.
        if (!order || order[0] !== food.type) return;
        const elapsed = Date.now() - Number(order[1]);
        const prepTime = Number(food.prepTime) * 1000;
        if (elapsed < prepTime) return;
        client.player.cookingFoods.pop();
        const expireTime = Math.max(0, Number(food.expireTime || 3600)) * 1000;
        if (elapsed <= prepTime + expireTime || prepTime === 0) {
            client.player.equippedFoods[food.type] = Number(client.player.equippedFoods[food.type] || 0) + 1;
        }
        this.persistLobbyPlayer(client);
    }

    handleEatFood(client, data) {
        if (client.connectionType !== "lobby") return;
        const food = this.WOPW.petFoodsObj[data.type];
        if (!food) return;
        this.foodState(client);
        if (Number(client.player.equippedFoods[food.type] || 0) <= 0 || client.player.eatenFoods.length >= 3) return;
        client.player.equippedFoods[food.type] -= 1;
        if (client.player.equippedFoods[food.type] <= 0) delete client.player.equippedFoods[food.type];
        client.player.eatenFoods.push([food.type, Number(food.bonusTime)]);
        client.updatePlayerData();
        client.sendUpdate();
    }

    handleCancelFood(client) {
        if (client.connectionType !== "lobby") return;
        this.foodState(client);
        if (client.player.cookingFoods.length === 0) return;
        client.player.cookingFoods.pop();
        client.updatePlayerData();
        client.sendUpdate();
    }

    handleOnReady(client, data){
        client.getGame().updatePlayerStatus(client.player.id, "ready");
        if(DEBUG) console.log("client.player.status " + client.player.status);
        client.getGame().checkGame();
    }

    handleNotReady(client, data){
        var game = client.getGame();
        if(game.isRunning() || game.awaitingMapLoad) return;
        game.updatePlayerStatus(client.player.id, "not_ready");
        game.stopGameStart();
    }

    async handleMapLoad(client, data){
        var game = client.getGame();
        if(!game) return;
        var mapProtocol = Number(data.protocol);
        if(client.isBot || !Number.isInteger(mapProtocol) || mapProtocol < 3 || mapProtocol > 4 || data.value !== true || String(data.loadId || "") !== String(game.mapLoadId || "")){
            console.warn("map_load_rejected code=invalid_ack game=" + JSON.stringify(game.gameId) + "; renderer=" + client.player.id);
            return false;
        }
        if(data.map != null && String(data.map) !== String(game.mapName)){
            console.warn("map_load_rejected code=map_mismatch game=" + JSON.stringify(game.gameId) + "; renderer=" + client.player.id);
            return false;
        }
        try{
            // Respawn and fallback collision checks must see the same authored
            // terrain before startGame can assign avatars.
            await game.field.loadMapMask(game.mapName);
        }catch(error){
            console.error("map_load_failed game=" + JSON.stringify(game.gameId) + "; map=" + JSON.stringify(game.mapName) + "; error=" + error.message);
            return game.failMapLoad("map_asset_error");
        }
        return game.onMapLoaded(client, data.loadId);
    }

    handleSynchCheck(client, data){
        if(client.getGame().currentPlayer != client.player.id) return;
        client.getGame().lastSynchCheck = data;
        client.getGame().lastSynchTick = data.tick;
        client.getGame().lastSynchAt = Date.now();

        //client.getGame().sendPacketE(data, client);
    }

    handleMoveLeft(client, data){
        if(client.getGame().currentPlayer != client.player.id || client.avatar.locked){
            return;
        }

        client.avatar.isFacingRight = false;
        client.avatar.isWalkingLeft = true;
        client.avatar.isWalkingRight = false;
        if(client.getGame().recordProgression) client.getGame().recordProgression(client, "moves", 1);
        if(client.getGame().recordMatchMove) client.getGame().recordMatchMove(client);
        if(Array.isArray(data.d)) client.avatar.setPosition(data.d[0], data.d[1]);
        if(client.isBot) client.getGame().sendPacket(data);
        else client.getGame().sendPacketE(data, client);
    }

    handleMoveRight(client, data){
        if(client.getGame().currentPlayer != client.player.id || client.avatar.locked){
            return;
        }

        client.avatar.isFacingRight = true;
        client.avatar.isWalkingLeft = false;
        client.avatar.isWalkingRight = true;
        if(client.getGame().recordProgression) client.getGame().recordProgression(client, "moves", 1);
        if(client.getGame().recordMatchMove) client.getGame().recordMatchMove(client);
        if(Array.isArray(data.d)) client.avatar.setPosition(data.d[0], data.d[1]);
        if(client.isBot) client.getGame().sendPacket(data);
        else client.getGame().sendPacketE(data, client);
    }

    handleMoveJump(client, data){
        if(client.getGame().currentPlayer != client.player.id || client.avatar.locked){
            return;
        }

        client.avatar.jumpDirection = data.direction;
        client.avatar.waitingForJump = true;
        client.avatar.waitingForJumpTick = client.getGame().tick; //what tick?
        if(client.getGame().recordProgression) client.getGame().recordProgression(client, "moves", 1);
        if(client.getGame().recordMatchMove) client.getGame().recordMatchMove(client);
        if(Array.isArray(data.d)) client.avatar.setPosition(data.d[0], data.d[1]);
        if(client.isBot) client.getGame().sendPacket(data);
        else client.getGame().sendPacketE(data, client);
    }

    handleMoveStop(client, data){
        if(client.getGame().currentPlayer != client.player.id || client.avatar.locked){
            return;
        }

        client.avatar.isWalkingLeft = false;
        client.avatar.isWalkingRight = false;
        if(Array.isArray(data.d)) client.avatar.setPosition(data.d[0], data.d[1]);
        if(client.isBot) client.getGame().sendPacket(data);
        else client.getGame().sendPacketE(data, client);
    }

    handleTurnComplete(client, data){
        var game = client.getGame();
        if(game.currentPlayer != client.player.id){
            return;
        }
        if(data && data.turnEpoch != null && Number(data.turnEpoch) !== Number(game.turnEpoch)) return;
        if(data && data.generation != null &&
            Number(data.generation) !== Number(client.respawnGeneration || 0)) return;
        if(typeof game.shouldHoldTurnCompletion === "function" && game.shouldHoldTurnCompletion(client, data)) return;
        // The Flash client sends this only after all local physics objects have
        // settled. Without advancing the server turn here, AI games remain on
        // the completed player's turn indefinitely.
        client.avatar.locked = true;
        game.setNextTurn(0);
        game.sendChangeTurn();
    }

    handleBotTurnComplete(client, data){
        var game = client.getGame();
        if(!game) return;
        var botId = parseInt(data.id);
        var bot = game && game.clients[botId];
        if(client.isBot || !bot || !bot.isBot || parseInt(game.currentPlayer) !== botId) return;
        if(game.getBotRendererId && client.player && String(client.player.id) !== String(game.getBotRendererId())) return;
        if(data.turnEpoch != null && Number(data.turnEpoch) !== Number(game.turnEpoch)) return;
        if(data.controllerEpoch != null && Number(data.controllerEpoch) !== Number(game.botControllerEpoch)) return;
        if(data.generation != null && Number(data.generation) !== Number(bot.respawnGeneration || 0)) return;
        // In server-controller mode the renderer does not choose actions; it
        // only reports that the authoritative projectile/effects have settled.
        // Require a projectile from this exact turn so cached or early packets
        // cannot skip a bot turn.
        if(!game.nativeBotAI){
            var pending = game.botPendingProjectile;
            if(!pending || Number(pending.id) !== botId || Number(pending.turnEpoch) !== Number(game.turnEpoch)) return;
        }
        if(DEBUG) console.log(">> Rendered bot turn complete: " + botId);
        game.nativeBotTimeouts = 0;
        this.handleTurnComplete(bot, { id: botId, command: "turn_complete" });
    }

    handleBotAction(client, data){
        var game = client.getGame();
        // See handleBotTurnComplete: only the explicitly enabled native mode
        // may relay renderer-originated bot actions.
        if(!game || !game.nativeBotAI) return;
        var botId = parseInt(data.botId);
        var bot = game && game.clients[botId];
        if(client.isBot || !bot || !bot.isBot || parseInt(game.currentPlayer) !== botId) return;
        if(String(client.player.id) !== String(game.getBotRendererId())) return;
        if(Number(data.turnEpoch) !== Number(game.turnEpoch) || Number(data.controllerEpoch) !== Number(game.botControllerEpoch)) return;
        var seq = Number(data.seq);
        if(!Number.isFinite(seq) || seq <= Number(game.botActionSeq || 0)) return;
        if(!data.action || typeof data.action.command !== "string") return;
        if(data.action.command === "projectile" && data.action.ammo_type !== bot._assignedBotWeapon) return;
        game.botActionSeq = seq;
        var action = Object.assign({}, data.action, { id: bot.player.id });
        this.handleGameCommand(bot, action);
    }

    handlePosition(client, data){
        var game = client.getGame();
        if(!game || !client.avatar || client.isDead()) return;
        if(data.id != null && String(data.id) !== String(client.player.id)) return;
        if(data.generation != null && Number(data.generation) !== Number(client.respawnGeneration || 0)) return;
        var sequence = Number(data.sequence);
        if(!Number.isFinite(sequence) || sequence <= Number(client.positionSequence || 0)) return;
        client.positionSequence = sequence;
        var x = Number(data.x);
        var y = Number(data.y);
        var respawnGraceActive = Boolean(client.respawnGraceUntil && Date.now() < client.respawnGraceUntil);
        if(game && client.avatar && Number.isFinite(x) && Number.isFinite(y) && !respawnGraceActive){
            client.avatar.setPosition(x, y);
            client.avatar.Vx = Number.isFinite(Number(data.vx)) ? Number(data.vx) : 0;
            client.avatar.Vy = Number.isFinite(Number(data.vy)) ? Number(data.vy) : 0;
            var map = game.WOPW.mapsObj[game.mapName] || {};
            if(!client.isDead() && y > Number(map.height || game.field.height || 1400) + 10){
                console.log(">> Client-reported world death: " + client.player.id + " y=" + y);
                game.setPlayerDead(client.player.id, game.currentPlayer);
            }
        }
        var cmd = {};
        cmd["command"] = "position";
        // A queued pre-death position must not be relayed after the server has
        // assigned a new spawn. Other renderers would otherwise briefly move
        // the respawned avatar back into the fatal crater.
        cmd["x"] = respawnGraceActive ? client.avatar.X : data.x;
        cmd["y"] = respawnGraceActive ? client.avatar.Y : data.y;
        cmd["tick"] = data.tick;
        cmd["id"] = client.player.id;
        cmd["generation"] = Number(client.respawnGeneration || 0);
        cmd["sequence"] = sequence;
        cmd["vx"] = Number(client.avatar.Vx || 0);
        cmd["vy"] = Number(client.avatar.Vy || 0);
        client.positionRevision = Number(client.positionRevision || 0) + 1;
        cmd["revision"] = client.positionRevision;

        game.sendPacketE(cmd, client);
    }

    handleRespawnReady(client, data){
        var game = client.getGame();
        if(!game || client.isBot) return;
        var accepted = game.acknowledgeRespawn(
            client.player.id,
            parseInt(data.id),
            data.generation,
            data.respawnToken,
            data.x,
            data.y,
            data.grounded,
            data.terrainRevision
        );
        if(DEBUG) console.log(">> respawn_ready: reporter=" + client.player.id + "; target=" + data.id + "; generation=" + data.generation + "; accepted=" + accepted);
    }

    handleWorldFall(client, data){
        var game = client.getGame();
        if(!game || !game.isRunning() || client.isBot || !client.avatar || client.isDead()) return false;
        if(String(data.id) !== String(client.player.id)) return false;
        if(Number(data.generation) !== Number(client.respawnGeneration || 0)) return false;
        var x = Number(data.x);
        var y = Number(data.y);
        var map = game.WOPW.mapsObj[game.mapName] || {};
        var fatalY = Number(map.height || game.field.height || 1400) + 10;
        if(!Number.isFinite(x) || !Number.isFinite(y) || y <= fatalY) return false;
        client.avatar.setPosition(x, y);
        return game.killWorldFall(client, game.currentPlayer);
    }

    handleTerrainExplosion(client, data){
        return this.handleTerrainExplosionBatch(client, {
            turnEpoch: data && data.turnEpoch,
            batchSeq: data && data.batchSeq,
            explosions: data ? [[data.x, data.y, data.r]] : []
        });
    }

    handleTerrainExplosionBatch(client, data){
        var game = client.getGame();
        if(!game || !game.isRunning() || client.isBot || !game.field) return false;
        var turnEpoch = Number(data.turnEpoch);
        if(!Number.isFinite(turnEpoch) || turnEpoch < Number(game.turnEpoch) - 1 || turnEpoch > Number(game.turnEpoch)) return false;
        if(!Array.isArray(data.explosions) || data.explosions.length === 0 || data.explosions.length > 64) return false;

        var batchSeq = Number(data.batchSeq);
        var sequenceKey = String(turnEpoch);
        client.terrainBatchSequences = client.terrainBatchSequences || Object.create(null);
        if(Number.isFinite(batchSeq)){
            var previousSequence = Number(client.terrainBatchSequences[sequenceKey] || 0);
            if(batchSeq <= previousSequence) return false;
            client.terrainBatchSequences[sequenceKey] = batchSeq;
        }

        var records = [];
        for(var i = 0; i < data.explosions.length; i++){
            var explosion = data.explosions[i];
            if(!Array.isArray(explosion) || explosion.length < 3) continue;
            var x = Number(explosion[0]);
            var y = Number(explosion[1]);
            var r = Number(explosion[2]);
            if(!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(r)) continue;
            records.push([
                Utils.intToString(x),
                Utils.intToString(y),
                Utils.intToString(r)
            ]);
        }
        var accepted = game.field.mergeExplosionRecords(records);
        // Normal five-Hz coalescing is sufficient. A forced snapshot for
        // every Drill crater used to create a packet storm during the most
        // expensive Ruffle frame.
        if(accepted > 0){
            game.terrainRevision = Number(game.terrainRevision || 0) + 1;
            game.lastTerrainMutationAt = Date.now();
            if(typeof game.reconcileBotsAfterTerrainMutation === "function") game.reconcileBotsAfterTerrainMutation();
            if(typeof game.sendWorldState === "function") game.sendWorldState(true);
            if(typeof game.sendBotState === "function") game.sendBotState(false);
            if(DEBUG) console.log(
                "terrain_batch game=" + JSON.stringify(game.gameId) +
                " renderer=" + client.player.id +
                " epoch=" + turnEpoch +
                " accepted=" + accepted +
                " revision=" + game.terrainRevision
            );
        }
        return accepted > 0;
    }

    handleRuntimeMetrics(client, data){
        var game = client.getGame();
        if(!game || client.isBot) return false;
        var now = Date.now();
        if(now - Number(client.lastRuntimeMetricsAt || 0) < 1000) return false;
        client.lastRuntimeMetricsAt = now;
        console.warn(
            "client_runtime game=" + JSON.stringify(game.gameId) +
            " player=" + client.player.id +
            " epoch=" + Number(data.turnEpoch || game.turnEpoch || 0) +
            " reason=" + JSON.stringify(String(data.reason || "sample")) +
            " objects=" + Math.max(0, Number(data.objects || 0))
        );
        return true;
    }

    handleSetAim(client, data){
        if(client.getGame().currentPlayer != client.player.id || client.avatar.locked){
            return;
        }

        var power = Number(data.power);
        if(!Number.isFinite(power)) return;
        data.power = Math.max(0.08, Math.min(1, power));
        client.avatar.trueGunAngle = data.value;
        client.avatar.fpDistance = data.power;


        client.getGame().sendPacketE(data, client);
    }

    handleStartFire(client, data){
        if(client.getGame().currentPlayer != client.player.id || client.avatar.locked){
            return;
        }
        var isAiCommand = client.isBot === true;
        if(Array.isArray(data.d)) client.avatar.setPosition(data.d[0], data.d[1]);
        // Bot physics live in the rendering SWF because only it owns the current
        // destructible field. Never inject the server's stale map coordinates.
        if(isAiCommand) client.getGame().sendPacket(data);
        else client.getGame().sendPacketE(data, client);
    }

    handleCancelFire(client, data){
        if(client.getGame().currentPlayer != client.player.id || client.avatar.locked){
            return;
        }

        client.getGame().sendPacketE(data, client);
    }

    handleEquip(client, data){
        if(client.getGame().currentPlayer != client.player.id || client.avatar.locked){
            return;
        }

        client.getGame().sendPacketE(data, client);
    }

    handleToggleWeapon(client, data){
        if(client.getGame().currentPlayer != client.player.id || client.avatar.locked){
            return;
        }

        client.getGame().sendPacketE(data, client);
    }

    handleProjectile(client, data){
        //do I own this?
        //is it equipped?
        //did I already shoot?
        //how many remaining uses?
        //should I shorten turn time?
        if(client.getGame().currentPlayer != client.player.id ||
            (typeof client.isDead === "function" && client.isDead())){
            return;
        }

        if(client.avatar.alreadyShot){
            // Burst and split weapons legitimately emit more than one
            // projectile command.  The first packet already shortened the turn;
            // rejecting later projectiles must not lock out turn_complete.
            return;
        }

        var isAiCommand = client.isBot === true;
        var game = client.getGame();
        if(Array.isArray(data.d)) client.avatar.setPosition(data.d[0], data.d[1]);

        var properties = this.WOPW.weaponsObj[data.ammo_type];

        if(!properties) return;
        var isPetWeapon = properties.petWeapon === true || String(properties.petWeapon).toLowerCase() === "true";
        if(isPetWeapon){
            normalizeProfileState(client.player);
            var pet = client.player.ownedPets[String(client.player.currentPet)];
            var petDefinition = pet && this.WOPW.petsObj[pet.type];
            if(game.balancedGame || !petDefinition || String(petDefinition.petPower || "") !== String(data.ammo_type)){
                client.sendPacket({
                    command: "weapon_rejected",
                    reason: game.balancedGame ? "skill_match" : "inactive_pet_power",
                    item: String(data.ammo_type || "")
                });
                return;
            }
            var playerUsage = game.petPowerUsage[client.player.id] ||
                (game.petPowerUsage[client.player.id] = Object.create(null));
            var clip = Number(properties.clip);
            if(Number.isInteger(clip) && clip > 0 && Number(playerUsage[data.ammo_type] || 0) >= clip){
                client.sendPacket({
                    command: "weapon_rejected",
                    reason: "pet_power_depleted",
                    item: String(data.ammo_type || "")
                });
                return;
            }
            playerUsage[data.ammo_type] = Number(playerUsage[data.ammo_type] || 0) + 1;
        }
        var resolveDelayTicks = this.WOPW.DEFAULT_TIME_AFTER_WEAPON;
        if(Number(properties.timeAfter) > 0) resolveDelayTicks = Number(properties.timeAfter) / 10;
        if(Number(properties.timeout) > 0 && String(properties.allowTurn) !== "true" && properties.allowTurn !== true){
            resolveDelayTicks = Math.max(resolveDelayTicks, (Number(properties.timeout) / 10) + 50);
        }
        // Ruffle-safe hard budgets: the Kame cinematic intentionally needs
        // about ten seconds; ordinary effects may never hold a turn longer
        // than 7.5 seconds. Drill's imported client class uses the same 6.5s
        // finite lifetime.
        var behaviorType = String(properties.baseType && properties.baseType !== "null" ? properties.baseType : data.ammo_type);
        if(data.ammo_type === "kame") resolveDelayTicks = 1100;
        else if(behaviorType === "mirv") resolveDelayTicks = 1200;
        else if(data.ammo_type === "drill") resolveDelayTicks = 650;
        else resolveDelayTicks = Math.max(250, Math.min(750, resolveDelayTicks));

        var isBasicWeapon = ["mortar", "punch", "bone", "walk", "superjump", "climb", "dig", "empty"].includes(data.ammo_type);

        if(!isBasicWeapon && !isPetWeapon && data.crate != "true"){
            if(!client.player.userWeaponsOwned[data.ammo_type] || client.player.userWeaponsOwned[data.ammo_type] <= 0){
                client.avatar.alreadyShot = true;
                if(DEBUG) console.log("!! wep not owned: " + data.ammo_type);
                return;
            }
        }
        if(typeof game.markCurrentTurnRespawnShot === "function") game.markCurrentTurnRespawnShot(client);
        var shotReward = false;
        if(properties.timeAfter == null){ //harmful
            client.avatar.alreadyShot = true;
            if(DEBUG){
                console.log("Setting next turn at bounded weapon delay: " + resolveDelayTicks);
            }
            game.setNextTurnFN(resolveDelayTicks);
        }else if(properties.timeAfter > 0){ //harmful
            client.avatar.alreadyShot = true;
            if(DEBUG) console.log("Next turn in: " + resolveDelayTicks);
            game.setNextTurnFN(resolveDelayTicks);
            shotReward = true;
        }

        if(!isBasicWeapon && !isPetWeapon && data.crate != "true" && !client.player.unlimitedInventory) client.player.userWeaponsOwned[data.ammo_type] -= 1;

        if(game.recordProgression){
            game.recordProgression(client, "shotsFired", 1);
            if(data.crate === "true") game.recordProgression(client, "crates", 1);
        }
        if(game.recordMatchShot) game.recordMatchShot(client, data.ammo_type, properties, data.crate === "true");
        if(data.ammo_type === "healthEquipA" && game.authorizeHeal) game.authorizeHeal(client.player.id, 200);
        if(isAiCommand){
            game.botPendingProjectile = {
                id: client.player.id,
                turnEpoch: game.turnEpoch,
                controllerEpoch: game.botControllerEpoch,
                weapon: data.ammo_type
            };
            // The original four-second weapon deadline made the server advance
            // before Ruffle had rendered the projectile. Send the watchdog
            // deadline immediately; bot_turn_complete ends it earlier once the
            // visual simulation has actually settled.
            game.sendServerTick();
        }

        // The human owner already rendered this exact snapshot locally. Relay
        // it only to the other renderers; bot shots still go to everybody.
        data.id = client.player.id;
        data.turnEpoch = Number(game.turnEpoch || 0);
        data.generation = Number(client.respawnGeneration || 0);
        data.tick = Number.isFinite(Number(data.tick)) ? Number(data.tick) : Number(game.tick || 0);
        data.shotId = String(game.gameId) + ":" + data.turnEpoch + ":" + (++game.projectileSequence);
        var reportedX = Number(data.sourceX);
        var reportedY = Number(data.sourceY);
        var closeToOwner = Number.isFinite(reportedX) && Number.isFinite(reportedY) &&
            Math.abs(reportedX - Number(client.avatar.X || 0)) <= 100 &&
            Math.abs(reportedY - Number(client.avatar.Y || 0)) <= 100;
        data.sourceX = closeToOwner ? reportedX : Number(client.avatar.X || 0);
        data.sourceY = closeToOwner ? reportedY : Number(client.avatar.Y || 0);
        data.sourceVx = Number.isFinite(Number(data.sourceVx)) ? Number(data.sourceVx) : Number(client.avatar.Vx || 0);
        data.sourceVy = Number.isFinite(Number(data.sourceVy)) ? Number(data.sourceVy) : Number(client.avatar.Vy || 0);
        data.angle = Number.isFinite(Number(data.angle)) ? Number(data.angle) : Number(client.avatar.trueGunAngle || 0);
        data.power = Math.max(0.08, Math.min(1,
            Number.isFinite(Number(data.power)) ? Number(data.power) : Number(client.avatar.fpDistance || 0.08)
        ));
        // Relay first: the other renderers are waiting on this packet, while
        // the profile/reward bookkeeping below is only for the shooter.
        if(isAiCommand) game.sendPacket(data);
        else game.sendPacketE(data, client);
        if(typeof game.sendWorldState === "function") game.sendWorldState(true);

        if(shotReward){
            // One combined profile update instead of three full player packets.
            client.player.xp += Math.round(Math.random() * 10) + 1;
            client.addGold(Math.round(Math.random() * 5) + 1, false);
        }
        client.updatePlayerData();
        client.sendUpdate();
    }

    handleDamage(client, data){
        var game = client.getGame();
        if(!game || !game.isRunning()) return;

        var attackerId = parseInt(data.from);
        var victimId = parseInt(data.to);
        var damage = parseInt(data.value);
        if(!Number.isFinite(victimId) || !Number.isFinite(damage) || damage <= 0 || attackerId !== parseInt(client.player.id)) return;
        if(parseInt(game.currentPlayer) !== attackerId) return;

        var victim = game.clients[victimId];
        if(!victim || victim.isDead()) return;
        // v21 reports attacker-side damage. For a human victim the victim's
        // own legacy synch_pts/modern health_state is authoritative; accepting
        // both would double-damage. Bots have no socket, so this is their
        // compatibility reducer until every renderer is v22.
        if(!victim.isBot) return;
        // Protocol 4 has one stable renderer report the bot's exact hpAfter.
        // Applying this older accumulated-damage packet as well would race the
        // exact state and can subtract the same hit twice.
        if(typeof game.getBotHealthReporterId === "function" && game.getBotHealthReporterId() != null) return;
        if(typeof game.initializeHealth !== "function" || typeof game.applyHealthState !== "function"){
            victim.avatar.hp = Math.max(0, Number(victim.avatar.hp || 0) - damage);
            if(victim.avatar.hp <= 0) game.setPlayerDead(victimId, attackerId, data.generation);
            return;
        }
        var state = game.initializeHealth(victim, false);
        client.legacyDamageSeq = Number(client.legacyDamageSeq || 0) + 1;
        game.applyHealthState(client, victimId, state.hp - damage, data.generation, client.legacyDamageSeq, "damage", attackerId);
    }

    handleHealthState(client, data){
        var game = client.getGame();
        if(!game || !game.isRunning()) return;
        // Explosions and fall damage can resolve on the renderer just as a
        // turn advances. Accept only the current (or immediately preceding)
        // turn while the life generation and sequence still provide replay
        // protection; rejecting that boundary packet was restoring real
        // players to the server's older, full-health value on their next turn.
        var reportedTurnEpoch = Number(data.turnEpoch);
        if(!Number.isFinite(reportedTurnEpoch) || reportedTurnEpoch < Number(game.turnEpoch) - 1 || reportedTurnEpoch > Number(game.turnEpoch)) return;
        var targetId = parseInt(data.targetId != null ? data.targetId : data.id);
        var target = game.clients[targetId];
        if(!target) return;
        var raw = data.hpAfter != null ? data.hpAfter : data.hp;
        var hpAfter = typeof raw === "string" && raw.length === 16 ? Utils.stringToInt(raw) : Number(raw);
        if(!Number.isFinite(hpAfter)) return;
        game.applyHealthState(client, targetId, hpAfter, data.generation, data.seq, data.reason, data.sourceId, { enforceReporter: true });
    }

    handleRetractRope(client, data){
        if(client.getGame().currentPlayer != client.player.id || client.avatar.locked){
            return;
        }

        client.getGame().sendPacketE(data, client);
    }

    handleReleaseRope(client, data){
        if(client.getGame().currentPlayer != client.player.id || client.avatar.locked){
            return;
        }

        client.getGame().sendPacketE(data, client);
    }

    handleStopRope(client, data){
        if(client.getGame().currentPlayer != client.player.id || client.avatar.locked){
            return;
        }

        client.getGame().sendPacketE(data, client);
    }

    handleDetach(client, data){
        if(client.getGame().currentPlayer != client.player.id || client.avatar.locked){
            return;
        }

        client.getGame().sendPacketE(data, client);
    }

    handleTeleportStop(client, data){
        if(client.getGame().currentPlayer != client.player.id || client.avatar.locked){
            return;
        }

        client.getGame().sendPacketE(data, client);
    }

    handlePlayerKill(client, data){
        var game = client.getGame();
        if(!game || !game.isRunning()) return;

        var victimId = parseInt(data.id);
        if(!Number.isFinite(victimId)) return;

        var victim = game.clients[victimId];
        if(!victim || victim.isDead()) return;

        var expected = game.getHealthReporterId(victim);
        if(String(expected) !== String(client.player.id)) return;
        var state = game.initializeHealth(victim, false);
        client.legacyKillSeq = Number(client.legacyKillSeq || 0) + 1;
        game.applyHealthState(client, victimId, 0, data.generation, client.legacyKillSeq, "damage", data.killerId || client.player.id);
    }

    handleRequestSynch(client, data){
        //console.log("client who requested synch: " + client.player.id);
        if(DEBUG) console.log("client whos data was req: " + data.pid);
        client.sendPacket(client.getGame().clients[data.pid].getSynchCommand());

    }

    async handleCollectionRoll(client, data){
        if(client.connectionType !== "lobby") return false;
        ensureProgression(client.player);
        const requestId = this.purchaseRequestId(data);
        const setType = String(data.setType || "");
        const transactionKind = `collection:${setType}`;
        const collections = this.WOPW.otherObj && this.WOPW.otherObj.chanceCollections;
        const collection = collections && /^[A-Za-z0-9_-]{1,48}$/.test(setType)
            ? collections[setType]
            : null;
        const reply = (value, reason, receipt = {}) => {
            const balance = Math.max(0, Number(client.player.treats) || 0);
            client.sendPacket({
                command: "collection_roll_return",
                requestId,
                value: Boolean(value),
                error: value ? null : String(reason || "unavailable"),
                reason: value ? null : String(reason || "unavailable"),
                setType,
                reward: receipt.reward || null,
                finalReward: receipt.finalReward || null,
                balance,
                collectionRevision: Math.max(0, Number(receipt.collectionRevision) || 0)
            });
        };
        // Retry the exact stored outcome before checking whether the set is
        // now complete. This also makes the final spin safely idempotent after
        // it grants the collection reward.
        const transactionKey = crypto.createHash("sha256")
            .update(`${transactionKind}:${requestId}`)
            .digest("hex");
        const previous = client.player.transactions && client.player.transactions[transactionKey];
        if(previous){
            reply(previous.ok !== false, previous.reason || null, previous.receipt || {});
            return previous.ok !== false;
        }
        if(!collection || !Array.isArray(collection.prize)){
            reply(false, "unavailable");
            return false;
        }

        const normalizeReward = (candidate) => {
            if(!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
            const type = Object.keys(candidate)[0];
            const amount = Math.max(1, Math.floor(Number(candidate[type]) || 1));
            if(!type || !/^[A-Za-z0-9_-]+$/.test(type)) return null;
            if(type === "gold" || type === "treats" || type === "xp") return { type, amount, accessory: false };
            const accessorySupport = manifestRecord(type, this.WOPW.accessoryAssetManifest);
            if(this.WOPW.accessoriesObj[type] && accessorySupport && accessorySupport.rewardEligible){
                return { type, amount: 1, accessory: true, pet: false };
            }
            if(this.WOPW.petsObj && this.WOPW.petsObj[type]){
                return { type, amount: 1, accessory: false, pet: true };
            }
            const weaponEntry = this.WOPW.weaponCatalog && this.WOPW.weaponCatalog.entries.get(type);
            const weaponSupport = this.WOPW.weaponAssetManifest && this.WOPW.weaponAssetManifest.weapons &&
                this.WOPW.weaponAssetManifest.weapons[type];
            if(weaponEntry && weaponSupport && weaponSupport.runtimeSupported){
                return { type, amount, accessory: false, pet: false };
            }
            return null;
        };

        const owned = new Set(Array.isArray(client.player.userAccessories) ? client.player.userAccessories : []);
        const validPrizes = collection.prize.map((row) => {
            const primary = normalizeReward(row && row.reward);
            const alternate = normalizeReward(row && row.altreward);
            return primary ? {
                primary,
                alternate,
                weight: Math.max(1, Math.floor(Number(row.pWeight || row.p || row.slots || 1)))
            } : null;
        }).filter(Boolean);
        const missing = validPrizes.filter((row) => !row.primary.accessory || !owned.has(row.primary.type));
        if(!missing.length){
            reply(false, "collection_complete", {
                collectionRevision: Number(client.player.collections[setType] &&
                    client.player.collections[setType].spins || 0)
            });
            return false;
        }

        const eligiblePrizes = validPrizes.filter((row) =>
            !row.primary.accessory || !owned.has(row.primary.type) || Boolean(row.alternate));
        const totalWeight = eligiblePrizes.reduce((sum, row) => sum + row.weight, 0);
        let roll = this.randomInt(0, totalWeight);
        let selected = eligiblePrizes[eligiblePrizes.length - 1];
        for(const row of eligiblePrizes){
            if(roll < row.weight){
                selected = row;
                break;
            }
            roll -= row.weight;
        }
        const reward = selected.primary.accessory && owned.has(selected.primary.type) && selected.alternate
            ? selected.alternate
            : selected.primary;

        const state = client.player.collections[setType] || {};
        const spins = Math.max(0, Number(state.spins) || 0);
        const spinPath = `collections.${setType}.spins`;
        const revision = spins + 1;
        const projectedOwned = new Set(owned);
        if(reward.accessory) projectedOwned.add(reward.type);
        const collectionAccessoryTypes = validPrizes
            .filter((row) => row.primary.accessory)
            .map((row) => row.primary.type);
        const completesCollection = collectionAccessoryTypes.length > 0 &&
            collectionAccessoryTypes.every((type) => projectedOwned.has(type));
        const finalReward = completesCollection && !state.finalClaimed
            ? normalizeReward(collection.finalPrize)
            : null;

        const increments = {
            [spinPath]: 1,
            "stats.purchases": 1
        };
        const sets = {
            [`collections.${setType}.revision`]: revision
        };
        const accessoriesToGrant = [];
        let petToGrant = null;
        const applyReward = (grant) => {
            if(!grant) return;
            if(grant.accessory){
                accessoriesToGrant.push(grant.type);
                sets[`durability.${grant.type}`] = 30;
                return;
            }
            if(grant.pet){
                if(petToGrant) return;
                normalizeProfileState(client.player);
                const petId = String(client.player.nextPetId);
                const mainColors = this.WOPW.config && this.WOPW.config.petMainColors || ["0x999999"];
                const detailColors = this.WOPW.config && this.WOPW.config.petDetailColors || ["0xFFFFFF"];
                petToGrant = {
                    id: petId,
                    gender: "M",
                    name: String(this.WOPW.petsObj[grant.type].alt || grant.type),
                    color1: String(mainColors[0] || "0x999999"),
                    color2: String(detailColors[0] || "0xFFFFFF"),
                    played: 0,
                    wins: 0,
                    losses: 0,
                    kills: 0,
                    deaths: 0,
                    gold: 0,
                    lastPlayed: 0,
                    type: grant.type,
                    pers: "physicist",
                    accessories: []
                };
                sets[`ownedPets.${petId}`] = petToGrant;
                increments.nextPetId = Number(increments.nextPetId || 0) + 1;
                return;
            }
            const path = grant.type === "gold" || grant.type === "treats" || grant.type === "xp"
                ? grant.type
                : `userWeaponsOwned.${grant.type}`;
            increments[path] = Number(increments[path] || 0) + grant.amount;
        };
        applyReward(reward);
        applyReward(finalReward);
        if(finalReward){
            sets[`collections.${setType}.finalClaimed`] = true;
            sets[`collections.${setType}.completedAt`] = new Date();
        }
        const rewardObject = { [reward.type]: reward.amount };
        const finalRewardObject = finalReward ? { [finalReward.type]: finalReward.amount } : null;
        const receipt = {
            reward: rewardObject,
            finalReward: finalRewardObject,
            collectionRevision: revision
        };
        const update = {
            $inc: increments,
            $set: sets
        };
        if(accessoriesToGrant.length){
            update.$addToSet = { userAccessories: { $each: [...new Set(accessoriesToGrant)] } };
        }
        const expectedSpinFilter = spins === 0
            ? { [spinPath]: { $in: [null, 0] } }
            : { [spinPath]: spins };
        const configuredCost = Math.max(0, Math.floor(Number(collection.cost) || 0));
        const cost = client.player.unlimitedInventory ? 0 : configuredCost;
        const result = await client.db.applyPurchase({
            userId: client.player.id,
            requestId,
            kind: transactionKind,
            item: setType,
            quantity: 1,
            currency: "treats",
            cost,
            filter: expectedSpinFilter,
            update,
            receipt
        });
        if(result.user) this.syncPurchaseUser(client, result.user);
        const storedReceipt = result.transaction && result.transaction.receipt || receipt;
        if(!result.ok){
            reply(false, result.reason, storedReceipt);
            return false;
        }
        client.sendUpdate();
        reply(true, null, storedReceipt);
        return true;
    }

    handleChanceWheel(client, data){
        if(client.connectionType !== "lobby") return false;
        ensureProgression(client.player);
        const configuredPrizes = this.WOPW.otherObj && this.WOPW.otherObj.chanceWheel &&
            Array.isArray(this.WOPW.otherObj.chanceWheel.prize)
            ? this.WOPW.otherObj.chanceWheel.prize
            : [];
        const prizePool = configuredPrizes.map((prize) => {
            const weaponType = Object.keys(prize && prize.reward || {})[0];
            const entry = weaponType && this.WOPW.weaponCatalog && this.WOPW.weaponCatalog.entries.get(weaponType);
            return {
                weaponType,
                amount: Math.max(1, Math.floor(Number(prize && prize.reward && prize.reward[weaponType]) || 1)),
                special: prize && String(prize.special).toLowerCase() === "true",
                weight: Math.max(0, Math.floor(Number(prize && prize.slots) || 0)),
                valid: Boolean(entry && entry.runtimeSupported && entry.iconSupported)
            };
        }).filter((prize) => prize.valid && prize.weight > 0);
        const totalWeight = prizePool.reduce((sum, prize) => sum + prize.weight, 0);
        if(!totalWeight){
            client.sendPacket({
                command: "alert",
                text: "Prize Wheel is currently unavailable"
            });
            return false;
        }

        // The legacy client only sends a command and used to make the random
        // draw (and charge the treats) on the connection object.  Keeping the
        // whole transaction here prevents a replayed packet from granting a
        // second prize and makes the balance durable before the animation is
        // allowed to start.
        if(client._chanceWheelPending) return false;
        if(!this.chargeCurrency(client, "treats", 2)){
            client.sendPacket({ command: "chance_wheel_return", value: { reward: null } });
            return false;
        }

        client._chanceWheelPending = true;
        try {
            let roll = crypto.randomInt(0, totalWeight);
            let selectedPrize = prizePool[prizePool.length - 1];
            for(const prize of prizePool){
                if(roll < prize.weight){
                    selectedPrize = prize;
                    break;
                }
                roll -= prize.weight;
            }

            const reward = rewardPlayer(client.player, {
                [selectedPrize.weaponType]: selectedPrize.amount
            });
            this.recordStat(client, "purchases", 1);
            this.persistLobbyPlayer(client);
            client.sendPacket({
                command: "chance_wheel_return",
                value: { reward: reward, special: selectedPrize.special ? "true" : "false" }
            });
            return true;
        } finally {
            client._chanceWheelPending = false;
        }
    }

    medalCollectionPayload(client){
        ensureProgression(client.player);
        return {
            medalList: client.player.medals.medalList,
            medalCounts: client.player.medals.medalCounts,
            newItems: [],
            totalMedals: client.player.medals.totalMedals,
            guid: String(client.player && client.player.id || ""),
            playerGuid: String(client.player && client.player.id || ""),
            version: 1
        };
    }

    handleGetMedals(client){
        if(client.connectionType !== "lobby") return;

        const payload = this.medalCollectionPayload(client);
        // Player.initMedalInfo() sends this command automatically while the
        // game boots.  Returning medal_info at that point opens an incomplete
        // modal before the home screen exists.  The next request comes from
        // the Medal button and is the only time the collection UI should open.
        if(!client.medalsInitialized){
            client.medalsInitialized = true;
            client.sendPacket({ command: "medal_init", ...payload });
            return;
        }
        client.sendPacket({ command: "medal_info", ...payload });
    }

    handleSetXPromoPopup(client, data){
        if(client.connectionType == "lobby") {
            client.sendPacket({ command: "xpromo_fetched", show: "verdonia", local: true });
        }
    }

    handleSetPrizeFlag(client, data){
        if(client.connectionType !== "lobby") return false;
        ensureProgression(client.player);
        var type = String(data.type || "").toLowerCase();
        if(type !== "gold" && type !== "treats") return false;
        var key = "prize_flag:" + type;
        // This notification is emitted during lobby initialization. Persist it
        // once, then accept repeat frames idempotently without producing an
        // unhandled-command warning or a write on every reconnect.
        if(!client.player.promos[key]){
            client.player.promos[key] = Date.now();
            this.persistLobbyPlayer(client);
        }
        return true;
    }
    
    handleShowNewsPopUp(client, data){
         if(client.connectionType == "lobby") {
            client.sendPacket
            (
                {
                    "command": "news"
                }
            );
        }
    }

    handleClaimIdleGift(client, data){
        if(client.connectionType !== "lobby") return false;
        ensureProgression(client.player);
        var now = Date.now();
        var last = Number(client.player.idleGift && client.player.idleGift.lastClaimAt || 0);
        if(now - last < 4 * 60 * 60 * 1000){
            client.sendPacket({ command: "idlegift", value: false, reason: "cooldown" });
            return false;
        }
        client.player.idleGift = { lastClaimAt: now };
        var reward = rewardPlayer(client.player, { gold: 100, xp: 100 });
        this.persistLobbyPlayer(client);
        client.sendPacket({ command: "idlegift", value: reward });
        return true;
    }    

    handleBecomeMember(client){
        if(client.connectionType !== "lobby") return false;
        ensureProgression(client.player);
        client.player.membership.active = true;
        this.persistLobbyPlayer(client);
        client.sendPacket({ command: "member_return", value: true });
        return true;
    }

    handleClaimMember(client){
        if(client.connectionType !== "lobby") return false;
        ensureProgression(client.player);
        if(!client.player.membership.active) return this.handleBecomeMember(client);
        var now = Date.now();
        if(now - Number(client.player.membership.lastClaimAt || 0) < 24 * 60 * 60 * 1000){
            client.sendPacket({ command: "member_bonus_return", value: { error: "cooldown" } });
            return false;
        }
        client.player.membership.lastClaimAt = now;
        var reward = rewardPlayer(client.player, { gold: 250, xp: 250, treats: 3 });
        this.persistLobbyPlayer(client);
        client.sendPacket({ command: "member_bonus_return", value: reward });
        return true;
    }

    handleXPromoReward(client, data){
        if(client.connectionType !== "lobby") return false;
        ensureProgression(client.player);
        var type = String(data.game || data.type || "local").slice(0, 48);
        if(client.player.promos["xpromo:" + type]){
            client.sendPacket({ command: "xpromo_reward_return", value: false, duplicate: true });
            return false;
        }
        client.player.promos["xpromo:" + type] = Date.now();
        var reward = rewardPlayer(client.player, { gold: 200, xp: 200, grenade: 2 });
        this.persistLobbyPlayer(client);
        client.sendPacket({ command: "xpromo_reward_return", value: reward });
        return true;
    }

    handleMysteryGift(client){
        if(client.connectionType !== "lobby") return false;
        ensureProgression(client.player);
        var now = Date.now();
        var nextAt = Number(client.player.mysteryGift && client.player.mysteryGift.nextAt || 0);
        if(now < nextAt) return false;
        var reward = rewardPlayer(client.player, { gold: 50, xp: 50, teleport: 1 });
        client.player.mysteryGift = { claimed: true, nextAt: now + 24 * 60 * 60 * 1000 };
        this.persistLobbyPlayer(client);
        client.sendPacket({ command: "mystery_gift_claimed", value: reward });
        return true;
    }

    handleChangePet(client, data){
        const petId = String(data.name == null ? data.petId : data.name);
        normalizeProfileState(client.player);
        if(!Object.hasOwn(client.player.ownedPets, petId)) return false;
        client.player.currentPet = petId;
        this.persistLobbyPlayer(client);
        return true;
    }

    async handleBuyAccessory(client, data){
        if(client.connectionType != "lobby") return false;
        const requestId = this.purchaseRequestId(data);
        const type = String(data.type || "");
        const item = this.WOPW.accessoriesObj[type];
        const currency = item && item.currency === "treats" ? "treats" : "gold";
        const support = manifestRecord(type, this.WOPW.accessoryAssetManifest);
        if(!item || !support || !support.shopVisible || !/^[A-Za-z0-9_-]+$/.test(type)){
            this.purchaseReply(client, "accessoryPurchase", requestId, false, "unknown_item", type, 1, currency, { type });
            return false;
        }
        ensureProgression(client.player);
        const requiredLevel = Math.max(0, Number(this.WOPW.itemLevel && this.WOPW.itemLevel[type]) || 0);
        const currentLevel = levelFromXp(client.player.xp, this.WOPW.levelsObj);
        if(requiredLevel && currentLevel < requiredLevel){
            this.purchaseReply(client, "accessoryPurchase", requestId, false, "level_locked", type, 1, currency, { type });
            return false;
        }
        const price = client.player.unlimitedInventory ? 0 : Math.max(0, Number(item.price) || 0);
        const result = await client.db.applyPurchase({
            userId: client.player.id,
            requestId,
            kind: "accessory",
            item: type,
            quantity: 1,
            currency,
            cost: price,
            filter: { userAccessories: { $ne: type } },
            update: {
                $addToSet: { userAccessories: type },
                $set: { [`durability.${type}`]: 30 },
                $inc: { "stats.purchases": 1 }
            }
        });
        if(result.user) this.syncPurchaseUser(client, result.user);
        if(!result.ok){
            const owned = Array.isArray(client.player.userAccessories) && client.player.userAccessories.includes(type);
            this.purchaseReply(client, "accessoryPurchase", requestId, false, owned ? "already_owned" : result.reason, type, 1, currency, { type });
            return false;
        }
        if(!result.duplicate) this.awardProgressionMedal(client, "dressed_to_kill");
        client.sendUpdate();
        if(!result.duplicate) client.updatePlayerData();
        this.purchaseReply(client, "accessoryPurchase", requestId, true, null, type, 1, currency, {
            type,
            category: item.category,
            duplicate: Boolean(result.duplicate)
        });
        return true;
    }

    handleAccLoad(client, data){
        if(client.connectionType != "lobby") return;
        if(!Array.isArray(data.load) || data.load.length > 6) return false;
        if(!Array.isArray(client.player.userAccessories)) client.player.userAccessories = [];
        var petId = String(data.pet == null ? client.player.currentPet : data.pet);
        var pet = client.player.ownedPets && client.player.ownedPets[petId];
        if(!pet) return false;

        var load = data.load.map(function(value){ return String(value || ""); }).filter(Boolean);
        var sanitized = sanitizeEquippedAccessories(
            load,
            this.WOPW.accessoriesObj,
            this.WOPW.accessoryAssetManifest,
            6
        );
        var occurrences = Object.create(null);
        var valid = load.length === data.load.length && sanitized.length === load.length;
        for(var index = 0; valid && index < load.length; index++){
            var itemType = load[index];
            var definition = this.WOPW.accessoriesObj[itemType];
            if(!definition || client.player.userAccessories.indexOf(itemType) < 0){
                valid = false;
                break;
            }
            // The movie exposes one slot per visual category, including the
            // dedicated minipet follower slot.
            var category = String(definition.category || "");
            occurrences[category] = Number(occurrences[category] || 0) + 1;
            if(!category || occurrences[category] > 1) valid = false;
        }

        if(!valid){
            console.warn("accessory_load_rejected player=" + JSON.stringify(client.player.dname) + " pet=" + JSON.stringify(petId));
            return false;
        }

        pet.accessories = load;
        this.persistLobbyPlayer(client);
        client.sendPacket({ command: "accessory_load_saved", pet: petId, load: load });
        return true;
    }

    async handleBuyPet(client, data){
        if(client.connectionType != "lobby") return false;
        const requestId = this.purchaseRequestId(data);
        const type = String(data.type || "");
        const petDefinition = this.WOPW.petsObj[type];
        const currency = petDefinition && petDefinition.currency === "treats" ? "treats" : "gold";
        const petName = String(data.name || "").normalize("NFKC").trim();
        var toColorToken = function(value){
            var parsed = typeof value === "string" && /^0x/i.test(value) ? parseInt(value.slice(2), 16) : Number(value);
            if(!Number.isFinite(parsed) || parsed < 0 || parsed > 0xFFFFFF) return null;
            return Math.floor(parsed).toString(16).toLowerCase();
        };
        var color1 = toColorToken(data.color1);
        var color2 = toColorToken(data.color2);
        const validName = petName.length >= 1 && petName.length <= 20 &&
            /^[\p{L}\p{N} _'-]+$/u.test(petName);
        if(!validName || !color1 || !color2 ||
            this.WOPW.config.petDetailColors.map(String).map(function(value){ return value.toLowerCase().replace(/^0x/, ""); }).indexOf(color2) < 0 ||
            this.WOPW.config.petMainColors.map(String).map(function(value){ return value.toLowerCase().replace(/^0x/, ""); }).indexOf(color1) < 0){
            this.purchaseReply(client, "petPurchase", requestId, false, "invalid_customization", type, 1, currency, { type });
            return false;
        }
        if(!petDefinition){
            this.purchaseReply(client, "petPurchase", requestId, false, "unknown_item", type, 1, currency, { type });
            return false;
        }
        const requiredLevel = Math.max(0, Number(this.WOPW.itemLevel && this.WOPW.itemLevel[type]) || 0);
        if(requiredLevel && levelFromXp(client.player.xp, this.WOPW.levelsObj) < requiredLevel){
            this.purchaseReply(client, "petPurchase", requestId, false, "level_locked", type, 1, currency, { type });
            return false;
        }
        normalizeProfileState(client.player);
        const petId = String(client.player.nextPetId);
        var petInfo = {
            "id": petId,
            "gender": "M",
            "name": petName,
            "color1": "0x" + color1.toUpperCase(),
            "color2": "0x" + color2.toUpperCase(),
            "played": 0,
            "wins": 0,
            "losses": 0,
            "kills": 0,
            "deaths": 0,
            "gold": 0,
            "lastPlayed": 0,
            "type": type,
            "pers": "physicist",
            "accessories": []
        };
        const price = client.player.unlimitedInventory ? 0 : Math.max(0, Number(petDefinition.price) || 0);
        const result = await client.db.applyPurchase({
            userId: client.player.id,
            requestId,
            kind: "pet",
            item: type,
            quantity: 1,
            currency,
            cost: price,
            filter: { [`ownedPets.${petId}`]: { $exists: false } },
            update: {
                $set: { [`ownedPets.${petId}`]: petInfo },
                $inc: { nextPetId: 1, "stats.purchases": 1 }
            },
            receipt: { petId: petId }
        });
        if(result.user) this.syncPurchaseUser(client, result.user);
        if(!result.ok){
            this.purchaseReply(client, "petPurchase", requestId, false, result.reason, type, 1, currency, { type });
            return false;
        }
        client.sendUpdate();
        const purchasedPetId = String(result.transaction && result.transaction.receipt &&
            result.transaction.receipt.petId || petId);
        this.purchaseReply(client, "petPurchase", requestId, true, null, type, 1, currency, {
            pet: purchasedPetId,
            type: type,
            name: petName,
            duplicate: Boolean(result.duplicate)
        });
        return true;
    }

    handleDeletePet(client, data){
        if(client.connectionType != "lobby") return;
        normalizeProfileState(client.player);
        const petId = String(data.petId == null ? data.pet : data.petId);
        const petIds = Object.keys(client.player.ownedPets).sort(comparePetIds);
        if(!Object.hasOwn(client.player.ownedPets, petId) || petIds.length <= 1) return false;

        const deletingActivePet = client.player.currentPet === petId;
        delete client.player.ownedPets[petId];
        if(deletingActivePet){
            client.player.currentPet = Object.keys(client.player.ownedPets).sort(comparePetIds)[0];
        }
        this.persistLobbyPlayer(client);
        client.sendPacket({
            command: "pet_deleted",
            value: true,
            petId: petId,
            currentPet: client.player.currentPet
        });
        return true;
    }

    async handleBuyAmmo(client, data){
        if(client.connectionType != "lobby") return false;
        const requestId = this.purchaseRequestId(data);
        const type = String(data.ammoType || data.type || "");
        const count = Number(data.ammoCount == null ? data.quantity : data.ammoCount);
        const weapon = this.WOPW.weaponsObj[type];
        const currency = weapon && weapon.currency === "treats" ? "treats" : "gold";
        if(!Number.isInteger(count) || count < 1 || count > 99){
            this.purchaseReply(client, "ammoPurchase", requestId, false, "invalid_quantity", type, count || 1, currency, { type });
            return false;
        }
        const catalogEntry = this.WOPW.weaponCatalog && this.WOPW.weaponCatalog.entries.get(type);
        if(!weapon || !catalogEntry || !catalogEntry.selectable || !catalogEntry.shopVisible || !/^[A-Za-z0-9_-]+$/.test(type)){
            this.purchaseReply(client, "ammoPurchase", requestId, false, "unknown_item", type, count, currency, { type });
            return false;
        }
        const requiredLevel = Math.max(0, Number(this.WOPW.itemLevel && this.WOPW.itemLevel[type]) || 0);
        if(requiredLevel && levelFromXp(client.player.xp, this.WOPW.levelsObj) < requiredLevel){
            this.purchaseReply(client, "ammoPurchase", requestId, false, "level_locked", type, count, currency, { type });
            return false;
        }
        const purchaseAmount = Math.max(1, Math.floor(Number(weapon.purchaseAmount) || 1));
        const grantedQuantity = purchaseAmount * count;
        const inventoryPath = `userWeaponsOwned.${type}`;
        const maxAmmo = 9999;
        const price = client.player.unlimitedInventory ? 0 : Math.max(0, Number(weapon.price) || 0) * count;
        const result = await client.db.applyPurchase({
            userId: client.player.id,
            requestId,
            kind: "ammo",
            item: type,
            quantity: count,
            currency,
            cost: price,
            filter: {
                $or: [
                    { [inventoryPath]: { $exists: false } },
                    { [inventoryPath]: { $lte: maxAmmo - grantedQuantity } }
                ]
            },
            update: {
                $inc: {
                    [inventoryPath]: grantedQuantity,
                    "stats.purchases": 1
                }
            },
            receipt: { grantedQuantity }
        });
        if(result.user) this.syncPurchaseUser(client, result.user);
        if(!result.ok){
            const reason = result.reason === "conflict" ? "invalid_quantity" : result.reason;
            this.purchaseReply(client, "ammoPurchase", requestId, false, reason, type, count, currency, { type });
            return false;
        }
        client.sendUpdate();
        this.purchaseReply(client, "ammoPurchase", requestId, true, null, type, count, currency, {
            type,
            grantedQuantity: Number(result.transaction && result.transaction.receipt &&
                result.transaction.receipt.grantedQuantity || grantedQuantity),
            amount: Number(result.transaction && result.transaction.receipt &&
                result.transaction.receipt.grantedQuantity || grantedQuantity),
            duplicate: Boolean(result.duplicate)
        });
        return true;
    }

    handleSetWeaponsEquipped(client, data){
        if(!data || !Array.isArray(data.value) || !data.value.length || data.value.length > 8) return;
        var equipped = data.value.map(function(value){ return String(value || ""); });
        var utilityTypes = ["mortar", "superjump", "empty", "punch", "walk", "bone", "dig", "climb", ""];
        var validSet = true;
        for(var i = 0; i < equipped.length; i++){
            var type = equipped[i];
            if(utilityTypes.indexOf(type) >= 0){
                continue;
            }

            var catalogEntry = this.WOPW.weaponCatalog && this.WOPW.weaponCatalog.entries.get(type);
            // Existing accounts could have been saved with the hidden tree
            // growth projectile selected. Preserve the account but replace the
            // unusable slot with a known playable weapon on its next save.
            if(type === "treegrowth"){
                equipped[i] = client.player.userWeaponsOwned.grenade ? "grenade" : "mortar";
                continue;
            }
            if(!catalogEntry || !catalogEntry.selectable || !client.player.userWeaponsOwned[type]){
                console.log(">> invalid_set: " + type);
                this.invalidItemLog.write("Supposedly invalid item: " + type);
                validSet = false;
                break;
            }
        }

        if(!validSet) return;

        client.player.userWeaponsEquipped = equipped;
        client.sendUpdate();
        client.updatePlayerData();
    }

    handleSynchPts(client, data){
        var game = client.getGame();
        if(!game || !game.isRunning()) return;
        var hpAfter = Utils.stringToInt(data.value);
        if(!Number.isFinite(hpAfter)) return;
        client.legacyHealthSeq = Number(client.legacyHealthSeq || 0) + 1;
        game.applyHealthState(client, client.player.id, hpAfter, data.generation, client.legacyHealthSeq, data.reason === "heal" ? "heal" : "damage", client.player.id);
    }

    sendGameJoinFailed(client, code, details){
        client.sendPacket(Object.assign({
            command: "game_join_failed",
            code: String(code || "not_found")
        }, details || {}));
    }

    sendResolvedRoomSettings(client, mapDetails){
        client.sendPacket({
            command: "room_settings",
            mapName: mapDetails.mapName,
            playerCount: mapDetails.playerCount,
            requestedPlayerCount: mapDetails.requestedPlayerCount,
            capacityAdjusted: Boolean(mapDetails.capacityAdjusted),
            gameDuration: mapDetails.gameDuration,
            turnDuration: mapDetails.turnDuration,
            nu: mapDetails.nu,
            te: mapDetails.te,
            ba: mapDetails.ba,
            wi: mapDetails.wi,
            fillPolicy: mapDetails.fillPolicy || "auto"
        });
    }

    handleGameNameCheck(client, data){
        const room = canonicalRoomName(data.name);
        const cmd = {
            command:"game_name_return",
            name: room.ok ? room.displayName : String(data.name || ""),
            value: room.ok && !this.WOPW.getGame(room.key) ? 1 : 0
        };
        if(!room.ok) cmd.reason = room.code;
        client.sendPacket(cmd);
        return Boolean(cmd.value);
    }

    async handleCreateGame(client, data){
        const room = canonicalRoomName(data.gameName);
        if(!room.ok){
            this.sendGameJoinFailed(client, room.code);
            return false;
        }
        if(this.WOPW.getGame(room.key)){
            client.sendPacket({
                command:"game_name_return",
                name: room.displayName,
                value: 0,
                reason: "duplicate"
            });
            return false;
        }

        var mapDetails = this.WOPW.validateMapDetails(client, Object.assign({}, data));
        if(mapDetails.mapError){
            this.sendGameJoinFailed(client, mapDetails.mapError, {
                map: data.mapName || null,
                setting: mapDetails.invalidSetting || null
            });
            return false;
        }
        mapDetails.roomDisplayName = room.displayName;
        mapDetails.fillPolicy = "human_only";
        var gameId = this.WOPW.findSlot(client, mapDetails, room.key);

        if(!gameId){
            this.sendGameJoinFailed(client, "running");
            return false;
        }

        this.sendResolvedRoomSettings(client, mapDetails);
        client.gameId  = gameId;
        await client.sendJoinGame();
        return true;
    }

    async handleJoinGame(client, data){
        const room = canonicalRoomName(data.gameName);
        if(!room.ok){
            this.sendGameJoinFailed(client, room.code);
            return false;
        }
        var gameRef = this.WOPW.getGame(room.key);
        if(!gameRef){
            this.sendGameJoinFailed(client, "not_found");
            return false;
        }
        if(gameRef.isRunning() || gameRef.isGameOver()){
            this.sendGameJoinFailed(client, "running");
            return false;
        }
        if(gameRef.isFull()){
            this.sendGameJoinFailed(client, "full");
            return false;
        }
        if(!this.WOPW.mapsObj[gameRef.mapName]){
            this.sendGameJoinFailed(client, "map_unavailable", { map: gameRef.mapName });
            return false;
        }
        this.sendResolvedRoomSettings(client, {
            mapName: gameRef.mapName,
            playerCount: gameRef.playerCount,
            requestedPlayerCount: gameRef.requestedPlayerCount,
            capacityAdjusted: gameRef.capacityAdjusted,
            gameDuration: gameRef.gameDuration / 60000,
            turnDuration: gameRef.turnDuration / 1000,
            nu: gameRef.numberOfDeaths,
            te: gameRef.teamMode,
            ba: gameRef.balancedGame,
            wi: gameRef.useWind
        });
        client.gameId = room.key;
        await client.sendJoinGame();
        return true;
    }

    handleSynch(client, data){
        var game = client.getGame();
        if(!game || !data || !data.timeLoop || !Array.isArray(data.avatarList)) return;
        if(data.field && Array.isArray(data.field.explosions) && game.field){
            game.field.mergeExplosionRecords(data.field.explosions);
        }

        // Process unaffected avatars and terrain even when one entry crosses a
        // respawn boundary. The old global return made the server blind to all
        // other players for four seconds after every death.
        var now = Date.now();
        data.command = "set_synch";
        data.id = "oppenheimer";
        data.gameRecord = null;//client.getGame().getGameRecord("startGame");
        data.timeLoop.activeAvatar = game.currentPlayer;
        data.timeLoop.currentTick = game.tick;
        data.timeLoop.commandQueue = [];


        for(var i = 0; i < data.avatarList.length; i ++){
            data.avatarList[i].isWalkingLeft = "false";
            data.avatarList[i].isWalkingRight = "false";

            var authoritativeClient = client.getGame().clients[data.avatarList[i].player];
            if(authoritativeClient){
                var reportedGeneration = data.avatarList[i].generation;
                if(reportedGeneration === undefined) reportedGeneration = data.avatarList[i].respawnGeneration;
                var activeGeneration = Number(authoritativeClient.respawnGeneration || 0);
                var staleGeneration = reportedGeneration !== undefined && reportedGeneration !== null && reportedGeneration !== "" && Number(reportedGeneration) !== activeGeneration;
                var reportedComplete = data.avatarList[i].complete === true || data.avatarList[i].complete === "true";
                var respawnGraceActive = Boolean(authoritativeClient.respawnGraceUntil && now < authoritativeClient.respawnGraceUntil);

                data.avatarList[i].generation = activeGeneration;
                data.avatarList[i].respawnGeneration = activeGeneration;
                data.avatarList[i].complete = authoritativeClient.isDead() ? "true" : "false";
                data.avatarList[i].hp = Utils.intToString(authoritativeClient.isDead() ? 0 : authoritativeClient.avatar.hp);

                // Synchronization rebuilds every Flash avatar. During the
                // transition (or for an old packet), use the server's spawn
                // record instead of allowing stale X/Y/complete fields to
                // recreate a just-respawned avatar as dead.
                // A renderer never owns a bot snapshot. Rewriting its stale
                // client-side coordinates here prevents set_synch from
                // immediately undoing the server's bot_state update.
                if(!authoritativeClient.isDead() && (respawnGraceActive || staleGeneration || authoritativeClient.isBot)){
                    data.avatarList[i].X = Utils.intToString(authoritativeClient.avatar.X);
                    data.avatarList[i].Y = Utils.intToString(authoritativeClient.avatar.Y);
                    data.avatarList[i].Vx = Utils.intToString(authoritativeClient.isBot ? authoritativeClient.avatar.Vx || 0 : 0);
                    data.avatarList[i].Vy = Utils.intToString(authoritativeClient.isBot ? authoritativeClient.avatar.Vy || 0 : 0);
                }
            }

            // The renderer may synchronize its own avatar only. Accepting a
            // rendered bot snapshot overwrote the server collision state and
            // caused embedded bots/negative fall damage loops.
            var isSelfOrBot = authoritativeClient && authoritativeClient === client;

            if(isSelfOrBot && typeof data.avatarList[i].X === "string" && data.avatarList[i].X.length === 16 && typeof data.avatarList[i].Y === "string" && data.avatarList[i].Y.length === 16){
                var reportedX = Utils.stringToInt(data.avatarList[i].X);
                var reportedY = Utils.stringToInt(data.avatarList[i].Y);
                if(Number.isFinite(reportedX) && Number.isFinite(reportedY)){
                    if(!authoritativeClient.respawnGraceUntil || now >= authoritativeClient.respawnGraceUntil){
                        authoritativeClient.avatar.setPosition(reportedX, reportedY);
                        var map = game.WOPW.mapsObj[game.mapName] || {};
                        if(!authoritativeClient.isDead() && reportedY > Number(map.height || game.field.height || 1400) + 10){
                            console.log(">> Synch-reported world death: " + authoritativeClient.player.id + " y=" + reportedY);
                            game.setPlayerDead(authoritativeClient.player.id, game.currentPlayer);
                        }
                    }
                }
            }
        }

        // Never relay a full renderer snapshot. Battlefield.synchronization
        // destroys and reconstructs every avatar/projectile, so forwarding one
        // player's delayed frame made every other player jump backwards and
        // visually restored stale health. Position, health, terrain and bot
        // state already have dedicated incremental protocols.
    }

    handlePlayerDied(client, data){
        var game = client.getGame();
        var victim = game && game.clients[parseInt(data.id)];
        if(!game || !game.isRunning() || !victim || victim.isDead()) return;
        var expected = game.getHealthReporterId(victim);
        if(String(expected) !== String(client.player.id)) return;
        // Kept as a generation-aware fallback for legacy SWFs. New clients send
        // health_state and therefore cannot create a second death here.
        client.legacyDeathSeq = Number(client.legacyDeathSeq || 0) + 1;
        game.applyHealthState(client, victim.player.id, 0, data.generation, client.legacyDeathSeq, "damage", data.killerId || game.currentPlayer);
    }

    handleExiting(client, data){
        client.getGame().sendPacketE(data, client);
    }
}

module.exports = Handler;
