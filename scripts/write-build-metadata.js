"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const swfFile = path.join(root, "web", "web", "gamewo-v26.swf");
const rufflePackageFile = path.join(root, "web", "web", "ruffle", "package.json");
const outputFile = path.join(root, "shared", "build-info.json");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").toUpperCase();
}

if (!fs.existsSync(swfFile)) throw new Error(`Missing runtime SWF: ${swfFile}`);

const builtAt = new Date();
const swfSha256 = sha256(swfFile);
const compactTime = builtAt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const ruffle = JSON.parse(fs.readFileSync(rufflePackageFile, "utf8"));
const result = {
  buildId: `v26-${compactTime}-${swfSha256.slice(0, 8).toLowerCase()}`,
  builtAt: builtAt.toISOString(),
  swf: {
    file: "gamewo-v26.swf",
    bytes: fs.statSync(swfFile).size,
    sha256: swfSha256
  },
  ruffle: {
    version: String(ruffle.version || "unknown"),
    presentationFps: 30,
    legacyAnimationFps: 24
  }
};

fs.writeFileSync(outputFile, `${JSON.stringify(result, null, 2)}\n`);
console.log(`Build metadata ${result.buildId} -> ${path.relative(root, outputFile)}`);
