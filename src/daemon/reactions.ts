// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import { isDuplicateAnnotation } from "./matrix.ts";
import type { Matrix, MatrixEvent } from "./matrix.ts";
import type { RoomManager } from "./rooms.ts";
import type { AgentRegistry } from "./registry.ts";
import type { Logger } from "./log.ts";
import type { InboundMessage } from "../protocol/messages.ts";

export type ReactionsMatrix = Pick<Matrix, "sendRaw" | "sendMessage" | "owner">;
export type ReactionsRooms = Pick<RoomManager, "controlRoomId" | "roomToAgent">;
export type ReactionsRegistry = Pick<AgentRegistry, "get">;

export interface ReactionsDeps {
  matrix: ReactionsMatrix;
  rooms: ReactionsRooms;
  registry: ReactionsRegistry;
  log: Logger;
}

export const MAX_EMOJI_LENGTH = 32;
const MAX_BOT_MESSAGES = 1000;
const MAX_SUMMARIES = 200;
const MAX_DELIVERIES = 1000;
const MAX_TARGET_TEXT = 2000;
const SNIPPET_LENGTH = 120;
// Control and format characters (bidi overrides, zero-width, tag characters), line/paragraph
// separators and `"` (would end the quoted snippet in daemon-authored text). ZWJ (U+200D) stays
// allowed because emoji sequences (family, rainbow flag) need it.
const UNSAFE_KEY = /["\p{Cc}\u2028\u2029]|(?![\u200d])\p{Cf}/u;

/** True if `key` is usable as a reaction key in text the daemon shows to agents or the owner. */
export function safeReactionKey(key: string): boolean {
  return key.length > 0 && key.length <= MAX_EMOJI_LENGTH && !UNSAFE_KEY.test(key);
}

interface Summary {
  names: string[];
  noticeId?: string;
  chain: Promise<void>;
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as K);
}

/**
 * Reactions in both directions.
 *
 * Wiring: `matrix.onSent((roomId, eventId, content) => reactions.rememberBotMessage(roomId, eventId,
 * typeof content.body === "string" ? content.body : ""))` so owner reactions can be matched to the
 * agent whose message they target without fetching the event.
 */
export class Reactions {
  private readonly matrix: ReactionsMatrix;
  private readonly rooms: ReactionsRooms;
  private readonly registry: ReactionsRegistry;
  private readonly log: Logger;
  private readonly deliveries = new Map<string, { roomId: string; eventId: string }>(); // agent key -> latest owner message
  private readonly botMessages = new Map<string, { roomId: string; agentKey: string; text: string }>(); // bot event id
  private readonly summaries = new Map<string, Summary>(); // `${eventId}|${label}`

  constructor(deps: ReactionsDeps) {
    this.matrix = deps.matrix;
    this.rooms = deps.rooms;
    this.registry = deps.registry;
    this.log = deps.log;
  }

  /** Unencrypted m.reaction (clients aggregate those on the target). Never throws. */
  async receipt(roomId: string, eventId: string, emoji: string): Promise<void> {
    try {
      await this.matrix.sendRaw(roomId, "m.reaction", {
        "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key: emoji },
      });
    } catch (e) {
      // All agents share one bot user; Matrix allows one identical reaction per user and event.
      if (!isDuplicateAnnotation(e)) this.log.warn("reaction failed on", eventId, (e as Error)?.message ?? String(e));
    }
  }

  rememberDelivery(agentKey: string, roomId: string, eventId: string): void {
    setBounded(this.deliveries, agentKey, { roomId, eventId }, MAX_DELIVERIES);
  }

  /** Protocol `react`. Throws an Error with client-facing text on invalid input or no target. */
  async agentReact(agentKey: string, agentName: string, emoji: string): Promise<void> {
    const e = typeof emoji === "string" ? emoji.trim() : "";
    if (!e || e.length > MAX_EMOJI_LENGTH) throw new Error("emoji required");
    if (!safeReactionKey(e)) throw new Error("emoji must not contain quotes, control or formatting characters");
    if (/[\[\]]/.test(e)) throw new Error("emoji must not contain brackets"); // would mimic "[name]" routing prefixes
    const last = this.deliveries.get(agentKey);
    if (!last) throw new Error("no message from the owner to react to yet");
    await this.receipt(last.roomId, last.eventId, e);
    if (last.roomId === this.rooms.controlRoomId) await this.summarize(last.eventId, e, agentName);
  }

  /**
   * Shared control-room messages can show each emoji only once for the bot user, so one notice per
   * (event, label) replies to the event and is edited as more agents are added ("👍 a, b").
   * `previousLabel` (a changed vote) removes the agent from that label's notice first.
   */
  summarize(eventId: string, label: string, agentName: string, previousLabel?: string): Promise<void> {
    const roomId = this.rooms.controlRoomId;
    if (!roomId) return Promise.resolve();
    if (previousLabel !== undefined && previousLabel !== label) {
      const old = this.summaries.get(`${eventId}|${previousLabel}`);
      const i = old ? old.names.indexOf(agentName) : -1;
      if (old && i >= 0) {
        old.names.splice(i, 1);
        this.render(old, roomId, eventId, previousLabel);
      }
    }
    const key = `${eventId}|${label}`;
    let entry = this.summaries.get(key);
    if (!entry) {
      entry = { names: [], chain: Promise.resolve() };
      setBounded(this.summaries, key, entry, MAX_SUMMARIES);
    }
    if (entry.names.includes(agentName)) return entry.chain;
    entry.names.push(agentName);
    return this.render(entry, roomId, eventId, label);
  }

  /** Sends or edits the notice. Serialized per entry so concurrent calls edit one notice instead of creating several. */
  private render(s: Summary, roomId: string, eventId: string, label: string): Promise<void> {
    s.chain = s.chain.then(async () => {
      if (!s.noticeId && !s.names.length) return;
      const body = `${label} ${s.names.length ? s.names.join(", ") : "(none)"}`;
      try {
        if (!s.noticeId) {
          const r = await this.matrix.sendMessage(roomId, {
            msgtype: "m.notice",
            body,
            "m.relates_to": { "m.in_reply_to": { event_id: eventId } },
          });
          if (r.eventId) s.noticeId = r.eventId;
        } else {
          await this.matrix.sendMessage(roomId, {
            msgtype: "m.notice",
            body: `* ${body}`,
            "m.new_content": { msgtype: "m.notice", body },
            "m.relates_to": { rel_type: "m.replace", event_id: s.noticeId },
          });
        }
      } catch (err) {
        this.log.warn("reaction summary failed for", eventId, (err as Error)?.message ?? String(err));
      }
    });
    return s.chain;
  }

  /** Feed from matrix.onSent. Only messages in agent rooms are remembered. */
  rememberBotMessage(roomId: string, eventId: string, text: string): void {
    const agentKey = this.rooms.roomToAgent(roomId);
    if (!agentKey) return;
    const t = typeof text === "string" ? text.slice(0, MAX_TARGET_TEXT) : "";
    setBounded(this.botMessages, eventId, { roomId, agentKey, text: t }, MAX_BOT_MESSAGES);
  }

  /**
   * Owner reaction (plain or decrypted m.reaction) on a bot message in an agent room → that agent.
   * `verified` = the reaction was encrypted and passed the owner trust check; plain reactions can be
   * forged by the homeserver and are forwarded with `verified: false`.
   */
  async ownerReaction(roomId: string, event: MatrixEvent, verified = false): Promise<void> {
    if (event.type !== "m.reaction" || event.sender !== this.matrix.owner) return;
    const rel = event.content?.["m.relates_to"];
    if (!rel || typeof rel !== "object" || rel.rel_type !== "m.annotation") return;
    const targetId = rel.event_id;
    const emoji = rel.key;
    if (typeof targetId !== "string" || !targetId || typeof emoji !== "string" || !emoji) return;
    // Keys can be forged: line breaks, quotes or invisible characters could fake text in `text`.
    if (!safeReactionKey(emoji)) return;

    // Only targets the daemon sent itself in this run: a fetched event could be altered by the homeserver.
    const target = this.botMessages.get(targetId);
    if (!target) {
      this.log.debug("reaction target unknown, ignored", targetId);
      return;
    }
    if (target.roomId !== roomId) return;

    const link = this.registry.get(target.agentKey);
    if (!link || !link.alive()) {
      this.log.debug("reaction not forwarded, agent offline:", target.agentKey);
      return;
    }
    const snippet = target.text.length > SNIPPET_LENGTH ? target.text.slice(0, SNIPPET_LENGTH - 3) + "..." : target.text;
    const msg: InboundMessage = {
      type: "message",
      kind: "reaction",
      text: `[reaction] Owner reacted ${emoji}${verified ? "" : " (unverified)"} to your message: "${snippet}"`,
      sender: event.sender,
      via: "room",
      event_id: event.event_id,
      emoji,
      target_text: target.text,
      verified,
    };
    link.send(msg);
    this.log.debug("forwarded reaction", event.event_id, "to", target.agentKey);
  }
}
