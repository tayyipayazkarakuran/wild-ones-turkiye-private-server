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

function flatTerrain(slot, groundY = 240, gapFrom = Infinity) {
    slot.field.bitmapData = {};
    slot.field.width = 2000;
    slot.field.height = 1400;
    // Solid ground from groundY down, except a pit starting at gapFrom.
    slot.field.checkFieldCollisionPoint = (x, y) => Number(y) >= groundY && Number(x) < gapFrom && Number(x) >= 0;
}

function tacticalWopw(weapons) {
    const wopw = makeWopw();
    wopw.weaponsObj = Object.fromEntries(weapons.map((type) => [type, { type, Vmax: 1.5, gravity: 0.0005, windR: 0.0001, R2: type === "mortar" ? 400 : 4 }]));
    const moves = [];
    wopw.packetHandler = {
        handleMoveLeft: () => moves.push("left"),
        handleMoveRight: () => moves.push("right"),
        handleMoveStop: () => moves.push("stop"),
        handleMoveJump: () => moves.push("jump")
    };
    wopw.moves = moves;
    return wopw;
}

test("a bot within melee reach uses its melee weapon", () => {
    const slot = new Slot(tacticalWopw(["chainsaw", "mortar"]), "bot-melee", "Critter Falls", 2, 60000, 10000);
    flatTerrain(slot);
    const bot = participant(900000001, 500, true);
    bot.player.userWeaponsEquipped = ["chainsaw", "mortar"];
    const enemy = participant(2, 590);
    slot.clients = { 900000001: bot, 2: enemy };
    const state = new BotController(slot).begin(bot, Date.now());
    assert.equal(state.intent, "melee");
    assert.equal(state.weapon, "chainsaw");
    slot.initialize();
});

test("a rushing bot walks toward its target and stops at melee reach", () => {
    const wopw = tacticalWopw(["chainsaw", "mortar"]);
    const slot = new Slot(wopw, "bot-rush", "Critter Falls", 2, 60000, 10000);
    flatTerrain(slot);
    const bot = participant(900000001, 400, true);
    const enemy = participant(2, 700);
    slot.clients = { 900000001: bot, 2: enemy };
    const controller = new BotController(slot);
    const now = Date.now();
    const state = {
        bot, target: enemy, phase: "moving", direction: 1, jumped: true, jumpAt: Infinity,
        move: { direction: 1, until: "reach", goal: 100 }, dueAt: now + 5000,
        moveStartedAt: now, stuckCheckAt: Infinity, stuckX: 400
    };
    let stoppedAt = null;
    for (let t = 0; t < 60 && stoppedAt === null; t++) {
        bot.avatar.X += 6;
        if (controller.updateMovement(state, bot, now + t * 50)) stoppedAt = bot.avatar.X;
    }
    assert.ok(stoppedAt !== null, "the leg ends");
    assert.ok(enemy.avatar.X - stoppedAt <= 100 && enemy.avatar.X - stoppedAt > 80, `stopped ${enemy.avatar.X - stoppedAt}px away`);
    assert.equal(state.phase, "equip");
    assert.equal(wopw.moves.at(-1), "stop");
    slot.initialize();
});

test("bots never walk off a ledge while moving", () => {
    const slot = new Slot(tacticalWopw(["mortar"]), "bot-ledge", "Critter Falls", 2, 60000, 10000);
    flatTerrain(slot, 240, 450);
    const bot = participant(900000001, 400, true);
    const enemy = participant(2, 1500);
    slot.clients = { 900000001: bot, 2: enemy };
    const controller = new BotController(slot);
    assert.equal(controller.hasGroundAhead(bot, 1), false, "the pit starts within one step");
    assert.equal(controller.hasGroundAhead(bot, -1), true);
    const now = Date.now();
    const state = {
        bot, target: enemy, phase: "moving", direction: 1, jumped: true, jumpAt: Infinity,
        move: { direction: 1, until: "time", goal: 0 }, dueAt: now + 5000, stuckCheckAt: Infinity
    };
    assert.equal(controller.updateMovement(state, bot, now), true);
    slot.initialize();
});

test("a stuck bot jumps once and then gives up the leg", () => {
    const wopw = tacticalWopw(["mortar"]);
    const slot = new Slot(wopw, "bot-stuck", "Critter Falls", 2, 60000, 10000);
    flatTerrain(slot);
    // A wall right in front of the bot, with headroom to jump.
    const base = slot.field.checkFieldCollisionPoint;
    slot.field.checkFieldCollisionPoint = (x, y) => base(x, y) || (x >= 455 && x <= 470 && y >= 180);
    const bot = participant(900000001, 400, true);
    const enemy = participant(2, 1500);
    slot.clients = { 900000001: bot, 2: enemy };
    const controller = new BotController(slot);
    const now = Date.now();
    const state = {
        bot, target: enemy, phase: "moving", direction: 1, jumped: false, jumpAt: Infinity, wantsJump: false,
        move: { direction: 1, until: "time", goal: 0 }, dueAt: now + 5000,
        moveStartedAt: now, stuckCheckAt: now + 450, stuckX: 400
    };
    assert.equal(controller.updateMovement(state, bot, now + 500), false);
    assert.ok(wopw.moves.includes("jump"));
    state.stuckCheckAt = now + 900;
    assert.equal(controller.updateMovement(state, bot, now + 950), true);
    slot.initialize();
});

test("bots rotate weapons instead of repeating the last one", () => {
    const slot = new Slot(tacticalWopw(["shotgun", "minigun"]), "bot-rotate", "Critter Falls", 2, 60000, 10000);
    const bot = participant(900000001, 400, true);
    bot.player.userWeaponsEquipped = ["shotgun", "minigun"];
    const enemy = participant(2, 600);
    slot.clients = { 900000001: bot, 2: enemy };
    const controller = new BotController(slot);
    for (const last of ["shotgun", "minigun", "shotgun"]) {
        bot._botRecentWeapons = [last];
        const choice = controller.choosePreferredWeapon(bot, enemy, ["close"]);
        assert.notEqual(choice, last);
    }
    slot.initialize();
});

test("weapons are grouped into tactical families", () => {
    const controller = new BotController(new Slot(makeWopw(), "bot-families", "Critter Falls", 2, 60000, 10000));
    assert.equal(controller.weaponClass("chainsaw"), "melee");
    assert.equal(controller.weaponClass("shotgun"), "close");
    assert.equal(controller.weaponClass("lasercannon"), "direct");
    assert.equal(controller.weaponClass("mortar"), "lob");
    assert.equal(controller.weaponClass("drill"), "bore");
    controller.slot.initialize();
});
