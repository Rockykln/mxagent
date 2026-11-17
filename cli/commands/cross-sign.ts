// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import { fingerprint } from "../../src/daemon/fingerprint.ts";
import crypto from "node:crypto";
import { loadConfig, paths } from "../../src/daemon/config.ts";
import { StateStore } from "../../src/daemon/state.ts";
import { canonicalJson, verifySignature } from "../../src/daemon/trust.ts";
import type { KeysQueryResponse, SignedKeys } from "../../src/daemon/trust.ts";
import { MatrixApiError, matrixApi, socketAnswers, stringOpt, UsageError } from "./common.ts";
import type { Command } from "./common.ts";
import { decodeRecoveryKey, decryptSecret, ed25519FromSeed, unpaddedBase64, verifyKeyInfo } from "./recovery.ts";

export interface CrossSignOptions {
  homeserver: string;
  userId: string;
  accessToken: string;
  recoveryKey: string;
  deviceId: string;
  fetch: typeof fetch;
  /** Master key fingerprint given by the operator (any spacing); must match the published master key. */
  expectedMaster?: string;
  /** Device ed25519 fingerprint given by the operator (any spacing); must match the device's published key. */
  expectedDevice?: string;
  /**
   * Local reference for the device's ed25519 key (written by the daemon at startup). A device whose
   * published key differs is refused.
   */
  deviceReference?: string;
  /**
   * Called before signing with the device's ed25519 key; return false to abort. `referenced` is true
   * when the key matched `deviceReference` or `expectedDevice`. Without this callback, only a referenced
   * device is signed.
   */
  confirmDevice?: (ed25519: string, referenced: boolean) => Promise<boolean>;
  /**
   * Called with the published master key when its private key is not in secret storage and no
   * `expectedMaster` is given; return false to abort. Without this callback such a master key is rejected.
   */
  confirmMaster?: (ed25519: string) => Promise<boolean>;
}

export interface CrossSignResult {
  result: "signed" | "already";
  sskPublic: string;
  /** Verified public master key of the account (unpadded base64). */
  masterPublic: string;
  /**
   * How the master key was verified: decrypted from secret storage, matched against the fingerprint the
   * operator passed, or confirmed interactively.
   */
  masterSource: "secret-storage" | "fingerprint" | "confirmed";
}

/** Canonical form of a key fingerprint as typed by a person: no whitespace, no base64 padding. */
export function normalizeFingerprint(fp: string): string {
  return fp.replace(/\s+/g, "").replace(/=+$/, "");
}

const sameKey = (fp: string, key: string) => {
  const a = Buffer.from(normalizeFingerprint(fp));
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/** The single ed25519 key of a published cross-signing key with matching user_id and usage. */
function publishedKey(k: SignedKeys | undefined, user: string, usage: string): string | undefined {
  if (!k || k.user_id !== user || !Array.isArray(k.usage) || !k.usage.includes(usage)) return undefined;
  const entries = Object.entries(k.keys ?? {}).filter(([id]) => id.startsWith("ed25519:"));
  if (entries.length !== 1 || typeof entries[0][1] !== "string" || entries[0][0] !== `ed25519:${entries[0][1]}`) return undefined;
  return entries[0][1];
}

/**
 * Verifies the account's cross-signing identity and signs `deviceId` with the self-signing key from
 * secret storage. The master key is anchored by its private key in secret storage, or else by the
 * operator confirming its fingerprint; the published self-signing and user-signing keys must be
 * signed by it.
 */
export async function crossSignDevice(o: CrossSignOptions): Promise<CrossSignResult> {
  const key = decodeRecoveryKey(o.recoveryKey);
  const api = <T = any>(method: string, p: string, body?: unknown) => matrixApi<T>(o.fetch, o.homeserver, o.accessToken, method, p, body);
  const user = encodeURIComponent(o.userId);
  const accountData = `/_matrix/client/v3/user/${user}/account_data`;

  const def = await api<{ key?: unknown }>("GET", `${accountData}/m.secret_storage.default_key`);
  if (typeof def.key !== "string" || !def.key) throw new Error("account has no default secret storage key");
  const keyId = def.key;
  const keyInfo = await api("GET", `${accountData}/m.secret_storage.key.${encodeURIComponent(keyId)}`);
  if (!verifyKeyInfo(key, keyInfo)) throw new Error("secret storage key has no check value (iv/mac); cannot verify the recovery key");

  const sskData = await api<{ encrypted?: Record<string, any> }>("GET", `${accountData}/m.cross_signing.self_signing`);
  const enc = sskData.encrypted?.[keyId];
  if (!enc) throw new Error("self-signing key is not stored with the default secret storage key");
  const seed = Buffer.from(decryptSecret(key, "m.cross_signing.self_signing", enc), "base64");
  const { privateKey, publicKey } = ed25519FromSeed(seed);

  let masterSeed: Buffer | undefined;
  try {
    const m = await api<{ encrypted?: Record<string, any> }>("GET", `${accountData}/m.cross_signing.master`);
    const menc = m.encrypted?.[keyId];
    if (menc) masterSeed = Buffer.from(decryptSecret(key, "m.cross_signing.master", menc), "base64");
  } catch (e) {
    if (!(e instanceof MatrixApiError) || e.status !== 404) throw e;
  }

  const q = await api<KeysQueryResponse>("POST", "/_matrix/client/v3/keys/query", { device_keys: { [o.userId]: [] } });
  const sskPublished = q.self_signing_keys?.[o.userId];
  if (publishedKey(sskPublished, o.userId, "self_signing") !== publicKey) throw new Error("decrypted self-signing key does not match the published one");

  const masterObj = q.master_keys?.[o.userId];
  const masterPublic = publishedKey(masterObj, o.userId, "master");
  if (!masterPublic) throw new Error("account has no valid published master key");
  if (o.expectedMaster !== undefined && !sameKey(o.expectedMaster, masterPublic))
    throw new Error("the published master key does not match the given master fingerprint");
  let masterSource: CrossSignResult["masterSource"];
  if (masterSeed) {
    if (ed25519FromSeed(masterSeed).publicKey !== masterPublic) throw new Error("decrypted master key does not match the published one");
    masterSource = "secret-storage";
  } else if (o.expectedMaster !== undefined) {
    masterSource = "fingerprint";
  } else {
    if (!o.confirmMaster || !(await o.confirmMaster(masterPublic))) throw new Error("aborted: master key fingerprint not confirmed");
    masterSource = "confirmed";
  }
  if (!sskPublished || !verifySignature(sskPublished, o.userId, masterPublic, masterPublic))
    throw new Error("published self-signing key is not signed by the master key");
  const usk = q.user_signing_keys?.[o.userId];
  const uskPublic = publishedKey(usk, o.userId, "user_signing");
  if (!usk || !uskPublic || !verifySignature(usk, o.userId, masterPublic, masterPublic))
    throw new Error("published user-signing key is missing or not signed by the master key");

  const done = (result: CrossSignResult["result"]): CrossSignResult => ({ result, sskPublic: publicKey, masterPublic, masterSource });
  const device = q.device_keys?.[o.userId]?.[o.deviceId];
  if (!device) throw new Error(`device ${o.deviceId} not found for ${o.userId}`);
  if (device.user_id !== o.userId) throw new Error("device keys belong to another user");
  if (device.device_id !== o.deviceId) throw new Error("device keys are for another device");
  const devKey = device.keys?.[`ed25519:${o.deviceId}`];
  if (typeof devKey !== "string") throw new Error("device has no ed25519 key");
  if (o.expectedDevice !== undefined && !sameKey(o.expectedDevice, devKey))
    throw new Error("the device's published ed25519 key does not match the given device fingerprint");
  if (o.deviceReference !== undefined && !sameKey(o.deviceReference, devKey))
    throw new Error("the device's published ed25519 key differs from the one the daemon recorded at startup");
  if (verifySignature(device, o.userId, publicKey, publicKey)) return done("already");
  if (!verifySignature(device, o.userId, o.deviceId, devKey)) throw new Error("device keys are not self-signed by the device");
  const referenced = o.expectedDevice !== undefined || o.deviceReference !== undefined;
  const confirmed = o.confirmDevice ? await o.confirmDevice(devKey, referenced) : referenced;
  if (!confirmed) throw new Error("aborted: device fingerprint not confirmed");

  const { signatures: _s, unsigned: _u, ...toSign } = device;
  const sig = unpaddedBase64(crypto.sign(null, Buffer.from(canonicalJson(toSign)), privateKey));
  const signed: SignedKeys = { ...toSign, keys: device.keys, signatures: { [o.userId]: { [`ed25519:${publicKey}`]: sig } } };
  const res = await api<{ failures?: Record<string, unknown> }>("POST", "/_matrix/client/v3/keys/signatures/upload", {
    [o.userId]: { [o.deviceId]: signed },
  });
  if (res.failures && Object.keys(res.failures).length) throw new Error("signature upload failed: " + JSON.stringify(res.failures).slice(0, 300));
  return done("signed");
}

/** The daemon's recorded ed25519 key of its own device, if the state file has one. */
function recordedDeviceKey(state: StateStore, deviceId: string): string | undefined {
  const v = (state.data as { deviceEd25519?: unknown }).deviceEd25519;
  return deviceId === state.data.deviceId && typeof v === "string" && v ? v : undefined;
}

export const crossSign: Command = {
  name: "cross-sign",
  summary: "verify the bot's identity, store it as trust anchor and sign a bot device (asks for the recovery key)",
  positionals: [0, 1],
  options: {
    yes: { type: "boolean", short: "y" },
    "master-fingerprint": { type: "string" },
    "device-fingerprint": { type: "string" },
  },
  usage: `usage: mxagentctl cross-sign [-y] [--master-fingerprint <fp>] [--device-fingerprint <fp>] [device-id]

Verifies the bot account's cross-signing identity, stores its master key in the state file as the
trust anchor for owner verification, and signs a device of the bot with the self-signing key, so
the owner's clients trust it. The keys are read from server-side secret storage and decrypted with
the bot's recovery key. Default device: the daemon's own device from the state file.

The recovery key is asked for without echo. For automation only, it can be passed in the
environment variable MXA_RECOVERY_KEY; never type it on the command line or keep it in the config file.

Master key: normally its private part is in secret storage and is checked with the recovery key.
If it is missing there, the homeserver may be hiding it, and the published master key cannot be
checked. Then its fingerprint must be confirmed in a terminal or passed with --master-fingerprint.
Read the fingerprint in a client that is logged in as the bot and holds its cross-signing keys
(for example Element: Settings, Security & Privacy, Cross-signing), never from the homeserver alone.

Device: the daemon records its device's ed25519 key in the state file at startup. A device whose
published key differs is refused. Without that record (another device, or an older state file) the
fingerprint must be confirmed in a terminal or passed with --device-fingerprint; compare it with the
fingerprint the daemon logged at startup or with the session key shown in the device's own client.
The daemon must be stopped, because it owns the state file while running.

  -y, --yes                     skip the device confirmation when the key matches the daemon's record;
                                never skips a master key or device check without a local reference
  --master-fingerprint <fp>     expected bot master key (spaces allowed); required without a terminal
                                when the master key is not in secret storage
  --device-fingerprint <fp>     expected ed25519 key of the device (spaces allowed); required without
                                a terminal when the daemon has no record for the device`,
  async run(ctx, args) {
    const cfg = loadConfig(ctx.env);
    if (await socketAnswers(cfg.socketPath)) throw new Error(`the daemon is running (${cfg.socketPath} answers); stop it first`);
    const p = paths(ctx.env);
    const state = StateStore.load(p.stateFile);
    if (!state.data.accessToken) throw new Error("not logged in; run mxagentctl login-password or login-sso and start the daemon once");
    const deviceId = args.positionals[0] ?? state.data.deviceId;
    if (!deviceId) throw new Error("no device id in state; pass one");
    const expectedMaster = stringOpt(args, "master-fingerprint");
    const expectedDevice = stringOpt(args, "device-fingerprint");
    if (expectedMaster !== undefined && !normalizeFingerprint(expectedMaster)) throw new UsageError("cross-sign: --master-fingerprint is empty");
    if (expectedDevice !== undefined && !normalizeFingerprint(expectedDevice)) throw new UsageError("cross-sign: --device-fingerprint is empty");
    const fromEnv = Boolean(cfg.recoveryKey);
    const recoveryKey = cfg.recoveryKey ?? (await ctx.promptHidden("Recovery key: ")).trim();
    if (!recoveryKey) throw new Error("no recovery key given");
    const yes = args.values.yes === true;
    const r = await crossSignDevice({
      homeserver: cfg.homeserver,
      userId: cfg.botUser,
      accessToken: state.data.accessToken,
      recoveryKey,
      deviceId,
      fetch: ctx.fetch,
      expectedMaster,
      expectedDevice,
      deviceReference: recordedDeviceKey(state, deviceId),
      confirmMaster: async (key) => {
        ctx.out("The bot's master key is not in secret storage, so it cannot be checked with the recovery key.");
        ctx.out("This is suspicious if it was stored there before: the homeserver can hide it.");
        ctx.out(`bot master key fingerprint: ${fingerprint(key)}`);
        ctx.out("Compare it with the master key shown in a client logged in as the bot (see --help).");
        const ok = await ctx.confirm("Does it match?");
        if (!ok) ctx.err("(without a terminal, pass --master-fingerprint <fp>; --yes does not cover the master key)");
        return ok;
      },
      confirmDevice: async (key, referenced) => {
        if (referenced && yes) return true;
        ctx.out(`device ${deviceId} ed25519 fingerprint: ${fingerprint(key)}`);
        if (referenced) ctx.out("It matches the key the daemon recorded at startup.");
        else ctx.out("The daemon has no record of this device's key. Compare it with the fingerprint the daemon logged at startup.");
        const ok = await ctx.confirm(referenced ? "Sign this device?" : "Does it match?");
        if (!ok) ctx.err(referenced ? "(use --yes when not running in a terminal)" : "(without a terminal, pass --device-fingerprint <fp>)");
        return ok;
      },
    });
    const previous = state.data.botMasterKey;
    if (previous !== r.masterPublic) {
      if (previous) ctx.err(`warning: the bot master key changed (was ${fingerprint(previous)})`);
      state.data.botMasterKey = r.masterPublic;
      state.save();
    }
    const how = { "secret-storage": "checked with the recovery key", fingerprint: "matched --master-fingerprint", confirmed: "confirmed by fingerprint" }[r.masterSource];
    ctx.out(`bot master key ${r.masterPublic.slice(0, 8)}... ${how}, stored as trust anchor`);
    if (r.result === "already") ctx.out(`device ${deviceId} is already cross-signed`);
    else ctx.out(`device ${deviceId} cross-signed with self-signing key ${r.sskPublic.slice(0, 8)}...`);
    if (fromEnv) ctx.out(`Now remove MXA_RECOVERY_KEY from ${p.configFile} and from your environment.`);
  },
};
