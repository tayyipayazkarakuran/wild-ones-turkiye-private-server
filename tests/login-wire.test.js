"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Handler = require("../game/handler.js");

test("login emits one initial player profile packet", async () => {
  const profile = { id: 17, dname: "wire-test" };
  let setupPackets = 0;
  let updatePackets = 0;
  const client = {
    db: {
      async fetchSession(token) {
        assert.equal(token, "valid-token");
        return { userId: profile.id };
      },
      async fetch(query) {
        assert.deepEqual(query, { id: profile.id });
        return profile;
      }
    },
    setupPlayer(doc) {
      assert.equal(doc, profile);
      return 1;
    },
    sendPlayerSetup() { setupPackets++; },
    sendUpdate() { updatePackets++; }
  };

  const target = new Handler({});
  await target.handleLogin(client, { dname: "wire-test", snum: "valid-token" });

  assert.equal(client.loggedIn, true);
  assert.equal(client.authToken, "valid-token");
  assert.equal(setupPackets, 1);
  assert.equal(updatePackets, 0);
});
