// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { Polls, parsePollStart, parsePollResponse, renderPoll } from "../src/daemon/polls.ts";
import type { PollsDeps } from "../src/daemon/polls.ts";
import { OwnerNotJoinedError } from "../src/daemon/matrix.ts";
import type { MatrixEvent } from "../src/daemon/matrix.ts";
import { silentLogger } from "../src/daemon/log.ts";
import type { AgentLink } from "../src/daemon/registry.ts";
import type { DaemonMessage } from "../src/protocol/messages.ts";

const OWNER = "@owner:example.org";
const CONTROL = "!control:example.org";
const ROOM_A = "!alpha:example.org";
const ROOM_B = "!beta:example.org";

function setup(opts: { ownerJoined?: boolean } = {}) {
  const sent: { roomId: string; type: string; content: Record<string, any> }[] = [];
  const ids: string[] = []; // event id of each entry in `sent`
  const notices: { roomId: string; body: string }[] = [];
  const summaries: { id: string; label: string; agent: string }[] = [];
  const links = new Map<string, AgentLink & { got: DaemonMessage[] }>();
  let n = 0;
  const addLink = (key: string) => {
    const got: DaemonMessage[] = [];
    const l = {
      key, name: key, machine: "local", since: 0, got,
      send: (m: DaemonMessage) => void got.push(m),
      close: () => {},
      alive: () => true,
    };
    links.set(key, l);
    return l;
  };
  const deps: PollsDeps = {
    matrix: {
      async sendEvent(roomId: string, type: string, content: Record<string, any>) {
        if (opts.ownerJoined === false) throw new OwnerNotJoinedError(roomId);
        const id = `$sent${++n}`;
        sent.push({ roomId, type, content });
        ids.push(id);
        return id;
      },
      async sendNotice(roomId: string, body: string) {
        notices.push({ roomId, body });
        return { eventId: `$notice${++n}`, held: false };
      },
    },
    rooms: {
      controlRoomId: CONTROL,
      agentRoom: (k: string) => ({ alpha: ROOM_A, beta: ROOM_B } as Record<string, string>)[k],
      roomToAgent: (r: string) => ({ [ROOM_A]: "alpha", [ROOM_B]: "beta" } as Record<string, string>)[r],
    },
    registry: {
      get: (k: string) => links.get(k),
      keys: () => [...links.keys()].sort(),
    },
    log: silentLogger,
    summarize: async (id, label, agent) => void summaries.push({ id, label, agent }),
  };
  return { polls: new Polls(deps), sent, ids, notices, summaries, links, addLink, deps };
}

/** Allow/Deny answer ids of the approval poll sent as event `eventId`. */
function approvalIds(sent: { type: string; content: Record<string, any> }[], ids: string[], eventId: string): { allow: string; deny: string } {
  const answers = sent[ids.indexOf(eventId)].content["org.matrix.msc3381.poll.start"].answers;
  return { allow: answers[0].id, deny: answers[1].id };
}

function stableStart(id: string, roomId: string, ts: number, question: string, options: string[]): MatrixEvent {
  return {
    event_id: id, sender: OWNER, type: "m.poll.start", room_id: roomId, origin_server_ts: ts,
    content: {
      "m.poll": {
        kind: "m.disclosed", max_selections: 1,
        question: { "m.text": [{ body: question }] },
        answers: options.map((o, i) => ({ "m.id": `opt${i}`, "m.text": [{ body: o }] })),
      },
    },
  };
}

function unstableStart(id: string, roomId: string, ts: number, question: string, options: string[]): MatrixEvent {
  return {
    event_id: id, sender: OWNER, type: "org.matrix.msc3381.poll.start", room_id: roomId, origin_server_ts: ts,
    content: {
      "org.matrix.msc3381.poll.start": {
        question: { "org.matrix.msc1767.text": question },
        answers: options.map((o, i) => ({ id: `u${i}`, "org.matrix.msc1767.text": o })),
      },
    },
  };
}

function response(id: string, roomId: string, ref: string, answers: string[], stable = false): MatrixEvent {
  return {
    event_id: id, sender: OWNER, room_id: roomId,
    type: stable ? "m.poll.response" : "org.matrix.msc3381.poll.response",
    content: stable
      ? { "m.relates_to": { rel_type: "m.reference", event_id: ref }, "m.selections": answers }
      : { "m.relates_to": { rel_type: "m.reference", event_id: ref }, "org.matrix.msc3381.poll.response": { answers } },
  };
}

test("parsers handle stable and unstable shapes and reject garbage", () => {
  assert.deepEqual(parsePollStart(stableStart("$1", ROOM_A, 1, "Q?", ["x", "y"]).content), {
    question: "Q?", answers: [{ id: "opt0", text: "x" }, { id: "opt1", text: "y" }],
  });
  assert.equal(parsePollStart(unstableStart("$1", ROOM_A, 1, "Q", ["a"]).content)?.answers[0].id, "u0");
  assert.equal(parsePollStart({}), null);
  assert.equal(parsePollStart({ "m.poll": { question: "x", answers: "no" } }), null);
  assert.equal(parsePollResponse({ "m.selections": ["a"] }), null);
  assert.deepEqual(parsePollResponse(response("$r", ROOM_A, "$p", ["a", 3 as any], true).content), { ref: "$p", selections: ["a"] });
  const c = renderPoll("Q", ["A", "B"]);
  assert.equal(c["org.matrix.msc3381.poll.start"].answers[1].id, "a1");
  assert.equal(c["org.matrix.msc1767.text"], "Q\n1. A\n2. B");
});

test("ownerEvent ignores non-poll events", async () => {
  const { polls } = setup();
  assert.equal(await polls.ownerEvent(ROOM_A, { event_id: "$m", sender: OWNER, type: "m.room.message", content: { body: "hi" } }), null);
});

test("owner poll in agent room goes to that agent", async () => {
  const { polls } = setup();
  const r = await polls.ownerEvent(ROOM_A, stableStart("$p", ROOM_A, 10, "Lunch?", ["Pizza", "Soup"]));
  assert.ok(r && "deliverTo" in r);
  assert.deepEqual(r.deliverTo, ["alpha"]);
  assert.equal(r.via, "room");
  assert.equal(r.message.kind, "poll_started");
  assert.equal(r.message.question, "Lunch?");
  assert.deepEqual(r.message.options, ["Pizza", "Soup"]);
  assert.match(r.message.text, /Lunch\?/);
  assert.match(r.message.text, /Pizza/);
  assert.equal(r.message.event_id, "$p");
});

test("owner poll in control room goes to all connected agents", async () => {
  const { polls, addLink } = setup();
  addLink("beta");
  addLink("alpha");
  const r = await polls.ownerEvent(CONTROL, unstableStart("$c", CONTROL, 10, "Deploy?", ["yes", "no"]));
  assert.ok(r && "deliverTo" in r);
  assert.deepEqual(r.deliverTo, ["alpha", "beta"]);
  assert.equal(r.via, "control");
  assert.equal(r.message.via, "control");
});

test("poll in unknown room or malformed poll is consumed", async () => {
  const { polls } = setup();
  assert.deepEqual(await polls.ownerEvent("!other:example.org", stableStart("$x", "!other:example.org", 1, "Q", ["a"])), { handled: true });
  assert.deepEqual(await polls.ownerEvent(ROOM_A, { event_id: "$y", sender: OWNER, type: "m.poll.start", content: {} }), { handled: true });
});

test("agent poll: rendering, answer delivery, retraction and wrong room", async () => {
  const { polls, sent } = setup();
  const id = await polls.sendAgentPoll("alpha", "Pick one", ["Red", "Green", "Blue"]);
  assert.equal(sent[0].roomId, ROOM_A);
  assert.equal(sent[0].type, "org.matrix.msc3381.poll.start");
  const start = sent[0].content["org.matrix.msc3381.poll.start"];
  assert.equal(start.kind, "org.matrix.msc3381.poll.disclosed");
  assert.equal(start.max_selections, 1);
  assert.deepEqual(start.question, { "org.matrix.msc1767.text": "Pick one", body: "Pick one" });
  assert.deepEqual(start.answers.map((a: any) => a.id), ["a0", "a1", "a2"]);

  const r = await polls.ownerEvent(ROOM_A, response("$r1", ROOM_A, id, ["a2"], true));
  assert.ok(r && "deliverTo" in r);
  assert.deepEqual(r.deliverTo, ["alpha"]);
  assert.equal(r.message.kind, "poll_answer");
  assert.equal(r.message.question, "Pick one");
  assert.deepEqual(r.message.choices, ["Blue"]);
  assert.match(r.message.text, /^\[poll answer\]/);

  assert.deepEqual(await polls.ownerEvent(ROOM_A, response("$r2", ROOM_A, id, [])), { handled: true });
  assert.deepEqual(await polls.ownerEvent(ROOM_B, response("$r3", ROOM_B, id, ["a0"])), { handled: true });
  assert.deepEqual(await polls.ownerEvent(ROOM_A, response("$r4", ROOM_A, "$unknown", ["a0"])), { handled: true });
});

test("sendAgentPoll validates input and propagates OwnerNotJoinedError", async () => {
  const { polls } = setup();
  await assert.rejects(polls.sendAgentPoll("alpha", "", ["a", "b"]), /question/);
  await assert.rejects(polls.sendAgentPoll("alpha", "Q", ["a"]), /2-20/);
  await assert.rejects(polls.sendAgentPoll("alpha", "Q", Array.from({ length: 21 }, (_, i) => `o${i}`)), /2-20/);
  await assert.rejects(polls.sendAgentPoll("alpha", "Q", ["a", " "]), /non-empty/);
  await assert.rejects(polls.sendAgentPoll("nobody", "Q", ["a", "b"]), /no room/);
  const off = setup({ ownerJoined: false });
  await assert.rejects(off.polls.sendAgentPoll("alpha", "Q", ["a", "b"]), OwnerNotJoinedError);
});

test("vote in agent room sends a real poll response", async () => {
  const { polls, sent, summaries } = setup();
  await assert.rejects(polls.vote("alpha", "alpha", "1"), /no open poll/);
  await polls.ownerEvent(ROOM_A, stableStart("$p", ROOM_A, 10, "Q", ["Yes", "No"]));
  await polls.vote("alpha", "alpha", "no");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].roomId, ROOM_A);
  assert.equal(sent[0].type, "org.matrix.msc3381.poll.response");
  assert.deepEqual(sent[0].content, {
    "m.relates_to": { rel_type: "m.reference", event_id: "$p" },
    "org.matrix.msc3381.poll.response": { answers: ["opt1"] },
  });
  await polls.vote("alpha", "alpha", "1");
  assert.deepEqual(sent[1].content["org.matrix.msc3381.poll.response"].answers, ["opt0"]);
  await assert.rejects(polls.vote("alpha", "alpha", "3"), /unknown option.*Yes.*No/);
  await assert.rejects(polls.vote("alpha", "alpha", "maybe"), /unknown option/);
  await assert.rejects(polls.vote("alpha", "alpha", ""), /unknown option/);
  assert.equal(summaries.length, 0);
});

test("vote picks the newer of agent-room and control-room poll", async () => {
  const { polls, sent, summaries } = setup();
  await polls.ownerEvent(ROOM_A, stableStart("$a", ROOM_A, 10, "Room", ["r1", "r2"]));
  await polls.ownerEvent(CONTROL, unstableStart("$c", CONTROL, 20, "Control", ["c1", "c2"]));
  await polls.vote("alpha", "Alpha", "C2");
  assert.deepEqual(summaries, [{ id: "$c", label: "🗳 c2:", agent: "Alpha" }]);
  assert.equal(sent.length, 0);
  // Another agent without its own poll also votes in the control room.
  await polls.vote("beta", "Beta", "1");
  assert.deepEqual(summaries[1], { id: "$c", label: "🗳 c1:", agent: "Beta" });
  // A newer poll in the agent room wins again.
  await polls.ownerEvent(ROOM_A, stableStart("$a2", ROOM_A, 30, "Room 2", ["x", "y"]));
  await polls.vote("alpha", "Alpha", "y");
  assert.equal(sent[0].content["m.relates_to"].event_id, "$a2");
});

test("approval: allow resolves once, notice is posted, link gets result", async () => {
  const { polls, sent, ids, notices, addLink } = setup();
  const link = addLink("alpha");
  await polls.requestApproval("alpha", "Alpha", "req-1", "run shell command", "rm -rf build");
  assert.equal(sent.length, 1);
  const start = sent[0].content["org.matrix.msc3381.poll.start"];
  const { allow, deny } = approvalIds(sent, ids, "$sent1");
  assert.match(allow, /^[0-9a-f]{32}$/);
  assert.match(deny, /^[0-9a-f]{32}$/);
  assert.deepEqual(start.answers, [
    { id: allow, "org.matrix.msc1767.text": "Allow" },
    { id: deny, "org.matrix.msc1767.text": "Deny" },
  ]);
  assert.match(start.question.body, /run shell command\nrm -rf build/);
  const pollId = "$sent1";

  // Answer in another room is ignored.
  assert.deepEqual(await polls.ownerEvent(ROOM_B, response("$x", ROOM_B, pollId, [allow])), { handled: true });
  assert.equal(link.got.length, 0);
  // Unknown selections (also the old fixed ids) are ignored and the approval stays open.
  assert.deepEqual(await polls.ownerEvent(ROOM_A, response("$y", ROOM_A, pollId, ["zz"])), { handled: true });
  assert.deepEqual(await polls.ownerEvent(ROOM_A, response("$y2", ROOM_A, pollId, ["a0"])), { handled: true });
  assert.equal(link.got.length, 0);

  assert.deepEqual(await polls.ownerEvent(ROOM_A, response("$r", ROOM_A, pollId, [allow])), { handled: true });
  assert.deepEqual(link.got, [{ type: "approval_result", request_id: "req-1", decision: "allow" }]);
  assert.deepEqual(notices, [{ roomId: ROOM_A, body: "Allowed: run shell command" }]);

  // The poll is ended with the outcome.
  assert.deepEqual(sent[1], {
    roomId: ROOM_A,
    type: "org.matrix.msc3381.poll.end",
    content: {
      "m.relates_to": { rel_type: "m.reference", event_id: pollId },
      "org.matrix.msc3381.poll.end": {},
      "org.matrix.msc1767.text": "Allowed: run shell command",
    },
  });

  // Changing the vote later does not resolve again, is not forwarded as a poll answer and says so.
  assert.deepEqual(await polls.ownerEvent(ROOM_A, response("$r2", ROOM_A, pollId, [deny], true)), { handled: true });
  assert.equal(link.got.length, 1);
  assert.deepEqual(notices[1], {
    roomId: ROOM_A,
    body: "Vote not applied, this approval is no longer pending (allowed): run shell command",
  });
  // A retraction (empty selection) is consumed silently.
  await polls.ownerEvent(ROOM_A, response("$r3", ROOM_A, pollId, []));
  assert.equal(notices.length, 2);
});

function lastStart(sent: { type: string }[], ids: string[]): string {
  return ids[sent.map((e) => e.type).lastIndexOf("org.matrix.msc3381.poll.start")];
}

test("approval: deny, and offline agent", async () => {
  const { polls, sent, ids, notices, addLink, links } = setup();
  const link = addLink("alpha");
  await polls.requestApproval("alpha", "Alpha", "r2", "write file");
  await polls.ownerEvent(ROOM_A, response("$r", ROOM_A, "$sent1", [approvalIds(sent, ids, "$sent1").deny], true));
  assert.deepEqual(link.got, [{ type: "approval_result", request_id: "r2", decision: "deny" }]);
  assert.equal(notices[0].body, "Denied: write file");

  links.delete("alpha");
  await polls.requestApproval("alpha", "Alpha", "r3", "push");
  const second = lastStart(sent, ids);
  await polls.ownerEvent(ROOM_A, response("$r3", ROOM_A, second, [approvalIds(sent, ids, second).allow]));
  assert.match(notices[1].body, /^Allowed: push \(Alpha is offline/);
});

test("requestApproval validates input", async () => {
  const { polls } = setup();
  await assert.rejects(polls.requestApproval("alpha", "Alpha", "", "t"), /request_id/);
  await assert.rejects(polls.requestApproval("alpha", "Alpha", "r", "  "), /title/);
  await assert.rejects(polls.requestApproval("nobody", "N", "r", "t"), /no room/);
  const off = setup({ ownerJoined: false });
  await assert.rejects(off.polls.requestApproval("alpha", "Alpha", "r", "t"), OwnerNotJoinedError);
});

test("approval polls are not owner polls and cannot be voted on by agents", async () => {
  const { polls } = setup();
  await polls.requestApproval("alpha", "Alpha", "r", "t");
  await assert.rejects(polls.vote("alpha", "Alpha", "Allow"), /no open poll/);
});

test("poll maps are bounded", async () => {
  const { polls } = setup();
  for (let i = 0; i < 600; i++) await polls.sendAgentPoll("alpha", "Q", ["a", "b"]);
  // The oldest polls were evicted: their answers are consumed silently.
  assert.deepEqual(await polls.ownerEvent(ROOM_A, response("$r", ROOM_A, "$sent1", ["a0"])), { handled: true });
  const r = await polls.ownerEvent(ROOM_A, response("$r2", ROOM_A, "$sent600", ["a0"]));
  assert.ok(r && "deliverTo" in r);
});

test("approval expires: deny sent to the agent, poll ended, Expired notice, later vote not applied", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] });
  const { polls, sent, ids, notices, addLink } = setup();
  const link = addLink("alpha");
  await polls.requestApproval("alpha", "Alpha", "req", "deploy");
  const pollId = ids[0];
  ctx.mock.timers.tick(15 * 60_000 - 1);
  assert.equal(notices.length, 0);
  assert.equal(link.got.length, 0);
  ctx.mock.timers.tick(1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(link.got, [{ type: "approval_result", request_id: "req", decision: "deny" }]);
  assert.equal(sent[1].type, "org.matrix.msc3381.poll.end");
  assert.equal(sent[1].content["m.relates_to"].event_id, pollId);
  assert.equal(sent[1].content["org.matrix.msc1767.text"], "Expired: deploy");
  assert.deepEqual(notices, [{ roomId: ROOM_A, body: "Expired: deploy" }]);
  await polls.ownerEvent(ROOM_A, response("$late", ROOM_A, pollId, [approvalIds(sent, ids, pollId).allow]));
  assert.equal(link.got.length, 1); // the late vote resolves nothing
  assert.equal(notices[1].body, "Vote not applied, this approval is no longer pending (expired): deploy");
  await assert.rejects(polls.cancelApproval("alpha", "req"), /no pending approval/);
});

test("approval TTL is configurable and a decision stops the timer", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] });
  const s = setup();
  const polls = new Polls({ ...s.deps, approvalTtlMs: 1000 });
  s.addLink("alpha");
  await polls.requestApproval("alpha", "Alpha", "a", "one");
  await polls.requestApproval("alpha", "Alpha", "b", "two");
  await polls.ownerEvent(ROOM_A, response("$v", ROOM_A, s.ids[0], [approvalIds(s.sent, s.ids, s.ids[0]).allow]));
  ctx.mock.timers.tick(1000);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.notices.map((n) => n.body), ["Allowed: one", "Expired: two"]);
});

test("evicted approvals cannot be resolved and get a notice", async () => {
  const { polls, sent, ids, notices, addLink } = setup();
  const link = addLink("alpha");
  for (let i = 0; i < 201; i++) await polls.requestApproval("alpha", "Alpha", `r${i}`, `t${i}`);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(notices.map((n) => n.body), ["Expired: t0"]);
  assert.deepEqual(link.got, [{ type: "approval_result", request_id: "r0", decision: "deny" }]);
  await polls.ownerEvent(ROOM_A, response("$v", ROOM_A, ids[0], [approvalIds(sent, ids, ids[0]).allow]));
  assert.equal(link.got.length, 1);
  assert.match(notices.at(-1)!.body, /no longer pending \(expired\): t0$/);
  polls.close();
});

test("approval result goes only to a link from the requesting machine", async () => {
  const { polls, sent, ids, notices, addLink, links } = setup();
  addLink("alpha"); // machine "local"
  await polls.requestApproval("alpha", "Alpha", "req", "push");
  // Another machine takes over the name.
  const got: DaemonMessage[] = [];
  links.set("alpha", { key: "alpha", name: "alpha", machine: "other", since: 0, got, send: (m: DaemonMessage) => void got.push(m), close() {}, alive: () => true });
  await assert.rejects(polls.cancelApproval("alpha", "req"), /no pending approval/);
  await polls.ownerEvent(ROOM_A, response("$v", ROOM_A, ids[0], [approvalIds(sent, ids, ids[0]).allow]));
  assert.equal(got.length, 0);
  assert.match(notices[0].body, /^Allowed: push \(Alpha is offline, not delivered\)$/);
  polls.close();
});

test("expired approval: deny only to a live link from the requesting machine, never throws", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] });
  const s = setup();
  const polls = new Polls({ ...s.deps, approvalTtlMs: 1000 });
  s.addLink("alpha");
  s.addLink("beta");
  await polls.requestApproval("alpha", "Alpha", "a", "one");
  await polls.requestApproval("beta", "Beta", "b", "two");
  const got: DaemonMessage[] = [];
  s.links.set("alpha", { key: "alpha", name: "alpha", machine: "other", since: 0, got, send: (m: DaemonMessage) => void got.push(m), close() {}, alive: () => true });
  s.links.set("beta", { ...s.links.get("beta")!, send: () => { throw new Error("closed"); } });
  ctx.mock.timers.tick(1000);
  await new Promise((r) => setImmediate(r));
  assert.equal(got.length, 0);
  assert.deepEqual(s.notices.map((n) => n.body).sort(), ["Expired: one", "Expired: two"]);
});

test("owner ending an approval poll denies it; ending an owner poll stops votes on it", async () => {
  const { polls, ids, notices, addLink } = setup();
  const link = addLink("alpha");
  await polls.requestApproval("alpha", "Alpha", "req", "rm");
  const end = (ref: string, roomId: string): MatrixEvent => ({
    event_id: "$end", sender: OWNER, room_id: roomId, type: "m.poll.end",
    content: { "m.relates_to": { rel_type: "m.reference", event_id: ref } },
  });
  assert.deepEqual(await polls.ownerEvent(ROOM_B, end(ids[0], ROOM_B)), { handled: true });
  assert.equal(link.got.length, 0);
  await polls.ownerEvent(ROOM_A, end(ids[0], ROOM_A));
  assert.deepEqual(link.got, [{ type: "approval_result", request_id: "req", decision: "deny" }]);
  assert.equal(notices[0].body, "Denied: rm");

  await polls.ownerEvent(ROOM_A, stableStart("$p", ROOM_A, 10, "Q", ["x", "y"]));
  await polls.ownerEvent(ROOM_A, end("$p", ROOM_A));
  await assert.rejects(polls.vote("alpha", "alpha", "1"), /no open poll/);
});

test("changed control-room vote passes the previous label", async () => {
  const calls: unknown[][] = [];
  const s = setup();
  const p = new Polls({ ...s.deps, summarize: async (...args) => void calls.push(args) });
  await p.ownerEvent(CONTROL, unstableStart("$c", CONTROL, 20, "Control", ["c1", "c2"]));
  await p.vote("alpha", "Alpha", "1");
  await p.vote("alpha", "Alpha", "2");
  await p.vote("beta", "Beta", "2");
  await p.vote("alpha", "Alpha", "2");
  assert.deepEqual(calls, [
    ["$c", "🗳 c1:", "Alpha", undefined],
    ["$c", "🗳 c2:", "Alpha", "🗳 c1:"],
    ["$c", "🗳 c2:", "Beta", undefined],
    ["$c", "🗳 c2:", "Alpha", "🗳 c2:"],
  ]);
});

test("approval answer ids are random per poll; a vote moved to another approval does not resolve it", async () => {
  const { polls, sent, ids, addLink } = setup();
  const link = addLink("alpha");
  await polls.requestApproval("alpha", "Alpha", "one", "first");
  await polls.requestApproval("alpha", "Alpha", "two", "second");
  const a = approvalIds(sent, ids, ids[0]);
  const b = approvalIds(sent, ids, ids[1]);
  assert.equal(new Set([a.allow, a.deny, b.allow, b.deny]).size, 4);
  // An "Allow" for the first approval, re-pointed (cleartext relation) at the second one.
  assert.deepEqual(await polls.ownerEvent(ROOM_A, response("$moved", ROOM_A, ids[1], [a.allow])), { handled: true });
  assert.equal(link.got.length, 0);
  // Stable response shape (m.selections) maps back as well.
  const stable: MatrixEvent = {
    event_id: "$st", sender: OWNER, type: "m.poll.response", room_id: ROOM_A,
    content: { "m.relates_to": { rel_type: "m.reference", event_id: ids[1] }, "m.selections": [b.deny] },
  };
  await polls.ownerEvent(ROOM_A, stable);
  await polls.ownerEvent(ROOM_A, response("$ok", ROOM_A, ids[0], [a.allow], true));
  assert.deepEqual(link.got, [
    { type: "approval_result", request_id: "two", decision: "deny" },
    { type: "approval_result", request_id: "one", decision: "allow" },
  ]);
  polls.close();
});

test("renderPoll uses given answer ids and requires one per option", () => {
  const c = renderPoll("Q", ["A", "B"], ["x1", "y2"]);
  assert.deepEqual(c["org.matrix.msc3381.poll.start"].answers.map((a: any) => a.id), ["x1", "y2"]);
  assert.throws(() => renderPoll("Q", ["A", "B"], ["x1"]), /one id per option/);
});
