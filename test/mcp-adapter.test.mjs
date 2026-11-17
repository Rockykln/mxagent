// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync, mkdirSync, chmodSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../adapters/mcp/server.mjs", import.meta.url));

// Stub SDK loaded by the server via MXA_MCP_SDK_MODULE. It forwards every SDK call to the
// test process over a Unix socket and turns pushed {event} lines into agent events.
const STUB_SDK = `
import { connect as netConnect } from "node:net";
import { EventEmitter } from "node:events";

export async function connect(opts) {
  const agent = new EventEmitter();
  if (process.env.MXA_STUB_MODE === "down") {
    agent.ready = () => Promise.reject(new Error("connect ENOENT /nonexistent/bridge.sock"));
    agent.close = async () => {};
    return agent;
  }
  if (process.env.MXA_STUB_MODE === "trylater") {
    let readyCalls = 0;
    agent.ready = () => {
      readyCalls++;
      process.stderr.write("stub ready call " + readyCalls + "\\n");
      const e = new Error("daemon asked to try again later (close 4029: rate limit, capacity or timeout)");
      e.name = "NotConnectedError";
      agent.emit("error", e);
      return Promise.reject(e);
    };
    agent.close = () => process.stderr.write("stub closed\\n");
    return agent;
  }
  if (process.env.MXA_STUB_MODE === "reject") {
    let readyCalls = 0;
    agent.ready = () => {
      readyCalls++;
      process.stderr.write("stub ready call " + readyCalls + "\\n");
      return Promise.reject(new Error("daemon rejected registration: agent x is already connected"));
    };
    agent.close = () => process.stderr.write("stub closed\\n");
    return agent;
  }
  const sock = netConnect(process.env.MXA_STUB_CONTROL);
  const pending = new Map();
  let nextId = 1, buf = "";
  sock.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.event) agent.emit(m.event, m.payload);
      else { const p = pending.get(m.id); pending.delete(m.id); if (m.error) { const e = new Error(m.error); e.name = m.name || "Error"; p.reject(e); } else p.resolve(m.result); }
    }
  });
  const rpc = (method, args) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject });
    sock.write(JSON.stringify({ id, method, args }) + "\\n");
  });
  sock.write(JSON.stringify({ method: "connect", args: [opts] }) + "\\n");
  for (const m of ["reply", "status", "ask", "poll", "vote", "react"]) agent[m] = (...a) => rpc(m, a);
  agent.requestApproval = ({ signal, ...req }) => {
    signal?.addEventListener("abort", () => sock.write(JSON.stringify({ method: "approvalAborted", args: [req.requestId] }) + "\\n"));
    return rpc("requestApproval", [{ ...req, hasSignal: signal instanceof AbortSignal }]);
  };
  const slow = process.env.MXA_STUB_MODE === "slow";
  agent.ready = () => (slow ? new Promise((r) => setTimeout(r, 600)) : Promise.resolve()).then(() => rpc("ready", []));
  agent.close = async () => { sock.end(); };
  return agent;
}
`;

let dir, controlPath, stubPath, controlServer, peer;
// Killed in after(), so a failed test that skipped stop() cannot keep the test file alive.
const children = new Set();
const peers = new Set();
const calls = [];
const handlers = {};

function pushEvent(event, payload) {
  peer.write(JSON.stringify({ event, payload }) + "\n");
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "mxagent-mcp-test-"));
  controlPath = join(dir, "control.sock");
  stubPath = join(dir, "stub-sdk.mjs");
  writeFileSync(stubPath, STUB_SDK);
  controlServer = createServer((s) => {
    peer = s;
    peers.add(s);
    s.on("close", () => peers.delete(s));
    let buf = "";
    s.on("data", async (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        calls.push(m);
        if (m.id === undefined) continue;
        const h = handlers[m.method] || (() => ({}));
        Promise.resolve()
          .then(() => h(...m.args))
          .then(
            (result) => s.write(JSON.stringify({ id: m.id, result }) + "\n"),
            (err) => s.write(JSON.stringify({ id: m.id, error: err.message, name: err.name }) + "\n"),
          );
      }
    });
  });
  await new Promise((r) => controlServer.listen(controlPath, r));
});

after(() => {
  for (const c of children) c.kill("SIGKILL");
  for (const p of peers) p.destroy();
  controlServer.close();
  rmSync(dir, { recursive: true, force: true });
});

function startServer({ args = ["--name", "test-agent"], mode, env = {} } = {}) {
  const child = spawn(process.execPath, [SERVER, ...args], {
    env: {
      PATH: process.env.PATH,
      MXA_MCP_SDK_MODULE: stubPath,
      MXA_STUB_CONTROL: controlPath,
      XDG_STATE_HOME: join(dir, "state"),
      ...(mode ? { MXA_STUB_MODE: mode } : {}),
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  child.on("exit", () => children.delete(child));
  child.stdin.on("error", () => {});
  const waiting = new Map();
  const stray = [];
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      const w = waiting.get(m.id);
      if (w) {
        waiting.delete(m.id);
        w(m);
      } else stray.push(m);
    }
  });
  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  const tool = async (name, args = {}) => (await request("tools/call", { name, arguments: args })).result;
  const stop = () =>
    new Promise((r) => {
      child.once("exit", r);
      child.stdin.end();
    });
  return { child, request, notify, tool, stop, stray, nextId: () => nextId, stderr: () => stderr };
}

async function initialized(opts) {
  const s = startServer(opts);
  const init = await s.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  s.notify("notifications/initialized", {});
  return { s, init };
}

const textOf = (r) => r.content.map((c) => c.text).join("\n");

test("initialize, ping and tools/list", async () => {
  const { s, init } = await initialized();
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "mxagent");
  assert.match(init.result.instructions, /bridge_inbox/);
  assert.deepEqual(init.result.capabilities.tools, { listChanged: false });
  assert.deepEqual((await s.request("ping")).result, {});
  const names = (await s.request("tools/list")).result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "bridge_ask", "bridge_inbox", "bridge_poll", "bridge_react", "bridge_reply",
    "bridge_request_approval", "bridge_status", "bridge_vote", "bridge_wait",
  ]);
  const unknown = await s.request("does/not/exist");
  assert.equal(unknown.error.code, -32601);
  const old = await s.request("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(old.result.protocolVersion, "2025-06-18");
  await s.stop();
});

test("connect options carry name, instance and client id", async () => {
  calls.length = 0;
  const { s } = await initialized({ args: ["--name", "builder", "--instance", "inst-1"] });
  await s.tool("bridge_status", { text: "hi" });
  const c = calls.find((m) => m.method === "connect");
  assert.equal(c.args[0].name, "builder");
  assert.equal(c.args[0].instance, "inst-1");
  assert.match(c.args[0].client, /^mcp-adapter\//);
  assert.deepEqual(calls.find((m) => m.method === "status").args, ["hi"]);
  await s.stop();
});

test("inbox queues messages and saves attachments privately", async () => {
  const { s } = await initialized();
  await s.tool("bridge_status", { text: "up" }); // make sure the stub is connected
  let r = await s.tool("bridge_inbox");
  assert.match(textOf(r), /No new messages/);
  pushEvent("message", { type: "message", kind: "text", text: "build it", sender: "@owner:example.org", via: "room", event_id: "$1" });
  pushEvent("message", {
    type: "message", kind: "attachment", text: "", sender: "@owner:example.org", via: "control",
    attachment: { name: "../../evil name.png", mime: "image/png", kind: "image", data: Buffer.from("PNGDATA").toString("base64"), size: 7 },
  });
  pushEvent("message", { type: "message", kind: "location", text: "[location] 1, 2", sender: "@owner:example.org", via: "room", lat: 1, lon: 2 });
  await new Promise((res) => setTimeout(res, 150));
  r = await s.tool("bridge_inbox");
  const msgs = r.structuredContent.messages;
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].text, "build it");
  assert.equal(msgs[0].event_id, "$1");
  assert.equal(msgs[2].lat, 1);
  const att = msgs[1].attachment;
  assert.equal(att.data, undefined);
  assert.ok(att.path.startsWith(join(dir, "state", "mxagent", "attachments", "test-agent")));
  assert.ok(!att.path.includes(".."));
  assert.equal(readFileSync(att.path, "utf8"), "PNGDATA");
  assert.equal(statSync(att.path).mode & 0o777, 0o600);
  assert.match(textOf(r), /build it/);
  assert.match(textOf(r), /saved at /);
  assert.deepEqual(JSON.parse(r.content[1].text).messages.length, 3);
  r = await s.tool("bridge_inbox");
  assert.equal(r.structuredContent.messages.length, 0);
  await s.stop();
});

test("bridge_wait blocks until a message arrives and times out otherwise", async () => {
  const { s } = await initialized();
  let r = await s.tool("bridge_wait", { timeout_s: 0.2 });
  assert.equal(r.structuredContent.timed_out, true);
  assert.match(textOf(r), /No message within/);
  const pending = s.tool("bridge_wait", { timeout_s: 10 });
  setTimeout(() => pushEvent("message", { kind: "text", text: "wake up", sender: "@owner:example.org", via: "room" }), 100);
  r = await pending;
  assert.equal(r.structuredContent.timed_out, false);
  assert.equal(r.structuredContent.messages[0].text, "wake up");
  pushEvent("update");
  r = await s.tool("bridge_wait", { timeout_s: 5 });
  assert.equal(r.structuredContent.messages[0].kind, "update_request");
  await s.stop();
});

test("cancelled bridge_wait sends no response", async () => {
  const { s } = await initialized();
  await s.tool("bridge_status", { text: "up" });
  const id = s.nextId();
  s.request("tools/call", { name: "bridge_wait", arguments: { timeout_s: 30 } });
  await new Promise((res) => setTimeout(res, 50));
  s.notify("notifications/cancelled", { requestId: id, reason: "test" });
  await new Promise((res) => setTimeout(res, 100));
  assert.deepEqual((await s.request("ping")).result, {});
  assert.equal(s.stray.length, 0);
  await s.stop();
});

test("reply, poll, vote and react pass through; bad input is rejected", async () => {
  calls.length = 0;
  handlers.reply = () => ({ held: true });
  const { s } = await initialized();
  let r = await s.tool("bridge_reply", { text: "done" });
  assert.equal(r.structuredContent.held, true);
  assert.match(textOf(r), /Queued/);
  r = await s.tool("bridge_reply", {});
  assert.equal(r.isError, true);
  assert.match(textOf(r), /Missing required argument "text"/);
  r = await s.tool("bridge_poll", { question: "Which?", options: ["a"] });
  assert.equal(r.isError, true);
  r = await s.tool("bridge_poll", { question: "Which?", options: ["a", "b"] });
  assert.ok(!r.isError);
  await s.tool("bridge_vote", { answer: 2 });
  await s.tool("bridge_react", { emoji: "✅" });
  assert.deepEqual(calls.find((m) => m.method === "poll").args, ["Which?", ["a", "b"]]);
  assert.deepEqual(calls.find((m) => m.method === "vote").args, ["2"]);
  assert.deepEqual(calls.find((m) => m.method === "react").args, ["✅"]);
  handlers.react = () => {
    throw new Error("no message to react to");
  };
  r = await s.tool("bridge_react", { emoji: "✅" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /no message to react to/);
  r = await s.tool("no_such_tool");
  assert.equal(r, undefined);
  delete handlers.reply;
  delete handlers.react;
  await s.stop();
});

test("bridge_ask with wait returns only the answer", async () => {
  const { s } = await initialized();
  await s.tool("bridge_status", { text: "up" });
  pushEvent("message", { kind: "text", text: "older", sender: "@owner:example.org", via: "room" });
  await new Promise((res) => setTimeout(res, 100));
  handlers.ask = () => {
    setTimeout(() => pushEvent("message", { kind: "text", text: "yes", sender: "@owner:example.org", via: "control" }), 100);
    return {};
  };
  const r = await s.tool("bridge_ask", { text: "Deploy?", wait: true, timeout_s: 5 });
  assert.deepEqual(r.structuredContent.messages.map((m) => m.text), ["yes"]);
  assert.equal(r.structuredContent.remaining, 1);
  delete handlers.ask;
  await s.stop();
});

test("bridge_request_approval returns the decision or times out", async () => {
  calls.length = 0;
  const { s } = await initialized();
  handlers.requestApproval = () => "allow";
  let r = await s.tool("bridge_request_approval", { title: "rm build/", detail: "cleanup" });
  assert.equal(r.structuredContent.decision, "allow");
  const req = calls.find((m) => m.method === "requestApproval").args[0];
  assert.equal(req.title, "rm build/");
  assert.equal(req.detail, "cleanup");
  assert.equal(typeof req.requestId, "string");
  handlers.requestApproval = () => "deny";
  r = await s.tool("bridge_request_approval", { title: "x" });
  assert.equal(r.structuredContent.decision, "deny");
  handlers.requestApproval = () => new Promise(() => {});
  r = await s.tool("bridge_request_approval", { title: "x", timeout_s: 0.3 });
  assert.equal(r.structuredContent.decision, "timeout");
  assert.match(textOf(r), /Treat as denied/);
  // The SDK gets the timeout and the abort signal, so it can withdraw the request (approval_cancel).
  const last = calls.filter((m) => m.method === "requestApproval").at(-1).args[0];
  assert.equal(last.timeoutMs, 300);
  assert.equal(last.hasSignal, true);
  handlers.requestApproval = () => {
    const e = new Error("no approval decision in time");
    e.name = "RequestTimeoutError";
    throw e;
  };
  r = await s.tool("bridge_request_approval", { title: "x", timeout_s: 1 });
  assert.equal(r.structuredContent.decision, "timeout");
  delete handlers.requestApproval;
  await s.stop();
});

test("clear error when the daemon is not reachable", async () => {
  const { s } = await initialized({ mode: "down" });
  const r = await s.tool("bridge_reply", { text: "hello" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /daemon is not reachable/);
  assert.match(textOf(r), /ENOENT/);
  const inbox = await s.tool("bridge_inbox");
  assert.match(textOf(inbox), /not connected/);
  await s.stop();
});

test("missing agent name exits with an error", async () => {
  const s = startServer({ args: [] });
  let err = "";
  s.child.stderr.on("data", (d) => (err += d));
  const code = await new Promise((r) => s.child.once("exit", r));
  assert.equal(code, 2);
  assert.match(err, /--name/);
});

test("works end to end with the real JS client against a fake daemon socket", async () => {
  const sockPath = join(dir, "fake-daemon.sock");
  const seen = [];
  let link;
  const daemon = createServer((s) => {
    link = s;
    let buf = "";
    s.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        seen.push(m);
        if (m.type === "hello") s.write(JSON.stringify({ type: "welcome", id: m.id, room_id: "!room:example.org" }) + "\n");
        else if (m.id !== undefined) s.write(JSON.stringify({ type: "ok", id: m.id, held: false }) + "\n");
      }
    });
  });
  await new Promise((r) => daemon.listen(sockPath, r));
  after(() => daemon.close());
  const child = spawn(process.execPath, [SERVER, "--name", "e2e"], {
    env: { PATH: process.env.PATH, MXA_SOCKET_PATH: sockPath, XDG_CONFIG_HOME: join(dir, "cfg"), XDG_STATE_HOME: join(dir, "state") },
    stdio: ["pipe", "pipe", "inherit"],
  });
  children.add(child);
  child.on("exit", () => children.delete(child));
  const responses = new Map();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      responses.get(m.id)?.(m);
    }
  });
  let id = 0;
  const req = (method, params) =>
    new Promise((r) => {
      responses.set(++id, r);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  const r = await req("tools/call", { name: "bridge_reply", arguments: { text: "hello owner" } });
  assert.equal(r.result.structuredContent.held, false);
  const hello = seen.find((m) => m.type === "hello");
  assert.equal(hello.name, "e2e");
  assert.match(hello.client, /^mcp-adapter\//);
  assert.equal(seen.find((m) => m.type === "reply").text, "hello owner");
  link.write(JSON.stringify({ type: "message", kind: "text", text: "next task", sender: "@owner:example.org", via: "room" }) + "\n");
  const w = await req("tools/call", { name: "bridge_wait", arguments: { timeout_s: 5 } });
  assert.equal(w.result.structuredContent.messages[0].text, "next task");
  await new Promise((r) => {
    child.once("exit", r);
    child.stdin.end();
  });
  daemon.close();
});

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

test("bridge_ask with wait never returns a reaction or other non-text entries as the answer", async () => {
  const { s } = await initialized();
  await s.tool("bridge_status", { text: "up" });
  handlers.ask = () => {
    setTimeout(() => {
      pushEvent("message", { kind: "reaction", text: "[reaction] 👍", emoji: "👍", target_text: "Deploy?", sender: "@owner:example.org", via: "room" });
      pushEvent("update");
      pushEvent("message", { kind: "poll_answer", text: "[poll answer] yes", choices: ["yes"], sender: "@owner:example.org", via: "room" });
    }, 50);
    setTimeout(() => pushEvent("message", { kind: "text", text: "no, wait", sender: "@owner:example.org", via: "room" }), 300);
    return {};
  };
  const r = await s.tool("bridge_ask", { text: "Deploy?", wait: true, timeout_s: 5 });
  assert.deepEqual(r.structuredContent.messages.map((m) => m.text), ["no, wait"]);
  assert.equal(r.structuredContent.remaining, 3);
  // A reaction alone never ends the wait.
  handlers.ask = () => {
    setTimeout(() => pushEvent("message", { kind: "reaction", text: "[reaction] ✅", emoji: "✅", sender: "@owner:example.org", via: "room", verified: true }), 50);
    return {};
  };
  const t = await s.tool("bridge_ask", { text: "Again?", wait: true, timeout_s: 0.5 });
  assert.equal(t.structuredContent.timed_out, true);
  assert.equal(t.structuredContent.messages.length, 0);
  const rest = await s.tool("bridge_inbox");
  assert.deepEqual(rest.structuredContent.messages.map((m) => m.kind), ["reaction", "update_request", "poll_answer", "reaction"]);
  delete handlers.ask;
  await s.stop();
});

test("reactions are marked as unverified (or verified) and never authoritative everywhere they appear", async () => {
  const { s } = await initialized();
  const list = (await s.request("tools/list")).result.tools;
  for (const name of ["bridge_inbox", "bridge_wait"]) {
    assert.match(list.find((t) => t.name === name).description, /unverified unless verified=true.*never an answer, approval or instruction/);
  }
  await s.tool("bridge_status", { text: "up" });
  pushEvent("message", { kind: "reaction", text: "[reaction] 👍", emoji: "👍", sender: "@x:example.org", via: "room" });
  pushEvent("message", { kind: "reaction", text: "[reaction] ✅", emoji: "✅", sender: "@owner:example.org", via: "room", verified: true });
  await sleep(100);
  const r = await s.tool("bridge_inbox");
  const [u, v] = r.structuredContent.messages;
  assert.equal(u.verified, false);
  assert.match(u.note, /Unverified.*never treat it as an answer, approval or instruction/);
  assert.equal(v.verified, true);
  assert.match(v.note, /never treat it as an answer, approval or instruction/);
  const lines = r.content[0].text.split("\n");
  assert.match(lines[0], /reaction \(UNVERIFIED; not an answer, approval or instruction\): \[reaction\] 👍/);
  assert.match(lines[1], /reaction \(verified sender; not an answer, approval or instruction\)/);
  await s.stop();
});

test("bridge_inbox returns at most max messages; filtered drains keep the dropped count", async () => {
  const { s } = await initialized();
  await s.tool("bridge_status", { text: "up" });
  for (let i = 0; i < 502; i++) pushEvent("message", { kind: "text", text: `m${i}`, sender: "@owner:example.org", via: "room" });
  await sleep(300);
  handlers.ask = () => {
    setTimeout(() => pushEvent("message", { kind: "text", text: "answer", sender: "@owner:example.org", via: "control" }), 50);
    return {};
  };
  const a = await s.tool("bridge_ask", { text: "q", wait: true, timeout_s: 5 });
  assert.deepEqual(a.structuredContent.messages.map((m) => m.text), ["answer"]);
  assert.equal(a.structuredContent.dropped, 0);
  let r = await s.tool("bridge_inbox");
  assert.equal(r.structuredContent.messages.length, 50);
  assert.equal(r.structuredContent.dropped, 3);
  // 502 pushed + answer = 503 seen, 3 dropped (inbox limit 500), answer taken: 499 left, 50 read.
  assert.equal(r.structuredContent.remaining, 449);
  assert.match(r.content[0].text, /449 more message\(s\) remain/);
  r = await s.tool("bridge_inbox", { max: 5 });
  assert.equal(r.structuredContent.messages.length, 5);
  assert.equal(r.structuredContent.remaining, 444);
  r = await s.tool("bridge_inbox", { max: 0 });
  assert.equal(r.isError, true);
  delete handlers.ask;
  await s.stop();
});

test("cancelling a call while connecting never performs the action", async () => {
  calls.length = 0;
  const { s } = await initialized({ mode: "slow" });
  const id = s.nextId();
  s.request("tools/call", { name: "bridge_reply", arguments: { text: "too late" } });
  await sleep(100);
  s.notify("notifications/cancelled", { requestId: id, reason: "test" });
  await sleep(900);
  assert.ok(calls.some((m) => m.method === "ready"));
  assert.ok(!calls.some((m) => m.method === "reply"));
  assert.equal(s.stray.length, 0);
  await s.stop();
});

test("cancelled approval is aborted in the SDK and gets no response", async () => {
  calls.length = 0;
  handlers.requestApproval = () => new Promise(() => {});
  const { s } = await initialized();
  await s.tool("bridge_status", { text: "up" });
  const id = s.nextId();
  s.request("tools/call", { name: "bridge_request_approval", arguments: { title: "rm -rf", timeout_s: 60 } });
  await sleep(100);
  s.notify("notifications/cancelled", { requestId: id, reason: "test" });
  await sleep(100);
  const req = calls.find((m) => m.method === "requestApproval").args[0];
  assert.equal(req.timeoutMs, 60000);
  assert.deepEqual(calls.find((m) => m.method === "approvalAborted")?.args, [req.requestId]);
  assert.deepEqual((await s.request("ping")).result, {});
  assert.equal(s.stray.length, 0);
  delete handlers.requestApproval;
  await s.stop();
});

test("a rejected registration is reported as rejected and stops retrying", async () => {
  const { s } = await initialized({ mode: "reject" });
  let r = await s.tool("bridge_reply", { text: "hello" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /rejected this agent: daemon rejected registration/);
  assert.doesNotMatch(textOf(r), /not reachable/);
  r = await s.tool("bridge_status", { text: "again" });
  assert.match(textOf(r), /stopped retrying/);
  const inbox = await s.tool("bridge_inbox");
  assert.match(textOf(inbox), /rejected this agent/);
  assert.equal((s.stderr().match(/stub ready call/g) || []).length, 1);
  assert.match(s.stderr(), /stub closed/);
  await s.stop();
});

test("close 4029 is reported as try later and never stops the adapter", async () => {
  const { s } = await initialized({ mode: "trylater" });
  let r = await s.tool("bridge_reply", { text: "hello" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /try again later \(close 4029/);
  assert.doesNotMatch(textOf(r), /rejected this agent|stopped retrying/);
  r = await s.tool("bridge_status", { text: "again" });
  assert.match(textOf(r), /try again later/);
  assert.equal((s.stderr().match(/stub ready call/g) || []).length, 2);
  assert.doesNotMatch(s.stderr(), /stub closed|stopped:/);
  await s.stop();
});

test("agent names follow the daemon's rules", async () => {
  for (const [name, why] of [["a/b", /1-64 letters/], ["x:y", /1-64 letters/], ["has space", /1-64 letters/], ["ALL", /reserved/], ["list", /reserved/], ["Control", /reserved/], ["system", /reserved/], ["__proto__", /reserved/], ["constructor", /reserved/], ["toString", /reserved/], ["a".repeat(65), /1-64 letters/]]) {
    const s = startServer({ args: ["--name", name] });
    const code = await new Promise((r) => s.child.once("exit", r));
    assert.equal(code, 2, name);
    assert.match(s.stderr(), /invalid agent name/, name);
    assert.match(s.stderr(), why, name);
  }
  calls.length = 0;
  // must match the daemon's list exactly: "team" is an ordinary name
  const daemon = await import("../src/daemon/registry.ts");
  for (const n of ["all", "room", "list", "update", "control", "system", "__proto__", "hasOwnProperty", "prototype"]) {
    assert.throws(() => daemon.validateAgentName(n), /reserved/, n);
  }
  assert.equal(daemon.validateAgentName("team"), "team");
  const src = readFileSync(fileURLToPath(new URL("../adapters/mcp/server.mjs", import.meta.url)), "utf8");
  const listed = JSON.parse(src.match(/const RESERVED_NAMES = new Set\((\[[^\]]*\])\)/)[1]);
  assert.deepEqual([...listed].sort(), [...daemon.RESERVED_NAMES].sort());
  const { s } = await initialized({ args: ["--name", "Build-Agent_1.é"] });
  await s.tool("bridge_status", { text: "ok" });
  assert.equal(calls.find((m) => m.method === "connect").args[0].name, "Build-Agent_1.é");
  await s.stop();
});

test("attachment directory is forced to 0700 and old attachments are pruned", async () => {
  const agentDir = join(dir, "state", "mxagent", "attachments", "retention-agent");
  mkdirSync(agentDir, { recursive: true });
  chmodSync(agentDir, 0o755);
  const old = join(agentDir, "old.bin");
  const fresh = join(agentDir, "fresh.bin");
  writeFileSync(old, "x");
  writeFileSync(fresh, "y");
  const tenDaysAgo = (Date.now() - 10 * 24 * 3600 * 1000) / 1000;
  utimesSync(old, tenDaysAgo, tenDaysAgo);
  const { s } = await initialized({ args: ["--name", "retention-agent"] });
  assert.equal(statSync(agentDir).mode & 0o777, 0o700);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(fresh), true);
  await s.stop();

  // Retention 0 keeps everything; the directory is still tightened.
  chmodSync(agentDir, 0o750);
  utimesSync(fresh, tenDaysAgo, tenDaysAgo);
  const k = await initialized({ args: ["--name", "retention-agent"], env: { MXA_ATTACHMENT_RETENTION_DAYS: "0" } });
  assert.equal(statSync(agentDir).mode & 0o777, 0o700);
  assert.equal(existsSync(fresh), true);
  await k.s.stop();
});

test("bridge_vote takes a string (numbers tolerated); empty batch is an invalid request", async () => {
  calls.length = 0;
  const { s } = await initialized();
  const list = (await s.request("tools/list")).result.tools;
  assert.deepEqual(list.find((t) => t.name === "bridge_vote").inputSchema.properties.answer.type, "string");
  for (const t of list) assert.ok(!JSON.stringify(t.inputSchema).includes('"type":['), t.name);
  await s.tool("bridge_vote", { answer: " 2 " });
  assert.deepEqual(calls.filter((m) => m.method === "vote").map((m) => m.args), [["2"]]);
  let r = await s.tool("bridge_vote", { answer: "0" });
  assert.equal(r.isError, true);
  r = await s.tool("bridge_vote", { answer: "" });
  assert.equal(r.isError, true);
  s.child.stdin.write("[]\n");
  await sleep(100);
  assert.equal(s.stray.at(-1).error.code, -32600);
  await s.stop();
});

test("a URL without machine and secret is reported as a configuration error", async () => {
  const child = spawn(process.execPath, [SERVER, "--name", "cfg-agent", "--url", "ws://127.0.0.1:9/"], {
    env: { PATH: process.env.PATH, XDG_CONFIG_HOME: join(dir, "cfg-none"), XDG_STATE_HOME: join(dir, "state") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  child.on("exit", () => children.delete(child));
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bridge_reply", arguments: { text: "x" } } }) + "\n");
  for (let i = 0; i < 250 && !out.includes("\n"); i++) await sleep(20);
  const r = JSON.parse(out.split("\n")[0]).result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Invalid connection settings: remote mode needs a machine name and secret/);
  await new Promise((res) => {
    child.once("exit", res);
    child.stdin.end();
  });
});
