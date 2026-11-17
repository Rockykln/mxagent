// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
// Wire types of the agent protocol. Source of truth: docs/reference/protocol.md (keep both in sync).

export type AttachmentKind = "image" | "file" | "video" | "audio";

export interface Attachment {
  name: string;
  mime: string;
  kind: AttachmentKind;
  data: string; // base64
  size: number;
}

/** Request ids are integers in the JSON safe range (0 .. 2^53 - 1). */
export type RequestId = number;

// Agent -> daemon
export type AgentRequest =
  | { type: "hello"; id?: RequestId; name: string; client?: string; version?: string; instance?: string }
  | { type: "reply"; id?: RequestId; text: string }
  | { type: "status"; id?: RequestId; text: string }
  | { type: "ask"; id?: RequestId; text: string }
  | { type: "poll"; id?: RequestId; question: string; options: string[] }
  | { type: "vote"; id?: RequestId; answer: string | number }
  | { type: "react"; id?: RequestId; emoji: string }
  | { type: "approval_request"; id?: RequestId; request_id: string; title: string; detail?: string }
  | { type: "approval_cancel"; id?: RequestId; request_id: string }
  | { type: "updated"; id?: RequestId; from: string }
  | { type: "update_failed"; id?: RequestId; error: string };

/** Interval of daemon -> agent `heartbeat` lines on every link. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** A client treats a link without any inbound frame for this long as dead. */
export const LINK_DEAD_AFTER_MS = 75_000;

// Daemon -> agent
export type MessageKind = "text" | "attachment" | "location" | "poll_started" | "poll_answer" | "reaction";

export interface InboundMessage {
  type: "message";
  kind: MessageKind;
  text: string;
  sender: string;
  via: "room" | "control";
  event_id?: string;
  attachment?: Attachment;
  lat?: number;
  lon?: number;
  accuracy_m?: number;
  description?: string;
  question?: string;
  options?: string[];
  choices?: string[];
  emoji?: string;
  target_text?: string;
  verified?: boolean; // kind "reaction": true only if encrypted and trust-checked
}

export type DaemonMessage =
  | { type: "welcome"; id?: RequestId; room_id: string }
  | InboundMessage
  | { type: "approval_result"; request_id: string; decision: "allow" | "deny" }
  | { type: "update" }
  | { type: "heartbeat" }
  | { type: "ok"; id: RequestId; held?: boolean }
  | { type: "error"; id?: RequestId; error: string };
