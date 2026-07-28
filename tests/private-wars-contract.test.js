"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("TURKIYE web shell uses the themed login and verified v26 Ruffle movie", () => {
  const app = read("web", "app.js");
  const compose = read("docker-compose.yml");
  const login = read("web", "web", "index.html");
  const theme = read("web", "web", "theme", "private-wars.css");

  assert.match(app, /\["v21", "v22", "v23", "v24", "v25", "v26"\]\.includes\(process\.env\.ASSET_VERSION\)/);
  assert.match(app, /GAME_SWF_FILE = `gamewo-\$\{ASSET_VERSION\}\.swf`/);
  assert.match(app, /GAME_SWF_REVISION/);
  assert.match(app, /value === ASSET_VERSION \? GAME_SWF_REVISION : value/);
  assert.match(app, /jotscaleroot/);
  assert.match(app, /app\.post\(\["\/register", "\/hero"\]/);
  assert.match(app, /app\.get\("\/play"/);
  assert.match(app, /app\.post\("\/logout"/);
  assert.match(app, /app\.get\("\/favicon\.ico"/);
  assert.match(app, /SOCKET_TRACE/);
  assert.match(compose, /SOCKET_TRACE: \$\{SOCKET_TRACE:-false\}/);
  assert.match(login, /Wild Ones: TURKIYE/);
  assert.match(login, /action="\/register"/);
  assert.match(login, /action="\/login"/);
  assert.match(theme, /carnival-turkiye\.webp/);
  assert.match(theme, /space-turkiye\.webp/);
  assert.equal(fs.existsSync(path.join(root, "web", "web", "theme", "wild-ones-turkiye-logo.png")), true);
  assert.equal(fs.existsSync(path.join(root, "web", "web", "gamewo-v26.swf")), true);
  assert.equal(fs.existsSync(path.join(root, "web", "assets", "pre_flash-turkiye.png")), true);
});

test("the active web server has no executable HTML5 match path", () => {
  const app = read("web", "app.js");
  assert.doesNotMatch(app, /v2-match-server|client-html5|html5\//i);
  assert.equal(fs.existsSync(path.join(root, "web", "v2-match-server.js")), false);
  assert.equal(fs.existsSync(path.join(root, "web", "scripts", "v2-smoke.js")), false);
  assert.equal(fs.existsSync(path.join(root, "web", "tests", "v2-match-server.test.js")), false);
});

test("v26 does not remap retired map assets to a different scene", () => {
  const app = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
  assert.doesNotMatch(app, /legacyMapPreviews|legacyMapAssets|legacyMapMidgrounds/);
  assert.match(app, /v26 never remaps an unavailable map/);
  assert.match(app, /previewFormatAliases/);
  assert.match(app, /af_preview\.gif/);
});
