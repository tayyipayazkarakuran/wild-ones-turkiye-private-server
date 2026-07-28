"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const express = require("express");
const bcrypt = require("bcrypt");
const { MongoClient } = require("mongodb");
const { WebSocketServer } = require("ws");
const { createProfile, validateCredentials, canonicalName } = require("../shared/profile");
const {
  normalizeProfileState,
  profileStateSnapshot,
  profileStateUpdate
} = require("../shared/profile-state");
const BUILD_INFO = (() => {
  try { return require("../shared/build-info.json"); }
  catch { return { buildId: "development", swf: {}, ruffle: { presentationFps: 60, legacyAnimationFps: 24 } }; }
})();

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017";
const DB_NAME = process.env.DB_NAME || "emu";
const PORT = Number(process.env.PORT || 3000);
const GAME_HOST = process.env.GAME_HOST || "127.0.0.1";
const GAME_PORT = Number(process.env.GAME_PORT || 8000);
const ASSET_VERSION = ["v21", "v22", "v23", "v24", "v25", "v26"].includes(process.env.ASSET_VERSION) ? process.env.ASSET_VERSION : "v26";
const GAME_SWF_FILE = `gamewo-${ASSET_VERSION}.swf`;
// Ruffle keys loaded movies by URL. A static `?v=v26` could therefore leave
// an earlier movie in a browser after a v26 deployment. This revision changes
// with the shipped SWF while `cdnversion` remains the required `v26` value.
const GAME_SWF_REVISION = (() => {
  if (BUILD_INFO.swf && BUILD_INFO.swf.sha256) return `${ASSET_VERSION}-${String(BUILD_INFO.swf.sha256).slice(0, 12).toLowerCase()}`;
  try { return `${ASSET_VERSION}-${Math.trunc(fs.statSync(path.join(__dirname, "web", GAME_SWF_FILE)).mtimeMs).toString(36)}`; }
  catch { return ASSET_VERSION; }
})();
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 8);
const SOCKET_TRACE = process.env.SOCKET_TRACE === "true";
const BCRYPT_ROUNDS = 12;
const app = express();
let mongoClient;
let db;
let server;

function buildStarterInventory() {
  // New accounts use the finite, canonical profile defaults.  Existing
  // unlimited profiles retain their persisted sandbox flag; registration must
  // never silently turn every player into a sandbox account.
  return {};
}

const STARTER_INVENTORY = buildStarterInventory();

app.disable("x-powered-by");
app.use(express.urlencoded({ extended: false, limit: "16kb" }));
app.use(express.json({ limit: "16kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

function setSessionCookie(req, res, token) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.append("Set-Cookie", `wo_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_HOURS * 60 * 60}${secure ? "; Secure" : ""}`);
}
function clearSessionCookie(req, res) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.append("Set-Cookie", `wo_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`);
}
function getSessionToken(req) {
  const match = String(req.headers.cookie || "").match(/(?:^|;\s*)wo_session=([^;]+)/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}
function sessionHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
async function getSessionUser(req) {
  const token = getSessionToken(req);
  if (!token || !db) return null;
  const now = new Date();
  const session = await db.collection("sessions").findOne({ tokenHash: sessionHash(token), expiresAt: { $gt: now } });
  if (!session) return null;
  const user = await db.collection("users").findOne({ id: session.userId });
  if (!user) return null;
  await db.collection("sessions").updateOne({ _id: session._id }, { $set: { lastUsedAt: now } });
  return { token, user };
}
function gamePage({ dname, token }) {
  const params = JSON.stringify({ dname, snum: token, net: "M", cdnversion: ASSET_VERSION, jotscaleroot: "http://localhost/" }).replace(/</g, "\\u003c");
  const displayName = JSON.stringify(String(dname)).replace(/</g, "\\u003c");
  const encodeURIComponent = (value) => globalThis.encodeURIComponent(value === ASSET_VERSION ? GAME_SWF_REVISION : value);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#141a36"><title>Wild Ones: TURKIYE</title><link rel="stylesheet" href="/theme/private-wars.css"><script>window.__WO_BUILD__=${JSON.stringify(BUILD_INFO).replace(/</g, "\\u003c")};window.RufflePlayer={config:{autoplay:"on",unmuteOverlay:"visible",scale:"showAll",forceScale:true,frameRate:30,quality:"high",openUrlMode:"confirm",socketProxy:[{host:"localhost",port:8000,proxyUrl:(location.protocol==="https:"?"wss://":"ws://")+location.host+"/socket"},{host:"localhost",port:80,proxyUrl:(location.protocol==="https:"?"wss://":"ws://")+location.host+"/socket"}]}};</script><script src="/ruffle/ruffle.js"></script></head><body class="game-page" data-build-id="${BUILD_INFO.buildId}"><main class="game-shell" aria-label="Wild Ones: TURKIYE"><header class="game-topbar"><img src="/theme/wild-ones-turkiye-logo.png" alt="Wild Ones: TURKIYE"><div class="game-status"><i class="status-dot" aria-hidden="true"></i><span id="pilot"></span><form action="/logout" method="post"><button class="logout" type="submit">Sign out</button></form></div></header><section class="game-frame"><div id="game"></div></section></main><script>console.info("wo_runtime",window.__WO_BUILD__);document.getElementById("pilot").textContent=${displayName};const p=window.RufflePlayer.newest().createPlayer();document.getElementById("game").append(p);p.load({url:"/${GAME_SWF_FILE}?v=${encodeURIComponent(ASSET_VERSION)}",parameters:${params}});</script></body></html>`;
}

async function createSession(userId, gameId = null) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  await db.collection("sessions").insertOne({ tokenHash: crypto.createHash("sha256").update(token).digest("hex"), userId, gameId, gameJoinExpiresAt: gameId ? new Date(now.getTime() + 10 * 60 * 1000) : null, createdAt: now, lastUsedAt: now, expiresAt: new Date(now.getTime() + SESSION_HOURS * 60 * 60 * 1000) });
  return token;
}

async function connectDb() {
  mongoClient = new MongoClient(MONGO_URI);
  await mongoClient.connect();
  db = mongoClient.db(DB_NAME);
  const users = db.collection("users");
  const profiles = users.find({}, {
    projection: {
      dname: 1, dnameCanonical: 1, schemaVersion: 1, currentPet: 1,
      nextPetId: 1, ownedPets: 1, stats: 1, wins: 1, losses: 1,
      gamecount: 1, kills: 1, deaths: 1
    }
  });
  for await (const profile of profiles) {
    const before = profileStateSnapshot(profile);
    const normalizedName = canonicalName(profile.dname);
    const canonicalChanged = profile.dnameCanonical !== normalizedName;
    normalizeProfileState(profile);
    if (before !== profileStateSnapshot(profile) || canonicalChanged) {
      const update = profileStateUpdate(profile);
      update.dnameCanonical = normalizedName;
      await users.updateOne({ _id: profile._id }, { $set: update });
    }
  }
  await users.createIndex({ id: 1 }, { name: "id_unique", unique: true });
  await users.createIndex({ dnameCanonical: 1 }, { name: "dname_canonical_unique", unique: true });
  await users.createIndex({ serialNumber: 1 }, { name: "serial_unique", unique: true });
  await users.createIndex({ "stats.wins": -1, dnameCanonical: 1, id: 1 }, { name: "leaderboard_wins" });
  await users.createIndex({ "stats.kills": -1, dnameCanonical: 1, id: 1 }, { name: "leaderboard_kills" });
  await users.createIndex({ xp: -1, dnameCanonical: 1, id: 1 }, { name: "leaderboard_xp" });
  await db.collection("sessions").createIndex({ tokenHash: 1 }, { name: "token_hash_unique", unique: true });
  await db.collection("sessions").createIndex({ expiresAt: 1 }, { name: "session_expiry", expireAfterSeconds: 0 });
  await db.collection("counters").updateOne({ _id: "userId" }, { $setOnInsert: { value: 0 } }, { upsert: true });
}

async function createUserAccount(dname, password) {
  const result = validateCredentials(dname, password);
  if (!result.ok) {
    const error = new Error(result.reason);
    error.statusCode = 400;
    error.code = "invalid_credentials";
    throw error;
  }
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const counter = await db.collection("counters").findOneAndUpdate({ _id: "userId" }, { $inc: { value: 1 } }, { returnDocument: "after", includeResultMetadata: false });
  const user = createProfile({ id: counter.value, dname: result.dname, passwordHash, starterInventory: STARTER_INVENTORY });
  await db.collection("users").insertOne(user);
  return user;
}

app.post(["/register", "/hero"], async (req, res, next) => {
  try {
    const user = await createUserAccount(req.body.dname, req.body.password || req.body.snum);
    const token = await createSession(user.id);
    setSessionCookie(req, res, token);
    res.redirect(303, "/play");
  } catch (error) {
    if (error && error.code === 11000) return res.redirect(303, "/?message=duplicate");
    if (error && error.statusCode) return res.redirect(303, "/?message=invalid");
    next(error);
  }
});

app.post("/login", async (req, res, next) => {
  try {
    const dname = canonicalName(req.body.dname);
    const password = String(req.body.password || req.body.snum || "");
    const user = await db.collection("users").findOne({ dnameCanonical: dname });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.redirect(303, "/?message=login");
    const token = await createSession(user.id);
    setSessionCookie(req, res, token);
    res.redirect(303, "/play");
  } catch (error) { next(error); }
});

app.post("/logout", async (req, res, next) => {
  try {
    const token = getSessionToken(req);
    if (token) await db.collection("sessions").deleteOne({ tokenHash: sessionHash(token) });
    clearSessionCookie(req, res);
    res.redirect(303, "/?message=signedout");
  } catch (error) { next(error); }
});

app.get("/health/live", (_req, res) => res.json({ ok: true }));
app.get("/health/ready", async (_req, res) => {
  try {
    await db.command({ ping: 1 });
    const swf = fs.existsSync(path.join(__dirname, "web", GAME_SWF_FILE));
    const ruffle = fs.existsSync(path.join(__dirname, "web", "ruffle", "ruffle.js"));
    if (!swf || !ruffle) return res.status(503).json({ ok: false, swf, ruffle });
    res.json({ ok: true, swf, ruffle });
  } catch { res.status(503).json({ ok: false }); }
});
app.get("/crossdomain.xml", (_req, res) => res.type("application/xml").sendFile(path.join(__dirname, "web", "crossdomain.xml")));
app.get("/play", async (req, res, next) => {
  try {
    const session = await getSessionUser(req);
    if (!session) return res.redirect(303, "/");
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(gamePage({ dname: session.user.dname, token: session.token }));
  } catch (error) { next(error); }
});
app.get("/", async (req, res, next) => {
  try {
    const session = await getSessionUser(req);
    if (session) return res.redirect(303, "/play");
    res.sendFile(path.join(__dirname, "web", "index.html"));
  } catch (error) { next(error); }
});

const emptyMidgrounds = new Set(["/images/r1_waterfall-C/wf_mid.swf", "/images/pw-big-top/bt_mid.swf", "/images/r1_kitchen-A/kt_mid.swf", "/images/r1_moonlake-C/ml_mid.swf", "/images/r1_antfarm-A/af_mid.swf", "/images/r1_lab-A/lb_mid.swf", "/images/No%20Midground", "/images/No Midground"]);
// The movie still preloads these legacy preview names with a .gif suffix,
// while the bundled source files are the matching map-specific PNGs. Keep
// the same scene and let the Loader complete instead of emitting Ruffle 404s.
const previewFormatAliases = new Map([
  ["/images/r1_antfarm-A/af_preview.gif", "/images/r1_antfarm-A/af_preview.png"],
  ["/images/r1_kitchen-A/kt_preview.gif", "/images/r1_kitchen-A/kt_preview.png"],
  ["/images/r1_lab-A/lb_preview.gif", "/images/r1_lab-A/lb_preview.png"]
]);
// A tiny, transparent Flash 9 movie: it satisfies legacy Loader completion without drawing anything.
const EMPTY_SWF = Buffer.from([0x46, 0x57, 0x53, 0x09, 0x12, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x18, 0x01, 0x00, 0x40, 0x00, 0x00, 0x00]);
app.get(/^\/images\/.+/, (req, res, next) => {
  const requested = req.originalUrl.split("?")[0];
  const previewAlias = previewFormatAliases.get(requested);
  if (previewAlias) return res.redirect(302, previewAlias);
  // v26 never remaps an unavailable map to a different scene.  The SWF only
  // requests transparent midground placeholders for the verified catalogue.
  return emptyMidgrounds.has(requested) ? res.type("application/x-shockwave-flash").send(EMPTY_SWF) : next();
});
app.use("/ruffle", express.static(path.join(__dirname, "web", "ruffle"), { immutable: true, maxAge: "365d" }));
app.use("/assets/json", express.static(path.join(__dirname, "assets", "json")));
app.use("/images", express.static(path.join(__dirname, "images")));
app.use("/assets", express.static(path.join(__dirname, "assets")));
// Browsers request this implicitly even though the Flash shell does not use a
// separate icon. Redirect it to the themed logo so normal page loads stay
// free of a misleading 404 console error.
app.get("/favicon.ico", (_req, res) => res.redirect(302, "/theme/wild-ones-turkiye-logo.png"));
app.use(express.static(path.join(__dirname, "web")));
app.use((req, res) => res.status(404).send("Not Found"));
app.use((error, _req, res, _next) => { console.error("web_error", error.message); res.status(500).send("Server error."); });

function startBridge(httpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  let bridgeSequence = 0;
  httpServer.on("upgrade", (req, socket, head) => {
    if (req.url !== "/socket") return;
    const origin = req.headers.origin;
    const expected = `http://${req.headers.host}`;
    if (origin && origin !== expected && origin !== expected.replace("http://", "https://")) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (ws) => {
    const bridgeId = ++bridgeSequence;
    const upstream = net.connect({ host: GAME_HOST, port: GAME_PORT });
    const startedAt = Date.now();
    let clientBytes = 0;
    let serverBytes = 0;
    let serverQueueBytes = 0;
    let serverSendActive = false;
    let serverBackpressureSince = 0;
    const serverQueue = [];
    const trace = (event, details = {}) => {
      if (!SOCKET_TRACE) return;
      console.log("socket_bridge", {
        bridgeId,
        event,
        elapsedMs: Date.now() - startedAt,
        clientBytes,
        serverBytes,
        ...details
      });
    };
    const close = (code = 1000, reason = "") => {
      if (ws.readyState === ws.OPEN) ws.close(code, reason);
      upstream.destroy();
    };
    const flushServerQueue = () => {
      if (serverSendActive || ws.readyState !== ws.OPEN || serverQueue.length === 0) return;
      if (ws.bufferedAmount > 512 * 1024) {
        if (!serverBackpressureSince) serverBackpressureSince = Date.now();
        if (Date.now() - serverBackpressureSince > 5000) {
          trace("server_backpressure_timeout", { bufferedAmount: ws.bufferedAmount, serverQueueBytes });
          return close(1013, "bridge backpressure");
        }
        setTimeout(flushServerQueue, 10).unref();
        return;
      }
      serverBackpressureSince = 0;
      const data = serverQueue.shift();
      serverQueueBytes -= data.length;
      serverSendActive = true;
      ws.send(data, { binary: true }, (error) => {
        serverSendActive = false;
        if (error) {
          trace("server_send_error", { message: error.message });
          return close(1011, "bridge send failed");
        }
        if (serverQueueBytes < 512 * 1024 && upstream.isPaused()) upstream.resume();
        flushServerQueue();
      });
    };
    let idle = setTimeout(close, 5 * 60 * 1000);
    const touch = () => { clearTimeout(idle); idle = setTimeout(close, 5 * 60 * 1000); idle.unref(); };
    trace("open");
    ws.on("message", (data, isBinary) => {
      if (!isBinary) { trace("client_non_binary"); return close(); }
      clientBytes += data.length;
      touch();
      if (!upstream.write(data)) ws._socket.pause();
    });
    upstream.on("drain", () => ws._socket.resume());
    upstream.on("data", (data) => {
      serverBytes += data.length;
      touch();
      if (ws.readyState !== ws.OPEN) return;
      serverQueue.push(data);
      serverQueueBytes += data.length;
      if (serverQueueBytes > 2 * 1024 * 1024) {
        upstream.pause();
        trace("server_queue_paused", { bufferedAmount: ws.bufferedAmount, serverQueueBytes });
      }
      flushServerQueue();
    });
    ws.on("close", (code, reason) => {
      trace("client_close", { code, reason: reason.toString(), bufferedAmount: ws.bufferedAmount, serverQueueBytes });
      clearTimeout(idle);
      upstream.destroy();
    });
    ws.on("error", (error) => { trace("client_error", { message: error.message }); close(); });
    upstream.on("error", (error) => { trace("upstream_error", { message: error.message }); close(); });
    upstream.on("close", (hadError) => { trace("upstream_close", { hadError }); clearTimeout(idle); if (ws.readyState === ws.OPEN) ws.close(); });
  });
}

async function start() {
  await connectDb();
  server = http.createServer(app);
  startBridge(server);
  await new Promise((resolve) => server.listen(PORT, "0.0.0.0", resolve));
  console.log(`web listening on ${PORT} buildId=${BUILD_INFO.buildId} swf=${BUILD_INFO.swf && BUILD_INFO.swf.sha256 || "unknown"}`);
}
async function shutdown() { if (server) await new Promise((resolve) => server.close(resolve)); if (mongoClient) await mongoClient.close(); }
process.on("SIGTERM", () => shutdown().finally(() => process.exit(0)));
process.on("SIGINT", () => shutdown().finally(() => process.exit(0)));
start().catch((error) => { console.error(error); process.exit(1); });
