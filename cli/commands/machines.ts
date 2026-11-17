// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from "node:fs";
import path from "node:path";
import { paths } from "../../src/daemon/config.ts";
import * as machines from "../../src/daemon/machines.ts";
import { stringOpt, UsageError } from "./common.ts";
import type { Command, Env } from "./common.ts";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Validates the agent-side URL; only wss:// except for loopback hosts. */
export function checkClientUrl(v: string | undefined): string {
  if (!v) throw new UsageError("add-machine: --url is required (e.g. wss://bridge.example.org)");
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new UsageError("--url is not a valid URL");
  }
  if (u.protocol !== "wss:" && !(u.protocol === "ws:" && LOOPBACK.has(u.hostname)))
    throw new UsageError("--url must start with wss:// (ws:// only for localhost)");
  if (u.username || u.password || u.search || u.hash) throw new UsageError("--url must not contain credentials, query or fragment");
  if (/[\s"'\\#]/.test(v)) throw new UsageError("--url contains characters that are not allowed");
  return v;
}

function machineName(v: unknown): string {
  try {
    return machines.validateMachineName(v);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

const fileFor = (env: Env) => machines.machinesFile(paths(env));

export function machineList(env: Env): string[] {
  return machines.listMachines(fileFor(env));
}

export const addMachine: Command = {
  name: "add-machine",
  summary: "register a remote machine and write its client env file",
  options: { url: { type: "string" } },
  positionals: [1, 1],
  usage: `usage: mxagentctl add-machine <name> --url wss://host[/path]

Creates a random secret for a remote machine and writes client-<name>.env (MXA_URL, MXA_MACHINE,
MXA_SECRET; mode 0600) into the current directory. The secret is not printed.
Copy the file to the machine as $XDG_CONFIG_HOME/mxagent/client.env, then delete it here.

  --url URL   WebSocket URL agents on that machine connect to (through your TLS proxy)`,
  async run(ctx, args) {
    const name = machineName(args.positionals[0]);
    const url = checkClientUrl(stringOpt(args, "url"));
    const out = path.join(ctx.cwd, `client-${name}.env`);
    if (fs.existsSync(out)) throw new Error(`${out} already exists; delete it first`);
    const file = fileFor(ctx.env);
    const secret = machines.addMachine(name, file);
    try {
      fs.writeFileSync(out, `MXA_URL=${url}\nMXA_MACHINE=${name}\nMXA_SECRET=${secret}\n`, { mode: 0o600, flag: "wx" });
      fs.chmodSync(out, 0o600);
    } catch (e) {
      machines.removeMachine(name, file);
      throw e;
    }
    ctx.out(`added machine ${name}; wrote ${out}`);
    ctx.out("Copy it to the machine as $XDG_CONFIG_HOME/mxagent/client.env (mode 0600), then delete it here.");
  },
};

export const removeMachine: Command = {
  name: "remove-machine",
  summary: "revoke a remote machine's secret",
  positionals: [1, 1],
  usage: `usage: mxagentctl remove-machine <name>

Deletes the machine's secret. Agents on that machine can no longer connect; the running
daemon picks the change up without a restart and closes open links of that machine within ~30 s.`,
  async run(ctx, args) {
    const name = machineName(args.positionals[0]);
    if (!machines.removeMachine(name, fileFor(ctx.env))) throw new Error(`unknown machine ${name}`);
    ctx.out(`removed machine ${name}; it can no longer connect, and the running daemon closes its open links within ~30 s`);
  },
};

export const listMachines: Command = {
  name: "list-machines",
  summary: "list registered remote machines",
  usage: `usage: mxagentctl list-machines

Prints the names of all registered remote machines, one per line (no secrets).`,
  async run(ctx) {
    const names = machineList(ctx.env);
    if (!names.length) ctx.err("no machines registered");
    for (const n of names) ctx.out(n);
  },
};
