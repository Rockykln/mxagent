#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: Apache-2.0
// Echoes every owner message back and confirms it with a reaction.
// Usage: node examples/js/echo-agent.mjs [name]

import { connect } from "../../clients/js/index.mjs";

const agent = connect({ name: process.argv[2] ?? "echo" });

function describe(msg) {
  switch (msg.kind) {
    case "text":
      return `echo: ${msg.text}`;
    case "attachment": {
      const a = msg.attachment;
      const caption = msg.text ? ` "${msg.text}"` : "";
      return `got ${a.kind} ${a.name} (${a.mime}, ${a.size} bytes)${caption}`;
    }
    case "location": {
      const acc = msg.accuracy_m != null ? ` ±${Math.round(msg.accuracy_m)} m` : "";
      const desc = msg.description ? ` (${msg.description})` : "";
      return `got location ${msg.lat}, ${msg.lon}${acc}${desc}`;
    }
    case "poll_answer":
      return `poll "${msg.question}" answered: ${msg.choices.join(", ")}`;
    case "reaction":
      return null; // reacting to a reaction would loop
    default:
      return `got ${msg.kind}: ${msg.text}`;
  }
}

agent.on("message", async (msg) => {
  const answer = describe(msg);
  if (!answer) return;
  try {
    await agent.reply(answer);
    await agent.react("✅");
  } catch (err) {
    console.error("reply failed:", err.message);
  }
});

agent.on("connected", () => console.error("connected"));
agent.on("disconnected", () => console.error("disconnected, reconnecting"));

await agent.ready();
await agent.status("echo agent online");

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await agent.close();
    process.exit(0);
  });
}
