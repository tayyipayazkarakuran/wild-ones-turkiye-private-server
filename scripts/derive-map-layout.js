"use strict";

// Derives spawn, crate and mine zones for a map from its collision mask and
// validates authored zones against it. Several legacy Maps.dat entries carry
// positions copied from a different map, which put players and crates in the
// air or inside rock.
//
//   node scripts/derive-map-layout.js --check            report every map
//   node scripts/derive-map-layout.js "Big Tops" --json  print derived zones

const fs = require("node:fs");
const path = require("node:path");
const { Jimp } = require("../game/node_modules/jimp");

const root = path.resolve(__dirname, "..");
const imagesDir = path.join(root, "web", "images");
const mapsFile = path.join(root, "web", "assets", "json", "Maps.dat");

// Pet geometry used by the server (resolveRespawnSurface) and the renderer.
const AVATAR_RADIUS = 40;
const CLEARANCE = 85;
const EDGE_MARGIN = 70;
const WATER_MARGIN = 160;

async function loadMask(map) {
  const image = await Jimp.read(path.join(imagesDir, map.mask));
  const { width, height, data } = image.bitmap;
  const solid = (x, y) => x >= 0 && y >= 0 && x < width && y < height && data[(y * width + x) * 4 + 3] > 0;
  return { width, height, solid };
}

// Mirrors Slot.resolveRespawnSurface: first solid pixel under the column, at
// least two of three support columns within 42 px, and a clear capsule.
function resolveSurface(mask, x, preferredY) {
  x = Math.round(x);
  preferredY = Math.round(preferredY);
  if (x < 30 || x > mask.width - 30) return null;
  const scanStart = Math.max(30, Math.min(mask.height - 70, preferredY - 90));
  const firstSolid = (sx, start, end) => {
    for (let sy = start; sy <= end; sy += 2) if (mask.solid(sx, sy)) return sy;
    return null;
  };
  const centerY = firstSolid(x, scanStart, mask.height - 8);
  if (centerY === null) return null;
  const supports = [-20, 0, 20]
    .map((offset) => firstSolid(x + offset, Math.max(scanStart, centerY - 28), Math.min(mask.height - 8, centerY + 42)))
    .filter((value) => value !== null && Math.abs(value - centerY) <= 42)
    .sort((a, b) => a - b);
  if (supports.length < 2) return null;
  const groundY = supports[Math.floor(supports.length / 2)];
  for (let cy = groundY - 80; cy <= groundY - 12; cy += 6) {
    if (mask.solid(x - 12, cy) || mask.solid(x, cy) || mask.solid(x + 12, cy)) return null;
  }
  return { x, groundY, y: Math.max(5, groundY - 45) };
}

// Every standable surface: scan each column top-down for air->solid edges.
function surfaces(mask, step = 10) {
  const points = [];
  for (let x = EDGE_MARGIN; x <= mask.width - EDGE_MARGIN; x += step) {
    let wasSolid = true;
    for (let y = 0; y < mask.height - WATER_MARGIN; y += 2) {
      const isSolid = mask.solid(x, y);
      if (isSolid && !wasSolid) {
        const surface = resolveSurface(mask, x, y);
        if (surface && Math.abs(surface.groundY - y) <= 4) points.push(surface);
      }
      wasSolid = isSolid;
    }
  }
  return points;
}

// Contiguous runs of standable points become authored zones [x1,y1,x2,y2].
function runs(points, step = 10) {
  const sorted = points.slice().sort((a, b) => a.x - b.x || a.groundY - b.groundY);
  const open = [];
  const closed = [];
  for (const point of sorted) {
    const run = open.find((candidate) => point.x - candidate.end.x <= step && Math.abs(point.groundY - candidate.end.groundY) <= 14);
    if (run) {
      run.points.push(point);
      run.end = point;
    } else {
      open.push({ points: [point], end: point });
    }
    for (let i = open.length - 1; i >= 0; i--) {
      if (point.x - open[i].end.x > step) closed.push(...open.splice(i, 1));
    }
  }
  closed.push(...open);
  return closed
    .filter((run) => run.points.length >= 4)
    .map((run) => {
      const pts = run.points;
      return {
        x1: pts[0].x, y1: pts[0].groundY - 10,
        x2: pts[pts.length - 1].x, y2: pts[pts.length - 1].groundY - 10,
        width: pts[pts.length - 1].x - pts[0].x,
        mid: pts[Math.floor(pts.length / 2)]
      };
    });
}

// Greedy farthest-point selection keeps spawns spread over the whole map.
function spreadPick(candidates, count, seed = []) {
  const chosen = seed.slice();
  const pool = candidates.slice();
  while (chosen.length < count + seed.length && pool.length) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    pool.forEach((candidate, index) => {
      const nearest = chosen.length
        ? Math.min(...chosen.map((other) => Math.hypot(candidate.mid.x - other.mid.x, candidate.mid.groundY - other.mid.groundY)))
        : candidate.width;
      // Prefer distant and wide surfaces; a branch tip is a poor spawn.
      const score = nearest + Math.min(candidate.width, 300) * 0.6;
      if (score > bestScore) { bestScore = score; bestIndex = index; }
    });
    chosen.push(pool.splice(bestIndex, 1)[0]);
  }
  return chosen.slice(seed.length);
}

// Crates and mines fall from their zone; start them above the surface so a
// sloped surface never puts part of the zone inside the terrain.
const lift = (zone, by) => [zone[0], zone[1] - by, zone[2], zone[3] - by];

function shrink(run, maxWidth) {
  if (run.width <= maxWidth) return [run.x1, run.y1, run.x2, run.y2];
  const center = run.mid.x;
  const x1 = Math.round(center - maxWidth / 2);
  const x2 = Math.round(center + maxWidth / 2);
  const ratio = (value) => (value - run.x1) / Math.max(1, run.width);
  const y = (value) => Math.round(run.y1 + (run.y2 - run.y1) * ratio(value));
  return [x1, y(x1), x2, y(x2)];
}

// Slot.setDefaultPositions samples the zone every 10 px and keeps the
// surface closest to the authored height; any resolvable sample is usable.
function spawnZoneValid(mask, zone) {
  const [x1, y1, x2 = x1, y2 = y1] = zone;
  for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x += 10) {
    const ratio = x2 === x1 ? 0 : (x - x1) / (x2 - x1);
    const authored = Math.round(y1 + (y2 - y1) * ratio);
    const surface = resolveSurface(mask, x, authored);
    if (surface && surface.groundY - authored <= 220) return true;
  }
  return false;
}

function zoneValid(mask, zone) {
  const [x1, y1, x2, y2] = zone;
  const samples = 5;
  let valid = 0;
  for (let i = 0; i < samples; i++) {
    const ratio = i / (samples - 1);
    const x = x1 + (x2 - x1) * ratio;
    const y = y1 + (y2 - y1) * ratio;
    const surface = resolveSurface(mask, x, y);
    if (surface && Math.abs(surface.groundY - y) <= 60) valid++;
  }
  return valid >= 3;
}

async function deriveLayout(map, { players = 6, crates = 6, mines = 0 } = {}) {
  const mask = await loadMask(map);
  const candidates = runs(surfaces(mask));
  const spawnRuns = spreadPick(candidates.filter((run) => run.width >= 60 && run.mid.groundY >= 140), players);
  const crateRuns = spreadPick(candidates.filter((run) => run.width >= 30), crates, spawnRuns);
  const mineRuns = mines > 0 ? spreadPick(candidates.filter((run) => run.width >= 30), mines, spawnRuns.concat(crateRuns)) : [];
  return {
    positions: spawnRuns.map((run) => shrink(run, 90)),
    cratePos: crateRuns.map((run) => lift(shrink(run, 160), 60)),
    minePos: mineRuns.map((run) => lift(shrink(run, 120), 30))
  };
}

// Crates and mines are dropped from their zone: the drop point must be in
// open air with solid ground somewhere below it (not water at the bottom).
function dropZoneValid(mask, zone) {
  const [x1, y1, x2 = x1, y2 = y1] = zone;
  let valid = 0;
  for (let i = 0; i < 5; i++) {
    const ratio = i / 4;
    const x = Math.round(x1 + (x2 - x1) * ratio);
    const y = Math.round(y1 + (y2 - y1) * ratio);
    if (mask.solid(x, y - 20)) continue;
    let ground = null;
    for (let sy = y; sy < mask.height; sy += 2) {
      if (mask.solid(x, sy)) { ground = sy; break; }
    }
    if (ground !== null && ground < mask.height - 40) valid++;
  }
  return valid >= 3;
}

// Keeps every valid authored zone and replaces only the broken ones with
// derived surfaces spread away from the zones that remain.
async function repairDropZones(map, field) {
  const mask = await loadMask(map);
  const spawn = field === "positions";
  const valid = (zone) => spawn ? spawnZoneValid(mask, zone) : dropZoneValid(mask, zone);
  const zones = Array.isArray(map[field]) ? map[field] : [];
  const keep = zones.filter(valid);
  const broken = zones.length - keep.length;
  if (!broken) return { zones, replaced: 0 };
  const asRun = (zone) => ({ mid: { x: (zone[0] + (zone[2] ?? zone[0])) / 2, groundY: (zone[1] + (zone[3] ?? zone[1])) / 2 }, width: 0 });
  const seed = keep.map(asRun).concat(spawn ? [] : (map.positions || []).map(asRun));
  const picks = spreadPick(runs(surfaces(mask)).filter((run) => run.width >= (spawn ? 60 : 30)), broken, seed)
    .map((run) => spawn ? shrink(run, 90) : lift(shrink(run, 160), 60));
  let pick = 0;
  return {
    zones: zones.map((zone) => valid(zone) ? zone : (picks[pick++] || zone)),
    replaced: Math.min(broken, picks.length)
  };
}

async function checkMap(map) {
  const mask = await loadMask(map);
  const report = (zones, check) => (zones || []).map((zone) => check(mask, zone.length >= 4 ? zone : [zone[0], zone[1], zone[0], zone[1]]));
  return { positions: report(map.positions, spawnZoneValid), cratePos: report(map.cratePos, dropZoneValid), minePos: report(map.minePos, dropZoneValid) };
}

module.exports = { deriveLayout, checkMap, loadMask, resolveSurface, zoneValid, spawnZoneValid, dropZoneValid, repairDropZones };

if (require.main === module) {
  (async () => {
    const maps = JSON.parse(fs.readFileSync(mapsFile, "utf8"));
    const args = process.argv.slice(2);
    if (args.includes("--check")) {
      for (const map of maps) {
        const result = await checkMap(map);
        const summary = Object.entries(result).map(([key, values]) =>
          `${key} ${values.filter(Boolean).length}/${values.length}`).join("  ");
        console.log(`${map.name.padEnd(16)} ${summary}`);
      }
      return;
    }
    const name = args.find((arg) => !arg.startsWith("--"));
    const map = maps.find((entry) => entry.name === name);
    if (!map) throw new Error(`Unknown map: ${name}`);
    const layout = await deriveLayout(map, {
      players: Number(map.players || 6),
      crates: Math.max(Number(map.crates || 3) * 2, 4),
      mines: Number(map.mines || 0)
    });
    console.log(JSON.stringify(layout));
  })().catch((error) => { console.error(error); process.exit(1); });
}
