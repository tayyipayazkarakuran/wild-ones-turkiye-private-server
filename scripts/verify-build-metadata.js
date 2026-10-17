"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const info = require("../shared/build-info.json");
const swf = path.join(root, "web", "web", "gamewo-v26.swf");
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").toUpperCase();

assert.match(info.buildId, /^v26-\d{8}T\d{6}Z-[0-9a-f]{8}$/);
assert.equal(info.swf.sha256, sha256(swf), "build metadata must identify the shipped game SWF");
assert.equal(info.swf.bytes, fs.statSync(swf).size);
assert.equal(Object.hasOwn(info, "turkiyeAccessories"), false);
assert.equal(info.ruffle.presentationFps, 24);
assert.equal(info.ruffle.legacyAnimationFps, 24);
console.log(`Verified build metadata ${info.buildId}`);
