// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as ts from "../src/protocol/secure.ts";

type SecureModule = typeof ts;
const jsPath = new URL("../clients/js/secure.mjs", import.meta.url).href;
const js = (await import(jsPath)) as SecureModule;

const VECTOR = {
  secret: "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8",
  machine: "laptop",
  nc: "AAECAwQFBgcICQoLDA0ODw==",
  ns: "EBESExQVFhcYGRobHB0eHw==",
  root: "5348dedae3270728831465d9df320287745e48e3f0779fa5d70ccabdf6b6a201",
  proofClient: "PmLX7WYTETMHz+52Y/GlKbCJCPWClmqrxVuo9J5jjBo=",
  proofServer: "JtUTRpVfuJt7WMLTHPNWzwlsF7xLD34cp+mETaSosMM=",
  clientFrame1: {
    text: '{"type":"hello","id":1,"name":"demo"}\n',
    frame: "AAAAAAAAAAFWFARG38MQnXCirpK5HmZ/c4xbXaYwkVEBVhA2SevLaG4i6ABxyRQn97I8Yjf5lEdisN+R8xM=",
  },
  serverFrame1: {
    text: '{"type":"authed","machine":"laptop","mac":"JtUTRpVfuJt7WMLTHPNWzwlsF7xLD34cp+mETaSosMM="}\n',
    frame:
      "AAAAAAAAAAGjMr5VocOwRiRMiDM/+pVr162bHYlCqGJu7FfLWPLo3pbp+PnS+ruJKJsjqi/R+CEh2ILHOG7BG62t3f0zfsbCjCicqYQVZfHSfDDZdP+atEPYUa9okuj6qgijZlUoGEbyTmQBANMmL4By",
  },
};

const M = "laptop";

function pair(mod: SecureModule, other: SecureModule = mod) {
  const secret = mod.newSecret();
  const nc = mod.nonce();
  const ns = mod.nonce();
  return { secret, nc, ns, client: new mod.Cipher(secret, M, nc, ns, "client"), server: new other.Cipher(secret, M, nc, ns, "server") };
}

function flip(frame: string, index: number): string {
  const raw = Buffer.from(frame, "base64");
  raw[index] = raw[index]! ^ 0x01;
  return raw.toString("base64");
}

for (const [name, mod] of [["ts", ts], ["js", js]] as const) {
  test(`${name}: nonce and secret shapes`, () => {
    assert.equal(Buffer.from(mod.nonce(), "base64").length, 16);
    assert.match(mod.newSecret(), /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(mod.nonce(), mod.nonce());
  });

  test(`${name}: round trip both directions`, () => {
    const { client, server } = pair(mod);
    for (let i = 0; i < 5; i++) {
      assert.equal(server.open(client.seal(`c${i} é漢 🙂`)), `c${i} é漢 🙂`);
      assert.equal(client.open(server.seal(`s${i}`)), `s${i}`);
    }
    assert.equal(server.open(client.seal("")), "");
  });

  test(`${name}: a frame cannot be opened by the sending direction`, () => {
    const { secret, nc, ns, client } = pair(mod);
    const otherClient = new mod.Cipher(secret, M, nc, ns, "client");
    assert.throws(() => otherClient.open(client.seal("x")));
  });

  test(`${name}: tamper detection`, () => {
    const { client, server } = pair(mod);
    const frame = client.seal("hello world");
    const len = Buffer.from(frame, "base64").length;
    for (const i of [10, len - 1]) assert.throws(() => server.open(flip(frame, i)));
    assert.equal(server.open(frame), "hello world");
  });

  test(`${name}: replay and reorder are rejected`, () => {
    const { client, server } = pair(mod);
    const f1 = client.seal("1");
    const f2 = client.seal("2");
    const f3 = client.seal("3");
    assert.throws(() => server.open(f2), /counter/);
    assert.equal(server.open(f1), "1");
    assert.throws(() => server.open(f1), /counter/);
    assert.throws(() => server.open(f3), /counter/);
    assert.equal(server.open(f2), "2");
    assert.equal(server.open(f3), "3");
  });

  test(`${name}: short and malformed frames are rejected`, () => {
    const { server } = pair(mod);
    assert.throws(() => server.open(Buffer.alloc(23).toString("base64")), /short/);
    assert.throws(() => server.open("not base64!"), /malformed/);
    assert.throws(() => server.open(42 as unknown as string), /malformed/);
  });

  test(`${name}: proofs`, () => {
    const { secret, nc, ns } = pair(mod);
    const mac = mod.proof(secret, "client", M, nc, ns);
    assert.equal(mod.proofOk(secret, "client", M, nc, ns, mac), true);
    assert.equal(mod.proofOk(secret, "server", M, nc, ns, mac), false);
    assert.equal(mod.proofOk(mod.newSecret(), "client", M, nc, ns, mac), false);
    assert.equal(mod.proofOk(secret, "client", M, ns, nc, mac), false);
  });

  test(`${name}: proof and session key are bound to the machine name`, () => {
    const { secret, nc, ns, client } = pair(mod);
    const mac = mod.proof(secret, "client", M, nc, ns);
    assert.equal(mod.proofOk(secret, "client", "desktop", nc, ns, mac), false);
    assert.notEqual(mod.proof(secret, "server", "desktop", nc, ns), mod.proof(secret, "server", M, nc, ns));
    // a peer that shares the secret but claims another machine derives a different key
    const other = new mod.Cipher(secret, "desktop", nc, ns, "server");
    assert.throws(() => other.open(client.seal("x")));
  });

  test(`${name}: secret and machine name formats are enforced`, () => {
    const { nc, ns } = pair(mod);
    const ok = mod.newSecret();
    for (const bad of ["", "s3cret", "a".repeat(31), "a".repeat(257), `${ok.slice(0, 42)}=`, `${ok.slice(0, 42)}+`, ` ${ok}`]) {
      assert.throws(() => mod.rootKey(bad), /invalid secret/);
      assert.throws(() => new mod.Cipher(bad, M, nc, ns, "client"), /invalid secret/);
    }
    assert.doesNotThrow(() => mod.rootKey("a".repeat(32)));
    assert.doesNotThrow(() => mod.rootKey("a".repeat(256)));
    for (const bad of ["", "Laptop", "a".repeat(33), "lap top", "café", "lap_top"]) {
      assert.throws(() => mod.proof(ok, "client", bad, nc, ns), /invalid machine/);
      assert.throws(() => new mod.Cipher(ok, bad, nc, ns, "client"), /invalid machine/);
    }
  });

  test(`${name}: invalid UTF-8 inside a valid frame is rejected`, () => {
    const v = VECTOR;
    // build a frame with the vector key around invalid UTF-8 bytes
    const key = crypto.hkdfSync("sha256", mod.rootKey(v.secret), Buffer.concat([Buffer.from(v.nc, "base64"), Buffer.from(v.ns, "base64")]), Buffer.from("session-v1\0laptop"), 32);
    const iv = Buffer.from("010000000000000000000001", "hex");
    const c = crypto.createCipheriv("aes-256-gcm", Buffer.from(key), iv);
    const body = Buffer.concat([c.update(Buffer.from([0xff, 0xfe, 0x0a])), c.final(), c.getAuthTag()]);
    const frame = Buffer.concat([Buffer.from("0000000000000001", "hex"), body]).toString("base64");
    const server = new mod.Cipher(v.secret, v.machine, v.nc, v.ns, "server");
    assert.throws(() => server.open(frame));
  });

  test(`${name}: malformed mac or nonces return false`, () => {
    const { secret, nc, ns } = pair(mod);
    const mac = mod.proof(secret, "client", M, nc, ns);
    for (const bad of [undefined, null, 1, {}, [], "", "abc", mac.slice(0, -2), `${mac}A`, Buffer.from(mac, "base64")]) {
      assert.equal(mod.proofOk(secret, "client", M, nc, ns, bad), false);
    }
    assert.equal(mod.proofOk(secret, "client", M, "short", ns, mac), false);
    assert.equal(mod.proofOk(secret, "admin" as ts.Role, M, nc, ns, mac), false);
    assert.equal(mod.proofOk(secret, "client", "BAD", nc, ns, mac), false);
    assert.equal(mod.proofOk("short", "client", M, nc, ns, mac), false);
  });

  test(`${name}: fixed test vector`, () => {
    const v = VECTOR;
    assert.equal(mod.rootKey(v.secret).toString("hex"), v.root);
    assert.equal(mod.proof(v.secret, "client", v.machine, v.nc, v.ns), v.proofClient);
    assert.equal(mod.proof(v.secret, "server", v.machine, v.nc, v.ns), v.proofServer);
    assert.equal(mod.proofOk(v.secret, "client", v.machine, v.nc, v.ns, v.proofClient), true);
    const client = new mod.Cipher(v.secret, v.machine, v.nc, v.ns, "client");
    const server = new mod.Cipher(v.secret, v.machine, v.nc, v.ns, "server");
    assert.equal(client.seal(v.clientFrame1.text), v.clientFrame1.frame);
    assert.equal(server.seal(v.serverFrame1.text), v.serverFrame1.frame);
    assert.equal(server.open(v.clientFrame1.frame), v.clientFrame1.text);
    assert.equal(client.open(v.serverFrame1.frame), v.serverFrame1.text);
  });
}

test("ts and js implementations interoperate", () => {
  const a = pair(ts, js);
  assert.equal(a.server.open(a.client.seal("ts->js")), "ts->js");
  assert.equal(a.client.open(a.server.seal("js->ts")), "js->ts");
  const b = pair(js, ts);
  assert.equal(b.server.open(b.client.seal("js->ts")), "js->ts");
  assert.equal(b.client.open(b.server.seal("ts->js")), "ts->js");
  const { secret, nc, ns } = a;
  assert.equal(js.proofOk(secret, "client", M, nc, ns, ts.proof(secret, "client", M, nc, ns)), true);
  assert.equal(ts.proofOk(secret, "server", M, nc, ns, js.proof(secret, "server", M, nc, ns)), true);
});
