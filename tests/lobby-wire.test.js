"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const LobbyClient = require("../game/client/client.lobby.js");

test("the first lobby profile frame uses setPlayer before normal player updates", () => {
  const writes = [];
  const client = new LobbyClient({
    sock: { writable: true, write(value) { writes.push(value); } },
    db: {},
    WOPW: {},
    id: "wire-client",
    connectionType: "lobby"
  });
  client.authToken = "session-token";
  client.player = {
    id: 1,
    dname: "wire-test",
    snum: "legacy-token",
    userWeaponsOwned: { grenade: 5 },
    userWeaponsEquipped: ["walk", "grenade"],
    ownedPets: {},
    allowedMaps: ["Critter Falls"]
  };

  client.sendPlayerSetup();

  assert.equal(writes.length, 1);
  const header = "Originality is undetected plagiarism.\r\n\r\n";
  assert.equal(writes[0].startsWith(header), true);
  const bodyLength = Number(writes[0].slice(header.length, header.length + 6));
  const packet = JSON.parse(writes[0].slice(header.length + 6));
  assert.equal(bodyLength, Buffer.byteLength(JSON.stringify(packet), "utf8"));
  assert.equal(packet.command, "setPlayer");
  assert.equal(packet.snum, "session-token");
  assert.equal(client.player.command, "player");
});
