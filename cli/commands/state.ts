// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import { loadConfig, paths } from "../../src/daemon/config.ts";
import { agentKey, validateAgentName } from "../../src/daemon/registry.ts";
import { StateStore } from "../../src/daemon/state.ts";
import { DAEMON_CHECK_NOTE, MatrixApiError, matrixApi, refuseIfRunning, UsageError } from "./common.ts";
import type { Command } from "./common.ts";

export const removeRoom: Command = {
  name: "remove-room",
  summary: "unlink an agent's room from the space, leave it and forget it",
  positionals: [1, 1],
  usage: `usage: mxagentctl remove-room <agent>

Removes the agent's room from the space, makes the bot leave it and deletes it from the state
file. The room itself stays for its other members (you can leave it in your client).
The daemon must be stopped, because it owns the state file while running.
${DAEMON_CHECK_NOTE}`,
  async run(ctx, args) {
    const cfg = loadConfig(ctx.env);
    await refuseIfRunning(ctx.env, cfg.socketPath);
    const state = StateStore.load(paths(ctx.env).stateFile);
    const key = agentKey(args.positionals[0]);
    const entry = state.data.rooms[key];
    if (!entry) {
      // an existing entry is removable whatever its name; otherwise tell a typo from an invalid name
      try {
        validateAgentName(args.positionals[0]);
      } catch (e) {
        throw new UsageError(`remove-room: ${(e as Error).message}`);
      }
      throw new Error(`no room for agent "${args.positionals[0]}"`);
    }
    const token = state.data.accessToken;
    if (!token) throw new Error("not logged in; no access token in the state file");
    const e = encodeURIComponent;
    const api = (method: string, p: string, body: unknown) => matrixApi(ctx.fetch, cfg.homeserver, token, method, p, body);

    try {
      await api("PUT", `/_matrix/client/v3/rooms/${e(cfg.spaceId)}/state/m.space.child/${e(entry.roomId)}`, {});
    } catch (err) {
      ctx.err(`warning: unlinking from the space failed: ${(err as Error).message}`);
    }
    await api("PUT", `/_matrix/client/v3/rooms/${e(entry.roomId)}/state/m.space.parent/${e(cfg.spaceId)}`, {}).catch(() => undefined);
    try {
      await api("POST", `/_matrix/client/v3/rooms/${e(entry.roomId)}/leave`, {});
    } catch (err) {
      // already left or room gone: still drop it from the state
      if (!(err instanceof MatrixApiError) || (err.status !== 403 && err.status !== 404)) throw err;
      ctx.err(`warning: leaving failed: ${err.message}`);
    }
    delete state.data.rooms[key];
    state.save();
    ctx.out(`removed room of ${entry.name} (${entry.roomId})`);
  },
};

export const resetOwnerPin: Command = {
  name: "reset-owner-pin",
  summary: "forget the pinned owner master key (after the owner reset cross-signing)",
  options: { yes: { type: "boolean", short: "y" } },
  usage: `usage: mxagentctl reset-owner-pin [--yes]

The daemon pins the owner's cross-signing master key on first use and rejects all owner messages
if it changes. After the owner has reset cross-signing, verify the owner's new identity from the
bot account FIRST (the bot's user-signing key must sign the new master key), then run this
command. The new key is pinned on the next verified owner message.
The daemon must be stopped.
${DAEMON_CHECK_NOTE}

  -y, --yes   do not ask for confirmation (required when not running in a terminal)`,
  async run(ctx, args) {
    const cfg = loadConfig(ctx.env);
    await refuseIfRunning(ctx.env, cfg.socketPath);
    const state = StateStore.load(paths(ctx.env).stateFile);
    const pinned = state.data.ownerMasterKey;
    if (!pinned) {
      ctx.out("no owner key is pinned; nothing to do");
      return;
    }
    ctx.err(`Pinned owner master key: ${pinned}`);
    ctx.err("Warning: only continue if you have re-verified the owner's new identity with the bot account.");
    ctx.err("Without that verification the new key is not trusted and owner messages stay rejected.");
    if (args.values.yes !== true && !(await ctx.confirm("Forget the pinned key?"))) {
      ctx.err("aborted (use --yes when not running in a terminal)");
      return 1;
    }
    delete state.data.ownerMasterKey;
    state.save();
    ctx.out("owner key pin cleared; start the daemon and send a message from a verified device to pin the new key");
  },
};
