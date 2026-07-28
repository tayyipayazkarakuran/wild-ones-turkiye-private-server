"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const inventory = JSON.parse(fs.readFileSync(path.join(root, "shared", "ui-control-inventory.json"), "utf8"));
const handler = fs.readFileSync(path.join(root, "game", "handler.js"), "utf8");
const build = fs.readFileSync(path.join(root, "scripts", "build-ruffle-v26.js"), "utf8");
const web = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
const seen = new Set();

assert.equal(inventory.unsupportedMessage, "Unavailable on this private server");
assert.ok(Array.isArray(inventory.controls) && inventory.controls.length >= 25);

for (const entry of inventory.controls) {
  assert.ok(entry.group && entry.control, "Every UI control needs a group and label");
  assert.ok(["local", "disabled"].includes(entry.status), `${entry.control} has an invalid status`);
  const key = `${entry.group}:${entry.control}`;
  assert.equal(seen.has(key), false, `Duplicate UI control: ${key}`);
  seen.add(key);
  if (entry.protocol && entry.target !== "game") {
    assert.match(handler, new RegExp(`case\\s+"${entry.protocol}"`), `${entry.control} has no server command`);
  }
}

assert.match(build, /function privateFeatureUnavailable/);
assert.match(build, /Unavailable on this private server/);
assert.match(web, /app\.post\("\/logout"/);
assert.match(web, />Sign out</);
console.log(`Verified ${inventory.controls.length} visible UI controls`);
