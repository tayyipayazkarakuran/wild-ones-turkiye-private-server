"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Slot = require("../game/slot.js");
const BotController = require("../game/bot.controller.js");

function makeWopw() {
    return {
        mapsObj: { "Critter Falls": { positions: [[100, 100], [300, 100], [500, 100], [700, 100]] } },
        petsObj: { rabbit: { hp: 100, size: 40 } },
        levelsObj: Array.from({ length: 101 }, (_, index) => ({ xp: index * 100 })),
        accessoriesObj: {},
        weaponsObj: {
            mortar: { type: "mortar", Vmax: 1.5, gravity: 0.0005, windR: 0.0001, R2: 60 },
            minigun: { type: "minigun" }
        },
        getLobbyLoad: () => 0,
        packetHandler: {}
    };
}

function participant(id, x, isBot = false) {
    return {
        isBot,
        connectionType: isBot ? undefined : "game",
        player: { id, dname: "P" + id },
        avatar: { X: x, Y: 200, dead: false, boundRadius: 40, properties: { hp: 100 }, stopWalking() {} },
        isDead() { return this.avatar.dead; },
        sendPacket() {}
    };
}

test("team-mode bots never target or splash their teammates", () => {
    const slot = new Slot(makeWopw(), "team-bots", "Critter Falls", 4, 60000, 10000, { te: true });
    const bot = participant(900000001, 500, true);
    const ally = participant(3, 560);
    const enemyA = participant(2, 900);
    const enemyB = participant(4, 1300);
    slot.clients = { 900000001: bot, 2: enemyA, 3: ally, 4: enemyB };
    slot.matchPlayerIds = ["900000001", "2", "3", "4"];
    const controller = new BotController(slot);
    const targets = controller.livingTargets(bot).map((client) => client.player.id).sort();
    assert.deepEqual(targets, [2, 4]);
    assert.equal(controller.endangersAlly(bot, { impactX: 570, impactY: 210 }, "mortar"), true);
    assert.equal(controller.endangersAlly(bot, { impactX: 900, impactY: 210 }, "mortar"), false);
    slot.initialize();
});

test("free-for-all bots still target everybody", () => {
    const slot = new Slot(makeWopw(), "ffa-bots", "Critter Falls", 4, 60000, 10000);
    const bot = participant(900000001, 500, true);
    slot.clients = { 900000001: bot, 2: participant(2, 900), 3: participant(3, 560) };
    assert.equal(new BotController(slot).livingTargets(bot).length, 2);
    slot.initialize();
});

test("bot shot simulation applies the renderer's air resistance", () => {
    const slot = new Slot(makeWopw(), "drag-bots", "Critter Falls", 2, 60000, 10000);
    const controller = new BotController(slot);
    const bot = participant(900000001, 200, true);
    const target = participant(2, 5000);
    const withDrag = controller.simulateBallisticShot(bot, target, "mortar", -Math.PI / 4, 1, { ignoreTerrain: true });
    slot.WOPW.weaponsObj.mortar.windR = 0;
    const withoutDrag = controller.simulateBallisticShot(bot, target, "mortar", -Math.PI / 4, 1, { ignoreTerrain: true });
    assert.ok(withDrag.impactX < withoutDrag.impactX, "drag shortens long shots like on the client");
    slot.initialize();
});

test("bots wait for respawn acknowledgement and the first-turn countdown", () => {
    const slot = new Slot(makeWopw(), "bot-guards", "Critter Falls", 2, 60000, 10000);
    const bot = participant(900000001, 200, true);
    slot.clients = { 900000001: bot, 2: participant(2, 900) };
    slot.updateGameStatus("running");
    slot.currentPlayer = 900000001;
    const controller = new BotController(slot);
    let begun = 0;
    controller.begin = () => { begun++; return null; };
    controller.finishTurn = () => {};

    bot.respawnReady = false;
    controller.update();
    assert.equal(begun, 0);

    bot.respawnReady = true;
    slot.botActionNotBefore = Date.now() + 1000;
    controller.update();
    assert.equal(begun, 0);

    slot.botActionNotBefore = 0;
    controller.update();
    assert.equal(begun, 1);
    slot.initialize();
});

test("a silent renderer stops being the bot health reporter", () => {
    const slot = new Slot(makeWopw(), "bot-reporter", "Critter Falls", 4, 60000, 10000);
    const first = participant(1, 100);
    const second = participant(2, 300);
    first.botAiProtocol = 4;
    second.botAiProtocol = 4;
    first.lastMessageTime = Date.now();
    second.lastMessageTime = Date.now();
    slot.clients = { 1: first, 2: second, 900000001: participant(900000001, 500, true) };
    assert.equal(slot.getBotHealthReporterId(), "1");
    first.lastMessageTime = Date.now() - 30000;
    assert.equal(slot.getBotHealthReporterId(), "2");
    slot.initialize();
});

test("bot snapshots go out at 10 Hz while a bot moves and 5 Hz at rest", () => {
    const slot = new Slot(makeWopw(), "bot-state-rate", "Critter Falls", 2, 60000, 10000);
    const bot = participant(900000001, 500, true);
    bot.avatar.Vx = 0; bot.avatar.Vy = 0;
    const packets = [];
    slot.clients = { 900000001: bot, 2: Object.assign(participant(2, 900), { sendPacket: (packet) => packets.push(packet) }) };
    slot.updateGameStatus("running");
    slot.tick = 100; slot.sendBotState(true);
    slot.tick = 110; slot.sendBotState();
    assert.equal(packets.length, 1, "resting bots keep the 200 ms cadence");
    bot.avatar.isWalkingRight = true;
    slot.tick = 120; slot.sendBotState();
    assert.equal(packets.length, 2);
    slot.initialize();
});
