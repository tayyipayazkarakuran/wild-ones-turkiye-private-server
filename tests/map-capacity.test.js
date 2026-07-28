"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const Slot = require("../game/slot.js");
const { V26_MAP_NAMES, buildMapManifest } = require("../shared/map-manifest.js");

const repoRoot = path.join(__dirname, "..");
const allMaps = JSON.parse(fs.readFileSync(path.join(repoRoot, "web", "assets", "json", "Maps.dat"), "utf8"));
const maps = allMaps.filter((map) => V26_MAP_NAMES.includes(map.name));
const config = JSON.parse(fs.readFileSync(path.join(repoRoot, "game", "crumbs", "config.json"), "utf8"));
const mapsObj = Object.fromEntries(maps.map((map) => [map.name, map]));

function makeWopw(overrides = {}) {
    return {
        mapsObj,
        config,
        petsObj: {},
        accessoriesObj: {},
        weaponsObj: {},
        packetHandler: {},
        getLobbyLoad: () => 0,
        ...overrides
    };
}

function participant(id, packets = []) {
    return {
        isBot: true,
        connectionType: "game",
        player: { id, dname: `Player-${id}`, status: "playing" },
        avatar: { X: -1, Y: -1, dead: false },
        isDead() { return this.avatar.dead; },
        sendPacket(packet) { packets.push(packet); },
        sendServerTick() {},
        resetTurnChanges() {}
    };
}

function addParticipantsDirectly(slot, count, packets = []) {
    for (let index = 0; index < count; index++) {
        const id = index + 1;
        slot.clients[id] = participant(id, packets);
    }
}

function expectedCapacity(map, requested) {
    return Math.max(...config.maxPlayers.filter((capacity) => capacity <= requested && capacity <= map.positions.length));
}

test("every verified v26 map satisfies the deterministic 2/4/6 spawn-capacity contract", () => {
    for (const map of maps) {
        for (const requested of config.maxPlayers) {
            const expected = expectedCapacity(map, requested);
            const slot = new Slot(makeWopw(), `contract-${map.name}-${requested}`, map.name, requested, 60000, 10000);
            try {
                assert.equal(slot.requestedPlayerCount, requested, `${map.name}/${requested} requested capacity`);
                assert.equal(slot.spawnCapacity, map.positions.length, `${map.name}/${requested} authored capacity`);
                assert.equal(slot.playerCount, expected, `${map.name}/${requested} effective capacity`);
                assert.equal(slot.min, expected, `${map.name}/${requested} protocol capacity`);
                assert.equal(slot.getString("join").min, expected, `${map.name}/${requested} join record capacity`);

                addParticipantsDirectly(slot, expected);
                slot.generateRndSeed = () => { slot.randomSeed = 123456; };
                assert.equal(slot.startGame(), true, `${map.name}/${requested} should start`);
                assert.equal(slot.status, "running", `${map.name}/${requested} running state`);

                const assigned = Object.values(slot.clients).map((client) => [client.avatar.X, client.avatar.Y]);
                const authored = map.positions.slice(0, expected).map((position) => [Number(position[0]), Number(position[1])]);
                assert.deepEqual(assigned, authored, `${map.name}/${requested} deterministic authored positions`);
                assert.equal(new Set(assigned.map((position) => position.join(":"))).size, expected,
                    `${map.name}/${requested} unique positions`);
            } finally {
                slot.initialize();
            }
        }
    }
});

test("Crash Landing and Hot and Spicy cap a six-player request to four and start without overlap", () => {
    for (const mapName of ["Crash Landing", "Hot and Spicy"]) {
        const slot = new Slot(makeWopw(), `known-repro-${mapName}`, mapName, 6, 60000, 10000);
        try {
            assert.equal(slot.requestedPlayerCount, 6);
            assert.equal(slot.spawnCapacity, 4);
            assert.equal(slot.playerCount, 4);
            assert.equal(slot.capacityAdjusted, true);
            addParticipantsDirectly(slot, 4);

            assert.doesNotThrow(() => assert.equal(slot.startGame(), true));
            const assigned = Object.values(slot.clients).map((client) => `${client.avatar.X}:${client.avatar.Y}`);
            assert.equal(new Set(assigned).size, 4, `${mapName} must not reuse a spawn`);
        } finally {
            slot.initialize();
        }
    }
});

test("room admission refuses a fifth participant after a six-player request is capped to four", () => {
    const slot = new Slot(makeWopw(), "capped-room-admission", "Crash Landing", 6, 60000, 10000);
    try {
        addParticipantsDirectly(slot, 4);
        const rejectedPackets = [];
        assert.equal(slot.isFull(), true);
        assert.equal(slot.addClient(participant(5, rejectedPackets)), false);
        assert.equal(slot.getPlayerCount(), 4);
        assert.deepEqual(rejectedPackets[0], {
            command: "game_join_failed",
            code: "full",
            capacity: 4
        });
    } finally {
        slot.initialize();
    }
});

test("a corrupted over-capacity room rejects start safely instead of indexing a missing spawn", () => {
    const packets = [];
    const slot = new Slot(makeWopw(), "capped-room-corrupt", "Hot and Spicy", 6, 60000, 10000);
    try {
        addParticipantsDirectly(slot, 5, packets);
        let result;
        assert.doesNotThrow(() => { result = slot.startGame(); });
        assert.equal(result, false);
        assert.equal(slot.status, "start_error");
        assert.ok(packets.some((packet) => packet.command === "game_start_rejected" &&
            packet.code === "map_capacity_exceeded" && packet.capacity === 4 && packet.playerCount === 5));
        assert.ok(Object.values(slot.clients).every((client) => client.avatar.X === -1 && client.avatar.Y === -1),
            "rejected start must not partially assign positions");
    } finally {
        slot.initialize();
    }
});

test("duplicate authored starting coordinates are rejected instead of silently overlapping players", () => {
    const duplicateMap = { name: "Duplicate", positions: [[100, 200], [100, 200]] };
    assert.throws(
        () => new Slot(makeWopw({ mapsObj: { Duplicate: duplicateMap } }), "duplicate-spawns", "Duplicate", 2, 60000, 10000),
        /Duplicate spawn position 100:200/
    );
});

test("the manifest contains only seven visible scenes with real image assets", () => {
    const imageRoot = path.join(repoRoot, "web", "images");
    const manifest = buildMapManifest(allMaps, {
        assetExists(relativePath) { return fs.existsSync(path.join(imageRoot, relativePath)); }
    });
    assert.deepEqual(manifest.names, V26_MAP_NAMES);
    assert.deepEqual(manifest.rejected, []);
    assert.equal(manifest.names.includes("Swamp"), false);
    assert.equal(manifest.names.includes("Haunted Mansion"), false);
});

test("every visible map resolves live starting positions onto its collision mask", async () => {
    for (const map of maps) {
        const requested = Math.min(4, expectedCapacity(map, 4));
        const slot = new Slot(makeWopw(), `surface-${map.name}`, map.name, requested, 60000, 10000);
        try {
            await slot.field.loadMapMask(map.name);
            addParticipantsDirectly(slot, slot.playerCount);
            slot.generateRndSeed = () => { slot.randomSeed = 987654; };
            assert.equal(slot.startGame(), true, `${map.name} should start on its loaded mask`);
            for (const client of Object.values(slot.clients)) {
                const surface = slot.resolveRespawnSurface(client.avatar.X, client.avatar.Y + 45);
                assert.ok(surface && surface.verified, `${map.name} ${client.player.id} needs supported terrain`);
                assert.ok(Math.abs(surface.y - client.avatar.Y) <= 4,
                    `${map.name} ${client.player.id} must start on the resolved surface`);
            }
        } finally {
            slot.initialize();
        }
    }
});
