// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: Apache-2.0
// Zero-dependency client for the mxagent agent protocol (docs/reference/protocol.md).
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { lineSplitter } from "./lines.mjs";

export const CLIENT_VERSION = "1.0.0";

const REQUEST_TIMEOUT_MS = 30_000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
// The daemon sends a heartbeat every 30 s; a link silent for longer than this is dead.
const DEAD_LINK_TIMEOUT_MS = 75_000;
// With retryAuthFailures, never retry rejected credentials faster than this (daemon lockout).
const AUTH_RETRY_MIN_MS = 60_000;
// Close 4029 ("try later": lockout, cap, timeout): wait at least this long, plus up to TRY_LATER_JITTER_MS.
const TRY_LATER_MIN_MS = 60_000;
const TRY_LATER_JITTER_MS = 30_000;
const CLOSE_FORBIDDEN = 4003;
const CLOSE_TRY_LATER = 4029;
const MAX_HANDSHAKE_FRAME = 1024 * 1024;
// Counted in decoded characters, like the daemon's limit.
const MAX_LINE_LENGTH = 64 * 1024 * 1024;
const ENV_KEYS = ["MXA_SOCKET_PATH", "MXA_URL", "MXA_MACHINE", "MXA_SECRET"];
const SECRET_RE = /^[A-Za-z0-9_-]{32,256}$/;
const MACHINE_RE = /^[a-z0-9-]{1,32}$/;
const MAX_REQUEST_ID_LENGTH = 200;
const MESSAGE_KINDS = new Set(["text", "attachment", "location", "poll_started", "poll_answer", "reaction"]);

/** Base class of every error this library raises or emits. */
export class BridgeError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
  }
}
/** Invalid or incomplete connection settings. */
export class ConfigError extends BridgeError {}
/** No link to the daemon, or it dropped while a request was pending. */
export class NotConnectedError extends BridgeError {}
/** The daemon (or the owner, for approvals) did not answer in time. */
export class RequestTimeoutError extends BridgeError {}
/** The secure WebSocket handshake failed or the daemon rejected the machine credentials. */
export class AuthenticationError extends BridgeError {}

// Authentication failures that retrying cannot fix (wrong secret or machine, impostor daemon).
const FATAL_AUTH = new WeakSet();
function fatalAuth(message) {
  const err = new AuthenticationError(message);
  err.fatal = true;
  FATAL_AUTH.add(err);
  return err;
}

// Transient refusals by the daemon (close 4029): never fatal, retried after a long delay.
const TRY_LATER = new WeakSet();
function tryLater(message) {
  const err = new NotConnectedError(message);
  TRY_LATER.add(err);
  return err;
}

// Shared by every agent created in this process, so a reconnect replaces the old link.
const PROCESS_INSTANCE = randomUUID();

function readClientEnvFile(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!ENV_KEYS.includes(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function defaultConfigDir() {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

/** Same default as the daemon. */
function defaultSocketPath(env) {
  if (env.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, "mxagent.sock");
  const state = env.MXA_STATE_DIR || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "mxagent");
  return path.join(state, "bridge.sock");
}

/**
 * Resolves connection settings: explicit options, then environment, then the client env file
 * (empty values count as unset). A URL selects remote mode and then requires machine and secret,
 * unless `socketPath` was passed explicitly.
 */
function duration(value, fallback, field) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new ConfigError(`${field} must be a positive number of milliseconds`);
  return value;
}

export function resolveOptions(opts = {}) {
  if (!opts || typeof opts.name !== "string" || !opts.name.trim()) throw new TypeError("connect(): `name` is required");
  const env = process.env;
  const file = readClientEnvFile(opts.configFile || path.join(defaultConfigDir(), "mxagent", "client.env"));
  const pick = (opt, key) => opt || env[key] || file[key] || undefined;
  const common = {
    name: opts.name.trim(),
    instance: opts.instance || PROCESS_INSTANCE,
    client: opts.client || `mxagent/${CLIENT_VERSION}`,
    version: opts.version || undefined,
    reconnect: opts.reconnect ?? true,
    retryAuthFailures: opts.retryAuthFailures === true,
    requestTimeoutMs: duration(opts.requestTimeoutMs, REQUEST_TIMEOUT_MS, "requestTimeoutMs"),
    handshakeTimeoutMs: duration(opts.handshakeTimeoutMs, HANDSHAKE_TIMEOUT_MS, "handshakeTimeoutMs"),
    deadLinkTimeoutMs: duration(opts.deadLinkTimeoutMs, DEAD_LINK_TIMEOUT_MS, "deadLinkTimeoutMs"),
  };
  const local = (socketPath) => ({ ...common, mode: "local", socketPath, url: undefined, machine: undefined, secret: undefined });
  if (opts.socketPath) return local(opts.socketPath);
  const url = pick(opts.url, "MXA_URL");
  if (!url) return local(pick(undefined, "MXA_SOCKET_PATH") ?? defaultSocketPath(env));
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError("MXA_URL is not a valid URL");
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") throw new ConfigError("MXA_URL must start with ws:// or wss://");
  const machine = pick(opts.machine, "MXA_MACHINE");
  const secret = pick(opts.secret, "MXA_SECRET");
  if (!machine || !secret) throw new ConfigError("remote mode needs a machine name and secret (MXA_MACHINE, MXA_SECRET)");
  if (!MACHINE_RE.test(machine)) throw new ConfigError("MXA_MACHINE must match ^[a-z0-9-]{1,32}$");
  // Used verbatim: no trimming or decoding, so a mangled secret fails here instead of at the daemon.
  if (!SECRET_RE.test(secret)) throw new ConfigError("MXA_SECRET must be 32-256 base64url characters (A-Z a-z 0-9 _ -)");
  return { ...common, mode: "remote", socketPath: undefined, url, machine, secret };
}

function splitter(onLine) {
  const feed = lineSplitter(onLine, MAX_LINE_LENGTH);
  return (chunk) => {
    try {
      feed(chunk);
    } catch (e) {
      if (e instanceof BridgeError) throw e;
      throw new BridgeError(e instanceof Error ? e.message : String(e));
    }
  };
}

/** Calls `onDead` once no data arrived for `ms`; `touch()` restarts the countdown. */
function watchdog(ms, onDead) {
  const timer = setTimeout(onDead, ms);
  return { touch: () => timer.refresh(), stop: () => clearTimeout(timer) };
}

function deadLinkError(ms) {
  return new NotConnectedError(`no data from the daemon for ${ms} ms, link considered dead`);
}

function openLocal(cfg, handlers) {
  const sock = net.createConnection({ path: cfg.socketPath });
  sock.setEncoding("utf8");
  let closed = false;
  const feed = splitter(handlers.onLine);
  const dog = watchdog(cfg.deadLinkTimeoutMs, () => {
    sock.destroy();
    finish(deadLinkError(cfg.deadLinkTimeoutMs));
  });
  const finish = (err) => {
    if (closed) return;
    closed = true;
    dog.stop();
    handlers.onClose(err);
  };
  sock.on("connect", () => handlers.onOpen());
  sock.on("data", (chunk) => {
    dog.touch();
    try {
      feed(chunk);
    } catch (e) {
      sock.destroy();
      finish(e);
    }
  });
  sock.on("error", (e) => finish(e));
  sock.on("close", () => finish());
  return {
    write: (line) => {
      if (!closed) sock.write(line + "\n");
    },
    close: () => sock.destroy(),
  };
}

function frameSize(data) {
  if (typeof data === "string") return Buffer.byteLength(data, "utf8");
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return 0;
}

function frameToText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  throw new Error("unsupported frame type");
}

async function openRemote(cfg, handlers) {
  const { Cipher, nonce, proof, proofOk } = await import("./secure.mjs");
  if (typeof WebSocket !== "function") throw new NotConnectedError("global WebSocket not available (Node >= 22 required)");
  const ws = new WebSocket(cfg.url);
  ws.binaryType = "arraybuffer";
  const nc = nonce();
  let ns = null;
  let cipher = null;
  let authed = false;
  let closed = false;
  const feed = splitter(handlers.onLine);
  // A peer that never completes the handshake must not hold the connection open.
  const handshakeTimer = setTimeout(() => finish(new AuthenticationError("secure handshake timed out")), cfg.handshakeTimeoutMs);
  // Node's WebSocket does not surface pings, so a silent link is detected by the daemon's heartbeats.
  const dog = watchdog(cfg.deadLinkTimeoutMs, () => finish(deadLinkError(cfg.deadLinkTimeoutMs)));
  const finish = (err) => {
    if (closed) return;
    closed = true;
    clearTimeout(handshakeTimer);
    dog.stop();
    try {
      ws.close();
    } catch {}
    handlers.onClose(err);
  };
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "hello", machine: cfg.machine, nc }));
  });
  ws.addEventListener("message", (ev) => {
    if (closed) return;
    dog.touch();
    try {
      if (!authed && frameSize(ev.data) > MAX_HANDSHAKE_FRAME) throw new AuthenticationError("handshake frame too large");
      const data = frameToText(ev.data);
      if (!cipher) {
        const msg = JSON.parse(data);
        if (msg?.type !== "challenge" || typeof msg.ns !== "string" || Buffer.from(msg.ns, "base64").length !== 16) {
          throw new AuthenticationError("unexpected handshake message");
        }
        ns = msg.ns;
        cipher = new Cipher(cfg.secret, cfg.machine, nc, ns, "client");
        ws.send(JSON.stringify({ type: "proof", mac: proof(cfg.secret, "client", cfg.machine, nc, ns) }));
        return;
      }
      const text = cipher.open(data);
      if (!authed) {
        const msg = JSON.parse(text.trim());
        if (msg?.type !== "authed" || typeof msg.mac !== "string" || !proofOk(cfg.secret, "server", cfg.machine, nc, ns, msg.mac)) {
          throw fatalAuth("daemon could not prove knowledge of the machine secret");
        }
        authed = true;
        clearTimeout(handshakeTimer);
        handlers.onOpen();
        return;
      }
      feed(text.endsWith("\n") ? text : text + "\n");
    } catch (e) {
      finish(e instanceof BridgeError ? e : new AuthenticationError(`secure channel failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  });
  ws.addEventListener("error", (ev) => {
    const cause = /** @type {any} */ (ev).error;
    const detail = cause instanceof Error ? cause.message : /** @type {any} */ (ev).message;
    finish(new NotConnectedError(detail ? `websocket error: ${detail}` : "websocket error", cause ? { cause } : undefined));
  });
  ws.addEventListener("close", (ev) => {
    if (ev.code === CLOSE_FORBIDDEN) finish(fatalAuth("daemon rejected the machine credentials (close 4003)"));
    else if (ev.code === CLOSE_TRY_LATER) finish(tryLater("daemon asked to try again later (close 4029: rate limit, capacity or timeout)"));
    else finish();
  });
  return {
    write: (line) => {
      if (!closed && authed) ws.send(cipher.seal(line + "\n"));
    },
    close: () => finish(),
  };
}

function text(value, field, allowEmpty = false) {
  if (typeof value !== "string" || (!value && !allowEmpty)) throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function asBridgeError(err) {
  if (err instanceof BridgeError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new NotConnectedError(`cannot reach the bridge daemon: ${msg}`, { cause: err });
}

export class Agent extends EventEmitter {
  #cfg;
  #link = null;
  #welcomed = false;
  #roomId = null;
  #closed = false;
  #nextId = 1;
  #pending = new Map();
  #approvals = new Map();
  #readyWaiters = [];
  #attempt = 0;
  #reconnectTimer = null;
  #helloId = null;

  constructor(opts) {
    super();
    this.#cfg = resolveOptions(opts);
    queueMicrotask(() => this.#open());
  }

  get name() {
    return this.#cfg.name;
  }
  get instance() {
    return this.#cfg.instance;
  }
  get mode() {
    return this.#cfg.mode;
  }
  get connected() {
    return this.#welcomed;
  }
  get roomId() {
    return this.#roomId;
  }

  #emitError(err) {
    if (this.listenerCount("error") > 0) this.emit("error", err);
  }

  async #open() {
    if (this.#closed) return;
    const handlers = {
      onOpen: () => this.#sendHello(),
      onLine: (line) => this.#onLine(line),
      onClose: (err) => this.#onClose(err),
    };
    try {
      const link = this.#cfg.mode === "remote" ? await openRemote(this.#cfg, handlers) : openLocal(this.#cfg, handlers);
      if (this.#closed) {
        link.close();
        return;
      }
      this.#link = link;
    } catch (e) {
      this.#onClose(e);
    }
  }

  #sendHello() {
    this.#helloId = this.#nextId++;
    const hello = { type: "hello", id: this.#helloId, name: this.#cfg.name, instance: this.#cfg.instance, client: this.#cfg.client };
    if (this.#cfg.version) hello.version = this.#cfg.version;
    this.#link?.write(JSON.stringify(hello));
  }

  #onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.#emitError(new BridgeError("invalid JSON from daemon"));
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "welcome":
        if (typeof msg.room_id !== "string") return;
        this.#roomId = msg.room_id;
        if (this.#welcomed) return;
        this.#welcomed = true;
        this.#attempt = 0;
        this.#helloId = null;
        for (const w of this.#readyWaiters.splice(0)) w.resolve({ roomId: msg.room_id });
        this.emit("connected", { roomId: msg.room_id });
        return;
      case "ok":
      case "error": {
        if (msg.type === "error" && this.#helloId !== null && (msg.id === this.#helloId || msg.id === undefined) && !this.#welcomed) {
          const err = new BridgeError(`daemon rejected registration: ${String(msg.error ?? "unknown error")}`);
          for (const w of this.#readyWaiters.splice(0)) w.reject(err);
          this.#emitError(err);
          this.#link?.close();
          return;
        }
        const p = typeof msg.id === "number" ? this.#pending.get(msg.id) : undefined;
        if (!p) {
          if (msg.type === "error") this.#emitError(new BridgeError(String(msg.error ?? "unknown error")));
          return;
        }
        this.#pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.type === "ok") p.resolve(msg);
        else p.reject(new BridgeError(String(msg.error ?? "unknown error")));
        return;
      }
      case "message":
        if (!MESSAGE_KINDS.has(msg.kind) || typeof msg.text !== "string") return;
        this.emit("message", msg);
        return;
      case "approval_result": {
        if (typeof msg.request_id !== "string") return;
        // Anything but an explicit "allow" counts as a denial.
        const decision = msg.decision === "allow" ? "allow" : "deny";
        const waiter = this.#approvals.get(msg.request_id);
        if (waiter) {
          this.#approvals.delete(msg.request_id);
          waiter.resolve(decision);
        }
        this.emit("approval_result", { request_id: msg.request_id, decision });
        return;
      }
      case "update":
        this.emit("update");
        return;
    }
  }

  #onClose(err) {
    const wasWelcomed = this.#welcomed;
    this.#link = null;
    this.#welcomed = false;
    this.#helloId = null;
    const lost = new NotConnectedError("connection to the bridge daemon lost");
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(lost);
      this.#pending.delete(id);
    }
    const error = err ? asBridgeError(err) : undefined;
    if (error && !this.#closed) this.#emitError(error);
    if (wasWelcomed) this.emit("disconnected");
    if (this.#closed) return;
    const authFailed = error !== undefined && FATAL_AUTH.has(error);
    if (!this.#cfg.reconnect || (authFailed && !this.#cfg.retryAuthFailures)) {
      this.#shutdown(error ?? new NotConnectedError("disconnected from the bridge daemon"));
      return;
    }
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.#attempt);
    this.#attempt = Math.min(this.#attempt + 1, 16);
    let delay = Math.max(authFailed ? AUTH_RETRY_MIN_MS : 0, Math.round(base * (0.8 + Math.random() * 0.4)));
    if (error !== undefined && TRY_LATER.has(error)) delay = TRY_LATER_MIN_MS + Math.round(Math.random() * TRY_LATER_JITTER_MS);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#open();
    }, delay);
  }

  /** Resolves once the daemon has welcomed this agent (immediately if already connected). */
  ready() {
    if (this.#closed) return Promise.reject(new NotConnectedError("agent is closed"));
    if (this.#welcomed) return Promise.resolve({ roomId: this.#roomId });
    return new Promise((resolve, reject) => this.#readyWaiters.push({ resolve, reject }));
  }

  /** Waits (within the request timeout) for a link if there is none, then sends and awaits ok/error. */
  async #request(type, fields) {
    if (this.#closed) throw new NotConnectedError("agent is closed");
    const deadline = Date.now() + this.#cfg.requestTimeoutMs;
    if (!this.#welcomed || !this.#link) await this.#waitReady(this.#cfg.requestTimeoutMs);
    // The link may have dropped again between the welcome and this continuation.
    if (this.#closed) throw new NotConnectedError("agent is closed");
    const link = this.#link;
    if (!this.#welcomed || !link) throw new NotConnectedError("connection to the bridge daemon lost");
    const id = this.#nextId++;
    const line = JSON.stringify({ type, id, ...fields });
    return new Promise((resolve, reject) => {
      try {
        link.write(line);
      } catch (e) {
        reject(asBridgeError(e));
        return;
      }
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RequestTimeoutError(`${type}: no answer from the daemon`));
      }, Math.max(0, deadline - Date.now()));
      this.#pending.set(id, { resolve, reject, timer });
    });
  }

  #waitReady(ms) {
    return new Promise((resolve, reject) => {
      let waiter;
      const timer = setTimeout(() => {
        this.#readyWaiters = this.#readyWaiters.filter((w) => w !== waiter);
        reject(new NotConnectedError("not connected to the bridge daemon"));
      }, ms);
      waiter = {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.#readyWaiters.push(waiter);
    });
  }

  async reply(value) {
    const ok = await this.#request("reply", { text: text(value, "text") });
    return { held: ok.held === true };
  }

  async status(value) {
    await this.#request("status", { text: text(value, "text") });
  }

  async ask(value) {
    await this.#request("ask", { text: text(value, "text") });
  }

  async poll(question, options) {
    if (!Array.isArray(options) || options.length < 2 || options.length > 20) {
      throw new RangeError("a poll needs 2 to 20 non-empty string options");
    }
    if (!options.every((o) => typeof o === "string" && o)) throw new TypeError("a poll needs 2 to 20 non-empty string options");
    await this.#request("poll", { question: text(question, "question"), options: [...options] });
  }

  /** Votes by option text or 1-based option number (sent as a string). */
  async vote(answer) {
    if (typeof answer === "number") {
      if (!Number.isSafeInteger(answer) || answer < 1) throw new RangeError("option numbers start at 1");
      answer = String(answer);
    }
    await this.#request("vote", { answer: text(answer, "answer") });
  }

  async react(emoji) {
    await this.#request("react", { emoji: text(emoji, "emoji") });
  }

  /**
   * Posts an Allow/Deny request and resolves with the owner's decision. `timeoutMs` bounds the
   * wait for the owner (default: wait indefinitely) and `signal` aborts it; both withdraw the poll
   * with `approval_cancel`. Pending approvals survive reconnects.
   */
  async requestApproval({ title, detail, requestId, timeoutMs, signal } = {}) {
    if (requestId !== undefined && requestId !== null) {
      text(requestId, "requestId");
      if (requestId.length > MAX_REQUEST_ID_LENGTH) throw new RangeError(`requestId must be at most ${MAX_REQUEST_ID_LENGTH} characters`);
    }
    if (timeoutMs !== undefined && timeoutMs !== null && (typeof timeoutMs !== "number" || !(timeoutMs >= 0))) {
      throw new RangeError("timeoutMs must be a non-negative number");
    }
    const fields = { request_id: requestId ?? randomUUID(), title: text(title, "title") };
    if (detail !== undefined && detail !== null) fields.detail = text(detail, "detail", true);
    const request_id = fields.request_id;
    signal?.throwIfAborted();
    if (this.#approvals.has(request_id)) throw new BridgeError(`approval "${request_id}" is already pending`);
    const decision = new Promise((resolve, reject) => this.#approvals.set(request_id, { resolve, reject }));
    // close() may reject this before the request is acknowledged; the caller then sees the request error.
    decision.catch(() => {});
    try {
      await this.#request("approval_request", fields);
    } catch (e) {
      this.#approvals.delete(request_id);
      throw e;
    }
    const stop = () => {
      if (!this.#approvals.delete(request_id)) return;
      // Best effort: withdraw the poll so a later vote is not taken for an answer nobody awaits.
      this.#request("approval_cancel", { request_id }).catch(() => {});
    };
    if (signal?.aborted) {
      stop();
      throw signal.reason;
    }
    const hasTimeout = timeoutMs !== undefined && timeoutMs !== null;
    if (!hasTimeout && !signal) return decision;
    let timer;
    let onAbort;
    const cancelled = new Promise((_, reject) => {
      if (hasTimeout) {
        timer = setTimeout(() => {
          stop();
          reject(new RequestTimeoutError("no approval decision in time"));
        }, timeoutMs);
      }
      if (signal) {
        onAbort = () => {
          stop();
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    try {
      return await Promise.race([decision, cancelled]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  async reportUpdated(from) {
    await this.#request("updated", { from: text(from, "from") });
  }

  async reportUpdateFailed(error) {
    await this.#request("update_failed", { error: text(error instanceof Error ? error.message : error, "error") });
  }

  #shutdown(err) {
    this.#closed = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    for (const w of this.#readyWaiters.splice(0)) w.reject(err);
    for (const a of this.#approvals.values()) a.reject(err);
    this.#approvals.clear();
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();
  }

  close() {
    if (this.#closed) return;
    this.#shutdown(new NotConnectedError("agent is closed"));
    this.#link?.close();
  }
}

export function connect(opts) {
  return new Agent(opts);
}
