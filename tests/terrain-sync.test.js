"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Slot = require("../game/slot.js");
const Field = require("../game/field.js");
const Handler = require("../game/handler.js");
const Utils = require("../game/helpers/utils.js");

const hex = (value) => Utils.intToString(value);
const crater = (x, y, r, type) => type ? [hex(x), hex(y), hex(r), type] : [hex(x), hex(y), hex(r)];

function makeWopw() {
    return {
        mapsObj: { "Critter Falls": { positions: [[100, 100, 1000, 100], [300, 100], [500, 100], [700, 100]] } },
        petsObj: { rabbit: { hp: 100, size: 40, bounce: 0.2, jump: 0.25, speed: 0.004 } },
        levelsObj: Array.from({ length: 101 }, (_, index) => ({ xp: index * 100 })),
        accessoriesObj: {},
        weaponsObj: { mortar: { type: "mortar", R1: 20, R2: 60, Rdirt: 50, damage: 40, impulse: 0.002 } },
        getLobbyLoad: () => 0,
        packetHandler: {}
    };
}

function human(id) {
    const packets = [];
    return {
        connectionType: "game",
        packets,
        player: { id, dname: "P" + id, status: "playing" },
        avatar: { X: 0, Y: 0, dead: false, properties: { hp: 100 }, stopWalking() {} },
        isDead() { return this.avatar.dead; },
        sendPacket(packet) { packets.push(packet); },
        sendServerTick() {}, resetTurnChanges() {}, addXP() {}, addGold() {}, sendGameStats() {}
    };
}

// A real RGBA buffer so carving and collision use the production code path.
function installMask(slot, width = 1200, height = 500, groundY = 300) {
    const data = Buffer.alloc(width * height * 4);
    for (let y = groundY; y < height; y++) data.fill(255, (y * width) * 4, ((y + 1) * width) * 4);
    slot.field.width = width;
    slot.field.height = height;
    slot.field.bitmapData = {
        bitmap: { data },
        getPixelColor(x, y) {
            x = Math.floor(x); y = Math.floor(y);
            return data[(y * width + x) * 4 + 3];
        }
    };
}

function runningSlot(name) {
    const slot = new Slot(makeWopw(), name, "Critter Falls", 4, 60000, 10000);
    installMask(slot);
    slot.updateGameStatus("running");
    slot.matchId = name + ":match-2";
    return slot;
}

test("world_state names the match, not the reused room, so a second match is not ignored", () => {
    const slot = runningSlot("reused-room");
    const owner = human(1);
    slot.clients = { 1: owner };
    slot.sendWorldState(true);
    const packet = owner.packets.find((entry) => entry.command === "world_state");
    assert.equal(packet.gameId, "reused-room:match-2");
    slot.initialize();
});

test("terrain is sent as a delta from the last broadcast revision with periodic full lists", () => {
    const slot = runningSlot("terrain-delta");
    const owner = human(1);
    slot.clients = { 1: owner };
    slot.sendWorldState(true);
    slot.applyTerrainMutation([crater(200, 300, 30), crater(600, 300, 30)]);
    slot.sendWorldState(true);
    let packet = owner.packets.filter((entry) => entry.command === "world_state").at(-1);
    assert.equal(packet.terrainRevision, 1);
    assert.equal(packet.terrainFrom, 0);
    assert.equal(packet.terrain.length, 2);

    slot.applyTerrainMutation([crater(900, 300, 30)]);
    slot.sendWorldState(true);
    packet = owner.packets.filter((entry) => entry.command === "world_state").at(-1);
    assert.equal(packet.terrainFrom, 1);
    assert.deepEqual(packet.terrain, [[900, 300, 30]]);

    slot.sendWorldState(true);
    packet = owner.packets.filter((entry) => entry.command === "world_state").at(-1);
    assert.equal(packet.terrain.length, 0, "unchanged terrain is not resent");

    while (slot.worldStateSequence % 10 !== 9) slot.sendWorldState(true);
    slot.sendWorldState(true);
    packet = owner.packets.filter((entry) => entry.command === "world_state").at(-1);
    assert.equal(packet.terrainFrom, 0);
    assert.equal(packet.terrain.length, 3, "a lagging renderer can recover from the periodic full list");
    slot.initialize();
});

test("the same crater from two renderers, or one inside another, is stored once", () => {
    const field = new Field({ WOPW: makeWopw() });
    field.width = 1200; field.height = 500;
    assert.equal(field.mergeExplosionRecords([crater(400, 300, 50)]), 1);
    assert.equal(field.mergeExplosionRecords([crater(400.0000001, 299.9999999, 50.0000001)]), 0);
    assert.equal(field.mergeExplosionRecords([crater(410, 300, 20)]), 0, "covered by the first crater");
    assert.equal(field.mergeExplosionRecords([crater(460, 300, 30)]), 1);
    assert.equal(field.explosionRecord.length, 2);
});

test("drill-sized histories no longer freeze the server mask at 2048 craters", () => {
    const field = new Field({ WOPW: makeWopw() });
    field.width = 2800; field.height = 1400;
    const records = [];
    for (let i = 0; i < 2100; i++) records.push(crater(20 + (i % 100) * 27, 20 + Math.floor(i / 100) * 60, 12));
    let accepted = 0;
    for (let i = 0; i < records.length; i += 64) accepted += field.mergeExplosionRecords(records.slice(i, i + 64));
    assert.equal(accepted, 2100);
});

test("every terrain path bumps the revision: batches, legacy synch and server digs", () => {
    const slot = runningSlot("terrain-paths");
    const owner = human(1);
    owner.getGame = () => slot;
    slot.clients = { 1: owner };
    slot.turnEpoch = 5;
    const handler = new Handler(slot.WOPW);
    assert.equal(handler.handleTerrainExplosionBatch(owner, { turnEpoch: 3, batchSeq: 1, explosions: [[100, 300, 30, "mortar"]] }), true,
        "late batches from a long effect are kept");
    assert.equal(slot.terrainRevision, 1);
    handler.handleSynch(owner, { timeLoop: {}, avatarList: [], field: { explosions: [crater(700, 300, 30)] } });
    assert.equal(slot.terrainRevision, 2);
    slot.field.explode(1000, 300, 25);
    assert.equal(slot.terrainRevision, 3);
    assert.equal(slot.field.checkFieldCollisionPoint(1000, 305), false);
    slot.initialize();
});

test("explosions reported with a weapon type knock server-simulated bots back", () => {
    const slot = runningSlot("bot-knockback");
    const owner = human(1);
    const bot = {
        isBot: true,
        player: { id: 900000001 },
        avatar: { X: 400, Y: 260, Vx: 0, Vy: 0, dead: false, properties: { hp: 100, impulse: 1 }, stopWalking() {} },
        isDead() { return this.avatar.dead; },
        sendPacket() {}
    };
    slot.clients = { 1: owner, 900000001: bot };
    slot.applyTerrainMutation([crater(370, 290, 50, "mortar")]);
    assert.ok(bot.avatar.Vx > 0, "pushed away from the blast horizontally");
    assert.ok(bot.avatar.Vy < 0, "pushed up out of the crater");
    const before = bot.avatar.Vx;
    slot.applyTerrainMutation([crater(370, 290, 50, "mortar")]);
    assert.equal(bot.avatar.Vx, before, "a duplicate report does not push twice");
    slot.initialize();
});

test("live support is measured at the pet's feet", () => {
    const slot = runningSlot("support-feet");
    const resting = { avatar: { X: 400, Y: 260, boundRadius: 40 } };
    assert.equal(slot.hasLiveSupport(resting), true);
    slot.field.mergeExplosionRecords([crater(400, 300, 60)]);
    assert.equal(slot.hasLiveSupport(resting), false);
    slot.initialize();
});

test("collision outside the mask is open air instead of a clamped edge pixel", () => {
    const slot = runningSlot("mask-edges");
    assert.equal(slot.field.checkFieldCollisionPoint(1199, 400), true);
    assert.equal(slot.field.checkFieldCollisionPoint(1200, 400), false);
    assert.equal(slot.field.checkFieldCollisionPoint(500, 500), false);
    slot.initialize();
});

test("a crater elsewhere does not relocate an unacknowledged respawn", () => {
    const slot = runningSlot("respawn-rebase");
    const owner = human(1);
    const target = human(2);
    target.avatar.dead = true;
    slot.clients = { 1: owner, 2: target };
    assert.equal(slot.respawnPlayer(2), true);
    const state = slot.respawnAckStates[2];
    assert.ok(state);
    const far = state.packet.x > 600 ? 100 : 1100;
    slot.applyTerrainMutation([crater(far, 300, 20)]);
    slot.processRespawnAcks();
    assert.ok(slot.respawnAckStates[2], "the pending respawn survives");
    assert.equal(target.avatar.dead, false);
    assert.equal(slot.acknowledgeRespawn(1, 2, state.packet.generation, state.packet.respawnToken,
        state.packet.x, state.packet.y, true, state.packet.terrainRevision), true);
    slot.initialize();
});
