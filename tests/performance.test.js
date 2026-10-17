"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const root = path.resolve(__dirname, "..");
const { compressedStatic, chooseEncoding } = require("../web/compressed-static.js");
const { playerWireDto, publicPlayerRecord } = require("../shared/player-wire.js");

function fakeResponse() {
  const headers = {};
  return {
    headers,
    statusCode: 200,
    body: null,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    end(body) { this.body = body || null; this.ended = true; }
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not reached");
}

test("compressed static serves brotli from memory after warm-up and raw before", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wo-static-"));
  const payload = Buffer.from("ruffle wasm core ".repeat(4096));
  fs.writeFileSync(path.join(dir, "core.wasm"), payload);
  const middleware = compressedStatic(dir, { cacheControl: "public, max-age=31536000, immutable" });
  const request = { method: "GET", path: "/core.wasm", headers: { "accept-encoding": "gzip, deflate, br" } };

  let passed = false;
  const first = fakeResponse();
  middleware(request, first, () => { passed = true; });
  assert.equal(passed, true, "the first request must not wait for the compressor");

  middleware.warm(["core.wasm"]);
  let response;
  await waitFor(() => {
    response = fakeResponse();
    let fellThrough = false;
    middleware(request, response, () => { fellThrough = true; });
    return !fellThrough;
  });
  assert.equal(response.headers["content-encoding"], "br");
  assert.equal(response.headers["content-type"], "application/wasm");
  assert.equal(response.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.ok(response.body.length < payload.length / 10);
  assert.deepEqual(zlib.brotliDecompressSync(response.body), payload);

  const revalidate = fakeResponse();
  middleware({ ...request, headers: { ...request.headers, "if-none-match": response.headers.etag } }, revalidate, () => {});
  assert.equal(revalidate.statusCode, 304);
});

test("compressed static refuses traversal and clients without compression", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wo-static-"));
  const middleware = compressedStatic(dir);
  let calls = 0;
  middleware({ method: "GET", path: "/../../etc/passwd.txt", headers: { "accept-encoding": "br" } }, fakeResponse(), () => calls++);
  middleware({ method: "GET", path: "/a.js", headers: {} }, fakeResponse(), () => calls++);
  assert.equal(calls, 2);
  assert.equal(chooseEncoding("gzip"), "gzip");
  assert.equal(chooseEncoding("identity"), null);
});

test("profile packets omit server bookkeeping and rosters omit private account state", () => {
  const player = {
    id: 7, dname: "Pilot", level: 3, xp: 10, gold: 5, treats: 1, snum: "secret-serial",
    transactions: Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`tx${index}`, { ok: true, at: index }])),
    collections: { a: 1 }, promos: {}, mysteryGift: {}, idleGift: {}, ownedPets: {}, currentPet: "",
    userAccessories: [], medals: {}, membership: {}
  };
  const own = playerWireDto(player, { snum: "token" });
  assert.equal(Object.hasOwn(own, "transactions"), false);
  assert.equal(own.snum, "token");
  assert.ok(player.transactions.tx0, "the persisted profile is not mutated");

  const roster = publicPlayerRecord(player);
  for (const field of ["transactions", "snum", "collections", "promos", "mysteryGift", "idleGift"]) {
    assert.equal(Object.hasOwn(roster, field), false, field);
  }
  assert.equal(roster.dname, "Pilot");
  assert.equal(roster.id, 7);
});

test("slot rosters and broadcasts reuse one serialized frame per packet", () => {
  const Slot = require("../game/slot.js");
  const slot = Object.create(Slot.prototype);
  const frames = [];
  const objects = [];
  slot.clients = {
    1: { player: { id: 1, transactions: { x: 1 }, snum: "s" }, sendSerialized: (value) => frames.push(value) },
    2: { player: { id: 2 }, sendSerialized: (value) => frames.push(value) },
    3: { player: { id: 3 }, sendPacket: (value) => objects.push(value) }
  };
  const packet = { command: "changeTurn", value: 1 };
  slot.sendPacketE(packet, slot.clients[2]);
  assert.equal(frames.length, 1);
  assert.equal(frames[0], JSON.stringify(packet));
  assert.deepEqual(objects, [packet]);
  const list = slot.getPlayerList();
  assert.equal(Object.hasOwn(list[0], "transactions"), false);
  assert.equal(Object.hasOwn(list[0], "snum"), false);
});

test("terrain masks are decoded once per process and cloned per room", async () => {
  const Field = require("../game/field.js");
  const maps = JSON.parse(fs.readFileSync(path.join(root, "web", "assets", "json", "Maps.dat"), "utf8"));
  const map = maps.find((entry) => entry.name === "Critter Falls");
  const wopw = { mapsObj: { [map.name]: map } };
  const first = new Field({ WOPW: wopw });
  const second = new Field({ WOPW: wopw });
  await first.loadMapMask(map.name);
  const startedAt = process.hrtime.bigint();
  await second.loadMapMask(map.name);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.notEqual(first.bitmapData, second.bitmapData, "each room carves a private copy");
  assert.ok(elapsedMs < 500, `cached mask load took ${elapsedMs} ms`);
  const again = await first.loadMapMask(map.name);
  assert.equal(again, first.bitmapData, "later renderer acks reuse the loaded room mask");

  first.mergeExplosionRecords([["4082C00000000000", "4082C00000000000", "4049000000000000"]]);
  const x = 600; const y = 600;
  assert.equal(first.checkFieldCollisionPoint(x, y), false);
  assert.equal(second.checkFieldCollisionPoint(x, y), second.checkFieldCollisionPoint(x, y));
});
