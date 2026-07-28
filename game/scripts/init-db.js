"use strict";
const { MongoClient } = require("mongodb");
const {
  normalizeProfileState,
  profileStateSnapshot,
  profileStateUpdate
} = require("../../shared/profile-state.js");

async function main() {
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const db = client.db(process.env.DB_NAME || "emu");
  await db.collection("sessions").createIndexes([
    { key: { tokenHash: 1 }, name: "token_hash_unique", unique: true },
    { key: { expiresAt: 1 }, name: "session_expiry", expireAfterSeconds: 0 }
  ]);
  await db.collection("counters").updateOne({ _id: "userId" }, { $setOnInsert: { value: 0 } }, { upsert: true });
  const users = db.collection("users");
  const cursor = users.find({}, {
    projection: {
      id: 1, dname: 1, dnameCanonical: 1, schemaVersion: 1,
      currentPet: 1, nextPetId: 1, ownedPets: 1,
      stats: 1, wins: 1, losses: 1, gamecount: 1, kills: 1, deaths: 1
    }
  });
  for await (const profile of cursor) {
    const before = profileStateSnapshot(profile);
    const canonicalName = String(profile.dname || "").normalize("NFKC")
      .trim().toLocaleLowerCase("en-US");
    const canonicalChanged = profile.dnameCanonical !== canonicalName;
    normalizeProfileState(profile);
    if (before !== profileStateSnapshot(profile) || canonicalChanged) {
      const update = profileStateUpdate(profile);
      update.dnameCanonical = canonicalName;
      await users.updateOne({ _id: profile._id }, { $set: update });
    }
  }
  await users.createIndexes([
    { key: { id: 1 }, name: "id_unique", unique: true },
    { key: { dnameCanonical: 1 }, name: "dname_canonical_unique", unique: true },
    { key: { serialNumber: 1 }, name: "serial_unique", unique: true },
    { key: { "stats.wins": -1, dnameCanonical: 1, id: 1 }, name: "leaderboard_wins" },
    { key: { "stats.kills": -1, dnameCanonical: 1, id: 1 }, name: "leaderboard_kills" },
    { key: { xp: -1, dnameCanonical: 1, id: 1 }, name: "leaderboard_xp" }
  ]);
  await client.close();
}
main().catch((error) => { console.error(error); process.exit(1); });
