# Architecture and module ownership

```
Matrix homeserver (any) ── encrypted space
   ├─ one room per agent
   ├─ control room   status lines, @agent / @all / @list / @update, replies to agent messages
   └─ system room    daemon notices only
          │  Matrix client-server API (bot account, E2EE via matrix-bot-sdk + Rust crypto)
   bridge daemon (src/daemon)
          │  agent protocol (docs/reference/protocol.md): Unix socket or encrypted WebSocket
   agents: JS SDK (clients/js), Python SDK (clients/python), MCP adapter (adapters/mcp), anything else
```

## Config (env file, see [configuration.md](../guide/configuration.md))

All settings come from one env file (default `$XDG_CONFIG_HOME/mxagent/bridge.env`,
override with `MXA_CONFIG`) plus `MXA_*` environment variables, which win over the file.
State lives in `$XDG_STATE_HOME/mxagent/` (override `MXA_STATE_DIR`, from the environment or the
config file): `state.json`, `crypto/`, `sync.json`, `replay.log` and, between `mxagentctl login-sso`
and the next start, `sso-session.json`. The config directory holds the remote machine secrets
(`machines`).

| Key | Meaning |
|---|---|
| `MXA_HOMESERVER` | client API base URL |
| `MXA_BOT_USER` | bot user id |
| `MXA_BOT_PASSWORD` | optional; alternatives: `mxagentctl login-password` (prompt) or `mxagentctl login-sso` |
| `MXA_OWNER` | the only user whose messages are accepted |
| `MXA_SPACE_ID` | space that holds all rooms |
| `MXA_CONTROL_ROOM_ID` | control room (optional; created if missing) |
| `MXA_SOCKET_PATH` | Unix socket (default `$XDG_RUNTIME_DIR/mxagent.sock`, else `<stateDir>/bridge.sock`) |
| `MXA_WS_LISTEN` | e.g. `127.0.0.1:8640` (optional; enables WebSocket + `/health`) |
| `MXA_TRUST_PROXY_HEADER` | `none` (default), `cf-connecting-ip` or `x-forwarded-for`: header that holds the client address for rate limits |
| `MXA_RECOVERY_KEY` | only temporarily, to automate `mxagentctl cross-sign` (otherwise prompted) |
| `MXA_MAX_ATTACHMENT_MB` | default 25, at most 45 |
| `MXA_APPROVAL_TTL_MINUTES` | approval expiry, 1–1440, default 15 |
| `MXA_LOG_LEVEL` | `debug` / `info` (default) / `warn` / `error` |

## Modules (one owner each; talk only through the listed interfaces)

| Path | Responsibility |
|---|---|
| `src/protocol/messages.ts` | wire types (frozen contract) |
| `src/protocol/secure.ts` | handshake + AES-GCM framing (pure functions, no I/O) |
| `src/daemon/config.ts` | load + validate env config, paths |
| `src/daemon/state.ts` | persisted state (rooms, control/system room ids, bot trust anchor, pinned owner key, session token), durable atomic writes |
| `src/daemon/log.ts` | leveled logger, never logs message bodies or secrets |
| `src/daemon/matrix.ts` | MatrixClient setup, login, crypto store, decrypt hook exposing sender device/curve key, persistent replay protection (`replay.log`), send guard (encrypted room, only bot and owner, every device of owner and bot cross-signed; room keys only to those devices), send helpers incl. "hold until owner joined" |
| `src/daemon/trust.ts` | owner verification chain (anchored bot master → bot USK → owner master (pinned) → owner SSK → device) |
| `src/daemon/rooms.ts` | create/ensure encrypted rooms in the space, system/control room (safety check for a configured control room), per-room display name, remove room |
| `src/daemon/registry.ts` | connected agents (name, instance, machine, version, link), name rules and reserved names, replace/reject logic, liveness, new-room quota per machine |
| `src/daemon/commands.ts` | pure parser for owner commands in the control room |
| `src/daemon/machines.ts` | remote machine secrets file (`<configDir>/machines`), locked atomic writes, re-read on change |
| `src/daemon/fingerprint.ts` | key fingerprint formatting (groups of four) |
| `src/daemon/router.ts` | inbound owner events → agents: room messages, control commands, replies (only to daemon messages of this run), broadcast, 👀/💤 receipts |
| `src/daemon/media.ts` | authenticated media download + attachment decryption, size limits |
| `src/daemon/polls.ts` | poll parsing (stable + unstable MSC3381 fields), sending polls, votes, control-room vote summaries, approvals (machine binding, expiry, cancel) |
| `src/daemon/reactions.ts` | sending reactions (unencrypted), forwarding owner reactions (verified / unverified), control-room reaction summaries |
| `src/daemon/updates.ts` | `@update` fan-out (staggered per machine), ✅/⚠️ completion tracking |
| `src/daemon/transport/link.ts` | `Connection` abstraction over socket / WebSocket, NDJSON framing |
| `src/daemon/transport/local.ts` | Unix socket server |
| `src/daemon/transport/websocket.ts` | HTTP server (`/health`) + WebSocket server, secure handshake, rate limit, connection caps, pings, dead-link cleanup |
| `src/daemon/agent-link.ts` | per-connection request handling (protocol requests → modules), heartbeat, request queue limits |
| `src/daemon/index.ts` | wiring + startup/shutdown |
| `cli/mxagentctl.ts`, `cli/commands/` | admin CLI (`node cli/mxagentctl.ts` or `npm run ctl --`): `status`, `login-password`, `login-sso`, `cross-sign [device]`, `add-machine <name> --url`, `remove-machine`, `list-machines`, `remove-room`, `reset-owner-pin` (commands that write the state file refuse to run while the daemon is running) |
| `clients/js/` | JS/TS SDK (zero dependencies, Node ≥ 22) |
| `clients/python/` | Python SDK (stdlib + `cryptography`; `websockets` for remote mode) |
| `adapters/mcp/` | MCP server exposing the protocol as tools + an inbox (works with any MCP host) |
| `examples/` | small agents using the SDKs, health check script |
| `deploy/` | systemd units, Dockerfile, compose, reverse-proxy notes |
| `test/` | `node --test` unit tests (no network) |
| `docs/guide/`, `docs/reference/` | user guides and technical reference |
