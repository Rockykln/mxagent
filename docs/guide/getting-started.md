# Getting started

This guide takes you from nothing to a running bridge with one agent. It takes about 15 minutes
if you already have a Matrix account.

What you end up with:

- a daemon that logs in to Matrix as a bot account,
- a space with a control room and one room per agent,
- an agent that can send you messages and receive your answers.

## Before you start

| You need | Notes |
|---|---|
| Node.js 22.18 or newer | the daemon runs TypeScript directly, there is no build step |
| A Matrix homeserver | any server with end-to-end encryption and cross-signing |
| A bot account | a new, dedicated account such as `@agents:example.org`. Never use your own account |
| Your own account | for example `@alice:example.org`, with verified sessions in your Matrix client |
| A space | create it with your own account and invite the bot. The bot needs permission to add rooms to it |

The admin tool is run from the repository as `node cli/mxagentctl.ts <command>` (or
`npm run ctl -- <command>`). It is not installed as a separate program.

## Install

```sh
git clone https://github.com/Rockykln/mxagent mxagent
cd mxagent
npm ci
```

`npm ci` downloads a prebuilt native crypto library. Do not use `--ignore-scripts`.

## Prepare the bot account

The daemon only accepts your messages if the bot account has verified your account, and your
client only trusts the bot if the bot has a cross-signing identity. Set this up once in a normal
Matrix client:

1. Log in to the bot account in a Matrix client (a private browser window works well).
2. Set up cross-signing and key backup ("secure backup" or "recovery" in most clients). Save the
   **recovery key** it shows; you need it once below.
3. From the bot account, verify your own account (open your user profile and start a
   verification, then confirm it on one of your devices).
4. Optionally verify the bot from your own account too, so your client shows it as trusted.
5. Log out of the bot account in that client, otherwise the daemon refuses to send while any
   session of the bot or of your account is not cross-signed (see
   [below](#unverified-devices-block-sending)). A bot session you keep
   must be cross-signed, and every session of your own account must be verified.

## Configure

Create the config file and restrict its permissions:

```sh
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/mxagent"
cat > "${XDG_CONFIG_HOME:-$HOME/.config}/mxagent/bridge.env" <<'EOF'
MXA_HOMESERVER=https://matrix.example.org
MXA_BOT_USER=@agents:example.org
MXA_OWNER=@alice:example.org
MXA_SPACE_ID=!AbCdEf:example.org
EOF
chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/mxagent/bridge.env"
```

Replace the four values with your own. `MXA_HOMESERVER` is the URL your client connects to,
not the server name. The space id is shown in your client's space settings.

Details: [configuration.md](configuration.md).

## Log in the bot

The daemon must not be running while you log in (the login commands refuse otherwise).

With a password:

```sh
node cli/mxagentctl.ts login-password
```

The password is taken from `MXA_BOT_PASSWORD` if it is set, otherwise you are asked for it
(the input is hidden). The session is stored in `state.json` in the state directory.

If your homeserver only offers single sign-on:

```sh
node cli/mxagentctl.ts login-sso
```

This prints a URL. Open it in a browser on the same machine and log in as the bot. The session is
saved as `sso-session.json` in the state directory; the daemon moves it into `state.json` on its
next start and deletes the file. On a headless server, pick a fixed callback port and forward it
from the machine with the browser:

```sh
ssh -L 8400:127.0.0.1:8400 server         # on the machine with the browser
node cli/mxagentctl.ts login-sso --port 8400   # on the server
```

Both commands refuse to replace an existing session; `--force` replaces it and logs the old device
out.

After login the password is no longer needed. Remove `MXA_BOT_PASSWORD` from the config file if
you put it there.

Details: [internals.md, login order](../reference/internals.md#srcdaemonmatrixts).

## Start the daemon once

```sh
npm start
```

On the first start the daemon:

1. logs in, creates the bot device's encryption keys and logs a line
   `device <ID> ed25519 fingerprint XXXX XXXX …`. Note this fingerprint,
2. creates a **control room** and a **system room** in your space and invites you,
3. waits for agents on a local socket.

Join the control room and the system room in your Matrix client. Then stop the daemon with
Ctrl-C.

Until the next step is done, the daemon **sends nothing**, not even the `daemon … started` notice in
the system room: every send is refused with "bot identity not anchored; run mxagentctl cross-sign"
(visible only in the daemon's log), and every message from you is rejected for the same reason.
The rooms and invites are still created.

## Anchor the bot's identity

`cross-sign` needs the bot's recovery key and the daemon stopped:

```sh
node cli/mxagentctl.ts cross-sign
```

It asks for the recovery key (the input is hidden) and then:

1. checks the bot's cross-signing identity with the keys from secret storage,
2. compares the device's key with the one the daemon recorded in `state.json` at startup and refuses
   a device whose key differs. It shows the device's fingerprint (groups of four characters) and asks
   before signing; `-y` skips only this question, and only when the daemon's record (or `--device-fingerprint`)
   matches,
3. signs the daemon's device with the bot's self-signing key, so your client trusts the bot,
4. stores the bot's master key in `state.json` as the **trust anchor**. From now on the daemon
   trusts only this identity, so a homeserver cannot swap in another one.

Two cases always need you, even with `-y`:

- **The master key is not in secret storage.** Then it cannot be checked with the recovery key, and
  a homeserver could be hiding it. `cross-sign` shows the published master key and asks you to
  confirm it, or takes `--master-fingerprint <fp>`. Read the fingerprint in a client logged in as
  the bot that holds its cross-signing keys (for example Element: Settings, Security & Privacy,
  Cross-signing), never only from what the homeserver serves. If the key was in secret storage
  before, treat this as an attack and stop.
- **The daemon has no record of the device's key** (another device id, or the daemon has not started
  with this device yet). Compare the fingerprint with the `ed25519 fingerprint` line from the daemon's
  log, or pass it with `--device-fingerprint <fp>`.

Without a terminal, pass the option for each case that applies, plus `-y` for the device question;
`cross-sign` aborts otherwise.

Never store the recovery key in `bridge.env`. For automation it can be passed in the environment
as `MXA_RECOVERY_KEY` for this one command.

Start the daemon again and keep it running:

```sh
npm start
```

The system room now shows `daemon … started`. If it stays empty, read the daemon's log (see
[below](#unverified-devices-block-sending)).

The first message you send from a verified session makes the daemon remember ("pin") your
cross-signing identity.

Details: [security.md, recovery key](security.md#keep-the-recovery-key-offline).

### Unverified devices block sending

Before every message the daemon checks all sessions (devices) of the bot account and of your
account. If one of them is not cross-signed, it sends nothing at all and agents get an error. The
daemon's log then shows a line like

```text
refusing to send to !room:example.org: unverified device(s): @agents:example.org ABCDEFGHIJ; verify them with cross-signing or remove them
```

- **A session of the bot**, often the client you used to set up cross-signing: log it out, or
  cross-sign it with the daemon stopped (`node cli/mxagentctl.ts cross-sign <device-id>`).
- **A session of your own account**: verify it from one of your verified sessions, or log it out.

Sending resumes with the next message. More: [security.md, unknown device blocks
sending](security.md#unknown-device-blocks-sending).

Check the setup at any time:

```sh
node cli/mxagentctl.ts status
```

For a permanent setup (systemd or Docker) see [`deploy/README.md`](../../deploy/README.md).

## Connect a local agent

An agent on the same host connects through a Unix socket. It must run as the same user as the
daemon.

The quickest test is the echo example:

```sh
node examples/js/echo-agent.mjs demo
```

The daemon creates a room named `demo` and invites you. Join it and send a message: the agent
echoes it back. Messages the agent sends before you join are held and delivered once you join.

Other ways to connect:

| Option | Use it when | Start here |
|---|---|---|
| JavaScript SDK | your agent is written in JS/TS | [`clients/js/README.md`](../../clients/js/README.md) |
| Python SDK | your agent is written in Python | [`clients/python/README.md`](../../clients/python/README.md) |
| MCP adapter | your agent runs in an MCP host | [`adapters/mcp/README.md`](../../adapters/mcp/README.md) |
| Raw protocol | any other language | [protocol.md](../reference/protocol.md) |

More examples: [`examples/README.md`](../../examples/README.md).

## Connect a remote agent

Agents on other machines connect over WebSocket. Do this once per machine.

**1. Enable the WebSocket listener** on the daemon host. Add to `bridge.env` and restart:

```sh
MXA_WS_LISTEN=127.0.0.1:8640
```

**2. Put a TLS reverse proxy in front of it**, for example `wss://bridge.example.org/` →
`127.0.0.1:8640`. Forward the `Upgrade` header and set the read timeout well above 30 seconds
(the daemon pings every 30 seconds). Plain HTTP `GET /health` on the same port is for monitoring.
Set `MXA_TRUST_PROXY_HEADER` to the header your proxy overwrites (`x-forwarded-for` for nginx or
Caddy, `cf-connecting-ip` for a Cloudflare tunnel), otherwise all machines share the proxy's
address for the login rate limit (see [configuration.md](configuration.md#all-settings)).

**3. Register the machine** on the daemon host:

```sh
node cli/mxagentctl.ts add-machine laptop --url wss://bridge.example.org
```

This writes `client-laptop.env` (mode 0600) into the current directory. It contains `MXA_URL`,
`MXA_MACHINE` and the new `MXA_SECRET`; the secret is not printed. Machine names use `a-z`, `0-9`
and `-` (up to 32 characters).

**4. Copy the file to the other machine** over a secure channel (for example `scp`), install it as
`client.env`, then delete it on the daemon host:

```sh
# on the other machine
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/mxagent"
mv client-laptop.env "${XDG_CONFIG_HOME:-$HOME/.config}/mxagent/client.env"
chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/mxagent/client.env"
```

The SDKs and the MCP adapter read this file automatically. Environment variables with the same
names work too.

The running daemon picks up new and removed machines without a restart. To revoke a machine:
`node cli/mxagentctl.ts remove-machine laptop` (open connections of that machine are closed
within about 30 seconds). `node cli/mxagentctl.ts list-machines` shows all registered machines.

Details: [protocol.md, secure WebSocket handshake](../reference/protocol.md#secure-websocket-handshake).

## Everyday commands

| Task | Command |
|---|---|
| show configuration, rooms, machines and daemon health | `node cli/mxagentctl.ts status` |
| list remote machines | `node cli/mxagentctl.ts list-machines` |
| remove an agent's room (daemon stopped) | `node cli/mxagentctl.ts remove-room <agent>` |
| cross-sign a new bot device (daemon stopped) | `node cli/mxagentctl.ts cross-sign [device]` |
| accept your new identity after you reset cross-signing (daemon stopped) | `node cli/mxagentctl.ts reset-owner-pin` |

`status` reads the config and state files; it cannot see which agents are connected. Write
`@list` in the control room for that. `node cli/mxagentctl.ts --help` lists all commands.

## Next steps

- [commands.md](commands.md): what you can do from the control room.
- [security.md](security.md): what the bridge protects and what it does not.
- [faq.md](faq.md): common questions.
