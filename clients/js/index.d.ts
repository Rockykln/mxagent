// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from "node:events";

export declare const CLIENT_VERSION: string;

/** Base class of every error this library raises or emits. */
export declare class BridgeError extends Error {
  constructor(message?: string, options?: ErrorOptions);
}
/** Invalid or incomplete connection settings (thrown by `connect()` / `resolveOptions()`): bad URL, machine name or secret format, missing remote settings, non-positive timeouts. */
export declare class ConfigError extends BridgeError {}
/** No link to the daemon, it dropped while a request was pending, or it went silent (dead link). */
export declare class NotConnectedError extends BridgeError {}
/** The daemon (or the owner, for approvals with `timeoutMs`) did not answer in time. */
export declare class RequestTimeoutError extends BridgeError {}
/**
 * The secure WebSocket handshake failed or the daemon rejected the machine credentials (close 4003).
 * Rejected credentials and a daemon that cannot prove the secret close the agent unless `retryAuthFailures` is set.
 */
export declare class AuthenticationError extends BridgeError {
  /** True when retrying cannot help (wrong secret or machine, daemon failed to prove the secret). */
  fatal?: boolean;
}

export type AttachmentKind = "image" | "file" | "video" | "audio";

export interface Attachment {
  name: string;
  mime: string;
  kind: AttachmentKind;
  /** base64 */
  data: string;
  size: number;
}

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
}

export type Decision = "allow" | "deny";

export interface ApprovalResult {
  request_id: string;
  decision: Decision;
}

export interface ConnectOptions {
  /** Agent name; becomes the room name. */
  name: string;
  /** Unique per running agent process. Defaults to a random id generated once per process. */
  instance?: string;
  /** Client identifier sent in `hello`, e.g. "my-agent/1.0". */
  client?: string;
  /** Optional version string sent in `hello`. */
  version?: string;
  /**
   * Unix socket path. Env: MXA_SOCKET_PATH. Default: $XDG_RUNTIME_DIR/mxagent.sock, else
   * $MXA_STATE_DIR (or $XDG_STATE_HOME/mxagent)/bridge.sock. Passing it explicitly forces local mode.
   */
  socketPath?: string;
  /** WebSocket URL of the daemon (ws:// or wss://); selects remote mode and requires machine and secret. Env: MXA_URL */
  url?: string;
  /** Machine name (remote mode), `^[a-z0-9-]{1,32}$`. Env: MXA_MACHINE */
  machine?: string;
  /** Machine secret (remote mode), 32-256 base64url characters, used verbatim. Env: MXA_SECRET */
  secret?: string;
  /** Env file with MXA_* fallbacks. Default: $XDG_CONFIG_HOME/mxagent/client.env */
  configFile?: string;
  /** Reconnect automatically after the link drops. Default: true */
  reconnect?: boolean;
  /**
   * Keep reconnecting after the daemon rejected the credentials (close 4003; at most once per minute).
   * Default: false, the agent closes and rejects everything with AuthenticationError.
   * A "try later" refusal (close 4029: lockout, capacity, timeout) is never fatal: the agent emits a
   * NotConnectedError and reconnects after 60-90 s, regardless of this option.
   */
  retryAuthFailures?: boolean;
  /** Timeout for each request in milliseconds. Default: 30000 */
  requestTimeoutMs?: number;
  /** Remote mode: time allowed for the secure handshake before the link is closed and retried. Default: 10000 */
  handshakeTimeoutMs?: number;
  /** Close and reconnect a link that delivered nothing (not even a heartbeat) for this long. Default: 75000 */
  deadLinkTimeoutMs?: number;
}

export interface ResolvedOptions {
  name: string;
  instance: string;
  client: string;
  version: string | undefined;
  mode: "local" | "remote";
  socketPath: string | undefined;
  url: string | undefined;
  machine: string | undefined;
  secret: string | undefined;
  reconnect: boolean;
  retryAuthFailures: boolean;
  requestTimeoutMs: number;
  handshakeTimeoutMs: number;
  deadLinkTimeoutMs: number;
}

export interface ApprovalRequest {
  title: string;
  detail?: string;
  /** 1-200 characters. Defaults to a random UUID. */
  requestId?: string;
  /**
   * Bounds the wait for the owner's decision; rejects with RequestTimeoutError and sends
   * `approval_cancel`. Default: wait indefinitely.
   */
  timeoutMs?: number;
  /** Aborts the wait; rejects with `signal.reason` and sends `approval_cancel`. */
  signal?: AbortSignal;
}

export interface AgentEvents {
  message: [message: InboundMessage];
  approval_result: [result: ApprovalResult];
  update: [];
  connected: [info: { roomId: string }];
  disconnected: [];
  error: [error: Error];
}

export declare class Agent extends EventEmitter<AgentEvents> {
  constructor(opts: ConnectOptions);
  readonly name: string;
  readonly instance: string;
  readonly mode: "local" | "remote";
  /** True between `welcome` and the next disconnect. */
  readonly connected: boolean;
  readonly roomId: string | null;

  ready(): Promise<{ roomId: string }>;
  reply(text: string): Promise<{ held: boolean }>;
  status(text: string): Promise<void>;
  ask(text: string): Promise<void>;
  poll(question: string, options: string[]): Promise<void>;
  vote(answer: string | number): Promise<void>;
  react(emoji: string): Promise<void>;
  requestApproval(req: ApprovalRequest): Promise<Decision>;
  reportUpdated(from: string): Promise<void>;
  reportUpdateFailed(error: string | Error): Promise<void>;
  close(): void;
}

export declare function resolveOptions(opts: ConnectOptions): ResolvedOptions;
export declare function connect(opts: ConnectOptions): Agent;
