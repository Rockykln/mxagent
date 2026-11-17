// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import { fingerprint } from "./fingerprint.ts";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sdk from "matrix-bot-sdk";
import type { MatrixClient } from "matrix-bot-sdk";
import { RoomId } from "@matrix-org/matrix-sdk-crypto-nodejs";
import type { Config, Paths } from "./config.ts";
import { fsyncDir, type StateStore } from "./state.ts";
import type { Logger } from "./log.ts";
import type { DeviceAudit, KeysQueryResponse } from "./trust.ts";

const { MatrixClient: MatrixClientCtor, SimpleFsStorageProvider, RustSdkCryptoStorageProvider, LogService, LogLevel, RoomEvent } = sdk;

export const MEGOLM = "m.megolm.v1.aes-sha2";

/** Sender identity of a decrypted event, as reported by the crypto machine. */
export interface SenderInfo {
  device: string | null;
  curveKey: string | null;
  /** User the crypto machine attributes the session to (untrusted unless the shield is clean). */
  userId?: string | null;
  /** Ed25519 key the session creator claimed. */
  claimedEd25519?: string | null;
  /** True if the room key arrived via m.forwarded_room_key: the sender key is then only claimed, not proven. */
  forwarded?: boolean;
  /** Strict shield state from the crypto library (color 2 = none/ok), null if unavailable. */
  shield?: { color: number; code: number | null } | null;
}

export interface MatrixEvent {
  event_id: string;
  sender: string;
  type: string;
  room_id?: string;
  state_key?: string;
  origin_server_ts?: number;
  content: Record<string, any>;
  unsigned?: Record<string, unknown>;
  /** Present only on events that were decrypted by the sync loop of this daemon. */
  mxa_sender?: SenderInfo;
  /** Replay key (room, Megolm session, message index) of a decrypted event; see Matrix.recordReplay. */
  mxa_replay_key?: string;
}

export type EventHandler = (roomId: string, event: MatrixEvent) => void | Promise<void>;

/** The parts of the crypto library's DecryptedRoomEvent used here (lets tests pass a plain object). */
export interface DecryptedLike {
  readonly event: string;
  readonly sender?: { toString(): string } | null;
  readonly senderDevice?: { toString(): string } | null;
  readonly senderCurve25519Key?: string | null;
  readonly senderClaimedEd25519Key?: string | null;
  readonly forwardingCurve25519KeyChain?: string[];
  shieldState?(strict: boolean): { color: number; code?: number } | null;
}

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MEGOLM_VERSION = 3;
const MEGOLM_MAC_LEN = 8;
const MEGOLM_SIG_LEN = 64;
const MAX_CIPHERTEXT_CHARS = 1 << 20;

/** Reads a protobuf varint of at most 7 bytes (enough for a u32 index and any length here); null if invalid. */
function readVarint(buf: Buffer, pos: number, end: number): { value: number; next: number } | null {
  let value = 0;
  for (let i = 0; i < 7; i++) {
    if (pos + i >= end) return null;
    const b = buf[pos + i]!;
    value += (b & 0x7f) * 2 ** (7 * i);
    if ((b & 0x80) === 0) return { value, next: pos + i + 1 };
  }
  return null;
}

/**
 * Message index of a Megolm v1 message: base64 (padded or not) of version byte 0x03, protobuf fields
 * (1 = varint message index, 2 = ciphertext bytes), 8-byte MAC and 64-byte signature. Null if the input is not
 * a well-formed Megolm message (duplicate or missing fields, unknown wire types, index above 2^32 - 1).
 */
export function megolmMessageIndex(ciphertext: unknown): number | null {
  if (typeof ciphertext !== "string" || ciphertext.length > MAX_CIPHERTEXT_CHARS || !B64_RE.test(ciphertext)) return null;
  const s = ciphertext.replace(/=+$/, "");
  if (s.length % 4 === 1) return null;
  const buf = Buffer.from(s, "base64");
  const end = buf.length - MEGOLM_MAC_LEN - MEGOLM_SIG_LEN;
  if (end < 1 || buf[0] !== MEGOLM_VERSION) return null;
  let pos = 1;
  let index: number | null = null;
  let body = false;
  while (pos < end) {
    const tag = readVarint(buf, pos, end);
    if (!tag) return null;
    pos = tag.next;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    if (wire === 0) {
      const v = readVarint(buf, pos, end);
      if (!v) return null;
      pos = v.next;
      if (field === 1) {
        if (index !== null || v.value > 0xffffffff) return null;
        index = v.value;
      } else if (field === 2) return null;
    } else if (wire === 2) {
      const len = readVarint(buf, pos, end);
      if (!len || len.next + len.value > end) return null;
      pos = len.next + len.value;
      if (field === 1) return null;
      if (field === 2) {
        if (body) return null;
        body = true;
      }
    } else return null;
  }
  return pos === end && index !== null && body ? index : null;
}

/**
 * Replay key of an encrypted event: hash over room id, Megolm session id and message index. A session id and
 * index identify exactly one message, whatever base64 form the homeserver relays. Null (event is dropped) if the
 * event is not Megolm or its ciphertext cannot be parsed.
 */
export function replayKey(roomId: string, raw: { content?: Record<string, unknown> } | null | undefined): string | null {
  const c = raw?.content;
  if (!c || c.algorithm !== MEGOLM) return null;
  const sid = typeof c.session_id === "string" ? c.session_id.replace(/=+$/, "") : "";
  if (!sid || !B64_RE.test(sid)) return null;
  const index = megolmMessageIndex(c.ciphertext);
  if (index === null) return null;
  return createHash("sha256").update(roomId).update("\0").update(sid).update("\0").update(String(index)).digest().subarray(0, 18).toString("base64url");
}

/** Builds the decrypted raw event: cleartext type/content plus `mxa_sender` and the replay key (null if unparsable). */
export function decryptedRaw(raw: Record<string, any>, roomId: string, d: DecryptedLike): Record<string, any> {
  const clear = JSON.parse(d.event);
  let shield: SenderInfo["shield"] = null;
  try {
    const s = d.shieldState?.(true);
    if (s) shield = { color: s.color, code: typeof s.code === "number" ? s.code : null };
  } catch {
    shield = null;
  }
  const mxa_sender: SenderInfo = {
    device: d.senderDevice?.toString() ?? null,
    curveKey: d.senderCurve25519Key ?? null,
    userId: d.sender?.toString() ?? null,
    claimedEd25519: d.senderClaimedEd25519Key ?? null,
    forwarded: (d.forwardingCurve25519KeyChain?.length ?? 0) > 0,
    shield,
  };
  return {
    ...raw,
    type: typeof clear.type === "string" && clear.type ? clear.type : "io.t2bot.unknown",
    content: clear.content && typeof clear.content === "object" ? clear.content : {},
    mxa_sender,
    mxa_replay_key: replayKey(roomId, raw),
  };
}

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Thrown by ReplayStore.add when a new key cannot be written to the log; the event must not be delivered. */
const TO_DEVICE_REQUEST = 3; // RequestType.ToDevice in matrix-sdk-crypto
const GOSSIP_REQUESTS = new Set(["m.room_key_request", "m.secret.request"]);

/** Removes room-key and secret requests from the to-device events of a sync before the crypto machine sees them. */
export function dropGossipRequests(toDevice: string, log?: { warn: (...a: unknown[]) => void }): string {
  let events: unknown;
  try {
    events = JSON.parse(toDevice);
  } catch {
    return toDevice;
  }
  if (!Array.isArray(events)) return toDevice;
  const kept = events.filter((e) => !GOSSIP_REQUESTS.has((e as { type?: unknown } | null)?.type as string));
  if (kept.length === events.length) return toDevice;
  log?.warn("ignored", events.length - kept.length, "key or secret request(s)");
  return JSON.stringify(kept);
}

/**
 * Keeps a to-device message only if it is Olm-encrypted to exactly the signed curve25519 key of an allowed
 * device. Checking the key, not just the device id, stops a homeserver from serving the crypto machine a forged
 * device under an allowed id.
 */
export function keepKeyBound(messages: unknown, allowedKeys: DeviceAudit["allowedKeys"]): { kept: Record<string, Record<string, unknown>>; removed: string[] } {
  const kept: Record<string, Record<string, unknown>> = {};
  const removed: string[] = [];
  const all = messages && typeof messages === "object" ? (messages as Record<string, unknown>) : {};
  for (const [user, devices] of Object.entries(all)) {
    const ok = allowedKeys.get(user);
    for (const [device, content] of Object.entries(devices && typeof devices === "object" ? devices : {})) {
      const want = device !== "*" ? ok?.get(device) : undefined;
      const c = content as { algorithm?: unknown; ciphertext?: unknown } | null;
      const recipients = c && typeof c.ciphertext === "object" && c.ciphertext !== null ? Object.keys(c.ciphertext) : [];
      const boundToKey = c?.algorithm === "m.olm.v1.curve25519-aes-sha2" && recipients.length === 1 && recipients[0] === want;
      if (want && boundToKey) (kept[user] ??= {})[device] = content;
      else removed.push(`${user} ${device}`);
    }
  }
  return { kept, removed };
}

export class ReplayLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayLogError";
  }
}

/**
 * Remembers replay keys of delivered owner events. Bounded (oldest dropped) and, with a file, persisted as an
 * append-only log (mode 0600) that is compacted when it grows to twice the cap, so a restart does not reopen
 * replays. Fails closed: a log that exists but cannot be read, is not a regular file or has a malformed line
 * makes the constructor throw; a failed append makes add() throw ReplayLogError (the key stays in memory).
 */
export class ReplayStore {
  readonly cap: number;
  private readonly file?: string;
  private readonly log?: Logger;
  private readonly keys = new Set<string>();
  private lines = 0;

  constructor(opts: { file?: string; cap?: number; log?: Logger } = {}) {
    this.cap = opts.cap ?? 50_000;
    this.file = opts.file;
    this.log = opts.log;
    if (this.file) this.load(this.file);
  }

  get size(): number {
    return this.keys.size;
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  /** Adds the key; false if it was already known (replay). Throws ReplayLogError if it cannot be persisted. */
  add(key: string): boolean {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    while (this.keys.size > this.cap) this.keys.delete(this.keys.values().next().value!);
    if (this.file) this.append(this.file, key);
    return true;
  }

  private load(file: string): void {
    const fail = (why: string): never => {
      throw new Error(`cannot read replay log ${file}: ${why}. Fix or remove the file (removing it lets old messages be replayed)`);
    };
    let text: string;
    try {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile()) fail("not a regular file");
        if ((st.mode & 0o077) !== 0) fs.fchmodSync(fd, 0o600);
        text = fs.readFileSync(fd, "utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      if ((e as Error).message.startsWith("cannot read replay log")) throw e;
      return fail((e as NodeJS.ErrnoException).code ?? (e as Error).message);
    }
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (const [i, line] of lines.entries()) {
      if (!KEY_RE.test(line)) fail(`malformed line ${i + 1}`);
      this.lines++;
      this.keys.delete(line);
      this.keys.add(line);
    }
    while (this.keys.size > this.cap) this.keys.delete(this.keys.values().next().value!);
  }

  private append(file: string, key: string): void {
    try {
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW, 0o600);
      try {
        fs.writeSync(fd, `${key}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      this.log?.error("cannot write replay log:", (e as Error).message);
      throw new ReplayLogError(`cannot write replay log: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
    }
    if (++this.lines > this.cap * 2) {
      try {
        this.compact(file);
      } catch (e) {
        this.log?.error("cannot compact replay log:", (e as Error).message);
      }
    }
  }

  private compact(file: string): void {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.rmSync(tmp, { force: true });
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeSync(fd, [...this.keys].join("\n") + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    fsyncDir(path.dirname(file));
    this.lines = this.keys.size;
  }
}

export interface SsoSession {
  userId: string;
  deviceId: string;
  accessToken: string;
}

export function readSsoSession(file: string, log?: Logger): SsoSession | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
    if ((fs.statSync(file).mode & 0o077) !== 0) log?.warn(`${file} is readable by other users`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const s = JSON.parse(raw) as Partial<SsoSession>;
  if (typeof s.userId !== "string" || typeof s.deviceId !== "string" || typeof s.accessToken !== "string")
    throw new Error(`session file ${file} is malformed (needs userId, deviceId, accessToken)`);
  return { userId: s.userId, deviceId: s.deviceId, accessToken: s.accessToken };
}

/**
 * Ensures state.data.accessToken/deviceId. Order: existing state, then the session file written by
 * `mxagentctl login-sso` (in the state directory), then password login. Throws if none is possible.
 */
export async function login(deps: { config: Config; paths: Paths; state: StateStore; log: Logger; fetch?: typeof fetch }): Promise<void> {
  const { config, paths, state, log } = deps;
  if (state.data.accessToken && state.data.deviceId) return;
  const sso = readSsoSession(paths.ssoSessionFile, log);
  if (sso) {
    if (sso.userId !== config.botUser) throw new Error(`session file belongs to ${sso.userId}, not ${config.botUser}`);
    state.data.accessToken = sso.accessToken;
    state.data.deviceId = sso.deviceId;
    state.save();
    try {
      fs.rmSync(paths.ssoSessionFile, { force: true });
      log.info("using SSO session, device", sso.deviceId, "(session file moved into the state)");
    } catch (e) {
      log.warn(`using SSO session, device ${sso.deviceId}, but ${paths.ssoSessionFile} could not be deleted (${(e as NodeJS.ErrnoException).code ?? "error"}); delete it by hand`);
    }
    return;
  }
  if (!config.botPassword) throw new Error("no MXA_BOT_PASSWORD and no session file; run mxagentctl login-sso or set a password");
  const doFetch = deps.fetch ?? fetch;
  const res = await doFetch(`${config.homeserver}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: config.botUser },
      password: config.botPassword,
      initial_device_display_name: `mxagent (${os.hostname()})`,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; device_id?: string; errcode?: string };
  if (!res.ok || !data.access_token || !data.device_id) throw new Error(`login failed: ${res.status} ${data.errcode ?? ""}`.trim());
  state.data.accessToken = data.access_token;
  state.data.deviceId = data.device_id;
  state.save();
  log.info("logged in, device", data.device_id);
}

export class OwnerNotJoinedError extends Error {
  constructor(roomId: string) {
    super(`owner has not joined room ${roomId} yet`);
    this.name = "OwnerNotJoinedError";
  }
}

/** Thrown when the send guard refuses a room: encryption unknown, or members other than bot and owner. */
export class SendRefusedError extends Error {
  readonly roomId: string;
  readonly reason: string;
  constructor(roomId: string, reason: string) {
    super(`refusing to send to ${roomId}: ${reason}`);
    this.name = "SendRefusedError";
    this.roomId = roomId;
    this.reason = reason;
  }
}

/** True for the error Matrix returns when the same user already sent the same reaction. */
export function isDuplicateAnnotation(e: unknown): boolean {
  const err = e as { body?: { errcode?: string }; message?: string } | null;
  return err?.body?.errcode === "M_DUPLICATE_ANNOTATION" || String(err?.message ?? "").includes("M_DUPLICATE_ANNOTATION");
}

export interface SendResult {
  eventId: string | null; // null while held
  held: boolean;
}

export type SentHandler = (roomId: string, eventId: string, content: Record<string, any>) => void;
export type RefusedHandler = (roomId: string, reason: string) => void;
export type HeldDroppedHandler = (roomId: string, count: number) => void;

/** Events older than this relative to daemon start are not passed to handlers (initial-sync backlog). */
export const BACKLOG_GRACE_MS = 5_000;
export const MAX_HELD_PER_ROOM = 50;
const MEMBERS_OK_MS = 30_000;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 300_000;

/** Audits the device lists of owner and bot before encrypted sends (OwnerTrust.auditDevices). */
export type DeviceGuard = () => Promise<DeviceAudit>;
export type DevicesChangedHandler = (users: string[]) => void;

export interface MatrixDeps {
  client: MatrixClient;
  config: Config;
  log: Logger;
  /** Replay keys of delivered owner events; default: in memory only. */
  replay?: ReplayStore;
  /** If given, start() stores the device's ed25519 key in state.data.deviceEd25519. */
  state?: StateStore;
  /** Backoff for re-checking rooms with held messages (tests use small values). */
  retryMinMs?: number;
  retryMaxMs?: number;
}

type CryptoStoreLike = { getRoom(roomId: string): Promise<any>; storeRoom(roomId: string, config: any): Promise<void> };

/**
 * Wraps the bot's MatrixClient. Handlers receive only:
 * - onDecrypted: events decrypted by the sync loop (have mxa_sender and mxa_replay_key), not sent by the bot,
 *   not older than start - 5 s, and whose replay key is not recorded yet. Handlers record the key with
 *   recordReplay() only after the owner check, so untrusted senders never take replay slots.
 * - onPlainEvent: unencrypted timeline events (reactions, membership, other state), not sent by the bot;
 *   non-membership events older than start - 5 s are dropped. Undecryptable events go nowhere.
 * Owner invites are joined automatically.
 *
 * Send guard: encrypted sends (and the Megolm key sharing they trigger) only go to rooms known to be encrypted
 * whose joined members are exactly bot and owner, and only while the device guard (setDeviceGuard) reports
 * every device of owner and bot as cross-signed. Otherwise the send is refused (SendRefusedError) and
 * onSendRefused handlers are told once per room until a send there succeeds again. As a backstop, room keys
 * are only handed to devices the guard allows, even if the device list changed after the check.
 */
export class Matrix {
  readonly client: MatrixClient;
  readonly startedAt = Date.now();
  private readonly config: Config;
  private readonly log: Logger;
  private readonly replay: ReplayStore;
  private readonly retryMinMs: number;
  private readonly retryMaxMs: number;
  private readonly decryptedHandlers = new Set<EventHandler>();
  private readonly plainHandlers = new Set<EventHandler>();
  private readonly sentHandlers = new Set<SentHandler>();
  private readonly refusedHandlers = new Set<RefusedHandler>();
  private readonly droppedHandlers = new Set<HeldDroppedHandler>();
  private readonly devicesChangedHandlers = new Set<DevicesChangedHandler>();
  private readonly state?: StateStore;
  private deviceGuard?: DeviceGuard;
  private patchedMachine?: unknown;
  private readonly encrypted = new Set<string>();
  private readonly membersOkUntil = new Map<string, number>();
  private readonly refusedNotified = new Set<string>();
  private readonly held = new Map<string, Record<string, any>[]>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly retryDelay = new Map<string, number>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private lastSync = 0;
  private running = false;

  constructor(deps: MatrixDeps) {
    this.client = deps.client;
    this.config = deps.config;
    this.log = deps.log;
    this.replay = deps.replay ?? new ReplayStore();
    this.state = deps.state;
    this.retryMinMs = deps.retryMinMs ?? RETRY_MIN_MS;
    this.retryMaxMs = deps.retryMaxMs ?? RETRY_MAX_MS;
    this.patchClient();
    this.client.on("room.decrypted_event", (roomId: string, event: MatrixEvent) => this.dispatchDecrypted(roomId, event));
    this.client.on("room.event", (roomId: string, event: MatrixEvent) => this.dispatchPlain(roomId, event));
    this.client.on("room.failed_decryption", (roomId: string, event: MatrixEvent, e: Error) =>
      this.log.warn("decryption failed in", roomId, "event", event?.event_id, "from", event?.sender, e?.message ?? ""),
    );
    this.client.on("room.invite", (roomId: string, event: MatrixEvent) => {
      if (event?.sender !== this.config.owner) return;
      this.client.joinRoom(roomId, [this.config.serverName]).catch((e: Error) => this.log.warn("join failed", roomId, e.message));
    });
  }

  /** Instance patches: decrypt with sender info, member filter for key sharing, encryption tracking, sync health. */
  private patchClient(): void {
    const c = this.client as any;
    const crypto = c.crypto;
    if (crypto) {
      // matrix-bot-sdk drops the sender's device after decryption; keep it (and the forwarding info).
      crypto.decryptRoomEvent = async (event: any, roomId: string) => {
        const d = await crypto.engine.machine.decryptRoomEvent(JSON.stringify(event.raw), new RoomId(roomId));
        return new RoomEvent(decryptedRaw(event.raw, roomId, d));
      };
      // The machine is created in prepare(); wrap its key sharing as soon as it exists.
      if (typeof crypto.prepare === "function") {
        const origPrepare = crypto.prepare.bind(crypto) as (...a: unknown[]) => Promise<unknown>;
        crypto.prepare = async (...a: unknown[]) => {
          const r = await origPrepare(...a);
          this.patchMachine(crypto.engine?.machine);
          return r;
        };
      }
      this.patchMachine(crypto.engine?.machine);
      if (typeof crypto.encryptRoomEvent === "function") {
        const origEncrypt = crypto.encryptRoomEvent.bind(crypto) as (roomId: string, ...a: unknown[]) => Promise<unknown>;
        crypto.encryptRoomEvent = async (roomId: string, ...a: unknown[]) => {
          const machine = crypto.engine?.machine;
          if (!machine || machine !== this.patchedMachine) throw new SendRefusedError(roomId, "key sharing is not guarded");
          return origEncrypt(roomId, ...a);
        };
      }
    }
    // Megolm keys are shared with whatever /joined_members returns; never share beyond bot and owner.
    const origMembers = c.getJoinedRoomMembers.bind(c) as (roomId: string) => Promise<string[]>;
    c.getJoinedRoomMembers = async (roomId: string) => {
      const members = await origMembers(roomId);
      const extra = members.filter((m) => m !== this.config.botUser && m !== this.config.owner);
      if (extra.length) {
        this.membersOkUntil.delete(roomId);
        this.log.warn("room", roomId, "has members besides bot and owner:", extra.join(", "));
        throw new SendRefusedError(roomId, `room has ${extra.length} member(s) besides bot and owner`);
      }
      return members;
    };
    const origCreate = c.createRoom.bind(c) as (body: any) => Promise<string>;
    c.createRoom = async (body: any) => {
      const roomId = await origCreate(body);
      const st: any[] = Array.isArray(body?.initial_state) ? body.initial_state : [];
      const enc = st.find((e) => e?.type === "m.room.encryption" && (e.state_key ?? "") === "");
      if (enc?.content?.algorithm === MEGOLM) {
        const hv = st.find((e) => e?.type === "m.room.history_visibility")?.content?.history_visibility;
        await this.markEncrypted(roomId, typeof hv === "string" ? hv : undefined);
      }
      return roomId;
    };
    if (typeof c.doSync === "function") {
      const origSync = c.doSync.bind(c) as (token: unknown) => Promise<unknown>;
      c.doSync = async (token: unknown) => {
        const r = await origSync(token);
        this.lastSync = Date.now();
        this.deviceListChanges(r);
        return r;
      };
    }
  }

  /**
   * Wraps OlmMachine.shareRoomKey: to-device messages (room keys) for owner and bot go only to devices the device
   * guard allows; anything else is removed from the request before the SDK sends it. Covers a device list that
   * changed between the send guard's check and the SDK's own /keys/query.
   */
  private patchMachine(machine: any): void {
    if (!machine || machine === this.patchedMachine || typeof machine.shareRoomKey !== "function") return;
    // Incoming key and secret requests are never answered: the daemon has no reason to forward room keys or
    // secrets, and a forward could reach a device the backstop below would refuse.
    if (typeof machine.receiveSyncChanges === "function") {
      const origSync = machine.receiveSyncChanges.bind(machine) as (toDevice: string, ...rest: unknown[]) => Promise<unknown>;
      machine.receiveSyncChanges = (toDevice: string, ...rest: unknown[]) => origSync(dropGossipRequests(toDevice, this.log), ...rest);
    }
    // Encrypted to-device messages queued by the machine itself (key forwards, re-shares) pass the same key-bound
    // filter as room-key sharing before the SDK sends them.
    if (typeof machine.outgoingRequests === "function") {
      const origOut = machine.outgoingRequests.bind(machine) as () => Promise<any[]>;
      machine.outgoingRequests = async () => {
        const requests = await origOut();
        if (!Array.isArray(requests) || !requests.some((r) => r?.type === TO_DEVICE_REQUEST)) return requests;
        const allowedKeys = this.deviceGuard ? (await this.deviceGuard()).allowedKeys : new Map();
        return requests.map((r) => (r?.type === TO_DEVICE_REQUEST ? this.filterQueuedToDevice(r, allowedKeys) : r));
      };
    }
    const orig = machine.shareRoomKey.bind(machine) as (roomId: any, users: any, settings: any) => Promise<any[]>;
    machine.shareRoomKey = async (roomId: any, users: any, settings: any) => {
      const requests = await orig(roomId, users, settings);
      if (!Array.isArray(requests) || !requests.length) return requests;
      const room = String(roomId?.toString?.() ?? roomId);
      if (!this.deviceGuard) throw new SendRefusedError(room, "device check not configured");
      const { allowedKeys } = await this.deviceGuard();
      const filtered = requests.map((r) => this.filterKeyShare(room, r, allowedKeys));
      // A removed device would otherwise stay without this session's key until it rotates; start a new
      // session on the next send so a device that becomes verified gets keys right away.
      if (filtered.some((r, i) => r !== requests[i]) && typeof machine.invalidateGroupSession === "function") {
        await Promise.resolve(machine.invalidateGroupSession(roomId)).catch(() => {});
      }
      return filtered;
    };
    this.patchedMachine = machine;
  }

  /** Room keys from shareRoomKey go only to allowed devices, bound to their signed keys (see keepKeyBound). */
  private filterKeyShare(roomId: string, req: any, allowedKeys: DeviceAudit["allowedKeys"]): any {
    let body: { messages?: unknown };
    try {
      body = JSON.parse(req.body);
    } catch {
      throw new SendRefusedError(roomId, "unreadable key-sharing request");
    }
    const { kept, removed } = keepKeyBound(body?.messages, allowedKeys);
    if (!removed.length) return req;
    this.log.warn("room key for", roomId, "not shared with unverified device(s):", removed.join(", "));
    return { id: req.id, txnId: req.txnId, eventType: req.eventType, type: req.type, body: JSON.stringify({ ...body, messages: kept }) };
  }

  /**
   * A to-device request the machine queued on its own. Plaintext ones (no keys inside) pass; encrypted ones keep
   * only recipients whose signed curve25519 key they are encrypted to. An unreadable body is sent empty, so the
   * request is still marked as sent and not queued again.
   */
  private filterQueuedToDevice(req: any, allowedKeys: DeviceAudit["allowedKeys"]): any {
    let body: { event_type?: unknown; messages?: unknown } | null = null;
    try {
      body = JSON.parse(req.body);
    } catch {}
    if (body && body.event_type !== "m.room.encrypted" && body.event_type !== "m.room_key" && body.event_type !== "m.forwarded_room_key" && body.event_type !== "m.secret.send") return req;
    const { kept, removed } = keepKeyBound(body?.messages, allowedKeys);
    if (!removed.length && body) return req;
    this.log.warn("queued to-device message not sent to unverified device(s):", removed.join(", ") || "<unreadable>");
    return { id: req.id, type: req.type, body: JSON.stringify({ ...(body ?? {}), messages: kept }) };
  }

  /** Tells onDevicesChanged handlers when a sync reports changed or left device lists of owner or bot. */
  private deviceListChanges(r: unknown): void {
    const dl = (r as { device_lists?: { changed?: unknown; left?: unknown } } | null)?.device_lists;
    if (!dl || typeof dl !== "object") return;
    const users = [dl.changed, dl.left].flatMap((l) => (Array.isArray(l) ? l : [])).filter((u) => u === this.config.owner || u === this.config.botUser);
    if (!users.length) return;
    const unique = [...new Set(users as string[])];
    for (const h of this.devicesChangedHandlers) {
      try {
        h(unique);
      } catch (e) {
        this.log.error("devices-changed handler failed:", (e as Error).message);
      }
    }
  }

  /** Sets the device audit run before every encrypted send. Without one, encrypted sends are refused. */
  setDeviceGuard(guard: DeviceGuard): void {
    this.deviceGuard = guard;
  }

  /** Called when a sync reports a device list change of owner or bot (use it to drop cached keys). */
  onDevicesChanged(cb: DevicesChangedHandler): () => void {
    this.devicesChangedHandlers.add(cb);
    return () => this.devicesChangedHandlers.delete(cb);
  }

  /** True if the key is missing/invalid or already recorded: such an event must not be delivered. */
  isReplay(key: unknown): boolean {
    return typeof key !== "string" || !KEY_RE.test(key) || this.replay.has(key);
  }

  /**
   * Records the replay key of an event that passed the owner check, right before it is delivered. False for a
   * missing/invalid or already recorded key (do not deliver). Throws ReplayLogError if it cannot be persisted.
   */
  recordReplay(key: unknown): boolean {
    if (typeof key !== "string" || !KEY_RE.test(key)) return false;
    return this.replay.add(key);
  }

  private get cryptoStore(): CryptoStoreLike | undefined {
    return (this.client as any).cryptoStore;
  }

  get botUser(): string {
    return this.config.botUser;
  }

  get owner(): string {
    return this.config.owner;
  }

  onDecrypted(cb: EventHandler): () => void {
    this.decryptedHandlers.add(cb);
    return () => this.decryptedHandlers.delete(cb);
  }

  onPlainEvent(cb: EventHandler): () => void {
    this.plainHandlers.add(cb);
    return () => this.plainHandlers.delete(cb);
  }

  /** Called after every successful sendMessage/sendEvent, including held messages when flushed. */
  onSent(cb: SentHandler): () => void {
    this.sentHandlers.add(cb);
    return () => this.sentHandlers.delete(cb);
  }

  /** Called once per room when the send guard refuses it (again only after a later send there succeeded). */
  onSendRefused(cb: RefusedHandler): () => void {
    this.refusedHandlers.add(cb);
    return () => this.refusedHandlers.delete(cb);
  }

  /** Called when held messages are dropped because a room's queue exceeded 50 (not on stop()). */
  onHeldDropped(cb: HeldDroppedHandler): () => void {
    this.droppedHandlers.add(cb);
    return () => this.droppedHandlers.delete(cb);
  }

  /** Records that a room is Megolm-encrypted (rooms we created or whose m.room.encryption we saw). */
  async markEncrypted(roomId: string, historyVisibility?: string): Promise<void> {
    this.encrypted.add(roomId);
    const store = this.cryptoStore;
    if (!store) return;
    try {
      const cur = await store.getRoom(roomId);
      if (cur?.algorithm !== MEGOLM) await store.storeRoom(roomId, { algorithm: MEGOLM, ...(historyVisibility ? { historyVisibility } : {}) });
    } catch (e) {
      this.log.warn("cannot store room encryption for", roomId, (e as Error).message);
    }
  }

  isKnownEncrypted(roomId: string): boolean {
    return this.encrypted.has(roomId);
  }

  private isBacklog(event: MatrixEvent): boolean {
    return (event.origin_server_ts ?? 0) < this.startedAt - BACKLOG_GRACE_MS;
  }

  private async run(handlers: Set<EventHandler>, roomId: string, event: MatrixEvent): Promise<void> {
    for (const h of handlers) {
      try {
        await h(roomId, event);
      } catch (e) {
        this.log.error("event handler failed:", (e as Error).message);
      }
    }
  }

  private async dispatchDecrypted(roomId: string, event: MatrixEvent): Promise<void> {
    if (!event?.mxa_sender) return;
    if (event.sender === this.config.botUser) return;
    // Only checked here; the router records the key after the owner check (and checks again atomically).
    if (this.isReplay(event.mxa_replay_key)) {
      this.log.warn("dropped replayed or unidentifiable event", roomId, event.event_id);
      return;
    }
    if (this.isBacklog(event)) return;
    event.room_id ??= roomId;
    this.log.debug("decrypted", roomId, event.event_id, event.type);
    await this.run(this.decryptedHandlers, roomId, event);
  }

  private async dispatchPlain(roomId: string, event: MatrixEvent): Promise<void> {
    // room.event also fires for decrypted (has mxa_sender) and undecryptable events; those are not plain.
    if (!event || event.mxa_sender || event.type === "m.room.encrypted") return;
    event.room_id ??= roomId;
    if (event.type === "m.room.encryption" && event.state_key === "" && event.content?.algorithm === MEGOLM) await this.markEncrypted(roomId);
    if (event.type === "m.room.member") {
      this.membersOkUntil.delete(roomId);
      if (event.state_key === this.config.owner) this.ownerMembership(roomId, event);
    }
    if (event.sender === this.config.botUser) return;
    if (event.type !== "m.room.member" && this.isBacklog(event)) return;
    await this.run(this.plainHandlers, roomId, event);
  }

  private ownerMembership(roomId: string, event: MatrixEvent): void {
    if (event.content?.membership !== "join" || !this.held.get(roomId)?.length) return;
    this.retryDelay.delete(roomId);
    const t = this.retryTimers.get(roomId);
    if (t) clearTimeout(t);
    this.retryTimers.delete(roomId);
    void this.serial(roomId, () => this.flushHeld(roomId));
  }

  private emitSent(roomId: string, eventId: string, content: Record<string, any>): void {
    this.refusedNotified.delete(roomId);
    for (const h of this.sentHandlers) {
      try {
        h(roomId, eventId, content);
      } catch (e) {
        this.log.error("sent handler failed:", (e as Error).message);
      }
    }
  }

  private refused(e: SendRefusedError): void {
    this.log.warn(e.message);
    if (this.refusedNotified.has(e.roomId)) return;
    this.refusedNotified.add(e.roomId);
    for (const h of this.refusedHandlers) {
      try {
        h(e.roomId, e.reason);
      } catch (err) {
        this.log.error("refused handler failed:", (err as Error).message);
      }
    }
  }

  /** Runs fn after all earlier sends to the same room (keeps message order, including held messages). */
  private serial<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(roomId) ?? Promise.resolve();
    const p = prev.then(fn, fn);
    const tail = p.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(roomId, tail);
    void tail.then(() => {
      if (this.chains.get(roomId) === tail) this.chains.delete(roomId);
    });
    return p;
  }

  /** Throws SendRefusedError unless the room is known to be Megolm-encrypted (fails closed). */
  private async ensureEncrypted(roomId: string): Promise<void> {
    const crypto = (this.client as any).crypto as { isRoomEncrypted(roomId: string): Promise<boolean> } | undefined;
    if (!crypto) throw new SendRefusedError(roomId, "encryption is not available");
    if (!this.encrypted.has(roomId)) {
      const stored = await this.cryptoStore?.getRoom(roomId).catch(() => null);
      if (stored?.algorithm === MEGOLM) this.encrypted.add(roomId);
      else {
        const ev = await this.client.getRoomStateEvent(roomId, "m.room.encryption", "").catch(() => null);
        if (ev?.algorithm !== MEGOLM) throw new SendRefusedError(roomId, "room is not known to be encrypted");
        await this.markEncrypted(roomId);
      }
    }
    // The bot SDK decides on its own whether to encrypt; make sure it agrees before handing it the message.
    if (!(await crypto.isRoomEncrypted(roomId))) {
      await this.markEncrypted(roomId);
      if (!(await crypto.isRoomEncrypted(roomId))) throw new SendRefusedError(roomId, "the crypto layer does not treat the room as encrypted");
    }
  }

  /**
   * "ok" if the room may receive encrypted messages now, "owner-absent" if the owner has not joined.
   * Throws SendRefusedError (guard) or the lookup error (homeserver unreachable etc.).
   */
  private async roomStatus(roomId: string): Promise<"ok" | "owner-absent"> {
    await this.ensureEncrypted(roomId);
    await this.checkDevices(roomId);
    if ((this.membersOkUntil.get(roomId) ?? 0) > Date.now()) return "ok";
    const members = await this.client.getJoinedRoomMembers(roomId); // patched: throws on extra members
    if (!members.includes(this.config.botUser)) throw new SendRefusedError(roomId, "the bot is not joined");
    if (!members.includes(this.config.owner)) return "owner-absent";
    this.membersOkUntil.set(roomId, Date.now() + MEMBERS_OK_MS);
    return "ok";
  }

  /** Throws SendRefusedError unless every device of owner and bot is cross-signed; query errors propagate. */
  private async checkDevices(roomId: string): Promise<void> {
    if (!this.deviceGuard) throw new SendRefusedError(roomId, "device check not configured");
    const { problem } = await this.deviceGuard();
    if (problem) throw new SendRefusedError(roomId, problem);
  }

  private async guardedSend(roomId: string, send: () => Promise<string>): Promise<string> {
    try {
      return await send();
    } catch (e) {
      if (e instanceof SendRefusedError) this.refused(e);
      throw e;
    }
  }

  /** Number of messages currently held for a room. */
  heldCount(roomId: string): number {
    return this.held.get(roomId)?.length ?? 0;
  }

  private hold(roomId: string, content: Record<string, any>, why: string): SendResult {
    const queue = this.held.get(roomId) ?? [];
    queue.push(content);
    const drop = queue.length - MAX_HELD_PER_ROOM;
    if (drop > 0) {
      queue.splice(0, drop);
      this.log.warn("held queue full in", roomId, "dropped", drop, "oldest message(s)");
      this.emitDropped(roomId, drop);
    }
    this.held.set(roomId, queue);
    this.log.info(`holding message (${why})`, roomId);
    this.scheduleRetry(roomId);
    return { eventId: null, held: true };
  }

  private emitDropped(roomId: string, count: number): void {
    for (const h of this.droppedHandlers) {
      try {
        h(roomId, count);
      } catch (e) {
        this.log.error("held-dropped handler failed:", (e as Error).message);
      }
    }
  }

  private scheduleRetry(roomId: string): void {
    if (this.retryTimers.has(roomId) || !this.held.get(roomId)?.length) return;
    const delay = this.retryDelay.get(roomId) ?? this.retryMinMs;
    this.retryDelay.set(roomId, Math.min(delay * 2, this.retryMaxMs));
    const t = setTimeout(() => {
      this.retryTimers.delete(roomId);
      void this.serial(roomId, () => this.flushHeld(roomId));
    }, delay);
    t.unref?.();
    this.retryTimers.set(roomId, t);
  }

  /** Sends held messages in order if the room is ok now; otherwise (or on failure) retries with backoff. */
  private async flushHeld(roomId: string): Promise<void> {
    const queue = this.held.get(roomId);
    if (!queue?.length) return;
    let status: "ok" | "owner-absent";
    try {
      status = await this.roomStatus(roomId);
    } catch (e) {
      if (e instanceof SendRefusedError) this.refused(e);
      else this.log.debug("membership check failed for", roomId, (e as Error).message);
      this.scheduleRetry(roomId);
      return;
    }
    if (status !== "ok") {
      this.scheduleRetry(roomId);
      return;
    }
    this.log.info("owner joined", roomId, "sending", queue.length, "held message(s)");
    while (queue.length) {
      const content = queue[0]!;
      try {
        const id = await this.guardedSend(roomId, () => this.client.sendMessage(roomId, content));
        queue.shift();
        this.emitSent(roomId, id, content);
      } catch (e) {
        this.log.warn("send of held message failed:", (e as Error).message);
        this.scheduleRetry(roomId);
        return;
      }
    }
    this.held.delete(roomId);
    this.retryDelay.delete(roomId);
  }

  /**
   * Sends an m.room.message, always encrypted (see the send guard). If the owner has not joined, or their
   * membership cannot be checked right now, the message is queued (last 50 per room) and sent once the owner
   * is joined (re-checked on owner join events and with backoff). With `hold: false` it throws instead
   * (OwnerNotJoinedError or the lookup error). Throws SendRefusedError when the guard refuses the room.
   */
  sendMessage(roomId: string, content: Record<string, any>, opts: { hold?: boolean } = {}): Promise<SendResult> {
    return this.serial(roomId, async () => {
      let status: "ok" | "owner-absent";
      try {
        status = await this.roomStatus(roomId);
      } catch (e) {
        if (e instanceof SendRefusedError) {
          this.refused(e);
          throw e;
        }
        if (opts.hold === false) throw e;
        return this.hold(roomId, content, "membership check failed");
      }
      if (status === "owner-absent") {
        if (opts.hold === false) throw new OwnerNotJoinedError(roomId);
        return this.hold(roomId, content, "owner has not joined");
      }
      if (this.held.get(roomId)?.length) {
        await this.flushHeld(roomId);
        if (this.held.get(roomId)?.length) {
          if (opts.hold === false) throw new Error(`earlier messages to ${roomId} are still held`);
          return this.hold(roomId, content, "earlier messages still held");
        }
      }
      const eventId = await this.guardedSend(roomId, () => this.client.sendMessage(roomId, content));
      this.emitSent(roomId, eventId, content);
      return { eventId, held: false };
    });
  }

  sendText(roomId: string, body: string): Promise<SendResult> {
    return this.sendMessage(roomId, { msgtype: "m.text", body });
  }

  sendNotice(roomId: string, body: string): Promise<SendResult> {
    return this.sendMessage(roomId, { msgtype: "m.notice", body });
  }

  /** Sends any event type, always encrypted (send guard). Never held: throws OwnerNotJoinedError. */
  sendEvent(roomId: string, type: string, content: Record<string, any>): Promise<string> {
    return this.serial(roomId, async () => {
      let status: "ok" | "owner-absent";
      try {
        status = await this.roomStatus(roomId);
      } catch (e) {
        if (e instanceof SendRefusedError) this.refused(e);
        throw e;
      }
      if (status !== "ok") throw new OwnerNotJoinedError(roomId);
      const eventId = await this.guardedSend(roomId, () => this.client.sendEvent(roomId, type, content));
      this.emitSent(roomId, eventId, content);
      return eventId;
    });
  }

  /** Sends unencrypted (reactions, so clients aggregate them). Not held, not reported to onSent. */
  sendRaw(roomId: string, type: string, content: Record<string, any>): Promise<string> {
    return this.client.sendRawEvent(roomId, type, content);
  }

  /** Best effort; errors are swallowed. */
  setTyping(roomId: string, typing: boolean, timeoutMs = 30_000): void {
    this.client.setTyping(roomId, typing, typing ? timeoutMs : undefined).catch(() => {});
  }

  /**
   * Fetches an event (decrypted if possible, also if already seen). The result never carries mxa_sender and is
   * not checked against or recorded in the replay store: never treat it as owner input.
   */
  async getEvent(roomId: string, eventId: string): Promise<MatrixEvent> {
    const ev = (await this.client.getEvent(roomId, eventId)) as MatrixEvent;
    delete ev.mxa_sender;
    delete ev.mxa_replay_key;
    return ev;
  }

  keysQuery(body: unknown): Promise<KeysQueryResponse> {
    return this.client.doRequest("POST", "/_matrix/client/v3/keys/query", null, body);
  }

  /** True while running and the sync loop completed a sync within maxAgeMs (grace period from start()). */
  healthy(maxAgeMs = 180_000): boolean {
    return this.running && Date.now() - this.lastSync < maxAgeMs;
  }

  /** Time of the last successful sync (ms since epoch), 0 before the first one. */
  get lastSyncAt(): number {
    return this.lastSync;
  }

  async start(): Promise<void> {
    if (this.running) throw new Error("matrix client already started");
    this.running = true;
    this.lastSync = Date.now(); // grace period until the first sync completes
    try {
      await this.client.start();
    } catch (e) {
      this.running = false;
      throw e;
    }
    const fp = (this.client as any).crypto?.deviceEd25519;
    if (typeof fp === "string") {
      this.log.info("device", this.client.crypto?.clientDeviceId, "ed25519 fingerprint", fingerprint(fp));
      // lets mxagentctl cross-sign compare the device it signs with the key this daemon really holds
      if (this.state && this.state.data.deviceEd25519 !== fp) {
        this.state.data.deviceEd25519 = fp;
        try {
          this.state.save();
        } catch (e) {
          this.log.error("cannot store the device key in the state:", (e as Error).message);
        }
      }
    }
  }

  stop(): void {
    this.running = false;
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
    for (const [roomId, queue] of this.held) {
      if (!queue.length) continue;
      this.log.warn("stopping with", queue.length, "held message(s) for", roomId, "(dropped)");
    }
    this.held.clear();
    this.client.stop();
  }
}

/**
 * Logs in (see login()), creates the MatrixClient with SimpleFs sync storage and the Rust crypto store
 * (SQLite) under paths and returns a Matrix (not yet started) with a persisted replay store.
 */
export async function createMatrix(deps: { config: Config; paths: Paths; state: StateStore; log: Logger; fetch?: typeof fetch }): Promise<Matrix> {
  const { config, paths, state, log } = deps;
  LogService.setLevel(log.level === "debug" ? LogLevel.INFO : LogLevel.WARN);
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  // An existing directory keeps its mode; it holds tokens and keys, so tighten it.
  try {
    const st = fs.statSync(paths.stateDir);
    if (st.uid === process.getuid?.() && (st.mode & 0o077) !== 0) {
      fs.chmodSync(paths.stateDir, st.mode & 0o700);
      log.warn("state directory was accessible to others; mode set to 0700");
    }
  } catch {}
  await login(deps);
  const client = new MatrixClientCtor(
    config.homeserver,
    state.data.accessToken!,
    new SimpleFsStorageProvider(paths.syncFile),
    new RustSdkCryptoStorageProvider(paths.cryptoDir, 0 /* SQLite */),
  );
  const mlog = log.child("matrix");
  const replay = new ReplayStore({ file: paths.replayFile, log: mlog });
  return new Matrix({ client, config, log: mlog, replay, state });
}
