"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { V26_MAP_NAMES, V26_FREE_MAP_NAMES } = require("../shared/map-manifest.js");
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

test("enabled maps reference previews that exist and no missing ambient loop", () => {
    for (const map of maps) {
        assert.ok(fs.existsSync(path.join(root, "web", "images", map.preview)), `${map.name} preview`);
        // Big Tops' original loop is in none of the shipped sound libraries.
        assert.notEqual(map.ambientLoop, "Amb_BigTop_Loop.mp3");
    }
});

test("the free-map list matches the enabled price-0 maps", () => {
    assert.deepEqual(maps.filter((map) => Number(map.price) === 0).map((map) => map.name).sort(), [...V26_FREE_MAP_NAMES].sort());
});

test("every enabled foreground can be rasterized by Field at load time", () => {
    // Field draws the loaded foreground into a BitmapData on COMPLETE. Flash 5/8
    // (AVM1) movies have not built their first frame yet at that point under
    // Ruffle and draw as nothing, so those foregrounds ship as PNG.
    const { analyzeSWF } = require("../scripts/lib/swf-parser.js");
    for (const map of maps) {
        const file = path.join(root, "web", "images", map.foreground);
        assert.ok(fs.existsSync(file), `${map.name} foreground`);
        if (/\.swf$/i.test(map.foreground)) {
            // AVM2 (ActionScript 3) requires SWF version 9 or later.
            assert.ok(analyzeSWF(file).version >= 9, `${map.name} foreground must not be an AVM1 movie`);
        }
    }
});
