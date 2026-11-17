// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
// Verifies that a decrypted event came from a cross-signed device of the owner, and that every device the bot
// would share room keys with (all devices of owner and bot) is cross-signed.
// Chain: bot master key (anchored locally by mxagentctl cross-sign) -> bot user-signing key -> owner master key
// (pinned on first use) -> owner self-signing key -> owner device; bot master key -> bot self-signing key -> bot device.
import crypto from "node:crypto";

export interface SignedKeys {
  user_id?: string;
  usage?: string[];
  keys: Record<string, string>;
  signatures?: Record<string, Record<string, string>>;
  [k: string]: unknown;
}

/** Subset of the /keys/query response that is evaluated. */
export interface KeysQueryResponse {
  master_keys?: Record<string, SignedKeys>;
  self_signing_keys?: Record<string, SignedKeys>;
  user_signing_keys?: Record<string, SignedKeys>;
  device_keys?: Record<string, Record<string, SignedKeys>>;
  [k: string]: unknown;
}

/** Matrix canonical JSON: sorted keys, no insignificant whitespace. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Checks `obj.signatures[signer]["ed25519:" + keyId]` against the ed25519 public key `pubKey` (base64). */
export function verifySignature(obj: SignedKeys, signer: string, keyId: string, pubKey: string): boolean {
  const sig = obj.signatures?.[signer]?.[`ed25519:${keyId}`];
  if (typeof sig !== "string") return false;
  const { signatures: _s, unsigned: _u, ...signed } = obj;
  try {
    const raw = Buffer.from(pubKey, "base64");
    if (raw.length !== 32) return false;
    const pub = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(canonicalJson(signed)), pub, Buffer.from(sig, "base64"));
  } catch {
    return false;
  }
}

/**
 * Public key of a cross-signing key object if it has exactly one ed25519 key whose id is `ed25519:<key>`, the
 * right owner and usage.
 */
export function crossSigningKey(k: SignedKeys | undefined, user: string, usage: string): string | undefined {
  if (!k || typeof k.keys !== "object" || k.keys === null) return undefined;
  if (k.user_id !== user) return undefined;
  if (!Array.isArray(k.usage) || !k.usage.includes(usage)) return undefined;
  const entries = Object.entries(k.keys).filter(([id]) => id.startsWith("ed25519:"));
  if (entries.length !== 1 || typeof entries[0][1] !== "string" || entries[0][0] !== `ed25519:${entries[0][1]}`) return undefined;
  return entries[0][1];
}

const verifyCross = (obj: SignedKeys, signer: string, pub: string) => verifySignature(obj, signer, pub, pub);

/** Result of OwnerTrust.auditDevices. */
export interface DeviceAudit {
  /** null if every device of owner and bot is cross-signed; else a reason naming the unverified devices. */
  problem: string | null;
  /** Devices that may receive room keys (cross-signed, plus the daemon's own device): user id -> device ids. */
  allowed: ReadonlyMap<string, ReadonlySet<string>>;
  /** Cross-signed devices with their signed curve25519 key: user id -> device id -> key. Key sharing is bound to these keys, not just ids. */
  allowedKeys: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

const NOT_ANCHORED = "bot identity not anchored; run mxagentctl cross-sign";
const MAX_LISTED_DEVICES = 10;
/** A cached audit with a problem is re-queried once if the keys are older than this. */
const AUDIT_REFRESH_MS = 5_000;

/** Device id as shown in notices: homeserver-supplied, so only plain ids are repeated. */
function showDevice(id: string): string {
  return /^[A-Za-z0-9_.=+/-]{1,64}$/.test(id) ? id : "<invalid id>";
}

function deviceSignedBy(dev: SignedKeys | undefined, user: string, id: string, sskPub: string): boolean {
  if (!dev || typeof dev !== "object" || typeof dev.keys !== "object" || dev.keys === null) return false;
  if (dev.user_id !== user || dev.device_id !== id) return false;
  return verifySignature(dev, user, sskPub, sskPub);
}

export interface OwnerTrustOptions {
  /** POST /_matrix/client/v3/keys/query with the given body. */
  queryKeys: (body: unknown) => Promise<KeysQueryResponse>;
  botUser: string;
  owner: string;
  getPinnedMaster: () => string | undefined;
  /** Called once when the owner's master key is pinned on first successful verification. */
  pinMaster: (key: string) => void;
  /**
   * The bot's own master key as verified by `mxagentctl cross-sign` (state.botMasterKey). Nothing is
   * trusted or pinned unless the published bot master key equals it; missing means not anchored.
   */
  getBotMasterKey?: () => string | undefined;
  /** The daemon's own device id; it never receives room keys from itself, so it is not audited. */
  getOwnDeviceId?: () => string | undefined;
  cacheMs?: number; // default 60 seconds
  now?: () => number;
}

export class OwnerTrust {
  private readonly opts: OwnerTrustOptions;
  private cache?: { at: number; data: KeysQueryResponse };
  private inflight?: Promise<KeysQueryResponse>;

  constructor(opts: OwnerTrustOptions) {
    this.opts = opts;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private async keys(force: boolean): Promise<KeysQueryResponse> {
    const ttl = this.opts.cacheMs ?? 60_000;
    if (!force && this.cache && this.now() - this.cache.at < ttl) return this.cache.data;
    if (!this.inflight) {
      const { owner, botUser } = this.opts;
      this.inflight = this.opts
        .queryKeys({ device_keys: { [owner]: [], [botUser]: [] } })
        .then((data) => {
          this.cache = { at: this.now(), data: data ?? {} };
          return this.cache.data;
        })
        .finally(() => {
          this.inflight = undefined;
        });
    }
    return this.inflight;
  }

  /** Drops cached keys (e.g. after a device list change of the owner or the bot). */
  invalidate(): void {
    this.cache = undefined;
  }

  /**
   * Returns null if the sender device is a verified device of the owner, otherwise a short human-readable
   * reason. Uses cached keys first and re-queries once before rejecting. Query errors propagate.
   */
  async check(device: string | null | undefined, curveKey: string | null | undefined): Promise<string | null> {
    if (!device || !curveKey) return "unknown sender device";
    const first = this.evaluate(await this.keys(false), device, curveKey);
    if (!first) return null;
    return this.evaluate(await this.keys(true), device, curveKey);
  }

  /** The anchored bot master key as published, or null if the published one does not match the anchor. */
  private botMaster(q: KeysQueryResponse): string | null {
    const { botUser } = this.opts;
    // The homeserver could serve a made-up bot identity; only the locally anchored bot master key counts.
    const anchor = this.opts.getBotMasterKey?.();
    const botMasterPub = crossSigningKey(q.master_keys?.[botUser], botUser, "master");
    return anchor && botMasterPub && botMasterPub === anchor ? botMasterPub : null;
  }

  /** The owner's verified master and self-signing key, or a reason. `pin` is set when the master is not pinned yet. */
  private ownerChain(q: KeysQueryResponse, botMasterPub: string): { masterPub: string; sskPub: string; pin: boolean } | string {
    const { owner, botUser } = this.opts;
    const master = q.master_keys?.[owner];
    const masterPub = crossSigningKey(master, owner, "master");
    if (!master || !masterPub) return "owner has no cross-signing identity";

    const pinned = this.opts.getPinnedMaster();
    if (pinned) {
      if (pinned !== masterPub) return "owner master key changed (verify the owner again and reset the pin)";
    } else {
      // First use: only pin a master key the bot itself has verified (signed by the bot's user-signing key).
      const botUsk = q.user_signing_keys?.[botUser];
      const uskPub = crossSigningKey(botUsk, botUser, "user_signing");
      if (!botUsk || !uskPub || !verifyCross(botUsk, botUser, botMasterPub)) return "bot user-signing key invalid";
      if (!verifyCross(master, botUser, uskPub)) return "owner is not verified by the bot";
    }

    const ssk = q.self_signing_keys?.[owner];
    const sskPub = crossSigningKey(ssk, owner, "self_signing");
    if (!ssk || !sskPub || !verifyCross(ssk, owner, masterPub)) return "owner self-signing key invalid";
    return { masterPub, sskPub, pin: !pinned };
  }

  private evaluate(q: KeysQueryResponse, device: string, curveKey: string): string | null {
    const { owner } = this.opts;
    const botMasterPub = this.botMaster(q);
    if (!botMasterPub) return NOT_ANCHORED;
    const chain = this.ownerChain(q, botMasterPub);
    if (typeof chain === "string") return chain;
    const { masterPub, sskPub } = chain;
    const dev = q.device_keys?.[owner]?.[device];
    if (!dev || typeof dev.keys !== "object" || dev.keys === null) return `device ${device} unknown`;
    if (dev.user_id !== owner || dev.device_id !== device) return `device ${device} unknown`;
    if (dev.keys[`curve25519:${device}`] !== curveKey) return "sender key does not match device";
    if (!verifySignature(dev, owner, sskPub, sskPub)) return `device ${device} is not verified by the owner`;

    if (chain.pin) this.opts.pinMaster(masterPub);
    return null;
  }

  /**
   * Checks every device the homeserver lists for owner and bot: owner devices must be signed by the owner's
   * verified self-signing key (pinned master, or on first use the master the bot verified), bot devices (except
   * the daemon's own) by the bot's self-signing key under the anchored master key. Uses cached keys and
   * re-queries once (if the cache is older than 5 s) before reporting a problem. Never pins. Query errors propagate.
   */
  async auditDevices(): Promise<DeviceAudit> {
    const first = this.audit(await this.keys(false));
    if (!first.problem || this.now() - (this.cache?.at ?? 0) < AUDIT_REFRESH_MS) return first;
    return this.audit(await this.keys(true));
  }

  private audit(q: KeysQueryResponse): DeviceAudit {
    const { owner, botUser } = this.opts;
    const allowed = new Map<string, Set<string>>([
      [owner, new Set()],
      [botUser, new Set()],
    ]);
    const allowedKeys = new Map<string, Map<string, string>>([
      [owner, new Map()],
      [botUser, new Map()],
    ]);
    const own = this.opts.getOwnDeviceId?.();
    if (own) allowed.get(botUser)!.add(own);
    const botMasterPub = this.botMaster(q);
    if (!botMasterPub) return { problem: NOT_ANCHORED, allowed, allowedKeys };
    const botSsk = q.self_signing_keys?.[botUser];
    const botSskPub = crossSigningKey(botSsk, botUser, "self_signing");
    if (!botSsk || !botSskPub || !verifyCross(botSsk, botUser, botMasterPub)) return { problem: "bot self-signing key invalid; run mxagentctl cross-sign", allowed, allowedKeys };
    const chain = this.ownerChain(q, botMasterPub);
    if (typeof chain === "string") return { problem: chain, allowed, allowedKeys };

    const unverified: string[] = [];
    const scan = (user: string, sskPub: string) => {
      const devices = q.device_keys?.[user];
      if (!devices || typeof devices !== "object") return;
      for (const [id, dev] of Object.entries(devices)) {
        if (user === botUser && id === own) continue;
        if (deviceSignedBy(dev, user, id, sskPub)) {
          allowed.get(user)!.add(id);
          const curve = (dev as { keys: Record<string, unknown> }).keys[`curve25519:${id}`];
          if (typeof curve === "string" && curve) allowedKeys.get(user)!.set(id, curve);
        }
        else unverified.push(`${user} ${showDevice(id)}`);
      }
    };
    scan(owner, chain.sskPub);
    scan(botUser, botSskPub);
    if (!unverified.length) return { problem: null, allowed, allowedKeys };
    const more = unverified.length > MAX_LISTED_DEVICES ? ` and ${unverified.length - MAX_LISTED_DEVICES} more` : "";
    return {
      problem: `unverified device(s): ${unverified.slice(0, MAX_LISTED_DEVICES).join(", ")}${more}; verify them with cross-signing or remove them`,
      allowed,
      allowedKeys,
    };
  }
}
