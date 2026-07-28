"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildWeaponCatalog } = require("../shared/weapon-catalog.js");

const SYMBOL_ALIASES = Object.freeze({
  acornschild: ["acornschild", "accorns", "accorn"]
});

const root = path.resolve(__dirname, "..");
const ffdec = process.env.FFDEC_CLI || path.join(root, ".tools", "ffdec", "ffdec-cli.exe");
const output = path.join(root, "shared", "weapon-assets.json");

function activeWeaponIconMovies() {
  const other = JSON.parse(fs.readFileSync(path.join(root, "web", "assets", "json", "Other.dat"), "utf8"));
  const active = [...(other.assetFiles || []), ...(other.assetFiles2 || [])]
    .map((entry) => String(entry).split("?")[0])
    .filter((name) => /^weaponicons\d*\.swf$/i.test(name));
  return [...new Set(active)].sort().map((name) => {
    const movie = path.join(root, "web", "assets", name);
    if (!fs.existsSync(movie)) throw new Error(`Active weapon asset is missing: ${name}`);
    return movie;
  });
}

function exportedSymbols(movie) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "wo-weapon-symbols-"));
  try {
    execFileSync(ffdec, ["-export", "symbolClass", temporary, movie], {
      cwd: root,
      stdio: "ignore"
    });
    const csv = path.join(temporary, "symbols.csv");
    if (!fs.existsSync(csv)) return [];
    return fs.readFileSync(csv, "utf8").split(/\r?\n/).map((line) => {
      const match = line.match(/^\d+;"(.+)"$/);
      return match && match[1];
    }).filter(Boolean);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function buildManifest() {
  // Archived movies are intentionally excluded. Declaring a symbol supported
  // because an inactive backup happens to contain it makes the live movie try
  // to instantiate classes that were never loaded.
  const movies = activeWeaponIconMovies();
  const symbolSources = new Map();
  for (const movie of movies) {
    for (const symbol of exportedSymbols(movie)) {
      if (!symbolSources.has(symbol)) symbolSources.set(symbol, []);
      symbolSources.get(symbol).push(path.relative(root, movie).replaceAll("\\", "/"));
    }
  }

  const records = JSON.parse(fs.readFileSync(path.join(root, "web", "assets", "json", "WeaponsGrid.dat"), "utf8"));
  const catalog = buildWeaponCatalog(records);
  const weapons = {};
  for (const [type, entry] of [...catalog.entries].sort(([left], [right]) => left.localeCompare(right))) {
    const behaviorType = String(entry.effectiveType || type);
    const aliases = SYMBOL_ALIASES[type] || [type];
    const iconSymbols = aliases.map((candidate) => `${candidate}_icon`);
    const baseType = entry.weapon && entry.weapon.baseType && entry.weapon.baseType !== "null"
      ? String(entry.weapon.baseType)
      : type;
    const runtimeSymbols = [...new Set([...aliases, baseType].flatMap((candidate) =>
      ["_weapon", "_ammo", "_gun", "_icon"].map((suffix) => candidate + suffix)
    ))];
    const iconSymbol = iconSymbols.find((symbol) => symbolSources.has(symbol)) || null;
    const iconSupported = Boolean(iconSymbol);
    const runtimeSupported = entry.runtimeKind === "direct" || runtimeSymbols.some((symbol) => symbolSources.has(symbol));
    weapons[type] = {
      visualType: type,
      behaviorType,
      // Compatibility field for older server code. It now means visual
      // identity and must never be used to select projectile behavior.
      effectiveType: type,
      aliases,
      runtimeSupported,
      iconSupported,
      shopVisible: Boolean(entry.selectable && runtimeSupported && iconSupported),
      symbols: {
        icon: iconSymbol,
        runtime: runtimeSymbols.filter((symbol) => symbolSources.has(symbol))
      }
    };
  }

  const manifest = {
    version: 2,
    generatedAt: new Date().toISOString(),
    scannedMovies: movies.map((movie) => path.relative(root, movie).replaceAll("\\", "/")),
    symbolCount: symbolSources.size,
    weapons
  };
  fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (require.main === module) {
  const manifest = buildManifest();
  const visible = Object.values(manifest.weapons).filter((weapon) => weapon.shopVisible).length;
  console.log(`Built ${path.relative(root, output)} from ${manifest.scannedMovies.length} SWF files (${visible} shop weapons)`);
}

module.exports = { buildManifest };
