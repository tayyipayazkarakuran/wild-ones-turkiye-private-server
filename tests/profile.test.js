"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createProfile, validateCredentials, playerDto } = require("../shared/profile");

test("profile validates Turkish display names and keeps passwords out of player DTOs", () => {
  const credentials = validateCredentials("Çağrı", "CorrectHorseBattery1");
  assert.equal(credentials.ok, true);
  const profile = createProfile({ id: 1, dname: credentials.dname, passwordHash: "hash" });
  const dto = playerDto(profile, { snum: "session-token" });
  assert.equal(dto.snum, "session-token");
  assert.equal(Object.hasOwn(dto, "passwordHash"), false);
});

test("profile rejects invalid credentials", () => {
  assert.equal(validateCredentials("x", "12345678").ok, false);
  assert.equal(validateCredentials("ValidName", "short").ok, false);
});
