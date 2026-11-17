// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import type net from "node:net";
import type { WebSocket } from "ws";
import type { Cipher } from "../../protocol/secure.ts";

/** One agent link, independent of the transport. Lines are NDJSON objects. */
export interface Connection {
  readonly machine: string;
  /** Sends one NDJSON line; a missing trailing "\n" is added. No-op once closed. */
  write(line: string): void;
  close(): void;
  alive(): boolean;
  onLine(cb: (obj: unknown) => void): void;
  onClose(cb: () => void): void;
}

export const MAX_LINE_LENGTH = 64 * 1024 * 1024;
/**
 * Per connection: a peer that does not read its data is dropped when a write would take the output buffered
 * for it above this many bytes (UTF-8 for the Unix socket, encrypted base64 frames for WebSocket). A write to
 * an empty buffer always goes out, so one maximum-size line is never refused.
 */
export const MAX_BUFFERED_OUTPUT = 256 * 1024 * 1024;
export const DEFAULT_ALIVE_MS = 75_000;

/**
 * Splits a character stream into JSON values. Invalid JSON lines and blank lines are skipped.
 * Returns false from push() when a single line exceeds `maxLine` characters.
 */
export class LineSplitter {
  #buf = "";
  readonly #maxLine: number;
  readonly #emit: (obj: unknown) => void;

  constructor(emit: (obj: unknown) => void, maxLine = MAX_LINE_LENGTH) {
    this.#emit = emit;
    this.#maxLine = maxLine;
  }

  push(chunk: string): boolean {
    let start = 0;
    let nl: number;
    while ((nl = chunk.indexOf("\n", start)) >= 0) {
      const part = chunk.slice(start, nl);
      start = nl + 1;
      if (this.#buf.length + part.length > this.#maxLine) return false;
      const line = this.#buf + part;
      this.#buf = "";
      this.#parse(line);
    }
    const rest = chunk.slice(start);
    if (this.#buf.length + rest.length > this.#maxLine) return false;
    this.#buf += rest;
    return true;
  }

  #parse(line: string): void {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!trimmed.trim()) return;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return;
    }
    this.#emit(obj);
  }
}

/** Shared listener bookkeeping: lines arriving before the first onLine() are queued. */
class Base {
  readonly machine: string;
  #lineCbs: ((obj: unknown) => void)[] = [];
  #closeCbs: (() => void)[] = [];
  #pending: unknown[] = [];
  protected closed = false;
  /** Set by close(); the transport's close event (async) then runs markClosed(). */
  protected stopped = false;

  constructor(machine: string) {
    this.machine = machine;
  }

  onLine(cb: (obj: unknown) => void): void {
    this.#lineCbs.push(cb);
    if (this.#pending.length) {
      const queued = this.#pending;
      this.#pending = [];
      for (const obj of queued) this.dispatch(obj);
    }
  }

  onClose(cb: () => void): void {
    if (this.closed) queueMicrotask(cb);
    else this.#closeCbs.push(cb);
  }

  protected dispatch(obj: unknown): void {
    if (this.closed || this.stopped) return;
    if (!this.#lineCbs.length) {
      this.#pending.push(obj);
      return;
    }
    for (const cb of this.#lineCbs) {
      try {
        cb(obj);
      } catch {
        // a throwing handler must not break the stream for the others
      }
    }
  }

  protected markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.#pending = [];
    this.#lineCbs = [];
    const cbs = this.#closeCbs;
    this.#closeCbs = [];
    for (const cb of cbs) {
      try {
        cb();
      } catch {
        // ignore
      }
    }
  }
}

function terminated(line: string): string {
  return line.endsWith("\n") ? line : line + "\n";
}

class SocketConnection extends Base implements Connection {
  readonly #sock: net.Socket;
  readonly #maxBuffered: number;

  constructor(sock: net.Socket, machine: string, maxLine: number, maxBuffered: number) {
    super(machine);
    this.#sock = sock;
    this.#maxBuffered = maxBuffered;
    const splitter = new LineSplitter((obj) => this.dispatch(obj), maxLine);
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      if (!splitter.push(chunk)) this.close();
    });
    sock.on("close", () => this.markClosed());
    sock.on("error", () => {});
  }

  write(line: string): void {
    if (this.closed || this.stopped || this.#sock.destroyed || !this.#sock.writable) return;
    const data = Buffer.from(terminated(line), "utf8");
    if (this.#sock.writableLength > 0 && this.#sock.writableLength + data.length > this.#maxBuffered) {
      this.close();
      return;
    }
    this.#sock.write(data);
  }

  close(): void {
    this.stopped = true;
    this.#sock.destroy();
  }

  alive(): boolean {
    return !this.closed && !this.stopped && !this.#sock.destroyed;
  }
}

export function socketConnection(
  sock: net.Socket,
  machine: string,
  opts: { maxLine?: number; maxBufferedOutput?: number } = {},
): Connection {
  return new SocketConnection(sock, machine, opts.maxLine ?? MAX_LINE_LENGTH, opts.maxBufferedOutput ?? MAX_BUFFERED_OUTPUT);
}

export interface WsConnectionOptions {
  maxLine?: number;
  maxBufferedOutput?: number; // bytes, default MAX_BUFFERED_OUTPUT
  aliveMs?: number;
  now?: () => number;
}

class WsConnection extends Base implements Connection {
  readonly #ws: WebSocket;
  readonly #cipher: Cipher;
  readonly #aliveMs: number;
  readonly #maxBuffered: number;
  readonly #now: () => number;
  #lastPong: number;

  constructor(ws: WebSocket, cipher: Cipher, machine: string, opts: WsConnectionOptions) {
    super(machine);
    this.#ws = ws;
    this.#cipher = cipher;
    this.#aliveMs = opts.aliveMs ?? DEFAULT_ALIVE_MS;
    this.#maxBuffered = opts.maxBufferedOutput ?? MAX_BUFFERED_OUTPUT;
    this.#now = opts.now ?? Date.now;
    this.#lastPong = this.#now();
    const splitter = new LineSplitter((obj) => this.dispatch(obj), opts.maxLine ?? MAX_LINE_LENGTH);
    ws.on("message", (data) => {
      if (this.closed || this.stopped) return;
      let text: string;
      try {
        text = this.#cipher.open(rawToString(data));
      } catch {
        this.close(); // tampered, replayed, reordered or not a frame
        return;
      }
      if (!splitter.push(text.endsWith("\n") ? text : text + "\n")) this.close();
    });
    ws.on("pong", () => {
      this.#lastPong = this.#now();
    });
    ws.on("close", () => this.markClosed());
    ws.on("error", () => {});
  }

  write(line: string): void {
    if (this.closed || this.stopped || this.#ws.readyState !== this.#ws.OPEN) return;
    const frame = this.#cipher.seal(terminated(line));
    if (this.#ws.bufferedAmount > 0 && this.#ws.bufferedAmount + frame.length > this.#maxBuffered) {
      this.close();
      return;
    }
    this.#ws.send(frame);
  }

  close(): void {
    this.stopped = true;
    // terminate() drops a dead peer immediately; close() would wait for its close frame
    this.#ws.terminate();
  }

  alive(): boolean {
    return !this.closed && !this.stopped && this.#ws.readyState === this.#ws.OPEN && this.#now() - this.#lastPong < this.#aliveMs;
  }
}

export function rawToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return String(data);
}

/**
 * Wraps an authenticated WebSocket. Every inbound frame is decrypted with `cipher` and may hold one or
 * more NDJSON lines; every write() becomes one encrypted frame.
 */
export function wsConnection(ws: WebSocket, cipher: Cipher, machine: string, opts: WsConnectionOptions = {}): Connection {
  return new WsConnection(ws, cipher, machine, opts);
}
