// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateStore, sanitizeState } from "../src/daemon/state.ts";

test("state save is 0600 even over a leftover temp file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mxa-state-"));
  try {
    const file = path.join(dir, "state.json");
    fs.writeFileSync(`${file}.${process.pid}.tmp`, "x", { mode: 0o644 });
    const s = StateStore.load(file);
    s.data.accessToken = "token";
    s.save();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(StateStore.load(file).data.accessToken, "token");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("state save never follows a symlinked temp file and leaves no temp file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mxa-state-"));
  try {
    const file = path.join(dir, "state.json");
    const victim = path.join(dir, "victim");
    fs.writeFileSync(victim, "keep");
    fs.symlinkSync(victim, `${file}.${process.pid}.tmp`);
    const s = StateStore.load(file);
    s.data.accessToken = "token";
    s.save();
    assert.equal(fs.readFileSync(victim, "utf8"), "keep");
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["state.json", "victim"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("botMasterKey is kept and room keys like __proto__ cannot change the prototype", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mxa-state-"));
  try {
    const file = path.join(dir, "state.json");
    fs.writeFileSync(file, '{"botMasterKey":"BOTKEY","rooms":{"__proto__":{"roomId":"!a:example.org","name":"__proto__"},"x":{"roomId":1}}}');
    const s = StateStore.load(file);
    assert.equal(s.data.botMasterKey, "BOTKEY");
    assert.equal(Object.getPrototypeOf(s.data.rooms), null);
    assert.deepEqual(Object.keys(s.data.rooms), ["__proto__"]);
    s.save();
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).rooms.__proto__.roomId, "!a:example.org");
    const plain = new StateStore(file, { rooms: {} });
    assert.equal(Object.getPrototypeOf(plain.data.rooms), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deviceEd25519 survives sanitizing; non-strings are dropped", () => {
  assert.equal(sanitizeState({ deviceEd25519: "abcDEF123" }).deviceEd25519, "abcDEF123");
  assert.equal(sanitizeState({ deviceEd25519: 5 }).deviceEd25519, undefined);
});
