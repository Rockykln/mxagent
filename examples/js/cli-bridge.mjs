#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: Apache-2.0
// Connects a terminal program to the bridge: owner messages are written to its stdin,
// its stdout lines are posted back as replies (batched, rate limited).
// Useful for line-oriented agents and REPLs that have no MCP support.
//
// Usage: node examples/js/cli-bridge.mjs [--name NAME] -- <program> [args...]
//
// Env:
//   CLI_BRIDGE_BATCH_MS     collect output this long before sending (default 1500)
//   CLI_BRIDGE_MIN_GAP_MS   minimum gap between two replies (default 3000)
//   CLI_BRIDGE_MAX_CHARS    split replies longer than this (default 3500)
//   CLI_BRIDGE_MAX_PENDING  lines kept while waiting to send; older ones are dropped (default 1000)

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { connect } from "../../clients/js/index.mjs";

let name = "cli";
const argv = process.argv.slice(2);
while (argv.length && argv[0] !== "--") {
  const flag = argv.shift();
  if (flag === "--name" && argv.length) name = argv.shift();
  else {
    console.error(`unknown option: ${flag}`);
    process.exit(2);
  }
}
argv.shift(); // "--"
if (argv.length === 0) {
  console.error("usage: cli-bridge.mjs [--name NAME] -- <program> [args...]");
  process.exit(2);
}

function envInt(key, fallback, min) {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) {
    console.error(`${key} must be an integer >= ${min}`);
    process.exit(2);
  }
  return value;
}

const BATCH_MS = envInt("CLI_BRIDGE_BATCH_MS", 1500, 0);
const MIN_GAP_MS = envInt("CLI_BRIDGE_MIN_GAP_MS", 3000, 0);
const MAX_CHARS = envInt("CLI_BRIDGE_MAX_CHARS", 3500, 1);
const MAX_PENDING = envInt("CLI_BRIDGE_MAX_PENDING", 1000, 1);

const agent = connect({ name });
await agent.ready();

const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "inherit"] });

// --- outgoing: stdout -> batched replies ---------------------------------

let pending = [];
let dropped = 0;
let timer = null;
let lastSent = 0;
let sending = Promise.resolve();

function flushSoon() {
  if (timer) return;
  const wait = Math.max(BATCH_MS, lastSent + MIN_GAP_MS - Date.now());
  timer = setTimeout(flush, wait);
}

function flush() {
  timer = null;
  if (dropped) {
    pending.unshift(`[... ${dropped} lines dropped]`);
    dropped = 0;
  }
  if (pending.length === 0) return;

  // Take as many whole lines as fit into one message; the rest waits for the next slot.
  const chunk = [];
  let size = 0;
  while (pending.length) {
    let line = pending[0];
    if (line.length > MAX_CHARS) {
      pending[0] = line.slice(MAX_CHARS);
      line = line.slice(0, MAX_CHARS);
    } else {
      pending.shift();
    }
    if (size + line.length + 1 > MAX_CHARS && chunk.length) {
      pending.unshift(line);
      break;
    }
    chunk.push(line);
    size += line.length + 1;
  }

  lastSent = Date.now();
  const text = chunk.join("\n");
  sending = sending
    .then(() => agent.reply(text))
    .catch((err) => console.error("reply failed:", err.message));
  if (pending.length) flushSoon();
}

createInterface({ input: child.stdout }).on("line", (line) => {
  if (line.trim() === "") return;
  pending.push(line);
  if (pending.length > MAX_PENDING) {
    pending.shift();
    dropped++;
  }
  flushSoon();
});

// --- incoming: owner messages -> stdin -----------------------------------

// Writes can still fail with EPIPE when the program closes its stdin between the check and the write.
child.stdin.on("error", (err) => console.error("stdin:", err.message));

// The daemon already marks each delivered message with 👀.
agent.on("message", (msg) => {
  if (msg.kind === "reaction" || msg.kind === "poll_started") return;
  if (!child.stdin.writable) return;
  // Multi-line messages are sent as one line so line-based programs see one input.
  child.stdin.write(msg.text.replace(/\r?\n/g, " ") + "\n");
});

// --- lifecycle -------------------------------------------------------------

async function finish(statusText, exitCode) {
  try {
    await agent.status(statusText);
    await agent.close();
  } catch (err) {
    console.error("status failed:", err.message);
  }
  process.exit(exitCode);
}

child.on("error", (err) => {
  console.error(err.message);
  finish(`cannot start ${argv[0]}: ${err.message}`, 127);
});

// "close" fires after the program has exited and its stdout has ended, so readline has
// delivered every line by then ("exit" can come while output is still buffered).
child.on("close", async (code, signal) => {
  if (code === null && signal === null) return; // spawn failed, handled by "error"
  clearTimeout(timer);
  timer = null;
  while (pending.length || dropped) flush();
  await sending;
  finish(`${argv[0]} exited (${signal ?? code})`, code ?? 1);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
