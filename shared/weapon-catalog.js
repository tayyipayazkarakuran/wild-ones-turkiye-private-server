"use strict";

// WeaponsGrid was authored as an inheritance graph, while the original
// emulator treated it as a flat, order-dependent list.  Keeping the graph
// resolution in one shared module prevents the web starter inventory and game
// server from disagreeing about what a player may equip.

const INTERNAL_TYPES = new Set([
    "walk", "jet", "drowning", "mirvchild", "mirvchildSC1", "rabbithatchildbig",
    "candymirvchild", "coconutblast", "goochild", "flamechild", "beechild",
    "fishchunk", "acornschild", "healthEquipA", "empty", "superjump", "climb", "dig",
    "treegrowth"
]);

const RUNTIME_ALIASES = Object.freeze({
    // Three spellings shipped across the original catalog, Latin assets and
    // v26 bytecode. Keep them on one canonical server/runtime definition.
    accorn: "grenade",
    accorns: "grenade",
    banana: "grenade",
    packaging_peanuts: "mortar",
    coconutgun: "goo",
    filmclapperboard: "spider",
    rabbitshower: "airstrike",
    rabbithatchildbig: "spider",
    eggsblaster: "grenade",
    acornschild: "grenade",
    spiderstrike: "airstrike",
    firehose: "shotgun",
    battle: "kangaroo",
    cow: "anvil",
    slingshot: "anvil",
    starfield: "multishot",
    meganinjastar: "ninjastar",
    dualpistol: "minigun",
    gas: "acidcloud",
    fishspit: "spit",
    dinoquake: "earthquake",
    batton: "mallet",
    lantern: "mallet",
    broom: "mallet",
    jinglebell: "mallet",
    candycane: "mallet"
});

const DIRECT_TYPES = new Set([
    "scratch", "giant", "flood", "superspin", "shield", "invisibility", "jetpack"
]);

// These are native projectile roots in the Latin SWF rather than rows in the
// shop catalog. Their derived shop entries carry the complete gameplay values.
const EXTERNAL_RUNTIME_ROOTS = new Set(["spit", "laser"]);

function clone(value) {
    return Object.assign({}, value);
}

function normalizeRecords(records) {
    if (!Array.isArray(records)) throw new Error("WeaponsGrid must be an array");
    const byType = new Map();
    for (const raw of records) {
        if (!raw || typeof raw.type !== "string" || !raw.type) continue;
        // The later Candy MIRV record is the only one with the matching
        // dedicated child projectile and visual effects, so last-write-wins is
        // intentional and deterministic for all duplicate ids.
        byType.set(raw.type, clone(raw));
    }
    if (!byType.has("coconutblast") && byType.has("goochild")) {
        const child = clone(byType.get("goochild"));
        child.type = "coconutblast";
        child.baseType = "goochild";
        child.alt = "";
        byType.set(child.type, child);
    }
    return byType;
}

function flatten(records) {
    const byType = normalizeRecords(records);
    const resolved = new Map();
    const resolving = new Set();

    function resolve(type) {
        if (resolved.has(type)) return resolved.get(type);
        const entry = byType.get(type);
        if (!entry) throw new Error(`Unknown weapon type referenced by catalog: ${type}`);
        if (resolving.has(type)) throw new Error(`Cyclic weapon inheritance: ${[...resolving, type].join(" -> ")}`);
        resolving.add(type);
        let base = {};
        if (entry.baseType && entry.baseType !== "null" && entry.baseType !== type) {
            if (!byType.has(entry.baseType)) {
                if (!EXTERNAL_RUNTIME_ROOTS.has(entry.baseType)) {
                    throw new Error(`Weapon ${type} references missing baseType ${entry.baseType}`);
                }
            } else {
                base = resolve(entry.baseType);
            }
        }
        const value = Object.assign({}, base, entry, {
            type,
            baseType: entry.baseType || "null",
            effectiveType: RUNTIME_ALIASES[type] || (base.effectiveType || type)
        });
        resolving.delete(type);
        resolved.set(type, value);
        return value;
    }

    for (const type of byType.keys()) resolve(type);
    return { byType, resolved };
}

function classify(type, weapon) {
    const isInternal = INTERNAL_TYPES.has(type) || /child$/i.test(type) || type === "treegrowth";
    const petPower = ["scratch", "giant", "flood", "superspin"].includes(type);
    return {
        type,
        weapon,
        effectiveType: weapon.effectiveType,
        runtimeKind: isInternal ? "internal" : (petPower ? "pet" : (DIRECT_TYPES.has(type) ? "direct" : "weapon")),
        selectable: Boolean(weapon.alt) && !isInternal && !petPower
    };
}

function buildWeaponCatalog(records) {
    const { byType, resolved } = flatten(records);
    const entries = new Map();
    for (const [type, weapon] of resolved) entries.set(type, classify(type, weapon));
    const selectable = [...entries.values()].filter((entry) => entry.selectable).map((entry) => entry.type).sort();
    return { entries, selectable, records: [...resolved.values()], byType };
}

function isSelectableWeapon(catalog, type) {
    return Boolean(catalog && catalog.entries && catalog.entries.get(type) && catalog.entries.get(type).selectable);
}

module.exports = { buildWeaponCatalog, isSelectableWeapon, RUNTIME_ALIASES, INTERNAL_TYPES };
