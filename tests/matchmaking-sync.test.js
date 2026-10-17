"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Slot = require("../game/slot.js");
const WOPW = require("../game/wopw.js");
const Handler = require("../game/handler.js");

const positions = [[100, 100], [300, 100], [500, 100], [700, 100], [900, 100], [1100, 100]];

function makeWopw() {
    return {
        mapsObj: { "Critter Falls": { name: "Critter Falls", positions } },
        petsObj: { rabbit: { hp: 100, size: 20, bounce: 0.2, jump: 0.25, speed: 0.004 } },
        levelsObj: Array.from({ length: 101 }, (_, index) => ({ xp: index * 100 })),
        accessoriesObj: {},
        weaponsObj: { mortar: { type: "mortar", timeAfter: 100 } },
        getLobbyLoad: () => 0,
        packetHandler: {}
    };
}

function human(id) {
    const packets = [];
    return {
        connectionType: "game",
        packets,
        player: { id, dname: "Player" + id, status: "playing" },
        avatar: { X: 0, Y: 0, dead: false, alreadyShot: false, properties: { hp: 100 }, stopWalking() {} },
        isDead() { return this.avatar.dead; },
        sendPacket(packet) { packets.push(packet); },
        sendServerTick() {},
        resetTurnChanges() {},
        addXP() {},
        addGold() {},
        sendGameStats() {}
    };
}

function makeMatchmaker() {
    const wopw = Object.create(WOPW.prototype);
    wopw.slots = {};
    wopw.mapsObj = makeWopw().mapsObj;
    wopw.config = { gameTimes: [5, 10], turnTimes: [10, 20, 30], maxPlayers: [2, 4, 6], maxSlots: 10 };
    const shared = makeWopw();
    wopw.createSlot = function (gameId, mapName, playerCount, gameDuration, turnDuration, rules) {
        this.slots[gameId] = new Slot(Object.assign(shared, { slots: this.slots }), gameId, mapName, playerCount, gameDuration, turnDuration, rules);
        return this.slots[gameId];
    };
    return wopw;
}

function quickPlay(wopw, playerId, overrides = {}) {
    const data = Object.assign({ mapName: "Critter Falls", playerCount: 4, gameDuration: 5, turnDuration: 10, nu: 0, te: false, ba: false, wi: false }, overrides);
    const details = wopw.validateMapDetails({}, data);
    const gameId = wopw.findSlot({}, details, null);
    if (gameId) wopw.reserveSeat(gameId, playerId);
    return gameId;
}

test("a reserved seat survives the bot-fill deadline until the player's socket arrives", () => {
    const wopw = makeMatchmaker();
    const room = quickPlay(wopw, 1);
    const slot = wopw.slots[room];
    slot.addClient(human(1));
    assert.equal(quickPlay(wopw, 2), room, "the second quick-play player is routed to the waiting room");
    assert.equal(slot.getReservedSeatCount(), 1);

    slot.fillWithBots();
    assert.equal(slot.getPlayerCount(), 1, "bots must not take a seat that is still reserved");

    slot.botFillFirstHumanAt = Date.now() - 30000;
    slot.fillWithBots();
    assert.equal(slot.getPlayerCount() + slot.getReservedSeatCount(), 4, "after the grace bots fill only free seats");
    assert.equal(slot.canAdmit(2), true, "the reserved player still has a seat");
    assert.notEqual(slot.addClient(human(2)), false);
    assert.equal(slot.clients[2] !== undefined, true);
    assert.equal(slot.getReservedSeatCount(), 0);
    slot.initialize();
});

test("reservations expire and never overbook a room", () => {
    const wopw = makeMatchmaker();
    const room = quickPlay(wopw, 1, { playerCount: 2 });
    const slot = wopw.slots[room];
    assert.equal(slot.reserveSeat(2), true);
    assert.equal(slot.reserveSeat(3), false, "a two-seat room cannot hold three reservations");
    assert.equal(slot.isFull(), true);
    slot.seatReservations["1"] = Date.now() - 1;
    assert.equal(slot.isFull(), false);
    slot.initialize();
});

test("'any' settings join an existing waiting room instead of rolling a new key", () => {
    const wopw = makeMatchmaker();
    const room = quickPlay(wopw, 1, { gameDuration: 10, turnDuration: 30 });
    wopw.slots[room].addClient(human(1));
    assert.equal(quickPlay(wopw, 2, { gameDuration: 0, turnDuration: 0, playerCount: 0 }), room);
    wopw.slots[room].initialize();
});

test("failed-start and map-loading rooms are never handed to new players and recycle", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const wopw = makeMatchmaker();
    const room = quickPlay(wopw, 1);
    const slot = wopw.slots[room];
    slot.addClient(human(1));

    slot.awaitingMapLoad = true;
    assert.equal(wopw.isJoinable(slot), false);
    assert.notEqual(quickPlay(wopw, 9), room);
    slot.awaitingMapLoad = false;

    slot.failMapLoad("map_asset_error");
    assert.equal(slot.status, "start_error");
    assert.equal(wopw.isJoinable(slot), false);
    slot.checkGame();
    assert.equal(slot.status, "start_error", "a terminal room is not silently idled");
    t.mock.timers.tick(3100);
    assert.equal(slot.status, "idle");
    assert.equal(slot.getPlayerCount(), 0);
    slot.initialize();
});

test("one late renderer is dropped at the map-load timeout instead of failing the room", () => {
    const slot = new Slot(makeWopw(), "late-renderer", "Critter Falls", 4, 60000, 10000);
    const owner = human(1);
    const late = human(2);
    slot.addClient(owner);
    slot.addClient(late);
    let started = 0;
    slot.startGame = () => { started++; slot.updateGameStatus("running"); return true; };
    slot.updateGameStatus("starting");
    slot.beginGameStart();
    assert.equal(slot.getPlayerCount(), 4, "open seats are bot-filled before the roster is committed");
    slot.onMapLoaded(owner, slot.mapLoadId);
    assert.equal(started, 0);
    slot.handleMapLoadTimeout();
    assert.equal(started, 1);
    assert.equal(slot.clients[2], undefined);
    assert.equal(late.packets.at(-1).command, "game_start_failed");
    assert.equal(late.packets.at(-1).code, "map_timeout");
    slot.initialize();
});

test("dying after firing ends the turn on the shot deadline; dying before shooting holds briefly", () => {
    const slot = new Slot(makeWopw(), "death-hold", "Critter Falls", 2, 60000, 30000);
    const owner = human(1);
    const other = human(2);
    slot.clients = { 1: owner, 2: other };
    slot.updateGameStatus("running");
    slot.currentPlayer = 1;
    slot.tick = 1000;
    slot.setNextTurn(0);
    assert.equal(slot.turnHardEndTick, 4000);

    owner.avatar.alreadyShot = true;
    slot.setNextTurnFN(250);
    assert.equal(slot.holdCurrentTurnThroughRespawn(owner), false);
    assert.equal(slot.turnEndTick, 1250, "the shot deadline is kept");

    owner.avatar.alreadyShot = false;
    slot.setNextTurn(0);
    assert.equal(slot.holdCurrentTurnThroughRespawn(owner), true);
    assert.ok(slot.turnEndTick < slot.turnHardEndTick, "the rest of a 30 s turn is not held");
    assert.ok(slot.turnEndTick - slot.tick >= 450, "respawn plus a short action window remains");
    slot.initialize();
});

test("a silent renderer loses its turn and is skipped in the rotation", () => {
    const slot = new Slot(makeWopw(), "stale-renderer", "Critter Falls", 2, 60000, 30000);
    const owner = human(1);
    const other = human(2);
    owner.lastMessageTime = Date.now() - 25000;
    other.lastMessageTime = Date.now();
    assert.equal(slot.isTurnEligible(owner), false);
    assert.equal(slot.isTurnEligible(other), true);
    owner.lastMessageTime = Date.now();
    assert.equal(slot.isTurnEligible(owner), true);
    slot.initialize();
});

test("turn changes broadcast the server turn clock to every renderer", () => {
    const slot = new Slot(makeWopw(), "turn-clock", "Critter Falls", 2, 60000, 10000);
    const owner = human(1);
    const other = human(2);
    slot.clients = { 1: owner, 2: other };
    slot.updateGameStatus("running");
    slot.currentPlayer = 1;
    slot.setNextTurn(50);
    slot.sendChangeTurn();
    for (const client of [owner, other]) {
        assert.ok(client.packets.some((packet) => packet.command === "set_tick"), `player ${client.player.id}`);
    }
    slot.initialize();
});

test("health reports from a renderer trailing by a few turns are still applied", () => {
    const handler = new Handler({});
    const applied = [];
    const target = { isBot: false, player: { id: 2 } };
    const game = {
        turnEpoch: 10,
        clients: { 2: target },
        isRunning: () => true,
        applyHealthState: (...args) => { applied.push(args); return { accepted: true }; }
    };
    const reporter = { player: { id: 2 }, getGame: () => game };
    handler.handleHealthState(reporter, { id: 2, hp: 40, turnEpoch: 8, generation: 0, seq: 1 });
    handler.handleHealthState(reporter, { id: 2, hp: 30, turnEpoch: 5, generation: 0, seq: 2 });
    assert.equal(applied.length, 1);
    assert.equal(applied[0][2], 40);
});

test("match commands for a recycled room are ignored instead of disconnecting", () => {
    const handler = new Handler({});
    const client = { loggedIn: true, player: { id: 1 }, getGame: () => null, sendPacket() {} };
    assert.doesNotThrow(() => handler.handleGameCommand(client, { command: "synch_check" }));
    assert.doesNotThrow(() => handler.handleGameCommand(client, { command: "move_left" }));
    assert.doesNotThrow(() => handler.handleGameCommand(client, { command: "request_synch", pid: 5 }));
});

test("the lobby's Any map card resolves to a waiting room's map or a verified map", () => {
    const wopw = makeMatchmaker();
    wopw.mapManifest = { names: ["Critter Falls"] };
    const first = wopw.validateMapDetails({}, { mapName: "Any", playerCount: 4, gameDuration: 5, turnDuration: 10 });
    assert.equal(first.mapError, undefined);
    assert.equal(first.mapName, "Critter Falls");
    assert.equal(first.anyMap, true);
    const room = quickPlay(wopw, 1);
    wopw.slots[room].addClient(human(1));
    const details = wopw.validateMapDetails({}, { mapName: "", playerCount: 0, gameDuration: 0, turnDuration: 0, nu: 0, te: false, ba: false, wi: false });
    assert.equal(wopw.findSlot({}, details, null), room, "an Any request joins the waiting player");
    wopw.slots[room].initialize();
});
