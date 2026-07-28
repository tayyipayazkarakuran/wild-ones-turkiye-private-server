"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const files = [
  path.join(root, "web", "app.js"),
  path.join(root, "web", "web", "index.html"),
  path.join(root, "web", "web", "theme", "private-wars.css"),
  path.join(root, "web", "package.json")
];
const forbidden = [
  /Wild Ones:\s*Private Wars/i,
  />\s*Çıkış\s*</i,
  />\s*Savaş/i,
  />\s*Kullanıcı adı\s*</i,
  />\s*Parola\s*</i,
  /Sunucu hatası/i
];

for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  for (const pattern of forbidden) {
    assert.doesNotMatch(source, pattern, `${path.relative(root, file)} still contains legacy user-facing copy`);
  }
}

const index = fs.readFileSync(path.join(root, "web", "web", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "web", "web", "theme", "private-wars.css"), "utf8");
assert.match(index, /<html lang="en">/);
assert.match(index, /Wild Ones: TURKIYE/);
assert.match(app, /Sign out/);
assert.match(app, /wild-ones-turkiye-logo\.png/);
assert.match(css, /carnival-turkiye\.webp/);
assert.match(css, /space-turkiye\.webp/);

for (const asset of [
  path.join(root, "web", "web", "theme", "carnival-turkiye.webp"),
  path.join(root, "web", "web", "theme", "space-turkiye.webp"),
  path.join(root, "web", "web", "theme", "wild-ones-turkiye-logo.png"),
  path.join(root, "web", "assets", "pre_flash-turkiye.png")
]) {
  assert.ok(fs.existsSync(asset) && fs.statSync(asset).size > 10_000, `${path.relative(root, asset)} is missing or too small`);
}

console.log("Verified English Wild Ones: TURKIYE branding and active visual assets");
