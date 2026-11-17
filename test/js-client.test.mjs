// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import {
  connect,
  resolveOptions,
  BridgeError,
  ConfigError,
  NotConnectedError,
  RequestTimeoutError,
  AuthenticationError,
} from "../clients/js/index.mjs";
import { lineSplitter } from "../clients/js/lines.mjs";
import { Cipher, nonce, proof, proofOk } from "../clients/js/secure.mjs";

const SECRET = "A".repeat(20) + "b_-".repeat(4) + "0123456789z"; // 43 base64url characters

let dir;
before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "mxagent-js-client-"));
  for (const k of ["MXA_SOCKET_PATH", "MXA_URL", "MXA_MACHINE", "MXA_SECRET"]) delete process.env[k];
});
after(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
const sockPath = () => path.join(dir, `d${++counter}.sock`);
const noFile = () => path.join(dir, "missing.env");

/** Minimal in-process daemon: records requests, answers via a pluggable handler. */
class FakeDaemon {
  constructor(file, handler) {
    this.file = file;
    this.handler = handler;
    this.requests = [];
    this.sockets = new Set();
    this.waiters = [];
  }

  async start() {
    this.server = net.createServer((sock) => {
      this.sockets.add(sock);
      sock.setEncoding("utf8");
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const msg = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          this.requests.push(msg);
          this.handler(msg, (out) => sock.write(JSON.stringify(out) + "\n"), sock);
          this.waiters = this.waiters.filter((w) => !(w.pred(msg) && (w.resolve(msg), true)));
        }
      });
      sock.on("close", () => this.sockets.delete(sock));
      sock.on("error", () => {});
    });
    this.server.listen(this.file);
    await once(this.server, "listening");
  }

  /** Waits for the next request matching pred (or an already received one after index `from`). */
  next(pred, from = 0) {
    const hit = this.requests.slice(from).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => this.waiters.push({ pred, resolve }));
  }

  broadcast(obj) {
    for (const s of this.sockets) s.write(JSON.stringify(obj) + "\n");
  }

  async stop() {
    for (const s of this.sockets) s.destroy();
    await new Promise((r) => this.server.close(() => r()));
  }
}

function standardHandler(msg, send) {
  if (msg.type === "hello") send({ type: "welcome", id: msg.id, room_id: "!room:example.org" });
  else if (msg.type === "reply") send({ type: "ok", id: msg.id, held: msg.text === "early" });
  else if (msg.type === "vote" && msg.answer === "bad") send({ type: "error", id: msg.id, error: "no poll" });
  else if (typeof msg.id === "number") send({ type: "ok", id: msg.id });
}

test("hello/welcome and reply/ok", async () => {
  const file = sockPath();
  const d = new FakeDaemon(file, standardHandler);
  await d.start();
  const agent = connect({ name: "builder", client: "test/1", socketPath: file, configFile: noFile() });
  try {
    const info = await agent.ready();
    assert.equal(info.roomId, "!room:example.org");
    assert.equal(agent.connected, true);
    const hello = d.requests[0];
    assert.equal(hello.type, "hello");
    assert.equal(hello.name, "builder");
    assert.equal(hello.client, "test/1");
    assert.equal(typeof hello.instance, "string");
    assert.ok(hello.instance.length > 0);

    assert.deepEqual(await agent.reply("hi"), { held: false });
    assert.deepEqual(await agent.reply("early"), { held: true });
    await agent.status("working");
    await agent.ask("question?");
    await agent.poll("pick", ["a", "b"]);
    await agent.react("✅");
    await agent.reportUpdated("abc");
    await agent.reportUpdateFailed(new Error("boom"));
    await assert.rejects(agent.vote("bad"), (e) => e instanceof BridgeError && /no poll/.test(e.message));
    await assert.rejects(agent.poll("pick", ["only"]), RangeError);
    await assert.rejects(agent.poll("pick", ["a", ""]), TypeError);
    await assert.rejects(agent.vote(0), RangeError);
    await assert.rejects(agent.vote(1.5), RangeError);
    await assert.rejects(agent.reply(""), TypeError);

    await agent.vote(2);
    assert.equal(d.requests.at(-1).answer, "2");
    const types = d.requests.map((r) => r.type);
    assert.deepEqual(types, ["hello", "reply", "reply", "status", "ask", "poll", "react", "updated", "update_failed", "vote", "vote"]);
    assert.deepEqual(d.requests.at(-3), { type: "update_failed", id: d.requests.at(-3).id, error: "boom" });
    const ids = d.requests.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    agent.close();
    await d.stop();
  }
});

test("message, update and approval flow", async () => {
  const file = sockPath();
  const d = new FakeDaemon(file, standardHandler);
  await d.start();
  const agent = connect({ name: "builder", socketPath: file, configFile: noFile() });
  try {
    await agent.ready();
    const gotMsg = once(agent, "message");
    const gotUpdate = once(agent, "update");
    d.broadcast({ type: "message", kind: "text", text: "hello agent", sender: "@owner:example.org", via: "room", event_id: "$e1" });
    d.broadcast({ type: "message", text: "missing kind" });
    d.broadcast({ type: "message", kind: "bogus", text: "unknown kind", sender: "s", via: "room" });
    d.broadcast({ type: "update" });
    const [m] = await gotMsg;
    assert.equal(m.text, "hello agent");
    assert.equal(m.via, "room");
    await gotUpdate;

    const events = [];
    agent.on("approval_result", (r) => events.push(r));
    const pending = agent.requestApproval({ title: "Deploy?", detail: "to staging" });
    const req = await d.next((r) => r.type === "approval_request");
    assert.equal(req.title, "Deploy?");
    assert.equal(req.detail, "to staging");
    assert.equal(typeof req.request_id, "string");
    d.broadcast({ type: "approval_result", request_id: "other", decision: "allow" });
    d.broadcast({ type: "approval_result", request_id: req.request_id, decision: "deny" });
    assert.equal(await pending, "deny");
    assert.deepEqual(events, [
      { request_id: "other", decision: "allow" },
      { request_id: req.request_id, decision: "deny" },
    ]);

    const p2 = agent.requestApproval({ title: "Again", requestId: "fixed-1" });
    await d.next((r) => r.request_id === "fixed-1");
    d.broadcast({ type: "approval_result", request_id: "fixed-1", decision: "allow" });
    assert.equal(await p2, "allow");

    const p3 = agent.requestApproval({ title: "Odd", requestId: "fixed-2" });
    await d.next((r) => r.request_id === "fixed-2");
    d.broadcast({ type: "approval_result", request_id: "fixed-2", decision: "maybe" });
    assert.equal(await p3, "deny");

    await assert.rejects(agent.requestApproval({ title: "Slow", timeoutMs: 50 }), RequestTimeoutError);
  } finally {
    agent.close();
    await d.stop();
  }
});

test("request timeout rejects with Error", async () => {
  const file = sockPath();
  const d = new FakeDaemon(file, (msg, send) => {
    if (msg.type === "hello") send({ type: "welcome", id: msg.id, room_id: "!r:example.org" });
  });
  await d.start();
  const agent = connect({ name: "slow", socketPath: file, configFile: noFile(), requestTimeoutMs: 100 });
  try {
    await agent.ready();
    await assert.rejects(agent.status("x"), (e) => e instanceof RequestTimeoutError && /no answer/.test(e.message));
  } finally {
    agent.close();
    await d.stop();
  }
});

test("reconnects after daemon restart with the same instance", async () => {
  const file = sockPath();
  let d = new FakeDaemon(file, standardHandler);
  await d.start();
  const agent = connect({ name: "persistent", socketPath: file, configFile: noFile(), requestTimeoutMs: 300 });
  const errors = [];
  agent.on("error", (e) => errors.push(e));
  try {
    await agent.ready();
    const firstInstance = d.requests[0].instance;

    const disconnected = once(agent, "disconnected");
    await d.stop();
    await disconnected;
    assert.equal(agent.connected, false);
    await assert.rejects(agent.reply("while down"), (e) => e instanceof NotConnectedError && /not connected/.test(e.message));

    // A request issued while disconnected waits for the reconnect.
    const queued = agent.reply("queued");
    const reconnected = once(agent, "connected");
    rmSync(file, { force: true });
    d = new FakeDaemon(file, standardHandler);
    await d.start();
    const [info] = await reconnected;
    assert.deepEqual(await queued, { held: false });
    assert.equal(info.roomId, "!room:example.org");
    assert.equal(d.requests[0].type, "hello");
    assert.equal(d.requests[0].instance, firstInstance);
    assert.equal(d.requests[1].text, "queued");
    assert.deepEqual(await agent.reply("back"), { held: false });
  } finally {
    agent.close();
    await d.stop();
  }
});

test("rejected hello rejects ready()", async () => {
  const file = sockPath();
  const d = new FakeDaemon(file, (msg, send) => {
    if (msg.type === "hello") send({ type: "error", id: msg.id, error: "name in use" });
  });
  await d.start();
  const agent = connect({ name: "dup", socketPath: file, configFile: noFile() });
  agent.on("error", () => {});
  try {
    await assert.rejects(agent.ready(), (e) => e instanceof BridgeError && /rejected registration: name in use/.test(e.message));
  } finally {
    agent.close();
    await d.stop();
  }
});

test("close() rejects pending approvals and later calls", async () => {
  const file = sockPath();
  const d = new FakeDaemon(file, standardHandler);
  await d.start();
  const agent = connect({ name: "closer", socketPath: file, configFile: noFile() });
  await agent.ready();
  const pending = agent.requestApproval({ title: "never answered" });
  await d.next((r) => r.type === "approval_request");
  agent.close();
  await assert.rejects(pending, (e) => e instanceof NotConnectedError && /closed/.test(e.message));
  await assert.rejects(agent.reply("x"), /closed/);
  await d.stop();
});

test("without reconnect a drop rejects pending approvals and later calls", async () => {
  const file = sockPath();
  const d = new FakeDaemon(file, standardHandler);
  await d.start();
  const agent = connect({ name: "once", socketPath: file, configFile: noFile(), reconnect: false });
  agent.on("error", () => {});
  await agent.ready();
  const pending = agent.requestApproval({ title: "never answered" });
  await d.next((r) => r.type === "approval_request");
  await d.stop();
  await assert.rejects(pending, NotConnectedError);
  await assert.rejects(agent.reply("x"), NotConnectedError);
});

test("no daemon and no reconnect: ready() rejects with NotConnectedError", async () => {
  const agent = connect({ name: "lonely", socketPath: path.join(dir, "nope.sock"), configFile: noFile(), reconnect: false });
  agent.on("error", () => {});
  await assert.rejects(agent.ready(), (e) => e instanceof NotConnectedError && /cannot reach/.test(e.message));
});

test("option resolution: explicit, env, then file", () => {
  const cfg = path.join(dir, "client.env");
  writeFileSync(cfg, `# comment\nMXA_URL="wss://bridge.example.org/agent"\nMXA_MACHINE=laptop\nMXA_SECRET=${SECRET}\nOTHER=x\n`);
  const remote = resolveOptions({ name: "a", configFile: cfg });
  assert.equal(remote.mode, "remote");
  assert.equal(remote.url, "wss://bridge.example.org/agent");
  assert.equal(remote.machine, "laptop");

  process.env.MXA_MACHINE = "from-env";
  try {
    assert.equal(resolveOptions({ name: "a", configFile: cfg }).machine, "from-env");
    assert.equal(resolveOptions({ name: "a", configFile: cfg, machine: "explicit" }).machine, "explicit");
  } finally {
    delete process.env.MXA_MACHINE;
  }

  const local = resolveOptions({ name: "a", configFile: cfg, socketPath: "/tmp/explicit.sock" });
  assert.equal(local.mode, "local");
  assert.equal(local.url, undefined);
  assert.equal(local.socketPath, "/tmp/explicit.sock");
  assert.equal(resolveOptions({ name: "a", configFile: noFile() }).instance, local.instance);
  assert.throws(() => resolveOptions({ name: "" }), TypeError);
});

test("option resolution: incomplete remote settings are a configuration error", () => {
  assert.throws(
    () => resolveOptions({ name: "a", configFile: noFile(), url: "wss://bridge.example.org/agent", machine: "m" }),
    (e) => e instanceof ConfigError && e instanceof BridgeError && /MXA_MACHINE, MXA_SECRET/.test(e.message),
  );
  assert.throws(() => connect({ name: "a", configFile: noFile(), url: "wss://bridge.example.org/agent" }), ConfigError);
  assert.throws(
    () => resolveOptions({ name: "a", configFile: noFile(), url: "https://bridge.example.org", machine: "m", secret: SECRET }),
    ConfigError,
  );
  process.env.MXA_URL = "wss://bridge.example.org/agent";
  try {
    assert.throws(() => resolveOptions({ name: "a", configFile: noFile() }), ConfigError);
    process.env.MXA_SECRET = "";
    assert.throws(() => resolveOptions({ name: "a", configFile: noFile(), machine: "m" }), ConfigError);
  } finally {
    delete process.env.MXA_URL;
    delete process.env.MXA_SECRET;
  }
});

test("option resolution: default socket matches the daemon", () => {
  const saved = { ...process.env };
  try {
    process.env.XDG_RUNTIME_DIR = "/run/x";
    assert.equal(resolveOptions({ name: "a", configFile: noFile() }).socketPath, "/run/x/mxagent.sock");
    delete process.env.XDG_RUNTIME_DIR;
    process.env.XDG_STATE_HOME = "/s";
    delete process.env.MXA_STATE_DIR;
    assert.equal(resolveOptions({ name: "a", configFile: noFile() }).socketPath, "/s/mxagent/bridge.sock");
    process.env.MXA_STATE_DIR = "/st";
    assert.equal(resolveOptions({ name: "a", configFile: noFile() }).socketPath, "/st/bridge.sock");
    process.env.MXA_SOCKET_PATH = "/env.sock";
    assert.equal(resolveOptions({ name: "a", configFile: noFile() }).socketPath, "/env.sock");
  } finally {
    for (const k of ["XDG_RUNTIME_DIR", "XDG_STATE_HOME", "MXA_STATE_DIR", "MXA_SOCKET_PATH"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

/** Loopback WebSocket server whose behaviour per connection is up to the test. */
async function wsServer(onConnection) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wss, "listening");
  const conns = [];
  wss.on("connection", (ws) => {
    conns.push(ws);
    onConnection(ws, conns.length);
  });
  return {
    url: `ws://127.0.0.1:${wss.address().port}/`,
    conns,
    close: () => new Promise((r) => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => r());
    }),
  };
}

test("remote: a silent daemon hits the handshake timeout, then the client reconnects", async () => {
  const srv = await wsServer(() => {}); // accepts, reads the hello, never sends a challenge
  const agent = connect({ name: "r", url: srv.url, machine: "m", secret: SECRET, configFile: noFile(), handshakeTimeoutMs: 100 });
  const errors = [];
  agent.on("error", (e) => errors.push(e));
  try {
    const start = Date.now();
    while (srv.conns.length < 2 && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 20));
    assert.ok(srv.conns.length >= 2, "client did not reconnect after the handshake timeout");
    assert.ok(errors.some((e) => e.name === "AuthenticationError" && /handshake timed out/.test(e.message)));
    assert.equal(agent.connected, false);
  } finally {
    agent.close();
    await srv.close();
  }
});

test("remote: an oversized frame before authentication closes the link", async () => {
  const srv = await wsServer((ws) => ws.once("message", () => ws.send("x".repeat(1024 * 1024 + 1))));
  const agent = connect({ name: "r", url: srv.url, machine: "m", secret: SECRET, configFile: noFile(), reconnect: false });
  agent.on("error", () => {});
  try {
    await assert.rejects(agent.ready(), (e) => e.name === "AuthenticationError" && /too large/.test(e.message));
    const ws = srv.conns[0];
    if (ws.readyState !== ws.CLOSED) await once(ws, "close");
  } finally {
    agent.close();
    await srv.close();
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Loopback WebSocket daemon that runs the real secure handshake. `onLine(msg, send, ws)` gets
 * decrypted agent lines; `serverMac(nc, ns)` may return a wrong proof to impersonate the daemon.
 */
async function secureServer({ onLine = () => {}, serverMac } = {}) {
  return wsServer((ws) => {
    let cipher = null;
    let hs = null;
    ws.send_ = (obj) => ws.send(cipher.seal(JSON.stringify(obj) + "\n"));
    ws.on("message", (raw) => {
      const data = raw.toString();
      if (!hs) {
        const hello = JSON.parse(data);
        hs = { machine: hello.machine, nc: hello.nc, ns: nonce() };
        ws.send(JSON.stringify({ type: "challenge", ns: hs.ns }));
        return;
      }
      if (!cipher) {
        const msg = JSON.parse(data);
        if (!proofOk(SECRET, "client", hs.machine, hs.nc, hs.ns, msg.mac)) return ws.close(4003, "forbidden");
        cipher = new Cipher(SECRET, hs.machine, hs.nc, hs.ns, "server");
        const mac = serverMac ? serverMac(hs.nc, hs.ns) : proof(SECRET, "server", hs.machine, hs.nc, hs.ns);
        ws.send_({ type: "authed", mac });
        return;
      }
      for (const line of cipher.open(data).split("\n").filter(Boolean)) onLine(JSON.parse(line), ws.send_, ws);
    });
  });
}

const welcomeOnHello = (msg, send) => {
  if (msg.type === "hello") send({ type: "welcome", id: msg.id, room_id: "!r:example.org" });
  else if (typeof msg.id === "number") send({ type: "ok", id: msg.id });
};

test("remote: close 4003 is fatal: ready(), waiting calls and the error event get AuthenticationError", async () => {
  const srv = await wsServer((ws) => ws.once("message", () => ws.close(4003, "forbidden")));
  const agent = connect({ name: "r", url: srv.url, machine: "m", secret: SECRET, configFile: noFile() });
  const errors = [];
  agent.on("error", (e) => errors.push(e));
  try {
    const waiting = agent.reply("queued before welcome");
    await assert.rejects(agent.ready(), (e) => e instanceof AuthenticationError && /4003/.test(e.message));
    await assert.rejects(waiting, AuthenticationError);
    await assert.rejects(agent.status("later"), NotConnectedError);
    assert.ok(errors.some((e) => e instanceof AuthenticationError));
    await sleep(1200); // the normal backoff would have retried by now
    assert.equal(srv.conns.length, 1);
  } finally {
    agent.close();
    await srv.close();
  }
});

test("remote: a daemon that cannot prove the secret is fatal", async () => {
  const srv = await secureServer({ serverMac: () => "A".repeat(43) + "=" });
  const agent = connect({ name: "r", url: srv.url, machine: "m", secret: SECRET, configFile: noFile() });
  agent.on("error", () => {});
  try {
    await assert.rejects(agent.ready(), (e) => e instanceof AuthenticationError && /could not prove/.test(e.message));
    await sleep(1200);
    assert.equal(srv.conns.length, 1);
  } finally {
    agent.close();
    await srv.close();
  }
});

test("remote: retryAuthFailures keeps the agent open after 4003", async () => {
  const srv = await wsServer((ws) => ws.once("message", () => ws.close(4003, "forbidden")));
  const agent = connect({ name: "r", url: srv.url, machine: "m", secret: SECRET, configFile: noFile(), retryAuthFailures: true });
  const gotError = once(agent, "error");
  try {
    const [err] = await gotError;
    assert.ok(err instanceof AuthenticationError);
    let settled = false;
    agent.ready().then(() => (settled = true), () => (settled = true));
    await sleep(1200);
    assert.equal(settled, false, "ready() must keep waiting");
    assert.equal(srv.conns.length, 1, "auth retries must be throttled to at most one per minute");
  } finally {
    agent.close();
    await srv.close();
  }
});

test("remote: close 4029 is not fatal: the agent stays open and waits at least a minute", async () => {
  const srv = await wsServer((ws) => ws.once("message", () => ws.close(4029, "try later")));
  const agent = connect({ name: "r", url: srv.url, machine: "m", secret: SECRET, configFile: noFile() });
  const gotError = once(agent, "error");
  try {
    const [err] = await gotError;
    assert.ok(err instanceof NotConnectedError && !(err instanceof AuthenticationError));
    assert.match(err.message, /4029/);
    let settled = false;
    agent.ready().then(() => (settled = true), () => (settled = true));
    await sleep(1200); // the normal backoff would have retried by now
    assert.equal(settled, false, "ready() must keep waiting");
    assert.equal(srv.conns.length, 1, "4029 must be retried slowly");
  } finally {
    agent.close();
    await srv.close();
  }
});

test("remote: full handshake, then a silent link is closed and re-opened; heartbeats keep it alive", async () => {
  let beat = true;
  const srv = await secureServer({ onLine: welcomeOnHello });
  const timers = [];
  const agent = connect({ name: "r", url: srv.url, machine: "m", secret: SECRET, configFile: noFile(), deadLinkTimeoutMs: 400 });
  const errors = [];
  agent.on("error", (e) => errors.push(e));
  try {
    await agent.ready();
    const ws = srv.conns[0];
    timers.push(setInterval(() => beat && ws.readyState === ws.OPEN && ws.send_({ type: "heartbeat" }), 100));
    await sleep(900);
    assert.equal(agent.connected, true, "heartbeats must keep the link alive");
    assert.equal(srv.conns.length, 1);
    await agent.status("still here");

    const disconnected = new Promise((r) => agent.once("disconnected", r));
    beat = false;
    await disconnected;
    assert.ok(errors.some((e) => e instanceof NotConnectedError && /link considered dead/.test(e.message)));
    await new Promise((r) => agent.once("connected", r));
    assert.equal(srv.conns.length, 2);
  } finally {
    timers.forEach(clearInterval);
    agent.close();
    await srv.close();
  }
});

test("local: a silent link is closed and re-opened; heartbeats keep it alive", async () => {
  const file = sockPath();
  const d = new FakeDaemon(file, standardHandler);
  await d.start();
  let beat = true;
  const timer = setInterval(() => beat && d.broadcast({ type: "heartbeat" }), 100);
  const agent = connect({ name: "quiet", socketPath: file, configFile: noFile(), deadLinkTimeoutMs: 400 });
  const errors = [];
  agent.on("error", (e) => errors.push(e));
  try {
    await agent.ready();
    await sleep(900);
    assert.equal(agent.connected, true);
    assert.equal(d.requests.filter((r) => r.type === "hello").length, 1);

    const disconnected = new Promise((r) => agent.once("disconnected", r));
    beat = false;
    await disconnected;
    assert.ok(errors.some((e) => e instanceof NotConnectedError && /link considered dead/.test(e.message)));
    await new Promise((r) => agent.once("connected", r));
    assert.equal(d.requests.filter((r) => r.type === "hello").length, 2);
  } finally {
    clearInterval(timer);
    agent.close();
    await d.stop();
  }
});

test("a request queued while connecting rejects with NotConnectedError if the link drops right after welcome", async () => {
  const file = sockPath();
  const d = new FakeDaemon(file, standardHandler);
  await d.start();
  const agent = connect({ name: "racy", socketPath: file, configFile: noFile(), requestTimeoutMs: 5000 });
  agent.on("error", () => {});
  // A throwing listener drops the link synchronously, after ready waiters were resolved.
  agent.once("connected", () => {
    throw new Error("listener failed");
  });
  try {
    const started = Date.now();
    await assert.rejects(agent.reply("queued"), (e) => e instanceof NotConnectedError && /lost/.test(e.message));
    assert.ok(Date.now() - started < 4000, "must not wait for the request timeout");
    assert.equal(d.requests.some((r) => r.type === "reply"), false);
    await agent.ready();
    assert.deepEqual(await agent.reply("after"), { held: false });
  } finally {
    agent.close();
    await d.stop();
  }
});

test("requestApproval sends approval_cancel on timeout and on abort, and validates requestId", async () => {
  const file = sockPath();
  const d = new FakeDaemon(file, standardHandler);
  await d.start();
  const agent = connect({ name: "approver", socketPath: file, configFile: noFile() });
  try {
    await agent.ready();
    await assert.rejects(agent.requestApproval({ title: "Slow", requestId: "t-1", timeoutMs: 50 }), RequestTimeoutError);
    assert.deepEqual(await d.next((r) => r.type === "approval_cancel"), { type: "approval_cancel", id: d.requests.at(-1).id, request_id: "t-1" });

    const ac = new AbortController();
    const p = agent.requestApproval({ title: "Abort me", requestId: "a-1", signal: ac.signal });
    await d.next((r) => r.type === "approval_request" && r.request_id === "a-1");
    ac.abort();
    await assert.rejects(p, (e) => e.name === "AbortError");
    await d.next((r) => r.type === "approval_cancel" && r.request_id === "a-1");

    // A decision before the timeout sends no cancel.
    const before = d.requests.length;
    const p2 = agent.requestApproval({ title: "Quick", requestId: "q-1", timeoutMs: 2000, signal: new AbortController().signal });
    await d.next((r) => r.request_id === "q-1");
    d.broadcast({ type: "approval_result", request_id: "q-1", decision: "allow" });
    assert.equal(await p2, "allow");
    await agent.status("sync");
    assert.equal(d.requests.slice(before).some((r) => r.type === "approval_cancel"), false);

    const n = d.requests.length;
    await assert.rejects(agent.requestApproval({ title: "x", signal: AbortSignal.abort() }), (e) => e.name === "AbortError");
    await assert.rejects(agent.requestApproval({ title: "x", requestId: "" }), TypeError);
    await assert.rejects(agent.requestApproval({ title: "x", requestId: 5 }), TypeError);
    await assert.rejects(agent.requestApproval({ title: "x", requestId: "r".repeat(201) }), RangeError);
    await assert.rejects(agent.requestApproval({ title: "x", timeoutMs: -1 }), RangeError);
    assert.equal(d.requests.length, n, "invalid calls must not reach the daemon");
  } finally {
    agent.close();
    await d.stop();
  }
});

test("option resolution: URL, machine, secret and timeouts are validated up front", () => {
  const base = { name: "a", configFile: noFile(), machine: "m", secret: SECRET };
  assert.equal(resolveOptions({ ...base, url: "wss://bridge.example.org:8443/agent" }).mode, "remote");
  for (const url of ["wss://bridge example.org/", "wss://bridge.example.org:99999/", "ws//bridge.example.org", "http://bridge.example.org/"]) {
    assert.throws(() => resolveOptions({ ...base, url }), ConfigError, url);
  }
  const url = "wss://bridge.example.org/";
  for (const secret of ["short", SECRET + " ", ` ${SECRET}`, SECRET.replace("_", "+"), "a".repeat(257)]) {
    assert.throws(() => resolveOptions({ ...base, url, secret }), (e) => e instanceof ConfigError && /MXA_SECRET/.test(e.message));
  }
  assert.equal(resolveOptions({ ...base, url, secret: "a".repeat(32) }).secret, "a".repeat(32));
  assert.throws(() => resolveOptions({ ...base, url, machine: "Laptop" }), (e) => e instanceof ConfigError && /MXA_MACHINE/.test(e.message));
  assert.throws(() => connect({ ...base, url, secret: "short" }), ConfigError);
  for (const key of ["requestTimeoutMs", "handshakeTimeoutMs", "deadLinkTimeoutMs"]) {
    assert.throws(() => resolveOptions({ name: "a", configFile: noFile(), [key]: 0 }), ConfigError);
    assert.throws(() => resolveOptions({ name: "a", configFile: noFile(), [key]: "100" }), ConfigError);
  }
  const d = resolveOptions({ name: "a", configFile: noFile() });
  assert.equal(d.deadLinkTimeoutMs, 75_000);
  assert.equal(d.retryAuthFailures, false);
});

test("line splitter: split and joined lines, limit", () => {
  const lines = [];
  const feed = lineSplitter((l) => lines.push(l), 10);
  feed('{"a":1}\n{"b"');
  feed(":2}\n\n  \n");
  feed("x");
  feed("y\nz");
  feed("\n");
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', "xy", "z"]);
  assert.throws(() => feed("0123456789A"), /too long/);
  feed("ok\n");
  assert.throws(() => feed("01234\n0123456789A\n"), /too long/);
  feed("123456");
  assert.throws(() => feed("78901\n"), /too long/);
  feed("fine\n");
  assert.deepEqual(lines.slice(4), ["ok", "01234", "fine"]);
});

test("line splitter: a 25 MiB line in 64 KiB chunks is linear", () => {
  const chunk = "A".repeat(64 * 1024);
  const count = Math.ceil((25 * 1024 * 1024) / chunk.length);
  let got = 0;
  const feed = lineSplitter((l) => (got = l.length), 64 * 1024 * 1024);
  let slowest = 0;
  const start = performance.now();
  for (let i = 0; i <= count; i++) {
    const t = performance.now();
    feed(i === count ? "\n" : chunk);
    slowest = Math.max(slowest, performance.now() - t);
  }
  const total = performance.now() - start;
  assert.equal(got, count * chunk.length);
  // The old quadratic splitter needed over a second here; linear takes a few milliseconds.
  assert.ok(total < 500, `took ${total.toFixed(0)} ms`);
  assert.ok(slowest < 200, `slowest chunk took ${slowest.toFixed(0)} ms`);
});
