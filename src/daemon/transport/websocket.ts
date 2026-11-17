// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { Cipher, newSecret, nonce, proof, proofOk } from "../../protocol/secure.ts";
import type { Logger } from "../log.ts";
import type { ProxyHeaderMode } from "../config.ts";
import { MACHINE_NAME_RE } from "../machines.ts";
import { rawToString, wsConnection, type Connection } from "./link.ts";

export const MAX_INBOUND_FRAME = 1024 * 1024;
const NONCE_RE = /^[A-Za-z0-9+/]{22}==$/;
/** Close codes (docs/reference/protocol.md): authentication failed (fatal for clients) / transient refusal, retry later. */
export const CLOSE_FORBIDDEN = 4003;
export const CLOSE_TRY_LATER = 4029;

export interface WebSocketOptions {
  host: string;
  port: number; // 0 picks a free port (see WebSocketServerHandle.port)
  log: Logger;
  /** Result of GET /health. */
  healthy: () => boolean;
  secretFor: (machine: string) => string | undefined;
  onConnection: (conn: Connection) => void;
  /** Header that holds the client address ("none": the socket address). Only set behind a trusted proxy. */
  trustProxyHeader?: ProxyHeaderMode;
  helloTimeoutMs?: number; // 3000 until "hello" arrives ...
  handshakeTimeoutMs?: number; // ... 10000 for the whole handshake
  pingIntervalMs?: number; // 30000; also the dead-link / revoked-secret sweep interval
  aliveMs?: number; // 75000
  maxFailures?: number; // 10 failed handshakes ...
  failureWindowMs?: number; // ... per 600000 ms lock the address out until the window ends
  trustedLoginMs?: number; // 86400000: a machine that authenticated from an address keeps working there during a lockout
  maxPendingPerAddress?: number; // 8 unfinished handshakes per client address ...
  maxPendingTotal?: number; // ... and 256 in total; further connections are closed with 4029
  maxSoftFailures?: number; // 30 handshakes per address that time out or close early (per failureWindowMs) lock it out too
  maxConnections?: number; // 512 WebSocket connections in total (pending and authenticated); further ones get 4029
  maxLinksPerMachine?: number; // 64 authenticated links per machine
  maxTrackedAddresses?: number; // 10000 entries in the failure table
  now?: () => number;
}

export interface WebSocketServerHandle {
  readonly port: number;
  close(): Promise<void>;
}

interface Failure {
  count: number;
  until: number;
  soft: boolean; // a timeout or close during the handshake was already counted in this window
}

/**
 * Failed handshakes per key within a window. Bounded: when full, expired and then the oldest non-locked
 * entries are evicted; active lockouts are never evicted (a new key is then not tracked).
 */
class FailureTable {
  readonly #map = new Map<string, Failure>();
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #max: number;
  readonly #now: () => number;
  readonly #onFull: () => void;

  constructor(limit: number, windowMs: number, max: number, now: () => number, onFull: () => void) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#max = max;
    this.#now = now;
    this.#onFull = onFull;
  }

  get size(): number {
    return this.#map.size;
  }

  locked(key: string): boolean {
    const f = this.#map.get(key);
    return !!f && f.until > this.#now() && f.count >= this.#limit;
  }

  /** `soft` failures (timeout, close) count at most once per window. */
  record(key: string, soft = false): void {
    const t = this.#now();
    const f = this.#map.get(key);
    if (f && f.until > t) {
      if (soft) {
        if (f.soft) return;
        f.soft = true;
      }
      f.count++;
      return;
    }
    if (f) this.#map.delete(key);
    if (!this.#makeRoom(t)) {
      this.#onFull();
      return;
    }
    this.#map.set(key, { count: 1, until: t + this.#windowMs, soft });
  }

  clear(key: string): void {
    this.#map.delete(key);
  }

  #makeRoom(t: number): boolean {
    if (this.#map.size < this.#max) return true;
    for (const [k, v] of this.#map) if (v.until <= t) this.#map.delete(k);
    for (const [k, v] of this.#map) {
      if (this.#map.size < this.#max) break;
      if (v.count < this.#limit) this.#map.delete(k);
    }
    return this.#map.size < this.#max;
  }
}

/** Strips a port and IPv6 brackets ("1.2.3.4:5", "[v6]:5", "[v6]"); returns undefined if no IP remains. */
export function parseForwardedAddress(value: string): string | undefined {
  let v = value.trim();
  const bracket = v.match(/^\[([^\]]+)\](?::\d{1,5})?$/);
  if (bracket) v = bracket[1]!;
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(v)) v = v.slice(0, v.lastIndexOf(":"));
  return net.isIP(v) ? v : undefined;
}

/**
 * Client address for rate limits and logs. Only the configured header is read: CF-Connecting-IP as a single
 * value, X-Forwarded-For by its right-most entry (added by the trusted proxy itself; earlier entries are
 * client-controlled). A missing or invalid header falls back to the socket address.
 */
export function clientAddress(req: http.IncomingMessage, mode: ProxyHeaderMode = "none"): string {
  const socketAddr = req.socket.remoteAddress ?? "unknown";
  if (mode === "none") return socketAddr;
  const raw = req.headers[mode];
  const joined = Array.isArray(raw) ? raw.join(",") : raw;
  if (!joined) return socketAddr;
  const value = mode === "x-forwarded-for" ? joined.split(",").map((s) => s.trim()).filter(Boolean).at(-1) : joined;
  return (value && parseForwardedAddress(value)) || socketAddr;
}

function isLocalAddress(addr: string): boolean {
  const a = addr.replace(/^::ffff:/i, "");
  return a === "::1" || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a) || /^f[cd]/i.test(a);
}

/**
 * Key for rate limits and pending caps: IPv4 as is (also when IPv4-mapped), IPv6 by its /64 prefix,
 * because a single client usually controls a whole /64.
 */
export function rateLimitKey(addr: string): string {
  const mapped = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return mapped[1]!;
  if (!addr.includes(":") || !net.isIPv6(addr)) return addr;
  const [head, tail] = addr.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  if (right.length && right[right.length - 1]!.includes(".")) right.splice(-1, 1, "0", "0"); // embedded IPv4
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(":")}::/64`;
}

function sameSecret(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * One HTTP server: GET /health for monitoring, WebSocket upgrades for remote agents (secure handshake per
 * docs/reference/protocol.md), everything else 426.
 */
export async function startWebSocket(opts: WebSocketOptions): Promise<WebSocketServerHandle> {
  const { log, healthy, secretFor, onConnection } = opts;
  const now = opts.now ?? Date.now;
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 10_000;
  const helloTimeoutMs = Math.min(opts.helloTimeoutMs ?? 3_000, handshakeTimeoutMs);
  const pingIntervalMs = opts.pingIntervalMs ?? 30_000;
  const aliveMs = opts.aliveMs ?? 75_000;
  const maxFailures = opts.maxFailures ?? 10;
  const failureWindowMs = opts.failureWindowMs ?? 600_000;
  const trustedLoginMs = opts.trustedLoginMs ?? 86_400_000;
  const proxyMode: ProxyHeaderMode = opts.trustProxyHeader ?? "none";
  const maxPendingPerAddress = opts.maxPendingPerAddress ?? 8;
  const maxPendingTotal = opts.maxPendingTotal ?? 256;
  const maxConnections = opts.maxConnections ?? 512;
  const maxSoftFailures = opts.maxSoftFailures ?? 30;
  const maxLinksPerMachine = opts.maxLinksPerMachine ?? 64;
  const maxTracked = opts.maxTrackedAddresses ?? 10_000;

  let warnedFull = false;
  const onFull = () => {
    if (warnedFull) return;
    warnedFull = true;
    log.warn("websocket failure table is full of active lockouts; new addresses are not tracked");
  };
  const failures = new FailureTable(maxFailures, failureWindowMs, maxTracked, now, onFull);
  // per (address, machine) for machines that authenticated from that address before (see trusted)
  const pairFailures = new FailureTable(maxFailures, failureWindowMs, maxTracked, now, onFull);
  // every idle or aborted handshake per address (the main table counts them once per window), so a client
  // cannot keep its pending slots busy forever with handshakes that never finish
  const softFailures = new FailureTable(maxSoftFailures, failureWindowMs, maxTracked, now, onFull);
  // address -> machine -> time of the last successful handshake; lets known machines through an address lockout
  const trusted = new Map<string, Map<string, number>>();
  const links = new Map<WebSocket, { conn: Connection; machine: string; secret: string }>();
  const linksPerMachine = new Map<string, number>();
  const pending = new Map<string, number>(); // client address -> unfinished handshakes
  let pendingTotal = 0;
  let closing = false;
  let warnedProxy = false;

  const pairKey = (addr: string, machine: string) => `${addr} ${machine}`;
  const isTrusted = (addr: string, machine?: string): boolean => {
    const m = trusted.get(addr);
    if (!m) return false;
    const t = now();
    for (const [k, at] of m) if (t - at >= trustedLoginMs) m.delete(k);
    if (!m.size) {
      trusted.delete(addr);
      return false;
    }
    return machine === undefined || m.has(machine);
  };
  const markTrusted = (addr: string, machine: string): void => {
    const m = trusted.get(addr) ?? new Map<string, number>();
    trusted.delete(addr); // re-insert: the map is kept in least-recently-used order
    m.delete(machine);
    m.set(machine, now());
    while (m.size > 64) m.delete(m.keys().next().value!);
    trusted.set(addr, m);
    while (trusted.size > maxTracked) trusted.delete(trusted.keys().next().value!);
  };

  const refuse = (ws: WebSocket, code: number = CLOSE_FORBIDDEN): void => {
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      ws.close(code, code === CLOSE_TRY_LATER ? "try later" : "forbidden");
    }
    // a peer that ignores the close frame is dropped shortly after
    setTimeout(() => ws.terminate(), 2000).unref();
  };

  const httpServer = http.createServer((req, res) => {
    const url = req.url ?? "";
    const pathOnly = url.split("?")[0];
    if (req.method === "GET" && pathOnly === "/health") {
      let ok = false;
      try {
        ok = healthy();
      } catch {
        ok = false;
      }
      res.writeHead(ok ? 200 : 503, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end(ok ? "ok" : "stale");
      return;
    }
    res.writeHead(426, { "Content-Type": "text/plain", Upgrade: "websocket", Connection: "Upgrade", "Cache-Control": "no-store" }).end();
  });

  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_INBOUND_FRAME, perMessageDeflate: false });
  wss.on("error", (e) => log.error("websocket server error:", e));

  // bound how long a client may take to send the upgrade request (slow-header connections)
  httpServer.headersTimeout = Math.min(httpServer.headersTimeout, 15_000);
  httpServer.requestTimeout = Math.min(httpServer.requestTimeout || Infinity, 20_000);
  // raw TCP connections (before the upgrade, health checks); some headroom over the WebSocket cap
  httpServer.maxConnections = maxConnections + 64;

  wss.on("connection", (ws, req) => {
    const shown = clientAddress(req, proxyMode);
    const addr = rateLimitKey(shown);
    ws.on("error", () => {});
    if (closing) {
      ws.terminate();
      return;
    }
    if (proxyMode === "none" && !warnedProxy && isLocalAddress(shown)) {
      warnedProxy = true;
      log.warn(
        `websocket connection from local address ${shown}: behind a reverse proxy all clients share this address ` +
          "for rate limits; set MXA_TRUST_PROXY_HEADER",
      );
    }
    if (wss.clients.size > maxConnections) {
      log.warn("websocket connection refused (too many connections):", shown);
      refuse(ws, CLOSE_TRY_LATER);
      return;
    }
    // an address lockout spares machines that authenticated from this address before; they are checked at hello
    if ((failures.locked(addr) || softFailures.locked(addr)) && !isTrusted(addr)) {
      log.warn("websocket handshake refused (rate limited):", shown);
      refuse(ws, CLOSE_TRY_LATER);
      return;
    }
    const mine = pending.get(addr) ?? 0;
    if (mine >= maxPendingPerAddress || pendingTotal >= maxPendingTotal) {
      log.warn("websocket handshake refused (too many pending):", shown);
      refuse(ws, CLOSE_TRY_LATER);
      return;
    }
    pending.set(addr, mine + 1);
    pendingTotal++;
    handshake(ws, addr, shown);
  });

  const releasePending = (addr: string): void => {
    pendingTotal--;
    const n = (pending.get(addr) ?? 1) - 1;
    if (n > 0) pending.set(addr, n);
    else pending.delete(addr);
  };

  type Counted = "hard" | "soft" | "none";

  function handshake(ws: WebSocket, addr: string, shown: string): void {
    let step = 0;
    let done = false;
    let machine = "";
    let secret = "";
    let nc = "";
    let ns = "";
    let pairTrusted = false;

    const finish = () => {
      done = true;
      releasePending(addr);
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
    };
    const fail = (why: string, counted: Counted = "hard", code: number = CLOSE_FORBIDDEN) => {
      if (done) return;
      finish();
      if (closing) return;
      if (counted !== "none") {
        failures.record(addr, counted === "soft");
        if (counted === "soft") softFailures.record(addr);
        if (pairTrusted) pairFailures.record(pairKey(addr, machine), counted === "soft");
      }
      log.warn(`websocket handshake failed from ${shown}: ${why}`);
      // only a wrong proof or a broken handshake is final; timeouts, lockouts and caps are worth a later retry
      refuse(ws, code);
    };
    const onClose = () => fail("closed during handshake", "soft", CLOSE_TRY_LATER);
    let timer = setTimeout(() => fail("timeout", "soft", CLOSE_TRY_LATER), helloTimeoutMs);
    timer.unref();

    const onMessage = (data: unknown) => {
      if (done) return;
      let msg: unknown;
      try {
        msg = JSON.parse(rawToString(data));
      } catch {
        return fail("malformed frame");
      }
      if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return fail("malformed frame");
      const m = msg as Record<string, unknown>;
      if (step === 0) {
        if (m.type !== "hello") return fail("expected hello");
        if (typeof m.machine !== "string" || !MACHINE_NAME_RE.test(m.machine)) return fail("invalid machine name");
        if (typeof m.nc !== "string" || !NONCE_RE.test(m.nc)) return fail("invalid nonce");
        machine = m.machine;
        nc = m.nc;
        pairTrusted = isTrusted(addr, machine);
        const addrLocked = failures.locked(addr) || softFailures.locked(addr);
        if (addrLocked && (!pairTrusted || pairFailures.locked(pairKey(addr, machine)))) {
          return fail("rate limited", "none", CLOSE_TRY_LATER);
        }
        let known: string | undefined;
        try {
          known = secretFor(machine);
        } catch (e) {
          log.error("machine secret lookup failed:", e as Error);
        }
        // unknown machines get a challenge too, with a throw-away secret, so names cannot be probed
        secret = known ?? newSecret();
        ns = nonce();
        step = 1;
        clearTimeout(timer);
        timer = setTimeout(() => fail("timeout", "soft", CLOSE_TRY_LATER), Math.max(0, handshakeTimeoutMs - helloTimeoutMs));
        timer.unref();
        ws.send(JSON.stringify({ type: "challenge", ns }));
        return;
      }
      if (m.type !== "proof") return fail("expected proof");
      if (!proofOk(secret, "client", machine, nc, ns, m.mac)) return fail(`bad proof for machine ${machine}`);
      if ((linksPerMachine.get(machine) ?? 0) >= maxLinksPerMachine) {
        log.warn(`websocket link refused: machine ${machine} already has ${maxLinksPerMachine} links`);
        return fail("too many links", "none", CLOSE_TRY_LATER);
      }
      finish();
      failures.clear(addr);
      softFailures.clear(addr);
      pairFailures.clear(pairKey(addr, machine));
      markTrusted(addr, machine);
      let conn: Connection;
      try {
        const cipher = new Cipher(secret, machine, nc, ns, "server");
        conn = wsConnection(ws, cipher, machine, { aliveMs, now });
        conn.write(JSON.stringify({ type: "authed", machine, mac: proof(secret, "server", machine, nc, ns) }));
      } catch (e) {
        log.error("websocket link setup failed:", e as Error);
        ws.terminate();
        return;
      }
      links.set(ws, { conn, machine, secret });
      linksPerMachine.set(machine, (linksPerMachine.get(machine) ?? 0) + 1);
      conn.onClose(() => {
        links.delete(ws);
        const n = (linksPerMachine.get(machine) ?? 1) - 1;
        if (n > 0) linksPerMachine.set(machine, n);
        else linksPerMachine.delete(machine);
      });
      log.info(`websocket link up: machine ${machine} from ${shown}`);
      try {
        onConnection(conn);
      } catch (e) {
        log.error("websocket connection handler failed:", e as Error);
        conn.close();
      }
    };

    ws.on("message", onMessage);
    ws.on("close", onClose);
  }

  const sweep = setInterval(() => {
    for (const [ws, link] of links) {
      let current: string | undefined;
      try {
        current = secretFor(link.machine);
      } catch {
        current = link.secret; // lookup errors must not drop every link
      }
      if (!sameSecret(current, link.secret)) {
        log.info(`closing link of machine ${link.machine}: secret revoked`);
        link.conn.close();
        continue;
      }
      if (!link.conn.alive()) {
        log.info(`dropping dead link of machine ${link.machine}`);
        link.conn.close();
        continue;
      }
      if (ws.readyState === ws.OPEN) ws.ping();
    }
  }, pingIntervalMs);
  sweep.unref();

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  httpServer.on("error", (e) => log.error("http server error:", e));
  const port = (httpServer.address() as AddressInfo).port;
  log.info(`websocket listening on ${opts.host}:${port}`);

  return {
    port,
    close: () => {
      if (closing) return Promise.resolve();
      closing = true;
      clearInterval(sweep);
      for (const ws of wss.clients) ws.terminate();
      return new Promise<void>((resolve) => {
        wss.close(() => {
          httpServer.close(() => resolve());
          httpServer.closeAllConnections();
        });
      });
    },
  };
}
