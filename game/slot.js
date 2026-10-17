"use strict";

var Utils = require('./helpers/utils.js');
var Field = require('./field.js');
var CollisionAverage = require('./physics/collision.js');
var WeaponManager = require('./weapons/weapon.manager.js');
var BotClient = require('./client/client.bot.js');
var BotController = require('./bot.controller.js');
var Progression = require('../shared/progression.js');
var Levels = require('../shared/levels.js');
var calculateAccessoryBonuses = require('../shared/accessory-bonuses.js').calculateAccessoryBonuses;
var publicPlayerRecord = require('../shared/player-wire.js').publicPlayerRecord;


var DEBUG = process.env.DEBUG === 'true' || false;
var DEFAULT_SUPPORTED_PLAYER_COUNTS = [2, 4, 6];

function ruleBoolean(value){
    if(typeof value === "string") return value.toLowerCase() === "true" || value === "1";
    return value === true || value === 1;
}

/*function Slot(wopw, gameId, mapName, playerCount, gameDuration, turnDuration){

}*/


class Slot{
    constructor(wopw, gameId, mapName, playerCount, gameDuration, turnDuration, rules){
        this.WOPW           = wopw;
        this.gameId         = gameId;

        this.mapName        = mapName;
        var capacity = this.resolveMapCapacity(playerCount);
        this.requestedPlayerCount = capacity.requestedPlayerCount;
        this.supportedPlayerCounts = capacity.supportedPlayerCounts;
        this.spawnPositions = capacity.spawnPositions;
        this.spawnCapacity  = capacity.spawnPositions.length;
        this.playerCount    = capacity.playerCount;
        this.capacityAdjusted = this.playerCount !== this.requestedPlayerCount;
        if(this.capacityAdjusted){
            console.warn(
                "map_capacity_adjusted map=" + JSON.stringify(this.mapName) +
                " requested=" + this.requestedPlayerCount +
                " effective=" + this.playerCount +
                " authoredSpawns=" + this.spawnCapacity
            );
        }
        this.gameDuration   = Number.isFinite(Number(gameDuration)) && Number(gameDuration) > 0
            ? Number(gameDuration)
            : 3 * 60 * 1000;
        this.turnDuration   = turnDuration;
        rules = rules || {};
        this.numberOfDeaths = Number(rules.nu) === 1 ? 1 : 0;
        this.teamMode       = ruleBoolean(rules.te);
        this.balancedGame   = ruleBoolean(rules.ba);
        this.useWind        = ruleBoolean(rules.wi);
        this.fillPolicy     = rules.fillPolicy === "human_only" ? "human_only" : "auto";

        this.initialize();
    }

    resolveMapCapacity(playerCount){
        var configuredCounts = this.WOPW && this.WOPW.config && Array.isArray(this.WOPW.config.maxPlayers)
            ? this.WOPW.config.maxPlayers
            : DEFAULT_SUPPORTED_PLAYER_COUNTS;
        var supportedPlayerCounts = configuredCounts.map(Number).filter(function(value){
            return Number.isInteger(value) && value >= 2;
        }).filter(function(value, index, values){
            return values.indexOf(value) === index;
        }).sort(function(a, b){ return a - b; });

        if(!supportedPlayerCounts.length){
            throw new Error("No supported multiplayer capacities are configured");
        }

        var requestedPlayerCount = Number(playerCount);
        if(!Number.isInteger(requestedPlayerCount) || supportedPlayerCounts.indexOf(requestedPlayerCount) < 0){
            throw new Error("Unsupported player capacity: " + playerCount);
        }

        var map = this.WOPW && this.WOPW.mapsObj && this.WOPW.mapsObj[this.mapName];
        if(!map || !Array.isArray(map.positions)){
            throw new Error("Missing authored spawn positions for map: " + this.mapName);
        }

        var seenPositions = Object.create(null);
        var spawnPositions = map.positions.map(function(position, index){
            if(!Array.isArray(position) || position.length < 2){
                throw new Error("Invalid spawn position " + index + " for map: " + this.mapName);
            }
            var x = Number(position[0]);
            var y = Number(position[1]);
            if(!Number.isFinite(x) || !Number.isFinite(y)){
                throw new Error("Non-numeric spawn position " + index + " for map: " + this.mapName);
            }
            var positionKey = x + ":" + y;
            if(seenPositions[positionKey]){
                throw new Error("Duplicate spawn position " + positionKey + " for map: " + this.mapName);
            }
            seenPositions[positionKey] = true;
            return [x, y];
        }.bind(this));

        var availableCounts = supportedPlayerCounts.filter(function(value){
            return value <= requestedPlayerCount && value <= spawnPositions.length;
        });
        if(!availableCounts.length){
            throw new Error(
                "Map " + this.mapName + " has " + spawnPositions.length +
                " authored spawn positions, below the minimum supported capacity"
            );
        }

        return {
            requestedPlayerCount: requestedPlayerCount,
            supportedPlayerCounts: supportedPlayerCounts,
            spawnPositions: spawnPositions,
            playerCount: availableCounts[availableCounts.length - 1]
        };
    }

    initialize(){
        if(this.startingTimeout) clearTimeout(this.startingTimeout);
        if(this.startHandshakeTimeout) clearTimeout(this.startHandshakeTimeout);
        if(this.botFillTimer) clearTimeout(this.botFillTimer);
        if(this.endGameCleanupTimer) clearTimeout(this.endGameCleanupTimer);
        if(this.deathBurstTimer) clearTimeout(this.deathBurstTimer);
        if(this.respawnTimers){
            for(var respawnId in this.respawnTimers) clearTimeout(this.respawnTimers[respawnId]);
        }
        this.currentPlayer = -1;

        this.deaths = [];

        this.initialCount = 0;
        this.randomSeed = 0;

        this.startingTime = 0;
        this.tick         = 0;
        this.lastUpdateAt = 0;
        this.lastTickStep = 10;
        this.lastSynchTickSentAt = 0;
        this.turnEndTick  = 0;
        this.turnHardEndTick = 0;
        this.turnCleanupEpoch = -1;
        this.turnCleanupDeadline = 0;
        this.currentTurnDeathHold = null;

        this.clients        = {};
        this.status         = "idle";
        this.min            = this.playerCount;
        this.skip           = [];
        this.time           = "";
        this.cl             = 0;
        this.sumOfLevels    = 0;
        this.session        = "undefined";
        this.deadPlayers = [];
        this.initialCount = 0;

        this.weapon = new WeaponManager(this);
        this.field = new Field(this);

        this.commands = [];
        this.physicsObjects = [];

        this.lastSynchCheck = {"command": "synch_check", "synchCheck" : ""};
        this.lastSynchAt = Date.now();

        this.completedTurns = 0;
        this.turnEpoch = 0;
        this.healthRevision = 0;
        this.terrainRevision = 0;
        this.lastTerrainMutationAt = 0;
        this.respawnTerrainBarrierUntil = 0;
        this.deathBurstTimer = null;
        this.deathBurstEpoch = -1;
        this.deathBurstIds = [];
        this.respawnTokenSequence = 0;
        this.respawnReservations = [];
        this.nativeBotRendererId = null;
        this.botControllerEpoch = 0;
        this.botActionSeq = 0;
        this.botStateSequence = 0;
        this.lastBotStateAtTick = -Infinity;
        this.worldStateSequence = 0;
        this.lastWorldStateAtTick = -Infinity;
        this.lastWorldTerrainBroadcastRevision = -1;
        this.lastWorldTerrainBroadcastCount = 0;
        this.worldStateForcePending = false;
        this.combatScores = Object.create(null);
        this.projectileSequence = 0;
        this.botPendingProjectile = null;
        this.healAuthorizations = [];

        this.synchCmd = null;
        this.startingTimeout = null;
        this.startHandshakeTimeout = null;
        this.awaitingMapLoad = false;
        this.mapLoadId = null;
        this.mapLoadSequence = 0;
        this.mapLoadExpectedRenderers = Object.create(null);
        this.botFillTimer = null;
        this.endGameCleanupTimer = null;
        this.pendingGameOverSince = 0;
        this.endingGame = false;
        this.matchEndTick = 0;
        this.scores = {};
        this.deathCounts = {};
        this.petPowerUsage = {};
        this.matchPlayerIds = [];
        this.matchMedalState = {};
        this.matchId = "";
        this.progressionSnapshots = {};
        this.endGamePromise = null;
        this.respawnTimers = {};
        this.respawnDeadlines = {};
        this.respawnAckStates = {};
        this.nextRespawnDispatchAt = 0;
        this.botFillDeadline = 0;
        this.botFillFirstHumanAt = 0;
        this.botFillLastHumanAt = 0;
        this.botFillScheduled = false;
        this.botFillCompleted = false;
        if(this.startErrorResetTimer) clearTimeout(this.startErrorResetTimer);
        this.startErrorResetTimer = null;
        // Lobby players sent to this room by quick play / join hold their seat
        // until their game socket authenticates (or the hold expires). Without
        // it, bots or a second lobby player could take the seat meanwhile.
        this.seatReservations = Object.create(null);
        this.lastReservationAt = 0;
        this.countdownExtensions = 0;
        this.nativeBotAICapable = false;
        this.nativeBotAI = false;
        this.nativeBotRosterReady = false;
        this.nativeBotRosterRendererId = null;
        this.nativeBotRosterEpoch = 0;
        this.nativeBotTimeouts = 0;
        this.botOrdinal = 0;
        this.botController = new BotController(this);
    }

    getCollisionAverage(obj, pointSet, checkNonAvatar, checkAvatar, checkField, checkWalls) {

        var avg = new CollisionAverage();
        for(var j = 0; j < pointSet.length; j++){
            var fieldX = obj.X + pointSet[j].X;
            var fieldY = obj.Y + pointSet[j].Y;

            for (var i = 0; i < this.physicsObjects.length; i++) {
                if(this.physicsObjects[i].type == "avatar" && !checkAvatar) continue;
                if((this.physicsObjects[i].type == "crate" || this.physicsObjects[i].type == "mine") && !checkNonAvatar) continue;
                if(!this.physicsObjects[i].complete && this.physicsObjects[i] != obj){
                    if(this.physicsObjects[i].checkCollision(fieldX, fieldY)){
                        avg.sumX += pointSet[j].X;
                        avg.sumY += pointSet[j].Y;
                        avg.nP++;
                    }
                }
            }
        }

        if(checkWalls){
            for(var j = 0; j < pointSet.length; j++){
                var fieldX = obj.X + pointSet[j].X;

                if(fieldX < 0 || fieldX > this.field.width){
                    avg.sumX += pointSet[j].X;
                    avg.sumY += pointSet[j].Y;
                    avg.nP++;
                    avg.nWall++;
                }
            }
        }

        if(checkField){
            avg = this.field.checkCollisionPointSet(obj.X, obj.Y, pointSet, avg);
        }

        if (avg.nP != 0){
            avg.sumX = (avg.sumX / avg.nP);
            avg.sumY = (avg.sumY / avg.nP);
        }

        return avg;
    }


    update(){
        if(this.isRunning()){
            this.processRespawns();
            this.processRespawnAcks();
        }
        this.checkGame();

        if(this.isRunning()){
            // One tick is 10 ms. Advance by the wall-clock time actually
            // elapsed so a stalled event loop cannot stretch turn deadlines,
            // clamped so a long pause never skips a whole turn at once.
            var now = Date.now();
            var tickStep = Number(this.lastUpdateAt) > 0
                ? Math.max(1, Math.min(50, Math.round((now - this.lastUpdateAt) / 10)))
                : Math.round(this.updateIntervalMs() / 10);
            this.lastUpdateAt = now;
            this.tick += tickStep;
            this.lastTickStep = tickStep;

            if(this.tick - Number(this.lastSynchTickSentAt || 0) >= 50){
                this.lastSynchTickSentAt = this.tick - (this.tick % 50);
                if(DEBUG)
                    console.log(">> Game Tick: " + this.tick);
                this.sendTick();
            }

            if(DEBUG && Date.now() - this.lastSynchAt > 20000){
                console.log("haven't received a client synchronization tick in 20s");
                this.lastSynchAt = Date.now();
            }

            for(var i = 0; i < this.physicsObjects.length; i++){
                // The connected Flash renderer owns avatar physics and the
                // destructible terrain mask. Simulating the same avatar here
                // uses a stale/server-only mask, so its invisible copy can fall
                // through the floor and manufacture a death while the rendered
                // player is still alive. Client position/death packets keep the
                // authoritative avatar state below; only non-avatar objects are
                // stepped by the server.
                if(this.physicsObjects[i].type === "avatar") continue;
                if(this.physicsObjects[i].complete){
                    this.physicsObjects.splice(i, 1);
                    i--;
                }else{
                    this.physicsObjects[i].step();
                    this.physicsObjects[i].move();
                }
            }
            // Human avatars remain renderer-authoritative. Server-created bots
            // have no socket, so step their collision model on the verified
            // terrain mask and publish snapshots back to each renderer.
            this.stepServerBots();
            this.sendBotState();
            this.sendWorldState();
            if(!this.nativeBotAI) this.botController.update();
        }
    }

    updateIntervalMs(){
        return Number(this.WOPW && this.WOPW.updateIntervalMs) > 0 ? Number(this.WOPW.updateIntervalMs) : 100;
    }

    hasLiveSupport(client){
        if(!client || !client.avatar || !this.field || !this.field.bitmapData) return false;
        var avatar = client.avatar;
        // The avatar is a circle of boundRadius around (X, Y), so its feet
        // are at Y + boundRadius. Probing 20 px below the feet reported thin
        // platforms and crater rims as "no support" and killed resting bots.
        var supportY = Number(avatar.Y) + Number(avatar.boundRadius || 20);
        var supportedColumns = 0;
        [-16, 0, 16].forEach(function(offset){
            for(var dy = -6; dy <= 14; dy += 4){
                if(this.field.checkFieldCollisionPoint(Math.round(Number(avatar.X) + offset), Math.round(supportY + dy))){
                    supportedColumns++;
                    break;
                }
            }
        }.bind(this));
        // One supported column is enough: physics already rests the pet on
        // a ledge edge or stair tip; zero columns means it hangs over a hole.
        return supportedColumns >= 1;
    }

    // Single entry point for every terrain change (renderer batches, legacy
    // synchronization, server-side digs) so they all bump the revision that
    // clients, respawn guards and bots converge on.
    applyTerrainMutation(records, options){
        if(!this.field) return 0;
        var accepted = this.field.mergeExplosionRecords(records);
        if(accepted <= 0) return 0;
        var craters = Array.isArray(this.field.lastAcceptedRecords) ? this.field.lastAcceptedRecords.slice() : [];
        this.terrainRevision = Number(this.terrainRevision || 0) + 1;
        this.lastTerrainMutationAt = Date.now();
        if(this.isRunning()){
            this.applyBotExplosionImpulses(craters);
            this.reconcileBotsAfterTerrainMutation();
            this.scheduleWorldState();
            this.sendBotState(false);
        }
        return accepted;
    }

    // Bots are simulated only here, so the knockback a renderer applies to a
    // bot is overwritten by the next bot_state. Re-apply the original
    // Battlefield.explode impulse model once per accepted crater.
    applyBotExplosionImpulses(craters){
        if(!Array.isArray(craters) || !craters.length || !this.WOPW || !this.WOPW.weaponsObj) return 0;
        var pushed = 0;
        for(var i = 0; i < craters.length; i++){
            var crater = craters[i];
            var weapon = crater && crater.type ? this.WOPW.weaponsObj[crater.type] : null;
            if(!weapon) continue;
            var r1 = Number(weapon.R1) || 0;
            var r2 = Number(weapon.R2) || 0;
            var damage = Number(weapon.damage) || 0;
            var weaponImpulse = Number(weapon.impulse);
            if(!(r2 > 0) || !(damage > 0)) continue;
            if(!Number.isFinite(weaponImpulse)) weaponImpulse = 0.0007;
            var inner = 25 + r1;
            var outer = 25 + r2;
            for(var id in this.clients){
                var bot = this.clients[id];
                if(!bot || !bot.isBot || !bot.avatar || bot.isDead() || bot.avatar.complete) continue;
                var dx = crater.x - Number(bot.avatar.X);
                var dy = crater.y - Number(bot.avatar.Y);
                var d2 = dx * dx + dy * dy;
                if(d2 === 0 || d2 > outer * outer) continue;
                var d = Math.sqrt(d2);
                var force = d2 < inner * inner || outer <= inner ? damage : damage * (1 - (d - inner) / (outer - inner));
                var chassisImpulse = Number(bot.avatar.properties && bot.avatar.properties.impulse);
                var impulse = -force * weaponImpulse * (Number.isFinite(chassisImpulse) && chassisImpulse > 0 ? chassisImpulse : 1);
                if(!Number.isFinite(impulse) || impulse === 0) continue;
                bot.avatar.Vx = Number(bot.avatar.Vx || 0) + (dx / d) * impulse;
                bot.avatar.Vy = Number(bot.avatar.Vy || 0) + (dy / d) * impulse;
                if(typeof bot.avatar.stopWalking === "function") bot.avatar.stopWalking();
                bot._unsupportedTicks = 0;
                pushed++;
            }
        }
        if(pushed > 0) this.sendBotState(true);
        return pushed;
    }

    reconcileBotsAfterTerrainMutation(){
        for(var id in this.clients){
            var bot = this.clients[id];
            if(!bot || !bot.isBot || !bot.avatar || bot.isDead()) continue;
            if(this.hasLiveSupport(bot)) continue;
            bot.avatar.stopWalking();
            bot.avatar.waitingForJump = false;
            bot.avatar.waitingForSuper = false;
            // Start the fall, but keep an upward knockback that was just applied.
            var currentVy = Number(bot.avatar.Vy || 0);
            bot.avatar.Vy = currentVy < -0.01 ? currentVy : Math.max(currentVy, 0.02);
            bot._unsupportedTicks = Math.max(1, Number(bot._unsupportedTicks || 0));
        }
    }

    isBotEmbedded(bot){
        if(!bot || !bot.avatar || !this.field.bitmapData || !bot.avatar.boundPoints) return false;
        var average = this.getCollisionAverage(bot.avatar, bot.avatar.boundPoints, false, false, true, true);
        return average.nP >= Math.max(6, Math.floor((bot.avatar.nChecks || bot.avatar.boundPoints.length) * 0.8));
    }

    recoverBot(bot, reason){
        if(!bot || !bot.avatar || bot.isDead()) return false;
        var position = this.getRandomRespawnPosition(bot);
        if(!position) return false;
        bot.avatar.X = position.x;
        bot.avatar.Y = position.y;
        bot.avatar.Vx = 0;
        bot.avatar.Vy = 0;
        bot.avatar.Va = 0;
        bot.avatar.stopWalking();
        bot._embeddedTicks = 0;
        this.recordRespawnPosition(bot, position);
        console.warn("bot_recovered game=" + JSON.stringify(this.gameId) + " bot=" + bot.player.id + " reason=" + reason);
        this.sendBotState(true);
        return true;
    }

    stepServerBots(){
        if(!this.field.bitmapData) return;
        for(var id in this.clients){
            var bot = this.clients[id];
            if(!bot || !bot.isBot || !bot.avatar || bot.isDead()) continue;
            var health = this.initializeHealth(bot, false);
            try{
                // The original physics model uses a 10 ms dt. Run one substep
                // per elapsed room tick so bots move at real speed whatever the
                // room update interval, without tunnelling through terrain.
                var physicsSteps = Math.max(1, Math.min(50, Number(this.lastTickStep) || 10));
                for(var physicsStep = 0; physicsStep < physicsSteps; physicsStep++){
                    bot.avatar.step();
                    bot.avatar.move(true);
                }
            }catch(error){
                console.error("bot_physics_error bot=" + bot.player.id + " error=" + error.message);
                this.recoverBot(bot, "physics_error");
                continue;
            }
            if(![bot.avatar.X, bot.avatar.Y, bot.avatar.Vx, bot.avatar.Vy].every(function(value){ return Number.isFinite(Number(value)); })){
                // A NaN would serialise as null and draw the bot at (0, 0).
                bot.avatar.Vx = 0;
                bot.avatar.Vy = 0;
                if(!this.recoverBot(bot, "non_finite")){
                    var last = bot.lastFinitePosition;
                    if(last){
                        bot.avatar.X = last.x;
                        bot.avatar.Y = last.y;
                    }
                }
                continue;
            }
            bot.lastFinitePosition = { x: Number(bot.avatar.X), y: Number(bot.avatar.Y) };
            // Physics is allowed to resolve terrain, never to manufacture a
            // fall/drowning damage loop. Health remains server-authoritative.
            if(health) bot.avatar.hp = health.hp;
            var fatalFall = bot.avatar.Y > this.field.height + 10;
            if(fatalFall){
                this.killWorldFall(bot, this.currentPlayer);
                continue;
            }
            var outOfBounds = bot.avatar.X < 0 || bot.avatar.X > this.field.width || bot.avatar.Y < -120;
            if(this.isBotEmbedded(bot)) bot._embeddedTicks = Number(bot._embeddedTicks || 0) + 1;
            else bot._embeddedTicks = 0;
            if(this.hasLiveSupport(bot)){
                bot._unsupportedTicks = 0;
                bot._unsupportedMs = 0;
            }else if(Math.abs(Number(bot.avatar.Vy || 0)) < 0.01 ||
                bot.avatar.isWalkingLeft || bot.avatar.isWalkingRight){
                bot._unsupportedTicks = Number(bot._unsupportedTicks || 0) + 1;
                // Measured in time, not room updates: the loop rate changed
                // from 10 to 20 Hz and a count silently halved the grace.
                bot._unsupportedMs = Number(bot._unsupportedMs || 0) + physicsSteps * 10;
                bot.avatar.stopWalking();
                bot.avatar.Vy = Math.max(Number(bot.avatar.Vy || 0), 0.02);
            }
            if(Number(bot._unsupportedMs || 0) >= 1500){
                bot._unsupportedTicks = 0;
                bot._unsupportedMs = 0;
                // Physics is holding the bot in place on geometry too narrow
                // for the support probe (a stair edge, a crater rim). Put it
                // on verified ground instead of awarding a free kill.
                if(this.recoverBot(bot, "support_lost")) continue;
                console.warn("bot_support_lost game=" + JSON.stringify(this.gameId) + " bot=" + bot.player.id);
                this.killWorldFall(bot, this.currentPlayer);
                continue;
            }
            if(outOfBounds || bot._embeddedTicks >= 3) this.recoverBot(bot, outOfBounds ? "bounds" : "embedded");
        }
    }

    sendBotState(force){
        if(!this.isRunning()) return;
        // The room itself updates at 10 Hz, so `tick % 10` sent a full bot
        // snapshot on every update. Five samples per second are enough for the
        // 24 fps renderer's velocity interpolation and halve packet/render
        // pressure without changing server physics.
        // 10 Hz while a bot is visibly moving (walking, falling, knocked
        // back) so renderers extrapolate less; 5 Hz when everything rests.
        var botMoving = Object.values(this.clients).some(function(client){
            return client && client.isBot && client.avatar && !client.isDead() &&
                (client.avatar.isWalkingLeft || client.avatar.isWalkingRight ||
                    Math.abs(Number(client.avatar.Vx || 0)) > 0.01 || Math.abs(Number(client.avatar.Vy || 0)) > 0.01);
        });
        if(!force && this.tick - this.lastBotStateAtTick < (botMoving ? 10 : 20)) return;
        var bots = [];
        for(var id in this.clients){
            var bot = this.clients[id];
            if(!bot || !bot.isBot || !bot.avatar) continue;
            var health = this.initializeHealth(bot, false);
            bots.push({
                id: bot.player.id,
                x: Math.round(bot.avatar.X),
                y: Math.round(bot.avatar.Y),
                vx: Number(bot.avatar.Vx || 0),
                vy: Number(bot.avatar.Vy || 0),
                hp: Math.max(0, Number(health && health.hp || bot.avatar.hp || 0)),
                maxHp: Math.max(1, Number(health && health.maxHp || bot.avatar.maxHealth || bot.avatar.properties && bot.avatar.properties.hp || 100)),
                generation: Number(bot.respawnGeneration || 0),
                complete: Boolean(bot.avatar.complete),
                embedded: Number(bot._embeddedTicks || 0) > 0
            });
        }
        if(!bots.length) return;
        this.lastBotStateAtTick = this.tick;
        this.sendPacket({
            command: "bot_state",
            turnEpoch: this.turnEpoch,
            controllerEpoch: this.botControllerEpoch,
            sequence: ++this.botStateSequence,
            bots: bots
        });
    }

    scheduleWorldState(){
        this.worldStateForcePending = true;
    }

    sendWorldState(force){
        if(!this.isRunning()) return;
        if(!force && this.worldStateForcePending && this.tick - this.lastWorldStateAtTick >= 10) force = true;
        if(!force && this.tick - this.lastWorldStateAtTick < 50) return;
        this.worldStateForcePending = false;
        this.lastWorldStateAtTick = this.tick;
        var players = [];
        for(var id in this.clients){
            var client = this.clients[id];
            if(!client || !client.avatar) continue;
            var health = this.initializeHealth(client, false);
            players.push({
                id: client.player.id,
                x: Math.round(Number(client.avatar.X || 0)),
                y: Math.round(Number(client.avatar.Y || 0)),
                vx: Number(client.avatar.Vx || 0),
                vy: Number(client.avatar.Vy || 0),
                hp: client.isDead() ? 0 : Math.max(0, Number(health && health.hp || client.avatar.hp || 0)),
                maxHp: Math.max(1, Number(health && health.maxHp || client.avatar.maxHealth || 100)),
                generation: Number(client.respawnGeneration || 0),
                healthRevision: Number(health && health.revision || 0),
                positionRevision: Number(client.positionRevision || 0),
                score: Math.max(0, Math.round(Number(this.combatScores[String(client.player.id)] || 0))),
                dead: client.isDead()
            });
        }
        var sequence = ++this.worldStateSequence;
        var records = this.field && Array.isArray(this.field.explosionRecord) ? this.field.explosionRecord : [];
        var revisionChanged = Number(this.lastWorldTerrainBroadcastRevision) !== Number(this.terrainRevision);
        // Normally only the craters added since the last broadcast are sent
        // (terrainFrom = the revision they extend). A periodic full list lets
        // a renderer that fell behind recover; up-to-date renderers skip it.
        var fullTerrain = sequence % 10 === 0 || Number(this.lastWorldTerrainBroadcastRevision) < 0 ||
            Number(this.lastWorldTerrainBroadcastCount || 0) > records.length;
        var terrainFrom = 0;
        var slice = [];
        if(fullTerrain){
            slice = records;
        }else if(revisionChanged){
            terrainFrom = Number(this.lastWorldTerrainBroadcastRevision);
            slice = records.slice(Number(this.lastWorldTerrainBroadcastCount || 0));
        }
        var terrain = slice.map(function(record){
            return [
                Utils.stringToInt(record[0]),
                Utils.stringToInt(record[1]),
                Utils.stringToInt(record[2])
            ];
        }).filter(function(record){
            return record.every(Number.isFinite);
        });
        if(fullTerrain || revisionChanged){
            this.lastWorldTerrainBroadcastRevision = Number(this.terrainRevision);
            this.lastWorldTerrainBroadcastCount = records.length;
        }
        this.sendPacket({
            command: "world_state",
            // Room ids are reused between matches while the renderer keeps
            // its last sequence/terrain revision per id. The match identity
            // makes every new match reset that ordering state, otherwise the
            // second match in a room ignored world_state (and its craters).
            gameId: String(this.matchId || this.gameId),
            sequence: sequence,
            turnEpoch: Number(this.turnEpoch || 0),
            terrainRevision: Number(this.terrainRevision || 0),
            terrainFrom: terrainFrom,
            terrain: terrain,
            players: players
        });
    }

    recordProgression(client, field, amount){
        if(!client || client.isBot || !client.player) return false;
        Progression.recordPlayerStat(client.player, field, amount);
        if(field === "kills" || field === "deaths"){
            Progression.recordActivePetStat(client.player, field, amount);
        }
        return true;
    }

    getMatchMedalState(client){
        if(!client || !client.player) return null;
        var id = String(client.player.id);
        if(!this.matchMedalState[id]){
            this.matchMedalState[id] = {
                shots: 0,
                moves: 0,
                damageTaken: 0,
                damageDealt: 0,
                crates: 0,
                onlyMortar: true,
                onlyGrenade: true,
                onlyPetPower: true,
                killEpoch: -1,
                turnKills: 0
            };
        }
        return this.matchMedalState[id];
    }

    recordMatchMove(client){
        var state = this.getMatchMedalState(client);
        if(state) state.moves++;
    }

    recordMatchShot(client, weapon, properties, isCrate){
        var state = this.getMatchMedalState(client);
        if(!state) return;
        if(isCrate){
            state.crates++;
            this.awardProgressionMedal(client, "pack_rat");
            return;
        }
        state.shots++;
        state.onlyMortar = state.onlyMortar && weapon === "mortar";
        state.onlyGrenade = state.onlyGrenade && weapon === "grenade";
        state.onlyPetPower = state.onlyPetPower && Boolean(properties && properties.petWeapon);
    }

    recordMatchDamage(target, source, amount){
        var targetState = this.getMatchMedalState(target);
        if(targetState) targetState.damageTaken += Math.max(0, Number(amount) || 0);
        var sourceState = this.getMatchMedalState(source);
        if(sourceState) sourceState.damageDealt += Math.max(0, Number(amount) || 0);
    }

    awardProgressionMedal(client, type){
        if(!client || client.isBot || !client.player) return false;
        var event = Progression.recordMedalEvent(client.player, type);
        if(!event.unlocked.length) return false;
        if(typeof client.sendPacket === "function"){
            client.sendPacket({
                command: "medal_unlock",
                medalList: client.player.medals.medalList,
                medalCounts: client.player.medals.medalCounts,
                newItems: [type],
                totalMedals: client.player.medals.totalMedals,
                guid: String(client.player.id),
                playerGuid: String(client.player.id),
                version: 1
            });
        }
        return true;
    }

    captureProgressionSnapshot(client){
        if(!client || client.isBot || !client.player) return null;
        var player = client.player;
        Progression.ensureProgression(player);
        var petId = String(player.currentPet || "");
        var snapshot = {
            xp: Number(player.xp || 0),
            gold: Number(player.gold || 0),
            treats: Number(player.treats || 0),
            stats: JSON.parse(JSON.stringify(player.stats || {})),
            petId: petId,
            pet: JSON.parse(JSON.stringify(player.ownedPets && player.ownedPets[petId] || {})),
            weapons: JSON.parse(JSON.stringify(player.userWeaponsOwned || {})),
            medals: JSON.parse(JSON.stringify(player.medals || {}))
        };
        this.progressionSnapshots[String(player.id)] = snapshot;
        return snapshot;
    }

    progressionDelta(before, after){
        return Number(after || 0) - Number(before || 0);
    }

    async persistProgression(client){
        if(!client || client.isBot) return null;
        var snapshot = this.progressionSnapshots[String(client.player.id)];
        if(!snapshot || !client.db || typeof client.db.applyMatchProgression !== "function"){
            if(typeof client.updatePlayerData === "function") await client.updatePlayerData({ force: true });
            if(typeof client.sendUpdate === "function") client.sendUpdate();
            return client.player;
        }

        var player = client.player;
        Progression.ensureProgression(player);
        var increments = {
            xp: this.progressionDelta(snapshot.xp, player.xp),
            gold: this.progressionDelta(snapshot.gold, player.gold),
            treats: this.progressionDelta(snapshot.treats, player.treats)
        };
        var statFields = new Set(Object.keys(snapshot.stats || {}).concat(Object.keys(player.stats || {})));
        statFields.forEach(function(field){
            var delta = this.progressionDelta(snapshot.stats[field], player.stats[field]);
            if(delta) increments["stats." + field] = delta;
            if(field === "games") increments.gamecount = delta;
            if(["wins", "losses", "kills", "deaths"].indexOf(field) >= 0) increments[field] = delta;
        }.bind(this));

        var weaponFields = new Set(Object.keys(snapshot.weapons || {}).concat(Object.keys(player.userWeaponsOwned || {})));
        weaponFields.forEach(function(type){
            if(!/^[A-Za-z0-9_-]+$/.test(type)) return;
            var delta = this.progressionDelta(snapshot.weapons[type], player.userWeaponsOwned[type]);
            if(delta) increments["userWeaponsOwned." + type] = delta;
        }.bind(this));

        var sets = { schemaVersion: Number(player.schemaVersion || 3) };
        var petId = snapshot.petId;
        var activePet = player.ownedPets && player.ownedPets[petId];
        if(activePet && /^[A-Za-z0-9_-]+$/.test(petId)){
            for(var petField of ["played", "wins", "losses", "kills", "deaths", "gold"]){
                var petDelta = this.progressionDelta(snapshot.pet && snapshot.pet[petField], activePet[petField]);
                if(petDelta) increments["ownedPets." + petId + "." + petField] = petDelta;
            }
            sets["ownedPets." + petId + ".lastPlayed"] = Number(activePet.lastPlayed || 0);
        }

        var beforeMedals = snapshot.medals || {};
        var afterMedals = player.medals || {};
        var medalTypes = new Set(Object.keys(beforeMedals.medalCounts || {}).concat(Object.keys(afterMedals.medalCounts || {})));
        medalTypes.forEach(function(type){
            if(!/^[A-Za-z0-9_-]+$/.test(type)) return;
            var delta = this.progressionDelta(beforeMedals.medalCounts && beforeMedals.medalCounts[type], afterMedals.medalCounts && afterMedals.medalCounts[type]);
            if(delta) increments["medals.medalCounts." + type] = delta;
            var beforeTiers = beforeMedals.medalList && beforeMedals.medalList[type] || {};
            var afterTiers = afterMedals.medalList && afterMedals.medalList[type] || {};
            for(var tier in afterTiers){
                if(!Object.prototype.hasOwnProperty.call(beforeTiers, tier) && /^[A-Za-z0-9_-]+$/.test(tier)){
                    sets["medals.medalList." + type + "." + tier] = afterTiers[tier];
                }
            }
        }.bind(this));
        var totalMedalDelta = this.progressionDelta(beforeMedals.totalMedals, afterMedals.totalMedals);
        if(totalMedalDelta) increments["medals.totalMedals"] = totalMedalDelta;

        var result = await client.db.applyMatchProgression({
            userId: client.player.id,
            matchId: this.matchId,
            increments: increments,
            sets: sets,
            receipt: {
                gameId: this.gameId,
                map: this.mapName,
                endedAt: Date.now()
            }
        });
        if(!result || !result.ok || !result.user){
            throw new Error("match_progression_failed:" + (result && result.reason || "unknown"));
        }
        for(var field of [
            "xp", "gold", "treats", "stats", "wins", "losses", "gamecount",
            "kills", "deaths", "ownedPets", "userWeaponsOwned", "medals", "schemaVersion"
        ]){
            if(result.user[field] !== undefined) client.player[field] = result.user[field];
        }
        client.progressionDirty = false;
        var progressionPacket = {
            command: "match_progression_return",
            matchId: this.matchId,
            revision: result.user.updatedAt instanceof Date ? result.user.updatedAt.getTime() : Date.now(),
            stats: client.player.stats,
            xp: Number(client.player.xp || 0),
            level: Levels.levelFromXp(client.player.xp, this.WOPW.levelsObj),
            gold: Number(client.player.gold || 0),
            activePetStats: client.player.ownedPets && client.player.ownedPets[String(client.player.currentPet)] || null
        };
        if(typeof client.sendUpdate === "function") client.sendUpdate();
        if(typeof client.sendPacket === "function") client.sendPacket(progressionPacket);
        if(this.WOPW && typeof this.WOPW.sendLobbyPlayerPacket === "function"){
            this.WOPW.sendLobbyPlayerPacket(client.player.id, progressionPacket);
        }
        return client.player;
    }

    //### update methods ###

    checkIfTurnIsOver(){
        if(this.turnEndTick > 0 && this.turnEndTick <= this.tick) {
            // Give every renderer one bounded opportunity to remove orphaned
            // projectile/effect objects before the epoch changes. Late
            // completions from the old epoch are rejected by the normal turn
            // guards, so this transition remains idempotent.
            if(Number(this.turnCleanupEpoch) !== Number(this.turnEpoch)){
                this.turnCleanupEpoch = Number(this.turnEpoch);
                this.turnCleanupDeadline = this.tick + 50;
                this.turnEndTick = this.turnCleanupDeadline;
                this.sendPacket({
                    command: "force_effect_cleanup",
                    turnEpoch: this.turnEpoch,
                    reason: "turn_deadline"
                });
                if(DEBUG) console.warn(
                    "turn_effect_cleanup game=" + JSON.stringify(this.gameId) +
                    " epoch=" + this.turnEpoch +
                    " player=" + this.currentPlayer
                );
                return;
            }
            if(DEBUG)
                console.log(">> Changing turn");
            var timedOutClient = this.clients[this.currentPlayer];
            if(this.nativeBotAI && timedOutClient && timedOutClient.isBot){
                this.nativeBotTimeouts++;
                this.nativeBotAI = false;
                this.nativeBotAICapable = false;
                this.botController.reset();
                console.error(
                    "native_bot_ai_timeout player=" + timedOutClient.player.id +
                    " game=" + JSON.stringify(this.gameId) +
                    "; server fallback enabled"
                );
            }
            this.currentTurnDeathHold = null;
            this.turnCleanupEpoch = -1;
            this.turnCleanupDeadline = 0;
            // The cleanup grace above already gave renderers time to settle.
            this.setNextTurn(50);
            this.sendChangeTurn();
        }
    }

    checkGame(){
        if(!this.isRunning()){
            var len = Object.keys(this.clients).length;
            var humans = Object.values(this.clients).filter(function(client){
                return client && !client.isBot;
            });
            var allHumansReady = humans.length >= 2 && humans.every(function(client){
                return client.player && client.player.status === "ready";
            });
            var eligibleToStart = this.fillPolicy === "human_only" ? allHumansReady : len >= 2;

            // Admission normally prevents this state. Keep the start timer
            // defensive as well so a malformed/restored room can never index
            // beyond its map's authored spawn positions.
            if(len > this.playerCount){
                if(this.status !== "start_error"){
                    this.rejectGameStart({
                        code: "map_capacity_exceeded",
                        playerCount: len
                    });
                }
                return;
            }

            // Only an idle room may create a countdown.  After the first
            // countdown expires the room remains "starting" briefly while the
            // SWF confirms map loading; treating every non-running state as a
            // new lobby created the observed second 5 -> 4 countdown.
            if(eligibleToStart && this.status === "idle" && !this.startingTimeout && !this.awaitingMapLoad){
                //everybody is ready, there are at least 2 players and the game hasn't been set to 'starting'
                if(DEBUG) console.log(">> Starting game in 5 seconds");
                this.updateGameStatus("starting");
                this.countdownExtensions = 0;
                this.armStartCountdown(5000);
                this.refresh();
            }else if(!eligibleToStart){
                //it might be starting, but if there are not enough players (some might exit) or if
                // some new players hop in and they're not "ready", the game should stop.

                if(this.status == "idle") return; //it's already been idled
                if(this.status == "start_error") return; // terminal; reset is scheduled
                if(DEBUG) console.log(">> New game status: Idle");
                this.updateGameStatus("idle");
                //handle timeout
                if(this.startingTimeout){
                	clearTimeout(this.startingTimeout);
                	this.startingTimeout = null;
                }
                this.startingTime = 0;
                //refresh
                this.refresh();
            }
        }else{
            var activeClient = this.clients[this.currentPlayer];
            if(activeClient && this.isRendererStale(activeClient) && this.turnEndTick > this.tick + 10){
                this.turnEndTick = this.tick;
            }
            this.checkIfTurnIsOver();
            //if only one player remains in game
            //send game over
            if(Object.keys(this.clients).length <= 1){
                this.endGame("not-enough-players");
                return;
            }

            if(this.isEliminationMode()){
                var aliveIds = this.getAlivePlayerIds();
                if((!this.teamMode && aliveIds.length <= 1) ||
                    (this.teamMode && this.getAliveTeamIds(aliveIds).length <= 1)){
                    this.endGame(this.teamMode ? "last-team-standing" : "last-one-standing");
                    return;
                }
            }

            if(this.matchEndTick > 0 && this.tick >= this.matchEndTick){
                this.endGame("time-limit");
                return;
            }

            //what if the current player exits?
            if(!this.clients[this.currentPlayer]){
                this.sendChangeTurn();
            }
        }
    }

    armStartCountdown(delayMs){
        if(this.startingTimeout) clearTimeout(this.startingTimeout);
        // findSlot stops routing players into a room whose start is imminent.
        this.startingTime = Date.now() + delayMs;
        this.startingTimeout = setTimeout(function(){
            this.startingTimeout = null;
            if(this.status !== "starting" || this.awaitingMapLoad || this.isRunning()) return;
            // A player who already chose this room is still loading its lobby
            // screen; give them a short, bounded grace instead of a bot.
            if(this.hasPendingReservations() && this.countdownExtensions < 4){
                this.countdownExtensions++;
                this.armStartCountdown(2000);
                return;
            }
            if(DEBUG) console.log(">> Time is up. Starting game");
            this.startingTime = 0;
            this.refresh();
            this.beginGameStart();
        }.bind(this), delayMs);
        if(this.startingTimeout.unref) this.startingTimeout.unref();
    }

    onHumanJoinedDuringCountdown(){
        // A late joiner keeps the running countdown (no 5-4-3 restart), but
        // gets at least two seconds to receive the roster before the start.
        if(this.status !== "starting" || !this.startingTimeout || this.awaitingMapLoad) return;
        if(Number(this.startingTime || 0) - Date.now() < 2000) this.armStartCountdown(2000);
    }

    beginGameStart(){
        if(this.isRunning() || this.awaitingMapLoad || this.status === "start_error") return;
        if(this.fillPolicy === "auto" && !this.botFillCompleted && this.getHumanPlayerCount() > 0 &&
            this.getPlayerCount() < this.playerCount){
            // Fill the open seats now, before the roster is committed by the
            // map handshake, instead of racing a separate bot-fill timer.
            this.seatReservations = Object.create(null);
            this.fillWithBots(true);
        }
        var rendererIds = this.getHumanRendererIds();
        if(!rendererIds.length){
            return this.failMapLoad("no_human_renderer");
        }
        // game_join_confirmed makes every connected human SWF mark the map as
        // joined and emit its map_loaded acknowledgement. Starting before all
        // renderers confirm leaves a valid server match with a broken client.
        this.awaitingMapLoad = true;
        this.mapLoadId = this.gameId + ":" + (++this.mapLoadSequence);
        this.mapLoadExpectedRenderers = Object.create(null);
        for(var i = 0; i < rendererIds.length; i++){
            this.mapLoadExpectedRenderers[String(rendererIds[i])] = false;
            this.clients[rendererIds[i]].mapLoaded = false;
        }
        this.sendConfirmation();
        this.startHandshakeTimeout = setTimeout(function(){
            this.startHandshakeTimeout = null;
            this.handleMapLoadTimeout();
        }.bind(this), 20000);
        this.startHandshakeTimeout.unref();
    }

    onMapLoaded(client, loadId){
        if(!client || client.isBot || !this.awaitingMapLoad || this.isRunning()) return false;
        if(String(loadId || "") !== String(this.mapLoadId || "")){
            console.warn("map_load_rejected code=stale_or_missing_load_id game=" + JSON.stringify(this.gameId));
            return false;
        }
        var rendererId = String(client.player.id);
        if(!Object.prototype.hasOwnProperty.call(this.mapLoadExpectedRenderers, rendererId)) return false;
        client.mapLoaded = true;
        this.mapLoadExpectedRenderers[rendererId] = true;
        var allLoaded = Object.keys(this.mapLoadExpectedRenderers).every(function(id){
            return this.mapLoadExpectedRenderers[id] === true;
        }.bind(this));
        if(allLoaded) this.startGameAfterMapLoad();
        return true;
    }

    startGameAfterMapLoad(){
        if(this.isRunning() || !this.awaitingMapLoad) return;
        if(!Object.keys(this.mapLoadExpectedRenderers).length || !Object.keys(this.mapLoadExpectedRenderers).every(function(id){
            return this.mapLoadExpectedRenderers[id] === true;
        }.bind(this))){
            return;
        }
        if(this.startHandshakeTimeout) clearTimeout(this.startHandshakeTimeout);
        this.startHandshakeTimeout = null;
        this.awaitingMapLoad = false;
        this.startGame();
    }

    handleMapLoadTimeout(){
        if(!this.awaitingMapLoad || this.isRunning()) return false;
        var lateIds = Object.keys(this.mapLoadExpectedRenderers).filter(function(id){
            return this.mapLoadExpectedRenderers[id] !== true;
        }.bind(this));
        var loadedHumans = Object.keys(this.mapLoadExpectedRenderers).length - lateIds.length;
        var remaining = this.getPlayerCount() - lateIds.length;
        var enoughHumans = this.fillPolicy === "human_only" ? loadedHumans >= 2 : loadedHumans >= 1;
        if(!enoughHumans || (this.fillPolicy === "human_only" && remaining < 2)){
            return this.failMapLoad("map_timeout");
        }
        // One slow renderer no longer fails the whole room: it is removed and
        // the players who did load start (auto rooms backfill the seat).
        for(var i = 0; i < lateIds.length; i++){
            var late = this.clients[lateIds[i]];
            delete this.mapLoadExpectedRenderers[lateIds[i]];
            if(!late) continue;
            console.warn("map_load_timeout_removed game=" + JSON.stringify(this.gameId) + " renderer=" + lateIds[i]);
            if(typeof late.sendPacket === "function"){
                late.sendPacket({ command: "game_start_failed", code: "map_timeout", map: this.mapName, loadId: this.mapLoadId });
            }
            delete this.clients[lateIds[i]];
            if(late.avatar){
                var avatarIndex = this.physicsObjects.indexOf(late.avatar);
                if(avatarIndex >= 0) this.physicsObjects.splice(avatarIndex, 1);
            }
        }
        if(this.fillPolicy === "auto" && this.getPlayerCount() < 2){
            this.botFillCompleted = false;
            this.fillWithBots(true);
        }
        this.startGameAfterMapLoad();
        return true;
    }

    failMapLoad(code){
        if(this.startHandshakeTimeout) clearTimeout(this.startHandshakeTimeout);
        this.startHandshakeTimeout = null;
        this.awaitingMapLoad = false;
        this.mapLoadExpectedRenderers = Object.create(null);
        // A failed generation is terminal for this room. Returning to idle
        // schedules another five-second countdown and traps the lobby in an
        // endless WAITING/5-4-3 cycle.
        this.updateGameStatus("start_error");
        console.error("game_start_failed code=" + code + " game=" + JSON.stringify(this.gameId) + " map=" + JSON.stringify(this.mapName));
        this.sendPacket({ command: "game_start_failed", code: code, map: this.mapName, loadId: this.mapLoadId });
        this.refresh();
        this.scheduleStartErrorReset();
        return false;
    }

    scheduleStartErrorReset(){
        // The failed generation stays terminal long enough for every client to
        // read game_start_failed, then the room is recycled so matchmaking can
        // reuse it instead of routing new players into a dead room.
        if(this.startErrorResetTimer) clearTimeout(this.startErrorResetTimer);
        this.startErrorResetTimer = setTimeout(function(){
            this.startErrorResetTimer = null;
            if(this.status !== "start_error") return;
            for(var id in this.clients){
                var client = this.clients[id];
                if(client && !client.isBot && this.WOPW && this.WOPW.slots && client.gameId === this.gameId){
                    client.gameId = null;
                }
            }
            this.initialize();
        }.bind(this), 3000);
        if(this.startErrorResetTimer.unref) this.startErrorResetTimer.unref();
    }

    stopGameStart(){
        // The legacy room controller emits a delayed not_ready while it is
        // being removed for the Battlefield transition.  At that point a bot
        // room is already starting/running, so accepting it would reset the
        // room and begin the five-second countdown all over again.
        if(this.isRunning() || this.awaitingMapLoad || this.status === "start_error") return;
        if(DEBUG) console.log("stopping game!");
        clearTimeout(this.startingTimeout);
        this.startingTimeout = null;
        this.startingTime = 0;
        this.updateGameStatus("idle");
        this.refresh();
    }

    generateRndSeed(){
        this.randomSeed = Utils.randInt();
    }

    setNextTurn(delay){
        this.turnEndTick = this.tick + (this.turnDuration / 10) + delay;
        this.turnHardEndTick = this.turnEndTick;
        this.turnCleanupEpoch = -1;
        this.turnCleanupDeadline = 0;
    }

    setNextTurnFN(delay){
        var newTurnEndTick = this.tick + delay;
        this.turnEndTick = (newTurnEndTick > this.turnEndTick) ? this.turnEndTick : newTurnEndTick;
    }

    holdCurrentTurnThroughRespawn(client){
        if(!client || parseInt(this.currentPlayer) !== parseInt(client.player.id)) return false;
        if(client.avatar && client.avatar.alreadyShot){
            // The turn's action is already spent: dying to your own shot ends
            // the turn on the shot's own deadline instead of idling the room.
            return false;
        }
        this.currentTurnDeathHold = {
            playerId: Number(client.player.id),
            turnEpoch: Number(this.turnEpoch),
            deathGeneration: Number(client.respawnGeneration || 0),
            firedAfterRespawn: false
        };
        // The owner gets the respawn delay plus a short window to act after
        // returning (never the whole remaining turn, which left everybody
        // else idle for up to 30 s). The hard deadline still bounds it.
        var respawnWindowTicks = Math.ceil((3000 + 1500) / 10) + 800;
        var hardEnd = Number(this.turnHardEndTick || 0);
        if(hardEnd > 0){
            this.turnEndTick = Math.min(hardEnd, this.tick + respawnWindowTicks);
        }
        this.botPendingProjectile = null;
        return true;
    }

    shouldHoldTurnCompletion(client, data){
        var hold = this.currentTurnDeathHold;
        if(!hold || !client || parseInt(this.currentPlayer) !== hold.playerId ||
            parseInt(client.player.id) !== hold.playerId ||
            Number(this.turnEpoch) !== hold.turnEpoch){
            return false;
        }
        // v26 supplies both identifiers. A completion created by the dead
        // avatar remains invalid even if TCP delivers it after respawn.
        if(data && data.turnEpoch != null && Number(data.turnEpoch) !== hold.turnEpoch) return true;
        if(data && data.generation != null &&
            Number(data.generation) !== Number(client.respawnGeneration || 0)) return true;
        return !hold.firedAfterRespawn;
    }

    markCurrentTurnRespawnShot(client){
        var hold = this.currentTurnDeathHold;
        if(!hold || !client || parseInt(client.player.id) !== hold.playerId ||
            parseInt(this.currentPlayer) !== hold.playerId ||
            Number(this.turnEpoch) !== hold.turnEpoch ||
            client.isDead() ||
            Number(client.respawnGeneration || 0) <= hold.deathGeneration){
            return false;
        }
        hold.firedAfterRespawn = true;
        return true;
    }

    updatePlayerStatus(id, status) {
        for(var key in this.clients)
            if(this.clients[key].player.id == id){
                this.clients[key].player.status = status;
                break;
            }
        this.refresh();
    }

    updateGameStatus(status){
        this.status = status;
    }

    setPlayerDead(id, killerId, generation){
        if(this.clients[id]){
            var victim = this.clients[id];
            // Every respawn creates a new life. Packets from an earlier life
            // are expected on a lossy/late Flash socket and must never erase
            // the player who has already returned to the field.
            var expectedGeneration = Number(victim.respawnGeneration || 0);
            var hasGeneration = generation !== undefined && generation !== null && generation !== "";
            if(hasGeneration && Number(generation) !== expectedGeneration) return false;
            if(victim.isDead()) return false;
            var deathHealth = this.initializeHealth(victim, false);
            if(deathHealth && Number(deathHealth.hp) !== 0){
                deathHealth.hp = 0;
                deathHealth.revision = Number(deathHealth.revision || 0) + 1;
                this.healthRevision++;
            }
            victim.avatar.hp = 0;
            victim.avatar.dead = true;
            victim.avatar.lifeGeneration = expectedGeneration;
            victim.respawnReady = false;
            victim.respawnGraceUntil = 0;
            this.clients[id].lastDeathPosition = {
                x: this.clients[id].avatar.X,
                y: this.clients[id].avatar.Y
            };
            if(this.deadPlayers.indexOf(id) < 0) this.deadPlayers.push(id);
            this.deathCounts[id] = (this.deathCounts[id] || 0) + 1;
            this.recordProgression(victim, "deaths", 1);
            killerId = parseInt(killerId);
            if(Number.isFinite(killerId) && killerId !== parseInt(id) && this.clients[killerId]){
                this.scores[killerId] = (this.scores[killerId] || 0) + 1;
                this.recordProgression(this.clients[killerId], "kills", 1);
                var killerState = this.getMatchMedalState(this.clients[killerId]);
                if(killerState){
                    if(killerState.killEpoch !== this.turnEpoch){
                        killerState.killEpoch = this.turnEpoch;
                        killerState.turnKills = 0;
                    }
                    killerState.turnKills++;
                    if(killerState.turnKills >= 2) this.awardProgressionMedal(this.clients[killerId], "two_bird_one_stone");
                }
                if(!this.clients[killerId].isBot){
                    this.clients[killerId].player.xp += 15;
                    this.clients[killerId].addGold(5, true);
                }
            }
            console.log(">> Player dead: " + id + "; alive=" + this.getAlivePlayerIds().join(","));
            this.scheduleDeathBurstCleanup(id);
            if(this.botController && this.botController.state && this.botController.state.bot === this.clients[id]){
                this.botController.reset();
            }
            if(!this.isEliminationMode()) this.scheduleRespawn(id);
            if(parseInt(this.currentPlayer) === parseInt(id)){
                if(this.isEliminationMode()){
                    // One-life modes cannot restore the current participant.
                    this.turnEndTick = Math.min(this.turnEndTick || (this.tick + 10), this.tick + 10);
                }else{
                    this.holdCurrentTurnThroughRespawn(victim);
                }
            }
            return true;
        }else{
            //its been removed from the clients array
            return false;
        }
    }

    scheduleDeathBurstCleanup(id){
        var epoch = Number(this.turnEpoch);
        if(Number(this.deathBurstEpoch) !== epoch){
            if(this.deathBurstTimer) clearTimeout(this.deathBurstTimer);
            this.deathBurstEpoch = epoch;
            this.deathBurstIds = [];
            this.deathBurstTimer = null;
        }
        if(this.deathBurstIds.indexOf(String(id)) < 0) this.deathBurstIds.push(String(id));
        if(this.deathBurstTimer) clearTimeout(this.deathBurstTimer);
        this.deathBurstTimer = setTimeout(function(){
            this.deathBurstTimer = null;
            if(!this.isRunning() || Number(this.turnEpoch) !== epoch) return;
            var burst = this.deathBurstIds.slice();
            this.deathBurstIds = [];
            if(burst.length < 2) return;
            // forceEffectCleanup flushes pending terrain events before removing
            // orphaned projectiles. The short server barrier gives that batch
            // time to update the authoritative collision mask before respawn.
            this.respawnTerrainBarrierUntil = Math.max(
                Number(this.respawnTerrainBarrierUntil || 0),
                Date.now() + 750
            );
            this.sendPacket({
                command: "force_effect_cleanup",
                turnEpoch: epoch,
                reason: "mass_death",
                deaths: burst.length
            });
            console.warn(
                "mass_death_cleanup game=" + JSON.stringify(this.gameId) +
                " epoch=" + epoch +
                " deaths=" + burst.join(",")
            );
        }.bind(this), 500);
        this.deathBurstTimer.unref();
    }

    calculateMaxHp(client){
        var avatar = client && client.avatar;
        var pet = client && client.player && client.player.ownedPets && client.player.ownedPets[client.player.currentPet];
        var base = Number(avatar && avatar.properties && avatar.properties.hp);
        if(!Number.isFinite(base) || base <= 0) base = 100;
        // Match the client-side model: only one equipped item from a category
        // contributes, depleted equipment contributes nothing, and vitality is
        // the active pet's `vi` stat. Existing catalogs currently have no HP
        // accessories, but keeping the complete calculation avoids a future
        // client/server max-health split.
        var accessories = !this.balancedGame && pet && Array.isArray(pet.accessories) ? pet.accessories : [];
        var equipped = accessories.filter(function(type){
            return !(client.player.durability && client.player.durability[type] != null &&
                Number(client.player.durability[type]) <= 0);
        });
        var bonuses = calculateAccessoryBonuses(equipped, this.WOPW.accessoriesObj, {
            balanced: this.balancedGame,
            manifest: this.WOPW.accessoryAssetManifest
        });
        client.accessoryBonuses = bonuses;
        var healthBonus = Number(bonuses.health_points || 0);
        var vitality = this.balancedGame ? 0 : (Number(pet && pet.vi || 0) || 0);
        var maxHp = Math.max(1, Math.round(base + healthBonus + (vitality * 15)));
        // Avatar.as doubles health for the one-life modes. Keep the server
        // health clamp on the identical value or every elimination hit looks
        // like an unauthorized heal/truncated health update.
        return this.isEliminationMode() ? maxHp * 2 : maxHp;
    }

    initializeHealth(client, reset){
        if(!client || !client.avatar) return null;
        var maxHp = this.calculateMaxHp(client);
        var existing = client.healthState || {};
        if(reset || !Number.isFinite(existing.hp)){
            existing.hp = maxHp;
            client.avatar.hp = maxHp;
            // A new life has its own client sequence space. Retaining the
            // previous generation's sequence rejects every report from a
            // reconstructed Flash avatar whose counter starts at zero.
            existing.lastSeqByReporter = Object.create(null);
        }
        existing.maxHp = maxHp;
        existing.generation = Number(client.respawnGeneration || 0);
        existing.lastSeqByReporter = existing.lastSeqByReporter || Object.create(null);
        existing.revision = Number(existing.revision || 0);
        client.healthState = existing;
        return existing;
    }

    getBotRendererId(){
        var now = Date.now();
        var candidates = this.getHumanRendererIds().filter(function(id){
            // A silent renderer cannot report bot health or completion; hand
            // the role to a live one instead of freezing every bot hit.
            return Number(this.clients[id].botAiProtocol || 0) >= 2 && !this.isRendererStale(this.clients[id], now);
        }.bind(this)).sort(function(a,b){
            var protocolDifference = Number(this.clients[b].botAiProtocol || 0) - Number(this.clients[a].botAiProtocol || 0);
            return protocolDifference || Number(a) - Number(b);
        }.bind(this));
        var selected = candidates.length ? String(candidates[0]) : null;
        if(selected !== this.nativeBotRendererId){
            this.nativeBotRendererId = selected;
            this.botControllerEpoch++;
            this.nativeBotRosterReady = false;
            this.nativeBotRosterRendererId = null;
            this.nativeBotRosterEpoch = 0;
            this.nativeBotAI = false;
        }
        return this.nativeBotRendererId;
    }

    getBotHealthReporterId(){
        var rendererId = this.getBotRendererId();
        var renderer = rendererId == null ? null : this.clients[rendererId];
        return renderer && Number(renderer.botAiProtocol || 0) >= 4 ? String(rendererId) : null;
    }

    acknowledgeBotRoster(renderer, data){
        if(!this.isRunning() || !renderer || renderer.isBot || !data || !Array.isArray(data.botIds)) return false;
        var selectedRendererId = this.getBotRendererId();
        if(String(renderer.player.id) !== String(selectedRendererId)) return false;
        if(Number(data.controllerEpoch) !== Number(this.botControllerEpoch)) return false;
        var expected = Object.keys(this.clients).filter(function(id){ return this.clients[id] && this.clients[id].isBot; }.bind(this)).map(String).sort();
        var reported = data.botIds.map(String).sort();
        if(expected.length !== reported.length || expected.some(function(id, index){ return id !== reported[index]; })){
            console.warn("bot_roster_rejected game=" + JSON.stringify(this.gameId) + " renderer=" + renderer.player.id);
            return false;
        }
        this.nativeBotRosterReady = true;
        this.nativeBotRosterRendererId = String(renderer.player.id);
        this.nativeBotRosterEpoch = this.botControllerEpoch;
        // The movie can construct and acknowledge every bot avatar, but its
        // embedded AI still stalls on parts of the full weapon catalogue.
        // Keep that renderer acknowledgement for avatar synchronization while
        // the verified server controller remains the sole turn authority.
        this.nativeBotAI = false;
        this.nativeBotTimeouts = 0;
        this.botController.reset();
        console.log(">> Native SWF bot roster verified for game " + this.gameId + "; server controller active; bots=" + reported.join(","));
        return true;
    }

    getHealthReporterId(target){
        if(!target || !target.isBot) return String(target && target.player && target.player.id);
        // Protocol 4 renders every bot in one selected movie and reports its
        // exact post-hit HP. Keeping that reporter stable across human and bot
        // turns also covers bot-vs-bot deaths, for which no bot socket exists.
        var botHealthReporter = this.getBotHealthReporterId();
        if(botHealthReporter != null) return botHealthReporter;
        var current = this.clients[this.currentPlayer];
        if(current && !current.isBot) return String(current.player.id);
        return this.getBotRendererId();
    }

    assignBotWeapon(bot){
        if(!bot || !bot.isBot) return null;
        return this.botController.reserveWeapon(bot);
    }

    authorizeHeal(sourceId, amount){
        var value = Math.max(0, Number(amount) || 0);
        if(!value) return false;
        var now = Date.now();
        this.healAuthorizations = this.healAuthorizations.filter(function(entry){
            return entry.expiresAt > now && entry.remaining > 0;
        });
        this.healAuthorizations.push({
            sourceId: String(sourceId),
            remaining: value,
            expiresAt: now + 120000
        });
        return true;
    }

    consumeHealAuthorization(amount){
        var requested = Math.max(0, Number(amount) || 0);
        if(!requested) return true;
        var now = Date.now();
        this.healAuthorizations = this.healAuthorizations.filter(function(entry){
            return entry.expiresAt > now && entry.remaining > 0;
        });
        for(var i = 0; i < this.healAuthorizations.length; i++){
            if(this.healAuthorizations[i].remaining < requested) continue;
            this.healAuthorizations[i].remaining -= requested;
            return true;
        }
        return false;
    }

    applyHealthState(reporter, targetId, hpAfter, generation, seq, reason, sourceId, options){
        var target = this.clients[targetId];
        if(!target || !target.avatar || target.isDead()) return { accepted: false, reason: "missing_or_dead" };
        var state = this.initializeHealth(target, false);
        var reporterId = String(reporter && reporter.player && reporter.player.id);
        var expectedReporter = this.getHealthReporterId(target);
        if(!options || options.enforceReporter !== false){
            if(!reporterId || reporterId !== expectedReporter) return { accepted: false, reason: "unauthorized_reporter" };
        }
        if(generation !== undefined && generation !== null && Number(generation) !== Number(target.respawnGeneration || 0)) return { accepted: false, reason: "stale_generation" };
        if(!Number.isFinite(Number(hpAfter))) return { accepted: false, reason: "invalid_hp" };
        var key = reporterId || "server";
        var lastSeq = Number(state.lastSeqByReporter[key] || 0);
        if(seq !== undefined && seq !== null && seq !== ""){
            if(!Number.isFinite(Number(seq)) || Number(seq) <= lastSeq) return { accepted: false, reason: "stale_sequence" };
            state.lastSeqByReporter[key] = Number(seq);
        }
        var oldHp = Number(state.hp);
        var nextHp = Math.max(0, Math.min(state.maxHp, Number(hpAfter)));
        if(nextHp > oldHp){
            var isServerRespawn = reason === "respawn" && (!reporter || reporterId === "server");
            var isAuthorizedHeal = reason === "heal" && this.consumeHealAuthorization(nextHp - oldHp);
            if(!isServerRespawn && !isAuthorizedHeal) return { accepted: false, reason: "unapproved_heal" };
        }
        state.hp = nextHp;
        var damageApplied = Math.max(0, oldHp - nextHp);
        if(damageApplied > 0){
            this.recordProgression(target, "damageTaken", damageApplied);
            var source = this.clients[sourceId];
            this.recordProgression(source, "damageDealt", damageApplied);
            this.recordMatchDamage(target, source, damageApplied);
            if(source && source.player){
                var scoreKey = String(source.player.id);
                this.combatScores[scoreKey] = Number(this.combatScores[scoreKey] || 0) + damageApplied;
            }
        }
        state.revision++;
        target.avatar.hp = nextHp;
        this.healthRevision++;
        var packet = {
            command: "set_health", id: target.player.id, hp: nextHp, maxHp: state.maxHp,
            generation: Number(target.respawnGeneration || 0), revision: state.revision, reason: reason || "damage"
        };
        // The reporter has already rendered this exact damage. Echoing the
        // authoritative value back into that same movie races the next bot
        // snapshot and produces equal +HP/-HP text. Other renderers still need
        // the accepted value.
        if(reporter && !reporter.isBot) this.sendPacketE(packet, reporter);
        else this.sendPacket(packet);
        // set_health already carries the change; the convergence snapshot is
        // coalesced so a multi-hit weapon sends one, not one per hit.
        this.scheduleWorldState();
        if(nextHp === 0) this.setPlayerDead(target.player.id, sourceId, generation);
        return { accepted: true, hp: nextHp, maxHp: state.maxHp, revision: state.revision };
    }

    killWorldFall(target, sourceId){
        if(!target || !target.avatar || target.isDead()) return false;
        target.lastDeathPosition = {
            x: Number(target.avatar.X),
            y: Number(target.avatar.Y)
        };
        var result = this.applyHealthState(
            null,
            target.player.id,
            0,
            Number(target.respawnGeneration || 0),
            undefined,
            "world_fall",
            sourceId,
            { enforceReporter: false }
        );
        if(result.accepted){
            console.log(">> World fall confirmed: " + target.player.id + " y=" + target.avatar.Y);
        }
        return Boolean(result.accepted);
    }

    scheduleRespawn(id){
        if(this.isEliminationMode()) return false;
        if(this.respawnTimers[id]) clearTimeout(this.respawnTimers[id]);
        // Keep the death packet on screen long enough for Flash/Ruffle to
        // finish its animation before the authoritative respawn packet is
        // applied.  A one-and-a-half second transition was short enough to
        // race the client display list, which made avatars briefly appear and
        // immediately disappear in PvP matches.
        this.respawnDeadlines[id] = Date.now() + 3000;
        this.respawnTimers[id] = setTimeout(function(){
            delete this.respawnTimers[id];
            this.processRespawns();
        }.bind(this), 3000);
        this.respawnTimers[id].unref();
        return true;
    }

    processRespawns(){
        if(!this.isRunning() || this.isEliminationMode()) return;
        var now = Date.now();
        if(now < Number(this.nextRespawnDispatchAt || 0)) return;
        if(now < Number(this.respawnTerrainBarrierUntil || 0)) return;
        if(now - Number(this.lastTerrainMutationAt || 0) < 350) return;
        this.respawnReservations = (this.respawnReservations || []).filter(function(reservation){
            return Number(reservation.expiresAt || 0) > now;
        });
        var clientIds = Object.keys(this.clients).sort(function(a, b){
            var deadlineDifference = Number(this.respawnDeadlines[a] || Infinity) - Number(this.respawnDeadlines[b] || Infinity);
            return deadlineDifference || Number(a) - Number(b);
        }.bind(this));
        for(var clientIndex = 0; clientIndex < clientIds.length; clientIndex++){
            var key = clientIds[clientIndex];
            var client = this.clients[key];
            if(!client || !client.avatar || !client.isDead()) continue;

            // The update loop is the authoritative fallback for timers.  Even
            // if a timeout was lost or cleared, every dead participant is
            // guaranteed to receive another respawn deadline.
            if(!this.respawnDeadlines[key]){
                this.scheduleRespawn(key);
                continue;
            }
            if(now < this.respawnDeadlines[key]) continue;

            if(this.respawnPlayer(key)){
                delete this.respawnDeadlines[key];
                if(this.respawnTimers[key]) clearTimeout(this.respawnTimers[key]);
                delete this.respawnTimers[key];
                // Ruffle mutates several display-list and physics structures
                // while applying a respawn. Sending three restorations in one
                // TCP frame can abort the command batch before any ACK is
                // flushed. One life transition per room update is deterministic
                // and gives each avatar an atomic render frame.
                this.nextRespawnDispatchAt = now + 150;
                return;
            }else{
                this.respawnDeadlines[key] = now + 250;
            }
        }
    }

    processRespawnAcks(){
        var now = Date.now();
        for(var key in this.respawnAckStates){
            var state = this.respawnAckStates[key];
            var client = this.clients[key];
            if(!state || !client || client.isDead()){
                delete this.respawnAckStates[key];
                continue;
            }
            var checkedRevision = Number(state.checkedTerrainRevision != null ? state.checkedTerrainRevision : state.packet.terrainRevision);
            if(checkedRevision !== Number(this.terrainRevision) && !this.respawnTerrainTouched(state)){
                // Craters elsewhere on the map do not invalidate this spawn;
                // relocating on every terrain batch made respawns loop while
                // a Drill or several renderers kept reporting craters.
                state.checkedTerrainRevision = Number(this.terrainRevision);
                state.terrainRecordCount = this.field && Array.isArray(this.field.explosionRecord) ? this.field.explosionRecord.length : 0;
                checkedRevision = state.checkedTerrainRevision;
            }
            if(checkedRevision !== Number(this.terrainRevision)){
                console.warn(">> Respawn terrain changed before ACK; relocating avatar: " + key);
                client.avatar.dead = true;
                client.avatar.complete = true;
                client.avatar.hp = 0;
                client.respawnReady = false;
                client.respawnGraceUntil = 0;
                delete this.respawnAckStates[key];
                this.respawnReservations = (this.respawnReservations || []).filter(function(reservation){
                    return String(reservation.id) !== String(key);
                });
                this.respawnDeadlines[key] = now + 250;
                continue;
            }

            var expectedRenderers = state.expectedRendererIds.filter(function(rendererId){
                return this.clients[rendererId] && !this.clients[rendererId].isBot;
            }.bind(this));
            var allAcknowledged = expectedRenderers.every(function(rendererId){
                return state.acknowledgedRendererIds[rendererId] === true;
            });
            if(allAcknowledged){
                client.respawnReady = true;
                delete this.respawnAckStates[key];
                if(DEBUG) console.log(">> Respawn acknowledged by all renderers: " + key + " generation=" + state.packet.generation);
                continue;
            }

            if(now >= Number(state.watchdogAt || Infinity)){
                console.warn(">> Respawn watchdog relocating unacknowledged avatar: " + key);
                client.avatar.dead = true;
                client.avatar.complete = true;
                client.avatar.hp = 0;
                client.respawnReady = false;
                client.respawnGraceUntil = 0;
                delete this.respawnAckStates[key];
                this.respawnReservations = (this.respawnReservations || []).filter(function(reservation){
                    return String(reservation.id) !== String(key);
                });
                this.respawnDeadlines[key] = now + 250;
                continue;
            }

            if(state.nextRetryAt && now >= state.nextRetryAt){
                this.sendPacket(state.packet);
                state.retryCount = Number(state.retryCount || 0) + 1;
                state.nextRetryAt = now + Math.min(2000, 250 * Math.pow(2, Math.min(3, state.retryCount)));
            }
            if(!state.warningLogged && now >= state.warningAt){
                state.warningLogged = true;
                console.warn(">> Respawn ACK delayed; authoritative packet will keep retrying: " + key);
            }
        }
    }

    respawnTerrainTouched(state){
        if(!state || !state.packet || !this.field || !Array.isArray(this.field.explosionRecord)) return true;
        var records = this.field.explosionRecord;
        var from = Number(state.terrainRecordCount || 0);
        if(from > records.length) return true;
        var x = Number(state.packet.x), y = Number(state.packet.y);
        for(var i = from; i < records.length; i++){
            var cx = Utils.stringToInt(records[i][0]);
            var cy = Utils.stringToInt(records[i][1]);
            var cr = Utils.stringToInt(records[i][2]);
            if(!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cr)) return true;
            // Pet radius (40) plus support depth below the feet.
            if(Math.hypot(x - cx, y - cy) < cr + 90) return true;
        }
        return false;
    }

    acknowledgeRespawn(rendererId, id, generation, respawnToken, observedX, observedY, grounded, terrainRevision){
        // Keep accepting the old two-argument shape while v21 rolls out:
        // acknowledgeRespawn(respawnedId, generation).
        if(arguments.length === 2){
            generation = id;
            id = rendererId;
        }
        var state = this.respawnAckStates[id];
        var client = this.clients[id];
        if(!state || !client) return false;
        var hasGeneration = generation !== undefined && generation !== null && generation !== "";
        if(hasGeneration && Number(state.packet.generation) !== Number(generation)) return false;
        if(String(respawnToken || "") !== String(state.packet.respawnToken || "")) return false;
        if(grounded !== true && String(grounded).toLowerCase() !== "true") return false;
        var checkedRevision = Number(state.checkedTerrainRevision != null ? state.checkedTerrainRevision : state.packet.terrainRevision);
        if(Number(terrainRevision) !== Number(state.packet.terrainRevision) && Number(terrainRevision) !== Number(this.terrainRevision)) return false;
        if(checkedRevision !== Number(this.terrainRevision)){
            if(this.respawnTerrainTouched(state)) return false;
            state.checkedTerrainRevision = Number(this.terrainRevision);
            state.terrainRecordCount = this.field && Array.isArray(this.field.explosionRecord) ? this.field.explosionRecord.length : 0;
        }
        if(!Number.isFinite(Number(observedX)) || !Number.isFinite(Number(observedY))) return false;
        if(Math.hypot(Number(observedX) - Number(state.packet.x), Number(observedY) - Number(state.packet.y)) > 120) return false;
        var surface = this.resolveRespawnSurface(Number(observedX), Number(observedY) + 45);
        if(!surface || !surface.verified ||
            Math.abs(Number(surface.y) - Number(observedY)) > 32) return false;
        rendererId = String(rendererId);
        if(state.expectedRendererIds.indexOf(rendererId) < 0) return false;
        state.acknowledgedRendererIds[rendererId] = true;

        var connectedRenderers = state.expectedRendererIds.filter(function(expectedRendererId){
            return this.clients[expectedRendererId] && !this.clients[expectedRendererId].isBot;
        }.bind(this));
        var allAcknowledged = connectedRenderers.every(function(expectedRendererId){
            return state.acknowledgedRendererIds[expectedRendererId] === true;
        });
        if(allAcknowledged){
            client.respawnReady = true;
            delete this.respawnAckStates[id];
        }
        if(DEBUG) console.log(">> Respawn acknowledged: target=" + id + " renderer=" + rendererId + " generation=" + generation);
        return true;
    }

    resolveRespawnSurface(x, preferredY){
        var field = this.field;
        x = Math.round(Number(x));
        preferredY = Math.round(Number(preferredY));
        if(!field || !field.bitmapData || typeof field.checkFieldCollisionPoint !== "function"){
            return {
                x: x,
                y: preferredY - 45,
                groundY: preferredY,
                verified: false
            };
        }

        var width = Number(field.width || 2800);
        var height = Number(field.height || 1400);
        if(!Number.isFinite(x) || !Number.isFinite(preferredY) || x < 30 || x > width - 30) return null;
        var scanStart = Math.max(30, Math.min(height - 70, preferredY - 90));

        function firstSolidY(sampleX, startY, endY){
            for(var sampleY = startY; sampleY <= endY; sampleY += 2){
                if(field.checkFieldCollisionPoint(sampleX, sampleY)) return sampleY;
            }
            return null;
        }

        var centerY = firstSolidY(x, scanStart, height - 8);
        if(centerY === null) return null;
        var supportYs = [-20, 0, 20].map(function(offset){
            return firstSolidY(x + offset, Math.max(scanStart, centerY - 28), Math.min(height - 8, centerY + 42));
        }).filter(function(value){
            return value !== null && Math.abs(value - centerY) <= 42;
        });
        if(supportYs.length < 2) return null;
        supportYs.sort(function(a, b){ return a - b; });
        var groundY = supportYs[Math.floor(supportYs.length / 2)];

        // A valid floor is not enough if the pet would be reconstructed inside
        // an overhang or a surviving sliver of crater wall. Require a clear
        // avatar-height capsule above the selected surface.
        // The capsule spans the whole pet (about 80 px), not only its middle.
        for(var clearanceY = groundY - 80; clearanceY <= groundY - 12; clearanceY += 6){
            if(field.checkFieldCollisionPoint(x - 12, clearanceY) ||
                field.checkFieldCollisionPoint(x, clearanceY) ||
                field.checkFieldCollisionPoint(x + 12, clearanceY)){
                return null;
            }
        }
        return {
            x: x,
            y: Math.max(5, groundY - 45),
            groundY: groundY,
            verified: true
        };
    }

    getRandomRespawnPosition(client){
        var map = this.WOPW.mapsObj[this.mapName] || {};
        var zones = Array.isArray(map.positions) ? map.positions : [];
        if(!zones.length) return null;
        var seedText = [
            String(this.randomSeed || this.gameId || ""),
            String(client && client.player && client.player.id || ""),
            String(Number(client && client.respawnGeneration || 0) + 1),
            String(Number(this.respawnTokenSequence || 0) + 1)
        ].join(":");
        var seed = 2166136261;
        for(var seedIndex = 0; seedIndex < seedText.length; seedIndex++){
            seed ^= seedText.charCodeAt(seedIndex);
            seed = Math.imul(seed, 16777619);
        }
        var respawnRandom = function(){
            seed += 0x6D2B79F5;
            var value = seed;
            value = Math.imul(value ^ (value >>> 15), value | 1);
            value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
            return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
        };

        var death = client.lastDeathPosition || { x: client.avatar.X, y: client.avatar.Y };
        if(!Number.isFinite(Number(death.x)) || !Number.isFinite(Number(death.y))){
            death = { x: Number(zones[0][0]), y: Number(zones[0][1]) };
        }
        var explosions = (this.field.explosionRecord || []).map(function(record){
            return {
                x: Utils.stringToInt(record[0]),
                y: Utils.stringToInt(record[1]),
                r: Math.max(0, Utils.stringToInt(record[2]))
            };
        });
        var history = (Array.isArray(client.respawnHistory) ? client.respawnHistory : []).filter(function(position){
            return position && Number.isFinite(Number(position.x)) && Number.isFinite(Number(position.y));
        }).slice(-4);
        var candidates = [];
        var candidateKeys = Object.create(null);

        var addCandidate = function(surface){
            if(!surface || !surface.verified) return;
            var x = Number(surface.x);
            var y = Number(surface.y);
            var reservedTooClose = (this.respawnReservations || []).some(function(reservation){
                return Math.hypot(x - Number(reservation.x), y - Number(reservation.y)) < 100;
            });
            if(reservedTooClose) return;
            var candidateKey = Math.round(x / 8) + ":" + Math.round(y / 8);
            if(candidateKeys[candidateKey]) return;
            candidateKeys[candidateKey] = true;

            var nearestPlayer = Infinity;
            for(var key in this.clients){
                var other = this.clients[key];
                if(!other || other === client || !other.avatar || other.isDead()) continue;
                nearestPlayer = Math.min(nearestPlayer, Math.hypot(x - other.avatar.X, y - other.avatar.Y));
            }

            var craterPenalty = 0;
            var craterOverlap = false;
            var insideCrater = false;
            explosions.forEach(function(explosion){
                var distance = Math.hypot(x - explosion.x, y - explosion.y);
                if(distance < explosion.r + 10) insideCrater = true;
                if(distance < explosion.r + 90){
                    craterOverlap = true;
                    craterPenalty += (explosion.r + 90 - distance) * 20;
                }
            });

            var deathDistance = Math.hypot(x - death.x, y - death.y);
            var recentDistance = history.length ? Math.min.apply(null, history.map(function(position){
                return Math.hypot(x - Number(position.x), y - Number(position.y));
            })) : Infinity;
            var recentXDistance = history.length ? Math.min.apply(null, history.map(function(position){
                return Math.abs(x - Number(position.x));
            })) : Infinity;
            var repeated = recentDistance < 120 || recentXDistance < 70;
            var historyBonus = history.length ? Math.min(recentDistance, 900) * 1.35 : 0;
            candidates.push({
                x: x,
                y: y,
                score: Math.min(deathDistance, 900) +
                    Math.min(nearestPlayer, 600) +
                    historyBonus -
                    craterPenalty -
                    (repeated ? 2400 : 0) +
                    (respawnRandom() * 40),
                fresh: !repeated,
                // The current terrain mask is the final authority. Explosion
                // overlap is a ranking penalty, not proof that all lower floor
                // in the same column disappeared.
                safe: surface.verified && !craterOverlap,
                usable: surface.verified && !insideCrater
            });
        }.bind(this);

        zones.forEach(function(zone){
            var x1 = Number(zone[0]);
            var y1 = Number(zone[1]);
            var x2 = Number(zone.length > 2 ? zone[2] : zone[0]);
            var y2 = Number(zone.length > 3 ? zone[3] : zone[1]);
            for(var i = 0; i < 8; i++){
                var ratio = respawnRandom();
                var x = Math.round(x1 + ((x2 - x1) * ratio));
                var authoredY = Math.round(y1 + ((y2 - y1) * ratio));
                // The authored point describes the original map. Resolve it
                // against the current server mask so a cratered platform falls
                // through to surviving terrain instead of creating an endless
                // respawn -> world-fall loop.
                var surface = this.resolveRespawnSurface(x, authoredY);
                addCandidate(surface);
            }
        }.bind(this));

        // Search the living raster on every respawn. Restricting this to the
        // total-manifest-failure case made a surviving authored column win
        // repeatedly after every world fall.
        if(this.field && this.field.bitmapData){
            var fieldWidth = Number(this.field.width || 2800);
            for(var fallbackX = 50; fallbackX <= fieldWidth - 50; fallbackX += 40){
                var fallbackSurface = this.resolveRespawnSurface(fallbackX, 70);
                if(!fallbackSurface || !fallbackSurface.verified) continue;
                addCandidate(fallbackSurface);
            }
        }

        candidates.sort(function(a, b){
            if(a.safe !== b.safe) return a.safe ? -1 : 1;
            if(a.fresh !== b.fresh) return a.fresh ? -1 : 1;
            return b.score - a.score;
        });
        var verifiedCandidates = candidates.filter(function(candidate){ return candidate.safe; });
        if(!verifiedCandidates.length){
            // Late in a match every surface can be near some crater. A floor
            // that the mask verifies and that is not inside a recorded crater
            // is still valid; refusing it left players dead indefinitely.
            verifiedCandidates = candidates.filter(function(candidate){ return candidate.usable; });
        }
        if(!verifiedCandidates.length) return null;
        var topCandidates = verifiedCandidates.slice(0, Math.min(5, verifiedCandidates.length));
        return topCandidates[Math.floor(respawnRandom() * topCandidates.length)];
    }

    recordRespawnPosition(client, position){
        if(!client || !position) return;
        if(!Array.isArray(client.respawnHistory)) client.respawnHistory = [];
        client.respawnHistory.push({ x: Number(position.x), y: Number(position.y) });
        if(client.respawnHistory.length > 4){
            client.respawnHistory.splice(0, client.respawnHistory.length - 4);
        }
    }

    respawnPlayer(id){
        if(this.isEliminationMode()) return false;
        var client = this.clients[id];
        if(!this.isRunning() || !client || !client.avatar || !client.isDead()) return false;
        var position = this.getRandomRespawnPosition(client);
        if(!position) return false;
        client.avatar.dead = false;
        client.avatar.complete = false;
        client.respawnGeneration = (client.respawnGeneration || 0) + 1;
        var health = this.initializeHealth(client, true);
        client.avatar.X = position.x;
        client.avatar.Y = position.y;
        client.avatar.Vx = 0;
        client.avatar.Vy = 0;
        client.avatar.locked = false;
        client.avatar.alreadyShot = false;
        client.avatar.lifeGeneration = client.respawnGeneration;
        client.respawnGraceUntil = Date.now() + 4000;
        var respawnToken = [
            String(this.gameId),
            String(client.player.id),
            String(client.respawnGeneration),
            String(++this.respawnTokenSequence)
        ].join(":");
        this.respawnReservations.push({
            id: String(client.player.id),
            x: Number(position.x),
            y: Number(position.y),
            expiresAt: Date.now() + 5000
        });
        this.recordRespawnPosition(client, position);
        var packet = {
            command: "respawn_player",
            id: client.player.id,
            x: client.avatar.X,
            y: client.avatar.Y,
            tick: this.tick,
            generation: client.respawnGeneration,
            terrainRevision: this.terrainRevision,
            respawnToken: respawnToken,
            hp: health.hp,
            maxHp: health.maxHp
        };
        // Every rendered avatar, including a server-controlled bot, must be
        // grounded on every connected movie's current terrain before it can
        // re-enter the turn ring. The clients already report bot grounding;
        // previously those reports were discarded and floating bots were
        // marked ready from the server mask alone.
        var rendererIds = this.getHumanRendererIds();
        if(rendererIds.length){
            client.respawnReady = false;
            this.respawnAckStates[id] = {
                packet: packet,
                expectedRendererIds: rendererIds,
                acknowledgedRendererIds: Object.create(null),
                retryCount: 0,
                nextRetryAt: Date.now() + 250,
                warningAt: Date.now() + 5000,
                watchdogAt: Date.now() + 10000,
                warningLogged: false,
                // Terrain the spawn was validated against; advanced when later
                // craters are verified not to touch the spawn point.
                checkedTerrainRevision: Number(this.terrainRevision || 0),
                terrainRecordCount: this.field && Array.isArray(this.field.explosionRecord) ? this.field.explosionRecord.length : 0
            };
        }else{
            client.respawnReady = true;
        }
        this.sendPacket(packet);
        if(DEBUG) console.log(">> Player respawned: " + id + " at " + client.avatar.X + "," + client.avatar.Y);
        return true;
    }

    setDefaultPositions(clientIds){
        clientIds = clientIds || Object.keys(this.clients);
        if(clientIds.length > this.playerCount || clientIds.length > this.spawnPositions.length) return false;

        // Resolve authored ranges against the actual loaded collision mask.
        // The legacy code used only x1/y1, which placed several Crash Landing
        // participants hundreds of pixels above the floor and put a number of
        // other map starts inside terrain.
        var map = this.WOPW.mapsObj[this.mapName] || {};
        var zones = Array.isArray(map.positions) ? map.positions : [];
        var resolvedPositions = [];
        var isSeparated = function(surface){
            return resolvedPositions.every(function(existing){
                return Math.hypot(Number(existing.x) - Number(surface.x), Number(existing.y) - Number(surface.y)) >= 100;
            });
        };

        for(var i = 0; i < clientIds.length; i++){
            var candidate = this.clients[clientIds[i]];
            if(!candidate || !candidate.avatar || !this.spawnPositions[i]) return false;
            var fallback = { x: Number(this.spawnPositions[i][0]), y: Number(this.spawnPositions[i][1]), verified: false };
            var zone = zones[i] || [fallback.x, fallback.y, fallback.x, fallback.y];
            var x1 = Number(zone[0]);
            var y1 = Number(zone[1]);
            var x2 = Number(zone.length > 2 ? zone[2] : zone[0]);
            var y2 = Number(zone.length > 3 ? zone[3] : zone[1]);
            var startX = Math.min(x1, x2);
            var endX = Math.max(x1, x2);
            var best = null;
            if(this.field && this.field.bitmapData){
                for(var sampleX = startX; sampleX <= endX; sampleX += 10){
                    var ratio = x2 === x1 ? 0 : (sampleX - x1) / (x2 - x1);
                    var authoredY = Math.round(y1 + ((y2 - y1) * ratio));
                    var surface = this.resolveRespawnSurface(sampleX, authoredY);
                    if(!surface || !surface.verified || !isSeparated(surface)) continue;
                    var correction = Math.abs(Number(surface.groundY) - authoredY);
                    if(!best || correction < best.correction){
                        best = Object.assign({ correction: correction }, surface);
                    }
                }
                // A few legacy ranges point at decorative/too-tight lower
                // platforms. Keep the map playable by selecting a distinct
                // verified surface from the complete living mask.
                if(!best){
                    for(var globalX = 50; globalX <= Number(this.field.width || 2800) - 50; globalX += 20){
                        var globalSurface = this.resolveRespawnSurface(globalX, 70);
                        if(globalSurface && globalSurface.verified && isSeparated(globalSurface)){
                            best = Object.assign({ correction: 9999 }, globalSurface);
                            break;
                        }
                    }
                }
            }
            if(this.field && this.field.bitmapData && !best) return false;
            resolvedPositions.push(best || fallback);
        }
        for(var positionIndex = 0; positionIndex < clientIds.length; positionIndex++){
            var client = this.clients[clientIds[positionIndex]];
            client.avatar.X = Number(resolvedPositions[positionIndex].x);
            client.avatar.Y = Number(resolvedPositions[positionIndex].y);
            client.respawnHistory = [{
                x: Number(client.avatar.X),
                y: Number(client.avatar.Y)
            }];
        }
        return true;
    }

    getPlayerPositions(){
        var positions = [];

        for(var key in this.clients){
            positions.push(
            {
                id: this.clients[key].player.id,
                 x: this.clients[key].avatar.X,
                 y: this.clients[key].avatar.Y
            });
        }

        return positions;
    }
    
    getPlayerPositionsAndVelocities(){
        var collection = [];

        for(var key in this.clients){
            collection.push([
                    this.clients[key].player.id,
                    this.clients[key].avatar.X,
                    this.clients[key].avatar.Y,
                    this.clients[key].avatar.Vx,
                    this.clients[key].avatar.Vy
                ]
            );
        }

        return collection;
    }

    getRemainingTicks(){
        return (this.turnEndTick - this.tick);
    }

    //### weps ###

    addProjectile(properties, x, y, vx, vy){
        if(DEBUG) console.log("adding projectile! " + x + " " + y + " " + vx + " " + vy);
        this.physicsObjects.push(this.weapon.makeWeapon(properties, x, y, vx, vy));
    }

    //### player container helpers ###

    addClient(client){
        var clientId = client && client.player && client.player.id;
        var alreadyPresent = clientId !== undefined && clientId !== null &&
            Object.prototype.hasOwnProperty.call(this.clients, clientId);
        if(!alreadyPresent && !this.canAdmit(clientId)){
            console.warn(
                "game_join_rejected code=full game=" + JSON.stringify(this.gameId) +
                " capacity=" + this.playerCount
            );
            if(client && typeof client.sendPacket === "function"){
                client.sendPacket({
                    command: "game_join_failed",
                    code: "full",
                    capacity: this.playerCount
                });
            }
            return false;
        }

        var previousClient = alreadyPresent ? this.clients[clientId] : null;
        if(previousClient && previousClient !== client){
            // A reconnect replaces the renderer for this participant. Remove
            // the old server avatar as well; otherwise it remains in
            // physicsObjects even though the client map now points at the new
            // socket.
            if(previousClient.avatar){
                var previousAvatarIndex = this.physicsObjects.indexOf(previousClient.avatar);
                if(previousAvatarIndex >= 0) this.physicsObjects.splice(previousAvatarIndex, 1);
            }
            if(this.respawnTimers[clientId]) clearTimeout(this.respawnTimers[clientId]);
            delete this.respawnTimers[clientId];
            delete this.respawnDeadlines[clientId];
            delete this.respawnAckStates[clientId];
        }

        this.clients[client.player.id] = client;
        delete this.seatReservations[String(client.player.id)];
        if(client.avatar != null){
            if(DEBUG) console.log(">> client avatar is not null. adding to physicsObjects");
            this.physicsObjects.push(client.avatar);
        }
        else if(DEBUG) console.log("!! client avatar is null");

        if (this.currentPlayer == -1)
            this.currentPlayer = client.player.id;
        else if(client.player.id < this.currentPlayer){
            this.currentPlayer = client.player.id;
        }

        if(this.fillPolicy === "human_only" && !client.isBot && this.isStarting()){
            this.stopGameStart();
        }

        if(client.isBot) return true;
        if(client.connectionType !== "game") return true;

        if(this.getPlayerCount() < this.playerCount && !this.botFillCompleted){
            this.scheduleBotFill();
        }else if(this.getPlayerCount() >= this.playerCount){
            this.clearBotFillTimer();
        }
        return true;
    }

    getHumanPlayerCount(){
        var count = 0;
        for(var key in this.clients){
            if(!this.clients[key].isBot) count++;
        }
        return count;
    }

    getHumanRendererIds(){
        return Object.keys(this.clients).filter(function(id){
            return this.clients[id] && !this.clients[id].isBot && this.clients[id].connectionType === "game";
        }.bind(this));
    }

    clearBotFillTimer(){
        if(this.botFillTimer) clearTimeout(this.botFillTimer);
        this.botFillTimer = null;
        this.botFillDeadline = 0;
        this.botFillScheduled = false;
    }

    cancelBotFill(){
        this.clearBotFillTimer();
        this.botFillFirstHumanAt = 0;
        this.botFillLastHumanAt = 0;
    }

    getBotFillDelay(now){
        now = Number.isFinite(now) ? now : Date.now();
        var firstHumanAt = this.botFillFirstHumanAt || now;
        // A reserved (still loading) player counts as recent activity: the
        // room waits for them instead of handing their seat to a bot.
        var lastHumanAt = Math.max(this.botFillLastHumanAt || now, Number(this.lastReservationAt || 0));
        var deadline = Math.min(firstHumanAt + 15000, lastHumanAt + 8000);
        return Math.max(0, deadline - now);
    }

    scheduleBotFill(){
        if(this.fillPolicy !== "auto" || this.isRunning() || this.botFillCompleted || this.getHumanPlayerCount() < 1 || this.getPlayerCount() >= this.playerCount) return;
        var now = Date.now();
        if(!this.botFillFirstHumanAt) this.botFillFirstHumanAt = now;
        this.botFillLastHumanAt = now;
        this.clearBotFillTimer();
        var delay = this.getBotFillDelay(now);
        this.botFillScheduled = true;
        this.botFillDeadline = now + delay;
        this.botFillTimer = setTimeout(function(){
            this.botFillTimer = null;
            this.botFillScheduled = false;
            if(this.fillPolicy !== "auto" || !this.canAccept() || this.botFillCompleted || this.getHumanPlayerCount() < 1) return;
            // Hold the seats of players whose game socket is still connecting,
            // but never beyond the reservation lifetime.
            if(this.hasPendingReservations() && Date.now() < Number(this.botFillFirstHumanAt || 0) + 25000){
                this.botFillScheduled = true;
                this.botFillDeadline = Date.now() + 1000;
                this.botFillTimer = setTimeout(function(){
                    this.botFillTimer = null;
                    this.botFillScheduled = false;
                    this.fillWithBots();
                }.bind(this), 1000);
                this.botFillTimer.unref();
                return;
            }
            this.fillWithBots();
        }.bind(this), delay);
        this.botFillTimer.unref();
    }

    fillWithBots(force){
        if(this.fillPolicy !== "auto" || this.status === "start_error" || this.isRunning() || this.isGameOver() ||
            (!force && this.awaitingMapLoad) || this.botFillCompleted || this.getHumanPlayerCount() < 1) return;
        if(!force && this.hasPendingReservations() && Date.now() < Number(this.botFillFirstHumanAt || 0) + 25000 && this.botFillFirstHumanAt){
            if(!this.botFillScheduled) this.scheduleBotFill();
            return;
        }
        this.clearBotFillTimer();
        this.botFillCompleted = true;
        while(this.getPlayerCount() + this.getReservedSeatCount() < this.playerCount){
            var id = 900000000 + (++this.botOrdinal);
            var bot = new BotClient(this, id, this.botOrdinal);
            this.addClient(bot);
            // Existing human clients must receive each bot's player profile
            // before startGame broadcasts positions and turn order.
            this.sendPacket(bot.player);
        }
        this.refresh();
        // Let clients see the newly filled slots, then use the same five-second
        // ready countdown as a normal full multiplayer room.
        this.checkGame();
    }

    removeClient(client){
        if(!client || !client.player || this.clients[client.player.id] !== client) return false;
        //change status from dead to disconnected
        if(DEBUG) console.log(">> checking if player was dead");
        var deadPlayerIndex = this.deadPlayers.indexOf(client.player.id);
        if(deadPlayerIndex >= 0){
            this.deadPlayers.splice(deadPlayerIndex, 1);
        }

        if(this.respawnTimers[client.player.id]) clearTimeout(this.respawnTimers[client.player.id]);
        delete this.respawnTimers[client.player.id];
        delete this.respawnDeadlines[client.player.id];
        delete this.respawnAckStates[client.player.id];
        delete this.clients[client.player.id];

        if(!client.isBot && String(client.player.id) === String(this.nativeBotRendererId)){
            this.nativeBotRendererId = null;
            this.getBotRendererId();
        }

        if(!client.isBot && this.getHumanPlayerCount() === 0){
            this.cancelBotFill();
            // A server-only bot match has no connected client to render or
            // synchronize it. Release its physics objects and timers instead
            // of leaving an orphaned game running forever.
            this.initialize();
            return true;
        }

        if(this.fillPolicy === "auto" && !this.isRunning() && !this.botFillCompleted && this.getHumanPlayerCount() > 0){
            this.scheduleBotFill();
        }

        if(this.isStarting())
            this.stopGameStart();
        else this.refresh();

        this.checkGame();
        return true;
    }

    containsClient(client){
        return this.clients[client.player.id] != null;
    }

    //### packets ###

    sendPacket(packet){
        this.broadcastPacket(packet, null);
    }
    sendPacketE(packet, clientExcl){
        this.broadcastPacket(packet, clientExcl);
    }
    broadcastPacket(packet, clientExcl){
        // Session-bearing packets are personalised; everything else is
        // serialized once and the same frame body is written to every socket.
        var personalised = packet.hasOwnProperty("session");
        var serialized = null;
        for(var key in this.clients){
            var client = this.clients[key];
            if(!client || client == clientExcl) continue;
            if(personalised){
                packet.session = client.gameSession;
                client.sendPacket(packet);
            }else if(typeof client.sendSerialized === "function"){
                if(serialized === null) serialized = JSON.stringify(packet);
                client.sendSerialized(serialized);
            }else{
                client.sendPacket(packet);
            }
        }
    }

    getStartInvariant(){
        var clientIds = Object.keys(this.clients);
        if(clientIds.length < 2){
            return { ok: false, code: "not_enough_players", playerCount: clientIds.length };
        }
        if(clientIds.length > this.playerCount || clientIds.length > this.spawnPositions.length){
            return { ok: false, code: "map_capacity_exceeded", playerCount: clientIds.length };
        }
        for(var i = 0; i < clientIds.length; i++){
            var client = this.clients[clientIds[i]];
            if(!client || !client.avatar){
                return { ok: false, code: "invalid_participant", playerCount: clientIds.length };
            }
        }
        return { ok: true, clientIds: clientIds, playerCount: clientIds.length };
    }

    rejectGameStart(error){
        if(this.startingTimeout) clearTimeout(this.startingTimeout);
        if(this.startHandshakeTimeout) clearTimeout(this.startHandshakeTimeout);
        this.startingTimeout = null;
        this.startHandshakeTimeout = null;
        this.awaitingMapLoad = false;
        this.cancelBotFill();
        this.updateGameStatus("start_error");

        var packet = {
            command: "game_start_rejected",
            code: error.code,
            map: this.mapName,
            requestedCapacity: this.requestedPlayerCount,
            capacity: this.playerCount,
            playerCount: error.playerCount
        };
        console.error(
            "game_start_rejected code=" + error.code +
            " game=" + JSON.stringify(this.gameId) +
            " map=" + JSON.stringify(this.mapName) +
            " players=" + error.playerCount +
            " capacity=" + this.playerCount
        );
        try{
            this.sendPacket(packet);
            this.refresh();
        }catch(sendError){
            console.error("game_start_rejection_delivery_failed", sendError.message);
        }
        this.scheduleStartErrorReset();
        return false;
    }

    startGame(){
        var invariant = this.getStartInvariant();
        if(!invariant.ok) return this.rejectGameStart(invariant);

        this.cancelBotFill();
        this.generateRndSeed();
        if(!this.setDefaultPositions(invariant.clientIds)){
            return this.rejectGameStart({
                code: "spawn_assignment_failed",
                playerCount: invariant.playerCount
            });
        }

        // All participant and spawn invariants are established before the
        // room becomes visible as running.
        this.updateGameStatus("running");
        this.turnEpoch = 1;
        // Capability is not readiness. The v23 renderer must first create and
        // acknowledge every bot avatar before it can replace the server AI.
        this.nativeBotAI = false;
        this.nativeBotRosterReady = false;
        if(!this.clients[this.currentPlayer]) this.currentPlayer = invariant.clientIds[0];
        this.matchPlayerIds = invariant.clientIds.map(String);
        this.matchId = [
            String(this.gameId),
            String(this.randomSeed),
            String(Date.now())
        ].join(":");
        this.progressionSnapshots = {};
        for(var snapshotId of invariant.clientIds){
            this.captureProgressionSnapshot(this.clients[snapshotId]);
        }

        var cmd = {
            "command" 		: "startGame",
            "randomSeed"	: this.randomSeed,
            "co"			: this.getPlayerIds(),
            "currentPlayer" : this.getCurrentPlayer(),
            "tick"			: this.getTick(),
            "playerlist"	: this.getPlayerList(),
            "positions"     : this.getPlayerPositions()
        };

        this.initialCount = cmd.co.length;
        this.matchEndTick = this.tick + Math.floor(this.gameDuration / 10);
        for(var scoreId in this.clients){
            this.scores[scoreId] = 0;
            this.deathCounts[scoreId] = 0;
            this.matchMedalState[String(scoreId)] = {
                shots: 0, moves: 0, damageTaken: 0, damageDealt: 0, crates: 0,
                onlyMortar: true, onlyGrenade: true, onlyPetPower: true,
                killEpoch: -1, turnKills: 0
            };
            this.initializeHealth(this.clients[scoreId], true);
        }

        this.getBotRendererId();
        cmd.turnEpoch = this.turnEpoch;
        cmd.nativeBotRendererId = this.nativeBotRendererId;
        cmd.botControllerEpoch = this.botControllerEpoch;
        if(this.clients[this.currentPlayer] && this.clients[this.currentPlayer].isBot){
            cmd.botWeapon = this.assignBotWeapon(this.clients[this.currentPlayer]);
            cmd.botWeaponCycle = this.clients[this.currentPlayer]._botWeaponCycle || 1;
        }

        this.sendPacket(cmd);
        this.setNextTurn(200);
        this.botActionNotBefore = Date.now() + 2500;
        return true;
    }

    isFull(){
        return (this.getPlayerCount() + this.getReservedSeatCount() >= this.playerCount);
    }

    refresh(){
        this.sendPacket(this.getString("game"));
    }

    sendConfirmation(){
        this.sendPacket({"command" : "game_join_confirmed", "map": this.mapName, "loadId": this.mapLoadId, "protocol": 4});
    }

    sendChangeTurn(){
        try{
            this.currentTurnDeathHold = null;
            if(this.clients[this.currentPlayer]){
                this.clients[this.currentPlayer].avatar.stopWalking();
            }
            this.botPendingProjectile = null;

            //this.synchronize();
            var r = this.getNextPlayerId();
            if(r === -1){
                // Every avatar can briefly be dead during a multi-kill. The
                // scheduled respawns restore the turn ring; retry when the
                // earliest one is due, without another cleanup round trip.
                var nextRespawnAt = Infinity;
                for(var respawnKey in this.respawnDeadlines){
                    nextRespawnAt = Math.min(nextRespawnAt, Number(this.respawnDeadlines[respawnKey]) || Infinity);
                }
                var waitTicks = Number.isFinite(nextRespawnAt)
                    ? Math.max(10, Math.min(300, Math.ceil((nextRespawnAt - Date.now()) / 10) + 20))
                    : 50;
                this.turnEndTick = this.tick + waitTicks;
                this.turnCleanupEpoch = Number(this.turnEpoch);
                return;
            }

            // Every renderer shows the same turn clock (it used to reach only
            // the new current player while the others ran local timers).
            this.sendServerTick();
            this.clients[this.currentPlayer].resetTurnChanges();
            var record = this.getGameRecord("changeTurn");
            this.turnEpoch++;
            record.turnEpoch = this.turnEpoch;
            record.nativeBotRendererId = this.getBotRendererId();
            record.botControllerEpoch = this.botControllerEpoch;
            var active = this.clients[this.currentPlayer];
            if(active && active.isBot){
                record.botWeapon = this.assignBotWeapon(active);
                record.botWeaponCycle = active._botWeaponCycle || 1;
            }

            this.sendPacket(record);

        }
        catch(e){
            console.error("sendChangeTurn failed", e);
        }
    }

    synchronize(){
        for(var key in this.clients){
            var c = this.clients[key];
            this.sendPlayerPosition(c);
        }
    }

    sendTick(){
        var cmd = this.lastSynchCheck;
        cmd["command"] = "synch_check";
        cmd["id"] = "oppenheimer";
        cmd["tick"] = this.tick;
        this.sendPacketE(cmd, this.clients[this.currentPlayer]);
    }

    sendServerTick(){
        var cmd = {
            "id"	: -1,
            "command" : "set_tick",
            "value": this.tick,
            "turnEndTick": this.turnEndTick,
            "tick": 0
        };

        this.sendPacket(cmd);
    }

    endGame(reason = "unspecified"){
        if(this.endingGame || this.isGameOver()) return;
        this.endingGame = true;
        this.updateGameStatus("gameover");
        //set the status to gameover to pause any ticking, processing etc. and
        //don't free this slot. not yet.
        //give awards, show screens etc. first
        console.log(">> Game over! reason=" + reason + "; alive=" + this.getAlivePlayerIds().join(",") + "; dead=" + this.deadPlayers.join(","));

        var participantIds = Object.keys(this.clients).map(Number);
        var winningTeam = null;
        var teamRank = Object.create(null);
        if(this.teamMode){
            var teamTotals = Object.create(null);
            participantIds.forEach(function(id){
                var team = this.getTeamId(id);
                if(!teamTotals[team]) teamTotals[team] = { team: team, score: 0, deaths: 0, alive: 0 };
                teamTotals[team].score += Number(this.scores[id] || 0);
                teamTotals[team].deaths += Number(this.deathCounts[id] || 0);
                if(this.clients[id] && !this.clients[id].isDead()) teamTotals[team].alive++;
            }.bind(this));
            var orderedTeams = Object.values(teamTotals).sort(function(a, b){
                if(this.isEliminationMode() && a.alive !== b.alive) return b.alive - a.alive;
                if(a.score !== b.score) return b.score - a.score;
                if(a.deaths !== b.deaths) return a.deaths - b.deaths;
                return Number(a.team) - Number(b.team);
            }.bind(this));
            orderedTeams.forEach(function(team, index){ teamRank[team.team] = index; });
            if(orderedTeams.length) winningTeam = orderedTeams[0].team;
        }

        var playerOrder = participantIds.sort(function(a, b){
            if(this.teamMode){
                var teamDifference = teamRank[this.getTeamId(a)] - teamRank[this.getTeamId(b)];
                if(teamDifference !== 0) return teamDifference;
            }
            var scoreDifference = (this.scores[b] || 0) - (this.scores[a] || 0);
            if(scoreDifference !== 0) return scoreDifference;
            var deathDifference = (this.deathCounts[a] || 0) - (this.deathCounts[b] || 0);
            if(deathDifference !== 0) return deathDifference;
            return a - b;
        }.bind(this));

        if(playerOrder.length > 2){
            for(var i = 0; i < playerOrder.length; i++){
                if(!this.clients[playerOrder[i]]) continue;
                this.clients[playerOrder[i]].addXP(9 * (6 - i));
                this.clients[playerOrder[i]].addGold(12 * (6 - i), true);
            }
        }

        var persistenceTasks = [];
        for(var key in this.clients){
            var participant = this.clients[key];
            if(!participant || participant.isBot) continue;
            this.recordProgression(participant, "games", 1);
            Progression.recordActivePetStat(participant.player, "played", 1);
            this.awardProgressionMedal(participant, "gone_wild");
            var medalState = this.getMatchMedalState(participant);
            var isWinner = this.teamMode
                ? this.getTeamId(key) === winningTeam
                : Number(playerOrder[0]) === Number(key);
            if(isWinner){
                this.recordProgression(participant, "wins", 1);
                Progression.recordActivePetStat(participant.player, "wins", 1);
                this.awardProgressionMedal(participant, "pick_of_litter");
                if(medalState && medalState.damageTaken === 0) this.awardProgressionMedal(participant, "untouchable");
                if(medalState && medalState.moves === 0) this.awardProgressionMedal(participant, "stand_and_fight");
                if(medalState && medalState.shots === 0) this.awardProgressionMedal(participant, "passive_aggression");
                if(medalState && medalState.shots > 0 && medalState.onlyMortar) this.awardProgressionMedal(participant, "mortar_mayhem");
                if(medalState && medalState.shots > 0 && medalState.onlyGrenade) this.awardProgressionMedal(participant, "have_a_blast");
                if(medalState && medalState.shots > 0 && medalState.onlyPetPower) this.awardProgressionMedal(participant, "furry_fury");
            }else{
                this.recordProgression(participant, "losses", 1);
                Progression.recordActivePetStat(participant.player, "losses", 1);
            }
            if(medalState && medalState.damageDealt > 0){
                var dealtMax = Object.keys(this.clients).every(function(id){
                    return medalState.damageDealt >= Number((this.getMatchMedalState(this.clients[id]) || {}).damageDealt || 0);
                }.bind(this));
                var takenMax = Object.keys(this.clients).every(function(id){
                    return medalState.damageTaken >= Number((this.getMatchMedalState(this.clients[id]) || {}).damageTaken || 0);
                }.bind(this));
                if(dealtMax && takenMax) this.awardProgressionMedal(participant, "suicidal_mayhem");
            }
            persistenceTasks.push(this.persistProgression(participant));
        }

        this.endGamePromise = Promise.all(persistenceTasks).then(function(){
            for(var resultKey in this.clients){
                this.clients[resultKey].sendGameStats(playerOrder, this.scores, this.deathCounts);
            }

            var cmd = this.getGameRecord("endGame");
            this.sendPacket(cmd);
            // The Flash client closes its game socket before it shows the
            // result popup. Keep this slot intact for a short grace period so
            // final commands still resolve against the completed match.
            this.endGameCleanupTimer = setTimeout(function(){
                this.initialize();
            }.bind(this), 30000);
            this.endGameCleanupTimer.unref();
            return playerOrder;
        }.bind(this)).catch(function(error){
            console.error("match_progression_commit_failed", error);
            this.sendPacket({
                command: "alert",
                text: "Match progress could not be saved. Please try again."
            });
            return [];
        }.bind(this));
        return this.endGamePromise;
    }

    sendChatMessage(msg){
        var cmd = {
            "command" : "chat",
            "text": msg,
            "id": 0,
            "ordered" : "true",
            "tick" : 0,
            "date": Date.now(),
            "dname" : "Bot"
        };

        this.sendPacket(cmd);
    }

    sendPlayerPosition(c){
        var cmd = {};
        cmd["command"] = "position";
        cmd["x"] = c.avatar.X;
        cmd["y"] = c.avatar.Y;
        cmd["tick"] = this.tick;
        cmd["id"] = c.player.id;

        this.sendPacket(cmd);
    }

    requestSynch(){
        this.clients[this.currentPlayer].sendPacket({"command": "request_synch"});
    }

    //### getters ###

    getNextPlayerId(){
        var foundPlayer = false;
        for(var pKey in this.clients){
            if(!foundPlayer) {
                //console.log("Looking over: " + pKey + " " + this.clients[pKey].player.dname);

                if (parseInt(pKey) > this.currentPlayer && this.isTurnEligible(this.clients[pKey])) {
                    //console.log("Found in first loop: " + pKey + " " + this.clients[pKey].player.dname + " compare " + (pKey > this.currentPlayer));

                    this.currentPlayer = pKey;
                    foundPlayer = true;
                }
            }
        }

        if(!foundPlayer) {
            for (var pKey in this.clients) {
                if (!foundPlayer) {
                    if (parseInt(pKey) < this.currentPlayer && this.isTurnEligible(this.clients[pKey])) {
                        this.currentPlayer = pKey;
                        foundPlayer = true;
                        if(DEBUG) console.log("Found in second loop: " + pKey + " " + this.clients[pKey].player.dname);
                    }
                }
            }
        }

        if(!foundPlayer) return -1;

        if(DEBUG) console.log("current player is " + this.currentPlayer);
    }

    countPlayersAlive(){
        // Derive this from the participant state itself.  The death array is
        // retained for placement ordering, but it must not be the authority for
        // turn selection or match completion.
        return Object.values(this.clients).filter(function(client){
            return client && !client.isDead();
        }).length;
    }

    isRendererStale(client, now){
        // Every live v26 renderer sends position heartbeats several times a
        // second. A silent, half-open socket would otherwise keep receiving
        // full-length turns until the five-minute socket timeout.
        if(!client || client.isBot || client.connectionType !== "game") return false;
        var last = Number(client.lastMessageTime || 0);
        if(!(last > 0)) return false;
        return (Number.isFinite(now) ? now : Date.now()) - last > 20000;
    }

    isTurnEligible(client){
        if(!client || client.isDead()) return false;
        if(this.isRendererStale(client)) return false;
        if(client.respawnReady !== false) return true;

        // Never advance onto an avatar the movie has not confirmed as living.
        // The respawn packet is retried until acknowledgement; a timeout that
        // silently marks the server ready is how turns became stuck on ghosts.
        var state = this.respawnAckStates[client.player.id];
        if(!state) return false;
        return false;
    }

    getAlivePlayerIds(){
        return Object.values(this.clients).filter(function(client){
            return client && !client.isDead();
        }).map(function(client){
            return client.player.id;
        });
    }

    isEliminationMode(){
        return this.numberOfDeaths === 1;
    }

    getAliveTeamIds(aliveIds){
        // The Flash movie assigns teams by avatar-list parity. Preserve the
        // exact start order so the server reaches the same Last Team Standing
        // result even after a participant dies.
        var order = this.matchPlayerIds.length ? this.matchPlayerIds : Object.keys(this.clients);
        var teams = Object.create(null);
        (aliveIds || this.getAlivePlayerIds()).forEach(function(id){
            var index = order.indexOf(String(id));
            if(index >= 0) teams[index % 2] = true;
        });
        return Object.keys(teams);
    }

    getTeamId(id){
        var order = this.matchPlayerIds.length ? this.matchPlayerIds : Object.keys(this.clients);
        var index = order.indexOf(String(id));
        return index < 0 ? -1 : index % 2;
    }

    getGameStatus(){
        return this.status;
    }

    getCurrentPlayer(){
        return this.currentPlayer;
    }

    getTick(){
        return this.tick;
    }

    getPlayerCount(){
        return Object.keys(this.clients).length;
    }

    pruneSeatReservations(now){
        now = Number.isFinite(now) ? now : Date.now();
        for(var id in this.seatReservations){
            if(this.seatReservations[id] <= now || Object.prototype.hasOwnProperty.call(this.clients, id)){
                delete this.seatReservations[id];
            }
        }
    }

    getReservedSeatCount(now){
        this.pruneSeatReservations(now);
        return Object.keys(this.seatReservations).length;
    }

    hasPendingReservations(now){
        return this.getReservedSeatCount(now) > 0;
    }

    canAccept(){
        // Rooms in their map-load handshake, running, finished or failed can
        // never take a new participant; their roster is already committed.
        return this.status !== "start_error" && !this.awaitingMapLoad &&
            !this.isRunning() && !this.isGameOver() && !this.endingGame;
    }

    reserveSeat(playerId, ttlMs){
        if(playerId === undefined || playerId === null || !this.canAccept()) return false;
        var key = String(playerId);
        var now = Date.now();
        this.pruneSeatReservations(now);
        if(!Object.prototype.hasOwnProperty.call(this.clients, key) &&
            !Object.prototype.hasOwnProperty.call(this.seatReservations, key) &&
            this.getPlayerCount() + Object.keys(this.seatReservations).length >= this.playerCount){
            return false;
        }
        this.seatReservations[key] = now + (Number(ttlMs) > 0 ? Number(ttlMs) : 20000);
        this.lastReservationAt = now;
        // A newly committed player pushes the bot deadline out, exactly like
        // a connected one, so a slow Ruffle load is not replaced by a bot.
        if(this.botFillScheduled) this.scheduleBotFill();
        return true;
    }

    releaseSeat(playerId){
        delete this.seatReservations[String(playerId)];
    }

    canAdmit(playerId){
        var key = playerId === undefined || playerId === null ? null : String(playerId);
        if(key !== null && Object.prototype.hasOwnProperty.call(this.clients, key)) return true;
        var now = Date.now();
        this.pruneSeatReservations(now);
        if(key !== null && Object.prototype.hasOwnProperty.call(this.seatReservations, key)){
            return this.getPlayerCount() < this.playerCount;
        }
        return this.getPlayerCount() + Object.keys(this.seatReservations).length < this.playerCount;
    }

    getStatusCollection(){
        var playerList = [];
        for(var key in this.clients){
            var client = this.clients[key];
            playerList.push({"guid" : client.player.id, "status": client.player.status});
        }
        return playerList;
    }

    getPlayerList(){
        var playerList = [];
        for(var key in this.clients){
            var client = this.clients[key];
            playerList.push(publicPlayerRecord(client.player));
        }
        return playerList;
    }

    getString(command){
        var cmd = {};
        cmd.command         = command;
        cmd.status          = this.status;
        cmd.playerCount     = this.getPlayerCount();
        cmd.min             = this.min;
        cmd.id              = this.gameId;
        cmd.map             = this.mapName;
        cmd.players         = this.getStatusCollection();
        cmd.name            = this.displayName || this.mapName;
        cmd.skip            = this.skip;
        cmd.time            = new Date().getTime();
        cmd.gameDuration    = this.gameDuration;
        cmd.turnDuration    = this.turnDuration;
        cmd.nu              = this.numberOfDeaths;
        cmd.te              = this.teamMode;
        cmd.ba              = this.balancedGame;
        cmd.wi              = this.useWind;
        cmd.fillPolicy      = this.fillPolicy;
        cmd.cl              = this.cl;
        cmd.sumOfLevels     = this.sumOfLevels;
        cmd.session         = this.session;
        return cmd;
    }

    getClients(){
        return this.clients;
    }

    getPlayerIds(){
        var ids = [];
        for(var key in this.clients){
            var client = this.clients[key];
            ids.push(client.player.id.toString());
        }
        return ids;
    }

    getPlayerAlive(){
        for(var key in this.clients)
            if(!this.clients[key].isDead()) return this.clients[key];

        return null;
    }

    getGameRecord(cmd){
        var record = {
            "randomSeed"    : this.randomSeed,
            "co"		    : this.getPlayerIds(),
            "playerlist"    : this.getPlayerList(),
            "tick"          : 0,
            "currentPlayer" : this.currentPlayer,
            "command"       : cmd,
            "why"           : "Because we can."
        };

        return record;
    }

    //### checkers ###

    isRunning(){
        return this.status == "running";
    }

    isStarting(){
        return this.status == "starting";
    }

    isGameOver(){
        return this.status == "gameover";
    }
}

module.exports = Slot;
