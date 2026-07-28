"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Slot = require("../game/slot.js");
const BotController = require("../game/bot.controller.js");
const Handler = require("../game/handler.js");
const Utils = require("../game/helpers/utils.js");

function makeWopw() {
    return {
        mapsObj: { "Critter Falls": { positions: [[100, 100], [300, 100], [500, 100], [700, 100], [900, 100], [1100, 100]] } },
        petsObj: { rabbit: { hp: 100, size: 20, bounce: 0.2, jump: 0.25, speed: 0.004 } },
        levelsObj: Array.from({ length: 101 }, (_, index) => ({ xp: index * 100 })),
        accessoriesObj: {
            unsafeHat: { type: "unsafeHat", category: "heads" },
            testHat: { type: "testHat", category: "heads", stats: {} },
            testTop: { type: "testTop", category: "tops", stats: {} },
            testBottom: { type: "testBottom", category: "bottoms", stats: {} }
        },
        weaponsObj: Object.fromEntries(["minigun", "mortar", "fireworks", "grenade", "banana", "fireball", "pumpkin", "dynamite", "clustergrenade", "jumbomissile", "multishot"].map((type) => [type, { type, timeAfter: 100 }])),
        getLobbyLoad: () => 0,
        packetHandler: {}
    };
}

function human(id) {
    return {
        connectionType: "game",
        player: { id, dname: "Owner", status: "playing" },
        avatar: { X: 0, Y: 0, dead: false, properties: { hp: 100 }, stopWalking() {} },
        isDead() { return this.avatar.dead; },
        sendPacket() {},
        sendServerTick() {},
        resetTurnChanges() {},
        addXP() {},
        addGold() {},
        sendGameStats() {}
    };
}

function installFlatTerrain(slot, groundY = 180) {
    slot.field.bitmapData = {};
    slot.field.width = 1200;
    slot.field.height = 500;
    slot.field.checkFieldCollisionPoint = (x, y) =>
        Number(x) >= 0 && Number(x) <= slot.field.width && Number(y) >= groundY;
}

for (const capacity of [2, 4, 6]) {
    test(`single-human ${capacity}-slot room fills every remaining slot and enters the normal start countdown`, () => {
        const slot = new Slot(makeWopw(), `bot-test-${capacity}`, "Critter Falls", capacity, 60000, 10000);
        slot.addClient(human(1));
        assert.equal(slot.botFillScheduled, true);

        slot.fillWithBots();
        assert.equal(slot.getPlayerCount(), capacity);
        assert.equal(slot.getHumanPlayerCount(), 1);
        assert.equal(slot.status, "starting");
        assert.equal(Object.values(slot.clients).filter((client) => client.isBot).length, capacity - 1);
        assert.ok(Object.values(slot.clients).filter((client) => client.isBot).every((client) =>
            Array.isArray(client.player.ownedPets[1].accessories)
        ));
        assert.ok(Object.values(slot.clients).filter((client) => client.isBot).every((client) =>
            client.player.ownedPets[1].accessories.every((type) => slot.WOPW.accessoriesObj[type].stats)
        ));
        assert.equal(slot.botFillCompleted, true);
        slot.initialize();
    });
}

test("second human cancels the pending bot fill", () => {
    const slot = new Slot(makeWopw(), "bot-cancel", "Critter Falls", 2, 60000, 10000);
    slot.addClient(human(1));
    slot.addClient(human(2));
    assert.equal(slot.botFillScheduled, false);
    assert.equal(slot.getHumanPlayerCount(), 2);
    slot.initialize();
});

test("a death records score and respawns instead of ending the score match", () => {
    const slot = new Slot(makeWopw(), "bot-last-dead", "Critter Falls", 2, 60000, 10000);
    const owner = human(1);
    const bot = { isBot: true, player: { id: 2 }, avatar: { dead: false, properties: { hp: 100 } }, isDead() { return this.avatar.dead; }, sendPacket() {} };
    slot.clients = { 1: owner, 2: bot };
    slot.updateGameStatus("running");
    installFlatTerrain(slot);
    let ended = 0;
    slot.endGame = () => { ended++; };

    slot.setPlayerDead(2, 1);
    assert.equal(bot.avatar.dead, true);
    assert.equal(ended, 0);
    assert.equal(slot.scores[1], 1);
    assert.equal(slot.respawnPlayer(2), true);
    assert.equal(bot.avatar.dead, false);
    assert.equal(bot.avatar.hp, 100);
    assert.equal(ended, 0);
    slot.initialize();
});

test("respawn is delayed three seconds and chooses a different random spawn zone", () => {
    const slot = new Slot(makeWopw(), "random-respawn", "Critter Falls", 2, 60000, 10000);
    const owner = human(1);
    const bot = { isBot: true, player: { id: 2 }, avatar: { X: 100, Y: 100, dead: false, properties: { hp: 100 } }, isDead() { return this.avatar.dead; }, sendPacket() {} };
    slot.clients = { 1: owner, 2: bot };
    slot.updateGameStatus("running");
    installFlatTerrain(slot);
    slot.currentPlayer = 2;
    slot.tick = 500;

    slot.setPlayerDead(2, 1);
    assert.equal(bot.avatar.dead, true);
    assert.ok(slot.respawnDeadlines[2] - Date.now() > 2900);
    assert.equal(slot.turnEndTick, 0);

    slot.respawnDeadlines[2] = Date.now() - 1;
    slot.processRespawns();
    assert.equal(bot.avatar.dead, false);
    assert.notDeepEqual([bot.avatar.X, bot.avatar.Y], [100, 100]);
    slot.initialize();
});

test("the update fallback restores a dead player whose respawn timer was lost", () => {
    const slot = new Slot(makeWopw(), "respawn-fallback", "Critter Falls", 2, 60000, 10000);
    const owner = human(1);
    const bot = { isBot: true, player: { id: 2 }, avatar: { X: 100, Y: 100, dead: true, properties: { hp: 100 } }, isDead() { return this.avatar.dead; }, sendPacket() {} };
    slot.clients = { 1: owner, 2: bot };
    slot.updateGameStatus("running");
    installFlatTerrain(slot);
    slot.processRespawns();
    assert.ok(slot.respawnDeadlines[2] > Date.now());
    slot.respawnDeadlines[2] = Date.now() - 1;
    slot.processRespawns();
    assert.equal(bot.avatar.dead, false);
    slot.initialize();
});

test("simultaneous respawns reserve distinct verified surfaces", () => {
    const slot = new Slot(makeWopw(), "reserved-respawns", "Critter Falls", 4, 60000, 10000);
    slot.clients = Object.fromEntries([1, 2, 3, 4].map((id) => {
        const participant = human(id);
        participant.avatar.X = id * 100;
        participant.avatar.Y = 100;
        participant.avatar.dead = true;
        return [id, participant];
    }));
    slot.updateGameStatus("running");
    slot.randomSeed = 8675309;
    installFlatTerrain(slot);
    for (const id of [1, 2, 3, 4]) assert.equal(slot.respawnPlayer(id), true);
    const positions = Object.values(slot.clients).map((client) => [client.avatar.X, client.avatar.Y]);
    for (let left = 0; left < positions.length; left++) {
        for (let right = left + 1; right < positions.length; right++) {
            assert.ok(Math.hypot(
                positions[left][0] - positions[right][0],
                positions[left][1] - positions[right][1]
            ) >= 100);
        }
    }
    slot.initialize();
});

test("respawn refuses every surface covered by the current crater record", () => {
    const slot = new Slot(makeWopw(), "cratered-respawn", "Critter Falls", 2, 60000, 10000);
    const owner = human(1);
    owner.avatar.dead = true;
    slot.clients = { 1: owner };
    slot.updateGameStatus("running");
    installFlatTerrain(slot);
    slot.field.explosionRecord = [[
        Utils.intToString(600),
        Utils.intToString(180),
        Utils.intToString(2000)
    ]];
    assert.equal(slot.getRandomRespawnPosition(owner), null);
    assert.equal(slot.respawnPlayer(1), false);
    assert.equal(owner.avatar.dead, true);
    slot.initialize();
});

test("a score-match death burst requests one early effect cleanup", async () => {
    const slot = new Slot(makeWopw(), "mass-death-cleanup", "Critter Falls", 4, 60000, 10000);
    slot.clients = Object.fromEntries([1, 2, 3, 4].map((id) => [id, human(id)]));
    slot.updateGameStatus("running");
    const packets = [];
    slot.sendPacket = (packet) => packets.push(packet);
    for (const id of [1, 2, 3, 4]) assert.equal(slot.setPlayerDead(id, 1, 0), true);
    await new Promise((resolve) => setTimeout(resolve, 550));
    const cleanups = packets.filter((packet) =>
        packet.command === "force_effect_cleanup" && packet.reason === "mass_death");
    assert.equal(cleanups.length, 1);
    assert.equal(cleanups[0].deaths, 4);
    assert.ok(slot.respawnTerrainBarrierUntil > Date.now());
    slot.initialize();
});

test("a four-player mass death commits one elimination result", async () => {
    const slot = new Slot(makeWopw(), "mass-death", "Critter Falls", 4, 60000, 10000, { nu: 1 });
    slot.clients = Object.fromEntries([1, 2, 3, 4].map((id) => {
        const participant = human(id);
        participant.player.dname = `Player-${id}`;
        return [id, participant];
    }));
    slot.matchPlayerIds = ["1", "2", "3", "4"];
    slot.updateGameStatus("running");
    const packets = [];
    slot.sendPacket = (packet) => packets.push(packet);
    for (const id of [1, 2, 3, 4]) assert.equal(slot.setPlayerDead(id, id === 1 ? 2 : 1, 0), true);
    slot.checkGame();
    slot.checkGame();
    await slot.endGamePromise;
    assert.deepEqual(Object.values(slot.deathCounts), [1, 1, 1, 1]);
    assert.equal(packets.filter((packet) => packet.command === "endGame").length, 1);
    slot.initialize();
});

test("a stale zero-HP synchronization cannot kill a respawned player again", () => {
    const handler = new Handler({});
    let deaths = 0;
    const participant = human(1);
    participant.avatar.setPosition = () => {};
    const game = {
        currentPlayer: 1,
        tick: 100,
        mapName: "Critter Falls",
        WOPW: makeWopw(),
        field: { height: 1400 },
        clients: { 1: participant },
        setPlayerDead() { deaths++; },
        sendPacket() {}
    };
    participant.getGame = () => game;
    handler.handleSynch(participant, {
        timeLoop: {},
        avatarList: [{ player: 1, hp: Utils.intToString(0), X: Utils.intToString(100), Y: Utils.intToString(100) }]
    });
    assert.equal(deaths, 0);
});

test("an authoritative bot respawn waits for every connected renderer to confirm current terrain", () => {
    const slot = new Slot(makeWopw(), "respawn-ack", "Critter Falls", 2, 60000, 10000);
    const owner = human(1);
    const bot = { isBot: true, player: { id: 2 }, avatar: { X: 100, Y: 100, dead: true, properties: { hp: 100 } }, isDead() { return this.avatar.dead; }, sendPacket() {} };
    slot.clients = { 1: owner, 2: bot };
    slot.updateGameStatus("running");
    installFlatTerrain(slot);
    assert.equal(slot.respawnPlayer(2), true);
    const respawn = slot.respawnAckStates[2].packet;
    assert.ok(respawn.respawnToken);
    assert.equal(slot.isTurnEligible(bot), false);
    assert.equal(slot.acknowledgeRespawn(
        1,
        2,
        bot.respawnGeneration,
        respawn.respawnToken,
        respawn.x,
        respawn.y,
        true,
        respawn.terrainRevision
    ), true);
    assert.equal(slot.respawnAckStates[2], undefined);
    assert.equal(slot.isTurnEligible(bot), true);
    slot.initialize();
});

test("a bot stays out of the turn ring until both human terrain renderers acknowledge it", () => {
    const slot = new Slot(makeWopw(), "respawn-two-renderers", "Critter Falls", 4, 60000, 10000);
    const first = human(1);
    const second = human(2);
    const bot = {
        isBot: true,
        player: { id: 3 },
        avatar: { X: 100, Y: 100, dead: true, properties: { hp: 100 } },
        isDead() { return this.avatar.dead; },
        sendPacket() {}
    };
    slot.clients = { 1: first, 2: second, 3: bot };
    slot.updateGameStatus("running");
    installFlatTerrain(slot);
    assert.equal(slot.respawnPlayer(3), true);
    const respawn = slot.respawnAckStates[3].packet;
    assert.equal(slot.acknowledgeRespawn(
        1, 3, bot.respawnGeneration, respawn.respawnToken,
        respawn.x, respawn.y, true, respawn.terrainRevision
    ), true);
    assert.equal(slot.isTurnEligible(bot), false);
    assert.equal(slot.acknowledgeRespawn(
        2, 3, bot.respawnGeneration, respawn.respawnToken,
        respawn.x, respawn.y, true, respawn.terrainRevision
    ), true);
    assert.equal(slot.isTurnEligible(bot), true);
    slot.initialize();
});

test("a delayed human respawn ACK is retried until the renderer confirms it", () => {
    const slot = new Slot(makeWopw(), "respawn-ack-timeout", "Critter Falls", 4, 60000, 10000);
    const owner = human(1);
    const bots = [2, 3, 4].map((id) => ({ isBot: true, player: { id }, avatar: { X: id * 100, Y: 100, dead: false, properties: { hp: 100 } }, isDead() { return this.avatar.dead; }, sendPacket() {}, sendServerTick() {}, resetTurnChanges() {} }));
    slot.clients = { 1: owner, 2: bots[0], 3: bots[1], 4: bots[2] };
    slot.updateGameStatus("running");
    installFlatTerrain(slot);
    owner.avatar.dead = true;
    assert.equal(slot.respawnPlayer(1), true);
    assert.equal(slot.isTurnEligible(owner), false);
    slot.respawnAckStates[1].nextRetryAt = Date.now() - 1;
    slot.processRespawnAcks();
    assert.equal(slot.respawnAckStates[1].retryCount, 1);
    assert.equal(slot.isTurnEligible(owner), false);
    const ownerRespawn = slot.respawnAckStates[1].packet;
    assert.equal(slot.acknowledgeRespawn(
        1, 1, owner.respawnGeneration, ownerRespawn.respawnToken,
        ownerRespawn.x, ownerRespawn.y, false, ownerRespawn.terrainRevision
    ), false);
    assert.equal(slot.acknowledgeRespawn(
        1, 1, owner.respawnGeneration, ownerRespawn.respawnToken,
        ownerRespawn.x, ownerRespawn.y, true, ownerRespawn.terrainRevision + 1
    ), false);
    assert.equal(slot.acknowledgeRespawn(
        1,
        1,
        owner.respawnGeneration,
        ownerRespawn.respawnToken,
        ownerRespawn.x,
        ownerRespawn.y,
        true,
        ownerRespawn.terrainRevision
    ), true);
    assert.equal(slot.isTurnEligible(owner), true);
    slot.currentPlayer = 4;
    slot.getNextPlayerId();
    assert.equal(parseInt(slot.currentPlayer), 1);
    slot.initialize();
});

test("only an authenticated self world-fall enters the three-second respawn queue", () => {
    const slot = new Slot(makeWopw(), "fall-respawn", "Critter Falls", 2, 60000, 10000);
    const owner = human(1);
    const bot = { isBot: true, player: { id: 2 }, avatar: { X: 100, Y: 100, hp: 100, dead: false, properties: { hp: 100 }, setPosition(x, y) { this.X = x; this.Y = y; } }, isDead() { return this.avatar.dead; }, sendPacket() {} };
    slot.clients = { 1: owner, 2: bot };
    slot.updateGameStatus("running");
    owner.avatar.setPosition = function(x, y) { this.X = x; this.Y = y; };
    owner.getGame = () => slot;
    const handler = new Handler({});
    assert.equal(handler.handleWorldFall(owner, {
        id: 1,
        generation: 0,
        x: 100,
        y: 1500
    }), true);
    assert.equal(handler.handleWorldFall(owner, {
        id: 2,
        generation: 0,
        x: 100,
        y: 1500
    }), false);
    assert.equal(owner.avatar.dead, true);
    assert.ok(slot.respawnDeadlines[1] - Date.now() > 2900);
    assert.equal(bot.avatar.dead, false);
    assert.equal(slot.respawnDeadlines[2], undefined);
    slot.initialize();
});

test("custom rooms never schedule or add bots and require two ready humans", () => {
    const slot = new Slot(makeWopw(), "friends-only", "Critter Falls", 4, 60000, 10000, {
        fillPolicy: "human_only"
    });
    const first = human(1);
    const second = human(2);
    first.player.status = "ready";
    second.player.status = "not_ready";
    slot.addClient(first);
    slot.addClient(second);
    assert.equal(slot.botFillScheduled, false);
    slot.fillWithBots();
    assert.equal(slot.getPlayerCount(), 2);
    slot.checkGame();
    assert.equal(slot.status, "idle");
    second.player.status = "ready";
    slot.checkGame();
    assert.equal(slot.status, "starting");
    slot.initialize();
});

test("bot profiles use unique Turkey names, weighted valid levels and matching XP thresholds", () => {
    const slot = new Slot(makeWopw(), "turkiye-bots", "Critter Falls", 6, 60000, 10000);
    slot.addClient(human(1));
    slot.fillWithBots();
    const bots = Object.values(slot.clients).filter((client) => client.isBot);
    assert.equal(new Set(bots.map((bot) => bot.player.dname)).size, bots.length);
    for (const bot of bots) {
        assert.match(bot.player.dname, /^[A-Za-z0-9-]+$/);
        assert.ok(bot.player.level >= 1 && bot.player.level <= 100);
        assert.equal(bot.player.xp, (bot.player.level - 1) * 100);
        assert.ok(bot.player.ownedPets["1"].accessories.length >= 1);
        assert.ok(bot.player.ownedPets["1"].accessories.length <= 4);
    }
    slot.initialize();
});

test("legacy synchronization cannot move or kill a renderer-owned bot", () => {
    const slot = new Slot(makeWopw(), "bot-sync-authority", "Critter Falls", 2, 60000, 10000);
    const owner = human(1);
    const bot = { isBot: true, player: { id: 2 }, avatar: { X: 100, Y: 100, hp: 100, dead: false, properties: { hp: 100 }, setPosition(x, y) { this.X = x; this.Y = y; } }, isDead() { return this.avatar.dead; }, sendPacket() {} };
    slot.clients = { 1: owner, 2: bot };
    slot.updateGameStatus("running");
    owner.getGame = () => slot;
    new Handler({}).handleSynch(owner, {
        timeLoop: {},
        avatarList: [{ player: 2, X: Utils.intToString(100), Y: Utils.intToString(1500) }]
    });
    assert.equal(bot.avatar.dead, false);
    assert.equal(bot.avatar.Y, 100);
    slot.initialize();
});

test("server physics never advances renderer-owned avatars", () => {
    const slot = new Slot(makeWopw(), "no-double-avatar-physics", "Critter Falls", 2, 60000, 10000);
    const owner = human(1);
    const bot = human(2);
    let steps = 0;
    bot.avatar.type = "avatar";
    bot.avatar.step = () => { steps++; };
    bot.avatar.move = () => { steps++; };
    slot.clients = { 1: owner, 2: bot };
    slot.physicsObjects = [bot.avatar];
    slot.updateGameStatus("running");
    slot.update();
    assert.equal(steps, 0);
    assert.equal(bot.avatar.dead, false);
    slot.initialize();
});

test("terrain mutation wakes an unsupported bot and stops air walking", () => {
    const slot = new Slot(makeWopw(), "bot-terrain-watchdog", "Critter Falls", 2, 60000, 10000);
    const owner = human(1);
    let stopped = 0;
    const bot = {
        isBot: true,
        player: { id: 2 },
        avatar: {
            X: 300,
            Y: 40,
            Vx: 0,
            Vy: 0,
            dead: false,
            isWalkingLeft: true,
            properties: { hp: 100 },
            stopWalking() {
                stopped++;
                this.isWalkingLeft = false;
                this.isWalkingRight = false;
            }
        },
        isDead() { return this.avatar.dead; },
        sendPacket() {}
    };
    slot.clients = { 1: owner, 2: bot };
    slot.updateGameStatus("running");
    installFlatTerrain(slot, 180);
    slot.reconcileBotsAfterTerrainMutation();
    assert.equal(stopped, 1);
    assert.ok(bot.avatar.Vy >= 0.02);
    assert.equal(bot._unsupportedTicks, 1);
    slot.initialize();
});

test("world-state snapshots carry canonical health, position, life and terrain revisions", () => {
    const slot = new Slot(makeWopw(), "world-state", "Critter Falls", 2, 60000, 10000);
    const first = human(1);
    const second = human(2);
    first.avatar.setPosition = function(x, y) { this.X = x; this.Y = y; };
    second.avatar.setPosition = function(x, y) { this.X = x; this.Y = y; };
    first.avatar.setPosition(220, 110);
    second.avatar.setPosition(640, 140);
    second.avatar.dead = true;
    first.positionRevision = 7;
    first.respawnGeneration = 2;
    second.respawnGeneration = 1;
    slot.clients = { 1: first, 2: second };
    slot.updateGameStatus("running");
    slot.terrainRevision = 3;
    slot.field.explosionRecord = [[
        Utils.intToString(400),
        Utils.intToString(300),
        Utils.intToString(80)
    ]];
    const packets = [];
    slot.sendPacket = (packet) => packets.push(packet);
    slot.sendWorldState(true);
    const snapshot = packets.at(-1);
    assert.equal(snapshot.command, "world_state");
    assert.equal(snapshot.terrainRevision, 3);
    assert.deepEqual(snapshot.terrain, [[400, 300, 80]]);
    assert.equal(snapshot.players.find((player) => player.id === 1).positionRevision, 7);
    assert.equal(snapshot.players.find((player) => player.id === 1).generation, 2);
    assert.equal(snapshot.players.find((player) => player.id === 2).dead, true);
    assert.equal(snapshot.players.find((player) => player.id === 2).hp, 0);
    slot.initialize();
});

test("MIRV keeps its turn watchdog open long enough for the falling children", () => {
    const wopw = makeWopw();
    wopw.DEFAULT_TIME_AFTER_WEAPON = 400;
    wopw.weaponsObj.mirv = {
        type: "mirv",
        baseType: "null",
        timeout: 2000,
        timeAfter: 4000
    };
    const handler = new Handler(wopw);
    let deadline = 0;
    const game = {
        currentPlayer: 1,
        balancedGame: false,
        petPowerUsage: {},
        setNextTurnFN(value) { deadline = value; },
        markCurrentTurnRespawnShot() {},
        recordProgression() {},
        recordMatchShot() {},
        sendPacketE(packet) { this.lastProjectile = packet; },
        sendWorldState() {},
        sendPacket(packet) { this.lastProjectile = packet; },
        tick: 500,
        turnEpoch: 3,
        gameId: "mirv-relay",
        projectileSequence: 0
    };
    const shooter = human(1);
    shooter.player.userWeaponsOwned = { mirv: 1 };
    shooter.player.unlimitedInventory = true;
    shooter.avatar.alreadyShot = false;
    shooter.avatar.locked = false;
    shooter.avatar.setPosition = function(x, y) { this.X = x; this.Y = y; };
    shooter.getGame = () => game;
    shooter.updatePlayerData = () => {};
    shooter.sendUpdate = () => {};
    handler.handleProjectile(shooter, { ammo_type: "mirv" });
    assert.equal(deadline, 1200);
    assert.equal(game.lastProjectile.tick, 500);
    assert.equal(game.lastProjectile.turnEpoch, 3);
    assert.equal(game.lastProjectile.sourceX, shooter.avatar.X);
    assert.equal(game.lastProjectile.shotId, "mirv-relay:3:1");
});

test("owner position heartbeats reject stale sequences and relay one canonical snapshot", () => {
    const handler = new Handler({});
    const packets = [];
    const game = {
        currentPlayer: 1,
        field: { height: 900 },
        WOPW: { mapsObj: { "Critter Falls": { height: 900 } } },
        mapName: "Critter Falls",
        sendPacketE(packet) { packets.push(packet); }
    };
    const owner = human(1);
    owner.getGame = () => game;
    owner.avatar.dead = false;
    owner.avatar.setPosition = function(x, y) { this.X = x; this.Y = y; };
    handler.handlePosition(owner, {
        id: 1, x: 410, y: 220, vx: 1.5, vy: -2,
        generation: 0, sequence: 2, tick: 100
    });
    handler.handlePosition(owner, {
        id: 1, x: 999, y: 999, generation: 0, sequence: 1, tick: 101
    });
    assert.equal(owner.avatar.X, 410);
    assert.equal(owner.avatar.Y, 220);
    assert.equal(owner.avatar.Vx, 1.5);
    assert.equal(owner.avatar.Vy, -2);
    assert.equal(packets.length, 1);
    assert.equal(packets[0].revision, 1);
});

test("a repeated projectile from a burst weapon cannot block turn completion", () => {
    const handler = new Handler({});
    let nextTurnCalls = 0;
    let changeTurnCalls = 0;
    const game = {
        currentPlayer: 1,
        setNextTurn() { nextTurnCalls++; },
        sendChangeTurn() { changeTurnCalls++; }
    };
    const shooter = {
        player: { id: 1 },
        avatar: { alreadyShot: true, locked: false },
        getGame: () => game
    };

    handler.handleProjectile(shooter, { ammo_type: "multishot" });
    assert.equal(shooter.avatar.locked, false);
    handler.handleTurnComplete(shooter, { command: "turn_complete" });
    assert.equal(nextTurnCalls, 1);
    assert.equal(changeTurnCalls, 1);
});

test("killing two bots in one shot keeps a four-player match running for the survivor", () => {
    const slot = new Slot(makeWopw(), "bot-two-kills", "Critter Falls", 4, 60000, 10000);
    const owner = human(1);
    owner.avatar.locked = false;
    owner.getGame = () => slot;
    const makeBot = (id) => ({
        isBot: true,
        player: { id, dname: `Bot-${id}` },
        avatar: { dead: false, stopWalking() {} },
        isDead() { return this.avatar.dead; },
        sendPacket() {}, sendServerTick() {}, resetTurnChanges() {}, sendGameStats() {}
    });
    const bot2 = makeBot(2);
    const bot3 = makeBot(3);
    const bot4 = makeBot(4);
    slot.clients = { 1: owner, 2: bot2, 3: bot3, 4: bot4 };
    slot.currentPlayer = 1;
    slot.updateGameStatus("running");
    slot.setPlayerDead(2);
    slot.setPlayerDead(3);

    const handler = new Handler({});
    handler.handleTurnComplete(owner, { command: "turn_complete" });
    assert.equal(slot.status, "running");
    assert.equal(parseInt(slot.currentPlayer), 4);
    assert.deepEqual(slot.getAlivePlayerIds(), [1, 4]);
    slot.initialize();
});

test("bot controller emits the existing aim, fire, projectile protocol sequence", () => {
    const wopw = makeWopw();
    const actions = [];
    wopw.packetHandler = {
        handleEquip: (_bot, packet) => actions.push(packet),
        handleSetAim: (_bot, packet) => actions.push(packet),
        handleStartFire: (_bot, packet) => actions.push(packet),
        handleProjectile: (bot, packet) => { actions.push(packet); bot.avatar.alreadyShot = true; },
        handleMoveLeft() {}, handleMoveRight() {}, handleMoveStop() {}, handleMoveJump() {},
        handleTurnComplete: (_bot, packet) => actions.push(packet.command)
    };
    const slot = new Slot(wopw, "bot-actions", "Critter Falls", 2, 60000, 10000);
    slot.addClient(human(1));
    slot.fillWithBots();
    slot.updateGameStatus("running");
    const bot = Object.values(slot.clients).find((client) => client.isBot);
    slot.currentPlayer = bot.player.id;
    const controller = new BotController(slot);
    controller.state = { bot, phase: "equip", dueAt: 0, expiresAt: Date.now() + 1000, angle: 0, power: "200", weapon: "mortar" };
    for (let index = 0; index < 20 && !actions.some((packet) => packet.command === "projectile"); index++) {
        controller.state.dueAt = 0;
        controller.update();
    }
    const commands = actions.map((packet) => packet.command);
    assert.equal(commands[0], "equip");
    assert.ok(commands.includes("set_aim"));
    assert.equal(commands.at(-1), "projectile");
    assert.ok(actions.every((packet) => packet.id === bot.player.id));
    assert.ok(actions.every((packet) => packet.d === undefined));
    slot.initialize();
});

test("bot movement does not send stale server coordinates into destructible client terrain", () => {
    const wopw = makeWopw();
    const moves = [];
    wopw.packetHandler = {
        handleMoveLeft: (_bot, packet) => moves.push(packet),
        handleMoveRight: (_bot, packet) => moves.push(packet)
    };
    const slot = new Slot(wopw, "bot-client-physics", "Critter Falls", 2, 60000, 10000);
    const bot = { isBot: true, player: { id: 2 }, avatar: { X: 100, Y: 100 } };
    new BotController(slot).sendMove(bot, 1);
    assert.equal(moves.length, 1);
    assert.equal(moves[0].command, "move_right");
    assert.equal(moves[0].d, undefined);
    slot.initialize();
});

test("native SWF bot AI disables the server-side fallback controller", () => {
    const slot = new Slot(makeWopw(), "bot-native-ai", "Critter Falls", 2, 60000, 10000);
    let fallbackUpdates = 0;
    slot.checkGame = () => {};
    slot.updateGameStatus("running");
    slot.nativeBotAI = true;
    slot.botController.update = () => { fallbackUpdates++; };
    slot.update();
    assert.equal(fallbackUpdates, 0);
    slot.initialize();
});

test("only the active native bot can be completed by its human renderer", () => {
    const handler = new Handler({});
    let completed = 0;
    handler.handleTurnComplete = (actor) => { completed += actor.player.id === 2 ? 1 : 100; };
    const bot = { isBot: true, player: { id: 2 } };
    const game = {
        currentPlayer: 2,
        clients: { 2: bot },
        nativeBotAI: true,
        nativeBotTimeouts: 0,
        getBotRendererId: () => 1
    };
    const renderer = { isBot: false, player: { id: 1 }, getGame: () => game };
    handler.handleBotTurnComplete(renderer, { id: 2 });
    handler.handleBotTurnComplete(renderer, { id: 3 });
    assert.equal(completed, 1);
});

test("bot controller uses minigun rather than a point-blank explosive shot", () => {
    const slot = new Slot(makeWopw(), "bot-safe-shot", "Critter Falls", 2, 60000, 10000);
    const bot = { isBot: true, player: { id: 2, userWeaponsEquipped: ["minigun", "mortar"] }, avatar: { X: 100, Y: 100, maxFPDistance: 900 }, isDead: () => false };
    const owner = human(1);
    owner.avatar.X = 250;
    owner.avatar.Y = 100;
    slot.clients = { 1: owner, 2: bot };
    const controller = new BotController(slot);
    assert.equal(controller.begin(bot, Date.now()).weapon, "minigun");
    slot.initialize();
});

test("bot controller may use an explosive only at a safe long range", () => {
    const slot = new Slot(makeWopw(), "bot-safe-long-shot", "Critter Falls", 2, 60000, 10000);
    const bot = { isBot: true, player: { id: 2, userWeaponsEquipped: ["minigun", "mortar"] }, avatar: { X: 100, Y: 100, maxFPDistance: 900 }, isDead: () => false };
    const owner = human(1);
    owner.avatar.X = 1000;
    owner.avatar.Y = 100;
    slot.clients = { 1: owner, 2: bot };
    const controller = new BotController(slot);
    assert.equal(controller.begin(bot, Date.now()).weapon, "mortar");
    slot.initialize();
});

test("bot turn completion tolerates string ids created by object-key rotation", () => {
    const wopw = makeWopw();
    let completed = 0;
    wopw.packetHandler.handleTurnComplete = () => { completed++; };
    const slot = new Slot(wopw, "bot-string-turn", "Critter Falls", 2, 60000, 10000);
    const bot = { isBot: true, player: { id: 900000001 }, avatar: { dead: false }, isDead: () => false };
    slot.currentPlayer = "900000001";
    new BotController(slot).finishTurn(bot);
    assert.equal(completed, 1);
    slot.initialize();
});

test("alive count follows avatar death state even if a legacy death list is stale", () => {
    const slot = new Slot(makeWopw(), "bot-authoritative-alive", "Critter Falls", 2, 60000, 10000);
    const owner = human(1);
    const bot = { isBot: true, player: { id: 2 }, avatar: { dead: true }, isDead() { return this.avatar.dead; } };
    slot.clients = { 1: owner, 2: bot };
    slot.deadPlayers = [];
    assert.equal(slot.countPlayersAlive(), 1);
    slot.initialize();
});

test("authoritative damage packet marks a killed bot and pays the human shooter once", () => {
    const game = {
        currentPlayer: 1,
        isRunning: () => true,
        clients: {},
        scores: {},
        setPlayerDead(id, killerId) {
            const victim = this.clients[id];
            if(victim.isDead()) return false;
            victim.avatar.dead = true;
            this.scores[killerId] = (this.scores[killerId] || 0) + 1;
            const killer = this.clients[killerId];
            killer.addXP(15);
            killer.addGold(5, true);
            return true;
        }
    };
    const bot = { isBot: true, avatar: { hp: 40, dead: false }, isDead() { return this.avatar.dead; } };
    let xp = 0;
    let gold = 0;
    const shooter = {
        isBot: false,
        player: { id: 1 },
        getGame: () => game,
        addXP: (value) => { xp += value; },
        addGold: (value) => { gold += value; }
    };
    game.clients = { 1: shooter, 2: bot };
    const handler = new Handler({});
    handler.handleDamage(shooter, { from: "1", to: "2", value: "40", died: "true" });
    handler.handleDamage(shooter, { from: "1", to: "2", value: "40", died: "true" });
    assert.equal(bot.isDead(), true);
    assert.equal(xp, 15);
    assert.equal(gold, 5);
    assert.equal(game.scores[1], 1);
});

test("the five-minute limit ranks players by kills and ends exactly once", async () => {
    const slot = new Slot(makeWopw(), "timed-score", "Critter Falls", 2, 300000, 20000);
    const first = human(1);
    const second = human(2);
    const packets = [];
    first.sendGameStats = (order) => packets.push(order);
    second.sendGameStats = () => {};
    slot.clients = { 1: first, 2: second };
    slot.startGame();
    assert.equal(slot.gameDuration, 300000);
    slot.scores = { 1: 2, 2: 4 };
    slot.tick = slot.matchEndTick;
    slot.checkGame();
    assert.equal(slot.status, "gameover");
    await slot.endGamePromise;
    assert.deepEqual(packets[0], [2, 1]);
    slot.checkGame();
    assert.equal(packets.length, 1);
    slot.initialize();
});

test("validated game handshake authenticates all subsequent match commands", async () => {
    const game = {
        isFull: () => false,
        addClient() {},
        stopGameStart() {}
    };
    const client = {
        loggedIn: false,
        gameId: "test-room",
        gameSession: "token",
        db: {
            fetchSession: async () => ({ userId: 1, gameJoinExpiresAt: new Date(Date.now() + 60000) }),
            fetch: async () => ({ id: 1, dname: "Owner" })
        },
        getGame: () => game,
        setupPlayer(doc) { this.player = { id: doc.id }; return 1; },
        sendGamePlayers() {},
        sendToGame() {},
        updateGame() {}
    };
    const handler = new Handler({});
    await handler.handleStartServerConnect(client, { userId: "Owner" });
    assert.equal(client.loggedIn, true);
});

test("game start waits for the human map-load acknowledgement", () => {
    const slot = new Slot(makeWopw(), "bot-map-handshake", "Critter Falls", 2, 60000, 10000);
    const owner = human(1);
    const bot = { isBot: true, player: { id: 2 }, avatar: { dead: false }, isDead() { return this.avatar.dead; }, sendPacket() {} };
    slot.clients = { 1: owner, 2: bot };
    let starts = 0;
    slot.startGame = () => { starts++; slot.updateGameStatus("running"); };
    slot.beginGameStart();
    assert.equal(starts, 0);
    slot.onMapLoaded(owner, slot.mapLoadId);
    assert.equal(starts, 1);
    slot.initialize();
});

test("startGame emits exactly one deterministic start record", () => {
    const slot = new Slot(makeWopw(), "bot-start-single", "Critter Falls", 2, 60000, 10000);
    const packets = [];
    const owner = human(1);
    owner.sendPacket = (packet) => packets.push(packet.command);
    const bot = { isBot: true, player: { id: 2 }, avatar: { X: 300, Y: 100 }, isDead: () => false, sendPacket() {} };
    slot.clients = { 1: owner, 2: bot };
    slot.startGame();
    assert.equal(packets.filter((command) => command === "startGame").length, 1);
    slot.initialize();
});

test("a delayed legacy not-ready cannot reset an active bot match", () => {
    const slot = new Slot(makeWopw(), "bot-ignore-stale-not-ready", "Critter Falls", 2, 60000, 10000);
    slot.updateGameStatus("running");
    slot.stopGameStart();
    assert.equal(slot.status, "running");
    slot.initialize();
});

test("map handshake cannot schedule a second lobby countdown", () => {
    const slot = new Slot(makeWopw(), "bot-single-countdown", "Critter Falls", 2, 60000, 10000);
    slot.clients = {
        1: human(1),
        2: { isBot: true, player: { id: 2 }, avatar: { dead: false }, isDead: () => false, sendPacket() {} }
    };
    slot.updateGameStatus("starting");
    slot.awaitingMapLoad = true;
    slot.startingTimeout = null;
    slot.checkGame();
    assert.equal(slot.startingTimeout, null);
    assert.equal(slot.status, "starting");
    slot.initialize();
});
