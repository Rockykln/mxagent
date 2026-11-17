# Configuration

The daemon and `mxagentctl` read one file of `KEY=value` lines. There is no other config format.
`mxagentctl` is run from the repository: `node cli/mxagentctl.ts <command>` or
`npm run ctl -- <command>`.

## Where the files are

| What | Default location | Change with |
|---|---|---|
| config file | `$XDG_CONFIG_HOME/mxagent/bridge.env` | `MXA_CONFIG` |
| config directory | the directory of the config file; holds `machines` | follows `MXA_CONFIG` |
| state directory | `$XDG_STATE_HOME/mxagent/` | `MXA_STATE_DIR` |

Without `XDG_CONFIG_HOME` / `XDG_STATE_HOME` the usual defaults `~/.config` and `~/.local/state`
apply. `MXA_CONFIG` only works in the process environment. `MXA_STATE_DIR` can be set in the
environment or in the config file (the environment wins).

## Minimal config

```sh
MXA_HOMESERVER=https://matrix.example.org
MXA_BOT_USER=@agents:example.org
MXA_OWNER=@alice:example.org
MXA_SPACE_ID=!AbCdEf:example.org
```

These four keys are required. Everything else has a sensible default. A missing config file is
fine if all required keys come from the environment (for example in a container).

Keep the file private: `chmod 600 bridge.env`. The daemon warns at startup if other users can
read it.

## File format

- One `KEY=value` per line. Blank lines and lines starting with `#` are ignored.
- `export KEY=value` is accepted, so the file can also be sourced by a shell.
- Values may be quoted with `'single'` or `"double"` quotes. Inside double quotes `\"`, `\\` and
  `\n` are unescaped.
- Variables set in the environment override the file. This lets you pass a secret for one
  command only, for example `MXA_RECOVERY_KEY`.

Details: [internals.md, config.ts](../reference/internals.md#srcdaemonconfigts).

## All settings

| Key | Default | Meaning |
|---|---|---|
| `MXA_HOMESERVER` | required | URL of the homeserver's client API, e.g. `https://matrix.example.org` (no query or fragment; plain `http://` to a non-local host gives a warning) |
| `MXA_BOT_USER` | required | the bot's Matrix id, e.g. `@agents:example.org` |
| `MXA_OWNER` | required | your Matrix id. Only your messages are accepted. Must differ from the bot |
| `MXA_SPACE_ID` | required | the space that holds all rooms, e.g. `!AbCdEf:example.org` |
| `MXA_BOT_PASSWORD` | — | bot password for the first login. Remove it after login |
| `MXA_CONTROL_ROOM_ID` | created on first start | use an existing room as the control room. It must be encrypted, invite-only, closed to guests and have only you and the bot as members; otherwise the daemon logs the problems and ignores the control room |
| `MXA_SOCKET_PATH` | `$XDG_RUNTIME_DIR/mxagent.sock` | socket for local agents. Without `XDG_RUNTIME_DIR`: `bridge.sock` in the state directory (the SDKs use the same fallback, but read `MXA_STATE_DIR` only from their own environment) |
| `MXA_WS_LISTEN` | off | `host:port` or just `port` (then `127.0.0.1`). Enables remote agents and `GET /health` |
| `MXA_TRUST_PROXY_HEADER` | `none` | which request header holds the client address for the handshake rate limits: `none` (the socket address), `cf-connecting-ip` (Cloudflare Tunnel or proxy) or `x-forwarded-for` (right-most entry, e.g. nginx, Caddy). Only that header is read; a port or `[...]` brackets are stripped, an invalid value falls back to the socket address. Set it only when the proxy overwrites that header and the WebSocket port is not reachable directly. `MXA_TRUST_PROXY_HEADERS` (plural) is rejected to catch typos |
| `MXA_MAX_ATTACHMENT_MB` | `25` | largest attachment forwarded to agents (more than 0, at most 45; fractions allowed). The cap keeps the base64-encoded file below the clients' 64 MiB line limit |
| `MXA_APPROVAL_TTL_MINUTES` | `15` | how long an approval request waits for your vote (whole minutes, 1–1440). When it expires, the agent gets `deny`, the poll is ended and "Expired: …" is posted |
| `MXA_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `MXA_RECOVERY_KEY` | — | only for automating `mxagentctl cross-sign`, which otherwise asks for the key. Never keep it in the file (the daemon warns if it is set) |
| `MXA_CONFIG` | see above | path of the config file (environment only) |
| `MXA_STATE_DIR` | see above | path of the state directory (environment or config file) |

Message bodies, tokens and secrets are never logged, at any log level.

Bind `MXA_WS_LISTEN` to `127.0.0.1` and put a TLS reverse proxy in front of it. Behind a proxy all
connections come from the proxy's address. With `MXA_TRUST_PROXY_HEADER=none` all clients then share
one rate limit: ten failed handshakes lock out every machine that has not authenticated from that
address within the last 24 hours, and a single client can hold the eight unfinished-handshake slots
of that address. The daemon logs a warning on the first connection from a loopback or private
address while the setting is `none`. Set `MXA_TRUST_PROXY_HEADER` to the header your proxy sets, and
make sure the proxy overwrites it instead of passing on a value from the client (the
[nginx example](../../deploy/README.md#nginx) does this). See
[getting-started.md, remote agent](getting-started.md#connect-a-remote-agent).

## Agent settings

Agents are configured in their SDK or adapter, not in `bridge.env`. A local agent needs nothing
but a name. A remote agent needs three values:

| Key | Example | Meaning |
|---|---|---|
| `MXA_URL` | `wss://bridge.example.org` | WebSocket URL of the daemon (through the TLS proxy) |
| `MXA_MACHINE` | `laptop` | machine name registered with `mxagentctl add-machine` |
| `MXA_SECRET` | — | machine secret created by `mxagentctl add-machine` (never printed) |

`mxagentctl add-machine <name> --url wss://…` writes all three into a file `client-<name>.env`.
Install it on the agent machine as `$XDG_CONFIG_HOME/mxagent/client.env` (mode 0600), or set the
variables in the environment. A local agent can set `MXA_SOCKET_PATH` the same way if the daemon
uses a non-default socket.
All options: [`clients/js/README.md`](../../clients/js/README.md),
[`clients/python/README.md`](../../clients/python/README.md),
[`adapters/mcp/README.md`](../../adapters/mcp/README.md).

## What is in the state directory

The state directory lets the daemon resume after a restart. **Back it up and protect it like a
password**: it contains the bot's login and encryption keys.

| Path | Content |
|---|---|
| `state.json` | bot login (access token, device id), room ids, the bot's master key stored by `mxagentctl cross-sign` (trust anchor), the ed25519 key of the daemon's device (recorded at every start, checked by `cross-sign`), your pinned cross-signing key |
| `crypto/` | the bot device's encryption keys. Losing it means a new device and verifying the bot again |
| `sync.json` | Matrix sync position |
| `replay.log` | ids (encryption session and message number) of your messages already delivered, so a replayed event is dropped after a restart too. If it exists but cannot be read, the daemon does not start |
| `sso-session.json` | only between `mxagentctl login-sso` and the next daemon start: the new bot session. The daemon moves it into `state.json` (if that has no session yet) and deletes the file |

`state.json`, `replay.log` and `sso-session.json` are written with mode 0600. A new state directory
is created with mode 0700; if you create it yourself, give it that mode too.

One more secret file lives in the **config directory** (next to `bridge.env`), not in the state
directory:

| Path | Content |
|---|---|
| `machines` | one `<name> <secret>` line per remote machine (mode 0600), managed with `mxagentctl add-machine` / `remove-machine` / `list-machines` |

Details: [internals.md, state.ts](../reference/internals.md#srcdaemonstatets).
