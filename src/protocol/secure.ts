// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared-secret handshake and per-connection framing; see docs/reference/protocol.md
// ("Secure WebSocket handshake"). The secret itself never crosses the wire.
import crypto from "node:crypto";

export type Role = "client" | "server";

const SALT = Buffer.from("mxagent", "utf8");
const NONCE_RE = /^[A-Za-z0-9+/]{22}==$/;
const MAC_RE = /^[A-Za-z0-9+/]{43}=$/;
const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SECRET_RE = /^[A-Za-z0-9_-]{32,256}$/;
const MACHINE_RE = /^[a-z0-9-]{1,32}$/;
const TAG_LEN = 16;
const CTR_LEN = 8;
const SEP = Buffer.from([0]);
const utf8 = new TextDecoder("utf-8", { fatal: true });

function decodeNonce(s: unknown): Buffer {
  if (typeof s !== "string" || !NONCE_RE.test(s)) throw new Error("invalid nonce");
  return Buffer.from(s, "base64");
}

function checkRole(role: unknown): Role {
  if (role !== "client" && role !== "server") throw new Error("invalid role");
  return role;
}

function checkMachine(machine: unknown): Buffer {
  if (typeof machine !== "string" || !MACHINE_RE.test(machine)) throw new Error("invalid machine name");
  return Buffer.from(machine, "utf8");
}

/** Throws unless `secret` has the wire format (32-256 base64url characters, used verbatim). */
export function rootKey(secret: string): Buffer {
  if (typeof secret !== "string" || !SECRET_RE.test(secret)) throw new Error("invalid secret");
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), SALT, "root-v1", 32));
}

/** base64( HMAC-SHA256(root, role || 0x00 || machine || 0x00 || nc || ns) ) */
export function proof(secret: string, role: Role, machine: string, nc: string, ns: string): string {
  const r = checkRole(role);
  const m = checkMachine(machine);
  return crypto
    .createHmac("sha256", rootKey(secret))
    .update(r, "utf8")
    .update(SEP)
    .update(m)
    .update(SEP)
    .update(decodeNonce(nc))
    .update(decodeNonce(ns))
    .digest("base64");
}

export function proofOk(secret: string, role: Role, machine: string, nc: string, ns: string, mac: unknown): boolean {
  if (typeof mac !== "string" || !MAC_RE.test(mac)) return false;
  let want: Buffer;
  try {
    want = Buffer.from(proof(secret, role, machine, nc, ns), "base64");
  } catch {
    return false;
  }
  const got = Buffer.from(mac, "base64");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export function nonce(): string {
  return crypto.randomBytes(16).toString("base64");
}

export function newSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function iv(dir: number, ctr: bigint): Buffer {
  const out = Buffer.alloc(12);
  out[0] = dir;
  out.writeBigUInt64BE(ctr, 4);
  return out;
}

/** Per-connection AES-256-GCM cipher. `role` selects the direction byte used for sending. */
export class Cipher {
  readonly #key: Buffer;
  readonly #sendDir: number;
  readonly #recvDir: number;
  #sendCtr = 0n;
  #recvCtr = 0n;

  constructor(secret: string, machine: string, nc: string, ns: string, role: Role) {
    const r = checkRole(role);
    const info = Buffer.concat([Buffer.from("session-v1", "utf8"), SEP, checkMachine(machine)]);
    const salt = Buffer.concat([decodeNonce(nc), decodeNonce(ns)]);
    this.#key = Buffer.from(crypto.hkdfSync("sha256", rootKey(secret), salt, info, 32));
    this.#sendDir = r === "client" ? 1 : 2;
    this.#recvDir = r === "client" ? 2 : 1;
  }

  seal(text: string): string {
    if (typeof text !== "string") throw new Error("seal expects a string");
    const ctr = this.#sendCtr + 1n;
    if (ctr > 0xffffffffffffffffn) throw new Error("counter exhausted");
    this.#sendCtr = ctr;
    const c = crypto.createCipheriv("aes-256-gcm", this.#key, iv(this.#sendDir, ctr));
    const head = Buffer.alloc(CTR_LEN);
    head.writeBigUInt64BE(ctr);
    return Buffer.concat([head, c.update(text, "utf8"), c.final(), c.getAuthTag()]).toString("base64");
  }

  /** Throws on malformed frames, tampering, replay or reordering. */
  open(frame: string): string {
    if (typeof frame !== "string" || !B64_RE.test(frame)) throw new Error("malformed frame");
    const raw = Buffer.from(frame, "base64");
    if (raw.length < CTR_LEN + TAG_LEN) throw new Error("short frame");
    const ctr = raw.readBigUInt64BE(0);
    if (ctr !== this.#recvCtr + 1n) throw new Error("unexpected counter");
    const d = crypto.createDecipheriv("aes-256-gcm", this.#key, iv(this.#recvDir, ctr));
    d.setAuthTag(raw.subarray(raw.length - TAG_LEN));
    const plain = Buffer.concat([d.update(raw.subarray(CTR_LEN, raw.length - TAG_LEN)), d.final()]);
    const text = utf8.decode(plain); // invalid UTF-8 throws
    this.#recvCtr = ctr;
    return text;
  }
}
