// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from "node:fs";
import { loadConfig, paths } from "../../src/daemon/config.ts";
import type { Config } from "../../src/daemon/config.ts";
import { StateStore } from "../../src/daemon/state.ts";
import { findRunningDaemon } from "./common.ts";
import type { Command } from "./common.ts";
import { machineList } from "./machines.ts";

/** URL for GET /health on the WebSocket listener; wildcard binds are reached via loopback. */
export function healthUrl(listen: NonNullable<Config["wsListen"]>): string {
  let host = listen.host;
  if (host === "0.0.0.0") host = "127.0.0.1";
  else if (host === "::") host = "::1";
  if (host.includes(":")) host = `[${host}]`;
  return `http://${host}:${listen.port}/health`;
}

export const status: Command = {
  name: "status",
  summary: "show configuration, state and daemon health (no secrets)",
  usage: `usage: mxagentctl status

Prints a summary of the configuration and the state file without secrets, checks whether the
daemon socket answers (MXA_SOCKET_PATH and the default locations) and, if MXA_WS_LISTEN is set, requests GET /health.
Exit code 1 if the health check fails.`,
  async run(ctx) {
    const cfg = loadConfig(ctx.env);
    const p = paths(ctx.env);
    const yesNo = (b: boolean) => (b ? "yes" : "no");
    const rows: [string, string][] = [
      ["config file", p.configFile],
      ["state dir", p.stateDir],
      ["homeserver", cfg.homeserver],
      ["bot user", cfg.botUser],
      ["owner", cfg.owner],
      ["space", cfg.spaceId],
      ["control room", cfg.controlRoomId ?? "(created by the daemon)"],
      ["socket", cfg.socketPath],
      ["websocket", cfg.wsListen ? `${cfg.wsListen.host}:${cfg.wsListen.port}` : "off"],
      ["password set", yesNo(!!cfg.botPassword)],
      ["recovery key set", yesNo(!!cfg.recoveryKey)],
    ];

    const state = StateStore.load(p.stateFile);
    const d = state.data;
    let sso = "none";
    try {
      const s = JSON.parse(fs.readFileSync(p.ssoSessionFile, "utf8")) as { userId?: unknown; deviceId?: unknown };
      sso = `${String(s.userId)}, device ${String(s.deviceId)}`;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") sso = "unreadable";
    }
    const rooms = Object.values(d.rooms);
    rows.push(
      ["logged in", d.accessToken ? `yes, device ${d.deviceId ?? "?"}` : "no"],
      ["sso session file", sso],
      ["control room id", d.controlRoomId ?? "-"],
      ["system room id", d.systemRoomId ?? "-"],
      ["owner key pinned", d.ownerMasterKey ? `yes (${d.ownerMasterKey.slice(0, 8)}...)` : "no"],
      ["agent rooms", rooms.length ? `${rooms.length} (${rooms.map((r) => r.name).sort().join(", ")})` : "0"],
    );

    let machines: string;
    try {
      const names = machineList(ctx.env);
      machines = names.length ? `${names.length} (${names.join(", ")})` : "0";
    } catch (e) {
      machines = `unreadable (${(e as Error).message})`;
    }
    rows.push(["machines", machines]);
    const running = await findRunningDaemon(ctx.env, cfg.socketPath);
    rows.push(["daemon", running ? (running === cfg.socketPath ? "running" : `running (socket ${running})`) : "not running"]);

    let code = 0;
    if (cfg.wsListen) {
      const url = healthUrl(cfg.wsListen);
      try {
        const res = await ctx.fetch(url, { signal: AbortSignal.timeout(5000) });
        const body = (await res.text()).trim().slice(0, 40).replace(/[^\x20-\x7e]/g, "?");
        rows.push(["health", `${res.status} ${body}`]);
        if (!res.ok) code = 1;
      } catch (e) {
        rows.push(["health", `unreachable (${(e as Error).message})`]);
        code = 1;
      }
    }

    const w = Math.max(...rows.map(([k]) => k.length));
    for (const [k, v] of rows) ctx.out(`${k.padEnd(w)}  ${v}`);
    for (const warning of cfg.warnings) ctx.err(`warning: ${warning}`);
    return code;
  },
};
