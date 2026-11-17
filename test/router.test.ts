// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { Router, formatAgentList, parseLocation } from "../src/daemon/router.ts";
import type { PollOutcome, RouterDeps } from "../src/daemon/router.ts";
import type { EventHandler, MatrixEvent } from "../src/daemon/matrix.ts";
import type { AgentLink } from "../src/daemon/registry.ts";
import { agentKey } from "../src/daemon/registry.ts";
import { silentLogger } from "../src/daemon/log.ts";
import type { DaemonMessage, InboundMessage } from "../src/protocol/messages.ts";
import { MediaError } from "../src/daemon/media.ts";

const OWNER = "@owner:example.org";
const BOT = "@bot:example.org";
const CONTROL = "!control:example.org";
const SYSTEM = "!system:example.org";
const ROOM_A = "!builder:example.org";
const ROOM_B = "!writer:example.org";

type FakeLink = AgentLink & { sent: DaemonMessage[] };

function link(name: string, machine = "local", version?: string): FakeLink {
  const sent: DaemonMessage[] = [];
  return { key: agentKey(name), name, machine, version, since: Date.UTC(2026, 0, 2, 3, 4), sent, send: (m) => sent.push(m), close() {}, alive: () => true };
}

function setup(opts: { agents?: FakeLink[]; trust?: string | null | Error; poll?: PollOutcome; media?: Error; mediaDelayMs?: number; replayLogFails?: boolean } = {}) {
  const replay = new Set<string>();
  const mediaOpts: unknown[] = [];
  const agents = new Map((opts.agents ?? []).map((l) => [l.key, l]));
  const notices: Array<[string, string]> = [];
  const system: string[] = [];
  const receipts: Array<[string, string, string]> = [];
  const remembered: Array<[string, string, string]> = [];
  const ownerReactions: string[] = [];
  const reactionVerified: Array<boolean | undefined> = [];
  const updates: Array<[string, string, string | undefined]> = [];
  const typing: string[] = [];
  const trustCalls: Array<[unknown, unknown]> = [];
  const pollCalls: string[] = [];
  const fetched: string[] = [];
  let decrypted: EventHandler | undefined;
  let plain: EventHandler | undefined;
  const deps: RouterDeps = {
    config: { owner: OWNER, botUser: BOT },
    log: silentLogger,
    matrix: {
      onDecrypted: (cb) => ((decrypted = cb), () => (decrypted = undefined)),
      onPlainEvent: (cb) => ((plain = cb), () => (plain = undefined)),
      sendNotice: async (r, b) => (notices.push([r, b]), { eventId: "$n", held: false }),
      setTyping: (r) => void typing.push(r),
      isReplay: (k) => typeof k !== "string" || replay.has(k),
      recordReplay: (k) => {
        if (typeof k !== "string" || replay.has(k)) return false;
        if (opts.replayLogFails) throw new Error("EACCES");
        replay.add(k);
        return true;
      },
    },
    trust: {
      check: async (d, c) => {
        trustCalls.push([d, c]);
        if (opts.trust instanceof Error) throw opts.trust;
        return opts.trust ?? null;
      },
    },
    rooms: {
      controlRoomId: CONTROL,
      roomToAgent: (r) => (r === ROOM_A ? "builder" : r === ROOM_B ? "writer" : undefined),
      agentRoom: (k) => (k === "builder" ? ROOM_A : k === "writer" ? ROOM_B : undefined),
    },
    registry: { get: (k) => agents.get(k), list: () => [...agents.values()].sort((a, b) => a.key.localeCompare(b.key)) },
    media: {
      fetch: async (c, o) => {
        fetched.push(c.url);
        mediaOpts.push(o);
        if (opts.mediaDelayMs) await new Promise((r) => setTimeout(r, opts.mediaDelayMs));
        if (opts.media) throw opts.media;
        return { attachment: { name: "a.png", mime: "image/png", kind: "image", data: "AAAA", size: 3 }, caption: "cap" };
      },
    },
    polls: { ownerEvent: async (r) => (pollCalls.push(r), opts.poll ?? null) },
    reactions: {
      receipt: (r, e, emoji) => void receipts.push([r, e, emoji]),
      rememberDelivery: (k, r, e) => void remembered.push([k, r, e]),
      ownerReaction: async (r, _e, verified) => void (ownerReactions.push(r), reactionVerified.push(verified)),
    },
    updates: { command: (r, e, t) => void updates.push([r, e, t]) },
    notify: { system: (t) => void system.push(t) },
  };
  const router = new Router(deps);
  router.attach();
  return {
    router, agents, replay, mediaOpts, notices, system, receipts, remembered, ownerReactions, reactionVerified, updates, typing, trustCalls, pollCalls, fetched,
    decrypted: (room: string, ev: MatrixEvent) => decrypted!(room, ev),
    plain: (room: string, ev: MatrixEvent) => plain!(room, ev),
  };
}

let n = 0;
function ev(content: Record<string, any>, over: Partial<MatrixEvent> = {}): MatrixEvent {
  return { event_id: `$e${++n}`, sender: OWNER, type: "m.room.message", content, mxa_sender: { device: "DEV", curveKey: "CURVE" }, mxa_replay_key: `replay-key-${n}-aaaaaaa`, ...over };
}
const text = (body: string, extra: Record<string, any> = {}) => ev({ msgtype: "m.text", body, ...extra });
const msgs = (l: FakeLink) => l.sent as InboundMessage[];

test("agent room text is delivered with 👀, trust checked with sender device", async () => {
  const a = link("builder");
  const t = setup({ agents: [a] });
  const e = text("  hello  ");
  await t.decrypted(ROOM_A, e);
  assert.deepEqual(t.trustCalls, [["DEV", "CURVE"]]);
  assert.deepEqual(msgs(a), [{ type: "message", kind: "text", text: "hello", sender: OWNER, via: "room", event_id: e.event_id }]);
  assert.deepEqual(t.receipts, [[ROOM_A, e.event_id, "👀"]]);
  assert.deepEqual(t.remembered, [["builder", ROOM_A, e.event_id]]);
  assert.deepEqual(t.typing, [ROOM_A]);
});

test("agent offline: notice + 💤", async () => {
  const t = setup();
  const e = text("hi");
  await t.decrypted(ROOM_A, e);
  assert.deepEqual(t.receipts, [[ROOM_A, e.event_id, "💤"]]);
  assert.equal(t.notices.length, 1);
  assert.equal(t.notices[0][0], ROOM_A);
  assert.match(t.notices[0][1], /offline/);
});

test("events from others, bot or undecrypted-trust failures are never forwarded", async () => {
  const a = link("builder");
  const t = setup({ agents: [a] });
  await t.decrypted(ROOM_A, text("x", {}));
  await t.decrypted(ROOM_A, { ...text("intruder"), sender: "@eve:example.org" });
  await t.decrypted(ROOM_A, { ...text("self"), sender: BOT });
  assert.equal(msgs(a).length, 1);
  assert.equal(t.trustCalls.length, 1);
});

test("trust rejection: notice in agent room, system notice for control room", async () => {
  const a = link("builder");
  const t = setup({ agents: [a], trust: "device X is not verified by the owner" });
  await t.decrypted(ROOM_A, text("hi"));
  await t.decrypted(CONTROL, text("@builder hi"));
  assert.equal(msgs(a).length, 0);
  assert.deepEqual(t.notices, [[ROOM_A, "Not delivered: device X is not verified by the owner."]]);
  assert.equal(t.system.length, 1);
  assert.match(t.system[0], /not verified/);
  assert.equal(t.receipts.length, 0);
});

test("trust check error is a rejection", async () => {
  const a = link("builder");
  const t = setup({ agents: [a], trust: new Error("network") });
  await t.decrypted(ROOM_A, text("hi"));
  assert.equal(msgs(a).length, 0);
  assert.equal(t.notices.length, 1);
});

test("events in unrelated rooms are ignored without trust check", async () => {
  const a = link("builder");
  const t = setup({ agents: [a] });
  await t.decrypted(SYSTEM, text("@builder hi"));
  await t.decrypted("!other:example.org", text("hi"));
  assert.equal(t.trustCalls.length, 0);
  assert.equal(msgs(a).length, 0);
});

test("plain events: only owner reactions", async () => {
  const t = setup({ agents: [link("builder")] });
  await t.plain(ROOM_A, ev({ "m.relates_to": { rel_type: "m.annotation", event_id: "$x", key: "👍" } }, { type: "m.reaction", mxa_sender: undefined }));
  await t.plain(ROOM_A, ev({ "m.relates_to": {} }, { type: "m.reaction", sender: "@eve:example.org" }));
  await t.plain(ROOM_A, ev({ msgtype: "m.text", body: "plain" }, { mxa_sender: undefined }));
  assert.deepEqual(t.ownerReactions, [ROOM_A]);
  assert.deepEqual(t.reactionVerified, [undefined]); // plain path: reactions module default (unverified)
  assert.equal(t.agents.get("builder")!.sent.length, 0);
});

test("decrypted owner reaction that passed the trust check is forwarded as verified", async () => {
  const t = setup({ agents: [link("builder")] });
  const reaction = () => ev({ "m.relates_to": { rel_type: "m.annotation", event_id: "$x", key: "👍" } }, { type: "m.reaction" });
  await t.decrypted(ROOM_A, reaction());
  assert.deepEqual(t.ownerReactions, [ROOM_A]);
  assert.deepEqual(t.reactionVerified, [true]);

  const untrusted = setup({ agents: [link("builder")], trust: "unverified session" });
  await untrusted.decrypted(ROOM_A, reaction());
  assert.deepEqual(untrusted.ownerReactions, []);
  const forwarded = setup({ agents: [link("builder")] });
  await forwarded.decrypted(ROOM_A, ev({ "m.relates_to": { rel_type: "m.annotation", event_id: "$x", key: "👍" } }, { type: "m.reaction", mxa_sender: { device: "DEV", curveKey: "CURVE", forwarded: true } }));
  assert.deepEqual(forwarded.ownerReactions, []);
});

test("location", async () => {
  const a = link("builder");
  const t = setup({ agents: [a] });
  const e = ev({ msgtype: "m.location", body: "geo:52.52,13.405;u=12.4", geo_uri: "geo:52.52,13.405;u=12.4", "m.location": { uri: "geo:52.52,13.405;u=12.4", description: "Office" } });
  await t.decrypted(ROOM_A, e);
  const m = msgs(a)[0];
  assert.equal(m.kind, "location");
  assert.equal(m.lat, 52.52);
  assert.equal(m.lon, 13.405);
  assert.equal(m.accuracy_m, 12.4);
  assert.equal(m.description, "Office");
  assert.equal(m.text, "[location] 52.52, 13.405 (accuracy 12 m)\nOffice");
  assert.ok(!m.text.includes("geo:"));
  assert.deepEqual(t.receipts, [[ROOM_A, e.event_id, "👀"]]);

  const bad = ev({ msgtype: "m.location", body: "x", geo_uri: "geo:999,0" });
  await t.decrypted(ROOM_A, bad);
  assert.equal(msgs(a).length, 1);
  assert.match(t.notices[0][1], /invalid geo/);
  assert.deepEqual(t.receipts[1], [ROOM_A, bad.event_id, "💤"]);
});

test("parseLocation variants", () => {
  assert.deepEqual(parseLocation({ geo_uri: "geo:-33.9,18.4", body: "geo:-33.9,18.4" }), { lat: -33.9, lon: 18.4, text: "[location] -33.9, 18.4" });
  assert.equal(parseLocation({ geo_uri: "geo:1,2,30;crs=wgs84;u=5", body: "Home" })?.text, "[location] 1, 2 (accuracy 5 m)\nHome");
  assert.equal(parseLocation({ body: "nothing" }), null);
  assert.equal(parseLocation({ geo_uri: "geo:1,200" }), null);
  // absurd uncertainty is ignored, small values keep one decimal, surrounding spaces are fine
  const huge = parseLocation({ geo_uri: "geo:1,2;u=1" + "0".repeat(305) });
  assert.equal(huge?.accuracy_m, undefined);
  assert.equal(huge?.text, "[location] 1, 2");
  assert.equal(parseLocation({ geo_uri: " geo:1,2;u=2.46 " })?.text, "[location] 1, 2 (accuracy 2.5 m)");
  assert.equal(parseLocation({ geo_uri: "geo:1,2;u=0" })?.text, "[location] 1, 2 (accuracy 0 m)");
});

test("attachment via media.fetch", async () => {
  const a = link("builder");
  const t = setup({ agents: [a] });
  const e = ev({ msgtype: "m.image", body: "a.png", url: "mxc://example.org/abc" });
  await t.decrypted(ROOM_A, e);
  assert.deepEqual(t.fetched, ["mxc://example.org/abc"]);
  assert.deepEqual(t.mediaOpts, [{ encryptedOnly: true }]);
  const m = msgs(a)[0];
  assert.equal(m.kind, "attachment");
  assert.equal(m.text, "cap");
  assert.equal(m.attachment?.mime, "image/png");
  assert.deepEqual(t.receipts, [[ROOM_A, e.event_id, "👀"]]);
});

test("attachment: offline agent is not fetched; fetch error gives notice", async () => {
  const t1 = setup();
  const e = ev({ msgtype: "m.file", body: "f", url: "mxc://example.org/f" });
  await t1.decrypted(ROOM_A, e);
  assert.deepEqual(t1.fetched, []);
  assert.deepEqual(t1.receipts, [[ROOM_A, e.event_id, "💤"]]);
  assert.match(t1.notices[0][1], /offline/);

  const a = link("builder");
  const t2 = setup({ agents: [a], media: new MediaError("attachment too large") });
  const e2 = ev({ msgtype: "m.file", body: "f", url: "mxc://example.org/f" });
  await t2.decrypted(ROOM_A, e2);
  assert.equal(a.sent.length, 0);
  assert.deepEqual(t2.notices, [[ROOM_A, "Attachment not delivered: attachment too large"]]);
  assert.deepEqual(t2.receipts, [[ROOM_A, e2.event_id, "💤"]]);
});

test("attachment: non-MediaError text never reaches the room", async () => {
  const a = link("builder");
  const t = setup({ agents: [a], media: new Error("undici: socket /internal/path secret") });
  const e = ev({ msgtype: "m.file", body: "f", url: "mxc://example.org/f" });
  await t.decrypted(ROOM_A, e);
  assert.deepEqual(t.notices, [[ROOM_A, "Attachment not delivered: internal error"]]);
  assert.deepEqual(t.receipts, [[ROOM_A, e.event_id, "💤"]]);
});

test("edits of attachments and locations are not delivered again", async () => {
  const a = link("builder");
  const t = setup({ agents: [a] });
  const rel = { "m.relates_to": { rel_type: "m.replace", event_id: "$orig" } };
  await t.decrypted(ROOM_A, ev({ msgtype: "m.image", body: "* new caption", url: "mxc://example.org/x", "m.new_content": { msgtype: "m.image", body: "new caption", url: "mxc://example.org/x" }, ...rel }));
  await t.decrypted(ROOM_A, ev({ msgtype: "m.location", body: "* here", geo_uri: "geo:1,2", "m.new_content": { msgtype: "m.location", body: "here", geo_uri: "geo:1,2" }, ...rel }));
  assert.deepEqual(t.fetched, []);
  assert.equal(a.sent.length, 0);
  assert.equal(t.receipts.length, 0);
});

test("delivery order per room is kept although an attachment download is slow", async () => {
  const a = link("builder");
  const t = setup({ agents: [a], mediaDelayMs: 40 });
  const p1 = t.decrypted(ROOM_A, ev({ msgtype: "m.image", body: "a.png", url: "mxc://example.org/abc" }));
  const p2 = t.decrypted(ROOM_A, text("what is in this?"));
  await Promise.all([p1, p2]);
  assert.deepEqual(msgs(a).map((m) => m.kind), ["attachment", "text"]);
});

test("forwarded room keys and foreign sessions are rejected before the trust check", async () => {
  const a = link("builder");
  const t = setup({ agents: [a] });
  await t.decrypted(ROOM_A, { ...text("hi"), mxa_sender: { device: "DEV", curveKey: "CURVE", forwarded: true } });
  await t.decrypted(ROOM_A, { ...text("hi"), mxa_sender: { device: "DEV", curveKey: "CURVE", userId: "@eve:example.org" } });
  await t.decrypted(CONTROL, { ...text("@builder hi"), mxa_sender: { device: "DEV", curveKey: "CURVE", forwarded: true } });
  assert.equal(a.sent.length, 0);
  assert.equal(t.trustCalls.length, 0);
  assert.deepEqual(t.notices.map((x) => x[1]), ["Not delivered: key forwarded; message not trusted.", "Not delivered: session belongs to another user; message not trusted."]);
  assert.match(t.system[0], /key forwarded/);
  // matching user id is fine
  await t.decrypted(ROOM_A, { ...text("ok"), mxa_sender: { device: "DEV", curveKey: "CURVE", userId: OWNER, forwarded: false } });
  assert.equal(a.sent.length, 1);
});

test("verification requests and unknown msgtypes are ignored", async () => {
  const a = link("builder");
  const t = setup({ agents: [a] });
  await t.decrypted(ROOM_A, ev({ msgtype: "m.key.verification.request", body: "verify" }));
  assert.equal(a.sent.length, 0);
  assert.equal(t.receipts.length, 0);
});

test("reply fallback stripped in agent room, edits use new content", async () => {
  const a = link("builder");
  const t = setup({ agents: [a] });
  await t.decrypted(ROOM_A, text("> <@bot:example.org> question\n\nanswer", { "m.relates_to": { "m.in_reply_to": { event_id: "$q" } } }));
  await t.decrypted(ROOM_A, text("* fixed", { "m.new_content": { msgtype: "m.text", body: "fixed" }, "m.relates_to": { rel_type: "m.replace", event_id: "$o" } }));
  assert.deepEqual(msgs(a).map((m) => m.text), ["answer", "[edited] fixed"]);
});

test("control: @agent", async () => {
  const a = link("Builder");
  const b = link("writer");
  const t = setup({ agents: [a, b] });
  const e = text("@builder run tests");
  await t.decrypted(CONTROL, e);
  assert.deepEqual(msgs(a), [{ type: "message", kind: "text", text: "run tests", sender: OWNER, via: "control", event_id: e.event_id }]);
  assert.equal(b.sent.length, 0);
  assert.deepEqual(t.receipts, [[CONTROL, e.event_id, "👀"]]);
  assert.deepEqual(t.remembered, [["builder", CONTROL, e.event_id]]);
  assert.equal(t.typing.length, 0);
});

test("control: @agent not connected -> system + 💤", async () => {
  const t = setup({ agents: [link("writer")] });
  const e = text("@builder run");
  await t.decrypted(CONTROL, e);
  assert.deepEqual(t.receipts, [[CONTROL, e.event_id, "💤"]]);
  assert.match(t.system[0], /not connected: builder/);
});

test("control: unknown target is not repeated in the notice", async () => {
  const t = setup({ agents: [link("writer")] });
  const e = text("@password123 secret stuff");
  await t.decrypted(CONTROL, e);
  assert.deepEqual(t.receipts, [[CONTROL, e.event_id, "💤"]]);
  assert.deepEqual(t.system, ["Control-room message not delivered: unknown agent."]);
});

test("control: @name: and @name, address forms", async () => {
  const a = link("builder");
  const t = setup({ agents: [a] });
  await t.decrypted(CONTROL, text("@builder: fix it"));
  await t.decrypted(CONTROL, text("@Builder, and this"));
  assert.deepEqual(msgs(a).map((m) => m.text), ["fix it", "and this"]);
});

test("control: explicit @name wins over m.mentions.room", async () => {
  const a = link("builder");
  const b = link("writer");
  const t = setup({ agents: [a, b] });
  await t.decrypted(CONTROL, text("@builder private, see @room", { "m.mentions": { room: true } }));
  assert.deepEqual(msgs(a).map((m) => m.text), ["private, see @room"]);
  assert.equal(b.sent.length, 0);
});

test("control: edits are never broadcast by a room mention; edited @name gets [edited]", async () => {
  const a = link("builder");
  const b = link("writer");
  const t = setup({ agents: [a, b] });
  const edit = (body: string) => text(`* ${body}`, { "m.new_content": { msgtype: "m.text", body }, "m.relates_to": { rel_type: "m.replace", event_id: "$o" }, "m.mentions": { room: true } });
  await t.decrypted(CONTROL, edit("hello everyone"));
  assert.equal(a.sent.length + b.sent.length, 0);
  assert.equal(t.system.length, 0);
  await t.decrypted(CONTROL, edit("@builder fixed typo"));
  assert.deepEqual(msgs(a).map((m) => m.text), ["[edited] fixed typo"]);
  assert.equal(b.sent.length, 0);
});

test("control: broadcast via @all and m.mentions.room, single receipt", async () => {
  const a = link("builder");
  const b = link("writer");
  const t = setup({ agents: [a, b] });
  const e1 = text("@all hi");
  await t.decrypted(CONTROL, e1);
  const e2 = text("@room status?", { "m.mentions": { room: true } });
  await t.decrypted(CONTROL, e2);
  assert.deepEqual(msgs(a).map((m) => m.text), ["hi", "status?"]);
  assert.deepEqual(msgs(b).map((m) => m.text), ["hi", "status?"]);
  assert.deepEqual(t.receipts, [[CONTROL, e1.event_id, "👀"], [CONTROL, e2.event_id, "👀"]]);
  assert.equal(t.remembered.length, 4);
});

test("control: broadcast with nobody connected", async () => {
  const t = setup();
  const e = text("@all hi");
  await t.decrypted(CONTROL, e);
  assert.deepEqual(t.receipts, [[CONTROL, e.event_id, "💤"]]);
  assert.match(t.system[0], /no agents connected/);
});

test("control: @list", async () => {
  const t = setup({ agents: [link("writer", "laptop", "1.2.0"), link("builder")] });
  await t.decrypted(CONTROL, text("@list"));
  assert.deepEqual(t.notices, [[CONTROL, "builder · local · - · 2026-01-02 03:04 UTC\nwriter · laptop · 1.2.0 · 2026-01-02 03:04 UTC"]]);
  assert.equal(formatAgentList([]), "No agents connected.");
});

test("control: @update", async () => {
  const t = setup({ agents: [link("builder")] });
  const e1 = text("@update");
  const e2 = text("@update Builder");
  await t.decrypted(CONTROL, e1);
  await t.decrypted(CONTROL, e2);
  assert.deepEqual(t.updates, [[CONTROL, e1.event_id, undefined], [CONTROL, e2.event_id, "builder"]]);
});

test("control: unknown command -> system hint", async () => {
  const a = link("builder");
  const t = setup({ agents: [a] });
  await t.decrypted(CONTROL, text("hello there"));
  assert.equal(a.sent.length, 0);
  assert.equal(t.system.length, 1);
  assert.match(t.system[0], /@<agent>/);
});

test("control: attachments are not delivered", async () => {
  const a = link("builder");
  const t = setup({ agents: [a] });
  await t.decrypted(CONTROL, ev({ msgtype: "m.image", body: "x", url: "mxc://example.org/x" }));
  assert.deepEqual(t.fetched, []);
  assert.equal(a.sent.length, 0);
  assert.equal(t.system.length, 1);
});

test("control: reply to a remembered status message", async () => {
  const a = link("builder");
  const t = setup({ agents: [a] });
  t.router.rememberControlMessage("$status", "Builder");
  const e = text("> <@bot:example.org> [builder] need input\n\nyes, go", { "m.relates_to": { "m.in_reply_to": { event_id: "$status" } } });
  await t.decrypted(CONTROL, e);
  assert.deepEqual(msgs(a).map((m) => [m.text, m.via]), [["yes, go", "control"]]);
  assert.deepEqual(t.receipts, [[CONTROL, e.event_id, "👀"]]);
});

test("control: replies route only to messages the daemon remembered (no lookup)", async () => {
  const a = link("builder");
  const t = setup({ agents: [a] });
  // unknown target event (e.g. a relation the homeserver changed): treated as a normal control-room message
  await t.decrypted(CONTROL, text("thanks", { "m.relates_to": { "m.in_reply_to": { event_id: "$unknown" } } }));
  assert.equal(a.sent.length, 0);
  assert.deepEqual(t.system, ["Message in the control room ignored: start it with @<agent>, @all, @list or @update."]);
});

test("control: explicit @command wins over the reply relation", async () => {
  const a = link("builder");
  const b = link("writer");
  const t = setup({ agents: [a, b] });
  t.router.rememberControlMessage("$status", "writer");
  await t.decrypted(CONTROL, text("@builder only you", { "m.relates_to": { "m.in_reply_to": { event_id: "$status" } } }));
  assert.deepEqual(msgs(a).map((m) => m.text), ["only you"]);
  assert.equal(b.sent.length, 0);
});

test("control: own > quote in a reply is kept", async () => {
  const a = link("builder");
  const t = setup({ agents: [a] });
  t.router.rememberControlMessage("$status", "builder");
  await t.decrypted(CONTROL, text("> my quote\n\nmy answer", { "m.relates_to": { "m.in_reply_to": { event_id: "$status" } } }));
  assert.deepEqual(msgs(a).map((m) => m.text), ["> my quote\n\nmy answer"]);
});

test("control: reply to an offline agent", async () => {
  const t = setup();
  t.router.rememberControlMessage("$old", "writer");
  const e = text("go", { "m.relates_to": { "m.in_reply_to": { event_id: "$old" } } });
  await t.decrypted(CONTROL, e);
  assert.deepEqual(t.receipts, [[CONTROL, e.event_id, "💤"]]);
  assert.match(t.system[0], /not connected: writer/);
});

test("polls: delivered to agent room", async () => {
  const a = link("builder");
  const message: InboundMessage = { type: "message", kind: "poll_started", text: "Q?\n1. a\n2. b", sender: OWNER, via: "room", question: "Q?", options: ["a", "b"] };
  const t = setup({ agents: [a], poll: { deliverTo: ["builder"], via: "room", message } });
  const e = ev({}, { type: "org.matrix.msc3381.poll.start" });
  await t.decrypted(ROOM_A, e);
  assert.deepEqual(t.pollCalls, [ROOM_A]);
  assert.deepEqual(a.sent, [message]);
  assert.deepEqual(t.receipts, [[ROOM_A, e.event_id, "👀"]]);
});

test("polls: offline agent, handled, control fan-out, untrusted", async () => {
  const message: InboundMessage = { type: "message", kind: "poll_started", text: "Q?", sender: OWNER, via: "control" };
  const t1 = setup({ poll: { deliverTo: ["builder"], via: "room", message } });
  const e1 = ev({}, { type: "m.poll.start" });
  await t1.decrypted(ROOM_A, e1);
  assert.deepEqual(t1.receipts, [[ROOM_A, e1.event_id, "💤"]]);
  assert.match(t1.notices[0][1], /offline/);

  const t2 = setup({ agents: [link("builder")], poll: { handled: true } });
  await t2.decrypted(ROOM_A, ev({}, { type: "m.poll.response" }));
  assert.equal(t2.receipts.length, 0);
  assert.equal(t2.agents.get("builder")!.sent.length, 0);

  const a = link("builder");
  const b = link("writer");
  const t3 = setup({ agents: [a, b], poll: { deliverTo: ["builder", "writer"], via: "control", message } });
  const e3 = ev({}, { type: "m.poll.start" });
  await t3.decrypted(CONTROL, e3);
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 1);
  assert.deepEqual(t3.receipts, [[CONTROL, e3.event_id, "👀"]]);

  const t4 = setup({ agents: [link("builder")], trust: "unknown sender device", poll: { deliverTo: ["builder"], via: "room", message } });
  await t4.decrypted(ROOM_A, ev({}, { type: "m.poll.start" }));
  assert.deepEqual(t4.pollCalls, []);
});

test("deliver() public API", () => {
  const a = link("builder");
  const t = setup({ agents: [a] });
  const msg: InboundMessage = { type: "message", kind: "text", text: "x", sender: OWNER, via: "room" };
  assert.equal(t.router.deliver("Builder", msg, { roomId: ROOM_A, eventId: "$1" }), true);
  assert.equal(t.router.deliver("writer", msg, { roomId: ROOM_B, eventId: "$2" }), false);
  assert.deepEqual(t.receipts, [[ROOM_A, "$1", "👀"], [ROOM_B, "$2", "💤"]]);
  assert.deepEqual(t.remembered, [["builder", ROOM_A, "$1"]]);
});

test("a throwing link counts as not delivered", async () => {
  const a = link("builder");
  a.send = () => {
    throw new Error("closed");
  };
  const t = setup({ agents: [a] });
  const e = text("hi");
  await t.decrypted(ROOM_A, e);
  assert.deepEqual(t.receipts, [[ROOM_A, e.event_id, "💤"]]);
});

test("replay keys are recorded only after the owner check; replays and keyless events are dropped", async () => {
  const a = link("builder");
  const t = setup({ agents: [a] });
  // other senders and untrusted owner devices never take replay slots
  await t.decrypted(ROOM_A, ev({ msgtype: "m.text", body: "x" }, { sender: "@eve:example.org" }));
  assert.equal(t.replay.size, 0);
  const untrusted = setup({ agents: [link("builder")], trust: "device EVIL unknown" });
  await untrusted.decrypted(ROOM_A, text("x"));
  assert.equal(untrusted.replay.size, 0);

  const e = text("once");
  await t.decrypted(ROOM_A, e);
  assert.equal(t.replay.size, 1);
  await t.decrypted(ROOM_A, { ...e, event_id: "$copy" });
  await t.decrypted(ROOM_A, ev({ msgtype: "m.text", body: "nokey" }, { mxa_replay_key: undefined }));
  assert.equal(msgs(a).length, 1);
  assert.equal(t.trustCalls.length, 1); // the replay was not even checked again
});

test("queued duplicates of one event are delivered once", async () => {
  const a = link("builder");
  const t = setup({ agents: [a] });
  const e = text("dup");
  await Promise.all([t.decrypted(ROOM_A, e), t.decrypted(ROOM_A, { ...e, event_id: "$dup2" })]);
  assert.equal(msgs(a).length, 1);
});

test("an unwritable replay log blocks delivery with a notice", async () => {
  const a = link("builder");
  const t = setup({ agents: [a], replayLogFails: true });
  await t.decrypted(ROOM_A, text("hi"));
  assert.equal(msgs(a).length, 0);
  assert.deepEqual(t.notices, [[ROOM_A, "Not delivered: replay log cannot be written."]]);
});
