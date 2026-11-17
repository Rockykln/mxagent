// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ConfigError } from "../../src/daemon/config.ts";
import { defaultCtx, parseCommandArgs, UsageError } from "./common.ts";
import type { Command, Ctx } from "./common.ts";
import { crossSign } from "./cross-sign.ts";
import { loginPassword, loginSso } from "./login.ts";
import { addMachine, listMachines, removeMachine } from "./machines.ts";
import { removeRoom, resetOwnerPin } from "./state.ts";
import { status } from "./status.ts";

export const COMMANDS: readonly Command[] = [
  status,
  loginPassword,
  loginSso,
  crossSign,
  addMachine,
  removeMachine,
  listMachines,
  removeRoom,
  resetOwnerPin,
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name);
}

export function mainUsage(): string {
  const w = Math.max(...COMMANDS.map((c) => c.name.length));
  return [
    "usage: mxagentctl <command> [options]",
    "",
    "Commands:",
    ...COMMANDS.map((c) => `  ${c.name.padEnd(w)}  ${c.summary}`),
    "",
    "Run 'mxagentctl <command> --help' for details. Configuration is read from $MXA_CONFIG or",
    "$XDG_CONFIG_HOME/mxagent/bridge.env plus MXA_* environment variables.",
    "Exit codes: 0 ok, 1 error, 2 usage error.",
  ].join("\n");
}

/** Runs mxagentctl with the given arguments (without node/script). Returns the exit code. */
export async function run(argv: string[], ctx: Ctx = defaultCtx()): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === "--help" || name === "-h" || name === "help") {
    const topic = name === "help" && rest[0] ? findCommand(rest[0]) : undefined;
    if (name === "help" && rest[0] && !topic) {
      ctx.err(`unknown command "${rest[0]}"`);
      return 2;
    }
    (name === undefined ? ctx.err : ctx.out)(topic ? topic.usage : mainUsage());
    return name === undefined ? 2 : 0;
  }
  const cmd = findCommand(name);
  if (!cmd) {
    ctx.err(`unknown command "${name}"\n\n${mainUsage()}`);
    return 2;
  }
  try {
    const args = parseCommandArgs(cmd, rest);
    if (args.help) {
      ctx.out(cmd.usage);
      return 0;
    }
    const code = await cmd.run(ctx, args);
    return typeof code === "number" ? code : 0;
  } catch (e) {
    if (e instanceof UsageError) {
      ctx.err(`${e.message}\n\n${cmd.usage}`);
      return 2;
    }
    if (e instanceof ConfigError) ctx.err(e.message);
    else ctx.err(`error: ${(e as Error).message}`);
    return 1;
  }
}
