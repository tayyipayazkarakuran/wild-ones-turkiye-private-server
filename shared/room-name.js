"use strict";

const ROOM_NAME_PATTERN = /^[\p{L}\p{N}_-]+$/u;
const MAX_ROOM_NAME_LENGTH = 24;

function canonicalRoomName(value) {
  const displayName = String(value == null ? "" : value)
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, "-");
  const length = Array.from(displayName).length;
  if (!displayName || length > MAX_ROOM_NAME_LENGTH || !ROOM_NAME_PATTERN.test(displayName)) {
    return { ok: false, code: "invalid_name", displayName: "", key: "" };
  }
  return {
    ok: true,
    code: null,
    displayName,
    key: displayName
      .toLocaleUpperCase("en-US")
      .toLocaleLowerCase("en-US")
      .replace(/\u0307/gu, "")
      .normalize("NFKC")
  };
}

module.exports = { ROOM_NAME_PATTERN, MAX_ROOM_NAME_LENGTH, canonicalRoomName };
