// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import { ConfigError, loadConfig, paths } from "../../src/daemon/config.ts";
import { StateStore } from "../../src/daemon/state.ts";
import { DAEMON_CHECK_NOTE, matrixApi, NoTerminalError, plainHttpWarning, refuseIfRunning, stringOpt, UsageError, writeSecretFile } from "./common.ts";
import type { Command, Ctx } from "./common.ts";

const DEVICE_NAME = () => `mxagent (${os.hostname()})`;

interface LoginResponse {
  user_id?: string;
  device_id?: string;
  access_token?: string;
}

function checkLoginResponse(r: LoginResponse): { userId: string; deviceId: string; accessToken: string } {
  if (typeof r.user_id !== "string" || typeof r.device_id !== "string" || typeof r.access_token !== "string" || !r.access_token)
    throw new Error("homeserver returned an incomplete login response");
  return { userId: r.user_id, deviceId: r.device_id, accessToken: r.access_token };
}

function cryptoStoreWarning(ctx: Ctx, cryptoDir: string): void {
  try {
    if (fs.readdirSync(cryptoDir).length > 0)
      ctx.err(`warning: ${cryptoDir} belongs to the previous device; move it away before starting the daemon`);
  } catch {
    // no crypto store yet
  }
}

/** Logs out a replaced session so no orphaned device with a valid token stays on the server. */
async function logoutOld(ctx: Ctx, homeserver: string, token: string, what: string): Promise<void> {
  try {
    await matrixApi(ctx.fetch, homeserver, token, "POST", "/_matrix/client/v3/logout", {});
    ctx.out(`logged out ${what}`);
  } catch (e) {
    ctx.err(`warning: could not log out ${what} (${(e as Error).message}); remove its device in a Matrix client`);
  }
}

export const loginPassword: Command = {
  name: "login-password",
  summary: "log the bot in with its password and store the session in the state file",
  options: { force: { type: "boolean" } },
  usage: `usage: mxagentctl login-password [--force]

Logs the bot account in with m.login.password and stores the access token and device id in the
state file. The password comes from MXA_BOT_PASSWORD or is asked for on the terminal (hidden).
The daemon must be stopped, because it owns the state file while running.
${DAEMON_CHECK_NOTE}

  --force   replace an existing session; the old device is logged out (best effort)`,
  async run(ctx, args) {
    const cfg = loadConfig(ctx.env);
    const p = paths(ctx.env);
    await refuseIfRunning(ctx.env, cfg.socketPath);
    const state = StateStore.load(p.stateFile);
    const old = { token: state.data.accessToken, deviceId: state.data.deviceId };
    if (old.token && args.values.force !== true)
      throw new Error(`already logged in (device ${old.deviceId ?? "?"}); use --force to replace the session`);
    const httpWarning = plainHttpWarning(cfg.homeserver);
    if (httpWarning) ctx.err(`warning: ${httpWarning}`);
    let password = cfg.botPassword;
    if (!password) {
      try {
        password = await ctx.promptHidden(`Password for ${cfg.botUser}: `);
      } catch (e) {
        if (e instanceof NoTerminalError) throw new Error(`${e.message}; set MXA_BOT_PASSWORD or run in a terminal`);
        throw e;
      }
    }
    if (!password) throw new Error("empty password");
    const r = checkLoginResponse(
      await matrixApi<LoginResponse>(ctx.fetch, cfg.homeserver, undefined, "POST", "/_matrix/client/v3/login", {
        type: "m.login.password",
        identifier: { type: "m.id.user", user: cfg.botUser },
        password,
        initial_device_display_name: DEVICE_NAME(),
      }),
    );
    if (r.userId !== cfg.botUser) throw new Error(`homeserver logged in ${r.userId}, expected ${cfg.botUser}`);
    state.data.accessToken = r.accessToken;
    state.data.deviceId = r.deviceId;
    state.save();
    ctx.out(`logged in as ${r.userId}, device ${r.deviceId}; session saved to ${p.stateFile}`);
    if (old.token && old.token !== r.accessToken) {
      await logoutOld(ctx, cfg.homeserver, old.token, `the previous device ${old.deviceId ?? "?"}`);
      cryptoStoreWarning(ctx, p.cryptoDir);
    }
    if (cfg.botPassword) ctx.out("You can remove MXA_BOT_PASSWORD from the config file now.");
    ctx.out("Next: start the daemon once, then run mxagentctl cross-sign.");
  },
};

export interface SsoLoginOptions {
  homeserver: string;
  file: string;
  fetch: typeof fetch;
  out: (line: string) => void;
  timeoutMs?: number;
  /** Fixed callback port (for an SSH port forward); 0 or unset picks a random port. */
  port?: number;
  /** Called with the URL the user has to open (tests use it to drive the flow). */
  onUrl?: (url: string) => void;
}

/**
 * SSO login via a one-shot callback server on 127.0.0.1. The callback path contains a random
 * nonce so stray requests are ignored. Resolves with the session after it was written to `file`.
 */
export function ssoLogin(o: SsoLoginOptions): Promise<{ userId: string; deviceId: string }> {
  const nonce = crypto.randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    let finished = false;
    let claimed = false; // set before the token exchange so a second callback is never exchanged
    const finish = (err: Error | null, v?: { userId: string; deviceId: string }) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      if (err) reject(err);
      else resolve(v!);
    };
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const token = url.searchParams.get("loginToken");
      if (req.method !== "GET" || url.pathname !== `/callback/${nonce}` || !token || finished || claimed) {
        res.writeHead(404).end();
        return;
      }
      claimed = true;
      try {
        const r = checkLoginResponse(
          await matrixApi<LoginResponse>(o.fetch, o.homeserver, undefined, "POST", "/_matrix/client/v3/login", {
            type: "m.login.token",
            token,
            initial_device_display_name: DEVICE_NAME(),
          }),
        );
        writeSecretFile(o.file, JSON.stringify({ userId: r.userId, deviceId: r.deviceId, accessToken: r.accessToken }, null, 2) + "\n");
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Login complete. You can close this window.");
        finish(null, { userId: r.userId, deviceId: r.deviceId });
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("Login failed, see terminal.");
        finish(e as Error);
      }
    });
    const timer = setTimeout(() => finish(new Error("timed out waiting for the SSO callback")), o.timeoutMs ?? 10 * 60_000);
    server.once("error", (e) => finish(e));
    server.listen(o.port ?? 0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      const redirect = encodeURIComponent(`http://127.0.0.1:${port}/callback/${nonce}`);
      const url = `${o.homeserver}/_matrix/client/v3/login/sso/redirect?redirectUrl=${redirect}`;
      if (o.port) {
        o.out(`If the browser runs on another machine, run this there first: ssh -L ${port}:127.0.0.1:${port} <this host>`);
        o.out("");
      }
      o.out("Open this URL in a browser (a private window avoids logging in with the wrong account):");
      o.out("");
      o.out(url);
      o.out("");
      o.out(`Waiting for the callback (${Math.round((o.timeoutMs ?? 600_000) / 60_000)} minutes)...`);
      o.onUrl?.(url);
    });
  });
}

function normalizeHomeserver(v: string): string {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new UsageError("--homeserver must be a URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new UsageError("--homeserver must be an http(s) URL");
  return v.replace(/\/+$/, "");
}

function parsePort(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!/^\d+$/.test(v) || n < 1 || n > 65535) throw new UsageError("--port must be a number between 1 and 65535");
  return n;
}

export const loginSso: Command = {
  name: "login-sso",
  summary: "log the bot in via SSO/OIDC in a browser and write the session file",
  options: { homeserver: { type: "string" }, port: { type: "string" }, force: { type: "boolean" } },
  usage: `usage: mxagentctl login-sso [--homeserver URL] [--port N] [--force]

For bot accounts without a password (SSO or OIDC login). Starts a callback server on
127.0.0.1, prints the homeserver's SSO URL, and exchanges the returned login token
(m.login.token). The session is written to sso-session.json in the state directory (mode 0600).
The daemon moves it into the state file on its next start, but only if the state file has no
session yet; --force therefore also removes the old session from the state file and logs it out.
The daemon must be stopped.
${DAEMON_CHECK_NOTE}

On a headless server, pick a port and forward it from the machine with the browser:
  ssh -L 8400:127.0.0.1:8400 <server>    then run: mxagentctl login-sso --port 8400

  --homeserver URL   homeserver client API URL (default: MXA_HOMESERVER)
  --port N           callback port on 127.0.0.1 (default: random)
  --force            replace an existing session (session file and state file)`,
  async run(ctx, args) {
    const p = paths(ctx.env);
    const force = args.values.force === true;
    const port = parsePort(stringOpt(args, "port"));
    const given = stringOpt(args, "homeserver");
    let homeserver = given;
    let botUser: string | undefined;
    let configured: string | undefined;
    let socketPath: string | undefined;
    try {
      const cfg = loadConfig(ctx.env);
      botUser = cfg.botUser;
      configured = cfg.homeserver;
      socketPath = cfg.socketPath;
      homeserver ??= cfg.homeserver;
    } catch (e) {
      if (!homeserver || !(e instanceof ConfigError)) throw e;
    }
    homeserver = normalizeHomeserver(homeserver);
    if (given && configured && homeserver !== configured)
      ctx.err(`warning: --homeserver ${homeserver} differs from MXA_HOMESERVER ${configured}; the daemon will use this session against MXA_HOMESERVER`);
    const httpWarning = plainHttpWarning(homeserver);
    if (httpWarning) ctx.err(`warning: ${httpWarning}`);

    await refuseIfRunning(ctx.env, socketPath);
    const state = StateStore.load(p.stateFile);
    const old = { token: state.data.accessToken, deviceId: state.data.deviceId };
    if (old.token && !force)
      throw new Error(`already logged in (device ${old.deviceId ?? "?"}); the daemon would ignore a new session file; use --force to replace the session`);
    if (fs.existsSync(p.ssoSessionFile) && !force) throw new Error(`${p.ssoSessionFile} already exists; use --force to replace it`);

    const flows = await matrixApi<{ flows?: { type?: string }[] }>(ctx.fetch, homeserver, undefined, "GET", "/_matrix/client/v3/login");
    const types = new Set((flows.flows ?? []).map((f) => f.type));
    if (!types.has("m.login.sso") || !types.has("m.login.token")) throw new Error("homeserver does not offer SSO login (m.login.sso + m.login.token)");

    const tmp = `${p.ssoSessionFile}.new`;
    fs.rmSync(tmp, { force: true });
    const r = await ssoLogin({ homeserver, file: tmp, fetch: ctx.fetch, out: ctx.out, port });
    const readToken = (file: string): string | undefined => {
      try {
        const t = (JSON.parse(fs.readFileSync(file, "utf8")) as { accessToken?: unknown }).accessToken;
        return typeof t === "string" ? t : undefined;
      } catch {
        return undefined;
      }
    };
    if (botUser && r.userId !== botUser) {
      try {
        await matrixApi(ctx.fetch, homeserver, readToken(tmp), "POST", "/_matrix/client/v3/logout", {});
      } catch {
        ctx.err("warning: could not log out the unexpected session; remove its device in a Matrix client");
      }
      fs.rmSync(tmp, { force: true });
      throw new Error(`logged in as ${r.userId}, but MXA_BOT_USER is ${botUser}; session discarded`);
    }
    const unusedFileToken = readToken(p.ssoSessionFile);
    fs.renameSync(tmp, p.ssoSessionFile);
    ctx.out(`logged in as ${r.userId}, device ${r.deviceId}; session saved to ${p.ssoSessionFile}`);
    if (unusedFileToken && unusedFileToken !== old.token) await logoutOld(ctx, homeserver, unusedFileToken, "the session of the replaced session file");
    if (old.token) {
      delete state.data.accessToken;
      delete state.data.deviceId;
      state.save();
      ctx.out(`removed the previous session from ${p.stateFile}`);
      await logoutOld(ctx, homeserver, old.token, `the previous device ${old.deviceId ?? "?"}`);
      cryptoStoreWarning(ctx, p.cryptoDir);
    }
    ctx.out("The daemon moves the session into the state file on its next start.");
  },
};
