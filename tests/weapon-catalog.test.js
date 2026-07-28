"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildWeaponCatalog } = require("../shared/weapon-catalog.js");
const weaponAssets = require("../shared/weapon-assets.json");

const root = path.resolve(__dirname, "..");
const weapons = JSON.parse(fs.readFileSync(path.join(root, "web", "assets", "json", "WeaponsGrid.dat"), "utf8"));

test("weapon catalog resolves inherited gameplay data without exposing child hazards or tree growth", () => {
    const catalog = buildWeaponCatalog(weapons);
    assert.ok(catalog.selectable.length >= 100);
    for (const type of ["treegrowth", "mirvchild", "goochild", "flamechild", "beechild", "fishchunk", "acornschild"]) {
        assert.equal(catalog.entries.get(type).selectable, false, `${type} must not be a selectable loadout weapon`);
    }
    const candyMirv = catalog.entries.get("candy_corn_mirv");
    assert.ok(candyMirv && candyMirv.weapon.effect1, "special-effect metadata must survive inheritance flattening");
    assert.equal(catalog.entries.get("coconutblast").runtimeKind, "internal");
});

test("shop visibility requires a real icon and a runtime-backed weapon asset", () => {
    const visible = Object.entries(weaponAssets.weapons).filter(([, support]) => support.shopVisible);
    assert.ok(visible.length > 20);
    for (const [type, support] of visible) {
        assert.equal(support.iconSupported, true, `${type} icon`);
        assert.equal(support.runtimeSupported, true, `${type} runtime`);
        assert.equal(support.symbols.icon, `${type}_icon`);
    }
});

test("v22's external combat asset manifest is fully served by the web image", () => {
    const other = JSON.parse(fs.readFileSync(path.join(root, "web", "assets", "json", "Other.dat"), "utf8"));
    const swfs = [...new Set(Object.values(other).flat(Infinity)
        .filter((value) => typeof value === "string" && /\.swf(?:\?|$)/i.test(value))
        .map((value) => value.split("?")[0].replace(/^.*\//, "")))];
    const directories = [path.join(root, "web", "assets"), path.join(root, "web", "images")];
    const missing = swfs.filter((name) => !directories.some((directory) => fs.existsSync(path.join(directory, name))));
    assert.deepEqual(missing, []);
});
