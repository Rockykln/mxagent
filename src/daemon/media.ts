// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Attachment as CryptoAttachment, EncryptedAttachment } from "@matrix-org/matrix-sdk-crypto-nodejs";
import type { Config } from "./config.ts";
import type { State } from "./state.ts";
import type { Logger } from "./log.ts";
import type { Attachment, AttachmentKind } from "../protocol/messages.ts";

export const MEDIA_TIMEOUT_MS = 60_000;

const KINDS: Record<string, AttachmentKind> = {
  "m.image": "image",
  "m.file": "file",
  "m.video": "video",
  "m.audio": "audio",
};

const MIB = 1024 * 1024;

/** Error whose message is safe to show to the owner (no URLs, no tokens). */
export class MediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaError";
  }
}

export interface MediaDeps {
  config: Pick<Config, "homeserver" | "maxAttachmentBytes">;
  state: { data: Pick<State, "accessToken"> };
  log: Logger;
  fetch?: typeof fetch;
  timeoutMs?: number; // default MEDIA_TIMEOUT_MS
}

export interface MediaResult {
  attachment: Attachment;
  caption: string;
}

function formatMb(bytes: number): string {
  const mb = bytes / MIB;
  return mb >= 10 ? String(Math.round(mb)) : String(Math.round(mb * 10) / 10);
}

// Server name: DNS name or IPv4 (dot-separated labels, no empty label, so no "." or "..") or
// bracketed IPv6, each with an optional port.
const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const SERVER_RE = new RegExp(`^(?:${LABEL}(?:\\.${LABEL})*|\\[(?=[^\\]]*:)[0-9A-Fa-f:.]{2,45}\\])(?::\\d{1,5})?$`);
const MEDIA_ID_RE = /^[A-Za-z0-9_-]{1,255}$/;

/** Splits an mxc:// URI into server name and media id; throws MediaError if malformed. */
export function parseMxc(uri: unknown): { server: string; mediaId: string } {
  if (typeof uri !== "string" || !uri.startsWith("mxc://")) throw new MediaError("invalid media URL");
  const rest = uri.slice(6);
  const slash = rest.indexOf("/");
  if (slash < 0) throw new MediaError("invalid media URL");
  const server = rest.slice(0, slash);
  const mediaId = rest.slice(slash + 1);
  if (server.length > 255 || !SERVER_RE.test(server) || !MEDIA_ID_RE.test(mediaId)) throw new MediaError("invalid media URL");
  return { server, mediaId };
}

function cleanName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
  return (name || "attachment").slice(0, 255);
}

export class Media {
  private readonly config: MediaDeps["config"];
  private readonly state: MediaDeps["state"];
  private readonly log: Logger;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(deps: MediaDeps) {
    this.config = deps.config;
    this.state = deps.state;
    this.log = deps.log;
    this.fetchFn = deps.fetch ?? fetch;
    this.timeoutMs = deps.timeoutMs ?? MEDIA_TIMEOUT_MS;
  }

  /**
   * Downloads (and decrypts) the media of an m.room.message in memory. With `encryptedOnly` (messages from
   * encrypted rooms) a plain `url` without `file` is refused: only `file` media is hash-checked.
   * Throws MediaError with an owner-facing message on failure.
   */
  async fetch(content: any, opts: { encryptedOnly?: boolean } = {}): Promise<MediaResult> {
    if (!content || typeof content !== "object") throw new MediaError("no media URL");
    const kind = KINDS[content.msgtype];
    if (!kind) throw new MediaError("unsupported message type");
    const limit = this.config.maxAttachmentBytes;
    const declared = content.info?.size;
    if (typeof declared === "number" && declared > limit) throw this.tooLarge(declared);

    const encrypted = content.file && typeof content.file === "object" ? content.file : null;
    if (!encrypted && opts.encryptedOnly) throw new MediaError(content.url ? "unencrypted attachment refused" : "no media URL");
    const mxc = encrypted ? encrypted.url : content.url;
    if (mxc === undefined || mxc === null || mxc === "") throw new MediaError("no media URL");
    const { server, mediaId } = parseMxc(mxc);

    const raw = await this.download(server, mediaId, limit);
    let data: Buffer;
    if (encrypted) {
      try {
        data = Buffer.from(CryptoAttachment.decrypt(new EncryptedAttachment(raw, JSON.stringify(encrypted))));
      } catch {
        throw new MediaError("decryption failed");
      }
    } else {
      data = raw;
    }
    if (data.length > limit) throw this.tooLarge(data.length);

    const filename = typeof content.filename === "string" && content.filename ? content.filename : undefined;
    const body = typeof content.body === "string" ? content.body : undefined;
    const caption = filename !== undefined && body !== undefined && body !== filename ? body.trim() : "";
    const mime = typeof content.info?.mimetype === "string" && content.info.mimetype ? content.info.mimetype : "application/octet-stream";

    this.log.debug("fetched attachment", kind, data.length, "bytes", encrypted ? "(encrypted)" : "(plain)");
    return {
      attachment: { name: cleanName(filename ?? body), mime, kind, data: data.toString("base64"), size: data.length },
      caption,
    };
  }

  /** Without `bytes` (real size unknown, stream cut off) only the limit is reported. */
  private tooLarge(bytes?: number): MediaError {
    const limit = formatMb(this.config.maxAttachmentBytes);
    return new MediaError(bytes === undefined ? `file too large (over ${limit} MB limit)` : `file too large (${formatMb(bytes)} MB, limit ${limit} MB)`);
  }

  private async download(server: string, mediaId: string, limit: number): Promise<Buffer> {
    const url = `${this.config.homeserver}/_matrix/client/v1/media/download/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`;
    const headers: Record<string, string> = {};
    const token = this.state.data.accessToken;
    if (token) headers.Authorization = `Bearer ${token}`;

    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, this.timeoutMs);
    try {
      let res: Response;
      try {
        res = await this.fetchFn(url, { headers, signal: ctrl.signal, redirect: "follow" });
      } catch (e) {
        if (timedOut) throw new MediaError("download timed out");
        this.log.warn("media download error:", (e as Error)?.name ?? "error");
        throw new MediaError("download failed (network error)");
      }
      if (!res.ok) {
        res.body?.cancel().catch(() => {});
        throw new MediaError(`download failed (HTTP ${res.status})`);
      }
      const length = Number(res.headers.get("content-length"));
      if (Number.isFinite(length) && length > limit) {
        res.body?.cancel().catch(() => {});
        throw this.tooLarge(length);
      }
      return await this.readBody(res, limit, ctrl, () => timedOut);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readBody(res: Response, limit: number, ctrl: AbortController, timedOut: () => boolean): Promise<Buffer> {
    if (!res.body) return Buffer.alloc(0);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
          ctrl.abort();
          reader.cancel().catch(() => {});
          throw this.tooLarge();
        }
        chunks.push(value);
      }
    } catch (e) {
      if (e instanceof MediaError) throw e;
      if (timedOut()) throw new MediaError("download timed out");
      throw new MediaError("download failed (connection interrupted)");
    }
    return Buffer.concat(chunks, total);
  }
}
