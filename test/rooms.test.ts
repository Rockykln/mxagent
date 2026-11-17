// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../src/daemon/config.ts";
import { silentLogger } from "../src/daemon/log.ts";
import { RoomManager, UnsafeRoomError, type RoomsClient } from "../src/daemon/rooms.ts";
import { StateStore } from "../src/daemon/state.ts";

const BOT = "@bot:example.org";
const OWNER = "@owner:example.org";
const SPACE = "!space:example.org";
const MEGOLM = "m.megolm.v1.aes-sha2";

class FakeRooms {
  seq = 0;
  joined = new Set<string>([SPACE]);
  created: any[] = [];
  stateEvents: { roomId: string; type: string; key: string; content: any }[] = [];
  invites: { user: string; roomId: string }[] = [];
  roomState = new Map<string, Record<string, any>>(); // `${roomId}|${type}|${key}` -> content
  members = new Map<string, string[]>();

  readonly client = {
    createRoom: async (body: any) => {
      this.created.push(body);
      const id = `!r${++this.seq}:example.org`;
      this.joined.add(id);
      return id;
    },
    sendStateEvent: async (roomId: string, type: string, key: string, content: any) => {
      this.stateEvents.push({ roomId, type, key, content });
      return "$s";
    },
    getJoinedRooms: async () => [...this.joined],
    joinRoom: async (id: string) => {
      this.joined.add(id);
      return id;
    },
    leaveRoom: async (id: string) => void this.joined.delete(id),
    getRoomStateEvent: async (roomId: string, type: string, key: string) => {
      const c = this.roomState.get(`${roomId}|${type}|${key}`);
      if (!c) throw Object.assign(new Error("not found"), { statusCode: 404, body: { errcode: "M_NOT_FOUND" } });
      return c;
    },
    getJoinedRoomMembers: async (roomId: string) => this.members.get(roomId) ?? [BOT, OWNER],
    inviteUser: async (user: string, roomId: string) => void this.invites.push({ user, roomId }),
  } as unknown as RoomsClient;

  set(roomId: string, type: string, key: string, content: any) {
    this.roomState.set(`${roomId}|${type}|${key}`, content);
  }
}

function setup(over: Partial<Config> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mxa-rooms-"));
  const state = StateStore.load(path.join(dir, "state.json"));
  const config = { botUser: BOT, owner: OWNER, spaceId: SPACE, serverName: "example.org", ...over } as Config;
  const fake = new FakeRooms();
  const rooms = new RoomManager({ client: fake.client, config, state, log: silentLogger });
  return { dir, state, fake, rooms, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("created rooms are encrypted, invite-only, history from invite, no guests, linked into the space", async () => {
  const t = setup();
  try {
    const id = await t.rooms.ensureAgentRoom("builder");
    const body = t.fake.created[0];
    const st = Object.fromEntries(body.initial_state.map((e: any) => [`${e.type}|${e.state_key}`, e.content]));
    assert.deepEqual(st["m.room.encryption|"], { algorithm: MEGOLM });
    assert.deepEqual(st["m.room.join_rules|"], { join_rule: "invite" });
    assert.deepEqual(st["m.room.history_visibility|"], { history_visibility: "invited" });
    assert.deepEqual(st["m.room.guest_access|"], { guest_access: "forbidden" });
    assert.deepEqual(st[`m.space.parent|${SPACE}`], { via: ["example.org"], canonical: true });
    assert.deepEqual(body.invite, [OWNER]);
    assert.deepEqual(body.power_level_content_override, { users: { [BOT]: 100, [OWNER]: 100 } });
    assert.deepEqual(t.fake.stateEvents.at(-1), { roomId: SPACE, type: "m.space.child", key: id, content: { via: ["example.org"], suggested: false } });
  } finally {
    t.done();
  }
});

test("names like __proto__ are plain entries and survive a save", async () => {
  const t = setup();
  try {
    const id = await t.rooms.ensureAgentRoom("__proto__");
    assert.equal(t.rooms.agentRoom("__proto__"), id);
    assert.equal(t.rooms.roomToAgent(id), "__proto__");
    assert.equal(t.rooms.agentRoom("constructor"), undefined);
    assert.equal(t.rooms.agentRoom("toString"), undefined);
    assert.equal(StateStore.load(t.state.file).data.rooms["__proto__"]?.roomId, id);
    assert.equal(await t.rooms.ensureAgentRoom("__proto__"), id); // reused, no second room
    assert.equal(t.fake.created.length, 1);
  } finally {
    t.done();
  }
});

test("a recreated agent room replaces the stale space child", async () => {
  const t = setup();
  try {
    const old = await t.rooms.ensureAgentRoom("builder");
    t.fake.joined.delete(old); // bot was kicked
    const fresh = await t.rooms.ensureAgentRoom("builder");
    assert.notEqual(fresh, old);
    assert.ok(t.fake.stateEvents.some((e) => e.roomId === SPACE && e.type === "m.space.child" && e.key === old && Object.keys(e.content).length === 0));
  } finally {
    t.done();
  }
});

test("the owner is re-invited when they left an agent room", async () => {
  const t = setup();
  try {
    const id = await t.rooms.ensureAgentRoom("builder");
    t.fake.set(id, "m.room.member", OWNER, { membership: "leave" });
    await t.rooms.ensureAgentRoom("builder");
    assert.deepEqual(t.fake.invites, [{ user: OWNER, roomId: id }]);
    t.fake.set(id, "m.room.member", OWNER, { membership: "join" });
    await t.rooms.ensureAgentRoom("builder");
    assert.equal(t.fake.invites.length, 1);
  } finally {
    t.done();
  }
});

test("a configured control room is used only if encrypted, invite-only, without guests or strangers", async () => {
  const CTL = "!ctl:example.org";
  const safe = (fake: FakeRooms) => {
    fake.set(CTL, "m.room.encryption", "", { algorithm: MEGOLM });
    fake.set(CTL, "m.room.join_rules", "", { join_rule: "invite" });
    fake.set(CTL, "m.room.guest_access", "", { guest_access: "forbidden" });
  };
  const ok = setup({ controlRoomId: CTL });
  try {
    safe(ok.fake);
    assert.equal(await ok.rooms.ensureControlRoom(), CTL);
    assert.equal(ok.rooms.controlRoomId, CTL);
  } finally {
    ok.done();
  }
  const cases: [string, (f: FakeRooms) => void, RegExp][] = [
    ["unencrypted", (f) => f.roomState.delete(`${CTL}|m.room.encryption|`), /not end-to-end encrypted/],
    ["public", (f) => f.set(CTL, "m.room.join_rules", "", { join_rule: "public" }), /join rule is public/],
    ["guests", (f) => f.set(CTL, "m.room.guest_access", "", { guest_access: "can_join" }), /guests can join/],
    ["stranger", (f) => f.members.set(CTL, [BOT, OWNER, "@eve:example.org"]), /1 member\(s\) besides bot and owner/],
  ];
  for (const [label, breakIt, re] of cases) {
    const t = setup({ controlRoomId: CTL });
    try {
      safe(t.fake);
      breakIt(t.fake);
      await assert.rejects(t.rooms.ensureControlRoom(), (e: unknown) => e instanceof UnsafeRoomError && re.test(e.message), label);
      assert.equal(t.rooms.controlRoomId, undefined, label);
    } finally {
      t.done();
    }
  }
});
