// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { Updates } from "../src/daemon/updates.ts";
import { silentLogger } from "../src/daemon/log.ts";
import type { DaemonMessage } from "../src/protocol/messages.ts";

const CONTROL = "!control:example.org";

function mkLink(name: string, machine: string) {
  const sent: DaemonMessage[] = [];
  return { key: name.toLowerCase(), name, machine, since: 0, sent, send: (m: DaemonMessage) => sent.push(m), close() {}, alive: () => true };
}

function setup(names: [string, string][]) {
  const links = names.map(([n, m]) => mkLink(n, m));
  const registry = { get: (k: string) => links.find((l) => l.key === k), list: () => links };
  const receipts: [string, string, string][] = [];
  const notices: string[] = [];
  let t = 0;
  const u = new Updates({
    registry: registry as any,
    reactions: { receipt: async (r: string, e: string, emoji: string) => void receipts.push([r, e, emoji]) },
    log: silentLogger,
    notify: { system: (s) => notices.push(s) },
    now: () => t,
  });
  return { u, links, receipts, notices, advance: (ms: number) => (t += ms) };
}

test("staggers per machine, machines in parallel", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] });
  const { u, links, receipts, notices } = setup([["A", "m1"], ["B", "m1"], ["C", "m2"], ["D", "m1"]]);
  await u.command(CONTROL, "$cmd");
  const count = () => links.map((l) => l.sent.length).join("");
  assert.equal(count(), "1010");
  ctx.mock.timers.tick(7999);
  assert.equal(count(), "1010");
  ctx.mock.timers.tick(1);
  assert.equal(count(), "1110");
  ctx.mock.timers.tick(8000);
  assert.equal(count(), "1111");
  assert.deepEqual(links[0].sent[0], { type: "update" });
  assert.deepEqual(receipts, [[CONTROL, "$cmd", "👀"]]);
  assert.equal(notices[0], "Update requested: A, B, C, D");
  u.cancel();
});

test("all succeed with one version -> checkmark", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] });
  const { u, receipts, notices, advance } = setup([["A", "m1"], ["B", "m2"]]);
  await u.command(CONTROL, "$cmd");
  advance(12_000);
  u.reported("a", "1.2.0");
  u.reported("x", null); // not targeted
  assert.ok(u.active);
  u.reported("b", "1.2.0");
  assert.ok(!u.active);
  assert.deepEqual(receipts.at(-1), [CONTROL, "$cmd", "✅"]);
  assert.equal(notices.at(-1), "Update complete: all 2 agent(s) on version 1.2.0 (12 s)");
});

test("failure and mixed versions -> warning with details", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] });
  const { u, receipts, notices } = setup([["A", "m1"], ["B", "m2"], ["C", "m3"]]);
  await u.command(CONTROL, "$cmd");
  u.reported("a", "1.0");
  u.reported("b", "1.1");
  u.reported("c", null);
  assert.deepEqual(receipts.at(-1), [CONTROL, "$cmd", "⚠️"]);
  assert.equal(notices.at(-1), "Update incomplete (failed: C; mixed versions: A 1.0, B 1.1)");
});

test("timeout -> no response", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] });
  const { u, receipts, notices } = setup([["A", "m1"], ["B", "m1"]]);
  await u.command(CONTROL, "$cmd");
  u.reported("a", "2.0");
  ctx.mock.timers.tick(60_000 + 2 * 10_000 - 1);
  assert.ok(u.active);
  ctx.mock.timers.tick(1);
  assert.ok(!u.active);
  assert.deepEqual(receipts.at(-1), [CONTROL, "$cmd", "⚠️"]);
  assert.equal(notices.at(-1), "Update incomplete (no response: B)");
});

test("single target, unknown target, replacement", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] });
  const { u, links, receipts, notices } = setup([["A", "m1"], ["B", "m1"]]);
  await u.command(CONTROL, "$1", "nobody");
  assert.ok(!u.active);
  assert.equal(notices.at(-1), 'Update: agent "nobody" is not connected.');
  await u.command(CONTROL, "$2");
  assert.equal(links[1].sent.length, 0);
  await u.command(CONTROL, "$3", "B");
  assert.equal(links[1].sent.length, 1);
  ctx.mock.timers.tick(100_000); // old staggered send cancelled, new timeout fires
  assert.equal(links[1].sent.length, 1);
  assert.equal(links[0].sent.length, 1);
  assert.deepEqual(receipts.at(-1), [CONTROL, "$3", "⚠️"]);
  assert.equal(notices.at(-1), "Update incomplete (no response: B)");
  await u.command(CONTROL, "$4", "b");
  u.reported("b", "");
  assert.deepEqual(receipts.at(-1), [CONTROL, "$4", "✅"]);
  assert.match(notices.at(-1)!, /version unknown/);
});

test("an answer that arrives before the receipt returns is counted", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] });
  const links = [mkLink("A", "m1")];
  const registry = { get: (k: string) => links.find((l) => l.key === k), list: () => links };
  const notices: string[] = [];
  const receipts: string[] = [];
  let release!: () => void;
  const u = new Updates({
    registry: registry as any,
    reactions: {
      receipt: (_r: string, _e: string, emoji: string) => {
        receipts.push(emoji);
        return emoji === "👀" ? new Promise<void>((res) => (release = res)) : Promise.resolve();
      },
    },
    log: silentLogger,
    notify: { system: (s) => notices.push(s) },
  });
  const done = u.command(CONTROL, "$cmd");
  assert.equal(links[0].sent.length, 1);
  assert.ok(u.active);
  u.reported("a", null); // fast update_failed while the homeserver is still answering
  assert.ok(!u.active);
  assert.deepEqual(receipts, ["👀", "⚠️"]);
  assert.equal(notices.at(-1), "Update incomplete (failed: A)");
  release();
  await done;
  assert.ok(!u.active);
});

test("a replaced run's timer cannot end the next run early", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] });
  const links = [mkLink("A", "m1"), mkLink("B", "m2")];
  const registry = { get: (k: string) => links.find((l) => l.key === k), list: () => links };
  const notices: string[] = [];
  const releases: (() => void)[] = [];
  const u = new Updates({
    registry: registry as any,
    reactions: { receipt: () => new Promise<void>((res) => releases.push(res)) },
    log: silentLogger,
    notify: { system: (s) => notices.push(s) },
  });
  const first = u.command(CONTROL, "$1", "A"); // 1 agent: 70 s timeout
  ctx.mock.timers.tick(30_000);
  const second = u.command(CONTROL, "$2"); // 2 agents: 80 s timeout, ends at 110 s
  releases.forEach((r) => r());
  await Promise.all([first, second]);
  ctx.mock.timers.tick(79_999);
  assert.ok(u.active);
  assert.ok(!notices.some((n) => n.startsWith("Update incomplete")));
  ctx.mock.timers.tick(1);
  assert.ok(!u.active);
  assert.equal(notices.at(-1), "Update incomplete (no response: A, B)");
  assert.equal(notices.filter((n) => n.startsWith("Update incomplete")).length, 1);
});
