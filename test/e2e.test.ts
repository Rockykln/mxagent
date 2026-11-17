// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
// End to end: the real daemon graph (fake Matrix, fake trust, real local and WebSocket transports on
// loopback) driven by the JS SDK, the Python SDK (child process) and the MCP adapter (stdio).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configFromVars } from "../src/daemon/config.ts";
import { silentLogger } from "../src/daemon/log.ts";
import { MachineStore, machinesFile } from "../src/daemon/machines.ts";
import type { EventHandler, MatrixEvent, SendResult, SentHandler } from "../src/daemon/matrix.ts";
import { StateStore } from "../src/daemon/state.ts";
import { createDaemon, type Daemon, type DaemonMatrix } from "../src/daemon/index.ts";
import type { InboundMessage } from "../src/protocol/messages.ts";
import { connect, type Agent } from "../clients/js/index.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MCP_SERVER = path.join(ROOT, "adapters", "mcp", "server.mjs");
const PY_SRC = path.join(ROOT, "clients", "python", "src");

const OWNER = "@alice:example.org";
const BOT = "@agents:example.org";
const SPACE = "!space:example.org";
const TRUSTED = { device: "OWNERDEV", curveKey: "curve-owner" };
const POLL_START = "org.matrix.msc3381.poll.start";
const POLL_RESPONSE = "org.matrix.msc3381.poll.response";

interface Sent {
  roomId: string;
  type: string;
  content: Record<string, any>;
  eventId: string;
}

function withTimeout<T>(p: Promise<T>, ms = 5000, what = "operation"): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), ms);
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

/** Fake Matrix layer: the owner has joined every room; outgoing events are recorded. */
class FakeMatrix {
  readonly botUser = BOT;
  readonly owner = OWNER;
  readonly sent: Sent[] = [];
  readonly raw: Sent[] = [];
  private readonly decrypted = new Set<EventHandler>();
  private readonly plain = new Set<EventHandler>();
  private readonly sentHandlers = new Set<SentHandler>();
  private readonly joined = new Set<string>([SPACE]);
  private seq = 0;
  private waiters: { list: Sent[]; pred: (s: Sent) => boolean; resolve: (s: Sent) => void }[] = [];
  running = false;

  readonly client = {
    createRoom: async () => {
      const roomId = `!r${++this.seq}:example.org`;
      this.joined.add(roomId);
      return roomId;
    },
    sendStateEvent: async () => `$state${++this.seq}`,
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

  private readonly replayKeys = new Set<string>();
  isReplay(key: unknown): boolean {
    return typeof key !== "string" || !key || this.replayKeys.has(key);
  }
  recordReplay(key: unknown): boolean {
    if (this.isReplay(key)) return false;
    this.replayKeys.add(key as string);
    return true;
  }

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
  // Sends never fail and nothing is held here (the owner has joined every room).
  onSendRefused(_cb: (roomId: string, reason: string) => void) {
    return () => {};
  }
  onHeldDropped(_cb: (roomId: string, count: number) => void) {
    return () => {};
  }

  private record(list: Sent[], roomId: string, type: string, content: Record<string, any>): string {
    const eventId = `$e${++this.seq}`;
    const s = { roomId, type, content, eventId };
    list.push(s);
    this.waiters = this.waiters.filter((w) => !(w.list === list && w.pred(s) && (w.resolve(s), true)));
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
    this.running = true;
  }
  stop() {
    this.running = false;
  }

  waitSent(pred: (s: Sent) => boolean, raw = false): Promise<Sent> {
    const list = raw ? this.raw : this.sent;
    const hit = list.find(pred);
    if (hit) return Promise.resolve(hit);
    return withTimeout(new Promise<Sent>((resolve) => this.waiters.push({ list, pred, resolve })), 5000, "matrix event");
  }

  reaction(eventId: string, key: string): Promise<Sent> {
    return this.waitSent((s) => s.content["m.relates_to"]?.event_id === eventId && s.content["m.relates_to"]?.key === key, true);
  }

  async ownerEvent(roomId: string, type: string, content: Record<string, any>): Promise<string> {
    const event_id = `$owner${++this.seq}`;
    const ev: MatrixEvent = { event_id, sender: OWNER, type, room_id: roomId, origin_server_ts: Date.now(), content, mxa_sender: { ...TRUSTED }, mxa_replay_key: `${roomId}|fake-session|${this.seq}` };
    for (const h of this.decrypted) await h(roomId, ev);
    return event_id;
  }

  ownerText(roomId: string, body: string): Promise<string> {
    return this.ownerEvent(roomId, "m.room.message", { msgtype: "m.text", body });
  }

  pollAnswer(roomId: string, pollEventId: string, answerId: string): Promise<string> {
    return this.ownerEvent(roomId, POLL_RESPONSE, {
      "m.relates_to": { rel_type: "m.reference", event_id: pollEventId },
      [POLL_RESPONSE]: { answers: [answerId] },
    });
  }
}

// ---------- daemon ----------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mxagent-e2e-"));
const CLIENT_ENV_KEYS = ["MXA_SOCKET_PATH", "MXA_URL", "MXA_MACHINE", "MXA_SECRET"];
for (const k of CLIENT_ENV_KEYS) delete process.env[k];
const noFile = path.join(dir, "none.env");
const config = configFromVars(
  {
    MXA_HOMESERVER: "https://matrix.example.org",
    MXA_BOT_USER: BOT,
    MXA_OWNER: OWNER,
    MXA_SPACE_ID: SPACE,
    MXA_SOCKET_PATH: path.join(dir, "bridge.sock"),
    MXA_WS_LISTEN: "127.0.0.1:8640",
  },
  { MXA_STATE_DIR: path.join(dir, "state"), MXA_CONFIG: path.join(dir, "bridge.env"), XDG_RUNTIME_DIR: dir },
);
config.wsListen = { host: "127.0.0.1", port: 0 };
const machines = new MachineStore(machinesFile({ configDir: dir }));
const laptopSecret = machines.addMachine("laptop");
const fake = new FakeMatrix();
const daemon: Daemon = createDaemon({
  config,
  state: StateStore.load(path.join(dir, "state", "state.json")),
  log: silentLogger,
  matrix: fake,
  machines,
  trust: { check: async (device, curveKey) => (device === TRUSTED.device && curveKey === TRUSTED.curveKey ? null : "untrusted device") },
  fetch: (async () => new Response("", { status: 404 })) as typeof fetch,
  version: "1.0.0",
});
await daemon.start();
const wsUrl = () => `ws://127.0.0.1:${daemon.wsPort}/`;
const control = () => daemon.rooms.controlRoomId!;

/** Child environment without the test runner's MXA_* settings and with private XDG dirs. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("MXA_")) delete env[k];
  return { ...env, XDG_CONFIG_HOME: path.join(dir, "xdg-config"), XDG_STATE_HOME: path.join(dir, "xdg-state"), ...extra };
}

const cleanups: (() => void | Promise<void>)[] = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
  await daemon.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

function inbox(agent: Agent) {
  const got: InboundMessage[] = [];
  let waiters: { pred: (m: InboundMessage) => boolean; resolve: (m: InboundMessage) => void }[] = [];
  agent.on("message", (m) => {
    got.push(m as InboundMessage);
    waiters = waiters.filter((w) => !(w.pred(m as InboundMessage) && (w.resolve(m as InboundMessage), true)));
  });
  return (pred: (m: InboundMessage) => boolean): Promise<InboundMessage> => {
    const hit = got.find(pred);
    if (hit) return Promise.resolve(hit);
    return withTimeout(new Promise((resolve) => waiters.push({ pred, resolve })), 5000, "agent message");
  };
}

/** Answer id of option `index` in a sent poll start (approval polls use random ids). */
function pollAnswerId(poll: Sent, index: number): string {
  const id = poll.content[POLL_START]?.answers?.[index]?.id;
  assert.equal(typeof id, "string");
  return id;
}

/** The common scenario every client runs: message delivery, reply, poll + answer, approval. */
interface Driver {
  name: string;
  roomId: string;
  nextMessage(pred: (m: Record<string, any>) => boolean): Promise<Record<string, any>>;
  reply(text: string): Promise<void>;
  poll(question: string, options: string[]): Promise<void>;
  /** Votes by 1-based option number. */
  vote(answer: number): Promise<void>;
  /** Starts an approval request; the returned promise resolves with the decision. */
  approval(title: string): Promise<string>;
}

async function scenario(d: Driver) {
  const room = d.roomId;
  assert.equal(daemon.rooms.agentRoom(d.name.toLowerCase()), room);

  const id = await fake.ownerText(room, `hello ${d.name}`);
  const m = await d.nextMessage((x) => x.event_id === id);
  assert.equal(m.kind, "text");
  assert.equal(m.text, `hello ${d.name}`);
  assert.equal(m.via, "room");
  await fake.reaction(id, "👀");

  await d.reply(`reply from ${d.name}`);
  await fake.waitSent((s) => s.roomId === room && s.content.msgtype === "m.text" && s.content.body === `reply from ${d.name}`);

  await d.poll(`color for ${d.name}?`, ["red", "blue"]);
  const start = await fake.waitSent((s) => s.roomId === room && s.type === POLL_START && JSON.stringify(s.content).includes(`color for ${d.name}?`));
  const answerId = await fake.pollAnswer(room, start.eventId, "a1");
  const answer = await d.nextMessage((x) => x.event_id === answerId);
  assert.equal(answer.kind, "poll_answer");
  assert.deepEqual(answer.choices, ["blue"]);

  const ownerPoll = await fake.ownerEvent(room, POLL_START, {
    [POLL_START]: {
      question: { "org.matrix.msc1767.text": "lunch?" },
      answers: [
        { id: "o1", "org.matrix.msc1767.text": "pizza" },
        { id: "o2", "org.matrix.msc1767.text": "salad" },
      ],
    },
  });
  const started = await d.nextMessage((x) => x.event_id === ownerPoll);
  assert.equal(started.kind, "poll_started");
  assert.deepEqual(started.options, ["pizza", "salad"]);
  await d.vote(2);
  await fake.waitSent((s) => s.roomId === room && s.type === POLL_RESPONSE && s.content["m.relates_to"]?.event_id === ownerPoll && s.content[POLL_RESPONSE]?.answers?.[0] === "o2");

  const decision = d.approval(`deploy ${d.name}`);
  const approvalPoll = await fake.waitSent(
    (s) => s.roomId === room && s.type === POLL_START && /approval/.test(JSON.stringify(s.content)) && JSON.stringify(s.content).includes(`deploy ${d.name}`),
  );
  await fake.waitSent((s) => s.roomId === control() && /needs approval/.test(String(s.content.body)) && String(s.content.body).includes(d.name));
  await fake.pollAnswer(room, approvalPoll.eventId, pollAnswerId(approvalPoll, 0));
  assert.equal(await withTimeout(decision, 5000, "approval decision"), "allow");
}

function jsDriver(agent: Agent, roomId: string): Driver {
  const next = inbox(agent);
  return {
    name: agent.name,
    roomId,
    nextMessage: (pred) => next(pred as (m: InboundMessage) => boolean) as Promise<Record<string, any>>,
    reply: async (t) => {
      assert.deepEqual(await agent.reply(t), { held: false });
    },
    poll: (q, o) => agent.poll(q, o),
    vote: (n) => agent.vote(n),
    approval: (title) => agent.requestApproval({ title }),
  };
}

function jsAgent(opts: Parameters<typeof connect>[0]): Agent {
  const a = connect({ configFile: noFile, reconnect: false, ...opts });
  a.on("error", () => {});
  cleanups.push(() => a.close());
  return a;
}

// ---------- raw protocol ----------

test("an approval request_id that is still pending on the link is rejected", async () => {
  const sock = net.connect(config.socketPath);
  cleanups.push(() => void sock.destroy());
  const lines: Record<string, any>[] = [];
  let waiters: { pred: (m: Record<string, any>) => boolean; resolve: (m: Record<string, any>) => void }[] = [];
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      lines.push(m);
      waiters = waiters.filter((w) => !(w.pred(m) && (w.resolve(m), true)));
    }
  });
  const next = (pred: (m: Record<string, any>) => boolean) => {
    const hit = lines.find(pred);
    if (hit) return Promise.resolve(hit);
    return withTimeout(new Promise<Record<string, any>>((resolve) => waiters.push({ pred, resolve })), 5000, "daemon line");
  };
  const send = (obj: unknown) => sock.write(JSON.stringify(obj) + "\n");
  send({ type: "hello", id: 1, name: "raw-dup" });
  const { room_id: room } = await next((m) => m.type === "welcome");
  send({ type: "approval_request", id: 2, request_id: "dup", title: "raw dup approval" });
  assert.deepEqual(await next((m) => m.id === 2), { type: "ok", id: 2 });
  send({ type: "approval_request", id: 3, request_id: "dup", title: "raw dup approval again" });
  assert.deepEqual(await next((m) => m.id === 3), { type: "error", id: 3, error: "request_id already pending" });
  const poll = await fake.waitSent((s) => s.roomId === room && s.type === POLL_START && JSON.stringify(s.content).includes("raw dup approval"));
  await fake.pollAnswer(room, poll.eventId, pollAnswerId(poll, 1));
  assert.deepEqual(await next((m) => m.type === "approval_result"), { type: "approval_result", request_id: "dup", decision: "deny" });
  // decided: the id may be used again
  send({ type: "approval_request", id: 4, request_id: "dup", title: "raw dup approval reused" });
  assert.deepEqual(await next((m) => m.id === 4), { type: "ok", id: 4 });
  send({ type: "approval_cancel", id: 5, request_id: "dup" });
  assert.deepEqual(await next((m) => m.id === 5), { type: "ok", id: 5 });
  send({ type: "approval_request", id: 6, request_id: "dup", title: "raw dup approval after cancel" });
  assert.deepEqual(await next((m) => m.id === 6), { type: "ok", id: 6 });
  sock.destroy();
});

// ---------- JS SDK ----------

test("JS SDK over the local socket", async () => {
  const agent = jsAgent({ name: "js-local", socketPath: config.socketPath, client: "e2e-js/1.0" });
  const { roomId } = await withTimeout(agent.ready(), 5000, "welcome");
  assert.equal(agent.mode, "local");
  await fake.waitSent((s) => /^js-local online · e2e-js\/1\.0 · local$/.test(String(s.content.body)));
  await scenario(jsDriver(agent, roomId));
});

test("JS SDK over the encrypted WebSocket with a machine secret", async () => {
  const agent = jsAgent({ name: "js-remote", url: wsUrl(), machine: "laptop", secret: laptopSecret, version: "2.0" });
  const { roomId } = await withTimeout(agent.ready(), 5000, "welcome");
  assert.equal(agent.mode, "remote");
  assert.equal(daemon.registry.get("js-remote")?.machine, "laptop");
  await scenario(jsDriver(agent, roomId));

  const bad = jsAgent({ name: "js-intruder", url: wsUrl(), machine: "laptop", secret: laptopSecret.replace(/^./, (c) => (c === "A" ? "B" : "A")) });
  await assert.rejects(withTimeout(bad.ready(), 5000, "rejection"), /rejected|disconnected/);
  assert.equal(daemon.registry.has("js-intruder"), false);
});

// ---------- Python SDK ----------

const PY_DRIVER = String.raw`
import asyncio, json, sys
from mxagent import connect

def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

async def main():
    agent = await connect(**json.loads(sys.argv[1]))

    @agent.on_message
    def on_message(msg):
        out({"ev": "message", "msg": msg})

    out({"ev": "welcome", "room_id": agent.room_id, "remote": agent.settings.remote})
    loop = asyncio.get_running_loop()
    tasks = set()

    async def run(cmd):
        try:
            op = cmd["op"]
            if op == "reply":
                res = await agent.reply(cmd["text"])
            elif op == "poll":
                res = await agent.poll(cmd["question"], cmd["options"])
            elif op == "approval":
                res = await agent.request_approval(cmd["title"])
            elif op == "vote":
                res = await agent.vote(cmd["answer"])
            else:
                raise ValueError("unknown op")
            out({"ev": "done", "tag": cmd["tag"], "result": res})
        except Exception as exc:
            out({"ev": "failed", "tag": cmd["tag"], "error": f"{type(exc).__name__}: {exc}"})

    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line or json.loads(line)["op"] == "close":
            break
        task = asyncio.ensure_future(run(json.loads(line)))
        tasks.add(task)
        task.add_done_callback(tasks.discard)
    await agent.close()

try:
    asyncio.run(main())
except Exception as exc:
    out({"ev": "fatal", "error": f"{type(exc).__name__}: {exc}"})
    sys.exit(1)
`;

function pythonHas(module: string): boolean {
  const r = spawnSync("python3", ["-c", `import ${module}`], { stdio: "ignore", env: childEnv() });
  return r.status === 0;
}

const hasPython = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const pySkip = !hasPython ? "python3 not found" : !pythonHas("cryptography") ? "Python package 'cryptography' is not installed" : false;
const pyRemoteSkip = pySkip || (!pythonHas("websockets") ? "Python package 'websockets' is not installed (needed for remote mode)" : false);
// CI sets MXA_REQUIRE_PY_E2E=1 so that a missing Python setup fails the run instead of skipping quietly.
if (process.env.MXA_REQUIRE_PY_E2E === "1") {
  test("Python e2e prerequisites are installed (MXA_REQUIRE_PY_E2E=1)", () => {
    assert.equal(pyRemoteSkip, false, `the Python e2e tests would be skipped: ${pyRemoteSkip}`);
  });
}

class PyAgent {
  readonly proc: ChildProcessWithoutNullStreams;
  private events: Record<string, any>[] = [];
  private waiters: { pred: (e: Record<string, any>) => boolean; resolve: (e: Record<string, any>) => void }[] = [];
  private tag = 0;
  stderr = "";

  constructor(opts: Record<string, unknown>) {
    const script = path.join(dir, "py_driver.py");
    if (!fs.existsSync(script)) fs.writeFileSync(script, PY_DRIVER);
    this.proc = spawn("python3", [script, JSON.stringify({ config_file: noFile, reconnect: false, ...opts })], {
      env: childEnv({ PYTHONPATH: PY_SRC, PYTHONDONTWRITEBYTECODE: "1" }),
    });
    let buf = "";
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let ev: Record<string, any>;
        try {
          ev = JSON.parse(line) as Record<string, any>;
        } catch {
          ev = { ev: "fatal", error: `invalid driver output: ${line.slice(0, 200)}` };
        }
        this.push(ev);
      }
    });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (c: string) => (this.stderr += c));
    // An early exit must fail the waiting test, not crash the file with EPIPE / spawn errors.
    this.proc.stdin.on("error", () => {});
    this.proc.on("error", (err) => this.push({ ev: "fatal", error: `spawn failed: ${err.message}` }));
    this.proc.on("close", (code) => this.push({ ev: "fatal", error: `python driver exited (code ${code})` }));
    cleanups.push(() => this.stop());
  }

  private push(ev: Record<string, any>) {
    this.events.push(ev);
    this.waiters = this.waiters.filter((w) => !(w.pred(ev) && (w.resolve(ev), true)));
  }

  next(pred: (e: Record<string, any>) => boolean, what = "python event"): Promise<Record<string, any>> {
    const hit = this.events.find(pred) ?? this.events.find((e) => e.ev === "fatal");
    if (hit?.ev === "fatal") return Promise.reject(new Error(`python agent failed: ${hit.error}\n${this.stderr}`));
    if (hit) return Promise.resolve(hit);
    const p = new Promise<Record<string, any>>((resolve) => this.waiters.push({ pred: (e) => e.ev === "fatal" || pred(e), resolve }));
    return withTimeout(p, 8000, what).then((e) => {
      if (e.ev === "fatal") throw new Error(`python agent failed: ${e.error}\n${this.stderr}`);
      return e;
    });
  }

  /** Sends a command; resolves with its result, rejects with the Python exception text. */
  async call(op: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    const tag = ++this.tag;
    if (this.proc.exitCode === null && this.proc.stdin.writable) this.proc.stdin.write(JSON.stringify({ op, tag, ...fields }) + "\n");
    const ev = await this.next((e) => e.tag === tag, `python ${op}`);
    if (ev.ev === "failed") throw new Error(String(ev.error));
    return ev.result;
  }

  driver(name: string, roomId: string): Driver {
    return {
      name,
      roomId,
      nextMessage: async (pred) => (await this.next((e) => e.ev === "message" && pred(e.msg), "python message")).msg,
      reply: async (t) => {
        assert.deepEqual(await this.call("reply", { text: t }), { held: false });
      },
      poll: async (question, options) => {
        await this.call("poll", { question, options });
      },
      vote: async (answer) => {
        await this.call("vote", { answer });
      },
      approval: async (title) => String(await this.call("approval", { title })),
    };
  }

  async stop() {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    if (this.proc.stdin.writable) this.proc.stdin.end(JSON.stringify({ op: "close" }) + "\n");
    await withTimeout(new Promise((r) => this.proc.once("exit", r)), 3000, "python exit").catch(() => this.proc.kill());
  }
}

test("Python SDK over the local socket", { skip: pySkip }, async () => {
  const py = new PyAgent({ name: "py-local", socket_path: config.socketPath, client: "e2e-py/1.0" });
  const welcome = await py.next((e) => e.ev === "welcome", "python welcome");
  assert.equal(welcome.remote, false);
  await fake.waitSent((s) => /^py-local online · e2e-py\/1\.0 · local$/.test(String(s.content.body)));
  await scenario(py.driver("py-local", welcome.room_id));
  await assert.rejects(py.call("vote", { answer: 0 }), /ValueError/);
  await py.stop();
  assert.equal(py.proc.exitCode, 0, py.stderr);
});

test("Python SDK with incomplete remote settings raises ConfigError", { skip: pySkip }, async () => {
  const py = new PyAgent({ name: "py-misconfigured", url: wsUrl(), machine: "laptop" });
  await assert.rejects(py.next((e) => e.ev === "welcome", "python welcome"), /ConfigError: remote mode needs a machine name and secret/);
});

test("Python SDK over the encrypted WebSocket with a machine secret", { skip: pyRemoteSkip }, async () => {
  const py = new PyAgent({ name: "py-remote", url: wsUrl(), machine: "laptop", secret: laptopSecret });
  const welcome = await py.next((e) => e.ev === "welcome", "python welcome");
  assert.equal(welcome.remote, true);
  assert.equal(daemon.registry.get("py-remote")?.machine, "laptop");
  await scenario(py.driver("py-remote", welcome.room_id));
  await py.stop();
});

// ---------- MCP adapter ----------

class McpClient {
  readonly proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (msg: any) => void; reject: (err: Error) => void }>();
  private exited: Error | null = null;
  stderr = "";

  constructor(args: string[], env: Record<string, string> = {}) {
    this.proc = spawn(process.execPath, [MCP_SERVER, ...args], { env: childEnv(env) });
    let buf = "";
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // not ours to judge here; the request then times out with stderr attached
        }
        const p = this.pending.get(msg?.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg);
        }
      }
    });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (c: string) => (this.stderr += c));
    // An early exit must fail the pending requests, not crash the file with EPIPE / spawn errors.
    this.proc.stdin.on("error", () => {});
    const fail = (err: Error) => {
      this.exited ??= err;
      for (const p of this.pending.values()) p.reject(this.exited);
      this.pending.clear();
    };
    this.proc.on("error", (err) => fail(new Error(`mcp adapter failed to start: ${err.message}`)));
    this.proc.on("close", (code) => fail(new Error(`mcp adapter exited (code ${code})\n${this.stderr}`)));
    cleanups.push(() => this.stop());
  }

  request(method: string, params: unknown = {}): Promise<any> {
    if (this.exited) return Promise.reject(this.exited);
    const id = this.nextId++;
    const p = new Promise<any>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return withTimeout(p, 8000, `mcp ${method}`).then((msg) => {
      if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
      return msg.result;
    });
  }

  async tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const res = await this.request("tools/call", { name, arguments: args });
    if (res.isError) throw new Error(`${name}: ${res.content?.[0]?.text}\n${this.stderr}`);
    return res;
  }

  /**
   * Calls bridge_wait until a message matching pred shows up (the inbox may hold others too).
   * `keep` receives every drained batch in full, so messages after the hit are not lost.
   */
  async waitMessage(pred: (m: Record<string, any>) => boolean, keep?: (batch: Record<string, any>[]) => void): Promise<Record<string, any>> {
    for (let i = 0; i < 10; i++) {
      const res = await this.tool("bridge_wait", { timeout_s: 5 });
      const batch = res.structuredContent.messages as Record<string, any>[];
      keep?.(batch);
      const hit = batch.find(pred);
      if (hit) return hit;
    }
    throw new Error("message did not arrive in the MCP inbox");
  }

  async stop() {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    this.proc.stdin.end();
    await withTimeout(new Promise((r) => this.proc.once("exit", r)), 3000, "mcp exit").catch(() => this.proc.kill());
  }
}

test("MCP adapter over stdio against the daemon", async () => {
  const mcp = new McpClient(["--name", "mcp-agent", "--socket", config.socketPath]);
  const init = await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  assert.equal(init.serverInfo.name, "mxagent");
  const list = await mcp.request("tools/list");
  assert.ok(list.tools.some((t: { name: string }) => t.name === "bridge_request_approval"));

  const status = await mcp.tool("bridge_status", { text: "mcp agent ready" });
  assert.match(status.content[0].text, /posted/);
  await fake.waitSent((s) => s.roomId === control() && /^\[mcp-agent\] mcp agent ready$/.test(String(s.content.body)));
  await fake.waitSent((s) => /^mcp-agent online · mcp-adapter\/[^ ]+ · local$/.test(String(s.content.body)));
  const roomId = daemon.rooms.agentRoom("mcp-agent");
  assert.ok(roomId);

  // Messages that arrive between bridge_wait calls stay queued; seen ones are kept for later lookups.
  const seen: Record<string, any>[] = [];
  const driver: Driver = {
    name: "mcp-agent",
    roomId,
    nextMessage: async (pred) => {
      const old = seen.find(pred);
      if (old) return old;
      return mcp.waitMessage(pred, (batch) => seen.push(...batch));
    },
    reply: async (t) => {
      const r = await mcp.tool("bridge_reply", { text: t });
      assert.equal(r.structuredContent.held, false);
    },
    poll: async (question, options) => {
      await mcp.tool("bridge_poll", { question, options });
    },
    vote: async (answer) => {
      await mcp.tool("bridge_vote", { answer: String(answer) });
    },
    approval: async (title) => (await mcp.tool("bridge_request_approval", { title, timeout_s: 10 })).structuredContent.decision,
  };
  await scenario(driver);

  // A timed-out approval is withdrawn through the SDK (approval_cancel): the daemon ends the poll.
  const timedOut = await mcp.tool("bridge_request_approval", { title: "mcp late approval", timeout_s: 1 });
  assert.equal(timedOut.structuredContent.decision, "timeout");
  await fake.waitSent((s) => s.roomId === roomId && String(s.content.body ?? "").startsWith("Cancelled: mcp late approval"));
  await mcp.stop();
});

test("MCP adapter over the encrypted WebSocket with a machine secret", async () => {
  const mcp = new McpClient(["--name", "mcp-remote", "--url", wsUrl(), "--machine", "laptop"], { MXA_SECRET: laptopSecret });
  await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  await mcp.tool("bridge_reply", { text: "hello over websocket" });
  const roomId = daemon.rooms.agentRoom("mcp-remote");
  assert.ok(roomId);
  assert.equal(daemon.registry.get("mcp-remote")?.machine, "laptop");
  await fake.waitSent((s) => s.roomId === roomId && s.content.body === "hello over websocket");
  const id = await fake.ownerText(roomId, "remote instruction");
  const m = await mcp.waitMessage((x) => x.event_id === id);
  assert.equal(m.text, "remote instruction");
  await mcp.stop();
});
