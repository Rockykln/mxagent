// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { Cipher, newSecret, nonce, proof, proofOk } from "../src/protocol/secure.ts";
import { configFromVars } from "../src/daemon/config.ts";
import { createLogger, silentLogger } from "../src/daemon/log.ts";
import { MachineStore, machinesFile, parseMachines } from "../src/daemon/machines.ts";
import { LineSplitter, socketConnection, type Connection } from "../src/daemon/transport/link.ts";
import { probeSocket, startLocal } from "../src/daemon/transport/local.ts";
import { clientAddress, parseForwardedAddress, startWebSocket, type WebSocketOptions } from "../src/daemon/transport/websocket.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mxagent-transport-"));
}

function nextEvent<T = unknown>(cb: (resolve: (v: T) => void) => void, ms = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    cb((v) => {
      clearTimeout(t);
      resolve(v);
    });
  });
}

// ---------- link ----------

test("LineSplitter: split lines, skip invalid JSON, enforce max line", () => {
  const got: unknown[] = [];
  const s = new LineSplitter((o) => got.push(o), 20);
  assert.equal(s.push('{"a":1}\n{bad}\n\n{"b"'), true);
  assert.equal(s.push(':2}\r\n'), true);
  assert.deepEqual(got, [{ a: 1 }, { b: 2 }]);
  assert.equal(s.push("x".repeat(21)), false);
});

// ---------- machines ----------

test("machines: add, lookup, reload on external change, remove, 0600", () => {
  const dir = tmpDir();
  const file = machinesFile({ configDir: dir });
  assert.equal(file, path.join(dir, "machines"));
  const store = new MachineStore(file);
  assert.equal(store.secretFor("laptop"), undefined);
  const secret = store.addMachine("laptop");
  assert.equal(store.secretFor("laptop"), secret);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => store.addMachine("laptop"));
  assert.throws(() => store.addMachine("Bad Name"));
  assert.throws(() => store.addMachine("x".repeat(33)));

  // a second store (e.g. mxagentctl) changes the file; the first one sees it without restart
  const other = new MachineStore(file);
  const s2 = other.addMachine("build-01");
  assert.deepEqual(store.listMachines(), ["build-01", "laptop"]);
  assert.equal(store.secretFor("build-01"), s2);
  assert.equal(other.removeMachine("laptop"), true);
  assert.equal(store.secretFor("laptop"), undefined);
  assert.equal(store.removeMachine("laptop"), false);
  assert.equal(store.secretFor("../etc"), undefined);
  assert.equal(store.secretFor(42), undefined);
});

test("machines: parser ignores malformed lines", () => {
  const good = newSecret();
  const m = parseMachines(`# comment\n\nok ${good}\nBAD ${good}\nshort abc\nthree a b\nok ${newSecret()}\n`);
  assert.deepEqual([...m], [["ok", good]]);
});

// ---------- local ----------

test("local: NDJSON round trip, mode 0600, stale socket removed", async () => {
  const dir = tmpDir();
  const socketPath = path.join(dir, "bridge.sock");
  // stale socket file left by a crashed process
  const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(socketPath)})`]);
  while (!fs.existsSync(socketPath)) await new Promise((r) => setTimeout(r, 20));
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  assert.equal(fs.lstatSync(socketPath).isSocket(), true);

  const conns: Connection[] = [];
  const server = await startLocal({
    socketPath,
    log: silentLogger,
    onConnection: (c) => {
      conns.push(c);
      c.onLine((obj) => c.write(JSON.stringify({ echo: obj })));
    },
  });
  try {
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
    const client = net.connect(socketPath);
    client.setEncoding("utf8");
    let buf = "";
    const lines = nextEvent<string[]>((resolve) => {
      client.on("data", (d: string) => {
        buf += d;
        const parts = buf.split("\n").filter(Boolean);
        if (parts.length >= 2) resolve(parts);
      });
    });
    client.write('{"type":"hello","name":"a"}\nnot json\n{"type":"st');
    client.write('atus","text":"ñ"}\n');
    assert.deepEqual(
      (await lines).map((l) => JSON.parse(l)),
      [{ echo: { type: "hello", name: "a" } }, { echo: { type: "status", text: "ñ" } }],
    );
    assert.equal(conns[0]!.machine, "local");
    assert.equal(conns[0]!.alive(), true);
    const closed = nextEvent<void>((r) => conns[0]!.onClose(r));
    client.end();
    await closed;
    assert.equal(conns[0]!.alive(), false);
  } finally {
    await server.close();
  }
  assert.equal(fs.existsSync(socketPath), false);
});

test("local: refuses a socket that is in use", async () => {
  const dir = tmpDir();
  const socketPath = path.join(dir, "bridge.sock");
  const a = await startLocal({ socketPath, log: silentLogger, onConnection: () => {} });
  try {
    await assert.rejects(startLocal({ socketPath, log: silentLogger, onConnection: () => {} }), /in use/);
  } finally {
    await a.close();
  }
});

// ---------- websocket ----------

interface Client {
  ws: WebSocket;
  frames: string[];
  next(): Promise<string>;
  closed: Promise<number>;
}

async function openClient(port: number, headers: Record<string, string> = {}, autoPong = true): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers, autoPong });
  const frames: string[] = [];
  const waiters: ((s: string) => void)[] = [];
  ws.on("message", (d) => {
    const s = String(d);
    const w = waiters.shift();
    if (w) w(s);
    else frames.push(s);
  });
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  ws.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return {
    ws,
    frames,
    closed,
    next: () => {
      const f = frames.shift();
      if (f !== undefined) return Promise.resolve(f);
      return nextEvent<string>((r) => waiters.push(r));
    },
  };
}

async function handshake(c: Client, machine: string, secret: string) {
  const nc = nonce();
  c.ws.send(JSON.stringify({ type: "hello", machine, nc }));
  const challenge = JSON.parse(await c.next());
  assert.equal(challenge.type, "challenge");
  assert.match(challenge.ns, /^[A-Za-z0-9+/]{22}==$/);
  const ns: string = challenge.ns;
  c.ws.send(JSON.stringify({ type: "proof", mac: proof(secret, "client", machine, nc, ns) }));
  return { nc, ns, cipher: new Cipher(secret, machine, nc, ns, "client") };
}

async function withServer(
  extra: Partial<WebSocketOptions>,
  fn: (ctx: { port: number; secret: string; conns: Connection[]; health: { ok: boolean } }) => Promise<void>,
) {
  const secret = newSecret();
  const conns: Connection[] = [];
  const health = { ok: true };
  const srv = await startWebSocket({
    host: "127.0.0.1",
    port: 0,
    log: silentLogger,
    healthy: () => health.ok,
    secretFor: (m) => (m === "laptop" ? secret : undefined),
    onConnection: (c) => {
      conns.push(c);
      c.onLine((obj) => c.write(JSON.stringify({ echo: obj })));
    },
    ...extra,
  });
  try {
    await fn({ port: srv.port, secret, conns, health });
  } finally {
    await srv.close();
  }
}

test("websocket: handshake, mutual auth, encrypted NDJSON round trip", async () => {
  await withServer({}, async ({ port, secret, conns }) => {
    const c = await openClient(port);
    const { nc, ns, cipher } = await handshake(c, "laptop", secret);
    const authed = JSON.parse(cipher.open(await c.next()));
    assert.equal(authed.type, "authed");
    assert.equal(authed.machine, "laptop");
    assert.equal(proofOk(secret, "server", "laptop", nc, ns, authed.mac), true);

    c.ws.send(cipher.seal('{"type":"hello","name":"a"}\n{"type":"status","text":"x"}\n'));
    const r1 = JSON.parse(cipher.open(await c.next()));
    const r2 = JSON.parse(cipher.open(await c.next()));
    assert.deepEqual([r1, r2], [{ echo: { type: "hello", name: "a" } }, { echo: { type: "status", text: "x" } }]);
    assert.equal(conns.length, 1);
    assert.equal(conns[0]!.machine, "laptop");
    assert.equal(conns[0]!.alive(), true);

    const closed = nextEvent<void>((r) => conns[0]!.onClose(r));
    c.ws.close();
    await closed;
    assert.equal(conns[0]!.alive(), false);
  });
});

test("websocket: wrong secret closes with 4003", async () => {
  await withServer({}, async ({ port, conns }) => {
    const c = await openClient(port);
    await handshake(c, "laptop", newSecret());
    assert.equal(await c.closed, 4003);
    assert.equal(conns.length, 0);
  });
});

test("websocket: a proof for another machine name is refused even with the same secret", async () => {
  await withServer({}, async ({ port, secret, conns }) => {
    const c = await openClient(port);
    const nc = nonce();
    c.ws.send(JSON.stringify({ type: "hello", machine: "laptop", nc }));
    const { ns } = JSON.parse(await c.next());
    // proof computed for "desktop" with the right secret and nonces, sent on a "laptop" hello
    c.ws.send(JSON.stringify({ type: "proof", mac: proof(secret, "client", "desktop", nc, ns) }));
    assert.equal(await c.closed, 4003);
    assert.equal(conns.length, 0);
  });
});

test("websocket: unknown machine gets a challenge, then 4003", async () => {
  await withServer({}, async ({ port, conns }) => {
    const c = await openClient(port);
    await handshake(c, "nobody", newSecret()); // asserts that a well-formed challenge arrives
    assert.equal(await c.closed, 4003);
    assert.equal(conns.length, 0);
  });
});

test("websocket: malformed hello closes with 4003, a handshake timeout with 4029", async () => {
  await withServer({ handshakeTimeoutMs: 200 }, async ({ port }) => {
    const a = await openClient(port);
    a.ws.send(JSON.stringify({ type: "hello", machine: "laptop", nc: "short" }));
    assert.equal(await a.closed, 4003);
    const b = await openClient(port);
    assert.equal(await b.closed, 4029);
  });
});

test("websocket: rate limit locks an address out after repeated failures (4029)", async () => {
  await withServer({ maxFailures: 3 }, async ({ port, secret, conns }) => {
    for (let i = 0; i < 3; i++) {
      const c = await openClient(port);
      await handshake(c, "laptop", newSecret());
      assert.equal(await c.closed, 4003);
    }
    // even the right secret is refused now, without a challenge
    const c = await openClient(port);
    c.ws.send(JSON.stringify({ type: "hello", machine: "laptop", nc: nonce() }));
    assert.equal(await c.closed, 4029);
    assert.equal(c.frames.length, 0);
    assert.equal(conns.length, 0);
    void secret;
  });
});

test("websocket: proxy headers are only trusted when enabled", async () => {
  await withServer({ maxFailures: 1, trustProxyHeader: "x-forwarded-for" }, async ({ port, secret, conns }) => {
    const bad = await openClient(port, { "X-Forwarded-For": "198.51.100.7" });
    await handshake(bad, "laptop", newSecret());
    assert.equal(await bad.closed, 4003);
    // a different forwarded address is not locked out
    const good = await openClient(port, { "X-Forwarded-For": "198.51.100.8" });
    const { cipher } = await handshake(good, "laptop", secret);
    assert.equal(JSON.parse(cipher.open(await good.next())).type, "authed");
    assert.equal(conns.length, 1);
    good.ws.close();
  });
  await withServer({ maxFailures: 1 }, async ({ port, secret }) => {
    const bad = await openClient(port, { "X-Forwarded-For": "198.51.100.7" });
    await handshake(bad, "laptop", newSecret());
    assert.equal(await bad.closed, 4003);
    // header ignored: same socket address, locked out
    const again = await openClient(port, { "X-Forwarded-For": "198.51.100.8" });
    again.ws.send(JSON.stringify({ type: "hello", machine: "laptop", nc: nonce() }));
    assert.equal(await again.closed, 4029);
    void secret;
  });
});

test("websocket: /health codes and 426 for other requests", async () => {
  await withServer({}, async ({ port, health }) => {
    let r = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "ok");
    assert.equal(r.headers.get("cache-control"), "no-store");
    health.ok = false;
    r = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(r.status, 503);
    assert.equal(await r.text(), "stale");
    assert.equal(r.headers.get("cache-control"), "no-store");
    r = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(r.status, 426);
    await r.arrayBuffer();
    r = await fetch(`http://127.0.0.1:${port}/health`, { method: "POST" });
    assert.equal(r.status, 426);
    await r.arrayBuffer();
  });
});

test("websocket: tampered frame closes the link", async () => {
  await withServer({}, async ({ port, secret, conns }) => {
    const c = await openClient(port);
    const { cipher } = await handshake(c, "laptop", secret);
    await c.next(); // authed
    const frame = Buffer.from(cipher.seal('{"type":"status","text":"x"}\n'), "base64");
    frame[12] = frame[12]! ^ 0x01;
    c.ws.send(frame.toString("base64"));
    await c.closed;
    assert.equal(conns.length, 1);
    await nextEvent<void>((r) => conns[0]!.onClose(r));
    assert.equal(conns[0]!.alive(), false);
  });
});

test("websocket: replayed frame closes the link", async () => {
  await withServer({}, async ({ port, secret, conns }) => {
    const c = await openClient(port);
    const { cipher } = await handshake(c, "laptop", secret);
    await c.next();
    const frame = cipher.seal('{"type":"status"}\n');
    c.ws.send(frame);
    await c.next();
    c.ws.send(frame);
    await c.closed;
    await nextEvent<void>((r) => conns[0]!.onClose(r));
  });
});

test("websocket: oversized inbound frame is rejected", async () => {
  await withServer({}, async ({ port, secret }) => {
    const c = await openClient(port);
    const { cipher } = await handshake(c, "laptop", secret);
    await c.next();
    c.ws.send(cipher.seal(JSON.stringify({ type: "reply", text: "x".repeat(1024 * 1024) }) + "\n"));
    assert.equal(await c.closed, 1009);
  });
});

test("websocket: dead links are dropped, revoked secrets close links", async () => {
  let now = 1_000_000;
  let current: string | undefined;
  await withServer(
    {
      pingIntervalMs: 50,
      aliveMs: 1000,
      now: () => now,
      secretFor: (m) => (m === "laptop" ? current : undefined),
    },
    async ({ port, conns }) => {
      current = newSecret();
      const c = await openClient(port, {}, false);
      const { cipher } = await handshake(c, "laptop", current);
      await c.next();
      void cipher;
      assert.equal(conns[0]!.alive(), true);
      now += 5000; // no pong within aliveMs (the clock is frozen for pongs too)
      assert.equal(conns[0]!.alive(), false);
      await c.closed;

      const d = await openClient(port);
      await handshake(d, "laptop", current);
      await d.next();
      current = undefined; // remove-machine
      await d.closed;
      assert.equal(conns.length, 2);
    },
  );
});

test("websocket: pending handshakes are capped per address and in total", async () => {
  await withServer({ trustProxyHeader: "x-forwarded-for", maxPendingPerAddress: 2, maxPendingTotal: 3 }, async ({ port, secret, conns }) => {
    const from = (ip: string) => openClient(port, { "X-Forwarded-For": ip });
    const a1 = await from("198.51.100.1");
    const a2 = await from("198.51.100.1");
    const a3 = await from("198.51.100.1"); // third pending handshake from one address
    assert.equal(await a3.closed, 4029);
    assert.equal(a3.frames.length, 0);

    const b1 = await from("198.51.100.2");
    const c1 = await from("198.51.100.3"); // total limit reached
    assert.equal(await c1.closed, 4029);
    assert.equal(c1.frames.length, 0);

    // pending ones still work; finishing a handshake frees its slot
    const { cipher } = await handshake(a1, "laptop", secret);
    assert.equal(JSON.parse(cipher.open(await a1.next())).type, "authed");
    const c2 = await from("198.51.100.3");
    const second = await handshake(c2, "laptop", secret);
    assert.equal(JSON.parse(second.cipher.open(await c2.next())).type, "authed");
    assert.equal(conns.length, 2);
    for (const c of [a1, a2, b1, c2]) c.ws.close();
  });
});

test("websocket: rate-limit key groups IPv6 by /64 and unmaps IPv4", async () => {
  const { rateLimitKey } = await import("../src/daemon/transport/websocket.ts");
  assert.equal(rateLimitKey("198.51.100.7"), "198.51.100.7");
  assert.equal(rateLimitKey("::ffff:198.51.100.7"), "198.51.100.7");
  assert.equal(rateLimitKey("2001:db8:1:2:aaaa::1"), rateLimitKey("2001:db8:1:2:bbbb:cccc:dddd:eeee"));
  assert.notEqual(rateLimitKey("2001:db8:1:2::1"), rateLimitKey("2001:db8:1:3::1"));
  assert.equal(rateLimitKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(rateLimitKey("::1"), "0:0:0:0::/64");
  assert.equal(rateLimitKey("unknown"), "unknown");
});

// ---------- proxy header, lockout, caps ----------

function fakeReq(headers: Record<string, string | string[]>, remote = "203.0.113.9") {
  return { headers, socket: { remoteAddress: remote } } as unknown as Parameters<typeof clientAddress>[0];
}

test("MXA_TRUST_PROXY_HEADER: modes, invalid value, removed boolean key", () => {
  const base = {
    MXA_HOMESERVER: "https://matrix.example.org",
    MXA_BOT_USER: "@bot:example.org",
    MXA_OWNER: "@owner:example.org",
    MXA_SPACE_ID: "!space:example.org",
  };
  const env = { XDG_RUNTIME_DIR: "/run/user/1000" };
  assert.equal(configFromVars(base, env).trustProxyHeader, "none");
  assert.equal(configFromVars({ ...base, MXA_TRUST_PROXY_HEADER: "X-Forwarded-For" }, env).trustProxyHeader, "x-forwarded-for");
  assert.equal(configFromVars({ ...base, MXA_TRUST_PROXY_HEADER: "cf-connecting-ip" }, env).trustProxyHeader, "cf-connecting-ip");
  assert.throws(() => configFromVars({ ...base, MXA_TRUST_PROXY_HEADER: "true" }, env), /must be one of none, cf-connecting-ip, x-forwarded-for/);
  assert.throws(() => configFromVars({ ...base, MXA_TRUST_PROXY_HEADERS: "true" }, env), /did you mean MXA_TRUST_PROXY_HEADER/);
});

test("clientAddress: reads only the configured header, strips ports and brackets", () => {
  const both = { "cf-connecting-ip": "198.51.100.1", "x-forwarded-for": "10.0.0.1, 198.51.100.2" };
  assert.equal(clientAddress(fakeReq(both), "none"), "203.0.113.9");
  assert.equal(clientAddress(fakeReq(both), "x-forwarded-for"), "198.51.100.2"); // forged CF header ignored
  assert.equal(clientAddress(fakeReq(both), "cf-connecting-ip"), "198.51.100.1");
  assert.equal(clientAddress(fakeReq({ "x-forwarded-for": "198.51.100.1" }), "cf-connecting-ip"), "203.0.113.9");
  assert.equal(clientAddress(fakeReq({ "x-forwarded-for": ["1.1.1.1", "198.51.100.3:4567"] }), "x-forwarded-for"), "198.51.100.3");
  assert.equal(clientAddress(fakeReq({ "x-forwarded-for": "[2001:db8::1]:443" }), "x-forwarded-for"), "2001:db8::1");
  assert.equal(clientAddress(fakeReq({ "x-forwarded-for": "garbage" }), "x-forwarded-for"), "203.0.113.9");
  assert.equal(parseForwardedAddress("[2001:db8::2]"), "2001:db8::2");
  assert.equal(parseForwardedAddress("2001:db8::3"), "2001:db8::3");
  assert.equal(parseForwardedAddress("unknown"), undefined);
});

async function failProof(port: number, machine = "laptop", headers: Record<string, string> = {}) {
  const c = await openClient(port, headers);
  await handshake(c, machine, newSecret());
  assert.equal(await c.closed, 4003);
}

async function goodLogin(port: number, secret: string, headers: Record<string, string> = {}) {
  const c = await openClient(port, headers);
  const { cipher } = await handshake(c, "laptop", secret);
  assert.equal(JSON.parse(cipher.open(await c.next())).type, "authed");
  return c;
}

test("websocket: a successful handshake resets the failure counter", async () => {
  await withServer({ maxFailures: 3 }, async ({ port, secret }) => {
    await failProof(port);
    await failProof(port);
    (await goodLogin(port, secret)).ws.close();
    await failProof(port);
    await failProof(port);
    (await goodLogin(port, secret)).ws.close(); // would be locked out without the reset (4 failures)
  });
});

test("websocket: closes and timeouts during the handshake count once per window", async () => {
  await withServer({ maxFailures: 2, helloTimeoutMs: 50 }, async ({ port, secret }) => {
    for (let i = 0; i < 3; i++) {
      const c = await openClient(port);
      c.ws.close();
      await c.closed;
    }
    const idle = await openClient(port);
    assert.equal(await idle.closed, 4029); // hello timeout
    await new Promise((r) => setTimeout(r, 50));
    (await goodLogin(port, secret)).ws.close();
  });
});

test("websocket: repeated idle handshakes hit the soft limit and lock the address out (4029)", async () => {
  await withServer({ maxFailures: 10, maxSoftFailures: 3, helloTimeoutMs: 30 }, async ({ port, secret }) => {
    for (let i = 0; i < 3; i++) {
      const idle = await openClient(port);
      assert.equal(await idle.closed, 4029);
    }
    // the address is locked now, even for the right secret: refused before the challenge
    const c = await openClient(port);
    c.ws.send(JSON.stringify({ type: "hello", machine: "laptop", nc: nonce() }));
    assert.equal(await c.closed, 4029);
    assert.equal(c.frames.length, 0);
    void secret;
  });
  await withServer({ maxFailures: 10, maxSoftFailures: 2, helloTimeoutMs: 30 }, async ({ port, secret }) => {
    (await goodLogin(port, secret)).ws.close();
    for (let i = 0; i < 2; i++) assert.equal(await (await openClient(port)).closed, 4029);
    // a machine that authenticated from this address before still gets in, others do not
    const other = await openClient(port);
    other.ws.send(JSON.stringify({ type: "hello", machine: "nobody", nc: nonce() }));
    assert.equal(await other.closed, 4029);
    (await goodLogin(port, secret)).ws.close();
  });
});

test("websocket: an address lockout spares machines that authenticated from there", async () => {
  await withServer({ maxFailures: 2 }, async ({ port, secret }) => {
    (await goodLogin(port, secret)).ws.close();
    await failProof(port, "nobody");
    await failProof(port, "nobody");
    // locked for other machines: refused at hello, no challenge
    const other = await openClient(port);
    other.ws.send(JSON.stringify({ type: "hello", machine: "nobody", nc: nonce() }));
    assert.equal(await other.closed, 4029);
    assert.equal(other.frames.length, 0);
    // the known machine still gets in
    (await goodLogin(port, secret)).ws.close();
  });
  await withServer({ maxFailures: 2 }, async ({ port, secret }) => {
    (await goodLogin(port, secret)).ws.close();
    await failProof(port, "laptop");
    await failProof(port, "laptop"); // wrong secret for the trusted machine itself: its own budget is used up too
    const c = await openClient(port);
    c.ws.send(JSON.stringify({ type: "hello", machine: "laptop", nc: nonce() }));
    assert.equal(await c.closed, 4029);
    assert.equal(c.frames.length, 0);
    void secret;
  });
});

test("websocket: a full failure table never evicts active lockouts", async () => {
  const xff = (ip: string) => ({ "X-Forwarded-For": ip });
  await withServer({ trustProxyHeader: "x-forwarded-for", maxFailures: 2, maxTrackedAddresses: 2 }, async ({ port }) => {
    await failProof(port, "laptop", xff("198.51.100.1")); // A: 1 failure
    await failProof(port, "laptop", xff("198.51.100.2"));
    await failProof(port, "laptop", xff("198.51.100.2")); // B: locked
    await failProof(port, "laptop", xff("198.51.100.3")); // C evicts A, not B
    await failProof(port, "laptop", xff("198.51.100.4")); // table full of {B locked, C}: evicts C
    const b = await openClient(port, xff("198.51.100.2"));
    b.ws.send(JSON.stringify({ type: "hello", machine: "laptop", nc: nonce() }));
    assert.equal(await b.closed, 4029);
    assert.equal(b.frames.length, 0);
  });
});

test("websocket: global connection cap and per-machine link cap", async () => {
  await withServer({ maxConnections: 2 }, async ({ port }) => {
    const a = await openClient(port);
    const b = await openClient(port);
    const c = await openClient(port);
    assert.equal(await c.closed, 4029); // try later
    a.ws.close();
    b.ws.close();
  });
  await withServer({ maxLinksPerMachine: 1 }, async ({ port, secret, conns }) => {
    const first = await goodLogin(port, secret);
    const second = await openClient(port);
    await handshake(second, "laptop", secret);
    assert.equal(await second.closed, 4029);
    assert.equal(conns.length, 1);
    const closed = nextEvent<void>((r) => conns[0]!.onClose(r));
    first.ws.close();
    await closed;
    (await goodLogin(port, secret)).ws.close(); // slot free again
  });
});

// ---------- machines file robustness ----------

function captureLogger() {
  const warns: string[] = [];
  return { warns, log: createLogger("warn", { sink: (_l, line) => warns.push(line) }) };
}

test("machines: read errors keep the last good list; a missing file revokes after the grace period", () => {
  const dir = tmpDir();
  const file = machinesFile({ configDir: dir });
  let now = 1000;
  const store = new MachineStore(file, { now: () => now, missingGraceMs: 500, log: silentLogger });
  const secret = store.addMachine("laptop");
  assert.equal(store.secretFor("laptop"), secret);
  if (process.getuid?.() !== 0) {
    fs.chmodSync(file, 0o000);
    assert.equal(store.secretFor("laptop"), secret); // EACCES
    fs.chmodSync(file, 0o600);
  }
  fs.writeFileSync(file, ""); // editor truncated it while saving
  assert.equal(store.secretFor("laptop"), secret);
  fs.rmSync(file);
  now += 100;
  assert.equal(store.secretFor("laptop"), secret);
  now += 1000;
  assert.equal(store.secretFor("laptop"), undefined);
});

test("machines: rewrite keeps comments and malformed lines, warns once, drops duplicates", () => {
  const dir = tmpDir();
  const file = machinesFile({ configDir: dir });
  const s1 = newSecret();
  const s2 = newSecret();
  fs.writeFileSync(file, `# my machines\nlaptop ${s1}\nbroken line here\nlaptop ${s2}\nold ${newSecret()}\n`, { mode: 0o600 });
  const { warns, log } = captureLogger();
  const store = new MachineStore(file, { log });
  assert.equal(store.secretFor("laptop"), s1);
  store.secretFor("laptop");
  assert.equal(warns.filter((w) => /line\(s\) 3, 4/.test(w)).length, 1);
  assert.equal(store.removeMachine("old"), true);
  const added = store.addMachine("build-01");
  assert.equal(fs.readFileSync(file, "utf8"), `# my machines\nlaptop ${s1}\nbroken line here\nbuild-01 ${added}\n`);
  assert.equal(store.removeMachine("laptop"), true);
  assert.equal(store.secretFor("laptop"), undefined); // the duplicate did not become active
  assert.equal(store.removeMachine("build-01"), true);
  assert.match(fs.readFileSync(file, "utf8"), /^# my machines\nbroken line here\n$/);
  assert.deepEqual(store.listMachines(), []);
});

test("machines: lock file, stale lock, leftover temp file", () => {
  const dir = tmpDir();
  const file = machinesFile({ configDir: dir });
  const store = new MachineStore(file, { lockTimeoutMs: 100 });
  const lock = `${file}.lock`;
  fs.writeFileSync(lock, "1\n");
  assert.throws(() => store.addMachine("laptop"), /locked by another process/);
  assert.equal(fs.existsSync(file), false);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old); // crashed writer
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, "junk");
  const secret = store.addMachine("laptop");
  assert.equal(store.secretFor("laptop"), secret);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(tmp), false);
  // removing the last machine leaves a non-empty file, so it is not mistaken for a truncated one
  assert.equal(store.removeMachine("laptop"), true);
  assert.equal(store.secretFor("laptop"), undefined);
  assert.match(fs.readFileSync(file, "utf8"), /^# /);
});

// ---------- local socket probe, output cap ----------

test("local: a socket that cannot be checked is not removed", { skip: process.getuid?.() === 0 }, async () => {
  const dir = tmpDir();
  const socketPath = path.join(dir, "bridge.sock");
  const srv = net.createServer().listen(socketPath);
  await new Promise((r) => srv.once("listening", r));
  try {
    fs.chmodSync(socketPath, 0o000);
    assert.equal(await probeSocket(socketPath), "unknown"); // EACCES
    await assert.rejects(startLocal({ socketPath, log: silentLogger, onConnection: () => {} }), /cannot be checked/);
    assert.equal(fs.existsSync(socketPath), true);
  } finally {
    await new Promise((r) => srv.close(r));
  }
  assert.equal(await probeSocket(path.join(dir, "missing.sock")), "free");
});

test("link: output buffered for a peer that does not read is capped in bytes", async () => {
  const dir = tmpDir();
  const socketPath = path.join(dir, "cap.sock");
  const accepted = new Promise<net.Socket>((resolve) => {
    const srv = net.createServer((s) => {
      srv.close();
      resolve(s);
    });
    srv.listen(socketPath);
  });
  const peer = net.connect(socketPath);
  peer.pause(); // never reads
  const sock = await accepted;
  const conn = socketConnection(sock, "local", { maxBufferedOutput: 1536 * 1024 });
  const line = JSON.stringify({ type: "message", text: "x".repeat(1024 * 1024) });
  conn.write(line); // empty buffer: always written
  assert.equal(conn.alive(), true);
  conn.write(line); // would exceed 1.5 MiB buffered
  assert.equal(conn.alive(), false);
  peer.destroy();
});
