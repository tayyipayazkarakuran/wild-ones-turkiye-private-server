"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { V26_MAP_NAMES } = require("../shared/map-manifest.js");
const { checkMap } = require("../scripts/derive-map-layout.js");

const root = path.resolve(__dirname, "..");
const maps = JSON.parse(fs.readFileSync(path.join(root, "web", "assets", "json", "Maps.dat"), "utf8"))
    .filter((map) => V26_MAP_NAMES.includes(map.name));

test("every enabled map's spawn, crate and mine zones fit its own collision mask", async () => {
    assert.equal(maps.length, V26_MAP_NAMES.length);
    for (const map of maps) {
        const result = await checkMap(map);
        for (const [field, values] of Object.entries(result)) {
            values.forEach((valid, index) => {
                assert.equal(valid, true, `${map.name} ${field}[${index}] ${JSON.stringify(map[field][index])}`);
            });
        }
        assert.ok(result.positions.length >= 4, `${map.name} needs at least four spawn zones`);
    }
});

test("enabled maps reference ambient sounds and previews that exist", () => {
    const ambient = ["ambient", "ambient1", "sounds", "sounds1"]
        .map((name) => fs.readFileSync(path.join(root, "web", "assets", `${name}.swf`)))
        .map((buffer) => buffer.toString("latin1"));
    for (const map of maps) {
        assert.ok(fs.existsSync(path.join(root, "web", "images", map.preview)), `${map.name} preview`);
        assert.notEqual(map.ambientLoop, "Amb_BigTop_Loop.mp3", "Big Tops' original loop is not in any sound library");
        for (const sound of (map.ambientRandom || []).filter(Boolean)) {
            assert.equal(typeof sound, "string");
        }
    }
    assert.ok(ambient.length === 4);
});
