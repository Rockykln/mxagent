// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import crypto from "node:crypto";
import type { Matrix, MatrixEvent } from "./matrix.ts";
import type { RoomManager } from "./rooms.ts";
import type { AgentRegistry } from "./registry.ts";
import type { Logger } from "./log.ts";
import type { InboundMessage } from "../protocol/messages.ts";

export const POLL_START_TYPES: ReadonlySet<string> = new Set(["m.poll.start", "org.matrix.msc3381.poll.start"]);
export const POLL_RESPONSE_TYPES: ReadonlySet<string> = new Set(["m.poll.response", "org.matrix.msc3381.poll.response"]);
export const POLL_END_TYPES: ReadonlySet<string> = new Set(["m.poll.end", "org.matrix.msc3381.poll.end"]);

const UNSTABLE_START = "org.matrix.msc3381.poll.start";
const UNSTABLE_RESPONSE = "org.matrix.msc3381.poll.response";
const UNSTABLE_END = "org.matrix.msc3381.poll.end";

export const MAX_QUESTION_CHARS = 500;
export const MAX_OPTION_CHARS = 200;
export const MAX_DETAIL_CHARS = 1500;
export const MAX_OPTIONS = 20;
const MAX_POLLS = 500;
const MAX_APPROVALS = 200;
const MAX_CLOSED_APPROVALS = 2000;
const MAX_CONTROL_VOTES = 200;
export const DEFAULT_APPROVAL_TTL_MS = 15 * 60_000;

/**
 * Fresh random answer ids for one Allow/Deny poll (128 bit each). A vote whose relation the homeserver
 * moved to another approval does not carry that approval's ids and is ignored.
 */
export function approvalAnswerIds(): { allow: string; deny: string } {
  return { allow: crypto.randomBytes(16).toString("hex"), deny: crypto.randomBytes(16).toString("hex") };
}

export type OwnerEventResult =
  | null
  | { deliverTo: string[]; via: "room" | "control"; message: InboundMessage }
  | { handled: true };

export interface PollsDeps {
  matrix: Pick<Matrix, "sendEvent" | "sendNotice">;
  rooms: Pick<RoomManager, "agentRoom" | "roomToAgent" | "controlRoomId">;
  registry: Pick<AgentRegistry, "get" | "keys">;
  log: Logger;
  /** `previousLabel`: the agent changed its vote; remove it from that label's summary. */
  summarize: (controlEventId: string, label: string, agentName: string, previousLabel?: string) => Promise<void>;
  now?: () => number;
  approvalTtlMs?: number; // default DEFAULT_APPROVAL_TTL_MS; pending approvals expire after this
}

interface Answer {
  id: string;
  text: string;
}

interface OwnerPoll {
  roomId: string;
  question: string;
  answers: Answer[];
  ts: number;
}

interface AgentPoll {
  roomId: string;
  agentKey: string;
  question: string;
  answers: Answer[];
}

interface Approval {
  roomId: string;
  agentKey: string;
  machine: string | undefined; // machine of the requesting link; results go only to a link from it
  agentName: string;
  requestId: string;
  title: string;
  allowId: string;
  denyId: string;
  timer: ReturnType<typeof setTimeout>;
}

type ApprovalOutcome = "allowed" | "denied" | "expired" | "cancelled";

interface ClosedApproval {
  roomId: string;
  title: string;
  outcome: ApprovalOutcome;
}

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as K);
}

/** Constant-time comparison of a selected answer id with an approval's id. */
function choiceIs(choice: string | undefined, id: string): boolean {
  if (typeof choice !== "string") return false;
  const a = Buffer.from(choice);
  const b = Buffer.from(id);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Text of an MSC1767 extensible-text value in any of the shapes clients send. */
function textOf(o: unknown): string {
  if (typeof o === "string") return o;
  if (!o || typeof o !== "object") return "";
  const v = o as Record<string, unknown>;
  const stable = v["m.text"];
  if (Array.isArray(stable)) {
    const first = stable.find((t) => t && typeof t === "object" && typeof (t as Record<string, unknown>).body === "string");
    if (first) return (first as { body: string }).body;
  }
  if (typeof stable === "string") return stable;
  if (typeof v["org.matrix.msc1767.text"] === "string") return v["org.matrix.msc1767.text"] as string;
  if (typeof v.body === "string") return v.body;
  return "";
}

/** Parses a poll start event (stable or unstable MSC3381); null if malformed. */
export function parsePollStart(content: Record<string, any>): { question: string; answers: Answer[] } | null {
  const p = content["m.poll"] ?? content[UNSTABLE_START] ?? content["m.poll.start"];
  if (!p || typeof p !== "object" || !Array.isArray(p.answers)) return null;
  const question = clip(textOf(p.question).trim(), MAX_QUESTION_CHARS);
  const answers: Answer[] = [];
  const seen = new Set<string>();
  for (const a of p.answers.slice(0, MAX_OPTIONS)) {
    if (!a || typeof a !== "object") continue;
    const id = a["m.id"] ?? a.id;
    if (typeof id !== "string" || !id || id.length > 100 || seen.has(id)) continue;
    seen.add(id);
    answers.push({ id, text: clip(textOf(a).trim(), MAX_OPTION_CHARS) });
  }
  if (!question || answers.length === 0) return null;
  return { question, answers };
}

/** Selected answer ids of a poll response (stable or unstable); null if malformed. */
export function parsePollResponse(content: Record<string, any>): { ref: string; selections: string[] } | null {
  const rel = content["m.relates_to"];
  const ref = rel && typeof rel === "object" ? rel.event_id : undefined;
  if (typeof ref !== "string" || !ref) return null;
  const raw = content["m.selections"] ?? content[UNSTABLE_RESPONSE]?.answers ?? content["m.poll.response"]?.answers;
  if (!Array.isArray(raw)) return null;
  const selections = raw.filter((s): s is string => typeof s === "string").slice(0, MAX_OPTIONS);
  return { ref, selections };
}

/**
 * Content of a poll start event: unstable MSC3381 fields plus a text fallback for clients without poll support.
 * `ids`: answer ids, one per option (default `a0`, `a1`, ...).
 */
export function renderPoll(question: string, options: string[], ids?: string[]): Record<string, any> {
  if (ids && ids.length !== options.length) throw new Error("renderPoll: one id per option");
  return {
    [UNSTABLE_START]: {
      kind: "org.matrix.msc3381.poll.disclosed",
      max_selections: 1,
      question: { "org.matrix.msc1767.text": question, body: question },
      answers: options.map((text, i) => ({ id: ids ? ids[i] : `a${i}`, "org.matrix.msc1767.text": text })),
    },
    "org.matrix.msc1767.text": `${question}\n${options.map((o, i) => `${i + 1}. ${o}`).join("\n")}`,
  };
}

export class Polls {
  private readonly matrix: PollsDeps["matrix"];
  private readonly rooms: PollsDeps["rooms"];
  private readonly registry: PollsDeps["registry"];
  private readonly log: Logger;
  private readonly summarize: PollsDeps["summarize"];
  private readonly now: () => number;
  private readonly ownerPolls = new Map<string, OwnerPoll>(); // start event id -> poll
  private readonly latestOwnerPoll = new Map<string, string>(); // room id -> start event id
  private readonly agentPolls = new Map<string, AgentPoll>(); // start event id -> poll
  private readonly approvals = new Map<string, Approval>(); // approval poll event id -> pending request
  // Approvals that left `approvals` (decided, expired, cancelled, evicted): never resolvable again.
  private readonly closedApprovals = new Map<string, ClosedApproval>();
  private readonly controlVotes = new Map<string, Map<string, string>>(); // control poll id -> agent name -> label
  private readonly approvalTtlMs: number;

  constructor(deps: PollsDeps) {
    this.matrix = deps.matrix;
    this.rooms = deps.rooms;
    this.registry = deps.registry;
    this.log = deps.log;
    this.summarize = deps.summarize;
    this.now = deps.now ?? Date.now;
    this.approvalTtlMs = deps.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
  }

  /** Stops the approval expiry timers (shutdown). */
  close(): void {
    for (const a of this.approvals.values()) clearTimeout(a.timer);
  }

  /**
   * Handles a poll event the router already verified as coming from the owner.
   * Returns null for non-poll events; every poll event is consumed (`handled`) or turned into a delivery.
   */
  async ownerEvent(roomId: string, event: MatrixEvent): Promise<OwnerEventResult> {
    const content = event.content && typeof event.content === "object" ? event.content : {};
    if (POLL_START_TYPES.has(event.type)) return this.onStart(roomId, event, content);
    if (POLL_RESPONSE_TYPES.has(event.type)) return this.onResponse(roomId, event, content);
    if (POLL_END_TYPES.has(event.type)) return this.onEnd(roomId, content);
    return null;
  }

  private onStart(roomId: string, event: MatrixEvent, content: Record<string, any>): OwnerEventResult {
    const control = roomId === this.rooms.controlRoomId;
    const agent = control ? undefined : this.rooms.roomToAgent(roomId);
    if (!control && !agent) return { handled: true };
    const poll = parsePollStart(content);
    if (!poll) {
      this.log.debug("ignored malformed poll start", event.event_id);
      return { handled: true };
    }
    const ts = typeof event.origin_server_ts === "number" ? event.origin_server_ts : this.now();
    boundedSet(this.ownerPolls, event.event_id, { roomId, ...poll, ts }, MAX_POLLS);
    boundedSet(this.latestOwnerPoll, roomId, event.event_id, MAX_POLLS);
    const options = poll.answers.map((a) => a.text);
    const where = control ? " in the control room" : "";
    const message: InboundMessage = {
      type: "message",
      kind: "poll_started",
      text: `[poll started by owner${where}] ${poll.question}\nOptions: ${options.map((o, i) => `${i + 1}. ${o}`).join(" | ")}`,
      sender: event.sender,
      via: control ? "control" : "room",
      event_id: event.event_id,
      question: poll.question,
      options,
    };
    const deliverTo = control ? this.registry.keys() : [agent!];
    this.log.info("owner poll", event.event_id, control ? "control" : agent, `${options.length} options`);
    return { deliverTo, via: message.via, message };
  }

  private async onResponse(roomId: string, event: MatrixEvent, content: Record<string, any>): Promise<OwnerEventResult> {
    const resp = parsePollResponse(content);
    if (!resp) return { handled: true };

    const approval = this.approvals.get(resp.ref);
    if (approval) {
      if (approval.roomId !== roomId) return { handled: true };
      const choice = resp.selections[0];
      const decision = choiceIs(choice, approval.allowId) ? "allow" : choiceIs(choice, approval.denyId) ? "deny" : null;
      if (!decision) return { handled: true };
      await this.decide(resp.ref, approval, decision);
      return { handled: true };
    }
    const closed = this.closedApprovals.get(resp.ref);
    if (closed) {
      if (closed.roomId === roomId && resp.selections.length) {
        await this.notice(roomId, `Vote not applied, this approval is no longer pending (${closed.outcome}): ${closed.title}`);
      }
      return { handled: true };
    }

    const poll = this.agentPolls.get(resp.ref);
    if (!poll || poll.roomId !== roomId) return { handled: true };
    const choices = resp.selections
      .map((id) => poll.answers.find((a) => a.id === id)?.text)
      .filter((t): t is string => t !== undefined);
    if (choices.length === 0) return { handled: true }; // retracted vote or unknown ids
    const message: InboundMessage = {
      type: "message",
      kind: "poll_answer",
      text: `[poll answer] ${poll.question}\nOwner chose: ${choices.join(", ")}`,
      sender: event.sender,
      via: "room",
      event_id: event.event_id,
      question: poll.question,
      choices,
    };
    return { deliverTo: [poll.agentKey], via: "room", message };
  }

  /** Sends a poll from an agent into its room; returns the event id. */
  async sendAgentPoll(agentKey: string, question: string, options: string[]): Promise<string> {
    const q = typeof question === "string" ? question.trim() : "";
    if (!q) throw new Error("poll needs a question");
    if (q.length > MAX_QUESTION_CHARS) throw new Error(`question is longer than ${MAX_QUESTION_CHARS} characters`);
    if (!Array.isArray(options) || options.length < 2 || options.length > MAX_OPTIONS) {
      throw new Error(`poll needs 2-${MAX_OPTIONS} options`);
    }
    const opts = options.map((o) => (typeof o === "string" ? o.trim() : ""));
    if (opts.some((o) => !o)) throw new Error("poll options must be non-empty strings");
    if (opts.some((o) => o.length > MAX_OPTION_CHARS)) throw new Error(`poll option is longer than ${MAX_OPTION_CHARS} characters`);
    const roomId = this.agentRoomOrThrow(agentKey);
    const eventId = await this.matrix.sendEvent(roomId, UNSTABLE_START, renderPoll(q, opts));
    boundedSet(
      this.agentPolls,
      eventId,
      { roomId, agentKey, question: q, answers: opts.map((text, i) => ({ id: `a${i}`, text })) },
      MAX_POLLS,
    );
    this.log.info("agent poll", agentKey, eventId, `${opts.length} options`);
    return eventId;
  }

  /** Votes in the owner's latest poll (agent room or control room, whichever is newer). */
  async vote(agentKey: string, agentName: string, answer: string): Promise<void> {
    const ownRoom = this.agentRoomOrThrow(agentKey);
    const controlRoom = this.rooms.controlRoomId;
    const own = this.latest(ownRoom);
    const ctl = controlRoom ? this.latest(controlRoom) : undefined;
    const pick = ctl && (!own || ctl.poll.ts > own.poll.ts) ? ctl : own;
    if (!pick) throw new Error("no open poll from the owner");

    const want = typeof answer === "string" ? answer.trim() : String(answer ?? "").trim();
    const answers = pick.poll.answers;
    const hit = /^\d+$/.test(want)
      ? answers[Number(want) - 1]
      : answers.find((a) => a.text.toLowerCase() === want.toLowerCase());
    if (!want || !hit) {
      throw new Error(`unknown option; choose one of: ${answers.map((a, i) => `${i + 1}. ${a.text}`).join(" | ")}`);
    }

    if (pick.poll.roomId === controlRoom) {
      // All agents share one bot user: a real vote would overwrite the others, so the vote is summarized instead.
      const label = `🗳 ${hit.text}:`;
      let votes = this.controlVotes.get(pick.id);
      if (!votes) {
        votes = new Map();
        boundedSet(this.controlVotes, pick.id, votes, MAX_CONTROL_VOTES);
      }
      const previous = votes.get(agentName);
      votes.set(agentName, label);
      await this.summarize(pick.id, label, agentName, previous);
      this.log.info("control vote", agentKey, pick.id);
      return;
    }
    await this.matrix.sendEvent(pick.poll.roomId, UNSTABLE_RESPONSE, {
      "m.relates_to": { rel_type: "m.reference", event_id: pick.id },
      [UNSTABLE_RESPONSE]: { answers: [hit.id] },
    });
    this.log.info("vote", agentKey, pick.id);
  }

  /** Sends an Allow/Deny poll into the agent's room and remembers the request. */
  async requestApproval(agentKey: string, agentName: string, requestId: string, title: string, detail?: string): Promise<void> {
    if (typeof requestId !== "string" || !requestId || requestId.length > 200) throw new Error("invalid request_id");
    const t = typeof title === "string" ? title.trim() : "";
    if (!t) throw new Error("approval needs a title");
    const d = typeof detail === "string" ? detail.trim() : "";
    const roomId = this.agentRoomOrThrow(agentKey);
    const shortTitle = clip(t, MAX_OPTION_CHARS);
    const question = clip(`${agentName} asks for approval: ${shortTitle}` + (d ? `\n${clip(d, MAX_DETAIL_CHARS)}` : ""), MAX_QUESTION_CHARS + MAX_DETAIL_CHARS);
    const machine = this.registry.get(agentKey)?.machine;
    const ids = approvalAnswerIds();
    const eventId = await this.matrix.sendEvent(roomId, UNSTABLE_START, renderPoll(question, ["Allow", "Deny"], [ids.allow, ids.deny]));
    const timer = setTimeout(() => void this.expire(eventId), this.approvalTtlMs);
    timer.unref?.();
    this.approvals.set(eventId, { roomId, agentKey, machine, agentName, requestId, title: shortTitle, allowId: ids.allow, denyId: ids.deny, timer });
    this.log.info("approval requested", agentKey, requestId, eventId);
    // Evicted approvals are closed like expired ones, so a later vote cannot resolve them.
    while (this.approvals.size > MAX_APPROVALS) void this.expire(this.approvals.keys().next().value as string);
  }

  /**
   * Withdraws a pending approval of this agent (agent gave up waiting): ends the Allow/Deny poll and
   * posts "Cancelled: …". Later owner votes on it only get a "no longer pending" notice. Throws if no such approval is pending.
   */
  async cancelApproval(agentKey: string, requestId: string): Promise<void> {
    const machine = this.registry.get(agentKey)?.machine;
    let found: [string, Approval] | undefined;
    for (const entry of this.approvals) {
      const a = entry[1];
      if (a.agentKey === agentKey && a.requestId === requestId && (a.machine === undefined || a.machine === machine)) found = entry;
    }
    if (!found) throw new Error("no pending approval with this request_id");
    const [eventId, approval] = found;
    this.log.info("approval cancelled", agentKey, requestId, eventId);
    await this.closeApproval(eventId, approval, "cancelled", `Cancelled: ${approval.title}`);
  }

  private async decide(eventId: string, approval: Approval, decision: "allow" | "deny"): Promise<void> {
    const label = decision === "allow" ? "Allowed" : "Denied";
    // Close first: a second vote arriving while the notice is sent must not resolve again.
    const closing = this.closeApproval(eventId, approval, decision === "allow" ? "allowed" : "denied", null);
    const delivered = this.sendResult(approval, decision);
    this.log.info("approval", decision, approval.agentKey, approval.requestId, delivered ? "delivered" : "agent offline");
    const suffix = delivered ? "" : ` (${approval.agentName} is offline, not delivered)`;
    await closing;
    await this.notice(approval.roomId, `${label}: ${approval.title}${suffix}`);
  }

  /** Sends `approval_result` to the requesting agent if it is connected from the same machine; true if sent. */
  private sendResult(approval: Approval, decision: "allow" | "deny"): boolean {
    const link = this.registry.get(approval.agentKey);
    if (!link || !link.alive() || (approval.machine !== undefined && link.machine !== approval.machine)) return false;
    try {
      link.send({ type: "approval_result", request_id: approval.requestId, decision });
      return true;
    } catch (e) {
      this.log.warn("approval result not sent", approval.agentKey, e instanceof Error ? e.name : "error");
      return false;
    }
  }

  private async expire(eventId: string): Promise<void> {
    const approval = this.approvals.get(eventId);
    if (!approval) return;
    // fail-safe: the agent gets a "deny" so it never waits forever
    const delivered = this.sendResult(approval, "deny");
    this.log.info("approval expired", approval.agentKey, approval.requestId, eventId, delivered ? "deny delivered" : "agent offline");
    await this.closeApproval(eventId, approval, "expired", `Expired: ${approval.title}`);
  }

  /**
   * Moves an approval from pending to closed (synchronously, before any await) and ends its poll.
   * `body`: text of the poll end and of a notice; null = poll end with the outcome, no notice.
   */
  private async closeApproval(eventId: string, approval: Approval, outcome: ApprovalOutcome, body: string | null): Promise<void> {
    clearTimeout(approval.timer);
    this.approvals.delete(eventId);
    boundedSet(this.closedApprovals, eventId, { roomId: approval.roomId, title: approval.title, outcome }, MAX_CLOSED_APPROVALS);
    const text = body ?? `${outcome[0].toUpperCase()}${outcome.slice(1)}: ${approval.title}`;
    await this.matrix
      .sendEvent(approval.roomId, UNSTABLE_END, {
        "m.relates_to": { rel_type: "m.reference", event_id: eventId },
        [UNSTABLE_END]: {},
        "org.matrix.msc1767.text": text,
      })
      .catch((e: unknown) => {
        this.log.warn("approval poll end failed", approval.roomId, e instanceof Error ? e.message : String(e));
      });
    if (body !== null) await this.notice(approval.roomId, body);
  }

  /** Owner ended a poll: an open approval counts as denied; an ended owner poll can no longer be voted on. */
  private async onEnd(roomId: string, content: Record<string, any>): Promise<OwnerEventResult> {
    const rel = content["m.relates_to"];
    const ref = rel && typeof rel === "object" ? rel.event_id : undefined;
    if (typeof ref !== "string" || !ref) return { handled: true };
    const approval = this.approvals.get(ref);
    if (approval && approval.roomId === roomId) {
      await this.decide(ref, approval, "deny");
      return { handled: true };
    }
    const owner = this.ownerPolls.get(ref);
    if (owner && owner.roomId === roomId) {
      this.ownerPolls.delete(ref);
      if (this.latestOwnerPoll.get(roomId) === ref) this.latestOwnerPoll.delete(roomId);
    }
    return { handled: true };
  }

  private notice(roomId: string, body: string): Promise<void> {
    return this.matrix.sendNotice(roomId, body).then(
      () => undefined,
      (e: unknown) => this.log.warn("approval notice failed", roomId, e instanceof Error ? e.message : String(e)),
    );
  }

  private latest(roomId: string): { id: string; poll: OwnerPoll } | undefined {
    const id = this.latestOwnerPoll.get(roomId);
    const poll = id ? this.ownerPolls.get(id) : undefined;
    return id && poll ? { id, poll } : undefined;
  }

  private agentRoomOrThrow(agentKey: string): string {
    const roomId = this.rooms.agentRoom(agentKey);
    if (!roomId) throw new Error("agent has no room");
    return roomId;
  }
}
