// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import { agentKey } from "./registry.ts";
import type { AgentLink, AgentRegistry } from "./registry.ts";
import type { Logger } from "./log.ts";
import type { Reactions } from "./reactions.ts";

export interface UpdatesDeps {
  registry: Pick<AgentRegistry, "get" | "list">;
  reactions: Pick<Reactions, "receipt">;
  log: Logger;
  notify: { system(text: string): void };
  staggerMs?: number; // default 8000
  now?: () => number;
}

export const UPDATE_BASE_TIMEOUT_MS = 60_000;
export const UPDATE_PER_AGENT_MS = 10_000;

interface Pending {
  roomId: string;
  eventId: string;
  startedAt: number;
  names: Map<string, string>; // key -> display name
  results: Map<string, string | null | undefined>; // undefined = no report yet, null = failed
  timer: ReturnType<typeof setTimeout>;
}

/**
 * `@update` fan-out and completion tracking. Agents on one machine often share a working copy, so
 * concurrent self-updates there would collide: machines run in parallel, agents per machine are
 * staggered by `staggerMs`.
 */
export class Updates {
  private readonly registry: UpdatesDeps["registry"];
  private readonly reactions: UpdatesDeps["reactions"];
  private readonly log: Logger;
  private readonly notify: UpdatesDeps["notify"];
  private readonly staggerMs: number;
  private readonly now: () => number;
  private pending: Pending | null = null;
  private readonly sendTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(deps: UpdatesDeps) {
    this.registry = deps.registry;
    this.reactions = deps.reactions;
    this.log = deps.log;
    this.notify = deps.notify;
    this.staggerMs = deps.staggerMs ?? 8000;
    this.now = deps.now ?? Date.now;
  }

  /** Owner `@update [agent]` in the control room. Replaces a pending update. */
  async command(roomId: string, eventId: string, target?: string): Promise<void> {
    this.cancel();
    let links: AgentLink[];
    if (target !== undefined && target.trim() !== "") {
      const l = this.registry.get(agentKey(target.trim()));
      links = l && l.alive() ? [l] : [];
    } else {
      links = this.registry.list().filter((l) => l.alive());
    }

    // Tracking starts before anything is sent: an agent may answer before the receipt below returns.
    if (links.length) {
      const run: Pending = {
        roomId,
        eventId,
        startedAt: this.now(),
        names: new Map(links.map((l) => [l.key, l.name])),
        results: new Map(links.map((l) => [l.key, undefined])),
        timer: setTimeout(() => this.finish(run, true), UPDATE_BASE_TIMEOUT_MS + links.length * UPDATE_PER_AGENT_MS),
      };
      this.pending = run;
    }
    const receipt = this.reactions.receipt(roomId, eventId, "👀");
    if (!links.length) {
      this.notify.system(target ? `Update: agent "${target.trim()}" is not connected.` : "Update: no agent connected.");
      await receipt;
      return;
    }
    this.log.info("update requested for", links.length, "agent(s)");
    this.notify.system(`Update requested: ${links.map((l) => l.name).join(", ")}`);

    const perMachine = new Map<string, AgentLink[]>();
    for (const l of links) {
      const group = perMachine.get(l.machine);
      if (group) group.push(l);
      else perMachine.set(l.machine, [l]);
    }
    for (const group of perMachine.values()) {
      group.forEach((l, i) => {
        if (i === 0) {
          this.sendUpdate(l);
          return;
        }
        const t = setTimeout(() => {
          this.sendTimers.delete(t);
          this.sendUpdate(l);
        }, i * this.staggerMs);
        this.sendTimers.add(t);
      });
    }
    await receipt;
  }

  /**
   * From `updated` (version = the link's current version; pass "" if the agent reports none) or
   * `update_failed` (null). Reports from agents that were not targeted are ignored.
   */
  reported(key: string, version: string | null): void {
    const p = this.pending;
    if (!p || !p.results.has(key) || p.results.get(key) !== undefined) return;
    p.results.set(key, version);
    if ([...p.results.values()].every((v) => v !== undefined)) this.finish(p, false);
  }

  /** True while a completion is being tracked. */
  get active(): boolean {
    return this.pending !== null;
  }

  /** Stops pending sends and tracking without a result (shutdown or replacement). */
  cancel(): void {
    for (const t of this.sendTimers) clearTimeout(t);
    this.sendTimers.clear();
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }

  private sendUpdate(l: AgentLink): void {
    const current = this.registry.get(l.key);
    if (current !== l || !l.alive()) return;
    try {
      l.send({ type: "update" });
    } catch (e) {
      this.log.warn("update send failed for", l.key, (e as Error)?.message ?? String(e));
    }
  }

  /** Ends `p` only if it is still the current run, so a stale timer cannot end a newer one. */
  private finish(p: Pending, timedOut: boolean): void {
    if (this.pending !== p) return;
    this.pending = null;
    clearTimeout(p.timer);
    const entries = [...p.results.entries()];
    const name = (k: string) => p.names.get(k) ?? k;
    const succeeded = entries.filter((e): e is [string, string] => typeof e[1] === "string");
    const versions = new Set(succeeded.map(([, v]) => v));
    const failed = entries.filter(([, v]) => v === null).map(([k]) => name(k));
    const missing = entries.filter(([, v]) => v === undefined).map(([k]) => name(k));
    const secs = Math.max(0, Math.round((this.now() - p.startedAt) / 1000));

    if (!timedOut && !failed.length && !missing.length && versions.size === 1) {
      const v = [...versions][0];
      void this.reactions.receipt(p.roomId, p.eventId, "✅");
      this.notify.system(`Update complete: all ${entries.length} agent(s) on version ${v || "unknown"} (${secs} s)`);
      this.log.info("update complete for", entries.length, "agent(s)");
      return;
    }
    void this.reactions.receipt(p.roomId, p.eventId, "⚠️");
    const parts = [
      failed.length ? `failed: ${failed.join(", ")}` : "",
      missing.length ? `no response: ${missing.join(", ")}` : "",
      versions.size > 1 ? `mixed versions: ${succeeded.map(([k, v]) => `${name(k)} ${v || "unknown"}`).join(", ")}` : "",
    ].filter(Boolean);
    this.notify.system(`Update incomplete (${parts.join("; ")})`);
    this.log.warn("update incomplete:", failed.length, "failed,", missing.length, "no response,", versions.size, "version(s)");
  }
}
