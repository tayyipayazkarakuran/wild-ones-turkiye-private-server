"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

test("bot outfits use only renderer-backed active accessory symbols", () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(root, "shared", "bot-accessory-assets.json"),
    "utf8"
  ));
  const accessories = JSON.parse(fs.readFileSync(
    path.join(root, "web", "assets", "json", "Accessories.dat"),
    "utf8"
  ));
  const catalog = new Map(accessories.map((accessory) => [accessory.type, accessory]));
  assert.equal(manifest.version, 2);
  assert.equal(accessories.length, 248);
  assert.equal(manifest.types.length, 160);
  assert.equal(new Set(manifest.types).size, manifest.types.length);
  const categories = new Set();
  for (const type of manifest.types) {
    assert.ok(catalog.has(type), `${type} is absent from Accessories.dat`);
    categories.add(catalog.get(type).category);
  }
  assert.ok(categories.size >= 4);
  for (const movie of manifest.scannedMovies) {
    assert.ok(movie.startsWith("web/assets/accessories"));
    assert.equal(fs.existsSync(path.join(root, movie)), true);
  }
  const baseTypes = new Set(accessories.map((item) => item.type));
  assert.equal([...baseTypes].filter((type) => manifest.accessories[type].rendererSupported).length, 160);
  assert.equal([...baseTypes].filter((type) => !manifest.accessories[type].rendererSupported).length, 86);
  assert.equal(accessories.some((item) => /_turkiye_/.test(item.type)), false);
});
