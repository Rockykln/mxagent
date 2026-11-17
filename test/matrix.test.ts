// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../src/daemon/config.ts";
import { silentLogger } from "../src/daemon/log.ts";
import {
  Matrix,
  MEGOLM,
  MAX_HELD_PER_ROOM,
  OwnerNotJoinedError,
  ReplayLogError,
  ReplayStore,
  SendRefusedError,
  decryptedRaw,
  megolmMessageIndex,
  replayKey,
  type MatrixEvent,
} from "../src/daemon/matrix.ts";
import type { DeviceAudit } from "../src/daemon/trust.ts";
import { StateStore, emptyRooms } from "../src/daemon/state.ts";

const BOT = "@bot:example.org";
const OWNER = "@owner:example.org";
const ROOM = "!room:example.org";

const config = { botUser: BOT, owner: OWNER, serverName: "example.org" } as Config;
const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeClient {
  handlers = new Map<string, ((...a: any[]) => any)[]>();
  members = new Map<string, string[] | Error>();
  encState = new Map<string, any>();
  store = new Map<string, any>();
  sent: { roomId: string; content: any }[] = [];
  events: { roomId: string; type: string }[] = [];
  syncs = 0;
  cryptoStore = {
    getRoom: async (id: string) => this.store.get(id),
    storeRoom: async (id: string, c: any) => void this.store.set(id, c),
  };
  shareCalls = 0;
  shareResult: any[] = [];
  syncedToDevice = "";
  invalidated = 0;
  outgoing: any[] = [];
  crypto: any = {
    isRoomEncrypted: async (id: string) => !!this.store.get(id)?.algorithm,
    engine: undefined as any,
    deviceEd25519: "ZGV2aWNlLWVkMjU1MTkta2V5LWZvci10ZXN0cw",
    clientDeviceId: "BOTDEV",
    prepare: async () => {
      // like matrix-bot-sdk: the machine only exists after prepare()
      this.crypto.engine = {
        machine: {
          shareRoomKey: async () => (this.shareCalls++, this.shareResult),
          invalidateGroupSession: async () => void this.invalidated++,
          receiveSyncChanges: async (toDevice: string) => ((this.syncedToDevice = toDevice), "[]"),
          outgoingRequests: async () => this.outgoing,
        },
      };
    },
  };
  syncResponse: any = {};
  on(ev: string, cb: (...a: any[]) => any) {
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), cb]);
  }
  async emit(ev: string, ...args: any[]) {
    for (const h of this.handlers.get(ev) ?? []) await h(...args);
  }
  async getJoinedRoomMembers(roomId: string) {
    const m = this.members.get(roomId) ?? [BOT];
    if (m instanceof Error) throw m;
    return m;
  }
  async getRoomStateEvent(roomId: string, type: string) {
    if (type === "m.room.encryption" && this.encState.has(roomId)) return this.encState.get(roomId);
    throw Object.assign(new Error("not found"), { statusCode: 404 });
  }
  async createRoom(_body: any) {
    return "!new:example.org";
  }
  async sendMessage(roomId: string, content: any) {
    this.sent.push({ roomId, content });
    // like matrix-bot-sdk: encryption shares keys with /joined_members
    await this.getJoinedRoomMembers(roomId);
    return `$m${this.sent.length}`;
  }
  async sendEvent(roomId: string, type: string) {
    this.events.push({ roomId, type });
    return `$e${this.events.length}`;
  }
  async getEvent(_roomId: string, _id: string) {
    return { event_id: _id, sender: OWNER, type: "m.room.message", content: { body: "x" }, mxa_sender: { device: "D", curveKey: "C" }, mxa_replay_key: "k" };
  }
  async doSync(_t: unknown) {
    this.syncs++;
    return this.syncResponse;
  }
  async start() {
    await this.crypto.prepare();
  }
  stop() {}
  async joinRoom(id: string) {
    return id;
  }
}

const OWN_CURVE = "ownerCurveKey";
const BOT_CURVE = "botCurveKey";
const OK_AUDIT: DeviceAudit = {
  problem: null,
  allowed: new Map([[OWNER, new Set(["OWNDEV"])], [BOT, new Set(["BOTDEV"])]]),
  allowedKeys: new Map([[OWNER, new Map([["OWNDEV", OWN_CURVE]])], [BOT, new Map([["BOTDEV", BOT_CURVE]])]]),
};
const olm = (curve: string, n: number) => ({ algorithm: "m.olm.v1.curve25519-aes-sha2", sender_key: "x", ciphertext: { [curve]: { type: 0, body: String(n) } } });

function setup(opts: { replay?: ReplayStore; audit?: DeviceAudit | null; state?: StateStore } = {}) {
  const client = new FakeClient();
  const m = new Matrix({ client: client as any, config, log: silentLogger, replay: opts.replay, state: opts.state, retryMinMs: 5, retryMaxMs: 20 });
  if (opts.audit !== null) {
    const audit = opts.audit ?? OK_AUDIT;
    m.setDeviceGuard(async () => audit);
  }
  const refused: [string, string][] = [];
  const dropped: [string, number][] = [];
  m.onSendRefused((r, why) => refused.push([r, why]));
  m.onHeldDropped((r, n) => dropped.push([r, n]));
  return { client, m, refused, dropped };
}

/** Room that passes the guard: encrypted, bot and owner joined. */
function okRoom(client: FakeClient, roomId = ROOM) {
  client.store.set(roomId, { algorithm: MEGOLM });
  client.members.set(roomId, [BOT, OWNER]);
}

let n = 0;
function decrypted(over: Partial<MatrixEvent> & { key?: string } = {}): MatrixEvent {
  const { key, ...rest } = over;
  return {
    event_id: `$d${++n}`,
    sender: OWNER,
    type: "m.room.message",
    origin_server_ts: Date.now(),
    content: { msgtype: "m.text", body: "hi" },
    mxa_sender: { device: "DEV", curveKey: "CURVE" },
    mxa_replay_key: key ?? `key-${n}-aaaaaaaaaaaaaaaa`,
    ...rest,
  } as MatrixEvent;
}

/** Megolm v1 message: 0x03, field 1 = index (varint), field 2 = ciphertext bytes, 8-byte MAC, 64-byte signature. */
function megolm(index: number, ctLen = 13, opts: { version?: number; extra?: number[] } = {}): Buffer {
  const varint = (v: number) => {
    const out: number[] = [];
    do {
      let b = v % 128;
      v = Math.floor(v / 128);
      if (v) b |= 0x80;
      out.push(b);
    } while (v);
    return out;
  };
  const ct = Array.from({ length: ctLen }, (_, i) => (i * 7 + index) & 0xff);
  return Buffer.from([opts.version ?? 3, 0x08, ...varint(index), 0x12, ...varint(ctLen), ...ct, ...(opts.extra ?? []), ...new Array(8).fill(0xaa), ...new Array(64).fill(0xbb)]);
}
const b64 = (b: Buffer) => b.toString("base64");
const unpad = (s: string) => s.replace(/=+$/, "");
const SID = "c2Vzc2lvbi1pZC1mb3ItdGVzdHM";
const enc = (ciphertext: string, sid = SID) => ({ content: { algorithm: MEGOLM, ciphertext, session_id: sid } });

test("megolmMessageIndex parses padded and unpadded ciphertexts and rejects malformed ones", () => {
  for (const idx of [0, 1, 127, 128, 300, 0xffffffff]) {
    const buf = megolm(idx);
    assert.equal(megolmMessageIndex(b64(buf)), idx);
    assert.equal(megolmMessageIndex(unpad(b64(buf))), idx);
  }
  assert.equal(megolmMessageIndex(b64(megolm(5, 13, { extra: [0x18, 0x01] }))), 5); // unknown varint field skipped
  assert.equal(megolmMessageIndex(b64(megolm(5, 13, { version: 4 }))), null);
  assert.equal(megolmMessageIndex(b64(megolm(5, 13, { extra: [0x08, 0x06] }))), null); // duplicate index
  assert.equal(megolmMessageIndex(b64(megolm(5, 13, { extra: [0x0b] }))), null); // unknown wire type
  assert.equal(megolmMessageIndex(b64(megolm(5)).slice(0, 40)), null); // truncated
  assert.equal(megolmMessageIndex("CT"), null);
  assert.equal(megolmMessageIndex("-" + b64(megolm(5)).slice(1)), null); // url-safe alphabet
  assert.equal(megolmMessageIndex(b64(megolm(5)) + "==="), null);
  assert.equal(megolmMessageIndex(undefined), null);
});

test("replay key: padded, unpadded and over-padded forms of one Megolm message are the same message", () => {
  // 13-byte body: total length not a multiple of 3, so the canonical form has padding
  for (const ctLen of [13, 14, 15]) {
    const buf = megolm(42, ctLen);
    const forms = [b64(buf), unpad(b64(buf))];
    if (!b64(buf).endsWith("=")) forms.push(b64(buf)); // already canonical without padding
    const keys = new Set(forms.map((f) => replayKey(ROOM, enc(f))));
    assert.equal(keys.size, 1, `ctLen ${ctLen}`);
    assert.ok([...keys][0]);
    // padded session id is the same session
    assert.equal(replayKey(ROOM, enc(forms[0], SID + "=")), [...keys][0]);
  }
  const k = replayKey(ROOM, enc(b64(megolm(42))));
  assert.notEqual(replayKey(ROOM, enc(b64(megolm(43)))), k); // next index
  assert.notEqual(replayKey(ROOM, enc(b64(megolm(42)), "b3RoZXItc2Vzc2lvbg")), k); // other session
  assert.notEqual(replayKey("!other:example.org", enc(b64(megolm(42)))), k);
  assert.equal(replayKey(ROOM, enc("not megolm")), null);
  assert.equal(replayKey(ROOM, { content: { ciphertext: b64(megolm(1)), session_id: SID } }), null); // no algorithm
  assert.equal(replayKey(ROOM, enc(b64(megolm(1)), "")), null);
});

test("a re-padded replay of a delivered event is dropped", async () => {
  const { client, m } = setup();
  const got: string[] = [];
  m.onDecrypted((_r, e) => {
    if (m.recordReplay(e.mxa_replay_key)) got.push(e.event_id);
  });
  const buf = megolm(7, 13);
  const d = { event: JSON.stringify({ type: "m.room.message", content: { body: "rm -rf build" } }), senderDevice: { toString: () => "OWNDEV" }, senderCurve25519Key: "C" };
  for (const [id, ct] of [["$orig", unpad(b64(buf))], ["$pad1", b64(buf)], ["$pad2", unpad(b64(buf)) + "=="]] as const) {
    const raw = { event_id: id, sender: OWNER, type: "m.room.encrypted", origin_server_ts: Date.now(), content: { algorithm: MEGOLM, ciphertext: ct, session_id: SID } };
    await client.emit("room.decrypted_event", ROOM, decryptedRaw(raw, ROOM, d));
  }
  assert.deepEqual(got, ["$orig"]);
});

test("decryptedRaw keeps sender user, device, keys, forwarding and shield info", () => {
  const raw = { event_id: "$x", sender: OWNER, type: "m.room.encrypted", content: { algorithm: MEGOLM, ciphertext: b64(megolm(3)), session_id: SID } };
  const out = decryptedRaw(raw, ROOM, {
    event: JSON.stringify({ type: "m.room.message", content: { body: "b" } }),
    sender: { toString: () => OWNER },
    senderDevice: { toString: () => "DEV" },
    senderCurve25519Key: "CURVE",
    senderClaimedEd25519Key: "ED",
    forwardingCurve25519KeyChain: ["OTHER"],
    shieldState: () => ({ color: 1, code: 3 }),
  });
  assert.equal(out.type, "m.room.message");
  assert.deepEqual(out.content, { body: "b" });
  assert.deepEqual(out.mxa_sender, { device: "DEV", curveKey: "CURVE", userId: OWNER, claimedEd25519: "ED", forwarded: true, shield: { color: 1, code: 3 } });
  assert.equal(out.mxa_replay_key, replayKey(ROOM, raw));
  assert.ok(out.mxa_replay_key);
  assert.equal(replayKey(ROOM, { content: {} }), null);
  const direct = decryptedRaw(raw, ROOM, { event: "{}", forwardingCurve25519KeyChain: [] });
  assert.equal(direct.mxa_sender.forwarded, false);
});

test("dispatch only checks the replay key; the handler records it, later copies are dropped", async () => {
  const replay = new ReplayStore();
  const { client, m } = setup({ replay });
  const got: string[] = [];
  let record = false;
  m.onDecrypted((_r, e) => {
    got.push(e.event_id);
    if (record) assert.equal(m.recordReplay(e.mxa_replay_key), true);
  });
  // not recorded by dispatch (an untrusted sender would otherwise take slots)
  const first = decrypted({ key: "same-key-aaaaaaaaaaaa" });
  await client.emit("room.decrypted_event", ROOM, first);
  assert.equal(replay.size, 0);
  assert.equal(first.mxa_replay_key, "same-key-aaaaaaaaaaaa"); // kept for the handler
  record = true;
  await client.emit("room.decrypted_event", ROOM, decrypted({ key: "same-key-aaaaaaaaaaaa" }));
  await client.emit("room.decrypted_event", ROOM, decrypted({ key: "same-key-aaaaaaaaaaaa", origin_server_ts: Date.now() + 1000 }));
  await client.emit("room.decrypted_event", ROOM, decrypted({ key: undefined as any, mxa_replay_key: undefined } as any));
  await client.emit("room.decrypted_event", ROOM, decrypted({ key: "bad key" }));
  assert.equal(got.length, 2);
  assert.equal(m.isReplay("same-key-aaaaaaaaaaaa"), true);
  assert.equal(m.recordReplay("same-key-aaaaaaaaaaaa"), false);
  assert.equal(m.recordReplay(undefined), false);
  assert.equal(m.isReplay(undefined), true);
});

test("own events are not recorded, so they never take replay slots", async () => {
  const replay = new ReplayStore({ cap: 10 });
  const { client } = setup({ replay });
  await client.emit("room.decrypted_event", ROOM, decrypted({ sender: BOT }));
  assert.equal(replay.size, 0);
});

test("getEvent decrypts already-seen events, strips mxa_sender and leaves the replay store alone", async () => {
  const replay = new ReplayStore();
  const { m } = setup({ replay });
  const ev = await m.getEvent(ROOM, "$a");
  assert.equal(ev.mxa_sender, undefined);
  assert.equal("mxa_replay_key" in ev, false);
  assert.equal(replay.size, 0);
});

test("replay store persists across restarts, is 0600 and stays bounded", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mxa-replay-"));
  try {
    const file = path.join(dir, "replay.log");
    const a = new ReplayStore({ file, cap: 3 });
    for (const k of ["k1aaaaaaaaaaaaaaaa", "k2aaaaaaaaaaaaaaaa", "k3aaaaaaaaaaaaaaaa"]) assert.equal(a.add(k), true);
    assert.equal(a.add("k1aaaaaaaaaaaaaaaa"), false);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const b = new ReplayStore({ file, cap: 3 });
    assert.equal(b.has("k2aaaaaaaaaaaaaaaa"), true);
    assert.equal(b.add("k3aaaaaaaaaaaaaaaa"), false);
    for (let i = 0; i < 10; i++) b.add(`n${i}aaaaaaaaaaaaaaaa`);
    assert.equal(b.size, 3);
    assert.ok(fs.readFileSync(file, "utf8").trim().split("\n").length <= 7); // compacted at 2 x cap
    const c = new ReplayStore({ file, cap: 3 });
    assert.equal(c.has("n9aaaaaaaaaaaaaaaa"), true);
    assert.equal(c.has("k1aaaaaaaaaaaaaaaa"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("replay store refuses to follow a symlinked log file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mxa-replay-"));
  try {
    const target = path.join(dir, "target");
    fs.writeFileSync(target, "");
    fs.symlinkSync(target, path.join(dir, "replay.log"));
    assert.throws(() => new ReplayStore({ file: path.join(dir, "replay.log") }), /cannot read replay log .*ELOOP/);
    assert.equal(fs.readFileSync(target, "utf8"), "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("replay store refuses to start on an unreadable or corrupt log", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mxa-replay-"));
  try {
    const file = path.join(dir, "replay.log");
    fs.writeFileSync(file, "k1aaaaaaaaaaaaaaaa\nthis is not a key\n");
    assert.throws(() => new ReplayStore({ file }), /malformed line 2/);
    fs.writeFileSync(file, "k1aaaaaaaaaaaaaaaa\n");
    assert.equal(new ReplayStore({ file }).has("k1aaaaaaaaaaaaaaaa"), true);
    fs.rmSync(file);
    fs.mkdirSync(file);
    assert.throws(() => new ReplayStore({ file }), /cannot read replay log/);
    fs.rmdirSync(file);
    if (process.getuid?.() !== 0) {
      fs.writeFileSync(file, "", { mode: 0o000 });
      assert.throws(() => new ReplayStore({ file }), /EACCES/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("replay store throws ReplayLogError when a key cannot be written, but still remembers it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mxa-replay-"));
  try {
    const file = path.join(dir, "replay.log");
    const s = new ReplayStore({ file });
    fs.mkdirSync(file); // appends now fail
    assert.throws(() => s.add("k1aaaaaaaaaaaaaaaa"), ReplayLogError);
    assert.equal(s.has("k1aaaaaaaaaaaaaaaa"), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("send guard: refuses every encrypted send while a device of owner or bot is unverified", async () => {
  const problem = "unverified device(s): @owner:example.org EVILDEV; verify them with cross-signing or remove them";
  const { client, m, refused } = setup({ audit: { problem, allowed: new Map(), allowedKeys: new Map() } });
  okRoom(client);
  await assert.rejects(m.sendText(ROOM, "secret"), SendRefusedError);
  await assert.rejects(m.sendEvent(ROOM, "m.poll.start", {}), SendRefusedError);
  assert.equal(client.sent.length, 0);
  assert.deepEqual(refused, [[ROOM, problem]]);

  const none = setup({ audit: null }); // no guard configured: fails closed
  okRoom(none.client);
  await assert.rejects(none.m.sendText(ROOM, "x"), /device check not configured/);
  assert.equal(none.client.sent.length, 0);

  // a failing key query holds the message instead of sending it
  const failing = setup({ audit: null });
  okRoom(failing.client);
  failing.m.setDeviceGuard(async () => {
    throw new Error("keys query failed");
  });
  assert.equal((await failing.m.sendText(ROOM, "later")).held, true);
  assert.equal(failing.client.sent.length, 0);
  failing.m.stop();
});

test("key sharing backstop: room keys go only to devices the guard allows", async () => {
  const { client, m } = setup();
  await m.start();
  const machine = client.crypto.engine.machine;
  const body = {
    messages: {
      [OWNER]: { OWNDEV: olm(OWN_CURVE, 1), EVILDEV: olm("evilCurve", 2) },
      [BOT]: { BOTDEV: olm(BOT_CURVE, 3), "*": olm(BOT_CURVE, 4) },
      "@eve:example.org": { EVE: olm("eveCurve", 5) },
    },
  };
  client.shareResult = [{ id: "r1", txnId: "t1", eventType: "m.room.encrypted", type: 3, body: JSON.stringify(body) }];
  const [req] = await machine.shareRoomKey({ toString: () => ROOM }, [], {});
  assert.equal(req.txnId, "t1");
  assert.deepEqual(JSON.parse(req.body).messages, { [OWNER]: { OWNDEV: olm(OWN_CURVE, 1) }, [BOT]: { BOTDEV: olm(BOT_CURVE, 3) } });
  assert.equal(client.invalidated, 1); // something was removed: the next send starts a new session
  // N1: an allowed device id whose key share is encrypted to a different (forged) curve25519 key is removed.
  client.shareResult = [{ id: "r3", txnId: "t3", eventType: "m.room.encrypted", type: 3, body: JSON.stringify({ messages: { [OWNER]: { OWNDEV: olm("forgedCurve", 6) } } }) }];
  assert.deepEqual(JSON.parse((await machine.shareRoomKey(ROOM, [], {}))[0].body).messages, {});
  const clean = { id: "r2", txnId: "t2", eventType: "m.room.encrypted", type: 3, body: JSON.stringify({ messages: { [OWNER]: { OWNDEV: olm(OWN_CURVE, 7) } } }) };
  client.shareResult = [clean];
  assert.equal((await machine.shareRoomKey(ROOM, [], {}))[0], clean); // untouched
  m.stop();

  const unguarded = setup({ audit: null });
  await unguarded.m.start();
  unguarded.client.shareResult = [clean];
  await assert.rejects(unguarded.client.crypto.engine.machine.shareRoomKey(ROOM, [], {}), SendRefusedError);
  unguarded.m.stop();
});

test("device list changes of owner or bot from sync are reported", async () => {
  const { client, m } = setup();
  const seen: string[][] = [];
  m.onDevicesChanged((u) => seen.push(u));
  client.syncResponse = { device_lists: { changed: [OWNER, "@eve:example.org"], left: [] } };
  await client.doSync(null);
  client.syncResponse = { device_lists: { changed: ["@eve:example.org"] } };
  await client.doSync(null);
  client.syncResponse = { device_lists: { changed: [BOT], left: [OWNER, BOT] } };
  await client.doSync(null);
  client.syncResponse = {};
  await client.doSync(null);
  assert.deepEqual(seen, [[OWNER], [BOT, OWNER]]);
});

test("start stores the device's ed25519 key in the state", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mxa-state-"));
  try {
    const file = path.join(dir, "state.json");
    const state = new StateStore(file, { rooms: emptyRooms() });
    const { client, m } = setup({ state });
    await m.start();
    assert.equal(state.data.deviceEd25519, client.crypto.deviceEd25519);
    assert.equal(StateStore.load(file).data.deviceEd25519, client.crypto.deviceEd25519);
    m.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("send guard: never sends to a room whose encryption is unknown", async () => {
  const { client, m, refused } = setup();
  client.members.set(ROOM, [BOT, OWNER]);
  await assert.rejects(m.sendText(ROOM, "a"), SendRefusedError);
  await assert.rejects(m.sendText(ROOM, "b"), SendRefusedError);
  await assert.rejects(m.sendEvent(ROOM, "m.poll.start", {}), SendRefusedError);
  assert.equal(client.sent.length, 0);
  assert.equal(client.events.length, 0);
  assert.deepEqual(refused, [[ROOM, "room is not known to be encrypted"]]); // reported once
});

test("send guard: rooms we created and rooms with megolm state count as encrypted", async () => {
  const { client, m } = setup();
  const id = await (client as any).createRoom({ initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: MEGOLM } }] });
  assert.equal(m.isKnownEncrypted(id), true);
  assert.equal(client.store.get(id)?.algorithm, MEGOLM); // seeded so the SDK encrypts too
  client.members.set(id, [BOT, OWNER]);
  assert.equal((await m.sendText(id, "x")).held, false);

  client.encState.set(ROOM, { algorithm: MEGOLM });
  client.members.set(ROOM, [BOT, OWNER]);
  assert.equal((await m.sendText(ROOM, "y")).held, false);

  const other = "!plain:example.org";
  await client.emit("room.event", other, { event_id: "$s", sender: OWNER, type: "m.room.encryption", state_key: "", content: { algorithm: MEGOLM } });
  assert.equal(m.isKnownEncrypted(other), true);
});

test("send guard: refuses rooms with members besides bot and owner and blocks key sharing", async () => {
  const { client, m, refused } = setup();
  okRoom(client);
  client.members.set(ROOM, [BOT, OWNER, "@eve:example.org"]);
  await assert.rejects(m.sendText(ROOM, "secret"), SendRefusedError);
  await assert.rejects((client as any).getJoinedRoomMembers(ROOM), SendRefusedError);
  assert.equal(client.sent.length, 0);
  assert.equal(refused.length, 1);
  // fixed: sends again, and a new problem is reported again
  client.members.set(ROOM, [BOT, OWNER]);
  await client.emit("room.event", ROOM, { event_id: "$l", sender: "@eve:example.org", type: "m.room.member", state_key: "@eve:example.org", content: { membership: "leave" } });
  assert.equal((await m.sendText(ROOM, "ok")).held, false);
  client.members.set(ROOM, [BOT, OWNER, "@eve:example.org"]);
  await client.emit("room.event", ROOM, { event_id: "$j", sender: "@eve:example.org", type: "m.room.member", state_key: "@eve:example.org", content: { membership: "join" } });
  await assert.rejects(m.sendText(ROOM, "again"), SendRefusedError);
  assert.equal(refused.length, 2);
});

test("send guard also applies when a stranger shows up between check and key sharing", async () => {
  const { client, m } = setup();
  okRoom(client);
  assert.equal((await m.sendText(ROOM, "1")).held, false); // members cached as ok
  client.members.set(ROOM, [BOT, OWNER, "@eve:example.org"]);
  await assert.rejects(m.sendText(ROOM, "2"), SendRefusedError); // refused inside the SDK's key sharing
});

test("held messages are sent in order when the owner joins", async () => {
  const { client, m } = setup();
  client.store.set(ROOM, { algorithm: MEGOLM });
  assert.equal((await m.sendText(ROOM, "1")).held, true);
  assert.equal((await m.sendText(ROOM, "2")).held, true);
  await assert.rejects(m.sendText(ROOM, "x").then(() => m.sendMessage(ROOM, { body: "y" }, { hold: false })), OwnerNotJoinedError);
  client.members.set(ROOM, [BOT, OWNER]);
  await client.emit("room.event", ROOM, { event_id: "$j", sender: OWNER, type: "m.room.member", state_key: OWNER, content: { membership: "join" } });
  await m.sendText(ROOM, "3");
  assert.deepEqual(client.sent.map((s) => s.content.body), ["1", "2", "x", "3"]);
  assert.equal(m.heldCount(ROOM), 0);
});

test("a failed membership lookup holds and retries until the owner is joined", async () => {
  const { client, m } = setup();
  client.store.set(ROOM, { algorithm: MEGOLM });
  client.members.set(ROOM, new Error("timeout"));
  assert.equal((await m.sendText(ROOM, "a")).held, true);
  await assert.rejects(m.sendMessage(ROOM, { body: "b" }, { hold: false }), /timeout/);
  await sleep(15);
  client.members.set(ROOM, [BOT, OWNER]); // no join event: found by the retry
  for (let i = 0; i < 50 && client.sent.length === 0; i++) await sleep(5);
  assert.deepEqual(client.sent.map((s) => s.content.body), ["a"]);
  m.stop();
});

test("held queue keeps the last 50 and reports drops", async () => {
  const { client, m, dropped } = setup();
  client.store.set(ROOM, { algorithm: MEGOLM });
  for (let i = 0; i < MAX_HELD_PER_ROOM + 2; i++) await m.sendText(ROOM, String(i));
  assert.equal(m.heldCount(ROOM), MAX_HELD_PER_ROOM);
  assert.deepEqual(dropped, [
    [ROOM, 1],
    [ROOM, 1],
  ]);
  m.stop();
  assert.equal(dropped.length, 2); // stop() only logs
});

test("health follows the sync loop", async () => {
  const { client, m } = setup();
  assert.equal(m.healthy(), false);
  await m.start();
  await assert.rejects(m.start(), /already started/);
  assert.equal(m.healthy(), true);
  await sleep(10);
  assert.equal(m.healthy(5), false);
  await client.doSync(null);
  assert.equal(client.syncs, 1);
  assert.equal(m.healthy(5), true);
  m.stop();
  assert.equal(m.healthy(), false);
  await tick();
});

test("key requests are dropped and queued key forwards go only to allowed, key-bound devices (N2)", async () => {
  const { client, m } = setup();
  await m.start();
  const machine = client.crypto.engine.machine;
  const events = [
    { type: "m.room_key_request", sender: OWNER, content: { action: "request", requesting_device_id: "EVILDEV" } },
    { type: "m.secret.request", sender: OWNER, content: { action: "request", name: "m.cross_signing.master" } },
    { type: "m.room.encrypted", sender: OWNER, content: {} },
  ];
  await machine.receiveSyncChanges(JSON.stringify(events), "{}", new Map(), []);
  assert.deepEqual(JSON.parse(client.syncedToDevice).map((e: any) => e.type), ["m.room.encrypted"]);

  const forward = { txn_id: "f1", event_type: "m.room.encrypted", messages: { [OWNER]: { EVILDEV: olm("evilCurve", 1), OWNDEV: olm("forgedCurve", 2) }, [BOT]: { BOTDEV: olm(BOT_CURVE, 3) } } };
  const verification = { txn_id: "v1", event_type: "m.key.verification.request", messages: { [OWNER]: { OWNDEV: { methods: [] } } } };
  const upload = { id: "u1", type: 0, body: "{}" };
  client.outgoing = [{ id: "f1", type: 3, body: JSON.stringify(forward) }, { id: "v1", type: 3, body: JSON.stringify(verification) }, upload];
  const out = await machine.outgoingRequests();
  assert.equal(out[0].id, "f1");
  assert.deepEqual(JSON.parse(out[0].body).messages, { [BOT]: { BOTDEV: olm(BOT_CURVE, 3) } });
  assert.equal(JSON.parse(out[0].body).txn_id, "f1");
  assert.equal(out[1], client.outgoing[1]); // plaintext, no keys inside: untouched
  assert.equal(out[2], upload);
  m.stop();
});
