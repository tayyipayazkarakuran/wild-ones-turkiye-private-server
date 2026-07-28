"use strict";

const { playerWireDto } = require("../../shared/player-wire.js");

function applyMovieCompatibility(player) {
  const canonicalMaps = Array.isArray(player.allowedMaps)
    ? player.allowedMaps.map(String).filter(Boolean)
    : (player.allowedMaps && typeof player.allowedMaps === "object" ? Object.keys(player.allowedMaps) : []);
  Object.assign(player, playerWireDto(player));
  // Handlers and database updates require canonical arrays. The outbound
  // adapter creates the name-keyed object the legacy SWF needs on each send.
  player.allowedMaps = canonicalMaps;
  return player;
}

function playerWireCompatibility(player, overrides) {
  return playerWireDto(player, overrides);
}

module.exports = { applyMovieCompatibility, playerWireCompatibility };
