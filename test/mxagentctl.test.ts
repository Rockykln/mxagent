// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { PassThrough } from "node:stream";
import { confirmTty, daemonSocketCandidates, NoTerminalError, promptHiddenTty } from "../cli/commands/common.ts";
import type { Ctx, PromptInput } from "../cli/commands/common.ts";
import { ssoLogin } from "../cli/commands/login.ts";
import { crossSignDevice } from "../cli/commands/cross-sign.ts";
import { fingerprint } from "../src/daemon/fingerprint.ts";
import { checkClientUrl } from "../cli/commands/machines.ts";
import {
  decodeRecoveryKey,
  decryptSecret,
  ed25519FromSeed,
  encodeRecoveryKey,
  encryptSecret,
  keyCheck,
  unpaddedBase64,
  verifyKeyInfo,
} from "../cli/commands/recovery.ts";
import { canonicalJson } from "../src/daemon/trust.ts";
import { run } from "../cli/commands/run.ts";
import { paths } from "../src/daemon/config.ts";
import { healthUrl } from "../cli/commands/status.ts";
import { verifySignature } from "../src/daemon/trust.ts";
import type { SignedKeys } from "../src/daemon/trust.ts";

const BOT = "@bot:example.org";
const TOKEN = "syt_secret_token_value";

let root: string;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mxagentctl-test-"));
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

interface TestEnv {
  dir: string;
  env: Record<string, string>;
  stateFile: string;
  configDir: string;
}

function setup(extra: Record<string, string> = {}, state?: unknown): TestEnv {
  const dir = fs.mkdtempSync(path.join(root, "case-"));
  const configDir = path.join(dir, "config");
  fs.mkdirSync(configDir, { mode: 0o700 });
  const configFile = path.join(configDir, "bridge.env");
  const lines = {
    MXA_HOMESERVER: "https://matrix.example.org",
    MXA_BOT_USER: BOT,
    MXA_OWNER: "@owner:example.org",
    MXA_SPACE_ID: "!space:example.org",
    MXA_SOCKET_PATH: path.join(dir, "bridge.sock"),
    ...extra,
  };
  fs.writeFileSync(configFile, Object.entries(lines).map(([k, v]) => `${k}=${v}\n`).join(""), { mode: 0o600 });
  const stateDir = path.join(dir, "state");
  const stateFile = path.join(stateDir, "state.json");
  if (state) {
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
  }
  // XDG_RUNTIME_DIR keeps the running-daemon check away from the real /run/user/<uid> socket
  return { dir, configDir, stateFile, env: { MXA_CONFIG: configFile, MXA_STATE_DIR: stateDir, HOME: dir, XDG_RUNTIME_DIR: dir } };
}

type FetchHandler = (method: string, url: URL, body: any) => { status?: number; json?: unknown; text?: string } | undefined;

function makeCtx(t: TestEnv, handler: FetchHandler = () => undefined, over: Partial<Ctx> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { method: string; path: string; body: any; auth?: string }[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    calls.push({ method, path: url.pathname, body, auth });
    const r = handler(method, url, body);
    if (!r) return new Response(JSON.stringify({ errcode: "M_NOT_FOUND" }), { status: 404 });
    if (r.text !== undefined) return new Response(r.text, { status: r.status ?? 200 });
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const ctx: Ctx = {
    env: t.env,
    cwd: t.dir,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    fetch: fakeFetch,
    promptHidden: async () => {
      throw new Error("no prompt expected");
    },
    confirm: async () => false,
    ...over,
  };
  return { ctx, out, err, calls };
}

const readState = (t: TestEnv) => JSON.parse(fs.readFileSync(t.stateFile, "utf8"));

describe("argument parsing", () => {
  const t = () => setup();
  it("no command prints usage with exit 2", async () => {
    const { ctx, err } = makeCtx(t());
    assert.equal(await run([], ctx), 2);
    assert.match(err.join("\n"), /usage: mxagentctl/);
  });
  it("--help and help <cmd> exit 0", async () => {
    const { ctx, out } = makeCtx(t());
    assert.equal(await run(["--help"], ctx), 0);
    assert.equal(await run(["help", "cross-sign"], ctx), 0);
    assert.match(out.join("\n"), /usage: mxagentctl cross-sign/);
    assert.equal(await run(["help", "nope"], ctx), 2);
  });
  it("every command has --help", async () => {
    for (const c of ["status", "login-password", "login-sso", "cross-sign", "add-machine", "remove-machine", "list-machines", "remove-room", "reset-owner-pin"]) {
      const { ctx, out } = makeCtx(t());
      assert.equal(await run([c, "--help"], ctx), 0, c);
      assert.match(out.join("\n"), new RegExp(`usage: mxagentctl ${c}`));
    }
  });
  it("unknown command, unknown option, wrong arity exit 2", async () => {
    const { ctx } = makeCtx(t());
    assert.equal(await run(["frobnicate"], ctx), 2);
    assert.equal(await run(["status", "--bogus"], ctx), 2);
    assert.equal(await run(["status", "extra"], ctx), 2);
    assert.equal(await run(["remove-room"], ctx), 2);
    assert.equal(await run(["cross-sign", "A", "B"], ctx), 2);
    assert.equal(await run(["add-machine", "laptop"], ctx), 2); // --url missing
    assert.equal(await run(["login-sso", "--homeserver"], ctx), 2); // value missing
  });
  it("config errors exit 1", async () => {
    const t1 = setup();
    const { ctx, err } = makeCtx({ ...t1, env: { ...t1.env, MXA_CONFIG: path.join(t1.dir, "missing.env") } });
    assert.equal(await run(["status"], ctx), 1);
    assert.match(err.join("\n"), /cannot read config file/);
  });
  it("checkClientUrl", () => {
    assert.equal(checkClientUrl("wss://bridge.example.org/agents"), "wss://bridge.example.org/agents");
    assert.equal(checkClientUrl("ws://127.0.0.1:8640"), "ws://127.0.0.1:8640");
    assert.throws(() => checkClientUrl("ws://bridge.example.org"));
    assert.throws(() => checkClientUrl("https://bridge.example.org"));
    assert.throws(() => checkClientUrl("wss://user:pw@bridge.example.org"));
    assert.throws(() => checkClientUrl("not a url"));
  });
});

describe("recovery key", () => {
  const key = crypto.createHash("sha256").update("test key").digest();

  it("round-trips and tolerates whitespace", () => {
    const rk = encodeRecoveryKey(key);
    assert.match(rk, /^E[sS]\w{2} /); // recovery keys start with "Es"
    assert.deepEqual(decodeRecoveryKey(rk), key);
    assert.deepEqual(decodeRecoveryKey(rk.replace(/ /g, "")), key);
    assert.deepEqual(decodeRecoveryKey(`  ${rk.replace(/ /g, "\n")} `), key);
  });

  it("rejects a parity error", () => {
    const compact = encodeRecoveryKey(key).replace(/ /g, "");
    // change one character in the middle; the length usually stays 35 bytes, so parity must catch it
    let caught = 0;
    for (const repl of ["2", "3", "4"]) {
      const bad = compact.slice(0, 20) + (compact[20] === repl ? "5" : repl) + compact.slice(21);
      assert.throws(() => decodeRecoveryKey(bad), /parity|prefix|length/);
      try {
        decodeRecoveryKey(bad);
      } catch (e) {
        if (/parity/.test((e as Error).message)) caught++;
      }
    }
    assert.ok(caught > 0);
  });

  it("rejects a wrong prefix", () => {
    const body = Buffer.concat([Buffer.from([0x8b, 0x02]), key]);
    const parity = body.reduce((a, b) => a ^ b, 0);
    const raw = Buffer.concat([body, Buffer.from([parity])]);
    const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let n = BigInt("0x" + raw.toString("hex"));
    let s = "";
    while (n > 0n) {
      s = B58[Number(n % 58n)] + s;
      n /= 58n;
    }
    assert.throws(() => decodeRecoveryKey(s), /prefix/);
  });

  it("rejects invalid characters and wrong length", () => {
    assert.throws(() => decodeRecoveryKey("EsT0 0000"), /invalid character/);
    assert.throws(() => decodeRecoveryKey("EsTc"), /length/);
    assert.throws(() => encodeRecoveryKey(Buffer.alloc(31)));
  });

  it("verifies key info and decrypts secrets", () => {
    const info = { algorithm: "m.secret_storage.v1.aes-hmac-sha2", ...keyCheck(key) };
    assert.equal(verifyKeyInfo(key, info), true);
    assert.throws(() => verifyKeyInfo(Buffer.alloc(32, 1), info), /does not match/);
    assert.equal(verifyKeyInfo(key, { algorithm: "m.secret_storage.v1.aes-hmac-sha2" }), false);
    assert.throws(() => verifyKeyInfo(key, { algorithm: "other" }), /unsupported/);
    const enc = encryptSecret(key, "m.cross_signing.self_signing", "hello");
    assert.equal(decryptSecret(key, "m.cross_signing.self_signing", enc), "hello");
    assert.throws(() => decryptSecret(key, "other.name", enc), /MAC mismatch/);
  });
});

describe("cross-sign", () => {
  const key = crypto.randomBytes(32);
  const seed = crypto.randomBytes(32);
  const ssk = ed25519FromSeed(seed);
  const masterSeed = crypto.randomBytes(32);
  const master = ed25519FromSeed(masterSeed);
  const usk = ed25519FromSeed(crypto.randomBytes(32));
  const devKp = ed25519FromSeed(crypto.randomBytes(32));
  const signWith = (obj: SignedKeys, keyId: string, k: ReturnType<typeof ed25519FromSeed>): SignedKeys => {
    const { signatures, unsigned: _u, ...rest } = obj;
    const sig = unpaddedBase64(crypto.sign(null, Buffer.from(canonicalJson(rest)), k.privateKey));
    return { ...obj, signatures: { ...signatures, [BOT]: { ...signatures?.[BOT], [`ed25519:${keyId}`]: sig } } };
  };
  const crossKey = (usage: string, pub: string): SignedKeys => ({ user_id: BOT, usage: [usage], keys: { [`ed25519:${pub}`]: pub } });
  const unsignedDevice = {
    user_id: BOT,
    device_id: "DEVICE1",
    algorithms: ["m.olm.v1.curve25519-aes-sha2"],
    keys: { "curve25519:DEVICE1": "curve", "ed25519:DEVICE1": devKp.publicKey },
  };
  // Real device self-signature, as cross-sign verifies it before signing.
  const device: SignedKeys = {
    ...unsignedDevice,
    signatures: { [BOT]: { "ed25519:DEVICE1": unpaddedBase64(crypto.sign(null, Buffer.from(canonicalJson(unsignedDevice)), devKp.privateKey)) } },
    unsigned: { device_display_name: "x" },
  };

  interface HsOpts {
    publishedSsk?: string;
    dev?: SignedKeys;
    /** Seed stored as m.cross_signing.master; null = not in secret storage. */
    storedMaster?: Buffer | null;
    /** Key that signs the published SSK/USK (default: the real master). */
    signer?: ReturnType<typeof ed25519FromSeed>;
  }

  function homeserver(o: HsOpts = {}) {
    const publishedSsk = o.publishedSsk ?? ssk.publicKey;
    const signer = o.signer ?? master;
    const storedMaster = o.storedMaster === undefined ? masterSeed : o.storedMaster;
    let uploaded: any;
    const handler: FetchHandler = (method, url, body) => {
      const p = decodeURIComponent(url.pathname);
      if (p.endsWith("/account_data/m.secret_storage.default_key")) return { json: { key: "KEYID" } };
      if (p.endsWith("/account_data/m.secret_storage.key.KEYID"))
        return { json: { algorithm: "m.secret_storage.v1.aes-hmac-sha2", ...keyCheck(key) } };
      if (p.endsWith("/account_data/m.cross_signing.self_signing"))
        return { json: { encrypted: { KEYID: encryptSecret(key, "m.cross_signing.self_signing", seed.toString("base64")) } } };
      if (p.endsWith("/account_data/m.cross_signing.master"))
        return storedMaster ? { json: { encrypted: { KEYID: encryptSecret(key, "m.cross_signing.master", storedMaster.toString("base64")) } } } : undefined;
      if (p === "/_matrix/client/v3/keys/query" && method === "POST")
        return {
          json: {
            master_keys: { [BOT]: crossKey("master", master.publicKey) },
            self_signing_keys: { [BOT]: signWith(crossKey("self_signing", publishedSsk), signer.publicKey, signer) },
            user_signing_keys: { [BOT]: signWith(crossKey("user_signing", usk.publicKey), signer.publicKey, signer) },
            device_keys: { [BOT]: { DEVICE1: o.dev ?? device } },
          },
        };
      if (p === "/_matrix/client/v3/keys/signatures/upload") {
        uploaded = body;
        return { json: { failures: {} } };
      }
      return undefined;
    };
    return { handler, uploaded: () => uploaded };
  }

  const opts = (f: typeof fetch) => ({
    homeserver: "https://matrix.example.org",
    userId: BOT,
    accessToken: TOKEN,
    recoveryKey: encodeRecoveryKey(key),
    deviceId: "DEVICE1",
    fetch: f,
    deviceReference: devKp.publicKey,
  });
  const loggedIn = { accessToken: TOKEN, deviceId: "DEVICE1", rooms: {} };
  const devFp = ["--device-fingerprint", devKp.publicKey];

  it("signs the device and verifies the master key from secret storage", async () => {
    const t = setup();
    const hs = homeserver();
    const { ctx, calls } = makeCtx(t, hs.handler);
    let asked = false;
    const r = await crossSignDevice({ ...opts(ctx.fetch), confirmMaster: async () => (asked = true) });
    assert.equal(r.result, "signed");
    assert.equal(r.masterPublic, master.publicKey);
    assert.equal(r.masterSource, "secret-storage");
    assert.equal(asked, false);
    const signed = hs.uploaded()[BOT].DEVICE1 as SignedKeys;
    assert.equal(signed.unsigned, undefined);
    assert.ok(verifySignature(signed, BOT, ssk.publicKey, ssk.publicKey));
    assert.ok(calls.every((c) => c.auth === `Bearer ${TOKEN}`));
  });

  it("reports an already signed device", async () => {
    const t = setup();
    const first = homeserver();
    const { ctx } = makeCtx(t, first.handler);
    await crossSignDevice(opts(ctx.fetch));
    const signed = first.uploaded()[BOT].DEVICE1 as SignedKeys;
    const again = homeserver({ dev: signed });
    const r = await crossSignDevice(opts(makeCtx(t, again.handler).ctx.fetch));
    assert.equal(r.result, "already");
    assert.equal(r.masterPublic, master.publicKey);
    assert.equal(again.uploaded(), undefined);
  });

  it("refuses when the published self-signing key differs", async () => {
    const t = setup();
    const hs = homeserver({ publishedSsk: ed25519FromSeed(crypto.randomBytes(32)).publicKey });
    await assert.rejects(crossSignDevice(opts(makeCtx(t, hs.handler).ctx.fetch)), /does not match the published/);
    assert.equal(hs.uploaded(), undefined);
  });

  it("refuses when the decrypted master key differs from the published one", async () => {
    const t = setup();
    const hs = homeserver({ storedMaster: crypto.randomBytes(32) });
    await assert.rejects(crossSignDevice(opts(makeCtx(t, hs.handler).ctx.fetch)), /decrypted master key does not match/);
    assert.equal(hs.uploaded(), undefined);
  });

  it("refuses when self-signing and user-signing keys are not signed by the master key", async () => {
    const t = setup();
    const hs = homeserver({ signer: ed25519FromSeed(crypto.randomBytes(32)) });
    await assert.rejects(crossSignDevice(opts(makeCtx(t, hs.handler).ctx.fetch)), /not signed by the master key/);
    assert.equal(hs.uploaded(), undefined);
  });

  it("without the master key in secret storage, requires a fingerprint confirmation", async () => {
    const t = setup();
    const hs = homeserver({ storedMaster: null });
    const f = makeCtx(t, hs.handler).ctx.fetch;
    await assert.rejects(crossSignDevice(opts(f)), /master key fingerprint not confirmed/);
    let shown = "";
    await assert.rejects(crossSignDevice({ ...opts(f), confirmMaster: async (k) => ((shown = k), false) }), /master key fingerprint not confirmed/);
    assert.equal(shown, master.publicKey);
    assert.equal(hs.uploaded(), undefined);
    const r = await crossSignDevice({ ...opts(f), confirmMaster: async () => true });
    assert.equal(r.masterSource, "confirmed");
    assert.equal(r.masterPublic, master.publicKey);
  });

  it("command stores the bot master key as anchor and reminds to remove the env key", async () => {
    const t = setup({ MXA_RECOVERY_KEY: encodeRecoveryKey(key) }, loggedIn);
    const hs = homeserver();
    const { ctx, out } = makeCtx(t, hs.handler);
    assert.equal(await run(["cross-sign", "--yes", ...devFp], ctx), 0);
    assert.ok(hs.uploaded());
    assert.equal(readState(t).botMasterKey, master.publicKey);
    assert.match(out.join("\n"), /checked with the recovery key, stored as trust anchor/);
    assert.match(out.join("\n"), /remove MXA_RECOVERY_KEY/);
    assert.ok(!out.join("\n").includes(TOKEN));
  });

  it("command asks for the recovery key without echo when the env var is unset", async () => {
    const t = setup({}, loggedIn);
    const hs = homeserver();
    let asked = "";
    const { ctx, out } = makeCtx(t, hs.handler, { promptHidden: async (q) => ((asked = q), ` ${encodeRecoveryKey(key)} \n`) });
    assert.equal(await run(["cross-sign", "--yes", ...devFp], ctx), 0);
    assert.equal(asked, "Recovery key: ");
    assert.equal(readState(t).botMasterKey, master.publicKey);
    assert.ok(!out.join("\n").includes("MXA_RECOVERY_KEY"));
  });

  it("command fails on an empty recovery key", async () => {
    const t = setup({}, loggedIn);
    const { ctx, err } = makeCtx(t, undefined, { promptHidden: async () => "" });
    assert.equal(await run(["cross-sign", "--yes"], ctx), 1);
    assert.match(err.join("\n"), /no recovery key given/);
  });

  it("command shows the master fingerprint and stores nothing when not confirmed", async () => {
    const t = setup({ MXA_RECOVERY_KEY: encodeRecoveryKey(key) }, loggedIn);
    const hs = homeserver({ storedMaster: null });
    const no = makeCtx(t, hs.handler);
    assert.equal(await run(["cross-sign"], no.ctx), 1);
    assert.ok(no.out.join("\n").includes(`bot master key fingerprint: ${master.publicKey.slice(0, 4)} `));
    assert.match(no.out.join("\n"), /suspicious/);
    assert.match(no.err.join("\n"), /pass --master-fingerprint/);
    assert.equal(readState(t).botMasterKey, undefined);
    assert.equal(hs.uploaded(), undefined);

    const asked: string[] = [];
    const yes = makeCtx(t, hs.handler, { confirm: async (q) => (asked.push(q), true) });
    assert.equal(await run(["cross-sign"], yes.ctx), 0);
    assert.equal(asked.length, 2); // master key, then device
    assert.equal(readState(t).botMasterKey, master.publicKey);
    assert.match(yes.out.join("\n"), /confirmed by fingerprint/);
  });

  it("command warns when the stored anchor changes", async () => {
    const t = setup({ MXA_RECOVERY_KEY: encodeRecoveryKey(key) }, { ...loggedIn, botMasterKey: usk.publicKey });
    const { ctx, err } = makeCtx(t, homeserver().handler);
    assert.equal(await run(["cross-sign", "--yes", ...devFp], ctx), 0);
    assert.match(err.join("\n"), /bot master key changed/);
    assert.equal(readState(t).botMasterKey, master.publicKey);
  });

  it("command refuses while the daemon is running", async () => {
    const t = setup({ MXA_RECOVERY_KEY: encodeRecoveryKey(key) }, loggedIn);
    const srv = await listenSocket(path.join(t.dir, "bridge.sock"));
    try {
      const { ctx, err, calls } = makeCtx(t, homeserver().handler);
      assert.equal(await run(["cross-sign", "--yes"], ctx), 1);
      assert.match(err.join("\n"), /daemon is running/);
      assert.equal(calls.length, 0);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it("help no longer suggests the recovery key on the command line", async () => {
    const { ctx, out } = makeCtx(setup());
    assert.equal(await run(["help", "cross-sign"], ctx), 0);
    const text = out.join("\n");
    assert.match(text, /cross-sign \[-y\] \[--master-fingerprint <fp>\] \[--device-fingerprint <fp>\] \[device-id\]/);
    assert.match(text, /Element: Settings, Security & Privacy, Cross-signing/);
    assert.ok(!text.includes("MXA_RECOVERY_KEY='"));
  });

  it("checks a given master fingerprint, normalized, whether or not the master key is in secret storage", async () => {
    const t = setup();
    const missing = homeserver({ storedMaster: null });
    const f = makeCtx(t, missing.handler).ctx.fetch;
    let asked = false;
    const confirmMaster = async () => (asked = true);
    const r = await crossSignDevice({ ...opts(f), confirmMaster, expectedMaster: ` ${fingerprint(master.publicKey)}= ` });
    assert.equal(r.masterSource, "fingerprint");
    assert.equal(asked, false);
    const other = fingerprint(usk.publicKey);
    await assert.rejects(crossSignDevice({ ...opts(f), confirmMaster, expectedMaster: other }), /does not match the given master fingerprint/);
    const stored = makeCtx(t, homeserver().handler).ctx.fetch;
    await assert.rejects(crossSignDevice({ ...opts(stored), expectedMaster: other }), /does not match the given master fingerprint/);
    assert.equal(asked, false);
  });

  it("refuses a device whose key differs from the daemon's record, even if already signed", async () => {
    const t = setup();
    const hs = homeserver();
    const f = makeCtx(t, hs.handler).ctx.fetch;
    const wrong = ed25519FromSeed(crypto.randomBytes(32)).publicKey;
    await assert.rejects(crossSignDevice({ ...opts(f), deviceReference: wrong, confirmDevice: async () => true }), /differs from the one the daemon recorded/);
    await assert.rejects(crossSignDevice({ ...opts(f), expectedDevice: wrong, confirmDevice: async () => true }), /does not match the given device fingerprint/);
    assert.equal(hs.uploaded(), undefined);
    await crossSignDevice(opts(f));
    const again = homeserver({ dev: hs.uploaded()[BOT].DEVICE1 });
    await assert.rejects(crossSignDevice({ ...opts(makeCtx(t, again.handler).ctx.fetch), deviceReference: wrong }), /differs from the one the daemon recorded/);
  });

  it("without a device reference, signs only after an explicit confirmation", async () => {
    const t = setup();
    const hs = homeserver();
    const f = makeCtx(t, hs.handler).ctx.fetch;
    const base = { ...opts(f), deviceReference: undefined };
    await assert.rejects(crossSignDevice(base), /device fingerprint not confirmed/);
    let seen: [string, boolean] | undefined;
    await assert.rejects(crossSignDevice({ ...base, confirmDevice: async (k, ref) => ((seen = [k, ref]), false) }), /device fingerprint not confirmed/);
    assert.deepEqual(seen, [devKp.publicKey, false]);
    assert.equal(hs.uploaded(), undefined);
    const r = await crossSignDevice({ ...base, expectedDevice: fingerprint(devKp.publicKey) });
    assert.equal(r.result, "signed");
  });

  it("rejects secret storage key info without a check value", async () => {
    const t = setup();
    const hs = homeserver();
    const handler: FetchHandler = (m, url, body) =>
      decodeURIComponent(url.pathname).endsWith("/m.secret_storage.key.KEYID") ? { json: { algorithm: "m.secret_storage.v1.aes-hmac-sha2" } } : hs.handler(m, url, body);
    await assert.rejects(crossSignDevice(opts(makeCtx(t, handler).ctx.fetch)), /no check value/);
  });

  it("command: --yes never confirms a master key that is missing from secret storage", async () => {
    const t = setup({ MXA_RECOVERY_KEY: encodeRecoveryKey(key) }, loggedIn);
    const hs = homeserver({ storedMaster: null });
    const asked: string[] = [];
    const { ctx, err } = makeCtx(t, hs.handler, { confirm: async (q) => (asked.push(q), false) });
    assert.equal(await run(["cross-sign", "--yes", ...devFp], ctx), 1);
    assert.equal(asked.length, 1);
    assert.match(err.join("\n"), /pass --master-fingerprint/);
    assert.equal(readState(t).botMasterKey, undefined);
    assert.equal(hs.uploaded(), undefined);

    const ok = makeCtx(t, hs.handler);
    assert.equal(await run(["cross-sign", "--yes", ...devFp, "--master-fingerprint", fingerprint(master.publicKey)], ok.ctx), 0);
    assert.match(ok.out.join("\n"), /matched --master-fingerprint, stored as trust anchor/);
    assert.equal(readState(t).botMasterKey, master.publicKey);
    assert.ok(hs.uploaded());
  });

  it("command: a wrong --master-fingerprint aborts", async () => {
    const t = setup({ MXA_RECOVERY_KEY: encodeRecoveryKey(key) }, loggedIn);
    const hs = homeserver({ storedMaster: null });
    const { ctx, err } = makeCtx(t, hs.handler, { confirm: async () => true });
    assert.equal(await run(["cross-sign", ...devFp, "--master-fingerprint", usk.publicKey], ctx), 1);
    assert.match(err.join("\n"), /does not match the given master fingerprint/);
    assert.equal(readState(t).botMasterKey, undefined);
  });

  it("command: --yes does not cover a device without the daemon's record", async () => {
    const t = setup({ MXA_RECOVERY_KEY: encodeRecoveryKey(key) }, loggedIn);
    const hs = homeserver();
    const asked: string[] = [];
    const { ctx, err } = makeCtx(t, hs.handler, { confirm: async (q) => (asked.push(q), false) });
    assert.equal(await run(["cross-sign", "--yes"], ctx), 1);
    assert.deepEqual(asked, ["Does it match?"]);
    assert.match(err.join("\n"), /pass --device-fingerprint/);
    assert.equal(hs.uploaded(), undefined);
  });

  it("command: uses the device key the daemon recorded in the state file", async () => {
    const t = setup({ MXA_RECOVERY_KEY: encodeRecoveryKey(key) }, { ...loggedIn, deviceEd25519: devKp.publicKey });
    const hs = homeserver();
    const asked: string[] = [];
    const { ctx } = makeCtx(t, hs.handler, { confirm: async (q) => (asked.push(q), false) });
    assert.equal(await run(["cross-sign", "--yes"], ctx), 0);
    assert.deepEqual(asked, []);
    assert.ok(hs.uploaded());

    const t2 = setup({ MXA_RECOVERY_KEY: encodeRecoveryKey(key) }, { ...loggedIn, deviceEd25519: usk.publicKey });
    const hs2 = homeserver();
    const bad = makeCtx(t2, hs2.handler, { confirm: async () => true });
    assert.equal(await run(["cross-sign", "--yes"], bad.ctx), 1);
    assert.match(bad.err.join("\n"), /differs from the one the daemon recorded/);
    assert.equal(hs2.uploaded(), undefined);
    assert.equal(readState(t2).botMasterKey, undefined);
  });
});

describe("machines", () => {
  it("add, list, remove", async () => {
    const t = setup();
    const { ctx, out } = makeCtx(t);
    assert.equal(await run(["add-machine", "laptop", "--url", "wss://bridge.example.org/agents"], ctx), 0);
    const envFile = path.join(t.dir, "client-laptop.env");
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    const content = fs.readFileSync(envFile, "utf8");
    const secret = /^MXA_SECRET=([A-Za-z0-9_-]+)$/m.exec(content)?.[1];
    assert.ok(secret && secret.length >= 43);
    assert.match(content, /^MXA_URL=wss:\/\/bridge\.example\.org\/agents$/m);
    assert.match(content, /^MXA_MACHINE=laptop$/m);
    assert.ok(!out.join("\n").includes(secret), "secret must not be printed");
    assert.match(out.join("\n"), /client\.env.*then delete it here/);

    const machinesFile = path.join(t.configDir, "machines");
    assert.equal(fs.statSync(machinesFile).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(machinesFile, "utf8"), new RegExp(`^laptop ${secret}$`, "m"));

    // env file exists -> refused before a secret is created
    assert.equal(await run(["add-machine", "laptop", "--url", "wss://bridge.example.org"], ctx), 1);
    fs.rmSync(envFile);
    // machine exists -> refused, no env file left behind
    assert.equal(await run(["add-machine", "laptop", "--url", "wss://bridge.example.org"], ctx), 1);
    assert.ok(!fs.existsSync(envFile));
    assert.equal(await run(["add-machine", "Bad Name", "--url", "wss://bridge.example.org"], ctx), 2);
    assert.equal(await run(["add-machine", "pc", "--url", "ws://bridge.example.org"], ctx), 2);
    assert.equal(await run(["add-machine", "pc", "--url", "wss://bridge.example.org"], ctx), 0);

    out.length = 0;
    assert.equal(await run(["list-machines"], ctx), 0);
    assert.deepEqual(out, ["laptop", "pc"]);

    assert.equal(await run(["remove-machine", "laptop"], ctx), 0);
    assert.equal(await run(["remove-machine", "laptop"], ctx), 1);
    out.length = 0;
    await run(["list-machines"], ctx);
    assert.deepEqual(out, ["pc"]);
  });
});

function listenSocket(file: string): Promise<net.Server> {
  return new Promise((resolve) => {
    const s = net.createServer((c) => c.end());
    s.listen(file, () => resolve(s));
  });
}

describe("reset-owner-pin", () => {
  it("clears the pin with --yes", async () => {
    const t = setup({}, { accessToken: TOKEN, deviceId: "D", ownerMasterKey: "MASTERKEYBASE64", rooms: {} });
    const { ctx, err } = makeCtx(t);
    assert.equal(await run(["reset-owner-pin", "--yes"], ctx), 0);
    assert.equal(readState(t).ownerMasterKey, undefined);
    assert.equal(readState(t).accessToken, TOKEN);
    assert.match(err.join("\n"), /re-verified/);
  });
  it("keeps the pin when not confirmed", async () => {
    const t = setup({}, { ownerMasterKey: "MASTERKEYBASE64", rooms: {} });
    const { ctx } = makeCtx(t);
    assert.equal(await run(["reset-owner-pin"], ctx), 1);
    assert.equal(readState(t).ownerMasterKey, "MASTERKEYBASE64");
    const yes = makeCtx(t, undefined, { confirm: async () => true });
    assert.equal(await run(["reset-owner-pin"], yes.ctx), 0);
    assert.equal(readState(t).ownerMasterKey, undefined);
  });
  it("no pin is fine", async () => {
    const t = setup({}, { rooms: {} });
    const { ctx, out } = makeCtx(t);
    assert.equal(await run(["reset-owner-pin", "-y"], ctx), 0);
    assert.match(out.join("\n"), /nothing to do/);
  });
  it("refuses while the daemon is running", async () => {
    const t = setup({}, { ownerMasterKey: "MASTERKEYBASE64", rooms: {} });
    const server = await listenSocket(path.join(t.dir, "bridge.sock"));
    try {
      const { ctx, err } = makeCtx(t);
      assert.equal(await run(["reset-owner-pin", "--yes"], ctx), 1);
      assert.match(err.join("\n"), /daemon is running/);
      assert.equal(readState(t).ownerMasterKey, "MASTERKEYBASE64");
    } finally {
      server.close();
    }
  });
});

describe("remove-room", () => {
  const state = { accessToken: TOKEN, deviceId: "D", rooms: { "my agent": { roomId: "!room:example.org", name: "My Agent" }, other: { roomId: "!o:example.org", name: "other" } } };

  it("unlinks, leaves and forgets the room", async () => {
    const t = setup({}, state);
    const { ctx, calls } = makeCtx(t, () => ({ json: {} }));
    assert.equal(await run(["remove-room", "MY AGENT"], ctx), 0);
    const paths = calls.map((c) => `${c.method} ${decodeURIComponent(c.path)}`);
    assert.deepEqual(paths, [
      "PUT /_matrix/client/v3/rooms/!space:example.org/state/m.space.child/!room:example.org",
      "PUT /_matrix/client/v3/rooms/!room:example.org/state/m.space.parent/!space:example.org",
      "POST /_matrix/client/v3/rooms/!room:example.org/leave",
    ]);
    assert.deepEqual(Object.keys(readState(t).rooms), ["other"]);
  });
  it("unknown agent exits 1", async () => {
    const t = setup({}, state);
    const { ctx, calls } = makeCtx(t, () => ({ json: {} }));
    assert.equal(await run(["remove-room", "nobody"], ctx), 1);
    assert.equal(calls.length, 0);
  });
  it("refuses while the daemon is running", async () => {
    const t = setup({}, state);
    const server = await listenSocket(path.join(t.dir, "bridge.sock"));
    try {
      const { ctx, calls } = makeCtx(t, () => ({ json: {} }));
      assert.equal(await run(["remove-room", "my agent"], ctx), 1);
      assert.equal(calls.length, 0);
      assert.equal(Object.keys(readState(t).rooms).length, 2);
    } finally {
      server.close();
    }
  });
});

describe("status", () => {
  const state = { accessToken: TOKEN, deviceId: "DEVICE1", ownerMasterKey: "ABCDEFGHIJKL", rooms: { a: { roomId: "!a:example.org", name: "Alpha" } } };

  it("prints a summary without secrets and no health check without MXA_WS_LISTEN", async () => {
    const t = setup({ MXA_BOT_PASSWORD: "hunter2-password" }, state);
    const { ctx, out, calls } = makeCtx(t);
    assert.equal(await run(["status"], ctx), 0);
    const text = out.join("\n");
    assert.match(text, /homeserver\s+https:\/\/matrix\.example\.org/);
    assert.match(text, /logged in\s+yes, device DEVICE1/);
    assert.match(text, /agent rooms\s+1 \(Alpha\)/);
    assert.match(text, /daemon\s+not running/);
    assert.match(text, /password set\s+yes/);
    assert.ok(!text.includes(TOKEN) && !text.includes("hunter2"));
    assert.equal(calls.length, 0);
  });

  it("queries /health when MXA_WS_LISTEN is set", async () => {
    const t = setup({ MXA_WS_LISTEN: "0.0.0.0:8640" }, state);
    const ok = makeCtx(t, (_m, url) => (url.pathname === "/health" ? { text: "ok" } : undefined));
    assert.equal(await run(["status"], ok.ctx), 0);
    assert.equal(ok.calls[0].path, "/health");
    assert.match(ok.out.join("\n"), /health\s+200 ok/);

    const stale = makeCtx(t, () => ({ status: 503, text: "stale" }));
    assert.equal(await run(["status"], stale.ctx), 1);
    assert.match(stale.out.join("\n"), /health\s+503 stale/);
  });

  it("healthUrl maps wildcard hosts to loopback", () => {
    assert.equal(healthUrl({ host: "0.0.0.0", port: 1 }), "http://127.0.0.1:1/health");
    assert.equal(healthUrl({ host: "::", port: 2 }), "http://[::1]:2/health");
    assert.equal(healthUrl({ host: "127.0.0.1", port: 3 }), "http://127.0.0.1:3/health");
  });
});

describe("login", () => {
  it("login-password stores the session from MXA_BOT_PASSWORD", async () => {
    const t = setup({ MXA_BOT_PASSWORD: "pw with spaces" });
    const { ctx, out, calls } = makeCtx(t, (m, url) =>
      m === "POST" && url.pathname === "/_matrix/client/v3/login" ? { json: { user_id: BOT, device_id: "NEWDEV", access_token: TOKEN } } : undefined,
    );
    assert.equal(await run(["login-password"], ctx), 0);
    assert.equal(calls[0].body.password, "pw with spaces");
    assert.equal(calls[0].body.identifier.user, BOT);
    const s = readState(t);
    assert.equal(s.accessToken, TOKEN);
    assert.equal(s.deviceId, "NEWDEV");
    assert.equal(fs.statSync(t.stateFile).mode & 0o777, 0o600);
    assert.ok(!out.join("\n").includes(TOKEN));
    // existing session needs --force
    assert.equal(await run(["login-password"], ctx), 1);
  });

  it("login-password prompts when no password is configured", async () => {
    const t = setup();
    let asked = "";
    const { ctx, calls } = makeCtx(
      t,
      () => ({ json: { user_id: BOT, device_id: "D2", access_token: TOKEN } }),
      { promptHidden: async (q) => ((asked = q), "typed") },
    );
    assert.equal(await run(["login-password"], ctx), 0);
    assert.match(asked, /Password for @bot:example\.org/);
    assert.equal(calls[0].body.password, "typed");
  });

  it("login-sso exchanges the login token from the local callback", async () => {
    const t = setup();
    let callback: Promise<Response> | undefined;
    const { ctx, calls } = makeCtx(t, (m, url, body) => {
      if (url.pathname !== "/_matrix/client/v3/login") return undefined;
      if (m === "GET") return { json: { flows: [{ type: "m.login.sso" }, { type: "m.login.token" }] } };
      assert.equal(body.type, "m.login.token");
      assert.equal(body.token, "LOGINTOKEN");
      return { json: { user_id: BOT, device_id: "SSODEV", access_token: TOKEN } };
    }, {
      out: (line) => {
        const m = /redirectUrl=([^&\s]+)/.exec(line);
        if (m) {
          const cb = new URL(decodeURIComponent(m[1]));
          assert.equal(cb.hostname, "127.0.0.1");
          cb.searchParams.set("loginToken", "LOGINTOKEN");
          callback = fetch(cb);
        }
      },
    });
    assert.equal(await run(["login-sso"], ctx), 0);
    assert.equal((await callback!).status, 200);
    const file = paths(t.env).ssoSessionFile;
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { userId: BOT, deviceId: "SSODEV", accessToken: TOKEN });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(calls.length, 2);
    // second run refuses without --force
    assert.equal(await run(["login-sso"], ctx), 1);
  });

  it("login-sso refuses homeservers without SSO", async () => {
    const t = setup();
    const { ctx, err } = makeCtx(t, () => ({ json: { flows: [{ type: "m.login.password" }] } }));
    assert.equal(await run(["login-sso", "--homeserver", "https://other.example.org/"], ctx), 1);
    assert.match(err.join("\n"), /does not offer SSO/);
  });
});

describe("daemon running check", () => {
  it("checks MXA_SOCKET_PATH and the default socket locations", () => {
    const env = { MXA_STATE_DIR: "/s", MXA_SOCKET_PATH: "/env.sock", XDG_RUNTIME_DIR: "/run/user/7" };
    assert.deepEqual(daemonSocketCandidates(env, "/cfg.sock"), ["/cfg.sock", "/env.sock", "/run/user/7/mxagent.sock", "/s/bridge.sock", "/run/mxagent/bridge.sock"]);
    assert.deepEqual(daemonSocketCandidates({ MXA_STATE_DIR: "/s", XDG_RUNTIME_DIR: "/r" }, "/r/mxagent.sock"), ["/r/mxagent.sock", "/s/bridge.sock", "/run/mxagent/bridge.sock"]);
  });

  it("finds a daemon on a default socket the config does not name", async () => {
    const t = setup({}, { ownerMasterKey: "MASTERKEYBASE64", rooms: {} });
    const server = await listenSocket(path.join(t.dir, "mxagent.sock")); // $XDG_RUNTIME_DIR/mxagent.sock
    try {
      const { ctx, err } = makeCtx(t);
      assert.equal(await run(["reset-owner-pin", "--yes"], ctx), 1);
      assert.match(err.join("\n"), /daemon is running \(.*mxagent\.sock answers\).*stop it first/);
      assert.equal(readState(t).ownerMasterKey, "MASTERKEYBASE64");
      const st = makeCtx(t);
      await run(["status"], st.ctx);
      assert.match(st.out.join("\n"), /daemon\s+running \(socket .*mxagent\.sock\)/);
    } finally {
      server.close();
    }
  });

  it("help texts explain the socket check", async () => {
    for (const c of ["remove-room", "reset-owner-pin", "login-password", "login-sso"]) {
      const { ctx, out } = makeCtx(setup());
      await run([c, "--help"], ctx);
      assert.match(out.join("\n"), /set MXA_SOCKET_PATH/, c);
    }
  });

  it("remove-room: an invalid agent name is a usage error", async () => {
    const t = setup({}, { accessToken: TOKEN, rooms: {} });
    const { ctx, calls } = makeCtx(t, () => ({ json: {} }));
    assert.equal(await run(["remove-room", "bad name!"], ctx), 2);
    assert.equal(await run(["remove-room", "all"], ctx), 2);
    assert.equal(calls.length, 0);
  });
});

describe("login-password safety", () => {
  const loginOk = (newToken: string, logoutStatus = 200): FetchHandler => (m, url) => {
    if (m === "POST" && url.pathname === "/_matrix/client/v3/login") return { json: { user_id: BOT, device_id: "NEWDEV", access_token: newToken } };
    if (m === "POST" && url.pathname === "/_matrix/client/v3/logout") return { status: logoutStatus, json: logoutStatus === 200 ? {} : { errcode: "M_UNKNOWN_TOKEN" } };
    return undefined;
  };

  it("refuses while the daemon is running", async () => {
    const t = setup({ MXA_BOT_PASSWORD: "pw" }, { accessToken: "OLD", deviceId: "OLDDEV", rooms: {} });
    const server = await listenSocket(path.join(t.dir, "bridge.sock"));
    try {
      const { ctx, err, calls } = makeCtx(t, loginOk(TOKEN));
      assert.equal(await run(["login-password", "--force"], ctx), 1);
      assert.match(err.join("\n"), /daemon is running/);
      assert.equal(calls.length, 0);
      assert.equal(readState(t).accessToken, "OLD");
    } finally {
      server.close();
    }
  });

  it("--force logs out the old session", async () => {
    const t = setup({ MXA_BOT_PASSWORD: "pw" }, { accessToken: "OLD", deviceId: "OLDDEV", rooms: {} });
    const { ctx, out, calls } = makeCtx(t, loginOk(TOKEN));
    assert.equal(await run(["login-password", "--force"], ctx), 0);
    const logout = calls.find((c) => c.path === "/_matrix/client/v3/logout");
    assert.equal(logout?.auth, "Bearer OLD");
    assert.equal(readState(t).accessToken, TOKEN);
    assert.match(out.join("\n"), /logged out the previous device OLDDEV/);
    assert.ok(!out.join("\n").includes("OLD\n") && !out.join("\n").includes(TOKEN));
  });

  it("--force warns when the old session cannot be logged out", async () => {
    const t = setup({ MXA_BOT_PASSWORD: "pw" }, { accessToken: "OLD", deviceId: "OLDDEV", rooms: {} });
    const { ctx, err } = makeCtx(t, loginOk(TOKEN, 401));
    assert.equal(await run(["login-password", "--force"], ctx), 0);
    assert.match(err.join("\n"), /could not log out the previous device OLDDEV.*remove its device/);
    assert.equal(readState(t).accessToken, TOKEN);
  });

  it("without a terminal it points to MXA_BOT_PASSWORD", async () => {
    const t = setup();
    const { ctx, err } = makeCtx(t, loginOk(TOKEN), {
      promptHidden: async () => {
        throw new NoTerminalError();
      },
    });
    assert.equal(await run(["login-password"], ctx), 1);
    assert.match(err.join("\n"), /no terminal.*set MXA_BOT_PASSWORD or run in a terminal/);
  });

  it("warns about plain http to a remote homeserver", async () => {
    const t = setup({ MXA_BOT_PASSWORD: "pw", MXA_HOMESERVER: "http://matrix.example.org" });
    const { ctx, err } = makeCtx(t, loginOk(TOKEN));
    assert.equal(await run(["login-password"], ctx), 0);
    assert.match(err.join("\n"), /plain http/);
  });
});

describe("login-sso replacement and options", () => {
  /** Handler for an SSO homeserver; drives the callback from the printed URL. */
  function ssoCtx(t: TestEnv, extra: FetchHandler = () => undefined) {
    let callback: Promise<Response> | undefined;
    const printed: string[] = [];
    const r = makeCtx(t, (m, url, body) => {
      if (url.pathname === "/_matrix/client/v3/login" && m === "GET") return { json: { flows: [{ type: "m.login.sso" }, { type: "m.login.token" }] } };
      if (url.pathname === "/_matrix/client/v3/login" && m === "POST" && body.type === "m.login.token") return { json: { user_id: BOT, device_id: "SSODEV", access_token: TOKEN } };
      return extra(m, url, body);
    }, {
      out: (line) => {
        printed.push(line);
        const m = /redirectUrl=([^&\s]+)/.exec(line);
        if (m) {
          const cb = new URL(decodeURIComponent(m[1]));
          cb.searchParams.set("loginToken", "LOGINTOKEN");
          callback = fetch(cb);
        }
      },
    });
    return { ...r, printed, callback: () => callback };
  }

  it("refuses to write an ignored session file when the state has a session", async () => {
    const t = setup({}, { accessToken: "OLD", deviceId: "OLDDEV", rooms: {} });
    const { ctx, err, calls } = ssoCtx(t);
    assert.equal(await run(["login-sso"], ctx), 1);
    assert.match(err.join("\n"), /already logged in \(device OLDDEV\).*--force/);
    assert.equal(calls.length, 0);
  });

  it("--force clears the old session from the state and logs it out", async () => {
    const t = setup({}, { accessToken: "OLD", deviceId: "OLDDEV", ownerMasterKey: "PIN", rooms: { a: { roomId: "!a:example.org", name: "a" } } });
    const s = ssoCtx(t, (m, url) => (m === "POST" && url.pathname === "/_matrix/client/v3/logout" ? { json: {} } : undefined));
    assert.equal(await run(["login-sso", "--force"], s.ctx), 0);
    assert.equal((await s.callback()!).status, 200);
    const st = readState(t);
    assert.equal(st.accessToken, undefined);
    assert.equal(st.deviceId, undefined);
    assert.equal(st.ownerMasterKey, "PIN");
    assert.deepEqual(Object.keys(st.rooms), ["a"]);
    assert.equal(JSON.parse(fs.readFileSync(paths(t.env).ssoSessionFile, "utf8")).deviceId, "SSODEV");
    assert.equal(s.calls.find((c) => c.path === "/_matrix/client/v3/logout")?.auth, "Bearer OLD");
    assert.ok(!s.printed.join("\n").includes(TOKEN));
  });

  it("refuses while the daemon is running", async () => {
    const t = setup({}, { accessToken: "OLD", deviceId: "OLDDEV", rooms: {} });
    const server = await listenSocket(path.join(t.dir, "bridge.sock"));
    try {
      const { ctx, err, calls } = ssoCtx(t);
      assert.equal(await run(["login-sso", "--force"], ctx), 1);
      assert.match(err.join("\n"), /daemon is running/);
      assert.equal(calls.length, 0);
      assert.equal(readState(t).accessToken, "OLD");
    } finally {
      server.close();
    }
  });

  it("warns about plain http and a homeserver that differs from MXA_HOMESERVER", async () => {
    const t = setup();
    const { ctx, err } = makeCtx(t, () => ({ json: { flows: [] } }));
    assert.equal(await run(["login-sso", "--homeserver", "http://other.example.org"], ctx), 1);
    const text = err.join("\n");
    assert.match(text, /differs from MXA_HOMESERVER/);
    assert.match(text, /plain http/);
    const same = makeCtx(t, () => ({ json: { flows: [] } }));
    await run(["login-sso", "--homeserver", "https://matrix.example.org/"], same.ctx);
    assert.doesNotMatch(same.err.join("\n"), /differs|plain http/);
  });

  it("--port uses a fixed callback port and prints the ssh forward", async () => {
    const free = await new Promise<number>((resolve) => {
      const srv = net.createServer().listen(0, "127.0.0.1", () => {
        const { port } = srv.address() as net.AddressInfo;
        srv.close(() => resolve(port));
      });
    });
    const t = setup();
    const s = ssoCtx(t);
    assert.equal(await run(["login-sso", "--port", String(free)], s.ctx), 0);
    const text = s.printed.join("\n");
    assert.match(text, new RegExp(`ssh -L ${free}:127\\.0\\.0\\.1:${free}`));
    assert.match(text, new RegExp(`127\\.0\\.0\\.1%3A${free}%2Fcallback`));
    for (const bad of ["0", "70000", "abc", "1.5"]) assert.equal(await run(["login-sso", "--port", bad], makeCtx(t).ctx), 2, bad);
  });

  it("the callback is one-shot even while the token exchange is pending", async () => {
    const t = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let exchanges = 0;
    let started!: () => void;
    const exchangeStarted = new Promise<void>((r) => (started = r));
    const fakeFetch = (async () => {
      exchanges++;
      started();
      await gate;
      return new Response(JSON.stringify({ user_id: BOT, device_id: "D", access_token: TOKEN }), { status: 200 });
    }) as unknown as typeof fetch;
    let cbUrl!: URL;
    const done = ssoLogin({
      homeserver: "https://matrix.example.org",
      file: path.join(t.dir, "s.json"),
      fetch: fakeFetch,
      out: () => undefined,
      onUrl: (u) => {
        cbUrl = new URL(decodeURIComponent(/redirectUrl=([^&]+)/.exec(u)![1]));
        cbUrl.searchParams.set("loginToken", "T");
      },
    });
    while (!cbUrl) await new Promise((r) => setTimeout(r, 5));
    const first = fetch(cbUrl);
    await exchangeStarted;
    const second = await fetch(cbUrl);
    assert.equal(second.status, 404);
    release();
    assert.equal((await first).status, 200);
    assert.equal((await done).deviceId, "D");
    assert.equal(exchanges, 1);
  });
});

describe("terminal prompts", () => {
  function fakeTty(): PromptInput & PassThrough {
    const s = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (b: boolean) => unknown };
    s.isTTY = true;
    s.setRawMode = () => s;
    return s as unknown as PromptInput & PassThrough;
  }
  const sink = { write: () => true };

  it("hidden prompt reads a line and rejects on Ctrl-D and end of input", async () => {
    const a = fakeTty();
    const p1 = promptHiddenTty("pw: ", a, sink);
    a.write("se\u007fecret\r");
    assert.equal(await p1, "secret");
    const b = fakeTty();
    const p2 = promptHiddenTty("pw: ", b, sink);
    b.write("\u0004");
    await assert.rejects(p2, /end of input/);
    const c = fakeTty();
    const p3 = promptHiddenTty("pw: ", c, sink);
    c.end();
    await assert.rejects(p3, /end of input/);
    const notTty = new PassThrough() as unknown as PromptInput;
    await assert.rejects(promptHiddenTty("pw: ", notTty, sink), NoTerminalError);
  });

  it("confirm answers and rejects on end of input", async () => {
    const a = fakeTty();
    const p1 = confirmTty("ok?", a, sink);
    a.write("y\n");
    assert.equal(await p1, true);
    const b = fakeTty();
    const p2 = confirmTty("ok?", b, sink);
    b.end();
    await assert.rejects(p2, /end of input/);
    assert.equal(await confirmTty("ok?", new PassThrough() as unknown as PromptInput, sink), false);
  });

  it("end of input at a confirmation exits 1 with a message", async () => {
    const t = setup({}, { ownerMasterKey: "PIN", rooms: {} });
    const { ctx, err } = makeCtx(t, undefined, { confirm: () => Promise.reject(new Error("aborted (end of input)")) });
    assert.equal(await run(["reset-owner-pin"], ctx), 1);
    assert.match(err.join("\n"), /aborted \(end of input\)/);
    assert.equal(readState(t).ownerMasterKey, "PIN");
  });
});
