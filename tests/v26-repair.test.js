"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const Handler = require("../game/handler.js");
const Slot = require("../game/slot.js");
const WOPW = require("../game/wopw.js");
const GameClient = require("../game/client/client.game.js");
const {
  normalizeProfileState,
  recordActivePetStat
} = require("../shared/profile-state.js");
const { canonicalRoomName } = require("../shared/room-name.js");

const root = path.resolve(__dirname, "..");
const config = JSON.parse(fs.readFileSync(path.join(root, "game", "crumbs", "config.json"), "utf8"));
const maps = JSON.parse(fs.readFileSync(path.join(root, "web", "assets", "json", "Maps.dat"), "utf8"));
const mapsObj = Object.fromEntries(maps.map((map) => [map.name, map]));

test("profile migration preserves the largest counters and repairs active pet identity", () => {
  const profile = {
    stats: { games: 1, wins: 2, losses: 1, kills: 3, deaths: 4 },
    gamecount: 4,
    wins: 5,
    losses: 3,
    kills: 7,
    deaths: 2,
    currentPet: 99,
    nextPetId: 2,
    ownedPets: {
      8: { id: 1, type: "bat", stats: { wins: 2, played: 3 } },
      3: { id: 77, type: "dragon", kills: 4 }
    }
  };
  normalizeProfileState(profile);
  assert.deepEqual(profile.stats, {
    games: 8, wins: 5, losses: 3, kills: 7, deaths: 4,
    damageDealt: 0, damageTaken: 0, shotsFired: 0, moves: 0, crates: 0, purchases: 0
  });
  assert.equal(profile.gamecount, 8);
  assert.equal(profile.currentPet, "3");
  assert.equal(profile.ownedPets["3"].id, "3");
  assert.equal(profile.ownedPets["8"].id, "8");
  assert.equal(profile.ownedPets["8"].played, 3);
  assert.equal(profile.nextPetId, 9);
});

test("deleting pets never renumbers survivors and changes currentPet only when active pet is removed", () => {
  const sent = [];
  const client = {
    connectionType: "lobby",
    player: {
      currentPet: "8",
      ownedPets: {
        3: { id: "3", type: "rabbit" },
        8: { id: "8", type: "bat" },
        12: { id: "12", type: "dragon" }
      }
    },
    sendPacket(packet) { sent.push(packet); },
    sendUpdate() {},
    updatePlayerData() {}
  };
  const handler = new Handler({});
  assert.equal(handler.handleDeletePet(client, { petId: "3" }), true);
  assert.equal(client.player.currentPet, "8");
  assert.deepEqual(Object.keys(client.player.ownedPets), ["8", "12"]);
  assert.equal(handler.handleDeletePet(client, { petId: "8" }), true);
  assert.equal(client.player.currentPet, "12");
  assert.deepEqual(Object.keys(client.player.ownedPets), ["12"]);
  assert.equal(sent.at(-1).currentPet, "12");
});

test("pet match counters, earnings and last-played update only the active pet", () => {
  const player = {
    currentPet: "7",
    gold: 0,
    ownedPets: {
      2: { id: "2", type: "rabbit" },
      7: { id: "7", type: "dragon" }
    }
  };
  recordActivePetStat(player, "played", 1, 123456);
  recordActivePetStat(player, "wins", 1);
  GameClient.prototype.addGold.call({
    player,
    sendUpdate() {},
    updatePlayerData() {}
  }, 25, false);
  assert.equal(player.ownedPets["7"].played, 1);
  assert.equal(player.ownedPets["7"].wins, 1);
  assert.equal(player.ownedPets["7"].gold, 25);
  assert.equal(player.ownedPets["7"].lastPlayed, 123456);
  assert.equal(player.ownedPets["2"].played, 0);
  assert.equal(player.ownedPets["2"].gold, 0);
});

test("match progression persists deltas under one idempotent match id and refreshes both connections", async () => {
  const sent = [];
  const lobbyPackets = [];
  const writes = [];
  const player = {
    id: 44,
    xp: 100,
    gold: 200,
    treats: 5,
    stats: { games: 2, wins: 1, losses: 1, kills: 3, deaths: 2 },
    wins: 1,
    losses: 1,
    gamecount: 2,
    kills: 3,
    deaths: 2,
    currentPet: "7",
    ownedPets: {
      7: {
        id: "7", type: "rabbit", played: 2, wins: 1, losses: 1,
        kills: 3, deaths: 2, gold: 20, lastPlayed: 1
      }
    },
    userWeaponsOwned: { grenade: 5 }
  };
  const client = {
    isBot: false,
    player,
    db: {
      async applyMatchProgression(payload) {
        writes.push(payload);
        return { ok: true, duplicate: false, user: { ...player, updatedAt: new Date(1234) } };
      }
    },
    sendUpdate() {},
    sendPacket(packet) { sent.push(packet); }
  };
  const slot = new Slot({
    levelsObj: [{ xp: 0 }, { xp: 100 }],
    mapsObj: { "Critter Falls": { positions: [[100, 100], [300, 100]] } },
    petsObj: {},
    accessoriesObj: {},
    weaponsObj: {},
    packetHandler: {},
    getLobbyLoad: () => 0,
    sendLobbyPlayerPacket(id, packet) { lobbyPackets.push({ id, packet }); }
  }, "progress-room", "Critter Falls", 2, 300000, 20000);
  slot.matchId = "progress-room:seed:finish";
  slot.captureProgressionSnapshot(client);
  player.xp += 15;
  player.gold += 9;
  player.stats.games += 1;
  player.stats.wins += 1;
  player.gamecount += 1;
  player.wins += 1;
  player.ownedPets["7"].played += 1;
  player.ownedPets["7"].wins += 1;
  player.ownedPets["7"].gold += 9;
  player.ownedPets["7"].lastPlayed = 1234;
  await slot.persistProgression(client);

  assert.equal(writes.length, 1);
  assert.equal(writes[0].matchId, slot.matchId);
  assert.equal(writes[0].increments.xp, 15);
  assert.equal(writes[0].increments.gold, 9);
  assert.equal(writes[0].increments["stats.games"], 1);
  assert.equal(writes[0].increments["stats.wins"], 1);
  assert.equal(writes[0].increments.gamecount, 1);
  assert.equal(writes[0].increments.wins, 1);
  assert.equal(writes[0].increments["ownedPets.7.played"], 1);
  assert.equal(writes[0].sets["ownedPets.7.lastPlayed"], 1234);
  assert.equal(sent.at(-1).command, "match_progression_return");
  assert.equal(lobbyPackets.at(-1).packet.matchId, slot.matchId);
  slot.initialize();
});

test("database match progression uses an atomic receipt guard", () => {
  const source = fs.readFileSync(path.join(root, "game", "database.js"), "utf8");
  assert.match(source, /matchReceipts\.\$\{matchKey\}/);
  assert.match(source, /findOneAndUpdate\(\s*\{ id: userId, \[matchPath\]: \{ \$exists: false \} \}/);
  assert.match(source, /\$inc = safeIncrements/);
});

test("leaderboard response is paged, level-derived and excludes private profile fields", async () => {
  const packets = [];
  const handler = new Handler({ levelsObj: [{ xp: 0 }, { xp: 100 }, { xp: 300 }] });
  const client = {
    player: { id: 9 },
    db: {
      async leaderboardPage(sortKey, startRank, pageSize, userId) {
        assert.deepEqual([sortKey, startRank, pageSize, userId], ["kills", 27, 26, 9]);
        return {
          sortKey: "kills",
          startRank: 27,
          tableSize: 52,
          myRank: 31,
          revision: 1234,
          results: [{
            id: 9,
            dname: "Oyuncu",
            net: "M",
            xp: 150,
            passwordHash: "must-not-leak",
            stats: { games: 10, wins: 4, losses: 6, kills: 12, deaths: 8 }
          }]
        };
      }
    },
    sendPacket(packet) { packets.push(packet); }
  };
  await handler.handleLeaderboardFetch(client, {
    sort_key: "kills", start_rank: 27, num_results: 26
  });
  assert.deepEqual(packets[0], {
    command: "leaderboard_return",
    sort_key: "kills",
    start_rank: 27,
    results: [{
      rank: 27,
      dname: "Oyuncu",
      level: 2,
      wins: 4,
      losses: 6,
      kills: 12,
      deaths: 8,
      games: 10,
      winRate: 40,
      neighbors: 0,
      snum: "9",
      net: "M"
    }],
    table_size: 52,
    my_rank: 31,
    revision: 1234
  });
  assert.equal(JSON.stringify(packets[0]).includes("password"), false);
});

test("leaderboard selected-player response contains safe canonical detail fields", async () => {
  const packets = [];
  const handler = new Handler({ levelsObj: [{ xp: 0 }, { xp: 100 }, { xp: 300 }] });
  const client = {
    db: {
      async fetch(query) {
        assert.deepEqual(query, { id: 42 });
        return {
          id: 42,
          dname: "Detay",
          net: "M",
          xp: 150,
          passwordHash: "must-not-leak",
          currentPet: 7,
          ownedPets: {
            7: {
              id: 3, type: "bat", name: "Wing", color1: 1, color2: 2,
              stats: { played: 3, wins: 2, kills: 4 }
            },
            9: { id: 9, type: "dragon", name: "Private reserve pet" }
          },
          stats: { games: 5, wins: 2, losses: 3, kills: 8, deaths: 6 }
        };
      }
    },
    sendPacket(packet) { packets.push(packet); }
  };
  await handler.handleLeaderboardPlayerFetch(client, { snum: "42" });
  assert.deepEqual(packets[0], {
    command: "leaderboard_player",
    id: "42",
    snum: "42",
    dname: "Detay",
    net: "M",
    xp: 150,
    level: 2,
    gamecount: 5,
    games: 5,
    wins: 2,
    losses: 3,
    kills: 8,
    deaths: 6,
    winRate: 40,
    neighbors: 0,
    currentPet: "7",
    ownedPets: {
      7: {
        id: "7", type: "bat", name: "Wing", gender: "M", pers: "brave",
        color1: 1, color2: 2, accessories: [],
        played: 3, wins: 2, losses: 0, kills: 4, deaths: 0, gold: 0, last: 0
      }
    }
  });
  assert.equal(JSON.stringify(packets[0]).includes("password"), false);
  assert.equal(JSON.stringify(packets[0]).includes("reserve"), false);
});

test("room names use one Unicode normalization and case-insensitive room key", () => {
  assert.deepEqual(canonicalRoomName("  ＷİＬＤ   Ones  "), {
    ok: true,
    code: null,
    displayName: "WİLD-Ones",
    key: "wild-ones"
  });
  assert.equal(canonicalRoomName("WİLD-Ones").key, canonicalRoomName("wild-ones").key);
  assert.equal(canonicalRoomName("bad room!").code, "invalid_name");
  assert.equal(canonicalRoomName("x".repeat(25)).code, "invalid_name");
});

test("all seven modes preserve their exact duration, turn, life, team, wind and balance flags", () => {
  const context = { config, mapsObj };
  const modes = [
    ["Point Match", 4, 5, 20, 0, false, false, true],
    ["Team Point Match", 4, 5, 20, 0, true, false, true],
    ["Last One Standing", 4, 5, 20, 1, false, false, true],
    ["Last Team Standing", 4, 5, 20, 1, true, false, true],
    ["Super Speed", 4, 5, 10, 0, false, false, true],
    ["Skill Match", 4, 5, 20, 1, false, true, false],
    ["Custom Game", 6, 10, 30, 0, true, false, true]
  ];
  for (const [name, playerCount, gameDuration, turnDuration, nu, te, ba, wi] of modes) {
    const result = WOPW.prototype.validateMapDetails.call(context, null, {
      mode: name,
      mapName: "Critter Falls",
      playerCount,
      gameDuration,
      turnDuration,
      nu,
      te,
      ba,
      wi
    });
    assert.equal(result.mapError, undefined, name);
    assert.deepEqual(
      [result.playerCount, result.gameDuration, result.turnDuration, result.nu, result.te, result.ba, result.wi],
      [playerCount, gameDuration, turnDuration, nu, te, ba, wi],
      name
    );
  }
});

function matchParticipant(id) {
  return {
    isBot: false,
    player: {
      id,
      dname: `Player-${id}`,
      gold: 0,
      currentPet: "2",
      ownedPets: { 1: { id: "1", type: "rabbit" }, 2: { id: "2", type: "bat" } }
    },
    avatar: { dead: false, properties: { hp: 100 } },
    isDead() { return this.avatar.dead; },
    addXP() {},
    addGold(amount) { GameClient.prototype.addGold.call(this, amount, false); },
    sendGameStats() {},
    sendPacket() {},
    sendUpdate() {},
    updatePlayerData() {}
  };
}

test("team result awards every member of the winning team and records active-pet match stats", () => {
  const wopw = {
    config: { ...config, goldSet: [], treatSet: [] },
    mapsObj,
    petsObj: {},
    accessoriesObj: {},
    weaponsObj: {},
    packetHandler: {},
    getLobbyLoad: () => 0
  };
  const slot = new Slot(wopw, "team-result", "Critter Falls", 4, 300000, 20000, { te: true });
  try {
    slot.clients = {
      1: matchParticipant(1),
      2: matchParticipant(2),
      3: matchParticipant(3),
      4: matchParticipant(4)
    };
    slot.matchPlayerIds = ["1", "2", "3", "4"];
    slot.scores = { 1: 1, 2: 3, 3: 2, 4: 4 };
    slot.deathCounts = { 1: 1, 2: 0, 3: 1, 4: 0 };
    slot.updateGameStatus("running");
    slot.endGame("test");
    assert.equal(slot.clients[2].player.stats.wins, 1);
    assert.equal(slot.clients[4].player.stats.wins, 1);
    assert.equal(slot.clients[1].player.stats.losses, 1);
    assert.equal(slot.clients[3].player.stats.losses, 1);
    for (const participant of Object.values(slot.clients)) {
      assert.equal(participant.player.stats.games, 1);
      assert.equal(participant.player.ownedPets["2"].played, 1);
      assert.equal(participant.player.ownedPets["1"].played, 0);
      assert.ok(participant.player.ownedPets["2"].gold > 0);
      assert.ok(participant.player.ownedPets["2"].lastPlayed > 0);
    }
  } finally {
    slot.initialize();
  }
});
