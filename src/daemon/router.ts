// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
// Inbound owner events -> agents: agent rooms, control-room commands, replies, broadcasts, receipts.

import type { Attachment, InboundMessage } from "../protocol/messages.ts";
import type { Config } from "./config.ts";
import type { Logger } from "./log.ts";
import type { EventHandler, MatrixEvent, SendResult } from "./matrix.ts";
import type { AgentLink } from "./registry.ts";
import { agentKey } from "./registry.ts";
import { parseControlCommand, stripReplyFallback } from "./commands.ts";
import { MediaError } from "./media.ts";

export type ReceiptEmoji = "👀" | "💤";

export interface RouterMatrix {
  onDecrypted(cb: EventHandler): () => void;
  onPlainEvent(cb: EventHandler): () => void;
  sendNotice(roomId: string, body: string): Promise<SendResult>;
  setTyping(roomId: string, typing: boolean, timeoutMs?: number): void;
  /** True if the event's replay key is missing/invalid or already recorded. */
  isReplay(key: unknown): boolean;
  /** Records the key of a verified owner event before delivery; false = replay. May throw (log not writable). */
  recordReplay(key: unknown): boolean;
}

export interface RouterTrust {
  check(device: string | null | undefined, curveKey: string | null | undefined): Promise<string | null>;
}

export interface RouterRooms {
  readonly controlRoomId: string | undefined;
  roomToAgent(roomId: string): string | undefined;
  agentRoom(key: string): string | undefined;
}

export interface RouterRegistry {
  get(key: string): AgentLink | undefined;
  list(): AgentLink[];
}

export interface RouterMedia {
  fetch(content: any, opts?: { encryptedOnly?: boolean }): Promise<{ attachment: Attachment; caption: string }>;
}

export type PollOutcome =
  | null
  | { deliverTo: string[]; via: "room" | "control"; message: InboundMessage }
  | { handled: true };

export interface RouterPolls {
  ownerEvent(roomId: string, event: any): Promise<PollOutcome>;
}

export interface RouterReactions {
  receipt(roomId: string, eventId: string, emoji: ReceiptEmoji): void;
  rememberDelivery(agentKey: string, roomId: string, eventId: string): void;
  /** `verified`: true only for a decrypted reaction that passed the owner trust check. */
  ownerReaction(roomId: string, event: any, verified?: boolean): Promise<void>;
}

export interface RouterUpdates {
  command(roomId: string, eventId: string, target?: string): void;
}

export interface RouterDeps {
  config: Pick<Config, "owner" | "botUser">;
  log: Logger;
  matrix: RouterMatrix;
  trust: RouterTrust;
  rooms: RouterRooms;
  registry: RouterRegistry;
  media: RouterMedia;
  polls: RouterPolls;
  reactions: RouterReactions;
  updates: RouterUpdates;
  notify: { system(text: string): void };
}

export interface Origin {
  roomId: string;
  eventId: string;
}

export const POLL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "m.poll.start",
  "org.matrix.msc3381.poll.start",
  "m.poll.response",
  "org.matrix.msc3381.poll.response",
  "m.poll.end",
  "org.matrix.msc3381.poll.end",
]);

const TEXT_TYPES = new Set(["m.text", "m.notice", "m.emote"]);
const MEDIA_TYPES = new Set(["m.image", "m.file", "m.video", "m.audio"]);
const MAX_CONTROL_MESSAGES = 1000;
const OFFLINE_NOTICE = "Agent is offline. Message was not delivered.";
const CONTROL_HINT = "Message in the control room ignored: start it with @<agent>, @all, @list or @update.";
/** Largest accepted `u=` (uncertainty) in a geo URI, in metres; larger values are ignored. */
const MAX_ACCURACY_M = 1e7;
const FORWARDED_REASON = "key forwarded; message not trusted";
const SENDER_MISMATCH_REASON = "session belongs to another user; message not trusted";
const REPLAY_LOG_REASON = "replay log cannot be written";

export interface ParsedLocation {
  lat: number;
  lon: number;
  accuracy_m?: number;
  description?: string;
  text: string;
}

/** Parses an m.location message; null if the geo URI is missing or invalid. */
export function parseLocation(content: Record<string, any>): ParsedLocation | null {
  const loc = content["m.location"] && typeof content["m.location"] === "object" ? content["m.location"] : {};
  const uri = (typeof loc.uri === "string" ? loc.uri : typeof content.geo_uri === "string" ? content.geo_uri : "").trim();
  const m = uri.match(/^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,-?\d+(?:\.\d+)?)?((?:;[^;]*)*)$/i);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
  const u = m[3].match(/;u=(\d+(?:\.\d+)?)/i);
  const uval = u ? Number(u[1]) : NaN;
  const accuracy = Number.isFinite(uval) && uval <= MAX_ACCURACY_M ? uval : undefined;
  // Some clients put the raw geo URI into body; only a non-geo body is a description.
  let description: string | undefined;
  if (typeof loc.description === "string" && loc.description.trim()) description = loc.description.trim();
  else if (typeof content.body === "string" && content.body.trim() && !/geo:/i.test(content.body)) description = content.body.trim();
  const acc = accuracy !== undefined ? ` (accuracy ${accuracy < 10 ? Number(accuracy.toFixed(1)) : Math.round(accuracy)} m)` : "";
  const text = `[location] ${lat}, ${lon}${acc}` + (description ? `\n${description}` : "");
  const out: ParsedLocation = { lat, lon, text };
  if (accuracy !== undefined) out.accuracy_m = accuracy;
  if (description) out.description = description;
  return out;
}

function fmtSince(ms: number): string {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "-";
}

/** One line per connected agent: name · machine · version · connected since. */
export function formatAgentList(links: AgentLink[]): string {
  if (!links.length) return "No agents connected.";
  return links.map((l) => `${l.name} · ${l.machine} · ${l.version || "-"} · ${fmtSince(l.since)}`).join("\n");
}

export class Router {
  private readonly deps: RouterDeps;
  private readonly log: Logger;
  /** Event ids of control-room messages the daemon itself sent for an agent (status/ask/approval) -> agent key. */
  private readonly controlMessages = new Map<string, string>();
  /** Tail of the per-room chain of owner events, so each agent gets them in room order. */
  private readonly roomQueues = new Map<string, Promise<void>>();

  constructor(deps: RouterDeps) {
    this.deps = deps;
    this.log = deps.log;
  }

  /** Registers both handlers on matrix; returns an unsubscribe function. Use this or the handlers, not both. */
  attach(): () => void {
    const a = this.deps.matrix.onDecrypted(this.handleDecrypted);
    const b = this.deps.matrix.onPlainEvent(this.handlePlain);
    return () => {
      a();
      b();
    };
  }

  /** Remembers which agent sent a bot message in the control room (status/ask) for reply routing. */
  rememberControlMessage(eventId: string, key: string): void {
    this.controlMessages.delete(eventId);
    this.controlMessages.set(eventId, agentKey(key));
    if (this.controlMessages.size > MAX_CONTROL_MESSAGES) {
      this.controlMessages.delete(this.controlMessages.keys().next().value!);
    }
  }

  /** Sends to the agent's link, then 👀 + remembers the delivery; 💤 if the agent is not connected. */
  deliver(key: string, message: InboundMessage, origin: Origin): boolean {
    const k = agentKey(key);
    if (!this.send(k, message)) {
      this.deps.reactions.receipt(origin.roomId, origin.eventId, "💤");
      return false;
    }
    this.deps.reactions.receipt(origin.roomId, origin.eventId, "👀");
    this.deps.reactions.rememberDelivery(k, origin.roomId, origin.eventId);
    return true;
  }

  readonly handlePlain: EventHandler = async (roomId, event) => {
    if (event.type !== "m.reaction" || event.sender !== this.deps.config.owner) return;
    try {
      await this.deps.reactions.ownerReaction(roomId, event);
    } catch (e) {
      this.log.warn("owner reaction failed:", (e as Error)?.name ?? "error");
    }
  };

  /** Handles one decrypted event after all earlier events of the same room (keeps delivery order per agent). */
  readonly handleDecrypted: EventHandler = (roomId, event) => {
    const prev = this.roomQueues.get(roomId) ?? Promise.resolve();
    const next = prev.then(async () => {
      try {
        await this.decrypted(roomId, event);
      } catch (e) {
        this.log.error("event handling failed", event.event_id, (e as Error)?.name ?? "error");
      }
    });
    this.roomQueues.set(roomId, next);
    void next.then(() => {
      if (this.roomQueues.get(roomId) === next) this.roomQueues.delete(roomId);
    });
    return next;
  };

  private send(key: string, message: InboundMessage): boolean {
    const link = this.deps.registry.get(key);
    if (!link || !link.alive()) return false;
    try {
      link.send(message);
      return true;
    } catch (e) {
      this.log.warn("send to agent failed", key, (e as Error)?.name ?? "error");
      return false;
    }
  }

  private notice(roomId: string, body: string): Promise<void> {
    return this.deps.matrix.sendNotice(roomId, body).then(
      () => undefined,
      (e: Error) => this.log.warn("notice failed", roomId, e),
    );
  }

  private typing(roomId: string): void {
    try {
      this.deps.matrix.setTyping(roomId, true);
    } catch {
      // best effort
    }
  }

  private async decrypted(roomId: string, event: MatrixEvent): Promise<void> {
    const { config, rooms, matrix } = this.deps;
    // replay keys are recorded only below, after the owner check, so other senders cannot fill the store
    if (matrix.isReplay(event.mxa_replay_key)) {
      this.log.warn("dropped replayed or unidentifiable event", event.event_id);
      return;
    }
    if (event.sender !== config.owner) {
      if (event.sender !== config.botUser) this.log.debug("ignored event from", event.sender, "in", roomId);
      return;
    }
    const isPoll = POLL_EVENT_TYPES.has(event.type);
    if (event.type !== "m.room.message" && event.type !== "m.reaction" && !isPoll) return;
    const agent = rooms.roomToAgent(roomId);
    const isControl = roomId === rooms.controlRoomId;
    if (!agent && !isControl) return;
    if (!event.content || typeof event.content !== "object") return;

    let reason: string | null = null;
    const sender = event.mxa_sender;
    // a forwarded or backed-up room key only claims its sender key, so the device binding proves nothing
    if (sender?.forwarded === true) reason = FORWARDED_REASON;
    else if (sender?.userId != null && sender.userId !== event.sender) reason = SENDER_MISMATCH_REASON;
    else {
      try {
        reason = await this.deps.trust.check(sender?.device, sender?.curveKey);
      } catch (e) {
        this.log.warn("trust check failed", event.event_id, (e as Error)?.name ?? "error");
        reason = "owner verification failed";
      }
    }
    if (!reason) {
      // checked and recorded synchronously (no await in between), so a queued duplicate cannot pass as well
      try {
        if (!matrix.recordReplay(event.mxa_replay_key)) {
          this.log.warn("dropped replayed event", event.event_id);
          return;
        }
      } catch (e) {
        this.log.error("replay log failed", event.event_id, (e as Error)?.name ?? "error");
        reason = REPLAY_LOG_REASON;
      }
    }
    if (reason) {
      this.log.warn("rejected owner event", event.event_id, reason);
      if (agent) await this.notice(roomId, `Not delivered: ${reason}.`);
      else this.deps.notify.system(`Message in the control room not delivered: ${reason}.`);
      return;
    }

    if (event.type === "m.reaction") {
      await this.deps.reactions.ownerReaction(roomId, event, true);
      return;
    }
    if (isPoll) {
      await this.poll(roomId, event, agent);
      return;
    }
    if (agent) await this.agentRoomMessage(roomId, agent, event);
    else await this.controlMessage(roomId, event);
  }

  private async poll(roomId: string, event: MatrixEvent, agent: string | undefined): Promise<void> {
    const out = await this.deps.polls.ownerEvent(roomId, event);
    if (!out || "handled" in out) return;
    const origin = { roomId, eventId: event.event_id };
    if (out.via === "room") {
      const target = out.deliverTo[0] ?? agent;
      if (!target || !this.deliver(target, out.message, origin)) {
        if (!target) this.deps.reactions.receipt(roomId, event.event_id, "💤");
        await this.notice(roomId, OFFLINE_NOTICE);
      }
      return;
    }
    this.fanOut(out.deliverTo, out.message, origin, "Control-room poll");
  }

  private baseMessage(event: MatrixEvent, via: "room" | "control"): Pick<InboundMessage, "type" | "sender" | "via" | "event_id"> {
    return { type: "message", sender: event.sender, via, event_id: event.event_id };
  }

  /** Text body of an m.room.message, using m.new_content for edits. */
  private textBody(content: Record<string, any>): string | null {
    const rel = content["m.relates_to"];
    if (rel?.rel_type === "m.replace") {
      const nc = content["m.new_content"];
      if (!nc || typeof nc.body !== "string" || !TEXT_TYPES.has(nc.msgtype)) return null;
      const t = nc.body.trim();
      return t ? `[edited] ${t}` : null;
    }
    if (typeof content.body !== "string") return null;
    const body = rel?.["m.in_reply_to"] ? stripReplyFallback(content.body, content.formatted_body) : content.body.trim();
    return body || null;
  }

  private async agentRoomMessage(roomId: string, key: string, event: MatrixEvent): Promise<void> {
    const content = event.content;
    const msgtype = content.msgtype;
    const origin = { roomId, eventId: event.event_id };
    let message: InboundMessage;

    // edits are delivered only for text; a caption or location edit would otherwise arrive as a new attachment
    if (content["m.relates_to"]?.rel_type === "m.replace" && !TEXT_TYPES.has(msgtype)) {
      this.log.debug("ignored edit of non-text message", event.event_id);
      return;
    }

    if (msgtype === "m.location") {
      const loc = parseLocation(content);
      if (!loc) {
        this.deps.reactions.receipt(roomId, event.event_id, "💤");
        await this.notice(roomId, "Location not delivered: invalid geo URI.");
        return;
      }
      message = { ...this.baseMessage(event, "room"), kind: "location", text: loc.text, lat: loc.lat, lon: loc.lon };
      if (loc.accuracy_m !== undefined) message.accuracy_m = loc.accuracy_m;
      if (loc.description !== undefined) message.description = loc.description;
    } else if (MEDIA_TYPES.has(msgtype)) {
      if (!this.deps.registry.get(key)?.alive()) {
        this.deps.reactions.receipt(roomId, event.event_id, "💤");
        await this.notice(roomId, "Agent is offline. Attachment was not delivered.");
        return;
      }
      let fetched: { attachment: Attachment; caption: string };
      try {
        // decrypted events come from encrypted rooms: a plain `url` could be swapped by the homeserver
        fetched = await this.deps.media.fetch(content, { encryptedOnly: true });
      } catch (e) {
        // only MediaError texts are written for the owner; anything else may carry internal details
        const known = e instanceof MediaError;
        this.log.warn("attachment failed", event.event_id, known ? "MediaError" : ((e as Error)?.name ?? "error"));
        this.deps.reactions.receipt(roomId, event.event_id, "💤");
        await this.notice(roomId, `Attachment not delivered: ${known ? (e as Error).message : "internal error"}`);
        return;
      }
      message = { ...this.baseMessage(event, "room"), kind: "attachment", text: fetched.caption, attachment: fetched.attachment };
    } else if (TEXT_TYPES.has(msgtype)) {
      const text = this.textBody(content);
      if (!text) return;
      message = { ...this.baseMessage(event, "room"), kind: "text", text };
    } else {
      this.log.debug("ignored msgtype in agent room", event.event_id);
      return;
    }

    if (this.deliver(key, message, origin)) this.typing(roomId);
    else await this.notice(roomId, message.kind === "attachment" ? "Agent is offline. Attachment was not delivered." : OFFLINE_NOTICE);
  }

  /**
   * Agent behind a control-room message the daemon sent itself. The reply relation is not covered by the
   * owner check (a homeserver can change it), so only ids from the in-memory map count; there is no lookup.
   */
  private replyTarget(eventId: string): string | undefined {
    return this.controlMessages.get(eventId);
  }

  /** Names a target in a notice only if it is a known agent; otherwise the owner's text is not repeated. */
  private knownName(key: string): string | undefined {
    const link = this.deps.registry.get(key);
    if (link) return link.name;
    return this.deps.rooms.agentRoom(key) ? key : undefined;
  }

  private async controlMessage(roomId: string, event: MatrixEvent): Promise<void> {
    const content = event.content;
    if (!TEXT_TYPES.has(content.msgtype)) {
      this.deps.notify.system("Only text commands, replies and polls are handled in the control room.");
      return;
    }
    const rel = content["m.relates_to"];
    const isEdit = rel?.rel_type === "m.replace";
    let raw: string | null;
    if (isEdit) {
      const nc = content["m.new_content"];
      raw = nc && typeof nc.body === "string" && TEXT_TYPES.has(nc.msgtype) ? nc.body.trim() || null : null;
    } else raw = this.textBody(content);
    if (!raw) return;
    const origin = { roomId, eventId: event.event_id };
    const label = (t: string) => (isEdit ? `[edited] ${t}` : t);

    const names = this.deps.registry.list().map((l) => l.name);
    // room mentions never broadcast edits; an explicit leading @command always wins over the reply relation
    const cmd = parseControlCommand(raw, { mentionsRoom: !isEdit && content["m.mentions"]?.room === true, names });
    const explicit = cmd.type !== "unknown" && raw.startsWith("@");

    const replyTo = rel?.["m.in_reply_to"]?.event_id;
    if (!explicit && !isEdit && typeof replyTo === "string") {
      const target = this.replyTarget(replyTo);
      if (target) {
        const msg: InboundMessage = { ...this.baseMessage(event, "control"), kind: "text", text: raw };
        if (!this.deliver(target, msg, origin)) this.deps.notify.system(`Reply not delivered, not connected: ${this.knownName(target) ?? target}`);
        return;
      }
    }

    switch (cmd.type) {
      case "list":
        if (isEdit) return;
        await this.notice(roomId, formatAgentList(this.deps.registry.list()));
        return;
      case "update":
        if (isEdit) return;
        this.deps.updates.command(roomId, event.event_id, cmd.target);
        return;
      case "direct": {
        const msg: InboundMessage = { ...this.baseMessage(event, "control"), kind: "text", text: label(cmd.text) };
        if (!this.deliver(cmd.target, msg, origin)) {
          const name = this.knownName(cmd.target);
          this.deps.notify.system(name ? `Control-room message not delivered, not connected: ${name}` : "Control-room message not delivered: unknown agent.");
        }
        return;
      }
      case "broadcast": {
        const msg: InboundMessage = { ...this.baseMessage(event, "control"), kind: "text", text: label(cmd.text) };
        this.fanOut(this.deps.registry.list().map((l) => l.key), msg, origin, "Control-room message");
        return;
      }
      default:
        if (!isEdit) this.deps.notify.system(CONTROL_HINT);
    }
  }

  /** Delivers to several agents with a single 👀 (or 💤 when nobody got it). */
  private fanOut(keys: string[], message: InboundMessage, origin: Origin, what: string): void {
    const targets = [...new Set(keys.map(agentKey))];
    const delivered: string[] = [];
    const missed: string[] = [];
    for (const k of targets) (this.send(k, message) ? delivered : missed).push(k);
    for (const k of delivered) this.deps.reactions.rememberDelivery(k, origin.roomId, origin.eventId);
    this.deps.reactions.receipt(origin.roomId, origin.eventId, delivered.length ? "👀" : "💤");
    if (!targets.length) this.deps.notify.system(`${what} not delivered: no agents connected.`);
    else if (missed.length) this.deps.notify.system(`${what} not delivered, not connected: ${missed.join(", ")}`);
  }
}
