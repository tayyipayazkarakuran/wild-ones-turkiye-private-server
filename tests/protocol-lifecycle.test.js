"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Handler = require("../game/handler.js");
const WOPW = require("../game/wopw.js");
const Field = require("../game/field.js");

function frame(packet){
    const body = Buffer.from(JSON.stringify(packet), "utf8");
    const length = Buffer.from(String(body.length).padStart(6, "0"), "ascii");
    return Buffer.concat([length, body]);
}

function fakeSocket(){
    return {
        writable: true,
        writableEnded: false,
        destroyed: false,
        closeCalls: 0,
        destroySoon(){
            this.closeCalls++;
            this.destroyed = true;
        }
    };
}

function bareWopw(){
    const wopw = Object.create(WOPW.prototype);
    wopw.lobbyClients = {};
    wopw.ladderClients = {};
    wopw.slots = {};
    return wopw;
}

test("commands from one TCP chunk wait for the preceding async game login", async () => {
    const handler = new Handler({});
    const socket = fakeSocket();
    const client = {
        connectionType: "game",
        loggedIn: false,
        sock: socket,
        _protocolBuffer: Buffer.alloc(0),
        lastMessageTime: 0
    };
    const events = [];

    handler.handleStartServerConnect = async (target) => {
        events.push("login:start");
        await Promise.resolve();
        target.loggedIn = true;
        events.push("login:complete");
    };
    handler.handleOnReady = (target) => events.push("ready:" + target.loggedIn);
    handler.handleMapLoad = (target) => events.push("map_loaded:" + target.loggedIn);

    handler.handle(client, Buffer.concat([
        frame({ command: "start_server_connect" }),
        frame({ command: "on_ready" }),
        frame({ command: "map_loaded" })
    ]));
    await socket._packetDispatchQueue;

    assert.deepEqual(events, [
        "login:start",
        "login:complete",
        "ready:true",
        "map_loaded:true"
    ]);
});

test("a rejected async command is logged, closes its socket, and cancels queued commands", async () => {
    const handler = new Handler({});
    const socket = fakeSocket();
    const client = {
        id: "client-1",
        connectionType: "game",
        loggedIn: false,
        sock: socket,
        _protocolBuffer: Buffer.alloc(0),
        lastMessageTime: 0
    };
    const protocolErrors = [];
    let readyCalls = 0;
    const originalError = console.error;

    handler.handleStartServerConnect = async () => {
        throw new Error("database unavailable");
    };
    handler.handleOnReady = () => { readyCalls++; };
    console.error = (...args) => protocolErrors.push(args);
    try {
        handler.handle(client, Buffer.concat([
            frame({ command: "start_server_connect" }),
            frame({ command: "on_ready" })
        ]));
        await socket._packetDispatchQueue;
    } finally {
        console.error = originalError;
    }

    assert.equal(readyCalls, 0);
    assert.equal(socket.closeCalls, 1);
    assert.equal(socket._protocolFailed, true);
    assert.equal(protocolErrors.length, 1);
    assert.equal(protocolErrors[0][0], "protocol_error");
    assert.equal(protocolErrors[0][1].command, "start_server_connect");
    assert.equal(protocolErrors[0][1].message, "database unavailable");
});

test("an old same-id socket cannot remove a newer registered client", () => {
    const wopw = bareWopw();
    const oldLobby = { connectionType: "lobby", sock: { id: "same-id" } };
    const newLobby = { connectionType: "lobby", sock: { id: "same-id" } };
    wopw.lobbyClients["same-id"] = newLobby;

    assert.equal(wopw.removeClientObj(oldLobby), false);
    assert.equal(wopw.lobbyClients["same-id"], newLobby);

    let removeCalls = 0;
    const oldGame = { connectionType: "game", gameId: "room", player: { id: 7 }, sock: { id: "old" } };
    const newGame = { connectionType: "game", gameId: "room", player: { id: 7 }, sock: { id: "new" } };
    const slot = {
        clients: { 7: newGame },
        removeClient(target){
            removeCalls++;
            delete this.clients[target.player.id];
        }
    };
    wopw.slots.room = slot;

    assert.equal(wopw.removeClientObj(oldGame), false);
    assert.equal(slot.clients[7], newGame);
    assert.equal(removeCalls, 0);
    assert.equal(wopw.removeClientObj(newGame), true);
    assert.equal(removeCalls, 1);
});

test("an uninitialized TCP health probe disconnect is ignored without logging", () => {
    const wopw = bareWopw();
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args);
    try {
        assert.equal(wopw.removeClientObj({
            connectionType: "abstract",
            sock: { id: "health-probe" }
        }), false);
    } finally {
        console.log = originalLog;
    }
    assert.deepEqual(logs, []);
});

test("the automatic medal initialization never opens the medal modal", () => {
    const handler = new Handler({});
    const packets = [];
    const client = {
        connectionType: "lobby",
        loggedIn: true,
        player: { id: 42 },
        sendPacket(packet){ packets.push(packet); }
    };

    handler.handleLobbyCommand(client, { command: "get_medals" });

    assert.deepEqual(packets, [{
        command: "medal_init",
        medalList: {},
        medalCounts: {},
        newItems: [],
        totalMedals: 0,
        guid: "42",
        playerGuid: "42",
        version: 1
    }]);

    handler.handleLobbyCommand(client, { command: "get_medals" });
    assert.equal(packets[1].command, "medal_info");
    assert.deepEqual(packets[1].medalList, {});
});

test("v26 map readiness accepts protocol 3-4 and is bound to the current load generation", async () => {
    const handler = new Handler({});
    const acknowledgements = [];
    let maskLoads = 0;
    const game = {
        gameId: "protocol-map",
        mapName: "Critter Falls",
        mapLoadId: "protocol-map:7",
        field: { loadMapMask: async () => { maskLoads++; } },
        onMapLoaded(client, loadId) {
            acknowledgements.push([client.player.id, loadId]);
            return true;
        },
        failMapLoad() { throw new Error("unexpected map failure"); }
    };
    const client = { isBot: false, player: { id: 1 }, getGame: () => game };

    assert.equal(await handler.handleMapLoad(client, {
        command: "map_loaded", protocol: 3, value: true, map: "Critter Falls", loadId: "stale"
    }), false);
    assert.equal(maskLoads, 0);
    assert.deepEqual(acknowledgements, []);

    assert.equal(await handler.handleMapLoad(client, {
        command: "map_loaded", protocol: 2, value: true, map: "Critter Falls", loadId: "protocol-map:7"
    }), false);
    assert.equal(maskLoads, 0);

    assert.equal(await handler.handleMapLoad(client, {
        command: "map_loaded", protocol: 4, value: true, map: "Critter Falls", loadId: "protocol-map:7"
    }), true);
    assert.equal(maskLoads, 1);
    assert.deepEqual(acknowledgements, [[1, "protocol-map:7"]]);
});

test("a current terrain explosion reaches the authoritative mask once and coalesces bot physics refresh", () => {
    const handler = new Handler({});
    const game = {
        turnEpoch: 12,
        field: new Field({}),
        isRunning: () => true,
        botRefreshes: [],
        sendBotState(force) { this.botRefreshes.push(force); }
    };
    const client = { isBot: false, player: { id: 1 }, getGame: () => game };
    const packet = { x: 500, y: 420, r: 70, turnEpoch: 12 };

    assert.equal(handler.handleTerrainExplosion(client, packet), true);
    assert.equal(handler.handleTerrainExplosion(client, packet), false, "duplicate crater must be idempotent");
    assert.equal(game.field.explosionRecord.length, 1);
    assert.deepEqual(game.botRefreshes, [false]);
    assert.equal(handler.handleTerrainExplosion(client, { ...packet, turnEpoch: 10 }), false);
});

test("the authoritative crater turns solid collision pixels transparent", () => {
    const field = new Field({});
    const pixels = new Uint32Array(32 * 32);
    pixels.fill(0xffffffff);
    field.bitmapData = {
        getPixelColor(x, y) { return pixels[(y * 32) + x]; },
        setPixelColor(value, x, y) { pixels[(y * 32) + x] = value; }
    };
    field.width = 32;
    field.height = 32;
    assert.equal(field.checkFieldCollisionPoint(16, 16), true);
    field.explode(16, 16, 5);
    assert.equal(field.checkFieldCollisionPoint(16, 16), false);
    assert.equal(field.checkFieldCollisionPoint(0, 0), true);
});
