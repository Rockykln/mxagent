// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
// Leveled logger. Convention for all callers: log ids, sizes, counts and error messages only;
// never message bodies, attachment data, tokens, passwords, secrets or recovery keys.
import type { LogLevel } from "./config.ts";

export type { LogLevel };

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** Same sink and level, lines prefixed with `[scope]`. */
  child(scope: string): Logger;
  readonly level: LogLevel;
}

export interface LoggerOptions {
  scope?: string;
  /** Receives finished lines; defaults to stdout (debug/info) and stderr (warn/error). */
  sink?: (level: LogLevel, line: string) => void;
  now?: () => Date;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function fmt(a: unknown): string {
  if (a instanceof Error) return a.message; // no stack traces with request bodies
  if (typeof a === "string") return a;
  if (a === undefined) return "undefined";
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

const defaultSink = (level: LogLevel, line: string) => {
  if (RANK[level] >= RANK.warn) process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
};

export function createLogger(level: LogLevel = "info", opts: LoggerOptions = {}): Logger {
  const sink = opts.sink ?? defaultSink;
  const now = opts.now ?? (() => new Date());
  const prefix = opts.scope ? ` [${opts.scope}]` : "";
  const emit = (l: LogLevel, args: unknown[]) => {
    if (RANK[l] < RANK[level]) return;
    sink(l, `${now().toISOString()} ${l.toUpperCase().padEnd(5)}${prefix} ${args.map(fmt).join(" ")}`);
  };
  return {
    level,
    debug: (...a) => emit("debug", a),
    info: (...a) => emit("info", a),
    warn: (...a) => emit("warn", a),
    error: (...a) => emit("error", a),
    child: (scope) => createLogger(level, { ...opts, scope: opts.scope ? `${opts.scope}/${scope}` : scope }),
  };
}

/** Logger that drops everything (tests). */
export const silentLogger: Logger = createLogger("error", { sink: () => {} });
