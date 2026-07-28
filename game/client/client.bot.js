"use strict";

const Avatar = require("./extensions/avatar.js");
const { thresholdForLevel } = require("../../shared/levels.js");

const BOT_NAMES = [
    "Anka", "Bozkurt", "Poyraz", "Ayaz", "Yildiz", "Efe", "Zeybek", "Ozan", "Alp", "Mete",
    "Bora", "Deniz", "Toprak", "Kartal", "Sahin", "Pars", "Kaplan", "Cinar", "Kagan", "Tunga",
    "Ruzgar", "Bulut", "Yaman", "Baran", "Ates", "Doruk", "Kuzey", "Guney", "Aras", "Duru",
    "Ekin", "Lale", "Mavi", "Nehir", "Ada", "Sarp", "Gokce", "Umay", "Asena", "Bilge",
    "Kutay", "Altay", "Ilgaz", "Toros", "Pamir", "Sakarya", "Likya", "Troya", "Nemrut", "Efes"
];
// Minigun is the close-range option: unlike the explosives below it has a
// four-pixel terrain radius, so bots can act safely on compact two-player
// spawns instead of having to throw a grenade at their own feet.
const BOT_WEAPONS = [
    "mortar", "grenade", "minigun", "marshmallow", "chainsaw", "multishot",
    "ninjastar", "tornadogrenade", "mirv", "shuriken", "drill", "goo",
    "lasercannon", "dart", "gravbubble", "kame", "freeze", "snowman",
    "acidcloud", "boomerang"
];

function hashSeed(value) {
    let hash = 2166136261;
    for (const character of String(value)) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function seededRandom(seed) {
    let state = seed >>> 0;
    return function next() {
        state += 0x6D2B79F5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function pick(values, random) {
    return values[Math.floor(random() * values.length)];
}

function randomColor(random) {
    return "0x" + Math.floor(random() * 0xFFFFFF).toString(16).padStart(6, "0").toUpperCase();
}

function chooseLevel(random) {
    const roll = random();
    if (roll < 0.50) return 1 + Math.floor(random() * 20);
    if (roll < 0.85) return 21 + Math.floor(random() * 30);
    return 51 + Math.floor(random() * 50);
}

function chooseName(slot, seed) {
    const occupied = new Set(Object.values(slot.clients || {}).map((client) =>
        String(client && client.player && client.player.dname || "").toLowerCase()
    ));
    const start = seed % BOT_NAMES.length;
    for (let offset = 0; offset < BOT_NAMES.length; offset++) {
        const candidate = BOT_NAMES[(start + offset) % BOT_NAMES.length];
        if (!occupied.has(candidate.toLowerCase())) return candidate;
    }
    return `Anka-${seed % 1000}`;
}

function chooseOutfit(slot, random) {
    const validatedTypes = slot.WOPW.botAccessoryTypes;
    const supported = Object.values(slot.WOPW.accessoriesObj || {}).filter((accessory) =>
        accessory && accessory.type && accessory.category && accessory.stats &&
        (!validatedTypes || !validatedTypes.size || validatedTypes.has(accessory.type))
    );
    const byCategory = new Map();
    for (const accessory of supported) {
        if (!byCategory.has(accessory.category)) byCategory.set(accessory.category, []);
        byCategory.get(accessory.category).push(accessory.type);
    }
    const categories = [...byCategory.keys()];
    for (let index = categories.length - 1; index > 0; index--) {
        const swapIndex = Math.floor(random() * (index + 1));
        [categories[index], categories[swapIndex]] = [categories[swapIndex], categories[index]];
    }
    const desiredCount = Math.min(categories.length, 1 + Math.floor(random() * 4));
    return categories.slice(0, desiredCount).map((category) => pick(byCategory.get(category), random));
}

class BotClient {
    constructor(slot, id, ordinal) {
        this.WOPW = slot.WOPW;
        this.slot = slot;
        this.gameId = slot.gameId;
        this.isBot = true;
        this.disconnected = false;
        const seed = hashSeed(`${slot.gameId}:${id}:${ordinal}`);
        const random = seededRandom(seed);

        // The v23 movie ships display symbols for these original pets.  The
        // server catalogue also contains later pet records whose display
        // classes are not embedded in this SWF; selecting one leaves
        // AnimalGraphics.chassisObject undefined and breaks every bot card.
        const swfPetTypes = ["dog", "rabbit", "panda"];
        const petTypes = swfPetTypes.filter((type) => !this.WOPW.petsObj || this.WOPW.petsObj[type]);
        const petType = pick(petTypes.length ? petTypes : ["rabbit"], random);
        const weapons = BOT_WEAPONS.filter((type) => !this.WOPW.weaponsObj || !Object.keys(this.WOPW.weaponsObj).length || this.WOPW.weaponsObj[type]);
        const equipped = weapons.length > 0 ? weapons : ["mortar", "minigun", "fireworks", "grenade", "banana"];

        const name = chooseName(slot, seed);
        const inventory = Object.fromEntries([...new Set(equipped)].map((type) => [type, 99]));
        const outfit = chooseOutfit(slot, random);
        const durability = Object.fromEntries(outfit.map((type) => [type, -1]));
        const level = chooseLevel(random);
        const xp = thresholdForLevel(level - 1, this.WOPW.levelsObj);
        this.player = {
            id,
            isBot: true,
            nw: -1,
            level,
            currentPet: "1",
            login_streak: 1,
            playerStatus: "playing",
            status: "ready",
            net: "M",
            snum: `bot-${id}`,
            gamecount: 0,
            gold: 0,
            treats: 0,
            hp: 500000,
            wins: 0,
            sesscount: 0,
            losses: 0,
            speed: 5,
            attack: 100,
            defence: 5,
            jump: 5,
            xp,
            userAccessories: outfit,
            durability,
            ownedPets: {
                1: {
                    gender: random() < 0.5 ? "M" : "F",
                    id: "1",
                    pers: "brave",
                    name,
                    accessories: outfit,
                    color1: randomColor(random),
                    color2: randomColor(random),
                    type: petType,
                    played: 0,
                    wins: 0,
                    losses: 0,
                    deaths: 0,
                    kills: 0,
                    gold: 0,
                    lastPlayed: 0
                }
            },
            userWeaponsOwned: inventory,
            userWeaponsEquipped: equipped,
            allowedMaps: Object.keys(this.WOPW.mapsObj),
            equippedFoods: {},
            cookingFoods: [],
            eatenFoods: [],
            unlimitedInventory: true,
            dname: name,
            command: "player",
            online: this.WOPW.getLobbyLoad()
        };

        this.avatar = new Avatar(this);
        this.avatar.initialize();
    }

    getGame() { return this.slot; }
    isCurrentPlayer() { return String(this.slot.currentPlayer) === String(this.player.id); }
    isDead() { return this.avatar.dead; }
    resetTurnChanges() { this.avatar.alreadyShot = false; this.avatar.locked = false; }
    addXP() {}
    addGold() {}
    addTreats() {}
    sendGameStats() {}
    sendServerTick() {}
    sendPacket() {}
    sendUpdate() {}
    updatePlayerData() {}
}

module.exports = BotClient;
