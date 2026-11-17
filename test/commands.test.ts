// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseControlCommand, stripReplyFallback } from "../src/daemon/commands.ts";

test("@list and @update", () => {
  assert.deepEqual(parseControlCommand("@list"), { type: "list" });
  assert.deepEqual(parseControlCommand("  @LIST  "), { type: "list" });
  assert.deepEqual(parseControlCommand("@update"), { type: "update" });
  assert.deepEqual(parseControlCommand("@update Builder"), { type: "update", target: "builder" });
  // only the first token is the target, so notices never repeat free text
  assert.deepEqual(parseControlCommand("@update  builder now "), { type: "update", target: "builder" });
  assert.deepEqual(parseControlCommand("@update all"), { type: "update" });
  assert.deepEqual(parseControlCommand("@update room"), { type: "update" });
  assert.deepEqual(parseControlCommand("@update: builder,"), { type: "update", target: "builder" });
  assert.deepEqual(parseControlCommand("@list now"), { type: "unknown" });
  assert.deepEqual(parseControlCommand("@list:"), { type: "list" });
});

test("direct messages", () => {
  assert.deepEqual(parseControlCommand("@Builder fix the tests"), { type: "direct", target: "builder", text: "fix the tests" });
  assert.deepEqual(parseControlCommand("@builder line1\nline2"), { type: "direct", target: "builder", text: "line1\nline2" });
  assert.deepEqual(parseControlCommand("@builder"), { type: "unknown" });
  assert.deepEqual(parseControlCommand("@builder   "), { type: "unknown" });
});

test("longest known name wins when names share a prefix", () => {
  const names = ["build", "Build Bot"];
  assert.deepEqual(parseControlCommand("@build bot run", { names }), { type: "direct", target: "build bot", text: "run" });
  assert.deepEqual(parseControlCommand("@build run", { names }), { type: "direct", target: "build", text: "run" });
  assert.deepEqual(parseControlCommand("@builder run", { names }), { type: "direct", target: "builder", text: "run" });
  assert.deepEqual(parseControlCommand("@Build Bot", { names }), { type: "unknown" });
  assert.deepEqual(parseControlCommand("@İzmir go", { names: ["İzmir"] }), { type: "direct", target: "İzmir".toLowerCase(), text: "go" });
});

test("broadcast", () => {
  for (const w of ["@all", "@ALL", "@room", "@all:"]) {
    assert.deepEqual(parseControlCommand(`${w} good morning`), { type: "broadcast", text: "good morning" });
    assert.deepEqual(parseControlCommand(w), { type: "unknown" });
  }
  assert.deepEqual(parseControlCommand("@room hi", { mentionsRoom: true }), { type: "broadcast", text: "hi" });
  assert.deepEqual(parseControlCommand("hello everyone", { mentionsRoom: true }), { type: "broadcast", text: "hello everyone" });
  assert.deepEqual(parseControlCommand("@list", { mentionsRoom: true }), { type: "list" });
  // only "@room" is reserved; any other word is an ordinary agent name
  assert.deepEqual(parseControlCommand("@team hi"), { type: "direct", target: "team", text: "hi" });
});

test("@name: and @name, are addresses", () => {
  const names = ["builder"];
  assert.deepEqual(parseControlCommand("@builder: fix it", { names }), { type: "direct", target: "builder", text: "fix it" });
  assert.deepEqual(parseControlCommand("@Builder, fix it", { names }), { type: "direct", target: "builder", text: "fix it" });
  assert.deepEqual(parseControlCommand("@builder: fix it"), { type: "direct", target: "builder", text: "fix it" });
  assert.deepEqual(parseControlCommand("@builder,"), { type: "unknown" });
  assert.deepEqual(parseControlCommand("@builder:x go", { names }), { type: "direct", target: "builder:x", text: "go" });
});

test("explicit @name wins over a room mention", () => {
  assert.deepEqual(parseControlCommand("@builder secret", { mentionsRoom: true, names: ["builder"] }), { type: "direct", target: "builder", text: "secret" });
  assert.deepEqual(parseControlCommand("@builder secret", { mentionsRoom: true }), { type: "direct", target: "builder", text: "secret" });
});

test("reserved room names are not addressable", () => {
  assert.deepEqual(parseControlCommand("@control hi"), { type: "unknown" });
  assert.deepEqual(parseControlCommand("@system hi"), { type: "unknown" });
});

test("unknown", () => {
  assert.deepEqual(parseControlCommand("hello"), { type: "unknown" });
  assert.deepEqual(parseControlCommand(""), { type: "unknown" });
  assert.deepEqual(parseControlCommand("@"), { type: "unknown" });
  assert.deepEqual(parseControlCommand("email me@example.org"), { type: "unknown" });
});

test("stripReplyFallback", () => {
  assert.equal(stripReplyFallback("> <@bot:example.org> [builder] done\n> more\n\nthanks"), "thanks");
  assert.equal(stripReplyFallback("plain text "), "plain text");
  assert.equal(stripReplyFallback("> only quote"), "> only quote");
  assert.equal(stripReplyFallback("> my quote\n\nmy answer"), "> my quote\n\nmy answer");
  assert.equal(stripReplyFallback("> quoted\n\nanswer", "<mx-reply><blockquote>q</blockquote></mx-reply>answer"), "answer");
});
