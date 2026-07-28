"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createProfile } = require("../shared/profile.js");
const { MEDAL_CATALOG, recordMedalEvent } = require("../shared/progression.js");

test("medal events use only the v26 movie catalogue and unlock its authored tiers", () => {
  const player = createProfile({ id: 77, dname: "MedalTester", passwordHash: "hash" });

  assert.deepEqual(MEDAL_CATALOG.pack_rat, [3, 6, 12]);
  assert.deepEqual(recordMedalEvent(player, "first_kill"), { count: 0, unlocked: [] });
  assert.deepEqual(recordMedalEvent(player, "pack_rat", 2, 100), { count: 2, unlocked: [] });
  assert.deepEqual(recordMedalEvent(player, "pack_rat", 1, 101), { count: 3, unlocked: [3] });
  assert.deepEqual(recordMedalEvent(player, "pack_rat", 3, 102), { count: 6, unlocked: [6] });

  assert.deepEqual(player.medals.medalList.pack_rat, { 3: 101, 6: 102 });
  assert.equal(player.medals.medalCounts.pack_rat, 6);
  assert.equal(player.medals.totalMedals, 2);
});
