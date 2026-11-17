// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry, RESERVED_NAMES, RoomQuota, agentKey, validateAgentName } from "../src/daemon/registry.ts";
import type { AgentLink } from "../src/daemon/registry.ts";
import type { DaemonMessage } from "../src/protocol/messages.ts";

function link(name: string, opts: { instance?: string; alive?: boolean; machine?: string } = {}) {
  let alive = opts.alive ?? true;
  const sent: DaemonMessage[] = [];
  let closed = 0;
  const l: AgentLink & { closed: () => number; kill: () => void; sent: DaemonMessage[] } = {
    key: agentKey(name),
    name,
    instance: opts.instance,
    machine: opts.machine ?? "local",
    since: Date.now(),
    send: (m) => sent.push(m),
    close: () => {
      closed++;
      alive = false;
    },
    alive: () => alive,
    closed: () => closed,
    kill: () => {
      alive = false;
    },
    sent,
  };
  return l;
}

test("validateAgentName", () => {
  assert.equal(validateAgentName("  build-bot  "), "build-bot");
  assert.throws(() => validateAgentName("Build Bot")); // no whitespace: names are used as @name
  assert.equal(validateAgentName("agent_1.x-y"), "agent_1.x-y");
  assert.throws(() => validateAgentName(""));
  assert.throws(() => validateAgentName("a/b"));
  assert.throws(() => validateAgentName("x".repeat(65)));
  assert.throws(() => validateAgentName(42));
  assert.throws(() => validateAgentName("All"), /reserved/);
  assert.throws(() => validateAgentName("list"), /reserved/);
  assert.equal(agentKey("Bot"), "bot");
});

test("register new agents and list sorted", () => {
  const r = new AgentRegistry();
  assert.deepEqual(r.register(link("beta")), { ok: true });
  assert.deepEqual(r.register(link("Alpha")), { ok: true });
  assert.deepEqual(r.keys(), ["alpha", "beta"]);
  assert.equal(r.size, 2);
  assert.equal(r.get("alpha")?.name, "Alpha");
});

test("same instance replaces and closes the old link", () => {
  const r = new AgentRegistry();
  const a = link("bot", { instance: "i1" });
  const b = link("Bot", { instance: "i1" });
  r.register(a);
  const res = r.register(b);
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.reason, "same-instance");
  assert.equal(res.ok && res.replaced, a);
  assert.equal(a.closed(), 1);
  assert.equal(r.get("bot"), b);
  assert.equal(r.remove(a), false, "old link's close handler must not remove the new one");
  assert.equal(r.get("bot"), b);
});

test("stale link is replaced", () => {
  const r = new AgentRegistry();
  const a = link("bot", { instance: "i1" });
  r.register(a);
  a.kill();
  const res = r.register(link("bot", { instance: "i2" }));
  assert.equal(res.ok && res.reason, "stale");
});

test("live duplicate is rejected", () => {
  const r = new AgentRegistry();
  const a = link("bot", { instance: "i1" });
  r.register(a);
  const res = r.register(link("bot", { instance: "i2" }));
  assert.equal(res.ok, false);
  assert.match(!res.ok ? res.error : "", /already connected/);
  assert.equal(r.get("bot"), a);
  assert.equal(a.closed(), 0);
});

test("same instance from another machine does not replace a live link", () => {
  const r = new AgentRegistry();
  const a = link("bot", { instance: "i1", machine: "laptop" });
  r.register(a);
  const res = r.register(link("bot", { instance: "i1", machine: "server" }));
  assert.equal(res.ok, false);
  assert.equal(r.get("bot"), a);
  assert.equal(a.closed(), 0);
});

test("missing instance never replaces a live link", () => {
  const r = new AgentRegistry();
  r.register(link("bot"));
  assert.equal(r.register(link("bot")).ok, false);
});

test("remove, sweep and closeAll", () => {
  const r = new AgentRegistry();
  const a = link("a"), b = link("b"), c = link("c");
  r.register(a);
  r.register(b);
  r.register(c);
  assert.equal(r.remove(a), true);
  assert.equal(r.has("a"), false);
  b.kill();
  assert.deepEqual(r.sweep(), [b]);
  assert.deepEqual(r.keys(), ["c"]);
  r.closeAll();
  assert.equal(r.size, 0);
  assert.equal(c.closed(), 1);
});

test("reserved names follow the protocol", () => {
  assert.deepEqual([...RESERVED_NAMES].sort(), ["all", "control", "list", "room", "system", "update"]);
  for (const n of ["control", "System", "UPDATE", "room"]) assert.throws(() => validateAgentName(n), /reserved/);
  assert.equal(validateAgentName("team"), "team");
});

test("object-prototype keys are rejected as names", () => {
  for (const n of ["__proto__", "constructor", "prototype", "hasOwnProperty", "toString", "__PROTO__"]) {
    assert.throws(() => validateAgentName(n), /reserved/, n);
  }
  assert.equal(validateAgentName("proto"), "proto");
});

test("RoomQuota limits new rooms per machine", () => {
  const q = new RoomQuota(2);
  assert.equal(q.take("laptop", "a"), true);
  assert.equal(q.take("laptop", "a"), true); // same name again does not count twice
  assert.equal(q.take("laptop", "b"), true);
  assert.equal(q.take("laptop", "c"), false);
  assert.equal(q.take("server", "c"), true); // other machines have their own quota
  q.release("laptop", "b");
  assert.equal(q.take("laptop", "c"), true);
  assert.equal(new RoomQuota().take("x", "y"), true);
});
