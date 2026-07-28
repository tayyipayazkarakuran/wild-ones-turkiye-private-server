"use strict";

const MAX_BOT_TURN_MS = 7500;
const BOT_WEAPONS_LIST = [
    "mortar", "grenade", "minigun", "marshmallow", "chainsaw", "multishot",
    "ninjastar", "tornadogrenade", "mirv", "shuriken", "drill", "goo",
    "lasercannon", "dart", "gravbubble", "kame", "freeze", "snowman",
    "acidcloud", "boomerang"
];

const SPLASH_SAFE_DISTANCE = Object.freeze({
    mortar: 475, grenade: 575, multishot: 475, ninjastar: 225,
    tornadogrenade: 825, mirv: 700, shuriken: 195, drill: 475, goo: 500
});
const DIRECT_WEAPONS = new Set([
    "minigun", "marshmallow", "chainsaw", "lasercannon", "gravbubble",
    "kame", "freeze", "snowman", "acidcloud"
]);
// Drill is the deliberate answer to sealed cave geometry. Its projectile
// removes terrain while travelling, so terrain intersections must not be
// treated as a failed/blocked shot by the server-side planner.
const PENETRATING_WEAPONS = new Set(["drill"]);
const CLOSE_RANGE_LIMIT = Object.freeze({
    chainsaw: 145,
    marshmallow: 625
});
const DEFAULT_PROJECTILE_SPEED = 1.5;
const DEFAULT_PROJECTILE_GRAVITY = 0.0005;
const PHYSICS_DT = 10;

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function shortestAngleDelta(from, to) {
    return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

// xorshift keeps the server fallback reproducible. Native v22 bots receive
// this same slot seed and therefore do not depend on each renderer's Math.random.
function nextRandom(bot) {
    let state = Number(bot._botRandomState || 1) | 0;
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bot._botRandomState = state | 0;
    return ((state >>> 0) % 0x1000000) / 0x1000000;
}

class BotController {
    constructor(slot) {
        this.slot = slot;
        this.state = null;
    }

    reset() { this.state = null; }

    livingTargets(bot) {
        return Object.values(this.slot.clients).filter((client) => {
            if (!client || client === bot || client.isDead()) return false;
            if (!client.avatar || !Number.isFinite(Number(client.avatar.X)) ||
                !Number.isFinite(Number(client.avatar.Y))) return false;
            const field = this.slot.field;
            if (field && (Number(client.avatar.X) < -50 ||
                Number(client.avatar.X) > Number(field.width || 2800) + 50 ||
                Number(client.avatar.Y) < -120 ||
                Number(client.avatar.Y) > Number(field.height || 1400) + 10)) return false;
            const ownTeam = bot.player && bot.player.team;
            const targetTeam = client.player && client.player.team;
            return ownTeam == null || targetTeam == null || ownTeam !== targetTeam;
        });
    }

    weaponProperties(weapon) {
        return this.slot.WOPW.weaponsObj[weapon] || {};
    }

    hasClearLine(bot, target) {
        const field = this.slot.field;
        if (!field || !field.bitmapData || typeof field.checkFieldCollisionPoint !== "function") return true;
        const targetRadius = Math.max(20, Number(target.avatar.boundRadius || 25));
        const dx = target.avatar.X - bot.avatar.X;
        const dy = (target.avatar.Y - targetRadius * 0.25) - bot.avatar.Y;
        const distance = Math.hypot(dx, dy);
        if (distance <= 1) return true;
        const start = Math.max(50, Number(bot.avatar.boundRadius || 25) + 20);
        const end = Math.max(start, distance - targetRadius);
        for (let offset = start; offset < end; offset += 12) {
            const ratio = offset / distance;
            if (field.checkFieldCollisionPoint(
                Math.round(bot.avatar.X + dx * ratio),
                Math.round(bot.avatar.Y + dy * ratio)
            )) return false;
        }
        return true;
    }

    simulateBallisticShot(bot, target, weapon, angle, power, options = {}) {
        const properties = this.weaponProperties(weapon);
        const speed = Math.max(0.01, Number(properties.Vmax || DEFAULT_PROJECTILE_SPEED)) * power;
        const gravity = Number.isFinite(Number(properties.gravity))
            ? Number(properties.gravity)
            : DEFAULT_PROJECTILE_GRAVITY;
        const targetRadius = Math.max(20, Number(target.avatar.boundRadius || 25));
        const splashRadius = Math.max(0, Math.min(450, Number(properties.R2 || 0)));
        const muzzleLength = Math.max(35, Number(bot.avatar.gunLength || 45));
        const originX = Number(bot.avatar.X);
        const originY = Number(bot.avatar.Y);
        let x = originX + Math.cos(angle) * muzzleLength;
        let y = originY + Math.sin(angle) * muzzleLength;
        let vx = Math.cos(angle) * speed;
        let vy = Math.sin(angle) * speed;
        let closest = Math.hypot(target.avatar.X - x, target.avatar.Y - y);
        const field = this.slot.field;

        for (let step = 0; step < 900; step++) {
            vy += gravity * PHYSICS_DT;
            x += vx * PHYSICS_DT;
            y += vy * PHYSICS_DT;
            const targetDistance = Math.hypot(target.avatar.X - x, target.avatar.Y - y);
            closest = Math.min(closest, targetDistance);
            if (targetDistance <= targetRadius + 10) {
                return { angle, power, score: step * 0.01, impactX: x, impactY: y };
            }

            const travelled = Math.hypot(x - originX, y - originY);
            if (!options.ignoreTerrain && travelled > muzzleLength + 15 && field && field.bitmapData &&
                field.checkFieldCollisionPoint(Math.round(x), Math.round(y))) {
                const selfDistance = Math.hypot(x - originX, y - originY);
                const safeDistance = Number(SPLASH_SAFE_DISTANCE[weapon] || 0);
                if (safeDistance > 0 && selfDistance < safeDistance * 0.72) return null;
                const effectiveMiss = Math.max(0, targetDistance - targetRadius - splashRadius * 0.75);
                return {
                    angle,
                    power,
                    score: effectiveMiss + step * 0.01,
                    impactX: x,
                    impactY: y
                };
            }
            if (field && (x < -100 || x > field.width + 100 || y > field.height + 220)) break;
        }
        return {
            angle,
            power,
            score: closest + (options.ignoreTerrain ? 0 : 500),
            impactX: x,
            impactY: y
        };
    }

    planBallisticShot(bot, target, weapon, options = {}) {
        const properties = this.weaponProperties(weapon);
        const maxSpeed = Math.max(0.01, Number(properties.Vmax || DEFAULT_PROJECTILE_SPEED));
        const gravity = Number.isFinite(Number(properties.gravity))
            ? Number(properties.gravity)
            : DEFAULT_PROJECTILE_GRAVITY;
        if (gravity <= 0) return null;

        const dx = Number(target.avatar.X) - Number(bot.avatar.X);
        const dy = Number(target.avatar.Y) - Number(bot.avatar.Y);
        const horizontal = Math.abs(dx);
        if (horizontal < 5) {
            return this.simulateBallisticShot(bot, target, weapon, -Math.PI * 0.5, 0.65, options);
        }
        const verticalUp = -dy;
        const minimumSpeed = Math.sqrt(Math.max(0,
            gravity * (Math.hypot(horizontal, verticalUp) + verticalUp)
        ));
        const minimumPower = clamp((minimumSpeed / maxSpeed) * 1.06, 0.18, 1);
        const powers = [];
        for (let index = 0; index < 8; index++) {
            powers.push(minimumPower + (1 - minimumPower) * index / 7);
        }

        let best = null;
        for (const power of powers) {
            const speed = maxSpeed * power;
            const speed2 = speed * speed;
            const discriminant = speed2 * speed2 -
                gravity * (gravity * horizontal * horizontal + 2 * verticalUp * speed2);
            if (discriminant < 0) continue;
            const root = Math.sqrt(discriminant);
            for (const numerator of [speed2 - root, speed2 + root]) {
                const angleUp = Math.atan(numerator / (gravity * horizontal));
                const vx = (dx >= 0 ? 1 : -1) * Math.cos(angleUp);
                const vy = -Math.sin(angleUp);
                const angle = Math.atan2(vy, vx);
                const candidate = this.simulateBallisticShot(bot, target, weapon, angle, power, options);
                if (candidate && (!best || candidate.score < best.score)) best = candidate;
            }
        }
        const propertiesSplash = Math.max(0, Math.min(450, Number(properties.R2 || 0)));
        const acceptableMiss = Math.max(options.ignoreTerrain ? 80 : 55, propertiesSplash * 0.7);
        return best && best.score <= acceptableMiss ? best : null;
    }

    planShot(bot, target, weapon) {
        if (!bot || !target || !bot.avatar || !target.avatar) return null;
        const distance = Math.hypot(
            target.avatar.X - bot.avatar.X,
            target.avatar.Y - bot.avatar.Y
        );
        const closeLimit = Number(CLOSE_RANGE_LIMIT[weapon] || 0);
        if (closeLimit > 0 && distance > closeLimit) return null;
        if (!this.isSafeWeapon(weapon, distance)) return null;

        if (DIRECT_WEAPONS.has(weapon)) {
            if (!this.hasClearLine(bot, target)) return null;
            return {
                angle: Math.atan2(target.avatar.Y - bot.avatar.Y, target.avatar.X - bot.avatar.X),
                power: 1,
                score: 0
            };
        }
        return this.planBallisticShot(bot, target, weapon, {
            ignoreTerrain: PENETRATING_WEAPONS.has(weapon)
        });
    }

    initializeBag(bot) {
        if (!bot._botRandomState) {
            bot._botRandomState = ((Number(this.slot.randomSeed) + 1) * 1103515245) ^ Number(bot.player.id);
        }
        if (Array.isArray(bot._botWeaponBag) && bot._botWeaponBag.length) return;
        const equipped = bot.player && Array.isArray(bot.player.userWeaponsEquipped) ? bot.player.userWeaponsEquipped : [];
        // Test/recovery bots can have a deliberately reduced legacy loadout.
        // Production BotClient always carries the full twenty-item roster.
        bot._botWeaponBag = (equipped.length > 0 && equipped.length <= 2 ? equipped : BOT_WEAPONS_LIST)
            .filter((type) => this.slot.WOPW.weaponsObj[type]);
        for (let i = bot._botWeaponBag.length - 1; i > 0; i--) {
            const j = Math.floor(nextRandom(bot) * (i + 1));
            [bot._botWeaponBag[i], bot._botWeaponBag[j]] = [bot._botWeaponBag[j], bot._botWeaponBag[i]];
        }
        bot._botWeaponCycle = Number(bot._botWeaponCycle || 0) + 1;
    }

    isSafeWeapon(weapon, distance) {
        if (CLOSE_RANGE_LIMIT[weapon]) return distance <= CLOSE_RANGE_LIMIT[weapon];
        return !Object.prototype.hasOwnProperty.call(SPLASH_SAFE_DISTANCE, weapon) || distance >= SPLASH_SAFE_DISTANCE[weapon];
    }

    chooseWeapon(bot, target) {
        this.initializeBag(bot);
        const distance = Math.hypot(target.avatar.X - bot.avatar.X, target.avatar.Y - bot.avatar.Y);
        const attempts = bot._botWeaponBag.length;
        for (let index = 0; index < attempts; index++) {
            const weapon = bot._botWeaponBag.shift();
            const plan = this.planShot(bot, target, weapon);
            if (this.isSafeWeapon(weapon, distance) && plan) {
                bot._botWeaponLast = weapon;
                bot._botShotPlan = plan;
                return weapon;
            }
            // Unsafe splash weapons are postponed instead of discarded; they
            // will be tried on a later geometry without breaking the 20-item cycle.
            bot._botWeaponBag.push(weapon);
        }
        // Prefer a validated terrain-boring path in sealed maps. Minigun is
        // last and is used only when its direct line-of-sight check succeeded.
        for (const fallback of ["drill", "mortar", "minigun"]) {
            if (this.slot.WOPW.weaponsObj[fallback]) {
                const plan = this.planShot(bot, target, fallback);
                if (plan) {
                    bot._botShotPlan = plan;
                    return fallback;
                }
            }
        }
        // There is no safe, verified path from the current position. Returning
        // no weapon lets the controller skip this turn instead of firing a
        // visually plausible but invalid shot into terrain or into itself.
        bot._botShotPlan = null;
        return null;
    }

    reserveWeapon(bot) {
        const target = this.livingTargets(bot).sort((a, b) => {
            const aDistance = Math.hypot(a.avatar.X - bot.avatar.X, a.avatar.Y - bot.avatar.Y);
            const bDistance = Math.hypot(b.avatar.X - bot.avatar.X, b.avatar.Y - bot.avatar.Y);
            return aDistance - bDistance;
        })[0];
        if (!target) return null;
        bot._assignedBotWeapon = this.chooseWeapon(bot, target);
        bot._assignedBotTargetId = target.player.id;
        return bot._assignedBotWeapon;
    }

    begin(bot, now) {
        const targets = this.livingTargets(bot).map((target) => {
            const dx = target.avatar.X - bot.avatar.X;
            const dy = target.avatar.Y - bot.avatar.Y;
            return { target, dx, dy, distance: Math.hypot(dx, dy) };
        }).sort((a, b) => a.distance - b.distance);
        if (!targets.length) return null;

        const choice = targets.find((candidate) =>
            String(candidate.target.player.id) === String(bot._assignedBotTargetId)
        ) || targets[0];
        let weapon = bot._assignedBotWeapon || this.chooseWeapon(bot, choice.target);
        let shotPlan = weapon ? (this.planShot(bot, choice.target, weapon) || bot._botShotPlan) : null;
        if (!shotPlan) {
            weapon = this.chooseWeapon(bot, choice.target);
            shotPlan = weapon ? (this.planShot(bot, choice.target, weapon) || bot._botShotPlan) : null;
        }
        if (!weapon || !shotPlan) {
            return {
                bot,
                target: choice.target,
                weapon: null,
                shotPlan: null,
                phase: "skip",
                dueAt: now + 650,
                expiresAt: now + MAX_BOT_TURN_MS,
                direction: choice.dx >= 0 ? 1 : -1,
                jumped: false,
                fired: false,
                aimStep: 0
            };
        }
        const towardTarget = choice.dx >= 0 ? 1 : -1;
        const moveChance = choice.distance < 180 ? 0.55 : (choice.distance > 700 ? 0.45 : 0.30);
        const shouldMove = nextRandom(bot) < moveChance;
        const directionRoll = nextRandom(bot);
        const direction = choice.distance < 180 || directionRoll < 0.12
            ? -towardTarget
            : (directionRoll > 0.88 ? (nextRandom(bot) < 0.5 ? -1 : 1) : towardTarget);
        const thinkDelay = 450 + Math.round(nextRandom(bot) * 700);
        const moveDuration = 450 + Math.round(nextRandom(bot) * 650);
        return {
            bot,
            target: choice.target,
            weapon,
            shotPlan,
            phase: "thinking",
            nextPhase: shouldMove ? "moving" : "equip",
            dueAt: now + thinkDelay,
            expiresAt: now + MAX_BOT_TURN_MS,
            direction,
            moveDuration,
            jumpAt: 0,
            wantsJump: nextRandom(bot) < 0.18,
            jumped: false,
            fired: false,
            aimStep: 0,
            aimSteps: 6,
            aimStartAngle: NaN,
            aimCorrection: (nextRandom(bot) - 0.5) * 0.28,
            aimInterval: 180 + Math.round(nextRandom(bot) * 80)
        };
    }

    sendMove(bot, direction) {
        const packet = { id: bot.player.id, command: direction > 0 ? "move_right" : "move_left" };
        console.log(">> Server bot move: " + bot.player.id + "; direction=" + (direction > 0 ? "right" : "left"));
        if (direction > 0) this.slot.WOPW.packetHandler.handleMoveRight(bot, packet);
        else this.slot.WOPW.packetHandler.handleMoveLeft(bot, packet);
    }

    sendJump(bot) { this.slot.WOPW.packetHandler.handleMoveJump(bot, { id: bot.player.id, command: "move_jump", direction: "up" }); }

    shouldJump(bot, direction, optionalJump) {
        const field = this.slot.field;
        if (!field || !field.bitmapData || typeof field.checkFieldCollisionPoint !== "function") return false;
        const radius = Math.max(18, Number(bot.avatar.boundRadius || 25));
        const frontX = Number(bot.avatar.X) + direction * (radius + 12);
        const y = Number(bot.avatar.Y);
        const obstacle = field.checkFieldCollisionPoint(Math.round(frontX), Math.round(y)) ||
            field.checkFieldCollisionPoint(Math.round(frontX), Math.round(y - radius * 0.45));
        const headClear = !field.checkFieldCollisionPoint(
            Math.round(bot.avatar.X),
            Math.round(y - radius - 18)
        );
        const grounded = field.checkFieldCollisionPoint(
            Math.round(bot.avatar.X),
            Math.round(y + radius + 5)
        );
        const landingAhead = field.checkFieldCollisionPoint(
            Math.round(frontX),
            Math.round(y + radius + 8)
        );
        return headClear && (obstacle || (optionalJump && grounded && landingAhead));
    }

    finishTurn(bot) {
        if (!bot || !bot.player || parseInt(this.slot.currentPlayer) !== parseInt(bot.player.id)) return this.reset();
        this.slot.WOPW.packetHandler.handleTurnComplete(bot, { id: bot.player.id, command: "turn_complete" });
        this.reset();
    }

    update() {
        if (!this.slot.isRunning()) return this.reset();
        const bot = this.slot.clients[this.slot.currentPlayer];
        if (!bot || !bot.isBot || bot.isDead()) return this.reset();
        const now = Date.now();
        if (!this.state || this.state.bot !== bot) {
            this.state = this.begin(bot, now);
            if (!this.state) return this.finishTurn(bot);
            if (this.state.phase === "moving") this.sendMove(bot, this.state.direction);
            return;
        }
        const state = this.state;
        if (now >= state.expiresAt) {
            // A fired projectile owns its natural `timeAfter` turn close.  A
            // forced turn_complete races MIRV/boomerang effects in Ruffle.
            if (state.fired) return;
            const expiryTargets = this.livingTargets(bot);
            const expiryTarget = state.target && !state.target.isDead() && expiryTargets.includes(state.target)
                ? state.target
                : expiryTargets[0];
            const expiryPlan = expiryTarget ? this.planShot(bot, expiryTarget, state.weapon) : null;
            if (!expiryPlan) return this.finishTurn(bot);
            this.slot.WOPW.packetHandler.handleSetAim(bot, {
                id: bot.player.id,
                command: "set_aim",
                value: String(expiryPlan.angle),
                power: String(clamp(Number(expiryPlan.power || 1), 0.08, 1))
            });
            this.slot.WOPW.packetHandler.handleProjectile(bot, { id: bot.player.id, command: "projectile", ammo_type: state.weapon });
            state.fired = true;
            state.phase = "waiting";
            return;
        }
        if (state.phase === "moving" && !state.jumped && now >= state.jumpAt &&
            this.shouldJump(bot, state.direction, state.wantsJump)) {
            this.sendJump(bot);
            state.jumped = true;
        }
        if (now < state.dueAt) return;
        if (state.phase === "thinking") {
            if (state.nextPhase === "moving") {
                this.sendMove(bot, state.direction);
                state.phase = "moving";
                state.jumpAt = now + Math.min(320, Math.round(state.moveDuration * 0.35));
                state.dueAt = now + state.moveDuration;
            } else {
                state.phase = "equip";
                state.dueAt = now + 100;
            }
            return;
        }
        if (state.phase === "moving") {
            this.slot.WOPW.packetHandler.handleMoveStop(bot, { id: bot.player.id, command: "move_stop" });
            state.phase = "equip"; state.dueAt = now + 250; return;
        }
        if (state.phase === "equip") {
            this.slot.WOPW.packetHandler.handleEquip(bot, {
                id: bot.player.id, command: "equip", value: state.weapon
            });
            state.phase = "aim"; state.dueAt = now + 300; return;
        }
        if (state.phase === "aim") {
            const targets = this.livingTargets(bot);
            const target = state.target && !state.target.isDead() ? state.target : targets[0];
            if (target) {
                state.target = target;
                state.shotPlan = this.planShot(bot, target, state.weapon);
                // Movement and terrain destruction may invalidate the weapon
                // reserved at turn start. Re-equip a newly validated weapon
                // before showing aim frames; never fall through to a blind
                // direct shot into the old geometry.
                if (!state.shotPlan) {
                    const replacement = this.chooseWeapon(bot, target);
                    const replacementPlan = replacement
                        ? (this.planShot(bot, target, replacement) || bot._botShotPlan)
                        : null;
                    if (replacementPlan) {
                        state.weapon = replacement;
                        state.shotPlan = replacementPlan;
                        state.aimStep = 0;
                        state.aimStartAngle = NaN;
                        this.slot.WOPW.packetHandler.handleEquip(bot, {
                            id: bot.player.id, command: "equip", value: replacement
                        });
                        state.dueAt = now + 300;
                        return;
                    }
                    state.phase = "skip";
                    state.dueAt = now + 300;
                    return;
                }
            }
            const dx = target ? target.avatar.X - bot.avatar.X : (bot.avatar.isFacingRight ? 1 : -1);
            const dy = target ? target.avatar.Y - bot.avatar.Y : 0;
            const fallbackPlan = {
                angle: Math.atan2(dy, dx),
                power: 1
            };
            const shotPlan = state.shotPlan || fallbackPlan;
            const finalPower = clamp(Number(shotPlan.power || 1), 0.08, 1);
            state.aimStep = Number(state.aimStep || 0) + 1;
            const aimSteps = Math.max(4, Number(state.aimSteps || 6));
            if (!Number.isFinite(Number(state.aimStartAngle))) {
                const existingAngle = Number(bot.avatar.trueGunAngle);
                state.aimStartAngle = Number.isFinite(existingAngle)
                    ? existingAngle
                    : (bot.avatar.isFacingRight ? 0 : Math.PI);
            }
            const progress = clamp(state.aimStep / aimSteps, 0, 1);
            const easedProgress = progress * (2 - progress);
            const finalAngle = Number(shotPlan.angle);
            const displayedAngle = state.aimStartAngle +
                shortestAngleDelta(state.aimStartAngle, finalAngle) * easedProgress +
                Math.sin(progress * Math.PI) * Number(state.aimCorrection || 0);
            this.slot.WOPW.packetHandler.handleSetAim(bot, {
                id: bot.player.id, command: "set_aim", value: String(progress >= 1 ? finalAngle : displayedAngle),
                // CommandProcessor assigns this value directly to firePower.
                // Sending world pixels (140..450) produced impossible projectile
                // velocities and locked the Ruffle renderer on the bot turn.
                power: String(clamp(finalPower * (0.2 + 0.8 * progress), 0.08, 1))
            });
            // Six eased frames visibly sweep the arm/reticle and charge power,
            // including a small diminishing correction like a human player.
            if (state.aimStep < aimSteps) {
                state.dueAt = now + Number(state.aimInterval || 220);
            } else {
                state.phase = "projectile";
                state.dueAt = now + 400;
            }
            return;
        }
        if (state.phase === "skip") {
            return this.finishTurn(bot);
        }
        if (state.phase === "projectile") {
            const targets = this.livingTargets(bot);
            const target = state.target && !state.target.isDead() && targets.includes(state.target)
                ? state.target
                : targets[0];
            const finalPlan = target ? this.planShot(bot, target, state.weapon) : null;
            if (!finalPlan) {
                const replacement = target ? this.chooseWeapon(bot, target) : null;
                const replacementPlan = replacement && target
                    ? (this.planShot(bot, target, replacement) || bot._botShotPlan)
                    : null;
                if (replacementPlan && Number(state.replanCount || 0) < 2) {
                    state.target = target;
                    state.weapon = replacement;
                    state.shotPlan = replacementPlan;
                    state.replanCount = Number(state.replanCount || 0) + 1;
                    state.aimStep = 0;
                    state.aimStartAngle = NaN;
                    state.phase = "equip";
                    state.dueAt = now + 150;
                    return;
                }
                state.phase = "skip";
                state.dueAt = now;
                return;
            }
            state.shotPlan = finalPlan;
            // The final exact aim and the projectile share one ordered server
            // update. Target motion or a freshly destroyed platform can no
            // longer leave the bot firing a 400 ms stale angle into empty sky.
            this.slot.WOPW.packetHandler.handleSetAim(bot, {
                id: bot.player.id,
                command: "set_aim",
                value: String(finalPlan.angle),
                power: String(clamp(Number(finalPlan.power || 1), 0.08, 1))
            });
            console.log(">> Server bot action: " + bot.player.id + "; weapon=" + state.weapon);
            this.slot.WOPW.packetHandler.handleProjectile(bot, { id: bot.player.id, command: "projectile", ammo_type: state.weapon });
            state.fired = true; state.phase = "waiting"; return;
        }
        // The slot changes turn from weapon timeAfter. Do not send a second
        // transition while visual effects are still active.
        if (state.phase === "waiting") return;
    }
}

module.exports = BotController;
