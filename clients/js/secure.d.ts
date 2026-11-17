// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: Apache-2.0
// Low-level handshake and framing primitives (docs/reference/protocol.md, "Secure WebSocket handshake").
// Most users only need `newSecret()`; the agent client uses the rest internally.

export type Role = "client" | "server";

/** HKDF root key of a secret; throws unless the secret has the wire format (32-256 base64url characters). */
export declare function rootKey(secret: string): Buffer;
/** base64 HMAC proof of knowledge of the secret for one handshake. */
export declare function proof(secret: string, role: Role, machine: string, nc: string, ns: string): string;
/** Verifies a proof in constant time; never throws. */
export declare function proofOk(secret: string, role: Role, machine: string, nc: string, ns: string, mac: unknown): boolean;
/** A fresh 16-byte handshake nonce, base64. */
export declare function nonce(): string;
/** A new 43-character machine secret (32 random bytes, base64url without padding). */
export declare function newSecret(): string;

/** Per-connection AES-256-GCM cipher. `role` selects the direction used for sending. */
export declare class Cipher {
  constructor(secret: string, machine: string, nc: string, ns: string, role: Role);
  /** Encrypts one frame (base64). */
  seal(text: string): string;
  /** Decrypts one frame; throws on malformed frames, tampering, replay or reordering. */
  open(frame: string): string;
}
