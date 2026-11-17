// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure parser for owner text in the control room (see docs/reference/protocol.md).

import { agentKey, RESERVED_NAMES } from "./registry.ts";

export type ControlCommand =
  | { type: "direct"; target: string; text: string } // target is the agent key
  | { type: "broadcast"; text: string }
  | { type: "list" }
  | { type: "update"; target?: string } // agent key, absent = all agents
  | { type: "unknown" };

export interface ParseOptions {
  /** `content["m.mentions"].room === true` on the event; ignored when the text starts with an explicit `@` command. */
  mentionsRoom?: boolean;
  /** Known agent names; lets `@<name> text` resolve to the longest matching name. */
  names?: Iterable<string>;
}

const BROADCAST_WORDS = new Set(["all", "room"]);

/**
 * Removes the quoted reply fallback older clients put in front of replies. Only a fallback is removed (it starts
 * with "> <@user>", or the HTML body carries <mx-reply>); the owner's own "> quote" lines stay.
 */
export function stripReplyFallback(body: string, formattedBody?: unknown): string {
  const lines = body.split("\n");
  const isFallback = lines[0]?.startsWith("> <@") || (typeof formattedBody === "string" && formattedBody.includes("<mx-reply>"));
  if (!isFallback) return body.trim();
  let i = 0;
  while (i < lines.length && lines[i].startsWith(">")) i++;
  if (i < lines.length && lines[i].trim() === "") i++;
  return lines.slice(i).join("\n").trim();
}

/** Length of an address suffix after a name: "" (end), whitespace, or ":"/"," then whitespace or end. */
function addressEnd(src: string, at: number): number {
  const next = src.charAt(at);
  if (next === "" || /\s/.test(next)) return at;
  if ((next === ":" || next === ",") && (at + 1 === src.length || /\s/.test(src.charAt(at + 1)))) return at + 1;
  return -1;
}

function matchName(rest: string, names: Iterable<string> | undefined): { key: string; text: string } | null {
  const src = rest.normalize("NFC");
  let best: { key: string; len: number; end: number } | null = null;
  for (const n of names ?? []) {
    const name = n.normalize("NFC").trim();
    if (!name || src.length < name.length) continue;
    if (agentKey(src.slice(0, name.length)) !== agentKey(name)) continue;
    const end = addressEnd(src, name.length);
    if (end < 0) continue;
    if (!best || name.length > best.len) best = { key: agentKey(name), len: name.length, end };
  }
  if (!best) return null;
  return { key: best.key, text: src.slice(best.end).trim() };
}

/** First word after "@", without a trailing ":" or ",", plus the remaining text. */
function firstWord(text: string): { word: string; rest: string } | null {
  const m = text.match(/^@(\S+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { word: m[1].replace(/[:,]$/, ""), rest: (m[2] ?? "").trim() };
}

export function parseControlCommand(body: string, opts: ParseOptions = {}): ControlCommand {
  const text = body.trim();
  const first = firstWord(text);
  if (first) {
    const word = agentKey(first.word.normalize("NFC"));
    if (word === "list") return first.rest ? { type: "unknown" } : { type: "list" };
    if (word === "update") {
      // only the first token counts, so hints never repeat free text
      const target = first.rest.split(/\s+/)[0]?.replace(/[:,]$/, "");
      if (!target) return { type: "update" };
      const key = agentKey(target.normalize("NFC"));
      return BROADCAST_WORDS.has(key) ? { type: "update" } : { type: "update", target: key };
    }
    if (BROADCAST_WORDS.has(word)) return first.rest ? { type: "broadcast", text: first.rest } : { type: "unknown" };
    if (RESERVED_NAMES.has(word)) return { type: "unknown" };
    // an explicit @name wins over a room mention
    const named = matchName(text.slice(1), opts.names);
    if (named) return named.text ? { type: "direct", target: named.key, text: named.text } : { type: "unknown" };
    return first.rest ? { type: "direct", target: word, text: first.rest } : { type: "unknown" };
  }
  if (opts.mentionsRoom && text) return { type: "broadcast", text };
  return { type: "unknown" };
}
