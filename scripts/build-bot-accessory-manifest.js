"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const ffdec = process.env.FFDEC_CLI || path.join(root, ".tools", "ffdec", "ffdec-cli.exe");
const assetsDir = path.join(root, "web", "assets");
const output = path.join(root, "shared", "bot-accessory-assets.json");

function exportedSymbols(movie) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "wo-accessory-symbols-"));
  try {
    execFileSync(ffdec, ["-export", "symbolClass", temporary, movie], {
      cwd: root,
      stdio: "ignore"
    });
    const csv = path.join(temporary, "symbols.csv");
    const symbols = fs.existsSync(csv) ? fs.readFileSync(csv, "utf8").split(/\r?\n/).map((line) => {
      const match = line.match(/^\d+;"(.+)"$/);
      return match && match[1];
    }).filter(Boolean) : [];
    return [...new Set(symbols)];
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function buildManifest() {
  const movies = fs.readdirSync(assetsDir)
    .filter((name) => /^accessories\d*\.swf$/i.test(name))
    .sort()
    .map((name) => path.join(assetsDir, name));
  const symbols = new Set(movies.flatMap(exportedSymbols));
  const accessories = JSON.parse(fs.readFileSync(path.join(assetsDir, "json", "Accessories.dat"), "utf8"));
  const records = {};
  for (const accessory of accessories) {
    if (!accessory || !accessory.type || !accessory.category) continue;
    const type = String(accessory.type);
    const category = String(accessory.category);
    const directSymbol = symbols.has(type);
    const leftSymbolSupported = category !== "shoes" || symbols.has(`${type}_L`);
    const virtualSet = category === "sets";
    const rendererSupported = !virtualSet && directSymbol && leftSymbolSupported;
    records[type] = {
      category,
      rendererSupported,
      leftSymbolSupported,
      shopVisible: rendererSupported && Number(accessory.price || 0) > 0,
      equipVisible: rendererSupported,
      rewardEligible: rendererSupported,
      effectiveType: type,
      reason: rendererSupported ? null : (
        virtualSet ? "virtual_set" :
          (!directSymbol ? "missing_symbol" : "missing_left_symbol")
      )
    };
  }
  const types = Object.keys(records).filter((type) => records[type].rendererSupported).sort();
  const manifest = {
    version: 2,
    scannedMovies: movies.map((movie) => path.relative(root, movie).replaceAll("\\", "/")),
    symbolCount: symbols.size,
    types,
    accessories: Object.fromEntries(Object.entries(records).sort(([left], [right]) => left.localeCompare(right)))
  };
  fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (require.main === module) {
  const manifest = buildManifest();
  console.log(`Built ${path.relative(root, output)} with ${manifest.types.length} renderer-backed accessories`);
}

module.exports = { buildManifest };
