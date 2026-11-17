// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DaemonMessage } from "../protocol/messages.ts";

/** One connected agent, independent of the transport. */
export interface AgentLink {
  readonly key: string; // agentKey(name)
  readonly name: string;
  readonly instance?: string;
  readonly machine: string; // "local" for the Unix socket, machine name for WebSocket
  readonly version?: string;
  readonly client?: string;
  readonly since: number; // ms epoch of registration
  send(msg: DaemonMessage): void;
  close(): void;
  /** false once the transport is known dead (closed, or missed pings). */
  alive(): boolean;
}

/** Command words and managed room names; agents must not take them as names (docs/reference/protocol.md). */
export const RESERVED_NAMES: ReadonlySet<string> = new Set(["all", "room", "list", "update", "control", "system"]);

/** Names that are special as JavaScript object keys; rejected so no lookup can reach Object.prototype. */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(Object.getOwnPropertyNames(Object.prototype).map((k) => k.toLowerCase()).concat("prototype"));

/** Default number of new agent rooms one machine may create per daemon run. */
export const MAX_NEW_ROOMS_PER_MACHINE = 20;

// No whitespace: names are addressed as @name in the control room.
const NAME_RE = /^[\p{L}\p{N}._-]{1,64}$/u;

/** Canonical lookup key for an agent name (NFC, lower case). */
export function agentKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/** Returns the trimmed, NFC-normalized name or throws an Error with a client-facing message. */
export function validateAgentName(input: unknown): string {
  if (typeof input !== "string") throw new Error("invalid name");
  const name = input.normalize("NFC").trim();
  if (!NAME_RE.test(name)) throw new Error("invalid name (1-64 letters, digits, '.', '_', '-')");
  const key = agentKey(name);
  if (RESERVED_NAMES.has(key) || UNSAFE_KEYS.has(key)) throw new Error(`name "${name}" is reserved`);
  return name;
}

export type RegisterResult =
  | { ok: true; replaced?: AgentLink; reason?: "same-instance" | "stale" }
  | { ok: false; error: string; existing: AgentLink };

export class AgentRegistry {
  private readonly links = new Map<string, AgentLink>();

  /**
   * Adds a link. If an agent with the same key exists:
   * - same non-empty `instance` from the same machine -> replaced (reconnect of the same agent process),
   * - existing link not alive -> replaced (stale),
   * - otherwise rejected; the existing link stays.
   * A replaced link is removed first and then closed, so its close handler's remove() is a no-op.
   */
  register(link: AgentLink): RegisterResult {
    const existing = this.links.get(link.key);
    if (!existing) {
      this.links.set(link.key, link);
      return { ok: true };
    }
    if (existing === link) return { ok: true };
    let reason: "same-instance" | "stale" | undefined;
    if (!existing.alive()) reason = "stale";
    // the instance id is client-chosen, so it only counts on the machine that registered it
    else if (link.instance && existing.instance === link.instance && existing.machine === link.machine) reason = "same-instance";
    if (!reason) return { ok: false, error: `an agent named "${existing.name}" is already connected`, existing };
    this.links.set(link.key, link);
    try {
      existing.close();
    } catch {
      // the old transport may already be gone
    }
    return { ok: true, replaced: existing, reason };
  }

  /** Removes the link only if it is still the registered one for its key. Returns true if removed. */
  remove(link: AgentLink): boolean {
    if (this.links.get(link.key) !== link) return false;
    this.links.delete(link.key);
    return true;
  }

  get(key: string): AgentLink | undefined {
    return this.links.get(key);
  }

  has(key: string): boolean {
    return this.links.has(key);
  }

  /** All links sorted by name (case-insensitive). */
  list(): AgentLink[] {
    return [...this.links.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  keys(): string[] {
    return this.list().map((l) => l.key);
  }

  get size(): number {
    return this.links.size;
  }

  /** Removes and closes every link that reports !alive(). Returns the dropped links. */
  sweep(): AgentLink[] {
    const dead = [...this.links.values()].filter((l) => !l.alive());
    for (const l of dead) {
      this.links.delete(l.key);
      try {
        l.close();
      } catch {
        // ignore
      }
    }
    return dead;
  }

  /** Closes and forgets all links (shutdown). */
  closeAll(): void {
    for (const l of this.links.values()) {
      try {
        l.close();
      } catch {
        // ignore
      }
    }
    this.links.clear();
  }
}

/**
 * Limits how many new agent rooms (names without a room yet) each machine may create while the daemon runs,
 * so a leaked machine secret cannot fill the space with rooms and invites.
 */
export class RoomQuota {
  private readonly max: number;
  private readonly used = new Map<string, Set<string>>(); // machine -> agent keys it created rooms for

  constructor(max = MAX_NEW_ROOMS_PER_MACHINE) {
    this.max = max;
  }

  /** Reserves a new room for `key` on `machine`; false if the machine has used up its quota. */
  take(machine: string, key: string): boolean {
    let set = this.used.get(machine);
    if (set?.has(key)) return true;
    if ((set?.size ?? 0) >= this.max) return false;
    if (!set) this.used.set(machine, (set = new Set()));
    set.add(key);
    return true;
  }

  /** Gives a reservation back (room creation failed). */
  release(machine: string, key: string): void {
    this.used.get(machine)?.delete(key);
  }
}
