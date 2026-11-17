// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from "node:fs";
import path from "node:path";

export interface RoomEntry {
  roomId: string;
  name: string; // display name as the agent sent it in hello
}

export interface State {
  accessToken?: string;
  deviceId?: string;
  spaceId?: string;
  controlRoomId?: string;
  systemRoomId?: string;
  ownerMasterKey?: string; // pinned owner cross-signing master key (unpadded base64)
  botMasterKey?: string; // bot master key verified by mxagentctl cross-sign (trust anchor)
  deviceEd25519?: string; // ed25519 key of the daemon's own device (unpadded base64), written at startup
  rooms: Record<string, RoomEntry>; // key: agentKey(name); null-prototype object, use Object.hasOwn
}

const OPTIONAL_STRINGS = ["accessToken", "deviceId", "spaceId", "controlRoomId", "systemRoomId", "ownerMasterKey", "botMasterKey", "deviceEd25519"] as const;

/** An empty rooms map without a prototype, so keys such as "__proto__" are plain entries. */
export function emptyRooms(): Record<string, RoomEntry> {
  return Object.create(null) as Record<string, RoomEntry>;
}

/** Keeps only well-formed fields, so a hand-edited or truncated file cannot inject odd types. */
export function sanitizeState(raw: unknown): State {
  const out: State = { rooms: emptyRooms() };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  for (const k of OPTIONAL_STRINGS) if (typeof r[k] === "string" && r[k]) out[k] = r[k] as string;
  if (r.rooms && typeof r.rooms === "object") {
    for (const [key, v] of Object.entries(r.rooms as Record<string, unknown>)) {
      const e = v as Partial<RoomEntry> | null;
      if (e && typeof e === "object" && typeof e.roomId === "string" && typeof e.name === "string") out.rooms[key] = { roomId: e.roomId, name: e.name };
    }
  }
  return out;
}

/** Persisted daemon state. Mutate `data` in place, then call `save()`. */
export class StateStore {
  readonly file: string;
  readonly data: State;

  constructor(file: string, data: State) {
    this.file = file;
    if (!data.rooms || typeof data.rooms !== "object") data.rooms = emptyRooms();
    else if (Object.getPrototypeOf(data.rooms) !== null) data.rooms = Object.assign(emptyRooms(), data.rooms);
    this.data = data;
  }

  /** Reads the file; a missing file yields empty state. Invalid JSON throws (never silently drop a session). */
  static load(file: string): StateStore {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let raw: unknown = {};
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`cannot read state file ${file}: ${(e as Error).message}`);
    }
    return new StateStore(file, sanitizeState(raw));
  }

  /**
   * Durable atomic write: temp file created exclusively with mode 0600 (never follows a symlink or reuses a
   * leftover file), fsync, rename, fsync of the directory. The temp file is removed on failure.
   */
  save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.rmSync(tmp, { force: true });
    let fd: number | undefined = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(this.data, null, 2) + "\n");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmp, this.file);
    } catch (e) {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    fsyncDir(path.dirname(this.file));
  }
}

/** Best effort: fsync a directory so a rename in it is durable. */
export function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    // not supported on every platform
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
