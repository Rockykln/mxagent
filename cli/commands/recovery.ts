// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
// Matrix secret storage (m.secret_storage.v1.aes-hmac-sha2) and recovery key handling.
import crypto from "node:crypto";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PREFIX = [0x8b, 0x01];

function base58Decode(s: string): Buffer {
  let n = 0n;
  let zeros = 0;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("recovery key contains an invalid character");
    if (n === 0n && i === 0) zeros++;
    n = n * 58n + BigInt(i);
  }
  let hex = n === 0n ? "" : n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, "hex")]);
}

function base58Encode(b: Buffer): string {
  let n = BigInt("0x" + (b.toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of b) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** Decodes a recovery key (spaces allowed) to the 32-byte secret storage key. */
export function decodeRecoveryKey(key: string): Buffer {
  const raw = base58Decode(key.replace(/\s+/g, ""));
  if (raw.length !== 35 || raw[0] !== PREFIX[0] || raw[1] !== PREFIX[1]) throw new Error("not a recovery key (wrong length or prefix)");
  if (raw.reduce((a, b) => a ^ b, 0) !== 0) throw new Error("recovery key parity check failed (typo?)");
  return Buffer.from(raw.subarray(2, 34));
}

/** Encodes a 32-byte key as a recovery key in groups of four characters. */
export function encodeRecoveryKey(key: Buffer): string {
  if (key.length !== 32) throw new Error("key must be 32 bytes");
  const body = Buffer.concat([Buffer.from(PREFIX), key]);
  const parity = body.reduce((a, b) => a ^ b, 0);
  return base58Encode(Buffer.concat([body, Buffer.from([parity])])).replace(/(.{4})(?!$)/g, "$1 ");
}

const b64 = (s: string) => Buffer.from(s, "base64");
export const unpaddedBase64 = (b: Buffer) => b.toString("base64").replace(/=+$/, "");

function deriveKeys(key: Buffer, name: string) {
  const out = Buffer.from(crypto.hkdfSync("sha256", key, Buffer.alloc(32), name, 64));
  return { aes: out.subarray(0, 32), hmac: out.subarray(32) };
}

function macEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface EncryptedSecret {
  iv: string;
  ciphertext: string;
  mac: string;
}

export function encryptSecret(key: Buffer, name: string, plaintext: string, iv: Buffer = crypto.randomBytes(16)): EncryptedSecret {
  iv = Buffer.from(iv);
  iv[8] &= 0x7f; // spec: clear bit 63 of the IV
  const k = deriveKeys(key, name);
  const c = crypto.createCipheriv("aes-256-ctr", k.aes, iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  const mac = crypto.createHmac("sha256", k.hmac).update(ct).digest();
  return { iv: iv.toString("base64"), ciphertext: ct.toString("base64"), mac: mac.toString("base64") };
}

export function decryptSecret(key: Buffer, name: string, enc: EncryptedSecret): string {
  if (!enc || typeof enc.iv !== "string" || typeof enc.ciphertext !== "string" || typeof enc.mac !== "string")
    throw new Error(`secret ${name} is not encrypted with this key`);
  const k = deriveKeys(key, name);
  const ct = b64(enc.ciphertext);
  const mac = crypto.createHmac("sha256", k.hmac).update(ct).digest();
  if (!macEquals(mac, b64(enc.mac))) throw new Error(`MAC mismatch for ${name} (wrong recovery key?)`);
  const d = crypto.createDecipheriv("aes-256-ctr", k.aes, b64(enc.iv));
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

export interface SecretStorageKeyInfo {
  algorithm?: string;
  iv?: string;
  mac?: string;
}

/** Key check data (`iv`/`mac`) for m.secret_storage.key.* account data. */
export function keyCheck(key: Buffer, iv?: Buffer): { iv: string; mac: string } {
  const e = encryptSecret(key, "", "\0".repeat(32), iv);
  return { iv: e.iv, mac: e.mac };
}

/**
 * Throws if the key does not match the key description. Returns false when the description has no
 * check data (then only the MAC of each secret proves the key).
 */
export function verifyKeyInfo(key: Buffer, info: SecretStorageKeyInfo): boolean {
  if (info.algorithm !== undefined && info.algorithm !== "m.secret_storage.v1.aes-hmac-sha2")
    throw new Error(`unsupported secret storage algorithm ${info.algorithm}`);
  if (typeof info.iv !== "string" || typeof info.mac !== "string") return false;
  const k = deriveKeys(key, "");
  const c = crypto.createCipheriv("aes-256-ctr", k.aes, b64(info.iv));
  const ct = Buffer.concat([c.update(Buffer.alloc(32)), c.final()]);
  const mac = crypto.createHmac("sha256", k.hmac).update(ct).digest();
  if (!macEquals(mac, b64(info.mac))) throw new Error("recovery key does not match the secret storage key");
  return true;
}

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** ed25519 key pair from a 32-byte seed; public key as unpadded base64. */
export function ed25519FromSeed(seed: Buffer): { privateKey: crypto.KeyObject; publicKey: string } {
  if (seed.length !== 32) throw new Error("cross-signing key has the wrong length");
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const der = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  return { privateKey, publicKey: unpaddedBase64(der.subarray(der.length - 32)) };
}
