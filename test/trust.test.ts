// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { OwnerTrust, canonicalJson, verifySignature } from "../src/daemon/trust.ts";
import type { KeysQueryResponse, SignedKeys } from "../src/daemon/trust.ts";

const BOT = "@bot:example.org";
const OWNER = "@owner:example.org";
const DEVICE = "OWNERDEV";
const CURVE = "curve-key-of-owner-device";

const unpadded = (b: Buffer) => b.toString("base64").replace(/=+$/, "");

function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { pub: unpadded(raw), privateKey };
}
type KP = ReturnType<typeof keyPair>;

function sign(obj: SignedKeys, signer: string, keyId: string, kp: KP): SignedKeys {
  const { signatures, unsigned: _u, ...signed } = obj;
  const sig = unpadded(crypto.sign(null, Buffer.from(canonicalJson(signed)), kp.privateKey));
  return { ...obj, signatures: { ...signatures, [signer]: { ...signatures?.[signer], [`ed25519:${keyId}`]: sig } } };
}

const crossKey = (user: string, usage: string, kp: KP): SignedKeys => ({ user_id: user, usage: [usage], keys: { [`ed25519:${kp.pub}`]: kp.pub } });

function world() {
  const botMaster = keyPair(), botUsk = keyPair(), ownerMaster = keyPair(), ownerSsk = keyPair(), deviceKey = keyPair();
  const build = (opts: { verifiedByBot?: boolean; deviceSigned?: boolean; master?: KP; bot?: { master: KP; usk: KP } } = {}): KeysQueryResponse => {
    const om = opts.master ?? ownerMaster;
    const bm = opts.bot?.master ?? botMaster;
    const bu = opts.bot?.usk ?? botUsk;
    let ownerMasterObj = crossKey(OWNER, "master", om);
    if (opts.verifiedByBot !== false) ownerMasterObj = sign(ownerMasterObj, BOT, bu.pub, bu);
    let dev: SignedKeys = {
      user_id: OWNER,
      device_id: DEVICE,
      algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
      keys: { [`curve25519:${DEVICE}`]: CURVE, [`ed25519:${DEVICE}`]: deviceKey.pub },
      unsigned: { device_display_name: "phone" },
    };
    dev = sign(dev, OWNER, DEVICE, deviceKey);
    if (opts.deviceSigned !== false) dev = sign(dev, OWNER, ownerSsk.pub, ownerSsk);
    return {
      master_keys: { [BOT]: crossKey(BOT, "master", bm), [OWNER]: ownerMasterObj },
      user_signing_keys: { [BOT]: sign(crossKey(BOT, "user_signing", bu), BOT, bm.pub, bm) },
      self_signing_keys: { [OWNER]: sign(crossKey(OWNER, "self_signing", ownerSsk), OWNER, om.pub, om) },
      device_keys: { [OWNER]: { [DEVICE]: dev } },
    };
  };
  return { build, ownerMaster, botMaster };
}

function makeTrust(responses: KeysQueryResponse[] | (() => KeysQueryResponse), anchor: string | undefined, pinned?: string) {
  const calls: unknown[] = [];
  const pins: string[] = [];
  let pin = pinned;
  let clock = 0;
  const trust = new OwnerTrust({
    queryKeys: async (body) => {
      calls.push(body);
      if (typeof responses === "function") return responses();
      return responses[Math.min(calls.length - 1, responses.length - 1)];
    },
    botUser: BOT,
    owner: OWNER,
    getPinnedMaster: () => pin,
    pinMaster: (k) => {
      pin = k;
      pins.push(k);
    },
    getBotMasterKey: () => anchor,
    now: () => clock,
  });
  return { trust, calls, pins, tick: (ms: number) => (clock += ms), pinned: () => pin };
}

/** Trust over a fresh world, anchored to that world's bot master key. */
function anchored(opts: Parameters<ReturnType<typeof world>["build"]>[0] = {}, pinned?: (w: ReturnType<typeof world>) => string) {
  const w = world();
  return { w, ...makeTrust([w.build(opts)], w.botMaster.pub, pinned?.(w)) };
}

const NOT_ANCHORED = "bot identity not anchored; run mxagentctl cross-sign";

test("canonicalJson sorts keys and drops whitespace", () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, "x"], c: { z: 1, y: 2 } }), '{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}');
});

test("verifySignature ignores signatures and unsigned", () => {
  const kp = keyPair();
  const obj = sign({ keys: { a: "b" }, unsigned: { x: 1 } }, BOT, kp.pub, kp);
  assert.equal(verifySignature(obj, BOT, kp.pub, kp.pub), true);
  assert.equal(verifySignature({ ...obj, keys: { a: "c" } }, BOT, kp.pub, kp.pub), false);
  assert.equal(verifySignature(obj, OWNER, kp.pub, kp.pub), false);
  assert.equal(verifySignature(obj, BOT, kp.pub, "not-a-key"), false);
});

test("trusted device passes and pins the master key on first use", async () => {
  const t = anchored();
  assert.equal(await t.trust.check(DEVICE, CURVE), null);
  assert.deepEqual(t.pins, [t.w.ownerMaster.pub]);
  assert.deepEqual(t.calls[0], { device_keys: { [OWNER]: [], [BOT]: [] } });
});

test("missing bot anchor: nothing is trusted or pinned", async () => {
  const w = world();
  const t = makeTrust([w.build()], undefined);
  assert.equal(await t.trust.check(DEVICE, CURVE), NOT_ANCHORED);
  assert.equal(t.pins.length, 0);
  const pinned = makeTrust([w.build()], undefined, w.ownerMaster.pub);
  assert.equal(await pinned.trust.check(DEVICE, CURVE), NOT_ANCHORED);
});

test("forged bot identity from the homeserver is rejected and not pinned", async () => {
  // The homeserver invents a bot master + user-signing key and an owner identity signed by them.
  const real = world();
  const forged = world();
  const fakeBot = { master: keyPair(), usk: keyPair() };
  const t = makeTrust([forged.build({ bot: fakeBot })], real.botMaster.pub);
  assert.equal(await t.trust.check(DEVICE, CURVE), NOT_ANCHORED);
  assert.equal(t.pins.length, 0);
  assert.equal(t.calls.length, 2); // refreshed once before rejecting
});

test("a pinned owner is no longer trusted when the bot master key changes", async () => {
  const w = world();
  const t = makeTrust([w.build({ bot: { master: keyPair(), usk: keyPair() } })], w.botMaster.pub, w.ownerMaster.pub);
  assert.equal(await t.trust.check(DEVICE, CURVE), NOT_ANCHORED);
});

test("bot master key without user_id or master usage does not match the anchor", async () => {
  for (const mutate of [(k: SignedKeys) => delete k.user_id, (k: SignedKeys) => delete k.usage, (k: SignedKeys) => (k.usage = ["self_signing"])]) {
    const w = world();
    const q = w.build();
    mutate(q.master_keys![BOT]);
    assert.equal(await makeTrust([q], w.botMaster.pub).trust.check(DEVICE, CURVE), NOT_ANCHORED);
  }
});

test("missing sender info is rejected without a query", async () => {
  const t = anchored();
  assert.equal(await t.trust.check(null, CURVE), "unknown sender device");
  assert.equal(await t.trust.check(DEVICE, null), "unknown sender device");
  assert.equal(t.calls.length, 0);
});

test("wrong curve key is rejected", async () => {
  const t = anchored();
  assert.equal(await t.trust.check(DEVICE, "other"), "sender key does not match device");
});

test("unknown device is rejected after a forced refresh", async () => {
  const t = anchored();
  assert.match((await t.trust.check("NOPE", CURVE)) ?? "", /unknown/);
  assert.equal(t.calls.length, 2);
});

test("device keys without user_id or device_id are rejected", async () => {
  for (const field of ["user_id", "device_id"] as const) {
    const w = world();
    const q = w.build();
    delete q.device_keys![OWNER][DEVICE][field];
    const t = makeTrust([q], w.botMaster.pub);
    assert.equal(await t.trust.check(DEVICE, CURVE), `device ${DEVICE} unknown`);
  }
});

test("device not signed by the self-signing key is rejected", async () => {
  const t = anchored({ deviceSigned: false });
  assert.match((await t.trust.check(DEVICE, CURVE)) ?? "", /not verified by the owner/);
});

test("owner not verified by the bot is not pinned", async () => {
  const t = anchored({ verifiedByBot: false });
  assert.equal(await t.trust.check(DEVICE, CURVE), "owner is not verified by the bot");
  assert.equal(t.pins.length, 0);
});

test("pinned key is enough even without bot signature", async () => {
  const t = anchored({ verifiedByBot: false }, (w) => w.ownerMaster.pub);
  assert.equal(await t.trust.check(DEVICE, CURVE), null);
});

test("changed master key is rejected even if the bot signed it", async () => {
  const t = anchored({ master: keyPair() }, (w) => w.ownerMaster.pub);
  assert.match((await t.trust.check(DEVICE, CURVE)) ?? "", /master key changed/);
});

test("cached keys are reused for 60 s; a failing check refreshes once", async () => {
  const w = world();
  const good = w.build();
  const unsigned = w.build({ deviceSigned: false });
  const t = makeTrust([unsigned, good], w.botMaster.pub);
  assert.equal(await t.trust.check(DEVICE, CURVE), null); // first unsigned, refresh -> good
  assert.equal(t.calls.length, 2);
  t.tick(59_000);
  assert.equal(await t.trust.check(DEVICE, CURVE), null); // cached
  assert.equal(t.calls.length, 2);
  t.tick(2_000);
  assert.equal(await t.trust.check(DEVICE, CURVE), null); // expired -> new query
  assert.equal(t.calls.length, 3);
  t.trust.invalidate();
  assert.equal(await t.trust.check(DEVICE, CURVE), null); // invalidated -> new query
  assert.equal(t.calls.length, 4);
});

test("tampered self-signing key is rejected", async () => {
  const w = world();
  const q = w.build();
  q.self_signing_keys![OWNER] = crossKey(OWNER, "self_signing", keyPair());
  const t = makeTrust([q], w.botMaster.pub);
  assert.equal(await t.trust.check(DEVICE, CURVE), "owner self-signing key invalid");
});

test("owner self-signing key without usage is rejected", async () => {
  const w = world();
  const q = w.build();
  // Correctly signed by the owner master key, but without the usage field the spec requires.
  const { usage: _u, signatures: _s, ...noUsage } = q.self_signing_keys![OWNER];
  q.self_signing_keys![OWNER] = sign(noUsage as SignedKeys, OWNER, w.ownerMaster.pub, w.ownerMaster);
  const t = makeTrust([q], w.botMaster.pub);
  assert.equal(await t.trust.check(DEVICE, CURVE), "owner self-signing key invalid");
});

test("wrong usage on the bot user-signing key is rejected", async () => {
  const w = world();
  const q = w.build();
  q.user_signing_keys![BOT] = { ...q.user_signing_keys![BOT], usage: ["self_signing"] };
  const t = makeTrust([q], w.botMaster.pub);
  assert.equal(await t.trust.check(DEVICE, CURVE), "bot user-signing key invalid");
});

// --- device audit (who may receive room keys) ---

function deviceObj(user: string, id: string, kp: KP, ssk?: KP): SignedKeys {
  let dev: SignedKeys = { user_id: user, device_id: id, algorithms: ["m.megolm.v1.aes-sha2"], keys: { [`curve25519:${id}`]: `curve-${id}`, [`ed25519:${id}`]: kp.pub } };
  dev = sign(dev, user, id, kp);
  return ssk ? sign(dev, user, ssk.pub, ssk) : dev;
}

/** World with a bot self-signing key, the daemon's own device BOTDEV and optional extra devices. */
function auditWorld(opts: { evilOwner?: boolean; evilBot?: boolean; botSskSigned?: boolean; ownDeviceSigned?: boolean } = {}) {
  const w = world();
  const botSsk = keyPair();
  const q = w.build();
  q.self_signing_keys![BOT] = opts.botSskSigned === false ? crossKey(BOT, "self_signing", botSsk) : sign(crossKey(BOT, "self_signing", botSsk), BOT, w.botMaster.pub, w.botMaster);
  q.device_keys![BOT] = {
    BOTDEV: deviceObj(BOT, "BOTDEV", keyPair(), opts.ownDeviceSigned === false ? undefined : botSsk),
    PHONE: deviceObj(BOT, "PHONE", keyPair(), botSsk),
  };
  if (opts.evilOwner) q.device_keys![OWNER]!.EVILDEV = deviceObj(OWNER, "EVILDEV", keyPair());
  if (opts.evilBot) q.device_keys![BOT]!.EVILBOT = deviceObj(BOT, "EVILBOT", keyPair());
  return { w, q, botSsk };
}

function auditTrust(q: KeysQueryResponse | (() => KeysQueryResponse), anchor: string | undefined, pinned?: string) {
  const calls: unknown[] = [];
  const pins: string[] = [];
  const trust = new OwnerTrust({
    queryKeys: async (b) => (calls.push(b), typeof q === "function" ? q() : q),
    botUser: BOT,
    owner: OWNER,
    getPinnedMaster: () => pinned,
    pinMaster: (k) => void pins.push(k),
    getBotMasterKey: () => anchor,
    getOwnDeviceId: () => "BOTDEV",
    now: () => clock.v,
  });
  return { trust, calls, pins };
}
const clock = { v: 0 };

test("device audit: all devices cross-signed -> no problem, allowed set lists them", async () => {
  const { w, q } = auditWorld();
  const { trust, pins } = auditTrust(q, w.botMaster.pub);
  const a = await trust.auditDevices();
  assert.equal(a.problem, null);
  assert.deepEqual([...a.allowed.get(OWNER)!], [DEVICE]);
  assert.deepEqual([...a.allowed.get(BOT)!].sort(), ["BOTDEV", "PHONE"]);
  assert.deepEqual(pins, []); // the audit never pins
});

test("device audit: an injected owner or bot device is reported by id and not allowed", async () => {
  const owner = auditWorld({ evilOwner: true });
  const a = await auditTrust(owner.q, owner.w.botMaster.pub).trust.auditDevices();
  assert.match(a.problem!, /^unverified device\(s\): @owner:example.org EVILDEV; /);
  assert.equal(a.allowed.get(OWNER)!.has("EVILDEV"), false);
  assert.equal(a.allowed.get(OWNER)!.has(DEVICE), true);

  const bot = auditWorld({ evilBot: true });
  const b = await auditTrust(bot.q, bot.w.botMaster.pub).trust.auditDevices();
  assert.match(b.problem!, /@bot:example.org EVILBOT/);
  assert.equal(b.allowed.get(BOT)!.has("EVILBOT"), false);
});

test("device audit: the daemon's own device needs no signature; odd device ids are not repeated", async () => {
  const { w, q } = auditWorld({ ownDeviceSigned: false });
  assert.equal((await auditTrust(q, w.botMaster.pub).trust.auditDevices()).problem, null);
  q.device_keys![OWNER]!["<b>x</b>"] = deviceObj(OWNER, "<b>x</b>", keyPair());
  assert.match((await auditTrust(q, w.botMaster.pub).trust.auditDevices()).problem!, /@owner:example.org <invalid id>/);
});

test("device audit: a device signed by a self-signing key the homeserver made up is not allowed", async () => {
  const { w, q } = auditWorld();
  const fakeSsk = keyPair();
  q.device_keys![OWNER]!.FAKE = deviceObj(OWNER, "FAKE", keyPair(), fakeSsk);
  q.device_keys![BOT]!.FAKEBOT = deviceObj(BOT, "FAKEBOT", keyPair(), fakeSsk);
  const a = await auditTrust(q, w.botMaster.pub).trust.auditDevices();
  assert.match(a.problem!, /@owner:example.org FAKE, @bot:example.org FAKEBOT/);
});

test("device audit fails closed without anchor, with a bad bot self-signing key or an unverified owner", async () => {
  const { w, q } = auditWorld();
  assert.equal((await auditTrust(q, undefined).trust.auditDevices()).problem, NOT_ANCHORED);
  assert.equal((await auditTrust(q, keyPair().pub).trust.auditDevices()).problem, NOT_ANCHORED);
  const bad = auditWorld({ botSskSigned: false });
  assert.match((await auditTrust(bad.q, bad.w.botMaster.pub).trust.auditDevices()).problem!, /bot self-signing key invalid/);
  const unverified = auditWorld();
  unverified.q.master_keys![OWNER] = crossKey(OWNER, "master", unverified.w.ownerMaster); // no bot signature
  assert.equal((await auditTrust(unverified.q, unverified.w.botMaster.pub).trust.auditDevices()).problem, "owner is not verified by the bot");
  // pinned master instead of the bot signature is enough
  assert.equal((await auditTrust(unverified.q, unverified.w.botMaster.pub, unverified.w.ownerMaster.pub).trust.auditDevices()).problem, null);
  assert.match((await auditTrust(q, w.botMaster.pub, keyPair().pub).trust.auditDevices()).problem!, /owner master key changed/);
});

test("device audit re-queries stale keys once before reporting; invalidate drops the cache", async () => {
  const good = auditWorld();
  const evil = auditWorld({ evilOwner: true });
  // same identities: put the evil device into the good world
  const evilQ: KeysQueryResponse = JSON.parse(JSON.stringify(good.q));
  evilQ.device_keys![OWNER]!.EVILDEV = evil.q.device_keys![OWNER]!.EVILDEV;
  let current = evilQ;
  clock.v = 0;
  const { trust, calls } = auditTrust(() => current, good.w.botMaster.pub);
  assert.ok((await trust.auditDevices()).problem);
  assert.equal(calls.length, 1); // fresh keys: no second query
  current = good.q;
  clock.v = 6_000;
  assert.equal((await trust.auditDevices()).problem, null); // stale + problem: re-queried
  assert.equal(calls.length, 2);
  current = evilQ;
  assert.equal((await trust.auditDevices()).problem, null); // cached
  trust.invalidate();
  assert.ok((await trust.auditDevices()).problem);
  assert.equal(calls.length, 3);
  clock.v = 0;
});

test("cross-signing key whose key id does not match its value is ignored", async () => {
  const w = world();
  const q = w.build();
  const m = q.master_keys![BOT]!;
  q.master_keys![BOT] = { ...m, keys: { "ed25519:other": Object.values(m.keys)[0]! } };
  const t = makeTrust([q], w.botMaster.pub);
  assert.equal(await t.trust.check(DEVICE, CURVE), NOT_ANCHORED);
});
