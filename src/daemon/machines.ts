// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { newSecret } from "../protocol/secure.ts";
import { paths, type Paths } from "./config.ts";
import type { Logger } from "./log.ts";

export const MACHINE_NAME_RE = /^[a-z0-9-]{1,32}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{32,256}$/;

/** `<configDir>/machines`: one "<name> <secret>" per line, mode 0600. */
export function machinesFile(p: Pick<Paths, "configDir">): string {
  return path.join(p.configDir, "machines");
}

export function validateMachineName(input: unknown): string {
  if (typeof input !== "string" || !MACHINE_NAME_RE.test(input)) {
    throw new Error("machine names are 1-32 characters of a-z, 0-9 and -");
  }
  return input;
}

/** Lines that are blank, comments or malformed are ignored; the first entry for a name wins. */
export function parseMachines(text: string): Map<string, string> {
  return parseMachinesFile(text).map;
}

interface ParsedMachines {
  map: Map<string, string>;
  lines: string[]; // raw lines, kept when the file is rewritten
  invalid: number[]; // 1-based numbers of lines that are neither blank, comments nor used entries
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function entryOf(raw: string): [string, string] | undefined {
  const line = raw.trim();
  if (!line || line.startsWith("#")) return undefined;
  const parts = line.split(/\s+/);
  if (parts.length !== 2) return undefined;
  const [name, secret] = parts as [string, string];
  return MACHINE_NAME_RE.test(name) && SECRET_RE.test(secret) ? [name, secret] : undefined;
}

export function parseMachinesFile(text: string): ParsedMachines {
  const map = new Map<string, string>();
  const lines = splitLines(text);
  const invalid: number[] = [];
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const e = entryOf(raw);
    if (!e || map.has(e[0])) invalid.push(i + 1);
    else map.set(e[0], e[1]);
  });
  return { map, lines, invalid };
}

const HEADER = '# mxagent machine secrets, one "<name> <secret>" per line; managed by mxagentctl';

/**
 * Rewrites `lines` so they hold `map`: comments, blank and malformed lines stay as they are; the first entry of
 * a kept machine gets its (new) secret; duplicate entries and entries of removed machines are dropped (a kept
 * duplicate would become active once the first entry is removed); new machines are appended.
 */
function renderMachines(lines: string[], map: Map<string, string>): string {
  const out: string[] = [];
  const written = new Set<string>();
  for (const raw of lines) {
    const e = entryOf(raw);
    if (!e) {
      out.push(raw);
      continue;
    }
    const name = e[0];
    if (!map.has(name) || written.has(name)) continue;
    out.push(`${name} ${map.get(name)!}`);
    written.add(name);
  }
  for (const [n, sec] of map) if (!written.has(n)) out.push(`${n} ${sec}`);
  if (!out.some((l) => l.trim())) out.unshift(HEADER);
  return out.map((l) => `${l}\n`).join("");
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Removes a stale lock file atomically: renames it to a unique name, then checks that the renamed file is
 * the one judged stale (same inode). If another writer replaced the lock in the meantime, its fresh lock
 * is put back with link(), which fails rather than overwrite a lock created since. Returns true if the
 * stale lock was removed.
 */
export function takeOverStaleLock(lock: string, stale: Pick<fs.Stats, "ino" | "dev">): boolean {
  const aside = `${lock}.stale.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.renameSync(lock, aside);
  } catch {
    return false; // released or taken over by someone else
  }
  let same = false;
  try {
    const st = fs.statSync(aside);
    same = st.ino === stale.ino && st.dev === stale.dev;
  } catch {
    // vanished; nothing to restore
  }
  if (!same) {
    try {
      fs.linkSync(aside, lock);
    } catch {
      // a newer lock exists already; that writer holds the lock
    }
  }
  fs.rmSync(aside, { force: true });
  return same;
}

export interface MachineStoreOptions {
  log?: Logger;
  /** A missing or empty file only revokes all machines after it stayed so for this long (editors saving). */
  missingGraceMs?: number; // 2000
  lockTimeoutMs?: number; // 5000: how long a writer waits for the lock file
  staleLockMs?: number; // 30000: an older lock file is left over from a crashed writer and is removed
  now?: () => number;
}

/**
 * Machine secrets backed by a file. Reads are re-validated against the file's stat, so changes made by
 * `mxagentctl add-machine` / `remove-machine` apply to the running daemon without a restart. Read errors keep
 * the last good list. Writers take `<file>.lock` and write atomically (temp file, fsync, rename, fsync dir).
 */
export class MachineStore {
  readonly file: string;
  readonly #log?: Logger;
  readonly #graceMs: number;
  readonly #lockTimeoutMs: number;
  readonly #staleLockMs: number;
  readonly #now: () => number;
  #map = new Map<string, string>();
  #stamp = "";
  #goneSince: number | undefined;
  #warnedMode = false;
  #warnedRead = false;
  #warnedInvalid = "";

  constructor(file: string, opts: MachineStoreOptions = {}) {
    this.file = file;
    this.#log = opts.log;
    this.#graceMs = opts.missingGraceMs ?? 2000;
    this.#lockTimeoutMs = opts.lockTimeoutMs ?? 5000;
    this.#staleLockMs = opts.staleLockMs ?? 30_000;
    this.#now = opts.now ?? Date.now;
  }

  #readError(e: unknown): void {
    if (this.#warnedRead) return;
    this.#warnedRead = true;
    this.#log?.warn("cannot read machines file, keeping the last good list:", (e as Error).message);
  }

  /** The file is missing or empty: revoke everything, but only once that state outlasts the grace period. */
  #gone(stamp: string): void {
    const t = this.#now();
    if (this.#map.size) {
      this.#goneSince ??= t;
      if (t - this.#goneSince < this.#graceMs) return;
    }
    this.#map = new Map();
    this.#stamp = stamp;
    this.#goneSince = undefined;
  }

  #reload(): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") this.#gone("");
      else this.#readError(e);
      return;
    }
    const stamp = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    if (stamp === this.#stamp) return;
    if (st.mode & 0o077 && !this.#warnedMode) {
      this.#warnedMode = true;
      this.#log?.warn("machines file is accessible by group/others; run: chmod 600", this.file);
    }
    let text: string;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") this.#gone("");
      else this.#readError(e);
      return;
    }
    if (!text.trim()) {
      this.#gone(stamp);
      return;
    }
    const parsed = parseMachinesFile(text);
    this.#map = parsed.map;
    this.#stamp = stamp;
    this.#goneSince = undefined;
    this.#warnedRead = false;
    this.#warnInvalid(parsed.invalid);
  }

  #warnInvalid(invalid: number[]): void {
    const key = invalid.join(",");
    if (key === this.#warnedInvalid) return;
    this.#warnedInvalid = key;
    if (invalid.length) {
      this.#log?.warn(`machines file: ignoring malformed or duplicate entries on line(s) ${invalid.slice(0, 20).join(", ")}`);
    }
  }

  /** Current file content for a writer; unlike #reload() it never falls back to a cached list. */
  #readForWrite(): ParsedMachines {
    let text = "";
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const parsed = parseMachinesFile(text);
    this.#warnInvalid(parsed.invalid);
    return parsed;
  }

  #withLock<T>(fn: () => T): T {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const lock = `${this.file}.lock`;
    const deadline = this.#now() + this.#lockTimeoutMs;
    let fd: number | undefined;
    while (fd === undefined) {
      try {
        fd = fs.openSync(lock, "wx", 0o600);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        let st: fs.Stats;
        try {
          st = fs.statSync(lock);
        } catch {
          continue; // released in the meantime
        }
        if (this.#now() - st.mtimeMs > this.#staleLockMs) {
          takeOverStaleLock(lock, st);
          continue;
        }
        if (this.#now() >= deadline) throw new Error(`machines file is locked by another process (${lock})`);
        sleepSync(25);
      }
    }
    const own = fs.fstatSync(fd);
    try {
      fs.writeSync(fd, `${process.pid}\n`);
      return fn();
    } finally {
      fs.closeSync(fd);
      // Remove only our own lock file, never one another writer created after taking ours over.
      try {
        const cur = fs.statSync(lock);
        if (cur.ino === own.ino && cur.dev === own.dev) fs.rmSync(lock, { force: true });
      } catch {
        // already gone
      }
    }
  }

  #write(lines: string[], map: Map<string, string>): void {
    const dir = path.dirname(this.file);
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.rmSync(tmp, { force: true });
    try {
      const fd = fs.openSync(tmp, "wx", 0o600);
      try {
        fs.writeSync(fd, renderMachines(lines, map));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    try {
      const dfd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(dfd);
      } finally {
        fs.closeSync(dfd);
      }
    } catch {
      // directory fsync is not supported everywhere; the rename itself has happened
    }
    this.#stamp = "";
    this.#goneSince = undefined;
    this.#reload();
  }

  secretFor(name: unknown): string | undefined {
    if (typeof name !== "string" || !MACHINE_NAME_RE.test(name)) return undefined;
    this.#reload();
    return this.#map.get(name);
  }

  /** Creates a machine and returns its new secret. Throws if the name is invalid or exists (unless `replace`). */
  addMachine(name: string, opts: { replace?: boolean } = {}): string {
    validateMachineName(name);
    return this.#withLock(() => {
      const cur = this.#readForWrite();
      if (cur.map.has(name) && !opts.replace) throw new Error(`machine "${name}" already exists`);
      const secret = newSecret();
      const next = new Map(cur.map);
      next.set(name, secret);
      this.#write(cur.lines, next);
      return secret;
    });
  }

  /** Returns false if the machine did not exist. Open links of that machine are not closed here. */
  removeMachine(name: string): boolean {
    if (!MACHINE_NAME_RE.test(name)) return false;
    return this.#withLock(() => {
      const cur = this.#readForWrite();
      if (!cur.map.has(name)) return false;
      const next = new Map(cur.map);
      next.delete(name);
      this.#write(cur.lines, next);
      return true;
    });
  }

  listMachines(): string[] {
    this.#reload();
    return [...this.#map.keys()].sort();
  }
}

/** Convenience wrappers on `machinesFile(paths())` (or `file`), e.g. for mxagentctl. */
export function defaultMachineStore(file: string = machinesFile(paths())): MachineStore {
  return new MachineStore(file);
}

export function secretFor(name: unknown, file?: string): string | undefined {
  return defaultMachineStore(file).secretFor(name);
}

export function addMachine(name: string, file?: string, opts: { replace?: boolean } = {}): string {
  return defaultMachineStore(file).addMachine(name, opts);
}

export function removeMachine(name: string, file?: string): boolean {
  return defaultMachineStore(file).removeMachine(name);
}

export function listMachines(file?: string): string[] {
  return defaultMachineStore(file).listMachines();
}
