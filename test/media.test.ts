// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { Attachment as CryptoAttachment } from "@matrix-org/matrix-sdk-crypto-nodejs";
import { Media, MediaError, parseMxc } from "../src/daemon/media.ts";
import { silentLogger } from "../src/daemon/log.ts";

const MIB = 1024 * 1024;
const TOKEN = "syt_test_token";

interface Call {
  url: string;
  auth: string | undefined;
}

type Responder = (url: string, signal: AbortSignal) => Response | Promise<Response>;

function setup(respond: Responder, opts: { limit?: number; timeoutMs?: number } = {}) {
  const calls: Call[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, auth: headers.Authorization });
    return respond(url, init!.signal!);
  }) as typeof fetch;
  const media = new Media({
    config: { homeserver: "https://matrix.example.org", maxAttachmentBytes: opts.limit ?? 25 * MIB },
    state: { data: { accessToken: TOKEN } },
    log: silentLogger,
    fetch: fakeFetch,
    timeoutMs: opts.timeoutMs,
  });
  return { media, calls };
}

function ok(body: Uint8Array | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  return new Response(body as BodyInit, { status: 200, headers });
}

function streamOf(chunks: Uint8Array[]): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean; pulled: () => number } {
  let i = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (i < chunks.length) ctrl.enqueue(chunks[i++]);
      else ctrl.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled, pulled: () => i };
}

function hanging(signal: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
}

async function rejectsWith(p: Promise<unknown>, re: RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof MediaError, `expected MediaError, got ${String(e)}`);
    assert.match((e as Error).message, re);
    return true;
  });
}

test("plain image download", async () => {
  const bytes = Buffer.from("hello image");
  const { media, calls } = setup(() => ok(bytes));
  const r = await media.fetch({
    msgtype: "m.image",
    body: "photo.png",
    url: "mxc://example.org/AbC123_-x",
    info: { mimetype: "image/png", size: bytes.length },
  });
  assert.deepEqual(r.attachment, {
    name: "photo.png",
    mime: "image/png",
    kind: "image",
    data: bytes.toString("base64"),
    size: bytes.length,
  });
  assert.equal(r.caption, "");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://matrix.example.org/_matrix/client/v1/media/download/example.org/AbC123_-x");
  assert.equal(calls[0].auth, `Bearer ${TOKEN}`);
});

test("kind from msgtype, default mime", async () => {
  const { media } = setup(() => ok(Buffer.from("x")));
  for (const [msgtype, kind] of [["m.file", "file"], ["m.video", "video"], ["m.audio", "audio"]] as const) {
    const r = await media.fetch({ msgtype, body: "f", url: "mxc://example.org/id" });
    assert.equal(r.attachment.kind, kind);
    assert.equal(r.attachment.mime, "application/octet-stream");
  }
  await rejectsWith(media.fetch({ msgtype: "m.text", body: "hi", url: "mxc://example.org/id" }), /unsupported message type/);
});

test("caption logic", async () => {
  const { media } = setup(() => ok(Buffer.from("x")));
  const base = { msgtype: "m.file", url: "mxc://example.org/id" };
  let r = await media.fetch({ ...base, filename: "report.pdf", body: "  see attached  " });
  assert.equal(r.attachment.name, "report.pdf");
  assert.equal(r.caption, "see attached");
  r = await media.fetch({ ...base, filename: "report.pdf", body: "report.pdf" });
  assert.equal(r.caption, "");
  r = await media.fetch({ ...base, body: "only-body.txt" });
  assert.equal(r.attachment.name, "only-body.txt");
  assert.equal(r.caption, "");
  r = await media.fetch({ ...base });
  assert.equal(r.attachment.name, "attachment");
  r = await media.fetch({ ...base, body: "a\nb\u0000.txt" });
  assert.equal(r.attachment.name, "ab.txt");
});

test("declared size over limit is rejected before download", async () => {
  const { media, calls } = setup(() => ok(Buffer.from("x")), { limit: 2 * MIB });
  await rejectsWith(
    media.fetch({ msgtype: "m.file", body: "big", url: "mxc://example.org/id", info: { size: 30 * MIB } }),
    /^file too large \(30 MB, limit 2 MB\)$/,
  );
  assert.equal(calls.length, 0);
});

test("content-length over limit is rejected", async () => {
  const { media } = setup(() => ok(Buffer.alloc(10), { "content-length": String(3 * MIB) }), { limit: 2 * MIB });
  await rejectsWith(media.fetch({ msgtype: "m.file", body: "big", url: "mxc://example.org/id" }), /^file too large \(3 MB, limit 2 MB\)$/);
});

test("actual size over limit aborts the stream", async () => {
  const chunk = new Uint8Array(1000);
  const s = streamOf(Array.from({ length: 100 }, () => chunk));
  const { media } = setup(() => ok(s.stream), { limit: 2500 });
  await rejectsWith(media.fetch({ msgtype: "m.file", body: "lie", url: "mxc://example.org/id", info: { size: 10 } }), /^file too large \(over 0 MB limit\)$/);
  assert.ok(s.pulled() < 10, `stream not aborted early (pulled ${s.pulled()})`);
  assert.ok(s.cancelled());
});

test("exactly at limit is accepted", async () => {
  const { media } = setup(() => ok(new Uint8Array(1024)), { limit: 1024 });
  const r = await media.fetch({ msgtype: "m.file", body: "f", url: "mxc://example.org/id", info: { size: 1024 } });
  assert.equal(r.attachment.size, 1024);
});

test("HTTP error", async () => {
  const { media } = setup(() => new Response("nope", { status: 404 }));
  await rejectsWith(media.fetch({ msgtype: "m.file", body: "f", url: "mxc://example.org/id" }), /^download failed \(HTTP 404\)$/);
});

test("network error does not leak details", async () => {
  const { media } = setup(() => {
    throw new TypeError(`fetch failed for https://matrix.example.org/?access_token=${TOKEN}`);
  });
  await assert.rejects(media.fetch({ msgtype: "m.file", body: "f", url: "mxc://example.org/id" }), (e: Error) => {
    assert.ok(e instanceof MediaError);
    assert.ok(!e.message.includes(TOKEN));
    assert.ok(!e.message.includes("https://"));
    return true;
  });
});

test("timeout while waiting for headers", async () => {
  const { media } = setup((_url, signal) => hanging(signal), { timeoutMs: 30 });
  await rejectsWith(media.fetch({ msgtype: "m.file", body: "f", url: "mxc://example.org/id" }), /^download timed out$/);
});

test("timeout while reading the body", async () => {
  const { media } = setup(
    (_url, signal) => {
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(new Uint8Array(5));
          signal.addEventListener("abort", () => ctrl.error(new DOMException("aborted", "AbortError")));
        },
      });
      return ok(stream);
    },
    { timeoutMs: 30 },
  );
  await rejectsWith(media.fetch({ msgtype: "m.file", body: "f", url: "mxc://example.org/id" }), /^download timed out$/);
});

test("missing and invalid mxc", async () => {
  const { media, calls } = setup(() => ok(Buffer.from("x")));
  await rejectsWith(media.fetch({ msgtype: "m.image", body: "x" }), /^no media URL$/);
  for (const url of [
    "https://example.org/id",
    "mxc://example.org",
    "mxc://example.org/",
    "mxc:///id",
    "mxc://example.org/../../admin",
    "mxc://example.org/a/b",
    "mxc://ex ample.org/id",
    "mxc://example.org/id?x=1",
    "mxc://../config",
    "mxc://./config",
    "mxc://.../config",
    "mxc://example..org/id",
    "mxc://.example.org/id",
    "mxc://example.org./id",
    "mxc://-example.org/id",
    "mxc://[..]/id",
    "mxc://example.org:/id",
    42,
  ]) {
    await rejectsWith(media.fetch({ msgtype: "m.image", body: "x", url }), /^invalid media URL$/);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(parseMxc("mxc://[::1]:8448/abc"), { server: "[::1]:8448", mediaId: "abc" });
  assert.deepEqual(parseMxc("mxc://matrix.example.org:8448/abc"), { server: "matrix.example.org:8448", mediaId: "abc" });
  assert.deepEqual(parseMxc("mxc://192.0.2.1/abc"), { server: "192.0.2.1", mediaId: "abc" });
  assert.deepEqual(parseMxc("mxc://localhost/abc"), { server: "localhost", mediaId: "abc" });
});

test("encrypted attachment round trip", async () => {
  const plain = Buffer.from("secret file contents é ñ 漢");
  const enc = CryptoAttachment.encrypt(plain);
  const cipher = Buffer.from(enc.encryptedData);
  const info = JSON.parse(enc.mediaEncryptionInfo!);
  assert.notDeepEqual(cipher, plain);
  const { media, calls } = setup(() => ok(cipher));
  const r = await media.fetch({
    msgtype: "m.file",
    body: "notes.txt",
    filename: "notes.txt",
    file: { ...info, url: "mxc://example.org/enc123" },
    info: { mimetype: "text/plain", size: plain.length },
  });
  assert.equal(calls[0].url, "https://matrix.example.org/_matrix/client/v1/media/download/example.org/enc123");
  assert.equal(Buffer.from(r.attachment.data, "base64").toString(), plain.toString());
  assert.equal(r.attachment.size, plain.length);
  assert.equal(r.attachment.mime, "text/plain");
  assert.equal(r.caption, "");
});

test("tampered encrypted attachment fails", async () => {
  const enc = CryptoAttachment.encrypt(Buffer.from("payload"));
  const cipher = Buffer.from(enc.encryptedData);
  cipher[0] ^= 0xff;
  const info = JSON.parse(enc.mediaEncryptionInfo!);
  const { media } = setup(() => ok(cipher));
  await rejectsWith(
    media.fetch({ msgtype: "m.file", body: "x", file: { ...info, url: "mxc://example.org/enc" } }),
    /^decryption failed$/,
  );
});

test("encryptedOnly refuses a plain url without file and never downloads it", async () => {
  const { media, calls } = setup(() => ok(Buffer.from("x")));
  await rejectsWith(media.fetch({ msgtype: "m.image", body: "x", url: "mxc://example.org/id" }, { encryptedOnly: true }), /^unencrypted attachment refused$/);
  await rejectsWith(media.fetch({ msgtype: "m.image", body: "x" }, { encryptedOnly: true }), /^no media URL$/);
  assert.equal(calls.length, 0);
});
