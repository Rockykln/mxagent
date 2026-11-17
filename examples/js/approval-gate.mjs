#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: Apache-2.0
// Runs a command only after the owner allows it in the Matrix room.
// The command is started without a shell; for pipes or `&&` pass `sh -c '...'` explicitly.
// Usage: node examples/js/approval-gate.mjs -- <command> [args...]
// Exit code: the command's exit code (128 + signal number if killed), 77 if denied,
// 2 for usage errors.

import { spawn } from "node:child_process";
import { constants } from "node:os";
import { basename } from "node:path";
import { connect } from "../../clients/js/index.mjs";

const argv = process.argv.slice(2);
if (argv[0] === "--") argv.shift();
if (argv.length === 0) {
  console.error("usage: approval-gate.mjs -- <command> [args...]");
  process.exit(2);
}

// The owner decides based on this text, so it must show exactly what runs: every argument is
// shell-quoted, and control characters (newlines could forge extra lines in the approval
// detail) as well as invisible or direction-changing characters are refused.
const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

function shellQuote(arg) {
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

const cwd = process.cwd();
for (const value of [...argv, cwd]) {
  if (value.match(UNSAFE)) {
    const shown = value.replace(UNSAFE, (c) => `\\u{${c.codePointAt(0).toString(16)}}`);
    console.error(`refusing to run: control or invisible characters in "${shown}"`);
    process.exit(2);
  }
}

const commandLine = argv.map(shellQuote).join(" ");

const agent = connect({ name: process.env.MXA_AGENT_NAME ?? "approval-gate" });
await agent.ready();

const decision = await agent.requestApproval({
  title: `Run ${basename(argv[0])}?`,
  detail: `${commandLine}\ncwd: ${shellQuote(cwd)}`,
});

if (decision !== "allow") {
  await agent.status(`denied: ${commandLine}`);
  await agent.close();
  process.exit(77);
}

const started = Date.now();
const child = spawn(argv[0], argv.slice(1), { stdio: "inherit" });

const code = await new Promise((resolve) => {
  child.on("error", (err) => {
    console.error(err.message);
    resolve(127);
  });
  child.on("exit", (c, signal) => resolve(c ?? 128 + (constants.signals[signal] ?? 0)));
});

const secs = ((Date.now() - started) / 1000).toFixed(1);
await agent.status(code === 0 ? `ok (${secs} s): ${commandLine}` : `failed, exit ${code} (${secs} s): ${commandLine}`);
await agent.close();
process.exit(code);
