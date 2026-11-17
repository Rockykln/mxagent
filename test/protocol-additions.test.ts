// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
// Daemon side of the 1.0 protocol additions: `heartbeat` lines and `approval_cancel`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleConnection, type AgentLinkDeps } from "../src/daemon/agent-link.ts";
import { Polls, type PollsDeps } from "../src/daemon/polls.ts";
import { silentLogger } from "../src/daemon/log.ts";
import type { MatrixEvent } from "../src/daemon/matrix.ts";
import type { AgentLink } from "../src/daemon/registry.ts";
import type { Connection } from "../src/daemon/transport/link.ts";
import { HEARTBEAT_INTERVAL_MS, LINK_DEAD_AFTER_MS, type DaemonMessage } from "../src/protocol/messages.ts";

const ROOM_A = "!alpha:example.org";
const OWNER = "@owner:example.org";

function fakeConn() {
  const out: Record<string, unknown>[] = [];
  let lineCb: (obj: unknown) => void = () => {};
  const closeCbs: (() => void)[] = [];
  let open = true;
  const conn: Connection = {
    machine: "local",
    write: (line) => {
      if (open) out.push(JSON.parse(line));
    },
    close: () => {
      if (!open) return;
      open = false;
      for (const cb of closeCbs) cb();
    },
    alive: () => open,
    onLine: (cb) => {
      lineCb = cb;
    },
    onClose: (cb) => void closeCbs.push(cb),
  };
  return { conn, out, send: (obj: unknown) => lineCb(obj) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(5);
  }
}

function linkDeps(extra: Partial<AgentLinkDeps> = {}) {
  const cancels: { agentKey: string; requestId: string }[] = [];
  const deps: AgentLinkDeps = {
    config: { owner: OWNER },
    log: silentLogger,
    matrix: {
      sendText: async () => ({ eventId: "$t", held: false }),
      sendNotice: async () => ({ eventId: "$n", held: false }),
      sendMessage: async () => ({ eventId: "$m", held: false }),
      setTyping: () => {},
    } as unknown as AgentLinkDeps["matrix"],
    rooms: { ensureAgentRoom: async () => ROOM_A, setDisplayName: async () => {}, controlRoomId: "!control:example.org" } as unknown as AgentLinkDeps["rooms"],
    registry: { register: () => ({ ok: true }), remove: () => true },
    router: { rememberControlMessage: () => {} },
    polls: {
      sendAgentPoll: async () => "$p",
      vote: async () => {},
      requestApproval: async () => {},
      cancelApproval: async (agentKey: string, requestId: string) => {
        if (requestId === "unknown") throw new Error("no pending approval with this request_id");
        cancels.push({ agentKey, requestId });
      },
    },
    reactions: { agentReact: async () => {} },
    updates: { reported: () => {} },
    notify: { system: () => {} },
    heartbeatMs: 0,
    ...extra,
  };
  return { deps, cancels };
}

test("daemon sends heartbeat lines on every link until it closes", async () => {
  const { conn, out } = fakeConn();
  const { deps } = linkDeps({ heartbeatMs: 15 });
  handleConnection(conn, deps);
  // before hello as well: the heartbeat is a property of the link, not of the agent session
  await until(() => out.filter((m) => m.type === "heartbeat").length >= 2);
  assert.deepEqual(out[0], { type: "heartbeat" });
  conn.close();
  const n = out.length;
  await sleep(50);
  assert.equal(out.length, n);
});

test("heartbeat interval is 30 s by default and can be disabled", async () => {
  assert.equal(HEARTBEAT_INTERVAL_MS, 30_000);
  assert.equal(LINK_DEAD_AFTER_MS, 75_000);
  const { conn, out } = fakeConn();
  handleConnection(conn, linkDeps().deps); // heartbeatMs: 0
  await sleep(40);
  assert.equal(out.length, 0);
  conn.close();
});

test("approval_cancel is routed to Polls.cancelApproval and answered", async () => {
  const { conn, out, send } = fakeConn();
  const { deps, cancels } = linkDeps();
  handleConnection(conn, deps);
  send({ type: "hello", id: 1, name: "Alpha" });
  send({ type: "approval_cancel", id: 2, request_id: "req-1" });
  send({ type: "approval_cancel", id: 3 });
  send({ type: "approval_cancel", id: 4, request_id: "unknown" });
  await until(() => out.length >= 4);
  assert.deepEqual(out[0], { type: "welcome", id: 1, room_id: ROOM_A });
  assert.deepEqual(out[1], { type: "ok", id: 2 });
  assert.deepEqual(out[2], { type: "error", id: 3, error: "request_id required" });
  assert.deepEqual(out[3], { type: "error", id: 4, error: "no pending approval with this request_id" });
  assert.deepEqual(cancels, [{ agentKey: "alpha", requestId: "req-1" }]);
  conn.close();
});

function pollsSetup() {
  const sent: { roomId: string; type: string; content: Record<string, any> }[] = [];
  const notices: { roomId: string; body: string }[] = [];
  const got: DaemonMessage[] = [];
  let n = 0;
  const link: AgentLink = {
    key: "alpha", name: "Alpha", machine: "local", since: 0,
    send: (m) => void got.push(m),
    close: () => {},
    alive: () => true,
  };
  const deps: PollsDeps = {
    matrix: {
      async sendEvent(roomId: string, type: string, content: Record<string, any>) {
        sent.push({ roomId, type, content });
        return `$sent${++n}`;
      },
      async sendNotice(roomId: string, body: string) {
        notices.push({ roomId, body });
        return { eventId: `$notice${++n}`, held: false };
      },
    },
    rooms: {
      controlRoomId: "!control:example.org",
      agentRoom: (k: string) => (k === "alpha" ? ROOM_A : undefined),
      roomToAgent: (r: string) => (r === ROOM_A ? "alpha" : undefined),
    },
    registry: { get: (k: string) => (k === "alpha" ? link : undefined), keys: () => ["alpha"] },
    log: silentLogger,
    summarize: async () => {},
  };
  return { polls: new Polls(deps), sent, notices, got };
}

function vote(ref: string, answer: string): MatrixEvent {
  return {
    event_id: "$vote", sender: OWNER, room_id: ROOM_A, type: "org.matrix.msc3381.poll.response",
    content: { "m.relates_to": { rel_type: "m.reference", event_id: ref }, "org.matrix.msc3381.poll.response": { answers: [answer] } },
  };
}

test("cancelApproval ends the poll, posts Cancelled and ignores later votes", async () => {
  const { polls, sent, notices, got } = pollsSetup();
  await polls.requestApproval("alpha", "Alpha", "req-1", "deploy");
  const pollId = "$sent1";
  await assert.rejects(polls.cancelApproval("beta", "req-1"), /no pending approval/);
  await assert.rejects(polls.cancelApproval("alpha", "other"), /no pending approval/);

  await polls.cancelApproval("alpha", "req-1");
  assert.deepEqual(sent[1], {
    roomId: ROOM_A,
    type: "org.matrix.msc3381.poll.end",
    content: {
      "m.relates_to": { rel_type: "m.reference", event_id: pollId },
      "org.matrix.msc3381.poll.end": {},
      "org.matrix.msc1767.text": "Cancelled: deploy",
    },
  });
  assert.deepEqual(notices, [{ roomId: ROOM_A, body: "Cancelled: deploy" }]);

  assert.deepEqual(await polls.ownerEvent(ROOM_A, vote(pollId, "a0")), { handled: true });
  assert.equal(got.length, 0);
  assert.deepEqual(notices[1], { roomId: ROOM_A, body: "Vote not applied, this approval is no longer pending (cancelled): deploy" });
  await assert.rejects(polls.cancelApproval("alpha", "req-1"), /no pending approval/);
});

test("a resolved approval cannot be cancelled", async () => {
  const { polls, got, sent } = pollsSetup();
  await polls.requestApproval("alpha", "Alpha", "req-2", "push");
  await polls.ownerEvent(ROOM_A, vote("$sent1", sent[0].content["org.matrix.msc3381.poll.start"].answers[1].id));
  assert.deepEqual(got, [{ type: "approval_result", request_id: "req-2", decision: "deny" }]);
  await assert.rejects(polls.cancelApproval("alpha", "req-2"), /no pending approval/);
});
