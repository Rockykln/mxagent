// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-connection protocol handler: agent requests (docs/reference/protocol.md, "Agent -> daemon") -> modules.

import { HEARTBEAT_INTERVAL_MS, type DaemonMessage } from "../protocol/messages.ts";
import type { Config } from "./config.ts";
import type { Logger } from "./log.ts";
import type { Matrix } from "./matrix.ts";
import type { Polls } from "./polls.ts";
import type { Reactions } from "./reactions.ts";
import type { RoomManager } from "./rooms.ts";
import type { Router } from "./router.ts";
import type { Updates } from "./updates.ts";
import type { Connection } from "./transport/link.ts";
import { agentKey, validateAgentName, type AgentLink, type AgentRegistry, type RoomQuota } from "./registry.ts";

export interface AgentLinkDeps {
  config: Pick<Config, "owner">;
  log: Logger;
  matrix: Pick<Matrix, "sendText" | "sendNotice" | "sendMessage" | "setTyping">;
  rooms: Pick<RoomManager, "ensureAgentRoom" | "setDisplayName" | "controlRoomId"> & Partial<Pick<RoomManager, "agentRoom">>;
  registry: Pick<AgentRegistry, "register" | "remove">;
  router: Pick<Router, "rememberControlMessage">;
  polls: Pick<Polls, "sendAgentPoll" | "vote" | "requestApproval" | "cancelApproval">;
  reactions: Pick<Reactions, "agentReact">;
  updates: Pick<Updates, "reported">;
  notify: { system(text: string): void };
  /** Shared limit of new agent rooms per machine; without it (tests) new rooms are not limited. */
  roomQuota?: RoomQuota;
  now?: () => number;
  /** Interval of `heartbeat` lines to the agent (default HEARTBEAT_INTERVAL_MS); 0 disables them. */
  heartbeatMs?: number;
}

export const MAX_TEXT_CHARS = 16_000;
const MAX_META_CHARS = 100;
const MAX_ERROR_CHARS = 300;
/** Requests waiting behind a slow one; a peer that floods beyond this is dropped. */
const MAX_QUEUED_REQUESTS = 256;
/** Approximate size (JSON characters) of requests waiting behind a slow one; beyond this the link is dropped. */
export const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
/** Approval request_ids remembered per link for the duplicate check (the daemon keeps at most 200 pending). */
const MAX_PENDING_APPROVALS = 1000;

/** Error whose message is sent to the agent. */
class RequestError extends Error {}

const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function metaString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_META_CHARS);
  return s || undefined;
}

function requireText(v: unknown, what = "text"): string {
  if (typeof v !== "string" || !v.trim()) throw new RequestError(`${what} required`);
  const s = v.replace(CONTROL_CHARS, "").trim();
  if (!s) throw new RequestError(`${what} required`);
  if (s.length > MAX_TEXT_CHARS) throw new RequestError(`${what} is longer than ${MAX_TEXT_CHARS} characters`);
  return s;
}

/** Poll texts: control characters removed (length and count checks stay in polls.ts). */
function cleanPollText(v: unknown): unknown {
  return typeof v === "string" ? v.replace(CONTROL_CHARS, "") : v;
}

/** Log fields of a module error: class name and Matrix errcode only (messages may quote content). */
function errInfo(e: unknown): string {
  const name = (e as Error | null)?.name ?? "error";
  const errcode = (e as { body?: { errcode?: unknown } } | null)?.body?.errcode;
  return typeof errcode === "string" ? `${name} ${errcode}` : name;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Content of a control-room message that mentions (and so notifies) the owner. */
export function mentionContent(owner: string, name: string, text: string): Record<string, any> {
  return {
    msgtype: "m.text",
    body: `[${name}] ${text}`,
    format: "org.matrix.custom.html",
    formatted_body: `<a href="https://matrix.to/#/${encodeURIComponent(owner)}">${escapeHtml(owner)}</a> [${escapeHtml(name)}] ${escapeHtml(text).replace(/\n/g, "<br>")}`,
    "m.mentions": { user_ids: [owner] },
  };
}

interface Session {
  link: AgentLink;
  roomId: string;
}

/**
 * Wires one transport connection to the daemon. Requests are handled one at a time in arrival order;
 * every request with a numeric `id` gets exactly one `ok`/`error` (`welcome` for `hello`).
 */
export function handleConnection(conn: Connection, deps: AgentLinkDeps): void {
  const { log, matrix, rooms, registry } = deps;
  const now = deps.now ?? Date.now;
  let session: Session | null = null;
  let queue: Promise<void> = Promise.resolve();
  let queued = 0;
  let queuedBytes = 0;
  // approval request_ids sent on this link that have no approval_result yet
  const pendingApprovals = new Set<string>();

  const write = (msg: DaemonMessage): void => conn.write(JSON.stringify(msg));

  // lets clients without access to WebSocket pings (or on a Unix socket) detect a dead link
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
  const heartbeat = heartbeatMs > 0 ? setInterval(() => write({ type: "heartbeat" }), heartbeatMs) : undefined;
  heartbeat?.unref();

  conn.onClose(() => {
    if (heartbeat) clearInterval(heartbeat);
    const s = session;
    if (!s) return;
    session = null;
    matrix.setTyping(s.roomId, false);
    if (registry.remove(s.link)) {
      log.info("agent offline:", s.link.name, `(${s.link.machine})`);
      deps.notify.system(`${s.link.name} offline`);
    }
  });

  conn.onLine((obj) => {
    if (!conn.alive()) return;
    let size = 0;
    try {
      size = JSON.stringify(obj)?.length ?? 0;
    } catch {
      // unreachable for parsed JSON; handle() rejects it
    }
    // a single large request on an idle link is fine (it is rejected by the field limits); a backlog is not
    if (++queued > MAX_QUEUED_REQUESTS || (queued > 1 && queuedBytes + size > MAX_QUEUED_BYTES)) {
      log.warn("dropping link of machine", conn.machine, queued > MAX_QUEUED_REQUESTS ? "(too many queued requests)" : "(too much queued data)");
      queued--;
      conn.close();
      return;
    }
    queuedBytes += size;
    queue = queue
      .then(() => handle(obj))
      .catch((e: unknown) => {
        // handle() answers every request itself; this only keeps the queue alive if that answer failed
        log.warn("request handling failed on link of machine", conn.machine, errInfo(e));
      })
      .finally(() => {
        queued--;
        queuedBytes -= size;
      });
  });

  async function handle(obj: unknown): Promise<void> {
    if (!conn.alive()) return;
    const msg = obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
    const id = typeof msg?.id === "number" && Number.isFinite(msg.id) ? msg.id : undefined;
    const type = typeof msg?.type === "string" ? msg.type : "";
    try {
      if (!msg || !type) throw new RequestError("malformed request");
      if (type === "hello") {
        await hello(msg, id);
        return;
      }
      if (!session) throw new RequestError("send hello first");
      const extra = await request(session, type, msg);
      if (id !== undefined) write({ type: "ok", id, ...extra });
    } catch (e) {
      const text = e instanceof Error && e.message ? e.message : "request failed";
      // module errors may quote poll options and the like: log only the error class and Matrix errcode
      if (!(e instanceof RequestError)) log.warn(`request ${type.slice(0, 40)} from ${session?.link.name ?? conn.machine} failed:`, errInfo(e));
      const err: DaemonMessage = id !== undefined ? { type: "error", id, error: text } : { type: "error", error: text };
      write(err);
    }
  }

  async function hello(msg: Record<string, unknown>, id: number | undefined): Promise<void> {
    if (session) throw new RequestError("already registered");
    let name: string;
    try {
      name = validateAgentName(msg.name);
    } catch (e) {
      throw new RequestError((e as Error).message);
    }
    const client = metaString(msg.client);
    const version = metaString(msg.version);
    const instance = metaString(msg.instance);
    const link: AgentLink = {
      key: agentKey(name),
      name,
      instance,
      machine: conn.machine,
      version,
      client,
      since: now(),
      send: (m) => {
        if (m.type === "approval_result") pendingApprovals.delete(m.request_id);
        write(m);
      },
      close: () => conn.close(),
      alive: () => conn.alive(),
    };
    // The room comes first and the link is registered only once it exists, so nothing (router, @all, @update)
    // can send to the agent before its welcome.
    const quota = deps.roomQuota;
    const isNewRoom = quota !== undefined && !rooms.agentRoom?.(link.key);
    if (isNewRoom && !quota.take(conn.machine, link.key)) {
      log.warn("rejected hello:", name, `(${conn.machine})`, "new-room quota used up");
      throw new RequestError("too many new agent names from this machine");
    }
    let roomId: string;
    try {
      roomId = await rooms.ensureAgentRoom(name);
    } catch (e) {
      if (isNewRoom) quota.release(conn.machine, link.key);
      throw e;
    }
    if (!conn.alive()) return;
    if (session) throw new RequestError("already registered");
    const res = registry.register(link);
    if (!res.ok) {
      log.info("rejected hello:", name, `(${conn.machine})`, "name in use");
      throw new RequestError(res.error);
    }
    if (res.replaced) log.info("agent", name, "replaces its previous link", `(${res.reason})`);
    session = { link, roomId };
    // synchronous with register(): welcome is the first line the agent gets
    write(id !== undefined ? { type: "welcome", id, room_id: roomId } : { type: "welcome", room_id: roomId });
    void rooms.setDisplayName(roomId, name);
    const clientInfo = [client, version].filter(Boolean).join(" ");
    deps.notify.system([`${name} online`, clientInfo, conn.machine].filter(Boolean).join(" · "));
    log.info("agent online:", name, `(${conn.machine})`);
  }

  function controlRoom(): string {
    const id = rooms.controlRoomId;
    if (!id) throw new RequestError("no control room");
    return id;
  }

  async function request(s: Session, type: string, msg: Record<string, unknown>): Promise<{ held?: boolean }> {
    const { link } = s;
    switch (type) {
      case "reply": {
        const text = requireText(msg.text);
        matrix.setTyping(s.roomId, false);
        const r = await matrix.sendText(s.roomId, text);
        return { held: r.held };
      }
      case "status": {
        let text = requireText(msg.text);
        // the daemon adds "[name]"; drop one the agent already put in front
        const own = new RegExp(`^\\[${escapeRe(link.name)}\\]\\s*[:\\-]?\\s*`, "iu");
        text = text.replace(own, "") || text;
        const r = await matrix.sendNotice(controlRoom(), `[${link.name}] ${text}`);
        if (r.eventId) deps.router.rememberControlMessage(r.eventId, link.key);
        return {};
      }
      case "ask": {
        const text = requireText(msg.text);
        const r = await matrix.sendMessage(controlRoom(), mentionContent(deps.config.owner, link.name, text));
        if (r.eventId) deps.router.rememberControlMessage(r.eventId, link.key);
        return {};
      }
      case "poll": {
        if (!Array.isArray(msg.options)) throw new RequestError("options must be an array");
        matrix.setTyping(s.roomId, false);
        await deps.polls.sendAgentPoll(link.key, cleanPollText(msg.question) as string, msg.options.map(cleanPollText) as string[]);
        return {};
      }
      case "vote": {
        const a = msg.answer;
        if (typeof a !== "string" && typeof a !== "number") throw new RequestError("answer required");
        await deps.polls.vote(link.key, link.name, String(a));
        return {};
      }
      case "react":
        await deps.reactions.agentReact(link.key, link.name, msg.emoji as string);
        return {};
      case "approval_request": {
        const title = requireText(msg.title, "title");
        if (msg.detail !== undefined && msg.detail !== null && typeof msg.detail !== "string") throw new RequestError("detail must be a string");
        const detail = typeof msg.detail === "string" ? msg.detail : undefined;
        const requestId = msg.request_id;
        if (typeof requestId === "string" && pendingApprovals.has(requestId)) throw new RequestError("request_id already pending");
        matrix.setTyping(s.roomId, false);
        await deps.polls.requestApproval(link.key, link.name, requestId as string, title, detail);
        pendingApprovals.add(requestId as string);
        if (pendingApprovals.size > MAX_PENDING_APPROVALS) pendingApprovals.delete(pendingApprovals.values().next().value!);
        const ctl = rooms.controlRoomId;
        if (ctl) {
          try {
            const r = await matrix.sendMessage(ctl, mentionContent(deps.config.owner, link.name, `needs approval in its room: ${title.split("\n")[0]!.slice(0, 200)}`));
            if (r.eventId) deps.router.rememberControlMessage(r.eventId, link.key);
          } catch (e) {
            log.warn("approval mention failed for", link.name, errInfo(e));
          }
        }
        return {};
      }
      case "approval_cancel": {
        if (typeof msg.request_id !== "string" || !msg.request_id) throw new RequestError("request_id required");
        await deps.polls.cancelApproval(link.key, msg.request_id);
        pendingApprovals.delete(msg.request_id);
        return {};
      }
      case "updated": {
        const from = metaString(msg.from) ?? "unknown";
        deps.updates.reported(link.key, link.version ?? "");
        deps.notify.system(`${link.name} updated: ${from} → ${link.version ?? "unknown"}`);
        return {};
      }
      case "update_failed": {
        const raw = typeof msg.error === "string" ? msg.error.replace(/[\u0000-\u001f\u007f]+/g, " ").trim() : "";
        deps.updates.reported(link.key, null);
        deps.notify.system(`${link.name}: update failed${raw ? `: ${raw.slice(0, MAX_ERROR_CHARS)}` : ""}`);
        return {};
      }
      default:
        throw new RequestError(`unknown request type "${type.slice(0, 40)}"`);
    }
  }
}
