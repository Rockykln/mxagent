// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MachineStore, machinesFile, takeOverStaleLock } from "../src/daemon/machines.ts";

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mxa-machines-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const leftovers = (dir: string) => fs.readdirSync(dir).filter((f) => f.includes(".stale."));

test("stale lock takeover removes the stale lock and leaves nothing behind", () => {
  const dir = tmpDir();
  const lock = path.join(dir, "machines.lock");
  fs.writeFileSync(lock, "1\n");
  assert.equal(takeOverStaleLock(lock, fs.statSync(lock)), true);
  assert.equal(fs.existsSync(lock), false);
  assert.deepEqual(leftovers(dir), []);
  // Nothing to take over any more.
  assert.equal(takeOverStaleLock(lock, { ino: 1, dev: 1 }), false);
});

test("stale lock takeover puts back a fresh lock another writer created in the meantime", () => {
  const dir = tmpDir();
  const lock = path.join(dir, "machines.lock");
  fs.writeFileSync(lock, "crashed\n");
  const stale = fs.statSync(lock);
  // Another writer removed the stale lock and created its own before our rename.
  const held = path.join(dir, "held");
  fs.writeFileSync(held, "fresh\n");
  fs.renameSync(held, lock);
  const fresh = fs.statSync(lock);
  assert.notEqual(fresh.ino, stale.ino);
  assert.equal(takeOverStaleLock(lock, stale), false);
  assert.equal(fs.readFileSync(lock, "utf8"), "fresh\n");
  assert.equal(fs.statSync(lock).ino, fresh.ino);
  assert.deepEqual(leftovers(dir), []);
});

test("a writer never removes a lock file that is not its own", () => {
  const dir = tmpDir();
  const file = machinesFile({ configDir: dir });
  const store = new MachineStore(file);
  const lock = `${file}.lock`;
  let replaced = false;
  // Simulate another writer taking over our lock while we hold it (e.g. after a long pause).
  const orig = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    orig(from, to);
    if (!replaced && String(to) === file) {
      replaced = true;
      fs.rmSync(lock);
      fs.writeFileSync(lock, "other\n");
    }
  }) as typeof fs.renameSync;
  try {
    store.addMachine("laptop");
  } finally {
    fs.renameSync = orig;
  }
  assert.ok(replaced);
  assert.equal(fs.readFileSync(lock, "utf8"), "other\n");
});

test("a stale lock is taken over by the store and the write goes through", () => {
  const dir = tmpDir();
  const file = machinesFile({ configDir: dir });
  const store = new MachineStore(file, { lockTimeoutMs: 100 });
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, "1\n");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  const secret = store.addMachine("laptop");
  assert.equal(store.secretFor("laptop"), secret);
  assert.equal(fs.existsSync(lock), false);
  assert.deepEqual(leftovers(path.dirname(lock)), []);
});
