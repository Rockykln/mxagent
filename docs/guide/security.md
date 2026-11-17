# Security

What the bridge protects and what you have to protect yourself.

## Summary

- Only you can talk to your agents: your Matrix account, from a verified session.
- Messages are end-to-end encrypted between your Matrix client and the daemon.
- **The daemon host sees everything.** It decrypts all messages and passes them to agents.
- Room names, most reactions and the reply relation of a message are **not** encrypted by Matrix.
- Keep these secret: the state directory (bot login, trust anchor, encryption keys), the config
  directory (machine secrets) and the bot's recovery key.

## Who can see what

| Who | Sees message content | Notes |
|---|---|---|
| your Matrix client | yes | |
| the homeserver | no | sees metadata: room names, members, timestamps, unencrypted reactions, reply relations |
| the daemon host | **yes** | can do everything the agents can do |
| an agent | its own messages only | |
| the TLS proxy for remote agents | no | the WebSocket content is encrypted again after login |

"End-to-end" in this project means **your client ↔ the daemon**, not your client ↔ the agent.

Room names are visible to the homeserver, and each agent room is named after its agent. Choose
agent names that reveal nothing sensitive.

Details: [protocol.md, transports](../reference/protocol.md#transports).

## Who can talk to your agents

A message reaches an agent only if all of these are true:

1. it was encrypted, and the room key came directly from the sending device (not forwarded),
2. it was sent by `MXA_OWNER`,
3. it was sent from a session you verified with cross-signing, and the bot has verified you,
4. the bot's own identity matches the trust anchor stored by `mxagentctl cross-sign`,
5. the daemon has not delivered the same message before (also across restarts). A message is
   identified by its encryption session and message number, so a homeserver cannot resend an old
   command in a slightly different encoding.

Messages from other users are ignored, and they cannot push your old messages out of the daemon's
replay memory: only messages that passed all checks are remembered. If the replay log
(`replay.log` in the state directory) exists but cannot be read or is damaged, the daemon refuses
to start; fix its permissions or remove it (removing it lets old messages be replayed once more).
If it cannot be written, messages are not delivered and the notice says "replay log cannot be
written". Your own messages from an unverified session or with a
changed identity are not delivered; a notice in the agent room (or, for the control room, in the
system room) says why. Plain (unencrypted) messages are never delivered.

The first time a message from you passes all checks, the daemon remembers ("pins") your
cross-signing identity. If you later reset cross-signing, the daemon stops accepting your messages
until you verify your new identity from the bot account again and then renew the pin: stop the
daemon and run `node cli/mxagentctl.ts reset-owner-pin`. This way a homeserver admin
cannot silently swap in a new identity for you.

The bot's identity is anchored the same way: `mxagentctl cross-sign` checks the bot's master key
with the recovery key and stores it. If the private key is not in secret storage (the homeserver
can fake that by hiding it), you must confirm the master key's fingerprint in a terminal or pass it
with `--master-fingerprint`; `-y` never covers this. If the homeserver later publishes another master key for the bot, the
daemon trusts nobody until you run `cross-sign` again.

Details: [internals.md, trust.ts](../reference/internals.md#srcdaemontrustts).

## Where the daemon sends

Before every encrypted message the daemon checks that the room is known to be encrypted, that
its only members are you and the bot, and that every device of your account and of the bot
account is cross-signed. If the room is the problem, it refuses to send there and posts "Refusing
to send to <room>: <reason>" in the system room. If a device is the problem, it sends nothing
anywhere (the reason is in the daemon log, see
[Unknown device blocks sending](#unknown-device-blocks-sending)). So nobody the homeserver adds to
a room, and no device it adds to an account, receives the room keys for agent messages. Keep agent
rooms, the control room and the system room to yourself.

## Reactions are not encrypted

Matrix clients usually send reactions unencrypted. The daemon passes your reactions to agents as
hints, but:

- reactions never trigger approvals or any other decision in the daemon,
- approvals use polls, which are encrypted and checked like messages,
- a reaction reaches the agent with `verified: true` only if it was encrypted and passed the same
  checks as a message. Plain reactions are marked unverified, because the homeserver can forge
  them. Agents must never treat any reaction as an approval or an instruction.

The daemon's own reactions (👀, 💤, ✅, ⚠️) are visible to the homeserver too.

## Approvals

When an agent asks for approval, you get an Allow/Deny poll in its room. Only your vote, from a
verified session, counts, and only the first one. The result goes only to the agent of that name
on the machine that asked. A request you do not answer expires (default 15 minutes,
`MXA_APPROVAL_TTL_MINUTES`) and the agent gets **deny**. Agents must treat a missing answer as
deny too, because an agent that is offline at that moment misses the result.

Details: [protocol.md, approvals](../reference/protocol.md#approvals).

## Protect machine secrets

Each remote machine has its own secret, created with `mxagentctl add-machine`.

- The secret itself never travels over the network. Both sides prove they know it and then
  encrypt the connection.
- Whoever has a machine's secret can connect agents under any name that is not in use and read
  their messages. It gives no access to the Matrix account. A machine can create rooms for at most
  20 new agent names per daemon run, so a leaked secret cannot flood your space.
- `mxagentctl add-machine` writes it into `client-<name>.env` (mode 0600) and never prints it.
  Move that file to the agent machine and delete the copy on the daemon host.
- On the daemon host all secrets are stored in the `machines` file in the config directory
  (mode 0600).
- If it leaks, revoke it: `node cli/mxagentctl.ts remove-machine <name>`. The running daemon closes
  that machine's connections within about 30 seconds.
- Still use TLS in front of the WebSocket. It hides the machine name and protects against
  misbehaving proxies.

Details: [protocol.md, secure WebSocket handshake](../reference/protocol.md#secure-websocket-handshake).

## Keep the recovery key offline

The bot's recovery key lets anyone verify new devices as the bot. You need it only for
`mxagentctl cross-sign`.

- Type it when `cross-sign` asks for it (the input is hidden). Never put it in `bridge.env`.
- For automation only, pass it as `MXA_RECOVERY_KEY` in the environment of that one command; keep it
  out of shell history, for example with `read -rs MXA_RECOVERY_KEY && export MXA_RECOVERY_KEY`.
- Store it offline, for example in a password manager.

## Local socket

Local agents connect through a Unix socket with mode 0600. Any process running as the daemon's
user can use it and act as any agent. If other software shares that user, run the daemon under
its own user (the system unit in [`deploy/`](../../deploy/README.md) does this).

## Rate limits and logging

- Failed remote logins are rate-limited per client address (10 failures, or 30 logins that time
  out or are aborted, per 10 minutes lock the address out; IPv6 addresses are grouped by /64).
  Machines that logged in from that address within the last 24 hours still get through. Agents are
  told to try again later (close code 4029) and reconnect after a minute or more; only a wrong or
  revoked secret (close code 4003) stops them. Behind a reverse proxy set `MXA_TRUST_PROXY_HEADER`,
  otherwise all clients share the proxy's address.
- Connection caps: 512 WebSocket connections in total, 8 unfinished handshakes per address (256 in
  total), 64 links per machine, 3 seconds to start and 10 seconds to finish the handshake.
- Dead agent connections are detected and removed: the daemon pings WebSocket links every 30
  seconds and drops a link without an answer for 75 seconds; agents get a heartbeat line every 30
  seconds and reconnect when nothing arrives for 75 seconds.
- Per link, at most 256 requests or 8 MiB of requests may wait; a link that sends more is dropped.
- Each machine (the local socket counts as `local`) may create rooms for at most 20 new agent
  names per daemon run.
- Attachments larger than `MXA_MAX_ATTACHMENT_MB` are not forwarded; the download stops at the limit.
- Logs never contain message bodies, tokens, secrets or recovery keys. Room ids, user ids and
  event types may appear.

## Residual risks

The daemon does not trust the homeserver for who is talking: the bot's identity is
anchored locally, your identity is pinned, replayed events are dropped even after a restart,
plaintext messages are refused and the send guard keeps room keys away from extra room members.
What remains:

- **The reply relation is not encrypted.** Matrix leaves the "in reply to" part of a message in
  plaintext, so the homeserver can change which message your reply points to. The daemon only
  routes a reply to an agent if the target is a message the daemon itself sent for that agent
  since its last start, so the worst case is that a reply meant for one agent reaches another
  agent that posted in the control room during this run. A message that starts with `@name` is
  never redirected. When it matters, address the agent explicitly.
- Reactions are only verified when encrypted. Most clients send reactions unencrypted; the
  homeserver can forge or change those. They reach agents marked unverified, and no reaction ever
  counts as an approval.
- Metadata is visible to the homeserver: room names (each agent room is named after its agent),
  members, timestamps, reactions, the reply relation and message sizes.
- **The daemon host sees plaintext.** See [below](#if-the-daemon-host-is-compromised).
- **Room keys only go to cross-signed devices.** Before every encrypted message the daemon checks
  all devices of your account and of the bot account. If one of them is not signed by your
  verified identity (or, for the bot, by the bot's identity), the daemon sends nothing and logs
  "refusing to send to <room>: unverified device(s): <user> <device id> …". A key that slips
  through a device-list change in between is withheld from that device as well. See
  [Unknown device blocks sending](#unknown-device-blocks-sending).
- Keys are bound to signed device keys, and key requests are ignored. The last filter before
  room keys leave the daemon keeps a key only if it is encrypted to exactly the curve25519 key that
  your identity signed for that device, so a homeserver cannot slip in a different key under an
  allowed device id. Requests from other devices for room keys or secrets are dropped unread, and
  every encrypted message the crypto library queues on its own passes the same filter. Because the
  bot does not answer key requests, a new device of yours only reads messages sent after it was
  cross-signed.
- `cross-sign` needs a local reference for what it signs. The device key served by the homeserver
  must match the key the daemon recorded in `state.json` at startup; a different key is refused.
  Without that record, compare the fingerprint it shows with the `ed25519 fingerprint` line the
  daemon logs at startup (or pass `--device-fingerprint`). If the bot's master key is not in secret
  storage, compare its fingerprint with the master key shown in a client logged in as the bot (for
  example Element: Settings, Security & Privacy, Cross-signing) or pass `--master-fingerprint`. `-y`
  skips neither check.
- Agent names are not tied to machines. Any machine secret can register any name that is not
  in use (limited to 20 new names per machine and daemon run). Revoke a machine you no longer trust
  instead of relying on names.
- Revoking a device can take up to a minute. The daemon caches your keys for 60 seconds and
  drops the cache when the homeserver reports a device change, so a removed or unverified device
  is usually rejected at once and at the latest after a minute.
- `MXA_TRUST_PROXY_HEADER` only belongs behind a proxy that overwrites that header, and only if
  the WebSocket port is not reachable directly. Otherwise clients can pick their own address and
  dodge the rate limit.
- **Supply chain of the native crypto library.** `npm ci` downloads a prebuilt binary of the Matrix
  Rust crypto library without a checksum check. Install from a network you trust, or build the
  image or `node_modules/` once and reuse it.
- Attachments must be encrypted. In the encrypted rooms an attachment that comes as a plain
  link (instead of an encrypted file) is not delivered ("unencrypted attachment refused"), because
  the homeserver could swap its contents.
- Attachments are limited to 25 MB by default (`MXA_MAX_ATTACHMENT_MB`, at most 45), because
  they are passed to agents in memory.
- Held messages live in memory. Messages for a room you have not joined yet are lost if the
  daemon stops before you join.
- The SSO session file is short-lived. `sso-session.json` in the state directory holds a bot
  access token until the daemon starts; the daemon then moves the token into its state and deletes
  the file.

## Unknown device blocks sending

The daemon stops sending (agent output, notices, polls) as long as your account or the bot account
has a device that is not cross-signed. This keeps a homeserver admin from adding a device and
reading along. To recover:

1. Read the device id from the daemon log (`refusing to send to …: unverified device(s): …`).
   The system room cannot show it, because the daemon sends nothing there either.
2. If you know the device (a new phone, a fresh login): verify it from one of your verified
   sessions. For a bot device, sign it with `node cli/mxagentctl.ts cross-sign <device>` (daemon
   stopped) or log it out.
3. If you do not know it: log it out (your client's session list, or the bot account's) and treat
   the homeserver as suspicious; change the password of the affected account.

Sending resumes on the next message once the device list is clean; no restart is needed (except
around `cross-sign`, which needs the daemon stopped). Before `cross-sign` has stored the bot's
identity the daemon cannot check devices and sends nothing. The client
you used to set up the bot's cross-signing counts as a bot device too: log it out or cross-sign it.

## If the daemon host is compromised

Assume an attacker with the daemon user's access can:

- read all messages and attachments for all agents,
- send messages and polls as the bot and impersonate any agent,
- use the bot's login, and with the recovery key verify new bot devices,
- connect as any registered machine.

They cannot, without more access:

- read your other Matrix rooms,
- send messages that your client shows as coming from you,
- vote on approvals as you (but they can talk to agents directly and skip the approval).

What to do: stop the daemon, log out the bot's sessions and reset its cross-signing from another
client, change the bot password, revoke all machines (`remove-machine`) and register them again,
rebuild the host.

Never give an agent more rights than you would accept for a compromised daemon.

## Not covered

- What agents do. The bridge checks who is talking; it does not sandbox agents.
- Metadata the homeserver collects.
- A compromised Matrix client or device on your side.

## Report a vulnerability

See [SECURITY.md](../../SECURITY.md).
