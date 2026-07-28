"use strict";

// This is the exact catalogue embedded in Ballistics_MedalsJSON in the v26
// movie.  Keeping the server list here means it can never persist a medal the
// Flash collection has no icon or tier for.
const MEDAL_CATALOG = Object.freeze({
  gone_wild: Object.freeze([5, 25, 100]),
  pick_of_litter: Object.freeze([5, 20, 50]),
  eagle_eye: Object.freeze([1, 10, 50]),
  dressed_to_kill: Object.freeze([3, 6, 10]),
  two_bird_one_stone: Object.freeze([1, 5, 20]),
  minesweeper: Object.freeze([5, 10, 20]),
  mortar_mayhem: Object.freeze([1, 10, 50]),
  stand_and_fight: Object.freeze([1, 5, 25]),
  doctors_orders: Object.freeze([3, 6, 12]),
  passive_aggression: Object.freeze([1, 10, 20]),
  furry_fury: Object.freeze([1, 5, 10]),
  have_a_blast: Object.freeze([1, 5, 10]),
  untouchable: Object.freeze([1, 5, 15]),
  pack_rat: Object.freeze([3, 6, 12]),
  geronimo: Object.freeze([5, 10, 30]),
  suicidal_mayhem: Object.freeze([1, 5, 15])
});

function isKnownMedal(type) {
  return Object.prototype.hasOwnProperty.call(MEDAL_CATALOG, String(type || ""));
}

module.exports = { MEDAL_CATALOG, isKnownMedal };
