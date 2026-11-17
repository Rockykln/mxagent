# Technical changelog

This is the technical companion of the user-level [CHANGELOG.md](../../CHANGELOG.md). It lists
protocol, security and implementation details for each release.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries that affect the wire protocol ([protocol.md](protocol.md)) are marked **[protocol]**.
Entries that require agents or SDKs to be updated are marked **[agents]**.

## [Unreleased]

## [1.0.1] - 2026-11-17

Daemon only; clients, MCP adapter and protocol are unchanged (still 1.0.0).

### Security

- `ws` 8.18.3 → 8.21.0 (GHSA for memory exhaustion from tiny fragments and data chunks, and an
  uninitialized memory disclosure). The remote agent WebSocket server was exposed to the first one
  before authentication.
- `package.json` `overrides` for transitive dependencies of `matrix-bot-sdk` 0.8.0 (via `request`):
  `form-data` ^2.5.6 (predictable multipart boundary, CRLF injection in field names), `qs` ^6.16.0
  (DoS via array limits and `isBuffer`), `tough-cookie` ^4.1.3 (prototype pollution). Checked against
  `request` with query strings, cookie jars, multipart and JSON bodies.
- Not changed: `request` 2.88.2 itself has no fixed release (SSRF via cross-protocol redirects); it is
  only used for requests to the configured homeserver. `uuid` 3.4.0 stays because `request` imports
  `uuid/v4`, which newer versions removed; the advisory concerns v3/v5/v6 with a caller buffer, which
  `request` does not use. Both remain until the Matrix SDK drops `request`.

## [1.0.0] - 2026-11-17

First public release.

### Added

#### Daemon: Matrix side
- Matrix bot daemon (Node.js ≥ 22.18, TypeScript via type stripping, no build step) using
  `matrix-bot-sdk` with the Rust crypto store (SQLite); works with any homeserver that supports
  end-to-end encryption, cross-signing, spaces and authenticated media (`/_matrix/client/v1/media`).
- Login order: session in `state.json` → `sso-session.json` in the state directory (written by
  `mxagentctl login-sso`, must belong to `MXA_BOT_USER`, deleted after import) → password login with
  `MXA_BOT_PASSWORD`. Homeserver URLs with query or fragment are rejected; plain `http://` to a
  non-local host gives a warning.
- One end-to-end encrypted room per agent inside the configured space (room version 11, Megolm,
  join rule `invite`, history visibility `invited`, guests forbidden, owner invited and re-invited to
  reused rooms), plus a control room and a system room for daemon notices. A configured
  `MXA_CONTROL_ROOM_ID` is checked (encrypted, invite-only, no guests, only bot and owner); an unsafe
  room is ignored.
- Owner verification for every inbound event: only events decrypted by the sync loop, room key not
  forwarded, crypto-attributed user equal to the sender, sender equal to `MXA_OWNER`, and a full
  cross-signing chain: bot master key equal to the locally anchored key → bot user-signing key →
  owner master key (pinned on first use) → owner self-signing key → device (matching `user_id`,
  `device_id` and Curve25519 key). Cross-signing keys must carry exactly one ed25519 key, the right
  `user_id` and usage. Keys are cached for 60 s and dropped when the sync reports a device-list change
  of owner or bot; a failing check re-queries once. Rejections are reported as `Not delivered: <reason>.`
- Bot trust anchor: `mxagentctl cross-sign` stores the bot's verified master key in `state.json`
  (`botMasterKey`). Without it, or if the homeserver publishes another bot master key, no owner
  event is trusted ("bot identity not anchored; run mxagentctl cross-sign").
- Persistent replay protection: every decrypted event is identified by a hash over room id, Megolm
  session id (padding stripped) and the Megolm message index parsed from the ciphertext, so a
  re-encoded ciphertext (other base64 padding) is still recognised; events without a parsable index
  are dropped. Known keys are dropped before dispatch; a key is recorded only after the owner check
  passed and before delivery, so other users cannot push owner keys out of the bounded store. Keys
  are persisted in `replay.log` (append-only, mode 0600, `O_NOFOLLOW`, fsync per key, bounded to
  50 000 entries with atomic compaction), so replayed events are dropped even after a restart. The log
  fails closed: an unreadable, non-regular or malformed log stops the daemon at startup, and a failed
  append means the event is not delivered ("replay log cannot be written"). Events from before the
  daemon start (minus 5 s) are ignored.
- Send guard: every encrypted send requires that the room is known to be Megolm-encrypted, that
  its joined members are exactly bot and owner (cached 30 s, reset on membership changes) and that a
  device audit finds every device of owner and bot cross-signed (owner devices by the owner's
  self-signing key under the pinned or bot-verified master key, bot devices by the bot's self-signing
  key under the anchored master key; the daemon's own device excepted). Otherwise the send is refused,
  logged, and reported once per room in the system room ("Refusing to send to <room>: <reason>") when
  that room can still be sent to; an unverified device blocks every send, so before `cross-sign` the
  daemon sends nothing at all. A failing key query holds the message
  instead. Backstop: the crypto layer's room-key sharing is wrapped and drops every room key not
  encrypted to the signed curve25519 key of a device the audit allowed (other users, unverified
  devices, forged keys under an allowed id); key forwards the crypto layer queues itself pass the
  same filter, and incoming room-key and secret requests are ignored; encryption is refused while
  that wrapper is not in place. Plain `m.room.message` events are never delivered to agents.
- Hold queue: messages to a room the owner has not joined yet (or while the membership lookup
  fails) are held in memory, at most 50 per room (dropping older ones is reported), and sent in order
  on the owner's join or by a retry with backoff (2 s doubling to 5 min).
- Attachments (image, file, video, audio): authenticated download with size checks
  (`info.size`, `Content-Length`, running total, decrypted size), decryption of encrypted
  attachments, `MXA_MAX_ATTACHMENT_MB` (default 25, at most 45), 60 s timeout; strict `mxc://`
  parsing. Unencrypted attachments (plain `url`, not hash-checked) are refused ("unencrypted
  attachment refused"). Passed to the agent in memory, never written to disk by the daemon. A failed download is
  answered with 💤 and a notice.
- Locations (`m.location`, geo URI) forwarded with coordinates, accuracy and description; text edits
  forwarded as `[edited] …`, edits of attachments and locations ignored; reply fallbacks stripped.
- Polls (stable and unstable MSC3381 event types): owner polls forwarded as `poll_started`, agent
  polls rendered for both client generations, owner answers mapped to option texts.
- Approvals: Allow/Deny poll in the agent room plus a mention in the control room; the two answer ids
  are fresh random 128-bit values per poll, so a vote cannot be moved to another approval; first valid
  owner vote wins, an owner poll end counts as deny; results go only to the requesting agent name on the
  requesting machine. Pending approvals expire after `MXA_APPROVAL_TTL_MINUTES` (1–1440, default 15)
  or when more than 200 are pending: the agent gets `deny`, the poll is ended and `Expired: …` is
  posted. Late votes get a "Vote not applied …" notice. Approvals resolve at most once.
- Reactions: 👀 on every delivered owner message, 💤 when it was not delivered, agent reactions on the
  owner's latest message, owner reactions on daemon messages of the current run forwarded to the
  agent with a `verified` flag (true only for encrypted reactions that passed the owner check).
  Reaction keys are filtered (length, quotes, control and format characters except ZWJ). Reactions
  never drive decisions; reacted-to events are never fetched from the homeserver.
- Control room: commands `@<agent>` (longest matching name, also `@name:` / `@name,`), `@all` /
  `@room` / room mentions, `@list`, `@update [agent|all]`; unknown input gets a hint in the system
  room. Replies are routed only to agents behind daemon-sent control-room messages of the current run
  (last 1000 ids, never looked up on the homeserver); an explicit leading command always wins; edits
  are never replies. Events are processed one at a time per room.
- Control-room aggregation: all agents share one bot user and Matrix allows one identical reaction or
  poll vote per user and event, so the daemon posts and edits one summary line per emoji or option
  (a changed vote moves the name).
- `@update`: fan-out to the targeted agents, machines in parallel and agents on one machine 8 s apart;
  ✅ when all report success with one common version, ⚠️ on failure, timeout (60 s + 10 s per agent)
  or mixed versions. A new command replaces a running one.
- Agent registry: names compared case-insensitively (NFC + lower case); the same `instance` from the
  same machine replaces its old link, a dead link is replaced, any other live agent with the same
  name is rejected. Reserved names and a per-machine quota of 20 new rooms per daemon run (see
  protocol below).
- State written durably: temp file created exclusively with mode 0600 (no symlink following), fsync,
  rename, directory fsync. New state directories get mode 0700. At every start the daemon records its
  device's ed25519 key in `state.json` (`deviceEd25519`) as the local reference for `cross-sign`.
- `GET /health` on the WebSocket listener: 200 `ok` while the sync loop completed a sync within the
  last 180 s, else 503 `stale`.
- Logging never includes message bodies, captions, poll content, attachment data, tokens, passwords,
  machine secrets or recovery keys.

#### Agent protocol and transports **[protocol]**
- NDJSON agent protocol ([protocol.md](protocol.md), version 1.0): request ids (integers), exactly one
  `ok` / `error` / `welcome` per request with id, in-order processing per link, typed inbound
  messages (`text`, `attachment`, `location`, `poll_started`, `poll_answer`, `reaction` with
  `verified`), `approval_result`, `update`, `heartbeat`.
- Requests: `hello`, `reply`, `status`, `ask`, `poll`, `vote` (option text or 1-based number, as
  integer or string), `react`, `approval_request` (`detail` must be a string), `approval_cancel`,
  `updated`, `update_failed`. An `approval_request` whose `request_id` is still pending on the same
  link gets `error` "request_id already pending". Field limits: texts 1–16 000 characters, poll question 500, 2–20
  options of 200, request ids 200, reaction keys 32.
- Agent names: NFC, `^[\p{L}\p{N}._-]{1,64}$`; reserved: `all`, `room`, `list`, `update`,
  `control`, `system`, all lower-cased `Object.prototype` property names and `prototype`.
- New-name quota: each machine (`local` for the Unix socket) may create rooms for at most 20 new agent
  names per daemon run.
- Keepalive: `heartbeat` line every 30 s on every link; clients treat 75 s of silence as a dead link.
  WebSocket pings every 30 s, links without pong for 75 s are dropped.
- Unix socket transport (mode 0600, umask 0177, parent directory 0700; a stale socket file is only
  removed when nothing answers on it).
- WebSocket transport for remote agents with mutual authentication and end-to-end encryption between
  agent and daemon: per-machine secret (`^[A-Za-z0-9_-]{32,256}$`, used verbatim, never transmitted),
  HKDF-SHA256 key schedule, HMAC-SHA256 challenge–response, machine name bound into both proofs and
  the session key, AES-256-GCM frames with per-direction counters (replay, reorder and gap
  protection). Unknown machine names receive a challenge as well (no name enumeration).
- Limits: lines up to 64 MiB, inbound WebSocket messages up to 1 MiB (close 1009), at most 256 or
  8 MiB of queued requests per link, 256 MiB unread output.
- Abuse protection: 10 failed handshakes, or 30 handshakes that time out or are closed early, per
  10 minutes per IPv4 address or IPv6 /64 lock the address out (machines that authenticated from it
  within 24 h still pass), 8 unfinished handshakes per address and 256 in total, 3 s to the handshake
  `hello` and 10 s for the whole handshake, 512 connections in total, 64 links per machine.
- Close codes: **4003** only when authentication fails (wrong proof, unknown machine, broken
  handshake); clients treat it as fatal. **4029** "try later" for every transient refusal (lockout,
  caps, handshake timeout or early close); clients must not treat it as fatal and reconnect after at
  least 60 s with jitter. A peer that ignores the close frame is dropped after 2 s. `MXA_TRUST_PROXY_HEADER`
  (`none`, `cf-connecting-ip`, `x-forwarded-for` right-most entry) selects the one header that holds
  the client address behind a proxy.
- Machine secrets in `<configDir>/machines` (mode 0600, written atomically under a lock file whose
  stale-lock takeover is atomic (rename plus inode re-check), malformed lines kept and logged); the daemon re-reads the file on change and closes links of removed
  or changed machines within 30 s.
- Published test vectors ([protocol-test-vectors.md](protocol-test-vectors.md)) for independent
  implementations.

#### Clients and adapters **[agents]**
- JavaScript SDK (`clients/js`, npm package `mxagent`, plain ESM, no dependencies, TypeScript
  declarations): local and remote mode from options, environment or `client.env`, strict settings
  validation (`ConfigError`), auto-reconnect with jittered backoff, request timeouts, dead-link
  detection (`deadLinkTimeoutMs`, 75 s), authentication failures (close 4003) are fatal unless
  `retryAuthFailures`, close 4029 is never fatal and reconnects after 60–90 s, `requestApproval` with `timeoutMs` / `AbortSignal` that sends
  `approval_cancel`, linear-time line splitting, `mxagent/secure` export.
- Python SDK (`clients/python`, package `mxagent`, asyncio, `cryptography`; `websockets` via the
  `remote` extra): same behaviour with `connect_timeout`, `dead_link_timeout`, `retry_auth_failures`,
  `TryLaterError` (a `NotConnectedError`) for close 4029 with a 60–90 s reconnect delay,
  `request_approval(timeout=)` with `approval_cancel` on timeout or cancellation, linear line
  buffering, settings validation.
- MCP adapter (`adapters/mcp`): stdio MCP server for any MCP host; inbound messages are queued in an
  inbox (`bridge_inbox`, `bridge_wait` long-poll, `max` / `remaining`, at most 500 messages),
  outbound actions as tools (`bridge_reply`, `bridge_status`, `bridge_ask` with optional wait for a
  text answer, `bridge_poll`, `bridge_vote`, `bridge_react`, `bridge_request_approval` with timeout
  and cancel → `approval_cancel`). Reactions are marked verified / unverified. Attachments are saved
  to a 0700 directory (files 0600) and deleted after `MXA_ATTACHMENT_RETENTION_DAYS` (default 7).
  Agent names are checked against the daemon's rules at startup; a rejected registration or machine
  credential stops retries, a 4029 refusal does not (reconnect after 60–90 s, reported in tool errors).
- Examples: echo agent, approval gate for shell commands, bridge for terminal programs without MCP
  support, Python echo and poll agents, `healthcheck.sh`.

#### Operations
- `mxagentctl` (run as `node cli/mxagentctl.ts` or `npm run ctl --`; exit codes 0 ok, 1 error,
  2 usage): `status`, `login-password [--force]`, `login-sso [--homeserver URL] [--port N] [--force]`,
  `cross-sign [-y] [--master-fingerprint <fp>] [--device-fingerprint <fp>] [device]`, `add-machine <name> --url` (writes `client-<name>.env`, never prints
  the secret), `remove-machine`, `list-machines`, `remove-room`, `reset-owner-pin [-y]`.
  Commands that write the state file refuse to run while the daemon answers on its socket;
  `--force` logins log the replaced device out.
- `cross-sign` verifies the bot's cross-signing identity from secret storage
  (`m.secret_storage.v1.aes-hmac-sha2`) with the recovery key, asked for with hidden input
  (`MXA_RECOVERY_KEY` for automation), stores the bot master key as trust anchor and signs the
  device. The device's published ed25519 key must match `state.deviceEd25519`; a different key is
  refused. Without that record its fingerprint must be confirmed in a terminal or given with
  `--device-fingerprint`. If the master key's private part is not in secret storage, the master
  fingerprint must be confirmed in a terminal or given with `--master-fingerprint`. `-y` only skips
  the device question when the key matches the daemon's record or `--device-fingerprint`; it never
  covers the master key. Setup order: login → start the daemon once → stop → `cross-sign` → start.
- Configuration from one env file plus `MXA_*` environment variables; `MXA_STATE_DIR` is also read
  from the config file.
- Hardened systemd system unit (state and config directories 0700) and a user unit; multi-stage
  Dockerfile (base image pinned by digest, non-root, native crypto library load-checked at build
  time, `LICENSE` and `LICENSING.md` included, writable config volume); Compose file with health
  check; reverse-proxy examples (nginx overwriting `X-Forwarded-For` and clearing
  `CF-Connecting-IP`, Caddy); `examples/healthcheck.sh` with state-change-only webhook notifications.
- CI: type check and Node tests on Node 22.18.0, 22 and 24 including Python end-to-end tests
  (`MXA_REQUIRE_PY_E2E=1`), Python tests on 3.10 and 3.13, actions pinned by commit SHA.
- Licensing: AGPL-3.0-or-later for daemon and CLI, Apache-2.0 for clients, adapter, examples and the
  protocol specification; SPDX headers plus `REUSE.toml`.

### Security
- See the [security guide](../guide/security.md) for the threat model and residual risks. In short:
  Matrix traffic is end-to-end encrypted; the daemon necessarily sees plaintext; the bot identity is
  anchored locally and the owner identity pinned, so the homeserver cannot swap identities, replay
  events or receive room keys through extra room members or devices; reply relations and plain reactions remain
  unencrypted metadata; remote agent links are encrypted end to end with the machine secret, so
  TLS-terminating proxies or tunnels only see ciphertext; the recovery key is not stored.

[Unreleased]: https://github.com/Rockykln/mxagent/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/Rockykln/mxagent/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Rockykln/mxagent/releases/tag/v1.0.0
