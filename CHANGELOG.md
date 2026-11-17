# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

For protocol details, migration notes and implementation changes see the
[technical changelog](docs/reference/changelog-technical.md).

## [Unreleased]

## [1.0.1] - 2026-11-17

### Security

- Update the WebSocket library `ws` to 8.21.0. Older versions could be crashed by a peer sending many
  tiny message fragments, which affected the remote agent port.
- Pin patched versions of `form-data`, `qs` and `tough-cookie`, which the Matrix SDK pulls in.

## [1.0.0] - 2026-11-17

First public release.

### Added

- Talk to each AI agent in its own end-to-end encrypted room, grouped in a Matrix space.
- A control room with status updates from all agents and the commands `@agent`, `@all` (or `@room`),
  `@list` and `@update`. Replies to an agent's messages in the control room go to that agent.
- Approval requests: agents ask before risky steps and you answer Allow or Deny from your phone.
  Unanswered requests expire after 15 minutes (configurable) and count as Deny; agents can withdraw
  a request they no longer wait for. Each poll uses fresh random answer ids, and an agent cannot
  reuse a request id that is still pending.
- Polls in both directions, and reactions as delivery receipts (👀 delivered, 💤 not delivered).
  Your reactions reach agents as hints, marked verified only when they were encrypted.
- Send images, files, audio, video and locations to your agents.
- Only messages from your own verified devices are accepted. The bot's identity is anchored with
  `mxagentctl cross-sign`, yours is pinned on first use, and replayed messages are dropped, even
  after a restart. Unencrypted attachments are refused.
- The daemon only sends into rooms that are encrypted and contain just you and the bot, and only
  while all sessions of both accounts are cross-signed. Room keys go only to those sessions.
- Agents on other machines connect over a link that is encrypted end to end, with one secret per
  machine, login rate limits (also for logins that time out or are aborted) and connection caps.
  A wrong or revoked secret stops the agent; a lockout or a full server only tells it to try again
  later, and it reconnects on its own after a minute or so.
- An MCP adapter for any MCP host, plus JavaScript and Python SDKs and examples, including one for
  terminal programs. Agents detect dead connections and reconnect on their own.
- `mxagentctl` for login (password or SSO, also on headless servers), cross-signing, managing
  remote machines and rooms, and checking the setup. `cross-sign` signs only a device whose key
  matches what the daemon recorded at startup, asks you to compare fingerprints when it cannot check
  a key itself (or takes `--master-fingerprint` / `--device-fingerprint`), and `-y` never skips those
  checks.
- A health endpoint, systemd units, a Docker setup and reverse-proxy examples for running the daemon.
- Licensing: daemon and CLI under AGPL-3.0-or-later; client libraries, MCP adapter, examples and protocol
  specification under Apache-2.0 (see LICENSING.md).

[Unreleased]: https://github.com/Rockykln/mxagent/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/Rockykln/mxagent/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Rockykln/mxagent/releases/tag/v1.0.0
