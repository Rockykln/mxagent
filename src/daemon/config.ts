// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** MXA_TRUST_PROXY_HEADER: which request header (if any) holds the client address. */
export const PROXY_HEADER_MODES = ["none", "cf-connecting-ip", "x-forwarded-for"] as const;
export type ProxyHeaderMode = (typeof PROXY_HEADER_MODES)[number];

export interface Config {
  homeserver: string; // client API base URL, no trailing slash
  botUser: string;
  botPassword?: string;
  owner: string;
  spaceId: string;
  controlRoomId?: string;
  socketPath: string;
  wsListen?: { host: string; port: number };
  trustProxyHeader: ProxyHeaderMode; // MXA_TRUST_PROXY_HEADER, default "none"
  recoveryKey?: string;
  maxAttachmentBytes: number;
  approvalTtlMs: number; // MXA_APPROVAL_TTL_MINUTES (1-1440), default 15 minutes
  logLevel: LogLevel;
  serverName: string; // server part of botUser, used as "via" for room links
  warnings: string[]; // non-fatal problems found while loading (log them at startup)
}

export interface Paths {
  configDir: string;
  configFile: string;
  stateDir: string;
  ssoSessionFile: string; // <stateDir>/sso-session.json (the daemon must be able to delete it)
  replayFile: string; // <stateDir>/replay.log
  cryptoDir: string;
  syncFile: string;
  stateFile: string;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

type Env = Record<string, string | undefined>;

const APP = "mxagent";

/**
 * File and directory locations. MXA_STATE_DIR is taken from the environment, else from the config file
 * (`fileVars`, read from the config file when not given), else the XDG default.
 */
export function paths(env: Env = process.env, fileVars?: Env): Paths {
  const home = os.homedir();
  const configFile = env.MXA_CONFIG || path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), APP, "bridge.env");
  const configDir = path.dirname(configFile);
  const fileStateDir = env.MXA_STATE_DIR ? undefined : (fileVars ?? readEnvFileQuiet(configFile)).MXA_STATE_DIR?.trim();
  const stateDir = env.MXA_STATE_DIR || fileStateDir || path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), APP);
  return {
    configDir,
    configFile,
    stateDir,
    ssoSessionFile: path.join(stateDir, "sso-session.json"),
    replayFile: path.join(stateDir, "replay.log"),
    cryptoDir: path.join(stateDir, "crypto"),
    syncFile: path.join(stateDir, "sync.json"),
    stateFile: path.join(stateDir, "state.json"),
  };
}

/** Variables of an env file, or {} if it cannot be read (errors are reported by loadConfig). */
function readEnvFileQuiet(file: string): Env {
  try {
    return parseEnvFile(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** Parses KEY=value lines. Supports comments, blank lines, `export KEY=...` and single/double quoted values. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(i + 1).trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) {
      value = value.slice(1, -1);
      if (q === '"') value = value.replace(/\\(["\\n])/g, (_, c: string) => (c === "n" ? "\n" : c));
    }
    out[key] = value;
  }
  return out;
}

const USER_ID = /^@[^:\s]+:[^\s]+$/;
const ROOM_ID = /^![^\s]+$/; // room v12 ids have no server part
const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

function parseListen(v: string): { host: string; port: number } | null {
  const m = v.match(/^(?:(?:\[([^\]]+)\]|([^:[\]]+)):)?(\d{1,5})$/);
  if (!m) return null;
  const port = Number(m[3]);
  if (port < 1 || port > 65535) return null;
  return { host: m[1] ?? m[2] ?? "127.0.0.1", port };
}

/** Builds and validates a Config from already merged variables. Pure apart from the default socket path. */
export function configFromVars(vars: Env, env: Env = process.env): Config {
  const problems: string[] = [];
  const warnings: string[] = [];
  const get = (k: string) => {
    const v = vars[k]?.trim();
    return v ? v : undefined;
  };
  const need = (k: string) => {
    const v = get(k);
    if (!v) problems.push(`${k} is required`);
    return v ?? "";
  };

  let homeserver = need("MXA_HOMESERVER").replace(/\/+$/, "");
  if (homeserver) {
    try {
      const u = new URL(homeserver);
      if (u.protocol !== "https:" && u.protocol !== "http:") problems.push("MXA_HOMESERVER must be an http(s) URL");
      else if (u.search || u.hash) problems.push("MXA_HOMESERVER must not contain a query or fragment");
      else if (u.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
        warnings.push("MXA_HOMESERVER uses plain http to a non-local host");
    } catch {
      problems.push("MXA_HOMESERVER is not a valid URL");
      homeserver = "";
    }
  }

  const botUser = need("MXA_BOT_USER");
  if (botUser && !USER_ID.test(botUser)) problems.push("MXA_BOT_USER must look like @bot:example.org");
  const owner = need("MXA_OWNER");
  if (owner && !USER_ID.test(owner)) problems.push("MXA_OWNER must look like @you:example.org");
  if (owner && botUser && owner === botUser) problems.push("MXA_OWNER and MXA_BOT_USER must be different accounts");

  const spaceId = need("MXA_SPACE_ID");
  if (spaceId && !ROOM_ID.test(spaceId)) problems.push("MXA_SPACE_ID must be a room id (starts with '!')");
  const controlRoomId = get("MXA_CONTROL_ROOM_ID");
  if (controlRoomId && !ROOM_ID.test(controlRoomId)) problems.push("MXA_CONTROL_ROOM_ID must be a room id (starts with '!')");

  let wsListen: Config["wsListen"];
  const ws = get("MXA_WS_LISTEN");
  if (ws) {
    wsListen = parseListen(ws) ?? undefined;
    if (!wsListen) problems.push("MXA_WS_LISTEN must be host:port or port (e.g. 127.0.0.1:8640)");
  }

  let trustProxyHeader: ProxyHeaderMode = "none";
  const tph = get("MXA_TRUST_PROXY_HEADER")?.toLowerCase();
  if (tph !== undefined) {
    if ((PROXY_HEADER_MODES as readonly string[]).includes(tph)) trustProxyHeader = tph as ProxyHeaderMode;
    else problems.push(`MXA_TRUST_PROXY_HEADER must be one of ${PROXY_HEADER_MODES.join(", ")}`);
  }
  if (get("MXA_TRUST_PROXY_HEADERS") !== undefined) {
    problems.push(`MXA_TRUST_PROXY_HEADERS is not a setting; did you mean MXA_TRUST_PROXY_HEADER (${PROXY_HEADER_MODES.join(", ")})?`);
  }

  let maxAttachmentBytes = 25 * 1024 * 1024;
  const mb = get("MXA_MAX_ATTACHMENT_MB");
  if (mb) {
    const n = Number(mb);
    // Clients cap a line at 64 MiB; base64 adds a third, so 45 MB is the safe maximum.
    if (!Number.isFinite(n) || n <= 0 || n > 45) problems.push("MXA_MAX_ATTACHMENT_MB must be a number greater than 0 and at most 45");
    else maxAttachmentBytes = Math.floor(n * 1024 * 1024);
  }

  let approvalTtlMs = 15 * 60_000;
  const ttl = get("MXA_APPROVAL_TTL_MINUTES");
  if (ttl) {
    const n = Number(ttl);
    if (!Number.isInteger(n) || n < 1 || n > 1440) problems.push("MXA_APPROVAL_TTL_MINUTES must be a whole number from 1 to 1440");
    else approvalTtlMs = n * 60_000;
  }

  const level = (get("MXA_LOG_LEVEL") ?? "info").toLowerCase() as LogLevel;
  if (!LOG_LEVELS.includes(level)) problems.push(`MXA_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}`);

  const recoveryKey = get("MXA_RECOVERY_KEY");
  if (recoveryKey) warnings.push("MXA_RECOVERY_KEY is set; remove it after running mxagentctl cross-sign");

  if (problems.length) throw new ConfigError(problems);

  const p = paths(env, vars);
  const socketPath = get("MXA_SOCKET_PATH") ?? (env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, `${APP}.sock`) : path.join(p.stateDir, "bridge.sock"));

  return {
    homeserver,
    botUser,
    botPassword: vars.MXA_BOT_PASSWORD || undefined, // not trimmed: passwords may contain spaces
    owner,
    spaceId,
    controlRoomId,
    socketPath,
    wsListen,
    trustProxyHeader,
    recoveryKey,
    maxAttachmentBytes,
    approvalTtlMs,
    logLevel: level,
    serverName: botUser.slice(botUser.indexOf(":") + 1),
    warnings,
  };
}

/**
 * Loads the env file ($MXA_CONFIG or $XDG_CONFIG_HOME/mxagent/bridge.env) and merges it with
 * the process environment; variables set in the environment win over the file. A missing default file is
 * fine (environment-only setups); a missing file named by MXA_CONFIG is an error.
 */
export function loadConfig(env: Env = process.env): Config {
  const p = paths(env, {});
  let fileVars: Record<string, string> = {};
  let fileWarning: string | undefined;
  try {
    const st = fs.statSync(p.configFile);
    if ((st.mode & 0o077) !== 0) fileWarning = `${p.configFile} is readable by other users; run chmod 600 on it`;
    fileVars = parseEnvFile(fs.readFileSync(p.configFile, "utf8"));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" || env.MXA_CONFIG) throw new ConfigError([`cannot read config file ${p.configFile}: ${code ?? (e as Error).message}`]);
  }
  if (fileVars.MXA_CONFIG) fileWarning ??= "MXA_CONFIG in the config file has no effect; set it in the environment";
  const merged: Env = { ...fileVars };
  for (const [k, v] of Object.entries(env)) if (k.startsWith("MXA_") && v !== undefined && v !== "") merged[k] = v;
  const cfg = configFromVars(merged, env);
  if (fileWarning) cfg.warnings.unshift(fileWarning);
  return cfg;
}
