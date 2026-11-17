// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatrixClient } from "matrix-bot-sdk";
import type { Config } from "./config.ts";
import { emptyRooms, type StateStore, type RoomEntry } from "./state.ts";
import type { Logger } from "./log.ts";
import { agentKey } from "./registry.ts";

/** The MatrixClient methods this module uses (lets tests pass a fake). */
export type RoomsClient = Pick<
  MatrixClient,
  "createRoom" | "sendStateEvent" | "getJoinedRooms" | "joinRoom" | "leaveRoom" | "getRoomStateEvent" | "getJoinedRoomMembers" | "inviteUser"
>;

export interface RoomsDeps {
  client: RoomsClient;
  config: Config;
  state: StateStore;
  log: Logger;
}

const ROOM_VERSION = "11";
const MEGOLM = "m.megolm.v1.aes-sha2";

/** Thrown when MXA_CONTROL_ROOM_ID names a room that is not safe to use. */
export class UnsafeRoomError extends Error {
  readonly problems: string[];
  constructor(roomId: string, problems: string[]) {
    super(`room ${roomId} is not safe to use: ${problems.join("; ")}`);
    this.name = "UnsafeRoomError";
    this.problems = problems;
  }
}

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export class RoomManager {
  private readonly client: RoomsClient;
  private readonly config: Config;
  private readonly state: StateStore;
  private readonly log: Logger;
  private readonly pending = new Map<string, Promise<string>>();
  private controlRejected = false;

  constructor(deps: RoomsDeps) {
    this.client = deps.client;
    this.config = deps.config;
    this.state = deps.state;
    this.log = deps.log;
    // rooms must not have a prototype: agent names like "__proto__" would otherwise change it
    const rooms = this.state.data.rooms;
    if (!rooms || typeof rooms !== "object") this.state.data.rooms = emptyRooms();
    else if (Object.getPrototypeOf(rooms) !== null) this.state.data.rooms = Object.assign(emptyRooms(), rooms);
  }

  private room(key: string): RoomEntry | undefined {
    return hasOwn(this.state.data.rooms, key) ? this.state.data.rooms[key] : undefined;
  }

  get spaceId(): string {
    return this.config.spaceId;
  }

  /**
   * Control room id: MXA_CONTROL_ROOM_ID (undefined if ensureControlRoom found it unsafe), else the one stored
   * in state (after ensureControlRoom).
   */
  get controlRoomId(): string | undefined {
    if (this.config.controlRoomId) return this.controlRejected ? undefined : this.config.controlRoomId;
    return this.state.data.controlRoomId;
  }

  get systemRoomId(): string | undefined {
    return this.state.data.systemRoomId;
  }

  /** Room id of a known agent room, by agent key. */
  agentRoom(key: string): string | undefined {
    return this.room(key)?.roomId;
  }

  /** Agent key for an agent room id, or undefined (control/system/unknown rooms). */
  roomToAgent(roomId: string): string | undefined {
    for (const [key, r] of Object.entries(this.state.data.rooms)) if (r.roomId === roomId) return key;
    return undefined;
  }

  /** All known agent rooms (key -> entry), including rooms of agents that are offline. */
  agentRooms(): Record<string, RoomEntry> {
    return Object.assign(emptyRooms(), this.state.data.rooms);
  }

  /** Joins the space and a configured control room (errors are logged, not thrown). Call once after start. */
  async joinConfigured(): Promise<void> {
    const via = [this.config.serverName];
    await this.client.joinRoom(this.config.spaceId, via).catch((e: Error) => this.log.warn("joining space failed:", e.message));
    if (this.config.controlRoomId)
      await this.client.joinRoom(this.config.controlRoomId, via).catch((e: Error) => this.log.warn("joining control room failed:", e.message));
  }

  /**
   * Returns the agent's room, creating it (encrypted, in the space, owner invited) if unknown or if the bot
   * is no longer joined. Concurrent calls for the same agent share one creation. Saves state.
   */
  ensureAgentRoom(name: string): Promise<string> {
    const key = agentKey(name);
    const running = this.pending.get(key);
    if (running) return running;
    const p = (async () => {
      const known = this.room(key);
      if (known && (await this.client.getJoinedRooms()).includes(known.roomId)) {
        if (known.name !== name) {
          known.name = name;
          this.state.save();
        }
        await this.reinviteOwner(known.roomId);
        return known.roomId;
      }
      if (known) await this.unlinkFromSpace(known.roomId);
      const roomId = await this.createSpaceRoom(name, `Agent "${name}"`);
      this.state.data.rooms[key] = { roomId, name };
      this.state.save();
      return roomId;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }

  /** Ensures the system room (daemon notices). Saves state. */
  async ensureSystemRoom(): Promise<string> {
    const id = this.state.data.systemRoomId;
    if (id && (await this.client.getJoinedRooms()).includes(id)) {
      await this.reinviteOwner(id);
      return id;
    }
    if (id) await this.unlinkFromSpace(id);
    const roomId = await this.createSpaceRoom("system", "Bridge daemon notices");
    this.state.data.systemRoomId = roomId;
    this.state.save();
    return roomId;
  }

  /**
   * Ensures the control room. With MXA_CONTROL_ROOM_ID it joins that room and verifies it (Megolm-encrypted,
   * invite-only, no guests, only bot and owner joined); an unsafe room throws UnsafeRoomError and
   * controlRoomId stays undefined. Otherwise it reuses the room stored in state or creates one named
   * "control" in the space. Saves state.
   */
  async ensureControlRoom(): Promise<string> {
    const configured = this.config.controlRoomId;
    if (configured) {
      this.controlRejected = true;
      await this.client.joinRoom(configured, [this.config.serverName]);
      const problems = await this.checkRoom(configured);
      if (problems.length) throw new UnsafeRoomError(configured, problems);
      this.controlRejected = false;
      return configured;
    }
    const id = this.state.data.controlRoomId;
    if (id && (await this.client.getJoinedRooms()).includes(id)) {
      await this.reinviteOwner(id);
      return id;
    }
    if (id) await this.unlinkFromSpace(id);
    const roomId = await this.createSpaceRoom("control", "mxagent control room");
    this.state.data.controlRoomId = roomId;
    this.state.save();
    return roomId;
  }

  /** Sets the bot's display name in one room (agent rooms show the agent's name). Best effort. */
  async setDisplayName(roomId: string, displayName: string): Promise<void> {
    await this.client
      .sendStateEvent(roomId, "m.room.member", this.config.botUser, { membership: "join", displayname: displayName })
      .catch((e: Error) => this.log.debug("display name failed", roomId, e.message));
  }

  /**
   * Unlinks an agent room from the space, leaves it and forgets it in state. Does not check whether the agent
   * is connected (callers decide). Returns the removed entry, or null if the key is unknown.
   */
  async removeAgentRoom(key: string): Promise<RoomEntry | null> {
    const entry = this.room(key);
    if (!entry) return null;
    await this.unlinkFromSpace(entry.roomId);
    await this.client
      .sendStateEvent(entry.roomId, "m.space.parent", this.config.spaceId, {})
      .catch((e: Error) => this.log.debug("removing space parent failed:", e.message));
    await this.client.leaveRoom(entry.roomId).catch((e: Error) => this.log.warn("leaving room failed:", e.message));
    delete this.state.data.rooms[key];
    this.state.save();
    this.log.info("removed room", entry.roomId);
    return entry;
  }

  /**
   * Problems that make a room unsafe for agent traffic (empty list = fine). A failed lookup counts as a
   * problem: the room is only used once all checks have passed.
   */
  async checkRoom(roomId: string): Promise<string[]> {
    const problems: string[] = [];
    const state = (type: string) => this.client.getRoomStateEvent(roomId, type, "").then((c: any) => c ?? null, (e: any) => (notFound(e) ? null : Promise.reject(e)));
    try {
      const enc = await state("m.room.encryption");
      if (enc?.algorithm !== MEGOLM) problems.push("not end-to-end encrypted");
      const jr = await state("m.room.join_rules");
      if (jr?.join_rule !== "invite") problems.push(`join rule is ${typeof jr?.join_rule === "string" ? jr.join_rule : "unknown"}, not invite`);
      const ga = await state("m.room.guest_access");
      if (ga && ga.guest_access !== "forbidden") problems.push("guests can join");
    } catch (e) {
      problems.push(`room state could not be read (${(e as Error).message})`);
    }
    try {
      const members = await this.client.getJoinedRoomMembers(roomId);
      const extra = members.filter((m) => m !== this.config.botUser && m !== this.config.owner);
      if (extra.length) problems.push(`${extra.length} member(s) besides bot and owner`);
    } catch (e) {
      // Matrix.client refuses member lists with strangers itself (SendRefusedError)
      problems.push((e as Error).name === "SendRefusedError" ? "members besides bot and owner" : `members could not be read (${(e as Error).message})`);
    }
    return problems;
  }

  /** Invites the owner again if they left the room (rooms are invite-only, so they could not rejoin). */
  private async reinviteOwner(roomId: string): Promise<void> {
    let membership: string | undefined;
    try {
      const m = (await this.client.getRoomStateEvent(roomId, "m.room.member", this.config.owner)) as { membership?: unknown } | null;
      membership = typeof m?.membership === "string" ? m.membership : undefined;
    } catch (e) {
      if (!notFound(e)) {
        this.log.debug("owner membership lookup failed", roomId, (e as Error).message);
        return;
      }
    }
    if (membership === "join" || membership === "invite") return;
    if (membership === "ban") {
      this.log.warn("owner is banned from", roomId);
      return;
    }
    await this.client
      .inviteUser(this.config.owner, roomId)
      .then(() => this.log.info("re-invited owner to", roomId))
      .catch((e: Error) => this.log.warn("re-inviting owner failed:", roomId, e.message));
  }

  private async unlinkFromSpace(roomId: string): Promise<void> {
    await this.client
      .sendStateEvent(this.config.spaceId, "m.space.child", roomId, {})
      .catch((e: Error) => this.log.warn("unlinking room failed:", e.message));
  }

  private async createSpaceRoom(name: string, topic: string): Promise<string> {
    const { spaceId, owner, botUser, serverName } = this.config;
    const roomId = await this.client.createRoom({
      name,
      topic,
      preset: "private_chat",
      invite: [owner],
      room_version: ROOM_VERSION,
      initial_state: [
        { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
        // Invite-only: room keys are shared with every joined member, so only owner and bot may be in it.
        { type: "m.room.join_rules", state_key: "", content: { join_rule: "invite" } },
        { type: "m.room.history_visibility", state_key: "", content: { history_visibility: "invited" } },
        { type: "m.room.guest_access", state_key: "", content: { guest_access: "forbidden" } },
        { type: "m.space.parent", state_key: spaceId, content: { via: [serverName], canonical: true } },
      ],
      power_level_content_override: { users: { [botUser]: 100, [owner]: 100 } },
    });
    await this.client
      .sendStateEvent(spaceId, "m.space.child", roomId, { via: [serverName], suggested: false })
      .catch((e: Error) => this.log.warn("linking room into space failed:", e.message));
    this.log.info("created room", roomId);
    return roomId;
  }
}

function notFound(e: unknown): boolean {
  const err = e as { statusCode?: number; errcode?: string; body?: { errcode?: string } } | null;
  return err?.statusCode === 404 || err?.errcode === "M_NOT_FOUND" || err?.body?.errcode === "M_NOT_FOUND";
}
