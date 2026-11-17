// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
// Full daemon graph with a fake Matrix layer; agents connect through the real transports and the JS SDK.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configFromVars } from "../src/daemon/config.ts";
import { silentLogger } from "../src/daemon/log.ts";
import { MachineStore, machinesFile } from "../src/daemon/machines.ts";
import type { EventHandler, HeldDroppedHandler, MatrixEvent, RefusedHandler, SendResult, SentHandler } from "../src/daemon/matrix.ts";
import { handleConnection, MAX_QUEUED_BYTES } from "../src/daemon/agent-link.ts";
import type { Connection } from "../src/daemon/transport/link.ts";
import { StateStore } from "../src/daemon/state.ts";
import { createDaemon, type Daemon, type DaemonMatrix } from "../src/daemon/index.ts";
import type { InboundMessage } from "../src/protocol/messages.ts";
import { Attachment as CryptoAttachment } from "@matrix-org/matrix-sdk-crypto-nodejs";

type Sdk = typeof import("../clients/js/index.js");
type Agent = InstanceType<Sdk["Agent"]>;
const sdk: Sdk = await import(new URL("../clients/js/index.mjs", import.meta.url).href);

const OWNER = "@alice:example.org";
const BOT = "@agents:example.org";
const SPACE = "!space:example.org";
const TRUSTED = { device: "OWNERDEV", curveKey: "curve-owner" };
const UNTRUSTED = { device: "EVILDEV", curveKey: "curve-evil" };

interface Sent {
  roomId: string;
  type: string;
  content: Record<string, any>;
  eventId: string;
}

/** Fake Matrix: rooms exist once created, the owner has joined every room, events are recorded. */
class FakeMatrix {
  readonly botUser = BOT;
  readonly owner = OWNER;
  readonly sent: Sent[] = [];
  readonly raw: Sent[] = [];
  readonly created: { roomId: string; name: string }[] = [];
  readonly state: { roomId: string; type: string; key: string; content: any }[] = [];
  private readonly decrypted = new Set<EventHandler>();
  private readonly plain = new Set<EventHandler>();
  private readonly sentHandlers = new Set<SentHandler>();
  readonly refusedHandlers = new Set<RefusedHandler>();
  readonly droppedHandlers = new Set<HeldDroppedHandler>();
  /** While set, createRoom waits for it (lets tests observe a hello whose room is not ready yet). */
  createGate: Promise<void> | undefined;
  createStarted = 0;
  /** While set, start() waits for it. */
  startGate: Promise<void> | undefined;
  private readonly joined = new Set<string>([SPACE]);
  private seq = 0;
  private waiters: { pred: (s: Sent) => boolean; resolve: (s: Sent) => void }[] = [];
  running = false;

  readonly client = {
    createRoom: async (opts: any) => {
      this.createStarted++;
      if (this.createGate) await this.createGate;
      const roomId = `!r${++this.seq}:example.org`;
      this.joined.add(roomId);
      this.created.push({ roomId, name: opts?.name });
      return roomId;
    },
    sendStateEvent: async (roomId: string, type: string, key: string, content: any) => {
      this.state.push({ roomId, type, key, content });
      return `$state${++this.seq}`;
    },
    getJoinedRooms: async () => [...this.joined],
    joinRoom: async (roomId: string) => {
      this.joined.add(roomId);
      return roomId;
    },
    leaveRoom: async (roomId: string) => {
      this.joined.delete(roomId);
    },
    getRoomStateEvent: async () => ({ membership: "join" }),
  } as unknown as DaemonMatrix["client"];

  onDecrypted(cb: EventHandler) {
    this.decrypted.add(cb);
    return () => this.decrypted.delete(cb);
  }
  onPlainEvent(cb: EventHandler) {
    this.plain.add(cb);
    return () => this.plain.delete(cb);
  }
  onSent(cb: SentHandler) {
    this.sentHandlers.add(cb);
    return () => this.sentHandlers.delete(cb);
  }
  readonly replay = new Set<string>();
  isReplay(key: unknown) {
    return typeof key !== "string" || this.replay.has(key);
  }
  recordReplay(key: unknown) {
    if (typeof key !== "string" || this.replay.has(key)) return false;
    this.replay.add(key);
    return true;
  }
  onSendRefused(cb: RefusedHandler) {
    this.refusedHandlers.add(cb);
    return () => this.refusedHandlers.delete(cb);
  }
  onHeldDropped(cb: HeldDroppedHandler) {
    this.droppedHandlers.add(cb);
    return () => this.droppedHandlers.delete(cb);
  }

  private record(list: Sent[], roomId: string, type: string, content: Record<string, any>): string {
    const eventId = `$e${++this.seq}`;
    const s = { roomId, type, content, eventId };
    list.push(s);
    this.waiters = this.waiters.filter((w) => !(w.pred(s) && (w.resolve(s), true)));
    return eventId;
  }

  async sendMessage(roomId: string, content: Record<string, any>): Promise<SendResult> {
    const eventId = this.record(this.sent, roomId, "m.room.message", content);
    for (const h of this.sentHandlers) h(roomId, eventId, content);
    return { eventId, held: false };
  }
  sendText(roomId: string, body: string) {
    return this.sendMessage(roomId, { msgtype: "m.text", body });
  }
  sendNotice(roomId: string, body: string) {
    return this.sendMessage(roomId, { msgtype: "m.notice", body });
  }
  async sendEvent(roomId: string, type: string, content: Record<string, any>): Promise<string> {
    const eventId = this.record(this.sent, roomId, type, content);
    for (const h of this.sentHandlers) h(roomId, eventId, content);
    return eventId;
  }
  async sendRaw(roomId: string, type: string, content: Record<string, any>): Promise<string> {
    return this.record(this.raw, roomId, type, content);
  }
  setTyping() {}
  async getEvent(roomId: string, eventId: string): Promise<MatrixEvent> {
    const s = this.sent.find((x) => x.eventId === eventId && x.roomId === roomId);
    if (!s) throw new Error("M_NOT_FOUND");
    return { event_id: eventId, sender: BOT, type: s.type, room_id: roomId, content: s.content };
  }
  async keysQuery(): Promise<never> {
    throw new Error("not used: trust is faked");
  }
  healthy() {
    return this.running;
  }
  async start() {
    if (this.startGate) await this.startGate;
    this.running = true;
  }
  stop() {
    this.running = false;
  }

  /** Waits for a recorded message/event (or reaction with `raw`) matching pred, including earlier ones. */
  waitSent(pred: (s: Sent) => boolean, raw = false): Promise<Sent> {
    const hit = (raw ? this.raw : this.sent).find(pred);
    if (hit) return Promise.resolve(hit);
    return withTimeout(new Promise<Sent>((resolve) => this.waiters.push({ pred: (s) => (raw ? this.raw : this.sent).includes(s) && pred(s), resolve })));
  }

  reaction(eventId: string, key: string): Promise<Sent> {
    return this.waitSent((s) => s.content["m.relates_to"]?.event_id === eventId && s.content["m.relates_to"]?.key === key, true);
  }

  notice(roomId: string | undefined, match: RegExp): Promise<Sent> {
    return this.waitSent((s) => s.roomId === roomId && s.content.msgtype === "m.notice" && match.test(String(s.content.body)));
  }

  /** Injects an event the owner sent from a trusted (or given) device; resolves after all handlers ran. */
  async ownerEvent(roomId: string, type: string, content: Record<string, any>, sender = TRUSTED): Promise<string> {
    const event_id = `$owner${++this.seq}`;
    const ev: MatrixEvent = { event_id, sender: OWNER, type, room_id: roomId, origin_server_ts: Date.now(), content, mxa_sender: { ...sender }, mxa_replay_key: `replay-${this.seq}-aaaaaaaaaaaa` };
    for (const h of this.decrypted) await h(roomId, ev);
    return event_id;
  }

  async ownerText(roomId: string, body: string, extra: Record<string, any> = {}, sender = TRUSTED): Promise<string> {
    return this.ownerEvent(roomId, "m.room.message", { msgtype: "m.text", body, ...extra }, sender);
  }

  async plainEvent(roomId: string, type: string, content: Record<string, any>): Promise<string> {
    const event_id = `$plain${++this.seq}`;
    const ev: MatrixEvent = { event_id, sender: OWNER, type, room_id: roomId, origin_server_ts: Date.now(), content };
    for (const h of this.plain) await h(roomId, ev);
    return event_id;
  }
}

function withTimeout<T>(p: Promise<T>, ms = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Collects messages of an agent; next() waits for one matching pred. */
function inbox(agent: Agent) {
  const got: InboundMessage[] = [];
  let waiters: { pred: (m: InboundMessage) => boolean; resolve: (m: InboundMessage) => void }[] = [];
  agent.on("message", (m) => {
    got.push(m);
    waiters = waiters.filter((w) => !(w.pred(m) && (w.resolve(m), true)));
  });
  return {
    got,
    next(pred: (m: InboundMessage) => boolean = () => true): Promise<InboundMessage> {
      const hit = got.find(pred);
      if (hit) {
        got.splice(got.indexOf(hit), 1);
        return Promise.resolve(hit);
      }
      return withTimeout(
        new Promise<InboundMessage>((resolve) =>
          waiters.push({
            pred,
            resolve: (m) => {
              got.splice(got.indexOf(m), 1);
              resolve(m);
            },
          }),
        ),
      );
    },
  };
}

// ---------- setup ----------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mxagent-integration-"));
for (const k of ["MXA_SOCKET_PATH", "MXA_URL", "MXA_MACHINE", "MXA_SECRET"]) delete process.env[k];
const env = { MXA_STATE_DIR: path.join(dir, "state"), MXA_CONFIG: path.join(dir, "bridge.env"), XDG_RUNTIME_DIR: dir };
const config = configFromVars(
  {
    MXA_HOMESERVER: "https://matrix.example.org",
    MXA_BOT_USER: BOT,
    MXA_OWNER: OWNER,
    MXA_SPACE_ID: SPACE,
    MXA_SOCKET_PATH: path.join(dir, "bridge.sock"),
    MXA_WS_LISTEN: "127.0.0.1:8640",
  },
  env,
);
config.wsListen = { host: "127.0.0.1", port: 0 }; // free port; the env syntax does not allow 0
const state = StateStore.load(path.join(dir, "state", "state.json"));
const machines = new MachineStore(machinesFile({ configDir: dir }));
const laptopSecret = machines.addMachine("laptop");
const fake = new FakeMatrix();
const fetched: string[] = [];
const pngEnc = CryptoAttachment.encrypt(Buffer.from("PNGDATA"));
const pngCipher = Buffer.from(pngEnc.encryptedData);
const fakeFetch = (async (url: string | URL) => {
  fetched.push(String(url));
  return new Response(pngCipher, { status: 200, headers: { "content-length": String(pngCipher.length) } });
}) as typeof fetch;

const daemon: Daemon = createDaemon({
  config,
  state,
  log: silentLogger,
  matrix: fake,
  machines,
  trust: { check: async (device, curveKey) => (device === TRUSTED.device && curveKey === TRUSTED.curveKey ? null : `device ${device} is not verified by the owner`) },
  fetch: fakeFetch,
  version: "9.9.9",
  updateStaggerMs: 10,
});
await daemon.start();

const agents: Agent[] = [];
function local(name: string, opts: { instance?: string; version?: string } = {}): Agent {
  const a = sdk.connect({ name, socketPath: config.socketPath, reconnect: false, configFile: path.join(dir, "none.env"), client: "test-agent/1.0", ...opts });
  a.on("error", () => {});
  agents.push(a);
  return a;
}
function remote(name: string, secret = laptopSecret): Agent {
  const a = sdk.connect({
    name,
    url: `ws://127.0.0.1:${daemon.wsPort}/`,
    machine: "laptop",
    secret,
    reconnect: false,
    configFile: path.join(dir, "none.env"),
    version: "1.0.0",
  });
  a.on("error", () => {});
  agents.push(a);
  return a;
}

after(async () => {
  for (const a of agents) a.close();
  await daemon.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Raw NDJSON client on the Unix socket. */
async function rawLocal(socketPath = config.socketPath) {
  const net = await import("node:net");
  const sock = net.connect(socketPath);
  sock.setEncoding("utf8");
  let buf = "";
  const lines: any[] = [];
  let closed = false;
  sock.on("data", (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  sock.on("error", () => {});
  sock.on("close", () => (closed = true));
  await new Promise<void>((r) => sock.once("connect", () => r()));
  const until = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error("condition not met in time");
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { sock, lines, until, closed: () => closed, send: (o: unknown) => sock.write(JSON.stringify(o) + "\n") };
}

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

const control = () => daemon.rooms.controlRoomId!;
const system = () => daemon.rooms.systemRoomId!;

// ---------- tests ----------

test("startup: system and control rooms, started notice", async () => {
  assert.ok(system());
  assert.ok(control());
  await fake.notice(system(), /^daemon 9\.9\.9 started$/);
});

const alpha = local("Alpha", { version: "2.0" });
const alphaInbox = inbox(alpha);
let alphaRoom = "";

test("hello creates the room and answers welcome", async () => {
  const { roomId } = await withTimeout(alpha.ready());
  alphaRoom = roomId;
  assert.equal(daemon.rooms.agentRoom("alpha"), roomId);
  assert.ok(fake.created.some((r) => r.roomId === roomId && r.name === "Alpha"));
  assert.ok(fake.state.some((s) => s.roomId === roomId && s.type === "m.room.member" && s.content.displayname === "Alpha"));
  await fake.notice(system(), /^Alpha online · test-agent\/1\.0 2\.0 · local$/);
});

test("owner text reaches the agent and gets 👀", async () => {
  const id = await fake.ownerText(alphaRoom, "hello agent");
  const m = await alphaInbox.next((x) => x.event_id === id);
  assert.equal(m.kind, "text");
  assert.equal(m.text, "hello agent");
  assert.equal(m.via, "room");
  assert.equal(m.sender, OWNER);
  await fake.reaction(id, "👀");
});

test("reply goes to the agent room", async () => {
  const r = await alpha.reply("done");
  assert.equal(r.held, false);
  await fake.waitSent((s) => s.roomId === alphaRoom && s.content.msgtype === "m.text" && s.content.body === "done");
});

test("status goes to the control room with the name prefix", async () => {
  await alpha.status("[Alpha] build finished");
  await fake.notice(control(), /^\[Alpha\] build finished$/);
});

test("ask mentions the owner; a reply to it is routed back", async () => {
  await alpha.ask("deploy now?");
  const q = await fake.waitSent((s) => s.roomId === control() && s.content.msgtype === "m.text" && /deploy now\?/.test(s.content.body));
  assert.deepEqual(q.content["m.mentions"], { user_ids: [OWNER] });
  assert.equal(q.content.format, "org.matrix.custom.html");
  assert.match(q.content.formatted_body, /<a href="https:\/\/matrix\.to\/#\/%40alice%3Aexample\.org">/);
  assert.match(q.content.body, /^\[Alpha\] /);
  const id = await fake.ownerText(control(), "> <@agents:example.org> [Alpha] deploy now?\n\nyes", { "m.relates_to": { "m.in_reply_to": { event_id: q.eventId } } });
  const m = await alphaInbox.next((x) => x.event_id === id);
  assert.equal(m.text, "yes");
  assert.equal(m.via, "control");
  await fake.reaction(id, "👀");
});

test("untrusted device is rejected", async () => {
  const id = await fake.ownerText(alphaRoom, "from a stranger device", {}, UNTRUSTED);
  await fake.notice(alphaRoom, /^Not delivered: device EVILDEV is not verified by the owner\.$/);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(alphaInbox.got.some((m) => m.event_id === id), false);
});

test("attachment is downloaded with the fake fetch and forwarded", async () => {
  const id = await fake.ownerEvent(alphaRoom, "m.room.message", {
    msgtype: "m.image",
    body: "photo.png",
    file: { ...JSON.parse(pngEnc.mediaEncryptionInfo!), url: "mxc://example.org/abc123" },
    info: { mimetype: "image/png", size: 7 },
  });
  const m = await alphaInbox.next((x) => x.event_id === id);
  assert.equal(m.kind, "attachment");
  assert.equal(m.attachment?.name, "photo.png");
  assert.equal(m.attachment?.mime, "image/png");
  assert.equal(Buffer.from(m.attachment!.data, "base64").toString(), "PNGDATA");
  assert.ok(fetched.some((u) => u === "https://matrix.example.org/_matrix/client/v1/media/download/example.org/abc123"));
});

test("an unencrypted attachment url in an encrypted room is refused", async () => {
  const before = fetched.length;
  await fake.ownerEvent(alphaRoom, "m.room.message", { msgtype: "m.image", body: "photo.png", url: "mxc://example.org/plain1" });
  await fake.notice(alphaRoom, /^Attachment not delivered: unencrypted attachment refused$/);
  assert.equal(fetched.length, before);
});

test("a replayed owner event is delivered only once", async () => {
  const ev: MatrixEvent = { event_id: "$replayed", sender: OWNER, type: "m.room.message", room_id: alphaRoom, origin_server_ts: Date.now(), content: { msgtype: "m.text", body: "only once" }, mxa_sender: { ...TRUSTED }, mxa_replay_key: "replay-fixed-aaaaaaaaaaaa" };
  for (const h of (fake as any).decrypted) await h(alphaRoom, { ...ev });
  for (const h of (fake as any).decrypted) await h(alphaRoom, { ...ev, event_id: "$replayed2" });
  const m = await alphaInbox.next((x) => x.text === "only once");
  assert.equal(m.event_id, "$replayed");
  assert.equal(fake.replay.has("replay-fixed-aaaaaaaaaaaa"), true);
});

test("owner reaction on an agent message is forwarded", async () => {
  await alpha.reply("result is 42");
  const msg = await fake.waitSent((s) => s.roomId === alphaRoom && s.content.body === "result is 42");
  await fake.plainEvent(alphaRoom, "m.reaction", { "m.relates_to": { rel_type: "m.annotation", event_id: msg.eventId, key: "👍" } });
  const m = await alphaInbox.next((x) => x.kind === "reaction");
  assert.equal(m.emoji, "👍");
  assert.equal(m.target_text, "result is 42");
  assert.equal(m.verified, false);
  assert.match(m.text, /\(unverified\)/);
});

test("encrypted owner reaction from a trusted device is forwarded as verified", async () => {
  await alpha.reply("result is 43");
  const msg = await fake.waitSent((s) => s.roomId === alphaRoom && s.content.body === "result is 43");
  const id = await fake.ownerEvent(alphaRoom, "m.reaction", { "m.relates_to": { rel_type: "m.annotation", event_id: msg.eventId, key: "🎉" } });
  const m = await alphaInbox.next((x) => x.event_id === id);
  assert.equal(m.kind, "reaction");
  assert.equal(m.verified, true);
  assert.doesNotMatch(m.text, /unverified/);
});

test("a changed control-room vote moves the agent out of the old option's summary", async () => {
  await fake.ownerEvent(control(), "org.matrix.msc3381.poll.start", {
    "org.matrix.msc3381.poll.start": {
      kind: "org.matrix.msc3381.poll.disclosed",
      max_selections: 1,
      question: { "org.matrix.msc1767.text": "Lunch?" },
      answers: [{ id: "x", "org.matrix.msc1767.text": "pizza" }, { id: "y", "org.matrix.msc1767.text": "salad" }],
    },
  });
  await alphaInbox.next((x) => x.kind === "poll_started" && x.question === "Lunch?");
  await alpha.vote(1);
  await fake.notice(control(), /^🗳 pizza: Alpha$/);
  await alpha.vote(2);
  await fake.notice(control(), /^🗳 salad: Alpha$/);
  await fake.waitSent((s) => s.roomId === control() && s.content["m.new_content"]?.body === "🗳 pizza: (none)");
});

test("agent poll and the owner's answer", async () => {
  await alpha.poll("Which color?", ["red", "blue"]);
  const start = await fake.waitSent((s) => s.roomId === alphaRoom && s.type === "org.matrix.msc3381.poll.start");
  const id = await fake.ownerEvent(alphaRoom, "org.matrix.msc3381.poll.response", {
    "m.relates_to": { rel_type: "m.reference", event_id: start.eventId },
    "org.matrix.msc3381.poll.response": { answers: ["a1"] },
  });
  const m = await alphaInbox.next((x) => x.event_id === id);
  assert.equal(m.kind, "poll_answer");
  assert.deepEqual(m.choices, ["blue"]);
});

test("approval request: Allow poll, control-room mention, allow result", async () => {
  const decision = alpha.requestApproval({ title: "delete old builds", requestId: "req-1" });
  const poll = await fake.waitSent(
    (s) => s.roomId === alphaRoom && s.type === "org.matrix.msc3381.poll.start" && /approval/.test(JSON.stringify(s.content)),
  );
  const mention = await fake.waitSent((s) => s.roomId === control() && /needs approval/.test(String(s.content.body)));
  assert.deepEqual(mention.content["m.mentions"], { user_ids: [OWNER] });
  await fake.ownerEvent(alphaRoom, "org.matrix.msc3381.poll.response", {
    "m.relates_to": { rel_type: "m.reference", event_id: poll.eventId },
    "org.matrix.msc3381.poll.response": { answers: [poll.content["org.matrix.msc3381.poll.start"].answers[0].id] },
  });
  assert.equal(await withTimeout(decision), "allow");
  await fake.notice(alphaRoom, /^Allowed: delete old builds$/);
});

test("requests before hello are rejected; bad hello names too", async () => {
  const net = await import("node:net");
  const sock = net.connect(config.socketPath);
  sock.setEncoding("utf8");
  let buf = "";
  const lines: any[] = [];
  sock.on("data", (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  sock.write('{"type":"reply","id":1,"text":"x"}\n{"type":"hello","id":2,"name":"all"}\n{"type":"hello","id":3,"name":"a b"}\n');
  while (lines.length < 3) await new Promise((r) => setTimeout(r, 10));
  sock.destroy();
  assert.deepEqual(lines.map((l) => [l.type, l.id]), [["error", 1], ["error", 2], ["error", 3]]);
  assert.match(lines[0].error, /hello/);
  assert.match(lines[1].error, /reserved/);
});

test("duplicate name from another instance is rejected", async () => {
  const dup = local("alpha", { instance: "other-instance" });
  await assert.rejects(withTimeout(dup.ready()), /already connected/);
  assert.equal(alpha.connected, true);
});

let beta: Agent;
let betaInbox: ReturnType<typeof inbox>;

test("remote agent over the WebSocket with a machine secret", async () => {
  beta = remote("beta");
  betaInbox = inbox(beta);
  await withTimeout(beta.ready());
  await fake.notice(system(), /^beta online · mxagent\/[^ ]+ 1\.0\.0 · laptop$/);
  assert.equal(daemon.registry.get("beta")?.machine, "laptop");
});

test("wrong machine secret is refused", async () => {
  const bad = remote("gamma", laptopSecret.replace(/^./, (c) => (c === "A" ? "B" : "A")));
  await assert.rejects(withTimeout(bad.ready()), /disconnected|rejected/);
  assert.equal(daemon.registry.has("gamma"), false);
});

test("@list shows connected agents", async () => {
  const id = await fake.ownerText(control(), "@list");
  const n = await fake.waitSent((s) => s.roomId === control() && s.content.msgtype === "m.notice" && /^Alpha · local · 2\.0/.test(s.content.body));
  assert.match(n.content.body, /\nbeta · laptop · 1\.0\.0/);
  void id;
});

test("@agent text goes to one agent, @all to every agent", async () => {
  const direct = await fake.ownerText(control(), "@beta only you");
  const d = await betaInbox.next((x) => x.event_id === direct);
  assert.equal(d.text, "only you");
  assert.equal(d.via, "control");

  const id = await fake.ownerText(control(), "@all stand up");
  const [a, b] = await Promise.all([alphaInbox.next((x) => x.event_id === id), betaInbox.next((x) => x.event_id === id)]);
  assert.equal(a.text, "stand up");
  assert.equal(b.text, "stand up");
  await fake.reaction(id, "👀");
});

test("@update: agents update, report back, ✅", async () => {
  const updates = Promise.all([alpha, beta].map((a) => withTimeout(new Promise<void>((r) => a.once("update", () => r())))));
  const id = await fake.ownerText(control(), "@update");
  await updates;
  await Promise.all([alpha.reportUpdated("1.9"), beta.reportUpdated("0.9.0")]);
  // versions differ (2.0 vs 1.0.0), so the result is ⚠️; check that path ends, then run a single-agent update
  await fake.reaction(id, "⚠️");
  await fake.notice(system(), /^Alpha updated: 1\.9 → 2\.0$/);

  const one = new Promise<void>((r) => beta.once("update", () => r()));
  const id2 = await fake.ownerText(control(), "@update beta");
  await withTimeout(one);
  await beta.reportUpdated("0.9.0");
  await fake.reaction(id2, "✅");
  await fake.notice(system(), /^Update complete: all 1 agent\(s\) on version 1\.0\.0/);
});

test("same instance replaces the old link without an offline notice", async () => {
  const instance = "worker-instance-1";
  const first = local("delta", { instance });
  await withTimeout(first.ready());
  const disconnected = withTimeout(new Promise<void>((r) => first.once("disconnected", () => r())));
  const second = local("delta", { instance });
  await withTimeout(second.ready());
  await disconnected;
  assert.equal(second.connected, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fake.sent.some((s) => s.roomId === system() && s.content.body === "delta offline"), false);
  const id = await fake.ownerText(daemon.rooms.agentRoom("delta")!, "still there?");
  const m = await inbox(second).next((x) => x.event_id === id);
  assert.equal(m.text, "still there?");
});

test("offline agent: offline notice, then 💤 for its room", async () => {
  alpha.close();
  await fake.notice(system(), /^Alpha offline$/);
  const id = await fake.ownerText(alphaRoom, "anyone?");
  await fake.reaction(id, "💤");
  await fake.notice(alphaRoom, /^Agent is offline\. Message was not delivered\.$/);
});

// ---------- additions: react, update_failed, hello rules, ordering, limits, stop ----------

let eps: Agent;
let epsInbox: ReturnType<typeof inbox>;

test("react puts the agent's emoji on the owner's last message", async () => {
  eps = local("Epsilon", { version: "1.0" });
  epsInbox = inbox(eps);
  const { roomId } = await withTimeout(eps.ready());
  const id = await fake.ownerText(roomId, "please check");
  await epsInbox.next((x) => x.event_id === id);
  await eps.react("👍");
  const r = await fake.reaction(id, "👍");
  assert.equal(r.roomId, roomId);
  await assert.rejects(eps.react("[x]"), /brackets/);
});

test("update_failed gives a system notice without control characters", async () => {
  await eps.reportUpdateFailed("npm\u0007 failed\nbadly");
  await fake.notice(system(), /^Epsilon: update failed: npm +failed badly$/);
});

test("poll texts are stripped of control characters", async () => {
  await eps.poll("Pick\u0007 one?", ["re\u0001d", "blue"]);
  const start = await fake.waitSent((s) => s.roomId === daemon.rooms.agentRoom("epsilon") && s.type === "org.matrix.msc3381.poll.start");
  const json = JSON.stringify(start.content);
  assert.equal(/\\u000[17]/.test(json), false);
  assert.match(json, /Pick one\?/);
  assert.match(json, /"red"/);
});

test("a second hello on one connection is rejected", async () => {
  const c = await rawLocal();
  c.send({ type: "hello", id: 1, name: "zeta" });
  await c.until(() => c.lines.some((l) => l.id === 1));
  c.send({ type: "hello", id: 2, name: "zeta2" });
  c.send({ type: "status" }); // id-less failure: error without id
  await c.until(() => c.lines.filter((l) => l.type === "error").length >= 2);
  const errs = c.lines.filter((l) => l.type === "error");
  assert.deepEqual(errs[0], { type: "error", id: 2, error: "already registered" });
  assert.equal(errs[1].id, undefined);
  assert.equal(daemon.registry.has("zeta2"), false);
  c.sock.destroy();
});

test("the agent is registered only after its room exists, and welcome is its first message", async () => {
  const g = gate();
  fake.createGate = g.p;
  const before = fake.createStarted;
  const c = await rawLocal();
  try {
    c.send({ type: "hello", id: 1, name: "slowpoke" });
    await c.until(() => fake.createStarted > before);
    assert.equal(daemon.registry.has("slowpoke"), false);
    const id = await fake.ownerText(control(), "@all are you there?");
    await fake.reaction(id, "👀"); // other agents got it
  } finally {
    fake.createGate = undefined;
    g.open();
  }
  await c.until(() => c.lines.some((l) => l.type === "welcome"));
  assert.equal(c.lines.filter((l) => l.type !== "heartbeat")[0].type, "welcome");
  assert.equal(c.lines.some((l) => l.type === "message"), false);
  assert.equal(daemon.registry.has("slowpoke"), true);
  c.sock.destroy();
});

test("too much queued data drops the link", async () => {
  const g = gate();
  fake.createGate = g.p;
  const before = fake.createStarted;
  const c = await rawLocal();
  try {
    c.send({ type: "hello", id: 1, name: "flooder" });
    await c.until(() => fake.createStarted > before);
    const big = "x".repeat(1024 * 1024);
    for (let i = 0; i < Math.ceil(MAX_QUEUED_BYTES / big.length) + 2; i++) c.send({ type: "reply", text: big });
    await c.until(() => c.closed());
  } finally {
    fake.createGate = undefined;
    g.open();
  }
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(daemon.registry.has("flooder"), false);
});

test("a held control-room message is remembered once sent, so replies to it are routed", async () => {
  // the fake sends immediately; simulate a flushed held message by a status the router learns only via onSent
  await eps.status("waiting for input");
  const st = await fake.notice(control(), /^\[Epsilon\] waiting for input$/);
  const id = await fake.ownerText(control(), "go ahead", { "m.relates_to": { "m.in_reply_to": { event_id: st.eventId } } });
  const m = await epsInbox.next((x) => x.event_id === id);
  assert.equal(m.text, "go ahead");
});

test("send-refused and held-dropped hooks post system notices (not for the system room)", async () => {
  for (const h of fake.refusedHandlers) h("!x:example.org", "room is not encrypted");
  await fake.notice(system(), /^Refusing to send to !x:example\.org: room is not encrypted$/);
  for (const h of fake.droppedHandlers) h("!y:example.org", 3);
  await fake.notice(system(), /^3 held message\(s\) for !y:example\.org dropped$/);
  const n = fake.sent.length;
  for (const h of fake.refusedHandlers) h(system(), "x");
  for (const h of fake.droppedHandlers) h(system(), 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fake.sent.length, n);
});

test("request queue survives a failing answer", async () => {
  const lines: string[] = [];
  let onLine!: (o: unknown) => void;
  let failNext = true;
  const conn: Connection = {
    machine: "local",
    write(line) {
      if (failNext && line.includes('"error"')) {
        failNext = false;
        throw new Error("write failed");
      }
      lines.push(line);
    },
    close() {},
    alive: () => true,
    onLine: (cb) => void (onLine = cb),
    onClose() {},
  };
  const deps = {
    config: { owner: OWNER },
    log: silentLogger,
    matrix: { sendText: async () => ({ eventId: "$t", held: false }), setTyping() {} },
    rooms: { ensureAgentRoom: async () => "!room:example.org", setDisplayName: async () => {}, controlRoomId: undefined },
    registry: { register: () => ({ ok: true }), remove: () => true },
    router: { rememberControlMessage() {} },
    polls: {},
    reactions: {},
    updates: {},
    notify: { system() {} },
    heartbeatMs: 0,
  } as unknown as Parameters<typeof handleConnection>[1];
  const rejections: unknown[] = [];
  const onRej = (e: unknown) => rejections.push(e);
  process.on("unhandledRejection", onRej);
  try {
    handleConnection(conn, deps);
    onLine({ type: "reply", id: 1, text: "x" }); // error "send hello first" -> write throws
    onLine({ type: "hello", id: 2, name: "queue-test" });
    onLine({ type: "reply", id: 3, text: "hi" });
    const end = Date.now() + 2000;
    while (!lines.some((l) => l.includes('"id":3')) && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  } finally {
    await new Promise((r) => setTimeout(r, 10));
    process.off("unhandledRejection", onRej);
  }
  assert.ok(lines.some((l) => l.includes('"welcome"')));
  assert.ok(lines.some((l) => l.includes('"ok"') && l.includes('"id":3')));
  assert.deepEqual(rejections, []);
});

test("new-room quota per machine", async () => {
  const lines: string[] = [];
  let onLine!: (o: unknown) => void;
  const conn = (): Connection => ({
    machine: "laptop",
    write: (l) => void lines.push(l),
    close() {},
    alive: () => true,
    onLine: (cb) => void (onLine = cb),
    onClose() {},
  });
  const { RoomQuota } = await import("../src/daemon/registry.ts");
  const quota = new RoomQuota(1);
  const known = new Set<string>(["old"]);
  const deps = {
    config: { owner: OWNER },
    log: silentLogger,
    matrix: { setTyping() {} },
    rooms: { ensureAgentRoom: async (n: string) => (known.add(n.toLowerCase()), `!${n}:example.org`), agentRoom: (k: string) => (known.has(k) ? `!${k}:example.org` : undefined), setDisplayName: async () => {}, controlRoomId: undefined },
    registry: { register: () => ({ ok: true }), remove: () => true },
    router: { rememberControlMessage() {} },
    polls: {},
    reactions: {},
    updates: {},
    notify: { system() {} },
    roomQuota: quota,
    heartbeatMs: 0,
  } as unknown as Parameters<typeof handleConnection>[1];
  for (const [i, name] of ["one", "two", "old", "one"].entries()) {
    handleConnection(conn(), deps);
    onLine({ type: "hello", id: i, name });
    const end = Date.now() + 2000;
    while (!lines.some((l) => l.includes(`"id":${i}`)) && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  }
  const byId = lines.map((l) => JSON.parse(l));
  assert.deepEqual(byId.map((l) => l.type), ["welcome", "error", "welcome", "welcome"]);
  assert.match(byId[1].error, /too many new agent names/);
});

test("stop() during start() leaves no listener open", async () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "mxagent-stop-"));
  try {
    const cfg = configFromVars(
      { MXA_HOMESERVER: "https://matrix.example.org", MXA_BOT_USER: BOT, MXA_OWNER: OWNER, MXA_SPACE_ID: SPACE, MXA_SOCKET_PATH: path.join(d2, "b.sock"), MXA_WS_LISTEN: "127.0.0.1:8640" },
      { MXA_STATE_DIR: path.join(d2, "state"), MXA_CONFIG: path.join(d2, "bridge.env"), XDG_RUNTIME_DIR: d2 },
    );
    cfg.wsListen = { host: "127.0.0.1", port: 0 };
    const f2 = new FakeMatrix();
    const g = gate();
    f2.startGate = g.p;
    const d = createDaemon({ config: cfg, state: StateStore.load(path.join(d2, "state", "state.json")), log: silentLogger, matrix: f2, machines: new MachineStore(machinesFile({ configDir: d2 })), trust: { check: async () => null }, version: "0" });
    const starting = d.start();
    await d.stop();
    g.open();
    await withTimeout(starting);
    assert.equal(d.wsPort, undefined);
    assert.equal(fs.existsSync(cfg.socketPath), false);
    assert.equal(f2.sent.length, 0);
  } finally {
    fs.rmSync(d2, { recursive: true, force: true });
  }
});

test("MXA_APPROVAL_TTL_MINUTES is wired: an expired approval answers deny; stop() clears pending timers", async () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "mxagent-ttl-"));
  const opened: Agent[] = [];
  try {
    const cfg = configFromVars(
      { MXA_HOMESERVER: "https://matrix.example.org", MXA_BOT_USER: BOT, MXA_OWNER: OWNER, MXA_SPACE_ID: SPACE, MXA_SOCKET_PATH: path.join(d2, "b.sock"), MXA_APPROVAL_TTL_MINUTES: "1" },
      { MXA_STATE_DIR: path.join(d2, "state"), MXA_CONFIG: path.join(d2, "bridge.env"), XDG_RUNTIME_DIR: d2 },
    );
    assert.equal(cfg.approvalTtlMs, 60_000);
    cfg.approvalTtlMs = 150; // minutes are too slow for a test
    const f2 = new FakeMatrix();
    const d = createDaemon({ config: cfg, state: StateStore.load(path.join(d2, "state", "state.json")), log: silentLogger, matrix: f2, machines: new MachineStore(machinesFile({ configDir: d2 })), trust: { check: async () => null }, version: "0" });
    await d.start();
    const connect = (name: string) => {
      const a = sdk.connect({ name, socketPath: cfg.socketPath, reconnect: false, configFile: path.join(d2, "none.env") });
      a.on("error", () => {});
      opened.push(a);
      return a;
    };
    const a = connect("Ttl");
    const { roomId } = await withTimeout(a.ready());
    assert.equal(await withTimeout(a.requestApproval({ title: "slow", requestId: "t-1" })), "deny");
    await f2.notice(roomId, /^Expired: slow$/);

    const b = connect("Ttl2");
    const r2 = await withTimeout(b.ready());
    void b.requestApproval({ title: "pending at shutdown", requestId: "t-2" }).catch(() => undefined);
    await f2.waitSent((s) => s.roomId === r2.roomId && s.type === "org.matrix.msc3381.poll.start");
    await d.stop();
    const before = f2.sent.length;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(f2.sent.length, before); // no expiry ran after shutdown
  } finally {
    for (const a of opened) a.close();
    fs.rmSync(d2, { recursive: true, force: true });
  }
});

test("forwarded room key: owner message is not delivered", async () => {
  const roomId = daemon.rooms.agentRoom("epsilon")!;
  const id = await fake.ownerEvent(roomId, "m.room.message", { msgtype: "m.text", body: "forwarded" }, { ...TRUSTED, forwarded: true } as typeof TRUSTED);
  await fake.notice(roomId, /^Not delivered: key forwarded; message not trusted\.$/);
  assert.equal(epsInbox.got.some((m) => m.event_id === id), false);
});
