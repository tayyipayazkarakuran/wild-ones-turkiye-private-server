const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const {
  normalizeProfileState,
  profileStateSnapshot,
  profileStateUpdate
} = require('../shared/profile-state.js');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'emu';

let client;
let db;

class Database {
  async connect() {
    try {
      client = new MongoClient(MONGO_URI);
      await client.connect();
      db = client.db(DB_NAME);
      await this.migrateProfiles();
      await this.ensureIndexes();
      console.log('Connected to MongoDB');
    } catch (err) {
      console.error('MongoDB connection error:', err);
      throw err;
    }
  }

  async update(condition, data) {
    return db.collection('users').updateOne(condition, { $set: data });
  }

  async ensureIndexes() {
    await db.collection('users').createIndexes([
      { key: { id: 1 }, name: 'id_unique', unique: true },
      { key: { dnameCanonical: 1 }, name: 'dname_canonical_unique', unique: true },
      { key: { serialNumber: 1 }, name: 'serial_unique', unique: true },
      { key: { 'stats.wins': -1, dnameCanonical: 1, id: 1 }, name: 'leaderboard_wins' },
      { key: { 'stats.kills': -1, dnameCanonical: 1, id: 1 }, name: 'leaderboard_kills' },
      { key: { xp: -1, dnameCanonical: 1, id: 1 }, name: 'leaderboard_xp' }
    ]);
  }

  async migrateProfiles() {
    const users = db.collection('users');
    const cursor = users.find({}, {
      projection: {
        id: 1, dname: 1, dnameCanonical: 1, schemaVersion: 1,
        currentPet: 1, nextPetId: 1, ownedPets: 1,
        stats: 1, wins: 1, losses: 1, gamecount: 1, kills: 1, deaths: 1
      }
    });
    let migrated = 0;
    for await (const profile of cursor) {
      const before = profileStateSnapshot(profile);
      const canonicalName = String(profile.dname || "").normalize("NFKC")
        .trim().toLocaleLowerCase("en-US");
      const canonicalChanged = profile.dnameCanonical !== canonicalName;
      normalizeProfileState(profile);
      if (before === profileStateSnapshot(profile) && !canonicalChanged) continue;
      const update = profileStateUpdate(profile);
      update.dnameCanonical = canonicalName;
      await users.updateOne({ _id: profile._id }, { $set: update });
      migrated++;
    }
    if (migrated) console.log(`Migrated ${migrated} player profile(s) to schema v3`);
    return migrated;
  }

  async count(condition) {
    return db.collection('users').countDocuments(condition);
  }

  async fetch(condition) {
    const user = await db.collection('users').findOne(condition);
    if (user) normalizeProfileState(user);
    return user;
  }

  async leaderboardPage(sortKey, startRank, pageSize, currentUserId) {
    const users = db.collection('users');
    const safeSortKey = ['wins', 'kills', 'level', 'neighbors'].includes(sortKey) ? sortKey : 'wins';
    const start = Math.max(1, Math.floor(Number(startRank) || 1));
    const limit = Math.max(1, Math.min(26, Math.floor(Number(pageSize) || 26)));
    const projection = {
      _id: 0, id: 1, dname: 1, dnameCanonical: 1, net: 1, xp: 1,
      stats: 1, wins: 1, losses: 1, gamecount: 1, kills: 1, deaths: 1
    };
    const sortField = safeSortKey === 'wins'
      ? 'stats.wins'
      : (safeSortKey === 'kills' ? 'stats.kills' : (safeSortKey === 'level' ? 'xp' : null));
    const sort = sortField
      ? { [sortField]: -1, dnameCanonical: 1, id: 1 }
      : { dnameCanonical: 1, id: 1 };
    const [results, tableSize, me] = await Promise.all([
      users.find({}, { projection }).sort(sort).skip(start - 1).limit(limit).toArray(),
      users.countDocuments({}),
      users.findOne({ id: currentUserId }, { projection })
    ]);

    let myRank = 0;
    if (me) {
      normalizeProfileState(me);
      const canonical = String(me.dnameCanonical || '').toLocaleLowerCase('en-US');
      const tieBreak = [
        { dnameCanonical: { $lt: canonical } },
        { dnameCanonical: canonical, id: { $lt: me.id } }
      ];
      let aheadFilter;
      if (sortField) {
        const value = sortField === 'xp'
          ? Math.max(0, Number(me.xp) || 0)
          : Math.max(0, Number(safeSortKey === 'wins' ? me.stats.wins : me.stats.kills) || 0);
        aheadFilter = {
          $or: [
            { [sortField]: { $gt: value } },
            { [sortField]: value, $or: tieBreak }
          ]
        };
      } else {
        aheadFilter = { $or: tieBreak };
      }
      myRank = (await users.countDocuments(aheadFilter)) + 1;
    }

    for (const result of results) normalizeProfileState(result);
    return {
      sortKey: safeSortKey,
      startRank: start,
      pageSize: limit,
      results,
      tableSize,
      myRank,
      revision: Date.now()
    };
  }

  async applyMatchProgression({ userId, matchId, increments = {}, sets = {}, receipt = {} }) {
    const users = db.collection('users');
    const normalizedMatchId = String(matchId || '');
    if (!normalizedMatchId || normalizedMatchId.length > 256) {
      return { ok: false, reason: 'invalid_match_id' };
    }
    const matchKey = crypto.createHash('sha256').update(normalizedMatchId).digest('hex');
    const matchPath = `matchReceipts.${matchKey}`;
    const existing = await users.findOne({ id: userId, [matchPath]: { $exists: true } });
    if (existing) {
      normalizeProfileState(existing);
      return { ok: true, duplicate: true, user: existing, matchKey };
    }

    const operators = {
      $set: {
        ...sets,
        [matchPath]: {
          matchId: normalizedMatchId,
          receipt,
          createdAt: new Date()
        },
        updatedAt: new Date()
      }
    };
    const safeIncrements = Object.fromEntries(Object.entries(increments).filter(([, value]) =>
      Number.isFinite(Number(value)) && Number(value) !== 0
    ).map(([key, value]) => [key, Number(value)]));
    if (Object.keys(safeIncrements).length) operators.$inc = safeIncrements;

    const result = await users.findOneAndUpdate(
      { id: userId, [matchPath]: { $exists: false } },
      operators,
      { returnDocument: 'after', includeResultMetadata: false }
    );
    if (result) {
      normalizeProfileState(result);
      return { ok: true, duplicate: false, user: result, matchKey };
    }
    const current = await users.findOne({ id: userId });
    if (!current) return { ok: false, reason: 'profile_not_found', matchKey };
    normalizeProfileState(current);
    return {
      ok: Boolean(current.matchReceipts && current.matchReceipts[matchKey]),
      duplicate: true,
      reason: current.matchReceipts && current.matchReceipts[matchKey] ? null : 'conflict',
      user: current,
      matchKey
    };
  }

  async applyPurchase({ userId, requestId, kind, item, quantity, currency, cost, filter = {}, update = {}, receipt = {} }) {
    const users = db.collection('users');
    const normalizedRequestId = String(requestId || '');
    if (!normalizedRequestId || normalizedRequestId.length > 128) {
      return { ok: false, reason: 'invalid_request_id' };
    }
    const transactionKey = crypto.createHash('sha256')
      .update(`${kind}:${normalizedRequestId}`)
      .digest('hex');
    const transactionPath = `transactions.${transactionKey}`;
    const projection = {
      _id: 0, id: 1, gold: 1, treats: 1, userAccessories: 1, durability: 1,
      allowedMaps: 1, userWeaponsOwned: 1, ownedPets: 1, currentPet: 1,
      nextPetId: 1, transactions: 1, collections: 1, stats: 1, wins: 1, losses: 1,
      gamecount: 1, kills: 1, deaths: 1, schemaVersion: 1
    };
    const existing = await users.findOne(
      { id: userId, [transactionPath]: { $exists: true } },
      { projection }
    );
    if (existing) {
      normalizeProfileState(existing);
      const transaction = existing.transactions[transactionKey];
      return {
        ok: transaction.ok !== false,
        duplicate: true,
        reason: transaction.reason || null,
        user: existing,
        transactionKey,
        transaction
      };
    }

    const purchaseFilter = { id: userId, [transactionPath]: { $exists: false }, ...filter };
    const normalizedCost = Math.max(0, Math.floor(Number(cost) || 0));
    if (normalizedCost > 0) purchaseFilter[currency] = { $gte: normalizedCost };

    const operators = {};
    for (const operator of ['$inc', '$set', '$addToSet', '$push']) {
      if (update[operator] && Object.keys(update[operator]).length) operators[operator] = { ...update[operator] };
    }
    if (!operators.$inc) operators.$inc = {};
    if (normalizedCost > 0) operators.$inc[currency] = Number(operators.$inc[currency] || 0) - normalizedCost;
    if (!operators.$set) operators.$set = {};
    operators.$set[transactionPath] = {
      ok: true,
      requestId: normalizedRequestId,
      kind: String(kind || ''),
      item: String(item || ''),
      quantity: Math.max(1, Math.floor(Number(quantity) || 1)),
      currency: String(currency || ''),
      cost: normalizedCost,
      receipt,
      createdAt: new Date()
    };
    operators.$set.updatedAt = new Date();

    const result = await users.findOneAndUpdate(
      purchaseFilter,
      operators,
      { returnDocument: 'after', includeResultMetadata: false, projection }
    );
    if (result) {
      normalizeProfileState(result);
      return {
        ok: true,
        duplicate: false,
        user: result,
        transactionKey,
        transaction: result.transactions && result.transactions[transactionKey]
      };
    }

    const current = await users.findOne({ id: userId }, { projection });
    if (!current) return { ok: false, reason: 'profile_not_found' };
    normalizeProfileState(current);
    if (current.transactions && current.transactions[transactionKey]) {
      const transaction = current.transactions[transactionKey];
      return {
        ok: transaction.ok !== false,
        duplicate: true,
        reason: transaction.reason || null,
        user: current,
        transactionKey,
        transaction
      };
    }
    const failureReason = normalizedCost > 0 &&
      Math.max(0, Number(current[currency]) || 0) < normalizedCost
      ? 'insufficient_funds'
      : 'conflict';
    const failureTransaction = {
      ok: false,
      reason: failureReason,
      requestId: normalizedRequestId,
      kind: String(kind || ''),
      item: String(item || ''),
      quantity: Math.max(1, Math.floor(Number(quantity) || 1)),
      currency: String(currency || ''),
      cost: normalizedCost,
      receipt,
      createdAt: new Date()
    };
    const failureWrite = await users.updateOne(
      { id: userId, [transactionPath]: { $exists: false } },
      { $set: { [transactionPath]: failureTransaction, updatedAt: new Date() } }
    );
    const recorded = await users.findOne({ id: userId }, { projection });
    if (!recorded) return { ok: false, reason: 'profile_not_found', transactionKey };
    normalizeProfileState(recorded);
    const recordedTransaction = recorded.transactions && recorded.transactions[transactionKey] || failureTransaction;
    return {
      ok: recordedTransaction.ok !== false,
      duplicate: failureWrite.modifiedCount === 0,
      reason: recordedTransaction.reason || null,
      user: recorded,
      transactionKey,
      transaction: recordedTransaction
    };
  }

  async fetchSession(token, gameId) {
    const crypto = require('crypto');
    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const query = { tokenHash, expiresAt: { $gt: new Date() } };
    if(gameId) query.gameId = gameId;
    const session = await db.collection('sessions').findOne(query);
    if(session) await db.collection('sessions').updateOne({ _id: session._id }, { $set: { lastUsedAt: new Date() } });
    return session;
  }

  async createGameSession(userId, gameId) {
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('base64url');
    const now = new Date();
    await db.collection('sessions').insertOne({
      tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      userId,
      gameId,
      gameJoinExpiresAt: new Date(now.getTime() + 10 * 60 * 1000),
      createdAt: now,
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + 8 * 60 * 60 * 1000)
    });
    return token;
  }

  async close() {
    if (client) await client.close();
  }
}

module.exports = Database;
