// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";
import type { ParseArgsConfig } from "node:util";
import { paths } from "../../src/daemon/config.ts";

export type Env = Record<string, string | undefined>;

export interface Ctx {
  env: Env;
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  fetch: typeof fetch;
  /** Reads a secret from the terminal without echo. */
  promptHidden: (question: string) => Promise<string>;
  /** Asks a yes/no question on the terminal; resolves false when no terminal is available. */
  confirm: (question: string) => Promise<boolean>;
}

/** Wrong invocation: exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type Options = NonNullable<ParseArgsConfig["options"]>;

export interface Command {
  name: string;
  summary: string;
  usage: string; // full --help text
  options?: Options;
  positionals?: [min: number, max: number];
  run(ctx: Ctx, args: ParsedArgs): Promise<number | void>;
}

export interface ParsedArgs {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
}

/** Strict option parsing; unknown options and wrong positional counts raise UsageError. */
export function parseCommandArgs(cmd: Command, argv: string[]): ParsedArgs & { help: boolean } {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { ...cmd.options, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const values = parsed.values as Record<string, string | boolean | undefined>;
  const help = values.help === true;
  delete values.help;
  const [min, max] = cmd.positionals ?? [0, 0];
  if (!help) {
    if (parsed.positionals.length < min) throw new UsageError(`${cmd.name}: missing argument`);
    if (parsed.positionals.length > max) throw new UsageError(`${cmd.name}: unexpected argument "${parsed.positionals[max]}"`);
  }
  return { values, positionals: parsed.positionals, help };
}

export function stringOpt(args: ParsedArgs, name: string): string | undefined {
  const v = args.values[name];
  return typeof v === "string" ? v : undefined;
}

export class MatrixApiError extends Error {
  readonly status: number;
  readonly errcode?: string;
  constructor(message: string, status: number, errcode?: string) {
    super(message);
    this.name = "MatrixApiError";
    this.status = status;
    this.errcode = errcode;
  }
}

/** Client-server API call. Errors name the method, path and Matrix error code, never the token. */
export async function matrixApi<T = any>(
  doFetch: typeof fetch,
  homeserver: string,
  token: string | undefined,
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await doFetch(homeserver + apiPath, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const errcode = typeof data.errcode === "string" ? data.errcode : undefined;
    const detail = typeof data.error === "string" ? data.error.slice(0, 200) : "";
    const shownPath = apiPath.split("?")[0];
    throw new MatrixApiError(`${method} ${shownPath}: ${res.status} ${errcode ?? ""} ${detail}`.replace(/\s+/g, " ").trim(), res.status, errcode);
  }
  return data as T;
}

/** True if something accepts connections on the Unix socket (i.e. the daemon is running). */
export function socketAnswers(socketPath: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(socketPath);
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/**
 * Socket paths where a daemon may listen: the configured one, MXA_SOCKET_PATH from the
 * environment, and the defaults of the user and system service. The CLI's environment can
 * differ from the daemon's (sudo, ssh, a unit that sets MXA_SOCKET_PATH), so all are checked.
 */
export function daemonSocketCandidates(env: Env, configured?: string): string[] {
  const list: (string | undefined)[] = [configured, env.MXA_SOCKET_PATH];
  if (env.XDG_RUNTIME_DIR) list.push(path.join(env.XDG_RUNTIME_DIR, "mxagent.sock"));
  else if (typeof process.getuid === "function") list.push(`/run/user/${process.getuid()}/mxagent.sock`);
  list.push(path.join(paths(env).stateDir, "bridge.sock"), "/run/mxagent/bridge.sock");
  return [...new Set(list.filter((v): v is string => !!v))];
}

/** Returns the first candidate socket that answers, or undefined. */
export async function findRunningDaemon(env: Env, configured?: string): Promise<string | undefined> {
  for (const s of daemonSocketCandidates(env, configured)) if (await socketAnswers(s)) return s;
  return undefined;
}

export const DAEMON_CHECK_NOTE = `The running-daemon check connects to MXA_SOCKET_PATH and the default socket locations; if the
daemon uses another socket path, set MXA_SOCKET_PATH to it when running this command.`;

/** Throws if a daemon answers on any candidate socket; the daemon owns the state file while running. */
export async function refuseIfRunning(env: Env, configured?: string): Promise<void> {
  const s = await findRunningDaemon(env, configured);
  if (s) throw new Error(`the daemon is running (${s} answers) and owns the state file; stop it first (systemctl [--user] stop mxagent)`);
}

/** Warning text for plain http to a non-loopback homeserver, else undefined. */
export function plainHttpWarning(homeserver: string): string | undefined {
  try {
    const u = new URL(homeserver);
    if (u.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
      return `${u.origin} uses plain http; login tokens and the access token travel unencrypted`;
  } catch {
    // validated elsewhere
  }
  return undefined;
}

/** Writes a new file with mode 0600, creating the parent directory with 0700. Fails if the file exists unless overwrite. */
export function writeSecretFile(file: string, content: string, overwrite = false): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (overwrite) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
  } else {
    fs.writeFileSync(file, content, { mode: 0o600, flag: "wx" });
  }
  fs.chmodSync(file, 0o600);
}

/** Raised when a prompt needs a terminal but stdin is not one. */
export class NoTerminalError extends Error {
  constructor(message = "no terminal to read from") {
    super(message);
    this.name = "NoTerminalError";
  }
}

/** Minimal stream surface the prompts need (process.stdin satisfies it; tests pass a fake). */
export type PromptInput = Pick<NodeJS.ReadStream, "isTTY" | "setRawMode" | "setEncoding" | "on" | "once" | "removeListener" | "pause" | "resume">;
export type PromptOutput = Pick<NodeJS.WriteStream, "write">;

/** Reads a line without echo. Rejects on Ctrl-C, Ctrl-D and end of input. */
export function promptHiddenTty(question: string, input: PromptInput = process.stdin, output: PromptOutput = process.stderr): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!input.isTTY) {
      reject(new NoTerminalError());
      return;
    }
    output.write(question);
    let buf = "";
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      try {
        input.setRawMode(false);
      } catch {
        // terminal already gone
      }
      input.pause();
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("close", onEnd);
      output.write("\n");
      if (err) reject(err);
      else resolve(buf);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003") return finish(new Error("cancelled"));
        if (ch === "\u0004") return finish(new Error("cancelled (end of input)"));
        if (ch === "\u007f" || ch === "\b") buf = Array.from(buf).slice(0, -1).join("");
        else if (ch >= " ") buf += ch;
      }
    };
    const onEnd = () => finish(new Error("cancelled (end of input)"));
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("close", onEnd);
    input.resume();
  });
}

/** Asks a yes/no question. Resolves false without a terminal; rejects on end of input (Ctrl-D). */
export function confirmTty(question: string, input: PromptInput = process.stdin, output: PromptOutput = process.stderr): Promise<boolean> {
  return new Promise((resolve, reject) => {
    if (!input.isTTY) {
      resolve(false);
      return;
    }
    output.write(`${question} [y/N] `);
    let done = false;
    const cleanup = () => {
      done = true;
      input.pause();
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("close", onEnd);
    };
    const onData = (d: string) => {
      if (done) return;
      cleanup();
      resolve(/^\s*y(es)?\s*$/i.test(d));
    };
    const onEnd = () => {
      if (done) return;
      cleanup();
      output.write("\n");
      reject(new Error("aborted (end of input)"));
    };
    input.setEncoding("utf8");
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("close", onEnd);
    input.resume();
  });
}

export function defaultCtx(): Ctx {
  return {
    env: process.env,
    cwd: process.cwd(),
    out: (l) => process.stdout.write(l + "\n"),
    err: (l) => process.stderr.write(l + "\n"),
    fetch: (...a) => fetch(...a),
    promptHidden: (q) => promptHiddenTty(q),
    confirm: (q) => confirmTty(q),
  };
}
